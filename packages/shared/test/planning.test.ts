import { describe, expect, it } from 'vitest';
import {
  AIRFRAMES,
  LocalProjection,
  airDensity,
  airframeById,
  applyTerrainFollowing,
  cameraFootprint,
  compareAirframes,
  destinationPoint,
  distancePointToSegmentM,
  enduranceEstimate,
  flownFrom,
  formationPlans,
  fromQgcPlan,
  generateCameraSurvey,
  generateCorridor,
  generateOrbit,
  generatePerimeter,
  haversineDistance,
  legKinematics,
  linearTrend,
  minSeparation,
  missionPath,
  missionStats,
  newItemId,
  normalizePlan,
  optimizeRoute,
  planOffsetsM,
  pointInPolygon,
  predictThreshold,
  rotorPower,
  routeAround,
  routeDeviation,
  simulateFlight,
  solveTour,
  splitSurvey,
  surveyParameters,
  terrainSamplePoints,
  toQgcPlan,
  windVector,
  wingPower,
  type LatLon,
  type MissionItem,
  type MissionPlan,
} from '../src';

const HOME = { lat: 25.0732, lon: 121.5355 };
const QUAD = airframeById('specter-10x')!;
const X8 = airframeById('hamburger-x8')!;
const VTOL = airframeById('athena-vtol')!;

const route = (pts: LatLon[], alt = 50, rtl = true): MissionPlan => ({
  home: { ...HOME, alt: 0 },
  items: [
    { id: newItemId(), type: 'takeoff', alt },
    ...pts.map((p): MissionItem => ({ id: newItemId(), type: 'waypoint', lat: p.lat, lon: p.lon, alt })),
    ...(rtl ? [{ id: newItemId(), type: 'rtl' as const }] : []),
  ],
  rallyPoints: [],
  geofence: null,
  defaultSpeed: 12,
  defaultAlt: alt,
});

describe('airframe physics (true-to-life models)', () => {
  it('matches the ISA density table and the temperature correction', () => {
    expect(airDensity(0)).toBeCloseTo(1.225, 3);
    expect(airDensity(1000)).toBeCloseTo(1.1117, 3);
    expect(airDensity(3000)).toBeCloseTo(0.9091, 3);
    expect(airDensity(0, 35)).toBeCloseTo(1.1455, 3);
  });

  it('computes rotor power from momentum theory (reference values computed independently)', () => {
    expect(rotorPower(QUAD, 3.1, 0, 0, 1.225).totalW).toBeCloseTo(492.7, 0);
    // translational lift: cruising costs less than hovering
    expect(rotorPower(QUAD, 3.1, 12, 0, 1.225).totalW).toBeCloseTo(359.7, 0);
    expect(rotorPower(QUAD, 3.1, 0, 3, 1.225).totalW).toBeCloseTo(601.3, 0);
    // thinner air needs more power
    expect(rotorPower(QUAD, 3.1, 0, 0, airDensity(3000)).totalW).toBeGreaterThan(rotorPower(QUAD, 3.1, 0, 0, 1.225).totalW * 1.1);
    // coaxial X8: four disks plus the interference penalty
    expect(rotorPower(X8, 11.5, 0, 0, 1.225).totalW).toBeCloseTo(2488.2, 0);
    expect(rotorPower(X8, 11.5, 0, 0, 1.225).totalW).toBeGreaterThan(rotorPower({ ...X8, coaxial: false }, 11.5, 0, 0, 1.225).totalW * 1.5);
  });

  it('computes wing-borne power from the drag polar', () => {
    expect(wingPower(VTOL, 14, 22, 0, 1.225).totalW).toBeCloseTo(509.4, 0);
    const e = enduranceEstimate(QUAD, 0);
    expect(e.hoverEnduranceS / 60).toBeCloseTo(23.4, 0);
    expect(e.cruiseRangeM / 1000).toBeCloseTo(23.2, 0);
    expect(enduranceEstimate(VTOL, 0).cruiseRangeM).toBeGreaterThan(enduranceEstimate(QUAD, 0).cruiseRangeM * 3);
  });

  it('solves the wind triangle for ground- and air-speed holding', () => {
    const head = windVector(5, 0); // wind from the north
    expect(legKinematics(0, 20, head, 'air', 30).groundSpeedMs).toBeCloseTo(15, 6);
    expect(legKinematics(0, 10, head, 'ground', 18).airspeedMs).toBeCloseTo(15, 6);
    expect(legKinematics(0, 20, windVector(5, 90), 'air', 30).groundSpeedMs).toBeCloseTo(19.3649, 3);
    // multirotor ground speed is reduced when the airspeed would exceed the maximum
    const capped = legKinematics(0, 15, windVector(8, 0), 'ground', 18);
    expect(capped.airspeedMs).toBeCloseTo(18, 6);
    expect(capped.groundSpeedMs).toBeCloseTo(10, 6);
    expect(legKinematics(0, 10, windVector(25, 0), 'air', 30).feasible).toBe(false);
  });

  it('derives the camera footprint, GSD and survey spacing', () => {
    const fp = cameraFootprint(QUAD.camera, 100);
    expect(fp.widthM).toBeCloseTo(150, 6);
    expect(fp.gsdCmPerPx).toBeCloseTo(2.741, 3);
    const p = surveyParameters(QUAD.camera, 100, 0.8, 0.7);
    expect(p.lineSpacingM).toBeCloseTo(45, 6);
    expect(p.triggerDistanceM).toBeCloseTo(20, 6);
  });
});

