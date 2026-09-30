import { describe, expect, it } from 'vitest';
import { cutLine, DEFAULT_PLAYER, SCORE_LAYOUT, scoreboardLayout } from '../src/scoreboard';
import { layoutText, textWidth } from '../src/hudFont';
import type { ScoreRowInfo } from '../src/scoreboard';
import { DEFAULT_MODEL, Hud, hudLayout } from '../src/hud';

/** The multiplayer round's scoreboard (web/redotcom/docs/research/87-hud.md §12): SELECT held, `FUN_0022a8b0`'s layout. */

const PS2 = { width: 640, height: 448 };
const SIZES: Record<string, { width: number; height: number }> = {
  'newweapnbkrnd.tif': { width: 128, height: 64 }, 'font_text_01.tif': { width: 512, height: 128 }, white: { width: 1, height: 1 },
};
const info = { player: 'SEAL', game: 'FROSTFIRE', type: 'SUPPRESSION' };

describe('scoreboardLayout', () => {
  it('nine-slices the panel over x 153..630, y 104..430, 20-pixel corners, alpha 100', () => {
    const { quads } = scoreboardLayout(PS2, info, SIZES);
    const slice = quads.filter((q) => q.texture === 'newweapnbkrnd.tif').slice(0, 9);
    const x0 = Math.min(...slice.map((q) => q.x - q.w / 2)), x1 = Math.max(...slice.map((q) => q.x + q.w / 2));
    const y0 = Math.min(...slice.map((q) => q.y - q.h / 2)), y1 = Math.max(...slice.map((q) => q.y + q.h / 2));
    expect([x0, x1, y0, y1]).toEqual([153, 630, 104, 430]);
    expect(slice[0]).toMatchObject({ w: 20, h: 20, u0: 128, u1: 128 - (20 / 173) * 128 });    // the left corner mirrored
    for (const q of slice) expect(q.rgba).toEqual([1, 1, 1, 100 / 128]);
    expect(quads.every((q) => q.layer === 1)).toBe(true);
  });

  it('puts the team bars under it: SEALs (32, 32, 64) at 104, TERRORISTS (64, 32, 32) at 267, 25 high, alpha 80', () => {
    const { tris } = scoreboardLayout(PS2, info, SIZES);
    expect(tris).toHaveLength(4);
    expect(tris[0]!.p.slice(0, 2)).toEqual([153, 104]);
    expect(tris[2]!.p.slice(0, 2)).toEqual([153, 267]);
    expect(tris[0]!.rgba).toEqual([32 / 255, 32 / 255, 64 / 255, 80 / 128]);
    expect(tris[2]!.rgba).toEqual([64 / 255, 32 / 255, 32 / 255, 80 / 128]);
    expect(SCORE_LAYOUT.teams[1]!.y).toBe(267);
  });

  it('writes the one SEAL on the first row (y 142) in the local player\'s yellow, the columns 0, the rest empty', () => {
    const { quads } = scoreboardLayout(PS2, info, SIZES);
    const glyphs = quads.filter((q) => q.texture === 'font_text_01.tif' && q.rgba[0] !== 0);
    const yellow = glyphs.filter((q) => q.rgba[2] === 12 / 128);
    // "SEAL" and three zeros: 7 glyphs; their feet on the baseline 142.
    expect(yellow).toHaveLength(4 + 3);
    const name = yellow.filter((q) => q.x < 300);
    expect(Math.min(...name.map((q) => q.x - q.w / 2))).toBeCloseTo(223 - 0.6, 6);
  });

  it('cuts a detail line to 118 wide with a trailing dash', () => {
    const long = cutLine('A VERY LONG GAME NAME INDEED', 0.8, 118);
    expect(long.endsWith('-')).toBe(true);
    expect(textWidth(long, 0.8)).toBeLessThanOrEqual(118);
    expect(cutLine('LAN game', 0.8, 118)).toBe('LAN game');
    expect(DEFAULT_PLAYER).toBe('SEAL');
  });
});

describe('the HUD with the scoreboard up', () => {
  it('hides the ammo box, the compass, the prompts and the timer', () => {
    const hud = new Hud();
    hud.setScoreboard(true);
    expect(hud.state().model.scoreboard).toBe(true);
    // hudLayout itself still lays them out; the pass drops them (SCOREBOARD_HIDES) and adds the board.
    expect(hudLayout(PS2, { ...DEFAULT_MODEL, scoreboard: true }, { 'newweapnbkrnd.tif': { width: 128, height: 64 } }).rects.panel).toBeDefined();
  });

  it('hides the ammo box while scoped, where the zoom readout stands', () => {
    const sizes = { 'newweapnbkrnd.tif': { width: 128, height: 64 }, 'font_text_01.tif': { width: 512, height: 128 } };
    expect(hudLayout(PS2, { ...DEFAULT_MODEL, zoom: 1 }, sizes).rects.panel).toBeDefined();
    const scoped = hudLayout(PS2, { ...DEFAULT_MODEL, zoom: 3 }, sizes).rects;
    expect(scoped.panel).toBeUndefined();
    expect(scoped.rounds).toBeUndefined();
    expect(scoped.zoom).toBeDefined();
  });
});

