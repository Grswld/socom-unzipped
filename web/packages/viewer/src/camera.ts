import { MathUtils, PerspectiveCamera, Vector3 } from 'three';

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

/**
 * How fast velocity chases the stick, per second, as the exponent of an exponential approach.
 * Pressing a key reaches ~99% of cruise in 3/ACCEL seconds; releasing it coasts for about 3/BRAKE.
 * Braking is slower than accelerating, which is what gives creative-mode flight its glide: you stop
 * over roughly a third of a second rather than on the frame the key comes up.
 */
const ACCEL = 14;
const BRAKE = 8;

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
 * the viewer has the keyboard.
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
    this.pitch = MathUtils.clamp(MathUtils.degToRad(pose.pitch ?? now.pitch), -PITCH_LIMIT, PITCH_LIMIT);
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
   * One frame of movement. `dt` is seconds, so held keys move the same distance on any refresh rate,
   * and the exponential approach below is sampled rather than iterated — 30 fps and 240 fps land the
   * camera in the same place.
   */
  update(dt: number): void {
    if (dt <= 0) return;

    // The arrow keys turn at a steady rate; a frame's worth here, before the frame's forward is taken.
    const turn = (this.keys.has('arrowleft') ? 1 : 0) - (this.keys.has('arrowright') ? 1 : 0);
    const tilt = (this.keys.has('arrowup') ? 1 : 0) - (this.keys.has('arrowdown') ? 1 : 0);
    if (turn !== 0 || tilt !== 0) {
      this.yaw += turn * ARROW_LOOK * dt;
      this.pitch = MathUtils.clamp(this.pitch + tilt * ARROW_LOOK * dt, -PITCH_LIMIT, PITCH_LIMIT);
      this.apply();
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
    const boosting = moving && (this.sprinting() || (this.stickBoost && (this.stickX !== 0 || this.stickY !== 0)));
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
    const decay = Math.exp(-rate * dt);
    const integral = (1 - decay) / rate;            // ∫e^(-rate t) dt over the frame
    const step = (v: number, t: number): number => t * dt + (v - t) * integral;

    this.camera.position.set(
      this.camera.position.x + step(this.velocity.x, target.x),
      this.camera.position.y + step(this.velocity.y, target.y),
      this.camera.position.z + step(this.velocity.z, target.z),
    );
    this.velocity.set(
      target.x + (this.velocity.x - target.x) * decay,
      target.y + (this.velocity.y - target.y) * decay,
      target.z + (this.velocity.z - target.z) * decay,
    );

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
    this.stickBoost = on;
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
    this.yaw -= dx * LOOK;
    this.pitch = MathUtils.clamp(this.pitch - dy * LOOK, -PITCH_LIMIT, PITCH_LIMIT);
    this.apply();
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
    if (this.locked) return;
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
    if (this.dragging !== e.pointerId) return;
    this.dragging = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
  };

  private readonly onLockChange = (): void => {
    this.locked = globalThis.document?.pointerLockElement === this.canvas;
    if (this.locked && this.dragging !== null) {
      // The click that took the lock also started a drag; the lock owns the look from here.
      if (this.canvas.hasPointerCapture(this.dragging)) this.canvas.releasePointerCapture(this.dragging);
      this.dragging = null;
    }
    this.options.onLockChange?.(this.locked);
  };

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

    if (code === 'keyw' && !this.keys.has('keyw')) {          // the press, not the auto-repeat
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
    this.keys.clear();
    this.velocity.set(0, 0, 0);
    this.sprinting_ = false;
  };
}
