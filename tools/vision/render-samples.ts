/**
 * Renders sample camera frames around simulated targets (visual check of the synthetic world).
 * Usage: tsx tools/vision/render-samples.ts <out-dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { destinationPoint } from '@athena-sky/shared';
import { FrameRenderer, SimWorld, VIDEO_PRESETS, cameraPose, targetBox } from '@athena-sky/simulator';

const out = process.argv[2] ?? 'vision-samples';
mkdirSync(out, { recursive: true });
const world = new SimWorld({ lat: 25.075, lon: 121.535 });
const r = new FrameRenderer(VIDEO_PRESETS.sd);
const t0 = Date.UTC(2026, 10, 21, 3, 0, 0);
const targets = world.targetsAt(t0);
const picks = [targets.find((t) => t.kind === 'person')!, targets.find((t) => t.kind === 'vehicle')!, targets[3]!];
picks.forEach((target, k) => {
  const pos = world.positionOf(target);
  for (const [alt, back] of [[15, 15], [30, 30]] as const) {
    const heading = (target.heading + 40 * k) % 360;
    const cam = destinationPoint(pos, heading + 180, back);
    const tel = { t: t0, lat: cam.lat, lon: cam.lon, altRel: alt, heading, groundSpeed: 0, roll: 0, pitch: 0, battery: { pct: 90 }, mode: 'HOLD' } as never;
    const jpg = r.render(tel, world.anchor, targets);
    writeFileSync(join(out, `sample-${target.id}-${alt}.jpg`), jpg);
    const pose = cameraPose(tel, world.anchor, 640, 360);
    const boxes = targets.map((t) => ({ id: t.id, b: targetBox(pose, t) })).filter((x) => x.b && x.b.visible > 0.5);
    console.log(target.id, alt, boxes.map((x) => `${x.id}:${Math.round(x.b!.x0)},${Math.round(x.b!.y0)}-${Math.round(x.b!.x1)},${Math.round(x.b!.y1)}`).join(' '));
  }
});
