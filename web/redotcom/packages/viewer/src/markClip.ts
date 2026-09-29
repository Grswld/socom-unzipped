import { type BufferAttribute, BufferGeometry, Float32BufferAttribute, InstancedMesh, type Material, Mesh, type Object3D, Sphere, Uint16BufferAttribute, Vector3 } from 'three';
import { MARK_DEPTH } from './surfaceShade';

type Vec3 = [number, number, number];

/**
 * EFFECTS (web/docs/research/89 §5 and §13): a mark -- a bullet's, a footprint, a grenade's scorch, every
 * `FUN_003139e0` decal -- clipped to the drawn world under it and shaded per vertex, as the game builds it.
 *
 * The game (`FUN_003139e0` decomp 213893 -> `FUN_003b3950` 306426 -> `FUN_003b3ab0` 306491), for each visual of the
 * hit node flagged `0x10000`, walks the visual's triangles and keeps one when
 * - its stored normal faces the round: `n . dir < -0.01` (306595; the direction is brought into the node's frame);
 * - each of its three vertices projects within **4.8** units of the mark's plane (`fabs(z) <= 4.8`, 306632), the
 *   projection the mark's own matrix (`FUN_00307810` 206431: a look-at along the round, x and y scaled by
 *   `(w - 1) / (size * w)`, offset 0.5 -- so x, y are the bitmap's u, v and z the depth along the round);
 * - its projected box meets the mark's square (`FUN_003bf290` 313290: min <= hi and max >= lo on u and on v).
 * Each kept triangle goes whole, with its three vertices' own colour words, into one pool entry (`FUN_003b3800` 306386,
 * `FUN_003beca0` 313065), and the GS draws it with the bitmap clamped: the mark shows where the triangle and the square
 * overlap, gouraud-shaded by the wall's colours.
 *
 * The viewer draws the same pixels with less fill: each kept triangle is clipped to the square (Sutherland-Hodgman on
 * u in [0, 1] and v in [0, 1]), each output vertex taking the triangle's colour interpolated at that point -- the
 * gouraud value the GS gives that pixel. The whole mark is one small mesh, built into buffers made once.
 *
 * **The node.** The game marks only the hit node's visuals. The viewer's world is one mesh per texture across the
 * whole map (`./world`, `frustumCulled` off) and a prop is a mesh (or an instance) per placement; so the node is the
 * world, or one prop placement (its name and its matrix): the one whose triangle is nearest the hit at the square's
 * centre. A mark on the ground beside a crate does not climb the crate, nor one on the crate the ground.
 *
 * **The budget.** `FUN_003b3ab0` has no cap per mark (each kept triangle is its own pool entry, 306654-306659); the
 * cap is the temporary pool's, `TEMP_DECAL_TRIANGLES`, in triangles. `MARK_CLIP_MAX_TRIANGLES` bounds a mark's
 * buffers [a reading: a mark is at most 3.4 units across; the maps' triangles near a hit number a handful].
 */

/** The facing test's bound: a triangle is kept when its normal . the round's direction is below this (306595). */
export const MARK_FACING = -0.01;
/** The world triangles one mark keeps at most [reading: the buffers' bound, not the game's; see the header]. */
export const MARK_CLIP_MAX_TRIANGLES = 32;
/**
 * `decals.rdr`'s `TEMP_DECAL_POOL` `BASE 150`: the game's temporary pool counts **triangles** -- one entry per kept world
 * triangle (`FUN_003b3800` takes one from `FUN_003bf1a0` per triangle) -- trimmed back to the base oldest first each
 * frame (`FUN_003bf110`). The bullet marks and the footprints share it (`0x4b5030`); the grenade's blast goes to the
 * permanent pool (`0x4b5050`).
 */
export const TEMP_DECAL_TRIANGLES = 150;
/**
 * `decals.rdr`'s `PERM_DECAL_POOL` `BASE 30, OVERFLOW 0` (read into `0x4b5050`, decomp 324141-324148): the permanent
 * pool the grenade's blast set goes to (`FUN_003b3800` 306401-306402, a negative size), one entry per kept world
 * triangle. `FUN_003bf1a0` (313254-313262) refuses once `count >= base + overflow`; nothing trims it (`FUN_003bf110`
 * runs on `0x4b5030` only: 218207, 219048, 236776) until the level's teardown empties it (`FUN_003bf050`, 218219,
 * 219060). So a map keeps its first 30 scorch triangles and refuses the rest.
 */
export const PERM_DECAL_TRIANGLES = 30;

