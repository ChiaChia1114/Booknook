/**
 * Drone swarm planning: one mission flown by several drones in formation, a route or a survey
 * split between drones, assignment of drones to formation slots, synchronisation points with
 * leg-by-leg speed matching, and a time-based separation check of the planned flights.
 *
 * Runtime model (see the server's swarm controller): all drones start their missions at the
 * same moment; at every synchronisation point a drone that arrives early holds until all
 * others have arrived ("barrier"), then they continue together.
 */
import { LocalProjection, haversineDistance, interpolateLatLon, type LatLon, type XY } from './geo';
import { generateSurvey, loiterSeconds, newItemId, type MissionItem, type MissionPlan, type SurveyOptions } from './mission';

export type FormationPattern = 'line' | 'column' | 'echelon' | 'v' | 'grid';
export const FORMATION_PATTERNS: readonly FormationPattern[] = ['line', 'column', 'echelon', 'v', 'grid'];

/** Offsets (metres right of / behind the leader, which is index 0 at 0,0). */
export function formationOffsets(n: number, pattern: FormationPattern, spacingM: number): { right: number; back: number }[] {
  const out: { right: number; back: number }[] = [];
  for (let i = 0; i < n; i++) {
    switch (pattern) {
      case 'line': {
        // Abreast, alternating right / left of the leader.
        const k = Math.ceil(i / 2);
        out.push({ right: (i % 2 === 1 ? 1 : -1) * k * spacingM * (i === 0 ? 0 : 1), back: 0 });
        break;
      }
      case 'column':
        out.push({ right: 0, back: i * spacingM });
        break;
      case 'echelon':
        out.push({ right: i * spacingM * 0.7071, back: i * spacingM * 0.7071 });
        break;
      case 'v': {
        const k = Math.ceil(i / 2);
        out.push({ right: (i % 2 === 1 ? 1 : -1) * k * spacingM * 0.7071 * (i === 0 ? 0 : 1), back: k * spacingM * 0.7071 });
        break;
      }
      case 'grid': {
        const cols = Math.ceil(Math.sqrt(n));
        const row = Math.floor(i / cols);
        const col = i % cols;
        out.push({ right: (col - (cols - 1) / 2) * spacingM, back: row * spacingM });
        break;
      }
    }
  }
  return out;
}

const hasPos = (it: MissionItem): it is MissionItem & LatLon => it.lat !== undefined && it.lon !== undefined;
/** Positioned items a formation moves: waypoints, loiters and landing points. */
const isNav = (it: MissionItem) => hasPos(it) && (it.type === 'waypoint' || it.type === 'loiter' || it.type === 'land');
/** Positioned items a split divides and the swarm synchronises on. */
const isPathPoint = (it: MissionItem) => hasPos(it) && (it.type === 'waypoint' || it.type === 'loiter');
const hasAlt = (it: MissionItem) => it.type === 'takeoff' || it.type === 'waypoint' || it.type === 'loiter';

const unit = (a: XY, b: XY): XY | null => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = Math.hypot(dx, dy);
  return l > 0.5 ? { x: dx / l, y: dy / l } : null;
};

/**
 * One plan per formation slot flying the leader's mission. Positions are offset in the frame of
 * the local direction of travel with mitred corners, so every member flies legs parallel to the
 * leader's at the formation distance; `altStepM` stacks the slots vertically as an additional
 * collision barrier.
 */
