import { flattenScene, worldDi, type PlacedModel } from './buildScene';
import type { WorldPoly } from './collision';
import { transformPoint, type SceneNode } from './sceneGraph';
import type { GridParams } from './worldRoot';

/**
 * The engine's grid, `zdb::CGrid`: the map cut into square cells on the ground plane, every object linked into
 * each cell its bounds cover, and a walk over the cells outward from the camera. The draw walks it
 * (`CPipe::RenderWorld`, `research/recom/src/gamez/zRender/zrndr_pipe.cpp:207`) and so does the ground probe
 * (research 23 section 1.1, 24 section 1.1). Nothing of it is on the disc but `grid_params` (`worldRoot.ts`):
 * the cells are generated at load (`CGrid::Create`, `zGrid/grid_main.cpp:35-147`; `web/docs/research/72`
 * section 6).
 *
 * What the viewer links, and what it does not copy from the engine:
 *
 * - **Placements** (`placeInstances`): one object per drawn placement, filed by its node's bbox carried into the
 *   world by two corners (`worldFootprint`). The engine links nodes -- a world child (type 1) or a top-level
 *   instance (type 2), each with its whole subtree -- not each visual-bearing node (research 23 section 2.1).
 * - **Clutter** (`placeClutter`'s placements): one cell each, by position. The engine's clutter reader hands
 *   back the record's position and its caller takes `.x`/`.z` for the cell (`FUN_002d9490`, `sub_002D55C0`;
 *   `clutter.ts`), into the cell node's own clutter list (`CCell::m_clutterList`, `zGrid/zgrid.h:37`), drawn when
 *   the walk reaches the cell node (`zrndr_pipe.cpp:209-248`, `RenderClutter` at `:248`) -- so here it heads each
 *   cell's list.
 * - **Collision**: one object per *node that owns polygons*, its polygons in surface order, filed by their
 *   world-space extent. The engine reaches a polygon only through its model's atom and takes the first hit per
 *   model in surface order (research 23 section 1.1), so that is the unit; one atom per polygon would also spend
 *   more than the pool's 8,192 on 16 of the 22 maps, up to 24,514 on MP82 (counted 2026-09-28).
 *
 * The pool is not emulated: a grid never runs out, and `atomsSpent` says what it would have taken.
 */

/** A world-space rectangle on the ground plane: what the grid files an object by. */
export interface Footprint { minX: number; minZ: number; maxX: number; maxZ: number }

/** An inclusive range of cell coordinates, already clamped into the grid. */
export interface CellRange { x0: number; x1: number; z0: number; z1: number }

/**
 * The polygons of one realised node: `count` consecutive entries of the collision list from `first`. The
 * probe's unit (first hit per model, research 23 section 1.1) and the grid's collision object.
 */
export interface CollisionOwner {
  modelName: string; path: string; first: number; count: number;
  /**
   * The node's `tag_NODE_PARAMS` flag word, for the probe's per-model gate (`m_active`, `m_hasDI`,
   * `m_region_shift`; research 23 section 1.1, `probe.ts`). Absent where the owners were inferred without the
   * graph (`collisionRuns`), which the gate lets through.
   */
  flags?: number;
}

interface ObjectBase {
  /** Its index in the list it came from: `placed`, `clutter`, or the collision owners. */
  index: number;
  footprint: Footprint;
  /** The cells it is linked into: one atom each. */
  cells: CellRange;
}
/** A drawn placement of the scene graph. */
export interface ModelObject extends ObjectBase { kind: 'model'; placed: PlacedModel }
/** A drawn clutter placement. */
export interface ClutterObject extends ObjectBase { kind: 'clutter'; placed: PlacedModel }
/** One node's collision polygons, in surface order (the same objects as the collision list's). */
export interface CollisionObject extends ObjectBase { kind: 'collision'; owner: CollisionOwner; polys: readonly WorldPoly[] }
/** What an atom points at: `CGridAtom::Ent` (`zGrid/zgrid.h:18`). */
export type GridObject = ModelObject | ClutterObject | CollisionObject;

