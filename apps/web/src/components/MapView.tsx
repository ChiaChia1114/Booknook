/**
 * Declarative Leaflet wrapper. Layers are re-rendered when their data changes;
 * the view is fitted to `fit` bounds once (or when `fitKey` changes).
 */
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { ESRI_IMAGERY_URL, SERVER_IMAGERY_URL, clientConfig } from '../lib/client-config';
import { useAuth } from '../state/auth';

/**
 * Leaflet's canvas renderer (the heatmap) asks for a redraw in the next frame when shapes are added;
 * redrawing at once (fitting the view) forgets that request without cancelling it. A map removed
 * within that frame – the page left right after its data came in – then had the forgotten redraw
 * run on its removed canvas ("Cannot read properties of undefined (reading 'clearRect')"): a
 * renderer without its canvas no longer draws.
 */
type CanvasInternals = { _ctx?: CanvasRenderingContext2D; _redrawRequest: number | null; _redraw(): void };
const canvasProto = L.Canvas.prototype as unknown as CanvasInternals;
const leafletRedraw = canvasProto._redraw;
canvasProto._redraw = function (this: CanvasInternals) {
  if (!this._ctx) {
    this._redrawRequest = null;
    return;
  }
  leafletRedraw.call(this);
};

export interface MapMarker {
  id: string;
  lat: number;
  lon: number;
  color?: string;
  radius?: number;
  label?: string;
  /** Heading in degrees – renders a drone arrow instead of a dot. */
  heading?: number;
  popup?: string;
  onClick?(): void;
}
export interface MapLine {
  id: string;
  points: [number, number][];
  color?: string;
  weight?: number;
  dashed?: boolean;
  label?: string;
}
export interface MapPolygon {
  id: string;
  points: [number, number][];
  color?: string;
  fillOpacity?: number;
  label?: string;
  dashed?: boolean;
}
export interface MapCircle {
  id: string;
  lat: number;
  lon: number;
  radiusM: number;
  color?: string;
  fillOpacity?: number;
  label?: string;
}

/** A grid cell of a density heatmap. */
export interface HeatCell {
  lat: number;
  lon: number;
  count: number;
}

/** Colour of a heat value (0..1): deep blue → blue → cyan → yellow → red. */
export function heatColor(f: number): string {
  const stops: [number, [number, number, number]][] = [
    [0, [30, 58, 138]],
    [0.25, [37, 99, 235]],
    [0.5, [34, 211, 238]],
    [0.75, [250, 204, 21]],
    [1, [239, 68, 68]],
  ];
  const x = Math.min(1, Math.max(0, f));
  for (let i = 1; i < stops.length; i++) {
    const [f1, c1] = stops[i]!;
    const [f0, c0] = stops[i - 1]!;
    if (x <= f1) {
      const t = (x - f0) / (f1 - f0);
      const c = c0.map((v, k) => Math.round(v + (c1[k]! - v) * t));
      return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
    }
  }
  return 'rgb(239, 68, 68)';
}

export interface MapViewProps {
  markers?: MapMarker[];
  lines?: MapLine[];
  polygons?: MapPolygon[];
  circles?: MapCircle[];
  fit?: [number, number][];
  fitKey?: string;
  /** Space (px) kept free on each side when fitting – e.g. under overlays on the map. Measured when fitting. */
  fitPadding?: () => { top: number; right: number; bottom: number; left: number };
  center?: [number, number];
  zoom?: number;
  className?: string;
  onClick?(lat: number, lon: number): void;
  onMove?(center: { lat: number; lon: number }, zoom: number): void;
  cursor?: string;
  testId?: string;
  /** Density heatmap cells (cell size in degrees); colour on a log scale of the count. */
  heat?: { cells: HeatCell[]; cellDeg: number; max: number } | null;
}

const BASE_LAYERS = {
  Map: () =>
    L.tileLayer(import.meta.env.VITE_TILE_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
      // Rendered dark in the dark theme (see .osm-tiles in styles.css).
      className: 'osm-tiles',
    }),
  Satellite: () => L.tileLayer(ESRI_IMAGERY_URL, { maxZoom: 19, attribution: 'Tiles &copy; Esri' }),
};

/**
 * Tooltip / popup content as a text node: labels contain user-provided names
 * (organisations, zones, drones), so they must never be interpreted as HTML.
 */
function textContent(text: string): HTMLElement {
  const el = document.createElement('span');
  el.textContent = text;
  return el;
}

const SAFE_COLOR = /^#[0-9a-f]{3,8}$/i;

function droneIcon(color: string, heading: number): L.DivIcon {
  const c = SAFE_COLOR.test(color) ? color : '#38bdf8';
  const h = Number.isFinite(heading) ? heading : 0;
  return L.divIcon({
    className: 'drone-icon',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    html: `<svg viewBox="0 0 28 28" width="28" height="28" style="transform: rotate(${h}deg)"><path d="M14 2 L24 24 L14 18 L4 24 Z" fill="${c}" stroke="#0b1220" stroke-width="1.5"/></svg>`,
  });
}

