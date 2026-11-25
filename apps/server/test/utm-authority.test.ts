import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockAuthority, type MockAuthority } from '@athena-sky/simulator';
import { destinationPoint } from '@athena-sky/shared';
import { parseUtmAuthority } from '../src/config';
import { HttpFlightAuthority, authorityId, decisionOf, volumeRing, type AuthorityDecision, type FlightAuthority } from '../src/airspace/authority';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, cookieHeader, signup, startServer, waitFor, type Session, type TestServer } from './helpers';

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Counts the calls the server makes to an authority, and the most under way at once – as the
 * server sees them (a call ends when the server stops waiting for it, e.g. at its time limit).
 */
function counting(inner: FlightAuthority) {
  const seen = { calls: 0, active: 0, max: 0, order: [] as string[] };
  const count = async <R>(method: string, call: () => Promise<R>): Promise<R> => {
    seen.calls++;
    seen.order.push(method);
    seen.max = Math.max(seen.max, ++seen.active);
    try {
      return await call();
    } finally {
      seen.active--;
    }
  };
  const authority: FlightAuthority = {
    id: inner.id,
    name: inner.name,
    origin: inner.origin,
    submit: (plan) => count('submit', () => inner.submit(plan)),
    get: (id) => count('get', () => inner.get(id)),
    find: (reference) => count('find', () => inner.find(reference)),
    cancelByReference: (reference) => count('cancelByReference', () => inner.cancelByReference(reference)),
    cancel: (id) => count('cancel', () => inner.cancel(id)),
  };
  return {
    authority,
    seen,
    reset() {
      seen.calls = 0;
      seen.max = seen.active;
      seen.order.length = 0;
    },
  };
}

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
    // Paths are appended to the address: no query or fragment; keys go in ATHENA_UTM_AUTHORITY_KEY.
    expect(() => parseUtmAuthority({ ATHENA_UTM_AUTHORITY_URL: 'https://utm.example/api?tenant=1' })).toThrow(/query string/);
    expect(() => parseUtmAuthority({ ATHENA_UTM_AUTHORITY_URL: 'https://utm.example/api#x' })).toThrow(/fragment/);
    expect(() => parseUtmAuthority({ ATHENA_UTM_AUTHORITY_URL: 'http://127.0.0.1:4711?' })).toThrow(/query string/);
    expect(() => parseUtmAuthority({ ATHENA_UTM_AUTHORITY_URL: 'http://127.0.0.1:4711/api#' })).toThrow(/fragment/);
    expect(() => parseUtmAuthority({ ATHENA_UTM_AUTHORITY_URL: 'https://u:p@utm.example/api' })).toThrow(/credentials/);
  });

  it('reads the answers of an authority strictly', () => {
    expect(decisionOf({ id: 'A1', status: 'Authorised', reason: ' ok ', publicUrl: 'https://map.example/A1' })).toEqual({ id: 'A1', status: 'approved', reason: 'ok', publicUrl: 'https://map.example/A1', reference: null });
    // The reference it was submitted with, when the authority states it.
    expect(decisionOf({ id: 'A1', status: 'pending', reference: 'ATH-1A2B3C4D' }).reference).toBe('ATH-1A2B3C4D');
    expect(decisionOf({ id: 'A1', status: 'pending', reference: 42 }).reference).toBeNull();
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
    expect(a).toMatchObject({ status: 'pending', authority: 'Mock UTM', authorityState: 'submitted', authorityDecides: true, decisionReason: "Awaiting the flight authority's decision" });
    const decide = await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/airspace/authorizations/${a.id}/decision`, { decision: 'approve' });
    expect(decide.statusCode).toBe(409);
    expect(decide.json().message).toMatch(/decided by Mock UTM/);
    expect((await api(s.app, owner)('GET', `/api/v2/organisations/${owner.orgId}/airspace/authority`)).json()).toMatchObject({ configured: true, name: 'Mock UTM', origin: authority.url, pending: 1, lastError: null });
    // Another organisation sees none of it.
    expect((await api(s.app, other)('GET', `/api/v2/organisations/${other.orgId}/airspace/authority`)).json()).toMatchObject({ configured: true, pending: 0, lastError: null });
    expect((await api(s.app, other)('GET', `/api/v2/organisations/${owner.orgId}/airspace/authority`)).statusCode).toBe(404);
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
    expect((await api(s.app, owner)('GET', `/api/v2/organisations/${owner.orgId}/airspace/authority`)).json().lastError).toMatch(/HTTP 503/);
    // The authority's answer to this organisation's request is not shown to another one.
    expect((await api(s.app, other)('GET', `/api/v2/organisations/${other.orgId}/airspace/authority`)).json().lastError).toBeNull();
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

  it('follows every open exchange, however many there are', async () => {
    // More open exchanges than one page of the poll: the newest are followed too.
    const at = (i: number) => destinationPoint(destinationPoint(HOME, 315, 20_000), (i * 37) % 360, 2_000 + (i % 7) * 900);
    const ids: string[] = [];
    for (let i = 0; i < 205; i++) {
      const a = (await request(owner, { geometry: { kind: 'cylinder', center: at(i), radiusM: 50 }, ...window(24 * 60) })).json();
      expect(a.status).toBe('approved');
      ids.push(a.id);
    }
    mode = 'review';
    const late = (await request(owner, { geometry: { kind: 'cylinder', center: destinationPoint(HOME, 315, 40_000), radiusM: 50 } })).json();
    expect(late.status).toBe('pending');
    const newest = (await get(owner, ids[ids.length - 1]!)).authorityRef;
    authority.setStatus(late.authorityRef, 'approved');
    authority.setStatus(newest, 'cancelled', 'Temporary restriction');
    await s.ctx.authority.poll();
    expect((await get(owner, late.id)).status).toBe('approved');
    expect(await get(owner, ids[ids.length - 1]!)).toMatchObject({ status: 'cancelled', cancelReason: 'Withdrawn by Mock UTM: Temporary restriction' });
    for (const id of ids.slice(0, -1)) await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/airspace/authorizations/${id}/cancel`);
    await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/airspace/authorizations/${late.id}/cancel`);
  });

  it("keeps the reference authority's console to its operator; its public map stays open", async () => {
    expect((await fetch(`${authority.url}/`)).status).toBe(401);
    expect((await fetch(`${authority.url}/?key=${KEY}`)).status).toBe(200);
    expect((await fetch(`${authority.url}/map`)).status).toBe(200);
    const decide = (q: string) => fetch(`${authority.url}/flight-plans/FP-NONE/decision${q}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"status":"approved"}' });
    expect((await decide('')).status).toBe(401);
    expect((await decide(`?key=${KEY}`)).status).toBe(404);
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
      expect((await api(plain.app, me)('GET', `/api/v2/organisations/${me.orgId}/airspace/authority`)).json()).toMatchObject({ configured: false, name: null, pending: 0 });
      const a = (
        await api(plain.app, me)('POST', `/api/v2/organisations/${me.orgId}/airspace/authorizations`, { geometry: { kind: 'cylinder', center: HOME, radiusM: 300 }, maxAltM: 100, ...window() })
      ).json();
      expect(a).toMatchObject({ status: 'approved', authority: null, authorityState: null, decisionReason: 'Automatically approved – no conflicts' });
    } finally {
      await plain.close();
    }
  });
});

