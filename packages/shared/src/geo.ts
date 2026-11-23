/**
 * Geodesy and planar geometry helpers.
 *
 * Long-range values (distance, bearing, destination) use spherical formulas.
 * Shape-vs-shape checks (airspace conflicts, geofences, corridors) use a local
 * equirectangular projection, which is accurate to well under 1 % for the
 * < 50 km extents typical of drone operations.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

export interface LatLonAlt extends LatLon {
  alt: number;
}

export interface XY {
  x: number;
  y: number;
}

export interface BBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

export const EARTH_RADIUS_M = 6_371_008.8;
const D2R = Math.PI / 180;

export const toRad = (deg: number): number => deg * D2R;
export const toDeg = (rad: number): number => rad / D2R;

/** Normalises a longitude into [-180, 180). */
export function normalizeLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Normalises an angle into [0, 360). */
export function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

export function isValidLatLon(p: Partial<LatLon> | null | undefined): p is LatLon {
  return (
    !!p &&
    typeof p.lat === 'number' &&
    typeof p.lon === 'number' &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lon) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    p.lon >= -180 &&
    p.lon <= 180
  );
}

/** Great-circle distance in metres. */
export function haversineDistance(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing from a to b in degrees [0, 360), clockwise from true north. */
export function initialBearing(a: LatLon, b: LatLon): number {
  const p1 = toRad(a.lat);
  const p2 = toRad(b.lat);
  const dl = toRad(b.lon - a.lon);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return normalizeDeg(toDeg(Math.atan2(y, x)));
}

/** Point reached travelling `distanceM` from `origin` on initial bearing `bearingDeg`. */
export function destinationPoint(origin: LatLon, bearingDeg: number, distanceM: number): LatLon {
  const d = distanceM / EARTH_RADIUS_M;
  const t = toRad(bearingDeg);
  const p1 = toRad(origin.lat);
  const l1 = toRad(origin.lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: toDeg(p2), lon: normalizeLon(toDeg(l2)) };
}

/** Linear interpolation between two nearby positions (f in [0, 1]). */
export function interpolateLatLon(a: LatLon, b: LatLon, f: number): LatLon {
  const dLon = normalizeLon(b.lon - a.lon);
  return { lat: a.lat + (b.lat - a.lat) * f, lon: normalizeLon(a.lon + dLon * f) };
}

export function polylineLengthM(points: LatLon[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineDistance(points[i - 1]!, points[i]!);
  return total;
}

export function bboxOf(points: LatLon[]): BBox | null {
  if (points.length === 0) return null;
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return { minLat, minLon, maxLat, maxLon };
}

export function centroidOf(points: LatLon[]): LatLon | null {
  if (points.length === 0) return null;
  let lat = 0;
  let lon = 0;
  for (const p of points) {
    lat += p.lat;
    lon += p.lon;
  }
  return { lat: lat / points.length, lon: lon / points.length };
}

/** Local east/north metric projection around a reference point. */
export class LocalProjection {
  readonly ref: LatLon;
  private readonly kx: number;
  private readonly ky: number;

  constructor(ref: LatLon) {
    this.ref = ref;
    this.ky = D2R * EARTH_RADIUS_M;
    this.kx = D2R * EARTH_RADIUS_M * Math.cos(toRad(ref.lat));
  }

  toXY(p: LatLon): XY {
    return { x: normalizeLon(p.lon - this.ref.lon) * this.kx, y: (p.lat - this.ref.lat) * this.ky };
  }

  toLatLon(x: number, y: number): LatLon {
    return { lat: this.ref.lat + y / this.ky, lon: normalizeLon(this.ref.lon + x / this.kx) };
  }
}

// ---------------------------------------------------------------------------
// Planar primitives
// ---------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function distPointSegmentXY(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function orient(a: XY, b: XY, c: XY): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: XY, b: XY, p: XY): boolean {
  return (
    Math.min(a.x, b.x) - 1e-9 <= p.x &&
    p.x <= Math.max(a.x, b.x) + 1e-9 &&
    Math.min(a.y, b.y) - 1e-9 <= p.y &&
    p.y <= Math.max(a.y, b.y) + 1e-9
  );
}

export function segmentsIntersectXY(p1: XY, p2: XY, q1: XY, q2: XY): boolean {
  const d1 = orient(q1, q2, p1);
  const d2 = orient(q1, q2, p2);
  const d3 = orient(p1, p2, q1);
  const d4 = orient(p1, p2, q2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const eps = 1e-9;
  if (Math.abs(d1) < eps && onSegment(q1, q2, p1)) return true;
  if (Math.abs(d2) < eps && onSegment(q1, q2, p2)) return true;
  if (Math.abs(d3) < eps && onSegment(p1, p2, q1)) return true;
  if (Math.abs(d4) < eps && onSegment(p1, p2, q2)) return true;
  return false;
}

export function distSegmentSegmentXY(p1: XY, p2: XY, q1: XY, q2: XY): number {
  if (segmentsIntersectXY(p1, p2, q1, q2)) return 0;
  return Math.min(
    distPointSegmentXY(p1, q1, q2),
    distPointSegmentXY(p2, q1, q2),
    distPointSegmentXY(q1, p1, p2),
    distPointSegmentXY(q2, p1, p2),
  );
}

/** Ray casting point-in-polygon; points on the boundary count as inside. */
export function pointInPolygonXY(p: XY, poly: XY[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    if (distPointSegmentXY(p, poly[j]!, poly[i]!) < 1e-6) return true;
  }
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(p: LatLon, polygon: LatLon[]): boolean {
  if (polygon.length < 3) return false;
  const proj = new LocalProjection(polygon[0]!);
  return pointInPolygonXY(proj.toXY(p), polygon.map((v) => proj.toXY(v)));
}

export function distancePointToSegmentM(p: LatLon, a: LatLon, b: LatLon): number {
  const proj = new LocalProjection(p);
  return distPointSegmentXY(proj.toXY(p), proj.toXY(a), proj.toXY(b));
}

export function distancePointToPolylineM(p: LatLon, line: LatLon[]): number {
  if (line.length === 0) return Infinity;
  if (line.length === 1) return haversineDistance(p, line[0]!);
  const proj = new LocalProjection(p);
  const pp = proj.toXY(p);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    best = Math.min(best, distPointSegmentXY(pp, proj.toXY(line[i - 1]!), proj.toXY(line[i]!)));
  }
  return best;
}

export function polygonAreaM2(polygon: LatLon[]): number {
  if (polygon.length < 3) return 0;
  const proj = new LocalProjection(polygon[0]!);
  const pts = polygon.map((p) => proj.toXY(p));
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j]!.x + pts[i]!.x) * (pts[j]!.y - pts[i]!.y);
  return Math.abs(s) / 2;
}

