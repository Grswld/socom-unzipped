import type { MotionClip } from '@s2u/scene';
import { oneShotSeconds } from './locomotion';
import type { MotionEntry } from './motionTable';

/**
 * A traversal clip's root travel, and a mover path that follows it (web research 86 section 1).
 *
 * The climbs and the ladder's ends are clips whose skeleton root rises and moves ahead: `motion.rdr` flags them
 * `UseVelY` (the actor's vertical velocity is the root's) and gives each a `refPt`, the point the move is aligned on
 * (research 86 section 1.3). The viewer's animator stands the root over the feet at the bind's x and z with the clip's
 * height (`./animator`, `writePose`), so a clip's own travel would lift and carry the body over feet that stay put.
 * A `ClipPath` instead moves the feet from where the move starts to where it ends, in step with the clip's own
 * progress, and gives the root's height over those feet that keeps the drawn body where the clip puts it -- stretched
 * evenly over the move where the obstacle and the clip disagree (a 9-unit crate climbed with the 12.9 of
 * `seal_climbcrate`), so the body neither pops at the end nor floats.
 */

/** The shape of a clip's root: its keys (the closing key dropped), their seconds, and the root's xyz per key. */
export interface ClipShape {
  name: string;
  /** Keys, the closing key (key n, which is key 0: research 77 section 5) not counted. */
  keys: number;
  /**
   * The clip's length in seconds as `FUN_00287620` (decomp 131281-131320) sets the loaded clip's `+0x10`: a loop's with
   * a negative `max_velocity` is `motion.rdr`'s `playback`; a loop with a positive one (a locomotion cycle, the ladder's
   * climb) is its own duration divided by `playback` (`seal_climbladder`: 0.533 / 3 = 0.178 s). A one-shot runs from key
   * 0 to its last key n - 1 in `playback x ((n - 1) / n)^2` (`FUN_0028c4f0`, `./locomotion` `oneShotSeconds`).
   */
  seconds: number;
  /** The root's xyz per key, model space (x right, y up, z behind). */
  root: Float32Array;
}

/** The root part (`m_root`, research 77 section 4). */
const ROOT = 'skel_root';

/**
 * A clip's shape: its root's translations (a constant root repeats), its keys, and its seconds (`ClipShape.seconds`:
 * the table's `playback`, or the duration over it for a moving loop; the clip's own `frameCount / 30` without one).
 */
export function clipShape(clip: MotionClip, entry?: MotionEntry | null): ClipShape {
  const keys = Math.max(1, clip.frameCount);
  const part = clip.parts.find((p) => p.name === ROOT);
  const root = new Float32Array(keys * 3);
  for (let k = 0; k < keys; k++) {
    const t = part?.translations;
    const at = t && t.length > 3 ? 3 * k : 0;
    root[k * 3] = t?.[at] ?? 0; root[k * 3 + 1] = t?.[at + 1] ?? 0; root[k * 3 + 2] = t?.[at + 2] ?? 0;
  }
  const playback = entry?.playback;
  if (playback === null || playback === undefined || !(playback > 0)) return { name: clip.name, keys, seconds: clip.duration, root };
  if (entry?.looped === true) return { name: clip.name, keys, seconds: (entry.maxVelocity ?? -1) >= 0 ? clip.duration / playback : playback, root };
  return { name: clip.name, keys, seconds: oneShotSeconds(playback, keys), root };
}

/**
 * A stand-in shape where the clip is not on hand (tests without the disc, a page before the pack arrives): the root
 * rising `rise` and going `ahead` along a smoothstep over `seconds`, from `rootY`. PLACEHOLDER shape, named as one; the
 * numbers passed are the clip's own, research 86's table.
 */
export function straightShape(name: string, seconds: number, rootY: number, rise: number, ahead: number, keys = 30): ClipShape {
  const root = new Float32Array(keys * 3);
  for (let k = 0; k < keys; k++) {
    const s = keys > 1 ? k / (keys - 1) : 1, e = s * s * (3 - 2 * s);
    root[k * 3 + 1] = rootY + rise * e;
    root[k * 3 + 2] = -ahead * e;
  }
  return { name, keys, seconds, root };
}

/** The clip played backwards (the game's reverse flag: `FUN_0028c160` negates the rate and starts at the end). */
export function reverseShape(shape: ClipShape): ClipShape {
  const root = new Float32Array(shape.root.length);
  for (let k = 0; k < shape.keys; k++) root.set(shape.root.subarray((shape.keys - 1 - k) * 3, (shape.keys - k) * 3), k * 3);
  return { name: shape.name, keys: shape.keys, seconds: shape.seconds, root };
}

/**
 * Two one-shots as one play's two nodes (`FUN_00581110`, decomp 442306-442340; `FUN_0028c4f0`, `FUN_0028d670`): one
 * phase at `w / (A's playback x (n-1)/n) + (1 - w) / (B's ...)` a second to B's end `(n_B - 1) / n_B` (the play was
 * made for B), each node sampled at `phase x n` and held at its own last key, the roots weighted: `w` of A, `1 - w` of B.
 * The shape is laid out on B's keys, over the blend's seconds.
 */
export function blendShapes(a: ClipShape, b: ClipShape, w: number): ClipShape {
  const rateOf = (s: ClipShape): number => 1 / (s.seconds / ((s.keys - 1) / s.keys));   // seconds = playback x ((n-1)/n)^2
  const rate = w * rateOf(a) + (1 - w) * rateOf(b);
  const end = (b.keys - 1) / b.keys;
  const root = new Float32Array(b.keys * 3);
  for (let k = 0; k < b.keys; k++) {
    const phase = k / b.keys;
    const ra = rootAt(a, Math.min(a.keys - 1, phase * a.keys)), rb = rootAt(b, phase * b.keys);
    for (let i = 0; i < 3; i++) root[k * 3 + i] = w * ra[i]! + (1 - w) * rb[i]!;
  }
  return { name: b.name, keys: b.keys, seconds: end / rate, root };
}

