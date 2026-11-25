/**
 * Airspace data providers.
 *
 * Every consumer of airspace data (zone list, airspace checks, flight authorisations, mission
 * checks, post-flight compliance, the live UTM monitor) goes through {@link AirspaceService},
 * which merges the zones of all configured providers:
 *
 *  - {@link OrgZoneProvider} – zones drawn or imported by the organisation (built in, editable);
 *  - {@link GeoJsonFeedProvider} – a read-only external feed (e.g. an aviation authority's
 *    published UAS geographical zones) polled from a GeoJSON URL configured by the operator
 *    with `ATHENA_AIRSPACE_FEEDS`.
 *
 * Connecting another UTM / airspace service means implementing {@link AirspaceProvider}
 * (serve cached zones synchronously, refresh in the background) and registering it in app.ts.
 */
import type { AirspaceProviderDto, AirspaceZoneDto } from '@athena-sky/shared';
import type { Db } from '../db/database';
import { feedOrigin, nowIso } from '../lib/util';
import { listZones } from './airspace-service';
import { parseZoneFeatures } from './geojson';

export { feedOrigin };

export interface AirspaceProvider {
  readonly id: string;
  readonly name: string;
  readonly kind: AirspaceProviderDto['kind'];
  /**
   * Zones that apply to an organisation. Synchronous by design: remote providers serve their
   * last successful download and refresh in the background, so a provider outage never blocks
   * a safety check (the status reports the staleness instead).
   */
  zones(orgId: string): AirspaceZoneDto[];
  status(): AirspaceProviderDto;
  start?(): void;
  stop?(): void;
}

interface Logger {
  warn(obj: unknown, msg?: string): void;
}

/** Built-in provider: the organisation's own zones stored in the database. */
export class OrgZoneProvider implements AirspaceProvider {
  readonly id = 'org';
  readonly name = 'Organisation zones';
  readonly kind = 'builtin' as const;
  /** The zones of each organisation, read once (and again after a change, or a minute). */
  private readonly cache = new Map<string, { at: number; zones: AirspaceZoneDto[] }>();
  constructor(private readonly db: Db) {}

  zones(orgId: string): AirspaceZoneDto[] {
    const hit = this.cache.get(orgId);
    if (hit && Date.now() - hit.at < 60_000) return hit.zones;
    const zones = listZones(this.db, orgId);
    this.cache.set(orgId, { at: Date.now(), zones });
    return zones;
  }

  /** The organisation's zones changed. */
  invalidate(orgId: string): void {
    this.cache.delete(orgId);
  }

  status(): AirspaceProviderDto {
    return { id: this.id, name: this.name, kind: this.kind, url: null, zoneCount: null, lastFetchAt: null, lastError: null, skipped: 0, issues: [] };
  }
}

export interface FeedOptions {
  id: string;
  name: string;
  url: string;
  refreshMs: number;
  log: Logger;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  maxFeatures?: number;
}

/** Most reasons of each kind written to the server log for one download. */
export const FEED_LOG_MAX = 1000;

/** Most reasons shown for a feed of each kind – skipped, simplified (the rest are counted). */
export const FEED_ISSUES_SHOWN = 40;

/**
 * Why features of a feed were skipped, then how others were simplified: each list on its own
 * cut at `FEED_ISSUES_SHOWN`, so that many skipped features do not hide the simplifications.
 */
