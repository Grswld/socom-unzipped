import type { Rules, Team } from './protocol';

/**
 * The match's rules, shared by the server's room and the page (web sprint 3, classic mode; the owner's ruling of
 * 2026-09-29: every rule from the decompilation, the disc's scripts or reCOM, cited; what cannot be sourced is a named
 * placeholder). Sources: `analysis/socom2_game.elf.decomp.c` (`FUN_x Lnnn`), the disc's `MPxx.ZDB:MZANIM.ZAR`
 * animation `objectives` (read with `@s2u/scene` `parseAnimSets` / `decodeEffectProgram`; MP51's sequences cited, the
 * same in MP2, MP5, MP8, MP64, MP81), and web/docs/research/91-the-round.md (sections 9, 12, 18).
 */

/** `mp_max_rounds`: the create-game default, 11 (frame `A_49_creategame`; 9 if the valve is 0 at load, `FUN_001f5e70` L55628-55631). */
export const MAX_ROUNDS = 11;

/** `mp_half_rounds` = (`mp_max_rounds` + 1) >> 1 (`FUN_002a6c50` L149073): 6 of 11. */
export function halfRounds(maxRounds: number): number {
  return (maxRounds + 1) >> 1;
}

/**
 * Whether the round just scored ends the match (`mp_game_over`).
 * - respawn: the map script's `success2` sets `mp_game_over` = 1 unconditionally after the one timed round, a draw
 *   included (research 91 section 18.2.1).
 * - classic: the `objectives` sequence `game_over` (research 91 section 18.2.2): `end_of_round_round_count` =
 *   `mp_round_count` + 1 (the rounds played, this one counted); IF it is >= `mp_max_rounds`: over unless the round wins
 *   are level (then the sequence stops and a tiebreaker round is played); ELSEIF either side's wins >= `mp_half_rounds`:
 *   over.
 */
export function isMatchOver(rules: Rules, roundsPlayed: number, maxRounds: number, wins: { seal: number; terrorist: number }): boolean {
  if (rules === 'respawn') return true;
  if (roundsPlayed >= maxRounds) return wins.seal !== wins.terrorist;
  const half = halfRounds(maxRounds);
  return wins.seal >= half || wins.terrorist >= half;
}

/**
 * The round-start banner (`FUN_001fb420` L57633-57648): "STARTING ROUND %d OF %d" (0x3e3520) with `mp_round_count` + 1
 * and `mp_max_rounds`, or "PLAYING TIEBREAKER ROUND" (0x3e3540) when `mp_max_rounds` < `mp_round_count` + 1. The
 * function reads no respawn flag, so a respawn match -- one round -- still reads "STARTING ROUND 1 OF 11" (kept by
 * the owner's ruling of 2026-09-29; research 91 section 18.2.2, RESPAWN_BANNER_PLACEHOLDER: not captured on a console).
 */
export function roundBanner(round: number, maxRounds: number): string {
  return maxRounds < round ? 'PLAYING TIEBREAKER ROUND' : `STARTING ROUND ${round} OF ${maxRounds}`;
}

/**
 * Classic's round clock (MP51 `objectives`): `start` waits 5 s then 10 s before its elimination loop, and
 * `mission_timer` waits 15 s before it watches `mp_timer`: neither ends a round in its first 15 s.
 */
export const ROUND_WATCH_S = 5 + 10;
/**
 * After an elimination: `start`'s WAIT 2 (the sound, then the music), `success` / `failure`'s WAIT 20, `round_count`
 * += 1 and `game_over`, WAIT 1, then `mission_complete` / `mission_failure` = 1 -- the round's end state, which the
 * engine reads 3 s later (`FUN_002a9b30` L150612-150672) as for any round.
 */
export const ELIMINATED_HOLD_S = 2 + 20 + 1;

/**
 * Who an elimination makes the winner (MP51 `objectives` sequence `start`, its WHILE loop): `aiteam_08` == 0 (no living
 * Terrorists) is tested first, so the SEALs win it -- also when both sides fell together; then `aiteam_00` == 0 (no
 * living SEALs): the Terrorists. Null while both have a living player.
 */
export function eliminationWinner(living: { seal: number; terrorist: number }, seated?: { seal: number; terrorist: number }): Team | null {
  // `seated` (the room's single-player match, SOLO_ROUND_PLACEHOLDER): a side with nobody on it is never eliminated.
  if (living.terrorist === 0 && (!seated || seated.terrorist > 0)) return 'seal';
  if (living.seal === 0 && (!seated || seated.seal > 0)) return 'terrorist';
  return null;
}

/**
 * The two MESSAGE lines the elimination posts (MP51 `objectives` `start`; `mp51LOC` 5103-5106): the side eliminated
 * at 0.7, the winner at 0.9 (research 91 section 18.2.3).
 */
export function eliminationLines(winner: Team): { text: string; scale: number }[] {
  return winner === 'seal'
    ? [{ text: 'ALL TERRORISTS ELIMINATED', scale: 0.7 }, { text: 'SEALS VICTORIOUS!', scale: 0.9 }]
    : [{ text: 'ALL SEALS ELIMINATED', scale: 0.7 }, { text: 'TERRORISTS WIN!', scale: 0.9 }];
}

/**
 * The objective under "OBJECTIVE:" 5 s into a round, by `player_team` (MP51 `objectives` `start` / `start2`: the raw
 * names 38-40, research 91 section 18.2.3). The rooms run SUPPRESSION's rules on every map, so every map's objective is
 * SUPPRESSION's (OBJECTIVE_BY_MAP_PLACEHOLDER: the other game types' objectives are not read).
 */
export function objectiveOf(team: Team | null): string {
  return team === 'terrorist' ? 'ELIMINATE THE SEALS' : 'ELIMINATE THE TERRORISTS';
}

/**
 * The dead's camera (research 91 section 12; `FUN_001f97b0` L57000-57007 "cycle through living teammates"): the next
 * of `candidates` (the living teammates' ids) after `current` in id order, wrapping; from the first when `current` is
 * none or no longer a candidate; null with none.
 */
export function nextFollow(current: number | null, candidates: readonly number[]): number | null {
  const ids = [...candidates].sort((a, b) => a - b);
  if (!ids.length) return null;
  const at = current === null ? -1 : ids.indexOf(current);
  return ids[(at + 1) % ids.length]!;
}
