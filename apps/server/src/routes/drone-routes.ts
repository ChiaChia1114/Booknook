import type { FastifyInstance } from 'fastify';
import { Type, type Static } from '@sinclair/typebox';
import { Nullable } from '../lib/schema';
import type { DroneCreatedDto, DroneDto, FirmwarePackageDto, FirmwareUpdateDto, NextMissionDto } from '@athena-sky/shared';
import { COMMANDS, airframeById, can } from '@athena-sky/shared';
import type { AppContext } from '../context';
import { orgAccess } from '../auth/auth';
import { parseJson } from '../db/database';
import { audit } from '../lib/audit';
import { randomToken, sha256Hex } from '../lib/crypto';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { readMultipart } from '../lib/multipart';
import { nowIso, uuid } from '../lib/util';

const OrgParams = Type.Object({ orgId: Type.String({ format: 'uuid' }) });
const DroneParams = Type.Object({ orgId: Type.String({ format: 'uuid' }), droneId: Type.String({ format: 'uuid' }) });
type DroneP = Static<typeof DroneParams>;

const DroneBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  model: Type.Optional(Type.String({ maxLength: 100 })),
  serial: Type.Optional(Type.String({ maxLength: 100 })),
  fleetId: Type.Optional(Nullable(Type.String({ format: 'uuid' }))),
  notes: Type.Optional(Type.String({ maxLength: 2000 })),
  airframeId: Type.Optional(Nullable(Type.String({ maxLength: 60 }))),
});
const DronePatch = Type.Partial(DroneBody);
const CommandBody = Type.Object({
  command: Type.Union(COMMANDS.map((c) => Type.Literal(c))),
  params: Type.Optional(
    Type.Object({
      alt: Type.Optional(Type.Number()),
      lat: Type.Optional(Type.Number()),
      lon: Type.Optional(Type.Number()),
      mode: Type.Optional(Type.String({ maxLength: 16 })),
      speed: Type.Optional(Type.Number()),
      fromSeq: Type.Optional(Type.Integer()),
    }),
  ),
});
const FirmwareUpdateBody = Type.Object({ packageId: Type.String({ format: 'uuid' }) });

const tag = { tags: ['drones'] };

/** Estimated battery health from the trend of consumption rate (%/min): first flights vs latest flights. */
export function batteryHealth(rates: number[]): number | null {
  if (rates.length < 6) return null;
  const k = Math.min(5, Math.floor(rates.length / 2));
  const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const baseline = avg(rates.slice(0, k));
  const recent = avg(rates.slice(-k));
  if (!(baseline > 0) || !(recent > 0)) return null;
  return Math.round(Math.max(0, Math.min(100, (100 * baseline) / recent)));
}

