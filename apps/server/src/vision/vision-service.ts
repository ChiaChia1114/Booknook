/**
 * Live AI vision on drone video.
 *
 *  - Detection: the built-in detector (a small CenterNet-style network trained on the simulator
 *    camera, see tools/vision) runs on the video frames in a worker thread, at a few frames
 *    per second per drone; drones with their own on-board AI can send detections instead.
 *  - Recognition and tracking: a multi-object tracker keeps identities across frames, votes on
 *    the class and recognises the dominant colour of each object.
 *  - Geolocation: the point where an object touches the ground is projected from the image
 *    through the camera model (position, height, heading, gimbal pitch, field of view).
 *  - Follow-me: the drone keeps a chosen object in view at a set height and distance (goto
 *    commands with the camera turned towards it), holding when it loses sight of it.
 *
 * Results are pushed to the drone's viewers; confirmed objects are recorded with the flight.
 */
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AiStatus, CameraInfo, DetectedObjectDto, Role, Telemetry } from '@athena-sky/shared';
import { ConvNet, DETECTOR_CLASSES, can, ObjectTracker, destinationPoint, haversineDistance, initialBearing, objectGroundPoint, type DetectorClass, type DetectorModelSpec } from '@athena-sky/shared';
import type { Hub } from '../realtime/hub';
import type { FlightRecorder } from '../flights/recorder';
import { analyzeFrame, loadDetectorModel, type FrameAnalysis } from './analyze';

interface Logger {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface VisionActor {
  id: string;
  name: string;
  role: Role;
}

/** Camera assumed for drones that do not declare one (typical gimbal camera, 45° down). */
export const DEFAULT_CAMERA: CameraInfo = { hfovDeg: 78, pitchDeg: -45 };
/** Follow-me: the object is given up after this long out of sight (ms). */
export const FOLLOW_LOST_MS = 8000;

interface FollowState {
  trackId: number;
  user: VisionActor;
  altM: number;
  standoffM: number;
  lastCommandAt: number;
  lostSince: number | null;
  target: { lat: number; lon: number; t: number } | null;
  vel: { e: number; n: number };
}

interface Session {
  orgId: string;
  droneId: string;
  enabled: boolean;
  source: 'cloud' | 'onboard';
  lastOnboardAt: number;
  tracker: ObjectTracker;
  busy: boolean;
  lastProcessedAt: number;
  objects: DetectedObjectDto[];
  reported: Set<number>;
  speeds: Map<number, { lat: number; lon: number; t: number; speed: number }>;
  follow: FollowState | null;
  frames: number;
  lastMs: number;
}

export interface VisionOptions {
  /** 'worker' (default) keeps inference off the event loop; 'inline' runs it in-process (tests). */
  mode?: 'worker' | 'inline';
  /** Frames analysed per second and drone. */
  hz?: number;
  threshold?: number;
}

export class VisionService {
  readonly model: DetectorModelSpec | null;
  private readonly sessions = new Map<string, Session>();
  private readonly hz: number;
  private readonly threshold: number;
  private readonly mode: 'worker' | 'inline';
  private worker: Worker | null = null;
  private net: ConvNet | null = null;
  private readonly pending = new Map<number, { resolve(r: FrameAnalysis): void; reject(e: Error): void }>();
  private seq = 0;

  constructor(
    private readonly deps: { hub: Hub; recorder: FlightRecorder; log: Logger },
    opts: VisionOptions = {},
  ) {
    this.model = loadDetectorModel();
    this.hz = opts.hz ?? 3;
    this.threshold = opts.threshold ?? (typeof this.model?.meta?.threshold === 'number' ? (this.model.meta.threshold as number) : 0.35);
    this.mode = opts.mode ?? 'worker';
    const hub = deps.hub;
    hub.aiStatus = (droneId) => this.status(droneId);
    hub.events.on('frame', (_orgId, droneId, _ts, jpeg) => this.onFrame(droneId, jpeg));
    hub.events.on('detections', (orgId, droneId, msg) => this.onOnboard(orgId, droneId, msg));
    // A drone with on-board AI that (re)connects while detection is on is told to go on detecting.
    hub.events.on('hello', (_orgId, droneId) => {
      if (this.sessions.get(droneId)?.enabled && hub.hasOnboardAi(droneId)) hub.setOnboardAi(droneId, true);
    });
    hub.events.on('offline', (_orgId, droneId) => {
      const s = this.sessions.get(droneId);
      if (s?.follow) this.stopFollow(s, 'Follow-me stopped: data link lost', null);
    });
    hub.events.on('control', (_orgId, droneId, c) => {
      const s = this.sessions.get(droneId);
      if (s?.follow && c && c.userId !== s.follow.user.id) this.stopFollow(s, `Follow-me stopped: ${c.name} took control`, null);
    });
    // The follower was demoted or removed: stop at once (no command can be sent for them any more).
    hub.events.on('member', (orgId, userId, role) => {
      if (role && can(role, 'drone.control')) return;
      for (const s of this.sessions.values()) {
        if (s.orgId === orgId && s.follow?.user.id === userId) this.stopFollow(s, `Follow-me stopped: ${s.follow.user.name} can no longer control drones`, null);
      }
    });
  }

