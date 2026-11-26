/**
 * Flow control of a live viewer that acknowledges what it receives (`ack`): the cloud sends it no
 * more than its link carries, so that what it gets is never late because of what was sent before
 * it – whether the link is slow, far away (a long round trip) or both.
 *
 * From the acknowledgements the cloud learns the link's shortest round trip and its delivery rate.
 * Video frames go only while what is in flight stays within what the link delivers in a round trip
 * plus a short queue (`FLOW_QUEUE_MS` at its rate, at most `FLOW_QUEUE_BYTES`; at least one frame
 * at a time): the queue in front of the viewer – in the cloud's and the network's buffers,
 * invisible to the socket – stays a fraction of a second however far away the viewer is. Should a
 * message still wait for its acknowledgement `FLOW_LAG_MS` after it should have come – after what
 * was in flight before it and the message itself were delivered at the link's rate, and the round
 * trip – the link slowed down or stalled: it is
 * congested. Then no video goes, and of what only matters at its latest (a drone's telemetry, its
 * detections) only the latest of each is kept back until the acknowledgements catch up. Video is
 * also paced at the delivery rate (a quarter faster), so that a window refilled at once – after a
 * pause – never queues up in front of what follows.
 *
 * Like BBR (Cardwell et al., "BBR: Congestion-Based Congestion Control", ACM Queue 2016): the
 * delivery rate is the highest measured lately; starting, what is in flight may double each round
 * trip until the rate stops growing or a queue builds up (the round trip grows, as HyStart tells
 * the end of TCP's slow start); and the round trip is measured again (video paused until the queue
 * drained) when a short one was not seen for a while – so that a queue is never taken for the
 * link's own round trip.
 */

/**
 * A viewer's link may queue this much beyond its round trip: this long at its delivery rate (ms),
 * and never more than `FLOW_QUEUE_BYTES` (what a link that suddenly became much slower has to
 * deliver before it is caught up with).
 */
export const FLOW_QUEUE_MS = 250;
export const FLOW_QUEUE_BYTES = 64 * 1024;
/** A message may come this long after it should have before the link is congested (ms). */
export const FLOW_LAG_MS = 500;
/** What may be in flight before the link's delivery rate is known (bytes). */
const INITIAL_WINDOW = 64 * 1024;
/** The round trip assumed before one is measured (ms). */
const INITIAL_RTT_MS = 3000;
/** The longest a message's delivery at the link's rate is waited for beyond the round trip (ms). */
const MAX_DELIVERY_MS = 2000;
/** The delivery rate is the highest of this window and the one before; the round trip is measured again after it. */
const WINDOW_MS = 10_000;
/** A round trip within this of the shortest confirms it (ms, and a fraction of it). */
const RTT_CONFIRM_MS = 5;
const RTT_CONFIRM_FRACTION = 0.05;
/** Starting ends once the shortest round trip of a round grows by this much, or by a quarter, on the round before (ms). */
const STARTUP_RTT_GROWTH_MS = 50;
/** The longest queue allowed while starting, at the rate measured (ms). */
const STARTUP_QUEUE_MS = 1000;
/** Video paced at the delivery rate may go in bursts of this long at it (ms; two frames at least). */
const PACING_BURST_MS = 100;

interface Mark {
  /** The count of messages sent, this one included. */
  n: number;
  at: number;
  /** Bytes sent, this message included. */
  bytes: number;
  /** Bytes acknowledged, and when last, as this message was sent (its delivery-rate sample; what was in flight). */
  delivered: number;
  deliveredAt: number;
  frame: boolean;
}

