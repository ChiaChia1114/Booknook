import type { AirspaceZoneDto, AuthGeometry, ConflictDto, ZoneGeometry, ZoneType } from '@athena-sky/shared';
import { LocalProjection, isValidLatLon, type LatLon, type Shape } from '@athena-sky/shared';
import { badRequest } from '../lib/errors';
import { runAtOnce, type Steps } from '../lib/slice';
import { PreparedVolume } from './volume';
import { boxesOverlap, grow, shapeBox, zoneActiveIn, zoneInfo } from './zone-index';

export function zoneShape(g: ZoneGeometry): Shape {
  switch (g.kind) {
    case 'polygon':
      return { kind: 'polygon', polygon: g.polygon };
    case 'circle':
      return { kind: 'point', point: g.center, radiusM: g.radiusM };
    case 'line':
      return { kind: 'line', line: g.line, radiusM: g.bufferM };
  }
}

/** Points (vertices; one for a circle) of a zone's geometry. */
export function zonePoints(g: ZoneGeometry): number {
  return g.kind === 'polygon' ? g.polygon.length : g.kind === 'line' ? g.line.length : 1;
}

export function authShape(g: AuthGeometry): Shape {
  return g.kind === 'cylinder' ? { kind: 'point', point: g.center, radiusM: g.radiusM } : { kind: 'line', line: g.line, radiusM: g.widthM / 2 };
}

const pts = (v: unknown, min: number, field: string): LatLon[] => {
  if (!Array.isArray(v) || v.length < min) throw badRequest(`${field} needs at least ${min} points`);
  if (v.length > 5000) throw badRequest(`${field} has too many points`);
  return v.map((p, i) => {
    const q = p as LatLon;
    if (!isValidLatLon(q)) throw badRequest(`${field}[${i}] is not a valid position`);
    return { lat: q.lat, lon: q.lon };
  });
};

/** Validates untrusted zone geometry. */
export function parseZoneGeometry(raw: unknown): ZoneGeometry {
  const g = raw as Record<string, unknown> | null;
  switch (g?.kind) {
    case 'polygon': {
      const polygon = pts(g.polygon, 3, 'polygon');
      // Corners on one line (or repeated) enclose nothing a drone could be in.
      const proj = new LocalProjection(polygon[0]!);
      const xy = polygon.map((p) => proj.toXY(p));
      let area = 0;
      for (let i = 0; i < xy.length; i++) {
        const a = xy[i]!;
        const b = xy[(i + 1) % xy.length]!;
        area += a.x * b.y - b.x * a.y;
      }
      if (!(Math.abs(area) / 2 >= 1)) throw badRequest('polygon encloses no area (its corners lie on one line)');
      return { kind: 'polygon', polygon };
    }
    case 'circle': {
      if (!isValidLatLon(g.center as LatLon)) throw badRequest('circle centre is not a valid position');
      const r = Number(g.radiusM);
      if (!(r > 0 && r <= 500_000)) throw badRequest('radiusM must be within (0, 500000]');
      const c = g.center as LatLon;
      return { kind: 'circle', center: { lat: c.lat, lon: c.lon }, radiusM: r };
    }
    case 'line': {
      const b = Number(g.bufferM);
      // A line without width covers nothing a drone could be in.
      if (!(b >= 1 && b <= 50_000)) throw badRequest('bufferM must be within [1, 50000] (metres either side of the line)');
      return { kind: 'line', line: pts(g.line, 2, 'line'), bufferM: b };
    }
    default:
      throw badRequest("geometry.kind must be 'polygon', 'circle' or 'line'");
  }
}

/** Validates untrusted authorization geometry (cylinder or corridor flight plan). */
export function parseAuthGeometry(raw: unknown): AuthGeometry {
  const g = raw as Record<string, unknown> | null;
  if (g?.kind === 'cylinder') {
    if (!isValidLatLon(g.center as LatLon)) throw badRequest('cylinder centre is not a valid position');
    const r = Number(g.radiusM);
    if (!(r >= 10 && r <= 50_000)) throw badRequest('radiusM must be within [10, 50000]');
    const c = g.center as LatLon;
    return { kind: 'cylinder', center: { lat: c.lat, lon: c.lon }, radiusM: r };
  }
  if (g?.kind === 'corridor') {
    const w = Number(g.widthM);
    if (!(w >= 10 && w <= 10_000)) throw badRequest('widthM must be within [10, 10000]');
    return { kind: 'corridor', line: pts(g.line, 2, 'line'), widthM: w };
  }
  throw badRequest("geometry.kind must be 'cylinder' or 'corridor'");
}

export const ZONE_SEVERITY: Record<ZoneType, ConflictDto['severity']> = {
  prohibited: 'blocking',
  restricted: 'blocking',
  temporary: 'blocking',
  controlled: 'review',
  danger: 'review',
  hazard_powerline: 'advisory',
  hazard_obstacle: 'advisory',
};