/** One link of an object into one cell (`CGridAtom`, `zgrid.h:13-21`). */
export interface GridAtom {
  object: GridObject;
  /** The cell's index, `x + z * cellsX`. */
  cell: number;
}

/** One cell (`CCell`, `zgrid.h:23-39`). */
export interface GridCell {
  /** `x + z * cellsX`: `Create`'s `m_Atoms[cx + cy * m_CellCount.cx]` (`grid_main.cpp:136`). */
  index: number;
  x: number;
  z: number;
  /** `cell%06d`, numbered x fastest as `Create` names them (`grid_main.cpp:139`; research 23 section 2.3). */
  name: string;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** The atoms linked into it, in the order they were linked; clutter first (see the file's comment). */
  atoms: GridAtom[];
}

export interface Grid {
  params: GridParams;
  /**
   * `m_InvCellDim`, `1 / m_CellDim` as the f32 `Create` stores (`grid_main.cpp:69`), the quotient rounded to
   * nearest: chopped instead, Frostfire's type-1 world nodes other than the three oceans spend 393 atoms, not
   * the 414 of research 24 section 1.1 (2026-09-28).
   */
  invCellDim: number;
  /** `cellsX * cellsZ` of them; `cells[i].index === i`. */
  cells: GridCell[];
  /** Every object linked, in link order: clutter, then placements, then collision owners. */
  objects: GridObject[];
  /** How many atoms the links took: one per (object, covered cell). The cells' own heads are not counted. */
  atomsSpent: number;
  /** `atomsSpent` by kind of object. */
  spent: Record<GridObject['kind'], number>;
}

const I32_MAX = 0x7fffffff, I32_MIN = -0x80000000;

/**
 * `cvt.w.s` as the EE does it: toward zero, saturating, and NaN to `0x7fffffff` -- research 23 section 2.1's
 * "NaN bounds are safe: cvt_w gives 0x7fffffff, which clamps to one cell".
 */
export function cvtW(v: number): number {
  if (Number.isNaN(v) || v >= 2 ** 31) return I32_MAX;
  if (v <= -(2 ** 31)) return I32_MIN;
  return Math.trunc(v);
}

/**
 * A number to single precision the way the EE rounds its arithmetic: by chopping, toward zero ("PS2 chop never
 * rounds up", research 25's rounding-mode row) -- where `Math.fround` rounds to nearest. Overflow chops to
 * +-FLT_MAX, as the EE has no infinity.
 */
export function chopF32(v: number): number {
  if (Number.isNaN(v)) return v;
  const r = Math.fround(v);
  if (Math.abs(r) <= Math.abs(v)) return r;
  const one = new Float32Array([r]);
  new Uint32Array(one.buffer)[0]! -= 1;               // one unit in the last place toward zero, either sign
  return one[0]!;
}

/** `0 <= i <= n - 1`, the clamp of `addOrderedCellAtom` and `gridGetAtomBasePtr` (`grid_main.cpp:317-334`, `:474-489`). */
const clampIndex = (i: number, n: number): number => (i < 0 ? 0 : i > n - 1 ? n - 1 : i);

/**
 * A world coordinate's cell along one axis, clamped: the coordinate chopped to single precision, times
 * `m_InvCellDim`, through `cvt.w`. Two f32s multiply exactly in a double, and chopping that product to f32
 * before `cvt.w` truncates it cannot change the integer, so the product is left exact. The chop shows: one
 * Frostfire prop's bound sits at 799.9999981 (`relieftower`), which rounding to nearest lifts to 800 and a cell
 * further; chopped, the world's 65 instance children spend 117 atoms, the type-2 count research 24 section 1.1
 * walked in the image (rounded to nearest, 115). That the two 117s are the same nodes is not shown.
 */
function axisCell(v: number, origin: number, inv: number, n: number): number {
  return clampIndex(cvtW(chopF32(v - origin) * inv), n);
}

/** The clamped cell range a footprint covers. Never empty: a range read backwards is taken both ways round. */
export function cellRange(grid: Grid, f: Footprint): CellRange {
  const { originX, originZ, cellsX, cellsZ } = grid.params;
  const ax = axisCell(f.minX, originX, grid.invCellDim, cellsX), bx = axisCell(f.maxX, originX, grid.invCellDim, cellsX);
  const az = axisCell(f.minZ, originZ, grid.invCellDim, cellsZ), bz = axisCell(f.maxZ, originZ, grid.invCellDim, cellsZ);
  return { x0: Math.min(ax, bx), x1: Math.max(ax, bx), z0: Math.min(az, bz), z1: Math.max(az, bz) };
}

/**
 * A node's bbox (model space, min xyz then max xyz) carried into the world by `rowMajor`, the way
 * `gridAddNodeToGrids` does it: the two corners transformed, then ordered axis by axis
 * (`grid_main.cpp:408-431`, reCOM's "translates two points"). Not the eight: a turned node's footprint is the
 * box its min and max corners span, narrower than the node at 45 degrees -- on the three fixtures 45 of 448,
 * 74 of 680 and 40 of 363 placements draw more than a unit outside it, up to 31 (measured 2026-09-28). That is the
 * engine's rule as reCOM reads it; the eight-corner box holds every drawn vertex on all three.
 */
export function worldFootprint(bbox: Float32Array, rowMajor: Float32Array): Footprint {
  const a = transformPoint(rowMajor, bbox[0]!, bbox[1]!, bbox[2]!);
  const b = transformPoint(rowMajor, bbox[3]!, bbox[4]!, bbox[5]!);
  return { minX: Math.min(a[0], b[0]), minZ: Math.min(a[2], b[2]), maxX: Math.max(a[0], b[0]), maxZ: Math.max(a[2], b[2]) };
}

/** A placement's footprint: its node's bbox, or the point it is translated to when it has none. */
function placedFootprint(p: PlacedModel): Footprint {
  if (p.bbox) return worldFootprint(p.bbox, p.rowMajor);
  return pointFootprint(p.rowMajor);
}

/** The translation row of a row-major matrix, as a footprint of no size. */
function pointFootprint(m: Float32Array): Footprint {
  return { minX: m[12]!, minZ: m[14]!, maxX: m[12]!, maxZ: m[14]! };
}

/** The ground-plane extent of some polygons' world points. */
function polysFootprint(polys: readonly WorldPoly[]): Footprint {
  const f: Footprint = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  for (const p of polys) {
    for (let i = 0; i < p.points.length; i += 3) {
      const x = p.points[i]!, z = p.points[i + 2]!;
      if (x < f.minX) f.minX = x;
      if (x > f.maxX) f.maxX = x;
      if (z < f.minZ) f.minZ = z;
      if (z > f.maxZ) f.maxZ = z;
    }
  }
  return f;
}

/**
 * The owners of a collision list: one per realised node, exactly, walked the way `worldCollision(models,
 * rootName)` walks them (`placeCollision` emits each node's polygons together, in `flattenScene` order), so
 * `first`/`count` index that list.
 */
export function collisionOwners(models: SceneNode[], rootName = 'worldmodel'): CollisionOwner[] {
  const out: CollisionOwner[] = [];
  let first = 0;
  for (const f of flattenScene(models, rootName)) {
    const count = worldDi(f).length;
    if (count === 0) continue;
    out.push({ modelName: f.modelName, path: f.path, first, count, flags: f.node.flags });
    first += count;
  }
  return out;
}

/**
 * The owners a collision list implies without the scene graph: runs of one model name and path. Exact but for
 * sibling nodes of one name that follow each other with polygons, which a run merges -- Frostfire has 330 runs
 * for 348 nodes. Pass `collisionOwners(models)` where the graph is to hand.
 */
export function collisionRuns(polys: readonly WorldPoly[]): CollisionOwner[] {
  const out: CollisionOwner[] = [];
  polys.forEach((p, i) => {
    const last = out[out.length - 1];
    if (last && last.path === p.path && last.modelName === p.modelName) last.count++;
    else out.push({ modelName: p.modelName, path: p.path, first: i, count: 1 });
  });
  return out;
}

/**
 * `CGrid::Create` and the loads' inserts (`FUN_002d7580`, one atom per covered cell; research 23 section 2.1):
 * the cells from `params`, then clutter, placements and collision linked into every cell their footprints
 * cover, clamped into the grid as the engine clamps. `owners` split `collision` into its nodes; without them,
 * `collisionRuns` does.
 */
export function buildGrid(
  params: GridParams,
  placed: readonly PlacedModel[],
  clutter: readonly PlacedModel[],
  collision: readonly WorldPoly[],
  owners: readonly CollisionOwner[] = collisionRuns(collision),
): Grid {
  const cells: GridCell[] = [];
  for (let z = 0; z < params.cellsZ; z++) {
    for (let x = 0; x < params.cellsX; x++) {
      const index = cells.length;
      const minX = params.originX + x * params.cellDim, minZ = params.originZ + z * params.cellDim;
      cells.push({
        index, x, z, name: `cell${String(index).padStart(6, '0')}`,
        minX, minZ, maxX: minX + params.cellDim, maxZ: minZ + params.cellDim, atoms: [],
      });
    }
  }
  const grid: Grid = {
    params, invCellDim: Math.fround(1 / params.cellDim), cells, objects: [], atomsSpent: 0,
    spent: { model: 0, clutter: 0, collision: 0 },
  };
  const link = (object: GridObject): void => {
    grid.objects.push(object);
    const { x0, x1, z0, z1 } = object.cells;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const cell = x + z * params.cellsX;
        cells[cell]!.atoms.push({ object, cell });
        grid.atomsSpent++;
        grid.spent[object.kind]++;
      }
    }
  };
  clutter.forEach((p, index) => {
    const footprint = pointFootprint(p.rowMajor);
    link({ kind: 'clutter', index, placed: p, footprint, cells: cellRange(grid, footprint) });
  });
  placed.forEach((p, index) => {
    const footprint = placedFootprint(p);
    link({ kind: 'model', index, placed: p, footprint, cells: cellRange(grid, footprint) });
  });
  owners.forEach((owner, index) => {
    if (owner.count <= 0) return;
    const polys = collision.slice(owner.first, owner.first + owner.count);
    const footprint = polysFootprint(polys);
    if (!(footprint.minX <= footprint.maxX)) return;               // no points: nothing to find it by
    link({ kind: 'collision', index, owner, polys, footprint, cells: cellRange(grid, footprint) });
  });
  return grid;
}