export function formationPlans(plan: MissionPlan, n: number, pattern: FormationPattern, spacingM: number, altStepM = 0): MissionPlan[] {
  const offsets = formationOffsets(n, pattern, spacingM);
  const navIdx = plan.items.flatMap((it, i) => (isNav(it) ? [i] : []));
  const ref: LatLon | null = navIdx.length ? (plan.items[navIdx[0]!] as LatLon) : (plan.home ?? null);
  const proj = ref ? new LocalProjection(ref) : null;
  const pts = proj ? navIdx.map((i) => proj.toXY(plan.items[i] as LatLon)) : [];
  const homeXY = proj && plan.home ? proj.toXY(plan.home) : null;
  const dirIn = pts.map((p, k) => (k > 0 ? unit(pts[k - 1]!, p) : homeXY ? unit(homeXY, p) : null));
  const dirOut = pts.map((p, k) => (k + 1 < pts.length ? unit(p, pts[k + 1]!) : null));
  const scan = (arr: (XY | null)[], from: number, step: number): XY | null => {
    for (let k = from; k >= 0 && k < arr.length; k += step) if (arr[k]) return arr[k]!;
    return null;
  };
  // Along-track direction, right normal and mitre factor at every positioned item.
  const frames = pts.map((_, k) => {
    const din = dirIn[k] ?? scan(dirIn, k - 1, -1) ?? dirOut[k] ?? scan(dirOut, k + 1, 1) ?? { x: 0, y: 1 };
    const dout = dirOut[k] ?? scan(dirOut, k + 1, 1) ?? din;
    const sx = din.x + dout.x;
    const sy = din.y + dout.y;
    const sl = Math.hypot(sx, sy);
    // Near a reversal the mitre is unbounded: keep the incoming frame there.
    const b = sl < 0.2 ? din : { x: sx / sl, y: sy / sl };
    const cosHalf = b.x * dout.x + b.y * dout.y;
    return { b, n: { x: b.y, y: -b.x }, scale: sl < 0.2 ? 1 : 1 / Math.max(0.5, cosHalf) };
  });
  const homeFrame = homeXY && pts.length ? (unit(homeXY, pts[0]!) ?? frames[0]!.b) : frames[0]?.b ?? { x: 0, y: 1 };

  return offsets.map((off, d) => {
    let k = 0;
    const items = plan.items.map((it): MissionItem => {
      const out: MissionItem = { ...it, id: newItemId() };
      if (altStepM && hasAlt(it)) out.alt = (it.alt ?? plan.defaultAlt) + d * altStepM;
      if (isNav(it) && proj) {
        const f = frames[k]!;
        const p = pts[k++]!;
        const q = proj.toLatLon(p.x + off.right * f.scale * f.n.x - off.back * f.b.x, p.y + off.right * f.scale * f.n.y - off.back * f.b.y);
        out.lat = q.lat;
        out.lon = q.lon;
      }
      return out;
    });
    let home = plan.home ?? null;
    if (home && proj && homeXY) {
      const nx = homeFrame.y;
      const ny = -homeFrame.x;
      const q = proj.toLatLon(homeXY.x + off.right * nx - off.back * homeFrame.x, homeXY.y + off.right * ny - off.back * homeFrame.y);
      home = { ...q, alt: home.alt };
    }
    return { ...plan, home, items, rallyPoints: plan.rallyPoints.map((r) => ({ ...r, alt: r.alt + d * altStepM })) };
  });
}

/**
 * Splits a mission between n drones by path length: each drone gets a contiguous part of the
 * route (cut points are interpolated inside legs), its own take-off and a return home. The
 * cruise speed and camera-trigger state in force at a cut are carried into the next part, and
 * the trigger is stopped at the end of each part.
 */
