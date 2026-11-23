import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from './api/client';

export interface Resource<T> {
  data: T | null;
  /**
   * The path `data` was loaded from: while a changed path loads, `data` is still the previous
   * one – a map fitted to the data keys its fitting on this, not on the path asked for.
   */
  dataPath: string | null;
  error: string | null;
  loading: boolean;
  reload(): void;
  setData(d: T | null): void;
}

/** Fetches a JSON resource and refetches when the path changes. */
export function useApi<T>(path: string | null, deps: unknown[] = []): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [dataPath, setDataPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    const ctl = new AbortController();
    setLoading(true);
    setError(null);
    api<T>(path, { signal: ctl.signal })
      .then((d) => {
        setData(d);
        setDataPath(path);
      })
      .catch((err) => {
        if (!ctl.signal.aborted) setError(errorMessage(err));
      })
      .finally(() => {
        if (!ctl.signal.aborted) setLoading(false);
      });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, dataPath, error, loading, reload, setData };
}

export function useInterval(fn: () => void, ms: number | null): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/** A local calendar day as YYYY-MM-DD (date inputs). */
function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Date range state persisted in the URL-less session (shared by analytics pages).
 *
 * "Last N days" are the last N calendar days, today included, from local midnight; the end is
 * left open (`to` empty: now, when the server answers). The range is so the same all day: pages
 * do not fetch again, refocus their maps or drop loaded pages when the minute changes, and still
 * see flights recorded meanwhile when they reload.
 */
export function useDateRange(defaultDays = 30) {
  const [days, setDays] = useState<number | 'custom'>(defaultDays);
  const [from, setFromState] = useState(() => localDay(new Date(Date.now() - (defaultDays - 1) * 86_400_000)));
  const [to, setToState] = useState(() => localDay(new Date()));
  // A date being typed or cleared (an empty or incomplete field) keeps the last complete one.
  const valid = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00:00`).getTime());
  const setFrom = useCallback((v: string) => {
    if (valid(v)) setFromState(v);
  }, []);
  const setTo = useCallback((v: string) => {
    if (valid(v)) setToState(v);
  }, []);
  let range: { from: string; to: string };
  if (days === 'custom') range = { from: new Date(`${from}T00:00:00`).toISOString(), to: new Date(`${to}T23:59:59.999`).toISOString() };
  else {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));
    range = { from: start.toISOString(), to: '' };
  }
  return { days, setDays, from, setFrom, to, setTo, range };
}
