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
import { runSliced, type Steps } from '../lib/slice';
import { AIRSPACE_WORK, workOwner } from '../lib/turns';
import { feedOrigin, nowIso } from '../lib/util';
import { listZones, zoneDto } from './airspace-service';
import { parseZoneFeatures, type ParsedZoneFeature } from './geojson';
import { zonePoints } from './geometry';
import { zoneInfo } from './zone-index';

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
  /** The zones when they are at hand – null while they are read (which this starts). */
  zonesIfReady?(orgId: string): AirspaceZoneDto[] | null;
  /** Resolves once the organisation's zones are at hand (read a slice at a time if they are not). */
  ready?(orgId: string): Promise<void>;
  status(): AirspaceProviderDto;
  start?(): void;
  stop?(): void;
}

interface Logger {
  warn(obj: unknown, msg?: string): void;
}

/** As SQLite orders names (BINARY: UTF-8 bytes, i.e. code points). */
function byName(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(i)!;
    if (x !== y) return x < y ? -1 : 1;
    if (x > 0xffff) i++;
  }
  return a.length - b.length;
}

/** Points of the organisations' zones kept at hand, all together (beyond, those used longest ago are let go – and read again when needed). */
export const ZONE_CACHE_POINTS = 1_000_000;

interface OrgZones {
  zones: AirspaceZoneDto[];
  points: number;
}

/**
 * Built-in provider: the organisation's own zones stored in the database – read once, a slice at
 * a time (see `ready`), and then kept: a change is applied to the zones at hand (see `changed`), so
 * they are never all read again while drones fly. Each zone's box and shape are prepared as it is
 * read (zone-index.ts).
 */
export class OrgZoneProvider implements AirspaceProvider {
  readonly id = 'org';
  readonly name = 'Organisation zones';
  readonly kind = 'builtin' as const;
  /** Most recently used last. */
  private readonly cache = new Map<string, OrgZones>();
  private cachedPoints = 0;
  private readonly loading = new Map<string, { promise: Promise<void>; changed: Set<string> }>();
  constructor(
    private readonly db: Db,
    private readonly cachePoints = ZONE_CACHE_POINTS,
  ) {}

  private hit(orgId: string): OrgZones | undefined {
    const hit = this.cache.get(orgId);
    if (hit) {
      this.cache.delete(orgId);
      this.cache.set(orgId, hit);
    }
    return hit;
  }

  private store(orgId: string, zones: AirspaceZoneDto[]): void {
    const old = this.cache.get(orgId);
    if (old) this.cachedPoints -= old.points;
    this.cache.delete(orgId);
    let points = 0;
    for (const z of zones) points += zonePoints(z.geometry);
    this.cache.set(orgId, { zones, points });
    this.cachedPoints += points;
    for (const [id, entry] of this.cache) {
      if (this.cachedPoints <= this.cachePoints || id === orgId) break;
      this.cache.delete(id);
      this.cachedPoints -= entry.points;
    }
  }

  zones(orgId: string): AirspaceZoneDto[] {
    const hit = this.hit(orgId);
    if (hit) return hit.zones;
    // Not at hand (whoever can wait reads them a slice at a time first – see `ready`): at once.
    const zones = listZones(this.db, orgId);
    this.store(orgId, zones);
    return zones;
  }

  zonesIfReady(orgId: string): AirspaceZoneDto[] | null {
    const hit = this.hit(orgId);
    if (hit) return hit.zones;
    void this.ready(orgId);
    return null;
  }

  /** Points of the organisation's zones (see `zonePoints`). */
  points(orgId: string): number {
    this.zones(orgId);
    return this.cache.get(orgId)!.points;
  }

  ready(orgId: string): Promise<void> {
    if (this.cache.has(orgId)) return Promise.resolve();
    const loading = this.loading.get(orgId);
    if (loading) return loading.promise;
    const changed = new Set<string>();
    // The cloud's airspace work (whoever asks first): read once for all who wait for it.
    const promise = workOwner.run(AIRSPACE_WORK, async () => {
      try {
        let zones = await runSliced(this.readSteps(orgId));
        // Forgotten while they were read (see `invalidate`): read once more.
        if (changed.delete('*')) zones = await runSliced(this.readSteps(orgId));
        // Zones changed while they were read: those are read again.
        const ids = [...changed].filter((id) => id !== '*');
        const again = await runSliced(this.rowsSteps(orgId, ids));
        if (!this.cache.has(orgId)) this.store(orgId, applied(zones, ids, again));
      } finally {
        this.loading.delete(orgId);
      }
    });
    this.loading.set(orgId, { promise, changed });
    return promise;
  }

