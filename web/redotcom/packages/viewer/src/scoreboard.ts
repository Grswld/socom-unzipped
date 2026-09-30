import { FONT_TEXT_01, layoutText, textWidth } from './hudFont';
import type { HudQuad, HudTri } from './hud';

/**
 * The multiplayer round's scoreboard (web/docs/research/87-hud.md §12): what SOCOM II shows while SELECT is held in a
 * round -- `FUN_0022be20` (L79675) builds it on the press (`FUN_0022cc10` L79974), rebuilds it every second while held
 * and hides it on the release (`FUN_0022bb30`); `FUN_0022a8b0` (L79100) draws it; while it is up the ammo box, the
 * compass, the prompts, the reticle and the timer are hidden (L56808-56828). Two parts: the team tables (SEALs above,
 * TERRORISTS below) on a nine-sliced `newweapnbkrnd.tif`, and the left column's GAME DETAILS and SPECTATORS.
 *
 * The viewer fills it with what it has: one SEAL (the player's name, or `DEFAULT_PLAYER`), no terrorists, no
 * spectators, the scores 0; the game details are the LAN game's lines (`"LAN game"`, the game's name, its type).
 */

/** The panel's top: the message window's bottom (91) + its YMargin (8) + 5 (`0x436aa8`/`0x436ae8`). */
export const SCORE_TOP = 104;
/**
 * The Modern presentation's lift, in the 640x448 frame's pixels (owner ruling 2026-09-29: "try to bump up the location
 * of the scoreboard a bit when in modern mode"): the whole scoreboard -- the panel, the team bars, the rows, GAME
 * DETAILS and SPECTATORS -- drawn this much higher. 4 is what the gap to what sits above it allows: the message window
 * (`HUD_LAYOUT.message`: its panel y 0..99, its newest line's glyph cells, drop shadow included, down to ~99.9 at scale
 * 1), centre-anchored and height-scaled like the board, so the gap is the same at every aspect; the board's top at 100
 * stays clear of both. The compass above the right end is hidden while the board is up. The PS2 presentation keeps
 * the game's 104 (lift 0).
 */
export const MODERN_SCOREBOARD_LIFT = 4;
export const SCORE_LAYOUT = {
  /** The team tables' nine-slice over x 153..630, y 104..430 (`FUN_0022ae90` L79223), alpha 100. */
  panel: { x0: 153, x1: 630, y0: SCORE_TOP, y1: 430, corner: 20, alpha: 100 / 128 },
  /** The corners' texels as fractions: 20/173 across, 20/74 down (`DAT_003e5718` 0.8844, `DAT_003e5720` 0.2703). */
  cornerUv: { u: 20 / 173, v: 20 / 74 },
  /** SEALs from the top, TERRORISTS from the panel's middle, (104 + 430) / 2 = 267 (`FUN_00229d00` L78846). */
  teams: [
    { name: 'SEALs', y: SCORE_TOP, header: [32, 32, 64] as [number, number, number] },
    { name: 'TERRORISTS', y: (SCORE_TOP + 430) / 2, header: [64, 32, 32] as [number, number, number] },
  ],
  /** A team's header bar: untextured, x 153..630, 25 high, alpha 80. */
  header: { h: 25, alpha: 80 / 128 },
  /** The header's line "SEALs :   %d" at the pen (171, y + 20), scale 1, alpha 90; the columns centred on y + 20. */
  title: { x: 171, dy: 20, scale: 1, alpha: 90 / 128 },
  /** "KILLS" (locale 60523), "DEATH", "SCORE" centred on 455, 522, 588 (175 and 175/3 from `DAT_003dc8e8`). */
  columns: [{ text: 'KILLS', x: 455 }, { text: 'DEATH', x: 522 }, { text: 'SCORE', x: 588 }],
  /** Rows: baseline y + 38 + 16.8 i, 8 a team, scale 0.8; the clan tag at 163, the name at 223 (`FUN_0022a290`). */
  rows: { dy: 38, pitch: 16.8, max: 8, scale: 0.8, clanX: 163, nameX: 223 },
  /** Row colours: (115, 115, 115) alpha 110; the local player's blue 12; the clan tag (128, 64, 32). */
  rowRgb: [115, 115, 115] as [number, number, number], localRgb: [115, 115, 12] as [number, number, number],
  clanRgb: [128, 64, 32] as [number, number, number], rowAlpha: 110 / 128,
  /** Odd rows' stripes: x 161..624, baseline - 12 .. + 4, `newweapnbkrnd`'s centre texel, alpha 60. */
  stripe: { x0: 161, x1: 624, up: 12, down: 4, alpha: 60 / 128 },
  /** The left column: x 10..152; its headers green (64, 128, 64) alpha 80, 25 high (`DAT_00412e68`, `FUN_0022ac30`). */
  left: {
    x0: 10, x1: 152, headerRgb: [64, 128, 64] as [number, number, number], headerAlpha: 80 / 128,
    details: { y0: SCORE_TOP, y1: 229, title: 'GAME DETAILS', titleAt: [20, 124] as [number, number] },
    spectators: { y0: 229, y1: 430, title: 'SPECTATORS', titleAt: [20, 249] as [number, number] },
    /** The detail lines at the pen x 24, y 145 / 165 / 185, scale 0.8, cut with "-" to 118 wide. */
    lines: { x: 24, ys: [145, 165, 185], scale: 0.8, width: 118 },
  },
} as const;