export function MapView(props: MapViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const satellite = useRef<L.TileLayer | null>(null);
  const { me } = useAuth();
  // Signed in, the satellite imagery comes through this server's tile cache when it has one: only
  // this server then needs to reach the imagery service (public pages fetch it themselves).
  useEffect(() => {
    if (!me) return;
    void clientConfig().then((c) => {
      if (c.imagery) satellite.current?.setUrl(SERVER_IMAGERY_URL);
    });
  }, [me]);
  const layer = useRef<L.LayerGroup | null>(null);
  const fitted = useRef<string | null>(null);
  const onClick = useRef(props.onClick);
  onClick.current = props.onClick;
  const onMove = useRef(props.onMove);
  onMove.current = props.onMove;

  useEffect(() => {
    if (!host.current) return;
    // Zoom/fade animations are disabled: removing a map while an animation is pending makes
    // Leaflet throw (`_leaflet_pos` of undefined) when the user navigates away quickly.
    const m = L.map(host.current, { zoomControl: true, attributionControl: true, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false, preferCanvas: !!props.heat }).setView(
      props.center ?? [25.0732, 121.5355],
      props.zoom ?? 13,
      { animate: false },
    );
    const base = BASE_LAYERS.Map();
    base.addTo(m);
    satellite.current = BASE_LAYERS.Satellite();
    if (me) void clientConfig().then((c) => c.imagery && satellite.current?.setUrl(SERVER_IMAGERY_URL));
    L.control.layers({ Map: base, Satellite: satellite.current }, undefined, { position: 'topright' }).addTo(m);
    L.control.scale({ imperial: false }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => onClick.current?.(e.latlng.lat, e.latlng.lng));
    m.on('moveend', () => {
      const c = m.getCenter();
      onMove.current?.({ lat: c.lat, lon: c.lng }, m.getZoom());
    });
    map.current = m;
    const ro = new ResizeObserver(() => {
      if (map.current === m) m.invalidateSize({ animate: false });
    });
    ro.observe(host.current);
    return () => {
      ro.disconnect();
      m.off();
      m.stop();
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const g = layer.current;
    if (!g) return;
    g.clearLayers();
    if (props.heat && props.heat.cells.length) {
      const { cells, cellDeg, max } = props.heat;
      const lmax = Math.log1p(max);
      for (const c of cells) {
        const f = lmax > 0 ? Math.log1p(c.count) / lmax : 0;
        L.rectangle(
          [
            [c.lat - cellDeg / 2, c.lon - cellDeg / 2],
            [c.lat + cellDeg / 2, c.lon + cellDeg / 2],
          ],
          { stroke: false, fillColor: heatColor(f), fillOpacity: 0.25 + 0.55 * f, interactive: false },
        ).addTo(g);
      }
    }
    for (const p of props.polygons ?? []) {
      if (p.points.length < 3) continue;
      const poly = L.polygon(p.points, { color: p.color ?? '#f59e0b', weight: 2, fillOpacity: p.fillOpacity ?? 0.15, dashArray: p.dashed ? '6 6' : undefined });
      if (p.label) poly.bindTooltip(textContent(p.label));
      poly.addTo(g);
    }
    for (const c of props.circles ?? []) {
      const circle = L.circle([c.lat, c.lon], { radius: c.radiusM, color: c.color ?? '#f59e0b', weight: 2, fillOpacity: c.fillOpacity ?? 0.15 });
      if (c.label) circle.bindTooltip(textContent(c.label));
      circle.addTo(g);
    }
    for (const l of props.lines ?? []) {
      if (l.points.length < 2) continue;
      const line = L.polyline(l.points, {
        color: l.color ?? '#38bdf8',
        weight: l.weight ?? 3,
        dashArray: l.dashed ? '6 6' : undefined,
        // e.g. "map-line map-line-route-<droneId>": lets a line be found in the page.
        className: `map-line map-line-${l.id.replace(/[^A-Za-z0-9_-]/g, '-')}`,
      });
      if (l.label) line.bindTooltip(textContent(l.label));
      line.addTo(g);
    }
    for (const mk of props.markers ?? []) {
      const color = mk.color ?? '#38bdf8';
      const marker =
        mk.heading !== undefined
          ? L.marker([mk.lat, mk.lon], { icon: droneIcon(color, mk.heading) })
          : L.circleMarker([mk.lat, mk.lon], { radius: mk.radius ?? 6, color: '#0b1220', weight: 1.5, fillColor: color, fillOpacity: 0.95 });
      if (mk.label) marker.bindTooltip(textContent(mk.label), { direction: 'top', offset: [0, -8] });
      if (mk.popup) marker.bindPopup(textContent(mk.popup));
      if (mk.onClick) marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        mk.onClick!();
      });
      marker.addTo(g);
    }
  }, [props.markers, props.lines, props.polygons, props.circles, props.heat]);

  useEffect(() => {
    const m = map.current;
    if (!m || !props.fit || props.fit.length === 0) return;
    const key = props.fitKey ?? 'default';
    if (fitted.current === key) return;
    fitted.current = key;
    const pad = props.fitPadding?.() ?? { top: 30, right: 30, bottom: 30, left: 30 };
    // A single point is fitted as a small area around it, so that it too lands in the free part.
    const bounds = props.fit.length === 1 ? L.latLng(props.fit[0]!).toBounds(400) : L.latLngBounds(props.fit);
    m.fitBounds(bounds, { paddingTopLeft: [pad.left, pad.top], paddingBottomRight: [pad.right, pad.bottom], maxZoom: props.fit.length === 1 ? 15 : 17, animate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fit, props.fitKey]);

  return <div ref={host} className={`map ${props.className ?? ''}`} style={props.cursor ? { cursor: props.cursor } : undefined} data-testid={props.testId} />;
}