export function splitPlan(plan: MissionPlan, n: number): MissionPlan[] {
  const parts = Math.max(1, Math.floor(n));
  const items = plan.items;
  const takeoffAlt = items.find((i) => i.type === 'takeoff')?.alt ?? plan.defaultAlt;
  const navIdx = items.flatMap((it, i) => (isPathPoint(it) ? [i] : []));
  if (navIdx.length === 0) throw new Error('The mission has no waypoints to split');
  const cumAt = new Map<number, number>([[navIdx[0]!, 0]]);
  let total = 0;
  for (let k = 1; k < navIdx.length; k++) {
    total += haversineDistance(items[navIdx[k - 1]!] as LatLon, items[navIdx[k]!] as LatLon);
    cumAt.set(navIdx[k]!, total);
  }
  if (parts > 1 && total < 1) throw new Error('The route is too short to split');
  const cut = (j: number) => (j * total) / parts;
  const altOf = (it: MissionItem) => it.alt ?? plan.defaultAlt;
  const out: MissionItem[][] = [[]];
  let part = 0;
  let speed: number | null = null;
  let trigger = 0;
  let last: (MissionItem & LatLon) | null = null;
  let lastCum = 0;
  const copy = (it: MissionItem): MissionItem => ({ ...it, id: newItemId() });
  const newPart = (at: LatLon & { alt: number }) => {
    const wp: MissionItem = { id: newItemId(), type: 'waypoint', lat: at.lat, lon: at.lon, alt: at.alt };
    out[part]!.push({ ...wp, id: newItemId() });
    if (trigger > 0) out[part]!.push({ id: newItemId(), type: 'camera_trigger', triggerDistanceM: 0 });
    part++;
    out.push([]);
    if (speed) out[part]!.push({ id: newItemId(), type: 'speed', speed });
    out[part]!.push(wp);
    if (trigger > 0) out[part]!.push({ id: newItemId(), type: 'camera_trigger', triggerDistanceM: trigger });
  };
  for (const [i, it] of items.entries()) {
    // Every part gets its own take-off and return home.
    if (it.type === 'takeoff' || it.type === 'rtl' || it.type === 'land') continue;
    if (it.type === 'speed' && it.speed) speed = it.speed;
    if (it.type === 'camera_trigger') trigger = it.triggerDistanceM ?? 0;
    if (!isPathPoint(it)) {
      out[part]!.push(copy(it));
      continue;
    }
    const p = it as MissionItem & LatLon;
    const c = cumAt.get(i)!;
    // Cuts inside the leg from the previous point to this one.
    while (last && part < parts - 1 && cut(part + 1) < c - 0.5) {
      const f = (cut(part + 1) - lastCum) / Math.max(1e-9, c - lastCum);
      const q = interpolateLatLon(last, p, f);
      newPart({ ...q, alt: altOf(last) + (altOf(p) - altOf(last)) * f });
    }
    out[part]!.push(copy(it));
    // A cut at this point: the part ends here, the next one starts here.
    while (part < parts - 1 && cut(part + 1) <= c + 0.5) {
      if (trigger > 0) out[part]!.push({ id: newItemId(), type: 'camera_trigger', triggerDistanceM: 0 });
      part++;
      out.push([]);
      if (speed) out[part]!.push({ id: newItemId(), type: 'speed', speed });
      out[part]!.push({ id: newItemId(), type: 'waypoint', lat: p.lat, lon: p.lon, alt: altOf(p) });
      if (trigger > 0) out[part]!.push({ id: newItemId(), type: 'camera_trigger', triggerDistanceM: trigger });
    }
    last = p;
    lastCum = c;
  }
  return out.map((partItems) => ({
    ...plan,
    items: [{ id: newItemId(), type: 'takeoff', alt: takeoffAlt }, ...partItems, { id: newItemId(), type: 'rtl' }],
    rallyPoints: plan.rallyPoints.map((r) => ({ ...r })),
  }));
}

/** Splits a lawn-mower survey between n drones (contiguous, length-balanced line groups). */
export function splitSurvey(polygon: LatLon[], n: number, opts: SurveyOptions, home?: LatLon | null): MissionPlan[] {
  const wps = generateSurvey(polygon, opts);
  const lines: MissionItem[][] = [];
  for (let i = 0; i + 1 < wps.length; i += 2) lines.push([wps[i]!, wps[i + 1]!]);
  const lengths = lines.map(([a, b]) => haversineDistance(a as LatLon, b as LatLon));
  const total = lengths.reduce((s, v) => s + v, 0);
  const groups: MissionItem[][][] = Array.from({ length: n }, () => []);
  let acc = 0;
  lines.forEach((l, i) => {
    const g = Math.min(n - 1, Math.floor((acc / Math.max(1, total)) * n));
    groups[g]!.push(l);
    acc += lengths[i]!;
  });
  return groups.map((g) => {
    const items: MissionItem[] = [{ id: newItemId(), type: 'takeoff', alt: opts.alt }];
    for (const line of g) for (const wp of line) items.push({ ...wp, id: newItemId() });
    items.push({ id: newItemId(), type: 'rtl' });
    return { home: home ? { lat: home.lat, lon: home.lon, alt: 0 } : null, items, rallyPoints: [], geofence: null, defaultSpeed: 8, defaultAlt: opts.alt };
  });
}

/**
 * Assigns drones to slots minimising the total distance from each drone to its slot's first
 * position (exact for up to 8 drones, greedy beyond). Returns the slot of every drone.
 */
export function assignSlots(starts: LatLon[], targets: LatLon[]): number[] {
  const n = starts.length;
  if (targets.length < n) throw new Error('fewer slots than drones');
  const cost = starts.map((s) => targets.map((t) => haversineDistance(s, t)));
  if (n <= 8) {
    let best: number[] = [];
    let bestCost = Infinity;
    const used = new Array<boolean>(targets.length).fill(false);
    const cur: number[] = [];
    const rec = (i: number, acc: number) => {
      if (acc >= bestCost) return;
      if (i === n) {
        bestCost = acc;
        best = [...cur];
        return;
      }
      for (let s = 0; s < targets.length; s++) {
        if (used[s]) continue;
        used[s] = true;
        cur.push(s);
        rec(i + 1, acc + cost[i]![s]!);
        cur.pop();
        used[s] = false;
      }
    };
    rec(0, 0);
    return best;
  }
  const slotOf = new Array<number>(n).fill(-1);
  const taken = new Set<number>();
  const pairs = cost.flatMap((row, i) => row.map((c, s) => ({ i, s, c }))).sort((a, b) => a.c - b.c);
  for (const p of pairs) {
    if (slotOf[p.i]! >= 0 || taken.has(p.s)) continue;
    slotOf[p.i] = p.s;
    taken.add(p.s);
  }
  return slotOf;
}

