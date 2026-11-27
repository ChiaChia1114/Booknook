import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import {
  ChevronDown,
  FileBarChart,
  FileCode2,
  LayoutDashboard,
  LogOut,
  Map as MapIcon,
  Menu,
  MapPin,
  Moon,
  Mountain,
  PanelLeftClose,
  PanelLeftOpen,
  Plane,
  Radar,
  Radio,
  ScrollText,
  Settings,
  ShieldCheck,
  Sun,
  UserRound,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { ROLE_LABELS } from '@athena-sky/shared';
import { useAuth } from '../state/auth';
import { orgSwitchTarget } from '../lib/navigation';
import { entryOrg, forgetEntryOrg, recordEntryOrg } from '../lib/history-orgs';
import { useLive } from '../state/live';
import { NotificationBell } from './NotificationBell';
import { ErrorBoundary } from './ErrorBoundary';
import { errorMessage } from '../api/client';
import { AsyncButton, Loading, anyModalOpen, useToast } from './ui';
import { lostText } from './LiveLink';

/** Athena-sky mark: a delta wing in a rounded square. */
export function Logo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="athena-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#60a5fa" />
          <stop offset="1" stopColor="#2563eb" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#athena-logo)" />
      <path d="M16 6.5 L24.5 24 L16 19.6 L7.5 24 Z" fill="#fff" />
    </svg>
  );
}

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard },
      { to: '/analytics', label: 'Drones & Operators', icon: Users },
      { to: '/locations', label: 'Flight Locations', icon: MapPin },
    ],
  },
  {
    section: 'Operations',
    items: [
      { to: '/live', label: 'Real-Time Flights', icon: Radio },
      { to: '/missions', label: '3D Mission Planning', icon: Mountain },
      { to: '/airspace', label: 'Airspace & UTM', icon: Radar },
    ],
  },
  {
    section: 'Assets & data',
    items: [
      { to: '/fleet', label: 'Fleet Management', icon: Plane },
      { to: '/maintenance', label: 'Maintenance', icon: Wrench },
      { to: '/flights', label: 'Flight Logs', icon: ScrollText },
      { to: '/reports', label: 'Reports', icon: FileBarChart },
    ],
  },
  {
    section: 'Organisation',
    items: [{ to: '/settings', label: 'Settings & API', icon: Settings }],
  },
];

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(() => localStorage.getItem('athena.theme') ?? 'dark');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('athena.theme', theme);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}

export const initials = (name: string | null | undefined) =>
  (name ?? '?')
    .split(/[\s(]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

function UserMenu({ name, email, role, onLogout }: { name: string; email: string; role: string | null; onLogout(): Promise<void> }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      // A dialog over the page has the keys.
      if (e.key !== 'Escape' || anyModalOpen()) return;
      const active = document.activeElement;
      const inside = !!box.current?.contains(active);
      setOpen(false);
      // The focus was in the menu (or lost from it to the page): it goes back to its button (not
      // lost with the menu).
      if (inside || !active || active === document.body) button.current?.focus();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="user-menu" ref={box}>
      <button ref={button} className="user-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Account menu">
        <span className="avatar">{initials(name)}</span>
        <span className="truncate user-name" style={{ maxWidth: 140 }}>
          {name}
        </span>
        <ChevronDown />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <div style={{ fontWeight: 600 }}>{name}</div>
            <div className="small" style={{ color: '#9ba3ae' }}>
              {email}
            </div>
            {role && (
              <div className="small" style={{ color: '#9ba3ae', marginTop: 2 }}>
                {role}
              </div>
            )}
          </div>
          <Link className="menu-item" to="/settings?tab=profile" onClick={() => setOpen(false)} role="menuitem">
            <UserRound /> My profile
          </Link>
          <Link className="menu-item" to="/settings" onClick={() => setOpen(false)} role="menuitem">
            <Settings /> Settings & API
          </Link>
          <AsyncButton className="menu-item" onClick={onLogout} role="menuitem">
            <LogOut /> Log out
          </AsyncButton>
        </div>
      )}
    </div>
  );
}

/**
 * Each entry of the tab's history belongs to the organisation it was opened in (lib/history-orgs):
 * - Back (or Forward) to a page opened in another of the user's organisations goes back to that one;
 * - a page of an organisation the user is no longer a member of (removed meanwhile) leaves behind
 *   what its address selects there, as when switching in the top bar.
 * A page never shows in one organisation with the address of another's page: until the entry and
 * the organisation agree, it waits (returns why).
 */
