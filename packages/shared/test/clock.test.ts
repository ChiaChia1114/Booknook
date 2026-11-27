import { describe, expect, it } from 'vitest';
import { CLOCK_DRIFT, CLOCK_STEP_MS, CLOCK_WINDOW_MS, ClockBound } from '../src/clock';

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
    expect(c.rtt).toBeNull();
    exchange(c, 1000, 60_000, 20, 30);
    const b = c.bound(1050)!;
    expect(b).toBeGreaterThanOrEqual(60_000);
    expect(b - 60_000).toBeCloseTo(20, 0);
    expect(c.rtt).toBe(50);
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

  it('a way out that becomes slow loosens the bound at once – it cannot be told from the remote clock set forward: reported times look older, never newer', () => {
    const c = new ClockBound();
    let now = exchange(c, 0, 1000, 10, 10);
    for (let i = 0; i < 30; i++) {
      now += 2000;
      exchange(c, now, 1000, 3000, 10);
      const b = c.bound(now + 3010)!;
      expect(b).toBeGreaterThanOrEqual(1000);
      expect(b - 1000).toBeGreaterThan(2990);
    }
    // Fast again: the better bound at once.
    now = exchange(c, now + 2000, 1000, 10, 10);
    expect(c.bound(now)! - 1000).toBeGreaterThanOrEqual(0);
    expect(c.bound(now)! - 1000).toBeLessThan(20);
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

  it('follows a remote clock set forward by less than its round trip (a slow uplink) at the next exchange', () => {
    for (const step of [1000, 3000, 5000]) {
      const c = new ClockBound();
      let now = 0;
      // Every answer takes 6 s to come back: a step of less than that is no contradiction…
      for (let i = 0; i < 20; i++) now = exchange(c, now + 2000, 0, 5, 6000);
      now = exchange(c, now + 2000, step, 5, 6000);
      // …but the bound it tells is well above the one kept: only it holds now.
      expect(c.bound(now)!).toBeGreaterThanOrEqual(step);
      expect(c.bound(now)! - step).toBeLessThan(20);
    }
  });

  it('a step smaller than CLOCK_STEP_MS (and than the way back) is followed once the exchanges before it are older than the window', () => {
    const c = new ClockBound();
    let now = 0;
    for (let i = 0; i < 10; i++) now = exchange(c, now + 2000, 0, 5, 50);
    const step = CLOCK_STEP_MS - 10;
    const from = now;
    while (now - from <= CLOCK_WINDOW_MS + 2000) {
      now = exchange(c, now + 2000, step, 5, 50);
      // Never more than the step too low.
      expect(c.bound(now)!).toBeGreaterThan(step - CLOCK_STEP_MS);
    }
    expect(c.bound(now)!).toBeGreaterThanOrEqual(step);
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
    // A bound kept without newer exchanges widens by the possible drift.
    const quiet = new ClockBound();
    exchange(quiet, 0, 100, 5, 5);
    expect(quiet.bound(60_000)! - quiet.bound(10)!).toBeCloseTo(CLOCK_DRIFT * (60_000 - 10), 3);
  });

  it('tells the shortest round trip of the latest exchanges – those whose answer had no time too', () => {
    const c = new ClockBound();
    c.roundTrip(0, 900);
    expect(c.rtt).toBe(900);
    expect(c.bound(900)).toBeNull();
    let now = exchange(c, 1000, 0, 100, 200);
    expect(c.rtt).toBe(300);
    now = exchange(c, now + 1000, 0, 100, 2000);
    expect(c.rtt).toBe(300);
    // Older than the window: forgotten once newer ones came.
    for (let i = 0; i < 8; i++) now = exchange(c, now + 1000, 0, 100, 1500);
    expect(c.rtt).toBe(1600);
  });

  it('is moved along when our clock is set back (the remote clock is that much more ahead of it)', () => {
    const c = new ClockBound();
    exchange(c, 0, 500, 5, 5);
    const before = c.bound(10)!;
    c.shiftLocal(-7000);
    expect(c.bound(10 - 7000)!).toBeCloseTo(before + 7000, 6);
  });

  it('ignores exchanges that make no sense', () => {
    const c = new ClockBound();
    c.sample(NaN, 1, 2);
    c.sample(10, Infinity, 20);
    c.sample(20, 15, 10);
    c.roundTrip(30, 20);
    c.roundTrip(NaN, 20);
    expect(c.bound(30)).toBeNull();
    expect(c.rtt).toBeNull();
    c.sample(10, 115, 20);
    expect(c.bound(20)).toBe(105);
    c.reset();
    expect(c.bound(20)).toBeNull();
  });
});
