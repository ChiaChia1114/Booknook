/**
 * Flow control of a live viewer that acknowledges what it receives (`ack`): the cloud sends it no
 * more than its link carries, so that what it gets is never late because of what was sent before
 * it – whether the link is slow, far away (a long round trip) or both.
 *
 * From the acknowledgements the cloud learns the link's shortest round trip and its delivery rate –
 * also from each video frame: its round trip beyond the shortest is how long it held the link up at
 * most, so that its bytes tell the link's rate however far away it is (what is in flight alone
 * would tell no more than a frame a round trip on a far link). Video frames go only while what is
 * in flight stays within what the link delivers in a round trip plus a short queue
 * (`FLOW_QUEUE_MS` at its rate, at most `FLOW_QUEUE_BYTES` – or the frames of all its streams that
 * come at once; at least one frame at a time): the queue in front of the viewer – in the cloud's
 * and the network's buffers, invisible to the socket – stays a fraction of a second however far
 * away the viewer is. On a link that takes its frames a while (`FRAME_TAKES_MS`), a frame goes only
 * once what was sent before it has (nearly) left the link's queue, as its rate tells: what follows
 * never waits behind two frames. A frame that would hold the link up longer than `MAX_FRAME_MS` at
 * its rate is not sent (what follows it would wait that long) – but one now and then. Video is
 * paced at the delivery rate (a quarter faster), so that a window refilled at once – after a pause
 * – never queues up in front of what follows.
 *
 * Should a message still wait for its acknowledgement `FLOW_LAG_MS` after it should have come –
 * once it left the link's queue at the link's rate (what was sent before it going first) and the
 * round trip passed – the link slowed down, became farther or stalled (or the page is busy): it is
 * congested. Then no video goes, and – once that lasts `HOLD_AFTER_MS` – of what only matters at
 * its latest (a drone's telemetry, its detections) only the latest of each is kept back until the
 * acknowledgements catch up. What was in flight is waited for (no more video until it is
 * acknowledged); the rate at which it came meanwhile is the link's rate from then on – should it
 * have come slower than it was sent (it waited in front of the link; what came as it was sent, at
 * the pace it was made, tells only that pace) – (a link that slowed down is sent no more than it
 * carries now: what was on its way as it slowed down passes at its new rate first – about a round
 * trip of video – and no new queue builds up behind it), and the round trip is measured again: a
 * link that became farther starts again (its video comes back within a few round trips).
 *
 * Like BBR (Cardwell et al., "BBR: Congestion-Based Congestion Control", ACM Queue 2016): the
 * delivery rate is the highest measured lately; starting, what is in flight may double each round
 * trip while the window holds video back and the rate grows – until it stops growing or a queue
 * builds up (the round trip grows, as HyStart tells the end of TCP's slow start); and the round
 * trip is measured again (video paused until the queue drained) when a short one was not seen for
 * a while – so that a queue is never taken for the link's own round trip.
 */

/**
 * A viewer's link may queue this much beyond its round trip: this long at its delivery rate (ms),
 * and never more than `FLOW_QUEUE_BYTES` (what a link that suddenly became much slower has to
 * deliver before it is caught up with) – or than the frames of all its video streams that come at
 * once, should they be more.
 */
export const FLOW_QUEUE_MS = 250;
export const FLOW_QUEUE_BYTES = 64 * 1024;
/** What only matters at its latest is kept back once the link has been congested this long (ms; a page busy for a moment gets it all). */
export const HOLD_AFTER_MS = 1000;
/** A message may come this long after it should have before the link is congested (ms). */
export const FLOW_LAG_MS = 500;
/**
 * A video frame that would hold the link up longer than this at its rate is not sent (ms) – but
 * one every `VIDEO_PROBE_MS`, so that a link that became faster again is seen to.
 */
