/**
 * Maintenance: scheduled maintenance per drone (every N flight hours, flights or days, with
 * assignees and a maintenance log) and predictive maintenance from the trends of per-flight
 * health metrics.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Activity, CalendarClock, CheckCircle2, ClipboardList, Clock, History, ListPlus, Pencil, Plus, Sparkles, Trash2, TriangleAlert, UserRound, Wrench } from 'lucide-react';
import type { DroneMaintenanceDto, MaintenanceOverviewDto, MaintenanceTaskDto, MemberDto } from '@athena-sky/shared';
import { formatHours } from '@athena-sky/shared';
import { api, errorMessage } from '../api/client';
import { useApi } from '../hooks';
import { useAuth, useOrgId } from '../state/auth';
import { TimeChart } from '../components/charts';
import { Badge, Card, Empty, ErrorBox, Kpi, Loading, Modal, PageHead, fmtDay, useToast } from '../components/ui';

type Due = MaintenanceTaskDto['due'];

/** yyyy-mm-dd in the browser's time zone (what a date input shows). */
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const STATUS_TONE: Record<Due['status'], 'ok' | 'warn' | 'danger'> = { ok: 'ok', due_soon: 'warn', overdue: 'danger' };
const STATUS_LABEL: Record<Due['status'], string> = { ok: 'OK', due_soon: 'Due soon', overdue: 'Overdue' };
const LEVEL_TONE = { ok: 'ok', watch: 'warn', action: 'danger' } as const;
const LEVEL_LABEL = { ok: 'Healthy', watch: 'Watch', action: 'Action needed' } as const;

export function intervalText(t: { intervalHours: number | null; intervalFlights: number | null; intervalDays: number | null }): string {
  const parts: string[] = [];
  if (t.intervalHours) parts.push(`${t.intervalHours} h`);
  if (t.intervalFlights) parts.push(`${t.intervalFlights} flights`);
  if (t.intervalDays) parts.push(`${t.intervalDays} days`);
  return parts.length ? `every ${parts.join(' / ')}` : '—';
}

export function remainingText(due: Due): string {
  const parts: string[] = [];
  if (due.remainingHours !== null) parts.push(due.remainingHours < 0 ? `${-due.remainingHours} h over` : `${due.remainingHours} h left`);
  if (due.remainingFlights !== null) parts.push(due.remainingFlights < 0 ? `${-due.remainingFlights} flights over` : `${due.remainingFlights} flights left`);
  if (due.remainingDays !== null) parts.push(due.remainingDays < 0 ? `${Math.ceil(-due.remainingDays)} days over` : `${Math.ceil(due.remainingDays)} days left`);
  return parts.join(' · ');
}

function DueBar({ due }: { due: Due }) {
  return (
    <div className="col" style={{ gap: 4, minWidth: 140 }}>
      <div className={`progress ${STATUS_TONE[due.status]}`}>
        <div style={{ width: `${Math.min(100, due.used * 100)}%` }} />
      </div>
      <span className="small muted">{remainingText(due)}</span>
    </div>
  );
}

