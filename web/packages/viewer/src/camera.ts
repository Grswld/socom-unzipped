import { MathUtils, PerspectiveCamera, Vector3 } from 'three';
import { PAD_DEAD_ZONE } from './gamepad';
import {
  FirstPersonBob, LookLaw, nudgePitch, ScreenShake, SCREEN, stepPitch, viewOffset,
  type LookOptions, type LookState, type Shake,
} from './look';

/** A camera pose in the game's world frame: position in game units, yaw and pitch in degrees. */
export interface Pose { x: number; y: number; z: number; yaw: number; pitch: number }

/** Metres a second at a cruise; the fly speed is this divided by `MetersPerUnit` to get game units. */
const METRES_PER_SECOND = 12;
/** Ctrl multiplies it: crossing a 100 m map end to end takes about two seconds. */
const SPRINT = 5;
/** Radians of look per pixel of drag, and per unit of pointer-lock movement. */
const LOOK = 0.0028;
/** A thumb has a phone's width to work with, not a desk's: a touch drag turns this much further. */
const TOUCH_LOOK = 2;
/** Radians a second the arrow keys turn, for a keyboard with no mouse to hand. */
const ARROW_LOOK = 1.6;
/** Straight up and straight down are singular for a yaw/pitch camera, so stop just short. */
const PITCH_LIMIT = MathUtils.degToRad(89.9);
/*
 * Walking, the look is the game's (`./look`, web research 83): the pad's right stick and the arrow keys (a full push)
 * through the pad reader's dead zone, curve and ramp, at `turn_maxrate` / `pitch_rate` x 1.118 at full push, and the
 * mouse by the viewer's own mapping (`LookOptions`: raw by default, one inch at 800 DPI = one second of full stick, the
 * pitch at the game's 0.425 of the turn). The pitch stops at the stance's aim limits and comes back to them at
 * 0.5 rad/s after a stance change (`FUN_00594600`).
 */

/**
 * How fast velocity chases the stick, per second, as the exponent of an exponential approach.
 * Pressing a key reaches ~99% of cruise in 3/ACCEL seconds; releasing it coasts for about 3/BRAKE.
 * Braking is slower than accelerating, which is what gives creative-mode flight its glide: you stop
 * over roughly a third of a second rather than on the frame the key comes up.
 */
export const ACCEL = 14;
export const BRAKE = 8;

/**
 * One axis of the velocity model over `dt` seconds, in closed form: v(t) = target + (v0 - target)e^(-rate t).
 * Both the distance covered and the velocity at the end are taken from that curve rather than from `v * dt` at
 * one end of it, so the distance does not depend on how the time is cut up. The fly camera steps it once a frame;
 * the walk (`./walk`) steps it once a 60 Hz tick on the ground plane.
 */
export function glide(v0: number, target: number, rate: number, dt: number): { moved: number; velocity: number } {
  const decay = Math.exp(-rate * dt);
  const integral = (1 - decay) / rate;            // ∫e^(-rate t) dt over the step
  return { moved: target * dt + (v0 - target) * integral, velocity: target + (v0 - target) * decay };
}

/**
 * What the keys and the touch stick ask the walk for (`./walk`): forward and right on the ground plane, -1..1. The
 * boost is the fly camera's gesture and is always false here: the walk has no sprint (W2.R2; the owner, 2026-09-28).
 * The field stays so the walk's input type is unchanged.
 */
export interface GroundWish { forward: number; right: number; boost: boolean }

/**
 * The vertical field of view at rest before a map states its own, and how far the boost widens it.
 * Every map's `cameras/camera` authors `fov (0.6109 0.4276)` -- half-angles, 35 degrees by 24.5 --
 * and `setFov` puts the map's on once it is read; 49 is what all but one of them come to.
 */
const FOV = 49;
/**
 * The clip planes a map is opened with, before its own are known. 4 is the game's own near plane; the
 * far is a whole large map and then some, and `setClipPlanes` narrows it once the map's extent is read.
 */
const DEFAULT_NEAR = 4;
const DEFAULT_FAR = 12000;
const SPRINT_FOV = 1.14;
/** Exponential approach rate for the FOV kick, per second. */
const FOV_RATE = 9;

