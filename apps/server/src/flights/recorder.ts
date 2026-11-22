import { haversineDistance, type EventLevel, type MissionPlan, type Telemetry } from '@athena-sky/shared';
import type { Db } from '../db/database';
import { nowIso, uuid } from '../lib/util';
import { scheduleWindow } from '../lib/schedule-window';

export interface RecorderDeps {
  db: Db;
  sampleHz: number;
  linkLossGraceS: number;
  /** Called when a live flight starts or ends. */
  onFlightState(orgId: string, droneId: string, flightId: string, state: 'started' | 'ended'): void;
  /** Called after a flight has been closed and its statistics written. */
  onFlightClosed(flightId: string): void;
  log: { warn(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void };
}

export interface FlightContext {
  orgId: string;
  droneId: string;
  pilotId: string | null;
  missionId: string | null;
  /** The plan uploaded to the drone (kept with the flight). */
  missionPlan?: MissionPlan | null;
}

interface SampleRow {
  t: number;
  tel: Telemetry;
}

interface ActiveFlight {
  flightId: string;
  orgId: string;
  droneId: string;
  startedAt: number;
  lastSampleAt: number;
  buffer: SampleRow[];
  events: { t: number; level: EventLevel; code: string | null; message: string }[];
  distanceM: number;
  maxAltM: number;
  maxSpeed: number;
  batteryStart: number | null;
  batteryEnd: number | null;
  startPos: { lat: number; lon: number } | null;
  lastPos: { lat: number; lon: number } | null;
  lastInAir: boolean;
  landedSince: number | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  pilotId: string | null;
  missionId: string | null;
  /** The loaded mission last considered for this flight (a deleted one is not looked up again). */
  missionCheckedFor: string | null;
}

/** Seconds a drone may sit armed on the ground before its flight is considered finished. */
const LANDED_ARMED_TIMEOUT_MS = 20_000;

/**
 * Turns live telemetry into flight records: detects take-off / landing, persists
 * down-sampled telemetry and events, accumulates statistics and closes flights
 * on disarm, prolonged landing, or link loss.
 */
export class FlightRecorder {
  private readonly active = new Map<string, ActiveFlight>();
  private readonly flushTimer: ReturnType<typeof setInterval>;

  constructor(private readonly deps: RecorderDeps) {
    this.flushTimer = setInterval(() => this.flushAll(), 1000);
    this.flushTimer.unref?.();
    this.recoverStale();
  }

  /** Flights left "in progress" by a previous process are closed as aborted. */
  private recoverStale(): void {
    const stale = this.deps.db.all<{ id: string; started_at: string }>(
      "SELECT id, started_at FROM flights WHERE status = 'in_progress' AND source = 'live'",
    );
    for (const f of stale) {
      const last = this.deps.db.get<{ t: number }>('SELECT MAX(t) AS t FROM flight_samples WHERE flight_id = ?', f.id);
      const endMs = last?.t ?? new Date(f.started_at).getTime();
      this.deps.db.run(
        "UPDATE flights SET status = 'aborted', ended_at = ?, duration_s = ? WHERE id = ?",
        new Date(endMs).toISOString(),
        Math.max(0, (endMs - new Date(f.started_at).getTime()) / 1000),
        f.id,
      );
      this.insertEvent(f.id, endMs, 'warning', 'server_restart', 'Flight closed after a server restart');
    }
  }

  activeFlightId(droneId: string): string | null {
    return this.active.get(droneId)?.flightId ?? null;
  }

  setPilotIfMissing(droneId: string, userId: string): void {
    const f = this.active.get(droneId);
    if (f && !f.pilotId) {
      f.pilotId = userId;
      this.deps.db.run('UPDATE flights SET pilot_id = ? WHERE id = ? AND pilot_id IS NULL', userId, f.flightId);
    }
  }

