import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { circlePolygon, destinationPoint, flownFrom, interpolateLatLon, missionPath, newItemId, rtlDestination, type LatLon, type MissionPlan } from '@athena-sky/shared';
import { simulateMission } from '@athena-sky/simulator';
import { addMember, api, multipart, signup, startServer, type Session, type TestServer } from './helpers';
import { analyzeFlight } from '../src/flights/analysis';
import { checkCompliance } from '../src/flights/compliance';
import { routeConformance } from '../src/flights/flight-service';

const HOME = { lat: 25.0732, lon: 121.5355 };
let s: TestServer;
let u: Session;
let droneId: string;

function plan(alt = 30, distance = 150): MissionPlan {
  return {
    home: { ...HOME, alt: 8 },
    items: [
      { id: newItemId(), type: 'takeoff', alt },
      { id: newItemId(), type: 'waypoint', ...destinationPoint(HOME, 30, distance), alt },
      { id: newItemId(), type: 'waypoint', ...destinationPoint(HOME, 120, distance), alt },
      { id: newItemId(), type: 'rtl' },
    ],
    rallyPoints: [],
    geofence: null,
    defaultSpeed: 8,
    defaultAlt: alt,
  };
}

async function upload(content: Buffer, filename: string, fields: Record<string, string> = {}) {
  const mp = multipart({ droneId, ...fields }, [{ field: 'file', filename, content }]);
  return s.app.inject({
    method: 'POST',
    url: `/api/v2/organisations/${u.orgId}/flights/upload`,
    headers: { cookie: u.cookie, 'x-csrf-token': u.csrf, 'content-type': mp.contentType },
    payload: mp.body,
  });
}

beforeAll(async () => {
  s = await startServer();
  u = await signup(s.app, { name: 'Log Pilot' });
  droneId = (await api(s.app, u)('POST', `/api/v2/organisations/${u.orgId}/drones`, { name: 'Logger' })).json().id;
});
afterAll(async () => {
  await s.close();
});

