/**
 * The SEAL's head look (the motion workstream, round 4; web/docs/research/80-the-jump.md §6c): where the head, the neck
 * and the spine turn to look, as `socom2_game.elf` does it for the player. Three pieces, each cited by address:
 *
 * 1. **The controller's request** (`CSealCtrl`, vtable 0x6694b0): each tick `FUN_00596f10` (decomp 453979-454030)
 *    asks for a look **into the turn** -- the model-space direction `(sin p, 0, -cos p)`, `p = -1.5 x ctrl+0x60 x`
 *    the turn axis (`PTR_DAT_00650620` -1.5, `ctrl+0x60` 0.349 from the constructor `FUN_00598280`, line 454787) --
 *    at priority 1 while the axis is off rest (`FUN_0052eb60`'s 0.05), and drops it (`FUN_00600d40`) when it is not.
 *    With nothing asked the look is priority 0: ahead, with a **glance** aside every 4 to 7 s (`FUN_00601400` case 0,
 *    `FUN_00600550` 511240-511290): `0.349 x (0.8 to 1.1)` radians, left and right in turn. `FUN_00601400` sets each
 *    priority's speed share (`ctrl+0x1c` + `ctrl+0x20 x` a draw: 0.1 + 0.2 ahead, 0.8 into the turn), and
 *    `FUN_00600550` sends a new direction on when it has moved from the last sent by more than a dot of 0.97
 *    (`DAT_00650db0`), at `3.5 f + 0.5 (1 - f)` radians a second (`DAT_00650dc0`, `DAT_00650db8`).
 * 2. **The rotator** at `actor+0x1190` (`FUN_005adc70` 465655-465760 -> `FUN_005ad9d0`; run by `FUN_005ad920`): the
 *    current direction turns to the new one about their cross, at that speed, eased (`FUN_002874f0`, the node blend's
 *    `2s^2`). `FUN_00287210` reads it as two fractions: the yaw over 90 degrees and the pitch over 80, each capped at 1.
 * 3. **The pose** (`FUN_005ad5b0` 465415-465450 with `FUN_005ae730`): the head (`actor+0x308`) and three nodes up its
 *    parents -- neck, spinehi, spinelo -- each post-multiplied by `exp(|a| / 2 x E_yaw) exp(|b| / 2 x E_pitch)` (the
 *    pitch left out within 0.01 of rest), where the E are built once (`FUN_005ae980` 466054-466562, from
 *    `FUN_005ae6a0`) from nine captured poses a node (Euler X, Y, Z, `FUN_00287550`; the tables at 0x650820,
 *    0x6507b0, 0x650740, 0x6506d0): `E = forward x rotate(conj(P4) P_k, forward)`, P4 the rest and P5 / P3 / P1 / P7
 *    the right, left, up and down poses. A full yaw right turns the head's facing 64 degrees, left 48; the pitch
 *    poses hardly move it.
 *
 * `FUN_0057a330` (439152-439191) runs 2 and 3 only when the rifle is down (the raise weight `FUN_00286b80(actor+0x1160)`
 * 0) or the rotator is still turning (its done byte `actor+0x11f0` clear), not prone (prone plays action 0x1a's clip
 * instead) and not on a ladder or a hang (`FUN_00587b40`: states 8-10; no SEAL clip carries `NoHeadlooks`). The eyes
 * and lids (`FUN_005ae4b0`, `FUN_005ad4d0`, `FUN_005ad400`, the blinks) need `left_eyeball` ... `left_lid` nodes: the
 * SEAL's skeleton has none, so they are not ported.
 */

type Vec = [number, number, number];
type Quat = [number, number, number, number];

/** The nodes `FUN_005ad5b0` turns: the head (`actor+0x308`) and up its parents (the node's `+0x1c`). */
export const HEAD_LOOK_NODES = ['head', 'neck', 'spinehi', 'spinelo'] as const;
export type HeadLookNode = (typeof HEAD_LOOK_NODES)[number];

/**
 * `FUN_005ae6a0`'s source tables (0x650820, 0x6507b0, 0x650740, 0x6506d0; the ELF's data): per node nine Euler
 * triplets (X, Y, Z radians) in a 3 x 3 grid -- up-left, up, up-right / left, rest, right / down-left, down, down-right.
 */
