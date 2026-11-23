/**
 * Long computations in slices.
 *
 * Reading a long log, checking a long flight, loading its samples: the work is written as a
 * generator that `yield`s every few units of work. `runSliced` runs it in slices of about
 * `SLICE_MS` and gives the event loop a turn in between, so live telemetry, video, commands
 * and other requests of every organisation go on meanwhile; `runAtOnce` runs it to the end
 * (tests, small inputs).
 */
import { yieldToLoop } from './util';

export type Steps<T> = Generator<void, T, void>;

/** Longest stretch of work between two turns of the event loop (ms). */
export const SLICE_MS = 8;

export function runAtOnce<T>(steps: Steps<T>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

export async function runSliced<T>(steps: Steps<T>, sliceMs = SLICE_MS): Promise<T> {
  let start = performance.now();
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
    if (performance.now() - start >= sliceMs) {
      await yieldToLoop();
      start = performance.now();
    }
  }
}

/** For loops in async functions: `await pace()` gives the event loop a turn once a slice is used up. */
export function pacer(sliceMs = SLICE_MS): () => Promise<void> | void {
  let start = performance.now();
  return () => {
    if (performance.now() - start < sliceMs) return;
    return yieldToLoop().then(() => {
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
