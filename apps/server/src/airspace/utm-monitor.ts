/**
 * Real-time UTM monitoring: checks every airborne drone against the airspace (zones of all
 * providers, approved authorisations, airspace reserved by other operators), the
 * organisation's altitude limit, the other drones of
 * the fleet (loss of separation) and turns manned-traffic advisories and drone faults into
 * notifications. Conditions are de-duplicated while they last and resolved when they end.
 */
import type { AirspaceZoneDto, AuthGeometry, BBox, NotificationCategory, NotificationLevel, Telemetry } from '@athena-sky/shared';
import { haversineDistance, shapeDistanceM, type Shape } from '@athena-sky/shared';
import { runSliced, type Steps } from '../lib/slice';
import { MONITOR_WORK, workOwner } from '../lib/turns';
import type { Db } from '../db/database';
import { parseJson } from '../db/database';
import { getOrgSettings } from '../orgs/org-service';
import type { Hub } from '../realtime/hub';
import type { NotificationService } from '../realtime/notifications';
import { ZONE_LABEL, ZONE_SEVERITY, authShape } from './geometry';
import { boxesOverlap, grow, shapeBox, zoneActiveIn, zoneDistance, zoneInfo } from './zone-index';
import type { AirspaceService } from './providers';

/** Distance at which an approach to a prohibited / restricted / temporary zone is reported. */
export const APPROACH_WARNING_M = 150;
/** Distance to a hazard (power line, obstacle) buffer that is reported. */
export const HAZARD_WARNING_M = 50;
/** Loss of separation between two own drones. */
export const SEPARATION_HORIZONTAL_M = 20;
export const SEPARATION_VERTICAL_M = 10;
/** Drones of the same swarm operation fly close on purpose (planned and deconflicted). */
export const SWARM_SEPARATION_HORIZONTAL_M = 5;
export const SWARM_SEPARATION_VERTICAL_M = 3;

interface Reservation {
  id: string;
  orgId: string;
  reference: string;
  /** Operator name – only for reservations shown on the public safety map. */
  operator: string | null;
  shape: Shape;
  /** The shape's box (its radius included): drones elsewhere are not measured. */
  box: BBox;
  maxAltM: number;
  startAt: number;
  endAt: number;
}

interface OwnAuth {
  droneId: string | null;
  shape: Shape;
  box: BBox;
  maxAltM: number;
  startAt: number;
  endAt: number;
}

interface OrgData {
  at: number;
  maxAltM: number;
  auths: OwnAuth[];
}

/** Authorisations and reservations are read again this often (ms) – a slice at a time, the last copy used meanwhile. */
const REFRESH_MS = 10_000;
/** Authorisations read per query. */
const AUTH_PAGE = 50;

/** Whether a point lies in a box (near the antimeridian: yes). */
const inBox = (b: BBox, p: { lat: number; lon: number }) => boxesOverlap(b, { minLat: p.lat, maxLat: p.lat, minLon: p.lon, maxLon: p.lon });

/** A position of a drone when its telemetry arrived. */
interface Fix {
  t: number;
  lat: number;
  lon: number;
  altMsl: number;
}

/** Position on a drone's recent track at time `s` (linear between fixes, held beyond them). */
function fixAt(track: Fix[], s: number): Fix {
  if (s <= track[0]!.t) return track[0]!;
  for (let i = 1; i < track.length; i++) {
    const b = track[i]!;
    if (s <= b.t) {
      const a = track[i - 1]!;
      const f = b.t > a.t ? (s - a.t) / (b.t - a.t) : 1;
      return { t: s, lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, altMsl: a.altMsl + (b.altMsl - a.altMsl) * f };
    }
  }
  return track[track.length - 1]!;
}

interface Condition {
  notificationId: string;
  lastSeen: number;
}

interface Detected {
  key: string;
  level: NotificationLevel;
  category: NotificationCategory;
  code: string;
  title: string;
  message: string;
  data: Record<string, unknown>;
}

