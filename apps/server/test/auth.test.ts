import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, api, cookieHeader, signup, startServer, waitFor, type Session, type TestServer } from './helpers';

let s: TestServer;
beforeAll(async () => {
  s = await startServer();
});
afterAll(async () => {
  await s.close();
});

describe('F1 sign up, log in, password reset', () => {
  it('signs up, creates a personal organisation and returns a session', async () => {
    const u = await signup(s.app, { email: 'alice@example.com', name: 'Alice', organisationName: 'Alice Aerial' });
    expect(u.orgId).toBeTruthy();
    const me = await api(s.app, u)('GET', '/api/v2/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('alice@example.com');
    expect(me.json().memberships[0]).toMatchObject({ orgName: 'Alice Aerial', role: 'owner' });
  });

  it('rejects duplicate e-mail, weak passwords and invalid e-mails', async () => {
    const dup = await s.app.inject({ method: 'POST', url: '/api/v2/auth/signup', payload: { email: 'alice@example.com', password: 'whatever123', name: 'X' } });
    expect(dup.statusCode).toBe(409);
    const weak = await s.app.inject({ method: 'POST', url: '/api/v2/auth/signup', payload: { email: 'b@example.com', password: 'short', name: 'X' } });
    expect(weak.statusCode).toBe(400);
    const bad = await s.app.inject({ method: 'POST', url: '/api/v2/auth/signup', payload: { email: 'not-an-email', password: 'whatever123', name: 'X' } });
    expect(bad.statusCode).toBe(400);
  });

  it('logs in and out; wrong password is 401', async () => {
    const wrong = await s.app.inject({ method: 'POST', url: '/api/v2/auth/login', payload: { email: 'alice@example.com', password: 'nope-nope' } });
    expect(wrong.statusCode).toBe(401);
    const ok = await s.app.inject({ method: 'POST', url: '/api/v2/auth/login', payload: { email: 'ALICE@example.com', password: 'correct-horse-battery' } });
    expect(ok.statusCode).toBe(200);
    const cookie = cookieHeader(ok.headers['set-cookie']);
    expect(cookie).toContain('athena_session=');
    const csrf = ok.json().csrfToken;
    const out = await s.app.inject({ method: 'POST', url: '/api/v2/auth/logout', headers: { cookie, 'x-csrf-token': csrf } });
    expect(out.statusCode).toBe(200);
    const me = await s.app.inject({ method: 'GET', url: '/api/v2/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });

  it('reports the session state without a 401 (used by the web app on start-up)', async () => {
    const anon = await s.app.inject({ method: 'GET', url: '/api/v2/auth/session' });
    expect(anon.statusCode).toBe(200);
    expect(anon.json()).toEqual({ authenticated: false });
    const u = await signup(s.app);
    const res = await api(s.app, u)('GET', '/api/v2/auth/session');
    expect(res.json()).toMatchObject({ authenticated: true, user: { id: u.userId }, csrfToken: u.csrf });
    // terrain availability probe for the 3D planner (disabled in tests)
    expect((await api(s.app, u)('GET', '/api/v2/terrain')).json()).toEqual({ enabled: false });
  });

  it('enforces CSRF tokens on cookie-authenticated mutations', async () => {
    const u = await signup(s.app);
    const noToken = await s.app.inject({ method: 'POST', url: `/api/v2/organisations/${u.orgId}/fleets`, headers: { cookie: u.cookie }, payload: { name: 'F' } });
    expect(noToken.statusCode).toBe(403);
    const wrong = await s.app.inject({ method: 'POST', url: `/api/v2/organisations/${u.orgId}/fleets`, headers: { cookie: u.cookie, 'x-csrf-token': 'x' }, payload: { name: 'F' } });
    expect(wrong.statusCode).toBe(403);
    const good = await api(s.app, u)('POST', `/api/v2/organisations/${u.orgId}/fleets`, { name: 'F' });
    expect(good.statusCode).toBe(201);
  });

  it('resets a forgotten password via the e-mailed link', async () => {
    const u = await signup(s.app, { email: 'reset@example.com' });
    const req = await s.app.inject({ method: 'POST', url: '/api/v2/auth/password/reset', payload: { email: 'reset@example.com' } });
    expect(req.statusCode).toBe(200);
    // unknown accounts get the same answer
    const unknown = await s.app.inject({ method: 'POST', url: '/api/v2/auth/password/reset', payload: { email: 'nobody@example.com' } });
    expect(unknown.statusCode).toBe(200);
    const mail = await waitFor(() => s.ctx.db.get<{ body: string }>("SELECT body FROM outbox WHERE to_addr = 'reset@example.com' ORDER BY created_at DESC"));
    const token = decodeURIComponent(/token=([^\s]+)/.exec(mail.body)![1]!);
    const bad = await s.app.inject({ method: 'POST', url: '/api/v2/auth/password/reset/confirm', payload: { token: 'x'.repeat(20), password: 'new-password-1' } });
    expect(bad.statusCode).toBe(400);
    const ok = await s.app.inject({ method: 'POST', url: '/api/v2/auth/password/reset/confirm', payload: { token, password: 'new-password-1' } });
    expect(ok.statusCode).toBe(200);
    // old sessions are revoked, token cannot be reused
    expect((await api(s.app, u)('GET', '/api/v2/auth/me')).statusCode).toBe(401);
    expect((await s.app.inject({ method: 'POST', url: '/api/v2/auth/password/reset/confirm', payload: { token, password: 'other-password-2' } })).statusCode).toBe(400);
    const login = await s.app.inject({ method: 'POST', url: '/api/v2/auth/login', payload: { email: 'reset@example.com', password: 'new-password-1' } });
    expect(login.statusCode).toBe(200);
  });

  it('answers a password reset at once and the same way, whether or not the account exists or mail can be sent', async () => {
    await signup(s.app, { email: 'slowmail@example.com' });
    const real = s.ctx.mailer;
    const sent: string[] = [];
    try {
      // A slow mail server: the answer does not wait for it (nor tells that a mail is sent).
      s.ctx.mailer = { send: async (to) => void (await new Promise((r) => setTimeout(r, 400)), sent.push(to)) };
      const t0 = Date.now();
      const known = await s.app.inject({ method: 'POST', url: '/api/v2/auth/password/reset', payload: { email: 'slowmail@example.com' } });
      expect(Date.now() - t0).toBeLessThan(250);
      const unknown = await s.app.inject({ method: 'POST', url: '/api/v2/auth/password/reset', payload: { email: 'nobody-here@example.com' } });
      expect([known.statusCode, unknown.statusCode]).toEqual([200, 200]);
      expect(known.body).toBe(unknown.body);
      await waitFor(() => sent.includes('slowmail@example.com'));
      // A failing mail server: still the same answer (the failure is logged).
      s.ctx.mailer = { send: async () => Promise.reject(new Error('SMTP unreachable')) };
      const down = await s.app.inject({ method: 'POST', url: '/api/v2/auth/password/reset', payload: { email: 'slowmail@example.com' } });
      expect(down.statusCode).toBe(200);
      expect(down.body).toBe(unknown.body);
    } finally {
      s.ctx.mailer = real;
    }
    expect(sent).toEqual(['slowmail@example.com']);
  });

  it('changes the password with the current password', async () => {
    const u = await signup(s.app);
    const call = api(s.app, u);
    expect((await call('POST', '/api/v2/auth/password/change', { currentPassword: 'wrong-one', newPassword: 'brand-new-pass' })).statusCode).toBe(400);
    expect((await call('POST', '/api/v2/auth/password/change', { currentPassword: 'correct-horse-battery', newPassword: 'brand-new-pass' })).statusCode).toBe(200);
    expect((await call('GET', '/api/v2/auth/me')).statusCode).toBe(200);
  });
});

describe('F1 sign-up with e-mail confirmation (SMTP configured)', () => {
  let c: TestServer;
  beforeAll(async () => {
    c = await startServer({ config: { signupConfirmEmail: true } });
  });
  afterAll(async () => {
    await c.close();
  });
  const signupReq = (email: string, extra: Record<string, unknown> = {}) =>
    c.app.inject({ method: 'POST', url: '/api/v2/auth/signup', payload: { email, password: 'correct-horse-battery', name: 'Nina Newcomer', ...extra } });
  const mails = (to: string) => c.ctx.db.all<{ subject: string; body: string }>('SELECT subject, body FROM outbox WHERE to_addr = ? ORDER BY rowid', to);
  /** The newest e-mail to the address, waiting for the n-th one (sent after the response). */
  const lastMail = async (to: string, n = 1) => (await waitFor(() => mails(to).length >= n && mails(to)))[mails(to).length - 1]!;
  /** Signs up and follows the confirmation link. */
  const register = async (email: string, name: string): Promise<Session> => {
    await signupReq(email, { name });
    const token = decodeURIComponent(/token=([^\s]+)/.exec((await lastMail(email)).body)![1]!);
    const res = await c.app.inject({ method: 'POST', url: '/api/v2/auth/signup/confirm', payload: { token, password: 'correct-horse-battery' } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    return { cookie: cookieHeader(res.headers['set-cookie']), csrf: body.csrfToken, userId: body.user.id, orgId: body.memberships[0]?.orgId, email };
  };

  it('creates the account only from the e-mailed link – and never tells whether an address is registered', async () => {
    const existing = await register('taken@example.com', 'Theo Taken');
    const fresh = await signupReq('nina@example.com', { organisationName: 'Nina Aerial' });
    const taken = await signupReq('taken@example.com');
    // Same status and body shape either way, no session.
    expect([fresh.statusCode, taken.statusCode]).toEqual([202, 202]);
    expect(fresh.json()).toEqual({ confirmationRequired: true, email: 'nina@example.com' });
    expect(taken.json()).toEqual({ confirmationRequired: true, email: 'taken@example.com' });
    expect(fresh.headers['set-cookie']).toBeUndefined();
    expect(taken.headers['set-cookie']).toBeUndefined();
    // The owner of the registered address is told so by e-mail; their account is untouched.
    expect(await lastMail('taken@example.com', 2)).toMatchObject({ subject: 'Your Athena-sky account', body: expect.stringContaining('already has one') });
    expect((await api(c.app, existing)('GET', '/api/v2/auth/me')).statusCode).toBe(200);
    // The new address has no account until it is confirmed.
    expect(c.ctx.db.get("SELECT 1 FROM users WHERE email = 'nina@example.com'")).toBeUndefined();
    expect((await c.app.inject({ method: 'POST', url: '/api/v2/auth/login', payload: { email: 'nina@example.com', password: 'correct-horse-battery' } })).statusCode).toBe(401);
    const mail = await lastMail('nina@example.com');
    expect(mail.subject).toBe('Confirm your Athena-sky account');
    const token = decodeURIComponent(/signup\/confirm\?token=([^\s]+)/.exec(mail.body)![1]!);
    expect((await c.app.inject({ method: 'POST', url: '/api/v2/auth/signup/confirm', payload: { token: 'x'.repeat(30), password: 'correct-horse-battery' } })).statusCode).toBe(400);
    // The link alone is not enough: the password chosen at sign-up goes with it.
    expect((await c.app.inject({ method: 'POST', url: '/api/v2/auth/signup/confirm', payload: { token } })).statusCode).toBe(400);
    expect((await c.app.inject({ method: 'POST', url: '/api/v2/auth/signup/confirm', payload: { token, password: 'not-my-password' } })).json().message).toMatch(/not the password chosen when signing up/);
    const ok = await c.app.inject({ method: 'POST', url: '/api/v2/auth/signup/confirm', payload: { token, password: 'correct-horse-battery' } });
    expect(ok.statusCode).toBe(201);
    expect(cookieHeader(ok.headers['set-cookie'])).toContain('athena_session=');
    expect(ok.json()).toMatchObject({ user: { email: 'nina@example.com', name: 'Nina Newcomer' }, memberships: [{ orgName: 'Nina Aerial', role: 'owner' }] });
    // A link works once; the password chosen at sign-up is the account's password.
    expect((await c.app.inject({ method: 'POST', url: '/api/v2/auth/signup/confirm', payload: { token, password: 'correct-horse-battery' } })).statusCode).toBe(400);
    expect((await c.app.inject({ method: 'POST', url: '/api/v2/auth/login', payload: { email: 'nina@example.com', password: 'correct-horse-battery' } })).statusCode).toBe(200);
  });

  it('creates the account of whoever owns the address – not of someone who signed up with it later, and lets an invitation create the account at once', async () => {
    const confirm = (token: string, password: string) => c.app.inject({ method: 'POST', url: '/api/v2/auth/signup/confirm', payload: { token, password } });
    const linkOf = async (n: number) => decodeURIComponent(/token=([^\s]+)/.exec((await lastMail('twice@example.com', n)).body)![1]!);
    // Alice signs up; Eve then signs up with Alice's address (her own name and password).
    await signupReq('twice@example.com', { name: 'Alice Owner', password: 'alice-password-1' });
    const alices = await linkOf(1);
    await signupReq('twice@example.com', { name: 'Eve Intruder', password: 'eve-password-12' });
    const eves = await linkOf(2);
    // Alice clicking the link of Eve's request does not create Eve's account: her password does not fit it.
    expect((await confirm(eves, 'alice-password-1')).statusCode).toBe(400);
    // Her own link still works, with her details.
    const ok = await confirm(alices, 'alice-password-1');
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ user: { name: 'Alice Owner' }, memberships: [{ orgName: "Alice Owner's organisation" }] });
    // Confirming one request ends the others.
    expect((await confirm(eves, 'eve-password-12')).statusCode).toBe(400);
    expect((await c.app.inject({ method: 'POST', url: '/api/v2/auth/login', payload: { email: 'twice@example.com', password: 'eve-password-12' } })).statusCode).toBe(401);
    expect((await c.app.inject({ method: 'POST', url: '/api/v2/auth/login', payload: { email: 'twice@example.com', password: 'alice-password-1' } })).statusCode).toBe(200);
    // Confirmed twice at the same moment (a double click, or two links): one account, and the
    // other confirmation is told to log in – not an error of the server.
    for (const [addr, links] of [['double@example.com', 1], ['pair@example.com', 2]] as const) {
      for (let k = 0; k < links; k++) await signupReq(addr, { name: 'Dana Double', password: 'dana-password-1' });
      const tokens = await Promise.all(Array.from({ length: links }, async (_, k) => decodeURIComponent(/token=([^\s]+)/.exec((await lastMail(addr, k + 1)).body)![1]!)));
      const both = await Promise.all([confirm(tokens[0]!, 'dana-password-1'), confirm(tokens[links - 1]!, 'dana-password-1')]);
      expect(both.map((r) => r.statusCode).sort(), addr).toEqual([201, 409]);
      expect(both.find((r) => r.statusCode === 409)!.json().message).toBe('An account with this e-mail already exists – log in instead');
      expect(c.ctx.db.all('SELECT id FROM users WHERE email = ?', addr)).toHaveLength(1);
    }
    // The invitation was sent to the address: no further confirmation.
    const admin = await register('boss@example.com', 'Bea Boss');
    const invited = await api(c.app, admin)('POST', `/api/v2/organisations/${admin.orgId}/members`, { email: 'crew@example.com', role: 'pilot' });
    expect(invited.statusCode).toBe(201);
    // The link goes to the invited mailbox only: the inviter could otherwise create the account
    // of an address they do not own (or learn whether it has one).
    expect(invited.json().invitation.acceptUrl).toBeUndefined();
    const invite = decodeURIComponent(/invite=([^\s]+)/.exec((await lastMail('crew@example.com')).body)![1]!);
    const joined = await signupReq('crew@example.com', { inviteToken: invite });
    expect(joined.statusCode).toBe(201);
    expect(joined.json().memberships[0]).toMatchObject({ orgId: admin.orgId, role: 'pilot' });
  });
});

describe('F10 API tokens', () => {
  it('creates, uses, scopes and revokes personal API tokens', async () => {
    const u = await signup(s.app);
    const other = await api(s.app, u)('POST', '/api/v2/organisations', { name: 'Second org' });
    const secondOrg = other.json().id;
    const created = await api(s.app, u)('POST', '/api/v2/tokens', { name: 'CI', orgId: u.orgId });
    expect(created.statusCode).toBe(201);
    const token = created.json().token as string;
    expect(token.startsWith('ast_')).toBe(true);
    const auth = { authorization: `Bearer ${token}` };
    // bearer requests need no CSRF token
    const fleet = await s.app.inject({ method: 'POST', url: `/api/v2/organisations/${u.orgId}/fleets`, headers: auth, payload: { name: 'API fleet' } });
    expect(fleet.statusCode).toBe(201);
    // scoped to the first organisation
    const scoped = await s.app.inject({ method: 'GET', url: `/api/v2/organisations/${secondOrg}/drones`, headers: auth });
    expect(scoped.statusCode).toBe(403);
    const list = await s.app.inject({ method: 'GET', url: '/api/v2/organisations', headers: auth });
    expect(list.json()).toHaveLength(1);
    // tokens cannot mint tokens
    expect((await s.app.inject({ method: 'POST', url: '/api/v2/tokens', headers: auth, payload: { name: 'x' } })).statusCode).toBe(403);
    const tokens = await api(s.app, u)('GET', '/api/v2/tokens');
    expect(tokens.json()[0].prefix).toBe(token.slice(0, 10));
    expect(JSON.stringify(tokens.json())).not.toContain(token);
    expect((await api(s.app, u)('DELETE', `/api/v2/tokens/${created.json().id}`)).statusCode).toBe(200);
    expect((await s.app.inject({ method: 'GET', url: '/api/v2/auth/me', headers: auth })).statusCode).toBe(401);
  });

  it('publishes the OpenAPI schema and API root', async () => {
    const schema = await s.app.inject({ method: 'GET', url: '/api/v2/schema/' });
    expect(schema.statusCode).toBe(200);
    const doc = schema.json();
    expect(doc.openapi).toBe('3.0.3');
    expect(Object.keys(doc.paths)).toContain('/api/v2/organisations/{orgId}/drones');
    expect(Object.keys(doc.paths).length).toBeGreaterThan(60);
    const root = await s.app.inject({ method: 'GET', url: '/api/v2/' });
    expect(root.json().organisations).toMatch(/\/api\/v2\/organisations\/$/);
    const docs = await s.app.inject({ method: 'GET', url: '/api/v2/docs/' });
    expect(docs.statusCode).toBe(200);
  });
});

describe('F1.4 organisations, members, roles and isolation', () => {
  it('keeps no invitation whose e-mail could not be sent', async () => {
    const owner = await signup(s.app);
    const real = s.ctx.mailer;
    try {
      s.ctx.mailer = { send: async () => Promise.reject(new Error('SMTP unreachable')) };
      const r = await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/members`, { email: 'unreached@example.com', role: 'pilot' });
      expect(r.statusCode).toBe(502);
      expect(r.json()).toMatchObject({ error: 'mail_failed' });
    } finally {
      s.ctx.mailer = real;
    }
    const pending = (await api(s.app, owner)('GET', `/api/v2/organisations/${owner.orgId}/invitations`)).json();
    expect(pending.map((i: any) => i.email)).not.toContain('unreached@example.com');
    // With the mail server back, inviting again works.
    expect((await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/members`, { email: 'unreached@example.com', role: 'pilot' })).statusCode).toBe(201);
  });

  it('invites a new user who signs up with the invitation and gets the role', async () => {
    const owner = await signup(s.app);
    const inv = await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/members`, { email: 'newpilot@example.com', role: 'pilot' });
    expect(inv.statusCode).toBe(201);
    const url: string = inv.json().invitation.acceptUrl;
    const token = decodeURIComponent(url.split('invite=')[1]!);
    const info = await s.app.inject({ method: 'GET', url: `/api/v2/invitations/${encodeURIComponent(token)}` });
    expect(info.json()).toMatchObject({ email: 'newpilot@example.com', role: 'pilot' });
    const wrongEmail = await s.app.inject({ method: 'POST', url: '/api/v2/auth/signup', payload: { email: 'other@example.com', password: 'whatever123', name: 'X', inviteToken: token } });
    expect(wrongEmail.statusCode).toBe(400);
    const pilot = await signup(s.app, { email: 'newpilot@example.com', inviteToken: token });
    expect(pilot.orgId).toBe(owner.orgId);
    const me = await api(s.app, pilot)('GET', '/api/v2/auth/me');
    expect(me.json().memberships).toEqual([{ orgId: owner.orgId, orgName: expect.any(String), role: 'pilot' }]);
    const members = await api(s.app, owner)('GET', `/api/v2/organisations/${owner.orgId}/members`);
    expect(members.json().map((m: any) => m.role).sort()).toEqual(['owner', 'pilot']);
  });

  it('invites existing users too (they join after accepting) and enforces the permission matrix', async () => {
    const owner = await signup(s.app);
    const viewer = await signup(s.app);
    const add = await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/members`, { email: viewer.email, role: 'viewer' });
    expect(add.statusCode).toBe(201);
    // Same answer as for an unknown address: no member yet, an invitation – nothing tells whether the account exists.
    const unknown = await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/members`, { email: `nobody-${Date.now()}@example.com`, role: 'viewer' });
    expect(Object.keys(add.json()).sort()).toEqual(Object.keys(unknown.json()).sort());
    expect(add.json()).toMatchObject({ member: null, invitation: { email: viewer.email, role: 'viewer' } });
    expect((await api(s.app, viewer)('GET', `/api/v2/organisations/${owner.orgId}/drones`)).statusCode).toBe(404);
    // Accepting with the invited account.
    const token = new URL(add.json().invitation.acceptUrl).searchParams.get('invite');
    expect((await api(s.app, owner)('POST', '/api/v2/invitations/accept', { token })).statusCode).toBe(403);
    expect((await api(s.app, viewer)('POST', '/api/v2/invitations/accept', { token })).statusCode).toBe(200);
    expect((await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/members`, { email: viewer.email, role: 'viewer' })).statusCode).toBe(409);
    const v = api(s.app, viewer);
    expect((await v('GET', `/api/v2/organisations/${owner.orgId}/drones`)).statusCode).toBe(200);
    expect((await v('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: 'X' })).statusCode).toBe(403);
    expect((await v('POST', `/api/v2/organisations/${owner.orgId}/missions`, { name: 'M', plan: { items: [] } })).statusCode).toBe(403);
    expect((await v('POST', `/api/v2/organisations/${owner.orgId}/members`, { email: 'x@example.com', role: 'owner' })).statusCode).toBe(403);
    // a viewer may leave on their own
    expect((await v('DELETE', `/api/v2/organisations/${owner.orgId}/members/${viewer.userId}`)).statusCode).toBe(200);
    // the last owner cannot be demoted or removed
    expect((await api(s.app, owner)('PATCH', `/api/v2/organisations/${owner.orgId}/members/${owner.userId}`, { role: 'pilot' })).statusCode).toBe(400);
    expect((await api(s.app, owner)('DELETE', `/api/v2/organisations/${owner.orgId}/members/${owner.userId}`)).statusCode).toBe(400);
  });

  it('keeps only the latest invitation, and a removed member cannot come back with an old one', async () => {
    const owner = await signup(s.app);
    const eve = await signup(s.app);
    const call = api(s.app, owner);
    const tokenOf = (r: any) => new URL(r.json().invitation.acceptUrl).searchParams.get('invite');
    const asPilot = tokenOf(await call('POST', `/api/v2/organisations/${owner.orgId}/members`, { email: eve.email, role: 'pilot' }));
    const asViewer = tokenOf(await call('POST', `/api/v2/organisations/${owner.orgId}/members`, { email: eve.email, role: 'viewer' }));
    expect((await api(s.app, eve)('POST', '/api/v2/invitations/accept', { token: asPilot })).statusCode).toBe(400);
    expect((await api(s.app, eve)('POST', '/api/v2/invitations/accept', { token: asViewer })).statusCode).toBe(200);
    expect((await call('DELETE', `/api/v2/organisations/${owner.orgId}/members/${eve.userId}`)).statusCode).toBe(200);
    expect((await api(s.app, eve)('POST', '/api/v2/invitations/accept', { token: asPilot })).statusCode).toBe(400);
    expect((await api(s.app, eve)('POST', '/api/v2/invitations/accept', { token: asViewer })).statusCode).toBe(400);
    expect((await api(s.app, eve)('GET', `/api/v2/organisations/${owner.orgId}/drones`)).statusCode).toBe(404);
  });

  it('admins cannot grant or remove owners', async () => {
    const owner = await signup(s.app);
    const admin = await signup(s.app);
    await addMember(s.app, owner, admin, 'admin');
    const a = api(s.app, admin);
    expect((await a('POST', `/api/v2/organisations/${owner.orgId}/members`, { email: 'y@example.com', role: 'owner' })).statusCode).toBe(403);
    expect((await a('DELETE', `/api/v2/organisations/${owner.orgId}/members/${owner.userId}`)).statusCode).toBe(403);
    expect((await a('DELETE', `/api/v2/organisations/${owner.orgId}`)).statusCode).toBe(403);
  });

  it('isolates organisations from each other (404, not 403)', async () => {
    const a = await signup(s.app);
    const b = await signup(s.app);
    const drone = await api(s.app, a)('POST', `/api/v2/organisations/${a.orgId}/drones`, { name: 'Private drone' });
    expect(drone.statusCode).toBe(201);
    const bb = api(s.app, b);
    expect((await bb('GET', `/api/v2/organisations/${a.orgId}`)).statusCode).toBe(404);
    expect((await bb('GET', `/api/v2/organisations/${a.orgId}/drones/${drone.json().id}`)).statusCode).toBe(404);
    expect((await bb('GET', `/api/v2/organisations/${b.orgId}/drones/${drone.json().id}`)).statusCode).toBe(404);
  });

  it('records configuration changes in the audit trail', async () => {
    const owner = await signup(s.app);
    await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/fleets`, { name: 'Audited fleet' });
    const log = await api(s.app, owner)('GET', `/api/v2/organisations/${owner.orgId}/audit`);
    expect(log.json().items.some((e: any) => e.action === 'fleet.create' && e.details.name === 'Audited fleet')).toBe(true);
  });
});
