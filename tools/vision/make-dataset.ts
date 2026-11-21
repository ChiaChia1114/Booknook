/**
 * Synthetic training data for the Athena-sky object detector, rendered with the simulator's
 * camera exactly as the live video is produced: full frame with HUD, JPEG round trip at the SD
 * quality, then the shared downscale to the model input. Labels are the projected 3D boxes of
 * the people and vehicles (too small or mostly hidden objects are marked "ignore").
 *
 * Usage: tsx tools/vision/make-dataset.ts <out-dir> [train-count] [test-count] [seed]
 * Writes <out>/{train,test}.u8 (N × 180 × 320 × 3 RGB) and <out>/{train,test}.json (boxes).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { DETECTOR_CLASSES, DETECTOR_INPUT, destinationPoint, downscaleToRgb } from '@athena-sky/shared';
import { FrameRenderer, SimWorld, VIDEO_PRESETS, cameraPose, targetBox } from '@athena-sky/simulator';

const out = process.argv[2] ?? 'vision-data';
const nTrain = Number(process.argv[3] ?? 3500);
const nTest = Number(process.argv[4] ?? 500);
let seed = Number(process.argv[5] ?? 1);
const rand = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const uniform = (a: number, b: number) => a + (b - a) * rand();

const preset = VIDEO_PRESETS.sd;
const renderer = new FrameRenderer(preset);
const W = DETECTOR_INPUT.width;
const H = DETECTOR_INPUT.height;
const sx = W / preset.width;
const sy = H / preset.height;
// Several worlds, so that the detector does not learn one layout.
const worlds = [
  { lat: 25.075, lon: 121.535 },
  { lat: 47.26, lon: 11.35 },
  { lat: 51.5, lon: -0.12 },
  { lat: 37.775, lon: -122.42 },
  { lat: -33.87, lon: 151.21 },
].map((a) => new SimWorld(a, { people: 24, vehicles: 10 }));
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

type Box = [number, number, number, number, number, number]; // cls, x0, y0, x1, y1, ignore

function sample(): { rgb: Uint8Array; boxes: Box[] } {
  const world = worlds[Math.floor(rand() * worlds.length)]!;
  const t = T0 + Math.floor(rand() * 30 * DAY);
  const targets = world.targetsAt(t);
  let lat: number;
  let lon: number;
  let heading: number;
  let alt: number;
  if (rand() < 0.8) {
    // Looking at a target from a random side and distance, target anywhere in the frame.
    const target = targets[Math.floor(rand() * targets.length)]!;
    alt = rand() < 0.75 ? uniform(8, 30) : uniform(30, 60);
    const dist = alt * uniform(0.45, 1.7);
    const bearing = uniform(0, 360);
    const p = destinationPoint(world.positionOf(target), bearing, dist);
    lat = p.lat;
    lon = p.lon;
    heading = (bearing + 180 + uniform(-35, 35) + 360) % 360;
  } else {
    const p = world.toLatLon(uniform(-320, 320), uniform(-320, 320));
    lat = p.lat;
    lon = p.lon;
    alt = uniform(8, 60);
    heading = uniform(0, 360);
  }
  const tel = { t, lat, lon, altRel: alt, heading, groundSpeed: uniform(0, 12), roll: uniform(-8, 8), pitch: uniform(-6, 6), battery: { pct: uniform(20, 100) }, mode: rand() < 0.5 ? 'MISSION' : 'GUIDED' } as never;
  renderer.renderRaw(tel, world.anchor, targets);
  renderer.hud(tel);
  const raw = (renderer as unknown as { buf: Buffer }).buf;
  const enc = jpeg.encode({ data: raw, width: preset.width, height: preset.height }, preset.quality).data;
  const dec = jpeg.decode(enc, { useTArray: true, formatAsRGBA: true });
  const rgb = downscaleToRgb(dec.data, dec.width, dec.height, 4, W, H);
  const cam = cameraPose(tel, world.anchor, preset.width, preset.height);
  const boxes: Box[] = [];
  for (const tg of targets) {
    const b = targetBox(cam, tg);
    if (!b || b.visible <= 0 || b.depth > 400) continue;
    const x0 = b.x0 * sx;
    const y0 = b.y0 * sy;
    const x1 = b.x1 * sx;
    const y1 = b.y1 * sy;
    const tall = y1 - y0;
    const wide = x1 - x0;
    // Large enough and mostly in view → object; otherwise "ignore" (neither object nor background).
    const ignore = b.visible < 0.6 || tall < (tg.kind === 'person' ? 5 : 3) || wide < 1.5 ? 1 : 0;
    boxes.push([DETECTOR_CLASSES.indexOf(tg.kind), x0, y0, x1, y1, ignore]);
  }
  return { rgb, boxes };
}

mkdirSync(out, { recursive: true });
for (const [name, n] of [['train', nTrain], ['test', nTest]] as const) {
  const images = Buffer.alloc(n * W * H * 3);
  const labels: Box[][] = [];
  const started = Date.now();
  for (let i = 0; i < n; i++) {
    const s = sample();
    images.set(s.rgb, i * W * H * 3);
    labels.push(s.boxes.map((b) => b.map((v, k) => (k >= 1 && k <= 4 ? Math.round(v * 100) / 100 : v)) as Box));
    if ((i + 1) % 500 === 0) console.log(`${name}: ${i + 1}/${n} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  }
  writeFileSync(join(out, `${name}.u8`), images);
  writeFileSync(join(out, `${name}.json`), JSON.stringify({ width: W, height: H, classes: DETECTOR_CLASSES, labels }));
  const objects = labels.flat().filter((b) => !b[5]);
  console.log(`${name}: ${n} images, ${objects.filter((b) => b[0] === 0).length} people, ${objects.filter((b) => b[0] === 1).length} vehicles (+${labels.flat().length - objects.length} ignored)`);
}
