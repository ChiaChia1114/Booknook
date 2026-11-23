/**
 * Post-flight regulatory compliance: legal altitude limit, restricted / prohibited
 * airspace, controlled airspace without authorisation, authorised volume, airspace
 * reserved by other operators and mission geofence.
 */
import type { AirspaceZoneDto, AuthGeometry, ComplianceDto, ComplianceViolation, FlightSampleDto, Geofence } from '@athena-sky/shared';
import { bboxOf, haversineDistance, pointShapeDistance, shapeNearBox } from '@athena-sky/shared';
import { authShape } from '../airspace/geometry';
import { boxesOverlap, grow, zoneActiveIn, zoneDistance, zoneInfo } from '../airspace/zone-index';
import { runAtOnce, runSliced, SLICE_MS, type Steps } from '../lib/slice';

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
  return runAtOnce(checkedTrackSteps(flown));
}

function* checkedTrackSteps(flown: TrackPoint[]): Steps<TrackPoint[]> {
  const out: TrackPoint[] = [];
  for (let i = 0; i < flown.length; i++) {
    if ((i & 1023) === 1023) yield;
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


/**
 * Points tested between two looks at the time used: the slices are bounded by time (see
 * `runSliced`), whatever a point costs (many large authorised corridors near the track).
 */
const STEP = 16;

/** Runs the compliance check at once (tests, small inputs). */
export function checkCompliance(input: ComplianceInput): ComplianceDto {
  return runAtOnce(complianceSteps(input));
}

/**
 * Runs the compliance check in slices of about `sliceMs`, giving the event loop back in
 * between: a long flight among large zones never stalls the server (live telemetry, video and
 * commands of every organisation go on meanwhile).
 */
export function checkComplianceAsync(input: ComplianceInput, sliceMs = SLICE_MS): Promise<ComplianceDto> {
  return runSliced(complianceSteps(input), sliceMs);
}

/** The compliance check; yields now and then (every `STEP` points tested). */
function* complianceSteps(input: ComplianceInput): Steps<ComplianceDto> {
  const violations: ComplianceViolation[] = [];
  const flown: TrackPoint[] = [];
  let maxAlt = -Infinity;
  for (let i = 0; i < input.samples.length; i++) {
    if ((i & 4095) === 4095) yield;
    const s = input.samples[i]!;
    if (!s.armed || !(s.altRel > 1)) continue;
    flown.push(s);
    if (s.altRel > maxAlt) maxAlt = s.altRel;
  }
  if (flown.length === 0) return { compliant: true, violations };
  // Every recorded point is checked (and the straight stretches between close samples): a
  // short pass through a small zone during a long flight is still a violation.
  const track = yield* checkedTrackSteps(flown);
  const from = flown[0]!.t;
  const to = flown[flown.length - 1]!.t;
  // Zones and reservations nowhere near the flight are not tested point by point.
  let box = bboxOf(track.slice(0, 1))!;
  for (let i = 1; i < track.length; i++) {
    if ((i & 8191) === 8191) yield;
    const p = track[i]!;
    if (p.lat < box.minLat) box = { ...box, minLat: p.lat };
    if (p.lat > box.maxLat) box = { ...box, maxLat: p.lat };
    if (p.lon < box.minLon) box = { ...box, minLon: p.lon };
    if (p.lon > box.maxLon) box = { ...box, maxLon: p.lon };
  }
  const near = grow(box, 1);
  yield;

  if (maxAlt > input.maxAltitudeM + 1) {
    violations.push({ type: 'altitude', message: `Maximum altitude ${maxAlt.toFixed(0)} m exceeded the ${input.maxAltitudeM} m limit` });
  }

  const auths: { a: ComplianceInput['authorizations'][number]; distance: (p: TrackPoint) => number }[] = [];
  for (const a of input.authorizations) {
    auths.push({ a, distance: pointShapeDistance(authShape(a.geometry), AUTH_TOLERANCE_M) });
    yield;
  }
  type Auth = (typeof auths)[number];
  const valid = ({ a }: Auth, t: number) => (a.startAt === undefined || t >= a.startAt) && (a.endAt === undefined || t <= a.endAt);
  const inside = ({ a, distance }: Auth, s: TrackPoint) => s.altRel <= a.maxAltM + 5 && distance(s) <= AUTH_TOLERANCE_M;
  /** An authorisation valid at the time covers the point (controlled airspace and danger areas are then allowed). */
  const authorized = (s: TrackPoint) => auths.some((x) => valid(x, s.t) && inside(x, s));
  // The volumes the flight was operated under: the authorisations requested for its mission and
  // those it took off in – of its drone or organisation-wide alike – while they were in effect.
  // An authorisation elsewhere, or not yet (or no longer) in effect, says nothing about this
  // flight: where else it may fly is up to the airspace zones.
  const bound = auths.filter(
    (x) => (x.a.missionId && x.a.missionId === input.missionId && (x.a.startAt ?? -Infinity) <= to && (x.a.endAt ?? Infinity) >= from) || (valid(x, flown[0]!.t) && inside(x, flown[0]!)),
  );

  /** Finds the first point of `points` matching `test`, yielding now and then. */
  function* find<T>(points: T[], test: (p: T) => boolean): Generator<void, T | undefined, void> {
    for (let i = 0; i < points.length; i++) {
      if (i % STEP === STEP - 1) yield;
      if (test(points[i]!)) return points[i];
    }
    return undefined;
  }

  // The live monitor's rules, for every point flown: prohibited / restricted / temporary areas
  // are never to be entered; controlled airspace and danger areas only where an approved
  // authorisation covers the drone at that moment.
  for (const z of input.zones) {
    if (z.type.startsWith('hazard_')) continue;
    // Prepared once per zone (box, shape index), kept while the zone list is cached.
    const info = zoneInfo(z);
    if (!zoneActiveIn(info, from, to) || !boxesOverlap(info.box, near)) continue;
    const activeFrom = info.from;
    const activeTo = info.to;
    const distance = zoneDistance(z, 0);
    const needsAuthorisation = z.type === 'controlled' || z.type === 'danger';
    const offending = yield* find(track, (s) => s.t >= activeFrom && s.t <= activeTo && s.altRel >= z.floorM && s.altRel <= z.ceilingM && distance(s) <= 0 && !(needsAuthorisation && authorized(s)));
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
    // A point is held to the volumes in effect at its time.
    const out = (s: TrackPoint) => {
      const current = bound.filter((x) => valid(x, s.t));
      return current.length > 0 && !current.some((x) => inside(x, s));
    };
    let outside = 0;
    for (let i = 0; i < flown.length; i++) {
      if (i % STEP === STEP - 1) yield;
      if (out(flown[i]!)) outside++;
    }
    if (outside > 0) {
      violations.push({ type: 'authorization', message: `${outside} track point(s) outside the authorised volume (${refs})` });
    } else if (yield* find(track, out)) {
      violations.push({ type: 'authorization', message: `The track left the authorised volume (${refs}) between two recorded points` });
    }
  }

  for (const r of input.reservations ?? []) {
    const shape = authShape(r.geometry);
    if (!shapeNearBox(shape, box)) continue;
    const distance = pointShapeDistance(shape, 0);
    const entered = yield* find(track, (s) => s.t >= r.startAt && s.t <= r.endAt && s.altRel <= r.maxAltM && distance(s) <= -RESERVATION_MARGIN_M);
    if (entered) violations.push({ type: 'reservation', message: `Entered airspace reserved by ${r.label}` });
  }

  const fences = [...(input.geofence ? [{ from: -Infinity, to: Infinity, fence: input.geofence }] : []), ...(input.geofences ?? [])];
  for (const { from: f, to: t, fence } of fences) {
    if (fence.polygon.length < 3) continue;
    const distance = pointShapeDistance({ kind: 'polygon', polygon: fence.polygon }, 0);
    const left = yield* find(track, (s) => s.t >= f && s.t < t && (distance(s) > 0 || (fence.maxAlt != null && s.altRel > fence.maxAlt + 2)));
    if (left) {
      violations.push({ type: 'geofence', message: 'Flight left the mission geofence' });
      break;
    }
  }
  return { compliant: violations.length === 0, violations };
}
