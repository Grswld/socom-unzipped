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
import { simClipsFromBytes } from '../src/simMap';
import { LADDER_STANDOFF, rippleAnimation, Traversal, TRAVERSAL_CLIPS, type TraversalEvent } from '../src/traversal';

/**
 * The traversal moves (web research 86): synthetic hulls pin the rules, Frostfire's ladders (MP2, the fixture) pin the
 * whole against the game's own hull and, with the owner's `MOTION_P.ZAR`, the clips' own roots.
 */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures');
const MP2 = fixture('RUN/MP2.ZDB');
const PACK = fixture('RUN/MOTION_P.ZAR');

/** The pack's traversal clips, read once. */
let packClips: ReturnType<typeof clipsFromPack> | null = null;
const PACK_CLIPS = (): ReturnType<typeof clipsFromPack> => (packClips ??= clipsFromPack(PACK!, TRAVERSAL_CLIPS));

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

// ---- the climb (research 86 section 3) ---------------------------------------------------------------------------

/** A box from (x0, z0) to (x1, z1), `h` tall on the 0 floor, its four sides of `appflags`, its top a floor. */
function box(x0: number, z0: number, x1: number, z1: number, h: number, appflags: number): WorldPoly[] {
  return [
    quad([x0, 0, z1, x1, 0, z1, x1, h, z1, x0, h, z1], 2, appflags),
    quad([x0, 0, z0, x1, 0, z0, x1, h, z0, x0, h, z0], 2, appflags),
    quad([x0, 0, z0, x0, 0, z1, x0, h, z1, x0, h, z0], 2, appflags),
    quad([x1, 0, z0, x1, 0, z1, x1, h, z1, x1, h, z0], 2, appflags),
    floor(x0, z0, x1, z1, h),
  ];
}

function climbWorld(h: number, appflags: number): { grid: Grid; polys: WorldPoly[] } {
  const polys = [floor(-100, -100, 100, 100, 0), ...box(-10, -30, 10, 0, h, appflags)];
  return { grid: world(polys), polys };
}

/** A walker and its traversal on a hull, stood at (0, 0, z) facing -z, the box's near side at z 0. */
function climber(polys: WorldPoly[], grid: Grid, z = 12): { w: Walker; t: Traversal; events: TraversalEvent[] } {
  const w = new Walker(grid);
  const t = new Traversal(grid, polys);
  w.driver = t;
  const events: TraversalEvent[] = [];
  t.on((e) => events.push(e));
  w.place(0, 10, z);
  w.state.yaw = 0;
  return { w, t, events };
}

