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
  Animator, BANK_FACTOR, BODY_PARTS, SAMPLED_TRANSLATIONS, HELD_ALIAS, HELD_PART, PLAY_CLIPS, TWIST_SHARE, blendWeight, crosses, isCycle, layerName,
  mergeRotations, partIndex, qmul, qrot, quatOfMatrix, slerp, turnStepSpeed, writePose,
  type AnimEvent, type LayerContext, type MoverSnapshot,
} from '../src/animator';
import { BLEND_TIME_DEFAULT, MOTION_CLIPS, SEAL_ANIMS, oneShotSeconds } from '../src/locomotion';
import { clipsFromPack, motionTableFromArchive, type MotionEntry } from '../src/motionTable';
import type { GroundMotion, MoverAction } from '../src/walk';

/**
 * The animator (web sprint 2 W2.2b; the motion workstream, web/docs/research/80-the-jump.md): the mover's action or
 * ground state names a play -- nodes sharing one phase, `./locomotion`'s port of the game's pick and blend -- which
 * starts with a cross-fade, advances as `FUN_0028c4f0` does, fires its events, and poses the skeleton. Synthetic clips
 * pin the rules with made-up numbers; the owner's `MOTION_P.ZAR`, `READERC.ZAR` and Frostfire's SEAL pin the rest.
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

/** A clip whose root travels `speed` units a second along the model's -z and whose left thigh turns `legDeg` a key. */
function walker(name: string, frames: number, speed: number, legDeg: number, rootY = 11): MotionClip {
  return clip(name, frames, [
    { name: 'skel_root', t: keys(frames, (i) => [0.5, rootY, 20 - (speed / 30) * i]), q: [Q_ID] },
    { name: 'lthigh', t: [[1, -1, 0]], q: keys(frames, (i) => qx(legDeg * i)) },
    { name: 'lbicep', t: [[2, 6, 0]], q: [qx(0)] },
    { name: 'rifle', t: [[0, 0, 0]], q: [Q_ID] },               // a prop the skeleton does not have
  ]);
}

