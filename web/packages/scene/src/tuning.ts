import { Zar, parseRdr, rdrGet, type RdrNode } from '@s2u/archive';

/**
 * The SEAL's tuning: `READERC.ZAR/dynamics.rdr` (the table reCOM's `CharacterDynamics::Load` reads,
 * `zCharacter/char_dyn.cpp:6-427`) and the SEAL's moving clips out of `READERC.ZAR/motion.rdr`. Web
 * sprint 2 spec §1 and §7 list the values; W2.R5 rules that the table is transcribed here and pinned
 * by a fixture test against the game's own file.
 *
 * Units. The game's world unit is a decimetre: a map's `MetersPerUnit` is 0.1, and reCOM scales the
 * script's metre values by `CWorld::m_scale = 1 / MetersPerUnit` = 10 (`zNode/node_saveload.cpp:291`).
 * Where `char_dyn.cpp` multiplies by `m_scale` -- the fall distances (`:28-30`), the climb, stand and
 * jump heights (`:412-425`) -- this table holds the product, in units; the console's own copy of the
 * table at `0x44c250` holds the same products (13, 21.5, 26.5, 10, 20: `docs/research/17-ground-height.md
 * §8`). `motion.rdr`'s `max_velocity` and `transition_speed_A/B` are metres a second and are held here
 * in units a second (x10: `seal_run` 6.5 m/s is 65, research 25 §0's (0, 0, -65)). Everything else is
 * raw: `gravity 235`, `ground_touch_distance 8` and `step_height 6.5` are the console table's numbers
 * as they stand (research 17 §8, `+0x00`, `+0x14`, `+0x1c`), and the `cam_*` block is read unscaled
 * (`char_dyn.cpp:261-404`). Angles stay in the file's degrees; the game stores radians.
 */
export interface SealTuning {
  /** `gravity`: raw, units/s^2 as the game integrates it (research 17 §8 `+0x00`; `char_dyn.cpp:12`). */
  gravity: number;
  /** `jump_factor` (`char_dyn.cpp:14`). */
  jumpFactor: number;
  /** `ground_touch_distance`: units, raw (research 17 §8 `+0x14`; `char_dyn.cpp:17`). */
  groundTouchDistance: number;
  /** `max_slope` in degrees; the game keeps its cosine, 0.642788 (research 17 §8 `+0x18`; `char_dyn.cpp:18-19`). */
  maxSlopeDeg: number;
  /** `step_height`: units, raw (research 17 §8 `+0x1c`; `char_dyn.cpp:20`). */
  stepHeight: number;
  /** `fb_accel`, `lr_accel`: the forward/back and lateral stick stiffness (`char_dyn.cpp:39-40`). */
  fbAccel: number;
  lrAccel: number;
  /**
   * `throt_exp` (`char_dyn.cpp:41`). SOCOM II's `dynamics.rdr` does not carry the key; the console's
   * table holds `+0x11c = 1 / (exp(throt_exp) - 1) = 0.581809`, i.e. `throt_exp` 1, the loader's
   * default (research 17 §5, §8 `+0x118`). The reader takes the file's value when there is one.
   */
  throtExp: number;
  /** `lower_x_accel`/`upper_x_accel`, `lower_z_accel`/`upper_z_accel` (`char_dyn.cpp:52-55`). */
  accelX: [lo: number, hi: number];
  accelZ: [lo: number, hi: number];
  /** `turn_maxrate` (`char_dyn.cpp:51`; research 22's omega = 2.0 x axis). */
  turnMaxRate: number;
  /** `stand_turn_factor` (`char_dyn.cpp:46-49`). */
  standTurnFactor: number;
  /** `pitch_rate` (`char_dyn.cpp:164-167`). */
  pitchRate: number;
  /** `min_look_pitch`, `max_look_pitch`, degrees (`char_dyn.cpp:116-124`). */
  lookPitch: [min: number, max: number];
  /** `max_look_yaw`, degrees (`char_dyn.cpp:126`). */
  lookYaw: number;
  /** `min_aim_pitch`, `max_aim_pitch`, degrees (`char_dyn.cpp:64-68`). */
  aimPitch: [min: number, max: number];
  /** `max_aim_yaw`, degrees (`char_dyn.cpp:69`). */
  aimYaw: number;
  /** `low/med/high_climb_height`: units (metres x10, `char_dyn.cpp:412-419`). */
  climbHeights: [low: number, med: number, high: number];
  /** `min_stand_height`: units (metres x10, `char_dyn.cpp:421-422`). */
  minStandHeight: number;
  /** `min_jump_height`: units (metres x10, `char_dyn.cpp:424-425`). */
  minJumpHeight: number;
  /** `land_fall_rate`, `land_hard_fall_rate`: raw (`char_dyn.cpp:15-16`). */
  landFallRate: number;
  landHardFallRate: number;
  /** `FALLING_DAMAGE_LIGHT/HEAVY/DEATH`: fall distances in units (metres x10, `char_dyn.cpp:25-30`). */
  fallingDamage: [light: number, heavy: number, death: number];
  /** `BOBBING_FIRSTPERSON` (`char_dyn.cpp:203-225`). */
  bobbing: { walkAmplitude: number; walkRate: number; crawlAmplitude: number; crawlRate: number };
  /** `cam_<view>_height/dist/side/aim`: raw (`char_dyn.cpp:261-378`). */
  cam: Record<SealCamView, SealCam>;
  /** `cam_tether_stiff` (`char_dyn.cpp:381`). */
  tetherStiff: number;
  /** `cam_peek_decay_rate` (`char_dyn.cpp:401`). */
  peekDecayRate: number;
  /** `zoom_factor`, `zoom_rate` (`char_dyn.cpp:243-251`). */
  zoomFactor: number;
  zoomRate: number;
}

