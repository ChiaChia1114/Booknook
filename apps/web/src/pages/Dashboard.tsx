/**
 * Dashboard: a customisable grid of widgets (KPIs, flights and flight hours by pilot and by
 * drone, daily activity, AI alerts, an activity heatmap, AI trends with anomalies, maintenance
 * status, recent flights). The layout is saved per user (preferences API).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDown,
  ArrowUp,
  BellRing,
  CalendarDays,
  ChartColumn,
  Clock,
  Eye,
  EyeOff,
  Flame,
  LayoutGrid,
  Plane,
  RotateCcw,
  Route,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  UserRound,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { DashboardDto, DashboardWidgetId, DronesOperatorsDto, HeatmapDto, MaintenanceOverviewDto, TrendDto } from '@athena-sky/shared';
import { DASHBOARD_WIDGETS, formatHours } from '@athena-sky/shared';
import { api, errorMessage } from '../api/client';
import { useApi, useDateRange } from '../hooks';
import { useOrgId } from '../state/auth';
import { DateRangeFilter, FleetSelect } from '../components/Filters';
import { ColumnChart, TimeChart } from '../components/charts';
import { MapView } from '../components/MapView';
import { Badge, Card, Empty, ErrorBox, Kpi, Loading, PageHead, fmtDate, fmtDistance, fmtDuration, scoreTone } from '../components/ui';

type WidgetId = DashboardWidgetId;

const WIDGETS: Record<WidgetId, { title: string; icon: LucideIcon; span: 'w4' | 'w6' | 'w8' | 'w12' }> = {
  kpis: { title: 'Key figures', icon: LayoutGrid, span: 'w12' },
  'flights-by-pilot': { title: 'Flights by pilot', icon: UserRound, span: 'w6' },
  'hours-by-pilot': { title: 'Flight hours by pilot', icon: UserRound, span: 'w6' },
  'flights-by-drone': { title: 'Flights by drone', icon: Plane, span: 'w6' },
  'hours-by-drone': { title: 'Flight hours by drone', icon: Plane, span: 'w6' },
  activity: { title: 'Daily activity', icon: CalendarDays, span: 'w8' },
  alerts: { title: 'AI alerts', icon: ShieldAlert, span: 'w4' },
  heatmap: { title: 'Flight activity heatmap', icon: Flame, span: 'w6' },
  trends: { title: 'AI trends & anomalies', icon: Sparkles, span: 'w6' },
  maintenance: { title: 'Maintenance', icon: Wrench, span: 'w4' },
  recent: { title: 'Recent flights', icon: Route, span: 'w8' },
};
const DEFAULT_LAYOUT: WidgetId[] = [...DASHBOARD_WIDGETS];
const TREND_METRICS: [string, string][] = [
  ['batteryRatePctPerMin', 'Battery consumption (%/min)'],
  ['vibrationMean', 'Vibration (m/s²)'],
  ['motorImbalance', 'Motor imbalance'],
  ['healthScore', 'Flight health score'],
  ['routeMeanM', 'Route deviation (m)'],
  ['durationS', 'Flight duration (s)'],
];

/**
 * The member's Dashboard layout: the stored one, else the default. While the stored layout could
 * not be read, changes are kept on this page only – the stored one is not overwritten by the
 * default (and the page says so); a change that could not be saved is said too.
 */
function useLayout(orgId: string): [WidgetId[], (l: WidgetId[]) => void, boolean, string | null] {
  const pref = useApi<{ value: { widgets?: unknown } | null }>(`/api/v2/organisations/${orgId}/preferences/dashboard`);
  const [layout, setLayout] = useState<WidgetId[] | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => {
    if (pref.loading || layout) return;
    // A stored layout of another shape (another version, written through the API) is ignored; one
    // with every widget hidden stays empty.
    const widgets: unknown = pref.data?.value && typeof pref.data.value === 'object' ? pref.data.value.widgets : null;
    const saved = Array.isArray(widgets) ? [...new Set(widgets.filter((w): w is WidgetId => typeof w === 'string' && Object.hasOwn(WIDGETS, w)))] : null;
    setLayout(saved && (saved.length || (widgets as unknown[]).length === 0) ? saved : DEFAULT_LAYOUT);
  }, [pref.loading, pref.data, layout]);
  const save = (l: WidgetId[]) => {
    setLayout(l);
    if (pref.error) return;
    void api(`/api/v2/organisations/${orgId}/preferences/dashboard`, { method: 'PUT', body: { value: { widgets: l } } }).then(
      () => setSaveError(null),
      (err) => setSaveError(errorMessage(err)),
    );
  };
  const problem = pref.error
    ? `Your Dashboard layout could not be loaded (${pref.error}) – the default is shown, and changes are not saved.`
    : saveError
      ? `The Dashboard layout could not be saved: ${saveError}`
      : null;
  return [layout ?? DEFAULT_LAYOUT, save, !layout, problem];
}

