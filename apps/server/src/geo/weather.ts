import type { WeatherDto } from '@athena-sky/shared';
import { unavailable } from '../lib/errors';

export interface WeatherOptions {
  url: string | null;
  fetchImpl?: typeof fetch;
}

/** Flight suitability rules for small multirotors. */
export function assessWeather(w: Pick<WeatherDto, 'windSpeedMs' | 'windGustMs' | 'precipitationMm' | 'visibilityM' | 'temperatureC'>): WeatherDto['assessment'] {
  const reasons: string[] = [];
  let level = 0; // 0 go, 1 caution, 2 no-go
  const flag = (l: number, reason: string) => {
    level = Math.max(level, l);
    reasons.push(reason);
  };
  if (w.windSpeedMs !== null) {
    if (w.windSpeedMs >= 12) flag(2, `Wind ${w.windSpeedMs.toFixed(1)} m/s exceeds 12 m/s`);
    else if (w.windSpeedMs >= 8) flag(1, `Wind ${w.windSpeedMs.toFixed(1)} m/s`);
  }
  if (w.windGustMs !== null) {
    if (w.windGustMs >= 15) flag(2, `Gusts ${w.windGustMs.toFixed(1)} m/s exceed 15 m/s`);
    else if (w.windGustMs >= 11) flag(1, `Gusts ${w.windGustMs.toFixed(1)} m/s`);
  }
  if (w.precipitationMm !== null) {
    if (w.precipitationMm >= 2) flag(2, `Precipitation ${w.precipitationMm} mm/h`);
    else if (w.precipitationMm > 0.2) flag(1, `Light precipitation ${w.precipitationMm} mm/h`);
  }
  if (w.visibilityM !== null) {
    if (w.visibilityM < 1000) flag(2, `Visibility ${Math.round(w.visibilityM)} m below 1 km`);
    else if (w.visibilityM < 3000) flag(1, `Reduced visibility ${Math.round(w.visibilityM)} m`);
  }
  if (w.temperatureC !== null && (w.temperatureC < -10 || w.temperatureC > 45)) {
    flag(1, `Temperature ${w.temperatureC} °C outside battery comfort range`);
  }
  return { status: level === 2 ? 'no-go' : level === 1 ? 'caution' : 'go', reasons };
}

/** Current weather from Open-Meteo (no API key needed), cached for 10 minutes per ~1 km cell. */
export class WeatherService {
  private readonly cache = new Map<string, { at: number; value: WeatherDto }>();
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: WeatherOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async current(lat: number, lon: number): Promise<WeatherDto> {
    if (!this.opts.url) throw unavailable('Weather provider is disabled');
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 600_000) return hit.value;
    const url = new URL(this.opts.url);
    url.searchParams.set('latitude', lat.toFixed(4));
    url.searchParams.set('longitude', lon.toFixed(4));
    url.searchParams.set('current', 'temperature_2m,precipitation,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m');
    url.searchParams.set('hourly', 'visibility');
    url.searchParams.set('forecast_days', '1');
    url.searchParams.set('wind_speed_unit', 'ms');
    url.searchParams.set('timezone', 'GMT');
    let body: any;
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
    } catch (err) {
      throw unavailable(`Weather provider unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const c = body?.current ?? {};
    const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    let visibility: number | null = null;
    const times: unknown = body?.hourly?.time;
    const vis: unknown = body?.hourly?.visibility;
    if (Array.isArray(times) && Array.isArray(vis) && typeof c.time === 'string') {
      const hour = c.time.slice(0, 13);
      const idx = times.findIndex((t: unknown) => typeof t === 'string' && t.slice(0, 13) === hour);
      visibility = n(vis[idx >= 0 ? idx : 0]);
    }
    const partial = {
      temperatureC: n(c.temperature_2m),
      windSpeedMs: n(c.wind_speed_10m),
      windGustMs: n(c.wind_gusts_10m),
      windDirDeg: n(c.wind_direction_10m),
      precipitationMm: n(c.precipitation),
      cloudCoverPct: n(c.cloud_cover),
      visibilityM: visibility,
    };
    const value: WeatherDto = {
      lat,
      lon,
      time: typeof c.time === 'string' ? `${c.time}Z` : new Date().toISOString(),
      ...partial,
      assessment: assessWeather(partial),
      source: 'Open-Meteo',
    };
    this.cache.set(key, { at: Date.now(), value });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }
}
