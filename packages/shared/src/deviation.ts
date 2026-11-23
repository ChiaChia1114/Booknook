/**
 * Route-deviation analytics: how far the flown track stayed from the planned route
 * (cross-track error) and from the planned altitude.
 */
import { LocalProjection, type LatLon, type LatLonAlt, type XY } from './geo';

export interface TrackPoint extends LatLon {
  t: number;
  altRel: number;
}

export interface RouteDeviation {
  /** Samples compared (airborne samples after reaching the route). */
  samples: number;
  meanM: number;
  rmsM: number;
  p95M: number;
  maxM: number;
  /** Share of the compared time spent farther than the tolerance (%). */
  outsidePct: number;
  toleranceM: number;
  /**
   * Largest altitude difference to the planned altitude at the closest route point (m), en
   * route: from leaving the start of the route to arriving at its end.
   */
  maxAltDevM: number;
  /** Where that largest altitude difference was. */
  worstAlt: { t: number; lat: number; lon: number; deviationM: number } | null;
  worst: { t: number; lat: number; lon: number; distanceM: number } | null;
  /** Fraction of the planned route length that was flown within tolerance (coverage, %). */
  coveragePct: number;
}

interface Seg {
  a: XY;
  b: XY;
  altA: number;
  altB: number;
  len: number;
}

/**
 * Compares a flown track with the planned 3D path (e.g. `missionPath(plan)`).
 * Only airborne samples (≥ `minAltM` above home) are compared.
 */
