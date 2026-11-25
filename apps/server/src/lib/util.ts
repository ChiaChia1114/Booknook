import { randomUUID } from 'node:crypto';
import { badRequest } from './errors';
import { zonedDayKey } from '@athena-sky/shared';

export const uuid = (): string => randomUUID();
export const nowIso = (): string => new Date().toISOString();

/** Gives the event loop a turn (between the long steps of a request: other requests go on). */
export const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function isoOrNull(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** Parses an ISO date string (query/body input) or throws 400. */
export function parseDate(v: unknown, field: string): Date {
  if (typeof v !== 'string' || !v) throw badRequest(`${field} is required`);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw badRequest(`${field} must be an ISO-8601 date`);
  return d;
}

export interface DateRange {
  from: Date;
  to: Date;
}

/**
 * The day (YYYY-MM-DD) of an instant in the IANA time zone `tz` (UTC when not given); an unknown
 * zone is refused (400) rather than silently counted in UTC.
 */
export function zonedDay(tz: string | undefined | null): (d: Date | number | string) => string {
  const zone = tz?.trim() || 'UTC';
  try {
    return zonedDayKey(zone);
  } catch {
    throw badRequest(`Unknown time zone "${zone.slice(0, 64)}"`);
  }
}

/**
 * Resolves an analytics date range (defaults to the last `defaultDays` days).
 * The span is capped (`maxDays`) so a request cannot make the server build huge series: `maxDays`
 * whole calendar days of the viewer (local midnight to the end of the last day) – a period that
 * passes the end of daylight saving time is an hour longer, which is still allowed.
 */
export function resolveRange(from: unknown, to: unknown, defaultDays = 30, maxDays = 3660): DateRange {
  const end = typeof to === 'string' && to ? parseDate(to, 'to') : new Date();
  const start =
    typeof from === 'string' && from ? parseDate(from, 'from') : new Date(end.getTime() - defaultDays * 86_400_000);
  if (start.getTime() > end.getTime()) throw badRequest('from must be before to');
  if (end.getTime() - start.getTime() > maxDays * 86_400_000 + 3_600_000) throw badRequest(`The period cannot exceed ${maxDays} days`);
  return { from: start, to: end };
}

export function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Sanitises a user-supplied file name for Content-Disposition headers and storage metadata. */
export function safeFilename(name: string, fallback = 'file'): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^\w.\- ()]+/g, '_').slice(0, 120).trim();
  return cleaned || fallback;
}

/** Scheme, host and port of an address (a feed's, an authority's) – without credentials, path or query, which may hold a key. */
export function feedOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.pathname === '/' && !u.search ? u.origin : `${u.origin}/…`;
  } catch {
    return null;
  }
}