describe('the climb on a synthetic box (research 86 section 3)', () => {
  it('shows the climb prompt once the climbable side is touched, and the action climbs the crate onto its top', () => {
    const { grid, polys } = climbWorld(12, 4);
    const { w, t, events } = climber(polys, grid);
    expect(t.climbPrompt()).toBeNull();
    run(w, FORWARD, () => t.climbPrompt() !== null, 120);
    expect(t.climbPrompt()).toEqual({ visible: true, kind: 'low', automatic: false });
    // The contact is kept stepping back (within 24, in front, facing it).
    for (let i = 0; i < 10; i++) w.tick(BACK);
    expect(t.climbPrompt()?.kind).toBe('low');
    t.action();
    w.tick(STILL);
    expect(events[0]).toEqual({ type: 'climbStart', kind: 'low' });
    const ticks = run(w, STILL, () => t.state().kind === 'none', 400);
    expect(ticks * TICK).toBeGreaterThan(1.25 * (29 / 30) ** 2);   // the clip's run to its last key (FUN_0028c4f0), after the steering
    expect(events.map((e) => e.type)).toEqual(['climbStart', 'climbUp', 'climbEnd']);
    expect(w.state.y).toBeCloseTo(12, 6);
    expect(w.state.z).toBeLessThan(0);                                // on the top, past the edge
    expect(w.airborne).toBe(false);
  });

  it('picks the clip by the height (FUN_00580b70): step, crate, medium, hang; nothing over 32 or on a plain wall', () => {
    const kind = (h: number, app: number): string | null => {
      const { grid, polys } = climbWorld(h, app);
      const { w, t } = climber(polys, grid, 5);
      run(w, FORWARD, () => false, 30);
      return t.climbPrompt()?.kind ?? null;
    };
    expect(kind(8, 1)).toBe('step');
    expect(kind(11, 1)).toBe('low');
    expect(kind(18, 1)).toBe('low');                                  // crate weight 1 - 6 / 14.5 = 0.59
    expect(kind(20, 1)).toBe('med');                                  // 0.45
    expect(kind(27, 3)).toBe('med');
    expect(kind(30, 1)).toBe('high');
    expect(kind(34, 1)).toBeNull();
    expect(kind(12, 0)).toBeNull();                                   // an ordinary wall is never climbed
    expect(kind(4, 4)).toBeNull();                                    // a crate under 5
  });

  it('steps onto a low crate with no press (appflags 4, 5 < h <= 10)', () => {
    const { grid, polys } = climbWorld(8, 4);
    const { w, t, events } = climber(polys, grid);
    run(w, FORWARD, () => events.length > 0, 200);
    expect(events[0]).toEqual({ type: 'climbStart', kind: 'step' });
    run(w, STILL, () => t.state().kind === 'none', 400);
    expect(w.state.y).toBeCloseTo(8, 6);
  });

  it('climbs over appflags 5 whatever its height, landing on the far side', () => {
    const polys = [floor(-100, -100, 100, 100, 0), ...box(-10, -2, 10, 0, 10, 5).slice(0, 4)];
    const grid = world(polys);
    const { w, t, events } = climber(polys, grid);
    run(w, FORWARD, () => t.climbPrompt() !== null, 120);
    expect(t.climbPrompt()?.kind).toBe('over');
    t.action();
    run(w, STILL, () => events.at(-1)?.type === 'climbEnd', 400);
    expect(w.state.y).toBe(0);
    expect(w.state.z).toBeLessThan(-2);                               // over the wall
  });

  it('hangs from a 30-high ledge, and the stick ahead pulls up onto it', () => {
    const { grid, polys } = climbWorld(30, 1);
    const { w, t, events } = climber(polys, grid);
    run(w, FORWARD, () => t.climbPrompt() !== null, 120);
    t.action();
    run(w, STILL, () => t.state().kind === 'hang', 400);
    expect(w.state.y).toBeGreaterThan(5);
    expect(w.airborne).toBe(false);                                   // held by the hang, not falling
    run(w, FORWARD, () => t.state().kind === 'none', 400);
    expect(events.map((e) => e.type)).toEqual(['climbStart', 'jumpWhoosh', 'pullUp', 'climbEnd']);
    expect(w.state.y).toBeCloseTo(30, 6);
  });

  it('the jump-grab: a 36 ledge is out of reach from the floor, and in reach at the top of a jump', () => {
    const { grid, polys } = climbWorld(36, 1);
    const { w, t, events } = climber(polys, grid);
    run(w, FORWARD, () => false, 60);
    expect(t.climbPrompt()).toBeNull();                               // h 36 > 32
    w.setAirborne(true, 60);                                         // a jump's rise
    run(w, STILL, () => t.climbPrompt() !== null, 60);
    expect(w.airborne).toBe(true);
    expect(t.climbPrompt()?.kind).toBe('high');
    t.action();
    w.tick(FORWARD);
    run(w, FORWARD, () => t.state().kind === 'none', 800);
    expect(events[0]).toEqual({ type: 'climbStart', kind: 'high' });
    expect(w.state.y).toBeCloseTo(36, 6);
  });

  it('the jump-grab off the walk own running jump (79.9 up, research 80): a 36 ledge climbed from the air', () => {
    const { grid, polys } = climbWorld(36, 1);
    const { w, t, events } = climber(polys, grid, 40);
    run(w, FORWARD, () => Math.hypot(w.state.vx, w.state.vz) > 60, 60);
    run(w, FORWARD, () => w.state.z < 16, 60);
    expect(w.jump()).toBe(true);
    expect(w.action?.name).toBe('launch');
    run(w, FORWARD, () => t.climbPrompt() !== null && w.airborne, 90);
    expect(w.airborne).toBe(true);
    expect(t.climbPrompt()?.kind).toBe('high');                      // 36 less the rise: within the table's 32
    t.action();
    w.tick(FORWARD);
    expect(events[0]).toEqual({ type: 'climbStart', kind: 'high' });
    expect(w.airborne).toBe(false);                                   // the climb holds it: the jump and its fall are over
    expect(w.action).toBeNull();
    run(w, FORWARD, () => t.state().kind === 'none', 800);
    expect(w.state.y).toBeCloseTo(36, 6);
    expect(w.action).toBeNull();
  });

  it('does not climb prone, or facing away', () => {
    const { grid, polys } = climbWorld(12, 4);
    const { w, t } = climber(polys, grid);
    run(w, FORWARD, () => t.climbPrompt() !== null, 120);
    w.stance = 'prone';
    w.tick(STILL);
    expect(t.climbPrompt()).toBeNull();
    w.stance = 'stand';
    w.state.yaw = 180;
    w.tick(STILL);
    expect(t.climbPrompt()).toBeNull();
  });
});

