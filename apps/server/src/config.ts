import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  /** Terrarium DEM tile URL template, or null to disable terrain. */
  terrainUrl: string | null;
  /** Open-Meteo forecast endpoint, or null to disable weather. */
  weatherUrl: string | null;
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
  mkdirSync(dataDir, { recursive: true });
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
    terrainUrl: off(env.ATHENA_TERRAIN_URL, 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'),
    weatherUrl: off(env.ATHENA_WEATHER_URL, 'https://api.open-meteo.com/v1/forecast'),
    webDist: env.ATHENA_WEB_DIST ?? defaultWebDist(),
    sampleHz: Math.min(10, Math.max(0.2, envNum(env.ATHENA_SAMPLE_HZ, 2))),
    linkLossGraceS: envNum(env.ATHENA_LINK_LOSS_GRACE_S, 60),
    authRateLimitPerMin: envNum(env.ATHENA_AUTH_RATE_LIMIT, 30),
    logLevel: env.LOG_LEVEL ?? 'info',
    demo: envBool(env.ATHENA_DEMO, false),
    demoDrones: envNum(env.ATHENA_DEMO_DRONES, 3),
    maxUploadMb: envNum(env.ATHENA_MAX_UPLOAD_MB, 512),
    ...overrides,
  };
  cfg.secretKey = overrides.secretKey ?? loadSecretKey(dataDir, env.ATHENA_SECRET_KEY);
  return cfg;
}
