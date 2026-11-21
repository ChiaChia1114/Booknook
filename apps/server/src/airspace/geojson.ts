/**
 * GeoJSON → airspace zones. Used by the zone import endpoint and by external
 * GeoJSON airspace feeds (see providers.ts).
 *
 * Supported features: Polygon (first ring), LineString (+ `bufferM`) and Point (+ `radiusM`).
 * Properties: `name`, `type` (one of ZONE_TYPES), `floor`/`floorM`, `ceiling`/`ceilingM` (metres),
 * `activeFrom`/`activeTo` (ISO 8601), `notes`, optional feature `id`.
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

function featureGeometry(g: any, props: any): ZoneGeometry {
  if (g?.type === 'Polygon') {
    const ring: { lat: unknown; lon: unknown }[] = (Array.isArray(g.coordinates?.[0]) ? g.coordinates[0] : []).map((c: number[]) => ({ lat: c?.[1], lon: c?.[0] }));
    const first = ring[0];
    const last = ring.at(-1);
    if (ring.length > 3 && first && last && first.lat === last.lat && first.lon === last.lon) ring.pop();
    return parseZoneGeometry({ kind: 'polygon', polygon: ring });
  }
  if (g?.type === 'LineString') {
    const line = (Array.isArray(g.coordinates) ? g.coordinates : []).map((c: number[]) => ({ lat: c?.[1], lon: c?.[0] }));
    return parseZoneGeometry({ kind: 'line', line, bufferM: num(props.bufferM) ?? 30 });
  }
  if (g?.type === 'Point' && (num(props.radiusM) ?? 0) > 0) {
    return parseZoneGeometry({ kind: 'circle', center: { lat: g.coordinates?.[1], lon: g.coordinates?.[0] }, radiusM: num(props.radiusM)! });
  }
  throw new Error(`unsupported geometry ${g?.type ?? 'none'}`);
}

/**
 * Parses a GeoJSON FeatureCollection. Invalid features are skipped (with a reason) rather than
 * failing the whole collection; a non-FeatureCollection input is a 400.
 */
export function parseZoneFeatures(input: unknown, defaultType: ZoneType, maxFeatures: number): { zones: ParsedZoneFeature[]; skipped: string[] } {
  const fc = input as { type?: string; features?: unknown[] };
  if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features)) throw badRequest('geojson must be a FeatureCollection');
  if (fc.features.length > maxFeatures) throw badRequest(`Too many features (max ${maxFeatures})`);
  const zones: ParsedZoneFeature[] = [];
  const skipped: string[] = [];
  fc.features.forEach((f: any, i) => {
    const props = f?.properties && typeof f.properties === 'object' ? f.properties : {};
    const name = String(props.name ?? props.NAME ?? `Zone ${i + 1}`).slice(0, 120);
    const type: ZoneType = (ZONE_TYPES as readonly string[]).includes(props.type) ? props.type : defaultType;
    let geometry: ZoneGeometry;
    try {
      geometry = featureGeometry(f?.geometry, props);
    } catch (err) {
      skipped.push(`${name}: ${(err as Error).message}`);
      return;
    }
    const d = zoneDefaults(type);
    const floorM = num(props.floorM, props.floor) ?? d.floor;
    const ceilingM = Math.max(num(props.ceilingM, props.ceiling) ?? d.ceiling, floorM + 1);
    const featureId = typeof f?.id === 'string' || typeof f?.id === 'number' ? String(f.id).slice(0, 80) : null;
    zones.push({
      featureId,
      name,
      type,
      geometry,
      floorM,
      ceilingM,
      activeFrom: isoOrNull(props.activeFrom),
      activeTo: isoOrNull(props.activeTo),
      notes: String(props.notes ?? '').slice(0, 2000),
    });
  });
  return { zones, skipped };
}
