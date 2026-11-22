/**
 * Mission model, validation, statistics, survey generation and
 * QGroundControl (.plan) / Mission Planner (QGC WPL 110) interchange.
 *
 * Altitudes of mission items are metres relative to the home (takeoff) position.
 */
import {
  LocalProjection,
  centroidOf,
  haversineDistance,
  isValidLatLon,
  pointInPolygon,
  segmentCrossesPolygon,
  type LatLon,
  type LatLonAlt,
} from './geo';

export const MISSION_ITEM_TYPES = ['takeoff', 'waypoint', 'loiter', 'land', 'rtl', 'speed', 'photo', 'camera_trigger'] as const;
export type MissionItemType = (typeof MISSION_ITEM_TYPES)[number];

export interface MissionItem {
  /** Stable client-side identifier. */
  id: string;
  type: MissionItemType;
  lat?: number;
  lon?: number;
  /** Altitude relative to home (m). */
  alt?: number;
  /** Cruise speed (m/s) – for `speed` items, or an optional per-waypoint speed. */
  speed?: number;
  /** Hold time at the item (s) – used by `waypoint` and `loiter`. */
  holdS?: number;
  /** Heading the drone turns to while flying to a `waypoint` (degrees from north). */
  yawDeg?: number;
  /** `camera_trigger`: take a photo every N metres (0 stops triggering). */
  triggerDistanceM?: number;
  /** `loiter`: circle radius (m); 0 or absent = hover on the spot. */
  radiusM?: number;
  /** `loiter`: number of turns (instead of a hold time). */
  turns?: number;
  /** `loiter`: loiter until the operator continues the mission. */
  unlimited?: boolean;
}

export interface RallyPoint {
  lat: number;
  lon: number;
  alt: number;
}

export type GeofenceAction = 'rtl' | 'land' | 'hold';

export interface Geofence {
  /** Inclusion polygon (flight must stay inside). */
  polygon: LatLon[];
  /** Maximum altitude relative to home (m). */
  maxAlt?: number | null;
  action: GeofenceAction;
}

export interface MissionPlan {
  home?: LatLonAlt | null;
  items: MissionItem[];
  rallyPoints: RallyPoint[];
  geofence?: Geofence | null;
  /** Default cruise speed (m/s). */
  defaultSpeed: number;
  /** Default altitude for new waypoints (m). */
  defaultAlt: number;
}

export interface MissionIssue {
  level: 'error' | 'warning';
  message: string;
  itemIndex?: number;
}

export interface MissionStats {
  horizontalDistanceM: number;
  totalDistanceM: number;
  estimatedTimeS: number;
  maxAltM: number;
  waypointCount: number;
  photoCount: number;
  /** Estimated battery consumption (%), using the supplied endurance. */
  estimatedBatteryPct: number;
}

export const DEFAULT_MAX_ALTITUDE_M = 120;
export const NAV_TYPES: ReadonlySet<MissionItemType> = new Set(['takeoff', 'waypoint', 'loiter', 'land', 'rtl']);

