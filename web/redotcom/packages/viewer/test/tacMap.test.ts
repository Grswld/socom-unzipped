import { describe, expect, it } from 'vitest';
import { parseZdb } from '@s2u/archive';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { compassMarks, DEFAULT_MODEL, hudLayout } from '../src/hud';
import { navBitmap, readTacData, TAC_LAYOUT, TacMap, tacMapLayout, type TacData } from '../src/tacMap';

/** The tactical map and the compass's nav marks (web/redotcom/docs/research/87-hud.md §9, §10). */

const PS2 = { width: 640, height: 448 };
const SIZES: Record<string, { width: number; height: number }> = {
  'ret_nav_01.tif': { width: 16, height: 16 }, 'ret_triangle.tif': { width: 16, height: 16 },
  'fov.tif': { width: 64, height: 64 }, 'teammate_health.tif': { width: 16, height: 16 },
  'hud_arrow_off2.tif': { width: 32, height: 32 }, 'font_text_01.tif': { width: 512, height: 128 },
  'compass_lo.tif': { width: 128, height: 128 },
};

describe('the compass nav marks', () => {
  it('names the bitmap by the first letter: Charlie is ret_nav_01, Juliet ret_nav_08, Zulu ret_nav_24', () => {
    expect([navBitmap('Charlie'), navBitmap('juliet'), navBitmap('Zulu'), navBitmap('PlayerStart'), navBitmap('Alpha')])
      .toEqual(['ret_nav_01.tif', 'ret_nav_08.tif', 'ret_nav_24.tif', 'ret_nav_14.tif', null]);
  });

  it('pins Vigilance\'s Charlie where the console frame shows it from spawn A, facing north: (599.5, 36.5) +-1', () => {
    // Vigilance (MP51): A at (540, 1456) (KNOWN section 1), Charlie at (689.76, 1216.11) (AIMAPS), 283 units: pinned.
    const model = { ...DEFAULT_MODEL, yaw: 0, position: [540, 1456] as [number, number],
      navPoints: [{ name: 'Charlie', x: 689.76, z: 1216.11 }, { name: 'Delta', x: 489.76, z: 766.11 }] };
    const marks = compassMarks(model);
    expect(marks.map((m) => m.bitmap)).toEqual(['ret_nav_01.tif']);                  // only the nearest, beyond 200
    const { quads } = hudLayout(PS2, model, SIZES);
    const box = quads.find((q) => q.texture === 'ret_nav_01.tif')!;
    const arrow = quads.find((q) => q.texture === 'ret_triangle.tif')!;
    // The GS draws its content half a pixel right and down of the quad's centre (`GS_SAMPLE_OFFSET`).
    expect(Math.abs(box.x + 0.5 - 599.5)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.y + 0.5 - 36.5)).toBeLessThanOrEqual(1);
    expect([box.w, box.h]).toEqual([16 * 1.2, 16 * 1.2]);
    // The arrow: 0.6x at radius 50 (the frame's orange pixels x 589-593, y 46-49).
    expect(Math.abs(arrow.x + 0.5 - 591.5)).toBeLessThanOrEqual(1);
    expect(Math.abs(arrow.y + 0.5 - 48)).toBeLessThanOrEqual(1);
    expect(arrow.w).toBeCloseTo(9.6, 9);
  });

  it('draws a nav point within 200 units at 0.005 x 65 pixels a unit, at its own size', () => {
    const model = { ...DEFAULT_MODEL, yaw: 90, position: [0, 0] as [number, number], navPoints: [{ name: 'Charlie', x: 0, z: -100 }] };
    // Yaw 90 looks down -x; north (-z) is then to the right: the mark 32.5 px right of the centre.
    const box = hudLayout(PS2, model, SIZES).quads.find((q) => q.texture === 'ret_nav_01.tif')!;
    expect(box.x).toBeCloseTo(565 + 32.5, 6);
    expect(box.y).toBeCloseTo(90, 6);
    expect(box.w).toBe(16);
  });
});

