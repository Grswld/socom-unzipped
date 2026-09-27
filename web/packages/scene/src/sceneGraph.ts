import { Reader, type Zar, type ZarKey } from '@s2u/archive';

/**
 * The scene graph of one map: `MP*_GEO.ZED`'s `models` tree, as `CNode::Read` reads it
 * (`research/recom/src/gamez/zNode/node_io.cpp:251-320`, 36 section 2), plus the matrix algebra the
 * engine places it with.
 *
 * Every offset below is 36 section 2 (`nparams`, `model_name`, `regionmask`, `visuals`, `di`,
 * `children`) or 36 section 6 (the `di` params word), and every convention names its source.
 */

/** 36 section 2 / `tag_NODE_PARAMS` (`zNode/znode.h:73-105`): 64 B matrix, 24 B bbox, u32 type, u32 flags. */
const NPARAMS_SIZE = 96;
const MATRIX_AT = 0, MATRIX_FLOATS = 16;
const BBOX_AT = 64, BBOX_FLOATS = 6;                 // CBBox is two CPnt3D (`zMath/zmath.h:253-258`)
const TYPE_AT = 88, FLAGS_AT = 92;

/** `CNode::TYPE` (`zNode/znode.h:138-151`). An instance node is the one that names another model. */
export const NODE_EMPTY = 0, NODE_GENERIC = 1, NODE_INSTANCE = 2, NODE_MODEL = 7, NODE_LIGHT = 8;

/**
 * `tag_NODE_PARAMS`'s flag word (`zNode/znode.h:73-105`), the bits a renderer reads. The EE emits the
 * VU1 light command for a visual only when its node, or the model node it instances, sets
 * `m_dynamic_motion` or `m_dynamic_light` (`FUN_003b6d10`, decomp 308333-308357); every other node is
 * drawn from its baked vertex colours. `m_fog` is set on every drawn node of every map, and `m_landmark`
 * marks the skies, moons and stars, which `TestLandmarkFOG` fogs on its own terms.
 */
export const NODE_FLAG_DYNAMIC_MOTION = 1 << 1, NODE_FLAG_DYNAMIC_LIGHT = 1 << 2, NODE_FLAG_LANDMARK = 1 << 3,
  NODE_FLAG_PRELIGHT = 1 << 5, NODE_FLAG_FOG = 1 << 6;
/** The two bits that ask for the light command, on the node or on the model it instances. */
export const NODE_FLAGS_LIT = NODE_FLAG_DYNAMIC_MOTION | NODE_FLAG_DYNAMIC_LIGHT;
/** `vparams` word 0, bit 3: the visual is drawn with VU1's backface cull (see `SceneNode.visualParams`). */
export const VISUAL_FLAG_CULL = 1 << 3;
/**
 * `m_facade`, bits 8-9 of the node flags: the node is turned to face the camera every frame
 * (`CNode::ComputeFacadeMatrix`, called from `CPipe::RenderNode`). 0 on all but 41 nodes across the
 * 22 maps: the lamp flares, the stars, the moon and the sun. Two values occur, 1 (stars, moon, the
 * `g*` flare quads) and 2 (the `flare*` nodes, the sun); reCOM's `ComputeFacadeMatrix` is a stub, so
 * what distinguishes them is not known and both are drawn facing the camera.
 */
export const facadeOf = (flags: number): number => (flags >>> 8) & 3;

/** 36 section 6 / `CDI::Read` (`zIntersect/int_main.cpp:52-67`): 12-byte params, then 16 B per point. */
const DI_PARAMS_SIZE = 12, DI_POINT_SIZE = 16;
const DI_REGION_AT = 0, DI_REFCOUNT_AT = 4, DI_PACKED_AT = 8;

/** One convex collision polygon of a node, its points in that node's model space (36 section 6). */
export interface CollisionPoly {
  region: number;
  /** `m_refcount`; 0x2d in every polygon of all five maps (36 section 6). */
  refcount: number;
  ditype: number;
  ptcount: number;
  material: number;
  cameratype: number;
  appflags: number;
  inside: number;
  shadow: number;
  /** xyz per point, model space: the stored `CPnt4D`'s `w` is unused and dropped (36 section 6). */
  points: Float32Array;
}