export const ZONE_LABEL: Record<ZoneType, string> = {
  prohibited: 'Prohibited area',
  restricted: 'Restricted area',
  temporary: 'Temporary restriction',
  controlled: 'Controlled airspace',
  danger: 'Danger area',
  hazard_powerline: 'Power line',
  hazard_obstacle: 'Obstacle',
};

const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 <= b1 && b0 <= a1;

export function zoneActive(z: Pick<AirspaceZoneDto, 'activeFrom' | 'activeTo'>, from: number, to: number): boolean {
  const f = z.activeFrom ? new Date(z.activeFrom).getTime() : -Infinity;
  const t = z.activeTo ? new Date(z.activeTo).getTime() : Infinity;
  return overlaps(from, to, f, t);
}

export interface ReservationLike {
  id: string;
  /** Organisation holding the reservation. */
  orgId?: string;
  /** Drone the reservation was granted for (null: any drone of the organisation). */
  droneId?: string | null;
  droneName?: string | null;
  /** Shown on the public safety map: other operators may see who holds it. */
  isPublic?: boolean;
  reference: string;
  geometry: AuthGeometry;
  maxAltM: number;
  startAt: string;
  endAt: string;
  operator: string;
}

/**
 * Checks a requested operation volume against zones and existing reservations – in steps (see
 * `runSliced`): the volume is projected and indexed once, zones and reservations far from it are
 * passed over by their boxes, and each one near it costs the volume's segments near it.
 */
export function* checkVolumeSteps(
  shape: Shape,
  floorM: number,
  ceilingM: number,
  window: { from: number; to: number },
  zones: readonly AirspaceZoneDto[],
  reservations: readonly ReservationLike[],
): Steps<ConflictDto[]> {
  const conflicts: ConflictDto[] = [];
  const volume = new PreparedVolume(shape);
  // Zones whose box is farther than the hazard distance from the volume's box are not tested.
  const near = grow(shapeBox(shape), 60);
  let passed = 0;
  for (const z of zones) {
    if (++passed % 64 === 0) yield;
    const info = zoneInfo(z);
    if (!boxesOverlap(info.box, near)) continue;
    if (!zoneActiveIn(info, window.from, window.to)) continue;
    if (!overlaps(floorM, ceilingM, z.floorM, z.ceilingM)) continue;
    const hazard = z.type.startsWith('hazard_');
    // Hazards are reported when the volume passes within 50 m of their buffer.
    const limit = hazard ? 50 : 0;
    const d = yield* volume.distanceSteps(info.shape, limit);
    if (d > limit) continue;
    const severity = ZONE_SEVERITY[z.type];
    conflicts.push({
      kind: hazard ? 'hazard' : 'zone',
      severity,
      id: z.id,
      name: z.name,
      message: `${ZONE_LABEL[z.type]} "${z.name}" (${Math.round(z.floorM)}–${Math.round(z.ceilingM)} m)${hazard ? ` within ${Math.max(0, Math.round(d))} m` : ''}`,
    });
  }
  for (const r of reservations) {
    if (++passed % 64 === 0) yield;
    const rFrom = new Date(r.startAt).getTime();
    const rTo = new Date(r.endAt).getTime();
    if (!overlaps(window.from, window.to, rFrom, rTo)) continue;
    if (!overlaps(floorM, ceilingM, 0, r.maxAltM)) continue;
    if ((yield* volume.distanceSteps(authShape(r.geometry), 0)) > 0) continue;
    const named = r.isPublic !== false;
    conflicts.push({
      kind: 'reservation',
      severity: 'blocking',
      id: r.id,
      name: named ? r.reference : 'Reserved airspace',
      message: `Overlaps airspace reserved by ${named ? `${r.operator} (${r.reference})` : 'another operator'} ${new Date(rFrom).toISOString().slice(11, 16)}–${new Date(rTo).toISOString().slice(11, 16)} UTC`,
    });
  }
  const rank = { blocking: 0, review: 1, advisory: 2 } as const;
  return conflicts.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** `checkVolumeSteps` at once (small volumes, tests). */
export function checkVolume(
  shape: Shape,
  floorM: number,
  ceilingM: number,
  window: { from: number; to: number },
  zones: readonly AirspaceZoneDto[],
  reservations: readonly ReservationLike[],
): ConflictDto[] {
  return runAtOnce(checkVolumeSteps(shape, floorM, ceilingM, window, zones, reservations));
}

export function verdictOf(conflicts: ConflictDto[]): 'clear' | 'review' | 'blocked' {
  if (conflicts.some((c) => c.severity === 'blocking')) return 'blocked';
  if (conflicts.some((c) => c.severity === 'review')) return 'review';
  return 'clear';
}
