/**
 * Automatic waypoint generation and route optimisation.
 *
 * Generators: orbit / multi-layer structure scan (camera facing the structure), corridor
 * scan, perimeter inspection and camera-driven area survey (line spacing and trigger
 * distance from the camera footprint and the requested overlaps / GSD).
 *
 * Optimisation ("AI path optimisation"):
 *  1. waypoint ordering – an asymmetric travelling-salesman tour (nearest neighbour +
 *     2-opt / or-opt) whose edge cost is the energy predicted by the airframe model under
 *     the forecast wind (distance when no airframe is given);
 *  2. no-fly-zone avoidance – legs crossing blocking airspace are re-routed along the
 *     shortest path of a visibility graph around the buffered zones;
 *  3. terrain following – waypoint altitudes are raised (and summit waypoints inserted)
 *     so that the route keeps the minimum clearance above the terrain profile.
 */
import { legKinematics, rotorPower, surveyParameters, windAtHeight, windVector, wingBorne, wingPower, airDensity, type Airframe, type CameraSpec } from './airframes';
import type { ZoneGeometry, ZoneType } from './api';
import { LocalProjection, bufferPolyline, centroidOf, circlePolygon, destinationPoint, haversineDistance, initialBearing, interpolateLatLon, pointInPolygonXY, segmentsIntersectXY, type LatLon, type XY } from './geo';
import { generateSurvey, newItemId, type MissionItem, type MissionPlan } from './mission';

// ---------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------

export interface OrbitOptions {
  center: LatLon;
  radiusM: number;
  /** Altitude of the first layer (m, relative to home). */
  alt: number;
  /** Waypoints per revolution (≥ 3). */
  points?: number;
  /** Number of layers for a structure scan (each `layerStepM` higher). */
  layers?: number;
  layerStepM?: number;
  clockwise?: boolean;
  startBearingDeg?: number;
  /** Turn the camera towards the centre at every waypoint (default true). */
  faceCenter?: boolean;
  /** Take a photo at every waypoint. */
  photos?: boolean;
}

/** Circular orbit or multi-layer structure scan around a point of interest. */
export function generateOrbit(o: OrbitOptions): MissionItem[] {
  if (!(o.radiusM > 0)) throw new Error('radius must be positive');
  const n = Math.max(3, Math.min(360, Math.round(o.points ?? 16)));
  const layers = Math.max(1, Math.min(50, Math.round(o.layers ?? 1)));
  const step = o.layerStepM ?? 10;
  const dir = o.clockwise === false ? -1 : 1;
  const start = o.startBearingDeg ?? 0;
  const items: MissionItem[] = [];
  for (let l = 0; l < layers; l++) {
    const alt = o.alt + l * step;
    for (let i = 0; i <= n; i++) {
      const bearing = (((start + (dir * 360 * i) / n) % 360) + 360) % 360;
      const p = destinationPoint(o.center, bearing, o.radiusM);
      const it: MissionItem = { id: newItemId(), type: 'waypoint', lat: p.lat, lon: p.lon, alt };
      if (o.faceCenter !== false) it.yawDeg = (bearing + 180) % 360;
      items.push(it);
      if (o.photos && i < n) items.push({ id: newItemId(), type: 'photo' });
    }
  }
  return items;
}

/** Signed area (m²), positive for counter-clockwise rings. */
function signedArea(ring: XY[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j]!.x * ring[i]!.y - ring[i]!.x * ring[j]!.y;
  return a / 2;
}

function counterClockwise(ring: XY[]): XY[] {
  return signedArea(ring) >= 0 ? ring : [...ring].reverse();
}

/** Offsets a polyline sideways (positive = right of the direction of travel), miter joins clamped. */
function offsetPolylineXY(line: XY[], offset: number): XY[] {
  const out: XY[] = [];
  const normal = (a: XY, b: XY): XY => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dy / len, y: -dx / len }; // right-hand normal
  };
  for (let i = 0; i < line.length; i++) {
    const prev = i > 0 ? normal(line[i - 1]!, line[i]!) : null;
    const next = i < line.length - 1 ? normal(line[i]!, line[i + 1]!) : null;
    let nx: number;
    let ny: number;
    if (prev && next) {
      nx = prev.x + next.x;
      ny = prev.y + next.y;
      const len = Math.hypot(nx, ny) || 1;
      nx /= len;
      ny /= len;
      const cos = Math.max(0.35, nx * next.x + ny * next.y);
      nx /= cos;
      ny /= cos;
    } else {
      const n = (prev ?? next)!;
      nx = n.x;
      ny = n.y;
    }
    out.push({ x: line[i]!.x + nx * offset, y: line[i]!.y + ny * offset });
  }
  return out;
}