/** One node of `MP*_GEO.ZED`'s `models` tree. */
export interface SceneNode {
  /** The archive key's name: the model's name for a prototype, the node's for everything below. */
  name: string;
  /** The model this node instances, or null: only `m_type == INSTANCE` nodes carry one (36 section 2). */
  modelName: string | null;
  /** `tag_NODE_PARAMS.m_type`, one of the `NODE_*` constants. */
  type: number;
  /** `tag_NODE_PARAMS`'s flag word, `m_active` in bit 0 (`zNode/znode.h:78-105`). */
  flags: number;
  /** 16 floats, 4 rows of 4, row-vector convention exactly as stored (24 section 1.1). */
  matrix: Float32Array;
  /** 6 floats: min xyz then max xyz. */
  bbox: Float32Array;
  /** The optional `regionmask` key, 0 when absent. */
  regionmask: number;
  /** How many `visuals/vis` children the node has: one drawn chunk each (36 section 2). */
  visuals: number;
  /**
   * The first word of each visual's `vparams` (`tag_VIS_PARAMS`, `zVisual/zvis.h:85-96`), one per
   * `visuals/vis` child in order. Bit 3 is the one a renderer needs: the EE emits VU1's backface-cull
   * command for a visual only when it is set (`FUN_003b5f20`, `flags & 8`), and across the maps it is
   * clear on exactly the things drawn from both sides -- ladders, grates, fan blades, foliage, grass,
   * rugs, glow quads -- and set on solid objects. `VISUAL_FLAG_CULL` names it.
   */
  visualParams: number[];
  children: SceneNode[];
  collision: CollisionPoly[];
}

/** The 4x4 identity, row-major. */
export const IDENTITY: Float32Array = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * `local x parent`, both row-major, the engine's row-vector convention (24 section 1.1, `FUN_001BFC30`):
 * a point is a row vector on the left, so a child's matrix is applied before its parent's.
 */
export function multiply(local: Float32Array, parent: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += local[row * 4 + k]! * parent[k * 4 + col]!;
      out[row * 4 + col] = sum;
    }
  }
  return out;
}

/** A point through a row-major row-vector matrix: `[x y z 1] x m`, the translation being its fourth row. */
export function transformPoint(m: Float32Array, x: number, y: number, z: number): [number, number, number] {
  return [
    x * m[0]! + y * m[4]! + z * m[8]! + m[12]!,
    x * m[1]! + y * m[5]! + z * m[9]! + m[13]!,
    x * m[2]! + y * m[6]! + z * m[10]! + m[14]!,
  ];
}

/**
 * The one conversion on the way out, and the surprise in it: **it copies**.
 *
 * The engine multiplies row vectors on the left (`p x M`), so three.js, which multiplies column vectors
 * on the right, needs `M` transposed: `E = M^T`. But the two also disagree about storage -- the engine's
 * 64 bytes are four rows (`CMatrix::m_matrix[4][4]` in C, and `GetTranslate` returns row 3,
 * `zMath/zmath_matrix.cpp:36-38`), while `Matrix4.elements` is column-major. Writing both out:
 * `elements[c*4+r] = E[r][c] = M[c][r] = m[c*4+r]`. The transpose and the layout flip cancel exactly, so
 * the stored floats are already three.js's `elements` -- translation at 12, 13, 14 in both.
 *
 * It is still a function and still called once, because the reasoning is the part worth keeping: change
 * either convention and this is where the transpose reappears.
 */
export function toColumnMajor(m: Float32Array): Float32Array {
  return Float32Array.from(m);
}

/** The `models` children of a map's `MP*_GEO.ZED`, recursed: 46 prototypes on Frostfire. */
export function parseSceneGraph(geo: Zar): SceneNode[] {
  const models = geo.find('models');
  if (!models) throw new Error('GEO archive has no models key');
  return models.children.map((child) => readNode(geo, child));
}

