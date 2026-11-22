import type {
  AirspaceZoneDto,
  AlertDto,
  AuthGeometry,
  FlightAnalysisDto,
  FlightDto,
  FlightEventDto,
  FlightSampleDto,
  MissionPlan,
} from '@athena-sky/shared';
import type { Db } from '../db/database';
import { parseJson } from '../db/database';
import { listZones } from '../airspace/airspace-service';
import { getOrgSettings } from '../orgs/org-service';
import { analyzeFlight } from './analysis';
import { flownFrom, missionPath, normalizePlan, routeDeviation, type AnalysisFinding } from '@athena-sky/shared';
import { checkCompliance } from './compliance';
import type { GeofencePeriod } from './recorder';
import { nowIso } from '../lib/util';

export const FLIGHT_SELECT = `SELECT f.*, d.name AS drone_name, d.fleet_id AS fleet_id, u.name AS pilot_name
  FROM flights f JOIN drones d ON d.id = f.drone_id LEFT JOIN users u ON u.id = f.pilot_id`;

export function flightDto(r: any): FlightDto {
  return {
    id: r.id,
    droneId: r.drone_id,
    droneName: r.drone_name,
    fleetId: r.fleet_id ?? null,
    pilotId: r.pilot_id,
    pilotName: r.pilot_name ?? null,
    missionId: r.mission_id,
    source: r.source,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationS: r.duration_s,
    distanceM: r.distance_m,
    maxAltM: r.max_alt_m,
    maxSpeedMs: r.max_speed_ms,
    batteryStartPct: r.battery_start,
    batteryEndPct: r.battery_end,
    startLat: r.start_lat,
    startLon: r.start_lon,
    endLat: r.end_lat,
    endLon: r.end_lon,
    healthScore: r.health_score,
    compliance: parseJson(r.compliance, null),
    notes: r.notes,
    createdAt: r.created_at,
  };
}

export function getFlight(db: Db, orgId: string, flightId: string): FlightDto | null {
  const r = db.get(`${FLIGHT_SELECT} WHERE f.id = ? AND f.org_id = ?`, flightId, orgId);
  return r ? flightDto(r) : null;
}

export function sampleDto(r: any): FlightSampleDto {
  return {
    t: r.t,
    lat: r.lat,
    lon: r.lon,
    altMsl: r.alt_msl,
    altRel: r.alt_rel,
    groundSpeed: r.ground_speed ?? 0,
    climbRate: r.climb_rate ?? 0,
    heading: r.heading ?? 0,
    roll: r.roll ?? 0,
    pitch: r.pitch ?? 0,
    yaw: r.yaw ?? 0,
    batteryPct: r.battery_pct ?? 0,
    voltage: r.voltage ?? 0,
    current: r.current ?? 0,
    satellites: r.satellites ?? 0,
    hdop: r.hdop ?? 0,
    mode: r.mode ?? 'UNKNOWN',
    armed: r.armed === 1,
    vibration: r.vibration,
    motors: parseJson<number[] | null>(r.motors, null),
  };
}

export function loadSamples(db: Db, flightId: string): FlightSampleDto[] {
  return db.all('SELECT * FROM flight_samples WHERE flight_id = ? ORDER BY t', flightId).map(sampleDto);
}

export function loadEvents(db: Db, flightId: string): FlightEventDto[] {
  return db.all<any>('SELECT t, level, code, message FROM flight_events WHERE flight_id = ? ORDER BY t, id', flightId).map((e) => ({
    t: e.t,
    level: e.level,
    code: e.code,
    message: e.message,
  }));
}

