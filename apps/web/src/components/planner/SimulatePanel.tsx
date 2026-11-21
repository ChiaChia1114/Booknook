/**
 * Pre-flight simulation in the mission planner ("true-to-life models"): airframe, payload,
 * wind (manual or forecast), temperature → predicted time, energy, battery, power and
 * terrain clearance, feasibility issues, airframe benchmark and 3D playback.
 */
import { useState } from 'react';
import { AIRFRAMES, type AirframeComparisonRow, type MissionPlan, type SimulationResult, type SimulationSample } from '@athena-sky/shared';
import { api, errorMessage } from '../../api/client';
import { TimeChart } from '../charts';
import { Badge, fmtDistance, fmtDuration } from '../ui';

interface SimulateResponse {
  result: SimulationResult;
  comparison?: AirframeComparisonRow[];
  conditions: { windSource: 'manual' | 'forecast' | 'none'; wind: { speedMs: number; fromDeg: number; gustMs?: number | null } | null; temperatureC: number | null; homeElevationM: number; terrain: 'dem' | 'none'; notes: string[] };
}

export interface SimulationConditions {
  airframeId: string;
  payloadKg: number;
  windMode: 'none' | 'manual' | 'forecast';
  windSpeed: number;
  windFrom: number;
  temperature: string;
}

export function conditionsBody(c: SimulationConditions) {
  return {
    airframeId: c.airframeId,
    payloadKg: c.payloadKg,
    wind: c.windMode === 'manual' ? { speedMs: c.windSpeed, fromDeg: c.windFrom } : null,
    useForecast: c.windMode === 'forecast',
    temperatureC: c.temperature === '' ? null : Number(c.temperature),
  };
}

