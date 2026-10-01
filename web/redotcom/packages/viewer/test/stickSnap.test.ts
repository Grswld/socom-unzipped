import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseZdb, Zar, zdbMember } from '@s2u/archive';
import { buildGrid, readSkeleton, type CollisionOwner, type GridParams, type MotionClip, type Skeleton, type WorldPoly } from '@s2u/scene';
import { fixture } from '../../archive/test/fixtures';
import { Animator, PLAY_CLIPS, type MoverSnapshot } from '../src/animator';
import { clipsFromPack, motionTableFromArchive, type MotionEntry } from '../src/motionTable';
import { moverSnapshot, throttleSnaps, Walker, STICK_SNAP_BLEND, type Stance, type WalkInput } from '../src/mover';
import { bodyOf, snapshotOf } from '../src/net/body';
import { decodeSnapshot, encodeSnapshot } from '../src/net/codec';

/**
 * The owner's bug (2026-09-29, playing): "run forward -> run forward-left -> let go of left causes a janky animation
 * cancel". The diagonal is one play -- `seal_run` and `seal_run_90l` sharing a phase by the stick's angle
 * (`FUN_00583030`) -- and letting go of a full lateral takes the stick back at once: `FUN_00586c10`'s snap (an axis past
 * 0.78 / 0.9 whose wish moves faster than 7.8 / 9 a second takes the wish), which in the game also snapshots the pose
 * and starts a 0.2 s cross-fade (`FUN_0028e3e0(actor+0x170)`, `actor+0x178 = actor+0x17c = 0x3e4ccccd`, decomp
 * 445051-445055). The viewer took the snap and not the cross-fade: the strafe's weight fell from half to none in a
 * tick, and the pose with it.
 */

const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 200, cellsX: 4, cellsZ: 4, originX: -400, originZ: -400 };
const floor: WorldPoly = {
  modelName: 'worldmodel', path: 'worldmodel/floor', region: 0, ditype: 3, material: 25, ptcount: 4, cameratype: 0,
  points: Float32Array.from([-400, 0, -400, 400, 0, -400, 400, 0, 400, -400, 0, 400]),
};
const owners: CollisionOwner[] = [{ modelName: floor.modelName, path: floor.path, first: 0, count: 1 }];
const walker = (stance: Stance = 'stand'): Walker => {
  const w = new Walker(buildGrid(params, [], [], [floor], owners));
  w.place(0, 20, 0);
  w.state.yaw = 0;
  if (stance !== 'stand') w.stance = stance;
  return w;
};
const keys = (forward: number, right: number): WalkInput => ({ forward, right, boost: false });

/** Ticks of the script, each a (ticks, input) run; the snap count after every tick. */
function snapsOver(w: Walker, script: [number, WalkInput][]): number[] {
  const out: number[] = [];
  for (const [n, input] of script) for (let i = 0; i < n; i++) { w.tick(input); out.push(w.stickSnaps); }
  return out;
}

describe('FUN_00586c10\'s snap and the cross-fade it starts (decomp 445043-445056)', () => {
  it('names a snap only for an axis past its threshold whose wish moves faster than the rate', () => {
    expect(throttleSnaps(-1, 0, 'right', 1 / 60)).toBe(true);        // let go of a full lateral
    expect(throttleSnaps(0.7, 0, 'right', 1 / 60)).toBe(false);      // under 0.78: the ramp runs it down
    expect(throttleSnaps(0, -1, 'right', 1 / 60)).toBe(false);       // pressing: the ramp
    expect(throttleSnaps(1, 0, 'forward', 1 / 60)).toBe(true);
    expect(throttleSnaps(0.85, 0, 'forward', 1 / 60)).toBe(false);   // under 0.9 on the forward axis
    expect(STICK_SNAP_BLEND).toBeCloseTo(0.2, 6);                    // 0x3e4ccccd
  });

  it('forward, forward-left, forward: a snap on the tick the left key is let go (and the mirror)', () => {
    for (const side of [-1, 1]) {
      const w = walker();
      const s = snapsOver(w, [[60, keys(1, 0)], [60, keys(1, side)], [30, keys(1, 0)]]);
      expect(s[59]).toBe(0);                                         // the forward ramp: 0.917 -> 1 is 5 a second, under 9
      // pressing the side ramps at 5 a second to 0.833, and its last step to 1 (10 a second, past 0.78) is a snap
      expect(s[69]).toBe(0);
      expect(s[70]).toBe(1);
      expect(s[119]).toBe(1);
      expect(s[120]).toBe(2);                                        // the release
      expect(s[149]).toBe(2);
    }
  });

  it('strafe then forward: the lateral let go snaps; crouched the diagonal walk is under 0.78 and ramps', () => {
    expect(snapsOver(walker(), [[60, keys(0, 1)], [30, keys(1, 0)]]).slice(58)).toEqual([1, 1, 2, ...new Array<number>(29).fill(2)]);
    // the crouch walk rescales the stick to 14 / 14.8 of a push: 0.669 an axis on a diagonal
    expect(snapsOver(walker('crouch'), [[60, keys(0.5, -0.5)], [30, keys(0.5, 0)]]).at(-1)).toBe(0);
  });

  it('rides the wire to the other screens (a toggle in the body\'s spare bit)', () => {
    const w = walker();
    let last = -1;
    const seen: number[] = [];
    for (const [n, input] of [[60, keys(1, 0)], [60, keys(1, -1)], [30, keys(1, 0)], [60, keys(1, 1)], [30, keys(1, 0)]] as [number, WalkInput][]) {
      for (let i = 0; i < n; i++) {
        w.tick(input);
        const s = moverSnapshot(w, null, 0, 0);
        const back = snapshotOf(decodeSnapshot(encodeSnapshot({ tick: 0, own: null, bodies: [bodyOf(1, s, { alive: true, weapon: 0, aiming: false, trigger: false, boost: false })] })).bodies[0]!);
        expect((back.stickSnaps ?? 0) & 1).toBe((s.stickSnaps ?? 0) & 1);
        if (back.stickSnaps !== last) { seen.push(back.stickSnaps!); last = back.stickSnaps!; }
      }
    }
    expect(seen).toEqual([0, 1, 0, 1, 0]);                           // each side's press tail and its release
  });
});

