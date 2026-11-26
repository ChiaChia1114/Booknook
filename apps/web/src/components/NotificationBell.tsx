/**
 * Notification centre in the top bar: unread count, the latest notifications (UTM conformance,
 * manned traffic, separation, drone faults, swarm operations) and "mark all read". New
 * warnings and critical alerts pushed over the live connection also appear as toasts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, BellOff, CheckCheck } from 'lucide-react';
import type { NotificationDto, NotificationListDto } from '@athena-sky/shared';
import { api, errorMessage } from '../api/client';
import { useOrgId } from '../state/auth';
import { useLive } from '../state/live';
import { AsyncButton, anyModalOpen, timeAgo, useToast } from './ui';

const CATEGORY_LABEL: Record<NotificationDto['category'], string> = {
  airspace: 'Airspace',
  traffic: 'Traffic',
  separation: 'Separation',
  altitude: 'Altitude',
  drone: 'Drone',
  swarm: 'Swarm',
  maintenance: 'Maintenance',
};

export function NotificationBell() {
  const orgId = useOrgId();
  const { live } = useLive();
  const toast = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<NotificationListDto | null>(null);
  // Why the notifications could not be loaded (the panel says so – never "No notifications.").
  const [loadError, setLoadError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  // Only the latest read counts, and only for the organisation selected now: an answer overtaken
  // by a later read – or about the organisation selected before, answering late – is dropped.
  const reads = useRef(0);
  const selectedOrg = useRef(orgId);
  selectedOrg.current = orgId;
  const load = useCallback(() => {
    // E.g. "Mark all read" in the organisation selected before, finishing after the switch.
    if (!orgId || selectedOrg.current !== orgId) return;
    const read = ++reads.current;
    const current = () => read === reads.current && selectedOrg.current === orgId;
    api<NotificationListDto>(`/api/v2/organisations/${orgId}/notifications?limit=30`).then(
      (l) => {
        if (!current()) return;
        setList(l);
        setLoadError(null);
      },
      (err) => {
        if (current()) setLoadError(errorMessage(err));
      },
    );
  }, [orgId]);
  useEffect(() => {
    // Another organisation: none of the previous one's notifications.
    setList(null);
    setLoadError(null);
    load();
  }, [load]);

  // Pushed notifications: toast the new ones, then refresh the list and unread count.
  const seen = useRef(new Set<string>());
  const pushedKey = live.notifications.map((n) => `${n.id}:${n.resolvedAt ?? ''}`).join('|');
  useEffect(() => {
    if (!pushedKey) return;
    for (const n of live.notifications) {
      if (seen.current.has(n.id)) continue;
      seen.current.add(n.id);
      if (n.level !== 'info' && !n.resolvedAt) toast(`${n.title} – ${n.message}`, n.level === 'critical' ? 'error' : 'info');
    }
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushedKey]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      // A dialog over the page has the keys.
      if (e.key !== 'Escape' || anyModalOpen()) return;
      const inside = !!box.current?.contains(document.activeElement);
      setOpen(false);
      // The focus was in the panel: it goes back to the bell (not lost with the panel).
      if (inside) button.current?.focus();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  // A failure is shown by the button.
  const markAll = async () => {
    await api(`/api/v2/organisations/${orgId}/notifications/read`, { body: {} });
    load();
  };
  const unread = list?.unread ?? 0;
  const isUnread = (n: NotificationDto) => !list?.readUntil || n.createdAt > list.readUntil;

  return (
    <div className="bell" ref={box}>
      <button
        ref={button}
        className="top-icon"
        aria-label={!list && loadError ? 'Notifications (could not be loaded)' : `Notifications (${unread} unread)`}
        title={!list && loadError ? `Notifications could not be loaded: ${loadError}` : 'Notifications'}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="notification-bell"
      >
        <Bell aria-hidden="true" />
        {unread > 0 && <span className="bell-count">{unread > 99 ? '99+' : unread}</span>}
        {!list && loadError && <span className="bell-count">!</span>}
      </button>
      {open && (
        <div className="bell-panel" role="dialog" aria-label="Notifications" data-testid="notification-panel">
          <div className="row" style={{ justifyContent: 'space-between', padding: '10px 12px 10px 16px' }}>
            <b>Notifications</b>
            <AsyncButton className="btn small ghost" onClick={markAll} disabled={unread === 0}>
              <CheckCheck /> Mark all read
            </AsyncButton>
          </div>
          <div className="bell-list">
            {loadError && (
              <div className="error-box" role="alert" style={{ margin: '0 12px 8px' }}>
                {list ? `The notifications could not be refreshed: ${loadError}` : `The notifications could not be loaded: ${loadError}`}
              </div>
            )}
            {list && list.items.length === 0 && (
              <div className="empty small">
                <BellOff />
                No notifications.
              </div>
            )}
            {(list?.items ?? []).map((n) => (
              <button
                key={n.id}
                className={`bell-item ${n.level}${isUnread(n) ? ' unread' : ''}`}
                onClick={() => {
                  setOpen(false);
                  if (n.droneId) navigate(`/live?drone=${n.droneId}`);
                }}
              >
                <div className="row" style={{ justifyContent: 'space-between', gap: 6 }}>
                  <b className="truncate">{n.title}</b>
                  <span className="muted small" style={{ flex: 'none' }}>
                    {timeAgo(n.createdAt)}
                  </span>
                </div>
                <div className="small">{n.message}</div>
                <div className="row small" style={{ gap: 6, marginTop: 4 }}>
                  <span className={`badge${n.level === 'critical' ? ' danger' : n.level === 'warning' ? ' warn' : ''}`}>{CATEGORY_LABEL[n.category]}</span>
                  {n.droneName && <span className="muted">{n.droneName}</span>}
                  {n.resolvedAt && <span className="badge ok">ended</span>}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
