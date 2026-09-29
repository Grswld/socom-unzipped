import type { MotionClip } from '@s2u/scene';
import { clipsFromPack } from '../../packages/viewer/src/motionTable';
import { localCamera, lookHeight, PlayerCamera, INIT_AIM_PITCH } from '../../packages/viewer/src/playerCamera';
import { rootY, TICK, type Stance } from '../../packages/viewer/src/walk';
import { CONSOLE, consoleMoveStick, lightByte, LIGHT_PUSHES, type ConsoleValue, type TruthKind } from './console';
import { fitHold, type Hold, type Row } from './fit';
import { axisOfByte, DECK, FeelRig, type HoldInput, type MotionFixtures, type Sample } from './rig';

export type { MotionFixtures } from './rig';

/**
 * The feel-parity table (web research 88): scripted inputs through the viewer's whole walk -- the keys and the pad
 * into the fly camera, the look law, the mover's ticks, the game's camera -- against the console's numbers
 * (`./console`), each row with its error and the workstream that owns the difference.
 */

/** Who acts on a row's divergence: the mover and the camera's geometry (this workstream), the look, the motion. */
export type Owner = 'mover' | 'camera' | 'look' | 'motion' | 'presentation';

export interface FeelRow {
  id: string;
  quantity: string;
  unit: string;
  console: number;
  viewer: number | null;
  /** |viewer - console| / |console| x 100; the absolute error when the console's value is 0. */
  error: number | null;
  errorKind: '%' | 'abs';
  tolerance: number;
  pass: boolean;
  kind: TruthKind;
  owner: Owner;
  source: string;
  note?: string;
}

export interface RowOptions { tolerancePct?: number; toleranceAbs?: number; note?: string }

export function row(id: string, quantity: string, unit: string, truth: ConsoleValue, viewer: number | null, owner: Owner,
  opts: RowOptions = {}): FeelRow {
  const abs = truth.value === 0 || opts.toleranceAbs !== undefined;
  const error = viewer === null || !Number.isFinite(viewer) ? null
    : abs ? Math.abs(viewer - truth.value) : (Math.abs(viewer - truth.value) / Math.abs(truth.value)) * 100;
  const tolerance = abs ? opts.toleranceAbs ?? 1e-6 : opts.tolerancePct ?? 2;
  return {
    id, quantity, unit, console: truth.value, viewer, error, errorKind: abs ? 'abs' : '%', tolerance,
    pass: error !== null && error <= tolerance, kind: truth.kind, owner, source: truth.source, note: opts.note,
  };
}

// ---- measuring a hold ------------------------------------------------------------------------------------------

const DEG = Math.PI / 180;

/** The mean speed over the last 40 % of a hold's samples (the steady part). */
function steady(samples: readonly Sample[]): number {
  const tail = samples.slice(Math.floor(samples.length * 0.6));
  return tail.reduce((a, s) => a + s.speed, 0) / tail.length;
}

/** The tick (1-based, at 60 frames a second one a frame) whose speed first reaches 90 % of `target`, in seconds. */
function t90(samples: readonly Sample[], target: number): number {
  const i = samples.findIndex((s) => s.speed >= 0.9 * target - 1e-9);
  return i < 0 ? NaN : (i + 1) * TICK;
}

/** The velocity over the steady part split along and across the facing `yaw` (degrees): forward, right. */
function relative(samples: readonly Sample[], yaw: number): { forward: number; right: number } {
  const tail = samples.slice(Math.floor(samples.length * 0.6));
  const a = tail[0]!, b = tail[tail.length - 1]!, dt = b.t - a.t;
  const vx = (b.feet[0] - a.feet[0]) / dt, vz = (b.feet[2] - a.feet[2]) / dt, y = yaw * DEG;
  return { forward: vx * -Math.sin(y) + vz * -Math.cos(y), right: vx * Math.cos(y) + vz * -Math.sin(y) };
}