  /** The organisation's zones in order, a row at a time (each prepared as it is read). */
  private *readSteps(orgId: string): Steps<AirspaceZoneDto[]> {
    const ids = this.db.all<{ rid: number }>('SELECT rowid AS rid FROM airspace_zones WHERE org_id = ? ORDER BY name, rowid', orgId);
    yield;
    const zones: AirspaceZoneDto[] = [];
    for (const { rid } of ids) {
      const r = this.db.get<any>('SELECT * FROM airspace_zones WHERE rowid = ?', rid);
      if (r) {
        const z = zoneDto(r);
        zoneInfo(z);
        zones.push(z);
      }
      yield;
    }
    return zones;
  }

  /** Zones by id as they are now (missing: deleted). */
  private *rowsSteps(orgId: string, ids: string[]): Steps<Map<string, AirspaceZoneDto>> {
    const out = new Map<string, AirspaceZoneDto>();
    for (const id of ids) {
      const r = this.db.get<any>('SELECT * FROM airspace_zones WHERE id = ? AND org_id = ?', id, orgId);
      if (r) {
        const z = zoneDto(r);
        zoneInfo(z);
        out.set(id, z);
      }
      yield;
    }
    return out;
  }

  /**
   * Zones of the organisation were created, changed or deleted: they are read again (a slice at a
   * time) and put in place in the zones at hand – the others are not read again.
   */
  async changed(orgId: string, ids: string[]): Promise<void> {
    const loading = this.loading.get(orgId);
    if (loading) for (const id of ids) loading.changed.add(id);
    if (!this.cache.has(orgId)) return;
    const rows = await runSliced(this.rowsSteps(orgId, ids));
    // The zones at hand now (others may have been put in place meanwhile).
    const now = this.cache.get(orgId);
    if (now) this.store(orgId, applied(now.zones, ids, rows));
  }

  /** Forgets the organisation's zones (read again when needed). */
  invalidate(orgId: string): void {
    const old = this.cache.get(orgId);
    if (old) this.cachedPoints -= old.points;
    this.cache.delete(orgId);
    const loading = this.loading.get(orgId);
    // A reading under way may have read some before: what it read is read again.
    if (loading) loading.changed.add('*');
  }

  status(): AirspaceProviderDto {
    return { id: this.id, name: this.name, kind: this.kind, url: null, zoneCount: null, lastFetchAt: null, lastError: null, skipped: 0, issues: [] };
  }
}

/** `zones` with the zones of `ids` replaced by `rows` (or removed), in name order. */
function applied(zones: AirspaceZoneDto[], ids: string[], rows: Map<string, AirspaceZoneDto>): AirspaceZoneDto[] {
  if (!ids.length) return zones;
  const gone = new Set(ids);
  const out = zones.filter((z) => !gone.has(z.id));
  for (const id of ids) {
    const z = rows.get(id);
    if (!z) continue;
    // After the zones of the same name (a new one comes last of them, as its row does).
    let lo = 0;
    let hi = out.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (byName(out[mid]!.name, z.name) <= 0) lo = mid + 1;
      else hi = mid;
    }
    out.splice(lo, 0, z);
  }
  return out;
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
  /** Reads the feed (the planning worker: a large feed is never read on the event loop); here when absent. */
  parse?: (bytes: Uint8Array, maxFeatures: number) => Promise<ParsedFeed>;
}

/** Most reasons of each kind written to the server log for one download. */
export const FEED_LOG_MAX = 1000;

/** Most reasons shown for a feed of each kind – skipped, simplified (the rest are counted). */
export const FEED_ISSUES_SHOWN = 40;

/**
 * Why features of a feed were skipped, then how others were simplified: each list on its own
 * cut at `FEED_ISSUES_SHOWN`, so that many skipped features do not hide the simplifications.
 */
export function feedIssues(skipped: string[], warnings: string[], skippedCount = skipped.length, warningCount = warnings.length): string[] {
  const cut = (list: string[], total: number, what: string) =>
    total <= FEED_ISSUES_SHOWN ? list : [...list.slice(0, FEED_ISSUES_SHOWN - 1), `… and ${total - FEED_ISSUES_SHOWN + 1} more ${what}`];
  return [...cut(skipped.map((x) => `Skipped ${x}`), skippedCount, 'skipped'), ...cut(warnings, warningCount, 'simplified')];
}

