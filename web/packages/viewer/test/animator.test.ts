import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseZdb, Zar, zdbMember } from '@s2u/archive';
import { readMeshLibrary, skinSubMesh, type SkinnedMeshData } from '@s2u/mesh';
import {
  IDENTITY, partMatrix, readSkeleton, sampleClip, Skeleton, type MotionClip, type MotionPart, type SkeletonPart,
} from '@s2u/scene';
import { fixture } from '../../archive/test/fixtures';
import {
  Animator, BAND_PLACEHOLDERS, BLEND_TIME_PLACEHOLDER, DIRECTION_SPLIT_DEG, PLAY_CLIPS, RATE_MAX_PLACEHOLDER,
  RATE_MIN_PLACEHOLDER, SEAL_CLIPS, bandsFrom, blendWeight, clipRate, layerName, pickClip, quatOfMatrix, rootVelocity,
  writePose, type MoverSnapshot, type PickInput,
} from '../src/animator';
import { clipsFromPack, type MotionEntry } from '../src/motionTable';
import { WORLD_SCALE } from '../src/physics';

/**
 * W2.2b: the SEAL runs the game's clips on the mover -- picked by the mover's state, advanced at the clip's 30 keys a
 * second as `motion.rdr` says, blended over its `BlendTime`, written into the skeleton part by part (web/docs/
 * research/77). Synthetic clips pin the rules with made-up numbers; the owner's `MOTION_P.ZAR` and Frostfire's SEAL
 * pin the feet on the floor.
 */

// ---- synthetic clips and a synthetic skeleton ----------------------------------------------------------------------

const Q_ID: [number, number, number, number] = [0, 0, 0, 1];
/** A unit quaternion turning `deg` about x. */
const qx = (deg: number): [number, number, number, number] => {
  const a = (deg * Math.PI) / 360;
  return [Math.sin(a), 0, 0, Math.cos(a)];
};

/** Two 16-float matrices equal to float32's rounding. */
const expectMatrix = (a: ArrayLike<number>, b: ArrayLike<number>): void => {
  expect(a.length).toBe(16);
  for (let i = 0; i < 16; i++) expect(a[i]!, `element ${i}`).toBeCloseTo(b[i]!, 5);
};

/** A clip of `frames` keys at 30 a second; each part a constant or per-key channel. */
function clip(name: string, frames: number, parts: { name: string; t: number[][]; q: number[][] }[]): MotionClip {
  const mparts: MotionPart[] = parts.map((p, index) => ({
    index, name: p.name, flags: 0x0c | (p.q.length === 1 ? 0x10 : 0) | (p.t.length === 1 ? 0x20 : 0),
    translations: Float32Array.from(p.t.flat()), rotations: Float32Array.from(p.q.flat()),
  }));
  return { name, version: 5, duration: frames / 30, frameCount: frames, rate: 30, unknown10: -1, unknown14: 1, parts: mparts };
}

/** `n + 1` keys, the last equal to the first (77 §5), from a per-key function. */
const keys = <T>(frames: number, f: (i: number) => T): T[] =>
  Array.from({ length: frames + 1 }, (_, i) => f(i === frames ? 0 : i));

/** A clip whose root travels `speed` units a second along the model's -z (forward) and whose legs hold `legDeg`. */
function walker(name: string, frames: number, speed: number, legDeg: number, rootY = 11): MotionClip {
  return clip(name, frames, [
    { name: 'skel_root', t: keys(frames, (i) => [0.5, rootY, 20 - (speed / 30) * i]), q: [Q_ID] },
    { name: 'lthigh', t: [[1, -1, 0]], q: [qx(legDeg)] },
    { name: 'lbicep', t: [[2, 6, 0]], q: [qx(0)] },
    { name: 'rifle', t: [[0, 0, 0]], q: [Q_ID] },               // a prop the skeleton does not have
  ]);
}

