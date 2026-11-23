import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { destinationPoint, haversineDistance, newItemId, type MissionPlan, type SwarmDto } from '@athena-sky/shared';
import { LinkClient, VirtualDrone } from '@athena-sky/simulator';
import { addMember, api, recordCommands, signup, startServer, Viewer, waitFor, type Session, type TestServer } from './helpers';

const HOME = { lat: 25.0732, lon: 121.5355 };

let s: TestServer;
let owner: Session;
let pilot2: Session;
let call: ReturnType<typeof api>;
let viewer: Viewer;
const drones: { id: string; name: string; home: { lat: number; lon: number }; client: LinkClient }[] = [];
let missionId: string;

/** Leader route: 100 m north, then 80 m east, return home. */
const basePlan = (): MissionPlan => ({
  home: { ...HOME, alt: 0 },
  items: [
    { id: newItemId(), type: 'takeoff', alt: 12 },
    { id: newItemId(), type: 'waypoint', ...destinationPoint(HOME, 0, 100), alt: 12 },
    { id: newItemId(), type: 'waypoint', ...destinationPoint(destinationPoint(HOME, 0, 100), 90, 80), alt: 12 },
    { id: newItemId(), type: 'rtl' },
  ],
  rallyPoints: [],
  geofence: null,
  defaultSpeed: 8,
  defaultAlt: 12,
});

