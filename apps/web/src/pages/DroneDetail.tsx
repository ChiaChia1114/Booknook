import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { BatteryMedium, Clock, Cpu, FolderInput, HeartPulse, KeyRound, Pencil, Radio, Signal, Trash2, Wrench } from 'lucide-react';
import type { DroneDto, DroneMaintenanceDto, FirmwareUpdateDto, FleetDto, FleetTracksDto, FlightDto, Paged, TerrainSummary } from '@athena-sky/shared';
import { AIRFRAMES, formatHours, hasVisibleText } from '@athena-sky/shared';
import { api, errorMessage } from '../api/client';
import { useApi, useLocated, useOpening, useStillShown } from '../hooks';
import { useAuth, useOrgId } from '../state/auth';
import { useLive } from '../state/live';
import { MapView } from '../components/MapView';
import { ColumnChart, TerrainProfile } from '../components/charts';
import { remainingText } from './Maintenance';
import { AsyncButton, Badge, Card, Empty, ErrorBox, Kpi, Loading, Modal, PageHead, fmtDate, fmtDistance, fmtDuration, loadError, scoreTone, timeAgo, useShowSecret, useToast } from '../components/ui';
import { droneStatus } from './Fleet';
import { LiveLinkNote, linkState } from '../components/LiveLink';

const shortDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' });

