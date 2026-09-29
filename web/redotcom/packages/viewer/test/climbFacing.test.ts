import { describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsAssetSource } from '@s2u/archive/node';
import { buildGrid, type CollisionOwner, type Grid, type GridParams, type WorldPoly } from '@s2u/scene';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { loadMap } from '../src/loadMap';
import { simClipsFromBytes } from '../src/simMap';
import { shortTurn, Traversal } from '../src/traversal';
import { groundGrid, groundPolygons, Walker, type WalkInput } from '../src/walk';

/**
 * The climb's facing (web research 86 section 3.8; the owner, 2026-09-29: "when I climbed a box my character model
 * turned around and climbed in the wrong direction"). The game turns the SEAL to the ledge by vectors -- `FUN_005b1a10`
 * (decomp 467938-467946) stores the contact's normal negated as the facing to reach, `FUN_005b2d20` (468637-468680)
 * takes the angle to it as `acos` of a dot and its side from a cross product -- so the turn is always the short way,
 * whatever the yaw's winding. The viewer took the turn as `((want - yaw + 540) % 360) - 180`, which for a yaw more than
 * 540 over `want` (the page's camera yaw is never wrapped: two turns to the left) comes out <= -180: the SEAL spun the
 * long way, `FUN_005b2d20`'s 46 ticks ran out mid-spin, and the clip played with the body up to 153 degrees off the ledge.
 *
 * Frostfire's crate `worldmodel/crates1/prop02` (x 922.8-940.6, z 761-778.1, top 111.85; appflags 4 on its sides): its
 * west face (x 922.8, the open side; inward +x, the plan's yaw -90) approached every way the brief names; its south
 * face sits in an inside corner with `prop01` (x 916.6-934.4, z 778.1-795.2, top 118.96), its north-west corner is an
 * outside one. For each: whether a climb is offered, the body's facing against the clip's own travel as it starts
 * (degrees off) and at its worst through it (the dot), and where the feet end.
 */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures');
const MP2 = fixture('RUN/MP2.ZDB');
const PACK = fixture('RUN/MOTION_P.ZAR');

const STILL: WalkInput = { forward: 0, right: 0, boost: false };
const input = (forward: number, right = 0): WalkInput => ({ forward, right, boost: false });

let hull: { grid: Grid; polys: WorldPoly[] } | null = null;
async function frostfire(): Promise<{ grid: Grid; polys: WorldPoly[] }> {
  if (hull) return hull;
  const map = await loadMap(new FsAssetSource(FIXTURES), 'RUN/MP2.ZDB');
  return (hull = { grid: groundGrid(map.ground!), polys: groundPolygons(map.ground!) });
}

interface Approach {
  /** A climb was offered (the icon) and its clip played on the press. */
  climbed: boolean;
  /** The body's facing against the clip's own travel (start to end, horizontal) as the clip starts, degrees off. */
  offAtClip: number;
  /** The worst dot of the body's facing with the feet's travel, tick to tick, through the clip (1 = straight ahead). */
  worst: number;
  /** Where the feet end. */
  end: [number, number, number];
}

/** The mover's forward on the ground at a yaw (`walk.ts`: forward is (-sin, -cos)). */
const forward = (yaw: number): [number, number] => [-Math.sin((yaw * Math.PI) / 180), -Math.cos((yaw * Math.PI) / 180)];

