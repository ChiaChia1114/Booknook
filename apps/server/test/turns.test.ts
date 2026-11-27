/**
 * The cloud's work in turns of the event loop (lib/turns.ts): one turn at a time, the loop's other
 * work (the live connections) between any two; members in turn; the loop busy half the time at
 * most while work waits; at most two long computations of one member at once.
 */
import { describe, expect, it } from 'vitest';
import { FairLock, JOBS_PER_OWNER, Turns, jobSlots, workOwner } from '../src/lib/turns';
import { runAtOnce, runSliced, type Steps } from '../src/lib/slice';
import { hasLongList, jsonPartsSteps, partsBody } from '../src/lib/json-parts';

const busy = (ms: number) => {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Work.
  }
};

describe('turns of the event loop', () => {
  it('one turn at a time, a turn of the loop apart: what else the loop has to do is done between two', async () => {
    const turns = new Turns();
    const order: string[] = [];
    const jobs = ['first', 'second', 'third'].map(async (name) => {
      await turns.next('member-a');
      order.push(name);
    });
    // Something the loop has to do meanwhile (a live connection's message).
    setImmediate(() => order.push('live'));
    await Promise.all(jobs);
    expect(order[0]).toBe('first');
    expect(order.indexOf('live')).toBeLessThan(order.indexOf('second'));
    expect(order.slice(-2)).toEqual(['second', 'third']);
  });

  it('members in turn: one member\'s many requests do not hold up another\'s', async () => {
    const turns = new Turns();
    const order: string[] = [];
    const ask = async (who: string, name: string) => {
      await turns.next(who);
      order.push(name);
    };
    await Promise.all([ask('a', 'a1'), ask('a', 'a2'), ask('a', 'a3'), ask('a', 'a4'), ask('b', 'b1'), ask('c', 'c1')]);
    expect(order).toEqual(['a1', 'b1', 'c1', 'a2', 'a3', 'a4']);
  });

  it('while work waits, the loop is busy half the time at most', async () => {
    const turns = new Turns();
    const start = performance.now();
    let worked = 0;
    await Promise.all(
      Array.from({ length: 30 }, async () => {
        await turns.next('flooding member');
        const t = performance.now();
        busy(4);
        worked += performance.now() - t;
      }),
    );
    const took = performance.now() - start;
    expect(worked).toBeGreaterThanOrEqual(110);
    // Rests between the turns (the live connections have the loop meanwhile).
    expect(took).toBeGreaterThan(1.7 * worked);
  });

  it('a long computation runs in slices, each a turn of its own; at most two of one member at once', async () => {
    let running = 0;
    let most = 0;
    const steps = function* (): Steps<number> {
      running++;
      most = Math.max(most, running);
      for (let i = 0; i < 6; i++) {
        busy(3);
        yield;
      }
      running--;
      return 1;
    };
    const order: string[] = [];
    const other = workOwner.run('user:other', async () => {
      await runSliced(steps());
      order.push('other');
    });
    const own = workOwner.run('user:busy', () =>
      Promise.all(
        Array.from({ length: 5 }, async () => {
          await runSliced(steps());
          order.push('busy');
        }),
      ),
    );
    await Promise.all([own, other]);
    // The busy member's five went two at a time; the other's alongside – not after them.
    expect(JOBS_PER_OWNER).toBe(2);
    expect(most).toBeLessThanOrEqual(JOBS_PER_OWNER + 1);
    expect(order.indexOf('other')).toBeLessThan(2);
    // Slots given back: a new computation of the busy member starts at once.
    const release = await jobSlots.take('user:busy');
    release();
  });
});

describe('long answers written in parts (lib/json-parts.ts)', () => {
  const written = (value: unknown) => runAtOnce(jsonPartsSteps(value));
  it('the parts make up exactly what JSON.stringify writes', () => {
    const sample = (i: number) => ({ t: i * 100, lat: 25 + i * 1e-6, alt: i % 7 === 0 ? null : i / 3, name: `p"${i}\u2028`, skip: undefined, f: () => 1, tags: i % 3 ? [] : ['a', i] });
    const values: unknown[] = [
      [],
      [1],
      Array.from({ length: 1000 }, (_, i) => sample(i)),
      { samples: Array.from({ length: 700 }, (_, i) => sample(i)), one: [sample(1)], none: [], at: new Date(0), gone: undefined, n: 3, text: 'x' },
      // Items each longer than a part: one at a time.
      Array.from({ length: 5 }, (_, i) => ({ i, plan: 'w'.repeat(100_000) })),
      { rooms: Array.from({ length: 300 }, (_, i) => [i, i * 2, [i]]) },
      new Date(5),
      { toJSON: () => ({ replaced: [1, 2, 3] }) },
      null,
      'text',
      42,
      [undefined, () => 1, Symbol('s'), NaN, Infinity],
    ];
    for (const v of values) expect(written(v).join('')).toBe(JSON.stringify(v));
  });

  it('a few hundred items, or about 64 K characters, per part', () => {
    const many = written(Array.from({ length: 2000 }, (_, i) => ({ i })));
    expect(many.length).toBeGreaterThan(8);
    for (const p of many) expect(p.split('{').length - 1).toBeLessThanOrEqual(256);
    const large = written(Array.from({ length: 40 }, (_, i) => ({ i, plan: 'w'.repeat(10_000) })));
    for (const p of large) expect(p.length).toBeLessThan(65_536 + 10_100);
    expect(large.length).toBeGreaterThan(5);
  });

  it('long lists, and only those, are written in parts; a long answer is sent as a stream', () => {
    expect(hasLongList(Array.from({ length: 65 }, () => 0))).toBe(true);
    expect(hasLongList(Array.from({ length: 64 }, () => 0))).toBe(false);
    expect(hasLongList({ items: Array.from({ length: 65 }, () => 0) })).toBe(true);
    expect(hasLongList({ a: 1, b: [1, 2] })).toBe(false);
    expect(hasLongList('x'.repeat(10_000))).toBe(false);
    expect(hasLongList(Buffer.alloc(100))).toBe(false);
    expect(typeof partsBody(['[', '1', ']'])).toBe('string');
    expect(typeof partsBody(['[', 'x'.repeat(300_000), ']'])).not.toBe('string');
  });
});

describe('decisions one at a time (FairLock)', () => {
  it('held by one at a time; owners in turn – one owner\'s many never keep another\'s waiting behind all of them', async () => {
    const lock = new FairLock();
    const order: string[] = [];
    let holding = 0;
    let most = 0;
    const job = async (owner: string, name: string) => {
      const release = await lock.acquire(owner);
      holding++;
      most = Math.max(most, holding);
      order.push(name);
      await new Promise((r) => setTimeout(r, 2));
      holding--;
      release();
      release();
    };
    await Promise.all([job('a', 'a1'), job('a', 'a2'), job('a', 'a3'), job('a', 'a4'), job('b', 'b1'), job('b', 'b2')]);
    expect(most).toBe(1);
    expect(order).toEqual(['a1', 'a2', 'b1', 'a3', 'b2', 'a4']);
  });
});
