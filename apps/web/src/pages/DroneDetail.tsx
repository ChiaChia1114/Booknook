import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { DroneDto, FirmwareUpdateDto, FleetDto, FlightDto, Paged } from '@athena-sky/shared';
import { AIRFRAMES, formatHours } from '@athena-sky/shared';
import { api, errorMessage } from '../api/client';
import { useApi } from '../hooks';
import { useAuth, useOrgId } from '../state/auth';
import { useLive } from '../state/live';
import { MapView } from '../components/MapView';
import { BarChart } from '../components/charts';
import { Badge, Card, Empty, ErrorBox, Kpi, Loading, Modal, PageHead, fmtDate, fmtDistance, fmtDuration, scoreTone, timeAgo, useToast } from '../components/ui';
import { droneStatus } from './Fleet';

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
  const { live } = useLive();
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', model: '', serial: '', fleetId: '', notes: '', airframeId: '' });
  const d = drone.data;
  const l = live.drones[droneId];
  const tel = l?.online ? l.telemetry : null;
  if (drone.error) return <div className="content"><ErrorBox error={drone.error} /></div>;
  if (!d) return <Loading />;
  const history = [...(flights.data?.items ?? [])].reverse();
  return (
    <div className="content">
      <PageHead
        title={d.name}
        subtitle={
          <>
            {d.model || 'Unknown model'} · {AIRFRAMES.find((a) => a.id === d.airframeId)?.name ?? 'no airframe model'} · S/N {d.serial || '—'} · {d.fleetName ?? 'no fleet'} · {droneStatus({ online: l?.online ?? d.online, inFlight: !!l?.flightId })}
          </>
        }
        actions={
          <>
            {(l?.online ?? d.online) && (
              <Link className="btn primary" to={`/live?drone=${d.id}`}>
                Fly / watch live
              </Link>
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
                  Edit
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
                  Rotate link key
                </button>
                <button
                  className="btn danger"
                  onClick={async () => {
                    if (!confirm(`Delete ${d.name} and all of its flights?`)) return;
                    await api(`/api/v2/organisations/${orgId}/drones/${d.id}`, { method: 'DELETE' });
                    navigate('/fleet');
                  }}
                >
                  Delete
                </button>
              </>
            )}
          </>
        }
      />
      <div className="stack">
        <div className="grid kpis">
          <Kpi label="Flight hours" value={formatHours(d.flightTimeS)} sub={`${d.flightCount} flights · ${fmtDistance(d.distanceM)}`} />
          <Kpi label="Software" value={<span style={{ fontSize: 16 }}>{l?.firmware ?? d.firmwareVersion ?? '—'}</span>} sub="installed version" />
          <Kpi label="Battery" value={tel ? `${Math.round(tel.battery.pct)} %` : `${d.batteryCycles} cycles`} sub={d.batteryHealthPct !== null ? `estimated health ${d.batteryHealthPct} %` : 'health after 6 flights'} />
          <Kpi label="Health score" value={d.healthScore ?? '—'} tone={scoreTone(d.healthScore)} sub="mean of the last 10 flights" />
          <Kpi label="Last seen" value={<span style={{ fontSize: 16 }}>{l?.online ? 'online now' : timeAgo(d.lastSeenAt)}</span>} sub={d.linkKeyPrefix + '…'} />
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
            {history.length === 0 ? <Empty>No flights</Empty> : <BarChart data={history.map((f) => ({ label: fmtDate(f.startedAt), value: f.healthScore ?? 0 }))} color="var(--ok)" format={(v) => `${v.toFixed(0)} / 100`} height={100} />}
            <h3 style={{ marginTop: 12 }}>Battery used per flight (%)</h3>
            {history.length > 0 && (
              <BarChart
                data={history.map((f) => ({ label: fmtDate(f.startedAt), value: Math.max(0, (f.batteryStartPct ?? 0) - (f.batteryEndPct ?? 0)) }))}
                color="var(--warn)"
                format={(v) => `${v.toFixed(1)} %`}
                height={80}
              />
            )}
          </Card>
        </div>
        <Card title="Flights">
          {(flights.data?.items ?? []).length === 0 ? (
            <Empty>No flights recorded.</Empty>
          ) : (
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
          )}
        </Card>
        <Card title="Software update history">
          {(updates.data ?? []).length === 0 ? (
            <Empty>No remote updates.</Empty>
          ) : (
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
          )}
        </Card>
        {d.notes && <Card title="Notes">{d.notes}</Card>}
      </div>
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
