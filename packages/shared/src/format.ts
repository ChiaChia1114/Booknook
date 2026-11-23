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

/**
 * Date key (YYYY-MM-DD) in a time zone (IANA name, e.g. "Asia/Taipei"): flights are counted on
 * the day they were flown where the viewer is, not on the UTC day. Throws on an unknown zone.
 */
export function zonedDayKey(timeZone: string): (d: Date | number | string) => string {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (d) => {
    const parts = fmt.formatToParts(new Date(d));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  };
}

/** The calendar days from `first` to `last` (YYYY-MM-DD, both included). */
export function daysBetween(first: string, last: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${last}T00:00:00Z`);
  for (let t = Date.parse(`${first}T00:00:00Z`); t <= end && out.length <= 3700; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

// ---------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------

/**
 * Characters that show nothing on their own: white space, control and format characters (zero
 * width space and joiners, byte order mark, soft hyphen, directional marks, tag characters),
 * Hangul fillers, the blank Braille pattern, combining grapheme joiner and variation selectors.
 */
const INVISIBLE_CHARS = '\\s\\p{Z}\\p{Cc}\\p{Cf}\\u034F\\u115F\\u1160\\u17B4\\u17B5\\u2800\\u3164\\uFFA0\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}';
const INVISIBLE_CLASS = `[${INVISIBLE_CHARS}]`;
const INVISIBLE_EDGES = new RegExp(`^${INVISIBLE_CLASS}+|${INVISIBLE_CLASS}+$`, 'gu');

let invisible: number[] | null = null;

/** Every code point `cleanName` takes as invisible (for the database, which has no Unicode classes). */
export function invisibleCodePoints(): number[] {
  if (!invisible) {
    const one = new RegExp(`^${INVISIBLE_CLASS}$`, 'u');
    invisible = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (one.test(String.fromCodePoint(cp))) invisible.push(cp);
    }
  }
  return invisible;
}

/** A name as stored: without invisible characters at either end ('' when nothing visible is left). */
export function cleanName(v: string): string {
  return v.replace(INVISIBLE_EDGES, '');
}

/** True when the text shows something (has a character that is not invisible). */
export function hasVisibleText(v: string | null | undefined): boolean {
  return !!v && cleanName(v).length > 0;
}

/** `pattern` attribute of name inputs: at least one visible character (the server checks the same). */
export const VISIBLE_NAME_PATTERN = `.*[^${INVISIBLE_CHARS}].*`;