/** skel_root -> lthigh, skel_root -> lbicep, and `body` beside the root: bind locals with made-up translations. */
function skeleton(): Skeleton {
  const part = (index: number, name: string, parent: number, t: number[]): SkeletonPart => ({
    index, name, parent, bindLocal: partMatrix(Q_ID, t as [number, number, number]), bbox: new Float32Array(6), type: 0, flags: 0,
  });
  return new Skeleton('test', IDENTITY, [
    part(0, 'skel_root', -1, [0, 11.5, 0.5]), part(1, 'lthigh', 0, [1, -1, 0]), part(2, 'lbicep', 0, [2, 6, 0]), part(3, 'body', -1, [0, 0, 0]),
  ]);
}

/** The mover at rest on the floor, facing yaw 0 (the model's -z along the world's -z). */
const REST: MoverSnapshot = { vx: 0, vz: 0, vy: 0, yaw: 0, airborne: false, crouched: false, landing: null, jumps: 0 };
/** Moving at `speed` units a second along a heading `deg` off the facing (0 ahead, 90 to the right), yaw 0. */
const moving = (speed: number, deg = 0, extra: Partial<MoverSnapshot> = {}): MoverSnapshot => {
  const a = (deg * Math.PI) / 180;
  // yaw 0: forward is (0, -1), right is (1, 0) (walk.ts)
  return { ...REST, vx: speed * Math.sin(a), vz: -speed * Math.cos(a), ...extra };
};

const pick = (mover: MoverSnapshot, over: Partial<PickInput> = {}): string =>
  pickClip({ mover, current: null, jumped: false, landed: false, bands: BAND_PLACEHOLDERS, table: null, ...over });

// ---- the picker -----------------------------------------------------------------------------------------------------

