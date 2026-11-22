/**
 * Post-flight regulatory compliance: legal altitude limit, restricted / prohibited
 * airspace, controlled airspace without authorisation, authorised volume, airspace
 * reserved by other operators and mission geofence.
 */
import type { AirspaceZoneDto, AuthGeometry, ComplianceDto, ComplianceViolation, FlightSampleDto, Geofence } from '@athena-sky/shared';
import { bboxOf, haversineDistance, maxOf, pointShapeDistance, shapeNearBox } from '@athena-sky/shared';
import { authShape, zoneActive, zoneShape } from '../airspace/geometry';

export interface ComplianceInput {
  samples: Pick<FlightSampleDto, 't' | 'lat' | 'lon' | 'altRel' | 'armed'>[];
  maxAltitudeM: number;
  zones: AirspaceZoneDto[];
  /**
   * Approved authorisations overlapping the flight: of this drone (`drone`), or
   * organisation-wide ones without a drone (`org`).
   */
  authorizations: { reference: string; geometry: AuthGeometry; maxAltM: number; scope?: 'drone' | 'org'; missionId?: string | null; startAt?: number; endAt?: number }[];
  /** The mission the flight flew (an authorisation requested for it binds the flight). */
  missionId?: string | null;
  /** Approved reservations of other operators overlapping the flight (times in ms). */
  reservations?: { label: string; geometry: AuthGeometry; maxAltM: number; startAt: number; endAt: number }[];
  /** The mission geofence, for the whole flight (a flight recorded without its geofences). */
  geofence: Geofence | null;
  /**
   * The geofences the drone enforced during the flight, each from `from` until `to` (ms): that of
   * the mission loaded on it, whether the flight flew that mission or not.
   */
  geofences?: { from: number; to: number; fence: Geofence }[];
}

/** How far inside another operator's reserved volume a track point must be (GNSS noise, m). */
const RESERVATION_MARGIN_M = 5;

/** Tolerance for GNSS noise when testing containment in an authorised volume (m). */
const AUTH_TOLERANCE_M = 15;

/** Between samples at most this far apart in time the track is a straight line (ms). */
const INTERPOLATE_GAP_MS = 1000;
/** Spacing of the points checked along such a stretch (m). */
const CHECK_STEP_M = 2;

type TrackPoint = { t: number; lat: number; lon: number; altRel: number };

/**
 * Every point flown, and between samples recorded close together (at most a second apart) points
 * every 2 m along the straight line joining them: a fast drone crossing a small zone between two
 * samples is caught too. Longer gaps (link loss, a landing) are not bridged.
 */
export function checkedTrack(flown: TrackPoint[]): TrackPoint[] {
  const out: TrackPoint[] = [];
  for (let i = 0; i < flown.length; i++) {
    const s = flown[i]!;
    const p = i > 0 ? flown[i - 1]! : null;
    if (p && s.t - p.t > 0 && s.t - p.t <= INTERPOLATE_GAP_MS) {
      const n = Math.min(100, Math.floor(haversineDistance(p, s) / CHECK_STEP_M));
      for (let k = 1; k < n; k++) {
        const f = k / n;
        out.push({ t: p.t + (s.t - p.t) * f, lat: p.lat + (s.lat - p.lat) * f, lon: p.lon + (s.lon - p.lon) * f, altRel: p.altRel + (s.altRel - p.altRel) * f });
      }
    }
    out.push(s);
  }
  return out;
}

const timeOf = (iso: string | null | undefined, fallback: number) => (iso ? new Date(iso).getTime() : fallback);

