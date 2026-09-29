import { SEAL_TUNING } from '@s2u/scene';

/**
 * The look law (web research 83): how SOCOM II turns a right stick into a turn and a pitch, and the view's two screen
 * shifts -- the explosion / machine-gun shake and the view bob -- read from `game/analysis/socom2_game.elf.decomp.c`
 * and the console's own RAM at the spawn (`logs/parity/spawn_pcsx2.rdram`). Everything here is pure or a small state
 * machine; `camera.ts` (`FlyCamera`, walking) drives it.
 *
 * ```
 * FUN_002da930 (decomp 179484-179878), the pad reader, the right stick (the pad object +0x2ac..0x2d1; the dump's 0x84a13c)
 *   v = (127.5 - byte) / 127.5                                    -1..1 (right and up are the minus side of the byte)
 *   |v| < 0.3 -> 0                                                  the dead zone, per axis (+0x2b0 = 0.3)
 *   v = sign * (|v| - 0.3) / 0.7, clamped to 1                      the rescale (+0x2c8 = 1)
 *   FUN_002da200 mode 1 (DAT_003df240 = 1): r = 1 unless one axis' integer part beats the other's, then minor/major;
 *     both axes x sqrt(1 + |r|), clamped -- so below full push each axis is x sqrt 2 (+0x2c9 = 1)
 *   v = sign * |0.65 * v^3|                                         the curve (+0x2b8 = 0.65, +0x2bc = 3, +0x2d0/1 = 1)
 *   the ramp (+0x2ca = 1, +0x2cc = 0.75): |v| grows at most dt + (1 - dt) * 0.13 * (1 - 0.75), x 1 / (0.75 + 0.5),
 *     a frame; it falls at once, and a reversal starts from 0
 * FUN_005966a0 (decomp 453753-453875), the SEAL's controls
 *   turn = v.x * 1.72 (DAT_00650630), pitch = v.y * 1.72 (DAT_00650628; DAT_003df198 = +1, not inverted)
 *   [the throttle turn/pitch_throttle_a/b only when DAT_0066b3e8 -- 0 on the dump: off]
 *   both / the scope's magnification (FUN_005be660: 1 unscoped); x 0.2 more in view mode 4 (DAT_00650638)
 *   the game's view modes 1-3 (its first person and the night vision), moving: the bob (below)
 * FUN_00550ef0 (decomp 418340): the angular velocity actor+0x48 = turn_maxrate 2 x the turn axis (research 22: 128.1
 *   deg/s at full push = 2 x 0.65 x 1.72 rad/s, to the tenth)
 * FUN_00594600 (decomp 452781-452958): pitch += pitch_rate 0.85 x axis x dt toward a limit and not past it; a pitch
 *   outside the stance's limits comes back at 0.5 rad/s; +-1.4 rad in any case
 * ```
 */

/** The right stick's pad-reader settings on the console (the spawn dump; `FUN_002da6c0`'s preset 0 writes them). */
export interface StickConfig {
  /** `+0x2b0`: the per-axis dead zone. */
  deadZone: number;
  /** `+0x2b8`: the curve's gain (`FUN_002da800` reads it as the options slider at 0.5 -- the middle). */
  gain: number;
  /** `+0x2bc`: the curve's power. */
  exponent: number;
  /** `+0x2cc`: the ramp's setting. */
  ramp: number;
}

export const RIGHT_STICK: StickConfig = { deadZone: 0.3, gain: 0.65, exponent: 3, ramp: 0.75 };

