/**
 * Swarm ways home, flown: three drones in a row 12 m apart fly a line formation (15 m spacing)
 * whose ways home cross. The members never come closer than the planned separation – neither on
 * the planned way home (they hold at their return altitudes, then above their homes, until all
 * are there) nor when the operator sends them all home in the middle of the mission.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { destinationPoint, haversineDistance, newItemId, type MissionPlan, type SwarmDto } from '@athena-sky/shared';
import { LinkClient, VirtualDrone } from '@athena-sky/simulator';
import { api, signup, startServer, Viewer, waitFor, type Session, type TestServer } from './helpers';

const HOME = { lat: 47.3977, lon: 8.5456 };
const at = (east: number, north: number) => destinationPoint(destinationPoint(HOME, 90, east), 0, north);

let s: TestServer;
let owner: Session;
let call: ReturnType<typeof api>;
let viewer: Viewer;
let missionId: string;
const drones: { id: string; home: { lat: number; lon: number }; client: LinkClient }[] = [];
/** Every telemetry update of every drone, on the server's clock. */
const fixes = new Map<string, { t: number; lat: number; lon: number; alt: number }[]>();

/** take-off 30 m → 150 m N → 150 m N + 150 m E → 150 m E → return home. */
const route = (): MissionPlan => ({
  home: { ...HOME, alt: 0 },
  items: [
    { id: newItemId(), type: 'takeoff', alt: 30 },
    { id: newItemId(), type: 'waypoint', ...at(0, 150), alt: 30 },
    { id: newItemId(), type: 'waypoint', ...at(150, 150), alt: 30 },
    { id: newItemId(), type: 'waypoint', ...at(150, 0), alt: 30 },
    { id: newItemId(), type: 'rtl' },
  ],
  rallyPoints: [],
  geofence: null,
  defaultSpeed: 8,
  defaultAlt: 30,
});

const options = { mode: 'formation', pattern: 'line', spacingM: 15, altStepM: 5, syncWaypoints: true, syncLanding: true };

beforeAll(async () => {
  s = await startServer({ utm: { intervalMs: 0, clearAfterMs: 600 } });
  owner = await signup(s.app, { name: 'Row Owner' });
  call = api(s.app, owner);
  for (let i = 0; i < 3; i++) {
    const created = (await call('POST', `/api/v2/organisations/${owner.orgId}/drones`, { name: `Row-${i + 1}`, model: 'X4' })).json();
    const home = at(i * 12, 0);
    const client = new LinkClient({ url: `${s.wsBase}/api/v2/link`, key: created.linkKey, drone: new VirtualDrone({ home, groundAltMsl: 10, seed: 60 + i }), timeScale: 4, telemetryHz: 25 });
    client.start();
    drones.push({ id: created.id, home, client });
    fixes.set(created.id, []);
  }
  s.ctx.hub.events.on('telemetry', (_orgId, droneId, t) => {
    if (t.inAir && t.altRel > 3) fixes.get(droneId)?.push({ t: Date.now(), lat: t.lat, lon: t.lon, alt: t.altRel });
  });
  viewer = new Viewer(`${s.wsBase}/api/v2/live?org=${owner.orgId}`, { cookie: owner.cookie, origin: s.baseUrl });
  await viewer.opened;
  await waitFor(() => drones.every((d) => s.ctx.hub.droneState(d.id)?.telemetry), 15_000);
  missionId = (await call('POST', `/api/v2/organisations/${owner.orgId}/missions`, { name: 'Crossing ways home', plan: route() })).json().id;
}, 30_000);

afterAll(async () => {
  viewer?.close();
  await Promise.all(drones.map((d) => d.client.stop()));
  await s.close();
});

const swarmUpdates = (id: string): SwarmDto[] => viewer.messages.filter((m) => m.type === 'swarm' && m.swarm.id === id).map((m) => m.swarm);
const finalState = (id: string) => waitFor(() => swarmUpdates(id).find((x) => ['completed', 'failed', 'aborted'].includes(x.state)), 200_000);
const landed = () => waitFor(() => drones.every((d) => !s.ctx.hub.droneState(d.id)?.telemetry?.armed), 90_000);
/** Loss-of-separation alerts raised since `from` (ms). */
const separationAlerts = (from: number) =>
  viewer.messages.filter((m) => m.type === 'notification' && m.notification.code === 'loss_of_separation' && Date.parse(m.notification.createdAt) >= from).map((m) => m.notification.message);

/** Closest approach of two airborne drones (above 3 m), interpolating between their updates. */
function closestApproach(from: number): { distanceM: number; horizontalM: number; verticalM: number; afterS?: number; alts?: number[] } {
  const pos = (track: { t: number; lat: number; lon: number; alt: number }[], t: number) => {
    let i = track.findIndex((p) => p.t >= t);
    if (i <= 0) return i === 0 && track[0]!.t - t < 50 ? track[0]! : null;
    const a = track[i - 1]!;
    const b = track[i]!;
    // Not across a gap (the drone was on the ground in between).
    if (b.t - a.t > 500) return null;
    const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
    return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, alt: a.alt + (b.alt - a.alt) * f };
  };
  let best: { distanceM: number; horizontalM: number; verticalM: number; afterS?: number; alts?: number[] } = { distanceM: Infinity, horizontalM: Infinity, verticalM: Infinity };
  const ids = drones.map((d) => d.id);
  const all = ids.map((id) => fixes.get(id)!.filter((p) => p.t >= from));
  const times = [...new Set(all.flatMap((tr) => tr.map((p) => p.t)))].sort((a, b) => a - b);
  for (const t of times) {
    const ps = all.map((tr) => (tr.length ? pos(tr, t) : null));
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i];
        const b = ps[j];
        if (!a || !b) continue;
        const h = haversineDistance(a, b);
        const v = Math.abs(a.alt - b.alt);
        if (Math.hypot(h, v) < best.distanceM) best = { distanceM: Math.hypot(h, v), horizontalM: h, verticalM: v, afterS: Math.round((t - from) / 100) / 10, alts: [a.alt, b.alt].map((x) => Math.round(x * 10) / 10) };
      }
    }
  }
  return best;
}

