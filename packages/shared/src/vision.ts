/**
 * Computer vision core shared by the cloud (live detection on video frames), the tools that
 * train the detector and the tests: frame preprocessing, a small CenterNet-style convolutional
 * detector (inference), detection decoding, a multi-object tracker with class voting, dominant
 * colour recognition and ground geolocation of detections from the camera model.
 */
import { destinationPoint, haversineDistance, initialBearing, type LatLon } from './geo';

// ---------------------------------------------------------------------------------------
// Preprocessing
// ---------------------------------------------------------------------------------------

/** Model input size (width × height) and output stride. */
export const DETECTOR_INPUT = { width: 320, height: 180, stride: 4 } as const;
export const DETECTOR_CLASSES = ['person', 'vehicle'] as const;
export type DetectorClass = (typeof DETECTOR_CLASSES)[number];

/**
 * Downscales an RGBA (or RGB) image to `dw` × `dh` RGB by area averaging (box filter over the
 * source pixels each target pixel covers). Identical for training data and live frames.
 */
export function downscaleToRgb(src: Uint8Array | Uint8ClampedArray, sw: number, sh: number, channels: 3 | 4, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh * 3);
  const fx = sw / dw;
  const fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * sw + x0) * channels;
        for (let xx = x0; xx < x1; xx++) {
          r += src[i]!;
          g += src[i + 1]!;
          b += src[i + 2]!;
          i += channels;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * dw + x) * 3;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Convolutional network (inference)
// ---------------------------------------------------------------------------------------

export interface ConvLayerSpec {
  inC: number;
  outC: number;
  k: number;
  stride: number;
  pad: number;
  dilation: number;
  relu: boolean;
  /** Weights [outC][inC][k][k] and biases, base64 float32 (little endian). */
  w: string;
  b: string;
}

export interface DetectorModelSpec {
  format: 'athena-centernet-1';
  input: { width: number; height: number };
  stride: number;
  classes: string[];
  /** Per-channel normalisation of the RGB input (value/255 - mean) / std. */
  mean: number[];
  std: number[];
  layers: ConvLayerSpec[];
  /** Training and evaluation metadata (dataset size, precision / recall on held-out frames). */
  meta?: Record<string, unknown>;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

/** Base64 → bytes (no platform APIs, so it runs in browsers, Node and tests alike). */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64_INDEX.get(clean[i]!) ?? 0;
    const b = B64_INDEX.get(clean[i + 1]!) ?? 0;
    const c = B64_INDEX.get(clean[i + 2] ?? 'A') ?? 0;
    const d = B64_INDEX.get(clean[i + 3] ?? 'A') ?? 0;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

function decodeFloats(b64: string): Float32Array {
  const bytes = base64ToBytes(b64);
  return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
}

interface ConvLayer extends Omit<ConvLayerSpec, 'w' | 'b'> {
  w: Float32Array;
  b: Float32Array;
}

/** A tensor in CHW layout. */
export interface Tensor {
  c: number;
  h: number;
  w: number;
  data: Float32Array;
}

export class ConvNet {
  private readonly layers: ConvLayer[];

  constructor(readonly spec: DetectorModelSpec) {
    this.layers = spec.layers.map((l) => {
      const w = decodeFloats(l.w);
      const b = decodeFloats(l.b);
      if (w.length !== l.outC * l.inC * l.k * l.k || b.length !== l.outC) throw new Error('detector model: weight shape mismatch');
      return { ...l, w, b };
    });
  }

