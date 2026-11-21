import { describe, expect, it } from 'vitest';
import {
  LocalProjection,
  assignSlots,
  destinationPoint,
  formationPlans,
  haversineDistance,
  holdAtFinalSyncPoint,
  initialBearing,
  newItemId,
  planSwarm,
  planTimeline,
  separationOverTime,
  splitPlan,
  swarmSyncPoints,
  syncedTimelines,
  synchronizeLegSpeeds,
  type LatLon,
  type MissionItem,
  type MissionPlan,
} from '../src';

const HOME = { lat: 25.0732, lon: 121.5355 };
const proj = new LocalProjection(HOME);
const at = (x: number, y: number) => proj.toLatLon(x, y);
const xy = (p: LatLon) => proj.toXY(p);

const plan = (items: MissionItem[], speed = 10, alt = 50): MissionPlan => ({
  home: { ...HOME, alt: 0 },
  items,
  rallyPoints: [],
  geofence: null,
  defaultSpeed: speed,
  defaultAlt: alt,
});
const wp = (p: LatLon, alt = 50, extra: Partial<MissionItem> = {}): MissionItem => ({ id: newItemId(), type: 'waypoint', lat: p.lat, lon: p.lon, alt, ...extra });
const positioned = (p: MissionPlan) => p.items.filter((i) => i.lat !== undefined) as (MissionItem & LatLon)[];

describe('formation plans', () => {
  // Leader: north 500 m, then east 500 m (a 90° right turn).
  const base = plan([{ id: newItemId(), type: 'takeoff', alt: 50 }, wp(at(0, 500)), wp(at(500, 500)), { id: newItemId(), type: 'rtl' }]);

  it('offsets legs in parallel with mitred corners (line abreast)', () => {
    const [lead, right, left] = formationPlans(base, 3, 'line', 25, 5);
    const r = positioned(right!).map(xy);
    const l = positioned(left!).map(xy);
    // Right member: north leg shifted 25 m east, east leg shifted 25 m south; corner at (25, 475).
    expect(r[0]!.x).toBeCloseTo(25, 0);
    expect(r[0]!.y).toBeCloseTo(475, 0);
    expect(r[1]!.x).toBeCloseTo(500, 0);
    expect(r[1]!.y).toBeCloseTo(475, 0);
    // Left member mirrored: corner at (-25, 525).
    expect(l[0]!.x).toBeCloseTo(-25, 0);
    expect(l[0]!.y).toBeCloseTo(525, 0);
    expect(l[1]!.y).toBeCloseTo(525, 0);
    // Legs stay parallel to the leader's.
    const lp = positioned(lead!);
    expect(initialBearing(positioned(right!)[0]!, positioned(right!)[1]!)).toBeCloseTo(initialBearing(lp[0]!, lp[1]!), 0);
    // Vertical stagger on every altitude, including the take-off.
    expect(right!.items[0]!.alt).toBe(55);
    expect(left!.items.map((i) => i.alt).filter((a) => a !== undefined)).toEqual([60, 60, 60]);
  });

  it('keeps the trailing distance of a column on straight legs', () => {
    const straight = plan([{ id: newItemId(), type: 'takeoff', alt: 40 }, wp(at(0, 300), 40), wp(at(0, 900), 40)]);
    const [, second, third] = formationPlans(straight, 3, 'column', 30);
    expect(positioned(second!).map(xy).map((p) => Math.round(p.y))).toEqual([270, 870]);
    expect(positioned(third!).map(xy).map((p) => Math.round(p.y))).toEqual([240, 840]);
  });
});

