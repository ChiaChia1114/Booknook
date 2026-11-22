import { PNG } from 'pngjs';
import { haversineDistance, interpolateLatLon, maxOf, minOf, type LatLon, type LatLonAlt, type TerrainSummary } from '@athena-sky/shared';
import { TileStore } from './tile-store';

/** Decoded Terrarium tile: 256x256 elevations in metres. */
type Tile = Float32Array;

const TILE = 256;
export const TERRAIN_ZOOM = 12;

/** Converts a position into fractional XYZ (slippy) tile coordinates. */
export function lonLatToTile(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const r = (clampedLat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n,
  };
}

/** Terrarium encoding: height = (R * 256 + G + B / 256) - 32768. */
export function decodeTerrarium(png: Buffer): Tile {
  const img = PNG.sync.read(png);
  if (img.width !== TILE || img.height !== TILE) throw new Error(`unexpected tile size ${img.width}x${img.height}`);
  const out = new Float32Array(TILE * TILE);
  for (let i = 0; i < TILE * TILE; i++) {
    out[i] = img.data[i * 4]! * 256 + img.data[i * 4 + 1]! + img.data[i * 4 + 2]! / 256 - 32768;
  }
  return out;
}

/** Encodes elevations into a Terrarium PNG (used by tests and the demo seed). */
export function encodeTerrarium(heights: (x: number, y: number) => number): Buffer {
  const png = new PNG({ width: TILE, height: TILE });
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const v = heights(x, y) + 32768;
      const i = (y * TILE + x) * 4;
      png.data[i] = Math.floor(v / 256);
      png.data[i + 1] = Math.floor(v) % 256;
      png.data[i + 2] = Math.round((v - Math.floor(v)) * 256) % 256;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

export interface TerrainOptions {
  urlTemplate: string | null;
  cacheDir: string;
  /** Disk space the tile cache may use (default 256 MiB). */
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

/** Most detailed DEM zoom level served. */
export const TERRAIN_MAX_ZOOM = 15;
const isPng = (buf: Buffer) => buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;

/**
 * Terrain elevation from Terrarium-encoded DEM tiles (AWS Open Data "Terrain Tiles" by default).
 * Tiles are cached on disk and decoded tiles are kept in a small in-memory LRU.
 */
export class TerrainService {
  private readonly memory = new Map<string, Tile | null>();
  private readonly store: TileStore;

  constructor(opts: TerrainOptions) {
    this.store = new TileStore({
      urlTemplate: opts.urlTemplate,
      cacheDir: opts.cacheDir,
      ext: 'png',
      maxZoom: TERRAIN_MAX_ZOOM,
      maxBytes: opts.maxBytes ?? 256 * 1_048_576,
      accept: isPng,
      fetchImpl: opts.fetchImpl,
    });
  }

  get enabled(): boolean {
    return this.store.enabled;
  }

  /** Tiles and bytes in the disk cache. */
  get usage(): { tiles: number; bytes: number } {
    return this.store.cache?.usage ?? { tiles: 0, bytes: 0 };
  }

  inRange(z: number, x: number, y: number): boolean {
    return this.store.inRange(z, x, y);
  }

  /** Whether the tile is served without asking the tile service. */
  isCached(z: number, x: number, y: number): boolean {
    return this.store.isCached(z, x, y);
  }

  /** Raw PNG bytes for a tile (disk-cached), or null when unavailable. */
  tilePng(z: number, x: number, y: number): Promise<Buffer | null> {
    return this.store.get(z, x, y);
  }

  /** Number of tiles the elevations of these points need from the tile service. */
  uncachedTiles(points: LatLon[], z = TERRAIN_ZOOM): number {
    if (!this.enabled) return 0;
    const keys = new Set<string>();
    for (const p of points) {
      const t = lonLatToTile(p.lat, p.lon, z);
      const tx = Math.floor(t.x);
      const ty = Math.floor(t.y);
      const key = `${z}/${tx}/${ty}`;
      if (!this.memory.has(key) && !this.store.isCached(z, tx, ty)) keys.add(key);
    }
    return keys.size;
  }

  private async tile(z: number, x: number, y: number): Promise<Tile | null> {
    const key = `${z}/${x}/${y}`;
    if (this.memory.has(key)) {
      const t = this.memory.get(key)!;
      this.memory.delete(key);
      this.memory.set(key, t);
      return t;
    }
    const png = await this.tilePng(z, x, y);
    let decoded: Tile | null = null;
    if (png) {
      try {
        decoded = decodeTerrarium(png);
      } catch {
        decoded = null;
      }
    }
    this.memory.set(key, decoded);
    if (this.memory.size > 64) this.memory.delete(this.memory.keys().next().value!);
    return decoded;
  }

  /**
   * Elevation (m AMSL) at each point, bilinearly interpolated; null where unknown. `charge` is
   * told first how many tiles have to be fetched from the tile service (and may refuse by throwing).
   */
  async elevations(points: LatLon[], charge?: (tiles: number) => void, z = TERRAIN_ZOOM): Promise<(number | null)[]> {
    if (!this.enabled) return points.map(() => null);
    charge?.(this.uncachedTiles(points, z));
    const out: (number | null)[] = [];
    for (const p of points) {
      const t = lonLatToTile(p.lat, p.lon, z);
      const tx = Math.floor(t.x);
      const ty = Math.floor(t.y);
      const tile = await this.tile(z, tx, ty);
      if (!tile) {
        out.push(null);
        continue;
      }
      // pixel centres are at (i + 0.5) / 256
      const px = Math.min(TILE - 1, Math.max(0, (t.x - tx) * TILE - 0.5));
      const py = Math.min(TILE - 1, Math.max(0, (t.y - ty) * TILE - 0.5));
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const x1 = Math.min(TILE - 1, x0 + 1);
      const y1 = Math.min(TILE - 1, y0 + 1);
      const fx = px - x0;
      const fy = py - y0;
      const h = (x: number, y: number) => tile[y * TILE + x]!;
      const v = h(x0, y0) * (1 - fx) * (1 - fy) + h(x1, y0) * fx * (1 - fy) + h(x0, y1) * (1 - fx) * fy + h(x1, y1) * fx * fy;
      out.push(Math.round(v * 10) / 10);
    }
    return out;
  }

  /**
   * Terrain profile along a mission path (altitudes relative to home).
   * Planned AMSL altitude = home ground elevation + relative altitude.
   */
  async profile(path: LatLonAlt[], homeAltMsl: number | null, charge?: (tiles: number) => void, maxSamples = 120): Promise<TerrainSummary> {
    if (path.length === 0) {
      return { homeElevationM: null, minElevationM: null, maxElevationM: null, minClearanceM: null, samples: [] };
    }
    let total = 0;
    for (let i = 1; i < path.length; i++) total += haversineDistance(path[i - 1]!, path[i]!);
    const step = Math.max(5, total / maxSamples);
    const pts: { d: number; p: LatLon; alt: number }[] = [{ d: 0, p: path[0]!, alt: path[0]!.alt }];
    let acc = 0;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!;
      const b = path[i]!;
      const seg = haversineDistance(a, b);
      const n = Math.max(1, Math.ceil(seg / step));
      for (let k = 1; k <= n; k++) {
        const f = k / n;
        pts.push({ d: acc + seg * f, p: interpolateLatLon(a, b, f), alt: a.alt + (b.alt - a.alt) * f });
      }
      acc += seg;
    }
    const elev = await this.elevations([path[0]!, ...pts.map((x) => x.p)], charge);
    const homeElevation = elev[0] ?? homeAltMsl;
    const base = homeElevation ?? 0;
    const samples = pts.map((x, i) => ({ d: Math.round(x.d), elevation: elev[i + 1] ?? null, alt: Math.round((base + x.alt) * 10) / 10 }));
    const known = samples.filter((s) => s.elevation !== null) as { d: number; elevation: number; alt: number }[];
    return {
      homeElevationM: homeElevation,
      minElevationM: known.length ? minOf(known.map((s) => s.elevation)) : null,
      maxElevationM: known.length ? maxOf(known.map((s) => s.elevation)) : null,
      // Only meaningful while airborne: ignore the take-off and landing points on the ground.
      minClearanceM:
        known.length && homeElevation !== null
          ? Math.round(minOf(known.filter((s) => s.alt - base > 1).map((s) => s.alt - s.elevation)) * 10) / 10
          : null,
      samples,
    };
  }
}
