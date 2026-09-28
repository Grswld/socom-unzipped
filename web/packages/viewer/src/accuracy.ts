import type { WeaponRecord, WeaponStance, WeaponStanceName } from '@s2u/scene';

/**
 * The gunplay of SOCOM II's rifle, ported (research 84): the reticle's size (the bloom), its climb (the knock), where a
 * round goes inside it (the cone), the scoped kick and sway, and the fire modes. Pure: no three, no DOM; the page
 * (`main.ts`) feeds it the mover each frame and `fire.ts` asks it for each round. All from `CZKit` (the soldier's kit,
 * at body `+0x5e0`) in `socom2_game.elf.decomp.c`, cited by address:
 *
 * - **The size** (`kit+0x84c`, PS2 pixels of the 640x448 frame): each 60 Hz tick `FUN_005c2670` computes a target
 *   `|v|^2 / 65 x TargetDilateUponMovementMult + 158.7 x (turn rate^2 + pitch rate^2)` (the body's velocity in
 *   units a second, `+0x2c`; its angular velocity `+0x44` and pitch rate `+0x60` in radians a second; 158.7 =
 *   5.29 x 30), clamped to `[TargetMin, TargetMax]`; the size opens toward it by `TargetDilateUponMovement` a tick
 *   and closes by `TargetConstrict` a second. A round (`FUN_005c3360`) opens it by `TargetDilateUponFire x (1 + s)`,
 *   `s` the burst's accuracy scalar.
 * - **The knock** (`kit+0x20/+0x24`, pixels): a round moves the whole reticle **up** by `ReticuleKnock` (the
 *   `KnockCount`-th round of a pull by `ReticuleKnock x KnockEntryStrength`, earlier rounds not at all), capped at
 *   `ReticuleKnockMax`; it comes back at `ReticuleKnockReturn` a second. The HUD draws the reticle there
 *   (`FUN_00216770`: centre = (320, 224) + the offset) and the rounds go there (`FUN_005bd100`). The camera does not move.
 * - **The cone** (`FUN_005bd100`, `FUN_00592260`): the size and the knock become tangents -- `size x 0.707 x
 *   tan(tan(hfov) x 448/640) / 224` -- and a round's direction is `dir + right x (ox + r x s1) + up x (oy + r x s2)`,
 *   `s = u|u|` for `u` uniform in [-1, 1): a square, densest at its centre, its corners on the reticle's circle.
 * - **Scoped** (view state >= 4): no bloom and no knock; the cone is a point, moved by the sway (`SniperDist*`); a
 *   second round of a pull drops the scope back to first person (`FUN_005c5340`). The first round kicks the aim pitch
 *   (`FireRifleKick*`) -- **only scoped**: `FUN_005c5340` calls the kick's start `FUN_005b91c0` only when
 *   `body+0x200 > 4` and the pull's count is under 2, and `FUN_00550ef0` runs its tick `FUN_005b9280` only when
 *   `FUN_005b9990 || FUN_005b90f0` (state >= 4). The kick itself is the WEAPON workstream's `rifleKick.ts`; this file
 *   gives it its gate (`kickStarts`, `kickTicks`). Unscoped the camera never moves: the recoil is the reticle's climb.
 */

/** The game's tick: the per-tick terms (`TargetDilateUponMovement`, the kick's stick term) are per 1/60 s. */
export const TICK = 1 / 60;
/** The frame the reticle's pixels are pixels of (`DAT_004a44c4` x `DAT_004a44c8`, set to 0x280 x 0x1c0 by `FUN_003b1200`). */
export const PS2_FRAME = { width: 640, height: 448 } as const;
/** `FUN_005c2670`: the speed term's divisor, `0.015384615` = 1/65. */
export const MOVE_DIVISOR = 65;
/** `FUN_005c2670`: the turn terms' factor, 5.29 x 30. */
export const TURN_FACTOR = 5.29 * 30;
/** `FUN_005bd100`: the radius is the size times 0.707 (the square's half side, its corner on the circle). */
export const RADIUS_FACTOR = 0.707;

/** `FUN_005c5340`: a round starts the scoped kick when the view is a scope (state > 4) and it is the pull's first. */
export function kickStarts(zoomState: number, roundOfPull: number): boolean {
  return zoomState > 4 && roundOfPull < 2;
}

/** `FUN_00550ef0` -> `FUN_005b9280`: the kick (and the sway) tick only in the 9x view or a scope (state >= 4). */
export function kickTicks(zoomState: number): boolean {
  return zoomState >= 4;
}

type Vec3 = [number, number, number];

