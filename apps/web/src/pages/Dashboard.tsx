import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { DashboardDto, FlightLocationsDto } from '@athena-sky/shared';
import { formatHours } from '@athena-sky/shared';
import { useApi, useDateRange } from '../hooks';
import { useOrgId } from '../state/auth';
import { useLive } from '../state/live';
import { DateRangeFilter, FleetSelect } from '../components/Filters';
import { BarChart, HBarList } from '../components/charts';
import { MapView } from '../components/MapView';
import { Badge, Card, Empty, ErrorBox, Kpi, Loading, PageHead, fmtDate, fmtDistance, fmtDuration, scoreTone } from '../components/ui';

export function DashboardPage() {
  const orgId = useOrgId();
  const r = useDateRange(30);
  const [fleetId, setFleetId] = useState('');
  const q = `from=${encodeURIComponent(r.range.from)}&to=${encodeURIComponent(r.range.to)}${fleetId ? `&fleetId=${fleetId}` : ''}`;
  const dash = useApi<DashboardDto>(`/api/v2/organisations/${orgId}/analytics/dashboard?${q}`);
  const locations = useApi<FlightLocationsDto>(`/api/v2/organisations/${orgId}/analytics/locations?${q}`);
  const { live } = useLive();
  const d = dash.data;
  const liveDrones = Object.values(live.drones).filter((x) => x.online && x.telemetry);

  return (
    <div className="content">
      <PageHead
        title="Dashboard"
        subtitle="All major information about assets, users and flights at a glance."
        actions={
          <>
            <DateRangeFilter r={r} />
            <FleetSelect value={fleetId} onChange={setFleetId} />
          </>
        }
      />
      <ErrorBox error={dash.error} />
      {!d ? (
        <Loading />
      ) : (
        <div className="stack">
          <div className="grid kpis">
            <Kpi label="Drones" value={d.totals.drones} sub={`${d.totals.dronesOnline} online now`} />
            <Kpi label="Pilots" value={d.totals.pilots} sub={`${d.totals.pilotsOnline} online · ${d.totals.members} members`} />
            <Kpi label="Flights" value={d.totals.flights} sub={`${d.totals.flightsInProgress} in progress`} />
            <Kpi label="Flight hours" value={formatHours(d.totals.flightTimeS)} sub={`avg ${fmtDuration(d.totals.avgFlightS)} per flight`} />
            <Kpi label="Distance" value={fmtDistance(d.totals.distanceM)} />
            <Kpi label="Alerts" value={d.totals.alerts} tone={d.totals.alerts > 0 ? 'warn' : 'ok'} sub="from post-flight analytics" />
          </div>

          <div className="grid two">
            <Card title="Flights per day" actions={<span className="small muted">{d.flightsPerDay.reduce((n, x) => n + x.flights, 0)} flights</span>}>
              <BarChart testId="flights-per-day" data={d.flightsPerDay.map((x) => ({ label: x.date, value: x.flights }))} format={(v) => `${v} flights`} />
              <div className="row small muted" style={{ justifyContent: 'space-between' }}>
                <span>{d.flightsPerDay[0]?.date}</span>
                <span>{d.flightsPerDay.at(-1)?.date}</span>
              </div>
              <h3 style={{ marginTop: 12 }}>Flight hours per day</h3>
              <BarChart data={d.flightsPerDay.map((x) => ({ label: x.date, value: x.flightTimeS / 3600 }))} color="var(--violet)" format={(v) => `${v.toFixed(2)} h`} height={110} />
            </Card>
            <Card title="Flight locations" actions={<Link to="/locations">Open map →</Link>}>
              <MapView
                fitKey={q}
                fit={(locations.data?.points ?? []).map((p) => [p.lat, p.lon] as [number, number]).concat(liveDrones.map((x) => [x.telemetry!.lat, x.telemetry!.lon] as [number, number]))}
                markers={[
                  ...(locations.data?.points ?? []).map((p) => ({
                    id: p.flightId,
                    lat: p.lat,
                    lon: p.lon,
                    color: p.compliant === false ? '#ef4444' : '#22c55e',
                    label: `${p.droneName} · ${fmtDate(p.startedAt)}`,
                  })),
                  ...liveDrones.map((x) => ({ id: `live-${x.droneId}`, lat: x.telemetry!.lat, lon: x.telemetry!.lon, heading: x.telemetry!.heading, color: '#38bdf8', label: `${x.name} (live)` })),
                ]}
              />
            </Card>
          </div>

          <div className="grid three">
            <Card title="Most used drones">
              {d.topDrones.every((x) => x.flights === 0) ? (
                <Empty>No flights in this period.</Empty>
              ) : (
                <HBarList rows={d.topDrones.map((x) => ({ key: x.droneId, label: <Link to={`/fleet/${x.droneId}`}>{x.name}</Link>, value: x.flightTimeS }))} format={formatHours} />
              )}
            </Card>
            <Card title="Most experienced pilots">
              {d.topPilots.every((x) => x.flights === 0) ? (
                <Empty>No pilot activity in this period.</Empty>
              ) : (
                <HBarList rows={d.topPilots.map((x) => ({ key: x.userId, label: x.name, value: x.flightTimeS }))} format={formatHours} />
              )}
            </Card>
            <Card title="Alerts" actions={<Badge tone={d.alerts.length ? 'warn' : 'ok'}>{d.alerts.length}</Badge>}>
              {d.alerts.length === 0 ? (
                <Empty>No issues detected – the fleet looks healthy.</Empty>
              ) : (
                <div className="col" style={{ maxHeight: 260, overflowY: 'auto' }}>
                  {d.alerts.map((a, i) => (
                    <Link key={i} to={`/flights/${a.flightId}`} className={`finding ${a.severity}`} style={{ color: 'inherit' }}>
                      <b>{a.title}</b> · {a.droneName}
                      <div className="small muted">{a.detail}</div>
                    </Link>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <Card title="Recent flights" actions={<Link to="/flights">All flight logs →</Link>}>
            {d.recentFlights.length === 0 ? (
              <Empty>No flights recorded in this period.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Drone</th>
                      <th>Pilot</th>
                      <th className="num">Duration</th>
                      <th className="num">Distance</th>
                      <th className="num">Max alt</th>
                      <th>Health</th>
                      <th>Compliance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.recentFlights.map((f) => (
                      <tr key={f.id}>
                        <td>
                          <Link to={`/flights/${f.id}`}>{fmtDate(f.startedAt)}</Link>
                        </td>
                        <td>{f.droneName}</td>
                        <td>{f.pilotName ?? '—'}</td>
                        <td className="num">{fmtDuration(f.durationS)}</td>
                        <td className="num">{fmtDistance(f.distanceM)}</td>
                        <td className="num">{f.maxAltM.toFixed(0)} m</td>
                        <td>{f.healthScore === null ? <Badge>{f.status === 'in_progress' ? 'in flight' : '—'}</Badge> : <Badge tone={scoreTone(f.healthScore)}>{Math.round(f.healthScore)}</Badge>}</td>
                        <td>{f.compliance ? <Badge tone={f.compliance.compliant ? 'ok' : 'danger'}>{f.compliance.compliant ? 'compliant' : `${f.compliance.violations.length} issue(s)`}</Badge> : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