  /** Runs every layer. Input: RGB bytes of the model input size (HWC). Output: CHW tensor. */
  forward(rgb: Uint8Array): Tensor {
    const { width: W, height: H } = this.spec.input;
    let x: Tensor = { c: 3, h: H, w: W, data: new Float32Array(3 * H * W) };
    for (let c = 0; c < 3; c++) {
      const m = this.spec.mean[c]!;
      const s = this.spec.std[c]!;
      for (let i = 0; i < H * W; i++) x.data[c * H * W + i] = (rgb[i * 3 + c]! / 255 - m) / s;
    }
    for (const l of this.layers) x = conv2d(x, l);
    return x;
  }
}

/** Direct convolution (cache-friendly order: output channel, kernel tap, then rows). */
export function conv2d(x: Tensor, l: Omit<ConvLayer, 'inC'> & { inC: number }): Tensor {
  const oh = Math.floor((x.h + 2 * l.pad - l.dilation * (l.k - 1) - 1) / l.stride) + 1;
  const ow = Math.floor((x.w + 2 * l.pad - l.dilation * (l.k - 1) - 1) / l.stride) + 1;
  const out = new Float32Array(l.outC * oh * ow);
  const plane = oh * ow;
  for (let oc = 0; oc < l.outC; oc++) {
    const o = out.subarray(oc * plane, (oc + 1) * plane);
    o.fill(l.b[oc]!);
    for (let ic = 0; ic < l.inC; ic++) {
      const src = x.data.subarray(ic * x.h * x.w, (ic + 1) * x.h * x.w);
      for (let ky = 0; ky < l.k; ky++) {
        for (let kx = 0; kx < l.k; kx++) {
          const wv = l.w[((oc * l.inC + ic) * l.k + ky) * l.k + kx]!;
          if (wv === 0) continue;
          const dy = ky * l.dilation - l.pad;
          const dx = kx * l.dilation - l.pad;
          for (let y = 0; y < oh; y++) {
            const sy = y * l.stride + dy;
            if (sy < 0 || sy >= x.h) continue;
            const row = sy * x.w;
            const orow = y * ow;
            // Range of output columns whose source column lies inside the image.
            const xStart = Math.max(0, Math.ceil(-dx / l.stride));
            const xEnd = Math.min(ow, Math.floor((x.w - 1 - dx) / l.stride) + 1);
            if (l.stride === 1) {
              for (let xx = xStart; xx < xEnd; xx++) o[orow + xx]! += wv * src[row + xx + dx]!;
            } else {
              for (let xx = xStart; xx < xEnd; xx++) o[orow + xx]! += wv * src[row + xx * l.stride + dx]!;
            }
          }
        }
      }
    }
    if (l.relu) for (let i = 0; i < plane; i++) if (o[i]! < 0) o[i] = 0;
  }
  return { c: l.outC, h: oh, w: ow, data: out };
}

// ---------------------------------------------------------------------------------------
// Detection decoding
// ---------------------------------------------------------------------------------------

export interface Detection {
  cls: DetectorClass;
  score: number;
  /** Box in normalised image coordinates (0..1): left, top, width, height. */
  box: [number, number, number, number];
}

const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));

/**
 * Decodes the head (channels: one heatmap per class, log width, log height, x / y offset) into
 * detections: local maxima of the heatmap (3×3) above the threshold.
 */
export function decodeDetections(out: Tensor, spec: Pick<DetectorModelSpec, 'classes' | 'stride' | 'input'>, threshold = 0.35, maxDetections = 50): Detection[] {
  const nc = spec.classes.length;
  const { h, w } = out;
  const plane = h * w;
  const d = out.data;
  const found: Detection[] = [];
  for (let c = 0; c < nc; c++) {
    const hm = d.subarray(c * plane, (c + 1) * plane);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = hm[y * w + x]!;
        if (sigmoid(v) < threshold) continue;
        let peak = true;
        for (let dy = -1; dy <= 1 && peak; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const yy = y + dy;
            const xx = x + dx;
            if (yy < 0 || xx < 0 || yy >= h || xx >= w) continue;
            if (hm[yy * w + xx]! > v) {
              peak = false;
              break;
            }
          }
        }
        if (!peak) continue;
        const i = y * w + x;
        const bw = Math.exp(d[(nc + 0) * plane + i]!) * spec.stride;
        const bh = Math.exp(d[(nc + 1) * plane + i]!) * spec.stride;
        const cx = (x + d[(nc + 2) * plane + i]!) * spec.stride;
        const cy = (y + d[(nc + 3) * plane + i]!) * spec.stride;
        const W = spec.input.width;
        const H = spec.input.height;
        found.push({ cls: spec.classes[c] as DetectorClass, score: sigmoid(v), box: [(cx - bw / 2) / W, (cy - bh / 2) / H, bw / W, bh / H] });
      }
    }
  }
  found.sort((a, b) => b.score - a.score);
  // Class-agnostic suppression of overlapping boxes (a car's cabin is not also a person).
  const kept: Detection[] = [];
  for (const det of found) {
    if (kept.some((k) => iou(k.box, det.box) > 0.5)) continue;
    kept.push(det);
    if (kept.length >= maxDetections) break;
  }
  return kept;
}

