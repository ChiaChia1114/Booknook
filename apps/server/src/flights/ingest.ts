/**
 * Converts uploaded flight logs (PX4 ULog, CSV, Athena JSON export) into the
 * normalised sample/event representation used for storage and analytics.
 */
import type { FlightEventDto, FlightSampleDto } from '@athena-sky/shared';
import { haversineDistance } from '@athena-sky/shared';
import { isULog, parseULog, topic, type ULogFile, type ULogTopic } from './ulog';

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

const ULOG_TOPICS = new Set([
  'vehicle_global_position',
  'vehicle_gps_position',
  'sensor_gps',
  'vehicle_local_position',
  'vehicle_attitude',
  'battery_status',
  'vehicle_status',
  'vehicle_land_detected',
  'home_position',
  'vehicle_imu_status',
  'actuator_outputs',
  'actuator_motors',
]);

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
  for (const us of position.timestamps) {
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
  events.sort((a, b) => a.t - b.t);
  const sysName = file.info['sys_name'];
  const ver = file.info['ver_sw'] ?? file.info['ver_sw_release'];
  const hw = file.info['ver_hw'];
  return {
    kind: 'ulog',
    absoluteTime,
    startedAt: samples[0]!.t,
    endedAt: samples[samples.length - 1]!.t,
    samples,
    events,
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
  altRel: ['alt_rel', 'altrel', 'relative_alt', 'height', 'agl', 'alt_agl', 'relative_altitude'],
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

function splitCsvLine(line: string): string[] {
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
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function normalizeCsv(text: string, fallbackStart: number): NormalizedLog {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  if (lines.length < 2) throw new LogFormatError('CSV needs a header row and at least one data row');
  const header = splitCsvLine(lines[0]!).map(parseCsvHeader);
  const col = (key: ValueKey): number => header.findIndex((h) => ALIASES[key].includes(h.base));
  const idx = Object.fromEntries((Object.keys(ALIASES) as ValueKey[]).map((k) => [k, col(k)])) as Record<ValueKey, number>;
  const timeIdx = header.findIndex((h) => TIME_NAMES.has(h.base));
  const timeUnit = timeIdx >= 0 ? header[timeIdx]!.unit : null;
  if (idx.lat < 0 || idx.lon < 0) throw new LogFormatError('CSV must contain latitude and longitude columns');
  const events: FlightEventDto[] = [];

  // First pass: parse times (strictly – a present time column must parse on every row).
  const rows: { fields: string[]; time: ParsedTime | null; row: number }[] = [];
  for (let r = 1; r < lines.length; r++) {
    const fields = splitCsvLine(lines[r]!);
    let time: ParsedTime | null = null;
    if (timeIdx >= 0) {
      time = parseCsvTime(fields[timeIdx] ?? '', timeUnit);
      if (!time) throw new LogFormatError(`Row ${r + 1}: cannot parse time value "${(fields[timeIdx] ?? '').slice(0, 40)}"`);
    }
    rows.push({ fields, time, row: r + 1 });
  }
  // Unit-less relative times with implausibly large steps (> 10 s median) are milliseconds.
  let relScale = 1;
  if (timeIdx >= 0 && timeUnit === null) {
    const rel = rows.map((x) => (x.time && 'rel' in x.time ? x.time.rel : null)).filter((v): v is number => v !== null);
    const steps = rel.slice(1).map((v, i) => v - rel[i]!).filter((d) => d > 0).sort((a, b) => a - b);
    if (steps.length > 0 && steps[Math.floor(steps.length / 2)]! > 10_000) {
      relScale = 1 / 1000;
      events.push({ t: fallbackStart, level: 'info', code: 'csv_time_unit', message: 'Time column without unit interpreted as milliseconds' });
    }
  }
  if (timeIdx < 0) events.push({ t: fallbackStart, level: 'info', code: 'csv_no_time', message: 'No time column: one sample per second assumed' });

  const samples: FlightSampleDto[] = [];
  let firstAlt: number | null = null;
  let relativeRows = 0;
  for (const { fields: f, time, row } of rows) {
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
    samples.push({
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
  if (samples.length === 0) throw new LogFormatError('CSV contains no valid rows');
  samples.sort((a, b) => a.t - b.t);
  // Down-sample high-rate logs for storage and analytics (always keep the last sample).
  const kept: FlightSampleDto[] = [];
  for (const sm of samples) {
    const prev = kept[kept.length - 1];
    if (!prev || sm.t - prev.t >= CSV_MIN_SPACING_MS) kept.push(sm);
  }
  const lastSample = samples[samples.length - 1]!;
  if (kept[kept.length - 1] !== lastSample) kept.push(lastSample);
  return { kind: 'csv', startedAt: kept[0]!.t, endedAt: kept[kept.length - 1]!.t, absoluteTime: relativeRows === 0, samples: kept, events, vehicle: {} };
}

// ---------------------------------------------------------------------------
// Athena JSON export (round trip)
// ---------------------------------------------------------------------------

export function normalizeJson(text: string): NormalizedLog {
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new LogFormatError('Invalid JSON');
  }
  if (!doc || doc.format !== 'athena-sky-flight' || !Array.isArray(doc.samples)) throw new LogFormatError('Not an Athena-sky flight export');
  const samples = (doc.samples as FlightSampleDto[]).filter((s) => Number.isFinite(s?.t) && Number.isFinite(s?.lat) && Number.isFinite(s?.lon));
  if (samples.length === 0) throw new LogFormatError('Export contains no samples');
  samples.sort((a, b) => a.t - b.t);
  const events = Array.isArray(doc.events) ? (doc.events as FlightEventDto[]).filter((e) => Number.isFinite(e?.t) && typeof e?.message === 'string') : [];
  return { kind: 'json', startedAt: samples[0]!.t, endedAt: samples[samples.length - 1]!.t, absoluteTime: true, samples, events, vehicle: {} };
}

/** Detects the format of an uploaded log and normalises it. */
export function normalizeLog(buf: Buffer, filename: string, fallbackStart = Date.now()): NormalizedLog {
  if (isULog(buf)) return normalizeULog(parseULog(buf, { include: (n) => ULOG_TOPICS.has(n) }), fallbackStart);
  const text = buf.toString('utf8');
  if (/\.json$/i.test(filename) || text.trimStart().startsWith('{')) return normalizeJson(text);
  if (/\.(csv|txt)$/i.test(filename) || text.includes(',')) return normalizeCsv(text, fallbackStart);
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
  const s = samples.some((x) => x.armed) ? samples.filter((x) => x.armed) : samples;
  let dist = 0;
  for (let i = 1; i < s.length; i++) {
    const d = haversineDistance(s[i - 1]!, s[i]!);
    if (d < 500) dist += d;
  }
  const bats = s.map((x) => x.batteryPct).filter((b) => b > 0);
  return {
    durationS: s.length ? (s[s.length - 1]!.t - s[0]!.t) / 1000 : 0,
    distanceM: dist,
    maxAltM: s.reduce((m, x) => Math.max(m, x.altRel), 0),
    maxSpeedMs: s.reduce((m, x) => Math.max(m, x.groundSpeed), 0),
    batteryStart: bats.length ? bats[0]! : null,
    batteryEnd: bats.length ? bats[bats.length - 1]! : null,
  };
}
