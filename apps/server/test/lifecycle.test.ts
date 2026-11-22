import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { destinationPoint, haversineDistance, newItemId, type MissionPlan } from '@athena-sky/shared';
import { LinkClient, VirtualDrone, simulateMission } from '@athena-sky/simulator';
import { api, multipart, signup, startServer, waitFor, type Session, type TestServer } from './helpers';

const HOME = { lat: 25.0412, lon: 121.5654 };

function hop(alt = 20): MissionPlan {
  return {
    home: { ...HOME, alt: 8 },
    items: [
      { id: newItemId(), type: 'takeoff', alt },
      { id: newItemId(), type: 'waypoint', ...destinationPoint(HOME, 60, 120), alt },
      { id: newItemId(), type: 'rtl' },
    ],
    rallyPoints: [],
    geofence: null,
    defaultSpeed: 8,
    defaultAlt: alt,
  };
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

describe('Deleting drones and organisations', () => {
  let s: TestServer;
  let owner: Session;
  const clients: LinkClient[] = [];

  beforeAll(async () => {
    s = await startServer();
    owner = await signup(s.app, { name: 'Olga Owner' });
  });
  afterAll(async () => {
    for (const c of clients) await c.stop();
    await s.close();
  });

  const addDrone = async (who: Session, name: string) => (await api(s.app, who)('POST', `/api/v2/organisations/${who.orgId}/drones`, { name, model: 'X4' })).json() as { id: string; linkKey: string };
  const connect = async (drone: { id: string; linkKey: string }, home = HOME) => {
    const c = new LinkClient({ url: `${s.wsBase}/api/v2/link`, key: drone.linkKey, drone: new VirtualDrone({ home, groundAltMsl: 8, seed: 7 }), timeScale: 4 });
    clients.push(c);
    c.start();
    await waitFor(() => s.ctx.hub.telemetryOf(drone.id), 10_000);
    return c;
  };
  const command = (who: Session, droneId: string, c: string, params: Record<string, unknown> = {}) =>
    api(s.app, who)('POST', `/api/v2/organisations/${who.orgId}/drones/${droneId}/commands`, { command: c, params });
  /** A flight log with a payload image, stored as files under the data directory. */
  const storeLog = async (who: Session, droneId: string): Promise<string[]> => {
    const sim = simulateMission(hop(), { home: HOME, startTime: Date.UTC(2026, 9, 1, 2, 0), ulog: true, drone: { groundAltMsl: 8, seed: 5 } });
    const mp = multipart({ droneId }, [{ field: 'file', filename: 'log.ulg', content: sim.ulog! }]);
    const headers = { cookie: who.cookie, 'x-csrf-token': who.csrf };
    const up = await s.app.inject({ method: 'POST', url: `/api/v2/organisations/${who.orgId}/flights/upload`, headers: { ...headers, 'content-type': mp.contentType }, payload: mp.body });
    expect(up.statusCode).toBe(201);
    const img = multipart({}, [{ field: 'files', filename: 'IMG_0001.jpg', content: JPEG, type: 'image/jpeg' }]);
    const pic = await s.app.inject({ method: 'POST', url: `/api/v2/organisations/${who.orgId}/flights/${up.json().id}/images`, headers: { ...headers, 'content-type': img.contentType }, payload: img.body });
    expect(pic.statusCode).toBe(201);
    const files = s.ctx.db
      .all<{ p: string }>(
        'SELECT storage_path AS p FROM flight_files WHERE flight_id = ? UNION ALL SELECT storage_path AS p FROM payload_images WHERE flight_id = ?',
        up.json().id,
        up.json().id,
      )
      .map((r) => resolve(s.dataDir, 'files', r.p));
    expect(files).toHaveLength(2);
    for (const f of files) expect(existsSync(f)).toBe(true);
    return files;
  };
  const healthy = async () => (await s.app.inject({ method: 'GET', url: '/healthz' })).statusCode === 200;

  it('refuses to delete a drone – or its organisation – while it is flying, and deletes it with its files once it has landed', async () => {
    const kite = await addDrone(owner, 'Kite');
    const files = await storeLog(owner, kite.id);
    await connect(kite);
    expect((await command(owner, kite.id, 'takeoff', { alt: 15 })).json().result).toBe('accepted');
    const flightId = await waitFor(() => s.ctx.recorder.activeFlightId(kite.id), 20_000);

    const refused = await api(s.app, owner)('DELETE', `/api/v2/organisations/${owner.orgId}/drones/${kite.id}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'drone_in_flight' });
    expect(refused.json().message).toContain('Kite');
    const org = await api(s.app, owner)('DELETE', `/api/v2/organisations/${owner.orgId}`);
    expect(org.statusCode).toBe(409);
    expect(org.json()).toMatchObject({ error: 'drones_in_flight' });
    expect(org.json().message).toContain('Kite');
    // Nothing was deleted: the flight goes on being recorded.
    expect(s.ctx.hub.isOnline(kite.id)).toBe(true);
    expect(s.ctx.recorder.activeFlightId(kite.id)).toBe(flightId);

    expect((await command(owner, kite.id, 'land')).json().result).toBe('accepted');
    await waitFor(() => s.ctx.db.get("SELECT 1 FROM flights WHERE id = ? AND status = 'completed'", flightId), 60_000);
    const del = await api(s.app, owner)('DELETE', `/api/v2/organisations/${owner.orgId}/drones/${kite.id}`);
    expect(del.statusCode).toBe(200);
    // Its flights went with it – and so did their log files and images.
    expect(s.ctx.db.get('SELECT 1 FROM flights WHERE drone_id = ?', kite.id)).toBeUndefined();
    for (const f of files) expect(existsSync(f)).toBe(false);
    await waitFor(() => !s.ctx.hub.isOnline(kite.id), 5_000);
    expect(await healthy()).toBe(true);
  }, 120_000);

  it('keeps running when a flying drone disappears from the database (its flight cannot be closed)', async () => {
    const wisp = await addDrone(owner, 'Wisp');
    const client = await connect(wisp);
    expect((await command(owner, wisp.id, 'takeoff', { alt: 15 })).json().result).toBe('accepted');
    await waitFor(() => s.ctx.recorder.activeFlightId(wisp.id), 20_000);
    // Removed behind the routes' back (its flights cascade), then the link drops: the flight's
    // grace period ends with nothing left to close – the server logs it and carries on.
    s.ctx.db.run('DELETE FROM drones WHERE id = ?', wisp.id);
    await client.stop();
    await waitFor(() => !s.ctx.hub.isOnline(wisp.id), 5_000);
    await new Promise((r) => setTimeout(r, 3_500)); // > link-loss grace (2 s in tests)
    expect(s.ctx.recorder.activeFlightId(wisp.id)).toBeNull();
    expect(await healthy()).toBe(true);
  }, 60_000);

  it('deletes an organisation with the files of its flights', async () => {
    const other = await signup(s.app, { name: 'Short-lived Ops' });
    const lark = await addDrone(other, 'Lark');
    const files = await storeLog(other, lark.id);
    const del = await api(s.app, other)('DELETE', `/api/v2/organisations/${other.orgId}`);
    expect(del.statusCode).toBe(200);
    expect(s.ctx.db.get('SELECT 1 FROM drones WHERE id = ?', lark.id)).toBeUndefined();
    for (const f of files) expect(existsSync(f)).toBe(false);
  }, 60_000);
});

describe('A flight goes on over a server restart', () => {
  let dataDir: string;
  let s: TestServer | null = null;
  let client: LinkClient | null = null;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'athena-restart-'));
  });
  afterAll(async () => {
    await client?.stop();
    await s?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('records a mission flight interrupted by a restart as one flight, compared with its route as a whole', async () => {
    s = await startServer({ dataDir });
    const owner = await signup(s.app, { name: 'Rita Restart' });
    const call = () => api(s!.app, owner);
    const swift = (await call()('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: 'Swift', model: 'X4' })).json();
    client = new LinkClient({ url: `${s.wsBase}/api/v2/link`, key: swift.linkKey, drone: new VirtualDrone({ home: HOME, groundAltMsl: 8, seed: 9 }), timeScale: 4 });
    client.start();
    await waitFor(() => s!.ctx.hub.telemetryOf(swift.id), 10_000);
    const a = destinationPoint(HOME, 0, 250);
    const b = destinationPoint(a, 90, 250);
    const plan = {
      home: { ...HOME, alt: 0 },
      items: [{ type: 'takeoff', alt: 20 }, { type: 'waypoint', ...a, alt: 20 }, { type: 'waypoint', ...b, alt: 20 }, { type: 'waypoint', ...destinationPoint(HOME, 90, 250), alt: 20 }, { type: 'rtl' }],
      rallyPoints: [],
      defaultSpeed: 8,
      defaultAlt: 20,
    };
    const mission = (await call()('POST', `/api/v2/organisations/${owner.orgId}/missions`, { name: 'Square', plan })).json();
    expect((await call()('POST', `/api/v2/organisations/${owner.orgId}/missions/${mission.id}/upload`, { droneId: swift.id })).json()).toMatchObject({ result: 'accepted' });
    expect((await call()('POST', `/api/v2/organisations/${owner.orgId}/drones/${swift.id}/commands`, { command: 'mission_start', params: {} })).json().result).toBe('accepted');
    const flightId = await waitFor(() => s!.ctx.recorder.activeFlightId(swift.id), 20_000);
    const before = s.ctx.db.get<{ mission_started_at: number }>('SELECT mission_started_at FROM flights WHERE id = ?', flightId)!;
    // Halfway along the route, the server restarts (same data, same address).
    await waitFor(() => (s!.ctx.hub.droneState(swift.id)?.mission?.seq ?? 0) >= 2, 60_000);
    const port = s.port;
    await s.app.close();
    s = await startServer({ dataDir, port, config: { linkLossGraceS: 30 } });
    // The drone reconnects by itself and its flight goes on being recorded.
    await waitFor(() => s!.ctx.recorder.activeFlightId(swift.id), 20_000);
    expect(s.ctx.recorder.activeFlightId(swift.id)).toBe(flightId);
    const closed = await waitFor(() => s!.ctx.db.get<any>("SELECT * FROM flights WHERE id = ? AND status = 'completed'", flightId), 120_000);
    expect(s.ctx.db.all('SELECT id FROM flights WHERE drone_id = ?', swift.id)).toHaveLength(1);
    expect(closed).toMatchObject({ mission_id: mission.id, mission_started_at: before.mission_started_at });
    const events = s.ctx.db.all<{ code: string; message: string }>('SELECT code, message FROM flight_events WHERE flight_id = ?', flightId);
    expect(events.find((e) => e.code === 'server_restart')?.message).toContain('Recording resumed after a server restart');
    const analysis = await waitFor(() => s!.ctx.db.get<any>('SELECT metrics, findings FROM flight_analyses WHERE flight_id = ?', flightId), 30_000);
    expect(JSON.parse(analysis.metrics).routeCoveragePct).toBeGreaterThan(80);
    expect(JSON.parse(analysis.findings).map((f: { code: string }) => f.code)).not.toContain('route_incomplete');
  }, 240_000);
});

describe('Geofence of a loaded mission', () => {
  let s: TestServer;
  let client: LinkClient;
  afterAll(async () => {
    await client?.stop();
    await s?.close();
  });

  it('checks a flight against the geofence the drone enforced – also when the loaded mission was not flown', async () => {
    s = await startServer();
    const owner = await signup(s.app, { name: 'Gina Geofence' });
    const call = api(s.app, owner);
    const heron = (await call('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: 'Heron', model: 'X4' })).json();
    client = new LinkClient({ url: `${s.wsBase}/api/v2/link`, key: heron.linkKey, drone: new VirtualDrone({ home: HOME, groundAltMsl: 8, seed: 4 }), timeScale: 4 });
    client.start();
    await waitFor(() => s.ctx.hub.telemetryOf(heron.id), 10_000);
    const corner = (bearing: number) => destinationPoint(HOME, bearing, 140);
    const plan = {
      home: { ...HOME, alt: 0 },
      items: [{ type: 'takeoff', alt: 15 }, { type: 'waypoint', ...destinationPoint(HOME, 90, 60), alt: 15 }, { type: 'rtl' }],
      rallyPoints: [],
      geofence: { polygon: [corner(45), corner(135), corner(225), corner(315)], maxAlt: 60, action: 'rtl' },
      defaultSpeed: 8,
      defaultAlt: 15,
    };
    const fenced = (await call('POST', `/api/v2/organisations/${owner.orgId}/missions`, { name: 'Fenced yard', plan })).json();
    expect((await call('POST', `/api/v2/organisations/${owner.orgId}/missions/${fenced.id}/upload`, { droneId: heron.id })).json()).toMatchObject({ result: 'accepted' });
    // Flown by hand – the mission is loaded, not started – out of the fence: the drone returns.
    const cmd = (c: string, params: Record<string, unknown> = {}) => call('POST', `/api/v2/organisations/${owner.orgId}/drones/${heron.id}/commands`, { command: c, params });
    expect((await cmd('takeoff', { alt: 15 })).json().result).toBe('accepted');
    const flightId = await waitFor(() => s.ctx.recorder.activeFlightId(heron.id), 20_000);
    await waitFor(() => (s.ctx.hub.telemetryOf(heron.id)?.altRel ?? 0) > 12, 30_000);
    const out = destinationPoint(HOME, 0, 300);
    expect((await cmd('goto', { lat: out.lat, lon: out.lon, alt: 15 })).json().result).toBe('accepted');
    const flight = await waitFor(() => s.ctx.db.get<any>("SELECT * FROM flights WHERE id = ? AND status = 'completed' AND compliance IS NOT NULL", flightId), 120_000);
    expect(flight.mission_id).toBeNull();
    expect(JSON.parse(flight.geofence)).toEqual([expect.objectContaining({ fence: expect.objectContaining({ maxAlt: 60 }) })]);
    expect(JSON.parse(flight.compliance)).toMatchObject({ compliant: false, violations: [{ type: 'geofence' }] });
  }, 180_000);
});

describe('Logs and continued flights', () => {
  let s: TestServer;
  let owner: Session;
  const clients: LinkClient[] = [];

  beforeAll(async () => {
    s = await startServer();
    owner = await signup(s.app, { name: 'Lena Logs' });
  });
  afterAll(async () => {
    for (const c of clients) await c.stop();
    await s.close();
  });

  const call = () => api(s.app, owner);
  const connect = async (name: string, seed: number) => {
    const d = (await call()('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name, model: 'X4' })).json() as { id: string; linkKey: string };
    const drone = new VirtualDrone({ home: HOME, groundAltMsl: 8, seed });
    const c = new LinkClient({ url: `${s.wsBase}/api/v2/link`, key: d.linkKey, drone, timeScale: 4, onboardLog: false });
    clients.push(c);
    c.start();
    await waitFor(() => s.ctx.hub.telemetryOf(d.id), 10_000);
    return { id: d.id, client: c, drone };
  };
  const command = (droneId: string, c: string, params: Record<string, unknown> = {}) =>
    call()('POST', `/api/v2/organisations/${owner.orgId}/drones/${droneId}/commands`, { command: c, params });
  const uploadLog = (droneId: string, startTime: number) => {
    const sim = simulateMission(hop(), { home: HOME, startTime, ulog: true, drone: { groundAltMsl: 8, seed: 6 } });
    const mp = multipart({ droneId }, [{ field: 'file', filename: 'onboard.ulg', content: sim.ulog! }]);
    return s.app.inject({
      method: 'POST',
      url: `/api/v2/organisations/${owner.orgId}/flights/upload`,
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf, 'content-type': mp.contentType },
      payload: mp.body,
    });
  };

  it("attaches a flight's own log uploaded from the web to the flight recorded live – no second flight", async () => {
    const tern = await connect('Tern', 8);
    expect((await command(tern.id, 'takeoff', { alt: 15 })).json().result).toBe('accepted');
    const flightId = await waitFor(() => s.ctx.recorder.activeFlightId(tern.id), 20_000);
    await waitFor(() => (s.ctx.hub.telemetryOf(tern.id)?.altRel ?? 0) > 12, 30_000);
    expect((await command(tern.id, 'land')).json().result).toBe('accepted');
    const flight = await waitFor(() => s.ctx.db.get<{ started_at: string }>("SELECT started_at FROM flights WHERE id = ? AND status = 'completed'", flightId), 60_000);

    const own = await uploadLog(tern.id, Date.parse(flight.started_at));
    expect(own.statusCode).toBe(200);
    expect(own.json().id).toBe(flightId);
    expect(s.ctx.db.all('SELECT id FROM flights WHERE drone_id = ?', tern.id)).toHaveLength(1);
    expect(s.ctx.db.all('SELECT id FROM flight_files WHERE flight_id = ?', flightId)).toHaveLength(1);
    // A log of another flight (an hour later) is a flight of its own.
    const other = await uploadLog(tern.id, Date.parse(flight.started_at) + 3_600_000);
    expect(other.statusCode).toBe(201);
    expect(other.json().id).not.toBe(flightId);
  }, 120_000);

  it('keeps apart logs without a time base of their own (dated to end when they arrive, never in the future)', async () => {
    const d = (await call()('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: 'Wren', model: 'X4' })).json() as { id: string };
    const csv = (east: number) =>
      ['time(s),latitude,longitude,altitude_rel', ...Array.from({ length: 60 }, (_, i) => {
        const p = destinationPoint(HOME, 90, east + i * 5);
        return `${i},${p.lat.toFixed(7)},${p.lon.toFixed(7)},20`;
      })].join('\n');
    const send = (content: string, filename: string) => {
      const mp = multipart({ droneId: d.id }, [{ field: 'file', filename, content: Buffer.from(content) }]);
      return s.app.inject({ method: 'POST', url: `/api/v2/organisations/${owner.orgId}/flights/upload`, headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf, 'content-type': mp.contentType }, payload: mp.body });
    };
    const sentAt = Date.now();
    const a = await send(csv(0), 'morning.csv');
    const b = await send(csv(500), 'afternoon.csv');
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.json().id).not.toBe(b.json().id);
    // Flown before it arrived: 59 s ending on arrival.
    const f = a.json() as { startedAt: string; endedAt: string };
    expect(Date.parse(f.endedAt)).toBeGreaterThanOrEqual(sentAt - 1000);
    expect(Date.parse(f.endedAt)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(f.endedAt) - Date.parse(f.startedAt)).toBe(59_000);
  });

  it('compares a flight that begins with its mission under way (link back after the grace period) with what remains of the route', async () => {
    const gull = await connect('Gull', 10);
    const a = destinationPoint(HOME, 0, 250);
    const b = destinationPoint(a, 90, 250);
    const c = destinationPoint(b, 180, 250);
    const plan = {
      home: { ...HOME, alt: 0 },
      items: [{ type: 'takeoff', alt: 20 }, { type: 'waypoint', ...a, alt: 20 }, { type: 'waypoint', ...b, alt: 20 }, { type: 'waypoint', ...c, alt: 20 }, { type: 'rtl' }],
      rallyPoints: [],
      defaultSpeed: 8,
      defaultAlt: 20,
    };
    const mission = (await call()('POST', `/api/v2/organisations/${owner.orgId}/missions`, { name: 'Loop', plan })).json();
    expect((await call()('POST', `/api/v2/organisations/${owner.orgId}/missions/${mission.id}/upload`, { droneId: gull.id })).json()).toMatchObject({ result: 'accepted' });
    expect((await command(gull.id, 'mission_start')).json().result).toBe('accepted');
    const first = await waitFor(() => s.ctx.recorder.activeFlightId(gull.id), 20_000);
    await waitFor(() => (s.ctx.hub.droneState(gull.id)?.mission?.seq ?? 0) >= 3, 90_000);
    // The link is lost for longer than the grace period (2 s here): that record is closed …
    const link = gull.client as unknown as { stopped: boolean; backoffMs: number; ws: { terminate(): void } | null; connect(): void };
    link.stopped = true;
    link.ws?.terminate();
    await waitFor(() => s.ctx.db.get("SELECT 1 FROM flights WHERE id = ? AND status = 'aborted'", first), 20_000);
    // … while the drone flies on; when the link is back, a new record starts with the mission under way.
    link.stopped = false;
    link.backoffMs = 1000;
    link.connect();
    const second = await waitFor(() => {
      const id = s.ctx.recorder.activeFlightId(gull.id);
      return id && id !== first ? id : null;
    }, 20_000);
    const resumedAt = { lat: gull.drone.lat, lon: gull.drone.lon };
    await waitFor(() => s.ctx.db.get("SELECT 1 FROM flights WHERE id = ? AND status = 'completed'", second), 120_000);
    const analysis = await waitFor(() => s.ctx.db.get<any>('SELECT metrics, findings FROM flight_analyses WHERE flight_id = ?', second), 30_000);
    expect(JSON.parse(analysis.findings).map((f: { code: string }) => f.code)).not.toContain('route_incomplete');
    expect(JSON.parse(analysis.metrics).routeCoveragePct).toBeGreaterThan(80);
    // Its route is what remained: from where the drone was when the link came back, home.
    const route = (await call()('GET', `/api/v2/organisations/${owner.orgId}/flights/${second}/planned-route`)).json();
    expect(haversineDistance(route.path[0], resumedAt)).toBeLessThan(60);
    expect(haversineDistance(route.path[0], HOME)).toBeGreaterThan(150);
  }, 240_000);
});
