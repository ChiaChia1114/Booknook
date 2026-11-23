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
import { ZONE_TYPES, cleanName } from '@athena-sky/shared';
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

const FOOT_M = 0.3048;
/** The highest height a zone can reach (m). */
const HEIGHT_MAX_M = 20_000;

/**
 * A floor or ceiling: metres (a number, or a text with `m` / `ft`), `SFC` / `GND` (the ground),
 * `UNL` (unlimited) or a flight level (`FL100`, converted with a note). Anything else is reported
 * and the zone type's default is used.
 */
function height(values: unknown[], which: 'floor' | 'ceiling', fallback: number, notes: string[]): number {
  const raw = values.find((v) => v !== null && v !== undefined && v !== '');
  if (raw === undefined) return fallback;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const text = String(raw).trim();
  const metres = /^(-?\d+(?:\.\d+)?)\s*(m|metres|meters|ft|feet)?$/i.exec(text);
  if (metres) return Math.round(Number(metres[1]) * (/^f/i.test(metres[2] ?? '') ? FOOT_M : 1) * 10) / 10;
  if (/^(sfc|gnd|ground)$/i.test(text)) return 0;
  if (/^(unl|unltd|unlimited)$/i.test(text)) return HEIGHT_MAX_M;
  const level = /^FL\s*(\d{1,3})$/i.exec(text);
  if (level) {
    const m = Math.round(Number(level[1]) * 100 * FOOT_M);
    notes.push(`${which} ${text.toUpperCase().replace(/\s+/g, '')} is a flight level – taken as ${m} m`);
    return m;
  }
  notes.push(`${which} "${text.slice(0, 40)}" is not a height – ${fallback} m is used`);
  return fallback;
}

/**
 * A length (a radius, a buffer): metres as a number, or a text with `m`, `km` or `ft`. Returns
 * null when absent, NaN when given but not a length.
 */
function length(values: unknown[]): number | null {
  const raw = values.find((v) => v !== null && v !== undefined && v !== '');
  if (raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  const m = /^(\d+(?:\.\d+)?)\s*(m|metres|meters|km|ft|feet)?$/i.exec(String(raw).trim());
  if (!m) return NaN;
  const unit = (m[2] ?? 'm').toLowerCase();
  return Math.round(Number(m[1]) * (unit === 'km' ? 1000 : unit.startsWith('f') ? FOOT_M : 1) * 10) / 10;
}

/** Zone types as feeds write them (any case; common abbreviations). */
const TYPE_ALIASES: Record<string, ZoneType> = {
  p: 'prohibited',
  'prohibited area': 'prohibited',
  r: 'restricted',
  'restricted area': 'restricted',
  d: 'danger',
  'danger area': 'danger',
  ctr: 'controlled',
  cta: 'controlled',
  tma: 'controlled',
  atz: 'controlled',
  'controlled airspace': 'controlled',
  tfr: 'temporary',
  tra: 'temporary',
  'temporary restriction': 'temporary',
  powerline: 'hazard_powerline',
  'power line': 'hazard_powerline',
  obstacle: 'hazard_obstacle',
};

function zoneType(raw: unknown, fallback: ZoneType, notes: string[]): ZoneType {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const key = String(raw).trim().toLowerCase().replace(/[-_]+/g, ' ');
  const known = (ZONE_TYPES as readonly string[]).find((t) => t.replace(/_/g, ' ') === key) as ZoneType | undefined;
  const type = known ?? TYPE_ALIASES[key];
  if (type) return type;
  notes.push(`type "${String(raw).slice(0, 40)}" is not known – ${fallback} is used`);
  return fallback;
}

const num = (...values: unknown[]): number | null => {
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
};

/** ISO 8601: a date (UTC), or a date and time with its time zone – never the server's local time. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2}))?$/i;

const isoOrNull = (v: unknown): string | null => {
  if (typeof v !== 'string' || !ISO_TIME.test(v.trim())) return null;
  const text = v.trim().replace(' ', 'T');
  const t = Date.parse(text);
  if (!Number.isFinite(t)) return null;
  // A date that does not exist (30 February) is not rolled over to another one.
  const [y, mo, d] = text.slice(0, 10).split('-').map(Number);
  const day = new Date(Date.UTC(y!, mo! - 1, d!));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo! - 1 || day.getUTCDate() !== d) return null;
  const time = /T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (time && (Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3] ?? 0) > 59)) return null;
  return new Date(t).toISOString();
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
      const bufferM = length([props.bufferM, props.buffer_m, props.buffer]);
      if (Number.isNaN(bufferM)) throw new Error(`bufferM "${String(props.bufferM ?? props.buffer_m ?? props.buffer).slice(0, 40)}" is not a length (metres, or a text with m, km or ft)`);
      return [parseZoneGeometry({ kind: 'line', line, bufferM: bufferM ?? 30 })];
    }
    case 'Point': {
      const radiusM = length([props.radiusM, props.radius_m, props.radius]);
      if (radiusM === null || Number.isNaN(radiusM) || radiusM <= 0) throw new Error('a Point needs its radius (property radiusM: metres, or a text with m, km or ft)');
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
    const notes: string[] = [];
    const rawName = props.name ?? props.NAME;
    const textName = typeof rawName === 'string' || typeof rawName === 'number' ? cleanName(String(rawName)) : '';
    if (rawName !== undefined && rawName !== null && typeof rawName !== 'string' && typeof rawName !== 'number') notes.push('name is not a text – ignored');
    const name = (textName || `Zone ${i + 1}`).slice(0, 120);
    const type = zoneType(props.type, defaultType, notes);
    let geometries: ZoneGeometry[];
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
      if (raw != null && raw !== '' && window[key] === null) notes.push(`${key} "${String(raw).slice(0, 40)}" is not an ISO 8601 date (a time needs its time zone) – ignored`);
    }
    if (window.activeFrom && window.activeTo && Date.parse(window.activeFrom) >= Date.parse(window.activeTo)) {
      skipped.push(`${name}: active from ${window.activeFrom} is not before active to ${window.activeTo}`);
      return;
    }
    // Altitudes: given the wrong way round, the zone covers the span between them.
    let floorM = height([props.floorM, props.floor], 'floor', d.floor, notes);
    let ceilingM = height([props.ceilingM, props.ceiling], 'ceiling', d.ceiling, notes);
    if (floorM > ceilingM) {
      notes.push(`floor ${floorM} m is above the ceiling ${ceilingM} m – the zone covers ${ceilingM}–${floorM} m`);
      [floorM, ceilingM] = [ceilingM, floorM];
    }
    // Heights a zone can have (as zones created by hand): from 500 m below to 20 000 m above.
    if (ceilingM < 0) {
      skipped.push(`${name}: lies below the ground (ceiling ${ceilingM} m)`);
      return;
    }
    if (floorM < -500) {
      notes.push(`floor ${floorM} m is below −500 m – −500 m is used`);
      floorM = -500;
    }
    if (ceilingM > HEIGHT_MAX_M) {
      notes.push(`ceiling ${ceilingM} m is above ${HEIGHT_MAX_M} m – ${HEIGHT_MAX_M} m is used`);
      ceilingM = HEIGHT_MAX_M;
    }
    if (floorM >= HEIGHT_MAX_M) {
      skipped.push(`${name}: floor ${floorM} m is above any flight`);
      return;
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
