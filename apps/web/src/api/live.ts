/**
 * Athena Live client: one WebSocket per organisation carrying telemetry, status,
 * events, acks, video frames and latency probes for every drone of the organisation.
 */
import {
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
  rttMs: number | null;
  /** When the latest telemetry sample was taken (this browser's clock; 0: none yet). */
  dataAt: number;
  /**
   * The drone is online but nothing new came from it for a while – its link or the viewer's is
   * slow or stalled: what is shown of it is not live (and nothing that needs it is offered).
   */
  late: boolean;
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
/** An online drone with nothing newer than this is shown as late. */
export const DATA_MAX_AGE_MS = 5000;
/** A video frame older than this is not shown as live. */
export const VIDEO_MAX_AGE_MS = 3000;
/** Traffic not reported for this long is drawn as old, and removed after `TRAFFIC_MAX_AGE_MS`. */
export const TRAFFIC_OLD_MS = 15_000;
export const TRAFFIC_MAX_AGE_MS = 60_000;

export class LiveClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private pending = new Map<string, { resolve: (r: { result: AckResult; message?: string }) => void; timer: number }>();
  private pings = new Map<string, number>();
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
  /** The cloud's clock minus this browser's (ms) by the probe with the shortest round trip lately. */
  private serverOffset: number | null = null;
  private offsetRtt = Infinity;
  private offsetAt = 0;
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
    this.received = 0;
    this.ackedCount = 0;
    this.probes.clear();
    this.lastProbeRtt = null;
    this.socketSynced = false;
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
      this.state.lostAt = Date.now();
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

  /** A time of the cloud's clock in this browser's (its time of arrival while the offset is not known). */
  private localTime(cloudTime: number | null | undefined): number {
    return typeof cloudTime === 'number' && this.serverOffset !== null ? cloudTime - this.serverOffset : Date.now();
  }

  /** Probes the link (answered by the cloud at once). */
  private probe(): void {
    if (this.ws?.readyState !== WebSocket.OPEN || this.probes.size >= 30) return;
    const id = `link-${++this.probeSeq}`;
    this.probes.set(id, { perf: performance.now(), wall: Date.now() });
    this.send({ type: 'ping', id, t: Date.now() });
  }

  private onProbeAnswer(p: { perf: number; wall: number }, serverTime: number): void {
    const now = Date.now();
    const rtt = performance.now() - p.perf;
    this.lastProbeRtt = rtt;
    this.state.linkRttMs = Math.round(rtt);
    // NTP-style: the cloud answered half-way through the round trip (within ± rtt / 2). The probe
    // with the shortest round trip is kept, unless it is old or the two cannot both be right.
    const offset = serverTime - (p.wall + now) / 2;
    const jumped = this.serverOffset !== null && Math.abs(offset - this.serverOffset) > (rtt + this.offsetRtt) / 2 + 50;
    if (this.serverOffset === null || jumped || rtt <= this.offsetRtt || now - this.offsetAt > 60_000) {
      this.serverOffset = offset;
      this.offsetRtt = rtt;
      this.offsetAt = now;
    }
    this.checkLink();
  }

  /**
   * Whether the link keeps up: a probe that waits, or came back, longer than `LINK_LAG_MS` makes
   * what is shown late (not live) until a probe comes back in time; one left unanswered for
   * `LINK_STALL_MS` ends the connection (it is made again).
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
    const late = waiting > LINK_LAG_MS || (this.lastProbeRtt ?? 0) > LINK_LAG_MS;
    if (late && !st.delayed && this.socketSynced) {
      st.delayed = true;
      if (st.current) {
        st.current = false;
        // What is shown is as of when the oldest probe still waiting (or the last one) was sent.
        st.lostAt = oldest ? oldest.wall : Date.now() - (this.lastProbeRtt ?? 0);
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

  /** Every second: a link probe; how long the link and each drone's data take; traffic aged. */
  private tick(): void {
    this.probe();
    this.checkLink();
    const now = Date.now();
    let changed = false;
    for (const d of Object.values(this.state.drones)) {
      const late = d.online && d.dataAt > 0 && now - d.dataAt > DATA_MAX_AGE_MS;
      if (late !== d.late) {
        d.late = late;
        changed = true;
      }
      if (d.traffic.length) {
        const kept = d.traffic.filter((a) => now - a.t <= TRAFFIC_MAX_AGE_MS);
        for (const a of kept) {
          const old = now - a.t > TRAFFIC_OLD_MS;
          if (old !== a.old) {
            a.old = old;
            changed = true;
          }
        }
        if (kept.length !== d.traffic.length) {
          d.traffic = kept;
          changed = true;
        } else if (changed) d.traffic = [...kept];
      }
    }
    if (changed) {
      this.state.drones = { ...this.state.drones };
      this.emit();
    }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.probeTimer) clearInterval(this.probeTimer);
    if (this.ackTimer !== null) clearTimeout(this.ackTimer);
    this.ws?.close();
    for (const d of Object.values(this.state.drones)) if (d.frameUrl) URL.revokeObjectURL(d.frameUrl);
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
    const dataAt = state.telemetry ? (state.telemetryAt != null ? this.localTime(state.telemetryAt) : (prev?.dataAt ?? Date.now())) : (prev?.dataAt ?? 0);
    return {
      ...state,
      telemetry: state.telemetry ?? prev?.telemetry ?? null,
      track: prev?.track ?? [],
      frameUrl: prev?.frameUrl ?? null,
      frameAt: prev?.frameAt ?? 0,
      rttMs: fresh ? null : (prev?.rttMs ?? null),
      dataAt,
      late: state.online && dataAt > 0 && Date.now() - dataAt > DATA_MAX_AGE_MS,
      events: prev?.events ?? [],
      traffic: fresh ? [] : (prev?.traffic ?? []),
      firmwareProgress: fresh ? null : (prev?.firmwareProgress ?? null),
      detections: state.ai?.enabled && !fresh ? (prev?.detections ?? []) : [],
      detectionsAt: fresh ? 0 : (prev?.detectionsAt ?? 0),
    };
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
        // A first estimate of the cloud's clock (the probes refine it).
        if (this.serverOffset === null && typeof msg.serverTime === 'number') this.serverOffset = msg.serverTime - Date.now();
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
        }
        this.state.drones = { ...this.state.drones, [msg.drone.droneId]: v };
        break;
      }
      case 'telemetry': {
        const d = this.state.drones[msg.droneId];
        if (!d) return;
        d.telemetry = msg.data;
        d.dataAt = this.localTime(msg.at);
        d.late = d.online && Date.now() - d.dataAt > DATA_MAX_AGE_MS;
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
        }
        this.pushEvent(msg.droneId, {
          t: Date.now(),
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
          this.pushEvent(msg.droneId, { t: Date.now(), level: 'info', message: msg.state === 'started' ? 'Flight recording started' : 'Flight recorded' });
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
          const now = Date.now();
          // Aged by when each aircraft was reported (in this browser's clock).
          d.traffic = msg.aircraft
            .map((a) => {
              const t = Math.min(now, this.localTime(a.t));
              return { ...a, t, old: now - t > TRAFFIC_OLD_MS };
            })
            .filter((a) => now - a.t <= TRAFFIC_MAX_AGE_MS);
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
          this.onProbeAnswer(probe, msg.serverTime);
          break;
        }
        const sentAt = this.pings.get(msg.id);
        this.pings.delete(msg.id);
        const droneId = msg.id.split('|')[1];
        if (sentAt !== undefined && droneId && this.state.drones[droneId]) {
          const viewerRtt = performance.now() - sentAt;
          this.state.drones[droneId]!.rttMs = msg.droneRttMs !== undefined ? Math.round(viewerRtt) : null;
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
          d.detectionsAt = Date.now();
        }
        break;
      }
      case 'error':
        break;
    }
    this.emit();
  }

  private onFrame(buf: Uint8Array): void {
    const f = decodeLiveVideoFrame(buf);
    if (!f) return;
    const d = this.state.drones[f.droneId];
    if (!d) return;
    const url = URL.createObjectURL(new Blob([f.jpeg as BlobPart], { type: 'image/jpeg' }));
    if (d.frameUrl) URL.revokeObjectURL(d.frameUrl);
    d.frameUrl = url;
    // Its capture time (in the cloud's clock): a frame that comes late is not shown as live.
    d.frameAt = Math.min(Date.now(), this.localTime(f.ts));
    this.emit();
  }

  private pingAll(): void {
    for (const d of Object.values(this.state.drones)) {
      if (!d.online) continue;
      const id = `${Math.random().toString(36).slice(2)}|${d.droneId}`;
      this.pings.set(id, performance.now());
      this.send({ type: 'ping', id, t: Date.now(), droneId: d.droneId });
    }
  }

  command(droneId: string, command: CommandName, params: CommandParams = {}): Promise<{ result: AckResult; message?: string }> {
    const requestId = Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ result: 'timeout', message: 'No response' });
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