export const MAX_FRAME_MS = 1500;
const VIDEO_PROBE_MS = 30_000;
/** What may be in flight before the link's delivery rate is known (bytes). */
const INITIAL_WINDOW = 64 * 1024;
/** The round trip assumed before one is measured (ms). */
const INITIAL_RTT_MS = 3000;
/** The longest a message's queue at the link's rate is waited for beyond the round trip (ms). */
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
/** A round trip measured again this much longer (and by a quarter) than before: the link became farther (ms). */
const FARTHER_MS = 50;
/** The viewer acknowledges at most this often (ms): what it acknowledges may have come this much earlier. */
const ACK_SPACING_MS = 50;
/** Frames that hold the link up longer than this (ms) are not let wait behind each other. */
const FRAME_TAKES_MS = 2 * ACK_SPACING_MS;

interface Mark {
  /** The count of messages sent, this one included. */
  n: number;
  at: number;
  /** Bytes sent, this message included. */
  bytes: number;
  /** Bytes acknowledged, and when last, as this message was sent (its delivery-rate sample; what was in flight). */
  delivered: number;
  deliveredAt: number;
  /** Its own size (bytes). */
  size: number;
  /** When it leaves the link's queue, as the link's rate tells (what was sent before it going first). */
  dep: number;
  frame: boolean;
}

/** A congestion: what was in flight is waited for, the rate it is delivered at measured. */
interface Episode {
  /** When it began. */
  since: number;
  /** Bytes sent as it began: once they are acknowledged, the rate they came at since the first acknowledgement is the link's. */
  target: number;
  /** When the last of them was sent. */
  targetAt: number;
  /** The first acknowledgement meanwhile: when, of how many bytes, and when what it acknowledged last was sent. */
  firstAck: { at: number; bytes: number; sentAt: number } | null;
  rate: number | null;
  /** The shortest round trip seen meanwhile. */
  minRtt: number;
}

/** What was in flight as a congestion began must be this much (bytes) for the rate it comes at to tell the link's. */
const MEASURED_BYTES = 16 * 1024;

export class FlowControl {
  private acked: number;
  private ackedBytes = 0;
  private sentBytes = 0;
  private lastSent: number;
  private lastAckAt: number;
  /** When the latest message sent leaves the link's queue (see `Mark.dep`). */
  private lastDep = 0;
  /** The message from which on the link's queue (as its rate tells) has not been empty: their times hang together. */
  private queuedFrom = Infinity;
  /**
   * The latest frame acknowledged held the link up a while (`FRAME_TAKES_MS`, well beyond the
   * spacing of acknowledgements): the rate measured is the link's – not a bound of a faster one.
   */
  private framesTake = false;
  /** When the latest video frame was sent. */
  private lastFrameAt = -Infinity;
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
  /** The rate is the link's – measured while it was kept busy (not only what little was sent). */
  private rateKnown = false;
  /** Delivery-rate samples are taken of the messages after this one only (those before were in flight as it was measured again). */
  private sampleFrom: number;
  /** Starting: what is in flight may double each round trip until the delivery rate stops growing. */
  private startup = true;
  private fullRate = 0;
  private fullRounds = 0;
  private roundEnd: number;
  private limitedInRound = false;
  /**
   * The window held video back in the round before, and the delivery rate grew in it (starting,
   * the queue may then be as large as what fills the link: what is in flight doubles).
   */
  private limitedLastRound = false;
  private grewLastRound = true;
  /** The shortest round trip of this round, and of the one before. */
  private roundRtt = Infinity;
  private lastRoundRtt = Infinity;
  /**
   * Measuring the round trip again: video waits until `drainUntil` is acknowledged; `probe` is then
   * the message measured (the next one that is not a frame), `probeBefore` the round trip before.
   */
  private drainUntil: number | null = null;
  private probe: number | 'next' | null = null;
  private probeAt = 0;
  private probeBefore = Infinity;
  private episode: Episode | null = null;
  /** Video is paced: bytes it may send now (they accrue at the delivery rate, a little faster). */
  private tokens = 0;
  private tokensAt: number;
  /** Frames offered lately, and the most of them that came at once (bytes; within `PACING_BURST_MS`) – kept for a window. */
  private readonly offered: { at: number; bytes: number }[] = [];
  private burst = 0;
  private burstAt = 0;
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
    this.sampleFrom = sent;
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
   * starting, while the window holds video back, up to as much again (what is in flight doubles each
   * round trip), but never more than `STARTUP_QUEUE_MS` at the rate measured; else `FLOW_QUEUE_MS`
   * (at most `FLOW_QUEUE_BYTES`) – no more is in flight than video needs, should the link slow down.
   * The queue holds a frame at least: the link is never left idle between two frames.
   */
  window(): number {
    const rate = this.rate;
    if (!rate || !Number.isFinite(this.rttMin)) return INITIAL_WINDOW;
    const pipe = rate * this.rttMin;
    const growing = this.startup && this.limitedLastRound && this.grewLastRound;
    const queue = growing ? Math.min(pipe, rate * STARTUP_QUEUE_MS) : Math.min(rate * FLOW_QUEUE_MS, Math.max(FLOW_QUEUE_BYTES, this.burst));
    return pipe + Math.max(this.frameBytes, queue);
  }