export type SealCamView = 'full' | 'back' | 'side' | 'first' | 'peekl' | 'peekr';
export interface SealCam { height: number; dist: number; side: number; aim: [x: number, y: number, z: number] }

/** One of the SEAL's moving clips in `READERC.ZAR/motion.rdr`. */
export interface LocomotionBand {
  clip: string;
  /** `max_velocity`: units/s (metres/s x10). */
  maxVelocity: number;
  /** `transition_speed_A`, `transition_speed_B`: the speed band the clip plays over, units/s (metres/s x10). */
  from: number;
  to: number;
  /** The record carries the `Lateral` flag (the file's, as it stands: the pistol and prone strafes do not). */
  lateral: boolean;
  /** `playback`: the clip's rate, raw. */
  playback: number;
  /** `looped 1`. */
  looped: boolean;
}

/** `CWorld::m_scale` = 1 / `MetersPerUnit` 0.1 (reCOM `zNode/node_saveload.cpp:291`). */
const M_SCALE = 10;
const CAM_VIEWS: readonly SealCamView[] = ['full', 'back', 'side', 'first', 'peekl', 'peekr'];

/** `f32Text` keeps the source's spelling (`rdr.ts`); x10 of `2.15` is 21.499999..., so round to 1e-6. */
const tidy = (x: number): number => Math.round(x * 1e6) / 1e6 || 0;

/** A key's one number, times `scale`. Throws naming the key when it is absent or not a single number. */
export function rdrReal(script: RdrNode, key: string, scale = 1, where = 'script'): number {
  const v = rdrGet(script, key);
  const n = typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new Error(`${where} has no ${key}`);
  return tidy(n * scale);
}

function triple(script: RdrNode, key: string, where: string): [number, number, number] {
  const v = rdrGet(script, key);
  if (!Array.isArray(v) || v.length !== 3 || v.some((c) => typeof c !== 'string')) throw new Error(`${where} has no ${key}`);
  return [tidy(Number(v[0])), tidy(Number(v[1])), tidy(Number(v[2]))];
}

