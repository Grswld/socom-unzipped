import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial } from 'three';
import { buildGrid, DEFAULT_RIFLE, type CollisionOwner, type Grid, type GridParams, type WorldPoly } from '@s2u/scene';
import { Fire, type FireAim } from '../src/fire';
import { Effects } from '../src/effects';
import type { EffectData } from '../src/effectData';
import { GrenadeThrower } from '../src/grenade';
import { GRENADE_BITMAPS } from '../src/grenadeAssets';
import type { PlaySnapshot } from '../src/walk';
import { MarkClipper, markClipGeometry, markFrame, MARK_CLIP_MAX_TRIANGLES, TEMP_DECAL_TRIANGLES, type MarkFrame } from '../src/markClip';

/**
 * The mark clipped to the world under it, shaded per vertex (web/docs/research/89 §5 and §13): `FUN_003b3ab0` (decomp
 * 306491) takes each world triangle of the hit node's visuals that faces the round (its normal . the round's direction
 * below -0.01), whose three vertices lie within 4.8 units of the mark's plane and whose projected box meets the mark's
 * square (`FUN_003bf290`), and hands it to `FUN_003beca0` with its three vertices' own colour words. The viewer drew
 * one quad with one shade, so a mark hung past a stair's edge and stopped short at a corner.
 */

type V3 = [number, number, number];
type Rgba = [number, number, number, number];

/** A drawn mesh of quads (four corners each, CCW seen from the front), a colour per corner. */
function drawn(quads: { corners: V3[]; colours: Rgba[] }[]): Mesh {
  const positions: number[] = [], colours: number[] = [], index: number[] = [];
  for (const q of quads) {
    const base = positions.length / 3;
    q.corners.forEach((c, k) => { positions.push(...c); colours.push(...q.colours[k]!); });
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(Float32Array.from(positions), 3));
  g.setAttribute('color', new BufferAttribute(Float32Array.from(colours), 4));
  g.setIndex(index);
  return new Mesh(g, new MeshBasicMaterial());
}

const grey = (v: number): Rgba => [v, v, v, 1];
const flat4 = (v: number): Rgba[] => [grey(v), grey(v), grey(v), grey(v)];

function vertices(g: BufferGeometry): { p: V3; c: Rgba; uv: [number, number] }[] {
  const p = g.getAttribute('position'), c = g.getAttribute('color'), uv = g.getAttribute('uv');
  const index = g.getIndex()!;
  const used = new Set<number>();
  const end = Math.min(g.drawRange.start + g.drawRange.count, index.count);
  for (let i = g.drawRange.start; i < end; i++) used.add(index.getX(i));
  return [...used].map((i) => ({
    p: [p.getX(i), p.getY(i), p.getZ(i)],
    c: [c.getX(i), c.getY(i), c.getZ(i), c.getW(i)],
    uv: [uv.getX(i), uv.getY(i)],
  }));
}

/** The mark's drawn area, summed over its triangles. */
function area(g: BufferGeometry, keep: (centroid: V3) => boolean = () => true): number {
  const p = g.getAttribute('position'), index = g.getIndex()!;
  let sum = 0;
  const end = Math.min(g.drawRange.start + g.drawRange.count, index.count);
  for (let i = g.drawRange.start; i < end; i += 3) {
    const [a, b, c] = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
    const A: V3 = [p.getX(a), p.getY(a), p.getZ(a)], B: V3 = [p.getX(b), p.getY(b), p.getZ(b)], C: V3 = [p.getX(c), p.getY(c), p.getZ(c)];
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const cross = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const centroid: V3 = [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3, (A[2] + B[2] + C[2]) / 3];
    if (keep(centroid)) sum += Math.hypot(cross[0]!, cross[1]!, cross[2]!) / 2;
  }
  return sum;
}

function clipOnce(root: Group, frame: MarkFrame, lift = 0): { g: BufferGeometry; count: number; clipper: MarkClipper } {
  root.updateMatrixWorld(true);
  const clipper = new MarkClipper(root);
  const g = markClipGeometry();
  const count = clipper.clip(frame, g, lift);
  return { g, count, clipper };
}