describe.skipIf(!MP2)(`Frostfire climbables${MP2 ? '' : ` (${FIXTURES_ABSENT})`}`, () => {
  it('climbs the 11.9 crate at x 922.8-940.6, z 761-778.1 (appflags 4) from x 938 and hangs onto the 30 container at x 680-720, z 640-680', async () => {
    const map = await loadMap(new FsAssetSource(FIXTURES), 'RUN/MP2.ZDB');
    const grid = groundGrid(map.ground!);
    const polys = groundPolygons(map.ground!);
    const w = new Walker(grid);
    const t = new Traversal(grid, polys);
    w.driver = t;
    expect(w.place(938, 115, 790)).toBe(true);
    expect(w.state.y).toBe(100);
    w.state.yaw = 0;                                                 // facing -z, the crate side at z 778.1
    run(w, FORWARD, () => t.climbPrompt() !== null, 120);
    expect(t.climbPrompt()?.kind).toBe('low');
    t.action();
    w.tick(STILL);
    run(w, STILL, () => t.state().kind === 'none', 400);
    expect(w.state.y).toBeCloseTo(111.85, 2);
    expect(w.state.z).toBeLessThan(778.1);

    expect(w.place(700, 115, 700)).toBe(true);
    w.state.yaw = 0;
    run(w, FORWARD, () => t.climbPrompt() !== null, 120);
    expect(t.climbPrompt()?.kind).toBe('high');
    t.action();
    w.tick(FORWARD);
    run(w, FORWARD, () => t.state().kind === 'none', 800);
    expect(w.state.y).toBeCloseTo(130, 3);
  });
});

// ---- the peek (research 86 section 4) and the water (section 5) --------------------------------------------------

