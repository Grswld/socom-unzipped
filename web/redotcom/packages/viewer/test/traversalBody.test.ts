import { describe, expect, it } from 'vitest';
import { parseZdb, Zar, zdbMember } from '@s2u/archive';
import { buildGrid, readSkeleton, type CollisionOwner, type Grid, type GridParams, type Skeleton, type WorldPoly } from '@s2u/scene';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { Animator, PLAY_CLIPS } from '../src/animator';
import { clipsFromPack, motionTableFromArchive, type MotionEntry } from '../src/motionTable';
import { moverSnapshot, rootY } from '../src/mover';
import { actorToWorld } from '../src/play';
import { INIT_AIM_PITCH, PlayerCamera } from '../src/playerCamera';
import { Traversal, TRAVERSAL_CLIPS } from '../src/traversal';
import { TICK, Walker, type WalkInput } from '../src/walk';
import type { MotionClip } from '@s2u/scene';

/**
 * The traversal moves drawn on Frostfire's SEAL with the disc's clips (web research 86): where the body's hands and the
 * camera are, tick by tick, as the owner saw them (2026-09-29) -- the climb's hands against the ledge, the held peek's
 * view. The rules are pinned without the disc in `traversal.test.ts` and `playerCamera.test.ts`.
 */

const MP2 = fixture('RUN/MP2.ZDB'), PACK = fixture('RUN/MOTION_P.ZAR'), READERC = fixture('RUN/READERC.ZAR');
const noData = !MP2 || !PACK || !READERC;

const STILL: WalkInput = { forward: 0, right: 0, boost: false };
const FORWARD: WalkInput = { forward: 1, right: 0, boost: false };

const quad = (pts: number[], ditype: number, appflags = 0): WorldPoly => ({
  modelName: 'worldmodel', path: 'worldmodel/q', region: 0, ditype, material: 25, ptcount: 4, cameratype: 0, appflags, points: Float32Array.from(pts),
});
const floor = (x0: number, z0: number, x1: number, z1: number, y: number): WorldPoly => quad([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1], 3);
function world(polys: WorldPoly[]): Grid {
  const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 4, cellsZ: 4, originX: -200, originZ: -200 };
  const owners: CollisionOwner[] = polys.map((p, i) => ({ modelName: p.modelName, path: `${p.path}${i}`, first: i, count: 1 }));
  return buildGrid(params, [], [], polys, owners);
}
/** The 0 floor and a box x -10..10, z -30..0, `h` tall, its sides climbable by the height (appflags 1). */
function boxWorld(h: number): { grid: Grid; polys: WorldPoly[] } {
  const polys = [
    floor(-100, -100, 100, 100, 0),
    quad([-10, 0, 0, 10, 0, 0, 10, h, 0, -10, h, 0], 2, 1), quad([-10, 0, -30, 10, 0, -30, 10, h, -30, -10, h, -30], 2, 1),
    quad([-10, 0, -30, -10, 0, 0, -10, h, 0, -10, h, -30], 2, 1), quad([10, 0, -30, 10, 0, 0, 10, h, 0, 10, h, -30], 2, 1),
    floor(-10, -30, 10, 0, h),
  ];
  return { grid: world(polys), polys };
}

let loaded: { sk: Skeleton; clips: MotionClip[]; table: Map<string, MotionEntry> } | null = null;
function body(): { sk: Skeleton; clips: MotionClip[]; table: Map<string, MotionEntry> } {
  if (loaded) return loaded;
  const toc = parseZdb(MP2!);
  const sk = readSkeleton(Zar.parse(zdbMember(MP2!, toc, 'CLIB_GEO.ZED')), 'seal_A_scuba');
  return (loaded = { sk, clips: clipsFromPack(PACK!, [...PLAY_CLIPS, ...TRAVERSAL_CLIPS]), table: motionTableFromArchive(READERC!)! });
}
/** A part's origin in the body's frame as posed (x right, y up, z behind, the soles at 0). */
const part = (sk: Skeleton, name: string): [number, number, number] => {
  const m = sk.palette()[sk.indexOf(name)]!;
  return [m[12]!, m[13]!, m[14]!];
};

/**
 * Climbs the box from the floor with the disc's clips on the SEAL, and reads the higher hand against the ledge's top
 * at the pull -- the first tick the feet leave the floor, the hands on the edge -- and, for a hang, while it hangs.
 */
