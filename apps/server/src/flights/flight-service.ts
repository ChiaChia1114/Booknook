import type {
  AirspaceZoneDto,
  AlertDto,
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
import { missionPath, normalizePlan, routeDeviation, type AnalysisFinding } from '@athena-sky/shared';
import { checkCompliance } from './compliance';
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

/**
 * Route conformance of a mission flight: cross-track error of the flown track against the
 * planned route, time outside the tolerance and how much of the route was flown.
 */
export function routeConformance(plan: MissionPlan, samples: FlightSampleDto[]): { metrics: Record<string, number>; findings: AnalysisFinding[] } | null {
  const dev = routeDeviation(
    missionPath(plan),
    samples.map((s) => ({ t: s.t, lat: s.lat, lon: s.lon, altRel: s.altRel })),
    ROUTE_TOLERANCE_M,
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
  return { metrics, findings };
}

export function runAnalysis(db: Db, flightId: string): FlightAnalysisDto | null {
  const f = db.get<{ id: string; drone_id: string; started_at: string; mission_id: string | null }>('SELECT id, drone_id, started_at, mission_id FROM flights WHERE id = ?', flightId);
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
  const mission = f.mission_id ? db.get<{ plan: string }>('SELECT plan FROM missions WHERE id = ?', f.mission_id) : undefined;
  if (mission) {
    let plan: MissionPlan | null = null;
    try {
      plan = normalizePlan(parseJson(mission.plan, {}));
    } catch {
      plan = null;
    }
    const rc = plan ? routeConformance(plan, samples) : null;
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

/** Runs the compliance check and stores it on the flight. */
export function runCompliance(db: Db, flightId: string, zonesFor: (orgId: string) => AirspaceZoneDto[] = (orgId) => listZones(db, orgId)) {
  const f = db.get<{ org_id: string; drone_id: string; mission_id: string | null; started_at: string; ended_at: string | null }>(
    'SELECT org_id, drone_id, mission_id, started_at, ended_at FROM flights WHERE id = ?',
    flightId,
  );
  if (!f) return null;
  const end = f.ended_at ?? nowIso();
  const auths = db
    .all<{ reference: string; geometry: string; max_alt_m: number }>(
      "SELECT reference, geometry, max_alt_m FROM authorizations WHERE drone_id = ? AND status = 'approved' AND start_at <= ? AND end_at >= ?",
      f.drone_id,
      end,
      f.started_at,
    )
    .map((a) => ({ reference: a.reference, geometry: parseJson(a.geometry, null as any), maxAltM: a.max_alt_m }))
    .filter((a) => a.geometry);
  const plan = f.mission_id ? parseJson<MissionPlan | null>(db.get<{ plan: string }>('SELECT plan FROM missions WHERE id = ?', f.mission_id)?.plan, null) : null;
  const result = checkCompliance({
    samples: loadSamples(db, flightId),
    maxAltitudeM: getOrgSettings(db, f.org_id).maxAltitudeM,
    zones: zonesFor(f.org_id),
    authorizations: auths,
    geofence: plan?.geofence ?? null,
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
