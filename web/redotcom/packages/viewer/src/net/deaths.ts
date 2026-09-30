import type { Stance } from '../mover';
import { PART } from './damage';

/**
 * The death clip (web sprint 3, M6; research 91 section 3, `FUN_005a0700` L458831 / `FUN_005a0950` L458898): a head
 * hit plays a random clip of `damanim.rdr`'s HEAD list for the stance, a body hit one of the BODY list, a limb the
 * BODY list's first; a fall or a blast plays no death clip (their own landing and knock clips run, L461384). The
 * lists name `motion.rdr` entries by their display names; `MOTION_P.ZAR` holds them snake-cased
 * ("Death stand head01" -> `death_stand_head01`). DEATH_NAME_PLACEHOLDER: four names have no clip of their own name --
 * "Die", "Death02", "Crawl death01", "Crawl death02" -- and are read, by the lists' order and the clips left over, as
 * `death_stand_chest01`, `_chest02`, `death_stand_groin01`, `_groin02` (the groin clips' 7.4-8.1 s are the crawls).
 * The pistol variants ("Pistol death ...") are not in the SEAL's pack and are not used.
 */

const HEAD: Readonly<Record<Stance, readonly string[]>> = {
  stand: ['death_stand_head01', 'death_stand_head02', 'death_stand_head03', 'death_stand_head04'],
  crouch: ['death_crouch_head01', 'death_crouch_chest01'],
  prone: ['death_prone_chest01'],
};

const BODY: Readonly<Record<Stance, readonly string[]>> = {
  stand: [
    'death_stand_chest01', 'death_stand_chest02', 'death_stand_chest03', 'death_stand_rarm01', 'death_stand_larm01',
    'death_stand_larm02', 'death_stand_groin01', 'death_stand_groin02',
  ],
  crouch: ['death_crouch_back01', 'death_crouch_chest02'],
  prone: ['death_prone_chest01'],
};

/** Every death clip, for the page's clip request. */
export const DEATH_CLIPS: readonly string[] = [...new Set([...Object.values(HEAD), ...Object.values(BODY)].flat())];

/** One of a list at random (`FUN_005a0950`: `rand() % count`). */
const pick = (list: readonly string[], random: () => number): string => list[Math.min(list.length - 1, Math.floor(random() * list.length))]!;

/**
 * The clip a SEAL dies in, or null for a death with no clip of its own. A fall: none (its `Land forward` holds, cause 7,
 * L461387). A blast: none from the death itself (cause 4, L461387) -- the corpse is thrown by the knock (`./blast`
 * `blastKnock`, dead) -- except prone, where the knock does not throw and the game plays a clip of the BODY list for
 * prone instead (`FUN_0057e770` L441013-441015: `FUN_005a0950(actor, 3, 2)`, part 3 the body, posture 2 prone).
 */
export function deathClip(cause: 'bullet' | 'blast' | 'fall', part: number, stance: Stance, random: () => number): string | null {
  if (cause === 'blast') return stance === 'prone' ? pick(BODY.prone, random) : null;
  if (cause !== 'bullet') return null;
  if (part === PART.HEAD) return pick(HEAD[stance], random);
  const list = BODY[stance];
  if (part !== PART.BODY) return list[0]!;
  return pick(list, random);
}

/** "Press the %c button to respawn." shows from this long dead (`FUN_00592560` L451680-451701; research 91 section 4.1). */
export const RESPAWN_PROMPT_S = 5;

/** The body fades from 1 to 0 at 0.1 a second once dead (`FUN_005979a0` L454491): gone after this many seconds. */
export const BODY_FADE_S = 10;