/** True if the segment a-b crosses any edge of the polygon. */
export function segmentCrossesPolygon(a: LatLon, b: LatLon, polygon: LatLon[]): boolean {
  if (polygon.length < 3) return false;
  const proj = new LocalProjection(a);
  const pa = proj.toXY(a);
  const pb = proj.toXY(b);
  const ring = polygon.map((p) => proj.toXY(p));
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if (segmentsIntersectXY(pa, pb, ring[j]!, ring[i]!)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Shapes (used for airspace, reservations, corridors, hazards)
// ---------------------------------------------------------------------------

export type Shape =
  | { kind: 'point'; point: LatLon; radiusM: number }
  | { kind: 'line'; line: LatLon[]; radiusM: number }
  | { kind: 'polygon'; polygon: LatLon[]; radiusM?: number };

function shapeRef(s: Shape): LatLon {
  if (s.kind === 'point') return s.point;
  if (s.kind === 'line') return s.line[0]!;
  return s.polygon[0]!;
}

function shapeSegments(s: Shape, proj: LocalProjection): [XY, XY][] {
  if (s.kind === 'point') {
    const p = proj.toXY(s.point);
    return [[p, p]];
  }
  if (s.kind === 'line') {
    const pts = s.line.map((p) => proj.toXY(p));
    if (pts.length === 1) return [[pts[0]!, pts[0]!]];
    const segs: [XY, XY][] = [];
    for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1]!, pts[i]!]);
    return segs;
  }
  const ring = s.polygon.map((p) => proj.toXY(p));
  const segs: [XY, XY][] = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) segs.push([ring[j]!, ring[i]!]);
  return segs;
}

