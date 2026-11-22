import Fastify, { LogController, type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config';
import type { AppContext } from './context';
import { openDb } from './db/database';
import { authHook } from './auth/auth';
import { HttpError } from './lib/errors';
import { createMailer } from './lib/mailer';
import { FileStorage } from './lib/storage';
import { Hub } from './realtime/hub';
import { FlightRecorder } from './flights/recorder';
import { finalizeFlight } from './flights/finalize';
import { blockingMessages, checkMissionAirspace } from './airspace/mission-check';
import { getFlight } from './flights/flight-service';
import { WebhookDispatcher } from './integrations/webhooks';
import { LogbookExporter } from './integrations/logbook';
import { TerrainService } from './geo/terrain';
import { ImageryService } from './geo/imagery';
import { WeatherService } from './geo/weather';
import { GeocoderService } from './geo/geocoder';
import { AirspaceService, GeoJsonFeedProvider, OrgZoneProvider } from './airspace/providers';
import { registerAuthRoutes } from './routes/auth-routes';
import { registerOrgRoutes } from './routes/org-routes';
import { createFirmwareDownloadUrl, registerDroneRoutes } from './routes/drone-routes';
import { registerFlightRoutes } from './routes/flight-routes';
import { registerMissionRoutes } from './routes/mission-routes';
import { registerAirspaceRoutes } from './routes/airspace-routes';
import { registerAnalyticsRoutes } from './routes/analytics-routes';
import { registerIntegrationRoutes } from './routes/integration-routes';
import { registerRealtimeRoutes } from './routes/realtime-routes';
import { registerLinkRoutes } from './routes/link-routes';
import { registerPlanningRoutes } from './routes/planning-routes';
import { registerSwarmRoutes } from './routes/swarm-routes';
import { NotificationService } from './realtime/notifications';
import { SwarmService } from './realtime/swarm';
import { UtmMonitor, type UtmMonitorOptions } from './airspace/utm-monitor';
import { VisionService, type VisionOptions } from './vision/vision-service';
import { registerVisionRoutes } from './routes/vision-routes';
import { registerMaintenanceRoutes } from './routes/maintenance-routes';
import { MaintenanceService } from './maintenance/maintenance-service';

/**
 * Content-Security-Policy of the web application (defence in depth against XSS):
 * no inline scripts or event handlers; maps, terrain and Cesium ion are loaded over https.
 * 'unsafe-eval' is required by the Knockout bindings inside CesiumJS's Viewer widgets
 * (timeline, animation); injected markup still cannot run script because inline scripts
 * and inline event handlers stay blocked.
 */
export const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: https:",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

export interface BuildOptions {
  /** Injected fetch for outbound integrations (tests). */
  fetchImpl?: typeof fetch;
  /** Extra origins allowed to open cookie-authenticated WebSockets (e.g. a dev server). */
  allowedOrigins?: string[];
  /** Allow webhooks / logbook exports to private network targets. */
  allowPrivateTargets?: boolean;
  webhookRetryDelaysMs?: number[];
  logger?: boolean;
  /** UTM monitor timing (tests). */
  utm?: UtmMonitorOptions;
  /** AI vision backend and rate (tests run inference inline). */
  vision?: VisionOptions;
}

export async function buildApp(config: Config, opts: BuildOptions = {}): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    routerOptions: { ignoreTrailingSlash: true },
    bodyLimit: 10 * 1_048_576,
    trustProxy: config.trustProxy,
    logController: new LogController({ disableRequestLogging: process.env.ATHENA_LOG_REQUESTS !== '1' }),
  });

  const db = openDb(config.dbFile);
  const allowPrivate = opts.allowPrivateTargets ?? process.env.ATHENA_ALLOW_PRIVATE_TARGETS === '1';
  const ctx = { config, db, log: app.log, allowPrivateTargets: allowPrivate } as AppContext;
  ctx.storage = new FileStorage(config.dataDir);
  ctx.mailer = createMailer(db, config.smtpUrl, config.mailFrom, app.log);
  ctx.webhooks = new WebhookDispatcher(db, config.secretKey, app.log, {
    allowPrivateTargets: allowPrivate,
    fetchImpl: opts.fetchImpl,
    retryDelaysMs: opts.webhookRetryDelaysMs,
  });
  ctx.logbook = new LogbookExporter(db, config.secretKey, app.log, allowPrivate, opts.fetchImpl);
  ctx.terrain = new TerrainService({ urlTemplate: config.terrainUrl, cacheDir: join(config.dataDir, 'terrain-cache'), fetchImpl: opts.fetchImpl });
  ctx.imagery = new ImageryService({ urlTemplate: config.imageryUrl, cacheDir: join(config.dataDir, 'imagery-cache'), fetchImpl: opts.fetchImpl });
  ctx.weather = new WeatherService({ url: config.weatherUrl, fetchImpl: opts.fetchImpl });
  ctx.geocoder = new GeocoderService({ url: config.geocoderUrl, fetchImpl: opts.fetchImpl, log: app.log });
  ctx.airspace = new AirspaceService([
    new OrgZoneProvider(db),
    ...config.airspaceFeeds.map(
      (f) => new GeoJsonFeedProvider({ id: f.id, name: f.name, url: f.url, refreshMs: f.refreshMinutes * 60_000, log: app.log, fetchImpl: opts.fetchImpl }),
    ),
  ]);
  ctx.airspace.start();
  ctx.recorder = new FlightRecorder({
    db,
    sampleHz: config.sampleHz,
    linkLossGraceS: config.linkLossGraceS,
    log: app.log,
    onFlightState: (orgId, droneId, flightId, state) => {
      ctx.hub.broadcast(orgId, { type: 'flight', droneId, flightId, state: state === 'ended' ? 'ended' : 'started' }, droneId);
      if (state === 'started') ctx.webhooks.emit(orgId, 'flight.started', { flight: getFlight(db, orgId, flightId) });
    },
    onFlightClosed: (flightId) => {
      setImmediate(() => {
        try {
          finalizeFlight(ctx, flightId);
        } catch (err) {
          app.log.error({ err, flightId }, 'post-flight processing failed');
        }
      });
    },
  });
  ctx.hub = new Hub({
    db,
    recorder: ctx.recorder,
    webhooks: ctx.webhooks,
    log: app.log,
    publicUrl: config.publicUrl,
    firmwareDownloadUrl: (updateId) => createFirmwareDownloadUrl(ctx, updateId),
  });
  // A mission is checked again from where the drone starts it (see Hub.sendCommand).
  ctx.hub.missionStartCheck = (orgId, droneId, plan) => {
    const check = checkMissionAirspace(db, ctx.airspace, orgId, plan, { droneId });
    return check?.verdict === 'blocked' ? blockingMessages(check.conflicts).join('; ') : null;
  };
  ctx.notifications = new NotificationService({ db, hub: ctx.hub, webhooks: ctx.webhooks });
  ctx.utm = new UtmMonitor(
    { db, hub: ctx.hub, airspace: ctx.airspace, notifications: ctx.notifications, sameSwarm: (a, b) => ctx.swarms.sameOperation(a, b) },
    opts.utm,
  );
  ctx.swarms = new SwarmService({ db, hub: ctx.hub, notifications: ctx.notifications, webhooks: ctx.webhooks, airspace: ctx.airspace });
  ctx.vision = new VisionService({ hub: ctx.hub, recorder: ctx.recorder, log: app.log }, opts.vision);
  ctx.maintenance = new MaintenanceService({ db, notifications: ctx.notifications });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: config.maxUploadMb * 1_048_576, files: 50, fields: 50 } });
  await app.register(websocket, { options: { maxPayload: 8 * 1_048_576 } });
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Athena-sky API',
        version: '2.0.0',
        description:
          'REST API of the Athena-sky drone cloud: organisations, fleets, drones, flights & logs, missions, airspace & UTM, firmware OTA, analytics and integrations. ' +
          'Authenticate with a personal API token: `Authorization: Bearer ast_…`. Real-time data is available over the Athena Live WebSocket (`/api/v2/live?org=<id>`).',
      },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' }, cookieAuth: { type: 'apiKey', in: 'cookie', name: 'athena_session' } } },
      security: [{ bearerAuth: [] }, { cookieAuth: [] }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/api/v2/docs', uiConfig: { deepLinking: true } });

  app.decorateRequest('auth', null);
  app.addHook('onRequest', authHook(db));
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    // Other sites get the origin only (never a path or query, which can carry a token): map tile
    // servers require it – OpenStreetMap answers requests without a Referer with "Access blocked".
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    // No page of the service (the app, the API reference, reports) may be framed (clickjacking).
    reply.header('x-frame-options', 'DENY');
    if (req.url.startsWith('/api/')) reply.header('cache-control', reply.getHeader('cache-control') ?? 'no-store');
    return payload;
  });

  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) });
    }
    const fe = err as FastifyError;
    if (fe.validation) return reply.code(400).send({ error: 'validation_error', message: fe.message });
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      return reply.code(fe.statusCode).send({ error: fe.code ?? 'error', message: fe.message });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error', message: 'Internal server error' });
  });

  app.get('/api/v2/schema', { schema: { hide: true } }, async () => app.swagger());
  app.get('/swagger', { schema: { hide: true } }, async (_req, reply) => reply.redirect('/api/v2/docs/'));
  app.get('/healthz', { schema: { hide: true } }, async () => ({ ok: true }));

  const allowedOrigins = [...(opts.allowedOrigins ?? []), ...(process.env.ATHENA_ALLOWED_ORIGINS?.split(',').filter(Boolean) ?? [])];
  registerAuthRoutes(app, ctx);
  registerOrgRoutes(app, ctx);
  registerDroneRoutes(app, ctx);
  registerFlightRoutes(app, ctx);
  registerMissionRoutes(app, ctx);
  registerAirspaceRoutes(app, ctx);
  registerAnalyticsRoutes(app, ctx);
  registerIntegrationRoutes(app, ctx);
  registerPlanningRoutes(app, ctx);
  registerSwarmRoutes(app, ctx);
  registerVisionRoutes(app, ctx);
  registerMaintenanceRoutes(app, ctx);
  registerRealtimeRoutes(app, ctx, allowedOrigins);
  await registerLinkRoutes(app, ctx);

  // Web application (single-page app) with history-API fallback.
  const webDist = config.webDist;
  if (webDist && existsSync(join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false, index: false, maxAge: '1h' });
    app.get('/*', { schema: { hide: true } }, async (req, reply) => {
      const path = decodeURIComponent((req.params as { '*': string })['*'] ?? '');
      if (path && !path.includes('..') && existsSync(join(webDist, path)) && !path.endsWith('/')) {
        if (path.startsWith('assets/') || path.startsWith('cesium/')) reply.header('cache-control', 'public, max-age=31536000, immutable');
        return reply.sendFile(path);
      }
      if (path.startsWith('api/')) return reply.code(404).send({ error: 'not_found', message: 'Route not found' });
      reply.header('cache-control', 'no-cache');
      reply.header('content-security-policy', WEB_CSP);
      return reply.sendFile('index.html');
    });
  }
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'not_found', message: `Route ${req.method} ${req.url.split('?')[0]} not found` }));

  app.addHook('onClose', async () => {
    ctx.hub.shutdown();
    ctx.vision.shutdown();
    ctx.maintenance.stop();
    ctx.notifications.stop();
    ctx.recorder.shutdown();
    ctx.airspace.stop();
    ctx.webhooks.stop();
    db.close();
  });
  return { app, ctx };
}
