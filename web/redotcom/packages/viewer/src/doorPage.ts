import type { Grid } from '@s2u/scene';
import { DoorSet, pickDoor, type DoorSpec } from './doors';
import type { GroundData } from './mover';
import type { ClientEvent, DoorWire } from './net/protocol';

/**
 * The doors on the page (`./doors`, web/docs/research/92-doors.md): the map's `DoorSet` on the walk's own hull, its
 * swings drawn (`WorldView.moveNode`) and heard (the zAnim's `SOUND`), the door under the reticle for the HUD's prompt
 * and the action button, and -- in a match -- the server's doors followed from the snapshots, the action sent to it
 * as a `door` event rather than run here. `main.ts` makes one.
 */

/** What the page lends the doors. */
export interface DoorPageDeps {
  /** The walk: its hull's grid, the feet, the view's aim (`WalkMode.fireAim`); null when not walking. */
  grid(): Grid | null;
  feet(): [number, number, number] | null;
  aim(): { eye: readonly number[]; far: readonly number[] } | null;
  sound(name: string, at: [number, number, number]): void;
  /** The drawn leaf moved (`WorldView.moveNode`). */
  move(path: string, delta: Float32Array): void;
  /** The match, when in one and open: where the doors come from, and (a player's) where the action goes. */
  net(): { role: string; send(ev: ClientEvent): void; lastSeq(): number; doors(): DoorWire[] | undefined } | null;
}

export class DoorPage {
  private set: DoorSet | null = null;
  /** The last action's door and whether it was taken, for the hook. */
  private last: { door: number; taken: boolean; sent: boolean } | null = null;

  constructor(private readonly deps: DoorPageDeps) {}

  /** A new map: its doors on its hull (the one the walk stands on: `LoadedMap.ground`), shut, drawn where the disc has them. */
  setMap(doors: readonly DoorSpec[] | undefined, ground: GroundData | undefined): void {
    this.set = doors?.length ? new DoorSet(doors, ground ?? null, {
      sound: (name, at) => this.deps.sound(name, at),
      moved: (door, delta) => this.deps.move(door.path, delta),
    }) : null;
    this.last = null;
  }

  /** One frame: in a match the server's doors followed; the swings stepped. */
  frame(dt: number): void {
    const set = this.set;
    if (!set) return;
    const net = this.deps.net();
    if (net) set.applyWire(net.doors());
    set.step(dt);
  }

  /** The door under the reticle within its reach (`pickDoor`), or null: the HUD's prompt and the action's target. */
  target(): number | null {
    const set = this.set, grid = this.deps.grid(), feet = this.deps.feet(), aim = this.deps.aim();
    if (!set || !grid || !feet || !aim) return null;
    return pickDoor(set, grid, aim.eye, aim.far, feet);
  }

  /** The action button (`WalkMode.setActionFilter`): true when a door took it -- used here, or asked of the server. */
  action(): boolean {
    const i = this.target();
    if (i === null || !this.set) return false;
    const net = this.deps.net();
    if (net) {
      if (net.role !== 'player') return false;
      net.send({ type: 'door', seq: net.lastSeq(), door: i });
      this.last = { door: i, taken: true, sent: true };
      return true;
    }
    const taken = this.set.use(i, this.deps.feet());
    this.last = { door: i, taken, sent: false };
    return true;                                                   // refused mid-swing, the press is still the door's
  }

  /** For the hook: every door's node and state, the one under the reticle, and the last action. */
  stats(): { doors: { node: string; open: boolean; busy: boolean; valve: number }[]; target: number | null; last: DoorPage['last'] } {
    const set = this.set;
    return {
      doors: set ? set.specs.map((d, i) => ({ node: d.node, ...set.state(i) })) : [],
      target: this.target(),
      last: this.last && { ...this.last },
    };
  }

  /** For the hook: the action on door `i` from the feet, bypassing the reticle (the tests' door). */
  use(i: number): boolean {
    return this.set?.use(i, this.deps.feet()) ?? false;
  }
}