export interface CorridorOptions {
  line: LatLon[];
  /** Total width of the corridor (m). */
  widthM: number;
  /** Distance between parallel passes (m). */
  spacingM: number;
  alt: number;
}

/** Parallel passes along a linear asset (road, pipeline, power line), flown back and forth. */
export function generateCorridor(o: CorridorOptions): MissionItem[] {
  if (o.line.length < 2) throw new Error('corridor needs at least 2 points');
  if (!(o.spacingM > 0)) throw new Error('spacing must be positive');
  const proj = new LocalProjection(centroidOf(o.line)!);
  const xy = o.line.map((p) => proj.toXY(p));
  const passes = Math.max(1, Math.min(200, Math.floor(o.widthM / o.spacingM) + 1));
  const items: MissionItem[] = [];
  for (let k = 0; k < passes; k++) {
    const off = passes === 1 ? 0 : -o.widthM / 2 + (k * o.widthM) / (passes - 1);
    let pass = offsetPolylineXY(xy, off);
    if (k % 2 === 1) pass = pass.reverse();
    for (const q of pass) {
      const ll = proj.toLatLon(q.x, q.y);
      items.push({ id: newItemId(), type: 'waypoint', lat: ll.lat, lon: ll.lon, alt: o.alt });
    }
  }
  return items;
}

export interface PerimeterOptions {
  polygon: LatLon[];
  /** Distance outside (positive) or inside (negative) the boundary (m). */
  offsetM: number;
  alt: number;
  /** Maximum distance between consecutive waypoints (m); 0 = vertices only. */
  spacingM?: number;
  /** Face the inside of the area (camera towards the boundary). */
  faceInward?: boolean;
}

/** Closed loop around (or inside) an area boundary, e.g. a fence or facade inspection. */
export function generatePerimeter(o: PerimeterOptions): MissionItem[] {
  if (o.polygon.length < 3) throw new Error('perimeter needs at least 3 vertices');
  const proj = new LocalProjection(centroidOf(o.polygon)!);
  // Counter-clockwise ring: the interior is on the left, so the right-hand normal points outwards.
  const ring = counterClockwise(o.polygon.map((p) => proj.toXY(p)));
  // Mitered offset of every vertex (wrap-around neighbours), then close the loop.
  const mitered = offsetPolylineXY([ring[ring.length - 1]!, ...ring, ring[0]!], o.offsetM).slice(1, -1);
  const off = [...mitered, mitered[0]!];
  const pts: XY[] = [];
  const spacing = o.spacingM ?? 0;
  for (let i = 0; i < off.length - 1; i++) {
    const a = off[i]!;
    const b = off[i + 1]!;
    const n = spacing > 0 ? Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / spacing)) : 1;
    for (let k = 0; k < n; k++) pts.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  pts.push(off[off.length - 1]!);
  const c = { x: 0, y: 0 };
  return pts.map((q) => {
    const ll = proj.toLatLon(q.x, q.y);
    const it: MissionItem = { id: newItemId(), type: 'waypoint', lat: ll.lat, lon: ll.lon, alt: o.alt };
    if (o.faceInward) it.yawDeg = (((Math.atan2(c.x - q.x, c.y - q.y) * 180) / Math.PI) + 360) % 360;
    return it;
  });
}

export interface CameraSurveyOptions {
  polygon: LatLon[];
  camera: CameraSpec;
  /** Flight height above ground (m); computed from `gsdCmPerPx` when omitted. */
  alt?: number;
  gsdCmPerPx?: number;
  frontOverlap: number;
  sideOverlap: number;
  angleDeg: number;
}

export interface CameraSurvey {
  items: MissionItem[];
  alt: number;
  lineSpacingM: number;
  triggerDistanceM: number;
  gsdCmPerPx: number;
}

