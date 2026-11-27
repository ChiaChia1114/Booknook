import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config';
import type { Db } from './db/database';
import type { Mailer } from './lib/mailer';
import type { FileStorage } from './lib/storage';
import type { Hub } from './realtime/hub';
import type { FlightRecorder } from './flights/recorder';
import type { WebhookDispatcher } from './integrations/webhooks';
import type { TerrainService } from './geo/terrain';
import type { ImageryService } from './geo/imagery';
import type { TileBudget } from './geo/tile-store';
import type { RequestBudgets } from './auth/request-budget';
import type { WeatherService } from './geo/weather';
import type { GeocoderService } from './geo/geocoder';
import type { LogbookExporter } from './integrations/logbook';
import type { AirspaceService } from './airspace/providers';
import type { AuthorityService } from './airspace/authority';
import type { NotificationService } from './realtime/notifications';
import type { SwarmService } from './realtime/swarm';
import type { UtmMonitor } from './airspace/utm-monitor';
import type { Planner } from './planning/planner';
import type { VisionService } from './vision/vision-service';
import type { MaintenanceService } from './maintenance/maintenance-service';

/** Shared services handed to every route module. */
export interface AppContext {
  config: Config;
  db: Db;
  log: FastifyBaseLogger;
  mailer: Mailer;
  storage: FileStorage;
  webhooks: WebhookDispatcher;
  hub: Hub;
  recorder: FlightRecorder;
  terrain: TerrainService;
  imagery: ImageryService;
  /** API requests each member may still send (`api`; map and terrain tiles: `tiles`). */
  requestBudgets: { api: RequestBudgets; tiles: RequestBudgets };
  /** Tiles each user may have fetched from the imagery and terrain tile services. */
  tileBudgets: { imagery: TileBudget; terrain: TileBudget };
  weather: WeatherService;
  geocoder: GeocoderService;
  logbook: LogbookExporter;
  /** Merged airspace data of all providers (organisation zones + external feeds). */
  airspace: AirspaceService;
  /** Notification centre (UTM conformance, traffic, separation, drone and swarm alerts). */
  notifications: NotificationService;
  /** Real-time airspace conformance monitoring of airborne drones. */
  utm: UtmMonitor;
  /** The external flight authority (UTM service) deciding authorisation requests, if one is configured. */
  authority: AuthorityService;
  /** Swarm operations (formation / split missions with synchronisation). */
  swarms: SwarmService;
  /** AI vision on live video: detection, tracking, recognition, geolocation, follow-me. */
  vision: VisionService;
  /** Planning computations in a worker thread of their own (planning/planner.ts). */
  planner: Planner;
  /** Whether webhooks and integrations may target private networks (private deployments). */
  allowPrivateTargets: boolean;
  /** Maintenance schedules, log and predictive maintenance. */
  maintenance: MaintenanceService;
}
