/**
 * The console's side of the feel-parity table (web research 88): every number the viewer's walk is compared with,
 * transcribed from a log, a note or the console's own RAM, with where it was read. No disc data: the numbers are the
 * logs' and the notes', and the few that a disc file decides (a clip's root) are read at run time from the fixtures by
 * the harness, not written here (W2.R6).
 *
 * **What kind of truth each is** -- the table prints it, because they are not equally strong:
 *
 * - `console`: read off the console -- PCSX2's RAM at the slot-8 spawn (`logs/parity/spawn_pcsx2.rdram`) or a PINE
 *   poll of it (`logs/parity/probe_pcsx2.txt`, `cam_pcsx2_mission.txt`).
 * - `recomp`: a guest *state* word read on ours (the recompiled game): an axis, a velocity word, a node weight. The
 *   code that writes it is the console's, and the word does not depend on ours' frame rate; a *rate over host time*
 *   from ours is not used as a number (ours ran the game at ~41 frames a second in research 18's era, 18.7 now), only
 *   as a ratio that the time cancels out of.
 * - `decomp`: the decompilation's law, read and reviewed but never timed on the console. Research 79's run (not yet
 *   done, 2026-09-28) is what turns these into `console` rows; `feel-parity.ts --seal-speed` ingests it.
 * - `asset`: the disc's own clip decides it and the decompilation says the clip is what the game plays; the number is
 *   computed from the fixture at run time (`harness.ts`), the value here is only the transcription for the note.
 *
 * Paths are the main checkout's (`C:/Projects/socom_pc/`) for `logs/`, and this repository's for `docs/`.
 */

export type TruthKind = 'console' | 'recomp' | 'decomp' | 'asset';

export interface ConsoleValue {
  value: number;
  kind: TruthKind;
  /** Where the number was read: file and line, or dump address. */
  source: string;
}

const c = (value: number, kind: TruthKind, source: string): ConsoleValue => ({ value, kind, source });

/** The player at the slot-8 spawn, crouched (research 17 section 1, W2.3's reading of it). */
export const SPAWN = {
  /** The feet: actor matrix row 3. */
  feet: [939.4391, -145.8672, 857.0661] as const,
  /** The placed eye `cam+0xd8`, polled 15,853 times unmoving: probe_pcsx2.txt line 2's `player=`. */
  eye: [939.4390258789062, -126.2644271850586, 832.1597290039062] as const,
  /** The look-at target `cam+0x38`. */
  target: [939.439, -130.489, 858.341] as const,
  /** The eye before the pass, `cam+0x2c`. */
  eyeBeforePass: [939.439, -126.384, 832.9] as const,
};

