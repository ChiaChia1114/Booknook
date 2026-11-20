import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { MeDto, OrganisationDto, Permission, Role } from '@athena-sky/shared';
import { can } from '@athena-sky/shared';
import { api, setUnauthorizedHandler } from '../api/client';

interface AuthState {
  me: MeDto | null;
  loading: boolean;
  orgId: string | null;
  org: OrganisationDto | null;
  role: Role | null;
  setOrgId(id: string): void;
  refresh(): Promise<void>;
  refreshOrg(): Promise<void>;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  setMe(me: MeDto): void;
  can(p: Permission): boolean;
}

const Ctx = createContext<AuthState | null>(null);
const ORG_KEY = 'athena.org';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [orgId, setOrgIdState] = useState<string | null>(() => localStorage.getItem(ORG_KEY));
  const [org, setOrg] = useState<OrganisationDto | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api<{ authenticated: boolean } & Partial<MeDto>>('/api/v2/auth/session');
      setMe(s.authenticated && s.user && s.memberships ? { user: s.user, memberships: s.memberships } : null);
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    setUnauthorizedHandler(() => setMe(null));
  }, [refresh]);

  // Keep the selected organisation valid.
  const effectiveOrgId = useMemo(() => {
    if (!me || me.memberships.length === 0) return null;
    return me.memberships.some((m) => m.orgId === orgId) ? orgId : me.memberships[0]!.orgId;
  }, [me, orgId]);

  const refreshOrg = useCallback(async () => {
    if (!effectiveOrgId) {
      setOrg(null);
      return;
    }
    try {
      setOrg(await api<OrganisationDto>(`/api/v2/organisations/${effectiveOrgId}`));
    } catch {
      setOrg(null);
    }
  }, [effectiveOrgId]);

  useEffect(() => {
    void refreshOrg();
  }, [refreshOrg]);

  const value: AuthState = {
    me,
    loading,
    orgId: effectiveOrgId,
    org,
    role: (me?.memberships.find((m) => m.orgId === effectiveOrgId)?.role ?? null) as Role | null,
    setOrgId: (id) => {
      localStorage.setItem(ORG_KEY, id);
      setOrgIdState(id);
    },
    refresh,
    refreshOrg,
    login: async (email, password) => {
      setMe(await api<MeDto>('/api/v2/auth/login', { body: { email, password } }));
    },
    logout: async () => {
      await api('/api/v2/auth/logout', { method: 'POST' }).catch(() => undefined);
      setMe(null);
    },
    setMe,
    can: (p) => can((me?.memberships.find((m) => m.orgId === effectiveOrgId)?.role ?? null) as Role | null, p),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

/** Organisation id of the current context (pages are only rendered when one exists). */
export function useOrgId(): string {
  const { orgId } = useAuth();
  if (!orgId) throw new Error('No organisation selected');
  return orgId;
}