function shapeVertices(s: Shape, proj: LocalProjection): XY[] {
  if (s.kind === 'point') return [proj.toXY(s.point)];
  if (s.kind === 'line') return s.line.map((p) => proj.toXY(p));
  return s.polygon.map((p) => proj.toXY(p));
}

function shapeRadius(s: Shape): number {
  return s.kind === 'polygon' ? (s.radiusM ?? 0) : s.radiusM;
}

function isValidShape(s: Shape): boolean {
  if (s.kind === 'point') return isValidLatLon(s.point);
  if (s.kind === 'line') return s.line.length >= 1 && s.line.every(isValidLatLon);
  return s.polygon.length >= 3 && s.polygon.every(isValidLatLon);
}

/**
 * Minimum horizontal distance between two shapes in metres after subtracting
 * their buffer radii. Zero or negative means the shapes overlap.
 */
export function shapeDistanceM(a: Shape, b: Shape): number {
  if (!isValidShape(a) || !isValidShape(b)) return Infinity;
  const proj = new LocalProjection(shapeRef(a));
  const ra = shapeRadius(a);
  const rb = shapeRadius(b);
  let core = Infinity;
  if (a.kind === 'polygon') {
    const ring = a.polygon.map((p) => proj.toXY(p));
    if (shapeVertices(b, proj).some((v) => pointInPolygonXY(v, ring))) core = 0;
  }
  if (core > 0 && b.kind === 'polygon') {
    const ring = b.polygon.map((p) => proj.toXY(p));
    if (shapeVertices(a, proj).some((v) => pointInPolygonXY(v, ring))) core = 0;
  }
  if (core > 0) {
    const sa = shapeSegments(a, proj);
    const sb = shapeSegments(b, proj);
    for (const [p1, p2] of sa) {
      for (const [q1, q2] of sb) {
        const d = distSegmentSegmentXY(p1, p2, q1, q2);
        if (d < core) core = d;
        if (core === 0) break;
      }
      if (core === 0) break;
    }
  }
  return core - ra - rb;
}

/**
 * `shapeDistanceM` of points (radius 0) from one shape, prepared once for testing many points:
 * the shape is projected a single time, and a point more than `beyondM` from the shape returns
 * `Infinity` (or another value above `beyondM`) after a bounding-box test.
 *
 * Shapes with many edges (large polygons, long corridors) are indexed in bands across their
 * longer side: a point is tested against the edges of its band only – all edges a ray along the
 * band can cross, and all edges within `beyondM` of it – so the result is the same as testing
 * every edge.
 */