/** `DAT_00650630` / `DAT_00650628` on the dump: the controls' look gain, the same for the turn and the pitch. */
export const LOOK_GAIN = 1.72;
/** The turn axis at full push: 0.65 x 1.72 = 1.118, research 22's measured axis at |rx - 0x80| = 127. */
export const FULL_AXIS = RIGHT_STICK.gain * LOOK_GAIN;
/** The full-push turn, rad/s: `turn_maxrate` x 1.118 = 2.236 (128.1 deg/s). */
export const MAX_YAW_RATE = SEAL_TUNING.turnMaxRate * FULL_AXIS;
/** The full-push pitch, rad/s: `pitch_rate` x 1.118 = 0.950 (54.4 deg/s). */
export const MAX_PITCH_RATE = SEAL_TUNING.pitchRate * FULL_AXIS;
/** `FUN_00594600`: a pitch outside the limits comes back at this, rad/s (`param_1 * 0.5`). */
export const PITCH_RETURN = 0.5;
/** `FUN_00594600`: the pitch never passes this, rad, alive (`0x3fb33333`). */
export const PITCH_HARD = 1.4;
/** `DAT_00650638`, and the move axes' own x 0.2 in any scoped view mode (`FUN_005966a0`). */
export const SCOPE_SLOW = 0.2;

const clamp1 = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);

/** `FUN_002da930`'s dead zone and rescale on one axis. */
export function deadZone(v: number, zone: number = RIGHT_STICK.deadZone): number {
  if (Math.abs(v) < zone) return 0;
  return clamp1((v > 0 ? v - zone : v + zone) / (1 - zone));
}

/**
 * `FUN_002da200` in mode 1: the ratio of the two axes when one's integer part (0 or 1) is the larger, else 1, and both
 * axes times sqrt(1 + |ratio|), clamped. The integer parts are the decompilation's `(int)` casts; research 22's four
 * clean holds fit only with them (a float compare would leave a pure turn at x 1 and +96 at 0.31, not the 0.879 read).
 */
export function circle(x: number, y: number): [number, number] {
  const ix = Math.trunc(Math.abs(x)), iy = Math.trunc(Math.abs(y));
  let r = 1;
  if (iy < ix) r = y / x;
  else if (ix < iy) r = x / y;
  const f = Math.sqrt(Math.abs(r) + 1);
  return [clamp1(x * f), clamp1(y * f)];
}

/** `FUN_002da930`'s curve: sign x |gain x v^exponent|. */
export function curve(v: number, cfg: StickConfig = RIGHT_STICK): number {
  return Math.sign(v) * Math.abs(cfg.gain * Math.pow(v, cfg.exponent));
}

/**
 * The stick, one frame, from the raw pair (x right, y up, -1..1) to the pad reader's output before its ramp: the dead
 * zone, the rescale, the circle and the curve.
 */
export function stickCurve(x: number, y: number, cfg: StickConfig = RIGHT_STICK): [number, number] {
  const [cx, cy] = circle(deadZone(x, cfg.deadZone), deadZone(y, cfg.deadZone));
  return [curve(cx, cfg), curve(cy, cfg)];
}

/** The pad reader's curve on a stick already past its dead zone (0..1 per axis): the mouse's virtual stick. */
export function pushCurve(x: number, y: number, cfg: StickConfig = RIGHT_STICK): [number, number] {
  const [cx, cy] = circle(clamp1(x), clamp1(y));
  return [curve(cx, cfg), curve(cy, cfg)];
}

/** The ramp's largest growth in one game frame of `dt` seconds (`FUN_002da930`'s loop). */
export function rampStep(dt: number, setting: number = RIGHT_STICK.ramp): number {
  let step = dt <= 1 ? dt + (1 - dt) * (1 - (setting * 0.13 + 0.87)) : 1;
  if (setting > 0.5) step *= 1 / (setting + 0.5);
  return step;
}

/**
 * The ramp a second, at a 60 Hz game frame [reading: the console's frame rate is not measured]: 60 x 0.0389 = 2.33 --
 * a flick to full push takes 0.28 s to reach the full 0.65. The viewer's frames are any length, so the growth is this
 * times the frame's dt, not the formula at the frame's dt (which would ramp faster on a faster screen).
 */
export const RAMP_PER_SECOND = 60 * rampStep(1 / 60);

/** One axis of the ramp: `prev` the last output, `v` this frame's curve, `step` the growth allowed. */
export function ramp(prev: number, v: number, step: number): number {
  const sign = v < 0 ? -1 : 1;
  const from = sign * prev <= 0 ? 0 : prev;
  return clamp1(step + Math.abs(from) < Math.abs(v) ? sign * step + from : v);
}