describe('the clip picker: the mover\'s state to research 77\'s cycles (W2.2b)', () => {
  it('names the sixteen clips research 77 §12 lists for a mover, and plays nothing else', () => {
    expect(Object.values(SEAL_CLIPS).sort()).toEqual([
      'seal_crouch', 'seal_crouchwalk', 'seal_crouchwalk_bw', 'seal_jog', 'seal_jump', 'seal_land_hard', 'seal_land_soft',
      'seal_lstrafe', 'seal_rstrafe', 'seal_run', 'seal_run_bw', 'seal_runningjump_in_air', 'seal_runningjump_launch',
      'seal_stand', 'seal_walk', 'seal_walk_bw',
    ]);
    // what the page asks the worker for: the sixteen, and the pistol's upper-body layer of each where the pack has one
    expect(PLAY_CLIPS.slice(0, 16)).toEqual(Object.values(SEAL_CLIPS));
    expect(PLAY_CLIPS.slice(16)).toEqual(Object.values(SEAL_CLIPS).map(layerName));
    expect(layerName('seal_walk')).toBe('seal_p_walk');
  });

  it('pins the speed bands as named placeholders (units a second): the viewer\'s reading until the tick\'s rule is ported', () => {
    expect(BAND_PLACEHOLDERS).toMatchObject({
      seal_stand: { lo: 0, hi: 2 }, seal_crouch: { lo: 0, hi: 2 },
      seal_walk: { lo: 0, hi: 20 }, seal_jog: { lo: 15, hi: 45 }, seal_run: { lo: 40, hi: Infinity },
      seal_walk_bw: { lo: 0, hi: 20 }, seal_run_bw: { lo: 15, hi: Infinity },
    });
    expect(DIRECTION_SPLIT_DEG).toBe(45);
  });

  it('stands at rest, and under the stand band\'s top', () => {
    expect(pick(REST)).toBe('seal_stand');
    expect(pick(moving(1.9))).toBe('seal_stand');
  });

  it('walks, jogs and runs forward by speed; the mover\'s 40 (research 18) is a jog, the boost a run', () => {
    expect(pick(moving(10))).toBe('seal_walk');
    expect(pick(moving(30))).toBe('seal_jog');
    expect(pick(moving(40))).toBe('seal_jog');
    expect(pick(moving(100))).toBe('seal_run');
    // within 45 degrees of the facing is forward
    expect(pick(moving(10, 44))).toBe('seal_walk');
  });

  it('keeps the clip playing while the speed stays inside its band: the bands overlap, so there is no flicker', () => {
    const at = (name: string) => ({ current: { name, frame: 3, frames: 20, done: false } });
    expect(pick(moving(42), at('seal_jog'))).toBe('seal_jog');
    expect(pick(moving(42), at('seal_run'))).toBe('seal_run');
    expect(pick(moving(18), at('seal_walk'))).toBe('seal_walk');
    expect(pick(moving(18), at('seal_jog'))).toBe('seal_jog');
    expect(pick(moving(50), at('seal_jog'))).toBe('seal_run');
  });

  it('backs off and strafes: past 135 degrees is back, between is a strafe to that side', () => {
    expect(pick(moving(10, 180))).toBe('seal_walk_bw');
    expect(pick(moving(40, 180))).toBe('seal_run_bw');
    expect(pick(moving(40, 136))).toBe('seal_run_bw');
    expect(pick(moving(40, 90))).toBe('seal_rstrafe');
    expect(pick(moving(40, -90))).toBe('seal_lstrafe');
    expect(pick(moving(40, 60))).toBe('seal_rstrafe');
  });

  it('crouches: at rest the crouch, forward or across the crouch walk, back the crouch walk back', () => {
    expect(pick({ ...REST, crouched: true })).toBe('seal_crouch');
    expect(pick(moving(20, 0, { crouched: true }))).toBe('seal_crouchwalk');
    expect(pick(moving(20, 90, { crouched: true }))).toBe('seal_crouchwalk');
    expect(pick(moving(20, 180, { crouched: true }))).toBe('seal_crouchwalk_bw');
  });

  it('jumps standing or running, flies in the in-air clip once the launch is done, and after a fall', () => {
    const up = (speed: number) => moving(speed, 0, { airborne: true, vy: 60, jumps: 1 });
    expect(pick(up(0), { jumped: true })).toBe('seal_jump');
    expect(pick(up(10), { jumped: true })).toBe('seal_jump');
    expect(pick(up(40), { jumped: true })).toBe('seal_runningjump_launch');    // faster than a walk: a running jump
    const playing = (name: string, done: boolean) => ({ current: { name, frame: done ? 25 : 3, frames: 25, done } });
    expect(pick(up(40), playing('seal_runningjump_launch', false))).toBe('seal_runningjump_launch');
    expect(pick(up(40), playing('seal_runningjump_launch', true))).toBe('seal_runningjump_in_air');
    expect(pick(up(0), playing('seal_jump', false))).toBe('seal_jump');
    expect(pick(moving(40, 0, { airborne: true, vy: -20 }), playing('seal_jog', false))).toBe('seal_runningjump_in_air');
  });

  it('lands soft or hard by the mover\'s class, from the standing jump too (its tail would float the soles)', () => {
    const playing = (name: string) => ({ current: { name, frame: 5, frames: 14, done: false } });
    expect(pick({ ...REST, landing: 'soft' }, { landed: true, ...playing('seal_runningjump_in_air') })).toBe('seal_land_soft');
    expect(pick({ ...REST, landing: 'hard' }, { landed: true, ...playing('seal_runningjump_in_air') })).toBe('seal_land_hard');
    expect(pick({ ...REST, landing: 'harder' }, { landed: true, ...playing('seal_runningjump_in_air') })).toBe('seal_land_hard');
    expect(pick({ ...REST, landing: 'hard' }, { landed: true, ...playing('seal_jump') })).toBe('seal_land_hard');
  });

  it('holds a landing to its end at rest; moving interrupts it once its NoInterrupt fraction has played', () => {
    const table = new Map<string, MotionEntry>([['seal_land_hard', entry({ noInterrupt: 0.5 })]]);
    const landing = (frame: number) => ({ current: { name: 'seal_land_hard', frame, frames: 20, done: frame >= 20 } });
    expect(pick(REST, landing(4))).toBe('seal_land_hard');
    expect(pick(REST, landing(20))).toBe('seal_stand');
    expect(pick(moving(40), { ...landing(4), table })).toBe('seal_land_hard');
    expect(pick(moving(40), { ...landing(12), table })).toBe('seal_jog');
    expect(pick(moving(40), landing(1))).toBe('seal_jog');             // no NoInterrupt: at once
  });
});

