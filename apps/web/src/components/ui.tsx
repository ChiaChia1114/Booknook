import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, ChevronUp, Inbox, X, type LucideIcon } from 'lucide-react';
import { formatDistance, formatDuration, VISIBLE_NAME_PATTERN } from '@athena-sky/shared';
import { errorMessage } from '../api/client';

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

/** `pattern` of name inputs: something other than spaces. */
/** `pattern` of name inputs: at least one visible character. */
export const NAME_PATTERN = VISIBLE_NAME_PATTERN;

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

/** What could not be loaded, and why – for a part of a page whose data did not come (null: it did). */
export function loadError(what: string, error: string | null | undefined): string | null {
  return error ? `${what} could not be loaded: ${error}` : null;
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
          {actions && <div className="row card-actions">{actions}</div>}
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

/** Runs an action that waits for the server one at a time: another click or submit while it runs is ignored (`busy` meanwhile). */
export function useAction(): { busy: boolean; run(action: () => unknown): Promise<void> } {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (action: () => unknown) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await action();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);
  return { busy, run };
}

/**
 * A button whose action waits for the server (creating, saving, deleting): disabled while the
 * action runs, so a double click sends one request. An action that fails without saying so
 * itself (e.g. a zone a colleague deleted meanwhile) shows its error.
 */
export function AsyncButton({ onClick, disabled, children, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & { onClick(e: ReactMouseEvent<HTMLButtonElement>): unknown }) {
  const { busy, run } = useAction();
  const toast = useToast();
  const act = async (e: ReactMouseEvent<HTMLButtonElement>) => {
    try {
      await onClick(e);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  return (
    <button {...rest} disabled={disabled || busy} aria-busy={busy || undefined} onClick={(e) => void run(() => act(e))}>
      {children}
    </button>
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

// --- one-time secrets ------------------------------------------------------------------------

interface SecretNotice {
  title: string;
  note: string;
  secret: string;
}
const SecretCtx = createContext<(n: SecretNotice) => void>(() => undefined);

/**
 * One-time secrets (a drone's link key, an API token, a webhook's signing secret) whose dialog or
 * page was gone when the server answered – closed meanwhile, or another organisation chosen: shown
 * here, over any page, until dismissed – never lost.
 */
export function SecretProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<SecretNotice[]>([]);
  const show = useCallback((n: SecretNotice) => setNotices((all) => [...all, n]), []);
  const dismiss = () => setNotices((all) => all.slice(1));
  const current = notices[0];
  return (
    <SecretCtx.Provider value={show}>
      {children}
      {current && (
        <Modal
          title={current.title}
          onClose={dismiss}
          actions={
            <button className="btn primary" onClick={dismiss}>
              Done
            </button>
          }
        >
          <p>{current.note}</p>
          <div className="secret" data-testid="late-secret">
            {current.secret}
          </div>
        </Modal>
      )}
    </SecretCtx.Provider>
  );
}

export const useShowSecret = () => useContext(SecretCtx);

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