/**
 * Item indices where the drones of a swarm wait for each other: completion of the take-off,
 * then every waypoint / loiter (`waypoints`) or only the last one before returning (`landing`).
 */
export function swarmSyncPoints(plan: MissionPlan, opts: { waypoints: boolean; landing: boolean }): number[] {
  const out = new Set<number>();
  const takeoff = plan.items.findIndex((i) => i.type === 'takeoff');
  if (takeoff >= 0) out.add(takeoff);
  const path = plan.items.flatMap((it, i) => (isPathPoint(it) ? [i] : []));
  if (opts.waypoints) for (const i of path) out.add(i);
  else if (opts.landing && path.length) out.add(path[path.length - 1]!);
  return [...out].sort((a, b) => a - b);
}

/**
 * Matches the speeds of formation members leg by leg so that they reach every waypoint at the
 * same time: the member with the longest leg flies at the planned speed (or its own maximum),
 * the others slower. Change-speed items are inserted before the waypoints; the members must have
 * the same item structure (as produced by `formationPlans`).
 */
export function synchronizeLegSpeeds(plans: MissionPlan[], opts: { maxSpeedsMs?: (number | undefined)[]; minSpeedMs?: number } = {}): MissionPlan[] {
  if (plans.length < 2) return plans;
  const len = plans[0]!.items.length;
  if (plans.some((p) => p.items.length !== len || p.items.some((it, i) => it.type !== plans[0]!.items[i]!.type))) return plans;
  const minSpeed = opts.minSpeedMs ?? 1;
  const outItems: MissionItem[][] = plans.map(() => []);
  const prev: ({ lat: number; lon: number; alt: number } | null)[] = plans.map(() => null);
  const emitted: (number | null)[] = plans.map(() => null);
  const alt: number[] = plans.map(() => 0);
  let base = plans[0]!.defaultSpeed;
  for (let i = 0; i < len; i++) {
    const it0 = plans[0]!.items[i]!;
    if (it0.type === 'speed') {
      if (it0.speed && it0.speed > 0) base = it0.speed;
      continue; // replaced by per-leg speeds
    }
    if (it0.type === 'takeoff') plans.forEach((p, m) => (alt[m] = p.items[i]!.alt ?? p.defaultAlt));
    if (isNav(it0)) {
      const cur = plans.map((p, m) => {
        const it = p.items[i]!;
        const a = it.type === 'land' ? alt[m]! : (it.alt ?? alt[m]!);
        return { lat: it.lat!, lon: it.lon!, alt: a };
      });
      if (prev.every((p) => p)) {
        const lens = cur.map((c, m) => Math.hypot(haversineDistance(prev[m]!, c), c.alt - prev[m]!.alt));
        const vmax = plans.map((_, m) => Math.min(plans[m]!.items[i]!.speed ?? base, opts.maxSpeedsMs?.[m] ?? Infinity));
        const legTime = Math.max(...lens.map((l, m) => l / vmax[m]!));
        plans.forEach((_, m) => {
          const v = legTime > 0 ? Math.min(vmax[m]!, Math.max(minSpeed, lens[m]! / legTime)) : vmax[m]!;
          const rounded = Math.round(v * 100) / 100;
          if (emitted[m] === null || Math.abs(emitted[m]! - rounded) > 0.005) {
            outItems[m]!.push({ id: newItemId(), type: 'speed', speed: rounded });
            emitted[m] = rounded;
          }
        });
      } else {
        // Transit from the take-off position: synchronised by the barrier, flown at the planned speed.
        plans.forEach((_, m) => {
          if (emitted[m] !== base) {
            outItems[m]!.push({ id: newItemId(), type: 'speed', speed: base });
            emitted[m] = base;
          }
        });
      }
      cur.forEach((c, m) => {
        prev[m] = c;
        alt[m] = c.alt;
      });
    }
    plans.forEach((p, m) => {
      const it = { ...p.items[i]! };
      delete it.speed;
      outItems[m]!.push(it);
    });
  }
  return plans.map((p, m) => ({ ...p, items: outItems[m]! }));
}

