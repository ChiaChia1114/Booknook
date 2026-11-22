import type { MeDto, OrganisationDto, OrgSettings, Role, UserDto } from '@athena-sky/shared';
import { ROLE_LABELS, can, isRole } from '@athena-sky/shared';
import type { Db } from '../db/database';
import { parseJson } from '../db/database';
import { badRequest } from '../lib/errors';
import { nowIso, uuid } from '../lib/util';

/**
 * A pilot – of a flight, or of a scheduled operation – is a member allowed to fly the
 * organisation's drones.
 */
export function assertPilot(db: Db, orgId: string, userId: string): void {
  const m = db.get<{ role: Role; name: string }>('SELECT m.role, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.user_id = ?', orgId, userId);
  if (!m) throw badRequest('Pilot is not a member of this organisation');
  if (!can(m.role, 'drone.control')) throw badRequest(`${m.name} cannot fly drones in this organisation (${ROLE_LABELS[m.role]})`);
}

export const DEFAULT_ORG_SETTINGS: OrgSettings = { maxAltitudeM: 120, lowBatteryPct: 25 };

export function orgSettings(raw: unknown): OrgSettings {
  const s = parseJson<Partial<OrgSettings>>(raw, {});
  return {
    maxAltitudeM: typeof s.maxAltitudeM === 'number' && s.maxAltitudeM > 0 ? s.maxAltitudeM : DEFAULT_ORG_SETTINGS.maxAltitudeM,
    lowBatteryPct: typeof s.lowBatteryPct === 'number' && s.lowBatteryPct >= 0 ? s.lowBatteryPct : DEFAULT_ORG_SETTINGS.lowBatteryPct,
  };
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  created_at: string;
}

export function userDto(r: UserRow): UserDto {
  return { id: r.id, email: r.email, name: r.name, createdAt: r.created_at };
}

export function buildMe(db: Db, userId: string): MeDto {
  const user = db.get<UserRow>('SELECT id, email, name, created_at FROM users WHERE id = ?', userId);
  if (!user) throw new Error('user vanished');
  const memberships = db
    .all<{ org_id: string; name: string; role: string }>(
      `SELECT m.org_id, o.name, m.role FROM memberships m JOIN organisations o ON o.id = m.org_id
        WHERE m.user_id = ? ORDER BY o.created_at`,
      userId,
    )
    .filter((m) => isRole(m.role))
    .map((m) => ({ orgId: m.org_id, orgName: m.name, role: m.role as Role }));
  return { user: userDto(user), memberships };
}

export function createOrganisation(db: Db, name: string, ownerId: string): string {
  const id = uuid();
  const now = nowIso();
  db.tx(() => {
    db.run('INSERT INTO organisations (id, name, settings, created_at) VALUES (?, ?, ?, ?)', id, name, JSON.stringify(DEFAULT_ORG_SETTINGS), now);
    db.run('INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)', id, ownerId, 'owner', now);
  });
  return id;
}

export function getOrganisation(db: Db, orgId: string, role: Role): OrganisationDto | null {
  const r = db.get<{ id: string; name: string; settings: string; created_at: string }>(
    'SELECT id, name, settings, created_at FROM organisations WHERE id = ?',
    orgId,
  );
  if (!r) return null;
  return { id: r.id, name: r.name, createdAt: r.created_at, role, settings: orgSettings(r.settings) };
}

export function getOrgSettings(db: Db, orgId: string): OrgSettings {
  return orgSettings(db.get<{ settings: string }>('SELECT settings FROM organisations WHERE id = ?', orgId)?.settings);
}