/** A fresh rig, a hold of `seconds`, and the samples. */
function holdFrom(stance: Stance, input: HoldInput, seconds = 3, fps = 60): Sample[] {
  return new FeelRig(stance).hold(seconds, input, fps);
}

/** A pad's left stick pushed `value` of the way up (the browser's axis is negative up). */
const padForward = (value: number): number[] => [0, -value, 0, 0];

// ---- the decompilation's laws, computed apart from the viewer's code --------------------------------------------

/** Distance after `ticks` ticks of a full forward push from rest: the stick moves 5 a second (`FUN_00586c10`). */
function lawForwardDistance(ticks: number): number {
  let d = 0;
  for (let n = 1; n <= ticks; n++) d += Math.min(1, n * 5 * TICK) * 65 * TICK;
  return d;
}

/** Degrees turned in `frames` 60 Hz frames of a full push from rest (`FUN_002da930`'s ramp, the gain, turn_maxrate). */
function lawTurnDegrees(frames: number): number {
  const step = (1 / 60 + (1 - 1 / 60) * 0.13 * 0.25) / 1.25;
  let a = 0;
  for (let k = 1; k <= frames; k++) a += 2 * 1.72 * Math.min(0.65, k * step) * (1 / 60);
  return a / DEG;
}

// ---- the rows --------------------------------------------------------------------------------------------------

