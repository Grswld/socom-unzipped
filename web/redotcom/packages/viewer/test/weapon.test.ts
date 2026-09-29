import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseZdb, Zar, zdbMember } from '@s2u/archive';
import {
  DEFAULT_RIFLE, IDENTITY, partMatrix, readSkeleton, sampleClip, Skeleton, transformPoint, type MotionClip, type MotionPart,
  type SkeletonPart,
} from '@s2u/scene';
import { buildGrid, HELD_RIFLE, HELD_SIDEARM, type CollisionOwner, type Grid, type GridParams, type WorldPoly } from '@s2u/scene';
import { fixture } from '../../archive/test/fixtures';
import { Fire, PIP_TOLERANCE, type FireEvent } from '../src/fire';
import { PIP_FADE, PIP_FULL, PIP_SCOPED_REACH, stepPip, type PipState } from '../src/reticle';
import { Animator, partIndex, type MoverSnapshot } from '../src/animator';
import { HELD_ITEM, heldSkeleton, muzzleOf, muzzlePoint } from '../src/heldItem';
import { clipsFromPack, type MotionEntry } from '../src/motionTable';
import { RifleKick, STICK_FOLLOW_PLACEHOLDER } from '../src/rifleKick';
import {
  FIRE_VERSIONS, RELOAD_BLEND_PLACEHOLDER, RELOAD_CLIPS, reloadLength, STILL_CLIPS, WEAPON_CLIPS, WeaponPose,
} from '../src/weaponPose';
import {
  ALL_RELOAD_CLIPS, PISTOL_RELOAD_CLIPS, RELOAD_CLIPS as SHARED_RELOAD_CLIPS, RELOAD_SECONDS_PLACEHOLDER, reloadClip, reloadLockSeconds,
  reloadMoving, reloadSeconds, type ReloadItem, type ReloadStance,
} from '../src/reloadClip';
import { AIM_HOLDS_RAISE, ease, Envelope, LOWER_DELAY, nextEdge, RAISE_TIMES, WeaponRaise } from '../src/weaponRaise';

/**
 * The WEAPON workstream: the rifle in the hands (`./heldItem`), raised to fire (`./weaponRaise`, `./weaponPose`), its
 * kick (`./rifleKick`). Synthetic data pins the ported rules to the decomp's numbers; the owner's MOTION_P.ZAR and
 * Frostfire's SEAL pin where the rifle sits.
 */

const Q_ID: [number, number, number, number] = [0, 0, 0, 1];
const qx = (deg: number): [number, number, number, number] => {
  const a = (deg * Math.PI) / 360;
  return [Math.sin(a), 0, 0, Math.cos(a)];
};

function clip(name: string, frames: number, parts: { name: string; t: number[][]; q: number[][] }[]): MotionClip {
  const mparts: MotionPart[] = parts.map((p, index) => ({
    index, name: p.name, flags: 0x0c | (p.q.length === 1 ? 0x10 : 0) | (p.t.length === 1 ? 0x20 : 0),
    translations: Float32Array.from(p.t.flat()), rotations: Float32Array.from(p.q.flat()),
  }));
  return { name, version: 5, duration: frames / 30, frameCount: frames, rate: 30, unknown10: -1, unknown14: 1, parts: mparts };
}

/** skel_root -> rhand -> (rifle), and lbicep: made-up bind translations. */
function skeleton(): Skeleton {
  const part = (index: number, name: string, parent: number, t: number[]): SkeletonPart => ({
    index, name, parent, bindLocal: partMatrix(Q_ID, t as [number, number, number]), bbox: new Float32Array(6), type: 0, flags: 0,
  });
  return new Skeleton('test', IDENTITY, [part(0, 'skel_root', -1, [0, 11.5, 0]), part(1, 'rhand', 0, [3, 2, 0]), part(2, 'lbicep', 0, [-2, 6, 0])]);
}

const entry = (e: Partial<MotionEntry>): MotionEntry => ({
  looped: null, playback: null, maxVelocity: null, blendTime: null, transitionA: null, transitionB: null, noInterrupt: null, callbacks: [], ...e,
});
const REST: MoverSnapshot = { vx: 0, vz: 0, vy: 0, yaw: 0, airborne: false, crouched: false, landing: null, jumps: 0 };

