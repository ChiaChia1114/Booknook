/**
 * Synthetic gimbal camera: ray-casts a procedural landscape (fields, roads, a
 * river) from the drone's position/heading and overlays a minimal HUD, then
 * encodes the frame as JPEG. Used to exercise the live HD video pipeline.
 */
import jpeg from 'jpeg-js';
import type { Telemetry } from '@athena-sky/shared';

export interface FrameSpec {
  width: number;
  height: number;
  quality: number;
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

  constructor(private readonly spec: FrameSpec) {
    this.buf = Buffer.alloc(spec.width * spec.height * 4);
  }

  /** Renders a frame for the given telemetry. `origin` anchors the local world frame. */
  render(t: Telemetry, origin: { lat: number; lon: number }): Uint8Array {
    const { width: w, height: h } = this.spec;
    const data = this.buf;
    const east = (t.lon - origin.lon) * 111_320 * Math.cos((origin.lat * Math.PI) / 180);
    const north = (t.lat - origin.lat) * 111_320;
    const camH = Math.max(1.2, t.altRel + 0.3);
    const yaw = (t.heading * Math.PI) / 180;
    const alpha = (25 * Math.PI) / 180; // stabilised gimbal looking 25° down
    const fov = (78 * Math.PI) / 180;
    const f = w / 2 / Math.tan(fov / 2);
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const ca = Math.cos(alpha);
    const sa = Math.sin(alpha);
    for (let py = 0; py < h; py++) {
      const vy = -(py - h / 2) / f;
      // Camera ray (x right, y up, z forward = 1), tilted down by alpha …
      const up = vy * ca - sa;
      const forward = vy * sa + ca;
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
    this.drawHud(t);
    return jpeg.encode({ data, width: w, height: h }, this.spec.quality).data;
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
