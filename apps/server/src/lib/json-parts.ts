/**
 * Long JSON answers written a few hundred array items at a time, each part in a turn of its own
 * (see `runSliced`): a long answer – a flight's samples, a heatmap, a report – is neither written
 * in one go nor joined into one string while the live connections wait.
 */
import { Readable } from 'node:stream';
import type { FastifyReply } from 'fastify';
import { runSliced, type Steps } from './slice';

/** Array items written per part. */
const ITEMS_PER_PART = 256;
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
    for (let i = 0; i < items.length; i += ITEMS_PER_PART) {
      parts.push(
        (i ? ',' : '') +
          items
            .slice(i, i + ITEMS_PER_PART)
            .map((x) => JSON.stringify(x) ?? 'null')
            .join(','),
      );
      yield;
    }
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
      if (Array.isArray(v) && v.length > ITEMS_PER_PART) yield* array(v);
      else parts.push(JSON.stringify(v));
    }
    parts.push('}');
  } else parts.push(JSON.stringify(value) ?? 'null');
  return parts;
}

/** Sends `value` as JSON written in parts (see `jsonPartsSteps`): a long answer as a stream. */
export async function sendJsonInParts(reply: FastifyReply, value: unknown): Promise<FastifyReply> {
  const parts = await runSliced(jsonPartsSteps(value));
  let bytes = 0;
  for (const p of parts) bytes += p.length;
  reply.type('application/json; charset=utf-8');
  return reply.send(bytes <= JOINED_BYTES ? parts.join('') : Readable.from(parts));
}