/** A still clip whose root stands at `rootY` (a curve when given per key) and whose thigh holds `legDeg`. */
function pose(name: string, frames: number, legDeg: number, rootY: number | number[] = 11): MotionClip {
  const t = Array.isArray(rootY) ? rootY.map((y) => [0.5, y, 20]) : [[0.5, rootY, 20]];
  return clip(name, frames, [{ name: 'skel_root', t, q: [Q_ID] }, { name: 'lthigh', t: [[1, -1, 0]], q: [qx(legDeg)] }]);
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

/** A `motion.rdr` entry, made up: every field absent unless given. */
const entry = (e: Partial<MotionEntry>): MotionEntry => ({
  looped: null, playback: null, maxVelocity: null, blendTime: null, transitionA: null, transitionB: null, noInterrupt: null, callbacks: [], ...e,
});
/** A locomotion cycle's entry: looped, `playback` 1, `max_velocity` and the band in metres a second. */
const cycle = (maxVelocity: number, a: number, b: number, extra: Partial<MotionEntry> = {}): MotionEntry =>
  entry({ looped: true, playback: 1, maxVelocity, transitionA: a, transitionB: b, ...extra });
/** A one-shot's entry. */
const once = (playback: number, extra: Partial<MotionEntry> = {}): MotionEntry => entry({ looped: false, playback, maxVelocity: -1, ...extra });

const IDLE: GroundMotion = { state: 'idle', forward: 0, right: 0, cls: -1 };
/** The mover at rest on the floor, standing, facing yaw 0. */
const REST: MoverSnapshot = { vx: 0, vz: 0, vy: 0, yaw: 0, airborne: false, crouched: false, landing: null, jumps: 0, stance: 'stand', ground: IDLE, action: null };
/** The standing ground state with its stick (forward, right), moving at `speed`. */
const running = (forward: number, right = 0, speed = 65 * Math.hypot(forward, right)): MoverSnapshot =>
  ({ ...REST, vz: -speed, ground: { state: 'stand', forward, right, cls: 1 } });
const acting = (name: MoverAction['name'], serial = 1, extra: Partial<MoverAction> = {}): MoverSnapshot =>
  ({ ...REST, action: { name, serial, t: 0, seconds: null, reversed: false, ...extra } });

// ---- the plays --------------------------------------------------------------------------------------------------------

/** The standing sets' clips with bands like the Seal anim set's, and the stand. */
function standingKit(): { clips: MotionClip[]; table: Map<string, MotionEntry> } {
  const clips = [
    pose('seal_stand', 16, 0), walker('seal_walk_alert', 16, 32, 2), walker('seal_jog_alert', 18, 47, 3), walker('seal_run', 19, 57.7, 4),
    walker('seal_walk_bw', 16, -32, 1), walker('seal_run_bw', 18, -34, 1),
    clip('seal_rstrafe', 22, [{ name: 'skel_root', t: keys(22, (i) => [0.5 + (15 / 30) * i, 10.8, 20]), q: [Q_ID] }]),
    clip('seal_run_90r', 18, [{ name: 'skel_root', t: keys(18, (i) => [0.5 + (55 / 30) * i, 10, 20]), q: [Q_ID] }]),
  ];
  const table = new Map<string, MotionEntry>([
    ['seal_stand', entry({ looped: true, playback: 6, maxVelocity: -0.1, blendTime: 0.5 })],
    ['seal_walk_alert', cycle(6.5, 0, 4)], ['seal_jog_alert', cycle(6.5, 2, 6.15)], ['seal_run', cycle(6.5, 4.01, 6.5)],
    ['seal_walk_bw', cycle(3.7, 0, 2.8)], ['seal_run_bw', cycle(3.7, 2, 3.7)],
    ['seal_rstrafe', cycle(6.5, 0, 2.8)], ['seal_run_90r', cycle(6.5, 3, 6.5)],
  ]);
  return { clips, table };
}

describe('the play the mover asks for (research 80 §4)', () => {
  it('stands at rest; standing locomotion is the pick and blend -- full ahead the run, half the walk and the jog', () => {
    const { clips, table } = standingKit();
    const anim = new Animator(skeleton(), clips, table);
    anim.step(1 / 60, REST);
    expect(anim.stats()).toMatchObject({ clip: 'seal_stand', play: 'idle:stand' });
    anim.step(1 / 60, running(1));
    expect(anim.stats().play).toBe('loco:stand');
    expect(anim.stats().nodes.map((n) => n.clip)).toEqual(['seal_run']);
    anim.step(1 / 60, running(0.5));                     // 32.5 in walk_alert 0-40 and jog_alert 20-61.5
    const half = anim.stats().nodes;
    expect(half.map((n) => n.clip)).toEqual(['seal_walk_alert', 'seal_jog_alert']);
    expect(half[0]!.weight).toBeCloseTo(1 - (32.5 - 20) / (40 - 20), 9);
    expect(half[1]!.weight).toBeCloseTo((32.5 - 20) / (40 - 20), 9);
  });

  it('strafes with the strafe set, at full stick the running strafe -- not the slow strafe flailing at 65', () => {
    const { clips, table } = standingKit();
    const anim = new Animator(skeleton(), clips, table);
    anim.step(1 / 60, running(0, 1));
    expect(anim.stats().nodes.map((n) => n.clip)).toEqual(['seal_run_90r']);
    anim.step(1 / 60, running(0, 0.3));                  // 19.5: the slow strafe's band
    expect(anim.stats().nodes.map((n) => n.clip)).toEqual(['seal_rstrafe']);
    anim.step(1 / 60, running(Math.SQRT1_2, Math.SQRT1_2));
    const diag = anim.stats().nodes;
    expect(diag.map((n) => n.clip)).toEqual(['seal_run', 'seal_run_90r']);
    diag.forEach((n) => expect(n.weight).toBeCloseTo(0.5, 12));
  });

  it('plays each clip at the speed that makes its root travel the mover\'s speed: the rate follows the stick', () => {
    const { clips, table } = standingKit();
    const anim = new Animator(skeleton(), clips, table);
    anim.step(1 / 60, running(1));
    const runRate = anim.stats().rate;                   // keys a second
    // seal_run: 19 keys; its root travels 57.7 a second at 30 keys a second -> 65 needs 30 x 65 / 57.7
    expect(runRate).toBeCloseTo((30 * 65) / 57.7, 1);
    anim.step(1 / 60, running(0, 1));
    expect(anim.stats().rate).toBeCloseTo((30 * 65) / 55, 1);
  });

  it('every node samples the one phase, which advances by sum(weight x speed / T) (FUN_0028c4f0)', () => {
    const { clips, table } = standingKit();
    const anim = new Animator(skeleton(), clips, table);
    anim.step(1 / 60, running(0.5));
    const f0 = anim.stats().frame;
    for (let i = 0; i < 6; i++) anim.step(1 / 60, running(0.5));
    // weighted cycles a second: walk 32.5 / D_walk, jog 32.5 / D_jog, D the root's travel a cycle
    const dWalk = 32 * 16 / 30, dJog = 47 * 18 / 30;
    const w = (32.5 - 20) / 20;
    const cycles = (1 - w) * 32.5 / dWalk + w * 32.5 / dJog;
    const main = anim.stats();
    expect(main.clip).toBe('seal_jog_alert');
    expect((main.frame - f0 + 18) % 18).toBeCloseTo(cycles * 6 / 60 * 18, 3);
  });

  it('crouched: the one set of the direction class; the right strafe half a cycle on (FUN_00582d10)', () => {
    const clips = [pose('seal_crouch', 10, 0, 5.5), walker('seal_crouchwalk', 28, 13, 1, 9.3),
      clip('seal_crouchstrafe_right_fast', 20, [{ name: 'skel_root', t: keys(20, (i) => [0.5 + 0.4 * i, 9, 20]), q: [Q_ID] }])];
    const table = new Map<string, MotionEntry>([['seal_crouchwalk', cycle(1.48, 0, 2)], ['seal_crouchstrafe_right_fast', cycle(1.5, 0, 2)]]);
    const anim = new Animator(skeleton(), clips, table);
    anim.step(1 / 60, { ...REST, stance: 'crouch', ground: { state: 'crouch', forward: 0.946, right: 0, cls: 1 } });
    expect(anim.stats()).toMatchObject({ play: 'loco:crouch:1', clip: 'seal_crouchwalk' });
    anim.step(1 / 60, { ...REST, stance: 'crouch', ground: { state: 'crouch', forward: 0, right: 0.946, cls: 0 } });
    expect(anim.stats()).toMatchObject({ play: 'loco:crouch:0', clip: 'seal_crouchstrafe_right_fast' });
    expect(anim.stats().frame).toBeGreaterThanOrEqual(10 - 1e-9);          // the phase kept, plus the 0.5 offset
  });

  it('prone: the crawl, backwards when backing up; the prone strafes across (FUN_00583500)', () => {
    const clips = [pose('seal_prone', 10, 0, 2.2), walker('seal_prone_crawl', 26, 10, 1, 2.3)];
    const table = new Map<string, MotionEntry>([['seal_prone_crawl', cycle(1.1, 0, 0.4)]]);
    const anim = new Animator(skeleton(), clips, table);
    anim.step(1 / 60, { ...REST, stance: 'prone' });
    expect(anim.stats().clip).toBe('seal_prone');
    anim.step(1 / 60, { ...REST, stance: 'prone', ground: { state: 'prone', forward: 1, right: 0, cls: 1 } });
    expect(anim.stats().nodes[0]!.speed).toBeGreaterThan(0);
    anim.step(1 / 60, { ...REST, stance: 'prone', ground: { state: 'prone', forward: -1, right: 0, cls: 3 } });
    expect(anim.stats()).toMatchObject({ clip: 'seal_prone_crawl', play: 'loco:prone:3' });
    expect(anim.stats().nodes[0]!.speed).toBeLessThan(0);
    expect(anim.stats().rate).toBeLessThan(0);
  });

  it("prone and still, a turn plays seal_prone_turn (FUN_0054aa30); standing, a turn plays nothing: the body pivots", () => {
    const clips = [pose('seal_stand', 16, 0), pose('seal_prone', 10, 0, 2.2), pose('seal_prone_turn', 21, 10, 2.2)];
    const anim = new Animator(skeleton(), clips, null);
    anim.step(1 / 60, { ...REST, stance: 'prone', turnRate: 0 });
    expect(anim.stats().clip).toBe('seal_prone');
    anim.step(1 / 60, { ...REST, stance: 'prone', turnRate: 1.2 });
    expect(anim.stats()).toMatchObject({ clip: 'seal_prone_turn', play: 'turn:prone' });
    anim.step(1 / 60, { ...REST, stance: 'stand', turnRate: 1.2 });
    expect(anim.stats().clip).toBe('seal_stand');
  });

  it('the crouch idle draws one of the Seal anim set\'s three by their chances, and keeps it while it plays', () => {
    const clips = ['seal_crouch', 'seal_crouch_alert01', 'seal_crouch_alert02'].map((n, i) => pose(n, 10, i * 10, 5.5));
    const drawn = (r: number): string => {
      const anim = new Animator(skeleton(), clips, null, { random: () => r });
      anim.step(1 / 60, { ...REST, stance: 'crouch' });
      return anim.stats().clip;
    };
    expect([drawn(0), drawn(0.29), drawn(0.31), drawn(0.59), drawn(0.61), drawn(0.99)])
      .toEqual(['seal_crouch', 'seal_crouch', 'seal_crouch_alert01', 'seal_crouch_alert01', 'seal_crouch_alert02', 'seal_crouch_alert02']);
    let r = 0;
    const anim = new Animator(skeleton(), clips, null, { random: () => (r += 0.37) % 1 });
    anim.step(1 / 60, { ...REST, stance: 'crouch' });
    const first = anim.stats().clip;
    for (let i = 0; i < 30; i++) anim.step(1 / 60, { ...REST, stance: 'crouch' });
    expect(anim.stats().clip).toBe(first);
  });
});

describe('the actions: the jumps, the landings and the stance transitions', () => {
  const jumpKit = () => {
    const rise = [10.51, 10.51, 10.53, 10.54, 10.55, 10.56, 10.57, 10.65, 10.77, 11.46, 13.09, 14.55, 15.08, 14.94, 14.33, 12.83, 11.27, 11.25, 11.26, 11.26, 10.51];
    const clips = [pose('seal_stand', 16, 0, 11.48), pose(SEAL_ANIMS.jump, 20, 20, rise), pose(SEAL_ANIMS.launch, 25, 30),
      pose(SEAL_ANIMS.inAir, 14, 40), pose(SEAL_ANIMS.land, 20, 50), pose(SEAL_ANIMS.landHard, 20, 60),
      pose(SEAL_ANIMS.standToCrouch, 27, 0, keys(27, (i) => 11.5 - (6 * i) / 26)), pose('seal_crouch', 10, 0, 5.5)];
    const table = new Map<string, MotionEntry>([
      ['seal_stand', entry({ looped: true, playback: 6, maxVelocity: -0.1, blendTime: 0.5 })],
      [SEAL_ANIMS.jump, once(1.1, { blendTime: 0.32, noInterrupt: 0.7, callbacks: [{ name: 'jump_whoosh', time: 0.4 }] })],
      [SEAL_ANIMS.launch, entry({ looped: false, playback: 2.4, maxVelocity: 6.5, blendTime: 0.2, callbacks: [{ name: 'jump_whoosh', time: 0.1 }] })],
      [SEAL_ANIMS.inAir, once(5, { blendTime: 0.75 })], [SEAL_ANIMS.land, once(0.7)], [SEAL_ANIMS.landHard, once(1)],
      [SEAL_ANIMS.standToCrouch, once(0.65)],
    ]);
    return { clips, table };
  };

  it('each action plays its clip: the Jump, the launch, the fall, the landings', () => {
    const { clips, table } = jumpKit();
    const anim = new Animator(skeleton(), clips, table);
    for (const [name, clipName] of [['jump', SEAL_ANIMS.jump], ['launch', SEAL_ANIMS.launch], ['fall', SEAL_ANIMS.inAir],
      ['land', SEAL_ANIMS.land], ['landHard', SEAL_ANIMS.landHard]] as const) {
      anim.step(1 / 60, acting(name));
      expect(anim.stats().clip, name).toBe(clipName);
    }
  });

  it('a one-shot runs keys 0 to n - 1 in playback x ((n - 1) / n)^2 and holds the last (FUN_0028c4f0, FUN_0028d670)', () => {
    const { clips, table } = jumpKit();
    const anim = new Animator(skeleton(), clips, table);
    anim.step(1 / 60, REST);
    anim.step(0, acting('jump'));
    const seconds = oneShotSeconds(1.1, 20);
    expect(seconds).toBeCloseTo(0.99275, 6);
    let t = 0;
    while (anim.stats().frame < 19 - 1e-9 && t < 3) { anim.step(1 / 120, acting('jump')); t += 1 / 120; }
    expect(t).toBeCloseTo(seconds, 1);
    for (let i = 0; i < 60; i++) anim.step(1 / 60, acting('jump'));
    expect(anim.stats().frame).toBeCloseTo(19, 9);
  });

  it('the standing jump lifts the root as the clip does -- 10.5 to 15.1 -- after the 0.32 s blend in: rootY for the camera', () => {
    const { clips, table } = jumpKit();
    const anim = new Animator(skeleton(), clips, table);
    for (let i = 0; i < 60; i++) anim.step(1 / 60, REST);
    expect(anim.rootY()).toBeCloseTo(11.48, 5);
    anim.step(0, acting('jump'));
    let top = 0;
    for (let i = 0; i < 70; i++) { anim.step(1 / 60, acting('jump')); top = Math.max(top, anim.rootY()!); }
    expect(top).toBeGreaterThan(14.8);
    expect(top).toBeLessThanOrEqual(15.08 + 1e-6);
  });

  it('a transition played backwards (getting up) starts at its last key and runs to key 0 (FUN_0028c160)', () => {
    const { clips, table } = jumpKit();
    const anim = new Animator(skeleton(), clips, table);
    anim.step(0, { ...acting('standToCrouch', 1, { reversed: true }), stance: 'stand' });
    expect(anim.stats().frame).toBeCloseTo(26, 6);
    expect(anim.stats().rate).toBeLessThan(0);
    for (let i = 0; i < 60; i++) anim.step(1 / 60, { ...acting('standToCrouch', 1, { reversed: true }), stance: 'stand' });
    expect(anim.stats().frame).toBe(0);
  });

  it('a new play cross-fades from the pose on screen over the new clip\'s BlendTime -- 0.4 when motion.rdr gives none', () => {
    const { clips, table } = jumpKit();
    const anim = new Animator(skeleton(), clips, table);
    anim.step(1 / 60, REST);
    anim.step(1 / 60, acting('jump'));
    expect(anim.stats()).toMatchObject({ clip: SEAL_ANIMS.jump, from: 'seal_stand', blend: 0 });
    for (let i = 0; i < 9; i++) anim.step(1 / 60, acting('jump'));
    expect(anim.stats().blend).toBeCloseTo(blendWeight(9 / 60 / 0.32), 9);   // seal_jump's BlendTime 0.32
    anim.step(1 / 60, acting('land', 2));
    expect(BLEND_TIME_DEFAULT).toBe(0.4);                                   // FUN_00287620's default
    for (let i = 0; i < 12; i++) anim.step(1 / 60, acting('land', 2));
    expect(anim.stats().blend).toBeCloseTo(blendWeight(12 / 60 / 0.4), 9);
  });

  it('is continuous across a switch: no step turns a part further than the blend allows, and it arrives', () => {
    const { clips, table } = jumpKit();
    const sk = skeleton();
    const anim = new Animator(sk, clips, table);
    anim.step(1 / 60, REST);
    const angle = (): number => 2 * Math.acos(Math.min(1, Math.abs(quatOfMatrix(sk.local[1]!)[3])));
    let last = angle(), worst = 0;
    anim.step(1 / 60, acting('landHard'));                              // 0 to 60 degrees over 0.4 s
    for (let i = 0; i < 40; i++) {
      const now = angle();
      worst = Math.max(worst, Math.abs(now - last));
      last = now;
      anim.step(1 / 60, acting('landHard'));
    }
    expect(worst * 180 / Math.PI).toBeLessThan(5.1);                    // 60 over 0.4 s at the ease's steepest
    expect(anim.stats().blend).toBe(1);
    expect(last * 180 / Math.PI).toBeCloseTo(60, 3);
  });
});

describe('the events for the page (the audio): callbacks, footfalls, plays', () => {
  it('fires a zanim_callback as the phase crosses it -- seal_jump\'s jump_whoosh at 0.4 of its phase, 0.418 s in', () => {
    const clips = [pose('seal_stand', 16, 0), pose(SEAL_ANIMS.jump, 20, 20)];
    const table = new Map<string, MotionEntry>([[SEAL_ANIMS.jump, once(1.1, { callbacks: [{ name: 'jump_whoosh', time: 0.4 }] })]]);
    const anim = new Animator(skeleton(), clips, table);
    const seen: { e: AnimEvent; t: number }[] = [];
    let t = 0;
    anim.onEvent((e) => seen.push({ e, t }));
    anim.step(1 / 60, REST);
    for (let i = 0; i < 90; i++) { t += 1 / 60; anim.step(1 / 60, acting('jump')); }
    const whoosh = seen.filter((s) => s.e.kind === 'callback');
    expect(whoosh).toHaveLength(1);
    expect(whoosh[0]!.e).toEqual({ kind: 'callback', clip: SEAL_ANIMS.jump, name: 'jump_whoosh', phase: 0.4 });
    expect(whoosh[0]!.t).toBeCloseTo(0.4 * 1.1 * 0.95, 1);
    expect(seen.filter((s) => s.e.kind === 'play').map((s) => (s.e as { play: string }).play)).toEqual(['idle:stand', 'jump#1']);
  });

  it('a time over 1 is seconds, turned into the phase by playback x (n - 1) / n (FUN_00287620)', () => {
    const anim = new Animator(skeleton(), [pose('x', 21, 0)], new Map([['x', once(4, { callbacks: [{ name: 'late', time: 2 }] })]]));
    expect(anim.motion('x')!.callbacks).toEqual([{ name: 'late', phase: 2 / (4 * 20 / 21) }]);
  });

  it('a moving locomotion play steps left as its phase enters (0, 0.5), right as it enters (0.5, 1) (FUN_005a3570)', () => {
    const { clips, table } = standingKit();
    const anim = new Animator(skeleton(), clips, table);
    const feet: string[] = [];
    anim.onEvent((e) => { if (e.kind === 'footfall') feet.push(e.foot); });
    for (let i = 0; i < 120; i++) anim.step(1 / 60, running(1));        // 1.78 cycles a second for 2 s
    expect(feet.length).toBeGreaterThanOrEqual(6);
    expect(feet.length).toBeLessThanOrEqual(8);
    feet.forEach((f, i) => expect(f).toBe(i % 2 === 0 ? 'left' : 'right'));
    feet.length = 0;
    for (let i = 0; i < 60; i++) anim.step(1 / 60, REST);
    for (let i = 0; i < 60; i++) anim.step(1 / 60, acting('fall'));
    expect(feet).toEqual([]);                                           // not standing still, not in the air
  });

  it('crosses: forward, wrapped, backwards, and never on no step (FUN_0028c7c0)', () => {
    expect(crosses(0.4, 0.3, 0.5, false, false)).toBe(true);
    expect(crosses(0.4, 0.4, 0.5, false, false)).toBe(true);
    expect(crosses(0.4, 0.5, 0.6, false, false)).toBe(false);
    expect(crosses(0.1, 0.9, 0.2, true, false)).toBe(true);            // a loop wrapping past its start
    expect(crosses(0.95, 0.9, 0.2, true, false)).toBe(false);          // the game's own rule: from - 1 <= t <= to
    expect(crosses(0.4, 0.5, 0.3, false, true)).toBe(true);
    expect(crosses(0.4, 0.4, 0.4, false, false)).toBe(false);
  });
});

// ---- the cross-fade's weight and the pose -----------------------------------------------------------------------------

describe('the cross-fade (research 17 §4.2\'s weight; MOTION_BLEND\'s shorter arc)', () => {
  it('eases in and out as the game\'s node blend was traced: 0.020, 0.080, 0.180, 0.320, 0.500 at tenths', () => {
    expect([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 1].map((s) => Number(blendWeight(s).toFixed(3))))
      .toEqual([0, 0.02, 0.08, 0.18, 0.32, 0.5, 0.68, 0.82, 1]);
    expect(blendWeight(-1)).toBe(0);
    expect(blendWeight(2)).toBe(1);
  });

  it('blends on the shorter arc: a key stored as -q does not spin the part the long way round', () => {
    const sk = skeleton();
    const q = qx(10);
    const a = clip('seal_stand', 10, [{ name: 'lthigh', t: [[1, -1, 0]], q: [q] }]);
    const b = clip('seal_crouch', 10, [{ name: 'lthigh', t: [[1, -1, 0]], q: [q.map((v) => -v)] }]);
    const anim = new Animator(sk, [a, b], null);
    anim.step(1 / 60, REST);
    anim.step(1 / 60, { ...REST, stance: 'crouch' });
    for (let i = 0; i < 6; i++) {
      anim.step(1 / 60, { ...REST, stance: 'crouch' });
      const turn = 2 * Math.acos(Math.min(1, Math.abs(quatOfMatrix(sk.local[1]!)[3])));
      expect(turn * 180 / Math.PI).toBeCloseTo(10, 3);
    }
  });
});

describe('the pose into Skeleton.setLocal (W2.2b)', () => {
  it('writes each part the skeleton has, pins the root over the feet (the mover owns the position), keeps its height', () => {
    const sk = skeleton();
    const w = walker('seal_walk', 20, 30, 0, 10.25);
    writePose(sk, sampleClip(w, 5 / 30).parts);
    expect(Array.from(sk.local[0]!.subarray(12, 15))).toEqual([0, 10.25, 0.5]);
    expectMatrix(sk.local[1]!, partMatrix(qx(0), [1, -1, 0]));
    expectMatrix(sk.local[3]!, sk.parts[3]!.bindLocal);                              // `body`: no track, the bind
    expect(sk.world[1]![13]).toBeCloseTo(10.25 - 1, 5);
  });

  it('decomposes a bind matrix to the quaternion partMatrix builds it from', () => {
    for (const q of [qx(0), qx(35), qx(-170), [0.5, 0.5, 0.5, 0.5] as [number, number, number, number]]) {
      const back = quatOfMatrix(partMatrix(q, [1, 2, 3]));
      const sign = Math.sign(back[3] || 1) * Math.sign(q[3] || 1);
      back.forEach((v, i) => expect(v * sign).toBeCloseTo(q[i]!, 6));
    }
  });

  it('a blend of two nodes is their weighted pose: half the run and half the running strafe splits the thigh', () => {
    const sk = skeleton();
    const a = pose('seal_run', 10, 0), b = pose('seal_run_90r', 10, 40);
    const table = new Map<string, MotionEntry>([['seal_run', cycle(6.5, 4.01, 6.5)], ['seal_run_90r', cycle(6.5, 3, 6.5)]]);
    const anim = new Animator(sk, [a, b], table);
    anim.step(1 / 60, running(Math.SQRT1_2, Math.SQRT1_2));
    const turn = 2 * Math.acos(Math.min(1, Math.abs(quatOfMatrix(sk.local[1]!)[3])));
    expect(turn * 180 / Math.PI).toBeCloseTo(20, 1);
  });

  it('layers the pistol\'s upper-body clip over the legs when the weapon is the pistol; the rifle takes none', () => {
    const base = pose('seal_stand', 16, 30);
    const upper = clip('seal_p_stand', 16, [{ name: 'lbicep', t: [[2, 6, 0]], q: [qx(60)] }]);   // no root, no legs
    const rifle = skeleton();
    new Animator(rifle, [base, upper], null).step(1 / 60, REST);
    expectMatrix(rifle.local[2]!, partMatrix(qx(0), [2, 6, 0]));
    const pistol = skeleton();
    const anim = new Animator(pistol, [base, upper], null, { weapon: 'pistol' });
    anim.step(1 / 60, REST);
    expect(anim.stats().layer).toBe('seal_p_stand');
    expectMatrix(pistol.local[2]!, partMatrix(qx(60), [2, 6, 0]));
    expectMatrix(pistol.local[1]!, partMatrix(qx(30), [1, -1, 0]));                 // the legs stay the base's
    expect(layerName('seal_run')).toBe('seal_p_run');
  });

  it('asks the worker for every clip the plays name, and each one\'s pistol version', () => {
    for (const n of MOTION_CLIPS) {
      expect(PLAY_CLIPS).toContain(n);
      expect(PLAY_CLIPS).toContain(layerName(n));
    }
    for (const n of Object.values(SEAL_ANIMS)) expect(PLAY_CLIPS).toContain(n);
  });

  it("a pose layer blends over the play by its weight and sees the main clip, its key and its phase (the weapon's seam)", () => {
    const sk = skeleton();
    const anim = new Animator(sk, [pose('seal_stand', 16, 0)], null);
    const seen: LayerContext[] = [];
    let weight = 1;
    anim.addPoseLayer({ sample: (c) => { seen.push(c); return { parts: [{ index: 0, name: 'lthigh', rotation: qx(40), translation: [1, -1, 0] }], weight }; } });
    anim.step(1 / 60, REST);
    expectMatrix(sk.local[1]!, partMatrix(qx(40), [1, -1, 0]));
    expect(seen[0]!.clip.name).toBe('seal_stand');
    expect(seen[0]!.frame).toBeCloseTo(seen[0]!.phase * 16, 9);
    weight = 0.5;
    anim.step(1 / 60, REST);
    expectMatrix(sk.local[1]!, partMatrix(qx(20), [1, -1, 0]));
  });

  it("the held item's node: a clip's weapon track moves the rifle when the clip has no rifle track", () => {
    const part = (index: number, name: string, parent: number): SkeletonPart => ({
      index, name, parent, bindLocal: partMatrix(Q_ID, [0, 0, 0]), bbox: new Float32Array(6), type: 0, flags: 0,
    });
    const sk = new Skeleton('t', IDENTITY, [part(0, 'skel_root', -1), part(1, HELD_PART, 0)]);
    expect(partIndex(sk, [{ name: HELD_ALIAS }], HELD_ALIAS)).toBe(1);
    expect(partIndex(sk, [{ name: HELD_ALIAS }, { name: HELD_PART }], HELD_ALIAS)).toBe(-1);
    expect(partIndex(sk, [], 'skel_root')).toBe(0);
  });

  it("names the locomotion cycles (the footfalls' clips), a pistol version as its rifle clip", () => {
    for (const n of ['seal_walk_alert', 'seal_run', 'seal_run_90l', 'seal_crouchwalk_bw', 'seal_prone_crawl', 'seal_p_run']) expect(isCycle(n), n).toBe(true);
    for (const n of ['seal_stand', 'seal_jump', 'seal_crouch', 'seal_walk']) expect(isCycle(n), n).toBe(false);
  });
});

// ---- the owner's pack on Frostfire's SEAL -----------------------------------------------------------------------------

const RUN = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures/RUN');
const PACK = resolve(RUN, 'MOTION_P.ZAR'), READERC = resolve(RUN, 'READERC.ZAR');
const MP2 = fixture('RUN/MP2.ZDB');
const noData = !existsSync(PACK) || !existsSync(READERC) || MP2 === null;

describe.skipIf(noData)(`seal_A_scuba on MOTION_P.ZAR and motion.rdr${noData ? ' (MOTION_P.ZAR, READERC.ZAR or MP2 absent)' : ''}`, () => {
  const load = (): { sk: Skeleton; mesh: SkinnedMeshData; clips: MotionClip[]; table: Map<string, MotionEntry> } => {
    const toc = parseZdb(MP2!);
    const sk = readSkeleton(Zar.parse(zdbMember(MP2!, toc, 'CLIB_GEO.ZED')), 'seal_A_scuba');
    const mesh = readMeshLibrary(Zar.parse(zdbMember(MP2!, toc, 'CLIB_MDL.ZED')), ['seal_A_scuba'])[0]!.mesh!;
    return {
      sk, mesh, clips: clipsFromPack(new Uint8Array(readFileSync(PACK)), PLAY_CLIPS),
      table: motionTableFromArchive(new Uint8Array(readFileSync(READERC)))!,
    };
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

  it('finds every clip the plays name in the pack', () => {
    const { clips } = load();
    const names = clips.map((c) => c.name);
    for (const n of MOTION_CLIPS) expect(names, n).toContain(n);
  });

  it('full ahead plays seal_run at the node speed research 25 traced in memory, 1.1265 (65 / 57.7)', () => {
    const { sk, clips, table } = load();
    const anim = new Animator(sk, clips, table);
    anim.step(1 / 60, running(1));
    const [run] = anim.stats().nodes;
    expect(run).toMatchObject({ clip: 'seal_run', weight: 1 });
    expect(run!.speed).toBeCloseTo(1.1265, 2);
  });

  it('driven at 60 Hz through a walk, a run, a strafe, a stop and a crouch, the soles stay within a unit of the floor', () => {
    const { sk, mesh, clips, table } = load();
    const anim = new Animator(sk, clips, table, { random: () => 0 });
    const worst: Record<string, number> = {};
    const run = (steps: number, mover: MoverSnapshot): void => {
      for (let i = 0; i < steps; i++) {
        anim.step(1 / 60, mover);
        if (anim.stats().blend < 1) continue;          // a settled play; the cross-fade is not the floor's test
        const y = Math.abs(lowest(sk, mesh));
        const c = anim.stats().clip;
        worst[c] = Math.max(worst[c] ?? 0, y);
      }
    };
    run(90, running(0.3));
    run(90, running(1));
    run(90, running(0, 1));
    run(60, REST);
    run(60, { ...REST, stance: 'crouch' });
    expect(Object.keys(worst).sort()).toEqual(['seal_crouch', 'seal_run', 'seal_run_90r', 'seal_stand', 'seal_walk_alert']);
    for (const [c, y] of Object.entries(worst)) expect(y, c).toBeLessThan(1);
  });
});

// ---- the engine's node blend, the turn in place, the aim's twist and the run's bank ------------------------------------

/** A skeleton with the two spine nodes FUN_005aca70 turns: skel_root -> spinelo -> spinehi, bind at the identity. */
function spine(): Skeleton {
  const part = (index: number, name: string, parent: number, t: number[]): SkeletonPart => ({
    index, name, parent, bindLocal: partMatrix(Q_ID, t as [number, number, number]), bbox: new Float32Array(6), type: 0, flags: 0,
  });
  return new Skeleton('spine', IDENTITY, [part(0, 'skel_root', -1, [0, 11, 0]), part(1, 'spinelo', 0, [0, 1, 0]), part(2, 'spinehi', 1, [0, 3, 0])]);
}
const still = (name: string): MotionClip => clip(name, 10, [
  { name: 'skel_root', t: [[0, 11, 0]], q: [Q_ID] }, { name: 'spinelo', t: [[0, 1, 0]], q: [Q_ID] }, { name: 'spinehi', t: [[0, 3, 0]], q: [Q_ID] },
]);
/** The angle of a unit quaternion, radians. */
const angleOf = (q: readonly number[]): number => 2 * Math.acos(Math.min(1, Math.abs(q[3]!)));

describe('the engine\'s node blend (FUN_00577000, FUN_00576e30, FUN_00306ae0)', () => {
  it('the slerp: the shorter arc, a normalised lerp over a dot of 0.95, the true slerp under it', () => {
    const a = qx(0), b = qx(10);                                    // dot 0.996: the lerp
    const mid = slerp(a, b, 0.5);
    expect(angleOf(mid) * 180 / Math.PI).toBeCloseTo(5, 3);
    const c = qx(90);                                               // dot 0.707: the slerp
    expect(angleOf(slerp(a, c, 0.25)) * 180 / Math.PI).toBeCloseTo(22.5, 6);
    expect(slerp(a, c.map((v) => -v), 0.5)[3]).toBeGreaterThan(0.9);   // -q is the same turn
  });

  it('merges the lateral clips first, then the others, then the two results, each pair by wb / (wa + wb)', () => {
    const f1 = qx(0), f2 = qx(20), l1 = qx(60), l2 = qx(80);
    const got = mergeRotations([
      { q: f1, w: 0.3, lateral: false }, { q: f2, w: 0.3, lateral: false }, { q: l1, w: 0.2, lateral: true }, { q: l2, w: 0.2, lateral: true },
    ])!;
    const lat = slerp(l1, l2, 0.5), fwd = slerp(f1, f2, 0.5);
    const want = slerp(lat, fwd, 0.6 / 1.0);                        // the lateral pair survives first in the list's order
    got.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 9));
    expect(mergeRotations([{ q: null, w: 0.5, lateral: false }, { q: f2, w: 0.5, lateral: false }])).toEqual(f2);
  });
});