/** A convex polygon clipped from a triangle by four half-planes has at most seven corners. */
const POLY_MAX = 7;
/** Floats a polygon corner carries: x y z, u v, r g b a. */
const STRIDE = 9;
/** Candidate triangles one mark considers before the node is chosen [reading: a buffer bound]. */
const CANDIDATE_MAX = 256;
/** Floats a candidate carries: 3 x (x y z u v r g b a d), the face normal, its node, whether blended. */
const CAND_STRIDE = 3 * 10 + 3 + 2;
/** Drawn surfaces this close along the round at the centre are one surface's layers (`./surfaceShade`'s gap). */
const LAYER_GAP = 0.05;
/** The index's cell, units. */
const CELL = 16;
/** A triangle over more cells than this is kept on the geometry's oversized list, read by every query. */
const CELLS_PER_TRIANGLE_MAX = 64;
/** A query over more cells than this reads every triangle of the geometry instead. */
const QUERY_CELLS_MAX = 512;

/** Where a mark goes and how it lies: the bitmap's u along `right`, v along `up`, projected along `forward`. */
export interface MarkFrame {
  /** The hit: the square's centre (u = v = 0.5), depth 0. */
  origin: Vec3;
  /** Unit, across `forward`: the bitmap's u. */
  right: Vec3;
  /** Unit, across `forward` and `right`: the bitmap's v. */
  up: Vec3;
  /** Unit: the round's direction, the projection's. */
  forward: Vec3;
  /** The square's side, units. */
  side: number;
}

/**
 * The game's frame for a mark (`FUN_00307810`, research 89 §5): square to `dir`, its up the world axis least aligned
 * with the surface normal -- no turn. Writes into `out` when given. For a round's mark the game's `dir` is the hit
 * polygon's normal negated (research 89 §15; `Fire` passes it so): along the round instead, a wall's big triangles hit
 * at a slant fail the 4.8 test at their far vertices and the mark is dropped.
 */
export function markFrame(point: Vec3, normal: Vec3, dir: Vec3, side: number, out?: MarkFrame): MarkFrame {
  const f = out ?? { origin: [0, 0, 0], right: [0, 0, 0], up: [0, 0, 0], forward: [0, 0, 0], side: 0 };
  let fx = dir[0], fy = dir[1], fz = dir[2];
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl; fy /= fl; fz /= fl;
  const ax = Math.abs(normal[0]), ay = Math.abs(normal[1]), az = Math.abs(normal[2]);
  // The axis least aligned with the normal, the first on a tie (x, then y, then z), as `projectedMark` picks it.
  let ux = 1, uy = 0, uz = 0;
  if (ay < ax && ay <= az) { ux = 0; uy = 1; } else if (az < ax && az < ay) { ux = 0; uz = 1; }
  let rx = fy * uz - fz * uy, ry = fz * ux - fx * uz, rz = fx * uy - fy * ux;
  let rl = Math.hypot(rx, ry, rz);
  if (rl < 1e-6) { rx = 0; ry = -fz; rz = fy; rl = Math.hypot(ry, rz) || 1; }   // (1, 0, 0) x f
  rx /= rl; ry /= rl; rz /= rl;
  f.origin[0] = point[0]; f.origin[1] = point[1]; f.origin[2] = point[2];
  f.right[0] = rx; f.right[1] = ry; f.right[2] = rz;
  f.up[0] = ry * fz - rz * fy; f.up[1] = rz * fx - rx * fz; f.up[2] = rx * fy - ry * fx;
  f.forward[0] = fx; f.forward[1] = fy; f.forward[2] = fz;
  f.side = side;
  return f;
}

/** A mark's own geometry, its buffers sized once for `MARK_CLIP_MAX_TRIANGLES` clipped triangles (world space). */
export function markClipGeometry(): BufferGeometry {
  const g = new BufferGeometry();
  const vertices = MARK_CLIP_MAX_TRIANGLES * POLY_MAX;
  g.setAttribute('position', new Float32BufferAttribute(new Float32Array(vertices * 3), 3));
  g.setAttribute('uv', new Float32BufferAttribute(new Float32Array(vertices * 2), 2));
  g.setAttribute('color', new Float32BufferAttribute(new Float32Array(vertices * 4).fill(1), 4));
  g.setIndex(new Uint16BufferAttribute(new Uint16Array(MARK_CLIP_MAX_TRIANGLES * (POLY_MAX - 2) * 3), 1));
  g.setDrawRange(0, 0);
  g.boundingSphere = new Sphere(new Vector3(), 0);
  g.userData.markClip = true;
  return g;
}

