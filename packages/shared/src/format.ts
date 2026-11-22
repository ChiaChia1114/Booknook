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

// ---------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------

/**
 * Code points that show nothing on their own: white space, control and format characters (zero
 * width space and joiners, byte order mark, soft hyphen, directional marks), Hangul fillers,
 * the blank Braille pattern, combining grapheme joiner and variation selectors.
 */
export const INVISIBLE_CODE_POINTS: readonly number[] = [
  ...[0x0, 0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0x8, 0x9, 0xa, 0xb, 0xc, 0xd, 0xe, 0xf, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x7f],
  ...Array.from({ length: 0x21 }, (_, i) => 0x80 + i), // C1 controls and no-break space (0x80–0xa0)
  0xad, 0x34f, 0x61c, 0x115f, 0x1160, 0x1680, 0x17b4, 0x17b5, 0x180e,
  ...Array.from({ length: 0x10 }, (_, i) => 0x2000 + i), // en quad … right-to-left mark
  0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x202f, 0x205f,
  ...Array.from({ length: 0x10 }, (_, i) => 0x2060 + i).filter((cp) => cp !== 0x2065), // word joiner … nominal digit shapes
  0x2800, 0x3000, 0x3164,
  ...Array.from({ length: 0x10 }, (_, i) => 0xfe00 + i), // variation selectors
  0xfeff, 0xffa0, 0xfff9, 0xfffa, 0xfffb,
];

const INVISIBLE_CLASS = '[\\s\\p{Z}\\p{Cc}\\p{Cf}\\u034F\\u115F\\u1160\\u17B4\\u17B5\\u2800\\u3164\\uFFA0\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}]';
const INVISIBLE_EDGES = new RegExp(`^${INVISIBLE_CLASS}+|${INVISIBLE_CLASS}+$`, 'gu');

/** A name as stored: without invisible characters at either end ('' when nothing visible is left). */
export function cleanName(v: string): string {
  return v.replace(INVISIBLE_EDGES, '');
}

/** True when the text shows something (has a character that is not invisible). */
export function hasVisibleText(v: string | null | undefined): boolean {
  return !!v && cleanName(v).length > 0;
}

/** `pattern` attribute of name inputs: at least one visible character (the server checks the same). */
export const VISIBLE_NAME_PATTERN = '.*[^\\s\\p{Z}\\p{Cc}\\p{Cf}\\u034F\\u115F\\u1160\\u17B4\\u17B5\\u2800\\u3164\\uFFA0\\uFE00-\\uFE0F].*';