// ---------------------------------------------------------------------------------------
// Timelines and separation
// ---------------------------------------------------------------------------------------

export interface SwarmTrackPoint {
  t: number;
  lat: number;
  lon: number;
  /** Altitude relative to the drone's take-off position (m). */
  alt: number;
}

interface RawPoint extends SwarmTrackPoint {
  /** Item index completed at this point. */
  item?: number;
}

/**
 * Kinematic timeline of a plan: vertical take-off, straight legs at the commanded speeds,
 * hold and loiter times (unlimited loiters count as zero), landing and return home – starting
 * on the ground at `start`.
 */
export function planTimeline(plan: MissionPlan, start: LatLon, opts: { climbMs?: number; descentMs?: number } = {}): RawPoint[] {
  const climb = opts.climbMs ?? 3;
  const descent = opts.descentMs ?? 2;
  let t = 0;
  let cur = { lat: start.lat, lon: start.lon, alt: 0 };
  let speed = plan.defaultSpeed;
  const pts: RawPoint[] = [{ t: 0, ...cur }];
  const move = (to: { lat: number; lon: number; alt: number }, v: number, item?: number) => {
    const h = haversineDistance(cur, to);
    const dz = to.alt - cur.alt;
    const dt = Math.max(h / Math.max(0.5, v), dz > 0 ? dz / climb : -dz / descent);
    t += dt;
    cur = { ...to };
    pts.push({ t, ...cur, item });
  };
  const hold = (s: number, item?: number) => {
    if (s > 0) t += s;
    pts.push({ t, ...cur, item });
  };
  plan.items.forEach((it, i) => {
    switch (it.type) {
      case 'takeoff':
        move({ ...cur, alt: it.alt ?? plan.defaultAlt }, speed, i);
        break;
      case 'speed':
        if (it.speed && it.speed > 0) speed = it.speed;
        hold(0, i);
        break;
      case 'waypoint':
      case 'loiter': {
        if (!hasPos(it)) return hold(0, i);
        const v = it.speed ?? speed;
        move({ lat: it.lat, lon: it.lon, alt: it.alt ?? cur.alt }, v);
        hold(it.type === 'loiter' ? (it.unlimited ? 0 : loiterSeconds(it, v)) : (it.holdS ?? 0), i);
        break;
      }
      case 'land':
        if (hasPos(it)) move({ lat: it.lat, lon: it.lon, alt: cur.alt }, speed);
        move({ ...cur, alt: 0 }, speed, i);
        break;
      case 'rtl':
        move({ lat: start.lat, lon: start.lon, alt: cur.alt }, speed);
        move({ lat: start.lat, lon: start.lon, alt: 0 }, speed, i);
        break;
      default:
        hold(0, i);
    }
  });
  return pts;
}

/**
 * Timelines of the members of a swarm including the waits at the synchronisation points:
 * every member arrives at sync point j, holds until the last one has arrived, then continues.
 */
export function syncedTimelines(plans: MissionPlan[], starts: LatLon[], syncPoints: number[][]): SwarmTrackPoint[][] {
  const raw = plans.map((p, m) => planTimeline(p, starts[m]!));
  const m = Math.min(...syncPoints.map((s) => s.length));
  const arrival = raw.map((pts, k) => syncPoints[k]!.slice(0, m).map((idx) => pts.find((p) => p.item === idx)?.t ?? pts[pts.length - 1]!.t));
  // Barrier times and the waits of every member.
  const offset = plans.map(() => 0);
  const waits = plans.map(() => new Array<number>(m).fill(0));
  for (let j = 0; j < m; j++) {
    const at = arrival.map((a, k) => a[j]! + offset[k]!);
    const barrier = Math.max(...at);
    at.forEach((a, k) => {
      waits[k]![j] = barrier - a;
      offset[k] = offset[k]! + (barrier - a);
    });
  }
  return raw.map((pts, k) => {
    const out: SwarmTrackPoint[] = [];
    let off = 0;
    for (const p of pts) {
      out.push({ t: p.t + off, lat: p.lat, lon: p.lon, alt: p.alt });
      const j = p.item === undefined ? -1 : syncPoints[k]!.slice(0, m).indexOf(p.item);
      if (j >= 0 && waits[k]![j]! > 0) {
        off += waits[k]![j]!;
        out.push({ t: p.t + off, lat: p.lat, lon: p.lon, alt: p.alt });
      }
    }
    return out;
  });
}