function Widget({ id, editing, index, count, onMove, onHide, actions, children }: { id: WidgetId; editing: boolean; index: number; count: number; onMove(d: -1 | 1): void; onHide(): void; actions?: ReactNode; children: ReactNode }) {
  const w = WIDGETS[id];
  const bare = id === 'kpis';
  return (
    <section className={`card widget ${w.span}${bare ? ' bare' : ''}${editing ? ' editing' : ''}`} data-testid={`widget-${id}`}>
      <div className="card-head" hidden={bare && !editing}>
        <h3>
          <w.icon aria-hidden="true" /> {w.title}
        </h3>
        <div className="row" style={{ gap: 6 }}>
          {actions}
          {editing && (
            <div className="widget-tools">
              <button className="icon-btn" aria-label={`Move ${w.title} up`} disabled={index === 0} onClick={() => onMove(-1)}>
                <ArrowUp />
              </button>
              <button className="icon-btn" aria-label={`Move ${w.title} down`} disabled={index === count - 1} onClick={() => onMove(1)}>
                <ArrowDown />
              </button>
              <button className="icon-btn" aria-label={`Hide ${w.title}`} onClick={onHide}>
                <EyeOff />
              </button>
            </div>
          )}
        </div>
      </div>
      {children}
    </section>
  );
}

