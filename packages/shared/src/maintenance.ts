/**
 * Maintenance planning: when scheduled maintenance is due (by flight hours, flights or calendar
 * time since it was last done) and predictive maintenance from the trends of per-flight
 * health metrics (vibration, motor imbalance, voltage sag, battery consumption).
 */
import { predictThreshold, type ThresholdPrediction } from './predict';

export interface MaintenanceInterval {
  hours?: number | null;
  flights?: number | null;
  days?: number | null;
}

/** Usage of a drone at a point in time (totals since it entered service). */
export interface MaintenanceUsage {
  hours: number;
  flights: number;
  /** Epoch ms. */
  at: number;
}

export type MaintenanceStatus = 'ok' | 'due_soon' | 'overdue';

export interface MaintenanceDue {
  status: MaintenanceStatus;
  /** Largest share of any interval already used (1 = due now). */
  used: number;
  remainingHours: number | null;
  remainingFlights: number | null;
  remainingDays: number | null;
  /** Calendar due date (ISO) when a day interval applies. */
  dueDate: string | null;
  /** What makes it due first. */
  driver: 'hours' | 'flights' | 'days' | null;
}

const DAY = 86_400_000;

/** Due state of a maintenance task last done at `last`, with the drone's usage `now`. */
export function maintenanceDue(interval: MaintenanceInterval, last: MaintenanceUsage, now: MaintenanceUsage, soonFraction = 0.9): MaintenanceDue {
  const parts: { driver: 'hours' | 'flights' | 'days'; used: number }[] = [];
  let remainingHours: number | null = null;
  let remainingFlights: number | null = null;
  let remainingDays: number | null = null;
  let dueDate: string | null = null;
  if (interval.hours && interval.hours > 0) {
    const used = Math.max(0, now.hours - last.hours);
    remainingHours = Math.round((interval.hours - used) * 10) / 10;
    parts.push({ driver: 'hours', used: used / interval.hours });
  }
  if (interval.flights && interval.flights > 0) {
    const used = Math.max(0, now.flights - last.flights);
    remainingFlights = interval.flights - used;
    parts.push({ driver: 'flights', used: used / interval.flights });
  }
  if (interval.days && interval.days > 0) {
    const used = Math.max(0, (now.at - last.at) / DAY);
    remainingDays = Math.round((interval.days - used) * 10) / 10;
    dueDate = new Date(last.at + interval.days * DAY).toISOString();
    parts.push({ driver: 'days', used: used / interval.days });
  }
  if (!parts.length) return { status: 'ok', used: 0, remainingHours, remainingFlights, remainingDays, dueDate, driver: null };
  const top = parts.reduce((a, b) => (b.used > a.used ? b : a));
  const status: MaintenanceStatus = top.used >= 1 ? 'overdue' : top.used >= soonFraction ? 'due_soon' : 'ok';
  return { status, used: Math.round(top.used * 1000) / 1000, remainingHours, remainingFlights, remainingDays, dueDate, driver: top.driver };
}

export interface MaintenanceTemplate {
  name: string;
  interval: MaintenanceInterval;
  notes: string;
}

/** Default maintenance plan of a multirotor (manufacturer schedules vary – edit per drone). */
export const DEFAULT_MAINTENANCE_PLAN: MaintenanceTemplate[] = [
  { name: 'Pre-season inspection', interval: { days: 180 }, notes: 'Airframe, arms, landing gear, connectors, firmware and calibration.' },
  { name: 'Propeller replacement', interval: { hours: 50 }, notes: 'Replace all propellers; check for nicks and balance.' },
  { name: 'Motor inspection', interval: { hours: 100 }, notes: 'Bearings, windings, mounting screws; spin-test for noise.' },
  { name: 'Battery health check', interval: { flights: 50 }, notes: 'Cell balance, internal resistance and swelling of every pack.' },
];

// ---------------------------------------------------------------------------------------
// Predictive maintenance
// ---------------------------------------------------------------------------------------

export interface HealthIndicator {
  /** Flight-analysis metric (see apps/server/src/flights/analysis.ts). */
  metric: string;
  label: string;
  unit: string;
  threshold: number;
  direction: 'up' | 'down';
  /** What the trend means and what to do. */
  advice: string;
}

export const HEALTH_INDICATORS: HealthIndicator[] = [
  { metric: 'vibrationMean', label: 'Vibration', unit: 'm/s²', threshold: 30, direction: 'up', advice: 'Propeller or motor wear – balance or replace propellers, inspect motor bearings.' },
  { metric: 'motorImbalance', label: 'Motor imbalance', unit: '', threshold: 0.12, direction: 'up', advice: 'One motor works harder than the others – check that motor, its propeller and the ESC.' },
  { metric: 'voltageSagPerCell', label: 'Voltage sag per cell', unit: 'V', threshold: 0.45, direction: 'up', advice: 'Battery internal resistance is rising – retire or re-test the pack.' },
  { metric: 'batteryRatePctPerMin', label: 'Battery consumption', unit: '%/min', threshold: 6, direction: 'up', advice: 'Higher power draw for the same flying – check propellers, payload and battery capacity.' },
  { metric: 'healthScore', label: 'Flight health score', unit: '', threshold: 70, direction: 'down', advice: 'Overall health is declining – review the latest flight analyses.' },
];

export interface MetricPoint {
  /** Cumulative flight hours of the drone at that flight. */
  hours: number;
  value: number;
  at: string;
}

export interface HealthPrediction {
  indicator: HealthIndicator;
  points: number;
  current: number;
  /** Change per flight hour. */
  slopePerHour: number;
  r2: number;
  exceeded: boolean;
  /** Flight hours left until the threshold, when the trend heads there. */
  remainingHours: number | null;
  /** How the trend relates to the threshold (see `ThresholdPrediction.outlook`). */
  outlook: 'exceeded' | 'towards' | 'beyond' | 'unclear' | 'away';
  level: 'ok' | 'watch' | 'action';
}

/**
 * Predicts, per indicator, when the metric reaches its maintenance threshold from the drone's
 * recent flights (x = cumulative flight hours). "action" when exceeded or within 10 h,
 * "watch" within 50 h.
 */
export function predictHealth(series: Record<string, MetricPoint[]>, indicators: HealthIndicator[] = HEALTH_INDICATORS): HealthPrediction[] {
  const out: HealthPrediction[] = [];
  for (const ind of indicators) {
    const pts = (series[ind.metric] ?? []).filter((p) => Number.isFinite(p.value) && Number.isFinite(p.hours));
    const pred: ThresholdPrediction | null = predictThreshold(
      pts.map((p) => ({ x: p.hours, y: p.value })),
      ind.threshold,
      ind.direction,
    );
    if (!pred) continue;
    const remaining = pred.remaining === null ? null : Math.round(pred.remaining * 10) / 10;
    const level = pred.exceeded || (remaining !== null && remaining <= 10) ? 'action' : remaining !== null && remaining <= 50 ? 'watch' : 'ok';
    out.push({
      indicator: ind,
      points: pts.length,
      current: Math.round(pred.current * 1000) / 1000,
      slopePerHour: Math.round(pred.trend.slope * 10000) / 10000,
      r2: Math.round(pred.trend.r2 * 1000) / 1000,
      exceeded: pred.exceeded,
      remainingHours: remaining,
      outlook: pred.outlook,
      level,
    });
  }
  return out;
}
