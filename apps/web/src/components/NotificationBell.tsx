/**
 * Notification centre in the top bar: unread count, the latest notifications (UTM conformance,
 * manned traffic, separation, drone faults, swarm operations) and "mark all read". New
 * warnings and critical alerts pushed over the live connection also appear as toasts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, BellOff, CheckCheck } from 'lucide-react';
import type { NotificationDto, NotificationListDto } from '@athena-sky/shared';
import { api } from '../api/client';
import { useOrgId } from '../state/auth';
import { useLive } from '../state/live';
import { timeAgo, useToast } from './ui';

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
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    if (!orgId) return;
    api<NotificationListDto>(`/api/v2/organisations/${orgId}/notifications?limit=30`)
      .then(setList)
      .catch(() => undefined);
  }, [orgId]);
  useEffect(() => load(), [load]);

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
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const markAll = async () => {
    await api(`/api/v2/organisations/${orgId}/notifications/read`, { body: {} }).catch(() => undefined);
    load();
  };
  const unread = list?.unread ?? 0;
  const isUnread = (n: NotificationDto) => !list?.readUntil || n.createdAt > list.readUntil;

  return (
    <div className="bell" ref={box}>
      <button className="top-icon" aria-label={`Notifications (${unread} unread)`} title="Notifications" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="notification-bell">
        <Bell aria-hidden="true" />
        {unread > 0 && <span className="bell-count">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="bell-panel" role="dialog" aria-label="Notifications" data-testid="notification-panel">
          <div className="row" style={{ justifyContent: 'space-between', padding: '10px 12px 10px 16px' }}>
            <b>Notifications</b>
            <button className="btn small ghost" onClick={markAll} disabled={unread === 0}>
              <CheckCheck /> Mark all read
            </button>
          </div>
          <div className="bell-list">
            {(list?.items ?? []).length === 0 && (
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
