import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { destinationPoint, distancePointToSegmentM, haversineDistance, type LatLon } from '@athena-sky/shared';
import { api, signup, startServer, type Session, type TestServer } from './helpers';
import { encodeTerrarium } from '../src/geo/terrain';

const HOME = { lat: 25.0732, lon: 121.5355 };
const EAST = destinationPoint(HOME, 90, 2000);
const M_PER_DEG = 111_320;

/** Ground 20 m AMSL with a north–south ridge (170 m AMSL) 1200 m east of home. */
const groundAt = (lat: number, lon: number) => {
  const east = (lon - HOME.lon) * M_PER_DEG * Math.cos((HOME.lat * Math.PI) / 180);
  return 20 + Math.max(0, 150 - Math.abs(east - 1200) * 0.5);
};
const tileToLatLon = (z: number, x: number, y: number) => {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return { lat, lon };
};
let geoCalls = 0;
const fakeFetch: typeof fetch = async (input) => {
  const url = String(input);
  const m = /^https:\/\/dem\.test\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url);
  if (m) {
    const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return new Response(
      encodeTerrarium((px, py) => {
        const p = tileToLatLon(z, x + (px + 0.5) / 256, y + (py + 0.5) / 256);
        return groundAt(p.lat, p.lon);
      }),
      { status: 200, headers: { 'content-type': 'image/png' } },
    );
  }
  if (url.startsWith('https://geo.test/')) {
    geoCalls++;
    return Response.json({ name: 'Songshan Airport', display_name: 'Songshan Airport, Dunhua North Road, Songshan District, Taipei, Taiwan', address: { aeroway: 'Songshan Airport', city: 'Taipei', country: 'Taiwan' } });
  }
  if (url.startsWith('https://wx.test/')) {
    return Response.json({
      current: { time: '2026-11-20T10:00', temperature_2m: 31, precipitation: 0, cloud_cover: 10, wind_speed_10m: 7, wind_direction_10m: 90, wind_gusts_10m: 9 },
      hourly: { time: ['2026-11-20T10:00'], visibility: [20000] },
    });
  }
  return new Response('not found', { status: 404 });
};

let s: TestServer;
let owner: Session;
let missionId: string;
let droneId: string;

const plan = {
  home: { ...HOME, alt: 20 },
  items: [
    { type: 'takeoff', alt: 40 },
    { type: 'waypoint', lat: EAST.lat, lon: EAST.lon, alt: 40 },
    { type: 'rtl' },
  ],
  rallyPoints: [],
  geofence: null,
  defaultSpeed: 12,
  defaultAlt: 40,
};

