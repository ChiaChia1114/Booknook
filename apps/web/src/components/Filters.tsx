import type { DroneDto, FleetDto } from '@athena-sky/shared';
import { calendarBounds, useApi } from '../hooks';
import { useOrgId } from '../state/auth';

export function DateRangeFilter({ r }: { r: ReturnType<typeof import('../hooks').useDateRange> }) {
  // The calendars offer only periods the page accepts (From up to To, at most `maxDays` days,
  // 1970–2100); dates typed outside them (or a field left empty) are shown but not applied, and
  // the filter says so.
  const bounds = r.applied ? calendarBounds(r.from, r.to, r.applied, r.maxDays) : null;
  return (
    <div className="row wrap">
      <select aria-label="Period" value={String(r.days)} onChange={(e) => r.setDays(e.target.value === 'custom' ? 'custom' : Number(e.target.value))}>
        <option value="7">Last 7 days</option>
        <option value="30">Last 30 days</option>
        <option value="90">Last 90 days</option>
        <option value="365">Last 12 months</option>
        <option value="custom">Custom…</option>
      </select>
      {r.days === 'custom' && (
        <>
          <input
            type="date"
            aria-label="From"
            value={r.from}
            min={bounds?.from.min}
            max={bounds?.from.max}
            onChange={(e) => r.setFrom(e.target.value)}
          />
          <span className="muted">→</span>
          <input
            type="date"
            aria-label="To"
            value={r.to}
            min={bounds?.to.min}
            max={bounds?.to.max}
            onChange={(e) => r.setTo(e.target.value)}
          />
          {r.problem && r.applied && (
            <span className="small" role="alert" style={{ color: 'var(--danger)' }} data-testid="period-problem">
              Not applied: {r.problem} – still showing {r.applied.from} → {r.applied.to}
            </span>
          )}
        </>
      )}
    </div>
  );
}

export function FleetSelect({ value, onChange, allLabel = 'All fleets' }: { value: string; onChange(v: string): void; allLabel?: string }) {
  const orgId = useOrgId();
  const fleets = useApi<FleetDto[]>(`/api/v2/organisations/${orgId}/fleets`);
  // Without the list, the choice made stays – it cannot be changed – and the page says why.
  const failed = !fleets.data && !!fleets.error;
  return (
    <>
      <select aria-label="Fleet" value={value} onChange={(e) => onChange(e.target.value)} disabled={failed}>
        <option value="">{allLabel}</option>
        {!fleets.data && value && <option value={value}>Selected fleet</option>}
        {(fleets.data ?? []).map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      {failed && <FilterError what="fleets" error={fleets.error!} />}
    </>
  );
}

/** Drones of the organisation (of one fleet when `fleetId` is set). */
export function DroneSelect({ value, onChange, fleetId = '', allLabel = 'All drones' }: { value: string; onChange(v: string): void; fleetId?: string; allLabel?: string }) {
  const orgId = useOrgId();
  const drones = useApi<DroneDto[]>(`/api/v2/organisations/${orgId}/drones`);
  const list = (drones.data ?? []).filter((d) => !fleetId || d.fleetId === fleetId);
  const failed = !drones.data && !!drones.error;
  return (
    <>
      <select aria-label="Drone" value={value} onChange={(e) => onChange(e.target.value)} disabled={failed}>
        <option value="">{allLabel}</option>
        {!drones.data && value && <option value={value}>Selected drone</option>}
        {list.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
      {failed && <FilterError what="drones" error={drones.error!} />}
    </>
  );
}

/** A filter whose choices could not be loaded: said next to it (the filter keeps its choice). */
export function FilterError({ what, error }: { what: string; error: string }) {
  return (
    <span className="small" role="alert" style={{ color: 'var(--danger-text)' }} title={`The ${what} could not be loaded: ${error}`}>
      The {what} could not be loaded: {error}
    </span>
  );
}
