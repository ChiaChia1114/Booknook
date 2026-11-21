import { Suspense, lazy, useMemo, useRef, useState } from 'react';
import { Route } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type uPlot from 'uplot';
import type {
  FlightAnalysisDto,
  FlightDto,
  FlightEventDto,
  FlightFileDto,
  FlightSampleDto,
  LogTopicDto,
  PayloadImageDto,
  PayloadRecordDto,
} from '@athena-sky/shared';
import { api, download, errorMessage, upload } from '../api/client';
import { useApi } from '../hooks';
import { useAuth, useOrgId } from '../state/auth';
import { MapView } from '../components/MapView';
import type { DroneDto, LatLonAlt } from '@athena-sky/shared';
import { modelOfAirframe } from '../lib/models';

const FlightReplay3D = lazy(() => import('../components/FlightReplay3D'));
import { TimeChart, type Series } from '../components/charts';
import { Badge, Card, Empty, ErrorBox, Kpi, Loading, Modal, PageHead, fmtDate, fmtDistance, fmtDuration, fmtNum, scoreTone, useToast } from '../components/ui';

function LogPlotter({ base, file }: { base: string; file: FlightFileDto }) {
  const toast = useToast();
  const topics = useApi<{ topics: LogTopicDto[]; info: Record<string, unknown>; params: Record<string, number> }>(`${base}/files/${file.id}/topics`);
  const [topic, setTopic] = useState('');
  const [field, setField] = useState('');
  const [series, setSeries] = useState<{ t: number[]; values: (number | null)[]; label: string } | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  const sel = topics.data?.topics.find((t) => `${t.name}#${t.multiId}` === topic);
  const chartSeries: Series[] = useMemo(() => (series ? [{ label: series.label, values: series.values, color: '#38bdf8' }] : []), [series]);
  return (
    <div className="col">
      <ErrorBox error={topics.error} />
      {topics.data && (
        <div className="small muted">
          {String(topics.data.info.sys_name ?? '')} {String(topics.data.info.ver_sw ?? '')} · {topics.data.topics.length} topics · {Object.keys(topics.data.params).length} parameters
        </div>
      )}
      <div className="row">
        <select aria-label="Topic" value={topic} onChange={(e) => { setTopic(e.target.value); setField(''); }}>
          <option value="">Topic…</option>
          {(topics.data?.topics ?? []).map((t) => (
            <option key={`${t.name}#${t.multiId}`} value={`${t.name}#${t.multiId}`}>
              {t.name}
              {t.multiId ? ` [${t.multiId}]` : ''} ({t.samples})
            </option>
          ))}
        </select>
        <select aria-label="Field" value={field} onChange={(e) => setField(e.target.value)} disabled={!sel}>
          <option value="">Field…</option>
          {(sel?.fields ?? []).filter((f) => f !== 'timestamp').map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <button
          className="btn primary small"
          disabled={!sel || !field}
          onClick={async () => {
            try {
              const r = await api<{ t: number[]; values: (number | null)[] }>(`${base}/files/${file.id}/series`, { query: { topic: sel!.name, field, multiId: sel!.multiId } });
              setSeries({ ...r, label: `${sel!.name}.${field}` });
            } catch (err) {
              toast(errorMessage(err), 'error');
            }
          }}
        >
          Plot
        </button>
        {series && (
          <>
            <button
              className="btn small"
              onClick={() => {
                const canvas = plotRef.current?.ctx.canvas;
                if (!canvas) return;
                const a = document.createElement('a');
                a.href = canvas.toDataURL('image/png');
                a.download = `${series.label}.png`;
                a.click();
              }}
            >
              Export PNG
            </button>
            <button
              className="btn small"
              onClick={() => {
                const csv = ['time_s,' + series.label, ...series.t.map((t, i) => `${t},${series.values[i] ?? ''}`)].join('\n');
                const a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
                a.download = `${series.label}.csv`;
                a.click();
              }}
            >
              Export CSV
            </button>
          </>
        )}
      </div>
      {series && <TimeChart relative x={series.t} series={chartSeries} height={240} onReady={(u) => (plotRef.current = u)} />}
    </div>
  );
}

export function FlightDetailPage() {
  const { flightId = '' } = useParams();
  const orgId = useOrgId();
  const { can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const base = `/api/v2/organisations/${orgId}/flights/${flightId}`;
  const flight = useApi<FlightDto>(base);
  const samples = useApi<FlightSampleDto[]>(`${base}/samples?maxPoints=5000`);
  const events = useApi<FlightEventDto[]>(`${base}/events`);
  const live = flight.data?.status === 'in_progress';
  const analysis = useApi<FlightAnalysisDto>(flight.data && !live ? `${base}/analysis` : null, [flight.data?.status]);
  const files = useApi<FlightFileDto[]>(`${base}/files`);
  const payload = useApi<PayloadRecordDto[]>(`${base}/payload`);
  const images = useApi<PayloadImageDto[]>(`${base}/images`);
  const [notes, setNotes] = useState<string | null>(null);
  const [view3d, setView3d] = useState(false);
  const droneInfo = useApi<DroneDto>(view3d && flight.data ? `/api/v2/organisations/${orgId}/drones/${flight.data.droneId}` : null, [view3d, flight.data?.droneId]);
  // The plan as uploaded to the drone for this flight (not the mission as edited since).
  const missionInfo = useApi<{ missionId: string | null; snapshot: boolean; path: LatLonAlt[] }>(flight.data?.missionId ? `${base}/planned-route` : null, [flight.data?.missionId]);
  const plannedPath = missionInfo.data && missionInfo.data.path.length > 1 ? missionInfo.data.path : null;
  const replayModel = modelOfAirframe(droneInfo.data?.airframeId);
  const [imgFiles, setImgFiles] = useState<FileList | null>(null);
  const [offset, setOffset] = useState('0');

  const s = samples.data ?? [];
  const x = useMemo(() => s.map((p) => p.t / 1000), [s]);
  const charts = useMemo(
    () => ({
      alt: [
        { label: 'Altitude (rel, m)', values: s.map((p) => p.altRel), color: '#38bdf8' },
        { label: 'Climb (m/s)', values: s.map((p) => p.climbRate), color: '#a78bfa', scale: 'v' },
      ] as Series[],
      speed: [{ label: 'Ground speed (m/s)', values: s.map((p) => p.groundSpeed), color: '#22c55e' }] as Series[],
      battery: [
        { label: 'Battery (%)', values: s.map((p) => p.batteryPct), color: '#f59e0b' },
        { label: 'Voltage (V)', values: s.map((p) => p.voltage), color: '#ef4444', scale: 'v' },
        { label: 'Current (A)', values: s.map((p) => p.current), color: '#38bdf8', scale: 'a' },
      ] as Series[],
      attitude: [
        { label: 'Roll (°)', values: s.map((p) => p.roll), color: '#38bdf8' },
        { label: 'Pitch (°)', values: s.map((p) => p.pitch), color: '#f472b6' },
      ] as Series[],
      vib: [{ label: 'Vibration (m/s²)', values: s.map((p) => p.vibration), color: '#ef4444' }] as Series[],
      motors: [0, 1, 2, 3].map((i) => ({ label: `Motor ${i + 1}`, values: s.map((p) => p.motors?.[i] ?? null), color: ['#38bdf8', '#22c55e', '#f59e0b', '#ef4444'][i]! })) as Series[],
    }),
    [s],
  );
  const f = flight.data;
  if (flight.error) return <div className="content"><ErrorBox error={flight.error} /></div>;
  if (!f) return <Loading />;
  const track = s.map((p) => [p.lat, p.lon] as [number, number]);
  const photos = (payload.data ?? []).filter((p) => p.kind === 'photo' && typeof p.data.lat === 'number');
  const a = analysis.data;
  return (
    <div className="content">
      <PageHead
        title={`${f.droneName} · ${fmtDate(f.startedAt)}`}
        subtitle={
          <>
            Pilot {f.pilotName ?? '—'} · {f.source === 'live' ? 'recorded live over LTE' : 'uploaded log'} ·{' '}
            {f.status === 'in_progress' ? <Badge tone="accent">in progress</Badge> : f.status === 'aborted' ? <Badge tone="warn">aborted</Badge> : <Badge tone="ok">completed</Badge>}
            {f.missionId && (
              <>
                {' '}
                · <Link to={`/missions/${f.missionId}`}>mission</Link>
              </>
            )}
          </>
        }
        actions={
          <>
            {(['csv', 'kml', 'gpx', 'json'] as const).map((fmt) => (
              <button key={fmt} className="btn small" onClick={() => download(`${base}/export?format=${fmt}`)}>
                {fmt.toUpperCase()}
              </button>
            ))}
            {can('flight.upload') && !live && (
              <button
                className="btn small"
                onClick={async () => {
                  try {
                    const r = await api<{ ok: boolean; message: string }>(`${base}/logbook-export`, { method: 'POST' });
                    toast(r.ok ? 'Exported to the logbook' : `Logbook export failed: ${r.message}`, r.ok ? 'ok' : 'error');
                  } catch (err) {
                    toast(errorMessage(err), 'error');
                  }
                }}
              >
                Export to logbook
              </button>
            )}
            {can('flight.edit') && (
              <>
                <button className="btn small" onClick={() => setNotes(f.notes)}>
                  Notes
                </button>
                {!live && (
                  <button
                    className="btn small danger"
                    onClick={async () => {
                      if (!confirm('Delete this flight log permanently?')) return;
                      await api(base, { method: 'DELETE' });
                      navigate('/flights');
                    }}
                  >
                    Delete
                  </button>
                )}
              </>
            )}
          </>
        }
      />
      <div className="stack">
        <div className="grid kpis">
          <Kpi label="Duration" value={fmtDuration(f.durationS)} />
          <Kpi label="Distance" value={fmtDistance(f.distanceM)} />
          <Kpi label="Max altitude" value={`${f.maxAltM.toFixed(1)} m`} />
          <Kpi label="Max speed" value={`${f.maxSpeedMs.toFixed(1)} m/s`} />
          <Kpi label="Battery" value={`${fmtNum(f.batteryStartPct, 0)} → ${fmtNum(f.batteryEndPct, 0)} %`} />
          <Kpi label="Health score" value={f.healthScore === null ? '—' : Math.round(f.healthScore)} tone={scoreTone(f.healthScore)} />
        </div>
        {f.notes && <div className="notice">{f.notes}</div>}
        <div className="grid two">
          <Card
            title="Flight path"
            actions={
              <div className="segmented" role="group" aria-label="Flight path view">
                <button className={`btn small${view3d ? '' : ' primary'}`} onClick={() => setView3d(false)}>
                  2D map
                </button>
                <button className={`btn small${view3d ? ' primary' : ''}`} onClick={() => setView3d(true)} disabled={s.length < 2}>
                  3D replay
                </button>
              </div>
            }
          >
            {view3d ? (
              <Suspense fallback={<Loading what="Loading the 3D replay…" />}>
                {droneInfo.data && (!flight.data?.missionId || missionInfo.data || missionInfo.error) ? <FlightReplay3D samples={s} planned={plannedPath} model={replayModel} /> : <Loading what="Loading…" />}
              </Suspense>
            ) : (
            <MapView
              className="tall"
              fitKey={`${f.id}-${track.length > 0}`}
              fit={track}
              lines={[
                ...(plannedPath && plannedPath.length > 1 ? [{ id: 'planned', points: plannedPath.map((p) => [p.lat, p.lon] as [number, number]), color: '#a78bfa', dashed: true, weight: 2, label: 'Planned route' }] : []),
                { id: 'track', points: track, color: '#38bdf8' },
              ]}
              markers={[
                ...(track.length ? [{ id: 'start', lat: track[0]![0], lon: track[0]![1], color: '#22c55e', label: 'Take-off' }, { id: 'end', lat: track.at(-1)![0], lon: track.at(-1)![1], color: '#ef4444', label: 'Landing' }] : []),
                ...(a?.metrics.routeWorstLat !== undefined && a.metrics.routeWorstLon !== undefined && (a.metrics.routeMaxM ?? 0) > 2
                  ? [{ id: 'worst', lat: a.metrics.routeWorstLat, lon: a.metrics.routeWorstLon, color: '#f59e0b', radius: 7, label: `Largest route deviation: ${fmtNum(a.metrics.routeMaxM, 1)} m` }]
                  : []),
                ...photos.map((p) => ({ id: p.id, lat: p.data.lat as number, lon: p.data.lon as number, color: '#facc15', radius: 4, label: `Photo #${String(p.data.seq ?? '')}` })),
                ...(images.data ?? []).filter((i) => i.lat !== null).map((i) => ({ id: i.id, lat: i.lat!, lon: i.lon!, color: '#a78bfa', radius: 5, label: i.filename })),
              ]}
            />
            )}
          </Card>
          <Card title="Post-flight analytics" actions={can('flight.edit') && !live && <button className="btn small" onClick={async () => { analysis.setData(await api<FlightAnalysisDto>(`${base}/analysis`, { method: 'POST' })); }}>Re-analyse</button>}>
            {live ? (
              <Empty>Analytics run automatically when the flight ends.</Empty>
            ) : !a ? (
              <Loading />
            ) : (
              <div className="col" data-testid="analysis">
                <div className="row">
                  <span className="score" style={{ color: `var(--${scoreTone(a.score) ?? 'text'})` }}>{Math.round(a.score)}</span>
                  <span className="muted">/ 100 health score</span>
                </div>
                {a.findings.map((x, i) => (
                  <div key={i} className={`finding ${x.severity}`}>
                    <b>{x.title}</b> <Badge tone={x.severity === 'critical' ? 'danger' : x.severity === 'warning' ? 'warn' : 'ok'}>{x.severity}</Badge>
                    <div className="small muted">{x.detail}</div>
                  </div>
                ))}
                {a.metrics.routeMeanM !== undefined && (
                  <div className="route-conf" data-testid="route-conformance">
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <h3 className="row" style={{ gap: 6 }}>
                        <Route size={15} aria-hidden="true" /> Route conformance
                      </h3>
                      <span className="small muted">
                        <span className="legend-line planned" /> planned <span className="legend-line flown" /> flown
                      </span>
                    </div>
                    <div className="route-figures">
                      <div>
                        <span className="small muted">Mean deviation</span>
                        <b>{fmtNum(a.metrics.routeMeanM, 1)} m</b>
                      </div>
                      <div>
                        <span className="small muted">95th percentile</span>
                        <b>{fmtNum(a.metrics.routeP95M, 1)} m</b>
                      </div>
                      <div>
                        <span className="small muted">Maximum</span>
                        <b>{fmtNum(a.metrics.routeMaxM, 1)} m</b>
                      </div>
                      <div>
                        <span className="small muted">Outside 10 m corridor</span>
                        <b style={{ color: (a.metrics.routeOutsidePct ?? 0) > 15 ? 'var(--warn-text)' : undefined }}>{fmtNum(a.metrics.routeOutsidePct, 1)} %</b>
                      </div>
                      <div>
                        <span className="small muted">Route flown</span>
                        <b style={{ color: (a.metrics.routeCoveragePct ?? 100) < 80 ? 'var(--warn-text)' : undefined }}>{fmtNum(a.metrics.routeCoveragePct, 1)} %</b>
                      </div>
                      <div>
                        <span className="small muted">Max altitude deviation</span>
                        <b>{fmtNum(a.metrics.routeMaxAltDevM, 1)} m</b>
                      </div>
                    </div>
                  </div>
                )}
                <details>
                  <summary className="small muted">All metrics</summary>
                  <table className="table small">
                    <tbody>
                      {Object.entries(a.metrics).map(([k, v]) => (
                        <tr key={k}>
                          <td>{k}</td>
                          <td className="num">{v}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
                <h3 style={{ marginTop: 8 }}>Compliance</h3>
                {!f.compliance ? (
                  <span className="muted">Not checked</span>
                ) : f.compliance.compliant ? (
                  <Badge tone="ok">Compliant with all checks</Badge>
                ) : (
                  f.compliance.violations.map((v, i) => (
                    <div key={i} className="finding critical small">
                      {v.message}
                    </div>
                  ))
                )}
              </div>
            )}
          </Card>
        </div>
        {s.length > 1 && (
          <div className="grid two">
            <Card title="Altitude & climb rate">
              <TimeChart x={x} series={charts.alt} />
            </Card>
            <Card title="Ground speed">
              <TimeChart x={x} series={charts.speed} />
            </Card>
            <Card title="Battery">
              <TimeChart x={x} series={charts.battery} />
            </Card>
            <Card title="Attitude">
              <TimeChart x={x} series={charts.attitude} />
            </Card>
            {s.some((p) => p.vibration !== null) && (
              <Card title="Vibration">
                <TimeChart x={x} series={charts.vib} />
              </Card>
            )}
            {s.some((p) => p.motors) && (
              <Card title="Motor outputs">
                <TimeChart x={x} series={charts.motors} />
              </Card>
            )}
          </div>
        )}
        <div className="grid two">
          <Card title="Events">
            {(events.data ?? []).length === 0 ? (
              <Empty>No events</Empty>
            ) : (
              <div className="event-log" style={{ maxHeight: 320 }}>
                {events.data!.map((e, i) => (
                  <div key={i} style={{ color: e.level === 'critical' || e.level === 'error' ? 'var(--danger)' : e.level === 'warning' ? 'var(--warn)' : undefined }}>
                    {new Date(e.t).toLocaleTimeString()} [{e.level}] {e.message}
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card title="Original log files">
            {(files.data ?? []).length === 0 ? (
              <Empty>No original log attached (live telemetry only).</Empty>
            ) : (
              files.data!.map((file) => (
                <div key={file.id} className="col" style={{ marginBottom: 12 }}>
                  <div className="row">
                    <b>{file.filename}</b> <Badge>{file.kind}</Badge> <span className="small muted">{(file.size / 1024).toFixed(0)} KB</span>
                    <button className="btn small right" onClick={() => download(`${base}/files/${file.id}/download`)}>
                      Download
                    </button>
                  </div>
                  {file.kind === 'ulog' && <LogPlotter base={base} file={file} />}
                </div>
              ))
            )}
          </Card>
        </div>
        <Card title="Payload data & images" actions={(images.data ?? []).length > 0 && <button className="btn small" onClick={() => download(`${base}/images.csv`)}>Geotags CSV</button>}>
          {can('flight.upload') && !live && (
            <div className="row" style={{ marginBottom: 12 }}>
              <input type="file" accept="image/*" multiple onChange={(e) => setImgFiles(e.target.files)} aria-label="Images" />
              <label className="row small muted">
                Camera clock offset (s)
                <input style={{ width: 80 }} value={offset} onChange={(e) => setOffset(e.target.value)} />
              </label>
              <button
                className="btn small primary"
                disabled={!imgFiles || imgFiles.length === 0}
                onClick={async () => {
                  const fd = new FormData();
                  fd.append('timeOffsetS', offset);
                  // Without EXIF time stamps the file modification time is used as capture time.
                  Array.from(imgFiles!).forEach((file, i) => fd.append(`capturedAt_${i}`, new Date(file.lastModified).toISOString()));
                  for (const file of Array.from(imgFiles!)) fd.append('files', file);
                  try {
                    await upload(`${base}/images`, fd);
                    toast('Images uploaded and geotagged', 'ok');
                    images.reload();
                  } catch (err) {
                    toast(errorMessage(err), 'error');
                  }
                }}
              >
                Upload & geotag
              </button>
            </div>
          )}
          {(images.data ?? []).length > 0 && (
            <div className="gallery" style={{ marginBottom: 12 }}>
              {images.data!.map((i) => (
                <figure key={i.id}>
                  <img src={i.url} alt={i.filename} loading="lazy" />
                  <figcaption className="muted">
                    {i.filename}
                    <br />
                    {i.lat !== null ? `${i.lat.toFixed(5)}, ${i.lon!.toFixed(5)}` : 'no position'}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
          {(payload.data ?? []).length === 0 ? (
            <Empty>No payload records.</Empty>
          ) : (
            <div className="table-wrap" style={{ maxHeight: 280, overflowY: 'auto' }}>
              <table className="table small">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Kind</th>
                    <th>Data</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.data!.slice(0, 500).map((p) => (
                    <tr key={p.id}>
                      <td>{new Date(p.t).toLocaleTimeString()}</td>
                      <td>{p.kind}</td>
                      <td className="mono">{JSON.stringify(p.data)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      {notes !== null && (
        <Modal
          title="Flight notes"
          onClose={() => setNotes(null)}
          actions={
            <button
              className="btn primary"
              onClick={async () => {
                flight.setData(await api<FlightDto>(base, { method: 'PATCH', body: { notes } }));
                setNotes(null);
              }}
            >
              Save
            </button>
          }
        >
          <textarea rows={5} style={{ width: '100%' }} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Modal>
      )}
    </div>
  );
}