beforeAll(async () => {
  s = await startServer({ fetchImpl: fakeFetch, config: { terrainUrl: 'https://dem.test/{z}/{x}/{y}.png', weatherUrl: 'https://wx.test/v1/forecast', geocoderUrl: 'https://geo.test/reverse', cesiumIonToken: 'ion-test-token' } });
  owner = await signup(s.app);
  const call = api(s.app, owner);
  await call('PATCH', `/api/v2/organisations/${owner.orgId}`, { settings: { maxAltitudeM: 300 } });
  missionId = (await call('POST', `/api/v2/organisations/${owner.orgId}/missions`, { name: 'Ridge crossing', plan })).json().id;
  droneId = (await call('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: 'Kite', airframeId: 'athena-vtol' })).json().id;
});
afterAll(async () => {
  await s.close();
});

describe('client configuration and airframe catalogue', () => {
  it('hands the Cesium ion token to signed-in users only', async () => {
    expect((await s.app.inject({ method: 'GET', url: '/api/v2/config' })).statusCode).toBe(401);
    const cfg = (await api(s.app, owner)('GET', '/api/v2/config')).json();
    expect(cfg).toMatchObject({ cesiumIonToken: 'ion-test-token', terrain: true, weather: true });
  });

  it('lists airframes with physics parameters and endurance; drones reference one', async () => {
    const list = (await api(s.app, owner)('GET', '/api/v2/airframes')).json();
    expect(list.map((a: any) => a.id)).toEqual(['taixichuang-quad', 'h380', 'specter-10x', 'hamburger-x8', 'athena-vtol']);
    expect(list[0].summary.hoverEnduranceMin).toBeGreaterThan(25);
    expect(list.find((a: any) => a.id === 'hamburger-x8').coaxial).toBe(true);
    const drone = (await api(s.app, owner)('GET', `/api/v2/organisations/${owner.orgId}/drones/${droneId}`)).json();
    expect(drone.airframeId).toBe('athena-vtol');
    expect((await api(s.app, owner)('PATCH', `/api/v2/organisations/${owner.orgId}/drones/${droneId}`, { airframeId: 'nope' })).statusCode).toBe(400);
  });
});

describe('reverse geocoding', () => {
  it('names a position and caches it', async () => {
    const call = api(s.app, owner);
    const a = (await call('GET', `/api/v2/geocode/reverse?lat=${HOME.lat}&lon=${HOME.lon}`)).json();
    expect(a).toMatchObject({ name: 'Songshan Airport, Taipei, Taiwan', source: 'OpenStreetMap Nominatim' });
    const before = geoCalls;
    await call('GET', `/api/v2/geocode/reverse?lat=${HOME.lat + 0.0001}&lon=${HOME.lon}`);
    expect(geoCalls).toBe(before);
    expect((await call('GET', '/api/v2/geocode/reverse?lat=abc')).statusCode).toBe(400);
    expect((await s.app.inject({ method: 'GET', url: `/api/v2/geocode/reverse?lat=1&lon=1` })).statusCode).toBe(401);
  });
});

describe('automatic waypoint generation API', () => {
  it('generates orbits, corridors, perimeters and camera surveys', async () => {
    const call = api(s.app, owner);
    const orbit = (await call('POST', '/api/v2/planning/generate', { kind: 'orbit', params: { center: HOME, radiusM: 40, alt: 30, points: 8, layers: 2 } })).json();
    expect(orbit.items).toHaveLength(18);
    expect(orbit.items[0].yawDeg).toBeDefined();
    const area = [0, 90, 180, 270].map((b) => destinationPoint(HOME, b + 45, 200));
    const cam = (await call('POST', '/api/v2/planning/generate', { kind: 'camera_survey', params: { polygon: area, airframeId: 'specter-10x', gsdCmPerPx: 2.5 } })).json();
    expect(cam.info).toMatchObject({ camera: '1" 20 MP' });
    expect(cam.info.alt).toBeCloseTo(91.2, 0);
    expect(cam.items.some((i: any) => i.type === 'camera_trigger')).toBe(true);
    const corridor = await call('POST', '/api/v2/planning/generate', { kind: 'corridor', params: { line: [HOME, EAST], widthM: 40, spacingM: 20, alt: 50 } });
    expect(corridor.json().items).toHaveLength(6);
    const bad = await call('POST', '/api/v2/planning/generate', { kind: 'perimeter', params: { polygon: [HOME], alt: 30 } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/at least 3 positions/);
  });
});

describe('pre-flight simulation (true-to-life models)', () => {
  it('simulates with the drone airframe, forecast wind/temperature and the DEM', async () => {
    const r = (await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/missions/${missionId}/simulate`, { droneId, useForecast: true, payloadKg: 1, compare: true })).json();
    expect(r.result.airframeId).toBe('athena-vtol');
    expect(r.conditions).toMatchObject({ windSource: 'forecast', temperatureC: 31, terrain: 'dem' });
    expect(r.conditions.homeElevationM).toBeCloseTo(20, 0);
    // the 40 m route flies into the 150 m ridge
    expect(r.result.issues.map((i: any) => i.code)).toContain('terrain_collision');
    expect(r.result.feasible).toBe(false);
    expect(r.result.samples.length).toBeGreaterThan(50);
    expect(r.comparison.map((c: any) => c.airframeId)).toEqual(['taixichuang-quad', 'h380', 'specter-10x', 'hamburger-x8', 'athena-vtol']);
    // VTOL transitions appear in the legs
    expect(r.result.legs.filter((l: any) => l.phase === 'transition')).toHaveLength(2);
  });

  it('keeps explicit nulls (no AJV coercion of null to 0 / "")', async () => {
    const call = api(s.app, owner);
    const r = (await call('POST', `/api/v2/organisations/${owner.orgId}/missions/${missionId}/simulate`, { airframeId: 'specter-10x', temperatureC: null, wind: { speedMs: 3, fromDeg: 0, gustMs: null } })).json();
    // ISA at the 20 m home elevation, not 0 °C
    expect(r.conditions.temperatureC).toBeNull();
    expect(r.result.airDensity).toBeCloseTo(1.223, 3);
    await call('PATCH', `/api/v2/organisations/${owner.orgId}/drones/${droneId}`, { airframeId: null });
    expect((await call('GET', `/api/v2/organisations/${owner.orgId}/drones/${droneId}`)).json().airframeId).toBeNull();
    await call('PATCH', `/api/v2/organisations/${owner.orgId}/drones/${droneId}`, { airframeId: 'athena-vtol' });
    await call('PATCH', `/api/v2/organisations/${owner.orgId}/members/${owner.userId}`, { pilotLicense: null });
    const me = (await call('GET', `/api/v2/organisations/${owner.orgId}/members`)).json().find((m: any) => m.userId === owner.userId);
    expect(me.pilotLicense).toBeNull();
  });

  it('uses manual conditions and rejects unknown airframes', async () => {
    const call = api(s.app, owner);
    // climbing to 200 m right after take-off clears the ridge
    const high = { ...plan, items: [{ type: 'takeoff', alt: 200 }, { ...plan.items[1], alt: 200 }, plan.items[2]] };
    const calm = (await call('POST', `/api/v2/organisations/${owner.orgId}/missions/${missionId}/simulate`, { airframeId: 'specter-10x', plan: high })).json();
    expect(calm.result.issues).toEqual([]);
    expect(calm.result.feasible).toBe(true);
    expect(calm.conditions.windSource).toBe('none');
    const windy = (await call('POST', `/api/v2/organisations/${owner.orgId}/missions/${missionId}/simulate`, { airframeId: 'specter-10x', wind: { speedMs: 9, fromDeg: 90 }, plan: high })).json();
    expect(windy.result.energyWh).toBeGreaterThan(calm.result.energyWh);
    expect((await call('POST', `/api/v2/organisations/${owner.orgId}/missions/${missionId}/simulate`, { airframeId: 'zz' })).statusCode).toBe(400);
  });
});

describe('AI route optimisation', () => {
  it('avoids restricted airspace and follows the terrain', async () => {
    const call = api(s.app, owner);
    const zoneCenter = destinationPoint(HOME, 90, 600);
    await call('POST', `/api/v2/organisations/${owner.orgId}/airspace/zones`, { name: 'Prison', type: 'restricted', geometry: { kind: 'circle', center: zoneCenter, radiusM: 150 }, floorM: 0, ceilingM: 500 });
    const r = (await call('POST', `/api/v2/organisations/${owner.orgId}/missions/${missionId}/optimize`, { airframeId: 'specter-10x', bufferM: 25, minClearanceM: 30 })).json();
    expect(r.report.detours.length).toBeGreaterThanOrEqual(1);
    expect(r.report.detours[0].around).toEqual(['Prison']);
    expect(r.terrainAvailable).toBe(true);
    expect(r.terrain.inserted + r.terrain.changes.length).toBeGreaterThan(0);
    // ridge 150 m above home + 30 m clearance, minus what the ≈35 m DEM pixels shave off the sharp crest
    expect(r.terrain.maxRequiredAlt).toBeGreaterThanOrEqual(165);
    // the optimised route no longer collides with the ridge and stays out of the zone
    expect(r.before.errors.join(' ')).toMatch(/terrain/);
    expect(r.after.feasible).toBe(true);
    expect(r.after.minAglM).toBeGreaterThan(20);
    const pts: LatLon[] = [HOME, ...r.plan.items.filter((i: any) => i.lat !== undefined), HOME];
    for (let i = 0; i + 1 < pts.length; i++) expect(distancePointToSegmentM(zoneCenter, pts[i]!, pts[i + 1]!)).toBeGreaterThan(150);
    // nothing is saved until the planner stores the plan
    const stored = (await call('GET', `/api/v2/organisations/${owner.orgId}/missions/${missionId}`)).json();
    expect(stored.plan.items).toHaveLength(3);
    // the summit waypoint sits above the ridge
    const summit = r.plan.items.filter((i: any) => i.type === 'waypoint').find((i: any) => Math.abs(haversineDistance(HOME, i) - 1200) < 60);
    expect(summit.alt).toBeGreaterThanOrEqual(165);
  });
});