/** The cell at cell coordinates (x, z), clamped into the grid (`gridGetAtomBasePtr`, `grid_main.cpp:468-492`). */
export function cellByCoord(grid: Grid, x: number, z: number): GridCell {
  const cx = clampIndex(cvtW(x), grid.params.cellsX), cz = clampIndex(cvtW(z), grid.params.cellsZ);
  return grid.cells[cx + cz * grid.params.cellsX]!;
}

/** The cell holding world (x, z); a point off the grid gets the edge cell it clamps to. */
export function cellAt(grid: Grid, x: number, z: number): GridCell {
  const { originX, originZ, cellsX, cellsZ } = grid.params;
  return cellByCoord(grid, axisCell(x, originX, grid.invCellDim, cellsX), axisCell(z, originZ, grid.invCellDim, cellsZ));
}

/** Every cell a footprint covers, clamped, x fastest. */
export function cellsCovering(grid: Grid, f: Footprint): GridCell[] {
  const { x0, x1, z0, z1 } = cellRange(grid, f);
  const out: GridCell[] = [];
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) out.push(grid.cells[x + z * grid.params.cellsX]!);
  return out;
}

/**
 * The cells `buildGrid` links a placement into, without linking it: a placement of the scene graph by its
 * node's bbox (`worldFootprint`, or its translation when it has none), a clutter instance by its position
 * alone. What a draw made of placements is filed under when the grid is walked (the viewer's engine order).
 */