describe('lost answers and a renamed authority', () => {
  it('never leaves a second plan behind when an answer is lost, and withdraws a plan whose answer never came', async () => {
    const slow = await startMockAuthority({ decide: 'approve', submitDelayMs: 600 });
    // Gives up on an answer after 200 ms: the authority has the plan by then.
    const server = await startServer({ authority: new HttpFlightAuthority({ name: 'Slow UTM', url: slow.url, timeoutMs: 200 }), authorityPollMs: 3_600_000 });
    try {
      const me = await signup(server.app);
      const call = api(server.app, me);
      const body = (center: { lat: number; lon: number }) => ({ geometry: { kind: 'cylinder', center, radiusM: 200 }, maxAltM: 100, ...window() });
      const a = (await call('POST', `/api/v2/organisations/${me.orgId}/airspace/authorizations`, body(HOME))).json();
      expect(a).toMatchObject({ status: 'pending', authorityState: 'submitting', authorityRef: null });
      expect(a.authorityError).toMatch(/no answer in time/);
      expect(slow.plans.size).toBe(1);
      // Sent again: the authority returns the plan it already has (the reference is the key).
      await server.ctx.authority.poll();
      const after = (await call('GET', `/api/v2/organisations/${me.orgId}/airspace/authorizations`)).json().find((x: any) => x.id === a.id);
      expect(after).toMatchObject({ status: 'approved', authorityState: 'submitted', authorityRef: [...slow.plans.keys()][0] });
      expect(slow.plans.size).toBe(1);
      // Cancelled before any answer came: the plan the authority made is found by its reference and withdrawn.
      const b = (await call('POST', `/api/v2/organisations/${me.orgId}/airspace/authorizations`, body(destinationPoint(HOME, 90, 5000)))).json();
      expect(b.authorityRef).toBeNull();
      const made = [...slow.plans.values()].find((p) => p.plan.reference === b.reference)!;
      expect(made.status).toBe('approved');
      await call('POST', `/api/v2/organisations/${me.orgId}/airspace/authorizations/${b.id}/cancel`);
      await waitFor(() => made.status === 'cancelled');
      expect((await call('GET', `/api/v2/organisations/${me.orgId}/airspace/authorizations`)).json().find((x: any) => x.id === b.id)).toMatchObject({ status: 'cancelled', authorityState: 'closed' });
    } finally {
      await server.close();
      await slow.close();
    }
  });

  it('keeps following the open exchanges when the authority is renamed', async () => {
    const auth = await startMockAuthority({ decide: (plan) => (plan.maxAltM > 100 ? { status: 'pending' } : { status: 'approved' }) });
    const dataDir = mkdtempSync(join(tmpdir(), 'athena-authority-'));
    try {
      const first = await startServer({ dataDir, config: { utmAuthority: { name: 'External UTM', url: auth.url, key: null, pollSeconds: 3600 } }, authorityPollMs: 3_600_000 });
      const me = await signup(first.app);
      const req = (maxAltM: number, center: { lat: number; lon: number }) =>
        api(first.app, me)('POST', `/api/v2/organisations/${me.orgId}/airspace/authorizations`, { geometry: { kind: 'cylinder', center, radiusM: 200 }, maxAltM, ...window() });
      const approved = (await req(80, HOME)).json();
      const pending = (await req(110, destinationPoint(HOME, 0, 5000))).json();
      expect([approved.status, pending.status]).toEqual(['approved', 'pending']);
      await first.close();
      // Same address, another display name.
      const second = await startServer({ dataDir, port: 0, config: { utmAuthority: { name: 'Altitude Angel bridge', url: `${auth.url}/`, key: null, pollSeconds: 3600 } }, authorityPollMs: 3_600_000 });
      try {
        const login = await second.app.inject({ method: 'POST', url: '/api/v2/auth/login', payload: { email: me.email, password: 'correct-horse-battery' } });
        const call2 = api(second.app, { ...me, cookie: cookieHeader(login.headers['set-cookie']), csrf: login.json().csrfToken });
        // Still decided by the authority: the organisation cannot approve it itself.
        expect((await call2('POST', `/api/v2/organisations/${me.orgId}/airspace/authorizations/${pending.id}/decision`, { decision: 'approve' })).statusCode).toBe(409);
        const list = (await call2('GET', `/api/v2/organisations/${me.orgId}/airspace/authorizations`)).json();
        expect(list.find((x: any) => x.id === pending.id).authority).toBe('Altitude Angel bridge');
        // A cancellation is still passed on.
        await call2('POST', `/api/v2/organisations/${me.orgId}/airspace/authorizations/${approved.id}/cancel`);
        await waitFor(() => auth.plans.get(approved.authorityRef)!.status === 'cancelled');
        auth.setStatus(pending.authorityRef, 'approved');
        await second.ctx.authority.poll();
        expect((await call2('GET', `/api/v2/organisations/${me.orgId}/airspace/authorizations`)).json().find((x: any) => x.id === pending.id).status).toBe('approved');
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      await auth.close();
    }
  });

  it('knows an authority by its address', () => {
    expect(authorityId('https://user:pw@UTM.example:8443/api/v1/?key=x#f')).toBe('https://utm.example:8443/api/v1');
    expect(authorityId('http://127.0.0.1:4700')).toBe(authorityId('http://127.0.0.1:4700/'));
  });
});

describe('withdrawing plans whose answer never came', () => {
  const windowBody = (center: { lat: number; lon: number }) => ({ geometry: { kind: 'cylinder', center, radiusM: 200 }, maxAltM: 100, ...window() });

  it('withdraws by reference, also a plan a slow authority makes after the server gave up', async () => {
    const slow = await startMockAuthority({ decide: 'approve', processDelayMs: 600 });
    const server = await startServer({ authority: new HttpFlightAuthority({ name: 'Slow UTM', url: slow.url, timeoutMs: 200 }), authorityPollMs: 3_600_000 });
    try {
      const me = await signup(server.app);
      const call = api(server.app, me);
      const a = (await call('POST', `/api/v2/organisations/${me.orgId}/airspace/authorizations`, windowBody(HOME))).json();
      expect(a.authorityError).toMatch(/no answer in time/);
      // Cancelled before the authority has even stored the plan.
      expect(slow.plans.size).toBe(0);
      await call('POST', `/api/v2/organisations/${me.orgId}/airspace/authorizations/${a.id}/cancel`);
      await waitFor(async () => (await call('GET', `/api/v2/organisations/${me.orgId}/airspace/authorizations`)).json().find((x: any) => x.id === a.id).authorityState === 'closed');
      // The authority stores it afterwards – withdrawn, as its reference was.
      await waitFor(() => slow.plans.size === 1);
      expect([...slow.plans.values()][0]).toMatchObject({ status: 'cancelled' });
    } finally {
      await server.close();
      await slow.close();
    }
  });

  it('cancelled while a resubmission is under way: no stale error, withdrawn as soon as that call ends', async () => {
    const slow = await startMockAuthority({ decide: 'approve', processDelayMs: 600 });
    const server = await startServer({ authority: new HttpFlightAuthority({ name: 'Slow UTM', url: slow.url, timeoutMs: 200 }), authorityPollMs: 3_600_000 });
    try {
      const me = await signup(server.app);
      const call = api(server.app, me);
      const a = (await call('POST', `/api/v2/organisations/${me.orgId}/airspace/authorizations`, windowBody(HOME))).json();
      expect(a.authorityError).toMatch(/no answer in time/);
      // A poll sends it again (and will not get an answer either) …
      const polling = server.ctx.authority.poll();
      await new Promise((r) => setTimeout(r, 50));
      // … while it is cancelled.
      const c = (await call('POST', `/api/v2/organisations/${me.orgId}/airspace/authorizations/${a.id}/cancel`)).json();
      expect(c).toMatchObject({ status: 'cancelled', authorityState: 'cancelling', authorityError: null });
      await polling;
      const row = async () => (await call('GET', `/api/v2/organisations/${me.orgId}/airspace/authorizations`)).json().find((x: any) => x.id === a.id);
      // The failed resubmission's error is not put on the cancelled request …
      expect((await row()).authorityError).toBeNull();
      // … and the withdrawal follows at once, not at the next poll.
      await waitFor(async () => (await row()).authorityState === 'closed');
      await waitFor(() => slow.plans.size === 1);
      expect([...slow.plans.values()][0]!.status).toBe('cancelled');
    } finally {
      await server.close();
      await slow.close();
    }
  });

  it('gives a slow authority no more calls than the poll allows: no resubmission right after a lost answer, at most 8 at once', async () => {
    const slow = await startMockAuthority({ decide: 'approve', processDelayMs: 600 });
    const counted = counting(new HttpFlightAuthority({ name: 'Slow UTM', url: slow.url, timeoutMs: 150 }));
    const server = await startServer({ authority: counted.authority, authorityPollMs: 3_600_000 });
    try {
      const me = await signup(server.app);
      const call = api(server.app, me);
      const posts = () => slow.calls.filter((c) => c.method === 'POST').length;
      // Twelve requests at once, each submitted (no answer in time) while a poll comes by.
      const created = Promise.all(Array.from({ length: 12 }, (_, i) => call('POST', `/api/v2/organisations/${me.orgId}/airspace/authorizations`, windowBody(destinationPoint(HOME, i * 30, 2000)))));
      await sleep(30);
      await server.ctx.authority.poll();
      for (const r of await created) expect(r.json().authorityError).toMatch(/no answer in time/);
      // Members' submissions too: never more than 8 calls at once (the other four waited their turn).
      expect(counted.seen.max).toBe(8);
      // The poll found them busy and left them to the next poll: no second submission right away.
      await sleep(450);
      expect(posts()).toBe(12);
      expect(counted.seen.calls).toBe(12);
      // The next poll submits each again – at most 8 at a time – and nothing follows it at once.
      slow.resetCalls();
      counted.reset();
      await server.ctx.authority.poll();
      expect(posts()).toBe(12);
      expect(counted.seen).toMatchObject({ calls: 12, max: 8 });
      await sleep(450);
      expect(posts()).toBe(12);
      expect(counted.seen.calls).toBe(12);
    } finally {
      await server.close();
      await slow.close();
    }
  });

  it("members go first: a withdrawal asked for while the poll waits for a place is made before the poll's calls – never as a ninth", async () => {
    const slow = await startMockAuthority({ decide: 'approve', processDelayMs: 1000 });
    const counted = counting(new HttpFlightAuthority({ name: 'Slow UTM', url: slow.url, timeoutMs: 400 }));
    const server = await startServer({ authority: counted.authority, authorityPollMs: 3_600_000 });
    try {
      const me = await signup(server.app);
      const call = api(server.app, me);
      const path = `/api/v2/organisations/${me.orgId}/airspace/authorizations`;
      const create = (n: number, from: number) => Promise.all(Array.from({ length: n }, (_, i) => call('POST', path, windowBody(destinationPoint(HOME, (from + i) * 20, 2500)))));
      // Nine requests whose submissions got no answer: the poll's first round is the oldest eight.
      await create(8, 0);
      const x = (await create(1, 8))[0]!.json().id as string;
      counted.reset();
      // Eight new requests take every place …
      const newer = create(8, 9);
      await waitFor(() => counted.seen.active === 8, 5000, 5);
      // … so the poll's first round waits for places, and so does the withdrawal of the ninth request.
      const polling = server.ctx.authority.poll();
      expect((await call('POST', `${path}/${x}/cancel`)).json()).toMatchObject({ status: 'cancelled', authorityState: 'cancelling' });
      expect(counted.seen.active).toBe(8);
      await newer;
      await polling;
      // Never more than eight calls at once, and the member's withdrawal went before the poll's calls.
      expect(counted.seen.max).toBe(8);
      expect(counted.seen.order.slice(0, 10)).toEqual([...Array<string>(8).fill('submit'), 'cancelByReference', 'submit']);
      await waitFor(async () => (await call('GET', path)).json().find((r: any) => r.id === x).authorityState === 'closed', 5000);
    } finally {
      await server.close();
      await slow.close();
    }
  });

  it('a slow call holds up only its own place in the poll – the other exchanges go on', async () => {
    let slowRef: string | null = null;
    const checked: { id: string; at: number }[] = [];
    const decision = (id: string): AuthorityDecision => ({ id, status: 'pending', reason: null, publicUrl: null, reference: null });
    const stub: FlightAuthority = {
      id: 'http://stub.invalid',
      name: 'Stub UTM',
      origin: 'http://stub.invalid',
      submit: async (plan) => decision(`FP-${plan.reference}`),
      get: async (id) => {
        checked.push({ id, at: Date.now() });
        await sleep(id === slowRef ? 1500 : 10);
        return decision(id);
      },
      find: async () => [],
      cancelByReference: async () => true,
      cancel: async () => undefined,
    };
    const server = await startServer({ authority: stub, authorityPollMs: 3_600_000 });
    try {
      const me = await signup(server.app);
      const call = api(server.app, me);
      const created: any[] = [];
      for (let i = 0; i < 20; i++) created.push((await call('POST', `/api/v2/organisations/${me.orgId}/airspace/authorizations`, windowBody(destinationPoint(HOME, i * 18, 2500)))).json());
      // The oldest request (the poll's first) is checked slowly.
      slowRef = created[0].authorityRef;
      const started = Date.now();
      await server.ctx.authority.poll();
      expect(checked).toHaveLength(20);
      const others = checked.filter((c) => c.id !== slowRef);
      // All nineteen others were checked while the slow one was still under way.
      expect(Math.max(...others.map((c) => c.at - started))).toBeLessThan(700);
    } finally {
      await server.close();
    }
  });

  it('records the error of a withdrawal that fails right after its exchange moved the request on', async () => {
    // Takes plans for review and refuses to withdraw them.
    let approve = false;
    const decision = (status: AuthorityDecision['status']): AuthorityDecision => ({ id: 'FP-STUB', status, reason: null, publicUrl: null, reference: null });
    const stub: FlightAuthority = {
      id: 'http://stub.invalid',
      name: 'Stub UTM',
      origin: 'http://stub.invalid',
      submit: async () => decision('pending'),
      get: async () => decision(approve ? 'approved' : 'pending'),
      find: async () => [],
      cancelByReference: async () => true,
      cancel: async () => {
        throw new Error('withdrawal refused (503)');
      },
    };
    const server = await startServer({ authority: stub, authorityPollMs: 3_600_000 });
    try {
      const me = await signup(server.app);
      const call = api(server.app, me);
      const row = async (id: string) => (await call('GET', `/api/v2/organisations/${me.orgId}/airspace/authorizations`)).json().find((x: any) => x.id === id);
      // Left undecided past its short window: rejected here, then withdrawn there – which fails.
      const now = Date.now();
      const a = (await call('POST', `/api/v2/organisations/${me.orgId}/airspace/authorizations`, { ...windowBody(HOME), startAt: new Date(now).toISOString(), endAt: new Date(now + 1500).toISOString() })).json();
      expect(a).toMatchObject({ status: 'pending', authorityState: 'submitted' });
      await new Promise((r) => setTimeout(r, 1600));
      await server.ctx.authority.poll();
      expect(await row(a.id)).toMatchObject({ status: 'rejected', authorityState: 'cancelling', authorityError: 'withdrawal refused (503)' });
      // Approved by the authority after the airspace was taken: not used, withdrawn – which fails.
      const other = await signup(server.app);
      const b = (await call('POST', `/api/v2/organisations/${me.orgId}/airspace/authorizations`, windowBody(destinationPoint(HOME, 90, 3000)))).json();
      expect(b).toMatchObject({ status: 'pending', authorityState: 'submitted' });
      server.ctx.db.run(
        `INSERT INTO authorizations (id, org_id, reference, geometry, max_alt_m, start_at, end_at, status, conflicts, is_public, created_at, decided_at, approved_at)
         VALUES ('00000000-0000-4000-8000-0000000000b7', ?, 'ATH-OTHER', ?, 120, ?, ?, 'approved', '[]', 1, ?, ?, ?)`,
        other.orgId,
        JSON.stringify(b.geometry),
        b.startAt,
        b.endAt,
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
      );
      approve = true;
      await server.ctx.authority.poll();
      expect(await row(b.id)).toMatchObject({ status: 'rejected', authorityState: 'cancelling', authorityError: 'withdrawal refused (503)' });
    } finally {
      await server.close();
    }
  });

  it('without withdrawal by reference, keeps looking for the plan until the window ends', async () => {
    const slow = await startMockAuthority({ decide: 'approve', processDelayMs: 600, noReferenceDelete: true });
    const server = await startServer({ authority: new HttpFlightAuthority({ name: 'Slow UTM', url: slow.url, timeoutMs: 200 }), authorityPollMs: 3_600_000 });
    try {
      const me = await signup(server.app);
      const call = api(server.app, me);
      const a = (await call('POST', `/api/v2/organisations/${me.orgId}/airspace/authorizations`, windowBody(HOME))).json();
      const row = async () => (await call('GET', `/api/v2/organisations/${me.orgId}/airspace/authorizations`)).json().find((x: any) => x.id === a.id);
      await call('POST', `/api/v2/organisations/${me.orgId}/airspace/authorizations/${a.id}/cancel`);
      // Nothing there yet: still withdrawing – no longer reporting the lost answer as the news.
      await waitFor(async () => (await row()).authorityError === null);
      expect(await row()).toMatchObject({ status: 'cancelled', authorityState: 'cancelling', authorityError: null, decisionReason: null });
      await waitFor(() => slow.plans.size === 1);
      expect([...slow.plans.values()][0]!.status).toBe('approved');
      await server.ctx.authority.poll();
      // Found and withdrawn (there is only one plan per reference): the exchange is over.
      expect([...slow.plans.values()][0]!.status).toBe('cancelled');
      expect(await row()).toMatchObject({ authorityState: 'closed', authorityError: null });
    } finally {
      await server.close();
      await slow.close();
    }
  });
  it("withdraws by lookup only the plan stating the request's reference – never another one the authority lists", async () => {
    // Lists all its plans whatever the reference asked for, cannot withdraw by reference, answers submissions late.
    const lax = await startMockAuthority({ decide: 'approve', submitDelayMs: 400, noReferenceDelete: true, listAll: true });
    const server = await startServer({ authority: new HttpFlightAuthority({ name: 'Lax UTM', url: lax.url, timeoutMs: 200 }), authorityPollMs: 3_600_000 });
    try {
      // Another operator's approved plan at the same authority.
      const res = await fetch(`${lax.url}/flight-plans`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reference: 'OTHER-OPERATOR-1', operator: { organisation: 'Someone Else' }, volume: { kind: 'cylinder', center: destinationPoint(HOME, 0, 6000), radiusM: 200 }, maxAltM: 100, ...window(), public: true }),
      });
      expect(res.status).toBe(201);
      const me = await signup(server.app);
      const call = api(server.app, me);
      const path = `/api/v2/organisations/${me.orgId}/airspace/authorizations`;
      // The answer to this submission is lost (the authority has stored the plan); then it is cancelled.
      const b = (await call('POST', path, windowBody(HOME))).json();
      expect(b.authorityError).toMatch(/no answer in time/);
      await call('POST', `${path}/${b.id}/cancel`);
      await waitFor(async () => (await call('GET', path)).json().find((r: any) => r.id === b.id).authorityState === 'closed', 5000);
      const plan = (reference: string) => [...lax.plans.values()].find((p) => p.plan.reference === reference)!;
      expect(plan(b.reference).status).toBe('cancelled');
      expect(plan('OTHER-OPERATOR-1').status).toBe('approved');
      // The protocol client keeps to the reference itself.
      expect((await new HttpFlightAuthority({ name: 'Lax UTM', url: lax.url }).find(b.reference)).map((p) => p.reference)).toEqual([b.reference]);
    } finally {
      await server.close();
      await lax.close();
    }
  });

  it('withdraws nothing by lookup when the authority does not state the references of its plans', async () => {
    const lax = await startMockAuthority({ decide: 'approve', submitDelayMs: 400, noReferenceDelete: true, listAll: true, unreferenced: true });
    const server = await startServer({ authority: new HttpFlightAuthority({ name: 'Lax UTM', url: lax.url, timeoutMs: 200 }), authorityPollMs: 3_600_000 });
    try {
      const me = await signup(server.app);
      const call = api(server.app, me);
      const path = `/api/v2/organisations/${me.orgId}/airspace/authorizations`;
      const b = (await call('POST', path, windowBody(HOME))).json();
      await call('POST', `${path}/${b.id}/cancel`);
      // It cannot tell its plan from others: the error is shown and the withdrawal retried.
      const row = await waitFor(async () => {
        const r = (await call('GET', path)).json().find((x: any) => x.id === b.id);
        return /does not state the references/.test(r.authorityError ?? '') && r;
      }, 5000);
      expect(row).toMatchObject({ status: 'cancelled', authorityState: 'cancelling' });
      expect([...lax.plans.values()].map((p) => p.status)).toEqual(['approved']);
    } finally {
      await server.close();
      await lax.close();
    }
  });

  it('never withdraws a plan of another reference, whatever a connector finds', async () => {
    const withdrawn: string[] = [];
    const stub: FlightAuthority = {
      id: 'http://stub.invalid',
      name: 'Stub UTM',
      origin: 'http://stub.invalid',
      submit: async () => {
        throw new Error('no answer in time');
      },
      get: async (id) => ({ id, status: 'pending', reason: null, publicUrl: null, reference: null }),
      // A connector listing a plan of another reference (or none stated).
      find: async () => [
        { id: 'FP-OTHER', status: 'approved', reason: null, publicUrl: null, reference: 'OTHER-OPERATOR-1' },
        { id: 'FP-UNKNOWN', status: 'approved', reason: null, publicUrl: null, reference: null },
      ],
      cancelByReference: async () => false,
      cancel: async (id) => {
        withdrawn.push(id);
      },
    };
    const server = await startServer({ authority: stub, authorityPollMs: 3_600_000 });
    try {
      const me = await signup(server.app);
      const call = api(server.app, me);
      const path = `/api/v2/organisations/${me.orgId}/airspace/authorizations`;
      const b = (await call('POST', path, windowBody(HOME))).json();
      expect(b).toMatchObject({ authorityState: 'submitting', authorityError: 'no answer in time' });
      await call('POST', `${path}/${b.id}/cancel`);
      // Still looking for its own plan (until the window ends) – the others are left alone.
      await waitFor(async () => (await call('GET', path)).json().find((r: any) => r.id === b.id).authorityError === null, 5000);
      await server.ctx.authority.poll();
      expect(withdrawn).toEqual([]);
      expect((await call('GET', path)).json().find((r: any) => r.id === b.id)).toMatchObject({ status: 'cancelled', authorityState: 'cancelling' });
    } finally {
      await server.close();
    }
  });
});