describe('the turn in place (FUN_00586050, FUN_00583960)', () => {
  it('the step\'s speed: |turn / turn_maxrate| x the stance\'s share, capped; backwards turning left', () => {
    expect(turnStepSpeed(-2.236, 'stand')).toBeCloseTo(0.6, 9);    // full right: 1.118 x 0.6 capped at 0.6
    expect(turnStepSpeed(2.236, 'stand')).toBeCloseTo(-0.6, 9);    // full left: backwards
    expect(turnStepSpeed(-1, 'stand')).toBeCloseTo(0.3, 9);
    expect(turnStepSpeed(-1, 'crouch')).toBeCloseTo(0.15, 9);
    expect(turnStepSpeed(-4, 'prone')).toBeCloseTo(0.35, 9);
  });

  it('standing still and turning plays seal_step, crouched seal_crouch_step, prone seal_prone_turn, at that speed', () => {
    const clips = ['seal_stand', 'seal_step', 'seal_crouch', 'seal_crouch_step', 'seal_prone', 'seal_prone_turn'].map((n) => pose(n, 20, 0));
    const table = new Map<string, MotionEntry>([
      ['seal_step', entry({ looped: true, playback: 0.65, maxVelocity: -2, blendTime: 0.9 })],
      ['seal_crouch_step', entry({ looped: true, playback: 0.4, maxVelocity: -2, blendTime: 0.9 })],
    ]);
    const anim = new Animator(skeleton(), clips, table);
    anim.step(1 / 60, { ...REST, turnRate: -2.236 });
    expect(anim.stats()).toMatchObject({ clip: 'seal_step', play: 'turn:stand' });
    expect(anim.stats().nodes[0]!.speed).toBeCloseTo(0.6, 9);
    expect(anim.stats().rate).toBeCloseTo((0.6 / 0.65) * 20, 6);   // 0.6 of a cycle per 0.65 s
    anim.step(1 / 60, { ...REST, turnRate: -1 });
    expect(anim.stats().nodes[0]!.speed).toBeCloseTo(0.3, 9);       // the speed follows the turn, no new play
    anim.step(1 / 60, { ...REST, stance: 'crouch', turnRate: 1 });
    expect(anim.stats()).toMatchObject({ clip: 'seal_crouch_step', play: 'turn:crouch' });
    expect(anim.stats().nodes[0]!.speed).toBeCloseTo(-0.15, 9);
    anim.step(1 / 60, { ...REST, stance: 'prone', turnRate: 1 });
    expect(anim.stats().clip).toBe('seal_prone_turn');
    anim.step(1 / 60, { ...REST, turnRate: 0 });
    expect(anim.stats().clip).toBe('seal_stand');
  });
});