/** What the model reads of the mover and the view each frame. Angles in radians, speeds in units a second. */
export interface AccuracyInput {
  stance: WeaponStanceName;
  /** The body's velocity, units a second (`m_velM`, `+0x2c`): its length is what counts. */
  velocity: Vec3;
  /** In the air: the carried velocity counts again (`+0x1350`, while `+0x105e` bit 5) [reading: the airborne bit]. */
  airborne: boolean;
  /** Turn rate and pitch rate, radians a second (`+0x44..+0x4c` and `+0x60`). */
  yawRate: number;
  pitchRate: number;
  /** The view state (`body+0x200`; `./zoom`). */
  zoomState: number;
}

/** A round's aim error, tangents (`body+0x5d4/+0x5d8/+0x5dc`): the offset of the reticle and the cone's half side. */
export interface Cone { offsetX: number; offsetY: number; radius: number }

/** The frame's field of view the tangents are taken from: the map camera's half-angles, radians. */
export interface Fov { hfov: number; vfov: number }
/** Every map's `cameras/camera fov (0.6109 0.4276)` (research 72; `camera.ts`). */
export const MAP_FOV: Fov = { hfov: 0.6109, vfov: 0.4276 };

/**
 * `FUN_005bd100`'s pixel-to-tangent factors. `camera+0x290` is `(W/2) / tan(hfov)` (`FUN_002915f0`), so `W / it` is
 * `2 tan(hfov)`; the game then takes `tanf` of half of that as if it were an angle -- `tan(tan(hfov))` -- and divides
 * by the half frame. Faithful, quirk and all: the cone is ~1.2x the reticle it is drawn as.
 */
export function tangentPerPixel(fov: Fov = MAP_FOV): { x: number; y: number } {
  const w = 2 * Math.tan(fov.hfov);                          // fVar14 = W / cam+0x290
  const h = (w * PS2_FRAME.height) / PS2_FRAME.width;        // fVar12
  return { x: Math.tan(w * 0.5) / (PS2_FRAME.width / 2), y: Math.tan(h * 0.5) / (PS2_FRAME.height / 2) };
}

/**
 * The burst's accuracy scalar for the `count`-th round of a pull (`FUN_005c3360`): `n = count + 1 - AccBurstCnt_Min`,
 * 0 when not positive, else `min(n, AccBurstCnt_Max) x (AccScalar_Max - AccScalar_Min) / (AccBurstCnt_Max - AccBurstCnt_Min)`
 * (the slope `FUN_003c62b0` keeps at weapon `+0x278`; the cap is on `n`, not on `n`'s span -- the game's).
 */
export function burstScalar(weapon: WeaponRecord, count: number): number {
  const { countMin, countMax, scalarMin, scalarMax } = weapon.accuracyBurst;
  const span = countMax - countMin;
  const slope = span !== 0 ? (scalarMax - scalarMin) / span : 0;
  let n = count + 1 - countMin;
  if (n <= 0) return 0;
  if (countMax < n) n = countMax;
  return n * slope;
}

/** The movement size `FUN_005c2670` aims the reticle at, before the stance's clamp. */
export function movementSize(stance: WeaponStance, input: Pick<AccuracyInput, 'velocity' | 'airborne' | 'yawRate' | 'pitchRate'>): number {
  const [vx, vy, vz] = input.velocity;
  const v2 = vx * vx + vy * vy + vz * vz;
  let size = (v2 / MOVE_DIVISOR) * stance.dilateMoveMult
    + TURN_FACTOR * input.yawRate * input.yawRate + TURN_FACTOR * input.pitchRate * input.pitchRate;
  if (input.airborne) size += (vx * vx + vz * vz) / MOVE_DIVISOR;
  return size;
}

/**
 * `FUN_00592260`: the round's direction off `dir` by the cone. The axes are the game's, unnormalised: right =
 * dir x (0, 1, 0), up = right x dir (both cos(pitch) long for a unit `dir`); the result is not renormalised by the
 * game -- the caller normalises it for the ray. `random` is `rand()`/2^31, [0, 1).
 */
export function perturb(dir: Vec3, cone: Cone, random: () => number = Math.random): Vec3 {
  const [dx, dy, dz] = dir;
  const right: Vec3 = [-dz, 0, dx];                                            // dir x (0,1,0)
  const up: Vec3 = [right[1] * dz - right[2] * dy, right[2] * dx - right[0] * dz, right[0] * dy - right[1] * dx];
  const signedSquare = (): number => { const u = random() * 2 - 1; return u < 0 ? -(u * u) : u * u; };
  const a = cone.offsetX + cone.radius * signedSquare();
  const b = cone.offsetY + cone.radius * signedSquare();
  return [dx + right[0] * a + up[0] * b, dy + right[1] * a + up[1] * b, dz + right[2] * a + up[2] * b];
}

// ---- The fire modes (research 84 §6) --------------------------------------------------------------------------------