/**
 * The frame's bare square into a mark geometry (two triangles, lifted `lift` along `-forward`), every corner `rgba`
 * (unity for null): the mark while nothing drawn is under it yet.
 */
export function squareInto(frame: MarkFrame, target: BufferGeometry, lift: number, rgba: readonly number[] | null): void {
  const p = target.getAttribute('position') as BufferAttribute, uv = target.getAttribute('uv') as BufferAttribute;
  const c = target.getAttribute('color') as BufferAttribute, index = target.getIndex()!;
  const { origin: o, right: r, up: u, forward: f, side } = frame;
  for (let k = 0; k < 4; k++) {
    const su = k === 1 || k === 2 ? 1 : 0, sv = k >= 2 ? 1 : 0;
    const a = (su - 0.5) * side, b = (sv - 0.5) * side;
    p.setXYZ(k, o[0] + r[0] * a + u[0] * b - f[0] * lift, o[1] + r[1] * a + u[1] * b - f[1] * lift, o[2] + r[2] * a + u[2] * b - f[2] * lift);
    uv.setXY(k, su, sv);
    c.setXYZW(k, rgba?.[0] ?? 1, rgba?.[1] ?? 1, rgba?.[2] ?? 1, rgba?.[3] ?? 1);
  }
  const ix = index.array as Uint16Array;
  ix[0] = 0; ix[1] = 1; ix[2] = 2; ix[3] = 0; ix[4] = 2; ix[5] = 3;
  p.needsUpdate = uv.needsUpdate = c.needsUpdate = index.needsUpdate = true;
  target.setDrawRange(0, 6);
  target.boundingSphere!.center.set(o[0], o[1], o[2]);
  target.boundingSphere!.radius = side;
}

/** A drawn geometry's triangles filed by cell (local space), built on a mark's first look at it. */
interface GeometryIndex {
  position: BufferAttribute;
  version: number;
  index: ArrayLike<number> | null;
  triangles: number;
  cells: Map<number, number[]>;
  oversized: number[];
  /** Per triangle, the query that last read it: a triangle in several cells is read once. */
  stamp: Uint32Array;
}

/** A drawn mesh's placements: each instance's world matrix, its inverse, its winding's sign, its world box, its node. */
interface MeshEntry {
  seen: Float64Array;
  instanceVersion: number;
  count: number;
  world: Float64Array;
  inverse: Float64Array;
  flip: Int8Array;
  box: Float64Array;
  node: Int32Array;
  /** Per instance, 1 where its world matrix is the identity (the world's draws): the query box is already local. */
  identity: Uint8Array;
}

const cellKey = (x: number, y: number, z: number): number => ((x + 32768) * 65536 + (y + 32768)) * 65536 + (z + 32768);

/** A 4x4 (column-major, three's order) into `out` at `o`: `a * b`. */
function mul(a: ArrayLike<number>, ao: number, b: ArrayLike<number>, bo: number, out: Float64Array, o: number): void {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[o + c * 4 + r] = a[ao + r]! * b[bo + c * 4]! + a[ao + 4 + r]! * b[bo + c * 4 + 1]! + a[ao + 8 + r]! * b[bo + c * 4 + 2]! + a[ao + 12 + r]! * b[bo + c * 4 + 3]!;
    }
  }
}

/** The inverse of an affine 4x4 at `m[o]` into `out[o]`; returns the determinant of its 3x3. */
function invertAffine(m: Float64Array, o: number, out: Float64Array): number {
  const a = m[o]!, b = m[o + 1]!, c = m[o + 2]!, d = m[o + 4]!, e = m[o + 5]!, f = m[o + 6]!, g = m[o + 8]!, h = m[o + 9]!, i = m[o + 10]!;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const s = det === 0 ? 0 : 1 / det;
  // Rows of the inverse 3x3 (column-major storage).
  out[o] = A * s; out[o + 1] = (c * h - b * i) * s; out[o + 2] = (b * f - c * e) * s; out[o + 3] = 0;
  out[o + 4] = B * s; out[o + 5] = (a * i - c * g) * s; out[o + 6] = (c * d - a * f) * s; out[o + 7] = 0;
  out[o + 8] = C * s; out[o + 9] = (b * g - a * h) * s; out[o + 10] = (a * e - b * d) * s; out[o + 11] = 0;
  const tx = m[o + 12]!, ty = m[o + 13]!, tz = m[o + 14]!;
  out[o + 12] = -(out[o]! * tx + out[o + 4]! * ty + out[o + 8]! * tz);
  out[o + 13] = -(out[o + 1]! * tx + out[o + 5]! * ty + out[o + 9]! * tz);
  out[o + 14] = -(out[o + 2]! * tx + out[o + 6]! * ty + out[o + 10]! * tz);
  out[o + 15] = 1;
  return det;
}

