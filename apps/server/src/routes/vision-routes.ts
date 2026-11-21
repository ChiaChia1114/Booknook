import { audit } from '../lib/audit';
import type { FastifyInstance } from 'fastify';
import { Type, type Static } from '@sinclair/typebox';
import type { AppContext } from '../context';
import { orgAccess } from '../auth/auth';
import { badRequest, conflict, notFound } from '../lib/errors';

const Uuid = Type.String({ format: 'uuid' });
const DroneParams = Type.Object({ orgId: Uuid, droneId: Uuid });
type DroneP = Static<typeof DroneParams>;
const EnableBody = Type.Object({ enabled: Type.Boolean() });
const FollowBody = Type.Object({
  trackId: Type.Integer({ minimum: 1 }),
  altM: Type.Optional(Type.Number({ minimum: 5, maximum: 120 })),
  standoffM: Type.Optional(Type.Number({ minimum: 4, maximum: 150 })),
});

export function registerVisionRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, vision, hub } = ctx;
  const tag = { tags: ['ai-vision'] };
  const drone = (orgId: string, droneId: string) => {
    if (!db.get('SELECT 1 FROM drones WHERE id = ? AND org_id = ?', droneId, orgId)) throw notFound('Drone');
  };
  const body = (droneId: string) => ({ status: vision.status(droneId), objects: vision.objects(droneId), stats: vision.stats(droneId) });

  app.get('/api/v2/vision/model', { schema: { ...tag, summary: 'Built-in object detector: classes, input size and evaluation on held-out frames' } }, async (req) => {
    if (!req.auth) throw notFound('Model');
    const m = vision.model;
    return m ? { available: true, format: m.format, classes: m.classes, input: m.input, stride: m.stride, meta: m.meta ?? null } : { available: false };
  });

  app.get<{ Params: DroneP }>('/api/v2/organisations/:orgId/drones/:droneId/ai', { schema: { ...tag, summary: 'AI vision status and the objects currently tracked', params: DroneParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId);
    drone(a.orgId, req.params.droneId);
    return body(req.params.droneId);
  });

  app.post<{ Params: DroneP; Body: Static<typeof EnableBody> }>(
    '/api/v2/organisations/:orgId/drones/:droneId/ai',
    { schema: { ...tag, summary: 'Turn AI object detection on the live video on or off (pilots; turning it off ends follow-me)', params: DroneParams, body: EnableBody } },
    async (req) => {
      // Starting or stopping AI changes what the drone does (it ends follow-me): pilots only,
      // and not while another pilot controls the drone.
      const a = orgAccess(db, req, req.params.orgId, 'drone.control');
      drone(a.orgId, req.params.droneId);
      if (req.body.enabled && !hub.isOnline(req.params.droneId)) throw conflict('The drone is offline');
      const st = hub.droneState(req.params.droneId);
      if (st?.controller && st.controller.userId !== a.userId) throw conflict(`Drone is controlled by ${st.controller.name}`);
      try {
        vision.setEnabled(a.orgId, req.params.droneId, req.body.enabled, { id: a.userId, name: a.userName, role: a.role });
      } catch (err) {
        throw conflict((err as Error).message);
      }
      return body(req.params.droneId);
    },
  );

  app.post<{ Params: DroneP; Body: Static<typeof FollowBody> }>(
    '/api/v2/organisations/:orgId/drones/:droneId/ai/follow',
    { schema: { ...tag, summary: 'Follow a tracked object (follow-me): keep it in view at a set height and distance', params: DroneParams, body: FollowBody } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId, 'drone.control');
      drone(a.orgId, req.params.droneId);
      const st = hub.droneState(req.params.droneId);
      if (st?.controller && st.controller.userId !== a.userId) throw conflict(`Drone is controlled by ${st.controller.name}`);
      try {
        vision.startFollow(a.orgId, req.params.droneId, req.body.trackId, { id: a.userId, name: a.userName, role: a.role }, { altM: req.body.altM, standoffM: req.body.standoffM });
        audit(db, a.orgId, a.userId, 'ai.follow.start', req.params.droneId, { trackId: req.body.trackId });
      } catch (err) {
        throw badRequest((err as Error).message);
      }
      return body(req.params.droneId);
    },
  );

  app.delete<{ Params: DroneP }>('/api/v2/organisations/:orgId/drones/:droneId/ai/follow', { schema: { ...tag, summary: 'Stop following (the drone holds its position)', params: DroneParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId, 'drone.control');
    drone(a.orgId, req.params.droneId);
    vision.stopFollowCommand(a.orgId, req.params.droneId, { id: a.userId, name: a.userName, role: a.role });
    audit(db, a.orgId, a.userId, 'ai.follow.stop', req.params.droneId);
    return body(req.params.droneId);
  });
}
