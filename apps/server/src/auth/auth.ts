import type { FastifyReply, FastifyRequest } from 'fastify';
import { can, isRole, type Permission, type Role } from '@athena-sky/shared';
import type { Db } from '../db/database';
import type { Config } from '../config';
import { randomToken, safeEqual, sha256Hex } from '../lib/crypto';
import { forbidden, notFound, unauthorized } from '../lib/errors';
import { nowIso } from '../lib/util';

export const SESSION_COOKIE = 'athena_session';
export const CSRF_COOKIE = 'athena_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export interface AuthInfo {
  user: AuthUser;
  via: 'session' | 'token';
  sessionId?: string;
  csrf?: string;
  /** When authenticated with an organisation-scoped API token. */
  tokenOrgId?: string | null;
  tokenId?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthInfo | null;
  }
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function createSession(db: Db, config: Config, userId: string, req: FastifyRequest): { token: string; csrf: string; expires: Date } {
  const token = randomToken('', 32);
  const csrf = randomToken('', 24);
  const expires = new Date(Date.now() + config.sessionTtlDays * 86_400_000);
  db.run(
    'INSERT INTO sessions (id, user_id, csrf, created_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sha256Hex(token),
    userId,
    csrf,
    nowIso(),
    expires.toISOString(),
    String(req.headers['user-agent'] ?? '').slice(0, 200),
    req.ip,
  );
  return { token, csrf, expires };
}

export function setSessionCookies(reply: FastifyReply, config: Config, session: { token: string; csrf: string; expires: Date }): void {
  const base = { path: '/', sameSite: 'lax' as const, secure: config.cookieSecure, expires: session.expires };
  reply.setCookie(SESSION_COOKIE, session.token, { ...base, httpOnly: true });
  reply.setCookie(CSRF_COOKIE, session.csrf, { ...base, httpOnly: false });
}

export function clearSessionCookies(reply: FastifyReply, config: Config): void {
  const base = { path: '/', sameSite: 'lax' as const, secure: config.cookieSecure };
  reply.clearCookie(SESSION_COOKIE, base);
  reply.clearCookie(CSRF_COOKIE, base);
}

/** Resolves a bearer token or session cookie into an AuthInfo (no CSRF enforcement). */
export function resolveAuth(db: Db, authorization: string | undefined, sessionToken: string | undefined): AuthInfo | null {
  if (authorization) {
    const m = /^Bearer\s+(\S+)$/i.exec(authorization);
    if (!m) return null;
    const row = db.get<{ id: string; org_id: string | null; expires_at: string | null; uid: string; email: string; name: string }>(
      `SELECT t.id, t.org_id, t.expires_at, u.id AS uid, u.email, u.name
         FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
      sha256Hex(m[1]!),
    );
    if (!row) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
    db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', nowIso(), row.id);
    return { user: { id: row.uid, email: row.email, name: row.name }, via: 'token', tokenOrgId: row.org_id, tokenId: row.id };
  }
  if (sessionToken) {
    const row = db.get<{ id: string; csrf: string; expires_at: string; uid: string; email: string; name: string }>(
      `SELECT s.id, s.csrf, s.expires_at, u.id AS uid, u.email, u.name
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
      sha256Hex(sessionToken),
    );
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) {
      db.run('DELETE FROM sessions WHERE id = ?', row.id);
      return null;
    }
    return { user: { id: row.uid, email: row.email, name: row.name }, via: 'session', sessionId: row.id, csrf: row.csrf };
  }
  return null;
}

/**
 * onRequest hook: authenticates the request and enforces CSRF double-submit
 * for state-changing requests authenticated by cookie.
 */
export function authHook(db: Db) {
  return async (req: FastifyRequest): Promise<void> => {
    req.auth = resolveAuth(db, req.headers.authorization, req.cookies?.[SESSION_COOKIE]);
    if (req.auth?.via === 'session' && UNSAFE.has(req.method)) {
      const header = req.headers[CSRF_HEADER];
      if (typeof header !== 'string' || !safeEqual(header, req.auth.csrf!)) {
        throw forbidden('Missing or invalid CSRF token');
      }
    }
  };
}

export function requireAuth(req: FastifyRequest): AuthInfo {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export interface OrgAccess {
  orgId: string;
  role: Role;
  userId: string;
  userName: string;
}

/** Checks the caller's membership (and optional permission) in an organisation. */
export function orgAccess(db: Db, req: FastifyRequest, orgId: string, permission?: Permission): OrgAccess {
  const auth = requireAuth(req);
  if (auth.via === 'token' && auth.tokenOrgId && auth.tokenOrgId !== orgId) throw forbidden('API token is scoped to another organisation');
  const m = db.get<{ role: string }>('SELECT role FROM memberships WHERE org_id = ? AND user_id = ?', orgId, auth.user.id);
  if (!m || !isRole(m.role)) throw notFound('Organisation');
  if (permission && !can(m.role, permission)) throw forbidden(`Your role (${m.role}) does not allow ${permission}`);
  return { orgId, role: m.role, userId: auth.user.id, userName: auth.user.name };
}
