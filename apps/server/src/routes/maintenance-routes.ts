import type { FastifyInstance } from 'fastify';
import { Type, type Static } from '@sinclair/typebox';
import type { HeatmapDto, ReportSection, TrendDto } from '@athena-sky/shared';
import { HEALTH_INDICATORS, REPORT_SECTIONS, linearTrend, DASHBOARD_WIDGETS } from '@athena-sky/shared';
import { Nullable } from '../lib/schema';
import type { AppContext } from '../context';
import { orgAccess } from '../auth/auth';
import { parseJson } from '../db/database';
import { audit } from '../lib/audit';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { nowIso, resolveRange } from '../lib/util';
import { buildReport, reportCsv, reportHtml } from '../reports/report';
import { samplePagesSteps } from '../flights/flight-service';
import { runSliced } from '../lib/slice';

/** Most samples counted on a heatmap. */
const HEATMAP_POINTS = 400_000;

const Uuid = Type.String({ format: 'uuid' });
const OrgParams = Type.Object({ orgId: Uuid });
const DroneParams = Type.Object({ orgId: Uuid, droneId: Uuid });
const TaskParams = Type.Object({ orgId: Uuid, taskId: Uuid });
const Interval = Type.Optional(Nullable(Type.Number({ exclusiveMinimum: 0, maximum: 100_000 })));
const TaskBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  intervalHours: Interval,
  intervalFlights: Interval,
  intervalDays: Interval,
  notes: Type.Optional(Type.String({ maxLength: 2000 })),
  assigneeId: Type.Optional(Nullable(Uuid)),
});
const TaskPatch = Type.Partial(TaskBody);
const DoneBody = Type.Object({ notes: Type.Optional(Type.String({ maxLength: 2000 })), doneAt: Type.Optional(Type.String({ format: 'date-time' })) });
const RecordBody = Type.Object({ title: Type.String({ minLength: 1, maxLength: 200 }), notes: Type.Optional(Type.String({ maxLength: 2000 })), doneAt: Type.Optional(Type.String({ format: 'date-time' })) });
const ReportQuery = Type.Object({
  from: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
  fleetId: Type.Optional(Uuid),
  droneId: Type.Optional(Uuid),
  pilotId: Type.Optional(Uuid),
  sections: Type.Optional(Type.String({ maxLength: 200 })),
  format: Type.Optional(Type.Union([Type.Literal('json'), Type.Literal('csv'), Type.Literal('html')])),
});
const RangeQuery = Type.Object({ from: Type.Optional(Type.String()), to: Type.Optional(Type.String()), fleetId: Type.Optional(Uuid) });
const TrendQuery = Type.Object({ metric: Type.String({ maxLength: 40 }), from: Type.Optional(Type.String()), to: Type.Optional(Type.String()), fleetId: Type.Optional(Uuid), droneId: Type.Optional(Uuid) });
const PrefParams = Type.Object({ orgId: Uuid, key: Type.String({ pattern: '^[a-z0-9][a-z0-9_.-]{0,39}$' }) });

/** Metrics available for trends: flight-analysis metrics and flight fields. */
const TREND_METRICS: Record<string, { label: string; unit: string; source: 'metric' | 'flight' }> = {
  ...Object.fromEntries(HEALTH_INDICATORS.filter((i) => i.metric !== 'healthScore').map((i) => [i.metric, { label: i.label, unit: i.unit, source: 'metric' as const }])),
  routeMeanM: { label: 'Route deviation', unit: 'm', source: 'metric' },
  healthScore: { label: 'Flight health score', unit: '', source: 'flight' },
  durationS: { label: 'Flight duration', unit: 's', source: 'flight' },
  distanceM: { label: 'Flight distance', unit: 'm', source: 'flight' },
  maxAltM: { label: 'Maximum altitude', unit: 'm', source: 'flight' },
};
const FLIGHT_COLUMN: Record<string, string> = { healthScore: 'health_score', durationS: 'duration_s', distanceM: 'distance_m', maxAltM: 'max_alt_m' };

/** The dashboard layout: `{ widgets: [widget id, …] }` – known widgets, each once (or nothing: the default layout). */
function checkDashboardLayout(value: unknown): void {
  if (value === null) return;
  const widgets = typeof value === 'object' && !Array.isArray(value) ? (value as { widgets?: unknown }).widgets : undefined;
  const known = (w: unknown) => typeof w === 'string' && (DASHBOARD_WIDGETS as readonly string[]).includes(w);
  const ok = Array.isArray(widgets) && widgets.every(known) && new Set(widgets).size === widgets.length;
  if (!ok) throw badRequest(`The dashboard layout is { widgets: [...] } with each widget at most once, of: ${DASHBOARD_WIDGETS.join(', ')}`);
}