describe('upgrades and address changes', () => {
  it('keeps following the exchanges of the release before authorities were known by their address', async () => {
    const auth = await startMockAuthority({ decide: 'review' });
    const dataDir = mkdtempSync(join(tmpdir(), 'athena-authority-'));
    const config = { utmAuthority: { name: 'Mock UTM', url: auth.url, key: null, pollSeconds: 3600 } };
    try {
      const first = await startServer({ dataDir, config, authorityPollMs: 3_600_000 });
      const me = await signup(first.app);
      const pending = (await api(first.app, me)('POST', `/api/v2/organisations/${me.orgId}/airspace/authorizations`, { geometry: { kind: 'cylinder', center: HOME, radiusM: 200 }, maxAltM: 100, ...window() })).json();
      expect(pending.status).toBe('pending');
      // As stored by that release: known by its name only.
      first.ctx.db.run('UPDATE authorizations SET authority_id = NULL');
      await first.close();
      const second = await startServer({ dataDir, config, authorityPollMs: 3_600_000 });
      try {
        const login = await second.app.inject({ method: 'POST', url: '/api/v2/auth/login', payload: { email: me.email, password: 'correct-horse-battery' } });
        const call = api(second.app, { ...me, cookie: cookieHeader(login.headers['set-cookie']), csrf: login.json().csrfToken });
        const row = (await call('GET', `/api/v2/organisations/${me.orgId}/airspace/authorizations`)).json().find((x: any) => x.id === pending.id);
        expect(row.authorityDecides).toBe(true);
        expect((await call('GET', `/api/v2/organisations/${me.orgId}/airspace/authority`)).json().pending).toBe(1);
        expect((await call('POST', `/api/v2/organisations/${me.orgId}/airspace/authorizations/${pending.id}/decision`, { decision: 'approve' })).statusCode).toBe(409);
        auth.setStatus(pending.authorityRef, 'approved');
        await second.ctx.authority.poll();
        expect((await call('GET', `/api/v2/organisations/${me.orgId}/airspace/authorizations`)).json().find((x: any) => x.id === pending.id).status).toBe('approved');
        // A withdrawal by the authority is not lost.
        auth.setStatus(pending.authorityRef, 'cancelled', 'Emergency services operation');
        await second.ctx.authority.poll();
        expect((await call('GET', `/api/v2/organisations/${me.orgId}/airspace/authorizations`)).json().find((x: any) => x.id === pending.id)).toMatchObject({ status: 'cancelled', cancelReason: 'Withdrawn by Mock UTM: Emergency services operation' });
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      await auth.close();
    }
  });

  it('clears the errors earlier releases left on exchanges that are over (migration 20)', async () => {
    const auth = await startMockAuthority({ decide: 'review' });
    const dataDir = mkdtempSync(join(tmpdir(), 'athena-authority-'));
    const config = { utmAuthority: { name: 'Mock UTM', url: auth.url, key: null, pollSeconds: 3600 } };
    try {
      const first = await startServer({ dataDir, config, authorityPollMs: 3_600_000 });
      const me = await signup(first.app);
      const make = async (i: number) => (await api(first.app, me)('POST', `/api/v2/organisations/${me.orgId}/airspace/authorizations`, { geometry: { kind: 'cylinder', center: destinationPoint(HOME, i * 90, 2000), radiusM: 200 }, maxAltM: 100, ...window() })).json();
      const [stale, givenUp, open] = [await make(0), await make(1), await make(2)];
      // As an earlier release left them: cancelled before the submission ever got through (its
      // error kept), a withdrawal given up, and an exchange still going on.
      first.ctx.db.run("UPDATE authorizations SET status = 'cancelled', authority_state = 'closed', authority_error = 'unreachable (fetch failed)' WHERE id = ?", stale.id);
      first.ctx.db.run("UPDATE authorizations SET status = 'cancelled', authority_state = 'closed', authority_error = 'Could not withdraw the flight plan: unreachable (fetch failed)' WHERE id = ?", givenUp.id);
      first.ctx.db.run("UPDATE authorizations SET authority_error = 'unreachable (fetch failed)' WHERE id = ?", open.id);
      first.ctx.db.run('UPDATE schema_version SET version = 19');
      await first.close();
      const second = await startServer({ dataDir, config, authorityPollMs: 3_600_000 });
      try {
        const error = (id: string) => second.ctx.db.get<{ e: string | null }>('SELECT authority_error AS e FROM authorizations WHERE id = ?', id)!.e;
        expect(error(stale.id)).toBeNull();
        expect(error(givenUp.id)).toBe('Could not withdraw the flight plan: unreachable (fetch failed)');
        expect(error(open.id)).toBe('unreachable (fetch failed)');
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      await auth.close();
    }
  });

  it("withdraws an earlier release's unanswered submission cancelled right after the upgrade", async () => {
    const auth = await startMockAuthority({ decide: 'approve' });
    const dataDir = mkdtempSync(join(tmpdir(), 'athena-authority-'));
    const config = { utmAuthority: { name: 'Mock UTM', url: auth.url, key: null, pollSeconds: 3600 } };
    try {
      const first = await startServer({ dataDir, config, authorityPollMs: 3_600_000 });
      const me = await signup(first.app);
      const a = (await api(first.app, me)('POST', `/api/v2/organisations/${me.orgId}/airspace/authorizations`, { geometry: { kind: 'cylinder', center: HOME, radiusM: 200 }, maxAltM: 100, ...window() })).json();
      const plan = [...auth.plans.values()].find((p) => p.plan.reference === a.reference)!;
      expect(plan.status).toBe('approved');
      // As that release left it: the answer never came (no plan id), and it did not record that the submission went out.
      first.ctx.db.run(
        "UPDATE authorizations SET status = 'pending', approved_at = NULL, decided_at = NULL, authority_state = 'submitting', authority_ref = NULL, authority_sent = 0, authority_id = NULL, authority_error = 'no answer in time' WHERE id = ?",
        a.id,
      );
      await first.close();
      const second = await startServer({ dataDir, config, authorityPollMs: 3_600_000 });
      try {
        const login = await second.app.inject({ method: 'POST', url: '/api/v2/auth/login', payload: { email: me.email, password: 'correct-horse-battery' } });
        const call = api(second.app, { ...me, cookie: cookieHeader(login.headers['set-cookie']), csrf: login.json().csrfToken });
        // Cancelled before any poll: the plan the authority made is withdrawn by its reference.
        await call('POST', `/api/v2/organisations/${me.orgId}/airspace/authorizations/${a.id}/cancel`);
        await waitFor(() => plan.status === 'cancelled');
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      await auth.close();
    }
  });

  it('hands the requests of a former authority (another address, the same name) to the organisation', async () => {
    const a = await startMockAuthority({ decide: 'review' });
    const b = await startMockAuthority({ decide: 'review' });
    const dataDir = mkdtempSync(join(tmpdir(), 'athena-authority-'));
    try {
      const first = await startServer({ dataDir, config: { utmAuthority: { name: 'External UTM', url: a.url, key: null, pollSeconds: 3600 } }, authorityPollMs: 3_600_000 });
      const me = await signup(first.app);
      const pending = (await api(first.app, me)('POST', `/api/v2/organisations/${me.orgId}/airspace/authorizations`, { geometry: { kind: 'cylinder', center: HOME, radiusM: 200 }, maxAltM: 100, ...window() })).json();
      // The last check with it went unanswered.
      first.ctx.db.run("UPDATE authorizations SET authority_error = 'no answer in time' WHERE id = ?", pending.id);
      await first.close();
      const second = await startServer({ dataDir, config: { utmAuthority: { name: 'External UTM', url: b.url, key: null, pollSeconds: 3600 } }, authorityPollMs: 3_600_000 });
      try {
        const login = await second.app.inject({ method: 'POST', url: '/api/v2/auth/login', payload: { email: me.email, password: 'correct-horse-battery' } });
        const call = api(second.app, { ...me, cookie: cookieHeader(login.headers['set-cookie']), csrf: login.json().csrfToken });
        const row = (await call('GET', `/api/v2/organisations/${me.orgId}/airspace/authorizations`)).json().find((x: any) => x.id === pending.id);
        // The page offers the organisation's own decision for it – and tells the two authorities of the same name apart by their address.
        expect(row).toMatchObject({ status: 'pending', authority: 'External UTM', authorityOrigin: a.url, authorityDecides: false, authorityError: 'no answer in time' });
        expect((await call('GET', `/api/v2/organisations/${me.orgId}/airspace/authority`)).json()).toMatchObject({ name: 'External UTM', origin: b.url });
        const decided = await call('POST', `/api/v2/organisations/${me.orgId}/airspace/authorizations/${pending.id}/decision`, { decision: 'reject' });
        expect(decided.statusCode).toBe(200);
        // Its plan stays at the former authority, which this server can no longer reach: recorded as
        // not withdrawn. The error of the last call to it is no longer the news.
        expect(decided.json()).toMatchObject({ status: 'rejected', authorityState: 'cancelling', authorityDecides: false, authorityError: null, authorityOrigin: a.url });
        expect(a.plans.get(pending.authorityRef)!.status).toBe('pending');
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      await a.close();
      await b.close();
    }
  });
});