/**
 * Sprint is a double-tap of forward, held -- Minecraft's own gesture, and the only safe one in a browser.
 * Ctrl cannot be used: Ctrl+W closes the tab and Chrome does not let a page prevent it, so binding a boost
 * to Ctrl next to a W that means "forward" hands the player a loaded gun. Ctrl+D and Ctrl+A are preventable
 * and are prevented below, but Ctrl+W is not, so nothing is bound to Ctrl at all.
 */
const DOUBLE_TAP_MS = 300;

/** Wheel speed control: one notch is this factor, clamped to these bounds. */
const WHEEL_STEP = 1.15;
const SPEED_MIN = 0.1;
const SPEED_MAX = 16;

/** Frame-rate independent exponential approach: the value `a` moves toward `b` at rate `k` per second. */
const approach = (a: number, b: number, k: number, dt: number): number =>
  b + (a - b) * Math.exp(-k * dt);

/**
 * Every code the camera consumes. A keydown on one of these is prevented, so the browser chords that
 * share them -- Ctrl+D bookmark, Ctrl+A select-all, Ctrl+S save, Space page-scroll -- never fire while
 * the viewer has the keyboard. `C` (the walk's stance) and `V` (its first-person switch, W2.1) are not here:
 * `WalkMode` prevents a bare C or V while walking itself, and owning them here would take Ctrl+C / Ctrl+V (copy,
 * paste) from the page everywhere.
 */
const OWNED = new Set([
  'keyw', 'keya', 'keys', 'keyd', 'keyq', 'keye', 'space', 'shiftleft', 'shiftright',
  'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
]);

export interface FlyCameraOptions {
  /** Called when the wheel changes the speed multiplier, so the page can show it. */
  onSpeedChange?: (multiplier: number) => void;
  /** Called when pointer lock is taken or released, so the page can show a hint. */
  onLockChange?: (locked: boolean) => void;
  /**
   * The trigger (W2.5, `./fire`): the left button pressed (true) and let go (false) **while the mouse is captured**.
   * The click that takes the lock is not a shot; losing the lock lets a held trigger go.
   */
  onFire?: (down: boolean) => void;
}

/**
 * A fly camera in the game's world frame (y up, right-handed, SEMANTICS section 8), with the controls
 * and the feel of a creative-mode build camera:
 *
 * - **Click the canvas to capture the mouse**; look is then free, and Esc gives the pointer back. When
 *   pointer lock is unavailable — headless Playwright, a touch screen — dragging still looks, so the
 *   screenshot tests and a tablet both keep working.
 * - **W/S** fly along the look direction, pitch included, so looking down and holding W descends.
 *   **A/D** strafe level with the horizon whatever the pitch: a strafe that dipped with the nose makes
 *   it impossible to sidle along a wall while looking at it.
 * - **Space** up, **Shift** down, both in world space. **Double-tap W and hold** to boost, which widens
 *   the view to match -- Minecraft's own sprint gesture, and the only one that is safe here: Ctrl+W
 *   closes the tab and no page can prevent it, so nothing is bound to Ctrl.
 *   The boost is the fly camera's alone: in walk mode nothing boosts (owner, 2026-09-28).
 *   **Q/E** stay bound to down/up as they were, for anyone with the old keys in their fingers.
 * - **Wheel** trims the speed between a tenth and sixteen times, because a map is 100 m across but a
 *   prop is 30 cm.
 *
 * Movement is velocity-based rather than position-based: keys steer a target velocity that the real
 * velocity chases, so starts ramp and stops glide instead of snapping. `setPose` kills the velocity
 * outright, which is what keeps the Playwright poses exact.
 *
 * Yaw and pitch are kept here rather than read back off the camera's quaternion, so the debug hook can
 * set an exact pose.
 */
