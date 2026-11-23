/**
 * Virtual multirotor: kinematic flight model, flight controller (modes, mission
 * execution, RTL with rally points, geofence and battery failsafes) and battery model.
 * It is network-agnostic: LinkClient drives it in real time, demo seeding drives it
 * in fast-forward to synthesise historical flights.
 */
import {
  airDensity,
  batteryEnergyWh,
  destinationPoint,
  haversineDistance,
  loiterSeconds,
  initialBearing,
  pointInPolygon,
  rotorPower,
  wingPower,
  type Airframe,
  type AckResult,
  type CommandName,
  type CommandParams,
  type EventLevel,
  type LatLon,
  type MissionItem,
  type MissionPlan,
  type Telemetry,
} from '@athena-sky/shared';

export interface DroneOptions {
  home: LatLon;
  /** Ground elevation at home (m AMSL). */
  groundAltMsl?: number;
  firmware?: string;
  model?: string;
  serial?: string;
  /** Battery capacity (Wh). */
  capacityWh?: number;
  /** Cells in series. */
  cells?: number;
  /** Hover power draw (W). */
  hoverPowerW?: number;
  /** Extra load on one motor (0 = healthy, 0.2 = 20 % imbalance) – drives AI analytics demos. */
  motorImbalance?: number;
  /** Base vibration level (m/s²). */
  vibration?: number;
  /** Mean wind speed (m/s). */
  windSpeed?: number;
  lowBatteryPct?: number;
  criticalBatteryPct?: number;
  seed?: number;
  /**
   * Airframe flight-physics model: when set, the battery capacity and the electrical power
   * (momentum theory / drag polar with the simulated airspeed, climb rate and air density)
   * come from the same model as the pre-flight simulation.
   */
  airframe?: Airframe | null;
}

export type DroneEvent = { level: EventLevel; code?: string; message: string };
export type DroneListener = {
  event?(e: DroneEvent): void;
  missionProgress?(seq: number, total: number): void;
  /** `auto`: taken by distance-based camera triggering (surveys). */
  photo?(info: { seq: number; lat: number; lon: number; altMsl: number; auto?: boolean }): void;
};

type Mode = 'HOLD' | 'TAKEOFF' | 'MISSION' | 'RTL' | 'LAND' | 'GUIDED' | 'POSCTL';

const M_PER_DEG_LAT = 111_320;

