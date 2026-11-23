/**
 * Converts uploaded flight logs (PX4 ULog, CSV, Athena JSON export) into the
 * normalised sample/event representation used for storage and analytics.
 *
 * Every reader is a generator (see lib/slice): a long log is read in slices and the server
 * goes on answering meanwhile. Text is decoded a block at a time, never as one string.
 */
import type { FlightEventDto, FlightSampleDto } from '@athena-sky/shared';
import { haversineDistance } from '@athena-sky/shared';
import { runAtOnce, sortSteps, type Steps } from '../lib/slice';
import { isULog, parseULogSteps, topic, type ULogFile, type ULogTopic } from './ulog';

export interface NormalizedLog {
  kind: 'ulog' | 'csv' | 'json';
  startedAt: number;
  endedAt: number;
  /**
   * The times come from the log itself (GNSS time, absolute timestamps, an export); else they
   * count from when the log was received, which says nothing about when it was flown.
   */
  absoluteTime: boolean;
  samples: FlightSampleDto[];
  events: FlightEventDto[];
  vehicle: { model?: string; firmware?: string; serial?: string };
}

export class LogFormatError extends Error {}

/** Most samples stored for one flight, once down-sampled (55 hours at 5 Hz). */
export const MAX_LOG_SAMPLES = 1_000_000;
/** Most events (log messages) kept from one log; a last one says how many more it had. */
export const MAX_LOG_EVENTS = 10_000;

const tooManySamples = () =>
  new LogFormatError(`The log holds more than ${MAX_LOG_SAMPLES.toLocaleString('en')} samples once down-sampled – split it into shorter logs`);

/**
 * Keeps samples at least `spacingMs` apart, and always the last one. In one pass while the
 * samples come in order of time (logs do); samples out of order are gathered and everything is
 * sorted and thinned again at the end.
 */
class Thinner {
  private kept: FlightSampleDto[] = [];
  /** The latest sample (in order of time) – kept at the end if it is not kept by then. */
  private last: FlightSampleDto | null = null;
  private unsorted: FlightSampleDto[] | null = null;

  constructor(private readonly spacingMs: number) {}

  push(s: FlightSampleDto): void {
    if (this.unsorted) {
      if (this.unsorted.length >= MAX_LOG_SAMPLES) throw new LogFormatError(`More than ${MAX_LOG_SAMPLES.toLocaleString('en')} samples are out of time order – sort the log by time`);
      this.unsorted.push(s);
      return;
    }
    if (this.last && s.t < this.last.t) {
      this.unsorted = [s];
      return;
    }
    this.last = s;
    const prev = this.kept[this.kept.length - 1];
    if (!prev || s.t - prev.t >= this.spacingMs) {
      if (this.kept.length >= MAX_LOG_SAMPLES) throw tooManySamples();
      this.kept.push(s);
    }
  }

  *finish(): Steps<FlightSampleDto[]> {
    if (this.unsorted) {
      let all = this.kept;
      if (this.last && all[all.length - 1] !== this.last) all = all.concat([this.last]);
      const sorted = yield* sortSteps(all.concat(this.unsorted), (x) => x.t);
      this.kept = [];
      this.last = null;
      this.unsorted = null;
      for (let i = 0; i < sorted.length; i++) {
        if ((i & 4095) === 4095) yield;
        this.push(sorted[i]!);
      }
    }
    if (this.last && this.kept[this.kept.length - 1] !== this.last) this.kept.push(this.last);
    return this.kept;
  }
}

/**
 * At most `MAX_LOG_EVENTS` events (the earliest), the last of them saying how many more the
 * log had (`more`: those already left out while reading).
 */
function capEvents(events: FlightEventDto[], more: number, at: number): FlightEventDto[] {
  events.sort((a, b) => a.t - b.t);
  if (events.length + more <= MAX_LOG_EVENTS) return events;
  const kept = events.slice(0, MAX_LOG_EVENTS - 1);
  const left = events.length + more - kept.length;
  kept.push({ t: kept[kept.length - 1]?.t ?? at, level: 'info', code: 'log_truncated', message: `${left.toLocaleString('en')} more log messages were not imported` });
  return kept;
}

/** The topics a ULog's position is read from (every sample of them is kept). */
const POSITION_TOPICS = new Set(['vehicle_global_position', 'vehicle_gps_position', 'sensor_gps']);
/** The topics read from a ULog, and of each the fields used. */
const GPS_FIELDS = /^(lat|lon|alt|latitude_deg|longitude_deg|altitude_msl_m|vel_[ned]_m_s|satellites_used|hdop|eph|time_utc_usec)$/;
const ULOG_FIELDS: Record<string, RegExp> = {
  vehicle_global_position: /^(lat|lon|alt)$/,
  vehicle_gps_position: GPS_FIELDS,
  sensor_gps: GPS_FIELDS,
  vehicle_local_position: /^(vx|vy|vz)$/,
  vehicle_attitude: /^q\[[0-3]\]$/,
  battery_status: /^(voltage_v|voltage_filtered_v|current_a|current_filtered_a|remaining)$/,
  vehicle_status: /^(nav_state|arming_state)$/,
  vehicle_land_detected: /^landed$/,
  home_position: /^alt$/,
  vehicle_imu_status: /^accel_vibration_metric$/,
  actuator_outputs: /^output\[[0-7]\]$/,
  actuator_motors: /^control\[[0-7]\]$/,
};

