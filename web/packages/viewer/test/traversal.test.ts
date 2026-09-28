import { describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { FsAssetSource } from '@s2u/archive/node';
import { buildGrid, findLadders, type CollisionOwner, type Grid, type GridParams, type WorldPoly } from '@s2u/scene';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { loadMap } from '../src/loadMap';
import { clipsFromPack, motionTableFromArchive } from '../src/motionTable';
import { groundGrid, groundPolygons, TICK, Walker, type WalkInput } from '../src/walk';
import { LADDER_STANDOFF, Traversal, TRAVERSAL_CLIPS, type TraversalEvent } from '../src/traversal';

/**
 * The traversal moves (web research 86): synthetic hulls pin the rules, Frostfire's ladders (MP2, the fixture) pin the
 * whole against the game's own hull and, with the owner's `MOTION_P.ZAR`, the clips' own roots.
 */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures');
const MP2 = fixture('RUN/MP2.ZDB');
const PACK = fixture('RUN/MOTION_P.ZAR');

const FORWARD: WalkInput = { forward: 1, right: 0, boost: false };
const BACK: WalkInput = { forward: -1, right: 0, boost: false };
const STILL: WalkInput = { forward: 0, right: 0, boost: false };

const quad = (pts: number[], ditype: number, appflags = 0, path = 'worldmodel/q'): WorldPoly => ({
  modelName: 'worldmodel', path, region: 0, ditype, material: 25, ptcount: 4, cameratype: 0, appflags, points: Float32Array.from(pts),
});
const floor = (x0: number, z0: number, x1: number, z1: number, y: number): WorldPoly => quad([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1], 3);

function world(polys: WorldPoly[]): Grid {
  const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 4, cellsZ: 4, originX: -200, originZ: -200 };
  const owners: CollisionOwner[] = polys.map((p, i) => ({ modelName: p.modelName, path: `${p.path}${i}`, first: i, count: 1 }));
  return buildGrid(params, [], [], polys, owners);
}

/**
 * A 40-high wall across x at z 0 with a deck behind it (z < 0) at 40, the ground in front at 0, and a ladder on the
 * wall's face: the span 0..40 and the cap 40..50 (appflags 2), 6 wide.
 */
function ladderWorld(): { grid: Grid; polys: WorldPoly[] } {
  const polys = [
    floor(-100, 0, 100, 100, 0),
    floor(-100, -100, 100, 0, 40),
    quad([-100, 0, 0, 100, 0, 0, 100, 40, 0, -100, 40, 0], 2),
    quad([-3, 0, 0.2, 3, 0, 0.2, 3, 40, 0.2, -3, 40, 0.2], 2, 2, 'worldmodel/lad/ladder'),
    quad([3, 40, 0.2, -3, 40, 0.2, -3, 50, 0.2, 3, 50, 0.2], 2, 2, 'worldmodel/lad/ladder'),
  ];
  return { grid: world(polys), polys };
}

/** Ticks until `until` holds or `max` ticks pass; the ticks taken. */
function run(w: Walker, input: WalkInput, until: () => boolean, max = 2000): number {
  for (let i = 0; i < max; i++) { if (until()) return i; w.tick(input); }
  return max;
}

describe('ladders: the list off the hull (web research 86 section 2)', () => {
  it('finds a ladder by its appflags 2, its span and cap, and the side it is climbed from', () => {
    const { grid, polys } = ladderWorld();
    const [l, ...rest] = findLadders(polys, grid);
    expect(rest).toEqual([]);
    expect(l!.bottom).toBeCloseTo(0, 6);
    expect(l!.top).toBeCloseTo(40, 6);
    expect(l!.capTop).toBeCloseTo(50, 6);
    expect(l!.halfWidth).toBeCloseTo(3, 6);
    expect([l!.nx, l!.nz]).toEqual([0, 1]);                          // the deck is at z < 0: climbed from z > 0
    expect(l!.sided).toBe(true);
  });
});

