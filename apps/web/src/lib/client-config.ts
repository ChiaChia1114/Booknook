import { api } from '../api/client';

/** Map services of this server (`GET /api/v2/config`, signed-in users). */
export interface ClientConfig {
  cesiumIonToken: string | null;
  terrain: boolean;
  /** Aerial imagery tiles are served (and cached) by this server. */
  imagery: boolean;
  weather: boolean;
}

let configPromise: Promise<ClientConfig> | null = null;

export function clientConfig(): Promise<ClientConfig> {
  configPromise ??= api<ClientConfig>('/api/v2/config').catch(() => ({ cesiumIonToken: null, terrain: false, imagery: false, weather: false }));
  return configPromise;
}

/** Esri World Imagery, fetched by the browser itself (public pages, or servers without the imagery cache). */
export const ESRI_IMAGERY_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
/** The same imagery through this server's tile cache: browsers only need to reach this server. */
export const SERVER_IMAGERY_URL = '/api/v2/tiles/imagery/{z}/{x}/{y}';
