import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  eliminationLines, eliminationWinner, halfRounds, isMatchOver, MAX_ROUNDS, nextFollow, objectiveOf, roundBanner,
} from '../src/net/rules';
import { offeredRules, parseRules, PROTOCOL_VERSION, RESPAWN_RULES_ENABLED } from '../src/net/protocol';
import { readRules, resolveRules, RULES_KEY, rulesChoice } from '../src/rules';
import { readShare, writeShare } from '../src/shareUrl';

/**
 * The match's rules (web sprint 3, classic mode): respawn (SUPPRESSION with RESPAWN on, W3.R11) and classic (respawn
 * off, the create-game default "Respawn is disabled."), each rule from the decompilation or the disc's scripts.
 */

describe('the round count and the match (FUN_002a6c50, FUN_001fb420, the maps\' game_over script)', () => {
  it('is 11 rounds (the create-game default) and first to (11 + 1) >> 1 = 6', () => {
    expect(MAX_ROUNDS).toBe(11);
    expect(halfRounds(11)).toBe(6);
    expect(halfRounds(9)).toBe(5);
  });

  it('the banner: STARTING ROUND %d OF %d, and PLAYING TIEBREAKER ROUND past mp_max_rounds', () => {
    expect(roundBanner(1, 11)).toBe('STARTING ROUND 1 OF 11');
    expect(roundBanner(11, 11)).toBe('STARTING ROUND 11 OF 11');
    expect(roundBanner(12, 11)).toBe('PLAYING TIEBREAKER ROUND');
  });

  it('respawn: the one round is the match (success2), a draw included', () => {
    expect(isMatchOver('respawn', 1, 11, { seal: 0, terrorist: 0 })).toBe(true);
  });

  it('classic: first to 6; after the last round level plays a tiebreaker, else it is over', () => {
    expect(isMatchOver('classic', 5, 11, { seal: 0, terrorist: 5 })).toBe(false);
    expect(isMatchOver('classic', 6, 11, { seal: 0, terrorist: 6 })).toBe(true);
    expect(isMatchOver('classic', 10, 11, { seal: 5, terrorist: 5 })).toBe(false);
    expect(isMatchOver('classic', 11, 11, { seal: 5, terrorist: 5 })).toBe(false);   // the tiebreaker
    expect(isMatchOver('classic', 11, 11, { seal: 4, terrorist: 5 })).toBe(true);    // draws on the way: 5-4 wins
    expect(isMatchOver('classic', 12, 11, { seal: 6, terrorist: 5 })).toBe(true);
  });
});

describe('the round\'s end by elimination (the maps\' objectives script, sequence start)', () => {
  it('no living Terrorists is tested first: the SEALs win it; then no living SEALs', () => {
    expect(eliminationWinner({ seal: 2, terrorist: 0 })).toBe('seal');
    expect(eliminationWinner({ seal: 0, terrorist: 1 })).toBe('terrorist');
    expect(eliminationWinner({ seal: 0, terrorist: 0 })).toBe('seal');
    expect(eliminationWinner({ seal: 1, terrorist: 1 })).toBeNull();
  });

  it('posts the game\'s two lines (mp51LOC 5103-5106) at 0.7 and 0.9', () => {
    expect(eliminationLines('seal')).toEqual([{ text: 'ALL TERRORISTS ELIMINATED', scale: 0.7 }, { text: 'SEALS VICTORIOUS!', scale: 0.9 }]);
    expect(eliminationLines('terrorist')).toEqual([{ text: 'ALL SEALS ELIMINATED', scale: 0.7 }, { text: 'TERRORISTS WIN!', scale: 0.9 }]);
  });

  it('the objective by side', () => {
    expect(objectiveOf('seal')).toBe('ELIMINATE THE TERRORISTS');
    expect(objectiveOf('terrorist')).toBe('ELIMINATE THE SEALS');
  });
});

describe('the dead cycle through living teammates (FUN_001f97b0, research 91 section 12)', () => {
  it('steps to the next of the candidates in id order, wrapping; none: null', () => {
    expect(nextFollow(null, [7, 3, 5])).toBe(3);
    expect(nextFollow(3, [7, 3, 5])).toBe(5);
    expect(nextFollow(7, [7, 3, 5])).toBe(3);
    expect(nextFollow(4, [7, 3, 5])).toBe(3);                  // the followed one died: from the start
    expect(nextFollow(3, [])).toBeNull();
  });
});

describe('the rules on the wire and on the page', () => {
  it('protocol 4 carries the rules (5: the cone eye and aim; 6: the blast event and knock codes); anything else is not rules', () => {
    expect(PROTOCOL_VERSION).toBe(6);
    expect(parseRules('classic')).toBe('classic');
    expect(parseRules('respawn')).toBe('respawn');
    for (const v of [undefined, null, '', 'CLASSIC', 'deathmatch', 3]) expect(parseRules(v), String(v)).toBeNull();
  });

  it('respawn is switched off (owner ruling, 2026-09-29): classic whatever is stored or linked', () => {
    expect(RESPAWN_RULES_ENABLED).toBe(false);
    for (const v of [null, '', 'x', 'respawn', 'classic']) expect(rulesChoice(v), String(v)).toBe('classic');
    for (const q of ['', '?rules=respawn', '?map=MP2&rules=classic', '?rules=bogus', '?%E0%A4%A&rules=respawn']) {
      expect(resolveRules(q, 'respawn'), q).toEqual({ rules: 'classic', fromUrl: false });
    }
    expect(offeredRules('respawn')).toBe('classic');
    expect(offeredRules(null)).toBe('classic');
  });

  it('with the switch forced on, the respawn paths are as before: the link rules= first, then the stored choice, respawn by default', () => {
    expect(rulesChoice('classic', true)).toBe('classic');
    for (const v of [null, '', 'x', 'respawn']) expect(rulesChoice(v, true)).toBe('respawn');
    expect(resolveRules('?map=MP2&rules=classic', null, true)).toEqual({ rules: 'classic', fromUrl: true });
    expect(resolveRules('?rules=respawn', 'classic', true)).toEqual({ rules: 'respawn', fromUrl: true });
    expect(resolveRules('?rules=bogus', 'classic', true)).toEqual({ rules: 'classic', fromUrl: false });
    expect(resolveRules('', null, true)).toEqual({ rules: 'respawn', fromUrl: false });
    expect(offeredRules(undefined, true)).toBe('respawn');
    expect(offeredRules('classic', true)).toBe('classic');
  });

  it('the address carries no rules: rules= is never read and is taken out whenever the page writes its link', () => {
    expect(readShare('?rules=classic')).not.toHaveProperty('rules');
    expect(writeShare('?mode=play&map=MP2&rules=respawn&fly', { view: 'modern' })).toBe('?mode=play&map=MP2&view=modern&fly');
    expect(writeShare('?rules=classic&map=MP2', {})).toBe('?map=MP2');
  });

  describe('a choice remembered before the ruling', () => {
    let store: Map<string, string>;
    beforeEach(() => {
      store = new Map();
      (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); },
      };
    });
    afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage; });

    it('is read back under its key, and plays classic', () => {
      expect(readRules()).toBeNull();
      store.set(RULES_KEY, 'respawn');
      expect(readRules()).toBe('respawn');
      expect(resolveRules('', readRules()).rules).toBe('classic');
      expect(resolveRules('', readRules(), true).rules).toBe('respawn');
    });
  });
});
