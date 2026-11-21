/**
 * Reports: compliance and performance reports for a period, fleet, drone or pilot, with the
 * sections you choose – previewed here, exported as CSV or opened as a printable report.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BrainCircuit, CheckCircle2, Clock, FileDown, Gauge, Plane, Printer, Route, ShieldCheck, Users, Wrench } from 'lucide-react';
import type { DroneDto, MemberDto, ReportDto, ReportPerformanceRow, ReportSection } from '@athena-sky/shared';
import { REPORT_SECTIONS } from '@athena-sky/shared';
import { download } from '../api/client';
import { useApi, useDateRange } from '../hooks';
import { useOrgId } from '../state/auth';
import { DateRangeFilter, FleetSelect } from '../components/Filters';
import { HBarList } from '../components/charts';
import { Badge, Card, Empty, ErrorBox, Kpi, Loading, PageHead, fmtDate, fmtNum, scoreTone } from '../components/ui';

const SECTION_LABEL: Record<ReportSection, string> = {
  summary: 'Summary',
  performance: 'Performance',
  compliance: 'Compliance',
  maintenance: 'Maintenance',
  ai: 'AI detections',
  flights: 'Flight list',
};

function PerfTable({ rows, label }: { rows: ReportPerformanceRow[]; label: string }) {
  if (rows.length === 0) return <Empty>No flights.</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{label}</th>
            <th className="num">Flights</th>
            <th className="num">Hours</th>
            <th className="num">Distance</th>
            <th className="num">Avg health</th>
            <th className="num">Battery use</th>
            <th className="num">Mission flights</th>
            <th className="num">Route deviation</th>
            <th className="num">Outside corridor</th>
            <th className="num">Findings</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="nowrap">
                <b>{r.name}</b>
              </td>
              <td className="num">{r.flights}</td>
              <td className="num">{r.hours.toFixed(1)} h</td>
              <td className="num">{r.distanceKm.toFixed(1)} km</td>
              <td className="num">{r.avgHealth === null ? '—' : <Badge tone={scoreTone(r.avgHealth)}>{Math.round(r.avgHealth)}</Badge>}</td>
              <td className="num">{r.avgBatteryRatePctPerMin === null ? '—' : `${fmtNum(r.avgBatteryRatePctPerMin, 2)} %/min`}</td>
              <td className="num">{r.missionFlights}</td>
              <td className="num">{r.routeMeanM === null ? '—' : `${fmtNum(r.routeMeanM, 1)} m`}</td>
              <td className="num">{r.routeOutsidePct === null ? '—' : `${fmtNum(r.routeOutsidePct, 1)} %`}</td>
              <td className="num">
                {r.criticals > 0 && <Badge tone="danger">{r.criticals} critical</Badge>} {r.warnings > 0 && <Badge tone="warn">{r.warnings} warning</Badge>}
                {r.criticals === 0 && r.warnings === 0 && <span className="faint">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ReportsPage() {
  const orgId = useOrgId();
  const r = useDateRange(30);
  const [fleetId, setFleetId] = useState('');
  const [droneId, setDroneId] = useState('');
  const [pilotId, setPilotId] = useState('');
  const [sections, setSections] = useState<ReportSection[]>([...REPORT_SECTIONS]);
  const drones = useApi<DroneDto[]>(`/api/v2/organisations/${orgId}/drones`);
  const members = useApi<MemberDto[]>(`/api/v2/organisations/${orgId}/members`);
  const params = new URLSearchParams({ from: r.range.from, to: r.range.to, sections: (sections.length ? sections : ['summary']).join(',') });
  if (fleetId) params.set('fleetId', fleetId);
  if (droneId) params.set('droneId', droneId);
  if (pilotId) params.set('pilotId', pilotId);
  const base = `/api/v2/organisations/${orgId}/reports/flights`;
  const rep = useApi<ReportDto>(`${base}?${params}`);
  const d = rep.data;
  const toggle = (s: ReportSection) => setSections((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : REPORT_SECTIONS.filter((x) => x === s || cur.includes(x))));

  return (
    <div className="content">
      <PageHead
        title="Reports"
        subtitle="Compliance and performance reports for any period, fleet, drone or pilot – preview them here, export the flights as CSV or open a printable report."
        actions={
          <>
            <button className="btn" onClick={() => download(`${base}?${params}&format=csv`)}>
              <FileDown /> Export CSV
            </button>
            <button className="btn primary" onClick={() => window.open(`${base}?${params}&format=html`, '_blank', 'noopener')}>
              <Printer /> Printable report
            </button>
          </>
        }
      />
      <section className="card report-filters">
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <DateRangeFilter r={r} />
          <FleetSelect value={fleetId} onChange={setFleetId} />
          <select aria-label="Drone" value={droneId} onChange={(e) => setDroneId(e.target.value)}>
            <option value="">All drones</option>
            {(drones.data ?? []).map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
          <select aria-label="Pilot" value={pilotId} onChange={(e) => setPilotId(e.target.value)}>
            <option value="">All pilots</option>
            {(members.data ?? []).map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 12 }} role="group" aria-label="Report sections">
          <span className="small muted" style={{ marginRight: 4 }}>
            Sections
          </span>
          {REPORT_SECTIONS.map((s) => (
            <button key={s} className={`toggle-chip${sections.includes(s) ? ' on' : ''}`} aria-pressed={sections.includes(s)} onClick={() => toggle(s)}>
              {sections.includes(s) && <CheckCircle2 />} {SECTION_LABEL[s]}
            </button>
          ))}
        </div>
      </section>

      <ErrorBox error={rep.error} />
      {!d ? (
        <Loading />
      ) : (
        <div className="col report-preview" style={{ gap: 16 }} data-testid="report-preview">
          <div className="small muted">
            {fmtDate(d.range.from)} – {fmtDate(d.range.to)} · generated {fmtDate(d.generatedAt)}
          </div>
          {d.summary && (
            <div className="grid kpis five">
              <Kpi label="Flights" value={d.summary.flights} sub={`${d.summary.missionFlights} on a mission`} icon={Route} iconTone="ok" />
              <Kpi label="Flight hours" value={`${d.summary.hours.toFixed(1)} h`} sub={`avg ${d.summary.avgDurationMin.toFixed(1)} min`} icon={Clock} />
              <Kpi label="Distance" value={`${d.summary.distanceKm.toFixed(1)} km`} icon={Gauge} iconTone="violet" />
              <Kpi label="Drones · pilots" value={`${d.summary.drones} · ${d.summary.pilots}`} icon={Users} />
              <Kpi label="Avg health" value={d.summary.avgHealth === null ? '—' : Math.round(d.summary.avgHealth)} tone={scoreTone(d.summary.avgHealth) === 'ok' ? 'ok' : scoreTone(d.summary.avgHealth)} icon={ShieldCheck} iconTone="ok" />
            </div>
          )}
          {d.compliance && (
            <Card
              title={
                <h3>
                  <ShieldCheck /> Compliance
                </h3>
              }
            >
              <div className="report-compliance">
                <div className="compliance-score">
                  <div className="big" style={{ color: d.compliance.compliantPct >= 95 ? 'var(--ok-text)' : d.compliance.compliantPct >= 80 ? 'var(--warn-text)' : 'var(--danger-text)' }} data-testid="report-compliant-pct">
                    {d.compliance.compliantPct.toFixed(0)} %
                  </div>
                  <div className="small muted">of flights compliant</div>
                  <div className={`progress ${d.compliance.compliantPct >= 95 ? 'ok' : d.compliance.compliantPct >= 80 ? 'warn' : 'danger'}`} style={{ marginTop: 10 }}>
                    <div style={{ width: `${d.compliance.compliantPct}%` }} />
                  </div>
                  <div className="small muted" style={{ marginTop: 10 }}>
                    {d.compliance.flightsWithIssues} flight(s) with issues · {d.compliance.overdueMaintenanceFlights} flown with overdue maintenance
                  </div>
                </div>
                <div>
                  <div className="small muted" style={{ marginBottom: 6 }}>
                    Regulatory issues
                  </div>
                  {d.compliance.issues.length === 0 ? <div className="small faint">None</div> : <HBarList rows={d.compliance.issues.map((i) => ({ key: i.type, label: i.type, value: i.count }))} format={(v) => String(v)} />}
                </div>
                <div>
                  <div className="small muted" style={{ marginBottom: 6 }}>
                    UTM alerts during flights
                  </div>
                  {d.compliance.utmAlerts.length === 0 ? <div className="small faint">None</div> : <HBarList rows={d.compliance.utmAlerts.map((i) => ({ key: i.code, label: i.code.replace(/_/g, ' '), value: i.count }))} format={(v) => String(v)} />}
                </div>
              </div>
            </Card>
          )}
          {d.performance && (
            <Card
              title={
                <h3>
                  <Gauge /> Performance
                </h3>
              }
            >
              <div className="col" style={{ gap: 18 }}>
                <PerfTable rows={d.performance.byDrone} label="Drone" />
                <PerfTable rows={d.performance.byPilot} label="Pilot" />
              </div>
            </Card>
          )}
          <div className="grid two">
            {d.maintenance && (
              <Card
                title={
                  <h3>
                    <Wrench /> Maintenance
                  </h3>
                }
                actions={<Link to="/maintenance">Open →</Link>}
              >
                <div className="row small" style={{ gap: 8, marginBottom: 10 }}>
                  <Badge tone={d.maintenance.overdue ? 'danger' : 'ok'}>{d.maintenance.overdue} overdue</Badge>
                  <Badge tone={d.maintenance.dueSoon ? 'warn' : 'ok'}>{d.maintenance.dueSoon} due soon</Badge>
                </div>
                {d.maintenance.tasks.length === 0 ? (
                  <Empty icon={Wrench}>No scheduled maintenance.</Empty>
                ) : (
                  <div className="table-wrap">
                    <table className="table compact">
                      <thead>
                        <tr>
                          <th>Drone</th>
                          <th>Task</th>
                          <th>Status</th>
                          <th>Remaining</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.maintenance.tasks.map((t, i) => (
                          <tr key={i}>
                            <td className="nowrap">{t.droneName}</td>
                            <td>{t.name}</td>
                            <td>
                              <Badge tone={t.status === 'overdue' ? 'danger' : t.status === 'due_soon' ? 'warn' : 'ok'}>{t.status.replace('_', ' ')}</Badge>
                            </td>
                            <td className="small muted">{t.remaining}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            )}
            {d.ai && (
              <Card
                title={
                  <h3>
                    <BrainCircuit /> AI detections
                  </h3>
                }
                actions={<span className="small muted">{d.ai.flightsWithDetections} flight(s)</span>}
              >
                {d.ai.detections.length === 0 ? <Empty icon={BrainCircuit}>No objects detected in this period.</Empty> : <HBarList rows={d.ai.detections.map((x) => ({ key: x.cls, label: x.cls, value: x.count }))} format={(v) => String(v)} />}
              </Card>
            )}
          </div>
          {d.flights && (
            <Card
              title={
                <h3>
                  <Plane /> Flights
                </h3>
              }
              actions={<span className="small muted">{d.flights.length} flight(s)</span>}
            >
              {d.flights.length === 0 ? (
                <Empty>No flights in this period.</Empty>
              ) : (
                <div className="table-wrap" style={{ maxHeight: 520 }}>
                  <table className="table" data-testid="report-flights">
                    <thead>
                      <tr>
                        <th>Start</th>
                        <th>Drone</th>
                        <th>Pilot</th>
                        <th>Mission</th>
                        <th className="num">Duration</th>
                        <th className="num">Distance</th>
                        <th className="num">Battery</th>
                        <th className="num">Health</th>
                        <th className="num">Route dev.</th>
                        <th>Issues</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.flights.map((f) => (
                        <tr key={f.id}>
                          <td>
                            <Link to={`/flights/${f.id}`}>{fmtDate(f.startedAt)}</Link>
                          </td>
                          <td className="nowrap">{f.droneName}</td>
                          <td className="nowrap">{f.pilotName ?? '—'}</td>
                          <td className="truncate" style={{ maxWidth: 180 }}>
                            {f.missionName ?? <span className="faint">manual</span>}
                          </td>
                          <td className="num">{f.durationMin.toFixed(1)} min</td>
                          <td className="num">{f.distanceKm.toFixed(2)} km</td>
                          <td className="num">{f.batteryUsedPct === null ? '—' : `${f.batteryUsedPct.toFixed(0)} %`}</td>
                          <td className="num">{f.healthScore === null ? '—' : <Badge tone={scoreTone(f.healthScore)}>{Math.round(f.healthScore)}</Badge>}</td>
                          <td className="num">{f.routeMeanM === null ? '—' : `${f.routeMeanM.toFixed(1)} m`}</td>
                          <td className="small">{f.issues.length ? <span style={{ color: 'var(--warn-text)' }}>{f.issues.join('; ')}</span> : <span className="faint">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
