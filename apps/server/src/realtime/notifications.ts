/**
 * Notification centre: persisted alerts (UTM conformance, manned traffic, separation between
 * own drones, drone faults, swarm operations) pushed to the organisation's live viewers and to
 * webhooks. Live conditions ("inside a restricted area") are resolved when they end. Read state
 * is a per-user cursor ("read until").
 */
import type { NotificationCategory, NotificationDto, NotificationLevel, NotificationListDto } from '@athena-sky/shared';
import type { Db } from '../db/database';
import { parseJson } from '../db/database';
import type { WebhookDispatcher } from '../integrations/webhooks';
import { nowIso, uuid } from '../lib/util';
import type { Hub } from './hub';

export interface NewNotification {
  level: NotificationLevel;
  category: NotificationCategory;
  code: string;
  droneId?: string | null;
  title: string;
  message: string;
  data?: Record<string, unknown> | null;
}

/** Categories forwarded to the `utm.alert` webhook. */
const UTM_CATEGORIES = new Set<NotificationCategory>(['airspace', 'traffic', 'separation', 'altitude']);
const RETENTION_DAYS = 90;
/** UTM alerts are compliance evidence: kept as long as reports can look back (2 years). */
const UTM_RETENTION_DAYS = 731;

const SELECT = 'SELECT n.*, d.name AS drone_name FROM notifications n LEFT JOIN drones d ON d.id = n.drone_id';

function dto(r: any): NotificationDto {
  return {
    id: r.id,
    createdAt: r.created_at,
    level: r.level,
    category: r.category,
    code: r.code,
    droneId: r.drone_id,
    droneName: r.drone_name ?? null,
    title: r.title,
    message: r.message,
    data: parseJson(r.data, null),
    resolvedAt: r.resolved_at,
  };
}

export class NotificationService {
  private readonly pruneTimer: ReturnType<typeof setInterval>;

  constructor(private readonly deps: { db: Db; hub: Hub; webhooks: WebhookDispatcher }) {
    this.prune();
    this.pruneTimer = setInterval(() => this.prune(), 6 * 3_600_000);
    this.pruneTimer.unref?.();
  }

  create(orgId: string, n: NewNotification): NotificationDto {
    const id = uuid();
    this.deps.db.run(
      'INSERT INTO notifications (id, org_id, created_at, level, category, code, drone_id, title, message, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      orgId,
      nowIso(),
      n.level,
      n.category,
      n.code.slice(0, 64),
      n.droneId ?? null,
      n.title.slice(0, 200),
      n.message.slice(0, 1000),
      n.data ? JSON.stringify(n.data) : null,
    );
    const out = this.get(orgId, id)!;
    this.deps.hub.broadcast(orgId, { type: 'notification', notification: out });
    if (UTM_CATEGORIES.has(n.category) && n.level !== 'info') this.deps.webhooks.emit(orgId, 'utm.alert', { notification: out });
    return out;
  }

  /** Marks a live condition as ended and pushes the update. */
  resolve(orgId: string, id: string): NotificationDto | null {
    const r = this.deps.db.run('UPDATE notifications SET resolved_at = ? WHERE id = ? AND org_id = ? AND resolved_at IS NULL', nowIso(), id, orgId);
    if (!r.changes) return null;
    const out = this.get(orgId, id);
    if (out) this.deps.hub.broadcast(orgId, { type: 'notification', notification: out });
    return out;
  }

  get(orgId: string, id: string): NotificationDto | null {
    const r = this.deps.db.get(`${SELECT} WHERE n.id = ? AND n.org_id = ?`, id, orgId);
    return r ? dto(r) : null;
  }

  private readUntil(orgId: string, userId: string): string | null {
    return this.deps.db.get<{ read_until: string }>('SELECT read_until FROM notification_reads WHERE org_id = ? AND user_id = ?', orgId, userId)?.read_until ?? null;
  }

  list(orgId: string, userId: string, opts: { limit?: number; before?: string | null; active?: boolean } = {}): NotificationListDto {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const rows = this.deps.db.all(
      `${SELECT} WHERE n.org_id = ? AND (? IS NULL OR n.created_at < ?) AND (? = 0 OR n.resolved_at IS NULL) ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
      orgId,
      opts.before ?? null,
      opts.before ?? null,
      opts.active ? 1 : 0,
      limit,
    );
    const readUntil = this.readUntil(orgId, userId);
    const unread = this.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notifications WHERE org_id = ? AND created_at > ?', orgId, readUntil ?? '')!.n;
    return { items: rows.map(dto), unread, readUntil };
  }

  markRead(orgId: string, userId: string, until: string = nowIso()): string {
    // The cursor only moves forward.
    const cur = this.readUntil(orgId, userId);
    const next = cur && cur > until ? cur : until;
    this.deps.db.run(
      'INSERT INTO notification_reads (org_id, user_id, read_until) VALUES (?, ?, ?) ON CONFLICT (org_id, user_id) DO UPDATE SET read_until = excluded.read_until',
      orgId,
      userId,
      next,
    );
    return next;
  }

  prune(): void {
    const before = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    const utm = [...UTM_CATEGORIES];
    this.deps.db.run(`DELETE FROM notifications WHERE created_at < ? AND category NOT IN (${utm.map(() => '?').join(', ')})`, before(RETENTION_DAYS), ...utm);
    this.deps.db.run(`DELETE FROM notifications WHERE created_at < ? AND category IN (${utm.map(() => '?').join(', ')})`, before(UTM_RETENTION_DAYS), ...utm);
  }

  stop(): void {
    clearInterval(this.pruneTimer);
  }
}