describe('swarm ways home', () => {
  it('flies the planned way home with every member at its own altitude while others move', async () => {
    const org = `/api/v2/organisations/${owner.orgId}`;
    const preview = (await call('POST', `${org}/swarms/preview`, { missionId, droneIds: drones.map((d) => d.id), options })).json();
    expect(preview.warnings).toEqual([]);
    expect(preview.separation.distanceM).toBeGreaterThanOrEqual(10);
    const op: SwarmDto = (await call('POST', `${org}/swarms`, { missionId, droneIds: drones.map((d) => d.id), options, name: 'Planned way home' })).json();
    expect(op.state).toBe('ready');
    // Take-off, three waypoints, the return altitude, above home.
    expect(op.members.every((m) => m.syncTotal === 6)).toBe(true);
    const from = Date.now();
    expect((await call('POST', `${org}/swarms/${op.id}/actions`, { action: 'start' })).json().state).toBe('running');
    const done = await finalState(op.id);
    expect(done.state).toBe('completed');
    expect(done.members.every((m) => m.state === 'done' && m.syncPassed === 6)).toBe(true);
    await landed();
    // The members held at their return altitudes and above their homes …
    const updates = swarmUpdates(op.id);
    // (The last to arrive is released at once.)
    for (const passed of [5, 6]) {
      const held = drones.filter((d) => updates.some((u) => u.members.some((m) => m.droneId === d.id && m.state === 'waiting' && m.syncPassed === passed)));
      expect(held.length, `held at sync point ${passed}`).toBeGreaterThanOrEqual(drones.length - 1);
    }
    // … and none was released before every member had arrived.
    let releases = 0;
    for (let i = 1; i < updates.length; i++) {
      for (const m of updates[i]!.members) {
        const before = updates[i - 1]!.members.find((x) => x.droneId === m.droneId)!;
        if (before.state !== 'waiting' || m.state !== 'flying') continue;
        releases++;
        expect(Math.min(...updates[i]!.members.map((x) => x.syncPassed))).toBeGreaterThanOrEqual(before.syncPassed);
      }
    }
    expect(releases).toBeGreaterThanOrEqual(6);
    const closest = closestApproach(from);
    expect(closest.distanceM, JSON.stringify(closest)).toBeGreaterThanOrEqual(8);
    expect(separationAlerts(from)).toEqual([]);
    for (const d of drones) expect(haversineDistance(s.ctx.hub.droneState(d.id)!.telemetry!, d.home)).toBeLessThan(3);
  }, 240_000);

  it('sends every member home on its own altitude when the operator returns them all mid-mission', async () => {
    const org = `/api/v2/organisations/${owner.orgId}`;
    const op: SwarmDto = (await call('POST', `${org}/swarms`, { missionId, droneIds: drones.map((d) => d.id), options, name: 'Return all' })).json();
    const from = Date.now();
    await call('POST', `${org}/swarms/${op.id}/actions`, { action: 'start' });
    // On the last leg (heading south, 150 m east): the ways home cross.
    await waitFor(() => swarmUpdates(op.id).find((u) => u.members.every((m) => m.syncPassed >= 3)), 60_000);
    const ret = (await call('POST', `${org}/swarms/${op.id}/actions`, { action: 'rtl' })).json();
    expect(ret).toMatchObject({ state: 'returning', message: 'Climbing to separate return altitudes' });
    const plans = (await call('GET', `${org}/missions?swarm=true`)).json().filter((m: any) => m.swarmId === op.id);
    expect(plans).toHaveLength(3);
    // Climb first, then home, then land: each step only once every member has finished the last.
    await waitFor(() => swarmUpdates(op.id).find((u) => u.message === 'Flying home, each drone at its own altitude'), 60_000);
    const alts = drones.map((d) => s.ctx.hub.droneState(d.id)!.telemetry!.altRel).sort((a, b) => a - b);
    expect(alts[1]! - alts[0]!).toBeGreaterThan(8);
    expect(alts[2]! - alts[1]!).toBeGreaterThan(8);
    await waitFor(() => swarmUpdates(op.id).find((u) => u.message === 'Landing'), 60_000);
    expect((await finalState(op.id)).state).toBe('completed');
    await landed();
    const closest = closestApproach(from);
    expect(closest.distanceM, JSON.stringify(closest)).toBeGreaterThanOrEqual(8);
    expect(separationAlerts(from)).toEqual([]);
    for (const d of drones) expect(haversineDistance(s.ctx.hub.droneState(d.id)!.telemetry!, d.home)).toBeLessThan(3);
  }, 240_000);
});
