import type { MotionClip } from '@s2u/scene';
import type { MotionTable } from './motionTable';

/**
 * The reload's clip and its length, one table for the page and the match server (MJ-1 of the launch review; the
 * shared sim boundary, `./sim`): the page's `WeaponPose` plays and times the reload from here, and the server's room
 * locks the weapon for the same seconds, so the two clocks cannot drift.
 *
 * - **The lock is the clip.** The game has no reload timer: `FUN_005c2a90` (decomp 477395-477399) refuses a reload
 *   while `FUN_005a7d10` / `FUN_005a7ab0` / `FUN_005a78d0` answer, and the fire gate `FUN_005a7de0` tests the reload's
 *   animation state through `FUN_005a7ab0` -- the reload lasts as long as its clip plays. The M4A1's record carries no
 *   `ReloadTime` (research 79 s1.2; research 84 s18). So the length is the clip's `motion.rdr` `playback` [data]:
 *   `seal_reload` 1.6, `seal_crouch_reload` 1.9, `seal_prone_reload` 1.7, `seal_mv_reload` 1.2 (the pistol's four
 *   from the same table).
 * - **The clip.** `FUN_005a82e0` (decomp 462786-462930) picks it: prone the prone reload; otherwise the moving
 *   overlay when the mover's speed squared is over 400.0 (`bVar3`, 462821-462823: `vx^2 + vy^2 + vz^2 <= 400.0` is
 *   still -- hard-coded; `dynamics.rdr`'s `min_running_reload_speed` is loaded but never read), else the stance's.
 *   The item (`m_item`) picks the rifle's set or the pistol's (animset.rdr's "Rifle reload" / "Pistol reload" family).
 * - `RELOAD_SECONDS_PLACEHOLDER` (named; research 84 s11): the length when the clip or the table is missing (a
 *   source without `MOTION_P.ZAR`, a server started without the clips) -- the viewer's old estimate, 2 s, with no
 *   source. It is a fallback only; every retail disc carries the clips.
 */

/** The stance the reload picks its clip by (`Walker.posture`: the body in use). */
export type ReloadStance = 'stand' | 'crouch' | 'prone';
/** The firearm in use (`m_item`). */
export type ReloadItem = 'rifle' | 'pistol';

/** The rifle's reload clips by stance, and the moving one (animset.rdr's "Rifle reload" family). */
export const RELOAD_CLIPS = {
  stand: 'seal_reload', crouch: 'seal_crouch_reload', prone: 'seal_prone_reload', moving: 'seal_mv_reload',
} as const;

/** The pistol's (animset.rdr's "Pistol reload", "Pistol crouch reload", "Pistol prone reload", "Moving pistol reload"). */
export const PISTOL_RELOAD_CLIPS = {
  stand: 'seal_p_reload', crouch: 'seal_p_crouch_reload', prone: 'seal_p_prone_reload', moving: 'seal_p_mv_reload',
} as const;

/** The eight reload clips: what the sim's clip set (`./simMap` `SIM_CLIPS`) carries so the server can time a reload. */
export const ALL_RELOAD_CLIPS: readonly string[] = Object.freeze([...Object.values(RELOAD_CLIPS), ...Object.values(PISTOL_RELOAD_CLIPS)]);

/**
 * `FUN_005a82e0`'s still test for the reload (decomp 462821-462823): the mover's speed squared at most 400.0 (20 units
 * a second) is still. Faster, standing or crouched, the moving reload; prone always the prone one.
 */
export const RELOAD_STILL_SPEED = 20;

/** PLACEHOLDER (named; research 84 s11): the reload's seconds when its clip or the table is missing. No source. */
export const RELOAD_SECONDS_PLACEHOLDER = 2;

/** `FUN_005a82e0`'s `bVar3` negated: the mover's velocity (units a second) is over 20 -- the moving reload. */
export function reloadMoving(vx: number, vy: number, vz: number): boolean {
  return vx * vx + vy * vy + vz * vz > RELOAD_STILL_SPEED * RELOAD_STILL_SPEED;
}

/** `FUN_005a82e0`'s choice: prone the prone reload; else moving the overlay, still the stance's; the item's set. */
export function reloadClip(stance: ReloadStance, moving: boolean, item: ReloadItem = 'rifle'): string {
  const set = item === 'pistol' ? PISTOL_RELOAD_CLIPS : RELOAD_CLIPS;
  return stance === 'prone' ? set.prone : moving ? set.moving : set[stance];
}

/** The reload's length: the clip's `playback` seconds, else its keys at its own rate; null without the clip. */
export function reloadLength(clip: MotionClip | undefined, table: MotionTable | null): number | null {
  if (!clip) return null;
  const playback = table?.get(clip.name)?.playback;
  return playback !== null && playback !== undefined && playback > 0 ? playback : clip.frameCount / clip.rate;
}

/** The clips by name, from a map (the page's) or the list the sim loads (`SimClips.clips`, the server's). */
export type ReloadClipSource = ReadonlyMap<string, MotionClip> | readonly MotionClip[];

const clipNamed = (clips: ReloadClipSource, name: string): MotionClip | undefined =>
  Array.isArray(clips) ? (clips as readonly MotionClip[]).find((c) => c.name === name) : (clips as ReadonlyMap<string, MotionClip>).get(name);

/** The reload's length in a stance, moving or not, for an item: the chosen clip's (`reloadLength`), null without it. */
export function reloadSeconds(clips: ReloadClipSource, table: MotionTable | null, stance: ReloadStance, moving: boolean,
  item: ReloadItem = 'rifle'): number | null {
  return reloadLength(clipNamed(clips, reloadClip(stance, moving, item)), table);
}

/** The weapon's lock for a reload: `reloadSeconds`, else `RELOAD_SECONDS_PLACEHOLDER` (what the room holds a weapon for). */
export function reloadLockSeconds(clips: ReloadClipSource | null, table: MotionTable | null, stance: ReloadStance, moving: boolean,
  item: ReloadItem = 'rifle'): number {
  return (clips ? reloadSeconds(clips, table, stance, moving, item) : null) ?? RELOAD_SECONDS_PLACEHOLDER;
}