/** PX4 nav_state → readable flight mode. */
const NAV_STATES: Record<number, string> = {
  0: 'MANUAL',
  1: 'ALTCTL',
  2: 'POSCTL',
  3: 'MISSION',
  4: 'HOLD',
  5: 'RTL',
  10: 'ACRO',
  12: 'DESCEND',
  14: 'OFFBOARD',
  15: 'STAB',
  17: 'TAKEOFF',
  18: 'LAND',
  19: 'FOLLOW',
  20: 'PRECLAND',
  21: 'ORBIT',
};

/** Value of `field` in `t` at time `us` (sample-and-hold). */
function sampler(t: ULogTopic | undefined, field: string): ((us: number) => number | null) | null {
  if (!t || !t.data[field]) return null;
  const ts = t.timestamps;
  const vals = t.data[field]!;
  let idx = 0;
  return (us: number) => {
    if (ts.length === 0) return null;
    while (idx + 1 < ts.length && ts[idx + 1]! <= us) idx++;
    while (idx > 0 && ts[idx]! > us) idx--;
    const v = vals[idx];
    return v === undefined || Number.isNaN(v) ? null : v;
  };
}

function quatToEuler(q0: number, q1: number, q2: number, q3: number): { roll: number; pitch: number; yaw: number } {
  const roll = Math.atan2(2 * (q0 * q1 + q2 * q3), 1 - 2 * (q1 * q1 + q2 * q2));
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (q0 * q2 - q3 * q1))));
  const yaw = Math.atan2(2 * (q0 * q3 + q1 * q2), 1 - 2 * (q2 * q2 + q3 * q3));
  const d = 180 / Math.PI;
  return { roll: roll * d, pitch: pitch * d, yaw: yaw * d };
}

function levelOf(syslog: number): FlightEventDto['level'] {
  if (syslog <= 2) return 'critical';
  if (syslog === 3) return 'error';
  if (syslog === 4) return 'warning';
  return 'info';
}

export function normalizeULog(file: ULogFile, fallbackStart: number): NormalizedLog {
  return runAtOnce(normalizeULogSteps(file, fallbackStart));
}