describe('the mark clipped to the world triangles under it (FUN_003b3ab0)', () => {
  // A stair: the tread at y = 0 over x in [-10, 0], its riser at x = 0 falling to y = -6 (beyond the 4.8 reach).
  const tread = { corners: [[-10, 0, 10], [0, 0, 10], [0, 0, -10], [-10, 0, -10]] as V3[], colours: flat4(0.3) };
  const riser = { corners: [[0, 0, 10], [0, -6, 10], [0, -6, -10], [0, 0, -10]] as V3[], colours: flat4(0.3) };

  it('a mark on a stair\'s edge does not hang past the edge', () => {
    const root = new Group();
    root.add(drawn([tread, riser]));
    // Straight down, 0.4 units in from the edge, two units across: the square spans x -1.4 .. 0.6.
    const frame = markFrame([-0.4, 0, 0], [0, 1, 0], [0, -1, 0], 2);
    const { g, count } = clipOnce(root, frame);
    expect(count).toBeGreaterThan(0);
    const vs = vertices(g);
    expect(vs.length).toBeGreaterThan(0);
    for (const v of vs) {
      expect(v.p[0]).toBeLessThanOrEqual(1e-5);          // nothing past the edge
      expect(v.p[1]).toBeCloseTo(0, 5);                  // on the tread, not the riser (it does not face the round)
    }
    expect(area(g)).toBeCloseTo(2 * 1.4, 4);             // the square's part over the tread, all of it
  });

  it('a stair\'s lower step within reach takes the part past the edge, on its own surface', () => {
    const root = new Group();
    const lower = { corners: [[0, -1, 10], [10, -1, 10], [10, -1, -10], [0, -1, -10]] as V3[], colours: flat4(0.5) };
    const shortRiser = { corners: [[0, 0, 10], [0, -1, 10], [0, -1, -10], [0, 0, -10]] as V3[], colours: flat4(0.3) };
    root.add(drawn([tread, shortRiser, lower]));
    const { g } = clipOnce(root, markFrame([-0.4, 0, 0], [0, 1, 0], [0, -1, 0], 2));
    for (const v of vertices(g)) {
      if (v.p[0] > 1e-5) expect(v.p[1]).toBeCloseTo(-1, 5);  // past the edge: down on the lower step, not in the air
    }
    expect(area(g, (c) => c[1] < -0.5)).toBeCloseTo(2 * 0.6, 4);
  });

  it('a mark on a corner covers both faces', () => {
    // A floor at y = 0 meeting a wall at z = -10 facing +z, tessellated as a map is (two-unit quads: a big triangle
    // sloping away along the round reaches past 4.8 and is not kept, 306632); a round coming down into the corner at 45
    // degrees.
    const root = new Group();
    const floor = { corners: [[-1, 0, -8], [1, 0, -8], [1, 0, -10], [-1, 0, -10]] as V3[], colours: flat4(0.25) };
    const wall = { corners: [[-1, 0, -10], [1, 0, -10], [1, 2, -10], [-1, 2, -10]] as V3[], colours: flat4(0.5) };
    root.add(drawn([floor, wall]));
    const dir: V3 = [0, -Math.SQRT1_2, -Math.SQRT1_2];
    const { g } = clipOnce(root, markFrame([0, 0.3, -10], [0, 0, 1], dir, 2));
    const onWall = area(g, (c) => Math.abs(c[2] + 10) < 1e-4);
    const onFloor = area(g, (c) => Math.abs(c[1]) < 1e-4);
    expect(onWall).toBeGreaterThan(0.1);
    expect(onFloor).toBeGreaterThan(0.1);
    expect(onWall + onFloor).toBeCloseTo(area(g), 6);
    // The shade per face: the wall's vertices keep the wall's colour, the floor's the floor's.
    for (const v of vertices(g)) {
      if (Math.abs(v.p[2] + 10) < 1e-4 && v.p[1] > 1e-4) expect(v.c[0]).toBeCloseTo(0.5, 5);
      if (Math.abs(v.p[1]) < 1e-4 && v.p[2] > -10 + 1e-4) expect(v.c[0]).toBeCloseTo(0.25, 5);
    }
  });

  it('each clipped vertex takes the world\'s colour at that point, interpolated across its triangle', () => {
    // A wall facing +z whose colour runs linearly along x: r = 0.2 + 0.01 (x + 10); g along y.
    const root = new Group();
    const r = (x: number): number => 0.2 + 0.01 * (x + 10);
    const gy = (y: number): number => 0.1 + 0.02 * (y + 10);
    const corners: V3[] = [[-10, -10, 0], [10, -10, 0], [10, 10, 0], [-10, 10, 0]];
    root.add(drawn([{ corners, colours: corners.map(([x, y]) => [r(x), gy(y), 0.3, 1] as Rgba) }]));
    const frame = markFrame([1.3, -0.7, 0], [0, 0, 1], [0.3, 0.1, -1], 3);
    const { g, clipper } = clipOnce(root, frame);
    const vs = vertices(g);
    expect(vs.length).toBeGreaterThanOrEqual(4);
    for (const v of vs) {
      expect(v.c[0]).toBeCloseTo(r(v.p[0]), 5);
      expect(v.c[1]).toBeCloseTo(gy(v.p[1]), 5);
      expect(v.c[2]).toBeCloseTo(0.3, 5);
      expect(v.c[3]).toBeCloseTo(1, 5);
      // The uv is the point's place in the square (0..1), the square across the round's direction.
      expect(v.uv[0]).toBeGreaterThanOrEqual(-1e-5);
      expect(v.uv[0]).toBeLessThanOrEqual(1 + 1e-5);
      expect(v.uv[1]).toBeGreaterThanOrEqual(-1e-5);
      expect(v.uv[1]).toBeLessThanOrEqual(1 + 1e-5);
    }
    // The colour under the hit itself, for `lastShade`.
    expect(clipper.centreFound).toBe(true);
    expect(clipper.centre[0]).toBeCloseTo(r(1.3), 5);
    expect(clipper.centre[1]).toBeCloseTo(gy(-0.7), 5);
  });

  it('keeps only triangles facing the round, within 4.8 units of the mark\'s plane (decomp 306595, 306632)', () => {
    const root = new Group();
    // Facing away (CW seen from +z), and a facing one whose far corner is 5 units behind the plane.
    const away = { corners: [[-10, 10, 0], [10, 10, 0], [10, -10, 0], [-10, -10, 0]] as V3[], colours: flat4(0.5) };
    root.add(drawn([away]));
    expect(clipOnce(root, markFrame([0, 0, 0], [0, 0, 1], [0, 0, -1], 2)).count).toBe(0);
    // A facing slope whose vertices reach depth/2 either side of the mark's plane: kept at 4.7, not at 5 (306632).
    const slope = (depth: number): number => {
      const g = new Group();
      g.add(drawn([{ corners: [[-1, -1, 0], [1, -1, 0], [1, 1, -depth], [-1, 1, -depth]], colours: flat4(0.5) }]));
      return clipOnce(g, markFrame([0, 0, -depth / 2], [0, 0, 1], [0, 0, -1], 1)).count;
    };
    expect(slope(9.4)).toBe(2);
    expect(slope(10)).toBe(0);
  });

  it('reads instanced props through each instance\'s matrix, and skips hidden draws', () => {
    const root = new Group();
    const prop = drawn([{ corners: [[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]], colours: flat4(0.4) }]);
    const instanced = new InstancedMesh(prop.geometry, prop.material, 2);
    instanced.setMatrixAt(0, new Matrix4().makeTranslation(20, 0, 0));
    instanced.setMatrixAt(1, new Matrix4().makeTranslation(0, 0, -3));
    const hidden = drawn([{ corners: [[-5, -5, -1], [5, -5, -1], [5, 5, -1], [-5, 5, -1]], colours: flat4(0.9) }]);
    hidden.visible = false;
    root.add(instanced, hidden);
    const { g, count } = clipOnce(root, markFrame([0, 0, -3], [0, 0, 1], [0, 0, -1], 1));
    expect(count).toBe(2);
    for (const v of vertices(g)) { expect(v.p[2]).toBeCloseTo(-3, 5); expect(v.c[0]).toBeCloseTo(0.4, 5); }
  });

  it('lifts the mark off the surface toward the round, and builds into the same buffers each time', () => {
    const root = new Group();
    root.add(drawn([{ corners: [[-10, -10, 0], [10, -10, 0], [10, 10, 0], [-10, 10, 0]], colours: flat4(0.5) }]));
    root.updateMatrixWorld(true);
    const clipper = new MarkClipper(root);
    const g = markClipGeometry();
    const position = g.getAttribute('position') as BufferAttribute;
    clipper.clip(markFrame([0, 0, 0], [0, 0, 1], [0, 0, -1], 2), g, 0.05);
    for (const v of vertices(g)) expect(v.p[2]).toBeCloseTo(0.05, 6);
    const version = position.version;
    clipper.clip(markFrame([3, 0, 0], [0, 0, 1], [0, 0, -1], 2), g, 0.05);
    expect(g.getAttribute('position')).toBe(position);   // no new attribute: the same buffers, marked for upload
    expect(position.version).toBeGreaterThan(version);
    expect(MARK_CLIP_MAX_TRIANGLES).toBeGreaterThanOrEqual(16);
  });
});