describe('the raise envelope (FUN_00286b80 .. FUN_00286d90, seal+0x1160)', () => {
  it('rises over `in`, holds, and falls over `out`, eased as the node blend eases', () => {
    const e = new Envelope();
    e.start(0.1, 1, 0.5);
    expect(e.remaining).toBeCloseTo(1.6, 9);
    expect(e.linear()).toBe(0);                                   // just started: the rise's foot
    e.run(0.05);
    expect(e.linear()).toBeCloseTo(0.5, 9);
    expect(e.weight()).toBeCloseTo(0.5, 9);
    e.run(0.025);
    expect(e.linear()).toBeCloseTo(0.75, 9);
    expect(e.weight()).toBeCloseTo(1 - 2 * 0.25 * 0.25, 9);       // the ease's mirror half
    e.run(0.5);
    expect(e.weight()).toBe(1);                                   // the hold
    e.run(0.775);                                                 // 0.25 s left: halfway down the 0.5 s fall
    expect(e.linear()).toBeCloseTo(0.5, 6);
    e.run(10);
    expect(e.remaining).toBe(0);
    expect(e.weight()).toBe(0);
    expect(ease(0.25)).toBeCloseTo(0.125, 12);
  });

  it('pins FUN_005dffc0\'s rifle times and the controller\'s 5 s (FUN_00598280)', () => {
    expect(RAISE_TIMES).toEqual({ in: 0.1, hold: 100000, out: 0.5 });
    expect(LOWER_DELAY).toEqual({ base: 5, random: 0 });
    expect(AIM_HOLDS_RAISE).toBe(true);
  });
});

describe('the rifle raised to fire (FUN_005dfe30 / FUN_005dfc80 / FUN_00594cf0)', () => {
  const run = (r: WeaponRaise, seconds: number, input: { trigger: boolean; aiming: boolean }, dt = 1 / 60): number => {
    let w = 0;
    for (let t = 0; t < seconds - 1e-9; t += dt) w = r.frame(dt, input);
    return w;
  };
  const IDLE = { trigger: false, aiming: false }, FIRING = { trigger: true, aiming: false };

  it('reads the fire button as the game\'s edges: pressed, held, released, idle', () => {
    expect([nextEdge(0, true), nextEdge(2, true), nextEdge(1, true), nextEdge(1, false), nextEdge(3, false), nextEdge(3, true)])
      .toEqual([2, 1, 1, 3, 0, 2]);
  });

  it('starts down; the trigger raises it in 0.1 s, eased; it stays up 5 s after the release, then falls in 0.5 s', () => {
    const r = new WeaponRaise();
    expect(run(r, 1, IDLE)).toBe(0);
    expect(r.stats().state).toBe('down');
    const half = run(r, 0.05, FIRING);
    expect(half).toBeGreaterThan(0.2);
    expect(half).toBeLessThan(0.8);
    expect(run(r, 0.1, FIRING)).toBe(1);
    expect(r.stats()).toMatchObject({ state: 'up', moving: false });
    expect(run(r, 4.9, IDLE)).toBe(1);                              // the countdown: still up just under 5 s on
    expect(run(r, 0.2, IDLE)).toBeLessThan(1);                      // then it falls
    expect(r.stats().state).toBe('down');
    expect(run(r, 0.5, IDLE)).toBe(0);                              // gone within the out time
  });

  it('snaps back up when the trigger comes during the fall (the envelope is pinned at the hold)', () => {
    const r = new WeaponRaise();
    run(r, 0.2, FIRING);
    run(r, 5.2, IDLE);
    const falling = r.weight();
    expect(falling).toBeGreaterThan(0);
    expect(falling).toBeLessThan(1);
    expect(r.frame(1 / 60, FIRING)).toBe(1);
  });

  it('keeps the rifle up while aiming, the countdown reset', () => {
    const r = new WeaponRaise();
    run(r, 0.2, FIRING);
    expect(run(r, 8, { trigger: false, aiming: true })).toBe(1);
    expect(r.stats().countdown).toBeCloseTo(5, 6);
  });
});