export interface UtmMonitorOptions {
  /** Minimum time between two checks of the same drone (ms). */
  intervalMs?: number;
  /** A condition must be absent this long before it is resolved (hysteresis, ms). */
  clearAfterMs?: number;
}

export class UtmMonitor {
  private readonly lastCheck = new Map<string, number>();
  /** Last positions of every drone (server time), to check separation between two updates. */
  private readonly recent = new Map<string, Fix[]>();
  /** Active conditions by drone, then by condition key. */
  private readonly active = new Map<string, Map<string, Condition>>();
  /** Loss-of-separation conditions by pair key (sorted drone ids). */
  private readonly pairs = new Map<string, Condition & { orgId: string }>();
  /**
   * Each organisation's approved authorisations around now and its altitude limit, and the approved
   * reservations of every operator around now: read again in the background (a slice at a time)
   * every REFRESH_MS – and after a change, which a check waits for (see `detect`).
   */
  private readonly orgCache = new Map<string, OrgData>();
  private readonly orgStale = new Set<string>();
  private readonly orgReading = new Set<string>();
  private reservationCache: { at: number; list: Reservation[] } | null = null;
  private reservationsStale = false;
  private reservationsReading = false;
  private stopped = false;
  private readonly eventDedupe = new Map<string, number>();
  private readonly intervalMs: number;
  private readonly clearAfterMs: number;

  constructor(
    private readonly deps: {
      db: Db;
      hub: Hub;
      airspace: AirspaceService;
      notifications: NotificationService;
      /** True when both drones belong to the same running swarm operation. */
      sameSwarm?: (a: string, b: string) => boolean;
    },
    opts: UtmMonitorOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 2000;
    this.clearAfterMs = opts.clearAfterMs ?? 10_000;
    deps.hub.events.on('telemetry', (orgId, droneId, t) => this.onTelemetry(orgId, droneId, t));
    deps.hub.events.on('event', (orgId, droneId, e) => this.onDroneEvent(orgId, droneId, e));
    deps.hub.events.on('offline', (orgId, droneId) => this.clearDrone(orgId, droneId));
  }

  /** The organisation's data – null while it is first read, or read again after a change. */
  private org(orgId: string): OrgData | null {
    const hit = this.orgCache.get(orgId);
    if (!hit || this.orgStale.has(orgId) || Date.now() - hit.at >= REFRESH_MS) this.readOrg(orgId);
    return hit && !this.orgStale.has(orgId) ? hit : null;
  }

  private readOrg(orgId: string): void {
    if (this.orgReading.has(orgId) || this.stopped) return;
    this.orgReading.add(orgId);
    // Changed again while this reading went on: read once more.
    const changedBefore = this.orgChanges.get(orgId) ?? 0;
    void workOwner
      .run(MONITOR_WORK, () => runSliced(this.orgSteps(orgId)))
      .then((data) => {
        this.orgCache.set(orgId, data);
        if ((this.orgChanges.get(orgId) ?? 0) === changedBefore) this.orgStale.delete(orgId);
      })
      .catch(() => undefined)
      .finally(() => {
        this.orgReading.delete(orgId);
        if (this.orgStale.has(orgId)) this.readOrg(orgId);
      });
  }

  private readonly orgChanges = new Map<string, number>();

