import type { FastifyInstance } from 'fastify';
import { Type, type Static } from '@sinclair/typebox';
import { Nullable } from '../lib/schema';
import type { ApiTokenCreatedDto, ApiTokenDto } from '@athena-sky/shared';
import { isRole } from '@athena-sky/shared';
import type { AppContext } from '../context';
import {
  clearSessionCookies,
  createSession,
  orgAccess,
  requireAuth,
  setSessionCookies,
} from '../auth/auth';
import { hashPassword, randomToken, sha256Hex, verifyPassword } from '../lib/crypto';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors';
import { nowIso, uuid } from '../lib/util';
import { buildMe, createOrganisation } from '../orgs/org-service';

const Email = Type.String({ format: 'email', maxLength: 200 });
const Password = Type.String({ minLength: 8, maxLength: 200 });

const SignupBody = Type.Object({
  email: Email,
  password: Password,
  name: Type.String({ minLength: 1, maxLength: 100 }),
  organisationName: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  inviteToken: Type.Optional(Type.String({ minLength: 10, maxLength: 200 })),
});
const SignupConfirmBody = Type.Object({ token: Type.String({ minLength: 10, maxLength: 200 }) });
const LoginBody = Type.Object({ email: Email, password: Type.String({ minLength: 1, maxLength: 200 }) });
const ResetRequestBody = Type.Object({ email: Email });
const ResetConfirmBody = Type.Object({ token: Type.String({ minLength: 10, maxLength: 200 }), password: Password });
const ChangePasswordBody = Type.Object({ currentPassword: Type.String({ minLength: 1, maxLength: 200 }), newPassword: Password });
const ProfileBody = Type.Object({ name: Type.String({ minLength: 1, maxLength: 100 }) });
const TokenBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  orgId: Type.Optional(Nullable(Type.String({ format: 'uuid' }))),
  expiresInDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
});
const InviteAcceptBody = Type.Object({ token: Type.String({ minLength: 10, maxLength: 200 }) });

const tag = { tags: ['auth'] };

