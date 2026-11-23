import { describe, expect, it } from 'vitest';
import { SIM_FORMATS, ULogWriter, simulateMission } from '@athena-sky/simulator';
import { airframeById, destinationPoint, newItemId, type MissionPlan } from '@athena-sky/shared';
import { normalizeLog } from '../src/flights/ingest';
import { analyzeFlight } from '../src/flights/analysis';
import { parseULog } from '../src/flights/ulog';
import { motorChannels } from '../src/flights/ulog-motors';

interface Layout {
  params?: Record<string, number>;
  /** Logged channels in use (actuator_outputs.noutputs). */
  noutputs: number;
  /** Output PWM while airborne, per sample index. */
  air: (i: number) => number[];
  /** Output PWM on the ground (default: disarmed 900 µs on the channels in use). */
  ground?: number[];
  systemType?: number;
  isVtol?: boolean;
  /** Never armed (a bench or simulator test). */
  neverArmed?: boolean;
}

const OUTPUTS_FORMAT = 'actuator_outputs:uint64_t timestamp;uint32_t noutputs;float[16] output;uint8_t[4] _padding0';
const pad = (v: number[]) => v.concat(Array(16 - v.length).fill(0));
const jitter = (i: number, k: number) => Math.round(8 * Math.sin(i * 0.7 + k * 1.3));

/** A 5-minute PX4-style log at 2 Hz with legacy `actuator_outputs` (like PX4 before v1.13). */
function px4Log(l: Layout): Buffer {
  const w = new ULogWriter(0);
  w.info('sys_name', 'PX4');
  for (const [k, v] of Object.entries(l.params ?? {})) w.param(k, v, 'int32_t');
  for (const f of SIM_FORMATS.filter((f) => !f.startsWith('vehicle_status:'))) w.format(f);
  w.format('vehicle_status:uint64_t timestamp;uint8_t arming_state;uint8_t nav_state;uint8_t system_type;bool is_vtol;uint8_t[4] _padding0');
  w.format(OUTPUTS_FORMAT);
  for (let i = 0; i < 600; i++) {
    const ts = 1_000_000 + i * 500_000;
    const air = i > 20 && i < 580;
    w.data('vehicle_global_position', { timestamp: ts, lat: 25.03 + i * 1e-5, lon: 121.56, alt: air ? 40 : 10, eph: 1, epv: 1 });
    w.data('vehicle_status', { timestamp: ts + 10, arming_state: air && !l.neverArmed ? 2 : 1, nav_state: 3, system_type: l.systemType ?? 0, is_vtol: l.isVtol ? 1 : 0 });
    w.data('home_position', { timestamp: ts + 20, lat: 25.03, lon: 121.56, alt: 10 });
    const out = air ? l.air(i) : (l.ground ?? Array.from({ length: l.noutputs }, () => 900));
    w.data('actuator_outputs', { timestamp: ts + 30, noutputs: l.noutputs, output: pad(out) });
  }
  return w.toBuffer();
}

function analyse(buf: Buffer) {
  const log = normalizeLog(buf, 'log.ulg');
  const r = analyzeFlight({ samples: log.samples, events: log.events, history: [] });
  return { log, r, motor: r.findings.filter((f) => f.code.startsWith('motor_')) };
}