/** A feed read: each zone as JSON text, and why features were skipped or simplified (the first `FEED_LOG_MAX` of each, and how many). */
export interface ParsedFeed {
  zones: string[];
  skipped: string[];
  skippedCount: number;
  warnings: string[];
  warningCount: number;
}

/** Reads a feed's bytes (in the planning worker – see tasks.ts – or here when there is none). */
export function parseFeed(bytes: Uint8Array, maxFeatures: number, logMax = FEED_LOG_MAX): ParsedFeed {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('feed is not valid JSON');
  }
  const { zones, skipped, warnings } = parseZoneFeatures(json, 'restricted', maxFeatures);
  return { zones: zones.map((z) => JSON.stringify(z)), skipped: skipped.slice(0, logMax), skippedCount: skipped.length, warnings: warnings.slice(0, logMax), warningCount: warnings.length };
}

async function readLimited(res: Response, maxBytes: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
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
  return Buffer.concat(chunks);
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

  private *zonesSteps(texts: string[], fetchedAt: string): Steps<AirspaceZoneDto[]> {
    const seen = new Set<string>();
    const out: AirspaceZoneDto[] = [];
    for (let i = 0; i < texts.length; i++) {
      const z = JSON.parse(texts[i]!) as ParsedZoneFeature;
      let key = z.featureId ?? String(i);
      if (seen.has(key)) key = `${key}~${i}`;
      seen.add(key);
      const dto: AirspaceZoneDto = {
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
      zoneInfo(dto);
      out.push(dto);
      yield;
    }
    return out;
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
      const bytes = await readLimited(res, this.opts.maxBytes ?? 25 * 1_048_576);
      const maxFeatures = this.opts.maxFeatures ?? 20_000;
      const parsed = this.opts.parse ? await this.opts.parse(bytes, maxFeatures) : parseFeed(bytes, maxFeatures);
      const fetchedAt = nowIso();
      // The zones made a slice at a time (each prepared as it is made), then put in place at once.
      this.cache = await workOwner.run(AIRSPACE_WORK, () => runSliced(this.zonesSteps(parsed.zones, fetchedAt)));
      const { skipped, warnings } = parsed;
      this.skipped = parsed.skippedCount;
      this.issues = feedIssues(skipped, warnings, parsed.skippedCount, parsed.warningCount);
      // The log keeps the reasons the status shortens (up to a thousand of each kind).
      if (this.issues.length) {
        this.opts.log.warn(
          { feed: this.id, skipped: parsed.skippedCount, simplified: parsed.warningCount, skippedReasons: skipped.slice(0, FEED_LOG_MAX), simplifications: warnings.slice(0, FEED_LOG_MAX) },
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

  /** The zones when every provider has them at hand – null while some are read (which this starts). */
  zonesIfReady(orgId: string): AirspaceZoneDto[] | null {
    const out: AirspaceZoneDto[] = [];
    let ready = true;
    for (const p of this.providers) {
      const zones = p.zonesIfReady ? p.zonesIfReady(orgId) : p.zones(orgId);
      if (zones) out.push(...zones);
      else ready = false;
    }
    return ready ? out : null;
  }

  /** Resolves once the organisation's zones are at hand (read a slice at a time where they are not). */
  async ready(orgId: string): Promise<void> {
    for (const p of this.providers) await p.ready?.(orgId);
  }

  private get org(): OrgZoneProvider | undefined {
    return this.providers.find((p): p is OrgZoneProvider => p instanceof OrgZoneProvider);
  }

  /** Points of the organisation's own zones (see `zonePoints`). */
  async orgZonePoints(orgId: string): Promise<number> {
    const org = this.org;
    if (!org) return 0;
    await org.ready(orgId);
    return org.points(orgId);
  }

  /** Zones of an organisation were created, edited, deleted or imported: put in place (see `OrgZoneProvider.changed`). */
  changed(orgId: string, ids: string[]): Promise<void> {
    return this.org?.changed(orgId, ids) ?? Promise.resolve();
  }

  /** Forgets an organisation's own zones (read again when needed). */
  invalidate(orgId: string): void {
    this.org?.invalidate(orgId);
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