/** Mapping survey whose line spacing and camera trigger distance come from the camera model. */
export function generateCameraSurvey(o: CameraSurveyOptions): CameraSurvey {
  const alt = o.alt ?? (o.gsdCmPerPx ? ((o.gsdCmPerPx / 100) * o.camera.imageWidthPx * o.camera.focalLengthMm) / o.camera.sensorWidthMm : 60);
  const p = surveyParameters(o.camera, alt, o.frontOverlap, o.sideOverlap);
  const lines = generateSurvey(o.polygon, { spacingM: p.lineSpacingM, angleDeg: o.angleDeg, alt });
  const trigger = Math.round(p.triggerDistanceM * 10) / 10;
  const items: MissionItem[] = [];
  if (lines.length > 0) {
    items.push(lines[0]!);
    items.push({ id: newItemId(), type: 'camera_trigger', triggerDistanceM: trigger });
    items.push(...lines.slice(1));
    items.push({ id: newItemId(), type: 'camera_trigger', triggerDistanceM: 0 });
  }
  return { items, alt: Math.round(alt * 10) / 10, lineSpacingM: Math.round(p.lineSpacingM * 10) / 10, triggerDistanceM: trigger, gsdCmPerPx: Math.round(p.gsdCmPerPx * 100) / 100 };
}

// ---------------------------------------------------------------------------------------
// Optimisation
// ---------------------------------------------------------------------------------------

/** Zone types that a route must never cross. */
export const BLOCKING_ZONE_TYPES: ReadonlySet<ZoneType> = new Set(['prohibited', 'restricted', 'temporary', 'hazard_powerline', 'hazard_obstacle']);

export interface ObstacleZone {
  name: string;
  type: ZoneType;
  geometry: ZoneGeometry;
  floorM: number;
  ceilingM: number;
}

export interface OptimizeOptions {
  /** Reorder waypoints (keeps take-off first and RTL/landing last). */
  reorder?: boolean;
  zones?: ObstacleZone[];
  /** Horizontal safety margin around zones (m). Default 30. */
  bufferM?: number;
  airframe?: Airframe;
  payloadKg?: number;
  wind?: { speedMs: number; fromDeg: number } | null;
}

export interface Detour {
  legIndex: number;
  around: string[];
  addedPoints: number;
  extraDistanceM: number;
}

export interface OptimizeReport {
  reordered: boolean;
  distanceBeforeM: number;
  distanceAfterM: number;
  costBefore: number;
  costAfter: number;
  costUnit: 'Wh' | 'm';
  detours: Detour[];
  /** Legs that could not be routed around blocking airspace. */
  unresolved: string[];
}

interface Block {
  /** Navigation item with a position. */
  nav: MissionItem;
  /** Non-positional items that follow it (photo, speed, camera trigger …). */
  extras: MissionItem[];
}

const hasPos = (it: MissionItem): it is MissionItem & { lat: number; lon: number } => it.lat !== undefined && it.lon !== undefined;

/** Energy (Wh) or distance (m) to fly from a to b. */
export function legCost(a: LatLon & { alt?: number }, b: LatLon & { alt?: number }, opts: { airframe?: Airframe; payloadKg?: number; wind?: { speedMs: number; fromDeg: number } | null; speedMs: number }): number {
  const d = haversineDistance(a, b);
  const af = opts.airframe;
  if (!af) return d;
  if (d < 0.5) return 0;
  const altA = a.alt ?? 0;
  const altB = b.alt ?? altA;
  const mass = af.emptyMassKg + (opts.payloadKg ?? 0);
  const rho = airDensity(Math.max(altA, altB));
  const wSpeed = opts.wind ? windAtHeight(opts.wind.speedMs, Math.max(altA, altB)) : 0;
  const w = opts.wind ? windVector(wSpeed, opts.wind.fromDeg) : { e: 0, n: 0 };
  const wing = wingBorne(af, 'cruise');
  const k = legKinematics(initialBearing(a, b), wing ? af.cruiseSpeedMs : Math.min(opts.speedMs, af.maxSpeedMs), w, wing ? 'air' : 'ground', af.maxSpeedMs);
  if (!k.feasible || k.groundSpeedMs <= 0) return Number.MAX_SAFE_INTEGER / 1e6;
  const dz = altB - altA;
  const tH = d / k.groundSpeedMs;
  const tV = Math.abs(dz) / (dz >= 0 ? af.maxClimbMs : af.maxDescentMs);
  const time = Math.max(tH, tV);
  const climb = time > 0 ? dz / time : 0;
  const p = (wing ? wingPower(af, mass, k.airspeedMs, climb, rho) : rotorPower(af, mass, k.airspeedMs, climb, rho)).totalW;
  return (p * time) / 3600;
}

function tourCost(order: number[], cost: (i: number, j: number) => number, start: number, end: number | null): number {
  let c = order.length ? cost(start, order[0]!) : 0;
  for (let i = 0; i + 1 < order.length; i++) c += cost(order[i]!, order[i + 1]!);
  if (end !== null && order.length) c += cost(order[order.length - 1]!, end);
  return c;
}

