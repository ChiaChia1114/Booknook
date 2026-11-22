import type { FastifyInstance } from 'fastify';
import { Type, type Static } from '@sinclair/typebox';
import { Nullable } from '../lib/schema';
import type { MissionDto, MissionPlan, Role, ScheduleDto } from '@athena-sky/shared';
import {
  ROLE_LABELS,
  can,
  flownFrom,
  fromQgcPlan,
  fromWpl,
  missionPath,
  missionStats,
  normalizePlan,
  toQgcPlan,
  toWpl,
  validateMission,
} from '@athena-sky/shared';
import type { AppContext } from '../context';
import { orgAccess } from '../auth/auth';
import { parseJson } from '../db/database';
import { audit } from '../lib/audit';
import { HttpError, badRequest, conflict, notFound } from '../lib/errors';
import { nowIso, resolveRange, uuid } from '../lib/util';
import { scheduleWindow } from '../lib/schedule-window';
import { getOrgSettings } from '../orgs/org-service';
import { checkMissionAirspace, enforceMissionAirspace } from '../airspace/mission-check';

const OrgParams = Type.Object({ orgId: Type.String({ format: 'uuid' }) });
const MissionParams = Type.Object({ orgId: Type.String({ format: 'uuid' }), missionId: Type.String({ format: 'uuid' }) });
type MissionP = Static<typeof MissionParams>;
const MissionBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.Optional(Type.String({ maxLength: 5000 })),
  plan: Type.Unknown(),
});
const MissionPatch = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  description: Type.Optional(Type.String({ maxLength: 5000 })),
  plan: Type.Optional(Type.Unknown()),
});
const ImportBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  format: Type.Union([Type.Literal('plan'), Type.Literal('waypoints')]),
  content: Type.String({ minLength: 1, maxLength: 5_000_000 }),
});
const UploadBody = Type.Object({
  droneId: Type.String({ format: 'uuid' }),
  acceptAirspaceConflicts: Type.Optional(
    Type.Boolean({ description: 'Upload although the airspace check is blocked (owners and administrators only – it takes both drone control and authorisation decisions; recorded in the audit log)' }),
  ),
});
const ScheduleBody = Type.Object({
  missionId: Type.String({ format: 'uuid' }),
  droneId: Type.String({ format: 'uuid' }),
  pilotId: Type.Optional(Nullable(Type.String({ format: 'uuid' }))),
  plannedAt: Type.String({ format: 'date-time' }),
});
const SchedulePatch = Type.Object({
  plannedAt: Type.Optional(Type.String({ format: 'date-time' })),
  pilotId: Type.Optional(Nullable(Type.String({ format: 'uuid' }))),
  status: Type.Optional(Type.Literal('cancelled')),
});
const CheckBody = Type.Object({
  droneId: Type.Optional(Type.String({ format: 'uuid', description: 'Drone that will fly the mission' })),
  startAt: Type.Optional(Type.String({ format: 'date-time' })),
  endAt: Type.Optional(Type.String({ format: 'date-time' })),
  bufferM: Type.Optional(Type.Number({ minimum: 5, maximum: 2000 })),
});

const tag = { tags: ['missions'] };

/** A drone that lost its link this recently still counts as carrying its loaded mission. */
const RECONNECT_WINDOW_MS = 10 * 60_000;

