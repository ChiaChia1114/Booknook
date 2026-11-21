import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, api, cookieHeader, signup, startServer, type TestServer } from './helpers';

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
    const mail = s.ctx.db.get<{ body: string }>("SELECT body FROM outbox WHERE to_addr = 'reset@example.com' ORDER BY created_at DESC");
    const token = decodeURIComponent(/token=([^\s]+)/.exec(mail!.body)![1]!);
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

  it('changes the password with the current password', async () => {
    const u = await signup(s.app);
    const call = api(s.app, u);
    expect((await call('POST', '/api/v2/auth/password/change', { currentPassword: 'wrong-one', newPassword: 'brand-new-pass' })).statusCode).toBe(400);
    expect((await call('POST', '/api/v2/auth/password/change', { currentPassword: 'correct-horse-battery', newPassword: 'brand-new-pass' })).statusCode).toBe(200);
    expect((await call('GET', '/api/v2/auth/me')).statusCode).toBe(200);
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
