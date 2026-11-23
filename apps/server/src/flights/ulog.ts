/**
 * PX4 ULog (.ulg) parser.
 *
 * Implements the ULog file format (header, definitions and data sections:
 * B/F/I/M/P/Q/A/R/D/L/C/S/O messages). Data for topics is decoded lazily: only
 * topics selected through `include` are materialised, so a log can be listed
 * cheaply and individual fields extracted for plotting.
 */
import { runAtOnce, type Steps } from '../lib/slice';

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
  /** Log messages and dropout notes beyond `maxMessages`, counted but not kept. */
  droppedMessages: number;
}

export interface ParseOptions {
  /** Returns true for topics whose data should be decoded. Default: none. */
  include?: (topicName: string) => boolean;
  /** Of the included topics, the fields decoded (default: all of them). */
  fields?: (topicName: string, field: string) => boolean;
  /** Maximum number of samples kept per included topic (evenly decimated). */
  maxSamplesPerTopic?: number;
  /** Most log messages (and dropout notes) kept; the others are counted. Default: all. */
  maxMessages?: number;
  /** Of an included topic, samples less than this after the last one kept are skipped (µs). */
  minIntervalUs?: (topicName: string) => number;
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
  /** Values decoded from one file (timestamps included): 480 MB of numbers. */
  maxValues: 60_000_000,
  /** Topic subscriptions of one file (a PX4 log has a few hundred). */
  maxSubscriptions: 10_000,
  /** Fields of all the format definitions of one file (a PX4 log has a few thousand). */
  maxFormatFields: 200_000,
  /** Information and parameter entries of one file, and the longest information value. */
  maxEntries: 20_000,
  maxInfoLength: 65_536,
  /** Log messages kept when the reader does not say (the others are counted). */
  defaultMaxMessages: 100_000,
};

/** Values gathered in chunks while a file is read (a long array is never copied as it grows), joined at the end. */
class Column {
  private full: number[][] = [];
  private cur: number[] = [];

  push(v: number): void {
    if (this.cur.length === 65_536) {
      this.full.push(this.cur);
      this.cur = [];
    }
    this.cur.push(v);
  }

  /** The values in one array, made a chunk at a time (see `runSliced`). */
  *toArraySteps(): Steps<number[]> {
    if (this.full.length === 0) return this.cur;
    const chunks = [...this.full, this.cur];
    const out = new Array<number>(chunks.reduce((n, c) => n + c.length, 0));
    let k = 0;
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i++) out[k++] = chunk[i]!;
      yield;
    }
    return out;
  }
}

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
  /** The leaves decoded (all, or those `fields` selects), and their values. */
  decode: Leaf[];
  columns: Column[];
  times: Column;
  /** Timestamp of the last sample kept, and the least time to the next (see `minIntervalUs`). */
  lastKept: number;
  minInterval: number;
  timestampLeaf: Leaf | null;
  include: boolean;
  /** Raw sample count, used for decimation. */
  seen: number;
}

export function isULog(buf: Uint8Array): boolean {
  return buf.length >= 16 && MAGIC.every((b, i) => buf[i] === b);
}

export function parseULog(buf: Uint8Array, opts: ParseOptions = {}): ULogFile {
  return runAtOnce(parseULogSteps(buf, opts));
}