describe('the peek (research 86 section 4)', () => {
  const plain = (): { grid: Grid; polys: WorldPoly[] } => { const polys = [floor(-100, -100, 100, 100, 0)]; return { grid: world(polys), polys }; };

  it('eases the camera peek to the side at cam_peek_decay_rate 6, holds the lean clip, and holds the mover still', () => {
    const { grid, polys } = plain();
    const w = new Walker(grid);
    const t = new Traversal(grid, polys);
    w.driver = t;
    w.place(0, 10, 0);
    t.lean(1);
    for (let i = 0; i < 30; i++) w.tick(STILL);                      // half a second
    expect(t.peek()).toBeCloseTo(1 - Math.exp(-6 * 30 * TICK), 6);   // 0.95
    expect(t.pose()?.clip).toBe('seal_stand2rlean');
    const at = [w.state.x, w.state.z];
    for (let i = 0; i < 30; i++) w.tick(FORWARD);                    // no locomotion while peeking (FUN_005870e0 case 3)
    expect([w.state.x, w.state.z]).toEqual(at);
    t.lean(0);
    for (let i = 0; i < 60; i++) w.tick(STILL);
    expect(t.peek()).toBeLessThan(0.01);
    expect(t.pose()).toBeNull();
    t.lean(-1);
    w.stance = 'crouch';
    w.tick(STILL);
    expect(t.pose()?.clip).toBe('seal_crouch2llean');
    w.stance = 'prone';
    for (let i = 0; i < 30; i++) w.tick(STILL);
    expect(t.pose()?.clip).toBe('seal_prone2llean');
    expect(t.peek()).toBeLessThan(-0.9);                             // prone peeks shift the camera too (state 3)
  });

  it('does not start a peek on the move, or into a wall within the side ray (9.5 right, 7.8375 left)', () => {
    const polys = [floor(-100, -100, 100, 100, 0), quad([8, 0, -50, 8, 0, 50, 8, 30, 50, 8, 30, -50], 2)];
    const grid = world(polys);
    const w = new Walker(grid);
    const t = new Traversal(grid, polys);
    w.driver = t;
    w.place(0, 10, 0);
    w.state.yaw = 0;                                                 // right is +x: the wall 8 away
    t.lean(1);
    w.tick(STILL);
    expect(t.pose()).toBeNull();
    t.lean(-1);                                                      // left is clear
    w.tick(FORWARD);
    expect(t.pose()).toBeNull();                                     // moving: no peek
    w.tick(STILL);
    expect(t.pose()?.clip).toBe('seal_stand2llean');
  });
});

describe('the water (research 86 section 5)', () => {
  /** The bed at 0, a water surface (material 11) over it at `depth`, x in -50..50. */
  const pool = (depth: number): { grid: Grid; polys: WorldPoly[] } => {
    const water = { ...floor(-50, -50, 50, 50, depth), material: 11 };
    const polys = [floor(-100, -100, 100, 100, 0), water];
    return { grid: world(polys), polys };
  };

  it('wades on the bed, the stick at clamp(1 - 0.05 depth, 0.75, 1), and stands the SEAL up in deep water', () => {
    const { grid, polys } = pool(6);
    const w = new Walker(grid);
    const t = new Traversal(grid, polys);
    w.driver = t;
    const events: TraversalEvent[] = [];
    t.on((e) => events.push(e));
    expect(w.place(0, 20, 0)).toBe(true);
    expect(w.state.y).toBe(0);                                       // the water is no floor
    w.state.yaw = 90;
    for (let i = 0; i < 60; i++) w.tick(FORWARD);
    expect(t.depth()).toBeCloseTo(6, 6);
    expect(events[0]).toEqual({ type: 'waterEnter', depth: 6 });
    expect(t.stickFactor(w)).toBeCloseTo(0.75, 6);                   // 1 - 0.3 = 0.7, floored at 0.75
    expect(Math.hypot(w.state.vx, w.state.vz)).toBeCloseTo(65 * 0.75, 1);
    w.stance = 'prone';
    w.tick(STILL);
    expect(w.stance).toBe('crouch');                                 // prone only to 2 deep
    const shallow = pool(1);
    const v = new Walker(shallow.grid);
    const u = new Traversal(shallow.grid, shallow.polys);
    v.driver = u;
    v.place(0, 20, 0);
    v.tick(STILL);
    expect(u.stickFactor(v)).toBeCloseTo(0.95, 6);
  });
});

