import Fastify, { LogController, type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import { cleanName } from '@athena-sky/shared';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config';
import type { AppContext } from './context';
import { openDb } from './db/database';
import { authHook } from './auth/auth';
import { HttpError, badRequest } from './lib/errors';
import { createMailer } from './lib/mailer';
import { FileStorage } from './lib/storage';
import { Hub } from './realtime/hub';
import { FlightRecorder } from './flights/recorder';
import { discardInterruptedImports } from './flights/import';
import { finalizeFlight } from './flights/finalize';
import { blockingMessages, checkMissionAirspaceAsync } from './airspace/mission-check';
import { getFlight } from './flights/flight-service';
import { WebhookDispatcher } from './integrations/webhooks';
import { LogbookExporter } from './integrations/logbook';
import { TerrainService } from './geo/terrain';
import { ImageryService } from './geo/imagery';
import { TileBudget } from './geo/tile-store';
import { RequestBudgets, refuseTooMany } from './auth/request-budget';
import { turns, userWork, workOwner } from './lib/turns';
import { hasLongList, jsonPartsSteps, partsBody } from './lib/json-parts';
import { runSliced } from './lib/slice';
import { Planner } from './planning/planner';
import { WeatherService } from './geo/weather';
import { GeocoderService } from './geo/geocoder';
import { AirspaceService, FEED_LOG_MAX, GeoJsonFeedProvider, OrgZoneProvider } from './airspace/providers';
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
import { AuthorityService, HttpFlightAuthority, type FlightAuthority } from './airspace/authority';
import { AUTH_SELECT, authorizationDto } from './airspace/airspace-service';
import { audit } from './lib/audit';
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
  /** External flight authority instead of the configured one (tests); null: none. */
  authority?: FlightAuthority | null;
  /** How often open exchanges with the flight authority are followed (tests). */
  authorityPollMs?: number;
}

/** Fields of request bodies stored without surrounding spaces. */
const TRIMMED_FIELDS = ['name', 'organisationName', 'title'] as const;

/**
 * The path a request was routed to: its route's pattern – or, with no route, its path as the router
 * reads it (an absolute-form target's scheme and host left out, %-escapes decoded). The live
 * connection, the drone link, tiles and the API are told apart by it: never by the request target
 * as written (`http://host/api/…`, `/%61pi/…` are routed as `/api/…` too).
 */
export function routedPath(req: FastifyRequest): string {
  const route = req.routeOptions.url;
  if (route) return route;
  let path = req.url.split('?')[0]!.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '') || '/';
  try {
    path = decodeURIComponent(path);
  } catch {
    // Kept as written (the router answers it).
  }
  return path;
}

/** The live connection (its own limits) and the drone link: real time, no turns. */
const REAL_TIME_ROUTES = new Set(['/api/v2/live', '/api/v2/link']);
/** Map and terrain tiles (an allowance of their own). */
const TILE_ROUTE = /^\/api\/v2\/(?:tiles|terrain\/tiles)\//;
/** Largest JSON body (bytes): read in a turn of its own (see lib/turns.ts), in a few ms. */
export const JSON_BODY_LIMIT = 1_048_576;

