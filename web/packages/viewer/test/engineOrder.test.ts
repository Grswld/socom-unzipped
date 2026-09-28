import { describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGrid, cellAt, ringCells, type GridParams } from '@s2u/scene';
import { FsAssetSource } from '@s2u/archive/node';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { engineOrder, type EngineDraw } from '../src/engineOrder';
import { loadMap, type LoadedMap } from '../src/loadMap';

/**
 * The engine's draw order (W1.2): `CPipe::RenderWorld` walks the grid's cells outward from the camera's
 * (`StartTraversalOrdered` / `GetNextAtomOrdered`, reCOM `zRender/zrndr_pipe.cpp:207`), each ring labelled
 * `|dx| + |dz|` (`zGrid/grid_main.cpp:351`, W1.R8), so a draw goes out at the first ring that holds one of
 * its cells; the drop shadows are held back into a pass after the last ring; ties go by the scene walk.
 */

/** A 3 x 3 grid of 100-unit cells from the origin: cell `x + 3z`, the centre is 4. */
const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 3, cellsZ: 3, originX: 0, originZ: 0 };
const grid = buildGrid(params, [], [], []);

interface Named extends EngineDraw { name: string }
const draw = (name: string, cells: number[], order: number, shadow = false): Named => ({ name, cells, order, shadow });
const names = (list: Named[]): string[] => list.map((d) => d.name);

describe('engineOrder (synthetic)', () => {
  // Four meshes in known cells and a shadow on the camera's own cell.
  const scene = [
    draw('shadow', [4], 5, true),
    draw('far', [8], 0),                   // the corner: two steps from the centre
    draw('east', [5], 10),                 // shares an edge with the centre
    draw('centre', [4], 30),
    draw('west', [3], 20),                 // shares an edge too, later in the walk than 'east'
  ];

  it('draws the camera\'s cell first, then the rings outward, the shadow last', () => {
    expect(names(engineOrder(scene, grid, 150, 150))).toEqual(['centre', 'east', 'west', 'far', 'shadow']);
  });

  it('reorders when the camera moves: from the corner the far mesh comes first and the centre after its ring', () => {
    // From cell 8: 'far' is ring 0, 'east' (cell 5) ring 1, 'centre' ring 2, 'west' (cell 3) ring 3.
    expect(names(engineOrder(scene, grid, 250, 250))).toEqual(['far', 'east', 'centre', 'west', 'shadow']);
    // A camera off the grid walks from the cell it clamps to, as the grid's own clamp does.
    expect(names(engineOrder(scene, grid, 900, 900))).toEqual(names(engineOrder(scene, grid, 250, 250)));
  });

  it('breaks a tie within a ring by the scene walk, and keeps equal orders in the order given', () => {
    const tied = [draw('b', [5], 7), draw('a', [3], 7), draw('c', [1], 2)];
    expect(names(engineOrder(tied, grid, 150, 150))).toEqual(['c', 'b', 'a']);
  });

  it('puts a draw made of several placements at its nearest cell\'s ring, not at the cells between them', () => {
    // A merged part with pieces in the two far corners: ring 2 from the centre, ring 0 from either corner.
    const merged = draw('corners', [0, 8], 40);
    const list = [...scene, merged];
    expect(names(engineOrder(list, grid, 150, 150))).toEqual(['centre', 'east', 'west', 'far', 'corners', 'shadow']);
    expect(names(engineOrder(list, grid, 50, 50)).slice(0, 2)).toEqual(['corners', 'west']);
  });

  it('draws what has no cell after the last ring and before the shadows; shadows go by the scene walk', () => {
    const list = [...scene, draw('nowhere', [], 1), draw('shadow2', [8], 2, true)];
    expect(names(engineOrder(list, grid, 150, 150))).toEqual(['centre', 'east', 'west', 'far', 'nowhere', 'shadow2', 'shadow']);
  });

  it('emits every draw exactly once and leaves its input alone', () => {
    const before = names(scene);
    const out = engineOrder(scene, grid, 150, 150);
    expect(out).toHaveLength(scene.length);
    expect(new Set(out).size).toBe(scene.length);
    expect(names(scene)).toEqual(before);
  });
});

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures');
const absent = fixture('RUN/MP2.ZDB') === null;
const load = (path: string): Promise<LoadedMap> => loadMap(new FsAssetSource(FIXTURES), path);

