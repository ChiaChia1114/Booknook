/**
 * Real places in the simulated drone cameras: the server's aerial imagery tile cache (as SkyWeave
 * serves its geodata), the camera rendering the ground from those tiles, and on-board detection
 * of the people and vehicles in view.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import jpeg from 'jpeg-js';
import { FrameRenderer, GroundImagery, LinkClient, SimWorld, VIDEO_PRESETS, VirtualDrone, cameraPose, visibleObjects, worldAnchor } from '@athena-sky/simulator';
import { api, signup, startServer, waitFor, type Session, type TestServer } from './helpers';
import { ImageryService } from '../src/geo/imagery';

const HOME = { lat: 25.0732, lon: 121.5355 };
/** A plain magenta 256 × 256 JPEG tile. */
const MAGENTA = Buffer.from(jpeg.encode({ data: Buffer.alloc(256 * 256 * 4, Buffer.from([200, 30, 160, 255])), width: 256, height: 256 }, 90).data);

let upstream: Server;
let upstreamUrl: string;
let requests: string[] = [];

beforeAll(async () => {
  upstream = createServer((req, res) => {
    requests.push(req.url ?? '');
    if (/^\/tiles\/\d+\/\d+\/\d+$/.test(req.url ?? '') && !req.url!.startsWith('/tiles/18/')) {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(MAGENTA);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/tiles/{z}/{x}/{y}`;
});
afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
});

describe('aerial imagery tile cache', () => {
  let s: TestServer;
  let u: Session;
  beforeAll(async () => {
    s = await startServer({ config: { imageryUrl: upstreamUrl } });
    u = await signup(s.app, { name: 'Ida Imagery' });
  });
  afterAll(async () => {
    await s.close();
  });

  it('serves tiles to signed-in users, fetching each from the tile service once and keeping it on disk', async () => {
    requests = [];
    expect((await s.app.inject({ method: 'GET', url: '/api/v2/tiles/imagery/17/109000/56000' })).statusCode).toBe(401);
    const first = await api(s.app, u)('GET', '/api/v2/tiles/imagery/17/109000/56000');
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('image/jpeg');
    expect(first.rawPayload.equals(MAGENTA)).toBe(true);
    const again = await api(s.app, u)('GET', '/api/v2/tiles/imagery/17/109000/56000');
    expect(again.rawPayload.equals(MAGENTA)).toBe(true);
    expect(requests).toEqual(['/tiles/17/109000/56000']);
    expect(existsSync(join(s.dataDir, 'imagery-cache', '17', '109000', '56000.tile'))).toBe(true);
    // The web application learns that it can use it.
    expect((await api(s.app, u)('GET', '/api/v2/config')).json()).toMatchObject({ imagery: true });
  });

  it('refuses tiles out of range, and reports tiles the service does not deliver (not asked again at once)', async () => {
    expect((await api(s.app, u)('GET', '/api/v2/tiles/imagery/20/1/1')).statusCode).toBe(400);
    expect((await api(s.app, u)('GET', '/api/v2/tiles/imagery/3/8/1')).statusCode).toBe(400);
    requests = [];
    expect((await api(s.app, u)('GET', '/api/v2/tiles/imagery/18/1/1')).statusCode).toBe(502);
    expect((await api(s.app, u)('GET', '/api/v2/tiles/imagery/18/1/1')).statusCode).toBe(502);
    expect(requests).toEqual(['/tiles/18/1/1']);
  });

  it('is off without a tile service', async () => {
    const off = await startServer();
    try {
      const v = await signup(off.app, { name: 'Otto Offline' });
      expect((await api(off.app, v)('GET', '/api/v2/tiles/imagery/17/109000/56000')).statusCode).toBe(503);
      expect((await api(off.app, v)('GET', '/api/v2/config')).json()).toMatchObject({ imagery: false });
    } finally {
      await off.close();
    }
  });
});

describe('aerial imagery fetched for each user', () => {
  let s: TestServer;
  let a: Session;
  let b: Session;
  beforeAll(async () => {
    s = await startServer({ config: { imageryUrl: upstreamUrl, tileFetchesPerHour: 200 } });
    a = await signup(s.app, { name: 'Ada Allowance' });
    b = await signup(s.app, { name: 'Bo Burst' });
  });
  afterAll(async () => {
    await s.close();
  });

  it('fetches tiles not cached yet within each user’s allowance, while cached tiles stay free', async () => {
    requests = [];
    const tile = (u: Session, x: number) => api(s.app, u)('GET', `/api/v2/tiles/imagery/17/${109_000 + x}/56000`);
    for (let x = 0; x < 100; x++) expect((await tile(a, x)).statusCode).toBe(200);
    expect(requests.length).toBe(100);
    const refused = await tile(a, 100);
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(requests.length).toBe(100);
    expect((await tile(a, 7)).statusCode).toBe(200);
    expect((await tile(b, 100)).statusCode).toBe(200);
    expect(requests.length).toBe(101);
  });

  it('keeps the tile cache on disk within its size', async () => {
    const cacheDir = join(process.env.TMPDIR ?? '/tmp', `athena-imagery-bound-${Date.now()}`);
    const service = new ImageryService({ urlTemplate: upstreamUrl, cacheDir, maxBytes: MAGENTA.length * 5 });
    for (let x = 0; x < 12; x++) expect((await service.tile(16, 54_000 + x, 28_000))?.equals(MAGENTA)).toBe(true);
    expect(service.usage.bytes).toBeLessThanOrEqual(MAGENTA.length * 5);
    // Tiles removed with the directories they leave empty.
    expect(readdirSync(join(cacheDir, '16'), { recursive: true }).filter((f) => String(f).endsWith('.tile')).length).toBeLessThanOrEqual(5);
    expect(readdirSync(join(cacheDir, '16')).length).toBeLessThanOrEqual(5);
    // The most recent tiles are kept.
    expect(service.isCached(16, 54_011, 28_000)).toBe(true);
    expect(service.isCached(16, 54_000, 28_000)).toBe(false);
    rmSync(cacheDir, { recursive: true, force: true });
  });
});

describe('the simulated camera over real imagery', () => {
  it('shows the imagery under the drone once its tiles are loaded (and the procedural landscape before)', async () => {
    const service = new ImageryService({ urlTemplate: upstreamUrl, cacheDir: join(process.env.TMPDIR ?? '/tmp', `athena-imagery-${Date.now()}`) });
    const imagery = new GroundImagery((z, x, y) => service.tile(z, x, y));
    const renderer = new FrameRenderer(VIDEO_PRESETS.sd, imagery);
    const t = { lat: HOME.lat, lon: HOME.lon, altRel: 40, heading: 30 };
    const pixel = (buf: Buffer, x: number, y: number) => Array.from(buf.subarray((y * 640 + x) * 4, (y * 640 + x) * 4 + 3));
    const before = pixel(renderer.renderRaw(t, HOME), 320, 300);
    expect(before).not.toEqual([200, 30, 160]);
    await waitFor(() => imagery.size >= 2, 10_000);
    await new Promise((r) => setTimeout(r, 300));
    const after = pixel(renderer.renderRaw(t, HOME), 320, 300);
    // Magenta (JPEG-encoded, slightly hazed in the distance).
    expect(Math.abs(after[0]! - 200)).toBeLessThan(25);
    expect(Math.abs(after[1]! - 30)).toBeLessThan(25);
    expect(Math.abs(after[2]! - 160)).toBeLessThan(25);
  });

  it('detects on board the people and vehicles in view', () => {
    const world = new SimWorld(worldAnchor(HOME));
    const now = Date.UTC(2026, 10, 22, 4, 0);
    const target = world.targetsAt(now).find((x) => x.kind === 'person')!;
    // 20 m behind the person, looking at it from 15 m up.
    const kx = 111_320 * Math.cos((world.anchor.lat * Math.PI) / 180);
    const tel = { lat: world.anchor.lat + (target.north - 15) / 111_320, lon: world.anchor.lon + target.east / kx, altRel: 15, heading: 0 };
    const seen = visibleObjects(cameraPose(tel, world.anchor, 640, 360), world.targetsAt(now));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((o) => o.cls === 'person' && o.box[2] > 0 && o.box[3] > 0 && o.box[0] >= 0 && o.box[0] + o.box[2] <= 1)).toBe(true);
    // Looking away from everything: nothing.
    expect(visibleObjects(cameraPose({ ...tel, lat: tel.lat + 0.02 }, world.anchor, 640, 360), world.targetsAt(now))).toEqual([]);
  });
});

describe('on-board object detection', () => {
  let s: TestServer;
  let u: Session;
  let client: LinkClient;
  let droneId: string;
  beforeAll(async () => {
    s = await startServer();
    u = await signup(s.app, { name: 'Ari Onboard' });
    const d = (await api(s.app, u)('POST', `/api/v2/organisations/${u.orgId}/drones`, { name: 'Owl', model: 'X4' })).json();
    droneId = d.id;
    client = new LinkClient({ url: `${s.wsBase}/api/v2/link`, key: d.linkKey, drone: new VirtualDrone({ home: HOME, groundAltMsl: 10, seed: 5 }), video: false, onboardAi: true, timeScale: 4 });
    client.start();
    await waitFor(() => s.ctx.hub.telemetryOf(droneId), 10_000);
    await waitFor(() => s.ctx.hub.hasOnboardAi(droneId), 5_000);
  });
  afterAll(async () => {
    await client.stop();
    await s.close();
  });

  it('is started and stopped on the drone; its reports are used while it is on, and ignored after', async () => {
    const ai = (enabled: boolean) => api(s.app, u)('POST', `/api/v2/organisations/${u.orgId}/drones/${droneId}/ai`, { enabled });
    const reports = () => (s.ctx.vision as unknown as { sessions: Map<string, { lastOnboardAt: number }> }).sessions.get(droneId)?.lastOnboardAt ?? 0;
    expect((await ai(true)).json()).toMatchObject({ status: { enabled: true, source: 'onboard' } });
    // The drone reports what it sees (5 Hz) – no video is asked for.
    const t0 = Date.now();
    await waitFor(() => reports() > t0, 5_000);
    expect(s.ctx.hub.droneState(droneId)?.ai).toMatchObject({ enabled: true, source: 'onboard' });
    expect((await ai(false)).json().status?.enabled ?? false).toBe(false);
    // Stopped on board: whatever still arrives does not turn detection back on.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(s.ctx.hub.droneState(droneId)?.ai?.enabled ?? false).toBe(false);
    expect(s.ctx.vision.objects(droneId)).toEqual([]);
  });
});
