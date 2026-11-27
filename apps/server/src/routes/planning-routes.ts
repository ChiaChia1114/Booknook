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
  bboxOf,
  isValidLatLon,
  normalizePlan,
  terrainSamplePoints,
  type Airframe,
  type LatLon,
  type MissionPlan,
  type ObstacleZone,
} from '@athena-sky/shared';
import type { AppContext } from '../context';
import { orgAccess, requireAuth } from '../auth/auth';
import { HttpError, badRequest, notFound } from '../lib/errors';
import type { Ground } from '../planning/tasks';
import { boxesOverlap, grow, zoneInfo } from '../airspace/zone-index';
import { tileImageType } from '../geo/imagery';
import { chargeTiles } from '../geo/tile-store';
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

export function registerPlanningRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config } = ctx;

  app.get('/api/v2/config', { schema: { tags: ['meta'], summary: 'Client configuration (map services available to the web application)' } }, async (req) => {
    requireAuth(req);
    return {
      cesiumIonToken: config.cesiumIonToken,
      terrain: !!config.terrainUrl,
      /** Aerial imagery tiles are served by this server (`/api/v2/tiles/imagery/{z}/{x}/{y}`). */
      imagery: !!config.imageryUrl,
      weather: !!config.weatherUrl,
      airspaceFeeds: config.airspaceFeeds.length,
    };
  });

  app.get<{ Params: { z: string; x: string; y: string } }>(
    '/api/v2/tiles/imagery/:z/:x/:y',
    { schema: { tags: ['meta'], summary: 'Aerial imagery tile (Web Mercator), cached by this server – for the satellite maps and simulated drone cameras' } },
    async (req, reply) => {
      const auth = requireAuth(req);
      if (!ctx.imagery.enabled) throw new HttpError(503, 'imagery_disabled', 'Aerial imagery is not configured on this server (ATHENA_IMAGERY_URL)');
      const [z, x, y] = [req.params.z, req.params.x, req.params.y.replace(/\.(jpg|jpeg|png)$/i, '')].map(Number) as [number, number, number];
      if (!ctx.imagery.inRange(z, x, y)) throw badRequest('Tile coordinates out of range');
      // Tiles not cached yet are fetched from the tile service: within each user's allowance.
      if (!ctx.imagery.isCached(z, x, y)) chargeTiles(reply, ctx.tileBudgets.imagery, auth.user.id, 1, 'imagery');
      const buf = await ctx.imagery.tile(z, x, y);
      if (!buf) throw new HttpError(502, 'imagery_unavailable', 'The imagery tile service did not deliver this tile');
      reply.header('content-type', tileImageType(buf) ?? 'application/octet-stream');
      reply.header('cache-control', 'private, max-age=604800');
      return reply.send(buf);
    },
  );

  app.get<{ Querystring: { lat?: string; lon?: string } }>(
    '/api/v2/geocode/reverse',
    { schema: { tags: ['meta'], summary: 'Place name of a position (OpenStreetMap Nominatim, cached)' } },
    async (req) => {
      requireAuth(req);
      const lat = Number(req.query.lat);
      const lon = Number(req.query.lon);
      if (!isValidLatLon({ lat, lon })) throw badRequest('lat and lon are required');
      return ctx.geocoder.reverse(lat, lon);
    },
  );

  app.get('/api/v2/airframes', { schema: { ...tag, summary: 'Airframe catalogue with flight-physics parameters and endurance' } }, async (req) => {
    requireAuth(req);
    return AIRFRAMES.map((af) => ({ ...af, summary: airframeSummary(af) }));
  });

  app.post<{ Body: Static<typeof GenerateBody> }>(
    '/api/v2/planning/generate',
    { schema: { ...tag, summary: 'Generate waypoints: orbit / structure scan, corridor, perimeter, survey, camera survey', body: GenerateBody } },
    async (req) => {
      requireAuth(req);
      // Computed in the planning worker (a large area never holds up the server).
      return ctx.planner.run('generate', { kind: req.body.kind, params: req.body.params });
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

  /** Terrain tiles fetched for a request: within the caller's allowance. */
  const terrainCharge = (reply: { header(name: string, value: string): unknown }, userId: string) => (n: number) => chargeTiles(reply, ctx.tileBudgets.terrain, userId, n, 'terrain');

  /** Home elevation, terrain along the route and the weather used for a run. */
  const conditions = async (plan: MissionPlan, body: Static<typeof SimulateBody> | Static<typeof OptimizeBody>, charge: (tiles: number) => void) => {
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
    const elevations = pts.length ? await ctx.terrain.elevations(pts, charge) : [];
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
      ground: known > 0 ? ({ points: pts, elevations } satisfies Ground) : null,
      terrain: known > 0 ? ('dem' as const) : ('none' as const),
      notes,
    };
  };

  app.post<{ Params: Static<typeof MissionParams>; Body: Static<typeof SimulateBody> }>(
    '/api/v2/organisations/:orgId/missions/:missionId/simulate',
    { schema: { ...tag, summary: 'Pre-flight simulation with an airframe model under payload, wind, temperature and terrain', params: MissionParams, body: SimulateBody } },
    async (req, reply) => {
      const a = orgAccess(db, req, req.params.orgId);
      const plan = missionPlan(a.orgId, req.params.missionId, req.body.plan);
      const af = airframeFor(a.orgId, req.body.airframeId, req.body.droneId);
      const c = await conditions(plan, req.body, terrainCharge(reply, a.userId));
      // Flown in the planning worker (a long mission with every airframe never holds up the server).
      const { result, comparison } = await ctx.planner.run('simulate', {
        plan,
        airframeId: af.id,
        conditions: { payloadKg: req.body.payloadKg ?? 0, wind: c.wind, temperatureC: c.temperatureC, homeElevationM: c.homeElevationM, reservePct: req.body.reservePct ?? 20 },
        ground: c.ground,
        compare: req.body.compare === true,
      });
      return {
        result,
        comparison,
        conditions: { windSource: c.windSource, wind: c.wind, temperatureC: c.temperatureC, homeElevationM: c.homeElevationM, terrain: c.terrain, notes: c.notes },
      };
    },
  );

  app.post<{ Params: Static<typeof MissionParams>; Body: Static<typeof OptimizeBody> }>(
    '/api/v2/organisations/:orgId/missions/:missionId/optimize',
    { schema: { ...tag, summary: 'AI route optimisation: waypoint ordering, no-fly-zone avoidance and terrain following (not saved)', params: MissionParams, body: OptimizeBody } },
    async (req, reply) => {
      const a = orgAccess(db, req, req.params.orgId);
      const original = missionPlan(a.orgId, req.params.missionId, req.body.plan);
      const af = airframeFor(a.orgId, req.body.airframeId, req.body.droneId);
      const charge = terrainCharge(reply, a.userId);
      const c0 = await conditions(original, req.body, charge);
      const now = Date.now();
      // The zones near the route (within a few km of it): the others cannot be in its way.
      const route = bboxOf([...(original.home ? [original.home] : []), ...original.items.filter((i): i is typeof i & LatLon => i.lat !== undefined && i.lon !== undefined)]);
      const near = route ? grow(route, (req.body.bufferM ?? 30) + 5000) : null;
      const zones: ObstacleZone[] =
        req.body.avoidZones === false || !near
          ? []
          : ctx.airspace
              .zones(a.orgId)
              .filter((z) => (!z.activeTo || Date.parse(z.activeTo) >= now) && (!z.activeFrom || Date.parse(z.activeFrom) <= now + 24 * 3_600_000) && boxesOverlap(zoneInfo(z).box, near))
              .map((z) => ({ name: z.name, type: z.type, geometry: z.geometry, floorM: z.floorM, ceilingM: z.ceilingM }));
      // Ordered, routed around blocking airspace, raised over the terrain and flown again in the
      // planning worker (hundreds of waypoints never hold up the server).
      const { plan: routed, report } = await ctx.planner.run('optimize', {
        plan: original,
        reorder: req.body.reorder ?? false,
        zones,
        bufferM: req.body.bufferM ?? 30,
        airframeId: af.id,
        payloadKg: req.body.payloadKg ?? 0,
        wind: c0.wind,
      });
      let plan = routed;
      let terrain: Awaited<ReturnType<typeof ctx.planner.run<'terrainFollow'>>> | null = null;
      if (req.body.terrainFollow !== false) {
        const samples = terrainSamplePoints(routed, 20, 4000);
        const elevations = await ctx.terrain.elevations(samples, charge);
        if (elevations.some((e) => e !== null)) {
          terrain = await ctx.planner.run('terrainFollow', {
            plan: routed,
            samples,
            elevations,
            homeElevationM: c0.homeElevationM,
            minClearanceM: req.body.minClearanceM ?? 30,
            maxAltM: getOrgSettings(db, a.orgId).maxAltitudeM,
          });
          plan = terrain.plan;
        }
      }
      // Predicted effect with the airframe model (same conditions).
      const c1 = await conditions(plan, req.body, charge);
      const { before, after } = await ctx.planner.run('beforeAfter', {
        original,
        plan,
        airframeId: af.id,
        conditions: { payloadKg: req.body.payloadKg ?? 0, wind: c0.wind, temperatureC: c0.temperatureC, homeElevationM: c0.homeElevationM, maxSamples: 2 },
        before: { homeElevationM: c0.homeElevationM, ground: c0.ground },
        after: { homeElevationM: c1.homeElevationM, ground: c1.ground },
      });
      return {
        plan,
        report,
        terrain: terrain ? { changes: terrain.changes, inserted: terrain.inserted, maxRequiredAlt: terrain.maxRequiredAlt, violations: terrain.violations } : null,
        terrainAvailable: c0.terrain === 'dem',
        airframeId: af.id,
        before,
        after,
        notes: c0.notes,
      };
    },
  );
}
