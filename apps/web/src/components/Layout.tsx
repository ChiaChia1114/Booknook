import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { ROLE_LABELS } from '@athena-sky/shared';
import { useAuth } from '../state/auth';
import { useLive } from '../state/live';

export function Logo() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r="30" fill="#0b1220" stroke="#38bdf8" strokeWidth="2" />
      <path d="M32 12 L50 50 L32 41 L14 50 Z" fill="#38bdf8" />
    </svg>
  );
}

const NAV: { section: string; items: { to: string; label: string; icon: string }[] }[] = [
  {
    section: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: '◧' },
      { to: '/analytics', label: 'Drones & Operators', icon: '▤' },
      { to: '/locations', label: 'Flight Locations', icon: '⌖' },
    ],
  },
  {
    section: 'Operations',
    items: [
      { to: '/live', label: 'Real-Time Flights', icon: '◉' },
      { to: '/missions', label: '3D Mission Planning', icon: '⛰' },
      { to: '/airspace', label: 'Airspace & UTM', icon: '◎' },
    ],
  },
  {
    section: 'Assets & data',
    items: [
      { to: '/fleet', label: 'Fleet Management', icon: '✈' },
      { to: '/flights', label: 'Flight Logs', icon: '☰' },
    ],
  },
  {
    section: 'Organisation',
    items: [{ to: '/settings', label: 'Settings & API', icon: '⚙' }],
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
  const online = Object.values(live.drones).filter((d) => d.online).length;
  return (
    <div className={`app${collapsed ? ' collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <Logo /> <span className="brand-name">Athena-sky</span>
          <button className="sidebar-toggle" onClick={toggleSidebar} aria-label={collapsed ? 'Expand the menu' : 'Collapse the menu'} title={collapsed ? 'Expand the menu' : 'Collapse the menu'}>
            {collapsed ? '»' : '«'}
          </button>
        </div>
        <nav className="nav">
          {NAV.map((s) => (
            <div key={s.section}>
              <div className="nav-section">{s.section}</div>
              {s.items.map((i) => (
                <NavLink key={i.to} to={i.to} end={i.to === '/'} title={collapsed ? i.label : undefined} aria-label={collapsed ? i.label : undefined}>
                  <span aria-hidden="true" style={{ width: 18, textAlign: 'center' }}>
                    {i.icon}
                  </span>
                  <span className="nav-label">{i.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div style={{ marginTop: 'auto', padding: '12px 10px 0' }} className="small muted sidebar-links">
          <a href="/api/v2/docs/" target="_blank" rel="noreferrer">
            API reference ↗
          </a>
          <br />
          <a href="/safety-map" target="_blank" rel="noreferrer">
            Public safety map ↗
          </a>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <select aria-label="Organisation" value={orgId ?? ''} onChange={(e) => setOrgId(e.target.value)}>
            {me?.memberships.map((m) => (
              <option key={m.orgId} value={m.orgId}>
                {m.orgName}
              </option>
            ))}
          </select>
          {role && <span className="badge">{ROLE_LABELS[role]}</span>}
          <span className="row small muted" title={live.connected ? 'Real-time link connected' : 'Real-time link disconnected'}>
            <span className={`dot ${live.connected ? 'ok' : 'danger'}`} /> {live.connected ? `${online} drone${online === 1 ? '' : 's'} online` : 'offline'}
          </span>
          <span className="spacer" />
          <button className="btn ghost small" onClick={toggleTheme} aria-label="Toggle theme">
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          <span className="small">{me?.user.name}</span>
          <button
            className="btn small"
            onClick={async () => {
              await logout();
              navigate('/login');
            }}
          >
            Log out
          </button>
        </header>
        {children ?? <Outlet />}
      </div>
    </div>
  );
}
