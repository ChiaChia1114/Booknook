import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { destinationPoint, haversineDistance } from '@athena-sky/shared';
import { LinkClient, VirtualDrone } from '@athena-sky/simulator';
import { Viewer, addMember, api, signup, startServer, waitFor, type Session, type TestServer } from './helpers';

const HOME = { lat: 25.0732, lon: 121.5355 };

let s: TestServer;
let owner: Session;
let manager: Session;
let pilot: Session;
let droneId: string;
let drone2Id: string;
let drone2Key: string;
let client: LinkClient;

beforeAll(async () => {
  s = await startServer();
  owner = await signup(s.app, { name: 'Olivia Owner' });
  manager = await signup(s.app, { name: 'Mia Manager' });
  pilot = await signup(s.app, { name: 'Pat Pilot' });
  await addMember(s.app, owner, manager, 'manager');
  await addMember(s.app, owner, pilot, 'pilot');
  const call = api(s.app, owner);
  const created = await call('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: 'Falcon', model: 'X4' });
  droneId = created.json().id;
  const heron = (await call('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: 'Heron', model: 'X4' })).json();
  drone2Id = heron.id;
  drone2Key = heron.linkKey;
  client = new LinkClient({ url: `${s.wsBase}/api/v2/link`, key: created.json().linkKey, drone: new VirtualDrone({ home: HOME, groundAltMsl: 10, seed: 3 }), timeScale: 4 });
  client.start();
  await waitFor(() => s.ctx.hub.droneState(droneId)?.online && s.ctx.hub.telemetryOf(droneId), 10_000);
});

afterAll(async () => {
  await client?.stop();
  await s.close();
});

const plan = (items: Record<string, unknown>[]) => ({ home: { ...HOME, alt: 0 }, items, rallyPoints: [], defaultSpeed: 8, defaultAlt: 10 });
const createMission = async (who: Session, name: string, items: Record<string, unknown>[]) => {
  const r = await api(s.app, who)('POST', `/api/v2/organisations/${owner.orgId}/missions`, { name, plan: plan(items) });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
};
const upload = (who: Session, missionId: string, body: Record<string, unknown> = {}) =>
  api(s.app, who)('POST', `/api/v2/organisations/${owner.orgId}/missions/${missionId}/upload`, { droneId, ...body });
const check = (who: Session, missionId: string, body: Record<string, unknown> = {}) =>
  api(s.app, who)('POST', `/api/v2/organisations/${owner.orgId}/missions/${missionId}/airspace-check`, body);
const command = (who: Session, c: string, params: Record<string, unknown> = {}) =>
  api(s.app, who)('POST', `/api/v2/organisations/${owner.orgId}/drones/${droneId}/commands`, { command: c, params });
const landed = () => waitFor(() => s.ctx.hub.telemetryOf(droneId)?.inAir === false && !s.ctx.hub.telemetryOf(droneId)?.armed, 40_000);

describe('Mission upload: airspace gate', () => {
  it('refuses a mission through blocked airspace unless an owner or administrator overrides it (audited)', async () => {
    const zone = await api(s.app, manager)('POST', `/api/v2/organisations/${owner.orgId}/airspace/zones`, {
      name: 'Clinic helipad',
      type: 'restricted',
      geometry: { kind: 'circle', center: destinationPoint(HOME, 0, 600), radiusM: 60 },
      ceilingM: 300,
    });
    expect(zone.statusCode).toBe(201);
    const through = await createMission(pilot, 'Through the clinic', [{ type: 'takeoff', alt: 10 }, { type: 'waypoint', ...destinationPoint(HOME, 0, 900), alt: 10 }, { type: 'rtl' }]);
    expect((await check(pilot, through)).json()).toMatchObject({ verdict: 'blocked', conflicts: [{ kind: 'zone', severity: 'blocking', name: 'Clinic helipad' }] });

    const refused = await upload(pilot, through);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'airspace_blocked', details: { drones: [{ droneId, conflicts: [{ name: 'Clinic helipad', severity: 'blocking' }] }] } });
    expect(refused.json().message).toContain('Clinic helipad');
    expect(s.ctx.hub.droneState(droneId)?.mission ?? null).toBeNull();
    // A pilot cannot override the check; an owner (who may decide on authorisations) can, and it is audited.
    expect((await upload(pilot, through, { acceptAirspaceConflicts: true })).statusCode).toBe(403);
    const forced = await upload(owner, through, { acceptAirspaceConflicts: true });
    expect(forced.json()).toMatchObject({ result: 'accepted' });
    expect(s.ctx.hub.droneState(droneId)?.mission?.missionId).toBe(through);
    const entry = s.ctx.db.get<any>("SELECT * FROM audit_log WHERE org_id = ? AND action = 'mission.airspace_override'", owner.orgId);
    expect(entry).toMatchObject({ user_id: owner.userId, target: through });
    expect(JSON.parse(entry.details).drones[0].conflicts[0]).toContain('Clinic helipad');
    // A clear mission uploads without any override.
    const clear = await createMission(pilot, 'East hop', [{ type: 'takeoff', alt: 10 }, { type: 'waypoint', ...destinationPoint(HOME, 90, 200), alt: 10 }, { type: 'land' }]);
    expect((await upload(pilot, clear)).json()).toMatchObject({ result: 'accepted' });
  });

  it("treats the organisation's own authorisation as permission and other operators' reservations as conflicts", async () => {
    const now = Date.now();
    const window = { startAt: new Date(now - 60_000).toISOString(), endAt: new Date(now + 3_600_000).toISOString() };
    const east = await createMission(pilot, 'East survey', [{ type: 'takeoff', alt: 10 }, { type: 'waypoint', ...destinationPoint(HOME, 90, 250), alt: 10 }, { type: 'land' }]);
    const auth = await api(s.app, pilot)('POST', `/api/v2/organisations/${owner.orgId}/airspace/authorizations`, {
      geometry: { kind: 'cylinder', center: destinationPoint(HOME, 90, 150), radiusM: 200 },
      maxAltM: 60,
      droneId,
      ...window,
    });
    expect(auth.json().status).toBe('approved');
    // Our own reservation for this drone is what allows the flight – not a conflict.
    expect((await check(pilot, east, { droneId })).json()).toEqual({ verdict: 'clear', conflicts: [] });
    expect((await check(pilot, east)).json().verdict).toBe('clear');
    expect((await upload(pilot, east)).json()).toMatchObject({ result: 'accepted' });
    // Flown by another of our drones, the same mission shares that airspace: flagged for review.
    const other = (await check(pilot, east, { droneId: drone2Id })).json();
    expect(other).toMatchObject({ verdict: 'review', conflicts: [{ kind: 'reservation', severity: 'review' }] });
    expect(other.conflicts[0].message).toContain('Falcon');

    // Another operator reserves airspace west of home: our mission through it is blocked.
    const rival = await signup(s.app, { name: 'Rival Ops' });
    const theirs = await api(s.app, rival)('POST', `/api/v2/organisations/${rival.orgId}/airspace/authorizations`, {
      geometry: { kind: 'cylinder', center: destinationPoint(HOME, 270, 300), radiusM: 100 },
      maxAltM: 120,
      ...window,
    });
    expect(theirs.json().status).toBe('approved');
    const west = await createMission(pilot, 'West hop', [{ type: 'takeoff', alt: 10 }, { type: 'waypoint', ...destinationPoint(HOME, 270, 400), alt: 10 }, { type: 'land' }]);
    expect((await check(pilot, west)).json()).toMatchObject({ verdict: 'blocked', conflicts: [{ kind: 'reservation', severity: 'blocking', name: theirs.json().reference }] });
    expect((await upload(pilot, west)).statusCode).toBe(409);
  });
});

describe('Schedules follow the operation planned around now', () => {
  it('marks only the schedule planned near now as uploaded, and reverts it when another mission replaces it', async () => {
    const m = await createMission(pilot, 'Scheduled hop', [{ type: 'takeoff', alt: 6 }, { type: 'waypoint', ...destinationPoint(HOME, 90, 30), alt: 6 }, { type: 'land' }]);
    const schedule = async (inMs: number) =>
      (await api(s.app, manager)('POST', `/api/v2/organisations/${owner.orgId}/schedules`, { missionId: m, droneId, pilotId: pilot.userId, plannedAt: new Date(Date.now() + inMs).toISOString() })).json().id as string;
    const later = await schedule(3 * 86_400_000);
    const soon = await schedule(3_600_000);
    const status = (id: string) => s.ctx.db.get<{ status: string }>('SELECT status FROM schedules WHERE id = ?', id)!.status;
    expect((await upload(pilot, m)).json()).toMatchObject({ result: 'accepted' });
    expect([status(soon), status(later)]).toEqual(['uploaded', 'scheduled']);
    const other = await createMission(pilot, 'Something else', [{ type: 'takeoff', alt: 6 }, { type: 'waypoint', ...destinationPoint(HOME, 0, 30), alt: 6 }, { type: 'land' }]);
    expect((await upload(pilot, other)).json()).toMatchObject({ result: 'accepted' });
    expect([status(soon), status(later)]).toEqual(['scheduled', 'scheduled']);
    // An upload days ahead of every schedule touches none of them.
    const farOnly = await createMission(pilot, 'Far future', [{ type: 'takeoff', alt: 6 }, { type: 'waypoint', ...destinationPoint(HOME, 180, 30), alt: 6 }, { type: 'land' }]);
    const far = (await api(s.app, manager)('POST', `/api/v2/organisations/${owner.orgId}/schedules`, { missionId: farOnly, droneId, plannedAt: new Date(Date.now() + 2 * 86_400_000).toISOString() })).json().id;
    expect((await upload(pilot, farOnly)).json()).toMatchObject({ result: 'accepted' });
    expect(status(far)).toBe('scheduled');
  });
});

describe('Loaded mission lifecycle', () => {
  it('unloads a mission that ends with return-to-launch once it has been flown and the drone has landed', async () => {
    await landed();
    const rtl = await createMission(pilot, 'Out and RTL', [{ type: 'takeoff', alt: 6 }, { type: 'waypoint', ...destinationPoint(HOME, 90, 40), alt: 6 }, { type: 'rtl' }]);
    // Scheduled for in half an hour – and again in four days.
    const sched = async (inMs: number) => (await api(s.app, manager)('POST', `/api/v2/organisations/${owner.orgId}/schedules`, { missionId: rtl, droneId, plannedAt: new Date(Date.now() + inMs).toISOString() })).json().id as string;
    const today = await sched(1_800_000);
    const nextWeek = await sched(4 * 86_400_000);
    expect((await upload(pilot, rtl)).json()).toMatchObject({ result: 'accepted' });
    const before = new Set(s.ctx.db.all<{ id: string }>('SELECT id FROM flights WHERE drone_id = ?', droneId).map((r) => r.id));
    expect((await command(pilot, 'mission_start')).json().result).toBe('accepted');
    const flight = await waitFor(() => s.ctx.db.all<any>('SELECT * FROM flights WHERE drone_id = ?', droneId).find((f) => !before.has(f.id)), 20_000);
    await waitFor(() => s.ctx.db.get<any>("SELECT * FROM flights WHERE id = ? AND status = 'completed'", flight.id), 60_000);
    expect(s.ctx.db.get<any>('SELECT mission_id FROM flights WHERE id = ?', flight.id).mission_id).toBe(rtl);
    // The drone handed over to RTL at the last item and landed: the mission is done.
    await waitFor(() => s.ctx.hub.droneState(droneId)?.mission === null, 10_000);
    // The flight was today's scheduled operation, not next week's.
    expect(s.ctx.db.get<any>('SELECT status, flight_id FROM schedules WHERE id = ?', today)).toMatchObject({ status: 'completed', flight_id: flight.id });
    expect(s.ctx.db.get<any>('SELECT status, flight_id FROM schedules WHERE id = ?', nextWeek)).toMatchObject({ status: 'scheduled', flight_id: null });
  }, 90_000);

  it('clears a mission flown to the end from the drone too, so both agree after a reconnect', async () => {
    await landed();
    const m = await createMission(pilot, 'Flown once', [{ type: 'takeoff', alt: 6 }, { type: 'waypoint', ...destinationPoint(HOME, 60, 30), alt: 6 }, { type: 'rtl' }]);
    expect((await upload(pilot, m)).json()).toMatchObject({ result: 'accepted' });
    expect((await command(pilot, 'mission_start')).json().result).toBe('accepted');
    await waitFor(() => s.ctx.hub.telemetryOf(droneId)?.inAir, 20_000);
    await landed();
    await waitFor(() => s.ctx.hub.droneState(droneId)?.mission === null, 10_000);
    const drone = (client as unknown as { opts: { drone: VirtualDrone } }).opts.drone;
    await waitFor(() => drone.mission === null, 5_000);
    // After a link drop the drone reports no mission: no "unknown mission" warning, nothing to fly.
    const viewer = new Viewer(`${s.wsBase}/api/v2/live?org=${owner.orgId}`, { cookie: owner.cookie, origin: s.baseUrl });
    await viewer.opened;
    (client as unknown as { ws: { terminate(): void } }).ws.terminate();
    await waitFor(() => !s.ctx.hub.droneState(droneId)?.online, 5_000);
    await waitFor(() => s.ctx.hub.droneState(droneId)?.online && s.ctx.hub.telemetryOf(droneId), 15_000);
    await new Promise((r) => setTimeout(r, 500));
    expect(viewer.messages.filter((x) => x.type === 'event' && x.code === 'mission_unknown')).toEqual([]);
    viewer.close();
    expect(s.ctx.hub.droneState(droneId)?.mission).toBeNull();
    expect((await command(pilot, 'mission_start')).json().result).toBe('rejected');
  }, 90_000);

  it('shows the plan as uploaded to the drone – not the mission as edited since', async () => {
    await landed();
    const north = destinationPoint(HOME, 0, 300);
    const m = await createMission(pilot, 'Edited later', [{ type: 'takeoff', alt: 6 }, { type: 'waypoint', ...north, alt: 6 }, { type: 'rtl' }]);
    expect((await upload(pilot, m)).json()).toMatchObject({ result: 'accepted' });
    const state = s.ctx.hub.droneState(droneId)!;
    expect(state.mission).toMatchObject({ missionId: m, uploadedAt: expect.any(String), start: null });
    const east = destinationPoint(HOME, 90, 300);
    const edited = await api(s.app, pilot)('PUT', `/api/v2/organisations/${owner.orgId}/missions/${m}`, {
      plan: plan([{ type: 'takeoff', alt: 6 }, { type: 'waypoint', ...east, alt: 6 }, { type: 'rtl' }]),
    });
    expect(edited.statusCode).toBe(200);
    const loaded = (await api(s.app, owner)('GET', `/api/v2/organisations/${owner.orgId}/drones/${droneId}/loaded-mission`)).json();
    expect(loaded.mission).toMatchObject({ missionId: m, uploadedAt: state.mission!.uploadedAt });
    const wp = loaded.mission.plan.items.find((i: any) => i.type === 'waypoint');
    expect([wp.lat, wp.lon]).toEqual([north.lat, north.lon]);
    // Uploading the edited mission replaces it (a new upload time).
    expect((await upload(pilot, m)).json()).toMatchObject({ result: 'accepted' });
    const again = (await api(s.app, owner)('GET', `/api/v2/organisations/${owner.orgId}/drones/${droneId}/loaded-mission`)).json();
    expect(again.mission.plan.items.find((i: any) => i.type === 'waypoint')).toMatchObject({ lat: east.lat, lon: east.lon });
    expect(again.mission.uploadedAt).not.toBe(state.mission!.uploadedAt);
  });

  it('draws a mission started in the air from where it was started, and its return to the take-off point', async () => {
    await landed();
    const before = new Set(s.ctx.db.all<{ id: string }>('SELECT id FROM flights WHERE drone_id = ?', droneId).map((r) => r.id));
    expect((await command(pilot, 'takeoff', { alt: 8 })).json().result).toBe('accepted');
    await waitFor(() => (s.ctx.hub.telemetryOf(droneId)?.altRel ?? 0) > 6, 20_000);
    const p = destinationPoint(HOME, 270, 120);
    expect((await command(pilot, 'goto', { lat: p.lat, lon: p.lon, alt: 8 })).json().result).toBe('accepted');
    await waitFor(() => {
      const t = s.ctx.hub.telemetryOf(droneId);
      return t && Math.abs(t.lon - p.lon) < 0.00005 && Math.abs(t.lat - p.lat) < 0.00005;
    }, 40_000);
    const m = await createMission(pilot, 'From aloft', [{ type: 'takeoff', alt: 8 }, { type: 'waypoint', ...destinationPoint(p, 0, 40), alt: 8 }, { type: 'rtl' }]);
    expect((await upload(pilot, m)).json()).toMatchObject({ result: 'accepted' });
    expect((await command(pilot, 'mission_start')).json().result).toBe('accepted');
    await waitFor(() => s.ctx.hub.droneState(droneId)?.mission?.start, 10_000);
    expect(s.ctx.hub.droneState(droneId)!.mission!.start!.lon).toBeCloseTo(p.lon, 4);
    const flight = await waitFor(() => s.ctx.db.all<any>('SELECT * FROM flights WHERE drone_id = ?', droneId).find((f) => !before.has(f.id)), 20_000);
    await waitFor(() => s.ctx.db.get<any>("SELECT * FROM flights WHERE id = ? AND status = 'completed'", flight.id), 60_000);
    const route = (await api(s.app, pilot)('GET', `/api/v2/organisations/${owner.orgId}/flights/${flight.id}/planned-route`)).json();
    // From where the mission was started (at its altitude) ...
    expect(route.path[0].lat).toBeCloseTo(p.lat, 4);
    expect(route.path[0].lon).toBeCloseTo(p.lon, 4);
    expect(route.path[0].alt).toBeGreaterThan(5);
    // ... back to the take-off point, where the drone landed.
    const end = route.path[route.path.length - 1];
    expect(end.lat).toBeCloseTo(HOME.lat, 4);
    expect(end.lon).toBeCloseTo(HOME.lon, 4);
    const landedAt = s.ctx.hub.telemetryOf(droneId)!;
    expect(Math.abs(landedAt.lon - HOME.lon)).toBeLessThan(0.0001);
  }, 120_000);

  it('keeps a mission loaded when the drone returns before reaching its last item', async () => {
    await landed();
    const long = await createMission(pilot, 'Long leg', [
      { type: 'takeoff', alt: 6 },
      { type: 'waypoint', ...destinationPoint(HOME, 0, 30), alt: 6 },
      { type: 'waypoint', ...destinationPoint(HOME, 0, 400), alt: 6 },
    ]);
    expect((await upload(pilot, long)).json()).toMatchObject({ result: 'accepted' });
    expect((await command(pilot, 'mission_start')).json().result).toBe('accepted');
    await waitFor(() => (s.ctx.hub.droneState(droneId)?.mission?.seq ?? 0) >= 2, 40_000);
    expect((await command(pilot, 'rtl')).json().result).toBe('accepted');
    await landed();
    await new Promise((r) => setTimeout(r, 500));
    expect(s.ctx.hub.droneState(droneId)?.mission).toMatchObject({ missionId: long });
  }, 90_000);

  it('links the scheduled operation when its mission is started in the air', async () => {
    await landed();
    const m = await createMission(pilot, 'Started aloft', [{ type: 'takeoff', alt: 6 }, { type: 'waypoint', ...destinationPoint(HOME, 270, 40), alt: 6 }, { type: 'rtl' }]);
    const sched = (await api(s.app, manager)('POST', `/api/v2/organisations/${owner.orgId}/schedules`, { missionId: m, droneId, pilotId: pilot.userId, plannedAt: new Date(Date.now() + 3_600_000).toISOString() })).json().id as string;
    expect((await upload(pilot, m)).json()).toMatchObject({ result: 'accepted' });
    expect(s.ctx.db.get<any>('SELECT status FROM schedules WHERE id = ?', sched).status).toBe('uploaded');
    // Take off first (the console's Take off button), then start the loaded mission (Resume).
    const before = new Set(s.ctx.db.all<{ id: string }>('SELECT id FROM flights WHERE drone_id = ?', droneId).map((r) => r.id));
    expect((await command(pilot, 'takeoff', { alt: 5 })).json().result).toBe('accepted');
    const flight = await waitFor(() => s.ctx.db.all<any>('SELECT * FROM flights WHERE drone_id = ?', droneId).find((f) => !before.has(f.id)), 20_000);
    expect(flight.mission_id).toBeNull();
    await waitFor(() => (s.ctx.hub.telemetryOf(droneId)?.altRel ?? 0) > 3, 20_000);
    expect((await command(pilot, 'mission_start')).json().result).toBe('accepted');
    await waitFor(() => s.ctx.db.get<any>('SELECT mission_id FROM flights WHERE id = ?', flight.id).mission_id === m, 10_000);
    expect(s.ctx.db.get<any>('SELECT status, flight_id FROM schedules WHERE id = ?', sched)).toMatchObject({ status: 'in_progress', flight_id: flight.id });
    await waitFor(() => s.ctx.db.get<any>("SELECT * FROM flights WHERE id = ? AND status = 'completed'", flight.id), 60_000);
    // Flown: no longer an upcoming operation, and no later flight can be attached to it.
    expect(s.ctx.db.get<any>('SELECT status, flight_id FROM schedules WHERE id = ?', sched)).toMatchObject({ status: 'completed', flight_id: flight.id });
  }, 90_000);

  it('refuses to delete a mission loaded on a drone – and keeps the live picture if it is gone anyway', async () => {
    await landed();
    const m = await createMission(pilot, 'Loaded hop', [{ type: 'takeoff', alt: 6 }, { type: 'waypoint', ...destinationPoint(HOME, 45, 30), alt: 6 }, { type: 'land' }]);
    expect((await upload(pilot, m)).json()).toMatchObject({ result: 'accepted' });
    const del = await api(s.app, owner)('DELETE', `/api/v2/organisations/${owner.orgId}/missions/${m}`);
    expect(del.statusCode).toBe(409);
    expect(del.json()).toMatchObject({ error: 'mission_in_use', message: expect.stringContaining('Falcon') });
    expect(s.ctx.db.get('SELECT 1 FROM missions WHERE id = ?', m)).toBeTruthy();
    // Removed behind the server's back (e.g. a race with the upload): the flight is still recorded
    // – without the mission – and viewers keep receiving the drone's telemetry.
    s.ctx.db.run('DELETE FROM missions WHERE id = ?', m);
    const viewer = new Viewer(`${s.wsBase}/api/v2/live?org=${owner.orgId}`, { cookie: owner.cookie, origin: s.baseUrl });
    await viewer.opened;
    const before = new Set(s.ctx.db.all<{ id: string }>('SELECT id FROM flights WHERE drone_id = ?', droneId).map((r) => r.id));
    expect((await command(pilot, 'mission_start')).json().result).toBe('accepted');
    const flight = await waitFor(() => s.ctx.db.all<any>('SELECT * FROM flights WHERE drone_id = ?', droneId).find((f) => !before.has(f.id)), 20_000);
    expect(flight).toMatchObject({ mission_id: null, status: 'in_progress' });
    const count = () => viewer.messages.filter((x) => x.type === 'telemetry' && x.droneId === droneId && x.data.inAir).length;
    await waitFor(() => count() >= 10, 10_000);
    await waitFor(() => s.ctx.db.get<any>("SELECT * FROM flights WHERE id = ? AND status = 'completed'", flight.id), 60_000);
    viewer.close();
    // Once flown (or replaced), the mission can be deleted.
    const other = await createMission(pilot, 'Replaced', [{ type: 'takeoff', alt: 6 }, { type: 'waypoint', ...destinationPoint(HOME, 135, 30), alt: 6 }, { type: 'land' }]);
    expect((await upload(pilot, other)).json()).toMatchObject({ result: 'accepted' });
    const another = await createMission(pilot, 'Next', [{ type: 'takeoff', alt: 6 }, { type: 'waypoint', ...destinationPoint(HOME, 225, 30), alt: 6 }, { type: 'land' }]);
    expect((await upload(pilot, another)).json()).toMatchObject({ result: 'accepted' });
    expect((await api(s.app, owner)('DELETE', `/api/v2/organisations/${owner.orgId}/missions/${other}`)).statusCode).toBe(200);
  }, 90_000);

  it('keeps the loaded mission over a link drop: still not deletable, and its flight is attributed', async () => {
    await landed();
    const m = await createMission(pilot, 'Over the drop', [{ type: 'takeoff', alt: 6 }, { type: 'waypoint', ...destinationPoint(HOME, 300, 40), alt: 6 }, { type: 'rtl' }]);
    expect((await upload(pilot, m)).json()).toMatchObject({ result: 'accepted' });
    const del = () => api(s.app, owner)('DELETE', `/api/v2/organisations/${owner.orgId}/missions/${m}`);
    // The LTE link drops; the drone reconnects on its own a moment later.
    (client as unknown as { ws: { terminate(): void } }).ws.terminate();
    await waitFor(() => !s.ctx.hub.droneState(droneId)?.online, 5_000);
    expect((await del()).statusCode).toBe(409); // away for a moment: it still carries the mission
    await waitFor(() => s.ctx.hub.droneState(droneId)?.online && s.ctx.hub.telemetryOf(droneId), 15_000);
    await waitFor(() => s.ctx.hub.droneState(droneId)?.mission?.missionId === m, 5_000);
    const refused = await del();
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'mission_in_use' });
    const before = new Set(s.ctx.db.all<{ id: string }>('SELECT id FROM flights WHERE drone_id = ?', droneId).map((r) => r.id));
    expect((await command(pilot, 'mission_start')).json().result).toBe('accepted');
    const flight = await waitFor(() => s.ctx.db.all<any>('SELECT * FROM flights WHERE drone_id = ?', droneId).find((f) => !before.has(f.id)), 20_000);
    expect(flight.mission_id).toBe(m);
    await waitFor(() => s.ctx.db.get<any>("SELECT * FROM flights WHERE id = ? AND status = 'completed'", flight.id), 60_000);
    await waitFor(() => s.ctx.hub.droneState(droneId)?.mission === null, 10_000);
    expect((await del()).statusCode).toBe(200);
  }, 90_000);

  it('does not let another mission replace the one a flight is flying, even paused in the air', async () => {
    await landed();
    const a = await createMission(pilot, 'Long A', [{ type: 'takeoff', alt: 6 }, { type: 'waypoint', ...destinationPoint(HOME, 0, 30), alt: 6 }, { type: 'waypoint', ...destinationPoint(HOME, 0, 400), alt: 6 }, { type: 'rtl' }]);
    const b = await createMission(pilot, 'Other B', [{ type: 'takeoff', alt: 6 }, { type: 'waypoint', ...destinationPoint(HOME, 90, 30), alt: 6 }, { type: 'rtl' }]);
    expect((await upload(pilot, a)).json()).toMatchObject({ result: 'accepted' });
    expect((await command(pilot, 'mission_start')).json().result).toBe('accepted');
    await waitFor(() => (s.ctx.hub.droneState(droneId)?.mission?.seq ?? 0) >= 2, 40_000);
    expect((await command(pilot, 'mission_pause')).json().result).toBe('accepted');
    await waitFor(() => s.ctx.hub.telemetryOf(droneId)?.mode !== 'MISSION', 10_000);
    const replaced = await upload(pilot, b);
    try {
      expect(replaced.statusCode).toBe(409);
      expect(replaced.json().message).toContain('Long A');
      expect(s.ctx.hub.droneState(droneId)?.mission).toMatchObject({ missionId: a });
    } finally {
      expect((await command(pilot, 'rtl')).json().result).toBe('accepted');
      await landed();
    }
    // On the ground the next mission can be uploaded.
    expect((await upload(pilot, b)).json()).toMatchObject({ result: 'accepted' });
  }, 120_000);

  it('keeps a scheduled operation open when its mission is cut short, and completes it when flown to the end', async () => {
    await landed();
    const m = await createMission(pilot, 'Two goes', [{ type: 'takeoff', alt: 6 }, { type: 'waypoint', ...destinationPoint(HOME, 180, 30), alt: 6 }, { type: 'waypoint', ...destinationPoint(HOME, 180, 300), alt: 6 }, { type: 'rtl' }]);
    const sched = (await api(s.app, manager)('POST', `/api/v2/organisations/${owner.orgId}/schedules`, { missionId: m, droneId, pilotId: pilot.userId, plannedAt: new Date(Date.now() + 1_800_000).toISOString() })).json().id as string;
    expect((await upload(pilot, m)).json()).toMatchObject({ result: 'accepted' });
    const flightsNow = () => new Set(s.ctx.db.all<{ id: string }>('SELECT id FROM flights WHERE drone_id = ?', droneId).map((r) => r.id));
    let before = flightsNow();
    expect((await command(pilot, 'mission_start')).json().result).toBe('accepted');
    const first = await waitFor(() => s.ctx.db.all<any>('SELECT * FROM flights WHERE drone_id = ?', droneId).find((f) => !before.has(f.id)), 20_000);
    await waitFor(() => (s.ctx.hub.droneState(droneId)?.mission?.seq ?? 0) >= 2, 40_000);
    // Low battery: back early, well before the end of the route.
    expect((await command(pilot, 'rtl')).json().result).toBe('accepted');
    await landed();
    await waitFor(() => s.ctx.db.get<any>("SELECT 1 FROM flights WHERE id = ? AND status = 'completed'", first.id), 20_000);
    expect(s.ctx.hub.droneState(droneId)?.mission).toMatchObject({ missionId: m });
    expect(s.ctx.db.get<any>('SELECT status, flight_id FROM schedules WHERE id = ?', sched)).toMatchObject({ status: 'uploaded', flight_id: first.id });
    // Second go: flown to the end – that flight completes the operation.
    before = flightsNow();
    expect((await command(pilot, 'mission_start')).json().result).toBe('accepted');
    const second = await waitFor(() => s.ctx.db.all<any>('SELECT * FROM flights WHERE drone_id = ?', droneId).find((f) => !before.has(f.id)), 20_000);
    expect(s.ctx.db.get<any>('SELECT status, flight_id FROM schedules WHERE id = ?', sched)).toMatchObject({ status: 'in_progress', flight_id: second.id });
    await waitFor(() => s.ctx.hub.droneState(droneId)?.mission === null, 90_000);
    expect(s.ctx.db.get<any>('SELECT status, flight_id FROM schedules WHERE id = ?', sched)).toMatchObject({ status: 'completed', flight_id: second.id });
    await waitFor(() => s.ctx.db.get("SELECT 1 FROM flights WHERE id = ? AND status = 'completed'", second.id), 30_000);
    const routeBefore = (await api(s.app, pilot)('GET', `/api/v2/organisations/${owner.orgId}/flights/${second.id}/planned-route`)).json();
    expect(routeBefore.path.length).toBeGreaterThan(2);

    // The mission is deleted afterwards: the flights keep the plan they flew (route, analysis), and
    // the operation stays in the history under the mission's name.
    const pending = (await api(s.app, manager)('POST', `/api/v2/organisations/${owner.orgId}/schedules`, { missionId: m, droneId, plannedAt: new Date(Date.now() + 7_200_000).toISOString() })).json().id as string;
    expect((await api(s.app, owner)('DELETE', `/api/v2/organisations/${owner.orgId}/missions/${m}`)).statusCode).toBe(200);
    const routeAfter = (await api(s.app, pilot)('GET', `/api/v2/organisations/${owner.orgId}/flights/${second.id}/planned-route`)).json();
    expect(routeAfter).toMatchObject({ missionId: null, snapshot: true });
    expect(routeAfter.path).toEqual(routeBefore.path);
    const analysis = (await api(s.app, owner)('POST', `/api/v2/organisations/${owner.orgId}/flights/${second.id}/analysis`)).json();
    expect(analysis.metrics.routeCoveragePct).toBeGreaterThan(80);
    const listed = (await api(s.app, pilot)('GET', `/api/v2/organisations/${owner.orgId}/schedules?from=${new Date(Date.now() - 86_400_000).toISOString()}`)).json();
    expect(listed.find((x: any) => x.id === sched)).toMatchObject({ missionId: null, missionName: 'Two goes', status: 'completed', flightId: second.id });
    // An operation still to fly goes with its mission.
    expect(listed.find((x: any) => x.id === pending)).toBeUndefined();
  }, 180_000);

  it('compares the flight with the route flown from where the drone took off, not the plan\'s drawn home', async () => {
    // Heron stands 40 m from the home the missions were drawn with.
    const away = destinationPoint(HOME, 135, 40);
    const heron = new LinkClient({ url: `${s.wsBase}/api/v2/link`, key: drone2Key, drone: new VirtualDrone({ home: away, groundAltMsl: 10, seed: 9 }), timeScale: 4 });
    heron.start();
    try {
      await waitFor(() => s.ctx.hub.droneState(drone2Id)?.online && s.ctx.hub.telemetryOf(drone2Id), 10_000);
      const m = await createMission(pilot, 'Drawn at HOME', [{ type: 'takeoff', alt: 8 }, { type: 'waypoint', ...destinationPoint(HOME, 45, 150), alt: 8 }, { type: 'waypoint', ...destinationPoint(HOME, 90, 150), alt: 8 }, { type: 'rtl' }]);
      const up = await api(s.app, pilot)('POST', `/api/v2/organisations/${owner.orgId}/missions/${m}/upload`, { droneId: drone2Id });
      expect(up.json()).toMatchObject({ result: 'accepted' });
      expect((await api(s.app, pilot)('POST', `/api/v2/organisations/${owner.orgId}/drones/${drone2Id}/commands`, { command: 'mission_start', params: {} })).json().result).toBe('accepted');
      const flight = await waitFor(() => s.ctx.db.get<any>('SELECT * FROM flights WHERE drone_id = ? AND mission_id = ?', drone2Id, m), 20_000);
      const analysis = await waitFor(() => s.ctx.db.get<any>('SELECT a.metrics, a.findings FROM flight_analyses a JOIN flights f ON f.id = a.flight_id WHERE f.id = ? AND f.status = ?', flight.id, 'completed'), 90_000);
      const metrics = JSON.parse(analysis.metrics);
      // (The simulator runs 4× real time: under load a few samples come late – coverage stays far above the 80 % finding.)
      expect(metrics.routeCoveragePct).toBeGreaterThan(90);
      expect(metrics.routeOutsidePct).toBeLessThan(5);
      expect(metrics.routeMaxAltDevM).toBeLessThan(5);
      expect(JSON.parse(analysis.findings).map((f: any) => f.code)).not.toEqual(expect.arrayContaining(['route_deviation']));
      expect(JSON.parse(analysis.findings).map((f: any) => f.code).filter((c: string) => c.startsWith('route_'))).toEqual([]);
      // The flight page shows the route from there too.
      const planned = (await api(s.app, pilot)('GET', `/api/v2/organisations/${owner.orgId}/flights/${flight.id}/planned-route`)).json();
      expect(planned.path[0].lat).toBeCloseTo(away.lat, 4);
      expect(planned.path[0].lon).toBeCloseTo(away.lon, 4);
    } finally {
      await heron.stop();
    }
  }, 120_000);

  it('does not treat the loaded mission as flown when the drone refuses to start it', async () => {
    await landed();
    // Without a take-off item the drone refuses to start the mission on the ground.
    const noTakeoff = await createMission(pilot, 'No take-off', [{ type: 'waypoint', ...destinationPoint(HOME, 180, 30), alt: 6 }, { type: 'land' }]);
    expect((await upload(pilot, noTakeoff)).json()).toMatchObject({ result: 'accepted' });
    expect((await command(pilot, 'mission_start')).json().result).toBe('rejected');
    const before = new Set(s.ctx.db.all<{ id: string }>('SELECT id FROM flights WHERE drone_id = ?', droneId).map((r) => r.id));
    expect((await command(pilot, 'takeoff', { alt: 5 })).json().result).toBe('accepted');
    const flight = await waitFor(() => s.ctx.db.all<any>('SELECT * FROM flights WHERE drone_id = ?', droneId).find((f) => !before.has(f.id)), 20_000);
    await waitFor(() => (s.ctx.hub.telemetryOf(droneId)?.altRel ?? 0) > 3, 20_000);
    expect((await command(pilot, 'land')).json().result).toBe('accepted');
    const done = await waitFor(() => s.ctx.db.get<any>("SELECT * FROM flights WHERE id = ? AND status = 'completed'", flight.id), 40_000);
    expect(done).toMatchObject({ mission_id: null, mission_plan: null });
    expect(s.ctx.hub.droneState(droneId)?.mission).toMatchObject({ missionId: noTakeoff });
  }, 90_000);
});

