import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { Type, type Static } from '@sinclair/typebox';
import type { AirspaceCheckDto, ZoneType } from '@athena-sky/shared';
import { ZONE_TYPES, isValidLatLon } from '@athena-sky/shared';
import type { AppContext } from '../context';
import { orgAccess, requireAuth } from '../auth/auth';
import { audit } from '../lib/audit';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { nowIso, parseDate, uuid } from '../lib/util';
import { authShape, checkVolume, parseAuthGeometry, parseZoneGeometry, verdictOf } from '../airspace/geometry';
import { AUTH_SELECT, activeReservations, authorizationDto, listZones, publicReservations, zoneDto } from '../airspace/airspace-service';
import { can } from '@athena-sky/shared';

const OrgParams = Type.Object({ orgId: Type.String({ format: 'uuid' }) });
const ZoneTypeSchema = Type.Union(ZONE_TYPES.map((t) => Type.Literal(t)));
const ZoneBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  type: ZoneTypeSchema,
  geometry: Type.Unknown(),
  floorM: Type.Optional(Type.Number({ minimum: -500, maximum: 20000 })),
  ceilingM: Type.Optional(Type.Number({ minimum: 0, maximum: 20000 })),
  activeFrom: Type.Optional(Type.Union([Type.String({ format: 'date-time' }), Type.Null()])),
  activeTo: Type.Optional(Type.Union([Type.String({ format: 'date-time' }), Type.Null()])),
  notes: Type.Optional(Type.String({ maxLength: 2000 })),
});
const ZonePatch = Type.Partial(ZoneBody);
const CheckBody = Type.Object({
  geometry: Type.Unknown(),
  maxAltM: Type.Number({ minimum: 1, maximum: 10000 }),
  startAt: Type.String({ format: 'date-time' }),
  endAt: Type.String({ format: 'date-time' }),
});
const AuthBody = Type.Object({
  geometry: Type.Unknown(),
  maxAltM: Type.Number({ minimum: 1, maximum: 10000 }),
  startAt: Type.String({ format: 'date-time' }),
  endAt: Type.String({ format: 'date-time' }),
  droneId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  missionId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  isPublic: Type.Optional(Type.Boolean()),
});
const DecisionBody = Type.Object({
  decision: Type.Union([Type.Literal('approve'), Type.Literal('reject')]),
  reason: Type.Optional(Type.String({ maxLength: 1000 })),
});

const tag = { tags: ['airspace'] };

function window(startAt: string, endAt: string): { start: Date; end: Date } {
  const start = parseDate(startAt, 'startAt');
  const end = parseDate(endAt, 'endAt');
  if (end.getTime() <= start.getTime()) throw badRequest('endAt must be after startAt');
  if (end.getTime() - start.getTime() > 7 * 86_400_000) throw badRequest('Operation window cannot exceed 7 days');
  if (end.getTime() < Date.now()) throw badRequest('Operation window is in the past');
  return { start, end };
}

const reference = () => `ATH-${randomBytes(4).toString('hex').toUpperCase()}`;