/** The viewer's SEAL when no name is set. */
export const DEFAULT_PLAYER = 'SEAL';

/** What the scoreboard shows. */
export interface ScoreboardInfo {
  /** The player's name (`hud.setPlayerName`), the one SEAL row. */
  player: string;
  /** The game's name (the viewer's: the map's) and its type (`BREACH`, `DEMOLITION`, ... `SUPPRESSION`). */
  game: string; type: string;
  /**
   * Every player of the round (`net`'s `ScoreRow`, plus `self`): absent is the single SEAL row above. Each team's rows are
   * sorted by `score` descending, ties in the order given (join order), cut to 8 (research 91 §11). Ghosts and nameless
   * players are the caller's to leave out.
   */
  rows?: ScoreRowInfo[];
  /** The spectators' names, the SPECTATORS panel's lines (87 §12: up to 8). */
  spectators?: string[];
  /** Rounds won, the team lines' number (87 §12 [inferred], 91 §18); with `rows` only, default 0. */
  wins?: { seal: number; terrorist: number };
}

/** One player's scoreboard row; KILLS / DEATH / SCORE are the match totals (91 §18). */
export interface ScoreRowInfo {
  id: number; name: string; team: 'seal' | 'terrorist'; kills: number; deaths: number; score: number; alive: boolean;
  /** The local player: drawn in `localRgb`, as the single-row layout does. */
  self: boolean;
}

/** The dead rows' colour factor (`0x3f19999a`, `FUN_0022a290` L79022-79024, research 91 §11). */
export const DEAD_DIM = 0.6;
/** The SPECTATORS names: pen (24, 270 + 16.8 i), scale 0.8, up to 8 (research 87 §12). */
export const SPECTATOR_LINES = { x: 24, y0: 270, pitch: 16.8, max: 8 } as const;

/** A detail line cut to `width` at `scale` with a trailing "-", as `FUN_0022ac30` does. */
export function cutLine(text: string, scale: number, width: number): string {
  if (textWidth(text, scale) <= width) return text;
  let t = text;
  while (t.length > 0 && textWidth(`${t}-`, scale) > width) t = t.slice(0, -1);
  return `${t}-`;
}

type Rgba4 = [number, number, number, number];

/**
 * The scoreboard's quads (layer 1 of the HUD pass) on a frame: pure. `sizes` are the HUD's bitmaps; `white` the
 * untextured rects' bitmap. Centred on the frame, scaled by height / 448 like the HUD. `lift` raises all of it by that
 * many frame pixels: the Modern presentation's `MODERN_SCOREBOARD_LIFT`, 0 (the game's place) for the PS2 one.
 * `scale` shrinks all of it -- panel, bars, rows, strings, GAME DETAILS, SPECTATORS -- uniformly about its (lifted)
 * top-centre, (320, SCORE_TOP - lift): the Modern presentation's `modernScoreboardFit` (`./hud`), 1 for the PS2 one
 * (whose numbers then take exactly the unscaled path, bit for bit).
 */
