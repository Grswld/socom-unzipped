import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRdr, rdrGet, Zar, type RdrNode } from '@s2u/archive';
import type { MotionClip, MotionPart } from '@s2u/scene';
import {
  AXIS_DEAD, BLEND_TIME_DEFAULT, CROUCH_IDLES, MOTION_CLIPS, PISTOL_ANIMS, SEAL_ANIMS, SEAL_SETS, airBands, bandPick, crouchPlay, cycleTravel,
  entryOf, motionOf, nodeSpeed, oneShotSeconds, phaseRate, pronePlay, standPlay, stickSplit, type Motion, type MotionSets,
  type SetName,
} from '../src/locomotion';
import { clipsFromPack, motionTableFromArchive, type MotionEntry } from '../src/motionTable';
import { ACTION_CLIPS } from '../src/walk';

/**
 * `./locomotion`: the loaded motion's constants (`FUN_00287620`, `FUN_0028ab10`, `FUN_0028aa20`), the pick and blend
 * of `FUN_0058bdf0`, the stand, crouch and prone plays (web/docs/research/80-the-jump.md). Synthetic motions pin the
 * arithmetic; the disc's `READERC.ZAR` and `MOTION_P.ZAR` pin the transcriptions.
 */

/** A clip of `frames` keys whose root travels `speed` a second along `axis` (x or -z). */
function travelling(name: string, frames: number, speed: number, axis: 'x' | 'z' = 'z'): MotionClip {
  const t: number[] = [];
  for (let i = 0; i <= frames; i++) {
    const k = i === frames ? 0 : i, d = (speed / 30) * k;
    t.push(axis === 'x' ? d : 0, 10, axis === 'z' ? -d : 0);
  }
  const root: MotionPart = { index: 0, name: 'skel_root', flags: 0x1c, translations: Float32Array.from(t), rotations: Float32Array.of(0, 0, 0, 1) };
  return { name, version: 5, duration: frames / 30, frameCount: frames, rate: 30, unknown10: -1, unknown14: 1, parts: [root] };
}
const entry = (e: Partial<MotionEntry>): MotionEntry => ({
  looped: null, playback: null, maxVelocity: null, blendTime: null, transitionA: null, transitionB: null, noInterrupt: null, callbacks: [], ...e,
});
const loco = (name: string, frames: number, speed: number, mv: number, a: number, b: number, axis: 'x' | 'z' = 'z'): Motion =>
  motionOf(travelling(name, frames, speed, axis), entry({ looped: true, playback: 1, maxVelocity: mv, transitionA: a, transitionB: b }));

