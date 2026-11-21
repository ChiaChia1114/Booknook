/**
 * Route-deviation analytics: how far the flown track stayed from the planned route
 * (cross-track error) and from the planned altitude.
 */
import { LocalProjection, distPointSegmentXY, type LatLon, type LatLonAlt, type XY } from './geo';

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
  /** Largest altitude difference to the planned altitude at the closest route point (m). */
  maxAltDevM: number;
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

/** Distance of a point to every segment and its position along it (0–1). */
function distances(p: XY, segs: Seg[]): { d: number; f: number }[] {
  return segs.map((s) => {
    const dx = s.b.x - s.a.x;
    const dy = s.b.y - s.a.y;
    const f = s.len > 0 ? Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / (s.len * s.len))) : 0;
    return { d: distPointSegmentXY(p, s.a, s.b), f };
  });
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
  opts: {
    /** Trailing segments of the path not checked for altitude (an automatic return home flies at its own altitude). */
    altSkipLastSegments?: number;
  } = {},
): RouteDeviation | null {
  // Collapse vertical segments (take-off, landing) to one point at cruise altitude.
  const path: LatLonAlt[] = [];
  for (const p of planned) {
    const last = path[path.length - 1];
    if (last && last.lat === p.lat && last.lon === p.lon) last.alt = Math.max(last.alt, p.alt);
    else path.push({ ...p });
  }
  if (path.length < 2) return null;
  const proj = new LocalProjection(path[0]!);
  const xy = path.map((p) => proj.toXY(p));
  const segs: Seg[] = [];
  for (let i = 0; i + 1 < xy.length; i++) {
    segs.push({ a: xy[i]!, b: xy[i + 1]!, altA: path[i]!.alt, altB: path[i + 1]!.alt, len: Math.hypot(xy[i + 1]!.x - xy[i]!.x, xy[i + 1]!.y - xy[i]!.y) });
  }
  const air = track.filter((s) => s.altRel >= minAltM);
  if (air.length === 0) return null;
  const dists: number[] = [];
  let outsideTime = 0;
  let totalTime = 0;
  const altDevs: number[] = [];
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
  for (let i = 0; i < air.length; i++) {
    const s = air[i]!;
    const p = proj.toXY(s);
    const all = distances(p, segs);
    const minD = Math.min(...all.map((x) => x.d));
    // Where on the route the drone is: among the nearly closest segments, the first one at or
    // beyond the progress so far – an out-and-back route is matched to its return leg on the
    // way back, not to the outbound leg it overlaps.
    let seg = all.findIndex((x) => x.d === minD);
    let best = Infinity;
    all.forEach((x, k) => {
      if (x.d > minD + 3) return;
      const along = startAlong[k]! + x.f * segs[k]!.len;
      if (along >= prevAlong - 10 && along < best) {
        best = along;
        seg = k;
      }
    });
    const c = { d: minD, seg, f: all[seg]!.f };
    prevAlong = Math.max(prevAlong, startAlong[seg]! + c.f * segs[seg]!.len);
    dists.push(c.d);
    const sg = segs[c.seg]!;
    const plannedAlt = sg.altA + (sg.altB - sg.altA) * c.f;
    // Samples on the skipped trailing segments get no altitude deviation (NaN).
    altDevs.push(c.seg < segs.length - (opts.altSkipLastSegments ?? 0) ? Math.abs(s.altRel - plannedAlt) : NaN);
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
  // Altitude deviation en route only: from the first sample at the planned altitude (within
  // 5 m, i.e. after the take-off climb) to the last one (before the final descent).
  const firstAt = altDevs.findIndex((d) => d <= 5);
  let lastAt = -1;
  for (let i = altDevs.length - 1; i >= 0; i--) {
    if (altDevs[i]! <= 5) {
      lastAt = i;
      break;
    }
  }
  const enRoute = firstAt >= 0 ? altDevs.slice(firstAt, lastAt + 1) : altDevs;
  const maxAltDev = enRoute.reduce((m, d) => (Number.isFinite(d) ? Math.max(m, d) : m), 0);
  const sorted = [...dists].sort((a, b) => a - b);
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
    worst,
    coveragePct: totalLen > 0 ? r1((covered / totalLen) * 100) : 0,
  };
}
