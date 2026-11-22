import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface ImageryOptions {
  /** Web-Mercator tile URL template (`{z}`, `{x}`, `{y}`), or null when disabled. */
  urlTemplate: string | null;
  cacheDir: string;
  fetchImpl?: typeof fetch;
}

/** Most detailed zoom level served (≈ 0.3 m per pixel at the equator). */
export const IMAGERY_MAX_ZOOM = 19;
const MAX_TILE_BYTES = 2 * 1_048_576;
const CONCURRENCY = 6;
/** A tile the service could not deliver is not asked for again before this (ms). */
const RETRY_AFTER_MS = 60_000;

/** Image type of tile bytes (JPEG or PNG), or null. */
export function tileImageType(buf: Uint8Array): 'image/jpeg' | 'image/png' | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  return null;
}

/**
 * Aerial imagery tiles: fetched once from the configured tile service, kept on disk, and served
 * from this server – to the web application's satellite layers and to the cameras of simulated
 * drones (which show the real place they fly over). Browsers then only reach this server (a
 * firewall or proxy in front of them does not matter), and every tile is fetched upstream once.
 */
export class ImageryService {
  private readonly fetchImpl: typeof fetch;
  private readonly inflight = new Map<string, Promise<Buffer | null>>();
  private readonly failed = new Map<string, number>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly opts: ImageryOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    if (opts.urlTemplate) mkdirSync(opts.cacheDir, { recursive: true, mode: 0o700 });
  }

  get enabled(): boolean {
    return this.opts.urlTemplate !== null;
  }

  /** Image bytes (JPEG or PNG) of a tile, or null: disabled, out of range or unavailable. */
  async tile(z: number, x: number, y: number): Promise<Buffer | null> {
    const template = this.opts.urlTemplate;
    if (!template) return null;
    const n = 2 ** z;
    if (!Number.isInteger(z) || z < 0 || z > IMAGERY_MAX_ZOOM || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= n || y >= n) return null;
    const file = join(this.opts.cacheDir, String(z), String(x), `${y}.tile`);
    if (existsSync(file)) return readFileSync(file);
    const key = `${z}/${x}/${y}`;
    if ((this.failed.get(key) ?? 0) > Date.now()) return null;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.limited(async () => {
        try {
          const url = template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
          const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'Athena-sky (drone fleet cloud; tile cache)' } });
          const buf = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
          if (!buf || buf.length > MAX_TILE_BYTES || !tileImageType(buf)) throw new Error(`tile ${key} unavailable (HTTP ${res.status})`);
          mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
          writeFileSync(file, buf, { mode: 0o600 });
          this.failed.delete(key);
          return buf;
        } catch {
          this.failed.set(key, Date.now() + RETRY_AFTER_MS);
          if (this.failed.size > 10_000) this.failed.delete(this.failed.keys().next().value!);
          return null;
        }
      }).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  /** At most a few upstream requests at a time (fair to the tile service). */
  private async limited<T>(work: () => Promise<T>): Promise<T> {
    // A finished request hands its slot to the next one waiting.
    if (this.active >= CONCURRENCY) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