describe('the aim\'s twist and the run\'s bank on the spine (FUN_005aca70, FUN_0057a330)', () => {
  const at = (sk: Skeleton, name: string): number[] => quatOfMatrix(sk.local[sk.indexOf(name)]!);

  it('the upper body takes the pitch: spinelo 2 x 0.1 x sin, spinehi 2 x 0.4 x sin, about x, upward for up', () => {
    const sk = spine();
    const anim = new Animator(sk, [still('seal_stand')], null);
    anim.step(1 / 60, { ...REST, pitch: 30 });
    const lo = at(sk, 'spinelo'), hi = at(sk, 'spinehi');
    expect(angleOf(lo)).toBeCloseTo(2 * TWIST_SHARE.spinelo * Math.sin(Math.PI / 6), 5);
    expect(angleOf(hi)).toBeCloseTo(2 * TWIST_SHARE.spinehi * Math.sin(Math.PI / 6), 5);
    // the chest's forward (-z) turned up: y > 0
    const fwd = qrot(qmul(lo, hi), [0, 0, -1]);
    expect(fwd[1]).toBeGreaterThan(0.4);
    expect(anim.stats().twist).toBeCloseTo(2 * 0.5 * 0.5, 5);
  });

  it('none on a NoPitchtwist clip, none prone, none with no pitch given', () => {
    const table = new Map<string, MotionEntry>([['seal_stand', entry({ looped: true, playback: 6, maxVelocity: -0.1, noPitchtwist: true })]]);
    const a = spine();
    new Animator(a, [still('seal_stand')], table).step(1 / 60, { ...REST, pitch: 30 });
    expect(angleOf(at(a, 'spinehi'))).toBeCloseTo(0, 9);
    const b = spine();
    new Animator(b, [still('seal_prone')], null).step(1 / 60, { ...REST, stance: 'prone', pitch: 30 });
    expect(angleOf(at(b, 'spinehi'))).toBeCloseTo(0, 9);
  });

  it('the bank: -0.000375 x the turn x the local z speed about spinelo\'s parent z -- 3.1 degrees into a full turn at 65', () => {
    const sk = spine();
    const anim = new Animator(sk, [still('seal_stand'), still('seal_run')], new Map([['seal_run', cycle(6.5, 4.01, 6.5)]]));
    anim.step(1 / 60, { ...running(1), turnRate: 2.236, pitch: 0 });
    const want = 2.236 * -65 * BANK_FACTOR;
    expect(want * 180 / Math.PI).toBeCloseTo(3.1, 1);
    expect(anim.stats().bank).toBeCloseTo(want, 6);
    const lo = at(sk, 'spinelo');
    expect(lo[2]).toBeCloseTo(Math.sin(want / 2), 5);               // about z: a left turn leans left (+z)
    anim.step(1 / 60, { ...running(1), turnRate: 2.236, airborne: true });
    expect(anim.stats().bank).toBe(0);
  });
});

