import { describe, expect, it } from 'vitest';
import {
  countdownText, ROUND_SCREEN_LAYOUT, roundScreenLayout, timePlayedText, type RoundScreen, type RoundText,
} from '../src/roundScreens';
import type { ScoreRowInfo } from '../src/scoreboard';
import { DEFAULT_MODEL, hudPass, ROUND_SCREEN_HIDES, SCOREBOARD_HIDES, Hud, AT_REST } from '../src/hud';
import { layoutText } from '../src/hudFont';

/** The round's end screens (web/redotcom/docs/research/91-the-round.md §18): ROUND COMPLETE, FINAL ROUND, GAME COMPLETE. */

const PS2 = { width: 640, height: 448 };
const SIZES: Record<string, { width: number; height: number }> = {
  'newweapnbkrnd.tif': { width: 128, height: 64 }, 'font_text_01.tif': { width: 512, height: 128 }, white: { width: 1, height: 1 },
};
const row = (id: number, team: 'seal' | 'terrorist', kills: number, deaths: number, score: number, over: Partial<ScoreRowInfo> = {}): ScoreRowInfo =>
  ({ id, name: `P${id}`, team, kills, deaths, score, alive: true, self: false, ...over });
const ROWS: ScoreRowInfo[] = [
  row(1, 'seal', 2, 3, 4), row(2, 'seal', 5, 1, 10, { self: true }), row(3, 'terrorist', 3, 2, 6), row(4, 'terrorist', 1, 5, 2),
];
const screen = (over: Partial<RoundScreen>): RoundScreen =>
  ({ kind: 'roundComplete', secondsLeft: 5, winner: 'seal', wins: { seal: 1, terrorist: 0 }, rows: ROWS, ...over });
const byRole = (texts: RoundText[], role: RoundText['role']): RoundText[] => texts.filter((t) => t.role === role);
const words = (texts: RoundText[], role: RoundText['role']): string[] => byRole(texts, role).map((t) => t.text);

describe('countdownText', () => {
  it('counts ROUND COMPLETE 10..1 every 0.5 s, then GO at the 5 s end', () => {
    expect(countdownText('roundComplete', 5)).toBe('10');
    expect(countdownText('roundComplete', 4.9)).toBe('10');
    expect(countdownText('roundComplete', 4.5)).toBe('9');
    expect(countdownText('roundComplete', 2.4)).toBe('5');
    expect(countdownText('roundComplete', 0.2)).toBe('1');
    expect(countdownText('roundComplete', 0)).toBe('GO');
    expect(countdownText('roundComplete', 99)).toBe('10');
  });
  it('counts FINAL ROUND 20..1 every 0.5 s, then GO at the 10 s end', () => {
    expect(countdownText('finalRound', 10)).toBe('20');
    expect(countdownText('finalRound', 9.5)).toBe('19');
    expect(countdownText('finalRound', 5)).toBe('10');
    expect(countdownText('finalRound', 0.5)).toBe('1');
    expect(countdownText('finalRound', -1)).toBe('GO');
  });
  it('has none on GAME COMPLETE', () => {
    expect(countdownText('gameComplete', 3)).toBeNull();
  });
});

