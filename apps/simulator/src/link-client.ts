/**
 * Athena Link client – reference implementation of the drone side of the protocol
 * (what an on-board companion computer / LTE datalink runs). Drives a VirtualDrone.
 */
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import {
  destinationPoint,
  encodeLinkVideoFrame,
  type DetectedAircraft,
  type LinkDownMessage,
  type LinkUpMessage,
  type VideoQuality,
} from '@athena-sky/shared';
import { VirtualDrone } from './drone';
import { FrameRenderer, VIDEO_PRESETS } from './video';
import { OnboardLogger } from './onboard-log';

export interface LinkClientOptions {
  /** ws(s)://host/api/v2/link */
  url: string;
  key: string;
  drone: VirtualDrone;
  telemetryHz?: number;
  video?: boolean;
  adsb?: boolean;
  payload?: boolean;
  /** Upload an on-board ULog after every flight (post-flight sync). */
  onboardLog?: boolean;
  /** Physics speed-up factor (tests); 1 = real time. */
  timeScale?: number;
  log?: (msg: string) => void;
}

const PHYSICS_HZ = 20;

export class LinkClient {
  private ws: WebSocket | null = null;
  private physics: ReturnType<typeof setInterval> | null = null;
  private telemetryTimer: ReturnType<typeof setInterval> | null = null;
  private videoTimer: ReturnType<typeof setInterval> | null = null;
  private auxTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;
  private stopped = false;
  private renderer: FrameRenderer | null = null;
  private videoQuality: VideoQuality | null = null;
  private readonly logger: OnboardLogger;
  private wasArmed = false;
  private traffic: (DetectedAircraft & { vN: number; vE: number; until: number }) | null = null;
  private lastTrafficAt = 0;
  private updating = false;
  droneId: string | null = null;
  connected = false;

  constructor(private readonly opts: LinkClientOptions) {
    this.logger = new OnboardLogger(Date.now() - 60_000);
    opts.drone.listener = {
      event: (e) => {
        this.send({ type: 'event', level: e.level, code: e.code, message: e.message });
        this.logger.event(this.opts.drone.now, e.level, e.message);
      },
      missionProgress: (seq, total) => this.send({ type: 'mission_progress', seq, total }),
      photo: (p) => {
        this.send({ type: 'payload', kind: 'photo', data: { seq: p.seq, lat: p.lat, lon: p.lon, altMsl: p.altMsl } });
        this.send({ type: 'event', level: 'info', code: 'photo', message: `Photo #${p.seq} captured` });
      },
    };
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }

  get httpBase(): string {
    const u = new URL(this.opts.url);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '';
    u.search = '';
    return u.toString().replace(/\/$/, '');
  }