describe('a round\'s mark is clipped to the drawn world (Fire.setClip)', () => {
  const quad = (points: number[]): WorldPoly =>
    ({ modelName: 'worldmodel', path: 'worldmodel/q', region: 0, ditype: 2, material: 25, ptcount: 4, cameratype: 0, points: Float32Array.from(points) });
  function grid(): Grid {
    const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 4, cellsZ: 4, originX: -200, originZ: -200 };
    const polys = [quad([-50, 0, -30, 50, 0, -30, 50, 50, -30, -50, 50, -30])];
    const owners: CollisionOwner[] = [{ modelName: 'worldmodel', path: 'worldmodel/q0', first: 0, count: 1 }];
    return buildGrid(params, [], [], polys, owners);
  }
  const aim = (): FireAim => ({ eye: [0, 20, 0], far: [0, 20, -1000] });

  it('the mark\'s mesh is the clip, its lastShade the colour under the hit; a wall drawn late is clipped a frame later', () => {
    const g = grid();
    // The drawn wall stops at x = 0.2: a mark at x = 0 must not hang past it.
    const root = new Group();
    const wallMesh = drawn([{ corners: [[-50, 0, -30], [0.2, 0, -30], [0.2, 50, -30], [-50, 50, -30]], colours: flat4(0.28) }]);
    root.add(wallMesh);
    root.updateMatrixWorld(true);
    const fire = new Fire({ grid: () => g, aim }, DEFAULT_RIFLE, undefined, () => 0.5);
    fire.setClip(new MarkClipper(root));
    fire.shoot();
    const mark = fire.decalMeshes()[0]!;
    const vs = vertices(mark.geometry);
    expect(vs.length).toBeGreaterThan(0);
    for (const v of vs) { expect(v.p[0]).toBeLessThanOrEqual(0.2 + 1e-5); expect(v.c[0]).toBeCloseTo(0.28, 5); }
    expect(fire.state().lastShade![0]).toBeCloseTo(0.28, 5);

    wallMesh.visible = false;
    const late = new Fire({ grid: () => g, aim }, DEFAULT_RIFLE, undefined, () => 0.5);
    late.setClip(new MarkClipper(root));
    late.shoot();
    expect(late.decalMeshes()[0]!.visible).toBe(true);    // the bare square until the wall is drawn
    wallMesh.visible = true;
    late.update(1 / 60);
    for (const v of vertices(late.decalMeshes()[0]!.geometry)) expect(v.p[0]).toBeLessThanOrEqual(0.2 + 1e-5);
  });

  it('the temporary pool counts triangles, as the game\'s (one entry a world triangle, TEMP_DECAL_POOL BASE 150)', () => {
    const g = grid();
    const root = new Group();
    // The drawn wall's quad split along its diagonal, which runs through the hit (0, 20): every mark takes both halves.
    root.add(drawn([{ corners: [[-20, 0, -30], [20, 0, -30], [20, 40, -30], [-20, 40, -30]], colours: flat4(0.3) }]));
    root.updateMatrixWorld(true);
    const fire = new Fire({ grid: () => g, aim }, { ...DEFAULT_RIFLE, magazine: 200 }, undefined, () => 0.5);
    fire.setClip(new MarkClipper(root));
    for (let i = 0; i < 100; i++) { expect(fire.shoot()).not.toBeNull(); fire.update(DEFAULT_RIFLE.fireWait); }
    expect(TEMP_DECAL_TRIANGLES).toBe(150);
    // The diagonal of the wall's quad runs through (0, 20): each mark lies on both triangles.
    expect(fire.state().decals).toBe(75);
  });
});