function* normalizeULogSteps(file: ULogFile, fallbackStart: number): Steps<NormalizedLog> {
  const gpos = topic(file, 'vehicle_global_position');
  const gps = topic(file, 'sensor_gps') ?? topic(file, 'vehicle_gps_position');
  const position = gpos && gpos.samples > 0 ? gpos : gps;
  if (!position || position.timestamps.length === 0) throw new LogFormatError('Log contains no position data (vehicle_global_position / sensor_gps)');

  // Absolute time: GNSS UTC time when available.
  let offsetUs = fallbackStart * 1000 - position.timestamps[0]!;
  let absoluteTime = false;
  const utc = gps?.data['time_utc_usec'];
  if (gps && utc) {
    const i = utc.findIndex((v) => v > 1e15);
    if (i >= 0) {
      offsetUs = utc[i]! - gps.timestamps[i]!;
      absoluteTime = true;
    }
  }
  const toMs = (us: number) => Math.round((us + offsetUs) / 1000);

  // Position accessors for the different PX4 generations.
  const isGlobal = position === gpos;
  const latF = isGlobal ? sampler(position, 'lat') : sampler(position, 'latitude_deg') ?? sampler(position, 'lat');
  const lonF = isGlobal ? sampler(position, 'lon') : sampler(position, 'longitude_deg') ?? sampler(position, 'lon');
  const altF = isGlobal ? sampler(position, 'alt') : sampler(position, 'altitude_msl_m') ?? sampler(position, 'alt');
  const scaleLatLon = !isGlobal && !position.data['latitude_deg'] ? 1e-7 : 1;
  const scaleAlt = !isGlobal && !position.data['altitude_msl_m'] ? 1e-3 : 1;

  const lpos = topic(file, 'vehicle_local_position');
  const vx = sampler(lpos, 'vx');
  const vy = sampler(lpos, 'vy');
  const vz = sampler(lpos, 'vz');
  const gvn = sampler(gps, 'vel_n_m_s');
  const gve = sampler(gps, 'vel_e_m_s');
  const gvd = sampler(gps, 'vel_d_m_s');
  const att = topic(file, 'vehicle_attitude');
  const q = [0, 1, 2, 3].map((i) => sampler(att, `q[${i}]`));
  const bat = topic(file, 'battery_status');
  const volt = sampler(bat, 'voltage_v') ?? sampler(bat, 'voltage_filtered_v');
  const curr = sampler(bat, 'current_a') ?? sampler(bat, 'current_filtered_a');
  const remaining = sampler(bat, 'remaining');
  const sats = sampler(gps, 'satellites_used');
  const hdop = sampler(gps, 'hdop') ?? sampler(gps, 'eph');
  const status = topic(file, 'vehicle_status');
  const navState = sampler(status, 'nav_state');
  const armingState = sampler(status, 'arming_state');
  const landed = sampler(topic(file, 'vehicle_land_detected'), 'landed');
  const vib = sampler(topic(file, 'vehicle_imu_status'), 'accel_vibration_metric');
  const motorsTopic = topic(file, 'actuator_motors');
  const outputsTopic = topic(file, 'actuator_outputs');
  const motorF = motorsTopic
    ? [0, 1, 2, 3, 4, 5, 6, 7].map((i) => sampler(motorsTopic, `control[${i}]`)).filter((f): f is (us: number) => number | null => f !== null)
    : outputsTopic
      ? [0, 1, 2, 3, 4, 5, 6, 7].map((i) => sampler(outputsTopic, `output[${i}]`)).filter((f): f is (us: number) => number | null => f !== null)
      : [];
  const motorScale = motorsTopic ? (v: number) => v : (v: number) => (v - 1000) / 1000;
  const home = topic(file, 'home_position');
  const homeAlt = home?.data['alt']?.find((v) => Number.isFinite(v)) ?? null;

  // Resample at ~2 Hz along the position topic.
  const samples: FlightSampleDto[] = [];
  let lastUs = -Infinity;
  let firstAlt: number | null = null;
  let count = 0;
  for (const us of position.timestamps) {
    if ((++count & 1023) === 0) yield;
    if (us - lastUs < 500_000) continue;
    lastUs = us;
    const lat = latF?.(us);
    const lon = lonF?.(us);
    const alt = altF?.(us);
    if (lat == null || lon == null || alt == null) continue;
    const latD = lat * scaleLatLon;
    const lonD = lon * scaleLatLon;
    const altM = alt * scaleAlt;
    if (Math.abs(latD) < 1e-9 && Math.abs(lonD) < 1e-9) continue; // no fix yet
    firstAlt ??= altM;
    const n = vx?.(us) ?? gvn?.(us) ?? 0;
    const e = vy?.(us) ?? gve?.(us) ?? 0;
    const d = vz?.(us) ?? gvd?.(us) ?? 0;
    const qs = q.map((f) => f?.(us) ?? null);
    const eul = qs.every((v) => v !== null) ? quatToEuler(qs[0]!, qs[1]!, qs[2]!, qs[3]!) : { roll: 0, pitch: 0, yaw: 0 };
    const nav = navState?.(us);
    const arming = armingState?.(us);
    const motors = motorF.map((f) => f(us)).filter((v): v is number => v !== null && Number.isFinite(v)).map(motorScale);
    const rem = remaining?.(us);
    if (samples.length >= MAX_LOG_SAMPLES) throw tooManySamples();
    samples.push({
      t: toMs(us),
      lat: latD,
      lon: lonD,
      altMsl: altM,
      altRel: altM - (homeAlt ?? firstAlt),
      groundSpeed: Math.hypot(n, e),
      climbRate: -d,
      heading: ((eul.yaw % 360) + 360) % 360,
      roll: eul.roll,
      pitch: eul.pitch,
      yaw: eul.yaw,
      batteryPct: rem == null ? 0 : rem <= 1 ? rem * 100 : rem,
      voltage: volt?.(us) ?? 0,
      current: curr?.(us) ?? 0,
      satellites: sats?.(us) ?? 0,
      hdop: hdop?.(us) ?? 0,
      mode: nav == null ? 'UNKNOWN' : (NAV_STATES[nav] ?? `NAV_${nav}`),
      armed: arming == null ? (landed?.(us) === 0) : arming === 2,
      vibration: vib?.(us) ?? null,
      ...(motors.length ? { motors } : {}),
    } as FlightSampleDto);
  }
  if (samples.length === 0) throw new LogFormatError('Log contains no valid position fix');
  const events: FlightEventDto[] = file.messages.map((m) => ({ t: toMs(m.t), level: levelOf(m.level), code: null, message: m.text.slice(0, 500) }));
  for (const d of file.dropouts) events.push({ t: toMs(d.t), level: 'warning', code: 'log_dropout', message: `Logging dropout ${d.durationMs} ms` });
  const sysName = file.info['sys_name'];
  const ver = file.info['ver_sw'] ?? file.info['ver_sw_release'];
  const hw = file.info['ver_hw'];
  return {
    kind: 'ulog',
    absoluteTime,
    startedAt: samples[0]!.t,
    endedAt: samples[samples.length - 1]!.t,
    samples,
    events: capEvents(events, file.droppedMessages, samples[0]!.t),
    vehicle: {
      model: typeof hw === 'string' ? hw : typeof sysName === 'string' ? sysName : undefined,
      firmware: typeof ver === 'string' ? ver.slice(0, 40) : typeof ver === 'number' ? String(ver) : undefined,
      serial: typeof file.info['sys_uuid'] === 'string' ? (file.info['sys_uuid'] as string) : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

type ValueKey = Exclude<keyof FlightSampleDto, 't' | 'motors'>;

const ALIASES: Record<ValueKey, string[]> = {
  lat: ['lat', 'latitude', 'gps_lat'],
  lon: ['lon', 'lng', 'long', 'longitude', 'gps_lon'],
  altMsl: ['alt_msl', 'altmsl', 'alt', 'altitude', 'altitude_msl', 'gps_alt'],
  altRel: ['alt_rel', 'altrel', 'relative_alt', 'height', 'agl', 'alt_agl', 'relative_altitude', 'altitude_rel', 'rel_alt', 'altitude_relative', 'altitude_agl', 'height_agl'],
  groundSpeed: ['ground_speed', 'groundspeed', 'speed', 'gs'],
  climbRate: ['climb_rate', 'climbrate', 'vertical_speed', 'vspeed', 'vz'],
  heading: ['heading', 'hdg', 'course'],
  roll: ['roll'],
  pitch: ['pitch'],
  yaw: ['yaw'],
  batteryPct: ['battery_pct', 'battery', 'battery_percent', 'battery_remaining', 'remaining'],
  voltage: ['voltage', 'battery_voltage', 'volt'],
  current: ['current', 'battery_current', 'amps'],
  satellites: ['satellites', 'sats', 'num_sats', 'satellites_used'],
  hdop: ['hdop', 'eph'],
  mode: ['mode', 'flight_mode'],
  armed: ['armed', 'is_armed'],
  vibration: ['vibration', 'vibe'],
};

/** Base names (after unit stripping) recognised as the time column. */
const TIME_NAMES = new Set([
  't',
  'time',
  'timestamp',
  'datetime',
  'date_time',
  'time_utc',
  'utc',
  'elapsed',
  'elapsed_time',
  'gps_time',
  'time_boot',
  'time_s',
  'time_sec',
  'time_ms',
  'timestamp_ms',
  'time_boot_ms',
  'time_us',
  'time_usec',
  'timestamp_us',
  'time_boot_us',
]);

type TimeUnit = 's' | 'ms' | 'us';

function unitFrom(u: string | undefined): TimeUnit | null {
  if (!u) return null;
  if (/^(ms|msec|millis|millisecond|milliseconds)$/.test(u)) return 'ms';
  if (/^(us|usec|µs|micros|microsecond|microseconds)$/.test(u)) return 'us';
  if (/^(s|sec|secs|second|seconds)$/.test(u)) return 's';
  return null;
}

interface CsvColumn {
  base: string;
  unit: TimeUnit | null;
}

/** Normalises a header: "Time (ms)" -> { base: 'time', unit: 'ms' }, "time_boot_ms" -> unit ms. */
export function parseCsvHeader(raw: string): CsvColumn {
  const lower = raw.toLowerCase().trim();
  const bracket = /[([]\s*([a-zµ]+)\s*[)\]]/.exec(lower);
  const base = lower
    .replace(/[([][^)\]]*[)\]]/g, '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const suffix = /_(ms|msec|millis|us|usec|micros|s|sec)$/.exec(base);
  return { base, unit: unitFrom(bracket?.[1]) ?? unitFrom(suffix?.[1]) };
}

type ParsedTime = { abs: number } | { rel: number };

/** Parses one time value. Relative values are returned in the given unit converted to ms (unit-less = seconds). */
export function parseCsvTime(v: string, unit: TimeUnit | null): ParsedTime | null {
  const text = v.trim();
  if (!text) return null;
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text)) {
    const n = Number(text);
    const ms = unit === 'us' ? n / 1000 : unit === 'ms' ? n : unit === 's' ? n * 1000 : null;
    if (ms !== null) return ms > 1e11 ? { abs: Math.round(ms) } : { rel: ms };
    // No unit: recognise epoch timestamps by magnitude, otherwise relative seconds.
    if (n > 1e14) return { abs: Math.round(n / 1000) };
    if (n > 1e11) return { abs: Math.round(n) };
    if (n > 1e8) return { abs: Math.round(n * 1000) };
    return { rel: n * 1000 };
  }
  const d = Date.parse(text);
  return Number.isNaN(d) ? null : { abs: d };
}

