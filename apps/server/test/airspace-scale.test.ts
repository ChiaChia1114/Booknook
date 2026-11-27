/**
 * Airspace work at scale (airspace/volume.ts, geometry.ts, mission-check.ts, providers.ts,
 * utm-monitor.ts, realtime/hub.ts): an organisation's most zones checked against long corridors a
 * slice at a time – the same answers, the event loop never held long; the most points an
 * organisation's zones may have; its zones kept at hand and changed in place, let go when many
 * organisations' are; the live monitor waiting for what it checks against after a change; a start
 * being checked never sent after a later stop.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { destinationPoint, shapeDistanceM, type LatLon, type Shape, type Telemetry } from '@athena-sky/shared';
import { LinkClient, VirtualDrone } from '@athena-sky/simulator';
import { PreparedVolume } from '../src/airspace/volume';
import { checkVolumeSteps } from '../src/airspace/geometry';
import { OrgZoneProvider } from '../src/airspace/providers';
import { runAtOnce } from '../src/lib/slice';
import { api, signup, startServer, waitFor, type Session, type TestServer } from './helpers';

const HOME = { lat: 25.0732, lon: 121.5355 };

let s: TestServer;
let owner: Session;
let call: ReturnType<typeof api>;
let org: string;
beforeAll(async () => {
  s = await startServer();
  owner = await signup(s.app, { name: 'Zelda Zones' });
  call = api(s.app, owner);
  org = `/api/v2/organisations/${owner.orgId}`;
});
afterAll(async () => {
  await s.close();
});

/** A polygon of `n` corners around `c` (radius `r` m). */
const ring = (c: LatLon, r: number, n: number) => Array.from({ length: n }, (_, k) => destinationPoint(c, (k * 360) / n, r));

/** Stores zones directly (as many as an organisation may have, quickly). */
function storeZones(orgId: string, zones: { name: string; type?: string; polygon: LatLon[] }[]): void {
  s.ctx.db.tx(() => {
    for (const z of zones) {
      s.ctx.db.run(
        `INSERT INTO airspace_zones (id, org_id, name, type, geometry, floor_m, ceiling_m, source, notes, created_at) VALUES (?, ?, ?, ?, ?, 0, 120, 'manual', '', ?)`,
        crypto.randomUUID(),
        orgId,
        z.name,
        z.type ?? 'controlled',
        JSON.stringify({ kind: 'polygon', polygon: z.polygon }),
        new Date().toISOString(),
      );
    }
  });
  s.ctx.airspace.invalidate(orgId);
}

/** The event loop's longest stretch while `f` runs. */
async function longestStretch<T>(f: () => Promise<T>): Promise<{ value: T; longestMs: number }> {
  let last = performance.now();
  let longest = 0;
  const tick = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 1);
  try {
    await new Promise((r) => setTimeout(r, 20));
    last = performance.now();
    longest = 0;
    const value = await f();
    return { value, longestMs: Math.max(longest, performance.now() - last) };
  } finally {
    clearInterval(tick);
  }
}

describe('distances from a prepared volume', () => {
  it('as shapeDistanceM up to the limit asked for – above it, only that', () => {
    let seed = 11;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const near = (c: LatLon, r: number) => destinationPoint(c, rnd() * 360, rnd() * r);
    const shape = (kind: number, c: LatLon, size: number): Shape => {
      if (kind === 0) return { kind: 'point', point: near(c, size), radiusM: rnd() * size * 0.3 };
      if (kind === 1) {
        const line = [near(c, size)];
        for (let i = 1, n = 1 + Math.floor(rnd() * 40); i < n; i++) line.push(destinationPoint(line[i - 1]!, rnd() * 360, rnd() * size * 0.4));
        return { kind: 'line', line, radiusM: rnd() * size * 0.2 };
      }
      const n = 3 + Math.floor(rnd() * 60);
      const centre = near(c, size);
      return { kind: 'polygon', polygon: Array.from({ length: n }, (_, i) => destinationPoint(centre, (i * 360) / n + rnd() * (300 / n), size * (0.1 + rnd() * 0.5))), ...(rnd() < 0.3 ? { radiusM: rnd() * 30 } : {}) };
    };
    let within = 0;
    for (let t = 0; t < 3000; t++) {
      const size = [50, 500, 5000][t % 3]!;
      const a = shape(Math.floor(rnd() * 3), HOME, size);
      const b = shape(Math.floor(rnd() * 3), near(HOME, size), size);
      const exact = shapeDistanceM(a, b);
      const volume = new PreparedVolume(a);
      for (const limit of [0, 50, 300, Infinity]) {
        const got = runAtOnce(volume.distanceSteps(b, limit));
        if (exact <= limit) {
          within++;
          expect(got).toBe(exact);
        } else expect(got).toBeGreaterThan(limit);
      }
    }
    expect(within).toBeGreaterThan(5000);
  });
});

