import { IDENTITY, Skeleton, type MotionClip } from '@s2u/scene';
import { Animator, type AnimStats, type MoverSnapshot } from './animator';
import type { LoadedBody } from './body';
import type { BodyView } from './bodyView';
import type { MotionEntry } from './motionTable';
import type { WalkMode } from './walk';

/**
 * The play mode (web sprint 2, W2.2b; ruling W2.R1): the walk mode with the body. Entering walk (`G`, the panel's
 * switch, the pad's Start) shows the map's SEAL at the mover's feet, facing the look, running the game's clips
 * (`./animator`); leaving it hides the body. The W2.1 body switch becomes **"show the body in fly mode"**: with it on,
 * the body stays in view where the play left it -- or at slot A in its bind pose, W2.1's picture, until played.
 */

/** Which camera draws the frame (W2.6): the shoulder camera in play, the aim view, or the fly camera. */
export type ViewKind = 'third' | 'aim' | 'fly';

/**
 * Whether the body is drawn: always over the shoulder, never in the aim view -- a first-person view from the body's
 * own eyes, where the head would fill the screen; the first-person arms (`seal_fp_*`, 77 §12) are not drawn, a carry --
 * and in the fly camera only when the panel's switch asks.
 */
export function bodyVisible(kind: ViewKind, flyToggle: boolean): boolean {
  return kind === 'third' || (kind === 'fly' && flyToggle);
}

/**
 * The scene skeleton of a decoded body (`@s2u/scene`'s `Skeleton`: the animator writes it, `setLocal` per part), from
 * the parts the worker sent. The model node's matrix is the identity on all 411 characters (78 §3.1); the nodes'
 * bboxes, types and flags are the skeleton reader's and not sent, so they are left empty -- nothing here reads them.
 */
export function bodySkeleton(body: LoadedBody): Skeleton {
  return new Skeleton(body.model, IDENTITY, body.parts.map((p, index) => ({
    index, name: p.name, parent: p.parent, bindLocal: Float32Array.from(p.bindLocal), bbox: new Float32Array(6), type: 0, flags: 0,
  })));
}

/** The clips and the table as the worker read them (`./motionTable`, `PlayData`). */
export interface PlayClips { clips: MotionClip[]; table: [string, MotionEntry][] | null }

/** The mover's snapshot at rest where it stands: what the body plays in fly mode once it has been played. */
const at = (s: MoverSnapshot): MoverSnapshot => ({ ...s, vx: 0, vz: 0, vy: 0, airborne: false, landing: null });

/**
 * The play mode's state on the page: the body, its skeleton, the clips, the animator over them, and the panel's
 * switch. `frame` runs once a frame after the walk's own, and puts the body where the mover is, in its clip.
 */
export class Play {
  private body: BodyView | null = null;
  private skeleton: Skeleton | null = null;
  private clips: PlayClips | null = null;
  private animator: Animator | null = null;
  private flyToggle = false;
  /** The mover's last state in play, for the body left standing in fly mode; null until the first play. */
  private last: (MoverSnapshot & { feet: [number, number, number] }) | null = null;

  /** A map's body, or none: the animator is rebuilt over its skeleton (the clips are the source's, kept). */
  setBody(view: BodyView | null, body: LoadedBody | null): void {
    this.body = view;
    this.skeleton = view && body ? bodySkeleton(body) : null;
    this.last = null;
    this.rebuild();
  }

  /** The source's clips and table (`playFromDisc`), or none: without them the body stands in its bind pose. */
  setClips(clips: PlayClips | null): void {
    this.clips = clips && clips.clips.length ? clips : null;
    this.rebuild();
  }

  /** The panel's body switch: the body in fly mode (W2.1's switch, turned). */
  setFlyToggle(on: boolean): void {
    this.flyToggle = on;
  }

  /**
   * One frame: in walk mode the body at the mover's drawn feet, facing the look, its clip advanced by `dt` and its
   * pose on the bones; in fly mode, once played, the body left standing where the mover was. `kind` is the camera
   * drawing the frame, which says whether the body is seen (`bodyVisible`).
   */
  frame(dt: number, walk: Pick<WalkMode, 'snapshot'>, kind?: ViewKind): void {
    const view = this.body;
    if (!view) return;
    const snap = walk.snapshot();
    const shown = kind ?? (snap ? 'third' : 'fly');
    view.setVisible(bodyVisible(shown, this.flyToggle));
    if (snap) this.last = { ...snap, feet: [...snap.feet] };
    const mover = snap ?? (this.last && at(this.last));
    if (!mover || !this.last) return;                  // never played: W2.1's bind pose at slot A stays
    if (!view.group.visible && !snap) return;
    view.place(this.last.feet, mover.yaw);
    if (this.animator && this.skeleton) {
      this.animator.step(dt, mover);
      view.setPose(this.skeleton.local);
    }
  }

  /** What the clips are doing: the hook's `stats().anim`; null with no body, no clips, or before the first play. */
  animStats(): AnimStats | null {
    return this.animator && this.last ? this.animator.stats() : null;
  }

  /** The posed root's height over the feet (the clip's), or null: the shoulder camera rides it (W2.6). */
  rootY(): number | null {
    return this.animator && this.last ? this.animator.rootY() : null;
  }

  /** The skeleton as posed, model space per part, for the eye (W2.6); null with no body. */
  palette(): readonly Float32Array[] | null {
    return this.skeleton?.palette() ?? null;
  }

  private rebuild(): void {
    this.animator = this.skeleton && this.clips
      ? new Animator(this.skeleton, this.clips.clips, this.clips.table && new Map(this.clips.table))
      : null;
  }
}