describe('Airspace check of the route as flown from where the drone is', () => {
  it('checks a mission uploaded in the air with its return to the take-off point, and checks a mission again where it is started', async () => {
    await landed();
    const here = s.ctx.hub.telemetryOf(droneId)!;
    const base = { lat: here.lat, lon: here.lon };
    const zone = (
      await api(s.app, manager)('POST', `/api/v2/organisations/${owner.orgId}/airspace/zones`, {
        name: 'Water works',
        type: 'restricted',
        geometry: { kind: 'circle', center: destinationPoint(destinationPoint(base, 0, 150), 90, 150), radiusM: 60 },
        ceilingM: 300,
      })
    ).json();
    const p = destinationPoint(base, 0, 300);
    const w = destinationPoint(p, 90, 300);
    const outAndHome = await createMission(pilot, 'North-east and home', [{ type: 'takeoff', alt: 12 }, { type: 'waypoint', ...w, alt: 12 }, { type: 'rtl' }]);
    const eastHop = await createMission(pilot, 'East hop', [{ type: 'takeoff', alt: 12 }, { type: 'waypoint', ...destinationPoint(base, 90, 200), alt: 12 }, { type: 'land' }]);
    try {
      // From the take-off point, the way to W crosses the zone; the east hop is clear.
      expect((await upload(pilot, outAndHome)).statusCode).toBe(409);
      expect((await upload(pilot, eastHop)).json()).toMatchObject({ result: 'accepted' });
      expect((await command(pilot, 'takeoff', { alt: 12 })).json().result).toBe('accepted');
      await waitFor(() => (s.ctx.hub.telemetryOf(droneId)?.altRel ?? 0) > 10, 30_000);
      expect((await command(pilot, 'goto', { lat: p.lat, lon: p.lon, alt: 12 })).json().result).toBe('accepted');
      await waitFor(() => {
        const t = s.ctx.hub.telemetryOf(droneId);
        return t && haversineDistance(t, p) < 6 && t.groundSpeed < 0.5;
      }, 60_000);
      // Above P the way out (P → W) is clear, but the return to the take-off point crosses the zone.
      const inAir = await upload(pilot, outAndHome);
      expect(inAir.statusCode).toBe(409);
      expect(inAir.json()).toMatchObject({ error: 'airspace_blocked' });
      expect(inAir.json().message).toContain('Water works');
      // The east hop was checked from the take-off point: started from P it would cross the zone.
      const start = await command(pilot, 'mission_start');
      expect(start.statusCode).toBe(409);
      expect(start.json().message).toContain('Water works');
      // Resume (which starts a mission not started yet) and switching to MISSION mode alike.
      const resume = await command(pilot, 'mission_resume');
      expect(resume.statusCode).toBe(409);
      expect(resume.json().message).toContain('Water works');
      const mode = await command(pilot, 'set_mode', { mode: 'MISSION' });
      expect(mode.statusCode).toBe(409);
      expect(mode.json().message).toContain('Water works');
      expect(s.ctx.hub.droneState(droneId)?.mission).toMatchObject({ missionId: eastHop });
      expect(s.ctx.hub.telemetryOf(droneId)?.mode).not.toBe('MISSION');
      // An owner may send it from here anyway (audited) – then it is started.
      expect((await upload(owner, eastHop, { acceptAirspaceConflicts: true })).json()).toMatchObject({ result: 'accepted' });
      expect((await command(owner, 'mission_start')).json().result).toBe('accepted');
    } finally {
      await command(owner, 'land');
      await landed();
      await api(s.app, manager)('DELETE', `/api/v2/organisations/${owner.orgId}/airspace/zones/${zone.id}`);
    }
  }, 150_000);
});

