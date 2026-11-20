/** Small formatting helpers shared by the web UI, exports and reports. */

export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '—';
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export function formatHours(totalSeconds: number): string {
  return `${(totalSeconds / 3600).toFixed(1)} h`;
}

export function formatDistance(m: number): string {
  if (!Number.isFinite(m)) return '—';
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

/** UTC date key (YYYY-MM-DD) used for per-day aggregation. */
export function dayKey(d: Date | number | string): string {
  return new Date(d).toISOString().slice(0, 10);
}