/** Whose work a request is (see lib/turns.ts): its member's – or, not signed in, its address's. */
function ownerOf(req: FastifyRequest): string {
  return req.auth ? `user:${req.auth.user.id}` : `ip:${req.ip}`;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export async function buildApp(config: Config, opts: BuildOptions = {}): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    routerOptions: { ignoreTrailingSlash: true },
    bodyLimit: JSON_BODY_LIMIT,
    trustProxy: config.trustProxy,
    logController: new LogController({ disableRequestLogging: process.env.ATHENA_LOG_REQUESTS !== '1' }),
  });

  const db = openDb(config.dbFile);
  const allowPrivate = opts.allowPrivateTargets ?? process.env.ATHENA_ALLOW_PRIVATE_TARGETS === '1';
  const ctx = { config, db, log: app.log, allowPrivateTargets: allowPrivate } as AppContext;
  ctx.storage = new FileStorage(config.dataDir);
  // Logs whose import the last run did not finish: removed, so they can be uploaded again.
  const interrupted = discardInterruptedImports(db, ctx.storage);
  if (interrupted) app.log.warn({ flights: interrupted }, 'removed flights whose log import was interrupted');
  ctx.mailer = createMailer(db, config.smtpUrl, config.mailFrom, app.log);
  ctx.webhooks = new WebhookDispatcher(db, config.secretKey, app.log, {
    allowPrivateTargets: allowPrivate,
    fetchImpl: opts.fetchImpl,
    retryDelaysMs: opts.webhookRetryDelaysMs,
  });
  ctx.logbook = new LogbookExporter(db, config.secretKey, app.log, allowPrivate, opts.fetchImpl);
  ctx.terrain = new TerrainService({ urlTemplate: config.terrainUrl, cacheDir: join(config.dataDir, 'terrain-cache'), maxBytes: config.terrainCacheMb * 1_048_576, fetchImpl: opts.fetchImpl });
  ctx.imagery = new ImageryService({ urlTemplate: config.imageryUrl, cacheDir: join(config.dataDir, 'imagery-cache'), maxBytes: config.imageryCacheMb * 1_048_576, fetchImpl: opts.fetchImpl });
  ctx.tileBudgets = { imagery: new TileBudget(config.tileFetchesPerHour), terrain: new TileBudget(config.tileFetchesPerHour) };
  ctx.requestBudgets = {
    api: new RequestBudgets(config.apiRequestsPerS, config.apiRequestBurst),
    tiles: new RequestBudgets(config.apiRequestsPerS * 10, config.apiRequestBurst * 10),
  };
  ctx.weather = new WeatherService({ url: config.weatherUrl, fetchImpl: opts.fetchImpl });
  ctx.geocoder = new GeocoderService({ url: config.geocoderUrl, fetchImpl: opts.fetchImpl, log: app.log });
  // The planning worker (waypoint generators, simulation, optimisation, mission files, GeoJSON –
  // also airspace feeds): computations that never run on the event loop.
  ctx.planner = new Planner(app.log);
  ctx.airspace = new AirspaceService([
    new OrgZoneProvider(db),
    ...config.airspaceFeeds.map(
      (f) =>
        new GeoJsonFeedProvider({
          id: f.id,
          name: f.name,
          url: f.url,
          refreshMs: f.refreshMinutes * 60_000,
          log: app.log,
          fetchImpl: opts.fetchImpl,
          parse: (bytes, maxFeatures) => ctx.planner.run('parseFeed', { bytes, maxFeatures, logMax: FEED_LOG_MAX }, `feed:${f.id}`),
        }),
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
        finalizeFlight(ctx, flightId).catch((err) => app.log.error({ err, flightId }, 'post-flight processing failed'));
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
  // The member's work (also when a swarm operation or follow-me sends it): it never waits behind the
  // cloud's background work, such as the processing of flights just ended.
  ctx.hub.missionStartCheck = (orgId, droneId, plan, userId) =>
    workOwner.run(userWork(userId), async () => {
      const check = await checkMissionAirspaceAsync(db, ctx.airspace, orgId, plan, { droneId });
      return check?.verdict === 'blocked' ? blockingMessages(check.conflicts).join('; ') : null;
    });
  ctx.notifications = new NotificationService({ db, hub: ctx.hub, webhooks: ctx.webhooks });
  ctx.utm = new UtmMonitor(
    { db, hub: ctx.hub, airspace: ctx.airspace, notifications: ctx.notifications, sameSwarm: (a, b) => ctx.swarms.sameOperation(a, b) },
    opts.utm,
  );
  ctx.swarms = new SwarmService({ db, hub: ctx.hub, notifications: ctx.notifications, webhooks: ctx.webhooks, airspace: ctx.airspace, planner: ctx.planner });
  const ua = config.utmAuthority;
  const authority = opts.authority !== undefined ? opts.authority : ua ? new HttpFlightAuthority({ name: ua.name, url: ua.url, key: ua.key, fetchImpl: opts.fetchImpl }) : null;
  ctx.authority = new AuthorityService(
    {
      db,
      airspace: ctx.airspace,
      log: app.log,
      onChange: (c) => {
        ctx.utm.invalidate(c.orgId);
        const row = db.get<any>(`${AUTH_SELECT} WHERE a.id = ?`, c.authId);
        const dto = authorizationDto(row, ctx.authority.decides(row));
        audit(db, c.orgId, null, `authorization.authority.${c.to}`, c.authId, { reference: c.reference, authority: dto.authority, reason: c.reason });
        ctx.webhooks.emit(c.orgId, 'authorization.updated', { authorization: dto });
        const verb = c.to === 'approved' ? 'approved' : c.to === 'cancelled' ? 'withdrawn' : 'rejected';
        ctx.notifications.create(c.orgId, {
          level: c.to === 'approved' ? 'info' : 'warning',
          category: 'airspace',
          code: `authorization_${verb}`,
          droneId: c.droneId,
          title: `Flight authorisation ${c.reference} ${verb}${dto.authority ? ` by ${dto.authority}` : ''}`,
          message: c.reason ?? '',
          data: { authorizationId: c.authId, reference: c.reference },
        });
      },
    },
    authority,
    opts.authorityPollMs ?? (ua?.pollSeconds ?? 15) * 1000,
    // Tests that set the interval poll themselves.
    opts.authorityPollMs ?? 1000,
  );
  ctx.authority.start();
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
  // No member can keep the cloud busy with requests – so many a second at most, over all their
  // sessions and API tokens (map and terrain tiles ten times as many; the live connection has its
  // own limits): more are refused before anything is done for them, answered after a second.
  app.addHook('onRequest', async (req, reply) => {
    const path = routedPath(req);
    if (!req.auth || !path.startsWith('/api/') || REAL_TIME_ROUTES.has(path)) return;
    const tiles = TILE_ROUTE.test(path);
    if (!(tiles ? ctx.requestBudgets.tiles : ctx.requestBudgets.api).take(req.auth.user.id)) {
      await refuseTooMany(reply, tiles ? 'Too many map tiles asked for at once – wait a moment and try again' : 'Too many requests at once – wait a moment and try again');
    }
  });
  // Whose work the request is: its turns and long computations are counted to it (lib/turns.ts).
  app.addHook('onRequest', (req, _reply, done) => {
    workOwner.run(ownerOf(req), done);
  });
  // A JSON body is read in a turn of its own (it takes a few ms per MiB) – and at most 1 MiB.
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: JSON_BODY_LIMIT }, async (req: FastifyRequest, body: string | Buffer) => {
    await turns.next(ownerOf(req));
    return new Promise((resolve, reject) => parseJson(req, body as string, (err: Error | null, value?: unknown) => (err ? reject(err) : resolve(value))));
  });
  // Every API request is handled in a turn of its own, members in turn (lib/turns.ts): however
  // many there are, the live connections' messages are handled between them.
  app.addHook('preHandler', async (req) => {
    const path = routedPath(req);
    if (path.startsWith('/api/') && !REAL_TIME_ROUTES.has(path)) await turns.next(ownerOf(req));
  });
  // A long JSON answer – a list of hundreds of items – is written a part at a time, each part in a
  // turn of its own (lib/json-parts.ts): never in one go while the live connections wait.
  app.addHook('preSerialization', async (_req, reply, payload) => {
    if (!hasLongList(payload)) return payload;
    const parts = await runSliced(jsonPartsSteps(payload));
    reply.serializer((written: unknown) => written as string);
    return partsBody(parts);
  });
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    // Other sites get the origin only (never a path or query, which can carry a token): map tile
    // servers require it – OpenStreetMap answers requests without a Referer with "Access blocked".
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    // No page of the service (the app, the API reference, reports) may be framed (clickjacking).
    reply.header('x-frame-options', 'DENY');
    if (routedPath(req).startsWith('/api/')) reply.header('cache-control', reply.getHeader('cache-control') ?? 'no-store');
    return payload;
  });

  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) });
    }
    const fe = err as FastifyError;
    // More than a request may carry: said with how much may go at once (a file to import, split).
    if (fe.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      const json = /json/i.test(String(req.headers['content-type'] ?? ''));
      return reply.code(413).send({
        error: 'too_large',
        message: json ? `Too large: at most ${JSON_BODY_LIMIT / 1_048_576} MiB can be sent at once – split it into smaller parts` : 'Too large to be sent at once',
      });
    }
    // An address naming something that cannot exist (an id that is no id): nothing is there.
    const notAnId = (v: { keyword?: string; params?: { format?: string } }) => v.keyword === 'format' && v.params?.format === 'uuid';
    if (fe.validation && fe.validationContext === 'params' && fe.validation.every(notAnId)) return reply.code(404).send({ error: 'not_found', message: 'Not found' });
    if (fe.validation) return reply.code(400).send({ error: 'validation_error', message: fe.message });
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      return reply.code(fe.statusCode).send({ error: fe.code ?? 'error', message: fe.message });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error', message: 'Internal server error' });
  });

  // Whole numbers in query strings (limit, offset, days …) are written plainly: the validator
  // would otherwise read "0x10", "1e2" or " 5" as numbers.
  app.addHook('preValidation', async (req) => {
    const props = (req.routeOptions.schema?.querystring as { properties?: Record<string, { type?: unknown }> } | undefined)?.properties;
    if (!props) return;
    for (const [key, v] of Object.entries((req.query ?? {}) as Record<string, unknown>)) {
      if (typeof v === 'string' && props[key]?.type === 'integer' && !/^-?\d+$/.test(v)) {
        throw new HttpError(400, 'validation_error', `querystring/${key} must be a whole number`);
      }
    }
  });

  // Names and titles are kept without invisible characters around them (spaces, zero-width
  // characters …) – and a name of such characters alone is no name (refused by the schemas'
  // minimum length, which is checked after this).
  app.addHook('preValidation', async (req) => {
    const body = req.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return;
    for (const field of TRIMMED_FIELDS) {
      const v = body[field];
      if (typeof v === 'string') body[field] = cleanName(v);
    }
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
    // Files are looked up per request; their caching is decided below (not by the plugin).
    await app.register(fastifyStatic, { root: webDist, serve: false, cacheControl: false, dotfiles: 'deny' });
    app.get('/*', { schema: { hide: true } }, async (req, reply) => {
      let path = '';
      try {
        path = decodeURIComponent((req.params as { '*': string })['*'] ?? '');
      } catch {
        throw badRequest('Malformed path');
      }
      if (path.startsWith('api/')) return reply.code(404).send({ error: 'not_found', message: 'Route not found' });
      if (path && !path.includes('..') && !path.endsWith('/') && isFile(join(webDist, path))) {
        // Vite's bundles have content hashes in their names and never change; every other file
        // (Cesium's workers and assets, the 3D models) is checked again when used, so a new
        // version of the server is picked up at once.
        reply.header('cache-control', path.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
        return reply.sendFile(path);
      }
      // A file of the application that does not exist – e.g. a bundle of the version a browser
      // still has open: a 404, not the application page in its place.
      if (/^(assets|cesium|models)(\/|$)/.test(path) || /\.[a-z0-9]{1,8}$/i.test(path)) {
        return reply.code(404).send({ error: 'not_found', message: 'File not found' });
      }
      // The application page is checked again on every visit (it names the current bundles).
      reply.header('cache-control', 'no-cache');
      reply.header('content-security-policy', WEB_CSP);
      return reply.sendFile('index.html');
    });
  }
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'not_found', message: `Route ${req.method} ${req.url.split('?')[0]} not found` }));

  app.addHook('onClose', async () => {
    ctx.hub.shutdown();
    ctx.vision.shutdown();
    ctx.planner.shutdown();
    ctx.maintenance.stop();
    ctx.notifications.stop();
    ctx.recorder.shutdown();
    ctx.airspace.stop();
    ctx.utm.stop();
    await ctx.authority.stop();
    ctx.webhooks.stop();
    db.close();
  });
  return { app, ctx };
}
