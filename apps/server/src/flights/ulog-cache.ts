/**
 * ULog files read for the log explorer ("plot any field"): the topics of a file, and one field
 * of a topic as a series. A file is read in slices (the server goes on answering meanwhile) and
 * the results are kept for a while, so listing the topics and plotting fields one after the
 * other does not read the whole file each time. Concurrent requests share one reading.
 */
import { readFile } from 'node:fs/promises';
import type { LogTopicDto } from '@athena-sky/shared';
import { runSliced } from '../lib/slice';
import { parseULogSteps } from './ulog';

const KEEP_MS = 10 * 60_000;

/** A small cache: least recently used out first, entries kept `KEEP_MS`. */
class Recent<T> {
  private readonly entries = new Map<string, { at: number; value: Promise<T> }>();

  constructor(private readonly size: number) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < KEEP_MS) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.value;
    }
    const value = load();
    this.entries.set(key, { at: Date.now(), value });
    // A failed reading is not kept.
    value.catch(() => this.entries.get(key)?.value === value && this.entries.delete(key));
    while (this.entries.size > this.size) this.entries.delete(this.entries.keys().next().value!);
    return value;
  }
}

export interface ULogListing {
  topics: LogTopicDto[];
  info: Record<string, string | number>;
  params: Record<string, number>;
}

const listings = new Recent<ULogListing>(16);
const series = new Recent<{ timestamps: number[]; values: number[] } | null>(4);

/** The topics (with data), information and parameters of the ULog file at `path`. */
export function ulogTopics(path: string): Promise<ULogListing> {
  return listings.get(path, async () => {
    const parsed = await runSliced(parseULogSteps(await readFile(path), { maxMessages: 0 }));
    return {
      topics: parsed.topics.filter((t) => t.samples > 0).map((t) => ({ name: t.name, multiId: t.multiId, fields: t.fields, samples: t.samples })),
      info: parsed.info,
      params: parsed.params,
    };
  });
}

/** One field of a topic of the ULog file at `path` (null when the file has no such field). */
export function ulogFields(path: string, topic: string, multiId: number, field: string): Promise<{ timestamps: number[]; values: number[] } | null> {
  return series.get(JSON.stringify([path, topic, multiId, field]), async () => {
    const parsed = await runSliced(parseULogSteps(await readFile(path), { include: (n) => n === topic, fields: (_n, f) => f === field, maxMessages: 0 }));
    const t = parsed.topics.find((x) => x.name === topic && x.multiId === multiId);
    const values = t?.data[field];
    return t && values ? { timestamps: t.timestamps, values } : null;
  });
}