export function registerAirspaceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, webhooks } = ctx;

  // --- Zones (airspace data & ground hazards) ------------------------------------------------

  app.get<{ Params: Static<typeof OrgParams> }>('/api/v2/organisations/:orgId/airspace/zones', { schema: { ...tag, summary: 'Airspace zones and ground hazards', params: OrgParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId);
    return listZones(db, a.orgId);
  });

  const zoneDefaults = (type: ZoneType) => (type.startsWith('hazard_') ? { floor: 0, ceiling: 100 } : { floor: 0, ceiling: 10000 });

  app.post<{ Params: Static<typeof OrgParams>; Body: Static<typeof ZoneBody> }>(
    '/api/v2/organisations/:orgId/airspace/zones',
    { schema: { ...tag, params: OrgParams, body: ZoneBody } },
    async (req, reply) => {
      const a = orgAccess(db, req, req.params.orgId, 'airspace.manage');
      const b = req.body;
      const geometry = parseZoneGeometry(b.geometry);
      const d = zoneDefaults(b.type);
      const floor = b.floorM ?? d.floor;
      const ceiling = b.ceilingM ?? d.ceiling;
      if (ceiling <= floor) throw badRequest('ceilingM must be above floorM');
      const id = uuid();
      db.run(
        `INSERT INTO airspace_zones (id, org_id, name, type, geometry, floor_m, ceiling_m, active_from, active_to, source, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`,
        id,
        a.orgId,
        b.name.trim(),
        b.type,
        JSON.stringify(geometry),
        floor,
        ceiling,
        b.activeFrom ?? null,
        b.activeTo ?? null,
        b.notes ?? '',
        nowIso(),
      );
      audit(db, a.orgId, a.userId, 'airspace.zone.create', id, { name: b.name, type: b.type });
      reply.code(201);
      return zoneDto(db.get('SELECT * FROM airspace_zones WHERE id = ?', id));
    },
  );

  app.post<{ Params: Static<typeof OrgParams>; Body: { geojson: unknown; defaultType?: ZoneType } }>(
    '/api/v2/organisations/:orgId/airspace/zones/import',
    {
      schema: {
        ...tag,
        summary: 'Import airspace from a GeoJSON FeatureCollection (properties: name, type, floor, ceiling)',
        params: OrgParams,
        body: Type.Object({ geojson: Type.Unknown(), defaultType: Type.Optional(ZoneTypeSchema) }),
      },
    },
    async (req, reply) => {
      const a = orgAccess(db, req, req.params.orgId, 'airspace.manage');
      const fc = req.body.geojson as { type?: string; features?: any[] };
      if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features)) throw badRequest('geojson must be a FeatureCollection');
      const features = fc.features;
      if (features.length > 2000) throw badRequest('Too many features (max 2000)');
      let imported = 0;
      const skipped: string[] = [];
      db.tx(() => {
        features.forEach((f, i) => {
          const props = f?.properties ?? {};
          const name = String(props.name ?? props.NAME ?? `Zone ${i + 1}`).slice(0, 120);
          const type: ZoneType = (ZONE_TYPES as readonly string[]).includes(props.type) ? props.type : (req.body.defaultType ?? 'restricted');
          const g = f?.geometry;
          let geometry;
          try {
            if (g?.type === 'Polygon') {
              const ring = (g.coordinates?.[0] ?? []).map((c: number[]) => ({ lat: c[1], lon: c[0] }));
              if (ring.length > 3 && ring[0].lat === ring.at(-1).lat && ring[0].lon === ring.at(-1).lon) ring.pop();
              geometry = parseZoneGeometry({ kind: 'polygon', polygon: ring });
            } else if (g?.type === 'LineString') {
              geometry = parseZoneGeometry({ kind: 'line', line: (g.coordinates ?? []).map((c: number[]) => ({ lat: c[1], lon: c[0] })), bufferM: Number(props.bufferM ?? 30) });
            } else if (g?.type === 'Point' && Number(props.radiusM) > 0) {
              geometry = parseZoneGeometry({ kind: 'circle', center: { lat: g.coordinates[1], lon: g.coordinates[0] }, radiusM: Number(props.radiusM) });
            } else throw new Error(`unsupported geometry ${g?.type}`);
          } catch (err) {
            skipped.push(`${name}: ${(err as Error).message}`);
            return;
          }
          const d = zoneDefaults(type);
          const floor = Number.isFinite(Number(props.floor)) ? Number(props.floor) : d.floor;
          const ceiling = Number.isFinite(Number(props.ceiling)) ? Number(props.ceiling) : d.ceiling;
          db.run(
            `INSERT INTO airspace_zones (id, org_id, name, type, geometry, floor_m, ceiling_m, source, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'geojson', ?, ?)`,
            uuid(),
            a.orgId,
            name,
            type,
            JSON.stringify(geometry),
            floor,
            Math.max(ceiling, floor + 1),
            String(props.notes ?? '').slice(0, 2000),
            nowIso(),
          );
          imported++;
        });
      });
      audit(db, a.orgId, a.userId, 'airspace.zone.import', null, { imported, skipped: skipped.length });
      reply.code(201);
      return { imported, skipped };
    },
  );

  app.patch<{ Params: { orgId: string; zoneId: string }; Body: Static<typeof ZonePatch> }>(
    '/api/v2/organisations/:orgId/airspace/zones/:zoneId',
    { schema: { ...tag, body: ZonePatch } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId, 'airspace.manage');
      const z = db.get<any>('SELECT * FROM airspace_zones WHERE id = ? AND org_id = ?', req.params.zoneId, a.orgId);
      if (!z) throw notFound('Zone');
      const b = req.body;
      const floor = b.floorM ?? z.floor_m;
      const ceiling = b.ceilingM ?? z.ceiling_m;
      if (ceiling <= floor) throw badRequest('ceilingM must be above floorM');
      db.run(
        'UPDATE airspace_zones SET name = ?, type = ?, geometry = ?, floor_m = ?, ceiling_m = ?, active_from = ?, active_to = ?, notes = ? WHERE id = ?',
        b.name?.trim() ?? z.name,
        b.type ?? z.type,
        b.geometry === undefined ? z.geometry : JSON.stringify(parseZoneGeometry(b.geometry)),
        floor,
        ceiling,
        b.activeFrom === undefined ? z.active_from : b.activeFrom,
        b.activeTo === undefined ? z.active_to : b.activeTo,
        b.notes ?? z.notes,
        z.id,
      );
      return zoneDto(db.get('SELECT * FROM airspace_zones WHERE id = ?', z.id));
    },
  );

  app.delete<{ Params: { orgId: string; zoneId: string } }>('/api/v2/organisations/:orgId/airspace/zones/:zoneId', { schema: tag }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId, 'airspace.manage');
    if (db.run('DELETE FROM airspace_zones WHERE id = ? AND org_id = ?', req.params.zoneId, a.orgId).changes === 0) throw notFound('Zone');
    audit(db, a.orgId, a.userId, 'airspace.zone.delete', req.params.zoneId);
    return { ok: true };
  });

  // --- Checks & real-time flight authorisation -------------------------------------------------

  app.post<{ Params: Static<typeof OrgParams>; Body: Static<typeof CheckBody> }>(
    '/api/v2/organisations/:orgId/airspace/check',
    { schema: { ...tag, summary: 'Check a cylinder/corridor volume against zones, hazards and reservations', params: OrgParams, body: CheckBody } },
    async (req): Promise<AirspaceCheckDto> => {
      const a = orgAccess(db, req, req.params.orgId);
      const geometry = parseAuthGeometry(req.body.geometry);
      const { start, end } = window(req.body.startAt, req.body.endAt);
      const conflicts = checkVolume(authShape(geometry), 0, req.body.maxAltM, { from: start.getTime(), to: end.getTime() }, listZones(db, a.orgId), activeReservations(db, start.toISOString(), end.toISOString()));
      return { conflicts, verdict: verdictOf(conflicts) };
    },
  );

  app.get<{ Params: Static<typeof OrgParams>; Querystring: { status?: string } }>(
    '/api/v2/organisations/:orgId/airspace/authorizations',
    { schema: { ...tag, summary: 'Flight authorisation requests', params: OrgParams } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      const status = req.query.status || null;
      return db.all(`${AUTH_SELECT} WHERE a.org_id = ? AND (? IS NULL OR a.status = ?) ORDER BY a.start_at DESC LIMIT 500`, a.orgId, status, status).map(authorizationDto);
    },
  );

  app.post<{ Params: Static<typeof OrgParams>; Body: Static<typeof AuthBody> }>(
    '/api/v2/organisations/:orgId/airspace/authorizations',
    {
      schema: {
        ...tag,
        summary: 'Request real-time flight authorisation (cylinder or corridor). Clear requests are approved instantly and reserve the airspace.',
        params: OrgParams,
        body: AuthBody,
      },
    },
    async (req, reply) => {
      const a = orgAccess(db, req, req.params.orgId, 'authorization.request');
      const b = req.body;
      const geometry = parseAuthGeometry(b.geometry);
      const { start, end } = window(b.startAt, b.endAt);
      if (b.droneId && !db.get('SELECT 1 FROM drones WHERE id = ? AND org_id = ?', b.droneId, a.orgId)) throw notFound('Drone');
      if (b.missionId && !db.get('SELECT 1 FROM missions WHERE id = ? AND org_id = ?', b.missionId, a.orgId)) throw notFound('Mission');
      const id = uuid();
      const ref = reference();
      // Lock: evaluate and insert atomically so two overlapping requests cannot both be approved.
      const dto = db.tx(() => {
        const conflicts = checkVolume(authShape(geometry), 0, b.maxAltM, { from: start.getTime(), to: end.getTime() }, listZones(db, a.orgId), activeReservations(db, start.toISOString(), end.toISOString()));
        const verdict = verdictOf(conflicts);
        const status = verdict === 'blocked' ? 'rejected' : verdict === 'review' ? 'pending' : 'approved';
        const reason =
          verdict === 'blocked'
            ? `Automatically rejected: ${conflicts.filter((c) => c.severity === 'blocking').map((c) => c.message).join('; ')}`
            : verdict === 'review'
              ? 'Requires review by a mission manager'
              : 'Automatically approved – no conflicts';
        db.run(
          `INSERT INTO authorizations (id, org_id, reference, geometry, max_alt_m, start_at, end_at, status, drone_id, mission_id, requested_by,
                                       conflicts, decision_reason, decided_at, is_public, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          a.orgId,
          ref,
          JSON.stringify(geometry),
          b.maxAltM,
          start.toISOString(),
          end.toISOString(),
          status,
          b.droneId ?? null,
          b.missionId ?? null,
          a.userId,
          JSON.stringify(conflicts),
          reason,
          status === 'pending' ? null : nowIso(),
          b.isPublic ?? true,
          nowIso(),
        );
        return authorizationDto(db.get(`${AUTH_SELECT} WHERE a.id = ?`, id));
      });
      audit(db, a.orgId, a.userId, 'authorization.request', id, { reference: ref, status: dto.status });
      webhooks.emit(a.orgId, 'authorization.updated', { authorization: dto });
      reply.code(201);
      return dto;
    },
  );

  app.post<{ Params: { orgId: string; authId: string }; Body: Static<typeof DecisionBody> }>(
    '/api/v2/organisations/:orgId/airspace/authorizations/:authId/decision',
    { schema: { ...tag, summary: 'Approve or reject a pending authorisation', body: DecisionBody } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId, 'authorization.decide');
      const dto = db.tx(() => {
        const r = db.get<any>('SELECT * FROM authorizations WHERE id = ? AND org_id = ?', req.params.authId, a.orgId);
        if (!r) throw notFound('Authorisation');
        if (r.status !== 'pending') throw conflict(`Authorisation is already ${r.status}`);
        if (req.body.decision === 'approve') {
          const current = authorizationDto(db.get(`${AUTH_SELECT} WHERE a.id = ?`, r.id));
          const clash = checkVolume(authShape(current.geometry), 0, current.maxAltM, { from: Date.parse(current.startAt), to: Date.parse(current.endAt) }, [], activeReservations(db, current.startAt, current.endAt, current.id));
          if (clash.length > 0) throw conflict(`Cannot approve: ${clash[0]!.message}`);
        }
        db.run(
          'UPDATE authorizations SET status = ?, decision_reason = ?, decided_by = ?, decided_at = ? WHERE id = ?',
          req.body.decision === 'approve' ? 'approved' : 'rejected',
          req.body.reason ?? (req.body.decision === 'approve' ? 'Approved by mission manager' : 'Rejected by mission manager'),
          a.userId,
          nowIso(),
          r.id,
        );
        return authorizationDto(db.get(`${AUTH_SELECT} WHERE a.id = ?`, r.id));
      });
      audit(db, a.orgId, a.userId, `authorization.${req.body.decision}`, dto.id, { reference: dto.reference });
      webhooks.emit(a.orgId, 'authorization.updated', { authorization: dto });
      return dto;
    },
  );

  app.post<{ Params: { orgId: string; authId: string } }>('/api/v2/organisations/:orgId/airspace/authorizations/:authId/cancel', { schema: tag }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId);
    const r = db.get<any>('SELECT * FROM authorizations WHERE id = ? AND org_id = ?', req.params.authId, a.orgId);
    if (!r) throw notFound('Authorisation');
    if (r.requested_by !== a.userId && !can(a.role, 'authorization.decide')) throw forbidden();
    if (!['pending', 'approved'].includes(r.status)) throw conflict(`Authorisation is already ${r.status}`);
    db.run("UPDATE authorizations SET status = 'cancelled', decided_at = ?, decided_by = ? WHERE id = ?", nowIso(), a.userId, r.id);
    const dto = authorizationDto(db.get(`${AUTH_SELECT} WHERE a.id = ?`, r.id));
    audit(db, a.orgId, a.userId, 'authorization.cancel', r.id, { reference: r.reference });
    webhooks.emit(a.orgId, 'authorization.updated', { authorization: dto });
    return dto;
  });

  // --- Public drone safety map (no authentication) --------------------------------------------

  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/api/v2/public/safety-map',
    { schema: { tags: ['public'], summary: 'Approved, public airspace reservations (drone safety map)' }, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req) => {
      const from = req.query.from ? parseDate(req.query.from, 'from') : new Date();
      const to = req.query.to ? parseDate(req.query.to, 'to') : new Date(Date.now() + 7 * 86_400_000);
      if (to.getTime() - from.getTime() > 31 * 86_400_000) throw badRequest('Window cannot exceed 31 days');
      return { from: from.toISOString(), to: to.toISOString(), reservations: publicReservations(db, from.toISOString(), to.toISOString()) };
    },
  );

  // --- Weather and terrain -----------------------------------------------------------------------

  app.get<{ Querystring: { lat?: string; lon?: string } }>(
    '/api/v2/weather',
    { schema: { tags: ['weather'], summary: 'Current weather and go/no-go assessment for a location' } },
    async (req) => {
      requireAuth(req);
      const lat = Number(req.query.lat);
      const lon = Number(req.query.lon);
      if (!isValidLatLon({ lat, lon })) throw badRequest('lat and lon are required');
      return ctx.weather.current(lat, lon);
    },
  );

  app.post<{ Body: { points: { lat: number; lon: number }[] } }>(
    '/api/v2/terrain/elevation',
    {
      schema: {
        tags: ['terrain'],
        summary: 'Terrain elevation (m AMSL) for up to 500 points',
        body: Type.Object({ points: Type.Array(Type.Object({ lat: Type.Number(), lon: Type.Number() }), { maxItems: 500 }) }),
      },
    },
    async (req) => {
      requireAuth(req);
      if (!req.body.points.every(isValidLatLon)) throw badRequest('Invalid coordinates');
      return { elevations: await ctx.terrain.elevations(req.body.points), available: ctx.terrain.enabled };
    },
  );

  app.get<{ Params: { z: string; x: string; y: string } }>(
    '/api/v2/terrain/tiles/:z/:x/:y.png',
    { schema: { tags: ['terrain'], summary: 'Terrarium DEM tile proxy (cached) for the 3D planner' } },
    async (req, reply) => {
      requireAuth(req);
      const png = await ctx.terrain.tilePng(Number(req.params.z), Number(req.params.x), Number(req.params.y));
      if (!png) throw notFound('Terrain tile');
      return reply.header('content-type', 'image/png').header('cache-control', 'private, max-age=86400').send(png);
    },
  );
}