export function placementCells(grid: Grid, p: PlacedModel, kind: 'model' | 'clutter' = 'model'): GridCell[] {
  return cellsCovering(grid, kind === 'clutter' ? pointFootprint(p.rowMajor) : placedFootprint(p));
}

/**
 * How a cell's ring is numbered from the camera's cell.
 *
 * - `diamond` (the default, W1.R8): `|dx| + |dz|`, the label reCOM's `addOrderedCellAtom` writes into each
 *   ordered atom (`grid_main.cpp:351`) -- the camera's cell, then the four that share an edge with it, then
 *   the eight at two steps. The function is `zdb_CGrid_addOrderedCellAtom` at `0x002d7030` (384 bytes,
 *   `recomp/socom2_names.csv`, named by the call graph at 0.80); its body is not in this tree, so the label
 *   is reCOM's reading, unchecked against the instruction (2026-09-28).
 * - `square`: `max(|dx|, |dz|)` -- the 3 x 3 around the camera, the 5 x 5. Not the engine's ring; what a
 *   neighbourhood query wants (a wall in the diagonal cell is a neighbour).
 *
 * reCOM's `buildOrderedCellAtomList`, which would enumerate the cells, is empty (`:357-360`), so neither the
 * order the cells are listed in nor `RenderWorld`'s bound `m_ring < 2` (`zrndr_pipe.cpp:207`, five cells
 * under the diamond) is settled by it.
 */
