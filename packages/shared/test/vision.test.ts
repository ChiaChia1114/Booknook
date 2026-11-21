import { describe, expect, it } from 'vitest';
import { ObjectTracker, base64ToBytes, conv2d, decodeDetections, dominantColor, downscaleToRgb, haversineDistance, imagePointToGround, initialBearing, iou, type Tensor } from '../src';

const rand = (() => {
  let s = 12345;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
})();

/** Textbook convolution (independent of the optimised loop order in conv2d). */
function referenceConv(x: Tensor, w: Float32Array, b: Float32Array, outC: number, k: number, stride: number, pad: number, dilation: number, relu: boolean): Tensor {
  const oh = Math.floor((x.h + 2 * pad - dilation * (k - 1) - 1) / stride) + 1;
  const ow = Math.floor((x.w + 2 * pad - dilation * (k - 1) - 1) / stride) + 1;
  const out = new Float32Array(outC * oh * ow);
  for (let oc = 0; oc < outC; oc++)
    for (let y = 0; y < oh; y++)
      for (let xx = 0; xx < ow; xx++) {
        let acc = b[oc]!;
        for (let ic = 0; ic < x.c; ic++)
          for (let ky = 0; ky < k; ky++)
            for (let kx = 0; kx < k; kx++) {
              const sy = y * stride + ky * dilation - pad;
              const sx = xx * stride + kx * dilation - pad;
              if (sy < 0 || sx < 0 || sy >= x.h || sx >= x.w) continue;
              acc += w[((oc * x.c + ic) * k + ky) * k + kx]! * x.data[(ic * x.h + sy) * x.w + sx]!;
            }
        out[(oc * oh + y) * ow + xx] = relu ? Math.max(0, acc) : acc;
      }
  return { c: outC, h: oh, w: ow, data: out };
}