/** Intersection over union of two [left, top, width, height] boxes. */
export function iou(a: [number, number, number, number], b: [number, number, number, number]): number {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

/** Runs the detector on an RGBA frame of any size. */
export function detectObjects(net: ConvNet, rgba: Uint8Array, width: number, height: number, threshold = 0.35): Detection[] {
  const rgb = downscaleToRgb(rgba, width, height, 4, net.spec.input.width, net.spec.input.height);
  return decodeDetections(net.forward(rgb), net.spec, threshold);
}

// ---------------------------------------------------------------------------------------
// Recognition: dominant colour of a detected object
// ---------------------------------------------------------------------------------------

function toHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max > 0 ? d / max : 0, v: max / 255 };
}

/** Hue name of a saturated colour (brightness does not matter: shading keeps the hue). */
function hueName(h: number): string {
  if (h < 14 || h >= 345) return 'red';
  if (h < 38) return 'orange';
  if (h < 70) return 'yellow';
  if (h < 160) return 'green';
  if (h < 200) return 'teal';
  if (h < 255) return 'blue';
  if (h < 290) return 'purple';
  return 'pink';
}

const CHROMA_MIN_S = 0.3;
const CHROMA_MIN_V = 0.2;

/** Name of an RGB colour: hue for saturated colours, white / grey / black otherwise. */
export function colorName(rgb: [number, number, number]): string {
  const { h, s, v } = toHsv(rgb[0], rgb[1], rgb[2]);
  if (s >= CHROMA_MIN_S && v >= CHROMA_MIN_V) return hueName(h);
  return v > 0.72 ? 'white' : v < 0.3 ? 'black' : 'grey';
}

/**
 * Dominant colour of the object inside a box: hue votes of its vivid pixels (weighted by
 * saturation × brightness), or – for achromatic objects – white / grey / black from its
 * sun-lit pixels. Pixels resembling the box border (the background) are ignored.
 */
export function dominantColor(rgba: Uint8Array, width: number, height: number, box: [number, number, number, number], band: [number, number] = [0, 1]): string | null {
  const x0 = Math.max(0, Math.floor(box[0] * width));
  const yb0 = Math.max(0, Math.floor(box[1] * height));
  const x1 = Math.min(width, Math.ceil((box[0] + box[2]) * width));
  const yb1 = Math.min(height, Math.ceil((box[1] + box[3]) * height));
  if (x1 - x0 < 2 || yb1 - yb0 < 2) return null;
  // Background: mean of the box border.
  let br = 0;
  let bg = 0;
  let bb = 0;
  let bn = 0;
  const ring = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    br += rgba[i]!;
    bg += rgba[i + 1]!;
    bb += rgba[i + 2]!;
    bn++;
  };
  for (let x = x0; x < x1; x++) {
    ring(x, yb0);
    ring(x, yb1 - 1);
  }
  for (let y = yb0 + 1; y < yb1 - 1; y++) {
    ring(x0, y);
    ring(x1 - 1, y);
  }
  br /= bn;
  bg /= bn;
  bb /= bn;
  // Optional horizontal band of the box (e.g. the torso of a person: its clothing).
  const y0 = Math.max(yb0, Math.floor((box[1] + box[3] * band[0]) * height));
  const y1 = Math.min(yb1, Math.ceil((box[1] + box[3] * band[1]) * height));
  const votes = new Map<string, number>();
  const values: number[] = [];
  let chroma = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      const r = rgba[i]!;
      const g = rgba[i + 1]!;
      const b = rgba[i + 2]!;
      if (Math.abs(r - br) + Math.abs(g - bg) + Math.abs(b - bb) < 50) continue;
      total++;
      const c = toHsv(r, g, b);
      if (c.s >= CHROMA_MIN_S && c.v >= CHROMA_MIN_V) {
        const name = hueName(c.h);
        const w = c.s * c.v;
        votes.set(name, (votes.get(name) ?? 0) + w);
        chroma++;
      } else values.push(c.v);
    }
  }
  if (!total) return null;
  if (chroma >= total * 0.3 && votes.size) return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const lit = values[Math.floor(values.length * 0.8)]!;
  return lit > 0.72 ? 'white' : lit < 0.3 ? 'black' : 'grey';
}

