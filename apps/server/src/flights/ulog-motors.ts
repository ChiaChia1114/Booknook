/**
 * Which outputs of a PX4 log drive the lift motors, so that motor balance compares motors only.
 *
 * PX4 ≥ 1.13 logs `actuator_motors` (normalised 0…1 per motor, NaN when stopped). Older logs only
 * have `actuator_outputs`: the PWM of every output channel, where motors, servos, pass-through
 * channels and unused outputs (0 µs) sit side by side and the layout depends on the airframe.
 * Multicopter mixers put the motors on the first outputs, so the vehicle type (MAV_TYPE) gives
 * their number; for VTOL, fixed-wing and other airframes the motor channels cannot be told apart
 * reliably and no motor data is read.
 */
import { topic, type ULogFile, type ULogTopic } from './ulog';

/** MAVLink MAV_TYPE of multicopters → number of lift rotors. */
const ROTORS_BY_MAV_TYPE: Readonly<Record<number, number>> = { 2: 4, 13: 6, 14: 8, 15: 3, 29: 12, 35: 10 };
/** MAV_TYPE_GENERIC_MULTIROTOR: a multicopter whose rotor count comes from CA_ROTOR_COUNT. */
const GENERIC_MULTIROTOR = 43;
/** MAV_TYPE values of VTOL airframes (tailsitters, tiltrotors, standard VTOL, tiltwings). */
const VTOL_MAV_TYPES = new Set([19, 20, 21, 22, 23, 24, 25]);
/** Most motor channels read (PX4 logs up to 12 motors and 16 outputs). */
export const MAX_MOTOR_CHANNELS = 12;
export const MAX_OUTPUT_CHANNELS = 16;
/** PWM values outside this range mean an output that is not driven (0 µs) or not a PWM output. */
const PWM_LOWEST = 800;
const PWM_HIGHEST = 2200;
/** A PWM channel that moves by less than this over the whole log is held at one value. */
const STEADY_SPAN_US = 1;
/** PWM of a centred servo or pass-through channel. */
const PWM_CENTRE = 1500;
/** Motor counts accepted when the vehicle type is unknown. */
const PLAUSIBLE_ROTOR_COUNTS = new Set([3, 4, 6, 8]);

export interface MotorChannels {
  topic: ULogTopic;
  /** Fields of the motors, in motor order. */
  fields: string[];
  /** Per motor: logged value → output 0…1, or null when the value means "not driven". */
  scale: ((v: number) => number | null)[];
  /** How the channels were chosen (for diagnostics and tests). */
  basis: 'actuator_motors' | 'vehicle_type' | 'output_pattern';
}

