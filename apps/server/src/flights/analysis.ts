/**
 * Post-flight analytics ("post-flight AI analytics" in Sky-Drones terms).
 *
 * Two layers:
 *  1. Rule-based diagnostics on the flight itself (vibration, motor balance,
 *     battery sag, GNSS quality, attitude oscillation, hard landing, link loss…).
 *  2. Statistical anomaly detection against the drone's own history (z-scores of
 *     energy use, current, vibration and motor imbalance) to surface mechanical
 *     degradation before it becomes a failure.
 */
import type { AnalysisFinding, FlightEventDto, FlightSampleDto, FindingSeverity } from '@athena-sky/shared';

export interface AnalysisInput {
  samples: FlightSampleDto[];
  events: FlightEventDto[];
  /** Metrics of previous analysed flights of the same drone (most recent first). */
  history: Record<string, number>[];
}

export interface AnalysisResult {
  score: number;
  findings: AnalysisFinding[];
  metrics: Record<string, number>;
}

const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const std = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};
const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Metrics compared against the drone's history (higher = worse). */
export const BASELINE_METRICS: { key: string; label: string }[] = [
  { key: 'batteryRatePctPerMin', label: 'battery consumption' },
  { key: 'meanCurrentA', label: 'average current draw' },
  { key: 'vibrationMean', label: 'vibration level' },
  { key: 'motorImbalance', label: 'motor output imbalance' },
];