export interface SeparationResult {
  /** Members (indices) of the closest pair. */
  a: number;
  b: number;
  /** Time of closest approach (s from the synchronised start). */
  t: number;
  distanceM: number;
  horizontalM: number;
  verticalM: number;
}

/**
 * Closest approach of simultaneously flying drones along piecewise-linear timelines (exact:
 * between consecutive breakpoints every drone moves linearly). Pairs where a drone is below
 * `minAltM` (on the ground at its take-off spot) are ignored.
 */
export function separationOverTime(tracks: SwarmTrackPoint[][], opts: { minAltM?: number } = {}): SeparationResult | null {
  const minAlt = opts.minAltM ?? 2;
  const live = tracks.filter((t) => t.length > 0);
  if (live.length < 2) return null;
  const proj = new LocalProjection(tracks.find((t) => t.length)![0]!);
  const xyz = tracks.map((tr) => tr.map((p) => ({ t: p.t, ...proj.toXY(p), z: p.alt })));
  const times = [...new Set(xyz.flatMap((tr) => tr.map((p) => p.t)))].sort((a, b) => a - b);
  const at = (tr: { t: number; x: number; y: number; z: number }[], t: number) => {
    if (t <= tr[0]!.t) return tr[0]!;
    const last = tr[tr.length - 1]!;
    if (t >= last.t) return last;
    let lo = 0;
    let hi = tr.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (tr[mid]!.t <= t) lo = mid;
      else hi = mid;
    }
    const a = tr[lo]!;
    const b = tr[hi]!;
    const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
    return { t, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
  };
  let best: SeparationResult | null = null;
  for (let s = 0; s + 1 < times.length; s++) {
    const t0 = times[s]!;
    const t1 = times[s + 1]!;
    const p0 = xyz.map((tr) => (tr.length ? at(tr, t0) : null));
    const p1 = xyz.map((tr) => (tr.length ? at(tr, t1) : null));
    for (let i = 0; i < tracks.length; i++) {
      for (let j = i + 1; j < tracks.length; j++) {
        const a0 = p0[i];
        const b0 = p0[j];
        const a1 = p1[i];
        const b1 = p1[j];
        if (!a0 || !b0 || !a1 || !b1) continue;
        const d0 = { x: a0.x - b0.x, y: a0.y - b0.y, z: a0.z - b0.z };
        const dd = { x: a1.x - b1.x - d0.x, y: a1.y - b1.y - d0.y, z: a1.z - b1.z - d0.z };
        const q = dd.x * dd.x + dd.y * dd.y + dd.z * dd.z;
        const f = q > 1e-12 ? Math.min(1, Math.max(0, -(d0.x * dd.x + d0.y * dd.y + d0.z * dd.z) / q)) : 0;
        const za = a0.z + (a1.z - a0.z) * f;
        const zb = b0.z + (b1.z - b0.z) * f;
        if (za < minAlt || zb < minAlt) continue;
        const dx = d0.x + dd.x * f;
        const dy = d0.y + dd.y * f;
        const dz = d0.z + dd.z * f;
        const dist = Math.hypot(dx, dy, dz);
        if (!best || dist < best.distanceM) best = { a: i, b: j, t: Math.round((t0 + (t1 - t0) * f) * 10) / 10, distanceM: dist, horizontalM: Math.hypot(dx, dy), verticalM: Math.abs(dz) };
      }
    }
  }
  return best;
}

export interface SeparationPair {
  a: number;
  b: number;
  horizontalM: number;
  verticalM: number;
}