/** `turn_throttle_a/b`, `pitch_throttle_a/b`: linear to (a, b), then linear to (1, 1). Off on the console. */
export function throttle(v: number, [a, b]: readonly [number, number]): number {
  const m = Math.abs(v);
  return Math.sign(v) * (m <= a ? m * (b / a) : b + (1 - b) * ((m - a) / (1 - a)));
}

/**
 * `FUN_00594600`, one frame: the pitch (rad, up positive) moved at `rate` rad/s toward the limit it points at and
 * stopped there, pulled back at 0.5 rad/s when outside `[min, max]` (a stance change), and held within +-1.4.
 */
export function stepPitch(pitch: number, rate: number, dt: number, min: number, max: number): number {
  let p = pitch;
  if (rate > 0 && p < max) p = Math.min(p + rate * dt, max);
  else if (rate < 0 && p > min) p = Math.max(p + rate * dt, min);
  if (p > max) p = Math.max(max, p - PITCH_RETURN * dt);
  else if (p < min) p = Math.min(min, p + PITCH_RETURN * dt);
  return Math.max(-PITCH_HARD, Math.min(PITCH_HARD, p));
}

/**
 * A mouse's pitch step under `stepPitch`'s rule: toward the limit it points at and not past it, never further out of
 * limits it is already outside (the pull back is `stepPitch`'s, in the frame).
 */
export function nudgePitch(pitch: number, delta: number, min: number, max: number): number {
  if (delta > 0 && pitch < max) return Math.min(pitch + delta, max);
  if (delta < 0 && pitch > min) return Math.max(pitch + delta, min);
  return pitch;
}

/**
 * The magnification's hold on the look: `FUN_005966a0` divides both axes by the scope's zoom (`FUN_005be660`, 1 when
 * not scoped: the first-person view modes 1-3 change nothing), and view mode 4 (the 9x, `FUN_005448a0`) by 5 more.
 */
export function zoomScale(magnification: number, mode4 = false): number {
  const m = magnification > 0 ? magnification : 1;
  return (1 / m) * (mode4 ? SCOPE_SLOW : 1);
}

// ---- The mouse: the viewer's own mapping (research 83 section 7) --------------------------------------------------

/**
 * `raw`: a mouse count is an angle, `sensitivity` x `MOUSE_RADIANS_PER_COUNT` -- no curve, no cap, no ramp; the default.
 * `stick`: the mouse is the game's right stick -- its speed over the last few frames is a push (full push at
 * `MOUSE_FULL_PUSH` counts a second x `sensitivity`), through the circle, the curve, the ramp and the 128 deg/s cap.
 */
export type MouseLaw = 'raw' | 'stick';

/**
 * The anchor of the default: one inch of an 800-DPI mouse turns as far as one second of the full stick, 128.1 deg --
 * 0.160 deg a count, the fly camera's own 0.0028 rad a pixel to 0.2 %.
 */
export const MOUSE_FULL_PUSH = 800;
export const MOUSE_RADIANS_PER_COUNT = MAX_YAW_RATE / MOUSE_FULL_PUSH;
/** The `stick` law's speed window, seconds: a mouse reports in bursts, a stick does not. */
const MOUSE_WINDOW = 0.05;

export interface LookOptions {
  mouse: MouseLaw;
  /** A multiplier on the default mapping: 1 is one inch at 800 DPI = one second of full stick. */
  sensitivity: number;
  /**
   * `game`: the mouse's y moves the pitch at `pitch_rate / turn_maxrate` (0.425) of what its x turns -- the game's
   * anisotropy, the ratio a stick has at every push. `uniform`: one angle a count on both axes (the PC shooter's).
   */
  pitchRatio: 'game' | 'uniform';
  /** Pushing up (or moving the mouse away) looks down. The game's default (`DAT_003df198 = +1`) is not inverted. */
  invertPitch: boolean;
  /** `turn/pitch_throttle`: the game's own option, off on the console (`DAT_0066b3e8 = 0`). */
  throttle: boolean;
}

export const DEFAULT_LOOK: LookOptions = { mouse: 'raw', sensitivity: 1, pitchRatio: 'game', invertPitch: false, throttle: false };

