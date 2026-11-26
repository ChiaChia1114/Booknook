/**
 * Clocks of the live link: how far a remote clock (a drone's, the cloud's) is ahead of ours, so that
 * the times it reports can be told in ours – and how old what it reports is.
 */

/**
 * How fast two clocks may drift apart (ms per ms): 500 ppm, the most an NTP-disciplined clock is
 * slewed by. A bound learnt earlier is widened by it as it ages.
 */
export const CLOCK_DRIFT = 5e-4;

/**
 * The offset of a remote clock to ours (remote − local, ms) as an upper bound. An exchange sent at
 * `sent` (our clock), answered with the remote clock's time `remote` and received at `recv` tells
 * that the offset lies between `remote − recv` and `remote − sent` (the answer was given between
 * the two). The lowest upper bound is kept – widened by `CLOCK_DRIFT` as it ages, so that it keeps
 * holding until a better one comes; one that a newer exchange shows to be wrong (the remote clock
 * was set forward, or ours back) is replaced.
 *
 * A remote time converted with it (`remoteTime − bound`) is never later than when it really was –
 * what is reported is never taken for newer than it is, however slow the way back (uplink) is; it is
 * at most as much older as the exchange's way out took. (The midpoint of the exchange, as NTP takes
 * it, would be wrong by half of any difference between the two ways: data coming over a congested
 * uplink would look newer than it is.)
 */
export class ClockBound {
  private hi: number | null = null;
  private at = 0;

  constructor(private readonly drift = CLOCK_DRIFT) {}

  /** An exchange: sent at `sent`, answered at the remote time `remote`, received at `recv`. */
  sample(sent: number, remote: number, recv: number): void {
    if (!Number.isFinite(sent) || !Number.isFinite(remote) || !Number.isFinite(recv) || recv < sent) return;
    const hi = remote - sent;
    const lo = remote - recv;
    const cur = this.bound(recv);
    // A lower bound above the bound kept: that one is wrong now (1 ms for times in whole ms).
    if (cur === null || hi <= cur || lo > cur + 1) {
      this.hi = hi;
      this.at = recv;
    }
  }

  /** The upper bound of the offset at `now` (our clock), or null while no exchange was made. */
  bound(now: number): number | null {
    return this.hi === null ? null : this.hi + this.drift * Math.max(0, now - this.at);
  }

  /** Forgets what was learnt. */
  reset(): void {
    this.hi = null;
    this.at = 0;
  }
}