export function registerMaintenanceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, maintenance } = ctx;
  const tag = { tags: ['maintenance'] };

  app.get<{ Params: Static<typeof OrgParams> }>('/api/v2/organisations/:orgId/maintenance', { schema: { ...tag, summary: 'Maintenance overview: due tasks and predictive alerts per drone', params: OrgParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId);
    return maintenance.overview(a.orgId);
  });

  app.get<{ Params: Static<typeof DroneParams> }>(
    '/api/v2/organisations/:orgId/drones/:droneId/maintenance',
    { schema: { ...tag, summary: 'Maintenance of a drone: tasks with due state, log and predictive health trends', params: DroneParams } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      return maintenance.droneMaintenance(a.orgId, req.params.droneId);
    },
  );

  app.post<{ Params: Static<typeof DroneParams>; Body: Static<typeof TaskBody> }>(
    '/api/v2/organisations/:orgId/drones/:droneId/maintenance/tasks',
    { schema: { ...tag, summary: 'Schedule a maintenance task (every N flight hours, flights and/or days)', params: DroneParams, body: TaskBody } },
    async (req, reply) => {
      const a = orgAccess(db, req, req.params.orgId, 'drone.manage');
      const t = maintenance.createTask(a.orgId, req.params.droneId, req.body);
      audit(db, a.orgId, a.userId, 'maintenance.task.create', t.id, { name: t.name, droneId: t.droneId });
      reply.code(201);
      return t;
    },
  );

  app.post<{ Params: Static<typeof DroneParams> }>(
    '/api/v2/organisations/:orgId/drones/:droneId/maintenance/default-plan',
    { schema: { ...tag, summary: 'Add the default maintenance plan (inspection, propellers, motors, batteries)', params: DroneParams } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId, 'drone.manage');
      return maintenance.applyDefaultPlan(a.orgId, req.params.droneId);
    },
  );

  app.patch<{ Params: Static<typeof TaskParams>; Body: Static<typeof TaskPatch> }>(
    '/api/v2/organisations/:orgId/maintenance/tasks/:taskId',
    { schema: { ...tag, params: TaskParams, body: TaskPatch } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId, 'drone.manage');
      return maintenance.updateTask(a.orgId, req.params.taskId, req.body);
    },
  );

  app.delete<{ Params: Static<typeof TaskParams> }>('/api/v2/organisations/:orgId/maintenance/tasks/:taskId', { schema: { ...tag, params: TaskParams } }, async (req, reply) => {
    const a = orgAccess(db, req, req.params.orgId, 'drone.manage');
    maintenance.deleteTask(a.orgId, req.params.taskId);
    reply.code(204);
  });

  app.post<{ Params: Static<typeof TaskParams>; Body: Static<typeof DoneBody> }>(
    '/api/v2/organisations/:orgId/maintenance/tasks/:taskId/complete',
    { schema: { ...tag, summary: 'Record that a task was done (restarts its interval); allowed to drone managers and the assignee', params: TaskParams, body: DoneBody } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      const task = db.get<{ assignee_id: string | null }>('SELECT assignee_id FROM maintenance_tasks WHERE id = ? AND org_id = ?', req.params.taskId, a.orgId);
      if (!task) throw notFound('Maintenance task');
      const allowed = task.assignee_id === a.userId || (() => {
        try {
          orgAccess(db, req, req.params.orgId, 'drone.manage');
          return true;
        } catch {
          return false;
        }
      })();
      if (!allowed) throw forbidden('Only drone managers and the assignee can complete this task');
      const t = maintenance.completeTask(a.orgId, req.params.taskId, { id: a.userId }, req.body ?? {});
      audit(db, a.orgId, a.userId, 'maintenance.task.complete', t.id, { name: t.name, droneId: t.droneId });
      return t;
    },
  );

  app.post<{ Params: Static<typeof DroneParams>; Body: Static<typeof RecordBody> }>(
    '/api/v2/organisations/:orgId/drones/:droneId/maintenance/records',
    { schema: { ...tag, summary: 'Log maintenance that is not a scheduled task (repair, part replacement …)', params: DroneParams, body: RecordBody } },
    async (req, reply) => {
      const a = orgAccess(db, req, req.params.orgId, 'drone.manage');
      reply.code(201);
      return maintenance.addRecord(a.orgId, req.params.droneId, { id: a.userId }, req.body);
    },
  );

  // --- Reports ------------------------------------------------------------------------------

  app.get<{ Params: Static<typeof OrgParams>; Querystring: Static<typeof ReportQuery> }>(
    '/api/v2/organisations/:orgId/reports/flights',
    {
      schema: {
        tags: ['reports'],
        summary: 'Compliance & performance report (sections: summary, performance, compliance, maintenance, ai, flights) as JSON, CSV or printable HTML',
        params: OrgParams,
        querystring: ReportQuery,
      },
    },
    async (req, reply) => {
      const a = orgAccess(db, req, req.params.orgId, 'analytics.view');
      const { from, to } = resolveRange(req.query.from, req.query.to, 30, 731);
      const sections = (req.query.sections ? req.query.sections.split(',').map((s) => s.trim()) : []) as ReportSection[];
      const bad = sections.find((s) => !(REPORT_SECTIONS as readonly string[]).includes(s));
      if (bad) throw badRequest(`Unknown report section "${bad}"`);
      const r = buildReport(db, maintenance, a.orgId, { from: from.toISOString(), to: to.toISOString(), fleetId: req.query.fleetId, droneId: req.query.droneId, pilotId: req.query.pilotId, sections });
      const stamp = `${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}`;
      if (req.query.format === 'csv') {
        reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="athena-flights_${stamp}.csv"`);
        return reportCsv({ ...r, flights: r.flights ?? buildReport(db, maintenance, a.orgId, { from: r.range.from, to: r.range.to, fleetId: req.query.fleetId, droneId: req.query.droneId, pilotId: req.query.pilotId, sections: ['flights'] }).flights });
      }
      if (req.query.format === 'html') {
        const org = db.get<{ name: string }>('SELECT name FROM organisations WHERE id = ?', a.orgId)!;
        reply.header('content-type', 'text/html; charset=utf-8').header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
        return reportHtml(r, org.name);
      }
      return r;
    },
  );

  // --- Custom data display: heatmap, trends, preferences --------------------------------------

  app.get<{ Params: Static<typeof OrgParams>; Querystring: Static<typeof RangeQuery> }>(
    '/api/v2/organisations/:orgId/analytics/heatmap',
    { schema: { tags: ['analytics'], summary: 'Flight-activity heatmap: telemetry samples counted on a grid', params: OrgParams, querystring: RangeQuery } },
    async (req): Promise<HeatmapDto> => {
      const a = orgAccess(db, req, req.params.orgId, 'analytics.view');
      const { from, to } = resolveRange(req.query.from, req.query.to, 90, 731);
      // Airborne samples of the flights in the period (the most recent first), at most
      // HEATMAP_POINTS of them, read a page at a time: a busy organisation's heatmap never
      // stalls the server.
      const flights = db.all<{ id: string }>(
        `SELECT f.id FROM flights f JOIN drones d ON d.id = f.drone_id
          WHERE f.org_id = ? AND f.started_at >= ? AND f.started_at <= ? AND (? IS NULL OR d.fleet_id = ?)
          ORDER BY f.started_at DESC`,
        a.orgId,
        from.toISOString(),
        to.toISOString(),
        req.query.fleetId ?? null,
        req.query.fleetId ?? null,
      );
      const lats = new Float64Array(HEATMAP_POINTS);
      const lons = new Float64Array(HEATMAP_POINTS);
      let n = 0;
      const full = () => n >= HEATMAP_POINTS;
      for (const f of flights) {
        if (full()) break;
        await runSliced(
          samplePagesSteps(
            db,
            f.id,
            (r) => {
              if (full()) return;
              lats[n] = r.lat;
              lons[n] = r.lon;
              n++;
            },
            { columns: 'lat, lon', where: 'alt_rel > 1', done: full },
          ),
        );
      }
      // ~50 m cells (finer for small areas).
      let minLat = Infinity;
      let maxLat = -Infinity;
      for (let i = 0; i < n; i++) {
        minLat = Math.min(minLat, lats[i]!);
        maxLat = Math.max(maxLat, lats[i]!);
      }
      const span = n ? maxLat - minLat : 0;
      const cell = span > 0.5 ? 0.005 : span > 0.05 ? 0.001 : 0.0005;
      const grid = new Map<string, { lat: number; lon: number; count: number }>();
      await runSliced(
        (function* () {
          for (let i = 0; i < n; i++) {
            if ((i & 8191) === 8191) yield;
            const gy = Math.floor(lats[i]! / cell);
            const gx = Math.floor(lons[i]! / cell);
            const k = `${gy}:${gx}`;
            const c = grid.get(k);
            if (c) c.count++;
            else grid.set(k, { lat: (gy + 0.5) * cell, lon: (gx + 0.5) * cell, count: 1 });
          }
        })(),
      );
      const cells = [...grid.values()].map((c) => ({ lat: Math.round(c.lat * 1e6) / 1e6, lon: Math.round(c.lon * 1e6) / 1e6, count: c.count }));
      return { cellDeg: cell, cells, max: cells.reduce((m, c) => Math.max(m, c.count), 0), points: n };
    },
  );

  app.get<{ Params: Static<typeof OrgParams>; Querystring: Static<typeof TrendQuery> }>(
    '/api/v2/organisations/:orgId/analytics/trends',
    { schema: { tags: ['analytics'], summary: 'Trend of a per-flight metric with anomalies (robust z-score) and daily means', params: OrgParams, querystring: TrendQuery } },
    async (req): Promise<TrendDto> => {
      const a = orgAccess(db, req, req.params.orgId, 'analytics.view');
      const m = TREND_METRICS[req.query.metric];
      if (!m) throw badRequest(`Unknown metric; one of ${Object.keys(TREND_METRICS).join(', ')}`);
      const { from, to } = resolveRange(req.query.from, req.query.to, 90, 731);
      const rows = db.all<{ id: string; started_at: string; drone_name: string; metrics: string | null; v: number | null }>(
        `SELECT f.id, f.started_at, d.name AS drone_name, a.metrics, ${m.source === 'flight' ? `f.${FLIGHT_COLUMN[req.query.metric]}` : 'NULL'} AS v
           FROM flights f JOIN drones d ON d.id = f.drone_id LEFT JOIN flight_analyses a ON a.flight_id = f.id
          WHERE f.org_id = ? AND f.started_at >= ? AND f.started_at <= ? AND (? IS NULL OR d.fleet_id = ?) AND (? IS NULL OR f.drone_id = ?)
          ORDER BY f.started_at`,
        a.orgId,
        from.toISOString(),
        to.toISOString(),
        req.query.fleetId ?? null,
        req.query.fleetId ?? null,
        req.query.droneId ?? null,
        req.query.droneId ?? null,
      );
      const vals = rows
        .map((r) => ({ r, value: m.source === 'flight' ? r.v : parseJson<Record<string, number>>(r.metrics, {})[req.query.metric] }))
        .filter((x): x is { r: (typeof rows)[number]; value: number } => typeof x.value === 'number' && Number.isFinite(x.value));
      // Robust z-score (median / MAD): one bad flight does not hide the others.
      const sorted = vals.map((v) => v.value).sort((x, y) => x - y);
      const med = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
      const mad = sorted.length ? [...sorted.map((v) => Math.abs(v - med))].sort((x, y) => x - y)[Math.floor(sorted.length / 2)]! : 0;
      const scale = Math.max(1.4826 * mad, Math.abs(med) * 0.02, 1e-9);
      const points = vals.map(({ r, value }) => {
        const z = (value - med) / scale;
        return { flightId: r.id, at: r.started_at, droneName: r.drone_name, value: Math.round(value * 1000) / 1000, z: Math.round(z * 100) / 100, anomaly: Math.abs(z) > 3.5 && vals.length >= 8 };
      });
      const days = new Map<string, number[]>();
      for (const p of points) days.set(p.at.slice(0, 10), [...(days.get(p.at.slice(0, 10)) ?? []), p.value]);
      const daily = [...days.entries()].map(([day, v]) => ({ day, mean: Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 1000) / 1000, n: v.length }));
      const t0 = points.length ? Date.parse(points[0]!.at) : 0;
      const tr = linearTrend(points.map((p) => ({ x: (Date.parse(p.at) - t0) / 86_400_000, y: p.value })));
      return { metric: req.query.metric, label: m.label, unit: m.unit, points, daily, trend: tr ? { slopePerDay: Math.round(tr.slope * 10000) / 10000, r2: Math.round(tr.r2 * 1000) / 1000 } : null };
    },
  );

  app.get<{ Params: Static<typeof PrefParams> }>('/api/v2/organisations/:orgId/preferences/:key', { schema: { tags: ['preferences'], summary: 'A preference of the current user (e.g. the dashboard layout)', params: PrefParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId);
    const r = db.get<{ value: string; updated_at: string }>('SELECT value, updated_at FROM user_preferences WHERE user_id = ? AND org_id = ? AND key = ?', a.userId, a.orgId, req.params.key);
    return { key: req.params.key, value: r ? parseJson(r.value, null) : null, updatedAt: r?.updated_at ?? null };
  });

  app.put<{ Params: Static<typeof PrefParams>; Body: { value: unknown } }>(
    '/api/v2/organisations/:orgId/preferences/:key',
    { schema: { tags: ['preferences'], params: PrefParams, body: Type.Object({ value: Type.Unknown() }) } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      const json = JSON.stringify(req.body.value ?? null);
      if (json.length > 20_000) throw badRequest('Preference value too large');
      if (req.params.key === 'dashboard') checkDashboardLayout(req.body.value ?? null);
      const now = nowIso();
      db.run(
        'INSERT INTO user_preferences (user_id, org_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, org_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        a.userId,
        a.orgId,
        req.params.key,
        json,
        now,
      );
      return { key: req.params.key, value: req.body.value ?? null, updatedAt: now };
    },
  );
}