// ---------------------------------------------------------------------------------------
// Geolocation from the camera model
// ---------------------------------------------------------------------------------------

export interface CameraState {
  lat: number;
  lon: number;
  /** Height of the camera above the ground (m). */
  heightM: number;
  /** Heading of the camera (degrees from north). */
  headingDeg: number;
  /** Gimbal pitch (degrees, negative below the horizon). */
  pitchDeg: number;
  hfovDeg: number;
  /** Image aspect ratio (width / height). */
  aspect: number;
}

/**
 * Ground position of an image point (normalised coordinates) on flat ground below the camera,
 * or null when the ray does not reach the ground.
 */
export function imagePointToGround(cam: CameraState, u: number, v: number): (LatLon & { distanceM: number }) | null {
  const yaw = (cam.headingDeg * Math.PI) / 180;
  const a = (-cam.pitchDeg * Math.PI) / 180;
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  const sa = Math.sin(a);
  const ca = Math.cos(a);
  const w = 1;
  const h = 1 / cam.aspect;
  const f = w / 2 / Math.tan(((cam.hfovDeg * Math.PI) / 180) / 2);
  const vx = (u * w - w / 2) / f;
  const vy = -(v * h - h / 2) / f;
  const de = vx * cy + vy * sa * sy + ca * sy;
  const dn = -vx * sy + vy * sa * cy + ca * cy;
  const du = vy * ca - sa;
  if (du >= -1e-6) return null;
  const t = cam.heightM / -du;
  const east = de * t;
  const north = dn * t;
  const dist = Math.hypot(east, north);
  if (dist > 5000) return null;
  const p = destinationPoint({ lat: cam.lat, lon: cam.lon }, (Math.atan2(east, north) * 180) / Math.PI, dist);
  return { ...p, distanceM: dist };
}

/**
 * Ground position of a detected object: the point where it touches the ground – the feet of a
 * person, about the middle of a vehicle's footprint (its far edge is hidden behind the body).
 */
export function objectGroundPoint(det: Pick<Detection, 'cls' | 'box'>, cam: CameraState): (LatLon & { distanceM: number }) | null {
  const v = det.box[1] + det.box[3] * (det.cls === 'person' ? 0.95 : 0.8);
  return imagePointToGround(cam, det.box[0] + det.box[2] / 2, v);
}

// ---------------------------------------------------------------------------------------
// Multi-object tracking (SORT-style: constant-velocity boxes, greedy IoU association)
// ---------------------------------------------------------------------------------------

export interface Track {
  id: number;
  cls: DetectorClass;
  score: number;
  box: [number, number, number, number];
  /** Box velocity (normalised units per second). */
  vel: [number, number];
  hits: number;
  misses: number;
  firstSeen: number;
  lastSeen: number;
  /** Class votes (recognition is stable even when single frames disagree). */
  votes: Record<string, number>;
  color: string | null;
  colorVotes: Record<string, number>;
  /** Smoothed ground position. */
  lat: number | null;
  lon: number | null;
  /** Ground velocity (m/s east / north) and when the ground position was last updated. */
  gvel: { e: number; n: number };
  groundAt: number | null;
  confirmed: boolean;
}

