import type { FastifyInstance } from 'fastify';
import { Type, type Static } from '@sinclair/typebox';
import { FORMATION_PATTERNS } from '@athena-sky/shared';
import type { AppContext } from '../context';
import { orgAccess } from '../auth/auth';
import { badRequest } from '../lib/errors';

const Uuid = Type.String({ format: 'uuid' });
const OrgParams = Type.Object({ orgId: Uuid });
const SwarmParams = Type.Object({ orgId: Uuid, swarmId: Uuid });
const Options = Type.Object({
  mode: Type.Union([Type.Literal('formation'), Type.Literal('split')]),
  pattern: Type.Optional(Type.Union(FORMATION_PATTERNS.map((p) => Type.Literal(p)))),
  spacingM: Type.Optional(Type.Number({ minimum: 2, maximum: 500 })),
  altStepM: Type.Optional(Type.Number({ minimum: 0, maximum: 50 })),
  syncWaypoints: Type.Optional(Type.Boolean()),
  syncLanding: Type.Optional(Type.Boolean()),
});
const PlanBody = Type.Object({
  missionId: Uuid,
  droneIds: Type.Array(Uuid, { minItems: 2, maxItems: 12 }),
  options: Options,
});
const CreateBody = Type.Object({
  missionId: Uuid,
  droneIds: Type.Array(Uuid, { minItems: 2, maxItems: 12 }),
  options: Options,
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  acceptWarnings: Type.Optional(Type.Boolean()),
});
const ActionBody = Type.Object({
  action: Type.Union(['start', 'pause', 'resume', 'rtl', 'land', 'end'].map((a) => Type.Literal(a))),
});
const NotificationQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  before: Type.Optional(Type.String({ format: 'date-time' })),
  active: Type.Optional(Type.Boolean()),
});
const ReadBody = Type.Object({ until: Type.Optional(Type.String({ format: 'date-time' })) });

export function registerSwarmRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, swarms, notifications } = ctx;
  const tag = { tags: ['swarms'] };

  app.post<{ Params: Static<typeof OrgParams>; Body: Static<typeof PlanBody> }>(
    '/api/v2/organisations/:orgId/swarms/preview',
    { schema: { ...tag, summary: 'Plan a swarm operation (per-drone missions, sync points, timing, separation) without uploading', params: OrgParams, body: PlanBody } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId, 'mission.edit');
      return swarms.preview(a.orgId, req.body);
    },
  );

  app.post<{ Params: Static<typeof OrgParams>; Body: Static<typeof CreateBody> }>(
    '/api/v2/organisations/:orgId/swarms',
    { schema: { ...tag, summary: 'Create a swarm operation and upload the missions to its drones', params: OrgParams, body: CreateBody } },
    async (req, reply) => {
      const a = orgAccess(db, req, req.params.orgId, 'drone.control');
      const out = await swarms.create(a.orgId, { id: a.userId, name: a.userName, role: a.role }, req.body);
      reply.code(201);
      return out;
    },
  );

  app.get<{ Params: Static<typeof OrgParams> }>('/api/v2/organisations/:orgId/swarms', { schema: { ...tag, summary: 'Recent swarm operations', params: OrgParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId);
    return swarms.list(a.orgId);
  });

  app.get<{ Params: Static<typeof SwarmParams> }>('/api/v2/organisations/:orgId/swarms/:swarmId', { schema: { ...tag, params: SwarmParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId);
    return swarms.get(a.orgId, req.params.swarmId);
  });

  app.post<{ Params: Static<typeof SwarmParams>; Body: Static<typeof ActionBody> }>(
    '/api/v2/organisations/:orgId/swarms/:swarmId/actions',
    {
      schema: {
        ...tag,
        summary: 'Start (synchronised take-off), pause, resume, return home, land or end a swarm operation',
        params: SwarmParams,
        body: ActionBody,
      },
    },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId, 'drone.control');
      return swarms.action(a.orgId, req.params.swarmId, { id: a.userId, name: a.userName, role: a.role }, req.body.action as 'start');
    },
  );

  // --- Notification centre ------------------------------------------------------------------

  app.get<{ Params: Static<typeof OrgParams>; Querystring: Static<typeof NotificationQuery> }>(
    '/api/v2/organisations/:orgId/notifications',
    { schema: { tags: ['notifications'], summary: 'UTM, traffic, separation, drone and swarm notifications (newest first) with the unread count', params: OrgParams, querystring: NotificationQuery } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      return notifications.list(a.orgId, a.userId, { limit: req.query.limit, before: req.query.before ?? null, active: req.query.active });
    },
  );

  app.post<{ Params: Static<typeof OrgParams>; Body: Static<typeof ReadBody> }>(
    '/api/v2/organisations/:orgId/notifications/read',
    { schema: { tags: ['notifications'], summary: 'Mark notifications as read up to a time (default: now)', params: OrgParams, body: ReadBody } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      const until = req.body?.until ?? new Date().toISOString();
      if (Number.isNaN(Date.parse(until))) throw badRequest('until must be a date-time');
      return { readUntil: notifications.markRead(a.orgId, a.userId, new Date(until).toISOString()) };
    },
  );
}
