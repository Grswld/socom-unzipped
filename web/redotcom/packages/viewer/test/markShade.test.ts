import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicMaterial, OneMinusSrcAlphaFactor, SrcAlphaFactor } from 'three';
import type { Node } from 'three/webgpu';
import { buildGrid, DEFAULT_RIFLE, type CollisionOwner, type Grid, type GridParams, type WorldPoly } from '@s2u/scene';
import type { GsState } from '@s2u/gs';
import { markMaterial } from '../src/effectMaterials';
import { Fire, type FireAim } from '../src/fire';
import { MARK_DEPTH, surfaceShade } from '../src/surfaceShade';

/**
 * The bullet mark's shade (web/redotcom/docs/research/89 §5, "the mark's colour"): the game draws a mark with the vertex colour
 * of the world polygon it lies on -- `FUN_003beca0` (decomp 313065) unpacks each clipped vertex's own 32-bit colour
 * (`V4-8`, the world vertex's `+0x3c` word, `FUN_003b3ab0` 306470) into the packet the world's VU program draws -- so
 * the GS modulates the mark's texel by the same baked light the wall under it gets. The viewer drew the bitmap bare
 * (texel x 1.0) on walls whose mean vertex colour is 0.25-0.29 of unity (Frostfire, Desert Glory): a mark three to
 * four times lighter than the game's.
 */

type V3 = [number, number, number];

/** A wall across x at depth z = -30 facing +z, its vertex colours `rgba` per corner (4 floats each, 1.0 = 0x80). */
function wall(colours: number[][]): Mesh {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(Float32Array.from([-50, 0, -30, 50, 0, -30, 50, 50, -30, -50, 50, -30]), 3));
  g.setAttribute('color', new BufferAttribute(Float32Array.from(colours.flat()), 4));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return new Mesh(g, new MeshBasicMaterial());
}

const GS_SOURCE: GsState = {
  blend: 'source', alphaTest: null, depthTest: true, bilinear: true, mipmaps: false, levels: 0, lodK: 0, lodL: 0,
  wrapS: 'clamp', wrapT: 'clamp',
} as GsState;

describe('the world\'s drawn colour under a mark (surfaceShade)', () => {
  it('reads the wall\'s vertex colour at the point, interpolated across its triangle', () => {
    const root = new Group();
    root.add(wall([[0.25, 0.25, 0.25, 1], [0.75, 0.25, 0.25, 1], [0.75, 0.25, 0.25, 1], [0.25, 0.25, 0.25, 1]]));
    root.updateMatrixWorld(true);
    const shade = surfaceShade(root);
    const mid = shade([0, 20, -30], [0, 0, 1])!;
    expect(mid[0]).toBeCloseTo(0.5, 6);                 // halfway along x: between 0.25 and 0.75
    expect(mid[1]).toBeCloseTo(0.25, 6);
    expect(mid[3]).toBeCloseTo(1, 6);
    expect(shade([0, 20, 40], [0, 0, 1])).toBeNull();   // nothing drawn under the point
  });

  it('ignores a hidden draw in front and anything without vertex colours', () => {
    const root = new Group();
    const hidden = wall([[1, 0, 0, 1], [1, 0, 0, 1], [1, 0, 0, 1], [1, 0, 0, 1]]);
    hidden.position.z = 0.02;
    hidden.visible = false;
    root.add(hidden, wall([[0.3, 0.3, 0.3, 1], [0.3, 0.3, 0.3, 1], [0.3, 0.3, 0.3, 1], [0.3, 0.3, 0.3, 1]]));
    root.updateMatrixWorld(true);
    expect(surfaceShade(root)([0, 20, -30], [0, 0, 1])![0]).toBeCloseTo(0.3, 6);
  });

  it('takes the base surface under a blended overlay, and a drawn surface up to 4.8 units off the hull (decomp 306632-306635)', () => {
    const root = new Group();
    const overlay = wall([[0.9, 0.9, 0.9, 0.04], [0.9, 0.9, 0.9, 0.04], [0.9, 0.9, 0.9, 0.04], [0.9, 0.9, 0.9, 0.04]]);
    (overlay.material as MeshBasicMaterial).transparent = true;
    overlay.position.z = 0.01;
    const base = wall([[0.2, 0.2, 0.2, 1], [0.2, 0.2, 0.2, 1], [0.2, 0.2, 0.2, 1], [0.2, 0.2, 0.2, 1]]);
    root.add(overlay, base);
    root.updateMatrixWorld(true);
    expect(surfaceShade(root)([0, 20, -30], [0, 0, 1])).toEqual([0.2, 0.2, 0.2, 1].map((v) => expect.closeTo(v, 6)));
    expect(MARK_DEPTH).toBe(4.8);
    // The hull's face 4 units in front of the drawn wall: the probe still reaches it; 6 units, it does not.
    expect(surfaceShade(root)([0, 20, -26], [0, 0, 1])![0]).toBeCloseTo(0.2, 6);
    expect(surfaceShade(root)([0, 20, -24], [0, 0, 1])).toBeNull();
  });

  it('of a terrain\'s coplanar layers takes the most opaque (Vigilance: ground_grassy.tif fading over cobble_road.tif)', () => {
    const root = new Group();
    const fading = wall([[0.17, 0.14, 0.14, 0.03], [0.17, 0.14, 0.14, 0.03], [0.17, 0.14, 0.14, 0.03], [0.17, 0.14, 0.14, 0.03]]);
    const road = wall([[0.4, 0.35, 0.3, 1], [0.4, 0.35, 0.3, 1], [0.4, 0.35, 0.3, 1], [0.4, 0.35, 0.3, 1]]);
    root.add(fading, road);
    root.updateMatrixWorld(true);
    expect(surfaceShade(root)([0, 20, -30], [0, 0, 1])).toEqual([0.4, 0.35, 0.3, 1].map((v) => expect.closeTo(v, 6)));
  });
});