export function ConditionsForm({ c, set }: { c: SimulationConditions; set(c: SimulationConditions): void }) {
  return (
    <div className="form-grid">
      <label className="field" style={{ gridColumn: 'span 2' }}>
        Airframe
        <select value={c.airframeId} onChange={(e) => set({ ...c, airframeId: e.target.value })} aria-label="Airframe">
          {AIRFRAMES.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Payload (kg)
        <input type="number" step={0.1} min={0} value={c.payloadKg} onChange={(e) => set({ ...c, payloadKg: Number(e.target.value) })} aria-label="Payload (kg)" />
      </label>
      <label className="field">
        Wind
        <select value={c.windMode} onChange={(e) => set({ ...c, windMode: e.target.value as SimulationConditions['windMode'] })} aria-label="Wind">
          <option value="none">Calm</option>
          <option value="manual">Manual</option>
          <option value="forecast">Forecast at home</option>
        </select>
      </label>
      {c.windMode === 'manual' && (
        <>
          <label className="field">
            Wind speed (m/s)
            <input type="number" step={0.5} min={0} value={c.windSpeed} onChange={(e) => set({ ...c, windSpeed: Number(e.target.value) })} aria-label="Wind speed (m/s)" />
          </label>
          <label className="field">
            Wind from (°)
            <input type="number" min={0} max={360} value={c.windFrom} onChange={(e) => set({ ...c, windFrom: Number(e.target.value) })} aria-label="Wind from (°)" />
          </label>
        </>
      )}
      <label className="field">
        Temperature (°C)
        <input type="number" value={c.temperature} placeholder="ISA" onChange={(e) => set({ ...c, temperature: e.target.value })} aria-label="Temperature (°C)" />
      </label>
    </div>
  );
}

export function SimulatePanel({ base, plan, conditions, setConditions, onPlay }: { base: string; plan: MissionPlan; conditions: SimulationConditions; setConditions(c: SimulationConditions): void; onPlay(samples: SimulationSample[]): void }) {
  const [compare, setCompare] = useState(false);
  const [reserve, setReserve] = useState(20);
  const [res, setRes] = useState<SimulateResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setRes(await api<SimulateResponse>(`${base}/simulate`, { body: { plan, ...conditionsBody(conditions), reservePct: reserve, compare } }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const r = res?.result;
  const t0 = r?.samples[0]?.t ?? 0;
  return (
    <div className="card tight" data-testid="simulate-panel">
      <h3>Pre-flight simulation</h3>
      <p className="small muted">Flight-physics model of the airframe with payload, wind, temperature (air density) and terrain.</p>
      <ConditionsForm c={conditions} set={setConditions} />
      <div className="row small" style={{ gap: 12, marginTop: 6 }}>
        <label className="row">
          Reserve
          <input type="number" style={{ width: 60 }} value={reserve} onChange={(e) => setReserve(Number(e.target.value))} aria-label="Reserve (%)" /> %
        </label>
        <label className="row">
          <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> Compare airframes
        </label>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn small primary" onClick={run} disabled={busy}>
          {busy ? 'Simulating…' : 'Run simulation'}
        </button>
        {r && (
          <button className="btn small" onClick={() => onPlay(r.samples)} data-testid="sim-play">
            ▶ Play in 3D
          </button>
        )}
      </div>
      {error && <div className="small" style={{ color: 'var(--danger)' }}>{error}</div>}
      {r && res && (
        <div className="col" style={{ gap: 8, marginTop: 10 }} data-testid="sim-result">
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {r.feasible ? <Badge tone="ok">feasible</Badge> : <Badge tone="danger">not feasible</Badge>}
            <span className="small">
              {fmtDuration(r.durationS)} · {fmtDistance(r.distanceM)} · <b>{r.energyWh} Wh</b> · battery {r.endSocPct} % at landing · peak {r.maxPowerW} W
            </span>
          </div>
          <div className="small muted">
            {r.airframeName}, {r.massKg.toFixed(1)} kg · air density {r.airDensity} kg/m³ (density altitude {r.densityAltitudeM} m) · wind{' '}
            {res.conditions.wind ? `${res.conditions.wind.speedMs.toFixed(1)} m/s from ${Math.round(res.conditions.wind.fromDeg)}° (${res.conditions.windSource})` : 'calm'} · terrain {res.conditions.terrain === 'dem' ? `DEM, min. clearance ${r.minAglM ?? '—'} m` : 'unavailable'}
          </div>
          {res.conditions.notes.map((n) => (
            <div key={n} className="small muted">
              {n}
            </div>
          ))}
          {r.issues.map((i) => (
            <div key={i.code + i.message} className={`finding ${i.severity === 'error' ? 'critical' : i.severity === 'warning' ? 'warning' : 'info'}`}>
              <b>{i.code.replace(/_/g, ' ')}</b>
              <div className="small">{i.message}</div>
            </div>
          ))}
          <TimeChart
            height={180}
            relative
            x={r.samples.map((s) => s.t - t0)}
            series={[
              { label: 'Altitude (m)', values: r.samples.map((s) => s.altRel), color: '#38bdf8' },
              { label: 'Battery (%)', values: r.samples.map((s) => s.socPct), color: '#22c55e', scale: 'pct' },
              { label: 'Power (W)', values: r.samples.map((s) => s.powerW), color: '#f97316', scale: 'w' },
            ]}
          />
          {res.comparison && (
            <table className="table small" data-testid="sim-compare">
              <thead>
                <tr>
                  <th>Airframe</th>
                  <th>Time</th>
                  <th>Energy</th>
                  <th>Battery left</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {res.comparison.map((c) => (
                  <tr key={c.airframeId}>
                    <td>{c.airframeName}</td>
                    <td>{fmtDuration(c.durationS)}</td>
                    <td>{c.energyWh} Wh</td>
                    <td>{c.endSocPct} %</td>
                    <td>{c.feasible ? <Badge tone="ok">ok</Badge> : <Badge tone="danger" >{c.errors[0]?.slice(0, 40) ?? 'not feasible'}</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