/** Closest pair of a set of 3D positions (altitudes in metres, same reference). */
export function minSeparation(positions: (LatLon & { alt: number })[]): SeparationPair | null {
  let best: SeparationPair | null = null;
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const h = haversineDistance(positions[i]!, positions[j]!);
      const v = Math.abs(positions[i]!.alt - positions[j]!.alt);
      if (!best || Math.hypot(h, v) < Math.hypot(best.horizontalM, best.verticalM)) best = { a: i, b: j, horizontalM: h, verticalM: v };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------
// Complete swarm plan
// ---------------------------------------------------------------------------------------

export type SwarmMode = 'formation' | 'split';

export interface SwarmPlanOptions {
  mode: SwarmMode;
  /** Formation pattern (formation mode). */
  pattern?: FormationPattern;
  /** Distance between neighbouring drones in the formation (m). */
  spacingM?: number;
  /** Vertical stagger between drones (m): all altitudes in formation mode, the take-off altitude when splitting. */
  altStepM?: number;
  /** Formation mode: wait for each other at every waypoint (with matched leg speeds). */
  syncWaypoints?: boolean;
  /** Wait for each other at the last waypoint and return home together. */
  syncLanding?: boolean;
  /** Legal altitude limit (m above take-off): flagged when exceeded, and the ceiling of the return legs. */
  maxAltM?: number;
}

export interface SwarmMemberInput {
  id: string;
  name: string;
  /** Current position (take-off spot) of the drone. */
  position: LatLon;
  maxSpeedMs?: number;
}

export interface SwarmMemberPlan {
  droneId: string;
  name: string;
  /** Formation slot (0 = leader) or route part. */
  slot: number;
  plan: MissionPlan;
  /** Item indices of the synchronisation points (aligned between members). */
  syncPoints: number[];
  distanceM: number;
  durationS: number;
}

export interface SwarmPlanResult {
  members: SwarmMemberPlan[];
  separation: (SeparationResult & { droneA: string; droneB: string }) | null;
  durationS: number;
  warnings: string[];
}

/** Instantaneous items between a sync point and what follows it. */
const INSTANT = new Set<MissionItem['type']>(['speed', 'photo', 'camera_trigger']);

/**
 * Turns the last sync point into an unlimited loiter (hold on the spot until released) when the
 * mission returns home or lands right after it.
 */
export function holdAtFinalSyncPoint(plan: MissionPlan, syncPoints: number[]): MissionPlan {
  const last = syncPoints[syncPoints.length - 1];
  if (last === undefined) return plan;
  const it = plan.items[last]!;
  if (!isPathPoint(it)) return plan;
  let next = last + 1;
  while (next < plan.items.length && INSTANT.has(plan.items[next]!.type)) next++;
  const after = plan.items[next];
  if (after && after.type !== 'rtl' && after.type !== 'land') return plan;
  const items = [...plan.items];
  items[last] = { id: it.id, type: 'loiter', lat: it.lat, lon: it.lon, alt: it.alt ?? plan.defaultAlt, unlimited: true, ...(it.yawDeg !== undefined ? { yawDeg: it.yawDeg } : {}) };
  return { ...plan, items };
}

/** Minimum planned 3D distance between swarm members below which the plan is flagged. */
export const SWARM_MIN_SEPARATION_M = 10;

/** Vertical spacing of the members' return legs (m) and the highest return altitude used. */
export const SWARM_RETURN_STEP_M = 10;
const SWARM_RETURN_MAX_ALT_M = 120;

/**
 * Replaces each member's final return home (RTL) by explicit legs: climb on the spot to the
 * member's own return altitude (above every mission altitude, one step apart), fly home at it
 * and land. Drones released together cross each other's way home vertically separated – and
 * the planned timeline (and its separation check) is what they actually fly.
 */
export function separateReturns(plans: MissionPlan[], maxAltM = SWARM_RETURN_MAX_ALT_M): MissionPlan[] {
  const cruise = Math.max(0, ...plans.flatMap((p) => p.items.filter(hasAlt).map((it) => it.alt ?? p.defaultAlt)));
  // Up to 10 m apart, closer when the room below the altitude limit is short (at least 3 m:
  // without room the plan exceeds the limit and is flagged).
  const step = Math.max(3, Math.min(SWARM_RETURN_STEP_M, (maxAltM - cruise) / Math.max(1, plans.length)));
  return plans.map((p, k) => {
    const last = p.items[p.items.length - 1];
    const from = [...p.items].reverse().find(isPathPoint);
    if (!last || last.type !== 'rtl' || !p.home || !from) return p;
    const alt = Math.round(cruise + (k + 1) * step);
    const items: MissionItem[] = [
      ...p.items.slice(0, -1),
      { id: newItemId(), type: 'waypoint', lat: from.lat!, lon: from.lon!, alt },
      { id: newItemId(), type: 'waypoint', lat: p.home.lat, lon: p.home.lon, alt },
      { id: newItemId(), type: 'land', lat: p.home.lat, lon: p.home.lon },
    ];
    return { ...p, items };
  });
}

/** Plans a swarm operation: per-drone missions, sync points, timing and the separation check. */
export function planSwarm(base: MissionPlan, members: SwarmMemberInput[], opts: SwarmPlanOptions): SwarmPlanResult {
  const n = members.length;
  if (n < 2) throw new Error('A swarm needs at least two drones');
  if (n > 12) throw new Error('A swarm can have at most 12 drones');
  const altStep = Math.max(0, opts.altStepM ?? 5);
  const warnings: string[] = [];
  let slots: MissionPlan[];
  if (opts.mode === 'formation') {
    slots = formationPlans(base, n, opts.pattern ?? 'line', Math.max(1, opts.spacingM ?? 20), altStep);
  } else {
    slots = splitPlan(base, n).map((p, d) => ({ ...p, items: p.items.map((it) => (it.type === 'takeoff' ? { ...it, alt: (it.alt ?? p.defaultAlt) + d * altStep } : it)) }));
  }
  const firstPos = (p: MissionPlan): LatLon => {
    const it = p.items.find(isNav);
    if (!it) throw new Error('The mission has no waypoints');
    return it as LatLon;
  };
  const slotOf = assignSlots(
    members.map((m) => m.position),
    slots.map(firstPos),
  );
  let plans: MissionPlan[] = members.map((m, i) => ({ ...slots[slotOf[i]!]!, home: { lat: m.position.lat, lon: m.position.lon, alt: base.home?.alt ?? 0 } }));
  const syncWaypoints = opts.mode === 'formation' && opts.syncWaypoints !== false;
  if (syncWaypoints) plans = synchronizeLegSpeeds(plans, { maxSpeedsMs: members.map((m) => m.maxSpeedMs) });
  const syncPoints = plans.map((p) => swarmSyncPoints(p, { waypoints: syncWaypoints, landing: opts.syncLanding ?? false }));
  // The return home / landing follows the last sync point immediately, and a hold command
  // cannot stop a drone that already switched to it: the drones hold there by themselves
  // (unlimited loiter) until the operation releases them together.
  plans = plans.map((p, k) => holdAtFinalSyncPoint(p, syncPoints[k]!));
  const maxAlt = opts.maxAltM ?? SWARM_RETURN_MAX_ALT_M;
  plans = separateReturns(plans, maxAlt);
  members.forEach((m, i) => {
    const top = Math.max(0, ...plans[i]!.items.filter(hasAlt).map((it) => it.alt ?? plans[i]!.defaultAlt));
    if (top > maxAlt) warnings.push(`${m.name} would fly at up to ${Math.round(top)} m, above the ${maxAlt} m altitude limit – lower the mission altitude or the altitude step.`);
  });
  const tracks = syncedTimelines(
    plans,
    members.map((m) => m.position),
    syncPoints,
  );
  const sep = separationOverTime(tracks);
  if (sep && sep.distanceM < SWARM_MIN_SEPARATION_M) {
    warnings.push(
      `Planned separation between ${members[sep.a]!.name} and ${members[sep.b]!.name} drops to ${sep.distanceM.toFixed(1)} m (horizontal ${sep.horizontalM.toFixed(1)} m, vertical ${sep.verticalM.toFixed(1)} m) ${Math.round(sep.t)} s after take-off – increase the spacing or the altitude step.`,
    );
  }
  const memberPlans: SwarmMemberPlan[] = members.map((m, i) => {
    const tr = tracks[i]!;
    let dist = 0;
    for (let k = 1; k < tr.length; k++) dist += Math.hypot(haversineDistance(tr[k - 1]!, tr[k]!), tr[k]!.alt - tr[k - 1]!.alt);
    return { droneId: m.id, name: m.name, slot: slotOf[i]!, plan: plans[i]!, syncPoints: syncPoints[i]!, distanceM: Math.round(dist), durationS: Math.round(tr[tr.length - 1]!.t) };
  });
  return {
    members: memberPlans,
    separation: sep ? { ...sep, distanceM: Math.round(sep.distanceM * 10) / 10, horizontalM: Math.round(sep.horizontalM * 10) / 10, verticalM: Math.round(sep.verticalM * 10) / 10, droneA: members[sep.a]!.id, droneB: members[sep.b]!.id } : null,
    durationS: Math.max(...memberPlans.map((m) => m.durationS)),
    warnings,
  };
}

/** Local XY offsets of a plan's positions (debug / tests). */
export function planOffsetsM(a: MissionPlan, b: MissionPlan): number[] {
  const pa = a.items.filter((i) => i.lat !== undefined);
  const pb = b.items.filter((i) => i.lat !== undefined);
  const proj = new LocalProjection(pa[0] as LatLon);
  return pa.map((p, i) => {
    const x = proj.toXY(p as LatLon);
    const y = proj.toXY(pb[i] as LatLon);
    return Math.hypot(x.x - y.x, x.y - y.y);
  });
}
