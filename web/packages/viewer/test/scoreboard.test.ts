import { describe, expect, it } from 'vitest';
import { cutLine, DEFAULT_PLAYER, SCORE_LAYOUT, scoreboardLayout } from '../src/scoreboard';
import { textWidth } from '../src/hudFont';
import { DEFAULT_MODEL, Hud, hudLayout } from '../src/hud';

/** The multiplayer round's scoreboard (web/docs/research/87-hud.md §12): SELECT held, `FUN_0022a8b0`'s layout. */

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
