/**
 * Real-time 3D view of the fleet (CesiumJS): drone models oriented by heading, pitch and
 * roll, smoothed between telemetry samples, 3D trails, altitude stems, other traffic and
 * airspace volumes. Loaded on demand (Cesium is large).
 */
import { useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import type { AirspaceZoneDto, DetectedAircraft, ZoneType } from '@athena-sky/shared';
import { centroidOf } from '@athena-sky/shared';
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
  trail: Cesium.Cartesian3[];
  /** Rendered terrain height at the drone's home (vertical reference), keyed by home. */
  ref: { key: string; height: number } | null;
  refPending: string | null;
  altMslRef: number;
}

const RENDER_DELAY_MS = 300;
const TRAIL_POINTS = 400;

export interface Live3DProps {
  drones: DroneView[];
  models: Record<string, DroneModel>;
  zones: AirspaceZoneDto[];
  selectedId: string | null;
  onSelect?(droneId: string): void;
}

function lerpAngle(a: number, b: number, f: number): number {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * f + 360) % 360;
}

export default function Live3D(props: Live3DProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const tracks = useRef(new Map<string, Track>());
  const entities = useRef(new Map<string, Cesium.Entity>());
  const trafficDs = useRef<Cesium.CustomDataSource | null>(null);
  const zoneDs = useRef<Cesium.CustomDataSource | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [terrain, setTerrain] = useState<TerrainKind | null>(null);
  const [follow, setFollow] = useState(false);
  const [imagery, setImageryKind] = useState<ImageryKind>('map');
  const configRef = useRef<ClientConfig | null>(null);
  const fitted = useRef(false);

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
      setTerrain(kind);
      trafficDs.current = new Cesium.CustomDataSource('traffic');
      zoneDs.current = new Cesium.CustomDataSource('zones');
      void viewer.dataSources.add(zoneDs.current);
      void viewer.dataSources.add(trafficDs.current);
      handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction((e: { position: Cesium.Cartesian2 }) => {
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
        tr = { samples: [], trail: [], ref: null, refPending: null, altMslRef: t.altMsl - t.altRel };
        tracks.current.set(d.droneId, tr);
      }
      const last = tr.samples[tr.samples.length - 1];
      if (!last || last.lat !== t.lat || last.lon !== t.lon || last.altRel !== t.altRel || last.heading !== t.heading) {
        tr.samples.push({ at: now, lat: t.lat, lon: t.lon, altRel: t.altRel, heading: t.heading, pitch: t.pitch, roll: t.roll });
        if (tr.samples.length > 6) tr.samples.shift();
      }
      tr.altMslRef = t.altMsl - t.altRel;
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
      if (!entities.current.has(d.droneId)) {
        const id = d.droneId;
        const position = new Cesium.CallbackPositionProperty(() => positionOf(id), false);
        const entity = viewer.entities.add({
          id: `drone:${id}`,
          name: d.name,
          position,
          orientation: new Cesium.CallbackProperty(() => {
            const s = smoothed(id);
            const p = positionOf(id);
            return s && p ? droneOrientation(p, s.heading, s.pitch, s.roll) : Cesium.Quaternion.IDENTITY;
          }, false) as unknown as Cesium.Property,
          model: { uri: droneModelUri(propsRef.current.models[id]), minimumPixelSize: 56, maximumScale: 300, silhouetteColor: Cesium.Color.fromCssColorString('#38bdf8'), silhouetteSize: 0 },
          label: {
            text: new Cesium.CallbackProperty(() => {
              const s = smoothed(id);
              return s ? `${d.name} · ${Math.round(s.altRel)} m` : d.name;
            }, false),
            font: '13px sans-serif',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -36),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          polyline: {
            positions: new Cesium.CallbackProperty(() => tracks.current.get(id)?.trail ?? [], false),
            width: 2.5,
            material: Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.85),
            arcType: Cesium.ArcType.NONE,
          },
        });
        // Altitude stem from the reference height to the drone.
        viewer.entities.add({
          id: `stem:${id}`,
          polyline: {
            positions: new Cesium.CallbackProperty(() => {
              const s = smoothed(id);
              const tr2 = tracks.current.get(id);
              if (!s || !tr2) return [];
              const base = tr2.ref ? tr2.ref.height : tr2.altMslRef;
              return [Cesium.Cartesian3.fromDegrees(s.lon, s.lat, base), Cesium.Cartesian3.fromDegrees(s.lon, s.lat, base + s.altRel)];
            }, false),
            width: 1,
            material: Cesium.Color.WHITE.withAlpha(0.5),
            arcType: Cesium.ArcType.NONE,
          },
        });
        entities.current.set(id, entity);
      }
      // Trail (appended at telemetry rate).
      const p = positionOf(d.droneId, true);
      if (p && t.inAir) {
        const trail = tr.trail;
        const prev = trail[trail.length - 1];
        if (!prev || Cesium.Cartesian3.distance(prev, p) > 1) trail.push(p);
        if (trail.length > TRAIL_POINTS) trail.splice(0, trail.length - TRAIL_POINTS);
      }
    }
    // Drones no longer shown.
    for (const [id, e] of entities.current) {
      if (!seen.has(id)) {
        viewer.entities.remove(e);
        viewer.entities.removeById(`stem:${id}`);
        entities.current.delete(id);
        tracks.current.delete(id);
      }
    }
    // Other aircraft reported by the drones (ADS-B).
    const traffic: DetectedAircraft[] = props.drones.flatMap((d) => d.traffic);
    const ds = trafficDs.current;
    if (ds) {
      ds.entities.removeAll();
      for (const a of traffic) {
        ds.entities.add({
          position: Cesium.Cartesian3.fromDegrees(a.lon, a.lat, a.altMsl),
          point: { pixelSize: 10, color: Cesium.Color.ORANGE, outlineColor: Cesium.Color.BLACK, outlineWidth: 1 },
          label: { text: `✈ ${a.callsign ?? a.icao}`, font: '12px sans-serif', fillColor: Cesium.Color.ORANGE, pixelOffset: new Cesium.Cartesian2(0, -16), disableDepthTestDistance: Number.POSITIVE_INFINITY },
        });
      }
    }
    // Initial camera: frame the drones.
    if (!fitted.current) {
      const pts = props.drones.filter((d) => d.telemetry).map((d) => ({ lat: d.telemetry!.lat, lon: d.telemetry!.lon }));
      const c = centroidOf(pts);
      if (c) {
        fitted.current = true;
        viewer.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(c.lon, c.lat - 0.01, 900 + (tracks.current.values().next().value?.altMslRef ?? 0)),
          orientation: { heading: 0, pitch: Cesium.Math.toRadians(-35), roll: 0 },
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.drones, terrain]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer && configRef.current) void setImagery(viewer, imagery, configRef.current);
  }, [imagery]);

  // Model per airframe (may arrive after the entity was created).
  useEffect(() => {
    for (const [id, e] of entities.current) {
      if (e.model) e.model.uri = new Cesium.ConstantProperty(droneModelUri(props.models[id]));
    }
  }, [props.models]);

  // Selection highlight and camera follow.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    for (const [id, e] of entities.current) {
      if (e.model) e.model.silhouetteSize = new Cesium.ConstantProperty(id === props.selectedId ? 2 : 0);
    }
    const target = props.selectedId ? entities.current.get(props.selectedId) : undefined;
    viewer.trackedEntity = follow && target ? target : undefined;
  }, [props.selectedId, follow, props.drones.length]);

  // Airspace volumes (heights from the rendered terrain at each zone).
  useEffect(() => {
    const viewer = viewerRef.current;
    const ds = zoneDs.current;
    if (!viewer || !ds || !terrain) return;
    let stale = false;
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
  }, [props.zones, terrain]);

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
    <div className="live3d">
      <div ref={host} className="cesium-host" data-testid="live-3d" />
      <div className="map-overlay small">
        <label className="row">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} disabled={!props.selectedId} /> Follow selected drone
        </label>
        <button className="btn small" onClick={() => setImageryKind(imagery === 'map' ? 'satellite' : 'map')}>
          {imagery === 'map' ? 'Satellite' : 'Map'}
        </button>
        <span className="muted">terrain: {terrain ? TERRAIN_LABEL[terrain] : '…'}</span>
      </div>
    </div>
  );
}
