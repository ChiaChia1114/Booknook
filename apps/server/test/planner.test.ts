/**
 * Planning computations in a worker thread of their own (planning/planner.ts): members in turn, at
 * most two of one member waiting or running (more refused), one that takes too long stopped – and
 * the live connections' event loop never held up meanwhile.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { normalizePlan, type MissionPlan } from '@athena-sky/shared';
import { PER_OWNER, Planner } from '../src/planning/planner';

const log = { error: () => {} } as never;
let planner: Planner | null = null;
afterEach(() => {
  planner?.shutdown();
  planner = null;
});

const home = { lat: 25.03, lon: 121.56 };
/** A route of `n` scattered waypoints: reordering it takes the optimiser a while. */
const scattered = (n: number): MissionPlan =>
  normalizePlan({
    home,
    defaultAlt: 50,
    defaultSpeed: 10,
    items: [
      { id: 't', type: 'takeoff', alt: 40 },
      ...Array.from({ length: n }, (_, i) => ({ id: `w${i}`, type: 'waypoint', lat: home.lat + 0.01 * Math.sin(i * 0.37), lon: home.lon + 0.01 * Math.cos(i * 0.53), alt: 50 })),
      { id: 'r', type: 'rtl' },
    ],
  });
const reorder = (n: number) => ({ plan: scattered(n), reorder: true, zones: [], bufferM: 30, airframeId: 'specter-10x', payloadKg: 0, wind: null });
const orbit = { kind: 'orbit', params: { center: home, radiusM: 40, alt: 30, points: 8 } };

describe('the planning worker', () => {
  it('members in turn; at most two of one member at once – the event loop free meanwhile', async () => {
    planner = new Planner(log);
    const order: string[] = [];
    // The loop's longest stretch while the worker computes.
    let last = performance.now();
    let longest = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
    }, 2);
    const a1 = planner.run('optimize', reorder(120), 'user:a').then(() => order.push('a1'));
    const a2 = planner.run('optimize', reorder(120), 'user:a').then(() => order.push('a2'));
    const refused = planner.run('generate', orbit, 'user:a').catch((err: { status?: number; message: string }) => err);
    const b = planner.run('generate', orbit, 'user:b').then((r) => {
      order.push('b');
      return r;
    });
    const err = (await refused) as { status?: number; message: string };
    expect(PER_OWNER).toBe(2);
    expect(err.status).toBe(429);
    expect(err.message).toBe('Your plans are still being computed – try again once they are done');
    const [generated] = await Promise.all([b, a1, a2]);
    clearInterval(tick);
    // The other member's came after the first of the busy member's – not after both.
    expect(order).toEqual(['a1', 'b', 'a2']);
    expect(generated.items.length).toBeGreaterThan(5);
    expect(longest).toBeLessThan(60);
    // Done: the busy member may ask again.
    expect((await planner.run('generate', orbit, 'user:a')).items.length).toBeGreaterThan(5);
  }, 60_000);

  it('a request the computation refuses is told as it is; one that takes too long is stopped – the next one still computed', async () => {
    planner = new Planner(log, 300);
    const bad = await planner.run('generate', { kind: 'orbit', params: { center: { lat: 99, lon: 0 }, radiusM: 40 } }, 'user:a').catch((e) => e);
    expect(bad).toMatchObject({ status: 400, message: 'center must be a {lat, lon} position' });
    const slow = await planner.run('optimize', reorder(300), 'user:a').catch((e) => e);
    expect(slow).toMatchObject({ status: 503, message: 'The computation took too long – plan fewer waypoints or a smaller area' });
    expect((await planner.run('generate', orbit, 'user:a')).items.length).toBeGreaterThan(5);
  }, 60_000);
});