describe('F6 flight logs in the cloud', () => {
  let flightId: string;
  let fileId: string;

  it('uploads a PX4 ULog, creates the flight and runs analytics + compliance', async () => {
    const sim = simulateMission(plan(), { home: HOME, startTime: Date.UTC(2026, 9, 1, 2, 0), ulog: true, drone: { groundAltMsl: 8, seed: 11 } });
    const res = await upload(sim.ulog!, 'log_001.ulg', { notes: 'routine' });
    expect(res.statusCode).toBe(201);
    const f = res.json();
    flightId = f.id;
    expect(f).toMatchObject({ source: 'upload', status: 'completed', droneId, pilotId: u.userId, notes: 'routine' });
    expect(f.startedAt).toBe(new Date(sim.startedAt).toISOString().slice(0, 19) + f.startedAt.slice(19));
    expect(f.durationS).toBeGreaterThan(60);
    expect(f.distanceM).toBeGreaterThan(400);
    expect(f.maxAltM).toBeGreaterThan(25);
    expect(f.healthScore).toBeGreaterThanOrEqual(0);
    expect(f.compliance).toEqual({ compliant: true, violations: [] });
    const analysis = await api(s.app, u)('GET', `/api/v2/organisations/${u.orgId}/flights/${flightId}/analysis`);
    expect(analysis.statusCode).toBe(200);
    expect(analysis.json().metrics.batteryUsedPct).toBeGreaterThan(0);
    expect(analysis.json().metrics.motorImbalance).toBeDefined();
    const files = await api(s.app, u)('GET', `/api/v2/organisations/${u.orgId}/flights/${flightId}/files`);
    fileId = files.json()[0].id;
    expect(files.json()[0]).toMatchObject({ kind: 'ulog', filename: 'log_001.ulg' });
  });

  it('rejects duplicate uploads and unknown formats', async () => {
    const sim = simulateMission(plan(), { home: HOME, startTime: Date.UTC(2026, 9, 1, 2, 0), ulog: true, drone: { groundAltMsl: 8, seed: 11 } });
    const dup = await upload(sim.ulog!, 'again.ulg');
    expect(dup.statusCode).toBe(409);
    expect(dup.json().details.flightId).toBe(flightId);
    const junk = await upload(Buffer.from('\u0000\u0001garbage'), 'x.bin');
    expect(junk.statusCode).toBe(400);
  });

  it('lists ULog topics and plots any field (seconds since start)', async () => {
    const call = api(s.app, u);
    const topics = await call('GET', `/api/v2/organisations/${u.orgId}/flights/${flightId}/files/${fileId}/topics`);
    const names = topics.json().topics.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(['vehicle_global_position', 'battery_status', 'actuator_motors']));
    expect(topics.json().params.RTL_RETURN_ALT).toBe(30);
    const series = await call('GET', `/api/v2/organisations/${u.orgId}/flights/${flightId}/files/${fileId}/series?topic=battery_status&field=voltage_v&maxPoints=50`);
    expect(series.statusCode).toBe(200);
    expect(series.json().t).toHaveLength(50);
    expect(series.json().t[0]).toBe(0);
    expect(series.json().values[0]).toBeGreaterThan(20);
    expect((await call('GET', `/api/v2/organisations/${u.orgId}/flights/${flightId}/files/${fileId}/series?topic=nope&field=x`)).statusCode).toBe(404);
  });

  it('exports CSV, KML, GPX and JSON; the JSON export can be re-imported', async () => {
    const call = api(s.app, u);
    const csv = await call('GET', `/api/v2/organisations/${u.orgId}/flights/${flightId}/export?format=csv`);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\n')[0]).toContain('time_utc,time_ms,lat,lon,alt_msl,alt_rel');
    const kml = await call('GET', `/api/v2/organisations/${u.orgId}/flights/${flightId}/export?format=kml`);
    expect(kml.body).toContain('<LineString>');
    expect(kml.body).toMatch(/<coordinates>121\.53\d+,25\.07\d+,/);
    const gpx = await call('GET', `/api/v2/organisations/${u.orgId}/flights/${flightId}/export?format=gpx`);
    expect(gpx.body).toContain('<trkpt lat="25.07');
    const json = await call('GET', `/api/v2/organisations/${u.orgId}/flights/${flightId}/export?format=json`);
    expect(json.json().format).toBe('athena-sky-flight');
    // re-import into another drone
    const other = (await call('POST', `/api/v2/organisations/${u.orgId}/drones`, { name: 'Twin' })).json().id;
    const mp = multipart({ droneId: other }, [{ field: 'file', filename: 'export.json', content: Buffer.from(json.body) }]);
    const re = await s.app.inject({ method: 'POST', url: `/api/v2/organisations/${u.orgId}/flights/upload`, headers: { cookie: u.cookie, 'x-csrf-token': u.csrf, 'content-type': mp.contentType }, payload: mp.body });
    expect(re.statusCode).toBe(201);
    expect(re.json().distanceM).toBeCloseTo(json.json().flight.distanceM, -1);
    expect((await call('GET', `/api/v2/organisations/${u.orgId}/flights/${flightId}/export?format=doc`)).statusCode).toBe(400);
  });

  it('filters the flight history by drone, pilot and period', async () => {
    const call = api(s.app, u);
    const all = await call('GET', `/api/v2/organisations/${u.orgId}/flights`);
    expect(all.json().total).toBe(2);
    const byDrone = await call('GET', `/api/v2/organisations/${u.orgId}/flights?droneId=${droneId}`);
    expect(byDrone.json().items.map((f: any) => f.id)).toEqual([flightId]);
    const before = await call('GET', `/api/v2/organisations/${u.orgId}/flights?to=2026-01-01T00:00:00Z`);
    expect(before.json().total).toBe(0);
    const samples = await call('GET', `/api/v2/organisations/${u.orgId}/flights/${flightId}/samples?maxPoints=10`);
    expect(samples.json()).toHaveLength(10);
  });

  it('geotags payload images from the flight track (GCS "Geotag Images")', async () => {
    const f = (await api(s.app, u)('GET', `/api/v2/organisations/${u.orgId}/flights/${flightId}`)).json();
    const mid = new Date((Date.parse(f.startedAt) + Date.parse(f.endedAt)) / 2).toISOString();
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
    const mp = multipart({ capturedAt: mid }, [{ field: 'files', filename: 'IMG_0001.jpg', content: jpg, type: 'image/jpeg' }]);
    const res = await s.app.inject({ method: 'POST', url: `/api/v2/organisations/${u.orgId}/flights/${flightId}/images`, headers: { cookie: u.cookie, 'x-csrf-token': u.csrf, 'content-type': mp.contentType }, payload: mp.body });
    expect(res.statusCode).toBe(201);
    const img = res.json()[0];
    expect(img.lat).toBeCloseTo(HOME.lat, 2);
    expect(img.lon).toBeCloseTo(HOME.lon, 2);
    // per-file capture times (capturedAt_<n>) place each image at its own position on the track
    const early = new Date(Date.parse(f.startedAt) + 20_000).toISOString();
    const mp2 = multipart({ capturedAt_0: early, capturedAt_1: mid }, [
      { field: 'files', filename: 'IMG_0002.jpg', content: jpg, type: 'image/jpeg' },
      { field: 'files', filename: 'IMG_0003.jpg', content: jpg, type: 'image/jpeg' },
    ]);
    const two = await s.app.inject({ method: 'POST', url: `/api/v2/organisations/${u.orgId}/flights/${flightId}/images`, headers: { cookie: u.cookie, 'x-csrf-token': u.csrf, 'content-type': mp2.contentType }, payload: mp2.body });
    const [a, b] = two.json();
    expect(a.capturedAt).toBe(early);
    expect(b.capturedAt).toBe(mid);
    expect(a.lat === b.lat && a.lon === b.lon).toBe(false);
    expect(b.lat).toBeCloseTo(img.lat, 6);
    const csv = await api(s.app, u)('GET', `/api/v2/organisations/${u.orgId}/flights/${flightId}/images.csv`);
    expect(csv.body).toContain('IMG_0001.jpg');
    const bin = await api(s.app, u)('GET', img.url);
    expect(bin.headers['content-type']).toBe('image/jpeg');
  });

  it('edits notes / pilot and deletes flights (flight.edit)', async () => {
    const call = api(s.app, u);
    const r = await call('PATCH', `/api/v2/organisations/${u.orgId}/flights/${flightId}`, { notes: 'checked' });
    expect(r.json().notes).toBe('checked');
    const viewer = await signup(s.app);
    await addMember(s.app, u, viewer, 'viewer');
    expect((await api(s.app, viewer)('DELETE', `/api/v2/organisations/${u.orgId}/flights/${flightId}`)).statusCode).toBe(403);
  });
});