describe('a motion as the game holds it (FUN_00287620, FUN_0028ab10, FUN_0028aa20)', () => {
  it('a locomotion cycle: V = max_velocity / 10, T = duration / playback, D its root\'s travel a cycle, K = 100 T / D', () => {
    const m = loco('seal_run', 19, 57.7, 6.5, 4.01, 6.5);
    expect(m.velocity).toBeCloseTo(0.65, 12);
    expect(m.period).toBeCloseTo(19 / 30, 12);
    expect(m.travel).toBeCloseTo(57.7 * 19 / 30, 4);                        // (key 18 - key 0) x 19 / 18
    expect(m.scale).toBeCloseTo((100 * 19 / 30) / (57.7 * 19 / 30), 4);
    expect(m.band!.lo).toBeCloseTo(40.1, 9);
    expect(m.band!.hi).toBe(65);
    expect(m.end).toBe(1);
    // FUN_0028d570: the node speed for m = 1 is V x K: the root travels 65 a second
    expect(nodeSpeed(m, m.velocity) * 57.7).toBeCloseTo(65, 4);
    // a playback other than 1 changes T and K, not the cycle rate: V x K / T is target / D either way
    const fast = motionOf(travelling('x', 19, 57.7), entry({ looped: true, playback: 0.6, maxVelocity: 6.5, transitionA: 0, transitionB: 1 }));
    expect(nodeSpeed(fast, fast.velocity) / fast.period).toBeCloseTo(nodeSpeed(m, m.velocity) / m.period, 9);
  });

  it('a one-shot: T = playback, V and K 1, stopping at (n - 1) / n; its callbacks at their phase, seconds over 1 turned', () => {
    const m = motionOf(travelling('seal_jump', 20, 0), entry({ looped: false, playback: 1.1, maxVelocity: -1, blendTime: 0.32,
      callbacks: [{ name: 'jump_whoosh', time: 0.4 }, { name: 'late', time: 2 }] }));
    expect([m.period, m.velocity, m.scale, m.end, m.blendTime, m.looped]).toEqual([1.1, 1, 1, 0.95, 0.32, false]);
    expect(m.callbacks).toEqual([{ name: 'jump_whoosh', phase: 0.4 }, { name: 'late', phase: 2 / (1.1 * 0.95) }]);
    expect(oneShotSeconds(1.1, 20)).toBeCloseTo(1.1 * 0.95 * 0.95, 12);
    expect(phaseRate([{ motion: m, weight: 1, speed: 1, offset: 0 }]) * oneShotSeconds(1.1, 20)).toBeCloseTo(0.95, 12);
  });

  it('an idle loop plays in its playback: seal_stand\'s cycle takes 6 s (max_velocity < 0: T = playback, K 1)', () => {
    const m = motionOf(travelling('seal_stand', 16, 0), entry({ looped: true, playback: 6, maxVelocity: -0.1 }));
    expect([m.period, m.velocity, m.scale, m.locomotion]).toEqual([6, 1, 1, false]);
    expect(m.blendTime).toBe(BLEND_TIME_DEFAULT);
    expect(BLEND_TIME_DEFAULT).toBe(0.4);                                   // 0x3ecccccd
    expect(cycleTravel(travelling('x', 10, 30, 'x'), true)).toBeCloseTo(10, 9);
  });

  it('no motion.rdr: the transcription of its moving clips stands in (W2.R5), else the clip\'s own rate', () => {
    expect(entryOf('seal_run', null)).toMatchObject({ looped: true, playback: 1, maxVelocity: 6.5, transitionA: 4.01, transitionB: 6.5 });
    expect(entryOf('seal_jump', null)).toBeUndefined();
  });
});

