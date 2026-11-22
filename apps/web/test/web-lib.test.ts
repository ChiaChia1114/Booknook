/**
 * Helpers of the web application: where signing in leads, names on map tags, and loading the
 * new version of the application after a server update.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { safeNext } from '../src/lib/navigation';
import { tagName } from '../src/lib/labels';
import { isChunkLoadError, reloadForUpdate } from '../src/lib/update';
import { VISIBLE_NAME_PATTERN, cleanName, hasVisibleText } from '@athena-sky/shared';

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
    for (const bad of ['', ' ', '\u200B', '\u200B\u200C\u200D', '\uFEFF', '\u3164', '\u2800', '\u00A0\u00AD', '\uFE0F']) {
      expect(re.test(bad), JSON.stringify(bad)).toBe(false);
      expect(hasVisibleText(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(cleanName('\u200B Merlin \uFEFF')).toBe('Merlin');
  });
});
