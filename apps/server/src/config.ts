import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  host: string;
  port: number;
  /** Externally reachable base URL (used in e-mails and firmware download links). */
  publicUrl: string;
  dataDir: string;
  dbFile: string;
  /** 32-byte key used to encrypt secrets at rest (webhook / integration credentials). */
  secretKey: Buffer;
  cookieSecure: boolean;
  sessionTtlDays: number;
  smtpUrl: string | null;
  mailFrom: string;
  /**
   * Self-service sign-ups confirm their e-mail address before the account exists (and the
   * response never tells whether an address is registered). Default: on when SMTP is set.
   */
  signupConfirmEmail: boolean;
  /**
   * Reverse proxies whose X-Forwarded-For / -Proto headers are believed (client address for rate
   * limits and logs, HTTPS): false, or addresses / CIDR ranges – proxy-addr names `loopback`,
   * `linklocal`, `uniquelocal` included.
   */
  trustProxy: false | string;
  /** Terrarium DEM tile URL template, or null to disable terrain. */
  terrainUrl: string | null;
  /** Aerial imagery tile URL template (Web Mercator), or null to disable the imagery tile cache. */
  imageryUrl: string | null;
  /** Disk space (MiB) of the aerial imagery and terrain tile caches (least recently used tiles go first). */
  imageryCacheMb: number;
  terrainCacheMb: number;
  /**
   * Tiles each user may have this server fetch from a tile service per hour (aerial imagery and
   * terrain each; tiles already cached do not count; half of it at once). 0: no limit.
   */
  tileFetchesPerHour: number;
  /** Open-Meteo forecast endpoint, or null to disable weather. */
  weatherUrl: string | null;
  /** Reverse-geocoding endpoint (Nominatim API), or null to disable place names. */
  geocoderUrl: string | null;
  webDist: string | null;
  /** Telemetry samples persisted per second for live flights. */
  sampleHz: number;
  /** Seconds a flight stays open after the link is lost before it is closed as aborted. */
  linkLossGraceS: number;
  authRateLimitPerMin: number;
  logLevel: string;
  demo: boolean;
  /** Number of in-process virtual drones started in demo mode. */
  demoDrones: number;
  maxUploadMb: number;
  /** External airspace feeds (GeoJSON) merged into every organisation's airspace data. */
  airspaceFeeds: AirspaceFeedConfig[];
  /**
   * Cesium ion access token (world terrain, OSM 3D buildings, aerial imagery) handed to the
   * web application of signed-in users; null keeps the self-hosted terrain and OSM imagery.
   */
  cesiumIonToken: string | null;
  /** External flight authority (UTM service) deciding authorisation requests, or null. */
  utmAuthority: UtmAuthorityConfig | null;
}

export interface UtmAuthorityConfig {
  name: string;
  url: string;
  /** Bearer key, if the authority wants one. */
  key: string | null;
  pollSeconds: number;
}

/**
 * ATHENA_UTM_AUTHORITY_URL (+ _NAME, _KEY, _POLL_S): the flight authority of docs/UTM_AUTHORITY.md.
 * Invalid configuration fails start-up rather than silently deciding requests locally.
 */
export function parseUtmAuthority(env: NodeJS.ProcessEnv): UtmAuthorityConfig | null {
  const raw = env.ATHENA_UTM_AUTHORITY_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('ATHENA_UTM_AUTHORITY_URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('ATHENA_UTM_AUTHORITY_URL must be http(s)');
  const name = (env.ATHENA_UTM_AUTHORITY_NAME?.trim() || 'External UTM').slice(0, 80);
  const poll = Number(env.ATHENA_UTM_AUTHORITY_POLL_S ?? 15);
  return { name, url: url.toString(), key: env.ATHENA_UTM_AUTHORITY_KEY?.trim() || null, pollSeconds: Number.isFinite(poll) && poll >= 1 ? Math.min(poll, 3600) : 15 };
}

export interface AirspaceFeedConfig {
  id: string;
  name: string;
  url: string;
  refreshMinutes: number;
}

/**
 * Parses ATHENA_AIRSPACE_FEEDS: a JSON array of {"id","name","url","refreshMinutes"?}.
 * Invalid configuration fails start-up rather than silently disabling a safety data source.
 */
export function parseAirspaceFeeds(raw: string | undefined): AirspaceFeedConfig[] {
  if (!raw || !raw.trim()) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new Error('ATHENA_AIRSPACE_FEEDS must be a JSON array');
  }
  if (!Array.isArray(list)) throw new Error('ATHENA_AIRSPACE_FEEDS must be a JSON array');
  const ids = new Set<string>();
  return list.map((f: any, i) => {
    const id = String(f?.id ?? '');
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id) || id === 'org') throw new Error(`ATHENA_AIRSPACE_FEEDS[${i}].id must be a lowercase slug (not "org")`);
    if (ids.has(id)) throw new Error(`ATHENA_AIRSPACE_FEEDS: duplicate id "${id}"`);
    ids.add(id);
    let url: URL;
    try {
      url = new URL(String(f?.url ?? ''));
    } catch {
      throw new Error(`ATHENA_AIRSPACE_FEEDS[${i}].url is not a valid URL`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`ATHENA_AIRSPACE_FEEDS[${i}].url must be http(s)`);
    const refresh = Number(f?.refreshMinutes ?? 60);
    return { id, name: String(f?.name ?? id).slice(0, 80), url: url.toString(), refreshMinutes: Number.isFinite(refresh) && refresh >= 1 ? refresh : 60 };
  });
}