  /** The `n`-th message of the connection, of `bytes`, was sent at `now`. */
  sent(n: number, bytes: number, now: number, frame = false): void {
    this.lastSent = n;
    this.sentBytes += bytes;
    const rate = this.rate;
    // (While the link's rate is not known, it may wait for `MAX_DELIVERY_MS`.)
    let dep = now + MAX_DELIVERY_MS;
    if (rate > 0) {
      if (this.lastDep <= now) this.queuedFrom = n;
      dep = this.lastDep = Math.max(now, this.lastDep) + bytes / rate;
    }
    this.marks.push({ n, at: now, bytes: this.sentBytes, delivered: this.ackedBytes, deliveredAt: this.lastAckAt, size: bytes, dep, frame });
    if (frame) {
      this.frames++;
      this.frameBytes = bytes;
      this.lastFrameAt = now;
    }
    if (this.probe === 'next' && !frame) {
      this.probe = n;
      this.probeAt = now;
    }
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
    let minRtt = Infinity;
    const frames: Mark[] = [];
    while (this.marks.length && this.marks[0]!.n <= n) {
      last = this.marks.shift()!;
      if (last.frame) {
        this.frames--;
        frames.push(last);
      }
      minRtt = Math.min(minRtt, now - last.at);
    }
    // How long a frame held the link up at most: its round trip beyond the link's shortest (what it
    // waited for, and its acknowledgement's spacing, included) – the link carries its bytes in that
    // time at least, however far away it is (a frame alone in flight tells no more than its bytes
    // in a round trip otherwise).
    const base = Math.min(this.rttMin, minRtt);
    if (Number.isFinite(base) && !this.episode) {
      for (const f of frames) {
        if (f.n <= this.sampleFrom) continue;
        const held = Math.max(0, now - f.at - base);
        this.framesTake = held > FRAME_TAKES_MS;
        this.rateCur = Math.max(this.rateCur, f.size / (held + ACK_SPACING_MS));
      }
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
      if (dt > 0 && last.n > this.sampleFrom && !this.episode) this.rateCur = Math.max(this.rateCur, (this.ackedBytes - last.delivered) / dt);
      // It left the link's queue a round trip ago at the latest: what is reckoned to wait there yet
      // is no more than that tells (a rate measured low before kept no queue that is not there) –
      // should it have queued with what waits there now (what was sent once the queue was empty
      // waits for nothing before).
      if (last.n >= this.queuedFrom && Number.isFinite(this.rttMin) && last.dep > now - this.rttMin && this.lastDep > now) {
        this.lastDep = Math.max(now, this.lastDep - (last.dep - (now - this.rttMin)));
      }
      const rtt = now - last.at;
      if (!Number.isFinite(this.rttMin) || rtt <= this.rttMin * (1 + RTT_CONFIRM_FRACTION) + RTT_CONFIRM_MS) {
        this.rttMin = Math.min(this.rttMin, rtt);
        this.rttMinAt = now;
      }
      this.roundRtt = Math.min(this.roundRtt, rtt);
    }
    this.lastAckAt = now;
    if (this.episode && last) this.measureEpisode(now, minRtt, last.at);
    // Measuring the round trip again: drained, the next message measures it; once that one is
    // acknowledged, its round trip is the link's.
    if (this.drainUntil !== null && n >= this.drainUntil) {
      this.drainUntil = null;
      if (this.episode) this.endEpisode(now);
      this.probe = 'next';
    }
    if (typeof this.probe === 'number' && n >= this.probe) {
      const rtt = now - this.probeAt;
      // Farther than before: started again (the link's rate is the same, what fills it more).
      if (Number.isFinite(this.probeBefore) && rtt > this.probeBefore * 1.25 + FARTHER_MS) {
        this.startup = true;
        this.fullRate = 0;
        this.fullRounds = 0;
        this.grewLastRound = true;
        this.lastRoundRtt = Infinity;
        this.roundRtt = Infinity;
        this.roundEnd = this.lastSent;
      }
      this.rttMin = rtt;
      this.rttMinAt = now;
      this.probe = null;
      this.probeBefore = Infinity;
    }
    // A round trip passed: starting ends once a queue builds up (the shortest round trip of the
    // round grew) or the delivery rate stopped growing while the window held video back.
    if (n >= this.roundEnd) {
      if (this.startup && Number.isFinite(this.roundRtt) && Number.isFinite(this.lastRoundRtt) && this.roundRtt > this.lastRoundRtt + Math.max(STARTUP_RTT_GROWTH_MS, this.lastRoundRtt / 4)) {
        this.startup = false;
      }
      // A round in which the window held video back kept the link busy: its rate is the link's.
      if (this.limitedInRound) this.rateKnown = true;
      if (this.startup) {
        // Starting ends once the rate stopped growing for three rounds the window held video back in.
        const grew = this.rate >= this.fullRate * 1.25;
        if (grew) {
          this.fullRate = this.rate;
          this.fullRounds = 0;
        } else if (this.limitedInRound && ++this.fullRounds >= 3) this.startup = false;
        this.grewLastRound = grew;
      }
      if (Number.isFinite(this.roundRtt)) this.lastRoundRtt = this.roundRtt;
      this.roundRtt = Infinity;
      this.limitedLastRound = this.limitedInRound;
      this.limitedInRound = false;
      this.roundEnd = this.lastSent;
    }
    if (this.drainUntil === null && this.probe === null && Number.isFinite(this.rttMin) && now - this.rttMinAt > WINDOW_MS) {
      this.drainUntil = this.lastSent;
      this.probeBefore = this.rttMin;
    }
  }