interface InvitationRow {
  id: string;
  org_id: string;
  email: string;
  role: string;
  expires_at: string;
  accepted_at: string | null;
  org_name: string;
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config } = ctx;
  const authLimit = { rateLimit: { max: config.authRateLimitPerMin, timeWindow: '1 minute' } };

  const findInvitation = (token: string): InvitationRow | undefined =>
    db.get<InvitationRow>(
      `SELECT i.id, i.org_id, i.email, i.role, i.expires_at, i.accepted_at, o.name AS org_name
         FROM invitations i JOIN organisations o ON o.id = i.org_id WHERE i.token_hash = ?`,
      sha256Hex(token),
    );

  const usableInvitation = (inv: InvitationRow | undefined): inv is InvitationRow =>
    !!inv && !inv.accepted_at && new Date(inv.expires_at).getTime() > Date.now() && isRole(inv.role);

  app.post<{ Body: Static<typeof SignupBody> }>(
    '/api/v2/auth/signup',
    {
      schema: {
        ...tag,
        summary:
          'Create an account. With e-mail confirmation (default when SMTP is configured) a self-service sign-up answers 202 and the account is created from the link in the e-mail; the answer is the same whether or not the address is registered.',
        body: SignupBody,
      },
      config: authLimit,
    },
    async (req, reply) => {
      const { email, password, name, organisationName, inviteToken } = req.body;
      let invitation: InvitationRow | undefined;
      if (inviteToken) {
        // The invitation was sent to this address, so it is confirmed – and only its holder learns
        // that the address already has an account (which then accepts the invitation instead).
        invitation = findInvitation(inviteToken);
        if (!usableInvitation(invitation)) throw badRequest('Invitation is invalid or has expired');
        if (invitation.email.toLowerCase() !== email.toLowerCase()) throw badRequest('Invitation was issued for a different e-mail address');
      } else if (config.signupConfirmEmail) {
        await requestSignupConfirmation(email, password, name.trim(), organisationName?.trim() || null);
        reply.code(202);
        return { confirmationRequired: true, email };
      }
      // Without e-mail delivery an address cannot be confirmed: the account is created at once and
      // an address that is already registered is reported (rate limited).
      if (db.get('SELECT 1 FROM users WHERE email = ?', email)) throw conflict('An account with this e-mail already exists');
      const userId = uuid();
      const passwordHash = await hashPassword(password);
      db.tx(() => {
        db.run('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', userId, email, name.trim(), passwordHash, nowIso());
        if (invitation) {
          db.run('INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)', invitation.org_id, userId, invitation.role, nowIso());
          db.run('UPDATE invitations SET accepted_at = ? WHERE id = ?', nowIso(), invitation.id);
          db.run('DELETE FROM invitations WHERE org_id = ? AND accepted_at IS NULL AND lower(email) = lower(?)', invitation.org_id, invitation.email);
        } else {
          createOrganisation(db, organisationName?.trim() || `${name.trim()}'s organisation`, userId);
        }
      });
      const session = createSession(db, config, userId, req);
      setSessionCookies(reply, config, session);
      reply.code(201);
      return { ...buildMe(db, userId), csrfToken: session.csrf };
    },
  );

  /**
   * Self-service sign-up with e-mail confirmation: a new address gets a link that creates the
   * account; an address that already has one gets a note saying so (with log-in and password
   * reset links). Both take about as long, and the caller is told the same either way.
   */
  const requestSignupConfirmation = async (email: string, password: string, name: string, organisationName: string | null) => {
    const passwordHash = await hashPassword(password);
    const existing = db.get<{ name: string }>('SELECT name FROM users WHERE email = ?', email);
    if (existing) {
      await ctx.mailer.send(
        email,
        'Your Athena-sky account',
        `Hello ${existing.name},\n\nSomeone – hopefully you – tried to create an Athena-sky account with this e-mail address, but it already has one.\n\nLog in: ${config.publicUrl}/login\nForgot your password? ${config.publicUrl}/forgot-password\n\nIf this was not you, you can ignore this e-mail.`,
      );
      return;
    }
    const token = randomToken('', 32);
    db.tx(() => {
      db.run('DELETE FROM pending_signups WHERE email = ? OR expires_at < ?', email, nowIso());
      db.run(
        'INSERT INTO pending_signups (id, email, name, password_hash, organisation_name, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        sha256Hex(token),
        email,
        name,
        passwordHash,
        organisationName,
        new Date(Date.now() + 24 * 3_600_000).toISOString(),
        nowIso(),
      );
    });
    const link = `${config.publicUrl}/signup/confirm?token=${encodeURIComponent(token)}`;
    await ctx.mailer.send(
      email,
      'Confirm your Athena-sky account',
      `Hello ${name},\n\nConfirm your e-mail address to create your Athena-sky account (the link is valid for 24 hours):\n${link}\n\nIf you did not sign up, you can ignore this e-mail.`,
    );
  };

  app.post<{ Body: Static<typeof SignupConfirmBody> }>(
    '/api/v2/auth/signup/confirm',
    { schema: { ...tag, summary: 'Create the account of a confirmed sign-up (link from the confirmation e-mail) and log in', body: SignupConfirmBody }, config: authLimit },
    async (req, reply) => {
      const id = sha256Hex(req.body.token);
      const p = db.get<{ email: string; name: string; password_hash: string; organisation_name: string | null; expires_at: string }>(
        'SELECT email, name, password_hash, organisation_name, expires_at FROM pending_signups WHERE id = ?',
        id,
      );
      if (!p || new Date(p.expires_at).getTime() < Date.now()) throw badRequest('This confirmation link is invalid or has expired – please sign up again');
      if (db.get('SELECT 1 FROM users WHERE email = ?', p.email)) {
        db.run('DELETE FROM pending_signups WHERE email = ?', p.email);
        throw conflict('An account with this e-mail already exists – log in instead');
      }
      const userId = uuid();
      db.tx(() => {
        db.run('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', userId, p.email, p.name, p.password_hash, nowIso());
        createOrganisation(db, p.organisation_name || `${p.name}'s organisation`, userId);
        db.run('DELETE FROM pending_signups WHERE email = ?', p.email);
      });
      const session = createSession(db, config, userId, req);
      setSessionCookies(reply, config, session);
      reply.code(201);
      return { ...buildMe(db, userId), csrfToken: session.csrf };
    },
  );

  app.post<{ Body: Static<typeof LoginBody> }>(
    '/api/v2/auth/login',
    { schema: { ...tag, summary: 'Log in with e-mail and password', body: LoginBody }, config: authLimit },
    async (req, reply) => {
      const row = db.get<{ id: string; password_hash: string }>('SELECT id, password_hash FROM users WHERE email = ?', req.body.email);
      // Always run a hash to keep timing similar for unknown accounts.
      const ok = row ? await verifyPassword(req.body.password, row.password_hash) : (await hashPassword(req.body.password), false);
      if (!row || !ok) throw unauthorized('Invalid e-mail or password');
      const session = createSession(db, config, row.id, req);
      setSessionCookies(reply, config, session);
      return { ...buildMe(db, row.id), csrfToken: session.csrf };
    },
  );

  app.post('/api/v2/auth/logout', { schema: { ...tag, summary: 'Log out (ends the session)' } }, async (req, reply) => {
    if (req.auth?.sessionId) {
      db.run('DELETE FROM sessions WHERE id = ?', req.auth.sessionId);
      ctx.hub.closeAuth(req.auth.sessionId);
    }
    clearSessionCookies(reply, config);
    return { ok: true };
  });

  app.get('/api/v2/auth/session', { schema: { ...tag, summary: 'Session probe: never 401, tells whether the caller is logged in' } }, async (req) => {
    if (!req.auth) return { authenticated: false };
    return { authenticated: true, ...buildMe(db, req.auth.user.id), csrfToken: req.auth.csrf ?? null };
  });

  app.get('/api/v2/auth/me', { schema: { ...tag, summary: 'Current user and organisation memberships' } }, async (req) => {
    const auth = requireAuth(req);
    return { ...buildMe(db, auth.user.id), csrfToken: auth.csrf ?? null };
  });

  app.patch<{ Body: Static<typeof ProfileBody> }>(
    '/api/v2/auth/me',
    { schema: { ...tag, summary: 'Update profile', body: ProfileBody } },
    async (req) => {
      const auth = requireAuth(req);
      db.run('UPDATE users SET name = ? WHERE id = ?', req.body.name.trim(), auth.user.id);
      return buildMe(db, auth.user.id);
    },
  );

  app.post<{ Body: Static<typeof ChangePasswordBody> }>(
    '/api/v2/auth/password/change',
    { schema: { ...tag, summary: 'Change password', body: ChangePasswordBody }, config: authLimit },
    async (req) => {
      const auth = requireAuth(req);
      const row = db.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', auth.user.id)!;
      if (!(await verifyPassword(req.body.currentPassword, row.password_hash))) throw badRequest('Current password is incorrect');
      db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(req.body.newPassword), auth.user.id);
      // End every other session (and their live sockets).
      const others = db.all<{ id: string }>('SELECT id FROM sessions WHERE user_id = ? AND id != ?', auth.user.id, auth.sessionId ?? '');
      db.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', auth.user.id, auth.sessionId ?? '');
      for (const o of others) ctx.hub.closeAuth(o.id);
      return { ok: true };
    },
  );

  app.post<{ Body: Static<typeof ResetRequestBody> }>(
    '/api/v2/auth/password/reset',
    { schema: { ...tag, summary: 'Request a password reset e-mail', body: ResetRequestBody }, config: authLimit },
    async (req) => {
      const user = db.get<{ id: string; email: string; name: string }>('SELECT id, email, name FROM users WHERE email = ?', req.body.email);
      if (user) {
        const token = randomToken('', 32);
        db.run(
          'INSERT INTO password_resets (id, user_id, expires_at) VALUES (?, ?, ?)',
          sha256Hex(token),
          user.id,
          new Date(Date.now() + 3_600_000).toISOString(),
        );
        const link = `${config.publicUrl}/reset-password?token=${encodeURIComponent(token)}`;
        await ctx.mailer.send(
          user.email,
          'Athena-sky password reset',
          `Hello ${user.name},\n\nUse the link below to choose a new password (valid for 1 hour):\n${link}\n\nIf you did not request this, you can ignore this e-mail.`,
        );
      }
      // Same response whether or not the account exists.
      return { ok: true };
    },
  );

  app.post<{ Body: Static<typeof ResetConfirmBody> }>(
    '/api/v2/auth/password/reset/confirm',
    { schema: { ...tag, summary: 'Set a new password with a reset token', body: ResetConfirmBody }, config: authLimit },
    async (req) => {
      const id = sha256Hex(req.body.token);
      const row = db.get<{ user_id: string; expires_at: string; used_at: string | null }>(
        'SELECT user_id, expires_at, used_at FROM password_resets WHERE id = ?',
        id,
      );
      if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) throw badRequest('Reset link is invalid or has expired');
      const hash = await hashPassword(req.body.password);
      const sessions = db.all<{ id: string }>('SELECT id FROM sessions WHERE user_id = ?', row.user_id);
      db.tx(() => {
        db.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, row.user_id);
        db.run('UPDATE password_resets SET used_at = ? WHERE id = ?', nowIso(), id);
        db.run('DELETE FROM sessions WHERE user_id = ?', row.user_id);
      });
      for (const sess of sessions) ctx.hub.closeAuth(sess.id);
      return { ok: true };
    },
  );

  // --- Invitations (public lookup + accept for existing accounts) ---------------------------

  app.get<{ Params: { token: string } }>(
    '/api/v2/invitations/:token',
    { schema: { tags: ['organisations'], summary: 'Look up an invitation (public)' }, config: authLimit },
    async (req) => {
      const inv = findInvitation(req.params.token);
      if (!usableInvitation(inv)) throw notFound('Invitation');
      return { organisationName: inv.org_name, email: inv.email, role: inv.role, expiresAt: inv.expires_at };
    },
  );

  app.post<{ Body: Static<typeof InviteAcceptBody> }>(
    '/api/v2/invitations/accept',
    { schema: { tags: ['organisations'], summary: 'Accept an invitation with the current account', body: InviteAcceptBody } },
    async (req) => {
      const auth = requireAuth(req);
      const inv = findInvitation(req.body.token);
      if (!usableInvitation(inv)) throw badRequest('Invitation is invalid or has expired');
      if (inv.email.toLowerCase() !== auth.user.email.toLowerCase()) throw forbidden('Invitation was issued for a different e-mail address');
      db.tx(() => {
        db.run(
          'INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, user_id) DO NOTHING',
          inv.org_id,
          auth.user.id,
          inv.role,
          nowIso(),
        );
        db.run('UPDATE invitations SET accepted_at = ? WHERE id = ?', nowIso(), inv.id);
        // Other pending invitations to the same organisation are used up with this one.
        db.run('DELETE FROM invitations WHERE org_id = ? AND accepted_at IS NULL AND lower(email) = lower(?)', inv.org_id, inv.email);
      });
      return buildMe(db, auth.user.id);
    },
  );

  // --- Personal API tokens -------------------------------------------------------------------

  const tokenDto = (r: { id: string; name: string; prefix: string; org_id: string | null; created_at: string; last_used_at: string | null; expires_at: string | null }): ApiTokenDto => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    orgId: r.org_id,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
  });

  app.get('/api/v2/tokens', { schema: { tags: ['api tokens'], summary: 'List personal API tokens' } }, async (req) => {
    const auth = requireAuth(req);
    return db
      .all<any>('SELECT id, name, prefix, org_id, created_at, last_used_at, expires_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC', auth.user.id)
      .map(tokenDto);
  });

  app.post<{ Body: Static<typeof TokenBody> }>(
    '/api/v2/tokens',
    { schema: { tags: ['api tokens'], summary: 'Create a personal API token (shown once)', body: TokenBody } },
    async (req, reply) => {
      const auth = requireAuth(req);
      if (auth.via === 'token') throw forbidden('API tokens cannot create other API tokens');
      const orgId = req.body.orgId ?? null;
      if (orgId) orgAccess(db, req, orgId);
      const token = randomToken('ast_', 32);
      const id = uuid();
      const expires = req.body.expiresInDays ? new Date(Date.now() + req.body.expiresInDays * 86_400_000).toISOString() : null;
      db.run(
        'INSERT INTO api_tokens (id, user_id, org_id, name, token_hash, prefix, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        auth.user.id,
        orgId,
        req.body.name,
        sha256Hex(token),
        token.slice(0, 10),
        nowIso(),
        expires,
      );
      const row = db.get<any>('SELECT id, name, prefix, org_id, created_at, last_used_at, expires_at FROM api_tokens WHERE id = ?', id);
      reply.code(201);
      const dto: ApiTokenCreatedDto = { ...tokenDto(row), token };
      return dto;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v2/tokens/:id',
    { schema: { tags: ['api tokens'], summary: 'Revoke a personal API token' } },
    async (req) => {
      const auth = requireAuth(req);
      const r = db.run('DELETE FROM api_tokens WHERE id = ? AND user_id = ?', req.params.id, auth.user.id);
      if (r.changes === 0) throw notFound('API token');
      ctx.hub.closeAuth(req.params.id);
      return { ok: true };
    },
  );
}
