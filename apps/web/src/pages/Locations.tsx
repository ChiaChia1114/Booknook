import { TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { AirspaceZoneDto, FlightLocationsDto, LocationPointDto } from '@athena-sky/shared';
import { api, errorMessage } from '../api/client';
import { useApi, useDateRange } from '../hooks';
import { useOrgId } from '../state/auth';
import { DateRangeFilter, DroneSelect, FleetSelect } from '../components/Filters';
import { MapView } from '../components/MapView';
import { Badge, Card, ErrorBox, Kpi, Loading, PageHead, fmtDate, fmtDuration, loadError } from '../components/ui';
import { zoneLayers } from './Airspace';

export function LocationsPage() {
  const orgId = useOrgId();
  const r = useDateRange(90);
  const [params] = useSearchParams();
  const [fleetId, setFleetId] = useState('');
  const [droneId, setDroneId] = useState(params.get('drone') ?? '');
  const [compliance, setCompliance] = useState('all');
  const [selected, setSelected] = useState<string | null>(null);
  const url = `/api/v2/organisations/${orgId}/analytics/locations?from=${encodeURIComponent(r.range.from)}&to=${encodeURIComponent(r.range.to)}&compliance=${compliance}${fleetId ? `&fleetId=${fleetId}` : ''}${droneId ? `&droneId=${droneId}` : ''}`;
  const res = useApi<FlightLocationsDto>(url);
  // Further pages of the same query ("Load more"), their loading and their error belong to one
  // visit of the filters: dropped whenever the filters change – also back to earlier ones, whose
  // first page is read again – and an answer to an earlier visit is ignored.
  const [more, setMore] = useState<{ url: string; points: LocationPointDto[] }>({ url: '', points: [] });
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const visit = useRef(0);
  useEffect(() => {
    visit.current++;
    setMore({ url: '', points: [] });
    setMoreBusy(false);
    setMoreError(null);
  }, [url]);
  const zones = useApi<AirspaceZoneDto[]>(`/api/v2/organisations/${orgId}/airspace/zones`);
  const d = res.data;
  // While the flights of changed filters load, those of the previous ones stay on screen: no
  // further page can be asked for until the first page of the filters asked for is in (the next
  // page of the new filters does not continue the rows shown).
  const settled = res.dataPath === url && !res.loading;
  const points = d ? (settled && more.url === url ? [...d.points, ...more.points] : d.points) : [];
  const zl = zoneLayers(zones.data ?? []);
  const loadMore = async () => {
    if (!settled) return;
    const asked = { url, visit: visit.current };
    setMoreBusy(true);
    setMoreError(null);
    try {
      const next = await api<FlightLocationsDto>(`${asked.url}&offset=${points.length}`);
      if (visit.current !== asked.visit) return;
      // A flight added meanwhile shifts the pages: one already shown is not listed twice.
      const shown = new Set(points.map((p) => p.flightId));
      setMore({ url: asked.url, points: [...(more.url === asked.url ? more.points : []), ...next.points.filter((p) => !shown.has(p.flightId))] });
    } catch (err) {
      if (visit.current === asked.visit) setMoreError(errorMessage(err));
    } finally {
      if (visit.current === asked.visit) setMoreBusy(false);
    }
  };
  return (
    <div className="content">
      <PageHead
        title="Flight Locations"
        subtitle="Understand where vehicles are used and verify that every operation stayed compliant with the regulations."
        actions={
          <>
            <DateRangeFilter r={r} />
            <FleetSelect
              value={fleetId}
              onChange={(v) => {
                setFleetId(v);
                setDroneId('');
              }}
            />
            <DroneSelect value={droneId} onChange={setDroneId} fleetId={fleetId} />
            <select aria-label="Compliance" value={compliance} onChange={(e) => setCompliance(e.target.value)}>
              <option value="all">All flights</option>
              <option value="compliant">Compliant only</option>
              <option value="non_compliant">Non-compliant only</option>
            </select>
          </>
        }
      />
      <ErrorBox error={res.error} />
      {!d ? (
        res.error ? null : <Loading />
      ) : (
        <div className="stack">
          <div className="grid kpis four">
            <Kpi label="Flights" value={d.summary.flights} />
            <Kpi label="Compliant" value={d.summary.compliant} tone="ok" />
            <Kpi label="Non-compliant" value={d.summary.nonCompliant} tone={d.summary.nonCompliant ? 'danger' : 'ok'} />
            <Kpi label="Not checked" value={d.summary.unchecked} />
          </div>
          <div className="grid main-side">
            <Card tight>
              <ErrorBox error={loadError('Airspace zones (not drawn)', zones.error)} />
              <MapView
                className="tall"
                testId="locations-map"
                fitKey={res.dataPath ?? ''}
                fit={points.flatMap((p) => [[p.lat, p.lon] as [number, number], ...p.track])}
                polygons={zl.polygons}
                circles={zl.circles}
                lines={[
                  ...zl.lines,
                  ...points
                    .filter((p) => p.track.length > 1)
                    .map((p) => ({ id: `t-${p.flightId}`, points: p.track, color: p.compliant === false ? '#ef4444' : selected === p.flightId ? '#facc15' : '#38bdf8', weight: selected === p.flightId ? 4 : 2 })),
                ]}
                markers={points.map((p) => ({
                  id: p.flightId,
                  lat: p.lat,
                  lon: p.lon,
                  color: p.compliant === false ? '#ef4444' : p.compliant ? '#22c55e' : '#94a3b8',
                  radius: selected === p.flightId ? 9 : 6,
                  label: `${p.droneName} – ${fmtDate(p.startedAt)}${p.violations.length ? ` – ${p.violations.join('; ')}` : ''}`,
                  onClick: () => setSelected(p.flightId),
                }))}
              />
            </Card>
            <Card title={points.length < d.total ? `Flights (${points.length.toLocaleString('en')} of ${d.total.toLocaleString('en')})` : `Flights (${points.length.toLocaleString('en')})`}>
              {points.length < d.total && (
                <div className="notice small" data-testid="locations-partial" style={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 8 }}>
                  <span>
                    Showing the {points.length.toLocaleString('en')} most recent of {d.total.toLocaleString('en')} flights.
                  </span>
                  <button type="button" className="btn small" disabled={moreBusy || !settled} onClick={() => void loadMore()}>
                    {moreBusy || !settled ? 'Loading…' : `Load ${Math.min(d.points.length || 1, d.total - points.length).toLocaleString('en')} more`}
                  </button>
                </div>
              )}
              <ErrorBox error={moreError} />
              <div className="col" style={{ maxHeight: 520, overflowY: 'auto' }}>
                {points.map((p) => (
                  <div key={p.flightId} className={`drone-row${selected === p.flightId ? ' selected' : ''}`} onClick={() => setSelected(p.flightId)}>
                    <span className={`dot ${p.compliant === false ? 'danger' : p.compliant ? 'ok' : ''}`} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <Link to={`/flights/${p.flightId}`}>{p.droneName}</Link>
                        <span className="small muted">{fmtDuration(p.durationS)}</span>
                      </div>
                      <div className="small muted">
                        {fmtDate(p.startedAt)} · {p.pilotName ?? 'unknown pilot'} · max {p.maxAltM.toFixed(0)} m
                      </div>
                      {p.violations.map((v) => (
                        <div key={v} className="small check-line" style={{ color: 'var(--danger-text)' }}>
                          <TriangleAlert style={{ color: 'inherit' }} /> {v}
                        </div>
                      ))}
                    </div>
                    {p.compliant === null && <Badge>unchecked</Badge>}
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