describe('the mark\'s GS arithmetic (markMaterial)', () => {
  it('modulates the texel by the vertex colour, blended source alpha over, no depth write', () => {
    const tex = { rgba: { width: 1, height: 1, data: new Uint8ClampedArray([160, 160, 160, 163]) }, gs: GS_SOURCE };
    const m = markMaterial(tex);
    const types = new Set<string>();
    const seen = new Set<unknown>();
    const walk = (node: Node | null): void => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      types.add((node.constructor as { type?: string }).type ?? '');
      for (const child of node.getChildren()) walk(child as Node);
    };
    walk(m.colorNode as Node);
    expect(types.has('VertexColorNode')).toBe(true);    // Ct x Cv: the mark takes the surface's baked light
    expect([m.blendSrc, m.blendDst, m.transparent, m.depthWrite]).toEqual([SrcAlphaFactor, OneMinusSrcAlphaFactor, true, false]);
  });
});

describe('a round\'s mark carries the surface\'s colour (Fire.setShade)', () => {
  const quad = (points: number[]): WorldPoly =>
    ({ modelName: 'worldmodel', path: 'worldmodel/q', region: 0, ditype: 2, material: 25, ptcount: 4, cameratype: 0, points: Float32Array.from(points) });
  function grid(): Grid {
    const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 4, cellsZ: 4, originX: -200, originZ: -200 };
    const polys = [quad([-50, 0, -30, 50, 0, -30, 50, 50, -30, -50, 50, -30])];
    const owners: CollisionOwner[] = [{ modelName: 'worldmodel', path: 'worldmodel/q0', first: 0, count: 1 }];
    return buildGrid(params, [], [], polys, owners);
  }
  const eye: V3 = [0, 20, 0];
  const aim = (): FireAim => ({ eye, far: [0, 20, -1000] });

  it('every corner of the mark takes the colour under the hit; unity without a shade', () => {
    const g = grid();
    const asked: V3[] = [];
    const fire = new Fire({ grid: () => g, aim }, DEFAULT_RIFLE, undefined, () => 0.5);
    fire.setShade((point) => { asked.push(point); return [0.28, 0.27, 0.26, 1]; });
    fire.shoot();
    expect(asked[0]).toEqual([0, 20, -30]);
    const colour = fire.decalMeshes()[0]!.geometry.getAttribute('color');
    expect(colour.itemSize).toBe(4);
    for (let i = 0; i < colour.count; i++) {
      expect([colour.getX(i), colour.getY(i), colour.getZ(i), colour.getW(i)].map((v) => +v.toFixed(6))).toEqual([0.28, 0.27, 0.26, 1]);
    }

    // A wall not drawn yet when the round lands (the props stream in after the map shows): asked again each frame.
    let drawn = false;
    const late = new Fire({ grid: () => g, aim }, DEFAULT_RIFLE, undefined, () => 0.5);
    late.setShade(() => (drawn ? [0.4, 0.4, 0.4, 1] : null));
    late.shoot();
    const waiting = late.decalMeshes()[0]!.geometry.getAttribute('color');
    expect(waiting.getX(0)).toBe(1);
    late.update(1 / 60);
    expect(waiting.getX(0)).toBe(1);
    drawn = true;
    late.update(1 / 60);
    expect(waiting.getX(0)).toBeCloseTo(0.4, 6);

    const bare = new Fire({ grid: () => g, aim }, DEFAULT_RIFLE, undefined, () => 0.5);
    bare.shoot();
    const unity = bare.decalMeshes()[0]!.geometry.getAttribute('color');
    expect([unity.getX(0), unity.getY(0), unity.getZ(0), unity.getW(0)]).toEqual([1, 1, 1, 1]);
  });
});

describe('an effect light\'s overlay is not a surface (research 89 §10)', () => {
  it('surfaceShade reads no colour off a draw flagged effectLightPass', () => {
    const root = new Group();
    const overlay = wall([[1, 0, 0, 1], [1, 0, 0, 1], [1, 0, 0, 1], [1, 0, 0, 1]]);
    overlay.userData.effectLightPass = true;
    root.add(overlay);
    root.updateMatrixWorld(true);
    expect(surfaceShade(root)([0, 20, -30], [0, 0, 1])).toBeNull();
    const base = wall([[0.25, 0.25, 0.25, 1], [0.25, 0.25, 0.25, 1], [0.25, 0.25, 0.25, 1], [0.25, 0.25, 0.25, 1]]);
    root.add(base);
    root.updateMatrixWorld(true);
    expect(surfaceShade(root)([0, 20, -30], [0, 0, 1])![0]).toBeCloseTo(0.25, 6);
  });
});
