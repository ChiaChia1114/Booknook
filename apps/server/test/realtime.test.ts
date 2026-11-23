import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodeLiveVideoFrame, destinationPoint } from '@athena-sky/shared';
import { LinkClient, VirtualDrone } from '@athena-sky/simulator';
import { addMember, api, multipart, signup, startServer, Viewer, waitFor, type Session, type TestServer } from './helpers';

const HOME = { lat: 25.0732, lon: 121.5355 };

let s: TestServer;
let owner: Session;
let pilot2: Session;
let observer: Session;
let droneId: string;
let linkKey: string;
let client: LinkClient;
let drone: VirtualDrone;
let viewer: Viewer;
let hookServer: Server;
let hookSecret: string;
const hooks: { event: string; body: any; signatureOk: boolean }[] = [];

beforeAll(async () => {
  s = await startServer();
  hookServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const ts = String(req.headers['x-athena-timestamp']);
      const expected = `sha256=${createHmac('sha256', hookSecret).update(`${ts}.${body}`).digest('hex')}`;
      hooks.push({ event: String(req.headers['x-athena-event']), body: JSON.parse(body), signatureOk: expected === req.headers['x-athena-signature'] });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => hookServer.listen(0, '127.0.0.1', () => r()));
  owner = await signup(s.app, { name: 'Olivia Owner' });
  const call = api(s.app, owner);
  const hook = await call('POST', `/api/v2/organisations/${owner.orgId}/webhooks`, {
    url: `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/hook`,
    events: ['drone.online', 'flight.started', 'flight.ended', 'flight.analyzed', 'telemetry', 'firmware.updated'],
  });
  hookSecret = hook.json().secret;
  pilot2 = await signup(s.app, { name: 'Second Pilot' });
  observer = await signup(s.app, { name: 'Command Centre' });
  await addMember(s.app, owner, pilot2, 'pilot');
  await addMember(s.app, owner, observer, 'viewer');
  const created = await call('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: 'Falcon', model: 'X4' });
  droneId = created.json().id;
  linkKey = created.json().linkKey;
  drone = new VirtualDrone({ home: HOME, groundAltMsl: 10, seed: 7 });
  client = new LinkClient({ url: `${s.wsBase}/api/v2/link`, key: linkKey, drone, timeScale: 4, video: true, payload: true });
  client.start();
  viewer = new Viewer(`${s.wsBase}/api/v2/live?org=${owner.orgId}`, { cookie: owner.cookie, origin: s.baseUrl });
  await viewer.opened;
});

afterAll(async () => {
  viewer?.close();
  await client?.stop();
  await new Promise<void>((r) => hookServer.close(() => r()));
  await s.close();
});

const ack = (requestId: string) => viewer.wait((m) => m.type === 'ack' && m.requestId === requestId);
const tel = () => [...viewer.messages].reverse().find((m) => m.type === 'telemetry' && m.droneId === droneId)?.data;

