import { bench, describe } from 'vitest';
import { BufferAttribute, BufferGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial } from 'three';
import { MarkClipper, markClipGeometry, markFrame, type MarkFrame } from '../src/markClip';

/**
 * A mark's build time on a map-sized world (research 89 §13; the target: well under 0.2 ms a mark). The world as
 * `./world` draws it: a mesh per texture spanning the whole map (`frustumCulled` off), here 96 of them sharing a
 * 1024 x 1024 ground of 4-unit quads over rolling heights (131k triangles), each quad's texture at random; and 300
 * props, 200 single placements and 4 instanced models of 25, each a 24-triangle box. The rounds land on the ground
 * from a shooter 30 units off, at random over the map. Every geometry's index is built before the timing (a mark's
 * first look at a geometry builds it: reported apart, below).
 */

const SIZE = 1024, STEP = 4, TEXTURES = 96;
const height = (x: number, z: number): number => 6 * Math.sin(x / 37) * Math.cos(z / 53) + 2 * Math.sin((x + z) / 11);

function world(): Group {
  const root = new Group();
  let seed = 12345;
  const random = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const parts: { p: number[]; c: number[] }[] = Array.from({ length: TEXTURES }, () => ({ p: [], c: [] }));
  for (let x = 0; x < SIZE; x += STEP) {
    for (let z = 0; z < SIZE; z += STEP) {
      const part = parts[Math.floor(random() * TEXTURES)]!;
      const q = [[x, z + STEP], [x + STEP, z + STEP], [x + STEP, z], [x, z]];
      // CCW seen from above: (x, z+s), (x+s, z+s), (x+s, z); (x, z+s), (x+s, z), (x, z).
      for (const k of [0, 1, 2, 0, 2, 3]) {
        const [px, pz] = q[k]!;
        part.p.push(px!, height(px!, pz!), pz!);
        const v = 0.2 + 0.1 * Math.sin(px! / 13);
        part.c.push(v, v, v, 1);
      }
    }
  }
  for (const part of parts) {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(Float32Array.from(part.p), 3));
    g.setAttribute('color', new BufferAttribute(Float32Array.from(part.c), 4));
    const mesh = new Mesh(g, new MeshBasicMaterial());
    mesh.frustumCulled = false;
    root.add(mesh);
  }
  const box = (): BufferGeometry => {
    const g = new BufferGeometry();
    const p: number[] = [], c: number[] = [], index: number[] = [];
    const faces: [number, number, number][][] = [
      [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]],
      [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]], [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]],
      [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]],
    ];
    for (const f of faces) {
      // Each face as two 2x2 quads' worth: four triangles.
      const b = p.length / 3;
      for (const v of f) { p.push(v[0] * 3, v[1] * 3 + 3, v[2] * 3); c.push(0.4, 0.4, 0.4, 1); }
      index.push(b, b + 1, b + 2, b, b + 2, b + 3, b, b + 1, b + 2, b, b + 2, b + 3);
    }
    g.setAttribute('position', new BufferAttribute(Float32Array.from(p), 3));
    g.setAttribute('color', new BufferAttribute(Float32Array.from(c), 4));
    g.setIndex(index);
    return g;
  };
  const material = new MeshBasicMaterial();
  for (let i = 0; i < 200; i++) {
    const m = new Mesh(box(), material);
    m.name = `prop${i % 20}`;
    const x = random() * SIZE, z = random() * SIZE;
    m.position.set(x, height(x, z), z);
    root.add(m);
  }
  for (let k = 0; k < 4; k++) {
    const inst = new InstancedMesh(box(), material, 25);
    inst.name = `crate${k}`;
    for (let i = 0; i < 25; i++) {
      const x = random() * SIZE, z = random() * SIZE;
      inst.setMatrixAt(i, new Matrix4().makeTranslation(x, height(x, z), z));
    }
    root.add(inst);
  }
  root.updateMatrixWorld(true);
  return root;
}

const root = world();
const clipper = new MarkClipper(root);
const target = markClipGeometry();
const frames: MarkFrame[] = [];
{
  let seed = 777;
  const random = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 512; i++) {
    const x = 20 + random() * (SIZE - 40), z = 20 + random() * (SIZE - 40);
    const y = height(x, z);
    const eye = [x - 30, y + 18, z - 10];
    const d = [x - eye[0]!, y - eye[1]!, z - eye[2]!];
    const l = Math.hypot(d[0]!, d[1]!, d[2]!);
    frames.push(markFrame([x, y, z], [0, 1, 0], [d[0]! / l, d[1]! / l, d[2]! / l], 1 + random() * 2.4));
  }
}

// The first look at every geometry: the index built (the cost a map's first marks pay).
const cold = performance.now();
for (let x = 8; x < SIZE; x += 64) for (let z = 8; z < SIZE; z += 64) clipper.clip(markFrame([x, height(x, z), z], [0, 1, 0], [0, -1, 0], 2), target, 0.05);
console.log(`markClip: indexing ${TEXTURES} world meshes + props on first reach took ${(performance.now() - cold).toFixed(1)} ms in all`);

{
  let sum = 0, empty = 0;
  for (const f of frames) { const k = clipper.clip(f, target, 0.05); sum += k; if (k === 0) empty++; }
  console.log(`markClip: ${frames.length} marks, ${(sum / frames.length).toFixed(2)} world triangles kept a mark, ${empty} empty`);
}

let next = 0, kept = 0, marks = 0;
describe('a mark clipped to a map-sized drawn world', () => {
  bench('one mark (MarkClipper.clip)', () => {
    kept += clipper.clip(frames[next]!, target, 0.05);
    marks++;
    next = (next + 1) % frames.length;
  }, { time: 1500, warmupTime: 300 });
});
