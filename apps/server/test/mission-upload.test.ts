import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { destinationPoint } from '@athena-sky/shared';
import { LinkClient, VirtualDrone } from '@athena-sky/simulator';
import { Viewer, addMember, api, signup, startServer, waitFor, type Session, type TestServer } from './helpers';

const HOME = { lat: 25.0732, lon: 121.5355 };

let s: TestServer;
let owner: Session;
let manager: Session;
let pilot: Session;
let droneId: string;
let drone2Id: string;
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
  drone2Id = (await call('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: 'Heron', model: 'X4' })).json().id;
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
