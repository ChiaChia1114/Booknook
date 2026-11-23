/**
 * Fast-forward (non real-time) simulation of a complete mission, used to
 * synthesise realistic historical flights for demos and tests.
 */
import type { EventLevel, LatLon, MissionPlan, Telemetry } from '@athena-sky/shared';
import { VirtualDrone, type DroneOptions } from './drone';
import { OnboardLogger } from './onboard-log';

export interface OfflineFlight {
  telemetry: Telemetry[];
  events: { t: number; level: EventLevel; code?: string; message: string }[];
  photos: { t: number; seq: number; lat: number; lon: number; altMsl: number }[];
  ulog: Buffer | null;
  startedAt: number;
  endedAt: number;
}

export interface OfflineOptions {
  home: LatLon;
  startTime: number;
  drone?: Omit<DroneOptions, 'home'>;
  /** Telemetry samples kept per second. */
  sampleHz?: number;
  maxDurationS?: number;
  ulog?: boolean;
}

export function simulateMission(plan: MissionPlan, opts: OfflineOptions): OfflineFlight {
  const events: OfflineFlight['events'] = [];
  const photos: OfflineFlight['photos'] = [];
  const drone = new VirtualDrone(
    { ...(opts.drone ?? {}), home: opts.home },
    {
      event: (e) => events.push({ t: drone.now, ...e }),
      photo: (p) => photos.push({ t: drone.now, ...p }),
    },
    opts.startTime,
  );
  const logger = opts.ulog ? new OnboardLogger(opts.startTime - 120_000) : null;
  drone.loadMission('offline', plan);
  const start = drone.handleCommand('mission_start', {});
  if (start.result !== 'accepted') throw new Error(`mission_start rejected: ${start.message}`);
  const dt = 0.1;
  const every = Math.max(1, Math.round(1 / dt / (opts.sampleHz ?? 2)));
  const telemetry: Telemetry[] = [];
  const maxSteps = ((opts.maxDurationS ?? 3600) / dt) | 0;
  let tookOff = false;
  for (let i = 0; i < maxSteps; i++) {
    drone.step(dt);
    if (drone.inAir) tookOff = true;
    const tel = drone.telemetry();
    if (i % every === 0 && drone.armed) telemetry.push(tel);
    if (drone.armed) logger?.record(tel);
    // Mission finished in the air without land/RTL item: bring it home.
    if (tookOff && drone.inAir && drone.mode === 'HOLD' && drone.mission && drone.missionIndex >= drone.mission.items.length) {
      drone.handleCommand('rtl', {});
    }
    if (tookOff && !drone.armed) break;
  }
  if (logger) for (const e of events) logger.event(e.t, e.level, e.message);
  return {
    telemetry,
    events,
    photos,
    ulog: logger && logger.size > 0 ? logger.build({ sysName: 'Athena FC', firmware: drone.firmware, hardware: drone.opts.model, airframe: drone.opts.airframe ?? null }) : null,
    startedAt: telemetry[0]?.t ?? opts.startTime,
    endedAt: telemetry[telemetry.length - 1]?.t ?? opts.startTime,
  };
}
