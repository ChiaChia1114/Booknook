import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { badRequest } from './errors';

// ---------------------------------------------------------------------------
// Address classification (SSRF protection)
// ---------------------------------------------------------------------------

function v4Octets(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const o = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return o.every((n) => n >= 0 && n <= 255) ? o : null;
}

/** Loopback, private, link-local, CGNAT, multicast, reserved and documentation IPv4 ranges. */
function isPrivateV4Octets([a, b, c]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a! >= 224
  );
}

/** Parses an IPv6 address (any notation, optional zone id, embedded IPv4) into 8 hextets. */
export function parseIPv6(input: string): number[] | null {
  let ip = input.replace(/^\[|\]$/g, '').split('%')[0]!.toLowerCase();
  let tail: number[] = [];
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (v4) {
    const o = v4Octets(v4[1]!);
    if (!o) return null;
    tail = [(o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!];
    ip = ip.slice(0, -v4[1]!.length);
    if (ip.endsWith(':') && !ip.endsWith('::')) ip = ip.slice(0, -1);
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const h of s.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
      out.push(parseInt(h, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !rest) return null;
  const known = head.length + rest.length + tail.length;
  if (halves.length === 1) return known === 8 ? [...head, ...tail] : null;
  if (known > 7) return null;
  return [...head, ...new Array(8 - known).fill(0), ...rest, ...tail];
}

function isPrivateV6(ip: string): boolean {
  const h = parseIPv6(ip);
  if (!h) return true;
  const zeros = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
  const embedded = (hi: number, lo: number) => isPrivateV4Octets([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  if (zeros(0, 8)) return true; // ::
  if (zeros(0, 7) && h[7] === 1) return true; // ::1
  if (zeros(0, 5) && h[5] === 0xffff) return embedded(h[6]!, h[7]!); // ::ffff:a.b.c.d (any notation)
  if (zeros(0, 6)) return embedded(h[6]!, h[7]!); // ::a.b.c.d (deprecated IPv4-compatible)
  if (h[0] === 0x64 && h[1] === 0xff9b && zeros(2, 6)) return embedded(h[6]!, h[7]!); // NAT64
  if (h[0] === 0x2002) return embedded(h[1]!, h[2]!); // 6to4
  if (h[0] === 0x2001 && h[1] === 0) return true; // Teredo
  if (h[0] === 0x2001 && h[1] === 0xdb8) return true; // documentation
  if (h[0] === 0x100 && zeros(1, 4)) return true; // discard prefix
  if ((h[0]! & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((h[0]! & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((h[0]! & 0xffc0) === 0xfec0) return true; // site-local (deprecated)
  if ((h[0]! & 0xff00) === 0xff00) return true; // multicast
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip.replace(/^\[|\]$/g, '').split('%')[0]!);
  if (v === 4) return isPrivateV4Octets(v4Octets(ip)!);
  if (v === 6) return isPrivateV6(ip);
  return true;
}

/** Validates an outbound integration URL (http/https only, no credentials). */
export function validateOutboundUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('Invalid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw badRequest('URL must use http or https');
  if (url.username || url.password) throw badRequest('URL must not contain credentials');
  return url;
}

/**
 * Resolves the URL host and rejects loopback / private / link-local targets (SSRF protection).
 * Private deployments that need internal targets can opt out with ATHENA_ALLOW_PRIVATE_TARGETS=1.
 */
export async function assertPublicTarget(url: URL, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw badRequest('Target resolves to a private or loopback address');
  }
}

/**
 * fetch() whose connections are checked again at connect time: every address the
 * hostname resolves to must be public. This closes the DNS-rebinding gap between
 * assertPublicTarget() and the actual request.
 */
export function safeFetch(allowPrivate: boolean): typeof fetch {
  if (allowPrivate) return fetch;
  const agent = new Agent({
    connect: {
      lookup: (hostname: string, options: { all?: boolean }, callback: (...args: any[]) => void) => {
        dnsLookup(hostname, { all: true }, (err, addresses: LookupAddress[]) => {
          if (err) return callback(err);
          const bad = addresses.find((a) => isPrivateAddress(a.address));
          if (bad || addresses.length === 0) return callback(new Error(`Blocked request to private address ${bad?.address ?? hostname}`));
          if (options?.all) return callback(null, addresses);
          return callback(null, addresses[0]!.address, addresses[0]!.family);
        });
      },
    },
  });
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    undiciFetch(input as never, { ...(init as object), dispatcher: agent } as never)) as unknown as typeof fetch;
}