export class FlowControl {
  private acked: number;
  private ackedBytes = 0;
  private sentBytes = 0;
  private lastSent: number;
  private lastAckAt: number;
  private readonly marks: Mark[] = [];
  private frames = 0;
  /** The size of the latest video frame sent (bytes). */
  private frameBytes = 0;
  /** Shortest round trip lately (ms), and when a round trip confirmed it last. */
  rttMin = Infinity;
  private rttMinAt = 0;
  /** Delivery rate (bytes/ms): the highest of the current and the previous window. */
  private rateCur = 0;
  private ratePrev = 0;
  private rateWindowAt: number;
  private limitedInWindow = false;
  /** The latest delivery-rate samples. */
  private readonly recent: { at: number; rate: number }[] = [];
  /** Starting: what is in flight may double each round trip until the delivery rate stops growing. */
  private startup = true;
  private fullRate = 0;
  private fullRounds = 0;
  private roundEnd: number;
  private limitedInRound = false;
  /** The shortest round trip of this round, and of the one before. */
  private roundRtt = Infinity;
  private lastRoundRtt = Infinity;
  /** Measuring the round trip again: video waits until `drainUntil` is acknowledged; `probe` is then the message measured. */
  private drainUntil: number | null = null;
  private probe: number | 'next' | null = null;
  private wasCongested = false;
  /** Video is paced: bytes it may send now (they accrue at the delivery rate, a little faster). */
  private tokens = 0;
  private tokensAt: number;
  /** The latest of each kind of message kept back while the link is congested. */
  readonly held = new Map<string, string>();

  /** `sent`: the messages sent on the connection before flow control started. */
  constructor(now: number, sent: number) {
    this.acked = sent;
    this.lastSent = sent;
    this.lastAckAt = now;
    this.rateWindowAt = now;
    this.roundEnd = sent;
    this.tokensAt = now;
  }

  /** The delivery rate (bytes/ms; 0: not known yet). */
  get rate(): number {
    return Math.max(this.rateCur, this.ratePrev);
  }

  /** Bytes sent and not acknowledged yet. */
  get inflight(): number {
    return this.sentBytes - this.ackedBytes;
  }

  /**
   * What may be in flight (bytes): what the link delivers in its round trip, and a short queue –
   * starting, up to as much again (what is in flight doubles each round trip), but never more than
   * `STARTUP_QUEUE_MS` at the rate measured; then `FLOW_QUEUE_MS` (at most `FLOW_QUEUE_BYTES`). The
   * queue holds a frame at least: the link is never left idle between two frames.
   */
  window(): number {
    const rate = this.rate;
    if (!rate || !Number.isFinite(this.rttMin)) return INITIAL_WINDOW;
    const pipe = rate * this.rttMin;
    const queue = this.startup ? Math.min(pipe, rate * STARTUP_QUEUE_MS) : Math.min(rate * FLOW_QUEUE_MS, FLOW_QUEUE_BYTES);
    return pipe + Math.max(this.frameBytes, queue);
  }

  /** The `n`-th message of the connection, of `bytes`, was sent at `now`. */
  sent(n: number, bytes: number, now: number, frame = false): void {
    this.lastSent = n;
    this.sentBytes += bytes;
    this.marks.push({ n, at: now, bytes: this.sentBytes, delivered: this.ackedBytes, deliveredAt: this.lastAckAt, frame });
    if (frame) {
      this.frames++;
      this.frameBytes = bytes;
    }
    if (this.probe === 'next') this.probe = n;
    // A viewer that stops acknowledging keeps its oldest message waiting (its link stays congested);
    // the marks after it are thinned out.
    if (this.marks.length > 4096) {
      this.marks.splice(1, 2048);
      this.frames = this.marks.reduce((k, m) => k + (m.frame ? 1 : 0), 0);
    }
  }