export interface TrackerOptions {
  /** Detections needed before a track is reported. */
  minHits?: number;
  /** Missed updates before a track is dropped. */
  maxMisses?: number;
  /** Minimum IoU (with the predicted box) to continue a track. */
  iouThreshold?: number;
  /** Ground distance (m) within which a geolocated detection continues a track, plus speed × time. */
  groundGateM?: number;
}

export class ObjectTracker {
  private tracks: Track[] = [];
  private nextId = 1;
  private lastT: number | null = null;
  private readonly minHits: number;
  private readonly maxMisses: number;
  private readonly iouThreshold: number;
  private readonly groundGateM: number;

  constructor(opts: TrackerOptions = {}) {
    this.minHits = opts.minHits ?? 2;
    this.maxMisses = opts.maxMisses ?? 4;
    this.iouThreshold = opts.iouThreshold ?? 0.2;
    this.groundGateM = opts.groundGateM ?? 4;
  }

  /** Predicted ground position of a track at time t (constant ground velocity). */
  private groundAt(tr: Track, t: number): LatLon | null {
    if (tr.lat === null || tr.lon === null) return null;
    const dt = tr.groundAt === null ? 0 : Math.min(3, Math.max(0, (t - tr.groundAt) / 1000));
    const v = Math.hypot(tr.gvel.e, tr.gvel.n);
    return v * dt > 0.05 ? destinationPoint({ lat: tr.lat, lon: tr.lon }, (Math.atan2(tr.gvel.e, tr.gvel.n) * 180) / Math.PI, v * dt) : { lat: tr.lat, lon: tr.lon };
  }

  /** Updates the tracks with one frame's detections (optionally geolocated and coloured). */
  update(t: number, dets: (Detection & { lat?: number | null; lon?: number | null; color?: string | null })[]): Track[] {
    const dt = this.lastT === null ? 0 : Math.max(0, (t - this.lastT) / 1000);
    this.lastT = t;
    const predicted = this.tracks.map((tr) => [tr.box[0] + tr.vel[0] * dt, tr.box[1] + tr.vel[1] * dt, tr.box[2], tr.box[3]] as [number, number, number, number]);
    // Greedy association by IoU, best pairs first; a centre-distance fallback for tiny boxes.
    const pairs: { ti: number; di: number; score: number }[] = [];
    this.tracks.forEach((tr, ti) => {
      const gp = this.groundAt(tr, t);
      dets.forEach((d, di) => {
        // Geolocated on both sides: match on the ground, which camera motion does not disturb.
        if (gp && d.lat !== undefined && d.lat !== null && d.lon !== undefined && d.lon !== null) {
          const since = tr.groundAt === null ? 0 : Math.min(3, (t - tr.groundAt) / 1000);
          const gate = this.groundGateM + 2.5 * since + Math.hypot(tr.gvel.e, tr.gvel.n) * since * 0.5;
          const gd = haversineDistance(gp, { lat: d.lat, lon: d.lon });
          if (gd <= gate) pairs.push({ ti, di, score: 1.5 - gd / gate + (tr.cls === d.cls ? 0.05 : 0) });
          return;
        }
        const ov = iou(predicted[ti]!, d.box);
        const pc = [predicted[ti]![0] + predicted[ti]![2] / 2, predicted[ti]![1] + predicted[ti]![3] / 2];
        const dc = [d.box[0] + d.box[2] / 2, d.box[1] + d.box[3] / 2];
        const dist = Math.hypot(pc[0]! - dc[0]!, pc[1]! - dc[1]!);
        const near = dist < Math.max(predicted[ti]![2], predicted[ti]![3], d.box[2], d.box[3]) * 1.5;
        if (ov >= this.iouThreshold || near) pairs.push({ ti, di, score: ov + (near ? 0.01 : 0) + (tr.cls === d.cls ? 0.05 : 0) });
      });
    });
    pairs.sort((a, b) => b.score - a.score);
    const usedT = new Set<number>();
    const usedD = new Set<number>();
    for (const p of pairs) {
      if (usedT.has(p.ti) || usedD.has(p.di)) continue;
      usedT.add(p.ti);
      usedD.add(p.di);
      const tr = this.tracks[p.ti]!;
      const d = dets[p.di]!;
      if (dt > 0) {
        const a = 0.5;
        tr.vel = [(1 - a) * tr.vel[0] + (a * (d.box[0] - tr.box[0])) / dt, (1 - a) * tr.vel[1] + (a * (d.box[1] - tr.box[1])) / dt];
      }
      tr.box = d.box;
      tr.score = 0.7 * tr.score + 0.3 * d.score;
      tr.hits++;
      tr.misses = 0;
      tr.lastSeen = t;
      this.observe(tr, d, t);
    }
    for (let ti = 0; ti < this.tracks.length; ti++) {
      if (usedT.has(ti)) continue;
      const tr = this.tracks[ti]!;
      tr.misses++;
      tr.box = predicted[ti]!;
    }
    dets.forEach((d, di) => {
      if (usedD.has(di)) return;
      const tr: Track = { id: this.nextId++, cls: d.cls, score: d.score, box: d.box, vel: [0, 0], hits: 1, misses: 0, firstSeen: t, lastSeen: t, votes: {}, color: null, colorVotes: {}, lat: null, lon: null, gvel: { e: 0, n: 0 }, groundAt: null, confirmed: false };
      this.observe(tr, d, t);
      this.tracks.push(tr);
    });
    this.tracks = this.tracks.filter((tr) => tr.misses <= this.maxMisses);
    for (const tr of this.tracks) if (tr.hits >= this.minHits) tr.confirmed = true;
    return this.active();
  }