export const HEAD_LOOK_POSES: Readonly<Record<HeadLookNode, readonly number[]>> = Object.freeze({
  head: [0.650285, 0.249262, -0.064414, 0.36275, 0.125272, -0.315574, -3.448279, -3.158561, 2.663389, 0.714202, -0.029039, -0.121985, 0.329926, -0.048495, -0.227492, -0.339758, 0.18101, -0.213956, 0.523775, -0.23072, -0.009759, 0.338768, -0.10386, -0.023228, -0.225627, 0.194855, 0.026389],
  neck: [0.313277, 0.060785, -0.162475, 0.165401, 0.069281, -0.159767, -0.118875, -0.017073, 0.057555, 0.415331, -0.027244, 0.145387, 0.161143, -0.030062, 0.201689, -0.191031, -0.06698, 0.231968, 0.13453, -0.101409, 0.251084, 0.069458, -0.119262, 0.259829, -0.132396, -0.119262, 0.259828],
  spinehi: [3.289377, -3.141503, -3.134536, 3.184891, -3.093602, -3.070289, 3.112315, -3.090652, -3.086333, 3.25607, -3.123184, -3.100918, 3.158849, -3.141955, -3.13686, 3.076661, -3.141674, -3.134945, 3.270472, -3.08908, -3.003346, 3.199412, -3.084071, -3.012107, 3.105598, -3.064827, -3.027932],
  spinelo: [-2.022868, 0.051301, 1.491896, -2.168812, -0.074313, 1.530547, -2.240766, -0.039951, 1.617209, -2.049272, 0.060016, 1.542443, -2.171515, 0.134454, 1.491896, -2.26375, 0.093264, 1.533842, -2.030121, 0.112114, 1.542366, -2.088991, 0.198901, 1.55183, -2.250237, 0.025287, 1.470673],
});

/** The game's numbers for the player's look (the header's addresses). */
export const LOOK = Object.freeze({
  /** `ctrl+0x60` (0x3eb2b8c2, `FUN_00598280` line 454787): the turn lead's and the glance's angle, radians. */
  angle: 0.34906584,
  /** `PTR_DAT_00650620`: the turn lead's factor on it (the look leads the turn). */
  turnFactor: -1.5,
  /** `FUN_0052eb60(&axis, 0x650610 = 0, 0x650618 = 0.05)`: the turn axis at rest within this. */
  turnDead: 0.05,
  /** `DAT_00650dc0`, `DAT_00650db8`: the rotator's speed, radians a second, at share 1 and 0. */
  speedFast: 3.5, speedSlow: 0.5,
  /** `DAT_00650db0`: a new direction goes to the rotator when its dot with the last sent is under this. */
  resend: 0.97,
  /** `FUN_00601400` case 0: a glance every `4 + 3 x` a draw seconds (`ctrl+0x54`, `+0x58`). */
  glanceEvery: 4, glanceSpread: 3,
  /** `FUN_00600550` 511258: the glance's angle `angle x (0.8 + 0.3 x` a draw). */
  glanceMin: 0.8, glanceRange: 0.3,
  /** `FUN_00287210`: the yaw fraction's and the pitch fraction's full angles (90 and 80 degrees). */
  yawFull: Math.PI / 2, pitchFull: 1.3962635,
  /** `FUN_005ae730`'s `FUN_0052eb60(&b, 0x650890 = 0, 0x650898 = 0.01)`: the pitch left out this near rest. */
  pitchDead: 0.01,
});

/** The speed share by priority (`FUN_00601400`): `ctrl+0x1c` and the draw's `ctrl+0x20`. */
const SHARE: Readonly<Record<0 | 1, { base: number; random: number }>> = { 0: { base: 0.1, random: 0.2 }, 1: { base: 0.8, random: 0 } };

const FORWARD: Vec = [0, 0, -1];