/** `dynamics.rdr`, decoded, as a `SealTuning`. */
export function sealDynamics(script: RdrNode): SealTuning {
  const where = 'dynamics.rdr';
  const n = (key: string, scale = 1): number => rdrReal(script, key, scale, where);
  const bob = rdrGet(script, 'BOBBING_FIRSTPERSON');
  if (!Array.isArray(bob)) throw new Error(`${where} has no BOBBING_FIRSTPERSON`);
  const b = (key: string): number => rdrReal(bob, key, 1, `${where} BOBBING_FIRSTPERSON`);
  const cam = Object.fromEntries(CAM_VIEWS.map((view) => [view, {
    height: n(`cam_${view}_height`), dist: n(`cam_${view}_dist`), side: n(`cam_${view}_side`),
    aim: triple(script, `cam_${view}_aim`, where),
  }])) as Record<SealCamView, SealCam>;
  return {
    gravity: n('gravity'),
    jumpFactor: n('jump_factor'),
    groundTouchDistance: n('ground_touch_distance'),
    maxSlopeDeg: n('max_slope'),
    stepHeight: n('step_height'),
    fbAccel: n('fb_accel'),
    lrAccel: n('lr_accel'),
    throtExp: rdrGet(script, 'throt_exp') === undefined ? 1 : n('throt_exp'),
    accelX: [n('lower_x_accel'), n('upper_x_accel')],
    accelZ: [n('lower_z_accel'), n('upper_z_accel')],
    turnMaxRate: n('turn_maxrate'),
    standTurnFactor: n('stand_turn_factor'),
    pitchRate: n('pitch_rate'),
    lookPitch: [n('min_look_pitch'), n('max_look_pitch')],
    lookYaw: n('max_look_yaw'),
    aimPitch: [n('min_aim_pitch'), n('max_aim_pitch')],
    aimYaw: n('max_aim_yaw'),
    climbHeights: [n('low_climb_height', M_SCALE), n('med_climb_height', M_SCALE), n('high_climb_height', M_SCALE)],
    minStandHeight: n('min_stand_height', M_SCALE),
    minJumpHeight: n('min_jump_height', M_SCALE),
    landFallRate: n('land_fall_rate'),
    landHardFallRate: n('land_hard_fall_rate'),
    fallingDamage: [n('FALLING_DAMAGE_LIGHT', M_SCALE), n('FALLING_DAMAGE_HEAVY', M_SCALE), n('FALLING_DAMAGE_DEATH', M_SCALE)],
    bobbing: {
      walkAmplitude: b('Walk_Amplitude'), walkRate: b('Walk_Rate'),
      crawlAmplitude: b('Crawl_Amplitude'), crawlRate: b('Crawl_Rate'),
    },
    cam,
    tetherStiff: n('cam_tether_stiff'),
    peekDecayRate: n('cam_peek_decay_rate'),
    zoomFactor: n('zoom_factor'),
    zoomRate: n('zoom_rate'),
  };
}

/**
 * `motion.rdr`'s `animations` list, kept to the `seal_*` records whose `max_velocity` is positive --
 * the moving bands, in the file's order. The idles and one-shots (`seal_stand` -0.1, `seal_jump` -1,
 * `seal_step` -2, ...) carry a non-positive value and are left out. A record is scanned by key, so the
 * two stray tokens the game's file carries (`wa` in `seal_p_jog`, `f` in `seal_toss_rlean`) do no harm.
 */
