import { mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HttpError } from '../lib/errors';

/**
 * Map tiles kept on disk under `dir/z/x/y.<ext>`, bounded in size: once the cache grows past
 * `maxBytes`, the least recently used tiles are removed (down to 90 % of it).
 */
export class DiskTileCache {
  /** Tile key (`z/x/y`) → size in bytes, least recently used first. */
  private readonly index = new Map<string, number>();
  private total = 0;

  constructor(
    private readonly dir: string,
    private readonly ext: string,
    readonly maxBytes: number,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.scan();
  }

  /** Tiles and bytes held. */
  get usage(): { tiles: number; bytes: number } {
    return { tiles: this.index.size, bytes: this.total };
  }

  has(z: number, x: number, y: number): boolean {
    return this.index.has(`${z}/${x}/${y}`);
  }

  get(z: number, x: number, y: number): Buffer | null {
    const key = `${z}/${x}/${y}`;
    const size = this.index.get(key);
    if (size === undefined) return null;
    this.index.delete(key);
    try {
      const buf = readFileSync(this.file(key));
      this.index.set(key, size); // now the most recently used
      return buf;
    } catch {
      this.total -= size;
      return null;
    }
  }

  put(z: number, x: number, y: number, buf: Buffer): void {
    const key = `${z}/${x}/${y}`;
    const file = this.file(key);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, buf, { mode: 0o600 });
    const old = this.index.get(key);
    if (old !== undefined) {
      this.index.delete(key);
      this.total -= old;
    }
    this.index.set(key, buf.length);
    this.total += buf.length;
    this.evict();
  }

  private file(key: string): string {
    const [z, x, y] = key.split('/');
    return join(this.dir, z!, x!, `${y}.${this.ext}`);
  }

  /** Indexes the tiles already on disk, oldest first. */
  private scan(): void {
    const found: { key: string; size: number; at: number }[] = [];
    const list = (d: string) => {
      try {
        return readdirSync(d);
      } catch {
        return [];
      }
    };
    const suffix = `.${this.ext}`;
    for (const z of list(this.dir)) {
      if (!/^\d+$/.test(z)) continue;
      for (const x of list(join(this.dir, z))) {
        if (!/^\d+$/.test(x)) continue;
        for (const f of list(join(this.dir, z, x))) {
          const y = f.endsWith(suffix) ? f.slice(0, -suffix.length) : '';
          if (!/^\d+$/.test(y)) continue;
          try {
            const st = statSync(join(this.dir, z, x, f));
            found.push({ key: `${z}/${x}/${y}`, size: st.size, at: st.mtimeMs });
          } catch {
            // removed meanwhile
          }
        }
      }
    }
    found.sort((a, b) => a.at - b.at);
    for (const t of found) {
      this.index.set(t.key, t.size);
      this.total += t.size;
    }
    this.evict();
  }

  private evict(): void {
    if (this.total <= this.maxBytes) return;
    const target = this.maxBytes * 0.9;
    for (const [key, size] of this.index) {
      if (this.total <= target) break;
      this.index.delete(key);
      this.total -= size;
      const file = this.file(key);
      try {
        unlinkSync(file);
        // An emptied column directory goes too (fails while other tiles are in it).
        rmdirSync(dirname(file));
      } catch {
        // already gone, or not empty
      }
    }
  }
}

export interface TileStoreOptions {
  /** Tile URL template (`{z}`, `{x}`, `{y}`), or null when disabled. */
  urlTemplate: string | null;
  cacheDir: string;
  /** File extension of the cached tiles. */
  ext: string;
  maxZoom: number;
  /** Disk space the cache may use. */
  maxBytes: number;
  /** Whether bytes delivered by the tile service are a usable tile. */
  accept: (buf: Buffer) => boolean;
  fetchImpl?: typeof fetch;
}

const MAX_TILE_BYTES = 2 * 1_048_576;
const CONCURRENCY = 6;
/** A tile the service could not deliver is not asked for again before this (ms). */
const RETRY_AFTER_MS = 60_000;