describe('F9 real-time flights over the Athena Link / Live WebSockets', () => {
  it('rejects bad drone keys and unauthenticated or cross-site viewers', async () => {
    const WebSocket = (await import('ws')).default;
    const bad = new WebSocket(`${s.wsBase}/api/v2/link`, { headers: { authorization: 'Bearer adk_wrong' } });
    const code = await new Promise<number>((r) => bad.on('close', (c) => r(c)));
    expect(code).toBe(4403);
    const anon = new Viewer(`${s.wsBase}/api/v2/live?org=${owner.orgId}`, {});
    await expect(anon.opened).rejects.toThrow(/401/);
    const csrf = new Viewer(`${s.wsBase}/api/v2/live?org=${owner.orgId}`, { cookie: owner.cookie, origin: 'https://evil.example.com' });
    await expect(csrf.opened).rejects.toThrow(/403/);
    const other = await signup(s.app);
    const foreign = new Viewer(`${s.wsBase}/api/v2/live?org=${owner.orgId}`, { cookie: other.cookie });
    await expect(foreign.opened).rejects.toThrow(/404/);
  });

  it('shows the drone online with firmware and streams telemetry', async () => {
    await viewer.wait((m) => m.type === 'hello' && m.canControl === true);
    await viewer.wait((m) => m.type === 'status' && m.drone.droneId === droneId && m.drone.online && m.drone.firmware === 'athena-fc 2.4.0');
    await waitFor(() => tel());
    expect(tel()).toMatchObject({ armed: false, inAir: false, mode: 'HOLD' });
    expect(Math.abs(tel().lat - HOME.lat)).toBeLessThan(1e-4);
    const online = await api(s.app, observer)('GET', `/api/v2/organisations/${owner.orgId}/online`);
    expect(online.json().drones.map((d: any) => d.droneId)).toContain(droneId);
    expect(online.json().users.map((u: any) => u.userId)).toContain(owner.userId);
    await waitFor(() => hooks.find((h) => h.event === 'drone.online'));
    expect(hooks.find((h) => h.event === 'drone.online')!.signatureOk).toBe(true);
  });

  it('relays live HD/SD video frames only while somebody watches', async () => {
    viewer.send({ type: 'video', droneId, enabled: true, quality: 'sd' });
    await waitFor(() => viewer.frames.length >= 2, 15_000);
    const f = decodeLiveVideoFrame(new Uint8Array(viewer.frames[0]!))!;
    expect(f.droneId).toBe(droneId);
    expect([f.jpeg[0], f.jpeg[1]]).toEqual([0xff, 0xd8]);
    viewer.send({ type: 'video', droneId, enabled: false });
    await new Promise((r) => setTimeout(r, 400));
    const n = viewer.frames.length;
    await new Promise((r) => setTimeout(r, 600));
    expect(viewer.frames.length - n).toBeLessThanOrEqual(1);
  });

  it('measures end-to-end latency to the drone', async () => {
    viewer.send({ type: 'ping', id: 'p1', t: Date.now(), droneId });
    const pong = await viewer.wait((m) => m.type === 'pong' && m.id === 'p1');
    expect(typeof pong.droneRttMs).toBe('number');
    expect(pong.droneRttMs).toBeLessThan(2000);
  });

  it('takes off on command and records a live flight', async () => {
    viewer.send({ type: 'command', droneId, requestId: 'r1', command: 'takeoff', params: { alt: 8 } });
    expect((await ack('r1')).result).toBe('accepted');
    const started = await viewer.wait((m) => m.type === 'flight' && m.state === 'started');
    await waitFor(() => tel()?.altRel > 7.5);
    const ctl = await viewer.wait((m) => m.type === 'control' && m.controller?.userId === owner.userId);
    expect(ctl.controller.name).toBe('Olivia Owner');
    const f = s.ctx.db.get<any>('SELECT * FROM flights WHERE id = ?', started.flightId);
    expect(f).toMatchObject({ status: 'in_progress', drone_id: droneId, pilot_id: owner.userId, source: 'live' });
    await waitFor(() => hooks.find((h) => h.event === 'flight.started'));
    await waitFor(() => hooks.find((h) => h.event === 'telemetry'));
  });

  it('enforces the control lock and observer role', async () => {
    const p2 = new Viewer(`${s.wsBase}/api/v2/live?org=${owner.orgId}`, { cookie: pilot2.cookie });
    await p2.opened;
    p2.send({ type: 'command', droneId, requestId: 'x1', command: 'land' });
    const r = await p2.wait((m) => m.type === 'ack' && m.requestId === 'x1');
    expect(r.result).toBe('rejected');
    expect(r.message).toMatch(/controlled by Olivia Owner/);
    p2.send({ type: 'control', droneId, action: 'request' });
    await p2.wait((m) => m.type === 'error' && /controlled by/.test(m.message));
    const obs = new Viewer(`${s.wsBase}/api/v2/live?org=${owner.orgId}`, { cookie: observer.cookie });
    await obs.opened;
    await obs.wait((m) => m.type === 'hello' && m.canControl === false);
    obs.send({ type: 'command', droneId, requestId: 'o1', command: 'rtl' });
    expect((await obs.wait((m) => m.type === 'ack' && m.requestId === 'o1')).message).toMatch(/role cannot control/);
    // observers still receive the telemetry of the flight ("Everywhere")
    await obs.wait((m) => m.type === 'telemetry' && m.droneId === droneId && m.data.inAir);
    p2.close();
    obs.close();
  });

  it('flies to a clicked point (goto) and manual control moves the drone', async () => {
    const target = destinationPoint(HOME, 0, 25);
    viewer.send({ type: 'command', droneId, requestId: 'g1', command: 'goto', params: { lat: target.lat, lon: target.lon, alt: 10 } });
    expect((await ack('g1')).result).toBe('accepted');
    await waitFor(() => tel()?.mode === 'HOLD' && Math.abs(tel().lat - target.lat) < 2e-5, 20_000);
    const before = tel().altRel;
    for (let i = 0; i < 15; i++) {
      viewer.send({ type: 'manual_control', droneId, x: 0, y: 0, z: 1, r: 0 });
      await new Promise((r) => setTimeout(r, 60));
    }
    await waitFor(() => tel()?.mode === 'POSCTL' && tel().altRel > before + 1);
  });

  it('lands, closes the flight and runs post-flight analytics', async () => {
    viewer.send({ type: 'command', droneId, requestId: 'l1', command: 'land' });
    expect((await ack('l1')).result).toBe('accepted');
    const ended = await viewer.wait((m) => m.type === 'flight' && m.state === 'ended', 30_000);
    const flight = await waitFor(() => s.ctx.db.get<any>("SELECT * FROM flights WHERE id = ? AND status = 'completed' AND health_score IS NOT NULL", ended.flightId), 10_000);
    expect(flight.duration_s).toBeGreaterThan(1);
    expect(flight.max_alt_m).toBeGreaterThan(7);
    expect(flight.distance_m).toBeGreaterThan(15);
    const samples = s.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM flight_samples WHERE flight_id = ?', ended.flightId)!.n;
    expect(samples).toBeGreaterThan(3);
    const events = s.ctx.db.all<{ code: string }>('SELECT code FROM flight_events WHERE flight_id = ?', ended.flightId).map((e) => e.code);
    expect(events).toEqual(expect.arrayContaining(['takeoff', 'flight_end']));
    const payload = await api(s.app, owner)('GET', `/api/v2/organisations/${owner.orgId}/flights/${ended.flightId}/payload`);
    expect(payload.json().some((p: any) => p.kind === 'environment')).toBe(true);
    await waitFor(() => hooks.find((h) => h.event === 'flight.ended' && h.body.data.flight.id === ended.flightId));
    await waitFor(() => hooks.find((h) => h.event === 'flight.analyzed'));
    // post-flight sync: the on-board ULog is attached to the same live flight
    const file = await waitFor(() => s.ctx.db.get<any>("SELECT * FROM flight_files WHERE flight_id = ? AND kind = 'ulog'", ended.flightId), 15_000);
    expect(file.size).toBeGreaterThan(1000);
    const topics = await api(s.app, owner)('GET', `/api/v2/organisations/${owner.orgId}/flights/${ended.flightId}/files/${file.id}/topics`);
    expect(topics.json().topics.map((t: any) => t.name)).toContain('battery_status');
  });

  it('uploads a mission over the link and executes it autonomously', async () => {
    const call = api(s.app, owner);
    const wp = destinationPoint(HOME, 90, 30);
    const mission = await call('POST', `/api/v2/organisations/${owner.orgId}/missions`, {
      name: 'Short hop',
      plan: { items: [{ type: 'takeoff', alt: 6 }, { type: 'waypoint', lat: wp.lat, lon: wp.lon, alt: 6 }, { type: 'photo' }, { type: 'land' }], rallyPoints: [], defaultSpeed: 8, defaultAlt: 6 },
    });
    expect(mission.statusCode).toBe(201);
    const up = await call('POST', `/api/v2/organisations/${owner.orgId}/missions/${mission.json().id}/upload`, { droneId });
    expect(up.json()).toMatchObject({ result: 'accepted' });
    await viewer.wait((m) => m.type === 'status' && m.drone.mission?.missionId === mission.json().id);
    const start = await call('POST', `/api/v2/organisations/${owner.orgId}/drones/${droneId}/commands`, { command: 'mission_start' });
    expect(start.json().result).toBe('accepted');
    await viewer.wait((m) => m.type === 'mission_progress' && m.seq >= 2);
    const started = await viewer.wait((m) => m.type === 'flight' && m.state === 'started' && m.flightId !== viewer.find((x: any) => x.type === 'flight')?.flightId);
    await waitFor(() => s.ctx.db.get<any>("SELECT * FROM flights WHERE id = ? AND status = 'completed'", started.flightId), 40_000);
    const f = s.ctx.db.get<any>('SELECT mission_id FROM flights WHERE id = ?', started.flightId);
    expect(f.mission_id).toBe(mission.json().id);
    const photo = s.ctx.db.get<any>("SELECT * FROM payload_records WHERE flight_id = ? AND kind = 'photo'", started.flightId);
    expect(photo).toBeTruthy();
    // The flight keeps the plan it was flown with, even after the mission is edited.
    const far = destinationPoint(HOME, 0, 500);
    await call('PATCH', `/api/v2/organisations/${owner.orgId}/missions/${mission.json().id}`, {
      plan: { items: [{ type: 'takeoff', alt: 6 }, { type: 'waypoint', lat: far.lat, lon: far.lon, alt: 20 }, { type: 'land' }], rallyPoints: [], defaultSpeed: 8, defaultAlt: 6 },
    });
    const route = (await call('GET', `/api/v2/organisations/${owner.orgId}/flights/${started.flightId}/planned-route`)).json();
    expect(route).toMatchObject({ missionId: mission.json().id, snapshot: true });
    expect(route.plan.items.find((it: any) => it.type === 'waypoint')).toMatchObject({ lat: wp.lat, lon: wp.lon, alt: 6 });
    expect(route.path.length).toBeGreaterThan(1);
  });

  it('does not credit a later manual flight to the last mission or its pilot', async () => {
    // The mission was flown to the end and the drone landed: it is no longer the loaded mission.
    expect(s.ctx.hub.droneState(droneId)?.mission).toBeNull();
    viewer.send({ type: 'control', droneId, action: 'release' });
    await waitFor(() => !s.ctx.hub.droneState(droneId)?.controller, 5000);
    await waitFor(() => s.ctx.hub.telemetryOf(droneId)?.inAir === false && !s.ctx.hub.telemetryOf(droneId)?.armed, 20_000);
    const before = new Set(s.ctx.db.all<{ id: string }>('SELECT id FROM flights WHERE drone_id = ?', droneId).map((r) => r.id));
    const p2 = api(s.app, pilot2);
    const command = (c: string, params: Record<string, unknown> = {}) => p2('POST', `/api/v2/organisations/${owner.orgId}/drones/${droneId}/commands`, { command: c, params });
    // A mission uploaded but not started does not make the next flight a mission flight either.
    const wp = destinationPoint(HOME, 0, 20);
    const m = await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/missions`, { name: 'Loaded only', plan: { items: [{ type: 'takeoff', alt: 6 }, { type: 'waypoint', lat: wp.lat, lon: wp.lon, alt: 6 }, { type: 'land' }], rallyPoints: [], defaultSpeed: 8, defaultAlt: 6 } });
    expect((await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/missions/${m.json().id}/upload`, { droneId })).json()).toMatchObject({ result: 'accepted' });
    expect((await command('takeoff', { alt: 5 })).statusCode).toBe(200);
    const flight = await waitFor(() => s.ctx.db.all<any>('SELECT * FROM flights WHERE drone_id = ?', droneId).find((f) => !before.has(f.id)), 20_000);
    await waitFor(() => (s.ctx.hub.telemetryOf(droneId)?.altRel ?? 0) > 3, 20_000);
    expect((await command('land')).statusCode).toBe(200);
    const done = await waitFor(() => s.ctx.db.get<any>("SELECT * FROM flights WHERE id = ? AND status = 'completed'", flight.id), 40_000);
    expect(done).toMatchObject({ mission_id: null, mission_plan: null, pilot_id: pilot2.userId });
    // The uploaded mission is still loaded (it was never flown).
    expect(s.ctx.hub.droneState(droneId)?.mission?.missionId).toBe(m.json().id);
  }, 90_000);

  it('updates the firmware over the air and reports the new version', async () => {
    const pkg = randomBytes(64 * 1024);
    // Versions are named as drones report theirs ("athena-fc 2.4.0"): single spaces between words.
    const named = async (version: string) => {
      const m = multipart({ version, model: 'X4' }, [{ field: 'file', filename: 'fw.bin', content: pkg }]);
      return (await s.app.inject({ method: 'POST', url: `/api/v2/organisations/${owner.orgId}/firmware`, headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf, 'content-type': m.contentType }, payload: m.body })).statusCode;
    };
    expect(await named('athena-fc 9.9.8')).toBe(201);
    expect(await named('athena-fc  9.9.8')).toBe(400);
    expect(await named('athena-fc/9.9.8')).toBe(400);
    expect(await named('x'.repeat(41))).toBe(400);
    const mp = multipart({ version: 'athena-fc-9.9.9', model: 'X4', notes: 'test build' }, [{ field: 'file', filename: 'fw.bin', content: pkg }]);
    const up = await s.app.inject({ method: 'POST', url: `/api/v2/organisations/${owner.orgId}/firmware`, headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf, 'content-type': mp.contentType }, payload: mp.body });
    expect(up.statusCode).toBe(201);
    expect(up.json().sha256).toHaveLength(64);
    const upd = await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/drones/${droneId}/firmware-updates`, { packageId: up.json().id });
    expect(upd.statusCode).toBe(201);
    await viewer.wait((m) => m.type === 'firmware_progress' && m.status === 'downloading');
    await waitFor(() => s.ctx.db.get<any>("SELECT * FROM firmware_updates WHERE id = ? AND status = 'completed'", upd.json().id), 20_000);
    await waitFor(() => s.ctx.db.get<any>("SELECT * FROM drones WHERE id = ? AND firmware_version = 'athena-fc-9.9.9'", droneId));
    await viewer.wait((m) => m.type === 'status' && m.drone.firmware === 'athena-fc-9.9.9' && m.drone.online, 20_000);
    await waitFor(() => hooks.find((h) => h.event === 'firmware.updated'));
    // the tokenised download URL stops working once the update is finished
    const list = await api(s.app, owner)('GET', `/api/v2/organisations/${owner.orgId}/firmware-updates?droneId=${droneId}`);
    expect(list.json()[0]).toMatchObject({ status: 'completed', progress: 100, version: 'athena-fc-9.9.9' });
  });

  it('lists fleet assets with live status, flight hours and battery cycles', async () => {
    const res = await api(s.app, owner)('GET', `/api/v2/organisations/${owner.orgId}/drones`);
    const d = res.json().find((x: any) => x.id === droneId);
    expect(d).toMatchObject({ online: true, firmwareVersion: 'athena-fc-9.9.9', flightCount: 3 });
    expect(d.flightTimeS).toBeGreaterThan(2);
    // Equivalent full cycles: what the three flights used of the battery, in whole packs.
    const used = s.ctx.db.all<{ u: number }>('SELECT battery_start - battery_end AS u FROM flights WHERE drone_id = ? AND battery_start IS NOT NULL AND battery_end IS NOT NULL', droneId);
    expect(used.length).toBeGreaterThan(0);
    expect(d.batteryCycles).toBeCloseTo(used.reduce((sum, r) => sum + Math.max(0, r.u), 0) / 100, 2);
    expect(d.batteryCycles).toBeLessThan(3);
    expect(d.lastPosition).toBeTruthy();
  });

  it('rejects commands to offline drones and closes the link on key rotation', async () => {
    const rot = await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/drones/${droneId}/link-key`);
    expect(rot.json().linkKey).toMatch(/^adk_/);
    await viewer.wait((m) => m.type === 'status' && m.drone.droneId === droneId && m.drone.online === false);
    const res = await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/drones/${droneId}/commands`, { command: 'arm' });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/offline/);
  });
});

describe('control lock across reconnections', () => {
  it('keeps the pilot\'s lock for a grace period and hands it back on reconnect', async () => {
    s.ctx.hub.controlGraceMs = 1500;
    const created = (await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: 'Grace' })).json();
    const id = created.id as string;
    const link = new LinkClient({ url: `${s.wsBase}/api/v2/link`, key: created.linkKey, drone: new VirtualDrone({ home: HOME, groundAltMsl: 10, seed: 11 }), timeScale: 4 });
    link.start();
    try {
      await waitFor(() => s.ctx.hub.droneState(id)?.online);
      const pilotView = new Viewer(`${s.wsBase}/api/v2/live?org=${owner.orgId}`, { cookie: pilot2.cookie, origin: s.baseUrl });
      await pilotView.opened;
      await pilotView.wait((m) => m.type === 'snapshot');
      pilotView.send({ type: 'control', droneId: id, action: 'request' });
      await pilotView.wait((m) => m.type === 'control' && m.droneId === id && m.controller?.name === 'Second Pilot');
      pilotView.close();
      await new Promise((r) => setTimeout(r, 300));
      expect(s.ctx.hub.droneState(id)?.controller?.name).toBe('Second Pilot');
      // Within the grace period nobody else can take control …
      const ownerView = new Viewer(`${s.wsBase}/api/v2/live?org=${owner.orgId}`, { cookie: owner.cookie, origin: s.baseUrl });
      await ownerView.opened;
      await ownerView.wait((m) => m.type === 'snapshot');
      ownerView.send({ type: 'control', droneId: id, action: 'request' });
      await ownerView.wait((m) => m.type === 'error' && /controlled by Second Pilot/.test(m.message));
      // … and the pilot's new connection gets the lock back (manual control is accepted again).
      const again = new Viewer(`${s.wsBase}/api/v2/live?org=${owner.orgId}`, { cookie: pilot2.cookie, origin: s.baseUrl });
      await again.opened;
      await again.wait((m) => m.type === 'snapshot');
      await new Promise((r) => setTimeout(r, 1800));
      expect(s.ctx.hub.droneState(id)?.controller?.name).toBe('Second Pilot');
      // Without a reconnection the lock is released after the grace period.
      again.close();
      await ownerView.wait((m) => m.type === 'control' && m.droneId === id && m.controller === null, 5000);
      expect(s.ctx.hub.droneState(id)?.controller ?? null).toBeNull();
      ownerView.close();
    } finally {
      await link.stop();
      s.ctx.hub.controlGraceMs = 15_000;
    }
  });
});
