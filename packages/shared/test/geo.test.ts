import { describe, expect, it } from 'vitest';
import {
  bufferPolyline,
  circlePolygon,
  destinationPoint,
  distancePointToPolylineM,
  haversineDistance,
  initialBearing,
  LocalProjection,
  pointInPolygon,
  pointShapeDistance,
  shapeDistanceM,
  shapeNearBox,
  type Shape,
  polygonAreaM2,
  segmentCrossesPolygon,
  shapesOverlap,
} from '../src/geo';

const LONDON = { lat: 51.5074, lon: -0.1278 };
const PARIS = { lat: 48.8566, lon: 2.3522 };

describe('geodesy', () => {
  it('computes great-circle distance (London–Paris ≈ 343.5 km)', () => {
    expect(haversineDistance(LONDON, PARIS) / 1000).toBeCloseTo(343.5, 0);
  });

  it('computes initial bearing (London→Paris ≈ 148°)', () => {
    expect(initialBearing(LONDON, PARIS)).toBeCloseTo(148.1, 0);
  });

  it('destinationPoint is the inverse of distance/bearing', () => {
    const p = destinationPoint(LONDON, 77, 12_345);
    expect(haversineDistance(LONDON, p)).toBeCloseTo(12_345, 3);
    expect(initialBearing(LONDON, p)).toBeCloseTo(77, 3);
  });

  it('local projection round-trips', () => {
    const proj = new LocalProjection(LONDON);
    const xy = proj.toXY({ lat: 51.51, lon: -0.12 });
    const back = proj.toLatLon(xy.x, xy.y);
    expect(back.lat).toBeCloseTo(51.51, 9);
    expect(back.lon).toBeCloseTo(-0.12, 9);
    // 1 km east ≈ 1000 m in x
    const east = destinationPoint(LONDON, 90, 1000);
    expect(proj.toXY(east).x).toBeCloseTo(1000, 0);
  });
});

describe('planar geometry', () => {
  const square = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 0.01 },
    { lat: 0.01, lon: 0.01 },
    { lat: 0.01, lon: 0 },
  ];

  it('point in polygon', () => {
    expect(pointInPolygon({ lat: 0.005, lon: 0.005 }, square)).toBe(true);
    expect(pointInPolygon({ lat: 0.02, lon: 0.005 }, square)).toBe(false);
    expect(pointInPolygon({ lat: 0, lon: 0.005 }, square)).toBe(true); // boundary
  });

  it('polygon area of a ~1.11 km square', () => {
    expect(polygonAreaM2(square) / 1e6).toBeCloseTo(1.236, 2);
  });

  it('distance from point to polyline', () => {
    const line = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 0.01 },
    ];
    const p = destinationPoint({ lat: 0, lon: 0.005 }, 0, 250);
    expect(distancePointToPolylineM(p, line)).toBeCloseTo(250, 0);
  });

  it('segment crossing a polygon edge', () => {
    expect(segmentCrossesPolygon({ lat: 0.005, lon: -0.01 }, { lat: 0.005, lon: 0.005 }, square)).toBe(true);
    expect(segmentCrossesPolygon({ lat: 0.002, lon: 0.002 }, { lat: 0.008, lon: 0.008 }, square)).toBe(false);
  });

  it('shape distances: cylinders, corridors, polygons', () => {
    const c1 = { kind: 'point' as const, point: { lat: 0, lon: 0 }, radiusM: 100 };
    const c2 = { kind: 'point' as const, point: destinationPoint({ lat: 0, lon: 0 }, 90, 250), radiusM: 100 };
    expect(shapeDistanceM(c1, c2)).toBeCloseTo(50, 0);
    expect(shapesOverlap(c1, c2)).toBe(false);
    const c3 = { ...c2, radiusM: 200 };
    expect(shapesOverlap(c1, c3)).toBe(true);

    const corridor = { kind: 'line' as const, line: [{ lat: -0.01, lon: 0.02 }, { lat: 0.02, lon: 0.02 }], radiusM: 50 };
    const poly = { kind: 'polygon' as const, polygon: square };
    // corridor centreline is ~1.11 km east of the square's east edge
    expect(shapeDistanceM(corridor, poly)).toBeCloseTo(1113 - 50, -1);
    const crossing = { kind: 'line' as const, line: [{ lat: 0.005, lon: -0.01 }, { lat: 0.005, lon: 0.03 }], radiusM: 10 };
    expect(shapesOverlap(crossing, poly)).toBe(true);
    // point fully inside polygon
    expect(shapeDistanceM({ kind: 'point', point: { lat: 0.005, lon: 0.005 }, radiusM: 1 }, poly)).toBeLessThanOrEqual(0);
    // polygon inside a big circle
    expect(shapesOverlap({ kind: 'point', point: { lat: 0.005, lon: 0.005 }, radiusM: 5000 }, poly)).toBe(true);
  });

  it('circle and buffer polygons have the expected radius', () => {
    const c = circlePolygon(LONDON, 500, 36);
    expect(c).toHaveLength(36);
    for (const p of c) expect(haversineDistance(LONDON, p)).toBeCloseTo(500, 3);
    const line = [LONDON, destinationPoint(LONDON, 45, 1000), destinationPoint(LONDON, 0, 2000)];
    const buf = bufferPolyline(line, 50);
    expect(buf.length).toBeGreaterThan(6);
    for (const p of buf) {
      const d = distancePointToPolylineM(p, line);
      expect(d).toBeGreaterThan(45);
      expect(d).toBeLessThan(101);
    }
  });
});

