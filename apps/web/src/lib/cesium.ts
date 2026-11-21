/**
 * Shared CesiumJS set-up for the 3D views (mission planner, live 3D view, flight replay).
 *
 * Terrain, in order of preference:
 *  1. Cesium World Terrain (Cesium ion, when the server provides an ion token);
 *  2. the self-hosted Terrarium DEM served (and cached) by the Athena-sky server;
 *  3. a flat ellipsoid (offline).
 * Imagery: OpenStreetMap, or aerial imagery (Bing Maps through Cesium ion, else Esri).
 * 3D buildings: Cesium OSM Buildings (ion).
 *
 * Heights: mission and telemetry altitudes are relative to home. Views position objects at
 * "terrain height at home (as rendered) + relative altitude", which stays consistent whatever
 * the vertical datum of the terrain (ion terrain is ellipsoidal, the DEM is above sea level).
 */
import * as Cesium from 'cesium';
import { api } from '../api/client';

export interface ClientConfig {
  cesiumIonToken: string | null;
  terrain: boolean;
  weather: boolean;
}

let configPromise: Promise<ClientConfig> | null = null;

export function clientConfig(): Promise<ClientConfig> {
  configPromise ??= api<ClientConfig>('/api/v2/config').catch(() => ({ cesiumIonToken: null, terrain: false, weather: false }));
  return configPromise;
}

export type TerrainKind = 'ion' | 'dem' | 'flat';

export const TERRAIN_LABEL: Record<TerrainKind, string> = {
  ion: 'Cesium World Terrain',
  dem: '3D DEM',
  flat: 'flat (offline)',
};

// ----------------------------------------------------------------------------------------
// Terrarium DEM tiles served by the Athena-sky server
// ----------------------------------------------------------------------------------------

const tileCache = new Map<string, Promise<Float32Array | null>>();

function loadTerrarium(z: number, x: number, y: number): Promise<Float32Array | null> {
  const key = `${z}/${x}/${y}`;
  let p = tileCache.get(key);
  if (!p) {
    p = (async () => {
      try {
        const res = await fetch(`/api/v2/terrain/tiles/${z}/${x}/${y}.png`, { credentials: 'same-origin' });
        if (!res.ok) return null;
        const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(bmp, 0, 0);
        const d = ctx.getImageData(0, 0, 256, 256).data;
        const out = new Float32Array(256 * 256);
        for (let i = 0; i < out.length; i++) out[i] = d[i * 4]! * 256 + d[i * 4 + 1]! + d[i * 4 + 2]! / 256 - 32768;
        return out;
      } catch {
        return null;
      }
    })();
    tileCache.set(key, p);
    if (tileCache.size > 256) tileCache.delete(tileCache.keys().next().value!);
  }
  return p;
}

async function demTerrain(): Promise<Cesium.TerrainProvider | null> {
  try {
    const status = await api<{ enabled: boolean }>('/api/v2/terrain');
    if (!status.enabled) return null;
    const probe = await fetch('/api/v2/terrain/tiles/0/0/0.png', { credentials: 'same-origin' });
    if (!probe.ok) return null;
  } catch {
    return null;
  }
  const N = 65;
  return new Cesium.CustomHeightmapTerrainProvider({
    width: N,
    height: N,
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    callback: async (x: number, y: number, level: number) => {
      const zt = Math.min(level, 14);
      const scale = 2 ** (level - zt);
      const px = await loadTerrarium(zt, Math.floor(x / scale), Math.floor(y / scale));
      const out = new Float32Array(N * N);
      if (!px) return out;
      const ox = (x % scale) / scale;
      const oy = (y % scale) / scale;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const u = Math.min(255, Math.max(0, (ox + i / (N - 1) / scale) * 256 - 0.5));
          const v = Math.min(255, Math.max(0, (oy + j / (N - 1) / scale) * 256 - 0.5));
          const x0 = Math.floor(u);
          const y0 = Math.floor(v);
          const x1 = Math.min(255, x0 + 1);
          const y1 = Math.min(255, y0 + 1);
          const fx = u - x0;
          const fy = v - y0;
          out[j * N + i] =
            px[y0 * 256 + x0]! * (1 - fx) * (1 - fy) + px[y0 * 256 + x1]! * fx * (1 - fy) + px[y1 * 256 + x0]! * (1 - fx) * fy + px[y1 * 256 + x1]! * fx * fy;
        }
      }
      return out;
    },
  });
}