describe('the Fire set and the reload as pose layers (FUN_005e0690 pairs, animset.rdr names)', () => {
  it('pairs the twelve base types with their Fire clips, and asks for every clip it plays', () => {
    expect(FIRE_VERSIONS.seal_stand).toBe('seal_fp_stand');
    expect(FIRE_VERSIONS.seal_walk_alert).toBe('seal_fp_walk');
    expect(FIRE_VERSIONS.seal_run).toBe('seal_fp_run');
    expect(FIRE_VERSIONS.seal_run_bw).toBe('seal_fp_run_bw');           // Jog backwards -> Fire run backwards
    expect(FIRE_VERSIONS.seal_crouchwalk_bw).toBe('seal_fp_crouchwalk_bw');
    expect(FIRE_VERSIONS.seal_prone).toBe('seal_fp_prone');
    expect(FIRE_VERSIONS.seal_lstrafe).toBeUndefined();                // no Fire version: the strafes blend nothing
    expect(FIRE_VERSIONS.seal_jump).toBeUndefined();
    expect(new Set(Object.values(FIRE_VERSIONS)).size).toBe(12);
    for (const name of [...Object.values(FIRE_VERSIONS), ...Object.values(RELOAD_CLIPS)]) expect(WEAPON_CLIPS).toContain(name);
  });

  it('blends the Fire version over the clip at the raise weight; nothing at 0', () => {
    const sk = skeleton();
    const stand = clip('seal_stand', 10, [{ name: 'lbicep', t: [[-2, 6, 0]], q: [qx(0)] }]);
    const fire = clip('seal_fp_stand', 8, [{ name: 'lbicep', t: [[-2, 6, 0]], q: [qx(80)] }]);
    const table = new Map<string, MotionEntry>([['seal_fp_stand', entry({ looped: true, maxVelocity: -1, playback: 1 })]]);
    const anim = new Animator(sk, [stand, fire], table);
    const pose = new WeaponPose(new Map([[stand.name, stand], [fire.name, fire]]), table);
    anim.addPoseLayer(pose.fireLayer);
    anim.step(1 / 60, REST);
    expect(sk.local[2]![5]).toBeCloseTo(1, 6);                          // weight 0: the stand's arm
    pose.fireWeight = 1;
    anim.step(1 / 60, REST);
    expect(Array.from(sk.local[2]!)).toEqual(Array.from(partMatrix(qx(80), [-2, 6, 0])).map((v) => expect.closeTo(v, 5)));
    expect(pose.stats()).toMatchObject({ fire: 'seal_fp_stand', fireWeight: 1 });
    pose.fireWeight = 0.5;
    anim.step(1 / 60, REST);
    expect(Array.from(sk.local[2]!)).toEqual(Array.from(partMatrix(qx(40), [-2, 6, 0])).map((v) => expect.closeTo(v, 5)));
  });

  it('plays the stance\'s reload for its playback seconds, the moving one over a moving clip, in and out over 0.2 s', () => {
    const still = clip('seal_stand', 10, [{ name: 'lbicep', t: [[-2, 6, 0]], q: [qx(0)] }]);
    const reload = clip('seal_reload', 30, [{ name: 'lbicep', t: [[-2, 6, 0]], q: [qx(90)] }]);
    const mv = clip('seal_mv_reload', 30, [{ name: 'lbicep', t: [[-2, 6, 0]], q: [qx(-90)] }]);
    const table = new Map<string, MotionEntry>([['seal_reload', entry({ looped: false, maxVelocity: -1, playback: 1.6 })]]);
    const clips = new Map([[still.name, still], [reload.name, reload], [mv.name, mv]]);
    const pose = new WeaponPose(clips, table);
    expect(pose.reloadSeconds('stand', false)).toBe(1.6);                      // motion.rdr's playback
    expect(pose.reloadSeconds('stand', true)).toBe(1);                         // no entry: 30 keys at 30 a second
    expect(reloadLength(undefined, table)).toBeNull();
    pose.startReload('stand', 1.6);
    pose.step(0.1);
    const at = pose.reloadLayer.sample({ clip: still, frame: 0, phase: 0 })!;
    expect(at.weight).toBeCloseTo(0.1 / RELOAD_BLEND_PLACEHOLDER, 9);
    expect(pose.stats().reload).toBe('seal_reload');
    pose.step(0.5);
    expect(pose.reloadLayer.sample({ clip: still, frame: 0, phase: 0 })!.weight).toBe(1);
    expect(STILL_CLIPS.has('seal_run')).toBe(false);
    // FUN_005a82e0: over 20 units a second (the page sets `moving`) the overlay, at the same normalised time
    pose.moving = true;
    pose.reloadLayer.sample({ clip: still, frame: 0, phase: 0 });
    expect(pose.stats().reload).toBe('seal_mv_reload');
    expect(pose.reloadClip('prone', true)).toBe('seal_prone_reload');                // prone: no moving reload
    pose.item = 'pistol';
    expect([pose.reloadClip('stand', false), pose.reloadClip('crouch', false), pose.reloadClip('prone', false), pose.reloadClip('stand', true)])
      .toEqual(['seal_p_reload', 'seal_p_crouch_reload', 'seal_p_prone_reload', 'seal_p_mv_reload']);
    pose.item = 'rifle';
    pose.moving = false;
    pose.step(1.1);
    expect(pose.reloading()).toBe(false);
    expect(pose.reloadLayer.sample({ clip: still, frame: 0, phase: 0 })).toBeNull();
  });
});