describe('distances of many points from one shape', () => {
  const HOME_ = { lat: 47.3977, lon: 8.5456 };
  // A star-shaped (concave) polygon of 600 vertices, a long winding corridor and a circle.
  const star = circlePolygon(HOME_, 3000, 600).map((p, i) => (i % 2 ? destinationPoint(HOME_, (i * 360) / 600, 1500 + (i % 7) * 120) : p));
  const winding = Array.from({ length: 400 }, (_, i) => destinationPoint(destinationPoint(HOME_, 90, i * 20 - 4000), 0, Math.sin(i / 9) * 600));
  const shapes: Shape[] = [
    { kind: 'polygon', polygon: star },
    { kind: 'line', line: winding, radiusM: 40 },
    // Wider than tall, with a buffer wide for its height: bands run north–south.
    { kind: 'line', line: winding, radiusM: 400 },
    { kind: 'point', point: HOME_, radiusM: 250 },
    { kind: 'polygon', polygon: star.slice(0, 20) },
  ];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

  it('are those of shapeDistanceM wherever they matter (indexed in bands for shapes with many edges)', () => {
    for (const shape of shapes) {
      for (const beyond of [0, 15, 60]) {
        const fast = pointShapeDistance(shape, beyond);
        for (let k = 0; k < 4000; k++) {
          const p = destinationPoint(HOME_, rnd() * 360, rnd() * 4500);
          const exact = shapeDistanceM({ kind: 'point', point: p, radiusM: 0 }, shape);
          const d = fast(p);
          if (exact <= beyond || d <= beyond) expect(Math.abs(d - exact), `${shape.kind} ${beyond}`).toBeLessThan(0.05);
          else expect(d).toBeGreaterThan(beyond);
        }
      }
    }
  });

  it('decide inside or outside a polygon like pointInPolygon, also on its vertices and edges', () => {
    const fast = pointShapeDistance({ kind: 'polygon', polygon: star }, 0);
    for (const v of star.slice(0, 50)) expect(fast(v)).toBeLessThanOrEqual(0);
    for (let k = 0; k < 4000; k++) {
      const p = destinationPoint(HOME_, rnd() * 360, rnd() * 3500);
      expect(fast(p) <= 0, JSON.stringify(p)).toBe(pointInPolygon(p, star) || shapeDistanceM({ kind: 'point', point: p, radiusM: 0 }, { kind: 'polygon', polygon: star }) <= 0);
    }
  });

  it('say whether a shape can come near a box', () => {
    const box = { minLat: HOME_.lat - 0.01, maxLat: HOME_.lat + 0.01, minLon: HOME_.lon - 0.01, maxLon: HOME_.lon + 0.01 };
    expect(shapeNearBox({ kind: 'point', point: destinationPoint(HOME_, 0, 1500), radiusM: 400 }, box)).toBe(true);
    expect(shapeNearBox({ kind: 'point', point: destinationPoint(HOME_, 0, 5000), radiusM: 400 }, box)).toBe(false);
    expect(shapeNearBox({ kind: 'point', point: destinationPoint(HOME_, 0, 5000), radiusM: 4000 }, box)).toBe(true);
    expect(shapeNearBox({ kind: 'polygon', polygon: star }, { minLat: 10, maxLat: 11, minLon: 10, maxLon: 11 })).toBe(false);
  });
});