/** The ratio of the pitch to the turn a stick gives at any push: `pitch_rate / turn_maxrate`. */
export const PITCH_PER_YAW = SEAL_TUNING.pitchRate / SEAL_TUNING.turnMaxRate;

/** One frame's look, in the viewer's frame: `yaw` rad/s (left positive, as `Pose.yaw` grows), `pitch` rad/s up. */
export interface LookRates { yaw: number; pitch: number }

/**
 * The look law with its state: the pad reader's ramp and the mouse's speed. `frame` takes the stick (and the arrow
 * keys, a full push) and returns the rates; `mouse` returns a raw mouse's angles at once and feeds the `stick` law.
 */
export class LookLaw {
  private opts: LookOptions = { ...DEFAULT_LOOK };
  private scale = 1;
  /** The ramp's last output per axis (the pad object's +0x238 / +0x23c). */
  private prev: [number, number] = [0, 0];
  /** Mouse counts since the last frame, and their windowed speed (counts a second), for the `stick` law. */
  private counts: [number, number] = [0, 0];
  private speed: [number, number] = [0, 0];
  /** The turn axis last frame (ctrl+0x10's sign flipped to the viewer's: right positive), for `lookState`. */
  private axis_: [number, number] = [0, 0];

  options(): LookOptions {
    return { ...this.opts };
  }

  setOptions(opts: Partial<LookOptions>): void {
    this.opts = { ...this.opts, ...opts };
    if (!(this.opts.sensitivity > 0)) this.opts.sensitivity = 1;
    this.counts = [0, 0];
    this.speed = [0, 0];
  }

  /** The scope (`zoomScale`): 1 unscoped, the weapon's `ZoomModeN` when scoped (the M4A1's 1.5 and 2.5). */
  setZoom(magnification: number, mode4 = false): void {
    this.scale = zoomScale(magnification, mode4);
  }

  zoom(): number {
    return this.scale;
  }

  /** The game's turn and pitch axes last frame, after the gain and the zoom: x right, y up (1.118 at full push). */
  axis(): [number, number] {
    return [...this.axis_];
  }

  /** Forgets the ramp and the mouse's speed (a new walk, a lost focus). */
  reset(): void {
    this.prev = [0, 0];
    this.counts = [0, 0];
    this.speed = [0, 0];
    this.axis_ = [0, 0];
  }

  /**
   * A mouse move in counts (x right, y down, the browser's `movementX/Y`). The `raw` law answers the angles now --
   * yaw left positive, pitch up positive, radians; the `stick` law keeps the counts for `frame` and answers 0, 0.
   */
  mouse(dx: number, dy: number): [number, number] {
    if (this.opts.mouse === 'stick') {
      this.counts[0] += dx;
      this.counts[1] += dy;
      return [0, 0];
    }
    const k = MOUSE_RADIANS_PER_COUNT * this.opts.sensitivity * this.scale;
    const ky = k * (this.opts.pitchRatio === 'game' ? PITCH_PER_YAW : 1) * (this.opts.invertPitch ? -1 : 1);
    return [-dx * k, -dy * ky];
  }