function climbHands(h: number): { pull: number; hang: number | null; clip: string } {
  const { sk, clips, table } = body();
  const { grid, polys } = boxWorld(h);
  const w = new Walker(grid), t = new Traversal(grid, polys);
  w.driver = t;
  t.setClips(clips, table);
  const anim = new Animator(sk, clips, table);
  w.place(0, 10, 12);
  w.state.yaw = 0;
  for (let i = 0; i < 120 && t.climbPrompt() === null; i++) { w.tick(FORWARD); anim.step(TICK, moverSnapshot(w, t, 0, 0)); }
  t.action();
  let pull: number | null = null, hang: number | null = null, clip = '';
  for (let i = 0; i < 400 && (pull === null || (h > 28 && hang === null)); i++) {
    w.tick(STILL);
    const snap = moverSnapshot(w, t, 0, 0);
    anim.step(TICK, snap);
    const hands = Math.max(actorToWorld(snap.feet, snap.yaw, part(sk, 'lhand'))[1], actorToWorld(snap.feet, snap.yaw, part(sk, 'rhand'))[1]);
    const st = t.state();
    if (st.kind === 'climb' && pull === null && snap.feet[1] > 0.5) { pull = hands - h; clip = st.clip ?? ''; }
    if (st.kind === 'hang') hang = hands - h;
  }
  return { pull: pull ?? NaN, hang, clip };
}

describe.skipIf(noData)(`the climb's hands meet the ledge (FUN_005b2d20's steer)${noData ? ` (${FIXTURES_ABSENT})` : ''}`, () => {
  it('at every height the table climbs -- Frostfire\'s 11.85 crates, 18.96 crates and 30 containers among them -- the hands take the ledge', () => {
    const rows = [10.5, 11.85, 12, 15, 18.96, 24, 26.5, 27.5, 28.5, 30, 31.5].map((h) => ({ h, ...climbHands(h) }));
    // Before the steer's lift the hands were +2.2 over a 10.5 ledge and -6.7 under a 27.5 one at the pull, and +5.9 over
    // Frostfire's 30 containers while hanging; now the clips' own grab: 0 to -0.1 for the crate, to -1.7 for the medium.
    for (const r of rows) {
      if (r.h > 28) expect(Math.abs(r.hang!), `h ${r.h}: the hands ${r.hang!.toFixed(2)} off the ledge hanging`).toBeLessThan(1);
      else expect(Math.abs(r.pull), `h ${r.h} (${r.clip}): the hands ${r.pull.toFixed(2)} off the ledge at the pull`).toBeLessThan(2);
    }
  });

  it('one clip puts its hands on the ledge alike at any height: the steer lifts or lowers the body, the clip is not stretched to it', () => {
    const crate = [10.5, 11.85].map((h) => climbHands(h).pull);
    expect(Math.abs(crate[0]! - crate[1]!)).toBeLessThan(0.3);
    const medium = [26.7, 28].map((h) => climbHands(h).pull);
    expect(Math.abs(medium[0]! - medium[1]!)).toBeLessThan(0.3);
    const hang = [28.5, 31.5].map((h) => climbHands(h).hang!);
    expect(Math.abs(hang[0]! - hang[1]!)).toBeLessThan(0.3);
  });
});

describe.skipIf(noData)(`the held peek keeps its view (FUN_0029a950, FUN_00297410)${noData ? ` (${FIXTURES_ABSENT})` : ''}`, () => {
  it('standing and crouched, left and right: the eye goes out and stays out, the aim parallel to the facing, as the lean clip holds', () => {
    const { sk, clips, table } = body();
    for (const stance of ['stand', 'crouch'] as const) for (const side of [1, -1] as const) {
      const grid = world([floor(-100, -100, 100, 100, 0)]);
      const w = new Walker(grid), t = new Traversal(grid, []);
      w.driver = t;
      t.setClips(clips, table);
      const anim = new Animator(sk, clips, table);
      w.place(0, 10, 0);
      w.stance = stance;
      w.state.yaw = 0;
      w.state.pitch = INIT_AIM_PITCH;
      for (let i = 0; i < 30; i++) { w.tick(STILL); anim.step(TICK, moverSnapshot(w, t, 0, 0)); }
      const cam = new PlayerCamera(grid);
      t.lean(side);
      let out = 0;
      for (let i = 0; i < 90; i++) {                                             // 1.5 s held
        w.tick(STILL);
        anim.step(TICK, moverSnapshot(w, t, 0, 0));
        cam.peek = t.peek();
        cam.tick([w.state.x, w.state.y, w.state.z], w.state.yaw, w.state.pitch, anim.rootY() ?? rootY(w.posture), TICK, true);
        const v = cam.view(1);
        const aim = (Math.atan2(v.far[0] - v.eye[0], -(v.far[2] - v.eye[2])) * 180) / Math.PI;
        expect(Math.abs(aim), `${stance} ${side} tick ${i}: the aim ${aim.toFixed(2)} degrees off the facing`).toBeLessThan(0.2);
        const lateral = v.eye[0] * side;
        expect(lateral, `${stance} ${side} tick ${i}: the eye came back in`).toBeGreaterThanOrEqual(out - 1e-6);
        out = lateral;
      }
      expect(out, `${stance} ${side}: the eye's shift at the held peek`).toBeGreaterThan(side > 0 ? 5.3 : 4.7);   // 2 x 2.8, 2 x 2.5
      expect(t.pose()?.clip).toBe(`seal_${stance}2${side > 0 ? 'r' : 'l'}lean`);
    }
  });
});
