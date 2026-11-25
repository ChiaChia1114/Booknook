import { api, errorMessage } from '../api/client';

/** Map services of this server (`GET /api/v2/config`, signed-in users). */
export interface ClientConfig {
  cesiumIonToken: string | null;
  terrain: boolean;
  /** Aerial imagery tiles are served (and cached) by this server. */
  imagery: boolean;
  weather: boolean;
  /** Why the server's map settings could not be loaded (the views use none of its services then). */
  error?: string;
}

let configPromise: Promise<ClientConfig> | null = null;

/** The server's map settings – read once; a failure is not kept: the next view asks again. */
export function clientConfig(): Promise<ClientConfig> {
  configPromise ??= api<ClientConfig>('/api/v2/config').catch((err) => {
    configPromise = null;
    return { cesiumIonToken: null, terrain: false, imagery: false, weather: false, error: errorMessage(err) };
  });
  return configPromise;
}

/** Esri World Imagery, fetched by the browser itself (public pages, or servers without the imagery cache). */
export const ESRI_IMAGERY_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
/** The same imagery through this server's tile cache: browsers only need to reach this server. */
export const SERVER_IMAGERY_URL = '/api/v2/tiles/imagery/{z}/{x}/{y}';