export function sealLocomotion(script: RdrNode): LocomotionBand[] {
  const animations = rdrGet(script, 'animations');
  if (!Array.isArray(animations)) throw new Error('motion.rdr has no animations');
  const out: LocomotionBand[] = [];
  for (const record of animations) {
    if (!Array.isArray(record)) continue;
    const clip = rdrGet(record, 'anim_name');
    if (typeof clip !== 'string' || !clip.startsWith('seal_')) continue;
    const velocity = rdrGet(record, 'max_velocity');
    if (typeof velocity !== 'string' || !(Number(velocity) > 0)) continue;
    const where = `motion.rdr ${clip}`;
    const opt = (key: string, scale: number): number =>
      rdrGet(record, key) === undefined ? 0 : rdrReal(record, key, scale, where);
    out.push({
      clip,
      maxVelocity: rdrReal(record, 'max_velocity', M_SCALE, where),
      from: opt('transition_speed_A', M_SCALE),
      to: opt('transition_speed_B', M_SCALE),
      lateral: rdrGet(record, 'Lateral') !== undefined,
      playback: opt('playback', 1),
      looped: rdrGet(record, 'looped') === '1',
    });
  }
  return out;
}

/** `READERC.ZAR` -> its `dynamics.rdr` and `motion.rdr` (root children, named with the suffix: 36 §6). */
export function readSealTuning(readerc: Uint8Array): { dynamics: SealTuning; locomotion: LocomotionBand[] } {
  const zar = Zar.parse(readerc);
  const script = (name: string): RdrNode => {
    const key = zar.root.children.find((k) => k.name.toLowerCase() === name);
    if (!key) throw new Error(`READERC.ZAR has no ${name}`);
    return parseRdr(zar.data(key));
  };
  return { dynamics: sealDynamics(script('dynamics.rdr')), locomotion: sealLocomotion(script('motion.rdr')) };
}

/**
 * `READERC.ZAR/dynamics.rdr`, transcribed (web sprint 2 spec §1, §7; W2.R5): what the viewer uses when
 * the archive is not served. `test/tuning.test.ts` proves it deep-equals `readSealTuning` of the game's
 * file on every run that has the file.
 */
export const SEAL_TUNING: SealTuning = {
  gravity: 235, jumpFactor: 0.85, groundTouchDistance: 8, maxSlopeDeg: 50, stepHeight: 6.5,
  fbAccel: 0.01, lrAccel: 0.01, throtExp: 1, accelX: [2, 5], accelZ: [2, 5],
  turnMaxRate: 2, standTurnFactor: 2.3, pitchRate: 0.85,
  lookPitch: [-60, 80], lookYaw: 89, aimPitch: [-70, 60], aimYaw: 85,
  climbHeights: [13, 21.5, 26.5], minStandHeight: 10, minJumpHeight: 20,
  landFallRate: 40, landHardFallRate: 115, fallingDamage: [62, 91, 120],
  bobbing: { walkAmplitude: 6, walkRate: 15, crawlAmplitude: 4, crawlRate: 8 },
  cam: {
    full: { height: 20.5, dist: 30, side: 0, aim: [0, 20.5, -2] },
    back: { height: 20.5, dist: 13, side: 0, aim: [0, 20.5, -2] },
    side: { height: 19, dist: 8, side: 5, aim: [5, 19, -2] },
    first: { height: 20.5, dist: 13, side: 0, aim: [0, 20.5, -2] },
    peekl: { height: 0, dist: 0, side: -70, aim: [-30, 0, 0] },
    peekr: { height: 0, dist: 0, side: 70, aim: [30, 0, 0] },
  },
  tetherStiff: 0.95, peekDecayRate: 6, zoomFactor: 5500, zoomRate: 14000,
};

/**
 * `READERC.ZAR/motion.rdr`'s moving SEAL bands, transcribed in the file's order, units a second (web
 * sprint 2 spec §7; W2.R2: 65 forward at full stick, 37 back). Pinned as `SEAL_TUNING` is.
 */