describe('the reload\'s one table, the page\'s and the room\'s (MJ-1; FUN_005a82e0, FUN_005c2a90)', () => {
  /** motion.rdr's playbacks [data] for the rifle's four, made-up distinct ones for the pistol's. */
  const PLAYBACK: Record<string, number> = {
    seal_reload: 1.6, seal_crouch_reload: 1.9, seal_prone_reload: 1.7, seal_mv_reload: 1.2,
    seal_p_reload: 1.45, seal_p_crouch_reload: 1.7, seal_p_prone_reload: 1.75, seal_p_mv_reload: 1.1,
  };
  const table = new Map<string, MotionEntry>(Object.entries(PLAYBACK).map(([n, p]) => [n, entry({ looped: false, maxVelocity: -1, playback: p })]));
  const list = ALL_RELOAD_CLIPS.map((n) => clip(n, 30, [{ name: 'lbicep', t: [[-2, 6, 0]], q: [qx(0)] }]));
  const byName = new Map(list.map((c) => [c.name, c]));

  it('is the weapon layer\'s own table: the same clip names, eight of them', () => {
    expect(RELOAD_CLIPS).toBe(SHARED_RELOAD_CLIPS);
    expect(ALL_RELOAD_CLIPS).toEqual([...Object.values(RELOAD_CLIPS), ...Object.values(PISTOL_RELOAD_CLIPS)]);
    expect(new Set(ALL_RELOAD_CLIPS).size).toBe(8);
    for (const name of ALL_RELOAD_CLIPS) expect(WEAPON_CLIPS).toContain(name);
  });

  it('the rifle\'s lock is its clip\'s playback: stand 1.6, crouch 1.9, prone 1.7, moving 1.2 (prone never the moving one)', () => {
    expect(reloadSeconds(byName, table, 'stand', false)).toBe(1.6);
    expect(reloadSeconds(byName, table, 'crouch', false)).toBe(1.9);
    expect(reloadSeconds(byName, table, 'prone', false)).toBe(1.7);
    expect(reloadSeconds(byName, table, 'stand', true)).toBe(1.2);
    expect(reloadSeconds(byName, table, 'crouch', true)).toBe(1.2);
    expect(reloadSeconds(byName, table, 'prone', true)).toBe(1.7);
    expect(reloadClip('prone', true, 'pistol')).toBe('seal_p_prone_reload');
  });

  it('WeaponPose.reloadSeconds equals the room\'s lock for every stance, speed and item, from a map or the sim\'s list', () => {
    const pose = new WeaponPose(byName, table);
    for (const item of ['rifle', 'pistol'] as ReloadItem[]) {
      pose.item = item;
      for (const stance of ['stand', 'crouch', 'prone'] as ReloadStance[]) {
        for (const moving of [false, true]) {
          const page = pose.reloadSeconds(stance, moving);
          expect(page, `${item} ${stance} ${moving}`).toBe(PLAYBACK[reloadClip(stance, moving, item)]);
          expect(reloadLockSeconds(list, table, stance, moving, item)).toBe(page);
          expect(reloadLockSeconds(byName, table, stance, moving, item)).toBe(page);
          expect(pose.reloadClip(stance, moving)).toBe(reloadClip(stance, moving, item));
        }
      }
    }
  });

  it('FUN_005a82e0\'s still test: speed squared at most 400 is still, the fall speed counted too', () => {
    expect(reloadMoving(20, 0, 0)).toBe(false);
    expect(reloadMoving(12, 0, 16)).toBe(false);                               // 144 + 256 = 400: still
    expect(reloadMoving(20.01, 0, 0)).toBe(true);
    expect(reloadMoving(0, -21, 0)).toBe(true);                                // vy is in the game's sum
  });

  it('one moving decision: the page\'s body (play.ts) asks reloadMoving, as the room does, and keeps no copy of the test', () => {
    // Release review B10 carry-over: play.ts:224 (the reload's length) and :327 (the pose's moving flag) computed the
    // FUN_005a82e0 sum inline; both now call reloadClip.ts's reloadMoving, so page and room cannot diverge.
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/play.ts'), 'utf8');
    expect(src.match(/\breloadMoving\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/import \{[^}]*\breloadMoving\b[^}]*\} from '\.\/reloadClip'/);
    expect(src).not.toMatch(/RELOAD_STILL_SPEED/);
    expect(src).not.toMatch(/\.vy \* [\w.]*\.vy/);                         // no inline speed-squared sum
  });

  it('with no clips, or the clip missing, the lock is RELOAD_SECONDS_PLACEHOLDER (2 s)', () => {
    expect(RELOAD_SECONDS_PLACEHOLDER).toBe(2);
    expect(reloadLockSeconds(null, table, 'stand', false)).toBe(2);
    expect(reloadLockSeconds([], table, 'stand', false)).toBe(2);
    expect(reloadLockSeconds(list, null, 'stand', false)).toBe(1);             // no table: 30 keys at 30 a second
  });
});

