/**
 * Real-time 3D view of the fleet (CesiumJS) – the main stage of the live console:
 * drone models oriented by heading, pitch and roll (propellers spin while armed), smoothed
 * between telemetry samples, orange name tags, yellow altitude lines, the flown trajectory
 * (thick yellow), the camera view frustum, the routes of running missions (numbered
 * waypoints, loiter circles), other traffic and airspace volumes. Opens with a flight from
 * the whole globe down to the fleet. Loaded on demand (Cesium is large).
 */
import { useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import { overlaps, textWidth, type Rect } from '../lib/labels';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import type { AirspaceZoneDto, DetectedAircraft, MissionPlan, ZoneType } from '@athena-sky/shared';
import { airframeById, centroidOf, destinationPoint, missionPath } from '@athena-sky/shared';
import type { DroneView } from '../api/live';
import { TERRAIN_LABEL, createViewer, droneModelUri, droneOrientation, setImagery, terrainHeights, type ClientConfig, type DroneModel, type ImageryKind, type TerrainKind } from '../lib/cesium';

const ZONE_COLORS: Record<ZoneType, string> = {
  prohibited: '#ef4444',
  restricted: '#ef4444',
  temporary: '#a855f7',
  controlled: '#f97316',
  danger: '#eab308',
  hazard_powerline: '#facc15',
  hazard_obstacle: '#f43f5e',
};
const YELLOW = Cesium.Color.fromCssColorString('#facc15');
const ORANGE = Cesium.Color.fromCssColorString('#f59e0b');
const FRUSTUM = Cesium.Color.fromCssColorString('#60a5fa');

interface Sample {
  at: number;
  lat: number;
  lon: number;
  altRel: number;
  heading: number;
  pitch: number;
  roll: number;
}

interface Track {
  samples: Sample[];
  armed: boolean;
  trail: Cesium.Cartesian3[];
  /** Rendered terrain height at the drone's home (vertical reference), keyed by home. */
  ref: { key: string; height: number } | null;
  refPending: string | null;
  altMslRef: number;
}

const RENDER_DELAY_MS = 300;
const TRAIL_POINTS = 600;
/** Camera gimbal pitch used for the view frustum (degrees below the horizon). */
const GIMBAL_PITCH = -45;

export interface Live3DLayers {
  frustum: boolean;
  routes: boolean;
  zones: boolean;
  trails: boolean;
}

export interface Live3DProps {
  drones: DroneView[];
  models: Record<string, DroneModel>;
  /** Airframe of each drone (camera field of view of the frustum). */
  airframes?: Record<string, string | null>;
  zones: AirspaceZoneDto[];
  /** Plans of the missions the drones are flying, by mission id. */
  missions?: Record<string, MissionPlan>;
  selectedId: string | null;
  onSelect?(droneId: string): void;
  /** When set, a click on the terrain reports the position instead of selecting. */
  onPick?: ((lat: number, lon: number) => void) | null;
  layers?: Live3DLayers;
  follow?: boolean;
  /** Planned routes shown before upload (e.g. a swarm preview), one colour per drone. */
  previewRoutes?: { droneId: string; plan: MissionPlan; color: string }[] | null;
}

const DEFAULT_LAYERS: Live3DLayers = { frustum: true, routes: true, zones: true, trails: true };

function lerpAngle(a: number, b: number, f: number): number {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * f + 360) % 360;
}

/** Drone tags: centre this far above the model, this tall (12 px text + padding), this far apart. */
const TAG_ABOVE = 40;
const TAG_H = 22;
const TAG_GAP = 4;
const TAG_FONT = '600 12px sans-serif';
const ROUTE_LABEL_FONT = '600 11px sans-serif';

const DEFAULT_TAG_OFFSET = new Cesium.Cartesian2(0, -TAG_ABOVE);