/** A `motion.rdr` entry with every field absent but those given. */
function entry(over: Partial<MotionEntry>): MotionEntry {
  return { looped: null, playback: null, maxVelocity: null, blendTime: null, transitionA: null, transitionB: null, noInterrupt: null, ...over };
}

describe('the bands and the rate from motion.rdr, when it is read (W2.R6: no value of it in source)', () => {
  it('takes a clip\'s band from its transition speeds, metres a second times the world scale; the rest stay placeholders', () => {
    const table = new Map<string, MotionEntry>([
      ['seal_walk', entry({ transitionA: 0, transitionB: 3 })], ['seal_jog', entry({ transitionA: 2, transitionB: 7 })],
      ['seal_stand', entry({ transitionA: 0, transitionB: 0.5 })], ['seal_run', entry({})],
    ]);
    const bands = bandsFrom(table);
    expect(WORLD_SCALE).toBe(10);
    expect(bands.seal_walk).toEqual({ lo: 0, hi: 30 });
    expect(bands.seal_jog).toEqual({ lo: 20, hi: 70 });
    expect(bands.seal_stand).toEqual({ lo: 0, hi: 5 });
    expect(bands.seal_run).toEqual(BAND_PLACEHOLDERS.seal_run);
    expect(bandsFrom(null)).toEqual(BAND_PLACEHOLDERS);
    // with those bands 25 is a walk and the mover's 40 a jog
    expect(pickClip({ mover: moving(25), current: null, jumped: false, landed: false, bands, table })).toBe('seal_walk');
    expect(pickClip({ mover: moving(40), current: null, jumped: false, landed: false, bands, table })).toBe('seal_jog');
  });

  it('measures a clip\'s root travel, units a second in the model\'s frame (x right, z behind)', () => {
    expect(rootVelocity(walker('w', 20, 30, 0))).toEqual([expect.closeTo(0, 9), expect.closeTo(-30, 6)]);
    const still = clip('s', 10, [{ name: 'skel_root', t: [[1, 11, 2]], q: [Q_ID] }]);
    expect(rootVelocity(still)).toEqual([0, 0]);
    expect(rootVelocity(clip('none', 10, [{ name: 'lbicep', t: [[0, 0, 0]], q: [Q_ID] }]))).toEqual([0, 0]);
  });

  it('plays a clip at its own 30 keys a second, over playback seconds when it is no locomotion, and a cycle by speed', () => {
    const w = walker('seal_walk', 20, 30, 0);
    expect(clipRate(w, undefined, 0)).toBe(30);                                        // unread: the clip's own
    expect(clipRate(w, entry({ maxVelocity: -1, playback: 2 }), 0)).toBeCloseTo(10, 9);  // 20 keys over 2 s
    // a locomotion clip (max_velocity > 0): its root travels the mover's distance -- 15 over a 30-a-second root is half
    expect(clipRate(w, entry({ maxVelocity: 5, playback: 1 }), 15)).toBeCloseTo(15, 9);
    expect(clipRate(w, entry({ maxVelocity: 5, playback: 1 }), 1000)).toBeCloseTo(30 * RATE_MAX_PLACEHOLDER, 9);
    expect(clipRate(w, entry({ maxVelocity: 5, playback: 1 }), 0)).toBeCloseTo(30 * RATE_MIN_PLACEHOLDER, 9);
    expect([RATE_MIN_PLACEHOLDER, RATE_MAX_PLACEHOLDER]).toEqual([0.25, 3]);
  });
});

