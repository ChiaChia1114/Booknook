import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockAuthority, type MockAuthority } from '@athena-sky/simulator';
import { destinationPoint } from '@athena-sky/shared';
import { parseUtmAuthority } from '../src/config';
import { decisionOf, volumeRing } from '../src/airspace/authority';
import { api, signup, startServer, type Session, type TestServer } from './helpers';

const HOME = { lat: 25.0732, lon: 121.5355 };
const KEY = 'authority-key-1';

let authority: MockAuthority;
let mode: 'approve' | 'review' | 'reject' = 'approve';
let s: TestServer;
let owner: Session;
let other: Session;
let droneId: string;
const hooks: { event: string; status: string }[] = [];

const window = (minutes = 60) => ({ startAt: new Date(Date.now() + 60_000).toISOString(), endAt: new Date(Date.now() + minutes * 60_000).toISOString() });
const request = (who: Session, body: Record<string, unknown> = {}) =>
  api(s.app, who)('POST', `/api/v2/organisations/${who.orgId}/airspace/authorizations`, {
    geometry: { kind: 'cylinder', center: HOME, radiusM: 300 },
    maxAltM: 100,
    ...window(),
    ...body,
  });
const get = async (who: Session, id: string) => (await api(s.app, who)('GET', `/api/v2/organisations/${who.orgId}/airspace/authorizations`)).json().find((a: any) => a.id === id);

beforeAll(async () => {
  authority = await startMockAuthority({ key: KEY, decide: (plan) => (mode === 'review' ? { status: 'pending' } : mode === 'reject' ? { status: 'rejected', reason: 'Aerodrome closed' } : { status: 'approved', reason: 'No conflicting operations' }) });
  s = await startServer({
    config: { utmAuthority: { name: 'Mock UTM', url: `${authority.url}/`, key: KEY, pollSeconds: 3600 } },
    // Polled by the tests themselves.
    authorityPollMs: 3_600_000,
    fetchImpl: undefined,
  });
  owner = await signup(s.app, { organisationName: 'Acme Drones' });
  other = await signup(s.app, { organisationName: 'Other Operator' });
  droneId = (await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: 'Falcon', model: 'X4', serial: 'SN-42' })).json().id;
  // Webhook events of the organisation, as the dispatcher emits them.
  const emit = s.ctx.webhooks.emit.bind(s.ctx.webhooks);
  s.ctx.webhooks.emit = (orgId: string, event: any, data: any) => {
    if (orgId === owner.orgId && event === 'authorization.updated') hooks.push({ event, status: data.authorization.status });
    return emit(orgId, event, data);
  };
});

afterAll(async () => {
  await s.close();
  await authority.close();
});

beforeEach(() => {
  mode = 'approve';
  authority.failWith(null);
  hooks.length = 0;
});