describe('F6.2 post-flight AI analytics', () => {
  const base = (imbalance: number, seed: number) =>
    simulateMission(plan(30, 200), { home: HOME, startTime: Date.UTC(2026, 9, 2, 2, seed), drone: { groundAltMsl: 8, seed, motorImbalance: imbalance } });
  const toSamples = (tel: ReturnType<typeof base>['telemetry']) =>
    tel.map((t) => ({ t: t.t, lat: t.lat, lon: t.lon, altMsl: t.altMsl, altRel: t.altRel, groundSpeed: t.groundSpeed, climbRate: t.climbRate, heading: t.heading, roll: t.roll, pitch: t.pitch, yaw: t.yaw, batteryPct: t.battery.pct, voltage: t.battery.voltage, current: t.battery.current, satellites: t.gps.satellites, hdop: t.gps.hdop, mode: String(t.mode), armed: t.armed, vibration: t.vibration ?? null, motors: t.motors ?? null }));

  it('scores a healthy flight highly', () => {
    const r = analyzeFlight({ samples: toSamples(base(0, 1).telemetry), events: [], history: [] });
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.metrics.motorImbalance).toBeLessThan(0.12);
  });

  it('detects a failing motor and flags it against the drone history', () => {
    const history = [1, 2, 3, 4, 5, 6].map((seed) => analyzeFlight({ samples: toSamples(base(0, seed).telemetry), events: [], history: [] }).metrics);
    const bad = analyzeFlight({ samples: toSamples(base(0.3, 9).telemetry), events: [], history });
    const codes = bad.findings.map((f) => f.code);
    expect(codes).toContain('motor_imbalance');
    expect(codes).toContain('anomaly_motorImbalance');
    expect(codes).toContain('anomaly_vibrationMean');
    expect(bad.score).toBeLessThan(60);
  });

  it('reports low battery, hard landing and failsafes', () => {
    const t0 = 1_000_000;
    const samples = Array.from({ length: 60 }, (_, i) => ({
      t: t0 + i * 1000,
      lat: HOME.lat,
      lon: HOME.lon,
      altMsl: 10,
      altRel: i < 58 ? 20 - i * 0.33 : 0,
      groundSpeed: 0,
      climbRate: i >= 55 && i < 58 ? -4.5 : -0.3,
      heading: 0,
      roll: 0,
      pitch: 0,
      yaw: 0,
      batteryPct: 40 - i * 0.6,
      voltage: 22,
      current: 20,
      satellites: 12,
      hdop: 0.8,
      mode: 'LAND',
      armed: true,
      vibration: 10,
    }));
    const r = analyzeFlight({ samples, events: [{ t: t0, level: 'warning', code: 'failsafe', message: 'Low battery failsafe: returning to launch' }], history: [] });
    const codes = r.findings.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['battery_depleted', 'hard_landing', 'failsafe']));
  });
});