describe('the ladder on a synthetic wall (research 86 section 2)', () => {
  it('walking into the ladder facing it mounts it, climbs at 7.59 a second, and climbs off onto the deck', () => {
    const { grid, polys } = ladderWorld();
    const w = new Walker(grid);
    const t = new Traversal(grid, polys);
    w.driver = t;
    const events: TraversalEvent[] = [];
    t.on((e) => events.push(e));
    w.place(0, 10, 20);
    w.state.yaw = 0;                                                 // facing -z, at the ladder
    run(w, FORWARD, () => t.state().kind === 'ladderMount', 400);
    expect(events[0]).toEqual({ type: 'ladderMount', from: 'bottom' });
    run(w, FORWARD, () => t.state().kind === 'ladder', 400);
    expect(w.state.z).toBeCloseTo(0.2 + LADDER_STANDOFF, 6);        // on the rungs' centre line, the stand-off out
    expect(w.state.x).toBeCloseTo(0, 6);
    const y0 = w.state.y;
    for (let i = 0; i < 60; i++) w.tick(FORWARD);
    expect(w.state.y - y0).toBeCloseTo(7.59, 1);                    // one second at a full stick
    expect(events.filter((e) => e.type === 'ladderRung').length).toBeGreaterThanOrEqual(1);
    run(w, FORWARD, () => t.state().kind === 'ladderOffTop', 2000);
    run(w, FORWARD, () => t.state().kind === 'none', 400);
    expect(events.at(-1)).toEqual({ type: 'ladderDismount', at: 'top' });
    expect(w.state.y).toBeCloseTo(40, 6);
    expect(w.state.z).toBeLessThan(0);                               // over the wall, on the deck
    expect(w.airborne).toBe(false);
  });

  it('does not mount a ladder walked past, faced away from, or approached from behind', () => {
    const { grid, polys } = ladderWorld();
    const w = new Walker(grid);
    const t = new Traversal(grid, polys);
    w.driver = t;
    w.place(30, 10, 20); w.state.yaw = 0;                            // into the wall beside it
    run(w, FORWARD, () => false, 120);
    expect(t.state().kind).toBe('none');
    w.place(0, 10, 20); w.state.yaw = 180;                           // backing into it
    run(w, BACK, () => false, 120);
    expect(t.state().kind).toBe('none');
  });

  it('climbs back down and steps off at the foot, and the action button slides down at 0.8 g', () => {
    const { grid, polys } = ladderWorld();
    const w = new Walker(grid);
    const t = new Traversal(grid, polys);
    w.driver = t;
    const events: TraversalEvent[] = [];
    t.on((e) => events.push(e));
    w.place(0, 10, 20); w.state.yaw = 0;
    run(w, FORWARD, () => t.state().kind === 'ladder', 400);
    run(w, FORWARD, () => w.state.y > 10, 400);
    run(w, BACK, () => t.state().kind === 'ladderOffBottom', 800);
    run(w, STILL, () => t.state().kind === 'none', 400);
    expect(w.state.y).toBe(0);
    expect(w.state.z).toBeGreaterThan(0.2 + LADDER_STANDOFF);        // stepped back off the rungs
    expect(events.at(-1)).toEqual({ type: 'ladderDismount', at: 'bottom' });
    // Up again, then the slide.
    run(w, FORWARD, () => t.state().kind === 'ladder', 400);
    run(w, FORWARD, () => w.state.y > 12, 800);
    t.action();
    w.tick(STILL);
    expect(t.state().kind).toBe('ladderSlide');
    const from = w.state.y;
    const ticks = run(w, STILL, () => t.state().kind === 'ladderSlideLand', 800);
    expect(w.state.y).toBe(0);
    // The fall at 0.8 g from rest after "Ladder -> slide"'s 0.5 s: sqrt(2 h / (0.8 x 235)).
    expect(ticks * TICK).toBeCloseTo(0.5 + Math.sqrt((2 * from) / (0.8 * 235)), 0);
    expect(events.map((e) => e.type)).toContain('ladderSlideLand');
    run(w, STILL, () => t.state().kind === 'none', 400);
    expect(w.airborne).toBe(false);
  });

  it('mounts from the deck by backing onto the head\'s short quad, and climbs down to the ground', () => {
    const { grid, polys } = ladderWorld();
    const w = new Walker(grid);
    const t = new Traversal(grid, polys);
    w.driver = t;
    const events: TraversalEvent[] = [];
    t.on((e) => events.push(e));
    w.place(0, 60, -20); w.state.yaw = 180;                          // on the deck facing the ladder (+z)
    run(w, FORWARD, () => t.state().kind === 'ladderMountTop', 400);
    expect(events[0]).toEqual({ type: 'ladderMount', from: 'top' });
    run(w, STILL, () => t.state().kind === 'ladder', 400);
    expect(w.state.z).toBeCloseTo(0.2 + LADDER_STANDOFF, 6);
    expect(t.yaw()).toBeCloseTo(0, 6);                               // turned to face the rungs
    run(w, BACK, () => t.state().kind === 'none', 3000);
    expect(w.state.y).toBe(0);
  });
});

describe.skipIf(!MP2)(`Frostfire's ladders${MP2 ? '' : ` (${FIXTURES_ABSENT})`}`, () => {
  it('finds the five ladders research 86 section 2.2 lists, each climbed from the side away from its deck', async () => {
    const map = await loadMap(new FsAssetSource(FIXTURES), 'RUN/MP2.ZDB');
    const grid = groundGrid(map.ground!);
    const ladders = findLadders(groundPolygons(map.ground!), grid);
    expect(ladders.map((l) => [Math.round(l.x), Math.round(l.z), Math.round(l.bottom), Math.round(l.top)])).toEqual([
      [548, 854, 100, 160], [783, 364, 100, 155], [497, 596, 100, 155], [989, 617, 103, 153], [159, 913, 100, 157],
    ]);
    expect(ladders.every((l) => l.sided)).toBe(true);
  });

  it('climbs the sniper ladder at (547.5, 854.4) from the 100 floor to the 160 deck with the disc\'s clips', async () => {
    const map = await loadMap(new FsAssetSource(FIXTURES), 'RUN/MP2.ZDB');
    const grid = groundGrid(map.ground!);
    const w = new Walker(grid);
    const t = new Traversal(grid, groundPolygons(map.ground!));
    if (PACK) {
      const readers = resolve(FIXTURES, '../public/maps/RUN/READERC.ZAR');
      const table = existsSync(readers) ? motionTableFromArchive(readFileSync(readers)) : null;
      t.setClips(clipsFromPack(PACK, TRAVERSAL_CLIPS), table);
    }
    w.driver = t;
    const l = t.ladders[0]!;
    expect(w.place(l.x + l.nx * 15, 115, l.z + l.nz * 15)).toBe(true);
    w.state.yaw = Math.atan2(l.nx, l.nz) * 180 / Math.PI;
    run(w, FORWARD, () => t.state().kind === 'ladder', 600);
    expect(t.state().kind).toBe('ladder');
    const ticks = run(w, FORWARD, () => t.state().kind === 'none', 3000);
    expect(ticks).toBeLessThan(3000);
    expect(w.state.y).toBeCloseTo(160, 3);
    expect((w.state.x - l.x) * l.nx + (w.state.z - l.z) * l.nz).toBeLessThan(0);   // on the deck's side
  });
});