/** Minimum spacing between stored samples of high-rate CSV logs (5 Hz). */
const CSV_MIN_SPACING_MS = 200;
/** Minimum spacing between stored samples of JSON exports (10 Hz: the most a live flight records). */
const JSON_MIN_SPACING_MS = 100;

/** Most columns a CSV log may have. */
const CSV_COLUMNS_MAX = 2000;

/** The fields of a line – at most `limit` of them (the rest of a long line is not split). */
function splitCsvLine(line: string, limit = CSV_COLUMNS_MAX + 1): string[] {
  // Without quotes, the separators split the line as they are.
  if (!line.includes('"')) return line.split(/[,;\t]/, limit).map((s) => s.trim());
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === ';' || ch === '\t') {
      out.push(cur);
      cur = '';
      if (out.length >= limit) return out.map((s) => s.trim());
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Text decoded at a time (and the longest line a log may have). */
const TEXT_BLOCK = 1_048_576;

/** Where the text of a file starts (after a UTF-8 byte order mark). */
const textStart = (buf: Buffer): number => (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0);

/** The lines of a text file, decoded a block (about a megabyte, whole lines) at a time. */
class LineReader {
  private lines: string[] = [];
  private i = 0;
  private pos: number;

  constructor(private readonly buf: Buffer) {
    this.pos = textStart(buf);
  }

  /** The next line (without its line break), or null at the end. */
  next(): string | null {
    while (this.i >= this.lines.length) {
      const buf = this.buf;
      if (this.pos >= buf.length) return null;
      let end = Math.min(buf.length, this.pos + TEXT_BLOCK);
      if (end < buf.length) {
        const nl = buf.lastIndexOf(0x0a, end - 1);
        if (nl < this.pos) throw new LogFormatError('A line of the log is longer than a megabyte');
        end = nl + 1;
      }
      this.lines = buf.toString('utf8', this.pos, end).split('\n');
      this.pos = end;
      // A block ends after a line break: the empty piece after it is no line.
      if (end < buf.length || this.lines[this.lines.length - 1] === '') this.lines.pop();
      this.i = 0;
    }
    const line = this.lines[this.i++]!;
    return line.endsWith('\r') ? line.slice(0, -1) : line;
  }

  /** The next line that is neither blank nor a comment (#). */
  nextRow(): string | null {
    for (;;) {
      const line = this.next();
      if (line === null || (line.trim() && !line.startsWith('#'))) return line;
    }
  }
}

export function normalizeCsv(text: string | Buffer, fallbackStart: number): NormalizedLog {
  return runAtOnce(normalizeCsvSteps(typeof text === 'string' ? Buffer.from(text) : text, fallbackStart));
}

function* normalizeCsvSteps(buf: Buffer, fallbackStart: number): Steps<NormalizedLog> {
  // Rows are numbered among the lines that count (not blank, not comments); the header is row 1.
  const head = new LineReader(buf);
  const headerLine = head.nextRow();
  if (headerLine === null || head.nextRow() === null) throw new LogFormatError('CSV needs a header row and at least one data row');
  const names = splitCsvLine(headerLine);
  if (names.length > CSV_COLUMNS_MAX) throw new LogFormatError(`CSV has more than ${CSV_COLUMNS_MAX} columns`);
  const header = names.map(parseCsvHeader);
  const col = (key: ValueKey): number => header.findIndex((h) => ALIASES[key].includes(h.base));
  const idx = Object.fromEntries((Object.keys(ALIASES) as ValueKey[]).map((k) => [k, col(k)])) as Record<ValueKey, number>;
  const timeIdx = header.findIndex((h) => TIME_NAMES.has(h.base));
  const timeUnit = timeIdx >= 0 ? header[timeIdx]!.unit : null;
  if (idx.lat < 0 || idx.lon < 0) throw new LogFormatError('CSV must contain latitude and longitude columns');
  // Rows are split as far as the last column read.
  const used = Math.max(timeIdx, ...Object.values(idx)) + 1;
  const events: FlightEventDto[] = [];
  const timeOf = (fields: string[], row: number): ParsedTime | null => {
    if (timeIdx < 0) return null;
    const time = parseCsvTime(fields[timeIdx] ?? '', timeUnit);
    if (!time) throw new LogFormatError(`Row ${row}: cannot parse time value "${(fields[timeIdx] ?? '').slice(0, 40)}"`);
    return time;
  };

  // Unit-less relative times with implausibly large steps (> 10 s median) are milliseconds. A
  // first pass over the times decides: the median of the positive steps is above 10 s when no
  // more than half of them are 10 s or less. (Times are parsed strictly: a present time column
  // must parse on every row.)
  let relScale = 1;
  if (timeIdx >= 0 && timeUnit === null) {
    const r = new LineReader(buf);
    r.nextRow();
    let row = 1;
    let prev: number | null = null;
    let steps = 0;
    let small = 0;
    for (let line = r.nextRow(); line !== null; line = r.nextRow()) {
      ++row;
      // A row at a time (rows can be long): the slices stay short.
      yield;
      const time = timeOf(splitCsvLine(line, timeIdx + 1), row)!;
      if (!('rel' in time)) continue;
      if (prev !== null && time.rel - prev > 0) {
        steps++;
        if (time.rel - prev <= 10_000) small++;
      }
      prev = time.rel;
    }
    if (steps > 0 && Math.floor(steps / 2) >= small) {
      relScale = 1 / 1000;
      events.push({ t: fallbackStart, level: 'info', code: 'csv_time_unit', message: 'Time column without unit interpreted as milliseconds' });
    }
  }
  if (timeIdx < 0) events.push({ t: fallbackStart, level: 'info', code: 'csv_no_time', message: 'No time column: one sample per second assumed' });

  // High-rate logs are down-sampled for storage and analytics (the last sample is always kept).
  const thin = new Thinner(CSV_MIN_SPACING_MS);
  const r = new LineReader(buf);
  r.nextRow();
  let row = 1;
  let firstAlt: number | null = null;
  let relativeRows = 0;
  let valid = 0;
  for (let line = r.nextRow(); line !== null; line = r.nextRow()) {
    ++row;
    yield;
    const f = splitCsvLine(line, used);
    const time = timeOf(f, row);
    const num = (k: ValueKey, dflt = 0): number => {
      const i = idx[k];
      if (i < 0) return dflt;
      const n = Number(f[i]);
      return Number.isFinite(n) ? n : dflt;
    };
    const lat = num('lat', NaN);
    const lon = num('lon', NaN);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const t = time ? ('abs' in time ? time.abs : Math.round(fallbackStart + time.rel * relScale)) : fallbackStart + (row - 2) * 1000;
    if (!time || !('abs' in time)) relativeRows++;
    const altMsl = num('altMsl', 0);
    firstAlt ??= altMsl;
    const battery = num('batteryPct', 0);
    const armedRaw = idx.armed >= 0 ? (f[idx.armed] ?? '').toLowerCase() : '1';
    valid++;
    thin.push({
      t,
      lat,
      lon,
      altMsl,
      altRel: idx.altRel >= 0 ? num('altRel') : altMsl - firstAlt,
      groundSpeed: num('groundSpeed'),
      climbRate: num('climbRate'),
      heading: num('heading'),
      roll: num('roll'),
      pitch: num('pitch'),
      yaw: num('yaw'),
      batteryPct: battery <= 1 && battery > 0 && idx.batteryPct >= 0 && header[idx.batteryPct]!.base === 'remaining' ? battery * 100 : battery,
      voltage: num('voltage'),
      current: num('current'),
      satellites: num('satellites'),
      hdop: num('hdop'),
      mode: idx.mode >= 0 ? (f[idx.mode] ?? 'UNKNOWN').slice(0, 32) || 'UNKNOWN' : 'UNKNOWN',
      armed: !['0', 'false', 'no', 'disarmed'].includes(armedRaw),
      vibration: idx.vibration >= 0 ? num('vibration') : null,
    });
  }
  if (valid === 0) throw new LogFormatError('CSV contains no valid rows');
  const kept = yield* thin.finish();
  return { kind: 'csv', startedAt: kept[0]!.t, endedAt: kept[kept.length - 1]!.t, absoluteTime: relativeRows === 0, samples: kept, events, vehicle: {} };
}

// ---------------------------------------------------------------------------
// Athena JSON export (round trip)
// ---------------------------------------------------------------------------

/** Largest single value of a JSON export (a sample, an event, the flight's details). */
const JSON_VALUE_MAX = 1_048_576;

class JsonError extends Error {}

const isJsonSpace = (b: number | undefined) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;

/**
 * A JSON document read from its bytes in slices: the members of the top-level object one at a
 * time, and the elements of its arrays one at a time, each handed to `element` (not kept).
 * Every other value is parsed whole with JSON.parse and no value may exceed `JSON_VALUE_MAX`.
 */
function* readJsonObjectSteps(buf: Buffer, element: (key: string, value: unknown) => void): Steps<Record<string, unknown>> {
  let pos = textStart(buf);
  const ws = () => {
    while (isJsonSpace(buf[pos])) pos++;
  };
  const expect = (b: number) => {
    ws();
    if (buf[pos] !== b) throw new JsonError();
    pos++;
  };
  /** The index after the string starting at `at`. */
  const stringEnd = (at: number, max: number): number => {
    for (let i = at + 1; i < buf.length; i++) {
      if (i > max) throw new LogFormatError('A value of the export is larger than a megabyte');
      const b = buf[i];
      if (b === 0x5c) i++;
      else if (b === 0x22) return i + 1;
    }
    throw new JsonError();
  };
  /** Parses the value at `pos` (no larger than `JSON_VALUE_MAX`) and moves past it. */
  const value = (): unknown => {
    ws();
    const at = pos;
    const max = at + JSON_VALUE_MAX;
    const b = buf[at];
    let end: number;
    if (b === 0x22) end = stringEnd(at, max);
    else if (b === 0x7b || b === 0x5b) {
      let depth = 0;
      let i = at;
      for (; i < buf.length; i++) {
        if (i > max) throw new LogFormatError('A value of the export is larger than a megabyte');
        const c = buf[i];
        if (c === 0x22) i = stringEnd(i, max) - 1;
        else if (c === 0x7b || c === 0x5b) depth++;
        else if (c === 0x7d || c === 0x5d) {
          if (--depth === 0) break;
        }
      }
      if (i >= buf.length) throw new JsonError();
      end = i + 1;
    } else {
      let i = at;
      while (i < buf.length && !isJsonSpace(buf[i]) && buf[i] !== 0x2c && buf[i] !== 0x5d && buf[i] !== 0x7d) {
        if (i > max) throw new LogFormatError('A value of the export is larger than a megabyte');
        i++;
      }
      end = i;
    }
    pos = end;
    try {
      return JSON.parse(buf.toString('utf8', at, end));
    } catch {
      throw new JsonError();
    }
  };

  const doc: Record<string, unknown> = {};
  expect(0x7b);
  ws();
  if (buf[pos] === 0x7d) pos++;
  else {
    let n = 0;
    for (;;) {
      ws();
      if (buf[pos] !== 0x22) throw new JsonError();
      const key = value();
      if (typeof key !== 'string') throw new JsonError();
      expect(0x3a);
      ws();
      if (buf[pos] === 0x5b) {
        pos++;
        ws();
        if (buf[pos] === 0x5d) pos++;
        else {
          for (;;) {
            // An element at a time (one can be up to a megabyte): the slices stay short.
            yield;
            element(key, value());
            ws();
            if (buf[pos] === 0x2c) pos++;
            else if (buf[pos] === 0x5d) {
              pos++;
              break;
            } else throw new JsonError();
          }
        }
        // As JSON.parse would: the member is there, as an array (its elements were handed over).
        Object.defineProperty(doc, key, { value: [], enumerable: true, writable: true, configurable: true });
      } else Object.defineProperty(doc, key, { value: value(), enumerable: true, writable: true, configurable: true });
      ws();
      if (buf[pos] === 0x2c) pos++;
      else if (buf[pos] === 0x7d) {
        pos++;
        break;
      } else throw new JsonError();
    }
  }
  ws();
  if (pos !== buf.length) throw new JsonError();
  return doc;
}

const LEVELS = new Set<FlightEventDto['level']>(['info', 'warning', 'error', 'critical']);
const finiteOr = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);

