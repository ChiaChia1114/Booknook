/**
 * Drone swarm planning: formation flight of one mission by several drones, splitting an
 * area or a route between drones, and separation checks.
 */
import { LocalProjection, haversineDistance, initialBearing, destinationPoint, type LatLon } from './geo';
import { generateSurvey, newItemId, type MissionItem, type MissionPlan, type SurveyOptions } from './mission';

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

const shift = (p: LatLon, headingDeg: number, off: { right: number; back: number }): LatLon => {
  const a = off.right === 0 ? p : destinationPoint(p, headingDeg + 90, off.right);
  return off.back === 0 ? a : destinationPoint(a, headingDeg + 180, off.back);
};

/**
 * One plan per drone flying the leader's mission in formation. Each position is offset in
 * the frame of the local direction of travel; `altStepM` stacks the drones vertically as an
 * additional collision barrier.
 */
export function formationPlans(plan: MissionPlan, n: number, pattern: FormationPattern, spacingM: number, altStepM = 0): MissionPlan[] {
  const nav = plan.items.filter((it) => it.lat !== undefined && it.lon !== undefined);
  const headingAt = (idx: number): number => {
    const it = nav[idx]!;
    const prev = idx > 0 ? nav[idx - 1]! : plan.home ?? null;
    const next = idx + 1 < nav.length ? nav[idx + 1]! : null;
    if (prev && haversineDistance(prev as LatLon, it as LatLon) > 1) return initialBearing(prev as LatLon, it as LatLon);
    if (next) return initialBearing(it as LatLon, next as LatLon);
    return 0;
  };
  const offsets = formationOffsets(n, pattern, spacingM);
  const firstHeading = nav.length ? (plan.home ? initialBearing(plan.home, nav[0] as LatLon) : headingAt(0)) : 0;
  return offsets.map((off, d) => {
    let navNo = 0;
    const items = plan.items.map((it): MissionItem => {
      const out: MissionItem = { ...it, id: newItemId() };
      if (it.alt !== undefined && altStepM) out.alt = it.alt + d * altStepM;
      if (it.lat !== undefined && it.lon !== undefined) {
        const p = shift({ lat: it.lat, lon: it.lon }, headingAt(navNo++), off);
        out.lat = p.lat;
        out.lon = p.lon;
      }
      return out;
    });
    const home = plan.home ? { ...shift(plan.home, firstHeading, off), alt: plan.home.alt } : plan.home;
    return { ...plan, home, items, rallyPoints: plan.rallyPoints.map((r) => ({ ...r, alt: r.alt + d * altStepM })) };
  });
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

/** Splits the waypoints of a route between n drones (contiguous, length-balanced). */
export function splitRoute(plan: MissionPlan, n: number): MissionPlan[] {
  const nav = plan.items.filter((it) => it.type === 'waypoint' && it.lat !== undefined && it.lon !== undefined);
  const takeoffAlt = plan.items.find((i) => i.type === 'takeoff')?.alt ?? plan.defaultAlt;
  const seg = nav.map((it, i) => (i ? haversineDistance(nav[i - 1] as LatLon, it as LatLon) : 0));
  const total = seg.reduce((s, v) => s + v, 0);
  const groups: MissionItem[][] = Array.from({ length: n }, () => []);
  let acc = 0;
  nav.forEach((it, i) => {
    acc += seg[i]!;
    const g = Math.min(n - 1, Math.floor((acc / Math.max(1, total)) * n * 0.999999));
    groups[g]!.push(it);
  });
  return groups.map((g) => ({
    ...plan,
    items: [{ id: newItemId(), type: 'takeoff', alt: takeoffAlt }, ...g.map((it) => ({ ...it, id: newItemId() })), { id: newItemId(), type: 'rtl' }],
  }));
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

/** Number of waypoints (navigation items with a position) in a plan – the sync points of a swarm. */
export function syncPointCount(plan: MissionPlan): number {
  return plan.items.filter((it) => (it.type === 'waypoint' || it.type === 'loiter') && it.lat !== undefined).length;
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
