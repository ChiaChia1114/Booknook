/**
 * 3D mission planner (CesiumJS): add waypoints interactively, view the plan from any
 * perspective (rotate, tilt, surface view, orthographic top view), drag waypoints
 * horizontally and – with Shift – vertically, with terrain, airspace volumes and
 * ground hazards rendered in 3D.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import {
  centroidOf,
  generateSurvey,
  haversineDistance,
  initialBearing,
  missionPath,
  missionStats,
  newItemId,
  validateMission,
  type AirspaceCheckDto,
  type AirspaceZoneDto,
  type AuthorizationDto,
  type DroneDto,
  type LatLon,
  type MemberDto,
  type MissionDto,
  type MissionItem,
  type MissionItemType,
  type MissionPlan,
  type TerrainSummary,
  type ZoneType,
} from '@athena-sky/shared';
import { api, download, errorMessage } from '../api/client';
import { useApi } from '../hooks';
import { useAuth, useOrgId } from '../state/auth';
import { useLive } from '../state/live';
import { TerrainProfile } from '../components/charts';
import { Badge, ErrorBox, Loading, Modal, fmtDistance, fmtDuration, useToast } from '../components/ui';

type Mode = 'select' | 'waypoint' | 'rally' | 'geofence' | 'survey' | 'home';

const COLORS = {
  path: Cesium.Color.fromCssColorString('#38bdf8'),
  wp: Cesium.Color.fromCssColorString('#38bdf8'),
  selected: Cesium.Color.fromCssColorString('#facc15'),
  home: Cesium.Color.fromCssColorString('#60a5fa'),
  rally: Cesium.Color.fromCssColorString('#22c55e'),
  land: Cesium.Color.fromCssColorString('#ef4444'),
  survey: Cesium.Color.fromCssColorString('#a78bfa'),
};

const ZONE_COLORS: Record<ZoneType, string> = {
  prohibited: '#ef4444',
  restricted: '#ef4444',
  temporary: '#a855f7',
  controlled: '#f97316',
  danger: '#eab308',
  hazard_powerline: '#facc15',
  hazard_obstacle: '#f43f5e',
};

// ----------------------------------------------------------------------------------------
// Terrain: Terrarium DEM tiles served (and cached) by the Athena-sky server.
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

async function createTerrainProvider(): Promise<{ provider: Cesium.TerrainProvider; real: boolean }> {
  try {
    const status = await api<{ enabled: boolean }>('/api/v2/terrain');
    if (!status.enabled) return { provider: new Cesium.EllipsoidTerrainProvider(), real: false };
    const probe = await fetch('/api/v2/terrain/tiles/0/0/0.png', { credentials: 'same-origin' });
    if (!probe.ok) return { provider: new Cesium.EllipsoidTerrainProvider(), real: false };
  } catch {
    return { provider: new Cesium.EllipsoidTerrainProvider(), real: false };
  }
  const N = 65;
  const provider = new Cesium.CustomHeightmapTerrainProvider({
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
  return { provider, real: true };
}

const osm = () =>
  new Cesium.UrlTemplateImageryProvider({ url: import.meta.env.VITE_TILE_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maximumLevel: 19, credit: '© OpenStreetMap contributors' });
const satellite = () =>
  new Cesium.UrlTemplateImageryProvider({
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maximumLevel: 19,
    credit: 'Tiles © Esri',
  });

const keyOf = (p: LatLon) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
const NAV_WITH_POS = new Set<MissionItemType>(['waypoint', 'loiter', 'land']);

function insertBeforeTerminal(items: MissionItem[], add: MissionItem[], afterId: string | null): MissionItem[] {
  if (afterId) {
    const i = items.findIndex((it) => it.id === afterId);
    if (i >= 0) return [...items.slice(0, i + 1), ...add, ...items.slice(i + 1)];
  }
  const last = items[items.length - 1];
  if (last && (last.type === 'rtl' || last.type === 'land')) return [...items.slice(0, -1), ...add, last];
  return [...items, ...add];
}

export default function MissionPlannerPage() {
  const { missionId = '' } = useParams();
  const orgId = useOrgId();
  const { org, can } = useAuth();
  const toast = useToast();
  const { live, client } = useLive();
  const base = `/api/v2/organisations/${orgId}/missions/${missionId}`;
  const mission = useApi<MissionDto>(base);
  const zones = useApi<AirspaceZoneDto[]>(`/api/v2/organisations/${orgId}/airspace/zones`);
  const drones = useApi<DroneDto[]>(`/api/v2/organisations/${orgId}/drones`);
  const members = useApi<MemberDto[]>(`/api/v2/organisations/${orgId}/members`);
  const editable = can('mission.edit');

  const [plan, setPlanState] = useState<MissionPlan | null>(null);
  const [name, setName] = useState('');
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<Mode>('waypoint');
  const [selected, setSelected] = useState<string | null>(null);
  const [surveyPoly, setSurveyPoly] = useState<LatLon[]>([]);
  const [survey, setSurvey] = useState({ spacingM: 40, angleDeg: 0, alt: 60 });
  const [ground, setGround] = useState<Record<string, number | null>>({});
  const [terrainReal, setTerrainReal] = useState(false);
  const [terrain, setTerrain] = useState<TerrainSummary | null>(null);
  const [check, setCheck] = useState<AirspaceCheckDto | null>(null);
  const [imagery, setImagery] = useState<'map' | 'satellite'>('map');
  const [ortho, setOrtho] = useState(false);
  const [modal, setModal] = useState<'upload' | 'schedule' | 'authorize' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const host = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const missionDs = useRef<Cesium.CustomDataSource | null>(null);
  const zoneDs = useRef<Cesium.CustomDataSource | null>(null);
  const planRef = useRef<MissionPlan | null>(null);
  const modeRef = useRef<Mode>(mode);
  const selectedRef = useRef<string | null>(null);
  const homeElevRef = useRef(0);
  const dronesRef = useRef<DroneDto[] | null>(null);
  dronesRef.current = drones.data;
  planRef.current = plan;
  modeRef.current = mode;
  selectedRef.current = selected;

  const setPlan = useCallback((fn: (p: MissionPlan) => MissionPlan) => {
    setPlanState((p) => (p ? fn(p) : p));
    setDirty(true);
  }, []);

  useEffect(() => {
    if (mission.data && !plan) {
      setPlanState(mission.data.plan);
      setName(mission.data.name);
      setTerrain(mission.data.terrain);
    }
  }, [mission.data, plan]);

  // Home elevation: terrain at home (or the stored home altitude).
  const home = plan?.home ?? (plan ? (() => {
    const f = plan.items.find((i) => i.lat !== undefined && i.lon !== undefined);
    return f ? { lat: f.lat!, lon: f.lon!, alt: 0 } : null;
  })() : null);
  const homeElev = home ? (ground[keyOf(home)] ?? home.alt ?? 0) : 0;
  homeElevRef.current = homeElev;

  // Fetch ground elevations for positions we do not know yet.
  useEffect(() => {
    if (!plan) return;
    const pts: LatLon[] = [];
    if (home) pts.push(home);
    for (const it of plan.items) if (it.lat !== undefined && it.lon !== undefined) pts.push({ lat: it.lat, lon: it.lon });
    for (const r of plan.rallyPoints) pts.push(r);
    const missing = pts.filter((p) => !(keyOf(p) in ground));
    if (missing.length === 0) return;
    const t = setTimeout(() => {
      api<{ elevations: (number | null)[] }>('/api/v2/terrain/elevation', { body: { points: missing.slice(0, 500) } })
        .then((r) => setGround((g) => ({ ...g, ...Object.fromEntries(missing.slice(0, 500).map((p, i) => [keyOf(p), r.elevations[i] ?? null])) })))
        .catch(() => setGround((g) => ({ ...g, ...Object.fromEntries(missing.map((p) => [keyOf(p), null])) })));
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, home?.lat, home?.lon]);

  // ---------------------------------------------------------------------------------------
  // Viewer life-cycle and interaction
  // ---------------------------------------------------------------------------------------

  const pickLatLon = (pos: Cesium.Cartesian2): LatLon | null => {
    const viewer = viewerRef.current;
    if (!viewer) return null;
    const ray = viewer.camera.getPickRay(pos);
    let cart = ray ? viewer.scene.globe.pick(ray, viewer.scene) : undefined;
    cart ??= viewer.camera.pickEllipsoid(pos, viewer.scene.globe.ellipsoid);
    if (!cart) return null;
    const c = Cesium.Cartographic.fromCartesian(cart);
    return { lat: Cesium.Math.toDegrees(c.latitude), lon: Cesium.Math.toDegrees(c.longitude) };
  };

  const ready = !!plan;
  useEffect(() => {
    if (!ready || !host.current) return;
    let destroyed = false;
    let handler: Cesium.ScreenSpaceEventHandler | null = null;
    let shift = false;
    const keys = (e: KeyboardEvent) => (shift = e.shiftKey);
    window.addEventListener('keydown', keys);
    window.addEventListener('keyup', keys);
    void (async () => {
      const { provider, real } = await createTerrainProvider();
      if (destroyed || !host.current) return;
      setTerrainReal(real);
      const viewer = new Cesium.Viewer(host.current, {
        baseLayer: new Cesium.ImageryLayer(osm()),
        terrainProvider: provider,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        animation: false,
        timeline: false,
        fullscreenButton: false,
        infoBox: false,
        selectionIndicator: false,
      });
      viewer.scene.globe.depthTestAgainstTerrain = real;
      viewerRef.current = viewer;
      missionDs.current = new Cesium.CustomDataSource('mission');
      zoneDs.current = new Cesium.CustomDataSource('airspace');
      void viewer.dataSources.add(zoneDs.current);
      void viewer.dataSources.add(missionDs.current);
      (window as unknown as { __athenaPlanner?: unknown }).__athenaPlanner = { viewer };

      const p = planRef.current!;
      const firstPos = p.items.find((i) => i.lat !== undefined && i.lon !== undefined);
      const fleetPos = dronesRef.current?.find((d) => d.lastPosition)?.lastPosition;
      const s = p.home
        ? { lat: p.home.lat, lon: p.home.lon }
        : firstPos
          ? { lat: firstPos.lat!, lon: firstPos.lon! }
          : fleetPos
            ? { lat: fleetPos.lat, lon: fleetPos.lon }
            : { lat: 25.0732, lon: 121.5355 };
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(s.lon, s.lat - 0.012, 1200),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-40), roll: 0 },
      });

      handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      let drag: { id: string; startY: number; startAlt: number; moved: boolean } | null = null;
      let raf = 0;

      const entityAt = (pos: Cesium.Cartesian2): string | null => {
        const picked = viewer.scene.pick(pos) as { id?: Cesium.Entity } | undefined;
        const id = picked?.id?.id;
        return typeof id === 'string' && /^(wp|rally|gf|home)/.test(id) ? id : null;
      };

      handler.setInputAction((e: { position: Cesium.Cartesian2 }) => {
        const id = entityAt(e.position);
        if (!id || !editable) return;
        const pl = planRef.current!;
        let startAlt = 0;
        if (id.startsWith('wp:')) startAlt = pl.items.find((i) => i.id === id.slice(3))?.alt ?? pl.defaultAlt;
        if (id.startsWith('rally:')) startAlt = pl.rallyPoints[Number(id.slice(6))]?.alt ?? 30;
        drag = { id, startY: e.position.y, startAlt, moved: false };
        if (id.startsWith('wp:')) setSelected(id.slice(3));
        viewer.scene.screenSpaceCameraController.enableInputs = false;
      }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

      handler.setInputAction((e: { endPosition: Cesium.Cartesian2 }) => {
        if (!drag) return;
        drag.moved = true;
        const d = drag;
        const pos = e.endPosition.clone();
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          if (shift && (d.id.startsWith('wp:') || d.id.startsWith('rally:'))) {
            const alt = Math.max(1, Math.min(1000, Math.round(d.startAlt + (d.startY - pos.y) * 0.5)));
            setPlan((pl) =>
              d.id.startsWith('wp:')
                ? { ...pl, items: pl.items.map((i) => (i.id === d.id.slice(3) ? { ...i, alt } : i)) }
                : { ...pl, rallyPoints: pl.rallyPoints.map((r, k) => (k === Number(d.id.slice(6)) ? { ...r, alt } : r)) },
            );
            return;
          }
          const ll = pickLatLon(pos);
          if (!ll) return;
          setPlan((pl) => {
            if (d.id.startsWith('wp:')) return { ...pl, items: pl.items.map((i) => (i.id === d.id.slice(3) ? { ...i, lat: ll.lat, lon: ll.lon } : i)) };
            if (d.id.startsWith('rally:')) return { ...pl, rallyPoints: pl.rallyPoints.map((r, k) => (k === Number(d.id.slice(6)) ? { ...r, ...ll } : r)) };
            if (d.id.startsWith('gf:') && pl.geofence) return { ...pl, geofence: { ...pl.geofence, polygon: pl.geofence.polygon.map((v, k) => (k === Number(d.id.slice(3)) ? ll : v)) } };
            if (d.id === 'home') return { ...pl, home: { ...ll, alt: pl.home?.alt ?? 0 } };
            return pl;
          });
        });
      }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

      handler.setInputAction(() => {
        if (drag) {
          viewer.scene.screenSpaceCameraController.enableInputs = true;
          setTimeout(() => (drag = null), 0);
        }
      }, Cesium.ScreenSpaceEventType.LEFT_UP);

      handler.setInputAction((e: { position: Cesium.Cartesian2 }) => {
        if (drag?.moved) return;
        const id = entityAt(e.position);
        if (id?.startsWith('wp:')) {
          setSelected(id.slice(3));
          return;
        }
        if (!editable) return;
        const ll = pickLatLon(e.position);
        if (!ll) return;
        const m = modeRef.current;
        if (m === 'waypoint') {
          const pl = planRef.current!;
          const item: MissionItem = { id: newItemId(), type: 'waypoint', lat: ll.lat, lon: ll.lon, alt: pl.items.filter((i) => i.alt !== undefined).at(-1)?.alt ?? pl.defaultAlt };
          setPlan((p2) => {
            const withHome = p2.home ? p2 : { ...p2, home: { ...ll, alt: 0 } };
            const items = withHome.items.length === 0 ? [{ id: newItemId(), type: 'takeoff' as const, alt: p2.defaultAlt }, item] : insertBeforeTerminal(withHome.items, [item], selectedRef.current);
            return { ...withHome, items };
          });
          setSelected(item.id);
        } else if (m === 'rally') {
          setPlan((p2) => ({ ...p2, rallyPoints: [...p2.rallyPoints, { ...ll, alt: 30 }] }));
        } else if (m === 'geofence') {
          setPlan((p2) => ({ ...p2, geofence: { polygon: [...(p2.geofence?.polygon ?? []), ll], maxAlt: p2.geofence?.maxAlt ?? 120, action: p2.geofence?.action ?? 'rtl' } }));
        } else if (m === 'survey') {
          setSurveyPoly((s2) => [...s2, ll]);
        } else if (m === 'home') {
          setPlan((p2) => ({ ...p2, home: { ...ll, alt: 0 } }));
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    })();
    return () => {
      destroyed = true;
      window.removeEventListener('keydown', keys);
      window.removeEventListener('keyup', keys);
      handler?.destroy();
      viewerRef.current?.destroy();
      viewerRef.current = null;
      delete (window as unknown as { __athenaPlanner?: unknown }).__athenaPlanner;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // ---------------------------------------------------------------------------------------
  // Rendering of the mission and airspace
  // ---------------------------------------------------------------------------------------

  const groundAt = useCallback((p: LatLon) => ground[keyOf(p)] ?? homeElev, [ground, homeElev]);

  useEffect(() => {
    const ds = missionDs.current;
    if (!ds || !plan) return;
    ds.entities.removeAll();
    const abs = (p: LatLon & { alt: number }) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, homeElev + p.alt);
    const label = (text: string, color = Cesium.Color.WHITE) => ({
      text,
      font: '13px sans-serif',
      fillColor: color,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cesium.Cartesian2(0, -18),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
    const path = missionPath(plan);
    if (path.length > 1) {
      ds.entities.add({ polyline: { positions: path.map(abs), width: 3, material: COLORS.path, arcType: Cesium.ArcType.NONE } });
      // Projected ground track
      ds.entities.add({ polyline: { positions: path.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat)), width: 1, material: COLORS.path.withAlpha(0.5), clampToGround: true } });
    }
    if (home) {
      ds.entities.add({
        id: 'home',
        position: Cesium.Cartesian3.fromDegrees(home.lon, home.lat, homeElev + 0.5),
        point: { pixelSize: 14, color: COLORS.home, outlineColor: Cesium.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: label('H'),
      });
    }
    let n = 0;
    plan.items.forEach((it) => {
      if (!NAV_WITH_POS.has(it.type) || it.lat === undefined || it.lon === undefined) return;
      n++;
      const alt = it.type === 'land' ? 0 : (it.alt ?? plan.defaultAlt);
      const sel = it.id === selected;
      const pos = Cesium.Cartesian3.fromDegrees(it.lon, it.lat, homeElev + alt);
      ds.entities.add({
        id: `wp:${it.id}`,
        position: pos,
        point: { pixelSize: sel ? 16 : 12, color: sel ? COLORS.selected : it.type === 'land' ? COLORS.land : COLORS.wp, outlineColor: Cesium.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: label(`${n} · ${Math.round(alt)} m${it.holdS ? ` · ${it.holdS}s` : ''}`, sel ? COLORS.selected : Cesium.Color.WHITE),
      });
      ds.entities.add({
        polyline: {
          positions: [Cesium.Cartesian3.fromDegrees(it.lon, it.lat, groundAt({ lat: it.lat, lon: it.lon })), pos],
          width: 1.5,
          material: Cesium.Color.WHITE.withAlpha(0.6),
          arcType: Cesium.ArcType.NONE,
        },
      });
    });
    plan.rallyPoints.forEach((r, i) => {
      const pos = Cesium.Cartesian3.fromDegrees(r.lon, r.lat, homeElev + r.alt);
      ds.entities.add({
        id: `rally:${i}`,
        position: pos,
        point: { pixelSize: 12, color: COLORS.rally, outlineColor: Cesium.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: label(`R${i + 1} · ${r.alt} m`, COLORS.rally),
      });
      ds.entities.add({ polyline: { positions: [Cesium.Cartesian3.fromDegrees(r.lon, r.lat, groundAt(r)), pos], width: 1.5, material: COLORS.rally.withAlpha(0.7), arcType: Cesium.ArcType.NONE } });
    });
    const gf = plan.geofence;
    if (gf && gf.polygon.length > 0) {
      gf.polygon.forEach((v, i) =>
        ds.entities.add({ id: `gf:${i}`, position: Cesium.Cartesian3.fromDegrees(v.lon, v.lat, homeElev + 1), point: { pixelSize: 9, color: Cesium.Color.ORANGE, disableDepthTestDistance: Number.POSITIVE_INFINITY } }),
      );
      if (gf.polygon.length >= 3) {
        ds.entities.add({
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(gf.polygon.map((v) => Cesium.Cartesian3.fromDegrees(v.lon, v.lat))),
            height: homeElev,
            extrudedHeight: homeElev + (gf.maxAlt ?? 120),
            material: Cesium.Color.ORANGE.withAlpha(0.08),
            outline: true,
            outlineColor: Cesium.Color.ORANGE,
          },
        });
      }
    }
    if (surveyPoly.length > 0) {
      ds.entities.add({
        polyline: {
          positions: [...surveyPoly, surveyPoly[0]!].map((v) => Cesium.Cartesian3.fromDegrees(v.lon, v.lat)),
          width: 2,
          material: COLORS.survey,
          clampToGround: true,
        },
      });
    }
  }, [plan, selected, homeElev, surveyPoly, groundAt, home?.lat, home?.lon]);

  useEffect(() => {
    const ds = zoneDs.current;
    if (!ds) return;
    ds.entities.removeAll();
    for (const z of zones.data ?? []) {
      const color = Cesium.Color.fromCssColorString(ZONE_COLORS[z.type]);
      const common = { height: homeElev + z.floorM, extrudedHeight: homeElev + z.ceilingM, material: color.withAlpha(0.18), outline: true, outlineColor: color };
      const name = `${z.name} (${z.type.replace('_', ' ')}, ${z.floorM}–${z.ceilingM} m)`;
      if (z.geometry.kind === 'polygon') {
        ds.entities.add({ name, polygon: { ...common, hierarchy: new Cesium.PolygonHierarchy(z.geometry.polygon.map((v) => Cesium.Cartesian3.fromDegrees(v.lon, v.lat))) } });
      } else if (z.geometry.kind === 'circle') {
        ds.entities.add({ name, position: Cesium.Cartesian3.fromDegrees(z.geometry.center.lon, z.geometry.center.lat), ellipse: { ...common, semiMajorAxis: z.geometry.radiusM, semiMinorAxis: z.geometry.radiusM } });
      } else {
        ds.entities.add({ name, corridor: { ...common, positions: z.geometry.line.map((v) => Cesium.Cartesian3.fromDegrees(v.lon, v.lat)), width: Math.max(4, z.geometry.bufferM * 2) } });
        ds.entities.add({ polyline: { positions: z.geometry.line.map((v) => Cesium.Cartesian3.fromDegrees(v.lon, v.lat, homeElev + z.ceilingM)), width: 2, material: color } });
      }
    }
  }, [zones.data, homeElev, ready]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.imageryLayers.removeAll();
    viewer.imageryLayers.add(new Cesium.ImageryLayer(imagery === 'map' ? osm() : satellite()));
  }, [imagery]);

  // ---------------------------------------------------------------------------------------
  // Camera tools: rotate, tilt, surface view, orthographic top view, fit
  // ---------------------------------------------------------------------------------------

  const focus = (): { center: LatLon; range: number } => {
    const pts = plan ? missionPath(plan) : [];
    const c = centroidOf(pts.length ? pts : home ? [home] : [{ lat: 25.0732, lon: 121.5355 }])!;
    const r = Math.max(250, ...pts.map((p) => haversineDistance(c, p) * 2.6));
    return { center: c, range: r };
  };
  const look = (headingDeg: number | null, pitchDeg: number) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const { center, range } = focus();
    viewer.camera.switchToPerspectiveFrustum();
    setOrtho(false);
    const target = Cesium.Cartesian3.fromDegrees(center.lon, center.lat, homeElev);
    const heading = headingDeg === null ? viewer.camera.heading : Cesium.Math.toRadians(headingDeg);
    viewer.camera.lookAt(target, new Cesium.HeadingPitchRange(heading, Cesium.Math.toRadians(pitchDeg), range));
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  };
  const rotate = (deg: number) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    look(Cesium.Math.toDegrees(viewer.camera.heading) + deg, Math.min(-10, Cesium.Math.toDegrees(viewer.camera.pitch)));
  };
  const topView = () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const { center, range } = focus();
    viewer.camera.switchToOrthographicFrustum();
    setOrtho(true);
    viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(center.lon, center.lat, homeElev + range * 1.6), orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 } });
  };
  const surfaceView = () => {
    const viewer = viewerRef.current;
    if (!viewer || !home) return;
    const { center } = focus();
    viewer.camera.switchToPerspectiveFrustum();
    setOrtho(false);
    const heading = haversineDistance(home, center) > 5 ? initialBearing(home, center) : 0;
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(home.lon, home.lat, homeElev + 2),
      orientation: { heading: Cesium.Math.toRadians(heading), pitch: Cesium.Math.toRadians(8), roll: 0 },
    });
  };

  // ---------------------------------------------------------------------------------------
  // Derived data and actions
  // ---------------------------------------------------------------------------------------

  const stats = useMemo(() => (plan ? missionStats(plan) : null), [plan]);
  const issues = useMemo(() => (plan ? validateMission(plan, { maxAltitude: org?.settings.maxAltitudeM ?? 120 }) : []), [plan, org?.settings.maxAltitudeM]);

  const save = async (): Promise<boolean> => {
    if (!plan) return false;
    try {
      const m = await api<MissionDto>(base, { method: 'PUT', body: { name, plan } });
      mission.setData(m);
      setDirty(false);
      toast('Mission saved', 'ok');
      return true;
    } catch (err) {
      toast(errorMessage(err), 'error');
      return false;
    }
  };

  const updateItem = (id: string, patch: Partial<MissionItem>) => setPlan((p) => ({ ...p, items: p.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) }));
  const moveItem = (id: string, dir: -1 | 1) =>
    setPlan((p) => {
      const i = p.items.findIndex((x) => x.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= p.items.length) return p;
      const items = [...p.items];
      [items[i], items[j]] = [items[j]!, items[i]!];
      return { ...p, items };
    });
  const addItem = (type: MissionItemType) => {
    const pl = plan!;
    const lastPos = [...pl.items].reverse().find((i) => i.lat !== undefined);
    const item: MissionItem =
      type === 'takeoff'
        ? { id: newItemId(), type, alt: pl.defaultAlt }
        : type === 'speed'
          ? { id: newItemId(), type, speed: pl.defaultSpeed }
          : type === 'loiter' && lastPos
            ? { id: newItemId(), type, lat: lastPos.lat, lon: lastPos.lon, alt: lastPos.alt ?? pl.defaultAlt, holdS: 10 }
            : { id: newItemId(), type };
    setPlan((p) => ({ ...p, items: type === 'takeoff' ? [item, ...p.items] : type === 'rtl' || type === 'land' ? [...p.items, item] : insertBeforeTerminal(p.items, [item], selected) }));
  };

  if (mission.error) return <div className="content"><ErrorBox error={mission.error} /></div>;
  if (!plan || !mission.data) return <Loading what="Loading mission…" />;
  const onlineDrones = Object.values(live.drones).filter((d) => d.online);
  let navNo = 0;

  return (
    <div className="content fill">
      <div className="planner">
        <div className="planner-view">
          <div ref={host} className="cesium-host" data-testid="planner-3d" />
          <div className="planner-toolbar">
            <div className="group" role="toolbar" aria-label="Edit mode">
              {(
                [
                  ['select', 'Select / move'],
                  ['waypoint', '+ Waypoint'],
                  ['rally', '+ Rally point'],
                  ['geofence', '+ Geofence'],
                  ['survey', '+ Survey area'],
                  ['home', 'Set home'],
                ] as [Mode, string][]
              ).map(([m, l]) => (
                <button key={m} className={`btn small${mode === m ? ' active' : ''}`} onClick={() => setMode(m)} disabled={!editable && m !== 'select'}>
                  {l}
                </button>
              ))}
            </div>
            <div className="group" role="toolbar" aria-label="View">
              <button className="btn small" title="Rotate left" onClick={() => rotate(-45)}>
                ⟲
              </button>
              <button className="btn small" title="Rotate right" onClick={() => rotate(45)}>
                ⟳
              </button>
              <button className="btn small" onClick={() => look(null, -30)}>
                Tilt
              </button>
              <button className="btn small" onClick={surfaceView}>
                Surface view
              </button>
              <button className={`btn small${ortho ? ' active' : ''}`} onClick={topView}>
                Top (orthographic)
              </button>
              <button className="btn small" onClick={() => look(0, -45)}>
                Fit mission
              </button>
              <button className="btn small" onClick={() => setImagery(imagery === 'map' ? 'satellite' : 'map')}>
                {imagery === 'map' ? 'Satellite' : 'Map'}
              </button>
            </div>
          </div>
          <div className="small muted" style={{ position: 'absolute', bottom: 34, left: 10, background: 'color-mix(in srgb, var(--bg-elev) 85%, transparent)', padding: '4px 8px', borderRadius: 6 }}>
            Click to add · drag points to move · <b>Shift + drag</b> to change altitude · right-drag zoom · Ctrl/middle-drag tilt & rotate · terrain: {terrainReal ? '3D DEM' : 'flat (offline)'}
          </div>
        </div>

        <aside className="planner-side">
          <div className="col">
            <Link to="/missions" className="small">
              ← Missions
            </Link>
            <input aria-label="Mission name" value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} style={{ fontWeight: 600, fontSize: 16 }} disabled={!editable} />
            <div className="row">
              {editable && (
                <button className="btn primary" onClick={save} disabled={!dirty}>
                  {dirty ? 'Save' : 'Saved'}
                </button>
              )}
              <button className="btn small" onClick={() => download(`${base}/export?format=plan`)}>
                .plan
              </button>
              <button className="btn small" onClick={() => download(`${base}/export?format=waypoints`)}>
                .waypoints
              </button>
            </div>
          </div>

          {stats && (
            <div className="hud" data-testid="mission-stats">
              <div className="cell">
                <div className="k">Distance</div>
                <div className="v">{fmtDistance(stats.totalDistanceM)}</div>
              </div>
              <div className="cell">
                <div className="k">Time</div>
                <div className="v">{fmtDuration(stats.estimatedTimeS)}</div>
              </div>
              <div className="cell">
                <div className="k">Battery</div>
                <div className="v">{stats.estimatedBatteryPct.toFixed(0)}%</div>
              </div>
              <div className="cell">
                <div className="k">Waypoints</div>
                <div className="v" data-testid="waypoint-count">
                  {stats.waypointCount}
                </div>
              </div>
            </div>
          )}

          {issues.length > 0 && (
            <div className="col" style={{ gap: 4 }}>
              {issues.slice(0, 8).map((i, k) => (
                <div key={k} className={`issue ${i.level}`}>
                  {i.itemIndex !== undefined ? `#${i.itemIndex + 1}: ` : ''}
                  {i.message}
                </div>
              ))}
            </div>
          )}

          <div>
            <div className="card-head">
              <h3>Mission items ({plan.items.length})</h3>
            </div>
            {editable && (
              <div className="row" style={{ marginBottom: 8 }}>
                {(['takeoff', 'loiter', 'speed', 'photo', 'land', 'rtl'] as MissionItemType[]).map((t) => (
                  <button key={t} className="btn small" onClick={() => addItem(t)}>
                    + {t === 'rtl' ? 'RTL' : t}
                  </button>
                ))}
              </div>
            )}
            {plan.items.length === 0 && <div className="small muted">Click on the map to add the first waypoint (a take-off item is added automatically).</div>}
            {plan.items.map((it, idx) => {
              const hasNav = NAV_WITH_POS.has(it.type) && it.lat !== undefined;
              if (hasNav) navNo++;
              return (
                <div key={it.id} className={`item-row${selected === it.id ? ' selected' : ''}`} onClick={() => setSelected(it.id)}>
                  <span className="idx">{hasNav ? navNo : '·'}</span>
                  <select value={it.type} disabled={!editable} onChange={(e) => updateItem(it.id, { type: e.target.value as MissionItemType })} aria-label={`Item ${idx + 1} type`}>
                    {['takeoff', 'waypoint', 'loiter', 'land', 'rtl', 'speed', 'photo'].map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  {editable && (
                    <div className="row" style={{ gap: 2 }}>
                      <button className="btn small ghost" title="Move up" onClick={(e) => { e.stopPropagation(); moveItem(it.id, -1); }}>
                        ↑
                      </button>
                      <button className="btn small ghost" title="Move down" onClick={(e) => { e.stopPropagation(); moveItem(it.id, 1); }}>
                        ↓
                      </button>
                      <button className="btn small ghost" title="Delete" onClick={(e) => { e.stopPropagation(); setPlan((p) => ({ ...p, items: p.items.filter((x) => x.id !== it.id) })); }}>
                        ✕
                      </button>
                    </div>
                  )}
                  <div className="item-fields">
                    {(it.type === 'takeoff' || it.type === 'waypoint' || it.type === 'loiter') && (
                      <label>
                        Altitude (m)
                        <input type="number" aria-label="Altitude" value={it.alt ?? ''} disabled={!editable} onChange={(e) => updateItem(it.id, { alt: e.target.value === '' ? undefined : Number(e.target.value) })} />
                      </label>
                    )}
                    {(it.type === 'waypoint' || it.type === 'loiter') && (
                      <label>
                        Hold (s)
                        <input type="number" aria-label="Hold" value={it.holdS ?? ''} disabled={!editable} onChange={(e) => updateItem(it.id, { holdS: e.target.value === '' ? undefined : Number(e.target.value) })} />
                      </label>
                    )}
                    {(it.type === 'waypoint' || it.type === 'speed') && (
                      <label>
                        Speed (m/s)
                        <input type="number" aria-label="Speed" value={it.speed ?? ''} disabled={!editable} onChange={(e) => updateItem(it.id, { speed: e.target.value === '' ? undefined : Number(e.target.value) })} />
                      </label>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {mode === 'survey' || surveyPoly.length > 0 ? (
            <div className="card tight">
              <h3>Survey pattern</h3>
              <p className="small muted">Click the corners of the area on the map ({surveyPoly.length} so far), then generate a lawn-mower coverage pattern.</p>
              <div className="form-grid">
                <label className="field">
                  Line spacing (m)
                  <input type="number" value={survey.spacingM} onChange={(e) => setSurvey({ ...survey, spacingM: Number(e.target.value) })} />
                </label>
                <label className="field">
                  Direction (°)
                  <input type="number" value={survey.angleDeg} onChange={(e) => setSurvey({ ...survey, angleDeg: Number(e.target.value) })} />
                </label>
                <label className="field">
                  Altitude (m)
                  <input type="number" value={survey.alt} onChange={(e) => setSurvey({ ...survey, alt: Number(e.target.value) })} />
                </label>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <button
                  className="btn small primary"
                  disabled={surveyPoly.length < 3}
                  onClick={() => {
                    try {
                      const lanes = generateSurvey(surveyPoly, survey);
                      setPlan((p) => {
                        const withHome = p.home ? p : { ...p, home: { ...surveyPoly[0]!, alt: 0 } };
                        const items = withHome.items.length === 0 ? [{ id: newItemId(), type: 'takeoff' as const, alt: survey.alt }, ...lanes, { id: newItemId(), type: 'rtl' as const }] : insertBeforeTerminal(withHome.items, lanes, null);
                        return { ...withHome, items };
                      });
                      setSurveyPoly([]);
                      setMode('select');
                    } catch (err) {
                      toast(errorMessage(err), 'error');
                    }
                  }}
                >
                  Generate
                </button>
                <button className="btn small" onClick={() => setSurveyPoly([])}>
                  Clear area
                </button>
              </div>
            </div>
          ) : null}

          <div className="card tight">
            <h3>Rally points & geofence</h3>
            {plan.rallyPoints.length === 0 && <div className="small muted">No rally points: RTL returns to home. Add emergency landing points along the route for BVLOS safety.</div>}
            {plan.rallyPoints.map((r, i) => (
              <div key={i} className="row small">
                R{i + 1}: {r.lat.toFixed(5)}, {r.lon.toFixed(5)}
                <input type="number" style={{ width: 70 }} value={r.alt} aria-label={`Rally ${i + 1} altitude`} disabled={!editable} onChange={(e) => setPlan((p) => ({ ...p, rallyPoints: p.rallyPoints.map((x, k) => (k === i ? { ...x, alt: Number(e.target.value) } : x)) }))} />
                {editable && (
                  <button className="btn small ghost" onClick={() => setPlan((p) => ({ ...p, rallyPoints: p.rallyPoints.filter((_, k) => k !== i) }))}>
                    ✕
                  </button>
                )}
              </div>
            ))}
            {plan.geofence ? (
              <div className="row small" style={{ marginTop: 8 }}>
                Geofence: {plan.geofence.polygon.length} vertices · ceiling
                <input type="number" style={{ width: 70 }} aria-label="Geofence ceiling" value={plan.geofence.maxAlt ?? ''} disabled={!editable} onChange={(e) => setPlan((p) => ({ ...p, geofence: p.geofence ? { ...p.geofence, maxAlt: e.target.value === '' ? null : Number(e.target.value) } : null }))} />
                <select value={plan.geofence.action} disabled={!editable} onChange={(e) => setPlan((p) => ({ ...p, geofence: p.geofence ? { ...p.geofence, action: e.target.value as 'rtl' | 'land' | 'hold' } : null }))}>
                  <option value="rtl">RTL on breach</option>
                  <option value="land">Land on breach</option>
                  <option value="hold">Hold on breach</option>
                </select>
                {editable && (
                  <button className="btn small ghost" onClick={() => setPlan((p) => ({ ...p, geofence: null }))}>
                    ✕
                  </button>
                )}
              </div>
            ) : (
              <div className="small muted" style={{ marginTop: 8 }}>
                No geofence. Use “+ Geofence” and click the corners.
              </div>
            )}
            <div className="form-grid" style={{ marginTop: 8 }}>
              <label className="field">
                Default altitude (m)
                <input type="number" value={plan.defaultAlt} disabled={!editable} onChange={(e) => setPlan((p) => ({ ...p, defaultAlt: Number(e.target.value) || 1 }))} />
              </label>
              <label className="field">
                Cruise speed (m/s)
                <input type="number" value={plan.defaultSpeed} disabled={!editable} onChange={(e) => setPlan((p) => ({ ...p, defaultSpeed: Number(e.target.value) || 1 }))} />
              </label>
            </div>
          </div>

          <div className="card tight">
            <div className="card-head">
              <h3>Terrain & airspace</h3>
            </div>
            <div className="row">
              <button
                className="btn small"
                onClick={async () => {
                  if (dirty && !(await save())) return;
                  try {
                    setTerrain(await api<TerrainSummary>(`${base}/terrain`, { method: 'POST' }));
                  } catch (err) {
                    toast(errorMessage(err), 'error');
                  }
                }}
              >
                Terrain profile
              </button>
              <button
                className="btn small"
                onClick={async () => {
                  if (dirty && !(await save())) return;
                  try {
                    setCheck(await api<AirspaceCheckDto>(`${base}/airspace-check`, { body: {} }));
                  } catch (err) {
                    toast(errorMessage(err), 'error');
                  }
                }}
              >
                Check airspace
              </button>
              {can('authorization.request') && (
                <button className="btn small" onClick={() => setModal('authorize')}>
                  Request authorisation
                </button>
              )}
            </div>
            {terrain && (
              <div style={{ marginTop: 8 }}>
                <TerrainProfile samples={terrain.samples} />
                <div className="small muted">
                  {terrain.minElevationM === null
                    ? 'Terrain data unavailable – planned altitudes are relative to home.'
                    : `Terrain ${Math.round(terrain.minElevationM)}–${Math.round(terrain.maxElevationM ?? 0)} m AMSL · minimum clearance ${terrain.minClearanceM ?? '—'} m`}
                </div>
              </div>
            )}
            {check && (
              <div className="col" style={{ marginTop: 8, gap: 4 }} data-testid="airspace-check">
                <Badge tone={check.verdict === 'clear' ? 'ok' : check.verdict === 'review' ? 'warn' : 'danger'}>{check.verdict}</Badge>
                {check.conflicts.map((c, i) => (
                  <div key={i} className={`issue ${c.severity === 'advisory' ? 'warning' : 'error'}`}>
                    {c.message}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card tight">
            <h3>Operations</h3>
            <div className="row">
              {can('drone.control') && (
                <button className="btn small primary" disabled={dirty} title={dirty ? 'Save first' : ''} onClick={() => setModal('upload')}>
                  Upload to drone
                </button>
              )}
              {editable && (
                <button className="btn small" disabled={dirty} onClick={() => setModal('schedule')}>
                  Schedule
                </button>
              )}
            </div>
          </div>
          <ErrorBox error={error} />
        </aside>
      </div>

      {modal === 'upload' && (
        <UploadModal
          drones={onlineDrones.map((d) => ({ id: d.droneId, name: d.name, busy: !!d.telemetry?.inAir }))}
          onClose={() => setModal(null)}
          onUpload={async (droneId, start) => {
            try {
              await api(`${base}/upload`, { body: { droneId } });
              toast('Mission uploaded to the drone', 'ok');
              if (start && client) {
                const r = await client.command(droneId, 'mission_start');
                toast(`Mission start: ${r.result}${r.message ? ` – ${r.message}` : ''}`, r.result === 'accepted' ? 'ok' : 'error');
              }
              setModal(null);
            } catch (err) {
              setError(errorMessage(err));
            }
          }}
        />
      )}
      {modal === 'schedule' && (
        <ScheduleModal
          drones={drones.data ?? []}
          members={members.data ?? []}
          onClose={() => setModal(null)}
          onSave={async (body) => {
            try {
              await api(`/api/v2/organisations/${orgId}/schedules`, { body: { ...body, missionId } });
              toast('Mission scheduled', 'ok');
              setModal(null);
            } catch (err) {
              toast(errorMessage(err), 'error');
            }
          }}
        />
      )}
      {modal === 'authorize' && (
        <AuthorizeModal
          path={missionPath(plan)}
          droneOptions={drones.data ?? []}
          onClose={() => setModal(null)}
          onSubmit={async (body) => {
            try {
              const r = await api<AuthorizationDto>(`/api/v2/organisations/${orgId}/airspace/authorizations`, { body: { ...body, missionId } });
              toast(`Authorisation ${r.reference}: ${r.status}`, r.status === 'approved' ? 'ok' : r.status === 'rejected' ? 'error' : 'info');
              setModal(null);
            } catch (err) {
              toast(errorMessage(err), 'error');
            }
          }}
        />
      )}
    </div>
  );
}

function UploadModal({ drones, onClose, onUpload }: { drones: { id: string; name: string; busy: boolean }[]; onClose(): void; onUpload(droneId: string, start: boolean): void }) {
  const [droneId, setDroneId] = useState(drones[0]?.id ?? '');
  const [start, setStart] = useState(false);
  return (
    <Modal title="Upload mission over the link" onClose={onClose} actions={<button className="btn primary" disabled={!droneId} onClick={() => onUpload(droneId, start)}>Upload</button>}>
      {drones.length === 0 ? (
        <div className="muted">No drone is online. Missions can be uploaded to online drones only (schedule it instead).</div>
      ) : (
        <div className="form">
          <select value={droneId} onChange={(e) => setDroneId(e.target.value)} aria-label="Drone">
            {drones.map((d) => (
              <option key={d.id} value={d.id} disabled={d.busy}>
                {d.name}
                {d.busy ? ' (in flight)' : ''}
              </option>
            ))}
          </select>
          <label className="row">
            <input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} /> Start the mission immediately (arms and takes off)
          </label>
        </div>
      )}
    </Modal>
  );
}

function ScheduleModal({ drones, members, onClose, onSave }: { drones: DroneDto[]; members: MemberDto[]; onClose(): void; onSave(b: { droneId: string; pilotId: string | null; plannedAt: string }): void }) {
  const [droneId, setDroneId] = useState(drones[0]?.id ?? '');
  const [pilotId, setPilotId] = useState('');
  const [when, setWhen] = useState(() => new Date(Date.now() + 86_400_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
  return (
    <Modal title="Schedule mission" onClose={onClose} actions={<button className="btn primary" disabled={!droneId} onClick={() => onSave({ droneId, pilotId: pilotId || null, plannedAt: new Date(when).toISOString() })}>Schedule</button>}>
      <div className="form">
        <label className="field">
          Drone
          <select value={droneId} onChange={(e) => setDroneId(e.target.value)}>
            {drones.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Pilot
          <select value={pilotId} onChange={(e) => setPilotId(e.target.value)}>
            <option value="">—</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Planned date & time
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}

function AuthorizeModal({ path, droneOptions, onClose, onSubmit }: { path: (LatLon & { alt: number })[]; droneOptions: DroneDto[]; onClose(): void; onSubmit(b: Record<string, unknown>): void }) {
  const [start, setStart] = useState(() => new Date(Date.now() + 15 * 60_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
  const [hours, setHours] = useState(1);
  const [width, setWidth] = useState(100);
  const [droneId, setDroneId] = useState('');
  const maxAlt = Math.ceil(Math.max(10, ...path.map((p) => p.alt)) + 10);
  const line = path.filter((p, i) => i === 0 || haversineDistance(p, path[i - 1]!) > 1).map((p) => ({ lat: p.lat, lon: p.lon }));
  return (
    <Modal
      title="Request flight authorisation (corridor)"
      onClose={onClose}
      actions={
        <button
          className="btn primary"
          disabled={line.length < 2}
          onClick={() => {
            const s = new Date(start);
            onSubmit({ geometry: { kind: 'corridor', line, widthM: width }, maxAltM: maxAlt, startAt: s.toISOString(), endAt: new Date(s.getTime() + hours * 3_600_000).toISOString(), droneId: droneId || null });
          }}
        >
          Submit
        </button>
      }
    >
      <p className="small muted">The corridor follows the mission path. Conflict-free requests are approved instantly and published on the public safety map.</p>
      <div className="form-grid">
        <label className="field">
          Start
          <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="field">
          Duration (h)
          <input type="number" min={0.25} step={0.25} value={hours} onChange={(e) => setHours(Number(e.target.value))} />
        </label>
        <label className="field">
          Corridor width (m)
          <input type="number" min={10} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
        </label>
        <label className="field">
          Drone
          <select value={droneId} onChange={(e) => setDroneId(e.target.value)}>
            <option value="">—</option>
            {droneOptions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="small muted" style={{ marginTop: 8 }}>
        Maximum altitude {maxAlt} m · {line.length} corridor points
      </div>
    </Modal>
  );
}
