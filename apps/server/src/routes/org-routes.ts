import type { FastifyInstance } from 'fastify';
import { Type, type Static } from '@sinclair/typebox';
import { Nullable } from '../lib/schema';
import type { AuditEntryDto, FleetDto, InvitationDto, MemberDto } from '@athena-sky/shared';
import { ROLES, ROLE_RANK, isRole, type Role } from '@athena-sky/shared';
import type { AppContext } from '../context';
import { orgAccess, requireAuth } from '../auth/auth';
import { parseJson } from '../db/database';
import { audit } from '../lib/audit';
import { randomToken, sha256Hex } from '../lib/crypto';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { clampInt, nowIso, uuid } from '../lib/util';
import { createOrganisation, getOrganisation, getOrgSettings } from '../orgs/org-service';

const OrgParams = Type.Object({ orgId: Type.String({ format: 'uuid' }) });
type OrgP = Static<typeof OrgParams>;
const RoleSchema = Type.Union(ROLES.map((r) => Type.Literal(r)));

const CreateOrgBody = Type.Object({ name: Type.String({ minLength: 1, maxLength: 100 }) });
const UpdateOrgBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  settings: Type.Optional(
    Type.Object({
      maxAltitudeM: Type.Optional(Type.Number({ minimum: 1, maximum: 10000 })),
      lowBatteryPct: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    }),
  ),
});
const InviteBody = Type.Object({ email: Type.String({ format: 'email', maxLength: 200 }), role: RoleSchema });
const UpdateMemberBody = Type.Object({
  role: Type.Optional(RoleSchema),
  pilotLicense: Type.Optional(Nullable(Type.String({ maxLength: 100 }))),
});
const FleetBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  description: Type.Optional(Type.String({ maxLength: 1000 })),
});
const FleetPatch = Type.Partial(FleetBody);

const tag = { tags: ['organisations'] };