export function registerDroneRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, hub, storage, config } = ctx;

  const nextMission = (droneId: string): NextMissionDto | null => {
    const r = db.get<any>(
      `SELECT s.id, s.mission_id, s.planned_at, m.name, m.terrain FROM schedules s JOIN missions m ON m.id = s.mission_id
        WHERE s.drone_id = ? AND s.status IN ('scheduled','uploaded') AND s.planned_at >= ? ORDER BY s.planned_at LIMIT 1`,
      droneId,
      new Date(Date.now() - 6 * 3_600_000).toISOString(),
    );
    return r ? { scheduleId: r.id, missionId: r.mission_id, name: r.name, plannedAt: r.planned_at, terrain: parseJson(r.terrain, null) } : null;
  };

  const droneDto = (r: any): DroneDto => {
    const flights = db.all<{ battery_start: number | null; battery_end: number | null; duration_s: number }>(
      "SELECT battery_start, battery_end, duration_s FROM flights WHERE drone_id = ? AND status != 'in_progress' ORDER BY started_at",
      r.id,
    );
    const rates = flights
      .filter((f) => f.battery_start !== null && f.battery_end !== null && f.duration_s >= 60 && f.battery_start! > f.battery_end!)
      .map((f) => (f.battery_start! - f.battery_end!) / (f.duration_s / 60));
    const live = hub.droneState(r.id);
    const tel = live?.online ? live.telemetry : null;
    return {
      id: r.id,
      name: r.name,
      model: r.model,
      serial: r.serial,
      fleetId: r.fleet_id,
      fleetName: r.fleet_name ?? null,
      airframeId: r.airframe_id ?? null,
      firmwareVersion: live?.firmware ?? r.firmware_version,
      notes: r.notes,
      createdAt: r.created_at,
      lastSeenAt: live?.online ? nowIso() : r.last_seen_at,
      lastPosition: tel ? { lat: tel.lat, lon: tel.lon, altMsl: tel.altMsl } : r.last_lat !== null ? { lat: r.last_lat, lon: r.last_lon, altMsl: r.last_alt ?? 0 } : null,
      online: live?.online ?? false,
      inFlight: !!live?.flightId,
      flightCount: flights.length,
      flightTimeS: r.flight_time ?? 0,
      distanceM: r.distance ?? 0,
      batteryCycles: flights.length,
      batteryHealthPct: batteryHealth(rates),
      healthScore: r.health === null || r.health === undefined ? null : Math.round(r.health),
      nextMission: nextMission(r.id),
      linkKeyPrefix: r.link_key_prefix,
    };
  };

  const DRONE_SELECT = `SELECT d.*, f.name AS fleet_name,
      (SELECT COALESCE(SUM(fl.duration_s), 0) FROM flights fl WHERE fl.drone_id = d.id) AS flight_time,
      (SELECT COALESCE(SUM(fl.distance_m), 0) FROM flights fl WHERE fl.drone_id = d.id) AS distance,
      (SELECT AVG(h.health_score) FROM (SELECT health_score FROM flights fl WHERE fl.drone_id = d.id AND fl.health_score IS NOT NULL
         ORDER BY fl.started_at DESC LIMIT 10) h) AS health
    FROM drones d LEFT JOIN fleets f ON f.id = d.fleet_id`;

  const loadDrone = (orgId: string, droneId: string): any => {
    const r = db.get(`${DRONE_SELECT} WHERE d.id = ? AND d.org_id = ?`, droneId, orgId);
    if (!r) throw notFound('Drone');
    return r;
  };

  const checkFleet = (orgId: string, fleetId: string | null | undefined) => {
    if (fleetId && !db.get('SELECT 1 FROM fleets WHERE id = ? AND org_id = ?', fleetId, orgId)) throw badRequest('Unknown fleet');
  };
  const checkAirframe = (airframeId: string | null | undefined) => {
    if (airframeId && !airframeById(airframeId)) throw badRequest(`Unknown airframe ${airframeId}`);
  };

  app.get<{ Params: Static<typeof OrgParams>; Querystring: { fleetId?: string } }>(
    '/api/v2/organisations/:orgId/drones',
    { schema: { ...tag, summary: 'Fleet assets with live status, firmware, flight hours, battery and next mission', params: OrgParams } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      const fleetId = req.query.fleetId || null;
      return db.all(`${DRONE_SELECT} WHERE d.org_id = ? AND (? IS NULL OR d.fleet_id = ?) ORDER BY d.name`, a.orgId, fleetId, fleetId).map(droneDto);
    },
  );

  app.post<{ Params: Static<typeof OrgParams>; Body: Static<typeof DroneBody> }>(
    '/api/v2/organisations/:orgId/drones',
    { schema: { ...tag, summary: 'Register a drone (returns its link key once)', params: OrgParams, body: DroneBody } },
    async (req, reply) => {
      const a = orgAccess(db, req, req.params.orgId, 'drone.manage');
      checkFleet(a.orgId, req.body.fleetId);
      checkAirframe(req.body.airframeId);
      const id = uuid();
      const key = randomToken('adk_', 32);
      db.run(
        `INSERT INTO drones (id, org_id, fleet_id, name, model, serial, notes, link_key_hash, link_key_prefix, created_at, airframe_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        a.orgId,
        req.body.fleetId ?? null,
        req.body.name.trim(),
        req.body.model ?? '',
        req.body.serial ?? '',
        req.body.notes ?? '',
        sha256Hex(key),
        key.slice(0, 10),
        nowIso(),
        req.body.airframeId ?? null,
      );
      audit(db, a.orgId, a.userId, 'drone.create', id, { name: req.body.name });
      reply.code(201);
      const dto: DroneCreatedDto = { ...droneDto(loadDrone(a.orgId, id)), linkKey: key };
      return dto;
    },
  );

  app.get<{ Params: DroneP }>('/api/v2/organisations/:orgId/drones/:droneId', { schema: { ...tag, params: DroneParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId);
    return droneDto(loadDrone(a.orgId, req.params.droneId));
  });

  app.patch<{ Params: DroneP; Body: Static<typeof DronePatch> }>(
    '/api/v2/organisations/:orgId/drones/:droneId',
    { schema: { ...tag, params: DroneParams, body: DronePatch } },
    async (req) => {
      const onlyFleet = Object.keys(req.body).every((k) => k === 'fleetId');
      const a = orgAccess(db, req, req.params.orgId);
      if (!can(a.role, 'drone.manage') && !(onlyFleet && can(a.role, 'fleet.manage'))) throw forbidden();
      const d = loadDrone(a.orgId, req.params.droneId);
      checkFleet(a.orgId, req.body.fleetId);
      checkAirframe(req.body.airframeId);
      db.run(
        'UPDATE drones SET name = ?, model = ?, serial = ?, fleet_id = ?, notes = ?, airframe_id = ? WHERE id = ?',
        req.body.name?.trim() ?? d.name,
        req.body.model ?? d.model,
        req.body.serial ?? d.serial,
        req.body.fleetId === undefined ? d.fleet_id : req.body.fleetId,
        req.body.notes ?? d.notes,
        req.body.airframeId === undefined ? d.airframe_id : req.body.airframeId,
        d.id,
      );
      hub.refreshDroneMeta(d.id);
      audit(db, a.orgId, a.userId, 'drone.update', d.id, req.body as Record<string, unknown>);
      return droneDto(loadDrone(a.orgId, d.id));
    },
  );

  app.delete<{ Params: DroneP }>('/api/v2/organisations/:orgId/drones/:droneId', { schema: { ...tag, params: DroneParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId, 'drone.manage');
    loadDrone(a.orgId, req.params.droneId);
    hub.disconnectDrone(req.params.droneId, 'drone deleted');
    db.run('DELETE FROM drones WHERE id = ?', req.params.droneId);
    audit(db, a.orgId, a.userId, 'drone.delete', req.params.droneId);
    return { ok: true };
  });

  app.post<{ Params: DroneP }>(
    '/api/v2/organisations/:orgId/drones/:droneId/link-key',
    { schema: { ...tag, summary: 'Rotate the drone link key (disconnects the drone)', params: DroneParams } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId, 'drone.manage');
      loadDrone(a.orgId, req.params.droneId);
      const key = randomToken('adk_', 32);
      db.run('UPDATE drones SET link_key_hash = ?, link_key_prefix = ? WHERE id = ?', sha256Hex(key), key.slice(0, 10), req.params.droneId);
      hub.disconnectDrone(req.params.droneId, 'link key rotated');
      audit(db, a.orgId, a.userId, 'drone.key_rotate', req.params.droneId);
      return { linkKey: key, linkKeyPrefix: key.slice(0, 10) };
    },
  );

  app.get<{ Params: DroneP }>(
    '/api/v2/organisations/:orgId/drones/:droneId/live',
    { schema: { tags: ['realtime'], summary: 'Live state (telemetry, controller, mission) of a drone', params: DroneParams } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      loadDrone(a.orgId, req.params.droneId);
      return hub.droneState(req.params.droneId);
    },
  );

  app.post<{ Params: DroneP; Body: Static<typeof CommandBody> }>(
    '/api/v2/organisations/:orgId/drones/:droneId/commands',
    { schema: { tags: ['realtime'], summary: 'Send a flight command (waits for the drone acknowledgement)', params: DroneParams, body: CommandBody } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId, 'drone.control');
      loadDrone(a.orgId, req.params.droneId);
      const r = await hub.sendCommand(a.orgId, req.params.droneId, { id: a.userId, name: a.userName, role: a.role }, req.body.command, req.body.params ?? {});
      if (!r.delivered) throw conflict(r.message ?? 'Command rejected');
      return { result: r.result, message: r.message ?? null };
    },
  );

  // --- Firmware packages & over-the-air updates -------------------------------------------

  const packageDto = (r: any): FirmwarePackageDto => ({
    id: r.id,
    version: r.version,
    model: r.model,
    filename: r.filename,
    size: r.size,
    sha256: r.sha256,
    notes: r.notes,
    createdAt: r.created_at,
  });
  const updateDto = (r: any): FirmwareUpdateDto => ({
    id: r.id,
    droneId: r.drone_id,
    droneName: r.drone_name,
    packageId: r.package_id,
    version: r.version,
    status: r.status,
    progress: r.progress,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
  const UPDATE_SELECT = `SELECT u.*, d.name AS drone_name, p.version FROM firmware_updates u
    JOIN drones d ON d.id = u.drone_id JOIN firmware_packages p ON p.id = u.package_id`;

  app.get<{ Params: Static<typeof OrgParams> }>('/api/v2/organisations/:orgId/firmware', { schema: { tags: ['firmware'], params: OrgParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId);
    return db.all('SELECT * FROM firmware_packages WHERE org_id = ? ORDER BY created_at DESC', a.orgId).map(packageDto);
  });

  app.post<{ Params: Static<typeof OrgParams> }>(
    '/api/v2/organisations/:orgId/firmware',
    { schema: { tags: ['firmware'], summary: 'Upload a firmware package (multipart: file, version, model, notes)', params: OrgParams, consumes: ['multipart/form-data'] } },
    async (req, reply) => {
      const a = orgAccess(db, req, req.params.orgId, 'firmware.manage');
      const { fields, files } = await readMultipart(req, storage, 'firmware', config.maxUploadMb * 1_048_576);
      const file = files[0];
      const version = (fields.version ?? '').trim();
      if (!file || !/^[\w.+-]{1,40}$/.test(version)) {
        if (file) storage.remove(file.stored.storagePath);
        throw badRequest('A firmware file and a version (letters, digits, . + - _) are required');
      }
      const id = uuid();
      db.run(
        'INSERT INTO firmware_packages (id, org_id, version, model, filename, size, sha256, storage_path, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        a.orgId,
        version,
        (fields.model ?? '').slice(0, 100),
        file.filename,
        file.stored.size,
        file.stored.sha256,
        file.stored.storagePath,
        (fields.notes ?? '').slice(0, 2000),
        nowIso(),
      );
      audit(db, a.orgId, a.userId, 'firmware.upload', id, { version, sha256: file.stored.sha256 });
      reply.code(201);
      return packageDto(db.get('SELECT * FROM firmware_packages WHERE id = ?', id));
    },
  );

  app.delete<{ Params: { orgId: string; packageId: string } }>('/api/v2/organisations/:orgId/firmware/:packageId', { schema: { tags: ['firmware'] } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId, 'firmware.manage');
    const p = db.get<{ storage_path: string }>('SELECT storage_path FROM firmware_packages WHERE id = ? AND org_id = ?', req.params.packageId, a.orgId);
    if (!p) throw notFound('Firmware package');
    db.run('DELETE FROM firmware_packages WHERE id = ?', req.params.packageId);
    storage.remove(p.storage_path);
    return { ok: true };
  });

  app.get<{ Params: Static<typeof OrgParams>; Querystring: { droneId?: string } }>(
    '/api/v2/organisations/:orgId/firmware-updates',
    { schema: { tags: ['firmware'], params: OrgParams } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      const droneId = req.query.droneId || null;
      return db.all(`${UPDATE_SELECT} WHERE u.org_id = ? AND (? IS NULL OR u.drone_id = ?) ORDER BY u.created_at DESC LIMIT 200`, a.orgId, droneId, droneId).map(updateDto);
    },
  );

  app.post<{ Params: DroneP; Body: Static<typeof FirmwareUpdateBody> }>(
    '/api/v2/organisations/:orgId/drones/:droneId/firmware-updates',
    { schema: { tags: ['firmware'], summary: 'Schedule a remote firmware update (sent immediately if online)', params: DroneParams, body: FirmwareUpdateBody } },
    async (req, reply) => {
      const a = orgAccess(db, req, req.params.orgId, 'firmware.manage');
      loadDrone(a.orgId, req.params.droneId);
      if (!db.get('SELECT 1 FROM firmware_packages WHERE id = ? AND org_id = ?', req.body.packageId, a.orgId)) throw notFound('Firmware package');
      const state = hub.droneState(req.params.droneId);
      if (state?.telemetry?.armed) throw conflict('Cannot update firmware while the drone is armed');
      const id = uuid();
      db.tx(() => {
        db.run("UPDATE firmware_updates SET status = 'cancelled', updated_at = ? WHERE drone_id = ? AND status = 'pending'", nowIso(), req.params.droneId);
        db.run(
          "INSERT INTO firmware_updates (id, org_id, drone_id, package_id, status, progress, requested_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)",
          id,
          a.orgId,
          req.params.droneId,
          req.body.packageId,
          a.userId,
          nowIso(),
          nowIso(),
        );
      });
      audit(db, a.orgId, a.userId, 'firmware.update', req.params.droneId, { packageId: req.body.packageId });
      hub.dispatchPendingFirmware(req.params.droneId);
      reply.code(201);
      return updateDto(db.get(`${UPDATE_SELECT} WHERE u.id = ?`, id));
    },
  );

  app.post<{ Params: { orgId: string; updateId: string } }>('/api/v2/organisations/:orgId/firmware-updates/:updateId/cancel', { schema: { tags: ['firmware'] } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId, 'firmware.manage');
    const r = db.run("UPDATE firmware_updates SET status = 'cancelled', updated_at = ? WHERE id = ? AND org_id = ? AND status IN ('pending','sent')", nowIso(), req.params.updateId, a.orgId);
    if (r.changes === 0) throw conflict('Update cannot be cancelled in its current state');
    return updateDto(db.get(`${UPDATE_SELECT} WHERE u.id = ?`, req.params.updateId));
  });

  // Drone-side download of a firmware image (one-time token issued when the update is dispatched).
  app.get<{ Params: { updateId: string }; Querystring: { token?: string } }>(
    '/api/v2/link/firmware/:updateId',
    { schema: { tags: ['link'], summary: 'Firmware image download for the drone (tokenised URL)' } },
    async (req, reply) => {
      const u = db.get<{ download_token_hash: string | null; status: string; storage_path: string; filename: string; size: number }>(
        `SELECT u.download_token_hash, u.status, p.storage_path, p.filename, p.size FROM firmware_updates u
          JOIN firmware_packages p ON p.id = u.package_id WHERE u.id = ?`,
        req.params.updateId,
      );
      if (!u || !u.download_token_hash || !req.query.token || sha256Hex(req.query.token) !== u.download_token_hash) throw notFound('Firmware');
      if (['completed', 'failed', 'cancelled'].includes(u.status)) throw new HttpError(410, 'gone', 'Update is no longer active');
      reply.header('content-type', 'application/octet-stream');
      reply.header('content-length', String(u.size));
      reply.header('content-disposition', `attachment; filename="${u.filename}"`);
      return reply.send(storage.stream(u.storage_path));
    },
  );
}

/** Creates a fresh tokenised download URL for an update (called by the hub when dispatching). */
export function createFirmwareDownloadUrl(ctx: Pick<AppContext, 'db' | 'config'>, updateId: string): string {
  const token = randomToken('', 24);
  ctx.db.run('UPDATE firmware_updates SET download_token_hash = ? WHERE id = ?', sha256Hex(token), updateId);
  return `${ctx.config.publicUrl}/api/v2/link/firmware/${updateId}?token=${encodeURIComponent(token)}`;
}