function TaskModal({ droneId, task, members, onClose, onSaved }: { droneId: string; task: MaintenanceTaskDto | null; members: MemberDto[]; onClose(): void; onSaved(): void }) {
  const orgId = useOrgId();
  const [name, setName] = useState(task?.name ?? '');
  const [hours, setHours] = useState(task?.intervalHours?.toString() ?? '');
  const [flights, setFlights] = useState(task?.intervalFlights?.toString() ?? '');
  const [days, setDays] = useState(task?.intervalDays?.toString() ?? '');
  const [notes, setNotes] = useState(task?.notes ?? '');
  const [assignee, setAssignee] = useState(task?.assigneeId ?? '');
  const [error, setError] = useState<string | null>(null);
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (num(hours) === null && num(flights) === null && num(days) === null) {
      setError('Set at least one interval (flight hours, flights or days).');
      return;
    }
    const body = { name, intervalHours: num(hours), intervalFlights: num(flights), intervalDays: num(days), notes, assigneeId: assignee || null };
    try {
      if (task) await api(`/api/v2/organisations/${orgId}/maintenance/tasks/${task.id}`, { method: 'PATCH', body });
      else await api(`/api/v2/organisations/${orgId}/drones/${droneId}/maintenance/tasks`, { body });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Modal title={task ? 'Edit maintenance task' : 'Schedule maintenance'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBox error={error} />
        <label className="field">
          Task
          <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Propeller replacement" />
        </label>
        <div className="small muted">Due when any interval is reached since it was last done:</div>
        <div className="grid three" style={{ gap: 10 }}>
          <label className="field">
            Every … flight hours
            <input type="number" min={0.1} step="any" value={hours} onChange={(e) => setHours(e.target.value)} aria-label="Interval flight hours" />
          </label>
          <label className="field">
            Every … flights
            <input type="number" min={1} step={1} value={flights} onChange={(e) => setFlights(e.target.value)} aria-label="Interval flights" />
          </label>
          <label className="field">
            Every … days
            <input type="number" min={1} step={1} value={days} onChange={(e) => setDays(e.target.value)} aria-label="Interval days" />
          </label>
        </div>
        <label className="field">
          Assignee
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Instructions
          <textarea rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" type="submit">
            {task ? 'Save' : 'Schedule'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DoneModal({ title, onClose, onSubmit }: { title: string; onClose(): void; onSubmit(v: { title: string; notes: string; doneAt: string }): Promise<void> }) {
  const record = title === '';
  const [what, setWhat] = useState('');
  const [notes, setNotes] = useState('');
  const [day, setDay] = useState(() => localDay());
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      // Today: now. An earlier day: local noon of that day.
      const doneAt = day === localDay() ? new Date().toISOString() : new Date(`${day}T12:00:00`).toISOString();
      await onSubmit({ title: what, notes, doneAt });
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Modal title={record ? 'Log maintenance' : `Mark done: ${title}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBox error={error} />
        {record && (
          <label className="field">
            What was done
            <input required maxLength={200} value={what} onChange={(e) => setWhat(e.target.value)} placeholder="e.g. Replaced motor 3" />
          </label>
        )}
        <label className="field">
          Date
          <input type="date" value={day} max={localDay()} onChange={(e) => setDay(e.target.value)} />
        </label>
        <label className="field">
          Notes
          <textarea rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Parts, findings, measurements…" />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn ok solid" type="submit">
            <CheckCircle2 /> {record ? 'Log' : 'Mark done'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Decimals that suit a metric, judged by the size of its threshold (70 → 0, 30 → 1, 6 → 2, 0.12 → 3). */
const metricDecimals = (threshold: number) => {
  const a = Math.abs(threshold);
  return a >= 50 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3;
};
const fmtMetric = (v: number, threshold: number) => v.toFixed(metricDecimals(threshold));
/** Signed rate with two significant digits. */
const fmtRate = (v: number) => {
  if (v === 0) return '±0';
  const a = Math.abs(v);
  const d = a >= 10 ? 1 : a >= 1 ? 2 : Math.min(6, Math.ceil(-Math.log10(a)) + 1);
  return `${v > 0 ? '+' : '−'}${a.toFixed(d)}`;
};
const fmtHoursLeft = (h: number) => (h >= 10 ? `${Math.round(h)} h` : `${h.toFixed(1)} h`);

function HealthCard({ h, series }: { h: DroneMaintenanceDto['health'][number]; series: DroneMaintenanceDto['series'][string] }) {
  const ind = h.indicator;
  const chart = useMemo(() => {
    if (!series || series.length < 2) return null;
    const x = series.map((p) => p.hours);
    const n = x.length;
    const mx = x.reduce((a, b) => a + b, 0) / n;
    const my = series.reduce((a, p) => a + p.value, 0) / n;
    const line = x.map((v) => my + h.slopePerHour * (v - mx));
    return {
      x,
      series: [
        { label: ind.label, values: series.map((p) => p.value), color: '#3b82f6', points: true },
        { label: 'Trend', values: line, color: '#f59e0b' },
        { label: 'Threshold', values: x.map(() => ind.threshold), color: '#ef4444', dash: [5, 4] },
      ],
    };
  }, [series, h.slopePerHour, ind.label, ind.threshold]);
  return (
    <div className={`health-card ${h.level}`} data-testid={`health-${ind.metric}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>{ind.label}</b>
        <Badge tone={LEVEL_TONE[h.level]}>{LEVEL_LABEL[h.level]}</Badge>
      </div>
      <div className="health-figures">
        <div>
          <div className="small muted">Current</div>
          <div className="kpi-value-sm">
            {fmtMetric(h.current, ind.threshold)} <span className="small muted">{ind.unit}</span>
          </div>
        </div>
        <div>
          <div className="small muted">Threshold</div>
          <div className="kpi-value-sm">
            {fmtMetric(ind.threshold, ind.threshold)} <span className="small muted">{ind.unit}</span>
          </div>
        </div>
        <div>
          <div className="small muted">Reached in</div>
          <div className="kpi-value-sm">{h.exceeded ? 'now' : h.remainingHours === null ? '—' : fmtHoursLeft(h.remainingHours)}</div>
        </div>
      </div>
      {chart && <TimeChart x={chart.x} series={chart.series} height={120} legend={false} xFormat={(v) => `${v.toFixed(1)} h`} />}
      <div className="small muted" style={{ marginTop: 6 }}>
        {h.level === 'ok' ? `Stable trend over ${h.points} flights (${fmtRate(h.slopePerHour)}${ind.unit ? ` ${ind.unit}` : ''} per flight hour).` : ind.advice}
      </div>
    </div>
  );
}

function DronePanel({ droneId, members, onChanged }: { droneId: string; members: MemberDto[]; onChanged(): void }) {
  const orgId = useOrgId();
  const { can, me } = useAuth();
  const toast = useToast();
  const m = useApi<DroneMaintenanceDto>(`/api/v2/organisations/${orgId}/drones/${droneId}/maintenance`);
  const [editing, setEditing] = useState<MaintenanceTaskDto | 'new' | null>(null);
  const [completing, setCompleting] = useState<MaintenanceTaskDto | null>(null);
  const [logging, setLogging] = useState(false);
  const manage = can('drone.manage');
  const refresh = () => {
    m.reload();
    onChanged();
  };
  if (m.error) return <ErrorBox error={m.error} />;
  if (!m.data) return <Loading />;
  const d = m.data;
  const applyDefault = async () => {
    try {
      await api(`/api/v2/organisations/${orgId}/drones/${droneId}/maintenance/default-plan`, { method: 'POST' });
      toast('Default maintenance plan added', 'ok');
      refresh();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  const remove = async (t: MaintenanceTaskDto) => {
    if (!confirm(`Delete the maintenance task "${t.name}"?`)) return;
    try {
      await api(`/api/v2/organisations/${orgId}/maintenance/tasks/${t.id}`, { method: 'DELETE' });
      refresh();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  return (
    <div className="col" style={{ gap: 16 }}>
      <Card
        title={
          <h3>
            <CalendarClock /> Scheduled maintenance · {d.droneName}
          </h3>
        }
        actions={
          manage && (
            <>
              {d.tasks.length === 0 && (
                <button className="btn small" onClick={applyDefault}>
                  <ListPlus /> Add default plan
                </button>
              )}
              <button className="btn small primary" onClick={() => setEditing('new')}>
                <Plus /> Schedule task
              </button>
            </>
          )
        }
      >
        <div className="row wrap small muted" style={{ marginBottom: 10, columnGap: 16, rowGap: 4 }}>
          <span>
            <Clock size={13} style={{ verticalAlign: -2 }} /> {formatHours(d.usage.hours * 3600)} flown
          </span>
          <span>
            <Activity size={13} style={{ verticalAlign: -2 }} /> {d.usage.flights} flights
          </span>
        </div>
        {d.tasks.length === 0 ? (
          <Empty icon={Wrench}>No maintenance scheduled for this drone yet.{manage ? ' Add the default plan or schedule your own tasks.' : ''}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table" data-testid="maintenance-tasks">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Interval</th>
                  <th>Last done</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {d.tasks.map((t) => {
                  const mayComplete = manage || t.assigneeId === me?.user.id;
                  return (
                    <tr key={t.id}>
                      <td style={{ maxWidth: 240 }}>
                        <b>{t.name}</b>
                        {t.notes && (
                          <div className="small muted truncate" title={t.notes}>
                            {t.notes}
                          </div>
                        )}
                        {t.assigneeName && (
                          <div className="small row" style={{ gap: 4, marginTop: 2, color: 'var(--text-dim)' }}>
                            <UserRound size={12} aria-hidden="true" /> {t.assigneeName}
                          </div>
                        )}
                      </td>
                      <td className="small nowrap">{intervalText(t)}</td>
                      <td className="small nowrap">
                        {fmtDay(t.lastDoneAt)}
                        <div className="muted">at {t.lastDoneHours} h</div>
                      </td>
                      <td style={{ minWidth: 170 }}>
                        <div className="row" style={{ gap: 6, marginBottom: 6 }}>
                          <Badge tone={STATUS_TONE[t.due.status]}>{STATUS_LABEL[t.due.status]}</Badge>
                        </div>
                        <DueBar due={t.due} />
                      </td>
                      <td>
                        <div className="row nowrap" style={{ gap: 2, justifyContent: 'flex-end' }}>
                          {mayComplete && (
                            <button className="btn small" onClick={() => setCompleting(t)} aria-label={`Mark ${t.name} done`} title="Record that this was done">
                              <CheckCircle2 /> Done
                            </button>
                          )}
                          {manage && (
                            <>
                              <button className="icon-btn ghost" onClick={() => setEditing(t)} aria-label={`Edit ${t.name}`} title="Edit">
                                <Pencil />
                              </button>
                              <button className="icon-btn ghost danger-text" onClick={() => remove(t)} aria-label={`Delete ${t.name}`} title="Delete">
                                <Trash2 />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title={
          <h3>
            <Sparkles /> Predictive maintenance
          </h3>
        }
        actions={<span className="small muted">Trends of per-flight metrics vs. flight hours</span>}
      >
        {d.health.length === 0 ? (
          <Empty icon={Sparkles}>Not enough analysed flights yet – predictions start after 5 flights with telemetry.</Empty>
        ) : (
          <div className="health-grid">
            {d.health.map((h) => (
              <HealthCard key={h.indicator.metric} h={h} series={d.series[h.indicator.metric] ?? []} />
            ))}
          </div>
        )}
      </Card>

      <Card
        title={
          <h3>
            <History /> Maintenance log
          </h3>
        }
        actions={
          manage && (
            <button className="btn small" onClick={() => setLogging(true)}>
              <ClipboardList /> Log maintenance
            </button>
          )
        }
      >
        {d.records.length === 0 ? (
          <Empty icon={History}>Nothing logged yet.</Empty>
        ) : (
          <div className="timeline">
            {d.records.map((r) => (
              <div key={r.id} className="timeline-item">
                <span className="timeline-dot" />
                <div>
                  <div className="row" style={{ gap: 8 }}>
                    <b>{r.title}</b>
                    {r.taskId && <Badge tone="accent">scheduled</Badge>}
                  </div>
                  <div className="small muted">
                    {fmtDay(r.doneAt)} · {r.doneByName ?? 'unknown'} · at {r.hours} h / {r.flights} flights
                  </div>
                  {r.notes && <div className="small" style={{ marginTop: 2 }}>{r.notes}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {editing && (
        <TaskModal
          droneId={droneId}
          task={editing === 'new' ? null : editing}
          members={members}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      {completing && (
        <DoneModal
          title={completing.name}
          onClose={() => setCompleting(null)}
          onSubmit={async (v) => {
            await api(`/api/v2/organisations/${orgId}/maintenance/tasks/${completing.id}/complete`, { body: { notes: v.notes, doneAt: v.doneAt } });
            toast(`${completing.name} recorded`, 'ok');
            setCompleting(null);
            refresh();
          }}
        />
      )}
      {logging && (
        <DoneModal
          title=""
          onClose={() => setLogging(false)}
          onSubmit={async (v) => {
            await api(`/api/v2/organisations/${orgId}/drones/${droneId}/maintenance/records`, { body: { title: v.title, notes: v.notes, doneAt: v.doneAt } });
            setLogging(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

export function MaintenancePage() {
  const orgId = useOrgId();
  const [params, setParams] = useSearchParams();
  const overview = useApi<MaintenanceOverviewDto>(`/api/v2/organisations/${orgId}/maintenance`);
  const members = useApi<MemberDto[]>(`/api/v2/organisations/${orgId}/members`);
  const o = overview.data;
  const selected = params.get('drone') ?? o?.drones[0]?.droneId ?? null;
  const select = (id: string) => setParams({ drone: id }, { replace: true });
  const totalHours = o?.drones.reduce((s, d) => s + d.usage.hours, 0) ?? 0;
  return (
    <div className="content">
      <PageHead title="Maintenance" subtitle="Scheduled maintenance by flight hours, flights or calendar time – and predictive maintenance from the trends in every drone's flight data." />
      <ErrorBox error={overview.error} />
      {!o ? (
        <Loading />
      ) : (
        <>
          <div className="grid kpis four" style={{ marginBottom: 16 }}>
            <Kpi label="Overdue tasks" value={o.counts.overdue} tone={o.counts.overdue ? 'danger' : undefined} icon={TriangleAlert} iconTone={o.counts.overdue ? 'danger' : 'ok'} sub="past their interval" />
            <Kpi label="Due soon" value={o.counts.dueSoon} tone={o.counts.dueSoon ? 'warn' : undefined} icon={CalendarClock} iconTone="warn" sub="within 10 % of the interval" />
            <Kpi label="Predictive alerts" value={o.counts.healthActions} tone={o.counts.healthActions ? 'warn' : undefined} icon={Sparkles} iconTone="violet" sub="health trends needing action" />
            <Kpi label="Fleet flight hours" value={formatHours(totalHours * 3600)} icon={Clock} sub={`${o.drones.length} drones tracked`} />
          </div>
          {o.drones.length === 0 ? (
            <Card>
              <Empty icon={Wrench}>
                No drones yet. <Link to="/fleet">Register a drone</Link> to plan its maintenance.
              </Empty>
            </Card>
          ) : (
            <div className="split-layout">
              <aside className="card flush split-list">
                {o.drones.map((d) => {
                  const actions = d.health.filter((h) => h.level === 'action').length;
                  return (
                    <button key={d.droneId} className={`split-item${d.droneId === selected ? ' active' : ''}`} onClick={() => select(d.droneId)} data-testid={`maint-drone-${d.droneName}`}>
                      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                        <b className="truncate">{d.droneName}</b>
                        {d.overdue > 0 ? <Badge tone="danger">{d.overdue} overdue</Badge> : d.dueSoon > 0 ? <Badge tone="warn">{d.dueSoon} due soon</Badge> : d.next ? <Badge tone="ok">OK</Badge> : <Badge>no plan</Badge>}
                      </div>
                      <div className="small muted">
                        {formatHours(d.usage.hours * 3600)} · {d.usage.flights} flights
                        {actions > 0 && (
                          <span style={{ color: 'var(--warn-text)' }}>
                            {' '}
                            · {actions} predictive alert{actions === 1 ? '' : 's'}
                          </span>
                        )}
                      </div>
                      {d.next && (
                        <>
                          <div className={`progress ${STATUS_TONE[d.next.due.status]}`} style={{ marginTop: 8 }}>
                            <div style={{ width: `${Math.min(100, d.next.due.used * 100)}%` }} />
                          </div>
                          <div className="small faint" style={{ marginTop: 4 }}>
                            Next: {d.next.name} · {remainingText(d.next.due)}
                          </div>
                        </>
                      )}
                    </button>
                  );
                })}
              </aside>
              <div style={{ minWidth: 0 }}>{selected && <DronePanel key={selected} droneId={selected} members={members.data ?? []} onChanged={overview.reload} />}</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
