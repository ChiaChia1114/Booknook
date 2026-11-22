/**
 * Synthetic gimbal camera: ray-casts the ground from the drone's position/heading – the real
 * place under it from aerial imagery when a tile source is given (else, and where no tile is
 * loaded yet, a procedural landscape of fields, roads and a river) – draws the people and
 * vehicles of the simulated world, overlays a minimal HUD and encodes the frame as JPEG.
 */
import jpeg from 'jpeg-js';
import type { Telemetry } from '@athena-sky/shared';
import type { GroundImagery } from './imagery';
import type { WorldTarget } from './world';

export interface FrameSpec {
  width: number;
  height: number;
  quality: number;
}

/** Gimbal camera of the simulated drones (declared to the cloud in the hello message: its pitch in flight). */
export const CAMERA = { hfovDeg: 78, pitchDeg: -45 } as const;

/**
 * Gimbal pitch (degrees): looking 45° down in flight; on the ground the gimbal rests near level
 * (as real gimbals do once landed), so that the video shows the surroundings – not the few metres
 * of ground under the drone. It tilts between the two in the first 3 m.
 */
export function gimbalPitchDeg(altRel: number): number {
  const k = Math.min(1, Math.max(0, altRel / 3));
  return -10 + (CAMERA.pitchDeg + 10) * k;
}

/** Pose of the synthetic camera in the world frame (metres east / north / up of the origin). */
export interface CameraPose {
  east: number;
  north: number;
  height: number;
  /** Image axes in the world frame: right, up and forward (line of sight). */
  R: [number, number, number];
  U: [number, number, number];
  F: [number, number, number];
  /** Focal length (px) and image size. */
  f: number;
  w: number;
  h: number;
}

/** Camera pose for a telemetry sample (gimbal stabilised: heading, and the gimbal pitch for the height). */
export function cameraPose(t: Pick<Telemetry, 'lat' | 'lon' | 'altRel' | 'heading'>, origin: { lat: number; lon: number }, w: number, h: number): CameraPose {
  const yaw = (t.heading * Math.PI) / 180;
  const a = (-gimbalPitchDeg(t.altRel) * Math.PI) / 180;
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  const sa = Math.sin(a);
  const ca = Math.cos(a);
  return {
    east: (t.lon - origin.lon) * 111_320 * Math.cos((origin.lat * Math.PI) / 180),
    north: (t.lat - origin.lat) * 111_320,
    height: Math.max(1.2, t.altRel + 0.3),
    R: [cy, -sy, 0],
    U: [sa * sy, sa * cy, ca],
    F: [ca * sy, ca * cy, -sa],
    f: w / 2 / Math.tan(((CAMERA.hfovDeg * Math.PI) / 180) / 2),
    w,
    h,
  };
}

/** Image position (px) of a world point, or null behind the camera. */
export function projectPoint(cam: CameraPose, east: number, north: number, up: number): { x: number; y: number; depth: number } | null {
  const d = [east - cam.east, north - cam.north, up - cam.height];
  const z = d[0]! * cam.F[0] + d[1]! * cam.F[1] + d[2]! * cam.F[2];
  if (z < 0.3) return null;
  const x = d[0]! * cam.R[0] + d[1]! * cam.R[1] + d[2]! * cam.R[2];
  const y = d[0]! * cam.U[0] + d[1]! * cam.U[1] + d[2]! * cam.U[2];
  return { x: cam.w / 2 + (cam.f * x) / z, y: cam.h / 2 - (cam.f * y) / z, depth: z };
}

/** Corners of a target's bounding box in the world frame. */
export function targetCorners(t: WorldTarget): [number, number, number][] {
  const th = (t.heading * Math.PI) / 180;
  const fx = Math.sin(th);
  const fy = Math.cos(th);
  const out: [number, number, number][] = [];
  for (const l of [-t.length / 2, t.length / 2]) for (const wd of [-t.width / 2, t.width / 2]) for (const z of [0, t.height]) out.push([t.east + l * fx + wd * fy, t.north + l * fy - wd * fx, z]);
  return out;
}