function intParam(file: ULogFile, name: string): number | null {
  const v = file.params[name];
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

/** MAV_TYPE from the parameters, else from vehicle_status.system_type; and whether the airframe is a VTOL. */
export function vehicleType(file: ULogFile): { type: number | null; vtol: boolean } {
  const status = topic(file, 'vehicle_status');
  const firstValid = (field: string) => status?.data[field]?.find((v) => Number.isFinite(v)) ?? null;
  // MAV_TYPE_GENERIC (0) says nothing about the airframe.
  const known = (v: number | null) => (v === null || v === 0 ? null : v);
  const type = known(intParam(file, 'MAV_TYPE')) ?? known(firstValid('system_type'));
  const vtol = (type !== null && VTOL_MAV_TYPES.has(type)) || (status?.data['is_vtol']?.some((v) => v === 1) ?? false);
  return { type, vtol };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** PWM range of output `i` (0-based) from PWM_MAIN_MINn/MAXn, PWM_MAIN_MIN/MAX or PWM_MIN/MAX. */
function pwmRange(file: ULogFile, i: number): { lo: number; hi: number } {
  const pick = (names: string[], fallback: number) => {
    for (const n of names) {
      const v = intParam(file, n);
      if (v !== null && v >= PWM_LOWEST && v <= PWM_HIGHEST) return v;
    }
    return fallback;
  };
  const lo = pick([`PWM_MAIN_MIN${i + 1}`, 'PWM_MAIN_MIN', 'PWM_MIN'], 1000);
  const hi = pick([`PWM_MAIN_MAX${i + 1}`, 'PWM_MAIN_MAX', 'PWM_MAX'], 2000);
  return hi - lo >= 100 ? { lo, hi } : { lo: 1000, hi: 2000 };
}

interface ChannelStats {
  /** Share of the samples with a PWM value. */
  driven: number;
  lo: number;
  hi: number;
}

function channelStats(values: number[], keep: boolean[] | null): ChannelStats {
  let n = 0;
  let all = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (keep && !keep[i]) continue;
    all++;
    const v = values[i]!;
    if (!(v >= PWM_LOWEST && v <= PWM_HIGHEST)) continue;
    n++;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return { driven: all ? n / all : 0, lo, hi };
}

/** Per sample of `t`: whether the vehicle was armed (vehicle_status), or null when that is not logged or never true. */
function armedSamples(file: ULogFile, t: ULogTopic): boolean[] | null {
  const status = topic(file, 'vehicle_status');
  const arming = status?.data['arming_state'];
  if (!status || !arming) return null;
  const ts = status.timestamps;
  let j = -1;
  let any = false;
  const out = t.timestamps.map((us) => {
    while (j + 1 < ts.length && ts[j + 1]! <= us) j++;
    const armed = j >= 0 && arming[j] === 2;
    any ||= armed;
    return armed;
  });
  return any ? out : null;
}

/**
 * Motor count of an `actuator_outputs` log whose vehicle type is unknown (no MAV_TYPE): the leading
 * PWM-driven channels while armed, without trailing channels held at one value (servos, pass-through)
 * when the earlier ones move or the held value is the servo centre. Only typical multicopter counts
 * are accepted.
 */
function guessRotorCount(file: ULogFile, t: ULogTopic, fields: string[]): number | null {
  const armed = armedSamples(file, t);
  const stats: ChannelStats[] = [];
  for (const f of fields) {
    const s = channelStats(t.data[f]!, armed);
    if (s.driven < 0.5) break;
    stats.push(s);
  }
  const steady = (s: ChannelStats) => s.hi - s.lo < STEADY_SPAN_US;
  let n = stats.length;
  while (n > 0) {
    const s = stats[n - 1]!;
    const earlierMove = stats.slice(0, n - 1).some((e) => !steady(e));
    if (steady(s) && (earlierMove || Math.abs(s.lo - PWM_CENTRE) < STEADY_SPAN_US)) n--;
    else break;
  }
  return PLAUSIBLE_ROTOR_COUNTS.has(n) ? n : null;
}

/** The lift-motor channels of a ULog, or null when there are none or they cannot be identified. */
export function motorChannels(file: ULogFile): MotorChannels | null {
  const { type, vtol } = vehicleType(file);
  // Motor balance compares the lift rotors of a multicopter; VTOL pushers and tilting rotors,
  // fixed-wing motors and helicopter rotors would make it meaningless.
  if (vtol) return null;
  if (type !== null && ROTORS_BY_MAV_TYPE[type] === undefined && type !== GENERIC_MULTIROTOR) return null;
  const rotorParam = intParam(file, 'CA_ROTOR_COUNT');
  const typeCount = type !== null ? ROTORS_BY_MAV_TYPE[type] : undefined;

  const motors = topic(file, 'actuator_motors');
  if (motors && motors.timestamps.length > 0) {
    const fields: string[] = [];
    for (let i = 0; i < MAX_MOTOR_CHANNELS && motors.data[`control[${i}]`]; i++) fields.push(`control[${i}]`);
    // Unused motors are NaN throughout.
    let used = 0;
    while (used < fields.length && motors.data[fields[used]!]!.some(Number.isFinite)) used++;
    const n = rotorParam !== null && rotorParam > 0 ? rotorParam : (typeCount ?? used);
    if (n < 2 || n > used) return null;
    const scale = (v: number) => (Number.isFinite(v) ? (v < -1 ? -1 : v > 1 ? 1 : v) : null);
    return { topic: motors, fields: fields.slice(0, n), scale: fields.slice(0, n).map(() => scale), basis: 'actuator_motors' };
  }

  const outputs = topic(file, 'actuator_outputs');
  if (!outputs || outputs.timestamps.length === 0) return null;
  const fields: string[] = [];
  for (let i = 0; i < MAX_OUTPUT_CHANNELS && outputs.data[`output[${i}]`]; i++) fields.push(`output[${i}]`);
  const nOut = outputs.data['noutputs']?.reduce((m, v) => (Number.isFinite(v) && v > m ? v : m), 0);
  const usable = nOut ? fields.slice(0, Math.min(fields.length, nOut)) : fields;
  const n = typeCount ?? (rotorParam !== null && rotorParam > 0 ? rotorParam : null) ?? guessRotorCount(file, outputs, usable);
  if (n === null || n < 2 || n > usable.length) return null;
  const scale = usable.slice(0, n).map((_, i) => {
    const { lo, hi } = pwmRange(file, i);
    return (v: number) => (v >= PWM_LOWEST && v <= PWM_HIGHEST ? clamp01((v - lo) / (hi - lo)) : null);
  });
  return { topic: outputs, fields: usable.slice(0, n), scale, basis: typeCount !== undefined || (rotorParam !== null && rotorParam > 0) ? 'vehicle_type' : 'output_pattern' };
}
