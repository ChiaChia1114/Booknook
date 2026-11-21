import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AirspaceZoneDto, FlightLocationsDto } from '@athena-sky/shared';
import { useApi, useDateRange } from '../hooks';
import { useOrgId } from '../state/auth';
import { DateRangeFilter, FleetSelect } from '../components/Filters';
import { MapView } from '../components/MapView';
import { Badge, Card, ErrorBox, Kpi, Loading, PageHead, fmtDate, fmtDuration } from '../components/ui';
import { zoneLayers } from './Airspace';

export function LocationsPage() {
  const orgId = useOrgId();
  const r = useDateRange(90);
  const [fleetId, setFleetId] = useState('');
  const [compliance, setCompliance] = useState('all');
  const [selected, setSelected] = useState<string | null>(null);
  const res = useApi<FlightLocationsDto>(
    `/api/v2/organisations/${orgId}/analytics/locations?from=${encodeURIComponent(r.range.from)}&to=${encodeURIComponent(r.range.to)}&compliance=${compliance}${fleetId ? `&fleetId=${fleetId}` : ''}`,
  );
  const zones = useApi<AirspaceZoneDto[]>(`/api/v2/organisations/${orgId}/airspace/zones`);
  const d = res.data;
  const zl = zoneLayers(zones.data ?? []);
  return (
    <div className="content">
      <PageHead
        title="Flight Locations"
        subtitle="Understand where vehicles are used and verify that every operation stayed compliant with the regulations."
        actions={
          <>
            <DateRangeFilter r={r} />
            <FleetSelect value={fleetId} onChange={setFleetId} />
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
        <Loading />
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
              <MapView
                className="tall"
                testId="locations-map"
                fitKey={`${r.range.from}${fleetId}${compliance}`}
                fit={d.points.flatMap((p) => [[p.lat, p.lon] as [number, number], ...p.track])}
                polygons={zl.polygons}
                circles={zl.circles}
                lines={[
                  ...zl.lines,
                  ...d.points
                    .filter((p) => p.track.length > 1)
                    .map((p) => ({ id: `t-${p.flightId}`, points: p.track, color: p.compliant === false ? '#ef4444' : selected === p.flightId ? '#facc15' : '#38bdf8', weight: selected === p.flightId ? 4 : 2 })),
                ]}
                markers={d.points.map((p) => ({
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
            <Card title={`Flights (${d.points.length})`}>
              <div className="col" style={{ maxHeight: 520, overflowY: 'auto' }}>
                {d.points.map((p) => (
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
