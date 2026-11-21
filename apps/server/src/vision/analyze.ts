/**
 * Analysis of one video frame: JPEG decode, object detection with the built-in detector and
 * dominant colour of every detection. Runs in the vision worker (or inline in tests).
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { ConvNet, detectObjects, dominantColor, type Detection, type DetectorModelSpec } from '@athena-sky/shared';

export interface FrameAnalysis {
  width: number;
  height: number;
  detections: (Detection & { color: string | null })[];
  ms: number;
}

/** Location of the built-in model next to this module (src/vision or dist). */
export function modelPath(): string {
  return fileURLToPath(new URL('./athena-detector.json', import.meta.url));
}

export function loadDetectorModel(path = modelPath()): DetectorModelSpec | null {
  if (!existsSync(path)) return null;
  const spec = JSON.parse(readFileSync(path, 'utf8')) as DetectorModelSpec;
  if (spec.format !== 'athena-centernet-1') throw new Error(`unsupported detector model format ${String(spec.format)}`);
  return spec;
}

export function analyzeFrame(net: ConvNet, jpegBytes: Uint8Array, threshold: number): FrameAnalysis {
  const t0 = performance.now();
  const img = jpeg.decode(jpegBytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 64, maxResolutionInMP: 10 });
  const data = img.data as Uint8Array;
  // A person's colour is that of the clothing on the torso; a vehicle's the whole body.
  const detections = detectObjects(net, data, img.width, img.height, threshold).map((d) => ({ ...d, color: dominantColor(data, img.width, img.height, d.box, d.cls === 'person' ? [0.15, 0.55] : [0, 1]) }));
  return { width: img.width, height: img.height, detections, ms: performance.now() - t0 };
}
