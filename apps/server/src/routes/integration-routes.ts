import type { FastifyInstance } from 'fastify';
import { Type, type Static } from '@sinclair/typebox';
import { Nullable } from '../lib/schema';
import type { WebhookCreatedDto, WebhookDeliveryDto, WebhookDto } from '@athena-sky/shared';
import { WEBHOOK_EVENTS } from '@athena-sky/shared';
import type { AppContext } from '../context';
import { orgAccess, requireAuth } from '../auth/auth';
import { parseJson } from '../db/database';
import { audit } from '../lib/audit';
import { encryptSecret, randomToken } from '../lib/crypto';
import { notFound } from '../lib/errors';
import { checkOutboundTarget, validateOutboundUrl } from '../lib/net';
import { nowIso, uuid } from '../lib/util';
import { logbookProviderDtos } from '../integrations/logbook-providers';

const OrgParams = Type.Object({ orgId: Type.String({ format: 'uuid' }) });
const EventSchema = Type.Union(WEBHOOK_EVENTS.map((e) => Type.Literal(e)));
const WebhookBody = Type.Object({
  url: Type.String({ minLength: 8, maxLength: 2000 }),
  events: Type.Array(EventSchema, { minItems: 1, uniqueItems: true }),
  active: Type.Optional(Type.Boolean()),
});
const WebhookPatch = Type.Partial(WebhookBody);
const LogbookBody = Type.Object({
  enabled: Type.Boolean(),
  /** A LogbookProvider id (GET /api/v2/integrations/logbook/providers); legacy "dronelogbook"/"generic" map to "json". */
  provider: Type.String({ minLength: 1, maxLength: 40 }),
  endpointUrl: Type.String({ maxLength: 2000 }),
  autoExport: Type.Boolean(),
  apiKey: Type.Optional(Nullable(Type.String({ maxLength: 500 }))),
});

const tag = { tags: ['integrations'] };

