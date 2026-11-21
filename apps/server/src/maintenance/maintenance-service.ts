/**
 * Maintenance: scheduled tasks per drone (by flight hours, flights or calendar time), the
 * maintenance log, predictive maintenance from the trends of per-flight health metrics, and
 * notifications when a task becomes due or a metric is about to reach its limit.
 */
import type { DroneMaintenanceDto, MaintenanceOverviewDto, MaintenanceRecordDto, MaintenanceTaskDto } from '@athena-sky/shared';
import { DEFAULT_MAINTENANCE_PLAN, HEALTH_INDICATORS, maintenanceDue, predictHealth, type MaintenanceDue, type MaintenanceUsage, type MetricPoint } from '@athena-sky/shared';
import type { Db } from '../db/database';
import { parseJson } from '../db/database';
import { badRequest, notFound } from '../lib/errors';
import { nowIso, uuid } from '../lib/util';
import type { NotificationService } from '../realtime/notifications';

interface TaskRow {
  id: string;
  org_id: string;
  drone_id: string;
  drone_name: string;
  name: string;
  interval_hours: number | null;
  interval_flights: number | null;
  interval_days: number | null;
  notes: string;
  assignee_id: string | null;
  assignee_name: string | null;
  last_done_at: string;
  last_done_hours: number;
  last_done_flights: number;
  base_at: string;
  base_hours: number;
  base_flights: number;
  notified_status: string | null;
}

export interface TaskInput {
  name: string;
  intervalHours?: number | null;
  intervalFlights?: number | null;
  intervalDays?: number | null;
  notes?: string;
  assigneeId?: string | null;
}

const TASK_SELECT = `SELECT t.*, d.name AS drone_name, u.name AS assignee_name FROM maintenance_tasks t
  JOIN drones d ON d.id = t.drone_id LEFT JOIN users u ON u.id = t.assignee_id`;

const r1 = (v: number) => Math.round(v * 10) / 10;

export class MaintenanceService {
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly first: ReturnType<typeof setTimeout>;

  constructor(private readonly deps: { db: Db; notifications: NotificationService }) {
    const run = () => {
      try {
        this.check();
      } catch {
        /* next round */
      }
    };
    // Shortly after start (state may have changed while the server was down), then hourly.
    this.first = setTimeout(run, 15_000);
    this.first.unref?.();
    this.timer = setInterval(run, 3_600_000);
    this.timer.unref?.();
  }

  stop(): void {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }

  /** Flight hours and flights of a drone (optionally before a time). */
  usage(droneId: string, before?: string): { hours: number; flights: number } {
    const r = this.deps.db.get<{ s: number; n: number }>(
      'SELECT COALESCE(SUM(duration_s), 0) AS s, COUNT(*) AS n FROM flights WHERE drone_id = ? AND (? IS NULL OR started_at < ?)',
      droneId,
      before ?? null,
      before ?? null,
    )!;
    return { hours: r1(r.s / 3600), flights: r.n };
  }

  private due(t: Pick<TaskRow, 'interval_hours' | 'interval_flights' | 'interval_days'>, last: MaintenanceUsage, now: MaintenanceUsage): MaintenanceDue {
    return maintenanceDue({ hours: t.interval_hours, flights: t.interval_flights, days: t.interval_days }, last, now);
  }

  private taskDto(t: TaskRow, usage: { hours: number; flights: number }): MaintenanceTaskDto {
    return {
      id: t.id,
      droneId: t.drone_id,
      droneName: t.drone_name,
      name: t.name,
      intervalHours: t.interval_hours,
      intervalFlights: t.interval_flights,
      intervalDays: t.interval_days,
      notes: t.notes,
      assigneeId: t.assignee_id,
      assigneeName: t.assignee_name ?? null,
      lastDoneAt: t.last_done_at,
      lastDoneHours: t.last_done_hours,
      lastDoneFlights: t.last_done_flights,
      due: this.due(t, { hours: t.last_done_hours, flights: t.last_done_flights, at: Date.parse(t.last_done_at) }, { ...usage, at: Date.now() }),
    };
  }