/** A sample of an export, with the fields and types the server stores (null without time or position). */
function exportedSample(x: any): FlightSampleDto | null {
  if (!x || typeof x !== 'object' || !Number.isFinite(x.t) || !Number.isFinite(x.lat) || !Number.isFinite(x.lon)) return null;
  return {
    t: x.t,
    lat: x.lat,
    lon: x.lon,
    altMsl: finiteOr(x.altMsl, 0),
    altRel: finiteOr(x.altRel, 0),
    groundSpeed: finiteOr(x.groundSpeed, 0),
    climbRate: finiteOr(x.climbRate, 0),
    heading: finiteOr(x.heading, 0),
    roll: finiteOr(x.roll, 0),
    pitch: finiteOr(x.pitch, 0),
    yaw: finiteOr(x.yaw, 0),
    batteryPct: finiteOr(x.batteryPct, 0),
    voltage: finiteOr(x.voltage, 0),
    current: finiteOr(x.current, 0),
    satellites: finiteOr(x.satellites, 0),
    hdop: finiteOr(x.hdop, 0),
    mode: typeof x.mode === 'string' && x.mode ? x.mode.slice(0, 32) : 'UNKNOWN',
    armed: x.armed === true || x.armed === 1,
    vibration: typeof x.vibration === 'number' && Number.isFinite(x.vibration) ? x.vibration : null,
    ...(Array.isArray(x.motors) ? { motors: x.motors.slice(0, 16).map((m: unknown) => finiteOr(m, 0)) } : {}),
  };
}