  start(): void {
    this.stopped = false;
    const drone = this.opts.drone;
    let last = Date.now();
    this.physics = setInterval(() => {
      const now = Date.now();
      const dt = Math.min(0.2, (now - last) / 1000);
      last = now;
      const scale = Math.max(1, this.opts.timeScale ?? 1);
      for (let i = 0; i < scale; i++) drone.step(dt);
      drone.now = now;
      if (drone.armed) this.logger.record(drone.telemetry());
      if (this.wasArmed && !drone.armed) void this.flightEnded();
      this.wasArmed = drone.armed;
    }, 1000 / PHYSICS_HZ);
    this.telemetryTimer = setInterval(() => this.send({ type: 'telemetry', ...drone.telemetry() }), 1000 / (this.opts.telemetryHz ?? 5));
    this.auxTimer = setInterval(() => this.aux(), 1000);
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of [this.physics, this.telemetryTimer, this.videoTimer, this.auxTimer]) if (t) clearInterval(t);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
        ws.close(1000, 'simulator stopped');
        setTimeout(resolve, 1000);
      });
    } else ws?.terminate();
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.opts.url, { headers: { authorization: `Bearer ${this.opts.key}` } });
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this.backoffMs = 1000;
      this.opts.drone.setLink(true);
      const d = this.opts.drone;
      this.send({
        type: 'hello',
        firmware: d.firmware,
        model: d.opts.model,
        serial: d.opts.serial || undefined,
        capabilities: { video: this.opts.video !== false, manualControl: true, adsb: this.opts.adsb === true },
      });
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        this.onMessage(JSON.parse(data.toString()) as LinkDownMessage);
      } catch (err) {
        this.log(`bad message: ${(err as Error).message}`);
      }
    });
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.opts.drone.setLink(false);
      this.setVideo(null);
      if (code === 4403 || code === 4410) {
        this.log(`link closed permanently: ${reason.toString()}`);
        if (code === 4403) return; // invalid key – do not hammer the server
      }
      this.scheduleReconnect();
    });
    ws.on('error', (err) => this.log(`link error: ${err.message}`));
  }

  private scheduleReconnect(delay = this.backoffMs): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.backoffMs = Math.min(30_000, this.backoffMs * 2);
  }

  private send(msg: LinkUpMessage): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private onMessage(msg: LinkDownMessage): void {
    const drone = this.opts.drone;
    switch (msg.type) {
      case 'welcome':
        this.droneId = msg.droneId;
        this.log(`connected as ${msg.name} (${msg.droneId})`);
        return;
      case 'command': {
        const r = drone.handleCommand(msg.command, msg.params ?? {});
        this.send({ type: 'ack', id: msg.id, result: r.result, message: r.message });
        if (msg.command === 'reboot' && r.result === 'accepted') {
          this.ws?.close(1000, 'rebooting');
          this.scheduleReconnect(3000);
        }
        return;
      }
      case 'mission_upload': {
        const r = drone.loadMission(msg.missionId, msg.plan);
        this.send({ type: 'mission_ack', id: msg.id, result: r.result, message: r.message });
        return;
      }
      case 'manual_control':
        drone.manualControl(msg.x, msg.y, msg.z, msg.r);
        return;
      case 'video':
        this.setVideo(msg.action === 'start' && this.opts.video !== false ? msg.quality : null);
        return;
      case 'firmware_update':
        void this.updateFirmware(msg);
        return;
      case 'ping':
        this.send({ type: 'pong', id: msg.id, t: Date.now() });
        return;
      case 'error':
        this.log(`server error: ${msg.message}`);
        return;
    }
  }

  private setVideo(quality: VideoQuality | null): void {
    if (quality === this.videoQuality) return;
    if (this.videoTimer) clearInterval(this.videoTimer);
    this.videoTimer = null;
    this.videoQuality = quality;
    if (!quality) return;
    const preset = VIDEO_PRESETS[quality];
    this.renderer = new FrameRenderer(preset);
    const origin = { lat: this.opts.drone.home.lat, lon: this.opts.drone.home.lon };
    this.videoTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 2_000_000 || !this.renderer) return;
      const t = this.opts.drone.telemetry();
      const jpeg = this.renderer.render(t, origin);
      ws.send(encodeLinkVideoFrame(Date.now(), 0, jpeg));
    }, 1000 / preset.fps);
  }

  /** Once per second: simulated ADS-B receiver and payload sensor. */
  private aux(): void {
    const drone = this.opts.drone;
    const now = Date.now();
    if (this.opts.adsb && drone.inAir) {
      if (!this.traffic && now - this.lastTrafficAt > 90_000) {
        this.lastTrafficAt = now;
        const start = destinationPoint(drone, Math.random() * 360, 1800);
        const heading = (Math.atan2(drone.lon - start.lon, drone.lat - start.lat) * 180) / Math.PI;
        const speed = 45;
        this.traffic = {
          icao: `4CA${Math.floor(Math.random() * 0xfff).toString(16).toUpperCase().padStart(3, '0')}`,
          callsign: 'HEMS21',
          lat: start.lat,
          lon: start.lon,
          altMsl: drone.home.altMsl + drone.altRel + 120,
          heading: (heading + 360) % 360,
          speed,
          t: now,
          vN: speed * Math.cos((heading * Math.PI) / 180),
          vE: speed * Math.sin((heading * Math.PI) / 180),
          until: now + 80_000,
        };
      }
      const tr = this.traffic;
      if (tr) {
        tr.lat += tr.vN / 111_320;
        tr.lon += tr.vE / (111_320 * Math.cos((tr.lat * Math.PI) / 180));
        tr.t = now;
        this.send({ type: 'adsb', aircraft: [{ icao: tr.icao, callsign: tr.callsign, lat: tr.lat, lon: tr.lon, altMsl: tr.altMsl, heading: tr.heading, speed: tr.speed, t: now }] });
        if (now > tr.until) this.traffic = null;
      }
    }
    if (this.opts.payload && drone.inAir && now % 2000 < 1000) {
      this.send({
        type: 'payload',
        kind: 'environment',
        data: {
          temperatureC: Math.round((18 - drone.altRel * 0.0065 + Math.random()) * 10) / 10,
          humidityPct: Math.round(55 + Math.random() * 10),
          pm25: Math.round(8 + Math.random() * 6),
          lat: drone.lat,
          lon: drone.lon,
          altRel: Math.round(drone.altRel * 10) / 10,
        },
      });
    }
  }

  /** Post-flight: upload the on-board ULog (like syncing the SD-card log over LTE). */
  private async flightEnded(): Promise<void> {
    if (this.opts.onboardLog === false || this.logger.size < 20) {
      this.logger.reset();
      return;
    }
    const d = this.opts.drone;
    const buf = this.logger.build({ sysName: 'Athena FC', firmware: d.firmware, hardware: d.opts.model, serial: d.opts.serial || undefined });
    this.logger.reset();
    try {
      const res = await fetch(`${this.httpBase}/api/v2/link/logs`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.key}`,
          'content-type': 'application/octet-stream',
          'x-filename': `log_${new Date().toISOString().replace(/[:.]/g, '-')}.ulg`,
        },
        body: buf,
      });
      this.log(`on-board log uploaded: HTTP ${res.status}`);
    } catch (err) {
      this.log(`log upload failed: ${(err as Error).message}`);
    }
  }

  private async updateFirmware(msg: Extract<LinkDownMessage, { type: 'firmware_update' }>): Promise<void> {
    const progress = (status: 'downloading' | 'verifying' | 'installing' | 'completed' | 'failed', p: number, message?: string) =>
      this.send({ type: 'firmware_progress', updateId: msg.updateId, status, progress: p, message });
    if (this.opts.drone.armed) return progress('failed', 0, 'Vehicle is armed');
    if (this.updating) return progress('failed', 0, 'Another update is in progress');
    this.updating = true;
    try {
      progress('downloading', 0);
      const res = await fetch(msg.url);
      if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
      const hash = createHash('sha256');
      let received = 0;
      let lastReport = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        received += value.length;
        const pct = msg.size ? Math.floor((received / msg.size) * 100) : 50;
        if (pct - lastReport >= 20) {
          lastReport = pct;
          progress('downloading', pct);
        }
      }
      progress('verifying', 100);
      if (hash.digest('hex') !== msg.sha256) throw new Error('checksum mismatch');
      progress('installing', 50);
      await new Promise((r) => setTimeout(r, 1500));
      this.opts.drone.firmware = msg.version;
      progress('completed', 100);
      // Reboot into the new firmware: reconnect and announce the new version.
      setTimeout(() => {
        this.ws?.close(1000, 'rebooting after update');
        this.scheduleReconnect(1000);
      }, 300);
    } catch (err) {
      progress('failed', 0, (err as Error).message);
    } finally {
      this.updating = false;
    }
  }
}