/**
 * Orders nodes 1..n-1 (node 0 = start; `endAtStart` returns to it) minimising an asymmetric
 * cost: nearest neighbour, then 2-opt segment reversals and or-opt moves until no improvement.
 */
export function solveTour(n: number, cost: (i: number, j: number) => number, endAtStart: boolean, maxIterations = 200): number[] {
  const nodes = Array.from({ length: n - 1 }, (_, i) => i + 1);
  if (nodes.length <= 2) {
    if (nodes.length === 2) {
      const a = tourCost([1, 2], cost, 0, endAtStart ? 0 : null);
      const b = tourCost([2, 1], cost, 0, endAtStart ? 0 : null);
      return a <= b ? [1, 2] : [2, 1];
    }
    return nodes;
  }
  // Nearest neighbour.
  const order: number[] = [];
  const left = new Set(nodes);
  let cur = 0;
  while (left.size) {
    let best = -1;
    let bestC = Infinity;
    for (const j of left) {
      const c = cost(cur, j);
      if (c < bestC) {
        bestC = c;
        best = j;
      }
    }
    order.push(best);
    left.delete(best);
    cur = best;
  }
  const end = endAtStart ? 0 : null;
  let best = tourCost(order, cost, 0, end);
  for (let iter = 0; iter < maxIterations; iter++) {
    let improved = false;
    // 2-opt (segment reversal; costs recomputed because they are asymmetric).
    for (let i = 0; i < order.length - 1; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const cand = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
        const c = tourCost(cand, cost, 0, end);
        if (c < best - 1e-9) {
          order.splice(0, order.length, ...cand);
          best = c;
          improved = true;
        }
      }
    }
    // Or-opt: move one node elsewhere.
    for (let i = 0; i < order.length; i++) {
      for (let j = 0; j < order.length; j++) {
        if (i === j) continue;
        const cand = [...order];
        const [x] = cand.splice(i, 1);
        cand.splice(j, 0, x!);
        const c = tourCost(cand, cost, 0, end);
        if (c < best - 1e-9) {
          order.splice(0, order.length, ...cand);
          best = c;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return order;
}

/** Buffered obstacle outline in the local projection (circles as circumscribed 24-gons). */
function obstacleRing(z: ObstacleZone, bufferM: number, proj: LocalProjection): XY[] {
  const g = z.geometry;
  let ring: LatLon[];
  if (g.kind === 'circle') {
    const r = (g.radiusM + bufferM) / Math.cos(Math.PI / 24);
    ring = circlePolygon(g.center, r, 24);
  } else if (g.kind === 'line') {
    ring = bufferPolyline(g.line, g.bufferM + bufferM, 4);
  } else {
    // Grow the polygon: on a counter-clockwise ring the right-hand normal points outwards.
    const ccw = counterClockwise(g.polygon.map((p) => proj.toXY(p)));
    return offsetPolylineXY([ccw[ccw.length - 1]!, ...ccw, ccw[0]!], bufferM).slice(1, -1);
  }
  return ring.map((p) => proj.toXY(p));
}

function segmentBlocked(a: XY, b: XY, ring: XY[]): boolean {
  // Crosses an edge (touching endpoints excluded) or passes through the interior.
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const p = ring[j]!;
    const q = ring[i]!;
    const shares = [p, q].some((v) => (Math.abs(v.x - a.x) < 1e-6 && Math.abs(v.y - a.y) < 1e-6) || (Math.abs(v.x - b.x) < 1e-6 && Math.abs(v.y - b.y) < 1e-6));
    if (!shares && segmentsIntersectXY(a, b, p, q)) return true;
  }
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return pointInPolygonXY(mid, ring);
}

interface RouteResult {
  points: LatLon[];
  around: string[];
  ok: boolean;
}

/**
 * Shortest path from a to b avoiding the obstacles (visibility graph + Dijkstra).
 * Returns the intermediate points (excluding a and b).
 */
export function routeAround(a: LatLon, b: LatLon, obstacles: { name: string; ring: LatLon[] }[], bufferM = 0): RouteResult {
  const proj = new LocalProjection(a);
  const rings = obstacles.map((o) => ({ name: o.name, xy: o.ring.map((p) => proj.toXY(p)) }));
  const A = proj.toXY(a);
  const B = proj.toXY(b);
  const blockedBy = (p: XY, q: XY) => rings.filter((r) => segmentBlocked(p, q, r.xy));
  if (blockedBy(A, B).length === 0) return { points: [], around: [], ok: true };
  if (rings.some((r) => pointInPolygonXY(A, r.xy) || pointInPolygonXY(B, r.xy))) {
    return { points: [], around: rings.filter((r) => pointInPolygonXY(A, r.xy) || pointInPolygonXY(B, r.xy)).map((r) => r.name), ok: false };
  }
  // Vertices slightly pushed outward so that paths along an outline are not "inside".
  const nodes: XY[] = [A, B];
  const owner: string[] = ['', ''];
  for (const r of rings) {
    const c = r.xy.reduce((s, v) => ({ x: s.x + v.x / r.xy.length, y: s.y + v.y / r.xy.length }), { x: 0, y: 0 });
    for (const v of r.xy) {
      const dx = v.x - c.x;
      const dy = v.y - c.y;
      const len = Math.hypot(dx, dy) || 1;
      nodes.push({ x: v.x + (dx / len) * Math.max(0.5, bufferM * 0.02), y: v.y + (dy / len) * Math.max(0.5, bufferM * 0.02) });
      owner.push(r.name);
    }
  }
  const n = nodes.length;
  const dist = new Array<number>(n).fill(Infinity);
  const prev = new Array<number>(n).fill(-1);
  const done = new Array<boolean>(n).fill(false);
  dist[0] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i]! < Infinity && (u < 0 || dist[i]! < dist[u]!)) u = i;
    if (u < 0 || u === 1) break;
    done[u] = true;
    for (let v = 0; v < n; v++) {
      if (done[v] || v === u) continue;
      const w = Math.hypot(nodes[u]!.x - nodes[v]!.x, nodes[u]!.y - nodes[v]!.y);
      if (dist[u]! + w >= dist[v]!) continue;
      if (rings.some((r) => segmentBlocked(nodes[u]!, nodes[v]!, r.xy))) continue;
      dist[v] = dist[u]! + w;
      prev[v] = u;
    }
  }
  if (dist[1] === Infinity) return { points: [], around: blockedBy(A, B).map((r) => r.name), ok: false };
  const path: number[] = [];
  for (let v = prev[1]!; v > 0; v = prev[v]!) path.unshift(v);
  const around = [...new Set(path.map((i) => owner[i]!).filter(Boolean))];
  return { points: path.map((i) => proj.toLatLon(nodes[i]!.x, nodes[i]!.y)), around, ok: true };
}