describe('the footprint and the grenade\'s scorch are clipped the same way (FUN_003139e0, research 89 §13)', () => {
  // A tread of sand at y = 0 ending at x = 0.5, its riser falling past reach: a footprint at x = 0 is 3.5 across.
  const tread = (): Group => {
    const root = new Group();
    root.add(drawn([{ corners: [[-10, 0, 10], [0.5, 0, 10], [0.5, 0, -10], [-10, 0, -10]], colours: [grey(0.2), grey(0.6), grey(0.6), grey(0.2)] }]));
    root.updateMatrixWorld(true);
    return root;
  };
  const texture = { rgba: { width: 1, height: 1, data: new Uint8ClampedArray([100, 100, 100, 128]) }, gs: null };
  const data = (): EffectData => ({
    archive: 'T', programs: [], models: [], textures: [['fp.tif', texture]], absent: [], materials: ['UNKNOWN', 'PARTICLE_SYSTEM', 'SAND'],
    defaultMaterial: 0, marks: [], footprints: [['SAND', 'fp.tif']], ambient: [], sceneNodes: [], hitAnims: [], missing: [],
  });

  it('a footprint over a step\'s edge stops at the edge, each vertex the ground\'s colour there', () => {
    const fx = new Effects(() => 0.5);
    fx.setData(data());
    fx.setClip(new MarkClipper(tread()));
    expect(fx.footfall([0, 0, 0], 2, [0, 1, 0], [0, 0, -1], false)).toBe(true);
    const vs = vertices(fx.footprintMeshes()[0]!.geometry);
    expect(vs.length).toBeGreaterThan(0);
    for (const v of vs) {
      expect(v.p[0]).toBeLessThanOrEqual(0.5 + 1e-5);
      expect(v.c[0]).toBeCloseTo(0.2 + 0.4 * (v.p[0] + 10) / 10.5, 5);
    }
    expect(vs.some((v) => Math.abs(v.p[0] - 0.5) < 1e-5)).toBe(true);   // cut at the edge, not short of it
  });

  it('a grenade\'s scorch over a step\'s edge stops at the edge, each vertex the ground\'s colour there', () => {
    const grid: Grid = (() => {
      const poly: WorldPoly = {
        modelName: 'worldmodel', path: 'worldmodel/f', region: 0, ditype: 3, material: 7, ptcount: 4, cameratype: 0,
        points: Float32Array.from([-2000, 0, -2000, 2000, 0, -2000, 2000, 0, 2000, -2000, 0, 2000]),
      };
      const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 500, cellsX: 8, cellsZ: 8, originX: -2000, originZ: -2000 };
      return buildGrid(params, [], [], [poly], [{ modelName: 'worldmodel', path: 'worldmodel/f0', first: 0, count: 1 }]);
    })();
    const snap = (): PlaySnapshot => ({
      feet: [-2, 0, 8], yaw: 0, pitch: 0, vx: 0, vz: 0, vy: 0, airborne: false, crouched: false, stance: 'stand', landing: null, jumps: 0,
    } as PlaySnapshot);
    const g = new GrenadeThrower({ grid: () => grid, snapshot: snap, view: () => 'third', handPoint: () => [0, 12, 0] });
    g.setMap(null, { models: [], bitmaps: { [GRENADE_BITMAPS.scorch]: { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(128) } }, defaultMaterial: '' });
    g.setClip(new MarkClipper(tread()));
    g.select('Claymore');
    g.pull();
    for (let t = 0; t < 1.5; t += 1 / 60) g.update(1 / 60);
    expect(g.detonateCharges()).toBe(1);
    for (let t = 0; t < 0.1; t += 1 / 60) g.update(1 / 60);
    expect(g.scorchMeshes()).toHaveLength(1);
    const vs = vertices(g.scorchMeshes()[0]!.geometry);
    expect(vs.length).toBeGreaterThan(0);
    for (const v of vs) {
      expect(v.p[0]).toBeLessThanOrEqual(0.5 + 1e-5);
      expect(v.c[0]).toBeCloseTo(0.2 + 0.4 * (v.p[0] + 10) / 10.5, 5);
    }
    expect(vs.some((v) => Math.abs(v.p[0] - 0.5) < 1e-5)).toBe(true);   // cut at the edge, not short of it
    expect(g.stats().scorchShade).not.toBeNull();
  });
});