// ---- TRAVERSAL SEAM: a traversal move's clip (web research 86) ----------------------------------------------------

describe('a traversal move\'s clip in place of the mover\'s play (web research 86)', () => {
  it('plays the move\'s clip at the move\'s key, the root at the move\'s height, and fires its callbacks as it passes them', () => {
    const { clips, table } = standingKit();
    const rung = clip('seal_climbladder', 16, [{ name: 'skel_root', t: keys(16, (i) => [0, 15.6 + 0.625 * i, -7.6]), q: [Q_ID] }]);
    table.set('seal_climbladder', entry({ looped: true, playback: 3, maxVelocity: 1.35, callbacks: [{ name: 'ladder_rung', time: 0.01 }, { name: 'ladder_rung', time: 0.5 }] }));
    const anim = new Animator(skeleton(), [...clips, rung], table);
    const heard: string[] = [];
    anim.onEvent((e) => { if (e.kind === 'callback') heard.push(e.name); });
    anim.step(1 / 60, REST);
    expect(anim.stats().clip).toBe('seal_stand');
    const at = (frame: number): MoverSnapshot => ({ ...REST, traversal: { clip: 'seal_climbladder', frame, loop: true, rootY: 15.6 } });
    anim.step(1 / 60, at(0));
    expect(anim.stats().play).toBe('trav:seal_climbladder');
    expect(anim.stats().frame).toBeCloseTo(0, 6);
    for (let f = 0.7; f < 9; f += 0.7) anim.step(1 / 60, at(f));
    anim.step(1 / 60, at(9));
    expect(anim.stats().frame).toBeCloseTo(9, 6);
    expect(heard).toEqual(['ladder_rung', 'ladder_rung']);           // 0.01 and 0.5 of the cycle, each crossed once
    for (let i = 0; i < 60; i++) anim.step(1 / 60, at(9));           // the cross-fade settles
    expect(anim.rootY()).toBeCloseTo(15.6, 6);                       // the move's root, not the clip's 15.6 + 0.625 x 9
    anim.step(1 / 60, REST);
    expect(anim.stats().play).toBe('idle:stand');                    // the move over: the mover's own play again
  });
});