describe('pre-flight mission simulation', () => {
  const out = destinationPoint(HOME, 90, 2000);

  it('predicts time, energy and battery for a feasible mission', () => {
    const r = simulateFlight(route([out]), { airframe: QUAD, payloadKg: 0.5 });
    expect(r.feasible).toBe(true);
    // 10 s climb + 2 × 2000 m at 12 m/s + descent ≈ 360 s
    expect(r.durationS).toBeGreaterThan(330);
    expect(r.durationS).toBeLessThan(400);
    // ≈ 333 s cruising at ≈ 360 W plus climb / descent ≈ 35–45 Wh
    expect(r.energyWh).toBeGreaterThan(33);
    expect(r.energyWh).toBeLessThan(48);
    expect(r.endSocPct).toBeGreaterThan(70);
    expect(r.samples.at(-1)!.altRel).toBe(0);
    expect(r.legs.map((l) => l.phase)).toEqual(['takeoff', 'cruise', 'cruise', 'landing']);
  });

  it('accounts for wind, payload, temperature and battery limits', () => {
    const calm = simulateFlight(route([out]), { airframe: QUAD });
    const windy = simulateFlight(route([out]), { airframe: QUAD, wind: { speedMs: 8, fromDeg: 90 } });
    expect(windy.energyWh).toBeGreaterThan(calm.energyWh);
    expect(windy.legs[1]!.tailwindMs).toBeLessThan(0);
    expect(windy.legs[2]!.tailwindMs).toBeGreaterThan(0);
    const storm = simulateFlight(route([out]), { airframe: QUAD, wind: { speedMs: 14, fromDeg: 0 } });
    expect(storm.issues.map((i) => i.code)).toContain('wind_over_limit');
    const heavy = simulateFlight(route([out]), { airframe: QUAD, payloadKg: 3 });
    expect(heavy.feasible).toBe(false);
    expect(heavy.issues.map((i) => i.code)).toContain('payload_over_limit');
    const hot = simulateFlight(route([out]), { airframe: QUAD, temperatureC: 40, homeElevationM: 2500 });
    expect(hot.energyWh).toBeGreaterThan(calm.energyWh);
    // Specter cruise range ≈ 23 km: 2 × 20 km is beyond it, easy for the VTOL
    const far = destinationPoint(HOME, 90, 20_000);
    const long = simulateFlight(route([far]), { airframe: QUAD });
    expect(long.issues.map((i) => i.code)).toContain('battery_depleted');
    expect(simulateFlight(route([far]), { airframe: VTOL }).feasible).toBe(true);
  });

  it('flags terrain collisions along a leg', () => {
    const ridge = destinationPoint(HOME, 90, 1000);
    const groundAt = (p: LatLon) => (haversineDistance(p, ridge) < 150 ? 120 : 10);
    const r = simulateFlight(route([out], 50), { airframe: QUAD, homeElevationM: 10, groundAt });
    expect(r.issues.map((i) => i.code)).toContain('terrain_collision');
    expect(r.minAglM!).toBeLessThan(0);
  });

  it('benchmarks airframes on the same mission', () => {
    const rows = compareAirframes(route([destinationPoint(HOME, 90, 8000)]), AIRFRAMES, { payloadKg: 1 });
    expect(rows).toHaveLength(AIRFRAMES.length);
    const vtol = rows.find((r) => r.airframeId === 'athena-vtol')!;
    const quad = rows.find((r) => r.airframeId === 'specter-10x')!;
    expect(vtol.durationS).toBeLessThan(quad.durationS);
  });
});