  /**
   * One frame of `dt` seconds: the stick (x right, y up, raw -1..1; the arrow keys are a full push) through the pad
   * reader, the gain, the throttle when on and the zoom, and the `stick` law's mouse beside it (the larger push on
   * each axis). Returns the rates: yaw = -turn_maxrate x axis (right turns to a smaller yaw), pitch = pitch_rate x axis.
   */
  frame(dt: number, stickX: number, stickY: number): LookRates {
    let [x, y] = stickCurve(stickX, this.opts.invertPitch ? -stickY : stickY);
    if (this.opts.mouse === 'stick' && dt > 0) {
      const k = 1 - Math.exp(-dt / MOUSE_WINDOW);
      this.speed[0] += (this.counts[0] / dt - this.speed[0]) * k;
      this.speed[1] += (this.counts[1] / dt - this.speed[1]) * k;
      this.counts = [0, 0];
      const full = MOUSE_FULL_PUSH / this.opts.sensitivity;
      const ratio = this.opts.pitchRatio === 'game' ? 1 : 1 / PITCH_PER_YAW;
      const [mx, my] = pushCurve(this.speed[0] / full, (-this.speed[1] * ratio * (this.opts.invertPitch ? -1 : 1)) / full);
      if (Math.abs(mx) > Math.abs(x)) x = mx;
      if (Math.abs(my) > Math.abs(y)) y = my;
    }
    const step = RAMP_PER_SECOND * Math.max(0, dt);
    this.prev = [ramp(this.prev[0], x, step), ramp(this.prev[1], y, step)];
    let [ax, ay] = [this.prev[0] * LOOK_GAIN, this.prev[1] * LOOK_GAIN];
    if (this.opts.throttle) {
      ax = throttle(ax, SEAL_TUNING.turnThrottle);
      ay = throttle(ay, SEAL_TUNING.pitchThrottle);
    }
    ax *= this.scale;
    ay *= this.scale;
    this.axis_ = [ax, ay];
    return { yaw: -SEAL_TUNING.turnMaxRate * ax + 0, pitch: SEAL_TUNING.pitchRate * ay + 0 };
  }
}

// ---- The screen shifts: the shake and the bob (research 83 sections 5, 6) -----------------------------------------

/** The PS2 frame the offsets are counted in (`FUN_00294070`: added to the screen centre of a 640 x 448 frame). */
export const SCREEN = { width: 640, height: 448 } as const;
/** `FUN_002915a0` / `FUN_00291550`: an offset is held within +-200 pixels. */
export const SCREEN_OFFSET_LIMIT = 200;

/**
 * One shake (`FUN_002994e0`'s eight arguments): per axis the amplitude in PS2 pixels (`base` plus up to 0.99 x `rand`),
 * its fall a frame (`decr`), and the swing's rate in degrees a second (`dps`) -- `ScreenShake`'s `xaxis` / `yaxis`
 * in a weapon's `zweapon.rdr` stance, or the camera's three explosion presets.
 */
export interface ShakeAxis { base: number; rand: number; decr: number; dps: number }
export interface Shake { x: ShakeAxis; y: ShakeAxis }

/** The camera's presets (its constructor, decomp 142906-142929: +0x50, +0x70, +0x90). */
export const EXPLOSION_SHAKES: readonly Shake[] = [
  { x: { base: 6, rand: 1, decr: 2, dps: 2000 }, y: { base: 6, rand: 0.5, decr: 2, dps: 250 } },
  { x: { base: 20, rand: 10, decr: 2, dps: 2000 }, y: { base: 10, rand: 5, decr: 2, dps: 2000 } },
  { x: { base: 60, rand: 30, decr: 4, dps: 1000 }, y: { base: 55, rand: 15, decr: 4, dps: 1150 } },
];

/** `zweapon.rdr`'s `ScreenShake` on the M60E3, the M63A and the two turrets (every stance): one per round. */
export const MACHINE_GUN_SHAKE: Shake = {
  x: { base: 1, rand: 1, decr: 1, dps: 1600 }, y: { base: 1, rand: 1, decr: 1, dps: 2400 },
};

/**
 * `FUN_00550ef0` (decomp 418098-418110): an explosion within 100 units shakes with the big preset, within 200 the
 * middle, within 600 the small (`DAT_0064fc88/90/98` = 100^2, 200^2, 600^2); farther, none.
 */
export function explosionShake(distance: number): Shake | null {
  if (distance < 100) return EXPLOSION_SHAKES[2]!;
  if (distance < 200) return EXPLOSION_SHAKES[1]!;
  if (distance < 600) return EXPLOSION_SHAKES[0]!;
  return null;
}

/**
 * The game's screen shake (`FUN_002994e0` starts one, `FUN_00299c40` swings it each frame): x = A cos(phase), y = A
 * sin(phase), the phases at their `dps`, each amplitude falling by `decr` a frame; the phases start where the swing
 * is 0 (x 90 or 270 deg, y 0 or 180, a coin each), so a shake starts centred. A new shake only takes over when both its
 * amplitudes beat the running ones; its rates and falls never lower the running ones. `decr` is a frame's: the viewer
 * scales it by dt x 60 [reading: a 60 Hz frame].
 */
