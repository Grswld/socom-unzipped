import type { Spawns } from '@s2u/scene';
import type { Pose } from './camera';
import type { Backend } from './renderer';
import type { BodyState } from './body';
import type { Rect } from './reticle';
import type { Stand } from './stand';
import type { SliderName, ToggleName } from './ui';
import type { Stance } from './walk';

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
  /** W2.4: the reticle -- drawn or not, and its rectangle in the drawing buffer's pixels (y down) on `frame`. */
  reticle(): { visible: boolean; rect: Rect | null; frame: { width: number; height: number } };
  /** W2.3: the stand-in body -- drawn or not, its top over the feet, its world bounds (null before it stands). */
  body(): BodyState;
  /** The walk's stance (W2.2b, `./walk`): what `C` and the touch stance button cycle. */
  stance(): Stance;
  /** Sets the stance, walking or not; false for a name that is not a stance. */
  setStance(stance: Stance): boolean;
  /** The build's label as the panel shows it: `rev <hash>[-dirty] · built <UTC minute> UTC`. */
  revision: string;
}

declare global {
  interface Window { __viewer: ViewerHook }
}
