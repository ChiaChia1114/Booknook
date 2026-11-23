/**
 * Prepared facts of airspace zones, kept with each zone object while it lives (the lists of the
 * providers are cached, so they are prepared once): the zone's shape, its latitude/longitude box
 * (with its radius) and active window, and prepared distance functions. Checks test the boxes
 * first and only then the geometry – with thousands of zones from feeds a check costs the zones
 * near the volume, not all of them.
 */
import type { AirspaceZoneDto, BBox, LatLon, Shape } from '@athena-sky/shared';
import { bboxOf, pointShapeDistance, toRad } from '@athena-sky/shared';
import { zoneShape } from './geometry';

export interface ZoneInfo {
  shape: Shape;
  /** The zone's box, its radius included. */
  box: BBox;
  from: number;
  to: number;
  /** Prepared point distances, by the distance they are needed up to. */
  near: Map<number, (p: LatLon) => number>;
}

const infos = new WeakMap<AirspaceZoneDto, ZoneInfo>();

/** Points (or the vertices) of a shape. */
function vertices(shape: Shape): LatLon[] {
  return shape.kind === 'point' ? [shape.point] : shape.kind === 'line' ? shape.line : shape.polygon;
}

/** A box grown by `m` metres on every side. */
export function grow(b: BBox, m: number): BBox {
  const dLat = m / 111_000;
  const lat = Math.min(89, Math.max(Math.abs(b.minLat), Math.abs(b.maxLat)) + dLat);
  const dLon = m / (111_000 * Math.max(0.01, Math.cos(toRad(lat))));
  return { minLat: b.minLat - dLat, maxLat: b.maxLat + dLat, minLon: b.minLon - dLon, maxLon: b.maxLon + dLon };
}

/** Whether two boxes overlap (near the antimeridian: yes). */
export function boxesOverlap(a: BBox, b: BBox): boolean {
  if (Math.max(Math.abs(a.minLon), Math.abs(a.maxLon), Math.abs(b.minLon), Math.abs(b.maxLon)) > 179) return true;
  return a.minLat <= b.maxLat && a.maxLat >= b.minLat && a.minLon <= b.maxLon && a.maxLon >= b.minLon;
}

/** The box of a shape, its radius included. */
export function shapeBox(shape: Shape): BBox {
  const b = bboxOf(vertices(shape)) ?? { minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 };
  const r = shape.kind === 'polygon' ? (shape.radiusM ?? 0) : shape.radiusM;
  return grow(b, r);
}

export function zoneInfo(z: AirspaceZoneDto): ZoneInfo {
  let info = infos.get(z);
  if (!info) {
    const shape = zoneShape(z.geometry);
    info = {
      shape,
      box: shapeBox(shape),
      from: z.activeFrom ? new Date(z.activeFrom).getTime() : -Infinity,
      to: z.activeTo ? new Date(z.activeTo).getTime() : Infinity,
      near: new Map(),
    };
    infos.set(z, info);
  }
  return info;
}

/** Whether the zone is active at some time of [from, to]. */
export function zoneActiveIn(info: ZoneInfo, from: number, to: number): boolean {
  return from <= info.to && info.from <= to;
}

/** Prepared distance of points from the zone (exact up to `beyondM`). */
export function zoneDistance(z: AirspaceZoneDto, beyondM: number): (p: LatLon) => number {
  const info = zoneInfo(z);
  let fn = info.near.get(beyondM);
  if (!fn) {
    fn = pointShapeDistance(info.shape, beyondM);
    info.near.set(beyondM, fn);
  }
  return fn;
}
