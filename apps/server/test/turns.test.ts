/**
 * The cloud's work in turns of the event loop (lib/turns.ts): one turn at a time, the loop's other
 * work (the live connections) between any two; members in turn; the loop busy half the time at
 * most while work waits; at most two long computations of one member at once.
 */
import { describe, expect, it } from 'vitest';
import { JOBS_PER_OWNER, Turns, jobSlots, workOwner } from '../src/lib/turns';
import { runSliced, type Steps } from '../src/lib/slice';

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
