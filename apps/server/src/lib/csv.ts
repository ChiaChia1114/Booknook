/**
 * CSV cells for files opened in spreadsheets: text that a spreadsheet would evaluate as a
 * formula (=, +, -, @, tab, CR) is prefixed with an apostrophe; numbers stay numbers.
 */
export function csvCell(v: unknown, digits = 7): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 10 ** digits) / 10 ** digits) : '';
  const s = String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
