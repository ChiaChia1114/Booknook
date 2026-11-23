import type { EventLevel, Telemetry } from '@athena-sky/shared';
import { NAV_STATE, SIM_FORMATS, ULogWriter, eulerToQuat } from './ulog-writer';

const SYSLOG: Record<EventLevel, number> = { critical: 2, error: 3, warning: 4, info: 6 };

/** Records telemetry on board (like an SD-card logger) and produces a PX4 ULog file. */
export class OnboardLogger {
  private rows: Telemetry[] = [];
  private events: { t: number; level: EventLevel; text: string }[] = [];
  private lastAt = 0;

  constructor(
    private readonly bootMs: number,
    private readonly rateHz = 10,
  ) {}

  get size(): number {
    return this.rows.length;
  }

  record(t: Telemetry): void {
    if (t.t - this.lastAt < 1000 / this.rateHz) return;
    this.lastAt = t.t;
    this.rows.push(t);
  }

  event(t: number, level: EventLevel, text: string): void {
    this.events.push({ t, level, text });
  }

  reset(): void {
    this.rows = [];
    this.events = [];
  }

  build(meta: { sysName: string; firmware: string; hardware: string; serial?: string }): Buffer {
    const us = (ms: number) => Math.max(0, (ms - this.bootMs) * 1000);
    const w = new ULogWriter(us(this.rows[0]?.t ?? this.bootMs));
    w.info('sys_name', meta.sysName).info('ver_sw', meta.firmware).info('ver_hw', meta.hardware);
    if (meta.serial) w.info('sys_uuid', meta.serial);
    w.info('time_ref_utc', 0, 'int32_t');
    w.param('MAV_TYPE', 2, 'int32_t').param('CA_ROTOR_COUNT', 4, 'int32_t');
    w.param('MPC_XY_CRUISE', 8).param('RTL_RETURN_ALT', 30).param('COM_LOW_BAT_ACT', 3, 'int32_t');
    for (const f of SIM_FORMATS) w.format(f);
    const home = this.rows.find((r) => r.home)?.home;
    let ei = 0;
    for (const r of this.rows) {
      while (ei < this.events.length && this.events[ei]!.t <= r.t) {
        const e = this.events[ei++]!;
        w.log(SYSLOG[e.level], us(e.t), e.text);
      }
      const ts = us(r.t);
      const hdg = (r.heading * Math.PI) / 180;
      const vN = r.groundSpeed * Math.cos(hdg);
      const vE = r.groundSpeed * Math.sin(hdg);
      if (home && ts === us(this.rows[0]!.t)) w.data('home_position', { timestamp: ts, lat: home.lat, lon: home.lon, alt: home.altMsl });
      w.data('vehicle_global_position', { timestamp: ts, lat: r.lat, lon: r.lon, alt: r.altMsl, eph: 0.8, epv: 1.2 });
      w.data('sensor_gps', {
        timestamp: ts + 200,
        time_utc_usec: r.t * 1000,
        latitude_deg: r.lat,
        longitude_deg: r.lon,
        altitude_msl_m: r.altMsl,
        vel_n_m_s: vN,
        vel_e_m_s: vE,
        vel_d_m_s: -r.climbRate,
        hdop: r.gps.hdop,
        fix_type: r.gps.fix,
        satellites_used: r.gps.satellites,
      });
      w.data('vehicle_local_position', { timestamp: ts + 300, x: 0, y: 0, z: -r.altRel, vx: vN, vy: vE, vz: -r.climbRate });
      w.data('vehicle_attitude', { timestamp: ts + 400, q: eulerToQuat(r.roll, r.pitch, r.yaw) });
      w.data('battery_status', { timestamp: ts + 500, voltage_v: r.battery.voltage, current_a: r.battery.current, remaining: r.battery.pct / 100 });
      w.data('vehicle_status', { timestamp: ts + 600, arming_state: r.armed ? 2 : 1, nav_state: NAV_STATE[r.mode] ?? 4 });
      w.data('vehicle_land_detected', { timestamp: ts + 700, landed: r.inAir ? 0 : 1 });
      w.data('vehicle_imu_status', { timestamp: ts + 800, accel_vibration_metric: r.vibration ?? 0, gyro_vibration_metric: (r.vibration ?? 0) / 50 });
      if (r.motors) w.data('actuator_motors', { timestamp: ts + 900, control: r.motors.slice(0, 4) });
    }
    while (ei < this.events.length) {
      const e = this.events[ei++]!;
      w.log(SYSLOG[e.level], us(e.t), e.text);
    }
    return w.toBuffer();
  }
}