/**
 * Clips marks to the drawn world under `root` (the map's group, as `./surfaceShade` reads it): the visible meshes with a
 * `color` attribute, less the detail and reflection passes (a child mesh on its base's geometry) and the flares.
 * Everything a clip needs is allocated once; a drawn geometry is indexed on the first mark that reaches it.
 */
export class MarkClipper {
  /** The world's colour under the square's centre after a clip (rgba, 1.0 = 0x80), when `centreFound`. */
  readonly centre = new Float32Array(4);
  centreFound = false;
  /**
   * The chosen node's scene path after a clip that kept triangles, when the node is a prop placement that carries one
   * (`./world` puts it on the mesh: `userData.nodePath`, an `InstancedMesh`'s `userData.nodePaths[i]`); else null. The
   * game's decal entries are the hit visual's own list (`FUN_003b3800` 306396-306416), so a mark rides its node
   * (research 92 §6: a door's leaf).
   */
  lastNodePath: string | null = null;

  private readonly geometries = new WeakMap<BufferGeometry, GeometryIndex>();
  private readonly meshes = new WeakMap<Mesh, MeshEntry>();
  private readonly nodeIds = new Map<string, number>();
  /** A node id's scene path, where its placement has one. */
  private readonly nodePaths = new Map<number, string>();
  private query = 0;
  private readonly stack: Object3D[] = [];
  private readonly candidates = new Float64Array(CANDIDATE_MAX * CAND_STRIDE);
  private candidateCount = 0;
  private readonly polyA = new Float64Array(POLY_MAX * STRIDE + STRIDE);
  private readonly polyB = new Float64Array(POLY_MAX * STRIDE + STRIDE);
  private readonly box = new Float64Array(6);
  private readonly local = new Float64Array(6);

  constructor(private readonly root: Object3D) {}

  /**
   * Builds the mark for `frame` into `target` (a `markClipGeometry`), lifted `lift` along each triangle's normal toward
   * the round; returns the world triangles kept (0: nothing drawn under it, `target` untouched). At most `limit` are
   * kept, the first in the walk's order: a pool with that much room left (`FUN_003bf1a0` refuses an entry per triangle).
   */
  clip(frame: MarkFrame, target: BufferGeometry, lift: number, limit = MARK_CLIP_MAX_TRIANGLES): number {
    this.centreFound = false;
    this.lastNodePath = null;
    this.candidateCount = 0;
    const { origin: o, right: r, up: u, forward: f, side } = frame;
    // The query's world box: the square, MARK_DEPTH either side along the round.
    const h = side * 0.5;
    const box = this.box;
    for (let k = 0; k < 3; k++) {
      const ext = Math.abs(r[k]!) * h + Math.abs(u[k]!) * h + Math.abs(f[k]!) * MARK_DEPTH;
      box[k] = o[k]! - ext;
      box[k + 3] = o[k]! + ext;
    }
    const stack = this.stack;
    stack.length = 0;
    stack.push(this.root);
    while (stack.length) {
      const obj = stack.pop()!;
      if (!obj.visible) continue;
      const children = obj.children;
      for (let i = 0; i < children.length; i++) stack.push(children[i]!);
      if (!(obj instanceof Mesh) || !obj.geometry.getAttribute('color')) continue;
      const parent = obj.parent;
      if (parent instanceof Mesh && parent.geometry === obj.geometry) continue;   // a detail or reflection pass
      if (obj.name.endsWith('(flare)')) continue;
      // An effect light's overlay (`./effectLights`: the receiver re-drawn on its own geometry, a sibling) is the LIGHT's
      // second draw, not a visual of the node: the game's clip walks the hit node's own visuals, each once (research 89
      // §10; `FUN_003b3ab0` 306491-306659).
      if (obj.userData['effectLightPass'] === true) continue;
      this.gather(obj, frame);
    }
    if (this.candidateCount === 0 || limit <= 0) return 0;
    return this.build(frame, target, lift, Math.min(limit, MARK_CLIP_MAX_TRIANGLES));
  }