/** `parseULog` in steps: yields every few thousand messages (see `runSliced`). */
export function* parseULogSteps(buf: Uint8Array, opts: ParseOptions = {}): Steps<ULogFile> {
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
  const maxMessages = opts.maxMessages ?? ULOG_LIMITS.defaultMaxMessages;
  let subscriptions = 0;
  let entries = 0;
  let lastYield = 0;
  let formatFields = 0;
  /** A new information or parameter entry (a file with countless keys is refused). */
  const entry = (has: boolean) => {
    if (!has && ++entries > ULOG_LIMITS.maxEntries) throw new ULogError('log has too many information or parameter entries');
  };
  const included: Subscription[] = [];
  let values = 0;
  let droppedMessages = 0;
  let lastTimestamp = 0;
  let count = 0;

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
    // Every few thousand messages, or 64 KB of them (a definition can be that long).
    if ((++count & 2047) === 0 || pos - lastYield >= 65_536) {
      lastYield = pos;
      yield;
    }
    const size = dv.getUint16(pos, true);
    const type = String.fromCharCode(buf[pos + 2]!);
    const start = pos + 3;
    if (start + size > buf.length) break; // truncated final message
    switch (type) {
      case 'F': {
        const f = parseFormat(td.decode(buf.subarray(start, start + size)));
        if (!formats.has(f.name) && formats.size >= ULOG_LIMITS.maxFormats) throw new ULogError('too many format definitions');
        formatFields += f.fields.length - (formats.get(f.name)?.fields.length ?? 0);
        if (formatFields > ULOG_LIMITS.maxFormatFields) throw new ULogError('log defines too many fields');
        formats.set(f.name, f);
        break;
      }
      case 'I': {
        const kv = keyValue(start, size, 0);
        if (kv) {
          entry(Object.hasOwn(info, kv.key));
          info[kv.key] = typeof kv.value === 'string' ? kv.value.slice(0, ULOG_LIMITS.maxInfoLength) : kv.value;
        }
        break;
      }
      case 'M': {
        const kv = keyValue(start, size, 1);
        if (kv && typeof kv.value === 'string') {
          entry(Object.hasOwn(info, kv.key));
          // Values in parts (multi information): kept up to a length.
          const before = String(info[kv.key] ?? '');
          if (before.length < ULOG_LIMITS.maxInfoLength) info[kv.key] = (before + kv.value).slice(0, ULOG_LIMITS.maxInfoLength);
        }
        break;
      }
      case 'P': {
        const kv = keyValue(start, size, 0);
        if (kv && typeof kv.value === 'number') {
          entry(Object.hasOwn(params, kv.key));
          params[kv.key] = kv.value;
        }
        break;
      }
      case 'A': {
        const multiId = buf[start]!;
        const msgId = dv.getUint16(start + 1, true);
        const name = td.decode(buf.subarray(start + 3, start + size)).replace(/\0+$/, '');
        const format = formats.get(name);
        if (!format) break;
        if (++subscriptions > ULOG_LIMITS.maxSubscriptions) throw new ULogError('log subscribes to too many topics');
        totalLeaves += types.leafCount(name);
        if (totalLeaves > ULOG_LIMITS.maxTotalLeaves) throw new ULogError('log subscribes to too many fields');
        const leaves = types.flatten(format);
        const topic: ULogTopic = { name, multiId, fields: leaves.map((l) => l.name), timestamps: [], data: {}, samples: 0 };
        const inc = include(name);
        const decode = inc ? leaves.filter((l) => opts.fields?.(name, l.name) ?? true) : [];
        topics.push(topic);
        const sub: Subscription = {
          topic,
          leaves,
          decode,
          columns: decode.map(() => new Column()),
          times: new Column(),
          lastKept: -Infinity,
          minInterval: inc ? (opts.minIntervalUs?.(name) ?? 0) : 0,
          timestampLeaf: leaves.find((l) => l.name === 'timestamp') ?? null,
          include: inc,
          seen: 0,
        };
        subs.set(msgId, sub);
        if (inc) included.push(sub);
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
        // Only what is asked for is kept (a topic none of whose fields are wanted: nothing).
        if (!sub.include || sub.decode.length === 0) break;
        const since = lastTimestamp - sub.lastKept;
        if (since >= 0 && since < sub.minInterval) break;
        sub.lastKept = lastTimestamp;
        sub.seen++;
        values += 1 + sub.decode.length;
        if (values > ULOG_LIMITS.maxValues) throw new ULogError('log holds too many values to decode');
        sub.times.push(lastTimestamp);
        for (let k = 0; k < sub.decode.length; k++) {
          const leaf = sub.decode[k]!;
          const sz = TYPE_SIZES[leaf.type]!;
          sub.columns[k]!.push(leaf.offset + sz <= dataLen ? readValue(dv, leaf.type, dataStart + leaf.offset) : NaN);
        }
        break;
      }
      case 'L': {
        if (messages.length >= maxMessages) {
          droppedMessages++;
          break;
        }
        const lvl = buf[start]!;
        const t = Number(dv.getBigUint64(start + 1, true));
        messages.push({ t, level: lvl >= 48 ? lvl - 48 : lvl, text: td.decode(buf.subarray(start + 9, start + size)).replace(/\0+$/, '') });
        break;
      }
      case 'C': {
        if (messages.length >= maxMessages) {
          droppedMessages++;
          break;
        }
        const lvl = buf[start]!;
        const t = Number(dv.getBigUint64(start + 3, true));
        messages.push({ t, level: lvl >= 48 ? lvl - 48 : lvl, text: td.decode(buf.subarray(start + 11, start + size)).replace(/\0+$/, '') });
        break;
      }
      case 'O': {
        if (dropouts.length >= maxMessages) {
          droppedMessages++;
          break;
        }
        dropouts.push({ t: lastTimestamp, durationMs: dv.getUint16(start, true) });
        break;
      }
      default:
        // 'B' flag bits, 'Q' default params, 'S' sync and unknown types are skipped.
        break;
    }
    pos = start + size;
  }

  for (const sub of included) {
    yield;
    sub.topic.timestamps = yield* sub.times.toArraySteps();
    for (let k = 0; k < sub.decode.length; k++) {
      yield;
      sub.topic.data[sub.decode[k]!.name] = yield* sub.columns[k]!.toArraySteps();
    }
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
  return { version, headerTimestamp, info, params, topics, messages, dropouts, droppedMessages };
}

/** Returns the first topic instance (lowest multi id) with the given name. */
export function topic(file: ULogFile, name: string): ULogTopic | undefined {
  return file.topics.filter((t) => t.name === name).sort((a, b) => a.multiId - b.multiId)[0];
}