describe('automatic waypoint generation', () => {
  it('generates an orbit / multi-layer structure scan facing the centre', () => {
    const items = generateOrbit({ center: HOME, radiusM: 50, alt: 30, points: 12, layers: 3, layerStepM: 15 });
    expect(items).toHaveLength(3 * 13);
    for (const it of items) expect(haversineDistance(HOME, it as LatLon)).toBeCloseTo(50, 0);
    expect(items.map((i) => i.alt)).toContain(60);
    const first = items[0]!;
    const bearingToCenter = (Math.atan2(HOME.lon - first.lon!, HOME.lat - first.lat!) * 180) / Math.PI;
    expect(Math.abs((((first.yawDeg! - bearingToCenter) % 360) + 540) % 360 - 180)).toBeLessThan(1);
  });

  it('generates corridor passes offset from the centre line', () => {
    const line = [HOME, destinationPoint(HOME, 45, 1000), destinationPoint(HOME, 60, 2000)];
    const items = generateCorridor({ line, widthM: 60, spacingM: 30, alt: 40 });
    expect(items).toHaveLength(9);
    const d = (p: MissionItem) => Math.min(distancePointToSegmentM(p as LatLon, line[0]!, line[1]!), distancePointToSegmentM(p as LatLon, line[1]!, line[2]!));
    expect(d(items[0]!)).toBeCloseTo(30, 0);
    expect(d(items[3]!)).toBeCloseTo(0, 0);
  });

  it('generates a perimeter outside the area', () => {
    const square = [0, 90, 180, 270].map((b) => destinationPoint(HOME, b + 45, 141.42));
    const items = generatePerimeter({ polygon: square, offsetM: 20, alt: 30, spacingM: 50 });
    expect(items.length).toBeGreaterThanOrEqual(16);
    for (const it of items) expect(pointInPolygon(it as LatLon, square)).toBe(false);
    expect(haversineDistance(items[0] as LatLon, items.at(-1) as LatLon)).toBeLessThan(1);
  });

  it('derives the survey grid and camera triggering from the camera model', () => {
    const area = [0, 90, 180, 270].map((b) => destinationPoint(HOME, b + 45, 300));
    const s = generateCameraSurvey({ polygon: area, camera: QUAD.camera, gsdCmPerPx: 2, frontOverlap: 0.75, sideOverlap: 0.65, angleDeg: 0 });
    expect(s.alt).toBeCloseTo(73, 0);
    expect(s.gsdCmPerPx).toBeCloseTo(2, 2);
    expect(s.items.filter((i) => i.type === 'camera_trigger').map((i) => i.triggerDistanceM)).toEqual([s.triggerDistanceM, 0]);
    const plan = route([]);
    plan.items.splice(1, 0, ...s.items);
    expect(missionStats(plan).photoCount).toBeGreaterThan(50);
    // round trip through QGroundControl keeps yaw and camera triggering
    const back = fromQgcPlan(JSON.parse(JSON.stringify(toQgcPlan({ ...plan, items: [...plan.items, { id: 'y', type: 'waypoint', lat: HOME.lat, lon: HOME.lon, alt: 20, yawDeg: 135 }] }))));
    expect(back.items.find((i) => i.type === 'camera_trigger')!.triggerDistanceM).toBeCloseTo(s.triggerDistanceM, 5);
    expect(back.items.at(-1)!.yawDeg).toBe(135);
  });
});