export const CONSOLE = {
  // ---- the camera at the spawn (crouched, the rest pitch init_aim_pitch) ----------------------------------------
  spawnEyeUp: c(SPAWN.eye[1] - SPAWN.feet[1], 'console',
    'logs/parity/probe_pcsx2.txt line 2 (eye) - docs/research/17-ground-height.md line 77 (feet): cam+0xd8 over the feet'),
  spawnEyeBehind: c(SPAWN.feet[2] - SPAWN.eye[2], 'console',
    'logs/parity/probe_pcsx2.txt line 2 (eye z) against research 17 line 77 (feet z): the facing is +z'),
  spawnTargetUp: c(15.3782, 'console', 'docs/research/17-ground-height.md line 81 (spawn_pcsx2.rdram, cam+0x38)'),
  spawnTargetAhead: c(SPAWN.target[2] - SPAWN.feet[2], 'console', 'research 17 line 78 (cam+0x38 z) - line 77 (feet z)'),
  spawnEyeBeforePassUp: c(SPAWN.eyeBeforePass[1] - SPAWN.feet[1], 'console', 'research 17 line 79 (cam+0x2c y)'),
  spawnEyeBeforePassBehind: c(SPAWN.feet[2] - SPAWN.eyeBeforePass[2], 'console', 'research 17 line 79 (cam+0x2c z)'),
  spawnPassDistance: c(26.51936, 'console',
    'playerCamera.ts header: DAT_003de268 on spawn_pcsx2.rdram (research 17 section 1; web spec section 7 W2.1)'),
  crouchRootY: c(5.50391, 'console', 'research 17 line 82: the player skeleton root Y on spawn_pcsx2.rdram (crouched)'),
  standRootY: c(11.484, 'console', 'web spec section 7 W2.3: skel_root of the 24 bind-pose actors on spawn_pcsx2.rdram'),
  // ---- the projection ----------------------------------------------------------------------------------------------
  vfovDeg: c(2 * Math.asin(0.414693) * 180 / Math.PI, 'console',
    'logs/parity/cam_pcsx2_mission.txt line 8 (t=33.1): words 0.414693 / 0.909961 = sin/cos of the half vfov'),
  hfovDeg: c(2 * Math.asin(0.573576) * 180 / Math.PI, 'console',
    'logs/parity/cam_pcsx2_mission.txt line 8 (t=33.1): words 0.573576 / 0.819152 = sin/cos of the half hfov'),
  // ---- the orbit, and the camera on ours' decayed root -------------------------------------------------------------
  orbitRadius: c(24.91, 'recomp',
    'docs/research/18-online-round-start.md line 932: the three zero-residual circle fits of a turn in place'),
  elevationRootZero: c(29.73, 'recomp',
    'docs/research/22-kill-readout.md line 186: the camera over the actor at rest on ours, whose root had decayed to 0 (research 17 section 4.1)'),
  // ---- the move --------------------------------------------------------------------------------------------------
  runForward: c(65, 'recomp', 'docs/research/25-sp-teleport.md line 25: the velocity words (0, 0, -65) at a forward walk'),
  runBack: c(37, 'recomp', 'docs/research/25-sp-teleport.md line 26: (0, 0, +37) at a back walk'),
  strafe: c(65, 'decomp', 'motion.rdr seal_rstrafe/lstrafe max_velocity 6.5 m/s through FUN_00583030 (web spec section 7 W2.2b)'),
  backOverStrafe: c(25.30 / 44.30, 'recomp',
    'docs/research/18-online-round-start.md lines 985-986: back 25.30 / strafe A 44.30 units per host second on ours (the time cancels)'),
  diagonal: c(65, 'decomp', 'FUN_00583350: 1/sqrt(w^2 + (1-w)^2) renormalises a 45-degree stick to the band (web spec section 7 W2.2b)'),
  t90: c(11 / 60, 'decomp', 'FUN_00586c10: upper_z_accel 5 a second, 90 % of the run on tick 11 (web spec section 7 W2.2b)'),
  stopTicks: c(0, 'decomp', 'FUN_00586f00 idles a stick within 0.03 and FUN_00586570 skips the ramp: the stop is at once'),
  crouchWalk: c(14.0, 'decomp', 'FUN_00584c60: a push under 0.838 rescaled to 0.946 x 14.8 (web spec section 7 W2.2b)'),
  crouchFullPush: c(65, 'decomp', 'FUN_00584c60 -> FUN_00583030 at a push of 0.838 or more with headroom: the SEAL stands and runs'),
  proneForward: c(11, 'decomp', 'FUN_00583500: motion.rdr seal_prone_crawl 1.1 m/s x the class axis, no ramp'),
  /** Keyboard W+D: both axes a full byte (PCSX2's binds, the host port's keys), the class keeps one axis at 1. */
  proneDiagonalKeys: c(11, 'decomp', 'FUN_00583500 on the pad reader\'s (1, 1) (FUN_002da930: per-axis clamp, no disc): one axis x 11'),
  fallTime42: c(Math.sqrt(2 * 42 / 235), 'decomp', 'FUN_0059b440: v += g dt, g = dynamics.rdr gravity 235 (web spec section 7 W2.2b)'),
  fallCarry: c(65, 'decomp', 'no air control outside the Jump state (DAT_003deae8): the horizontal velocity at the edge is kept'),
  // ---- the move stick: the pad reader on the left stick (the dump's block, the decompilation's law) ------------------
  /** `(127.5 - byte) x 0.007843138`, per axis dead zone 0.3 and rescale, the circle x sqrt 2, clamp; no curve, no ramp. */
  leftStickDeadZone: c(0.3, 'console',
    'spawn_pcsx2.rdram 0x84a118 (pad 0x849e90 +0x288) = 0x3e99999a, rescale flag +0x2a0 = 1 (decomp 179566-179600)'),
  leftStickCircle: c(1, 'console', 'spawn_pcsx2.rdram 0x84a131 (pad +0x2a1) = 1 and DAT_003df240 = 1: FUN_002da200 mode 1 (decomp 179634)'),
  leftStickCurve: c(0, 'console',
    'spawn_pcsx2.rdram 0x84a138/9 (pad +0x2a8/+0x2a9) = 0: no curve, and so no ramp (decomp 179771 needs +0x2a8)'),
  // ---- the look (research 22 section 3.1, on ours in single player; the axis and the rate are state words) ---------
  turnAxis: {
    255: c(1.118, 'recomp', 'docs/research/22-kill-readout.md line 129: rx - 0x80 = +127, actor+0x23c'),
    224: c(0.879, 'recomp', 'docs/research/22-kill-readout.md line 128: +96'),
    192: c(0.080, 'recomp', 'docs/research/22-kill-readout.md line 127: +64 (run 3)'),
    64: c(0.072, 'recomp', 'docs/research/22-kill-readout.md line 133: -64'),
    80: c(0.004, 'recomp', 'docs/research/22-kill-readout.md line 132: -48 (run 3)'),
    176: c(0, 'recomp', 'docs/research/22-kill-readout.md line 126: +48'),
  } as Record<number, ConsoleValue>,
  turnRateFull: c(128.11, 'recomp', 'docs/research/22-kill-readout.md line 129: peak actor+0x48 at +127, deg/s'),
  turnRate224: c(100.74, 'recomp', 'docs/research/22-kill-readout.md line 128: peak actor+0x48 at +96, deg/s'),
  turnRampSeconds: c(0.65 / ((1 / 60 + (1 - 1 / 60) * 0.13 * 0.25) / 1.25) / 60, 'decomp',
    'FUN_002da930 179722-179765: 0.65 / 0.0389 a frame at 60 Hz (web research 83 section 1)'),
  pitchRateFull: c(0.85 * 0.65 * 1.72 * 180 / Math.PI, 'decomp', 'pitch_rate 0.85 x 1.118 (FUN_00594600; web research 83 section 1)'),
  /** A full push on both right-stick axes (bytes 255 and 0): FUN_002da200 r = 1, x sqrt 2 clamped: each axis full. */
  turnAxisCorner: c(1.118, 'decomp', 'FUN_002da200 mode 1 on (1, 1): both axes clamped to 1, the curve 0.65 x 1.72'),
  // ---- the body's clips (read from the fixtures at run time; values here for the note) -----------------------------
  runClipFactor: c(1.1265, 'recomp', 'docs/research/25-sp-teleport.md line 372: node +0x24 1.1265 on seal_run at a forward walk'),
  jumpRise: c(4.57, 'asset', 'MOTION_P.ZAR seal_jump skel_root y 10.51 -> 15.08 (key 12 of 20); the rise is the clip\'s (web spec section 7 W2.2b)'),
  jumpApexSeconds: c(12 * 1.1 / 20, 'asset', 'seal_jump: 20 keys over motion.rdr playback 1.1 s, the root\'s top at key 12'),
  runRootY: c(10.305, 'asset', 'MOTION_P.ZAR seal_run skel_root y; FUN_0029a950 reads the live root (research 17 section 3)'),
  proneRootY: c(2.168, 'asset', 'MOTION_P.ZAR seal_prone skel_root y (the camera ramp\'s floor is 2.169155)'),
} as const;