  onTelemetry(ctx: FlightContext, tel: Telemetry, now = Date.now()): void {
    let f = this.active.get(ctx.droneId);
    if (!f) {
      if (!(tel.armed && tel.inAir)) return;
      f = this.start(ctx, tel, now);
    } else if (ctx.missionId && !f.missionId && f.missionCheckedFor !== ctx.missionId) {
      // A mission started during the flight: the flight flies it from now on, and it is the
      // scheduled operation of that mission if one is planned around now.
      f.missionCheckedFor = ctx.missionId;
      const missionId = this.existingMission(ctx.missionId);
      if (missionId) {
        f.missionId = missionId;
        this.deps.db.run(
          'UPDATE flights SET mission_id = ?, mission_plan = ? WHERE id = ? AND mission_id IS NULL',
          missionId,
          ctx.missionPlan ? JSON.stringify(ctx.missionPlan) : null,
          f.flightId,
        );
        this.linkSchedule(f.flightId, ctx.droneId, missionId);
      }
    }
    if (f.graceTimer) {
      clearTimeout(f.graceTimer);
      f.graceTimer = null;
    }
    // statistics
    if (f.lastPos && tel.inAir && tel.gps.fix >= 2) {
      const d = haversineDistance(f.lastPos, tel);
      if (d < 500) f.distanceM += d; // ignore GNSS jumps
    }
    if (tel.gps.fix >= 2 || !f.lastPos) f.lastPos = { lat: tel.lat, lon: tel.lon };
    f.maxAltM = Math.max(f.maxAltM, tel.altRel);
    f.maxSpeed = Math.max(f.maxSpeed, tel.groundSpeed);
    f.batteryEnd = tel.battery.pct;
    if (now - f.lastSampleAt >= 1000 / this.deps.sampleHz) {
      f.buffer.push({ t: now, tel });
      f.lastSampleAt = now;
    }
    // end conditions
    if (!tel.armed) {
      this.end(f, now, 'completed', 'Disarmed');
      return;
    }
    if (tel.inAir) {
      f.landedSince = null;
    } else {
      f.landedSince ??= now;
      if (now - f.landedSince >= LANDED_ARMED_TIMEOUT_MS) this.end(f, now, 'completed', 'Landed');
    }
    f.lastInAir = tel.inAir;
  }

  onEvent(droneId: string, ev: { t?: number; level: EventLevel; code?: string; message: string }): string | null {
    const f = this.active.get(droneId);
    if (!f) return null;
    f.events.push({ t: Date.now(), level: ev.level, code: ev.code ?? null, message: ev.message.slice(0, 500) });
    return f.flightId;
  }

  onPayload(droneId: string, kind: string, data: Record<string, unknown>): string | null {
    const f = this.active.get(droneId);
    if (!f) return null;
    this.deps.db.run(
      'INSERT INTO payload_records (id, flight_id, t, kind, data) VALUES (?, ?, ?, ?, ?)',
      uuid(),
      f.flightId,
      Date.now(),
      kind.slice(0, 64),
      JSON.stringify(data).slice(0, 16_384),
    );
    return f.flightId;
  }

  /** Link lost: keep the flight open for the grace period, then close it as aborted. */
  onDisconnect(droneId: string): void {
    const f = this.active.get(droneId);
    if (!f || f.graceTimer) return;
    f.events.push({ t: Date.now(), level: 'warning', code: 'link_lost', message: 'Telemetry link lost' });
    f.graceTimer = setTimeout(() => {
      f.graceTimer = null;
      if (this.active.get(droneId) === f) {
        this.end(f, Date.now(), f.lastInAir ? 'aborted' : 'completed', f.lastInAir ? 'Link not restored' : 'Link lost after landing');
      }
    }, this.deps.linkLossGraceS * 1000);
    f.graceTimer.unref?.();
  }

  onReconnect(droneId: string): void {
    const f = this.active.get(droneId);
    if (f?.graceTimer) {
      clearTimeout(f.graceTimer);
      f.graceTimer = null;
      f.events.push({ t: Date.now(), level: 'info', code: 'link_restored', message: 'Telemetry link restored' });
    }
  }

  /** The mission id if the mission still exists (it may have been deleted while loaded on the drone). */
  private existingMission(missionId: string | null): string | null {
    return missionId && this.deps.db.get('SELECT 1 FROM missions WHERE id = ?', missionId) ? missionId : null;
  }

  /** Marks the scheduled operation being flown – same drone and mission, planned around now – as in progress. */
  private linkSchedule(flightId: string, droneId: string, missionId: string): void {
    const w = scheduleWindow();
    this.deps.db.run(
      `UPDATE schedules SET status = 'in_progress', flight_id = ?
        WHERE id = (SELECT id FROM schedules WHERE drone_id = ? AND mission_id = ? AND status IN ('scheduled','uploaded') AND planned_at BETWEEN ? AND ?
                    ORDER BY status = 'uploaded' DESC, ABS(julianday(planned_at) - julianday(?)) LIMIT 1)`,
      flightId,
      droneId,
      missionId,
      w.from,
      w.to,
      w.now,
    );
  }