function useHistoryOrg(orgId: string | null, setOrgId: (id: string) => void, memberOf: (id: string) => boolean): 'returning' | 'left' | null {
  const location = useLocation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  // The entry shown before: a replacing navigation (a filter written into the address, a switch)
  // removed it from the history – it is forgotten, so the record keeps only entries that exist.
  const previousKey = useRef(location.key);
  const opened = entryOrg(location.key);
  const returning = opened && opened !== orgId && memberOf(opened) ? opened : null;
  const left = !!opened && opened !== orgId && !memberOf(opened);
  useEffect(() => {
    // The entry a page is loaded at has no key of its own ("default" at every load): it gets one.
    if (location.key === 'default') {
      navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, { replace: true, state: location.state });
      return;
    }
    if (returning) {
      setOrgId(returning);
      return;
    }
    if (left) {
      navigate(orgSwitchTarget(location.pathname, location.search), { replace: true });
      return;
    }
    if (navigationType === 'REPLACE' && previousKey.current !== location.key) forgetEntryOrg(previousKey.current);
    previousKey.current = location.key;
    if (orgId) recordEntryOrg(location.key, orgId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key, orgId, returning, left]);
  return returning ? 'returning' : left ? 'left' : null;
}

export function Layout({ children }: { children?: ReactNode }) {
  const { me, orgId, setOrgId, logout, role } = useAuth();
  const { live } = useLive();
  const navigate = useNavigate();
  const toast = useToast();
  const [theme, toggleTheme] = useTheme();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('athena.sidebar') === 'collapsed';
    } catch {
      return false;
    }
  });
  const toggleSidebar = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem('athena.sidebar', c ? 'open' : 'collapsed');
      } catch {
        /* private mode */
      }
      return !c;
    });
  // Narrow screens: the sidebar is a drawer opened from the top bar. Open, it takes the keyboard
  // focus (the page behind is inert); Escape or the backdrop give it back to the menu button,
  // following a link moves it to the new page's heading.
  const [navOpen, setNavOpen] = useState(false);
  // Counts the menu links followed to the page already shown: each starts the page afresh.
  const [fresh, setFresh] = useState(0);
  const navButton = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const navOpenRef = useRef(false);
  navOpenRef.current = navOpen;
  const location = useLocation();
  const closeNav = () => {
    setNavOpen(false);
    requestAnimationFrame(() => navButton.current?.focus());
  };
  useEffect(() => {
    if (!navOpenRef.current) return;
    setNavOpen(false);
    // The page may still be loading – and the page behind the drawer stays inert until the drawer
    // has closed: wait for its heading to be focusable (a second at most).
    let frames = 0;
    const focusPage = () => {
      const heading = mainRef.current?.querySelector<HTMLElement>('h1');
      if (heading && !heading.closest('[inert]')) {
        heading.tabIndex = -1;
        heading.focus();
      } else if (++frames < 60) requestAnimationFrame(focusPage);
      else mainRef.current?.focus();
    };
    requestAnimationFrame(focusPage);
  }, [location.pathname]);
  useEffect(() => {
    if (!navOpen) return;
    // The menu takes the focus – unless it has it already (a link focused at once is kept).
    requestAnimationFrame(() => {
      const nav = navRef.current;
      if (!nav || nav.contains(document.activeElement)) return;
      (nav.querySelector<HTMLElement>('a.active') ?? nav.querySelector<HTMLElement>('a, button'))?.focus();
    });
    const keys = (e: KeyboardEvent) => {
      // A dialog over the menu (a one-time secret shown late) has the keyboard.
      if (anyModalOpen()) return;
      if (e.key === 'Escape') return closeNav();
      // Tab and Shift+Tab go round the menu's links (the page behind is inert).
      const nav = navRef.current;
      if (e.key !== 'Tab' || !nav) return;
      const items = [...nav.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const inside = nav.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    // Wide again (a rotated tablet): the drawer is the sidebar.
    const wide = window.matchMedia('(min-width: 901px)');
    const onWide = () => wide.matches && setNavOpen(false);
    document.addEventListener('keydown', keys);
    wide.addEventListener('change', onWide);
    return () => {
      document.removeEventListener('keydown', keys);
      wide.removeEventListener('change', onWide);
    };
  }, [navOpen]);
  const waiting = useHistoryOrg(orgId, setOrgId, (id) => !!me?.memberships.some((m) => m.orgId === id));
  // Counted from live data only: while the link is lost, the drones last received are not.
  const online = live.current ? Object.values(live.drones).filter((d) => d.online).length : 0;
  const flying = live.current ? Object.values(live.drones).filter((d) => d.online && d.telemetry?.inAir).length : 0;
  // The real-time link: up (the drones of this connection received), delayed (open, but what it
  // brings comes late), being made (the first connection, or connected again and receiving the
  // drones), or down (lost, or the last attempt failed – it is tried again).
  const link = live.current ? 'up' : live.delayed ? 'slow' : live.connected ? 'joining' : live.synced || live.unreachable ? 'down' : 'joining';
  const linkTitle =
    link === 'up'
      ? `Real-time link connected – ${online} drone${online === 1 ? '' : 's'} online${flying ? `, ${flying} flying` : ''}`
      : link === 'slow'
        ? `${lostText(live)} What is shown is not live.`
        : link === 'joining'
          ? 'Connecting to the real-time service…'
          : `${live.synced ? lostText(live) : 'Real-time link disconnected – trying again.'}`;
  return (
    <div className={`app${collapsed ? ' collapsed' : ''}`}>
      {navOpen && <div className="nav-backdrop" onClick={closeNav} />}
      <aside className={`sidebar${navOpen ? ' open' : ''}`} id="main-nav" ref={navRef}>
        <div className="brand">
          <Logo /> <span className="brand-name">Athena-sky</span>
          <button className="sidebar-toggle" onClick={toggleSidebar} aria-label={collapsed ? 'Expand the menu' : 'Collapse the menu'} title={collapsed ? 'Expand the menu' : 'Collapse the menu'}>
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </button>
        </div>
        <nav className="nav">
          {NAV.map((s) => (
            <div key={s.section} className="nav-group">
              <div className="nav-section">{s.section}</div>
              {s.items.map((i) => (
                <NavLink
                  key={i.to}
                  to={i.to}
                  end={i.to === '/'}
                  title={collapsed ? i.label : undefined}
                  aria-label={collapsed ? i.label : undefined}
                  // The page already shown starts afresh – its filters as a reload of the address
                  // shows them – and the drawer closes all the same.
                  onClick={() => {
                    if (location.pathname !== i.to) return;
                    setFresh((n) => n + 1);
                    if (navOpen) closeNav();
                  }}
                >
                  <i.icon aria-hidden="true" />
                  <span className="nav-label">{i.label}</span>
                  {i.to === '/live' && flying > 0 && <span className="nav-badge">{flying}</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-links">
          <a href="/api/v2/docs/" target="_blank" rel="noreferrer" title="API reference">
            <FileCode2 aria-hidden="true" /> <span>API reference</span>
          </a>
          <a href="/safety-map" target="_blank" rel="noreferrer" title="Public safety map">
            <ShieldCheck aria-hidden="true" /> <span>Public safety map</span>
          </a>
        </div>
      </aside>
      <div className="main" ref={mainRef} tabIndex={-1} inert={navOpen}>
        <header className="topbar">
          <button ref={navButton} className="top-icon nav-toggle" onClick={() => setNavOpen((o) => !o)} aria-label="Menu" aria-expanded={navOpen} aria-controls="main-nav">
            <Menu />
          </button>
          <select
            aria-label="Organisation"
            value={orgId ?? ''}
            onChange={(e) => {
              // One update (the router does not defer navigations, see main.tsx): the page starts
              // afresh in the new organisation at an address that names nothing of the previous one.
              navigate(orgSwitchTarget(location.pathname, location.search), { replace: true });
              setOrgId(e.target.value);
            }}
          >
            {me?.memberships.map((m) => (
              <option key={m.orgId} value={m.orgId}>
                {m.orgName}
              </option>
            ))}
          </select>
          {role && <span className="badge role-badge">{ROLE_LABELS[role]}</span>}
          {/* Narrow screens show only the dot: each state has its own (green live, amber ring being
              made, amber delayed, red lost) – its words stay for screen readers (hidden from view
              only), and the tooltip says it in full. */}
          <span className="status-pill" title={linkTitle} data-link={link}>
            <span className={`dot ${link === 'up' ? 'ok' : link === 'joining' ? 'warn ring' : link === 'slow' ? 'warn' : 'danger'}`} />
            <span className="pill-text">
              {link === 'up' ? (
                <>
                  {online} drone{online === 1 ? '' : 's'} online{flying ? ` · ${flying} flying` : ''}
                </>
              ) : link === 'slow' ? (
                'delayed'
              ) : link === 'joining' ? (
                'connecting…'
              ) : (
                'offline'
              )}
            </span>
          </span>
          <span className="spacer" />
          <Link to="/live" className="top-icon" title="Live operations map" aria-label="Live map" onClick={() => location.pathname === '/live' && setFresh((n) => n + 1)}>
            <MapIcon />
          </Link>
          <NotificationBell />
          <button className="top-icon" onClick={toggleTheme} aria-label="Toggle theme" title={theme === 'dark' ? 'Light theme' : 'Dark theme'}>
            {theme === 'dark' ? <Sun /> : <Moon />}
          </button>
          {me && (
            <UserMenu
              name={me.user.name}
              email={me.user.email}
              role={role ? ROLE_LABELS[role] : null}
              onLogout={async () => {
                try {
                  await logout();
                } catch (err) {
                  toast(`Not logged out: ${errorMessage(err)}`, 'error');
                  return;
                }
                navigate('/login');
              }}
            />
          )}
        </header>
        {/* A page starts afresh in another organisation: nothing it loaded or holds for the previous one stays. */}
        <ErrorBoundary resetKey={`${location.pathname}|${orgId}`}>
          {waiting ? (
            <Loading what={waiting === 'returning' ? 'Back to the organisation of this page…' : 'Loading…'} />
          ) : (
            <Fragment key={`${orgId ?? ''}|${fresh}`}>{children ?? <Outlet />}</Fragment>
          )}
        </ErrorBoundary>
      </div>
    </div>
  );
}