describe('the held item\'s node (FUN_00553290: "rifle" under rhand with the rifle in hand)', () => {
  it('adds the rifle after the body\'s parts, under rhand at the identity', () => {
    const sk = heldSkeleton(skeleton());
    expect(sk.parts.map((p) => p.name)).toEqual(['skel_root', 'rhand', 'lbicep', HELD_ITEM.name, 'pistol']);
    expect(sk.parts[3]!.parent).toBe(1);
    expect(Array.from(sk.world[3]!)).toEqual(Array.from(sk.world[1]!));
  });

  it('moves the rifle by a clip\'s `weapon` track where the clip has no `rifle` (SOCOM 1\'s name)', () => {
    const sk = heldSkeleton(skeleton());
    expect(partIndex(sk, [{ name: 'weapon' }], 'weapon')).toBe(3);
    expect(partIndex(sk, [{ name: 'weapon' }, { name: 'rifle' }], 'weapon')).toBe(-1);
    const jump = clip('seal_stand', 4, [{ name: 'weapon', t: [[1, 2, 3]], q: [qx(10)] }]);
    new Animator(sk, [jump], null).step(1 / 60, REST);
    expect(sk.local[3]![12]).toBeCloseTo(1, 6);
  });

  it('carries the weapon\'s firepoint through the node', () => {
    const sk = heldSkeleton(skeleton());
    expect(muzzlePoint([{ name: 'aimpoint', at: [0, 1, 0] }, { name: 'firepoint', at: [7.7854, 0.8338, 0] }])).toEqual([7.7854, 0.8338, 0]);
    expect(muzzlePoint([{ name: 'firepont', at: [1, 0, 0] }])).toEqual([1, 0, 0]);   // the RPG-7's spelling
    expect(muzzlePoint([])).toBeNull();
    expect(muzzleOf(sk, [7, 1, 0])).toEqual([10, 14.5, 0].map((v) => expect.closeTo(v, 5)));
  });
});

