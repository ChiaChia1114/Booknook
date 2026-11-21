/**
 * PX4 ULog (.ulg) parser.
 *
 * Implements the ULog file format (header, definitions and data sections:
 * B/F/I/M/P/Q/A/R/D/L/C/S/O messages). Data for topics is decoded lazily: only
 * topics selected through `include` are materialised, so a log can be listed
 * cheaply and individual fields extracted for plotting.
 */

const MAGIC = [0x55, 0x4c, 0x6f, 0x67, 0x01, 0x12, 0x35];

const TYPE_SIZES: Record<string, number> = {
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

interface FieldDef {
  type: string;
  arrayLen: number | null;
  name: string;
}

interface Leaf {
  name: string;
  type: string;
  offset: number;
}

interface Format {
  name: string;
  fields: FieldDef[];
}

export interface ULogTopic {
  name: string;
  multiId: number;
  /** Numeric leaf field names (nested structs flattened with '.', arrays as name[i]). */
  fields: string[];
  /** Microsecond timestamps (boot time) of each sample. */
  timestamps: number[];
  /** Field values, only present for included topics. */
  data: Record<string, number[]>;
  samples: number;
}

export interface ULogMessage {
  /** Microseconds since boot. */
  t: number;
  /** 0 (emergency) … 7 (debug), syslog style. */
  level: number;
  text: string;
}

export interface ULogFile {
  version: number;
  headerTimestamp: number;
  info: Record<string, string | number>;
  params: Record<string, number>;
  topics: ULogTopic[];
  messages: ULogMessage[];
  dropouts: { t: number; durationMs: number }[];
}

export interface ParseOptions {
  /** Returns true for topics whose data should be decoded. Default: none. */
  include?: (topicName: string) => boolean;
  /** Maximum number of samples kept per included topic (evenly decimated). */
  maxSamplesPerTopic?: number;
}

export class ULogError extends Error {}

function parseFormat(text: string): Format {
  const colon = text.indexOf(':');
  if (colon < 0) throw new ULogError(`invalid format definition: ${text.slice(0, 40)}`);
  const name = text.slice(0, colon);
  const fields: FieldDef[] = [];
  for (const part of text.slice(colon + 1).split(';')) {
    const f = part.trim();
    if (!f) continue;
    const sp = f.lastIndexOf(' ');
    if (sp < 0) throw new ULogError(`invalid field: ${f}`);
    const typeStr = f.slice(0, sp).trim();
    const fieldName = f.slice(sp + 1).trim();
    const m = /^(.+?)\[(\d+)\]$/.exec(typeStr);
    fields.push({ type: m ? m[1]! : typeStr, arrayLen: m ? Number(m[2]) : null, name: fieldName });
  }
  return { name, fields };
}

/** Limits that keep hostile logs from exhausting memory or CPU (PX4 topics have < 300 fields). */
export const ULOG_LIMITS = {
  maxFormats: 4096,
  maxLeavesPerTopic: 8192,
  maxTotalLeaves: 250_000,
  maxNesting: 16,
};

/**
 * Memoised type information (size and number of numeric leaves) for the formats of one file.
 * Without memoisation, nested struct definitions expand combinatorially.
 */
class TypeTable {
  private readonly sizes = new Map<string, number>();
  private readonly leaves = new Map<string, number>();

  constructor(private readonly formats: Map<string, Format>) {}

  private format(type: string): Format {
    const f = this.formats.get(type);
    if (!f) throw new ULogError(`unknown type ${type}`);
    return f;
  }

  size(type: string, stack: string[] = []): number {
    const base = TYPE_SIZES[type];
    if (base !== undefined) return base;
    const cached = this.sizes.get(type);
    if (cached !== undefined) return cached;
    if (stack.includes(type) || stack.length > ULOG_LIMITS.maxNesting) throw new ULogError(`recursive or too deeply nested type ${type}`);
    const f = this.format(type);
    let total = 0;
    for (const fd of f.fields) total += this.size(fd.type, [...stack, type]) * (fd.arrayLen ?? 1);
    if (!Number.isSafeInteger(total) || total > 0xffff) throw new ULogError(`type ${type} is too large`);
    this.sizes.set(type, total);
    return total;
  }

  /** Number of numeric leaves the type flattens into (char and padding fields excluded). */
  leafCount(type: string, stack: string[] = []): number {
    if (TYPE_SIZES[type] !== undefined) return type === 'char' ? 0 : 1;
    const cached = this.leaves.get(type);
    if (cached !== undefined) return cached;
    if (stack.includes(type) || stack.length > ULOG_LIMITS.maxNesting) throw new ULogError(`recursive or too deeply nested type ${type}`);
    const f = this.format(type);
    let total = 0;
    for (const fd of f.fields) {
      if (fd.name.startsWith('_padding')) continue;
      total += this.leafCount(fd.type, [...stack, type]) * (fd.arrayLen ?? 1);
      if (total > ULOG_LIMITS.maxLeavesPerTopic) throw new ULogError(`format ${type} has too many fields`);
    }
    this.leaves.set(type, total);
    return total;
  }

  flatten(format: Format, prefix = '', base = 0, out: Leaf[] = []): Leaf[] {
    let offset = base;
    for (const fd of format.fields) {
      const size = this.size(fd.type);
      const count = fd.arrayLen ?? 1;
      const skip = fd.name.startsWith('_padding') || fd.type === 'char';
      for (let i = 0; i < count; i++) {
        const name = `${prefix}${fd.name}${fd.arrayLen !== null ? `[${i}]` : ''}`;
        if (!skip) {
          if (TYPE_SIZES[fd.type] !== undefined) out.push({ name, type: fd.type, offset });
          else this.flatten(this.format(fd.type), `${name}.`, offset, out);
        }
        offset += size;
      }
    }
    return out;
  }
}

function readValue(dv: DataView, type: string, off: number): number {
  switch (type) {
    case 'int8_t':
      return dv.getInt8(off);
    case 'uint8_t':
    case 'bool':
      return dv.getUint8(off);
    case 'int16_t':
      return dv.getInt16(off, true);
    case 'uint16_t':
      return dv.getUint16(off, true);
    case 'int32_t':
      return dv.getInt32(off, true);
    case 'uint32_t':
      return dv.getUint32(off, true);
    case 'float':
      return dv.getFloat32(off, true);
    case 'double':
      return dv.getFloat64(off, true);
    case 'int64_t':
      return Number(dv.getBigInt64(off, true));
    case 'uint64_t':
      return Number(dv.getBigUint64(off, true));
    default:
      return NaN;
  }
}

function decodeTypedValue(dv: DataView, typeStr: string, off: number, len: number): string | number {
  const m = /^(.+?)(?:\[(\d+)\])?$/.exec(typeStr.trim());
  const type = m?.[1] ?? typeStr;
  if (type === 'char') return new TextDecoder().decode(new Uint8Array(dv.buffer, dv.byteOffset + off, len)).replace(/\0+$/, '');
  if (TYPE_SIZES[type] !== undefined && len >= TYPE_SIZES[type]!) return readValue(dv, type, off);
  return NaN;
}

interface Subscription {
  topic: ULogTopic;
  leaves: Leaf[];
  timestampLeaf: Leaf | null;
  include: boolean;
  /** Raw sample count, used for decimation. */
  seen: number;
}

export function isULog(buf: Uint8Array): boolean {
  return buf.length >= 16 && MAGIC.every((b, i) => buf[i] === b);
}

export function parseULog(buf: Uint8Array, opts: ParseOptions = {}): ULogFile {
  if (!isULog(buf)) throw new ULogError('not a ULog file (bad magic)');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const td = new TextDecoder();
  const version = buf[7]!;
  const headerTimestamp = Number(dv.getBigUint64(8, true));
  const formats = new Map<string, Format>();
  const types = new TypeTable(formats);
  let totalLeaves = 0;
  const subs = new Map<number, Subscription>();
  const topics: ULogTopic[] = [];
  const info: Record<string, string | number> = {};
  const params: Record<string, number> = {};
  const messages: ULogMessage[] = [];
  const dropouts: { t: number; durationMs: number }[] = [];
  const include = opts.include ?? (() => false);
  const maxSamples = opts.maxSamplesPerTopic ?? Infinity;
  let lastTimestamp = 0;

  const keyValue = (start: number, size: number, keyLenOffset: number): { key: string; type: string; value: string | number } | null => {
    const keyLen = buf[start + keyLenOffset]!;
    const keyStart = start + keyLenOffset + 1;
    if (keyStart + keyLen > start + size) return null;
    const keyText = td.decode(buf.subarray(keyStart, keyStart + keyLen));
    const sp = keyText.lastIndexOf(' ');
    if (sp < 0) return null;
    const type = keyText.slice(0, sp);
    const key = keyText.slice(sp + 1);
    const valueStart = keyStart + keyLen;
    const value = decodeTypedValue(dv, type, valueStart, start + size - valueStart);
    return { key, type, value };
  };

  let pos = 16;
  while (pos + 3 <= buf.length) {
    const size = dv.getUint16(pos, true);
    const type = String.fromCharCode(buf[pos + 2]!);
    const start = pos + 3;
    if (start + size > buf.length) break; // truncated final message
    switch (type) {
      case 'F': {
        const f = parseFormat(td.decode(buf.subarray(start, start + size)));
        if (!formats.has(f.name) && formats.size >= ULOG_LIMITS.maxFormats) throw new ULogError('too many format definitions');
        formats.set(f.name, f);
        break;
      }
      case 'I': {
        const kv = keyValue(start, size, 0);
        if (kv) info[kv.key] = kv.value;
        break;
      }
      case 'M': {
        const kv = keyValue(start, size, 1);
        if (kv && typeof kv.value === 'string') info[kv.key] = String(info[kv.key] ?? '') + kv.value;
        break;
      }
      case 'P': {
        const kv = keyValue(start, size, 0);
        if (kv && typeof kv.value === 'number') params[kv.key] = kv.value;
        break;
      }
      case 'A': {
        const multiId = buf[start]!;
        const msgId = dv.getUint16(start + 1, true);
        const name = td.decode(buf.subarray(start + 3, start + size)).replace(/\0+$/, '');
        const format = formats.get(name);
        if (!format) break;
        totalLeaves += types.leafCount(name);
        if (totalLeaves > ULOG_LIMITS.maxTotalLeaves) throw new ULogError('log subscribes to too many fields');
        const leaves = types.flatten(format);
        const topic: ULogTopic = { name, multiId, fields: leaves.map((l) => l.name), timestamps: [], data: {}, samples: 0 };
        const inc = include(name);
        if (inc) for (const l of leaves) topic.data[l.name] = [];
        topics.push(topic);
        subs.set(msgId, { topic, leaves, timestampLeaf: leaves.find((l) => l.name === 'timestamp') ?? null, include: inc, seen: 0 });
        break;
      }
      case 'R': {
        subs.delete(dv.getUint16(start, true));
        break;
      }
      case 'D': {
        const sub = subs.get(dv.getUint16(start, true));
        if (!sub) break;
        const dataStart = start + 2;
        const dataLen = size - 2;
        sub.topic.samples++;
        if (sub.timestampLeaf && sub.timestampLeaf.offset + 8 <= dataLen) {
          lastTimestamp = readValue(dv, 'uint64_t', dataStart + sub.timestampLeaf.offset);
        }
        if (!sub.include) break;
        sub.seen++;
        sub.topic.timestamps.push(lastTimestamp);
        for (const leaf of sub.leaves) {
          const sz = TYPE_SIZES[leaf.type]!;
          const arr = sub.topic.data[leaf.name]!;
          arr.push(leaf.offset + sz <= dataLen ? readValue(dv, leaf.type, dataStart + leaf.offset) : NaN);
        }
        break;
      }
      case 'L': {
        const lvl = buf[start]!;
        const t = Number(dv.getBigUint64(start + 1, true));
        messages.push({ t, level: lvl >= 48 ? lvl - 48 : lvl, text: td.decode(buf.subarray(start + 9, start + size)).replace(/\0+$/, '') });
        break;
      }
      case 'C': {
        const lvl = buf[start]!;
        const t = Number(dv.getBigUint64(start + 3, true));
        messages.push({ t, level: lvl >= 48 ? lvl - 48 : lvl, text: td.decode(buf.subarray(start + 11, start + size)).replace(/\0+$/, '') });
        break;
      }
      case 'O': {
        dropouts.push({ t: lastTimestamp, durationMs: dv.getUint16(start, true) });
        break;
      }
      default:
        // 'B' flag bits, 'Q' default params, 'S' sync and unknown types are skipped.
        break;
    }
    pos = start + size;
  }

  if (Number.isFinite(maxSamples)) {
    for (const t of topics) {
      if (t.timestamps.length <= maxSamples) continue;
      const step = t.timestamps.length / maxSamples;
      const pick = (arr: number[]) => Array.from({ length: maxSamples }, (_, i) => arr[Math.floor(i * step)]!);
      t.timestamps = pick(t.timestamps);
      for (const k of Object.keys(t.data)) t.data[k] = pick(t.data[k]!);
    }
  }
  return { version, headerTimestamp, info, params, topics, messages, dropouts };
}

/** Returns the first topic instance (lowest multi id) with the given name. */
export function topic(file: ULogFile, name: string): ULogTopic | undefined {
  return file.topics.filter((t) => t.name === name).sort((a, b) => a.multiId - b.multiId)[0];
}