describe('scoreboardLayout with every player (research 91 §11, §18)', () => {
  const row = (id: number, team: 'seal' | 'terrorist', score: number, over: Partial<ScoreRowInfo> = {}): ScoreRowInfo =>
    ({ id, name: `P${id}`, team, kills: id, deaths: 1, score, alive: true, self: false, ...over });
  /** The text quads (not shadows) of `line` laid at the pen and baseline, as the layout draws them. */
  const drawn = (quads: ReturnType<typeof scoreboardLayout>['quads'], line: string, x: number, y: number, scale = 0.8, centre = false) => {
    const g = layoutText(line, centre ? x - textWidth(line, scale) / 2 : x, y, scale).glyphs;
    const hit = g.map((h) => quads.find((q) => q.texture === 'font_text_01.tif' && q.rgba[0] !== 0
      && Math.abs(q.x - (h.x + h.w / 2)) < 1e-6 && Math.abs(q.y - (h.y + h.h / 2)) < 1e-6 && q.u0 === h.u0));
    return hit.every((q) => q) ? hit as typeof quads : [];   // the whole string, or none
  };
  const base = (team: 0 | 1, i: number): number => SCORE_LAYOUT.teams[team]!.y + 38 + 16.8 * i;
  const rows = [
    row(1, 'seal', 5), row(2, 'seal', 9, { self: true }), row(3, 'seal', 5), row(4, 'seal', 1, { alive: false }), row(5, 'seal', 7),
    row(6, 'terrorist', 2), row(7, 'terrorist', 3), row(8, 'terrorist', 3), row(9, 'terrorist', 0),
  ];

  it('sorts each team by score, ties in the given order, in its own panel', () => {
    const { quads } = scoreboardLayout(PS2, { ...info, rows, spectators: [] }, SIZES);
    ['P2', 'P5', 'P1', 'P3', 'P4'].forEach((n, i) => expect(drawn(quads, n, 223, base(0, i)).length).toBeGreaterThan(0));
    ['P7', 'P8', 'P6', 'P9'].forEach((n, i) => expect(drawn(quads, n, 223, base(1, i)).length).toBeGreaterThan(0));
    expect(drawn(quads, 'P9', 223, base(0, 3))).toHaveLength(0);
    // the row after the last SEAL is empty
    expect(quads.filter((q) => q.texture === 'font_text_01.tif' && q.rgba[0] !== 0 && Math.abs(q.y - base(0, 5)) < 6)).toHaveLength(0);
  });

  it('writes kills, deaths and score on the columns, the local player in yellow', () => {
    const { quads } = scoreboardLayout(PS2, { ...info, rows }, SIZES);
    expect(drawn(quads, 'P2', 223, base(0, 0)).every((q) => q.rgba[2] === 12 / 128 && q.rgba[3] === 110 / 128)).toBe(true);
    expect(drawn(quads, '9', 588, base(0, 0), 0.8, true).length).toBeGreaterThan(0);
    expect(drawn(quads, 'P5', 223, base(0, 1)).every((q) => q.rgba[2] === 115 / 128)).toBe(true);
  });

  it('scales the dead row\'s colours by 0.6', () => {
    const { quads } = scoreboardLayout(PS2, { ...info, rows }, SIZES);
    const dead = drawn(quads, 'P4', 223, base(0, 4));
    expect(dead.length).toBeGreaterThan(0);
    for (const q of dead) {
      expect(q.rgba[0]).toBeCloseTo((115 / 128) * 0.6, 6);
      expect(q.rgba[3]).toBeCloseTo((110 / 128) * 0.6, 6);
    }
  });

  it('cuts a team of 10 to its best 8', () => {
    const many = Array.from({ length: 10 }, (_, i) => row(i + 1, 'terrorist', i));
    const { quads } = scoreboardLayout(PS2, { ...info, rows: many }, SIZES);
    expect(drawn(quads, 'P10', 223, base(1, 0)).length).toBeGreaterThan(0);
    expect(drawn(quads, 'P3', 223, base(1, 7)).length).toBeGreaterThan(0);
    expect(drawn(quads, 'P2', 223, base(1, 8))).toHaveLength(0);
  });

  it('lists the spectators at (24, 270 + 16.8 i), at most 8, and the rounds won on the team lines', () => {
    const names = Array.from({ length: 10 }, (_, i) => `S${i}`);
    const { quads } = scoreboardLayout(PS2, { ...info, rows, spectators: names, wins: { seal: 2, terrorist: 1 } }, SIZES);
    for (let i = 0; i < 8; i++) expect(drawn(quads, names[i]!, 24, 270 + 16.8 * i).length).toBeGreaterThan(0);
    expect(drawn(quads, 'S8', 24, 270 + 16.8 * 8)).toHaveLength(0);
    expect(drawn(quads, 'SEALs :   2', 171, 124, 1).length).toBeGreaterThan(0);
    expect(drawn(quads, 'TERRORISTS :   1', 171, 287, 1).length).toBeGreaterThan(0);
  });

  it('without rows is today\'s single SEAL row, whatever the spectators', () => {
    const a = scoreboardLayout(PS2, info, SIZES), b = scoreboardLayout(PS2, { ...info, rows: undefined }, SIZES);
    expect(b).toEqual(a);
    const { quads } = scoreboardLayout(PS2, { ...info, wins: { seal: 3, terrorist: 3 } }, SIZES);
    expect(drawn(quads, 'SEALs :   0', 171, 124, 1).length).toBeGreaterThan(0);
  });

  it('Hud.setScoreRows feeds the model; null returns to the single row', () => {
    const hud = new Hud();
    hud.setScoreRows(rows, ['S'], { seal: 1, terrorist: 0 });
    expect(hud.state().model.scoreRows).toEqual({ rows, spectators: ['S'], wins: { seal: 1, terrorist: 0 } });
    hud.setScoreRows(null, []);
    expect(hud.state().model.scoreRows.rows).toBeNull();
  });
});