describe('the rifle kick (FUN_005b91c0 / FUN_005b9280; DAT_00650938 = 1 in the image)', () => {
  const stand = DEFAULT_RIFLE.rifleKick.stand!;

  it('climbs by BaseDist + RandomDist x rand at KickRate, then falls back to the rest at KickReturnRate', () => {
    const k = new RifleKick(DEFAULT_RIFLE, () => 0.5);
    let pitch = 0.1;
    k.round(pitch, 'stand');
    const goal = stand.baseDist + stand.randomDist * 0.5;
    expect(k.stats()).toMatchObject({ state: 1, rest: 0.1, goal });
    let peak = pitch;
    for (let i = 0; i < 120; i++) { pitch += k.frame(1 / 60, pitch); peak = Math.max(peak, pitch); }
    expect(peak - 0.1).toBeCloseTo(goal, 1);
    expect(peak - 0.1).toBeLessThanOrEqual(goal + 1e-9);
    for (let i = 0; i < 120; i++) pitch += k.frame(1 / 60, pitch);
    expect(pitch).toBeCloseTo(0.1, 9);
    expect(k.stats().state).toBe(0);
    expect(STICK_FOLLOW_PLACEHOLDER).toBe(0);
  });

  it('climbs under a held trigger: each round re-seats the rest where it finds the pitch', () => {
    const k = new RifleKick(DEFAULT_RIFLE, () => 0);
    let pitch = 0;
    for (let round = 0; round < 5; round++) {
      k.round(pitch, 'stand');
      for (let i = 0; i < 7; i++) pitch += k.frame(DEFAULT_RIFLE.fireWait / 7, pitch);
    }
    expect(pitch).toBeCloseTo(5 * stand.rate * DEFAULT_RIFLE.fireWait, 6);            // 0.06 rad a round at FireWait 0.12
  });

  it('reads the stance\'s record, and does nothing for a weapon without one', () => {
    const k = new RifleKick(DEFAULT_RIFLE, () => 0);
    k.round(0, 'prone');
    expect(k.stats().goal).toBe(DEFAULT_RIFLE.rifleKick.prone!.baseDist);
    const none = new RifleKick({ rifleKick: { stand: null, crouch: null, prone: null } });
    none.round(0, 'stand');
    expect(none.frame(1 / 60, 0)).toBe(0);
  });
});

// ---- the owner's pack on Frostfire's SEAL -------------------------------------------------------------------------------

const PACK = resolve(dirname(fileURLToPath(import.meta.url)), '../../../public/maps/RUN/MOTION_P.ZAR');
const MP2 = fixture('RUN/MP2.ZDB');
const noData = !existsSync(PACK) || MP2 === null;

