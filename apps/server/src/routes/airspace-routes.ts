import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { Type, type Static } from '@sinclair/typebox';
import { Nullable } from '../lib/schema';
import type { AirspaceCheckDto, ZoneType } from '@athena-sky/shared';
import { ZONE_TYPES, isValidLatLon } from '@athena-sky/shared';
import type { AppContext } from '../context';
import { orgAccess, requireAuth } from '../auth/auth';
import { audit } from '../lib/audit';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { nowIso, parseDate, uuid } from '../lib/util';
import { authShape, parseAuthGeometry, parseZoneGeometry, verdictOf } from '../airspace/geometry';
import { checkOrgVolume } from '../airspace/mission-check';
import { AUTH_SELECT, authorizationDto, publicReservations, zoneDto } from '../airspace/airspace-service';
import { parseZoneFeatures, zoneDefaults } from '../airspace/geojson';
import type { GeoJsonFeedProvider } from '../airspace/providers';
import { chargeTiles } from '../geo/tile-store';
import { can } from '@athena-sky/shared';

const OrgParams = Type.Object({ orgId: Type.String({ format: 'uuid' }) });
const ZoneTypeSchema = Type.Union(ZONE_TYPES.map((t) => Type.Literal(t)));
const ZoneBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  type: ZoneTypeSchema,
  geometry: Type.Unknown(),
  floorM: Type.Optional(Type.Number({ minimum: -500, maximum: 20000 })),
  ceilingM: Type.Optional(Type.Number({ minimum: 0, maximum: 20000 })),
  activeFrom: Type.Optional(Nullable(Type.String({ format: 'date-time' }))),
  activeTo: Type.Optional(Nullable(Type.String({ format: 'date-time' }))),
  notes: Type.Optional(Type.String({ maxLength: 2000 })),
});
const ZonePatch = Type.Partial(ZoneBody);
const CheckBody = Type.Object({
  geometry: Type.Unknown(),
  maxAltM: Type.Number({ minimum: 1, maximum: 10000 }),
  startAt: Type.String({ format: 'date-time' }),
  endAt: Type.String({ format: 'date-time' }),
  droneId: Type.Optional(Type.String({ format: 'uuid', description: 'Drone that will fly (flags your reservations for other drones)' })),
});
const AuthBody = Type.Object({
  geometry: Type.Unknown(),
  maxAltM: Type.Number({ minimum: 1, maximum: 10000 }),
  startAt: Type.String({ format: 'date-time' }),
  endAt: Type.String({ format: 'date-time' }),
  droneId: Type.Optional(Nullable(Type.String({ format: 'uuid' }))),
  missionId: Type.Optional(Nullable(Type.String({ format: 'uuid' }))),
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

/** How far in the past an authorisation request may start (a form filled in a few minutes ago). */
const AUTH_START_TOLERANCE_MS = 5 * 60_000;

/** A zone's active window must start before it ends (a zone that is never active is a mistake). */
function checkWindow(from: string | null, to: string | null): void {
  if (from && to && Date.parse(from) >= Date.parse(to)) throw badRequest('activeTo must be after activeFrom');
}

export function registerAirspaceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, webhooks } = ctx;

  // --- Zones (airspace data & ground hazards) ------------------------------------------------

  app.get<{ Params: Static<typeof OrgParams> }>('/api/v2/organisations/:orgId/airspace/zones', { schema: { ...tag, summary: 'Airspace zones and ground hazards', params: OrgParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId);
    return ctx.airspace.zones(a.orgId);
  });

  app.get('/api/v2/airspace/providers', { schema: { ...tag, summary: 'Airspace data providers (built-in zones and external feeds) and their status' } }, async (req) => {
    requireAuth(req);
    return ctx.airspace.statuses();
  });

  app.post<{ Params: { providerId: string } }>(
    '/api/v2/airspace/providers/:providerId/refresh',
    { schema: { ...tag, summary: 'Re-download an external airspace feed now (at most once per minute)' } },
    async (req) => {
      requireAuth(req);
      const p = ctx.airspace.provider(req.params.providerId);
      if (!p || p.kind !== 'geojson-feed') throw notFound('Airspace feed');
      await (p as GeoJsonFeedProvider).refreshIfOlderThan(60_000);
      return p.status();
    },
  );

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
      checkWindow(b.activeFrom ?? null, b.activeTo ?? null);
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
      ctx.airspace.invalidate(a.orgId);
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
        summary:
          'Import airspace from a GeoJSON FeatureCollection: Polygon (holes are covered), MultiPolygon (one zone per polygon), LineString (property bufferM), Point (property radiusM); properties name, type, floor, ceiling (m), activeFrom, activeTo, notes',
        params: OrgParams,
        body: Type.Object({ geojson: Type.Unknown(), defaultType: Type.Optional(ZoneTypeSchema) }),
      },
    },
    async (req, reply) => {
      const a = orgAccess(db, req, req.params.orgId, 'airspace.manage');
      const { zones: parsed, skipped, warnings } = parseZoneFeatures(req.body.geojson, req.body.defaultType ?? 'restricted', 2000);
      db.tx(() => {
        for (const z of parsed) {
          db.run(
            `INSERT INTO airspace_zones (id, org_id, name, type, geometry, floor_m, ceiling_m, active_from, active_to, source, notes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'geojson', ?, ?)`,
            uuid(),
            a.orgId,
            z.name,
            z.type,
            JSON.stringify(z.geometry),
            z.floorM,
            z.ceilingM,
            z.activeFrom,
            z.activeTo,
            z.notes,
            nowIso(),
          );
        }
      });
      const imported = parsed.length;
      ctx.airspace.invalidate(a.orgId);
      audit(db, a.orgId, a.userId, 'airspace.zone.import', null, { imported, skipped: skipped.length });
      reply.code(201);
      return { imported, skipped, warnings };
    },
  );

  app.patch<{ Params: { orgId: string; zoneId: string }; Body: Static<typeof ZonePatch> }>(
    '/api/v2/organisations/:orgId/airspace/zones/:zoneId',
    { schema: { ...tag, body: ZonePatch } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId, 'airspace.manage');
      if (req.params.zoneId.startsWith('feed:')) throw conflict('Zones from an external airspace feed are read-only');
      const z = db.get<any>('SELECT * FROM airspace_zones WHERE id = ? AND org_id = ?', req.params.zoneId, a.orgId);
      if (!z) throw notFound('Zone');
      const b = req.body;
      const floor = b.floorM ?? z.floor_m;
      const ceiling = b.ceilingM ?? z.ceiling_m;
      if (ceiling <= floor) throw badRequest('ceilingM must be above floorM');
      checkWindow(b.activeFrom === undefined ? z.active_from : b.activeFrom, b.activeTo === undefined ? z.active_to : b.activeTo);
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
      ctx.airspace.invalidate(a.orgId);
      return zoneDto(db.get('SELECT * FROM airspace_zones WHERE id = ?', z.id));
    },
  );

  app.delete<{ Params: { orgId: string; zoneId: string } }>('/api/v2/organisations/:orgId/airspace/zones/:zoneId', { schema: tag }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId, 'airspace.manage');
    if (req.params.zoneId.startsWith('feed:')) throw conflict('Zones from an external airspace feed are read-only');
    if (db.run('DELETE FROM airspace_zones WHERE id = ? AND org_id = ?', req.params.zoneId, a.orgId).changes === 0) throw notFound('Zone');
    ctx.airspace.invalidate(a.orgId);
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
      const conflicts = checkOrgVolume(db, ctx.airspace, a.orgId, authShape(geometry), 0, req.body.maxAltM, { from: start.getTime(), to: end.getTime() }, { droneId: req.body.droneId ?? null });
      return { conflicts, verdict: verdictOf(conflicts) };
    },
  );

  app.get<{ Params: Static<typeof OrgParams>; Querystring: { status?: string } }>(
    '/api/v2/organisations/:orgId/airspace/authorizations',
    { schema: { ...tag, summary: 'Flight authorisation requests', params: OrgParams } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      const status = req.query.status || null;
      return db.all<any>(`${AUTH_SELECT} WHERE a.org_id = ? AND (? IS NULL OR a.status = ?) ORDER BY a.created_at DESC LIMIT 500`, a.orgId, status, status).map((r) => authorizationDto(r, ctx.authority.decides(r)));
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
      // An authorisation covers flights from now on: a window starting in the past would make
      // flights already flown look authorised (or another operator's flights look intruding).
      if (start.getTime() < Date.now() - AUTH_START_TOLERANCE_MS) throw badRequest('startAt is in the past – an authorisation can start now at the earliest');
      if (b.droneId && !db.get('SELECT 1 FROM drones WHERE id = ? AND org_id = ?', b.droneId, a.orgId)) throw notFound('Drone');
      if (b.missionId && !db.get('SELECT 1 FROM missions WHERE id = ? AND org_id = ?', b.missionId, a.orgId)) throw notFound('Mission');
      const id = uuid();
      const ref = reference();
      // With an external flight authority, requests that pass the local checks are decided there.
      const authority = ctx.authority.authority?.name ?? null;
      const authorityId = ctx.authority.authority?.id ?? null;
      // Lock: evaluate and insert atomically so two overlapping requests cannot both be approved.
      let dto = db.tx(() => {
        const conflicts = checkOrgVolume(db, ctx.airspace, a.orgId, authShape(geometry), 0, b.maxAltM, { from: start.getTime(), to: end.getTime() }, { droneId: b.droneId ?? null });
        const verdict = verdictOf(conflicts);
        const status = verdict === 'blocked' ? 'rejected' : authority || verdict === 'review' ? 'pending' : 'approved';
        const reason =
          verdict === 'blocked'
            ? `Automatically rejected: ${conflicts.filter((c) => c.severity === 'blocking').map((c) => c.message).join('; ')}`
            : authority
              ? "Awaiting the flight authority's decision"
              : verdict === 'review'
                ? 'Requires review by a mission manager'
                : 'Automatically approved – no conflicts';
        const toAuthority = authority !== null && status === 'pending';
        db.run(
          `INSERT INTO authorizations (id, org_id, reference, geometry, max_alt_m, start_at, end_at, status, drone_id, mission_id, requested_by,
                                       conflicts, decision_reason, decided_at, is_public, created_at, approved_at, authority, authority_id, authority_state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          status === 'approved' ? nowIso() : null,
          toAuthority ? authority : null,
          toAuthority ? authorityId : null,
          toAuthority ? 'submitting' : null,
        );
        const row = db.get<any>(`${AUTH_SELECT} WHERE a.id = ?`, id);
        return authorizationDto(row, ctx.authority.decides(row));
      });
      audit(db, a.orgId, a.userId, 'authorization.request', id, { reference: ref, status: dto.status, ...(dto.authority ? { authority: dto.authority } : {}) });
      if (dto.status === 'approved') ctx.utm.invalidate(a.orgId);
      webhooks.emit(a.orgId, 'authorization.updated', { authorization: dto });
      if (dto.authorityState === 'submitting') {
        // Real-time: the authority's answer (approved, pending or rejected) is usually immediate.
        // When it is not reachable the request stays pending and is submitted again later.
        await ctx.authority.sync(id);
        const row = db.get<any>(`${AUTH_SELECT} WHERE a.id = ?`, id);
        dto = authorizationDto(row, ctx.authority.decides(row));
      }
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
        if (ctx.authority.decides(r)) throw conflict(`This request is decided by ${ctx.authority.authority!.name} – it can be cancelled instead`);
        // Approved after its window, it would never have been in effect.
        if (req.body.decision === 'approve' && Date.parse(r.end_at) <= Date.now()) throw conflict('The requested window has ended – the request can only be rejected');
        if (req.body.decision === 'approve') {
          const current = authorizationDto(db.get(`${AUTH_SELECT} WHERE a.id = ?`, r.id));
          // Since the request was made another operator may have reserved the airspace, or a
          // restriction (e.g. a temporary flight restriction) may have been put in place.
          const clash = checkOrgVolume(db, ctx.airspace, a.orgId, authShape(current.geometry), 0, current.maxAltM, { from: Date.parse(current.startAt), to: Date.parse(current.endAt) }, { droneId: current.droneId, excludeReservationId: current.id }).filter((c) => c.severity === 'blocking');
          if (clash.length > 0) throw conflict(`Cannot approve: ${clash[0]!.message}`);
        }
        const at = nowIso();
        // Decided here although a former authority may hold its flight plan (the server is no longer
        // connected to it): the plan is recorded as one to withdraw there – which cannot happen now.
        db.run(
          `UPDATE authorizations SET status = ?, decision_reason = ?, decided_by = ?, decided_at = ?, approved_at = ?,
                  authority_state = CASE
                    WHEN authority_state = 'submitted' THEN 'cancelling'
                    WHEN authority_state = 'submitting' THEN (CASE WHEN authority_sent = 1 THEN 'cancelling' ELSE 'closed' END)
                    ELSE authority_state END
            WHERE id = ?`,
          req.body.decision === 'approve' ? 'approved' : 'rejected',
          req.body.reason ?? (req.body.decision === 'approve' ? 'Approved by mission manager' : 'Rejected by mission manager'),
          a.userId,
          at,
          req.body.decision === 'approve' ? at : null,
          r.id,
        );
        return authorizationDto(db.get(`${AUTH_SELECT} WHERE a.id = ?`, r.id), false);
      });
      audit(db, a.orgId, a.userId, `authorization.${req.body.decision}`, dto.id, { reference: dto.reference });
      ctx.utm.invalidate(a.orgId);
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
    // The decision (who approved it, when) is kept: flights flown while it was in effect stay
    // covered (or intruding) – the cancellation is recorded beside it.
    // A flight plan at the external authority is withdrawn there too (and again later if it is not reachable now).
    // A submission whose answer has not come (it may have reached the authority) is withdrawn by its reference.
    db.run(
      `UPDATE authorizations SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?,
              decision_reason = CASE WHEN status = 'pending' THEN NULL ELSE decision_reason END,
              authority_error = NULL,
              authority_state = CASE
                WHEN authority_state = 'submitted' THEN 'cancelling'
                WHEN authority_state = 'submitting' THEN (CASE WHEN authority_sent = 1 THEN 'cancelling' ELSE 'closed' END)
                ELSE authority_state END
        WHERE id = ?`,
      nowIso(),
      a.userId,
      r.id,
    );
    void ctx.authority.sync(r.id);
    // The released airspace (or the coverage it gave) changes what the live monitor reports.
    ctx.utm.invalidate(a.orgId);
    const row = db.get<any>(`${AUTH_SELECT} WHERE a.id = ?`, r.id);
    const dto = authorizationDto(row, ctx.authority.decides(row));
    audit(db, a.orgId, a.userId, 'authorization.cancel', r.id, { reference: r.reference });
    webhooks.emit(a.orgId, 'authorization.updated', { authorization: dto });
    return dto;
  });

  app.get<{ Params: Static<typeof OrgParams> }>(
    '/api/v2/organisations/:orgId/airspace/authority',
    {
      schema: {
        ...tag,
        summary: "The external flight authority (UTM service) authorisation requests are submitted to, if any: the organisation's waiting requests and its exchanges' last contact and error",
        params: OrgParams,
      },
    },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      return ctx.authority.status(a.orgId);
    },
  );

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
    async (req, reply) => {
      const auth = requireAuth(req);
      if (!req.body.points.every(isValidLatLon)) throw badRequest('Invalid coordinates');
      const elevations = await ctx.terrain.elevations(req.body.points, (n) => chargeTiles(reply, ctx.tileBudgets.terrain, auth.user.id, n, 'terrain'));
      return { elevations, available: ctx.terrain.enabled };
    },
  );

  app.get('/api/v2/terrain', { schema: { tags: ['terrain'], summary: 'Whether terrain (DEM) data is available' } }, async (req) => {
    requireAuth(req);
    return { enabled: ctx.terrain.enabled };
  });

  app.get<{ Params: { z: string; x: string; y: string } }>(
    '/api/v2/terrain/tiles/:z/:x/:y.png',
    { schema: { tags: ['terrain'], summary: 'Terrarium DEM tile proxy (cached) for the 3D planner' } },
    async (req, reply) => {
      const auth = requireAuth(req);
      const [z, x, y] = [req.params.z, req.params.x, req.params.y].map(Number) as [number, number, number];
      if (!ctx.terrain.enabled) throw notFound('Terrain tile');
      if (!ctx.terrain.inRange(z, x, y)) throw badRequest('Tile coordinates out of range');
      if (!ctx.terrain.isCached(z, x, y)) chargeTiles(reply, ctx.tileBudgets.terrain, auth.user.id, 1, 'terrain');
      const png = await ctx.terrain.tilePng(z, x, y);
      if (!png) throw notFound('Terrain tile');
      return reply.header('content-type', 'image/png').header('cache-control', 'private, max-age=86400').send(png);
    },
  );
}