describe('route optimisation', () => {
  const east = destinationPoint(HOME, 90, 2000);
  const zoneCenter = destinationPoint(HOME, 90, 1000);

  it('re-routes legs around restricted airspace with the requested margin', () => {
    const zones = [{ name: 'Hospital', type: 'restricted' as const, geometry: { kind: 'circle' as const, center: zoneCenter, radiusM: 300 }, floorM: 0, ceilingM: 500 }];
    const { plan, report } = optimizeRoute(route([east]), { zones, bufferM: 30 });
    expect(report.detours).toHaveLength(2); // outbound leg and RTL leg
    expect(report.detours[0]!.around).toEqual(['Hospital']);
    expect(report.distanceAfterM).toBeGreaterThan(report.distanceBeforeM);
    const pts: LatLon[] = [HOME, ...plan.items.filter((i) => i.lat !== undefined).map((i) => i as LatLon), HOME];
    for (let i = 0; i + 1 < pts.length; i++) expect(distancePointToSegmentM(zoneCenter, pts[i]!, pts[i + 1]!)).toBeGreaterThan(320);
    // the detour is close to optimal: tangent path ≈ 2·sqrt(1000² − 330²) + arc
    expect(report.detours[0]!.extraDistanceM).toBeLessThan(250);
  });

  it('ignores zones above the flight and reports unavoidable ones', () => {
    const high = [{ name: 'High', type: 'restricted' as const, geometry: { kind: 'circle' as const, center: zoneCenter, radiusM: 300 }, floorM: 150, ceilingM: 500 }];
    expect(optimizeRoute(route([east]), { zones: high }).report.detours).toHaveLength(0);
    const onTarget = [{ name: 'Target', type: 'prohibited' as const, geometry: { kind: 'circle' as const, center: east, radiusM: 200 }, floorM: 0, ceilingM: 500 }];
    expect(optimizeRoute(route([east]), { zones: onTarget }).report.unresolved[0]).toMatch(/Target/);
    // controlled airspace needs an authorisation, it is not avoided
    const ctr = [{ name: 'CTR', type: 'controlled' as const, geometry: { kind: 'circle' as const, center: zoneCenter, radiusM: 300 }, floorM: 0, ceilingM: 500 }];
    expect(optimizeRoute(route([east]), { zones: ctr }).report.detours).toHaveLength(0);
  });

  it('routes around polygons with the visibility graph', () => {
    const proj = new LocalProjection(zoneCenter);
    const square = [[-200, -200], [200, -200], [200, 200], [-200, 200]].map(([x, y]) => proj.toLatLon(x!, y!));
    const r = routeAround(HOME, east, [{ name: 'Square', ring: square }]);
    expect(r.ok).toBe(true);
    expect(r.points).toHaveLength(2);
    expect(r.around).toEqual(['Square']);
  });

  it('reorders waypoints into a short tour (TSP) and keeps RTL last', () => {
    const ring = [0, 180, 45, 225, 90, 270, 135, 315].map((b) => destinationPoint(HOME, b, 1000));
    const { plan, report } = optimizeRoute(route(ring), { reorder: true });
    expect(report.reordered).toBe(true);
    expect(report.distanceAfterM).toBeLessThan(report.distanceBeforeM * 0.6);
    // optimal: 1 km out + 7 octagon edges + 1 km back
    expect(report.distanceAfterM).toBeLessThan(2000 + 7 * 765.4 + 20);
    expect(plan.items[0]!.type).toBe('takeoff');
    expect(plan.items.at(-1)!.type).toBe('rtl');
    expect(plan.items.filter((i) => i.type === 'waypoint')).toHaveLength(8);
  });

  it('keeps camera-triggered survey spans intact when reordering', () => {
    const area = [0, 90, 180, 270].map((b) => destinationPoint(destinationPoint(HOME, 90, 1500), b + 45, 200));
    const survey = generateCameraSurvey({ polygon: area, camera: QUAD.camera, alt: 60, frontOverlap: 0.7, sideOverlap: 0.6, angleDeg: 0 });
    const far = destinationPoint(HOME, 270, 1200);
    const near = destinationPoint(HOME, 90, 600);
    const plan = route([]);
    plan.items.splice(1, 0, { id: 'far', type: 'waypoint', lat: far.lat, lon: far.lon, alt: 60 }, ...survey.items, { id: 'near', type: 'waypoint', lat: near.lat, lon: near.lon, alt: 60 });
    const { plan: out, report } = optimizeRoute(plan, { reorder: true });
    const ids = (p: MissionPlan) => p.items.filter((i) => survey.items.some((s) => s.id === i.id)).map((i) => i.id);
    expect(ids(out)).toEqual(survey.items.map((i) => i.id));
    expect(report.reordered).toBe(true);
    // the near inspection point is now flown before the survey, the far one after it
    const order = out.items.map((i) => i.id);
    expect(order.indexOf('near')).toBeLessThan(order.indexOf(survey.items[0]!.id));
    expect(order.indexOf('far')).toBeGreaterThan(order.indexOf(survey.items.at(-1)!.id));
  });

  it('uses airframe energy under wind as the tour cost', () => {
    const pts = [destinationPoint(HOME, 0, 1500), destinationPoint(HOME, 90, 1500), destinationPoint(HOME, 180, 1500)];
    const r = optimizeRoute(route(pts), { reorder: true, airframe: QUAD, wind: { speedMs: 10, fromDeg: 0 } });
    expect(r.report.costUnit).toBe('Wh');
    expect(r.report.costAfter).toBeLessThanOrEqual(r.report.costBefore);
    // asymmetric costs: 1→2 is expensive, 2→1 cheap
    const cost = (i: number, j: number) => [[0, 1, 1], [1, 0, 9], [1, 1, 0]][i]![j]!;
    expect(solveTour(3, cost, false)).toEqual([2, 1]);
  });

  it('follows the terrain: endpoints raised and summit waypoints inserted above ridges', () => {
    const plan = route([east], 40);
    const ridgeAt = destinationPoint(HOME, 90, 1200);
    const ground = (p: LatLon) => 20 + Math.max(0, 150 - haversineDistance(p, ridgeAt) * 0.5);
    const samples = terrainSamplePoints(plan, 20);
    const res = applyTerrainFollowing(plan, samples, samples.map(ground), { homeElevationM: 20, minClearanceM: 30, maxAltM: 400 });
    expect(res.inserted).toBeGreaterThanOrEqual(1);
    expect(res.violations).toEqual([]);
    // every terrain sample of the new route (same 20 m sampling) keeps ≥ 30 m clearance
    const check = terrainSamplePoints(res.plan, 20);
    const pos = [{ ...HOME, alt: 40 }, ...res.plan.items.filter((i) => i.type === 'waypoint').map((i) => ({ lat: i.lat!, lon: i.lon!, alt: i.alt! })), { ...HOME, alt: 0 }];
    let minClearance = Infinity;
    for (const s of check) {
      const a = pos[s.leg]!;
      const b = pos[s.leg + 1]!;
      const alt = s.leg === pos.length - 2 ? a.alt : a.alt + (b.alt - a.alt) * s.f;
      minClearance = Math.min(minClearance, alt + 20 - ground(s));
    }
    expect(minClearance).toBeGreaterThanOrEqual(30 - 0.5);
    // the original 40 m route would have hit the ridge
    expect(Math.max(...samples.map(ground)) - 20).toBeGreaterThan(40);
    const capped = applyTerrainFollowing(plan, samples, samples.map(ground), { homeElevationM: 20, minClearanceM: 30, maxAltM: 120 });
    expect(capped.violations.length).toBeGreaterThan(0);
  });
});

