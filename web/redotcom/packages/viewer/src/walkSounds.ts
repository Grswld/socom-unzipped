import { probeFloor, type Grid } from '@s2u/scene';
import type { StanceCode } from '@s2u/sound';
import type { GameAudio, Vec3 } from './audio';
import type { FireEvent } from './fire';
import type { PlayEvent } from './play';
import type { Stance } from './walk';

/**
 * The walk's events turned into `GameAudio`'s (web/redotcom/docs/research/81 §4-§6): the body's (`Play.onEvent`: the game's
 * footfalls off the play's phase, `FUN_005a3570`; each clip's `zanim_callback` as its key is crossed -- `jump_whoosh`
 * among them; the landing with its contact speed, research 80) and the rifle's (`Fire.subscribe`: a round, a reload).
 * Each sound is heard where it happens: a step at the foot, a round at the muzzle.
 */

/** What this reads of the walk when an event comes. */
export interface WalkSignals {
  walking(): boolean;
  /** The feet as drawn, world units. */
  feet(): Vec3 | null;
  /** The posture the steps are chosen by (stand, crouch, prone). */
  stance(): Stance;
  /** The stick: forward and right, -1..1 (the keys are the stick at its rim). */
  wish(): { forward: number; right: number };
  grid(): Grid | null;
}

const STANCE_CODE: Record<Stance, StanceCode> = { stand: 0, crouch: 1, prone: 2 };

export class WalkSounds {
  /** How many of each the walk sent, for the hook. */
  readonly counts = { footfalls: 0, callbacks: 0, landings: 0, rounds: 0, reloads: 0 };

  constructor(private readonly audio: GameAudio, private readonly walk: WalkSignals) {}

  /** The material under a point: the floor the ground probe picks there (`probeFloor`), its polygon's byte. */
  material(at: Vec3): number {
    const grid = this.walk.grid();
    return (grid && probeFloor(grid, at[0], at[1], at[2])?.poly.material) ?? 0;
  }

  /**
   * Once a frame: the ambience on while walking, and the camera's place -- the floor the ground probe picks under the
   * camera (as `FUN_00295b00` probes under it each frame, decomp 140035-140058), its `m_inside` and reverb-zone bits --
   * for the reverb's depth and the beds (`GameAudio.setEnvironment`).
   */
  frame(camera: Vec3 | null): void {
    const walking = this.walk.walking();
    this.audio.setAmbience(walking);
    const grid = this.walk.grid();
    if (!walking || !grid || !camera) return;
    const floor = probeFloor(grid, camera[0], camera[1], camera[2])?.poly;
    if (floor) this.audio.setEnvironment((floor.inside ?? 0) !== 0, floor.reverbZone ?? 0);
  }

  /** The body's events (`Play.onEvent`), while walking. */
  playEvent(e: PlayEvent): void {
    const feet = this.walk.feet();
    if (!this.walk.walking() || !feet) return;
    if (e.kind === 'footfall') {
      const stance = STANCE_CODE[this.walk.stance()];
      if (stance === 2 && e.foot === 'left') return;   // prone: the left foot's call is skipped, the crawl is the right's
      const at = e.position ?? feet, wish = this.walk.wish();
      this.counts.footfalls++;
      this.audio.onFootstep(this.material(feet), at, { stance, stick: Math.max(Math.abs(wish.forward), Math.abs(wish.right)) });
    } else if (e.kind === 'callback') {
      this.counts.callbacks++;
      this.audio.onAnimCallback(e.name, feet);
    } else if (e.kind === 'land') {
      this.counts.landings++;
      this.audio.onLand(e.speed, this.material(feet), feet);
    }
  }

  /**
   * The rifle's own events (`./fire` `subscribe`): a round is heard at the fire point it left (the muzzle), a reload
   * where it starts -- the record's sounds by its `InternalName` (`.M4A1_SIL`, `.M4A1_SIL_RLD` for the M4A1 SD).
   */
  fireEvent(e: FireEvent): void {
    if (e.type === 'round') { this.audio.onFire(e.weapon.name, e.from); this.counts.rounds++; }
    else if (e.type === 'reloadStart') { this.audio.onReload(e.weapon.name, this.walk.feet()); this.counts.reloads++; }
  }
}
