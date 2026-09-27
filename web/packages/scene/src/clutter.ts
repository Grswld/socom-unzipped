import { Reader, type Zar, type ZarKey } from '@s2u/archive';
import { multiply } from './sceneGraph';
import { placeInstances, type PlacedModel } from './buildScene';
import type { SceneNode } from './sceneGraph';

/**
 * `CLUTTER.ZAR`, the scattered small props: rocks and grass strewn over the ground, placed outside the
 * scene graph (36 section 2).
 *
 * The layout is `Clutter -> <model name> -> a_clutter -> { params 96 B, scale_inverse f32 }`, one
 * `a_clutter` child per instance -- the children share a name, so they are read positionally rather than
 * by lookup. Frostfire and Crossroads have none (a 192-byte stub with an empty `Clutter` key); Desert
 * Glory has 6 models and 110 instances.
 *
 * `params` is 96 bytes but it is **not** a `tag_NODE_PARAMS`, despite the matching size: a real
 * `nparams` carries a coherent bbox at +64 and its flags at +92, while a clutter record has its flag
 * word at +76 and scratch in the bbox slot. It comes in two forms, and the flag word's bit 1 says
 * which -- see `clutterMatrix`.
 *
 * The models are ordinary ones: they live in the map's own `MDL` archive and are named by the scene
 * graph as prototypes, but *nothing instances them from the root*, so `placeInstances` never reaches
 * them. `CLUTTER.ZAR` is their only placement, which is why a viewer that ignores it draws a Desert
 * Glory with bare ground.
 */

const PARAMS_SIZE = 96;
const MATRIX_FLOATS = 16;

/**
 * The flag word, and the bit the engine itself branches on.
 *
 * `FUN_002d9490` (`recomp/output/FUN_002d9490_0x2d9490.cpp`) is the clutter reader's first call: it
 * does `lbu $v0, 0x4C($a0)` -- byte +76 -- isolates bit 1, and returns `record + 0x30` when it is
 * clear or `record + 0x20` when it is set. That is the position, read from the matrix's translation
 * row at +48 or from the decomposed form's own position at +32. Its caller `sub_002D55C0` takes
 * `.x`/`.z` off the returned pointer for the grid-cell lookup.
 *
 * Under reCOM's `tag_NODE_PARAMS` bit order bit 1 is `m_dynamic_motion`, and the authoring data
 * agrees: the decomposed form is used for exactly the models given `repel (max_angle ...)` in the
 * map's `clutter.rdr` (114 of 114 models), i.e. the foliage that bends when a player walks through
 * it and therefore needs its transform kept apart from its bend.
 */
const FLAGS_AT = 76;
const DYNAMIC = 0x2;

/** The decomposed form's fields. `+16` is a second, always-identity quaternion: the live bend slot. */
const QUAT_AT = 0, POSITION_AT = 32, SCALE_AT = 44, REPEL_AT = 48;

/** One scattered instance: which model, where, and the reciprocal of the scale baked into the matrix. */
export interface ClutterInstance {
  modelName: string;
  /** 16 floats, row-major, row-vector: the same convention as a node's matrix (24 section 1.1). */
  matrix: Float32Array;
  /**
   * `scale_inverse`: 1 / the uniform scale in `matrix`, stored rather than derived. The engine wants it
   * to unscale normals without a square root per instance; a viewer only needs it to notice when the two
   * disagree, which on Desert Glory they never do.
   */
  scaleInverse: number;
  /** True when the record was the decomposed quaternion form rather than a stored matrix. */
  dynamic: boolean;
  /**
   * The `repel max_angle` of the model, in radians, on a dynamic record: how far this instance may be
   * bent aside when something walks through it. Nothing is animated here; it is carried because it is
   * what identifies the form, and a future bend has to read it from somewhere.
   */
  repelMaxAngle: number | null;
}

/** Every clutter instance of one map, in archive order (model by model). */
export function parseClutter(zar: Zar): ClutterInstance[] {
  const clutter = zar.find('Clutter');
  if (!clutter) throw new Error('CLUTTER.ZAR has no Clutter key');
  const out: ClutterInstance[] = [];
  for (const model of clutter.children) {
    model.children.forEach((instance, i) => out.push(readInstance(zar, model.name, instance, i)));
  }
  return out;
}

