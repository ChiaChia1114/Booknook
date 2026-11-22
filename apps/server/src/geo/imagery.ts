import { TileStore } from './tile-store';

export interface ImageryOptions {
  /** Web-Mercator tile URL template (`{z}`, `{x}`, `{y}`), or null when disabled. */
  urlTemplate: string | null;
  cacheDir: string;
  /** Disk space the tile cache may use (default 1 GiB). */
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

/** Most detailed zoom level served (≈ 0.3 m per pixel at the equator). */
export const IMAGERY_MAX_ZOOM = 19;

/** Image type of tile bytes (JPEG or PNG), or null. */
export function tileImageType(buf: Uint8Array): 'image/jpeg' | 'image/png' | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  return null;
}

/**
 * Aerial imagery tiles: fetched once from the configured tile service, kept in a bounded disk
 * cache, and served from this server – to the web application's satellite layers and to the
 * cameras of simulated drones (which show the real place they fly over). Browsers then only
 * reach this server (a firewall or proxy in front of them does not matter), and every tile is
 * fetched upstream once.
 */
export class ImageryService {
  private readonly store: TileStore;

  constructor(opts: ImageryOptions) {
    this.store = new TileStore({
      urlTemplate: opts.urlTemplate,
      cacheDir: opts.cacheDir,
      ext: 'tile',
      maxZoom: IMAGERY_MAX_ZOOM,
      maxBytes: opts.maxBytes ?? 1024 * 1_048_576,
      accept: (buf) => tileImageType(buf) !== null,
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

  /** Image bytes (JPEG or PNG) of a tile, or null: disabled, out of range or unavailable. */
  tile(z: number, x: number, y: number): Promise<Buffer | null> {
    return this.store.get(z, x, y);
  }
}
