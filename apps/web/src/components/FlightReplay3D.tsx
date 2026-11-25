/**
 * Historical 3D trajectory review: replays a recorded flight with the drone model oriented
 * from the logged attitude, a timeline / animation clock, the full 3D track and the planned
 * route. Loaded on demand.
 */
import { Pause, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import type { FlightSampleDto, LatLonAlt } from '@athena-sky/shared';
import { TERRAIN_LABEL, createViewer, droneModelUri, droneOrientation, setImagery, terrainHeights, type ClientConfig, type DroneModel, type ImageryKind, type TerrainKind } from '../lib/cesium';
import { ImageryNotice, useImageryStatus } from './ImageryNotice';

export interface FlightReplay3DProps {
  samples: FlightSampleDto[];
  /** Planned mission path (altitudes relative to home). */
  planned?: LatLonAlt[] | null;
  model?: DroneModel;
  /** Highlighted time (e.g. a selected event). */
  focusT?: number | null;
}

const SPEEDS = [1, 5, 10, 30, 60];

export default function FlightReplay3D({ samples, planned, model, focusT }: FlightReplay3DProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const droneRef = useRef<Cesium.Entity | null>(null);
  const [terrain, setTerrain] = useState<TerrainKind | null>(null);
  const [terrainNote, setTerrainNote] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [speed, setSpeed] = useState(10);
  const [playing, setPlaying] = useState(false);
  const [imagery, setImageryKind] = useState<ImageryKind>('map');
  const imageryStatus = useImageryStatus();
  const configRef = useRef<ClientConfig | null>(null);

  useEffect(() => {
    let destroyed = false;
    const pts = samples.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
    void (async () => {
      if (!host.current || pts.length < 2) return;
      const { viewer, terrain: kind, terrainNote: note, config } = await createViewer(host.current, { timeline: true, animation: true, onImageryStatus: imageryStatus.track() });
      if (destroyed) {
        viewer.destroy();
        return;
      }
      viewerRef.current = viewer;
      configRef.current = config;
      setTerrain(kind);
      setTerrainNote(note);
      // Vertical reference: rendered terrain at the take-off point (+ relative altitude).
      const [h0] = await terrainHeights(viewer, [pts[0]!]);
      if (destroyed) return;
      const base = kind === 'flat' ? 0 : (h0 ?? pts[0]!.altMsl - pts[0]!.altRel);
      const position = new Cesium.SampledPositionProperty();
      position.setInterpolationOptions({ interpolationDegree: 1, interpolationAlgorithm: Cesium.LinearApproximation });
      const orientation = new Cesium.SampledProperty(Cesium.Quaternion);
      const track: Cesium.Cartesian3[] = [];
      for (const s of pts) {
        const time = Cesium.JulianDate.fromDate(new Date(s.t));
        const p = Cesium.Cartesian3.fromDegrees(s.lon, s.lat, base + s.altRel);
        position.addSample(time, p);
        orientation.addSample(time, droneOrientation(p, s.heading, s.pitch, s.roll));
        track.push(p);
      }
      const start = Cesium.JulianDate.fromDate(new Date(pts[0]!.t));
      const stop = Cesium.JulianDate.fromDate(new Date(pts[pts.length - 1]!.t));
      viewer.clock.startTime = start.clone();
      viewer.clock.stopTime = stop.clone();
      viewer.clock.currentTime = start.clone();
      viewer.clock.clockRange = Cesium.ClockRange.CLAMPED;
      viewer.clock.multiplier = 10;
      viewer.clock.shouldAnimate = false;
      viewer.timeline?.zoomTo(start, stop);
      viewer.entities.add({ polyline: { positions: track, width: 2, material: Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.6), arcType: Cesium.ArcType.NONE } });
      viewer.entities.add({ polyline: { positions: track.map((p) => Cesium.Cartographic.fromCartesian(p)).map((c) => Cesium.Cartesian3.fromRadians(c.longitude, c.latitude)), width: 1, material: Cesium.Color.WHITE.withAlpha(0.35), clampToGround: true } });
      if (planned && planned.length > 1) {
        viewer.entities.add({
          polyline: {
            positions: planned.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, base + p.alt)),
            width: 2,
            material: new Cesium.PolylineDashMaterialProperty({ color: Cesium.Color.fromCssColorString('#facc15'), dashLength: 12 }),
            arcType: Cesium.ArcType.NONE,
          },
        });
      }
      const drone = viewer.entities.add({
        id: 'replay-drone',
        // Chase camera: behind (south of) and above the drone when tracking starts.
        viewFrom: new Cesium.Cartesian3(-60, -260, 160),
        availability: new Cesium.TimeIntervalCollection([new Cesium.TimeInterval({ start, stop })]),
        position,
        orientation: orientation as unknown as Cesium.Property,
        model: { uri: droneModelUri(model), minimumPixelSize: 64, maximumScale: 300, runAnimations: true },
        path: { leadTime: 0, trailTime: 120, width: 3, material: Cesium.Color.fromCssColorString('#22d3ee') },
        label: {
          text: new Cesium.CallbackProperty((time) => {
            const ms = Cesium.JulianDate.toDate(time ?? viewer.clock.currentTime).getTime();
            let lo = 0;
            let hi = pts.length - 1;
            while (lo < hi) {
              const mid = (lo + hi) >> 1;
              if (pts[mid]!.t < ms) lo = mid + 1;
              else hi = mid;
            }
            const s = pts[lo]!;
            return `${Math.round(s.altRel)} m · ${s.groundSpeed.toFixed(1)} m/s · ${Math.round(s.batteryPct)} %`;
          }, false),
          font: '13px sans-serif',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -40),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      droneRef.current = drone;
      viewer.trackedEntity = drone;
      (window as unknown as { __athenaReplay?: unknown }).__athenaReplay = { viewer, drone };
    })();
    return () => {
      destroyed = true;
      viewerRef.current?.destroy();
      viewerRef.current = null;
      droneRef.current = null;
      delete (window as unknown as { __athenaReplay?: unknown }).__athenaReplay;
    };
  }, [samples, planned, model]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.trackedEntity = follow && droneRef.current ? droneRef.current : undefined;
  }, [follow, terrain]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.clock.multiplier = speed;
    viewer.clock.shouldAnimate = playing;
  }, [speed, playing, terrain]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer && configRef.current) void setImagery(viewer, imagery, configRef.current, imageryStatus.track());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imagery]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || focusT === null || focusT === undefined) return;
    viewer.clock.currentTime = Cesium.JulianDate.fromDate(new Date(focusT));
  }, [focusT, terrain]);

  if (samples.length < 2) return <div className="small muted">Not enough samples for a 3D replay.</div>;
  return (
    <div className="replay3d">
      <div className="row" style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <button className="btn small primary" onClick={() => setPlaying((p) => !p)} data-testid="replay-play">
          {playing ? (
            <>
              <Pause /> Pause
            </>
          ) : (
            <>
              <Play /> Play
            </>
          )}
        </button>
        <label className="row small">
          Speed
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Replay speed">
            {SPEEDS.map((v) => (
              <option key={v} value={v}>
                {v}×
              </option>
            ))}
          </select>
        </label>
        <label className="row small">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow drone
        </label>
        <button className="btn small" onClick={() => setImageryKind(imagery === 'map' ? 'satellite' : 'map')}>
          {imagery === 'map' ? 'Satellite' : 'Map'}
        </button>
        <span className="small muted">
          terrain: {terrain ? TERRAIN_LABEL[terrain] : '…'}
          {terrainNote ? ` (${terrainNote})` : ''} {planned && planned.length > 1 ? '· planned route dashed' : ''}
        </span>
        <ImageryNotice status={imageryStatus.status} />
      </div>
      <div ref={host} className="cesium-host replay-host" data-testid="replay-3d" />
    </div>
  );
}