/** From (x, z) on the floor at `yaw`, `move` held until the icon shows (at most `ticks`), `pre` still ticks, the press, the move to its end. */
async function approach(x: number, z: number, yaw: number, move: WalkInput, ticks = 120, pre = 0): Promise<Approach> {
  const { grid, polys } = await frostfire();
  const w = new Walker(grid), t = new Traversal(grid, polys);
  w.driver = t;
  if (PACK) { const sim = simClipsFromBytes(PACK, fixture('RUN/READERC.ZAR')); t.setClips(sim.clips, sim.table); w.actionRoots = sim.roots; }
  expect(w.place(x, 115, z)).toBe(true);
  w.state.yaw = yaw;
  for (let i = 0; i < ticks && t.climbPrompt() === null; i++) w.tick(move);
  for (let i = 0; i < pre; i++) w.tick(STILL);
  const out: Approach = { climbed: false, offAtClip: NaN, worst: 1, end: [w.state.x, w.state.y, w.state.z] };
  if (t.climbPrompt() !== null) {
    t.action();
    let start: { x: number; z: number; yaw: number } | null = null, last: [number, number] | null = null;
    for (let i = 0; i < 600; i++) {
      w.tick(STILL);
      const k = t.state().kind;
      if (k === 'climb') {
        out.climbed = true;
        start ??= { x: w.state.x, z: w.state.z, yaw: w.state.yaw };
        if (last) {
          const dx = w.state.x - last[0], dz = w.state.z - last[1], d = Math.hypot(dx, dz);
          const [fx, fz] = forward(w.state.yaw);
          if (d > 0.05) out.worst = Math.min(out.worst, (fx * dx + fz * dz) / d);
        }
        last = [w.state.x, w.state.z];
      } else if (out.climbed) break;
    }
    out.end = [w.state.x, w.state.y, w.state.z];
    if (start) {
      const dx = out.end[0] - start.x, dz = out.end[2] - start.z, d = Math.hypot(dx, dz);
      const [fx, fz] = forward(start.yaw);
      out.offAtClip = (Math.acos(Math.max(-1, Math.min(1, (fx * dx + fz * dz) / d))) * 180) / Math.PI;
    }
  }
  if (process.env.CLIMB_DEBUG) console.log(JSON.stringify({ x, z, yaw, move, pre, ...out }));
  return out;
}

/** The west face: x 922.8, z 761-778.1, the crate's top 111.85; the plan's yaw faces it at -90. */
const WEST_X = 922.8, MID_Z = 769.5, TOP = 111.85, WEST = -90;
/** `FUN_005b2d20` stops steering at facing > 0.993: 6.8 degrees. */
const ALIGNED = (Math.acos(0.993) * 180) / Math.PI;

/** Where to start at `yaw` so a walk of `back` across x meets the west face at z `at`. */
function startFor(yaw: number, back = 5.5, at = MID_Z): [number, number] {
  const [fx, fz] = forward(yaw);
  return [WEST_X - back, at - (fz / fx) * back];
}

/** A climb that faces the way the clip carries it and ends on the top, past the edge. */
function climbsRight(r: Approach, label: string, top = TOP): void {
  expect(r.climbed, `${label}: climbed`).toBe(true);
  expect(r.offAtClip, `${label}: degrees off the clip's travel as it starts`).toBeLessThan(ALIGNED + 0.5);
  expect(r.worst, `${label}: the body against its travel through the clip`).toBeGreaterThan(0.95);
  expect(r.end[1], `${label}: on the top`).toBeCloseTo(top, 2);
}