  /** The viewer acknowledged the first `n` messages at `now` (n: at most what was sent). */
  ack(n: number, now: number): void {
    if (n < this.acked) return;
    this.acked = n;
    let last: Mark | undefined;
    let probeAt: number | null = null;
    while (this.marks.length && this.marks[0]!.n <= n) {
      last = this.marks.shift()!;
      if (last.frame) this.frames--;
      if (typeof this.probe === 'number' && last.n === this.probe) probeAt = last.at;
    }
    if (last) {
      this.ackedBytes = last.bytes;
      if (now - this.rateWindowAt > WINDOW_MS) {
        // A window in which the link never held video back says nothing new of its rate.
        this.ratePrev = this.limitedInWindow ? this.rateCur : Math.max(this.rateCur, this.ratePrev);
        this.rateCur = 0;
        this.rateWindowAt = now;
        this.limitedInWindow = false;
      }
      const dt = now - last.deliveredAt;
      if (dt > 0) {
        const rate = (this.ackedBytes - last.delivered) / dt;
        this.rateCur = Math.max(this.rateCur, rate);
        this.recent.push({ at: now, rate });
        if (this.recent.length > 32) this.recent.shift();
      }
      const rtt = now - last.at;
      if (!Number.isFinite(this.rttMin) || rtt <= this.rttMin * (1 + RTT_CONFIRM_FRACTION) + RTT_CONFIRM_MS) {
        this.rttMin = Math.min(this.rttMin, rtt);
        this.rttMinAt = now;
      }
      this.roundRtt = Math.min(this.roundRtt, rtt);
    }
    this.lastAckAt = now;
    // Measuring the round trip again: drained, the next message measures it; once that one is
    // acknowledged, its round trip is the link's.
    if (this.drainUntil !== null && n >= this.drainUntil) {
      this.drainUntil = null;
      this.probe = 'next';
    }
    if (typeof this.probe === 'number' && n >= this.probe) {
      if (probeAt !== null) {
        this.rttMin = now - probeAt;
        this.rttMinAt = now;
      }
      this.probe = null;
    }
    // A round trip passed: starting ends once a queue builds up (the shortest round trip of the
    // round grew) or the delivery rate stopped growing while the window held video back.
    if (n >= this.roundEnd) {
      if (this.startup && Number.isFinite(this.roundRtt) && Number.isFinite(this.lastRoundRtt) && this.roundRtt > this.lastRoundRtt + Math.max(STARTUP_RTT_GROWTH_MS, this.lastRoundRtt / 4)) {
        this.startup = false;
      }
      if (this.startup && this.limitedInRound) {
        if (this.rate >= this.fullRate * 1.25) {
          this.fullRate = this.rate;
          this.fullRounds = 0;
        } else if (++this.fullRounds >= 3) this.startup = false;
      }
      if (Number.isFinite(this.roundRtt)) this.lastRoundRtt = this.roundRtt;
      this.roundRtt = Infinity;
      this.limitedInRound = false;
      this.roundEnd = this.lastSent;
    }
    if (this.drainUntil === null && this.probe === null && Number.isFinite(this.rttMin) && now - this.rttMinAt > WINDOW_MS) {
      this.drainUntil = this.lastSent;
    }
  }

  /**
   * A message waits too long for its acknowledgement: the link slowed down or stalled. (As it
   * becomes congested, the delivery rate is taken to be the one measured over the latest round
   * trips: the link may have become slower than it was.)
   */
  congested(now: number): boolean {
    const oldest = this.marks[0];
    if (!oldest) return (this.wasCongested = false);
    const base = Number.isFinite(this.rttMin) ? this.rttMin : INITIAL_RTT_MS;
    const rate = this.rate;
    // When it should have been acknowledged at the latest: after what was in flight as it was
    // sent, and itself, were delivered at the link's rate, and the round trip.
    const delivery = rate > 0 ? Math.min(MAX_DELIVERY_MS, (oldest.bytes - oldest.delivered) / rate) : 0;
    const congested = now - oldest.at > base + delivery + FLOW_LAG_MS;
    if (congested && !this.wasCongested) {
      this.startup = false;
      const since = now - Math.max(200, 2 * base);
      const measured = this.recent.reduce((m, s) => (s.at >= since ? Math.max(m, s.rate) : m), 0);
      if (measured > 0) this.rateCur = this.ratePrev = Math.min(rate, measured);
    }
    this.wasCongested = congested;
    return congested;
  }

  /**
   * Whether a video frame of `bytes` may go now: not while congested or measuring the round trip;
   * paced at the delivery rate (starting, twice; then a quarter more – so that a refilled window
   * never arrives at once); within the window (or the only frame in flight).
   */
  allowsFrame(bytes: number, now: number): boolean {
    if (this.congested(now) || this.drainUntil !== null) return false;
    const rate = this.rate;
    if (rate > 0) {
      const gain = this.startup ? 2 : 1.25;
      this.tokens = Math.min(this.tokens + (now - this.tokensAt) * rate * gain, Math.max(2 * bytes, rate * PACING_BURST_MS));
      this.tokensAt = now;
    }
    if (this.frames === 0 || ((rate === 0 || this.tokens >= bytes) && this.inflight + bytes <= this.window())) {
      if (rate > 0) this.tokens -= bytes;
      return true;
    }
    this.limitedInRound = true;
    this.limitedInWindow = true;
    return false;
  }
}
