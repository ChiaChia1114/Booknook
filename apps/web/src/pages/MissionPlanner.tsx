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
  AIRFRAMES,
  DEFAULT_AIRFRAME_ID,
  centroidOf,
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
  type SimulationSample,
  type TerrainSummary,
  type WeatherDto,
  type ZoneType,
} from '@athena-sky/shared';
import { api, download, errorMessage } from '../api/client';
import { useApi } from '../hooks';
import { useAuth, useOrgId } from '../state/auth';
import { useLive } from '../state/live';
import { TerrainProfile } from '../components/charts';
import { TERRAIN_LABEL, addOsmBuildings, createViewer, droneModelUri, droneOrientation, modelOfAirframe, setImagery as applyImagery, terrainHeights, type ClientConfig, type TerrainKind } from '../lib/cesium';
import { GeneratePanel, type GenerateResult } from '../components/planner/GeneratePanel';
import { OptimizePanel } from '../components/planner/OptimizePanel';
import { SimulatePanel, type SimulationConditions } from '../components/planner/SimulatePanel';
import { MissionItemsList, type AltitudeReference } from '../components/planner/MissionItemsList';
import { Badge, ErrorBox, Loading, Modal, fmtDistance, fmtDuration, useToast } from '../components/ui';

type Mode = 'select' | 'waypoint' | 'rally' | 'geofence' | 'survey' | 'home';