export class ScreenShake {
  private ampX = 0;
  private ampY = 0;
  private phaseX = 90;
  private phaseY = 0;
  private rate: [number, number] = [-1, -1];
  private dec: [number, number] = [-1, -1];
  private base: [number, number] = [-1, -1];
  private rand: [number, number] = [-1, -1];
  private active = false;

  constructor(private readonly random: () => number = Math.random) {
    this.settle();
  }

  /** `FUN_002994e0`. */
  start(shake: Shake): void {
    let [bx, by] = [shake.x.base, shake.y.base];
    const rate: [number, number] = [Math.max(shake.x.dps, this.rate[0]), Math.max(shake.y.dps, this.rate[1])];
    const takes = this.ampX < bx && this.ampY < by;
    if (bx <= this.ampX) bx = this.base[0];
    if (by <= this.ampY) by = this.base[1];
    this.dec = [Math.max(shake.x.decr, this.dec[0]), Math.max(shake.y.decr, this.dec[1])];
    this.rate = rate;
    this.base = [bx, by];
    this.rand = [shake.x.rand, shake.y.rand];
    if (!takes) return;
    this.ampX = Math.max(this.ampX, bx + this.rand[0] * Math.floor(this.random() * 100) * 0.01);
    this.ampY = Math.max(this.ampY, by + this.rand[1] * Math.floor(this.random() * 100) * 0.01);
    this.active = true;
  }

  /** `FUN_00299c40`: one frame, the offset (x right, y down, PS2 pixels). */
  step(dt: number): [number, number] {
    if (!this.active) return [0, 0];
    this.phaseX += dt * this.rate[0];
    if (this.phaseX > 360) this.phaseX -= 360;
    this.phaseY += dt * this.rate[1];
    if (this.phaseY > 360) this.phaseY -= 360;
    const out: [number, number] = [
      this.ampX * Math.cos((this.phaseX * Math.PI) / 180), this.ampY * Math.sin((this.phaseY * Math.PI) / 180),
    ];
    const frames = dt * 60;
    this.ampX = Math.max(0, this.ampX - this.dec[0] * frames);
    this.ampY = Math.max(0, this.ampY - this.dec[1] * frames);
    if (this.ampX === 0 && this.ampY === 0) this.settle();
    return out;
  }

  /** The amplitudes left, PS2 pixels (the hook's). */
  amplitude(): [number, number] {
    return [this.ampX, this.ampY];
  }

  private settle(): void {
    this.active = false;
    this.rate = [-1, -1];
    this.dec = [-1, -1];
    this.base = [-1, -1];
    this.rand = [-1, -1];
    this.ampX = 0;
    this.ampY = 0;
    this.phaseX = this.random() < 0.5 ? 270 : 90;
    this.phaseY = this.random() < 0.5 ? 180 : 0;
  }
}

/**
 * The view bob (`FUN_005966a0`, decomp 453823-453849; `BOBBING_FIRSTPERSON`): in the game's first-person view modes,
 * moving, the view drops by amplitude x cos(phase) PS2 pixels (`FUN_005b90c0` into the offset `FUN_005b9030` zeroes
 * each frame, handed to the camera's y), and the phase grows by the move stick's push x `Walk_Rate` (`Crawl_*` prone) a
 * second -- 15 rad/s is 2.4 swings a second at a full stick, 6 pixels either way. The push is one axis' when the
 * other is 0, else the mean of the two. Standing still the offset is 0 at once and the phase is kept. The viewer has
 * no first person (the owner, 2026-09-29): the bob runs in its views from the head, the scope and the night vision.
 */
export class ViewBob {
  private phase = 0;

  /** One frame: the move stick (either sign), prone or not; the vertical offset, PS2 pixels down. */
  step(dt: number, moveX: number, moveY: number, prone: boolean): number {
    const x = Math.abs(moveX), y = Math.abs(moveY);
    if (x === 0 && y === 0) return 0;
    const push = x === 0 ? y : y === 0 ? x : (x + y) / 2;
    const bob = SEAL_TUNING.bobbing;
    const out = Math.cos(this.phase) * (prone ? bob.crawlAmplitude : bob.walkAmplitude);
    this.phase += push * dt * (prone ? bob.crawlRate : bob.walkRate);
    if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
    return out;
  }