describe('external flight authority (UTM) integration', () => {
  it('reads its configuration and refuses a bad one', () => {
    expect(parseUtmAuthority({})).toBeNull();
    expect(parseUtmAuthority({ ATHENA_UTM_AUTHORITY_URL: 'https://utm.example/api', ATHENA_UTM_AUTHORITY_NAME: 'Altitude Angel bridge', ATHENA_UTM_AUTHORITY_KEY: 'k' })).toEqual({ name: 'Altitude Angel bridge', url: 'https://utm.example/api', key: 'k', pollSeconds: 15 });
    expect(() => parseUtmAuthority({ ATHENA_UTM_AUTHORITY_URL: 'ftp://utm.example' })).toThrow(/http/);
    expect(() => parseUtmAuthority({ ATHENA_UTM_AUTHORITY_URL: 'not a url' })).toThrow(/valid URL/);
  });

  it('reads the answers of an authority strictly', () => {
    expect(decisionOf({ id: 'A1', status: 'Authorised', reason: ' ok ', publicUrl: 'https://map.example/A1' })).toEqual({ id: 'A1', status: 'approved', reason: 'ok', publicUrl: 'https://map.example/A1' });
    expect(decisionOf({ status: 'withdrawn' }, 'A1')).toMatchObject({ id: 'A1', status: 'cancelled' });
    // Only http(s) links are kept (no javascript: links into the web app).
    expect(decisionOf({ id: 'A1', status: 'pending', publicUrl: 'javascript:alert(1)' }).publicUrl).toBeNull();
    expect(() => decisionOf({ id: 'A1', status: 'maybe' })).toThrow(/unknown status/);
    expect(() => decisionOf({ status: 'approved' })).toThrow(/no flight plan id/);
    expect(() => decisionOf('nope')).toThrow(/JSON object/);
  });

  it('submits a request as a flight plan and applies the immediate approval', async () => {
    const res = await request(owner, { droneId });
    expect(res.statusCode).toBe(201);
    const a = res.json();
    expect(a).toMatchObject({ status: 'approved', authority: 'Mock UTM', authorityState: 'submitted', authorityError: null, decisionReason: 'Approved by Mock UTM: No conflicting operations' });
    expect(a.approvedAt).not.toBeNull();
    const plan = authority.plans.get(a.authorityRef)!;
    expect(plan.plan).toMatchObject({
      reference: a.reference,
      operator: { organisation: 'Acme Drones' },
      drone: { name: 'Falcon', serial: 'SN-42' },
      volume: { kind: 'cylinder', radiusM: 300 },
      maxAltM: 100,
      minAltM: 0,
      altitudeReference: 'takeoff',
      startAt: a.startAt,
      endAt: a.endAt,
      public: true,
    });
    const ring = plan.plan.geojson.geometry.coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(ring.length).toBe(65);
    // The authority publishes it on its own safety map; the web app links to it.
    expect(a.authorityUrl).toBe(`${authority.url}/map#${a.authorityRef}`);
    const map = await (await fetch(`${authority.url}/map`)).text();
    expect(map).toContain(a.reference);
    // Created (pending) then approved, as two webhook events.
    expect(hooks.map((h) => h.status)).toEqual(['pending', 'approved']);
    // In effect: the airspace is reserved for other operators too.
    const theirs = (await request(other)).json();
    expect(theirs.status).toBe('rejected');
    expect(authority.plans.has(theirs.authorityRef ?? '')).toBe(false);
    await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/airspace/authorizations/${a.id}/cancel`);
  });

  it('waits for a decision the authority takes later, which only it can take', async () => {
    mode = 'review';
    const a = (await request(owner, { geometry: { kind: 'cylinder', center: destinationPoint(HOME, 0, 5000), radiusM: 200 } })).json();
    expect(a).toMatchObject({ status: 'pending', authority: 'Mock UTM', authorityState: 'submitted', decisionReason: 'Submitted to Mock UTM – awaiting its decision' });
    const decide = await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/airspace/authorizations/${a.id}/decision`, { decision: 'approve' });
    expect(decide.statusCode).toBe(409);
    expect(decide.json().message).toMatch(/decided by Mock UTM/);
    expect((await s.app.inject({ method: 'GET', url: '/api/v2/airspace/authority', headers: { cookie: owner.cookie } })).json()).toMatchObject({ configured: true, name: 'Mock UTM', origin: authority.url, pending: 1, lastError: null });
    await s.ctx.authority.poll();
    expect((await get(owner, a.id)).status).toBe('pending');
    authority.setStatus(a.authorityRef, 'approved', 'Cleared by the tower');
    await s.ctx.authority.poll();
    const after = await get(owner, a.id);
    expect(after).toMatchObject({ status: 'approved', decisionReason: 'Approved by Mock UTM: Cleared by the tower' });
    const notes = (await api(s.app, owner)('GET', `/api/v2/organisations/${owner.orgId}/notifications`)).json();
    expect(notes.items.map((n: any) => n.title)).toContain(`Flight authorisation ${a.reference} approved by Mock UTM`);
    // Withdrawn by the authority later (e.g. a new restriction): cancelled here, the approval kept.
    authority.setStatus(a.authorityRef, 'cancelled', 'Emergency services operation');
    await s.ctx.authority.poll();
    const gone = await get(owner, a.id);
    expect(gone).toMatchObject({ status: 'cancelled', cancelReason: 'Withdrawn by Mock UTM: Emergency services operation', cancelledBy: null, authorityState: 'closed' });
    expect(gone.approvedAt).toBe(after.approvedAt);
  });

  it('applies a rejection, and never submits what the local checks refuse', async () => {
    mode = 'reject';
    const a = (await request(owner, { geometry: { kind: 'cylinder', center: destinationPoint(HOME, 90, 5000), radiusM: 200 } })).json();
    expect(a).toMatchObject({ status: 'rejected', decisionReason: 'Rejected by Mock UTM: Aerodrome closed', authorityState: 'closed' });
    await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/airspace/zones`, {
      name: 'Prison',
      type: 'prohibited',
      geometry: { kind: 'circle', center: destinationPoint(HOME, 180, 5000), radiusM: 300 },
      floorM: 0,
      ceilingM: 500,
    });
    const plans = authority.plans.size;
    const blocked = (await request(owner, { geometry: { kind: 'cylinder', center: destinationPoint(HOME, 180, 5000), radiusM: 200 } })).json();
    expect(blocked).toMatchObject({ status: 'rejected', authority: null, authorityState: null });
    expect(blocked.decisionReason).toMatch(/^Automatically rejected/);
    expect(authority.plans.size).toBe(plans);
  });

  it('keeps a request pending while the authority cannot be reached and submits it later', async () => {
    authority.failWith(503);
    const a = (await request(owner, { geometry: { kind: 'cylinder', center: destinationPoint(HOME, 270, 5000), radiusM: 200 } })).json();
    expect(a).toMatchObject({ status: 'pending', authorityState: 'submitting', authorityRef: null });
    expect(a.authorityError).toMatch(/HTTP 503/);
    expect((await s.app.inject({ method: 'GET', url: '/api/v2/airspace/authority', headers: { cookie: owner.cookie } })).json().lastError).toMatch(/HTTP 503/);
    authority.failWith(null);
    await s.ctx.authority.poll();
    expect(await get(owner, a.id)).toMatchObject({ status: 'approved', authorityState: 'submitted', authorityError: null });
  });

  it('withdraws the flight plan when the request is cancelled here, also once the authority is back', async () => {
    const a = (await request(owner, { geometry: { kind: 'cylinder', center: destinationPoint(HOME, 45, 5000), radiusM: 200 } })).json();
    expect(a.status).toBe('approved');
    authority.failWith(503);
    const c = (await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/airspace/authorizations/${a.id}/cancel`)).json();
    expect(c.status).toBe('cancelled');
    await s.ctx.authority.poll();
    expect((await get(owner, a.id)).authorityState).toBe('cancelling');
    expect(authority.plans.get(a.authorityRef)!.status).toBe('approved');
    authority.failWith(null);
    await s.ctx.authority.poll();
    expect((await get(owner, a.id)).authorityState).toBe('closed');
    expect(authority.plans.get(a.authorityRef)!.status).toBe('cancelled');
  });

  it('rejects a request left undecided past its window and withdraws it there', async () => {
    mode = 'review';
    const a = (await request(owner, { geometry: { kind: 'cylinder', center: destinationPoint(HOME, 135, 5000), radiusM: 200 } })).json();
    s.ctx.db.run('UPDATE authorizations SET end_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), a.id);
    await s.ctx.authority.poll();
    expect(await get(owner, a.id)).toMatchObject({ status: 'rejected', decisionReason: 'No decision from Mock UTM before the window ended', authorityState: 'closed' });
    expect(authority.plans.get(a.authorityRef)!.status).toBe('cancelled');
  });

  it('cannot use an approval for airspace another operator reserved meanwhile', async () => {
    mode = 'review';
    const where = { geometry: { kind: 'cylinder', center: destinationPoint(HOME, 225, 5000), radiusM: 200 } };
    const mine = (await request(owner, where)).json();
    const theirs = (await request(other, where)).json();
    expect([mine.status, theirs.status]).toEqual(['pending', 'pending']);
    authority.setStatus(theirs.authorityRef, 'approved');
    await s.ctx.authority.poll();
    expect((await get(other, theirs.id)).status).toBe('approved');
    // The authority (wrongly) approves the overlapping plan too: refused here and withdrawn there.
    authority.setStatus(mine.authorityRef, 'approved');
    await s.ctx.authority.poll();
    const after = await get(owner, mine.id);
    expect(after.status).toBe('rejected');
    expect(after.decisionReason).toMatch(/^Approved by Mock UTM, but .*reserved/);
    expect(authority.plans.get(mine.authorityRef)!.status).toBe('cancelled');
  });

  it('describes a corridor as a closed polygon', () => {
    const ring = volumeRing({ kind: 'corridor', line: [HOME, destinationPoint(HOME, 90, 1000)], widthM: 100 });
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(ring.length).toBeGreaterThan(10);
  });
});

describe('without a flight authority', () => {
  it('reports none and decides requests itself', async () => {
    const plain = await startServer();
    try {
      const me = await signup(plain.app);
      expect((await plain.app.inject({ method: 'GET', url: '/api/v2/airspace/authority', headers: { cookie: me.cookie } })).json()).toMatchObject({ configured: false, name: null, pending: 0 });
      const a = (
        await api(plain.app, me)('POST', `/api/v2/organisations/${me.orgId}/airspace/authorizations`, { geometry: { kind: 'cylinder', center: HOME, radiusM: 300 }, maxAltM: 100, ...window() })
      ).json();
      expect(a).toMatchObject({ status: 'approved', authority: null, authorityState: null, decisionReason: 'Automatically approved – no conflicts' });
    } finally {
      await plain.close();
    }
  });
});