export function registerMissionRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, hub, terrain } = ctx;

  const missionDto = (r: any): MissionDto => {
    const plan = parseJson<MissionPlan>(r.plan, normalizePlan({}));
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      plan,
      stats: missionStats(plan),
      createdBy: r.created_by,
      createdByName: r.created_by_name ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      terrain: parseJson(r.terrain, null),
      swarmId: r.swarm_id ?? null,
    };
  };
  const SELECT = 'SELECT m.*, u.name AS created_by_name FROM missions m LEFT JOIN users u ON u.id = m.created_by';
  const loadMission = (orgId: string, id: string) => {
    const r = db.get(`${SELECT} WHERE m.id = ? AND m.org_id = ?`, id, orgId);
    if (!r) throw notFound('Mission');
    return missionDto(r);
  };
  const parsePlan = (raw: unknown): MissionPlan => {
    try {
      return normalizePlan(raw);
    } catch (err) {
      throw badRequest(`Invalid mission plan: ${(err as Error).message}`);
    }
  };
  const createMission = (orgId: string, userId: string, name: string, description: string, plan: MissionPlan): MissionDto => {
    const id = uuid();
    db.run(
      'INSERT INTO missions (id, org_id, name, description, plan, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      orgId,
      name.trim(),
      description,
      JSON.stringify(plan),
      userId,
      nowIso(),
      nowIso(),
    );
    return loadMission(orgId, id);
  };

  app.get<{ Params: Static<typeof OrgParams>; Querystring: { swarm?: boolean } }>(
    '/api/v2/organisations/:orgId/missions',
    { schema: { ...tag, params: OrgParams, querystring: Type.Object({ swarm: Type.Optional(Type.Boolean({ description: 'Include the per-drone missions of swarm operations' })) }) } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      return db.all(`${SELECT} WHERE m.org_id = ? AND (? = 1 OR m.swarm_id IS NULL) ORDER BY m.updated_at DESC`, a.orgId, req.query.swarm ? 1 : 0).map(missionDto);
    },
  );

  app.post<{ Params: Static<typeof OrgParams>; Body: Static<typeof MissionBody> }>(
    '/api/v2/organisations/:orgId/missions',
    { schema: { ...tag, summary: 'Create a mission (waypoints, rally points, geofence)', params: OrgParams, body: MissionBody } },
    async (req, reply) => {
      const a = orgAccess(db, req, req.params.orgId, 'mission.edit');
      const m = createMission(a.orgId, a.userId, req.body.name, req.body.description ?? '', parsePlan(req.body.plan));
      audit(db, a.orgId, a.userId, 'mission.create', m.id, { name: m.name });
      reply.code(201);
      return m;
    },
  );

  app.post<{ Params: Static<typeof OrgParams>; Body: Static<typeof ImportBody> }>(
    '/api/v2/organisations/:orgId/missions/import',
    { schema: { ...tag, summary: 'Import a QGroundControl .plan or QGC WPL 110 (.waypoints) file', params: OrgParams, body: ImportBody } },
    async (req, reply) => {
      const a = orgAccess(db, req, req.params.orgId, 'mission.edit');
      let plan: MissionPlan;
      try {
        plan = req.body.format === 'plan' ? fromQgcPlan(req.body.content) : fromWpl(req.body.content);
      } catch (err) {
        throw badRequest(`Cannot import mission: ${(err as Error).message}`);
      }
      const m = createMission(a.orgId, a.userId, req.body.name, `Imported from ${req.body.format === 'plan' ? 'QGroundControl plan' : 'QGC WPL 110 waypoints'}`, parsePlan(plan));
      audit(db, a.orgId, a.userId, 'mission.import', m.id, { format: req.body.format });
      reply.code(201);
      return m;
    },
  );

  app.get<{ Params: MissionP }>('/api/v2/organisations/:orgId/missions/:missionId', { schema: { ...tag, params: MissionParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId);
    return loadMission(a.orgId, req.params.missionId);
  });

  app.put<{ Params: MissionP; Body: Static<typeof MissionPatch> }>(
    '/api/v2/organisations/:orgId/missions/:missionId',
    { schema: { ...tag, params: MissionParams, body: MissionPatch } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId, 'mission.edit');
      const m = loadMission(a.orgId, req.params.missionId);
      const plan = req.body.plan === undefined ? m.plan : parsePlan(req.body.plan);
      db.run(
        'UPDATE missions SET name = ?, description = ?, plan = ?, terrain = ?, updated_at = ? WHERE id = ?',
        req.body.name?.trim() ?? m.name,
        req.body.description ?? m.description,
        JSON.stringify(plan),
        req.body.plan === undefined ? (m.terrain ? JSON.stringify(m.terrain) : null) : null,
        nowIso(),
        m.id,
      );
      return loadMission(a.orgId, m.id);
    },
  );

  app.delete<{ Params: MissionP }>('/api/v2/organisations/:orgId/missions/:missionId', { schema: { ...tag, params: MissionParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId, 'mission.edit');
    const m = loadMission(a.orgId, req.params.missionId);
    // A mission loaded on a drone (or being flown) is still in use: its flight is recorded
    // against it and its scheduled operation is linked to that flight.
    const loadedOn = hub.dronesWithMission(a.orgId, m.id);
    const flying = db.all<{ name: string }>(
      "SELECT d.name FROM flights f JOIN drones d ON d.id = f.drone_id WHERE f.mission_id = ? AND f.status = 'in_progress'",
      m.id,
    );
    // ...and drones that lost the link a moment ago with it on board (they pick it up again when
    // they reconnect). A drone away for longer reports it as unknown when it is back.
    const away = db.all<{ name: string }>(
      'SELECT d.name FROM drone_missions dm JOIN drones d ON d.id = dm.drone_id WHERE dm.mission_id = ? AND d.org_id = ? AND d.last_seen_at >= ?',
      m.id,
      a.orgId,
      new Date(Date.now() - RECONNECT_WINDOW_MS).toISOString(),
    );
    const inUse = [...new Set([...loadedOn, ...flying.map((r) => r.name), ...away.map((r) => r.name)])];
    if (inUse.length > 0) {
      throw new HttpError(
        409,
        'mission_in_use',
        `"${m.name}" is loaded on ${inUse.join(', ')}. Fly it, or upload another mission to ${inUse.length > 1 ? 'those drones' : 'that drone'}, before deleting it.`,
        { drones: inUse },
      );
    }
    db.run('DELETE FROM missions WHERE id = ? AND org_id = ?', m.id, a.orgId);
    audit(db, a.orgId, a.userId, 'mission.delete', m.id, { name: m.name });
    return { ok: true };
  });

  app.post<{ Params: MissionP }>('/api/v2/organisations/:orgId/missions/:missionId/duplicate', { schema: { ...tag, params: MissionParams } }, async (req, reply) => {
    const a = orgAccess(db, req, req.params.orgId, 'mission.edit');
    const m = loadMission(a.orgId, req.params.missionId);
    reply.code(201);
    return createMission(a.orgId, a.userId, `${m.name} (copy)`.slice(0, 120), m.description, m.plan);
  });

  app.get<{ Params: MissionP }>(
    '/api/v2/organisations/:orgId/missions/:missionId/validate',
    { schema: { ...tag, summary: 'Validate the mission against the organisation altitude limit and geofence', params: MissionParams } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      const m = loadMission(a.orgId, req.params.missionId);
      return { issues: validateMission(m.plan, { maxAltitude: getOrgSettings(db, a.orgId).maxAltitudeM }), stats: m.stats };
    },
  );

  app.get<{ Params: MissionP; Querystring: { format?: string } }>(
    '/api/v2/organisations/:orgId/missions/:missionId/export',
    { schema: { ...tag, summary: 'Export as QGroundControl .plan (format=plan) or QGC WPL 110 (format=waypoints)', params: MissionParams } },
    async (req, reply) => {
      const a = orgAccess(db, req, req.params.orgId);
      const m = loadMission(a.orgId, req.params.missionId);
      const safe = m.name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'mission';
      if ((req.query.format ?? 'plan') === 'plan') {
        return reply
          .header('content-type', 'application/json')
          .header('content-disposition', `attachment; filename="${safe}.plan"`)
          .send(JSON.stringify(toQgcPlan(m.plan), null, 2));
      }
      if (req.query.format === 'waypoints') {
        return reply.header('content-type', 'text/plain; charset=utf-8').header('content-disposition', `attachment; filename="${safe}.waypoints"`).send(toWpl(m.plan));
      }
      throw badRequest('format must be plan or waypoints');
    },
  );

  app.post<{ Params: MissionP }>(
    '/api/v2/organisations/:orgId/missions/:missionId/terrain',
    { schema: { ...tag, summary: 'Compute the terrain profile and clearance along the mission', params: MissionParams } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      const m = loadMission(a.orgId, req.params.missionId);
      const summary = await terrain.profile(missionPath(m.plan), m.plan.home?.alt ?? null);
      // Cached on the mission (fleet overview) only for members who may edit missions, and only
      // while the plan is still the one the profile was computed for.
      if (can(a.role, 'mission.edit')) db.run('UPDATE missions SET terrain = ? WHERE id = ? AND updated_at = ?', JSON.stringify(summary), m.id, m.updatedAt);
      return summary;
    },
  );

  app.post<{ Params: MissionP; Body: Static<typeof CheckBody> }>(
    '/api/v2/organisations/:orgId/missions/:missionId/airspace-check',
    { schema: { ...tag, summary: 'Check the mission corridor against airspace zones, hazards and reservations', params: MissionParams, body: CheckBody } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      const m = loadMission(a.orgId, req.params.missionId);
      const start = req.body.startAt ? new Date(req.body.startAt) : undefined;
      const check = checkMissionAirspace(db, ctx.airspace, a.orgId, m.plan, {
        droneId: req.body.droneId ?? null,
        startAt: start,
        endAt: req.body.endAt ? new Date(req.body.endAt) : undefined,
        bufferM: req.body.bufferM,
      });
      if (!check) throw badRequest('Mission has no flight path');
      return check;
    },
  );

  app.post<{ Params: MissionP; Body: Static<typeof UploadBody> }>(
    '/api/v2/organisations/:orgId/missions/:missionId/upload',
    { schema: { ...tag, summary: 'Upload the mission to an online drone over the link', params: MissionParams, body: UploadBody } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId, 'drone.control');
      const m = loadMission(a.orgId, req.params.missionId);
      if (!db.get('SELECT 1 FROM drones WHERE id = ? AND org_id = ?', req.body.droneId, a.orgId)) throw notFound('Drone');
      // A swarm member flies the operation's mission: replacing it would break the synchronisation.
      const op = ctx.swarms.operationOf(req.body.droneId);
      if (op) throw conflict(`The drone belongs to the swarm operation "${op.name}" – end the operation before uploading another mission`);
      const errors = validateMission(m.plan, { maxAltitude: Infinity }).filter((i) => i.level === 'error');
      if (errors.length) throw badRequest(`Mission is not valid: ${errors[0]!.message}`, errors);
      enforceMissionAirspace(
        db,
        a,
        m.id,
        [{ droneId: req.body.droneId, label: null, check: checkMissionAirspace(db, ctx.airspace, a.orgId, flownFrom(m.plan, hub.flightStartOf(req.body.droneId)), { droneId: req.body.droneId }) }],
        req.body.acceptAirspaceConflicts,
      );
      // The scheduled operation this upload belongs to: same drone and mission, planned around now.
      const w = scheduleWindow();
      const schedule = db.get<{ id: string; pilot_id: string | null }>(
        `SELECT id, pilot_id FROM schedules WHERE drone_id = ? AND mission_id = ? AND status = 'scheduled' AND planned_at BETWEEN ? AND ?
          ORDER BY ABS(julianday(planned_at) - julianday(?)) LIMIT 1`,
        req.body.droneId,
        m.id,
        w.from,
        w.to,
        w.now,
      );
      const r = await hub.uploadMission(a.orgId, req.body.droneId, { id: a.userId, role: a.role }, { id: m.id, name: m.name, plan: m.plan, pilotId: schedule?.pilot_id ?? a.userId });
      if (r.result === 'accepted' || r.result === 'completed') {
        // Another mission replaced the one uploaded for a schedule: that operation is pending again.
        db.run("UPDATE schedules SET status = 'scheduled' WHERE drone_id = ? AND status = 'uploaded' AND mission_id != ?", req.body.droneId, m.id);
        if (schedule) db.run("UPDATE schedules SET status = 'uploaded' WHERE id = ?", schedule.id);
        return { result: r.result, message: r.message ?? null };
      }
      throw conflict(r.message ?? `Mission upload ${r.result}`);
    },
  );

  // --- Schedules (future operations) ----------------------------------------------------------

  /** The pilot of a scheduled operation must be a member allowed to fly the organisation's drones. */
  const checkPilot = (orgId: string, userId: string) => {
    const m = db.get<{ role: Role; name: string }>('SELECT m.role, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.user_id = ?', orgId, userId);
    if (!m) throw badRequest('Pilot is not a member of this organisation');
    if (!can(m.role, 'drone.control')) throw badRequest(`${m.name} cannot fly drones in this organisation (${ROLE_LABELS[m.role]})`);
  };
  const scheduleDto = (r: any): ScheduleDto => ({
    id: r.id,
    missionId: r.mission_id,
    missionName: r.mission_name,
    droneId: r.drone_id,
    droneName: r.drone_name,
    pilotId: r.pilot_id,
    pilotName: r.pilot_name ?? null,
    plannedAt: r.planned_at,
    status: r.status,
    flightId: r.flight_id,
    createdAt: r.created_at,
  });
  const SCHED_SELECT = `SELECT s.*, m.name AS mission_name, d.name AS drone_name, u.name AS pilot_name FROM schedules s
    JOIN missions m ON m.id = s.mission_id JOIN drones d ON d.id = s.drone_id LEFT JOIN users u ON u.id = s.pilot_id`;

  app.get<{ Params: Static<typeof OrgParams>; Querystring: { from?: string; to?: string; droneId?: string } }>(
    '/api/v2/organisations/:orgId/schedules',
    { schema: { tags: ['schedules'], summary: 'Planned (future) operations', params: OrgParams } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      const range = resolveRange(req.query.from ?? new Date(Date.now() - 7 * 86_400_000).toISOString(), req.query.to ?? new Date(Date.now() + 90 * 86_400_000).toISOString());
      const droneId = req.query.droneId || null;
      return db
        .all(`${SCHED_SELECT} WHERE s.org_id = ? AND s.planned_at BETWEEN ? AND ? AND (? IS NULL OR s.drone_id = ?) ORDER BY s.planned_at`, a.orgId, range.from.toISOString(), range.to.toISOString(), droneId, droneId)
        .map(scheduleDto);
    },
  );

  app.post<{ Params: Static<typeof OrgParams>; Body: Static<typeof ScheduleBody> }>(
    '/api/v2/organisations/:orgId/schedules',
    { schema: { tags: ['schedules'], summary: 'Schedule a mission for a drone and pilot', params: OrgParams, body: ScheduleBody } },
    async (req, reply) => {
      const a = orgAccess(db, req, req.params.orgId, 'mission.edit');
      loadMission(a.orgId, req.body.missionId);
      if (!db.get('SELECT 1 FROM drones WHERE id = ? AND org_id = ?', req.body.droneId, a.orgId)) throw notFound('Drone');
      if (req.body.pilotId) checkPilot(a.orgId, req.body.pilotId);
      const id = uuid();
      db.run(
        "INSERT INTO schedules (id, org_id, mission_id, drone_id, pilot_id, planned_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?)",
        id,
        a.orgId,
        req.body.missionId,
        req.body.droneId,
        req.body.pilotId ?? null,
        new Date(req.body.plannedAt).toISOString(),
        nowIso(),
      );
      // Pre-compute the terrain profile used by the fleet overview ("terrain that will be encountered").
      const m = loadMission(a.orgId, req.body.missionId);
      if (!m.terrain && terrain.enabled) {
        void terrain
          .profile(missionPath(m.plan), m.plan.home?.alt ?? null)
          .then((s) => db.run('UPDATE missions SET terrain = ? WHERE id = ?', JSON.stringify(s), m.id))
          .catch(() => undefined);
      }
      audit(db, a.orgId, a.userId, 'schedule.create', id, { missionId: req.body.missionId, droneId: req.body.droneId });
      reply.code(201);
      return scheduleDto(db.get(`${SCHED_SELECT} WHERE s.id = ?`, id));
    },
  );

  app.patch<{ Params: { orgId: string; scheduleId: string }; Body: Static<typeof SchedulePatch> }>(
    '/api/v2/organisations/:orgId/schedules/:scheduleId',
    { schema: { tags: ['schedules'], body: SchedulePatch } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId, 'mission.edit');
      const s = db.get<any>('SELECT * FROM schedules WHERE id = ? AND org_id = ?', req.params.scheduleId, a.orgId);
      if (!s) throw notFound('Schedule');
      if (req.body.pilotId) checkPilot(a.orgId, req.body.pilotId);
      if (req.body.status === 'cancelled' && ['in_progress', 'completed'].includes(s.status)) throw conflict('Schedule can no longer be cancelled');
      db.run(
        'UPDATE schedules SET planned_at = ?, pilot_id = ?, status = ? WHERE id = ?',
        req.body.plannedAt ? new Date(req.body.plannedAt).toISOString() : s.planned_at,
        req.body.pilotId === undefined ? s.pilot_id : req.body.pilotId,
        req.body.status ?? s.status,
        s.id,
      );
      return scheduleDto(db.get(`${SCHED_SELECT} WHERE s.id = ?`, s.id));
    },
  );

  app.delete<{ Params: { orgId: string; scheduleId: string } }>('/api/v2/organisations/:orgId/schedules/:scheduleId', { schema: { tags: ['schedules'] } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId, 'mission.edit');
    if (db.run("DELETE FROM schedules WHERE id = ? AND org_id = ? AND status != 'in_progress'", req.params.scheduleId, a.orgId).changes === 0) throw notFound('Schedule');
    return { ok: true };
  });
}