describe("an organisation's most zones", () => {
  // 2000 zones of 100 corners (200 000 points) on a grid of 100 × 20 km.
  const corner = { lat: 24, lon: 120 };
  const zoneAt = (k: number) => destinationPoint(destinationPoint(corner, 0, (k % 100) * 1000 + 300), 90, Math.floor(k / 100) * 1000 + 300);

  it('missions, corridors and authorisations checked a slice at a time: the event loop never held long', async () => {
    storeZones(
      owner.orgId,
      Array.from({ length: 2000 }, (_, k) => ({ name: `Zone ${k}`, polygon: ring(zoneAt(k), 200, 100) })),
    );
    // A mission of 2000 items over every zone, a corridor of 5000 points 10 km wide over them all.
    const items = [{ type: 'takeoff', alt: 40 }, ...Array.from({ length: 1998 }, (_, i) => ({ type: 'waypoint', ...destinationPoint(destinationPoint(corner, 0, (i % 200) * 500), 90, Math.floor(i / 200) * 2000), alt: 50 })), { type: 'rtl' }];
    const mission = (await call('POST', `${org}/missions`, { name: 'Over everything', plan: { home: { ...corner, alt: 0 }, items, rallyPoints: [], geofence: null, defaultSpeed: 10, defaultAlt: 50 } })).json();
    const line = Array.from({ length: 5000 }, (_, i) => destinationPoint(destinationPoint(corner, 0, (i % 500) * 200), 90, Math.floor(i / 500) * 2000));
    const window = { startAt: new Date(Date.now() + 3_600_000).toISOString(), endAt: new Date(Date.now() + 7_200_000).toISOString() };
    const checked = await longestStretch(async () => {
      const t0 = performance.now();
      const m = await call('POST', `${org}/missions/${mission.id}/airspace-check`, {});
      const corridor = await call('POST', `${org}/airspace/check`, { geometry: { kind: 'corridor', line, widthM: 10_000 }, maxAltM: 100, ...window });
      const auth = await call('POST', `${org}/airspace/authorizations`, { geometry: { kind: 'corridor', line, widthM: 10_000 }, maxAltM: 100, ...window });
      return { m, corridor, auth, ms: performance.now() - t0 };
    });
    const { m, corridor, auth, ms } = checked.value;
    expect(m.json().verdict).toBe('review');
    expect(m.json().conflicts.length).toBeGreaterThan(300);
    expect(corridor.json().conflicts).toHaveLength(2000);
    expect(auth.statusCode).toBe(201);
    expect(auth.json().status).toBe('pending');
    // Measured about 0.3–0.6 s each, the longest stretch about 6–11 ms (before: a minute or two in one go).
    expect(ms).toBeLessThan(15_000);
    expect(checked.longestMs).toBeLessThan(60);
    // In steps of little work each (about a thousand pairs of segments, or points): many steps, none long.
    const steps = checkVolumeSteps({ kind: 'line', line, radiusM: 5000 }, 0, 100, { from: Date.now(), to: Date.now() + 3_600_000 }, s.ctx.airspace.zones(owner.orgId), []);
    let n = 0;
    let longest = 0;
    for (;;) {
      const t0 = performance.now();
      const r = steps.next();
      longest = Math.max(longest, performance.now() - t0);
      n++;
      if (r.done) {
        expect(r.value).toHaveLength(2000);
        break;
      }
    }
    expect(n).toBeGreaterThan(400);
    expect(longest).toBeLessThan(30);
  }, 120_000);

  it('at most 200 000 points in all – a zone, an import or an edit beyond is refused, saying so', async () => {
    const other = await signup(s.app, { name: 'Pia Points' });
    const at = `/api/v2/organisations/${other.orgId}`;
    const theirs = api(s.app, other);
    // 1000 zones of 199 corners, and one of 1000: 200 000 points.
    storeZones(other.orgId, Array.from({ length: 1000 }, (_, k) => ({ name: `P${k}`, polygon: ring(zoneAt(k), 200, 199) })));
    const full = await theirs('POST', `${at}/airspace/zones`, { name: 'The last points', type: 'restricted', geometry: { kind: 'polygon', polygon: ring(HOME, 500, 1000) } });
    expect(full.statusCode).toBe(201);
    const message = "An organisation's airspace zones can have at most 200000 points in all (this one's have 200000, 1 more were asked for) – simplify or delete some first";
    const one = await theirs('POST', `${at}/airspace/zones`, { name: 'One more', type: 'restricted', geometry: { kind: 'circle', center: HOME, radiusM: 50 } });
    expect(one.statusCode).toBe(409);
    expect(one.json().message).toBe(message);
    const geojson = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'Mast', radiusM: 30 }, geometry: { type: 'Point', coordinates: [HOME.lon, HOME.lat] } }] };
    const imported = await theirs('POST', `${at}/airspace/zones/import`, { geojson });
    expect(imported.statusCode).toBe(409);
    expect(imported.json().message).toBe(message);
    // Edited: one more corner is refused; as many as before fit.
    const zone = (await theirs('GET', `${at}/airspace/zones`)).json().find((z: { name: string }) => z.name === 'P0');
    const bigger = await theirs('PATCH', `${at}/airspace/zones/${zone.id}`, { geometry: { kind: 'polygon', polygon: ring(zoneAt(0), 200, 200) } });
    expect(bigger.statusCode).toBe(409);
    expect((await theirs('PATCH', `${at}/airspace/zones/${zone.id}`, { geometry: { kind: 'polygon', polygon: ring(zoneAt(0), 250, 199) } })).statusCode).toBe(200);
    // Some deleted: room again.
    expect((await theirs('DELETE', `${at}/airspace/zones/${full.json().id}`)).statusCode).toBe(200);
    expect((await theirs('POST', `${at}/airspace/zones/import`, { geojson })).statusCode).toBe(201);
  }, 60_000);
});

