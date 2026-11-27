/**
 * Long computations in slices.
 *
 * Reading a long log, checking a long flight, loading its samples: the work is written as a
 * generator that `yield`s every few units of work. `runSliced` runs it in slices of about
 * `SLICE_MS`, each in a turn of the event loop of its own (see `turns.ts`): live telemetry, video,
 * commands and the requests of every organisation go on between them, and no one's computations
 * hold up another's; `runAtOnce` runs it to the end (tests, small inputs).
 */
import { jobSlots, ownerOfWork, turns } from './turns';

export type Steps<T> = Generator<void, T, void>;

/** Longest stretch of work in one turn of the event loop (ms). */
export const SLICE_MS = 4;

export function runAtOnce<T>(steps: Steps<T>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/**
 * Runs the steps a slice at a time, each in a turn of its own – of the member (or address) whose
 * request it serves, after the turns of others waiting; at most `JOBS_PER_OWNER` computations of
 * one owner go on at once (the others wait to begin).
 */
export async function runSliced<T>(steps: Steps<T>, sliceMs = SLICE_MS): Promise<T> {
  const owner = ownerOfWork();
  const release = await jobSlots.take(owner);
  try {
    for (;;) {
      await turns.next(owner);
      const start = performance.now();
      for (;;) {
        const r = steps.next();
        if (r.done) return r.value;
        if (performance.now() - start >= sliceMs) break;
      }
    }
  } finally {
    release();
  }
}

/** For loops in async functions: `await pace()` waits for the next turn once a slice is used up. */
export function pacer(sliceMs = SLICE_MS): () => Promise<void> | void {
  const owner = ownerOfWork();
  let start = performance.now();
  return () => {
    if (performance.now() - start < sliceMs) return;
    return turns.next(owner).then(() => {
      start = performance.now();
    });
  };
}

/** Whether the items are in order of `key` already. */
export function* isSortedSteps<T>(items: readonly T[], key: (x: T) => number): Steps<boolean> {
  for (let i = 1; i < items.length; i++) {
    if (i % 4096 === 0) yield;
    if (key(items[i]!) < key(items[i - 1]!)) return false;
  }
  return true;
}

/** Sorts by a number, stable, in slices (bottom-up merge sort); returns the items in a new array. */
export function* sortSteps<T>(items: readonly T[], key: (x: T) => number): Steps<T[]> {
  let src = items.slice();
  if (yield* isSortedSteps(src, key)) return src;
  let dst = new Array<T>(src.length);
  let moved = 0;
  for (let width = 1; width < src.length; width *= 2) {
    for (let lo = 0; lo < src.length; lo += 2 * width) {
      const mid = Math.min(lo + width, src.length);
      const hi = Math.min(lo + 2 * width, src.length);
      let i = lo;
      let j = mid;
      let k = lo;
      while (i < mid && j < hi) dst[k++] = key(src[j]!) < key(src[i]!) ? src[j++]! : src[i++]!;
      while (i < mid) dst[k++] = src[i++]!;
      while (j < hi) dst[k++] = src[j++]!;
      moved += hi - lo;
      if (moved >= 8192) {
        moved = 0;
        yield;
      }
    }
    [src, dst] = [dst, src];
  }
  return src;
}
