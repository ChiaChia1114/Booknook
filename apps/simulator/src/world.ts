/**
 * The simulated world seen by the synthetic camera: people walking and vehicles driving on the
 * procedural roads around a world anchor. Every simulated drone near the same anchor sees the
 * same world, and positions are a pure function of absolute time, so separate simulator
 * processes (and tests) agree on where every target is.
 */
import { destinationPoint, type LatLon } from '@athena-sky/shared';

export type TargetKind = 'person' | 'vehicle';

export interface WorldTarget {
  id: string;
  kind: TargetKind;
  /** Position (m) east / north of the world anchor. */
  east: number;
  north: number;
  /** Direction of travel (degrees from north). */
  heading: number;
  length: number;
  width: number;
  height: number;
  color: [number, number, number];
}

/** Renderer road grid (local metres): north–south roads at east ≡ 200 (mod 400), east–west at north ≡ 260 (mod 520). */
export const ROAD_SPACING = { east: 400, north: 520, eastOffset: 200, northOffset: 260 } as const;

const SHIRTS: [number, number, number][] = [
  [220, 40, 40],
  [240, 200, 40],
  [40, 90, 220],
  [250, 250, 250],
  [250, 120, 30],
  [150, 50, 200],
  [30, 170, 160],
  [230, 80, 160],
];
const CARS: [number, number, number][] = [
  [235, 235, 235],
  [30, 30, 35],
  [190, 30, 30],
  [30, 70, 170],
  [160, 165, 170],
  [210, 170, 40],
];

/** Anchor of the shared world for a drone at `p` (a ~500 m grid). */
export function worldAnchor(p: LatLon): LatLon {
  return { lat: Math.round(p.lat / 0.005) * 0.005, lon: Math.round(p.lon / 0.005) * 0.005 };
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface PersonPath {
  id: string;
  cx: number;
  cy: number;
  r: number;
  omega: number;
  phase: number;
  color: [number, number, number];
}

interface VehiclePath {
  id: string;
  /** Road axis: 'ns' drives along north at a fixed east, 'ew' along east at a fixed north. */
  axis: 'ns' | 'ew';
  fixed: number;
  start: number;
  length: number;
  speed: number;
  phase: number;
  color: [number, number, number];
}

export class SimWorld {
  readonly anchor: LatLon;
  private readonly people: PersonPath[] = [];
  private readonly vehicles: VehiclePath[] = [];
  private readonly kx: number;

  constructor(anchor: LatLon, opts: { people?: number; vehicles?: number; radiusM?: number } = {}) {
    this.anchor = anchor;
    this.kx = 111_320 * Math.cos((anchor.lat * Math.PI) / 180);
    const rand = mulberry(Math.round(anchor.lat * 1e4) * 7919 + Math.round(anchor.lon * 1e4));
    const R = opts.radiusM ?? 260;
    for (let i = 0; i < (opts.people ?? 16); i++) {
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand()) * R;
      const r = 8 + rand() * 30;
      const speed = 0.9 + rand() * 0.7;
      this.people.push({ id: `P${i + 1}`, cx: Math.sin(a) * d, cy: Math.cos(a) * d, r, omega: (speed / r) * (rand() < 0.5 ? 1 : -1), phase: rand() * Math.PI * 2, color: SHIRTS[i % SHIRTS.length]! });
    }
    for (let i = 0; i < (opts.vehicles ?? 8); i++) {
      const axis = i % 2 === 0 ? 'ns' : 'ew';
      const sp = axis === 'ns' ? ROAD_SPACING.east : ROAD_SPACING.north;
      const off = axis === 'ns' ? ROAD_SPACING.eastOffset : ROAD_SPACING.northOffset;
      const k = Math.floor(rand() * 2) - 1; // roads at -1, 0 around the anchor
      const lane = rand() < 0.5 ? -2 : 2;
      this.vehicles.push({
        id: `V${i + 1}`,
        axis,
        fixed: off + k * sp + lane,
        start: -R - 100 + rand() * 100,
        length: 2 * R,
        speed: 6 + rand() * 6,
        phase: rand(),
        color: CARS[i % CARS.length]!,
      });
    }
  }

  /** Every target at an absolute time (epoch ms). */
  targetsAt(tMs: number): WorldTarget[] {
    const t = tMs / 1000;
    const out: WorldTarget[] = [];
    for (const p of this.people) {
      const ang = p.phase + p.omega * t;
      const east = p.cx + p.r * Math.sin(ang);
      const north = p.cy + p.r * Math.cos(ang);
      // Direction of the velocity (d/dt of the position above).
      const heading = ((Math.atan2(p.omega * Math.cos(ang), -p.omega * Math.sin(ang)) * 180) / Math.PI + 360) % 360;
      out.push({ id: p.id, kind: 'person', east, north, heading, length: 0.35, width: 0.5, height: 1.75, color: p.color });
    }
    for (const v of this.vehicles) {
      // Back and forth along the road segment (triangle wave).
      const cycle = (2 * v.length) / v.speed;
      const f = (((t / cycle + v.phase) % 1) + 1) % 1;
      const forward = f < 0.5;
      const s = v.start + v.length * (forward ? f * 2 : 2 - f * 2);
      const east = v.axis === 'ns' ? v.fixed : s;
      const north = v.axis === 'ns' ? s : v.fixed;
      const heading = v.axis === 'ns' ? (forward ? 0 : 180) : forward ? 90 : 270;
      out.push({ id: v.id, kind: 'vehicle', east, north, heading, length: 4.4, width: 1.85, height: 1.45, color: v.color });
    }
    return out;
  }

  toLocal(p: LatLon): { east: number; north: number } {
    return { east: (p.lon - this.anchor.lon) * this.kx, north: (p.lat - this.anchor.lat) * 111_320 };
  }

  toLatLon(east: number, north: number): LatLon {
    return { lat: this.anchor.lat + north / 111_320, lon: this.anchor.lon + east / this.kx };
  }

  /** Geographic position of a target. */
  positionOf(target: WorldTarget): LatLon {
    return this.toLatLon(target.east, target.north);
  }
}

/** Point `distanceM` from `p` towards `bearingDeg` (re-exported for tools). */
export const offsetPoint = destinationPoint;