beforeAll(async () => {
  s = await startServer({ utm: { intervalMs: 0, clearAfterMs: 600 } });
  owner = await signup(s.app, { name: 'Olivia Owner' });
  pilot2 = await signup(s.app, { name: 'Second Pilot' });
  call = api(s.app, owner);
  await addMember(s.app, owner, pilot2, 'pilot');
  for (let i = 0; i < 3; i++) {
    const created = (await call('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: `Swarm-${i + 1}`, model: 'X4' })).json();
    const home = destinationPoint(HOME, 90, i * 40);
    const client = new LinkClient({ url: `${s.wsBase}/api/v2/link`, key: created.linkKey, drone: new VirtualDrone({ home, groundAltMsl: 10, seed: 20 + i }), timeScale: 10 });
    client.start();
    drones.push({ id: created.id, name: `Swarm-${i + 1}`, home, client });
  }
  viewer = new Viewer(`${s.wsBase}/api/v2/live?org=${owner.orgId}`, { cookie: owner.cookie, origin: s.baseUrl });
  await viewer.opened;
  await waitFor(() => drones.every((d) => s.ctx.hub.droneState(d.id)?.telemetry), 15_000);
  missionId = (await call('POST', `/api/v2/organisations/${owner.orgId}/missions`, { name: 'Formation route', plan: basePlan() })).json().id;
}, 30_000);

afterAll(async () => {
  viewer?.close();
  await Promise.all(drones.map((d) => d.client.stop()));
  await s.close();
});

const swarmUpdates = (id: string): SwarmDto[] => viewer.messages.filter((m) => m.type === 'swarm' && m.swarm.id === id).map((m) => m.swarm);
const finalState = (id: string, timeoutMs = 90_000) =>
  waitFor(() => swarmUpdates(id).find((x) => ['completed', 'failed', 'aborted'].includes(x.state)), timeoutMs);
const landed = () => waitFor(() => drones.every((d) => !s.ctx.hub.droneState(d.id)?.telemetry?.armed), 60_000);
const body = (extra: Record<string, unknown> = {}) => ({ missionId, droneIds: drones.map((d) => d.id), options: { mode: 'formation', pattern: 'line', spacingM: 20, altStepM: 5, syncWaypoints: true }, ...extra });

describe('swarm operations', () => {
  it('previews a formation: one mission per drone, sync points, timing and separation', async () => {
    const res = await call('POST', `/api/v2/organisations/${owner.orgId}/swarms/preview`, body());
    expect(res.statusCode).toBe(200);
    const p = res.json();
    expect(p.members).toHaveLength(3);
    expect(new Set(p.members.map((m: any) => m.slot))).toEqual(new Set([0, 1, 2]));
    expect(p.members.every((m: any) => m.syncPoints.length === 5 && m.plan.items[0].type === 'takeoff')).toBe(true);
    expect(p.separation.distanceM).toBeGreaterThan(10);
    expect(p.durationS).toBeGreaterThan(20);
    expect(p.airspace.map((a: any) => a.verdict)).toEqual(['clear', 'clear', 'clear']);
    expect(p.errors).toEqual([]);
    // What uploading would refuse is shown already in the preview.
    const fenced = { ...basePlan(), geofence: { polygon: [destinationPoint(HOME, 225, 500), destinationPoint(HOME, 315, 500), destinationPoint(HOME, 45, 500), destinationPoint(HOME, 135, 500)], maxAlt: 10, action: 'rtl' } };
    const fencedId = (await call('POST', `/api/v2/organisations/${owner.orgId}/missions`, { name: 'Low fence', plan: fenced })).json().id;
    const low = (await call('POST', `/api/v2/organisations/${owner.orgId}/swarms/preview`, body({ missionId: fencedId }))).json();
    expect(low.errors.length).toBeGreaterThan(0);
    expect(low.errors[0]).toMatch(/^Mission of Swarm-\d is not valid: .*geofence ceiling/);
    const refused = await call('POST', `/api/v2/organisations/${owner.orgId}/swarms`, body({ missionId: fencedId, acceptWarnings: true }));
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toBe(low.errors[0]);
    await call('DELETE', `/api/v2/organisations/${owner.orgId}/missions/${fencedId}`);
    // Validation: unknown mission, too few drones.
    expect((await call('POST', `/api/v2/organisations/${owner.orgId}/swarms/preview`, body({ droneIds: [drones[0]!.id] }))).statusCode).toBe(400);
    expect((await call('POST', `/api/v2/organisations/${owner.orgId}/swarms/preview`, body({ missionId: drones[0]!.id }))).statusCode).toBe(404);
  });

  it('flies a synchronised formation: no drone ever gets more than one sync point ahead', async () => {
    const created = await call('POST', `/api/v2/organisations/${owner.orgId}/swarms`, body({ name: 'Formation test' }));
    expect(created.statusCode).toBe(201);
    const op: SwarmDto = created.json();
    expect(op.state).toBe('ready');
    expect(op.members.every((m) => m.state === 'uploaded' && m.missionId)).toBe(true);
    // Per-drone missions are stored with the operation but hidden from the mission list.
    const list = (await call('GET', `/api/v2/organisations/${owner.orgId}/missions`)).json();
    expect(list.map((m: any) => m.id)).toEqual([missionId]);
    const all = (await call('GET', `/api/v2/organisations/${owner.orgId}/missions?swarm=true`)).json();
    expect(all.filter((m: any) => m.swarmId === op.id)).toHaveLength(3);

    const started = await call('POST', `/api/v2/organisations/${owner.orgId}/swarms/${op.id}/actions`, { action: 'start' });
    expect(started.statusCode).toBe(200);
    expect(started.json().state).toBe('running');
    const done = await finalState(op.id);
    expect(done.state).toBe('completed');
    expect(done.members.every((m) => m.state === 'done')).toBe(true);
    const updates = swarmUpdates(op.id);
    // Barriers engaged before the end (take-off / waypoint), not only at the final hold …
    expect(updates.some((u) => u.members.some((m) => m.state === 'waiting' && m.syncPassed < m.syncTotal))).toBe(true);
    // … a waiting drone is released only once every active drone has reached its sync point …
    let releases = 0;
    for (let i = 1; i < updates.length; i++) {
      const active = updates[i]!.members.filter((m) => m.state !== 'detached' && m.state !== 'done');
      for (const m of updates[i]!.members) {
        const before = updates[i - 1]!.members.find((x) => x.droneId === m.droneId)!;
        if (before.state === 'waiting' && m.state === 'flying') {
          releases++;
          expect(Math.min(...active.map((x) => x.syncPassed))).toBeGreaterThanOrEqual(before.syncPassed);
        }
      }
    }
    expect(releases).toBeGreaterThan(0);
    // … and the leading drone is never more than one sync point ahead.
    for (const u of updates) {
      const passed = u.members.filter((m) => m.state !== 'detached' && m.state !== 'done').map((m) => m.syncPassed);
      if (passed.length > 1) expect(Math.max(...passed) - Math.min(...passed)).toBeLessThanOrEqual(1);
    }
    expect(viewer.find((m) => m.type === 'notification' && m.notification.code === 'swarm_started')).toBeTruthy();
    // Formation members are exempt from the fleet separation alert (planned spacing 20 m).
    expect(viewer.find((m) => m.type === 'notification' && m.notification.code === 'loss_of_separation')).toBeFalsy();
    await landed();
  }, 120_000);

  it('pauses, resumes and returns all drones home together', async () => {
    const op: SwarmDto = (await call('POST', `/api/v2/organisations/${owner.orgId}/swarms`, body({ name: 'Pause test' }))).json();
    await call('POST', `/api/v2/organisations/${owner.orgId}/swarms/${op.id}/actions`, { action: 'start' });
    await waitFor(() => swarmUpdates(op.id).find((u) => u.members.every((m) => m.syncPassed >= 1)), 30_000);
    const paused = (await call('POST', `/api/v2/organisations/${owner.orgId}/swarms/${op.id}/actions`, { action: 'pause' })).json();
    expect(paused.state).toBe('paused');
    await waitFor(() => drones.every((d) => s.ctx.hub.droneState(d.id)?.telemetry?.mode === 'HOLD'), 10_000);
    // Double pause is refused.
    expect((await call('POST', `/api/v2/organisations/${owner.orgId}/swarms/${op.id}/actions`, { action: 'pause' })).statusCode).toBe(409);
    expect((await call('POST', `/api/v2/organisations/${owner.orgId}/swarms/${op.id}/actions`, { action: 'resume' })).json().state).toBe('running');
    const ret = (await call('POST', `/api/v2/organisations/${owner.orgId}/swarms/${op.id}/actions`, { action: 'rtl' })).json();
    expect(ret.state).toBe('returning');
    expect(ret.members.every((m: any) => m.state === 'returning')).toBe(true);
    expect((await finalState(op.id)).state).toBe('completed');
    await landed();
    expect((await call('POST', `/api/v2/organisations/${owner.orgId}/swarms/${op.id}/actions`, { action: 'resume' })).statusCode).toBe(409);
  }, 120_000);

  it('lets a pilot take over one drone; the others continue without waiting for it', async () => {
    const op: SwarmDto = (await call('POST', `/api/v2/organisations/${owner.orgId}/swarms`, body({ name: 'Takeover test' }))).json();
    // A drone controlled by another pilot cannot join a new operation.
    await call('POST', `/api/v2/organisations/${owner.orgId}/swarms/${op.id}/actions`, { action: 'start' });
    await waitFor(() => swarmUpdates(op.id).find((u) => u.members.every((m) => m.syncPassed >= 1)), 30_000);
    const other = new Viewer(`${s.wsBase}/api/v2/live?org=${owner.orgId}`, { cookie: pilot2.cookie, origin: s.baseUrl });
    await other.opened;
    other.send({ type: 'control', droneId: drones[2]!.id, action: 'request' });
    const detached = await waitFor(() => swarmUpdates(op.id).find((u) => u.members.find((m) => m.droneId === drones[2]!.id)?.state === 'detached'), 10_000);
    expect(detached.members.find((m) => m.droneId === drones[2]!.id)!.message).toMatch(/Second Pilot took control/);
    expect(await viewer.wait((m) => m.type === 'notification' && m.notification.code === 'swarm_member_detached')).toBeTruthy();
    // The operation can no longer command it: the pilot who took over flies it home.
    const rtlId = 'pilot2-rtl';
    other.send({ type: 'command', droneId: drones[2]!.id, requestId: rtlId, command: 'rtl' });
    expect((await other.wait((m) => m.type === 'ack' && m.requestId === rtlId)).result).toBe('accepted');
    const done = await finalState(op.id);
    expect(done.state).toBe('completed');
    expect(done.members.filter((m) => m.state === 'done')).toHaveLength(2);
    other.send({ type: 'control', droneId: drones[2]!.id, action: 'release' });
    other.close();
    await landed();
    const listed: SwarmDto[] = (await call('GET', `/api/v2/organisations/${owner.orgId}/swarms`)).json();
    expect(listed[0]).toMatchObject({ id: op.id, state: 'completed' });
  }, 120_000);
  it("refuses a member's own mission commands while the operation flies; other commands take it out first", async () => {
    const org = `/api/v2/organisations/${owner.orgId}`;
    const op: SwarmDto = (await call('POST', `${org}/swarms`, body({ name: 'Member commands' }))).json();
    await call('POST', `${org}/swarms/${op.id}/actions`, { action: 'start' });
    await waitFor(() => swarmUpdates(op.id).find((u) => u.members.every((m) => m.syncPassed >= 1)), 30_000);
    const [a, b] = drones;
    // Resuming, (re)starting or switching to MISSION would leave the barrier on its own.
    for (const c of [{ command: 'mission_resume' }, { command: 'mission_start' }, { command: 'set_mode', params: { mode: 'MISSION' } }]) {
      const res = await call('POST', `${org}/drones/${a!.id}/commands`, c);
      expect(res.statusCode, c.command).toBe(409);
      expect(res.json().message).toMatch(/flies in the swarm operation "Member commands" – use the operation's controls/);
    }
    // A photo is no flight command.
    expect((await call('POST', `${org}/drones/${a!.id}/commands`, { command: 'camera_photo' })).statusCode).toBe(200);
    expect(swarmUpdates(op.id).at(-1)!.members.find((m) => m.droneId === a!.id)!.state).not.toBe('detached');
    // Holding, returning, landing … one member: it leaves the operation, the others do not wait for it.
    expect((await call('POST', `${org}/drones/${b!.id}/commands`, { command: 'hold' })).statusCode).toBe(200);
    const left = await waitFor(() => swarmUpdates(op.id).find((u) => u.members.find((m) => m.droneId === b!.id)?.state === 'detached'), 5_000);
    expect(left.members.find((m) => m.droneId === b!.id)!.message).toBe('Olivia Owner sent "hold" to it');
    // Once out, it is the pilot's again.
    expect((await call('POST', `${org}/drones/${b!.id}/commands`, { command: 'rtl' })).statusCode).toBe(200);
    expect((await call('POST', `${org}/swarms/${op.id}/actions`, { action: 'rtl' })).statusCode).toBe(200);
    expect((await finalState(op.id)).state).toBe('completed');
    await landed();
  }, 120_000);

  it('lets another pilot take photos of a member without taking it out of the operation', async () => {
    const org = `/api/v2/organisations/${owner.orgId}`;
    const op: SwarmDto = (await call('POST', `${org}/swarms`, body({ name: 'Photo test' }))).json();
    await call('POST', `${org}/swarms/${op.id}/actions`, { action: 'start' });
    await waitFor(() => swarmUpdates(op.id).find((u) => u.members.every((m) => m.syncPassed >= 1)), 30_000);
    const other = new Viewer(`${s.wsBase}/api/v2/live?org=${owner.orgId}`, { cookie: pilot2.cookie, origin: s.baseUrl });
    await other.opened;
    other.send({ type: 'command', droneId: drones[1]!.id, requestId: 'photo-1', command: 'camera_photo' });
    expect((await other.wait((m) => m.type === 'ack' && m.requestId === 'photo-1')).result).toBe('accepted');
    // The photo took no control lock: the member stays in the operation.
    expect(s.ctx.hub.droneState(drones[1]!.id)!.controller).toBeNull();
    await new Promise((r) => setTimeout(r, 500));
    expect(swarmUpdates(op.id).at(-1)!.members.find((m) => m.droneId === drones[1]!.id)!.state).not.toBe('detached');
    other.close();
    // Ended in the air: the drones fly their missions on by themselves – through the operation's
    // holds (return altitude, above home) – and land, instead of hovering there for good.
    expect((await call('POST', `${org}/swarms/${op.id}/actions`, { action: 'end' })).json().state).toBe('aborted');
    await landed();
    for (const d of drones) expect(haversineDistance(s.ctx.hub.droneState(d.id)!.telemetry!, d.home)).toBeLessThan(5);
    // An action refused in the state it is in changes nothing (nor is it audited).
    const audited = () => s.ctx.db.all("SELECT 1 FROM audit_log WHERE org_id = ? AND action LIKE 'swarm.%'", owner.orgId).length;
    const ready: SwarmDto = (await call('POST', `${org}/swarms`, body({ name: 'Refused' }))).json();
    const before = audited();
    expect((await call('POST', `${org}/swarms/${ready.id}/actions`, { action: 'pause' })).statusCode).toBe(409);
    expect(audited()).toBe(before);
    expect((await call('POST', `${org}/swarms/${ready.id}/actions`, { action: 'end' })).statusCode).toBe(200);
  }, 150_000);

  it('ends the operation when its operator can no longer control drones', async () => {
    const org = `/api/v2/organisations/${owner.orgId}`;
    const p2 = api(s.app, pilot2);
    const rec = recordCommands(s.ctx);
    const op: SwarmDto = (await p2('POST', `${org}/swarms`, body({ name: 'Demotion test' }))).json();
    expect((await p2('POST', `${org}/swarms/${op.id}/actions`, { action: 'start' })).statusCode).toBe(200);
    await waitFor(() => swarmUpdates(op.id).find((u) => u.members.every((m) => m.syncPassed >= 1)), 30_000);
    // The operation's start went to the drones in the operator's name.
    expect(rec.log.some((c) => c.userId === pilot2.userId && c.command === 'mission_start' && c.delivered)).toBe(true);
    await call('PATCH', `${org}/members/${pilot2.userId}`, { role: 'viewer' });
    const demotedAt = Date.now();
    const ended = await finalState(op.id, 5000);
    expect(ended.state).toBe('aborted');
    expect(ended.message).toMatch(/Second Pilot can no longer control drones/);
    await new Promise((r) => setTimeout(r, 2000));
    expect(rec.log.filter((c) => c.userId === pilot2.userId && c.delivered && c.at > demotedAt)).toHaveLength(0);
    rec.restore();
    // Another pilot takes over and brings the drones home.
    for (const d of drones) expect((await call('POST', `${org}/drones/${d.id}/commands`, { command: 'rtl' })).statusCode).toBe(200);
    await landed();
    await call('PATCH', `${org}/members/${pilot2.userId}`, { role: 'pilot' });
  }, 120_000);

  it("checks every drone's mission against the airspace before uploading", async () => {
    const org = `/api/v2/organisations/${owner.orgId}`;
    const zone = await call('POST', `${org}/airspace/zones`, { name: 'Prison', type: 'prohibited', geometry: { kind: 'circle', center: destinationPoint(HOME, 0, 1500), radiusM: 60 }, ceilingM: 500 });
    expect(zone.statusCode).toBe(201);
    const plan = basePlan();
    plan.items = [plan.items[0]!, { id: newItemId(), type: 'waypoint', ...destinationPoint(HOME, 0, 1800), alt: 12 }, { id: newItemId(), type: 'rtl' }];
    const over = (await call('POST', `${org}/missions`, { name: 'Over the prison', plan })).json().id;
    const preview = (await call('POST', `${org}/swarms/preview`, body({ missionId: over }))).json();
    expect(preview.airspace).toHaveLength(3);
    expect(preview.airspace.every((a: any) => a.verdict === 'blocked' && a.conflicts[0].name === 'Prison')).toBe(true);
    const before = (await call('GET', `${org}/swarms`)).json().length;
    const refused = await call('POST', `${org}/swarms`, body({ missionId: over }));
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'airspace_blocked' });
    expect(refused.json().details.drones.map((d: any) => d.droneId).sort()).toEqual(drones.map((d) => d.id).sort());
    expect((await call('GET', `${org}/swarms`)).json()).toHaveLength(before);
    // Pilots cannot override; the owner can, and the override is audited.
    expect((await api(s.app, pilot2)('POST', `${org}/swarms`, body({ missionId: over, acceptAirspaceConflicts: true }))).statusCode).toBe(403);
    const forced = await call('POST', `${org}/swarms`, body({ missionId: over, acceptAirspaceConflicts: true, name: 'Override test' }));
    expect(forced.statusCode).toBe(201);
    expect(forced.json().state).toBe('ready');
    expect(s.ctx.db.get<any>("SELECT * FROM audit_log WHERE org_id = ? AND action = 'mission.airspace_override' AND target = ?", owner.orgId, over)).toMatchObject({ user_id: owner.userId });
    // While the operation runs, its drones' missions cannot be replaced one by one.
    const replace = await call('POST', `${org}/missions/${missionId}/upload`, { droneId: drones[0]!.id });
    expect(replace.statusCode).toBe(409);
    expect(replace.json().message).toContain('Override test');
    expect((await call('POST', `${org}/swarms/${forced.json().id}/actions`, { action: 'end' })).statusCode).toBe(200);
    expect((await call('POST', `${org}/missions/${missionId}/upload`, { droneId: drones[0]!.id })).json()).toMatchObject({ result: 'accepted' });
    await call('DELETE', `${org}/airspace/zones/${zone.json().id}`);
  }, 60_000);
});

describe('real-time UTM monitoring and the notification centre', () => {
  const cmd = async (droneId: string, command: string, params: Record<string, unknown> = {}) => {
    const requestId = Math.random().toString(36).slice(2);
    viewer.send({ type: 'command', droneId, requestId, command, params });
    return viewer.wait((m) => m.type === 'ack' && m.requestId === requestId);
  };
  const note = (code: string, droneId?: string) => viewer.wait((m) => m.type === 'notification' && m.notification.code === code && (!droneId || m.notification.droneId === droneId), 30_000);

  it('reports approach, infringement and the end of an infringement of a restricted area', async () => {
    const d = drones[0]!;
    const center = destinationPoint(d.home, 0, 120);
    const zone = await call('POST', `/api/v2/organisations/${owner.orgId}/airspace/zones`, { name: 'Test helipad', type: 'restricted', geometry: { kind: 'circle', center, radiusM: 30 }, floorM: 0, ceilingM: 150 });
    expect(zone.statusCode).toBe(201);
    expect((await cmd(d.id, 'takeoff', { alt: 15 })).result).toBe('accepted');
    await waitFor(() => (s.ctx.hub.droneState(d.id)?.telemetry?.altRel ?? 0) > 13, 20_000);
    await cmd(d.id, 'goto', { ...center, alt: 15 });
    const near = await note('zone_approach', d.id);
    expect(near.notification.level).toBe('warning');
    const inside = await note('zone_infringement', d.id);
    expect(inside.notification).toMatchObject({ level: 'critical', category: 'airspace', title: 'Inside restricted area' });
    // Leaving the zone resolves the infringement.
    await cmd(d.id, 'goto', { ...d.home, alt: 15 });
    const resolved = await viewer.wait((m) => m.type === 'notification' && m.notification.id === inside.notification.id && m.notification.resolvedAt, 30_000);
    expect(resolved.notification.resolvedAt).toBeTruthy();
  }, 60_000);

  it('reports the altitude limit and a loss of separation between own drones', async () => {
    const [a, b] = drones;
    await call('PATCH', `/api/v2/organisations/${owner.orgId}`, { settings: { maxAltitudeM: 12 } });
    expect((await note('altitude_limit', a!.id)).notification.message).toMatch(/limit is 12 m/);
    await call('PATCH', `/api/v2/organisations/${owner.orgId}`, { settings: { maxAltitudeM: 120 } });
    expect((await cmd(b!.id, 'takeoff', { alt: 18 })).result).toBe('accepted');
    await waitFor(() => (s.ctx.hub.droneState(b!.id)?.telemetry?.altRel ?? 0) > 15, 20_000);
    const ta = s.ctx.hub.droneState(a!.id)!.telemetry!;
    await cmd(b!.id, 'goto', { lat: ta.lat, lon: ta.lon, alt: 18 });
    const sep = await note('loss_of_separation');
    expect(sep.notification.category).toBe('separation');
    await cmd(a!.id, 'land');
    await cmd(b!.id, 'land');
  }, 60_000);

  it('lists notifications with the unread count and marks them read', async () => {
    const list = (await call('GET', `/api/v2/organisations/${owner.orgId}/notifications?limit=100`)).json();
    expect(list.unread).toBeGreaterThanOrEqual(4);
    expect(list.items[0].createdAt >= list.items.at(-1).createdAt).toBe(true);
    expect(list.items.some((n: any) => n.code === 'zone_infringement' && n.droneName === 'Swarm-1')).toBe(true);
    const read = await call('POST', `/api/v2/organisations/${owner.orgId}/notifications/read`, {});
    expect(read.statusCode).toBe(200);
    expect((await call('GET', `/api/v2/organisations/${owner.orgId}/notifications`)).json().unread).toBe(0);
    // Another member has their own read state.
    expect((await api(s.app, pilot2)('GET', `/api/v2/organisations/${owner.orgId}/notifications`)).json().unread).toBeGreaterThan(0);
    // Not visible to other organisations.
    const stranger = await signup(s.app);
    expect((await api(s.app, stranger)('GET', `/api/v2/organisations/${owner.orgId}/notifications`)).statusCode).toBe(404);
  });
});
