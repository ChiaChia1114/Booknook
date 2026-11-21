/**
 * AI route optimisation in the mission planner: energy/wind-aware waypoint ordering,
 * no-fly-zone avoidance and terrain following. Results are previewed as a report and
 * applied to the plan (undoable) – nothing is saved until the mission is saved.
 */
import { Check, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { MissionPlan, OptimizeReport } from '@athena-sky/shared';
import { api, errorMessage } from '../../api/client';
import { Badge, fmtDistance, fmtDuration } from '../ui';
import { conditionsBody, type SimulationConditions } from './SimulatePanel';

interface Summary {
  durationS: number;
  energyWh: number;
  endSocPct: number;
  minAglM: number | null;
  feasible: boolean;
  errors: string[];
}

interface OptimizeResponse {
  plan: MissionPlan;
  report: OptimizeReport;
  terrain: { changes: { itemId: string; fromAlt: number; toAlt: number }[]; inserted: number; maxRequiredAlt: number; violations: string[] } | null;
  terrainAvailable: boolean;
  before: Summary;
  after: Summary;
  notes: string[];
}

export function OptimizePanel({ base, plan, conditions, onApply, onUndo, canUndo }: { base: string; plan: MissionPlan; conditions: SimulationConditions; onApply(p: MissionPlan): void; onUndo(): void; canUndo: boolean }) {
  const [opts, setOpts] = useState({ reorder: false, avoidZones: true, terrainFollow: true, bufferM: 30, minClearanceM: 30 });
  const [res, setRes] = useState<OptimizeResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setRes(await api<OptimizeResponse>(`${base}/optimize`, { body: { plan, ...opts, ...conditionsBody(conditions) } }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const changed = res && (res.report.reordered || res.report.detours.length > 0 || (res.terrain && (res.terrain.inserted > 0 || res.terrain.changes.length > 0)));
  return (
    <div className="card tight" data-testid="optimize-panel">
      <h3>AI route optimisation</h3>
      <p className="small muted">Uses the airframe and conditions of the simulation below.</p>
      <label className="row small">
        <input type="checkbox" checked={opts.reorder} onChange={(e) => setOpts({ ...opts, reorder: e.target.checked })} /> Reorder waypoints (shortest energy tour)
      </label>
      <label className="row small">
        <input type="checkbox" checked={opts.avoidZones} onChange={(e) => setOpts({ ...opts, avoidZones: e.target.checked })} /> Avoid no-fly zones and ground hazards
      </label>
      <label className="row small">
        <input type="checkbox" checked={opts.terrainFollow} onChange={(e) => setOpts({ ...opts, terrainFollow: e.target.checked })} /> Terrain following
      </label>
      <div className="form-grid">
        <label className="field">
          Zone margin (m)
          <input type="number" value={opts.bufferM} onChange={(e) => setOpts({ ...opts, bufferM: Number(e.target.value) })} aria-label="Zone margin (m)" />
        </label>
        <label className="field">
          Terrain clearance (m)
          <input type="number" value={opts.minClearanceM} onChange={(e) => setOpts({ ...opts, minClearanceM: Number(e.target.value) })} aria-label="Terrain clearance (m)" />
        </label>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn small primary" onClick={run} disabled={busy}>
          {busy ? 'Optimising…' : 'Optimise route'}
        </button>
        {canUndo && (
          <button className="btn small" onClick={onUndo}>
            Undo optimisation
          </button>
        )}
      </div>
      {error && <div className="small" style={{ color: 'var(--danger)' }}>{error}</div>}
      {res && (
        <div className="col small" style={{ gap: 6, marginTop: 10 }} data-testid="optimize-report">
          <div>
            Distance {fmtDistance(res.report.distanceBeforeM)} → <b>{fmtDistance(res.report.distanceAfterM)}</b> · energy {res.before.energyWh} → <b>{res.after.energyWh} Wh</b> · time {fmtDuration(res.before.durationS)} → {fmtDuration(res.after.durationS)}
          </div>
          {res.report.reordered && (
            <div className="check-line">
              <Check /> Waypoints reordered.
            </div>
          )}
          {res.report.detours.map((d) => (
            <div key={d.legIndex} className="check-line">
              <Check /> Leg {d.legIndex + 1} re-routed around {d.around.join(', ')} (+{d.addedPoints} waypoint{d.addedPoints === 1 ? '' : 's'}, +{d.extraDistanceM} m)
            </div>
          ))}
          {res.terrain && (res.terrain.changes.length > 0 || res.terrain.inserted > 0) && (
            <div className="check-line">
              <Check /> Terrain following: {res.terrain.changes.length} altitude change(s), {res.terrain.inserted} waypoint(s) added above terrain peaks (highest requirement {res.terrain.maxRequiredAlt} m).
            </div>
          )}
          {!res.terrainAvailable && opts.terrainFollow && <div className="muted">Terrain data is unavailable on this server: no terrain following.</div>}
          {[...res.report.unresolved, ...(res.terrain?.violations ?? [])].map((u) => (
            <div key={u} className="check-line warn">
              <TriangleAlert /> {u}
            </div>
          ))}
          <div className="row" style={{ gap: 6 }}>
            {res.before.feasible ? <Badge tone="ok">before: feasible</Badge> : <Badge tone="danger">before: {res.before.errors[0]?.slice(0, 50) ?? 'not feasible'}</Badge>}
            {res.after.feasible ? <Badge tone="ok">after: feasible</Badge> : <Badge tone="danger">after: {res.after.errors[0]?.slice(0, 50) ?? 'not feasible'}</Badge>}
          </div>
          {changed ? (
            <button
              className="btn small primary"
              onClick={() => {
                onApply(res.plan);
                setRes(null);
              }}
            >
              Apply to plan
            </button>
          ) : (
            <div className="muted">The route is already optimal for these options.</div>
          )}
        </div>
      )}
    </div>
  );
}