describe('the translations the engine takes from a clip (FUN_005777d0) and the zeroed root (FUN_0057a330)', () => {
  it('the six parts and the props take the clip\'s translation; the other body parts keep the skeleton\'s own', () => {
    expect([...SAMPLED_TRANSLATIONS].sort()).toEqual(['hips', 'lbicep', 'lshoulder_wgt', 'rbicep', 'rshoulder_wgt', 'skel_root']);
    expect(BODY_PARTS.has('rifle')).toBe(false);
    expect(BODY_PARTS.size).toBe(26);
    const sk = skeleton();                                          // skel_root, lthigh (body), lbicep (sampled), body
    const moved = clip('seal_stand', 10, [
      { name: 'skel_root', t: [[3, 11, 4]], q: [Q_ID] }, { name: 'lthigh', t: [[5, -5, 5]], q: [Q_ID] },
      { name: 'lbicep', t: [[7, 7, 7]], q: [Q_ID] },
    ]);
    new Animator(sk, [moved], null).step(1 / 60, REST);
    expect(Array.from(sk.local[0]!.subarray(12, 15))).toEqual([0, 11, 0]);   // the root: x and z zeroed, the clip's y
    expect(Array.from(sk.local[1]!.subarray(12, 15))).toEqual([1, -1, 0]);   // lthigh: the bind's
    expect(Array.from(sk.local[2]!.subarray(12, 15))).toEqual([7, 7, 7]);    // lbicep: the clip's
  });
});

