/**
 * Planning services: public client configuration, airframe catalogue, automatic waypoint
 * generation, pre-flight mission simulation and route optimisation.
 */
import type { FastifyInstance } from 'fastify';
import { Type, type Static } from '@sinclair/typebox';
import { Nullable } from '../lib/schema';
import {
  AIRFRAMES,
  DEFAULT_AIRFRAME_ID,
  airframeById,
  airframeSummary,
  applyTerrainFollowing,
  compareAirframes,
  generateCameraSurvey,
  generateCorridor,
  generateOrbit,
  generatePerimeter,
  generateSurvey,
  isValidLatLon,
  normalizePlan,
  optimizeRoute,
  simulateFlight,
  terrainSamplePoints,
  type Airframe,
  type GroundLookup,
  type LatLon,
  type MissionPlan,
  type ObstacleZone,
} from '@athena-sky/shared';
import type { AppContext } from '../context';
import { orgAccess, requireAuth } from '../auth/auth';
import { badRequest, notFound } from '../lib/errors';
import { getOrgSettings } from '../orgs/org-service';

const tag = { tags: ['planning'] };
const MissionParams = Type.Object({ orgId: Type.String({ format: 'uuid' }), missionId: Type.String({ format: 'uuid' }) });
const Wind = Type.Object({ speedMs: Type.Number({ minimum: 0, maximum: 60 }), fromDeg: Type.Number({ minimum: 0, maximum: 360 }), gustMs: Type.Optional(Nullable(Type.Number({ minimum: 0, maximum: 80 }))) });
const Conditions = {
  /** Unsaved plan from the editor; the stored plan is used when omitted. */
  plan: Type.Optional(Type.Unknown()),
  airframeId: Type.Optional(Type.String({ maxLength: 60 })),
  droneId: Type.Optional(Type.String({ format: 'uuid' })),
  payloadKg: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  wind: Type.Optional(Type.Union([Wind, Type.Null()])),
  /** Use the current forecast (wind, gusts, temperature) at the home position. */
  useForecast: Type.Optional(Type.Boolean()),
  temperatureC: Type.Optional(Nullable(Type.Number({ minimum: -60, maximum: 60 }))),
};
const SimulateBody = Type.Object({
  ...Conditions,
  reservePct: Type.Optional(Type.Number({ minimum: 0, maximum: 80 })),
  /** Also benchmark every airframe of the catalogue. */
  compare: Type.Optional(Type.Boolean()),
});
const OptimizeBody = Type.Object({
  ...Conditions,
  reorder: Type.Optional(Type.Boolean()),
  avoidZones: Type.Optional(Type.Boolean()),
  bufferM: Type.Optional(Type.Number({ minimum: 0, maximum: 2000 })),
  terrainFollow: Type.Optional(Type.Boolean()),
  minClearanceM: Type.Optional(Type.Number({ minimum: 5, maximum: 500 })),
});
const GenerateBody = Type.Object({
  kind: Type.Union(['orbit', 'corridor', 'perimeter', 'survey', 'camera_survey'].map((k) => Type.Literal(k))),
  params: Type.Record(Type.String(), Type.Unknown()),
});

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

