/**
 * Generates the low-poly glTF 2.0 VTOL fixed-wing model used by the 3D views
 * (apps/web/public/models/vtol.glb). The multirotor models are customer-supplied
 * (see tools/prepare-models.mjs).
 *
 * Built with the nose along +X, then turned so that the file follows the glTF convention
 * (+Y up, +Z nose, −X right wing). Units: metres.
 * Run: node tools/make-drone-models.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'public', 'models');

const COLORS = {
  body: [0.16, 0.18, 0.22, 1],
  arm: [0.24, 0.26, 0.3, 1],
  front: [0.93, 0.27, 0.27, 1],
  motor: [0.75, 0.77, 0.8, 1],
  prop: [0.85, 0.9, 0.95, 0.45],
  accent: [0.22, 0.74, 0.97, 1],
  camera: [0.05, 0.05, 0.06, 1],
  wing: [0.9, 0.92, 0.95, 1],
};

/** Mesh builder: one primitive per material. */
class Mesh {
  constructor() {
    this.parts = new Map();
  }
  part(material) {
    if (!this.parts.has(material)) this.parts.set(material, { pos: [], nrm: [], idx: [] });
    return this.parts.get(material);
  }
  /** Axis-aligned box (centre, size), optionally rotated about Y by `yaw` radians around the origin. */
  box(material, [cx, cy, cz], [sx, sy, sz], yaw = 0) {
    const p = this.part(material);
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const rot = ([x, y, z]) => [x * c + z * s, y, -x * s + z * c];
    const faces = [
      [[1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]],
      [[-1, 0, 0], [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]]],
      [[0, 1, 0], [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]]],
      [[0, -1, 0], [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]]],
      [[0, 0, 1], [[1, -1, 1], [1, 1, 1], [-1, 1, 1], [-1, -1, 1]]],
      [[0, 0, -1], [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]]],
    ];
    for (const [n, quad] of faces) {
      const base = p.pos.length / 3;
      for (const [x, y, z] of quad) {
        p.pos.push(...rot([cx + (x * sx) / 2, cy + (y * sy) / 2, cz + (z * sz) / 2]));
        p.nrm.push(...rot(n));
      }
      p.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  /** Vertical cylinder (axis Y) with caps. */
  cylinder(material, [cx, cy, cz], r, h, seg = 20) {
    const p = this.part(material);
    const y0 = cy - h / 2;
    const y1 = cy + h / 2;
    const base = p.pos.length / 3;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const x = Math.cos(a);
      const z = Math.sin(a);
      p.pos.push(cx + x * r, y0, cz + z * r, cx + x * r, y1, cz + z * r);
      p.nrm.push(x, 0, z, x, 0, z);
    }
    for (let i = 0; i < seg; i++) {
      const a = base + i * 2;
      p.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    for (const [y, ny] of [[y1, 1], [y0, -1]]) {
      const c = p.pos.length / 3;
      p.pos.push(cx, y, cz);
      p.nrm.push(0, ny, 0);
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        p.pos.push(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r);
        p.nrm.push(0, ny, 0);
      }
      for (let i = 0; i < seg; i++) {
        if (ny > 0) p.idx.push(c, c + i + 2, c + i + 1);
        else p.idx.push(c, c + i + 1, c + i + 2);
      }
    }
  }
}

/** Turns the mesh about Y so that +X (built nose) becomes +Z (glTF nose). */
function noseToPlusZ(mesh) {
  for (const p of mesh.parts.values()) {
    for (const arr of [p.pos, p.nrm]) {
      for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i];
        const z = arr[i + 2];
        arr[i] = -z;
        arr[i + 2] = x;
      }
    }
  }
  return mesh;
}

function toGlb(mesh, name) {
  const materials = [...mesh.parts.keys()];
  const chunks = [];
  const bufferViews = [];
  const accessors = [];
  let offset = 0;
  const pushView = (typed, target) => {
    const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const pad = (4 - (bytes.length % 4)) % 4;
    chunks.push(bytes, Buffer.alloc(pad));
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    offset += bytes.length + pad;
    return bufferViews.length - 1;
  };
  const primitives = materials.map((m, mi) => {
    const p = mesh.parts.get(m);
    const pos = new Float32Array(p.pos);
    const nrm = new Float32Array(p.nrm);
    const idx = new Uint16Array(p.idx);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], pos[i + k]);
      max[k] = Math.max(max[k], pos[i + k]);
    }
    accessors.push({ bufferView: pushView(pos, 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max });
    const posA = accessors.length - 1;
    accessors.push({ bufferView: pushView(nrm, 34962), componentType: 5126, count: nrm.length / 3, type: 'VEC3' });
    const nrmA = accessors.length - 1;
    accessors.push({ bufferView: pushView(idx, 34963), componentType: 5123, count: idx.length, type: 'SCALAR' });
    return { attributes: { POSITION: posA, NORMAL: nrmA }, indices: accessors.length - 1, material: mi };
  });
  const bin = Buffer.concat(chunks);
  const gltf = {
    asset: { version: '2.0', generator: 'Athena-sky make-drone-models' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [{ name, primitives }],
    materials: materials.map((m) => ({
      name: m,
      pbrMetallicRoughness: { baseColorFactor: COLORS[m], metallicFactor: m === 'motor' ? 0.6 : 0.1, roughnessFactor: 0.6 },
      ...(COLORS[m][3] < 1 ? { alphaMode: 'BLEND', doubleSided: true } : {}),
    })),
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
  };
  let json = Buffer.from(JSON.stringify(gltf), 'utf8');
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(json.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4); // 'JSON'
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4); // 'BIN\0'
  return Buffer.concat([header, jh, json, bh, bin]);
}

function vtol() {
  const m = new Mesh();
  m.box('wing', [0, 0, 0], [1.3, 0.16, 0.16]); // fuselage
  m.box('accent', [0.62, 0, 0], [0.12, 0.12, 0.12]); // nose
  m.box('camera', [0.35, -0.11, 0], [0.1, 0.08, 0.08]);
  m.box('wing', [0.05, 0.06, 0], [0.28, 0.035, 2.4]); // main wing
  m.box('front', [0.12, 0.06, -1.15], [0.12, 0.04, 0.1]); // left tip (nav light)
  m.box('accent', [0.12, 0.06, 1.15], [0.12, 0.04, 0.1]); // right tip
  m.box('wing', [-0.62, 0.04, 0], [0.18, 0.025, 0.7]); // tail plane
  m.box('wing', [-0.64, 0.16, 0], [0.18, 0.22, 0.025]); // fin
  for (const z of [-0.45, 0.45]) {
    m.box('arm', [0, 0.04, z], [1.1, 0.04, 0.04]); // boom
    for (const x of [-0.5, 0.5]) {
      m.cylinder('motor', [x, 0.09, z], 0.035, 0.06);
      m.cylinder('prop', [x, 0.125, z], 0.23, 0.006, 28);
    }
  }
  m.cylinder('motor', [-0.72, 0, 0], 0.04, 0.05); // pusher hub (simplified)
  return m;
}

mkdirSync(out, { recursive: true });
const glb = toGlb(noseToPlusZ(vtol()), 'vtol');
writeFileSync(join(out, 'vtol.glb'), glb);
console.log(`vtol.glb ${glb.length} bytes`);
