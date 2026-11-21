/**
 * Trend estimation for predictive maintenance: least-squares trends of per-flight metrics
 * and the predicted point at which a metric crosses its maintenance threshold.
 */

export interface Trend {
  slope: number;
  intercept: number;
  /** Coefficient of determination (0–1). */
  r2: number;
  n: number;
}

/** Ordinary least squares y = slope·x + intercept. */
export function linearTrend(points: { x: number; y: number }[]): Trend | null {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const n = pts.length;
  if (n < 2) return null;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
    syy += (p.y - my) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2, n };
}

export interface ThresholdPrediction {
  trend: Trend;
  /** Current value predicted by the trend at the last x. */
  current: number;
  /** x at which the threshold is reached, or null when the trend does not head there. */
  crossingX: number | null;
  /** Remaining x units (e.g. flight hours) until the threshold. */
  remaining: number | null;
  /** Whether the threshold has already been crossed. */
  exceeded: boolean;
}

/**
 * Predicts when an increasing (direction 'up') or decreasing ('down') metric reaches
 * `threshold`. Requires a minimum number of points and a minimally consistent trend.
 */
export function predictThreshold(points: { x: number; y: number }[], threshold: number, direction: 'up' | 'down', minPoints = 5, minR2 = 0.2): ThresholdPrediction | null {
  if (points.length < minPoints) return null;
  const trend = linearTrend(points);
  if (!trend) return null;
  const lastX = points.reduce((m, p) => Math.max(m, p.x), -Infinity);
  const current = trend.slope * lastX + trend.intercept;
  const exceeded = direction === 'up' ? current >= threshold : current <= threshold;
  const heading = direction === 'up' ? trend.slope > 0 : trend.slope < 0;
  if (exceeded) return { trend, current, crossingX: lastX, remaining: 0, exceeded: true };
  if (!heading || trend.r2 < minR2) return { trend, current, crossingX: null, remaining: null, exceeded: false };
  const crossingX = (threshold - trend.intercept) / trend.slope;
  return { trend, current, crossingX, remaining: Math.max(0, crossingX - lastX), exceeded: false };
}
