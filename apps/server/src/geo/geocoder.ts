/**
 * Reverse geocoding (place name of a position) for the planner and console headers.
 * Default provider: OpenStreetMap Nominatim. Following its usage policy the service sends an
 * identifying User-Agent, makes at most one request per second and caches results
 * (≈ 100 m grid, 24 h). Set ATHENA_GEOCODER_URL=off to disable.
 */

export interface PlaceDto {
  /** Short label, e.g. "Innsbruck Airport, Austria". */
  name: string | null;
  displayName: string | null;
  source: string;
}

interface Logger {
  warn(obj: unknown, msg?: string): void;
}

export class GeocoderService {
  private readonly cache = new Map<string, { at: number; value: PlaceDto }>();
  private readonly fetchImpl: typeof fetch;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(private readonly opts: { url: string | null; fetchImpl?: typeof fetch; log: Logger; minIntervalMs?: number }) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get enabled(): boolean {
    return !!this.opts.url;
  }

  async reverse(lat: number, lon: number): Promise<PlaceDto> {
    const empty: PlaceDto = { name: null, displayName: null, source: 'OpenStreetMap Nominatim' };
    if (!this.opts.url) return empty;
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 86_400_000) return hit.value;
    // Serialise requests and keep at least one second between them.
    const run = this.queue.then(async () => {
      const again = this.cache.get(key);
      if (again && Date.now() - again.at < 86_400_000) return again.value;
      const wait = (this.opts.minIntervalMs ?? 1000) - (Date.now() - this.lastRequestAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastRequestAt = Date.now();
      const url = new URL(this.opts.url!);
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('lat', lat.toFixed(5));
      url.searchParams.set('lon', lon.toFixed(5));
      url.searchParams.set('zoom', '14');
      url.searchParams.set('accept-language', 'en');
      try {
        const res = await this.fetchImpl(url, { headers: { 'user-agent': 'Athena-sky/2.0 (self-hosted drone operations platform)', accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { name?: string; display_name?: string; address?: Record<string, string> };
        const a = body.address ?? {};
        const locality = a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? a.state;
        const parts = [body.name || a.aeroway || a.amenity || a.road, locality, a.country].filter((p): p is string => !!p);
        const name = [...new Set(parts)].join(', ') || null;
        const value: PlaceDto = { name, displayName: body.display_name ?? null, source: 'OpenStreetMap Nominatim' };
        this.cache.set(key, { at: Date.now(), value });
        if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value!);
        return value;
      } catch (err) {
        this.opts.log.warn({ err: (err as Error).message }, 'reverse geocoding failed');
        return empty;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
