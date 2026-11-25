/**
 * Calendar days of the period filters (date inputs give YYYY-MM-DD): which typed dates make a
 * period the pages can ask for.
 */

/** A local calendar day as YYYY-MM-DD (date inputs). */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** A complete, existing calendar day (YYYY-MM-DD; not 2024-02-30) of a plausible year for flight data (1970–2100). */
export function plausibleDay(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const year = Number(v.slice(0, 4));
  if (year < 1970 || year > 2100) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Days from one calendar day (YYYY-MM-DD) to another, both included (0 or less: `to` is before `from`). */
export function daysIncluded(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** A calendar day (YYYY-MM-DD) shifted by whole days. */
export function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Why two complete calendar days are not a period of at most `maxDays` days (null: they are). */
export function periodProblem(from: string, to: string, maxDays: number): string | null {
  const n = daysIncluded(from, to);
  if (!(n >= 1)) return 'From is after To';
  if (n > maxDays) return `a period can be at most ${maxDays.toLocaleString('en')} days`;
  return null;
}