export function registerIntegrationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, webhooks, config } = ctx;

  const dto = (r: any): WebhookDto => ({
    id: r.id,
    url: r.url,
    events: parseJson(r.events, []),
    active: r.active === 1,
    createdAt: r.created_at,
    lastStatus: r.last_status,
    lastDeliveryAt: r.last_delivery_at,
  });
  const load = (orgId: string, id: string) => {
    const r = db.get('SELECT * FROM webhooks WHERE id = ? AND org_id = ?', id, orgId);
    if (!r) throw notFound('Webhook');
    return r as any;
  };

  app.get<{ Params: Static<typeof OrgParams> }>('/api/v2/organisations/:orgId/webhooks', { schema: { ...tag, params: OrgParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId, 'integrations.manage');
    return db.all('SELECT * FROM webhooks WHERE org_id = ? ORDER BY created_at', a.orgId).map(dto);
  });

  app.post<{ Params: Static<typeof OrgParams>; Body: Static<typeof WebhookBody> }>(
    '/api/v2/organisations/:orgId/webhooks',
    { schema: { ...tag, summary: 'Subscribe an HTTPS endpoint to events (telemetry & payload streaming, flights, alerts…)', params: OrgParams, body: WebhookBody } },
    async (req, reply) => {
      const a = orgAccess(db, req, req.params.orgId, 'integrations.manage');
      await checkOutboundTarget(validateOutboundUrl(req.body.url), ctx.allowPrivateTargets);
      const id = uuid();
      const secret = randomToken('whsec_', 24);
      db.run(
        'INSERT INTO webhooks (id, org_id, url, secret, events, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        a.orgId,
        req.body.url,
        encryptSecret(config.secretKey, secret),
        JSON.stringify(req.body.events),
        req.body.active ?? true,
        nowIso(),
      );
      webhooks.invalidate(a.orgId);
      audit(db, a.orgId, a.userId, 'webhook.create', id, { url: req.body.url, events: req.body.events });
      reply.code(201);
      const created: WebhookCreatedDto = { ...dto(load(a.orgId, id)), secret };
      return created;
    },
  );

  app.patch<{ Params: { orgId: string; webhookId: string }; Body: Static<typeof WebhookPatch> }>(
    '/api/v2/organisations/:orgId/webhooks/:webhookId',
    { schema: { ...tag, body: WebhookPatch } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId, 'integrations.manage');
      const w = load(a.orgId, req.params.webhookId);
      if (req.body.url) await checkOutboundTarget(validateOutboundUrl(req.body.url), ctx.allowPrivateTargets);
      db.run(
        'UPDATE webhooks SET url = ?, events = ?, active = ? WHERE id = ?',
        req.body.url ?? w.url,
        req.body.events ? JSON.stringify(req.body.events) : w.events,
        req.body.active ?? w.active === 1,
        w.id,
      );
      webhooks.invalidate(a.orgId);
      return dto(load(a.orgId, w.id));
    },
  );

  app.delete<{ Params: { orgId: string; webhookId: string } }>('/api/v2/organisations/:orgId/webhooks/:webhookId', { schema: tag }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId, 'integrations.manage');
    load(a.orgId, req.params.webhookId);
    db.run('DELETE FROM webhooks WHERE id = ?', req.params.webhookId);
    webhooks.invalidate(a.orgId);
    audit(db, a.orgId, a.userId, 'webhook.delete', req.params.webhookId);
    return { ok: true };
  });

  app.post<{ Params: { orgId: string; webhookId: string } }>('/api/v2/organisations/:orgId/webhooks/:webhookId/rotate-secret', { schema: tag }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId, 'integrations.manage');
    load(a.orgId, req.params.webhookId);
    const secret = randomToken('whsec_', 24);
    db.run('UPDATE webhooks SET secret = ? WHERE id = ?', encryptSecret(config.secretKey, secret), req.params.webhookId);
    webhooks.invalidate(a.orgId);
    return { secret };
  });

  app.post<{ Params: { orgId: string; webhookId: string } }>('/api/v2/organisations/:orgId/webhooks/:webhookId/test', { schema: { ...tag, summary: 'Send a test "ping" delivery' } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId, 'integrations.manage');
    load(a.orgId, req.params.webhookId);
    return { deliveryId: webhooks.sendTest(a.orgId, req.params.webhookId) };
  });

  app.get<{ Params: { orgId: string; webhookId: string } }>('/api/v2/organisations/:orgId/webhooks/:webhookId/deliveries', { schema: tag }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId, 'integrations.manage');
    load(a.orgId, req.params.webhookId);
    return db
      .all<any>('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 100', req.params.webhookId)
      .map(
        (r): WebhookDeliveryDto => ({
          id: r.id,
          event: r.event,
          statusCode: r.status_code,
          attempts: r.attempts,
          delivered: r.delivered === 1,
          error: r.error,
          createdAt: r.created_at,
          deliveredAt: r.delivered_at,
        }),
      );
  });

  // --- Logbook connector ----------------------------------------------------------------------

  app.get('/api/v2/integrations/logbook/providers', { schema: { ...tag, summary: 'Available logbook connector formats' } }, async (req) => {
    requireAuth(req);
    return logbookProviderDtos();
  });

  app.get<{ Params: Static<typeof OrgParams> }>(
    '/api/v2/organisations/:orgId/integrations/logbook/status',
    { schema: { ...tag, summary: 'Whether flights can be exported to a logbook (for every member; no settings)', params: OrgParams } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId);
      const c = ctx.logbook.get(a.orgId);
      return { enabled: c.enabled && !!c.endpointUrl };
    },
  );

  app.get<{ Params: Static<typeof OrgParams> }>('/api/v2/organisations/:orgId/integrations/logbook', { schema: { ...tag, params: OrgParams } }, async (req) => {
    const a = orgAccess(db, req, req.params.orgId, 'integrations.manage');
    return ctx.logbook.get(a.orgId);
  });

  app.put<{ Params: Static<typeof OrgParams>; Body: Static<typeof LogbookBody> }>(
    '/api/v2/organisations/:orgId/integrations/logbook',
    { schema: { ...tag, summary: 'Configure flight-log export to an external logbook', params: OrgParams, body: LogbookBody } },
    async (req) => {
      const a = orgAccess(db, req, req.params.orgId, 'integrations.manage');
      const res = await ctx.logbook.set(a.orgId, req.body);
      audit(db, a.orgId, a.userId, 'integration.logbook', null, { enabled: res.enabled, provider: res.provider, autoExport: res.autoExport });
      return res;
    },
  );
}
