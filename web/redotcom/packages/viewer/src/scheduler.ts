/**
 * Spreading a pile of synchronous work across animation frames.
 *
 * The map viewer needs this for one measured reason: `buildWorld` is cheap (14-20 ms) but the *first
 * frame that draws its result* is not. Three.js uploads a texture and a geometry to the GPU the first
 * time an object is drawn, so adding a whole map's 208 draws at once puts every upload and every
 * shader compile into one frame -- 690 ms on Frostfire, 1,703 ms on Crossroads, measured. The page is
 * frozen for that frame however little the build itself cost.
 *
 * Handing the objects over a few per frame turns that one long frame into many short ones. The work is
 * the same; what changes is that the camera keeps moving and the progress bar keeps drawing while it
 * happens.
 */

/** The bits of `window` this needs, so a test can supply its own clock and frame pump. */
export interface Frames {
  now(): number;
  requestFrame(run: () => void): number;
  cancelFrame(handle: number): void;
}

/** The real thing. */
export const browserFrames: Frames = {
  now: () => performance.now(),
  requestFrame: (run) => requestAnimationFrame(run),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
};

export interface SpreadOptions {
  /** How long a frame may spend on this work. The rest of the frame is the viewer's own. */
  budgetMs?: number;
  /**
   * At most this many tasks a frame, whatever the clock says.
   *
   * This is the budget that actually matters for the viewer, and the measurement is why. Adding a mesh
   * to a group costs about a hundredth of a millisecond; what costs 400 ms is the *render that
   * follows*, where three uploads the textures and geometry of everything newly visible. A time budget
   * cannot see that cost -- it is not spent inside the task -- so with a time budget alone all 37 of
   * Frostfire's world meshes ran in one slice and the next frame was as long as the one this was meant
   * to break up. Counting is crude and it works: the cost per object is roughly constant, so a count is
   * a time budget in disguise.
   */
  maxPerFrame?: number;
  /** Called after each frame's slice with how many tasks are done and how many there are. */
  onProgress?: (done: number, total: number) => void;
  frames?: Frames;
}

/** A run in progress: awaitable, and cancellable if the player picks another map first. */
export interface Spread {
  done: Promise<void>;
  cancel(): void;
}

/**
 * Runs `tasks` in order, as many per frame as fit in *both* budgets -- the count and the clock -- and
 * always **at least one** per frame, so a task that overruns on its own still makes progress rather
 * than wedging the queue forever.
 *
 * The budget is checked *after* each task, not before, because the cost of a task is not known until it
 * has run. So a frame can overshoot by one task's worth; 8 ms of budget against about 3 ms of upload
 * per draw keeps the overshoot small, and the alternative -- guessing a cost -- is worse.
 *
 * A task that throws does not stop the run: the rest still get their turn and the promise still
 * resolves. One prop that will not build should cost that prop, which is the rule the decoder follows.
 */
export function spreadAcrossFrames(tasks: (() => void)[], options: SpreadOptions = {}): Spread {
  const { budgetMs = 8, maxPerFrame = 4, onProgress, frames = browserFrames } = options;
  let index = 0;
  let handle: number | null = null;
  let cancelled = false;
  let settle: () => void = () => {};
  const done = new Promise<void>((resolve) => { settle = resolve; });

  if (tasks.length === 0) {
    onProgress?.(0, 0);
    settle();
    return { done, cancel: () => {} };
  }

  const slice = (): void => {
    handle = null;
    if (cancelled) return;
    const until = frames.now() + budgetMs;
    let ran = 0;
    do {
      const task = tasks[index++]!;
      ran++;
      try { task(); } catch { /* one task's failure is not the run's */ }
    } while (index < tasks.length && ran < maxPerFrame && frames.now() < until);
    onProgress?.(index, tasks.length);
    if (index >= tasks.length) { settle(); return; }
    handle = frames.requestFrame(slice);
  };

  handle = frames.requestFrame(slice);
  return {
    done,
    cancel: () => {
      cancelled = true;
      if (handle !== null) frames.cancelFrame(handle);
      handle = null;
      settle();
    },
  };
}
