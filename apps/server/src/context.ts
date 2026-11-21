import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config';
import type { Db } from './db/database';
import type { Mailer } from './lib/mailer';
import type { FileStorage } from './lib/storage';
import type { Hub } from './realtime/hub';
import type { FlightRecorder } from './flights/recorder';
import type { WebhookDispatcher } from './integrations/webhooks';
import type { TerrainService } from './geo/terrain';
import type { WeatherService } from './geo/weather';
import type { GeocoderService } from './geo/geocoder';
import type { LogbookExporter } from './integrations/logbook';
import type { AirspaceService } from './airspace/providers';

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
  weather: WeatherService;
  geocoder: GeocoderService;
  logbook: LogbookExporter;
  /** Merged airspace data of all providers (organisation zones + external feeds). */
  airspace: AirspaceService;
}
