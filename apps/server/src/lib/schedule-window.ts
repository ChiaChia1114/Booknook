/**
 * A scheduled operation is the one being flown only near its planned time: an upload or a
 * flight of the same mission on the same drone days earlier (or later) is another operation.
 */
export const SCHEDULE_WINDOW_MS = 12 * 3_600_000;

/** Planned times (ISO) that count as "now" for a schedule. */
export function scheduleWindow(now = Date.now()): { from: string; to: string; now: string } {
  return { from: new Date(now - SCHEDULE_WINDOW_MS).toISOString(), to: new Date(now + SCHEDULE_WINDOW_MS).toISOString(), now: new Date(now).toISOString() };
}
