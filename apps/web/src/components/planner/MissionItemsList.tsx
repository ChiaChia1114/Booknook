/**
 * Mission item list of the planner panel. Rows show a summary and a delete button; only the
 * selected row expands its fields (altitude, position, loiter end condition and radius,
 * speed, yaw, camera trigger). Altitudes can be shown relative to home or above sea level.
 */
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import type { MissionItem, MissionItemType, MissionPlan } from '@athena-sky/shared';

export type AltitudeReference = 'rel' | 'amsl';

const TYPES: MissionItemType[] = ['takeoff', 'waypoint', 'loiter', 'land', 'rtl', 'speed', 'photo', 'camera_trigger'];
const LABEL: Record<MissionItemType, string> = {
  takeoff: 'Takeoff',
  waypoint: 'Waypoint',
  loiter: 'Loiter',
  land: 'Land',
  rtl: 'Return home',
  speed: 'Speed',
  photo: 'Photo',
  camera_trigger: 'Camera trigger',
};
const NAV = new Set<MissionItemType>(['waypoint', 'loiter', 'land']);

function summary(it: MissionItem, plan: MissionPlan, altOf: (rel: number) => number, unit: string): string {
  const alt = it.alt ?? (it.type === 'takeoff' || it.type === 'waypoint' || it.type === 'loiter' ? plan.defaultAlt : undefined);
  const parts: string[] = [];
  if (alt !== undefined && it.type !== 'land') parts.push(`${Math.round(altOf(alt))} m ${unit}`);
  if (it.type === 'loiter') parts.push(it.unlimited ? 'unlimited' : it.turns ? `${it.turns} turns` : `${it.holdS ?? 0} s`);
  else if (it.holdS) parts.push(`hold ${it.holdS} s`);
  if (it.type === 'speed' || it.speed) parts.push(`${it.speed ?? plan.defaultSpeed} m/s`);
  if (it.type === 'camera_trigger') parts.push(it.triggerDistanceM ? `every ${it.triggerDistanceM} m` : 'stop');
  if (it.yawDeg !== undefined) parts.push(`yaw ${Math.round(it.yawDeg)}°`);
  return parts.join(' · ');
}