  private *orgSteps(orgId: string): Steps<OrgData> {
    const now = Date.now();
    const from = new Date(now).toISOString();
    const to = new Date(now + 3_600_000).toISOString();
    const auths: OwnAuth[] = [];
    // In the order of the organisation's window index (only the rows in effect then are read).
    let after: [string, string, number] = ['', '', -1];
    for (;;) {
      const rows = this.deps.db.all<{ rid: number; drone_id: string | null; geometry: string; max_alt_m: number; start_at: string; end_at: string }>(
        `SELECT rowid AS rid, drone_id, geometry, max_alt_m, start_at, end_at FROM authorizations INDEXED BY authorizations_org_window
          WHERE org_id = ? AND status = 'approved' AND start_at <= ? AND end_at >= ? AND (start_at, end_at, rowid) > (?, ?, ?) ORDER BY start_at, end_at, rowid LIMIT ?`,
        orgId,
        to,
        from,
        ...after,
        AUTH_PAGE,
      );
      for (const r of rows) {
        after = [r.start_at, r.end_at, r.rid];
        const shape = authShape(parseJson<AuthGeometry>(r.geometry, { kind: 'cylinder', center: { lat: 0, lon: 0 }, radiusM: 0 }));
        auths.push({ droneId: r.drone_id, shape, box: shapeBox(shape), maxAltM: r.max_alt_m, startAt: Date.parse(r.start_at), endAt: Date.parse(r.end_at) });
        yield;
      }
      if (rows.length < AUTH_PAGE) break;
    }
    return { at: now, maxAltM: getOrgSettings(this.deps.db, orgId).maxAltitudeM, auths };
  }

  /** Authorisations or settings changed: read again (a check waits for them – see `detect`). */
  invalidate(orgId: string): void {
    this.orgStale.add(orgId);
    this.orgChanges.set(orgId, (this.orgChanges.get(orgId) ?? 0) + 1);
    // Reservations are shared airspace: a change matters to every operator.
    this.reservationsStale = true;
    this.reservationChanges++;
  }

  private reservationChanges = 0;

  /** The approved reservations of every operator around now – null while first read, or read again after a change. */
  private reservations(): Reservation[] | null {
    const hit = this.reservationCache;
    if (!hit || this.reservationsStale || Date.now() - hit.at >= REFRESH_MS) this.readReservations();
    return hit && !this.reservationsStale ? hit.list : null;
  }

  private readReservations(): void {
    if (this.reservationsReading || this.stopped) return;
    this.reservationsReading = true;
    const changedBefore = this.reservationChanges;
    void workOwner
      .run(MONITOR_WORK, () => runSliced(this.reservationSteps()))
      .then((list) => {
        this.reservationCache = { at: Date.now(), list };
        if (this.reservationChanges === changedBefore) this.reservationsStale = false;
      })
      .catch(() => undefined)
      .finally(() => {
        this.reservationsReading = false;
        if (this.reservationsStale) this.readReservations();
      });
  }

  private *reservationSteps(): Steps<Reservation[]> {
    const now = Date.now();
    const from = new Date(now).toISOString();
    const to = new Date(now + 3_600_000).toISOString();
    const list: Reservation[] = [];
    // In the order of the window index (only the rows in effect then are read).
    let after: [string, string, number] = ['', '', -1];
    for (;;) {
      const rows = this.deps.db.all<{ rid: number; id: string; org_id: string; reference: string; geometry: string; max_alt_m: number; start_at: string; end_at: string; is_public: number; org_name: string }>(
        `SELECT a.rowid AS rid, a.id, a.org_id, a.reference, a.geometry, a.max_alt_m, a.start_at, a.end_at, a.is_public, o.name AS org_name
           FROM authorizations a JOIN organisations o ON o.id = a.org_id
          WHERE a.status = 'approved' AND a.start_at <= ? AND a.end_at >= ? AND (a.start_at, a.end_at, a.rowid) > (?, ?, ?) ORDER BY a.start_at, a.end_at, a.rowid LIMIT ?`,
        to,
        from,
        ...after,
        AUTH_PAGE,
      );
      for (const r of rows) {
        after = [r.start_at, r.end_at, r.rid];
        const shape = authShape(parseJson<AuthGeometry>(r.geometry, { kind: 'cylinder', center: { lat: 0, lon: 0 }, radiusM: 0 }));
        list.push({
          id: r.id,
          orgId: r.org_id,
          reference: r.reference,
          operator: r.is_public === 1 ? r.org_name : null,
          shape,
          box: shapeBox(shape),
          maxAltM: r.max_alt_m,
          startAt: Date.parse(r.start_at),
          endAt: Date.parse(r.end_at),
        });
        yield;
      }
      if (rows.length < AUTH_PAGE) return list;
    }
  }

