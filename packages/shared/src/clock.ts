/**
 * Clocks of the live link: how far a remote clock (a drone's, the cloud's) is ahead of ours, so that
 * the times it reports can be told in ours – and how old what it reports is.
 */

/**
 * How fast two clocks may drift apart (ms per ms): 500 ppm, the most an NTP-disciplined clock is
 * slewed by. A bound learnt earlier is widened by it as it ages.
 */
export const CLOCK_DRIFT = 5e-4;
/** Exchanges older than this are forgotten once a newer one came (ms). */
export const CLOCK_WINDOW_MS = 10_000;
/**
 * An exchange whose upper bound is this much above the bound kept (ms): the remote clock may have
 * been set forward (or ours back) – only the exchanges from then on hold.
 */
export const CLOCK_STEP_MS = 25;
/** Exchanges kept at most. */
const MAX_EXCHANGES = 64;

interface Exchange {
  /** Upper bound of the offset it tells (null: its answer carried no time of the remote clock). */
  hi: number | null;
  /** Its round trip (ms). */
  rtt: number;
  /** When its answer was received (our clock). */
  at: number;
}

/**
 * The offset of a remote clock to ours (remote − local, ms) as an upper bound. An exchange sent at
 * `sent` (our clock), answered with the remote clock's time `remote` and received at `recv` tells
 * that the offset lies between `remote − recv` and `remote − sent` (the answer was given between
 * the two). The lowest upper bound of the latest exchanges (`CLOCK_WINDOW_MS`) is kept – each
 * widened by `CLOCK_DRIFT` as it ages, so that it keeps holding until a better one comes. Should a
 * newer exchange show the remote clock set forward (or ours back) – its lower bound above the bound
 * kept, or its upper bound more than `CLOCK_STEP_MS` above it – only it holds from then on.
 *
 * A remote time converted with it (`remoteTime − bound`) is never later than when it really was –
 * what is reported is never taken for newer than it is, however slow the way back (uplink) is; it is
 * at most as much older as the exchange's way out took. (The midpoint of the exchange, as NTP takes
 * it, would be wrong by half of any difference between the two ways: data coming over a congested
 * uplink would look newer than it is.) Only a remote clock set forward by less than `CLOCK_STEP_MS`
 * – or set forward after the latest exchange, until the next one – goes unseen; what it reports may
 * then look newer by as much.
 */
export class ClockBound {
  private exchanges: Exchange[] = [];

  constructor(
    private readonly drift = CLOCK_DRIFT,
    private readonly windowMs = CLOCK_WINDOW_MS,
  ) {}

  /** An exchange: sent at `sent`, answered at the remote time `remote`, received at `recv`. */
  sample(sent: number, remote: number, recv: number): void {
    if (!Number.isFinite(sent) || !Number.isFinite(remote) || !Number.isFinite(recv) || recv < sent) return;
    const hi = remote - sent;
    const lo = remote - recv;
    const cur = this.bound(recv);
    // A lower bound above the bound kept (1 ms for times in whole ms), or an upper bound well above
    // it: the remote clock was (or may have been) set forward – the exchanges before do not hold.
    if (cur !== null && (lo > cur + 1 || hi > cur + CLOCK_STEP_MS)) this.exchanges = [];
    this.add({ hi, rtt: recv - sent, at: recv });
  }

  /** An exchange whose answer carried no time of the remote clock: its round trip only. */
  roundTrip(sent: number, recv: number): void {
    if (!Number.isFinite(sent) || !Number.isFinite(recv) || recv < sent) return;
    this.add({ hi: null, rtt: recv - sent, at: recv });
  }

  private add(e: Exchange): void {
    this.exchanges.push(e);
    while (this.exchanges.length > 1 && (e.at - this.exchanges[0]!.at > this.windowMs || this.exchanges.length > MAX_EXCHANGES)) this.exchanges.shift();
  }

  /** The upper bound of the offset at `now` (our clock), or null while no exchange told one. */
  bound(now: number): number | null {
    let b: number | null = null;
    for (const e of this.exchanges) {
      if (e.hi === null) continue;
      const hi = e.hi + this.drift * Math.max(0, now - e.at);
      if (b === null || hi < b) b = hi;
    }
    return b;
  }

  /** The shortest round trip of the latest exchanges (ms), or null while none was made. */
  get rtt(): number | null {
    let r: number | null = null;
    for (const e of this.exchanges) if (r === null || e.rtt < r) r = e.rtt;
    return r;
  }

  /**
   * Our clock was set by `delta` ms (`delta` < 0: back): the exchanges are told in it as it counts
   * now (the remote clock is `delta` less ahead of it).
   */
  shiftLocal(delta: number): void {
    if (!Number.isFinite(delta)) return;
    for (const e of this.exchanges) {
      if (e.hi !== null) e.hi -= delta;
      e.at += delta;
    }
  }

  /** Forgets what was learnt. */
  reset(): void {
    this.exchanges = [];
  }
}
