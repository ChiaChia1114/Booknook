import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { destinationPoint, newItemId, type MissionPlan, type SwarmDto } from '@athena-sky/shared';
import { LinkClient, VirtualDrone } from '@athena-sky/simulator';
import { addMember, api, signup, startServer, Viewer, waitFor, type Session, type TestServer } from './helpers';

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
    expect(p.members.every((m: any) => m.syncPoints.length === 3 && m.plan.items[0].type === 'takeoff')).toBe(true);
    expect(p.separation.distanceM).toBeGreaterThan(10);
    expect(p.durationS).toBeGreaterThan(20);
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
  it('ends the operation when its operator can no longer control drones', async () => {
    const org = `/api/v2/organisations/${owner.orgId}`;
    const p2 = api(s.app, pilot2);
    const op: SwarmDto = (await p2('POST', `${org}/swarms`, body({ name: 'Demotion test' }))).json();
    expect((await p2('POST', `${org}/swarms/${op.id}/actions`, { action: 'start' })).statusCode).toBe(200);
    await waitFor(() => swarmUpdates(op.id).find((u) => u.members.every((m) => m.syncPassed >= 1)), 30_000);
    await call('PATCH', `${org}/members/${pilot2.userId}`, { role: 'viewer' });
    const demotedAt = new Date().toISOString();
    const ended = await finalState(op.id, 5000);
    expect(ended.state).toBe('aborted');
    expect(ended.message).toMatch(/Second Pilot can no longer control drones/);
    await new Promise((r) => setTimeout(r, 2000));
    expect(s.ctx.db.all("SELECT 1 FROM audit_log WHERE user_id = ? AND action = 'drone.command' AND created_at > ?", pilot2.userId, demotedAt)).toHaveLength(0);
    // Another pilot takes over and brings the drones home.
    for (const d of drones) expect((await call('POST', `${org}/drones/${d.id}/commands`, { command: 'rtl' })).statusCode).toBe(200);
    await landed();
    await call('PATCH', `${org}/members/${pilot2.userId}`, { role: 'pilot' });
  }, 120_000);
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