  /**
   * While congested: the rate at which what was in flight comes, from the first acknowledgement on
   * (what waited in front of the link kept it busy: it came at the link's rate).
   */
  private measureEpisode(now: number, minRtt: number, sentAt: number): void {
    const e = this.episode!;
    e.minRtt = Math.min(e.minRtt, minRtt);
    if (!e.firstAck) {
      e.firstAck = { at: now, bytes: this.ackedBytes, sentAt };
      return;
    }
    if (e.rate === null && this.ackedBytes >= e.target && now > e.firstAck.at) {
      const bytes = this.ackedBytes - e.firstAck.bytes;
      const took = now - e.firstAck.at;
      // Only what came slower than it was sent waited in front of the link (and came at its rate):
      // what came as it was sent (as it was made – telemetry alone) tells no more than that pace.
      const sentIn = Math.max(0, e.targetAt - e.firstAck.sentAt);
      e.rate = bytes >= MEASURED_BYTES && took > sentIn * 1.1 + 20 ? bytes / took : 0;
    }
  }

  /**
   * What was in flight as the link became congested is acknowledged: the link carries what it
   * delivered meanwhile (never more than before) – the rate measured before is forgotten, and so
   * are the samples of what was in flight. Until the round trip is measured again, it is taken to
   * be at least the shortest seen meanwhile (a link that became farther is not taken for congested
   * again).
   */
  private endEpisode(now: number): void {
    const e = this.episode!;
    this.episode = null;
    // Enough was in flight to tell the link's rate – once the rate is known, it came no faster than
    // before (a page that was busy, a link that stalled, take up again at the rate before).
    if (e.rate) {
      const rate = this.rateKnown && !this.startup ? Math.min(this.rate, e.rate) : e.rate;
      this.rateKnown = true;
      this.rateCur = rate;
      this.ratePrev = rate;
      this.rateWindowAt = now;
      this.limitedInWindow = false;
    }
    this.sampleFrom = this.lastSent;
    if (Number.isFinite(e.minRtt) && (!Number.isFinite(this.rttMin) || e.minRtt > this.rttMin)) {
      this.rttMin = e.minRtt;
      this.rttMinAt = now;
    }
  }