describe('the stance press in water, as FUN_00581660 / FUN_00581990 take it (issue #22)', () => {
  const pool = (depth: number): { w: Walker; t: Traversal } => {
    const water = { ...floor(-50, -50, 50, 50, depth), material: 11 };
    const polys = [floor(-100, -100, 100, 100, 0), water];
    const grid = world(polys);
    const w = new Walker(grid);
    const t = new Traversal(grid, polys);
    w.driver = t;
    expect(w.place(0, 20, 0)).toBe(true);
    for (let i = 0; i < 60; i++) w.tick(STILL);
    return { w, t };
  };

  it('over 2 deep, a prone press crouches -- no prone clip, no root motion -- from crouch it changes nothing', () => {
    const { w } = pool(5);
    w.changeStance('prone');
    expect(w.stance).toBe('crouch');                                  // FUN_00581660 -> FUN_00581990 from stand
    expect(w.action?.name).toBe('standToCrouch');
    for (let i = 0; i < 120; i++) w.tick(STILL);
    const at = [w.state.x, w.state.z];
    w.changeStance('prone');                                          // crouched: FUN_00581990 finds stance 1, nothing
    expect(w.stance).toBe('crouch');
    expect(w.action).toBeNull();
    for (let i = 0; i < 360; i++) w.tick(STILL);
    expect([w.state.x, w.state.z]).toEqual(at);
  });

  it('over 8.5 deep, a prone or a crouch press stands (FUN_00581990 -> FUN_00581c10); 2 deep or less, prone as ever', () => {
    const deep = pool(9).w;
    deep.changeStance('crouch');
    expect(deep.stance).toBe('stand');
    expect(deep.action).toBeNull();
    deep.changeStance('prone');
    expect(deep.stance).toBe('stand');
    expect(deep.action).toBeNull();
    const shallow = pool(2).w;
    shallow.changeStance('prone');
    expect(shallow.stance).toBe('prone');
    expect(shallow.action?.name).toBe('standToProne');
  });
});

/**
 * Issue #22's three spawns: each is under water (5.3, 3.8 and 4.3 deep) on ground under 20 degrees, not a steep slope.
 * The maps are read from the served tree `npm run extract-maps` fills (`public/maps/RUN`), not the fixtures' three.
 */
const SERVED = resolve(FIXTURES, '../public/maps');
const WATER_SPAWNS = [['MP62', 'ENOWAPI'], ['MP64', 'SHADOW FALLS'], ['MP71', 'FISH HOOK']] as const;
for (const [m, name] of WATER_SPAWNS) {
  const there = existsSync(resolve(SERVED, `RUN/${m}.ZDB`));
  describe.skipIf(!there)(`${name}'s spawn A in the water (issue #22)${there ? '' : ` (${FIXTURES_ABSENT})`}`, () => {
    it('a prone press crouches there and the SEAL stays put with no input', async () => {
      const map = await loadMap(new FsAssetSource(SERVED), `RUN/${m}.ZDB`);
      const grid = groundGrid(map.ground!);
      const w = new Walker(grid);
      const t = new Traversal(grid, groundPolygons(map.ground!));
      w.driver = t;
      if (PACK) { const sim = simClipsFromBytes(PACK, fixture('RUN/READERC.ZAR')); t.setClips(sim.clips, sim.table); w.actionRoots = sim.roots; }
      const stand = map.stand!;
      expect(w.place(stand.position[0], stand.floor! + 15.4, stand.position[2])).toBe(true);
      for (let i = 0; i < 60; i++) w.tick(STILL);
      expect(t.depth()).toBeGreaterThan(2);
      expect(t.depth()).toBeLessThan(8.5);
      const at = [w.state.x, w.state.z];
      w.changeStance('crouch');
      for (let i = 0; i < 90; i++) w.tick(STILL);
      const crouched = [w.state.x, w.state.z];
      w.changeStance('prone');                                        // the hold of C, or setStance('prone')
      expect(w.stance).toBe('crouch');
      expect(w.action).toBeNull();
      for (let i = 0; i < 360; i++) w.tick(STILL);                    // 6 s, no input
      expect([w.state.x, w.state.z]).toEqual(crouched);
      expect(Math.hypot(w.state.x - at[0]!, w.state.z - at[1]!)).toBeLessThan(3);   // the crouch clip's own root only
    });
  });
}