describe('motor channels of PX4 logs', () => {
  it('reads no motors from a standard VTOL, whose outputs mix servos, lift motors and a pusher', () => {
    // Output layout of a PX4 v1.11 standard VTOL log: control surfaces and pusher on 1–4, lift motors on 5–8.
    const buf = px4Log({
      params: { MAV_TYPE: 22, PWM_MIN: 950, PWM_MAX: 2000 },
      noutputs: 8,
      air: (i) => [1596 + jitter(i, 0), 1491 + jitter(i, 1), 1000, 1508 + jitter(i, 3), 1328 + jitter(i, 4), 1107 + jitter(i, 5), 1169 + jitter(i, 6), 1044 + jitter(i, 7)],
    });
    expect(motorChannels(parseULog(buf, { include: () => true }))).toBeNull();
    const { log, motor } = analyse(buf);
    expect(log.samples.some((s) => s.motors)).toBe(false);
    expect(motor).toEqual([]);
  });

  it('also tells a VTOL from vehicle_status when the parameters are missing', () => {
    const air = () => [1780, 1440, 1440, 1440, 1500, 1500, 1500, 1500];
    expect(analyse(px4Log({ systemType: 22, noutputs: 8, air })).motor).toEqual([]);
    expect(analyse(px4Log({ isVtol: true, noutputs: 8, air })).motor).toEqual([]);
    // The same outputs of an airframe not known to be a VTOL are read as four motors and one failing.
    expect(analyse(px4Log({ noutputs: 8, air: () => [1780, 1440, 1440, 1440] })).motor).toHaveLength(1);
  });

  it('compares only the motors of a quadcopter whose other outputs are servos or unused', () => {
    // pyulog's sample_appended.ulg layout: motors 1–4, pass-through 5–6 at 1500 µs, 7–16 unused (0 µs).
    const buf = px4Log({ params: { MAV_TYPE: 2, PWM_MIN: 1075, PWM_MAX: 1950 }, noutputs: 6, air: (i) => [0, 1, 2, 3].map((k) => 1450 + jitter(i, k)).concat([1500, 1500]) });
    const { log, r, motor } = analyse(buf);
    const airborne = log.samples.filter((s) => s.armed);
    expect(airborne.every((s) => s.motors?.length === 4)).toBe(true);
    // Scaled with the log's PWM range: (1450 − 1075) / (1950 − 1075) ≈ 0.43.
    expect(airborne[100]!.motors![0]).toBeCloseTo((1450 + jitter(121, 0) - 1075) / 875, 3);
    expect(motor).toEqual([]);
    expect(r.metrics.motorImbalance).toBeLessThan(0.05);
  });

  it('flags a failing motor next to unused outputs (0 µs)', () => {
    // pyulog's sample.ulg layout: motors 1–4, outputs 5–16 at 0 µs.
    for (const params of [{ MAV_TYPE: 2 }, {}] as Record<string, number>[]) {
      const { r, motor } = analyse(px4Log({ params, noutputs: 8, air: (i) => [1780, 1440, 1440, 1440].map((v, k) => v + jitter(i, k)) }));
      expect(motor.map((f) => f.severity)).toEqual(['critical']);
      expect(motor[0]!.detail).toMatch(/^Motor 1 works \d+ % harder/);
      expect(r.metrics.motorImbalance).toBeGreaterThan(0.6);
    }
  });

  it('without a vehicle type, leaves out servo and pass-through outputs held at one value', () => {
    for (const air of [() => [1400, 1400, 1400, 1400, 1500, 1500], (i: number) => [0, 1, 2, 3].map((k) => 1400 + jitter(i, k)).concat([1500, 1500])]) {
      const { log, motor } = analyse(px4Log({ noutputs: 6, air }));
      expect(log.samples.find((s) => s.armed)!.motors).toHaveLength(4);
      expect(motor).toEqual([]);
    }
    // Five or seven driven outputs are no recognisable multicopter layout: no motor data.
    const odd = analyse(px4Log({ noutputs: 5, air: (i) => [0, 1, 2, 3, 4].map((k) => 1400 + jitter(i, k)) }));
    expect(odd.log.samples.some((s) => s.motors)).toBe(false);
  });

  it('refuses a log in which the vehicle was never armed: a bench test, not a flight', () => {
    expect(() => normalizeLog(px4Log({ params: { MAV_TYPE: 2 }, noutputs: 4, air: () => [1500, 1500, 1500, 1500], neverArmed: true }), 'bench.ulg')).toThrow(/never armed/);
  });

  it('reads as many motors as the airframe has, and none for fixed-wing aircraft', () => {
    const hexa = analyse(px4Log({ params: { MAV_TYPE: 13 }, noutputs: 8, air: (i) => [0, 1, 2, 3, 4, 5].map((k) => 1500 + jitter(i, k)).concat([1500, 1500]) }));
    expect(hexa.log.samples.find((s) => s.armed)!.motors).toHaveLength(6);
    expect(hexa.motor).toEqual([]);
    const plane = analyse(px4Log({ params: { MAV_TYPE: 1 }, noutputs: 8, air: () => [1500, 1500, 1800, 1500] }));
    expect(plane.log.samples.some((s) => s.motors)).toBe(false);
  });

  it('uses the per-output PWM limits and treats outputs that are not driven as missing', () => {
    const buf = px4Log({
      params: { MAV_TYPE: 2, PWM_MAIN_MIN: 1100, PWM_MAIN_MAX: 1900, PWM_MAIN_MIN2: 1000, PWM_MAIN_MAX2: 2000 },
      noutputs: 4,
      air: (i) => (i === 300 ? [1500, 1500, 0, 1500] : [1500, 1500, 1500, 1500]),
    });
    const { log } = analyse(buf);
    const s = log.samples.find((x) => x.armed)!;
    expect(s.motors![0]).toBeCloseTo(0.5);
    expect(s.motors![1]).toBeCloseTo(0.5);
    // A sample with an output at 0 µs has no motor data rather than a "−100 %" motor.
    expect(log.samples.filter((x) => x.armed && !x.motors).length).toBeLessThanOrEqual(1);
    expect(log.samples.every((x) => !x.motors || x.motors.every((v) => v >= 0 && v <= 1))).toBe(true);
  });

  it('reads actuator_motors of newer logs up to the rotor count, and none of a VTOL', () => {
    const make = (params: Record<string, number>) => {
      const w = new ULogWriter(0);
      for (const [k, v] of Object.entries(params)) w.param(k, v, 'int32_t');
      for (const f of SIM_FORMATS.filter((f) => !f.startsWith('actuator_motors:'))) w.format(f);
      w.format('actuator_motors:uint64_t timestamp;float[12] control');
      for (let i = 0; i < 100; i++) {
        const ts = 1_000_000 + i * 500_000;
        w.data('vehicle_global_position', { timestamp: ts, lat: 25.03, lon: 121.56, alt: 40, eph: 1, epv: 1 });
        w.data('actuator_motors', { timestamp: ts + 30, control: [0.5, 0.52, 0.5, 0.52, 0.9].concat(Array(7).fill(NaN)) });
      }
      return parseULog(w.toBuffer(), { include: () => true });
    };
    const quad = motorChannels(make({ MAV_TYPE: 2, CA_ROTOR_COUNT: 4 }))!;
    expect(quad.basis).toBe('actuator_motors');
    expect(quad.fields).toEqual(['control[0]', 'control[1]', 'control[2]', 'control[3]']);
    // Without a rotor count: every motor that is ever driven.
    expect(motorChannels(make({}))!.fields).toHaveLength(5);
    expect(motorChannels(make({ MAV_TYPE: 22, CA_ROTOR_COUNT: 5 }))).toBeNull();
  });
});