  /** `detect` once what it checks against has been read (tests, tools): waits at most `timeoutMs`. */
  async detectWhenReady(orgId: string, droneId: string, name: string, t: Telemetry, now = Date.now(), timeoutMs = 10_000): Promise<Detected[]> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const found = this.detect(orgId, droneId, name, t, now);
      if (found) return found;
      if (Date.now() > until) throw new Error('The airspace of the organisation could not be read');
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  /** No more readings in the background (the server is closing). */
  stop(): void {
    this.stopped = true;
  }

  /**
   * An approved authorisation covers the drone's position now: one for this drone or an
   * organisation-wide one (no drone) – the same rule as post-flight compliance.
   */
  private authorized(org: OrgData, droneId: string, t: Telemetry, now: number): boolean {
    return org.auths.some((a) => (a.droneId === null || a.droneId === droneId) && a.startAt <= now && a.endAt >= now && t.altRel <= a.maxAltM && inBox(a.box, t) && shapeDistanceM({ kind: 'point', point: t, radiusM: 0 }, a.shape) <= 0);
  }

  /**
   * Conditions of one drone at one instant – null while what they are checked against is still
   * read (the airspace of an organisation not read yet, authorisations or reservations read again
   * after a change): checked with a later update then, nothing resolved meanwhile.
   */
  detect(orgId: string, droneId: string, name: string, t: Telemetry, now = Date.now()): Detected[] | null {
    const out: Detected[] = [];
    if (!t.inAir) return out;
    const zones = this.deps.airspace.zonesIfReady(orgId);
    const org = this.org(orgId);
    const reservations = this.reservations();
    if (!zones || !org || !reservations) return null;
    const alt = Math.round(t.altRel);
    // Only zones whose box comes within the approach distance are measured.
    const around = grow({ minLat: t.lat, maxLat: t.lat, minLon: t.lon, maxLon: t.lon }, APPROACH_WARNING_M + 10);
    for (const z of zones as AirspaceZoneDto[]) {
      const info = zoneInfo(z);
      if (!boxesOverlap(info.box, around)) continue;
      if (!zoneActiveIn(info, now, now)) continue;
      if (t.altRel < z.floorM || t.altRel > z.ceilingM) continue;
      // Signed distance: negative inside a circle / buffer, 0 inside a polygon.
      const d = zoneDistance(z, APPROACH_WARNING_M)(t);
      const label = ZONE_LABEL[z.type];
      const data = { zoneId: z.id, zoneName: z.name, zoneType: z.type, distanceM: Math.max(0, Math.round(d)), altM: alt, lat: t.lat, lon: t.lon };
      if (z.type.startsWith('hazard_')) {
        if (d <= HAZARD_WARNING_M) {
          out.push({ key: `zone:${z.id}`, level: 'warning', category: 'airspace', code: 'hazard_proximity', title: `Close to ${label.toLowerCase()}`, message: `${name} is ${Math.max(0, Math.round(d))} m from ${label.toLowerCase()} "${z.name}" at ${alt} m.`, data });
        }
        continue;
      }
      const severity = ZONE_SEVERITY[z.type];
      if (d <= 0) {
        // Controlled / danger areas are fine with an approved authorisation covering the drone.
        if (severity !== 'blocking' && this.authorized(org, droneId, t, now)) continue;
        out.push({
          key: `zone:${z.id}:inside`,
          level: severity === 'blocking' ? 'critical' : 'warning',
          category: 'airspace',
          code: 'zone_infringement',
          title: `Inside ${label.toLowerCase()}`,
          message: `${name} is inside ${label.toLowerCase()} "${z.name}" (${Math.round(z.floorM)}–${Math.round(z.ceilingM)} m) at ${alt} m${severity === 'blocking' ? '' : ' without an approved authorisation'}.`,
          data,
        });
      } else if (severity === 'blocking' && d <= APPROACH_WARNING_M) {
        out.push({ key: `zone:${z.id}:near`, level: 'warning', category: 'airspace', code: 'zone_approach', title: `Approaching ${label.toLowerCase()}`, message: `${name} is ${Math.round(d)} m from ${label.toLowerCase()} "${z.name}".`, data });
      }
    }
    // Airspace another operator has reserved (approved authorisation) – shared airspace.
    for (const r of reservations) {
      if (r.orgId === orgId || r.startAt > now || r.endAt < now || t.altRel > r.maxAltM || !inBox(r.box, t)) continue;
      if (shapeDistanceM({ kind: 'point', point: { lat: t.lat, lon: t.lon }, radiusM: 0 }, r.shape) > 0) continue;
      const by = r.operator ? `${r.operator} (${r.reference})` : 'another operator';
      out.push({
        key: `reservation:${r.id}`,
        level: 'critical',
        category: 'airspace',
        code: 'reservation_infringement',
        title: 'Inside airspace reserved by another operator',
        message: `${name} is inside airspace reserved by ${by} (up to ${Math.round(r.maxAltM)} m) at ${alt} m.`,
        data: { reference: r.operator ? r.reference : null, operator: r.operator, altM: alt, lat: t.lat, lon: t.lon },
      });
    }
    const maxAlt = org.maxAltM;
    if (t.altRel > maxAlt) {
      out.push({ key: 'altitude', level: 'warning', category: 'altitude', code: 'altitude_limit', title: 'Altitude limit exceeded', message: `${name} is at ${alt} m – the organisation's limit is ${maxAlt} m.`, data: { altM: alt, limitM: maxAlt } });
    }
    return out;
  }