/** The mover: the run, its ramp and stop, the directions, the stances, the stick's pushes, the fall. */
export function moverRows(): FeelRow[] {
  const out: FeelRow[] = [];
  const rig = new FeelRig('stand');
  const run = rig.hold(3, { keys: ['KeyW'] });
  const after = rig.run(0.5);
  const v = steady(run);
  out.push(row('move.fwd', 'forward run, W held (steady)', 'u/s', CONSOLE.runForward, v, 'mover'));
  out.push(row('move.t90', 'forward from rest: time to 90 % of the run', 's', CONSOLE.t90, t90(run, v), 'mover',
    { toleranceAbs: TICK / 2 }));
  out.push(row('move.stop', 'W let go: ticks still moving', 'ticks', CONSOLE.stopTicks, after.filter((s) => s.speed > 0).length, 'mover',
    { toleranceAbs: 0 }));
  const back = steady(holdFrom('stand', { keys: ['KeyS'] }));
  const right = steady(holdFrom('stand', { keys: ['KeyD'] }));
  const left = steady(holdFrom('stand', { keys: ['KeyA'] }));
  out.push(row('move.back', 'back run, S held', 'u/s', CONSOLE.runBack, back, 'mover'));
  out.push(row('move.right', 'strafe right, D held', 'u/s', CONSOLE.strafe, right, 'mover'));
  out.push(row('move.left', 'strafe left, A held', 'u/s', CONSOLE.strafe, left, 'mover'));
  out.push(row('move.backOverStrafe', 'back / strafe (time-free, ours)', 'ratio', CONSOLE.backOverStrafe, back / left, 'mover'));
  const diag = holdFrom('stand', { keys: ['KeyW', 'KeyD'] });
  const rel = relative(diag, 0);
  out.push(row('move.diag', 'W+D: speed', 'u/s', CONSOLE.diagonal, steady(diag), 'mover'));
  out.push(row('move.diagHeading', 'W+D: heading off the facing', 'deg', { ...CONSOLE.diagonal, value: 45 },
    Math.atan2(rel.right, rel.forward) / DEG, 'mover', { toleranceAbs: 0.5 }));
  // Fps: the same second of W at 30 and 144 frames a second covers the 60 Hz law's distance.
  const law1s = { value: lawForwardDistance(60), kind: 'decomp' as const, source: 'FUN_00586c10 ramp over 60 ticks (this table\'s own loop)' };
  for (const fps of [30, 60, 144]) {
    const s = new FeelRig('stand').hold(1, { keys: ['KeyW'] }, fps);
    out.push(row(`move.dist1s@${fps}`, `1 s of W from rest at ${fps} fps: distance`, 'u', law1s, -s[s.length - 1]!.feet[2], 'mover',
      { tolerancePct: 0.5 }));
  }
  // Stances.
  out.push(row('move.crouchFull', 'crouched, W held (stands and runs)', 'u/s', CONSOLE.crouchFullPush, steady(holdFrom('crouch', { keys: ['KeyW'] })), 'mover'));
  const half = lightByte(0.5);
  out.push(row('move.crouchWalk', 'crouched, pad pushed half (byte 64)', 'u/s', CONSOLE.crouchWalk,
    steady(holdFrom('crouch', { pad: padForward(half.value) })), 'mover'));
  out.push(row('move.prone', 'prone, W held', 'u/s', CONSOLE.proneForward, steady(holdFrom('prone', { keys: ['KeyW'] })), 'mover'));
  out.push(row('move.proneDiag', 'prone, W+D held', 'u/s', CONSOLE.proneDiagonalKeys, steady(holdFrom('prone', { keys: ['KeyW', 'KeyD'] })), 'mover'));
  // The move stick: a pad pushed part way (research 79's two light levels), and the push that reaches the run.
  for (const push of LIGHT_PUSHES) {
    const { byte, value } = lightByte(push);
    const truth: ConsoleValue = {
      value: consoleMoveStick(0, value)[1] * 65, kind: 'console',
      source: `${CONSOLE.leftStickDeadZone.source}; ${CONSOLE.leftStickCircle.source}: byte ${byte} -> ${value.toFixed(3)}`,
    };
    out.push(row(`move.pad${push}`, `pad forward at byte ${byte} (push ${push})`, 'u/s', truth,
      steady(holdFrom('stand', { pad: padForward(value) }, 1.5)), 'mover',
      { note: `research 79's linear expectation is ${(push * 65).toFixed(2)}` }));
  }
  // Research 79's `--light 0.75` crouch walk: byte 32 reads 0.907 past the reader, over the crouch's 0.838 -- it stands and runs.
  const three = lightByte(0.75);
  out.push(row('move.crouchPad0.75', 'crouched, pad at byte 32 (push 0.75)', 'u/s',
    { value: consoleMoveStick(0, three.value)[1] * 65, kind: 'console', source: `${CONSOLE.crouchFullPush.source}; the move stick's law at byte 32` },
    steady(holdFrom('crouch', { pad: padForward(three.value) }, 1.5)), 'mover',
    { note: 'research 79 section 4 expects the 14.0 crouch walk here' }));
  out.push(row('move.padFull', 'pad push that first reaches the full run', 'of travel',
    { value: 0.3 + 0.7 / Math.SQRT2, kind: 'console', source: `${CONSOLE.leftStickDeadZone.source}; circle x sqrt 2` },
    fullRunPush(), 'mover', { toleranceAbs: 0.005 }));
  // The fall off Frostfire's 42.
  const deck = new FeelRig('stand', { x: (DECK.min + DECK.max) / 2, z: (DECK.min + DECK.max) / 2, y: DECK.y, yaw: -90 });
  const fall = deck.hold(4, { keys: ['KeyW'] }, 60, true);
  const landing = deck.walk.mover()!.landing;
  const air = fall.filter((s) => s.airborne);
  out.push(row('fall.time', 'walk off a 42 drop: time in the air', 's', CONSOLE.fallTime42, landing?.airTime ?? null, 'mover',
    { toleranceAbs: 2 * TICK }));
  out.push(row('fall.carry', 'walk off: speed across the ground in the air', 'u/s', CONSOLE.fallCarry,
    air.length ? air.reduce((a, s) => a + s.speed, 0) / air.length : null, 'mover'));
  deck.release();
  return out;
}