/**
 * `ATHENA_TRUST_PROXY`: `1` trusts a proxy on this host or a private network (the compose
 * `tls` profile's Caddy) – never a client connecting from the internet, which could otherwise
 * claim any address in X-Forwarded-For and escape the rate limits; or a list of addresses /
 * CIDR ranges of the proxies; `0` / empty: none.
 */
export function trustProxyOf(v: string | undefined): false | string {
  const t = (v ?? '').trim();
  if (!t || ['0', 'false', 'no', 'off'].includes(t.toLowerCase())) return false;
  if (['1', 'true', 'yes', 'on'].includes(t.toLowerCase())) return 'loopback, linklocal, uniquelocal';
  return t
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .join(', ');
}

function envBool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function envNum(v: string | undefined, dflt: number): number {
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function loadSecretKey(dataDir: string, fromEnv: string | undefined): Buffer {
  if (fromEnv) {
    const key = /^[0-9a-f]{64}$/i.test(fromEnv) ? Buffer.from(fromEnv, 'hex') : Buffer.from(fromEnv, 'base64');
    if (key.length !== 32) throw new Error('ATHENA_SECRET_KEY must be 32 bytes (64 hex chars or base64)');
    return key;
  }
  const file = join(dataDir, 'secret.key');
  if (existsSync(file)) return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
  const key = randomBytes(32);
  writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  return key;
}

function defaultWebDist(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [resolve(here, '../../web/dist'), resolve(here, '../web/dist'), resolve(process.cwd(), 'apps/web/dist')]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const port = envNum(env.PORT, 8080);
  const dataDirRaw = overrides.dataDir ?? env.ATHENA_DATA_DIR ?? 'data';
  const dataDir = isAbsolute(dataDirRaw) ? dataDirRaw : resolve(process.cwd(), dataDirRaw);
  // Database, secret key and uploaded files: for the server's user only (mkdir's mode does not
  // apply to a directory that already exists, e.g. a container volume).
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dataDir, 0o700);
  } catch {
    // not the owner (e.g. a read-only mount): the files inside are still created 0600
  }
  const publicUrl = (env.ATHENA_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');
  const off = (v: string | undefined, dflt: string): string | null => (v === 'off' || v === 'none' ? null : v || dflt);
  const cfg: Config = {
    host: env.HOST ?? '0.0.0.0',
    port,
    publicUrl,
    dataDir,
    dbFile: env.ATHENA_DB ?? join(dataDir, 'athena.db'),
    secretKey: Buffer.alloc(0),
    cookieSecure: envBool(env.ATHENA_COOKIE_SECURE, publicUrl.startsWith('https://')),
    sessionTtlDays: envNum(env.ATHENA_SESSION_TTL_DAYS, 30),
    smtpUrl: env.SMTP_URL || null,
    mailFrom: env.MAIL_FROM ?? 'Athena-sky <no-reply@athena-sky.local>',
    signupConfirmEmail: envBool(env.ATHENA_SIGNUP_CONFIRM_EMAIL, !!env.SMTP_URL),
    trustProxy: trustProxyOf(env.ATHENA_TRUST_PROXY),
    terrainUrl: off(env.ATHENA_TERRAIN_URL, 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'),
    imageryUrl: off(env.ATHENA_IMAGERY_URL, 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'),
    imageryCacheMb: Math.max(1, envNum(env.ATHENA_IMAGERY_CACHE_MB, 1024)),
    terrainCacheMb: Math.max(1, envNum(env.ATHENA_TERRAIN_CACHE_MB, 256)),
    tileFetchesPerHour: Math.max(0, envNum(env.ATHENA_TILE_FETCHES_PER_HOUR, 3600)),
    weatherUrl: off(env.ATHENA_WEATHER_URL, 'https://api.open-meteo.com/v1/forecast'),
    geocoderUrl: off(env.ATHENA_GEOCODER_URL, 'https://nominatim.openstreetmap.org/reverse'),
    webDist: env.ATHENA_WEB_DIST ?? defaultWebDist(),
    sampleHz: Math.min(10, Math.max(0.2, envNum(env.ATHENA_SAMPLE_HZ, 2))),
    linkLossGraceS: envNum(env.ATHENA_LINK_LOSS_GRACE_S, 60),
    authRateLimitPerMin: envNum(env.ATHENA_AUTH_RATE_LIMIT, 30),
    logLevel: env.LOG_LEVEL ?? 'info',
    demo: envBool(env.ATHENA_DEMO, false),
    demoDrones: envNum(env.ATHENA_DEMO_DRONES, 3),
    maxUploadMb: envNum(env.ATHENA_MAX_UPLOAD_MB, 512),
    airspaceFeeds: parseAirspaceFeeds(env.ATHENA_AIRSPACE_FEEDS),
    cesiumIonToken: env.CESIUM_ION_TOKEN?.trim() || null,
    utmAuthority: parseUtmAuthority(env),
    ...overrides,
  };
  cfg.secretKey = overrides.secretKey ?? loadSecretKey(dataDir, env.ATHENA_SECRET_KEY);
  return cfg;
}
