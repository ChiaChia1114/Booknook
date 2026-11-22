import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { BatteryMedium, Clock, Cpu, FolderInput, HeartPulse, KeyRound, Pencil, Radio, Signal, Trash2, Wrench } from 'lucide-react';
import type { DroneDto, DroneMaintenanceDto, FirmwareUpdateDto, FleetDto, FlightDto, Paged } from '@athena-sky/shared';
import { AIRFRAMES, formatHours } from '@athena-sky/shared';
import { api, errorMessage } from '../api/client';
import { useApi } from '../hooks';
import { useAuth, useOrgId } from '../state/auth';
import { useLive } from '../state/live';
import { MapView } from '../components/MapView';
import { ColumnChart } from '../components/charts';
import { remainingText } from './Maintenance';
import { Badge, Card, Empty, ErrorBox, Kpi, Loading, Modal, PageHead, fmtDate, fmtDistance, fmtDuration, scoreTone, timeAgo, useToast } from '../components/ui';
import { droneStatus } from './Fleet';

const shortDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' });

export function DroneDetailPage() {
  const { droneId = '' } = useParams();
  const orgId = useOrgId();
  const { can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const drone = useApi<DroneDto>(`/api/v2/organisations/${orgId}/drones/${droneId}`);
  const flights = useApi<Paged<FlightDto>>(`/api/v2/organisations/${orgId}/flights?droneId=${droneId}&limit=100`);
  const updates = useApi<FirmwareUpdateDto[]>(`/api/v2/organisations/${orgId}/firmware-updates?droneId=${droneId}`);
  const fleets = useApi<FleetDto[]>(`/api/v2/organisations/${orgId}/fleets`);
  const maint = useApi<DroneMaintenanceDto>(`/api/v2/organisations/${orgId}/drones/${droneId}/maintenance`);
  const { live } = useLive();
  const [editing, setEditing] = useState(false);
  /** The fleet chosen in the "Move to fleet" dialog (null: closed). */
  const [moving, setMoving] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', model: '', serial: '', fleetId: '', notes: '', airframeId: '' });
  const d = drone.data;
  const l = live.drones[droneId];
  const tel = l?.online ? l.telemetry : null;
  if (drone.error) return <div className="content"><ErrorBox error={drone.error} /></div>;
  if (!d) return <Loading />;
  const history = [...(flights.data?.items ?? [])].reverse();
  const airframeName = AIRFRAMES.find((a) => a.id === d.airframeId)?.name ?? null;
  // "Specter 10X" flying the "Specter 10X inspection quad" airframe is shown once.
  const model = (d.model ?? '').trim();
  const overlap = !!airframeName && (!model || airframeName.toLowerCase().includes(model.toLowerCase()) || model.toLowerCase().includes(airframeName.toLowerCase()));
  const modelText = overlap ? (airframeName!.length >= model.length ? airframeName! : model) : model || 'Unknown model';
  return (
    <div className="content">
      <PageHead
        title={d.name}
        subtitle={
          <>
            {[modelText, airframeName && !overlap ? `airframe ${airframeName}` : null, `S/N ${d.serial || '—'}`, d.fleetName ?? 'no fleet'].filter(Boolean).join(' · ')} · {droneStatus({ online: l?.online ?? d.online, inFlight: !!l?.flightId })}
          </>
        }
        actions={
          <>
            {(l?.online ?? d.online) && (
              <Link className="btn primary" to={`/live?drone=${d.id}`}>
                <Radio /> Fly / watch live
              </Link>
            )}
            <Link className="btn" to={`/maintenance?drone=${d.id}`}>
              <Wrench /> Maintenance
            </Link>
            {/* Mission managers organise the fleets without managing the drones themselves. */}
            {can('fleet.manage') && !can('drone.manage') && (
              <button className="btn" onClick={() => setMoving(d.fleetId ?? '')}>
                <FolderInput /> Move to fleet
              </button>
            )}
            {can('drone.manage') && (
              <>
                <button
                  className="btn"
                  onClick={() => {
                    setForm({ name: d.name, model: d.model, serial: d.serial, fleetId: d.fleetId ?? '', notes: d.notes, airframeId: d.airframeId ?? '' });
                    setEditing(true);
                  }}
                >
                  <Pencil /> Edit
                </button>
                <button
                  className="btn"
                  onClick={async () => {
                    if (!confirm('Rotate the link key? The drone disconnects until it is configured with the new key.')) return;
                    try {
                      setKey((await api<{ linkKey: string }>(`/api/v2/organisations/${orgId}/drones/${d.id}/link-key`, { method: 'POST' })).linkKey);
                    } catch (err) {
                      toast(errorMessage(err), 'error');
                    }
                  }}
                >
                  <KeyRound /> Rotate link key
                </button>
                <button
                  className="btn danger"
                  onClick={async () => {
                    if (!confirm(`Delete ${d.name} and all of its flights?`)) return;
                    try {
                      await api(`/api/v2/organisations/${orgId}/drones/${d.id}`, { method: 'DELETE' });
                      navigate('/fleet');
                    } catch (err) {
                      toast(errorMessage(err), 'error');
                    }
                  }}
                >
                  <Trash2 /> Delete
                </button>
              </>
            )}
          </>
        }
      />
      <div className="stack">
        <div className="grid kpis five">
          <Kpi label="Flight hours" value={formatHours(d.flightTimeS)} sub={`${d.flightCount} flights · ${fmtDistance(d.distanceM)}`} icon={Clock} />
          <Kpi label="Software" value={<span style={{ fontSize: 16 }}>{l?.firmware ?? d.firmwareVersion ?? '—'}</span>} sub="installed version" icon={Cpu} iconTone="violet" />
          <Kpi label="Battery" value={tel ? `${Math.round(tel.battery.pct)} %` : `${d.batteryCycles} cycles`} sub={d.batteryHealthPct !== null ? `estimated health ${d.batteryHealthPct} %` : 'health after 6 flights'} icon={BatteryMedium} iconTone="ok" />
          <Kpi label="Health score" value={d.healthScore ?? '—'} tone={scoreTone(d.healthScore)} sub="mean of the last 10 flights" icon={HeartPulse} iconTone={scoreTone(d.healthScore) ?? undefined} />
          <Kpi label="Last seen" value={<span style={{ fontSize: 16 }}>{l?.online ? 'online now' : timeAgo(d.lastSeenAt)}</span>} sub={d.linkKeyPrefix + '…'} icon={Signal} />
        </div>
        <div className="grid two">
          <Card title="Where it has been">
            <MapView
              fitKey={d.id}
              fit={[...(d.lastPosition ? [[d.lastPosition.lat, d.lastPosition.lon] as [number, number]] : []), ...(flights.data?.items ?? []).filter((f) => f.startLat !== null).map((f) => [f.startLat!, f.startLon!] as [number, number])]}
              markers={[
                ...(flights.data?.items ?? []).filter((f) => f.startLat !== null).map((f) => ({ id: f.id, lat: f.startLat!, lon: f.startLon!, color: '#a78bfa', radius: 4, label: fmtDate(f.startedAt) })),
                ...(tel ? [{ id: 'live', lat: tel.lat, lon: tel.lon, heading: tel.heading, color: '#38bdf8', label: 'live position' }] : d.lastPosition ? [{ id: 'last', lat: d.lastPosition.lat, lon: d.lastPosition.lon, color: '#94a3b8', radius: 8, label: 'last known position' }] : []),
              ]}
            />
          </Card>
          <Card title="Next mission & terrain">
            {d.nextMission ? (
              <div className="col">
                <div>
                  <Link to={`/missions/${d.nextMission.missionId}`}>{d.nextMission.name}</Link> · {fmtDate(d.nextMission.plannedAt)}
                </div>
                {d.nextMission.terrain ? (
                  <div className="small">
                    Terrain {Math.round(d.nextMission.terrain.minElevationM ?? 0)}–{Math.round(d.nextMission.terrain.maxElevationM ?? 0)} m AMSL · minimum clearance{' '}
                    <b>{d.nextMission.terrain.minClearanceM ?? '—'} m</b>
                  </div>
                ) : (
                  <div className="small muted">Terrain profile not computed yet (open the mission to compute it).</div>
                )}
              </div>
            ) : (
              <Empty>No mission scheduled.</Empty>
            )}
            <h3 style={{ marginTop: 16 }}>Health score per flight</h3>
            {history.length === 0 ? <Empty>No flights</Empty> : <ColumnChart data={history.map((f) => ({ label: shortDay(f.startedAt), value: f.healthScore ?? 0 }))} color="var(--ok)" height={130} />}
            <h3 style={{ marginTop: 12 }}>Battery used per flight (%)</h3>
            {history.length > 0 && <ColumnChart data={history.map((f) => ({ label: shortDay(f.startedAt), value: Math.round(Math.max(0, (f.batteryStartPct ?? 0) - (f.batteryEndPct ?? 0)) * 10) / 10 }))} color="var(--warn)" format={(v) => `${v} %`} height={120} />}
          </Card>
        </div>
        <Card title="Flights">
          {(flights.data?.items ?? []).length === 0 ? (
            <Empty>No flights recorded.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Pilot</th>
                    <th className="num">Duration</th>
                    <th className="num">Distance</th>
                    <th className="num">Battery</th>
                    <th>Health</th>
                  </tr>
                </thead>
                <tbody>
                  {flights.data!.items.map((f) => (
                    <tr key={f.id}>
                      <td>
                        <Link to={`/flights/${f.id}`}>{fmtDate(f.startedAt)}</Link>
                      </td>
                      <td>{f.pilotName ?? '—'}</td>
                      <td className="num">{fmtDuration(f.durationS)}</td>
                      <td className="num">{fmtDistance(f.distanceM)}</td>
                      <td className="num">
                        {f.batteryStartPct?.toFixed(0) ?? '—'} → {f.batteryEndPct?.toFixed(0) ?? '—'} %
                      </td>
                      <td>{f.healthScore === null ? '—' : <Badge tone={scoreTone(f.healthScore)}>{Math.round(f.healthScore)}</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <div className="grid two">
        <Card
          title={
            <h3>
              <Wrench /> Maintenance
            </h3>
          }
          actions={<Link to={`/maintenance?drone=${d.id}`}>Schedule & log →</Link>}
        >
          {!maint.data ? (
            <Loading />
          ) : (
            <div className="col" style={{ gap: 12 }} data-testid="drone-maintenance">
              {maint.data.tasks.length === 0 && <Empty icon={Wrench}>No maintenance scheduled.</Empty>}
              {[...maint.data.tasks]
                .sort((a, b) => b.due.used - a.due.used)
                .slice(0, 4)
                .map((t) => (
                  <div key={t.id}>
                    <div className="row small" style={{ justifyContent: 'space-between' }}>
                      <b>{t.name}</b>
                      <span className="muted">{remainingText(t.due)}</span>
                    </div>
                    <div className={`progress ${t.due.status === 'overdue' ? 'danger' : t.due.status === 'due_soon' ? 'warn' : 'ok'}`} style={{ marginTop: 5 }}>
                      <div style={{ width: `${Math.min(100, t.due.used * 100)}%` }} />
                    </div>
                  </div>
                ))}
              {/* Predictive alerts come from the flight data, with or without a schedule. */}
              {maint.data.health.filter((h) => h.level !== 'ok').map((h) => (
                <div key={h.indicator.metric} className={`finding ${h.level === 'action' ? 'critical' : 'warning'}`}>
                  <b>{h.indicator.label}</b> – {h.exceeded ? 'above its threshold' : `threshold in ~${h.remainingHours} h`}
                  <div className="small muted">{h.indicator.advice}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title="Software update history">
          {(updates.data ?? []).length === 0 ? (
            <Empty>No remote updates.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {updates.data!.map((u) => (
                    <tr key={u.id}>
                      <td>{u.version}</td>
                      <td>
                        <Badge tone={u.status === 'completed' ? 'ok' : u.status === 'failed' ? 'danger' : 'accent'}>{u.status}</Badge>
                      </td>
                      <td>{u.error ?? ''}</td>
                      <td>{fmtDate(u.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        </div>
        {d.notes && <Card title="Notes">{d.notes}</Card>}
      </div>
      {moving !== null && (
        <Modal
          title={`Move ${d.name} to a fleet`}
          onClose={() => setMoving(null)}
          actions={
            <button
              className="btn primary"
              disabled={moving === (d.fleetId ?? '')}
              onClick={async () => {
                try {
                  drone.setData(await api<DroneDto>(`/api/v2/organisations/${orgId}/drones/${d.id}`, { method: 'PATCH', body: { fleetId: moving || null } }));
                  setMoving(null);
                  toast(`${d.name} moved to ${(fleets.data ?? []).find((f) => f.id === moving)?.name ?? 'no fleet'}`);
                } catch (err) {
                  toast(errorMessage(err), 'error');
                }
              }}
            >
              Move
            </button>
          }
        >
          <label className="field">
            Fleet
            <select value={moving} onChange={(e) => setMoving(e.target.value)} data-testid="move-fleet">
              <option value="">No fleet</option>
              {(fleets.data ?? []).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        </Modal>
      )}
      {editing && (
        <Modal
          title="Edit drone"
          onClose={() => setEditing(false)}
          actions={
            <button
              className="btn primary"
              onClick={async () => {
                try {
                  drone.setData(await api<DroneDto>(`/api/v2/organisations/${orgId}/drones/${d.id}`, { method: 'PATCH', body: { ...form, fleetId: form.fleetId || null, airframeId: form.airframeId || null } }));
                  setEditing(false);
                } catch (err) {
                  toast(errorMessage(err), 'error');
                }
              }}
            >
              Save
            </button>
          }
        >
          <div className="form">
            <div className="form-grid">
              {(['name', 'model', 'serial'] as const).map((k) => (
                <label key={k} className="field">
                  {k[0]!.toUpperCase() + k.slice(1)}
                  <input value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
                </label>
              ))}
              <label className="field">
                Fleet
                <select value={form.fleetId} onChange={(e) => setForm({ ...form, fleetId: e.target.value })}>
                  <option value="">—</option>
                  {(fleets.data ?? []).map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Airframe model
                <select value={form.airframeId} onChange={(e) => setForm({ ...form, airframeId: e.target.value })} aria-label="Airframe model">
                  <option value="">—</option>
                  {AIRFRAMES.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              Notes
              <textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </label>
          </div>
        </Modal>
      )}
      {key && (
        <Modal title="New link key" onClose={() => setKey(null)}>
          <p>Configure the drone with this key. It will not be shown again.</p>
          <div className="secret">{key}</div>
        </Modal>
      )}
    </div>
  );
}