function planDistance(plan: MissionPlan): number {
  let d = 0;
  let prev: LatLon | null = plan.home ?? null;
  for (const it of plan.items) {
    if (!hasPos(it)) continue;
    if (prev) d += haversineDistance(prev, it);
    prev = it;
  }
  if (plan.home && prev && plan.items.some((i) => i.type === 'rtl')) d += haversineDistance(prev, plan.home);
  return d;
}

function planCost(plan: MissionPlan, opts: OptimizeOptions): number {
  let c = 0;
  const start = plan.home ?? plan.items.find(hasPos);
  if (!start) return 0;
  let prev: LatLon & { alt?: number } = { lat: start.lat, lon: start.lon, alt: plan.items.find((i) => i.type === 'takeoff')?.alt ?? plan.defaultAlt };
  let speed = plan.defaultSpeed;
  for (const it of plan.items) {
    if (it.type === 'speed' && it.speed) speed = it.speed;
    if (!hasPos(it)) continue;
    const to = { lat: it.lat, lon: it.lon, alt: it.alt ?? prev.alt };
    c += legCost(prev, to, { ...opts, speedMs: it.speed ?? speed });
    prev = to;
  }
  if (plan.home && plan.items.some((i) => i.type === 'rtl')) c += legCost(prev, { lat: plan.home.lat, lon: plan.home.lon, alt: prev.alt }, { ...opts, speedMs: speed });
  return c;
}

/**
 * Optimises a mission. Waypoints with a hold time, loiters and landings keep their
 * position in the sequence relative to the blocks around them only when reordering is off.
 */