describe('roundScreenLayout: ROUND COMPLETE (dlgMultiplayerRound.rdr)', () => {
  it('titles the screen, puts NEXT ROUND at (380, 45) and the countdown 110 right of it at 1.2', () => {
    const { texts } = roundScreenLayout(screen({ secondsLeft: 3 }));
    expect(words(texts, 'title')).toEqual(['ROUND COMPLETE']);
    expect(byRole(texts, 'next')[0]).toMatchObject({ text: 'NEXT ROUND', x: 380, y: 45, scale: 0.8 });
    expect(byRole(texts, 'countdown')[0]).toMatchObject({ text: '6', x: 490, y: 45, scale: 1.2 });
    expect(words(texts, 'team')).toEqual(['SEALS', 'TERRORISTS']);
    expect(byRole(texts, 'team').map((t) => [t.x, t.y])).toEqual([[27, 87], [27, 270]]);
  });

  it('writes WINNER / LOSER at (200, 90) and (200, 273), DRAW on both with no winner', () => {
    const won = byRole(roundScreenLayout(screen({ winner: 'seal' })).texts, 'result');
    expect(won.map((t) => [t.text, t.x, t.y])).toEqual([['WINNER', 200, 90], ['LOSER', 200, 273]]);
    expect(words(roundScreenLayout(screen({ winner: 'terrorist' })).texts, 'result')).toEqual(['LOSER', 'WINNER']);
    expect(words(roundScreenLayout(screen({ winner: null })).texts, 'result')).toEqual(['DRAW', 'DRAW']);
  });

  it('lists each side score-sorted: names at x 25, numbers right-justified at 319 / 379 / 439, 18 apart', () => {
    const rows = byRole(roundScreenLayout(screen({})).texts, 'row');
    const seals = rows.filter((t) => t.y < 250), terrs = rows.filter((t) => t.y > 250);
    expect(seals.filter((t) => t.x === 25).map((t) => [t.text, t.y])).toEqual([['P2', 112], ['P1', 130]]);
    expect(terrs.filter((t) => t.x === 25).map((t) => [t.text, t.y])).toEqual([['P3', 295], ['P4', 313]]);
    expect(seals.filter((t) => t.y === 112 && t.x !== 25).map((t) => [t.text, t.x, t.align])).toEqual(
      [['5', 319, 'right'], ['1', 379, 'right'], ['10', 439, 'right']]);
    expect(ROUND_SCREEN_LAYOUT.rows.max).toBe(8);
  });

  it('draws the local player in the scoreboard\'s local colour, the rest in its row colour', () => {
    const rows = byRole(roundScreenLayout(screen({})).texts, 'row');
    expect(rows.find((t) => t.text === 'P2')!.rgba).toEqual([115 / 128, 115 / 128, 12 / 128, 110 / 128]);
    expect(rows.find((t) => t.text === 'P1')!.rgba).toEqual([115 / 128, 115 / 128, 115 / 128, 110 / 128]);
  });

  it('draws no totals block and no lobby line', () => {
    const { texts } = roundScreenLayout(screen({}));
    expect(byRole(texts, 'totals')).toEqual([]);
    expect(byRole(texts, 'lobby')).toEqual([]);
  });

  it('lays glyph quads on layer 1 over an opaque backdrop, only with the font present', () => {
    const { quads, tris } = roundScreenLayout(screen({}), PS2, SIZES);
    expect(quads.length).toBeGreaterThan(0);
    expect(quads.every((q) => q.layer === 1 && q.element === 'roundScreen')).toBe(true);
    expect(tris[0]!.rgba).toEqual([0, 0, 0, 1]);
    expect(tris[0]!.p.slice(0, 4)).toEqual([0, 0, 640, 0]);
    // The title's first glyph where the font puts "R" at (27, 45), scale 1.
    const g = layoutText('ROUND COMPLETE', 27, 45, 1).glyphs[0]!;
    expect(quads.some((q) => q.texture === 'font_text_01.tif' && q.rgba[0] !== 0 && Math.abs(q.x - (g.x + g.w / 2)) < 1e-9)).toBe(true);
    expect(roundScreenLayout(screen({}), PS2, {}).quads).toEqual([]);
  });
});

describe('roundScreenLayout: FINAL ROUND (dlgMultiplayerFinal.rdr)', () => {
  it('titles FINAL ROUND, FINAL TOTALS at (380, 45), the countdown 125 right of it counting from 20', () => {
    const { texts } = roundScreenLayout(screen({ kind: 'finalRound', secondsLeft: 10, winner: 'terrorist' }));
    expect(words(texts, 'title')).toEqual(['FINAL ROUND']);
    expect(byRole(texts, 'next')[0]).toMatchObject({ text: 'FINAL TOTALS', x: 380, y: 45 });
    expect(byRole(texts, 'countdown')[0]).toMatchObject({ text: '20', x: 505, y: 45 });
    expect(words(texts, 'result')).toEqual(['LOSER', 'WINNER']);
    expect(byRole(texts, 'row').filter((t) => t.x === 25)).toHaveLength(4);
  });
});

