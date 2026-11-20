/**
 * Minimal PX4 ULog writer (file header, flag bits, formats, info, parameters,
 * subscriptions, data and logged strings). Used by the simulator to produce
 * on-board flight logs and by tests as a fixture generator.
 */

const MAGIC = Buffer.from([0x55, 0x4c, 0x6f, 0x67, 0x01, 0x12, 0x35]);
const SIZES: Record<string, number> = {
  int8_t: 1,
  uint8_t: 1,
  bool: 1,
  char: 1,
  int16_t: 2,
  uint16_t: 2,
  int32_t: 4,
  uint32_t: 4,
  float: 4,
  int64_t: 8,
  uint64_t: 8,
  double: 8,
};

interface Field {
  type: string;
  name: string;
  count: number;
  size: number;
}

interface Fmt {
  name: string;
  fields: Field[];
}

function writeScalar(dv: DataView, off: number, type: string, v: number): void {
  switch (type) {
    case 'int8_t':
      dv.setInt8(off, v);
      break;
    case 'uint8_t':
    case 'bool':
    case 'char':
      dv.setUint8(off, v);
      break;
    case 'int16_t':
      dv.setInt16(off, v, true);
      break;
    case 'uint16_t':
      dv.setUint16(off, v, true);
      break;
    case 'int32_t':
      dv.setInt32(off, v, true);
      break;
    case 'uint32_t':
      dv.setUint32(off, v, true);
      break;
    case 'float':
      dv.setFloat32(off, v, true);
      break;
    case 'double':
      dv.setFloat64(off, v, true);
      break;
    case 'int64_t':
      dv.setBigInt64(off, BigInt(Math.round(v)), true);
      break;
    case 'uint64_t':
      dv.setBigUint64(off, BigInt(Math.max(0, Math.round(v))), true);
      break;
    default:
      throw new Error(`unsupported type ${type}`);
  }
}

export type ULogValues = Record<string, number | number[] | Record<string, number>[]>;

export class ULogWriter {
  private readonly chunks: Buffer[] = [];
  private readonly formats = new Map<string, Fmt>();
  private readonly subs = new Map<string, number>();
  private nextMsgId = 0;

  constructor(headerTimestampUs = 0, opts: { flagBits?: boolean } = {}) {
    const header = Buffer.alloc(16);
    MAGIC.copy(header, 0);
    header[7] = 1;
    header.writeBigUInt64LE(BigInt(headerTimestampUs), 8);
    this.chunks.push(header);
    if (opts.flagBits !== false) {
      // 'B' flag bits: compat[8], incompat[8], appended_offsets[3] (all zero)
      this.message('B', Buffer.alloc(40));
    }
  }

  private message(type: string, payload: Buffer): void {
    if (payload.length > 0xffff) throw new Error('ULog message too large');
    const h = Buffer.alloc(3);
    h.writeUInt16LE(payload.length, 0);
    h[2] = type.charCodeAt(0);
    this.chunks.push(h, payload);
  }

  private typeSize(type: string): number {
    const s = SIZES[type];
    if (s !== undefined) return s;
    const f = this.formats.get(type);
    if (!f) throw new Error(`unknown type ${type}`);
    return f.fields.reduce((acc, fd) => acc + fd.size * fd.count, 0);
  }

