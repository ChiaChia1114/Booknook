import { describe, expect, it } from 'vitest';
import { HEALTH_INDICATORS, maintenanceDue, predictHealth, type MetricPoint } from '../src';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

describe('scheduled maintenance', () => {
  it('reports the interval used first and its remaining amount', () => {
    const last = { hours: 100, flights: 300, at: T0 };
    // 40 of 50 h used (80 %), 10 of 50 flights, 30 of 180 days → ok, driven by hours.
    const a = maintenanceDue({ hours: 50, flights: 50, days: 180 }, last, { hours: 140, flights: 310, at: T0 + 30 * DAY });
    expect(a).toMatchObject({ status: 'ok', driver: 'hours', remainingHours: 10, remainingFlights: 40, remainingDays: 150 });
    expect(a.used).toBeCloseTo(0.8, 6);
    expect(a.dueDate).toBe(new Date(T0 + 180 * DAY).toISOString());
    // 46 h → due soon (≥ 90 %); 51 h → overdue.
    expect(maintenanceDue({ hours: 50 }, last, { hours: 146, flights: 0, at: T0 }).status).toBe('due_soon');
    expect(maintenanceDue({ hours: 50 }, last, { hours: 151, flights: 0, at: T0 }).status).toBe('overdue');
    // Calendar time can be the driver.
    const c = maintenanceDue({ hours: 50, days: 30 }, last, { hours: 101, flights: 301, at: T0 + 31 * DAY });
    expect(c).toMatchObject({ status: 'overdue', driver: 'days' });
  });

  it('is never due without an interval', () => {
    expect(maintenanceDue({}, { hours: 0, flights: 0, at: T0 }, { hours: 999, flights: 999, at: T0 + 999 * DAY })).toMatchObject({ status: 'ok', driver: null });
  });
});

describe('predictive maintenance', () => {
  const series = (f: (h: number) => number, n = 12): MetricPoint[] => Array.from({ length: n }, (_, i) => ({ hours: i * 2, value: f(i * 2), at: new Date(T0 + i * DAY).toISOString() }));

  it('predicts when a rising vibration reaches its threshold', () => {
    // 10 m/s² + 0.5 per flight hour, last point at 22 h → 21 m/s²; reaches 30 at 40 h.
    const [vib] = predictHealth({ vibrationMean: series((h) => 10 + 0.5 * h) }, HEALTH_INDICATORS.filter((i) => i.metric === 'vibrationMean'));
    expect(vib!.slopePerHour).toBeCloseTo(0.5, 4);
    expect(vib!.remainingHours).toBeCloseTo(18, 1);
    expect(vib!.level).toBe('watch');
    expect(vib!.exceeded).toBe(false);
  });

  it('flags exceeded and imminent thresholds, ignores flat or noisy metrics', () => {
    const out = predictHealth({
      healthScore: series((h) => 95 - 1.2 * h),
      motorImbalance: series((h) => 0.05 + 0.003 * h),
      voltageSagPerCell: series((h) => 0.3 + (h % 4 === 0 ? 0.02 : -0.02)),
    });
    const byMetric = Object.fromEntries(out.map((p) => [p.indicator.metric, p]));
    // 95 − 1.2·22 = 68.6 < 70 → exceeded.
    expect(byMetric.healthScore).toMatchObject({ exceeded: true, level: 'action' });
    // 0.05 + 0.003·22 = 0.116, threshold 0.12 → 1.3 h left → action.
    expect(byMetric.motorImbalance!.level).toBe('action');
    expect(byMetric.motorImbalance!.remainingHours).toBeCloseTo(1.3, 1);
    // No trend → no time-to-threshold.
    expect(byMetric.voltageSagPerCell?.remainingHours ?? null).toBeNull();
    expect(byMetric.voltageSagPerCell?.level ?? 'ok').toBe('ok');
  });
});
