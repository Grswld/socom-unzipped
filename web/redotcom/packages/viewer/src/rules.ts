import { parseRules, type Rules } from './net/protocol';
import { readShare } from './shareUrl';

/**
 * The settings' **Rules** choice under Online (web sprint 3, classic mode): Respawn (the one timed round, W3.R11) or
 * Classic (respawn off, the create-game default: 11 rounds, first to 6; `./net/rules`). The room joined is the map's
 * under those rules. The address's `rules=respawn|classic` wins over the remembered choice (`RULES_KEY`), and the page
 * writes the choice back into the address through the links' module (`./shareUrl` `updateAddress({ rules })`).
 */

/** Where the choice is remembered. */
export const RULES_KEY = 's2u.viewer.rules';
/** A stored value, read back: one of the two, or respawn. */
export function rulesChoice(stored: string | null): Rules {
  return parseRules(stored) ?? 'respawn';
}

/** The rules the page joins with: the address's `rules=` first (when it names rules), else the stored choice. */
export function resolveRules(search: string, stored: string | null): { rules: Rules; fromUrl: boolean } {
  const asked = readShare(search).rules;
  return asked ? { rules: asked, fromUrl: true } : { rules: rulesChoice(stored), fromUrl: false };
}

/** The remembered choice, best-effort both ways (storage throws in a private window). */
export function readRules(): string | null {
  try { return globalThis.localStorage?.getItem(RULES_KEY) ?? null; } catch { return null; }
}
export function writeRules(rules: Rules): void {
  try { globalThis.localStorage?.setItem(RULES_KEY, rules); } catch { /* respawn next time */ }
}