describe('the pistol action set (FUN_0058c9e0, FUN_00576bb0)', () => {
  it('each node takes its own pistol version over the parts it carries, and setWeapon switches with a cross-fade', () => {
    const sk = skeleton();
    const run = walker('seal_run', 19, 57.7, 0), side = clip('seal_run_90r', 18, [{ name: 'skel_root', t: [[0.5, 10, 20]], q: [Q_ID] }, { name: 'lthigh', t: [[1, -1, 0]], q: [qx(10)] }]);
    const pRun = clip('seal_p_run', 19, [{ name: 'lbicep', t: [[2, 6, 0]], q: [qx(60)] }]);
    const pSide = clip('seal_p_run_90r', 18, [{ name: 'lbicep', t: [[2, 6, 0]], q: [qx(20)] }]);
    const table = new Map<string, MotionEntry>([['seal_run', cycle(6.5, 4.01, 6.5)], ['seal_run_90r', cycle(6.5, 3, 6.5, { lateral: true })]]);
    const anim = new Animator(sk, [run, side, pRun, pSide], table);
    anim.step(1 / 60, running(Math.SQRT1_2, Math.SQRT1_2));
    expect(angleOf(quatOfMatrix(sk.local[2]!))).toBeCloseTo(0, 6);             // the rifle: no pistol arms
    anim.setWeapon('pistol');
    anim.step(0, running(Math.SQRT1_2, Math.SQRT1_2));
    expect(anim.stats().blend).toBe(0);                                          // the cross-fade from the rifle's pose
    for (let i = 0; i < 40; i++) anim.step(1 / 60, running(Math.SQRT1_2, Math.SQRT1_2));
    // each node's arm its own pistol clip's, merged half and half: 40 degrees
    expect(angleOf(quatOfMatrix(sk.local[2]!)) * 180 / Math.PI).toBeCloseTo(40, 1);
    expect(anim.stats().layer).not.toBeNull();
  });
});