// ---- round 3: the head's "180" and slide, the hang's let-go (research 86 sections 2.4, 3.7) --------------------------

describe('the ladder head, as the game plays it (research 86 section 2.4)', () => {
  it('turns with "180" (0.883 s, by code) before the reversed climb-off when the SEAL faces the ladder from the deck', () => {
    const { grid, polys } = ladderWorld();
    const w = new Walker(grid);
    const t = new Traversal(grid, polys);
    w.driver = t;
    w.place(0, 60, -20); w.state.yaw = 180;                          // on the deck, walking toward the ladder (+z)
    run(w, FORWARD, () => t.state().kind !== 'none', 400);
    expect(t.state().kind).toBe('turn180');
    expect(t.pose()?.holdRootTurn).toBe(true);
    const ticks = run(w, STILL, () => t.state().kind !== 'turn180', 200);
    expect(ticks * TICK).toBeCloseTo(0.95 * (27 / 28) ** 2, 1);      // FUN_0028c4f0 on seal_180's 28 keys
    expect(((w.state.yaw % 360) + 360) % 360).toBeCloseTo(0, 6);     // facing the climb-off's way
    expect(t.state().kind).toBe('ladderMountTop');
    // Backing onto it needs no turn.
    const v = new Walker(grid), u = new Traversal(grid, polys);
    v.driver = u;
    v.place(0, 60, -20); v.state.yaw = 0;
    run(v, BACK, () => u.state().kind !== 'none', 400);
    expect(u.state().kind).toBe('ladderMountTop');
  });

  it('slides from the head with the action held in the reversed climb-off\'s last 0.2 (FUN_00582540)', () => {
    const { grid, polys } = ladderWorld();
    const w = new Walker(grid);
    const t = new Traversal(grid, polys);
    w.driver = t;
    w.place(0, 60, -20); w.state.yaw = 0;
    run(w, BACK, () => t.state().kind === 'ladderMountTop', 400);
    t.holdAction(true);
    run(w, STILL, () => t.state().kind !== 'ladderMountTop', 400);
    expect(t.state().kind).toBe('ladderSlide');                     // straight into "Ladderslide", no "Ladder -> slide"
    expect(w.state.z).toBeCloseTo(0.2 + LADDER_STANDOFF, 6);
    run(w, STILL, () => t.state().kind === 'none', 800);
    expect(w.state.y).toBe(0);
  });
});