function qmul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
function qrot(q: Quat, v: Vec): Vec {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const about = (angle: number, i: 0 | 1 | 2): Quat => {
  const q: Quat = [0, 0, 0, Math.cos(angle / 2)];
  q[i] = Math.sin(angle / 2);
  return q;
};
/** `FUN_003067b0`: a rotation vector to `(v sin|v| / |v|, cos|v|)` -- a turn by twice its length. */
function expmap(v: Vec): Quat {
  const m = Math.hypot(v[0], v[1], v[2]);
  if (m < 1e-12) return [0, 0, 0, 1];
  const s = Math.sin(m) / m;
  return [v[0] * s, v[1] * s, v[2] * s, Math.cos(m)];
}
/** `FUN_002874f0`: `2s^2` to the half, its mirror after. */
const ease = (s: number): number => (s <= 0.5 ? 2 * s * s : 1 - 2 * (s - 1) * (s - 1));
const acos = (c: number): number => (c >= 1 ? 0 : c <= -1 ? Math.PI : Math.acos(c));

/** `FUN_00287550`: an Euler triplet's quaternion, `Z Y X` (X first). */
export function eulerQuat(x: number, y: number, z: number): Quat {
  return qmul(qmul(about(z, 2), about(y, 1)), about(x, 0));
}

/** One node's rotation vectors (`FUN_005ae980`): right, left, up and down from the rest pose. */
export interface LookAxes { right: Vec; left: Vec; up: Vec; down: Vec }

/** `FUN_005ae980`: `forward x rotate(conj(P4) P_k, forward)` for the right (5), left (3), up (1) and down (7) poses. */
export function lookAxes(poses: readonly number[]): LookAxes {
  const pose = (k: number): Quat => eulerQuat(poses[3 * k]!, poses[3 * k + 1]!, poses[3 * k + 2]!);
  const rest = pose(4), inv: Quat = [-rest[0], -rest[1], -rest[2], rest[3]];
  const axis = (k: number): Vec => cross(FORWARD, qrot(qmul(inv, pose(k)), FORWARD));
  return { right: axis(5), left: axis(3), up: axis(1), down: axis(7) };
}

/** Each node's axes, built once as `FUN_005ae6a0` does at start-up. */
export const LOOK_AXES: Readonly<Record<HeadLookNode, LookAxes>> = Object.freeze(Object.fromEntries(
  HEAD_LOOK_NODES.map((n) => [n, lookAxes(HEAD_LOOK_POSES[n])]),
) as Record<HeadLookNode, LookAxes>);

/** `FUN_005ae730`: the node's turn for the yaw fraction `a` and the pitch fraction `b` (post-multiplied into it). */
export function lookQuat(axes: LookAxes, a: number, b: number): Quat {
  const scale = (v: Vec, k: number): Vec => [v[0] * k, v[1] * k, v[2] * k];
  const yaw = expmap(scale(a >= 0 ? axes.right : axes.left, Math.abs(a) * 0.5));
  if (Math.abs(b) <= LOOK.pitchDead) return yaw;
  return qmul(yaw, expmap(scale(b >= 0 ? axes.up : axes.down, Math.abs(b) * 0.5)));
}

/** `FUN_00287210`: a model-space direction as the yaw fraction (right positive) and the pitch fraction (up positive). */
export function lookFractions(d: Vec): [number, number] {
  let yaw: number, pitch = 0;
  if (d[1] === 0) yaw = acos(-d[2]);
  else {
    const h = Math.hypot(d[0], d[2]);
    pitch = h < 0.01 ? Math.PI / 2 : acos(h);
    yaw = Math.abs(d[1]) > 0.999 ? 0 : acos(-d[2] / h);
  }
  let a = Math.min(1, yaw / LOOK.yawFull), b = Math.min(1, pitch / LOOK.pitchFull);
  if (d[0] < 0) a = -a;
  if (d[1] < 0) b = -b;
  return [a, b];
}

/** Rodrigues: `v` turned by `angle` about the unit `axis`. */
function turnAbout(v: Vec, axis: Vec, angle: number): Vec {
  const c = Math.cos(angle), s = Math.sin(angle), k = dot(axis, v) * (1 - c), x = cross(axis, v);
  return [v[0] * c + x[0] * s + axis[0] * k, v[1] * c + x[1] * s + axis[1] * k, v[2] * c + x[2] * s + axis[2] * k];
}

/**
 * The player's look: the controller's request and the rotator (the header). `request` once a tick with the turn axis
 * (`actor+0x23c`: the turn over `turn_maxrate`, left positive), `advance` when `FUN_0057a330`'s gate lets it run, and
 * `quat(node)` for the pose.
 */
export class HeadLook {
  /** The rotator's direction now (`actor+0x11a0`), model space. */
  dir: Vec = [...FORWARD];
  private from: Vec = [...FORWARD];
  private to: Vec = [...FORWARD];
  private axis: Vec = [1, 0, 0];
  private angle = 0;
  private duration = 0;
  private progress = 1;
  /** The rotator's done byte (`actor+0x11f0`): nothing left to turn. */
  done = true;

  /** The request (`ctrl+0x24` priority, `+0x28` direction, `+0x40` the glance's offset, `+0x5c` its countdown). */
  priority: 0 | 1 = 0;
  private asked: Vec = [...FORWARD];
  private offset: Vec = [0, 0, 0];
  private glanceIn: number;
  private glanceSign = 1;
  private dirty = true;
  private sent: Vec = [...FORWARD];

  constructor(private readonly random: () => number = Math.random) {
    this.glanceIn = LOOK.glanceEvery + LOOK.glanceSpread * random();
  }

  /** `FUN_00601400` for priorities 0 and 1: the offset cleared and the direction marked to go on. */
  private ask(priority: 0 | 1, dir: Vec): void {
    this.asked = dir;
    this.offset = [0, 0, 0];
    this.dirty = true;
    this.priority = priority;
  }

  /**
   * One tick of `FUN_00596f10` then `FUN_00600550`: the turn lead asked (priority 1) or dropped back to ahead
   * (priority 0), the glance's countdown, and a direction moved on from the last sent sent to the rotator.
   */
  request(dt: number, turnAxis: number): void {
    if (Math.abs(turnAxis) > LOOK.turnDead) {
      const p = LOOK.turnFactor * LOOK.angle * turnAxis;
      this.ask(1, [Math.sin(p), 0, -Math.cos(p)]);
    } else if (this.priority === 1) this.ask(0, [...FORWARD]);            // FUN_00600d40(ctrl, 1)
    if (this.dirty) {
      this.dirty = false;
      const raw: Vec = [this.asked[0] + this.offset[0], this.asked[1] + this.offset[1], this.asked[2] + this.offset[2]];
      const m = Math.hypot(...raw) || 1;
      const d: Vec = [raw[0] / m, raw[1] / m, raw[2] / m];
      if (dot(d, this.sent) < LOOK.resend) {
        const s = SHARE[this.priority], f = s.base + s.random * this.random();
        this.turnTo(d, LOOK.speedFast * f + LOOK.speedSlow * (1 - f));
        this.sent = d;
      }
    }
    if (this.priority === 0) {
      this.glanceIn -= dt;
      if (this.glanceIn <= 0) {
        this.glanceIn = LOOK.glanceEvery + LOOK.glanceSpread * this.random();
        // FUN_00600550 511255-511290: the first to the side DAT_00650dd0 says (1, then flipped), then the other side
        // of the last; no pitch (DAT_0066bb48 is 0).
        const r = LOOK.glanceMin + LOOK.glanceRange * this.random();
        let psi: number;
        if (this.offset[0] === 0) { psi = this.glanceSign * LOOK.angle * r; this.glanceSign = -this.glanceSign; }
        else psi = (this.offset[0] >= 0 ? -1 : 1) * LOOK.angle * r;
        this.offset = [Math.sin(psi) - FORWARD[0], 0, -Math.cos(psi) - FORWARD[2]];
        this.dirty = true;
      }
    }
  }

  /** `FUN_005ad9d0`: turn from where the look is to `d` at `speed` radians a second. */
  private turnTo(d: Vec, speed: number): void {
    if (d[0] === this.to[0] && d[1] === this.to[1] && d[2] === this.to[2]) return;
    this.from = [...this.dir];
    this.to = d;
    this.angle = acos(dot(this.from, d));
    const c = cross(this.from, d), m = Math.hypot(...c);
    this.axis = m < 0.001 ? [1, 0, 0] : [c[0] / m, c[1] / m, c[2] / m];
    this.duration = speed > 0 ? this.angle / speed : 0;
    this.progress = 0;
    this.done = speed === 0;
    if (this.done) this.progress = 1;
  }

  /** `FUN_005ad920`: the rotator run on by `dt`. */
  advance(dt: number): void {
    if (this.done) return;
    this.progress = this.duration > 0 ? Math.min(1, this.progress + dt / this.duration) : 1;
    if (this.progress >= 1) this.done = true;
    this.dir = turnAbout(this.from, this.axis, ease(this.progress) * this.angle);
  }

  /** `FUN_00287210` then `FUN_005ae730`: the node's turn for the look now. */
  quat(node: HeadLookNode): Quat {
    const [a, b] = lookFractions(this.dir);
    return lookQuat(LOOK_AXES[node], a, b);
  }
}