  get available(): boolean {
    return !!this.model;
  }

  // =======================================================================================
  // Inference backend
  // =======================================================================================

  private analyze(jpeg: Buffer): Promise<FrameAnalysis> {
    if (this.mode === 'inline') {
      this.net ??= new ConvNet(this.model!);
      try {
        return Promise.resolve(analyzeFrame(this.net, jpeg, this.threshold));
      } catch (err) {
        return Promise.reject(err as Error);
      }
    }
    if (!this.worker) this.startWorker();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, jpeg: new Uint8Array(jpeg), threshold: this.threshold });
    });
  }

  private startWorker(): void {
    // Bundled build: dist/vision-worker.js next to dist/main.js; sources: the .ts file via tsx.
    const js = new URL('./vision-worker.js', import.meta.url);
    const url = existsSync(fileURLToPath(js)) ? js : new URL('./vision-worker.ts', import.meta.url);
    const w = new Worker(url, url.pathname.endsWith('.ts') ? { execArgv: ['--import', 'tsx'] } : {});
    w.unref();
    w.on('message', (m: { id: number; result?: FrameAnalysis; error?: string }) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.result) p.resolve(m.result);
      else p.reject(new Error(m.error ?? 'vision worker error'));
    });
    w.on('error', (err) => {
      this.deps.log.error({ err }, 'vision worker failed');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker = null;
    });
    this.worker = w;
  }

  // =======================================================================================
  // Sessions
  // =======================================================================================

  private session(orgId: string, droneId: string): Session {
    let s = this.sessions.get(droneId);
    if (!s) {
      s = {
        orgId,
        droneId,
        enabled: false,
        source: 'cloud',
        lastOnboardAt: 0,
        tracker: new ObjectTracker({ minHits: 2, maxMisses: 6 }),
        busy: false,
        lastProcessedAt: 0,
        objects: [],
        reported: new Set(),
        speeds: new Map(),
        follow: null,
        frames: 0,
        lastMs: 0,
      };
      this.sessions.set(droneId, s);
    }
    return s;
  }

  status(droneId: string): AiStatus | null {
    const s = this.sessions.get(droneId);
    if (!s || (!s.enabled && s.source === 'cloud')) return null;
    return { enabled: s.enabled, source: s.source, following: s.follow?.trackId ?? null, followStatus: s.follow ? (s.follow.lostSince ? 'searching' : 'following') : null };
  }

  objects(droneId: string): DetectedObjectDto[] {
    return this.sessions.get(droneId)?.objects ?? [];
  }

  stats(droneId: string): { frames: number; lastMs: number } | null {
    const s = this.sessions.get(droneId);
    return s ? { frames: s.frames, lastMs: Math.round(s.lastMs) } : null;
  }

  /** Turns detection on or off; turning it off while following holds the drone, as `actor`. */
  setEnabled(orgId: string, droneId: string, enabled: boolean, actor: VisionActor | null = null): AiStatus | null {
    // A drone with its own AI detects on board (no video needed); others are analysed here.
    const onboard = this.deps.hub.hasOnboardAi(droneId);
    if (enabled && !onboard && !this.model) throw new Error('No detector model is installed');
    const s = this.session(orgId, droneId);
    if (s.enabled === enabled) return this.status(droneId);
    s.enabled = enabled;
    if (enabled) {
      s.tracker.reset();
      s.objects = [];
      if (onboard) {
        s.source = 'onboard';
        this.deps.hub.setOnboardAi(droneId, true);
      } else {
        this.deps.hub.addVideoConsumer(droneId, 'ai', 'sd');
      }
      this.droneEvent(s, 'info', 'ai', onboard ? 'AI object detection started (on board)' : 'AI object detection started');
    } else {
      this.deps.hub.setOnboardAi(droneId, false);
      this.deps.hub.removeVideoConsumer(droneId, 'ai');
      if (s.follow) this.stopFollow(s, 'Follow-me stopped: AI detection turned off', actor);
      s.objects = [];
      this.deps.hub.broadcastDrone(droneId, { type: 'detections', droneId, t: Date.now(), objects: [] });
      this.droneEvent(s, 'info', 'ai', 'AI object detection stopped');
    }
    this.deps.hub.refreshStatus(droneId);
    return this.status(droneId);
  }

  // =======================================================================================
  // Frames and detections
  // =======================================================================================

  private onFrame(droneId: string, jpeg: Buffer): void {
    const s = this.sessions.get(droneId);
    if (!s?.enabled || s.busy) return;
    // A drone that sends its own detections does not need cloud inference.
    if (Date.now() - s.lastOnboardAt < 3000) return;
    const now = Date.now();
    if (now - s.lastProcessedAt < 1000 / this.hz) return;
    s.busy = true;
    s.lastProcessedAt = now;
    const tel = this.deps.hub.telemetryOf(droneId);
    const cam = this.deps.hub.cameraOf(droneId) ?? DEFAULT_CAMERA;
    this.analyze(jpeg)
      .then((r) => {
        s.frames++;
        s.lastMs = r.ms;
        s.source = 'cloud';
        this.ingest(s, now, r.width / r.height, r.detections, tel, cam);
      })
      .catch((err: Error) => this.deps.log.warn({ err: err.message, droneId }, 'frame analysis failed'))
      .finally(() => {
        s.busy = false;
      });
  }

  private onOnboard(orgId: string, droneId: string, msg: Record<string, unknown>): void {
    if (!Array.isArray(msg.objects)) return;
    const dets = (msg.objects as unknown[])
      .slice(0, 100)
      .map((o) => o as { cls?: unknown; score?: unknown; box?: unknown })
      .filter((o) => typeof o.cls === 'string' && (DETECTOR_CLASSES as readonly string[]).includes(o.cls) && Array.isArray(o.box) && o.box.length === 4 && o.box.every((v) => Number.isFinite(v)))
      .map((o) => ({ cls: o.cls as DetectorClass, score: Math.min(1, Math.max(0, Number(o.score) || 0)), box: (o.box as number[]).map((v) => Math.min(1, Math.max(0, v))) as [number, number, number, number], color: null }));
    const s = this.session(orgId, droneId);
    // A drone declaring on-board AI detects while asked to: reports after it was stopped are late.
    if (this.deps.hub.hasOnboardAi(droneId) && !s.enabled) return;
    const first = s.source !== 'onboard' || !s.enabled;
    s.source = 'onboard';
    s.enabled = true;
    s.lastOnboardAt = Date.now();
    this.ingest(s, Date.now(), 16 / 9, dets, this.deps.hub.telemetryOf(droneId), this.deps.hub.cameraOf(droneId) ?? DEFAULT_CAMERA);
    if (first) this.deps.hub.refreshStatus(droneId);
  }

  /** Geolocates, tracks, publishes and records one frame's detections. */
  private ingest(s: Session, t: number, aspect: number, dets: { cls: DetectorClass; score: number; box: [number, number, number, number]; color: string | null }[], tel: Telemetry | null, cam: CameraInfo): void {
    const located = dets.map((d) => {
      let lat: number | null = null;
      let lon: number | null = null;
      if (tel && tel.altRel > 1) {
        const g = objectGroundPoint(d, { lat: tel.lat, lon: tel.lon, heightM: Math.max(1.2, tel.altRel + 0.3), headingDeg: tel.heading, pitchDeg: cam.pitchDeg, hfovDeg: cam.hfovDeg, aspect });
        if (g) {
          lat = g.lat;
          lon = g.lon;
        }
      }
      return { ...d, lat, lon };
    });
    const tracks = s.tracker.update(t, located);
    s.objects = tracks.map((tr) => {
      let speed: number | null = null;
      if (tr.lat !== null && tr.lon !== null) {
        const prev = s.speeds.get(tr.id);
        if (prev && t - prev.t >= 500) {
          const v = haversineDistance(prev, { lat: tr.lat, lon: tr.lon }) / ((t - prev.t) / 1000);
          speed = prev.speed ? 0.6 * prev.speed + 0.4 * v : v;
          s.speeds.set(tr.id, { lat: tr.lat, lon: tr.lon, t, speed });
        } else {
          speed = prev?.speed ?? null;
          if (!prev) s.speeds.set(tr.id, { lat: tr.lat, lon: tr.lon, t, speed: 0 });
        }
      }
      return { trackId: tr.id, cls: tr.cls, score: Math.round(tr.score * 100) / 100, box: tr.box.map((v) => Math.round(v * 10000) / 10000) as [number, number, number, number], color: tr.color, lat: tr.lat, lon: tr.lon, speedMs: speed === null ? null : Math.round(speed * 10) / 10 };
    });
    if (s.speeds.size > 500) for (const id of [...s.speeds.keys()].slice(0, 250)) s.speeds.delete(id);
    this.deps.hub.broadcastDrone(s.droneId, { type: 'detections', droneId: s.droneId, t, objects: s.objects });
    // New confirmed objects: event and flight record (once per object).
    for (const o of s.objects) {
      if (s.reported.has(o.trackId) || o.lat === null || o.lon === null) continue;
      s.reported.add(o.trackId);
      const label = `${o.color ? `${o.color} ` : ''}${o.cls}`;
      this.droneEvent(s, 'info', 'ai_detection', `AI: ${label} detected (#${o.trackId}) at ${o.lat.toFixed(5)}, ${o.lon.toFixed(5)}`);
      this.deps.recorder.onPayload(s.droneId, 'ai.detection', { trackId: o.trackId, cls: o.cls, color: o.color, score: o.score, lat: o.lat, lon: o.lon, t });
    }
    if (s.reported.size > 2000) s.reported.clear();
    this.followTick(s, t);
  }

  // =======================================================================================
  // Follow-me
  // =======================================================================================

  startFollow(orgId: string, droneId: string, trackId: number, user: VisionActor, opts: { altM?: number; standoffM?: number } = {}): AiStatus | null {
    const s = this.sessions.get(droneId);
    if (!s || s.orgId !== orgId || !s.enabled) throw new Error('Turn on AI detection first');
    const tr = s.tracker.get(trackId);
    if (!tr || !tr.confirmed) throw new Error(`Object #${trackId} is not being tracked`);
    const tel = this.deps.hub.telemetryOf(droneId);
    if (!tel?.inAir) throw new Error('The drone must be airborne to follow an object');
    const cam = this.deps.hub.cameraOf(droneId) ?? DEFAULT_CAMERA;
    const altM = Math.min(120, Math.max(5, opts.altM ?? Math.round(Math.max(10, tel.altRel))));
    // At the gimbal pitch, this distance keeps the object in the middle of the picture.
    const standoffM = Math.min(150, Math.max(4, opts.standoffM ?? altM / Math.tan((Math.abs(cam.pitchDeg) * Math.PI) / 180)));
    s.follow = { trackId, user, altM, standoffM: Math.round(standoffM * 10) / 10, lastCommandAt: 0, lostSince: null, target: tr.lat !== null && tr.lon !== null ? { lat: tr.lat, lon: tr.lon, t: Date.now() } : null, vel: { e: 0, n: 0 } };
    this.droneEvent(s, 'info', 'follow', `Follow-me: following ${tr.cls} #${trackId} at ${altM} m, ${Math.round(standoffM)} m behind`);
    this.deps.hub.refreshStatus(droneId);
    this.followTick(s, Date.now());
    return this.status(droneId);
  }

  stopFollowCommand(orgId: string, droneId: string, user: VisionActor): AiStatus | null {
    const s = this.sessions.get(droneId);
    if (s?.orgId === orgId && s.follow) this.stopFollow(s, `Follow-me stopped by ${user.name}`, user);
    return this.status(droneId);
  }

  /**
   * Ends follow-me. `holdBy`: the user in whose name the drone is told to hold (the hub
   * checks that user's current role); null when no command may or need be sent.
   */
  private stopFollow(s: Session, message: string, holdBy: VisionActor | null): void {
    const f = s.follow;
    if (!f) return;
    s.follow = null;
    if (holdBy) void this.deps.hub.sendCommand(s.orgId, s.droneId, holdBy, 'hold', {});
    this.droneEvent(s, holdBy ? 'info' : 'warning', 'follow', message);
    this.deps.hub.refreshStatus(s.droneId);
  }

  private followTick(s: Session, now: number): void {
    const f = s.follow;
    if (!f) return;
    const tr = s.tracker.get(f.trackId);
    const seen = !!tr && tr.misses === 0 && tr.lat !== null && tr.lon !== null;
    const wasLost = f.lostSince !== null;
    if (seen) {
      if (f.target) {
        const dt = (now - f.target.t) / 1000;
        if (dt >= 0.25) {
          const d = haversineDistance(f.target, { lat: tr!.lat!, lon: tr!.lon! });
          const b = (initialBearing(f.target, { lat: tr!.lat!, lon: tr!.lon! }) * Math.PI) / 180;
          const ve = (d * Math.sin(b)) / dt;
          const vn = (d * Math.cos(b)) / dt;
          f.vel = { e: 0.6 * f.vel.e + 0.4 * ve, n: 0.6 * f.vel.n + 0.4 * vn };
        }
      }
      f.target = { lat: tr!.lat!, lon: tr!.lon!, t: now };
      f.lostSince = null;
    } else {
      // Re-acquire: another track of the same class where the object should be now (the
      // tracker may have started a new identity, e.g. after an occlusion).
      const predicted = f.target ? this.predictTarget(f, now) : null;
      const cls = tr?.cls ?? null;
      const candidate = predicted
        ? s.tracker
            .active()
            .filter((c) => c.id !== f.trackId && c.misses === 0 && c.lat !== null && c.lon !== null && (!cls || c.cls === cls))
            .map((c) => ({ c, d: haversineDistance(predicted, { lat: c.lat!, lon: c.lon! }) }))
            .filter((x) => x.d < 8)
            .sort((a, b) => a.d - b.d)[0]
        : undefined;
      if (candidate) {
        const old = f.trackId;
        f.trackId = candidate.c.id;
        f.target = { lat: candidate.c.lat!, lon: candidate.c.lon!, t: now };
        f.lostSince = null;
        this.droneEvent(s, 'info', 'follow', `Follow-me: re-acquired ${candidate.c.cls} #${old} as #${candidate.c.id}`);
        this.deps.hub.refreshStatus(s.droneId);
      } else {
        f.lostSince ??= now;
        if (now - f.lostSince > FOLLOW_LOST_MS) return this.stopFollow(s, `Follow-me: lost sight of #${f.trackId} – holding position`, f.user);
      }
    }
    if (wasLost !== (f.lostSince !== null)) this.deps.hub.refreshStatus(s.droneId);
    const tel = this.deps.hub.telemetryOf(s.droneId);
    if (!f.target || !tel || now - f.lastCommandAt < 900) return;
    // Where the object is now (dead reckoning for a short while when out of sight).
    const speed = Math.hypot(f.vel.e, f.vel.n);
    const target = this.predictTarget(f, now);
    // Behind a moving object; on the current side of a standing one.
    const awayBearing = speed > 0.6 ? (Math.atan2(-f.vel.e, -f.vel.n) * 180) / Math.PI : initialBearing(target, tel);
    const desired = destinationPoint(target, awayBearing, f.standoffM);
    const dist = haversineDistance(tel, desired);
    const cmdSpeed = Math.min(15, Math.max(1.5, speed + dist * 0.5));
    f.lastCommandAt = now;
    void this.deps.hub
      .sendCommand(s.orgId, s.droneId, f.user, 'goto', { lat: desired.lat, lon: desired.lon, alt: f.altM, speed: Math.round(cmdSpeed * 10) / 10, yaw: Math.round(initialBearing(desired, target)) }, null, { audit: false })
      .then((r) => {
        if (s.follow === f && r.result !== 'accepted' && r.result !== 'completed' && r.result !== 'in_progress') this.stopFollow(s, `Follow-me stopped: ${r.message ?? r.result}`, null);
      });
  }

  /** Target position extrapolated with its velocity (at most 4 s ahead). */
  private predictTarget(f: FollowState, now: number): { lat: number; lon: number } {
    const age = Math.min(4, (now - f.target!.t) / 1000);
    const moved = Math.hypot(f.vel.e, f.vel.n) * age;
    return moved > 0.1 ? destinationPoint(f.target!, (Math.atan2(f.vel.e, f.vel.n) * 180) / Math.PI, moved) : f.target!;
  }

  private droneEvent(s: Session, level: 'info' | 'warning', code: string, message: string): void {
    this.deps.hub.droneEvent(s.droneId, level, code, message);
  }

  shutdown(): void {
    void this.worker?.terminate();
    this.worker = null;
  }
}
