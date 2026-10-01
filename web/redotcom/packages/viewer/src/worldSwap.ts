import type { Object3D } from 'three';

/**
 * The map switch's bookkeeping (`main.ts`'s `show`): which drawn world is on screen, and which one waits to be taken
 * down when its successor's first meshes land.
 *
 * The old map stays in the scene until the new one's world starts to reveal, so the swap happens between two drawn
 * maps rather than through a blank frame; and no longer, because the two share a coordinate range and drawn together
 * one shows through the other. A switch made while the previous switch is still preparing (the disc opened during a
 * load: `show(C)` while B's programs link) never reaches B's reveal, so B never retires A: held here rather than in
 * each `show`'s closure, the world still waiting goes at the next `begin`, and at most two worlds are ever in the
 * scene. No game behaviour: a lifecycle rule (the release review's MJ-3).
 */

/** A drawn world as the swap sees it (`./world`'s `WorldView`). */
export interface SwappableWorld {
  group: Object3D;
  dispose(): void;
}

export interface WorldSwap<T extends SwappableWorld> {
  /** `next` goes up: the world waiting from an interrupted switch is taken down now; the one shown waits for `next`. */
  begin(next: T): void;
  /**
   * `next`'s first meshes are in: the world it replaces is taken down. A call from a switch since overtaken (`next` is
   * no longer the newest) does nothing.
   */
  retirePrevious(next: T): void;
  /** The newest world (the one `begin` last put up), or null. */
  current(): T | null;
  /** The world waiting to be taken down, or null. */
  waiting(): T | null;
}

export function createWorldSwap<T extends SwappableWorld>(scene: { remove(object: Object3D): unknown }): WorldSwap<T> {
  let shown: T | null = null;
  let awaiting: T | null = null;
  const takeDown = (world: T): void => {
    scene.remove(world.group);
    world.dispose();
  };
  return {
    begin(next) {
      if (next === shown) return;
      if (awaiting) takeDown(awaiting);
      awaiting = shown;
      shown = next;
    },
    retirePrevious(next) {
      if (next !== shown || !awaiting) return;
      takeDown(awaiting);
      awaiting = null;
    },
    current: () => shown,
    waiting: () => awaiting,
  };
}
