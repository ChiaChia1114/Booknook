import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { destinationPoint, toQgcPlan, toWpl } from '@athena-sky/shared';
import { addMember, api, signup, startServer, type Session, type TestServer } from './helpers';
import { encodeTerrarium, lonLatToTile } from '../src/geo/terrain';

const HOME = { lat: 25.0732, lon: 121.5355 };
const WP = destinationPoint(HOME, 0, 300);

/** Fake upstream for DEM tiles (elevation rises 0.5 m per pixel row southwards) and Open-Meteo. */
const fakeFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.startsWith('https://tiles.test/')) {
    return new Response(encodeTerrarium((_x, y) => 20 + y * 0.5), { status: 200, headers: { 'content-type': 'image/png' } });
  }
  if (url.startsWith('https://weather.test/')) {
    const u = new URL(url);
    const windy = Number(u.searchParams.get('latitude')) > 50;
    return Response.json({
      current: { time: '2026-11-20T10:00', temperature_2m: 21.5, precipitation: 0, cloud_cover: 40, wind_speed_10m: windy ? 13.2 : 4.1, wind_direction_10m: 220, wind_gusts_10m: windy ? 18 : 6.5 },
      hourly: { time: ['2026-11-20T09:00', '2026-11-20T10:00'], visibility: [24000, 23000] },
    });
  }
  return new Response('not found', { status: 404 });
};

let s: TestServer;
let owner: Session;
let manager: Session;
let pilot: Session;
let droneId: string;

