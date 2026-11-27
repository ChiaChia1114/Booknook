/**
 * The planning computations, run in a worker thread of their own (see planner.ts): pure functions
 * of what a request brought and what the cloud looked up for it (terrain, weather). A long one – a
 * route of hundreds of waypoints reordered, a survey of a large area, a long mission simulated with
 * every airframe – never holds up the live connections or anyone's requests.
 */
import {
  AIRFRAMES,
  DEFAULT_AIRFRAME_ID,
  airframeById,
  applyTerrainFollowing,
  compareAirframes,
  fromQgcPlan,
  fromWpl,
  generateCameraSurvey,
  generateCorridor,
  generateOrbit,
  generatePerimeter,
  generateSurvey,
  isValidLatLon,
  normalizePlan,
  optimizeRoute,
  planSwarm,
  simulateFlight,
  validateMission,
  type Airframe,
  type GroundLookup,
  type LatLon,
  type MissionPlan,
  type ObstacleZone,
  type RouteTerrainSample,
  type SimulationResult,
  type SwarmMemberInput,
  type SwarmPlanOptions,
} from '@athena-sky/shared';
import type { ZoneType } from '@athena-sky/shared';
import { parseZoneFeatures } from '../airspace/geojson';
import { zonePoints } from '../airspace/geometry';
import { parseFeed } from '../airspace/providers';

/** A request the computation refuses (told the caller as it is: status, code, message). */
export class TaskError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const invalid = (message: string) => new TaskError(400, 'bad_request', message);

/** Terrain along a route: positions and their elevations (null: not known). */
export interface Ground {
  points: LatLon[];
  elevations: (number | null)[];
}

/** Nearest-sample terrain lookup over the elevations fetched along a route (≈ 33 m cells). */
export function groundLookup(points: LatLon[], elevations: (number | null)[]): GroundLookup {
  const cell = 0.0003;
  const grid = new Map<string, { lat: number; lon: number; e: number }[]>();
  points.forEach((p, i) => {
    const e = elevations[i];
    if (e === null || e === undefined) return;
    const key = `${Math.floor(p.lat / cell)},${Math.floor(p.lon / cell)}`;
    const list = grid.get(key) ?? [];
    list.push({ lat: p.lat, lon: p.lon, e });
    grid.set(key, list);
  });
  return (p) => {
    const cy = Math.floor(p.lat / cell);
    const cx = Math.floor(p.lon / cell);
    let best: { d: number; e: number } | null = null;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const q of grid.get(`${cy + dy},${cx + dx}`) ?? []) {
          const d = (q.lat - p.lat) ** 2 + ((q.lon - p.lon) * Math.cos((p.lat * Math.PI) / 180)) ** 2;
          if (!best || d < best.d) best = { d, e: q.e };
        }
      }
    }
    return best && Math.sqrt(best.d) * 111_320 < 80 ? best.e : null;
  };
}

const groundAt = (g: Ground | null): GroundLookup | undefined => (g ? groundLookup(g.points, g.elevations) : undefined);

const airframe = (id: string): Airframe => {
  const af = airframeById(id);
  if (!af) throw invalid(`Unknown airframe ${id}`);
  return af;
};

