import { useState } from 'react';
import { Activity, Award, Plane, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { DronesOperatorsDto } from '@athena-sky/shared';
import { formatHours } from '@athena-sky/shared';
import { useApi, useDateRange } from '../hooks';
import { useOrgId } from '../state/auth';
import { DateRangeFilter, FleetSelect } from '../components/Filters';
import { Badge, Card, ErrorBox, Loading, PageHead, fmtDate, fmtDistance, fmtDuration, scoreTone, useSort } from '../components/ui';

function Highlight({ icon: Icon, tone, label, value, sub, testId }: { icon: LucideIcon; tone?: 'ok' | 'violet'; label: string; value: string | undefined; sub: string | null | undefined; testId: string }) {
  return (
    <section className="card highlight">
      <span className={`kpi-icon${tone ? ` ${tone}` : ''}`} aria-hidden="true">
        <Icon />
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="small muted">{label}</div>
        {value ? (
          <>
            <div className="hl-value truncate" data-testid={testId}>
              {value}
            </div>
            <div className="small faint">{sub}</div>
          </>
        ) : (
          <div className="hl-value faint">No flights yet</div>
        )}
      </div>
    </section>
  );
}

export function AnalyticsPage() {
  const orgId = useOrgId();
  const r = useDateRange(365);
  const [fleetId, setFleetId] = useState('');
  const res = useApi<DronesOperatorsDto>(
    `/api/v2/organisations/${orgId}/analytics/drones-operators?from=${encodeURIComponent(r.range.from)}&to=${encodeURIComponent(r.range.to)}${fleetId ? `&fleetId=${fleetId}` : ''}`,
  );
  const d = res.data;
  const drones = useSort(d?.drones ?? [], 'flightTimeS');
  const ops = useSort(d?.operators ?? [], 'flightTimeS');
  return (
    <div className="content">
      <PageHead
        title="Drones & Operators"
        subtitle="Which drone is used the most? Who is your most experienced pilot? Analytics for your fleet and team."
        actions={
          <>
            <DateRangeFilter r={r} />
            <FleetSelect value={fleetId} onChange={setFleetId} />
          </>
        }
      />
      <ErrorBox error={res.error} />
      {!d ? (
        <Loading />
      ) : (
        <div className="stack">
          <div className="grid three">
            <Highlight icon={Plane} label="Most used drone" testId="most-used-drone" value={d.highlights.mostUsedDrone?.name} sub={d.highlights.mostUsedDrone && `${d.highlights.mostUsedDrone.flights} flights · ${formatHours(d.highlights.mostUsedDrone.flightTimeS)} · ${fmtDistance(d.highlights.mostUsedDrone.distanceM)}`} />
            <Highlight icon={Award} tone="violet" label="Most experienced pilot (flight hours)" testId="most-experienced-pilot" value={d.highlights.mostExperiencedPilot?.name} sub={d.highlights.mostExperiencedPilot && `${formatHours(d.highlights.mostExperiencedPilot.flightTimeS)} in ${d.highlights.mostExperiencedPilot.flights} flights`} />
            <Highlight icon={Activity} tone="ok" label="Most active pilot (flights)" testId="most-active-pilot" value={d.highlights.mostActivePilot?.name} sub={d.highlights.mostActivePilot && `${d.highlights.mostActivePilot.flights} flights on ${d.highlights.mostActivePilot.dronesFlown} drone(s)`} />
          </div>
          <Card title="Drones">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    {drones.th('name', 'Drone')}
                    {drones.th('fleetName', 'Fleet')}
                    {drones.th('flights', 'Flights', true)}
                    {drones.th('flightTimeS', 'Flight time', true)}
                    {drones.th('distanceM', 'Distance', true)}
                    {drones.th('avgDurationS', 'Avg flight', true)}
                    {drones.th('pilots', 'Pilots', true)}
                    {drones.th('avgHealthScore', 'Health', true)}
                    {drones.th('lastFlightAt', 'Last flight')}
                  </tr>
                </thead>
                <tbody>
                  {drones.sorted.map((x) => (
                    <tr key={x.droneId}>
                      <td>
                        <Link to={`/fleet/${x.droneId}`}>{x.name}</Link>
                      </td>
                      <td>{x.fleetName ?? '—'}</td>
                      <td className="num">{x.flights}</td>
                      <td className="num">{formatHours(x.flightTimeS)}</td>
                      <td className="num">{fmtDistance(x.distanceM)}</td>
                      <td className="num">{fmtDuration(x.avgDurationS)}</td>
                      <td className="num">{x.pilots}</td>
                      <td className="num">{x.avgHealthScore === null ? '—' : <Badge tone={scoreTone(x.avgHealthScore)}>{x.avgHealthScore}</Badge>}</td>
                      <td>{fmtDate(x.lastFlightAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card title="Pilots & operators">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    {ops.th('name', 'Pilot')}
                    {ops.th('flights', 'Flights', true)}
                    {ops.th('flightTimeS', 'Flight hours', true)}
                    {ops.th('distanceM', 'Distance', true)}
                    {ops.th('dronesFlown', 'Drones flown', true)}
                    {ops.th('longestFlightS', 'Longest flight', true)}
                    {ops.th('lastFlightAt', 'Last flight')}
                  </tr>
                </thead>
                <tbody>
                  {ops.sorted.map((x) => (
                    <tr key={x.userId}>
                      <td>
                        {x.name}
                        <div className="small muted">{x.email}</div>
                      </td>
                      <td className="num">{x.flights}</td>
                      <td className="num">{formatHours(x.flightTimeS)}</td>
                      <td className="num">{fmtDistance(x.distanceM)}</td>
                      <td className="num">{x.dronesFlown}</td>
                      <td className="num">{fmtDuration(x.longestFlightS)}</td>
                      <td>{fmtDate(x.lastFlightAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