export function optimizeRoute(plan: MissionPlan, opts: OptimizeOptions = {}): { plan: MissionPlan; report: OptimizeReport } {
  const bufferM = opts.bufferM ?? 30;
  const unit: 'Wh' | 'm' = opts.airframe ? 'Wh' : 'm';
  const distanceBeforeM = planDistance(plan);
  const costBefore = planCost(plan, opts);
  let items = plan.items.map((i) => ({ ...i }));
  let reordered = false;

  // 1. Reorder the waypoint blocks between take-off and the terminal item.
  if (opts.reorder) {
    const head: MissionItem[] = [];
    let k = 0;
    while (k < items.length && !(items[k]!.type === 'waypoint' && hasPos(items[k]!))) head.push(items[k++]!);
    const tailStart = items.findIndex((it, idx) => idx >= k && (it.type === 'rtl' || it.type === 'land'));
    const body = items.slice(k, tailStart < 0 ? items.length : tailStart);
    const tail = tailStart < 0 ? [] : items.slice(tailStart);
    const blocks: Block[] = [];
    for (const it of body) {
      if (hasPos(it) && it.type === 'waypoint') blocks.push({ nav: it, extras: [] });
      else if (blocks.length) blocks[blocks.length - 1]!.extras.push(it);
      else head.push(it);
    }
    const start = plan.home ?? (blocks[0]?.nav as LatLon | undefined);
    if (start && blocks.length >= 3 && blocks.length <= 300) {
      const pts: (LatLon & { alt?: number })[] = [{ lat: start.lat, lon: start.lon, alt: head.find((i) => i.type === 'takeoff')?.alt ?? plan.defaultAlt }, ...blocks.map((b) => ({ lat: b.nav.lat!, lon: b.nav.lon!, alt: b.nav.alt ?? plan.defaultAlt }))];
      const memo = new Map<number, number>();
      const cost = (i: number, j: number) => {
        const key = i * 100_000 + j;
        let c = memo.get(key);
        if (c === undefined) {
          c = legCost(pts[i]!, pts[j]!, { ...opts, speedMs: plan.defaultSpeed });
          memo.set(key, c);
        }
        return c;
      };
      const endAtStart = tail.some((t) => t.type === 'rtl');
      const order = solveTour(pts.length, cost, endAtStart);
      const before = tourCost(blocks.map((_, i) => i + 1), cost, 0, endAtStart ? 0 : null);
      const after = tourCost(order, cost, 0, endAtStart ? 0 : null);
      if (after < before - 1e-6) {
        items = [...head, ...order.flatMap((i) => [blocks[i - 1]!.nav, ...blocks[i - 1]!.extras]), ...tail];
        reordered = true;
      }
    }
  }

  // 2. Re-route legs that cross blocking airspace.
  const detours: Detour[] = [];
  const unresolved: string[] = [];
  const zones = (opts.zones ?? []).filter((z) => BLOCKING_ZONE_TYPES.has(z.type));
  if (zones.length > 0) {
    const anchor = plan.home ?? items.find(hasPos);
    if (anchor) {
      const proj = new LocalProjection(anchor);
      const obstacles = zones.map((z) => ({ zone: z, ring: obstacleRing(z, bufferM, proj).map((q) => proj.toLatLon(q.x, q.y)) }));
      const out: MissionItem[] = [];
      let prev: (LatLon & { alt: number }) | null = plan.home ? { lat: plan.home.lat, lon: plan.home.lon, alt: 0 } : null;
      let legIndex = 0;
      const routeLeg = (from: LatLon & { alt: number }, to: LatLon & { alt: number }) => {
        const lo = Math.min(from.alt, to.alt);
        const hi = Math.max(from.alt, to.alt);
        const relevant = obstacles.filter((o) => o.zone.floorM <= hi && o.zone.ceilingM >= lo);
        const r = routeAround(from, to, relevant.map((o) => ({ name: o.zone.name, ring: o.ring })), bufferM);
        if (!r.ok) {
          unresolved.push(`Leg ${legIndex + 1} cannot avoid ${r.around.join(', ') || 'blocking airspace'} (start or end point inside the buffered zone).`);
          return [] as MissionItem[];
        }
        if (r.points.length === 0) return [];
        const total = [from, ...r.points, to].reduce((s, p, i, arr) => (i ? s + haversineDistance(arr[i - 1]!, p) : 0), 0);
        let run = 0;
        const added = r.points.map((p, i) => {
          run += haversineDistance(i === 0 ? from : r.points[i - 1]!, p);
          const f = total > 0 ? run / total : 0;
          return { id: newItemId(), type: 'waypoint' as const, lat: p.lat, lon: p.lon, alt: Math.round((from.alt + (to.alt - from.alt) * f) * 10) / 10 };
        });
        detours.push({ legIndex, around: r.around, addedPoints: added.length, extraDistanceM: Math.round(total - haversineDistance(from, to)) });
        return added;
      };
      let curAlt = 0;
      for (const it of items) {
        if (it.type === 'takeoff') curAlt = it.alt ?? plan.defaultAlt;
        if (hasPos(it) && (it.type === 'waypoint' || it.type === 'loiter' || it.type === 'land')) {
          const to = { lat: it.lat, lon: it.lon, alt: it.type === 'land' ? curAlt : (it.alt ?? curAlt) };
          if (prev) out.push(...routeLeg({ ...prev, alt: Math.max(prev.alt, curAlt) }, to));
          legIndex++;
          prev = to;
          curAlt = to.alt;
        }
        if (it.type === 'rtl' && plan.home && prev) {
          out.push(...routeLeg(prev, { lat: plan.home.lat, lon: plan.home.lon, alt: prev.alt }));
          legIndex++;
        }
        out.push(it);
      }
      items = out;
    }
  }

  const result: MissionPlan = { ...plan, items };
  return {
    plan: result,
    report: {
      reordered,
      distanceBeforeM: Math.round(distanceBeforeM),
      distanceAfterM: Math.round(planDistance(result)),
      costBefore: Math.round(costBefore * 10) / 10,
      costAfter: Math.round(planCost(result, opts) * 10) / 10,
      costUnit: unit,
      detours,
      unresolved,
    },
  };
}

