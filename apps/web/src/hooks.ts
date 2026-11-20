import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from './api/client';

export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload(): void;
  setData(d: T | null): void;
}

/** Fetches a JSON resource and refetches when the path changes. */
export function useApi<T>(path: string | null, deps: unknown[] = []): Resource<T> {
  const [data, setData] = useState<T | null>(null);
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
      .then((d) => setData(d))
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
  return { data, error, loading, reload, setData };
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

/** Date range state persisted in the URL-less session (shared by analytics pages). */
export function useDateRange(defaultDays = 30) {
  const [days, setDays] = useState<number | 'custom'>(defaultDays);
  const [from, setFrom] = useState(() => new Date(Date.now() - defaultDays * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const range =
    days === 'custom'
      ? { from: new Date(`${from}T00:00:00`).toISOString(), to: new Date(`${to}T23:59:59`).toISOString() }
      : { from: new Date(Date.now() - days * 86_400_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() };
  // Round the open-ended range to the minute so it does not change on every render.
  if (days !== 'custom') {
    range.from = range.from.slice(0, 16) + ':00.000Z';
    range.to = range.to.slice(0, 16) + ':00.000Z';
  }
  return { days, setDays, from, setFrom, to, setTo, range };
}
