/**
 * Flow control of a live viewer, simulated over links of every kind (fast, far away, slow, slow
 * and far away, slowing down, stalling, a viewer that cannot keep up): what the viewer shows of
 * each drone stays as new as its link allows – it never waits behind what was sent before it – and
 * the link is used (a far-away link gets everything, a slow one as much video as it carries).
 */
import { describe, expect, it } from 'vitest';
import { MAX_FRAME_MS } from '../src/realtime/flow';
import { FRAME_BYTES, KiB, simulate, TELEMETRY_HZ } from './flow-sim';
describe('Flow control: what a viewer shows stays as new as its link allows', () => {
  it('a fast link gets everything at once', () => {
    const r = simulate({ down: 20, up: 20, rate: () => Infinity }, { seconds: 40 });
    expect(r.telemetryShare).toBeGreaterThan(0.99);
    expect(r.max).toBeLessThan(260);
    expect(r.frameShare).toBeGreaterThan(0.95);
  });

  for (const down of [400, 800, 1600, 2500]) {
    it(`a far-away link (${down} ms out, nothing else limiting) gets every telemetry sample, as new as the distance allows`, () => {
      const r = simulate({ down, up: 10, rate: () => Infinity }, { seconds: 60 });
      expect(r.telemetryShare).toBeGreaterThan(0.99);
      // The newest sample is the distance old, plus the time to the next one.
      expect(r.max).toBeLessThan(down + 1000 / TELEMETRY_HZ + 60);
      // Video too (the farther, the longer it takes to start at full rate).
      expect(r.frameShare).toBeGreaterThan(down <= 1600 ? 0.9 : 0.6);
    });
  }

  for (const [name, kib, down, video] of [
    ['150 KiB/s', 150, 20, 'sd'],
    ['50 KiB/s', 50, 20, 'sd'],
    ['50 KiB/s with HD video', 50, 20, 'hd'],
    ['80 KiB/s and 800 ms out (a far-away link with a small window)', 80, 800, 'sd'],
    ['30 KiB/s and 1.2 s out', 30, 1200, 'sd'],
    ['100 KiB/s and 2 s out', 100, 2000, 'sd'],
  ] as const) {
    it(`a slow link (${name}) still gets its telemetry new; video takes what is left`, () => {
      // Measured once started (what is in flight grows round trip by round trip).
      const r = simulate({ down, up: 10, rate: () => kib * KiB }, { seconds: 70, warmup: 20_000 + 5 * down, video });
      // The newest telemetry is never older than the distance, a frame in front of it, and a
      // fraction of a second.
      const frameTime = FRAME_BYTES[video] / (kib * KiB);
      expect(r.max).toBeLessThan(down + frameTime + 700);
      expect(r.p90).toBeLessThan(down + frameTime + 400);
      expect(r.telemetryShare).toBeGreaterThan(0.9);
      // Video as much as the link carries (not starved), never old.
      const carried = (kib * KiB * 1000) / (3 * FRAME_BYTES[video] * (video === 'hd' ? 6 : 10));
      expect(r.frameShare).toBeGreaterThan(carried * 0.4);
      expect(r.frameMaxAge).toBeLessThan(down + frameTime + 700);
    });
  }

  it('a slow link far away is not flooded as it starts (video paced at its rate): the newest telemetry is never much older than the distance', () => {
    for (const [kib, down, extra] of [
      [80, 800, 1000],
      [100, 2000, 1300],
    ] as const) {
      // From the first data on (what is in flight grows from nothing, round trip by round trip).
      const r = simulate({ down, up: 10, rate: () => kib * KiB }, { seconds: 40, warmup: 2 * down + 1500 });
      expect(r.max).toBeLessThan(down + extra);
      expect(r.telemetryShare).toBeGreaterThan(0.99);
    }
  });

  it('a link that becomes farther (another route, a satellite hand-over) is measured again: its video comes back', () => {
    for (const [from, to, rate, video] of [
      [20, 800, Infinity, 0.9],
      [20, 800, 300 * KiB, 0.5 * ((300 * KiB * 1000) / (3 * FRAME_BYTES.sd * 10))],
      [400, 1600, Infinity, 0.9],
      [1000, 2500, Infinity, 0.85],
    ] as const) {
      const r = simulate({ down: (t) => (t < 25_000 ? from : to), up: 10, rate: () => rate }, { seconds: 90 });
      // The round trip used is the new one (not the shorter one seen before)…
      expect(r.flow.rttMin).toBeGreaterThan(to);
      expect(r.flow.rttMin).toBeLessThan(to + 150);
      // …the telemetry arrives as new as the distance allows…
      const after = r.ages.filter((a) => a.t > 45_000).map((a) => a.age);
      expect(Math.max(...after)).toBeLessThan(to + 600);
      expect(r.telemetryShare).toBeGreaterThan(0.9);
      // …and the video comes back within a few round trips – as much as the link carries.
      expect(r.frameShareBetween(25_000 + 5 * to + 5000, 80_000)).toBeGreaterThan(video);
    }
  });

  it('a far link that suddenly becomes slower holds up only what was on its way: then nothing builds up', () => {
    for (const [down, kib] of [
      [400, 50],
      [1000, 50],
      [1000, 150],
    ] as const) {
      const SLOW_AT = 40_000;
      const r = simulate({ down, up: 10, rate: (t) => (t < SLOW_AT ? Infinity : kib * KiB) }, { seconds: 130 });
      // What was on its way as it slowed down – a round trip of video (600 KB/s), a short queue and
      // a frame or two – passes at its new rate first…
      const held = (600 * (down + 100) + 96 * 1024) / (kib * KiB);
      const around = r.ages.filter((a) => a.t >= SLOW_AT && a.t < SLOW_AT + held + 10_000).map((a) => a.age);
      expect(Math.max(...around)).toBeLessThan(held + down + 2000);
      // …then the cloud sends no more than the link carries: the newest telemetry is never much
      // older than the distance and a frame in front of it – it never builds up again.
      const frameTime = FRAME_BYTES.sd / (kib * KiB);
      const later = r.ages.filter((a) => a.t >= SLOW_AT + held + 15_000).map((a) => a.age);
      expect(Math.max(...later)).toBeLessThan(down + frameTime + 1000);
      // Video as much as the link carries.
      const carried = (kib * KiB * 1000) / (3 * FRAME_BYTES.sd * 10);
      expect(r.frameShareBetween(SLOW_AT + held + 15_000, 120_000)).toBeGreaterThan(carried * 0.4);
    }
  });

  it(`a frame that would hold a slow link up for longer than ${MAX_FRAME_MS} ms is not sent – but one now and then (the link is measured again)`, () => {
    // HD video (60 KB frames) over 30 KiB/s: two seconds a frame.
    const r = simulate({ down: 20, up: 10, rate: () => 30 * KiB }, { seconds: 100, warmup: 5000, video: 'hd' });
    // The telemetry waits behind such a frame only now and then (one every half minute).
    expect(r.p90).toBeLessThan(300);
    expect(r.ages.filter((a) => a.age > 1000).length / r.ages.length).toBeLessThan(0.1);
    // One now and then: what the link carries is measured again.
    expect(r.frameShare).toBeGreaterThan(0);
    expect(r.frameShare).toBeLessThan(0.01);
    // A link fast enough for its frames gets them.
    const s = simulate({ down: 20, up: 10, rate: () => 50 * KiB }, { seconds: 70, warmup: 20_000, video: 'hd' });
    expect(s.frameShare).toBeGreaterThan(0.02);
  });

  it('a link that slows down is caught up with within seconds', () => {
    const r = simulate({ down: 20, up: 20, rate: (t) => (t < 25_000 ? Infinity : 50 * KiB) }, { seconds: 60 });
    const after = r.ages.filter((a) => a.t > 30_000).map((a) => a.age);
    expect(Math.max(...after)).toBeLessThan(1000);
    const around = r.ages.filter((a) => a.t >= 25_000 && a.t <= 30_000).map((a) => a.age);
    expect(Math.max(...around)).toBeLessThan(3500);
  });

  it('a stall of a far-away link is noticed a round trip and half a second after it began', () => {
    const r = simulate({ down: 1000, up: 10, rate: (t) => (t >= 40_000 && t < 44_000 ? 0 : Infinity) }, { seconds: 60 });
    const first = r.congestedAt.find((t) => t >= 40_000)!;
    expect(first - 40_000).toBeLessThan(1010 + 500 + 400);
  });

  it('a stalled link resumes with the latest data, not with what was waiting', () => {
    const r = simulate({ down: 20, up: 20, rate: (t) => (t >= 20_000 && t < 26_000 ? 0 : Infinity) }, { seconds: 40 });
    const stalled = r.ages.filter((a) => a.t >= 21_000 && a.t < 26_000).map((a) => a.age);
    expect(Math.min(...stalled)).toBeGreaterThan(900);
    const after = r.ages.filter((a) => a.t >= 27_000).map((a) => a.age);
    expect(Math.max(...after)).toBeLessThan(400);
  });

  it('a viewer whose page is busy for a moment is caught up with, nothing building up – and gets every telemetry sample', () => {
    for (const ms of [400, 900]) {
      const busy: [number, number][] = [];
      for (let t = 12_000; t < 60_000; t += 3000) busy.push([t, t + ms]);
      const r = simulate({ down: 30, up: 30, rate: () => 400 * KiB, busy }, { seconds: 60 });
      // (Kept back – only the latest – once the link has been congested for a while.)
      expect(r.telemetryShare).toBeGreaterThan(0.99);
      expect(r.max).toBeLessThan(ms + 1100);
    }
  });

  it('a page that takes long to show each frame gets as many as it shows – and every telemetry sample, new', () => {
    for (const [video, perFrameMs] of [
      ['sd', 60],
      ['hd', 100],
    ] as const) {
      const r = simulate({ down: 30, up: 30, rate: () => Infinity, perFrameMs }, { seconds: 60, video });
      expect(r.telemetryShare).toBeGreaterThan(0.99);
      expect(r.max).toBeLessThan(1000);
      // As many frames as the page shows (a frame each `perFrameMs` at most).
      expect(r.frameShare).toBeGreaterThan(0.6 * (1000 / perFrameMs) / (3 * (video === 'hd' ? 6 : 10)));
    }
  });

  it('HD video of several drones over a fast link: every frame (their frames that come at once fit in the queue)', () => {
    const r = simulate({ down: 30, up: 30, rate: () => Infinity }, { seconds: 40, video: 'hd' });
    expect(r.frameShare).toBeGreaterThan(0.95);
    expect(r.max).toBeLessThan(300);
  });

  it('a link kept full for minutes keeps its queue short (the round trip is measured again)', () => {
    // 300 KiB/s, 60 ms out, HD video asking for more than it carries – for six minutes.
    const r = simulate({ down: 60, up: 20, rate: () => 300 * KiB }, { seconds: 360, video: 'hd' });
    const last = r.ages.filter((a) => a.t > 300_000).map((a) => a.age);
    expect(Math.max(...last)).toBeLessThan(800);
    // Measured again and again: the round trip is the link's (60 + 20 ms), not its queue's.
    expect(r.flow.rttMin).toBeLessThan(150);
    expect(r.frameShare).toBeGreaterThan(0.12);
  });
});