  private start(ctx: FlightContext, tel: Telemetry, now: number): ActiveFlight {
    const flightId = uuid();
    const missionId = this.existingMission(ctx.missionId);
    this.deps.db.run(
      `INSERT INTO flights (id, org_id, drone_id, pilot_id, mission_id, mission_plan, source, status, started_at, battery_start,
                            start_lat, start_lon, takeoff_alt_msl, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'live', 'in_progress', ?, ?, ?, ?, ?, ?)`,
      flightId,
      ctx.orgId,
      ctx.droneId,
      ctx.pilotId,
      missionId,
      missionId && ctx.missionPlan ? JSON.stringify(ctx.missionPlan) : null,
      new Date(now).toISOString(),
      tel.battery.pct,
      tel.home?.lat ?? tel.lat,
      tel.home?.lon ?? tel.lon,
      tel.home?.altMsl ?? tel.altMsl - tel.altRel,
      nowIso(),
    );
    const f: ActiveFlight = {
      flightId,
      orgId: ctx.orgId,
      droneId: ctx.droneId,
      startedAt: now,
      lastSampleAt: 0,
      buffer: [],
      events: [{ t: now, level: 'info', code: 'takeoff', message: 'Take-off detected' }],
      distanceM: 0,
      maxAltM: 0,
      maxSpeed: 0,
      batteryStart: tel.battery.pct,
      batteryEnd: tel.battery.pct,
      startPos: { lat: tel.home?.lat ?? tel.lat, lon: tel.home?.lon ?? tel.lon },
      lastPos: null,
      lastInAir: true,
      landedSince: null,
      graceTimer: null,
      pilotId: ctx.pilotId,
      missionId,
      missionCheckedFor: ctx.missionId,
    };
    this.active.set(ctx.droneId, f);
    if (missionId) this.linkSchedule(flightId, ctx.droneId, missionId);
    this.deps.onFlightState(ctx.orgId, ctx.droneId, flightId, 'started');
    return f;
  }

  private insertEvent(flightId: string, t: number, level: string, code: string | null, message: string): void {
    this.deps.db.run('INSERT INTO flight_events (flight_id, t, level, code, message) VALUES (?, ?, ?, ?, ?)', flightId, t, level, code, message);
  }

  private flush(f: ActiveFlight): void {
    if (f.buffer.length === 0 && f.events.length === 0) return;
    const rows = f.buffer.splice(0);
    const events = f.events.splice(0);
    const db = this.deps.db;
    db.tx(() => {
      for (const { t, tel } of rows) {
        db.run(
          `INSERT INTO flight_samples (flight_id, t, lat, lon, alt_msl, alt_rel, ground_speed, climb_rate, heading, roll, pitch, yaw,
                                       battery_pct, voltage, current, satellites, hdop, mode, armed, vibration, motors)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          f.flightId,
          t,
          tel.lat,
          tel.lon,
          tel.altMsl,
          tel.altRel,
          tel.groundSpeed,
          tel.climbRate,
          tel.heading,
          tel.roll,
          tel.pitch,
          tel.yaw,
          tel.battery.pct,
          tel.battery.voltage,
          tel.battery.current,
          tel.gps.satellites,
          tel.gps.hdop,
          tel.mode,
          tel.armed,
          tel.vibration ?? null,
          tel.motors ? JSON.stringify(tel.motors) : null,
        );
      }
      for (const e of events) this.insertEvent(f.flightId, e.t, e.level, e.code, e.message);
      db.run(
        'UPDATE flights SET distance_m = ?, max_alt_m = ?, max_speed_ms = ?, battery_end = ?, duration_s = ? WHERE id = ?',
        f.distanceM,
        f.maxAltM,
        f.maxSpeed,
        f.batteryEnd,
        (Date.now() - f.startedAt) / 1000,
        f.flightId,
      );
    });
  }

  private flushAll(): void {
    for (const f of this.active.values()) {
      try {
        this.flush(f);
      } catch (err) {
        this.deps.log.error({ err, flightId: f.flightId }, 'failed to flush flight samples');
      }
    }
  }

  private end(f: ActiveFlight, now: number, status: 'completed' | 'aborted', reason: string): void {
    this.active.delete(f.droneId);
    if (f.graceTimer) clearTimeout(f.graceTimer);
    f.events.push({ t: now, level: status === 'aborted' ? 'warning' : 'info', code: 'flight_end', message: reason });
    this.flush(f);
    this.deps.db.run(
      `UPDATE flights SET status = ?, ended_at = ?, duration_s = ?, distance_m = ?, max_alt_m = ?, max_speed_ms = ?,
                          battery_end = ?, end_lat = ?, end_lon = ? WHERE id = ?`,
      status,
      new Date(now).toISOString(),
      (now - f.startedAt) / 1000,
      f.distanceM,
      f.maxAltM,
      f.maxSpeed,
      f.batteryEnd,
      f.lastPos?.lat ?? null,
      f.lastPos?.lon ?? null,
      f.flightId,
    );
    this.deps.db.run(
      "UPDATE schedules SET status = ? WHERE flight_id = ? AND status = 'in_progress'",
      status === 'completed' ? 'completed' : 'scheduled',
      f.flightId,
    );
    this.deps.onFlightState(f.orgId, f.droneId, f.flightId, 'ended');
    try {
      this.deps.onFlightClosed(f.flightId);
    } catch (err) {
      this.deps.log.error({ err, flightId: f.flightId }, 'post-flight processing failed');
    }
  }

  /** Flushes buffers; on shutdown flights remain open and are recovered on next start. */
  shutdown(): void {
    clearInterval(this.flushTimer);
    this.flushAll();
    for (const f of this.active.values()) if (f.graceTimer) clearTimeout(f.graceTimer);
  }
}