  private observe(tr: Track, d: Detection & { lat?: number | null; lon?: number | null; color?: string | null }, t: number): void {
    tr.votes[d.cls] = (tr.votes[d.cls] ?? 0) + d.score;
    tr.cls = (Object.entries(tr.votes).sort((a, b) => b[1] - a[1])[0]![0] as DetectorClass) ?? d.cls;
    if (d.color) {
      tr.colorVotes[d.color] = (tr.colorVotes[d.color] ?? 0) + 1;
      tr.color = Object.entries(tr.colorVotes).sort((a, b) => b[1] - a[1])[0]![0];
    }
    if (d.lat !== undefined && d.lat !== null && d.lon !== undefined && d.lon !== null) {
      if (tr.lat === null || tr.lon === null || tr.groundAt === null) {
        tr.lat = d.lat;
        tr.lon = d.lon;
      } else {
        // α-β filter on the ground: position blends prediction and measurement, velocity follows the residual.
        const dt = Math.max(0.05, (t - tr.groundAt) / 1000);
        const pred = this.groundAt(tr, t)!;
        const r = haversineDistance(pred, { lat: d.lat, lon: d.lon });
        const b = (initialBearing(pred, { lat: d.lat, lon: d.lon }) * Math.PI) / 180;
        const re = r * Math.sin(b);
        const rn = r * Math.cos(b);
        const next = r > 0.01 ? destinationPoint(pred, (b * 180) / Math.PI, 0.5 * r) : pred;
        tr.lat = next.lat;
        tr.lon = next.lon;
        tr.gvel = { e: tr.gvel.e + (0.3 * re) / dt, n: tr.gvel.n + (0.3 * rn) / dt };
        // Walking / driving speeds only; anything faster is measurement noise.
        const v = Math.hypot(tr.gvel.e, tr.gvel.n);
        if (v > 30) tr.gvel = { e: (tr.gvel.e * 30) / v, n: (tr.gvel.n * 30) / v };
      }
      tr.groundAt = t;
    }
  }

  /** Ground velocity of a track (m/s), if known. */
  groundSpeed(id: number): number | null {
    const tr = this.get(id);
    return tr && tr.groundAt !== null ? Math.hypot(tr.gvel.e, tr.gvel.n) : null;
  }

  /** Confirmed tracks seen in the latest update (or only just missed). */
  active(): Track[] {
    return this.tracks.filter((tr) => tr.confirmed && tr.misses <= 1);
  }

  get(id: number): Track | undefined {
    return this.tracks.find((t) => t.id === id);
  }

  reset(): void {
    this.tracks = [];
    this.lastT = null;
  }
}
