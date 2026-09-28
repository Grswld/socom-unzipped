import { probeFloor, type Grid } from '@s2u/scene';
import { FootfallClock, footfallMoving, type StanceCode } from '@s2u/sound';
import type { AnimStats } from './animator';
import type { GameAudio, Vec3 } from './audio';
import type { Stance } from './walk';

/**
 * The walk's own signals turned into `GameAudio`'s events (web/docs/research/81 §4-§6), once a frame, so the walk
 * sounds with what the viewer has today: the footfalls off the playing clip's phase, a take-off off the jump count, a
 * landing off the mover's contact speed, a round off the fire state's count and a reload off its flag. When the
 * motion workstream's clip callbacks and footfall events and the weapon workstream's round and reload events land,
 * they call `GameAudio`'s `on*` methods directly and the matching lines here go (the controller's merge).
 */

/** What this reads of the walk, the clips and the rifle each frame. */
export interface WalkSignals {
  walking(): boolean;
  /** The feet as drawn, world units. */
  feet(): Vec3 | null;
  /** The mover: velocity across the ground, in the air, the posture, the jumps taken. */
  mover(): { vx: number; vz: number; airborne: boolean; stance: Stance; jumps: number } | null;
  /** The last landing's contact speed (units a second), null in the air. */
  landingSpeed(): number | null;
  /** The stick: forward and right, -1..1 (the keys are the stick at its rim). */
  wish(): { forward: number; right: number };
  anim(): AnimStats | null;
  /** Whether a clip is a locomotion cycle (the game's clip flag 0x40, `FUN_005551a0`). */
  isCycle(clip: string): boolean;
  grid(): Grid | null;
  /** Rounds fired so far, and whether a reload is running. */
  shots(): number;
  reloading(): boolean;
}

const STANCE_CODE: Record<Stance, StanceCode> = { stand: 0, crouch: 1, prone: 2 };

export class WalkSounds {
  private readonly clock = new FootfallClock();
  private jumps: number | null = null;
  private airborne = false;
  private shots: number | null = null;
  private reloading = false;
  /** How many of each the walk sent, for the hook. */
  readonly counts = { footfalls: 0, jumps: 0, landings: 0, rounds: 0, reloads: 0 };

  constructor(private readonly audio: GameAudio, private readonly walk: WalkSignals, private readonly weapon = 'M4A1 SD') {}

  /** The material under the feet: the floor the ground probe picks there (`probeFloor`), its polygon's byte. */
  material(feet: Vec3): number {
    const grid = this.walk.grid();
    return (grid && probeFloor(grid, feet[0], feet[1], feet[2])?.poly.material) ?? 0;
  }

  frame(): void {
    const feet = this.walk.feet(), mover = this.walk.mover();
    // The rifle first: its count and its flag move in fly mode too (a reset), but sound only while walking.
    const shots = this.walk.shots(), reloading = this.walk.reloading();
    if (!this.walk.walking() || !feet || !mover) {
      this.jumps = null; this.shots = shots; this.reloading = reloading; this.airborne = false;
      return;
    }
    if (this.shots !== null && shots > this.shots) {
      for (let i = this.shots; i < shots; i++) { this.audio.onFire(this.weapon, feet); this.counts.rounds++; }
    }
    if (reloading && !this.reloading) { this.audio.onReload(this.weapon, feet); this.counts.reloads++; }
    this.shots = shots;
    this.reloading = reloading;

    if (this.jumps !== null && mover.jumps > this.jumps) { this.audio.onJump(feet); this.counts.jumps++; }
    this.jumps = mover.jumps;
    const speed = this.walk.landingSpeed();
    if (this.airborne && !mover.airborne && speed !== null) {
      this.audio.onLand(speed, this.material(feet), feet);
      this.counts.landings++;
    }
    this.airborne = mover.airborne;
    if (mover.airborne) return;

    // FUN_005a3570: the footfalls of a locomotion cycle, while the SEAL moves.
    const anim = this.walk.anim();
    const phase = anim && anim.frames > 0 && this.walk.isCycle(anim.clip) ? anim.frame / anim.frames : null;
    const wish = this.walk.wish();
    const foot = this.clock.update(phase, footfallMoving(Math.hypot(mover.vx, mover.vz), wish.forward));
    if (!foot) return;
    const stance = STANCE_CODE[mover.stance];
    if (stance === 2 && foot === 'left') return;   // prone: the left foot's call is skipped, the crawl is the right's
    this.counts.footfalls++;
    this.audio.onFootstep(this.material(feet), feet, { stance, stick: Math.max(Math.abs(wish.forward), Math.abs(wish.right)) });
  }
}