describe('the hang, as the game plays it (research 86 section 3.7)', () => {
  const hanging = (): { w: Walker; t: Traversal; events: TraversalEvent[] } => {
    const { grid, polys } = climbWorld(30, 1);
    const k = climber(polys, grid);
    if (PACK) k.t.setClips(PACK_CLIPS(), null);                    // the disc's own clips: the push's real rise
    run(k.w, FORWARD, () => k.t.climbPrompt() !== null, 120);
    k.t.action();
    run(k.w, STILL, () => k.t.state().kind === 'hang', 400);
    return k;
  };

  it('holds with the stick at rest, and lets go on the stick back: the push off the wall, then the walk\'s fall', () => {
    const { w, t, events } = hanging();
    for (let i = 0; i < 120; i++) w.tick(STILL);
    expect(t.state().kind).toBe('hang');                            // no timer
    const z0 = w.state.z, y0 = w.state.y;
    w.tick(BACK);
    expect(t.state().kind).toBe('hangDown');
    run(w, STILL, () => t.state().kind !== 'hangDown', 200);
    expect(t.state().kind).toBe('hangDropFall');
    expect(w.state.z).toBeGreaterThan(z0);                          // pushed back from the wall
    if (PACK) expect(w.state.y).toBeGreaterThan(y0);                // the push rises (the root 18.82 up to 21.3)
    expect(w.airborne).toBe(true);
    expect(t.pose()?.clip).toBe('seal_hang_jumpdown');
    run(w, STILL, () => !w.airborne, 400);
    expect(w.state.y).toBe(0);
    expect(events.map((e) => e.type)).toContain('climbEnd');
  });

  it('lets go on the jump and on a crouch; climbs on a stand', () => {
    const a = hanging();
    expect(a.t.jump(a.w)).toBe(true);
    a.w.tick(STILL);
    expect(['hangDown', 'hangDropFall']).toContain(a.t.state().kind);
    const b = hanging();
    expect(b.t.stanceButton(b.w, 'crouch')).toBe(true);
    b.w.tick(STILL);
    expect(['hangDown', 'hangDropFall']).toContain(b.t.state().kind);
    const c = hanging();
    expect(c.t.stanceButton(c.w, 'stand')).toBe(true);
    expect(c.t.state().kind).toBe('hangUp');
    run(c.w, STILL, () => c.t.state().kind === 'none', 400);
    expect(c.w.state.y).toBeCloseTo(30, 6);
  });
});

describe('the climb, as the game weighs it (research 86 section 3.3)', () => {
  it('plays the crate and the medium as one play between 12 and 26.5, the crate at 1 - (h - 12) / 14.5', () => {
    const { grid, polys } = climbWorld(18, 1);
    const { w, t } = climber(polys, grid);
    run(w, FORWARD, () => t.climbPrompt() !== null, 120);
    t.action();
    run(w, STILL, () => t.state().kind === 'climb', 120);
    const pose = t.pose()!;
    expect(pose.clip).toBe('seal_climbcrate');
    expect(pose.blend?.clip).toBe('seal_climb_medium');
    expect(pose.blend?.weight).toBeCloseTo(1 - 6 / 14.5, 6);
    run(w, STILL, () => t.state().kind === 'none', 400);
    expect(w.state.y).toBeCloseTo(18, 6);
  });

  it('adds the contact material\'s FOOT_STEP_OFFSET to the height: 12.5 of grass is an 11.7 crate climb, not a blend', () => {
    const polys = [floor(-100, -100, 100, 100, 0), ...box(-10, -30, 10, 0, 12.5, 1).map((p) => ({ ...p, material: 4 }))];
    const grid = world(polys);
    const { w, t } = climber(polys, grid);
    run(w, FORWARD, () => t.climbPrompt() !== null, 120);
    t.action();
    run(w, STILL, () => t.state().kind === 'climb', 120);
    expect(t.pose()?.blend).toBeUndefined();
    expect(t.pose()?.clip).toBe('seal_climbcrate');
  });

  it('the obstacle ray (FUN_0054e430): a wall standing at the ledge\'s top replaces the contact, and a plain wall is not climbed', () => {
    const wall = quad([-10, 12, -0.2, 10, 12, -0.2, 10, 40, -0.2, -10, 40, -0.2], 2, 0, 'worldmodel/wall');
    const polys = [floor(-100, -100, 100, 100, 0), ...box(-10, -30, 10, 0, 12, 4), wall];
    const grid = world(polys);
    const { w, t } = climber(polys, grid);
    run(w, FORWARD, () => false, 60);
    expect(t.climbPrompt()).toBeNull();
  });
});

