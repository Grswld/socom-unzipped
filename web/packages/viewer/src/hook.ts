import type { Spawns } from '@s2u/scene';
import type { Pose } from './camera';
import type { Input } from './gamepad';
import type { Backend } from './renderer';
import type { ShotRecord } from './shot';
import type { Stand } from './stand';
import type { BodyView } from './bodyView';
import type { SliderName, ToggleName } from './ui';
import type { MoverState } from './walk';

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
    /** The seal table the walk runs on (W2.3a, W2.R6): the disc's `dynamics.rdr` over the defaults, or the defaults. */
    tuning: 'disc' | 'defaults';
    /** W2.4 (`./shot`): the shots fired on this map, and the last one -- its fire point, its end, whether it hit the hull. */
    shots: number;
    lastShot: ShotRecord | null;
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
  /** Walk mode (W2.3a): in the air, sliding, crouched, and the last landing's class and speed; null in fly mode. */
  mover(): MoverState | null;
  /** Walk mode: the jump `Space` makes (a named placeholder impulse); false when flying or with no footing. */
  jump(): boolean;
  /** Walk mode: crouch (true), stand (false) or toggle, as `C` does; the stance after, false when flying. */
  crouch(on?: boolean): boolean;
  /** W2.4: one shot from the current pose, as the left button fires it; null in fly mode (`./shot`). */
  fire(): ShotRecord | null;
  /** The build's label as the panel shows it: `rev <hash>[-dirty] · built <UTC minute> UTC`. */
  revision: string;
}

declare global {
  interface Window { __viewer: ViewerHook }
}
