import { describe, expect, it } from 'vitest';
import { destinationPoint, haversineDistance, pointInPolygon } from '../src/geo';
import {
  emptyPlan,
  fromQgcPlan,
  fromWpl,
  generateSurvey,
  missionPath,
  missionStats,
  normalizePlan,
  toQgcPlan,
  toWpl,
  validateMission,
  type MissionPlan,
} from '../src/mission';

const HOME = { lat: 47.3977, lon: 8.5456, alt: 488 };

function samplePlan(): MissionPlan {
  const wp1 = destinationPoint(HOME, 0, 400);
  const wp2 = destinationPoint(HOME, 90, 300);
  return {
    ...emptyPlan(),
    home: HOME,
    defaultSpeed: 10,
    items: [
      { id: 'a', type: 'takeoff', alt: 30 },
      { id: 'b', type: 'waypoint', lat: wp1.lat, lon: wp1.lon, alt: 50 },
      { id: 'c', type: 'speed', speed: 5 },
      { id: 'd', type: 'loiter', lat: wp2.lat, lon: wp2.lon, alt: 50, holdS: 20 },
      { id: 'e', type: 'photo' },
      { id: 'f', type: 'rtl' },
    ],
    rallyPoints: [{ ...destinationPoint(HOME, 180, 200), alt: 30 }],
  };
}

describe('mission path & stats', () => {
  it('builds the 3D path including RTL descent', () => {
    const path = missionPath(samplePlan());
    expect(path[0]).toMatchObject({ lat: HOME.lat, lon: HOME.lon, alt: 0 });
    expect(path[1]!.alt).toBe(30);
    expect(path.at(-1)).toMatchObject({ lat: HOME.lat, lon: HOME.lon, alt: 0 });
    expect(path).toHaveLength(6);
  });

  it('computes distance, time and battery estimate', () => {
    const plan = samplePlan();
    const s = missionStats(plan, { enduranceS: 1000 });
    const leg1 = 400;
    const leg2 = haversineDistance(destinationPoint(HOME, 0, 400), destinationPoint(HOME, 90, 300));
    const leg3 = 300;
    expect(s.horizontalDistanceM).toBeCloseTo(leg1 + leg2 + leg3, 0);
    expect(s.waypointCount).toBe(2);
    expect(s.photoCount).toBe(1);
    expect(s.maxAltM).toBe(50);
    // takeoff 30m@3m/s=10s, leg1 400m@10m/s=40s, leg2 @5m/s, hold 20s, rtl leg 300@5=60, descent 50@2=25
    const expected = 10 + 40 + leg2 / 5 + 20 + 60 + 25;
    expect(s.estimatedTimeS).toBeCloseTo(expected, 0);
    expect(s.estimatedBatteryPct).toBeCloseTo((expected / 1000) * 100, 0);
  });
});

describe('mission validation', () => {
  it('accepts a sane plan', () => {
    expect(validateMission(samplePlan()).filter((i) => i.level === 'error')).toEqual([]);
  });

  it('flags altitude above the legal limit, missing takeoff and items after RTL', () => {
    const plan = samplePlan();
    plan.items = [plan.items[1]!, { id: 'x', type: 'rtl' }, { id: 'y', type: 'waypoint', lat: 47.4, lon: 8.55, alt: 200 }];
    const issues = validateMission(plan, { maxAltitude: 120 });
    expect(issues.some((i) => /takeoff/.test(i.message))).toBe(true);
    expect(issues.some((i) => /exceeds the 120 m limit/.test(i.message))).toBe(true);
    expect(issues.some((i) => /will not be executed/.test(i.message))).toBe(true);
  });

  it('detects geofence breaches', () => {
    const plan = samplePlan();
    plan.geofence = {
      polygon: [
        destinationPoint(HOME, 225, 150),
        destinationPoint(HOME, 135, 150),
        destinationPoint(HOME, 45, 150),
        destinationPoint(HOME, 315, 150),
      ],
      maxAlt: 40,
      action: 'rtl',
    };
    const errors = validateMission(plan).filter((i) => i.level === 'error');
    expect(errors.some((e) => /outside the geofence/.test(e.message))).toBe(true);
    expect(errors.some((e) => /ceiling/.test(e.message))).toBe(true);
  });

  it('normalizePlan rejects unknown item types and bad coordinates', () => {
    expect(() => normalizePlan({ items: [{ type: 'teleport' }] })).toThrow(/unknown type/);
    expect(() => normalizePlan({ items: [{ type: 'waypoint', lat: 95, lon: 0 }] })).toThrow(/invalid coordinates/);
    const p = normalizePlan({ items: [{ type: 'waypoint', lat: 1, lon: 2, alt: 30 }], defaultSpeed: 999 });
    expect(p.defaultSpeed).toBe(30);
    expect(p.items[0]!.id).toBeTruthy();
  });
});

describe('survey generator', () => {
  it('covers a rectangle with alternating lines inside the area', () => {
    const poly = [
      HOME,
      destinationPoint(HOME, 90, 400),
      destinationPoint(destinationPoint(HOME, 90, 400), 0, 200),
      destinationPoint(HOME, 0, 200),
    ];
    const items = generateSurvey(poly, { spacingM: 50, angleDeg: 90, alt: 60 });
    // 200 m tall area, 50 m spacing -> 4 east-west lines, 2 waypoints each
    expect(items).toHaveLength(8);
    for (const it of items) {
      expect(it.alt).toBe(60);
      const inside = pointInPolygon({ lat: it.lat!, lon: it.lon! }, poly);
      expect(inside).toBe(true);
    }
    // consecutive lines alternate direction (lawn-mower)
    expect(items[1]!.lon!).toBeGreaterThan(items[0]!.lon!);
    expect(items[3]!.lon!).toBeLessThan(items[2]!.lon!);
    // line length ≈ 400 m
    expect(haversineDistance(items[0] as any, items[1] as any)).toBeCloseTo(400, -1);
  });
});

describe('QGroundControl / WPL interchange', () => {
  it('round-trips a plan through .plan JSON', () => {
    const plan = samplePlan();
    plan.geofence = { polygon: [HOME, destinationPoint(HOME, 90, 500), destinationPoint(HOME, 0, 500)], maxAlt: null, action: 'rtl' };
    const json = JSON.parse(JSON.stringify(toQgcPlan(plan)));
    expect(json.fileType).toBe('Plan');
    expect(json.mission.items).toHaveLength(6);
    expect(json.mission.items[1].command).toBe(16);
    const back = fromQgcPlan(json);
    expect(back.items.map((i) => i.type)).toEqual(['takeoff', 'waypoint', 'speed', 'loiter', 'photo', 'rtl']);
    expect(back.items[1]!.lat).toBeCloseTo(plan.items[1]!.lat!, 7);
    expect(back.items[3]!.holdS).toBe(20);
    expect(back.items[2]!.speed).toBe(5);
    expect(back.home).toEqual(HOME);
    expect(back.rallyPoints).toHaveLength(1);
    expect(back.geofence?.polygon).toHaveLength(3);
  });

  it('round-trips through QGC WPL 110 text', () => {
    const plan = samplePlan();
    const text = toWpl(plan);
    expect(text.startsWith('QGC WPL 110\n0\t1\t0\t16')).toBe(true);
    const back = fromWpl(text);
    expect(back.home).toEqual(HOME);
    expect(back.items.map((i) => i.type)).toEqual(['takeoff', 'waypoint', 'speed', 'loiter', 'photo', 'rtl']);
    expect(back.items[0]!.alt).toBe(30);
    expect(() => fromWpl('hello')).toThrow();
  });
});
