/**
 * Athena Live client: one WebSocket per organisation carrying telemetry, status,
 * events, acks, video frames and latency probes for every drone of the organisation.
 */
import {
  ClockBound,
  LIVE_DATA_MAX_AGE_MS,
  decodeLiveVideoFrame,
  type AckResult,
  type CommandName,
  type CommandParams,
  type DetectedAircraft,
  type DetectedObjectDto,
  type LiveDownMessage,
  type LiveDroneState,
  type LiveUpMessage,
  type NotificationDto,
  type OnlineUser,
  type SwarmDto,
  type Telemetry,
  type VideoQuality,
  type Role,
} from '@athena-sky/shared';

export interface LiveEvent {
  droneId: string;
  t: number;
  level: 'info' | 'warning' | 'error' | 'critical';
  message: string;
}

/** Manned traffic a drone's ADS-B receiver reports – `t` (when it was reported) in this browser's clock. */
export interface TrafficView extends DetectedAircraft {
  /** Not reported for a while (drawn as old; it is removed once it is not reported for a minute). */
  old: boolean;
}

export interface DroneView extends LiveDroneState {
  track: [number, number][];
  frameUrl: string | null;
  /** When the frame shown was captured (this browser's clock). */
  frameAt: number;
  /** The frame is new enough to be shown as live video (captured less than `VIDEO_MAX_AGE_MS` ago). */
  frameLive: boolean;
  /** Round trip browser → cloud → drone (ms). */
  rttMs: number | null;
  /** When the latest telemetry sample was taken (this browser's clock; 0: none yet, or not known when). */
  dataAt: number;
  /**
   * The drone is online but nothing new came from it for `DATA_MAX_AGE_MS` – or nothing at all yet:
   * its link or the viewer's is slow or stalled (or it sends no telemetry). What is shown of it is
   * not live, and nothing that needs it is offered.
   */
  late: boolean;
  /**
   * Late, and the cloud has nothing newer of it either: it is the drone's own link that is slow or
   * stalled. (When the cloud has newer data, the viewer's link holds it up: the link is delayed.)
   */
  lateDrone: boolean;
  events: LiveEvent[];
  traffic: TrafficView[];
  firmwareProgress: { status: string; progress: number; message?: string } | null;
  /** Objects tracked by AI vision in the drone's video. */
  detections: DetectedObjectDto[];
  detectionsAt: number;
}

export interface LiveSnapshot {
  connected: boolean;
  /**
   * Whether the organisation's drones and the viewer's rights have been received (the first
   * snapshot): until then the pages say they are connecting – never "no drones" or "watch only".
   * It stays true over a reconnection (the drones last received are still shown).
   */
  synced: boolean;
  /**
   * Whether what is shown is live: connected, and the drones received on this connection. False
   * from when the link is lost until the drones are received again – the pages then say the link
   * is lost (the data shown is as of `lostAt`) and offer nothing that needs it.
   */
  current: boolean;
  /**
   * When the link was lost, or since when what it brings is late (ms since 1970) – null while it is
   * up or being made the first time.
   */
  lostAt: number | null;
  /**
   * The link is open but what it brings comes late (it is slow or stalled): what is shown is not
   * live (`current` is false) until it keeps up again – or it is made again.
   */
  delayed: boolean;
  /** Round trip of the link (browser → cloud → browser, ms) as last measured. */
  linkRttMs: number | null;
  /**
   * Counts the connections whose drones were received: what is only pushed (notifications, swarm
   * operations) is loaded again when it changes – nothing pushed while the link was down is lost.
   */
  epoch: number;
  /** The last attempt to connect failed (it is tried again). */
  unreachable: boolean;
  canControl: boolean;
  /** The viewer's role in the organisation, as the server last said. */
  role: Role | null;
  userId: string | null;
  drones: Record<string, DroneView>;
  users: OnlineUser[];
  /** Notifications pushed since the page loaded (newest first, updated when resolved). */
  notifications: NotificationDto[];
  /** Swarm operations updated since the page loaded, by id. */
  swarms: Record<string, SwarmDto>;
  version: number;
}