/** Rounds a trigger pull may fire in a mode (`FUN_005c0940`): single 1, burst 3, automatic 10,000, none 0. */
export function roundsPerPull(mode: number): number {
  if (mode === 0) return 0;
  if (mode === 2) return 3;
  if (mode === 3) return 10000;
  return 1;
}

/** The wait after a round in a mode (`FUN_005c09f0`): `FireWait`, x 0.8 in burst and automatic (1 s in mode 0). */
export function fireInterval(fireWait: number, mode: number): number {
  if (mode === 0) return 1;
  return mode === 2 || mode === 3 ? fireWait * 0.8 : fireWait;
}

/**
 * The fire-mode switch (`FUN_005c4600`, L3 on the pad): the next mode up, past `maxFireMode` back to single, skipping a
 * mode the weapon does not enable. Refused while scoped (the switch reads the zoom and acts only at 1.01 or less):
 * the caller passes `scoped`.
 */
export function nextFireMode(weapon: WeaponRecord, mode: number, scoped = false): number {
  if (scoped || weapon.fireModes.length === 0) return mode;
  let m = mode;
  for (let i = 0; i < 4; i++) {
    m = m + 1 > weapon.maxFireMode ? 1 : m + 1;
    if (weapon.fireModes.includes(m)) return m;
  }
  return mode;
}

/** The mode a weapon comes up in (`FUN_005c0fd0`: cycled until it is `MaxFireMode`): automatic on the M4A1s. */
export function defaultFireMode(weapon: WeaponRecord): number {
  return weapon.fireModes.includes(weapon.maxFireMode) ? weapon.maxFireMode : (weapon.fireModes[0] ?? 0);
}

export const FIRE_MODE_NAMES: Record<number, string> = { 0: 'SAFE', 1: 'SEMI', 2: 'BURST', 3: 'AUTO' };

// ---- The model ------------------------------------------------------------------------------------------------------

/** What a round did to the view: the scope dropped (a second round scoped), the scoped kick started (`kickStarts`). */
export interface RoundOutcome { dropZoom: boolean; kick: boolean }

export interface AccuracyState {
  /** The reticle's size, pixels (`kit+0x84c`), and the movement target it moves toward (`kit+0x86c`). */
  size: number; target: number;
  /** The knock's offset of the reticle, pixels, y down (`kit+0x20`, `kit+0x24`). */
  offset: [number, number];
  /** The scoped sway, pixels (`kit+0x28`, `kit+0x2c`). */
  sway: [number, number];
  /** Rounds fired in the current pull (`kit+0x818`). */
  burst: number;
}

export class Accuracy {
  private size = 0;
  private target = 0;
  private offX = 0;
  private offY = 0;
  private swayX = 0;
  private swayY = 0;
  /** The sway's signed rates: the game flips `SniperDistPPFrame*` in the weapon's own table at each end. */
  private swayRate: Record<WeaponStanceName, [number, number]>;
  private burst = 0;
  private stance: WeaponStanceName = 'stand';
  private carry = 0;

  constructor(private weapon: WeaponRecord, private fov: Fov = MAP_FOV) {
    this.swayRate = this.rates();
    this.size = weapon.stances.stand.targetMin;
  }

  setWeapon(weapon: WeaponRecord): void {
    this.weapon = weapon;
    this.swayRate = this.rates();
    this.reset();
  }

  setFov(fov: Fov): void { this.fov = fov; }

  /** A new life or a new map: at rest. */
  reset(): void {
    this.size = this.weapon.stances[this.stance].targetMin;
    this.target = this.size;
    this.offX = this.offY = this.swayX = this.swayY = 0;
    this.burst = 0;
    this.carry = 0;
  }

  /** The trigger pressed or let go: the pull's round count starts again (`FUN_005c0ae0`: trigger up or rising). */
  trigger(): void { this.burst = 0; }

  /** Rounds fired since the trigger was pressed. */
  rounds(): number { return this.burst; }

  /** One frame of `dt` seconds: the 60 Hz ticks it holds (`FUN_005c2670`, and scoped `FUN_005b9280`'s sway). */
  update(dt: number, input: AccuracyInput): void {
    this.stance = input.stance;
    this.carry += dt;
    let ticks = 0;
    while (this.carry >= TICK - 1e-9 && ticks < 30) { this.carry -= TICK; ticks++; this.tick(TICK, input); }
    if (ticks >= 30) this.carry = 0;
  }

