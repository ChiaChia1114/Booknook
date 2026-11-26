import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, ChevronUp, Inbox, X, type LucideIcon } from 'lucide-react';
import { formatDistance, formatDuration, VISIBLE_NAME_PATTERN } from '@athena-sky/shared';
import { errorMessage } from '../api/client';

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

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

// The button whose action runs while it has the focus. Disabled meanwhile, it loses the focus (to
// the page): a dialog its action opens takes it for the button that opened it, and the dialog the
// button is in leaves it to the button (it comes back to it when the action is done).
let busyFocus: HTMLButtonElement | null = null;

const TEXT_INPUTS = new Set(['', 'text', 'email', 'url', 'search', 'tel', 'password', 'number']);
const isEmptyField = (el: HTMLElement) => (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && TEXT_INPUTS.has(el.type))) && !(el as HTMLInputElement).value;

/**
 * Where the focus goes from a button that is disabled when its action is done (e.g. "Add fleet"
 * with its name field emptied, "Mark all read" with nothing left to read): the empty field of its
 * form (the one to fill in next), else the control nearest before it, else the first one after it
 * – looked for in its row first, then in ever wider parts of the page, never outside its dialog.
 */
export function focusNear(el: HTMLElement): HTMLElement | null {
  for (let scope = el.parentElement; scope && scope !== document.body; scope = scope.parentElement) {
    const items = tabbables(scope).filter((x) => x !== el);
    const before = items.filter((x) => x.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    const found = items.find(isEmptyField) ?? before[before.length - 1] ?? items[0];
    if (found) return found;
    if (scope.getAttribute('role') === 'dialog') return null;
  }
  return null;
}

/**
 * Hands the focus of a button removed while it has it (e.g. "Return all" once the drones return, a
 * list's row deleted, "Upload" replaced by the operation's buttons) on, in its part of the page –
 * its section, form, panel or dialog, else (no control left there, e.g. a list's last row deleted)
 * the part around that, up to the page: to the controls that replaced it (the first of them), else
 * the first one after where it was, else the nearest one before it. The controls are those on the
 * page once it has changed. A control that waits for the server (busy, disabled meanwhile) where
 * the focus would go takes it once it can (for a while); one disabled for another reason is passed
 * over. Nothing is done when the focus went elsewhere meanwhile, or when that part of the page is
 * gone too (a closed dialog gives the focus back itself; another page). It never leaves the
 * button's dialog.
 */
function handOffFocus(el: HTMLElement): void {
  // Each part around the button, innermost first, with the controls it had: the button's place
  // among them is found again once the page has changed, and those added since replaced it.
  const parts: { part: HTMLElement; known: Set<Element>; before: HTMLElement[] }[] = [];
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    if (!p.matches('[role="dialog"], section, form, .console-panel, .content')) continue;
    const all = [...p.querySelectorAll<HTMLElement>(FOCUSABLE)];
    parts.push({ part: p, known: new Set(all), before: all.filter((x) => x !== el && x.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) });
    if (p.matches('[role="dialog"], .content')) break;
  }
  // A part's controls now (disabled ones too), in the order they take the focus.
  const inOrder = ({ part, known, before }: (typeof parts)[number]): HTMLElement[] => {
    const now = tabbables(part, true);
    const added = now.filter((x) => !known.has(x));
    const kept = now.filter((x) => known.has(x));
    const anchor = before.findLast((x) => x.isConnected && part.contains(x));
    if (!anchor) return [...added, ...kept];
    const after = kept.filter((x) => anchor.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING);
    const earlier = kept.filter((x) => !(anchor.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING)).reverse();
    return [...added, ...after, ...earlier];
  };
  const until = performance.now() + 3000;
  const attempt = () => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const shown = parts.filter((x) => x.part.isConnected);
    if (!shown.length) return;
    const waited = performance.now() >= until;
    for (const at of shown) {
      for (const x of inOrder(at)) {
        if (!x.matches(':disabled')) {
          if (!anyModalOpen() || topModalHas(x)) x.focus({ preventScroll: true });
          return;
        }
        if (x.getAttribute('aria-busy') === 'true' && !waited) {
          requestAnimationFrame(attempt);
          return;
        }
      }
    }
    if (!waited) requestAnimationFrame(attempt);
  };
  queueMicrotask(attempt);
}

/**
 * The focus a button loses while it waits for the server (disabled meanwhile) comes back to it
 * when its action is done – unless it went somewhere meanwhile (a dialog the action opened gives
 * it back when it closes) or another button was pressed since. Disabled then, the control beside
 * it takes it (`focusNear`); removed, the control next to where it was (`handOffFocus`). Returns
 * what to call when the button is pressed.
 */