/** Per-flight metric over time with its linear trend and robust-z anomalies. */
function TrendWidget({ orgId, q }: { orgId: string; q: string }) {
  const [metric, setMetric] = useState('batteryRatePctPerMin');
  const t = useApi<TrendDto>(`/api/v2/organisations/${orgId}/analytics/trends?metric=${metric}&${q}`);
  const chart = useMemo(() => {
    const pts = t.data?.points ?? [];
    if (pts.length < 2) return null;
    const x = pts.map((p) => Date.parse(p.at) / 1000);
    // Least-squares line for display.
    const n = pts.length;
    const mx = x.reduce((s, v) => s + v, 0) / n;
    const my = pts.reduce((s, p) => s + p.value, 0) / n;
    let sxx = 0;
    let sxy = 0;
    pts.forEach((p, i) => {
      sxx += (x[i]! - mx) ** 2;
      sxy += (x[i]! - mx) * (p.value - my);
    });
    const slope = sxx ? sxy / sxx : 0;
    return {
      x,
      series: [
        { label: t.data!.label, values: pts.map((p) => (p.anomaly ? null : p.value)), color: '#3b82f6', points: true },
        { label: 'Anomaly', values: pts.map((p) => (p.anomaly ? p.value : null)), color: '#ef4444', points: true },
        { label: 'Trend', values: x.map((v) => my + slope * (v - mx)), color: '#f59e0b' },
      ],
    };
  }, [t.data]);
  const anomalies = t.data?.points.filter((p) => p.anomaly) ?? [];
  return (
    <>
      <div className="row" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
        <select aria-label="Trend metric" value={metric} onChange={(e) => setMetric(e.target.value)}>
          {TREND_METRICS.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        {t.data?.trend && (
          <span className="small muted" data-testid="trend-summary">
            <TrendingUp size={13} style={{ verticalAlign: -2 }} /> {t.data.trend.slopePerDay >= 0 ? '+' : ''}
            {t.data.trend.slopePerDay} {t.data.unit}/day · {anomalies.length} anomal{anomalies.length === 1 ? 'y' : 'ies'}
          </span>
        )}
      </div>
      {t.error ? (
        <ErrorBox error={t.error} />
      ) : !t.data ? (
        <Loading />
      ) : chart ? (
        <>
          <TimeChart x={chart.x} series={chart.series} height={200} legend={false} />
          <div className="chart-legend">
            {chart.series.map((s) => (
              <span key={s.label}>
                <i style={{ background: s.color }} className={s.points ? 'pt' : 'ln'} /> {s.label}
              </span>
            ))}
          </div>
        </>
      ) : (
        <Empty icon={Sparkles}>Not enough analysed flights in this period.</Empty>
      )}
      {anomalies.length > 0 && (
        <div className="col small" style={{ marginTop: 8, gap: 4 }}>
          {anomalies.slice(0, 3).map((a) => (
            <Link key={a.flightId} to={`/flights/${a.flightId}`} className="row" style={{ gap: 6 }}>
              <span className="dot danger" /> {a.droneName} · {fmtDate(a.at)} · {a.value} {t.data!.unit} (z {a.z})
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

/** The browser's IANA time zone (UTC when it cannot tell). */
const VIEWER_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

export function DashboardPage() {
  const orgId = useOrgId();
  // Two years at most: the per-day activity, the heatmap and the trends are built for the period.
  const r = useDateRange(30, 731);
  const [fleetId, setFleetId] = useState('');
  // Days are counted in the viewer's time zone.
  const q = `from=${encodeURIComponent(r.range.from)}&to=${encodeURIComponent(r.range.to)}${fleetId ? `&fleetId=${fleetId}` : ''}&tz=${encodeURIComponent(VIEWER_TZ)}`;
  const dash = useApi<DashboardDto>(`/api/v2/organisations/${orgId}/analytics/dashboard?${q}`);
  const ops = useApi<DronesOperatorsDto>(`/api/v2/organisations/${orgId}/analytics/drones-operators?${q}`);
  const heat = useApi<HeatmapDto>(`/api/v2/organisations/${orgId}/analytics/heatmap?${q}`);
  const maint = useApi<MaintenanceOverviewDto>(`/api/v2/organisations/${orgId}/maintenance`);
  const [layout, setLayout, layoutLoading, layoutProblem] = useLayout(orgId);
  const [editing, setEditing] = useState(false);
  const d = dash.data;
  const hidden = (Object.keys(WIDGETS) as WidgetId[]).filter((w) => !layout.includes(w));
  const move = (i: number, dir: -1 | 1) => {
    const l = [...layout];
    [l[i], l[i + dir]] = [l[i + dir]!, l[i]!];
    setLayout(l);
  };
  const pilots = (ops.data?.operators ?? []).filter((o) => o.flights > 0).sort((a, b) => b.flights - a.flights);
  const drones = (ops.data?.drones ?? []).filter((o) => o.flights > 0).sort((a, b) => b.flights - a.flights);

  const body = (id: WidgetId): { node: ReactNode; actions?: ReactNode } => {
    // Every widget shows what its own request brought – or that request's error, never results of
    // other filters (nor another request's error).
    const opsFailed = ops.error ? <ErrorBox error={ops.error} /> : !ops.data ? <Loading /> : null;
    switch (id) {
      case 'flights-by-pilot':
        return { node: opsFailed ?? (pilots.length ? <ColumnChart testId="flights-by-pilot" data={pilots.map((p) => ({ label: p.name, value: p.flights }))} /> : <Empty>No pilot activity in this period.</Empty>) };
      case 'hours-by-pilot':
        return { node: opsFailed ?? (pilots.length ? <ColumnChart data={pilots.map((p) => ({ label: p.name, value: Math.round((p.flightTimeS / 3600) * 100) / 100 }))} format={(v) => `${v} h`} /> : <Empty>No pilot activity in this period.</Empty>) };
      case 'flights-by-drone':
        return { node: opsFailed ?? (drones.length ? <ColumnChart testId="flights-by-drone" data={drones.map((p) => ({ label: p.name, value: p.flights }))} /> : <Empty>No flights in this period.</Empty>) };
      case 'hours-by-drone':
        return { node: opsFailed ?? (drones.length ? <ColumnChart data={drones.map((p) => ({ label: p.name, value: Math.round((p.flightTimeS / 3600) * 100) / 100 }))} format={(v) => `${v} h`} /> : <Empty>No flights in this period.</Empty>) };
      case 'heatmap':
        return {
          actions: heat.data ? <span className="small muted">{heat.data.points.toLocaleString()} samples</span> : undefined,
          node: heat.error ? (
            <ErrorBox error={heat.error} />
          ) : !heat.data ? (
            <Loading />
          ) : heat.data.cells.length ? (
              <>
                <MapView testId="heatmap" heat={heat.data} fitKey={heat.dataPath ?? ''} fit={heat.data.cells.map((c) => [c.lat, c.lon] as [number, number])} />
                <div className="row small muted" style={{ marginTop: 8, gap: 10 }}>
                  <span>Less</span>
                  <div className="legend-scale" style={{ flex: 1 }} />
                  <span>More time flown</span>
                </div>
              </>
            ) : (
              <Empty icon={Flame}>No telemetry in this period.</Empty>
            ),
        };
      case 'trends':
        return { node: <TrendWidget orgId={orgId} q={q} /> };
      case 'maintenance': {
        const m = maint.data;
        return {
          actions: <Link to="/maintenance">Open →</Link>,
          node: maint.error ? (
            <ErrorBox error={maint.error} />
          ) : !m ? (
            <Loading />
          ) : (
            <>
              <div className="grid three" style={{ marginBottom: 12, gap: 10 }}>
                <div className="hud-stat">
                  <div className="small muted">Overdue</div>
                  <div className="kpi-value-sm" style={{ color: m.counts.overdue ? 'var(--danger-text)' : undefined }}>
                    {m.counts.overdue}
                  </div>
                </div>
                <div className="hud-stat">
                  <div className="small muted">Due soon</div>
                  <div className="kpi-value-sm" style={{ color: m.counts.dueSoon ? 'var(--warn-text)' : undefined }}>
                    {m.counts.dueSoon}
                  </div>
                </div>
                <div className="hud-stat">
                  <div className="small muted">Predictive alerts</div>
                  <div className="kpi-value-sm" style={{ color: m.counts.healthActions ? 'var(--warn-text)' : undefined }}>
                    {m.counts.healthActions}
                  </div>
                </div>
              </div>
              <div className="col" style={{ gap: 10 }}>
                {m.drones.slice(0, 5).map((dr) => (
                  <div key={dr.droneId}>
                    <div className="row small" style={{ justifyContent: 'space-between' }}>
                      <Link to={`/fleet/${dr.droneId}`}>{dr.droneName}</Link>
                      <span className="muted">{dr.next ? `${dr.next.name} · ${dueText(dr.next.due)}` : 'No schedule'}</span>
                    </div>
                    {dr.next && (
                      <div className={`progress ${dr.next.due.status === 'overdue' ? 'danger' : dr.next.due.status === 'due_soon' ? 'warn' : 'ok'}`} style={{ marginTop: 4 }}>
                        <div style={{ width: `${Math.min(100, dr.next.due.used * 100)}%` }} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          ),
        };
      }
    }
    if (!d) return { node: dash.error ? <Empty>Not available – see the error above.</Empty> : <Loading /> };
    switch (id) {
      case 'kpis':
        return {
          node: (
            <div className="grid kpis six">
              <Kpi label="Drones" value={d.totals.drones} sub={`${d.totals.dronesOnline} online now`} icon={Plane} />
              <Kpi label="Pilots" value={d.totals.pilots} sub={`${d.totals.pilotsOnline} online · ${d.totals.members} members`} icon={Users} iconTone="violet" />
              <Kpi label="Flights" value={d.totals.flights} sub={`${d.totals.flightsInProgress} in progress`} icon={Route} iconTone="ok" />
              <Kpi label="Flight hours" value={formatHours(d.totals.flightTimeS)} sub={`avg ${fmtDuration(d.totals.avgFlightS)} per flight`} icon={Clock} />
              <Kpi label="Distance" value={fmtDistance(d.totals.distanceM)} icon={ChartColumn} iconTone="violet" />
              <Kpi label="Alerts" value={d.totals.alerts} tone={d.totals.alerts > 0 ? 'warn' : 'ok'} sub="from post-flight analytics" icon={BellRing} iconTone={d.totals.alerts > 0 ? 'warn' : 'ok'} />
            </div>
          ),
        };
      case 'activity':
        return {
          actions: <span className="small muted">{d.flightsPerDay.reduce((n, x) => n + x.flights, 0)} flights</span>,
          node: (
            <>
              <ColumnChart testId="flights-per-day" height={180} data={d.flightsPerDay.map((x) => ({ label: x.date.slice(5), value: x.flights }))} />
              <div className="small muted" style={{ marginTop: 4 }}>
                Flight hours per day
              </div>
              <ColumnChart height={120} data={d.flightsPerDay.map((x) => ({ label: x.date.slice(5), value: Math.round((x.flightTimeS / 3600) * 100) / 100 }))} format={(v) => `${v} h`} />
            </>
          ),
        };
      case 'alerts':
        return {
          actions: <Badge tone={d.alerts.length ? 'warn' : 'ok'}>{d.alerts.length}</Badge>,
          node:
            d.alerts.length === 0 ? (
              <Empty icon={ShieldAlert}>No issues detected – the fleet looks healthy.</Empty>
            ) : (
              <div className="col" style={{ maxHeight: 360, overflowY: 'auto', gap: 0 }}>
                {d.alerts.map((a, i) => (
                  <Link key={i} to={`/flights/${a.flightId}`} className={`finding ${a.severity}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                    <b>{a.title}</b> <span className="muted">· {a.droneName}</span>
                    <div className="small muted">{a.detail}</div>
                  </Link>
                ))}
              </div>
            ),
        };
      case 'recent':
        return {
          actions: <Link to="/flights">All flight logs →</Link>,
          node:
            d.recentFlights.length === 0 ? (
              <Empty>No flights recorded in this period.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Drone</th>
                      <th>Pilot</th>
                      <th className="num">Duration</th>
                      <th className="num">Distance</th>
                      <th>Health</th>
                      <th>Compliance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.recentFlights.map((f) => (
                      <tr key={f.id}>
                        <td className="nowrap">
                          <Link to={`/flights/${f.id}`}>{new Date(f.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</Link>
                        </td>
                        <td className="nowrap">{f.droneName}</td>
                        <td className="nowrap">{f.pilotName ?? '—'}</td>
                        <td className="num">{fmtDuration(f.durationS)}</td>
                        <td className="num">{fmtDistance(f.distanceM)}</td>
                        <td>{f.healthScore === null ? <Badge>{f.status === 'in_progress' ? 'in flight' : f.status === 'processing' ? 'importing' : '—'}</Badge> : <Badge tone={scoreTone(f.healthScore)}>{Math.round(f.healthScore)}</Badge>}</td>
                        <td>{f.compliance ? <Badge tone={f.compliance.compliant ? 'ok' : 'danger'}>{f.compliance.compliant ? 'compliant' : `${f.compliance.violations.length} issue(s)`}</Badge> : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ),
        };
    }
  };

  return (
    <div className="content">
      <PageHead
        title="Dashboard"
        subtitle="Assets, users and flights at a glance – filter by period and fleet, and arrange the widgets you need."
        actions={
          <>
            <DateRangeFilter r={r} />
            <FleetSelect value={fleetId} onChange={setFleetId} />
            <button className={`btn${editing ? ' primary' : ''}`} onClick={() => setEditing((e) => !e)} aria-pressed={editing}>
              <LayoutGrid /> {editing ? 'Done' : 'Customize'}
            </button>
          </>
        }
      />
      <ErrorBox error={layoutProblem} />
      <ErrorBox error={dash.error} />
      {editing && (
        <div className="customize-bar" data-testid="customize-bar">
          <span className="small muted">Hidden widgets:</span>
          {hidden.length === 0 && <span className="small faint">none</span>}
          {hidden.map((w) => (
            <button key={w} className="btn small" onClick={() => setLayout([...layout, w])}>
              <Eye /> {WIDGETS[w].title}
            </button>
          ))}
          <span className="spacer" />
          <button className="btn small ghost" onClick={() => setLayout(DEFAULT_LAYOUT)}>
            <RotateCcw /> Reset layout
          </button>
        </div>
      )}
      {layoutLoading ? (
        <Loading />
      ) : (
        <div className="widgets">
          {layout.length === 0 && (
            <div className="card widget w12" data-testid="dashboard-empty">
              <Empty>
                Every widget is hidden.{' '}
                <button className="btn small" onClick={() => setEditing(true)}>
                  Customize
                </button>
              </Empty>
            </div>
          )}
          {layout.map((id, i) => {
            const b = body(id);
            return (
              <Widget key={id} id={id} editing={editing} index={i} count={layout.length} onMove={(dir) => move(i, dir)} onHide={() => setLayout(layout.filter((x) => x !== id))} actions={b.actions}>
                {b.node}
              </Widget>
            );
          })}
        </div>
      )}
    </div>
  );
}

function dueText(due: { status: string; driver: string | null; remainingHours: number | null; remainingFlights: number | null; remainingDays: number | null }): string {
  if (due.status === 'overdue') return 'overdue';
  if (due.driver === 'hours') return `${due.remainingHours} h left`;
  if (due.driver === 'flights') return `${due.remainingFlights} flights left`;
  if (due.driver === 'days') return `${Math.ceil(due.remainingDays ?? 0)} days left`;
  return '';
}

export { Card };