  /** Registers a message format, e.g. "battery_status:uint64_t timestamp;float voltage_v". */
  format(def: string): this {
    const [name, body] = def.split(':') as [string, string];
    const fields: Field[] = body
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const sp = s.lastIndexOf(' ');
        const typeStr = s.slice(0, sp);
        const m = /^(.+?)\[(\d+)\]$/.exec(typeStr);
        const type = m ? m[1]! : typeStr;
        return { type, name: s.slice(sp + 1), count: m ? Number(m[2]) : 1, size: this.typeSize(type) };
      });
    this.formats.set(name, { name, fields });
    this.message('F', Buffer.from(def, 'utf8'));
    return this;
  }

  private keyValue(type: string, payloadPrefix: Buffer, key: string, valueType: string, value: string | number): void {
    let valueBuf: Buffer;
    let typeStr = valueType;
    if (typeof value === 'string') {
      valueBuf = Buffer.from(value, 'utf8');
      typeStr = `char[${valueBuf.length}]`;
    } else {
      valueBuf = Buffer.alloc(SIZES[valueType]!);
      writeScalar(new DataView(valueBuf.buffer, valueBuf.byteOffset, valueBuf.length), 0, valueType, value);
    }
    const keyBuf = Buffer.from(`${typeStr} ${key}`, 'utf8');
    this.message(type, Buffer.concat([payloadPrefix, Buffer.from([keyBuf.length]), keyBuf, valueBuf]));
  }

  info(key: string, value: string | number, valueType = 'int32_t'): this {
    this.keyValue('I', Buffer.alloc(0), key, valueType, value);
    return this;
  }

  param(name: string, value: number, valueType: 'float' | 'int32_t' = 'float'): this {
    this.keyValue('P', Buffer.alloc(0), name, valueType, value);
    return this;
  }

  /** Subscribes (adds a logged message) for a registered format; returns the msg id. */
  subscribe(name: string, multiId = 0): number {
    if (!this.formats.has(name)) throw new Error(`format ${name} not registered`);
    const id = this.nextMsgId++;
    const nameBuf = Buffer.from(name, 'utf8');
    const p = Buffer.alloc(3 + nameBuf.length);
    p[0] = multiId;
    p.writeUInt16LE(id, 1);
    nameBuf.copy(p, 3);
    this.message('A', p);
    this.subs.set(`${name}#${multiId}`, id);
    return id;
  }

  private encode(fmt: Fmt, values: Record<string, unknown>, dv: DataView, base: number): number {
    let off = base;
    for (const fd of fmt.fields) {
      const v = values[fd.name];
      for (let i = 0; i < fd.count; i++) {
        const item = Array.isArray(v) ? v[i] : v;
        if (SIZES[fd.type] !== undefined) {
          if (!fd.name.startsWith('_padding')) writeScalar(dv, off, fd.type, typeof item === 'number' ? item : 0);
        } else {
          this.encode(this.formats.get(fd.type)!, (item as Record<string, unknown>) ?? {}, dv, off);
        }
        off += fd.size;
      }
    }
    return off - base;
  }

  /** Writes a data message. Trailing padding is omitted, as PX4 does. */
  data(name: string, values: ULogValues, multiId = 0): this {
    const id = this.subs.get(`${name}#${multiId}`) ?? this.subscribe(name, multiId);
    const fmt = this.formats.get(name)!;
    let size = this.typeSize(name);
    const last = fmt.fields[fmt.fields.length - 1];
    if (last && last.name.startsWith('_padding')) size -= last.size * last.count;
    const buf = Buffer.alloc(2 + this.typeSize(name));
    buf.writeUInt16LE(id, 0);
    this.encode(fmt, values, new DataView(buf.buffer, buf.byteOffset, buf.length), 2);
    this.message('D', buf.subarray(0, 2 + size));
    return this;
  }

  /** Logged string; level is syslog style 0 (emergency) … 7 (debug). */
  log(level: number, timestampUs: number, text: string): this {
    const t = Buffer.from(text, 'utf8');
    const p = Buffer.alloc(9 + t.length);
    p[0] = 48 + level;
    p.writeBigUInt64LE(BigInt(Math.round(timestampUs)), 1);
    t.copy(p, 9);
    this.message('L', p);
    return this;
  }

  dropout(durationMs: number): this {
    const p = Buffer.alloc(2);
    p.writeUInt16LE(durationMs, 0);
    this.message('O', p);
    return this;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** PX4-style topic formats written by the simulator's on-board logger. */
export const SIM_FORMATS = [
  'vehicle_global_position:uint64_t timestamp;double lat;double lon;float alt;float eph;float epv;uint8_t[4] _padding0',
  'sensor_gps:uint64_t timestamp;uint64_t time_utc_usec;double latitude_deg;double longitude_deg;double altitude_msl_m;float vel_n_m_s;float vel_e_m_s;float vel_d_m_s;float hdop;uint8_t fix_type;uint8_t satellites_used;uint8_t[6] _padding0',
  'vehicle_local_position:uint64_t timestamp;float x;float y;float z;float vx;float vy;float vz',
  'vehicle_attitude:uint64_t timestamp;float[4] q',
  'battery_status:uint64_t timestamp;float voltage_v;float current_a;float remaining;uint8_t[4] _padding0',
  'vehicle_status:uint64_t timestamp;uint8_t arming_state;uint8_t nav_state;uint8_t[6] _padding0',
  'vehicle_land_detected:uint64_t timestamp;bool landed;uint8_t[7] _padding0',
  'vehicle_imu_status:uint64_t timestamp;float accel_vibration_metric;float gyro_vibration_metric',
  'actuator_motors:uint64_t timestamp;float[4] control',
  'home_position:uint64_t timestamp;double lat;double lon;float alt;uint8_t[4] _padding0',
];

export const NAV_STATE: Record<string, number> = { POSCTL: 2, MISSION: 3, HOLD: 4, GUIDED: 4, RTL: 5, TAKEOFF: 17, LAND: 18 };

export function eulerToQuat(rollDeg: number, pitchDeg: number, yawDeg: number): [number, number, number, number] {
  const r = (rollDeg * Math.PI) / 360;
  const p = (pitchDeg * Math.PI) / 360;
  const y = (yawDeg * Math.PI) / 360;
  const [cr, sr, cp, sp, cy, sy] = [Math.cos(r), Math.sin(r), Math.cos(p), Math.sin(p), Math.cos(y), Math.sin(y)];
  return [cr * cp * cy + sr * sp * sy, sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy];
}
