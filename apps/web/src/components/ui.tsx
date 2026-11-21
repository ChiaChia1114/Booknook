import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, ChevronUp, Inbox, X, type LucideIcon } from 'lucide-react';
import { formatDistance, formatDuration } from '@athena-sky/shared';

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export function Loading({ what = 'Loading…' }: { what?: string }) {
  return (
    <div className="empty">
      <Spinner /> <span style={{ marginLeft: 8 }}>{what}</span>
    </div>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? (
    <div className="error-box" role="alert">
      {error}
    </div>
  ) : null;
}

export function Empty({ children, icon: Icon = Inbox }: { children: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="empty">
      <Icon aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}

export function Card({ title, actions, children, tight, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; tight?: boolean; className?: string }) {
  return (
    <section className={`card${tight ? ' tight' : ''}${className ? ` ${className}` : ''}`}>
      {(title || actions) && (
        <div className="card-head">
          {typeof title === 'string' ? <h3>{title}</h3> : title}
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Kpi({ label, value, sub, tone, icon: Icon, iconTone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'warn' | 'danger'; icon?: LucideIcon; iconTone?: 'ok' | 'warn' | 'danger' | 'violet' }) {
  return (
    <div className="card kpi" data-testid={`kpi-${label.toLowerCase().replace(/\s+/g, '-')}`}>
      {Icon && (
        <span className={`kpi-icon${iconTone ? ` ${iconTone}` : ''}`} aria-hidden="true">
          <Icon />
        </span>
      )}
      <span className="label">{label}</span>
      <span className="value" style={tone ? { color: `var(--${tone})` } : undefined}>
        {value}
      </span>
      {sub && <span className="sub">{sub}</span>}
    </div>
  );
}

export function Badge({ tone, children }: { tone?: 'ok' | 'warn' | 'danger' | 'accent'; children: ReactNode }) {
  return <span className={`badge${tone ? ` ${tone}` : ''}`}>{children}</span>;
}

export function PageHead({ title, subtitle, actions, crumbs }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; crumbs?: { to: string; label: string }[] }) {
  return (
    <div className="page-head">
      <div style={{ minWidth: 0 }}>
        {crumbs && crumbs.length > 0 && (
          <nav className="crumbs" aria-label="Breadcrumb">
            {crumbs.map((c) => (
              <span key={c.to} className="row" style={{ gap: 6 }}>
                <Link to={c.to}>{c.label}</Link>
                <ChevronRight aria-hidden="true" />
              </span>
            ))}
          </nav>
        )}
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children, wide, actions }: { title: string; onClose(): void; children: ReactNode; wide?: boolean; actions?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="card-head">
          <h2>{title}</h2>
          <button className="icon-btn" style={{ background: 'transparent', borderColor: 'transparent' }} onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>
        {children}
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>
  );
}

// --- toasts ---------------------------------------------------------------------------------

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'ok' | 'error';
}
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// --- formatting helpers -----------------------------------------------------------------------

export const fmtDate = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString() : '—');
export const fmtDay = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleDateString() : '—');
export const fmtDuration = formatDuration;
export const fmtDistance = formatDistance;
export const fmtNum = (v: number | null | undefined, digits = 1): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits));

export function timeAgo(iso: string | number | null | undefined): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.max(0, s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function scoreTone(score: number | null | undefined): 'ok' | 'warn' | 'danger' | undefined {
  if (score === null || score === undefined) return undefined;
  return score >= 85 ? 'ok' : score >= 60 ? 'warn' : 'danger';
}

/** Sortable table state helper. */
export function useSort<T>(rows: T[], initial: keyof T, desc = true) {
  const [key, setKey] = useState<keyof T>(initial);
  const [dir, setDir] = useState<1 | -1>(desc ? -1 : 1);
  const sorted = [...rows].sort((a, b) => {
    const x = a[key] as unknown;
    const y = b[key] as unknown;
    if (x === y) return 0;
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    return (x < y ? -1 : 1) * dir;
  });
  const th = (k: keyof T, label: string, num = false) => (
    <th
      className={`sortable${num ? ' num' : ''}`}
      onClick={() => {
        if (k === key) setDir((d) => (d === 1 ? -1 : 1));
        else {
          setKey(k);
          setDir(-1);
        }
      }}
    >
      <span className="th-sort">
        {label}
        {k === key && (dir === -1 ? <ChevronDown aria-label="sorted descending" /> : <ChevronUp aria-label="sorted ascending" />)}
      </span>
    </th>
  );
  return { sorted, th };
}
