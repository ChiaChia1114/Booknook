/**
 * Turns of the event loop for the cloud's work – API requests and long computations – so that the
 * live connections (drones and viewers: commands, telemetry, video) never wait long for it, however
 * much there is and whoever asks for it:
 *
 * - One turn at a time: a request's handler, the reading of a request's body and every slice of a
 *   long computation (see `runSliced`) each run in a turn of their own, a turn of the event loop
 *   apart – the live connections' messages are handled between any two turns.
 * - Half the loop's time at most: while work waits, the loop rests before the next turn until it
 *   has been busy for no more than `WORK_SHARE` of the time (what the live connections needed
 *   meanwhile counted too), so their messages mostly find it free.
 * - Members in turn: whoever has work waiting gets a turn after each other who has (round robin) –
 *   one member's many requests do not hold up another's.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

/** Whose work runs: a member's (`user:…`), an address's (`ip:…`, not signed in) or the cloud's own. */
export const workOwner = new AsyncLocalStorage<string>();
export const CLOUD_WORK = 'cloud';
/**
 * The cloud's work kept apart from its other background work (post-flight processing, feeds…), so
 * that it never waits behind it: reading the airspace that checks need, and what the live monitor
 * checks drones against.
 */
export const AIRSPACE_WORK = 'airspace';
export const MONITOR_WORK = 'monitor';
/** The owner of a member's work. */
export const userWork = (userId: string): string => `user:${userId}`;

export function ownerOfWork(): string {
  return workOwner.getStore() ?? CLOUD_WORK;
}

/** Share of the loop's time that work keeps it busy at most while more waits. */
export const WORK_SHARE = 0.5;
/** Longest rest before a turn (ms): work always goes on. */
const MAX_REST_MS = 50;
/** Rest an idle loop saves up (ms): a few short turns after a quiet time run without rests. */
const MAX_CREDIT_MS = 10;

export class Turns {
  /** Who waits for a turn: each owner's waiters in order; owners in turn. */
  private readonly queues = new Map<string, (() => void)[]>();
  private readonly order: string[] = [];
  private scheduled = false;
  private since = performance.eventLoopUtilization();
  /** Rest owed (ms): what the loop was busy beyond the share since the turns began. */
  private debt = 0;
  /** Turns given (tests). */
  given = 0;

  /** Resolves in a turn of the loop of its own, after the turns of others waiting before (members in turn). */
  next(owner: string = ownerOfWork()): Promise<void> {
    return new Promise<void>((resolve) => {
      const q = this.queues.get(owner);
      if (q) q.push(resolve);
      else {
        this.queues.set(owner, [resolve]);
        this.order.push(owner);
      }
      this.schedule();
    });
  }

  /** Turns waiting – of one owner, or of all. */
  waiting(owner?: string): number {
    if (owner !== undefined) return this.queues.get(owner)?.length ?? 0;
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }

  private schedule(): void {
    if (this.scheduled || this.order.length === 0) return;
    this.scheduled = true;
    // The next turn of the loop: the live connections' messages that came meanwhile go first.
    setImmediate(this.tick);
  }

  private readonly tick = (): void => {
    // How busy the loop was since the last turn began (that turn and all that came between):
    // beyond the share, it rests first – the live connections have it meanwhile.
    const d = performance.eventLoopUtilization(this.since);
    this.debt = Math.max(-MAX_CREDIT_MS, this.debt + d.active / WORK_SHARE - (d.active + d.idle));
    if (this.debt >= 1) {
      const rest = Math.min(this.debt, MAX_REST_MS);
      this.debt -= rest;
      setTimeout(this.grant, rest);
    } else this.grant();
  };

  private readonly grant = (): void => {
    this.scheduled = false;
    const owner = this.order.shift();
    if (owner === undefined) return;
    const q = this.queues.get(owner)!;
    const resolve = q.shift()!;
    if (q.length) this.order.push(owner);
    else this.queues.delete(owner);
    this.since = performance.eventLoopUtilization();
    this.given++;
    resolve();
    this.schedule();
  };
}

/** The turns of this process. */
export const turns = new Turns();

/** Long computations of one owner going on at once: more wait for one to end (memory stays bounded). */
export const JOBS_PER_OWNER = 2;

class JobSlots {
  private readonly busy = new Map<string, number>();
  private readonly waiting = new Map<string, (() => void)[]>();

  /** A slot of the owner's; the function returned gives it back (once). */
  async take(owner: string): Promise<() => void> {
    const n = this.busy.get(owner) ?? 0;
    if (n < JOBS_PER_OWNER) this.busy.set(owner, n + 1);
    else
      await new Promise<void>((resolve) => {
        const w = this.waiting.get(owner);
        if (w) w.push(resolve);
        else this.waiting.set(owner, [resolve]);
      });
    let given = false;
    return () => {
      if (given) return;
      given = true;
      const w = this.waiting.get(owner);
      const next = w?.shift();
      if (w && w.length === 0) this.waiting.delete(owner);
      // Handed on to the owner's next job, or freed.
      if (next) next();
      else {
        const m = (this.busy.get(owner) ?? 1) - 1;
        if (m > 0) this.busy.set(owner, m);
        else this.busy.delete(owner);
      }
    };
  }
}

export const jobSlots = new JobSlots();

/**
 * What must not interleave – deciding on a flight authorisation against the reservations of
 * others – one at a time, owners in turn: the owner whose turn came longest ago goes first, so one
 * member's many requests never keep another's waiting behind all of them.
 */
export class FairLock {
  private held = false;
  /** Owners in the order of their turns (the next first). */
  private readonly queues = new Map<string, (() => void)[]>();

  /** Resolves with the function that gives the lock back (once) – the lock is held until then. */
  acquire(owner: string = ownerOfWork()): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        this.held = true;
        let given = false;
        resolve(() => {
          if (given) return;
          given = true;
          this.held = false;
          this.next();
        });
      };
      if (!this.held && this.queues.size === 0) grant();
      else {
        const q = this.queues.get(owner);
        if (q) q.push(grant);
        else this.queues.set(owner, [grant]);
      }
    });
  }

  private next(): void {
    const first = this.queues.entries().next();
    if (first.done) return;
    const [owner, q] = first.value;
    const grant = q.shift()!;
    // The owner's next waits behind the others now waiting.
    this.queues.delete(owner);
    if (q.length) this.queues.set(owner, q);
    grant();
  }
}

/** Decisions on flight authorisations (checked against every reservation, then recorded). */
export const decisions = new FairLock();