describe.skipIf(!MP2)(`the climb's facing on Frostfire's crate (research 86 section 3.8)${MP2 ? '' : ` (${FIXTURES_ABSENT})`}`, () => {
  it('(a) head on: faces the ledge through the clip and ends on the top, past the west edge', async () => {
    const [x, z] = startFor(WEST);
    const r = await approach(x, z, WEST, input(1));
    climbsRight(r, 'head on');
    expect(r.end[0]).toBeGreaterThan(WEST_X);
  });

  it('(b) walking backwards into it and (c) strafing into it: nothing is offered (the facing test, >= 0.3; 469213-469218)', async () => {
    // Yaw 90 faces -x: the stick back walks +x, into the face. Yaw 0 faces -z: right is +x; yaw 180: left is.
    expect((await approach(WEST_X - 5.5, MID_Z, 90, input(-1))).climbed, 'backwards').toBe(false);
    expect((await approach(WEST_X - 5.5, MID_Z, 0, input(0, 1))).climbed, 'strafing right').toBe(false);
    expect((await approach(WEST_X - 5.5, MID_Z, 180, input(0, -1))).climbed, 'strafing left').toBe(false);
  });

  it('(d) at 30 and 60 degrees to the face the SEAL turns to it the short way and climbs; at 85 nothing is offered', async () => {
    for (const a of [30, -30, 60, -60]) {
      const [x, z] = startFor(WEST + a, 5.5, Math.abs(a) > 45 ? 765 : MID_Z);   // clear of prop01 (z >= 778.1) at 60
      climbsRight(await approach(x, z, WEST + a, input(1)), `${a} degrees`);
    }
    for (const a of [85, -85]) {
      expect((await approach(WEST_X - 3.6, MID_Z, WEST + a, STILL, 10)).climbed, `${a} degrees`).toBe(false);
    }
  });

  it('(e) at corners -- the south face\'s inside corner with prop01, the north-west outside corner: whichever face, the body faces it', async () => {
    for (const a of [0, 30, -30]) {
      const r = await approach(937.5 - forward(a)[0] / -forward(a)[1] * 5.5, 783.6, a, input(1));
      if (!r.climbed) continue;
      expect(r.offAtClip, `inside corner at ${a}: degrees off the clip's travel`).toBeLessThan(ALIGNED + 0.5);
      expect(r.worst, `inside corner at ${a}: the body against its travel`).toBeGreaterThan(0.95);
      expect([111.85, 118.96].some((y) => Math.abs(r.end[1] - y) < 0.01), `inside corner at ${a}: on a top, ${r.end[1]}`).toBe(true);
    }
    for (const a of [-135, -120, -150]) {
      const [fx, fz] = forward(a);
      const r = await approach(922.8 - fx * 8, 761 - fz * 8, a, input(1));
      climbsRight(r, `outside corner at ${a}`);
    }
  });

  it('(f) the look wound round (the page\'s camera yaw is never wrapped: 360 k + a): the same climb as at a', async () => {
    for (const wind of [360, 720, 1080, -360, -720]) for (const a of [0, -30, 30, 60, -60]) {
      const [x, z] = startFor(WEST + a, 5.5, Math.abs(a) > 45 ? 765 : MID_Z);
      climbsRight(await approach(x, z, wind + WEST + a, input(1)), `yaw ${wind} + ${WEST + a}`);
    }
  });

  it('(g) standing against it, then the press: faces it and climbs, the look wound round or not', async () => {
    const [x, z] = startFor(WEST);
    climbsRight(await approach(x, z, WEST, input(1), 120, 30), 'still, then pressed');
    climbsRight(await approach(x, z, 720 + WEST, input(1), 120, 30), 'still at yaw 630, then pressed');
  });
});

// ---- without the disc: a synthetic box and ladder, the same rule (CI runs these) ----------------------------------

const quad = (pts: number[], ditype: number, appflags = 0, path = 'worldmodel/q'): WorldPoly => ({
  modelName: 'worldmodel', path, region: 0, ditype, material: 25, ptcount: 4, cameratype: 0, appflags, points: Float32Array.from(pts),
});
const floor = (x0: number, z0: number, x1: number, z1: number, y: number): WorldPoly => quad([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1], 3);
function world(polys: WorldPoly[]): Grid {
  const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 4, cellsZ: 4, originX: -200, originZ: -200 };
  const owners: CollisionOwner[] = polys.map((p, i) => ({ modelName: p.modelName, path: `${p.path}${i}`, first: i, count: 1 }));
  return buildGrid(params, [], [], polys, owners);
}