  private droneRow(orgId: string, droneId: string): { id: string; name: string } {
    const d = this.deps.db.get<{ id: string; name: string }>('SELECT id, name FROM drones WHERE id = ? AND org_id = ?', droneId, orgId);
    if (!d) throw notFound('Drone');
    return d;
  }

  private taskRow(orgId: string, taskId: string): TaskRow {
    const t = this.deps.db.get<TaskRow>(`${TASK_SELECT} WHERE t.id = ? AND t.org_id = ?`, taskId, orgId);
    if (!t) throw notFound('Maintenance task');
    return t;
  }

  private validate(input: Partial<TaskInput>, orgId: string): void {
    if (input.name !== undefined && !input.name.trim()) throw badRequest('The task needs a name');
    for (const k of ['intervalHours', 'intervalFlights', 'intervalDays'] as const) {
      const v = input[k];
      if (v !== undefined && v !== null && !(v > 0)) throw badRequest(`${k} must be positive`);
    }
    if (input.assigneeId && !this.deps.db.get('SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ?', orgId, input.assigneeId)) throw badRequest('The assignee is not a member of this organisation');
  }

  tasks(orgId: string, droneId: string): MaintenanceTaskDto[] {
    this.droneRow(orgId, droneId);
    const usage = this.usage(droneId);
    return this.deps.db
      .all<TaskRow>(`${TASK_SELECT} WHERE t.org_id = ? AND t.drone_id = ? ORDER BY t.created_at`, orgId, droneId)
      .map((t) => this.taskDto(t, usage))
      .sort((a, b) => b.due.used - a.due.used);
  }

