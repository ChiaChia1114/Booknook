/**
 * Distances from one shape – a volume being checked: a mission's corridor, an authorisation's
 * cylinder or corridor – to many others (zones, reservations). The volume is projected and its
 * segments indexed once, so each other shape costs the segments near it rather than all of them;
 * and the work is done in steps (see `runSliced`): a long corridor among many large zones never
 * holds the event loop.
 *
 * The answer is `shapeDistanceM(volume, other)` – the same projection, the same arithmetic, the same
 * pairs of segments that decide it – whenever that is at most the limit asked for; above the limit
 * the answer is only known to be above it.
 */
import type { LatLon, Shape, XY } from '@athena-sky/shared';
import { LocalProjection, distSegmentSegmentXY, isValidLatLon, pointInPolygonXY } from '@athena-sky/shared';
import type { Steps } from '../lib/slice';

/** About this many segment pairs (or edges of inside tests) are measured between two steps. */
const WORK_PER_STEP = 1024;
/** Most entries of a volume's segment grid (beyond, its cells get larger). */
const GRID_ENTRIES_MAX = 200_000;
/** Points this close to a box (metres) may still count as on its shape's boundary. */
const EDGE_M = 0.01;

function valid(s: Shape): boolean {
  if (s.kind === 'point') return isValidLatLon(s.point);
  if (s.kind === 'line') return s.line.length >= 1 && s.line.every(isValidLatLon);
  return s.polygon.length >= 3 && s.polygon.every(isValidLatLon);
}

const radiusOf = (s: Shape): number => (s.kind === 'polygon' ? (s.radiusM ?? 0) : s.radiusM);
const pointsOf = (s: Shape): LatLon[] => (s.kind === 'point' ? [s.point] : s.kind === 'line' ? s.line : s.polygon);

/** The segments of a shape's projected vertices, as `shapeDistanceM` takes them. */
function segmentsOf(kind: Shape['kind'], v: XY[]): [XY[], XY[]] {
  const from: XY[] = [];
  const to: XY[] = [];
  if (kind === 'polygon') {
    for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
      from.push(v[j]!);
      to.push(v[i]!);
    }
  } else if (v.length === 1) {
    from.push(v[0]!);
    to.push(v[0]!);
  } else {
    for (let i = 1; i < v.length; i++) {
      from.push(v[i - 1]!);
      to.push(v[i]!);
    }
  }
  return [from, to];
}

export class PreparedVolume {
  readonly ok: boolean;
  readonly proj: LocalProjection;
  readonly r: number;
  /** The volume's ring, when it is a polygon. */
  ring: XY[] | null = null;
  private from: XY[] = [];
  private to: XY[] = [];
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;
  /** Segments listed by the grid cells their boxes overlap. */
  private cells: number[][] = [];
  private n = 1;
  private size = 1;
  /** Marks of the segments already listed by a query. */
  private seen = new Uint32Array(0);
  private mark = 0;
  /** Work done since the last step (counted across shapes: many small ones are measured in steps too). */
  private work = 0;
  private prepared = false;

  constructor(readonly shape: Shape) {
    this.ok = valid(shape);
    // As shapeDistanceM: projected around the volume's first point.
    this.proj = new LocalProjection(this.ok ? pointsOf(shape)[0]! : { lat: 0, lon: 0 });
    this.r = radiusOf(shape);
  }

  /** Counts work; true when a step's worth is done (the caller yields). */
  private worked(units: number): boolean {
    this.work += units;
    if (this.work < WORK_PER_STEP) return false;
    this.work = 0;
    return true;
  }