/** The smallest pad push (along one axis) whose steady speed is the full 65, by bisection on the viewer. */
function fullRunPush(): number {
  let lo = 0.5, hi = 1;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (steady(holdFrom('stand', { pad: padForward(mid) }, 0.6)) >= 65 * 0.999) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** The camera: at the spawn crouched, standing through a run and a turn, on ours' root of 0, the projection. */
export function cameraRows(fovDegrees: number): FeelRow[] {
  const out: FeelRow[] = [];
  const crouched = new FeelRig('crouch').sample();
  const [, fy, fz] = crouched.drawn, cam = crouched.camera;
  out.push(row('cam.spawnEyeUp', 'spawn, crouched, rest pitch: eye over the feet', 'u', CONSOLE.spawnEyeUp, cam.eye[1] - fy, 'camera', { toleranceAbs: 0.01 }));
  out.push(row('cam.spawnEyeBehind', 'spawn: eye behind the feet', 'u', CONSOLE.spawnEyeBehind, cam.eye[2] - fz, 'camera', { toleranceAbs: 0.01 }));
  out.push(row('cam.spawnTargetUp', 'spawn: look-at target over the feet', 'u', CONSOLE.spawnTargetUp, cam.target[1] - fy, 'camera', { toleranceAbs: 0.01 }));
  out.push(row('cam.spawnPass', 'spawn: the pass\'s distance DAT_003de268', 'u', CONSOLE.spawnPassDistance, cam.pass.distance, 'camera', { toleranceAbs: 0.01 }));
  const pre = localCamera(rootY('crouch'), INIT_AIM_PITCH);
  out.push(row('cam.spawnPrePassUp', 'spawn: eye before the pass (cam+0x2c), up', 'u', CONSOLE.spawnEyeBeforePassUp, pre.eye[1], 'camera', { toleranceAbs: 0.01 }));
  out.push(row('cam.spawnPrePassBehind', 'spawn: eye before the pass, behind', 'u', CONSOLE.spawnEyeBeforePassBehind, pre.eye[2], 'camera', { toleranceAbs: 0.01 }));
  out.push(row('cam.spawnTargetAhead', 'spawn: target ahead of the feet (the -8 n.y lead)', 'u', CONSOLE.spawnTargetAhead, fz - cam.target[2], 'camera', { toleranceAbs: 0.01 }));
  // Standing: a run and a turn in place keep the eye 24.906 behind across the ground (no tether).
  const rig = new FeelRig('stand');
  const run = rig.hold(2, { keys: ['KeyW'] });
  const behind = (s: Sample): number => Math.hypot(s.camera.eye[0] - s.drawn[0], s.camera.eye[2] - s.drawn[2]);
  const runBehind = run.slice(30).map(behind);
  out.push(row('cam.runBehind', 'standing run: eye behind the feet across the ground (max drift)', 'u',
    { value: 24.906, kind: 'decomp', source: 'FUN_00297410 holds no tether (web spec section 7 W2.1): the rest-pitch eye is 24.906 behind' },
    Math.max(...runBehind.map((b) => Math.abs(b - 24.906))) + 24.906, 'camera', { toleranceAbs: 0.05 }));
  const turn = new FeelRig('stand');
  const turning = turn.hold(2, { keys: ['ArrowLeft'] });
  const radii = turning.slice(20).map((s) => Math.hypot(s.camera.eye[0] - s.drawn[0], s.camera.eye[2] - s.drawn[2]));
  out.push(row('cam.orbit', 'turn in place: the eye\'s orbit radius', 'u', CONSOLE.orbitRadius, radii.reduce((a, b) => a + b, 0) / radii.length, 'camera',
    { toleranceAbs: 0.05 }));
  // Ours' decayed root (research 17 section 4.1): FUN_0029a950's "no root" ramp of 10, the camera's elevation at rest.
  const zero = new PlayerCamera(null);
  zero.tick([0, 0, 0], 0, INIT_AIM_PITCH, 0);
  const zv = zero.view(1);
  out.push(row('cam.rootZeroElevation', 'root 0 (ours): camera elevation over the feet', 'deg', CONSOLE.elevationRootZero,
    Math.atan2(zv.eye[1], Math.hypot(zv.eye[0], zv.eye[2])) / DEG, 'camera', { tolerancePct: 2 }));
  out.push(row('cam.vfov', 'vertical field of view', 'deg', CONSOLE.vfovDeg, fovDegrees, 'presentation', { toleranceAbs: 0.05 }));
  const ps2Aspect = Math.tan(0.6109) / Math.tan(0.4276);
  out.push(row('cam.hfovPs2', 'horizontal field of view, PS2 presentation', 'deg', CONSOLE.hfovDeg,
    2 * Math.atan(ps2Aspect * Math.tan((fovDegrees / 2) * DEG)) / DEG, 'presentation', { toleranceAbs: 0.05 }));
  out.push(row('cam.hfov169', 'horizontal field of view, native presentation at 16:9', 'deg', CONSOLE.hfovDeg,
    2 * Math.atan((16 / 9) * Math.tan((fovDegrees / 2) * DEG)) / DEG, 'presentation',
    { toleranceAbs: 0.05, note: 'the native view keeps the vertical angle and widens with the window' }));
  return out;
}

/** The look through the fly camera: the pad's bytes as research 22 read them, the arrows, the ramp, the pitch. */
export function lookRows(): FeelRow[] {
  const out: FeelRow[] = [];
  for (const [byte, truth] of Object.entries(CONSOLE.turnAxis)) {
    const s = new FeelRig('stand').hold(1, { pad: [0, 0, axisOfByte(Number(byte)), 0] });
    out.push(row(`look.axis${byte}`, `right stick x at byte ${byte}: turn axis after 1 s`, 'axis', truth,
      Math.abs(s[s.length - 1]!.axis[0]), 'look', { toleranceAbs: 0.0015 }));
  }
  const full = new FeelRig('stand').hold(1, { pad: [0, 0, axisOfByte(255), 0] });
  out.push(row('look.rateFull', 'right stick full: turn rate', 'deg/s', CONSOLE.turnRateFull, Math.abs(full[full.length - 1]!.turnRate) / DEG, 'look', { tolerancePct: 0.1 }));
  const r224 = new FeelRig('stand').hold(1, { pad: [0, 0, axisOfByte(224), 0] });
  out.push(row('look.rate224', 'right stick at byte 224: turn rate', 'deg/s', CONSOLE.turnRate224, Math.abs(r224[r224.length - 1]!.turnRate) / DEG, 'look', { tolerancePct: 0.2 }));
  const arrows = new FeelRig('stand').hold(1, { keys: ['ArrowLeft'] });
  const ramped = arrows.findIndex((s) => Math.abs(s.axis[0]) >= 1.118 * 0.999);
  out.push(row('look.ramp', 'arrow held: time to the full turn', 's', CONSOLE.turnRampSeconds, ramped < 0 ? null : (ramped + 1) / 60, 'look',
    { toleranceAbs: 1 / 60 }));
  const law = { value: lawTurnDegrees(60), kind: 'decomp' as const, source: 'FUN_002da930 ramp, gain 1.72, turn_maxrate 2 over 60 frames (this table\'s own loop)' };
  for (const fps of [30, 60, 144]) {
    const rig = new FeelRig('stand');
    const s = rig.hold(1, { keys: ['ArrowLeft'] }, fps);
    out.push(row(`look.turn1s@${fps}`, `1 s of an arrow from rest at ${fps} fps: degrees turned`, 'deg', law, s[s.length - 1]!.yaw, 'look',
      { tolerancePct: 0.5 }));
  }
  const up = new FeelRig('stand').hold(1.2, { keys: ['ArrowUp'] });
  const a = up[29]!, b = up[59]!;
  out.push(row('look.pitchRate', 'arrow up: pitch rate after the ramp', 'deg/s', CONSOLE.pitchRateFull, (b.pitch - a.pitch) / (b.t - a.t), 'look', { tolerancePct: 0.5 }));
  const corner = new FeelRig('stand').hold(1, { pad: [0, 0, 1, -1] });
  out.push(row('look.corner', 'right stick in its corner (bytes 255, 0): turn axis', 'axis', CONSOLE.turnAxisCorner,
    Math.abs(corner[corner.length - 1]!.axis[0]), 'look', { toleranceAbs: 0.0015,
      note: 'a pad whose corner reads (1, -1); the viewer clamps the pair to the rim before the law' }));
  return out;
}

const rootOf = (clip: MotionClip): Float32Array => clip.parts.find((p) => p.name === 'skel_root')?.translations ?? new Float32Array();

/** A looped clip's root travel a cycle, computed here apart from `./locomotion` (`FUN_0028ab10`): x and z, x n / (n - 1). */
function travelPerCycle(clip: MotionClip): number {
  const t = rootOf(clip), n = clip.frameCount, last = 3 * (n - 1);
  return (Math.hypot(t[last]! - t[0]!, t[last + 2]! - t[2]!) * n) / (n - 1);
}

/** Frames of the rig at 60 a second, one at a time, with the walk's action after each. */
function frames(rig: FeelRig, seconds: number): { s: Sample; action: string | null }[] {
  const out: { s: Sample; action: string | null }[] = [];
  for (let i = Math.round(seconds * 60); i > 0; i--) out.push({ s: rig.run(1 / 60)[0]!, action: rig.walk.snapshot()?.action?.name ?? null });
  return out;
}

/**
 * The body's clips and the camera's root input (the motion workstream's, web research 80): the run's and the full
 * strafe's clip rates, the standing jump (the clip on the floor) and the running jump (the impulse), the camera on the
 * posed root in a run, a jump and prone. The rows that need the clips run only with the fixtures.
 */
export function motionRows(fx: MotionFixtures | null): FeelRow[] {
  const out: FeelRow[] = [];
  // The running jump needs no clip: 1 s of W, then the jump, W still held.
  const runner = new FeelRig('stand');
  runner.hold(1, { keys: ['KeyW'] }, 60, true);
  const y0 = runner.sample().feet[1];
  runner.walk.jump();
  const leap = frames(runner, 1.5);
  const air = runner.walk.mover()!.landing?.airTime ?? null;
  runner.release();
  const up = leap.findIndex((f) => f.s.feet[1] > y0 + 1e-9);
  out.push(row('jump.runDelay', 'running jump: take-off to the first rise', 's', CONSOLE.runJumpDelay, up < 0 ? null : (up + 1) / 60, 'motion',
    { toleranceAbs: 1 / 60 + 1e-9 }));
  out.push(row('jump.runTop', 'running jump: the feet\'s top', 'u', CONSOLE.runJumpTop, Math.max(...leap.map((f) => f.s.feet[1])) - y0, 'motion',
    { tolerancePct: 2 }));
  out.push(row('jump.runAir', 'running jump: time in the air on flat ground', 's', CONSOLE.runJumpAir, air, 'motion', { toleranceAbs: 2 / 60 }));
  if (!fx) return out;
  const clip = new Map(clipsFromPack(fx.pack, ['seal_run', 'seal_jump', 'seal_prone', 'seal_run_90r']).map((c) => [c.name, c] as const));
  const need = (name: string): MotionClip => {
    const c = clip.get(name);
    if (!c) throw new Error(`MOTION_P.ZAR has no ${name}`);
    return c;
  };
  // The run and the full strafe: FUN_0058bdf0 turns a cycle at 65 / its travel a cycle, n keys a cycle.
  const keysAt65 = (name: string): number => (65 * need(name).frameCount) / travelPerCycle(need(name)) / 30;
  const run = new FeelRig('stand', undefined, fx).hold(2, { keys: ['KeyW'] });
  const ran = run[run.length - 1]!;
  out.push(row('anim.runFactor', 'full run: the clip\'s keys a second / 30', 'x', CONSOLE.runClipFactor,
    ran.anim!.clip === 'seal_run' ? ran.anim!.rate / 30 : null, 'motion', { note: `playing ${ran.anim!.clip}` }));
  const strafe = new FeelRig('stand', undefined, fx).hold(2, { keys: ['KeyD'] });
  const st = strafe[strafe.length - 1]!;
  out.push(row('anim.strafeFactor', 'full right strafe: the clip\'s keys a second / 30', 'x',
    { value: keysAt65('seal_run_90r'), kind: 'decomp', source: 'FUN_00583030 -> FUN_0058bdf0: the strafe set\'s band at 65 is seal_run_90r (web research 80 section 0)' },
    st.anim!.clip === 'seal_run_90r' ? st.anim!.rate / 30 : null, 'motion', { tolerancePct: 1, note: `playing ${st.anim!.clip}` }));
  // The camera on the posed root: a run lowers the look-at to seal_run's root + 10; prone stands it on seal_prone's.
  const runRoot = rootOf(need('seal_run'))[1]!;
  out.push(row('cam.runTarget', 'full run: look-at target over the feet', 'u', { ...CONSOLE.runRootY, value: lookHeight(runRoot) },
    ran.camera.target[1] - ran.drawn[1], 'motion', { toleranceAbs: 0.05, note: `seal_run's root y ${runRoot.toFixed(3)} + the ramp's 10` }));
  const prone = new FeelRig('prone', undefined, fx).run(1.5);
  out.push(row('cam.proneRoot', 'prone at rest: the root the camera stands on', 'u', { ...CONSOLE.proneRootY, value: rootOf(need('seal_prone'))[1]! },
    prone[prone.length - 1]!.camera.rootY, 'motion', { toleranceAbs: 0.05 }));
  // The standing jump: the clip on the floor.
  const stander = new FeelRig('stand', undefined, fx);
  stander.run(1);
  const floorY = stander.sample().feet[1];
  const t0 = stander.sample().t;
  stander.walk.jump();
  const hop = frames(stander, 1.5);
  const rootAt = (f: { s: Sample }): number => f.s.anim?.rootY ?? -Infinity;
  const top = hop.reduce((m, f) => (rootAt(f) > rootAt(m) ? f : m), hop[0]!);
  const jt = rootOf(need('seal_jump'));
  let clipTop = -Infinity;
  for (let i = 1; i < jt.length; i += 3) clipTop = Math.max(clipTop, jt[i]!);
  out.push(row('jump.standFeet', 'standing jump: the feet\'s rise', 'u', CONSOLE.standJumpFeet, Math.max(...hop.map((f) => f.s.feet[1])) - floorY, 'motion',
    { toleranceAbs: 1e-6 }));
  out.push(row('jump.standRoot', 'standing jump: the posed root\'s top', 'u', { ...CONSOLE.standJumpRootTop, value: clipTop },
    top.s.anim?.rootY ?? null, 'motion', { toleranceAbs: 0.05 }));
  out.push(row('jump.standTop', 'standing jump: time to the root\'s top', 's', CONSOLE.standJumpTopSeconds, top.s.t - t0, 'motion',
    { toleranceAbs: 1 / 60 + 1e-9 }));
  const last = hop.map((f) => f.action).lastIndexOf('jump');
  out.push(row('jump.standLength', 'standing jump: how long the action holds', 's', CONSOLE.standJumpSeconds, last < 0 ? null : (last + 1) / 60, 'motion',
    { toleranceAbs: 1 / 60 + 1e-9 }));
  out.push(row('cam.jumpTarget', 'standing jump: the look-at target\'s top over the feet', 'u',
    { value: lookHeight(clipTop), kind: 'decomp', source: 'FUN_0029a950 on the posed root (web research 80 section 0): seal_jump\'s top + 10' },
    Math.max(...hop.map((f) => f.s.camera.target[1] - f.s.drawn[1])), 'motion', { toleranceAbs: 0.1 }));
  return out;
}

/** Every row: the mover, the camera, the look, and the motion's when the fixtures are on hand. */
export function feelTable(fx: MotionFixtures | null = null, fovDegrees = 49): FeelRow[] {
  return [...moverRows(), ...cameraRows(fovDegrees), ...lookRows(), ...motionRows(fx)];
}

// ---- research 79's run, replayed ---------------------------------------------------------------------------------

const KEY_OF: Record<string, string> = { W: 'KeyW', S: 'KeyS', A: 'KeyA', D: 'KeyD' };

/**
 * One hold of research 79's schedule on the viewer: its stance, its buttons (the keys, or the light macro `W_LIGHT` as
 * the pad at its push), from rest; the viewer's rows a tick apart on the same fitter. Returns the fitted pair.
 */
export function replayHold(consoleRows: readonly Row[], hold: Hold): { console: ReturnType<typeof fitHold>; viewer: ReturnType<typeof fitHold> } {
  const stance = (['stand', 'crouch', 'prone'] as const).find((s) => s === hold.stance) ?? 'stand';
  const rig = new FeelRig(stance);
  const input: HoldInput = { keys: [] };
  for (const b of hold.buttons ?? []) {
    if (b === 'W_LIGHT') input.pad = padForward(lightByte(hold.push ?? 0.5).value);
    else if (KEY_OF[b]) (input.keys as string[]).push(KEY_OF[b]!);
  }
  const seconds = hold.tEnd - hold.tStart;
  const rest = rig.run(1).map((s) => s);
  const moving = rig.hold(seconds, input);
  const viewerRows: Row[] = [...rest, ...moving].map((s) => ({ t: s.t, x: s.feet[0], y: s.feet[1], z: s.feet[2], rootY: s.camera.rootY, moveScale: 1 }));
  const t0 = rest[rest.length - 1]!.t;
  return {
    console: fitHold(consoleRows, hold),
    viewer: fitHold(viewerRows, { ...hold, tStart: t0, tEnd: t0 + seconds }),
  };
}

/** The table's rows for a whole run of research 79: the steady speed and the t90 of every hold both sides fit. */
export function sealSpeedRows(consoleRows: readonly Row[], holds: readonly Hold[]): FeelRow[] {
  const out: FeelRow[] = [];
  for (const h of holds) {
    const { console: c, viewer: v } = replayHold(consoleRows, h);
    const source = `research 79 run: hold ${h.name} (${c.status}, ${c.n} rows)`;
    if (Number.isFinite(c.speed)) {
      out.push(row(`r79.${h.name}.speed`, `${h.name}: steady speed`, 'u/s', { value: c.speed, kind: 'console', source }, v.speed, 'mover', { tolerancePct: 5 }));
    }
    if (Number.isFinite(c.t90)) {
      out.push(row(`r79.${h.name}.t90`, `${h.name}: t90 (with the pad latency)`, 's', { value: c.t90, kind: 'console', source }, v.t90, 'mover', { toleranceAbs: 0.05 }));
    }
    if (Number.isFinite(c.rootYRest)) {
      out.push(row(`r79.${h.name}.root`, `${h.name}: skeleton root at rest`, 'u', { value: c.rootYRest, kind: 'console', source }, v.rootYRest, 'motion', { toleranceAbs: 0.05 }));
    }
  }
  return out;
}

// ---- the table as text -------------------------------------------------------------------------------------------

const num = (v: number | null, digits = 3): string => (v === null || !Number.isFinite(v) ? '--' : Number(v.toFixed(digits)).toString());

/** A markdown table: quantity, console, viewer, error, status, kind, owner, source. */
export function formatTable(rows: readonly FeelRow[]): string {
  const lines = [
    '| id | quantity | unit | console | viewer | error | tol | | kind | owner | console source |',
    '|---|---|---|---:|---:|---:|---:|---|---|---|---|',
  ];
  for (const r of rows) {
    const err = r.error === null ? '--' : r.errorKind === '%' ? `${num(r.error, 2)} %` : num(r.error, 4);
    const tol = r.errorKind === '%' ? `${r.tolerance} %` : num(r.tolerance, 4);
    lines.push(`| ${r.id} | ${r.quantity}${r.note ? ` (${r.note})` : ''} | ${r.unit} | ${num(r.console)} | ${num(r.viewer)} | ${err} | ${tol} | ${r.pass ? 'ok' : '**DIVERGES**'} | ${r.kind} | ${r.owner} | ${r.source} |`);
  }
  return lines.join('\n');
}