  reset(): void {
    this.phase = 0;
  }
}

/**
 * A PS2 screen offset as a three.js view offset (`PerspectiveCamera.setViewOffset`) on a frame of `aspect`: the
 * console added it to the projection's centre on a 640 x 448 frame shown at 4:3, so a pixel across is 4/3 x 448 / 640
 * of a pixel down; both are kept at the console's size relative to the frame's height (as `reticle.ts` does). Returns
 * the view offset in a frame 448 high: `[x, y]` to pass with full width `aspect x 448` -- content moves right and down.
 */
export function viewOffset(offsetX: number, offsetY: number): [number, number] {
  const x = Math.max(-SCREEN_OFFSET_LIMIT, Math.min(SCREEN_OFFSET_LIMIT, offsetX));
  const y = Math.max(-SCREEN_OFFSET_LIMIT, Math.min(SCREEN_OFFSET_LIMIT, offsetY));
  return [-x * ((4 / 3) * SCREEN.height / SCREEN.width), -y];
}

// ---- The body and the look (research 83 section 3) -----------------------------------------------------------------

/**
 * The walk's look, for the body and its clips (`FlyCamera.lookState`). In SOCOM II the camera's yaw **is** the body's:
 * the stick turns the actor (`actor+0x48`, and `FUN_00297410` puts the camera behind the actor matrix), so `bodyYaw`
 * equals `lookYaw` and there is no twist before the legs turn; the upper body pitches with the look (the aim nodes,
 * `FUN_005df600`, held to the aim cone) unless the clip says `NoPitchtwist`. Turning in place plays no clip standing or
 * crouched (motion.rdr has none); prone, `seal_prone_turn` plays while the turn is not 0 (`FUN_0054aa30`).
 */
export interface LookState {
  /** The look's yaw, degrees (`Pose.yaw`). */
  lookYaw: number;
  /** The body's facing, degrees: the look's yaw in SOCOM II. */
  bodyYaw: number;
  /** The camera's pitch, degrees, up positive: the aim pitch the upper body takes. */
  pitch: number;
  /** The turn, rad/s, left positive (as `Pose.yaw` grows): `turn_maxrate` x the axis. */
  turnRate: number;
  /** The game's turn and pitch axes (x right, y up; 1.118 at full push, after the zoom). */
  axis: [number, number];
  /** The turn is not 0: prone, `seal_prone_turn`. */
  turning: boolean;
  /** The screen offset drawn this frame, PS2 pixels (the shake plus the bob; x right, y down). */
  screen: [number, number];
}

/**
 * The run's bank (`FUN_0057a330`, decomp 439198-439204): a node of the body (`actor+0x2fc`) turned about its forward
 * axis by -0.000375 x the angular velocity x the forward velocity, radians -- 3.1 deg into a full turn at the run.
 * Viewer terms: `turnRate` rad/s left positive, `forwardSpeed` units/s; positive leans right.
 */
export function runningLean(turnRate: number, forwardSpeed: number): number {
  return -0.000375 * turnRate * forwardSpeed;
}

/**
 * `FUN_005df600`'s cone: an aim `yawOffset` degrees off the body and a `pitch` held to the stance's aim limits
 * (`max_aim_yaw` 85, prone `prone_max_aim_yaw` 45; the aim pitches), for a body that must twist to an aim off its
 * facing -- none in the walk, where the offset is always 0.
 */
export function aimTwist(yawOffset: number, pitch: number, prone: boolean): { yaw: number; pitch: number } {
  const yawMax = prone ? SEAL_TUNING.proneAimYaw : SEAL_TUNING.aimYaw;
  const [min, max] = prone ? SEAL_TUNING.proneAimPitch : SEAL_TUNING.aimPitch;
  return { yaw: Math.max(-yawMax, Math.min(yawMax, yawOffset)), pitch: Math.max(min, Math.min(max, pitch)) };
}