export type RingMetric = 'square' | 'diamond';

const ringOf = (dx: number, dz: number, metric: RingMetric): number =>
  (metric === 'square' ? Math.max(Math.abs(dx), Math.abs(dz)) : Math.abs(dx) + Math.abs(dz));

/**
 * The cells in walk order from world (x, z) out to `maxRing` (to the grid's edge by default): ring by ring,
 * and within a ring by cell index. The camera's cell is `cellAt`'s, clamped, so a ring is only the part of
 * its diamond (or square) that lies on the grid -- the cells `addOrderedCellAtom` would clamp onto one it has
 * already stamped this tick (`grid_main.cpp:341`, `:349`) are the ones that are not there.
 */
export function ringCells(grid: Grid, x: number, z: number, maxRing = Infinity, metric: RingMetric = 'diamond'): { cell: GridCell; ring: number }[] {
  const view = cellAt(grid, x, z);
  const out: { cell: GridCell; ring: number }[] = [];
  if (Number.isFinite(maxRing)) {
    // PERFORMANCE (web sprint 3): a bounded ring visits only the cells in its square, not the whole grid; the list and
    // its order are the same.
    const { cellsX, cellsZ } = grid.params, r = Math.max(0, Math.floor(maxRing));
    for (let cz = Math.max(0, view.z - r); cz <= Math.min(cellsZ - 1, view.z + r); cz++) {
      for (let cx = Math.max(0, view.x - r); cx <= Math.min(cellsX - 1, view.x + r); cx++) {
        const ring = ringOf(cx - view.x, cz - view.z, metric);
        if (ring <= maxRing) out.push({ cell: grid.cells[cx + cz * cellsX]!, ring });
      }
    }
  } else {
    for (const cell of grid.cells) out.push({ cell, ring: ringOf(cell.x - view.x, cell.z - view.z, metric) });
  }
  return out.sort((a, b) => a.ring - b.ring || a.cell.index - b.cell.index);
}

/**
 * The ordered traversal (`StartTraversalOrdered` / `GetNextAtomOrdered`, `grid_main.cpp:264-310`): every atom of
 * every cell in `ringCells` order, each cell's atoms in the order they were linked, with the cell's ring. An
 * object covering several cells comes once per cell; the first time is its nearest ring. The engine also skips
 * a node that is not `m_active` (`:303`); every placement the viewer draws is taken as active.
 */
export function* traverse(grid: Grid, x: number, z: number, maxRing = Infinity, metric: RingMetric = 'diamond'): Generator<{ atom: GridAtom; ring: number }> {
  for (const { cell, ring } of ringCells(grid, x, z, maxRing, metric)) {
    for (const atom of cell.atoms) yield { atom, ring };
  }
}