function readInstance(zar: Zar, modelName: string, key: ZarKey, index: number): ClutterInstance {
  const params = zar.child(key, 'params');
  const scale = zar.child(key, 'scale_inverse');
  if (!params || params.size !== PARAMS_SIZE) {
    throw new Error(`clutter ${modelName}[${index}]: params is ${params ? `${params.size} bytes` : 'absent'}, expected ${PARAMS_SIZE}`);
  }
  if (!scale || scale.size !== 4) {
    throw new Error(`clutter ${modelName}[${index}]: scale_inverse is ${scale ? `${scale.size} bytes` : 'absent'}, expected 4`);
  }
  const bytes = zar.data(params);
  const r = new Reader(bytes);
  const dynamic = (r.u32(FLAGS_AT) & DYNAMIC) !== 0;
  return {
    modelName,
    matrix: clutterMatrix(bytes),
    scaleInverse: new Reader(zar.data(scale)).f32(0),
    dynamic,
    repelMaxAngle: dynamic ? r.f32(REPEL_AT) : null,
  };
}

/**
 * The 16 floats of a clutter record's transform, from whichever of the two forms it is stored in.
 *
 * **The matrix form** (bit 1 clear) is the first 64 bytes as they stand: row-major, row-vector, the
 * same convention a scene node's matrix uses.
 *
 * **The decomposed form** (bit 1 set) stores a rotation, a position and a scale instead, because the
 * engine has to re-compose it every frame with the instance's current bend:
 *
 * ```
 *  +0  CQuat   rotation (x, y, z, w) -- `{CPnt3D vec; f32 w}`, zmath.h:211-226. Not normalised:
 *              |q| runs 0.92..1.41 across the maps, so it is normalised here.
 * +16  CQuat   (0, 0, 0, 1) on all 4,759 records: the live bend, written empty at export.
 * +32  CPnt3D  world position
 * +44  f32     uniform scale, equal to 1 / `scale_inverse` to 6e-8 on every record
 * +48  f32     `repel max_angle` in radians
 * ```
 *
 * The composition is the transpose of the textbook column-vector quaternion matrix, because
 * everything here multiplies row vectors on the left. Checked over all 4,759 decomposed records on
 * the 14 maps that carry them: the basis rows come out orthonormal to 6e-8, the determinant is the
 * cube of the scale to 1.4e-7, and none is mirrored.
 *
 * What is *not* settled is whether the stored quaternion is the rotation or its conjugate: every
 * generated template in `clutter.rdr` has a symmetric `rotation_range`, and half the records are a
 * pure yaw, where the sense cannot be seen. If tilted foliage ever leans the wrong way, negate x/y/z.
 */
export function clutterMatrix(params: Uint8Array): Float32Array {
  const r = new Reader(params);
  const m = new Float32Array(MATRIX_FLOATS);
  if ((r.u32(FLAGS_AT) & DYNAMIC) === 0) {
    for (let i = 0; i < MATRIX_FLOATS; i++) m[i] = r.f32(i * 4);
    return m;
  }
  let x = r.f32(QUAT_AT), y = r.f32(QUAT_AT + 4), z = r.f32(QUAT_AT + 8), w = r.f32(QUAT_AT + 12);
  const n = Math.hypot(x, y, z, w) || 1;
  x /= n; y /= n; z /= n; w /= n;
  const s = r.f32(SCALE_AT);
  m[0] = s * (1 - 2 * (y * y + z * z)); m[1] = s * 2 * (x * y + w * z);       m[2] = s * 2 * (x * z - w * y);
  m[4] = s * 2 * (x * y - w * z);       m[5] = s * (1 - 2 * (x * x + z * z)); m[6] = s * 2 * (y * z + w * x);
  m[8] = s * 2 * (x * z + w * y);       m[9] = s * 2 * (y * z - w * x);       m[10] = s * (1 - 2 * (x * x + y * y));
  m[12] = r.f32(POSITION_AT); m[13] = r.f32(POSITION_AT + 4); m[14] = r.f32(POSITION_AT + 8);
  m[15] = 1;
  return m;
}