describe('vision core', () => {
  it('downscales by area averaging', () => {
    // 4×2 RGBA → 2×1: each target pixel averages a 2×2 block.
    const src = new Uint8Array([10, 0, 0, 255, 30, 0, 0, 255, 100, 50, 0, 255, 100, 50, 0, 255, 20, 0, 0, 255, 40, 0, 0, 255, 100, 70, 0, 255, 100, 70, 0, 255]);
    expect([...downscaleToRgb(src, 4, 2, 4, 2, 1)]).toEqual([25, 0, 0, 100, 60, 0]);
  });

  it('matches a reference convolution (stride, padding, dilation, 1×1)', () => {
    for (const [inC, outC, k, stride, pad, dilation, relu] of [
      [3, 4, 3, 2, 1, 1, true],
      [4, 3, 3, 1, 2, 2, true],
      [5, 6, 1, 1, 0, 1, false],
      [2, 2, 3, 1, 1, 1, false],
    ] as const) {
      const x: Tensor = { c: inC, h: 9, w: 13, data: Float32Array.from({ length: inC * 9 * 13 }, rand) };
      const w = Float32Array.from({ length: outC * inC * k * k }, rand);
      const b = Float32Array.from({ length: outC }, rand);
      const got = conv2d(x, { inC, outC, k, stride, pad, dilation, relu, w, b });
      const ref = referenceConv(x, w, b, outC, k, stride, pad, dilation, relu);
      expect([got.c, got.h, got.w]).toEqual([ref.c, ref.h, ref.w]);
      let worst = 0;
      for (let i = 0; i < ref.data.length; i++) worst = Math.max(worst, Math.abs(got.data[i]! - ref.data[i]!));
      expect(worst).toBeLessThan(1e-5);
    }
  });

  it('decodes heatmap peaks into boxes with size and offset', () => {
    const h = 10;
    const w = 16;
    const plane = h * w;
    const t: Tensor = { c: 6, h, w, data: new Float32Array(6 * plane).fill(-9) };
    // Vehicle peak at cell (x 5, y 4): 20×8 px box, offset (0.5, 0.25).
    const i = 4 * w + 5;
    t.data[1 * plane + i] = 3;
    t.data[1 * plane + i + 1] = 1; // a neighbour lower than the peak is suppressed
    t.data[2 * plane + i] = Math.log(20 / 4);
    t.data[3 * plane + i] = Math.log(8 / 4);
    t.data[4 * plane + i] = 0.5;
    t.data[5 * plane + i] = 0.25;
    const dets = decodeDetections(t, { classes: ['person', 'vehicle'], stride: 4, input: { width: 64, height: 40 } }, 0.35);
    expect(dets).toHaveLength(1);
    expect(dets[0]!.cls).toBe('vehicle');
    const [x, y, bw, bh] = dets[0]!.box;
    expect(x * 64).toBeCloseTo(22 - 10, 5);
    expect(y * 40).toBeCloseTo(17 - 4, 5);
    expect(bw * 64).toBeCloseTo(20, 5);
    expect(bh * 40).toBeCloseTo(8, 5);
  });

  it('computes IoU', () => {
    expect(iou([0, 0, 2, 2], [1, 1, 2, 2])).toBeCloseTo(1 / 7, 6);
    expect(iou([0, 0, 1, 1], [2, 2, 1, 1])).toBe(0);
  });

  it('keeps identities of moving objects, votes on the class and drops lost tracks', () => {
    const tr = new ObjectTracker({ minHits: 2, maxMisses: 2 });
    let ids: number[] = [];
    for (let k = 0; k < 6; k++) {
      const out = tr.update(k * 300, [
        { cls: 'person', score: 0.9, box: [0.1 + k * 0.01, 0.5, 0.03, 0.1] },
        { cls: k === 2 ? 'person' : 'vehicle', score: 0.8, box: [0.6 - k * 0.02, 0.3, 0.12, 0.08] },
      ]);
      if (k === 0) expect(out).toHaveLength(0); // not confirmed yet
      if (k >= 1) ids = out.map((o) => o.id).sort();
    }
    expect(ids).toEqual([1, 2]);
    expect(tr.get(2)!.cls).toBe('vehicle'); // one wrong frame does not flip the class
    // Out of sight long enough: dropped.
    for (let k = 6; k < 10; k++) tr.update(k * 300, []);
    expect(tr.active()).toHaveLength(0);
    expect(tr.get(1)).toBeUndefined();
  });

  it('recognises the dominant colour against the background', () => {
    const W = 20;
    const H = 20;
    const img = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) img.set([60, 140, 60, 255], i * 4);
    for (let y = 6; y < 14; y++) for (let x = 6; x < 14; x++) img.set([200, 30, 35, 255], (y * W + x) * 4);
    expect(dominantColor(img, W, H, [0.25, 0.25, 0.5, 0.5])).toBe('red');
  });

  it('decodes base64 without platform APIs', () => {
    expect([...base64ToBytes('AAECAwT/')]).toEqual([0, 1, 2, 3, 4, 255]);
  });

  it('geolocates image points on flat ground', () => {
    const cam = { lat: 25.07, lon: 121.53, heightM: 20, headingDeg: 90, pitchDeg: -45, hfovDeg: 78, aspect: 16 / 9 };
    // Image centre at 45° down: the ground point is as far ahead as the camera is high.
    const c = imagePointToGround(cam, 0.5, 0.5)!;
    expect(c.distanceM).toBeCloseTo(20, 6);
    expect(haversineDistance(cam, c)).toBeCloseTo(20, 1);
    expect(initialBearing(cam, c)).toBeCloseTo(90, 3);
    // Lower in the image = closer; above the horizon = no ground point.
    expect(imagePointToGround(cam, 0.5, 0.9)!.distanceM).toBeLessThan(20);
    expect(imagePointToGround({ ...cam, pitchDeg: -5 }, 0.5, 0.0)).toBeNull();
  });
});
