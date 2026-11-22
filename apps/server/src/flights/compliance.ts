/**
 * Post-flight regulatory compliance: legal altitude limit, restricted / prohibited
 * airspace, controlled airspace without authorisation, authorised volume, airspace
 * reserved by other operators and mission geofence.
 */
import type { AirspaceZoneDto, AuthGeometry, ComplianceDto, ComplianceViolation, FlightSampleDto, Geofence } from '@athena-sky/shared';
import { maxOf, pointInPolygon, shapeDistanceM } from '@athena-sky/shared';
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

export function checkCompliance(input: ComplianceInput): ComplianceDto {
  const violations: ComplianceViolation[] = [];
  const flown = input.samples.filter((s) => s.armed && s.altRel > 1);
  if (flown.length === 0) return { compliant: true, violations };
  const step = Math.max(1, Math.floor(flown.length / 600));
  const track = flown.filter((_, i) => i % step === 0);
  const from = flown[0]!.t;
  const to = flown[flown.length - 1]!.t;

  const maxAlt = maxOf(flown.map((s) => s.altRel));
  if (maxAlt > input.maxAltitudeM + 1) {
    violations.push({ type: 'altitude', message: `Maximum altitude ${maxAlt.toFixed(0)} m exceeded the ${input.maxAltitudeM} m limit` });
  }

  const inside = (a: ComplianceInput['authorizations'][number], s: { lat: number; lon: number; altRel: number }) =>
    s.altRel <= a.maxAltM + 5 && shapeDistanceM({ kind: 'point', point: s, radiusM: 0 }, authShape(a.geometry)) <= AUTH_TOLERANCE_M;
  /** An authorisation valid at the time covers the point (controlled airspace and danger areas are then allowed). */
  const authorized = (s: { t: number; lat: number; lon: number; altRel: number }) =>
    input.authorizations.some((a) => (a.startAt === undefined || s.t >= a.startAt) && (a.endAt === undefined || s.t <= a.endAt) && inside(a, s));
  // The volumes the flight was operated under: the authorisations requested for its mission and
  // those it took off in – of its drone or organisation-wide alike. An authorisation elsewhere
  // says nothing about this flight: where else it may fly is up to the airspace zones.
  const bound = input.authorizations.filter((a) => (a.missionId && a.missionId === input.missionId) || inside(a, track[0]!));

  // The live monitor's rules, for every point flown: prohibited / restricted / temporary areas
  // are never to be entered; controlled airspace and danger areas only where an approved
  // authorisation covers the drone at that moment.
  for (const z of input.zones) {
    if (z.type.startsWith('hazard_')) continue;
    if (!zoneActive(z, from, to)) continue;
    const shape = zoneShape(z.geometry);
    const needsAuthorisation = z.type === 'controlled' || z.type === 'danger';
    const offending = track.find(
      (s) =>
        zoneActive(z, s.t, s.t) &&
        s.altRel >= z.floorM &&
        s.altRel <= z.ceilingM &&
        shapeDistanceM({ kind: 'point', point: s, radiusM: 0 }, shape) <= 0 &&
        !(needsAuthorisation && authorized(s)),
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
    const outside = track.filter((s) => !bound.some((a) => inside(a, s)));
    if (outside.length > 0) {
      violations.push({ type: 'authorization', message: `${outside.length} track point(s) outside the authorised volume (${bound.map((a) => a.reference).join(', ')})` });
    }
  }

  for (const r of input.reservations ?? []) {
    const shape = authShape(r.geometry);
    const entered = track.some((s) => s.t >= r.startAt && s.t <= r.endAt && s.altRel <= r.maxAltM && shapeDistanceM({ kind: 'point', point: s, radiusM: 0 }, shape) <= -RESERVATION_MARGIN_M);
    if (entered) violations.push({ type: 'reservation', message: `Entered airspace reserved by ${r.label}` });
  }

  const fences = [...(input.geofence ? [{ from: -Infinity, to: Infinity, fence: input.geofence }] : []), ...(input.geofences ?? [])];
  const breach = fences.some(
    ({ from, to, fence }) =>
      fence.polygon.length >= 3 && track.some((s) => s.t >= from && s.t < to && (!pointInPolygon(s, fence.polygon) || (fence.maxAlt != null && s.altRel > fence.maxAlt + 2))),
  );
  if (breach) violations.push({ type: 'geofence', message: 'Flight left the mission geofence' });
  return { compliant: violations.length === 0, violations };
}