describe.skipIf(noData)(`the M4A1 SD on seal_A_scuba's hand${noData ? ' (MOTION_P.ZAR or the MP2 fixture absent)' : ''}`, () => {
  const load = (): { sk: Skeleton; clips: Map<string, MotionClip> } => {
    const toc = parseZdb(MP2!);
    const sk = heldSkeleton(readSkeleton(Zar.parse(zdbMember(MP2!, toc, 'CLIB_GEO.ZED')), 'seal_A_scuba'));
    const clips = clipsFromPack(new Uint8Array(readFileSync(PACK)), ['seal_stand', 'seal_jump', ...WEAPON_CLIPS]);
    return { sk, clips: new Map(clips.map((c) => [c.name, c])) };
  };
  /** A clip's first key on the skeleton, as the animator writes it (the root over the feet at the bind's x and z). */
  const posed = (sk: Skeleton, c: MotionClip): Skeleton => {
    sk.resetToBind();
    const parts = sampleClip(c, 0).parts;
    for (const p of parts) {
      const i = partIndex(sk, parts, p.name);
      if (i < 0) continue;
      const t: [number, number, number] = i === 0 ? [sk.parts[0]!.bindLocal[12]!, p.translation[1], sk.parts[0]!.bindLocal[14]!] : p.translation;
      sk.setLocal(i, partMatrix(p.rotation, t));
    }
    sk.update();
    return sk;
  };
  const MUZZLE: [number, number, number] = [7.7854, 0.8338, 0], SIGHT: [number, number, number] = [-0.2146, 0.8338, 0];

  it('shoulders the rifle in seal_fp_stand: the barrel along the body\'s forward, the sight at the cheek, 15.2 up', () => {
    const { sk, clips } = load();
    posed(sk, clips.get('seal_fp_stand')!);
    const w = sk.world[sk.indexOf('rifle')]!;
    const barrel = [w[0]!, w[1]!, w[2]!];                    // the node's +x, the weapon's barrel
    expect(barrel[2]).toBeLessThan(-0.99);                   // along -z, the model's forward, within 8 degrees
    const sight = transformPoint(w, ...SIGHT), muzzle = muzzleOf(sk, MUZZLE)!;
    expect(sight[1]).toBeCloseTo(15.2, 0);
    expect(muzzle[2]).toBeLessThan(sight[2] - 7.9);          // the muzzle 8 ahead of the sight
    const head = sk.world[sk.indexOf('head')]!;
    expect(Math.hypot(sight[0] - head[12]!, sight[1] - head[13]!)).toBeLessThan(2);   // under the eye, beside the cheek
  });

  it('carries it at the low ready in seal_stand, lower than the fire pose, the left hand under the fore-end', () => {
    const { sk, clips } = load();
    posed(sk, clips.get('seal_stand')!);
    const low = muzzleOf(sk, MUZZLE)!;
    const lhand = sk.world[sk.indexOf('lhand')]!;
    const w = sk.world[sk.indexOf('rifle')]!;
    // the left hand is near the barrel's line, a few units ahead of the grip
    const ahead = (lhand[12]! - w[12]!) * w[0]! + (lhand[13]! - w[13]!) * w[1]! + (lhand[14]! - w[14]!) * w[2]!;
    expect(ahead).toBeGreaterThan(0.5);
    expect(ahead).toBeLessThan(6);
    posed(sk, clips.get('seal_fp_stand')!);
    expect(muzzleOf(sk, MUZZLE)![1]).toBeGreaterThan(low[1] + 1.5);
  });

  it('keeps it in the hand through the clips that name it `weapon` (seal_jump)', () => {
    const { sk, clips } = load();
    posed(sk, clips.get('seal_jump')!);
    const w = sk.world[sk.indexOf('rifle')]!, hand = sk.world[sk.indexOf('rhand')]!;
    expect(Math.hypot(w[12]! - hand[12]!, w[13]! - hand[13]!, w[14]! - hand[14]!)).toBeLessThan(2);
  });

  it('finds every Fire and reload clip in the pack', () => {
    const { clips } = load();
    for (const name of WEAPON_CLIPS) expect(clips.has(name), name).toBe(true);
  });
});

// ---- round 2: the sidearm's magazine, the pip ------------------------------------------------------------------------