// ---- the blend --------------------------------------------------------------------------------------------------------

describe('the cross-fade (research 17 §4.2\'s weight; MOTION_BLEND\'s shorter arc)', () => {
  it('eases in and out as the game\'s node blend was traced: 0.020, 0.080, 0.180, 0.320, 0.500 at tenths', () => {
    expect([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 1].map((s) => Number(blendWeight(s).toFixed(3))))
      .toEqual([0, 0.02, 0.08, 0.18, 0.32, 0.5, 0.68, 0.82, 1]);
    expect(blendWeight(-1)).toBe(0);
    expect(blendWeight(2)).toBe(1);
    expect(BLEND_TIME_PLACEHOLDER).toBe(0.2);
  });

  it('is continuous across a switch: no step turns a part further than the blend allows, and it arrives', () => {
    const sk = skeleton();
    const a = walker('seal_walk', 20, 15, 0);
    const b = walker('seal_run', 20, 60, 80);
    const table = new Map<string, MotionEntry>([['seal_run', entry({ blendTime: 0.5 })]]);
    const anim = new Animator(sk, [a, b], table);
    anim.step(1 / 60, moving(10));
    expect(anim.stats()).toMatchObject({ clip: 'seal_walk', blend: 1, from: null });
    const angle = (): number => 2 * Math.acos(Math.min(1, Math.abs(quatOfMatrix(sk.local[1]!)[3])));
    let last = angle(), worst = 0;
    anim.step(1 / 60, moving(100));
    expect(anim.stats()).toMatchObject({ clip: 'seal_run', from: 'seal_walk' });
    for (let i = 0; i < 40; i++) {
      const now = angle();
      worst = Math.max(worst, Math.abs(now - last));
      last = now;
      anim.step(1 / 60, moving(100));
    }
    // 80 degrees over 0.5 s at the ease's steepest (2x the mean): at most about 5.4 degrees a 60 Hz step
    expect(worst * 180 / Math.PI).toBeLessThan(6);
    expect(anim.stats().blend).toBe(1);
    expect(last * 180 / Math.PI).toBeCloseTo(80, 3);
  });

  it('blends on the shorter arc: a key stored as -q does not spin the part the long way round', () => {
    const sk = skeleton();
    const q = qx(10);
    const a = clip('seal_stand', 10, [{ name: 'lthigh', t: [[1, -1, 0]], q: [q] }]);
    const b = clip('seal_crouch', 10, [{ name: 'lthigh', t: [[1, -1, 0]], q: [q.map((v) => -v)] }]);
    const anim = new Animator(sk, [a, b], null);
    anim.step(1 / 60, REST);
    anim.step(1 / 60, { ...REST, crouched: true });
    for (let i = 0; i < 6; i++) {
      anim.step(1 / 60, { ...REST, crouched: true });
      const turn = 2 * Math.acos(Math.min(1, Math.abs(quatOfMatrix(sk.local[1]!)[3])));
      expect(turn * 180 / Math.PI).toBeCloseTo(10, 3);
    }
  });
});

// ---- writing the skeleton ---------------------------------------------------------------------------------------------