describe('the pick and blend (FUN_0058bdf0, FUN_00583030, FUN_00583350)', () => {
  const walk = loco('seal_walk_alert', 17, 33, 6.5, 0, 4), jog = loco('seal_jog_alert', 19, 47.15, 6.5, 2, 6.15), run = loco('seal_run', 19, 57.7, 6.5, 4.01, 6.5);
  const set = [walk, jog, run];

  it('one band holds the speed: that clip at the weight; two: split by the overlap, the earlier falling off', () => {
    expect(bandPick(1, 1, set).map((n) => [n.motion.name, n.weight])).toEqual([['seal_run', 1]]);
    expect(bandPick(0.2, 1, set).map((n) => [n.motion.name, n.weight])).toEqual([['seal_walk_alert', 1]]);
    const p = bandPick(0.5, 1, set);                                        // 32.5: in 0-40 and 20-61.5
    expect(p.map((n) => n.motion.name)).toEqual(['seal_walk_alert', 'seal_jog_alert']);
    expect(p[1]!.weight).toBeCloseTo(12.5 / 20, 12);
    expect(p[0]!.weight + p[1]!.weight).toBeCloseTo(1, 12);
    // each at the speed that carries its root at 32.5
    for (const n of p) expect(n.speed * n.motion.travel / n.motion.period).toBeCloseTo(32.5, 6);
  });

  it('under every band the lowest-starting clip at its start\'s speed; over every band the highest at its end\'s', () => {
    const high = [loco('a', 10, 30, 6.5, 2, 4), loco('b', 10, 50, 6.5, 3, 5)];
    const under = bandPick(0.1, 1, high);                                   // 6.5 < 20
    expect(under.map((n) => n.motion.name)).toEqual(['a']);
    expect(under[0]!.speed * under[0]!.motion.travel / under[0]!.motion.period).toBeCloseTo(20, 6);
    const low = [loco('c', 10, 30, 6.5, 0, 2), loco('d', 10, 50, 6.5, 0, 3)];
    const over = bandPick(1, 1, low);                                       // 65 > 30
    expect(over.map((n) => n.motion.name)).toEqual(['d']);
    expect(over[0]!.speed * over[0]!.motion.travel / over[0]!.motion.period).toBeCloseTo(30, 6);
  });

  it('a weight under 1 scales what is already in the play by 1 - weight: the strafe set\'s share', () => {
    const play = bandPick(1, 1, set);
    bandPick(1, 0.25, [loco('seal_run_90r', 18, 55, 6.5, 3, 6.5, 'x')], play);
    expect(play.map((n) => [n.motion.name, n.weight])).toEqual([['seal_run', 0.75], ['seal_run_90r', 0.25]]);
  });

  it('the stick\'s split: m = min(1, |stick|), w = asin(|lateral| / |stick|) x 2 / pi; a forward within 0.03 is none', () => {
    expect(stickSplit(1, 0)).toEqual({ m: 1, w: 0 });
    expect(stickSplit(0, -1)).toEqual({ m: 1, w: 1 });
    const d = stickSplit(Math.SQRT1_2, Math.SQRT1_2);
    expect(d.m).toBeCloseTo(1, 12);
    expect(d.w).toBeCloseTo(0.5, 12);
    expect(stickSplit(AXIS_DEAD, 0.5)).toEqual({ m: 0.5, w: 1 });
    expect(stickSplit(0.9, 0.3).w).toBeCloseTo(Math.asin(0.3 / Math.hypot(0.9, 0.3)) * 2 / Math.PI, 12);
  });

  const sets = (): MotionSets => ({
    forward: set, back: [loco('seal_walk_bw', 16, 32.5, 3.7, 0, 2.8), loco('seal_run_bw', 18, 33.7, 3.7, 2, 3.7)],
    right: [loco('seal_rstrafe', 23, 14.6, 6.5, 0, 2.8, 'x'), loco('seal_rstrafe_fast', 27, 26, 6.5, 1, 5, 'x'), loco('seal_run_90r', 18, 55, 6.5, 3, 6.5, 'x')],
    left: [loco('seal_lstrafe', 22, 14.8, 6.5, 0, 2.3, 'x'), loco('seal_lstrafe_fast', 27, 26, 6.5, 0.9, 4.5, 'x'), loco('seal_run_90l', 18, 55, 6.5, 2.5, 6.5, 'x')],
    crouchForward: [loco('seal_crouchwalk', 28, 13, 1.48, 0, 2)], crouchBack: [loco('seal_crouchwalk_bw', 34, 10.1, 1.35, 0, 2)],
    crouchLeft: [loco('seal_crouchstrafe_left', 39, 10.8, 1.5, 0, 2, 'x')], crouchRight: [loco('seal_crouchstrafe_right_fast', 33, 12.4, 1.5, 0, 2, 'x')],
  });

  it('standing: forward, back, each side, and the angles between (FUN_00583030)', () => {
    const s = sets();
    const names = (f: number, r: number): string[] => standPlay(f, r, s).map((n) => `${n.motion.name}:${n.weight.toFixed(3)}`);
    expect(names(1, 0)).toEqual(['seal_run:1.000']);
    expect(names(-1, 0)).toEqual(['seal_run_bw:1.000']);
    expect(names(-0.4, 0)).toEqual(['seal_walk_bw:1.000']);                 // 14.8 in 0-28
    expect(names(0, 1)).toEqual(['seal_run_90r:1.000']);
    expect(names(0, -1)).toEqual(['seal_run_90l:1.000']);
    expect(names(0, 0.2)).toEqual(['seal_rstrafe:0.833', 'seal_rstrafe_fast:0.167']);   // 13 in 0-28 and 10-50
    expect(names(0, 0.1)).toEqual(['seal_rstrafe:1.000']);                  // 6.5: only the slow strafe
    expect(names(Math.SQRT1_2, Math.SQRT1_2)).toEqual(['seal_run:0.500', 'seal_run_90r:0.500']);
    expect(names(0, 0)).toEqual([]);
  });

  it('crouched: the class\'s one set at weight 1, the right strafe half a cycle on (FUN_00582d10)', () => {
    const s = sets();
    expect(crouchPlay(0.946, 0, 1, s).map((n) => [n.motion.name, n.weight, n.offset])).toEqual([['seal_crouchwalk', 1, 0]]);
    expect(crouchPlay(-0.946, 0, 3, s).map((n) => n.motion.name)).toEqual(['seal_crouchwalk_bw']);
    expect(crouchPlay(0, -0.946, 2, s).map((n) => [n.motion.name, n.offset])).toEqual([['seal_crouchstrafe_left', 0]]);
    expect(crouchPlay(0, 0.946, 0, s).map((n) => [n.motion.name, n.offset])).toEqual([['seal_crouchstrafe_right_fast', 0.5]]);
    const walk = crouchPlay(0.946, 0, 1, s)[0]!;
    expect(walk.speed * walk.motion.travel / walk.motion.period).toBeCloseTo(0.946 * 14.8, 6);
  });

  it('prone: the crawl forward, backwards backing up, a strafe across, at max(|f|, |l|) of the band (FUN_00583500)', () => {
    const crawl = loco('seal_prone_crawl', 26, 9.93, 1.1, 0, 0.4), right = loco('seal_prone_rstrafe', 22, 8.3, 0.55, 0, 1, 'x');
    const left = loco('seal_prone_lstrafe', 22, 7, 0.55, 0, 1, 'x');
    const on = { crawl, right, left };
    const f = pronePlay(0.8, 0.2, 1, on)[0]!;
    expect(f.motion.name).toBe('seal_prone_crawl');
    expect(f.speed * crawl.travel / crawl.period).toBeCloseTo(0.8 * 11, 6);
    expect(pronePlay(-0.8, 0, 3, on)[0]!.speed).toBeCloseTo(-f.speed, 12);
    expect(pronePlay(0, 0.5, 0, on)[0]!.motion.name).toBe('seal_prone_rstrafe');
    expect(pronePlay(0, -0.5, 2, on)[0]!.motion.name).toBe('seal_prone_lstrafe');
  });

  it('the Jump action\'s stick speeds are each set\'s top band end: 65 / 37 / 65 / 65 standing, 20 crouched', () => {
    expect(airBands('stand', null)).toEqual({ forward: 65, back: 37, right: 65, left: 65 });
    expect(airBands('crouch', null)).toEqual({ forward: 20, back: 20, right: 20, left: 20 });
  });
});

