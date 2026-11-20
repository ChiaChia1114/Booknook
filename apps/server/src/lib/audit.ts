import type { Db } from '../db/database';
import { nowIso, uuid } from './util';

/** Appends an entry to the organisation's audit trail (commands, configuration changes, decisions). */
export function audit(
  db: Db,
  orgId: string,
  userId: string | null,
  action: string,
  target: string | null,
  details: Record<string, unknown> = {},
): void {
  db.run(
    'INSERT INTO audit_log (id, org_id, user_id, action, target, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    uuid(),
    orgId,
    userId,
    action,
    target,
    JSON.stringify(details),
    nowIso(),
  );
}
