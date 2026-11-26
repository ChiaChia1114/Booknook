/**
 * Helpers of the web application: where signing in leads, names on map tags, and loading the
 * new version of the application after a server update.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { orgSwitchTarget, safeNext } from '../src/lib/navigation';
import { tagName } from '../src/lib/labels';
import { isChunkLoadError, reloadForUpdate } from '../src/lib/update';
import { calendarBounds, customProblem, daysIncluded, periodProblem, plausibleDay, shiftDay } from '../src/lib/period';
import { requestOutcome } from '../src/lib/authorization';
import type { AuthorizationDto } from '@athena-sky/shared';
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

describe('choosing another organisation', () => {
  it('keeps the page but nothing its address selects in the previous one; Settings keeps its tab', () => {
    expect(orgSwitchTarget('/flights', '?drone=2f0d6c1e&period=all')).toBe('/flights');
    expect(orgSwitchTarget('/locations', '?drone=2f0d6c1e')).toBe('/locations');
    expect(orgSwitchTarget('/maintenance', '?drone=2f0d6c1e')).toBe('/maintenance');
    expect(orgSwitchTarget('/live', '?drone=2f0d6c1e&panel=swarm')).toBe('/live');
    expect(orgSwitchTarget('/', '')).toBe('/');
    expect(orgSwitchTarget('/settings', '?tab=audit')).toBe('/settings?tab=audit');
    expect(orgSwitchTarget('/settings', '?tab=a%26b&x=1')).toBe('/settings?tab=a%26b');
    expect(orgSwitchTarget('/settings', '')).toBe('/settings');
  });
  it("leaves a page of one of the previous organisation's items for the list of its section", () => {
    expect(orgSwitchTarget('/fleet/2f0d6c1e', '')).toBe('/fleet');
    expect(orgSwitchTarget('/flights/2f0d6c1e/', '')).toBe('/flights');
    expect(orgSwitchTarget('/missions/2f0d6c1e', '?x=1')).toBe('/missions');
    expect(orgSwitchTarget('/fleet', '')).toBe('/fleet');
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

  it('says why the fields are not applied, also for years outside 1970–2100 and empty fields', () => {
    expect(customProblem('2025-06-01', '1969-01-01', 731)).toBe('To must be a date from 1970 to 2100');
    expect(customProblem('2025-06-01', '2101-01-01', 731)).toBe('To must be a date from 1970 to 2100');
    expect(customProblem('2150-12-01', '2025-06-30', 3660)).toBe('From must be a date from 1970 to 2100');
    expect(customProblem('0202-06-01', '2025-06-30', 3660)).toBe('From must be a date from 1970 to 2100');
    expect(customProblem('', '2025-06-30', 3660)).toBe('enter both dates');
    expect(customProblem('2025-06-01', '', 3660)).toBe('enter both dates');
    expect(customProblem('2025-07-01', '2025-06-30', 731)).toBe('From is after To');
    expect(customProblem('2025-06-01', '2025-06-30', 731)).toBeNull();
  });

  it('offers in the calendars only days of a period the page accepts – bounded by the period shown when the other field is unusable', () => {
    const shown = { from: '2025-06-01', to: '2025-06-30' };
    expect(calendarBounds('2025-06-01', '2025-06-30', shown, 731)).toEqual({ from: { min: '2023-07-01', max: '2025-06-30' }, to: { min: '2025-06-01', max: '2027-06-01' } });
    // To typed outside 1970–2100 (or cleared): From still offers days up to the To shown.
    expect(calendarBounds('2025-06-01', '2101-01-01', shown, 731).from).toEqual({ min: '2023-07-01', max: '2025-06-30' });
    expect(calendarBounds('', '', shown, 731)).toEqual({ from: { min: '2023-07-01', max: '2025-06-30' }, to: { min: '2025-06-01', max: '2027-06-01' } });
    // Never before 1970 or after 2100.
    expect(calendarBounds('1970-03-01', '1971-01-01', { from: '1970-03-01', to: '1971-01-01' }, 3660).from.min).toBe('1970-01-01');
    expect(calendarBounds('2099-01-01', '2099-02-01', { from: '2099-01-01', to: '2099-02-01' }, 3660).to.max).toBe('2100-12-31');
  });
});

describe('authorisation request outcome', () => {
  const base = { reference: 'ATH-1', status: 'pending', authority: 'Mock UTM', authorityState: 'submitted', authorityError: null } as unknown as AuthorizationDto;
  it('tells a request awaiting the authority from one whose submission got no answer yet', () => {
    expect(requestOutcome(base)).toEqual({ message: 'ATH-1: submitted to Mock UTM – awaiting its decision', tone: 'info' });
    expect(requestOutcome({ ...base, authorityState: 'submitting', authorityError: 'no answer in time' })).toEqual({ message: 'ATH-1: not submitted to Mock UTM yet (no answer in time) – retrying', tone: 'info' });
    expect(requestOutcome({ ...base, status: 'approved' })).toEqual({ message: 'ATH-1: approved by Mock UTM', tone: 'ok' });
    expect(requestOutcome({ ...base, status: 'rejected', authority: null })).toEqual({ message: 'ATH-1: rejected', tone: 'error' });
    expect(requestOutcome({ ...base, authority: null })).toEqual({ message: "ATH-1: pending – awaiting a mission manager's decision", tone: 'info' });
  });
});
