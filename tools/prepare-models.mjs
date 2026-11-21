/**
 * Prepares the customer-supplied drone models (GLB) for the 3D views.
 *
 *   node tools/prepare-models.mjs <source-dir>
 *
 * For each model in MODELS:
 *  - animations other than the propeller spin (e.g. "Explode" / "Explode_Loop" exploded
 *    views) are removed – Cesium starts every animation of an entity's model;
 *  - the model is re-pivoted so that its origin is the bottom of the airframe (landing gear
 *    on the ground when the drone is landed); horizontal centring is kept;
 *  - geometry, materials and the binary buffer are left untouched (lossless).
 * The models follow the glTF convention (+Y up, +Z nose), which Cesium maps to its X-forward
 * model frame.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODELS = {
  'TaiXiChuang_Quad.glb': 'taixichuang-quad.glb',
  'H380.glb': 'h380.glb',
  'Hamburger_X8.glb': 'hamburger-x8.glb',
  'Specter-10X.glb': 'specter-10x.glb',
};
const KEEP_ANIMATION = /spin|prop|rotor/i;

const src = process.argv[2];
if (!src) {
  console.error('usage: node tools/prepare-models.mjs <directory with the source .glb files>');
  process.exit(2);
}
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'public', 'models');
mkdirSync(out, { recursive: true });

function readGlb(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67 || buf.readUInt32LE(4) !== 2) throw new Error('not a glTF 2.0 binary');
  const jsonLen = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4e4f534a) throw new Error('first chunk is not JSON');
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen;
  const bin = binStart < buf.length ? buf.subarray(binStart + 8, binStart + 8 + buf.readUInt32LE(binStart)) : Buffer.alloc(0);
  return { json, bin };
}

function writeGlb(json, bin) {
  let j = Buffer.from(JSON.stringify(json), 'utf8');
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const b = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4, 0)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + j.length + (b.length ? 8 + b.length : 0), 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(j.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const parts = [header, jh, j];
  if (b.length) {
    const bh = Buffer.alloc(8);
    bh.writeUInt32LE(b.length, 0);
    bh.writeUInt32LE(0x004e4942, 4);
    parts.push(bh, b);
  }
  return Buffer.concat(parts);
}

const mul = (a, c) => {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) for (let i = 0; i < 4; i++) o[k * 4 + r] += a[i * 4 + r] * c[k * 4 + i];
  return o;
};
const local = (n) => {
  if (n.matrix) return n.matrix;
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
};

/** Bounding box of the scene in model coordinates (from accessor bounds). */
function sceneBounds(json) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const visit = (ni, parent) => {
    const n = json.nodes[ni];
    const m = mul(parent, local(n));
    if (n.mesh !== undefined) {
      for (const p of json.meshes[n.mesh].primitives) {
        const a = json.accessors[p.attributes.POSITION];
        for (const cx of [a.min[0], a.max[0]]) for (const cy of [a.min[1], a.max[1]]) for (const cz of [a.min[2], a.max[2]]) {
          for (let r = 0; r < 3; r++) {
            const v = m[r] * cx + m[4 + r] * cy + m[8 + r] * cz + m[12 + r];
            min[r] = Math.min(min[r], v);
            max[r] = Math.max(max[r], v);
          }
        }
      }
    }
    for (const c of n.children ?? []) visit(c, m);
  };
  for (const r of json.scenes[json.scene ?? 0].nodes) visit(r, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return { min, max };
}

for (const [from, to] of Object.entries(MODELS)) {
  const { json, bin } = readGlb(readFileSync(join(src, from)));
  const before = (json.animations ?? []).map((a) => a.name);
  json.animations = (json.animations ?? []).filter((a) => KEEP_ANIMATION.test(a.name ?? ''));
  if (json.animations.length === 0) delete json.animations;
  const { min, max } = sceneBounds(json);
  const scene = json.scenes[json.scene ?? 0];
  if (Math.abs(min[1]) > 1e-4) {
    json.nodes.push({ name: 'athena_ground_pivot', translation: [0, -min[1], 0], children: scene.nodes });
    scene.nodes = [json.nodes.length - 1];
  }
  json.asset = { ...json.asset, extras: { ...(json.asset?.extras ?? {}), athena: `prepared from ${from}: kept animations ${JSON.stringify((json.animations ?? []).map((a) => a.name))}, origin at the bottom` } };
  const glb = writeGlb(json, bin);
  writeFileSync(join(out, to), glb);
  console.log(`${to}: ${(glb.length / 1048576).toFixed(2)} MB, size ${max.map((v, i) => (v - min[i]).toFixed(2)).join(' × ')} m, animations ${JSON.stringify(before)} → ${JSON.stringify((json.animations ?? []).map((a) => a.name))}, lifted ${(-min[1]).toFixed(3)} m`);
}