describe('the tactical map', () => {
  const data: TacData = {
    lines: [{ points: [[0, -100], [100, -100]], type: 0, sub: 0 }],
    zones: [], points: [{ name: 'Charlie', kind: 1, x: 0, z: -200 }],
    bounds: { minX: -1000, minZ: -1000, maxX: 1000, maxZ: 1000 },
  };
  const view = { player: [0, 0] as [number, number], yaw: 0, look: 0, zoom: 2200, pan: null, age: 10 };

  it('is heading-up at 396 px per zoom width, centred on (430, 213.5), north (-z) up at yaw 0', () => {
    const { project } = tacMapLayout(PS2, data, view, SIZES);
    const k = 396 / 2200;
    expect(project(0, 0)).toEqual([430, 213.5]);
    expect(project(0, -100)).toEqual([430, 213.5 - 100 * k]);
    expect(project(100, 0)[0]).toBeCloseTo(430 + 100 * k, 9);         // east to the right
    // Facing east (yaw -90 looks down +x): east up.
    const east = tacMapLayout(PS2, data, { ...view, yaw: -90 }, SIZES).project(100, 0);
    expect(east[0]).toBeCloseTo(430, 9);
    expect(east[1]).toBeCloseTo(213.5 - 100 * k, 9);
  });

  it('draws the grid (7 + 9 lines), the map\'s lines in hud.rdr\'s colours, the nav marks, the player and the N', () => {
    const { quads, tris } = tacMapLayout(PS2, data, view, SIZES, 0.5);   // 0.5 s: the edge arrows mid-pulse
    // Each segment is two triangles: 16 grid lines, 1 map line, 3 north-arrow strokes.
    expect(tris).toHaveLength(2 * (16 + 1 + 3));
    const white = tris.filter((t) => t.rgba[3] === 127 / 128);
    expect(white).toHaveLength(2);                                     // type 0: (255, 255, 255) at opacity 1 x 127
    expect(quads.map((q) => q.texture).sort()).toEqual([
      'font_text_01.tif', 'fov.tif', 'hud_arrow_off2.tif', 'hud_arrow_off2.tif', 'hud_arrow_off2.tif', 'hud_arrow_off2.tif',
      'ret_nav_01.tif', 'teammate_health.tif',
    ]);
    expect(quads.every((q) => q.layer === 1) && tris.every((t) => t.layer === 1)).toBe(true);
  });

  it('wipes the grid in: nothing at 0 s, all 16 lines by 1.5 + 1 s', () => {
    const at = (age: number) => tacMapLayout(PS2, null, { ...view, age }, SIZES).tris.length - 2 * 3;
    expect(at(0)).toBe(0);
    expect(at(0.05)).toBe(2);
    expect(at(2.6)).toBe(32);
  });

  it('opens at the camera\'s heading and zoom 2200, zooms within 1300..4000, and closes', () => {
    const map = new TacMap(() => true);
    const seen: boolean[] = [];
    map.onToggle = (open) => seen.push(open);
    map.toggle(45);
    expect(map.state()).toMatchObject({ open: true, zoom: 2200, yaw: 45, pan: null });
    map.zoomBy(-5000);
    expect(map.state().zoom).toBe(TAC_LAYOUT.zoom.min);
    map.zoomBy(9000);
    expect(map.state().zoom).toBe(TAC_LAYOUT.zoom.max);
    map.panBy(10, 0, [5, 5]);
    expect(map.state().pan).toEqual([15, 5]);
    map.toggle(0);
    expect(seen).toEqual([true, false]);
    expect(map.layout(PS2, null, [0, 0], 0, SIZES)).toBeNull();
  });
});

const bytes = fixture('RUN/MP2.ZDB');
describe.skipIf(bytes === null)(`Frostfire's tactical map data${bytes === null ? ` (${FIXTURES_ABSENT})` : ''}`, () => {
  it('is AIMAPS.MPS: 253 polylines on the BaseMap, the nav points Charlie..Foxtrot, no zones', () => {
    const { data, diagnostics } = readTacData(bytes!, parseZdb(bytes!));
    expect(diagnostics).toEqual([]);
    expect(data!.lines).toHaveLength(253);
    expect(data!.zones).toEqual([]);
    expect(data!.points.filter((p) => p.kind === 1).map((p) => p.name)).toEqual(['Charlie', 'Delta', 'Echo', 'Foxtrot']);
    expect(data!.bounds.minX).toBeCloseTo(51, 0);
  });
});
