import type { FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import {
  COMMANDS,
  can,
  isRole,
  clampAxis,
  decodeLinkVideoFrame,
  encodeLiveVideoFrame,
  haversineDistance,
  sanitizeTelemetry,
  type AckResult,
  type CommandName,
  type CommandParams,
  type ControllerInfo,
  type DetectedAircraft,
  type EventLevel,
  type LinkDownMessage,
  type LiveDownMessage,
  type LiveDroneState,
  type LiveUpMessage,
  type MissionPlan,
  type OnlineUser,
  type Role,
  type Telemetry,
  type VideoQuality,
} from '@athena-sky/shared';
import type { Db } from '../db/database';
import type { FlightRecorder } from '../flights/recorder';
import type { WebhookDispatcher } from '../integrations/webhooks';
import { audit } from '../lib/audit';
import { sha256Hex } from '../lib/crypto';
import { nowIso, uuid } from '../lib/util';

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
  capabilities: { video?: boolean; manualControl?: boolean; adsb?: boolean };
  telemetry: Telemetry | null;
  controller: (ControllerInfo & { connId: string | null }) | null;
  controllerGraceTimer: NodeJS.Timeout | null;
  videoViewers: Map<string, VideoQuality>;
  videoActive: VideoQuality | null;
  mission: { missionId: string; name: string; seq: number; total: number; pilotId: string | null } | null;
  lastPersistAt: number;
  lastWebhookTelemetryAt: number;
  lastManualAt: number;
  alive: boolean;
  trafficAdvisories: Map<string, number>;
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
}

const COMMAND_TIMEOUT_MS = 10_000;
/** A pilot who loses the connection keeps the control lock this long to reconnect. */
export const CONTROL_GRACE_MS = 15_000;
/** Viewer sockets are closed after this many heartbeats without a pong. */
const MAX_MISSED_PONGS = 2;
const LONG_COMMAND_TIMEOUT_MS = 120_000;
const MAX_VIEWER_BUFFER = 1_000_000;
const MAX_TELEMETRY_BUFFER = 256_000;
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

/**
 * Real-time hub: terminates Athena Link connections from drones and Athena Live
 * connections from browsers / integrations, and routes telemetry, video, commands,
 * mission uploads, firmware updates and latency probes between them.
 */
export class Hub {
  /** Grace period of a disconnected pilot's control lock (ms). */
  controlGraceMs = CONTROL_GRACE_MS;
  private readonly drones = new Map<string, DroneConn>();
  private readonly viewers = new Map<string, ViewerConn>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly pendingMissions = new Map<string, PendingCommand>();
  private readonly pings = new Map<string, PendingPing>();
  private readonly keepalive: ReturnType<typeof setInterval>;

  constructor(private readonly deps: HubDeps) {
    this.keepalive = setInterval(() => this.heartbeat(), KEEPALIVE_MS);
    this.keepalive.unref?.();
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
      telemetry: null,
      controller: previous?.controller ?? null,
      controllerGraceTimer: previous?.controllerGraceTimer ?? null,
      videoViewers: previous?.videoViewers ?? new Map(),
      videoActive: null,
      mission: previous?.mission ?? null,
      lastPersistAt: 0,
      lastWebhookTelemetryAt: 0,
      lastManualAt: 0,
      alive: true,
      trafficAdvisories: new Map(),
    };
    this.drones.set(meta.droneId, conn);
    socket.on('pong', () => {
      conn.alive = true;
    });
    socket.on('message', (data, isBinary) => {
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
  }

  private onDroneClose(conn: DroneConn): void {
    if (this.drones.get(conn.droneId) !== conn) return; // replaced
    this.drones.delete(conn.droneId);
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
      };
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
    this.completeFirmwareIfInstalled(conn);
    this.broadcastStatus(conn);
    this.updateVideo(conn);
    this.dispatchPendingFirmware(conn.droneId);
  }

