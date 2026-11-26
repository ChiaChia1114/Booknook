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

export interface DroneView extends LiveDroneState {
  track: [number, number][];
  frameUrl: string | null;
  frameAt: number;
  rttMs: number | null;
  events: LiveEvent[];
  traffic: DetectedAircraft[];
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

export class LiveClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private pending = new Map<string, { resolve: (r: { result: AckResult; message?: string }) => void; timer: number }>();
  private pings = new Map<string, number>();
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
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
  state: LiveSnapshot = { connected: false, synced: false, unreachable: false, canControl: false, role: null, userId: null, drones: {}, users: [], notifications: [], swarms: {}, version: 0 };

  constructor(readonly orgId: string) {
    this.connect();
    this.pingTimer = window.setInterval(() => this.pingAll(), 3000);
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
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.backoff = 1000;
      this.state.connected = true;
      this.state.unreachable = false;
      for (const [droneId, quality] of this.videoWanted) this.send({ type: 'video', droneId, enabled: true, quality });
      this.emit();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') this.onMessage(JSON.parse(ev.data) as LiveDownMessage);
      else this.onFrame(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.state.connected = false;
      if (!opened) this.state.unreachable = true;
      this.emit();
      if (ev.code === 4403) {
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
    };
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
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

  private view(state: LiveDroneState): DroneView {
    const prev = this.state.drones[state.droneId];
    return {
      ...state,
      telemetry: state.telemetry ?? prev?.telemetry ?? null,
      track: prev?.track ?? [],
      frameUrl: prev?.frameUrl ?? null,
      frameAt: prev?.frameAt ?? 0,
      rttMs: prev?.rttMs ?? null,
      events: prev?.events ?? [],
      traffic: prev?.traffic ?? [],
      firmwareProgress: prev?.firmwareProgress ?? null,
      detections: state.ai?.enabled ? (prev?.detections ?? []) : [],
      detectionsAt: prev?.detectionsAt ?? 0,
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
        break;
      case 'snapshot':
        this.state.drones = Object.fromEntries(msg.drones.map((d) => [d.droneId, this.view(d)]));
        this.state.users = msg.users;
        this.state.synced = true;
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
        if (d) d.traffic = msg.aircraft;
        break;
      }
      case 'users':
        this.state.users = msg.users;
        break;
      case 'pong': {
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
    d.frameAt = Date.now();
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
