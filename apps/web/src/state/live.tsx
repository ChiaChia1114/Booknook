import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { LiveClient, type LiveSnapshot } from '../api/live';
import { useAuth } from './auth';

const Ctx = createContext<LiveClient | null>(null);

/** One shared Live connection per selected organisation for the whole app. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const { orgId, me } = useAuth();
  const [client, setClient] = useState<LiveClient | null>(null);
  useEffect(() => {
    if (!orgId || !me) return;
    const c = new LiveClient(orgId);
    setClient(c);
    return () => {
      c.close();
      setClient(null);
    };
  }, [orgId, me?.user.id]);
  return <Ctx.Provider value={client}>{children}</Ctx.Provider>;
}

const EMPTY: LiveSnapshot = { connected: false, canControl: false, userId: null, drones: {}, users: [], notifications: [], swarms: {}, version: 0 };
const noop = () => () => undefined;

export function useLive(): { client: LiveClient | null; live: LiveSnapshot } {
  const client = useContext(Ctx);
  const live = useSyncExternalStore(client?.subscribe ?? noop, client?.getSnapshot ?? (() => EMPTY));
  return { client, live };
}
