/**
 * No member can keep the cloud busy with API requests: so many a second (and at once) over all
 * their sessions and API tokens; more are refused (429, with Retry-After) after a second, before
 * anything is done for them. Map and terrain tiles have ten times as many; the live connection
 * has limits of its own (see live-flow.test.ts); requests not signed in are not counted.
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, signup, startServer, Viewer, type Session, type TestServer } from './helpers';

let s: TestServer;
let busy: Session;
let other: Session;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  s = await startServer({ config: { apiRequestsPerS: 5, apiRequestBurst: 20 } });
  busy = await signup(s.app, { name: 'Busy Member' });
  other = await signup(s.app, { name: 'Other Member' });
});

afterAll(async () => {
  await s.close();
});

describe('API requests of a member', () => {
  it('so many at once, then so many a second – more are refused after a second; another member is not held back', async () => {
    const drones = `/api/v2/organisations/${busy.orgId}/drones`;
    const at = Date.now();
    const res = await Promise.all(Array.from({ length: 30 }, () => api(s.app, busy)('GET', drones)));
    const took = Date.now() - at;
    const ok = res.filter((r) => r.statusCode === 200).length;
    const refused = res.filter((r) => r.statusCode === 429);
    expect(ok).toBeGreaterThanOrEqual(20);
    expect(ok).toBeLessThanOrEqual(22);
    expect(refused).toHaveLength(30 - ok);
    expect(refused[0]!.json()).toMatchObject({ error: 'too_many_requests', message: 'Too many requests at once – wait a moment and try again' });
    expect(refused[0]!.headers['retry-after']).toBe('1');
    // (Answered after a second: a client sending them as fast as they are answered sends few.)
    expect(took).toBeGreaterThanOrEqual(950);
    // Another member is not held back.
    expect((await api(s.app, other)('GET', `/api/v2/organisations/${other.orgId}/drones`)).statusCode).toBe(200);
    // Tiles have an allowance of their own (terrain is off here: not found, never too many).
    const tiles = await Promise.all(Array.from({ length: 30 }, () => api(s.app, busy)('GET', '/api/v2/terrain/tiles/10/500/500.png')));
    expect(tiles.filter((r) => r.statusCode === 429)).toHaveLength(0);
    // The live connection has its own limits.
    const v = new Viewer(`${s.wsBase}/api/v2/live?org=${busy.orgId}`, { cookie: busy.cookie });
    await v.opened;
    await v.wait((m) => m.type === 'snapshot');
    v.close();
    // Not signed in: not counted (refused for that).
    expect((await s.app.inject({ method: 'GET', url: drones })).statusCode).toBe(401);
    // Spent again: within the second its refusals wait, about five more accrue (five a second).
    await Promise.all(Array.from({ length: 30 }, () => api(s.app, busy)('GET', drones)));
    const again = await Promise.all(Array.from({ length: 10 }, () => api(s.app, busy)('GET', drones)));
    const okAgain = again.filter((r) => r.statusCode === 200).length;
    expect(okAgain).toBeGreaterThanOrEqual(4);
    expect(okAgain).toBeLessThanOrEqual(7);
  });

  it('a request target written another way – absolute (`http://host/api/…`), %-escaped – counts as well', async () => {
    const member = await signup(s.app, { name: 'Written Member' });
    const path = `/api/v2/organisations/${member.orgId}/drones`;
    // As the router reads them: all of them the same route.
    const targets = [`http://127.0.0.1:${s.port}${path}`, `http://example.com${path}`, path.replace('/api/', '/%61pi/'), path.replace('/drones', '/%64rones')];
    const raw = (target: string) =>
      new Promise<{ status: number; cacheControl: string | undefined }>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: s.port, path: target, headers: { cookie: member.cookie } }, (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0, cacheControl: res.headers['cache-control'] }));
        });
        req.on('error', reject);
        req.end();
      });
    const first = await raw(targets[0]!);
    expect(first).toEqual({ status: 200, cacheControl: 'no-store' });
    const all = await Promise.all(Array.from({ length: 40 }, (_, i) => raw(targets[i % targets.length]!)));
    const ok = all.filter((r) => r.status === 200).length;
    // Twenty at once (one was used just before).
    expect(ok).toBeGreaterThanOrEqual(17);
    expect(ok).toBeLessThanOrEqual(21);
    expect(all.filter((r) => r.status === 429)).toHaveLength(40 - ok);
  });

  it('a JSON body of up to 1 MiB is read (in a turn of its own) – a larger one is refused, saying so', async () => {
    const member = await signup(s.app, { name: 'Importing Member' });
    const url = `/api/v2/organisations/${member.orgId}/missions/import`;
    const send = (content: string) => api(s.app, member)('POST', url, { name: 'Big', format: 'waypoints', content });
    // A QGC WPL file a little under 1 MiB as JSON (its tabs and line ends take two characters each): read and imported.
    const line = (i: number) => `${i}\t0\t3\t16\t0\t0\t0\t0\t25.${String(i).padStart(6, '0')}\t121.5\t50\t1`;
    let wpl = 'QGC WPL 110\n';
    for (let i = 0; wpl.length < 760_000; i++) wpl += `${line(i)}\n`;
    const fits = await send(wpl);
    expect(fits.statusCode).not.toBe(413);
    const big = await send(wpl + wpl);
    expect(big.statusCode).toBe(413);
    expect(big.json()).toEqual({ error: 'too_large', message: 'Too large: at most 1 MiB can be sent at once – split it into smaller parts' });
  });

  it('an API token counts with the member\'s sessions', async () => {
    const member = await signup(s.app, { name: 'Token Member' });
    const token = (await api(s.app, member)('POST', '/api/v2/tokens', { name: 'script' })).json().token as string;
    expect(token).toMatch(/^ast_/);
    const drones = `/api/v2/organisations/${member.orgId}/drones`;
    // As many over the token as over the session at once: one budget for both (twenty at once).
    const all = await Promise.all([
      ...Array.from({ length: 25 }, () => s.app.inject({ method: 'GET', url: drones, headers: { authorization: `Bearer ${token}` } })),
      ...Array.from({ length: 25 }, () => api(s.app, member)('GET', drones)),
    ]);
    const ok = all.filter((r) => r.statusCode === 200).length;
    expect(ok).toBeGreaterThanOrEqual(18);
    expect(ok).toBeLessThanOrEqual(22);
    expect(all.filter((r) => r.statusCode === 429)).toHaveLength(50 - ok);
  });
});
