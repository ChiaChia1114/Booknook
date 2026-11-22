import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { destinationPoint, type Telemetry } from '@athena-sky/shared';
import { api, signup, startServer, type Session, type TestServer } from './helpers';

const HOME = { lat: 25.0732, lon: 121.5355 };

let s: TestServer;
let owner: Session;
let call: ReturnType<typeof api>;
let droneId: string;

const tel = (p: { lat: number; lon: number }, altRel = 40, inAir = true): Telemetry =>
  ({ t: Date.now(), lat: p.lat, lon: p.lon, altMsl: altRel + 10, altRel, heading: 0, groundSpeed: 0, climbRate: 0, roll: 0, pitch: 0, yaw: 0, battery: { pct: 80, voltage: 22 }, gps: { fix: 3, sats: 12 }, mode: 'MISSION', armed: inAir, inAir }) as unknown as Telemetry;
const codes = (p: { lat: number; lon: number }, altRel = 40, now = Date.now()) => s.ctx.utm.detect(owner.orgId, droneId, 'Falcon', tel(p, altRel), now).map((d) => `${d.code}:${d.level}`);

beforeAll(async () => {
  s = await startServer();
  owner = await signup(s.app);
  call = api(s.app, owner);
  droneId = (await call('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: 'Falcon', model: 'X4' })).json().id;
  const zone = (body: Record<string, unknown>) => call('POST', `/api/v2/organisations/${owner.orgId}/airspace/zones`, body);
  // Restricted circle 1 km north, controlled polygon 1 km east, power line 1 km west, future TFR 1 km south.
  await zone({ name: 'Helipad', type: 'restricted', geometry: { kind: 'circle', center: destinationPoint(HOME, 0, 1000), radiusM: 200 }, floorM: 0, ceilingM: 100 });
  await zone({
    name: 'CTR',
    type: 'controlled',
    geometry: { kind: 'polygon', polygon: [0, 90, 180, 270].map((b) => destinationPoint(destinationPoint(HOME, 90, 1000), b + 45, 300)) },
    floorM: 0,
    ceilingM: 600,
  });
  await zone({ name: 'Power line', type: 'hazard_powerline', geometry: { kind: 'line', line: [destinationPoint(HOME, 270, 1000), destinationPoint(destinationPoint(HOME, 270, 1000), 0, 500)], bufferM: 20 }, floorM: 0, ceilingM: 60 });
  await zone({
    name: 'Stadium TFR',
    type: 'temporary',
    geometry: { kind: 'circle', center: destinationPoint(HOME, 180, 1000), radiusM: 300 },
    floorM: 0,
    ceilingM: 1000,
    activeFrom: new Date(Date.now() + 86_400_000).toISOString(),
    activeTo: new Date(Date.now() + 2 * 86_400_000).toISOString(),
  });
});

afterAll(async () => {
  await s.close();
});

describe('UTM conformance rules', () => {
  it('reports infringement inside circles (negative signed distance) and polygons, approach and hazards', () => {
    expect(codes(destinationPoint(HOME, 0, 1000))).toEqual(['zone_infringement:critical']);
    expect(codes(destinationPoint(HOME, 0, 700))).toEqual(['zone_approach:warning']);
    expect(codes(destinationPoint(HOME, 0, 500))).toEqual([]);
    expect(codes(destinationPoint(HOME, 90, 1000))).toEqual(['zone_infringement:warning']);
    // 30 m from the line = 10 m outside its 20 m buffer.
    expect(codes(destinationPoint(destinationPoint(HOME, 270, 1000), 90, 30))).toEqual(['hazard_proximity:warning']);
    expect(codes(HOME, 40)).toEqual([]);
  });

  it('respects altitude bands, activity windows and the ground', () => {
    expect(codes(destinationPoint(HOME, 0, 1000), 110)).toEqual([]);
    expect(codes(destinationPoint(destinationPoint(HOME, 270, 1000), 90, 30), 80)).toEqual([]);
    expect(codes(destinationPoint(HOME, 180, 1000))).toEqual([]);
    expect(codes(destinationPoint(HOME, 180, 1000), 40, Date.now() + 1.5 * 86_400_000)).toEqual(['zone_infringement:critical']);
    expect(s.ctx.utm.detect(owner.orgId, droneId, 'Falcon', tel(destinationPoint(HOME, 0, 1000), 0, false))).toEqual([]);
  });

  it('exempts controlled airspace covered by an approved authorisation, never restricted areas', async () => {
    const now = Date.now();
    const req = await call('POST', `/api/v2/organisations/${owner.orgId}/airspace/authorizations`, {
      geometry: { kind: 'cylinder', center: destinationPoint(HOME, 90, 1000), radiusM: 150 },
      maxAltM: 100,
      startAt: new Date(now - 60_000).toISOString(),
      endAt: new Date(now + 3_600_000).toISOString(),
    });
    expect(req.statusCode).toBe(201);
    const auth = req.json();
    if (auth.status === 'pending') {
      expect((await call('POST', `/api/v2/organisations/${owner.orgId}/airspace/authorizations/${auth.id}/decision`, { decision: 'approve' })).json().status).toBe('approved');
    }
    expect(codes(destinationPoint(HOME, 90, 1000))).toEqual([]);
    // Above the authorised altitude or outside its cylinder it is reported again.
    expect(codes(destinationPoint(HOME, 90, 1000), 110)).toEqual(['zone_infringement:warning']);
    expect(codes(destinationPoint(destinationPoint(HOME, 90, 1000), 0, 200))).toEqual(['zone_infringement:warning']);
  });

  it("never accepts another drone's authorisation", async () => {
    const now = Date.now();
    const other = (await call('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: 'Heron', model: 'X8' })).json().id;
    // Inside the controlled area, clear of the earlier authorisation (a conflicting request would be refused).
    const corner = destinationPoint(destinationPoint(HOME, 90, 1000), 135, 260);
    const req = await call('POST', `/api/v2/organisations/${owner.orgId}/airspace/authorizations`, {
      geometry: { kind: 'cylinder', center: corner, radiusM: 40 },
      maxAltM: 100,
      startAt: new Date(now - 60_000).toISOString(),
      endAt: new Date(now + 3_600_000).toISOString(),
      droneId: other,
    });
    const auth = req.json();
    expect(auth.status, JSON.stringify(auth.conflicts)).not.toBe('rejected');
    if (auth.status === 'pending') await call('POST', `/api/v2/organisations/${owner.orgId}/airspace/authorizations/${auth.id}/decision`, { decision: 'approve' });
    s.ctx.utm.invalidate(owner.orgId);
    // Covers Heron, not Falcon.
    expect(codes(corner)).toEqual(['zone_infringement:warning']);
    expect(s.ctx.utm.detect(owner.orgId, other, 'Heron', tel(corner), now).map((d) => d.code)).toEqual([]);
  });

  it("reports flying into airspace another operator has reserved (named only when public)", async () => {
    const now = Date.now();
    const rival = await signup(s.app, { name: 'Rival Ops' });
    const reserve = (center: { lat: number; lon: number }, isPublic: boolean) =>
      api(s.app, rival)('POST', `/api/v2/organisations/${rival.orgId}/airspace/authorizations`, {
        geometry: { kind: 'cylinder', center, radiusM: 100 },
        maxAltM: 80,
        startAt: new Date(now - 60_000).toISOString(),
        endAt: new Date(now + 3_600_000).toISOString(),
        isPublic,
      });
    const pub = destinationPoint(HOME, 45, 2000);
    const priv = destinationPoint(HOME, 135, 2000);
    const a = (await reserve(pub, true)).json();
    expect(a.status).toBe('approved');
    expect((await reserve(priv, false)).json().status).toBe('approved');
    s.ctx.utm.invalidate(rival.orgId);
    const inside = s.ctx.utm.detect(owner.orgId, droneId, 'Falcon', tel(pub), Date.now());
    expect(inside.map((d) => `${d.code}:${d.level}`)).toEqual(['reservation_infringement:critical']);
    expect(inside[0]!.message).toContain(a.reference);
    const hidden = s.ctx.utm.detect(owner.orgId, droneId, 'Falcon', tel(priv), Date.now());
    expect(hidden.map((d) => d.code)).toEqual(['reservation_infringement']);
    expect(hidden[0]!.message).toContain('another operator');
    expect(hidden[0]!.message).not.toContain('Rival');
    // Above the reserved altitude, outside the cylinder or for the holder itself: nothing.
    expect(codes(pub, 90)).toEqual([]);
    expect(codes(destinationPoint(pub, 0, 150))).toEqual([]);
    expect(s.ctx.utm.detect(rival.orgId, droneId, 'Falcon', tel(pub), Date.now())).toEqual([]);
    // A check of our own over the private reservation names nothing that identifies it.
    const check = (await call('POST', `/api/v2/organisations/${owner.orgId}/airspace/check`, {
      geometry: { kind: 'cylinder', center: priv, radiusM: 50 },
      maxAltM: 60,
      startAt: new Date(now).toISOString(),
      endAt: new Date(now + 1_800_000).toISOString(),
    })).json();
    expect(check.verdict).toBe('blocked');
    expect(check.conflicts[0]).toEqual({ kind: 'reservation', severity: 'blocking', name: 'Reserved airspace', message: expect.stringContaining('another operator') });
    // Cancelling a reservation takes effect for the live monitor at once.
    expect((await api(s.app, rival)('POST', `/api/v2/organisations/${rival.orgId}/airspace/authorizations/${a.id}/cancel`)).json()).toMatchObject({ status: 'cancelled', decisionReason: 'Cancelled by Rival Ops' });
    expect(codes(pub)).toEqual([]);
  });

  it("treats the organisation's own reservations as permission, another drone's as needing review", async () => {
    const now = Date.now();
    const window = { startAt: new Date(now - 60_000).toISOString(), endAt: new Date(now + 3_600_000).toISOString() };
    const heron = (await call('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: 'Kite', model: 'X4' })).json().id;
    const site = destinationPoint(HOME, 225, 2500);
    const geometry = { kind: 'cylinder', center: site, radiusM: 120 };
    const first = (await call('POST', `/api/v2/organisations/${owner.orgId}/airspace/authorizations`, { geometry, maxAltM: 60, droneId, ...window })).json();
    expect(first.status).toBe('approved');
    // Same drone again: covered by our own reservation – approved.
    expect((await call('POST', `/api/v2/organisations/${owner.orgId}/airspace/authorizations`, { geometry, maxAltM: 60, droneId, ...window })).json().status).toBe('approved');
    // Another of our drones in the same volume and time: a manager decides.
    const second = (await call('POST', `/api/v2/organisations/${owner.orgId}/airspace/authorizations`, { geometry, maxAltM: 60, droneId: heron, ...window })).json();
    expect(second.status).toBe('pending');
    // Both approved reservations of Falcon overlap it.
    expect(second.conflicts.map((c: any) => `${c.kind}:${c.severity}`)).toEqual(['reservation:review', 'reservation:review']);
    expect(second.conflicts[0].message).toContain('Falcon');
    const ok = await call('POST', `/api/v2/organisations/${owner.orgId}/airspace/authorizations/${second.id}/decision`, { decision: 'approve' });
    expect(ok.json().status).toBe('approved');
    // A volume check without a drone: our own airspace is clear; for a drone, others' reservations need review.
    const check = (extra: Record<string, unknown>) => call('POST', `/api/v2/organisations/${owner.orgId}/airspace/check`, { geometry, maxAltM: 60, ...window, ...extra });
    expect((await check({})).json()).toEqual({ verdict: 'clear', conflicts: [] });
    const third = (await call('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: 'Wren', model: 'X4' })).json().id;
    expect((await check({ droneId: third })).json().verdict).toBe('review');
  });

  it('reports the organisation altitude limit', async () => {
    await call('PATCH', `/api/v2/organisations/${owner.orgId}`, { settings: { maxAltitudeM: 50 } });
    expect(codes(HOME, 60)).toEqual(['altitude_limit:warning']);
    expect(codes(HOME, 45)).toEqual([]);
  });
});
