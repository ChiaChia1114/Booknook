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

  it('reports the organisation altitude limit', async () => {
    await call('PATCH', `/api/v2/organisations/${owner.orgId}`, { settings: { maxAltitudeM: 50 } });
    expect(codes(HOME, 60)).toEqual(['altitude_limit:warning']);
    expect(codes(HOME, 45)).toEqual([]);
  });
});