export function feedIssues(skipped: string[], warnings: string[]): string[] {
  const cut = (list: string[], what: string) =>
    list.length <= FEED_ISSUES_SHOWN ? list : [...list.slice(0, FEED_ISSUES_SHOWN - 1), `… and ${list.length - FEED_ISSUES_SHOWN + 1} more ${what}`];
  return [...cut(skipped.map((x) => `Skipped ${x}`), 'skipped'), ...cut(warnings, 'simplified')];
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`feed is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * External airspace feed: a GeoJSON FeatureCollection downloaded from a URL and refreshed
 * periodically. Its zones are read-only and shared by every organisation on the server.
 */
export class GeoJsonFeedProvider implements AirspaceProvider {
  readonly kind = 'geojson-feed' as const;
  readonly id: string;
  readonly name: string;
  private cache: AirspaceZoneDto[] = [];
  private lastFetchAt: string | null = null;
  private lastError: string | null = null;
  private skipped = 0;
  /** What the last download skipped or simplified, and why. */
  private issues: string[] = [];
  private inflight: Promise<void> | null = null;
  private lastAttemptAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: FeedOptions) {
    this.id = opts.id;
    this.name = opts.name;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), Math.max(60_000, this.opts.refreshMs));
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  zones(): AirspaceZoneDto[] {
    return this.cache;
  }

  status(): AirspaceProviderDto {
    return {
      id: this.id,
      name: this.name,
      kind: this.kind,
      // Every signed-in account can list the feeds: show where they come from, never a key
      // that may be part of the address (credentials, path, query).
      url: feedOrigin(this.opts.url),
      zoneCount: this.cache.length,
      lastFetchAt: this.lastFetchAt,
      lastError: this.lastError,
      skipped: this.skipped,
      issues: this.issues,
    };
  }

  /** Downloads the feed now (concurrent calls share one request). Never throws. */
  refresh(): Promise<void> {
    this.inflight ??= this.load().finally(() => (this.inflight = null));
    return this.inflight;
  }

  /** Manual refresh: skipped when the last attempt is more recent than `minAgeMs`. */
  refreshIfOlderThan(minAgeMs: number): Promise<void> {
    if (this.inflight) return this.inflight;
    if (this.lastAttemptAt !== null && Date.now() - this.lastAttemptAt < minAgeMs) return Promise.resolve();
    return this.refresh();
  }

  private async load(): Promise<void> {
    this.lastAttemptAt = Date.now();
    try {
      const res = await this.fetchImpl(this.opts.url, {
        headers: { accept: 'application/geo+json, application/json', 'user-agent': 'Athena-sky-Airspace/1.0' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`HTTP ${res.status}`);
      }
      const text = await readLimited(res, this.opts.maxBytes ?? 25 * 1_048_576);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error('feed is not valid JSON');
      }
      const { zones, skipped, warnings } = parseZoneFeatures(json, 'restricted', this.opts.maxFeatures ?? 20_000);
      const fetchedAt = nowIso();
      const seen = new Set<string>();
      this.cache = zones.map((z, i) => {
        let key = z.featureId ?? String(i);
        if (seen.has(key)) key = `${key}~${i}`;
        seen.add(key);
        return {
          id: `feed:${this.id}:${key}`,
          name: z.name,
          type: z.type,
          geometry: z.geometry,
          floorM: z.floorM,
          ceilingM: z.ceilingM,
          activeFrom: z.activeFrom,
          activeTo: z.activeTo,
          source: `feed:${this.id}`,
          notes: z.notes,
          createdAt: fetchedAt,
          readOnly: true,
        };
      });
      this.skipped = skipped.length;
      this.issues = feedIssues(skipped, warnings);
      // The log keeps the reasons the status shortens (up to a thousand of each kind).
      if (this.issues.length) {
        this.opts.log.warn(
          { feed: this.id, skipped: skipped.length, simplified: warnings.length, skippedReasons: skipped.slice(0, FEED_LOG_MAX), simplifications: warnings.slice(0, FEED_LOG_MAX) },
          'airspace feed: features skipped or simplified',
        );
      }
      this.lastFetchAt = fetchedAt;
      this.lastError = null;
    } catch (err) {
      // Keep serving the last good copy; the status endpoint shows the error.
      const message = err instanceof Error ? err.message : String(err);
      this.opts.log.warn({ feed: this.id, err: message }, 'airspace feed refresh failed');
      this.lastError = message.split(this.opts.url).join(feedOrigin(this.opts.url) ?? 'the feed').replace(/https?:\/\/\S+/g, (u) => feedOrigin(u) ?? 'a URL');
    }
  }
}

/** Merges all providers; the single entry point for airspace data. */
export class AirspaceService {
  constructor(private readonly providers: AirspaceProvider[]) {}

  zones(orgId: string): AirspaceZoneDto[] {
    return this.providers.flatMap((p) => p.zones(orgId));
  }

  /** An organisation's own zones changed (created, edited, deleted, imported). */
  invalidate(orgId: string): void {
    for (const p of this.providers) if (p instanceof OrgZoneProvider) p.invalidate(orgId);
  }

  provider(id: string): AirspaceProvider | undefined {
    return this.providers.find((p) => p.id === id);
  }

  statuses(): AirspaceProviderDto[] {
    return this.providers.map((p) => p.status());
  }

  start(): void {
    for (const p of this.providers) p.start?.();
  }

  stop(): void {
    for (const p of this.providers) p.stop?.();
  }
}