export function checkCompliance(input: ComplianceInput): ComplianceDto {
  const violations: ComplianceViolation[] = [];
  const flown = input.samples.filter((s) => s.armed && s.altRel > 1);
  if (flown.length === 0) return { compliant: true, violations };
  // Every recorded point is checked (and the straight stretches between close samples): a
  // short pass through a small zone during a long flight is still a violation.
  const track = checkedTrack(flown);
  const from = flown[0]!.t;
  const to = flown[flown.length - 1]!.t;
  // Zones and reservations nowhere near the flight are not tested point by point.
  const box = bboxOf(track)!;

  const maxAlt = maxOf(flown.map((s) => s.altRel));
  if (maxAlt > input.maxAltitudeM + 1) {
    violations.push({ type: 'altitude', message: `Maximum altitude ${maxAlt.toFixed(0)} m exceeded the ${input.maxAltitudeM} m limit` });
  }

  const auths = input.authorizations.map((a) => ({ a, distance: pointShapeDistance(authShape(a.geometry), AUTH_TOLERANCE_M) }));
  type Auth = (typeof auths)[number];
  const inside = ({ a, distance }: Auth, s: TrackPoint) => s.altRel <= a.maxAltM + 5 && distance(s) <= AUTH_TOLERANCE_M;
  /** An authorisation valid at the time covers the point (controlled airspace and danger areas are then allowed). */
  const authorized = (s: TrackPoint) => auths.some((x) => (x.a.startAt === undefined || s.t >= x.a.startAt) && (x.a.endAt === undefined || s.t <= x.a.endAt) && inside(x, s));
  // The volumes the flight was operated under: the authorisations requested for its mission and
  // those it took off in – of its drone or organisation-wide alike. An authorisation elsewhere
  // says nothing about this flight: where else it may fly is up to the airspace zones.
  const bound = auths.filter((x) => (x.a.missionId && x.a.missionId === input.missionId) || inside(x, flown[0]!));

  // The live monitor's rules, for every point flown: prohibited / restricted / temporary areas
  // are never to be entered; controlled airspace and danger areas only where an approved
  // authorisation covers the drone at that moment.
  for (const z of input.zones) {
    if (z.type.startsWith('hazard_')) continue;
    if (!zoneActive(z, from, to)) continue;
    const shape = zoneShape(z.geometry);
    if (!shapeNearBox(shape, box)) continue;
    const activeFrom = timeOf(z.activeFrom, -Infinity);
    const activeTo = timeOf(z.activeTo, Infinity);
    const distance = pointShapeDistance(shape, 0);
    const needsAuthorisation = z.type === 'controlled' || z.type === 'danger';
    const offending = track.find(
      (s) => s.t >= activeFrom && s.t <= activeTo && s.altRel >= z.floorM && s.altRel <= z.ceilingM && distance(s) <= 0 && !(needsAuthorisation && authorized(s)),
    );
    if (!offending) continue;
    violations.push({
      type: 'zone',
      zoneId: z.id,
      message: needsAuthorisation
        ? `Entered ${z.type === 'danger' ? 'danger area' : 'controlled airspace'} "${z.name}" without an approved authorisation`
        : `Entered ${z.type} airspace "${z.name}"`,
    });
  }

  if (bound.length > 0) {
    const refs = bound.map((x) => x.a.reference).join(', ');
    const outside = flown.filter((s) => !bound.some((x) => inside(x, s)));
    if (outside.length > 0) {
      violations.push({ type: 'authorization', message: `${outside.length} track point(s) outside the authorised volume (${refs})` });
    } else if (track.some((s) => !bound.some((x) => inside(x, s)))) {
      violations.push({ type: 'authorization', message: `The track left the authorised volume (${refs}) between two recorded points` });
    }
  }

  for (const r of input.reservations ?? []) {
    const shape = authShape(r.geometry);
    if (!shapeNearBox(shape, box)) continue;
    const distance = pointShapeDistance(shape, 0);
    const entered = track.some((s) => s.t >= r.startAt && s.t <= r.endAt && s.altRel <= r.maxAltM && distance(s) <= -RESERVATION_MARGIN_M);
    if (entered) violations.push({ type: 'reservation', message: `Entered airspace reserved by ${r.label}` });
  }

  const fences = [...(input.geofence ? [{ from: -Infinity, to: Infinity, fence: input.geofence }] : []), ...(input.geofences ?? [])];
  const breach = fences.some(({ from, to, fence }) => {
    if (fence.polygon.length < 3) return false;
    const distance = pointShapeDistance({ kind: 'polygon', polygon: fence.polygon }, 0);
    return track.some((s) => s.t >= from && s.t < to && (distance(s) > 0 || (fence.maxAlt != null && s.altRel > fence.maxAlt + 2)));
  });
  if (breach) violations.push({ type: 'geofence', message: 'Flight left the mission geofence' });
  return { compliant: violations.length === 0, violations };
}