beforeAll(async () => {
  s = await startServer({ fetchImpl: fakeFetch, config: { terrainUrl: 'https://tiles.test/{z}/{x}/{y}.png', weatherUrl: 'https://weather.test/v1/forecast' } });
  owner = await signup(s.app);
  manager = await signup(s.app);
  pilot = await signup(s.app);
  const call = api(s.app, owner);
  await addMember(s.app, owner, manager, 'manager');
  await addMember(s.app, owner, pilot, 'pilot');
  droneId = (await call('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: 'Planner drone' })).json().id;
});
afterAll(async () => {
  await s.close();
});

const missionPlan = {
  home: { ...HOME, alt: 0 },
  items: [
    { type: 'takeoff', alt: 40 },
    { type: 'waypoint', lat: WP.lat, lon: WP.lon, alt: 60, holdS: 5 },
    { type: 'rtl' },
  ],
  rallyPoints: [{ ...destinationPoint(HOME, 90, 200), alt: 30 }],
  geofence: { polygon: [0, 90, 180, 270].map((b) => destinationPoint(HOME, b + 45, 800)), maxAlt: 100, action: 'rtl' },
  defaultSpeed: 10,
  defaultAlt: 40,
};

describe('F7 3D mission planning (server side)', () => {
  let missionId: string;

  it('creates, validates, updates and duplicates missions with stats', async () => {
    const call = api(s.app, pilot);
    const res = await call('POST', `/api/v2/organisations/${owner.orgId}/missions`, { name: 'Tower orbit', plan: missionPlan });
    expect(res.statusCode).toBe(201);
    missionId = res.json().id;
    expect(res.json().stats.horizontalDistanceM).toBeCloseTo(600, -1);
    expect(res.json().plan.items[1].id).toBeTruthy();
    const v = await call('GET', `/api/v2/organisations/${owner.orgId}/missions/${missionId}/validate`);
    expect(v.json().issues.filter((i: any) => i.level === 'error')).toEqual([]);
    const bad = await call('POST', `/api/v2/organisations/${owner.orgId}/missions`, { name: 'Bad', plan: { items: [{ type: 'warp' }] } });
    expect(bad.statusCode).toBe(400);
    const upd = await call('PUT', `/api/v2/organisations/${owner.orgId}/missions/${missionId}`, { plan: { ...missionPlan, items: [...missionPlan.items.slice(0, 2), { type: 'waypoint', lat: WP.lat, lon: WP.lon, alt: 150 }, { type: 'rtl' }] } });
    expect(upd.statusCode).toBe(200);
    const v2 = await call('GET', `/api/v2/organisations/${owner.orgId}/missions/${missionId}/validate`);
    expect(v2.json().issues.some((i: any) => /exceeds the 120 m limit/.test(i.message))).toBe(true);
    expect(v2.json().issues.some((i: any) => /ceiling/.test(i.message))).toBe(true);
    await call('PUT', `/api/v2/organisations/${owner.orgId}/missions/${missionId}`, { plan: missionPlan });
    const dup = await call('POST', `/api/v2/organisations/${owner.orgId}/missions/${missionId}/duplicate`);
    expect(dup.json().name).toBe('Tower orbit (copy)');
  });

  it('exports and imports QGroundControl .plan and QGC WPL 110 files', async () => {
    const call = api(s.app, pilot);
    const plan = await call('GET', `/api/v2/organisations/${owner.orgId}/missions/${missionId}/export?format=plan`);
    expect(plan.headers['content-disposition']).toContain('.plan');
    expect(JSON.parse(plan.body).mission.items[1].command).toBe(16);
    const wpl = await call('GET', `/api/v2/organisations/${owner.orgId}/missions/${missionId}/export?format=waypoints`);
    expect(wpl.body.startsWith('QGC WPL 110')).toBe(true);
    const imp = await call('POST', `/api/v2/organisations/${owner.orgId}/missions/import`, { name: 'From QGC', format: 'plan', content: plan.body });
    expect(imp.statusCode).toBe(201);
    expect(imp.json().plan.items.map((i: any) => i.type)).toEqual(['takeoff', 'waypoint', 'rtl']);
    expect(imp.json().plan.rallyPoints).toHaveLength(1);
    expect(imp.json().plan.geofence.polygon).toHaveLength(4);
    const imp2 = await call('POST', `/api/v2/organisations/${owner.orgId}/missions/import`, { name: 'From MP', format: 'waypoints', content: wpl.body });
    expect(imp2.json().plan.items[1].lat).toBeCloseTo(WP.lat, 6);
    expect((await call('POST', `/api/v2/organisations/${owner.orgId}/missions/import`, { name: 'X', format: 'plan', content: '{"nope":1}' })).statusCode).toBe(400);
    // the shared converters agree with the server
    expect(toWpl(imp2.json().plan).split('\n')[2]).toBe(wpl.body.split('\n')[2]);
    expect(toQgcPlan(imp.json().plan).fileType).toBe('Plan');
  });

  it('computes the terrain profile and clearance along the route (F5.5 / F8.2)', async () => {
    const r = await api(s.app, pilot)('POST', `/api/v2/organisations/${owner.orgId}/missions/${missionId}/terrain`);
    expect(r.statusCode).toBe(200);
    const t = r.json();
    // expected elevation at home from the synthetic tile
    const tile = lonLatToTile(HOME.lat, HOME.lon, 12);
    const py = (tile.y - Math.floor(tile.y)) * 256 - 0.5;
    expect(t.homeElevationM).toBeCloseTo(20 + py * 0.5, 0);
    expect(t.samples.length).toBeGreaterThan(10);
    expect(t.maxElevationM).toBeGreaterThan(t.minElevationM);
    expect(t.minClearanceM).toBeGreaterThan(30);
    expect(t.minClearanceM).toBeLessThan(45);
    const el = await api(s.app, pilot)('POST', '/api/v2/terrain/elevation', { points: [HOME] });
    expect(el.json().elevations[0]).toBeCloseTo(t.homeElevationM, 1);
    const tilePng = await api(s.app, pilot)('GET', `/api/v2/terrain/tiles/12/${Math.floor(tile.x)}/${Math.floor(tile.y)}.png`);
    expect(tilePng.headers['content-type']).toBe('image/png');
  });

  it('caches the terrain profile on the mission only for members who may edit missions', async () => {
    const observer = await signup(s.app);
    await addMember(s.app, owner, observer, 'viewer');
    const m = await api(s.app, pilot)('POST', `/api/v2/organisations/${owner.orgId}/missions`, { name: 'Terrain cache', plan: missionPlan });
    const url = `/api/v2/organisations/${owner.orgId}/missions/${m.json().id}`;
    const viewed = await api(s.app, observer)('POST', `${url}/terrain`);
    expect(viewed.statusCode).toBe(200);
    expect(viewed.json().samples.length).toBeGreaterThan(0);
    expect((await api(s.app, observer)('GET', url)).json().terrain).toBeNull();
    expect((await api(s.app, pilot)('POST', `${url}/terrain`)).statusCode).toBe(200);
    expect((await api(s.app, observer)('GET', url)).json().terrain.samples.length).toBeGreaterThan(0);
  });

  it('schedules future operations and shows the next mission on the drone', async () => {
    const call = api(s.app, manager);
    const plannedAt = new Date(Date.now() + 86_400_000).toISOString();
    const sch = await call('POST', `/api/v2/organisations/${owner.orgId}/schedules`, { missionId, droneId, pilotId: pilot.userId, plannedAt });
    expect(sch.statusCode).toBe(201);
    expect(sch.json()).toMatchObject({ status: 'scheduled', pilotName: expect.any(String), missionName: 'Tower orbit' });
    const drone = (await api(s.app, pilot)('GET', `/api/v2/organisations/${owner.orgId}/drones/${droneId}`)).json();
    expect(drone.nextMission).toMatchObject({ missionId, name: 'Tower orbit', plannedAt });
    expect(drone.nextMission.terrain.samples.length).toBeGreaterThan(0);
    const list = await call('GET', `/api/v2/organisations/${owner.orgId}/schedules`);
    expect(list.json()).toHaveLength(1);
    const cancel = await call('PATCH', `/api/v2/organisations/${owner.orgId}/schedules/${sch.json().id}`, { status: 'cancelled' });
    expect(cancel.json().status).toBe('cancelled');
  });
});

describe('F8 integrated UTM: airspace, hazards, weather, authorisation', () => {
  it('manages zones and imports GeoJSON airspace', async () => {
    const call = api(s.app, manager);
    const z = await call('POST', `/api/v2/organisations/${owner.orgId}/airspace/zones`, {
      name: 'Hospital',
      type: 'restricted',
      geometry: { kind: 'circle', center: destinationPoint(HOME, 180, 1000), radiusM: 250 },
      ceilingM: 300,
    });
    expect(z.statusCode).toBe(201);
    expect((await api(s.app, pilot)('POST', `/api/v2/organisations/${owner.orgId}/airspace/zones`, { name: 'x', type: 'restricted', geometry: { kind: 'circle', center: HOME, radiusM: 10 } })).statusCode).toBe(403);
    expect((await call('POST', `/api/v2/organisations/${owner.orgId}/airspace/zones`, { name: 'bad', type: 'restricted', geometry: { kind: 'polygon', polygon: [HOME] } })).statusCode).toBe(400);
    const line = [destinationPoint(HOME, 270, 500), destinationPoint(HOME, 90, 500)].map((p) => [p.lon, p.lat]);
    const ctr = [0, 120, 240].map((b) => destinationPoint(destinationPoint(HOME, 0, 3000), b, 800)).map((p) => [p.lon, p.lat]);
    const imp = await call('POST', `/api/v2/organisations/${owner.orgId}/airspace/zones/import`, {
      geojson: {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', properties: { name: 'Power line', type: 'hazard_powerline', bufferM: 25, ceiling: 50 }, geometry: { type: 'LineString', coordinates: line } },
          { type: 'Feature', properties: { name: 'CTR', type: 'controlled', floor: 0, ceiling: 1000 }, geometry: { type: 'Polygon', coordinates: [[...ctr, ctr[0]]] } },
          { type: 'Feature', properties: { name: 'Broken' }, geometry: { type: 'Point', coordinates: [0, 0] } },
        ],
      },
    });
    expect(imp.json().imported).toBe(2);
    expect(imp.json().skipped).toHaveLength(1);
    const zones = await call('GET', `/api/v2/organisations/${owner.orgId}/airspace/zones`);
    expect(zones.json()).toHaveLength(3);
  });

  it('checks volumes: blocking zones, review for controlled airspace, advisories for hazards', async () => {
    const call = api(s.app, pilot);
    const now = Date.now();
    const window = { startAt: new Date(now + 3_600_000).toISOString(), endAt: new Date(now + 7_200_000).toISOString() };
    const blocked = await call('POST', `/api/v2/organisations/${owner.orgId}/airspace/check`, { geometry: { kind: 'cylinder', center: destinationPoint(HOME, 180, 900), radiusM: 200 }, maxAltM: 100, ...window });
    expect(blocked.json().verdict).toBe('blocked');
    const review = await call('POST', `/api/v2/organisations/${owner.orgId}/airspace/check`, { geometry: { kind: 'cylinder', center: destinationPoint(HOME, 0, 3000), radiusM: 100 }, maxAltM: 100, ...window });
    expect(review.json().verdict).toBe('review');
    const hazard = await call('POST', `/api/v2/organisations/${owner.orgId}/airspace/check`, { geometry: { kind: 'corridor', line: [destinationPoint(HOME, 0, 200), destinationPoint(HOME, 180, 200)], widthM: 40 }, maxAltM: 80, ...window });
    expect(hazard.json()).toMatchObject({ verdict: 'clear', conflicts: [{ kind: 'hazard', severity: 'advisory', name: 'Power line' }] });
    const above = await call('POST', `/api/v2/organisations/${owner.orgId}/airspace/check`, { geometry: { kind: 'cylinder', center: destinationPoint(HOME, 180, 900), radiusM: 200 }, maxAltM: 100, startAt: new Date(now - 7_200_000).toISOString(), endAt: new Date(now - 3_600_000).toISOString() });
    expect(above.statusCode).toBe(400);
  });

  it('auto-approves clear requests, reserves the airspace publicly and rejects overlaps from other operators', async () => {
    const start = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const end = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const site = destinationPoint(HOME, 90, 1500);
    const req = await api(s.app, pilot)('POST', `/api/v2/organisations/${owner.orgId}/airspace/authorizations`, { geometry: { kind: 'cylinder', center: site, radiusM: 150 }, maxAltM: 90, startAt: start, endAt: end, droneId });
    expect(req.statusCode).toBe(201);
    expect(req.json()).toMatchObject({ status: 'approved', droneName: 'Planner drone' });
    expect(req.json().reference).toMatch(/^ATH-[0-9A-F]{8}$/);
    const map = await s.app.inject({ method: 'GET', url: '/api/v2/public/safety-map' });
    expect(map.statusCode).toBe(200);
    const pub = map.json().reservations.find((r: any) => r.reference === req.json().reference);
    expect(pub).toMatchObject({ maxAltM: 90, geometry: { kind: 'cylinder' } });
    expect(JSON.stringify(pub)).not.toContain(droneId);
    // a different operator asks for an overlapping corridor at the same time
    const other = await signup(s.app);
    const clash = await api(s.app, other)('POST', `/api/v2/organisations/${other.orgId}/airspace/authorizations`, {
      geometry: { kind: 'corridor', line: [destinationPoint(site, 0, 500), destinationPoint(site, 180, 500)], widthM: 50 },
      maxAltM: 60,
      startAt: start,
      endAt: end,
    });
    expect(clash.json().status).toBe('rejected');
    expect(clash.json().conflicts[0]).toMatchObject({ kind: 'reservation', severity: 'blocking' });
    // ...but the same corridor later the same day is fine
    const later = await api(s.app, other)('POST', `/api/v2/organisations/${other.orgId}/airspace/authorizations`, {
      geometry: { kind: 'corridor', line: [destinationPoint(site, 0, 500), destinationPoint(site, 180, 500)], widthM: 50 },
      maxAltM: 60,
      startAt: new Date(Date.now() + 5 * 3_600_000).toISOString(),
      endAt: new Date(Date.now() + 6 * 3_600_000).toISOString(),
    });
    expect(later.json().status).toBe('approved');
  });

  it('routes controlled-airspace requests to a manager for a decision', async () => {
    const start = new Date(Date.now() + 26 * 3_600_000).toISOString();
    const end = new Date(Date.now() + 27 * 3_600_000).toISOString();
    const req = await api(s.app, pilot)('POST', `/api/v2/organisations/${owner.orgId}/airspace/authorizations`, { geometry: { kind: 'cylinder', center: destinationPoint(HOME, 0, 3000), radiusM: 100 }, maxAltM: 60, startAt: start, endAt: end });
    expect(req.json().status).toBe('pending');
    expect((await api(s.app, pilot)('POST', `/api/v2/organisations/${owner.orgId}/airspace/authorizations/${req.json().id}/decision`, { decision: 'approve' })).statusCode).toBe(403);
    const ok = await api(s.app, manager)('POST', `/api/v2/organisations/${owner.orgId}/airspace/authorizations/${req.json().id}/decision`, { decision: 'approve', reason: 'Coordinated with ATC' });
    expect(ok.json()).toMatchObject({ status: 'approved', decisionReason: 'Coordinated with ATC', decidedBy: manager.userId });
    expect((await api(s.app, manager)('POST', `/api/v2/organisations/${owner.orgId}/airspace/authorizations/${req.json().id}/decision`, { decision: 'reject' })).statusCode).toBe(409);
    const cancel = await api(s.app, pilot)('POST', `/api/v2/organisations/${owner.orgId}/airspace/authorizations/${req.json().id}/cancel`);
    expect(cancel.json().status).toBe('cancelled');
  });

  it('checks a whole mission corridor against airspace', async () => {
    const m = await api(s.app, pilot)('POST', `/api/v2/organisations/${owner.orgId}/missions`, {
      name: 'Through the power line',
      plan: { home: { ...HOME, alt: 0 }, items: [{ type: 'takeoff', alt: 30 }, { type: 'waypoint', ...destinationPoint(HOME, 0, 300), alt: 30 }, { type: 'waypoint', ...destinationPoint(HOME, 180, 300), alt: 30 }, { type: 'rtl' }], rallyPoints: [], defaultSpeed: 8, defaultAlt: 30 },
    });
    const r = await api(s.app, pilot)('POST', `/api/v2/organisations/${owner.orgId}/missions/${m.json().id}/airspace-check`, {});
    expect(r.json().conflicts.map((c: any) => c.name)).toContain('Power line');
  });

  it('provides weather with a go / no-go assessment', async () => {
    const ok = await api(s.app, pilot)('GET', `/api/v2/weather?lat=${HOME.lat}&lon=${HOME.lon}`);
    expect(ok.json()).toMatchObject({ windSpeedMs: 4.1, windGustMs: 6.5, visibilityM: 23000, temperatureC: 21.5, assessment: { status: 'go' }, source: 'Open-Meteo' });
    const windy = await api(s.app, pilot)('GET', '/api/v2/weather?lat=55&lon=10');
    expect(windy.json().assessment.status).toBe('no-go');
    expect(windy.json().assessment.reasons.join(' ')).toMatch(/Wind 13\.2/);
    expect((await s.app.inject({ method: 'GET', url: `/api/v2/weather?lat=1&lon=1` })).statusCode).toBe(401);
    expect((await api(s.app, pilot)('GET', '/api/v2/weather?lat=999&lon=1')).statusCode).toBe(400);
  });
});
