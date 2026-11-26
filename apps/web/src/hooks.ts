import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ApiError, api, errorMessage } from './api/client';
import { recordEntryOrg } from './lib/history-orgs';
import { customProblem, localDay } from './lib/period';
import { useAuth } from './state/auth';

export { calendarBounds, plausibleDay, shiftDay } from './lib/period';

export interface Resource<T> {
  data: T | null;
  /**
   * The path `data` was loaded from: while a changed path loads, `data` is still the previous
   * one – a map fitted to the data keys its fitting on this, not on the path asked for.
   */
  dataPath: string | null;
  error: string | null;
  /** The HTTP status of the failed request (404: not found), null when it never got an answer. */
  errorStatus: number | null;
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
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
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
    setErrorStatus(null);
    api<T>(path, { signal: ctl.signal })
      .then((d) => {
        loadedPath.current = path;
        setData(d);
        setDataPath(path);
      })
      .catch((err) => {
        if (ctl.signal.aborted) return;
        setError(errorMessage(err));
        setErrorStatus(err instanceof ApiError ? err.status : null);
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
  return { data, dataPath, error, errorStatus, loading, reload, setData };
}

/**
 * Whether the component is still shown. An action answered after its page was left – another
 * page, or the same page started afresh in another organisation – does not act on the page shown
 * now (e.g. open the item it created).
 */
export function useStillShown(): () => boolean {
  const shown = useRef(false);
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);
  return useCallback(() => shown.current, []);
}

/**
 * The openings of a dialog whose state the page holds (`open`: whether it is shown). An action
 * started in the dialog acts on it – closes it, or fills it in again – only while the opening it
 * was started in is still shown: answered after the dialog was closed (and maybe opened again), it
 * leaves the dialog shown now as it is. Returns, for an action starting, that check.
 */
export function useOpening(open: boolean): () => () => boolean {
  const opening = useRef(0);
  const shown = useRef(open);
  useLayoutEffect(() => {
    if (open === shown.current) return;
    shown.current = open;
    opening.current += 1;
  }, [open]);
  return useCallback(() => {
    const at = opening.current;
    return () => shown.current && opening.current === at;
  }, []);
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


/**
 * Where the drone, flight or mission named by the address is (asked of the server once): in the
 * organisation shown (`here`: the page loads it), or in another of the user's organisations – a
 * link or bookmark to it: that organisation is chosen (`elsewhere`), and the page then shows the
 * item there (Back and Forward keep it there). Nothing is asked of an organisation that does not
 * hold the item. In none of them (or no answer): `here` – the page's own request says why.
 */
export function useLocated(kind: 'drones' | 'flights' | 'missions', id: string): { here: boolean; elsewhere: boolean } {
  const { me, orgId, setOrgId } = useAuth();
  const location = useLocation();
  const located = useApi<{ orgId: string | null }>(id ? `/api/v2/locate/${kind}/${encodeURIComponent(id)}` : null);
  const at = located.data?.orgId ?? null;
  const other = at && at !== orgId && me?.memberships.some((m) => m.orgId === at) ? at : null;
  useEffect(() => {
    if (!other) return;
    // This page now belongs to that organisation (Back and Forward keep it there).
    recordEntryOrg(location.key, other);
    setOrgId(other);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [other]);
  return { here: (!!located.data && !other) || !!located.error, elsewhere: !!other };
}