const COLORS = {
  path: Cesium.Color.WHITE,
  wp: Cesium.Color.WHITE,
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

const keyOf = (p: LatLon) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
const NAV_WITH_POS = new Set<MissionItemType>(['waypoint', 'loiter', 'land']);

function weatherIcon(w: WeatherDto): string {
  if ((w.precipitationMm ?? 0) > 0.2) return '🌧';
  if ((w.cloudCoverPct ?? 0) > 70) return '☁';
  if ((w.cloudCoverPct ?? 0) > 25) return '⛅';
  return '☀';
}

function insertBeforeTerminal(items: MissionItem[], add: MissionItem[], afterId: string | null): MissionItem[] {
  if (afterId) {
    const i = items.findIndex((it) => it.id === afterId);
    // After the selected item – but never after a return-home / land item: before it instead.
    if (i >= 0) {
      const at = items[i]!.type === 'rtl' || items[i]!.type === 'land' ? i : i + 1;
      return [...items.slice(0, at), ...add, ...items.slice(at)];
    }
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
  const [conditions, setConditions] = useState<SimulationConditions>({ airframeId: DEFAULT_AIRFRAME_ID, payloadKg: 0.5, windMode: 'none', windSpeed: 5, windFrom: 0, temperature: '' });
  const [undoPlan, setUndoPlan] = useState<MissionPlan | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [altRef, setAltRef] = useState<AltitudeReference>('rel');
  const simEntity = useRef<Cesium.Entity | null>(null);
  const [ground, setGround] = useState<Record<string, number | null>>({});
  const [terrainKind, setTerrainKind] = useState<TerrainKind>('flat');
  const [ionHomeHeight, setIonHomeHeight] = useState<number | null>(null);
  const [buildings, setBuildings] = useState(false);
  const buildingsRef = useRef<Cesium.Cesium3DTileset | null>(null);
  const configRef = useRef<ClientConfig | null>(null);
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

  // Default airframe for simulation / optimisation: the first drone that has one.
  const defaultAirframe = drones.data?.find((d) => d.airframeId)?.airframeId ?? null;
  useEffect(() => {
    if (defaultAirframe) setConditions((c) => ({ ...c, airframeId: defaultAirframe }));
  }, [defaultAirframe]);

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
  // Ground elevation at home above sea level (server DEM), and the offset that maps it onto
  // the rendered terrain (Cesium World Terrain heights are ellipsoidal).
  const demHomeElev = home ? (ground[keyOf(home)] ?? home.alt ?? 0) : 0;
  // Known when the terrain service answered or the plan carries a home altitude (e.g. an imported .plan).
  const homeAmslKnown = !!home && (ground[keyOf(home)] != null || (home.alt ?? 0) !== 0);
  const renderOffset = terrainKind === 'ion' && ionHomeHeight !== null ? ionHomeHeight - demHomeElev : 0;
  const homeElev = demHomeElev + renderOffset;
  homeElevRef.current = homeElev;
  const placeKey = home ? `lat=${home.lat.toFixed(3)}&lon=${home.lon.toFixed(3)}` : null;
  const place = useApi<{ name: string | null }>(placeKey ? `/api/v2/geocode/reverse?${placeKey}` : null, [placeKey]);
  // Weather only when a provider is configured (otherwise the endpoint answers 503).
  const clientCfg = useApi<ClientConfig>('/api/v2/config', []);
  const weatherOn = !!clientCfg.data?.weather;
  const weather = useApi<WeatherDto>(placeKey && weatherOn ? `/api/v2/weather?${placeKey}` : null, [placeKey, weatherOn]);

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
    void (async () => {
      if (!host.current) return;
      const created = await createViewer(host.current);
      const viewer = created.viewer;
      if (destroyed) {
        viewer.destroy();
        return;
      }
      setTerrainKind(created.terrain);
      configRef.current = created.config;
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

      // Cesium only fires an input action registered for the keyboard modifier held during the
      // event, so drag handlers are registered for plain and Shift (altitude) variants below.
      const onDown = (e: { position: Cesium.Cartesian2 }) => {
        const id = entityAt(e.position);
        if (!id || !editable) return;
        const pl = planRef.current!;
        let startAlt = 0;
        if (id.startsWith('wp:')) startAlt = pl.items.find((i) => i.id === id.slice(3))?.alt ?? pl.defaultAlt;
        if (id.startsWith('rally:')) startAlt = pl.rallyPoints[Number(id.slice(6))]?.alt ?? 30;
        drag = { id, startY: e.position.y, startAlt, moved: false };
        if (id.startsWith('wp:')) setSelected(id.slice(3));
        viewer.scene.screenSpaceCameraController.enableInputs = false;
      };

      const onMove = (shift: boolean) => (e: { endPosition: Cesium.Cartesian2 }) => {
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
      };

      const onUp = () => {
        if (drag) {
          viewer.scene.screenSpaceCameraController.enableInputs = true;
          setTimeout(() => (drag = null), 0);
        }
      };

      const { LEFT_DOWN, MOUSE_MOVE, LEFT_UP } = Cesium.ScreenSpaceEventType;
      const { SHIFT, CTRL, ALT } = Cesium.KeyboardEventModifier;
      handler.setInputAction(onDown, LEFT_DOWN);
      handler.setInputAction(onDown, LEFT_DOWN, SHIFT);
      handler.setInputAction(onMove(false), MOUSE_MOVE);
      handler.setInputAction(onMove(true), MOUSE_MOVE, SHIFT);
      // A drag must always end (and camera input be restored), whatever key is held on release.
      handler.setInputAction(onUp, LEFT_UP);
      for (const mod of [SHIFT, CTRL, ALT]) handler.setInputAction(onUp, LEFT_UP, mod);

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

  const groundAt = useCallback((p: LatLon) => (ground[keyOf(p)] ?? demHomeElev) + renderOffset, [ground, demHomeElev, renderOffset]);

  // With Cesium World Terrain, measure the rendered terrain height at home once per position.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || terrainKind !== 'ion' || !home) return;
    let stale = false;
    void terrainHeights(viewer, [home]).then(([h]) => {
      if (!stale && h !== undefined) setIonHomeHeight(h);
    });
    return () => {
      stale = true;
    };
  }, [terrainKind, home?.lat, home?.lon]);

  // Cesium OSM Buildings (ion) as obstacles in the 3D scene.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !configRef.current) return;
    if (buildings && !buildingsRef.current) {
      void addOsmBuildings(viewer, configRef.current).then((t) => {
        buildingsRef.current = t;
        if (!t) setBuildings(false);
      });
    } else if (buildingsRef.current) buildingsRef.current.show = buildings;
  }, [buildings]);

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
      ds.entities.add({ polyline: { positions: path.map(abs), width: 2.5, material: COLORS.path.withAlpha(0.95), arcType: Cesium.ArcType.NONE } });
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
    // Items at the same spot (e.g. a loiter added at the last waypoint) stack their labels.
    const labelsAt = new Map<string, number>();
    plan.items.forEach((it) => {
      if (!NAV_WITH_POS.has(it.type) || it.lat === undefined || it.lon === undefined) return;
      n++;
      const spot = `${it.lat.toFixed(5)},${it.lon.toFixed(5)}`;
      const stacked = labelsAt.get(spot) ?? 0;
      labelsAt.set(spot, stacked + 1);
      const extra =
        it.type === 'loiter' ? ` · ${it.unlimited ? '∞' : it.turns ? `${it.turns}×` : `${it.holdS ?? 0}s`}` : it.holdS ? ` · ${it.holdS}s` : '';
      const alt = it.type === 'land' ? 0 : (it.alt ?? plan.defaultAlt);
      const sel = it.id === selected;
      const pos = Cesium.Cartesian3.fromDegrees(it.lon, it.lat, homeElev + alt);
      // Numbered waypoint marker (white, selected in yellow) with its altitude.
      ds.entities.add({
        id: `wp:${it.id}`,
        position: pos,
        point: { pixelSize: sel ? 16 : 12, color: sel ? COLORS.selected : it.type === 'land' ? COLORS.land : COLORS.wp, outlineColor: Cesium.Color.fromCssColorString('#0b1220'), outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: {
          text: `${n}  ${Math.round(alt)} m${extra}`,
          font: '600 12px sans-serif',
          fillColor: Cesium.Color.BLACK,
          showBackground: true,
          backgroundColor: sel ? COLORS.selected : Cesium.Color.WHITE.withAlpha(0.88),
          backgroundPadding: new Cesium.Cartesian2(5, 3),
          pixelOffset: new Cesium.Cartesian2(0, -20 - 22 * stacked),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      // Loiters are drawn as their circle.
      if (it.type === 'loiter') {
        const r = it.radiusM && it.radiusM > 0 ? it.radiusM : 15;
        ds.entities.add({
          position: pos,
          ellipse: { semiMajorAxis: r, semiMinorAxis: r, height: homeElev + alt, fill: false, outline: true, outlineColor: sel ? COLORS.selected : Cesium.Color.WHITE, outlineWidth: 2 },
        });
      }
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
    if (!viewer || !configRef.current) return;
    void applyImagery(viewer, imagery, configRef.current);
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

  /** Animates the simulated flight in the 3D view (airframe model, 10× real time). */
  const playSimulation = (samples: SimulationSample[]) => {
    const viewer = viewerRef.current;
    if (!viewer || samples.length < 2) return;
    if (simEntity.current) viewer.entities.remove(simEntity.current);
    const start = Cesium.JulianDate.now();
    const position = new Cesium.SampledPositionProperty();
    const orientation = new Cesium.SampledProperty(Cesium.Quaternion);
    let heading = 0;
    samples.forEach((smp, i) => {
      const time = Cesium.JulianDate.addSeconds(start, smp.t, new Cesium.JulianDate());
      const p = Cesium.Cartesian3.fromDegrees(smp.lon, smp.lat, homeElev + smp.altRel);
      const next = samples[i + 1];
      if (next && haversineDistance(smp, next) > 0.5) heading = initialBearing(smp, next);
      position.addSample(time, p);
      orientation.addSample(time, droneOrientation(p, heading, 0, 0));
    });
    const stop = Cesium.JulianDate.addSeconds(start, samples[samples.length - 1]!.t, new Cesium.JulianDate());
    const model = modelOfAirframe(conditions.airframeId);
    simEntity.current = viewer.entities.add({
      id: 'simulation',
      availability: new Cesium.TimeIntervalCollection([new Cesium.TimeInterval({ start, stop })]),
      position,
      orientation: orientation as unknown as Cesium.Property,
      model: { uri: droneModelUri(model), minimumPixelSize: 48, maximumScale: 200, runAnimations: true },
      path: { leadTime: 0, trailTime: 3600, width: 2, material: Cesium.Color.fromCssColorString('#f97316') },
    });
    viewer.clock.startTime = start.clone();
    viewer.clock.stopTime = stop.clone();
    viewer.clock.currentTime = start.clone();
    viewer.clock.clockRange = Cesium.ClockRange.CLAMPED;
    viewer.clock.multiplier = 10;
    viewer.clock.shouldAnimate = true;
    (window as unknown as { __athenaPlanner?: Record<string, unknown> }).__athenaPlanner!.simulation = simEntity.current;
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
          : type === 'camera_trigger'
            ? { id: newItemId(), type, triggerDistanceM: 20 }
          : type === 'loiter' && lastPos
            ? { id: newItemId(), type, lat: lastPos.lat, lon: lastPos.lon, alt: lastPos.alt ?? pl.defaultAlt, holdS: 10 }
            : { id: newItemId(), type };
    setPlan((p) => ({ ...p, items: type === 'takeoff' ? [item, ...p.items] : type === 'rtl' || type === 'land' ? [...p.items, item] : insertBeforeTerminal(p.items, [item], selected) }));
    setSelected(item.id);
  };

  if (mission.error) return <div className="content"><ErrorBox error={mission.error} /></div>;
  if (!plan || !mission.data) return <Loading what="Loading mission…" />;
  const onlineDrones = Object.values(live.drones).filter((d) => d.online);
  return (
    <div className="content fill">
      <div className={`planner${panelOpen ? '' : ' panel-closed'}`}>
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
                  ['survey', '+ Area / line'],
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
              {terrainKind === 'ion' && (
                <button className={`btn small${buildings ? ' primary' : ''}`} onClick={() => setBuildings((b) => !b)} title="Cesium OSM Buildings">
                  3D buildings
                </button>
              )}
            </div>
          </div>
          <div className="small muted planner-hint">
            Click to add · drag points to move · <b>Shift + drag</b> to change altitude · right-drag zoom · Ctrl/middle-drag tilt & rotate · terrain: <span data-testid="terrain-kind">{TERRAIN_LABEL[terrainKind]}</span>
          </div>
        </div>

        <aside className={`planner-side${panelOpen ? '' : ' collapsed'}`} data-testid="planner-panel">
          <div className="planner-head">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <Link to="/missions" className="small">
                ← Missions
              </Link>
              <div className="row" style={{ gap: 4 }}>
                <button className="btn small" onClick={() => download(`${base}/export?format=plan`)}>
                  .plan
                </button>
                <button className="btn small" onClick={() => download(`${base}/export?format=waypoints`)}>
                  .waypoints
                </button>
                <button className="icon-btn" aria-label="Collapse the panel" title="Collapse the panel" onClick={() => setPanelOpen(false)}>
                  ⟩
                </button>
              </div>
            </div>
            <div className="planner-place" data-testid="planner-place">
              <b className="truncate">📍 {place.data?.name ?? (home ? 'Mission area' : 'No position yet')}</b>
              <div className="small muted">
                {home
                  ? `${home.lat.toFixed(5)}, ${home.lon.toFixed(5)} · ${homeAmslKnown ? `ground ${Math.round(demHomeElev)} m AMSL` : 'ground elevation unknown'}`
                  : 'Click the map to place the mission'}
                {weather.data && weather.data.temperatureC !== null && (
                  <span title={`${weather.data.source}: ${weather.data.assessment.status}`}>
                    {' '}
                    · {weatherIcon(weather.data)} {weather.data.temperatureC.toFixed(1)} °C
                    {weather.data.windSpeedMs !== null ? `, wind ${weather.data.windSpeedMs.toFixed(0)} m/s` : ''}
                  </span>
                )}
              </div>
            </div>
            <input aria-label="Mission name" value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} style={{ fontWeight: 600, fontSize: 16 }} disabled={!editable} />
          </div>

          <div className="planner-scroll">
            <section className="card tight" data-testid="mission-settings">
              <h3>Mission setting</h3>
              <div className="form-grid">
                <label className="field" style={{ gridColumn: 'span 2' }}>
                  Vehicle type
                  <select value={conditions.airframeId} onChange={(e) => setConditions({ ...conditions, airframeId: e.target.value })} aria-label="Vehicle type">
                    {AIRFRAMES.map((af) => (
                      <option key={af.id} value={af.id}>
                        {af.kind === 'multirotor' ? 'Multirotor' : af.kind === 'vtol' ? 'VTOL' : 'Fixed-wing'} – {af.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Altitude reference
                  <select value={homeAmslKnown ? altRef : 'rel'} onChange={(e) => setAltRef(e.target.value as AltitudeReference)} aria-label="Altitude reference">
                    <option value="rel">Relative alt (home)</option>
                    <option value="amsl" disabled={!homeAmslKnown}>
                      Above sea level{homeAmslKnown ? '' : ' (needs terrain data)'}
                    </option>
                  </select>
                </label>
                <label className="field">
                  Cruise speed (m/s)
                  <input type="number" value={plan.defaultSpeed} disabled={!editable} onChange={(e) => setPlan((p) => ({ ...p, defaultSpeed: Number(e.target.value) || 1 }))} aria-label="Cruise speed" />
                </label>
                <label className="field">
                  Default altitude (m rel)
                  <input type="number" value={plan.defaultAlt} disabled={!editable} onChange={(e) => setPlan((p) => ({ ...p, defaultAlt: Number(e.target.value) || 1 }))} aria-label="Default altitude" />
                </label>
                {editable && (
                  <button
                    className="btn small"
                    style={{ alignSelf: 'end' }}
                    onClick={() => setPlan((p) => ({ ...p, items: p.items.map((it) => (it.type === 'takeoff' || it.type === 'waypoint' || it.type === 'loiter' ? { ...it, alt: p.defaultAlt } : it)) }))}
                  >
                    Apply to all
                  </button>
                )}
              </div>
            </section>

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

            <section>
              <div className="card-head">
                <h3>Waypoints ({plan.items.length})</h3>
              </div>
              {editable && (
                <div className="row" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 4 }}>
                  {(['takeoff', 'loiter', 'speed', 'photo', 'camera_trigger', 'land', 'rtl'] as MissionItemType[]).map((t) => (
                    <button key={t} className="btn small" onClick={() => addItem(t)}>
                      + {t === 'rtl' ? 'RTL' : t === 'camera_trigger' ? 'camera trigger' : t}
                    </button>
                  ))}
                </div>
              )}
              <MissionItemsList
                plan={plan}
                selected={selected}
                setSelected={setSelected}
                editable={editable}
                updateItem={updateItem}
                moveItem={moveItem}
                deleteItem={(id) => setPlan((p) => ({ ...p, items: p.items.filter((x) => x.id !== id) }))}
                altRef={homeAmslKnown ? altRef : 'rel'}
                homeElevationM={demHomeElev}
              />
            </section>

            {editable && (
              <details className="tool" open={mode === 'survey' || surveyPoly.length > 0 ? true : undefined}>
                <summary>Automatic waypoints</summary>
                <GeneratePanel
                  points={surveyPoly}
                  airframeId={conditions.airframeId}
                  onClear={() => setSurveyPoly([])}
                  onGenerate={(r: GenerateResult) => {
                    setPlan((p) => {
                      const withHome = p.home ? p : { ...p, home: { ...surveyPoly[0]!, alt: 0 } };
                      const items =
                        withHome.items.length === 0
                          ? [{ id: newItemId(), type: 'takeoff' as const, alt: r.alt }, ...r.items, { id: newItemId(), type: 'rtl' as const }]
                          : insertBeforeTerminal(withHome.items, r.items, null);
                      return { ...withHome, items };
                    });
                    toast(`Generated ${r.items.filter((i) => i.lat !== undefined).length} waypoints – ${r.summary}`, 'ok');
                    setSurveyPoly([]);
                    setMode('select');
                  }}
                />
              </details>
            )}

            {editable && (
              <details className="tool">
                <summary>AI route optimisation</summary>
                <OptimizePanel
                  base={base}
                  plan={plan}
                  conditions={conditions}
                  canUndo={!!undoPlan}
                  onApply={(p) => {
                    setUndoPlan(plan);
                    setPlan(() => p);
                    toast('Optimised route applied – save the mission to keep it', 'ok');
                  }}
                  onUndo={() => {
                    if (undoPlan) setPlan(() => undoPlan);
                    setUndoPlan(null);
                  }}
                />
              </details>
            )}

            <details className="tool">
              <summary>Pre-flight simulation</summary>
              <SimulatePanel base={base} plan={plan} conditions={conditions} setConditions={setConditions} onPlay={playSimulation} />
            </details>

            <details className="tool">
              <summary>Rally points & geofence</summary>
              <div className="card tight">
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
              </div>
            </details>

            <details className="tool" open>
              <summary>Terrain & airspace</summary>
              <div className="card tight">
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
            </details>

            {editable && (
              <details className="tool">
                <summary>Schedule</summary>
                <div className="card tight">
                  <button className="btn small" disabled={dirty} title={dirty ? 'Save first' : ''} onClick={() => setModal('schedule')}>
                    Schedule
                  </button>
                </div>
              </details>
            )}
            <ErrorBox error={error} />
          </div>

          <div className="planner-foot" data-testid="planner-foot">
            <div className="small">
              <b>{stats?.waypointCount ?? 0}</b> waypoints · {fmtDuration(stats?.estimatedTimeS ?? 0)} · {fmtDistance(stats?.totalDistanceM ?? 0)}
            </div>
            <div className="row" style={{ gap: 6 }}>
              {editable && (
                <button className="btn ok solid" onClick={save} disabled={!dirty}>
                  {dirty ? 'Save' : 'Saved'}
                </button>
              )}
              {can('drone.control') && (
                <button className="btn primary" disabled={dirty} title={dirty ? 'Save first' : 'Upload to a drone and start or resume the mission'} onClick={() => setModal('upload')}>
                  Resume
                </button>
              )}
              {editable && (
                <button
                  className="btn ghost"
                  disabled={plan.items.length === 0}
                  onClick={() => {
                    if (confirm('Remove all mission items?')) setPlan((p) => ({ ...p, items: [] }));
                  }}
                >
                  Clean
                </button>
              )}
            </div>
          </div>
        </aside>
        {!panelOpen && (
          <button className="btn small planner-reopen" onClick={() => setPanelOpen(true)}>
            ☰ Mission panel
          </button>
        )}
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