describe('the accuracy pip (FUN_00215250, FUN_005aa6e0): a blocked muzzle', () => {
  it('shows past the drawn size, fading in 32 a frame to 128; hides inside it (a signed test) and fades out', () => {
    let s: PipState = { alpha: 0, offset: null };
    s = stepPip(s, [40, 5], 10, false);
    expect(s).toEqual({ alpha: 32, offset: [40, 5] });
    for (let i = 0; i < 5; i++) s = stepPip(s, [40, 5], 10, false);
    expect(s.alpha).toBe(PIP_FULL);
    s = stepPip(s, [-60, -60], 10, false);                     // up and to the left: both under the size, signed
    expect(s.alpha).toBe(PIP_FULL - PIP_FADE);
    expect(s.offset).toEqual([40, 5]);                          // fading where it was
    for (let i = 0; i < 4; i++) s = stepPip(s, null, 10, false);
    expect(s).toEqual({ alpha: 0, offset: null });
  });

  it('pulls a far offset in to 200.032 only scoped', () => {
    expect(stepPip({ alpha: 0, offset: null }, [400, 0], 1, false).offset).toEqual([400, 0]);
    const scoped = stepPip({ alpha: 0, offset: null }, [300, 400], 1, true).offset!;
    expect(Math.hypot(...scoped)).toBeCloseTo(PIP_SCOPED_REACH, 6);
  });

  it('is the muzzle\'s ray meeting something short of the point under the reticle', () => {
    const grid = pipWorld([pipQuad([-50, 0, -60, 50, 0, -60, 50, 50, -60, -50, 50, -60]), pipQuad([-50, 0, -30, 50, 0, -30, 50, 18, -30, -50, 18, -30])]);
    const fire = new Fire({ grid: () => grid, aim: () => ({ eye: [0, 20, 0], far: [0, 20, -1000] }), muzzle: () => [3, 15, -8] }, DEFAULT_RIFLE);
    const p = fire.blockedMuzzle()!;
    expect(p[2]).toBeCloseTo(-30, 6);                          // the low wall, not the wall under the reticle
    const clear = new Fire({ grid: () => grid, aim: () => ({ eye: [0, 20, 0], far: [0, 20, -1000] }), muzzle: () => [0, 19, -8] }, DEFAULT_RIFLE);
    expect(clear.blockedMuzzle()).toBeNull();
    expect(PIP_TOLERANCE).toBe(0.008);
  });
});

describe('the weapon in the hand changes (Fire.setWeapon): each keeps its magazine', () => {
  it('takes the Mark 23 at 12 rounds and three magazines, keeps the rifle\'s count, cancels a reload', () => {
    const grid = pipWorld([pipQuad([-50, 0, -60, 50, 0, -60, 50, 50, -60, -50, 50, -60])]);
    const events: FireEvent[] = [];
    const fire = new Fire({ grid: () => grid, aim: () => ({ eye: [0, 20, 0], far: [0, 20, -1000] }) }, HELD_RIFLE);
    fire.subscribe((e) => events.push(e));
    fire.shoot(); fire.update(0.5); fire.shoot();
    expect(fire.state().magazine.rounds).toBe(28);
    expect(fire.reload()).toBe(true);
    fire.update(0.001);                                        // asked for, not begun (RELOAD_DELAY)
    fire.setWeapon(HELD_RIFLE);                                // the same weapon: nothing
    fire.update(0.02);                                         // begun: the second magazine in
    expect(fire.state().magazine.rounds).toBe(30);
    fire.setWeapon(HELD_SIDEARM);
    expect(events.at(-1)).toMatchObject({ type: 'reloadEnd', completed: false, weapon: { name: 'M4A1 SD' } });
    expect(fire.state().magazine).toEqual({ rounds: 12, capacity: 12, spare: 2, reloading: false });
    fire.shoot();
    expect(events.at(-1)).toMatchObject({ type: 'round', weapon: { name: 'Mark 23', id: 15, fireAnim: 'muzzle_mark23', sounds: { close: '.MARK_23' } } });
    fire.setWeapon(HELD_RIFLE);
    expect(fire.state().magazine).toMatchObject({ rounds: 30, capacity: 30, spare: 2 });   // 30 in, the 28 and a full one kept
    fire.setWeapon(HELD_SIDEARM);
    expect(fire.state().magazine.rounds).toBe(11);
    expect(fire.weaponRecord()).toBe(HELD_SIDEARM);
  });
});

const pipQuad = (points: number[]): WorldPoly =>
  ({ modelName: 'worldmodel', path: 'worldmodel/q', region: 0, ditype: 2, material: 25, ptcount: 4, cameratype: 0, points: Float32Array.from(points) });
function pipWorld(polys: WorldPoly[]): Grid {
  const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 4, cellsZ: 4, originX: -200, originZ: -200 };
  const owners: CollisionOwner[] = polys.map((p, i) => ({ modelName: p.modelName, path: `${p.path}${i}`, first: i, count: 1 }));
  return buildGrid(params, [], [], polys, owners);
}