export function DroneDetailPage() {
  const { droneId = '' } = useParams();
  const orgId = useOrgId();
  const { can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const stillShown = useStillShown();
  const showSecret = useShowSecret();
  // A drone of another of the user's organisations (a link, a bookmark): shown there – nothing is
  // asked of this one about it.
  const located = useLocated('drones', droneId);
  const drone = useApi<DroneDto>(located.here ? `/api/v2/organisations/${orgId}/drones/${droneId}` : null);
  const lookingElsewhere = located.elsewhere;
  // The drone's own data is asked for once the drone is found here.
  const found = drone.data ? `/api/v2/organisations/${orgId}` : null;
  const flights = useApi<Paged<FlightDto>>(found && `${found}/flights?droneId=${droneId}&limit=100`);
  const updates = useApi<FirmwareUpdateDto[]>(found && `${found}/firmware-updates?droneId=${droneId}`);
  const fleets = useApi<FleetDto[]>(found && `${found}/fleets`);
  const maint = useApi<DroneMaintenanceDto>(found && `${found}/drones/${droneId}/maintenance`);
  // Tracks of its latest flights (of the last 12 months).
  const tracks = useApi<FleetTracksDto>(found && `${found}/fleet/tracks?droneId=${droneId}&days=365&perDrone=10`);
  const { live } = useLive();
  const [editing, setEditing] = useState(false);
  const [computingTerrain, setComputingTerrain] = useState(false);
  /** The fleet chosen in the "Move to fleet" dialog (null: closed). */
  const [moving, setMoving] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', model: '', serial: '', fleetId: '', notes: '', airframeId: '' });
  // A dialog's answer after it was closed (and maybe opened again) leaves the one shown now as it is.
  const moveOpening = useOpening(moving !== null);
  const editOpening = useOpening(editing);
  const d = drone.data;
  // The live status while the real-time link brings it – before it is made and while it is lost,
  // the stored one (last seen, last known position): never the status last received as current.
  const l = live.current ? live.drones[droneId] : undefined;
  const tel = l?.online ? l.telemetry : null;
  if (lookingElsewhere) return <Loading what="Opening this drone in your other organisation…" />;
  if (drone.error) return <div className="content"><ErrorBox error={loadError('The drone', drone.error)} /></div>;
  if (!d) return <Loading />;
  const history = [...(flights.data?.items ?? [])].reverse();
  // A chart of the latest flights – or what keeps it from being drawn.
  const flightsChart = (chart: () => ReactNode) =>
    !flights.data ? flights.error ? <div className="muted small">Not loaded – the flights could not be loaded.</div> : <Loading /> : history.length === 0 ? <Empty>No flights</Empty> : chart();
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
                <AsyncButton
                  className="btn"
                  onClick={async () => {
                    if (!confirm('Rotate the link key? The drone disconnects until it is configured with the new key.')) return;
                    try {
                      const { linkKey } = await api<{ linkKey: string }>(`/api/v2/organisations/${orgId}/drones/${d.id}/link-key`, { method: 'POST' });
                      // Shown once: over any page when this one is gone meanwhile.
                      if (stillShown()) setKey(linkKey);
                      else showSecret({ title: `New link key of ${d.name}`, note: 'Configure the drone with this key – it is shown only once.', secret: linkKey });
                    } catch (err) {
                      toast(errorMessage(err), 'error');
                    }
                  }}
                >
                  <KeyRound /> Rotate link key
                </AsyncButton>
                <AsyncButton
                  className="btn danger"
                  onClick={async () => {
                    if (!confirm(`Delete ${d.name} and all of its flights?`)) return;
                    try {
                      await api(`/api/v2/organisations/${orgId}/drones/${d.id}`, { method: 'DELETE' });
                      if (stillShown()) navigate('/fleet');
                    } catch (err) {
                      toast(errorMessage(err), 'error');
                    }
                  }}
                >
                  <Trash2 /> Delete
                </AsyncButton>
              </>
            )}
          </>
        }
      />
      <div className="stack">
        {/* The live status comes over the real-time link: while it is lost, the page says the
            status shown is the stored one. */}
        {linkState(live) === 'lost' && <LiveLinkNote small lost="The drone's status shown is the one last stored." />}
        <div className="grid kpis five">
          <Kpi label="Flight hours" value={formatHours(d.flightTimeS)} sub={`${d.flightCount} flights · ${fmtDistance(d.distanceM)}`} icon={Clock} />
          <Kpi label="Software" value={<span style={{ fontSize: 16 }}>{l?.firmware ?? d.firmwareVersion ?? '—'}</span>} sub="installed version" icon={Cpu} iconTone="violet" />
          <Kpi label="Battery" value={tel ? `${Math.round(tel.battery.pct)} %` : `${d.batteryCycles.toFixed(1)} cycles`} sub={`${tel ? `${d.batteryCycles.toFixed(1)} equivalent full cycles · ` : 'equivalent full cycles · '}${d.batteryHealthPct !== null ? `estimated health ${d.batteryHealthPct} %` : 'health after 6 flights'}`} icon={BatteryMedium} iconTone="ok" />
          <Kpi label="Health score" value={d.healthScore ?? '—'} tone={scoreTone(d.healthScore)} sub="mean of the last 10 flights" icon={HeartPulse} iconTone={scoreTone(d.healthScore) ?? undefined} />
          <Kpi label="Last seen" value={<span style={{ fontSize: 16 }}>{l?.online ? 'online now' : timeAgo(d.lastSeenAt)}</span>} sub={d.linkKeyPrefix + '…'} icon={Signal} />
        </div>
        <div className="grid two">
          <Card title="Where it has been">
            <ErrorBox error={loadError('The flights (not drawn)', flights.error)} />
            <ErrorBox error={loadError('The flight tracks (not drawn)', tracks.error)} />
            <MapView
              testId="drone-history-map"
              fitKey={`${d.id}:${tracks.dataPath}`}
              fit={[
                ...(d.lastPosition ? [[d.lastPosition.lat, d.lastPosition.lon] as [number, number]] : []),
                ...(flights.data?.items ?? []).filter((f) => f.startLat !== null).map((f) => [f.startLat!, f.startLon!] as [number, number]),
                ...(tracks.data?.drones[0]?.flights ?? []).flatMap((f) => f.track),
              ]}
              lines={[
                ...(tracks.data?.drones[0]?.flights ?? [])
                  .filter((f) => f.track.length > 1)
                  .map((f, i) => ({ id: f.flightId, points: f.track, color: i === 0 ? '#38bdf8' : '#a78bfa', weight: i === 0 ? 3 : 2, label: `Flight of ${fmtDate(f.startedAt)}` })),
                ...(d.nextMission && d.nextMission.route.length > 1 ? [{ id: 'next', points: d.nextMission.route, color: '#f59e0b', dashed: true, weight: 3, label: `Next mission "${d.nextMission.name}"` }] : []),
              ]}
              markers={[
                ...(flights.data?.items ?? []).filter((f) => f.startLat !== null).map((f) => ({ id: f.id, lat: f.startLat!, lon: f.startLon!, color: '#a78bfa', radius: 4, label: fmtDate(f.startedAt) })),
                ...(tel ? [{ id: 'live', lat: tel.lat, lon: tel.lon, heading: tel.heading, color: '#38bdf8', label: 'live position' }] : d.lastPosition ? [{ id: 'last', lat: d.lastPosition.lat, lon: d.lastPosition.lon, color: '#94a3b8', radius: 8, label: 'last known position' }] : []),
              ]}
            />
            <div className="legend">
              <span>
                <span className="legend-line" style={{ margin: 0 }} /> latest flight
              </span>
              <span>
                <span className="legend-line" style={{ margin: 0, borderTopColor: '#a78bfa' }} /> earlier flights ({tracks.data ? `${Math.max(0, (tracks.data.drones[0]?.flights.length ?? 0) - 1)} shown` : tracks.error ? 'not loaded' : 'loading…'})
              </span>
              {d.nextMission && (
                <span>
                  <span className="legend-line planned" style={{ margin: 0, borderTopColor: '#f59e0b' }} /> next mission
                </span>
              )}
              <Link to={`/locations?drone=${d.id}`}>All flights on Flight Locations →</Link>
            </div>
          </Card>
          <Card title="Next mission & terrain">
            {d.nextMission ? (
              <div className="col">
                <div>
                  <Link to={`/missions/${d.nextMission.missionId}`}>{d.nextMission.name}</Link> · {fmtDate(d.nextMission.plannedAt)}
                </div>
                {d.nextMission.route.length > 1 && (
                  <MapView
                    className="short"
                    testId="next-mission-map"
                    fitKey={d.nextMission.scheduleId}
                    fit={d.nextMission.route}
                    lines={[{ id: 'route', points: d.nextMission.route, color: '#f59e0b', dashed: true, weight: 3, label: d.nextMission.name }]}
                    markers={[{ id: 'start', lat: d.nextMission.route[0]![0], lon: d.nextMission.route[0]![1], color: '#22c55e', radius: 6, label: 'take-off' }]}
                  />
                )}
                {d.nextMission.terrain ? (
                  <>
                    <div className="small">
                      Terrain {Math.round(d.nextMission.terrain.minElevationM ?? 0)}–{Math.round(d.nextMission.terrain.maxElevationM ?? 0)} m AMSL · minimum clearance{' '}
                      <b>{d.nextMission.terrain.minClearanceM ?? '—'} m</b>
                    </div>
                    <TerrainProfile samples={d.nextMission.terrain.samples} labels />
                  </>
                ) : (
                  <div className="row small" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="muted">Terrain along the route not computed yet.</span>
                    <AsyncButton
                      className="btn small"
                      disabled={computingTerrain}
                      onClick={async () => {
                        setComputingTerrain(true);
                        try {
                          const t = await api<TerrainSummary>(`/api/v2/organisations/${orgId}/missions/${d.nextMission!.missionId}/terrain`, { method: 'POST' });
                          drone.setData({ ...d, nextMission: { ...d.nextMission!, terrain: t } });
                        } catch (err) {
                          toast(errorMessage(err), 'error');
                        } finally {
                          setComputingTerrain(false);
                        }
                      }}
                    >
                      {computingTerrain ? 'Computing…' : 'Compute terrain'}
                    </AsyncButton>
                  </div>
                )}
              </div>
            ) : (
              <Empty>No mission scheduled.</Empty>
            )}
            <h3 style={{ marginTop: 16 }}>Health score per flight</h3>
            {flightsChart(() => <ColumnChart data={history.map((f) => ({ label: shortDay(f.startedAt), value: f.healthScore ?? 0 }))} color="var(--ok)" height={130} />)}
            <h3 style={{ marginTop: 12 }}>Battery used per flight (%)</h3>
            {flightsChart(() => <ColumnChart data={history.map((f) => ({ label: shortDay(f.startedAt), value: Math.round(Math.max(0, (f.batteryStartPct ?? 0) - (f.batteryEndPct ?? 0)) * 10) / 10 }))} color="var(--warn)" format={(v) => `${v} %`} height={120} />)}
          </Card>
        </div>
        <Card title="Flights">
          <ErrorBox error={loadError('The flights', flights.error)} />
          {flights.data && flights.data.total > flights.data.items.length && (
            <div className="notice small" data-testid="drone-flights-partial" style={{ marginBottom: 8 }}>
              Showing the {flights.data.items.length.toLocaleString('en')} most recent of {flights.data.total.toLocaleString('en')} flights –{' '}
              <Link to={`/flights?drone=${d.id}&period=all`}>all of them in Flight Logs</Link>.
            </div>
          )}
          {!flights.data ? (
            flights.error ? null : <Loading />
          ) : flights.data.items.length === 0 ? (
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
                  {flights.data.items.map((f) => (
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
            maint.error ? <ErrorBox error={loadError('Maintenance', maint.error)} /> : <Loading />
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
          <ErrorBox error={loadError('The software updates', updates.error)} />
          {!updates.data ? (
            updates.error ? null : <Loading />
          ) : updates.data.length === 0 ? (
            <Empty>No remote updates.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {updates.data.map((u) => (
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
            <AsyncButton
              className="btn primary"
              disabled={moving === (d.fleetId ?? '') || !fleets.data}
              onClick={async () => {
                const still = moveOpening();
                try {
                  drone.setData(await api<DroneDto>(`/api/v2/organisations/${orgId}/drones/${d.id}`, { method: 'PATCH', body: { fleetId: moving || null } }));
                  if (still()) setMoving(null);
                  toast(`${d.name} moved to ${(fleets.data ?? []).find((f) => f.id === moving)?.name ?? 'no fleet'}`);
                } catch (err) {
                  toast(errorMessage(err), 'error');
                }
              }}
            >
              Move
            </AsyncButton>
          }
        >
          <ErrorBox error={loadError('The fleets', fleets.error)} />
          <label className="field">
            Fleet
            <select value={moving} onChange={(e) => setMoving(e.target.value)} data-testid="move-fleet" disabled={!fleets.data}>
              {!fleets.data && !fleets.error ? (
                <option value={moving}>Loading…</option>
              ) : (
                <>
                  <option value="">No fleet</option>
                  {d.fleetId && !(fleets.data ?? []).some((f) => f.id === d.fleetId) && <option value={d.fleetId}>{d.fleetName ?? 'Current fleet'}</option>}
                  {(fleets.data ?? []).map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </>
              )}
            </select>
          </label>
        </Modal>
      )}
      {editing && (
        <Modal
          title="Edit drone"
          onClose={() => setEditing(false)}
          actions={
            <AsyncButton
              className="btn primary"
              disabled={!hasVisibleText(form.name)}
              onClick={async () => {
                const still = editOpening();
                try {
                  drone.setData(await api<DroneDto>(`/api/v2/organisations/${orgId}/drones/${d.id}`, { method: 'PATCH', body: { ...form, fleetId: form.fleetId || null, airframeId: form.airframeId || null } }));
                  if (still()) setEditing(false);
                } catch (err) {
                  toast(errorMessage(err), 'error');
                }
              }}
            >
              Save
            </AsyncButton>
          }
        >
          <div className="form">
            <ErrorBox error={fleets.error ? `The fleets could not be loaded: ${fleets.error} – the drone stays in its fleet.` : null} />
            <div className="form-grid">
              {(['name', 'model', 'serial'] as const).map((k) => (
                <label key={k} className="field">
                  {k[0]!.toUpperCase() + k.slice(1)}
                  <input value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
                </label>
              ))}
              <label className="field">
                Fleet
                {/* Without the fleets, the drone stays in its fleet (shown, not changeable). */}
                <select value={form.fleetId} onChange={(e) => setForm({ ...form, fleetId: e.target.value })} disabled={!fleets.data} title={fleets.error ? `The fleets could not be loaded: ${fleets.error}` : undefined}>
                  {!fleets.data && !fleets.error ? (
                    <option value={form.fleetId}>Loading…</option>
                  ) : (
                    <>
                      <option value="">—</option>
                      {form.fleetId && !(fleets.data ?? []).some((f) => f.id === form.fleetId) && <option value={form.fleetId}>{d.fleetName ?? 'Current fleet'}</option>}
                      {(fleets.data ?? []).map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </>
                  )}
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
        // Shown once: closed only by its own buttons, not by a stray Escape or click beside it.
        <Modal
          title="New link key"
          onClose={() => setKey(null)}
          dismissible={false}
          actions={
            <button className="btn primary" onClick={() => setKey(null)}>
              Done
            </button>
          }
        >
          <p>Configure the drone with this key. It will not be shown again.</p>
          <div className="secret">{key}</div>
        </Modal>
      )}
    </div>
  );
}