const TRACK_LEN = 600;
/** Acknowledgements of what was received are sent at most this often (flow control). */
const ACK_INTERVAL_MS = 50;
/** Link probes (round trip, clock offset to the cloud) and checks of how old the data is. */
const PROBE_INTERVAL_MS = 1000;
/** The link counts as delayed when a probe takes longer than this. */
export const LINK_LAG_MS = 3000;
/** A link whose probe gets no answer for this long is made again. */
const LINK_STALL_MS = 15_000;
/** An online drone with nothing newer than this is shown as late (the cloud sends it nothing that sets it moving). */
export const DATA_MAX_AGE_MS = LIVE_DATA_MAX_AGE_MS;
/** A video frame older than this is not shown as live. */
export const VIDEO_MAX_AGE_MS = 3000;
/**
 * A drone with nothing newer than this is asked about with the next probe: if the cloud has newer
 * data of it, the link holds it up (the link is late, not the drone).
 */
const LATE_ASK_MS = 2000;
/** Drones whose round trip is measured each round (every 3 s). */
const PINGS_PER_ROUND = 20;
/** Traffic not reported for this long is drawn as old, and removed after `TRAFFIC_MAX_AGE_MS`. */
export const TRAFFIC_OLD_MS = 15_000;
export const TRAFFIC_MAX_AGE_MS = 60_000;
/**
 * This browser's clock set back by more than this (ms) – at once or in steps – moves the times noted
 * by it along.
 */
const CLOCK_SET_BACK_MS = 500;
/** How fast this browser's clock may fall behind its monotonic clock unseen (ms per ms): drift, kept in step by the system. */
const CLOCK_DRIFT = 0.001;

/** Online with nothing new for `DATA_MAX_AGE_MS` – or nothing at all yet (or not known when it was taken). */
const isLate = (d: Pick<DroneView, 'online' | 'dataAt'>, now: number): boolean => d.online && (d.dataAt <= 0 || now - d.dataAt > DATA_MAX_AGE_MS);