export class FlyCamera {
  readonly camera: PerspectiveCamera;
  private yaw = 0;
  private pitch = 0;
  /** The touch stick's axes, -1..1: x strafes right, y moves along the look direction. */
  private stickX = 0;
  private stickY = 0;
  /** The touch up/down buttons: 1, 0 or -1, the same lane space and shift drive. */
  private lift = 0;
  /** The stick held at its rim: the phone's boost gesture (`./touch`). */
  private stickBoost = false;
  /** A pad's right stick (`./gamepad`, W2.7), -1..1: x turns right, y looks up, at the arrow keys' rate scaled. */
  private lookX = 0;
  private lookY = 0;
  private readonly keys = new Set<string>();
  private dragging: number | null = null;
  private lastX = 0;
  private lastY = 0;
  /** Game units a second at the map's scale; `setScale` adjusts it when a map states its own. */
  private speed = METRES_PER_SECOND / 0.1;
  /** The wheel's trim on top of `speed`. */
  private speedMultiplier = 1;
  /** Current velocity in game units a second. Public movement state, zeroed by `setPose`. */
  private readonly velocity = new Vector3();
  /** The vertical field of view at rest: the map's own once `setFov` has it. */
  private restFov = FOV;
  /** The FOV actually applied, eased toward its target so the sprint kick is not a step. */
  private fov = FOV;
  private locked = false;
  /** When forward was last tapped, and whether the tap that is still held was the second one. */
  private lastForwardTap = 0;
  private sprinting_ = false;
  /** Walk mode (`./walk`): the keys and the stick steer the mover, and this camera only looks. */
  private walking = false;
  /** Walking, the pitch's limits in radians (`setPitchLimits`: the aim pitch's, W2.1). */
  private walkPitch: [number, number] = [-PITCH_LIMIT, PITCH_LIMIT];
  /** The left button pressed while locked and not yet let go (`onFire`). */
  private triggerHeld = false;
  /** Walking: the game's look law (`./look`), the screen shake, the first-person bob and what they last gave. */
  private readonly law = new LookLaw();
  private readonly shake = new ScreenShake();
  private readonly bob = new FirstPersonBob();
  private firstPerson = false;
  private prone = false;
  private scoped = false;
  private turnRate = 0;
  private screen: [number, number] = [0, 0];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly options: FlyCameraOptions = {},
  ) {
    this.camera = new PerspectiveCamera(FOV, 1, DEFAULT_NEAR, DEFAULT_FAR);
    this.camera.rotation.order = 'YXZ';       // yaw about y, then pitch about the new x
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    // A right-click is a look-around on a fly camera, not a request for the browser's menu.
    canvas.addEventListener('contextmenu', this.onContextMenu);
    globalThis.addEventListener('keydown', this.onKeyDown);
    globalThis.addEventListener('keyup', this.onKeyUp);
    globalThis.addEventListener('blur', this.onBlur);
    globalThis.document?.addEventListener('pointerlockchange', this.onLockChange);
  }

  /** `MetersPerUnit` from the map: the fly speed is a cruise in metres, whatever the unit is. */
  setScale(metersPerUnit: number): void {
    this.speed = METRES_PER_SECOND / (metersPerUnit > 0 ? metersPerUnit : 0.1);
  }

  /**
   * The near and far clip planes. Depth precision is spent in proportion to `far / near`, and a
   * perspective depth buffer puts most of its resolution just past the near plane: at the 1 / 40000 the
   * camera used to open with, two coplanar surfaces a few units apart land on the same depth value and
   * flicker against each other as the camera moves. The game's own near plane is 4 (`m_near_plane` in
   * `cameras/camera`, 4.0 on all 22 maps) and its far is a few hundred; the viewer keeps the near and
   * takes a far from the map's extent, which is generous enough to fly around in and still ~26x the
   * precision.
   */
  setClipPlanes(near: number, far: number): void {
    if (!(far > near) || near <= 0) return;
    this.camera.near = near;
    this.camera.far = far;
    this.camera.updateProjectionMatrix();
  }

  /** The map's own vertical field of view, in degrees; the boost widens from it and eases back to it. */
  setFov(degrees: number): void {
    if (!(degrees > 1 && degrees < 179)) return;
    this.restFov = degrees;
    this.fov = degrees;
    this.camera.fov = degrees;
    this.camera.updateProjectionMatrix();
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** The wheel's speed trim, for the page's hint line. */
  multiplier(): number {
    return this.speedMultiplier;
  }

  /** Whether the mouse is currently captured. */
  isLocked(): boolean {
    return this.locked;
  }

  /** Stand at `from` (game units) and face `to`. */
  lookFrom(from: readonly [number, number, number], to: readonly [number, number, number]): void {
    const [dx, dy, dz] = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const flat = Math.hypot(dx, dz);
    this.setPose({
      x: from[0], y: from[1], z: from[2],
      yaw: MathUtils.radToDeg(Math.atan2(-dx, -dz)),   // the camera looks down its own -z
      pitch: MathUtils.radToDeg(Math.atan2(dy, flat)),
    });
  }

  /**
   * Place the camera exactly. Velocity and the FOV kick are cleared: a pose set by the debug hook has
   * to be the pose the next frame renders, or the screenshot tests would photograph a camera still
   * gliding out of its previous one.
   */
  setPose(pose: Partial<Pose>): void {
    const now = this.pose();
    this.camera.position.set(pose.x ?? now.x, pose.y ?? now.y, pose.z ?? now.z);
    this.yaw = MathUtils.degToRad(pose.yaw ?? now.yaw);
    this.pitch = this.clampPitch(MathUtils.degToRad(pose.pitch ?? now.pitch));
    this.velocity.set(0, 0, 0);
    this.fov = this.restFov;
    this.camera.fov = this.restFov;
    this.camera.updateProjectionMatrix();
    this.apply();
  }

  pose(): Pose {
    const p = this.camera.position;
    return { x: p.x, y: p.y, z: p.z, yaw: MathUtils.radToDeg(this.yaw), pitch: MathUtils.radToDeg(this.pitch) };
  }

  /**
   * Walk mode on or off. On, `update` still turns the view (the mouse, the arrow keys) and eases the boost's FOV,
   * but no longer moves the camera: the keys and the stick are read by the walk through `groundWish`, and the walk
   * places the view with `placeView` (the mouse's y then moves the pitch at the pad's ratio, clamped to
   * `setPitchLimits`). Either way the glide is dropped, and so is any boost armed: a W double-tapped or a stick held at
   * its rim must not carry across the switch (the walk has none, and flying starts unboosted).
   */
  setWalking(on: boolean): void {
    this.walking = on;
    this.velocity.set(0, 0, 0);
    this.sprinting_ = false;
    this.lastForwardTap = 0;
    this.stickBoost = false;
    this.law.reset();
    this.turnRate = 0;
    if (!on) {
      this.setScreenOffset(0, 0);
      this.walkPitch = [-PITCH_LIMIT, PITCH_LIMIT];
      this.apply();                                  // a third-person view leaves the look where yaw and pitch put it
    }
  }

  /**
   * Walking, the camera's pitch limits in degrees (`playerCamera.ts`'s `pitchLimits`: -70..60, prone -20..25). A pitch
   * outside new limits (a stance change) is not clamped: `update` brings it back at the game's 0.5 rad/s
   * (`FUN_00594600`). Flying they are the fly camera's own, just short of straight up and down.
   */
  setPitchLimits(minDegrees: number, maxDegrees: number): void {
    if (!this.walking) return;
    this.walkPitch = [MathUtils.degToRad(minDegrees), MathUtils.degToRad(maxDegrees)];
  }

  // ---- The look law's controls (web research 83; `./look`) ---------------------------------------------------------

  /** The mouse's mapping and the look's options (`LookOptions`); they act while walking. */
  setLookOptions(opts: Partial<LookOptions>): void {
    this.law.setOptions(opts);
  }

  lookOptions(): LookOptions {
    return this.law.options();
  }

  /**
   * The scope's magnification (the weapon's `ZoomModeN`, 1 unscoped; `mode4` the 9x view): the look divides by it, and
   * the bob's phase slows by 0.2 (`FUN_005966a0`). The first-person aim view is not a scope: 1.
   */
  setZoom(magnification: number, mode4 = false): void {
    this.law.setZoom(magnification, mode4);
    this.scoped = magnification > 1.01 || mode4;
  }

  /** The body the look rides (the bob's inputs): first person or not, prone or not. `main.ts` sets it each frame. */
  setBody(firstPerson: boolean, prone: boolean): void {
    this.firstPerson = firstPerson;
    this.prone = prone;
  }

  /** A screen shake (`./look`: `explosionShake`, `MACHINE_GUN_SHAKE`, a weapon's `ScreenShake`); walking only. */
  shakeScreen(shake: Shake): void {
    if (this.walking) this.shake.start(shake);
  }

  /**
   * The walk's look for the body (`LookState`, `./look`): the look's yaw and the body's -- the same in SOCOM II --
   * the pitch, the turn rate and the axes, and the screen offset drawn.
   */
  lookState(): LookState {
    const yaw = MathUtils.radToDeg(this.yaw);
    return {
      lookYaw: yaw, bodyYaw: yaw, pitch: MathUtils.radToDeg(this.pitch), turnRate: this.turnRate,
      axis: this.law.axis(), turning: this.turnRate !== 0, screen: [...this.screen],
    };
  }

  /**
   * How far the screen offset moved the picture, as fractions of the frame (x right, y down): the reticle, a HUD
   * element, stays where it was while the world shifts under it (`main.ts` takes this off the projected aim point).
   */
  screenShift(): [number, number] {
    const [ox, oy] = viewOffset(this.screen[0], this.screen[1]);
    return [-ox / (this.camera.aspect * SCREEN.height), -oy / SCREEN.height];
  }

  /**
   * Walking, where the page puts the view (W2.1): the eye, and the target it looks at with no roll -- `FUN_0029bc90`'s
   * placement, which is three's `lookAt` with y up -- or with no target, the look yaw and pitch give (first person).
   * The yaw and pitch themselves are untouched: they are the body's turn and the camera's pitch.
   */
  placeView(eye: readonly [number, number, number], target: readonly [number, number, number] | null): void {
    this.camera.position.set(eye[0], eye[1], eye[2]);
    if (target) this.camera.lookAt(target[0], target[1], target[2]);
    else this.apply();
  }

  /** Stand the camera at a point without touching the look, the FOV or anything else `setPose` resets. */
  moveTo(x: number, y: number, z: number): void {
    this.camera.position.set(x, y, z);
  }

  /**
   * The ground-plane half of what `update` would steer by: W/S and the stick's y forward, D/A and the stick's x to
   * the right, clamped into the unit disc as `update` clamps. The boost (a double-tapped W held, or the stick held at
   * its rim) is the fly camera's: on the ground it is never on. Space and shift have no meaning on the ground.
   */
  groundWish(): GroundWish {
    let forward = this.stickY + (this.keys.has('keyw') ? 1 : 0) - (this.keys.has('keys') ? 1 : 0);
    let right = this.stickX + (this.keys.has('keyd') ? 1 : 0) - (this.keys.has('keya') ? 1 : 0);
    const length = Math.hypot(forward, right);
    if (length > 1) { forward /= length; right /= length; }
    return { forward, right, boost: false };
  }

  /**
   * One frame of movement. `dt` is seconds, so held keys move the same distance on any refresh rate,
   * and the exponential approach below is sampled rather than iterated — 30 fps and 240 fps land the
   * camera in the same place.
   */
  update(dt: number): void {
    if (dt <= 0) return;

    // The arrow keys turn at a steady rate; a frame's worth here, before the frame's forward is taken. A pad's right
    // stick (W2.7) turns at the same rate scaled by its push, and on each axis the larger of the two is taken.
    // Walking, they are the pad's full axis: `turn_maxrate` and `pitch_rate` radians a second (W2.1).
    const arrowTurn = (this.keys.has('arrowleft') ? 1 : 0) - (this.keys.has('arrowright') ? 1 : 0);
    const arrowTilt = (this.keys.has('arrowup') ? 1 : 0) - (this.keys.has('arrowdown') ? 1 : 0);
    if (this.walking) this.walkLook(dt, arrowTurn, arrowTilt);
    else {
      const turn = Math.abs(this.lookX) > Math.abs(arrowTurn) ? -this.lookX : arrowTurn;
      const tilt = Math.abs(this.lookY) > Math.abs(arrowTilt) ? this.lookY : arrowTilt;
      if (turn !== 0 || tilt !== 0) {
        this.yaw += turn * ARROW_LOOK * dt;
        this.pitch = this.clampPitch(this.pitch + tilt * ARROW_LOOK * dt);
        this.apply();
      }
    }

    // Forward carries the pitch; right is taken from the yaw alone so strafing stays level.
    const forward = new Vector3(0, 0, -1).applyEuler(this.camera.rotation);
    const right = new Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    const wish = new Vector3();
    // The touch stick, before the keys: it is an analogue pair on the same two axes, so it adds to the
    // same wish vector and everything below -- the ramp, the glide, the frame-rate independence -- is
    // the keys' own model doing the work.
    if (this.stickX !== 0 || this.stickY !== 0) {
      wish.addScaledVector(forward, this.stickY);
      wish.addScaledVector(right, this.stickX);
    }
    if (this.lift !== 0) wish.y += this.lift;
    if (this.keys.has('keyw')) wish.add(forward);
    if (this.keys.has('keys')) wish.sub(forward);
    if (this.keys.has('keyd')) wish.add(right);
    if (this.keys.has('keya')) wish.sub(right);
    if (this.keys.has('space') || this.keys.has('keye')) wish.y += 1;
    if (this.down() || this.keys.has('keyq')) wish.y -= 1;

    const moving = wish.lengthSq() > 0;
    // The walk has no boost (W2.R2: the game's run is 65 and nothing faster), so neither has its field of view.
    const boosting = !this.walking && moving && (this.sprinting() || (this.stickBoost && (this.stickX !== 0 || this.stickY !== 0)));
    const cruise = this.speed * this.speedMultiplier * (boosting ? SPRINT : 1);
    // One key or three, the speed is the same: clamping stops diagonals being 1.7x faster. It *clamps*
    // rather than normalises so that a stick pushed half way moves at half speed -- with keys the
    // vector is always at least unit length, so they are unaffected.
    if (wish.lengthSq() > 1) wish.normalize();
    const target = moving ? wish.multiplyScalar(cruise) : new Vector3();

    // v(t) = target + (v0 - target)e^(-rate t). Both the new velocity and the distance covered during
    // the frame are taken from that closed form rather than from `v * dt` at one end of it: stepping a
    // curve with a rectangle would make the distance depend on the frame length, and the camera would
    // quietly cover less ground on a 240 Hz monitor than on a 30 Hz one.
    const rate = moving ? ACCEL : BRAKE;
    const x = glide(this.velocity.x, target.x, rate, dt);
    const y = glide(this.velocity.y, target.y, rate, dt);
    const z = glide(this.velocity.z, target.z, rate, dt);
    if (!this.walking) {
      this.camera.position.set(this.camera.position.x + x.moved, this.camera.position.y + y.moved, this.camera.position.z + z.moved);
      this.velocity.set(x.velocity, y.velocity, z.velocity);
    }

    // Below a millimetre a second the glide is over; snapping to zero keeps a released key from
    // leaving the camera creeping forever and keeps `update` cheap when nothing is happening.
    if (!moving && this.velocity.lengthSq() < 1e-4) this.velocity.set(0, 0, 0);

    const fovTarget = boosting ? this.restFov * SPRINT_FOV : this.restFov;
    if (Math.abs(this.fov - fovTarget) > 1e-3) {
      this.fov = approach(this.fov, fovTarget, FOV_RATE, dt);
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * The touch stick, as an axis pair rather than as keys. Nothing is clamped here -- `./touch` has
   * already put the vector inside the unit disc, and `update` clamps anyway.
   */
  setStick(x: number, y: number): void {
    this.stickX = x;
    this.stickY = y;
  }

  /** The touch up/down buttons: 1 up, -1 down, 0 released. */
  setLift(v: number): void {
    this.lift = v;
  }

  /** The stick held at its rim: boosts while the stick is pushed, the way a double-tapped W does. */
  setStickBoost(on: boolean): void {
    this.stickBoost = on && !this.walking;      // no sprint on foot
  }

  /**
   * A pad's right stick (`./gamepad`, W2.7): x right, y up, in the unit disc. It turns the view at the arrow keys'
   * `ARROW_LOOK` scaled by the push, in walk mode as in fly, and moves nothing.
   */
  setLook(x: number, y: number): void {
    this.lookX = x;
    this.lookY = y;
  }

  /**
   * Walking, one frame of the game's look: the right stick -- the push as the pad itself gave it, `./gamepad`'s radial
   * 0.15 dead zone and rescale undone so the game's own 0.3 per axis is the only one -- or the arrow keys, a full
   * push, the larger on each axis; the look law's rates; the pitch stepped (`stepPitch`); then the screen shake and
   * the first-person bob, as a view offset.
   */
  private walkLook(dt: number, arrowTurn: number, arrowTilt: number): void {
    const push = Math.hypot(this.lookX, this.lookY);
    const raw = push > 0 ? (PAD_DEAD_ZONE + (1 - PAD_DEAD_ZONE) * Math.min(1, push)) / push : 0;
    const padX = this.lookX * raw, padY = this.lookY * raw;
    const x = Math.abs(padX) > Math.abs(arrowTurn) ? padX : -arrowTurn;
    const y = Math.abs(padY) > Math.abs(arrowTilt) ? padY : arrowTilt;
    const rates = this.law.frame(dt, x, y);
    this.turnRate = rates.yaw;
    const pitch = stepPitch(this.pitch, rates.pitch, dt, this.walkPitch[0], this.walkPitch[1]);
    if (rates.yaw !== 0 || pitch !== this.pitch) {
      this.yaw += rates.yaw * dt;
      this.pitch = pitch;
      this.apply();
    }
    const [sx, sy] = this.shake.step(dt);
    const wish = this.groundWish(), slow = this.scoped ? 0.2 : 1;
    const bob = this.firstPerson ? this.bob.step(dt, wish.right * slow, wish.forward * slow, this.prone) : 0;
    this.setScreenOffset(sx, sy + bob);
  }

  /** The PS2 screen offset (`./look`, `viewOffset`) on the camera, or none. */
  private setScreenOffset(x: number, y: number): void {
    this.screen = [x, y];
    if (x === 0 && y === 0) {
      if (this.camera.view?.enabled) this.camera.clearViewOffset();
      return;
    }
    const [ox, oy] = viewOffset(x, y);
    const w = this.camera.aspect * SCREEN.height;
    this.camera.setViewOffset(w, SCREEN.height, ox, oy, w, SCREEN.height);
  }

  /** Double-tapped forward, still held. Released, the sprint ends. */
  private sprinting(): boolean {
    return this.sprinting_ && this.keys.has('keyw');
  }

  private down(): boolean {
    return this.keys.has('shiftleft') || this.keys.has('shiftright');
  }

  private apply(): void {
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  private look(dx: number, dy: number): void {
    if (this.walking) {
      // The viewer's mouse mapping (`LookLaw.mouse`): raw angles now, or counts kept for the stick law's frame.
      const [yaw, pitch] = this.law.mouse(dx, dy);
      if (yaw === 0 && pitch === 0) return;
      this.yaw += yaw;
      this.pitch = nudgePitch(this.pitch, pitch, this.walkPitch[0], this.walkPitch[1]);
      this.apply();
      return;
    }
    this.yaw -= dx * LOOK;
    this.pitch = this.clampPitch(this.pitch - dy * LOOK);
    this.apply();
  }

  private clampPitch(pitch: number): number {
    return this.walking ? MathUtils.clamp(pitch, this.walkPitch[0], this.walkPitch[1]) : MathUtils.clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /**
   * A click captures the mouse. `requestPointerLock` rejects on a page that has not been interacted
   * with and is absent altogether in some headless configurations, so a failure quietly leaves us on
   * the drag path rather than breaking the viewer.
   */
  private readonly onPointerDown = (e: PointerEvent): void => {
    // Without this a drag across the canvas selects the panel's text and the page flashes blue.
    e.preventDefault();
    // A click on a checkbox leaves it focused, and `onKeyDown` ignores anything aimed at an input --
    // so without this, touching any panel control killed WASD until the page was reloaded. The canvas
    // has no tabindex and never takes focus by itself, so the focus is dropped by hand.
    const focused = globalThis.document?.activeElement;
    if (focused instanceof HTMLElement && focused !== this.canvas) focused.blur();
    if (this.locked) {
      if (e.button === 0) { this.triggerHeld = true; this.options.onFire?.(true); }
      return;
    }
    if (e.pointerType === 'mouse' && typeof this.canvas.requestPointerLock === 'function') {
      // Raw mouse input where the browser offers it: the OS's pointer acceleration is for a cursor,
      // not for a look, and Chrome lets a page ask for the unadjusted movement. A browser that does
      // not know the option (or a Firefox that rejects it) gets the plain request instead.
      try {
        const lock = this.canvas.requestPointerLock as (options?: { unadjustedMovement?: boolean }) => unknown;
        const r = lock.call(this.canvas, { unadjustedMovement: true });
        if (r instanceof Promise) r.catch(() => { try { this.canvas.requestPointerLock(); } catch { /* dragging */ } });
      } catch {
        try { this.canvas.requestPointerLock(); } catch { /* fall through to dragging */ }
      }
    }
    if (this.dragging !== null) return;
    this.dragging = e.pointerId;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.canvas.setPointerCapture(e.pointerId);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (this.locked) {
      this.look(e.movementX ?? 0, e.movementY ?? 0);
      return;
    }
    if (this.dragging !== e.pointerId) return;
    const k = e.pointerType === 'touch' ? TOUCH_LOOK : 1;
    this.look((e.clientX - this.lastX) * k, (e.clientY - this.lastY) * k);
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.button === 0) this.letGo();
    if (this.dragging !== e.pointerId) return;
    this.dragging = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
  };

  private readonly onLockChange = (): void => {
    this.locked = globalThis.document?.pointerLockElement === this.canvas;
    if (!this.locked) this.letGo();
    if (this.locked && this.dragging !== null) {
      // The click that took the lock also started a drag; the lock owns the look from here.
      if (this.canvas.hasPointerCapture(this.dragging)) this.canvas.releasePointerCapture(this.dragging);
      this.dragging = null;
    }
    this.options.onLockChange?.(this.locked);
  };

  /** The trigger let go, once, if it was held (`onFire`). */
  private letGo(): void {
    if (!this.triggerHeld) return;
    this.triggerHeld = false;
    this.options.onFire?.(false);
  }

  private readonly onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  /** The wheel trims the fly speed, the way every build camera does. */
  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const step = e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
    this.speedMultiplier = MathUtils.clamp(this.speedMultiplier * step, SPEED_MIN, SPEED_MAX);
    this.options.onSpeedChange?.(this.speedMultiplier);
  };

  /** `code`, not `key`: WASD stays where it is on an AZERTY keyboard, and shift does not rename letters. */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLElement && (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT')) return;
    const code = e.code.toLowerCase();
    if (OWNED.has(code)) e.preventDefault();

    if (code === 'keyw' && !this.keys.has('keyw') && !this.walking) {   // the press, not the auto-repeat; no sprint on foot
      const now = performance.now();
      this.sprinting_ = now - this.lastForwardTap < DOUBLE_TAP_MS;
      this.lastForwardTap = now;
    }
    this.keys.add(code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    const code = e.code.toLowerCase();
    if (code === 'keyw') this.sprinting_ = false;
    this.keys.delete(code);
  };

  /**
   * A key held while the page loses focus never sends its keyup, and the camera would drift forever.
   * The velocity goes too, or blurring mid-flight would leave it coasting behind a dead tab.
   */
  private readonly onBlur = (): void => {
    this.letGo();
    this.keys.clear();
    this.velocity.set(0, 0, 0);
    this.sprinting_ = false;
  };
}
