/** Normalised vehicle telemetry exchanged between drones, the cloud and viewers. */

export const FLIGHT_MODES = ['MANUAL', 'POSCTL', 'HOLD', 'TAKEOFF', 'MISSION', 'RTL', 'LAND', 'GUIDED'] as const;
export type FlightMode = (typeof FLIGHT_MODES)[number] | (string & {});

export interface BatteryState {
  /** Remaining charge 0..100 %. */
  pct: number;
  voltage: number;
  current: number;
}

export interface GpsState {
  /** 0 = no fix, 2 = 2D, 3 = 3D, 4 = DGPS, 5 = RTK float, 6 = RTK fixed. */
  fix: number;
  satellites: number;
  hdop: number;
}

export interface LinkState {
  /** e.g. 'LTE', '5G', 'RF'. */
  tech?: string;
  rssi?: number;
  rsrp?: number;
  rsrq?: number;
  sinr?: number;
  /** 0..100 link quality estimate. */
  quality?: number;
}

export interface HomePosition {
  lat: number;
  lon: number;
  altMsl: number;
}

export interface Telemetry {
  /** Sample time (epoch ms). */
  t: number;
  lat: number;
  lon: number;
  /** Altitude above mean sea level (m). */
  altMsl: number;
  /** Altitude relative to home / takeoff (m). */
  altRel: number;
  /** Heading 0..360 deg. */
  heading: number;
  /** Horizontal ground speed (m/s). */
  groundSpeed: number;
  /** Vertical speed (m/s, positive up). */
  climbRate: number;
  airSpeed?: number;
  roll: number;
  pitch: number;
  yaw: number;
  battery: BatteryState;
  gps: GpsState;
  mode: FlightMode;
  armed: boolean;
  inAir: boolean;
  link?: LinkState;
  home?: HomePosition | null;
  missionSeq?: number | null;
  missionTotal?: number | null;
  wind?: { speed: number; dir: number };
  /** Vibration level (m/s^2 RMS). */
  vibration?: number;
  /** Normalised motor outputs 0..1. */
  motors?: number[];
}

const num = (v: unknown, lo = -Infinity, hi = Infinity): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined;

/**
 * Validates and normalises an untrusted telemetry payload.
 * Returns null when mandatory fields are missing or out of range.
 */
export function sanitizeTelemetry(raw: unknown, now = Date.now()): Telemetry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const lat = num(r.lat, -90, 90);
  const lon = num(r.lon, -180, 180);
  const altMsl = num(r.altMsl, -1000, 20000);
  if (lat === undefined || lon === undefined || altMsl === undefined) return null;
  const b = (r.battery ?? {}) as Record<string, unknown>;
  const g = (r.gps ?? {}) as Record<string, unknown>;
  const t: Telemetry = {
    t: num(r.t, 0) ?? now,
    lat,
    lon,
    altMsl,
    altRel: num(r.altRel, -1000, 20000) ?? 0,
    heading: ((num(r.heading) ?? 0) % 360 + 360) % 360,
    groundSpeed: num(r.groundSpeed, 0, 400) ?? 0,
    climbRate: num(r.climbRate, -200, 200) ?? 0,
    roll: num(r.roll, -180, 180) ?? 0,
    pitch: num(r.pitch, -180, 180) ?? 0,
    yaw: num(r.yaw, -360, 360) ?? 0,
    battery: {
      pct: num(b.pct, 0, 100) ?? 0,
      voltage: num(b.voltage, 0, 1000) ?? 0,
      current: num(b.current, -1000, 1000) ?? 0,
    },
    gps: {
      fix: Math.round(num(g.fix, 0, 10) ?? 0),
      satellites: Math.round(num(g.satellites, 0, 255) ?? 0),
      hdop: num(g.hdop, 0, 100) ?? 99,
    },
    mode: typeof r.mode === 'string' && r.mode.length <= 32 ? r.mode : 'UNKNOWN',
    armed: r.armed === true,
    inAir: r.inAir === true,
  };
  const air = num(r.airSpeed, 0, 400);
  if (air !== undefined) t.airSpeed = air;
  if (r.link && typeof r.link === 'object') {
    const l = r.link as Record<string, unknown>;
    t.link = {
      tech: typeof l.tech === 'string' ? l.tech.slice(0, 16) : undefined,
      rssi: num(l.rssi),
      rsrp: num(l.rsrp),
      rsrq: num(l.rsrq),
      sinr: num(l.sinr),
      quality: num(l.quality, 0, 100),
    };
  }
  if (r.home && typeof r.home === 'object') {
    const h = r.home as Record<string, unknown>;
    const hl = num(h.lat, -90, 90);
    const ho = num(h.lon, -180, 180);
    const ha = num(h.altMsl, -1000, 20000);
    t.home = hl !== undefined && ho !== undefined && ha !== undefined ? { lat: hl, lon: ho, altMsl: ha } : null;
  }
  const seq = num(r.missionSeq, 0, 100000);
  if (seq !== undefined) t.missionSeq = Math.round(seq);
  const tot = num(r.missionTotal, 0, 100000);
  if (tot !== undefined) t.missionTotal = Math.round(tot);
  if (r.wind && typeof r.wind === 'object') {
    const w = r.wind as Record<string, unknown>;
    const ws = num(w.speed, 0, 200);
    const wd = num(w.dir, -360, 720);
    if (ws !== undefined && wd !== undefined) t.wind = { speed: ws, dir: ((wd % 360) + 360) % 360 };
  }
  const vib = num(r.vibration, 0, 1000);
  if (vib !== undefined) t.vibration = vib;
  if (Array.isArray(r.motors) && r.motors.length <= 16) {
    const m = r.motors.map((v) => num(v, 0, 1));
    if (m.every((v) => v !== undefined)) t.motors = m as number[];
  }
  return t;
}
