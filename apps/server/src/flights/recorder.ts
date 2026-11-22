import { flownFrom, haversineDistance, type EventLevel, type Geofence, type MissionPlan, type Telemetry } from '@athena-sky/shared';
import { parseJson, type Db } from '../db/database';
import { nowIso, uuid } from '../lib/util';
import { scheduleWindow } from '../lib/schedule-window';

export interface RecorderDeps {
  db: Db;
  sampleHz: number;
  linkLossGraceS: number;
  /** Called when a live flight starts or ends (`resumed`: recorded again after a server restart). */
  onFlightState(orgId: string, droneId: string, flightId: string, state: 'started' | 'resumed' | 'ended'): void;
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
  /** The geofence the drone enforces: that of the mission loaded on it, flown or not. */
  geofence?: Geofence | null;
}

/** The geofence a drone enforced from `from` (ms) on – null: none. Kept with the flight for the compliance check. */
export interface GeofencePeriod {
  from: number;
  fence: Geofence | null;
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
  /** The geofences the drone enforced during the flight, and the one it reported last. */
  geofences: GeofencePeriod[];
  fenceRef: Geofence | null | undefined;
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

  /** Flights a previous process left open, waiting for their drone to report again. */
  private readonly unfinished = new Map<string, { flightId: string; timer: ReturnType<typeof setTimeout> }>();

  /**
   * Flights left "in progress" by a previous process (a restart while drones were flying) wait
   * for their drone for the link-loss grace period: one that reports again still armed goes on
   * recording the same flight; otherwise the flight is closed where its recording stopped.
   */
  private recoverStale(): void {
    const stale = this.deps.db.all<{ id: string; drone_id: string }>(
      "SELECT id, drone_id FROM flights WHERE status = 'in_progress' AND source = 'live' ORDER BY started_at",
    );
    for (const f of stale) {
      const older = this.unfinished.get(f.drone_id);
      if (older) {
        // Two open flights of one drone: the older one is over (closed once the app is up).
        clearTimeout(older.timer);
        setImmediate(() => this.guard(older.flightId, () => this.closeUnfinished(older.flightId, 'aborted', 'Flight closed after a server restart')));
      }
      const timer = setTimeout(() => {
        if (this.unfinished.get(f.drone_id)?.flightId !== f.id) return;
        this.unfinished.delete(f.drone_id);
        this.guard(f.id, () => this.closeUnfinished(f.id, 'aborted', 'Flight closed after a server restart: the drone did not report again'));
      }, this.deps.linkLossGraceS * 1000);
      timer.unref?.();
      this.unfinished.set(f.drone_id, { flightId: f.id, timer });
    }
  }

  /** Closes a flight a previous process left open, where its recording stopped. */
  private closeUnfinished(flightId: string, status: 'completed' | 'aborted', message: string): void {
    const row = this.deps.db.get<{ org_id: string; drone_id: string; started_at: string }>(
      "SELECT org_id, drone_id, started_at FROM flights WHERE id = ? AND status = 'in_progress'",
      flightId,
    );
    if (!row) return; // deleted meanwhile
    const last = this.deps.db.get<{ t: number; lat: number; lon: number }>('SELECT t, lat, lon FROM flight_samples WHERE flight_id = ? ORDER BY t DESC LIMIT 1', flightId);
    const startMs = new Date(row.started_at).getTime();
    const endMs = last?.t ?? startMs;
    this.deps.db.run(
      'UPDATE flights SET status = ?, ended_at = ?, duration_s = ?, end_lat = COALESCE(?, end_lat), end_lon = COALESCE(?, end_lon) WHERE id = ?',
      status,
      new Date(endMs).toISOString(),
      Math.max(0, (endMs - startMs) / 1000),
      last?.lat ?? null,
      last?.lon ?? null,
      flightId,
    );
    this.insertEvent(flightId, endMs, 'warning', 'server_restart', message);
    this.reopenSchedule(flightId);
    this.deps.onFlightState(row.org_id, row.drone_id, flightId, 'ended');
    this.closed(flightId);
  }