describe("the simulator's on-board logs", () => {
  const HOME = { lat: 25.0732, lon: 121.5355 };
  const plan: MissionPlan = {
    home: { ...HOME, alt: 8 },
    items: [
      { id: newItemId(), type: 'takeoff', alt: 30 },
      { id: newItemId(), type: 'waypoint', ...destinationPoint(HOME, 90, 300), alt: 30 },
      { id: newItemId(), type: 'rtl' },
    ],
    rallyPoints: [],
    geofence: null,
    defaultSpeed: 8,
    defaultAlt: 30,
  };
  const log = (airframe: string) => {
    const sim = simulateMission(plan, { home: HOME, startTime: Date.UTC(2026, 9, 1, 2, 0), ulog: true, drone: { groundAltMsl: 8, seed: 3, airframe: airframeById(airframe) ?? null } });
    return parseULog(sim.ulog!, { include: () => true });
  };

  it('declare the airframe they fly: rotor count and vehicle type as PX4 does', () => {
    const x8 = log('hamburger-x8');
    expect(x8.params.MAV_TYPE).toBe(14);
    expect(x8.params.CA_ROTOR_COUNT).toBe(8);
    const m = motorChannels(x8)!;
    expect(m.basis).toBe('actuator_motors');
    expect(m.fields).toHaveLength(8);
    const vtol = log('athena-vtol');
    expect(vtol.params.MAV_TYPE).toBe(22);
    // As for a real PX4 VTOL: no motor balance verdict.
    expect(motorChannels(vtol)).toBeNull();
  });
});