describe("the turn to the ledge is the short one, whatever the yaw's winding (FUN_005b2d20, 468637-468680)", () => {
  it('shortTurn: the signed short way in [-180, 180), for any winding of either yaw', () => {
    expect(shortTurn(0, 30)).toBeCloseTo(30, 9);
    expect(shortTurn(700, 0)).toBeCloseTo(20, 9);                 // the old ((to - from + 540) % 360) - 180 gave -340
    expect(shortTurn(630, -90)).toBeCloseTo(0, 9);                // gave -360
    expect(shortTurn(-700, 0)).toBeCloseTo(-20, 9);
    expect(shortTurn(10, 190)).toBeCloseTo(-180, 9);
    for (let from = -1500; from <= 1500; from += 37) for (let to = -180; to <= 180; to += 23) {
      const d = shortTurn(from, to);
      expect(d).toBeGreaterThanOrEqual(-180);
      expect(d).toBeLessThan(180);
      const m = (((from + d - to) % 360) + 360) % 360;                // lands on `to`, modulo whole turns
      expect(Math.min(m, 360 - m)).toBeCloseTo(0, 6);
    }
  });

  it('a 12 crate (appflags 4) walked into after two turns to the left (yaw 700): turned 20 degrees, not spun, and climbed facing it', () => {
    const polys = [
      floor(-100, -100, 100, 100, 0),
      quad([-10, 0, 0, 10, 0, 0, 10, 12, 0, -10, 12, 0], 2, 4), quad([-10, 0, -30, 10, 0, -30, 10, 12, -30, -10, 12, -30], 2, 4),
      quad([-10, 0, -30, -10, 0, 0, -10, 12, 0, -10, 12, -30], 2, 4), quad([10, 0, -30, 10, 0, 0, 10, 12, 0, 10, 12, -30], 2, 4),
      floor(-10, -30, 10, 0, 12),
    ];
    const grid = world(polys);
    for (const yaw of [-20, 700, 1060, 340, -380]) {
      const w = new Walker(grid), t = new Traversal(grid, polys);
      w.driver = t;
      w.place(0, 10, 6);
      w.state.yaw = yaw;
      for (let i = 0; i < 120 && t.climbPrompt() === null; i++) w.tick(input(1));
      expect(t.climbPrompt()?.kind, `yaw ${yaw}`).toBe('low');
      t.action();
      let turned = 0, prev = w.state.yaw;
      for (let i = 0; i < 600 && t.state().kind !== 'climb'; i++) { w.tick(STILL); turned += Math.abs(w.state.yaw - prev); prev = w.state.yaw; }
      expect(t.state().kind, `yaw ${yaw}`).toBe('climb');
      expect(Math.cos((w.state.yaw * Math.PI) / 180), `yaw ${yaw}: faces -z (the face's inward normal) as the clip starts`).toBeGreaterThan(0.993);
      expect(turned, `yaw ${yaw}: the steer's turn`).toBeLessThan(21);
      for (let i = 0; i < 600 && t.state().kind !== 'none'; i++) w.tick(STILL);
      expect(w.state.y).toBeCloseTo(12, 6);
      expect(w.state.z).toBeLessThan(0);
    }
  });

  it(`backing onto a ladder's head after two turns (yaw 720): no "180" -- the SEAL already has its back to the edge`, () => {
    const polys = [
      floor(-100, 0, 100, 100, 0),
      floor(-100, -100, 100, 0, 40),
      quad([-100, 0, 0, 100, 0, 0, 100, 40, 0, -100, 40, 0], 2),
      quad([-3, 0, 0.2, 3, 0, 0.2, 3, 40, 0.2, -3, 40, 0.2], 2, 2, 'worldmodel/lad/ladder'),
      quad([3, 40, 0.2, -3, 40, 0.2, -3, 50, 0.2, 3, 50, 0.2], 2, 2, 'worldmodel/lad/ladder'),
    ];
    const grid = world(polys);
    for (const yaw of [0, 720, -720, 1080]) {
      const w = new Walker(grid), t = new Traversal(grid, polys);
      w.driver = t;
      w.place(0, 60, -20);
      w.state.yaw = yaw;
      for (let i = 0; i < 400 && t.state().kind === 'none'; i++) w.tick(input(-1));
      expect(t.state().kind, `yaw ${yaw}`).toBe('ladderMountTop');
    }
  });
});