let idCounter = 0;
export function newItemId(): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `i${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function emptyPlan(): MissionPlan {
  return { home: null, items: [], rallyPoints: [], geofence: null, defaultSpeed: 8, defaultAlt: 50 };
}

const hasPos = (it: MissionItem): it is MissionItem & { lat: number; lon: number } =>
  isValidLatLon({ lat: it.lat, lon: it.lon });

/** Sanitises an untrusted plan object into a well-formed MissionPlan (throws on structural errors). */
export function normalizePlan(raw: unknown): MissionPlan {
  if (!raw || typeof raw !== 'object') throw new Error('plan must be an object');
  const r = raw as Record<string, unknown>;
  const items = Array.isArray(r.items) ? r.items : [];
  if (items.length > 2000) throw new Error('too many mission items (max 2000)');
  const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const plan: MissionPlan = {
    home: null,
    items: items.map((x, i) => {
      const it = (x ?? {}) as Record<string, unknown>;
      const type = it.type as MissionItemType;
      if (!MISSION_ITEM_TYPES.includes(type)) throw new Error(`item ${i}: unknown type ${String(it.type)}`);
      const out: MissionItem = { id: typeof it.id === 'string' && it.id ? it.id.slice(0, 64) : newItemId(), type };
      const lat = n(it.lat);
      const lon = n(it.lon);
      if (lat !== undefined && lon !== undefined) {
        if (!isValidLatLon({ lat, lon })) throw new Error(`item ${i}: invalid coordinates`);
        out.lat = lat;
        out.lon = lon;
      }
      const alt = n(it.alt);
      if (alt !== undefined) out.alt = alt;
      const speed = n(it.speed);
      if (speed !== undefined) out.speed = speed;
      const holdS = n(it.holdS);
      if (holdS !== undefined) out.holdS = Math.max(0, holdS);
      const yaw = n(it.yawDeg);
      if (yaw !== undefined) out.yawDeg = ((yaw % 360) + 360) % 360;
      const trig = n(it.triggerDistanceM);
      if (trig !== undefined) out.triggerDistanceM = Math.min(1000, Math.max(0, trig));
      const radius = n(it.radiusM);
      if (radius !== undefined) out.radiusM = Math.min(5000, Math.max(0, radius));
      const turns = n(it.turns);
      if (turns !== undefined) out.turns = Math.min(1000, Math.max(0, turns));
      if (it.unlimited === true) out.unlimited = true;
      if (type === 'camera_trigger' && out.triggerDistanceM === undefined) out.triggerDistanceM = 0;
      return out;
    }),
    rallyPoints: (Array.isArray(r.rallyPoints) ? r.rallyPoints : [])
      .map((x) => x as Record<string, unknown>)
      .filter((p) => isValidLatLon({ lat: n(p.lat), lon: n(p.lon) }))
      .map((p) => ({ lat: p.lat as number, lon: p.lon as number, alt: n(p.alt) ?? 30 })),
    geofence: null,
    defaultSpeed: Math.min(30, Math.max(0.5, n(r.defaultSpeed) ?? 8)),
    defaultAlt: Math.min(1000, Math.max(1, n(r.defaultAlt) ?? 50)),
  };
  if (r.home && typeof r.home === 'object') {
    const h = r.home as Record<string, unknown>;
    if (isValidLatLon({ lat: n(h.lat), lon: n(h.lon) })) {
      plan.home = { lat: h.lat as number, lon: h.lon as number, alt: n(h.alt) ?? 0 };
    }
  }
  if (r.geofence && typeof r.geofence === 'object') {
    const g = r.geofence as Record<string, unknown>;
    const poly = (Array.isArray(g.polygon) ? g.polygon : [])
      .map((x) => x as Record<string, unknown>)
      .filter((p) => isValidLatLon({ lat: n(p.lat), lon: n(p.lon) }))
      .map((p) => ({ lat: p.lat as number, lon: p.lon as number }));
    const action = (['rtl', 'land', 'hold'] as const).includes(g.action as GeofenceAction)
      ? (g.action as GeofenceAction)
      : 'rtl';
    if (poly.length > 0) plan.geofence = { polygon: poly, maxAlt: n(g.maxAlt) ?? null, action };
  }
  return plan;
}

/**
 * Where a return-to-launch (RTL) from `from` goes: home or the closest rally point, whichever
 * is nearer – the default of PX4 and ArduPilot (and of the simulator) when rally points exist.
 */
export function rtlDestination(plan: Pick<MissionPlan, 'home' | 'rallyPoints'>, from: LatLon): LatLon | null {
  let best: LatLon | null = plan.home ? { lat: plan.home.lat, lon: plan.home.lon } : null;
  let bestD = best ? haversineDistance(from, best) : Infinity;
  for (const r of plan.rallyPoints ?? []) {
    const d = haversineDistance(from, r);
    if (d < bestD) {
      best = { lat: r.lat, lon: r.lon };
      bestD = d;
    }
  }
  return best;
}

/** 3D path flown by the mission (home first when known). */
export function missionPath(plan: MissionPlan): LatLonAlt[] {
  const path: LatLonAlt[] = [];
  const first = plan.items.find(hasPos);
  const home: LatLonAlt | null = plan.home ?? (first ? { lat: first.lat, lon: first.lon, alt: 0 } : null);
  if (!home) return path;
  let cur: LatLonAlt = { lat: home.lat, lon: home.lon, alt: 0 };
  path.push(cur);
  const push = (p: LatLonAlt) => {
    cur = p;
    path.push(p);
  };
  for (const it of plan.items) {
    switch (it.type) {
      case 'takeoff':
        push({ lat: cur.lat, lon: cur.lon, alt: it.alt ?? plan.defaultAlt });
        break;
      case 'waypoint':
      case 'loiter':
        if (hasPos(it)) push({ lat: it.lat, lon: it.lon, alt: it.alt ?? cur.alt });
        break;
      case 'land':
        if (hasPos(it)) push({ lat: it.lat, lon: it.lon, alt: cur.alt });
        push({ lat: cur.lat, lon: cur.lon, alt: 0 });
        break;
      case 'rtl': {
        const dest = rtlDestination({ home, rallyPoints: plan.rallyPoints }, cur) ?? home;
        push({ lat: dest.lat, lon: dest.lon, alt: cur.alt });
        push({ lat: dest.lat, lon: dest.lon, alt: 0 });
        break;
      }
      default:
        break;
    }
  }
  return path;
}

/** Time spent at a waypoint / loiter: hold time, or turns around the loiter circle (unlimited loiters count once). */
export function loiterSeconds(it: MissionItem, speedMs: number): number {
  if (it.type !== 'loiter' && it.type !== 'waypoint') return 0;
  const circle = it.radiusM && it.radiusM > 0 ? (2 * Math.PI * it.radiusM) / Math.max(1, speedMs) : 30;
  if (it.type === 'loiter' && it.unlimited) return circle;
  if (it.type === 'loiter' && it.turns) return it.turns * circle;
  return it.holdS ?? 0;
}

export interface StatsOptions {
  climbRate?: number;
  descentRate?: number;
  /** Flight endurance in seconds used for the battery estimate. */
  enduranceS?: number;
}

export function missionStats(plan: MissionPlan, opts: StatsOptions = {}): MissionStats {
  const climb = opts.climbRate ?? 3;
  const descent = opts.descentRate ?? 2;
  const endurance = opts.enduranceS ?? 25 * 60;
  const first = plan.items.find(hasPos);
  const home: LatLonAlt | null = plan.home ?? (first ? { lat: first.lat, lon: first.lon, alt: 0 } : null);
  let speed = plan.defaultSpeed;
  let cur: LatLonAlt | null = home ? { lat: home.lat, lon: home.lon, alt: 0 } : null;
  let horiz = 0;
  let total = 0;
  let time = 0;
  let maxAlt = 0;
  let waypoints = 0;
  let photos = 0;
  let trigger = 0;
  let sinceTrigger = 0;
  const leg = (to: LatLonAlt, legSpeed: number) => {
    if (!cur) {
      cur = to;
      return;
    }
    const h = haversineDistance(cur, to);
    const dz = to.alt - cur.alt;
    if (trigger > 0) {
      sinceTrigger += h;
      photos += Math.floor(sinceTrigger / trigger);
      sinceTrigger %= trigger;
    }
    horiz += h;
    total += Math.hypot(h, dz);
    const tH = legSpeed > 0 ? h / legSpeed : 0;
    const tV = dz >= 0 ? dz / climb : -dz / descent;
    time += Math.max(tH, tV);
    maxAlt = Math.max(maxAlt, to.alt);
    cur = to;
  };
  for (const it of plan.items) {
    switch (it.type) {
      case 'speed':
        if (it.speed && it.speed > 0) speed = it.speed;
        break;
      case 'photo':
        photos++;
        break;
      case 'camera_trigger':
        trigger = it.triggerDistanceM ?? 0;
        sinceTrigger = 0;
        if (trigger > 0) photos++;
        break;
      case 'takeoff':
        if (cur) leg({ lat: cur.lat, lon: cur.lon, alt: it.alt ?? plan.defaultAlt }, speed);
        break;
      case 'waypoint':
      case 'loiter':
        if (hasPos(it)) {
          waypoints++;
          leg({ lat: it.lat, lon: it.lon, alt: it.alt ?? cur?.alt ?? plan.defaultAlt }, it.speed ?? speed);
        }
        time += loiterSeconds(it, it.speed ?? speed);
        break;
      case 'land': {
        const c = cur as LatLonAlt | null;
        if (hasPos(it) && c) leg({ lat: it.lat, lon: it.lon, alt: c.alt }, speed);
        const c2 = cur as LatLonAlt | null;
        if (c2) leg({ lat: c2.lat, lon: c2.lon, alt: 0 }, speed);
        break;
      }
      case 'rtl': {
        const c = cur as LatLonAlt | null;
        const dest = c ? rtlDestination({ home, rallyPoints: plan.rallyPoints }, c) : null;
        if (dest && c) {
          leg({ lat: dest.lat, lon: dest.lon, alt: c.alt }, speed);
          leg({ lat: dest.lat, lon: dest.lon, alt: 0 }, speed);
        }
        break;
      }
    }
  }
  return {
    horizontalDistanceM: horiz,
    totalDistanceM: total,
    estimatedTimeS: time,
    maxAltM: maxAlt,
    waypointCount: waypoints,
    photoCount: photos,
    estimatedBatteryPct: Math.min(999, (time / endurance) * 100),
  };
}

export interface ValidateOptions {
  maxAltitude?: number;
}

export function validateMission(plan: MissionPlan, opts: ValidateOptions = {}): MissionIssue[] {
  const issues: MissionIssue[] = [];
  const maxAlt = opts.maxAltitude ?? DEFAULT_MAX_ALTITUDE_M;
  const nav = plan.items.filter((i) => NAV_TYPES.has(i.type));
  if (plan.items.length === 0) issues.push({ level: 'error', message: 'Mission has no items' });
  if (nav.length > 0 && nav[0]!.type !== 'takeoff') {
    issues.push({ level: 'warning', message: 'Mission should start with a takeoff item', itemIndex: 0 });
  }
  let terminated = false;
  plan.items.forEach((it, i) => {
    if (terminated) {
      issues.push({ level: 'warning', message: 'Item follows a land/RTL item and will not be executed', itemIndex: i });
    }
    if ((it.type === 'waypoint' || it.type === 'loiter') && !hasPos(it)) {
      issues.push({ level: 'error', message: `${it.type} has no valid position`, itemIndex: i });
    }
    if (it.alt !== undefined) {
      if (it.alt < 0) issues.push({ level: 'error', message: 'Altitude must not be negative', itemIndex: i });
      else if (it.type !== 'land' && it.alt < 2 && NAV_TYPES.has(it.type))
        issues.push({ level: 'warning', message: 'Altitude below 2 m', itemIndex: i });
      if (it.alt > maxAlt)
        issues.push({ level: 'warning', message: `Altitude ${it.alt} m exceeds the ${maxAlt} m limit`, itemIndex: i });
    }
    if (it.speed !== undefined && (it.speed <= 0 || it.speed > 30)) {
      issues.push({ level: 'error', message: 'Speed must be within (0, 30] m/s', itemIndex: i });
    }
    if (it.type === 'land' || it.type === 'rtl') terminated = true;
  });
  const gf = plan.geofence;
  if (gf) {
    if (gf.polygon.length < 3) issues.push({ level: 'error', message: 'Geofence needs at least 3 vertices' });
    else {
      const path = missionPath(plan);
      path.forEach((p, i) => {
        if (!pointInPolygon(p, gf.polygon)) issues.push({ level: 'error', message: `Path point ${i} is outside the geofence` });
        if (i > 0 && segmentCrossesPolygon(path[i - 1]!, p, gf.polygon) && pointInPolygon(path[i - 1]!, gf.polygon) && pointInPolygon(p, gf.polygon)) {
          issues.push({ level: 'error', message: `Leg ${i} leaves the geofence` });
        }
        if (gf.maxAlt != null && p.alt > gf.maxAlt)
          issues.push({ level: 'error', message: `Path point ${i} exceeds the geofence ceiling (${gf.maxAlt} m)` });
      });
      plan.rallyPoints.forEach((r, i) => {
        if (!pointInPolygon(r, gf.polygon)) issues.push({ level: 'warning', message: `Rally point ${i + 1} is outside the geofence` });
      });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Survey (lawn-mower) pattern
// ---------------------------------------------------------------------------

export interface SurveyOptions {
  /** Distance between adjacent survey lines (m). */
  spacingM: number;
  /** Direction of the survey lines, degrees clockwise from north. */
  angleDeg: number;
  /** Flight altitude relative to home (m). */
  alt: number;
}

/**
 * Generates a lawn-mower coverage pattern over a polygon.
 * Exact for convex polygons; for concave polygons each scan line is split into
 * its interior spans (transits between spans may cross outside the area).
 */
export function generateSurvey(polygon: LatLon[], opts: SurveyOptions): MissionItem[] {
  if (polygon.length < 3) throw new Error('survey polygon needs at least 3 vertices');
  if (!(opts.spacingM > 0)) throw new Error('spacing must be positive');
  const ref = centroidOf(polygon)!;
  const proj = new LocalProjection(ref);
  const a = ((opts.angleDeg - 90) * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const rot = (x: number, y: number) => ({ x: x * cos - y * sin, y: x * sin + y * cos });
  const unrot = (x: number, y: number) => ({ x: x * cos + y * sin, y: -x * sin + y * cos });
  const ring = polygon.map((p) => {
    const q = proj.toXY(p);
    return rot(q.x, q.y);
  });
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const lines = Math.floor((maxY - minY) / opts.spacingM) + 1;
  if (lines > 2000) throw new Error('spacing too small for this area');
  const items: MissionItem[] = [];
  let reverse = false;
  for (let k = 0; k < lines; k++) {
    const y = minY + opts.spacingM / 2 + k * opts.spacingM;
    if (y > maxY) break;
    const xs: number[] = [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const p = ring[i]!;
      const q = ring[j]!;
      if ((p.y <= y && y < q.y) || (q.y <= y && y < p.y)) xs.push(p.x + ((y - p.y) * (q.x - p.x)) / (q.y - p.y));
    }
    xs.sort((m, n) => m - n);
    const spans: [number, number][] = [];
    for (let i = 0; i + 1 < xs.length; i += 2) spans.push([xs[i]!, xs[i + 1]!]);
    if (spans.length === 0) continue;
    const ordered = reverse ? spans.reverse().map(([s, e]) => [e, s] as [number, number]) : spans;
    for (const [s, e] of ordered) {
      for (const x of [s, e]) {
        const u = unrot(x, y);
        const ll = proj.toLatLon(u.x, u.y);
        items.push({ id: newItemId(), type: 'waypoint', lat: ll.lat, lon: ll.lon, alt: opts.alt });
      }
    }
    reverse = !reverse;
  }
  return items;
}

// ---------------------------------------------------------------------------
// QGroundControl .plan interchange
// ---------------------------------------------------------------------------

export const MAV_CMD = {
  NAV_WAYPOINT: 16,
  NAV_LOITER_UNLIM: 17,
  NAV_LOITER_TURNS: 18,
  NAV_LOITER_TIME: 19,
  NAV_RETURN_TO_LAUNCH: 20,
  NAV_LAND: 21,
  NAV_TAKEOFF: 22,
  DO_CHANGE_SPEED: 178,
  DO_DIGICAM_CONTROL: 203,
  DO_SET_CAM_TRIGG_DIST: 206,
  IMAGE_START_CAPTURE: 2000,
} as const;

const MAV_FRAME_GLOBAL = 0;
const MAV_FRAME_MISSION = 2;
const MAV_FRAME_GLOBAL_RELATIVE_ALT = 3;

interface RawCmd {
  command: number;
  frame: number;
  params: (number | null)[];
}

function itemToCmd(it: MissionItem, plan: MissionPlan): RawCmd | null {
  const lat = it.lat ?? 0;
  const lon = it.lon ?? 0;
  switch (it.type) {
    case 'takeoff':
      return { command: MAV_CMD.NAV_TAKEOFF, frame: MAV_FRAME_GLOBAL_RELATIVE_ALT, params: [0, 0, 0, null, lat, lon, it.alt ?? plan.defaultAlt] };
    case 'waypoint':
      return { command: MAV_CMD.NAV_WAYPOINT, frame: MAV_FRAME_GLOBAL_RELATIVE_ALT, params: [it.holdS ?? 0, 0, 0, it.yawDeg ?? null, lat, lon, it.alt ?? plan.defaultAlt] };
    case 'loiter':
      if (it.unlimited) return { command: MAV_CMD.NAV_LOITER_UNLIM, frame: MAV_FRAME_GLOBAL_RELATIVE_ALT, params: [0, 0, it.radiusM ?? 0, null, lat, lon, it.alt ?? plan.defaultAlt] };
      if (it.turns) return { command: MAV_CMD.NAV_LOITER_TURNS, frame: MAV_FRAME_GLOBAL_RELATIVE_ALT, params: [it.turns, 0, it.radiusM ?? 0, 0, lat, lon, it.alt ?? plan.defaultAlt] };
      return { command: MAV_CMD.NAV_LOITER_TIME, frame: MAV_FRAME_GLOBAL_RELATIVE_ALT, params: [it.holdS ?? 0, 0, it.radiusM ?? 0, 0, lat, lon, it.alt ?? plan.defaultAlt] };
    case 'land':
      return { command: MAV_CMD.NAV_LAND, frame: MAV_FRAME_GLOBAL_RELATIVE_ALT, params: [0, 0, 0, null, lat, lon, 0] };
    case 'rtl':
      return { command: MAV_CMD.NAV_RETURN_TO_LAUNCH, frame: MAV_FRAME_MISSION, params: [0, 0, 0, 0, 0, 0, 0] };
    case 'speed':
      return { command: MAV_CMD.DO_CHANGE_SPEED, frame: MAV_FRAME_MISSION, params: [1, it.speed ?? plan.defaultSpeed, -1, 0, 0, 0, 0] };
    case 'photo':
      return { command: MAV_CMD.DO_DIGICAM_CONTROL, frame: MAV_FRAME_MISSION, params: [0, 0, 0, 0, 1, 0, 0] };
    case 'camera_trigger':
      return { command: MAV_CMD.DO_SET_CAM_TRIGG_DIST, frame: MAV_FRAME_MISSION, params: [it.triggerDistanceM ?? 0, 0, 1, 0, 0, 0, 0] };
    default:
      return null;
  }
}

/** MAV_FRAME values whose altitude is relative to home, absolute (AMSL) or relative to terrain. */
const RELATIVE_FRAMES = new Set([MAV_FRAME_GLOBAL_RELATIVE_ALT, 6 /* GLOBAL_RELATIVE_ALT_INT */, MAV_FRAME_MISSION]);
const ABSOLUTE_FRAMES = new Set([MAV_FRAME_GLOBAL, 5 /* GLOBAL_INT */]);
const TERRAIN_FRAMES = new Set([10 /* GLOBAL_TERRAIN_ALT */, 11 /* GLOBAL_TERRAIN_ALT_INT */]);

/**
 * Converts a raw MAVLink mission command. Altitudes are converted to "relative to home":
 * absolute (AMSL) frames subtract the home altitude; terrain-relative frames cannot be
 * represented without terrain data at every waypoint and are rejected rather than misread.
 */
function cmdToItem(c: RawCmd, homeAlt: number | null, index: number): MissionItem | null {
  const p = (i: number): number => {
    const v = c.params[i];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  const pos = (): Partial<MissionItem> => {
    const lat = p(4);
    const lon = p(5);
    return lat === 0 && lon === 0 ? {} : { lat, lon };
  };
  const alt = (): number => {
    const raw = p(6);
    if (RELATIVE_FRAMES.has(c.frame)) return raw;
    if (ABSOLUTE_FRAMES.has(c.frame)) {
      if (homeAlt === null) throw new Error(`item ${index + 1}: absolute (AMSL) altitude needs a planned home position with altitude`);
      return Math.round((raw - homeAlt) * 100) / 100;
    }
    if (TERRAIN_FRAMES.has(c.frame)) throw new Error(`item ${index + 1}: terrain-relative altitude frame (${c.frame}) is not supported – convert the plan to relative or AMSL altitudes`);
    throw new Error(`item ${index + 1}: unsupported coordinate frame ${c.frame}`);
  };
  switch (c.command) {
    case MAV_CMD.NAV_TAKEOFF:
      return { id: newItemId(), type: 'takeoff', alt: alt() };
    case MAV_CMD.NAV_WAYPOINT: {
      const it: MissionItem = { id: newItemId(), type: 'waypoint', ...pos(), alt: alt() };
      if (p(0) > 0) it.holdS = p(0);
      const yaw = c.params[3];
      if (typeof yaw === 'number' && Number.isFinite(yaw)) it.yawDeg = ((yaw % 360) + 360) % 360;
      return it;
    }
    case MAV_CMD.NAV_LOITER_TIME: {
      const it: MissionItem = { id: newItemId(), type: 'loiter', ...pos(), alt: alt(), holdS: p(0) };
      if (Math.abs(p(2)) > 0) it.radiusM = Math.abs(p(2));
      return it;
    }
    case MAV_CMD.NAV_LOITER_TURNS: {
      const it: MissionItem = { id: newItemId(), type: 'loiter', ...pos(), alt: alt(), turns: Math.max(0, p(0)) };
      if (Math.abs(p(2)) > 0) it.radiusM = Math.abs(p(2));
      return it;
    }
    case MAV_CMD.NAV_LOITER_UNLIM: {
      const it: MissionItem = { id: newItemId(), type: 'loiter', ...pos(), alt: alt(), unlimited: true };
      if (Math.abs(p(2)) > 0) it.radiusM = Math.abs(p(2));
      return it;
    }
    case MAV_CMD.NAV_LAND:
      return { id: newItemId(), type: 'land', ...pos() };
    case MAV_CMD.NAV_RETURN_TO_LAUNCH:
      return { id: newItemId(), type: 'rtl' };
    case MAV_CMD.DO_CHANGE_SPEED:
      return { id: newItemId(), type: 'speed', speed: p(1) };
    case MAV_CMD.DO_DIGICAM_CONTROL:
    case MAV_CMD.IMAGE_START_CAPTURE:
      return { id: newItemId(), type: 'photo' };
    case MAV_CMD.DO_SET_CAM_TRIGG_DIST:
      return { id: newItemId(), type: 'camera_trigger', triggerDistanceM: Math.max(0, p(0)) };
    default:
      return null;
  }
}

export function toQgcPlan(plan: MissionPlan): Record<string, unknown> {
  const home = plan.home ?? (() => {
    const f = plan.items.find(hasPos);
    return f ? { lat: f.lat, lon: f.lon, alt: 0 } : { lat: 0, lon: 0, alt: 0 };
  })();
  let seq = 1;
  const items = plan.items
    .map((it) => itemToCmd(it, plan))
    .filter((c): c is RawCmd => c !== null)
    .map((c) => ({
      autoContinue: true,
      command: c.command,
      doJumpId: seq++,
      frame: c.frame,
      params: c.params,
      type: 'SimpleItem',
    }));
  return {
    fileType: 'Plan',
    groundStation: 'Athena-sky',
    version: 1,
    geoFence: {
      circles: [],
      polygons: plan.geofence && plan.geofence.polygon.length >= 3
        ? [{ inclusion: true, polygon: plan.geofence.polygon.map((p) => [p.lat, p.lon]), version: 1 }]
        : [],
      version: 2,
    },
    mission: {
      cruiseSpeed: plan.defaultSpeed,
      firmwareType: 12,
      globalPlanAltitudeMode: 1,
      hoverSpeed: plan.defaultSpeed,
      items,
      plannedHomePosition: [home.lat, home.lon, home.alt],
      vehicleType: 2,
      version: 2,
    },
    rallyPoints: { points: plan.rallyPoints.map((r) => [r.lat, r.lon, r.alt]), version: 2 },
  };
}

export function fromQgcPlan(input: unknown): MissionPlan {
  const doc = (typeof input === 'string' ? JSON.parse(input) : input) as Record<string, any>;
  if (!doc || doc.fileType !== 'Plan' || !doc.mission) throw new Error('not a QGroundControl plan file');
  const m = doc.mission as Record<string, any>;
  const plan = emptyPlan();
  if (typeof m.cruiseSpeed === 'number' && m.cruiseSpeed > 0) plan.defaultSpeed = m.cruiseSpeed;
  if (Array.isArray(m.plannedHomePosition) && m.plannedHomePosition.length >= 2) {
    const [lat, lon, alt] = m.plannedHomePosition as number[];
    // QGC writes 0,0 when no home is known.
    if (isValidLatLon({ lat, lon }) && !(lat === 0 && lon === 0)) plan.home = { lat: lat!, lon: lon!, alt: typeof alt === 'number' && Number.isFinite(alt) ? alt : 0 };
  }
  const flatten = (items: any[]): RawCmd[] =>
    items.flatMap((it) => {
      if (it?.type === 'SimpleItem') return [{ command: it.command, frame: it.frame, params: it.params ?? [] }];
      if (it?.type === 'ComplexItem' && it.TransectStyleComplexItem?.Items) return flatten(it.TransectStyleComplexItem.Items);
      return [];
    });
  const homeAlt = plan.home ? plan.home.alt : null;
  for (const [i, c] of flatten(Array.isArray(m.items) ? m.items : []).entries()) {
    const it = cmdToItem(c, homeAlt, i);
    if (it) plan.items.push(it);
  }
  const takeoffAlt = plan.items.find((i) => i.type === 'takeoff')?.alt;
  if (takeoffAlt) plan.defaultAlt = takeoffAlt;
  const poly = doc.geoFence?.polygons?.find((p: any) => p.inclusion !== false)?.polygon;
  if (Array.isArray(poly) && poly.length >= 3) {
    plan.geofence = { polygon: poly.map((p: number[]) => ({ lat: p[0]!, lon: p[1]! })), maxAlt: null, action: 'rtl' };
  }
  const rp = doc.rallyPoints?.points;
  if (Array.isArray(rp)) plan.rallyPoints = rp.filter((p: number[]) => isValidLatLon({ lat: p[0], lon: p[1] })).map((p: number[]) => ({ lat: p[0]!, lon: p[1]!, alt: p[2] ?? 30 }));
  return plan;
}

// ---------------------------------------------------------------------------
// Mission Planner / ArduPilot "QGC WPL 110" text format
// ---------------------------------------------------------------------------

const fmt = (v: number | null): string => (v === null || !Number.isFinite(v) ? '0' : String(Number(v.toFixed(8))));

export function toWpl(plan: MissionPlan): string {
  const home = plan.home ?? (() => {
    const f = plan.items.find(hasPos);
    return f ? { lat: f.lat, lon: f.lon, alt: 0 } : { lat: 0, lon: 0, alt: 0 };
  })();
  const lines = ['QGC WPL 110'];
  lines.push([0, 1, MAV_FRAME_GLOBAL, MAV_CMD.NAV_WAYPOINT, 0, 0, 0, 0, fmt(home.lat), fmt(home.lon), fmt(home.alt), 1].join('\t'));
  let seq = 1;
  for (const it of plan.items) {
    const c = itemToCmd(it, plan);
    if (!c) continue;
    lines.push([seq++, 0, c.frame, c.command, ...c.params.map(fmt), 1].join('\t'));
  }
  return lines.join('\n') + '\n';
}

export function fromWpl(text: string): MissionPlan {
  const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!rows[0] || !/^QGC WPL 1[01]0$/.test(rows[0])) throw new Error('not a QGC WPL file');
  const plan = emptyPlan();
  for (const row of rows.slice(1)) {
    const f = row.split(/\s+/).map(Number);
    if (f.length < 12 || f.some((v) => Number.isNaN(v))) throw new Error(`malformed WPL line: ${row}`);
    const [seq, , frame, command, ...rest] = f as [number, number, number, number, ...number[]];
    const params = rest.slice(0, 7);
    if (seq === 0) {
      if (isValidLatLon({ lat: params[4], lon: params[5] }) && !(params[4] === 0 && params[5] === 0)) {
        plan.home = { lat: params[4]!, lon: params[5]!, alt: params[6] ?? 0 };
      }
      continue;
    }
    const it = cmdToItem({ command, frame, params }, plan.home ? plan.home.alt : null, seq - 1);
    if (it) plan.items.push(it);
  }
  const takeoffAlt = plan.items.find((i) => i.type === 'takeoff')?.alt;
  if (takeoffAlt) plan.defaultAlt = takeoffAlt;
  return plan;
}
