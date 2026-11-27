import type { FastifyReply } from 'fastify';
import { HttpError } from '../lib/errors';

/**
 * What each member may still ask now: `perS` requests accrue a second, `burst` at most (a token
 * bucket per member). Members whose budget has refilled are forgotten.
 */
export class RequestBudgets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private taken = 0;

  constructor(
    readonly perS: number,
    readonly burst: number,
  ) {}

  /** Takes one of `who`'s requests: false once their budget is spent (`perS` ≤ 0: no limit). */
  take(who: string, now = Date.now()): boolean {
    if (this.perS <= 0) return true;
    if (++this.taken % 1000 === 0) this.forget(now);
    let b = this.buckets.get(who);
    if (!b) {
      b = { tokens: this.burst, at: now };
      this.buckets.set(who, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + (Math.max(0, now - b.at) * this.perS) / 1000);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens--;
    return true;
  }

  private forget(now: number): void {
    const refilled = (this.burst / this.perS) * 1000;
    for (const [who, b] of this.buckets) if (now - b.at >= refilled) this.buckets.delete(who);
  }
}

/** How long a request refused for coming too often waits for its answer (s). */
export const TOO_MANY_WAIT_S = 1;

/**
 * Refuses a request that came too often (429, with Retry-After) – answered only after
 * `TOO_MANY_WAIT_S`: a client sending requests as fast as they are answered then sends few, and
 * the cloud spends next to nothing on them.
 */
export async function refuseTooMany(reply: FastifyReply, message: string): Promise<never> {
  await new Promise((resolve) => setTimeout(resolve, TOO_MANY_WAIT_S * 1000));
  reply.header('retry-after', String(TOO_MANY_WAIT_S));
  throw new HttpError(429, 'too_many_requests', message);
}