describe('F6.7 route conformance with an automatic return', () => {
  const a = destinationPoint(HOME, 0, 400);
  const b = destinationPoint(a, 90, 300);
  const rally = destinationPoint(b, 180, 150);
  const plan: MissionPlan = {
    home: { ...HOME, alt: 0 },
    items: [
      { id: newItemId(), type: 'takeoff', alt: 30 },
      { id: newItemId(), type: 'waypoint', ...a, alt: 30 },
      { id: newItemId(), type: 'waypoint', ...b, alt: 30 },
      { id: newItemId(), type: 'rtl' },
    ],
    rallyPoints: [{ ...rally, alt: 30 }],
    geofence: null,
    defaultSpeed: 10,
    defaultAlt: 30,
  };
  let t = 0;
  const leg = (p: LatLon, q: LatLon, n: number, mode: string, alt = 30) => Array.from({ length: n + 1 }, (_, i) => ({ t: (t += 1000), ...interpolateLatLon(p, q, i / n), altRel: alt, mode }));
  const climb = (at: LatLon, mode: string) => Array.from({ length: 6 }, (_, i) => ({ t: (t += 1000), ...at, altRel: 5 + i * 5, mode }));

  it('plans the return like the vehicle: to home or the closest rally point', () => {
    expect(rtlDestination(plan, b)).toEqual({ lat: rally.lat, lon: rally.lon });
    expect(rtlDestination(plan, destinationPoint(HOME, 0, 50))).toEqual({ lat: HOME.lat, lon: HOME.lon });
    expect(missionPath(plan).at(-1)).toMatchObject({ lat: rally.lat, lon: rally.lon, alt: 0 });
  });

  it('does not count the return to a rally point as an unflown part of the route', () => {
    const samples = [...climb(HOME, 'MISSION'), ...leg(HOME, a, 40, 'MISSION'), ...leg(a, b, 30, 'MISSION'), ...leg(b, rally, 15, 'RTL'), ...leg(rally, rally, 6, 'RTL', 0)];
    const r = routeConformance(plan, samples as never)!;
    expect(r.metrics.routeCoveragePct).toBeGreaterThan(95);
    expect(r.metrics.routeOutsidePct).toBe(0);
    expect(r.findings).toEqual([]);
  });

  it('reports an altitude error on the last leg (flown low to the last waypoint, then the return)', () => {
    // The last waypoint is planned at 50 m; the pilot pauses at A and flies to B at 30 m, then RTL.
    const high: MissionPlan = { ...plan, items: plan.items.map((it) => (it.type === 'waypoint' && it.lat === b.lat ? { ...it, alt: 50 } : it)) };
    const samples = [...climb(HOME, 'MISSION'), ...leg(HOME, a, 40, 'MISSION'), ...leg(a, a, 5, 'HOLD'), ...leg(a, b, 30, 'GUIDED'), ...leg(b, rally, 15, 'RTL'), ...leg(rally, rally, 6, 'RTL', 0)];
    const r = routeConformance(high, samples as never)!;
    expect(r.metrics.routeMaxAltDevM).toBeGreaterThan(19);
    expect(r.findings).toEqual([expect.objectContaining({ code: 'route_altitude', metric: r.metrics.routeMaxAltDevM })]);
    expect(r.metrics.routeCoveragePct).toBeGreaterThan(95);
  });

  it('compares a mission started in the air from where (and when) it was started', () => {
    // Manual take-off at home, a manual transit 300 m west, then the mission is started there.
    const west = destinationPoint(HOME, 270, 300);
    const manual = [...climb(HOME, 'POSCTL'), ...leg(HOME, west, 30, 'POSCTL')];
    const startT = t + 1000;
    const mission = [...leg(west, a, 50, 'MISSION'), ...leg(a, b, 30, 'MISSION'), ...leg(b, rally, 15, 'RTL'), ...leg(rally, rally, 6, 'RTL', 0)];
    const flown = flownFrom(plan, west);
    const r = routeConformance(flown, [...manual, ...mission] as never, { fromT: startT })!;
    expect(r.metrics.routeCoveragePct).toBeGreaterThan(95);
    expect(r.metrics.routeOutsidePct).toBe(0);
    expect(r.findings).toEqual([]);
    // Compared from the take-off instead, the manual transit would count as a deviation.
    expect(routeConformance(plan, [...manual, ...mission] as never)!.findings.map((f) => f.code)).toContain('route_deviation');
  });

  it('counts the rest of the route as not flown after a failsafe return – without calling the return a deviation', () => {
    // Halfway along the second leg the drone returns straight home (diagonally, away from the route).
    const mid = interpolateLatLon(a, b, 0.5);
    const samples = [...climb(HOME, 'MISSION'), ...leg(HOME, a, 40, 'MISSION'), ...leg(a, mid, 15, 'MISSION'), ...leg(mid, HOME, 50, 'RTL')];
    const r = routeConformance(plan, samples as never)!;
    expect(r.metrics.routeCoveragePct).toBeLessThan(80);
    expect(r.metrics.routeOutsidePct).toBe(0);
    expect(r.findings.map((f) => f.code)).toEqual(['route_incomplete']);
  });
});