describe('splitting a route between drones', () => {
  // 0 → 300 → 600 → 900 m north with a speed change and a camera trigger.
  const base = plan([
    { id: newItemId(), type: 'takeoff', alt: 60 },
    { id: newItemId(), type: 'speed', speed: 6 },
    wp(at(0, 0), 60),
    { id: newItemId(), type: 'camera_trigger', triggerDistanceM: 20 },
    wp(at(0, 300), 60),
    wp(at(0, 600), 80),
    wp(at(0, 900), 80),
    { id: newItemId(), type: 'camera_trigger', triggerDistanceM: 0 },
    { id: newItemId(), type: 'rtl' },
  ]);
  const pathLength = (p: MissionPlan) => {
    const pts = positioned(p);
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += haversineDistance(pts[i - 1]!, pts[i]!);
    return d;
  };

  it('cuts inside a leg at equal path lengths and carries speed and trigger state', () => {
    const [a, b] = splitPlan(base, 2);
    expect(pathLength(a!)).toBeCloseTo(450, 0);
    expect(pathLength(b!)).toBeCloseTo(450, 0);
    const endA = positioned(a!).at(-1)!;
    const startB = positioned(b!)[0]!;
    expect(xy(endA).y).toBeCloseTo(450, 0);
    expect(haversineDistance(endA, startB)).toBeLessThan(0.01);
    // Interpolated altitude between 60 m (300 m) and 80 m (600 m).
    expect(startB.alt).toBeCloseTo(70, 5);
    // Part A stops the trigger at its end; part B restores speed then starts the trigger at the cut.
    expect(a!.items.map((i) => i.type)).toEqual(['takeoff', 'speed', 'waypoint', 'camera_trigger', 'waypoint', 'waypoint', 'camera_trigger', 'rtl']);
    expect(a!.items.at(-2)!.triggerDistanceM).toBe(0);
    expect(b!.items.map((i) => i.type)).toEqual(['takeoff', 'speed', 'waypoint', 'camera_trigger', 'waypoint', 'waypoint', 'camera_trigger', 'rtl']);
    expect(b!.items[1]!.speed).toBe(6);
    expect(b!.items[3]!.triggerDistanceM).toBe(20);
  });

  it('cuts at existing waypoints when they fall on a cut', () => {
    const parts = splitPlan(base, 3);
    expect(parts.map(pathLength).map(Math.round)).toEqual([300, 300, 300]);
    expect(parts.every((p) => p.items[0]!.type === 'takeoff' && p.items.at(-1)!.type === 'rtl')).toBe(true);
    expect(positioned(parts[1]!).map((p) => Math.round(xy(p).y))).toEqual([300, 600]);
  });

  it('rejects routes without length', () => {
    expect(() => splitPlan(plan([wp(at(0, 0))]), 2)).toThrow(/too short/);
  });
});

