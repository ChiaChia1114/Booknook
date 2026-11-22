/**
 * The web application after a server update (bundles of the previous version are gone), names
 * made of spaces, and how many map tiles each user may have the server fetch.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { destinationPoint } from '@athena-sky/shared';
import { encodeTerrarium } from '../src/geo/terrain';
import { DiskTileCache, TileBudget, chargeTiles } from '../src/geo/tile-store';
import { addMember, api, multipart, signup, startServer, type Session, type TestServer } from './helpers';

const HOME = { lat: 25.0732, lon: 121.5355 };

describe('web application files', () => {
  let s: TestServer;
  let web: string;
  beforeAll(async () => {
    web = mkdtempSync(join(tmpdir(), 'athena-web-'));
    mkdirSync(join(web, 'assets'));
    mkdirSync(join(web, 'cesium', 'Workers'), { recursive: true });
    mkdirSync(join(web, 'models'));
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>Athena-sky</title><script type="module" src="/assets/index-B2.js"></script>');
    writeFileSync(join(web, 'assets', 'index-B2.js'), 'console.log("v2")');
    writeFileSync(join(web, 'cesium', 'Workers', 'transferTypedArrayTest.js'), 'self.onmessage=()=>{}');
    writeFileSync(join(web, 'models', 'quad.glb'), Buffer.from('glTF'));
    s = await startServer({ config: { webDist: web } });
  });
  afterAll(async () => {
    await s.close();
    rmSync(web, { recursive: true, force: true });
  });
  const get = (url: string) => s.app.inject({ method: 'GET', url });

  it('checks the application page again on every visit, so an update is picked up at once', async () => {
    for (const url of ['/', '/fleet', '/missions/2f0d6c1e-9a51-4c38-9a59-1d0f2c7c9b10?tab=plan']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(res.headers['cache-control'], url).toBe('no-cache');
      expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    }
  });

  it('keeps hashed bundles for a year and checks every other file again', async () => {
    const bundle = await get('/assets/index-B2.js');
    expect(bundle.statusCode).toBe(200);
    expect(bundle.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const worker = await get('/cesium/Workers/transferTypedArrayTest.js');
    expect(worker.statusCode).toBe(200);
    expect(worker.headers['cache-control']).toBe('no-cache');
    expect((await get('/models/quad.glb')).headers['cache-control']).toBe('no-cache');
    // Files of a new version written while the server runs are served.
    writeFileSync(join(web, 'assets', 'Planner-C3.js'), 'export default 1');
    expect((await get('/assets/Planner-C3.js')).statusCode).toBe(200);
  });

  it('answers files that do not exist (a bundle of the previous version) with 404, not the application page', async () => {
    for (const url of ['/assets/MissionPlanner-4cOQnR2F.js', '/assets/index-OLD.css', '/cesium/Workers/gone.js', '/models/none.glb', '/favicon.ico', '/assets']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type'], url).not.toMatch(/text\/html/);
    }
    expect((await get('/api/v2/nothing')).statusCode).toBe(404);
    expect((await get('/%E0%A4%A')).statusCode).toBe(400);
    expect((await get('/../package.json')).statusCode).not.toBe(200);
  });
});

describe('names', () => {
  let s: TestServer;
  let u: Session;
  let droneId: string;
  beforeAll(async () => {
    s = await startServer();
    u = await signup(s.app, { name: 'Nora Names' });
    droneId = (await api(s.app, u)('POST', `/api/v2/organisations/${u.orgId}/drones`, { name: 'Wren', model: 'X4' })).json().id;
  });
  afterAll(async () => {
    await s.close();
  });

  it('refuses names made of spaces alone, everywhere a name is given', async () => {
    const call = api(s.app, u);
    const blank = ' \t  ';
    const org = `/api/v2/organisations/${u.orgId}`;
    const attempts: [string, Promise<{ statusCode: number; body: string }>][] = [
      ['drone', call('POST', `${org}/drones`, { name: blank, model: 'X4' })],
      ['drone rename', call('PATCH', `${org}/drones/${droneId}`, { name: blank })],
      ['fleet', call('POST', `${org}/fleets`, { name: blank })],
      ['mission', call('POST', `${org}/missions`, { name: blank })],
      ['zone', call('POST', `${org}/airspace/zones`, { name: blank, type: 'restricted', geometry: { kind: 'circle', center: { lat: 25, lon: 121 }, radiusM: 100 } })],
      ['organisation', call('PATCH', org, { name: blank })],
      ['new organisation', call('POST', '/api/v2/organisations', { name: blank })],
      ['profile', call('PATCH', '/api/v2/auth/me', { name: blank })],
      ['API token', call('POST', '/api/v2/tokens', { name: blank })],
      ['maintenance task', call('POST', `${org}/drones/${droneId}/maintenance/tasks`, { name: blank, intervalFlights: 10 })],
      ['signup', s.app.inject({ method: 'POST', url: '/api/v2/auth/signup', payload: { email: 'blank@example.com', password: 'correct-horse-battery', name: blank } })],
      ['signup organisation', s.app.inject({ method: 'POST', url: '/api/v2/auth/signup', payload: { email: 'blank2@example.com', password: 'correct-horse-battery', name: 'Bea', organisationName: blank } })],
    ];
    for (const [what, p] of attempts) {
      const res = await p;
      expect(res.statusCode, `${what}: ${res.body}`).toBe(400);
    }
    expect((await call('GET', `${org}/drones/${droneId}`)).json().name).toBe('Wren');
  });

  it('stores names without the spaces around them', async () => {
    const d = (await api(s.app, u)('POST', `/api/v2/organisations/${u.orgId}/drones`, { name: '  Kestrel 2 ', model: 'X4' })).json();
    expect(d.name).toBe('Kestrel 2');
  });

  it('names what was stored nameless before', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'athena-names-'));
    try {
      const a = await startServer({ dataDir });
      const v = await signup(a.app, { name: 'Old Data', email: 'olddata@example.com' });
      const d = (await api(a.app, v)('POST', `/api/v2/organisations/${v.orgId}/drones`, { name: 'Tmp', model: 'X4' })).json();
      a.ctx.db.run("UPDATE drones SET name = '' WHERE id = ?", d.id);
      a.ctx.db.run("UPDATE users SET name = '  ' WHERE id = ?", v.userId);
      a.ctx.db.run("UPDATE organisations SET name = '' WHERE id = ?", v.orgId);
      a.ctx.db.run('UPDATE schema_version SET version = 10');
      await a.close();
      const b = await startServer({ dataDir });
      try {
        expect(b.ctx.db.get<{ name: string }>('SELECT name FROM drones WHERE id = ?', d.id)?.name).toBe('Unnamed drone');
        expect(b.ctx.db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', v.userId)?.name).toBe('olddata');
        expect(b.ctx.db.get<{ name: string }>('SELECT name FROM organisations WHERE id = ?', v.orgId)?.name).toBe('Unnamed organisation');
      } finally {
        await b.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('map tiles fetched for each user', () => {
  it('allow a burst of half the hourly allowance, refilled over the hour', () => {
    let now = 0;
    const budget = new TileBudget(200, () => now);
    expect(budget.burst).toBe(100);
    expect(budget.take('ann', 60)).toBe(0);
    expect(budget.take('ann', 40)).toBe(0);
    // Spent: one more tile in 18 s (200 an hour).
    expect(budget.take('ann', 1)).toBe(18);
    expect(budget.take('bob', 100)).toBe(0);
    now += 18_000;
    expect(budget.take('ann', 1)).toBe(0);
    expect(budget.take('ann', 1)).toBeGreaterThan(0);
    // Nothing is charged without a limit – not even requests needing many tiles at once.
    expect(new TileBudget(0).take('ann', 10_000)).toBe(0);
    const reply = { header: () => undefined };
    expect(() => chargeTiles(reply, new TileBudget(0), 'ann', 5_000, 'terrain')).not.toThrow();
    expect(() => chargeTiles(reply, new TileBudget(200), 'ann', 101, 'terrain')).toThrow(/at most 100 are fetched at once/);
  });

  it('keep the disk cache within its size, dropping the least recently used tiles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'athena-tiles-'));
    try {
      const tile = Buffer.alloc(1000, 7);
      const cache = new DiskTileCache(dir, 'png', 10_000);
      for (let i = 0; i < 10; i++) cache.put(12, i, 1, tile);
      expect(cache.usage).toEqual({ tiles: 10, bytes: 10_000 });
      // Tile 0 is used again: tile 1 is the least recently used now.
      expect(cache.get(12, 0, 1)?.length).toBe(1000);
      cache.put(12, 10, 1, tile);
      expect(cache.usage.bytes).toBeLessThanOrEqual(9_000);
      expect(cache.has(12, 0, 1)).toBe(true);
      expect(cache.has(12, 1, 1)).toBe(false);
      expect(cache.has(12, 10, 1)).toBe(true);
      // Started again with less room: the tiles on disk are found and trimmed to it.
      const again = new DiskTileCache(dir, 'png', 5_000);
      expect(again.usage.bytes).toBeLessThanOrEqual(5_000);
      expect(again.usage.tiles).toBeGreaterThan(0);
      expect(new DiskTileCache(dir, 'png', 5_000).usage).toEqual(again.usage);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('terrain', () => {
    let s: TestServer;
    let u: Session;
    let w: Session;
    const fetched: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      fetched.push(String(input));
      return new Response(encodeTerrarium(() => 42), { status: 200, headers: { 'content-type': 'image/png' } });
    };
    beforeAll(async () => {
      s = await startServer({ fetchImpl: fakeFetch, config: { terrainUrl: 'https://dem.test/{z}/{x}/{y}.png', tileFetchesPerHour: 200 } });
      u = await signup(s.app, { name: 'Tia Tiles' });
      w = await signup(s.app, { name: 'Walt Wide' });
    });
    afterAll(async () => {
      await s.close();
    });

    it('fetches tiles not cached yet within each user’s allowance; cached tiles stay free', async () => {
      const tile = (sess: Session, x: number) => api(s.app, sess)('GET', `/api/v2/terrain/tiles/12/${x}/1700.png`);
      for (let x = 0; x < 100; x++) expect((await tile(u, x)).statusCode).toBe(200);
      expect(fetched.length).toBe(100);
      const refused = await tile(u, 100);
      expect(refused.statusCode).toBe(429);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(fetched.length).toBe(100);
      // Cached: served; another user has an allowance of their own.
      expect((await tile(u, 5)).statusCode).toBe(200);
      expect((await tile(w, 100)).statusCode).toBe(200);
      expect((await api(s.app, u)('GET', '/api/v2/terrain/tiles/16/0/0.png')).statusCode).toBe(400);
    });

    it('charges the tiles an elevation request needs, and refuses requests needing more than a burst', async () => {
      const points = (n: number, lat: number) => Array.from({ length: n }, (_, i) => ({ lat, lon: -170 + i * 0.1 }));
      const before = fetched.length;
      const big = await api(s.app, w)('POST', '/api/v2/terrain/elevation', { points: points(150, 10) });
      expect(big.statusCode).toBe(400);
      expect(fetched.length).toBe(before);
      const ok = await api(s.app, w)('POST', '/api/v2/terrain/elevation', { points: points(60, 20) });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().elevations.every((e: number | null) => e === 42)).toBe(true);
      // Same points again: cached, free.
      expect((await api(s.app, w)('POST', '/api/v2/terrain/elevation', { points: points(60, 20) })).statusCode).toBe(200);
      expect((await api(s.app, w)('POST', '/api/v2/terrain/elevation', { points: points(60, 30) })).statusCode).toBe(429);
    });
  });
});

describe('pilots of flights', () => {
  let s: TestServer;
  let owner: Session;
  let observer: Session;
  let pilot: Session;
  let droneId: string;
  beforeAll(async () => {
    s = await startServer();
    owner = await signup(s.app, { name: 'Olga Owner' });
    observer = await signup(s.app, { name: 'Otis Observer' });
    pilot = await signup(s.app, { name: 'Pia Pilot' });
    await addMember(s.app, owner, observer, 'viewer');
    await addMember(s.app, owner, pilot, 'pilot');
    droneId = (await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: 'Lark', model: 'X4' })).json().id;
  });
  afterAll(async () => {
    await s.close();
  });

  it('are members allowed to fly – for uploaded logs and when a flight is edited', async () => {
    const csv = ['time(s),latitude,longitude,altitude_rel', ...Array.from({ length: 30 }, (_, i) => {
      const p = destinationPoint(HOME, 45, i * 4);
      return `${i},${p.lat.toFixed(7)},${p.lon.toFixed(7)},15`;
    })].join('\n');
    const upload = (pilotId: string, name: string) => {
      const mp = multipart({ droneId, pilotId }, [{ field: 'file', filename: name, content: Buffer.from(csv + `\n# ${name}`) }]);
      return s.app.inject({ method: 'POST', url: `/api/v2/organisations/${owner.orgId}/flights/upload`, headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf, 'content-type': mp.contentType }, payload: mp.body });
    };
    const refused = await upload(observer.userId, 'a.csv');
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toMatch(/cannot fly drones/);
    const ok = await upload(pilot.userId, 'b.csv');
    expect(ok.statusCode).toBe(201);
    expect(ok.json().pilotId).toBe(pilot.userId);
    const flight = `/api/v2/organisations/${owner.orgId}/flights/${ok.json().id}`;
    expect((await api(s.app, owner)('PATCH', flight, { pilotId: observer.userId })).statusCode).toBe(400);
    expect((await api(s.app, owner)('PATCH', flight, { pilotId: owner.userId })).json().pilotId).toBe(owner.userId);
    // A pilot recorded before keeps their place when the flight is edited – also once their role changed.
    expect((await api(s.app, owner)('PATCH', flight, { pilotId: pilot.userId })).statusCode).toBe(200);
    s.ctx.db.run('UPDATE memberships SET role = ? WHERE user_id = ? AND org_id = ?', 'viewer', pilot.userId, owner.orgId);
    const edited = await api(s.app, owner)('PATCH', flight, { notes: 'windy', pilotId: pilot.userId });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ notes: 'windy', pilotId: pilot.userId });
  });
});

describe('airspace from GeoJSON', () => {
  let s: TestServer;
  let u: Session;
  beforeAll(async () => {
    s = await startServer();
    u = await signup(s.app, { name: 'Gia GeoJSON' });
  });
  afterAll(async () => {
    await s.close();
  });

  it('takes multi-polygons as one zone per polygon, points with a radius, and says what it skipped or simplified', async () => {
    const square = (c: { lat: number; lon: number }, m: number) => {
      const ring = [45, 135, 225, 315].map((b) => destinationPoint(c, b, m)).map((p) => [p.lon, p.lat]);
      return [...ring, ring[0]!];
    };
    const a = destinationPoint(HOME, 0, 2000);
    const b = destinationPoint(HOME, 90, 2000);
    const res = await api(s.app, u)('POST', `/api/v2/organisations/${u.orgId}/airspace/zones/import`, {
      geojson: {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', id: 'twin', properties: { name: 'Twin parks', type: 'restricted' }, geometry: { type: 'MultiPolygon', coordinates: [[square(a, 300)], [square(b, 300)]] } },
          { type: 'Feature', properties: { name: 'Stadium', type: 'temporary', radius: 400 }, geometry: { type: 'Point', coordinates: [HOME.lon, HOME.lat] } },
          { type: 'Feature', properties: { name: 'Lake', type: 'restricted' }, geometry: { type: 'Polygon', coordinates: [square(HOME, 1500), square(HOME, 500)] } },
          { type: 'Feature', properties: { name: '   ' }, geometry: { type: 'Polygon', coordinates: [square(destinationPoint(HOME, 180, 3000), 200)] } },
          { type: 'Feature', properties: { name: 'Mast' }, geometry: { type: 'Point', coordinates: [HOME.lon, HOME.lat] } },
          { type: 'Feature', properties: { name: 'Route' }, geometry: { type: 'MultiLineString', coordinates: [] } },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { imported: number; skipped: string[]; warnings: string[] };
    expect(body.imported).toBe(5);
    expect(body.skipped).toEqual([expect.stringMatching(/^Mast: a Point needs its radius in metres \(property radiusM\)/), expect.stringMatching(/^Route: unsupported geometry MultiLineString/)]);
    expect(body.warnings).toEqual(['Lake: holes are not supported – the zone covers them']);
    const zones = (await api(s.app, u)('GET', `/api/v2/organisations/${u.orgId}/airspace/zones`)).json() as { name: string; geometry: { kind: string; radiusM?: number } }[];
    expect(zones.map((z) => z.name).sort()).toEqual(['Lake', 'Stadium', 'Twin parks (1/2)', 'Twin parks (2/2)', 'Zone 4']);
    expect(zones.find((z) => z.name === 'Stadium')?.geometry).toMatchObject({ kind: 'circle', radiusM: 400 });
  });
});