export function registerOrgRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config, hub } = ctx;

  app.get('/api/v2/', { schema: { tags: ['meta'], summary: 'API root' } }, async () => ({
    organisations: `${config.publicUrl}/api/v2/organisations/`,
    auth: `${config.publicUrl}/api/v2/auth/me`,
    tokens: `${config.publicUrl}/api/v2/tokens/`,
    safetyMap: `${config.publicUrl}/api/v2/public/safety-map`,
    weather: `${config.publicUrl}/api/v2/weather`,
    schema: `${config.publicUrl}/api/v2/schema/`,
    docs: `${config.publicUrl}/api/v2/docs/`,
  }));

  app.get('/api/v2/organisations', { schema: { ...tag, summary: 'Organisations of the current user' } }, async (req) => {
    const auth = requireAuth(req);
    const rows = db.all<{ org_id: string; role: string }>('SELECT org_id, role FROM memberships WHERE user_id = ?', auth.user.id);
    return rows
      .filter((r) => !auth.tokenOrgId || r.org_id === auth.tokenOrgId)
      .map((r) => getOrganisation(db, r.org_id, r.role as Role))
      .filter(Boolean);
  });

  app.post<{ Body: Static<typeof CreateOrgBody> }>(
    '/api/v2/organisations',
    { schema: { ...tag, summary: 'Create an organisation (caller becomes owner)', body: CreateOrgBody } },
    async (req, reply) => {
      const auth = requireAuth(req);
      if (auth.via === 'token' && auth.tokenOrgId) throw forbidden('Organisation-scoped tokens cannot create organisations');
      const id = createOrganisation(db, req.body.name.trim(), auth.user.id);
      reply.code(201);
      return getOrganisation(db, id, 'owner');
    },
  );

  app.get<{ Params: OrgP }>('/api/v2/organisations/:orgId', { schema: { ...tag, params: OrgParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId);
    return getOrganisation(db, a.orgId, a.role);
  });

  app.patch<{ Params: OrgP; Body: Static<typeof UpdateOrgBody> }>(
    '/api/v2/organisations/:orgId',
    { schema: { ...tag, params: OrgParams, body: UpdateOrgBody } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId, 'org.manage');
      if (req.body.name) db.run('UPDATE organisations SET name = ? WHERE id = ?', req.body.name.trim(), a.orgId);
      if (req.body.settings) {
        const merged = { ...getOrgSettings(db, a.orgId), ...req.body.settings };
        db.run('UPDATE organisations SET settings = ? WHERE id = ?', JSON.stringify(merged), a.orgId);
      }
      audit(db, a.orgId, a.userId, 'organisation.update', a.orgId, req.body as Record<string, unknown>);
      return getOrganisation(db, a.orgId, a.role);
    },
  );

  app.delete<{ Params: OrgP }>('/api/v2/organisations/:orgId', { schema: { ...tag, params: OrgParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId, 'org.delete');
    db.run('DELETE FROM organisations WHERE id = ?', a.orgId);
    hub.closeOrg(a.orgId);
    return { ok: true };
  });

  // --- Members -----------------------------------------------------------------------------

  const memberDto = (r: { user_id: string; email: string; name: string; role: string; pilot_license: string | null; created_at: string }, onlineIds: Set<string>): MemberDto => ({
    userId: r.user_id,
    email: r.email,
    name: r.name,
    role: r.role as Role,
    pilotLicense: r.pilot_license,
    joinedAt: r.created_at,
    online: onlineIds.has(r.user_id),
  });

  const listMembers = (orgId: string): MemberDto[] => {
    const online = new Set(hub.onlineUsers(orgId).map((u) => u.userId));
    return db
      .all<any>(
        `SELECT m.user_id, u.email, u.name, m.role, m.pilot_license, m.created_at
           FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.name`,
        orgId,
      )
      .map((r) => memberDto(r, online));
  };

  app.get<{ Params: OrgP }>('/api/v2/organisations/:orgId/members', { schema: { ...tag, params: OrgParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId);
    return listMembers(a.orgId);
  });

  app.post<{ Params: OrgP; Body: Static<typeof InviteBody> }>(
    '/api/v2/organisations/:orgId/members',
    { schema: { ...tag, summary: 'Add an existing user or e-mail an invitation', params: OrgParams, body: InviteBody } },
    async (req, reply) => {
      const a = orgAccess(db, req, req.params.orgId, 'members.manage');
      const { email, role } = req.body;
      if (role === 'owner' && a.role !== 'owner') throw forbidden('Only owners can grant the owner role');
      const user = db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', email);
      if (user) {
        if (db.get('SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ?', a.orgId, user.id)) throw conflict('User is already a member');
        db.run('INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)', a.orgId, user.id, role, nowIso());
        audit(db, a.orgId, a.userId, 'member.add', user.id, { email, role });
        reply.code(201);
        return { member: listMembers(a.orgId).find((m) => m.userId === user.id), invitation: null };
      }
      const token = randomToken('', 32);
      const id = uuid();
      const expires = new Date(Date.now() + 14 * 86_400_000).toISOString();
      db.run(
        'INSERT INTO invitations (id, org_id, email, role, token_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        a.orgId,
        email,
        role,
        sha256Hex(token),
        a.userId,
        nowIso(),
        expires,
      );
      const orgName = db.get<{ name: string }>('SELECT name FROM organisations WHERE id = ?', a.orgId)!.name;
      const acceptUrl = `${config.publicUrl}/signup?invite=${encodeURIComponent(token)}`;
      await ctx.mailer.send(
        email,
        `You have been invited to ${orgName} on Athena-sky`,
        `${a.userName} invited you to join "${orgName}" as ${role}.\n\nCreate your account here (link valid for 14 days):\n${acceptUrl}\n\nAlready have an account? Log in and open the link to accept.`,
      );
      audit(db, a.orgId, a.userId, 'member.invite', email, { role });
      reply.code(201);
      const invitation: InvitationDto = { id, email, role, createdAt: nowIso(), expiresAt: expires, acceptUrl };
      return { member: null, invitation };
    },
  );

  const ownerCount = (orgId: string): number =>
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner'", orgId)!.n;

  app.patch<{ Params: OrgP & { userId: string }; Body: Static<typeof UpdateMemberBody> }>(
    '/api/v2/organisations/:orgId/members/:userId',
    { schema: { ...tag, body: UpdateMemberBody } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId, 'members.manage');
      const target = db.get<{ role: string }>('SELECT role FROM memberships WHERE org_id = ? AND user_id = ?', a.orgId, req.params.userId);
      if (!target || !isRole(target.role)) throw notFound('Member');
      if (ROLE_RANK[target.role] > ROLE_RANK[a.role]) throw forbidden('You cannot modify a member with a higher role');
      const newRole = req.body.role;
      if (newRole) {
        if (newRole === 'owner' && a.role !== 'owner') throw forbidden('Only owners can grant the owner role');
        if (target.role === 'owner' && newRole !== 'owner' && ownerCount(a.orgId) <= 1) throw badRequest('An organisation needs at least one owner');
        db.run('UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?', newRole, a.orgId, req.params.userId);
        hub.updateUserRole(a.orgId, req.params.userId, newRole);
      }
      if (req.body.pilotLicense !== undefined) {
        db.run('UPDATE memberships SET pilot_license = ? WHERE org_id = ? AND user_id = ?', req.body.pilotLicense, a.orgId, req.params.userId);
      }
      audit(db, a.orgId, a.userId, 'member.update', req.params.userId, req.body as Record<string, unknown>);
      return listMembers(a.orgId).find((m) => m.userId === req.params.userId);
    },
  );

  app.delete<{ Params: OrgP & { userId: string } }>('/api/v2/organisations/:orgId/members/:userId', { schema: tag }, async (req) => {
    const self = requireAuth(req).user.id === req.params.userId;
    const a = orgAccess(db, req, req.params.orgId, self ? undefined : 'members.manage');
    const target = db.get<{ role: string }>('SELECT role FROM memberships WHERE org_id = ? AND user_id = ?', a.orgId, req.params.userId);
    if (!target || !isRole(target.role)) throw notFound('Member');
    if (!self && ROLE_RANK[target.role] > ROLE_RANK[a.role]) throw forbidden('You cannot remove a member with a higher role');
    if (target.role === 'owner' && ownerCount(a.orgId) <= 1) throw badRequest('An organisation needs at least one owner');
    db.run('DELETE FROM memberships WHERE org_id = ? AND user_id = ?', a.orgId, req.params.userId);
    hub.revokeUser(a.orgId, req.params.userId);
    audit(db, a.orgId, a.userId, self ? 'member.leave' : 'member.remove', req.params.userId);
    return { ok: true };
  });

  app.get<{ Params: OrgP }>('/api/v2/organisations/:orgId/invitations', { schema: { ...tag, params: OrgParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId, 'members.manage');
    return db
      .all<any>(
        'SELECT id, email, role, created_at, expires_at FROM invitations WHERE org_id = ? AND accepted_at IS NULL AND expires_at > ? ORDER BY created_at DESC',
        a.orgId,
        nowIso(),
      )
      .map((r): InvitationDto => ({ id: r.id, email: r.email, role: r.role, createdAt: r.created_at, expiresAt: r.expires_at }));
  });

  app.delete<{ Params: OrgP & { id: string } }>('/api/v2/organisations/:orgId/invitations/:id', { schema: tag }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId, 'members.manage');
    if (db.run('DELETE FROM invitations WHERE id = ? AND org_id = ?', req.params.id, a.orgId).changes === 0) throw notFound('Invitation');
    return { ok: true };
  });

  // --- Fleets ------------------------------------------------------------------------------

  const fleetDto = (r: any): FleetDto => ({
    id: r.id,
    name: r.name,
    description: r.description,
    droneCount: r.drone_count ?? 0,
    createdAt: r.created_at,
  });
  const fleetQuery = `SELECT f.*, (SELECT COUNT(*) FROM drones d WHERE d.fleet_id = f.id) AS drone_count FROM fleets f`;

  app.get<{ Params: OrgP }>('/api/v2/organisations/:orgId/fleets', { schema: { tags: ['fleets'], params: OrgParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId);
    return db.all<any>(`${fleetQuery} WHERE f.org_id = ? ORDER BY f.name`, a.orgId).map(fleetDto);
  });

  app.post<{ Params: OrgP; Body: Static<typeof FleetBody> }>(
    '/api/v2/organisations/:orgId/fleets',
    { schema: { tags: ['fleets'], params: OrgParams, body: FleetBody } },
    async (req, reply) => {
      const a = orgAccess(db, req, req.params.orgId, 'fleet.manage');
      const id = uuid();
      db.run('INSERT INTO fleets (id, org_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)', id, a.orgId, req.body.name.trim(), req.body.description ?? '', nowIso());
      audit(db, a.orgId, a.userId, 'fleet.create', id, { name: req.body.name });
      reply.code(201);
      return fleetDto(db.get(`${fleetQuery} WHERE f.id = ?`, id));
    },
  );

  app.patch<{ Params: OrgP & { fleetId: string }; Body: Static<typeof FleetPatch> }>(
    '/api/v2/organisations/:orgId/fleets/:fleetId',
    { schema: { tags: ['fleets'], body: FleetPatch } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId, 'fleet.manage');
      const f = db.get<any>('SELECT * FROM fleets WHERE id = ? AND org_id = ?', req.params.fleetId, a.orgId);
      if (!f) throw notFound('Fleet');
      db.run('UPDATE fleets SET name = ?, description = ? WHERE id = ?', req.body.name?.trim() ?? f.name, req.body.description ?? f.description, f.id);
      return fleetDto(db.get(`${fleetQuery} WHERE f.id = ?`, f.id));
    },
  );

  app.delete<{ Params: OrgP & { fleetId: string } }>('/api/v2/organisations/:orgId/fleets/:fleetId', { schema: { tags: ['fleets'] } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId, 'fleet.manage');
    if (db.run('DELETE FROM fleets WHERE id = ? AND org_id = ?', req.params.fleetId, a.orgId).changes === 0) throw notFound('Fleet');
    audit(db, a.orgId, a.userId, 'fleet.delete', req.params.fleetId);
    return { ok: true };
  });

  // --- Who is online right now -----------------------------------------------------------------

  app.get<{ Params: OrgP }>(
    '/api/v2/organisations/:orgId/online',
    { schema: { tags: ['realtime'], summary: 'Drones and users connected right now', params: OrgParams } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      return { drones: hub.orgDroneStates(a.orgId).filter((d) => d.online), users: hub.onlineUsers(a.orgId) };
    },
  );

  // --- Audit trail ----------------------------------------------------------------------------

  app.get<{ Params: OrgP; Querystring: { limit?: string; offset?: string } }>(
    '/api/v2/organisations/:orgId/audit',
    { schema: { tags: ['organisations'], summary: 'Audit trail', params: OrgParams } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId, 'audit.view');
      const limit = clampInt(req.query.limit, 100, 1, 500);
      const offset = clampInt(req.query.offset, 0, 0, 1_000_000);
      const total = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log WHERE org_id = ?', a.orgId)!.n;
      const items = db
        .all<any>(
          `SELECT l.*, u.name AS user_name FROM audit_log l LEFT JOIN users u ON u.id = l.user_id
            WHERE l.org_id = ? ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
          a.orgId,
          limit,
          offset,
        )
        .map(
          (r): AuditEntryDto => ({
            id: r.id,
            userId: r.user_id,
            userName: r.user_name,
            action: r.action,
            target: r.target,
            details: parseJson(r.details, {}),
            createdAt: r.created_at,
          }),
        );
      return { items, total, limit, offset };
    },
  );
}