export function scoreboardLayout(
  frame: { width: number; height: number }, info: ScoreboardInfo, sizes: Record<string, { width: number; height: number }>,
  lift = 0, scale = 1,
): { quads: HudQuad[]; tris: HudTri[] } {
  const s = frame.height / 448;
  const tris: HudTri[] = [];
  const top = SCORE_TOP - lift;
  const X = scale === 1 ? (x: number): number => frame.width / 2 + (x - 320) * s
    : (x: number): number => frame.width / 2 + (x - 320) * scale * s;
  const Y = scale === 1 ? (y: number): number => (y - lift) * s : (y: number): number => (top + (y - SCORE_TOP) * scale) * s;
  const quads: HudQuad[] = [];
  const L = SCORE_LAYOUT;
  const panel = sizes['newweapnbkrnd.tif'];
  const rect = (texture: string, x0: number, y0: number, x1: number, y1: number, rgba: Rgba4,
    uv?: [number, number, number, number], element: HudQuad['element'] = 'scoreboard'): void => {
    const size = sizes[texture];
    if (!size || rgba[3] <= 0 || x1 <= x0 || y1 <= y0) return;
    const [u0, v0, u1, v1] = uv ?? [0, 0, size.width, size.height];
    quads.push({ element, texture, x: (X(x0) + X(x1)) / 2, y: (Y(y0) + Y(y1)) / 2, w: X(x1) - X(x0), h: Y(y1) - Y(y0),
      turn: 0, u0, v0, u1, v1, rgba, layer: 1 });
  };
  const text = (line: string, x: number, y: number, scale: number, rgba: Rgba4, align: 'left' | 'centre' = 'left'): void => {
    if (!sizes[FONT_TEXT_01.texture] || !line.trim()) return;
    const pen = align === 'centre' ? x - textWidth(line, scale) / 2 : x;
    const { glyphs } = layoutText(line, pen, y, scale);
    const [dx, dy] = FONT_TEXT_01.dropShadow.pixels;
    for (const pass of ['shadow', 'text'] as const) {
      const [ox, oy] = pass === 'shadow' ? [dx * scale, dy * scale] : [0, 0];
      const c: Rgba4 = pass === 'shadow' ? [0, 0, 0, rgba[3]] : rgba;
      for (const g of glyphs) {
        const x0 = g.x + ox, y0 = g.y + oy;
        rect(FONT_TEXT_01.texture, x0, y0, x0 + g.w, y0 + g.h, c, [g.u0, g.v0, g.u1, g.v1]);
      }
    }
  };
  const c255 = (rgb: readonly number[], a: number): Rgba4 => [rgb[0]! / 255, rgb[1]! / 255, rgb[2]! / 255, a];
  const c128 = (rgb: readonly number[], a: number): Rgba4 => [rgb[0]! / 128, rgb[1]! / 128, rgb[2]! / 128, a];

  // The team headers' bars: untextured, under the nine-slice (the draw order's first) -- the layer's shapes.
  for (const t of L.teams) {
    const [x0, y0, x1, y1] = [X(L.panel.x0), Y(t.y), X(L.panel.x1), Y(t.y + L.header.h)];
    const rgba = c255(t.header, L.header.alpha);
    tris.push({ layer: 1, p: [x0, y0, x1, y0, x1, y1], rgba }, { layer: 1, p: [x0, y0, x1, y1, x0, y1], rgba });
  }

  // The nine-slice: 20-pixel corners, the left column mirrored (its stripe on both sides).
  if (panel) {
    const P = L.panel, c = P.corner, W = panel.width, H = panel.height;
    const fu = L.cornerUv.u * W, fv = L.cornerUv.v * H;
    const xs: [number, number, number, number][] = [
      [P.x0, P.x0 + c, W, W - fu], [P.x0 + c, P.x1 - c, fu, W - fu], [P.x1 - c, P.x1, W - fu, W],
    ];
    const ys: [number, number, number, number][] = [
      [P.y0, P.y0 + c, 0, fv], [P.y0 + c, P.y1 - c, fv, H - fv], [P.y1 - c, P.y1, H - fv, H],
    ];
    for (const [x0, x1, u0, u1] of xs) for (const [y0, y1, v0, v1] of ys) rect('newweapnbkrnd.tif', x0, y0, x1, y1, [1, 1, 1, P.alpha], [u0, v0, u1, v1]);
  }

  // The left column: GAME DETAILS and SPECTATORS, each a green header strip over its body.
  const C = L.left, white: Rgba4 = [1, 1, 1, L.panel.alpha];
  for (const part of [C.details, C.spectators]) {
    rect('newweapnbkrnd.tif', C.x0, part.y0 + 25, C.x1, part.y1, white);
    rect('newweapnbkrnd.tif', C.x0, part.y0, C.x1, part.y0 + 25, c128(C.headerRgb, C.headerAlpha));
  }
  text(C.details.title, C.details.titleAt[0], C.details.titleAt[1], 1, [1, 1, 1, L.title.alpha]);

  // The odd rows' stripes.
  if (panel) {
    const mid: [number, number, number, number] = [panel.width / 2, panel.height / 2, panel.width / 2 + 0.01, panel.height / 2 + 0.01];
    for (const t of L.teams) {
      for (let i = 1; i < L.rows.max; i += 2) {
        const base = t.y + L.rows.dy + L.rows.pitch * i;
        rect('newweapnbkrnd.tif', L.stripe.x0, base - L.stripe.up, L.stripe.x1, base + L.stripe.down, [1, 1, 1, L.stripe.alpha], mid);
      }
    }
  }

  // The teams' strings: the header lines, the columns, the rows (the one SEAL).
  const rowRgba = c128(L.rowRgb, L.rowAlpha);
  const wins = info.rows ? [info.wins?.seal ?? 0, info.wins?.terrorist ?? 0] : [0, 0];
  L.teams.forEach((t, i) => {
    text(`${t.name} :   ${wins[i]}`, L.title.x, t.y + L.title.dy, L.title.scale, [1, 1, 1, L.title.alpha]);
    for (const col of L.columns) text(col.text, col.x, t.y + L.title.dy, L.title.scale, [1, 1, 1, L.title.alpha], 'centre');
    if (info.rows) {
      const team = i === 0 ? 'seal' : 'terrorist';
      // Array.prototype.sort is stable: equal scores keep the given (join) order.
      const mine = info.rows.filter((r) => r.team === team).sort((a, b) => b.score - a.score).slice(0, L.rows.max);
      mine.forEach((r, k) => {
        const base = t.y + L.rows.dy + L.rows.pitch * k;
        const f = r.alive ? 1 : DEAD_DIM;
        const [cr, cg, cb, ca] = r.self ? c128(L.localRgb, L.rowAlpha) : rowRgba;
        const rgba: Rgba4 = [cr * f, cg * f, cb * f, ca * f];
        text(r.name, L.rows.nameX, base, L.rows.scale, rgba);
        [r.kills, r.deaths, r.score].forEach((n, c) => text(String(n), L.columns[c]!.x, base, L.rows.scale, rgba, 'centre'));
      });
      return;
    }
    if (i !== 0) return;
    const base = t.y + L.rows.dy;
    text(info.player, L.rows.nameX, base, L.rows.scale, c128(L.localRgb, L.rowAlpha));
    for (const col of L.columns) text('0', col.x, base, L.rows.scale, c128(L.localRgb, L.rowAlpha), 'centre');
  });

  // The detail lines, then the spectators' header.
  const details = ['LAN game', info.game, info.type];
  details.forEach((d, i) => text(cutLine(d, C.lines.scale, C.lines.width), C.lines.x, C.lines.ys[i]!, C.lines.scale, rowRgba));
  text(C.spectators.title, C.spectators.titleAt[0], C.spectators.titleAt[1], 1, [1, 1, 1, L.title.alpha]);
  (info.spectators ?? []).slice(0, SPECTATOR_LINES.max).forEach((n, i) =>
    text(cutLine(n, C.lines.scale, C.lines.width), SPECTATOR_LINES.x, SPECTATOR_LINES.y0 + SPECTATOR_LINES.pitch * i, C.lines.scale, rowRgba));
  return { quads, tris };
}
