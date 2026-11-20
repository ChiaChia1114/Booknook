import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { DroneDto, FlightDto, MemberDto, Paged } from '@athena-sky/shared';
import { errorMessage, upload } from '../api/client';
import { useApi, useDateRange } from '../hooks';
import { useAuth, useOrgId } from '../state/auth';
import { DateRangeFilter, FleetSelect } from '../components/Filters';
import { Badge, Card, Empty, ErrorBox, Loading, Modal, PageHead, fmtDate, fmtDistance, fmtDuration, scoreTone } from '../components/ui';

function UploadModal({ onClose }: { onClose(): void }) {
  const orgId = useOrgId();
  const navigate = useNavigate();
  const drones = useApi<DroneDto[]>(`/api/v2/organisations/${orgId}/drones`);
  const members = useApi<MemberDto[]>(`/api/v2/organisations/${orgId}/members`);
  const [file, setFile] = useState<File | null>(null);
  const [droneId, setDroneId] = useState('');
  const [pilotId, setPilotId] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      title="Upload a flight log"
      onClose={onClose}
      actions={
        <button
          className="btn primary"
          disabled={!file || !droneId || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const fd = new FormData();
            fd.append('droneId', droneId);
            if (pilotId) fd.append('pilotId', pilotId);
            fd.append('notes', notes);
            fd.append('file', file!);
            try {
              const f = await upload<FlightDto>(`/api/v2/organisations/${orgId}/flights/upload`, fd);
              navigate(`/flights/${f.id}`);
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Uploading…' : 'Upload & analyse'}
        </button>
      }
    >
      <div className="form">
        <p className="small muted">
          Post-flight sync: upload the autopilot log from the SD card (PX4 ULog <code>.ulg</code>), a CSV telemetry log, or an Athena-sky JSON export. The log is stored in the cloud and
          analysed automatically.
        </p>
        <ErrorBox error={error} />
        <label className="field">
          Log file
          <input type="file" accept=".ulg,.csv,.txt,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <div className="form-grid">
          <label className="field">
            Drone
            <select value={droneId} onChange={(e) => setDroneId(e.target.value)}>
              <option value="">Select…</option>
              {(drones.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Pilot
            <select value={pilotId} onChange={(e) => setPilotId(e.target.value)}>
              <option value="">Me (if pilot)</option>
              {(members.data ?? []).map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          Notes
          <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}

export function FlightsPage() {
  const orgId = useOrgId();
  const { can } = useAuth();
  const r = useDateRange(90);
  const [fleetId, setFleetId] = useState('');
  const [droneId, setDroneId] = useState('');
  const [pilotId, setPilotId] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(0);
  const [uploading, setUploading] = useState(false);
  const limit = 25;
  const drones = useApi<DroneDto[]>(`/api/v2/organisations/${orgId}/drones`);
  const members = useApi<MemberDto[]>(`/api/v2/organisations/${orgId}/members`);
  const params = new URLSearchParams({ from: r.range.from, to: r.range.to, limit: String(limit), offset: String(page * limit) });
  if (fleetId) params.set('fleetId', fleetId);
  if (droneId) params.set('droneId', droneId);
  if (pilotId) params.set('pilotId', pilotId);
  if (status) params.set('status', status);
  const flights = useApi<Paged<FlightDto>>(`/api/v2/organisations/${orgId}/flights?${params}`);
  const f = flights.data;
  return (
    <div className="content">
      <PageHead
        title="Flight Logs"
        subtitle="Every flight log is stored in the cloud – historic and ongoing operations for the whole fleet and every drone and pilot."
        actions={can('flight.upload') && <button className="btn primary" onClick={() => setUploading(true)}>Upload log</button>}
      />
      <Card>
        <div className="row" style={{ marginBottom: 12 }}>
          <DateRangeFilter r={r} />
          <FleetSelect value={fleetId} onChange={(v) => { setFleetId(v); setPage(0); }} />
          <select aria-label="Drone" value={droneId} onChange={(e) => { setDroneId(e.target.value); setPage(0); }}>
            <option value="">All drones</option>
            {(drones.data ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <select aria-label="Pilot" value={pilotId} onChange={(e) => { setPilotId(e.target.value); setPage(0); }}>
            <option value="">All pilots</option>
            {(members.data ?? []).map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </select>
          <select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
            <option value="">Any status</option>
            <option value="in_progress">In progress</option>
            <option value="completed">Completed</option>
            <option value="aborted">Aborted</option>
          </select>
        </div>
        <ErrorBox error={flights.error} />
        {!f ? (
          <Loading />
        ) : f.items.length === 0 ? (
          <Empty>No flights match the filters.</Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table" data-testid="flights-table">
                <thead>
                  <tr>
                    <th>Start</th>
                    <th>Drone</th>
                    <th>Pilot</th>
                    <th>Source</th>
                    <th className="num">Duration</th>
                    <th className="num">Distance</th>
                    <th className="num">Max alt</th>
                    <th className="num">Battery</th>
                    <th>Health</th>
                    <th>Compliance</th>
                  </tr>
                </thead>
                <tbody>
                  {f.items.map((x) => (
                    <tr key={x.id}>
                      <td>
                        <Link to={`/flights/${x.id}`}>{fmtDate(x.startedAt)}</Link> {x.status === 'in_progress' && <Badge tone="accent">live</Badge>}
                        {x.status === 'aborted' && <Badge tone="warn">aborted</Badge>}
                      </td>
                      <td>{x.droneName}</td>
                      <td>{x.pilotName ?? '—'}</td>
                      <td>
                        <Badge>{x.source === 'live' ? 'LTE live' : 'uploaded'}</Badge>
                      </td>
                      <td className="num">{fmtDuration(x.durationS)}</td>
                      <td className="num">{fmtDistance(x.distanceM)}</td>
                      <td className="num">{x.maxAltM.toFixed(0)} m</td>
                      <td className="num">
                        {x.batteryStartPct?.toFixed(0) ?? '—'} → {x.batteryEndPct?.toFixed(0) ?? '—'} %
                      </td>
                      <td>{x.healthScore === null ? '—' : <Badge tone={scoreTone(x.healthScore)}>{Math.round(x.healthScore)}</Badge>}</td>
                      <td>{x.compliance ? <Badge tone={x.compliance.compliant ? 'ok' : 'danger'}>{x.compliance.compliant ? 'OK' : `${x.compliance.violations.length} issue(s)`}</Badge> : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}>
              <span className="small muted">
                {f.offset + 1}–{f.offset + f.items.length} of {f.total}
              </span>
              <div className="row">
                <button className="btn small" disabled={page === 0} onClick={() => setPage(page - 1)}>
                  ← Prev
                </button>
                <button className="btn small" disabled={f.offset + f.items.length >= f.total} onClick={() => setPage(page + 1)}>
                  Next →
                </button>
              </div>
            </div>
          </>
        )}
      </Card>
      {uploading && <UploadModal onClose={() => setUploading(false)} />}
    </div>
  );
}
