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
  samples: readonly Pick<FlightSampleDto, 't' | 'lat' | 'lon' | 'altRel' | 'armed'>[];
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
/**
 * Faster than any drone flies (m/s): two samples further apart than that in their time are a jump
 * of the position (a GNSS error, a corrupt log) – not a stretch flown, so not bridged.
 */
const BRIDGED_SPEED_MAX_MS = 100;

type TrackPoint = { t: number; lat: number; lon: number; altRel: number };

/**
 * The first point of the checked track that passes `test`, yielding now and then (every `STEP`
 * points tested). The checked track is every point flown and, between samples recorded close
 * together (at most a second apart, and no further than a drone flies in that time), points every
 * 2 m along the straight line joining them: a fast drone crossing a small zone between two samples
 * is caught too. Longer gaps (link loss, a landing) and jumps are not bridged. The points between
 * samples are made as they are tested, never kept: a long log is checked in little memory.
 */
function* findOnTrack(flown: readonly TrackPoint[], test: (p: TrackPoint) => boolean): Steps<TrackPoint | undefined> {
  let tested = 0;
  for (let i = 0; i < flown.length; i++) {
    const s = flown[i]!;
    const p = i > 0 ? flown[i - 1]! : null;
    const dt = p ? s.t - p.t : 0;
    if (p && dt > 0 && dt <= INTERPOLATE_GAP_MS) {
      const d = haversineDistance(p, s);
      if (d <= (BRIDGED_SPEED_MAX_MS * dt) / 1000) {
        const n = Math.min(100, Math.floor(d / CHECK_STEP_M));
        for (let k = 1; k < n; k++) {
          if (++tested % STEP === 0) yield;
          const f = k / n;
          const q = { t: p.t + dt * f, lat: p.lat + (s.lat - p.lat) * f, lon: p.lon + (s.lon - p.lon) * f, altRel: p.altRel + (s.altRel - p.altRel) * f };
          if (test(q)) return q;
        }
      }
    }
    if (++tested % STEP === 0) yield;
    if (test(s)) return s;
  }
  return undefined;
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
  // Every recorded point is checked (and the straight stretches between close samples – see
  // findOnTrack): a short pass through a small zone during a long flight is still a violation.
  const from = flown[0]!.t;
  const to = flown[flown.length - 1]!.t;
  // Zones and reservations nowhere near the flight are not tested point by point. (The points
  // between samples lie between them: the samples' box holds them all.)
  let box = bboxOf(flown.slice(0, 1))!;
  for (let i = 1; i < flown.length; i++) {
    if ((i & 8191) === 8191) yield;
    const p = flown[i]!;
    if (p.lat < box.minLat) box = { ...box, minLat: p.lat };
    if (p.lat > box.maxLat) box = { ...box, maxLat: p.lat };
    if (p.lon < box.minLon) box = { ...box, minLon: p.lon };
    if (p.lon > box.maxLon) box = { ...box, maxLon: p.lon };
  }
  const near = grow(box, 1);
  yield;

  if (maxAlt > input.maxAltitudeM + 1) {
    // Heights throughout (limit, zone floors and ceilings, authorisations) are above the take-off point.
    violations.push({ type: 'altitude', message: `Maximum altitude ${maxAlt.toFixed(0)} m above take-off exceeded the ${input.maxAltitudeM} m limit` });
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
    const offending = yield* findOnTrack(flown, (s) => s.t >= activeFrom && s.t <= activeTo && s.altRel >= z.floorM && s.altRel <= z.ceilingM && distance(s) <= 0 && !(needsAuthorisation && authorized(s)));
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
    } else if (yield* findOnTrack(flown, out)) {
      violations.push({ type: 'authorization', message: `The track left the authorised volume (${refs}) between two recorded points` });
    }
  }

  for (const r of input.reservations ?? []) {
    const shape = authShape(r.geometry);
    if (!shapeNearBox(shape, box)) continue;
    const distance = pointShapeDistance(shape, 0);
    const entered = yield* findOnTrack(flown, (s) => s.t >= r.startAt && s.t <= r.endAt && s.altRel <= r.maxAltM && distance(s) <= -RESERVATION_MARGIN_M);
    if (entered) violations.push({ type: 'reservation', message: `Entered airspace reserved by ${r.label}` });
  }

  const fences = [...(input.geofence ? [{ from: -Infinity, to: Infinity, fence: input.geofence }] : []), ...(input.geofences ?? [])];
  for (const { from: f, to: t, fence } of fences) {
    if (fence.polygon.length < 3) continue;
    const distance = pointShapeDistance({ kind: 'polygon', polygon: fence.polygon }, 0);
    const left = yield* findOnTrack(flown, (s) => s.t >= f && s.t < t && (distance(s) > 0 || (fence.maxAlt != null && s.altRel > fence.maxAlt + 2)));
    if (left) {
      violations.push({ type: 'geofence', message: 'Flight left the mission geofence' });
      break;
    }
  }
  return { compliant: violations.length === 0, violations };
}