  /**
   * A message waits too long for its acknowledgement: the link slowed down, became farther or
   * stalled (or the page is busy) – what is in flight is waited for, and the link measured again.
   */
  congested(now: number): boolean {
    const oldest = this.marks[0];
    if (!oldest) return false;
    const base = Number.isFinite(this.rttMin) ? this.rttMin : INITIAL_RTT_MS;
    // When it should have been acknowledged at the latest: once it left the link's queue (what was
    // sent before it, and itself, at the link's rate – waited for `MAX_DELIVERY_MS` at most) and
    // the round trip passed.
    const congested = now > Math.min(oldest.dep, oldest.at + MAX_DELIVERY_MS) + base + FLOW_LAG_MS;
    if (congested && !this.episode) {
      this.startup = false;
      this.episode = { since: now, target: this.sentBytes, targetAt: this.marks.at(-1)?.at ?? now, firstAck: null, rate: null, minRtt: Infinity };
      this.drainUntil = this.lastSent;
      this.probe = null;
      if (!Number.isFinite(this.probeBefore)) this.probeBefore = this.rttMin;
    }
    return congested;
  }

  /** Whether what only matters at its latest is kept back now: the link has been congested for `HOLD_AFTER_MS`. */
  holdsLatest(now: number): boolean {
    return this.congested(now) && !!this.episode && now - this.episode.since >= HOLD_AFTER_MS;
  }

  /**
   * Whether a video frame of `bytes` may go now: not while congested or measuring the round trip;
   * not one that would hold the link up longer than `MAX_FRAME_MS`; paced at the delivery rate
   * (starting, twice; then a quarter more – so that a refilled window never arrives at once); within
   * the window (or the only frame in flight).
   */
  allowsFrame(bytes: number, now: number): boolean {
    // The frames that come at once (one of each stream) fit in the queue.
    this.offered.push({ at: now, bytes });
    while (this.offered[0]!.at < now - PACING_BURST_MS) this.offered.shift();
    const burst = this.offered.reduce((sum, f) => sum + f.bytes, 0);
    if (burst >= this.burst || now - this.burstAt > WINDOW_MS) {
      this.burst = burst;
      this.burstAt = now;
    }
    if (this.congested(now) || this.drainUntil !== null || this.probe === 'next') return false;
    const rate = this.rate;
    if (this.rateKnown && rate > 0 && bytes / rate > MAX_FRAME_MS && now - this.lastFrameAt < VIDEO_PROBE_MS) return false;
    // A frame goes once what was sent before it has (nearly) left the link's queue at its rate: what
    // follows never waits behind more than one frame and a short queue – on a link that takes its
    // frames a while (on a faster one the window and the pacing do: its rate is not known so well).
    if (this.framesTake && rate > 0 && this.lastDep - now > FLOW_QUEUE_MS) return false;
    if (rate > 0) {
      const gain = this.startup ? 2 : 1.25;
      this.tokens = Math.min(this.tokens + (now - this.tokensAt) * rate * gain, Math.max(2 * bytes, this.burst, rate * PACING_BURST_MS));
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
