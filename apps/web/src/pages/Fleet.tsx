import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { DroneCreatedDto, DroneDto, FirmwarePackageDto, FirmwareUpdateDto, FleetDto, FleetTracksDto } from '@athena-sky/shared';
import { AIRFRAMES, DEFAULT_AIRFRAME_ID, formatHours, hasVisibleText } from '@athena-sky/shared';
import { api, errorMessage, upload } from '../api/client';
import { useApi } from '../hooks';
import { useAuth, useOrgId } from '../state/auth';
import { useLive } from '../state/live';
import { FleetSelect } from '../components/Filters';
import { MapView } from '../components/MapView';
import { Badge, Card, Empty, ErrorBox, Loading, Modal, PageHead, fmtDate, scoreTone, timeAgo, useToast } from '../components/ui';

export function droneStatus(d: { online: boolean; inFlight: boolean }, liveArmed?: boolean) {
  if (d.inFlight || liveArmed)
    return (
      <Badge tone="accent">
        <span className="dot accent pulse" /> in flight
      </Badge>
    );
  if (d.online)
    return (
      <Badge tone="ok">
        <span className="dot ok" /> online
      </Badge>
    );
  return <Badge>offline</Badge>;
}

export function AddDroneModal({ onClose, onCreated }: { onClose(): void; onCreated(): void }) {
  const orgId = useOrgId();
  const fleets = useApi<FleetDto[]>(`/api/v2/organisations/${orgId}/fleets`);
  const [form, setForm] = useState({ name: '', model: '', serial: '', fleetId: '', airframeId: DEFAULT_AIRFRAME_ID });
  const [created, setCreated] = useState<DroneCreatedDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (created) {
    const ws = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v2/link`;
    return (
      <Modal title="Drone registered" onClose={onClose} actions={<button className="btn primary" onClick={onClose}>Done</button>}>
        <p>
          Configure the drone's datalink (or companion computer) with this <b>link key</b>. It is shown only once – rotate it from the drone page if it is lost.
        </p>
        <div className="secret" data-testid="link-key">
          {created.linkKey}
        </div>
        <p className="small muted">Endpoint: <code>{ws}</code></p>
        <p className="small muted">Try it with the bundled simulator:</p>
        <pre className="secret small" style={{ whiteSpace: 'pre-wrap' }}>{`npm run simulator -- --url ${ws} --key ${created.linkKey}`}</pre>
      </Modal>
    );
  }
  return (
    <Modal
      title="Register a drone"
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!hasVisibleText(form.name)}
            onClick={async () => {
              try {
                const d = await api<DroneCreatedDto>(`/api/v2/organisations/${orgId}/drones`, { body: { ...form, fleetId: form.fleetId || null } });
                setCreated(d);
                onCreated();
              } catch (err) {
                setError(errorMessage(err));
              }
            }}
          >
            Register
          </button>
        </>
      }
    >
      <div className="form">
        <ErrorBox error={error} />
        <label className="field">
          Name
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Falcon-7" autoFocus />
        </label>
        <div className="form-grid">
          <label className="field">
            Model
            <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
          </label>
          <label className="field">
            Serial number
            <input value={form.serial} onChange={(e) => setForm({ ...form, serial: e.target.value })} />
          </label>
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
              {AIRFRAMES.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </Modal>
  );
}

function FirmwarePanel({ drones }: { drones: DroneDto[] }) {
  const orgId = useOrgId();
  const { can } = useAuth();
  const toast = useToast();
  const packages = useApi<FirmwarePackageDto[]>(`/api/v2/organisations/${orgId}/firmware`);
  const updates = useApi<FirmwareUpdateDto[]>(`/api/v2/organisations/${orgId}/firmware-updates`);
  const { live } = useLive();
  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState({ version: '', model: '', notes: '' });
  const [target, setTarget] = useState<{ pkg: string; drones: Set<string> }>({ pkg: '', drones: new Set() });
  const manage = can('firmware.manage');
  return (
    <div className="stack">
      {manage && (
        <Card title="Upload firmware package">
          <div className="form-grid">
            <label className="field">
              Firmware file
              <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
            <label className="field">
              Version
              <input value={meta.version} onChange={(e) => setMeta({ ...meta, version: e.target.value })} placeholder="athena-fc 2.5.0" />
            </label>
            <label className="field">
              Target model
              <input value={meta.model} onChange={(e) => setMeta({ ...meta, model: e.target.value })} />
            </label>
            <label className="field">
              Release notes
              <input value={meta.notes} onChange={(e) => setMeta({ ...meta, notes: e.target.value })} />
            </label>
          </div>
          <button
            className="btn primary"
            style={{ marginTop: 10 }}
            disabled={!file || !meta.version}
            onClick={async () => {
              const fd = new FormData();
              fd.append('version', meta.version);
              fd.append('model', meta.model);
              fd.append('notes', meta.notes);
              fd.append('file', file!);
              try {
                await upload(`/api/v2/organisations/${orgId}/firmware`, fd);
                toast('Firmware uploaded', 'ok');
                packages.reload();
              } catch (err) {
                toast(errorMessage(err), 'error');
              }
            }}
          >
            Upload
          </button>
        </Card>
      )}
      <Card title="Packages">
        {(packages.data ?? []).length === 0 ? (
          <Empty>No firmware packages uploaded.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Model</th>
                  <th>File</th>
                  <th>SHA-256</th>
                  <th>Uploaded</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {packages.data!.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <b>{p.version}</b>
                      <div className="small muted">{p.notes}</div>
                    </td>
                    <td>{p.model || '—'}</td>
                    <td className="small">
                      {p.filename} ({(p.size / 1024).toFixed(0)} KB)
                    </td>
                    <td className="mono small">{p.sha256.slice(0, 12)}…</td>
                    <td>{fmtDate(p.createdAt)}</td>
                    <td>{manage && <button className="btn small" onClick={() => setTarget({ pkg: p.id, drones: new Set() })}>Deploy…</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Remote updates" actions={<button className="btn small" onClick={updates.reload}>Refresh</button>}>
        {(updates.data ?? []).length === 0 ? (
          <Empty>No updates yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Drone</th>
                  <th>Version</th>
                  <th>Status</th>
                  <th className="num">Progress</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {updates.data!.map((u) => {
                  const lp = live.drones[u.droneId]?.firmwareProgress;
                  const status = lp && !['completed', 'failed', 'cancelled'].includes(u.status) ? lp.status : u.status;
                  const progress = lp && status === lp.status ? lp.progress : u.progress;
                  return (
                    <tr key={u.id}>
                      <td>{u.droneName}</td>
                      <td>{u.version}</td>
                      <td>
                        <Badge tone={status === 'completed' ? 'ok' : status === 'failed' ? 'danger' : 'accent'}>{status}</Badge> {u.error && <span className="small muted">{u.error}</span>}
                      </td>
                      <td className="num">{Math.round(progress)} %</td>
                      <td>{timeAgo(u.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {target.pkg && (
        <Modal
          title="Deploy firmware"
          onClose={() => setTarget({ pkg: '', drones: new Set() })}
          actions={
            <button
              className="btn primary"
              disabled={target.drones.size === 0}
              onClick={async () => {
                let ok = 0;
                for (const id of target.drones) {
                  try {
                    await api(`/api/v2/organisations/${orgId}/drones/${id}/firmware-updates`, { body: { packageId: target.pkg } });
                    ok++;
                  } catch (err) {
                    toast(errorMessage(err), 'error');
                  }
                }
                toast(`Update scheduled for ${ok} drone(s). Offline drones update when they reconnect.`, 'ok');
                setTarget({ pkg: '', drones: new Set() });
                updates.reload();
              }}
            >
              Deploy to {target.drones.size} drone(s)
            </button>
          }
        >
          <div className="col">
            {drones.map((d) => (
              <label key={d.id} className="row">
                <input
                  type="checkbox"
                  checked={target.drones.has(d.id)}
                  onChange={(e) => {
                    const s = new Set(target.drones);
                    if (e.target.checked) s.add(d.id);
                    else s.delete(d.id);
                    setTarget({ ...target, drones: s });
                  }}
                />
                {d.name} <span className="muted small">({d.firmwareVersion ?? 'unknown'})</span> {droneStatus(d)}
              </label>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

/** One colour per drone on the fleet map (history and next mission alike). */
export const DRONE_COLORS = ['#38bdf8', '#22c55e', '#f59e0b', '#a78bfa', '#f472b6', '#14b8a6', '#ef4444', '#eab308', '#60a5fa', '#84cc16'];

export function FleetPage() {
  const orgId = useOrgId();
  const { can } = useAuth();
  const [fleetId, setFleetId] = useState('');
  const [tab, setTab] = useState<'assets' | 'map' | 'firmware'>('assets');
  const [adding, setAdding] = useState(false);
  const drones = useApi<DroneDto[]>(`/api/v2/organisations/${orgId}/drones${fleetId ? `?fleetId=${fleetId}` : ''}`);
  const { live } = useLive();
  const [historyDays, setHistoryDays] = useState(30);
  const [showNext, setShowNext] = useState(true);
  // Drones on the map, 500 at a time (by name); back to the first when the fleet changes.
  const [tracksPage, setTracksPage] = useState({ key: '', offset: 0 });
  const tracksOffset = tracksPage.key === fleetId ? tracksPage.offset : 0;
  // Where each drone has been (its latest flights) and where its next mission goes.
  const tracks = useApi<FleetTracksDto>(
    tab === 'map' ? `/api/v2/organisations/${orgId}/fleet/tracks?days=${historyDays || 30}${fleetId ? `&fleetId=${fleetId}` : ''}${tracksOffset ? `&offset=${tracksOffset}` : ''}` : null,
  );
  const colorOf = new Map((tracks.data?.drones ?? []).map((d, i) => [d.droneId, DRONE_COLORS[i % DRONE_COLORS.length]!]));
  const history = historyDays ? (tracks.data?.drones ?? []).flatMap((d) => d.flights.filter((f) => f.track.length > 1).map((f) => ({ d, f }))) : [];
  const nextRoutes = showNext ? (tracks.data?.drones ?? []).filter((d) => d.nextMission && d.nextMission.route.length > 1) : [];
  const list = (drones.data ?? []).map((d) => {
    const l = live.drones[d.id];
    return { ...d, online: l?.online ?? d.online, firmwareVersion: l?.firmware ?? d.firmwareVersion, liveTel: l?.online ? l.telemetry : null };
  });
  return (
    <div className="content">
      <PageHead
        title="Fleet Management"
        subtitle="Every asset of the company, synchronised in real time over LTE: status, software version, flight hours, battery life and next mission."
        actions={
          <>
            <FleetSelect value={fleetId} onChange={setFleetId} />
            {can('drone.manage') && (
              <button className="btn primary" onClick={() => setAdding(true)}>
                <Plus /> Register drone
              </button>
            )}
          </>
        }
      />
      <div className="tabs">
        {(['assets', 'map', 'firmware'] as const).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'assets' ? 'Assets' : t === 'map' ? 'Fleet map' : 'Software updates'}
          </button>
        ))}
      </div>
      <ErrorBox error={drones.error} />
      {!drones.data ? (
        <Loading />
      ) : tab === 'firmware' ? (
        <FirmwarePanel drones={list} />
      ) : tab === 'map' ? (
        <div className="grid main-side w3">
          <Card tight>
            <div className="row wrap small" style={{ gap: 12, padding: '8px 12px' }} data-testid="fleet-map-layers">
              <label className="row" style={{ gap: 6 }}>
                Flight history
                <select aria-label="Flight history" value={historyDays} onChange={(e) => setHistoryDays(Number(e.target.value))}>
                  <option value={0}>Off</option>
                  <option value={7}>Last 7 days</option>
                  <option value={30}>Last 30 days</option>
                  <option value={90}>Last 90 days</option>
                </select>
              </label>
              <label className="row" style={{ gap: 6 }}>
                <input type="checkbox" checked={showNext} onChange={(e) => setShowNext(e.target.checked)} /> Next missions
              </label>
              <span className="legend" style={{ marginTop: 0 }}>
                <span>
                  <span className="legend-line" style={{ margin: 0 }} /> flown (latest 5 per drone)
                </span>
                <span>
                  <span className="legend-line planned" style={{ margin: 0 }} /> next mission
                </span>
              </span>
            </div>
            <MapView
              className="tall"
              fitKey={`${drones.dataPath}:${tracks.dataPath}`}
              fit={[
                ...list.filter((d) => d.lastPosition).map((d) => [d.lastPosition!.lat, d.lastPosition!.lon] as [number, number]),
                ...history.flatMap(({ f }) => f.track),
                ...nextRoutes.flatMap((d) => d.nextMission!.route),
              ]}
              lines={[
                ...history.map(({ d, f }) => ({ id: `h-${f.flightId}`, points: f.track, color: colorOf.get(d.droneId), weight: 2, label: `${d.droneName} – flight of ${fmtDate(f.startedAt)}` })),
                ...nextRoutes.map((d) => ({
                  id: `n-${d.droneId}`,
                  points: d.nextMission!.route,
                  color: colorOf.get(d.droneId),
                  weight: 3,
                  dashed: true,
                  label: `${d.droneName} – next mission "${d.nextMission!.name}", ${fmtDate(d.nextMission!.plannedAt)}`,
                })),
                ...Object.values(live.drones).filter((d) => d.track.length > 1).map((d) => ({ id: d.droneId, points: d.track, color: '#38bdf8' })),
              ]}
              markers={list
                .filter((d) => d.liveTel || d.lastPosition)
                .map((d) => ({
                  id: d.id,
                  lat: d.liveTel?.lat ?? d.lastPosition!.lat,
                  lon: d.liveTel?.lon ?? d.lastPosition!.lon,
                  heading: d.liveTel ? d.liveTel.heading : undefined,
                  color: d.online ? '#38bdf8' : '#94a3b8',
                  label: `${d.name} – ${d.online ? 'online' : `last seen ${timeAgo(d.lastSeenAt)}`}`,
                }))}
            />
          </Card>
          <div className="stack">
            <Card title="Drones on the map">
              {tracks.data && tracks.data.total > tracks.data.drones.length && (
                <div className="notice small" style={{ marginBottom: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }} data-testid="fleet-map-partial">
                  <span>
                    Drones {(tracks.data.offset + 1).toLocaleString('en')}–{(tracks.data.offset + tracks.data.drones.length).toLocaleString('en')} of {tracks.data.total.toLocaleString('en')} (by name)
                  </span>
                  <span className="row" style={{ gap: 6 }}>
                    <button type="button" className="btn small" disabled={tracks.data.offset === 0} onClick={() => setTracksPage({ key: fleetId, offset: Math.max(0, tracksOffset - 500) })}>
                      Previous
                    </button>
                    <button type="button" className="btn small" disabled={tracks.data.offset + tracks.data.drones.length >= tracks.data.total} onClick={() => setTracksPage({ key: fleetId, offset: tracksOffset + 500 })}>
                      Next
                    </button>
                  </span>
                </div>
              )}
              {(tracks.data?.drones ?? []).length === 0 ? (
                <div className="muted small">{tracks.loading ? 'Loading…' : 'No drones.'}</div>
              ) : (
                <div className="col" data-testid="fleet-map-drones">
                  {tracks.data!.drones.map((d) => (
                    <div key={d.droneId} className="small">
                      <span className="swatch" style={{ background: colorOf.get(d.droneId) }} /> <Link to={`/fleet/${d.droneId}`}>{d.droneName}</Link>
                      <span className="muted">
                        {' '}
                        · {d.flights.length ? `${d.flights.length} flight${d.flights.length > 1 ? 's' : ''} shown` : 'no flights in the period'}
                      </span>
                      {d.nextMission && (
                        <div className="muted" style={{ marginLeft: 16 }}>
                          Next: <Link to={`/missions/${d.nextMission.missionId}`}>{d.nextMission.name}</Link> · {fmtDate(d.nextMission.plannedAt)}
                          {d.nextMission.terrain?.minClearanceM != null && ` · clearance ≥ ${d.nextMission.terrain.minClearanceM} m`}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card title="Online now">
              <h3 className="small muted">Drones</h3>
              {list.filter((d) => d.online).map((d) => (
                <div key={d.id} className="row">
                  <span className="dot ok" /> <Link to={`/fleet/${d.id}`}>{d.name}</Link> <span className="small muted">{d.liveTel?.mode}</span>
                </div>
              ))}
              {list.every((d) => !d.online) && <div className="muted small">No drone is online.</div>}
              <h3 className="small muted" style={{ marginTop: 12 }}>
                Pilots & operators
              </h3>
              {live.users.map((u) => (
                <div key={u.userId} className="row">
                  <span className="dot ok" /> {u.name} <span className="small muted">{u.role}</span>
                </div>
              ))}
            </Card>
          </div>
        </div>
      ) : list.length === 0 ? (
        <Card>
          <Empty>No drones registered yet.</Empty>
        </Card>
      ) : (
        <Card>
          <div className="table-wrap">
            <table className="table" data-testid="fleet-table">
              <thead>
                <tr>
                  <th>Drone</th>
                  <th>Status</th>
                  <th>Software</th>
                  <th className="num">Flight hours</th>
                  <th className="num">Flights</th>
                  <th className="num">Battery</th>
                  <th className="num">Health</th>
                  <th>Next mission</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {list.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <Link to={`/fleet/${d.id}`}>{d.name}</Link>
                      <div className="small muted">
                        {d.model || '—'} · {d.fleetName ?? 'no fleet'}
                      </div>
                    </td>
                    <td>{droneStatus(d, d.liveTel?.armed)}</td>
                    <td className="mono small">{d.firmwareVersion ?? '—'}</td>
                    <td className="num">{formatHours(d.flightTimeS)}</td>
                    <td className="num">{d.flightCount}</td>
                    <td className="num">
                      {d.liveTel ? `${Math.round(d.liveTel.battery.pct)} % · ` : ''}
                      <span title="Equivalent full cycles: the battery used by all flights, in whole packs">{d.batteryCycles.toFixed(1)} cycles</span>
                      {d.batteryHealthPct !== null && <div className="small muted">health {d.batteryHealthPct} %</div>}
                    </td>
                    <td className="num">{d.healthScore === null ? '—' : <Badge tone={scoreTone(d.healthScore)}>{d.healthScore}</Badge>}</td>
                    <td>
                      {d.nextMission ? (
                        <>
                          <Link to={`/missions/${d.nextMission.missionId}`}>{d.nextMission.name}</Link>
                          <div className="small muted">
                            {fmtDate(d.nextMission.plannedAt)}
                            {d.nextMission.terrain?.maxElevationM != null &&
                              ` · terrain ${Math.round(d.nextMission.terrain.minElevationM ?? 0)}–${Math.round(d.nextMission.terrain.maxElevationM)} m, min clearance ${d.nextMission.terrain.minClearanceM ?? '—'} m`}
                          </div>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="small">{d.online ? 'now' : timeAgo(d.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {adding && <AddDroneModal onClose={() => setAdding(false)} onCreated={drones.reload} />}
    </div>
  );
}