// ---- the owner's pack on Frostfire's SEAL ------------------------------------------------------------------------------

const RUN = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures/RUN');
const PACK = resolve(RUN, 'MOTION_P.ZAR'), READERC = resolve(RUN, 'READERC.ZAR');
const MP2 = fixture('RUN/MP2.ZDB');
const noData = !existsSync(PACK) || !existsSync(READERC) || MP2 === null;

interface Frame { tick: number; play: string; nodes: string; blend: number; move: number; pop: number; right: number }

/**
 * The walker and the animator at 60 Hz through a script, with the real clips and `motion.rdr`: per frame the play, its
 * nodes (clip x weight), the cross-fade, the largest joint move (units, the skeleton's world) and the largest change
 * of that move -- the second difference, a pose pop's mark.
 */
function drive(sk: Skeleton, clips: MotionClip[], table: Map<string, MotionEntry>, script: [number, WalkInput][], stance: Stance = 'stand'): Frame[] {
  const w = walker(stance);
  const anim = new Animator(sk, clips, table, { random: () => 0 });
  const frames: Frame[] = [];
  let p1: number[] | null = null, p2: number[] | null = null;
  let tick = 0;
  for (const [n, input] of script) {
    for (let i = 0; i < n; i++, tick++) {
      w.tick(input);
      const s = moverSnapshot(w, null, 0, 0);
      const snap: MoverSnapshot = { ...s };
      anim.step(1 / 60, snap);
      const p = sk.world.flatMap((m) => [m[12]!, m[13]!, m[14]!]);
      let move = 0, pop = 0;
      for (let j = 0; j < p.length; j += 3) {
        if (p1) move = Math.max(move, Math.hypot(p[j]! - p1[j]!, p[j + 1]! - p1[j + 1]!, p[j + 2]! - p1[j + 2]!));
        if (p1 && p2) {
          pop = Math.max(pop, Math.hypot(p[j]! - 2 * p1[j]! + p2[j]!, p[j + 1]! - 2 * p1[j + 1]! + p2[j + 1]!, p[j + 2]! - 2 * p1[j + 2]! + p2[j + 2]!));
        }
      }
      const st = anim.stats();
      frames.push({
        tick, play: st.play, blend: st.blend, move, pop, right: w.state.stickRight,
        nodes: st.nodes.map((x) => `${x.clip}x${x.weight.toFixed(2)}`).join('+'),
      });
      p2 = p1; p1 = p;
    }
  }
  return frames;
}

describe.skipIf(noData)(`the release on seal_A_scuba with MOTION_P.ZAR and motion.rdr${noData ? ' (data absent)' : ''}`, () => {
  const load = (): { sk: Skeleton; clips: MotionClip[]; table: Map<string, MotionEntry> } => {
    const toc = parseZdb(MP2!);
    return {
      sk: readSkeleton(Zar.parse(zdbMember(MP2!, toc, 'CLIB_GEO.ZED')), 'seal_A_scuba'),
      clips: clipsFromPack(new Uint8Array(readFileSync(PACK)), PLAY_CLIPS),
      table: motionTableFromArchive(new Uint8Array(readFileSync(READERC)))!,
    };
  };
  /** The largest joint move a frame over frames [from, to). */
  const worst = (f: Frame[], from: number, to: number): number => Math.max(...f.slice(from, to).map((x) => x.move));

  const cases: { name: string; script: [number, WalkInput][]; release: number; stance?: Stance }[] = [
    { name: 'forward, forward-left, forward', script: [[60, keys(1, 0)], [60, keys(1, -1)], [60, keys(1, 0)]], release: 120 },
    { name: 'forward, forward-right, forward', script: [[60, keys(1, 0)], [60, keys(1, 1)], [60, keys(1, 0)]], release: 120 },
    { name: 'strafe right, then forward', script: [[60, keys(0, 1)], [60, keys(1, 0)]], release: 60 },
    { name: 'crouched: forward, forward-left (the crouch run), forward', script: [[60, keys(1, 0)], [60, keys(1, -1)], [60, keys(1, 0)]], release: 120, stance: 'crouch' },
  ];
  for (const c of cases) {
    it(`${c.name}: the release cross-fades over 0.2 s in the same play, the phase kept, no pose pop`, () => {
      const { sk, clips, table } = load();
      const f = drive(sk, clips, table, c.script, c.stance);
      const r = c.release;
      const steady = Math.max(worst(f, r - 40, r), worst(f, r + 20, r + 40));
      const at = worst(f, r, r + 14);
      expect(f[r]!.play).toBe(f[r - 1]!.play);                     // the same locomotion play: no restart, the phase runs on
      expect(f[r]!.blend).toBeLessThan(1);                         // the snap's cross-fade has begun
      expect(f[r + 11]!.blend).toBeLessThan(1);
      expect(f[r + 12]!.blend).toBe(1);                            // 0.2 s: twelve ticks
      // before the fix the release tick moved a joint 3.56 (5.94 strafe to forward) against a stride's 1.55
      expect(at, `${c.name}: ${at.toFixed(3)} at the release, ${steady.toFixed(3)} a stride`).toBeLessThanOrEqual(steady);
    });
  }
});