export async function createTerrain(cfg: ClientConfig): Promise<{ provider: Cesium.TerrainProvider; kind: TerrainKind }> {
  if (cfg.cesiumIonToken) {
    try {
      Cesium.Ion.defaultAccessToken = cfg.cesiumIonToken;
      const provider = await Cesium.CesiumTerrainProvider.fromIonAssetId(1, { requestVertexNormals: true });
      return { provider, kind: 'ion' };
    } catch {
      /* ion unreachable: fall back to the self-hosted DEM */
    }
  }
  const dem = await demTerrain();
  if (dem) return { provider: dem, kind: 'dem' };
  return { provider: new Cesium.EllipsoidTerrainProvider(), kind: 'flat' };
}

// ----------------------------------------------------------------------------------------
// Imagery and buildings
// ----------------------------------------------------------------------------------------

export type ImageryKind = 'map' | 'satellite';

export const osmImagery = () =>
  new Cesium.UrlTemplateImageryProvider({ url: import.meta.env.VITE_TILE_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maximumLevel: 19, credit: '© OpenStreetMap contributors' });

const esriImagery = () =>
  new Cesium.UrlTemplateImageryProvider({ url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maximumLevel: 19, credit: 'Tiles © Esri' });

export async function imageryProvider(kind: ImageryKind, cfg: ClientConfig): Promise<Cesium.ImageryProvider> {
  if (kind === 'map') return osmImagery();
  if (cfg.cesiumIonToken) {
    try {
      Cesium.Ion.defaultAccessToken = cfg.cesiumIonToken;
      return await Cesium.IonImageryProvider.fromAssetId(2);
    } catch {
      /* fall back */
    }
  }
  return esriImagery();
}

export async function setImagery(viewer: Cesium.Viewer, kind: ImageryKind, cfg: ClientConfig): Promise<void> {
  const provider = await imageryProvider(kind, cfg);
  if (viewer.isDestroyed()) return;
  viewer.imageryLayers.removeAll();
  viewer.imageryLayers.addImageryProvider(provider);
}

/** Adds Cesium OSM Buildings (ion only). Returns null when unavailable. */
export async function addOsmBuildings(viewer: Cesium.Viewer, cfg: ClientConfig): Promise<Cesium.Cesium3DTileset | null> {
  if (!cfg.cesiumIonToken) return null;
  try {
    Cesium.Ion.defaultAccessToken = cfg.cesiumIonToken;
    const tileset = await Cesium.createOsmBuildingsAsync();
    if (viewer.isDestroyed()) return null;
    viewer.scene.primitives.add(tileset);
    return tileset;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------------------
// Viewer
// ----------------------------------------------------------------------------------------

export interface ViewerOptions {
  timeline?: boolean;
  animation?: boolean;
  imagery?: ImageryKind;
}

export interface AthenaViewer {
  viewer: Cesium.Viewer;
  terrain: TerrainKind;
  config: ClientConfig;
}

export async function createViewer(host: HTMLElement, opts: ViewerOptions = {}): Promise<AthenaViewer> {
  const config = await clientConfig();
  const { provider, kind } = await createTerrain(config);
  const imagery = await imageryProvider(opts.imagery ?? 'map', config);
  const viewer = new Cesium.Viewer(host, {
    baseLayer: new Cesium.ImageryLayer(imagery),
    terrainProvider: provider,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: opts.animation ?? false,
    timeline: opts.timeline ?? false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    shouldAnimate: false,
  });
  viewer.scene.globe.depthTestAgainstTerrain = kind !== 'flat';
  return { viewer, terrain: kind, config };
}

/** Rendered terrain heights (m) at positions, in the vertical datum of the viewer's terrain. */
export async function terrainHeights(viewer: Cesium.Viewer, points: { lat: number; lon: number }[]): Promise<number[]> {
  if (points.length === 0) return [];
  if (viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider) return points.map(() => 0);
  const carto = points.map((p) => Cesium.Cartographic.fromDegrees(p.lon, p.lat));
  try {
    const out = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, carto);
    return out.map((c) => (Number.isFinite(c.height) ? c.height : 0));
  } catch {
    return points.map(() => 0);
  }
}

// ----------------------------------------------------------------------------------------
// Drone models
// ----------------------------------------------------------------------------------------

export type DroneModel = 'quadcopter' | 'hexacopter' | 'vtol';

export const droneModelUri = (m: DroneModel | null | undefined) => `/models/${m ?? 'quadcopter'}.glb`;

/**
 * Model orientation from compass heading, pitch and roll (degrees). The glTF models point
 * their nose along +X, which Cesium's heading-pitch-roll frame aligns with east at heading 0.
 */
export function droneOrientation(position: Cesium.Cartesian3, headingDeg: number, pitchDeg = 0, rollDeg = 0): Cesium.Quaternion {
  const hpr = new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(headingDeg - 90), Cesium.Math.toRadians(pitchDeg), Cesium.Math.toRadians(rollDeg));
  return Cesium.Transforms.headingPitchRollQuaternion(position, hpr);
}