export const SEAL_LOCOMOTION: LocomotionBand[] = [
  { clip: 'seal_walk_alert', maxVelocity: 65, from: 0, to: 40, lateral: false, playback: 1, looped: true },
  { clip: 'seal_walk_alert02', maxVelocity: 65, from: 0, to: 35, lateral: false, playback: 1, looped: true },
  { clip: 'seal_jog_alert', maxVelocity: 65, from: 20, to: 61.5, lateral: false, playback: 1, looped: true },
  { clip: 'seal_walk', maxVelocity: 65, from: 0, to: 26, lateral: false, playback: 1, looped: true },
  { clip: 'seal_jog', maxVelocity: 65, from: 19, to: 50, lateral: false, playback: 1, looped: true },
  { clip: 'seal_run', maxVelocity: 65, from: 40.1, to: 65, lateral: false, playback: 1, looped: true },
  { clip: 'seal_p_walk', maxVelocity: 65, from: 0, to: 28, lateral: false, playback: 1, looped: true },
  { clip: 'seal_p_jog', maxVelocity: 65, from: 20, to: 46, lateral: false, playback: 1, looped: true },
  { clip: 'seal_p_run', maxVelocity: 65, from: 38, to: 65, lateral: false, playback: 1, looped: true },
  { clip: 'seal_fp_walk', maxVelocity: 65, from: 0, to: 28, lateral: false, playback: 1, looped: true },
  { clip: 'seal_fp_jog', maxVelocity: 65, from: 20, to: 46, lateral: false, playback: 1, looped: true },
  { clip: 'seal_fp_run', maxVelocity: 65, from: 38, to: 65, lateral: false, playback: 1, looped: true },
  { clip: 'seal_pfp_walk', maxVelocity: 65, from: 0, to: 28, lateral: false, playback: 1, looped: true },
  { clip: 'seal_pfp_jog', maxVelocity: 65, from: 20, to: 46, lateral: false, playback: 1, looped: true },
  { clip: 'seal_pfp_run', maxVelocity: 65, from: 38, to: 65, lateral: false, playback: 1, looped: true },
  { clip: 'seal_walk_bw', maxVelocity: 37, from: 0, to: 28, lateral: false, playback: 1, looped: true },
  { clip: 'seal_run_bw', maxVelocity: 37, from: 20, to: 37, lateral: false, playback: 1, looped: true },
  { clip: 'seal_p_walk_bw', maxVelocity: 37, from: 0, to: 28, lateral: false, playback: 1, looped: true },
  { clip: 'seal_p_run_bw', maxVelocity: 37, from: 20, to: 37, lateral: false, playback: 1, looped: true },
  { clip: 'seal_fp_walk_bw', maxVelocity: 37, from: 0, to: 28, lateral: false, playback: 1, looped: true },
  { clip: 'seal_fp_run_bw', maxVelocity: 37, from: 20, to: 37, lateral: false, playback: 1, looped: true },
  { clip: 'seal_pfp_walk_bw', maxVelocity: 37, from: 0, to: 28, lateral: false, playback: 1, looped: true },
  { clip: 'seal_pfp_run_bw', maxVelocity: 37, from: 20, to: 37, lateral: false, playback: 1, looped: true },
  { clip: 'seal_runningjump_launch', maxVelocity: 65, from: 0, to: 65, lateral: false, playback: 2.4, looped: false },
  { clip: 'seal_p_runningjump_launch', maxVelocity: 65, from: 0, to: 65, lateral: false, playback: 2.4, looped: false },
  { clip: 'seal_rstrafe', maxVelocity: 65, from: 0, to: 28, lateral: true, playback: 1, looped: true },
  { clip: 'seal_lstrafe', maxVelocity: 65, from: 0, to: 23, lateral: true, playback: 1, looped: true },
  { clip: 'seal_rstrafe_fast', maxVelocity: 65, from: 10, to: 50, lateral: true, playback: 1, looped: true },
  { clip: 'seal_lstrafe_fast', maxVelocity: 65, from: 9, to: 45, lateral: true, playback: 1, looped: true },
  { clip: 'seal_run_90r', maxVelocity: 65, from: 30, to: 65, lateral: true, playback: 1, looped: true },
  { clip: 'seal_run_90l', maxVelocity: 65, from: 25, to: 65, lateral: true, playback: 1, looped: true },
  { clip: 'seal_crouchwalk', maxVelocity: 14.8, from: 0, to: 20, lateral: false, playback: 1, looped: true },
  { clip: 'seal_crouchwalk_bw', maxVelocity: 13.5, from: 0, to: 20, lateral: false, playback: 1, looped: true },
  { clip: 'seal_p_crouchwalk', maxVelocity: 14.8, from: 0, to: 20, lateral: false, playback: 1, looped: true },
  { clip: 'seal_p_crouchwalk_bw', maxVelocity: 13.5, from: 0, to: 20, lateral: false, playback: 1, looped: true },
  { clip: 'seal_crouchstrafe_right_fast', maxVelocity: 15, from: 0, to: 20, lateral: true, playback: 1, looped: true },
  { clip: 'seal_crouchstrafe_left', maxVelocity: 15, from: 0, to: 20, lateral: true, playback: 1, looped: true },
  { clip: 'seal_p_crouchstrafe_right', maxVelocity: 15, from: 0, to: 20, lateral: true, playback: 1, looped: true },
  { clip: 'seal_p_crouchstrafe_left', maxVelocity: 15, from: 0, to: 20, lateral: false, playback: 1, looped: true },
  { clip: 'seal_prone_crawl', maxVelocity: 11, from: 0, to: 4, lateral: false, playback: 1, looped: true },
  { clip: 'seal_prone_rstrafe', maxVelocity: 5.5, from: 0, to: 10, lateral: false, playback: 0.6, looped: true },
  { clip: 'seal_prone_lstrafe', maxVelocity: 5.5, from: 0, to: 10, lateral: false, playback: 0.6, looped: true },
  { clip: 'seal_climbladder', maxVelocity: 13.5, from: 0, to: 20, lateral: false, playback: 3, looped: true },
  { clip: 'seal_p_climbladder', maxVelocity: 13.5, from: 0, to: 20, lateral: false, playback: 3, looped: true },
  { clip: 'seal_p_rstrafe', maxVelocity: 55, from: 0, to: 28, lateral: false, playback: 1, looped: true },
  { clip: 'seal_p_lstrafe', maxVelocity: 50, from: 0, to: 23, lateral: false, playback: 1, looped: true },
  { clip: 'seal_p_rstrafe_fast', maxVelocity: 55, from: 10, to: 50, lateral: false, playback: 1, looped: true },
  { clip: 'seal_p_lstrafe_fast', maxVelocity: 50, from: 9, to: 45, lateral: false, playback: 1, looped: true },
  { clip: 'seal_p_run_90r', maxVelocity: 55, from: 30, to: 55, lateral: false, playback: 1, looped: true },
  { clip: 'seal_p_run_90l', maxVelocity: 50, from: 25, to: 50, lateral: false, playback: 1, looped: true },
  { clip: 'seal_fp_crouchwalk', maxVelocity: 13, from: 0, to: 5, lateral: false, playback: 1, looped: true },
  { clip: 'seal_fp_crouchwalk_bw', maxVelocity: 10, from: 0, to: 10, lateral: false, playback: 1, looped: true },
  { clip: 'seal_pfp_crouchwalk', maxVelocity: 13, from: 0, to: 5, lateral: false, playback: 1, looped: true },
  { clip: 'seal_pfp_crouchwalk_bw', maxVelocity: 10, from: 0, to: 10, lateral: false, playback: 1, looped: true },
  { clip: 'seal_buddycarry_walk', maxVelocity: 17, from: 0, to: 33, lateral: false, playback: 1, looped: true },
  { clip: 'seal_p_buddycarry_walk', maxVelocity: 17, from: 0, to: 33, lateral: false, playback: 1, looped: true },
  { clip: 'seal_buddycarried_walk', maxVelocity: 17, from: 0, to: 33, lateral: false, playback: 1, looped: true },
];