/**
 * Tiles of an upstream tile service, fetched once and served from a bounded disk cache: a few
 * requests at a time (fair to the service), each tile fetched once however many ask for it
 * meanwhile, and tiles the service did not deliver not asked for again for a minute.
 */
export class TileStore {
  private readonly fetchImpl: typeof fetch;
  readonly cache: DiskTileCache | null;
  private readonly inflight = new Map<string, Promise<Buffer | null>>();
  private readonly failed = new Map<string, number>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly opts: TileStoreOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.cache = opts.urlTemplate ? new DiskTileCache(opts.cacheDir, opts.ext, opts.maxBytes) : null;
  }

  get enabled(): boolean {
    return this.cache !== null;
  }

  inRange(z: number, x: number, y: number): boolean {
    const n = 2 ** z;
    return Number.isInteger(z) && z >= 0 && z <= this.opts.maxZoom && Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < n && y < n;
  }

  /** Whether the tile is served without asking the tile service. */
  isCached(z: number, x: number, y: number): boolean {
    return !!this.cache?.has(z, x, y);
  }

  /** The tile's bytes, or null: disabled, out of range or unavailable. */
  async get(z: number, x: number, y: number): Promise<Buffer | null> {
    const template = this.opts.urlTemplate;
    if (!template || !this.cache || !this.inRange(z, x, y)) return null;
    const cached = this.cache.get(z, x, y);
    if (cached) return cached;
    const key = `${z}/${x}/${y}`;
    if ((this.failed.get(key) ?? 0) > Date.now()) return null;
    let p = this.inflight.get(key);
    if (!p) {
      const cache = this.cache;
      p = this.limited(async () => {
        try {
          const url = template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
          const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'Athena-sky (drone fleet cloud; tile cache)' } });
          const buf = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
          if (!buf || buf.length > MAX_TILE_BYTES || !this.opts.accept(buf)) throw new Error(`tile ${key} unavailable (HTTP ${res.status})`);
          cache.put(z, x, y, buf);
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

  /** At most a few upstream requests at a time. */
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

/**
 * How many tiles each user may have fetched from a tile service (tiles already cached cost
 * nothing): a bucket of `perHour / 2` tiles, refilled at `perHour` tiles an hour. Keeps a
 * signed-in user from using the server as an unlimited proxy to the tile service.
 */
export class TileBudget {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  readonly burst: number;

  constructor(
    readonly perHour: number,
    private readonly now: () => number = Date.now,
  ) {
    this.burst = Math.max(100, Math.round(perHour / 2));
  }

  /** Charges `n` tiles to `who`: 0 when allowed, otherwise the seconds until they would be. */
  take(who: string, n: number): number {
    if (n <= 0 || this.perHour <= 0) return 0;
    const t = this.now();
    const b = this.buckets.get(who) ?? { tokens: this.burst, at: t };
    b.tokens = Math.min(this.burst, b.tokens + ((t - b.at) / 3_600_000) * this.perHour);
    b.at = t;
    this.buckets.delete(who);
    this.buckets.set(who, b);
    if (this.buckets.size > 10_000) this.buckets.delete(this.buckets.keys().next().value!);
    if (b.tokens >= n) {
      b.tokens -= n;
      return 0;
    }
    return Math.max(1, Math.ceil(((Math.min(n, this.burst) - b.tokens) / this.perHour) * 3600));
  }
}

/**
 * Charges the tiles a request needs from a tile service to the caller's budget, or refuses the
 * request (429, with Retry-After) when that budget is spent.
 */
export function chargeTiles(reply: { header(name: string, value: string): unknown }, budget: TileBudget, who: string, n: number, what: string): void {
  if (budget.perHour <= 0 || n <= 0) return;
  if (n > budget.burst) throw new HttpError(400, 'too_many_tiles', `This request needs ${n} ${what} tiles that are not cached yet; at most ${budget.burst} are fetched at once`);
  const wait = budget.take(who, n);
  if (!wait) return;
  reply.header('retry-after', String(wait));
  throw new HttpError(429, 'tile_limit', `Too many ${what} tiles fetched from the tile service; try again in ${wait} s`, { retryAfterS: wait });
}