  private onTelemetry(conn: DroneConn, msg: Record<string, unknown>): void {
    const t = sanitizeTelemetry(msg);
    if (!t) return;
    conn.telemetry = t;
    const pilotId = conn.controller?.userId ?? conn.mission?.pilotId ?? null;
    this.deps.recorder.onTelemetry(
      { orgId: conn.orgId, droneId: conn.droneId, pilotId, missionId: conn.mission?.missionId ?? null },
      t,
    );
    const out = JSON.stringify({ type: 'telemetry', droneId: conn.droneId, data: t } satisfies LiveDownMessage);
    for (const v of this.viewersFor(conn.orgId, conn.droneId)) {
      if (v.socket.readyState === 1 && v.socket.bufferedAmount < MAX_TELEMETRY_BUFFER) v.socket.send(out);
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
    const frame = decodeLinkVideoFrame(buf);
    if (!frame || conn.videoViewers.size === 0) return;
    const out = encodeLiveVideoFrame(conn.droneId, frame.ts, frame.stream, frame.jpeg);
    for (const connId of conn.videoViewers.keys()) {
      const v = this.viewers.get(connId);
      // Drop frames for congested viewers so latency never accumulates.
      if (v && v.socket.readyState === 1 && v.socket.bufferedAmount < MAX_VIEWER_BUFFER) v.socket.send(out);
    }
  }

  private onAdsb(conn: DroneConn, msg: Record<string, any>): void {
    if (!Array.isArray(msg.aircraft)) return;
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
        t: Number.isFinite(a.t) ? a.t : Date.now(),
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
      }
    }
  }

  // ----- Commands -------------------------------------------------------------------------

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
  ): Promise<CommandOutcome> {
    const reject = (message: string): Promise<CommandOutcome> => Promise.resolve({ result: 'rejected', message, delivered: false });
    const conn = this.drones.get(droneId);
    if (!conn || conn.orgId !== orgId) return reject('Drone is offline');
    if (!(COMMANDS as readonly string[]).includes(command)) return reject(`Unknown command ${command}`);
    if (!can(user.role, 'drone.control')) return reject('Your role cannot control drones');
    if (conn.controller && conn.controller.userId !== user.id) return reject(`Drone is controlled by ${conn.controller.name}`);
    const clean = sanitizeParams(params);
    if (command === 'goto' && (clean.lat === undefined || clean.lon === undefined)) return reject('goto requires lat and lon');
    if (origin && !conn.controller) this.setController(conn, { userId: user.id, name: user.name, connId: origin.viewerConnId });
    this.deps.recorder.setPilotIfMissing(droneId, user.id);
    const id = uuid();
    audit(this.deps.db, orgId, user.id, 'drone.command', droneId, { command, params: clean });
    return new Promise((resolve) => {
      const p: PendingCommand = {
        id,
        droneId,
        command,
        viewerConnId: origin?.viewerConnId ?? null,
        requestId: origin?.requestId ?? null,
        resolve: (r) => resolve({ ...r, delivered: true }),
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
      if (v && p.requestId) send(v.socket, { type: 'ack', droneId: p.droneId, requestId: p.requestId, command: p.command, result, message } satisfies LiveDownMessage);
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

  uploadMission(
    orgId: string,
    droneId: string,
    user: { id: string; role: Role },
    mission: { id: string; name: string; plan: MissionPlan; pilotId?: string | null },
  ): Promise<{ result: AckResult; message?: string }> {
    const conn = this.drones.get(droneId);
    if (!conn || conn.orgId !== orgId) return Promise.resolve({ result: 'rejected', message: 'Drone is offline' });
    if (conn.controller && conn.controller.userId !== user.id) {
      return Promise.resolve({ result: 'rejected', message: `Drone is controlled by ${conn.controller.name}` });
    }
    if (conn.telemetry?.inAir && conn.telemetry.mode === 'MISSION') {
      return Promise.resolve({ result: 'rejected', message: 'Cannot replace the mission while it is being flown' });
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
            conn.mission = { missionId: mission.id, name: mission.name, seq: 0, total: navItems, pilotId: mission.pilotId ?? user.id };
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

  private onDronePong(conn: DroneConn, msg: Record<string, any>): void {
    const p = typeof msg.id === 'string' ? this.pings.get(msg.id) : undefined;
    if (!p) return;
    this.pings.delete(msg.id);
    clearTimeout(p.timer);
    const v = this.viewers.get(p.viewerConnId);
    if (v) {
      send(v.socket, { type: 'pong', id: p.viewerPingId, t: p.viewerT, serverTime: Date.now(), droneRttMs: Date.now() - p.sentAt } satisfies LiveDownMessage);
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
    const v: ViewerConn = { ...viewer, connId: uuid(), socket, since: Date.now(), subscriptions: 'all', alive: true, missedPongs: 0 };
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
        send(socket, { type: 'error', message: 'invalid message' } satisfies LiveDownMessage);
      }
    });
    socket.on('close', () => this.onViewerClose(v));
    socket.on('error', () => undefined);
    send(socket, { type: 'hello', userId: v.userId, orgId: v.orgId, serverTime: Date.now(), canControl: can(v.role, 'drone.control') } satisfies LiveDownMessage);
    send(socket, { type: 'snapshot', drones: this.orgDroneStates(v.orgId), users: this.onlineUsers(v.orgId) } satisfies LiveDownMessage);
    this.broadcastUsers(v.orgId);
  }

  private onViewerClose(v: ViewerConn): void {
    this.viewers.delete(v.connId);
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
        if (!conn) return send(v.socket, { type: 'error', message: 'Drone is offline' } satisfies LiveDownMessage);
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
          return send(v.socket, { type: 'ack', droneId: String(msg.droneId), requestId, command: String(msg.command), result: 'rejected', message: 'Drone is offline' } satisfies LiveDownMessage);
        }
        void this.sendCommand(v.orgId, conn.droneId, { id: v.userId, name: v.userName, role: v.role }, String(msg.command), msg.params ?? {}, {
          viewerConnId: v.connId,
          requestId,
        }).then((r) => {
          if (!r.delivered) {
            // Rejected before reaching the drone: tell only the requester.
            send(v.socket, { type: 'ack', droneId: conn.droneId, requestId, command: String(msg.command), result: r.result, message: r.message } satisfies LiveDownMessage);
          }
        });
        return;
      }
      case 'control': {
        const conn = this.droneForViewer(v, msg.droneId);
        if (!conn) return send(v.socket, { type: 'error', message: 'Drone is offline' } satisfies LiveDownMessage);
        if (msg.action !== 'release' && !this.refreshRole(v)) return;
        if (msg.action === 'release') {
          if (conn.controller?.userId === v.userId) this.setController(conn, null);
          return;
        }
        if (!can(v.role, 'drone.control')) return send(v.socket, { type: 'error', message: 'Your role cannot control drones' } satisfies LiveDownMessage);
        if (conn.controller && conn.controller.userId !== v.userId) {
          if (msg.action === 'force' && can(v.role, 'drone.manage')) {
            audit(this.deps.db, v.orgId, v.userId, 'drone.control.override', conn.droneId, { previous: conn.controller.name });
          } else {
            return send(v.socket, { type: 'error', message: `Drone is controlled by ${conn.controller.name}` } satisfies LiveDownMessage);
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
      case 'ping': {
        const id = typeof msg.id === 'string' ? msg.id.slice(0, 64) : '';
        const t = typeof msg.t === 'number' ? msg.t : 0;
        const conn = msg.droneId ? this.droneForViewer(v, msg.droneId) : null;
        if (!conn) return send(v.socket, { type: 'pong', id, t, serverTime: Date.now() } satisfies LiveDownMessage);
        const pingId = uuid();
        this.pings.set(pingId, {
          viewerConnId: v.connId,
          viewerPingId: id,
          viewerT: t,
          sentAt: Date.now(),
          timer: setTimeout(() => {
            this.pings.delete(pingId);
            send(v.socket, { type: 'pong', id, t, serverTime: Date.now() } satisfies LiveDownMessage);
          }, 5000),
        });
        send(conn.socket, { type: 'ping', id: pingId, t: Date.now() } satisfies LinkDownMessage);
        return;
      }
      default:
        send(v.socket, { type: 'error', message: 'unknown message type' } satisfies LiveDownMessage);
    }
  }

  private setController(conn: DroneConn, controller: (ControllerInfo & { connId: string | null }) | null): void {
    conn.controller = controller;
    this.broadcast(conn.orgId, { type: 'control', droneId: conn.droneId, controller: controller ? { userId: controller.userId, name: controller.name } : null }, conn.droneId);
  }

  private updateVideo(conn: DroneConn): void {
    if (!conn.helloReceived) return;
    const wanted: VideoQuality | null = conn.videoViewers.size === 0 ? null : [...conn.videoViewers.values()].includes('hd') ? 'hd' : 'sd';
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
    for (const v of this.viewersFor(orgId, droneId)) if (v.socket.readyState === 1) v.socket.send(out);
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
      controller: conn.controller ? { userId: conn.controller.userId, name: conn.controller.name } : null,
      flightId: this.deps.recorder.activeFlightId(conn.droneId),
      videoAvailable: conn.capabilities.video === true,
      mission: conn.mission ? { missionId: conn.mission.missionId, name: conn.mission.name, seq: conn.mission.seq, total: conn.mission.total } : null,
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

  /** A member was removed: close their live sockets and release their control locks. */
  revokeUser(orgId: string, userId: string): void {
    this.releaseLocksOf(orgId, userId);
    for (const v of [...this.viewers.values()]) {
      if (v.orgId === orgId && v.userId === userId) v.socket.close(4403, 'membership revoked');
    }
  }

  /** A member's role changed: apply it to open sockets immediately. */
  updateUserRole(orgId: string, userId: string, role: Role): void {
    if (!can(role, 'drone.control')) this.releaseLocksOf(orgId, userId);
    for (const v of this.viewers.values()) {
      if (v.orgId !== orgId || v.userId !== userId) continue;
      v.role = role;
      send(v.socket, { type: 'hello', userId: v.userId, orgId: v.orgId, serverTime: Date.now(), canControl: can(role, 'drone.control') } satisfies LiveDownMessage);
    }
    this.broadcastUsers(orgId);
  }

  /** A session ended or an API token was revoked. */
  closeAuth(authKey: string): void {
    for (const v of [...this.viewers.values()]) if (v.authKey === authKey) v.socket.close(4401, 'session ended');
  }

  /** The organisation was deleted. */
  closeOrg(orgId: string): void {
    for (const v of [...this.viewers.values()]) if (v.orgId === orgId) v.socket.close(4404, 'organisation deleted');
    for (const conn of [...this.drones.values()]) if (conn.orgId === orgId) conn.socket.close(4410, 'organisation deleted');
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
    clearInterval(this.keepalive);
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