export function normalizeJson(text: string | Buffer): NormalizedLog {
  return runAtOnce(normalizeJsonSteps(typeof text === 'string' ? Buffer.from(text) : text));
}

function* normalizeJsonSteps(buf: Buffer): Steps<NormalizedLog> {
  const thin = new Thinner(JSON_MIN_SPACING_MS);
  let valid = 0;
  const events: FlightEventDto[] = [];
  let moreEvents = 0;
  let doc: Record<string, unknown>;
  try {
    doc = yield* readJsonObjectSteps(buf, (key, v) => {
      if (key === 'samples') {
        const s = exportedSample(v);
        if (s) {
          valid++;
          thin.push(s);
        }
      } else if (key === 'events') {
        const e = v as any;
        if (!e || typeof e !== 'object' || !Number.isFinite(e.t) || typeof e.message !== 'string') return;
        if (events.length >= MAX_LOG_EVENTS) moreEvents++;
        else events.push({ t: e.t, level: LEVELS.has(e.level) ? e.level : 'info', code: typeof e.code === 'string' ? e.code.slice(0, 64) : null, message: e.message.slice(0, 500) });
      }
    });
  } catch (err) {
    if (!(err instanceof JsonError)) throw err;
    // Not an object: other JSON (a small file) is no export; anything else is no JSON.
    let other = false;
    if (buf.length <= JSON_VALUE_MAX) {
      try {
        JSON.parse(buf.toString('utf8', textStart(buf)));
        other = true;
      } catch {
        other = false;
      }
    }
    throw new LogFormatError(other ? 'Not an Athena-sky flight export' : 'Invalid JSON');
  }
  if (doc.format !== 'athena-sky-flight' || !Array.isArray(doc.samples)) throw new LogFormatError('Not an Athena-sky flight export');
  if (valid === 0) throw new LogFormatError('Export contains no samples');
  const samples = yield* thin.finish();
  return {
    kind: 'json',
    startedAt: samples[0]!.t,
    endedAt: samples[samples.length - 1]!.t,
    absoluteTime: true,
    samples,
    events: capEvents(events, moreEvents, samples[0]!.t),
    vehicle: {},
  };
}