  /** Projects the volume and indexes its segments – in steps (done once, before the first distance). */
  *prepareSteps(): Steps<void> {
    if (this.prepared) return;
    const pts = this.ok ? pointsOf(this.shape) : [{ lat: 0, lon: 0 }];
    const v: XY[] = [];
    for (const p of pts) {
      v.push(this.proj.toXY(p));
      if (this.worked(1)) yield;
    }
    this.ring = this.shape.kind === 'polygon' ? v : null;
    [this.from, this.to] = segmentsOf(this.shape.kind, v);
    for (const p of v) {
      this.minX = Math.min(this.minX, p.x);
      this.minY = Math.min(this.minY, p.y);
      this.maxX = Math.max(this.maxX, p.x);
      this.maxY = Math.max(this.maxY, p.y);
    }
    if (this.worked(v.length)) yield;
    // A grid of at most 256 × 256 cells – coarser while the segments would be listed too often.
    const extent = Math.max(this.maxX - this.minX, this.maxY - this.minY, 1e-6);
    let n = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(this.from.length) * 2)));
    for (;;) {
      const size = extent / n;
      let entries = 0;
      for (let k = 0; k < this.from.length; k++) {
        const [x0, x1, y0, y1] = this.cellRange(k, size, n);
        entries += (x1 - x0 + 1) * (y1 - y0 + 1);
        if (this.worked(1)) yield;
      }
      if (entries <= GRID_ENTRIES_MAX || n === 1) {
        this.n = n;
        this.size = size;
        break;
      }
      n = Math.max(1, Math.floor(n / 2));
    }
    this.cells = [];
    for (let i = 0; i < this.n * this.n; i++) {
      this.cells.push([]);
      if (this.worked(1)) yield;
    }
    for (let k = 0; k < this.from.length; k++) {
      const [x0, x1, y0, y1] = this.cellRange(k, this.size, this.n);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.cells[y * this.n + x]!.push(k);
      if (this.worked((x1 - x0 + 1) * (y1 - y0 + 1))) yield;
    }
    this.seen = new Uint32Array(this.from.length);
    this.prepared = true;
  }

  private cellRange(k: number, size: number, n: number): [number, number, number, number] {
    const a = this.from[k]!;
    const b = this.to[k]!;
    return [this.cellOf(Math.min(a.x, b.x) - this.minX, size, n), this.cellOf(Math.max(a.x, b.x) - this.minX, size, n), this.cellOf(Math.min(a.y, b.y) - this.minY, size, n), this.cellOf(Math.max(a.y, b.y) - this.minY, size, n)];
  }

  private cellOf(d: number, size: number, n: number): number {
    return Math.min(n - 1, Math.max(0, Math.floor(d / size)));
  }

  /** The segments whose boxes overlap a box (each once), or every segment for an unbounded box. */
  candidates(minX: number, minY: number, maxX: number, maxY: number): number[] {
    if (!(Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY))) return this.from.map((_, k) => k);
    if (minX > this.maxX || maxX < this.minX || minY > this.maxY || maxY < this.minY) return [];
    const out: number[] = [];
    this.mark = (this.mark + 1) >>> 0;
    if (this.mark === 0) {
      this.seen.fill(0);
      this.mark = 1;
    }
    const x0 = this.cellOf(minX - this.minX, this.size, this.n);
    const x1 = this.cellOf(maxX - this.minX, this.size, this.n);
    const y0 = this.cellOf(minY - this.minY, this.size, this.n);
    const y1 = this.cellOf(maxY - this.minY, this.size, this.n);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        for (const k of this.cells[y * this.n + x]!) {
          if (this.seen[k] === this.mark) continue;
          this.seen[k] = this.mark;
          const a = this.from[k]!;
          const b = this.to[k]!;
          if (Math.max(a.x, b.x) < minX || Math.min(a.x, b.x) > maxX || Math.max(a.y, b.y) < minY || Math.min(a.y, b.y) > maxY) continue;
          out.push(k);
        }
      }
    }
    return out;
  }

  /**
   * `shapeDistanceM(volume, other)` when it is at most `limit` (metres); otherwise some value above
   * `limit`. In steps: the work between two is bounded.
   */
  *distanceSteps(other: Shape, limit: number): Steps<number> {
    if (!this.ok || !valid(other)) return Infinity;
    yield* this.prepareSteps();
    const rb = radiusOf(other);
    // Segments farther apart than this cannot decide an answer within the limit.
    const margin = limit + this.r + rb;
    const v = pointsOf(other).map((p) => this.proj.toXY(p));
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of v) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    // Projecting the other's points is work too.
    if (this.worked(v.length)) yield;
    if (minX - margin > this.maxX || maxX + margin < this.minX || minY - margin > this.maxY || maxY + margin < this.minY) return Infinity;
    let core = Infinity;
    // A vertex of the other shape inside the volume's polygon (only those in the volume's box can be).
    if (this.ring) {
      for (const p of v) {
        if (p.x < this.minX - EDGE_M || p.x > this.maxX + EDGE_M || p.y < this.minY - EDGE_M || p.y > this.maxY + EDGE_M) continue;
        if (pointInPolygonXY(p, this.ring)) {
          core = 0;
          break;
        }
        if (this.worked(this.ring.length)) yield;
      }
    }
    // A vertex of the volume inside the other's polygon: an end of a segment in the polygon's box.
    if (core > 0 && other.kind === 'polygon') {
      for (const k of this.candidates(minX - EDGE_M, minY - EDGE_M, maxX + EDGE_M, maxY + EDGE_M)) {
        for (const p of [this.from[k]!, this.to[k]!]) {
          if (p.x < minX - EDGE_M || p.x > maxX + EDGE_M || p.y < minY - EDGE_M || p.y > maxY + EDGE_M) continue;
          if (pointInPolygonXY(p, v)) {
            core = 0;
            break;
          }
          if (this.worked(v.length)) yield;
        }
        if (core === 0) break;
      }
    }
    if (core > 0) {
      // Pairs of segments: for each of the other's, the volume's within reach of it – the nearer the
      // closest pair found so far, the fewer.
      const [from, to] = segmentsOf(other.kind, v);
      for (let i = 0; i < from.length && core > 0; i++) {
        const q1 = from[i]!;
        const q2 = to[i]!;
        const g = Math.min(margin, core);
        for (const k of this.candidates(Math.min(q1.x, q2.x) - g, Math.min(q1.y, q2.y) - g, Math.max(q1.x, q2.x) + g, Math.max(q1.y, q2.y) + g)) {
          const d = distSegmentSegmentXY(this.from[k]!, this.to[k]!, q1, q2);
          if (d < core) core = d;
          if (core === 0) break;
          if (this.worked(1)) yield;
        }
        if (this.worked(1)) yield;
      }
    }
    return core - this.r - rb;
  }
}