describe('roundScreenLayout: GAME COMPLETE (dlgMultiplayerFinalReally.rdr)', () => {
  const final = (over: Partial<RoundScreen> = {}) =>
    roundScreenLayout(screen({ kind: 'gameComplete', secondsLeft: 10, winner: null, wins: { seal: 1, terrorist: 0 }, timePlayed: 367, ...over })).texts;

  it('titles GAME COMPLETE with FINAL TOTALS, no countdown, and the lobby line at (340, 423)', () => {
    const texts = final();
    expect(words(texts, 'title')).toEqual(['GAME COMPLETE']);
    expect(words(texts, 'next')).toEqual(['FINAL TOTALS']);
    expect(byRole(texts, 'countdown')).toEqual([]);
    expect(words(texts, 'lobby')).toEqual(['RETURNING TO GAME LOBBY. . .']);
  });

  it('sums each side into SEAL TOTALS (26, 127) and TERRORIST TOTALS (26, 208), right-justified at 323 / 383 / 443', () => {
    const texts = final();
    expect(byRole(texts, 'totalsLabel').map((t) => [t.text, t.x, t.y])).toEqual([['SEAL TOTALS', 26, 127], ['TERRORIST TOTALS', 26, 208]]);
    const totals = byRole(texts, 'totals');
    expect(totals.filter((t) => t.y === 127).map((t) => [t.text, t.x])).toEqual([['7', 323], ['4', 383], ['14', 443]]);
    expect(totals.filter((t) => t.y === 208).map((t) => [t.text, t.x])).toEqual([['4', 323], ['7', 383], ['8', 443]]);
  });

  it('names WINNER on the side with more rounds, blank on both when equal; the rounds under SEAL / TERRORIST ROUNDS', () => {
    expect(byRole(final(), 'result').map((t) => [t.text, t.x, t.y])).toEqual([['WINNER', 185, 131]]);
    expect(byRole(final({ wins: { seal: 2, terrorist: 5 } }), 'result').map((t) => [t.text, t.y])).toEqual([['WINNER', 213]]);
    expect(byRole(final({ wins: { seal: 3, terrorist: 3 }, winner: 'seal' }), 'result')).toEqual([]);
    const rounds = byRole(final({ wins: { seal: 2, terrorist: 5 } }), 'rounds');
    expect(rounds.map((t) => [t.text, t.x, t.y])).toEqual(
      [['SEAL ROUNDS', 220, 327], ['2', 220, 377], ['TERRORIST ROUNDS', 360, 327], ['5', 355, 377]]);
  });

  it('makes the highest score the MVP: its name at (26, 291), its numbers at 290', () => {
    const texts = final();
    expect(byRole(texts, 'mvpLabel')[0]).toMatchObject({ text: 'MVP', x: 130, y: 258, scale: 1.2 });
    expect(byRole(texts, 'mvp').map((t) => [t.text, t.x, t.y])).toEqual([['P2', 26, 291], ['5', 323, 290], ['1', 383, 290], ['10', 443, 290]]);
    expect(words(final({ mvp: 'P3' }), 'mvp')).toEqual(['P3', '3', '2', '6']);
    expect(byRole(final({ mvp: null }), 'mvp')).toEqual([]);
  });

  it('shows YOUR STATS (the self row, or `you`) and TIME PLAYED as hh:mm:ss', () => {
    expect(words(final(), 'yourStats')).toEqual(['YOUR STATS', '5', '1', '10']);
    expect(words(final({ you: { kills: 9, deaths: 8, score: 7 } }), 'yourStats')).toEqual(['YOUR STATS', '9', '8', '7']);
    expect(words(final(), 'time')).toEqual(['TIME PLAYED', '00:06:07']);
    expect(timePlayedText(3600 + 61.9)).toBe('01:01:01');
  });

  it('draws no per-player round lists', () => {
    expect(byRole(final(), 'row')).toEqual([]);
  });
});

describe('the HUD with a round screen up', () => {
  it('sets and clears the screen', () => {
    const hud = new Hud();
    expect(hud.state().model.roundScreen ?? null).toBeNull();
    const s = screen({});
    hud.setRoundScreen(s);
    expect(hud.state().model.roundScreen).toBe(s);
    hud.setRoundScreen(null);
    expect(hud.state().model.roundScreen).toBeNull();
  });

  it('hides what the scoreboard hides and the rest of the in-round HUD, and replaces the scoreboard', () => {
    for (const e of SCOREBOARD_HIDES) expect(ROUND_SCREEN_HIDES.has(e)).toBe(true);
    for (const e of ['bar', 'name', 'box', 'range', 'stance', 'banner', 'message'] as const) expect(ROUND_SCREEN_HIDES.has(e)).toBe(true);
    expect(ROUND_SCREEN_HIDES.has('fader')).toBe(false);
    const model = { ...DEFAULT_MODEL, name: 'SEAL', scoreboard: true, roundScreen: screen({}) };
    const pass = hudPass(PS2, model, SIZES, AT_REST, false, null);
    expect(pass.quads.some((q) => q.element === 'scoreboard')).toBe(false);
    expect(pass.quads.some((q) => q.element === 'roundScreen')).toBe(true);
    expect(pass.quads.some((q) => ROUND_SCREEN_HIDES.has(q.element))).toBe(false);
    // Without it, the scoreboard is back.
    const board = hudPass(PS2, { ...model, roundScreen: null }, SIZES, AT_REST, false, null);
    expect(board.quads.some((q) => q.element === 'scoreboard')).toBe(true);
    expect(board.quads.some((q) => q.element === 'roundScreen')).toBe(false);
  });
});