  /** One 60 Hz tick. */
  tick(dt: number, input: AccuracyInput): void {
    const s = this.weapon.stances[input.stance];
    // FUN_005c2670: the floor, the knock's return, the movement target, the size toward it.
    if (this.size < s.targetMin) this.size = s.targetMin;
    const back = s.knockReturn * dt;
    if (this.offX > 0) this.offX = Math.max(0, this.offX - back);
    else if (this.offX < 0) this.offX = Math.min(0, this.offX + back);
    if (this.offY > 0) this.offY = Math.max(0, this.offY - back);
    else if (this.offY < 0) this.offY = Math.min(0, this.offY + back);
    this.target = Math.min(Math.max(Math.min(movementSize(s, input), s.targetMax), s.targetMin), s.targetMax);
    if (this.size < this.target) this.size = Math.min(this.size + s.dilateMove, this.target);
    else if (this.size > this.target) this.size = Math.max(this.size - s.constrict * dt, this.target);
    // FUN_005b9280: only while scoped (`FUN_005b9990` || `FUN_005b90f0`: view state >= 4).
    if (kickTicks(input.zoomState)) this.sway(dt, s, input);
  }

  private sway(dt: number, s: WeaponStance, input: AccuracyInput): void {
    // The sway (DAT_00650940 = 1), at full steadiness (`body+0xeb0` = 1: the limit is the whole SniperDistLimit).
    const rate = this.swayRate[input.stance];
    const step = (pos: number, limit: number, axis: 0 | 1): number => {
      if (limit === 0) return pos;
      const pp = rate[axis];
      let p = pos + dt * ((pp + 0.75) * Math.abs(pos / limit) + pp + 0.25);
      if (p > limit) { rate[axis] = -pp; p = limit; } else if (p < -limit) { rate[axis] = -pp; p = -limit; }
      return p;
    };
    this.swayX = step(this.swayX, s.swayLimitX, 0);
    this.swayY = step(this.swayY, s.swayLimitY, 1);
  }

  /**
   * A round leaves (`FUN_005c5340` then `FUN_005c3360`): the pull's count goes up; scoped, the first round kicks
   * (`kick`, for `rifleKick.ts`) and a later one drops the scope; unscoped, the knock and the bloom. The round itself
   * goes by the cone as it stood before this call (`FUN_005bd100` runs in the frame, before the shot).
   */
  round(zoomState: number, stance: WeaponStanceName): RoundOutcome {
    const s = this.weapon.stances[stance];
    this.burst++;
    const kick = kickStarts(zoomState, this.burst);
    const dropZoom = zoomState > 4 && !kick;                 // FUN_005448a0(body, 1)
    if (zoomState < 5 && zoomState !== 4) {
      if (this.burst === s.knockCount) this.offY -= s.knock * s.knockEntry;
      else if (s.knockCount < this.burst) this.offY -= s.knock;
      // The clamps: ReticuleKnockMax x the camera's projection scale (1 unzoomed; the aim-to-muzzle parallax, ~1, is 1).
      this.offY = Math.min(Math.max(this.offY, -s.knockMax), s.knockMax);
      this.offX = Math.min(Math.max(this.offX, -s.knockMax), s.knockMax);
      const grow = s.dilateFire + s.dilateFire * burstScalar(this.weapon, this.burst);
      this.size = Math.min(Math.max(this.size + grow, s.targetMin), s.targetMax);
    }
    return { dropZoom, kick };
  }

  /** Leaving the scope or the binoculars (`FUN_005b9020`): the knock's offset is cleared. */
  leaveScope(): void {
    this.offX = 0;
    this.offY = 0;
  }

  /** `FUN_005bd100`: the round's error in tangents. Scoped (state >= 4) the radius is 0 and the offset is the sway's. */
  cone(zoomState: number): Cone {
    const t = tangentPerPixel(this.fov);
    if (zoomState >= 4) return { offsetX: -this.swayX * t.x, offsetY: -this.swayY * t.y, radius: 0 };
    return { offsetX: this.offX * t.x, offsetY: -this.offY * t.y, radius: this.size * t.y * RADIUS_FACTOR };
  }

  /**
   * The reticle as the HUD draws it (`FUN_00216770`, `FUN_00215250`): its centre moved by the knock, in pixels (y
   * down), and the arms' push -- the size, halved in the third-person view (view state 0).
   */
  reticle(zoomState: number): { size: number; offset: [number, number] } {
    return { size: zoomState === 0 ? this.size * 0.5 : this.size, offset: [this.offX, this.offY] };
  }

  state(): AccuracyState {
    return {
      size: this.size, target: this.target, offset: [this.offX, this.offY], sway: [this.swayX, this.swayY],
      burst: this.burst,
    };
  }

  private rates(): Record<WeaponStanceName, [number, number]> {
    const r = (n: WeaponStanceName): [number, number] => [this.weapon.stances[n].swayRateX, this.weapon.stances[n].swayRateY];
    return { stand: r('stand'), crouch: r('crouch'), prone: r('prone') };
  }
}