  /**
   * The drone of a flight left open by a previous process reports again: still armed, the same
   * flight goes on being recorded (no second flight, no second battery cycle); disarmed, it
   * landed meanwhile and the flight is closed.
   */
  private resumeUnfinished(ctx: FlightContext, tel: Telemetry, now: number): ActiveFlight | null {
    const open = this.unfinished.get(ctx.droneId);
    if (!open) return null;
    clearTimeout(open.timer);
    this.unfinished.delete(ctx.droneId);
    if (!tel.armed) {
      this.closeUnfinished(open.flightId, 'completed', 'Landed while the server was restarting – the end of the flight was not recorded');
      return null;
    }
    const r = this.deps.db.get<{
      org_id: string;
      started_at: string;
      pilot_id: string | null;
      mission_id: string | null;
      distance_m: number | null;
      max_alt_m: number | null;
      max_speed_ms: number | null;
      battery_start: number | null;
      battery_end: number | null;
      start_lat: number | null;
      start_lon: number | null;
      geofence: string | null;
    }>(
      `SELECT org_id, started_at, pilot_id, mission_id, distance_m, max_alt_m, max_speed_ms, battery_start, battery_end, start_lat, start_lon, geofence
         FROM flights WHERE id = ? AND status = 'in_progress'`,
      open.flightId,
    );
    if (!r) return null;
    const last = this.deps.db.get<{ t: number; lat: number; lon: number }>('SELECT t, lat, lon FROM flight_samples WHERE flight_id = ? ORDER BY t DESC LIMIT 1', open.flightId);
    const gap = last ? Math.max(0, Math.round((now - last.t) / 1000)) : null;
    const f: ActiveFlight = {
      flightId: open.flightId,
      orgId: r.org_id,
      droneId: ctx.droneId,
      startedAt: new Date(r.started_at).getTime(),
      lastSampleAt: 0,
      buffer: [],
      events: [{ t: now, level: 'warning', code: 'server_restart', message: `Recording resumed after a server restart${gap !== null ? ` (no telemetry for ${gap} s)` : ''}` }],
      distanceM: r.distance_m ?? 0,
      maxAltM: r.max_alt_m ?? 0,
      maxSpeed: r.max_speed_ms ?? 0,
      batteryStart: r.battery_start,
      batteryEnd: r.battery_end ?? r.battery_start,
      startPos: r.start_lat != null && r.start_lon != null ? { lat: r.start_lat, lon: r.start_lon } : null,
      lastPos: last ? { lat: last.lat, lon: last.lon } : null,
      lastInAir: tel.inAir,
      landedSince: null,
      graceTimer: null,
      pilotId: r.pilot_id,
      missionId: r.mission_id,
      missionCheckedFor: r.mission_id,
      geofences: parseJson<GeofencePeriod[]>(r.geofence, []),
      fenceRef: undefined,
    };
    this.active.set(ctx.droneId, f);
    this.deps.onFlightState(f.orgId, f.droneId, f.flightId, 'resumed');
    return f;
  }

  /** Work started by a timer: a failure is logged – never thrown, it would stop the server. */
  private guard(flightId: string, work: () => void): void {
    try {
      work();
    } catch (err) {
      this.deps.log.error({ err, flightId }, 'failed to close flight');
    }
  }

  /** Post-flight processing of a closed flight. */
  private closed(flightId: string): void {
    try {
      this.deps.onFlightClosed(flightId);
    } catch (err) {
      this.deps.log.error({ err, flightId }, 'post-flight processing failed');
    }
  }

  /**
   * The scheduled operation of a flight that ended stays open – uploaded while its mission is
   * still on the drone – until the mission has been flown to the end (the live hub then marks it
   * completed).
   */
  private reopenSchedule(flightId: string): void {
    this.deps.db.run(
      `UPDATE schedules SET status = CASE WHEN EXISTS (SELECT 1 FROM drone_missions dm WHERE dm.drone_id = schedules.drone_id AND dm.mission_id = schedules.mission_id)
                                          THEN 'uploaded' ELSE 'scheduled' END
        WHERE flight_id = ? AND status = 'in_progress'`,
      flightId,
    );
  }

  activeFlightId(droneId: string): string | null {
    return this.active.get(droneId)?.flightId ?? null;
  }

  /** The mission the drone's current flight flies (null: none, or not flying). */
  activeFlightMission(droneId: string): string | null {
    return this.active.get(droneId)?.missionId ?? null;
  }

  /** The drone was deleted, its flights with it: nothing more is recorded for it. */
  forget(droneId: string): void {
    const f = this.active.get(droneId);
    if (f?.graceTimer) clearTimeout(f.graceTimer);
    this.active.delete(droneId);
    const open = this.unfinished.get(droneId);
    if (open) clearTimeout(open.timer);
    this.unfinished.delete(droneId);
  }

