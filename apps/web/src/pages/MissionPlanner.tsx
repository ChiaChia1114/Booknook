/**
 * 3D mission planner (CesiumJS): add waypoints interactively, view the plan from any
 * perspective (rotate, tilt, surface view, orthographic top view), drag waypoints
 * horizontally and – with Shift – vertically, with terrain, airspace volumes and
 * ground hazards rendered in 3D.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Cloud, CloudRain, CloudSun, Download, MapPin, PanelRightClose, PanelRightOpen, RotateCcw, RotateCw, Sun, X } from 'lucide-react';
import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { AIRFRAMES, DEFAULT_AIRFRAME_ID, centroidOf, destinationPoint, haversineDistance, initialBearing, missionPath, missionStats, newItemId, validateMission, type AirspaceCheckDto, type AirspaceZoneDto, type AuthorizationDto, type ConflictDto, type DroneDto, type FlightAuthorityStatusDto, type LatLon, type MemberDto, type MissionDto, type MissionItem, type MissionItemType, type MissionPlan, type SimulationSample, type TerrainSummary, type WeatherDto, type ZoneType, can as canRole, hasVisibleText } from '@athena-sky/shared';
import { ApiError, api, download, errorMessage } from '../api/client';
import { useApi } from '../hooks';
import { requestOutcome } from '../lib/authorization';
import { useAuth, useOrgId } from '../state/auth';
import { useLive } from '../state/live';
import { TerrainProfile } from '../components/charts';
import { TERRAIN_LABEL, addOsmBuildings, createViewer, droneModelUri, droneOrientation, modelOfAirframe, setImagery as applyImagery, terrainHeights, type ClientConfig, type TerrainKind } from '../lib/cesium';
import { DataNotice, ImageryNotice, useImageryStatus } from '../components/ImageryNotice';
import { GeneratePanel, type GenerateResult } from '../components/planner/GeneratePanel';
import { OptimizePanel } from '../components/planner/OptimizePanel';
import { SimulatePanel, type SimulationConditions } from '../components/planner/SimulatePanel';
import { MissionItemsList, type AltitudeReference } from '../components/planner/MissionItemsList';
import { AsyncButton, Badge, ErrorBox, Loading, Modal, fmtDistance, fmtDuration, loadError, useToast } from '../components/ui';
import { overlaps, rectAround, segmentHitsRect, textWidth, type Rect } from '../lib/labels';

type Mode = 'select' | 'waypoint' | 'rally' | 'geofence' | 'survey' | 'home';

const WP_LABEL_FONT = '600 12px sans-serif';
const PLAIN_LABEL_FONT = '13px sans-serif';

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

function WeatherIcon({ w }: { w: WeatherDto }) {
  const I = (w.precipitationMm ?? 0) > 0.2 ? CloudRain : (w.cloudCoverPct ?? 0) > 70 ? Cloud : (w.cloudCoverPct ?? 0) > 25 ? CloudSun : Sun;
  return <I size={13} style={{ verticalAlign: -2 }} aria-hidden="true" />;
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
  const { org, orgError, can } = useAuth();
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
  // Edits so far: a Save marks the mission saved only if nothing was edited while it was under way.
  const edits = useRef(0);
  const edited = useCallback(() => {
    edits.current++;
    setDirty(true);
  }, []);
  const [mode, setMode] = useState<Mode>(editable ? 'waypoint' : 'select');
  const [selected, setSelected] = useState<string | null>(null);
  const [surveyPoly, setSurveyPoly] = useState<LatLon[]>([]);
  const [conditions, setConditions] = useState<SimulationConditions>({ airframeId: DEFAULT_AIRFRAME_ID, payloadKg: 0.5, windMode: 'none', windSpeed: 5, windFrom: 0, temperature: '' });
  const [undoPlan, setUndoPlan] = useState<MissionPlan | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [altRef, setAltRef] = useState<AltitudeReference>('rel');
  const simEntity = useRef<Cesium.Entity | null>(null);
  const [ground, setGround] = useState<Record<string, number | null>>({});
  const [terrainKind, setTerrainKind] = useState<TerrainKind>('flat');
  const [terrainNote, setTerrainNote] = useState<string | null>(null);
  const [ionHomeHeight, setIonHomeHeight] = useState<number | null>(null);
  const [buildings, setBuildings] = useState(false);
  const buildingsRef = useRef<Cesium.Cesium3DTileset | null>(null);
  const configRef = useRef<ClientConfig | null>(null);
  const [terrain, setTerrain] = useState<TerrainSummary | null>(null);
  const [check, setCheck] = useState<AirspaceCheckDto | null>(null);
  const [imagery, setImagery] = useState<'map' | 'satellite'>('map');
  const imageryStatus = useImageryStatus();
  const [ortho, setOrtho] = useState(false);
  const [modal, setModal] = useState<'upload' | 'schedule' | 'authorize' | null>(null);
  // Who decides authorisation requests (told in the request dialog).
  const flightAuthority = useApi<FlightAuthorityStatusDto>(modal === 'authorize' ? `/api/v2/organisations/${orgId}/airspace/authority` : null);
  const [error, setError] = useState<string | null>(null);

  const host = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  /** The latest "Fit mission" (for the viewer set-up, which runs once). */
  const fitRef = useRef<() => void>(() => undefined);
  const missionDs = useRef<Cesium.CustomDataSource | null>(null);
  const zoneDs = useRef<Cesium.CustomDataSource | null>(null);
  const planRef = useRef<MissionPlan | null>(null);
  const modeRef = useRef<Mode>(mode);
  const selectedRef = useRef<string | null>(null);
  /** Waypoint labels hidden because they would overlap another label on screen. */
  const hiddenLabels = useRef(new Set<string>());
  /** Preferred offset of each label (above its marker) and the offset chosen to avoid overlaps. */
  const labelBase = useRef(new Map<string, Cesium.Cartesian2>());
  const labelOffsets = useRef(new Map<string, Cesium.Cartesian2>());
  /** The drawn route (3D positions): labels prefer spots clear of it. */
  const routeLine = useRef<Cesium.Cartesian3[]>([]);
  const homeElevRef = useRef(0);
  const dronesRef = useRef<DroneDto[] | null>(null);
  dronesRef.current = drones.data;
  planRef.current = plan;
  modeRef.current = mode;
  selectedRef.current = selected;

  const setPlan = useCallback((fn: (p: MissionPlan) => MissionPlan) => {
    setPlanState((p) => (p ? fn(p) : p));
    edited();
  }, [edited]);

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
  /** The 3D viewer and its layers exist (created asynchronously once the plan is loaded). */
  const [viewerReady, setViewerReady] = useState(false);
  /**
   * Hides waypoint labels that would overlap a label already placed on screen: the selected
   * waypoint first, then in mission order (zoomed out, only some numbers remain readable).
   */
  /** A label offset that follows the placement chosen by `declutterLabels`. */
  function placedOffset(id: string, base: Cesium.Cartesian2): Cesium.CallbackProperty {
    labelBase.current.set(id, base);
    return new Cesium.CallbackProperty(() => labelOffsets.current.get(id) ?? base, false);
  }

  /**
   * Places the labels so that none overlaps another label or sits on another marker: above the
   * marker, else below, right or left of it, else hidden. The selected waypoint's label always
   * shows, then home, the waypoints in order and the rally points.
   */
  function declutterLabels(viewer: Cesium.Viewer): void {
    const ds = missionDs.current;
    if (!ds) return;
    const now = viewer.clock.currentTime;
    const items: { id: string; rank: number; order: number; x: number; y: number; w: number; h: number; size: number }[] = [];
    const markers: { id: string; rect: Rect }[] = [];
    for (const e of ds.entities.values) {
      const id = String(e.id);
      const kind = id.startsWith('wp:') ? 'wp' : id === 'home' ? 'home' : id.startsWith('rally:') ? 'rally' : id.startsWith('gf:') ? 'gf' : null;
      if (!kind) continue;
      const pos = e.position?.getValue(now);
      const c = pos ? viewer.scene.cartesianToCanvasCoordinates(pos) : undefined;
      if (!c) continue;
      const size = Number(e.point?.pixelSize?.getValue(now) ?? 10) + 4;
      markers.push({ id, rect: rectAround(c.x, c.y, size, size) });
      if (!e.label || kind === 'gf') continue;
      const text = String(e.label.text?.getValue(now) ?? '');
      const sel = id === `wp:${selectedRef.current}`;
      items.push({
        id,
        rank: sel ? 0 : kind === 'home' ? 1 : kind === 'wp' ? 2 : 3,
        order: items.length,
        x: c.x,
        y: c.y,
        w: textWidth(text, kind === 'wp' ? WP_LABEL_FONT : PLAIN_LABEL_FONT) + (kind === 'wp' ? 10 : 6),
        h: kind === 'wp' ? 19 : 17,
        size,
      });
    }
    items.sort((a, b) => a.rank - b.rank || a.order - b.order);
    // The route on screen (segments behind the camera are left out).
    const line = routeLine.current.map((p) => viewer.scene.cartesianToCanvasCoordinates(p));
    const crossesRoute = (r: Rect) => line.some((a, i) => i > 0 && !!a && !!line[i - 1] && segmentHitsRect(line[i - 1]!.x, line[i - 1]!.y, a.x, a.y, r));
    const placed: Rect[] = [];
    const hide = new Set<string>();
    const offsets = new Map<string, Cesium.Cartesian2>();
    for (const it of items) {
      const base = labelBase.current.get(it.id) ?? new Cesium.Cartesian2(0, -18);
      // Above the marker (preferred), below it, to its right, to its left.
      const side = it.w / 2 + it.size / 2 + 4;
      const candidates = [base, new Cesium.Cartesian2(0, -base.y), new Cesium.Cartesian2(side, 0), new Cesium.Cartesian2(-side, 0)];
      const free = (o: Cesium.Cartesian2) => {
        const r = rectAround(it.x + o.x, it.y + o.y, it.w, it.h);
        return !placed.some((p) => overlaps(p, r)) && !markers.some((m) => m.id !== it.id && overlaps(m.rect, r));
      };
      // A free spot clear of the route line if there is one, else any free spot.
      const freeSpots = candidates.filter(free);
      const chosen = freeSpots.find((o) => !crossesRoute(rectAround(it.x + o.x, it.y + o.y, it.w, it.h))) ?? freeSpots[0] ?? (it.rank === 0 ? base : null);
      if (!chosen) {
        hide.add(it.id);
        continue;
      }
      offsets.set(it.id, chosen);
      placed.push(rectAround(it.x + chosen.x, it.y + chosen.y, it.w, it.h));
    }
    labelOffsets.current = offsets;
    hiddenLabels.current = hide;
  }

  useEffect(() => {
    if (!ready || !host.current) return;
    let destroyed = false;
    let handler: Cesium.ScreenSpaceEventHandler | null = null;
    void (async () => {
      if (!host.current) return;
      const created = await createViewer(host.current, { onImageryStatus: imageryStatus.track() });
      const viewer = created.viewer;
      if (destroyed) {
        viewer.destroy();
        return;
      }
      setTerrainKind(created.terrain);
      setTerrainNote(created.terrainNote);
      configRef.current = created.config;
      viewerRef.current = viewer;
      missionDs.current = new Cesium.CustomDataSource('mission');
      zoneDs.current = new Cesium.CustomDataSource('airspace');
      viewer.scene.preRender.addEventListener(() => declutterLabels(viewer));
      void viewer.dataSources.add(zoneDs.current);
      void viewer.dataSources.add(missionDs.current);
      (window as unknown as { __athenaPlanner?: unknown }).__athenaPlanner = { viewer };
      // Layers drawn before this point were skipped: draw them now.
      setViewerReady(true);

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
      // An existing mission opens framed in the visible part of the view (as "Fit mission").
      if (p.items.some((i) => i.lat !== undefined && i.lon !== undefined)) requestAnimationFrame(() => fitRef.current());

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
        if (!t) {
          setBuildings(false);
          toast('The 3D buildings could not be loaded', 'error');
        }
      });
    } else if (buildingsRef.current) buildingsRef.current.show = buildings;
  }, [buildings]);

  useEffect(() => {
    const ds = missionDs.current;
    if (!ds || !plan) return;
    ds.entities.removeAll();
    const abs = (p: LatLon & { alt: number }) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, homeElev + p.alt);
    const label = (id: string, text: string, color = Cesium.Color.WHITE) => ({
      text,
      font: PLAIN_LABEL_FONT,
      fillColor: color,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: placedOffset(id, new Cesium.Cartesian2(0, -18)),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      show: new Cesium.CallbackProperty(() => !hiddenLabels.current.has(id), false),
    });
    const path = missionPath(plan);
    routeLine.current = path.map(abs);
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
        label: label('home', 'H'),
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
          font: WP_LABEL_FONT,
          fillColor: Cesium.Color.BLACK,
          showBackground: true,
          backgroundColor: sel ? COLORS.selected : Cesium.Color.WHITE.withAlpha(0.88),
          backgroundPadding: new Cesium.Cartesian2(5, 3),
          pixelOffset: placedOffset(`wp:${it.id}`, new Cesium.Cartesian2(0, -20 - 22 * stacked)),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          show: new Cesium.CallbackProperty(() => !hiddenLabels.current.has(`wp:${it.id}`), false),
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
        label: label(`rally:${i}`, `R${i + 1} · ${r.alt} m`, COLORS.rally),
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
  }, [plan, selected, homeElev, surveyPoly, groundAt, home?.lat, home?.lon, viewerReady]);

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
  }, [zones.data, homeElev, ready, viewerReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !configRef.current) return;
    void applyImagery(viewer, imagery, configRef.current, imageryStatus.track());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imagery]);

  // ---------------------------------------------------------------------------------------
  // Camera tools: rotate, tilt, surface view, orthographic top view, fit
  // ---------------------------------------------------------------------------------------

  /** Centre of the mission and the radius to keep in view (with a margin). */
  const focus = (): { center: LatLon; radius: number } => {
    const pts = plan ? missionPath(plan) : [];
    const c = centroidOf(pts.length ? pts : home ? [home] : [{ lat: 25.0732, lon: 121.5355 }])!;
    const radius = Math.max(110, ...pts.map((p) => haversineDistance(c, p) * 1.45));
    return { center: c, radius };
  };
  /**
   * Shares of the 3D view hidden by overlays, per side: the toolbar rows at the top, the
   * mission panel on the right (wide screens) or at the bottom (bottom sheet, narrow screens).
   */
  const coveredBand = (): { top: number; bottom: number; left: number; right: number } => {
    const out = { top: 0, bottom: 0, left: 0, right: 0 };
    const view = host.current;
    if (!view) return out;
    const v = view.getBoundingClientRect();
    if (v.height <= 0 || v.width <= 0) return out;
    const panel = document.querySelector('.planner-side:not(.collapsed)');
    if (panel) {
      const p = panel.getBoundingClientRect();
      if (p.width >= v.width * 0.8 && p.top > v.top + 10) out.bottom = (v.bottom - p.top) / v.height;
      else if (p.height >= v.height * 0.5 && p.left > v.left + v.width * 0.25) out.right = (v.right - p.left) / v.width;
    }
    const toolbar = view.parentElement?.querySelector('.planner-toolbar');
    const rows = toolbar ? [...toolbar.children].map((c) => c.getBoundingClientRect()).filter((r) => r.height > 0) : [];
    if (rows.length) out.top = (Math.max(...rows.map((r) => r.bottom)) - v.top) / v.height;
    // The mission is framed in what really remains visible (on a phone, between the toolbars and
    // the bottom sheet that is often only a quarter of the view) – at least 15 % each way.
    const clamp = (a: 'top' | 'left', b: 'bottom' | 'right') => {
      out[a] = Math.max(0, out[a]);
      out[b] = Math.max(0, out[b]);
      const total = out[a] + out[b];
      if (total > 0.85) {
        out[a] *= 0.85 / total;
        out[b] *= 0.85 / total;
      }
    };
    clamp('top', 'bottom');
    clamp('left', 'right');
    return out;
  };
  /** Frames the mission in the visible part of the view (clear of the toolbars and the panel). */
  const look = (headingDeg: number | null, pitchDeg: number) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const { center, radius } = focus();
    viewer.camera.switchToPerspectiveFrustum();
    setOrtho(false);
    const fr = viewer.camera.frustum as Cesium.PerspectiveFrustum;
    const tanY = Math.tan((fr.fovy ?? Cesium.Math.toRadians(60)) / 2);
    const tanX = tanY * (fr.aspectRatio || 1);
    const band = coveredBand();
    // The visible part in normalised device units: half sizes and centre.
    const halfH = 1 - band.top - band.bottom;
    const halfW = 1 - band.left - band.right;
    const yc = band.bottom - band.top;
    const xc = band.left - band.right;
    const range = radius / Math.min(halfH * tanY, halfW * tanX);
    const target = Cesium.Cartesian3.fromDegrees(center.lon, center.lat, homeElev);
    const heading = headingDeg === null ? viewer.camera.heading : Cesium.Math.toRadians(headingDeg);
    viewer.camera.lookAt(target, new Cesium.HeadingPitchRange(heading, Cesium.Math.toRadians(pitchDeg), range));
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    // Aim so that the mission sits in the middle of the visible part.
    if (Math.abs(yc) > 0.001) viewer.camera.lookDown(Math.atan(yc * tanY));
    if (Math.abs(xc) > 0.001) viewer.camera.lookRight(Math.atan(-xc * tanX));
  };
  fitRef.current = () => look(0, -45);
  const rotate = (deg: number) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    look(Cesium.Math.toDegrees(viewer.camera.heading) + deg, Math.min(-10, Cesium.Math.toDegrees(viewer.camera.pitch)));
  };
  const topView = () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const { center, radius } = focus();
    viewer.camera.switchToOrthographicFrustum();
    setOrtho(true);
    const fr = viewer.camera.frustum as Cesium.OrthographicFrustum;
    const aspect = fr.aspectRatio || viewer.scene.drawingBufferWidth / Math.max(1, viewer.scene.drawingBufferHeight);
    const band = coveredBand();
    const halfH = 1 - band.top - band.bottom;
    const halfW = 1 - band.left - band.right;
    // Visible width (m) such that the mission fits into the visible part both ways.
    fr.width = Math.max((2 * radius) / halfW, (2 * radius * aspect) / halfH);
    // North up: offset the camera so that the mission sits in the middle of the visible part.
    const east = -(band.left - band.right) * (fr.width / 2);
    const north = -(band.bottom - band.top) * (fr.width / aspect / 2);
    let eye: LatLon = center;
    if (Math.abs(east) > 0.01) eye = destinationPoint(eye, east > 0 ? 90 : 270, Math.abs(east));
    if (Math.abs(north) > 0.01) eye = destinationPoint(eye, north > 0 ? 0 : 180, Math.abs(north));
    viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(eye.lon, eye.lat, homeElev + radius * 4), orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 } });
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
    if (!hasVisibleText(name)) {
      toast('Give the mission a name before saving it', 'error');
      return false;
    }
    const saving = edits.current;
    try {
      const m = await api<MissionDto>(base, { method: 'PUT', body: { name, plan } });
      mission.setData(m);
      // Edited while the request was under way: what is on screen is not what was saved.
      if (edits.current !== saving) {
        toast('Mission saved – but not the changes made meanwhile: save again', 'error');
        return false;
      }
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

  if (mission.error) {
    return (
      <div className="content">
        <ErrorBox error={loadError('The mission', mission.error)} />
        <Link to="/missions">← All missions</Link>
      </div>
    );
  }
  if (!plan || !mission.data) return <Loading what="Loading mission…" />;
  const onlineDrones = Object.values(live.drones).filter((d) => d.online);
  return (
    <div className="content fill">
      <div className={`planner${panelOpen ? '' : ' panel-closed'}`}>
        <div className="planner-view">
          <div ref={host} className="cesium-host" data-testid="planner-3d" />
          <div className="planner-toolbar">
            {editable && (
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
                  <button key={m} className={`btn small${mode === m ? ' active' : ''}`} onClick={() => setMode(m)}>
                    {l}
                  </button>
                ))}
              </div>
            )}
            <div className="group" role="toolbar" aria-label="View">
              <button className="btn small" title="Rotate left" aria-label="Rotate left" onClick={() => rotate(-45)}>
                <RotateCcw />
              </button>
              <button className="btn small" title="Rotate right" aria-label="Rotate right" onClick={() => rotate(45)}>
                <RotateCw />
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
            {editable ? (
              <>
                Click to add · drag points to move · <b>Shift + drag</b> to change altitude ·{' '}
              </>
            ) : (
              <>View only · </>
            )}
            right-drag zoom · Ctrl/middle-drag tilt & rotate · terrain: <span data-testid="terrain-kind" title={terrainNote ?? undefined}>{TERRAIN_LABEL[terrainKind]}{terrainNote ? ` (${terrainNote})` : ''}</span>{' '}
            <ImageryNotice status={imageryStatus.status} />
            <DataNotice what="airspace zones" error={zones.error} />
          </div>
        </div>

        <aside className={`planner-side${panelOpen ? '' : ' collapsed'}`} data-testid="planner-panel">
          <div className="planner-head">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <Link to="/missions" className="small row" style={{ gap: 4 }}>
                <ArrowLeft size={14} /> Missions
              </Link>
              <div className="row" style={{ gap: 4 }}>
                <button className="btn small" onClick={() => download(`${base}/export?format=plan`)} title="Export QGroundControl .plan">
                  <Download /> .plan
                </button>
                <button className="btn small" onClick={() => download(`${base}/export?format=waypoints`)}>
                  .waypoints
                </button>
                <button className="icon-btn" aria-label="Collapse the panel" title="Collapse the panel" onClick={() => setPanelOpen(false)}>
                  <PanelRightClose />
                </button>
              </div>
            </div>
            <div className="planner-place" data-testid="planner-place">
              <b className="place-name">
                <MapPin size={15} style={{ color: 'var(--accent)', flex: 'none' }} aria-hidden="true" /> <span className="truncate">{place.data?.name ?? (home ? 'Mission area' : 'No position yet')}</span>
              </b>
              <div className="small muted">
                {home
                  ? `${home.lat.toFixed(5)}, ${home.lon.toFixed(5)} · ${homeAmslKnown ? `ground ${Math.round(demHomeElev)} m AMSL` : 'ground elevation unknown'}`
                  : 'Click the map to place the mission'}
                {weather.error && <span title={`The weather could not be loaded: ${weather.error}`}>· weather unavailable</span>}
                {weather.data && weather.data.temperatureC !== null && (
                  <span title={`${weather.data.source}: ${weather.data.assessment.status}`}>
                    {' '}
                    · <WeatherIcon w={weather.data} /> {weather.data.temperatureC.toFixed(1)} °C
                    {weather.data.windSpeedMs !== null ? `, wind ${weather.data.windSpeedMs.toFixed(0)} m/s` : ''}
                  </span>
                )}
              </div>
            </div>
            <input aria-label="Mission name" value={name} onChange={(e) => { setName(e.target.value); edited(); }} style={{ fontWeight: 600, fontSize: 16 }} disabled={!editable} />
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

            {!org && orgError && (
              <div className="issue warning" role="alert">
                The organisation's altitude limit could not be loaded ({orgError}) – the plan is checked against 120 m here; the server checks it against the real limit.
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
                <h3>Mission items ({plan.items.length})</h3>
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
                      <button className="btn small ghost" aria-label={`Remove rally point ${i + 1}`} onClick={() => setPlan((p) => ({ ...p, rallyPoints: p.rallyPoints.filter((_, k) => k !== i) }))}>
                        <X />
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
                      <button className="btn small ghost" aria-label="Remove the geofence" onClick={() => setPlan((p) => ({ ...p, geofence: null }))}>
                        <X />
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
                  <AsyncButton
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
                  </AsyncButton>
                  <AsyncButton
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
                  </AsyncButton>
                  {can('authorization.request') && (
                    // The request is for the mission as stored: unsaved edits are saved first.
                    <AsyncButton
                      className="btn small"
                      onClick={async () => {
                        if (dirty && !(await save())) return;
                        setModal('authorize');
                      }}
                    >
                      Request authorisation
                    </AsyncButton>
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
                <AsyncButton className="btn ok solid" onClick={save} disabled={!dirty}>
                  {dirty ? 'Save' : 'Saved'}
                </AsyncButton>
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
            <PanelRightOpen /> Mission panel
          </button>
        )}
      </div>

      {modal === 'upload' && (
        <UploadModal
          drones={onlineDrones.map((d) => ({
            id: d.droneId,
            name: d.name,
            inAir: !!d.telemetry?.inAir,
            // As the drone refuses it: no other mission while one is flown on this flight.
            busy: !!d.telemetry?.inAir && (d.telemetry.mode === 'MISSION' || (d.mission?.seq ?? 0) > 0),
          }))}
          canOverride={can('authorization.decide')}
          onClose={() => setModal(null)}
          onUpload={async (droneId, start, acceptAirspaceConflicts) => {
            try {
              await api(`${base}/upload`, { body: { droneId, ...(acceptAirspaceConflicts ? { acceptAirspaceConflicts: true } : {}) } });
              toast('Mission uploaded to the drone', 'ok');
              if (start && client) {
                const r = await client.command(droneId, 'mission_start');
                toast(`Mission start: ${r.result}${r.message ? ` – ${r.message}` : ''}`, r.result === 'accepted' ? 'ok' : 'error');
              }
              setModal(null);
              return null;
            } catch (err) {
              // Blocked airspace: the modal lists the conflicts (and offers an override to managers).
              if (err instanceof ApiError && err.code === 'airspace_blocked') {
                const details = err.details as { drones?: { conflicts: ConflictDto[] }[] } | undefined;
                return details?.drones?.[0]?.conflicts ?? [];
              }
              toast(errorMessage(err), 'error');
              return null;
            }
          }}
        />
      )}
      {modal === 'schedule' && (
        <ScheduleModal
          drones={drones.data ?? []}
          members={members.data ?? []}
          notLoaded={[loadError('The drones', drones.error), loadError('The pilots', members.error)].filter(Boolean).join(' ') || null}
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
          notLoaded={loadError('The drones', drones.error)}
          decider={
            flightAuthority.data
              ? { known: true, authority: flightAuthority.data.configured ? (flightAuthority.data.name ?? 'the flight authority') : null }
              : { known: false, error: flightAuthority.error }
          }
          onClose={() => setModal(null)}
          onSubmit={async (body) => {
            try {
              const r = await api<AuthorizationDto>(`/api/v2/organisations/${orgId}/airspace/authorizations`, { body: { ...body, missionId } });
              const outcome = requestOutcome(r);
              toast(`Authorisation ${outcome.message}`, outcome.tone);
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

function UploadModal({
  drones,
  canOverride,
  onClose,
  onUpload,
}: {
  drones: { id: string; name: string; inAir: boolean; busy: boolean }[];
  canOverride: boolean;
  onClose(): void;
  /** Resolves with the airspace conflicts when the upload was refused because of them. */
  onUpload(droneId: string, start: boolean, acceptAirspaceConflicts: boolean): Promise<ConflictDto[] | null>;
}) {
  const [droneId, setDroneId] = useState(() => drones.find((d) => !d.busy)?.id ?? '');
  const [start, setStart] = useState(false);
  const [blocked, setBlocked] = useState<ConflictDto[] | null>(null);
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const conflicts = await onUpload(droneId, start, !!blocked && override);
    setBusy(false);
    if (conflicts) {
      setBlocked(conflicts);
      setOverride(false);
    }
  };
  return (
    <Modal
      title="Resume on a drone"
      onClose={onClose}
      actions={
        <button className={`btn ${blocked ? 'danger' : 'primary'}`} disabled={!droneId || busy || (!!blocked && !override)} onClick={() => void submit()}>
          {blocked ? (start ? 'Override and resume now' : 'Override and upload for later') : start ? 'Resume now' : 'Upload for later'}
        </button>
      }
    >
      {drones.length === 0 ? (
        <div className="muted">No drone is online. Missions can be uploaded to online drones only (schedule it instead).</div>
      ) : (
        <div className="form">
          <p className="small muted" style={{ margin: 0 }}>
            The plan is uploaded to the drone over the link and flown from where the drone is: now, or later from the live console – Start mission (on the ground: it arms and takes off) or Resume (in the air).
          </p>
          <select
            value={droneId}
            onChange={(e) => {
              setDroneId(e.target.value);
              setBlocked(null);
            }}
            aria-label="Drone"
          >
            {drones.map((d) => (
              <option key={d.id} value={d.id} disabled={d.busy}>
                {d.name}
                {d.busy ? ' (flying a mission)' : d.inAir ? ' (in the air)' : ''}
              </option>
            ))}
          </select>
          <label className="row">
            <input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} /> Start the mission immediately
            {drones.find((d) => d.id === droneId)?.inAir ? ' (flown from where the drone is)' : ' (arms and takes off)'}
          </label>
          {blocked && (
            <div className="col" style={{ gap: 6 }} data-testid="upload-airspace-blocked">
              <div className="issue error">The airspace check is blocked – the mission was not uploaded.</div>
              {blocked
                .filter((c) => c.severity === 'blocking')
                .map((c, i) => (
                  <div key={i} className="small">
                    • {c.message}
                  </div>
                ))}
              {canOverride ? (
                <label className="row small">
                  <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> I have permission to fly here – override the check (recorded in the audit log)
                </label>
              ) : (
                <div className="small muted">Change the route, or ask an owner or administrator to override the check.</div>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function ScheduleModal({ drones, members, notLoaded, onClose, onSave }: { drones: DroneDto[]; members: MemberDto[]; notLoaded: string | null; onClose(): void; onSave(b: { droneId: string; pilotId: string | null; plannedAt: string }): Promise<void> }) {
  const [droneId, setDroneId] = useState(drones[0]?.id ?? '');
  const [pilotId, setPilotId] = useState('');
  const [when, setWhen] = useState(() => new Date(Date.now() + 86_400_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
  return (
    <Modal title="Schedule mission" onClose={onClose} actions={<AsyncButton className="btn primary" disabled={!droneId} onClick={() => onSave({ droneId, pilotId: pilotId || null, plannedAt: new Date(when).toISOString() })}>Schedule</AsyncButton>}>
      <div className="form">
        <ErrorBox error={notLoaded} />
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
            {members.filter((m) => canRole(m.role, 'drone.control')).map((m) => (
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

function AuthorizeModal({
  path,
  droneOptions,
  notLoaded,
  decider,
  onClose,
  onSubmit,
}: {
  path: (LatLon & { alt: number })[];
  droneOptions: DroneDto[];
  /** Why the drones to choose from could not be loaded (null: they were). */
  notLoaded: string | null;
  /** Who decides requests: the external flight authority (null: none, Athena-sky and the mission managers), or not known (yet). */
  decider: { known: true; authority: string | null } | { known: false; error: string | null };
  onClose(): void;
  onSubmit(b: Record<string, unknown>): Promise<void>;
}) {
  const [start, setStart] = useState(() => new Date(Date.now() + 15 * 60_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
  const [hours, setHours] = useState(1);
  const [width, setWidth] = useState(100);
  const [droneId, setDroneId] = useState('');
  // One request per click: the server may wait for the authority's answer.
  const [submitting, setSubmitting] = useState(false);
  const maxAlt = Math.ceil(Math.max(10, ...path.map((p) => p.alt)) + 10);
  const line = path.filter((p, i) => i === 0 || haversineDistance(p, path[i - 1]!) > 1).map((p) => ({ lat: p.lat, lon: p.lon }));
  return (
    <Modal
      title="Request flight authorisation (corridor)"
      onClose={onClose}
      actions={
        <button
          className="btn primary"
          disabled={line.length < 2 || submitting}
          aria-busy={submitting}
          onClick={async () => {
            if (submitting) return;
            setSubmitting(true);
            try {
              const s = new Date(start);
              await onSubmit({ geometry: { kind: 'corridor', line, widthM: width }, maxAltM: maxAlt, startAt: s.toISOString(), endAt: new Date(s.getTime() + hours * 3_600_000).toISOString(), droneId: droneId || null });
            } finally {
              setSubmitting(false);
            }
          }}
        >
          {submitting ? 'Submitting…' : 'Submit'}
        </button>
      }
    >
      <p className="small muted" data-testid="authorize-how">
        The corridor follows the mission path. Requests that conflict with airspace, ground hazards or other operators are rejected at once.{' '}
        {!decider.known
          ? decider.error
            ? `Who decides the others could not be read (${decider.error}) – the Airspace page shows it and follows every request.`
            : 'Finding out who decides the others…'
          : decider.authority
            ? `The others are submitted to ${decider.authority}, which approves or rejects them – at once or later (the Airspace page follows them); approved public ones appear on its safety map.`
            : 'The others are approved instantly and published on the public safety map – in controlled airspace they wait for a mission manager.'}
      </p>
      <ErrorBox error={notLoaded} />
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