const latLon = (v: unknown, what: string): LatLon => {
  const p = v as LatLon;
  if (!isValidLatLon(p)) throw badRequest(`${what} must be a {lat, lon} position`);
  return { lat: p.lat, lon: p.lon };
};
const latLonList = (v: unknown, what: string, min: number): LatLon[] => {
  if (!Array.isArray(v) || v.length < min) throw badRequest(`${what} needs at least ${min} positions`);
  if (v.length > 500) throw badRequest(`${what} has too many positions (max 500)`);
  return v.map((p, i) => latLon(p, `${what}[${i}]`));
};
const num = (v: unknown, what: string, min: number, max: number, dflt?: number): number => {
  if (v === undefined || v === null) {
    if (dflt === undefined) throw badRequest(`${what} is required`);
    return dflt;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw badRequest(`${what} must be between ${min} and ${max}`);
  return n;
};

export function registerPlanningRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config } = ctx;

  app.get('/api/v2/config', { schema: { tags: ['meta'], summary: 'Client configuration (map services available to the web application)' } }, async (req) => {
    requireAuth(req);
    return {
      cesiumIonToken: config.cesiumIonToken,
      terrain: !!config.terrainUrl,
      weather: !!config.weatherUrl,
      airspaceFeeds: config.airspaceFeeds.length,
    };
  });

  app.get('/api/v2/airframes', { schema: { ...tag, summary: 'Airframe catalogue with flight-physics parameters and endurance' } }, async (req) => {
    requireAuth(req);
    return AIRFRAMES.map((af) => ({ ...af, summary: airframeSummary(af) }));
  });

  app.post<{ Body: Static<typeof GenerateBody> }>(
    '/api/v2/planning/generate',
    { schema: { ...tag, summary: 'Generate waypoints: orbit / structure scan, corridor, perimeter, survey, camera survey', body: GenerateBody } },
    async (req) => {
      requireAuth(req);
      const p = req.body.params;
      const alt = num(p.alt, 'alt', 1, 1000, 50);
      try {
        switch (req.body.kind) {
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
            if (!af) throw badRequest('Unknown airframe');
            const s = generateCameraSurvey({
              polygon: latLonList(p.polygon, 'polygon', 3),
              camera: af.camera,
              ...(p.gsdCmPerPx !== undefined ? { gsdCmPerPx: num(p.gsdCmPerPx, 'gsdCmPerPx', 0.1, 50) } : { alt }),
              frontOverlap: num(p.frontOverlap, 'frontOverlap', 0, 0.95, 0.75),
              sideOverlap: num(p.sideOverlap, 'sideOverlap', 0, 0.95, 0.65),
              angleDeg: num(p.angleDeg, 'angleDeg', -360, 360, 0),
            });
            if (s.alt > 1000) throw badRequest('The requested GSD needs an altitude above 1000 m');
            return { items: s.items, info: { alt: s.alt, lineSpacingM: s.lineSpacingM, triggerDistanceM: s.triggerDistanceM, gsdCmPerPx: s.gsdCmPerPx, camera: af.camera.name } };
          }
        }
      } catch (err) {
        if (err instanceof Error && !(err as { status?: number }).status) throw badRequest(err.message);
        throw err;
      }
      throw badRequest('Unknown generator');
    },
  );

  // --- Simulation & optimisation of a mission --------------------------------------------

  const missionPlan = (orgId: string, missionId: string, raw: unknown): MissionPlan => {
    const row = db.get<{ plan: string }>('SELECT plan FROM missions WHERE id = ? AND org_id = ?', missionId, orgId);
    if (!row) throw notFound('Mission');
    try {
      return normalizePlan(raw === undefined ? JSON.parse(row.plan) : raw);
    } catch (err) {
      throw badRequest(`Invalid mission plan: ${(err as Error).message}`);
    }
  };

  const airframeFor = (orgId: string, airframeId?: string, droneId?: string): Airframe => {
    if (airframeId) {
      const af = airframeById(airframeId);
      if (!af) throw badRequest(`Unknown airframe ${airframeId}`);
      return af;
    }
    if (droneId) {
      const d = db.get<{ airframe_id: string | null }>('SELECT airframe_id FROM drones WHERE id = ? AND org_id = ?', droneId, orgId);
      if (!d) throw notFound('Drone');
      return airframeById(d.airframe_id) ?? airframeById(DEFAULT_AIRFRAME_ID)!;
    }
    return airframeById(DEFAULT_AIRFRAME_ID)!;
  };

  /** Home elevation, terrain along the route and the weather used for a run. */
  const conditions = async (plan: MissionPlan, body: Static<typeof SimulateBody> | Static<typeof OptimizeBody>) => {
    const first = plan.items.find((i) => i.lat !== undefined && i.lon !== undefined);
    const home: LatLon | null = plan.home ?? (first ? { lat: first.lat!, lon: first.lon! } : null);
    const notes: string[] = [];
    let wind = body.wind ?? null;
    let temperatureC = body.temperatureC ?? null;
    let windSource: 'manual' | 'forecast' | 'none' = wind ? 'manual' : 'none';
    if (body.useForecast && home) {
      try {
        const w = await ctx.weather.current(home.lat, home.lon);
        if (w.windSpeedMs !== null && w.windDirDeg !== null) {
          wind = { speedMs: w.windSpeedMs, fromDeg: w.windDirDeg, gustMs: w.windGustMs };
          windSource = 'forecast';
        }
        if (temperatureC === null && w.temperatureC !== null) temperatureC = w.temperatureC;
      } catch (err) {
        notes.push(`Forecast unavailable (${(err as Error).message}); simulated without forecast wind.`);
      }
    }
    const samples = terrainSamplePoints(plan, 25, 3000);
    const pts: LatLon[] = home ? [home, ...samples] : samples;
    const elevations = pts.length ? await ctx.terrain.elevations(pts) : [];
    const homeElevationM = home ? (elevations[0] ?? plan.home?.alt ?? 0) : 0;
    const known = elevations.filter((e) => e !== null).length;
    return {
      home,
      wind,
      windSource,
      temperatureC,
      homeElevationM,
      samples,
      sampleElevations: home ? elevations.slice(1) : elevations,
      groundAt: known > 0 ? groundLookup(pts, elevations) : undefined,
      terrain: known > 0 ? ('dem' as const) : ('none' as const),
      notes,
    };
  };

  app.post<{ Params: Static<typeof MissionParams>; Body: Static<typeof SimulateBody> }>(
    '/api/v2/organisations/:orgId/missions/:missionId/simulate',
    { schema: { ...tag, summary: 'Pre-flight simulation with an airframe model under payload, wind, temperature and terrain', params: MissionParams, body: SimulateBody } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      const plan = missionPlan(a.orgId, req.params.missionId, req.body.plan);
      const af = airframeFor(a.orgId, req.body.airframeId, req.body.droneId);
      const c = await conditions(plan, req.body);
      const opts = {
        payloadKg: req.body.payloadKg ?? 0,
        wind: c.wind,
        temperatureC: c.temperatureC,
        homeElevationM: c.homeElevationM,
        groundAt: c.groundAt,
        reservePct: req.body.reservePct ?? 20,
      };
      const result = simulateFlight(plan, { ...opts, airframe: af });
      return {
        result,
        comparison: req.body.compare ? compareAirframes(plan, AIRFRAMES, opts) : undefined,
        conditions: { windSource: c.windSource, wind: c.wind, temperatureC: c.temperatureC, homeElevationM: c.homeElevationM, terrain: c.terrain, notes: c.notes },
      };
    },
  );

  app.post<{ Params: Static<typeof MissionParams>; Body: Static<typeof OptimizeBody> }>(
    '/api/v2/organisations/:orgId/missions/:missionId/optimize',
    { schema: { ...tag, summary: 'AI route optimisation: waypoint ordering, no-fly-zone avoidance and terrain following (not saved)', params: MissionParams, body: OptimizeBody } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      const original = missionPlan(a.orgId, req.params.missionId, req.body.plan);
      const af = airframeFor(a.orgId, req.body.airframeId, req.body.droneId);
      const c0 = await conditions(original, req.body);
      const now = Date.now();
      const zones: ObstacleZone[] =
        req.body.avoidZones === false
          ? []
          : ctx.airspace
              .zones(a.orgId)
              .filter((z) => (!z.activeTo || Date.parse(z.activeTo) >= now) && (!z.activeFrom || Date.parse(z.activeFrom) <= now + 24 * 3_600_000))
              .map((z) => ({ name: z.name, type: z.type, geometry: z.geometry, floorM: z.floorM, ceilingM: z.ceilingM }));
      const { plan: routed, report } = optimizeRoute(original, {
        reorder: req.body.reorder ?? false,
        zones,
        bufferM: req.body.bufferM ?? 30,
        airframe: af,
        payloadKg: req.body.payloadKg ?? 0,
        wind: c0.wind,
      });
      let plan = routed;
      let terrain: ReturnType<typeof applyTerrainFollowing> | null = null;
      if (req.body.terrainFollow !== false) {
        const samples = terrainSamplePoints(routed, 20, 4000);
        const elevations = await ctx.terrain.elevations(samples);
        if (elevations.some((e) => e !== null)) {
          terrain = applyTerrainFollowing(routed, samples, elevations, {
            homeElevationM: c0.homeElevationM,
            minClearanceM: req.body.minClearanceM ?? 30,
            maxAltM: getOrgSettings(db, a.orgId).maxAltitudeM,
          });
          plan = terrain.plan;
        }
      }
      // Predicted effect with the airframe model (same conditions).
      const c1 = await conditions(plan, req.body);
      const simOpts = { airframe: af, payloadKg: req.body.payloadKg ?? 0, wind: c0.wind, temperatureC: c0.temperatureC, maxSamples: 2 };
      const before = simulateFlight(original, { ...simOpts, homeElevationM: c0.homeElevationM, groundAt: c0.groundAt });
      const after = simulateFlight(plan, { ...simOpts, homeElevationM: c1.homeElevationM, groundAt: c1.groundAt });
      const summary = (r: typeof before) => ({ durationS: r.durationS, energyWh: r.energyWh, endSocPct: r.endSocPct, minAglM: r.minAglM, feasible: r.feasible, errors: r.issues.filter((i) => i.severity === 'error').map((i) => i.message) });
      return {
        plan,
        report,
        terrain: terrain ? { changes: terrain.changes, inserted: terrain.inserted, maxRequiredAlt: terrain.maxRequiredAlt, violations: terrain.violations } : null,
        terrainAvailable: c0.terrain === 'dem',
        airframeId: af.id,
        before: summary(before),
        after: summary(after),
        notes: c0.notes,
      };
    },
  );
}