  private onTelemetry(orgId: string, droneId: string, t: Telemetry): void {
    const now = Date.now();
    const track = this.recent.get(droneId) ?? [];
    track.push({ t: now, lat: t.lat, lon: t.lon, altMsl: t.altMsl });
    if (track.length > 8) track.shift();
    this.recent.set(droneId, track);
    // Separation is checked with every update, along the stretch flown since the previous one:
    // two drones passing each other between updates are caught too.
    this.checkSeparation(orgId, droneId, this.deps.hub.droneName(droneId) ?? 'Drone', t, now);
    if (now - (this.lastCheck.get(droneId) ?? 0) < this.intervalMs) return;
    const name = this.deps.hub.droneName(droneId) ?? 'Drone';
    const found = this.detect(orgId, droneId, name, t, now);
    // What it is checked against is still being read: checked with a later update.
    if (!found) return;
    this.lastCheck.set(droneId, now);
    const conds = this.active.get(droneId) ?? new Map<string, Condition>();
    this.active.set(droneId, conds);
    const seen = new Set<string>();
    for (const d of found) {
      seen.add(d.key);
      const c = conds.get(d.key);
      if (c) {
        c.lastSeen = now;
        continue;
      }
      const n = this.deps.notifications.create(orgId, { level: d.level, category: d.category, code: d.code, droneId, title: d.title, message: d.message, data: d.data });
      conds.set(d.key, { notificationId: n.id, lastSeen: now });
    }
    for (const [key, c] of conds) {
      if (!seen.has(key) && now - c.lastSeen > this.clearAfterMs) {
        this.deps.notifications.resolve(orgId, c.notificationId);
        conds.delete(key);
      }
    }
  }

