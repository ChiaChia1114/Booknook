import type { FastifyInstance } from 'fastify';
import { Type, type Static } from '@sinclair/typebox';
import { Nullable } from '../lib/schema';
import type { AuditEntryDto, FleetDto, InvitationDto, MemberDto } from '@athena-sky/shared';
import { ROLES, canManageMember, grantableRoles, isRole, type Role } from '@athena-sky/shared';
import type { AppContext } from '../context';
import { orgAccess, requireAuth } from '../auth/auth';
import { parseJson } from '../db/database';
import { audit } from '../lib/audit';
import { randomToken, sha256Hex } from '../lib/crypto';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { clearFlightRows, dronesInFlight, flightsOf, storedFilesOf } from '../flights/cleanup';
import { nowIso, uuid } from '../lib/util';
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
const LOCATE_TABLES = { drones: 'drones', flights: 'flights', missions: 'missions' } as const;
const LocateParams = Type.Object({
  kind: Type.Union([Type.Literal('drones'), Type.Literal('flights'), Type.Literal('missions')]),
  id: Type.String({ format: 'uuid' }),
});

/** A page of the audit trail: a malformed one is refused (400), not corrected silently. */
const AuditQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
});

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

  // A link to a drone, flight or mission (a bookmark, a shared link) is opened in the organisation
  // that holds it: asked once, among the caller's organisations (those its API token may reach) –
  // never by asking each organisation for an item most of them do not have.
  app.get<{ Params: Static<typeof LocateParams> }>(
    '/api/v2/locate/:kind/:id',
    {
      schema: {
        ...tag,
        summary: "Which of the caller's organisations holds a drone, flight or mission (orgId null: none of them)",
        params: LocateParams,
      },
    },
    async (req) => {
      const auth = requireAuth(req);
      const table = LOCATE_TABLES[req.params.kind];
      const row = db.get<{ org_id: string }>(
        `SELECT t.org_id FROM ${table} t JOIN memberships m ON m.org_id = t.org_id AND m.user_id = ? WHERE t.id = ?`,
        auth.user.id,
        req.params.id,
      );
      return { orgId: row && (!auth.tokenOrgId || row.org_id === auth.tokenOrgId) ? row.org_id : null };
    },
  );

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
        ctx.utm.invalidate(a.orgId);
      }
      audit(db, a.orgId, a.userId, 'organisation.update', a.orgId, req.body as Record<string, unknown>);
      return getOrganisation(db, a.orgId, a.role);
    },
  );

  app.delete<{ Params: OrgP }>(
    '/api/v2/organisations/:orgId',
    { schema: { ...tag, summary: 'Delete the organisation with all its data and files (not while one of its drones is flying)', params: OrgParams } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId, 'org.delete');
      const noneFlying = () => {
        const flying = dronesInFlight(db, { orgId: a.orgId });
        if (flying.length) {
          throw new HttpError(
            409,
            'drones_in_flight',
            `${flying.join(', ')} ${flying.length > 1 ? 'are' : 'is'} flying – delete the organisation once ${flying.length > 1 ? 'they have' : 'it has'} landed and the flights have been closed`,
          );
        }
      };
      noneFlying();
      // The samples of its flights first, a few at a time (see clearFlightRows) – then, checked
      // again, the rest at once.
      await clearFlightRows(db, flightsOf(db, { orgId: a.orgId }));
      if (!db.get('SELECT 1 FROM organisations WHERE id = ?', a.orgId)) return { ok: true };
      noneFlying();
      const drones = db.all<{ id: string }>('SELECT id FROM drones WHERE org_id = ?', a.orgId).map((r) => r.id);
      const files = storedFilesOf(db, { orgId: a.orgId });
      db.run('DELETE FROM organisations WHERE id = ?', a.orgId);
      hub.closeOrg(a.orgId, drones);
      for (const f of files) ctx.storage.remove(f);
      return { ok: true };
    },
  );

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
    { schema: { ...tag, summary: 'Invite someone by e-mail (they join after accepting)', params: OrgParams, body: InviteBody } },
    async (req, reply) => {
      const a = orgAccess(db, req, req.params.orgId, 'members.manage');
      const { email, role } = req.body;
      if (!grantableRoles(a.role).includes(role)) throw forbidden('Only owners can grant the owner role');
      // Everyone is invited – also people who already have an account: nobody is added to an
      // organisation without accepting, and the answer does not tell whether the address has
      // an account.
      const user = db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', email);
      if (user && db.get('SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ?', a.orgId, user.id)) throw conflict('User is already a member');
      const token = randomToken('', 32);
      const id = uuid();
      const expires = new Date(Date.now() + 14 * 86_400_000).toISOString();
      // A new invitation replaces any pending one for the same address (only the latest role holds).
      db.run('DELETE FROM invitations WHERE org_id = ? AND accepted_at IS NULL AND lower(email) = lower(?)', a.orgId, email);
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
      try {
        await ctx.mailer.send(
          email,
          `You have been invited to ${orgName} on Athena-sky`,
          `${a.userName} invited you to join "${orgName}" as ${role}.\n\nCreate your account here (link valid for 14 days):\n${acceptUrl}\n\nAlready have an account? Log in and open the link to accept.`,
        );
      } catch {
        // An invitation nobody received is not kept (the link would exist nowhere).
        db.run('DELETE FROM invitations WHERE id = ?', id);
        throw new HttpError(502, 'mail_failed', 'The invitation e-mail could not be sent – check the mail server settings and invite again');
      }
      audit(db, a.orgId, a.userId, 'member.invite', email, { role });
      reply.code(201);
      // The link creates the account of the invited address, so with e-mail confirmation of
      // accounts it goes to that mailbox only. Without it (no e-mail delivery) the inviter gets
      // it to pass on – anyone can then create an account for any address anyway.
      const invitation: InvitationDto = { id, email, role, createdAt: nowIso(), expiresAt: expires, ...(config.signupConfirmEmail ? {} : { acceptUrl }) };
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
      if (!canManageMember(a.role, target.role)) throw forbidden('You cannot modify a member with a higher role');
      const newRole = req.body.role;
      if (newRole) {
        if (!grantableRoles(a.role).includes(newRole)) throw forbidden('Only owners can grant the owner role');
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
    if (!self && !canManageMember(a.role, target.role)) throw forbidden('You cannot remove a member with a higher role');
    if (target.role === 'owner' && ownerCount(a.orgId) <= 1) throw badRequest('An organisation needs at least one owner');
    db.run('DELETE FROM memberships WHERE org_id = ? AND user_id = ?', a.orgId, req.params.userId);
    // Pending invitations of the removed person no longer let them back in.
    db.run('DELETE FROM invitations WHERE org_id = ? AND accepted_at IS NULL AND lower(email) = (SELECT lower(email) FROM users WHERE id = ?)', a.orgId, req.params.userId);
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

  app.get<{ Params: OrgP; Querystring: Static<typeof AuditQuery> }>(
    '/api/v2/organisations/:orgId/audit',
    { schema: { tags: ['organisations'], summary: 'Audit trail', params: OrgParams, querystring: AuditQuery } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId, 'audit.view');
      const limit = req.query.limit ?? 100;
      const offset = req.query.offset ?? 0;
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