describe('slot assignment, sync points and timing', () => {
  it('assigns drones to slots with the least total distance', () => {
    const drones = [at(0, 0), at(40, 0), at(80, 0)];
    const slots = [at(80, 100), at(0, 100), at(40, 100)];
    expect(assignSlots(drones, slots)).toEqual([1, 2, 0]);
  });

  it('marks take-off and waypoints (or only the last one) as sync points', () => {
    const p = plan([{ id: newItemId(), type: 'takeoff', alt: 30 }, { id: newItemId(), type: 'speed', speed: 5 }, wp(at(0, 100)), wp(at(0, 200)), { id: newItemId(), type: 'rtl' }]);
    expect(swarmSyncPoints(p, { waypoints: true, landing: false })).toEqual([0, 2, 3]);
    expect(swarmSyncPoints(p, { waypoints: false, landing: true })).toEqual([0, 3]);
    expect(swarmSyncPoints(p, { waypoints: false, landing: false })).toEqual([0]);
  });

  it('matches leg speeds so that formation members reach every waypoint together', () => {
    const base = plan([{ id: newItemId(), type: 'takeoff', alt: 50 }, wp(at(0, 500)), wp(at(500, 500)), wp(at(500, 0)), { id: newItemId(), type: 'rtl' }], 10);
    const members = synchronizeLegSpeeds(formationPlans(base, 3, 'line', 40));
    const starts = members.map((m) => positioned(m)[0]!);
    // Start every member at its first waypoint: from there on, the legs must take equally long.
    const legTimes = members.map((m, k) => {
      const tl = planTimeline({ ...m, items: m.items.filter((i) => i.type !== 'takeoff') }, starts[k]!);
      const wps = m.items.flatMap((it, i) => (it.lat !== undefined ? [i - 1] : []));
      return wps.map((i) => tl.find((p) => p.item === i)!.t);
    });
    for (let leg = 1; leg < legTimes[0]!.length; leg++) {
      const times = legTimes.map((t) => t[leg]! - t[0]!);
      expect(Math.max(...times) - Math.min(...times)).toBeLessThan(0.5);
    }
    // The outer member of a right turn flies the planned 10 m/s, the inner one slower.
    const speeds = members.map((m) => m.items.filter((i) => i.type === 'speed').map((i) => i.speed!));
    expect(Math.max(...speeds.flat())).toBe(10);
    expect(Math.min(...speeds.flat())).toBeLessThan(10);
  });

  it('holds at the last sync point when the return home follows it', () => {
    const p = plan([{ id: newItemId(), type: 'takeoff', alt: 30 }, wp(at(0, 100)), wp(at(0, 200)), { id: newItemId(), type: 'camera_trigger', triggerDistanceM: 0 }, { id: newItemId(), type: 'rtl' }]);
    const held = holdAtFinalSyncPoint(p, [0, 1, 2]);
    expect(held.items[2]).toMatchObject({ type: 'loiter', unlimited: true, lat: p.items[2]!.lat, alt: 50 });
    expect(held.items[1]!.type).toBe('waypoint');
    // Not when more waypoints follow, nor for a take-off-only sync.
    expect(holdAtFinalSyncPoint(p, [0, 1]).items[1]!.type).toBe('waypoint');
    expect(holdAtFinalSyncPoint(p, [0])).toBe(p);
  });

  it('inserts barrier waits into the timelines', () => {
    const a = plan([{ id: newItemId(), type: 'takeoff', alt: 30 }, wp(at(0, 100), 30), wp(at(0, 400), 30)], 10);
    const b = plan([{ id: newItemId(), type: 'takeoff', alt: 30 }, wp(at(50, 300), 30), wp(at(50, 600), 30)], 10);
    const tracks = syncedTimelines([a, b], [at(0, 0), at(50, 0)], [[0, 1, 2], [0, 1, 2]]);
    // a reaches its first waypoint after 10 s, b after 30 s: a waits 20 s, both leave at 30 s.
    const leaveA = tracks[0]!.filter((p) => Math.round(xy(p).y) === 100).at(-1)!.t;
    const leaveB = tracks[1]!.filter((p) => Math.round(xy(p).y) === 300).at(-1)!.t;
    expect(leaveA).toBeCloseTo(leaveB, 5);
    expect(tracks[0]!.at(-1)!.t).toBeCloseTo(tracks[1]!.at(-1)!.t, 5);
  });
});

describe('separation over time', () => {
  const track = (from: { x: number; y: number }, to: { x: number; y: number }, alt: number, t1 = 10) => [
    { t: 0, ...at(from.x, from.y), alt },
    { t: t1, ...at(to.x, to.y), alt },
  ];

  it('finds the closest approach between moving drones exactly', () => {
    const crossing = separationOverTime([track({ x: 0, y: 0 }, { x: 100, y: 0 }, 30), track({ x: 50, y: -50 }, { x: 50, y: 50 }, 40)])!;
    expect(crossing.t).toBeCloseTo(5, 1);
    expect(crossing.distanceM).toBeCloseTo(10, 1);
    expect(crossing.verticalM).toBeCloseTo(10, 1);
    expect(crossing.horizontalM).toBeLessThan(0.1);
    // Parallel flight 25 m apart never gets closer.
    const parallel = separationOverTime([track({ x: 0, y: 0 }, { x: 0, y: 300 }, 30), track({ x: 25, y: 0 }, { x: 25, y: 300 }, 30)])!;
    expect(parallel.distanceM).toBeCloseTo(25, 1);
  });

  it('ignores drones standing on the ground', () => {
    expect(separationOverTime([track({ x: 0, y: 0 }, { x: 0, y: 0 }, 0), track({ x: 1, y: 0 }, { x: 1, y: 0 }, 0)])).toBeNull();
  });
});