export function insertSamples(db: Db, flightId: string, samples: FlightSampleDto[]): void {
  db.tx(() => {
    for (const s of samples) {
      db.run(
        `INSERT INTO flight_samples (flight_id, t, lat, lon, alt_msl, alt_rel, ground_speed, climb_rate, heading, roll, pitch, yaw,
                                     battery_pct, voltage, current, satellites, hdop, mode, armed, vibration, motors)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        flightId,
        s.t,
        s.lat,
        s.lon,
        s.altMsl,
        s.altRel,
        s.groundSpeed,
        s.climbRate,
        s.heading,
        s.roll,
        s.pitch,
        s.yaw,
        s.batteryPct,
        s.voltage,
        s.current,
        s.satellites,
        s.hdop,
        s.mode,
        s.armed,
        s.vibration,
        s.motors ? JSON.stringify(s.motors) : null,
      );
    }
  });
}

export function analysisDto(r: any): FlightAnalysisDto {
  return { flightId: r.flight_id, score: r.score, computedAt: r.computed_at, findings: parseJson(r.findings, []), metrics: parseJson(r.metrics, {}) };
}

/** Runs post-flight analytics and stores the result; returns the analysis. */
/** Route-deviation tolerance of the post-flight analysis (m). */
export const ROUTE_TOLERANCE_M = 10;
/** Flight modes in which the vehicle returns or lands on its own (PX4, ArduPilot and simulator names). */
const AUTO_RETURN_MODE = /RTL|RETURN|LAND|DESCEND/i;

/**
 * Route conformance of a mission flight: cross-track error of the flown track against the
 * planned route, time outside the tolerance and how much of the route was flown.
 */
export function routeConformance(
  plan: MissionPlan,
  samples: FlightSampleDto[],
  opts: {
    /** When the flight began to fly the mission (ms): earlier samples (e.g. a manual climb and transit before a mission started in the air) are not compared. */
    fromT?: number | null;
  } = {},
): { metrics: Record<string, number>; findings: AnalysisFinding[] } | null {
  // The automatic return (RTL) is flown the way the vehicle decides – to home or the closest
  // rally point, at its own return altitude – so it is not part of the route that is checked:
  // neither the plan's final RTL leg nor any part of the flight in a return or landing mode
  // (also a failsafe return, after which the rest of the route counts as not flown).
  const rtl = plan.items[plan.items.length - 1]?.type === 'rtl';
  const route = rtl ? { ...plan, items: plan.items.slice(0, -1) } : plan;
  const fromT = opts.fromT ?? -Infinity;
  const flown = samples.filter((s) => s.t >= fromT && !AUTO_RETURN_MODE.test(s.mode ?? ''));
  const dev = routeDeviation(
    missionPath(route),
    flown.map((s) => ({ t: s.t, lat: s.lat, lon: s.lon, altRel: s.altRel })),
    ROUTE_TOLERANCE_M,
    2,
  );
  if (!dev) return null;
  const metrics: Record<string, number> = {
    routeMeanM: dev.meanM,
    routeP95M: dev.p95M,
    routeMaxM: dev.maxM,
    routeOutsidePct: dev.outsidePct,
    routeCoveragePct: dev.coveragePct,
    routeMaxAltDevM: dev.maxAltDevM,
  };
  if (dev.worst) {
    metrics.routeWorstLat = dev.worst.lat;
    metrics.routeWorstLon = dev.worst.lon;
    metrics.routeWorstT = dev.worst.t;
  }
  const findings: AnalysisFinding[] = [];
  if (dev.outsidePct > 15) {
    findings.push({ code: 'route_deviation', severity: 'warning', title: 'Route deviation', detail: `${dev.outsidePct} % of the flight was more than ${ROUTE_TOLERANCE_M} m off the planned route (95th percentile ${dev.p95M} m, max ${dev.maxM} m).`, metric: dev.outsidePct, t: dev.worst?.t });
  }
  if (dev.coveragePct < 80) {
    findings.push({ code: 'route_incomplete', severity: 'info', title: 'Route not completed', detail: `${dev.coveragePct} % of the planned route was flown within ${ROUTE_TOLERANCE_M} m.`, metric: dev.coveragePct });
  }
  if (dev.maxAltDevM > ROUTE_TOLERANCE_M && dev.worstAlt) {
    findings.push({ code: 'route_altitude', severity: 'info', title: 'Altitude off plan', detail: `Flown up to ${dev.maxAltDevM} m above or below the planned altitude en route.`, metric: dev.maxAltDevM, t: dev.worstAlt.t });
  }
  return { metrics, findings };
}

export function runAnalysis(db: Db, flightId: string): FlightAnalysisDto | null {
  const f = db.get<{ id: string; drone_id: string; started_at: string; mission_id: string | null; mission_plan: string | null; mission_started_at: number | null; start_lat: number | null; start_lon: number | null }>(
    'SELECT id, drone_id, started_at, mission_id, mission_plan, mission_started_at, start_lat, start_lon FROM flights WHERE id = ?',
    flightId,
  );
  if (!f) return null;
  const history = db
    .all<{ metrics: string }>(
      `SELECT a.metrics FROM flight_analyses a JOIN flights fl ON fl.id = a.flight_id
        WHERE fl.drone_id = ? AND fl.id != ? AND fl.started_at < ? ORDER BY fl.started_at DESC LIMIT 20`,
      f.drone_id,
      f.id,
      f.started_at,
    )
    .map((r) => parseJson<Record<string, number>>(r.metrics, {}));
  const samples = loadSamples(db, flightId);
  const res = analyzeFlight({ samples, events: loadEvents(db, flightId), history });
  // Mission flights: route conformance (reported, not part of the vehicle health score).
  const mission = flownPlanJson(db, f);
  if (mission) {
    let plan: MissionPlan | null = null;
    try {
      plan = normalizePlan(parseJson(mission.plan, {}));
    } catch {
      plan = null;
    }
    // A live flight's plan already starts where the mission was begun; otherwise (an uploaded log,
    // an older flight) the route starts where the flight took off – not at the plan's drawn home.
    if (plan && f.mission_started_at == null && f.start_lat != null && f.start_lon != null) plan = flownFrom(plan, { lat: f.start_lat, lon: f.start_lon });
    const rc = plan ? routeConformance(plan, samples, { fromT: f.mission_started_at }) : null;
    if (rc) {
      Object.assign(res.metrics, rc.metrics);
      res.findings.push(...rc.findings);
    }
  }
  const computedAt = nowIso();
  db.run(
    `INSERT INTO flight_analyses (flight_id, score, findings, metrics, computed_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (flight_id) DO UPDATE SET score = excluded.score, findings = excluded.findings, metrics = excluded.metrics, computed_at = excluded.computed_at`,
    flightId,
    res.score,
    JSON.stringify(res.findings),
    JSON.stringify(res.metrics),
    computedAt,
  );
  db.run('UPDATE flights SET health_score = ? WHERE id = ?', res.score, flightId);
  return { flightId, score: res.score, computedAt, findings: res.findings, metrics: res.metrics };
}

/**
 * The plan a flight was flown with: the snapshot taken when the mission was uploaded to the
 * drone, or (flights recorded before snapshots) the mission's current plan.
 */
export function flownPlanJson(db: Db, f: { mission_id: string | null; mission_plan: string | null }): { plan: string; snapshot: boolean } | undefined {
  // The plan kept with the flight – also once its mission has been deleted.
  if (f.mission_plan) return { plan: f.mission_plan, snapshot: true };
  if (!f.mission_id) return undefined;
  const m = db.get<{ plan: string }>('SELECT plan FROM missions WHERE id = ?', f.mission_id);
  return m ? { plan: m.plan, snapshot: false } : undefined;
}

/**
 * When an approved authorisation (or another operator's reservation) took effect: its start, or
 * the moment it was approved when that was later – an approval does not reach back to flights
 * flown before it.
 */
export function effectiveStart(startAt: string, decidedAt: string | null): number {
  const start = Date.parse(startAt);
  const decided = decidedAt ? Date.parse(decidedAt) : NaN;
  return Number.isFinite(decided) ? Math.max(start, decided) : start;
}

/** Runs the compliance check and stores it on the flight. */
export function runCompliance(db: Db, flightId: string, zonesFor: (orgId: string) => AirspaceZoneDto[] = (orgId) => listZones(db, orgId)) {
  const f = db.get<{ org_id: string; drone_id: string; mission_id: string | null; mission_plan: string | null; started_at: string; ended_at: string | null; geofence: string | null }>(
    'SELECT org_id, drone_id, mission_id, mission_plan, started_at, ended_at, geofence FROM flights WHERE id = ?',
    flightId,
  );
  if (!f) return null;
  const end = f.ended_at ?? nowIso();
  const auths = db
    .all<{ reference: string; geometry: string; max_alt_m: number; drone_id: string | null; mission_id: string | null; start_at: string; end_at: string; decided_at: string | null }>(
      // The flight's own drone, or an organisation-wide authorisation (no drone) – as the live UTM monitor.
      "SELECT reference, geometry, max_alt_m, drone_id, mission_id, start_at, end_at, decided_at FROM authorizations WHERE org_id = ? AND (drone_id = ? OR drone_id IS NULL) AND status = 'approved' AND start_at <= ? AND end_at >= ?",
      f.org_id,
      f.drone_id,
      end,
      f.started_at,
    )
    .map((a) => ({
      reference: a.reference,
      geometry: parseJson(a.geometry, null as any),
      maxAltM: a.max_alt_m,
      scope: a.drone_id ? ('drone' as const) : ('org' as const),
      missionId: a.mission_id,
      startAt: effectiveStart(a.start_at, a.decided_at),
      endAt: Date.parse(a.end_at),
    }))
    .filter((a) => a.geometry && a.startAt <= a.endAt);
  // Airspace other operators had reserved during the flight (named only when public).
  const reservations = db
    .all<{ reference: string; geometry: string; max_alt_m: number; start_at: string; end_at: string; decided_at: string | null; is_public: number; org_name: string }>(
      `SELECT a.reference, a.geometry, a.max_alt_m, a.start_at, a.end_at, a.decided_at, a.is_public, o.name AS org_name
         FROM authorizations a JOIN organisations o ON o.id = a.org_id
        WHERE a.org_id != ? AND a.status = 'approved' AND a.start_at <= ? AND a.end_at >= ?`,
      f.org_id,
      end,
      f.started_at,
    )
    .map((r) => ({
      label: r.is_public === 1 ? `${r.org_name} (${r.reference})` : 'another operator',
      geometry: parseJson<AuthGeometry | null>(r.geometry, null),
      maxAltM: r.max_alt_m,
      startAt: effectiveStart(r.start_at, r.decided_at),
      endAt: Date.parse(r.end_at),
    }))
    .filter((r): r is typeof r & { geometry: AuthGeometry } => !!r.geometry && r.startAt <= r.endAt);
  const plan = parseJson<MissionPlan | null>(flownPlanJson(db, f)?.plan, null);
  // The geofences the drone enforced (recorded with live flights – also those that flew no
  // mission while one was loaded); otherwise that of the mission flown.
  const periods = parseJson<GeofencePeriod[] | null>(f.geofence, null);
  const result = checkCompliance({
    samples: loadSamples(db, flightId),
    maxAltitudeM: getOrgSettings(db, f.org_id).maxAltitudeM,
    zones: zonesFor(f.org_id),
    authorizations: auths,
    missionId: f.mission_id,
    reservations,
    geofence: periods ? null : (plan?.geofence ?? null),
    geofences: (periods ?? []).flatMap((p, i, all) => (p.fence ? [{ from: p.from, to: all[i + 1]?.from ?? Infinity, fence: p.fence }] : [])),
  });
  db.run('UPDATE flights SET compliance = ? WHERE id = ?', JSON.stringify(result), flightId);
  return result;
}

/** Most recent warning / critical findings of an organisation's flights. */
export function recentAlerts(db: Db, orgId: string, from: string, to: string, fleetId: string | null, limit = 20): AlertDto[] {
  const rows = db.all<any>(
    `SELECT a.flight_id, a.findings, a.computed_at, f.drone_id, d.name AS drone_name, f.started_at
       FROM flight_analyses a JOIN flights f ON f.id = a.flight_id JOIN drones d ON d.id = f.drone_id
      WHERE f.org_id = ? AND f.started_at BETWEEN ? AND ? AND (? IS NULL OR d.fleet_id = ?)
      ORDER BY f.started_at DESC LIMIT 200`,
    orgId,
    from,
    to,
    fleetId,
    fleetId,
  );
  const alerts: AlertDto[] = [];
  for (const r of rows) {
    for (const f of parseJson<{ severity: string; title: string; detail: string }[]>(r.findings, [])) {
      if (f.severity !== 'warning' && f.severity !== 'critical') continue;
      alerts.push({ flightId: r.flight_id, droneId: r.drone_id, droneName: r.drone_name, severity: f.severity, title: f.title, detail: f.detail, at: r.started_at });
    }
  }
  return alerts.sort((a, b) => (a.severity === b.severity ? b.at.localeCompare(a.at) : a.severity === 'critical' ? -1 : 1)).slice(0, limit);
}

/**
 * The flight a log of the drone belongs to, if one is already recorded (live over the link, or
 * from another log of it): the log's middle falls within the flight (±30 s of clock skew), or
 * they overlap by at least half of the shorter one. Consecutive flights stay apart.
 */
export function sameFlightAs(db: Db, droneId: string, startMs: number, endMs: number): string | null {
  const mid = (startMs + endMs) / 2;
  const rows = db.all<{ id: string; started_at: string; ended_at: string | null }>(
    `SELECT id, started_at, ended_at FROM flights WHERE drone_id = ? AND started_at <= ? AND COALESCE(ended_at, ?) >= ? ORDER BY started_at DESC`,
    droneId,
    new Date(endMs + 120_000).toISOString(),
    nowIso(),
    new Date(startMs - 120_000).toISOString(),
  );
  for (const r of rows) {
    const fs = Date.parse(r.started_at);
    const fe = r.ended_at ? Date.parse(r.ended_at) : Date.now();
    const overlap = Math.min(fe, endMs) - Math.max(fs, startMs);
    if ((mid >= fs - 30_000 && mid <= fe + 30_000) || overlap >= 0.5 * Math.max(1, Math.min(fe - fs, endMs - startMs))) return r.id;
  }
  return null;
}