/**
 * Detects the format of an uploaded log and normalises it. A log without a time base of its own
 * is dated to end when it was received (`receivedAt`) – it was flown before that.
 */
export function normalizeLog(buf: Buffer, filename: string, receivedAt = Date.now()): NormalizedLog {
  return runAtOnce(normalizeLogSteps(buf, filename, receivedAt));
}

/** `normalizeLog` in steps (see `runSliced`): long logs are read without stalling the server. */
export function* normalizeLogSteps(buf: Buffer, filename: string, receivedAt = Date.now()): Steps<NormalizedLog> {
  const log = yield* detectLogSteps(buf, filename, receivedAt);
  // The samples and events are new objects of the reader: moved in place.
  const ms = log.absoluteTime ? 0 : receivedAt - log.endedAt;
  if (ms) {
    log.startedAt += ms;
    log.endedAt += ms;
    for (let i = 0; i < log.samples.length; i++) {
      if ((i & 8191) === 8191) yield;
      log.samples[i]!.t += ms;
    }
    for (const e of log.events) e.t += ms;
  }
  return log;
}

function* detectLogSteps(buf: Buffer, filename: string, start: number): Steps<NormalizedLog> {
  if (isULog(buf)) {
    const file = yield* parseULogSteps(buf, {
      include: (n) => n in ULOG_FIELDS,
      fields: (n, field) => ULOG_FIELDS[n]!.test(field),
      maxMessages: MAX_LOG_EVENTS,
      // Samples are stored at 2 Hz along the position: the other topics are read at up to 20 Hz.
      minIntervalUs: (n) => (POSITION_TOPICS.has(n) ? 0 : 50_000),
    });
    return yield* normalizeULogSteps(file, start);
  }
  let first = textStart(buf);
  while (first < buf.length && (isJsonSpace(buf[first]) || buf[first] === 0x0b || buf[first] === 0x0c)) first++;
  if (/\.json$/i.test(filename) || buf[first] === 0x7b) return yield* normalizeJsonSteps(buf);
  if (/\.(csv|txt)$/i.test(filename) || buf.includes(0x2c)) return yield* normalizeCsvSteps(buf, start);
  throw new LogFormatError('Unsupported log format (expected .ulg, .csv or Athena JSON export)');
}