const latLon = (v: unknown, what: string): LatLon => {
  const p = v as LatLon;
  if (!isValidLatLon(p)) throw invalid(`${what} must be a {lat, lon} position`);
  return { lat: p.lat, lon: p.lon };
};
const latLonList = (v: unknown, what: string, min: number): LatLon[] => {
  if (!Array.isArray(v) || v.length < min) throw invalid(`${what} needs at least ${min} positions`);
  if (v.length > 500) throw invalid(`${what} has too many positions (max 500)`);
  return v.map((p, i) => latLon(p, `${what}[${i}]`));
};
const num = (v: unknown, what: string, min: number, max: number, dflt?: number): number => {
  if (v === undefined || v === null) {
    if (dflt === undefined) throw invalid(`${what} is required`);
    return dflt;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw invalid(`${what} must be between ${min} and ${max}`);
  return n;
};

/** Conditions of a simulation (wind, temperature, payload, terrain) – no airframe. */
export interface SimConditions {
  payloadKg: number;
  wind: { speedMs: number; fromDeg: number; gustMs?: number | null } | null;
  temperatureC: number | null;
  homeElevationM: number;
  reservePct?: number;
  maxSamples?: number;
}

const summary = (r: SimulationResult) => ({
  durationS: r.durationS,
  energyWh: r.energyWh,
  endSocPct: r.endSocPct,
  minAglM: r.minAglM,
  feasible: r.feasible,
  errors: r.issues.filter((i) => i.severity === 'error').map((i) => i.message),
});

/** Waypoints of a generator: a mission holds at most MAX_MISSION_ITEMS of them (more are refused at once). */
function generated(input: { kind: string; params: Record<string, unknown> }) {
  const p = input.params;
  const alt = num(p.alt, 'alt', 1, 1000, 50);
  try {
    switch (input.kind) {
      case 'orbit':
        return {
          items: generateOrbit({
            center: latLon(p.center, 'center'),
            radiusM: num(p.radiusM, 'radiusM', 1, 5000),
            alt,
            points: num(p.points, 'points', 3, 360, 16),
            layers: num(p.layers, 'layers', 1, 50, 1),
            layerStepM: num(p.layerStepM, 'layerStepM', 0, 200, 10),
            clockwise: p.clockwise !== false,
            startBearingDeg: num(p.startBearingDeg, 'startBearingDeg', 0, 360, 0),
            faceCenter: p.faceCenter !== false,
            photos: p.photos === true,
          }),
        };
      case 'corridor':
        return { items: generateCorridor({ line: latLonList(p.line, 'line', 2), widthM: num(p.widthM, 'widthM', 0, 5000), spacingM: num(p.spacingM, 'spacingM', 1, 1000), alt }) };
      case 'perimeter':
        return {
          items: generatePerimeter({ polygon: latLonList(p.polygon, 'polygon', 3), offsetM: num(p.offsetM, 'offsetM', -1000, 1000, 0), alt, spacingM: num(p.spacingM, 'spacingM', 0, 5000, 0), faceInward: p.faceInward === true }),
        };
      case 'survey':
        return { items: generateSurvey(latLonList(p.polygon, 'polygon', 3), { spacingM: num(p.spacingM, 'spacingM', 1, 2000), angleDeg: num(p.angleDeg, 'angleDeg', -360, 360, 0), alt }) };
      case 'camera_survey': {
        const af = airframeById(String(p.airframeId ?? DEFAULT_AIRFRAME_ID));
        if (!af) throw invalid('Unknown airframe');
        const s = generateCameraSurvey({
          polygon: latLonList(p.polygon, 'polygon', 3),
          camera: af.camera,
          ...(p.gsdCmPerPx !== undefined ? { gsdCmPerPx: num(p.gsdCmPerPx, 'gsdCmPerPx', 0.1, 50) } : { alt }),
          frontOverlap: num(p.frontOverlap, 'frontOverlap', 0, 0.95, 0.75),
          sideOverlap: num(p.sideOverlap, 'sideOverlap', 0, 0.95, 0.65),
          angleDeg: num(p.angleDeg, 'angleDeg', -360, 360, 0),
        });
        if (s.alt > 1000) throw invalid('The requested GSD needs an altitude above 1000 m');
        return { items: s.items, info: { alt: s.alt, lineSpacingM: s.lineSpacingM, triggerDistanceM: s.triggerDistanceM, gsdCmPerPx: s.gsdCmPerPx, camera: af.camera.name } };
      }
    }
  } catch (err) {
    if (err instanceof TaskError) throw err;
    throw invalid((err as Error).message);
  }
  throw invalid('Unknown generator');
}

export const TASKS = {
  /**
   * Waypoints of a generator (orbit / structure scan, corridor, perimeter, survey, camera survey) –
   * as the JSON text of the answer (sent as it is: at most a mission's worth of items).
   */
  generate(input: { kind: string; params: Record<string, unknown> }) {
    return { json: JSON.stringify(generated(input)) };
  },

  /** A mission flown with an airframe model (and, with `compare`, with every airframe of the catalogue). */
  simulate(input: { plan: MissionPlan; airframeId: string; conditions: SimConditions; ground: Ground | null; compare: boolean }) {
    const opts = { ...input.conditions, groundAt: groundAt(input.ground) };
    const result = simulateFlight(input.plan, { ...opts, airframe: airframe(input.airframeId) });
    const comparison = input.compare ? compareAirframes(input.plan, AIRFRAMES, opts) : undefined;
    // As text (sent as it is, with the conditions): thousands of samples are not rebuilt in the server's thread.
    return { json: JSON.stringify({ result, comparison }) };
  },

  /** Waypoint ordering and no-fly-zone avoidance (`optimizeRoute`). */
  optimize(input: { plan: MissionPlan; reorder: boolean; zones?: ObstacleZone[]; zonesJson?: string; bufferM: number; airframeId: string; payloadKg: number; wind: SimConditions['wind'] }) {
    return optimizeRoute(input.plan, {
      reorder: input.reorder,
      // Many large zones pass between the threads as text (copied at once, read here).
      zones: input.zonesJson !== undefined ? (JSON.parse(input.zonesJson) as ObstacleZone[]) : (input.zones ?? []),
      bufferM: input.bufferM,
      airframe: airframe(input.airframeId),
      payloadKg: input.payloadKg,
      wind: input.wind,
    });
  },

  /** Altitudes raised to keep the clearance over the terrain sampled along the route. */
  terrainFollow(input: { plan: MissionPlan; samples: RouteTerrainSample[]; elevations: (number | null)[]; homeElevationM: number; minClearanceM: number; maxAltM: number }) {
    return applyTerrainFollowing(input.plan, input.samples, input.elevations, { homeElevationM: input.homeElevationM, minClearanceM: input.minClearanceM, maxAltM: input.maxAltM });
  },

  /** The missions of a swarm's drones (`planSwarm`), and what in them uploading would refuse. */
  planSwarm(input: { base: MissionPlan; members: SwarmMemberInput[]; options: SwarmPlanOptions; maxAltitude: number }) {
    let plan: ReturnType<typeof planSwarm>;
    try {
      plan = planSwarm(input.base, input.members, input.options);
    } catch (err) {
      throw invalid(`Cannot plan the swarm: ${(err as Error).message}`);
    }
    const invalidMissions = plan.members.map((m) => ({
      droneId: m.droneId,
      messages: validateMission(m.plan, { maxAltitude: input.maxAltitude })
        .filter((i) => i.level === 'error')
        .map((i) => i.message),
    }));
    // Each drone's mission as text: it passes between the threads at once and is read in a turn of
    // its own (twelve drones' missions are not rebuilt in one go).
    const { members, ...rest } = plan;
    return { ...rest, members: members.map((m) => JSON.stringify(m)), invalidMissions };
  },

  /** A QGroundControl plan (.plan) or a QGC WPL 110 waypoint file, read as a mission plan. */
  importMission(input: { format: 'plan' | 'waypoints'; content: string }) {
    let plan: MissionPlan;
    try {
      plan = input.format === 'plan' ? fromQgcPlan(input.content) : fromWpl(input.content);
    } catch (err) {
      throw invalid(`Cannot import mission: ${(err as Error).message}`);
    }
    try {
      return normalizePlan(plan);
    } catch (err) {
      throw invalid(`Invalid mission plan: ${(err as Error).message}`);
    }
  },

  /** Airspace zones of a GeoJSON FeatureCollection (an import: corridors buffered, holes covered …). */
  parseZones(input: { geojson: unknown; defaultType: ZoneType; maxFeatures: number }) {
    const { zones, skipped, warnings } = parseZoneFeatures(input.geojson, input.defaultType, input.maxFeatures);
    let points = 0;
    for (const z of zones) points += zonePoints(z.geometry);
    // Their geometry as it is stored (JSON): text passes between the threads at once.
    return { zones: zones.map(({ geometry, ...z }) => ({ ...z, geometryJson: JSON.stringify(geometry) })), points, skipped, warnings };
  },

  /** An airspace feed's bytes read (see providers.ts): each zone as JSON text. */
  parseFeed(input: { bytes: Uint8Array; maxFeatures: number; logMax: number }) {
    try {
      return parseFeed(input.bytes, input.maxFeatures, input.logMax);
    } catch (err) {
      const e = err as Error & { status?: unknown };
      // As said here (not valid JSON, too many features…): the feed's status shows it.
      throw typeof e.status === 'number' ? err : new TaskError(400, 'invalid_feed', e.message);
    }
  },

  /** The predicted effect of an optimisation: the original and the optimised plan flown alike. */
  beforeAfter(input: { original: MissionPlan; plan: MissionPlan; airframeId: string; conditions: SimConditions; before: { homeElevationM: number; ground: Ground | null }; after: { homeElevationM: number; ground: Ground | null } }) {
    const af = airframe(input.airframeId);
    const before = simulateFlight(input.original, { ...input.conditions, airframe: af, homeElevationM: input.before.homeElevationM, groundAt: groundAt(input.before.ground) });
    const after = simulateFlight(input.plan, { ...input.conditions, airframe: af, homeElevationM: input.after.homeElevationM, groundAt: groundAt(input.after.ground) });
    return { before: summary(before), after: summary(after) };
  },
};

export type TaskName = keyof typeof TASKS;
export type TaskInput<K extends TaskName> = Parameters<(typeof TASKS)[K]>[0];
export type TaskOutput<K extends TaskName> = ReturnType<(typeof TASKS)[K]>;
