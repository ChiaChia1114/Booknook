/**
 * Long JSON answers written a few hundred array items at a time, each part in a turn of its own
 * (see `runSliced`): a long answer – a flight's samples, a heatmap, a report – is neither written
 * in one go nor joined into one string while the live connections wait.
 */
import { Readable } from 'node:stream';
import type { FastifyReply } from 'fastify';
import { SLICE_MS, runSliced, type Steps } from './slice';
import { ownerOfWork, turns } from './turns';

/** Array items written per part – fewer once a part is this long (characters): large items (a mission's plan) one or a few at a time. */
const ITEMS_PER_PART = 256;
const PART_CHARS = 65_536;
/** Answers up to this size (bytes) are sent as one string (with their length). */
const JOINED_BYTES = 262_144;

/**
 * The JSON text of `value` in parts – as `JSON.stringify(value)` would write it, the items of its
 * arrays (the value's own, or its top-level properties') a few hundred at a time.
 */
export function* jsonPartsSteps(value: unknown): Steps<string[]> {
  const parts: string[] = [];
  function* array(items: readonly unknown[]): Steps<void> {
    parts.push('[');
    let chunk: string[] = [];
    let chars = 0;
    for (let i = 0; i < items.length; i++) {
      const text = JSON.stringify(items[i]) ?? 'null';
      chunk.push(text);
      chars += text.length;
      if (chunk.length >= ITEMS_PER_PART || chars >= PART_CHARS) {
        parts.push((i + 1 > chunk.length ? ',' : '') + chunk.join(','));
        chunk = [];
        chars = 0;
        yield;
      }
    }
    if (chunk.length) parts.push((items.length > chunk.length ? ',' : '') + chunk.join(','));
    parts.push(']');
  }
  const plain = value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON !== 'function';
  if (Array.isArray(value)) yield* array(value);
  else if (plain) {
    parts.push('{');
    let first = true;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
      parts.push(`${first ? '' : ','}${JSON.stringify(k)}:`);
      first = false;
      if (Array.isArray(v) && v.length > 1) yield* array(v);
      else parts.push(JSON.stringify(v));
    }
    parts.push('}');
  } else parts.push(JSON.stringify(value) ?? 'null');
  return parts;
}

/** Lists longer than this (items) are written in parts – a value's own, or one of its properties'. */
const LONG_LIST = 64;

/** Whether `value` has a list long enough to be written in parts (see `jsonPartsSteps`). */
export function hasLongList(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > LONG_LIST;
  if (value === null || typeof value !== 'object' || Buffer.isBuffer(value) || typeof (value as { pipe?: unknown }).pipe === 'function') return false;
  for (const v of Object.values(value as Record<string, unknown>)) if (Array.isArray(v) && v.length > LONG_LIST) return true;
  return false;
}

/**
 * The parts as an answer's body: one string when short, else a stream of them – not joined in one
 * go, and written about `JOINED_BYTES` a turn of the owner's (see turns.ts): to a fast reader the
 * stream would otherwise be written whole in one stretch of the event loop.
 */
export function partsBody(parts: string[], owner: string = ownerOfWork()): string | Readable {
  let bytes = 0;
  for (const p of parts) bytes += p.length;
  if (bytes <= JOINED_BYTES) return parts.join('');
  async function* body(): AsyncGenerator<string> {
    let sent = 0;
    for (const p of parts) {
      if (sent >= JOINED_BYTES) {
        await turns.next(owner);
        sent = 0;
      }
      yield p;
      sent += p.length;
    }
  }
  return Readable.from(body());
}

/** Sends `value` as JSON written in parts (see `jsonPartsSteps`): a long answer as a stream. */
export async function sendJsonInParts(reply: FastifyReply, value: unknown): Promise<FastifyReply> {
  const parts = await runSliced(jsonPartsSteps(value));
  reply.type('application/json; charset=utf-8');
  return reply.send(partsBody(parts));
}

/**
 * A JSON array of rows read one by one: `keys(after)` gives the next page of rows' keys in order
 * (read without their large columns; fewer than `pageSize` – or none – at the end), `row(key)`
 * the row's JSON (null: gone meanwhile). Written as it goes, each part in a turn of the owner's
 * own (see turns.ts) and only as fast as the answer is taken: many large rows never hold up the
 * server. `before` / `after` wrap the array (an object around it).
 */
export function rowsInParts<K>(owner: string, keys: (after: K | null) => K[], row: (key: K) => string | null, pageSize: number, wrap: { before: string; after: string } = { before: '[', after: ']' }): Readable {
  async function* body(): AsyncGenerator<string> {
    yield wrap.before;
    let first = true;
    let last: K | null = null;
    for (;;) {
      await turns.next(owner);
      const page = keys(last);
      let start = performance.now();
      let text = '';
      for (const key of page) {
        if (performance.now() - start >= SLICE_MS) {
          if (text) yield text;
          text = '';
          await turns.next(owner);
          start = performance.now();
        }
        const json = row(key);
        if (json === null) continue;
        text += (first ? '' : ',') + json;
        first = false;
      }
      if (text) yield text;
      if (page.length < pageSize) break;
      last = page[page.length - 1]!;
    }
    yield wrap.after;
  }
  return Readable.from(body());
}
