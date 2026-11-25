import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { MeDto, OrganisationDto, Permission, Role } from '@athena-sky/shared';
import { can } from '@athena-sky/shared';
import { ApiError, api, errorMessage, setUnauthorizedHandler } from '../api/client';

interface AuthState {
  me: MeDto | null;
  loading: boolean;
  /** Why the session could not be checked (the server could not be reached): not the same as signed out. */
  sessionError: string | null;
  orgId: string | null;
  org: OrganisationDto | null;
  /** Why the organisation (name, settings) could not be loaded. */
  orgError: string | null;
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
  const [orgError, setOrgError] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api<{ authenticated: boolean } & Partial<MeDto>>('/api/v2/auth/session');
      setMe(s.authenticated && s.user && s.memberships ? { user: s.user, memberships: s.memberships } : null);
      setSessionError(null);
    } catch (err) {
      // Signed out only when the server says so; otherwise the session could not be checked.
      if (err instanceof ApiError && err.status === 401) {
        setMe(null);
        setSessionError(null);
      } else setSessionError(errorMessage(err));
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
      setOrgError(null);
      return;
    }
    // Never the organisation selected before while another one loads.
    setOrg((o) => (o?.id === effectiveOrgId ? o : null));
    try {
      setOrg(await api<OrganisationDto>(`/api/v2/organisations/${effectiveOrgId}`));
      setOrgError(null);
    } catch (err) {
      setOrg(null);
      setOrgError(errorMessage(err));
    }
  }, [effectiveOrgId]);

  useEffect(() => {
    void refreshOrg();
  }, [refreshOrg]);

  const value: AuthState = {
    me,
    loading,
    sessionError,
    orgId: effectiveOrgId,
    org,
    orgError,
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
    // Signed out once the server has ended the session (a failure is shown, the session kept).
    logout: async () => {
      await api('/api/v2/auth/logout', { method: 'POST' });
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
