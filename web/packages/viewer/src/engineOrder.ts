import { ringCells, type Grid } from '@s2u/scene';

/**
 * What the engine order needs to know of one draw. `world.ts` holds one such record per drawn object --
 * a world part merged across placements, an instanced prop, one LOD copy or one flare per placement, a
 * line group -- which is why the order is computed over these rather than over `LoadedMesh`: a mesh and a
 * draw are not one-to-one.
 */
export interface EngineDraw {
  /**
   * The grid cells (`x + z * cellsX`) of the placements the draw is made of, each filed as the grid files it
   * (`placementCells` in `@s2u/scene`). Empty when there is no placement to file it by.
   */
  readonly cells: readonly number[];
  /** Its place in the scene walk (`LoadedMesh.order`): the tie-break within a ring and in the shadow pass. */
  readonly order: number;
  /** A drop shadow (a `shadow*.tif` draw): held back into the pass after the last ring. */
  readonly shadow: boolean;
}

/**
 * The draws in the order the engine issues them from a camera at world (x, z), `RenderWorld`'s shape:
 *
 * 1. **The grid walked outward from the camera's cell** (`CPipe::RenderWorld`, `grid->StartTraversalOrdered`
 *    / `GetNextAtomOrdered`, reCOM `zRender/zrndr_pipe.cpp:207-248`): ring 0 is the camera's cell, ring *n*
 *    the cells `|dx| + |dz| = n` from it, as `addOrderedCellAtom` labels them (`zGrid/grid_main.cpp:351`,
 *    W1.R8; `ringCells`). The engine links a node into every cell its bounds cover and draws it once, when
 *    the walk first reaches it (`m_TickNum`, `grid_main.cpp:341-346`), so a draw goes out at the **first
 *    ring that holds one of its cells**: a merged draw is as near as its nearest piece. The walk goes to
 *    the grid's edge -- reCOM's loop bound `m_ring < 2` would stop at five cells, and no draw is dropped.
 * 2. **What has no cell** -- a draw with no placement to file it by -- after the last ring.
 * 3. **The drop shadows**, in a pass after the walk, as the engine draws its decals and shadows apart from
 *    it (`zrndr_pipe.cpp:176-196`; the viewer's decal pass, `world.ts`).
 *
 * Within a ring, and within the shadow pass, draws go in scene-walk order (`order`), then as given. The
 * engine orders a ring by cell and each cell's atoms by link order; a draw merged across cells has no one
 * place in that, so the walk order stands in for it.
 *
 * reCOM's `buildOrderedCellAtomList`, which fills the list the walk reads, is empty (`grid_main.cpp:357-360`):
 * that the list runs near to far is the reading of the ring label and of the sprint's spec (§4, W1.2), not
 * something reCOM shows.
 */
export function engineOrder<T extends EngineDraw>(draws: readonly T[], grid: Grid, x: number, z: number): T[] {
  const ring = new Float64Array(grid.cells.length).fill(Infinity);
  for (const r of ringCells(grid, x, z)) ring[r.cell.index] = r.ring;
  const keyed = draws.map((draw, index) => {
    let first = Infinity;
    for (const c of draw.cells) {
      const at = ring[c];
      if (at !== undefined && at < first) first = at;
    }
    return { draw, index, pass: draw.shadow ? 1 : 0, ring: draw.shadow ? 0 : first };
  });
  // Two draws with no cell compare Infinity - Infinity, NaN, which falls through to the walk order.
  keyed.sort((a, b) => a.pass - b.pass || a.ring - b.ring || a.draw.order - b.draw.order || a.index - b.index);
  return keyed.map((k) => k.draw);
}