  private checkSeparation(orgId: string, droneId: string, name: string, t: Telemetry, now: number): void {
    const mine = this.recent.get(droneId);
    if (!mine?.length) return;
    const cur = mine[mine.length - 1]!;
    const prev = mine.length > 1 ? mine[mine.length - 2]! : null;
    // The stretch since the previous update (not across a gap in the telemetry).
    const from = prev && cur.t - prev.t <= 3000 ? prev.t : cur.t;
    for (const other of this.deps.hub.orgDroneStates(orgId)) {
      if (other.droneId === droneId) continue;
      const key = [droneId, other.droneId].sort().join('|');
      const o = other.telemetry;
      const theirs = this.recent.get(other.droneId);
      const swarm = this.deps.sameSwarm?.(droneId, other.droneId) ?? false;
      const maxH = swarm ? SWARM_SEPARATION_HORIZONTAL_M : SEPARATION_HORIZONTAL_M;
      const maxV = swarm ? SWARM_SEPARATION_VERTICAL_M : SEPARATION_VERTICAL_M;
      let closest: { h: number; v: number } | null = null;
      if (t.inAir && other.online && !!o?.inAir && now - o.t < 10_000 && theirs?.length) {
        const a0 = fixAt(mine, from);
        const b0 = fixAt(theirs, from);
        const b1 = fixAt(theirs, cur.t);
        // Too far apart to have come close in between.
        const moved = haversineDistance(a0, cur) + haversineDistance(b0, b1);
        if (haversineDistance(cur, b1) - moved < maxH) {
          const steps = Math.min(30, Math.max(1, Math.ceil((cur.t - from) / 100)));
          for (let k = 0; k <= steps; k++) {
            const at = from + ((cur.t - from) * k) / steps;
            const a = fixAt(mine, at);
            const b = fixAt(theirs, at);
            const h = haversineDistance(a, b);
            const v = Math.abs(a.altMsl - b.altMsl);
            if (h < maxH && v < maxV && (!closest || Math.hypot(h, v) < Math.hypot(closest.h, closest.v))) closest = { h, v };
          }
        }
      }
      const c = this.pairs.get(key);
      if (closest) {
        if (c) {
          c.lastSeen = now;
          continue;
        }
        const h = Math.round(closest.h);
        const v = Math.round(closest.v);
        const n = this.deps.notifications.create(orgId, {
          level: 'warning',
          category: 'separation',
          code: 'loss_of_separation',
          droneId,
          title: 'Loss of separation',
          message: `${name} and ${other.name} came ${h} m apart horizontally and ${v} m vertically.`,
          data: { otherDroneId: other.droneId, otherName: other.name, horizontalM: h, verticalM: v },
        });
        this.pairs.set(key, { orgId, notificationId: n.id, lastSeen: now });
      } else if (c && now - c.lastSeen > this.clearAfterMs) {
        this.deps.notifications.resolve(orgId, c.notificationId);
        this.pairs.delete(key);
      }
    }
  }

  private onDroneEvent(orgId: string, droneId: string, e: { level: string; code?: string; message: string }): void {
    const traffic = e.code === 'traffic';
    if (!traffic && e.level !== 'critical' && e.level !== 'error') return;
    // The same fault reported repeatedly within a minute is one notification.
    const key = `${droneId}:${e.code ?? ''}:${e.message}`;
    const now = Date.now();
    if (now - (this.eventDedupe.get(key) ?? 0) < 60_000) return;
    this.eventDedupe.set(key, now);
    if (this.eventDedupe.size > 5000) this.eventDedupe.clear();
    const name = this.deps.hub.droneName(droneId) ?? 'Drone';
    this.deps.notifications.create(orgId, {
      level: traffic ? 'warning' : e.level === 'critical' ? 'critical' : 'warning',
      category: traffic ? 'traffic' : 'drone',
      code: e.code ?? (traffic ? 'traffic' : 'drone_alert'),
      droneId,
      title: traffic ? 'Manned traffic nearby' : `${name}: ${e.level === 'critical' ? 'critical alert' : 'error'}`,
      message: traffic ? `${name} – ${e.message}` : e.message,
      data: null,
    });
  }

  /** A drone that went offline cannot keep its conditions alive. */
  private clearDrone(orgId: string, droneId: string): void {
    const conds = this.active.get(droneId);
    if (conds) for (const c of conds.values()) this.deps.notifications.resolve(orgId, c.notificationId);
    this.active.delete(droneId);
    this.lastCheck.delete(droneId);
    this.recent.delete(droneId);
    for (const [key, c] of this.pairs) {
      if (key.split('|').includes(droneId)) {
        this.deps.notifications.resolve(c.orgId, c.notificationId);
        this.pairs.delete(key);
      }
    }
  }
}