// ---------------------------------------------------------------------------------------
// Terrain following
// ---------------------------------------------------------------------------------------

export interface RouteTerrainSample {
  /** Index of the leg (between consecutive positions of the plan, home first). */
  leg: number;
  lat: number;
  lon: number;
  /** Fraction along the leg. */
  f: number;
}

/** Positions flown at cruise altitude: home, waypoints / loiters, and home again for RTL. */
function cruisePositions(plan: MissionPlan): { positions: LatLon[]; rtlLeg: number | null } {
  const positions: LatLon[] = [];
  if (plan.home) positions.push(plan.home);
  for (const it of plan.items) if (hasPos(it) && (it.type === 'waypoint' || it.type === 'loiter')) positions.push(it);
  const rtl = plan.home && plan.items.some((i) => i.type === 'rtl') && positions.length > 1;
  if (rtl) positions.push(plan.home!);
  return { positions, rtlLeg: rtl ? positions.length - 2 : null };
}

/** Points along every leg (every `spacingM`) whose ground elevation the terrain step needs. */
export function terrainSamplePoints(plan: MissionPlan, spacingM = 25, maxPoints = 4000): RouteTerrainSample[] {
  const { positions } = cruisePositions(plan);
  const out: RouteTerrainSample[] = [];
  for (let i = 0; i + 1 < positions.length; i++) {
    const a = positions[i]!;
    const b = positions[i + 1]!;
    const n = Math.max(1, Math.ceil(haversineDistance(a, b) / spacingM));
    for (let k = 0; k <= n; k++) {
      const p = interpolateLatLon(a, b, k / n);
      out.push({ leg: i, lat: p.lat, lon: p.lon, f: k / n });
    }
  }
  if (out.length <= maxPoints) return out;
  const step = out.length / maxPoints;
  return Array.from({ length: maxPoints }, (_, i) => out[Math.floor(i * step)]!);
}

export interface TerrainFollowResult {
  plan: MissionPlan;
  changes: { itemId: string; fromAlt: number; toAlt: number }[];
  inserted: number;
  /** Highest altitude the terrain requires (m above home). */
  maxRequiredAlt: number;
  violations: string[];
}

/**
 * Terrain following: every leg must stay `minClearanceM` above the terrain. Endpoints below
 * their own requirement are raised; between them, waypoints are inserted at the vertices of
 * the upper hull of the required-altitude profile – the lowest piecewise-linear profile with
 * the fewest breakpoints that clears the terrain. Requirements above `maxAltM` (regulatory
 * ceiling) are clamped and reported.
 */
