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
  authorizations: { reference: string; geometry: AuthGeometry; maxAltM: number; scope?: 'drone' | 'org' }[];
  /** Approved reservations of other operators overlapping the flight (times in ms). */
  reservations?: { label: string; geometry: AuthGeometry; maxAltM: number; startAt: number; endAt: number }[];
  geofence: Geofence | null;
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
  /** Any authorisation covers the point (controlled airspace is then allowed). */
  const authorized = (s: { lat: number; lon: number; altRel: number }) => input.authorizations.some((a) => inside(a, s));
  // The volumes the flight was operated under: its drone's authorisations, and organisation-wide
  // ones it took off in. An organisation-wide reservation elsewhere says nothing about this flight.
  const bound = input.authorizations.filter((a) => (a.scope ?? 'drone') === 'drone' || inside(a, track[0]!));

  for (const z of input.zones) {
    if (z.type.startsWith('hazard_') || z.type === 'danger') continue;
    if (!zoneActive(z, from, to)) continue;
    const shape = zoneShape(z.geometry);
    const inside = track.find(
      (s) => s.altRel >= z.floorM && s.altRel <= z.ceilingM && shapeDistanceM({ kind: 'point', point: s, radiusM: 0 }, shape) <= 0,
    );
    if (!inside) continue;
    if (z.type === 'controlled' && authorized(inside)) continue;
    violations.push({
      type: 'zone',
      zoneId: z.id,
      message:
        z.type === 'controlled'
          ? `Entered controlled airspace "${z.name}" without an approved authorisation`
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

  if (input.geofence && input.geofence.polygon.length >= 3) {
    const gf = input.geofence;
    const breach = track.some((s) => !pointInPolygon(s, gf.polygon) || (gf.maxAlt != null && s.altRel > gf.maxAlt + 2));
    if (breach) violations.push({ type: 'geofence', message: 'Flight left the mission geofence' });
  }
  return { compliant: violations.length === 0, violations };
}