  setPilotIfMissing(droneId: string, userId: string): void {
    const f = this.active.get(droneId);
    if (f && !f.pilotId) {
      f.pilotId = userId;
      this.deps.db.run('UPDATE flights SET pilot_id = ? WHERE id = ? AND pilot_id IS NULL', userId, f.flightId);
    }
  }

  onTelemetry(ctx: FlightContext, tel: Telemetry, now = Date.now()): void {
    let f = this.active.get(ctx.droneId) ?? this.resumeUnfinished(ctx, tel, now);
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
        // The mission is flown from here: the route the flight is compared with starts here.
        this.deps.db.run(
          'UPDATE flights SET mission_id = ?, mission_plan = ?, mission_started_at = ? WHERE id = ? AND mission_id IS NULL',
          missionId,
          // From here (and this altitude); the return still goes to the drone's home.
          ctx.missionPlan ? JSON.stringify(flownFrom(ctx.missionPlan, tel.home ? { lat: tel.home.lat, lon: tel.home.lon } : null, { lat: tel.lat, lon: tel.lon, alt: tel.altRel })) : null,
          now,
          f.flightId,
        );
        this.linkSchedule(f.flightId, ctx.droneId, missionId);
      }
    }
    if (f.graceTimer) {
      clearTimeout(f.graceTimer);
      f.graceTimer = null;
    }
    this.trackGeofence(f, ctx.geofence ?? null, now);
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
      if (this.active.get(droneId) !== f) return;
      this.guard(f.flightId, () => this.end(f, Date.now(), f.lastInAir ? 'aborted' : 'completed', f.lastInAir ? 'Link not restored' : 'Link lost after landing'));
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
    const geofences: GeofencePeriod[] = ctx.geofence ? [{ from: now, fence: ctx.geofence }] : [];
    this.deps.db.run(
      `INSERT INTO flights (id, org_id, drone_id, pilot_id, mission_id, mission_plan, mission_started_at, source, status, started_at, battery_start,
                            start_lat, start_lon, takeoff_alt_msl, geofence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'live', 'in_progress', ?, ?, ?, ?, ?, ?, ?)`,
      flightId,
      ctx.orgId,
      ctx.droneId,
      ctx.pilotId,
      missionId,
      // The plan as the drone flies it: from where it took off (not the plan's drawn home).
      missionId && ctx.missionPlan ? JSON.stringify(flownFrom(ctx.missionPlan, { lat: tel.home?.lat ?? tel.lat, lon: tel.home?.lon ?? tel.lon })) : null,
      missionId ? now : null,
      new Date(now).toISOString(),
      tel.battery.pct,
      tel.home?.lat ?? tel.lat,
      tel.home?.lon ?? tel.lon,
      tel.home?.altMsl ?? tel.altMsl - tel.altRel,
      geofences.length ? JSON.stringify(geofences) : null,
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
      geofences,
      fenceRef: ctx.geofence ?? null,
    };
    this.active.set(ctx.droneId, f);
    if (missionId) this.linkSchedule(flightId, ctx.droneId, missionId);
    this.deps.onFlightState(ctx.orgId, ctx.droneId, flightId, 'started');
    return f;
  }

  /** A geofence loaded or cleared during the flight (a mission uploaded in the air, or flown and cleared). */
  private trackGeofence(f: ActiveFlight, fence: Geofence | null, now: number): void {
    if (fence === f.fenceRef) return;
    f.fenceRef = fence;
    const last = f.geofences[f.geofences.length - 1]?.fence ?? null;
    if (JSON.stringify(last) === JSON.stringify(fence)) return;
    f.geofences.push({ from: now, fence });
    this.deps.db.run('UPDATE flights SET geofence = ? WHERE id = ?', JSON.stringify(f.geofences), f.flightId);
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
    this.reopenSchedule(f.flightId);
    this.deps.onFlightState(f.orgId, f.droneId, f.flightId, 'ended');
    this.closed(f.flightId);
  }

  /** Flushes buffers; on shutdown flights remain open and are taken up again on the next start. */
  shutdown(): void {
    clearInterval(this.flushTimer);
    this.flushAll();
    for (const f of this.active.values()) if (f.graceTimer) clearTimeout(f.graceTimer);
    for (const open of this.unfinished.values()) clearTimeout(open.timer);
  }
}