describe('authorisations and the public safety map', () => {
  it('read and written a page at a time: every one, in order, as asked for', async () => {
    const other = await signup(s.app, { name: 'Lena Lists' });
    const at = `/api/v2/organisations/${other.orgId}`;
    const now = Date.now();
    // 250 approved public reservations (a long corridor each), created one second apart, starting in reverse order.
    // Far from where the other checks here are made.
    const away = destinationPoint(HOME, 200, 300_000);
    const line = Array.from({ length: 2000 }, (_, i) => destinationPoint(away, 90, i * 10));
    s.ctx.db.tx(() => {
      for (let i = 0; i < 250; i++) {
        s.ctx.db.run(
          `INSERT INTO authorizations (id, org_id, reference, geometry, max_alt_m, start_at, end_at, status, requested_by, conflicts, decision_reason, decided_at, is_public, created_at, approved_at)
           VALUES (?, ?, ?, ?, 100, ?, ?, 'approved', ?, '[]', 'Automatically approved – no conflicts', ?, 1, ?, ?)`,
          crypto.randomUUID(),
          other.orgId,
          `R-${String(i).padStart(3, '0')}`,
          JSON.stringify({ kind: 'corridor', line, widthM: 50 }),
          new Date(now + (300 - i) * 60_000).toISOString(),
          new Date(now + 2 * 86_400_000).toISOString(),
          other.userId,
          new Date(now).toISOString(),
          new Date(now - (250 - i) * 1000).toISOString(),
          new Date(now).toISOString(),
        );
      }
    });
    const theirs = api(s.app, other);
    const all = await theirs('GET', `${at}/airspace/authorizations?limit=300`);
    expect(all.headers['x-total-count']).toBe('250');
    const refs = all.json().map((x: { reference: string }) => x.reference);
    expect(refs).toHaveLength(250);
    // The most recent first.
    expect(refs.slice(0, 2)).toEqual(['R-249', 'R-248']);
    expect(refs.at(-1)).toBe('R-000');
    expect(all.json()[0].geometry.line).toHaveLength(2000);
    const some = (await theirs('GET', `${at}/airspace/authorizations?limit=120&offset=100`)).json().map((x: { reference: string }) => x.reference);
    expect(some).toEqual(refs.slice(100, 220));
    // The safety map: every public one in the window, the earliest start first.
    const map = (await s.app.inject({ method: 'GET', url: '/api/v2/public/safety-map' })).json();
    const mine = map.reservations.filter((r: { operator: string }) => r.operator === 'Lena Lists' || r.operator?.includes('Lena'));
    expect(mine).toHaveLength(250);
    expect(mine.slice(0, 2).map((r: { reference: string }) => r.reference)).toEqual(['R-249', 'R-248']);
    expect(typeof map.from).toBe('string');
  });
});