describe('the pose into Skeleton.setLocal (W2.2b)', () => {
  it('writes each part the skeleton has, pins the root over the feet (the mover owns the position), keeps its height', () => {
    const sk = skeleton();
    const w = walker('seal_walk', 20, 30, 25, 10.25);
    writePose(sk, sampleClip(w, 5 / 30).parts);
    // the root: the bind's x and z, the clip's y (the clip travels 5 units ahead by key 5; the body does not)
    expect(Array.from(sk.local[0]!.subarray(12, 15))).toEqual([0, 10.25, 0.5]);
    expectMatrix(sk.local[1]!, partMatrix(qx(25), [1, -1, 0]));
    expectMatrix(sk.local[3]!, sk.parts[3]!.bindLocal);                              // `body`: no track, the bind
    expect(sk.world[1]![13]).toBeCloseTo(10.25 - 1, 5);                              // composed after the write
  });

  it('decomposes a bind matrix to the quaternion partMatrix builds it from', () => {
    for (const q of [qx(0), qx(35), qx(-170), [0.5, 0.5, 0.5, 0.5] as [number, number, number, number]]) {
      const back = quatOfMatrix(partMatrix(q, [1, 2, 3]));
      const sign = Math.sign(back[3] || 1) * Math.sign(q[3] || 1);
      back.forEach((v, i) => expect(v * sign).toBeCloseTo(q[i]!, 6));
    }
  });

  it('advances at the clip\'s rate, loops a cycle, and reports the clip, the frame and the blend', () => {
    const sk = skeleton();
    const stand = clip('seal_stand', 10, [{ name: 'lthigh', t: [[1, -1, 0]], q: keys(10, (i) => qx(i)) }]);
    const table = new Map<string, MotionEntry>([['seal_stand', entry({ looped: true, maxVelocity: -1, playback: 2 })]]);
    const anim = new Animator(sk, [stand], table);
    anim.step(0, REST);
    for (let i = 0; i < 60; i++) anim.step(1 / 60, REST);
    // ten keys over playback's 2 s: five keys a second, so one second in is key 5
    expect(anim.stats()).toMatchObject({ clip: 'seal_stand', blend: 1, layer: null });
    expect(anim.stats().frame).toBeCloseTo(5, 6);
    expect(anim.stats().rate).toBeCloseTo(5, 9);
    for (let i = 0; i < 60; i++) anim.step(1 / 60, REST);
    const f = anim.stats().frame;
    expect(Math.min(f, 10 - f)).toBeCloseTo(0, 6);                                   // looped round
  });

  it('layers the pistol\'s upper-body clip over the legs when the weapon is the pistol; the rifle takes none', () => {
    const base = walker('seal_walk', 20, 15, 30);
    const upper = clip('seal_p_walk', 20, [{ name: 'lbicep', t: [[2, 6, 0]], q: [qx(60)] }]);   // no root, no legs
    const rifle = skeleton();
    new Animator(rifle, [base, upper], null).step(1 / 60, moving(10));
    expectMatrix(rifle.local[2]!, partMatrix(qx(0), [2, 6, 0]));
    const pistol = skeleton();
    const anim = new Animator(pistol, [base, upper], null, { weapon: 'pistol' });
    anim.step(1 / 60, moving(10));
    expect(anim.stats().layer).toBe('seal_p_walk');
    expectMatrix(pistol.local[2]!, partMatrix(qx(60), [2, 6, 0]));
    expectMatrix(pistol.local[1]!, partMatrix(qx(30), [1, -1, 0]));                 // the legs stay the base's
  });

  it('carries a jump from the take-off to the landing through the mover\'s edges', () => {
    const sk = skeleton();
    const clips = ['seal_stand', 'seal_jump', 'seal_runningjump_in_air', 'seal_land_soft'].map((n) => walker(n, 10, 0, 0));
    const table = new Map<string, MotionEntry>([
      ['seal_jump', entry({ looped: false, maxVelocity: -1, playback: 1 / 3 })],
      ['seal_land_soft', entry({ looped: false, maxVelocity: -1, playback: 1 / 3 })],
    ]);
    const anim = new Animator(sk, clips, table);
    anim.step(1 / 60, REST);
    expect(anim.stats().clip).toBe('seal_stand');
    anim.step(1 / 60, { ...REST, airborne: true, vy: 60, jumps: 1 });
    expect(anim.stats().clip).toBe('seal_jump');
    for (let i = 0; i < 30; i++) anim.step(1 / 60, { ...REST, airborne: true, vy: 0, jumps: 1 });
    expect(anim.stats().clip).toBe('seal_runningjump_in_air');             // the jump's third of a second is done
    anim.step(1 / 60, { ...REST, landing: 'soft', jumps: 1 });
    expect(anim.stats().clip).toBe('seal_land_soft');
    for (let i = 0; i < 30; i++) anim.step(1 / 60, { ...REST, landing: 'soft', jumps: 1 });
    expect(anim.stats().clip).toBe('seal_stand');
  });
});