describe('swarm planning', () => {
  it('splits a survey between drones and finds the closest pair', () => {
    const area = [0, 90, 180, 270].map((b) => destinationPoint(HOME, b + 45, 400));
    const plans = splitSurvey(area, 3, { spacingM: 40, angleDeg: 0, alt: 60 }, HOME);
    const total = plans.reduce((s, p) => s + p.items.filter((i) => i.type === 'waypoint').length, 0);
    expect(total).toBe(2 * Math.round(565.7 / 40));
    expect(plans.every((p) => p.items[0]!.type === 'takeoff' && p.items.at(-1)!.type === 'rtl')).toBe(true);
    const sep = minSeparation([{ ...HOME, alt: 30 }, { ...destinationPoint(HOME, 0, 100), alt: 30 }, { ...destinationPoint(HOME, 0, 8), alt: 36 }]);
    expect(sep).toMatchObject({ a: 0, b: 2 });
    expect(sep!.horizontalM).toBeCloseTo(8, 1);
  });
});

describe('route deviation and trend prediction', () => {
  const planned = [{ ...HOME, alt: 0 }, { ...HOME, alt: 50 }, { ...destinationPoint(HOME, 90, 1000), alt: 50 }];
  const track = (offsetM: number) =>
    Array.from({ length: 101 }, (_, i) => ({ t: i * 1000, ...destinationPoint(destinationPoint(HOME, 90, i * 10), 0, offsetM), altRel: 50 }));

  it('measures cross-track error, time outside tolerance and coverage', () => {
    const near = routeDeviation(planned, track(5), 10)!;
    expect(near.meanM).toBeCloseTo(5, 0);
    expect(near.outsidePct).toBe(0);
    expect(near.coveragePct).toBeGreaterThan(95);
    const off = routeDeviation(planned, track(15), 10)!;
    expect(off.outsidePct).toBe(100);
    expect(off.maxM).toBeCloseTo(15, 0);
    expect(off.coveragePct).toBe(0);
  });

  it('ignores the take-off climb and final descent in the altitude deviation', () => {
    // Climb from 2 m to 50 m at home, cruise at 50 m (one sample 8 m too high), descend at the end.
    const pts = [
      ...Array.from({ length: 10 }, (_, i) => ({ t: i * 1000, ...HOME, altRel: 2 + i * 5 })),
      ...Array.from({ length: 101 }, (_, i) => ({ t: 10_000 + i * 1000, ...destinationPoint(HOME, 90, i * 10), altRel: i === 50 ? 58 : 50 })),
      ...Array.from({ length: 10 }, (_, i) => ({ t: 111_000 + i * 1000, ...destinationPoint(HOME, 90, 1000), altRel: 50 - i * 5 })),
    ];
    const r = routeDeviation(planned, pts, 10)!;
    expect(r.maxAltDevM).toBeCloseTo(8, 5);
    expect(r.meanM).toBeLessThan(1);
    // Never at the planned altitude: every sample counts.
    const low = routeDeviation(planned, track(0).map((p) => ({ ...p, altRel: 20 })), 10)!;
    expect(low.maxAltDevM).toBeCloseTo(30, 5);
  });

  it('does not count the return home at its own altitude as an altitude deviation', () => {
    // Mission at 20 m; the drone returns at its 30 m RTL altitude and lands through 20 m at home.
    const out = destinationPoint(HOME, 90, 1000);
    const path = [{ ...HOME, alt: 0 }, { ...HOME, alt: 20 }, { ...out, alt: 20 }, { ...HOME, alt: 20 }, { ...HOME, alt: 0 }];
    const pts = [
      ...Array.from({ length: 5 }, (_, i) => ({ t: i * 1000, ...HOME, altRel: 4 + i * 4 })),
      ...Array.from({ length: 101 }, (_, i) => ({ t: 10_000 + i * 1000, ...destinationPoint(HOME, 90, i * 10), altRel: 20 })),
      ...Array.from({ length: 101 }, (_, i) => ({ t: 111_000 + i * 1000, ...destinationPoint(HOME, 90, 1000 - i * 10), altRel: 30 })),
      ...Array.from({ length: 10 }, (_, i) => ({ t: 212_000 + i * 1000, ...HOME, altRel: 30 - i * 3 })),
    ];
    expect(routeDeviation(path, pts, 10)!.maxAltDevM).toBeCloseTo(10, 0);
    const r = routeDeviation(path, pts, 10, 2, { altSkipLastSegments: 1 })!;
    // The climb-out at home is within the take-off climb.
    expect(r.maxAltDevM).toBeLessThanOrEqual(4);
    expect(r.meanM).toBeLessThan(1);
    expect(r.coveragePct).toBeGreaterThan(95);
  });

  it('counts an altitude error that lasts to the end of the route, or from its start', () => {
    // Climb at home to 30 m, cruise to A at 30 m; the route then climbs to 60 m at B – flown at 30 m.
    const a = destinationPoint(HOME, 90, 500);
    const b = destinationPoint(HOME, 90, 1000);
    const climbHome = (to: number) => Array.from({ length: 6 }, (_, i) => ({ t: i * 1000, ...HOME, altRel: 5 + (i * (to - 5)) / 5 }));
    const cruise = (alt: number) => Array.from({ length: 101 }, (_, i) => ({ t: 6_000 + i * 1000, ...destinationPoint(HOME, 90, i * 10), altRel: alt }));
    const descendAtB = Array.from({ length: 6 }, (_, i) => ({ t: 108_000 + i * 1000, ...b, altRel: 30 - i * 5 }));
    const late = routeDeviation([{ ...HOME, alt: 0 }, { ...HOME, alt: 30 }, { ...a, alt: 30 }, { ...b, alt: 60 }], [...climbHome(30), ...cruise(30), ...descendAtB], 10)!;
    expect(late.maxAltDevM).toBeGreaterThan(29);
    expect(late.worstAlt!.lon).toBeCloseTo(b.lon, 3);
    expect(late.coveragePct).toBeGreaterThan(95);
    // The route starts at 60 m and descends to 30 m at B; the drone flies all of it at 30 m.
    const early = routeDeviation([{ ...HOME, alt: 0 }, { ...HOME, alt: 60 }, { ...a, alt: 60 }, { ...b, alt: 30 }], [...climbHome(30), ...cruise(30), ...descendAtB], 10)!;
    expect(early.maxAltDevM).toBeGreaterThan(29);
    // A manual climb at the start before the mission begins and the landing at its end are not deviations.
    const manual = [
      ...Array.from({ length: 10 }, (_, i) => ({ t: i * 1000, ...HOME, altRel: 5 + i * 8 })), // up to 77 m at home
      ...Array.from({ length: 101 }, (_, i) => ({ t: 10_000 + i * 1000, ...destinationPoint(HOME, 90, i * 10), altRel: i < 3 ? 77 - i * 9 : 50 })),
      ...Array.from({ length: 10 }, (_, i) => ({ t: 111_000 + i * 1000, ...b, altRel: 50 - i * 5 })),
    ];
    expect(routeDeviation([{ ...HOME, alt: 0 }, { ...HOME, alt: 50 }, { ...b, alt: 50 }], manual, 10)!.maxAltDevM).toBeLessThan(10);
  });

  it('follows a climb in place: the leg before it keeps its own altitude', () => {
    // Out at 25 m, hold at the far end, climb there to 60 m (swarm return level), fly home at 60 m.
    const out = destinationPoint(HOME, 90, 600);
    const path = [{ ...HOME, alt: 0 }, { ...HOME, alt: 25 }, { ...out, alt: 25 }, { ...out, alt: 60 }, { ...HOME, alt: 60 }, { ...HOME, alt: 0 }];
    const pts = [
      ...Array.from({ length: 5 }, (_, i) => ({ t: i * 1000, ...HOME, altRel: 5 + i * 5 })),
      ...Array.from({ length: 61 }, (_, i) => ({ t: 10_000 + i * 1000, ...destinationPoint(HOME, 90, i * 10), altRel: 25 })),
      ...Array.from({ length: 8 }, (_, i) => ({ t: 71_000 + i * 1000, ...out, altRel: 25 + i * 5 })),
      ...Array.from({ length: 61 }, (_, i) => ({ t: 80_000 + i * 1000, ...destinationPoint(HOME, 90, 600 - i * 10), altRel: i === 30 ? 67 : 60 })),
      ...Array.from({ length: 12 }, (_, i) => ({ t: 141_000 + i * 1000, ...HOME, altRel: 60 - i * 5 })),
    ];
    const r = routeDeviation(path, pts, 10)!;
    // Only the one sample 7 m above the return leg counts – not 35 m on the way out.
    expect(r.maxAltDevM).toBeCloseTo(7, 5);
    expect(r.meanM).toBeLessThan(1);
    expect(r.coveragePct).toBeGreaterThan(95);
  });

  it('starts the route of a mission started in the air where it was started, and returns it home', () => {
    const p = destinationPoint(HOME, 270, 150);
    const wp = destinationPoint(p, 0, 100);
    const base = { home: { ...HOME, alt: 0 }, items: [{ id: 't', type: 'takeoff' as const, alt: 20 }, { id: 'w', type: 'waypoint' as const, ...wp, alt: 20 }, { id: 'r', type: 'rtl' as const }], rallyPoints: [], defaultSpeed: 8, defaultAlt: 20 };
    const path = missionPath(flownFrom(base, HOME, { ...p, alt: 30 }));
    // From P at 30 m (above the 20 m take-off altitude: no descent), to the waypoint, back home.
    expect(path[0]).toMatchObject({ lat: p.lat, lon: p.lon, alt: 30 });
    expect(path[1]).toMatchObject({ lat: p.lat, lon: p.lon, alt: 30 });
    expect(path.at(-1)).toMatchObject({ lat: HOME.lat, lon: HOME.lon, alt: 0 });
    // The start survives storing the plan with the flight.
    expect(normalizePlan(JSON.parse(JSON.stringify(flownFrom(base, HOME, { ...p, alt: 30 })))).start).toEqual({ lat: p.lat, lon: p.lon, alt: 30 });
  });

  it('fits trends and predicts when a threshold is reached', () => {
    const pts = Array.from({ length: 10 }, (_, i) => ({ x: i * 2, y: 0.05 + i * 0.01 }));
    const t = linearTrend(pts)!;
    expect(t.slope).toBeCloseTo(0.005, 6);
    expect(t.r2).toBeCloseTo(1, 6);
    const p = predictThreshold(pts, 0.25, 'up')!;
    expect(p.crossingX).toBeCloseTo(40, 6);
    expect(p.remaining).toBeCloseTo(22, 6);
    expect(predictThreshold(pts, 0.1, 'up')!.exceeded).toBe(true);
    expect(predictThreshold(pts, 0, 'down')!.crossingX).toBeNull();
    // The outlook says why there is (no) prediction.
    expect(p.outlook).toBe('towards');
    expect(predictThreshold(pts, 0.1, 'up')!.outlook).toBe('exceeded');
    expect(predictThreshold(pts, 0, 'down')!.outlook).toBe('away');
    expect(predictThreshold(pts, 5, 'up')!.outlook).toBe('beyond');
    const noisy = Array.from({ length: 10 }, (_, i) => ({ x: i, y: 1 + (i % 2 ? 0.5 : -0.5) + i * 0.01 }));
    expect(predictThreshold(noisy, 3, 'up')).toMatchObject({ outlook: 'unclear', remaining: null });
  });
});