describe('zones at hand', () => {
  it('a zone created, edited or deleted is checked at once – the others are not read again', async () => {
    const other = await signup(s.app, { name: 'Hana Hand' });
    const at = `/api/v2/organisations/${other.orgId}`;
    const theirs = api(s.app, other);
    storeZones(other.orgId, Array.from({ length: 50 }, (_, k) => ({ name: `Far ${k}`, polygon: ring(destinationPoint(HOME, 180, 20_000 + k * 1000), 200, 20) })));
    await s.ctx.airspace.ready(other.orgId);
    const before = s.ctx.airspace.zones(other.orgId);
    const check = async () =>
      (await theirs('POST', `${at}/airspace/check`, { geometry: { kind: 'cylinder', center: HOME, radiusM: 100 }, maxAltM: 100, startAt: new Date(Date.now() + 60_000).toISOString(), endAt: new Date(Date.now() + 3_600_000).toISOString() })).json();
    expect((await check()).verdict).toBe('clear');
    const created = (await theirs('POST', `${at}/airspace/zones`, { name: 'Here', type: 'restricted', geometry: { kind: 'circle', center: HOME, radiusM: 50 } })).json();
    expect((await check()).conflicts.map((c: { name: string }) => c.name)).toEqual(['Here']);
    await theirs('PATCH', `${at}/airspace/zones/${created.id}`, { geometry: { kind: 'circle', center: destinationPoint(HOME, 0, 5000), radiusM: 50 } });
    expect((await check()).verdict).toBe('clear');
    await theirs('PATCH', `${at}/airspace/zones/${created.id}`, { geometry: { kind: 'circle', center: HOME, radiusM: 50 }, name: 'A here' });
    expect((await check()).conflicts.map((c: { name: string }) => c.name)).toEqual(['A here']);
    // In name order, as the database orders them; the others the very same objects (not read again).
    const after = s.ctx.airspace.zones(other.orgId);
    expect(after[0]!.name).toBe('A here');
    expect(after.slice(1)).toEqual(before);
    after.slice(1).forEach((z, i) => expect(z).toBe(before[i]));
    await theirs('DELETE', `${at}/airspace/zones/${created.id}`);
    expect((await check()).verdict).toBe('clear');
    expect(s.ctx.airspace.zones(other.orgId)).toHaveLength(50);
  });

  it('the least recently used organisations’ zones are let go beyond the points kept – and read again when needed', async () => {
    const a = await signup(s.app, { name: 'Ann A' });
    const b = await signup(s.app, { name: 'Ben B' });
    storeZones(a.orgId, [{ name: 'A1', polygon: ring(HOME, 100, 30) }]);
    storeZones(b.orgId, [{ name: 'B1', polygon: ring(HOME, 100, 30) }]);
    // Room for 40 points: one organisation's zones at a time.
    const provider = new OrgZoneProvider(s.ctx.db, 40);
    expect(provider.zonesIfReady(a.orgId)).toBeNull();
    await provider.ready(a.orgId);
    expect(provider.zonesIfReady(a.orgId)!.map((z) => z.name)).toEqual(['A1']);
    await provider.ready(b.orgId);
    expect(provider.zonesIfReady(b.orgId)!.map((z) => z.name)).toEqual(['B1']);
    // A's were let go (B's were used last); read again, they are as before.
    expect(provider.zonesIfReady(a.orgId)).toBeNull();
    await provider.ready(a.orgId);
    expect(provider.zonesIfReady(a.orgId)!.map((z) => z.name)).toEqual(['A1']);
    // One that is not at hand is still answered when asked at once.
    expect(provider.zones(b.orgId).map((z) => z.name)).toEqual(['B1']);
  });

  it('the live monitor checks against what it has read; after a change it waits for it – never a stale answer', async () => {
    const other = await signup(s.app, { name: 'Max Monitor' });
    const at = `/api/v2/organisations/${other.orgId}`;
    const theirs = api(s.app, other);
    const centre = destinationPoint(HOME, 90, 30_000);
    await theirs('POST', `${at}/airspace/zones`, { name: 'Control', type: 'controlled', geometry: { kind: 'circle', center: centre, radiusM: 500 }, ceilingM: 300 });
    const tel = { t: Date.now(), lat: centre.lat, lon: centre.lon, altRel: 40, altMsl: 50, inAir: true } as unknown as Telemetry;
    expect((await s.ctx.utm.detectWhenReady(other.orgId, 'drone', 'Kite', tel)).map((d) => d.code)).toEqual(['zone_infringement']);
    const auth = await theirs('POST', `${at}/airspace/authorizations`, { geometry: { kind: 'cylinder', center: centre, radiusM: 200 }, maxAltM: 100, startAt: new Date().toISOString(), endAt: new Date(Date.now() + 3_600_000).toISOString() });
    const id = auth.json().id;
    if (auth.json().status === 'pending') await theirs('POST', `${at}/airspace/authorizations/${id}/decision`, { decision: 'approve' });
    // Approved just now: what was read before is not used – the check waits for it to be read again.
    expect(s.ctx.utm.detect(other.orgId, 'drone', 'Kite', { ...tel, t: Date.now() })).toBeNull();
    expect(await s.ctx.utm.detectWhenReady(other.orgId, 'drone', 'Kite', { ...tel, t: Date.now() })).toEqual([]);
  });
});

