import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
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
import { useLive } from '../state/live';
import { NotificationBell } from './NotificationBell';
import { ErrorBoundary } from './ErrorBoundary';

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

function UserMenu({ name, email, role, onLogout }: { name: string; email: string; role: string | null; onLogout(): void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="user-menu" ref={box}>
      <button className="user-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Account menu">
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
          <button className="menu-item" onClick={onLogout} role="menuitem">
            <LogOut /> Log out
          </button>
        </div>
      )}
    </div>
  );
}

export function Layout({ children }: { children?: ReactNode }) {
  const { me, orgId, setOrgId, logout, role } = useAuth();
  const { live } = useLive();
  const navigate = useNavigate();
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
  // Narrow screens: the sidebar is a drawer opened from the top bar.
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setNavOpen(false), [location.pathname]);
  useEffect(() => {
    if (!navOpen) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setNavOpen(false);
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [navOpen]);
  const online = Object.values(live.drones).filter((d) => d.online).length;
  const flying = Object.values(live.drones).filter((d) => d.online && d.telemetry?.inAir).length;
  return (
    <div className={`app${collapsed ? ' collapsed' : ''}`}>
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}
      <aside className={`sidebar${navOpen ? ' open' : ''}`} id="main-nav">
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
                <NavLink key={i.to} to={i.to} end={i.to === '/'} title={collapsed ? i.label : undefined} aria-label={collapsed ? i.label : undefined}>
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
      <div className="main">
        <header className="topbar">
          <button className="top-icon nav-toggle" onClick={() => setNavOpen((o) => !o)} aria-label="Menu" aria-expanded={navOpen} aria-controls="main-nav">
            <Menu />
          </button>
          <select aria-label="Organisation" value={orgId ?? ''} onChange={(e) => setOrgId(e.target.value)}>
            {me?.memberships.map((m) => (
              <option key={m.orgId} value={m.orgId}>
                {m.orgName}
              </option>
            ))}
          </select>
          {role && <span className="badge role-badge">{ROLE_LABELS[role]}</span>}
          <span className="status-pill" title={live.connected ? 'Real-time link connected' : 'Real-time link disconnected'}>
            <span className={`dot ${live.connected ? 'ok' : 'danger'}`} />
            <span className="pill-text">
              {live.connected ? (
                <>
                  {online} drone{online === 1 ? '' : 's'} online{flying ? ` · ${flying} flying` : ''}
                </>
              ) : (
                'offline'
              )}
            </span>
          </span>
          <span className="spacer" />
          <Link to="/live" className="top-icon" title="Live operations map" aria-label="Live map">
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
                await logout();
                navigate('/login');
              }}
            />
          )}
        </header>
        <ErrorBoundary resetKey={location.pathname}>{children ?? <Outlet />}</ErrorBoundary>
      </div>
    </div>
  );
}
