import type { FastifyInstance } from 'fastify';
import { Type, type Static } from '@sinclair/typebox';
import type {
  DashboardDto,
  DroneStatsDto,
  DronesOperatorsDto,
  FlightLocationsDto,
  LocationPointDto,
  OperatorStatsDto,
} from '@athena-sky/shared';
import { can, dayKey } from '@athena-sky/shared';
import type { AppContext } from '../context';
import { orgAccess } from '../auth/auth';
import { parseJson } from '../db/database';
import { resolveRange } from '../lib/util';
import { FLIGHT_SELECT, flightDto, recentAlerts } from '../flights/flight-service';

const OrgParams = Type.Object({ orgId: Type.String({ format: 'uuid' }) });
const RangeQuery = Type.Object({
  from: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
  fleetId: Type.Optional(Type.String({ format: 'uuid' })),
});
type Q = Static<typeof RangeQuery>;

const tag = { tags: ['analytics'] };

export function registerAnalyticsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, hub } = ctx;

  const droneStats = (orgId: string, from: string, to: string, fleetId: string | null): DroneStatsDto[] =>
    db
      .all<any>(
        `SELECT d.id, d.name, fl.name AS fleet_name,
                COUNT(f.id) AS flights, COALESCE(SUM(f.duration_s), 0) AS flight_time, COALESCE(SUM(f.distance_m), 0) AS distance,
                MAX(f.started_at) AS last_flight, AVG(f.health_score) AS health, COUNT(DISTINCT f.pilot_id) AS pilots
           FROM drones d
           LEFT JOIN fleets fl ON fl.id = d.fleet_id
           LEFT JOIN flights f ON f.drone_id = d.id AND f.started_at BETWEEN ? AND ?
          WHERE d.org_id = ? AND (? IS NULL OR d.fleet_id = ?)
          GROUP BY d.id ORDER BY flight_time DESC, flights DESC, d.name`,
        from,
        to,
        orgId,
        fleetId,
        fleetId,
      )
      .map((r) => ({
        droneId: r.id,
        name: r.name,
        fleetName: r.fleet_name ?? null,
        flights: r.flights,
        flightTimeS: r.flight_time,
        distanceM: r.distance,
        lastFlightAt: r.last_flight ?? null,
        avgDurationS: r.flights ? r.flight_time / r.flights : 0,
        avgHealthScore: r.health === null ? null : Math.round(r.health),
        pilots: r.pilots,
      }));

  const operatorStats = (orgId: string, from: string, to: string, fleetId: string | null): OperatorStatsDto[] =>
    db
      .all<any>(
        `SELECT u.id, u.name, u.email, m.role,
                COUNT(f.id) AS flights, COALESCE(SUM(f.duration_s), 0) AS flight_time, COALESCE(SUM(f.distance_m), 0) AS distance,
                MAX(f.started_at) AS last_flight, COUNT(DISTINCT f.drone_id) AS drones, COALESCE(MAX(f.duration_s), 0) AS longest
           FROM memberships m
           JOIN users u ON u.id = m.user_id
           LEFT JOIN flights f ON f.pilot_id = u.id AND f.org_id = m.org_id AND f.started_at BETWEEN ? AND ?
                AND (? IS NULL OR f.drone_id IN (SELECT id FROM drones WHERE fleet_id = ?))
          WHERE m.org_id = ?
          GROUP BY u.id ORDER BY flight_time DESC, flights DESC, u.name`,
        from,
        to,
        fleetId,
        fleetId,
        orgId,
      )
      .filter((r) => r.flights > 0 || can(r.role, 'drone.control'))
      .map((r) => ({
        userId: r.id,
        name: r.name,
        email: r.email,
        flights: r.flights,
        flightTimeS: r.flight_time,
        distanceM: r.distance,
        lastFlightAt: r.last_flight ?? null,
        dronesFlown: r.drones,
        longestFlightS: r.longest,
      }));

  app.get<{ Params: Static<typeof OrgParams>; Querystring: Q }>(
    '/api/v2/organisations/:orgId/analytics/dashboard',
    { schema: { ...tag, summary: 'Dashboard: assets, users, flights and fleet performance (filter by period and fleet)', params: OrgParams, querystring: RangeQuery } },
    async (req): Promise<DashboardDto> => {
      const a = orgAccess(db, req, req.params.orgId, 'analytics.view');
      // The dashboard builds one entry per day: limit it to a year.
      const { from, to } = resolveRange(req.query.from, req.query.to, 30, 366);
      const f = from.toISOString();
      const t = to.toISOString();
      const fleetId = req.query.fleetId || null;
      const agg = db.get<any>(
        `SELECT COUNT(*) AS flights, COALESCE(SUM(f.duration_s), 0) AS time, COALESCE(SUM(f.distance_m), 0) AS dist
           FROM flights f JOIN drones d ON d.id = f.drone_id
          WHERE f.org_id = ? AND f.started_at BETWEEN ? AND ? AND (? IS NULL OR d.fleet_id = ?)`,
        a.orgId,
        f,
        t,
        fleetId,
        fleetId,
      )!;
      const drones = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM drones WHERE org_id = ? AND (? IS NULL OR fleet_id = ?)', a.orgId, fleetId, fleetId)!.n;
      const members = db.all<{ role: string }>('SELECT role FROM memberships WHERE org_id = ?', a.orgId);
      const fleetDroneIds = new Set(db.all<{ id: string }>('SELECT id FROM drones WHERE org_id = ? AND (? IS NULL OR fleet_id = ?)', a.orgId, fleetId, fleetId).map((r) => r.id));
      const live = hub.orgDroneStates(a.orgId).filter((d) => d.online && fleetDroneIds.has(d.droneId));
      const onlineUsers = hub.onlineUsers(a.orgId);
      const perDay = new Map<string, { flights: number; flightTimeS: number }>();
      for (let d = new Date(dayKey(from)); d.getTime() <= to.getTime(); d = new Date(d.getTime() + 86_400_000)) perDay.set(dayKey(d), { flights: 0, flightTimeS: 0 });
      for (const r of db.all<any>(
        `SELECT substr(f.started_at, 1, 10) AS day, COUNT(*) AS n, COALESCE(SUM(f.duration_s), 0) AS time
           FROM flights f JOIN drones d ON d.id = f.drone_id
          WHERE f.org_id = ? AND f.started_at BETWEEN ? AND ? AND (? IS NULL OR d.fleet_id = ?) GROUP BY day`,
        a.orgId,
        f,
        t,
        fleetId,
        fleetId,
      )) {
        perDay.set(r.day, { flights: r.n, flightTimeS: r.time });
      }
      const alerts = recentAlerts(db, a.orgId, f, t, fleetId);
      const recent = db
        .all(`${FLIGHT_SELECT} WHERE f.org_id = ? AND f.started_at BETWEEN ? AND ? AND (? IS NULL OR d.fleet_id = ?) ORDER BY f.started_at DESC LIMIT 10`, a.orgId, f, t, fleetId, fleetId)
        .map(flightDto);
      return {
        range: { from: f, to: t },
        fleetId,
        totals: {
          drones,
          members: members.length,
          pilots: members.filter((m) => can(m.role as never, 'drone.control')).length,
          flights: agg.flights,
          flightTimeS: agg.time,
          distanceM: agg.dist,
          avgFlightS: agg.flights ? agg.time / agg.flights : 0,
          dronesOnline: live.length,
          // Online: a live connection, or the person asking (whose live connection may still be opening).
          pilotsOnline: new Set([...onlineUsers.filter((u) => can(u.role as never, 'drone.control')).map((u) => u.userId), ...(can(a.role, 'drone.control') ? [a.userId] : [])]).size,
          flightsInProgress: live.filter((d) => d.flightId).length,
          alerts: alerts.length,
        },
        flightsPerDay: [...perDay.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([date, v]) => ({ date, ...v })),
        topDrones: droneStats(a.orgId, f, t, fleetId).slice(0, 5),
        topPilots: operatorStats(a.orgId, f, t, fleetId).slice(0, 5),
        recentFlights: recent,
        alerts,
      };
    },
  );

  app.get<{ Params: Static<typeof OrgParams>; Querystring: Q }>(
    '/api/v2/organisations/:orgId/analytics/drones-operators',
    { schema: { ...tag, summary: 'Drone and pilot analytics (most used drone, most experienced pilot, …)', params: OrgParams, querystring: RangeQuery } },
    async (req): Promise<DronesOperatorsDto> => {
      const a = orgAccess(db, req, req.params.orgId, 'analytics.view');
      const { from, to } = resolveRange(req.query.from, req.query.to, 365);
      const fleetId = req.query.fleetId || null;
      const drones = droneStats(a.orgId, from.toISOString(), to.toISOString(), fleetId);
      const operators = operatorStats(a.orgId, from.toISOString(), to.toISOString(), fleetId);
      const byHours = [...operators].sort((x, y) => y.flightTimeS - x.flightTimeS);
      const byFlights = [...operators].sort((x, y) => y.flights - x.flights);
      return {
        range: { from: from.toISOString(), to: to.toISOString() },
        drones,
        operators,
        highlights: {
          mostUsedDrone: drones.find((d) => d.flights > 0) ?? null,
          mostExperiencedPilot: byHours[0]?.flights ? byHours[0] : null,
          mostActivePilot: byFlights[0]?.flights ? byFlights[0] : null,
        },
      };
    },
  );

  app.get<{ Params: Static<typeof OrgParams>; Querystring: Q & { compliance?: string } }>(
    '/api/v2/organisations/:orgId/analytics/locations',
    { schema: { ...tag, summary: 'Flight locations with compliance status (filter by period and fleet)', params: OrgParams } },
    async (req): Promise<FlightLocationsDto> => {
      const a = orgAccess(db, req, req.params.orgId, 'analytics.view');
      const { from, to } = resolveRange(req.query.from, req.query.to, 90);
      const fleetId = req.query.fleetId || null;
      const rows = db.all<any>(
        `${FLIGHT_SELECT} WHERE f.org_id = ? AND f.started_at BETWEEN ? AND ? AND (? IS NULL OR d.fleet_id = ?) AND f.start_lat IS NOT NULL
         ORDER BY f.started_at DESC LIMIT 2000`,
        a.orgId,
        from.toISOString(),
        to.toISOString(),
        fleetId,
        fleetId,
      );
      const points: LocationPointDto[] = rows.map((r) => {
        const fd = flightDto(r);
        const track = db
          .all<{ lat: number; lon: number }>('SELECT lat, lon FROM flight_samples WHERE flight_id = ? ORDER BY t', r.id)
          .filter((_, i, arr) => i % Math.max(1, Math.ceil(arr.length / 100)) === 0)
          .map((p) => [p.lat, p.lon] as [number, number]);
        const compliance = parseJson<{ compliant: boolean; violations: { message: string }[] } | null>(r.compliance, null);
        return {
          flightId: fd.id,
          droneId: fd.droneId,
          droneName: fd.droneName,
          pilotName: fd.pilotName,
          lat: fd.startLat!,
          lon: fd.startLon!,
          startedAt: fd.startedAt,
          durationS: fd.durationS,
          maxAltM: fd.maxAltM,
          compliant: compliance ? compliance.compliant : null,
          violations: compliance?.violations.map((v) => v.message) ?? [],
          track,
        };
      });
      const filter = req.query.compliance;
      const filtered = filter === 'compliant' ? points.filter((p) => p.compliant === true) : filter === 'non_compliant' ? points.filter((p) => p.compliant === false) : points;
      return {
        range: { from: from.toISOString(), to: to.toISOString() },
        points: filtered,
        summary: {
          flights: points.length,
          compliant: points.filter((p) => p.compliant === true).length,
          nonCompliant: points.filter((p) => p.compliant === false).length,
          unchecked: points.filter((p) => p.compliant === null).length,
        },
      };
    },
  );
}