describe('F4.2 compliance checks', () => {
  const track = (alt: number, bearing = 0) =>
    Array.from({ length: 20 }, (_, i) => ({ t: i * 1000, ...destinationPoint(HOME, bearing, i * 50), altRel: alt, armed: true }));
  const zone = (type: any, geometry: any) => ({ id: 'z', name: 'Z', type, geometry, floorM: 0, ceilingM: 500, activeFrom: null, activeTo: null, source: 't', notes: '', createdAt: '', readOnly: false });

  it('checks every point of a long flight: a short pass through a small zone is a violation', () => {
    // One hour at 5 Hz, straight north at 10 m/s and 40 m: 1.6 s inside an 8 m zone 3015 m north.
    const long = Array.from({ length: 18_001 }, (_, i) => ({ t: i * 200, ...destinationPoint(HOME, 0, i * 2), altRel: 40, armed: true }));
    const tiny = zone('restricted', { kind: 'circle', center: destinationPoint(HOME, 0, 3015), radiusM: 8 });
    expect(checkCompliance({ samples: long, maxAltitudeM: 120, zones: [tiny], authorizations: [], geofence: null }).violations).toEqual([
      { type: 'zone', zoneId: 'z', message: 'Entered restricted airspace "Z"' },
    ]);
    // Leaving the geofence for 1.6 s is caught the same way.
    const fence = { polygon: [destinationPoint(HOME, 270, 50), destinationPoint(destinationPoint(HOME, 270, 50), 0, 3010), destinationPoint(destinationPoint(HOME, 90, 50), 0, 3010), destinationPoint(HOME, 90, 50)].map((p) => destinationPoint(p, 180, 10)), maxAlt: null, action: 'rtl' as const };
    const back = [...long.slice(0, 1506), ...long.slice(0, 1506).reverse().map((p, i) => ({ ...p, t: 1506 * 200 + i * 200 }))];
    expect(checkCompliance({ samples: back, maxAltitudeM: 120, zones: [], authorizations: [], geofence: fence }).violations.map((v) => v.type)).toEqual(['geofence']);
    // Hundreds of zones elsewhere cost little.
    const far = Array.from({ length: 300 }, (_, k) => ({
      ...zone('restricted', { kind: 'polygon', polygon: Array.from({ length: 40 }, (_, j) => destinationPoint(destinationPoint(HOME, k, 50_000), j * 9, 500)) }),
      id: `far${k}`,
    }));
    const started = performance.now();
    expect(checkCompliance({ samples: long, maxAltitudeM: 120, zones: [...far, tiny], authorizations: [], geofence: null }).violations).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it('stays quick for long flights inside large zones with many vertices', () => {
    const ring = (radiusM: number, n: number) => circlePolygon(HOME, radiusM, n);
    const zones = [zone('controlled', { kind: 'polygon', polygon: ring(25_000, 360) }), zone('controlled', { kind: 'polygon', polygon: ring(40_000, 500) }), zone('danger', { kind: 'polygon', polygon: ring(30_000, 200) })];
    // Three hours at 2 Hz and 25 m/s, circling 8 km around the centre – inside all three zones.
    const samples = Array.from({ length: 3 * 3600 * 2 }, (_, i) => ({ t: i * 500, ...destinationPoint(HOME, ((i * 12.5) / 8000) * (180 / Math.PI), 8000), altRel: 80, armed: true }));
    const auth = { reference: 'ATH-BIG', geometry: { kind: 'cylinder' as const, center: HOME, radiusM: 45_000 }, maxAltM: 200, scope: 'org' as const, missionId: null, startAt: -1, endAt: 1e15 };
    let started = performance.now();
    expect(checkCompliance({ samples, maxAltitudeM: 120, zones, authorizations: [auth], geofence: null })).toEqual({ compliant: true, violations: [] });
    expect(performance.now() - started).toBeLessThan(2000);
    // One hour inside a zone of 5000 vertices, authorised by a corridor of 2000 points.
    const corridor = { reference: 'ATH-COR', geometry: { kind: 'corridor' as const, line: Array.from({ length: 2000 }, (_, i) => destinationPoint(HOME, (i * 360) / 2000, 8000)), widthM: 400 }, maxAltM: 200, scope: 'org' as const, missionId: null, startAt: -1, endAt: 1e15 };
    started = performance.now();
    expect(checkCompliance({ samples: samples.slice(0, 7200), maxAltitudeM: 120, zones: [zone('controlled', { kind: 'polygon', polygon: ring(20_000, 5000) })], authorizations: [corridor], geofence: null }).compliant).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('notices the track leaving the authorised volume between two recorded points', () => {
    // A corridor 20 m wide, north then east. Every recorded point is on its centre line, but the
    // straight stretch between two samples 0.9 s apart cuts the bend 30 m outside it.
    const xy = (east: number, north: number) => destinationPoint(destinationPoint(HOME, 90, east), 0, north);
    const corridor = { reference: 'ATH-BEND', geometry: { kind: 'corridor' as const, line: [HOME, xy(0, 300), xy(300, 300)], widthM: 20 }, maxAltM: 100, scope: 'drone' as const, missionId: null, startAt: -1, endAt: 1e15 };
    const samples = [
      [0, 0, 0],
      [5000, 0, 120],
      [10_000, 0, 240],
      [10_900, 60, 300],
      [15_000, 180, 300],
      [20_000, 300, 300],
    ].map(([t, e, n]) => ({ t: t!, ...xy(e!, n!), altRel: 40, armed: true }));
    expect(checkCompliance({ samples, maxAltitudeM: 120, zones: [], authorizations: [corridor], geofence: null }).violations).toEqual([
      { type: 'authorization', message: 'The track left the authorised volume (ATH-BEND) between two recorded points' },
    ]);
    // Following the bend, it stays inside.
    const along = [...samples.slice(0, 3), { ...samples[2]!, t: 10_500, ...xy(0, 300) }, ...samples.slice(3).map((x) => ({ ...x, t: x.t + 1000 }))];
    expect(checkCompliance({ samples: along, maxAltitudeM: 120, zones: [], authorizations: [corridor], geofence: null }).violations).toEqual([]);
  });

  it('checks the straight stretch between samples recorded close together, not across gaps', () => {
    // 1 Hz at 15 m/s: the samples are 15 m apart, the zone (radius 4 m) lies between two of them.
    const sparse = Array.from({ length: 20 }, (_, i) => ({ t: i * 1000, ...destinationPoint(HOME, 0, i * 15), altRel: 40, armed: true }));
    const between = zone('prohibited', { kind: 'circle', center: destinationPoint(HOME, 0, 82.5), radiusM: 4 });
    expect(checkCompliance({ samples: sparse, maxAltitudeM: 120, zones: [between], authorizations: [], geofence: null }).violations.map((v) => v.type)).toEqual(['zone']);
    // Ten seconds between two samples (the link was lost): the line between them is not what was flown.
    const gap = sparse.map((p, i) => ({ ...p, t: i * 1000 + (i > 5 ? 9000 : 0) }));
    expect(checkCompliance({ samples: gap, maxAltitudeM: 120, zones: [between], authorizations: [], geofence: null }).compliant).toBe(true);
  });

  it('flags altitude limit, restricted airspace and controlled airspace without authorisation', () => {
    const restricted = zone('restricted', { kind: 'circle', center: destinationPoint(HOME, 0, 600), radiusM: 100 });
    const r = checkCompliance({ samples: track(150), maxAltitudeM: 120, zones: [restricted], authorizations: [], geofence: null });
    expect(r.compliant).toBe(false);
    expect(r.violations.map((v) => v.type).sort()).toEqual(['altitude', 'zone']);
    const ctr = zone('controlled', { kind: 'circle', center: HOME, radiusM: 2000 });
    expect(checkCompliance({ samples: track(50), maxAltitudeM: 120, zones: [ctr], authorizations: [], geofence: null }).violations[0]!.message).toMatch(/without an approved authorisation/);
    const auth = { reference: 'ATH-1', geometry: { kind: 'cylinder' as const, center: HOME, radiusM: 1200 }, maxAltM: 100 };
    expect(checkCompliance({ samples: track(50), maxAltitudeM: 120, zones: [ctr], authorizations: [auth], geofence: null }).compliant).toBe(true);
  });

  it('checks danger areas and controlled airspace at every point flown, against authorisations valid at that moment', () => {
    // North from home, 0 → 950 m: inside the zone from 200 m on.
    const area = { kind: 'circle' as const, center: destinationPoint(HOME, 0, 600), radiusM: 400 };
    const samples = track(50);
    const danger = zone('danger', area);
    expect(checkCompliance({ samples, maxAltitudeM: 120, zones: [danger], authorizations: [], geofence: null }).violations).toEqual([
      { type: 'zone', zoneId: 'z', message: 'Entered danger area "Z" without an approved authorisation' },
    ]);
    const whole = { reference: 'ATH-W', geometry: { kind: 'cylinder' as const, center: area.center, radiusM: 450 }, maxAltM: 100 };
    expect(checkCompliance({ samples, maxAltitudeM: 120, zones: [danger], authorizations: [whole], geofence: null }).compliant).toBe(true);
    // Authorised only where the flight entered controlled airspace – not further in.
    const edge = { reference: 'ATH-E', geometry: { kind: 'cylinder' as const, center: destinationPoint(HOME, 0, 250), radiusM: 80 }, maxAltM: 100 };
    const ctr = zone('controlled', area);
    expect(checkCompliance({ samples, maxAltitudeM: 120, zones: [ctr], authorizations: [edge], geofence: null }).violations).toEqual([
      { type: 'zone', zoneId: 'z', message: 'Entered controlled airspace "Z" without an approved authorisation' },
    ]);
    expect(checkCompliance({ samples, maxAltitudeM: 120, zones: [ctr], authorizations: [whole], geofence: null }).compliant).toBe(true);
    // An authorisation that had already ended covers nothing.
    expect(checkCompliance({ samples, maxAltitudeM: 120, zones: [ctr], authorizations: [{ ...whole, startAt: -60_000, endAt: 4_000 }], geofence: null }).compliant).toBe(false);
  });

  it("flags entering airspace another operator had reserved at the time", () => {
    const samples = track(50);
    const t0 = samples[0]!.t;
    const t1 = samples[samples.length - 1]!.t;
    const at = destinationPoint(HOME, 0, 600);
    const reserved = { label: 'Rival Ops (ATH-9)', geometry: { kind: 'cylinder' as const, center: at, radiusM: 120 }, maxAltM: 80, startAt: t0 - 1000, endAt: t1 + 1000 };
    const r = checkCompliance({ samples, maxAltitudeM: 120, zones: [], authorizations: [], reservations: [reserved], geofence: null });
    expect(r.violations).toEqual([{ type: 'reservation', message: 'Entered airspace reserved by Rival Ops (ATH-9)' }]);
    // Not while the reservation was not active, nor above its ceiling.
    expect(checkCompliance({ samples, maxAltitudeM: 120, zones: [], authorizations: [], reservations: [{ ...reserved, startAt: t1 + 60_000, endAt: t1 + 120_000 }], geofence: null }).compliant).toBe(true);
    expect(checkCompliance({ samples, maxAltitudeM: 120, zones: [], authorizations: [], reservations: [{ ...reserved, maxAltM: 30 }], geofence: null }).compliant).toBe(true);
  });

  it('flags leaving the authorised volume or the mission geofence', () => {
    const auth = { reference: 'ATH-2', geometry: { kind: 'cylinder' as const, center: HOME, radiusM: 300 }, maxAltM: 100 };
    const r = checkCompliance({ samples: track(50), maxAltitudeM: 120, zones: [], authorizations: [auth], geofence: null });
    expect(r.violations[0]!.type).toBe('authorization');
    const geofence = { polygon: [0, 90, 180, 270].map((b) => destinationPoint(HOME, b + 45, 300)), maxAlt: 100, action: 'rtl' as const };
    expect(checkCompliance({ samples: track(50), maxAltitudeM: 120, zones: [], authorizations: [], geofence }).violations[0]!.type).toBe('geofence');
  });

  it("binds a flight to its drone's authorisation only when it took off in it or flew its mission", () => {
    // The drone's authorisation for a survey 350 m away: a flight elsewhere in its window does not use it.
    const survey = { reference: 'ATH-DRONE', geometry: { kind: 'cylinder' as const, center: destinationPoint(HOME, 180, 350), radiusM: 100 }, maxAltM: 100, scope: 'drone' as const };
    expect(checkCompliance({ samples: track(50), maxAltitudeM: 120, zones: [], authorizations: [survey], geofence: null })).toEqual({ compliant: true, violations: [] });
    // The flight of the mission it was requested for must stay inside it, wherever it took off.
    const forMission = { ...survey, missionId: 'm-1' };
    const r = checkCompliance({ samples: track(50), maxAltitudeM: 120, zones: [], authorizations: [forMission], missionId: 'm-1', geofence: null });
    expect(r.violations).toEqual([expect.objectContaining({ type: 'authorization', message: expect.stringContaining('ATH-DRONE') })]);
    expect(checkCompliance({ samples: track(50), maxAltitudeM: 120, zones: [], authorizations: [forMission], missionId: 'm-2', geofence: null }).compliant).toBe(true);
  });

  it('binds a flight to an organisation-wide authorisation only when it was flown in it', () => {
    // Elsewhere (20 km away): irrelevant for this flight – not an "outside the authorised volume" violation.
    const elsewhere = { reference: 'ATH-ORG', geometry: { kind: 'cylinder' as const, center: destinationPoint(HOME, 200, 20_000), radiusM: 500 }, maxAltM: 100, scope: 'org' as const };
    expect(checkCompliance({ samples: track(50), maxAltitudeM: 120, zones: [], authorizations: [elsewhere], geofence: null })).toEqual({ compliant: true, violations: [] });
    // Taken off inside it: the flight must stay inside, as with its drone's own authorisation.
    const here = { reference: 'ATH-ORG2', geometry: { kind: 'cylinder' as const, center: HOME, radiusM: 300 }, maxAltM: 100, scope: 'org' as const };
    const r = checkCompliance({ samples: track(50), maxAltitudeM: 120, zones: [], authorizations: [here], geofence: null });
    expect(r.violations).toEqual([expect.objectContaining({ type: 'authorization', message: expect.stringContaining('ATH-ORG2') })]);
    // Either kind exempts controlled airspace it covers.
    const ctr = zone('controlled', { kind: 'circle', center: destinationPoint(HOME, 0, 300), radiusM: 100 });
    const wide = { ...here, geometry: { kind: 'cylinder' as const, center: HOME, radiusM: 2000 } };
    expect(checkCompliance({ samples: track(50), maxAltitudeM: 120, zones: [ctr], authorizations: [wide], geofence: null }).compliant).toBe(true);
  });
});
