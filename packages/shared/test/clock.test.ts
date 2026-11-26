import { describe, expect, it } from 'vitest';
import { CLOCK_DRIFT, ClockBound } from '../src/clock';

/** A remote clock `offset` ms ahead of ours; an exchange taking `down` ms out and `up` ms back. */
function exchange(c: ClockBound, now: number, offset: number, down: number, up: number): number {
  const answeredAt = now + down;
  c.sample(now, answeredAt + offset, answeredAt + up);
  return answeredAt + up;
}

describe('ClockBound: the offset of a remote clock as an upper bound', () => {
  it('is unknown until an exchange is made, then at most the way out above the true offset', () => {
    const c = new ClockBound();
    expect(c.bound(0)).toBeNull();
    exchange(c, 1000, 60_000, 20, 30);
    const b = c.bound(1050)!;
    expect(b).toBeGreaterThanOrEqual(60_000);
    expect(b - 60_000).toBeCloseTo(20, 0);
  });

  it('a slow way back (uplink) never makes reported times look newer than they are', () => {
    const c = new ClockBound();
    let now = 0;
    // A good exchange, then ten minutes in which every answer takes 8 s to come back.
    now = exchange(c, now, 5000, 5, 5);
    for (let i = 0; i < 300; i++) {
      now += 2000;
      exchange(c, now, 5000, 5, 8000);
      const b = c.bound(now + 8005)!;
      expect(b).toBeGreaterThanOrEqual(5000);
      expect(b - 5000).toBeLessThan(10);
    }
    // The same from the start (no good exchange before).
    const d = new ClockBound();
    exchange(d, 0, -3000, 5, 8000);
    expect(d.bound(8005)! - -3000).toBeCloseTo(5, 0);
  });

  it('a slow way out keeps the better bound, widened only by the possible drift', () => {
    const c = new ClockBound();
    let now = exchange(c, 0, 1000, 10, 10);
    for (let i = 0; i < 300; i++) {
      now += 2000;
      exchange(c, now, 1000, 3000, 10);
    }
    const b = c.bound(now)!;
    expect(b).toBeGreaterThanOrEqual(1000);
    // Ten minutes of drift at most: never the 3-s way out.
    expect(b - 1000).toBeLessThanOrEqual(10 + CLOCK_DRIFT * now + 1);
    expect(b - 1000).toBeLessThan(3000);
  });

  it('follows the remote clock set forward or back', () => {
    const c = new ClockBound();
    let now = exchange(c, 0, 0, 10, 10);
    // Set forward by 10 s: the next exchange shows the bound kept to be wrong.
    now = exchange(c, now + 2000, 10_000, 10, 10);
    expect(c.bound(now)! - 10_000).toBeGreaterThanOrEqual(0);
    expect(c.bound(now)! - 10_000).toBeLessThan(20);
    // Set back by 30 s: a lower bound.
    now = exchange(c, now + 2000, -20_000, 10, 10);
    expect(c.bound(now)! - -20_000).toBeGreaterThanOrEqual(0);
    expect(c.bound(now)! - -20_000).toBeLessThan(20);
  });

  it('stays an upper bound while the clocks drift apart (300 ppm) and exchanges are slow out', () => {
    const c = new ClockBound();
    let now = 0;
    const offsetAt = (t: number) => 2000 + 3e-4 * t;
    now = exchange(c, now, offsetAt(now), 5, 5);
    for (let i = 0; i < 1800; i++) {
      now += 2000;
      // Slow out: no better bound comes; the true offset grows.
      exchange(c, now, offsetAt(now + 4000), 4000, 5);
      expect(c.bound(now)!).toBeGreaterThanOrEqual(offsetAt(now));
    }
  });

  it('ignores exchanges that make no sense', () => {
    const c = new ClockBound();
    c.sample(NaN, 1, 2);
    c.sample(10, Infinity, 20);
    c.sample(20, 15, 10);
    expect(c.bound(30)).toBeNull();
    c.sample(10, 115, 20);
    expect(c.bound(20)).toBe(105);
    c.reset();
    expect(c.bound(20)).toBeNull();
  });
});