describe('complete swarm plan', () => {
  const route = plan([{ id: newItemId(), type: 'takeoff', alt: 40 }, wp(at(0, 600), 40), wp(at(400, 600), 40), { id: newItemId(), type: 'rtl' }], 8);
  const members = [0, 1, 2].map((i) => ({ id: `d${i}`, name: `Drone ${i}`, position: destinationPoint(HOME, 90, i * 40) }));

  it('plans a formation with synchronisation and a safe separation', () => {
    const r = planSwarm(route, members, { mode: 'formation', pattern: 'line', spacingM: 30, altStepM: 5, syncWaypoints: true });
    expect(r.members).toHaveLength(3);
    expect(new Set(r.members.map((m) => m.slot))).toEqual(new Set([0, 1, 2]));
    expect(r.members.every((m) => m.plan.home!.lat === members.find((x) => x.id === m.droneId)!.position.lat)).toBe(true);
    expect(r.members.every((m) => m.syncPoints.length === 3)).toBe(true);
    expect(r.separation!.distanceM).toBeGreaterThan(10);
    expect(r.warnings).toEqual([]);
    expect(r.durationS).toBeGreaterThan(100);
  });

  it('flags a formation whose members would come too close', () => {
    const r = planSwarm(route, members, { mode: 'formation', pattern: 'line', spacingM: 3, altStepM: 0 });
    expect(r.separation!.distanceM).toBeLessThan(10);
    expect(r.warnings[0]).toMatch(/separation/);
  });

  it('returns home on separated altitude layers, so that crossing ways home stay clear', () => {
    // The formation ends north-west of the homes: the ways home cross each other.
    const cross = plan([{ id: newItemId(), type: 'takeoff', alt: 40 }, wp(at(0, 300), 40), wp(at(-300, 300), 40), { id: newItemId(), type: 'rtl' }], 8);
    const r = planSwarm(cross, members, { mode: 'formation', pattern: 'line', spacingM: 20, altStepM: 5, syncWaypoints: true, syncLanding: true });
    for (const m of r.members) {
      const items = m.plan.items;
      const [climb, over, land] = items.slice(-3);
      // Climb on the spot of the final hold, fly home at the return altitude, land there.
      expect(climb).toMatchObject({ type: 'waypoint' });
      expect(haversineDistance(climb as LatLon, items[items.length - 4] as LatLon)).toBeLessThan(0.5);
      expect(over).toMatchObject({ type: 'waypoint', alt: climb!.alt, lat: m.plan.home!.lat, lon: m.plan.home!.lon });
      expect(land).toMatchObject({ type: 'land', lat: m.plan.home!.lat, lon: m.plan.home!.lon });
      expect(items.some((it) => it.type === 'rtl')).toBe(false);
    }
    const alts = r.members.map((m) => m.plan.items.at(-3)!.alt!).sort((a, b) => a - b);
    // Above every mission altitude (40–50 m), 10 m apart.
    expect(alts).toEqual([60, 70, 80]);
    expect(r.separation!.distanceM).toBeGreaterThanOrEqual(10);
    expect(r.warnings).toEqual([]);
  });

  it('flags members that would fly above the altitude limit and keeps the return legs below it', () => {
    const high = plan([{ id: newItemId(), type: 'takeoff', alt: 100 }, wp(at(0, 600), 100), wp(at(400, 600), 100), { id: newItemId(), type: 'rtl' }], 8, 100);
    const ok = planSwarm(high, members, { mode: 'formation', pattern: 'line', spacingM: 30, altStepM: 5, syncWaypoints: true, maxAltM: 120 });
    // Slots at 100 / 105 / 110 m; returns share the 10 m left below 120 m (3.3 m apart).
    const returns = ok.members.map((m) => m.plan.items.at(-3)!.alt!).sort((a, b) => a - b);
    expect(Math.max(...returns)).toBeLessThanOrEqual(120);
    expect(new Set(returns).size).toBe(3);
    expect(ok.warnings.filter((w) => /altitude limit/.test(w))).toEqual([]);
    const tooHigh = planSwarm(high, members, { mode: 'formation', pattern: 'line', spacingM: 30, altStepM: 15, syncWaypoints: true, maxAltM: 120 });
    expect(tooHigh.warnings.some((w) => /above the 120 m altitude limit/.test(w))).toBe(true);
  });

  it('splits the route and staggers the take-off altitudes', () => {
    const r = planSwarm(route, members, { mode: 'split', altStepM: 5, syncLanding: true });
    const takeoffs = r.members.map((m) => m.plan.items[0]!.alt).sort();
    expect(takeoffs).toEqual([40, 45, 50]);
    expect(r.members.every((m) => m.syncPoints.length === 2)).toBe(true);
    expect(() => planSwarm(route, members.slice(0, 1), { mode: 'split' })).toThrow(/at least two/);
  });
});