// ---- the owner's pack on Frostfire's SEAL -----------------------------------------------------------------------------

const PACK = resolve(dirname(fileURLToPath(import.meta.url)), '../../../public/maps/RUN/MOTION_P.ZAR');
const MP2 = fixture('RUN/MP2.ZDB');
const noData = !existsSync(PACK) || MP2 === null;

describe.skipIf(noData)(`seal_A_scuba on MOTION_P.ZAR's cycles${noData ? ' (MOTION_P.ZAR or the MP2 fixture absent)' : ''}`, () => {
  const load = (): { sk: Skeleton; mesh: SkinnedMeshData; clips: MotionClip[] } => {
    const toc = parseZdb(MP2!);
    const sk = readSkeleton(Zar.parse(zdbMember(MP2!, toc, 'CLIB_GEO.ZED')), 'seal_A_scuba');
    const mesh = readMeshLibrary(Zar.parse(zdbMember(MP2!, toc, 'CLIB_MDL.ZED')), ['seal_A_scuba'])[0]!.mesh!;
    return { sk, mesh, clips: clipsFromPack(new Uint8Array(readFileSync(PACK)), PLAY_CLIPS) };
  };
  /** The lowest point of the skinned mesh in the skeleton's current pose, every influence summed (`skinSubMesh`). */
  const lowest = (sk: Skeleton, mesh: SkinnedMeshData): number => {
    let y = Infinity;
    for (const sub of mesh.subMeshes) {
      const { positions } = skinSubMesh(sub, sk.palette());
      for (let i = 1; i < positions.length; i += 3) y = Math.min(y, positions[i]!);
    }
    return y;
  };

  it('finds the sixteen clips and the pistol layers the pack has', () => {
    const { clips } = load();
    const names = clips.map((c) => c.name);
    for (const n of Object.values(SEAL_CLIPS)) expect(names, n).toContain(n);
    expect(names.filter((n) => n.startsWith('seal_p_')).length).toBeGreaterThan(0);
  });

  it('seal_walk lands the soles on the floor at every frame: the skinned mesh\'s lowest vertex within a unit of 0', () => {
    const { sk, mesh, clips } = load();
    const walk = clips.find((c) => c.name === 'seal_walk')!;
    const lows: number[] = [];
    for (let f = 0; f < walk.frameCount; f++) {
      writePose(sk, sampleClip(walk, f / walk.rate).parts);
      lows.push(lowest(sk, mesh));
    }
    expect(lows).toHaveLength(25);
    for (const [f, y] of lows.entries()) expect(Math.abs(y), `frame ${f}: ${y}`).toBeLessThan(1);
  });

  it('driven by the Animator at 60 Hz through a walk, a stop and a crouch, the soles stay within a unit of the floor', () => {
    const { sk, mesh, clips } = load();
    const anim = new Animator(sk, clips, null);
    const worst: Record<string, number> = {};
    const run = (steps: number, mover: MoverSnapshot): void => {
      for (let i = 0; i < steps; i++) {
        anim.step(1 / 60, mover);
        if (anim.stats().blend < 1) continue;          // a settled clip; the cross-fade is the next test's
        const y = Math.abs(lowest(sk, mesh));
        const c = anim.stats().clip;
        worst[c] = Math.max(worst[c] ?? 0, y);
      }
    };
    run(90, moving(10));
    run(60, REST);
    run(60, { ...REST, crouched: true });
    expect(Object.keys(worst).sort()).toEqual(['seal_crouch', 'seal_stand', 'seal_walk']);
    for (const [c, y] of Object.entries(worst)) expect(y, c).toBeLessThan(1);
  });
});