export default function Live3D(props: Live3DProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const tracks = useRef(new Map<string, Track>());
  const entities = useRef(new Map<string, Cesium.Entity[]>());
  /** Pixel offset of each drone's tag, moved up so that tags of drones close on screen do not overlap. */
  const tagOffsets = useRef(new Map<string, Cesium.Cartesian2>());
  /** Route waypoint labels hidden because they would cover a drone tag. */
  const hiddenRouteLabels = useRef(new Set<string>());
  const trafficDs = useRef<Cesium.CustomDataSource | null>(null);
  const zoneDs = useRef<Cesium.CustomDataSource | null>(null);
  const routeDs = useRef<Cesium.CustomDataSource | null>(null);
  const objectsDs = useRef<Cesium.CustomDataSource | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const layersRef = useRef<Live3DLayers>(props.layers ?? DEFAULT_LAYERS);
  layersRef.current = props.layers ?? DEFAULT_LAYERS;
  const [terrain, setTerrain] = useState<TerrainKind | null>(null);
  const [imagery, setImageryKind] = useState<ImageryKind>('map');
  const configRef = useRef<ClientConfig | null>(null);
  const flown = useRef(false);
  // Re-run the data effects only when the data changed (the page re-renders on every video frame).
  const telemetryKey = props.drones.map((d) => `${d.droneId}:${d.telemetry?.t ?? 0}`).join('|');
  const trafficKey = props.drones
    .flatMap((d) => d.traffic)
    .map((a) => `${a.icao}:${a.lat.toFixed(4)}:${a.lon.toFixed(4)}:${Math.round(a.altMsl / 10)}`)
    .join('|');
  const routeKey = props.drones.map((d) => `${d.droneId}:${d.mission?.missionId ?? ''}:${d.mission?.seq ?? ''}`).join('|');

  // Viewer life-cycle.
  useEffect(() => {
    let destroyed = false;
    let handler: Cesium.ScreenSpaceEventHandler | null = null;
    void (async () => {
      if (!host.current) return;
      const { viewer, terrain: kind, config } = await createViewer(host.current);
      if (destroyed) {
        viewer.destroy();
        return;
      }
      viewerRef.current = viewer;
      configRef.current = config;
      viewer.scene.preRender.addEventListener(() => declutterTags(viewer));
      // Real-time clock: drives the model animations (spinning propellers).
      viewer.clock.shouldAnimate = true;
      // 30 fps is plenty for telemetry at a few Hz and keeps weaker clients responsive.
      viewer.targetFrameRate = 30;
      // Start from the whole globe (the flight down happens when the fleet is known).
      viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(121.5, 23.5, 2.2e7) });
      setTerrain(kind);
      trafficDs.current = new Cesium.CustomDataSource('traffic');
      zoneDs.current = new Cesium.CustomDataSource('zones');
      routeDs.current = new Cesium.CustomDataSource('routes');
      objectsDs.current = new Cesium.CustomDataSource('ai-objects');
      void viewer.dataSources.add(zoneDs.current);
      void viewer.dataSources.add(routeDs.current);
      void viewer.dataSources.add(trafficDs.current);
      void viewer.dataSources.add(objectsDs.current);
      handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction((e: { position: Cesium.Cartesian2 }) => {
        const pick = propsRef.current.onPick;
        if (pick) {
          const ray = viewer.camera.getPickRay(e.position);
          const cart = (ray ? viewer.scene.globe.pick(ray, viewer.scene) : undefined) ?? viewer.camera.pickEllipsoid(e.position);
          if (cart) {
            const c = Cesium.Cartographic.fromCartesian(cart);
            pick(Cesium.Math.toDegrees(c.latitude), Cesium.Math.toDegrees(c.longitude));
          }
          return;
        }
        const picked = viewer.scene.pick(e.position) as { id?: Cesium.Entity } | undefined;
        const id = picked?.id?.id;
        if (typeof id === 'string' && id.startsWith('drone:')) propsRef.current.onSelect?.(id.slice(6));
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      (window as unknown as { __athenaLive3D?: unknown }).__athenaLive3D = { viewer, tracks: tracks.current };
    })();
    return () => {
      destroyed = true;
      handler?.destroy();
      viewerRef.current?.destroy();
      viewerRef.current = null;
      entities.current.clear();
      tracks.current.clear();
      delete (window as unknown as { __athenaLive3D?: unknown }).__athenaLive3D;
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer && configRef.current) void setImagery(viewer, imagery, configRef.current);
  }, [imagery]);

  // Telemetry → samples, entities and vertical references.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !terrain) return;
    const now = performance.now();
    const seen = new Set<string>();
    for (const d of props.drones) {
      const t = d.telemetry;
      if (!t) continue;
      seen.add(d.droneId);
      let tr = tracks.current.get(d.droneId);
      if (!tr) {
        tr = { samples: [], armed: t.armed, trail: [], ref: null, refPending: null, altMslRef: t.altMsl - t.altRel };
        tracks.current.set(d.droneId, tr);
      }
      const last = tr.samples[tr.samples.length - 1];
      if (!last || last.lat !== t.lat || last.lon !== t.lon || last.altRel !== t.altRel || last.heading !== t.heading) {
        tr.samples.push({ at: now, lat: t.lat, lon: t.lon, altRel: t.altRel, heading: t.heading, pitch: t.pitch, roll: t.roll });
        if (tr.samples.length > 6) tr.samples.shift();
      }
      tr.altMslRef = t.altMsl - t.altRel;
      tr.armed = t.armed;
      // Vertical reference: rendered terrain height at home (falls back to the AMSL altitude).
      const home = t.home ?? (!t.inAir ? { lat: t.lat, lon: t.lon } : null);
      if (home) {
        const key = `${home.lat.toFixed(6)},${home.lon.toFixed(6)}`;
        if (tr.ref?.key !== key && tr.refPending !== key) {
          tr.refPending = key;
          const track = tr;
          void terrainHeights(viewer, [home]).then(([h]) => {
            if (track.refPending === key) track.ref = { key, height: terrain === 'flat' ? 0 : (h ?? 0) };
          });
        }
      }
      if (!entities.current.has(d.droneId)) entities.current.set(d.droneId, createDroneEntities(viewer, d.droneId, d.name));
      // Flown trajectory (appended at telemetry rate while airborne).
      const p = positionOf(d.droneId, true);
      if (p && t.inAir) {
        const trail = tr.trail;
        const prev = trail[trail.length - 1];
        if (!prev || Cesium.Cartesian3.distance(prev, p) > 1) trail.push(p);
        if (trail.length > TRAIL_POINTS) trail.splice(0, trail.length - TRAIL_POINTS);
      }
    }
    for (const [id, list] of entities.current) {
      if (!seen.has(id)) {
        for (const e of list) viewer.entities.remove(e);
        entities.current.delete(id);
        tracks.current.delete(id);
      }
    }
    // Opening shot: from the globe down to the fleet.
    if (!flown.current) {
      const pts = props.drones.filter((d) => d.telemetry).map((d) => ({ lat: d.telemetry!.lat, lon: d.telemetry!.lon }));
      const c = centroidOf(pts);
      if (c) {
        flown.current = true;
        const base = tracks.current.values().next().value?.altMslRef ?? 0;
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(c.lon, c.lat - 0.006, 450 + base),
          orientation: { heading: 0, pitch: Cesium.Math.toRadians(-35), roll: 0 },
          duration: 3.5,
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [telemetryKey, terrain]);

  // Other aircraft reported by the drones (ADS-B), with altitude lines like a UTM view.
  useEffect(() => {
    const ds = trafficDs.current;
    if (!ds || !terrain) return;
    const traffic: DetectedAircraft[] = propsRef.current.drones.flatMap((d) => d.traffic);
    ds.entities.removeAll();
    for (const a of traffic) {
      ds.entities.add({
        position: Cesium.Cartesian3.fromDegrees(a.lon, a.lat, a.altMsl),
        point: { pixelSize: 10, color: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 1 },
        label: { text: `✈ ${a.callsign ?? a.icao} ${Math.round(a.altMsl)} m`, font: '12px sans-serif', fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -16), disableDepthTestDistance: Number.POSITIVE_INFINITY },
        polyline: { positions: [Cesium.Cartesian3.fromDegrees(a.lon, a.lat, 0), Cesium.Cartesian3.fromDegrees(a.lon, a.lat, a.altMsl)], width: 2, material: Cesium.Color.fromCssColorString('#22c55e'), arcType: Cesium.ArcType.NONE },
      });
    }
  }, [trafficKey, terrain]);

  // Objects found by AI vision: points on the ground with their track number.
  const objectsKey = props.drones
    .map((d) => (d.ai?.enabled ? d.detections.map((o) => `${o.trackId}:${o.lat?.toFixed(5)}:${o.lon?.toFixed(5)}:${o.trackId === d.ai?.following ? 1 : 0}`).join(',') : ''))
    .join('|');
  useEffect(() => {
    const ds = objectsDs.current;
    if (!viewerRef.current || !ds || !terrain) return;
    ds.entities.removeAll();
    for (const d of propsRef.current.drones) {
      if (!d.ai?.enabled) continue;
      const tr = tracks.current.get(d.droneId);
      const base = tr ? (tr.ref ? tr.ref.height : tr.altMslRef) : 0;
      for (const o of d.detections) {
        if (o.lat === null || o.lon === null) continue;
        const followed = o.trackId === d.ai.following;
        const color = followed ? Cesium.Color.RED : o.cls === 'person' ? Cesium.Color.fromCssColorString('#22d3ee') : Cesium.Color.fromCssColorString('#e879f9');
        ds.entities.add({
          position: Cesium.Cartesian3.fromDegrees(o.lon, o.lat, base + 1),
          point: { pixelSize: followed ? 12 : 9, color, outlineColor: Cesium.Color.BLACK, outlineWidth: 1.5, disableDepthTestDistance: Number.POSITIVE_INFINITY },
          label: { text: `#${o.trackId} ${o.cls}`, font: '600 11px sans-serif', fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -14), disableDepthTestDistance: Number.POSITIVE_INFINITY },
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectsKey, terrain]);

  /**
   * Places the drone tags so that none overlaps another: the tag of the drone lowest on the
   * screen stays just above it, every other tag moves up past the tags it would cover. Route
   * waypoint numbers under a tag are hidden.
   */
  function declutterTags(viewer: Cesium.Viewer): void {
    const now = viewer.clock.currentTime;
    const items: { id: string; x: number; y: number; w: number }[] = [];
    for (const id of tracks.current.keys()) {
      const e = viewer.entities.getById(`drone:${id}`);
      const pos = e?.position?.getValue(now);
      const c = pos ? viewer.scene.cartesianToCanvasCoordinates(pos) : undefined;
      if (!e || !c) continue;
      const text = String(e.label?.text?.getValue(now) ?? '');
      items.push({ id, x: c.x, y: c.y, w: textWidth(text, TAG_FONT) + 12 });
    }
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const placed: Rect[] = [];
    const offsets = new Map<string, Cesium.Cartesian2>();
    for (const it of items) {
      let cy = it.y - TAG_ABOVE;
      const rect = (): Rect => ({ l: it.x - it.w / 2 - TAG_GAP / 2, r: it.x + it.w / 2 + TAG_GAP / 2, t: cy - TAG_H / 2 - TAG_GAP / 2, b: cy + TAG_H / 2 + TAG_GAP / 2 });
      for (let guard = 0; guard < 24; guard++) {
        const r = rect();
        const hit = placed.find((p) => overlaps(p, r));
        if (!hit) break;
        cy = hit.t - TAG_GAP / 2 - TAG_H / 2;
      }
      placed.push(rect());
      offsets.set(it.id, new Cesium.Cartesian2(0, cy - it.y));
    }
    tagOffsets.current = offsets;
    // Drone tags win over route waypoint numbers drawn under them.
    const hide = new Set<string>();
    for (const e of routeDs.current?.entities.values ?? []) {
      if (!e.label) continue;
      const pos = e.position?.getValue(now);
      const c = pos ? viewer.scene.cartesianToCanvasCoordinates(pos) : undefined;
      if (!c) continue;
      const w = textWidth(String(e.label.text?.getValue(now) ?? ''), ROUTE_LABEL_FONT) + 8;
      const r: Rect = { l: c.x - w / 2, r: c.x + w / 2, t: c.y - 16 - 9, b: c.y - 16 + 9 };
      if (placed.some((p) => overlaps(p, r))) hide.add(e.id);
    }
    hiddenRouteLabels.current = hide;
  }

  /** Model, tag, altitude line, flown trajectory and camera frustum of one drone. */
  function createDroneEntities(viewer: Cesium.Viewer, id: string, name: string): Cesium.Entity[] {
    const out: Cesium.Entity[] = [];
    out.push(
      viewer.entities.add({
        id: `drone:${id}`,
        name,
        position: new Cesium.CallbackPositionProperty(() => positionOf(id), false),
        orientation: new Cesium.CallbackProperty(() => {
          const s = smoothed(id);
          const p = positionOf(id);
          return s && p ? droneOrientation(p, s.heading, s.pitch, s.roll) : Cesium.Quaternion.IDENTITY;
        }, false) as unknown as Cesium.Property,
        model: {
          uri: droneModelUri(propsRef.current.models[id]),
          minimumPixelSize: 56,
          maximumScale: 300,
          silhouetteColor: Cesium.Color.RED,
          silhouetteSize: 0,
          // Propellers spin (model animation) while the drone is armed.
          runAnimations: new Cesium.CallbackProperty(() => tracks.current.get(id)?.armed ?? false, false),
        },
        label: {
          text: new Cesium.CallbackProperty(() => {
            const s = smoothed(id);
            return s ? `${name} · ${Math.round(s.altRel)} m` : name;
          }, false),
          fillColor: Cesium.Color.BLACK,
          showBackground: true,
          backgroundColor: ORANGE,
          backgroundPadding: new Cesium.Cartesian2(6, 4),
          font: TAG_FONT,
          pixelOffset: new Cesium.CallbackProperty(() => tagOffsets.current.get(id) ?? DEFAULT_TAG_OFFSET, false),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }),
    );
    // Altitude line (yellow) from the reference height to the drone.
    out.push(
      viewer.entities.add({
        id: `stem:${id}`,
        polyline: {
          positions: new Cesium.CallbackProperty(() => {
            const s = smoothed(id);
            const tr = tracks.current.get(id);
            if (!s || !tr || s.altRel < 0.5) return [];
            const base = tr.ref ? tr.ref.height : tr.altMslRef;
            return [Cesium.Cartesian3.fromDegrees(s.lon, s.lat, base), Cesium.Cartesian3.fromDegrees(s.lon, s.lat, base + s.altRel)];
          }, false),
          width: 2,
          material: YELLOW,
          arcType: Cesium.ArcType.NONE,
        },
      }),
    );
    // Flown trajectory (thick yellow).
    out.push(
      viewer.entities.add({
        id: `trail:${id}`,
        polyline: {
          positions: new Cesium.CallbackProperty(() => (layersRef.current.trails ? (tracks.current.get(id)?.trail ?? []) : []), false),
          width: 4,
          material: YELLOW.withAlpha(0.9),
          arcType: Cesium.ArcType.NONE,
        },
      }),
    );
    // Camera view frustum: four translucent faces down to the ground.
    for (let k = 0; k < 4; k++) {
      out.push(
        viewer.entities.add({
          id: `frustum:${id}:${k}`,
          polygon: {
            hierarchy: new Cesium.CallbackProperty(() => {
              const f = frustumOf(id);
              return f ? new Cesium.PolygonHierarchy([f.apex, f.corners[k]!, f.corners[(k + 1) % 4]!]) : new Cesium.PolygonHierarchy([]);
            }, false),
            perPositionHeight: true,
            material: FRUSTUM.withAlpha(0.16),
            outline: false,
          },
        }),
      );
    }
    out.push(
      viewer.entities.add({
        id: `footprint:${id}`,
        polyline: {
          positions: new Cesium.CallbackProperty(() => {
            const f = frustumOf(id);
            return f ? [...f.corners, f.corners[0]!] : [];
          }, false),
          width: 1.5,
          material: FRUSTUM.withAlpha(0.8),
          arcType: Cesium.ArcType.NONE,
        },
      }),
    );
    return out;
  }

  /** Camera frustum apex and ground corners (gimbal pitched below the horizon). */
  function frustumOf(id: string): { apex: Cesium.Cartesian3; corners: Cesium.Cartesian3[] } | null {
    // Drawn for the selected drone only (dynamic polygons are costly on weak GPUs).
    if (!layersRef.current.frustum || propsRef.current.selectedId !== id) return null;
    const s = smoothed(id);
    const tr = tracks.current.get(id);
    if (!s || !tr || s.altRel < 3) return null;
    const cam = airframeById(propsRef.current.airframes?.[id] ?? null)?.camera ?? { sensorWidthMm: 13.2, sensorHeightMm: 8.8, focalLengthMm: 8.8 };
    const hfov = 2 * Math.atan(cam.sensorWidthMm / (2 * cam.focalLengthMm)) * (180 / Math.PI);
    const vfov = 2 * Math.atan(cam.sensorHeightMm / (2 * cam.focalLengthMm)) * (180 / Math.PI);
    const base = tr.ref ? tr.ref.height : tr.altMslRef;
    const corners: Cesium.Cartesian3[] = [];
    for (const [da, db] of [[-1, 1], [1, 1], [1, -1], [-1, -1]] as const) {
      const pitch = Math.min(-5, GIMBAL_PITCH + (db * vfov) / 2);
      const dist = Math.min(1500, s.altRel / Math.tan((-pitch * Math.PI) / 180));
      const g = destinationPoint(s, s.heading + (da * hfov) / 2, dist);
      corners.push(Cesium.Cartesian3.fromDegrees(g.lon, g.lat, base));
    }
    return { apex: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, base + s.altRel), corners };
  }

  // Model per airframe (may arrive after the entity was created).
  useEffect(() => {
    for (const [id, list] of entities.current) {
      const e = list[0];
      if (e?.model) e.model.uri = new Cesium.ConstantProperty(droneModelUri(props.models[id]));
    }
  }, [props.models]);

  // Selection (red outline) and camera follow.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    for (const [id, list] of entities.current) {
      const e = list[0];
      if (e?.model) e.model.silhouetteSize = new Cesium.ConstantProperty(id === props.selectedId ? 2 : 0);
    }
    const target = props.selectedId ? entities.current.get(props.selectedId)?.[0] : undefined;
    viewer.trackedEntity = props.follow && target ? target : undefined;
  }, [props.selectedId, props.follow, props.drones.length]);

  // Routes of running missions: white lines, numbered waypoints, loiter circles.
  useEffect(() => {
    const viewer = viewerRef.current;
    const ds = routeDs.current;
    if (!viewer || !ds || !terrain) return;
    ds.entities.removeAll();
    if (!layersRef.current.routes) return;
    for (const d of propsRef.current.drones) {
      const m = d.mission ? props.missions?.[d.mission.missionId] : undefined;
      const tr = tracks.current.get(d.droneId);
      if (!m || !tr) continue;
      const base = tr.ref ? tr.ref.height : tr.altMslRef;
      const path = missionPath(m);
      if (path.length > 1) {
        ds.entities.add({ polyline: { positions: path.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, base + p.alt)), width: 2, material: Cesium.Color.WHITE.withAlpha(0.9), arcType: Cesium.ArcType.NONE } });
      }
      let n = 0;
      m.items.forEach((it, idx) => {
        if (it.lat === undefined || it.lon === undefined) return;
        n++;
        const current = d.mission && idx === d.mission.seq;
        const alt = it.alt ?? m.defaultAlt;
        const routeLabelId = `route:${d.droneId}:${idx}`;
        ds.entities.add({
          id: routeLabelId,
          position: Cesium.Cartesian3.fromDegrees(it.lon, it.lat, base + alt),
          point: { pixelSize: current ? 14 : 10, color: current ? YELLOW : Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 1.5, disableDepthTestDistance: Number.POSITIVE_INFINITY },
          label: {
            text: String(n),
            font: '600 11px sans-serif',
            fillColor: Cesium.Color.BLACK,
            showBackground: true,
            backgroundColor: Cesium.Color.WHITE.withAlpha(0.85),
            backgroundPadding: new Cesium.Cartesian2(4, 2),
            pixelOffset: new Cesium.Cartesian2(0, -16),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            show: new Cesium.CallbackProperty(() => !hiddenRouteLabels.current.has(routeLabelId), false),
          },
        });
        if (it.type === 'loiter') {
          const r = it.radiusM ?? 25;
          ds.entities.add({ position: Cesium.Cartesian3.fromDegrees(it.lon, it.lat, base + alt), ellipse: { semiMajorAxis: r, semiMinorAxis: r, height: base + alt, fill: false, outline: true, outlineColor: Cesium.Color.WHITE, outlineWidth: 2 } });
        }
      });
    }
    // Preview routes (dashed, coloured per drone), at each drone's vertical reference.
    for (const r of propsRef.current.previewRoutes ?? []) {
      const tr = tracks.current.get(r.droneId);
      const base = tr ? (tr.ref ? tr.ref.height : tr.altMslRef) : 0;
      const path = missionPath(r.plan);
      const color = Cesium.Color.fromCssColorString(r.color);
      if (path.length > 1) {
        ds.entities.add({ polyline: { positions: path.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, base + p.alt)), width: 3, material: new Cesium.PolylineDashMaterialProperty({ color, dashLength: 14 }), arcType: Cesium.ArcType.NONE } });
      }
      for (const it of r.plan.items) {
        if (it.lat === undefined || it.lon === undefined) continue;
        ds.entities.add({ position: Cesium.Cartesian3.fromDegrees(it.lon, it.lat, base + (it.alt ?? r.plan.defaultAlt)), point: { pixelSize: 8, color, outlineColor: Cesium.Color.BLACK, outlineWidth: 1, disableDepthTestDistance: Number.POSITIVE_INFINITY } });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, props.missions, terrain, props.layers?.routes, props.previewRoutes]);

  // Airspace volumes (heights from the rendered terrain at each zone).
  useEffect(() => {
    const viewer = viewerRef.current;
    const ds = zoneDs.current;
    if (!viewer || !ds || !terrain) return;
    let stale = false;
    ds.show = props.layers?.zones ?? true;
    const centers = props.zones.map((z) => (z.geometry.kind === 'circle' ? z.geometry.center : centroidOf(z.geometry.kind === 'polygon' ? z.geometry.polygon : z.geometry.line)!));
    void terrainHeights(viewer, centers).then((hs) => {
      if (stale) return;
      ds.entities.removeAll();
      props.zones.forEach((z, i) => {
        const color = Cesium.Color.fromCssColorString(ZONE_COLORS[z.type]);
        const base = hs[i] ?? 0;
        const common = { height: base + z.floorM, extrudedHeight: base + Math.min(z.ceilingM, 1500), material: color.withAlpha(0.15), outline: true, outlineColor: color };
        if (z.geometry.kind === 'polygon') ds.entities.add({ name: z.name, polygon: { hierarchy: Cesium.Cartesian3.fromDegreesArray(z.geometry.polygon.flatMap((p) => [p.lon, p.lat])), ...common } });
        else if (z.geometry.kind === 'circle') ds.entities.add({ name: z.name, position: Cesium.Cartesian3.fromDegrees(z.geometry.center.lon, z.geometry.center.lat), ellipse: { semiMajorAxis: z.geometry.radiusM, semiMinorAxis: z.geometry.radiusM, ...common } });
        else ds.entities.add({ name: z.name, corridor: { positions: Cesium.Cartesian3.fromDegreesArray(z.geometry.line.flatMap((p) => [p.lon, p.lat])), width: z.geometry.bufferM * 2, ...common } });
      });
    });
    return () => {
      stale = true;
    };
  }, [props.zones, terrain, props.layers?.zones]);

  /** Smoothed state: rendered slightly in the past, interpolated between telemetry samples. */
  function smoothed(id: string): Sample | null {
    const tr = tracks.current.get(id);
    if (!tr || tr.samples.length === 0) return null;
    const s = tr.samples;
    const t = performance.now() - RENDER_DELAY_MS;
    if (s.length === 1 || t >= s[s.length - 1]!.at) return s[s.length - 1]!;
    if (t <= s[0]!.at) return s[0]!;
    for (let i = s.length - 1; i > 0; i--) {
      const a = s[i - 1]!;
      const b = s[i]!;
      if (t >= a.at && t <= b.at) {
        const f = b.at > a.at ? (t - a.at) / (b.at - a.at) : 1;
        return {
          at: t,
          lat: a.lat + (b.lat - a.lat) * f,
          lon: a.lon + (b.lon - a.lon) * f,
          altRel: a.altRel + (b.altRel - a.altRel) * f,
          heading: lerpAngle(a.heading, b.heading, f),
          pitch: a.pitch + (b.pitch - a.pitch) * f,
          roll: a.roll + (b.roll - a.roll) * f,
        };
      }
    }
    return s[s.length - 1]!;
  }

  function positionOf(id: string, latest = false): Cesium.Cartesian3 | undefined {
    const tr = tracks.current.get(id);
    const s = latest ? tr?.samples[tr.samples.length - 1] : smoothed(id);
    if (!tr || !s) return undefined;
    const base = tr.ref ? tr.ref.height : tr.altMslRef;
    return Cesium.Cartesian3.fromDegrees(s.lon, s.lat, base + s.altRel);
  }

  return (
    <div className={`live3d${props.onPick ? ' picking' : ''}`}>
      <div ref={host} className="cesium-host" data-testid="live-3d" />
      <div className="map-overlay map-overlay-bottom small">
        <button className="btn small" onClick={() => setImageryKind(imagery === 'map' ? 'satellite' : 'map')}>
          {imagery === 'map' ? 'Satellite' : 'Map'}
        </button>
        <span className="muted">terrain: {terrain ? TERRAIN_LABEL[terrain] : '…'}</span>
      </div>
    </div>
  );
}