/** Small deterministic PRNG (mulberry32) so fast-forward simulations are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class VirtualDrone {
  // --- configuration
  readonly opts: Required<Omit<DroneOptions, 'seed'>>;
  firmware: string;
  // --- state
  lat: number;
  lon: number;
  altRel = 0;
  vN = 0;
  vE = 0;
  vU = 0;
  heading = 0;
  roll = 0;
  pitch = 0;
  rollRate = 0;
  pitchRate = 0;
  armed = false;
  inAir = false;
  mode: Mode = 'HOLD';
  remainingWh: number;
  current = 0;
  voltage = 0;
  cruiseSpeed = 8;
  home: LatLon & { altMsl: number };
  mission: MissionPlan | null = null;
  missionId: string | null = null;
  missionIndex = 0;
  private holdUntil: number | null = null;
  private landingPhase = false;
  private target: { lat: number; lon: number; alt: number } | null = null;
  private manual = { x: 0, y: 0, z: 0, r: 0, at: 0 };
  private armedAt = 0;
  private landedAt: number | null = null;
  private lowBatteryTriggered = false;
  private criticalBatteryTriggered = false;
  private geofenceTriggered = false;
  private photoSeq = 0;
  /** Distance-based camera triggering (MAV_CMD_DO_SET_CAM_TRIGG_DIST). */
  private triggerDistanceM = 0;
  private sinceTriggerM = 0;
  /** Heading requested by the current mission waypoint (structure scans) or a reposition. */
  private yawTarget: number | null = null;
  /** Speed / heading of the current reposition (GUIDED). */
  private guided: { speed: number | null; yaw: number | null } = { speed: null, yaw: null };
  /** Progress around the current circular loiter. */
  private loiter: { angle: number; travelled: number; until: number | null } | null = null;
  private rtlTarget: LatLon | null = null;
  private wind: { speed: number; dir: number };
  private readonly random: () => number;
  /** Simulation clock (ms). */
  now: number;
  linkUp = true;
  private linkLostAt: number | null = null;

  constructor(options: DroneOptions, public listener: DroneListener = {}, startTime = Date.now()) {
    this.opts = {
      groundAltMsl: 50,
      firmware: 'athena-fc 2.4.0',
      model: 'Athena X4',
      serial: '',
      capacityWh: 160,
      cells: 6,
      hoverPowerW: 320,
      motorImbalance: 0,
      vibration: 12,
      windSpeed: 3,
      lowBatteryPct: 25,
      criticalBatteryPct: 10,
      airframe: null,
      ...options,
    } as Required<Omit<DroneOptions, 'seed'>>;
    if (this.opts.airframe && options.capacityWh === undefined) this.opts.capacityWh = batteryEnergyWh(this.opts.airframe.battery);
    if (this.opts.airframe && options.cells === undefined) this.opts.cells = this.opts.airframe.battery.cells;
    this.random = rng(options.seed ?? Math.floor(Math.random() * 1e9));
    this.firmware = this.opts.firmware;
    this.lat = options.home.lat;
    this.lon = options.home.lon;
    this.home = { lat: options.home.lat, lon: options.home.lon, altMsl: this.opts.groundAltMsl };
    this.remainingWh = this.opts.capacityWh;
    this.wind = { speed: this.opts.windSpeed, dir: this.random() * 360 };
    this.now = startTime;
    this.voltage = this.opts.cells * 4.2;
  }

  get batteryPct(): number {
    return Math.max(0, Math.min(100, (this.remainingWh / this.opts.capacityWh) * 100));
  }

  get groundSpeed(): number {
    return Math.hypot(this.vN, this.vE);
  }

  private emit(level: EventLevel, message: string, code?: string): void {
    this.listener.event?.({ level, message, code });
  }

  // =====================================================================================
  // Commands
  // =====================================================================================

  private preArmCheck(): string | null {
    if (this.batteryPct < this.opts.criticalBatteryPct + 5) return 'Battery too low to arm';
    if (this.inAir) return null;
    return null;
  }

  private arm(): string | null {
    if (this.armed) return null;
    const err = this.preArmCheck();
    if (err) return err;
    this.armed = true;
    this.armedAt = this.now;
    this.landedAt = null;
    this.mode = 'HOLD';
    this.home = { lat: this.lat, lon: this.lon, altMsl: this.opts.groundAltMsl };
    this.lowBatteryTriggered = false;
    this.criticalBatteryTriggered = false;
    this.geofenceTriggered = false;
    this.emit('info', 'Armed', 'armed');
    return null;
  }

  private disarm(reason: string): void {
    if (!this.armed) return;
    this.armed = false;
    this.inAir = false;
    this.vN = this.vE = this.vU = 0;
    this.mode = 'HOLD';
    this.target = null;
    this.landingPhase = false;
    this.triggerDistanceM = 0;
    this.emit('info', `Disarmed (${reason})`, 'disarmed');
  }

  handleCommand(command: CommandName, params: CommandParams): { result: AckResult; message?: string } {
    switch (command) {
      case 'arm': {
        const err = this.arm();
        return err ? { result: 'rejected', message: err } : { result: 'accepted' };
      }
      case 'disarm':
        if (this.inAir) return { result: 'rejected', message: 'Cannot disarm while airborne' };
        this.disarm('command');
        return { result: 'accepted' };
      case 'takeoff': {
        if (this.inAir) return { result: 'rejected', message: 'Already airborne' };
        const err = this.arm();
        if (err) return { result: 'rejected', message: err };
        const alt = Math.max(2, Math.min(500, params.alt ?? 10));
        this.mode = 'TAKEOFF';
        this.target = { lat: this.lat, lon: this.lon, alt };
        this.emit('info', `Taking off to ${alt} m`, 'takeoff');
        return { result: 'accepted' };
      }
      case 'land':
        if (!this.inAir) return { result: 'rejected', message: 'Not airborne' };
        this.setMode('LAND');
        return { result: 'accepted' };
      case 'rtl':
        if (!this.inAir) return { result: 'rejected', message: 'Not airborne' };
        this.setMode('RTL');
        return { result: 'accepted' };
      case 'hold':
        if (!this.inAir) return { result: 'rejected', message: 'Not airborne' };
        this.setMode('HOLD');
        return { result: 'accepted' };
      case 'goto':
        if (!this.inAir) return { result: 'rejected', message: 'Take off first' };
        if (params.lat === undefined || params.lon === undefined) return { result: 'rejected', message: 'lat/lon required' };
        if (haversineDistance(this, { lat: params.lat, lon: params.lon }) > 20_000) return { result: 'rejected', message: 'Target further than 20 km' };
        this.target = { lat: params.lat, lon: params.lon, alt: params.alt ?? this.altRel };
        this.guided = { speed: params.speed ?? null, yaw: params.yaw ?? null };
        this.mode = 'GUIDED';
        this.emit('info', `Repositioning to ${params.lat.toFixed(5)}, ${params.lon.toFixed(5)} at ${Math.round(this.target.alt)} m${params.speed ? `, ${params.speed} m/s` : ''}${params.yaw !== undefined ? `, heading ${Math.round(params.yaw)}°` : ''}`, 'goto');
        return { result: 'accepted' };
      case 'set_mode': {
        const m = params.mode as Mode | undefined;
        if (!m || !['HOLD', 'POSCTL', 'MISSION', 'RTL', 'LAND'].includes(m)) return { result: 'rejected', message: `Unsupported mode ${params.mode}` };
        if (!this.inAir && m !== 'MISSION') return { result: 'rejected', message: 'Not airborne' };
        if (m === 'MISSION') return this.handleCommand('mission_start', {});
        this.setMode(m);
        return { result: 'accepted' };
      }
      case 'set_speed':
        if (!params.speed || params.speed <= 0) return { result: 'rejected', message: 'speed required' };
        this.cruiseSpeed = Math.min(20, params.speed);
        return { result: 'accepted' };
      case 'mission_start': {
        if (!this.mission || this.mission.items.length === 0) return { result: 'rejected', message: 'No mission loaded' };
        if (!this.inAir && this.mission.items[0]?.type !== 'takeoff') return { result: 'rejected', message: 'Mission must start with take-off when on the ground' };
        const err = this.arm();
        if (err) return { result: 'rejected', message: err };
        this.missionIndex = Math.max(0, Math.min(this.mission.items.length - 1, params.fromSeq ?? 0));
        this.holdUntil = null;
        this.landingPhase = false;
        this.cruiseSpeed = this.mission.defaultSpeed;
        this.mode = 'MISSION';
        this.emit('info', 'Mission started', 'mission_start');
        this.listener.missionProgress?.(this.missionIndex, this.mission.items.length);
        return { result: 'accepted' };
      }
      case 'mission_pause':
        if (this.mode !== 'MISSION') return { result: 'rejected', message: 'Mission not running' };
        this.setMode('HOLD');
        return { result: 'accepted' };
      case 'mission_resume': {
        if (!this.mission || !this.inAir) return { result: 'rejected', message: 'Nothing to resume' };
        const cur = this.mission.items[this.missionIndex];
        if (this.mode === 'MISSION' && cur?.type === 'loiter' && cur.unlimited) {
          // Continue after an unlimited loiter.
          this.missionIndex++;
          this.loiter = null;
          this.holdUntil = null;
          this.listener.missionProgress?.(this.missionIndex, this.mission.items.length);
          this.emit('info', `Loiter ended – continuing with item ${this.missionIndex + 1}`, 'mission_resume');
          return { result: 'accepted' };
        }
        this.mode = 'MISSION';
        this.holdUntil = null;
        this.emit('info', `Mission resumed at item ${this.missionIndex + 1}`, 'mission_resume');
        return { result: 'accepted' };
      }
      case 'camera_photo':
        this.takePhoto();
        return { result: 'accepted' };
      case 'reboot':
        if (this.armed) return { result: 'rejected', message: 'Disarm before rebooting' };
        return { result: 'accepted' };
      default:
        return { result: 'rejected', message: `Unknown command ${String(command)}` };
    }
  }

  loadMission(id: string, plan: MissionPlan): { result: AckResult; message?: string } {
    if (this.mode === 'MISSION' && this.inAir) return { result: 'rejected', message: 'Mission in progress' };
    if (plan.items.length === 0) return { result: 'rejected', message: 'Empty mission' };
    this.mission = plan;
    this.missionId = id;
    this.missionIndex = 0;
    this.emit('info', `Mission received (${plan.items.length} items, ${plan.rallyPoints.length} rally points${plan.geofence ? ', geofence' : ''})`, 'mission_upload');
    return { result: 'accepted' };
  }

  /** Forgets a mission that has been flown (never the one being flown, nor a newer one). */
  clearMission(missionId: string): void {
    if (this.missionId !== missionId || (this.mode === 'MISSION' && this.inAir)) return;
    this.mission = null;
    this.missionId = null;
    this.missionIndex = 0;
    this.emit('info', 'Mission cleared (flown to the end)', 'mission_cleared');
  }

  manualControl(x: number, y: number, z: number, r: number): void {
    this.manual = { x, y, z, r, at: this.now };
    if (this.inAir && this.mode !== 'POSCTL' && (Math.abs(x) > 0.05 || Math.abs(y) > 0.05 || Math.abs(z) > 0.05 || Math.abs(r) > 0.05)) {
      // Stick input overrides automatic modes (pilot takes over).
      this.setMode('POSCTL');
    }
  }

  setLink(up: boolean): void {
    if (this.linkUp === up) return;
    this.linkUp = up;
    this.linkLostAt = up ? null : this.now;
  }

  private setMode(m: Mode): void {
    if (this.mode === m) return;
    this.mode = m;
    this.holdUntil = null;
    if (m === 'HOLD') this.target = { lat: this.lat, lon: this.lon, alt: this.altRel };
    if (m === 'RTL') {
      this.rtlTarget = this.nearestSafePoint();
      this.landingPhase = false;
      this.emit('info', this.rtlTarget === this.home ? 'Returning to launch' : 'Returning to nearest rally point', 'rtl');
    }
    if (m === 'LAND') this.emit('info', 'Landing', 'land');
  }

  /** Home or the closest mission rally point (multiple emergency landing points, BVLOS safety). */
  private nearestSafePoint(): LatLon {
    let best: LatLon = this.home;
    let bestD = haversineDistance(this, this.home);
    for (const r of this.mission?.rallyPoints ?? []) {
      const d = haversineDistance(this, r);
      if (d < bestD) {
        best = r;
        bestD = d;
      }
    }
    return best;
  }

  private takePhoto(auto = false): void {
    this.photoSeq++;
    this.listener.photo?.({ seq: this.photoSeq, lat: this.lat, lon: this.lon, altMsl: this.opts.groundAltMsl + this.altRel, ...(auto ? { auto } : {}) });
  }

  // =====================================================================================
  // Simulation step
  // =====================================================================================

  step(dt: number): void {
    this.now += dt * 1000;
    const desired = this.guidance(dt);
    // First-order response of the velocity controller.
    const k = Math.min(1, dt / 0.8);
    this.vN += (desired.vN - this.vN) * k;
    this.vE += (desired.vE - this.vE) * k;
    this.vU += (desired.vU - this.vU) * Math.min(1, dt / 0.5);
    if (!this.armed) this.vN = this.vE = this.vU = 0;
    // Integrate position.
    this.lat += (this.vN * dt) / M_PER_DEG_LAT;
    this.lon += (this.vE * dt) / (M_PER_DEG_LAT * Math.cos((this.lat * Math.PI) / 180));
    this.altRel += this.vU * dt;
    if (this.triggerDistanceM > 0 && this.inAir) {
      this.sinceTriggerM += Math.hypot(this.vN, this.vE) * dt;
      if (this.sinceTriggerM >= this.triggerDistanceM) {
        this.sinceTriggerM -= this.triggerDistanceM;
        this.takePhoto(true);
      }
    }
    if (this.altRel <= 0) {
      this.altRel = 0;
      if (this.vU < 0) this.vU = 0;
    }
    // Air / ground state.
    if (this.armed && this.altRel > 0.3) this.inAir = true;
    if (this.inAir && this.altRel <= 0.05 && desired.vU <= 0) {
      this.inAir = false;
      this.landedAt = this.now;
      this.vN = this.vE = 0;
      this.emit('info', 'Landing detected', 'landed');
      if (this.mode === 'MISSION') this.finishMission();
      this.mode = 'HOLD';
      this.target = null;
      this.landingPhase = false;
    }
    if (this.armed && !this.inAir) {
      if (this.landedAt !== null && this.now - this.landedAt > 2000) this.disarm('landed');
      else if (this.landedAt === null && this.mode !== 'TAKEOFF' && this.mode !== 'MISSION' && this.now - this.armedAt > 30_000) this.disarm('auto-disarm, no take-off');
    }
    if (this.inAir) this.landedAt = null;
    // Attitude follows acceleration / velocity (small-angle multirotor model).
    const hdgRad = (this.heading * Math.PI) / 180;
    const fwd = this.vN * Math.cos(hdgRad) + this.vE * Math.sin(hdgRad);
    const right = -this.vN * Math.sin(hdgRad) + this.vE * Math.cos(hdgRad);
    const gust = this.inAir ? (this.random() - 0.5) * 0.8 : 0;
    const prevRoll = this.roll;
    const prevPitch = this.pitch;
    this.pitch = this.inAir ? -Math.max(-35, Math.min(35, fwd * 1.6 + (desired.vN - this.vN) * 0.5)) + gust : 0;
    this.roll = this.inAir ? Math.max(-35, Math.min(35, right * 1.6)) + gust : 0;
    // Differential thrust is only needed to change attitude (angular rate), not to hold it.
    this.rollRate = dt > 0 ? (this.roll - prevRoll) / dt : 0;
    this.pitchRate = dt > 0 ? (this.pitch - prevPitch) / dt : 0;
    if (this.inAir) {
      const yawRate = this.mode === 'POSCTL' ? this.manual.r * 60 : 0;
      if (yawRate !== 0) this.heading = (this.heading + yawRate * dt + 360) % 360;
      else if (this.yawTarget !== null) {
        let diff = ((this.yawTarget - this.heading + 540) % 360) - 180;
        diff = Math.max(-60 * dt, Math.min(60 * dt, diff));
        this.heading = (this.heading + diff + 360) % 360;
      } else if (this.groundSpeed > 1.5) {
        const course = (Math.atan2(this.vE, this.vN) * 180) / Math.PI;
        let diff = ((course - this.heading + 540) % 360) - 180;
        diff = Math.max(-60 * dt, Math.min(60 * dt, diff));
        this.heading = (this.heading + diff + 360) % 360;
      }
    }
    this.updateBattery(dt);
    this.failsafes();
  }

  private finishMission(): void {
    if (!this.mission) return;
    this.triggerDistanceM = 0;
    this.listener.missionProgress?.(this.mission.items.length, this.mission.items.length);
    this.emit('info', 'Mission complete', 'mission_complete');
  }

  private guidance(dt: number): { vN: number; vE: number; vU: number } {
    const zero = { vN: 0, vE: 0, vU: 0 };
    this.yawTarget = null;
    if (!this.armed) return zero;
    switch (this.mode) {
      case 'TAKEOFF': {
        const t = this.target!;
        if (Math.abs(this.altRel - t.alt) < 0.3) {
          this.setMode('HOLD');
          this.emit('info', 'Take-off complete', 'takeoff_complete');
          return zero;
        }
        return { vN: 0, vE: 0, vU: clampV(t.alt - this.altRel, 3, 2) };
      }
      case 'HOLD':
        if (!this.inAir) return zero;
        return this.flyTo(this.target ?? { lat: this.lat, lon: this.lon, alt: this.altRel }, this.cruiseSpeed);
      case 'GUIDED': {
        const t = this.target!;
        if (this.guided.yaw !== null) this.yawTarget = this.guided.yaw;
        if (haversineDistance(this, t) < 1.5 && Math.abs(t.alt - this.altRel) < 0.5) {
          this.setMode('HOLD');
          return zero;
        }
        return this.flyTo(t, this.guided.speed ?? this.cruiseSpeed);
      }
      case 'POSCTL': {
        const fresh = this.now - this.manual.at < 1000;
        if (!fresh) return zero; // stick timeout -> brake and hold
        const h = (this.heading * Math.PI) / 180;
        const fwd = this.manual.x * 10;
        const right = this.manual.y * 10;
        return { vN: fwd * Math.cos(h) - right * Math.sin(h), vE: fwd * Math.sin(h) + right * Math.cos(h), vU: this.manual.z * 3 };
      }
      case 'LAND':
        return { vN: 0, vE: 0, vU: this.altRel > 10 ? -2.5 : -0.8 };
      case 'RTL': {
        const dest = this.rtlTarget ?? this.home;
        const rtlAlt = Math.max(30, this.altRel);
        if (!this.landingPhase && this.altRel < rtlAlt - 0.5 && haversineDistance(this, dest) > 5) {
          return { vN: 0, vE: 0, vU: clampV(rtlAlt - this.altRel, 3, 2) };
        }
        if (haversineDistance(this, dest) > 1.5 && !this.landingPhase) return this.flyTo({ ...dest, alt: this.altRel }, Math.max(this.cruiseSpeed, 8));
        this.landingPhase = true;
        return { vN: 0, vE: 0, vU: this.altRel > 10 ? -2.5 : -0.8 };
      }
      case 'MISSION':
        return this.missionGuidance(dt);
    }
  }

  private missionGuidance(_dt: number): { vN: number; vE: number; vU: number } {
    const plan = this.mission!;
    const item: MissionItem | undefined = plan.items[this.missionIndex];
    if (!item) {
      this.setMode('HOLD');
      this.finishMission();
      return { vN: 0, vE: 0, vU: 0 };
    }
    const advance = () => {
      this.missionIndex++;
      this.holdUntil = null;
      this.loiter = null;
      this.listener.missionProgress?.(this.missionIndex, plan.items.length);
      if (this.missionIndex >= plan.items.length) {
        this.finishMission();
        this.setMode('HOLD');
      }
    };
    switch (item.type) {
      case 'takeoff': {
        const alt = item.alt ?? plan.defaultAlt;
        if (this.altRel >= alt - 0.5) {
          advance();
          return { vN: 0, vE: 0, vU: 0 };
        }
        return { vN: 0, vE: 0, vU: clampV(alt - this.altRel, 3, 2) };
      }
      case 'speed':
        if (item.speed) this.cruiseSpeed = item.speed;
        advance();
        return { vN: this.vN, vE: this.vE, vU: this.vU };
      case 'photo':
        this.takePhoto();
        advance();
        return { vN: this.vN, vE: this.vE, vU: this.vU };
      case 'camera_trigger':
        this.triggerDistanceM = item.triggerDistanceM ?? 0;
        this.sinceTriggerM = 0;
        if (this.triggerDistanceM > 0) this.takePhoto(true);
        advance();
        return { vN: this.vN, vE: this.vE, vU: this.vU };
      case 'waypoint':
      case 'loiter': {
        if (item.lat === undefined || item.lon === undefined) {
          advance();
          return { vN: 0, vE: 0, vU: 0 };
        }
        const t = { lat: item.lat, lon: item.lon, alt: item.alt ?? this.altRel };
        const speed = item.speed ?? this.cruiseSpeed;
        if (item.yawDeg !== undefined) this.yawTarget = item.yawDeg;
        if (item.type === 'loiter' && item.radiusM && item.radiusM > 0) return this.loiterCircle(item, t, speed, _dt, advance);
        const reached = haversineDistance(this, t) < 2 && Math.abs(t.alt - this.altRel) < 1;
        if (reached) {
          // Hold time, turns (on the spot: as long as the circle would take) or until resumed.
          const hold = item.type === 'loiter' && item.unlimited ? Infinity : loiterSeconds(item, speed);
          if (hold <= 0) {
            advance();
          } else {
            this.holdUntil ??= this.now + hold * 1000;
            if (this.now >= this.holdUntil) advance();
          }
          return this.flyTo(t, speed);
        }
        return this.flyTo(t, speed);
      }
      case 'land': {
        if (item.lat !== undefined && item.lon !== undefined && !this.landingPhase) {
          const t = { lat: item.lat, lon: item.lon, alt: this.altRel };
          if (haversineDistance(this, t) > 1.5) return this.flyTo(t, this.cruiseSpeed);
        }
        this.landingPhase = true;
        return { vN: 0, vE: 0, vU: this.altRel > 10 ? -2.5 : -0.8 };
      }
      case 'rtl':
        this.setMode('RTL');
        return { vN: 0, vE: 0, vU: 0 };
    }
  }

  /**
   * Circular loiter: approach the nearest point of the circle, then fly around it clockwise
   * (a look-ahead point on the circle) for the hold time / number of turns, or until resumed.
   */
  private loiterCircle(item: MissionItem, center: { lat: number; lon: number; alt: number }, speed: number, dt: number, advance: () => void): { vN: number; vE: number; vU: number } {
    const r = item.radiusM!;
    if (!this.loiter) {
      const bearing = haversineDistance(this, center) > 1 ? initialBearing(center, this) : 0;
      const entry = destinationPoint(center, bearing, r);
      if (haversineDistance(this, entry) > 4 || Math.abs(center.alt - this.altRel) > 1.5) return this.flyTo({ ...entry, alt: center.alt }, speed);
      this.loiter = { angle: bearing, travelled: 0, until: item.holdS && !item.turns && !item.unlimited ? this.now + item.holdS * 1000 : null };
      this.emit('info', `Loitering ${item.unlimited ? 'until resumed' : item.turns ? `${item.turns} turn(s)` : `${item.holdS ?? 0} s`} (radius ${r} m)`, 'loiter');
    }
    const l = this.loiter;
    l.angle = (l.angle + ((speed * dt) / r) * (180 / Math.PI)) % 360;
    l.travelled += speed * dt;
    const done = item.unlimited ? false : item.turns ? l.travelled >= item.turns * 2 * Math.PI * r : l.until !== null ? this.now >= l.until : l.travelled >= 2 * Math.PI * r;
    if (done) {
      advance();
      return { vN: this.vN, vE: this.vE, vU: this.vU };
    }
    const lead = 2 * Math.asin(Math.min(1, speed / r)) * (180 / Math.PI);
    const target = destinationPoint(center, l.angle + lead, r);
    return this.flyTo({ ...target, alt: center.alt }, speed);
  }

  /** Velocity command towards a target with speed limit and arrival braking. */
  private flyTo(t: { lat: number; lon: number; alt: number }, speed: number): { vN: number; vE: number; vU: number } {
    const d = haversineDistance(this, t);
    const brg = (initialBearing(this, t) * Math.PI) / 180;
    const v = Math.min(speed, Math.max(0, d) * 0.6);
    return { vN: v * Math.cos(brg), vE: v * Math.sin(brg), vU: clampV(t.alt - this.altRel, 3, 2) };
  }

  /** Electrical power (W) of the airframe model at the current state. */
  private airframePower(af: Airframe): number {
    if (!this.inAir && this.altRel <= 0) return this.armed ? af.avionicsW + 15 : af.avionicsW * 0.5;
    const wind = this.wind;
    const to = ((wind.dir + 180) * Math.PI) / 180;
    const airspeed = Math.hypot(this.vE - wind.speed * Math.sin(to), this.vN - wind.speed * Math.cos(to));
    const rho = airDensity(this.opts.groundAltMsl + this.altRel);
    const onWing = af.wing && af.kind !== 'multirotor' && airspeed > af.wing.stallSpeedMs;
    const p = onWing ? wingPower(af, af.emptyMassKg, airspeed, this.vU, rho) : rotorPower(af, af.emptyMassKg, airspeed, this.vU, rho);
    return p.totalW * (1 + this.opts.motorImbalance * 0.6);
  }

  private updateBattery(dt: number): void {
    let power = 4; // avionics idle
    if (this.armed) power += 15;
    if (this.opts.airframe) power = this.airframePower(this.opts.airframe);
    else if (this.inAir || this.altRel > 0) {
      const speed = this.groundSpeed;
      power += this.opts.hoverPowerW * (1 + this.opts.motorImbalance * 0.6) + 0.9 * speed * speed + Math.max(0, this.vU) * 60;
    }
    const pct = this.batteryPct / 100;
    const ocv = this.opts.cells * (3.55 + 0.6 * pct + 0.05 * Math.pow(pct, 4));
    this.current = power / Math.max(1, ocv);
    this.voltage = ocv - this.current * 0.02;
    this.remainingWh = Math.max(0, this.remainingWh - (power * dt) / 3600);
  }

  private failsafes(): void {
    if (!this.armed || !this.inAir) return;
    const pct = this.batteryPct;
    if (!this.criticalBatteryTriggered && pct < this.opts.criticalBatteryPct) {
      this.criticalBatteryTriggered = true;
      this.emit('critical', `Critical battery ${pct.toFixed(0)} %: emergency landing`, 'failsafe');
      this.setMode('LAND');
    } else if (!this.lowBatteryTriggered && pct < this.opts.lowBatteryPct) {
      this.lowBatteryTriggered = true;
      this.emit('warning', `Low battery ${pct.toFixed(0)} % failsafe: returning to launch`, 'failsafe');
      if (this.mode !== 'LAND' && this.mode !== 'RTL') this.setMode('RTL');
    }
    const gf = this.mission?.geofence;
    if (gf && gf.polygon.length >= 3 && !this.geofenceTriggered) {
      const outside = !pointInPolygon(this, gf.polygon) || (gf.maxAlt != null && this.altRel > gf.maxAlt);
      if (outside) {
        this.geofenceTriggered = true;
        this.emit('critical', `Geofence breach: ${gf.action.toUpperCase()}`, 'failsafe');
        this.setMode(gf.action === 'land' ? 'LAND' : gf.action === 'hold' ? 'HOLD' : 'RTL');
      }
    }
    if (!this.linkUp && this.linkLostAt !== null && this.now - this.linkLostAt > 10_000 && (this.mode === 'POSCTL' || this.mode === 'GUIDED' || this.mode === 'HOLD')) {
      this.linkLostAt = null;
      this.emit('warning', 'Data link lost failsafe: returning to launch', 'failsafe');
      this.setMode('RTL');
    }
  }

  // =====================================================================================
  // Telemetry
  // =====================================================================================

  /** Output of each lift motor (0…1): four for a quad, as many as the airframe's rotors otherwise. */
  motors(): number[] {
    const n = Math.max(1, Math.min(12, this.opts.airframe?.rotors ?? 4));
    if (!this.armed) return new Array<number>(n).fill(0);
    const base = this.inAir ? 0.48 + Math.max(0, this.vU) * 0.04 + this.groundSpeed * 0.008 : 0.12;
    const r = Math.max(-0.15, Math.min(0.15, this.rollRate * 0.003));
    const p = Math.max(-0.15, Math.min(0.15, this.pitchRate * 0.003));
    const imb = this.opts.motorImbalance;
    const noise = () => (this.random() - 0.5) * 0.02;
    if (n === 4) return [base + r - p + imb + noise(), base - r + p + noise(), base + r + p + noise(), base - r - p + noise()].map((v) => Math.max(0, Math.min(1, v)));
    // Rotors evenly around the frame (coaxial pairs share an arm): roll and pitch by position; motor 1 carries the imbalance.
    const arms = this.opts.airframe?.coaxial ? n / 2 : n;
    return Array.from({ length: n }, (_, i) => {
      const a = ((i % arms) / arms) * 2 * Math.PI + Math.PI / arms;
      return Math.max(0, Math.min(1, base + r * Math.sin(a) * 1.4 - p * Math.cos(a) * 1.4 + (i === 0 ? imb : 0) + noise()));
    });
  }

  vibration(): number {
    if (!this.armed) return 0.5;
    return this.opts.vibration * (this.inAir ? 1 : 0.4) * (1 + this.opts.motorImbalance * 3) + this.random() * 3;
  }

  telemetry(): Telemetry {
    const sats = 14 + Math.round(this.random() * 4 - 2);
    return {
      t: this.now,
      lat: this.lat,
      lon: this.lon,
      altMsl: this.opts.groundAltMsl + this.altRel,
      altRel: this.altRel,
      heading: this.heading,
      groundSpeed: this.groundSpeed,
      climbRate: this.vU,
      roll: this.roll,
      pitch: this.pitch,
      yaw: this.heading > 180 ? this.heading - 360 : this.heading,
      battery: { pct: this.batteryPct, voltage: this.voltage, current: this.current },
      gps: { fix: 3, satellites: sats, hdop: 0.6 + this.random() * 0.3 },
      mode: this.mode,
      armed: this.armed,
      inAir: this.inAir,
      link: { tech: 'LTE', rsrp: -82 - Math.round(this.random() * 12), rsrq: -9 - Math.round(this.random() * 4), sinr: 14 + Math.round(this.random() * 8), quality: 85 + Math.round(this.random() * 10) },
      home: { ...this.home },
      missionSeq: this.mission ? this.missionIndex : null,
      missionTotal: this.mission ? this.mission.items.length : null,
      wind: { speed: this.wind.speed + (this.random() - 0.5), dir: (this.wind.dir + (this.random() - 0.5) * 10 + 360) % 360 },
      vibration: this.vibration(),
      motors: this.motors(),
    };
  }

  /** Re-charges the battery (between demo flights / after landing). */
  recharge(): void {
    this.remainingWh = this.opts.capacityWh;
  }
}

function clampV(dz: number, up: number, down: number): number {
  return Math.max(-down, Math.min(up, dz));
}
