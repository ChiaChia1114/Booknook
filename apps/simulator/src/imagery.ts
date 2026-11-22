/**
 * Aerial imagery under the simulated camera: Web-Mercator imagery tiles (JPEG) are fetched on
 * demand, decoded and kept in memory, and sampled at the ground point each camera pixel looks
 * at – at the zoom level matching that pixel's footprint – so that the video shows the real
 * place the drone flies over, as the map does.
 */
import jpeg from 'jpeg-js';

/** Where tiles come from: image bytes of a tile, or null when it is unavailable. */
export type TileSource = (z: number, x: number, y: number) => Promise<Uint8Array | null>;

/** A tile source from a URL template (`{z}`, `{x}`, `{y}`), e.g. an Athena-sky server's tile cache. */
export function urlTileSource(template: string, headers: Record<string, string> = {}): TileSource {
  return async (z, x, y) => {
    try {
      const res = await fetch(template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)), { headers, signal: AbortSignal.timeout(15_000) });
      return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
    } catch {
      return null;
    }
  };
}

/** Earth radius of Web Mercator (m). */
const R = 6378137;
const MIN_ZOOM = 12;
const MAX_ZOOM = 19;
const TILE = 256;

interface Tile {
  /** RGB, 256 × 256. */
  rgb: Uint8Array;
}

/** One frame's view of the imagery around a local origin (metres east / north of it). */
export interface ImageryFrame {
  /** The zoom level for pixels covering `footprintM` metres of ground. */
  zoomFor(footprintM: number): number;
  /**
   * Colour (0xRRGGBB) of the ground at (east, north) at zoom `z` – or at a coarser level while
   * that tile loads – or -1 when none is loaded yet.
   */
  sample(east: number, north: number, z: number): number;
}

export class GroundImagery {
  private readonly tiles = new Map<number, Tile>();
  private readonly loading = new Set<number>();
  /** Tiles that could not be loaded: not asked for again before this time (ms). */
  private readonly failed = new Map<number, number>();
  private active = 0;
  private readonly queue: number[] = [];

  constructor(
    private readonly source: TileSource,
    private readonly opts: { maxTiles?: number; concurrency?: number } = {},
  ) {}

  /** Tiles held in memory (tests, diagnostics). */
  get size(): number {
    return this.tiles.size;
  }

  frame(origin: { lat: number; lon: number }): ImageryFrame {
    const lat = (origin.lat * Math.PI) / 180;
    const cosLat = Math.cos(lat);
    // Per zoom level: the origin in global pixel coordinates, and pixels per metre.
    const ppm0 = TILE / (2 * Math.PI * R * cosLat);
    const x00 = ((origin.lon + 180) / 360) * TILE;
    const y00 = ((1 - Math.log(Math.tan(lat) + 1 / cosLat) / Math.PI) / 2) * TILE;
    const x0 = new Float64Array(MAX_ZOOM + 1);
    const y0 = new Float64Array(MAX_ZOOM + 1);
    const ppm = new Float64Array(MAX_ZOOM + 1);
    for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
      x0[z] = x00 * 2 ** z;
      y0[z] = y00 * 2 ** z;
      ppm[z] = ppm0 * 2 ** z;
    }
    let lastKey = -1;
    let lastTile: Tile | undefined;
    return {
      zoomFor: (footprintM) => {
        const z = Math.round(Math.log2(1 / (ppm0 * Math.max(0.05, footprintM))));
        return z < MIN_ZOOM ? MIN_ZOOM : z > MAX_ZOOM ? MAX_ZOOM : z;
      },
      sample: (east, north, z) => {
        for (let zz = z; zz >= MIN_ZOOM; zz--) {
          const gx = x0[zz]! + east * ppm[zz]!;
          const gy = y0[zz]! - north * ppm[zz]!;
          const tx = Math.floor(gx / TILE);
          const ty = Math.floor(gy / TILE);
          const key = (zz * 1048576 + tx) * 1048576 + ty;
          let tile = lastTile;
          if (key !== lastKey) {
            tile = this.tiles.get(key);
            lastKey = key;
            lastTile = tile;
          }
          if (!tile) {
            if (zz === z) this.request(key);
            continue;
          }
          // Bilinear sample within the tile (edges clamped).
          let fx = gx - tx * TILE - 0.5;
          let fy = gy - ty * TILE - 0.5;
          fx = fx < 0 ? 0 : fx > TILE - 1.001 ? TILE - 1.001 : fx;
          fy = fy < 0 ? 0 : fy > TILE - 1.001 ? TILE - 1.001 : fy;
          const ix = fx | 0;
          const iy = fy | 0;
          const ax = fx - ix;
          const ay = fy - iy;
          const w00 = (1 - ax) * (1 - ay);
          const w01 = ax * (1 - ay);
          const w10 = (1 - ax) * ay;
          const w11 = ax * ay;
          const i00 = (iy * TILE + ix) * 3;
          const i10 = i00 + TILE * 3;
          const d = tile.rgb;
          const r = d[i00]! * w00 + d[i00 + 3]! * w01 + d[i10]! * w10 + d[i10 + 3]! * w11;
          const g = d[i00 + 1]! * w00 + d[i00 + 4]! * w01 + d[i10 + 1]! * w10 + d[i10 + 4]! * w11;
          const b = d[i00 + 2]! * w00 + d[i00 + 5]! * w01 + d[i10 + 2]! * w10 + d[i10 + 5]! * w11;
          return ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
        }
        return -1;
      },
    };
  }

  /** Queues a tile for loading (a few at a time; failed tiles wait a minute). */
  private request(key: number): void {
    if (this.loading.has(key) || this.tiles.has(key)) return;
    if ((this.failed.get(key) ?? 0) > Date.now()) return;
    this.loading.add(key);
    this.queue.push(key);
    this.pump();
  }

  private pump(): void {
    const concurrency = this.opts.concurrency ?? 4;
    while (this.active < concurrency && this.queue.length) {
      const key = this.queue.shift()!;
      this.active++;
      void this.load(key).finally(() => {
        this.active--;
        this.loading.delete(key);
        this.pump();
      });
    }
  }

  private async load(key: number): Promise<void> {
    const y = key % 1048576;
    const rest = (key - y) / 1048576;
    const x = rest % 1048576;
    const z = (rest - x) / 1048576;
    const bytes = await this.source(z, x, y).catch(() => null);
    const rgb = bytes ? decodeTile(bytes) : null;
    if (!rgb) {
      this.failed.set(key, Date.now() + 60_000);
      return;
    }
    this.tiles.set(key, { rgb });
    const max = this.opts.maxTiles ?? 160;
    while (this.tiles.size > max) this.tiles.delete(this.tiles.keys().next().value!);
  }
}

/** RGB pixels of a 256 × 256 JPEG tile, or null (other formats and sizes are not used). */
function decodeTile(bytes: Uint8Array): Uint8Array | null {
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) return null;
  try {
    const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: false, maxMemoryUsageInMB: 64 });
    return img.width === TILE && img.height === TILE ? (img.data as Uint8Array) : null;
  } catch {
    return null;
  }
}
