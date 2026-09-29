import type { EffectStats } from './effects';
import type { Spawns } from '@s2u/scene';
import type { Pose } from './camera';
import type { Input } from './gamepad';
import type { Backend } from './renderer';
import type { FireState, Shot } from './fire';
import type { Rect } from './reticle';
import type { Stand } from './stand';
import type { BodyView } from './bodyView';
import type { SliderName, ToggleName } from './ui';
import type { MoverState, Stance, WalkCameraState, WalkView } from './walk';
import type { AnimStats } from './animator';
import type { LookOptions, LookState } from './look';
import type { ViewStats, WeaponStats } from './play';
import type { AudioStats } from './audio';

/**
 * The debug hook `main.ts` hangs on `window` and Playwright drives: an exact camera pose, the numbers the
 * screenshot test asserts on, and the toggle states.
 *
 * It lives in its own file so that there is one declaration of the shape rather than two that can drift:
 * `main.ts` assigns `window.__viewer` and `e2e/viewer.spec.ts` reads it, both against the interface below.
 * The `declare global` is what makes the property exist on `Window` — the alternative was a cast to `any`.
 */
export interface ViewerHook {
  setCamera(pose: Partial<Pose>): void;
  pose(): Pose;
  stats(): {
    triangles: number; backend: Backend; diagnostics: string[]; loadMs: number; map: string | null;
    collisionPolys: number; untexturedDraws: number; shadowDraws: number; alternateDraws: number; spawns: Spawns | null;
    /** Draws carrying a detail pass (W1.6), the column `tools/map-health.ts` lists. */
    detailDraws: number;
    /**
     * Where the camera opened on this map (W1.4b, `./stand`): spawn A's (x, z), `EYE` over the ground probe's
     * floor there (`floor`), or over A's recorded y where `floor` is null. Null for a map with no measured spawns.
     */
    stand: Stand | null;
    /** The disc's spawn slots the spawn overlay holds, per side: 24 a side on 20 maps, 25/24 on two (W1.5b). */
    slots: { a: number; b: number };
    /** Where the map on screen was read from: the served tree, or the player's own disc image (W1.7). */
    source: 'http' | 'iso';
    /**
     * The player's body (W2.1, `./bodyView`): its model, counts, gear, height and eye line, where it stands, and
     * whether it is shown; null on a map whose body did not decode.
     */
    body: (BodyView['stats'] & { visible: boolean }) | null;
    /**
     * The body's clips (W2.2b, `./animator`): the clip playing, its fractional key, the cross-fade's weight (1 settled)
     * and the clip it leaves, the keys a second, the upper-body layer; null with no body, no `MOTION_P.ZAR`, or before
     * the play mode is first entered.
     */
    anim: AnimStats | null;
    /**
     * The view the frame is drawn with (`./play`): `third` (the game's camera) in play, `aim` while the aim is held
     * (first person), `fly` otherwise, and the drawn camera's pose. The walk's camera in detail is `camera()`.
     */
    view: ViewStats;
  };
  toggles(): Record<ToggleName, boolean>;
  chromeHidden(): boolean;
  panelCollapsed(): boolean;
  flares(): [number, number, number][];
  lines(): { texture: string | null; min: [number, number, number]; max: [number, number, number] }[];
  sliders(): Record<SliderName, number>;
  /** Walk or fly (W1.4, `./walk`): what `G` and the panel's switch toggle. */
  mode(): 'walk' | 'fly';
  /** False when walk was asked for and there is no floor to stand on, under the camera or at spawn A. */
  setMode(mode: 'walk' | 'fly'): boolean;
  /**
   * Walk mode: `seconds` of 60 Hz ticks run at once with this stick (forward 1 by default), facing the camera's
   * yaw, then the camera at the eye; the pose after. Frame-rate proof, for the route test (`e2e/walk.spec.ts`).
   */
  walkFor(seconds: number, input?: { forward?: number; right?: number }): Pose;
  /** Walk mode: the mover's feet, or null in fly mode. */
  feet(): [number, number, number] | null;
  /**
   * The controller (W2.7, `./gamepad`): the connected pad's id, or null, and what the camera and the mover were fed
   * on the last frame -- the pad's input merged with the touch stick's (`e2e/pad.spec.ts`).
   */
  pad(): { id: string | null; input: Input };
  /** Walk mode: in the air, crouched, the stance, and the last landing's class and speed; null in fly mode. */
  mover(): MoverState | null;
  /** Walk mode: the jump (a named placeholder impulse); false when flying or in the air. */
  jump(): boolean;
  /** Walk mode: crouch (true), stand (false) or toggle stand and crouch; crouched after, false when flying. */
  crouch(on?: boolean): boolean;
  /** The aim view (first person while held: L1, the right mouse button), on or off; the view after. */
  setAim(on: boolean): WalkView;
  /** The walk's look (web research 83): the body's yaw and the look's, the turn, the axes, the screen offset. */
  look(): LookState;
  /** The look's options (the mouse's mapping, the pitch ratio, the invert, the throttle); returns them all. */
  setLook(opts: Partial<LookOptions>): LookOptions;
  /** The scope's magnification for the look (1 unscoped). */
  setZoom(magnification: number, mode4?: boolean): void;
  /** An explosion this far from the player: the game's shake preset for it, if any (true when one started). */
  shake(distance: number): boolean;
  /** W2.4: the reticle -- drawn or not, and its rectangle in the drawing buffer's pixels (y down) on `frame`. */
  reticle(): { visible: boolean; rect: Rect | null; frame: { width: number; height: number } };
  /** The walk's stance (W2.2b, `./walk`): what `C` and the touch stance button cycle. */
  stance(): Stance;
  /** Sets the stance, walking or not; false for a name that is not a stance. */
  setStance(stance: Stance): boolean;
  /**
   * W2.1: the walk's camera as last drawn -- third or first person, the eye and the look-at target (world), the root
   * height the target stands on, the camera's pitch in degrees -- or null in fly mode.
   */
  camera(): WalkCameraState | null;
  /** W2.1: third person (the game's camera, the default) or first person (`V`); false for a name that is not one. */
  setView(view: WalkView): boolean;
  /**
   * W2.5 (`./fire`): the shots fired, the magazine, where the last round landed (null for a miss or before one), and
   * the marks on the walls.
   */
  fire(): FireState;
  /** W2.5: one round now, as a click would fire it (the rate, the magazine, walking); null when none went. */
  shoot(): Shot | null;
  /**
   * The sound (web/docs/research/81, `./audio`): unlocked or not, the banks loaded, the samples decoded, the sounds
   * played by name, the events sent, the plays dropped and why, the last few plays.
   */
  audio(): AudioStats;
  /** The sound's volume (1 the default level) and mute; the stats after. The UI's panel calls `GameAudio` itself. */
  setAudio(settings: { volume?: number; muted?: boolean }): AudioStats;
  /**
   * WEAPON (`./play`, `./weaponRaise`, `./weaponPose`, `./heldItem`): whether the rifle is in the SEAL's hands, its
   * raise (the Fire set's weight, up or down, the countdown), the layers' clips and weights, and the muzzle in the world.
   */
  weapon(): WeaponStats;
  /** WEAPON: the trigger held (true) or let go (false), as the mouse button and R1 hold it. */
  trigger(down: boolean): void;
  /** WEAPON: shows or hides a piece of the SEAL's gear by its `character.rdr` name (`Satchel`: the bomb carrier's). */
  setGear(name: string, on: boolean): boolean;
  /**
   * EFFECTS (`./effects`, web/docs/research/89): the map's effect data loaded or not, the animations played by name,
   * the runs live, the casings in the air and the last one's place, the bounces, the particles, the sounds.
   */
  effects(): EffectStats;
  /**
   * EFFECTS: plays an animation of the map's zAnim archives (`bullet_hit_stone`, `frag_grenade_stone`, `muzzle_m4` ...)
   * at `at`, or 30 units ahead of the camera: as an impact (the point, the normal up) or as a muzzle effect (a node
   * whose barrel runs to the camera's right, the flash seen from the side); false when the map has none of that name.
   */
  playEffect(name: string, at?: [number, number, number], kind?: 'impact' | 'muzzle'): boolean;
  /** EFFECTS: holds every effect where it is (true) or lets them run (false), for a picture of a three-frame flash. */
  pauseEffects(on: boolean): void;
  /** The build's label as the panel shows it: `rev <hash>[-dirty] · built <UTC minute> UTC`. */
  revision: string;
}

declare global {
  interface Window { __viewer: ViewerHook }
}