function readNode(geo: Zar, key: ZarKey): SceneNode {
  const nparams = geo.child(key, 'nparams');
  if (!nparams || nparams.size !== NPARAMS_SIZE) {
    throw new Error(`node ${key.name}: nparams is ${nparams ? `${nparams.size} bytes` : 'absent'}, expected ${NPARAMS_SIZE}`);
  }
  const r = new Reader(geo.data(nparams));
  const matrix = new Float32Array(MATRIX_FLOATS);
  for (let i = 0; i < MATRIX_FLOATS; i++) matrix[i] = r.f32(MATRIX_AT + i * 4);
  const bbox = new Float32Array(BBOX_FLOATS);
  for (let i = 0; i < BBOX_FLOATS; i++) bbox[i] = r.f32(BBOX_AT + i * 4);

  const modelNameKey = geo.child(key, 'model_name');
  const regionmaskKey = geo.child(key, 'regionmask');
  const visuals = geo.child(key, 'visuals');
  const di = geo.child(key, 'di');
  const children = geo.child(key, 'children');

  return {
    name: key.name,
    modelName: modelNameKey ? new Reader(geo.data(modelNameKey)).cstr(0, modelNameKey.size) : null,
    type: r.u32(TYPE_AT),
    flags: r.u32(FLAGS_AT),
    matrix,
    bbox,
    regionmask: regionmaskKey && regionmaskKey.size >= 4 ? new Reader(geo.data(regionmaskKey)).u32(0) : 0,
    visuals: visuals ? visuals.children.length : 0,
    visualParams: (visuals?.children ?? []).map((v) => {
      const vp = geo.child(v, 'vparams');
      return vp && vp.size >= 4 ? new Reader(geo.data(vp)).u32(0) : 0;
    }),
    children: children ? children.children.map((c) => readNode(geo, c)) : [],
    collision: di ? di.children.map((d) => readPoly(geo, d, key.name)) : [],
  };
}

/**
 * 36 section 6: `params` is 12 bytes -- region, refcount, then one packed word. The normal that
 * `DI_PARAMS` starts with in memory is not on disc; it is derived at load.
 */
function readPoly(geo: Zar, key: ZarKey, node: string): CollisionPoly {
  const params = geo.child(key, 'params');
  const points = geo.child(key, 'points');
  if (!params || params.size !== DI_PARAMS_SIZE) {
    throw new Error(`${node}/di/${key.name}: params is ${params ? `${params.size} bytes` : 'absent'}, expected ${DI_PARAMS_SIZE}`);
  }
  if (!points) throw new Error(`${node}/di/${key.name}: no points key`);
  const p = new Reader(geo.data(params));
  const packed = p.u32(DI_PACKED_AT);
  const ptcount = (packed >>> 2) & 0xff;
  if (ptcount * DI_POINT_SIZE !== points.size) {
    throw new Error(`${node}/di/${key.name}: ptcount ${ptcount} but ${points.size} bytes of points`);
  }
  const xyz = new Reader(geo.data(points));
  const out = new Float32Array(ptcount * 3);
  for (let i = 0; i < ptcount; i++) {
    out[i * 3] = xyz.f32(i * DI_POINT_SIZE);
    out[i * 3 + 1] = xyz.f32(i * DI_POINT_SIZE + 4);
    out[i * 3 + 2] = xyz.f32(i * DI_POINT_SIZE + 8);          // the fourth float, `w`, is unused
  }
  return {
    region: p.u32(DI_REGION_AT),
    refcount: p.u32(DI_REFCOUNT_AT),
    ditype: packed & 3,
    ptcount,
    material: (packed >>> 10) & 0xff,
    cameratype: (packed >>> 18) & 3,
    appflags: (packed >>> 20) & 7,
    inside: (packed >>> 23) & 1,
    shadow: (packed >>> 24) & 3,
    points: out,
  };
}

/**
 * The nodes of a model's own subtree that carry visuals, in the order `hookupVisuals` numbers them
 * (`zVisual/vis_main.cpp:58-175`): depth first, the model itself first, then its children in key order,
 * and never down through an instance -- an instance's geometry belongs to the model it names.
 *
 * The index of a node in this array is the `N` of its chunk keys.
 */
export function visualNodes(model: SceneNode): SceneNode[] {
  const out: SceneNode[] = [];
  const rec = (node: SceneNode): void => {
    if (node.visuals > 0) out.push(node);
    for (const child of node.children) if (child.type !== NODE_INSTANCE) rec(child);
  };
  rec(model);
  return out;
}