export function pointShapeDistance(shape: Shape, beyondM = Infinity): (p: LatLon) => number {
  if (!isValidShape(shape)) return () => Infinity;
  const proj = new LocalProjection(shapeRef(shape));
  const r = shapeRadius(shape);
  const segs = shapeSegments(shape, proj);
  const ring = shape.kind === 'polygon' ? shapeVertices(shape, proj) : null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of shapeVertices(shape, proj)) {
    minX = Math.min(minX, v.x);
    minY = Math.min(minY, v.y);
    maxX = Math.max(maxX, v.x);
    maxY = Math.max(maxY, v.y);
  }
  const pad = r + Math.max(0, beyondM) + 1;
  const outsideBox = (q: XY) => q.x < minX - pad || q.x > maxX + pad || q.y < minY - pad || q.y > maxY + pad;
  const index = Number.isFinite(pad) && segs.length > 24 ? bandIndex(segs, { minX, minY, maxX, maxY }, pad) : null;
  if (!index) {
    return (p) => {
      const q = proj.toXY(p);
      if (outsideBox(q)) return Infinity;
      if (ring && pointInPolygonXY(q, ring)) return -r;
      let core = Infinity;
      for (const [a, b] of segs) {
        const d = distPointSegmentXY(q, a, b);
        if (d < core) core = d;
      }
      return core - r;
    };
  }
  // In the index's frame (x and y swapped when the shape is wider than tall: bands then run
  // north–south and the ray of the inside test goes north – the parity is the same).
  const { swap, edges, at } = index;
  const lo = edges.map(([a, b]) => Math.min(a.x, b.x));
  const hi = edges.map(([a, b]) => Math.max(a.x, b.x));
  return (p) => {
    const q0 = proj.toXY(p);
    if (outsideBox(q0)) return Infinity;
    const q = swap ? { x: q0.y, y: q0.x } : q0;
    const list = at(q.y);
    let core = Infinity;
    for (const k of list) {
      if (lo[k]! - q.x > pad || q.x - hi[k]! > pad) continue;
      const [a, b] = edges[k]!;
      const d = distPointSegmentXY(q, a, b);
      if (d < core) core = d;
    }
    if (ring) {
      // As pointInPolygonXY: on the boundary counts as inside, then the crossing number.
      if (core < 1e-6) return -r;
      let inside = false;
      for (const k of list) {
        const [b, a] = edges[k]!;
        if (a.y > q.y !== b.y > q.y && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
      if (inside) return -r;
    }
    return core - r;
  };
}

/** Most entries of a band index (beyond, the bands get wider). */
const BAND_ENTRIES_MAX = 2_000_000;

/**
 * Edges listed by the bands their extent across the bands (widened by `pad`) overlaps: every
 * edge that crosses a band's line, or comes within `pad` of a point, is in the point's band.
 * Bands run across the shape's longer side and are at least `pad / 2` wide, so an edge is listed
 * in a few bands only – also for long corridors with a wide buffer.
 */
function bandIndex(segs: [XY, XY][], box: { minX: number; minY: number; maxX: number; maxY: number }, pad: number): { swap: boolean; edges: [XY, XY][]; at(y: number): number[] } {
  const swap = box.maxX - box.minX > box.maxY - box.minY;
  const edges: [XY, XY][] = swap ? segs.map(([a, b]) => [{ x: a.y, y: a.x }, { x: b.y, y: b.x }]) : segs;
  const y0 = (swap ? box.minX : box.minY) - pad;
  const y1 = (swap ? box.maxX : box.maxY) + pad;
  const extent = Math.max(y1 - y0, 1e-6);
  let span = 0;
  for (const [a, b] of edges) span += Math.abs(a.y - b.y);
  // Wide enough that the entries stay bounded: (span + 2·pad·edges) / h + edges.
  const h = Math.max(extent / 1024, pad / 2, (span + 2 * pad * edges.length) / BAND_ENTRIES_MAX, 1e-6);
  const n = Math.max(1, Math.min(1024, Math.ceil(extent / h)));
  const bands: number[][] = Array.from({ length: n }, () => []);
  const band = (y: number) => Math.min(n - 1, Math.max(0, Math.floor((y - y0) / h)));
  for (let k = 0; k < edges.length; k++) {
    const [a, b] = edges[k]!;
    const from = band(Math.min(a.y, b.y) - pad);
    const to = band(Math.max(a.y, b.y) + pad);
    for (let i = from; i <= to; i++) bands[i]!.push(k);
  }
  return { swap, edges, at: (y) => bands[band(y)]! };
}

/**
 * Whether a shape (with its radius and `padM` more) can reach into a latitude/longitude box – a
 * cheap test before checking many points against the shape. Close to the antimeridian it says yes.
 */
export function shapeNearBox(shape: Shape, box: BBox, padM = 0): boolean {
  if (!isValidShape(shape)) return false;
  const pts = shape.kind === 'point' ? [shape.point] : shape.kind === 'line' ? shape.line : shape.polygon;
  const b = bboxOf(pts)!;
  if (Math.max(Math.abs(b.minLon), Math.abs(b.maxLon), Math.abs(box.minLon), Math.abs(box.maxLon)) > 179) return true;
  const m = shapeRadius(shape) + Math.max(0, padM) + 1;
  const dLat = m / 111_000;
  const dLon = m / (111_000 * Math.max(0.01, Math.cos(toRad(Math.min(89, Math.max(Math.abs(b.minLat), Math.abs(b.maxLat)) + dLat)))));
  return b.minLat - dLat <= box.maxLat && b.maxLat + dLat >= box.minLat && b.minLon - dLon <= box.maxLon && b.maxLon + dLon >= box.minLon;
}

export function shapesOverlap(a: Shape, b: Shape): boolean {
  return shapeDistanceM(a, b) <= 0;
}

/** Approximates a circle as a polygon (for rendering and polygon checks). */
export function circlePolygon(center: LatLon, radiusM: number, segments = 48): LatLon[] {
  const out: LatLon[] = [];
  for (let i = 0; i < segments; i++) out.push(destinationPoint(center, (360 * i) / segments, radiusM));
  return out;
}

/**
 * Buffers a polyline into a polygon outline (miter joins, round caps).
 * Intended for display of corridors and hazard buffers.
 */
export function bufferPolyline(line: LatLon[], radiusM: number, capSegments = 8): LatLon[] {
  if (line.length === 0) return [];
  if (line.length === 1) return circlePolygon(line[0]!, radiusM, capSegments * 4);
  const proj = new LocalProjection(line[0]!);
  const pts = line.map((p) => proj.toXY(p));
  const normals: XY[] = [];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i]!.x - pts[i - 1]!.x;
    const dy = pts[i]!.y - pts[i - 1]!.y;
    const len = Math.hypot(dx, dy) || 1;
    normals.push({ x: -dy / len, y: dx / len });
  }
  const offset = (side: 1 | -1): XY[] => {
    const res: XY[] = [];
    for (let i = 0; i < pts.length; i++) {
      let nx: number;
      let ny: number;
      if (i === 0) ({ x: nx, y: ny } = normals[0]!);
      else if (i === pts.length - 1) ({ x: nx, y: ny } = normals[normals.length - 1]!);
      else {
        const n1 = normals[i - 1]!;
        const n2 = normals[i]!;
        const mx = n1.x + n2.x;
        const my = n1.y + n2.y;
        const ml = Math.hypot(mx, my) || 1;
        const cos = (n1.x * n2.x + n1.y * n2.y + 1) / 2; // cos^2 of half angle
        const scale = Math.min(2, 1 / Math.sqrt(Math.max(cos, 0.25)));
        nx = (mx / ml) * scale;
        ny = (my / ml) * scale;
      }
      res.push({ x: pts[i]!.x + side * nx * radiusM, y: pts[i]!.y + side * ny * radiusM });
    }
    return res;
  };
  const left = offset(1);
  const right = offset(-1).reverse();
  const cap = (center: XY, from: XY): XY[] => {
    const a0 = Math.atan2(from.y - center.y, from.x - center.x);
    const res: XY[] = [];
    for (let k = 1; k < capSegments; k++) {
      const a = a0 - (Math.PI * k) / capSegments;
      res.push({ x: center.x + Math.cos(a) * radiusM, y: center.y + Math.sin(a) * radiusM });
    }
    return res;
  };
  const endCap = cap(pts[pts.length - 1]!, left[left.length - 1]!);
  const startCap = cap(pts[0]!, right[right.length - 1]!);
  return [...left, ...endCap, ...right, ...startCap].map((p) => proj.toLatLon(p.x, p.y));
}
