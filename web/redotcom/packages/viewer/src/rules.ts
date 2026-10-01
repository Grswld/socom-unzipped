import { offeredRules, parseRules, RESPAWN_RULES_ENABLED, type Rules } from './net/protocol';

/**
 * The rules the page joins a match with (web sprint 3, classic mode).
 *
 * Owner ruling, 2026-09-29: "Remove the respawn option entirely for the time being. No mode selection." With
 * `RESPAWN_RULES_ENABLED` off -- today -- the page plays **classic** (respawn off, the create-game default: 11 rounds,
 * first to 6; `./net/rules`) online and offline, the settings have no Rules choice, and neither the address's `rules=`
 * nor a remembered choice (`RULES_KEY`, from before the ruling) is read: an old `rules=respawn` link lands in classic,
 * and the page takes `rules` out of its address (`./shareUrl`). The respawn ruleset's code stays behind the switch; with
 * it on, the link's `rules=` and then the remembered choice decide, respawn by default, as before the ruling.
 */

/** Where the choice was remembered before the ruling (read only while respawn is offered). */
export const RULES_KEY = 's2u.viewer.rules';

/** A stored value, read back as the rules the page may join with (classic while respawn is off). */
export function rulesChoice(stored: string | null, respawnEnabled: boolean = RESPAWN_RULES_ENABLED): Rules {
  return offeredRules(parseRules(stored), respawnEnabled);
}

/**
 * The rules the page joins with. Respawn off: classic, whatever the address or the storage say. On: the address's
 * `rules=` first (when it names rules), else the stored choice.
 */
export function resolveRules(search: string, stored: string | null, respawnEnabled: boolean = RESPAWN_RULES_ENABLED): { rules: Rules; fromUrl: boolean } {
  if (!respawnEnabled) return { rules: 'classic', fromUrl: false };
  let asked: Rules | null = null;
  try { asked = parseRules(new URLSearchParams(search).get('rules')?.toLowerCase()); } catch { /* a malformed query names nothing */ }
  return asked ? { rules: asked, fromUrl: true } : { rules: rulesChoice(stored, true), fromUrl: false };
}

/** The remembered choice, best-effort (storage throws in a private window). Nothing writes it while there is no choice. */
export function readRules(): string | null {
  try { return globalThis.localStorage?.getItem(RULES_KEY) ?? null; } catch { return null; }
}
