import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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

// The organisation the pages show now – for an answer that comes after its page was left (it says
// which organisation it is about when another one is shown).
let shownOrg: string | null = null;
export const shownOrgId = (): string | null => shownOrg;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [orgId, setOrgIdState] = useState<string | null>(() => localStorage.getItem(ORG_KEY));
  const [org, setOrg] = useState<OrganisationDto | null>(null);
  const [orgError, setOrgError] = useState<{ orgId: string; error: string } | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  // Only the latest word on the session counts: a check overtaken by a later one, a login or a logout
  // (e.g. answering late, from before signing out) is dropped.
  const sessionReads = useRef(0);
  const refresh = useCallback(async () => {
    const read = ++sessionReads.current;
    try {
      const s = await api<{ authenticated: boolean } & Partial<MeDto>>('/api/v2/auth/session');
      if (read !== sessionReads.current) return;
      setMe(s.authenticated && s.user && s.memberships ? { user: s.user, memberships: s.memberships } : null);
      setSessionError(null);
    } catch (err) {
      if (read !== sessionReads.current) return;
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
    setUnauthorizedHandler(() => {
      sessionReads.current++;
      setMe(null);
    });
  }, [refresh]);

  // Keep the selected organisation valid.
  const effectiveOrgId = useMemo(() => {
    if (!me || me.memberships.length === 0) return null;
    return me.memberships.some((m) => m.orgId === orgId) ? orgId : me.memberships[0]!.orgId;
  }, [me, orgId]);

  // Only the latest read counts: an answer overtaken by a later one – about the organisation
  // selected before, answering late, or an older read of this one – is dropped, so it never
  // shows (nor is saved) as the current organisation.
  const orgReads = useRef(0);
  // Whoever asks – also a page of the organisation selected before, finishing late (e.g. its
  // Save) – the organisation read is the one selected now.
  const selectedOrg = useRef(effectiveOrgId);
  selectedOrg.current = effectiveOrgId;
  shownOrg = effectiveOrgId;
  const refreshOrg = useCallback(async () => {
    const read = ++orgReads.current;
    const asked = selectedOrg.current;
    if (!asked) {
      setOrg(null);
      setOrgError(null);
      return;
    }
    // Never the organisation selected before while another one loads.
    setOrg((o) => (o?.id === asked ? o : null));
    setOrgError(null);
    try {
      const o = await api<OrganisationDto>(`/api/v2/organisations/${asked}`);
      if (read !== orgReads.current) return;
      setOrg(o);
    } catch (err) {
      if (read !== orgReads.current) return;
      setOrg(null);
      setOrgError({ orgId: asked, error: errorMessage(err) });
    }
  }, []);

  useEffect(() => {
    void refreshOrg();
  }, [effectiveOrgId, refreshOrg]);

  const value: AuthState = {
    me,
    loading,
    sessionError,
    orgId: effectiveOrgId,
    // Only ever the organisation selected (see refreshOrg).
    org: org?.id === effectiveOrgId ? org : null,
    orgError: orgError?.orgId === effectiveOrgId ? orgError.error : null,
    role: (me?.memberships.find((m) => m.orgId === effectiveOrgId)?.role ?? null) as Role | null,
    setOrgId: (id) => {
      localStorage.setItem(ORG_KEY, id);
      setOrgIdState(id);
    },
    refresh,
    refreshOrg,
    login: async (email, password) => {
      const signedIn = await api<MeDto>('/api/v2/auth/login', { body: { email, password } });
      sessionReads.current++;
      setSessionError(null);
      setMe(signedIn);
    },
    // Signed out once the server has ended the session (a failure is shown, the session kept).
    logout: async () => {
      await api('/api/v2/auth/logout', { method: 'POST' });
      sessionReads.current++;
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