describe('a start being checked', () => {
  let client: LinkClient;
  let drone: VirtualDrone;
  let droneId: string;
  beforeAll(async () => {
    const created = (await call('POST', `${org}/drones`, { name: 'Swift', model: 'X4' })).json();
    droneId = created.id;
    drone = new VirtualDrone({ home: HOME, groundAltMsl: 10, seed: 5 });
    client = new LinkClient({ url: `${s.wsBase}/api/v2/link`, key: created.linkKey, drone, timeScale: 4 });
    client.start();
    await waitFor(() => s.ctx.hub.droneState(droneId)?.online && s.ctx.hub.telemetryOf(droneId), 10_000);
    const items = [{ type: 'takeoff', alt: 20 }, { type: 'waypoint', ...destinationPoint(HOME, 45, 150), alt: 20 }, { type: 'land' }];
    const missionId = (await call('POST', `${org}/missions`, { name: 'Short hop', plan: { home: { ...HOME, alt: 0 }, items, rallyPoints: [], geofence: null, defaultSpeed: 8, defaultAlt: 20 } })).json().id;
    expect((await call('POST', `${org}/missions/${missionId}/upload`, { droneId })).json().result).toBe('accepted');
  }, 30_000);
  afterAll(async () => {
    await client?.stop();
  });

  it('a stop sent meanwhile goes at once and the start is not sent after it; any other command follows the start', async () => {
    const received: string[] = [];
    const handle = drone.handleCommand.bind(drone);
    drone.handleCommand = (c, p) => {
      received.push(c);
      return handle(c, p);
    };
    const me = { id: owner.userId, name: 'Zelda', role: 'owner' as const };
    const start = s.ctx.hub.sendCommand(owner.orgId, droneId, me, 'mission_start');
    const hold = s.ctx.hub.sendCommand(owner.orgId, droneId, me, 'hold');
    const [started, held] = await Promise.all([start, hold]);
    expect(held.delivered).toBe(true);
    expect(started).toMatchObject({ result: 'rejected', delivered: false });
    expect(started.message).toBe('Swift was told to stop (hold, land, return or pause) while the airspace was checked – mission_start not sent');
    expect(received).toEqual(['hold']);
    // Another command waits for the start being checked: the drone gets them in the order sent.
    received.length = 0;
    const again = s.ctx.hub.sendCommand(owner.orgId, droneId, me, 'mission_start');
    const speed = s.ctx.hub.sendCommand(owner.orgId, droneId, me, 'set_speed', { speed: 5 });
    expect((await again).delivered).toBe(true);
    expect((await speed).delivered).toBe(true);
    expect(received).toEqual(['mission_start', 'set_speed']);
    await s.ctx.hub.sendCommand(owner.orgId, droneId, me, 'land');
  }, 30_000);
});