/** The clip's first `fraction` (of its keys and its seconds): a move that leaves the clip partway (the hang's push). */
export function truncateShape(shape: ClipShape, fraction: number): ClipShape {
  const keys = Math.max(2, Math.round(fraction * (shape.keys - 1)) + 1);
  return { name: shape.name, keys, seconds: shape.seconds * ((keys - 1) / (shape.keys - 1)), root: shape.root.slice(0, keys * 3) };
}

/** The root at a fractional key, clamped to the clip's last real key. */
export function rootAt(shape: ClipShape, key: number): [number, number, number] {
  const k = Math.max(0, Math.min(shape.keys - 1, key));
  const i = Math.min(shape.keys - 1, Math.floor(k)), j = Math.min(shape.keys - 1, i + 1), t = k - i;
  const r = shape.root;
  return [r[i * 3]! + (r[j * 3]! - r[i * 3]!) * t, r[i * 3 + 1]! + (r[j * 3 + 1]! - r[i * 3 + 1]!) * t, r[i * 3 + 2]! + (r[j * 3 + 2]! - r[i * 3 + 2]!) * t];
}

/** The root's rise and its travel ahead (-z) from key 0 to the last key. */
export function shapeTravel(shape: ClipShape): { rise: number; ahead: number } {
  const a = rootAt(shape, 0), b = rootAt(shape, shape.keys - 1);
  return { rise: b[1] - a[1], ahead: a[2] - b[2] };
}

/** `FUN_005b2d20`: the steer's most, units a second on each axis (the velocity it sets is clamped to +-30). */
export const STEER_RATE = 30;

/** Where a path is at one moment: the feet, the root's height over them, the key, and whether it has ended. */
export interface PathPoint {
  feet: [number, number, number];
  rootY: number;
  key: number;
  done: boolean;
}

/**
 * A move along a clip from `from` to `to` (feet, world). Each tick `at(seconds)` gives the feet and the root's height
 * over them. The feet rise with the clip's running highest root (so they never sink under a floor they have left),
 * and go ahead with its running furthest travel, each normalised to the whole; the drawn root is the clip's own, plus
 * the part of the obstacle-to-clip mismatch the move has covered, so that the root ends `endRootY` over `to`.
 *
 * `lift` is the climb's vertical steer (`FUN_005b2d20`, decomp 468517-468748; web research 86 section 3.5): the game
 * drives the actor at up to `STEER_RATE` a second on each axis -- y too -- until the root plus the clip's `refPt` is on
 * the ledge's edge point, whose y is the contact polygon's top (`FUN_005b1a10`, 467887), so the clip's hands meet the
 * ledge at every height the table climbs. The drawn body takes that shift from the clip's start at the steer's rate,
 * the rest of the mismatch spread over the rise as before; the feet (the mover, the server's) are unchanged.
 */
export class ClipPath {
  readonly rise: number;
  readonly ahead: number;
  private readonly start: [number, number, number];

  constructor(readonly shape: ClipShape, readonly from: readonly [number, number, number], readonly to: readonly [number, number, number],
              readonly startRootY: number, readonly endRootY: number, readonly lift = 0) {
    const t = shapeTravel(shape);
    this.rise = t.rise;
    this.ahead = t.ahead;
    this.start = rootAt(shape, 0);
  }

  /** Seconds the move takes. */
  get seconds(): number {
    return this.shape.seconds;
  }

  at(seconds: number): PathPoint {
    const shape = this.shape;
    const key = Math.max(0, Math.min(shape.keys - 1, (seconds / shape.seconds) * (shape.keys - 1)));
    // The running furthest rise (or drop) and travel (ahead or back) up to this key, each as a fraction of the whole.
    const sy = Math.sign(this.rise) || 1, sz = Math.sign(this.ahead) || 1;
    let up = 0, on = 0;
    const last = Math.floor(key);
    for (let k = 0; k <= last; k++) {
      const r = rootAt(shape, k);
      up = Math.max(up, (r[1] - this.start[1]) * sy);
      on = Math.max(on, (this.start[2] - r[2]) * sz);
    }
    const r = rootAt(shape, key);
    up = Math.max(up, (r[1] - this.start[1]) * sy);
    on = Math.max(on, (this.start[2] - r[2]) * sz);
    const time = Math.min(1, seconds / shape.seconds);
    const u = Math.abs(this.rise) > 1e-6 ? Math.min(1, up / Math.abs(this.rise)) : time;
    const w = Math.abs(this.ahead) > 1e-6 ? Math.min(1, on / Math.abs(this.ahead)) : time;
    const [fx, fy, fz] = this.from, [tx, ty, tz] = this.to;
    const feet: [number, number, number] = [fx + (tx - fx) * w, fy + (ty - fy) * u, fz + (tz - fz) * w];
    // The drawn root: the clip's own over the start, the steer's lift at its rate, the rest of the mismatch over the rise.
    const lifted = Math.sign(this.lift) * Math.min(Math.abs(this.lift), STEER_RATE * seconds);
    const rest = (ty + this.endRootY) - (fy + this.startRootY + this.rise) - this.lift;
    const drawn = fy + this.startRootY + (r[1] - this.start[1]) + lifted + rest * u;
    return { feet, rootY: drawn - feet[1], key, done: seconds >= shape.seconds };
  }
}
