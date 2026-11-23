/**
 * Compliance and performance reports over a period (filter by fleet, drone, pilot; choose the
 * sections), as JSON for the web app, CSV (one row per flight) or a printable HTML document.
 */
import type { ComplianceDto, ReportDto, ReportFlightRow, ReportPerformanceRow, ReportSection } from '@athena-sky/shared';
import { REPORT_SECTIONS } from '@athena-sky/shared';
import type { Db } from '../db/database';
import { csvCell } from '../lib/csv';
import { parseJson } from '../db/database';
import type { MaintenanceService } from '../maintenance/maintenance-service';

export interface ReportOptions {
  from: string;
  to: string;
  fleetId?: string | null;
  droneId?: string | null;
  pilotId?: string | null;
  sections?: ReportSection[];
}

interface FlightRow {
  id: string;
  drone_id: string;
  drone_name: string;
  pilot_id: string | null;
  pilot_name: string | null;
  mission_id: string | null;
  mission_name: string | null;
  started_at: string;
  duration_s: number;
  distance_m: number;
  max_alt_m: number;
  battery_start: number | null;
  battery_end: number | null;
  health_score: number | null;
  compliance: string | null;
  metrics: string | null;
  findings: string | null;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

export function buildReport(db: Db, maintenance: MaintenanceService, orgId: string, opts: ReportOptions): ReportDto {
  const sections = opts.sections?.length ? opts.sections : [...REPORT_SECTIONS];
  const rows = db.all<FlightRow>(
    `SELECT f.id, f.drone_id, d.name AS drone_name, f.pilot_id, u.name AS pilot_name, f.mission_id, m.name AS mission_name, f.started_at,
            f.duration_s, f.distance_m, f.max_alt_m, f.battery_start, f.battery_end, f.health_score, f.compliance, a.metrics, a.findings
       FROM flights f JOIN drones d ON d.id = f.drone_id LEFT JOIN users u ON u.id = f.pilot_id LEFT JOIN missions m ON m.id = f.mission_id
       LEFT JOIN flight_analyses a ON a.flight_id = f.id
      WHERE f.org_id = ? AND f.started_at >= ? AND f.started_at <= ?
        AND (? IS NULL OR d.fleet_id = ?) AND (? IS NULL OR f.drone_id = ?) AND (? IS NULL OR f.pilot_id = ?)
      ORDER BY f.started_at`,
    orgId,
    opts.from,
    opts.to,
    opts.fleetId ?? null,
    opts.fleetId ?? null,
    opts.droneId ?? null,
    opts.droneId ?? null,
    opts.pilotId ?? null,
    opts.pilotId ?? null,
  );
  const flights: (ReportFlightRow & { droneId: string; pilotId: string | null; warnings: number; criticals: number; batteryRate: number | null; overdue: string[]; violations: string[]; durationS: number; distanceM: number })[] = rows.map((f) => {
    const metrics = parseJson<Record<string, number>>(f.metrics, {});
    const findings = parseJson<{ severity: string; code: string }[]>(f.findings, []);
    const compliance = parseJson<ComplianceDto | null>(f.compliance, null);
    const violations = (compliance?.violations ?? []).map((v) => v.type);
    const overdue = maintenance.overdueAt(f.drone_id, f.started_at);
    const issues = [...(compliance?.violations ?? []).map((v) => v.message), ...overdue.map((n) => `Flown with overdue maintenance: ${n}`)];
    return {
      id: f.id,
      droneId: f.drone_id,
      pilotId: f.pilot_id,
      startedAt: f.started_at,
      droneName: f.drone_name,
      pilotName: f.pilot_name ?? null,
      missionName: f.mission_name ?? null,
      durationMin: r1(f.duration_s / 60),
      distanceKm: r2(f.distance_m / 1000),
      maxAltM: Math.round(f.max_alt_m),
      batteryUsedPct: f.battery_start !== null && f.battery_end !== null ? r1(f.battery_start - f.battery_end) : null,
      healthScore: f.health_score,
      routeMeanM: Number.isFinite(metrics.routeMeanM) ? metrics.routeMeanM! : null,
      routeOutsidePct: Number.isFinite(metrics.routeOutsidePct) ? metrics.routeOutsidePct! : null,
      issues,
      warnings: findings.filter((x) => x.severity === 'warning').length,
      criticals: findings.filter((x) => x.severity === 'critical').length,
      batteryRate: Number.isFinite(metrics.batteryRatePctPerMin) ? metrics.batteryRatePctPerMin! : null,
      overdue,
      violations,
      // Unrounded: totals are sums of these, rounded once (not sums of rounded rows).
      durationS: f.duration_s,
      distanceM: f.distance_m,
    };
  });
  const totalS = (fs: typeof flights) => fs.reduce((s, f) => s + f.durationS, 0);
  const totalM = (fs: typeof flights) => fs.reduce((s, f) => s + f.distanceM, 0);
  const out: ReportDto = { generatedAt: new Date().toISOString(), range: { from: opts.from, to: opts.to }, filters: { fleetId: opts.fleetId ?? null, droneId: opts.droneId ?? null, pilotId: opts.pilotId ?? null }, sections };
  const health = flights.map((f) => f.healthScore).filter((v): v is number => v !== null);
  if (sections.includes('summary')) {
    out.summary = {
      flights: flights.length,
      hours: r1(totalS(flights) / 3600),
      distanceKm: r2(totalM(flights) / 1000),
      drones: new Set(flights.map((f) => f.droneId)).size,
      pilots: new Set(flights.map((f) => f.pilotId).filter(Boolean)).size,
      avgDurationMin: flights.length ? r1(totalS(flights) / 60 / flights.length) : 0,
      missionFlights: flights.filter((f) => f.missionName).length,
      avgHealth: health.length ? r1(avg(health)!) : null,
    };
  }
  if (sections.includes('performance')) {
    const group = (key: (f: (typeof flights)[number]) => string | null, name: (f: (typeof flights)[number]) => string): ReportPerformanceRow[] => {
      const by = new Map<string, typeof flights>();
      for (const f of flights) {
        const k = key(f);
        if (!k) continue;
        by.set(k, [...(by.get(k) ?? []), f]);
      }
      return [...by.entries()]
        .map(([id, fs]) => {
          const h = fs.map((f) => f.healthScore).filter((v): v is number => v !== null);
          const br = fs.map((f) => f.batteryRate).filter((v): v is number => v !== null);
          const rm = fs.map((f) => f.routeMeanM).filter((v): v is number => v !== null);
          const ro = fs.map((f) => f.routeOutsidePct).filter((v): v is number => v !== null);
          return {
            id,
            name: name(fs[0]!),
            flights: fs.length,
            hours: r1(totalS(fs) / 3600),
            distanceKm: r2(totalM(fs) / 1000),
            avgHealth: h.length ? r1(avg(h)!) : null,
            avgBatteryRatePctPerMin: br.length ? r2(avg(br)!) : null,
            missionFlights: fs.filter((f) => f.missionName).length,
            routeMeanM: rm.length ? r1(avg(rm)!) : null,
            routeOutsidePct: ro.length ? r1(avg(ro)!) : null,
            warnings: fs.reduce((s, f) => s + f.warnings, 0),
            criticals: fs.reduce((s, f) => s + f.criticals, 0),
          };
        })
        .sort((a, b) => b.hours - a.hours);
    };
    out.performance = { byDrone: group((f) => f.droneId, (f) => f.droneName), byPilot: group((f) => f.pilotId, (f) => f.pilotName ?? 'Unknown') };
  }
  if (sections.includes('compliance')) {
    const types = new Map<string, number>();
    for (const f of flights) for (const v of f.violations) types.set(v, (types.get(v) ?? 0) + 1);
    const overdueFlights = flights.filter((f) => f.overdue.length).length;
    if (overdueFlights) types.set('maintenance', overdueFlights);
    const withIssues = flights.filter((f) => f.issues.length).length;
    const utm = db.all<{ code: string; n: number }>(
      `SELECT n.code, COUNT(*) AS n FROM notifications n LEFT JOIN drones d ON d.id = n.drone_id
        WHERE n.org_id = ? AND n.category IN ('airspace', 'altitude', 'separation', 'traffic') AND n.created_at >= ? AND n.created_at <= ?
          AND (? IS NULL OR d.fleet_id = ?) AND (? IS NULL OR n.drone_id = ?)
          AND (? IS NULL OR EXISTS (SELECT 1 FROM flights f WHERE f.drone_id = n.drone_id AND f.pilot_id = ?
                                     AND f.started_at <= n.created_at AND COALESCE(f.ended_at, n.created_at) >= n.created_at))
        GROUP BY n.code ORDER BY n DESC`,
      orgId,
      opts.from,
      opts.to,
      opts.fleetId ?? null,
      opts.fleetId ?? null,
      opts.droneId ?? null,
      opts.droneId ?? null,
      opts.pilotId ?? null,
      opts.pilotId ?? null,
    );
    out.compliance = {
      flightsWithIssues: withIssues,
      compliantPct: flights.length ? r1(((flights.length - withIssues) / flights.length) * 100) : 100,
      issues: [...types.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
      utmAlerts: utm.map((u) => ({ code: u.code, count: u.n })),
      overdueMaintenanceFlights: overdueFlights,
    };
  }
  if (sections.includes('maintenance')) {
    const ov = maintenance.overview(orgId);
    const scope = new Set(
      db
        .all<{ id: string }>('SELECT id FROM drones WHERE org_id = ? AND (? IS NULL OR fleet_id = ?) AND (? IS NULL OR id = ?)', orgId, opts.fleetId ?? null, opts.fleetId ?? null, opts.droneId ?? null, opts.droneId ?? null)
        .map((d) => d.id),
    );
    const tasks: { droneName: string; name: string; status: string; remaining: string }[] = [];
    for (const d of ov.drones.filter((x) => scope.has(x.droneId))) {
      for (const t of maintenance.tasks(orgId, d.droneId)) {
        const left = (v: number, unit: string) => (v < 0 ? `${Math.abs(v)} ${unit} overdue` : `${v} ${unit} left`);
        const rem =
          t.due.driver === 'hours'
            ? left(t.due.remainingHours ?? 0, 'h')
            : t.due.driver === 'flights'
              ? left(t.due.remainingFlights ?? 0, 'flights')
              : t.due.driver === 'days'
                ? left(Math.round(t.due.remainingDays ?? 0), 'days')
                : '—';
        tasks.push({ droneName: d.droneName, name: t.name, status: t.due.status, remaining: rem });
      }
    }
    out.maintenance = { overdue: tasks.filter((t) => t.status === 'overdue').length, dueSoon: tasks.filter((t) => t.status === 'due_soon').length, tasks };
  }
  if (sections.includes('ai')) {
    const ids = flights.map((f) => f.id);
    const counts = new Map<string, number>();
    const withDet = new Set<string>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      if (!chunk.length) continue;
      for (const r of db.all<{ flight_id: string; data: string }>(`SELECT flight_id, data FROM payload_records WHERE kind = 'ai.detection' AND flight_id IN (${chunk.map(() => '?').join(',')})`, ...chunk)) {
        const cls = String(parseJson<{ cls?: string }>(r.data, {}).cls ?? 'object');
        counts.set(cls, (counts.get(cls) ?? 0) + 1);
        withDet.add(r.flight_id);
      }
    }
    out.ai = { detections: [...counts.entries()].map(([cls, count]) => ({ cls, count })).sort((a, b) => b.count - a.count), flightsWithDetections: withDet.size };
  }
  if (sections.includes('flights')) {
    out.flights = flights.map(({ droneId: _d, pilotId: _p, warnings: _w, criticals: _c, batteryRate: _b, overdue: _o, violations: _v, durationS: _ds, distanceM: _dm, ...row }) => row);
  }
  return out;
}

/** One row per flight. */
export function reportCsv(r: ReportDto): string {
  const head = ['Started (UTC)', 'Drone', 'Pilot', 'Mission', 'Duration (min)', 'Distance (km)', 'Max altitude (m)', 'Battery used (%)', 'Health score', 'Route mean deviation (m)', 'Time off route (%)', 'Issues'];
  const lines = (r.flights ?? []).map((f) =>
    [f.startedAt, f.droneName, f.pilotName, f.missionName, f.durationMin, f.distanceKm, f.maxAltM, f.batteryUsedPct, f.healthScore, f.routeMeanM, f.routeOutsidePct, f.issues.join('; ')].map((v) => csvCell(v)).join(','),
  );
  return [head.join(','), ...lines].join('\n') + '\n';
}

const esc = (v: unknown) =>
  String(v ?? '—')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Self-contained printable report (print to PDF from the browser). */
export function reportHtml(r: ReportDto, orgName: string): string {
  const table = (head: string[], rows: unknown[][]) =>
    `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map((row) => `<tr>${row.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${head.length}">No data</td></tr>`}</tbody></table>`;
  const perf = (rows: ReportPerformanceRow[]) =>
    table(
      ['Name', 'Flights', 'Hours', 'Distance (km)', 'Avg health', 'Battery %/min', 'Mission flights', 'Route dev. (m)', 'Off route (%)', 'Warnings', 'Critical'],
      rows.map((p) => [p.name, p.flights, p.hours, p.distanceKm, p.avgHealth, p.avgBatteryRatePctPerMin, p.missionFlights, p.routeMeanM, p.routeOutsidePct, p.warnings, p.criticals]),
    );
  const parts: string[] = [];
  if (r.summary) {
    const s = r.summary;
    parts.push(`<h2>Summary</h2>${table(['Flights', 'Flight hours', 'Distance (km)', 'Drones', 'Pilots', 'Avg duration (min)', 'Mission flights', 'Avg health'], [[s.flights, s.hours, s.distanceKm, s.drones, s.pilots, s.avgDurationMin, s.missionFlights, s.avgHealth]])}`);
  }
  if (r.performance) parts.push(`<h2>Performance by drone</h2>${perf(r.performance.byDrone)}<h2>Performance by pilot</h2>${perf(r.performance.byPilot)}`);
  if (r.compliance) {
    const c = r.compliance;
    parts.push(
      `<h2>Compliance</h2><p>${esc(c.compliantPct)} % of flights without issues · ${esc(c.flightsWithIssues)} with issues · ${esc(c.overdueMaintenanceFlights)} flown with overdue maintenance.</p>${table(
        ['Issue', 'Flights'],
        c.issues.map((i) => [i.type, i.count]),
      )}<h3>Real-time UTM alerts</h3>${table(
        ['Alert', 'Count'],
        c.utmAlerts.map((u) => [u.code, u.count]),
      )}`,
    );
  }
  if (r.maintenance) parts.push(`<h2>Maintenance</h2><p>${esc(r.maintenance.overdue)} overdue · ${esc(r.maintenance.dueSoon)} due soon.</p>${table(['Drone', 'Task', 'Status', 'Remaining'], r.maintenance.tasks.map((t) => [t.droneName, t.name, t.status, t.remaining]))}`);
  if (r.ai) parts.push(`<h2>AI detections</h2><p>${esc(r.ai.flightsWithDetections)} flights with detections.</p>${table(['Class', 'Objects'], r.ai.detections.map((d) => [d.cls, d.count]))}`);
  if (r.flights) {
    parts.push(
      `<h2>Flights</h2>${table(
        ['Started (UTC)', 'Drone', 'Pilot', 'Mission', 'Min', 'km', 'Max alt', 'Battery %', 'Health', 'Route dev.', 'Off route %', 'Issues'],
        r.flights.map((f) => [f.startedAt.slice(0, 16).replace('T', ' '), f.droneName, f.pilotName, f.missionName, f.durationMin, f.distanceKm, f.maxAltM, f.batteryUsedPct, f.healthScore, f.routeMeanM, f.routeOutsidePct, f.issues.join('; ')]),
      )}`,
    );
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(orgName)} – flight report</title>
<style>body{font:13px/1.45 system-ui,sans-serif;color:#111;margin:32px}h1{font-size:20px;margin:0}h2{font-size:15px;margin:24px 0 6px;border-bottom:1px solid #ccc}h3{font-size:13px}
table{border-collapse:collapse;width:100%;margin:6px 0}th,td{border:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top}th{background:#f3f4f6}.meta{color:#555}@media print{body{margin:12mm}}</style>
</head><body><h1>${esc(orgName)} – compliance &amp; performance report</h1>
<p class="meta">Period ${esc(r.range.from.slice(0, 10))} – ${esc(r.range.to.slice(0, 10))} · generated ${esc(r.generatedAt.slice(0, 16).replace('T', ' '))} UTC</p>
${parts.join('\n')}
</body></html>`;
}