function useFocusBack(self: RefObject<HTMLButtonElement | null>, busy: boolean): (button: HTMLButtonElement) => void {
  // Whether it had the focus when its running action started.
  const hadFocus = useRef(false);
  useLayoutEffect(() => {
    if (busy || !hadFocus.current) return;
    hadFocus.current = false;
    const el = self.current;
    // Another button pressed since (its action under way, or one that did not start): the focus
    // comes back to that one.
    if (!el || busyFocus !== el) return;
    busyFocus = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const target = el.disabled ? focusNear(el) : el;
    if (target && (!anyModalOpen() || topModalHas(target))) target.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);
  useLayoutEffect(() => {
    const el = self.current;
    return () => {
      if (!el) return;
      const active = document.activeElement;
      const lost = hadFocus.current && busyFocus === el && (!active || active === document.body);
      if (active !== el && !lost) return;
      if (busyFocus === el) busyFocus = null;
      handOffFocus(el);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (button) => {
    if (busy) return;
    hadFocus.current = document.activeElement === button;
    if (hadFocus.current) busyFocus = button;
  };
}

/**
 * A button whose action waits for the server (creating, saving, deleting): disabled while the
 * action runs, so a double click sends one request. An action that fails without saying so
 * itself (e.g. a zone a colleague deleted meanwhile) shows its error. The focus it loses while
 * disabled comes back to it when the action is done (see `useFocusBack`).
 */
export function AsyncButton({ onClick, disabled, children, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & { onClick(e: ReactMouseEvent<HTMLButtonElement>): unknown }) {
  const { busy, run } = useAction();
  const toast = useToast();
  const self = useRef<HTMLButtonElement>(null);
  const pressed = useFocusBack(self, busy);
  const act = async (e: ReactMouseEvent<HTMLButtonElement>) => {
    try {
      await onClick(e);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  return (
    <button
      {...rest}
      ref={self}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      onClick={(e) => {
        pressed(e.currentTarget);
        void run(() => act(e));
      }}
    >
      {children}
    </button>
  );
}

/**
 * A button whose action – run by its form, dialog or panel – waits for the server (`busy`
 * meanwhile, e.g. a form's submit button): disabled meanwhile, and the focus it loses comes back
 * to it when the action is done, as with AsyncButton.
 */
export function BusyButton({ busy, disabled, onClick, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { busy: boolean }) {
  const self = useRef<HTMLButtonElement>(null);
  const pressed = useFocusBack(self, busy);
  return (
    <button
      {...rest}
      ref={self}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      onClick={(e) => {
        pressed(e.currentTarget);
        onClick?.(e);
      }}
    />
  );
}

// The dialogs open at once, the latest on top (e.g. a one-time secret over another dialog): only
// the top one answers Escape and keeps the keyboard.
const openModals: { id: number; box: HTMLElement | null }[] = [];
let lastModalId = 0;
const topModal = () => openModals[openModals.length - 1];
const topModalHas = (el: Element) => !!topModal()?.box?.contains(el);

/** Whether a dialog is open: it has the keyboard (the page behind does not act on keys meanwhile). */
export const anyModalOpen = () => openModals.length > 0;

const FOCUSABLE = 'a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable]:not([contenteditable="false"])';

/** The elements of `root` that Tab goes to, in order (with `withDisabled`, also those disabled meanwhile). */
export function tabbables(root: HTMLElement, withDisabled = false): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
    if (el.tabIndex < 0 || (!withDisabled && el.matches(':disabled')) || el.closest('[inert]')) return false;
    if (el instanceof HTMLInputElement && el.type === 'hidden') return false;
    if (el.getClientRects().length === 0 || getComputedStyle(el).visibility === 'hidden') return false;
    // Of radio buttons, Tab goes to the checked one of their group (to each while none is checked).
    if (el instanceof HTMLInputElement && el.type === 'radio' && el.name && !el.checked)
      return ![...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')].some((r) => r.name === el.name && r.checked);
    return true;
  });
}

/**
 * A dialog. `dismissible` false: closed only by its own buttons – not by Escape or a click beside
 * it (a one-time secret must not be lost by a stray key).
 *
 * The dialog has the keyboard while it is on top: it takes the focus when it opens (unless one of
 * its fields took it) and when its content changes without it (a form replaced by its result), Tab
 * and Shift+Tab go round its own controls – never to the page behind – and closed, it gives the
 * focus back to where it was (the button that opened it, even one its running action disabled).
 */
export function Modal({
  title,
  onClose,
  children,
  wide,
  actions,
  dismissible = true,
  focusKey,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
  wide?: boolean;
  actions?: ReactNode;
  dismissible?: boolean;
  /** Changed when the dialog shows something new in place of what it showed (the next one-time key): it takes the focus again. */
  focusKey?: string | number;
}) {
  const id = useRef(0);
  if (!id.current) id.current = ++lastModalId;
  const box = useRef<HTMLDivElement>(null);
  const onTop = () => topModal()?.id === id.current;
  // Where the focus was when the dialog opened – on the page, when the button that opened it is
  // disabled while its action runs: then that button.
  const [opener] = useState(() => {
    if (typeof document === 'undefined') return null;
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return busyFocus?.isConnected ? busyFocus : null;
    return active;
  });
  useLayoutEffect(() => {
    // On top first – then the focus moves in (a dialog beneath no longer keeps it).
    const me = { id: id.current, box: box.current };
    openModals.push(me);
    const el = box.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    return () => {
      const at = openModals.indexOf(me);
      if (at >= 0) openModals.splice(at, 1);
    };
  }, []);
  useLayoutEffect(() => {
    // The content changed and took the focus with it (e.g. the form replaced by its result): it
    // comes back to the dialog – unless a button of the dialog lost it while it waits for the
    // server (the button takes it back when done).
    const el = box.current;
    const active = document.activeElement;
    const waiting = !!busyFocus?.isConnected && !!el?.contains(busyFocus);
    if (el && onTop() && (!active || active === document.body) && !waiting) el.focus({ preventScroll: true });
  });
  // Something new shown in its place: the focus leaves the button that dismissed what was shown
  // before (pressed again, it would dismiss the new one unseen).
  const shownKey = useRef(focusKey);
  useLayoutEffect(() => {
    if (shownKey.current === focusKey) return;
    shownKey.current = focusKey;
    const el = box.current;
    if (el && onTop()) el.focus({ preventScroll: true });
  }, [focusKey]);
  useEffect(
    () => () => {
      // Closed: the focus goes back where it was – unless it is elsewhere already (another
      // dialog, another page's heading) or that place is gone.
      const active = document.activeElement;
      if ((!active || active === document.body) && opener && opener !== document.body && opener.isConnected) opener.focus({ preventScroll: true });
    },
    [opener],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!onTop()) return;
      if (e.key === 'Escape') {
        if (dismissible) onClose();
        return;
      }
      const el = box.current;
      if (e.key !== 'Tab' || !el) return;
      const items = tabbables(el);
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!first || !last) {
        e.preventDefault();
        el.focus({ preventScroll: true });
      } else if (!el.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey ? active === first || active === el : active === last) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    // Whatever else would put the focus behind the dialog (a click is caught by the backdrop)
    // brings it back to the dialog.
    const onFocusIn = (e: FocusEvent) => {
      const el = box.current;
      if (el && onTop() && e.target instanceof Node && !el.contains(e.target)) el.focus({ preventScroll: true });
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [onClose, dismissible]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        // Beside a dialog that only its buttons close, a click does not take the focus out of it.
        if (dismissible) onClose();
        else e.preventDefault();
      }}
    >
      <div ref={box} className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="card-head">
          <h2>{title}</h2>
          <button
            className="icon-btn"
            style={{ background: 'transparent', borderColor: 'transparent' }}
            // The second click of a double click is not a second close (of what took its place).
            onClick={(e) => e.detail < 2 && onClose()}
            aria-label="Close"
          >
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
let lastNoticeId = 0;

/**
 * One-time secrets (a drone's link key, an API token, a webhook's signing secret) whose dialog or
 * page was gone when the server answered – closed meanwhile, or another organisation chosen: shown
 * here, over any page, one after the other, each until it is dismissed – never lost: a double
 * click or a second key press on "Done" does not dismiss the next one unseen.
 */
export function SecretProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<(SecretNotice & { id: number })[]>([]);
  const show = useCallback((n: SecretNotice) => setNotices((all) => [...all, { ...n, id: ++lastNoticeId }]), []);
  const current = notices[0];
  // Only the notice shown is dismissed (never the one that takes its place).
  const dismiss = (id: number) => setNotices((all) => all.filter((n) => n.id !== id));
  return (
    <SecretCtx.Provider value={show}>
      {children}
      {current && (
        <Modal
          title={current.title}
          onClose={() => dismiss(current.id)}
          dismissible={false}
          focusKey={current.id}
          actions={
            <button className="btn primary" onClick={(e) => e.detail < 2 && dismiss(current.id)}>
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
