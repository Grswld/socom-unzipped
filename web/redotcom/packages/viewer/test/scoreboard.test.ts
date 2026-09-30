import { describe, expect, it } from 'vitest';
import { cutLine, DEFAULT_PLAYER, MODERN_SCOREBOARD_LIFT, SCORE_LAYOUT, SCORE_TOP, scoreboardLayout } from '../src/scoreboard';
import { layoutText, textWidth } from '../src/hudFont';
import type { ScoreRowInfo } from '../src/scoreboard';
import {
  AT_REST, DEFAULT_MODEL, Hud, hudLayout, hudPass, MODERN_SCOREBOARD_MARGIN, MODERN_SCOREBOARD_MIN_SCALE, modernScoreboardFit,
  SCOREBOARD_HIDES, SCOREBOARD_KEEPS_BOTTOM,
} from '../src/hud';

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

  describe("the Modern presentation's lift (owner ruling 2026-09-29)", () => {
    const model = { ...DEFAULT_MODEL, scoreboard: true, name: 'SEAL', game: { name: 'FROSTFIRE', type: 'SUPPRESSION' }, message: 'SEAL falls to their death' };
    const board = (frame: { width: number; height: number }, presentation: 'native' | 'ps2') =>
      hudPass(frame, model, SIZES, AT_REST, false, null, presentation);
    const boardQuads = (frame: { width: number; height: number }, presentation: 'native' | 'ps2') =>
      board(frame, presentation).quads.filter((q) => q.element === 'scoreboard');
    const top = (qs: { y: number; h: number }[]): number => Math.min(...qs.map((q) => q.y - q.h / 2));
    // 16:9, 4:3, the narrowest (a phone held upright), and the PS2 frame itself.
    const frames = [{ width: 1920, height: 1080 }, { width: 1024, height: 768 }, { width: 390, height: 844 }, PS2];

    it('is a modest, positive lift', () => {
      expect(MODERN_SCOREBOARD_LIFT).toBeGreaterThan(0);
      expect(MODERN_SCOREBOARD_LIFT).toBeLessThanOrEqual(SCORE_TOP - 99);
    });

    it("raises the board's top by the lift in Modern and scales it about its top-centre, at every aspect", () => {
      for (const f of frames) {
        const s = f.height / 448, fit = modernScoreboardFit(f, SIZES);
        const modern = board(f, 'native'), ps2 = board(f, 'ps2');
        const m = modern.quads.filter((q) => q.element === 'scoreboard'), p = ps2.quads.filter((q) => q.element === 'scoreboard');
        expect(top(m)).toBeCloseTo((SCORE_TOP - MODERN_SCOREBOARD_LIFT) * s, 6);
        expect(top(p)).toBeCloseTo(SCORE_TOP * s, 6);
        expect(m).toHaveLength(p.length);
        const k = fit.scale, cx = f.width / 2, ty = (SCORE_TOP - MODERN_SCOREBOARD_LIFT) * s;
        m.forEach((q, i) => {
          expect(q.x).toBeCloseTo(cx + (p[i]!.x - cx) * k, 6);
          expect(q.y).toBeCloseTo(ty + (p[i]!.y - SCORE_TOP * s) * k, 6);
          expect(q.w).toBeCloseTo(p[i]!.w * k, 6); expect(q.h).toBeCloseTo(p[i]!.h * k, 6);
        });
        const mt = modern.tris.filter((t) => t.layer === 1), pt = ps2.tris.filter((t) => t.layer === 1);
        mt.forEach((t, i) => t.p.forEach((v, j) => expect(v).toBeCloseTo(j % 2 ? ty + (pt[i]!.p[j]! - SCORE_TOP * s) * k : cx + (pt[i]!.p[j]! - cx) * k, 6)));
      }
    });

    describe('shrinks just enough to clear the bottom HUD (owner ruling 2026-09-29: "a bit smaller")', () => {
      // 16:9, 21:9, 16:10, 4:3, a phone held sideways and upright.
      const aspects = [
        { name: '16:9', f: { width: 1920, height: 1080 }, scale: 0.8957 }, { name: '21:9', f: { width: 2560, height: 1080 }, scale: 1 },
        { name: '16:10', f: { width: 1920, height: 1200 }, scale: 0.8911 }, { name: '4:3', f: { width: 1024, height: 768 }, scale: 0.8911 },
        { name: 'phone landscape', f: { width: 812, height: 375 }, scale: 0.9602 }, { name: 'phone portrait', f: { width: 390, height: 844 }, scale: 0.8911 },
      ];
      // Every bottom element the board leaves up, at its widest: the name on the bar, a range, the stance word shown, zoomed.
      const busy = { ...model, range: 999, zoom: 10 };
      const rect = (qs: { x: number; y: number; w: number; h: number }[]) => ({
        x0: Math.min(...qs.map((q) => q.x - q.w / 2)), x1: Math.max(...qs.map((q) => q.x + q.w / 2)),
        y0: Math.min(...qs.map((q) => q.y - q.h / 2)), y1: Math.max(...qs.map((q) => q.y + q.h / 2)),
      });

      it('names the margin and the minimum', () => {
        expect(MODERN_SCOREBOARD_MARGIN).toBe(4);
        expect(MODERN_SCOREBOARD_MIN_SCALE).toBe(0.75);
        expect(SCOREBOARD_KEEPS_BOTTOM.every((e) => !SCOREBOARD_HIDES.has(e))).toBe(true);
      });

      for (const a of aspects) {
        it(`${a.name}: scale ${a.scale}, the board's bottom clear of every bottom element it stands over`, () => {
          const s = a.f.height / 448, fit = modernScoreboardFit(a.f, SIZES);
          expect(fit.fits).toBe(true);
          expect(fit.scale).toBeGreaterThanOrEqual(MODERN_SCOREBOARD_MIN_SCALE);
          expect(fit.scale).toBeLessThanOrEqual(1);
          expect(fit.scale).toBeCloseTo(a.scale, 4);
          for (const stance of ['stand', 'crouch', 'prone'] as const) {
            const pass = hudPass(a.f, { ...busy, stance }, SIZES, { fade: 1, stance: 1, pulse: 0 }, false, null, 'native');
            const b = rect(pass.quads.filter((q) => q.element === 'scoreboard'));
            const kept = SCOREBOARD_KEEPS_BOTTOM.filter((e) => pass.quads.some((q) => q.element === e));
            expect(kept.length).toBeGreaterThanOrEqual(5);
            for (const e of kept) {
              const r = rect(pass.quads.filter((q) => q.element === e)), m = MODERN_SCOREBOARD_MARGIN * s - 1e-6;
              const beside = r.x0 - b.x1 >= m || b.x0 - r.x1 >= m;
              if (!beside) expect(r.y0 - b.y1, `${a.name} ${e}`).toBeGreaterThanOrEqual(m);
            }
            // Nothing left up but the kept bottom HUD, the message window, the board, and the scope's mid-screen range line.
            expect([...new Set(pass.quads.map((q) => q.element))].filter((e) =>
              !['scoreboard', 'banner', 'message', 'scopeRange', ...SCOREBOARD_KEEPS_BOTTOM].includes(e))).toEqual([]);
          }
          // The top stays under the message window: the lift's place, whatever the scale.
          const qs = board(a.f, 'native').quads, above = qs.filter((q) => q.element === 'banner' || q.element === 'message');
          expect(top(boardQuads(a.f, 'native'))).toBeCloseTo((SCORE_TOP - MODERN_SCOREBOARD_LIFT) * s, 6);
          expect(top(boardQuads(a.f, 'native'))).toBeGreaterThanOrEqual(Math.max(...above.map((q) => q.y + q.h / 2)) - 1e-9);
          // The text scale: every glyph cell is the PS2 place's times the scale, never under the minimum.
          const glyph = (p: 'native' | 'ps2') => boardQuads(a.f, p).filter((q) => q.texture === 'font_text_01.tif');
          const gm = glyph('native'), gp = glyph('ps2');
          gm.forEach((q, i) => { expect(q.h / gp[i]!.h).toBeCloseTo(fit.scale, 6); expect(q.h / gp[i]!.h).toBeGreaterThanOrEqual(MODERN_SCOREBOARD_MIN_SCALE); });
        });
      }

      it('leaves the message window exactly where it was', () => {
        for (const a of aspects) {
          const pick = (p: 'native' | 'ps2') => board(a.f, p).quads.filter((q) => q.element === 'banner' || q.element === 'message');
          expect(pick('native')).toEqual(pick('ps2'));
          expect(pick('native')).toEqual(hudLayout(a.f, model, SIZES).quads.filter((q) => q.element === 'banner' || q.element === 'message'));
        }
      });

      it('scale 1 is the lift alone, bit for bit', () => {
        for (const a of aspects) expect(scoreboardLayout(a.f, info, SIZES, MODERN_SCOREBOARD_LIFT, 1)).toEqual(scoreboardLayout(a.f, info, SIZES, MODERN_SCOREBOARD_LIFT));
      });
    });

    it('stays clear of the message window above it at every aspect', () => {
      for (const f of frames) {
        const all = board(f, 'native').quads;
        const above = all.filter((q) => q.element === 'banner' || q.element === 'message');
        expect(above.length).toBeGreaterThan(0);
        const bottom = Math.max(...above.map((q) => q.y + q.h / 2));
        expect(top(boardQuads(f, 'native'))).toBeGreaterThanOrEqual(bottom - 1e-9);
      }
    });

    it("leaves the PS2 presentation pixel-identical to the game's place", () => {
      for (const f of frames) {
        const direct = scoreboardLayout(f, { player: 'SEAL', game: 'FROSTFIRE', type: 'SUPPRESSION' }, SIZES);
        const ps2 = board(f, 'ps2');
        expect(ps2.quads.filter((q) => q.element === 'scoreboard')).toEqual(direct.quads);
        expect(ps2.tris).toEqual(direct.tris);
      }
      // The default is the PS2 place: lift 0.
      expect(scoreboardLayout(PS2, info, SIZES, 0)).toEqual(scoreboardLayout(PS2, info, SIZES));
      // A digest of the PS2 board's quads and shapes, pinned (every place and size summed): any move shows here.
      const pinned = scoreboardLayout(PS2, info, SIZES), sum = (ns: number[]): number => Math.round(ns.reduce((t, n) => t + n, 0) * 1000) / 1000;
      expect({ quads: pinned.quads.length, x: sum(pinned.quads.map((q) => q.x)), y: sum(pinned.quads.map((q) => q.y)),
        w: sum(pinned.quads.map((q) => q.w)), h: sum(pinned.quads.map((q) => q.h)), tris: sum(pinned.tris.flatMap((t) => t.p)) }).toMatchInlineSnapshot(`
          {
            "h": 5968,
            "quads": 229,
            "tris": 7074,
            "w": 7494.2,
            "x": 57616.5,
            "y": 44094.4,
          }
        `);
    });
  });
});