describe('Scheduled operations follow what the drone carries', () => {
  it('puts an uploaded operation back to scheduled when the drone comes back without its mission', async () => {
    const m = await createMission(pilot, 'Heron morning round', [{ type: 'takeoff', alt: 8 }, { type: 'waypoint', ...destinationPoint(HOME, 45, 60), alt: 8 }, { type: 'land' }]);
    const sched = (await api(s.app, manager)('POST', `/api/v2/organisations/${owner.orgId}/schedules`, { missionId: m, droneId: drone2Id, plannedAt: new Date(Date.now() + 900_000).toISOString() })).json().id as string;
    const heron = new LinkClient({ url: `${s.wsBase}/api/v2/link`, key: drone2Key, drone: new VirtualDrone({ home: HOME, groundAltMsl: 10, seed: 12 }), timeScale: 4 });
    heron.start();
    try {
      await waitFor(() => s.ctx.hub.telemetryOf(drone2Id), 10_000);
      expect((await api(s.app, pilot)('POST', `/api/v2/organisations/${owner.orgId}/missions/${m}/upload`, { droneId: drone2Id })).json()).toMatchObject({ result: 'accepted' });
      expect(s.ctx.db.get<any>('SELECT status FROM schedules WHERE id = ?', sched)).toMatchObject({ status: 'uploaded' });
    } finally {
      await heron.stop();
    }
    await waitFor(() => !s.ctx.hub.isOnline(drone2Id), 5_000);
    // The drone restarted meanwhile: it reports nothing on board.
    const restarted = new LinkClient({ url: `${s.wsBase}/api/v2/link`, key: drone2Key, drone: new VirtualDrone({ home: HOME, groundAltMsl: 10, seed: 13 }), timeScale: 4 });
    restarted.start();
    try {
      await waitFor(() => s.ctx.hub.telemetryOf(drone2Id), 10_000);
      await waitFor(() => s.ctx.db.get<any>("SELECT 1 FROM schedules WHERE id = ? AND status = 'scheduled'", sched), 10_000);
      expect(s.ctx.hub.droneState(drone2Id)?.mission ?? null).toBeNull();
    } finally {
      await restarted.stop();
    }
  }, 60_000);
});
