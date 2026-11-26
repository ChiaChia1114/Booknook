import { ChevronLeft, ChevronRight, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { DroneDto, FlightDto, MemberDto, Paged } from '@athena-sky/shared';
import { can as canRole } from '@athena-sky/shared';
import { errorMessage, upload } from '../api/client';
import { useApi, useDateRange, useStillShown } from '../hooks';
import { useAuth, useOrgId } from '../state/auth';
import { DateRangeFilter, FleetSelect } from '../components/Filters';
import { Badge, BusyButton, Card, Empty, ErrorBox, Loading, Modal, PageHead, fmtDate, fmtDistance, fmtDuration, loadError, scoreTone, useToast } from '../components/ui';

function UploadModal({ onClose, onUploaded }: { onClose(): void; onUploaded(): void }) {
  const orgId = useOrgId();
  const navigate = useNavigate();
  const toast = useToast();
  const stillShown = useStillShown();
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
        <BusyButton
          className="btn primary"
          disabled={!file || !droneId}
          busy={busy}
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
              onUploaded();
              // The dialog closed meanwhile (or the page left, e.g. for another organisation): said
              // so instead of opening the flight – it is in the list of its organisation.
              if (stillShown()) navigate(`/flights/${f.id}`);
              else toast(`The flight log was uploaded (${f.droneName ?? 'drone'}, ${fmtDate(f.startedAt)}).`, 'ok');
            } catch (err) {
              if (stillShown()) setError(errorMessage(err));
              else toast(`The flight log could not be uploaded: ${errorMessage(err)}`, 'error');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Uploading…' : 'Upload & analyse'}
        </BusyButton>
      }
    >
      <div className="form">
        <p className="small muted">
          Post-flight sync: upload the autopilot log from the SD card (PX4 ULog <code>.ulg</code>), a CSV telemetry log, or an Athena-sky JSON export. The log is stored in the cloud and
          analysed automatically.
        </p>
        <ErrorBox error={error} />
        <ErrorBox error={loadError('The drones', drones.error)} />
        <ErrorBox error={loadError('The pilots', members.error)} />
        <label className="field">
          Log file
          <input type="file" accept=".ulg,.csv,.txt,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <div className="form-grid">
          <label className="field">
            Drone
            {/* Still loading: says so (nothing to choose from yet). */}
            <select value={droneId} onChange={(e) => setDroneId(e.target.value)} disabled={!drones.data}>
              <option value="">{drones.data || drones.error ? 'Select…' : 'Loading…'}</option>
              {(drones.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Pilot
            <select value={pilotId} onChange={(e) => setPilotId(e.target.value)} disabled={!members.data && !members.error}>
              <option value="">{members.data || members.error ? 'Me (if pilot)' : 'Loading…'}</option>
              {(members.data ?? []).filter((m) => canRole(m.role, 'drone.control')).map((m) => (
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
  const [search, setSearch] = useSearchParams();
  // The drone and "All time" are part of the address (a drone's page links here with
  // ?drone=…&period=all): the address and the filters stay in step – the menu's "Flight Logs"
  // starts without them, choosing "All drones" or another period takes them out of the address.
  const droneId = search.get('drone') ?? '';
  const allTime = search.get('period') === 'all';
  const setInAddress = (key: string, value: string | null) =>
    setSearch(
      (p) => {
        const next = new URLSearchParams(p);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  const setDroneId = (v: string) => setInAddress('drone', v || null);
  const dates = useDateRange(allTime ? 'all' : 90);
  useEffect(() => {
    if (allTime && dates.days !== 'all') dates.setDays('all');
    else if (!allTime && dates.days === 'all') dates.setDays(90);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTime]);
  const r: typeof dates = {
    ...dates,
    setDays: (v) => {
      const next = typeof v === 'function' ? v(dates.days) : v;
      setInAddress('period', next === 'all' ? 'all' : null);
      dates.setDays(next);
    },
  };
  const [fleetId, setFleetId] = useState('');
  const [pilotId, setPilotId] = useState('');
  const [status, setStatus] = useState('');
  // The page belongs to the filters it was chosen for: any other filter (the period too) starts on page 1.
  const filters = [r.range.from, r.range.to, fleetId, droneId, pilotId, status].join('|');
  const [pageAt, setPageAt] = useState({ filters: '', page: 0 });
  const page = pageAt.filters === filters ? pageAt.page : 0;
  const setPage = (n: number) => setPageAt({ filters, page: n });
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
        actions={
          can('flight.upload') && (
            <button className="btn primary" onClick={() => setUploading(true)}>
              <Upload /> Upload log
            </button>
          )
        }
      />
      <Card>
        <div className="row wrap" style={{ marginBottom: 12 }}>
          <DateRangeFilter r={r} allTime />
          <FleetSelect value={fleetId} onChange={(v) => { setFleetId(v); setPage(0); }} />
          <select aria-label="Drone" value={droneId} onChange={(e) => { setDroneId(e.target.value); setPage(0); }} disabled={!drones.data && !!drones.error}>
            <option value="">All drones</option>
            {/* A drone not listed (an address naming none of this organisation's) is shown as it is. */}
            {droneId && !(drones.data ?? []).some((d) => d.id === droneId) && <option value={droneId}>{drones.data ? 'Unknown drone' : 'Selected drone'}</option>}
            {(drones.data ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <select aria-label="Pilot" value={pilotId} onChange={(e) => { setPilotId(e.target.value); setPage(0); }} disabled={!members.data && !!members.error}>
            <option value="">All pilots</option>
            {pilotId && !(members.data ?? []).some((m) => m.userId === pilotId) && <option value={pilotId}>{members.data ? 'Unknown pilot' : 'Selected pilot'}</option>}
            {(members.data ?? []).map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </select>
          <select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
            <option value="">Any status</option>
            <option value="in_progress">In progress</option>
            <option value="processing">Importing</option>
            <option value="completed">Completed</option>
            <option value="aborted">Aborted</option>
          </select>
        </div>
        <ErrorBox error={loadError('The drones to filter by', drones.error)} />
        <ErrorBox error={loadError('The pilots to filter by', members.error)} />
        <ErrorBox error={loadError('The flights', flights.error)} />
        {!f ? (
          flights.error ? null : <Loading />
        ) : f.items.length === 0 ? (
          f.total > 0 ? (
            // Flights were removed meanwhile: this page is past the end.
            <Empty>
              No flights on this page.{' '}
              <button className="btn small" onClick={() => setPage(0)}>
                First page
              </button>
            </Empty>
          ) : (
            <Empty>No flights match the filters.</Empty>
          )
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
                        {x.status === 'processing' && <Badge tone="accent">importing</Badge>}
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
                  <ChevronLeft /> Prev
                </button>
                <button className="btn small" disabled={f.offset + f.items.length >= f.total} onClick={() => setPage(page + 1)}>
                  Next <ChevronRight />
                </button>
              </div>
            </div>
          </>
        )}
      </Card>
      {uploading && <UploadModal onClose={() => setUploading(false)} onUploaded={() => void flights.reload()} />}
    </div>
  );
}