export interface FlightTotals {
  durationS: number;
  distanceM: number;
  maxAltM: number;
  maxSpeedMs: number;
  batteryStart: number | null;
  batteryEnd: number | null;
}

/** Statistics over samples (airborne portion when arm state is known). */
export function computeTotals(samples: FlightSampleDto[]): FlightTotals {
  return runAtOnce(computeTotalsSteps(samples));
}

export function* computeTotalsSteps(samples: FlightSampleDto[]): Steps<FlightTotals> {
  const armedOnly = samples.some((x) => x.armed);
  let dist = 0;
  let first: FlightSampleDto | null = null;
  let prev: FlightSampleDto | null = null;
  let maxAlt = 0;
  let maxSpeed = 0;
  let batteryStart: number | null = null;
  let batteryEnd: number | null = null;
  for (let i = 0; i < samples.length; i++) {
    if ((i & 2047) === 2047) yield;
    const x = samples[i]!;
    if (armedOnly && !x.armed) continue;
    if (prev) {
      const d = haversineDistance(prev, x);
      if (d < 500) dist += d;
    }
    first ??= x;
    prev = x;
    maxAlt = Math.max(maxAlt, x.altRel);
    maxSpeed = Math.max(maxSpeed, x.groundSpeed);
    if (x.batteryPct > 0) {
      batteryStart ??= x.batteryPct;
      batteryEnd = x.batteryPct;
    }
  }
  return {
    durationS: first && prev ? (prev.t - first.t) / 1000 : 0,
    distanceM: dist,
    maxAltM: maxAlt,
    maxSpeedMs: maxSpeed,
    batteryStart,
    batteryEnd,
  };
}