/**
 * Whether these 16 floats are the affine row-vector matrix the format says they are.
 *
 * A row-vector affine transform has a last column of `(0, 0, 0, 1)`: rows 0-2 are basis vectors whose
 * fourth lane is zero, row 3 is the translation with a one. Desert Glory's clutter satisfies it
 * exactly. Abandoned's does not -- `bamboo5`'s first record reads
 *
 * ```
 *    0.067   0.135   0.051   0.987      <- a unit quaternion, not a basis row
 *    0.000   0.000   0.000   1.000
 * 1072.000  56.339 2205.600   1.000      <- a position, in row 2 rather than row 3
 *    0.251   0.000   0.000   1.000
 * ```
 *
 * Composing one of those as if it were a matrix is what drew Abandoned's streaks: basis rows thousands
 * of units long, radiating from the origin.
 *
 * **2026-09-20: that shape is now read rather than refused.** It is the decomposed form -- quaternion,
 * position, scale -- and `clutterMatrix` composes it; all 5,957 records on the 22 maps now pass this
 * guard. What is left for the guard to catch is a record that is neither: a corrupt read, a format
 * that turns out to have a third form, a future change to `clutterMatrix` that gets the algebra wrong.
 * It stays because a silent stream of streaks across a map is the failure it was written for, and
 * refusing loudly is still better than that.
 */
export function isAffineRowVector(m: Float32Array): boolean {
  const zeroish = (v: number): boolean => Math.abs(v) < 1e-4;
  if (!zeroish(m[3]!) || !zeroish(m[7]!) || !zeroish(m[11]!)) return false;
  if (Math.abs(m[15]! - 1) > 1e-4) return false;
  for (let r = 0; r < 3; r++) {
    const len = Math.hypot(m[r * 4]!, m[r * 4 + 1]!, m[r * 4 + 2]!);
    if (!Number.isFinite(len) || len < 1e-4 || len > 50) return false;
  }
  return [...m].every((v) => Number.isFinite(v));
}

/** What `placeClutter` found, and the models it could not place. */
export interface PlacedClutter {
  /** One per (instance, visual-bearing node of its model): the same shape a prop placement has. */
  placed: PlacedModel[];
  /** Models named by `CLUTTER.ZAR` that the scene graph does not hold, each named once. */
  missing: string[];
  /** Models whose records are not the affine matrix the format says, with how many instances each. */
  malformed: { modelName: string; instances: number }[];
}

/**
 * Places the clutter the way the props are placed: a model's own subtree is realised once, by
 * `placeInstances` rooted at that model, and each instance's matrix is composed on top of it. Doing it
 * through `placeInstances` rather than by hand is what gets the chunk keys right -- a clutter model may
 * carry instance contexts (`N000_I000_V00`) or none (`N000_000`), and the naming rule already knows
 * which from the graph.
 *
 * A model the graph does not hold costs one entry in `missing`, however many instances name it.
 */
export function placeClutter(models: SceneNode[], instances: ClutterInstance[]): PlacedClutter {
  const prototypes = new Map<string, PlacedModel[] | null>();
  const placed: PlacedModel[] = [];
  const missing: string[] = [];
  const badByModel = new Map<string, number>();
  for (const instance of instances) {
    if (!isAffineRowVector(instance.matrix)) {
      badByModel.set(instance.modelName, (badByModel.get(instance.modelName) ?? 0) + 1);
      continue;
    }
    let local = prototypes.get(instance.modelName);
    if (local === undefined) {
      try {
        local = placeInstances(models, instance.modelName);
      } catch {
        local = null;                                  // the graph has no such model; said once, below
        missing.push(instance.modelName);
      }
      prototypes.set(instance.modelName, local);
    }
    if (local === null) continue;
    for (const part of local) {
      const rowMajor = multiply(part.rowMajor, instance.matrix);
      placed.push({
        ...part,
        path: `clutter/${instance.modelName}`,
        world: Float32Array.from(rowMajor),            // the stored floats are three.js's elements (24 section 1.1)
        rowMajor,
      });
    }
  }
  const malformed = [...badByModel].map(([modelName, count]) => ({ modelName, instances: count }));
  return { placed, missing, malformed };
}
