import type { FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import {
  COMMANDS,
  can,
  isRole,
  clampAxis,
  decodeLinkVideoFrame,
  encodeLiveVideoFrame,
  flownFrom,
  haversineDistance,
  sanitizeTelemetry,
  type AckResult,
  type CameraInfo,
  type CommandName,
  type CommandParams,
  type ControllerInfo,
  type DetectedAircraft,
  type EventLevel,
  type LinkDownMessage,
  type LiveDownMessage,
  type LiveDroneState,
  type LiveUpMessage,
  type LatLon,
  type LatLonAlt,
  type MissionPlan,
  type OnlineUser,
  type Role,
  type Telemetry,
  type VideoQuality,
} from '@athena-sky/shared';
import { parseJson, type Db } from '../db/database';
import type { FlightRecorder } from '../flights/recorder';
import type { WebhookDispatcher } from '../integrations/webhooks';
import { audit } from '../lib/audit';
import { sha256Hex } from '../lib/crypto';
import { nowIso, uuid } from '../lib/util';
import { EventEmitter } from 'node:events';

interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface HubDeps {
  db: Db;
  recorder: FlightRecorder;
  webhooks: WebhookDispatcher;
  log: Logger;
  publicUrl: string;
  /** Hook used by firmware OTA to create one-time download URLs. */
  firmwareDownloadUrl(updateId: string): string;
}

interface DroneMeta {
  droneId: string;
  orgId: string;
  name: string;
  fleetId: string | null;
  model: string | null;
  firmware: string | null;
}

export interface CommandOutcome {
  result: AckResult;
  message?: string;
  /** False when the command was rejected by the cloud before reaching the drone. */
  delivered: boolean;
}

interface PendingCommand {
  id: string;
  droneId: string;
  command: string;
  viewerConnId: string | null;
  requestId: string | null;
  resolve: ((r: { result: AckResult; message?: string }) => void) | null;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingPing {
  viewerConnId: string;
  viewerPingId: string;
  viewerT: number;
  sentAt: number;
  timer: ReturnType<typeof setTimeout>;
}

interface DroneConn extends DroneMeta {
  connId: string;
  socket: WebSocket;
  connectedAt: number;
  helloReceived: boolean;
  capabilities: { video?: boolean; manualControl?: boolean; adsb?: boolean; ai?: boolean };
  camera: CameraInfo | null;
  telemetry: Telemetry | null;
  controller: (ControllerInfo & { connId: string | null }) | null;
  controllerGraceTimer: NodeJS.Timeout | null;
  videoViewers: Map<string, VideoQuality>;
  videoActive: VideoQuality | null;
  mission: {
    missionId: string;
    name: string;
    seq: number;
    total: number;
    pilotId: string | null;
    /** The plan as uploaded to the drone (edits to the mission afterwards do not change it). */
    plan: MissionPlan;
    uploadedAt: string;
    /** Where the mission was started in the air (null: from home). */
    start: LatLonAlt | null;
    /** Sent with its blocked airspace check overridden by an owner or administrator (audited). */
    airspaceAccepted: boolean;
  } | null;
  /** The loaded mission is being flown (started, or the drone reports MISSION mode). */
  missionRunning: boolean;
  /** Who sent the last command (credited as the pilot of a flight it starts). */
  lastCommander: { userId: string; at: number } | null;
  lastPersistAt: number;
  lastWebhookTelemetryAt: number;
  lastManualAt: number;
  alive: boolean;
  trafficAdvisories: Map<string, number>;
  /** The drone was deleted: whatever it still sends is ignored. */
  removed?: boolean;
  /**
   * The drone's clock: its offset to the cloud's (ms, drone − cloud) by the probe with the
   * shortest round trip lately – times the drone reports (telemetry, video, traffic) are passed
   * on in the cloud's clock, so that viewers can tell how old they are.
   */
  clock: { offset: number; rtt: number; at: number } | null;
  /** The clock probe waiting for its answer. */
  probe: { id: string; sentAt: number } | null;
  /** When the latest telemetry sample was taken, in the cloud's clock. */
  telemetryAt: number | null;
}

interface ViewerConn {
  connId: string;
  socket: WebSocket;
  orgId: string;
  userId: string;
  userName: string;
  role: Role;
  via: 'session' | 'token';
  /** Session id or API-token id the socket was authenticated with. */
  authKey: string;
  since: number;
  subscriptions: Set<string> | 'all';
  alive: boolean;
  /** Heartbeats without a pong (a busy browser may answer late). */
  missedPongs: number;
  /** Messages sent on the connection (counted from its start, as the viewer counts them). */
  sent: number;
  /** Flow control, once the viewer acknowledges what it receives (`ack`). */
  flow: ViewerFlow | null;
}

/**
 * Flow control of a viewer that acknowledges what it receives: how long the messages sent wait
 * for their acknowledgement tells a slow or stalled link – the kernel's buffers hide it from the
 * socket's own buffer. While they wait too long, video frames are dropped and only the latest
 * telemetry (and detections) of each drone is kept back, so that what the viewer gets is never
 * older than its link's round trip and a short budget.
 */
interface ViewerFlow {
  /** Messages acknowledged. */
  acked: number;
  /** The messages not yet acknowledged: the count at each one's end and when it was sent. */
  marks: { n: number; at: number }[];
  /** Shortest time from sending to acknowledgement in the current and the previous 10-s window. */
  rttCur: number;
  rttPrev: number;
  rttWindowAt: number;
  /** The latest telemetry / detections per drone kept back while the link is congested. */
  held: Map<string, string>;
}

const COMMAND_TIMEOUT_MS = 10_000;
/** A pilot who loses the connection keeps the control lock this long to reconnect. */
export const CONTROL_GRACE_MS = 15_000;
/** Viewer sockets are closed after this many heartbeats without a pong. */
const MAX_MISSED_PONGS = 2;
const LONG_COMMAND_TIMEOUT_MS = 120_000;
const MAX_VIEWER_BUFFER = 1_000_000;
const MAX_TELEMETRY_BUFFER = 256_000;
/**
 * How long what was sent to a viewer that acknowledges may wait for its acknowledgement beyond
 * the link's round trip before the link counts as congested.
 */
const VIEWER_LAG_BUDGET_MS = 300;
/** The longest round trip of a viewer's link counted (a longer one would let a queue build up). */
const VIEWER_MAX_RTT_MS = 1000;
/** Clock probes of each drone (its clock offset and round trip). */
const DRONE_PROBE_MS = 2000;
const PERSIST_INTERVAL_MS = 10_000;
const KEEPALIVE_MS = 15_000;
const AUTH_TIMEOUT_MS = 5_000;

const send = (socket: WebSocket, msg: object): void => {
  if (socket.readyState === 1) socket.send(JSON.stringify(msg));
};

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

/** What other services (UTM monitor, swarm controller) can observe on the hub. */
export interface HubEvents {
  telemetry: [orgId: string, droneId: string, telemetry: Telemetry];
  progress: [orgId: string, droneId: string, seq: number, total: number];
  online: [orgId: string, droneId: string];
  offline: [orgId: string, droneId: string];
  control: [orgId: string, droneId: string, controller: ControllerInfo | null];
  event: [orgId: string, droneId: string, event: { level: EventLevel; code?: string; message: string }];
  /** A video frame for internal consumers (AI vision). */
  frame: [orgId: string, droneId: string, ts: number, jpeg: Buffer];
  /** Detections computed on board the drone (drones with their own AI). */
  detections: [orgId: string, droneId: string, msg: Record<string, unknown>];
  /** The drone introduced itself (`hello`): its capabilities are known. */
  hello: [orgId: string, droneId: string];
  /** A member's role changed (role) or the member was removed (null). */
  member: [orgId: string, userId: string, role: Role | null];
  /** A drone accepted a command of a user (not one of a swarm operation to its member). */
  commanded: [orgId: string, droneId: string, user: { id: string; name: string }, command: string];
}

/**
 * Real-time hub: terminates Athena Link connections from drones and Athena Live
 * connections from browsers / integrations, and routes telemetry, video, commands,
 * mission uploads, firmware updates and latency probes between them.
 */
export class Hub {
  /** Grace period of a disconnected pilot's control lock (ms). */
  controlGraceMs = CONTROL_GRACE_MS;
  private readonly drones = new Map<string, DroneConn>();
  /** Last time a flight-recording failure was logged per drone (the log is rate limited). */
  private readonly recorderErrorAt = new Map<string, number>();
  private readonly viewers = new Map<string, ViewerConn>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly pendingMissions = new Map<string, PendingCommand>();
  private readonly pings = new Map<string, PendingPing>();
  private readonly keepalive: ReturnType<typeof setInterval>;
  private readonly prober: ReturnType<typeof setInterval>;
  /** Observers of drone telemetry, mission progress, connection, control and events. */
  readonly events = new EventEmitter<HubEvents>();

  /** Set once the server is shutting down. */
  private stopping = false;

  constructor(private readonly deps: HubDeps) {
    this.keepalive = setInterval(() => this.heartbeat(), KEEPALIVE_MS);
    this.keepalive.unref?.();
    this.prober = setInterval(() => this.probeDrones(), DRONE_PROBE_MS);
    this.prober.unref?.();
  }

  /** Notifies observers; a failing observer never breaks the link handling. */
  private fire<K extends keyof HubEvents>(name: K, ...args: HubEvents[K]): void {
    try {
      (this.events.emit as (n: string, ...a: unknown[]) => boolean)(name, ...args);
    } catch (err) {
      this.deps.log.error({ err, event: name }, 'hub observer failed');
    }
  }

  // =======================================================================================
  // Drone side (Athena Link)
  // =======================================================================================

  handleLinkConnection(socket: WebSocket, req: FastifyRequest): void {
    const header = req.headers.authorization;
    const m = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    if (m) {
      this.authenticateDrone(socket, m[1]!);
      return;
    }
    const timer = setTimeout(() => socket.close(4401, 'authentication timeout'), AUTH_TIMEOUT_MS);
    socket.once('message', (data, isBinary) => {
      clearTimeout(timer);
      if (isBinary) return socket.close(4401, 'authentication required');
      try {
        const msg = JSON.parse(toBuffer(data).toString('utf8'));
        if (msg?.type !== 'auth' || typeof msg.key !== 'string') return socket.close(4401, 'authentication required');
        this.authenticateDrone(socket, msg.key);
      } catch {
        socket.close(4400, 'invalid message');
      }
    });
  }

  private loadMeta(droneId: string): DroneMeta | null {
    const r = this.deps.db.get<{ id: string; org_id: string; name: string; fleet_id: string | null; model: string; firmware_version: string | null }>(
      'SELECT id, org_id, name, fleet_id, model, firmware_version FROM drones WHERE id = ?',
      droneId,
    );
    return r ? { droneId: r.id, orgId: r.org_id, name: r.name, fleetId: r.fleet_id, model: r.model || null, firmware: r.firmware_version } : null;
  }

  private authenticateDrone(socket: WebSocket, key: string): void {
    const row = this.deps.db.get<{ id: string }>('SELECT id FROM drones WHERE link_key_hash = ?', sha256Hex(key));
    const meta = row ? this.loadMeta(row.id) : null;
    if (!meta) {
      send(socket, { type: 'error', message: 'invalid drone key' } satisfies LinkDownMessage);
      socket.close(4403, 'invalid drone key');
      return;
    }
    const previous = this.drones.get(meta.droneId);
    if (previous) {
      // A new connection from the same drone (e.g. after an LTE hand-over) replaces the old one.
      this.drones.delete(meta.droneId);
      previous.socket.close(4409, 'replaced by a newer connection');
    }
    const conn: DroneConn = {
      ...meta,
      connId: uuid(),
      socket,
      connectedAt: Date.now(),
      helloReceived: false,
      capabilities: {},
      camera: previous?.camera ?? null,
      telemetry: null,
      controller: previous?.controller ?? null,
      controllerGraceTimer: previous?.controllerGraceTimer ?? null,
      videoViewers: previous?.videoViewers ?? new Map(),
      videoActive: null,
      mission: previous?.mission ?? null,
      missionRunning: previous?.missionRunning ?? false,
      lastCommander: previous?.lastCommander ?? null,
      lastPersistAt: 0,
      lastWebhookTelemetryAt: 0,
      lastManualAt: 0,
      alive: true,
      trafficAdvisories: new Map(),
      clock: null,
      probe: null,
      telemetryAt: null,
    };
    this.drones.set(meta.droneId, conn);
    socket.on('pong', () => {
      conn.alive = true;
    });
    socket.on('message', (data, isBinary) => {
      if (conn.removed) return;
      try {
        if (isBinary) this.onDroneBinary(conn, toBuffer(data));
        else this.onDroneMessage(conn, JSON.parse(toBuffer(data).toString('utf8')));
      } catch (err) {
        this.deps.log.warn({ err, droneId: conn.droneId }, 'bad link message');
      }
    });
    socket.on('close', () => this.onDroneClose(conn));
    socket.on('error', () => undefined);
    send(socket, { type: 'welcome', droneId: meta.droneId, name: meta.name, serverTime: Date.now() } satisfies LinkDownMessage);
    this.deps.recorder.onReconnect(meta.droneId);
    this.deps.db.run('UPDATE drones SET last_seen_at = ? WHERE id = ?', nowIso(), meta.droneId);
    this.broadcastStatus(conn);
    if (!previous) this.deps.webhooks.emit(meta.orgId, 'drone.online', { droneId: meta.droneId, name: meta.name });
    this.updateVideo(conn);
    if (!previous) this.fire('online', meta.orgId, meta.droneId);
  }

  private onDroneClose(conn: DroneConn): void {
    if (this.drones.get(conn.droneId) !== conn) return; // replaced
    this.drones.delete(conn.droneId);
    // Shutting down: positions are saved and flights stay open for the next start (the database
    // may already be closed when the socket reports it).
    if (this.stopping) return;
    this.persistPosition(conn);
    this.deps.recorder.onDisconnect(conn.droneId);
    for (const [id, p] of this.pending) {
      if (p.droneId === conn.droneId) this.resolvePending(id, 'failed', 'Drone disconnected');
    }
    for (const [id, p] of this.pendingMissions) {
      if (p.droneId === conn.droneId) this.resolveMission(id, 'failed', 'Drone disconnected');
    }
    this.broadcastStatus(conn);
    this.deps.webhooks.emit(conn.orgId, 'drone.offline', { droneId: conn.droneId, name: conn.name });
    this.fire('offline', conn.orgId, conn.droneId);
  }

  private persistPosition(conn: DroneConn): void {
    const t = conn.telemetry;
    if (t) {
      this.deps.db.run('UPDATE drones SET last_seen_at = ?, last_lat = ?, last_lon = ?, last_alt = ? WHERE id = ?', nowIso(), t.lat, t.lon, t.altMsl, conn.droneId);
    } else {
      this.deps.db.run('UPDATE drones SET last_seen_at = ? WHERE id = ?', nowIso(), conn.droneId);
    }
    conn.lastPersistAt = Date.now();
  }

  private onDroneMessage(conn: DroneConn, msg: Record<string, any>): void {
    switch (msg.type) {
      case 'hello':
        return this.onHello(conn, msg);
      case 'telemetry':
        return this.onTelemetry(conn, msg);
      case 'event': {
        const level: EventLevel = ['info', 'warning', 'error', 'critical'].includes(msg.level) ? msg.level : 'info';
        const message = String(msg.message ?? '').slice(0, 500);
        const code = typeof msg.code === 'string' ? msg.code.slice(0, 64) : undefined;
        const flightId = this.deps.recorder.onEvent(conn.droneId, { level, code, message });
        this.broadcast(conn.orgId, { type: 'event', droneId: conn.droneId, t: Date.now(), level, code, message }, conn.droneId);
        if (level === 'critical' || level === 'error') {
          this.deps.webhooks.emit(conn.orgId, 'alert.raised', { droneId: conn.droneId, flightId, level, code, message });
        }
        this.fire('event', conn.orgId, conn.droneId, { level, code, message });
        return;
      }
      case 'ack':
        if (typeof msg.id === 'string') this.onAck(conn, msg.id, msg.result, typeof msg.message === 'string' ? msg.message : undefined);
        return;
      case 'mission_ack':
        if (typeof msg.id === 'string') this.resolveMission(msg.id, msg.result, typeof msg.message === 'string' ? msg.message : undefined);
        return;
      case 'mission_progress': {
        const seq = Number(msg.seq);
        const total = Number(msg.total);
        if (!Number.isFinite(seq) || !Number.isFinite(total)) return;
        if (conn.mission) {
          conn.mission.seq = seq;
          conn.mission.total = total;
        }
        this.broadcast(conn.orgId, { type: 'mission_progress', droneId: conn.droneId, seq, total }, conn.droneId);
        this.fire('progress', conn.orgId, conn.droneId, seq, total);
        return;
      }
      case 'firmware_progress':
        return this.onFirmwareProgress(conn, msg);
      case 'adsb':
        return this.onAdsb(conn, msg);
      case 'payload': {
        if (typeof msg.kind !== 'string' || !msg.data || typeof msg.data !== 'object') return;
        const flightId = this.deps.recorder.onPayload(conn.droneId, msg.kind, msg.data);
        this.deps.webhooks.emit(conn.orgId, 'payload.data', { droneId: conn.droneId, flightId, kind: msg.kind, data: msg.data, t: Date.now() });
        return;
      }
      case 'pong':
        return this.onDronePong(conn, msg);
      case 'detections':
        this.fire('detections', conn.orgId, conn.droneId, msg);
        return;
      default:
        return;
    }
  }

  private onHello(conn: DroneConn, msg: Record<string, any>): void {
    conn.helloReceived = true;
    const firmware = typeof msg.firmware === 'string' ? msg.firmware.slice(0, 64) : null;
    if (msg.capabilities && typeof msg.capabilities === 'object') {
      conn.capabilities = {
        video: msg.capabilities.video === true,
        manualControl: msg.capabilities.manualControl === true,
        adsb: msg.capabilities.adsb === true,
        ai: msg.capabilities.ai === true,
      };
    }
    const cam = msg.camera;
    if (cam && typeof cam === 'object' && Number.isFinite(cam.hfovDeg) && Number.isFinite(cam.pitchDeg) && cam.hfovDeg > 5 && cam.hfovDeg < 180 && cam.pitchDeg >= -90 && cam.pitchDeg <= 30) {
      conn.camera = { hfovDeg: cam.hfovDeg, pitchDeg: cam.pitchDeg };
    }
    if (firmware && firmware !== conn.firmware) {
      conn.firmware = firmware;
      this.deps.db.run('UPDATE drones SET firmware_version = ? WHERE id = ?', firmware, conn.droneId);
    }
    if (typeof msg.model === 'string' && msg.model && !conn.model) {
      conn.model = msg.model.slice(0, 100);
      this.deps.db.run("UPDATE drones SET model = ? WHERE id = ? AND model = ''", conn.model, conn.droneId);
    }
    if (typeof msg.serial === 'string' && msg.serial) {
      this.deps.db.run("UPDATE drones SET serial = ? WHERE id = ? AND serial = ''", msg.serial.slice(0, 100), conn.droneId);
    }
    // The mission on board, picked up again after a link drop or a server restart.
    this.restoreMission(conn, 'mission' in msg ? msg.mission : undefined);
    this.completeFirmwareIfInstalled(conn);
    this.broadcastStatus(conn);
    this.updateVideo(conn);
    this.dispatchPendingFirmware(conn.droneId);
    this.fire('hello', conn.orgId, conn.droneId);
  }

  /**
   * Re-establishes the drone's loaded mission from what it reports on board (`hello.mission`:
   * the uploaded mission's id, or null for none) and the mission this cloud uploaded to it. A
   * drone that does not report it is assumed to still carry the mission last uploaded.
   */
  private restoreMission(conn: DroneConn, reported: unknown): void {
    const row = this.deps.db.get<{
      mission_id: string;
      name: string;
      plan: string;
      pilot_id: string | null;
      total: number;
      running: number;
      uploaded_at: string;
      start: string | null;
      airspace_accepted: number;
    }>(
      'SELECT mission_id, name, plan, pilot_id, total, running, uploaded_at, start, airspace_accepted FROM drone_missions WHERE drone_id = ?',
      conn.droneId,
    );
    if (reported === null) {
      // Nothing on board (e.g. the drone restarted).
      if (conn.mission || row) {
        conn.mission = null;
        conn.missionRunning = false;
        this.saveLoadedMission(conn);
      }
      this.missionLost(conn);
      return;
    }
    const r = reported && typeof reported === 'object' ? (reported as Record<string, unknown>) : null;
    const id = typeof r?.id === 'string' ? r.id : null;
    if (r && !id) return; // malformed report: keep what is known
    const seq = r && Number.isFinite(Number(r.seq)) ? Number(r.seq) : null;
    if (conn.mission && (!id || conn.mission.missionId === id)) {
      // Where it got to while the link was lost (its progress messages went nowhere).
      if (seq !== null && seq !== conn.mission.seq) {
        conn.mission.seq = seq;
        this.fire('progress', conn.orgId, conn.droneId, seq, conn.mission.total);
      }
      return;
    }
    const plan = row && (!id || row.mission_id === id) ? parseJson<MissionPlan | null>(row.plan, null) : null;
    if (row && plan) {
      conn.mission = {
        missionId: row.mission_id,
        name: row.name,
        seq: seq ?? 0,
        total: row.total,
        pilotId: row.pilot_id,
        plan,
        uploadedAt: row.uploaded_at,
        start: parseJson<LatLonAlt | null>(row.start, null),
        airspaceAccepted: row.airspace_accepted === 1,
      };
      conn.missionRunning = row.running === 1;
      return;
    }
    conn.mission = null;
    conn.missionRunning = false;
    if (row) this.saveLoadedMission(conn);
    this.missionLost(conn);
    if (id) {
      // Deleted while the drone was away, or uploaded with other software: its flights are
      // recorded without a mission.
      const message = `${conn.name} has a mission on board that is not loaded here (already flown, deleted meanwhile, or uploaded with other software) – upload a mission before flying one.`;
      this.deps.recorder.onEvent(conn.droneId, { level: 'warning', code: 'mission_unknown', message });
      this.broadcast(conn.orgId, { type: 'event', droneId: conn.droneId, t: Date.now(), level: 'warning', code: 'mission_unknown', message }, conn.droneId);
    }
  }

  /**
   * The drone no longer carries the mission uploaded for a scheduled operation: that operation is
   * pending again (to be uploaded before it is flown), as when another mission replaces it.
   */
  private missionLost(conn: DroneConn): void {
    this.deps.db.run("UPDATE schedules SET status = 'scheduled' WHERE drone_id = ? AND status = 'uploaded'", conn.droneId);
  }

  /** Keeps the drone's loaded mission (or its absence) over link drops and server restarts. */
  private saveLoadedMission(conn: DroneConn): void {
    const m = conn.mission;
    if (!m) {
      this.deps.db.run('DELETE FROM drone_missions WHERE drone_id = ?', conn.droneId);
      return;
    }
    try {
      this.deps.db.run(
        `INSERT INTO drone_missions (drone_id, mission_id, name, plan, pilot_id, total, running, uploaded_at, start, airspace_accepted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(drone_id) DO UPDATE SET mission_id = excluded.mission_id, name = excluded.name, plan = excluded.plan, pilot_id = excluded.pilot_id,
                                             total = excluded.total, running = excluded.running, uploaded_at = excluded.uploaded_at, start = excluded.start,
                                             airspace_accepted = excluded.airspace_accepted`,
        conn.droneId,
        m.missionId,
        m.name,
        JSON.stringify(m.plan),
        m.pilotId,
        m.total,
        conn.missionRunning ? 1 : 0,
        m.uploadedAt,
        m.start ? JSON.stringify(m.start) : null,
        m.airspaceAccepted ? 1 : 0,
      );
    } catch (err) {
      // The mission was deleted while it was being uploaded: nothing to keep.
      this.deps.db.run('DELETE FROM drone_missions WHERE drone_id = ?', conn.droneId);
      this.deps.log.warn({ err, droneId: conn.droneId }, 'loaded mission not kept');
    }
  }

  private setMissionRunning(conn: DroneConn, running: boolean): void {
    if (conn.missionRunning === running) return;
    conn.missionRunning = running;
    const m = conn.mission;
    if (!m) return;
    // Started in the air: the route is flown from where the drone is (it still returns home).
    const t = conn.telemetry;
    if (running) m.start = t?.inAir ? { lat: t.lat, lon: t.lon, alt: t.altRel } : null;
    this.deps.db.run('UPDATE drone_missions SET running = ?, start = ? WHERE drone_id = ?', running ? 1 : 0, m.start ? JSON.stringify(m.start) : null, conn.droneId);
    this.broadcastStatus(conn);
  }

  private onTelemetry(conn: DroneConn, msg: Record<string, unknown>): void {
    const t = sanitizeTelemetry(msg);
    if (!t) return;
    conn.telemetry = t;
    conn.telemetryAt = this.cloudTime(conn, t.t);
    this.fire('telemetry', conn.orgId, conn.droneId, t);
    // A flight belongs to the loaded mission only while that mission is being flown; its
    // pilot is whoever holds control, else whoever sent the command that started it.
    if (conn.mission && t.mode === 'MISSION') this.setMissionRunning(conn, true);
    const flying = conn.mission && conn.missionRunning ? conn.mission : null;
    const commander = conn.lastCommander && Date.now() - conn.lastCommander.at < 120_000 ? conn.lastCommander.userId : null;
    const pilotId = conn.controller?.userId ?? commander ?? flying?.pilotId ?? null;
    // A recording failure must not stop the live picture, alerts or webhooks of the drone.
    try {
      this.deps.recorder.onTelemetry(
        // The geofence is enforced by the drone whenever a mission carrying one is loaded.
        {
          orgId: conn.orgId,
          droneId: conn.droneId,
          pilotId,
          missionId: flying?.missionId ?? null,
          missionPlan: flying?.plan ?? null,
          missionSeq: flying?.seq ?? 0,
          geofence: conn.mission?.plan.geofence ?? null,
        },
        t,
      );
    } catch (err) {
      const now = Date.now();
      if (now - (this.recorderErrorAt.get(conn.droneId) ?? 0) > 60_000) {
        this.recorderErrorAt.set(conn.droneId, now);
        this.deps.log.error({ err, droneId: conn.droneId }, 'flight recording failed');
      }
    }
    if (!t.armed && !t.inAir) {
      const m = conn.mission;
      const flown = conn.missionRunning;
      this.setMissionRunning(conn, false);
      // Flown to the end and landed: the mission is done (upload it again to fly it again). A
      // mission ending with return-to-launch or a landing hands over to that mode at its last
      // item, so having flown up to that item is the end.
      const last = m ? m.plan.items[m.total - 1] : undefined;
      const handedOver = !!m && flown && m.seq >= m.total - 1 && (last?.type === 'rtl' || last?.type === 'land');
      if (m && (m.seq >= m.total || handedOver)) {
        conn.mission = null;
        this.saveLoadedMission(conn);
        // The drone forgets it too, so that both agree on what is loaded (and a mission flown
        // again is uploaded – and recorded – again).
        send(conn.socket, { type: 'mission_clear', id: uuid(), missionId: m.missionId } satisfies LinkDownMessage);
        // The scheduled operation is done once its mission has been flown to the end (a flight
        // that stopped earlier leaves it uploaded, and the next flight of the mission continues it).
        const lastFlight = this.deps.db.get<{ id: string }>('SELECT id FROM flights WHERE drone_id = ? AND mission_id = ? ORDER BY started_at DESC LIMIT 1', conn.droneId, m.missionId);
        if (lastFlight) this.deps.db.run("UPDATE schedules SET status = 'completed' WHERE flight_id = ? AND status IN ('in_progress','uploaded','scheduled')", lastFlight.id);
        this.broadcastStatus(conn);
      }
    }
    const out = JSON.stringify({ type: 'telemetry', droneId: conn.droneId, data: t, at: conn.telemetryAt } satisfies LiveDownMessage);
    for (const v of this.viewersFor(conn.orgId, conn.droneId)) {
      if (v.flow) this.sendLatest(v, `telemetry:${conn.droneId}`, out);
      else if (v.socket.readyState === 1 && v.socket.bufferedAmount < MAX_TELEMETRY_BUFFER) this.toViewer(v, out);
    }
    const now = Date.now();
    if (now - conn.lastPersistAt > PERSIST_INTERVAL_MS) this.persistPosition(conn);
    if (now - conn.lastWebhookTelemetryAt >= 1000) {
      conn.lastWebhookTelemetryAt = now;
      this.deps.webhooks.emit(conn.orgId, 'telemetry', {
        droneId: conn.droneId,
        flightId: this.deps.recorder.activeFlightId(conn.droneId),
        telemetry: t,
      });
    }
  }

  private onDroneBinary(conn: DroneConn, buf: Buffer): void {
    const internal = this.internalVideo.get(conn.droneId);
    if (conn.videoViewers.size === 0 && !internal?.size) return;
    const frame = decodeLinkVideoFrame(buf);
    if (!frame) return;
    if (internal?.size) this.fire('frame', conn.orgId, conn.droneId, frame.ts, Buffer.from(frame.jpeg));
    if (conn.videoViewers.size === 0) return;
    // Viewers get the capture time in the cloud's clock (to tell how old a frame is).
    const out = encodeLiveVideoFrame(conn.droneId, this.cloudTime(conn, frame.ts), frame.stream, frame.jpeg);
    const now = Date.now();
    for (const connId of conn.videoViewers.keys()) {
      const v = this.viewers.get(connId);
      // Frames are dropped for a congested viewer so that latency never accumulates: what was
      // sent before waits too long for its acknowledgement (or fills the socket's buffer).
      if (!v || v.socket.readyState !== 1 || v.socket.bufferedAmount >= MAX_VIEWER_BUFFER || this.congested(v, now)) continue;
      this.toViewer(v, out);
    }
  }

  // ----- Internal video consumers (AI vision) ---------------------------------------------

  /** Internal consumers of a drone's video by consumer id (kept across reconnects). */
  private readonly internalVideo = new Map<string, Map<string, VideoQuality>>();

  addVideoConsumer(droneId: string, consumer: string, quality: VideoQuality = 'sd'): void {
    const m = this.internalVideo.get(droneId) ?? new Map<string, VideoQuality>();
    m.set(consumer, quality);
    this.internalVideo.set(droneId, m);
    const conn = this.drones.get(droneId);
    if (conn) this.updateVideo(conn);
  }

  removeVideoConsumer(droneId: string, consumer: string): void {
    const m = this.internalVideo.get(droneId);
    if (!m) return;
    m.delete(consumer);
    if (!m.size) this.internalVideo.delete(droneId);
    const conn = this.drones.get(droneId);
    if (conn) this.updateVideo(conn);
  }

  /** Camera model a drone declared, if any. */
  cameraOf(droneId: string): CameraInfo | null {
    return this.drones.get(droneId)?.camera ?? null;
  }

  /** The drone detects objects itself (declared in `hello`). */
  hasOnboardAi(droneId: string): boolean {
    return this.drones.get(droneId)?.capabilities.ai === true;
  }

  /** Starts or stops the on-board object detection of a drone that has it. */
  setOnboardAi(droneId: string, enabled: boolean): void {
    const conn = this.drones.get(droneId);
    if (conn?.capabilities.ai) send(conn.socket, { type: 'ai', enabled } satisfies LinkDownMessage);
  }

  /**
   * Where the drone would fly a mission started now: from its home (where it took off, and where
   * it returns to) – or, in the air, from where it is (`start`); it still returns home. Null
   * when it is not reporting.
   */
  flightStartOf(droneId: string): { home: LatLon | null; start: LatLonAlt | null } | null {
    const t = this.drones.get(droneId)?.telemetry;
    if (!t) return null;
    return {
      home: t.home ? { lat: t.home.lat, lon: t.home.lon } : t.inAir ? null : { lat: t.lat, lon: t.lon },
      start: t.inAir ? { lat: t.lat, lon: t.lon, alt: t.altRel } : null,
    };
  }

  /** A plan as the drone would fly it if started now (see `flightStartOf`). */
  flownFromHere(droneId: string, plan: MissionPlan): MissionPlan {
    const s = this.flightStartOf(droneId);
    return s ? flownFrom(plan, s.home, s.start) : plan;
  }

  /**
   * Airspace check of a mission started now (set by the app): the blocking conflicts of the route
   * the drone would fly, or null when it is clear.
   */
  missionStartCheck: ((orgId: string, droneId: string, plan: MissionPlan) => string | null) | null = null;

  /** Latest telemetry of an online drone. */
  telemetryOf(droneId: string): Telemetry | null {
    return this.drones.get(droneId)?.telemetry ?? null;
  }

  /** AI status shown with the drone state (set by the vision service). */
  aiStatus: ((droneId: string) => LiveDroneState['ai']) | null = null;

  /** Pushes a drone's state to viewers (e.g. after an AI status change). */
  refreshStatus(droneId: string): void {
    const conn = this.drones.get(droneId);
    if (conn) this.broadcastStatus(conn);
  }

  /** Records and pushes an event of a drone that the cloud raised (AI, follow-me …). */
  droneEvent(droneId: string, level: EventLevel, code: string, message: string): void {
    const conn = this.drones.get(droneId);
    if (!conn) return;
    this.deps.recorder.onEvent(droneId, { level, code, message });
    this.broadcast(conn.orgId, { type: 'event', droneId, t: Date.now(), level, code, message }, droneId);
    this.fire('event', conn.orgId, droneId, { level, code, message });
  }

  /** Sends a message to the viewers of one drone. */
  broadcastDrone(droneId: string, msg: LiveDownMessage): void {
    const conn = this.drones.get(droneId);
    if (conn) this.broadcast(conn.orgId, msg, droneId);
  }

  private onAdsb(conn: DroneConn, msg: Record<string, any>): void {
    if (!Array.isArray(msg.aircraft)) return;
    const received = Date.now();
    const aircraft: DetectedAircraft[] = msg.aircraft
      .slice(0, 100)
      .filter((a: any) => typeof a?.icao === 'string' && Number.isFinite(a.lat) && Number.isFinite(a.lon) && Number.isFinite(a.altMsl))
      .map((a: any) => ({
        icao: a.icao.slice(0, 16),
        callsign: typeof a.callsign === 'string' ? a.callsign.slice(0, 16) : undefined,
        lat: a.lat,
        lon: a.lon,
        altMsl: a.altMsl,
        heading: Number.isFinite(a.heading) ? a.heading : 0,
        speed: Number.isFinite(a.speed) ? a.speed : 0,
        // When the aircraft was reported, in the cloud's clock (viewers age the traffic by it).
        t: Number.isFinite(a.t) ? this.cloudTime(conn, a.t, received) : received,
      }));
    this.broadcast(conn.orgId, { type: 'adsb', droneId: conn.droneId, aircraft }, conn.droneId);
    // Traffic advisory when manned aircraft come close (2 km horizontally, 300 m vertically).
    const own = conn.telemetry;
    if (!own) return;
    const now = Date.now();
    for (const a of aircraft) {
      const d = haversineDistance(own, a);
      if (d < 2000 && Math.abs(a.altMsl - own.altMsl) < 300 && now - (conn.trafficAdvisories.get(a.icao) ?? 0) > 60_000) {
        conn.trafficAdvisories.set(a.icao, now);
        const message = `Traffic advisory: ${a.callsign || a.icao} at ${Math.round(d)} m, ${Math.round(a.altMsl - own.altMsl)} m relative altitude`;
        this.deps.recorder.onEvent(conn.droneId, { level: 'warning', code: 'traffic', message });
        this.broadcast(conn.orgId, { type: 'event', droneId: conn.droneId, t: now, level: 'warning', code: 'traffic', message }, conn.droneId);
        this.fire('event', conn.orgId, conn.droneId, { level: 'warning', code: 'traffic', message });
      }
    }
  }

  // ----- Commands -------------------------------------------------------------------------

  /**
   * Consulted before a command of a user (or of an automated loop acting for one) is sent: returns
   * why it is refused, or null. Swarm operations use it for their members.
   */
  private commandGuard: ((orgId: string, droneId: string, user: { id: string; name: string }, command: string, params: CommandParams) => string | null) | null = null;

  setCommandGuard(guard: (orgId: string, droneId: string, user: { id: string; name: string }, command: string, params: CommandParams) => string | null): void {
    this.commandGuard = guard;
  }

  /**
   * Sends a command on behalf of a user. Enforces permission and the control lock.
   * Resolves with the drone's first acknowledgement (or timeout).
   */
  sendCommand(
    orgId: string,
    droneId: string,
    user: { id: string; name: string; role: Role },
    command: string,
    params: CommandParams = {},
    origin: { viewerConnId: string; requestId: string } | null = null,
    /**
     * `audit: false` for automated loops (follow-me, swarm synchronisation) that audit their start
     * and stop instead; `swarm: true` for the commands of a swarm operation to its own members.
     */
    options: { audit?: boolean; swarm?: boolean } = {},
  ): Promise<CommandOutcome> {
    const reject = (message: string): Promise<CommandOutcome> => Promise.resolve({ result: 'rejected', message, delivered: false });
    const conn = this.drones.get(droneId);
    if (!conn || conn.orgId !== orgId) return reject('Drone is offline');
    if (!(COMMANDS as readonly string[]).includes(command)) return reject(`Unknown command ${command}`);
    // The role is read again for every command: automated loops (follow-me, swarm
    // synchronisation) act for a user whose role may have changed since they started.
    if (!this.mayControl(orgId, user.id)) return reject('Your role cannot control drones');
    if (conn.controller && conn.controller.userId !== user.id) return reject(`Drone is controlled by ${conn.controller.name}`);
    const clean = sanitizeParams(params);
    if (command === 'goto' && (clean.lat === undefined || clean.lon === undefined)) return reject('goto requires lat and lon');
    // A drone flying in a swarm operation: the operation decides what its members may be sent.
    if (!options.swarm && this.commandGuard) {
      const refused = this.commandGuard(orgId, droneId, user, command, clean);
      if (refused) return reject(refused);
    }
    // Whatever sets the loaded mission flying – start, resume (which starts a mission not started
    // yet, or continues a paused one from here to its next item), switching to MISSION mode – is
    // checked again from where the drone is (it may have been carried to another take-off point,
    // or flown elsewhere, since the upload) – unless an owner or administrator sent the mission
    // with its blocked check overridden.
    const fliesMission = command === 'mission_start' || command === 'mission_resume' || (command === 'set_mode' && String(clean.mode ?? '').toUpperCase() === 'MISSION');
    if (fliesMission && conn.mission && !conn.mission.airspaceAccepted && this.missionStartCheck) {
      const m = conn.mission;
      const route = command !== 'mission_start' && conn.missionRunning ? { ...m.plan, items: m.plan.items.slice(Math.max(0, Math.min(m.seq, m.plan.items.length))) } : m.plan;
      const blocked = this.missionStartCheck(orgId, droneId, this.flownFromHere(droneId, route));
      if (blocked) return reject(`Airspace check blocked for "${m.name}" flown from where ${conn.name} is now – ${blocked}. Upload the mission again to review the conflicts.`);
    }
    // Flying the drone takes its control lock; taking a photo does not (a swarm operation keeps
    // its member, another pilot keeps the drone).
    if (origin && !conn.controller && command !== 'camera_photo') this.setController(conn, { userId: user.id, name: user.name, connId: origin.viewerConnId });
    conn.lastCommander = { userId: user.id, at: Date.now() };
    this.deps.recorder.setPilotIfMissing(droneId, user.id);
    const id = uuid();
    if (options.audit !== false) audit(this.deps.db, orgId, user.id, 'drone.command', droneId, { command, params: clean });
    return new Promise((resolve) => {
      const p: PendingCommand = {
        id,
        droneId,
        command,
        viewerConnId: origin?.viewerConnId ?? null,
        requestId: origin?.requestId ?? null,
        resolve: (r) => {
          const accepted = r.result === 'accepted' || r.result === 'in_progress' || r.result === 'completed';
          // The loaded mission is being flown once the drone has accepted to start it.
          if (command === 'mission_start' && conn.mission && accepted) this.setMissionRunning(conn, true);
          if (accepted && !options.swarm) this.fire('commanded', orgId, droneId, { id: user.id, name: user.name }, command);
          resolve({ ...r, delivered: true });
        },
        timer: setTimeout(() => this.resolvePending(id, 'timeout', 'No acknowledgement from the drone'), COMMAND_TIMEOUT_MS),
      };
      this.pending.set(id, p);
      send(conn.socket, { type: 'command', id, command: command as CommandName, params: clean } satisfies LinkDownMessage);
    });
  }

  private onAck(conn: DroneConn, id: string, result: unknown, message?: string): void {
    const p = this.pending.get(id);
    if (!p || p.droneId !== conn.droneId) return;
    const r: AckResult = ['accepted', 'in_progress', 'completed', 'rejected', 'failed'].includes(result as string) ? (result as AckResult) : 'failed';
    if (r === 'in_progress') {
      // Forward progress, resolve REST callers, keep waiting for the final result.
      p.resolve?.({ result: r, message });
      p.resolve = null;
      this.notifyAck(conn, p, r, message);
      clearTimeout(p.timer);
      p.timer = setTimeout(() => this.resolvePending(id, 'timeout', 'Command did not complete in time'), LONG_COMMAND_TIMEOUT_MS);
      return;
    }
    this.resolvePending(id, r, message);
  }

  private resolvePending(id: string, result: AckResult, message?: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve?.({ result, message });
    const conn = this.drones.get(p.droneId);
    if (conn) this.notifyAck(conn, p, result, message);
    else if (p.viewerConnId) {
      const v = this.viewers.get(p.viewerConnId);
      if (v && p.requestId) this.sendViewer(v, { type: 'ack', droneId: p.droneId, requestId: p.requestId, command: p.command, result, message });
    }
  }

  private notifyAck(conn: DroneConn, p: PendingCommand, result: AckResult, message?: string): void {
    this.broadcast(
      conn.orgId,
      { type: 'ack', droneId: conn.droneId, requestId: p.requestId ?? p.id, command: p.command, result, message },
      conn.droneId,
    );
  }

  // ----- Missions -------------------------------------------------------------------------

  /** The mission loaded on the drone as uploaded (also while it is offline), or null. */
  loadedMission(droneId: string): { missionId: string; name: string; plan: MissionPlan; uploadedAt: string; start: LatLonAlt | null; seq: number; total: number } | null {
    const m = this.drones.get(droneId)?.mission;
    if (m) return { missionId: m.missionId, name: m.name, plan: m.plan, uploadedAt: m.uploadedAt, start: m.start, seq: m.seq, total: m.total };
    const row = this.deps.db.get<{ mission_id: string; name: string; plan: string; uploaded_at: string; start: string | null; total: number }>(
      'SELECT mission_id, name, plan, uploaded_at, start, total FROM drone_missions WHERE drone_id = ?',
      droneId,
    );
    const plan = row ? parseJson<MissionPlan | null>(row.plan, null) : null;
    return row && plan ? { missionId: row.mission_id, name: row.name, plan, uploadedAt: row.uploaded_at, start: parseJson<LatLonAlt | null>(row.start, null), seq: 0, total: row.total } : null;
  }

  /** Names of the organisation's connected drones that have this mission loaded. */
  dronesWithMission(orgId: string, missionId: string): string[] {
    return [...this.drones.values()].filter((c) => c.orgId === orgId && c.mission?.missionId === missionId).map((c) => c.name);
  }


  uploadMission(
    orgId: string,
    droneId: string,
    user: { id: string; role: Role },
    mission: { id: string; name: string; plan: MissionPlan; pilotId?: string | null; airspaceAccepted?: boolean },
  ): Promise<{ result: AckResult; message?: string }> {
    const conn = this.drones.get(droneId);
    if (!conn || conn.orgId !== orgId) return Promise.resolve({ result: 'rejected', message: 'Drone is offline' });
    if (!this.mayControl(orgId, user.id)) return Promise.resolve({ result: 'rejected', message: 'Your role cannot control drones' });
    if (conn.controller && conn.controller.userId !== user.id) {
      return Promise.resolve({ result: 'rejected', message: `Drone is controlled by ${conn.controller.name}` });
    }
    if (conn.telemetry?.inAir && conn.telemetry.mode === 'MISSION') {
      return Promise.resolve({ result: 'rejected', message: 'Cannot replace the mission while it is being flown' });
    }
    // A flight is recorded and analysed with one mission: once it has flown one (also paused in
    // the air), another one is flown on the next flight.
    const flying = conn.telemetry?.inAir ? (this.deps.recorder.activeFlightMission(droneId) ?? (conn.missionRunning ? (conn.mission?.missionId ?? null) : null)) : null;
    if (flying) {
      const name = conn.mission?.missionId === flying ? conn.mission.name : (this.deps.db.get<{ name: string }>('SELECT name FROM missions WHERE id = ?', flying)?.name ?? 'a mission');
      return Promise.resolve({ result: 'rejected', message: `This flight is flying "${name}" – land before uploading another mission` });
    }
    const id = uuid();
    audit(this.deps.db, orgId, user.id, 'mission.upload', droneId, { missionId: mission.id, name: mission.name });
    return new Promise((resolve) => {
      const p: PendingCommand = {
        id,
        droneId,
        command: 'mission_upload',
        viewerConnId: null,
        requestId: null,
        resolve: (r) => {
          if (r.result === 'accepted' || r.result === 'completed') {
            const navItems = mission.plan.items.length;
            conn.mission = {
              missionId: mission.id,
              name: mission.name,
              seq: 0,
              total: navItems,
              pilotId: mission.pilotId ?? user.id,
              plan: mission.plan,
              uploadedAt: nowIso(),
              start: null,
              airspaceAccepted: mission.airspaceAccepted === true,
            };
            conn.missionRunning = false;
            this.saveLoadedMission(conn);
            this.broadcastStatus(conn);
          }
          resolve(r);
        },
        timer: setTimeout(() => this.resolveMission(id, 'timeout', 'No acknowledgement from the drone'), COMMAND_TIMEOUT_MS),
      };
      this.pendingMissions.set(id, p);
      send(conn.socket, { type: 'mission_upload', id, missionId: mission.id, name: mission.name, plan: mission.plan } satisfies LinkDownMessage);
    });
  }

  private resolveMission(id: string, result: unknown, message?: string): void {
    const p = this.pendingMissions.get(id);
    if (!p) return;
    this.pendingMissions.delete(id);
    clearTimeout(p.timer);
    const r: AckResult = ['accepted', 'completed', 'rejected', 'failed', 'timeout'].includes(result as string) ? (result as AckResult) : 'failed';
    p.resolve?.({ result: r, message });
  }

  // ----- Firmware OTA -----------------------------------------------------------------------

  /** Sends the oldest pending firmware update to the drone if it is online. */
  dispatchPendingFirmware(droneId: string): void {
    const conn = this.drones.get(droneId);
    if (!conn || !conn.helloReceived) return;
    const upd = this.deps.db.get<{ id: string; version: string; sha256: string; size: number }>(
      `SELECT u.id, p.version, p.sha256, p.size FROM firmware_updates u JOIN firmware_packages p ON p.id = u.package_id
        WHERE u.drone_id = ? AND u.status = 'pending' ORDER BY u.created_at LIMIT 1`,
      droneId,
    );
    if (!upd) return;
    this.deps.db.run("UPDATE firmware_updates SET status = 'sent', updated_at = ? WHERE id = ?", nowIso(), upd.id);
    send(conn.socket, {
      type: 'firmware_update',
      updateId: upd.id,
      version: upd.version,
      url: this.deps.firmwareDownloadUrl(upd.id),
      sha256: upd.sha256,
      size: upd.size,
    } satisfies LinkDownMessage);
    this.broadcast(conn.orgId, { type: 'firmware_progress', droneId, updateId: upd.id, status: 'sent', progress: 0 }, droneId);
  }

  private onFirmwareProgress(conn: DroneConn, msg: Record<string, any>): void {
    if (typeof msg.updateId !== 'string') return;
    const upd = this.deps.db.get<{ id: string; status: string; version: string }>(
      `SELECT u.id, u.status, p.version FROM firmware_updates u JOIN firmware_packages p ON p.id = u.package_id
        WHERE u.id = ? AND u.drone_id = ?`,
      msg.updateId,
      conn.droneId,
    );
    if (!upd || ['completed', 'failed', 'cancelled'].includes(upd.status)) return;
    const status = ['downloading', 'verifying', 'installing', 'completed', 'failed'].includes(msg.status) ? msg.status : null;
    if (!status) return;
    const progress = Math.max(0, Math.min(100, Number(msg.progress) || 0));
    const error = status === 'failed' ? String(msg.message ?? 'Update failed').slice(0, 300) : null;
    this.deps.db.run('UPDATE firmware_updates SET status = ?, progress = ?, error = ?, updated_at = ? WHERE id = ?', status, status === 'completed' ? 100 : progress, error, nowIso(), upd.id);
    if (status === 'completed') {
      conn.firmware = upd.version;
      this.deps.db.run('UPDATE drones SET firmware_version = ? WHERE id = ?', upd.version, conn.droneId);
      this.deps.webhooks.emit(conn.orgId, 'firmware.updated', { droneId: conn.droneId, updateId: upd.id, version: upd.version });
      this.broadcastStatus(conn);
    }
    this.broadcast(conn.orgId, { type: 'firmware_progress', droneId: conn.droneId, updateId: upd.id, status, progress, message: error ?? undefined }, conn.droneId);
  }

  private completeFirmwareIfInstalled(conn: DroneConn): void {
    if (!conn.firmware) return;
    const rows = this.deps.db.all<{ id: string }>(
      `SELECT u.id FROM firmware_updates u JOIN firmware_packages p ON p.id = u.package_id
        WHERE u.drone_id = ? AND u.status IN ('sent','downloading','verifying','installing') AND p.version = ?`,
      conn.droneId,
      conn.firmware,
    );
    for (const r of rows) {
      this.deps.db.run("UPDATE firmware_updates SET status = 'completed', progress = 100, updated_at = ? WHERE id = ?", nowIso(), r.id);
    }
  }

  // ----- Latency probes ------------------------------------------------------------------------

  /** Probes each drone's clock and round trip (one probe at a time). */
  private probeDrones(): void {
    const now = Date.now();
    for (const conn of this.drones.values()) {
      if (!conn.helloReceived || conn.removed) continue;
      // A probe left unanswered is given up after a while (the keepalive ends a dead link).
      if (conn.probe && now - conn.probe.sentAt < 30_000) continue;
      conn.probe = { id: `clock-${uuid()}`, sentAt: now };
      send(conn.socket, { type: 'ping', id: conn.probe.id, t: now } satisfies LinkDownMessage);
    }
  }

  /**
   * A time of the drone's clock in the cloud's – never later than `now` (nothing the drone
   * reports happened after it arrived); the time of arrival until the drone's clock is known.
   */
  private cloudTime(conn: DroneConn, droneTime: number, now = Date.now()): number {
    return conn.clock ? Math.min(now, Math.round(droneTime - conn.clock.offset)) : now;
  }

  private onDronePong(conn: DroneConn, msg: Record<string, any>): void {
    if (conn.probe && msg.id === conn.probe.id) {
      const now = Date.now();
      const rtt = now - conn.probe.sentAt;
      const sentAt = conn.probe.sentAt;
      conn.probe = null;
      if (typeof msg.t !== 'number' || !Number.isFinite(msg.t)) return;
      // NTP-style: the drone answered half-way through the round trip (within ± rtt / 2).
      const offset = msg.t - (sentAt + now) / 2;
      const best = conn.clock;
      // The probe with the shortest round trip is the most accurate; a newer one replaces it
      // when that one is old or the two cannot both be right (the drone's clock was set).
      const jumped = !!best && Math.abs(offset - best.offset) > (rtt + best.rtt) / 2 + 50;
      if (!best || jumped || rtt <= best.rtt || now - best.at > 60_000) conn.clock = { offset, rtt, at: now };
      return;
    }
    const p = typeof msg.id === 'string' ? this.pings.get(msg.id) : undefined;
    if (!p) return;
    this.pings.delete(msg.id);
    clearTimeout(p.timer);
    const v = this.viewers.get(p.viewerConnId);
    if (v) {
      this.sendViewer(v, { type: 'pong', id: p.viewerPingId, t: p.viewerT, serverTime: Date.now(), droneRttMs: Date.now() - p.sentAt });
    }
    void conn;
  }

  // =======================================================================================
  // Viewer side (Athena Live)
  // =======================================================================================

  handleLiveConnection(
    socket: WebSocket,
    viewer: { orgId: string; userId: string; userName: string; role: Role; via: 'session' | 'token'; authKey: string },
  ): void {
    const v: ViewerConn = { ...viewer, connId: uuid(), socket, since: Date.now(), subscriptions: 'all', alive: true, missedPongs: 0, sent: 0, flow: null };
    this.viewers.set(v.connId, v);
    socket.on('pong', () => {
      v.alive = true;
      v.missedPongs = 0;
    });
    // A pilot reconnecting within the grace period gets the control lock back.
    for (const conn of this.drones.values()) {
      if (conn.orgId === v.orgId && conn.controller && conn.controller.connId === null && conn.controller.userId === v.userId && can(v.role, 'drone.control')) {
        conn.controller = { ...conn.controller, connId: v.connId };
        if (conn.controllerGraceTimer) clearTimeout(conn.controllerGraceTimer);
        conn.controllerGraceTimer = null;
      }
    }
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        this.onViewerMessage(v, JSON.parse(toBuffer(data).toString('utf8')) as LiveUpMessage);
      } catch {
        this.sendViewer(v, { type: 'error', message: 'invalid message' });
      }
    });
    socket.on('close', () => this.onViewerClose(v));
    socket.on('error', () => undefined);
    this.sendViewer(v, { type: 'hello', userId: v.userId, orgId: v.orgId, serverTime: Date.now(), canControl: can(v.role, 'drone.control'), role: v.role });
    this.sendViewer(v, { type: 'snapshot', drones: this.orgDroneStates(v.orgId), users: this.onlineUsers(v.orgId) });
    this.broadcastUsers(v.orgId);
  }

  private onViewerClose(v: ViewerConn): void {
    this.viewers.delete(v.connId);
    if (this.stopping) return;
    for (const conn of this.drones.values()) {
      if (conn.controller?.connId === v.connId) {
        // Keep the lock for a short grace period (network hiccup, page reload): the same
        // user's next connection takes it over; otherwise it is released.
        conn.controller = { ...conn.controller, connId: null };
        if (conn.controllerGraceTimer) clearTimeout(conn.controllerGraceTimer);
        const droneId = conn.droneId;
        conn.controllerGraceTimer = setTimeout(() => {
          // The drone may have reconnected meanwhile: act on its current connection.
          const cur = this.drones.get(droneId) ?? conn;
          cur.controllerGraceTimer = null;
          if (cur.controller && cur.controller.connId === null) this.setController(cur, null);
        }, this.controlGraceMs);
        conn.controllerGraceTimer.unref?.();
      }
      if (conn.videoViewers.delete(v.connId)) this.updateVideo(conn);
    }
    for (const [id, p] of this.pings) {
      if (p.viewerConnId === v.connId) {
        clearTimeout(p.timer);
        this.pings.delete(id);
      }
    }
    this.broadcastUsers(v.orgId);
  }

  private droneForViewer(v: ViewerConn, droneId: unknown): DroneConn | null {
    if (typeof droneId !== 'string') return null;
    const conn = this.drones.get(droneId);
    return conn && conn.orgId === v.orgId ? conn : null;
  }

  private onViewerMessage(v: ViewerConn, msg: LiveUpMessage): void {
    switch (msg.type) {
      case 'subscribe':
        v.subscriptions = msg.droneIds === 'all' ? 'all' : new Set(Array.isArray(msg.droneIds) ? msg.droneIds.filter((x) => typeof x === 'string').slice(0, 500) : []);
        return;
      case 'video': {
        const conn = this.droneForViewer(v, msg.droneId);
        if (!conn) return this.sendViewer(v, { type: 'error', message: 'Drone is offline' });
        if (msg.enabled) conn.videoViewers.set(v.connId, msg.quality === 'hd' ? 'hd' : 'sd');
        else conn.videoViewers.delete(v.connId);
        this.updateVideo(conn);
        return;
      }
      case 'command': {
        const requestId = typeof msg.requestId === 'string' ? msg.requestId.slice(0, 64) : uuid();
        if (!this.refreshRole(v)) return;
        const conn = this.droneForViewer(v, msg.droneId);
        if (!conn) {
          return this.sendViewer(v, { type: 'ack', droneId: String(msg.droneId), requestId, command: String(msg.command), result: 'rejected', message: 'Drone is offline' });
        }
        void this.sendCommand(v.orgId, conn.droneId, { id: v.userId, name: v.userName, role: v.role }, String(msg.command), msg.params ?? {}, {
          viewerConnId: v.connId,
          requestId,
        }).then((r) => {
          if (!r.delivered) {
            // Rejected before reaching the drone: tell only the requester.
            this.sendViewer(v, { type: 'ack', droneId: conn.droneId, requestId, command: String(msg.command), result: r.result, message: r.message });
          }
        });
        return;
      }
      case 'control': {
        const conn = this.droneForViewer(v, msg.droneId);
        if (!conn) return this.sendViewer(v, { type: 'error', message: 'Drone is offline' });
        if (msg.action !== 'release' && !this.refreshRole(v)) return;
        if (msg.action === 'release') {
          if (conn.controller?.userId === v.userId) this.setController(conn, null);
          return;
        }
        if (!can(v.role, 'drone.control')) return this.sendViewer(v, { type: 'error', message: 'Your role cannot control drones' });
        if (conn.controller && conn.controller.userId !== v.userId) {
          if (msg.action === 'force' && can(v.role, 'drone.manage')) {
            audit(this.deps.db, v.orgId, v.userId, 'drone.control.override', conn.droneId, { previous: conn.controller.name });
          } else {
            return this.sendViewer(v, { type: 'error', message: `Drone is controlled by ${conn.controller.name}` });
          }
        }
        this.setController(conn, { userId: v.userId, name: v.userName, connId: v.connId });
        this.deps.recorder.setPilotIfMissing(conn.droneId, v.userId);
        return;
      }
      case 'manual_control': {
        const conn = this.droneForViewer(v, msg.droneId);
        if (!conn || conn.controller?.connId !== v.connId) return;
        const now = Date.now();
        if (now - conn.lastManualAt < 20) return; // ≤ 50 Hz
        conn.lastManualAt = now;
        send(conn.socket, { type: 'manual_control', x: clampAxis(msg.x), y: clampAxis(msg.y), z: clampAxis(msg.z), r: clampAxis(msg.r), t: now } satisfies LinkDownMessage);
        return;
      }
      case 'ack':
        return this.onViewerAck(v, msg.n);
      case 'ping': {
        const id = typeof msg.id === 'string' ? msg.id.slice(0, 64) : '';
        const t = typeof msg.t === 'number' ? msg.t : 0;
        const conn = msg.droneId ? this.droneForViewer(v, msg.droneId) : null;
        if (!conn) return this.sendViewer(v, { type: 'pong', id, t, serverTime: Date.now() });
        const pingId = uuid();
        this.pings.set(pingId, {
          viewerConnId: v.connId,
          viewerPingId: id,
          viewerT: t,
          sentAt: Date.now(),
          timer: setTimeout(() => {
            this.pings.delete(pingId);
            this.sendViewer(v, { type: 'pong', id, t, serverTime: Date.now() });
          }, 5000),
        });
        send(conn.socket, { type: 'ping', id: pingId, t: Date.now() } satisfies LinkDownMessage);
        return;
      }
      default:
        this.sendViewer(v, { type: 'error', message: 'unknown message type' });
    }
  }

  private setController(conn: DroneConn, controller: (ControllerInfo & { connId: string | null }) | null): void {
    const before = conn.controller?.userId ?? null;
    conn.controller = controller;
    const info = controller ? { userId: controller.userId, name: controller.name } : null;
    this.broadcast(conn.orgId, { type: 'control', droneId: conn.droneId, controller: info }, conn.droneId);
    if ((controller?.userId ?? null) !== before) this.fire('control', conn.orgId, conn.droneId, info);
  }

  /** Name of a drone (online or not) of an organisation. */
  droneName(droneId: string): string | null {
    return this.drones.get(droneId)?.name ?? this.deps.db.get<{ name: string }>('SELECT name FROM drones WHERE id = ?', droneId)?.name ?? null;
  }

  private updateVideo(conn: DroneConn): void {
    if (!conn.helloReceived) return;
    const all = [...conn.videoViewers.values(), ...(this.internalVideo.get(conn.droneId)?.values() ?? [])];
    const wanted: VideoQuality | null = all.length === 0 ? null : all.includes('hd') ? 'hd' : 'sd';
    if (wanted === conn.videoActive) return;
    conn.videoActive = wanted;
    send(conn.socket, wanted ? { type: 'video', action: 'start', quality: wanted } : { type: 'video', action: 'stop', quality: 'sd' });
  }

  // =======================================================================================
  // State & broadcasting
  // =======================================================================================

  private *viewersFor(orgId: string, droneId?: string): Iterable<ViewerConn> {
    for (const v of this.viewers.values()) {
      if (v.orgId !== orgId) continue;
      if (droneId && v.subscriptions !== 'all' && !v.subscriptions.has(droneId)) continue;
      yield v;
    }
  }

  broadcast(orgId: string, msg: LiveDownMessage, droneId?: string): void {
    const out = JSON.stringify(msg);
    for (const v of this.viewersFor(orgId, droneId)) {
      // A drone's state carries its latest telemetry: what was kept back of it is older.
      if (msg.type === 'status') v.flow?.held.delete(`telemetry:${msg.drone.droneId}`);
      // Detections come with each analysed frame: only the latest waits for a congested link.
      if (msg.type === 'detections' && v.flow) this.sendLatest(v, `detections:${msg.droneId}`, out);
      else this.toViewer(v, out);
    }
  }

  // ----- Sending to viewers (flow control) -------------------------------------------------

  /** Sends to a viewer, counting the message for the viewer's acknowledgements. */
  private toViewer(v: ViewerConn, data: string | Uint8Array): void {
    if (v.socket.readyState !== 1) return;
    v.socket.send(data);
    v.sent++;
    const f = v.flow;
    if (!f) return;
    f.marks.push({ n: v.sent, at: Date.now() });
    // A viewer that stops acknowledging keeps its oldest message waiting (its link stays
    // congested); the marks after it are thinned out.
    if (f.marks.length > 4096) f.marks.splice(1, 2048);
  }

  private sendViewer(v: ViewerConn, msg: LiveDownMessage): void {
    this.toViewer(v, JSON.stringify(msg));
  }

  /**
   * Whether what was sent to the viewer waits too long for its acknowledgement: its link is slow
   * or stalled (only known of viewers that acknowledge).
   */
  private congested(v: ViewerConn, now = Date.now()): boolean {
    const f = v.flow;
    const oldest = f?.marks[0];
    if (!f || !oldest) return false;
    const rtt = Math.min(VIEWER_MAX_RTT_MS, f.rttCur, f.rttPrev);
    return now - oldest.at > rtt + VIEWER_LAG_BUDGET_MS;
  }

  /**
   * Sends a message of which only the latest matters (a drone's telemetry, its detections): it
   * waits, replacing the one before, while the viewer's link is congested.
   */
  private sendLatest(v: ViewerConn, key: string, out: string): void {
    const f = v.flow;
    if (f && this.congested(v)) {
      f.held.set(key, out);
      return;
    }
    f?.held.delete(key);
    this.toViewer(v, out);
  }

  /** The viewer acknowledged the first `n` messages of the connection. */
  private onViewerAck(v: ViewerConn, n: unknown): void {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return;
    const now = Date.now();
    const f = (v.flow ??= { acked: 0, marks: [], rttCur: Infinity, rttPrev: Infinity, rttWindowAt: now, held: new Map() });
    const acked = Math.min(n, v.sent);
    if (acked < f.acked) return;
    f.acked = acked;
    let last: { n: number; at: number } | undefined;
    while (f.marks.length && f.marks[0]!.n <= acked) last = f.marks.shift();
    if (last) {
      if (now - f.rttWindowAt > 10_000) {
        f.rttPrev = f.rttCur;
        f.rttCur = Infinity;
        f.rttWindowAt = now;
      }
      f.rttCur = Math.min(f.rttCur, now - last.at);
    }
    if (f.held.size && !this.congested(v, now)) {
      const held = [...f.held.values()];
      f.held.clear();
      for (const out of held) this.toViewer(v, out);
    }
  }

  private broadcastStatus(conn: DroneConn): void {
    const state = this.droneState(conn.droneId);
    if (state) this.broadcast(conn.orgId, { type: 'status', drone: state }, conn.droneId);
  }

  private broadcastUsers(orgId: string): void {
    this.broadcast(orgId, { type: 'users', users: this.onlineUsers(orgId) });
  }

  /** Called by REST routes after a drone's name / fleet changes. */
  refreshDroneMeta(droneId: string): void {
    const conn = this.drones.get(droneId);
    const meta = this.loadMeta(droneId);
    if (conn && meta) {
      conn.name = meta.name;
      conn.fleetId = meta.fleetId;
      conn.model = meta.model ?? conn.model;
      this.broadcastStatus(conn);
    }
  }

  disconnectDrone(droneId: string, reason: string): void {
    const conn = this.drones.get(droneId);
    if (conn) conn.socket.close(4410, reason.slice(0, 100));
  }

  /** The drone was deleted (its flights with it): its link is closed and nothing more is recorded. */
  removeDrone(droneId: string, reason = 'drone deleted'): void {
    this.deps.recorder.forget(droneId);
    const conn = this.drones.get(droneId);
    if (!conn) return;
    conn.removed = true;
    conn.socket.close(4410, reason.slice(0, 100));
  }

  isOnline(droneId: string): boolean {
    return this.drones.has(droneId);
  }

  onlineDroneIds(orgId: string): string[] {
    return [...this.drones.values()].filter((d) => d.orgId === orgId).map((d) => d.droneId);
  }

  droneState(droneId: string): LiveDroneState | null {
    const conn = this.drones.get(droneId);
    if (conn) return this.stateOf(conn);
    const meta = this.loadMeta(droneId);
    if (!meta) return null;
    const row = this.deps.db.get<{ last_seen_at: string | null }>('SELECT last_seen_at FROM drones WHERE id = ?', droneId);
    return {
      droneId,
      name: meta.name,
      fleetId: meta.fleetId,
      model: meta.model,
      firmware: meta.firmware,
      online: false,
      connectedAt: null,
      lastSeenAt: row?.last_seen_at ? new Date(row.last_seen_at).getTime() : null,
      telemetry: null,
      controller: null,
      flightId: this.deps.recorder.activeFlightId(droneId),
      videoAvailable: false,
      mission: null,
    };
  }

  private stateOf(conn: DroneConn): LiveDroneState {
    return {
      droneId: conn.droneId,
      name: conn.name,
      fleetId: conn.fleetId,
      model: conn.model,
      firmware: conn.firmware,
      online: true,
      connectedAt: conn.connectedAt,
      lastSeenAt: Date.now(),
      telemetry: conn.telemetry,
      telemetryAt: conn.telemetryAt,
      controller: conn.controller ? { userId: conn.controller.userId, name: conn.controller.name } : null,
      flightId: this.deps.recorder.activeFlightId(conn.droneId),
      videoAvailable: conn.capabilities.video === true,
      mission: conn.mission
        ? { missionId: conn.mission.missionId, name: conn.mission.name, seq: conn.mission.seq, total: conn.mission.total, uploadedAt: conn.mission.uploadedAt, start: conn.mission.start }
        : null,
      ai: this.aiStatus?.(conn.droneId) ?? null,
    };
  }

  orgDroneStates(orgId: string): LiveDroneState[] {
    const ids = this.deps.db.all<{ id: string }>('SELECT id FROM drones WHERE org_id = ? ORDER BY name', orgId);
    return ids.map((r) => this.droneState(r.id)).filter((s): s is LiveDroneState => s !== null);
  }

  onlineUsers(orgId: string): OnlineUser[] {
    const byUser = new Map<string, OnlineUser>();
    for (const v of this.viewers.values()) {
      if (v.orgId !== orgId || v.via !== 'session') continue;
      const existing = byUser.get(v.userId);
      if (!existing || existing.since > v.since) byUser.set(v.userId, { userId: v.userId, name: v.userName, role: v.role, since: v.since });
    }
    return [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // ----- Authorisation life-cycle of open viewer sockets ------------------------------------

  /** Re-reads the viewer's role from the database (membership may have changed). */
  private refreshRole(v: ViewerConn): boolean {
    const m = this.deps.db.get<{ role: string }>('SELECT role FROM memberships WHERE org_id = ? AND user_id = ?', v.orgId, v.userId);
    if (!m || !isRole(m.role)) {
      this.revokeUser(v.orgId, v.userId);
      return false;
    }
    if (m.role !== v.role) this.updateUserRole(v.orgId, v.userId, m.role);
    return true;
  }

  private authStillValid(v: ViewerConn): boolean {
    const now = nowIso();
    if (v.via === 'session') return !!this.deps.db.get('SELECT 1 FROM sessions WHERE id = ? AND expires_at > ?', v.authKey, now);
    return !!this.deps.db.get('SELECT 1 FROM api_tokens WHERE id = ? AND (expires_at IS NULL OR expires_at > ?)', v.authKey, now);
  }

  private releaseLocksOf(orgId: string, userId: string): void {
    for (const conn of this.drones.values()) {
      if (conn.orgId === orgId && conn.controller?.userId === userId) this.setController(conn, null);
    }
  }

  /** Current role of a member (null when not a member). */
  memberRole(orgId: string, userId: string): Role | null {
    const m = this.deps.db.get<{ role: string }>('SELECT role FROM memberships WHERE org_id = ? AND user_id = ?', orgId, userId);
    return m && isRole(m.role) ? m.role : null;
  }

  /** Whether the user may control drones of the organisation right now. */
  mayControl(orgId: string, userId: string): boolean {
    const role = this.memberRole(orgId, userId);
    return !!role && can(role, 'drone.control');
  }

  /** A member was removed: close their live sockets and release their control locks. */
  revokeUser(orgId: string, userId: string): void {
    this.releaseLocksOf(orgId, userId);
    for (const v of [...this.viewers.values()]) {
      if (v.orgId === orgId && v.userId === userId) v.socket.close(4403, 'membership revoked');
    }
    this.fire('member', orgId, userId, null);
  }

  /** A member's role changed: apply it to open sockets immediately. */
  updateUserRole(orgId: string, userId: string, role: Role): void {
    if (!can(role, 'drone.control')) this.releaseLocksOf(orgId, userId);
    for (const v of this.viewers.values()) {
      if (v.orgId !== orgId || v.userId !== userId) continue;
      v.role = role;
      this.sendViewer(v, { type: 'hello', userId: v.userId, orgId: v.orgId, serverTime: Date.now(), canControl: can(role, 'drone.control'), role });
    }
    this.broadcastUsers(orgId);
    this.fire('member', orgId, userId, role);
  }

  /** A session ended or an API token was revoked. */
  closeAuth(authKey: string): void {
    for (const v of [...this.viewers.values()]) if (v.authKey === authKey) v.socket.close(4401, 'session ended');
  }

  /** The organisation was deleted. */
  closeOrg(orgId: string, droneIds: string[] = []): void {
    for (const v of [...this.viewers.values()]) if (v.orgId === orgId) v.socket.close(4404, 'organisation deleted');
    for (const conn of [...this.drones.values()]) if (conn.orgId === orgId) this.removeDrone(conn.droneId, 'organisation deleted');
    for (const id of droneIds) this.deps.recorder.forget(id);
  }

  private heartbeat(): void {
    for (const conn of this.drones.values()) {
      if (!conn.alive) {
        conn.socket.terminate();
        continue;
      }
      conn.alive = false;
      try {
        conn.socket.ping();
      } catch {
        /* closed */
      }
    }
    for (const v of this.viewers.values()) {
      if (!v.alive && ++v.missedPongs >= MAX_MISSED_PONGS) {
        v.socket.terminate();
        continue;
      }
      if (!this.authStillValid(v)) {
        v.socket.close(4401, 'authentication expired');
        continue;
      }
      v.alive = false;
      try {
        v.socket.ping();
      } catch {
        /* closed */
      }
    }
  }

  shutdown(): void {
    this.stopping = true;
    clearInterval(this.keepalive);
    clearInterval(this.prober);
    for (const conn of this.drones.values()) {
      try {
        this.persistPosition(conn);
      } catch (err) {
        this.deps.log.warn({ err, droneId: conn.droneId }, 'drone position not saved');
      }
    }
    for (const p of this.pending.values()) clearTimeout(p.timer);
    for (const p of this.pendingMissions.values()) clearTimeout(p.timer);
    for (const p of this.pings.values()) clearTimeout(p.timer);
    for (const conn of this.drones.values()) conn.socket.close(1001, 'server shutting down');
    for (const v of this.viewers.values()) v.socket.close(1001, 'server shutting down');
  }
}

function sanitizeParams(p: CommandParams): CommandParams {
  const out: CommandParams = {};
  const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);
  if (!p || typeof p !== 'object') return out;
  const alt = num(p.alt, 0, 5000);
  if (alt !== undefined) out.alt = alt;
  const lat = num(p.lat, -90, 90);
  const lon = num(p.lon, -180, 180);
  if (lat !== undefined && lon !== undefined) {
    out.lat = lat;
    out.lon = lon;
  }
  if (typeof p.mode === 'string' && /^[A-Z_]{2,16}$/.test(p.mode)) out.mode = p.mode;
  const speed = num(p.speed, 0.1, 50);
  if (speed !== undefined) out.speed = speed;
  const yaw = num(p.yaw, 0, 360);
  if (yaw !== undefined) out.yaw = yaw % 360;
  const fromSeq = num(p.fromSeq, 0, 10000);
  if (fromSeq !== undefined) out.fromSeq = Math.round(fromSeq);
  return out;
}