  /** The mesh's triangles near the query that pass the game's three tests, onto the candidate list. */
  private gather(mesh: Mesh, frame: MarkFrame): void {
    const geometry = mesh.geometry as BufferGeometry;
    const entry = this.entryOf(mesh);
    const gi = this.indexOf(geometry);
    if (!gi) return;
    const blended = (mesh.material as Material).transparent ? 1 : 0;
    const colour = geometry.getAttribute('color') as BufferAttribute;
    const box = this.box;
    for (let n = 0; n < entry.count; n++) {
      const b = n * 6;
      if (entry.box[b]! > box[3]! || entry.box[b + 3]! < box[0]! || entry.box[b + 1]! > box[4]! || entry.box[b + 4]! < box[1]!
        || entry.box[b + 2]! > box[5]! || entry.box[b + 5]! < box[2]!) continue;
      const query = ++this.query;
      const q = entry.identity[n] ? box : this.localBox(entry.inverse, n * 16);
      const x0 = Math.floor(q[0]! / CELL), y0 = Math.floor(q[1]! / CELL), z0 = Math.floor(q[2]! / CELL);
      const x1 = Math.floor(q[3]! / CELL), y1 = Math.floor(q[4]! / CELL), z1 = Math.floor(q[5]! / CELL);
      const m = n * 16;
      if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > QUERY_CELLS_MAX) {
        for (let t = 0; t < gi.triangles; t++) this.test(gi, t, entry, m, n, colour, blended, frame);
        continue;
      }
      for (let i = 0; i < gi.oversized.length; i++) {
        const t = gi.oversized[i]!;
        if (gi.stamp[t] === query) continue;
        gi.stamp[t] = query;
        this.test(gi, t, entry, m, n, colour, blended, frame);
      }
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          for (let z = z0; z <= z1; z++) {
            const list = gi.cells.get(cellKey(x, y, z));
            if (!list) continue;
            for (let i = 0; i < list.length; i++) {
              const t = list[i]!;
              if (gi.stamp[t] === query) continue;
              gi.stamp[t] = query;
              this.test(gi, t, entry, m, n, colour, blended, frame);
            }
          }
        }
      }
    }
  }

  /** The game's tests on triangle `t` of instance `n`: facing, 4.8 deep, meets the square; kept as a candidate. */
  private test(gi: GeometryIndex, t: number, entry: MeshEntry, m: number, n: number, colour: BufferAttribute, blended: number, frame: MarkFrame): void {
    if (this.candidateCount >= CANDIDATE_MAX) return;
    const { origin: o, right: r, up: u, forward: f, side } = frame;
    const w = entry.world;
    const pos = gi.position.array as ArrayLike<number>;
    const c = this.candidates;
    const base = this.candidateCount * CAND_STRIDE;
    let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
    for (let k = 0; k < 3; k++) {
      const vi = gi.index ? gi.index[t * 3 + k]! : t * 3 + k;
      const lx = pos[vi * 3]!, ly = pos[vi * 3 + 1]!, lz = pos[vi * 3 + 2]!;
      const x = w[m]! * lx + w[m + 4]! * ly + w[m + 8]! * lz + w[m + 12]!;
      const y = w[m + 1]! * lx + w[m + 5]! * ly + w[m + 9]! * lz + w[m + 13]!;
      const z = w[m + 2]! * lx + w[m + 6]! * ly + w[m + 10]! * lz + w[m + 14]!;
      const dx = x - o[0], dy = y - o[1], dz = z - o[2];
      const d = dx * f[0] + dy * f[1] + dz * f[2];
      if (d > MARK_DEPTH || d < -MARK_DEPTH) return;                // 306632: each vertex within 4.8 of the plane
      const uu = (dx * r[0] + dy * r[1] + dz * r[2]) / side + 0.5;
      const vv = (dx * u[0] + dy * u[1] + dz * u[2]) / side + 0.5;
      if (uu < umin) umin = uu;
      if (uu > umax) umax = uu;
      if (vv < vmin) vmin = vv;
      if (vv > vmax) vmax = vv;
      const b = base + k * 10;
      c[b] = x; c[b + 1] = y; c[b + 2] = z; c[b + 3] = uu; c[b + 4] = vv;
      c[b + 5] = colour.getX(vi); c[b + 6] = colour.getY(vi); c[b + 7] = colour.getZ(vi);
      c[b + 8] = colour.itemSize === 4 ? colour.getW(vi) : 1;
      c[b + 9] = d;
    }
    // FUN_003bf290: the projected box meets the square.
    if (umin > 1 || umax < 0 || vmin > 1 || vmax < 0) return;
    // The face normal from the winding (CCW front, mesh SEMANTICS §6), turned by a mirroring placement.
    const e1x = c[base + 10]! - c[base]!, e1y = c[base + 11]! - c[base + 1]!, e1z = c[base + 12]! - c[base + 2]!;
    const e2x = c[base + 20]! - c[base]!, e2y = c[base + 21]! - c[base + 1]!, e2z = c[base + 22]! - c[base + 2]!;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-12) return;
    const s = (entry.flip[n]! < 0 ? -1 : 1) / nl;
    nx *= s; ny *= s; nz *= s;
    if (nx * f[0] + ny * f[1] + nz * f[2] >= MARK_FACING) return;   // 306595: faces the round
    c[base + 30] = nx; c[base + 31] = ny; c[base + 32] = nz;
    c[base + 33] = entry.node[n]!;
    c[base + 34] = blended;
    this.candidateCount++;
  }

  /** The node under the centre, then its candidates clipped to the square into `target`. */
  private build(frame: MarkFrame, target: BufferGeometry, lift: number, limit: number): number {
    const c = this.candidates;
    // The hit's node: the candidate under the square's centre nearest the hit along the round (a solid one before a
    // blended one); where none covers the centre (the hull off the drawn surface, a hole), the nearest by its middle.
    let best = -1, bestKey = Infinity, bestD = Infinity;
    for (let i = 0; i < this.candidateCount; i++) {
      const b = i * CAND_STRIDE;
      const w = this.centreWeights(b);
      let d: number, covered: boolean;
      if (w) {
        d = Math.abs(w[0] * c[b + 9]! + w[1] * c[b + 19]! + w[2] * c[b + 29]!);
        covered = true;
      } else {
        d = Math.abs((c[b + 9]! + c[b + 19]! + c[b + 29]!) / 3);
        covered = false;
      }
      // Order: covered first, then solid, then nearer.
      const key = (covered ? 0 : 2) + c[b + 34]!;
      if (key < bestKey || (key === bestKey && d < bestD)) { best = i; bestKey = key; bestD = d; }
    }
    const node = c[best * CAND_STRIDE + 33]!;
    // The colour under the centre: of the node's layers there, the most opaque (as `./surfaceShade` reads it).
    if (bestKey < 2) {
      let alpha = -1;
      for (let i = 0; i < this.candidateCount; i++) {
        const b = i * CAND_STRIDE;
        if (c[b + 33] !== node) continue;
        const w = this.centreWeights(b);
        if (!w) continue;
        const d = Math.abs(w[0] * c[b + 9]! + w[1] * c[b + 19]! + w[2] * c[b + 29]!);
        if (d > bestD + LAYER_GAP) continue;
        const a = w[0] * c[b + 8]! + w[1] * c[b + 18]! + w[2] * c[b + 28]!;
        if (a <= alpha) continue;
        alpha = a;
        for (let k = 0; k < 4; k++) this.centre[k] = w[0] * c[b + 5 + k]! + w[1] * c[b + 15 + k]! + w[2] * c[b + 25 + k]!;
        this.centreFound = true;
      }
    }
    const p = target.getAttribute('position') as BufferAttribute, uv = target.getAttribute('uv') as BufferAttribute;
    const col = target.getAttribute('color') as BufferAttribute, index = target.getIndex()!;
    const P = p.array as Float32Array, UV = uv.array as Float32Array, C = col.array as Float32Array, I = index.array as Uint16Array;
    const vertexCap = P.length / 3, indexCap = I.length;
    let vertices = 0, indices = 0, kept = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.candidateCount && kept < limit; i++) {
      const b = i * CAND_STRIDE;
      if (c[b + 33] !== node) continue;
      const count = this.clipToSquare(b);
      if (count < 3) continue;
      if (vertices + count > vertexCap || indices + (count - 2) * 3 > indexCap) break;
      kept++;
      const poly = this.polyA;
      const lx = c[b + 30]! * lift, ly = c[b + 31]! * lift, lz = c[b + 32]! * lift;
      for (let k = 0; k < count; k++) {
        const s = k * STRIDE, v = vertices + k;
        const x = poly[s]! + lx, y = poly[s + 1]! + ly, z = poly[s + 2]! + lz;
        P[v * 3] = x; P[v * 3 + 1] = y; P[v * 3 + 2] = z;
        UV[v * 2] = poly[s + 3]!; UV[v * 2 + 1] = poly[s + 4]!;
        C[v * 4] = poly[s + 5]!; C[v * 4 + 1] = poly[s + 6]!; C[v * 4 + 2] = poly[s + 7]!; C[v * 4 + 3] = poly[s + 8]!;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
      for (let k = 1; k < count - 1; k++) {
        I[indices++] = vertices; I[indices++] = vertices + k; I[indices++] = vertices + k + 1;
      }
      vertices += count;
    }
    if (kept === 0) return 0;
    this.lastNodePath = this.nodePaths.get(node) ?? null;
    p.needsUpdate = uv.needsUpdate = col.needsUpdate = index.needsUpdate = true;
    target.setDrawRange(0, indices);
    const sphere = target.boundingSphere ?? (target.boundingSphere = new Sphere());
    sphere.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    sphere.radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2;
    return kept;
  }

  private readonly weights: [number, number, number] = [0, 0, 0];
  /** The centre (0.5, 0.5)'s barycentric weights in candidate `b`'s projected triangle, or null outside it. */
  private centreWeights(b: number): [number, number, number] | null {
    const c = this.candidates;
    const u0 = c[b + 3]!, v0 = c[b + 4]!, u1 = c[b + 13]!, v1 = c[b + 14]!, u2 = c[b + 23]!, v2 = c[b + 24]!;
    const den = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
    if (Math.abs(den) < 1e-12) return null;
    const w0 = ((v1 - v2) * (0.5 - u2) + (u2 - u1) * (0.5 - v2)) / den;
    const w1 = ((v2 - v0) * (0.5 - u2) + (u0 - u2) * (0.5 - v2)) / den;
    const w2 = 1 - w0 - w1;
    const e = -1e-6;
    if (w0 < e || w1 < e || w2 < e) return null;
    this.weights[0] = w0; this.weights[1] = w1; this.weights[2] = w2;
    return this.weights;
  }

  /** Sutherland-Hodgman: candidate `b`'s triangle against u >= 0, u <= 1, v >= 0, v <= 1; the result in `polyA`. */
  private clipToSquare(b: number): number {
    const c = this.candidates;
    let src = this.polyA, dst = this.polyB;
    for (let k = 0; k < 3; k++) for (let j = 0; j < STRIDE; j++) src[k * STRIDE + j] = c[b + k * 10 + j]!;
    let count = 3;
    for (let plane = 0; plane < 4 && count >= 3; plane++) {
      const axis = 3 + (plane >> 1);                           // u, then v
      const sign = plane & 1 ? -1 : 1;                        // >= 0, then <= 1
      const off = plane & 1 ? 1 : 0;
      let out = 0;
      for (let k = 0; k < count; k++) {
        const a = k * STRIDE, n = ((k + 1) % count) * STRIDE;
        const da = sign * (src[a + axis]! - off), dn = sign * (src[n + axis]! - off);
        if (da >= 0) { for (let j = 0; j < STRIDE; j++) dst[out * STRIDE + j] = src[a + j]!; out++; }
        if ((da >= 0) !== (dn >= 0)) {
          const s = da / (da - dn);
          for (let j = 0; j < STRIDE; j++) dst[out * STRIDE + j] = src[a + j]! + (src[n + j]! - src[a + j]!) * s;
          out++;
        }
      }
      const t = src; src = dst; dst = t;
      count = out;
    }
    if (src !== this.polyA) this.polyA.set(src.subarray(0, count * STRIDE));
    return count;
  }

  /** The world box through an instance's inverse: the query's box in the geometry's own space. */
  private localBox(inverse: Float64Array, m: number): Float64Array {
    const box = this.box, q = this.local;
    q[0] = q[1] = q[2] = Infinity;
    q[3] = q[4] = q[5] = -Infinity;
    for (let k = 0; k < 8; k++) {
      const x = box[k & 1 ? 3 : 0]!, y = box[k & 2 ? 4 : 1]!, z = box[k & 4 ? 5 : 2]!;
      for (let a = 0; a < 3; a++) {
        const v = inverse[m + a]! * x + inverse[m + 4 + a]! * y + inverse[m + 8 + a]! * z + inverse[m + 12 + a]!;
        if (v < q[a]!) q[a] = v;
        if (v > q[a + 3]!) q[a + 3] = v;
      }
    }
    return q;
  }

  /** A mesh's placements, remade when its world matrix or its instances change. */
  private entryOf(mesh: Mesh): MeshEntry {
    const instanced = mesh instanceof InstancedMesh ? mesh : null;
    const count = instanced ? instanced.count : 1;
    const version = instanced ? instanced.instanceMatrix.version : 0;
    const mw = mesh.matrixWorld.elements;
    let e = this.meshes.get(mesh);
    if (e && e.count === count && e.instanceVersion === version) {
      let same = true;
      for (let k = 0; k < 16; k++) if (e.seen[k] !== mw[k]) { same = false; break; }
      if (same) return e;
    }
    e = {
      seen: Float64Array.from(mw), instanceVersion: version, count,
      world: new Float64Array(count * 16), inverse: new Float64Array(count * 16), flip: new Int8Array(count),
      box: new Float64Array(count * 6), node: new Int32Array(count), identity: new Uint8Array(count),
    };
    const geometry = mesh.geometry as BufferGeometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const lb = geometry.boundingBox!;
    // The world's own draws are one node; a prop's placement is its own (its name and its place).
    const world = !instanced && mesh.frustumCulled === false;
    for (let n = 0; n < count; n++) {
      const m = n * 16;
      if (instanced) mul(mw, 0, instanced.instanceMatrix.array, m, e.world, m);
      else e.world.set(mw, m);
      e.flip[n] = invertAffine(e.world, m, e.inverse) < 0 ? -1 : 1;
      let identity = 1;
      for (let k = 0; k < 16; k++) if (e.world[m + k] !== (k % 5 === 0 ? 1 : 0)) { identity = 0; break; }
      e.identity[n] = identity;
      const w = e.world, b = n * 6;
      e.box[b] = e.box[b + 1] = e.box[b + 2] = Infinity;
      e.box[b + 3] = e.box[b + 4] = e.box[b + 5] = -Infinity;
      for (let k = 0; k < 8; k++) {
        const x = k & 1 ? lb.max.x : lb.min.x, y = k & 2 ? lb.max.y : lb.min.y, z = k & 4 ? lb.max.z : lb.min.z;
        for (let a = 0; a < 3; a++) {
          const v = w[m + a]! * x + w[m + 4 + a]! * y + w[m + 8 + a]! * z + w[m + 12 + a]!;
          if (v < e.box[b + a]!) e.box[b + a] = v;
          if (v > e.box[b + 3 + a]!) e.box[b + 3 + a] = v;
        }
      }
      const key = world ? 'world' : `${mesh.name}|${w[m + 12]!.toFixed(3)}|${w[m + 13]!.toFixed(3)}|${w[m + 14]!.toFixed(3)}`;
      let id = this.nodeIds.get(key);
      if (id === undefined) { id = this.nodeIds.size; this.nodeIds.set(key, id); }
      e.node[n] = id;
      const path: unknown = instanced ? (mesh.userData.nodePaths as unknown[] | undefined)?.[n] : mesh.userData.nodePath;
      if (typeof path === 'string') this.nodePaths.set(id, path);
    }
    this.meshes.set(mesh, e);
    return e;
  }

  /** A geometry's triangles filed by cell, made on first use and again if its positions change. */
  private indexOf(geometry: BufferGeometry): GeometryIndex | null {
    const position = geometry.getAttribute('position') as BufferAttribute | undefined;
    if (!position || position.itemSize !== 3 || (position as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute) return null;
    const known = this.geometries.get(geometry);
    if (known && known.position === position && known.version === position.version) return known;
    const idx = geometry.getIndex();
    const index = idx ? (idx.array as ArrayLike<number>) : null;
    const triangles = Math.floor((index ? index.length : position.count) / 3);
    const cells = new Map<number, number[]>();
    const oversized: number[] = [];
    const pos = position.array as ArrayLike<number>;
    for (let t = 0; t < triangles; t++) {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = index ? index[t * 3 + k]! : t * 3 + k;
        const x = pos[v * 3]!, y = pos[v * 3 + 1]!, z = pos[v * 3 + 2]!;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (z < z0) z0 = z;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
        if (z > z1) z1 = z;
      }
      const cx0 = Math.floor(x0 / CELL), cy0 = Math.floor(y0 / CELL), cz0 = Math.floor(z0 / CELL);
      const cx1 = Math.floor(x1 / CELL), cy1 = Math.floor(y1 / CELL), cz1 = Math.floor(z1 / CELL);
      if (!Number.isFinite(cx0 + cx1 + cy0 + cy1 + cz0 + cz1)) continue;
      if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) * (cz1 - cz0 + 1) > CELLS_PER_TRIANGLE_MAX) { oversized.push(t); continue; }
      for (let x = cx0; x <= cx1; x++) {
        for (let y = cy0; y <= cy1; y++) {
          for (let z = cz0; z <= cz1; z++) {
            const key = cellKey(x, y, z);
            const list = cells.get(key);
            if (list) list.push(t);
            else cells.set(key, [t]);
          }
        }
      }
    }
    const gi: GeometryIndex = { position, version: position.version, index, triangles, cells, oversized, stamp: new Uint32Array(triangles) };
    this.geometries.set(geometry, gi);
    return gi;
  }
}
