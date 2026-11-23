import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { LiveClient, type LiveSnapshot } from '../api/live';
import { useAuth } from './auth';

const Ctx = createContext<LiveClient | null>(null);

/** One shared Live connection per selected organisation for the whole app. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const { orgId, me, refresh } = useAuth();
  const [client, setClient] = useState<LiveClient | null>(null);
  // The role changed while the page is open (the server says so on the live connection): the
  // top bar, menus and pages follow at once.
  const myRole = me?.memberships.find((m) => m.orgId === orgId)?.role ?? null;
  useEffect(() => {
    if (!client) return;
    return client.subscribe(() => {
      const role = client.getSnapshot().role;
      if (role && myRole && role !== myRole) void refresh();
    });
  }, [client, myRole, refresh]);
  useEffect(() => {
    if (!orgId || !me) return;
    const c = new LiveClient(orgId);
    // Removed from the organisation (or refused a connection): what the account may see is read
    // again – the pages then show another of its organisations, or say it has none.
    let asked = 0;
    c.onTrouble = (kind) => {
      if (kind === 'unreachable' && Date.now() - asked < 15_000) return;
      asked = Date.now();
      void refresh();
    };
    setClient(c);
    return () => {
      c.close();
      setClient(null);
    };
  }, [orgId, me?.user.id, refresh]);
  return <Ctx.Provider value={client}>{children}</Ctx.Provider>;
}

const EMPTY: LiveSnapshot = { connected: false, canControl: false, role: null, userId: null, drones: {}, users: [], notifications: [], swarms: {}, version: 0 };
const noop = () => () => undefined;

export function useLive(): { client: LiveClient | null; live: LiveSnapshot } {
  const client = useContext(Ctx);
  const live = useSyncExternalStore(client?.subscribe ?? noop, client?.getSnapshot ?? (() => EMPTY));
  return { client, live };
}
