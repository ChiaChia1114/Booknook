import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { orgAccess } from '../auth/auth';
import { forbidden, unauthorized } from '../lib/errors';

/** Rejects cross-site WebSocket upgrades for cookie-authenticated viewers. */
function checkOrigin(req: FastifyRequest, publicUrl: string, extra: string[]): void {
  const origin = req.headers.origin;
  if (!origin) return; // non-browser clients
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    throw forbidden('Invalid Origin');
  }
  const allowed = new Set([req.headers.host, new URL(publicUrl).host, ...extra.map((o) => new URL(o).host)]);
  if (!allowed.has(host)) throw forbidden('Cross-origin WebSocket connection refused');
}

export function registerRealtimeRoutes(app: FastifyInstance, ctx: AppContext, allowedOrigins: string[]): void {
  const { hub, db, config } = ctx;

  // Athena Link: drones connect here (Authorization: Bearer <drone link key>, or a first {type:'auth'} message).
  app.get('/api/v2/link', { websocket: true, schema: { tags: ['link'], summary: 'Athena Link WebSocket for drones (see docs/LINK_PROTOCOL.md)' } }, (socket, req) => {
    hub.handleLinkConnection(socket, req);
  });

  // Athena Live: browsers and integrations connect here (session cookie or API token), ?org=<organisation id>.
  app.get<{ Querystring: { org?: string } }>(
    '/api/v2/live',
    {
      websocket: true,
      schema: { tags: ['realtime'], summary: 'Athena Live WebSocket: live telemetry, video and control of drones (see docs/LINK_PROTOCOL.md)' },
      preValidation: async (req) => {
        if (!req.auth) throw unauthorized();
        if (req.auth.via === 'session') checkOrigin(req, config.publicUrl, allowedOrigins);
        orgAccess(db, req, String(req.query.org ?? ''), 'live.view');
      },
    },
    (socket, req) => {
      const a = orgAccess(db, req, String(req.query.org ?? ''), 'live.view');
      hub.handleLiveConnection(socket, { orgId: a.orgId, userId: a.userId, userName: a.userName, role: a.role, via: req.auth!.via });
    },
  );
}
