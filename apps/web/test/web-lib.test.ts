/**
 * Helpers of the web application: where signing in leads, names on map tags, and loading the
 * new version of the application after a server update.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { safeNext } from '../src/lib/navigation';
import { tagName } from '../src/lib/labels';
import { isChunkLoadError, reloadForUpdate } from '../src/lib/update';
import { daysIncluded, periodProblem, plausibleDay, shiftDay } from '../src/lib/period';
import { VISIBLE_NAME_PATTERN, cleanName, hasVisibleText, invisibleCodePoints } from '@athena-sky/shared';

describe('after signing in', () => {
  it('goes to a page of the application only', () => {
    expect(safeNext('/fleet/2f0d6c1e?tab=flights')).toBe('/fleet/2f0d6c1e?tab=flights');
    expect(safeNext('/missions/abc')).toBe('/missions/abc');
    for (const bad of [null, '', 'https://evil.example/x', '//evil.example/x', '/\\evil.example', '/\\/evil.example', 'javascript:alert(1)', '/ok\nSet-Cookie: x', 'fleet']) {
      expect(safeNext(bad), String(bad)).toBe('/');
    }
  });
});

describe('map tags', () => {
  it('shorten long names with an ellipsis and keep short ones', () => {
    expect(tagName('Falcon-1')).toBe('Falcon-1');
    expect(tagName('12345678901234567890')).toBe('12345678901234567890');
    const long = tagName('R12 Extremely Long Drone Name For Layout Testing');
    expect(long).toBe('R12 Extremely Long…');
    expect(Array.from(long).length).toBeLessThanOrEqual(20);
    // Characters outside the basic plane are not cut in half.
    expect(tagName('無人機'.repeat(10))).toBe(`${'無人機'.repeat(6)}無…`);
    expect(tagName('🚁'.repeat(30)).endsWith('🚁…')).toBe(true);
  });
});

describe('after a server update', () => {
  const g = globalThis as unknown as { sessionStorage?: unknown; window?: unknown };
  afterEach(() => {
    delete g.sessionStorage;
    delete g.window;
  });

  it('recognises bundles of the previous version that are gone', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: http://h/assets/MissionPlanner-4cOQnR2F.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/index-X.css'))).toBe(true);
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'name')"))).toBe(false);
  });

  it('reloads the page once – not again and again when that did not help', () => {
    const store = new Map<string, string>();
    let reloads = 0;
    g.sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    g.window = { location: { reload: () => reloads++ } };
    expect(reloadForUpdate()).toBe(true);
    expect(reloads).toBe(1);
    expect(reloadForUpdate()).toBe(false);
    expect(reloads).toBe(1);
    // Later (a next update): once more.
    store.set('athena.reloadedForUpdate', String(Date.now() - 60_000));
    expect(reloadForUpdate()).toBe(true);
    expect(reloads).toBe(2);
    // Without storage the page cannot tell, and does not reload.
    g.sessionStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
    };
    expect(reloadForUpdate()).toBe(false);
    expect(reloads).toBe(2);
  });
});

describe('names in forms', () => {
  it('need a character that shows – as browsers check the pattern of name inputs (v flag)', () => {
    const re = new RegExp(`^(?:${VISIBLE_NAME_PATTERN})$`, 'v');
    for (const ok of ['Falcon', '無人機 1', 'a\u200Bb', '🚁', ' x ']) {
      expect(re.test(ok), JSON.stringify(ok)).toBe(true);
      expect(hasVisibleText(ok), JSON.stringify(ok)).toBe(true);
    }
    for (const bad of ['', ' ', '\u200B', '\u200B\u200C\u200D', '\uFEFF', '\u3164', '\u2800', '\u00A0\u00AD', '\uFE0F', '\u{E0101}\u{E0102}', '\u{E0041}\u{E007F}', '\u{1D173}']) {
      expect(re.test(bad), JSON.stringify(bad)).toBe(false);
      expect(hasVisibleText(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(cleanName('\u200B Merlin \uFEFF')).toBe('Merlin');
    // The database is cleaned of the same characters (migration 13).
    const cps = invisibleCodePoints();
    expect(cps).toContain(0x200b);
    expect(cps).toContain(0xe0101);
    expect(cps).toContain(0xe0041);
    expect(cps.every((cp) => !hasVisibleText(String.fromCodePoint(cp)))).toBe(true);
    expect(cps).not.toContain('a'.codePointAt(0));
  });
});

describe('period filters', () => {
  it('takes only complete dates of plausible years (a year typed digit by digit passes 0002, 0020, 0202)', () => {
    for (const v of ['0002-08-26', '0020-08-26', '0202-08-26', '1969-12-31', '2101-01-01', '2024-02-30', '', '2024-8-26']) expect(plausibleDay(v), v).toBe(false);
    for (const v of ['2024-08-26', '1970-01-01', '2100-12-31', '2024-02-29']) expect(plausibleDay(v), v).toBe(true);
  });

  it('counts whole calendar days, both ends included, across daylight saving changes', () => {
    expect(daysIncluded('2026-11-25', '2026-11-25')).toBe(1);
    expect(daysIncluded('2024-01-01', '2025-12-31')).toBe(731);
    expect(daysIncluded('2026-03-01', '2026-03-31')).toBe(31);
    expect(daysIncluded('2026-11-26', '2026-11-25')).toBe(0);
    expect(shiftDay('2024-12-31', 1)).toBe('2025-01-01');
    expect(shiftDay('2026-11-25', -730)).toBe('2024-11-25');
  });

  it('names what keeps a pair of dates from being a period the page accepts', () => {
    expect(periodProblem('2026-11-26', '2026-11-25', 731)).toBe('From is after To');
    expect(periodProblem('2024-01-01', '2025-12-31', 731)).toBeNull();
    expect(periodProblem('2024-01-01', '2026-01-01', 731)).toBe('a period can be at most 731 days');
    expect(periodProblem('2016-01-01', '2026-01-01', 3660)).toBeNull();
    expect(periodProblem('2016-01-01', '2026-12-31', 3660)).toBe('a period can be at most 3,660 days');
  });
});