// ---- the transcriptions against the disc ------------------------------------------------------------------------------

const RUN = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures/RUN');
const READERC = resolve(RUN, 'READERC.ZAR'), PACK = resolve(RUN, 'MOTION_P.ZAR');
const noDisc = !existsSync(READERC) || !existsSync(PACK);

describe.skipIf(noDisc)(`the anim set and the clips on the disc${noDisc ? ' (READERC.ZAR or MOTION_P.ZAR absent)' : ''}`, () => {
  const readerc = (): Zar => Zar.parse(new Uint8Array(readFileSync(READERC)));
  /** `animset.rdr`'s set by name: each `type_name` to its `anim_name`, or its `modes`' `default` (all its choices). */
  const animSet = (name: string): Map<string, string[]> => {
    const zar = readerc();
    const root = parseRdr(zar.data(zar.find('animset.rdr')!));
    const sets = root as RdrNode[];
    const flat = (n: RdrNode): RdrNode[] => (Array.isArray(n) && n.length === 1 && Array.isArray(n[0]) ? flat(n[0]) : n as RdrNode[]);
    const list = flat(sets);
    const out = new Map<string, string[]>();
    const add = (set: RdrNode): void => {
      for (const anim of rdrGet(set, 'anim_set_anims') as RdrNode[]) {
        const type = rdrGet(anim, 'type_name');
        if (typeof type !== 'string' || out.has(type)) continue;
        const one = rdrGet(anim, 'anim_name');
        if (typeof one === 'string') { out.set(type, [one]); continue; }
        const modes = rdrGet(anim, 'modes');
        const list = Array.isArray(modes) ? modes as RdrNode[] : [];
        const def = (list[0] === 'default' ? list : list.find((m) => Array.isArray(m) && m[0] === 'default')) as RdrNode[] | undefined;
        if (def) out.set(type, def.slice(1).map((c) => (Array.isArray(c) ? c[0] as string : c)));
      }
    };
    const byName = (n: string): RdrNode | undefined => list.find((s) => rdrGet(s, 'anim_set_name') === n);
    const own = byName(name)!;
    add(own);
    const include = rdrGet(own, 'include');
    for (const inc of (Array.isArray(include) ? include : [include]) as string[]) add(byName(inc)!);
    return out;
  };

  it('SEAL_ANIMS, SEAL_SETS and CROUCH_IDLES are the Seal anim set\'s default mode, the jump from its GLOBAL include', () => {
    const seal = animSet('Seal anim set');
    const one = (type: string): string => {
      const c = seal.get(type);
      expect(c, type).toBeTruthy();
      return c![0]!;
    };
    expect({
      stand: one('Stand'), walk: one('Walk'), jog: one('Jog'), run: one('Run'), walkBack: one('Walk backwards'), jogBack: one('Jog backwards'),
      strafeRight: one('Strafe right'), strafeRightFast: one('Strafe right fast'), runRight: one('Run right'),
      strafeLeft: one('Strafe left'), strafeLeftFast: one('Strafe left fast'), runLeft: one('Run left'),
      crouch: one('Crouch'), crouchWalk: one('Crouch walk'), crouchWalkBack: one('Crouch walk backwards'),
      crouchStrafeLeft: one('Crouch strafe left'), crouchStrafeRight: one('Crouch strafe right fast'),
      prone: one('Prone'), proneCrawl: one('Prone crawl'), proneRight: one('Prone rstrafe'), proneLeft: one('Prone lstrafe'),
      proneTurn: one('Prone turn'),
      standToCrouch: one('Stand -> Crouch'), crouchToProne: one('Crouch -> Prone'), standToProne: one('Stand -> Prone'),
      jump: one('Jump'), launch: one('Jump launch'), inAir: one('Jump fall'), land: one('Jump land'), landHard: one('Jump land hard'),
      hit: one('Hit01'), hitStomach: one('Hit stomach01'), landDeath: one('Land forward'), getUp: one('Get up forward'),
      step: one('Step'), crouchStep: one('Crouch step'),
    }).toEqual({ ...SEAL_ANIMS });
    expect(seal.get('Crouch')).toEqual(CROUCH_IDLES.map((c) => c.clip));
    // the sets' order is motion.rdr's: the transitions as the builder files them, ascending in every set
    const table = motionTableFromArchive(new Uint8Array(readFileSync(READERC)))!;
    const order = [...table.keys()];
    for (const [k, names] of Object.entries(SEAL_SETS)) {
      const at = names.map((n) => order.indexOf(n));
      expect(at.every((i) => i >= 0), k).toBe(true);
      expect([...at].sort((a, b) => a - b), k).toEqual(at);
    }
  });

  it("PISTOL_ANIMS: each action's `Pistol <action>` in the Seal anim set (FUN_005e1a50's table), where there is one", () => {
    const seal = animSet('Seal anim set');
    const rifleOf = new Map<string, string>();                     // the rifle clip -> its action's name
    for (const [type, clips] of seal) if (!type.startsWith('Pistol ') && !type.startsWith('Fire ')) rifleOf.set(clips[0]!, type);
    const want: Record<string, string> = {};
    for (const clip of MOTION_CLIPS) {
      const type = rifleOf.get(clip);
      if (!type) continue;
      const pistol = seal.get(`Pistol ${type[0]!.toLowerCase()}${type.slice(1)}`);
      if (pistol) want[clip] = pistol[0]!;
    }
    expect({ ...PISTOL_ANIMS }).toEqual(want);
  });

  it('the crouch idles\' chances are the file\'s (0.3, 0.3, 0.4)', () => {
    const zar = readerc();
    const text = JSON.stringify(parseRdr(zar.data(zar.find('animset.rdr')!)));
    expect(text).toContain(JSON.stringify(['default', ['seal_crouch', '0.3'], ['seal_crouch_alert01', '0.3'], ['seal_crouch_alert02', '0.4']]));
  });

  it("ACTION_CLIPS are motion.rdr's playback and NoInterrupt, and MOTION_P.ZAR's key counts and root travel", () => {
    const table = motionTableFromArchive(new Uint8Array(readFileSync(READERC)))!;
    const names: Record<keyof typeof ACTION_CLIPS, string> = {
      jump: SEAL_ANIMS.jump, land: SEAL_ANIMS.land, landHard: SEAL_ANIMS.landHard,
      standToCrouch: SEAL_ANIMS.standToCrouch, crouchToProne: SEAL_ANIMS.crouchToProne, standToProne: SEAL_ANIMS.standToProne,
      hit: SEAL_ANIMS.hit, hitStomach: SEAL_ANIMS.hitStomach, landDeath: SEAL_ANIMS.landDeath, getUp: SEAL_ANIMS.getUp,
    };
    const clips = new Map(clipsFromPack(new Uint8Array(readFileSync(PACK)), Object.values(names)).map((c) => [c.name, c]));
    const transitions = new Set(['standToCrouch', 'crouchToProne', 'standToProne']);
    for (const [k, n] of Object.entries(names)) {
      const c = ACTION_CLIPS[k as keyof typeof ACTION_CLIPS];
      const e = table.get(n)!, clip = clips.get(n)!;
      expect(e.playback, n).toBeCloseTo(c.playback, 6);
      expect(e.looped, n).toBe(false);
      expect(clip.frameCount, n).toBe(c.frames);
      // the transitions are never the player's to cut (FUN_00587c20), whatever their entries say
      if (!transitions.has(k)) expect(e.noInterrupt ?? 0, n).toBeCloseTo(c.noInterrupt, 6);
      const root = clip.parts.find((p) => p.name === 'skel_root')!.translations;
      const last = 3 * (clip.frameCount - 1);
      if (root.length > 3) {
        expect(root[last]! - root[0]!, n).toBeCloseTo(c.travel[0], 1);
        expect(root[last + 2]! - root[2]!, n).toBeCloseTo(c.travel[1], 1);
      }
    }
  });

  it("the within-stride shape: every locomotion clip's root moves the same each key -- the game's per-key velocity is the mover's", () => {
    // FUN_0028c250 moves the SEAL by the root's change between the two keys the phase is on (FUN_00289bb0); on every
    // set's clip and the crawl that change is the same to 1.5 % across the cycle, so the per-key velocity is the
    // constant target speed the mover runs at (walk.ts `locomotion`).
    const names = [...Object.values(SEAL_SETS).flat(), SEAL_ANIMS.proneCrawl];
    const clips = clipsFromPack(new Uint8Array(readFileSync(PACK)), names);
    expect(clips.length).toBe(names.length);
    for (const c of clips) {
      const t = c.parts.find((p) => p.name === 'skel_root')!.translations;
      const d: number[] = [];
      for (let i = 0; i + 1 < c.frameCount; i++) d.push(Math.hypot(t[3 * i + 3]! - t[3 * i]!, t[3 * i + 5]! - t[3 * i + 2]!));
      const mean = d.reduce((a, b) => a + b, 0) / d.length;
      for (const x of d) expect(Math.abs(x - mean) / mean, c.name).toBeLessThan(0.015);
    }
  });

  it('on the disc: full ahead seal_run at 1.126 (research 25 traced 1.1265); full aside seal_run_90r, its root at 65', () => {
    const table = motionTableFromArchive(new Uint8Array(readFileSync(READERC)))!;
    const clips = clipsFromPack(new Uint8Array(readFileSync(PACK)), MOTION_CLIPS);
    const motions = new Map(clips.map((c) => [c.name, motionOf(c, entryOf(c.name, table))]));
    const s = Object.fromEntries((Object.keys(SEAL_SETS) as SetName[]).map((k) => [k, SEAL_SETS[k].map((n) => motions.get(n)!)])) as MotionSets;
    const [run] = standPlay(1, 0, s);
    expect(run!.motion.name).toBe('seal_run');
    expect(run!.speed).toBeCloseTo(1.1265, 2);
    const [side] = standPlay(0, 1, s);
    expect(side!.motion.name).toBe('seal_run_90r');
    expect(side!.speed * side!.motion.travel / side!.motion.period).toBeCloseTo(65, 6);
    // the owner's finding: the slow strafe (a 14.6 a second root) plays only under 28 a second
    const slow = standPlay(0, 0.3, s);
    expect(slow.map((n) => n.motion.name)).toEqual(['seal_rstrafe', 'seal_rstrafe_fast']);
    for (const n of slow) expect(n.speed * n.motion.travel / n.motion.period).toBeCloseTo(19.5, 6);
  });
});