export function analyzeFlight(input: AnalysisInput): AnalysisResult {
  const all = [...input.samples].sort((a, b) => a.t - b.t);
  const findings: AnalysisFinding[] = [];
  const metrics: Record<string, number> = {};
  const add = (severity: FindingSeverity, code: string, title: string, detail: string, metric?: number, t?: number) =>
    findings.push({ code, severity, title, detail, ...(metric !== undefined ? { metric: r2(metric) } : {}), ...(t !== undefined ? { t } : {}) });

  if (all.length < 2) {
    return { score: 100, findings: [{ code: 'insufficient_data', severity: 'info', title: 'Not enough data', detail: 'The flight has fewer than two samples; no diagnostics were run.' }], metrics };
  }
  const air = all.filter((s) => s.armed && s.altRel > 0.5);
  const flying = air.length >= 2 ? air : all;
  const durationS = (all[all.length - 1]!.t - all[0]!.t) / 1000;
  metrics.durationS = r2(durationS);
  metrics.samples = all.length;

  // --- Battery ---------------------------------------------------------------------------
  const bat = all.filter((s) => s.batteryPct > 0);
  if (bat.length >= 2 && durationS >= 30) {
    const used = bat[0]!.batteryPct - bat[bat.length - 1]!.batteryPct;
    metrics.batteryUsedPct = r2(used);
    metrics.batteryRatePctPerMin = r2(used / (durationS / 60));
    const end = bat[bat.length - 1]!.batteryPct;
    metrics.batteryEndPct = r2(end);
    if (end < 5) add('critical', 'battery_depleted', 'Battery nearly depleted', `Flight ended with ${end.toFixed(0)} % battery remaining.`, end);
    else if (end < 15) add('warning', 'battery_low', 'Low battery at landing', `Flight ended with ${end.toFixed(0)} % battery remaining (reserve below 15 %).`, end);
  }
  const volts = flying.map((s) => s.voltage).filter((v) => v > 0);
  if (volts.length >= 5) {
    const early = median(volts.slice(0, Math.max(3, Math.floor(volts.length * 0.1))));
    const min = Math.min(...volts);
    metrics.minVoltage = r2(min);
    // Sag relative to the early-flight voltage, normalised to the pack (≈ 4.2 V/cell full).
    const cells = Math.max(1, Math.round(early / 3.9));
    const sagPerCell = (early - min) / cells;
    metrics.voltageSagPerCell = r2(sagPerCell);
    if (min / cells < 3.3) add('critical', 'voltage_critical', 'Critical cell voltage', `Pack voltage fell to ${min.toFixed(2)} V (≈${(min / cells).toFixed(2)} V/cell).`, min);
    else if (sagPerCell > 0.6) add('warning', 'voltage_sag', 'High voltage sag', `Voltage dropped ${sagPerCell.toFixed(2)} V/cell during flight – battery may be ageing or under-sized.`, sagPerCell);
  }
  const currents = flying.map((s) => s.current).filter((c) => c > 0);
  if (currents.length >= 5) {
    metrics.meanCurrentA = r2(mean(currents));
    metrics.maxCurrentA = r2(Math.max(...currents));
  }

  // --- Vibration ---------------------------------------------------------------------------
  const vib = flying.map((s) => s.vibration).filter((v): v is number => typeof v === 'number' && v >= 0);
  if (vib.length >= 5) {
    metrics.vibrationMean = r2(mean(vib));
    metrics.vibrationMax = r2(Math.max(...vib));
    if (metrics.vibrationMean > 60) add('critical', 'vibration_critical', 'Excessive vibration', `Mean vibration ${metrics.vibrationMean} m/s² – inspect propellers, motors and mounts before the next flight.`, metrics.vibrationMean);
    else if (metrics.vibrationMean > 30) add('warning', 'vibration_high', 'High vibration', `Mean vibration ${metrics.vibrationMean} m/s² (recommended < 30). Check propeller balance.`, metrics.vibrationMean);
  }

  // --- Motors ----------------------------------------------------------------------------
  const motorSamples = flying.filter((s) => Array.isArray(s.motors) && s.motors.length >= 2);
  if (motorSamples.length >= 5) {
    const n = Math.min(...motorSamples.map((s) => s.motors!.length));
    const means = Array.from({ length: n }, (_, i) => mean(motorSamples.map((s) => s.motors![i]!)));
    const avg = mean(means);
    const imbalance = avg > 0 ? (Math.max(...means) - Math.min(...means)) / avg : 0;
    metrics.motorImbalance = r2(imbalance);
    metrics.motorMaxOutput = r2(Math.max(...motorSamples.flatMap((s) => s.motors!.slice(0, n))));
    const worst = means.indexOf(Math.max(...means)) + 1;
    if (imbalance > 0.25) add('critical', 'motor_imbalance', 'Severe motor imbalance', `Motor ${worst} works ${(imbalance * 100).toFixed(0)} % harder than the weakest – possible failing motor, damaged propeller or CG offset.`, imbalance);
    else if (imbalance > 0.12) add('warning', 'motor_imbalance', 'Motor imbalance', `Motor ${worst} works ${(imbalance * 100).toFixed(0)} % harder than the weakest motor.`, imbalance);
    if (metrics.motorMaxOutput > 0.95) add('warning', 'motor_saturation', 'Motor saturation', 'At least one motor reached > 95 % output – the vehicle has little control margin.', metrics.motorMaxOutput);
  }

  // --- GNSS ------------------------------------------------------------------------------
  const sats = flying.map((s) => s.satellites).filter((v) => v > 0);
  if (sats.length) {
    metrics.minSatellites = Math.min(...sats);
    if (metrics.minSatellites < 6) add('warning', 'gnss_weak', 'Weak GNSS reception', `Satellite count dropped to ${metrics.minSatellites} while airborne.`, metrics.minSatellites);
  }
  const hdops = flying.map((s) => s.hdop).filter((v) => v > 0);
  if (hdops.length) {
    metrics.maxHdop = r2(Math.max(...hdops));
    if (metrics.maxHdop > 2.5) add('warning', 'gnss_hdop', 'Poor GNSS geometry', `HDOP reached ${metrics.maxHdop}.`, metrics.maxHdop);
  }

  // --- Attitude ---------------------------------------------------------------------------
  if (flying.length >= 10) {
    const hp = (vals: number[]) =>
      vals.map((v, i) => {
        const w = vals.slice(Math.max(0, i - 2), i + 3);
        return v - mean(w);
      });
    const osc = Math.sqrt(mean([...hp(flying.map((s) => s.roll)), ...hp(flying.map((s) => s.pitch))].map((v) => v * v)));
    metrics.attitudeOscillationDeg = r2(osc);
    const maxTilt = Math.max(...flying.map((s) => Math.hypot(s.roll, s.pitch)));
    metrics.maxTiltDeg = r2(maxTilt);
    if (osc > 6) add('warning', 'attitude_oscillation', 'Attitude oscillation', `Roll/pitch oscillation RMS ${osc.toFixed(1)}° – PID tuning or mechanical play suspected.`, osc);
    if (maxTilt > 45) add('warning', 'high_tilt', 'Aggressive attitude', `Tilt reached ${maxTilt.toFixed(0)}°.`, maxTilt);
  }

  // --- Landing ----------------------------------------------------------------------------
  const lastAir = [...all].reverse().find((s) => s.altRel > 0.3 && s.altRel < 3);
  if (lastAir && air.length > 0) {
    const finalDescent = all.filter((s) => s.t >= lastAir.t - 3000 && s.t <= lastAir.t + 2000).map((s) => s.climbRate);
    const touchdown = Math.min(...finalDescent);
    metrics.touchdownSpeedMs = r2(-touchdown);
    if (touchdown < -3) add('critical', 'hard_landing', 'Hard landing', `Vertical speed at touchdown was ${(-touchdown).toFixed(1)} m/s – inspect landing gear and frame.`, -touchdown, lastAir.t);
    else if (touchdown < -1.5) add('warning', 'firm_landing', 'Firm landing', `Vertical speed at touchdown was ${(-touchdown).toFixed(1)} m/s.`, -touchdown, lastAir.t);
  }

  // --- Events ------------------------------------------------------------------------------
  const linkLoss = input.events.filter((e) => e.code === 'link_lost').length;
  metrics.linkLosses = linkLoss;
  if (linkLoss > 0) add('warning', 'link_loss', 'Telemetry link interruptions', `${linkLoss} link interruption(s) recorded.`, linkLoss);
  const critical = input.events.filter((e) => e.level === 'critical' || e.level === 'error');
  metrics.criticalEvents = critical.length;
  if (critical.length > 0) add('warning', 'autopilot_errors', 'Autopilot errors reported', critical.slice(0, 3).map((e) => e.message).join(' · '), critical.length);
  const failsafes = input.events.filter((e) => /failsafe/i.test(e.message) || e.code === 'failsafe');
  if (failsafes.length > 0) add('warning', 'failsafe', 'Failsafe triggered', failsafes.map((e) => e.message).slice(0, 3).join(' · '), failsafes.length);

  // --- Anomaly detection against the drone's own history ----------------------------------
  for (const { key, label } of BASELINE_METRICS) {
    const value = metrics[key];
    if (value === undefined) continue;
    const hist = input.history.map((h) => h[key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).slice(0, 20);
    if (hist.length < 5) continue;
    const m = mean(hist);
    const sd = Math.max(std(hist), Math.abs(m) * 0.05, 1e-6);
    const z = (value - m) / sd;
    metrics[`${key}Z`] = r2(z);
    if (z > 4) add('critical', `anomaly_${key}`, `Abnormal ${label}`, `${label[0]!.toUpperCase()}${label.slice(1)} is ${z.toFixed(1)}σ above this drone's history (${value} vs ${r2(m)}) – likely mechanical degradation.`, z);
    else if (z > 2.5) add('warning', `anomaly_${key}`, `Unusual ${label}`, `${label[0]!.toUpperCase()}${label.slice(1)} is ${z.toFixed(1)}σ above this drone's history (${value} vs ${r2(m)}).`, z);
  }

  const penalty = findings.reduce((p, f) => p + (f.severity === 'critical' ? 25 : f.severity === 'warning' ? 8 : 0), 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));
  if (findings.length === 0) add('info', 'nominal', 'Nominal flight', 'No anomalies detected.');
  const order = { critical: 0, warning: 1, info: 2 } as const;
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { score, findings, metrics };
}
