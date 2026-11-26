import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from './api/client';
import { customProblem, localDay } from './lib/period';

export { calendarBounds, plausibleDay, shiftDay } from './lib/period';

export interface Resource<T> {
  data: T | null;
  /**
   * The path `data` was loaded from: while a changed path loads, `data` is still the previous
   * one – a map fitted to the data keys its fitting on this, not on the path asked for.
   */
  dataPath: string | null;
  error: string | null;
  loading: boolean;
  reload(): Promise<void>;
  setData(d: T | null): void;
}

/**
 * Fetches a JSON resource and refetches when the path changes. While a changed path loads, the
 * previous data stays; if that request fails, the previous data goes – a page never shows the
 * results of other filters under the error of its current ones. (A failed reload of the same path
 * keeps its data, and so does a failed path that `keepOnError` says still has the data loaded –
 * e.g. a longer part of the same list.)
 */
export function useApi<T>(path: string | null, deps: unknown[] = [], opts: { keepOnError?(loadedPath: string, failedPath: string): boolean } = {}): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [dataPath, setDataPath] = useState<string | null>(null);
  const loadedPath = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [tick, setTick] = useState(0);
  const keepOnError = useRef(opts.keepOnError);
  keepOnError.current = opts.keepOnError;
  // Callers of reload() waiting for its answer (e.g. a button kept busy until the list shows the change).
  const reloaded = useRef<(() => void)[]>([]);
  useEffect(() => {
    const settle = () => {
      for (const done of reloaded.current.splice(0)) done();
    };
    if (!path) {
      setLoading(false);
      settle();
      return;
    }
    const ctl = new AbortController();
    setLoading(true);
    setError(null);
    api<T>(path, { signal: ctl.signal })
      .then((d) => {
        loadedPath.current = path;
        setData(d);
        setDataPath(path);
      })
      .catch((err) => {
        if (ctl.signal.aborted) return;
        setError(errorMessage(err));
        const loaded = loadedPath.current;
        if (loaded !== path && !(loaded !== null && keepOnError.current?.(loaded, path))) {
          loadedPath.current = null;
          setData(null);
          setDataPath(null);
        }
      })
      .finally(() => {
        if (ctl.signal.aborted) return;
        setLoading(false);
        settle();
      });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps]);
  /** Reads the resource again; resolves once the new answer (or its error) is in. */
  const reload = useCallback(
    () =>
      new Promise<void>((resolve) => {
        reloaded.current.push(resolve);
        setTick((t) => t + 1);
      }),
    [],
  );
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

/**
 * Date range state persisted in the URL-less session (shared by analytics pages).
 *
 * "Last N days" are the last N calendar days, today included, from local midnight; the end is
 * left open (`to` empty: now, when the server answers). The range is so the same all day: pages
 * do not fetch again, refocus their maps or drop loaded pages when the minute changes, and still
 * see flights recorded meanwhile when they reload.
 *
 * A custom period is at most `maxDays` days (what the page's requests accept on the server).
 */
/**
 * The period of a page's filters: the last `days` days, a custom period, or – where the page
 * offers it (`DateRangeFilter allTime`) – all time ('all': no bounds, `range` is empty).
 */
export function useDateRange(defaultDays: number | 'all' = 30, maxDays = 3660) {
  const [days, setDays] = useState<number | 'custom' | 'all'>(defaultDays);
  const initialFrom = () => localDay(new Date(Date.now() - ((typeof defaultDays === 'number' ? defaultDays : 30) - 1) * 86_400_000));
  // What the date fields show (also while being typed, cleared or not yet a valid period) …
  const [fromInput, setFromInput] = useState(initialFrom);
  const [toInput, setToInput] = useState(() => localDay(new Date()));
  // … and the period asked for: the last complete, valid pair of dates. The year typed digit by
  // digit passes 0002, 0020, 0202, and a period being moved can pass From after To or one too long:
  // nothing is asked for until the dates make a period the page accepts again (`problem` says why
  // the fields are not applied meanwhile).
  const [applied, setApplied] = useState(() => ({ from: fromInput, to: toInput }));
  const latest = useRef(applied);
  const update = useCallback(
    (which: 'from' | 'to', v: string) => {
      latest.current = { ...latest.current, [which]: v };
      (which === 'from' ? setFromInput : setToInput)(v);
      const { from, to } = latest.current;
      if (!customProblem(from, to, maxDays)) setApplied({ from, to });
    },
    [maxDays],
  );
  const setFrom = useCallback((v: string) => update('from', v), [update]);
  const setTo = useCallback((v: string) => update('to', v), [update]);
  const custom = days === 'custom';
  // Whatever keeps the fields from being applied – a year outside 1970–2100 or an empty field too.
  const problem = custom ? customProblem(fromInput, toInput, maxDays) : null;
  let range: { from: string; to: string };
  if (custom) range = { from: new Date(`${applied.from}T00:00:00`).toISOString(), to: new Date(`${applied.to}T23:59:59.999`).toISOString() };
  else if (days === 'all') range = { from: '', to: '' };
  else {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));
    range = { from: start.toISOString(), to: '' };
  }
  return { days, setDays, from: fromInput, setFrom, to: toInput, setTo, range, maxDays, problem, applied: custom ? applied : null };
}