/** Research 79's light-stick levels (section 5): the macro lands ly on 128 - round(128 x push). */
export const LIGHT_PUSHES = [0.5, 0.75] as const;

/** The byte a light push puts on the axis, and the value the pad reader reads from it (`(127.5 - b) x 0.007843138`). */
export function lightByte(push: number): { byte: number; value: number } {
  const byte = 128 - Math.round(128 * push);
  return { byte, value: (127.5 - byte) * 0.007843138 };
}

/**
 * The console's move stick (`FUN_002da930` on the left block, the dump's settings): per axis `|v| < 0.3` is 0, else
 * `(|v| - 0.3) / 0.7` with its sign, clamped; then `FUN_002da200` mode 1 -- both axes x sqrt(1 + |r|), `r` the minor
 * over the major only when their integer parts differ, clamped. No curve, no ramp. The harness's own copy, so a change
 * to the viewer's cannot move the table's expectation with it.
 */
export function consoleMoveStick(x: number, y: number): [number, number] {
  const dz = (v: number): number => (Math.abs(v) < 0.3 ? 0 : Math.max(-1, Math.min(1, (v > 0 ? v - 0.3 : v + 0.3) / 0.7)));
  const ax = dz(x), ay = dz(y);
  const ix = Math.trunc(Math.abs(ax)), iy = Math.trunc(Math.abs(ay));
  let r = 1;
  if (iy < ix) r = ay / ax;
  else if (ix < iy) r = ax / ay;
  const f = Math.sqrt(Math.abs(r) + 1);
  return [Math.max(-1, Math.min(1, ax * f)), Math.max(-1, Math.min(1, ay * f))];
}
