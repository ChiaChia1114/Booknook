/**
 * Declarative Leaflet wrapper. Layers are re-rendered when their data changes;
 * the view is fitted to `fit` bounds once (or when `fitKey` changes).
 */
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

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

export interface MapViewProps {
  markers?: MapMarker[];
  lines?: MapLine[];
  polygons?: MapPolygon[];
  circles?: MapCircle[];
  fit?: [number, number][];
  fitKey?: string;
  center?: [number, number];
  zoom?: number;
  className?: string;
  onClick?(lat: number, lon: number): void;
  onMove?(center: { lat: number; lon: number }, zoom: number): void;
  cursor?: string;
  testId?: string;
}

const BASE_LAYERS = {
  Map: () =>
    L.tileLayer(import.meta.env.VITE_TILE_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }),
  Satellite: () =>
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Tiles &copy; Esri',
    }),
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
    const m = L.map(host.current, { zoomControl: true, attributionControl: true, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false }).setView(
      props.center ?? [25.0732, 121.5355],
      props.zoom ?? 13,
      { animate: false },
    );
    const base = BASE_LAYERS.Map();
    base.addTo(m);
    L.control.layers({ Map: base, Satellite: BASE_LAYERS.Satellite() }, undefined, { position: 'topright' }).addTo(m);
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
      const line = L.polyline(l.points, { color: l.color ?? '#38bdf8', weight: l.weight ?? 3, dashArray: l.dashed ? '6 6' : undefined });
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
  }, [props.markers, props.lines, props.polygons, props.circles]);

  useEffect(() => {
    const m = map.current;
    if (!m || !props.fit || props.fit.length === 0) return;
    const key = props.fitKey ?? 'default';
    if (fitted.current === key) return;
    fitted.current = key;
    if (props.fit.length === 1) m.setView(props.fit[0]!, 15, { animate: false });
    else m.fitBounds(L.latLngBounds(props.fit), { padding: [30, 30], maxZoom: 17, animate: false });
  }, [props.fit, props.fitKey]);

  return <div ref={host} className={`map ${props.className ?? ''}`} style={props.cursor ? { cursor: props.cursor } : undefined} data-testid={props.testId} />;
}