export function MissionItemsList({
  plan,
  selected,
  setSelected,
  editable,
  updateItem,
  moveItem,
  deleteItem,
  altRef,
  homeElevationM,
}: {
  plan: MissionPlan;
  selected: string | null;
  setSelected(id: string): void;
  editable: boolean;
  updateItem(id: string, patch: Partial<MissionItem>): void;
  moveItem(id: string, dir: -1 | 1): void;
  deleteItem(id: string): void;
  altRef: AltitudeReference;
  homeElevationM: number;
}) {
  const offset = altRef === 'amsl' ? homeElevationM : 0;
  const unit = altRef === 'amsl' ? 'AMSL' : 'rel';
  const altOf = (rel: number) => rel + offset;
  let navNo = 0;
  if (plan.items.length === 0) return <div className="small muted">Click on the map to add the first waypoint (a take-off item is added automatically).</div>;
  return (
    <div className="col" style={{ gap: 4 }} data-testid="mission-items">
      {plan.items.map((it, idx) => {
        const hasNav = NAV.has(it.type) && it.lat !== undefined;
        if (hasNav) navNo++;
        const open = selected === it.id;
        const num = (k: keyof MissionItem, label: string, aria: string, opts: { min?: number; transform?(v: number): number; display?(v: number): number } = {}) => {
          const raw = it[k] as number | undefined;
          return (
            <label>
              {label}
              <input
                type="number"
                aria-label={aria}
                value={raw === undefined ? '' : opts.display ? Math.round(opts.display(raw) * 100) / 100 : raw}
                disabled={!editable}
                onChange={(e) => {
                  if (e.target.value === '') return updateItem(it.id, { [k]: undefined } as Partial<MissionItem>);
                  const v = Number(e.target.value);
                  updateItem(it.id, { [k]: opts.transform ? opts.transform(v) : opts.min !== undefined ? Math.max(opts.min, v) : v } as Partial<MissionItem>);
                }}
              />
            </label>
          );
        };
        return (
          <div key={it.id} className={`item-row${open ? ' selected' : ''}`} onClick={() => setSelected(it.id)} data-testid={`item-${idx}`}>
            <span className="idx">{hasNav ? navNo : '·'}</span>
            <div className="item-main">
              {open && editable ? (
                <select value={it.type} onChange={(e) => updateItem(it.id, { type: e.target.value as MissionItemType })} aria-label={`Item ${idx + 1} type`} onClick={(e) => e.stopPropagation()}>
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {LABEL[t]}
                    </option>
                  ))}
                </select>
              ) : (
                <b>{LABEL[it.type]}</b>
              )}
              {!open && <span className="small muted truncate">{summary(it, plan, altOf, unit)}</span>}
            </div>
            {editable && (
              <div className="row" style={{ gap: 2 }}>
                {open && (
                  <>
                    <button className="btn small ghost" title="Move up" aria-label="Move up" onClick={(e) => { e.stopPropagation(); moveItem(it.id, -1); }}>
                      <ArrowUp />
                    </button>
                    <button className="btn small ghost" title="Move down" aria-label="Move down" onClick={(e) => { e.stopPropagation(); moveItem(it.id, 1); }}>
                      <ArrowDown />
                    </button>
                  </>
                )}
                <button className="btn small ghost danger-text" title="Delete" aria-label={`Delete item ${idx + 1}`} onClick={(e) => { e.stopPropagation(); deleteItem(it.id); }}>
                  <Trash2 />
                </button>
              </div>
            )}
            {open && (
              <div className="item-fields" onClick={(e) => e.stopPropagation()}>
                {(it.type === 'takeoff' || it.type === 'waypoint' || it.type === 'loiter') && (
                  <label>
                    Altitude (m {unit})
                    <input
                      type="number"
                      aria-label="Altitude"
                      value={it.alt === undefined ? '' : Math.round(altOf(it.alt) * 10) / 10}
                      disabled={!editable}
                      onChange={(e) => updateItem(it.id, { alt: e.target.value === '' ? undefined : Number(e.target.value) - offset })}
                    />
                  </label>
                )}
                {it.lat !== undefined && it.lon !== undefined && (
                  <>
                    {num('lat', 'Latitude', 'Latitude')}
                    {num('lon', 'Longitude', 'Longitude')}
                  </>
                )}
                {it.type === 'loiter' && (
                  <>
                    <label>
                      End condition
                      <select
                        aria-label="Loiter end condition"
                        value={it.unlimited ? 'unlimited' : it.turns ? 'turns' : 'time'}
                        disabled={!editable}
                        onChange={(e) => {
                          const v = e.target.value;
                          updateItem(it.id, v === 'unlimited' ? { unlimited: true, turns: undefined } : v === 'turns' ? { unlimited: undefined, turns: it.turns || 1, holdS: undefined } : { unlimited: undefined, turns: undefined, holdS: it.holdS ?? 30 });
                        }}
                      >
                        <option value="time">Time</option>
                        <option value="turns">Turns</option>
                        <option value="unlimited">Unlimited (until resumed)</option>
                      </select>
                    </label>
                    {!it.unlimited && !it.turns && num('holdS', 'Time (s)', 'Hold', { min: 0 })}
                    {!it.unlimited && !!it.turns && num('turns', 'Turns', 'Turns', { min: 0 })}
                    {num('radiusM', 'Radius (m)', 'Loiter radius', { min: 0 })}
                  </>
                )}
                {it.type === 'waypoint' && num('holdS', 'Hold (s)', 'Hold', { min: 0 })}
                {(it.type === 'waypoint' || it.type === 'speed') && num('speed', 'Speed (m/s)', 'Speed', { min: 0.5 })}
                {it.type === 'waypoint' && num('yawDeg', 'Yaw (°)', 'Yaw', { transform: (v) => ((v % 360) + 360) % 360 })}
                {it.type === 'camera_trigger' && num('triggerDistanceM', 'Photo every (m)', 'Trigger distance', { min: 0 })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