export function applyTerrainFollowing(plan: MissionPlan, samples: RouteTerrainSample[], elevations: (number | null)[], opts: { homeElevationM: number; minClearanceM: number; maxAltM: number }): TerrainFollowResult {
  const items = plan.items.map((i) => ({ ...i }));
  const { rtlLeg } = cruisePositions(plan);
  const navIdx: number[] = [];
  items.forEach((it, idx) => {
    if (hasPos(it) && (it.type === 'waypoint' || it.type === 'loiter')) navIdx.push(idx);
  });
  const offset = plan.home ? 1 : 0;
  const takeoffIdx = items.findIndex((i) => i.type === 'takeoff');
  const byLeg = new Map<number, { f: number; need: number; lat: number; lon: number }[]>();
  samples.forEach((s, i) => {
    const e = elevations[i];
    if (e === null || e === undefined || !Number.isFinite(e)) return;
    const list = byLeg.get(s.leg) ?? [];
    list.push({ f: s.f, need: e - opts.homeElevationM + opts.minClearanceM, lat: s.lat, lon: s.lon });
    byLeg.set(s.leg, list);
  });
  const changes: TerrainFollowResult['changes'] = [];
  const violations: string[] = [];
  const inserts: { beforeIdx: number; f: number; item: MissionItem }[] = [];
  let maxRequired = 0;
  const altOf = (idx: number) => items[idx]!.alt ?? plan.defaultAlt;
  const clamp = (alt: number, what: string) => {
    if (alt > opts.maxAltM + 1e-6) {
      violations.push(`${what} needs ${Math.ceil(alt)} m for ${opts.minClearanceM} m terrain clearance, above the ${opts.maxAltM} m limit.`);
      return opts.maxAltM;
    }
    return Math.ceil(alt);
  };
  const raise = (idx: number, alt: number) => {
    const from = altOf(idx);
    const target = clamp(alt, `Item ${idx + 1}`);
    if (target > from) {
      items[idx]!.alt = target;
      changes.push({ itemId: items[idx]!.id, fromAlt: from, toAlt: target });
    }
  };
  for (const leg of [...byLeg.keys()].sort((a, b) => a - b)) {
    const raw = byLeg.get(leg)!.sort((a, b) => a.f - b.f);
    // Safety margin for terrain between samples: each sample requires the highest need of
    // itself and its neighbours.
    const pts = raw.map((p, i) => ({ ...p, need: Math.max(p.need, raw[i - 1]?.need ?? -Infinity, raw[i + 1]?.need ?? -Infinity) }));
    for (const p of pts) maxRequired = Math.max(maxRequired, p.need);
    const startIdx = leg - offset >= 0 ? navIdx[leg - offset] : takeoffIdx >= 0 ? takeoffIdx : undefined;
    if (leg === rtlLeg) {
      // RTL is flown at the altitude of the last waypoint.
      if (startIdx !== undefined) raise(startIdx, pts.reduce((m, p) => Math.max(m, p.need), -Infinity));
      continue;
    }
    const endIdx = navIdx[leg + 1 - offset];
    if (endIdx === undefined) continue;
    const at0 = pts.filter((p) => p.f === 0).reduce((m, p) => Math.max(m, p.need), -Infinity);
    const at1 = pts.filter((p) => p.f === 1).reduce((m, p) => Math.max(m, p.need), -Infinity);
    if (startIdx !== undefined && at0 > altOf(startIdx)) raise(startIdx, at0);
    if (at1 > altOf(endIdx)) raise(endIdx, at1);
    const A = startIdx !== undefined ? altOf(startIdx) : plan.defaultAlt;
    const B = altOf(endIdx);
    // Upper hull (monotone chain, f ascending): pop while the middle point is not above the chord.
    type HP = { f: number; alt: number; lat?: number; lon?: number };
    const hull: HP[] = [];
    for (const p of [{ f: 0, alt: A }, ...pts.filter((q) => q.f > 0 && q.f < 1).map((q) => ({ f: q.f, alt: q.need, lat: q.lat, lon: q.lon })), { f: 1, alt: B }] as HP[]) {
      while (hull.length >= 2) {
        const o = hull[hull.length - 2]!;
        const a = hull[hull.length - 1]!;
        const cross = (a.f - o.f) * (p.alt - o.alt) - (a.alt - o.alt) * (p.f - o.f);
        if (cross >= 0) hull.pop();
        else break;
      }
      hull.push(p);
    }
    for (const h of hull.slice(1, -1)) {
      inserts.push({ beforeIdx: endIdx, f: h.f, item: { id: newItemId(), type: 'waypoint', lat: h.lat!, lon: h.lon!, alt: clamp(h.alt, `Terrain on leg ${leg + 1}`) } });
    }
  }
  // Insert from the end so earlier indices stay valid; points of one leg in flight order.
  inserts.sort((a, b) => b.beforeIdx - a.beforeIdx || b.f - a.f);
  for (const ins of inserts) items.splice(ins.beforeIdx, 0, ins.item);
  return { plan: { ...plan, items }, changes, inserted: inserts.length, maxRequiredAlt: Math.ceil(maxRequired), violations };
}