/** Bounding box (px) of a target in the image, the visible fraction of it and its distance. */
export function targetBox(cam: CameraPose, t: WorldTarget): { x0: number; y0: number; x1: number; y1: number; visible: number; depth: number } | null {
  const pts = targetCorners(t).map((c) => projectPoint(cam, c[0], c[1], c[2]));
  if (pts.some((p) => !p)) return null;
  const xs = pts.map((p) => p!.x);
  const ys = pts.map((p) => p!.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const area = Math.max(1e-6, (x1 - x0) * (y1 - y0));
  const cx0 = Math.max(0, x0);
  const cx1 = Math.min(cam.w, x1);
  const cy0 = Math.max(0, y0);
  const cy1 = Math.min(cam.h, y1);
  const vis = cx1 > cx0 && cy1 > cy0 ? ((cx1 - cx0) * (cy1 - cy0)) / area : 0;
  return { x0: cx0, y0: cy0, x1: cx1, y1: cy1, visible: vis, depth: Math.min(...pts.map((p) => p!.depth)) };
}

const SUN = (() => {
  const v = [0.45, -0.35, 0.82];
  const n = Math.hypot(v[0]!, v[1]!, v[2]!);
  return v.map((x) => x / n) as [number, number, number];
})();

interface Part {
  /** Box in the target's frame: x across (width), y along (length), z up. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
  color(z: number, face: number): [number, number, number];
}

function partsOf(t: WorldTarget): Part[] {
  if (t.kind === 'person') {
    const skin: [number, number, number] = [225, 185, 155];
    return [
      { x0: -0.25, x1: 0.25, y0: -0.17, y1: 0.17, z0: 0, z1: 1.48, color: (z) => (z < 0.8 ? [40, 42, 55] : t.color) },
      { x0: -0.12, x1: 0.12, y0: -0.12, y1: 0.12, z0: 1.48, z1: 1.75, color: () => skin },
    ];
  }
  const l = t.length / 2;
  const w = t.width / 2;
  const glass: [number, number, number] = [35, 45, 58];
  return [
    { x0: -w, x1: w, y0: -l, y1: l, z0: 0.18, z1: 0.95, color: () => t.color },
    { x0: -w * 0.88, x1: w * 0.88, y0: -l * 0.55, y1: l * 0.35, z0: 0.95, z1: t.height, color: (_z, face) => (face === 2 ? t.color : glass) },
  ];
}

/**
 * What an on-board detector sees: the people and vehicles in the camera view – mostly in frame
 * and at least a few pixels across – as normalised boxes (left, top, width, height).
 */
export function visibleObjects(cam: CameraPose, targets: WorldTarget[]): { cls: WorldTarget['kind']; score: number; box: [number, number, number, number] }[] {
  const out: { cls: WorldTarget['kind']; score: number; box: [number, number, number, number] }[] = [];
  for (const t of targets) {
    const b = targetBox(cam, t);
    if (!b || b.visible < 0.5 || b.x1 - b.x0 < 4 || b.y1 - b.y0 < 4) continue;
    out.push({ cls: t.kind, score: 0.9, box: [b.x0 / cam.w, b.y0 / cam.h, (b.x1 - b.x0) / cam.w, (b.y1 - b.y0) / cam.h] });
  }
  return out;
}

export const VIDEO_PRESETS: Record<'sd' | 'hd', FrameSpec & { fps: number }> = {
  sd: { width: 640, height: 360, quality: 60, fps: 10 },
  hd: { width: 1280, height: 720, quality: 65, fps: 6 },
};

/** 3x5 bitmap glyphs for the HUD. */
const GLYPHS: Record<string, string> = {
  '0': '111101101101111',
  '1': '010110010010111',
  '2': '111001111100111',
  '3': '111001111001111',
  '4': '101101111001001',
  '5': '111100111001111',
  '6': '111100111101111',
  '7': '111001001001001',
  '8': '111101111101111',
  '9': '111101111001111',
  '.': '000000000000010',
  '-': '000000111000000',
  ' ': '000000000000000',
  '%': '101001010100101',
  ':': '000010000010000',
  A: '010101111101101',
  B: '110101110101110',
  D: '110101101101110',
  E: '111100110100111',
  G: '111100101101111',
  H: '101101111101101',
  I: '111010010010111',
  L: '100100100100111',
  M: '101111111101101',
  N: '110101101101101',
  O: '111101101101111',
  P: '111101111100100',
  R: '110101110101101',
  S: '111100111001111',
  T: '111010010010010',
  U: '101101101101111',
  V: '101101101101010',
  W: '101101111111101',
  X: '101101010101101',
};

function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const FIELD_COLORS: [number, number, number][] = [
  [86, 125, 70],
  [110, 140, 76],
  [140, 150, 90],
  [160, 135, 95],
  [95, 115, 60],
  [125, 160, 95],
];

export class FrameRenderer {
  private readonly buf: Buffer;

  constructor(
    private readonly spec: FrameSpec,
    private readonly imagery: GroundImagery | null = null,
  ) {
    this.buf = Buffer.alloc(spec.width * spec.height * 4);
  }

  /** Renders a frame for the given telemetry. `origin` anchors the local world frame. */
  render(t: Telemetry, origin: { lat: number; lon: number }, targets: WorldTarget[] = []): Uint8Array {
    this.renderRaw(t, origin, targets);
    this.drawHud(t);
    return jpeg.encode({ data: this.buf, width: this.spec.width, height: this.spec.height }, this.spec.quality).data;
  }

  /** Renders the scene (without HUD) into the RGBA buffer and returns it. */
  renderRaw(t: Pick<Telemetry, 'lat' | 'lon' | 'altRel' | 'heading'>, origin: { lat: number; lon: number }, targets: WorldTarget[] = []): Buffer {
    const { width: w, height: h } = this.spec;
    const data = this.buf;
    const cam = cameraPose(t, origin, w, h);
    const east = cam.east;
    const north = cam.north;
    const camH = cam.height;
    const yaw = (t.heading * Math.PI) / 180;
    const alpha = (-gimbalPitchDeg(t.altRel) * Math.PI) / 180; // stabilised gimbal
    const f = cam.f;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const ca = Math.cos(alpha);
    const sa = Math.sin(alpha);
    const ground = this.imagery?.frame(origin) ?? null;
    for (let py = 0; py < h; py++) {
      const vy = -(py - h / 2) / f;
      // Camera ray (x right, y up, z forward = 1), tilted down by alpha …
      const up = vy * ca - sa;
      const forward = vy * sa + ca;
      // Every pixel of a row is at the same depth: one zoom level of imagery for the row.
      const rowZ = ground && up < -0.002 ? ground.zoomFor(camH / -up / f) : 0;
      for (let px = 0; px < w; px++) {
        const vx = (px - w / 2) / f;
        // … then rotated by the heading into east / north.
        const de = forward * sy + vx * cy;
        const dn = forward * cy - vx * sy;
        const i = (py * w + px) * 4;
        let r: number;
        let g: number;
        let b: number;
        if (up >= -0.002) {
          const k = Math.min(1, Math.max(0, up * 2.5));
          r = 170 - 90 * k;
          g = 200 - 70 * k;
          b = 235 - 20 * k;
        } else {
          const dist = camH / -up;
          const gx = east + de * dist;
          const gy = north + dn * dist;
          // The real ground (aerial imagery) where a tile is loaded.
          const real = ground ? ground.sample(gx, gy, rowZ) : -1;
          if (real >= 0) {
            const fog = Math.min(1, dist / 2500);
            data[i] = ((real >> 16) & 255) * (1 - fog) + 175 * fog;
            data[i + 1] = ((real >> 8) & 255) * (1 - fog) + 195 * fog;
            data[i + 2] = (real & 255) * (1 - fog) + 215 * fog;
            data[i + 3] = 255;
            continue;
          }
          const cell = 40;
          const cxi = Math.floor(gx / cell);
          const cyi = Math.floor(gy / cell);
          const c = FIELD_COLORS[Math.floor(hash(cxi, cyi) * FIELD_COLORS.length)]!;
          const stripes = 0.9 + 0.1 * Math.sin((gx + gy) * 0.6);
          r = c[0] * stripes;
          g = c[1] * stripes;
          b = c[2] * stripes;
          const roadX = Math.abs(((gx % 400) + 400) % 400 - 200);
          const roadY = Math.abs(((gy % 520) + 520) % 520 - 260);
          if (roadX < 4 || roadY < 4) {
            r = 120;
            g = 120;
            b = 118;
          }
          const river = Math.abs(gy - 150 * Math.sin(gx / 300) - 90);
          if (river < 12) {
            r = 70;
            g = 110;
            b = 150;
          }
          const fog = Math.min(1, dist / 2500);
          r = r * (1 - fog) + 175 * fog;
          g = g * (1 - fog) + 195 * fog;
          b = b * (1 - fog) + 215 * fog;
        }
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = 255;
      }
    }
    this.drawTargets(cam, targets);
    return data;
  }

  /** Ray-traces the people and vehicles (shaded boxes), far to near. */
  private drawTargets(cam: CameraPose, targets: WorldTarget[]): void {
    const { width: w, height: h } = this.spec;
    const visible = targets
      .map((t) => ({ t, box: targetBox(cam, t) }))
      .filter((x): x is { t: WorldTarget; box: NonNullable<ReturnType<typeof targetBox>> } => !!x.box && x.box.visible > 0 && x.box.depth < 2000)
      .sort((a, b) => b.box.depth - a.box.depth);
    for (const { t, box } of visible) {
      const th = (t.heading * Math.PI) / 180;
      const fx = Math.sin(th);
      const fy = Math.cos(th);
      // Target frame: x across (right of travel), y along travel, z up.
      const ax: [number, number] = [fy, -fx];
      const ay: [number, number] = [fx, fy];
      const ox = (cam.east - t.east) * ax[0] + (cam.north - t.north) * ax[1];
      const oy = (cam.east - t.east) * ay[0] + (cam.north - t.north) * ay[1];
      const oz = cam.height;
      const parts = partsOf(t);
      const fog = Math.min(1, box.depth / 2500);
      for (let py = Math.floor(box.y0); py < Math.ceil(box.y1) && py < h; py++) {
        for (let px = Math.floor(box.x0); px < Math.ceil(box.x1) && px < w; px++) {
          if (px < 0 || py < 0) continue;
          const vx = (px - w / 2) / cam.f;
          const vy = -(py - h / 2) / cam.f;
          const de = vx * cam.R[0] + vy * cam.U[0] + cam.F[0];
          const dn = vx * cam.R[1] + vy * cam.U[1] + cam.F[1];
          const du = vx * cam.R[2] + vy * cam.U[2] + cam.F[2];
          const dx = de * ax[0] + dn * ax[1];
          const dy = de * ay[0] + dn * ay[1];
          let best = Infinity;
          let hit: { part: Part; face: number; z: number } | null = null;
          for (const part of parts) {
            let t0 = -Infinity;
            let t1 = Infinity;
            let face = -1;
            const slabs: [number, number, number, number][] = [
              [ox, dx, part.x0, part.x1],
              [oy, dy, part.y0, part.y1],
              [oz, du, part.z0, part.z1],
            ];
            let ok = true;
            for (let k = 0; k < 3; k++) {
              const [o, d, lo, hi] = slabs[k]!;
              if (Math.abs(d) < 1e-12) {
                if (o < lo || o > hi) ok = false;
                continue;
              }
              let ta = (lo - o) / d;
              let tb = (hi - o) / d;
              if (ta > tb) [ta, tb] = [tb, ta];
              if (ta > t0) {
                t0 = ta;
                face = k;
              }
              t1 = Math.min(t1, tb);
            }
            if (!ok || t0 > t1 || t0 <= 0 || t0 >= best) continue;
            best = t0;
            hit = { part, face, z: oz + du * t0 };
          }
          if (!hit) continue;
          // Lambert shading of the face that was hit.
          const n: [number, number, number] =
            hit.face === 2 ? [0, 0, 1] : hit.face === 0 ? [ax[0] * Math.sign(-dx), ax[1] * Math.sign(-dx), 0] : [ay[0] * Math.sign(-dy), ay[1] * Math.sign(-dy), 0];
          const light = 0.5 + 0.55 * Math.max(0, n[0] * SUN[0] + n[1] * SUN[1] + n[2] * SUN[2]);
          const c = hit.part.color(hit.z, hit.face);
          const i = (py * w + px) * 4;
          this.buf[i] = Math.min(255, c[0] * light) * (1 - fog) + 175 * fog;
          this.buf[i + 1] = Math.min(255, c[1] * light) * (1 - fog) + 195 * fog;
          this.buf[i + 2] = Math.min(255, c[2] * light) * (1 - fog) + 215 * fog;
        }
      }
    }
  }

  /** Overlays the HUD (exposed for tools rendering complete frames from raw scenes). */
  hud(t: Telemetry): void {
    this.drawHud(t);
  }

  private pixel(x: number, y: number, r: number, g: number, b: number): void {
    const { width: w, height: h } = this.spec;
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (Math.floor(y) * w + Math.floor(x)) * 4;
    this.buf[i] = r;
    this.buf[i + 1] = g;
    this.buf[i + 2] = b;
  }

  private text(s: string, x: number, y: number, scale: number): void {
    let cx = x;
    for (const ch of s.toUpperCase()) {
      const glyph = GLYPHS[ch] ?? GLYPHS[' ']!;
      for (let gy = 0; gy < 5; gy++) {
        for (let gx = 0; gx < 3; gx++) {
          if (glyph[gy * 3 + gx] !== '1') continue;
          for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) this.pixel(cx + gx * scale + sx, y + gy * scale + sy, 255, 255, 255);
        }
      }
      cx += 4 * scale;
    }
  }

  private drawHud(t: Telemetry): void {
    const { width: w, height: h } = this.spec;
    const s = Math.max(1, Math.round(w / 320));
    // crosshair
    for (let k = -12 * s; k <= 12 * s; k++) {
      if (Math.abs(k) < 4 * s) continue;
      this.pixel(w / 2 + k, h / 2, 255, 255, 255);
      this.pixel(w / 2, h / 2 + k, 255, 255, 255);
    }
    // artificial horizon bar (roll)
    const roll = (t.roll * Math.PI) / 180;
    for (let k = -40 * s; k <= 40 * s; k++) {
      if (Math.abs(k) < 16 * s) continue;
      this.pixel(w / 2 + k * Math.cos(roll), h / 2 + (t.pitch * 2 * s) + k * Math.sin(roll), 120, 255, 140);
    }
    this.text(`ALT ${t.altRel.toFixed(1)}`, 6 * s, 6 * s, s * 2);
    this.text(`SPD ${t.groundSpeed.toFixed(1)}`, 6 * s, 20 * s, s * 2);
    this.text(`HDG ${Math.round(t.heading).toString().padStart(3, '0')}`, w - 70 * s, 6 * s, s * 2);
    this.text(`BAT ${Math.round(t.battery.pct)}%`, w - 70 * s, 20 * s, s * 2);
    this.text(String(t.mode).slice(0, 8), 6 * s, h - 16 * s, s * 2);
    const ts = new Date(t.t).toISOString().slice(11, 19);
    this.text(ts, w - 70 * s, h - 16 * s, s * 2);
  }
}