export class LiveClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private pending = new Map<string, { resolve: (r: { result: AckResult; message?: string }) => void; timer: number }>();
  /** Each drone's round-trip probe waiting for its answer (one at a time), and where the next round starts. */
  private dronePings = new Map<string, { id: string; sent: number }>();
  private pingRound = 0;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private probeTimer: number | null = null;
  /** Messages received on the current connection, and the count last acknowledged. */
  private received = 0;
  private ackedCount = 0;
  private lastAckAt = 0;
  private ackTimer: number | null = null;
  /** Link probes waiting for their answer (performance and wall-clock time they were sent). */
  private probes = new Map<string, { perf: number; wall: number }>();
  private probeSeq = 0;
  private lastProbeRtt: number | null = null;
  /** The drones were received on the current connection. */
  private socketSynced = false;
  /** The current connection's hello came (the one that answers its start). */
  private helloSeen = false;
  /**
   * How far the cloud's clock is ahead of this browser's, as an upper bound (see `ClockBound`):
   * times of the cloud converted with it are never later than they were – what comes late over a
   * slow link never looks newer than it is.
   */
  private cloudClock = new ClockBound();
  /** When the current connection was started (no answer on it was given before). */
  private connectStartedAt = 0;
  /** This browser's clock less its monotonic clock, at its most forward lately (see `now`), and when that was read. */
  private skew: number | null = null;
  private skewAt = 0;
  /** When the cloud's latest telemetry of the drones asked about was taken (this browser's clock). */
  private cloudData = new Map<string, number | null>();
  /** Re-checks how old what is shown is as soon as something becomes too old. */
  private expiryTimer: number | null = null;
  private expiryAt = Infinity;
  private closed = false;
  private notifyScheduled = false;
  private videoWanted = new Map<string, VideoQuality>();
  private videoOwners = new Map<string, Map<string, VideoQuality>>();
  private backoff = 1000;
  /**
   * The server ended the connection because the viewer is no longer a member (`revoked`: it is
   * not tried again), or a connection could not be made (`unreachable`).
   */
  onTrouble: ((kind: 'revoked' | 'unreachable') => void) | null = null;
  state: LiveSnapshot = {
    connected: false,
    synced: false,
    current: false,
    lostAt: null,
    delayed: false,
    linkRttMs: null,
    epoch: 0,
    unreachable: false,
    canControl: false,
    role: null,
    userId: null,
    drones: {},
    users: [],
    notifications: [],
    swarms: {},
    version: 0,
  };

  constructor(readonly orgId: string) {
    this.connect();
    this.pingTimer = window.setInterval(() => this.pingAll(), 3000);
    this.probeTimer = window.setInterval(() => this.tick(), PROBE_INTERVAL_MS);
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): LiveSnapshot => this.state;

  private emit(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    requestAnimationFrame(() => {
      this.notifyScheduled = false;
      this.state = { ...this.state, version: this.state.version + 1 };
      for (const l of this.listeners) l();
    });
  }

  private connect(): void {
    if (this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/api/v2/live?org=${encodeURIComponent(this.orgId)}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.connectStartedAt = this.now();
    this.received = 0;
    this.ackedCount = 0;
    this.probes.clear();
    this.dronePings.clear();
    this.cloudData.clear();
    this.lastProbeRtt = null;
    this.socketSynced = false;
    this.helloSeen = false;
    let opened = false;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      opened = true;
      this.backoff = 1000;
      this.state.connected = true;
      this.state.unreachable = false;
      // Acknowledging what is received (flow control): the cloud then sends no more than the
      // link carries without delay.
      this.send({ type: 'ack', n: 0 });
      for (const [droneId, quality] of this.videoWanted) this.send({ type: 'video', droneId, enabled: true, quality });
      this.probe();
      this.emit();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      // This browser's clock set back since it was last read: what was noted by it moves along
      // before anything noted is read (when a probe was sent, when the connection was started).
      this.now();
      this.received++;
      this.scheduleAck();
      if (typeof ev.data === 'string') this.onMessage(JSON.parse(ev.data) as LiveDownMessage);
      else this.onFrame(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.onSocketClosed(opened, ev.code);
    };
  }

  /** The connection ended (or was given up as stalled): the data shown stops being live. */
  private onSocketClosed(opened: boolean, code: number): void {
    this.ws = null;
    this.socketSynced = false;
    this.probes.clear();
    if (this.ackTimer !== null) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    this.state.connected = false;
    this.state.delayed = false;
    this.state.linkRttMs = null;
    // It is kept, as it was then, until the drones come again.
    if (this.state.current) {
      this.state.current = false;
      this.state.lostAt = this.now();
    }
    if (!opened) this.state.unreachable = true;
    this.emit();
    if (code === 4403) {
      // Removed from the organisation: trying again would only be refused.
      this.closed = true;
      this.onTrouble?.('revoked');
      return;
    }
    if (!opened) this.onTrouble?.('unreachable');
    if (!this.closed) {
      this.reconnectTimer = window.setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(15_000, this.backoff * 2);
    }
  }

  // ----- Flow control and the link's health ------------------------------------------------

  private scheduleAck(): void {
    if (performance.now() - this.lastAckAt >= ACK_INTERVAL_MS) return this.sendAck();
    if (this.ackTimer === null) {
      this.ackTimer = window.setTimeout(() => {
        this.ackTimer = null;
        this.sendAck();
      }, ACK_INTERVAL_MS);
    }
  }

  private sendAck(): void {
    if (this.received === this.ackedCount) return;
    this.lastAckAt = performance.now();
    if (this.send({ type: 'ack', n: this.received })) this.ackedCount = this.received;
  }

  /**
   * This browser's clock (ms since 1970). Should it have been set back since it was last read – its
   * monotonic clock tells – the times noted by it are moved along (what is shown stays as old as it
   * is: nothing looks newer for it); set forward (or the computer slept), they are kept – what is
   * shown only looks older.
   */
  private now(): number {
    const wall = Date.now();
    const mono = performance.now();
    const skew = wall - mono;
    if (this.skew === null) this.skew = skew;
    else {
      // Measured from the clock as it was at its most forward lately (less a drift of 1 ms a
      // second): set back in one step or in several small ones, it is seen once it is
      // CLOCK_SET_BACK_MS; set forward (or asleep), it is followed at once.
      const ref = this.skew - CLOCK_DRIFT * (mono - this.skewAt);
      if (skew - ref < -CLOCK_SET_BACK_MS) {
        this.clockSetBack(skew - ref);
        this.skew = skew;
      } else this.skew = Math.max(skew, ref);
    }
    this.skewAt = mono;
    return wall;
  }

  /** This browser's clock was set back by `-delta` ms: what was noted by it is told as it counts now. */
  private clockSetBack(delta: number): void {
    const by = (t: number) => (t > 0 ? t + delta : t);
    this.cloudClock.shiftLocal(delta);
    this.connectStartedAt = by(this.connectStartedAt);
    if (this.state.lostAt !== null) this.state.lostAt = by(this.state.lostAt);
    for (const p of this.probes.values()) p.wall = by(p.wall);
    for (const [id, at] of this.cloudData) if (typeof at === 'number') this.cloudData.set(id, by(at));
    // (In place: a message being handled holds the drone's view.)
    for (const d of Object.values(this.state.drones)) {
      d.dataAt = by(d.dataAt);
      d.frameAt = by(d.frameAt);
      d.detectionsAt = by(d.detectionsAt);
      d.traffic = d.traffic.map((a) => ({ ...a, t: by(a.t) }));
    }
    this.state.drones = { ...this.state.drones };
    // Checked again by the clock as it counts now.
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.expiryAt = Infinity;
    window.setTimeout(() => this.refresh(), 0);
    this.emit();
  }

  /**
   * A time of the cloud's clock in this browser's – never later than it was; 0 (not known when)
   * while the cloud's clock is not known.
   */
  private localTime(cloudTime: number | null | undefined): number {
    const ahead = this.cloudClock.bound(this.now());
    return typeof cloudTime === 'number' && Number.isFinite(cloudTime) && ahead !== null ? cloudTime - ahead : 0;
  }

  /**
   * Probes the link (answered by the cloud at once) – asking when the cloud's latest telemetry of
   * the drones it has nothing new of was taken.
   */
  private probe(): void {
    if (this.ws?.readyState !== WebSocket.OPEN || this.probes.size >= 30) return;
    const id = `link-${++this.probeSeq}`;
    const now = this.now();
    const late = Object.values(this.state.drones)
      .filter((d) => d.online && (d.dataAt <= 0 || now - d.dataAt > LATE_ASK_MS))
      .map((d) => d.droneId);
    this.probes.set(id, { perf: performance.now(), wall: now });
    this.send({ type: 'ping', id, t: now, ...(late.length ? { late } : {}) });
  }

  private onProbeAnswer(p: { perf: number; wall: number }, serverTime: number, dataAt: Record<string, number | null> | undefined): void {
    const rtt = performance.now() - p.perf;
    this.lastProbeRtt = rtt;
    this.state.linkRttMs = Math.round(rtt);
    this.cloudClock.sample(p.wall, serverTime, this.now());
    this.cloudData.clear();
    for (const [droneId, at] of Object.entries(dataAt ?? {})) this.cloudData.set(droneId, typeof at === 'number' ? this.localTime(at) : null);
    this.refresh();
  }

  /**
   * Since when this viewer's link holds up a drone's data: drones it has had nothing new of for
   * `DATA_MAX_AGE_MS` while the cloud has newer data of them – null when there is none.
   */
  private heldSince(): number | null {
    let since: number | null = null;
    for (const d of Object.values(this.state.drones)) {
      const cloud = this.cloudData.get(d.droneId);
      if (!d.online || !d.late || typeof cloud !== 'number' || cloud <= d.dataAt + 1000) continue;
      // Nothing of it came on this connection: held up since the connection was made.
      const from = d.dataAt > 0 ? d.dataAt : this.connectStartedAt;
      since = since === null ? from : Math.min(since, from);
    }
    return since;
  }

  /**
   * Whether the link keeps up: a probe that waits, or came back, longer than `LINK_LAG_MS` – or a
   * drone's data that the cloud has and the link holds up – makes what is shown late (not live)
   * until it keeps up again; a probe left unanswered for `LINK_STALL_MS` ends the connection (it is
   * made again).
   */
  private checkLink(): void {
    if (!this.ws || !this.state.connected) return;
    const now = performance.now();
    let oldest: { perf: number; wall: number } | null = null;
    for (const p of this.probes.values()) if (!oldest || p.perf < oldest.perf) oldest = p;
    const waiting = oldest ? now - oldest.perf : 0;
    if (oldest && waiting > LINK_STALL_MS) {
      const ws = this.ws;
      ws.onclose = null;
      ws.onmessage = null;
      ws.close(4000, 'link stalled');
      this.onSocketClosed(true, 4000);
      return;
    }
    const st = this.state;
    const slow = waiting > LINK_LAG_MS || (this.lastProbeRtt ?? 0) > LINK_LAG_MS;
    const held = this.heldSince();
    const late = slow || held !== null;
    if (late && !st.delayed && this.socketSynced) {
      st.delayed = true;
      if (st.current) {
        st.current = false;
        // What is shown is as of when the oldest probe still waiting (or the last one) was sent,
        // or as of the data held up.
        const since = slow ? (oldest ? oldest.wall : this.now() - (this.lastProbeRtt ?? 0)) : Infinity;
        st.lostAt = Math.min(since, held ?? Infinity);
      }
      this.emit();
    } else if (!late && st.delayed) {
      st.delayed = false;
      if (this.socketSynced) {
        st.current = true;
        st.lostAt = null;
      }
      this.emit();
    }
  }

  /** Every second: a link probe; how old what is shown is. */
  private tick(): void {
    this.probe();
    this.refresh();
  }

  /**
   * How old what is shown is: drones with nothing new for `DATA_MAX_AGE_MS` (late), frames older
   * than `VIDEO_MAX_AGE_MS` (not live), traffic not reported for a while (old, then removed) – at
   * the moment each becomes too old (a timer), not only when something else changes; and whether
   * the link keeps up.
   */
  private refresh(): void {
    const now = this.now();
    let changed = false;
    let next = Infinity;
    for (const d of Object.values(this.state.drones)) {
      let dChanged = false;
      const late = isLate(d, now);
      if (late !== d.late) {
        d.late = late;
        dChanged = true;
      }
      if (d.online && d.dataAt > 0 && !late) next = Math.min(next, d.dataAt + DATA_MAX_AGE_MS);
      const cloud = this.cloudData.get(d.droneId);
      const lateDrone = late && cloud !== undefined && !(typeof cloud === 'number' && cloud > d.dataAt + 1000);
      if (lateDrone !== d.lateDrone) {
        d.lateDrone = lateDrone;
        dChanged = true;
      }
      const frameLive = !!d.frameUrl && now - d.frameAt < VIDEO_MAX_AGE_MS;
      if (frameLive !== d.frameLive) {
        d.frameLive = frameLive;
        dChanged = true;
      }
      if (frameLive) next = Math.min(next, d.frameAt + VIDEO_MAX_AGE_MS);
      if (d.traffic.length) {
        const kept = d.traffic.filter((a) => now - a.t <= TRAFFIC_MAX_AGE_MS);
        let aged = kept.length !== d.traffic.length;
        const traffic = kept.map((a) => {
          const old = now - a.t > TRAFFIC_OLD_MS;
          next = Math.min(next, a.t + (old ? TRAFFIC_MAX_AGE_MS : TRAFFIC_OLD_MS) + 1);
          if (old === a.old) return a;
          aged = true;
          return { ...a, old };
        });
        if (aged) {
          d.traffic = traffic;
          dChanged = true;
        }
      }
      if (dChanged) {
        this.state.drones[d.droneId] = { ...d };
        changed = true;
      }
    }
    if (changed) {
      this.state.drones = { ...this.state.drones };
      this.emit();
    }
    this.checkLink();
    this.armExpiry(next);
  }

  /** Re-checks at `at` (this browser's clock) – the earliest moment something shown becomes too old. */
  private armExpiry(at: number): void {
    if (at >= this.expiryAt && this.expiryTimer !== null) return;
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.expiryAt = Infinity;
    if (!Number.isFinite(at) || this.closed) return;
    this.expiryAt = at;
    this.expiryTimer = window.setTimeout(() => {
      this.expiryTimer = null;
      this.expiryAt = Infinity;
      this.refresh();
    }, Math.max(0, at - this.now()) + 1);
  }

  /**
   * Ends the connection (another organisation was chosen, the page was left) – once the answers to
   * the commands sent on it have come (or timed out): what was sent is said as it ended.
   */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.probeTimer) clearInterval(this.probeTimer);
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    if (!this.pending.size) this.endSocket();
    for (const d of Object.values(this.state.drones)) if (d.frameUrl) URL.revokeObjectURL(d.frameUrl);
  }

  private endSocket(): void {
    if (this.ackTimer !== null) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    this.ws?.close();
  }

  private send(msg: LiveUpMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /**
   * A drone's state as received – `fresh` for the drones of a (new) connection: what was only
   * pushed before (traffic, firmware progress, detections, round trip) is not known any more.
   */
  private view(state: LiveDroneState, fresh = false): DroneView {
    const prev = this.state.drones[state.droneId];
    const dataAt = state.telemetry ? (state.telemetryAt != null ? this.localTime(state.telemetryAt) : (prev?.dataAt ?? 0)) : (prev?.dataAt ?? 0);
    const view: DroneView = {
      ...state,
      telemetry: state.telemetry ?? prev?.telemetry ?? null,
      track: prev?.track ?? [],
      frameUrl: prev?.frameUrl ?? null,
      frameAt: prev?.frameAt ?? 0,
      frameLive: prev?.frameLive ?? false,
      rttMs: fresh ? null : (prev?.rttMs ?? null),
      dataAt,
      late: false,
      lateDrone: prev?.lateDrone ?? false,
      events: prev?.events ?? [],
      traffic: fresh ? [] : (prev?.traffic ?? []),
      firmwareProgress: fresh ? null : (prev?.firmwareProgress ?? null),
      detections: state.ai?.enabled && !fresh ? (prev?.detections ?? []) : [],
      detectionsAt: fresh ? 0 : (prev?.detectionsAt ?? 0),
    };
    view.late = isLate(view, this.now());
    return view;
  }

  private pushEvent(droneId: string, e: Omit<LiveEvent, 'droneId'>): void {
    const d = this.state.drones[droneId];
    if (!d) return;
    d.events = [{ droneId, ...e }, ...d.events].slice(0, 100);
  }

  private onMessage(msg: LiveDownMessage): void {
    switch (msg.type) {
      case 'hello':
        this.state.canControl = msg.canControl;
        this.state.userId = msg.userId;
        this.state.role = msg.role ?? null;
        // A first bound of the cloud's clock (answered on this connection, so not before it was
        // started); the probes refine it. The hello sent again (the role changed) answers nothing:
        // the time it took since the start is no round trip.
        if (!this.helloSeen && typeof msg.serverTime === 'number') this.cloudClock.sample(this.connectStartedAt, msg.serverTime, this.now());
        this.helloSeen = true;
        break;
      case 'snapshot':
        this.state.drones = Object.fromEntries(msg.drones.map((d) => [d.droneId, this.view(d, true)]));
        this.state.users = msg.users;
        // Swarm operations are loaded again by the pages (a state pushed before may be overtaken by
        // one that was not pushed while the link was down); so are the notifications (`epoch`).
        this.state.swarms = {};
        this.state.epoch++;
        this.state.synced = true;
        this.socketSynced = true;
        if (!this.state.delayed) {
          this.state.current = true;
          this.state.lostAt = null;
        }
        break;
      case 'status': {
        const v = this.view(msg.drone);
        if (!msg.drone.online) {
          v.rttMs = null;
          if (v.frameUrl) URL.revokeObjectURL(v.frameUrl);
          v.frameUrl = null;
          v.frameLive = false;
        }
        this.state.drones = { ...this.state.drones, [msg.drone.droneId]: v };
        break;
      }
      case 'telemetry': {
        const d = this.state.drones[msg.droneId];
        if (!d) return;
        d.telemetry = msg.data;
        d.dataAt = this.localTime(msg.at);
        const wasLate = d.late;
        d.late = isLate(d, this.now());
        // Checked again as soon as it becomes too old (or the link keeps up again).
        if (wasLate && !d.late) this.refresh();
        else if (!d.late) this.armExpiry(d.dataAt + DATA_MAX_AGE_MS);
        if (msg.data.armed) {
          const last = d.track[d.track.length - 1];
          if (!last || Math.abs(last[0] - msg.data.lat) > 2e-6 || Math.abs(last[1] - msg.data.lon) > 2e-6) {
            d.track = [...d.track.slice(-TRACK_LEN), [msg.data.lat, msg.data.lon]];
          }
        }
        break;
      }
      case 'event':
        this.pushEvent(msg.droneId, { t: msg.t, level: msg.level, message: msg.message });
        break;
      case 'ack': {
        const p = this.pending.get(msg.requestId);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg.requestId);
          p.resolve({ result: msg.result, message: msg.message });
          if (this.closed && !this.pending.size) this.endSocket();
        }
        this.pushEvent(msg.droneId, {
          t: this.now(),
          level: msg.result === 'accepted' || msg.result === 'completed' || msg.result === 'in_progress' ? 'info' : 'warning',
          message: `${msg.command}: ${msg.result}${msg.message ? ` – ${msg.message}` : ''}`,
        });
        break;
      }
      case 'control': {
        const d = this.state.drones[msg.droneId];
        if (d) d.controller = msg.controller;
        break;
      }
      case 'flight': {
        const d = this.state.drones[msg.droneId];
        if (d) {
          d.flightId = msg.state === 'started' ? msg.flightId : null;
          if (msg.state === 'started') d.track = [];
          this.pushEvent(msg.droneId, { t: this.now(), level: 'info', message: msg.state === 'started' ? 'Flight recording started' : 'Flight recorded' });
        }
        break;
      }
      case 'mission_progress': {
        const d = this.state.drones[msg.droneId];
        if (d?.mission) d.mission = { ...d.mission, seq: msg.seq, total: msg.total };
        break;
      }
      case 'firmware_progress': {
        const d = this.state.drones[msg.droneId];
        if (d) d.firmwareProgress = { status: msg.status, progress: msg.progress, message: msg.message };
        break;
      }
      case 'adsb': {
        const d = this.state.drones[msg.droneId];
        if (d) {
          const now = this.now();
          // Aged by when each aircraft was reported (in this browser's clock).
          d.traffic = msg.aircraft
            .map((a) => {
              const t = Math.min(now, this.localTime(a.t));
              return { ...a, t, old: now - t > TRAFFIC_OLD_MS };
            })
            .filter((a) => now - a.t <= TRAFFIC_MAX_AGE_MS);
          for (const a of d.traffic) this.armExpiry(a.t + (a.old ? TRAFFIC_MAX_AGE_MS : TRAFFIC_OLD_MS) + 1);
        }
        break;
      }
      case 'users':
        this.state.users = msg.users;
        break;
      case 'pong': {
        const probe = this.probes.get(msg.id);
        if (probe) {
          this.probes.delete(msg.id);
          this.onProbeAnswer(probe, msg.serverTime, msg.dataAt);
          break;
        }
        const droneId = msg.id.split('|')[1];
        const ping = droneId ? this.dronePings.get(droneId) : undefined;
        if (droneId && ping?.id === msg.id) {
          this.dronePings.delete(droneId);
          const d = this.state.drones[droneId];
          // Browser → cloud and back, plus cloud → drone and back (as the cloud measures it).
          if (d) d.rttMs = msg.droneRttMs !== undefined ? Math.round(performance.now() - ping.sent + msg.droneRttMs) : null;
        }
        break;
      }
      case 'notification': {
        const n = msg.notification;
        const rest = this.state.notifications.filter((x) => x.id !== n.id);
        this.state.notifications = [n, ...rest].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
        break;
      }
      case 'swarm':
        this.state.swarms = { ...this.state.swarms, [msg.swarm.id]: msg.swarm };
        break;
      case 'detections': {
        const d = this.state.drones[msg.droneId];
        if (d) {
          d.detections = msg.objects;
          d.detectionsAt = this.now();
        }
        break;
      }
      case 'error':
        break;
    }
    this.emit();
  }

  private onFrame(buf: Uint8Array): void {
    // Closing (waiting only for the answers to its commands): no more video.
    if (this.closed) return;
    const f = decodeLiveVideoFrame(buf);
    if (!f) return;
    const d = this.state.drones[f.droneId];
    if (!d) return;
    const url = URL.createObjectURL(new Blob([f.jpeg as BlobPart], { type: 'image/jpeg' }));
    if (d.frameUrl) URL.revokeObjectURL(d.frameUrl);
    d.frameUrl = url;
    // Its capture time (in the cloud's clock): a frame that comes late is not shown as live – nor
    // one that becomes too old while nothing newer comes.
    const now = this.now();
    d.frameAt = Math.min(now, this.localTime(f.ts));
    d.frameLive = now - d.frameAt < VIDEO_MAX_AGE_MS;
    if (d.frameLive) this.armExpiry(d.frameAt + VIDEO_MAX_AGE_MS);
    this.emit();
  }

  /**
   * Measures the online drones' round trips – one probe at a time per drone, and at most
   * `PINGS_PER_ROUND` drones each round (in turn: a large fleet does not flood the link).
   */
  private pingAll(): void {
    const now = performance.now();
    const online = Object.values(this.state.drones).filter((d) => d.online);
    const start = online.length ? this.pingRound % online.length : 0;
    let sent = 0;
    for (let i = 0; i < online.length && sent < PINGS_PER_ROUND; i++) {
      const d = online[(start + i) % online.length]!;
      const waiting = this.dronePings.get(d.droneId);
      if (waiting && now - waiting.sent < 10_000) continue;
      const id = `${Math.random().toString(36).slice(2)}|${d.droneId}`;
      this.dronePings.set(d.droneId, { id, sent: now });
      this.send({ type: 'ping', id, t: this.now(), droneId: d.droneId });
      sent++;
    }
    this.pingRound += PINGS_PER_ROUND;
  }

  command(droneId: string, command: CommandName, params: CommandParams = {}): Promise<{ result: AckResult; message?: string }> {
    const requestId = Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ result: 'timeout', message: 'No response' });
        if (this.closed && !this.pending.size) this.endSocket();
      }, 15_000);
      this.pending.set(requestId, { resolve, timer });
      if (!this.send({ type: 'command', droneId, requestId, command, params })) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve({ result: 'rejected', message: 'Not connected' });
      }
    });
  }

  control(droneId: string, action: 'request' | 'release' | 'force'): void {
    this.send({ type: 'control', droneId, action });
  }

  manual(droneId: string, x: number, y: number, z: number, r: number): void {
    this.send({ type: 'manual_control', droneId, x, y, z, r });
  }

  /**
   * Video subscriptions are counted per owner (video tile, detail card …): the stream stops
   * when the last owner releases it, and HD wins when any owner asks for it.
   */
  setVideo(droneId: string, enabled: boolean, quality: VideoQuality = 'sd', owner = 'default'): void {
    const owners = this.videoOwners.get(droneId) ?? new Map<string, VideoQuality>();
    if (enabled) owners.set(owner, quality);
    else owners.delete(owner);
    if (owners.size) this.videoOwners.set(droneId, owners);
    else this.videoOwners.delete(droneId);
    const effective: VideoQuality | null = owners.size ? ([...owners.values()].includes('hd') ? 'hd' : 'sd') : null;
    const before = this.videoWanted.get(droneId) ?? null;
    if (effective === before) return;
    if (effective) this.videoWanted.set(droneId, effective);
    else this.videoWanted.delete(droneId);
    this.send({ type: 'video', droneId, enabled: !!effective, quality: effective ?? quality });
    if (!effective) {
      const d = this.state.drones[droneId];
      if (d?.frameUrl) {
        URL.revokeObjectURL(d.frameUrl);
        d.frameUrl = null;
        this.emit();
      }
    }
  }

  videoQuality(droneId: string): VideoQuality | null {
    return this.videoWanted.get(droneId) ?? null;
  }
}

export type { Telemetry };