/** A loaded map's draws as `world.ts` files them: each world part, each prop placement, each line group. */
function drawsOf(map: LoadedMap): Named[] {
  const out: Named[] = [];
  map.world.forEach((m, i) => out.push({ name: `world ${i} ${m.textureName}`, cells: m.cells ?? [], order: m.order, shadow: /shadow/i.test(m.textureName ?? '') }));
  for (const prop of map.props) {
    const placements = prop.matrices.length / 16;
    for (const part of prop.parts) {
      for (let i = 0; i < placements; i++) {
        out.push({ name: `${prop.modelName} ${i} ${part.textureName}`, cells: prop.cells?.[i] ?? [], order: part.order, shadow: /shadow/i.test(part.textureName ?? '') });
      }
    }
  }
  for (const g of map.lines ?? []) out.push({ name: `lines ${g.textureName}`, cells: g.cells ?? [], order: g.order, shadow: false });
  return out;
}

describe.skipIf(absent)(`the engine order on Frostfire${absent ? ` (${FIXTURES_ABSENT})` : ''}`, () => {
  it.skipIf(absent)('every draw out of loadMap is filed in the grid: world parts, prop placements, line groups', async () => {
    const map = await load('RUN/MP2.ZDB');
    expect(map.grid).toMatchObject({ cellDim: 160, cellsX: 8, cellsZ: 9 });
    for (const m of map.world) {
      expect(m.cells!.length, m.textureName ?? 'untextured').toBeGreaterThan(0);
      expect(m.cells!.every((c) => c >= 0 && c < 72)).toBe(true);
    }
    for (const p of map.props) {
      expect(p.cells, p.modelName).toHaveLength(p.matrices.length / 16);
      for (const cells of p.cells!) expect(cells.length, p.modelName).toBeGreaterThan(0);
    }
    for (const g of map.lines ?? []) expect(g.cells!.length).toBeGreaterThan(0);
  });

  it.skipIf(absent)('from spawn A the walk starts in cell (4, 3) and goes outward; from spawn B in (3, 7), in another order', async () => {
    const map = await load('RUN/MP2.ZDB');
    const g = buildGrid(map.grid, [], [], []);
    const draws = drawsOf(map);
    const ringsFrom = (x: number, z: number): Map<number, number> => new Map(ringCells(g, x, z).map((r) => [r.cell.index, r.ring]));
    for (const [x, z, cell] of [[796, 614, 4 + 3 * 8], [536, 1254, 3 + 7 * 8]] as const) {
      expect(cellAt(g, x, z).index).toBe(cell);
      const out = engineOrder(draws, g, x, z);
      expect(out).toHaveLength(draws.length);
      expect(out[0]!.cells).toContain(cell);
      // Rings never go back inward, and every shadow comes after every other draw.
      const ring = ringsFrom(x, z);
      const walked = out.filter((d) => !d.shadow).map((d) => Math.min(...d.cells.map((c) => ring.get(c)!)));
      for (let i = 1; i < walked.length; i++) expect(walked[i]).toBeGreaterThanOrEqual(walked[i - 1]!);
      const firstShadow = out.findIndex((d) => d.shadow);
      expect(firstShadow).toBeGreaterThan(0);
      expect(out.slice(firstShadow).every((d) => d.shadow)).toBe(true);
    }
    expect(names(engineOrder(draws, g, 796, 614))).not.toEqual(names(engineOrder(draws, g, 536, 1254)));
  });
});