export function routeDeviation(
  planned: LatLonAlt[],
  track: TrackPoint[],
  toleranceM = 10,
  minAltM = 2,
  opts: RouteDeviationOptions = {},
): RouteDeviation | null {
  const steps = routeDeviationSteps(planned, track, toleranceM, minAltM, opts);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

export interface RouteDeviationOptions {
  /** Trailing segments of the path not checked for altitude (an automatic return home flies at its own altitude). */
  altSkipLastSegments?: number;
}

/** `routeDeviation` in steps: yields every few samples, so a server can run it in slices. */
export function* routeDeviationSteps(
  planned: LatLonAlt[],
  track: TrackPoint[],
  toleranceM = 10,
  minAltM = 2,
  opts: RouteDeviationOptions = {},
): Generator<void, RouteDeviation | null, void> {
  // Vertical segments (take-off, landing, a climb in place before the return) become one
  // vertex with the altitude on arrival, on departure and the range flown there.
  const path: (LatLonAlt & { altIn: number; altOut: number; altMin: number; altMax: number })[] = [];
  for (const p of planned) {
    const last = path[path.length - 1];
    if (last && last.lat === p.lat && last.lon === p.lon) {
      last.altOut = p.alt;
      last.altMin = Math.min(last.altMin, p.alt);
      last.altMax = Math.max(last.altMax, p.alt);
    } else path.push({ ...p, altIn: p.alt, altOut: p.alt, altMin: p.alt, altMax: p.alt });
  }
  if (path.length < 2) return null;
  const proj = new LocalProjection(path[0]!);
  const xy = path.map((p) => proj.toXY(p));
  const segs: Seg[] = [];
  for (let i = 0; i + 1 < xy.length; i++) {
    segs.push({ a: xy[i]!, b: xy[i + 1]!, altA: path[i]!.altOut, altB: path[i + 1]!.altIn, len: Math.hypot(xy[i + 1]!.x - xy[i]!.x, xy[i + 1]!.y - xy[i]!.y) });
  }
  const vertical = path.map((v, i) => ({ xy: xy[i]!, min: v.altMin, max: v.altMax })).filter((v) => v.max - v.min > 0.5);
  const air = track.filter((s) => s.altRel >= minAltM);
  if (air.length === 0) return null;
  const dists: number[] = [];
  let outsideTime = 0;
  let totalTime = 0;
  // Altitude deviation en route only: not before the drone leaves the start of the route (a
  // climb there, also a manual one before the mission is started) and not after it arrives at
  // the end (hovering and descending there, a manual landing). An altitude error that lasts to
  // the end of the route – or from its start – is still an error.
  const startXY = xy[0]!;
  const endXY = xy[xy.length - 1]!;
  const routeLen = segs.reduce((acc, g) => acc + g.len, 0);
  let departed = false;
  let arrived = false;
  let maxAltDev = 0;
  let worstAlt: RouteDeviation['worstAlt'] = null;
  let worst: RouteDeviation['worst'] = null;
  // Route coverage: mark the 5 m bins of each segment flown within tolerance (between
  // consecutive in-tolerance samples on the same or adjacent segments).
  const bins = segs.map((s) => new Uint8Array(Math.max(1, Math.ceil(s.len / 5))));
  const mark = (seg: number, f0: number, f1: number) => {
    const b = bins[seg]!;
    const lo = Math.max(0, Math.floor(Math.min(f0, f1) * b.length));
    const hi = Math.min(b.length - 1, Math.floor(Math.max(f0, f1) * b.length));
    for (let k = lo; k <= hi; k++) b[k] = 1;
  };
  // Distance along the route at the start of every segment.
  const startAlong: number[] = [];
  segs.reduce((acc, g, k) => ((startAlong[k] = acc), acc + g.len), 0);
  let prevAlong = 0;
  let lastIn: { seg: number; f: number } | null = null;
  // Every sample is compared with every segment: their geometry in flat arrays, and the distance
  // and position along each segment (0–1) of the sample in hand.
  const m = segs.length;
  const AX = new Float64Array(m);
  const AY = new Float64Array(m);
  const DX = new Float64Array(m);
  const DY = new Float64Array(m);
  const L2 = new Float64Array(m);
  const LEN = new Float64Array(m);
  const ALONG = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const g = segs[k]!;
    AX[k] = g.a.x;
    AY[k] = g.a.y;
    DX[k] = g.b.x - g.a.x;
    DY[k] = g.b.y - g.a.y;
    L2[k] = DX[k]! * DX[k]! + DY[k]! * DY[k]!;
    LEN[k] = g.len;
    ALONG[k] = startAlong[k]!;
  }
  const D = new Float64Array(m);
  const F = new Float64Array(m);
  const G = new Float64Array(m);
  for (let i = 0; i < air.length; i++) {
    if ((i & 7) === 7) yield;
    const s = air[i]!;
    const p = proj.toXY(s);
    let minD = Infinity;
    let seg = -1;
    for (let k = 0; k < m; k++) {
      const dot = (p.x - AX[k]!) * DX[k]! + (p.y - AY[k]!) * DY[k]!;
      const len = LEN[k]!;
      F[k] = len > 0 ? Math.max(0, Math.min(1, dot / (len * len))) : 0;
      const l2 = L2[k]!;
      const t = l2 === 0 ? 0 : Math.min(1, Math.max(0, dot / l2));
      const d = Math.hypot(p.x - (AX[k]! + t * DX[k]!), p.y - (AY[k]! + t * DY[k]!));
      D[k] = d;
      if (d < minD) {
        minD = d;
        seg = k;
      }
    }
    // Where on the route the drone is: among the nearly closest segments, the one nearest to the
    // progress so far (not more than 10 m behind it) – an out-and-back route is matched to its
    // return leg on the way back, not to the outbound leg it overlaps. Where both are as near (at
    // a waypoint, at the turn of an out-and-back leg) the drone is on the next one.
    let nearest = Infinity;
    for (let k = 0; k < m; k++) {
      let g = Infinity;
      if (D[k]! <= minD + 3) {
        const along = ALONG[k]! + F[k]! * LEN[k]!;
        if (along >= prevAlong - 10) g = Math.abs(along - prevAlong);
      }
      G[k] = g;
      if (g < nearest) nearest = g;
    }
    if (Number.isFinite(nearest)) {
      for (let k = m - 1; k >= 0; k--) {
        if (G[k]! <= nearest + 1) {
          seg = k;
          break;
        }
      }
    }
    const c = { d: minD, seg, f: F[seg]! };
    prevAlong = Math.max(prevAlong, startAlong[seg]! + c.f * segs[seg]!.len);
    dists.push(c.d);
    const sg = segs[c.seg]!;
    const plannedAlt = sg.altA + (sg.altB - sg.altA) * c.f;
    if (Math.hypot(p.x - startXY.x, p.y - startXY.y) > toleranceM) departed = true;
    // Samples on the skipped trailing segments get no altitude deviation.
    const checked = departed && !arrived && c.seg < segs.length - (opts.altSkipLastSegments ?? 0);
    if (departed && prevAlong >= routeLen - toleranceM && Math.hypot(p.x - endXY.x, p.y - endXY.y) <= toleranceM) arrived = true; // this sample still counts
    if (checked) {
      // At a vertical segment (take-off, landing, a climb in place) any altitude of the range flown there is on plan.
      let dev = Math.abs(s.altRel - plannedAlt);
      for (const v of vertical) {
        if (Math.hypot(p.x - v.xy.x, p.y - v.xy.y) <= toleranceM) dev = Math.min(dev, Math.max(0, v.min - s.altRel, s.altRel - v.max));
      }
      if (dev > maxAltDev) {
        maxAltDev = dev;
        worstAlt = { t: s.t, lat: s.lat, lon: s.lon, deviationM: Math.round(dev * 10) / 10 };
      }
    }
    const dt = i + 1 < air.length ? Math.min(10_000, air[i + 1]!.t - s.t) : 0;
    totalTime += dt;
    if (c.d > toleranceM) {
      outsideTime += dt;
      lastIn = null;
    } else {
      if (lastIn && lastIn.seg === c.seg) mark(c.seg, lastIn.f, c.f);
      else if (lastIn && lastIn.seg + 1 === c.seg) {
        mark(lastIn.seg, lastIn.f, 1);
        mark(c.seg, 0, c.f);
      } else mark(c.seg, c.f, c.f);
      lastIn = { seg: c.seg, f: c.f };
    }
    if (!worst || c.d > worst.distanceM) worst = { t: s.t, lat: s.lat, lon: s.lon, distanceM: Math.round(c.d * 10) / 10 };
  }
  yield;
  const sorted = Float64Array.from(dists).sort();
  const mean = dists.reduce((a, b) => a + b, 0) / dists.length;
  const rms = Math.sqrt(dists.reduce((a, b) => a + b * b, 0) / dists.length);
  const covered = bins.reduce((s, b, i) => s + (b.reduce((x, v) => x + v, 0) / b.length) * segs[i]!.len, 0);
  const totalLen = segs.reduce((s, g) => s + g.len, 0);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    samples: dists.length,
    meanM: r1(mean),
    rmsM: r1(rms),
    p95M: r1(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!),
    maxM: r1(sorted[sorted.length - 1]!),
    outsidePct: totalTime > 0 ? r1((outsideTime / totalTime) * 100) : 0,
    toleranceM,
    maxAltDevM: r1(maxAltDev),
    worstAlt,
    worst,
    coveragePct: totalLen > 0 ? r1((covered / totalLen) * 100) : 0,
  };
}
