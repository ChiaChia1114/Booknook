/**
 * GeoJSON → airspace zones. Used by the zone import endpoint and by external
 * GeoJSON airspace feeds (see providers.ts).
 *
 * Supported features: Polygon (its outer ring: holes are covered by the zone), MultiPolygon (one
 * zone per polygon), LineString (+ `bufferM`, metres either side; default 30) and Point
 * (+ `radiusM`). Properties: `name`, `type` (one of ZONE_TYPES), `floor`/`floorM`,
 * `ceiling`/`ceilingM` (metres), `activeFrom`/`activeTo` (ISO 8601), `notes`, optional feature `id`.
 */
import type { ZoneGeometry, ZoneType } from '@athena-sky/shared';
import { ZONE_TYPES } from '@athena-sky/shared';
import { badRequest } from '../lib/errors';
import { parseZoneGeometry } from './geometry';

export interface ParsedZoneFeature {
  featureId: string | null;
  name: string;
  type: ZoneType;
  geometry: ZoneGeometry;
  floorM: number;
  ceilingM: number;
  activeFrom: string | null;
  activeTo: string | null;
  notes: string;
}

export function zoneDefaults(type: ZoneType): { floor: number; ceiling: number } {
  return type.startsWith('hazard_') ? { floor: 0, ceiling: 100 } : { floor: 0, ceiling: 10000 };
}

const num = (...values: unknown[]): number | null => {
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
};

const isoOrNull = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** Polygons of a MultiPolygon taken as zones of their own (more is skipped). */
const MAX_PARTS = 100;

/**
 * The zone geometries of a GeoJSON geometry – one, or one per polygon of a MultiPolygon – and
 * what had to be simplified (`notes`).
 */
function featureGeometries(g: any, props: any, notes: string[]): ZoneGeometry[] {
  const polygon = (rings: unknown): ZoneGeometry => {
    const list = Array.isArray(rings) ? rings : [];
    if (list.length > 1 && !notes.includes(HOLES)) notes.push(HOLES);
    const ring: { lat: unknown; lon: unknown }[] = (Array.isArray(list[0]) ? list[0] : []).map((c: number[]) => ({ lat: c?.[1], lon: c?.[0] }));
    const first = ring[0];
    const last = ring.at(-1);
    if (ring.length > 3 && first && last && first.lat === last.lat && first.lon === last.lon) ring.pop();
    return parseZoneGeometry({ kind: 'polygon', polygon: ring });
  };
  switch (g?.type) {
    case 'Polygon':
      return [polygon(g.coordinates)];
    case 'MultiPolygon': {
      const parts: unknown[] = Array.isArray(g.coordinates) ? g.coordinates : [];
      if (parts.length === 0) throw new Error('MultiPolygon without polygons');
      if (parts.length > MAX_PARTS) throw new Error(`MultiPolygon of more than ${MAX_PARTS} polygons`);
      return parts.map(polygon);
    }
    case 'LineString': {
      const line = (Array.isArray(g.coordinates) ? g.coordinates : []).map((c: number[]) => ({ lat: c?.[1], lon: c?.[0] }));
      return [parseZoneGeometry({ kind: 'line', line, bufferM: num(props.bufferM, props.buffer_m, props.buffer) ?? 30 })];
    }
    case 'Point': {
      const radiusM = num(props.radiusM, props.radius_m, props.radius);
      if (radiusM === null || radiusM <= 0) throw new Error('a Point needs its radius in metres (property radiusM)');
      return [parseZoneGeometry({ kind: 'circle', center: { lat: g.coordinates?.[1], lon: g.coordinates?.[0] }, radiusM })];
    }
    default:
      throw new Error(`unsupported geometry ${g?.type ?? 'none'} (supported: Polygon, MultiPolygon, LineString, Point with radiusM)`);
  }
}

const HOLES = 'holes are not supported – the zone covers them';

/**
 * Parses a GeoJSON FeatureCollection. Invalid features are skipped (with a reason) rather than
 * failing the whole collection; a non-FeatureCollection input is a 400.
 */
export function parseZoneFeatures(input: unknown, defaultType: ZoneType, maxFeatures: number): { zones: ParsedZoneFeature[]; skipped: string[]; warnings: string[] } {
  const fc = input as { type?: string; features?: unknown[] };
  if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features)) throw badRequest('geojson must be a FeatureCollection');
  if (fc.features.length > maxFeatures) throw badRequest(`Too many features (max ${maxFeatures})`);
  const zones: ParsedZoneFeature[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  fc.features.forEach((f: any, i) => {
    const props = f?.properties && typeof f.properties === 'object' ? f.properties : {};
    const name = (String(props.name ?? props.NAME ?? '').trim() || `Zone ${i + 1}`).slice(0, 120);
    const type: ZoneType = (ZONE_TYPES as readonly string[]).includes(props.type) ? props.type : defaultType;
    let geometries: ZoneGeometry[];
    const notes: string[] = [];
    try {
      geometries = featureGeometries(f?.geometry, props, notes);
    } catch (err) {
      skipped.push(`${name}: ${(err as Error).message}`);
      return;
    }
    if (zones.length + geometries.length > maxFeatures) {
      skipped.push(`${name}: more than ${maxFeatures} zones in all`);
      return;
    }
    const d = zoneDefaults(type);
    // Times: a window that ends before it starts describes no time at all.
    const window: Record<'activeFrom' | 'activeTo', string | null> = { activeFrom: null, activeTo: null };
    for (const key of ['activeFrom', 'activeTo'] as const) {
      const raw = props[key];
      window[key] = isoOrNull(raw);
      if (raw != null && raw !== '' && window[key] === null) notes.push(`${key} "${String(raw).slice(0, 40)}" is not a date – ignored`);
    }
    if (window.activeFrom && window.activeTo && Date.parse(window.activeFrom) >= Date.parse(window.activeTo)) {
      skipped.push(`${name}: active from ${window.activeFrom} is not before active to ${window.activeTo}`);
      return;
    }
    // Altitudes: given the wrong way round, the zone covers the span between them.
    let floorM = num(props.floorM, props.floor) ?? d.floor;
    let ceilingM = num(props.ceilingM, props.ceiling) ?? d.ceiling;
    if (floorM > ceilingM) {
      notes.push(`floor ${floorM} m is above the ceiling ${ceilingM} m – the zone covers ${ceilingM}–${floorM} m`);
      [floorM, ceilingM] = [ceilingM, floorM];
    }
    if (ceilingM < floorM + 1) {
      notes.push(`floor and ceiling are both ${floorM} m – the zone covers ${floorM}–${floorM + 1} m`);
      ceilingM = floorM + 1;
    }
    for (const n of notes) warnings.push(`${name}: ${n}`);
    const featureId = typeof f?.id === 'string' || typeof f?.id === 'number' ? String(f.id).slice(0, 80) : null;
    geometries.forEach((geometry, k) => {
      const part = geometries.length > 1;
      zones.push({
        featureId: featureId !== null && part ? `${featureId}#${k + 1}` : featureId,
        name: part ? `${name.slice(0, 110)} (${k + 1}/${geometries.length})` : name,
        type,
        geometry,
        floorM,
        ceilingM,
        activeFrom: window.activeFrom,
        activeTo: window.activeTo,
        notes: String(props.notes ?? '').slice(0, 2000),
      });
    });
  });
  return { zones, skipped, warnings };
}