describe('the dive (research 86 section 6.1)', () => {
  const plain = (): { grid: Grid; polys: WorldPoly[] } => { const polys = [floor(-200, -200, 200, 200, 0)]; return { grid: world(polys), polys }; };

  it('dives from a run into prone: the run kept, the root down at gravity after 0.2 s, the speed bled at 150', () => {
    const { grid, polys } = plain();
    const w = new Walker(grid);
    const t = new Traversal(grid, polys);
    w.driver = t;
    w.place(0, 10, 100); w.state.yaw = 0;
    run(w, FORWARD, () => Math.hypot(w.state.vx, w.state.vz) > 60, 60);
    const v0 = Math.hypot(w.state.vx, w.state.vz), z0 = w.state.z;
    expect(t.dive(w)).toBe(true);
    expect(w.stance).toBe('prone');
    expect(t.pose()?.clip).toBe('seal_dive2prone');
    const ticks = run(w, FORWARD, () => t.state().kind === 'none', 200);
    const fall = Math.sqrt((2 * (11.484 - 2.2)) / 235);
    expect(ticks * TICK).toBeCloseTo(0.2 + fall + v0 / 150, 1);
    expect(z0 - w.state.z).toBeCloseTo(v0 * (0.2 + fall) + (v0 * v0) / 300, -1);
    expect(w.stance).toBe('prone');
  });

  it('is refused walking (under 30 a second), prone, or in water over 2 deep', () => {
    const { grid, polys } = plain();
    const w = new Walker(grid);
    const t = new Traversal(grid, polys);
    w.driver = t;
    w.place(0, 10, 100); w.state.yaw = 0;
    run(w, { forward: 0.3, right: 0, boost: false }, () => false, 60);
    expect(t.dive(w)).toBe(false);
    w.stance = 'prone';
    expect(t.dive(w)).toBe(false);
  });
});

describe('the ground and the water on the stick, and the ripples (research 86 section 5.3)', () => {
  it('slows each axis going uphill by 1 - d^2 (FUN_005b56c0), not downhill or across', () => {
    // A 30-degree ramp rising toward -z: its normal (0, cos 30, sin 30) tilts toward +z, back at a mover going up it.
    const k = Math.tan(Math.PI / 6);
    const ramp = quad([-100, 0, 0, 100, 0, 0, 100, 100 * k, -100, -100, 100 * k, -100], 3);
    const polys = [ramp, floor(-100, 0, 100, 100, 0)];
    const grid = world(polys);
    const w = new Walker(grid);
    const t = new Traversal(grid, polys);
    w.driver = t;
    w.place(0, 60, -40); w.state.yaw = 0;
    const d = Math.sin(Math.PI / 6);
    const [up] = t.stickScale(w, 1, 0);
    expect(up).toBeCloseTo(1 - d * d, 3);                            // 0.75 up a 30-degree ramp
    expect(t.stickScale(w, -1, 0)[0]).toBeCloseTo(-1, 6);           // down it: no factor
    expect(t.stickScale(w, 0, 1)[1]).toBeCloseTo(1, 6);             // across it: no factor
  });

  it('asks for the big ripple with the water between the feet and the body\'s top, the small within 10 over it', () => {
    const at = (depth: number, pace = 0): ReturnType<Traversal['ripple']> => {
      const water = { ...floor(-50, -50, 50, 50, depth), material: 11 };
      const polys = [floor(-100, -100, 100, 100, 0), water];
      const grid = world(polys);
      const w = new Walker(grid);
      const t = new Traversal(grid, polys);
      w.driver = t;
      w.place(0, 40, 0); w.state.yaw = 0;
      for (let i = 0; i < 30; i++) w.tick({ forward: pace, right: 0, boost: false });
      return t.ripple();
    };
    expect(at(6)).toEqual({ size: 'big', pace: 'anim', at: [0, 6, 0] });
    expect(at(6, 1)?.pace).toBe('run');
    expect(at(25)?.size).toBe('small');                            // over the 19.6 top, within 10
    expect(at(35)).toBeNull();                                      // 10 or more over it: nothing
    expect(rippleAnimation({ size: 'big', pace: 'walk' })).toBe('big_ripple_anim_walk');
    expect(rippleAnimation({ size: 'small', pace: 'anim' })).toBe('small_ripple_anim');
  });
});
