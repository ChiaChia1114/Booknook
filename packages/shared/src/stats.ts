/** Loop-based aggregates (safe for arrays of any length, unlike Math.max(...arr)). */

export function maxOf(values: readonly number[], fallback = -Infinity): number {
  let m = fallback;
  for (const v of values) if (v > m) m = v;
  return m;
}

export function minOf(values: readonly number[], fallback = Infinity): number {
  let m = fallback;
  for (const v of values) if (v < m) m = v;
  return m;
}

/** Evenly picks at most n elements (keeps the first and the last). */
export function decimate<T>(arr: readonly T[], n: number): T[] {
  if (arr.length <= n || n < 2) return [...arr];
  const step = (arr.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => arr[Math.round(i * step)]!);
}