  createTask(orgId: string, droneId: string, input: TaskInput): MaintenanceTaskDto {
    this.droneRow(orgId, droneId);
    this.validate(input, orgId);
    if (!input.intervalHours && !input.intervalFlights && !input.intervalDays) throw badRequest('Give at least one interval (hours, flights or days)');
    const usage = this.usage(droneId);
    const id = uuid();
    const now = nowIso();
    this.deps.db.run(
      `INSERT INTO maintenance_tasks (id, org_id, drone_id, name, interval_hours, interval_flights, interval_days, notes, assignee_id,
         last_done_at, last_done_hours, last_done_flights, base_at, base_hours, base_flights, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      orgId,
      droneId,
      input.name.trim(),
      input.intervalHours ?? null,
      input.intervalFlights ?? null,
      input.intervalDays ?? null,
      input.notes ?? '',
      input.assigneeId ?? null,
      now,
      usage.hours,
      usage.flights,
      now,
      usage.hours,
      usage.flights,
      now,
      now,
    );
    return this.taskDto(this.taskRow(orgId, id), usage);
  }

  updateTask(orgId: string, taskId: string, input: Partial<TaskInput>): MaintenanceTaskDto {
    const t = this.taskRow(orgId, taskId);
    this.validate(input, orgId);
    const next = {
      name: input.name?.trim() ?? t.name,
      interval_hours: input.intervalHours !== undefined ? input.intervalHours : t.interval_hours,
      interval_flights: input.intervalFlights !== undefined ? input.intervalFlights : t.interval_flights,
      interval_days: input.intervalDays !== undefined ? input.intervalDays : t.interval_days,
      notes: input.notes ?? t.notes,
      assignee_id: input.assigneeId !== undefined ? input.assigneeId : t.assignee_id,
    };
    if (!next.interval_hours && !next.interval_flights && !next.interval_days) throw badRequest('Give at least one interval (hours, flights or days)');
    // Only a new interval changes when the task is due (and so what was notified).
    const intervalsChanged = next.interval_hours !== t.interval_hours || next.interval_flights !== t.interval_flights || next.interval_days !== t.interval_days;
    this.deps.db.run(
      `UPDATE maintenance_tasks SET name = ?, interval_hours = ?, interval_flights = ?, interval_days = ?, notes = ?, assignee_id = ?,
         notified_status = CASE WHEN ? THEN NULL ELSE notified_status END, updated_at = ? WHERE id = ?`,
      next.name,
      next.interval_hours,
      next.interval_flights,
      next.interval_days,
      next.notes,
      next.assignee_id,
      intervalsChanged ? 1 : 0,
      nowIso(),
      t.id,
    );
    return this.taskDto(this.taskRow(orgId, taskId), this.usage(t.drone_id));
  }

  deleteTask(orgId: string, taskId: string): void {
    const t = this.taskRow(orgId, taskId);
    this.deps.db.run('DELETE FROM maintenance_tasks WHERE id = ?', t.id);
  }

  /** Records that a task was done and restarts its interval. */
  completeTask(orgId: string, taskId: string, user: { id: string }, opts: { notes?: string; doneAt?: string } = {}): MaintenanceTaskDto {
    const t = this.taskRow(orgId, taskId);
    const doneAt = opts.doneAt ? new Date(opts.doneAt).toISOString() : nowIso();
    if (Date.parse(doneAt) > Date.now() + 60_000) throw badRequest('doneAt cannot be in the future');
    const usage = this.usage(t.drone_id, doneAt);
    this.deps.db.tx(() => {
      this.deps.db.run(
        'INSERT INTO maintenance_records (id, org_id, drone_id, task_id, title, done_at, done_by, hours, flights, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        uuid(),
        orgId,
        t.drone_id,
        t.id,
        t.name,
        doneAt,
        user.id,
        usage.hours,
        usage.flights,
        opts.notes ?? '',
        nowIso(),
      );
      // The interval restarts from the latest completion.
      const latest = this.deps.db.get<{ done_at: string; hours: number; flights: number }>('SELECT done_at, hours, flights FROM maintenance_records WHERE task_id = ? ORDER BY done_at DESC LIMIT 1', t.id)!;
      this.deps.db.run(
        'UPDATE maintenance_tasks SET last_done_at = ?, last_done_hours = ?, last_done_flights = ?, notified_status = NULL, updated_at = ? WHERE id = ?',
        latest.done_at,
        latest.hours,
        latest.flights,
        nowIso(),
        t.id,
      );
    });
    return this.taskDto(this.taskRow(orgId, taskId), this.usage(t.drone_id));
  }

  /** A maintenance record that is not tied to a scheduled task (repair, part replacement …). */
  addRecord(orgId: string, droneId: string, user: { id: string }, input: { title: string; notes?: string; doneAt?: string }): MaintenanceRecordDto {
    this.droneRow(orgId, droneId);
    const doneAt = input.doneAt ? new Date(input.doneAt).toISOString() : nowIso();
    if (Date.parse(doneAt) > Date.now() + 60_000) throw badRequest('doneAt cannot be in the future');
    const usage = this.usage(droneId, doneAt);
    const id = uuid();
    this.deps.db.run(
      'INSERT INTO maintenance_records (id, org_id, drone_id, task_id, title, done_at, done_by, hours, flights, notes, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)',
      id,
      orgId,
      droneId,
      input.title.trim(),
      doneAt,
      user.id,
      usage.hours,
      usage.flights,
      input.notes ?? '',
      nowIso(),
    );
    return this.records(orgId, droneId).find((r) => r.id === id)!;
  }

  records(orgId: string, droneId: string, limit = 100): MaintenanceRecordDto[] {
    return this.deps.db
      .all<any>(
        `SELECT r.*, u.name AS done_by_name FROM maintenance_records r LEFT JOIN users u ON u.id = r.done_by WHERE r.org_id = ? AND r.drone_id = ? ORDER BY r.done_at DESC LIMIT ?`,
        orgId,
        droneId,
        limit,
      )
      .map((r) => ({ id: r.id, droneId: r.drone_id, taskId: r.task_id, title: r.title, doneAt: r.done_at, doneBy: r.done_by, doneByName: r.done_by_name ?? null, hours: r.hours, flights: r.flights, notes: r.notes }));
  }

  /** Creates the default plan's tasks the drone does not have yet. */
  applyDefaultPlan(orgId: string, droneId: string): MaintenanceTaskDto[] {
    const have = new Set(this.tasks(orgId, droneId).map((t) => t.name.toLowerCase()));
    for (const tpl of DEFAULT_MAINTENANCE_PLAN) {
      if (have.has(tpl.name.toLowerCase())) continue;
      this.createTask(orgId, droneId, { name: tpl.name, intervalHours: tpl.interval.hours ?? null, intervalFlights: tpl.interval.flights ?? null, intervalDays: tpl.interval.days ?? null, notes: tpl.notes });
    }
    return this.tasks(orgId, droneId);
  }

  // ---------------------------------------------------------------------------------------
  // Predictive maintenance
  // ---------------------------------------------------------------------------------------

  /** Per-flight health metrics of the drone's latest flights, x = cumulative flight hours. */
  series(droneId: string, maxFlights = 60): Record<string, MetricPoint[]> {
    const rows = this.deps.db.all<{ started_at: string; duration_s: number; health_score: number | null; metrics: string | null }>(
      `SELECT f.started_at, f.duration_s, f.health_score, a.metrics FROM flights f LEFT JOIN flight_analyses a ON a.flight_id = f.id
        WHERE f.drone_id = ? ORDER BY f.started_at`,
      droneId,
    );
    let hours = 0;
    const all: { hours: number; at: string; metrics: Record<string, number> }[] = [];
    for (const r of rows) {
      hours += r.duration_s / 3600;
      const m = parseJson<Record<string, number>>(r.metrics, {});
      if (r.health_score !== null) m.healthScore = r.health_score;
      all.push({ hours: r1(hours * 10) / 10, at: r.started_at, metrics: m });
    }
    const recent = all.slice(-maxFlights);
    const out: Record<string, MetricPoint[]> = {};
    for (const ind of HEALTH_INDICATORS) {
      out[ind.metric] = recent.filter((p) => Number.isFinite(p.metrics[ind.metric])).map((p) => ({ hours: Math.round(p.hours * 100) / 100, value: p.metrics[ind.metric]!, at: p.at }));
    }
    return out;
  }

  droneMaintenance(orgId: string, droneId: string): DroneMaintenanceDto {
    const d = this.droneRow(orgId, droneId);
    const series = this.series(droneId);
    return { droneId, droneName: d.name, usage: this.usage(droneId), tasks: this.tasks(orgId, droneId), records: this.records(orgId, droneId, 50), health: predictHealth(series), series };
  }

  overview(orgId: string): MaintenanceOverviewDto {
    const drones = this.deps.db.all<{ id: string; name: string }>('SELECT id, name FROM drones WHERE org_id = ? ORDER BY name', orgId);
    const out: MaintenanceOverviewDto['drones'] = drones.map((d) => {
      const tasks = this.tasks(orgId, d.id);
      const health = predictHealth(this.series(d.id))
        .filter((h) => h.level !== 'ok')
        .map((h) => ({ metric: h.indicator.metric, label: h.indicator.label, level: h.level, remainingHours: h.remainingHours }));
      return {
        droneId: d.id,
        droneName: d.name,
        usage: this.usage(d.id),
        overdue: tasks.filter((t) => t.due.status === 'overdue').length,
        dueSoon: tasks.filter((t) => t.due.status === 'due_soon').length,
        next: tasks[0] ?? null,
        health,
      };
    });
    return {
      drones: out,
      counts: {
        overdue: out.reduce((s, d) => s + d.overdue, 0),
        dueSoon: out.reduce((s, d) => s + d.dueSoon, 0),
        healthActions: out.reduce((s, d) => s + d.health.filter((h) => h.level === 'action').length, 0),
      },
    };
  }

  /**
   * Whether a drone was flown with overdue maintenance at a past time: the due state of each
   * task with its usage and its latest completion before that time.
   */
  overdueAt(droneId: string, at: string): string[] {
    const tasks = this.deps.db.all<TaskRow>('SELECT * FROM maintenance_tasks WHERE drone_id = ? AND base_at <= ?', droneId, at);
    if (!tasks.length) return [];
    const usage = this.usage(droneId, at);
    const out: string[] = [];
    for (const t of tasks) {
      const rec = this.deps.db.get<{ done_at: string; hours: number; flights: number }>('SELECT done_at, hours, flights FROM maintenance_records WHERE task_id = ? AND done_at <= ? ORDER BY done_at DESC LIMIT 1', t.id, at);
      const last = rec ? { hours: rec.hours, flights: rec.flights, at: Date.parse(rec.done_at) } : { hours: t.base_hours, flights: t.base_flights, at: Date.parse(t.base_at) };
      if (this.due(t, last, { ...usage, at: Date.parse(at) }).status === 'overdue') out.push(t.name);
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------------------

  /** Notifies tasks that became due and predictive alerts (once per change). */
  check(droneId?: string): void {
    const db = this.deps.db;
    const tasks = db.all<TaskRow>(`${TASK_SELECT} WHERE (? IS NULL OR t.drone_id = ?)`, droneId ?? null, droneId ?? null);
    const usageCache = new Map<string, { hours: number; flights: number }>();
    const usageOf = (id: string) => usageCache.get(id) ?? (usageCache.set(id, this.usage(id)), usageCache.get(id)!);
    for (const t of tasks) {
      const dto = this.taskDto(t, usageOf(t.drone_id));
      const status = dto.due.status === 'ok' ? null : dto.due.status;
      if (status === t.notified_status) continue;
      db.run('UPDATE maintenance_tasks SET notified_status = ? WHERE id = ?', status, t.id);
      if (!status) continue;
      const left =
        dto.due.status === 'overdue'
          ? 'is overdue'
          : `is due in ${dto.due.driver === 'hours' ? `${dto.due.remainingHours} flight hours` : dto.due.driver === 'flights' ? `${dto.due.remainingFlights} flights` : `${Math.ceil(dto.due.remainingDays ?? 0)} days`}`;
      this.deps.notifications.create(t.org_id, {
        level: status === 'overdue' ? 'warning' : 'info',
        category: 'maintenance',
        code: status === 'overdue' ? 'maintenance_overdue' : 'maintenance_due_soon',
        droneId: t.drone_id,
        title: status === 'overdue' ? 'Maintenance overdue' : 'Maintenance due soon',
        message: `${t.name} on ${t.drone_name} ${left}${t.assignee_name ? ` (assigned to ${t.assignee_name})` : ''}.`,
        data: { taskId: t.id },
      });
    }
    const drones = db.all<{ id: string; org_id: string; name: string }>('SELECT id, org_id, name FROM drones WHERE (? IS NULL OR id = ?)', droneId ?? null, droneId ?? null);
    for (const d of drones) {
      const preds = predictHealth(this.series(d.id));
      const active = new Set<string>();
      for (const p of preds) {
        if (p.level !== 'action') continue;
        active.add(p.indicator.metric);
        const known = db.get<{ level: string }>('SELECT level FROM maintenance_alerts WHERE drone_id = ? AND key = ?', d.id, p.indicator.metric);
        if (known) continue;
        db.run('INSERT INTO maintenance_alerts (drone_id, key, level, at) VALUES (?, ?, ?, ?)', d.id, p.indicator.metric, p.level, nowIso());
        this.deps.notifications.create(d.org_id, {
          level: 'warning',
          category: 'maintenance',
          code: 'predictive_maintenance',
          droneId: d.id,
          title: 'Predictive maintenance',
          message: `${p.indicator.label} of ${d.name} ${p.exceeded ? 'has reached its limit' : `will reach its limit in about ${p.remainingHours} flight hours`} (now ${p.current}${p.indicator.unit ? ` ${p.indicator.unit}` : ''}, limit ${p.indicator.threshold}${p.indicator.unit ? ` ${p.indicator.unit}` : ''}). ${p.indicator.advice}`,
          data: { metric: p.indicator.metric, current: p.current, remainingHours: p.remainingHours },
        });
      }
      db.run(`DELETE FROM maintenance_alerts WHERE drone_id = ? AND key NOT IN (${[...active].map(() => '?').join(',') || "''"})`, d.id, ...active);
    }
  }
}
