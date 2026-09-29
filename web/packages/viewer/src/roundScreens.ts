import { FONT_TEXT_01, layoutText, textWidth } from './hudFont';
import type { HudQuad, HudTri } from './hud';
import { SCORE_LAYOUT, type ScoreRowInfo } from './scoreboard';

/**
 * The round's end screens (web/docs/research/91-the-round.md §18), drawn in the HUD's own pass with its font and its
 * colours: ROUND COMPLETE (`dlgMultiplayerRound.rdr`), FINAL ROUND (`dlgMultiplayerFinal.rdr`: the last round's lists
 * before the totals) and GAME COMPLETE / FINAL TOTALS (`dlgMultiplayerFinalReally.rdr`). Their strings are SOCOM II's
 * own (`UIMPXLOC`, 91 §18 §2.3); their layouts and backgrounds are not on the handoff disc (91 §18 "UI assets"), so the
 * positions are SOCOM 1's dialogs in reCOM (`recom/data/s1/common/dialog/<file>:<line>`, cited on each number) and the
 * rest is a named `*_PLACEHOLDER`. The missing background bitmap is stood in for by an opaque backdrop and the
 * scoreboard's own panel (research 87 §12). Pure: no three, no DOM.
 *
 * A reCOM TEXT's `YPOS` is taken as its baseline, as every HUD string's is (research 87 §3), and a LISTBOX row `i`'s
 * baseline as `YPOS + SPACING x i`: `dlgMultiplayerFinalReally.rdr` puts its totals lists on the same `YPOS` as their
 * labels (SealText 127 / SealsTotals 127, L691 / L1009; TerrText 208 / TerrsTotals 208, L709 / L1258).
 */

/** Which of the three screens. */
export type RoundScreenKind = 'roundComplete' | 'finalRound' | 'gameComplete';

/** What a round screen shows. */
export type RoundScreen = {
  kind: RoundScreenKind;
  /** Seconds to the screen's end: ROUND COMPLETE's 5 s, FINAL ROUND's 10 s; the countdown is derived from it. */
  secondsLeft: number;
  /** The round's winner (`mp_winner` 0 / 8), null for a draw (99, or `mission_timeout`). Unused on GAME COMPLETE. */
  winner: 'seal' | 'terrorist' | null;
  /** Rounds won (`mp_score00` / `mp_score08`): GAME COMPLETE's WINNER and its SEAL / TERRORIST ROUNDS. */
  wins: { seal: number; terrorist: number };
  /** Every player's row: the round lists; on GAME COMPLETE the totals, the MVP and the self row. */
  rows: ScoreRowInfo[];
  /** The MVP's name: absent is the highest score's (first on a tie); null is none. */
  mvp?: string | null;
  /** YOUR STATS: absent is the `self` row's numbers; null is none. */
  you?: { kills: number; deaths: number; score: number } | null;
  /** TIME PLAYED, seconds. */
  timePlayed?: number;
};

type Rgba4 = [number, number, number, number];

/** What a string is, for the tests and the page's inspection. */
export type RoundTextRole =
  | 'title' | 'next' | 'countdown' | 'team' | 'result' | 'header' | 'row' | 'totalsLabel' | 'totals' | 'mvpLabel' | 'mvp'
  | 'yourStats' | 'rounds' | 'time' | 'lobby';

/** One string of a screen, in the 640x448 frame's pixels: pen x (or the x it is right-aligned to / centred on), baseline. */
export interface RoundText {
  text: string; x: number; y: number; scale: number; align: 'left' | 'right' | 'centre'; rgba: Rgba4; role: RoundTextRole;
}

/** The strings, SOCOM II's own (`UIMPXLOC`, research 91 §18 §2.3). */
export const ROUND_STRINGS = {
  roundComplete: 'ROUND COMPLETE',        // 2133
  nextRound: 'NEXT ROUND',                // 2132
  finalRound: 'FINAL ROUND',              // 2103
  finalTotals: 'FINAL TOTALS',            // 2102
  gameComplete: 'GAME COMPLETE',          // 2105
  winner: 'WINNER', loser: 'LOSER', draw: 'DRAW',  // 2110 / 2109 / 2104
  go: 'GO',                               // 2111
  seals: 'SEALS', terrorists: 'TERRORISTS',        // 2101 / 2100
  score: 'SCORE', kills: 'KILLS', deaths: 'DEATHS', // 2106 / 2107 / 2108
  sealTotals: 'SEAL TOTALS', terroristTotals: 'TERRORIST TOTALS', mvp: 'MVP', yourStats: 'YOUR STATS',
  sealRounds: 'SEAL ROUNDS', terroristRounds: 'TERRORIST ROUNDS', timePlayed: 'TIME PLAYED', // 2112-2124
  lobby: 'RETURNING TO GAME LOBBY. . .',  // 2128, SOCOM II's `ReturnFlash` line
} as const;

/**
 * The screens' title: SOCOM 1 had it in the background bitmap (`MP_RoundComplete.tif`, `MP_Game_Complete.tif`), which
 * is not on the handoff disc. Placed at the team captions' x 27 (`dlgMultiplayerRound.rdr` L58) on NEXT ROUND's
 * baseline 45 (L96), scale 1.
 */
export const TITLE_PLACEHOLDER = { x: 27, y: 45, scale: 1 } as const;
/**
 * The three numeric columns' order: SOCOM II's round lists have three (`FUN_00224210` L76333-76339) whose stat offsets
 * (`DAT_003dc7f0..`) are unresolved; KILLS, DEATHS, SCORE is the SELECT scoreboard's order (research 87 §12), and
 * KILLS is SOCOM 1's first column (`dlgMultiplayerRound.rdr` L168).
 */
export const COLUMN_ORDER_PLACEHOLDER = ['kills', 'deaths', 'score'] as const;
/**
 * The panel behind a screen: the scoreboard's nine-slice (`SCORE_LAYOUT.panel`'s bitmap, corners, alpha) stretched over
 * the frame's margin, where SOCOM 1 drew its background bitmap.
 */
export const PANEL_PLACEHOLDER = { x0: 10, x1: 630, y0: 20, y1: 432 } as const;
/**
 * The team bars under the team captions: the scoreboard's (25 high, `SCORE_LAYOUT.teams`' colours, alpha 80), their
 * top 20 above the caption's baseline as the scoreboard's header line sits (`SCORE_LAYOUT.title.dy`), across the panel.
 */
export const TEAM_BAR_PLACEHOLDER = { above: SCORE_LAYOUT.title.dy, h: SCORE_LAYOUT.header.h } as const;
/** The odd rows' stripes as the scoreboard's (baseline - 12 .. + 4, alpha 60), across the round list's x 20..450. */
export const STRIPE_PLACEHOLDER = { x0: 20, x1: 450 } as const;
/**
 * YOUR STATS (SOCOM II's string 2115; SOCOM 1's final screen has none): a fourth block in the bottom row, right of the
 * rounds, built like them -- its caption centred at y 327 (`dlgMultiplayerFinalReally.rdr` L768), the numbers at + 50
 * (L810) at 0.8, right-justified 60 apart as the totals' columns (L1039).
 */
export const YOUR_STATS_PLACEHOLDER = { x: 530, y: 327, columns: [500, 560, 620], valueDy: 50 } as const;
/**
 * The single-line SOCOM II captions "SEAL ROUNDS" / "TERRORIST ROUNDS" / "TIME PLAYED" stand on SOCOM 1's first caption
 * line (y 327); its second line ("ROUNDS WON", "PLAYED", + 15) has no SOCOM II counterpart.
 */
export const BOTTOM_CAPTION_PLACEHOLDER = { y: 327 } as const;

/** The layout, 640x448 pixels. */
export const ROUND_SCREEN_LAYOUT = {
  title: TITLE_PLACEHOLDER,
  /** "NEXT  ROUND" at (380, 45), scale 0.8 (`dlgMultiplayerRound.rdr` L90-101); "FINAL  TOTALS" the same (`dlgMultiplayerFinal.rdr` L83). */
  next: { x: 380, y: 45, scale: 0.8 },
  /** CountDown, CHILDOF NextMission: + 110 (Round L108-121), + 125 (Final L101-114), scale 1.2. */
  countdown: { dx: { roundComplete: 110, finalRound: 125 }, scale: 1.2, every: 0.5, from: { roundComplete: 10, finalRound: 20 } },
  /** The round lists' two halves (Round L54-87 captions, L148 / L128 results, L168 / L372 headers, L578 / L890 lists). */
  teams: [
    { team: 'seal', caption: ROUND_STRINGS.seals, at: [27, 87], result: [200, 90], headerY: 86, listY: 112, bar: [32, 32, 64] },
    { team: 'terrorist', caption: ROUND_STRINGS.terrorists, at: [27, 270], result: [200, 273], headerY: 269, listY: 295, bar: [64, 32, 32] },
  ] as const,
  /** Captions scale 1 (L65); results 0.9 (L141); column headers 0.65 (L179). */
  scales: { caption: 1, result: 0.9, header: 0.65 },
  /**
   * The LISTBOX (L578-675): XPOS 129, scale 0.75, SPACING 18; its columns: the name at -104 (x 25), the numbers
   * RIGHT_JUSTIFIED at 190 / 250 / 310 (x 319 / 379 / 439). 8 a team, as the scoreboard (research 91 §11).
   */
  rows: { x: 129, name: -104, columns: [190, 250, 310], scale: 0.75, pitch: 18, max: 8 },
  /** GAME COMPLETE (`dlgMultiplayerFinalReally.rdr`). */
  final: {
    /** SealText (26, 127), TerrText (26, 208), scale 0.7 (L691, L709); DrawRoundS / T (185, 131) / (185, 213), 0.8 (L967, L987). */
    totals: [
      { team: 'seal', caption: ROUND_STRINGS.sealTotals, at: [26, 127], result: [185, 131], headerY: 95, bar: [32, 32, 64] },
      { team: 'terrorist', caption: ROUND_STRINGS.terroristTotals, at: [26, 208], result: [185, 213], headerY: 176, bar: [64, 32, 32] },
    ] as const,
    labelScale: 0.7, resultScale: 0.8,
    /** The totals lists at XPOS 273, scale 0.75, columns RIGHT_JUSTIFIED at 50 / 110 / 170 (x 323 / 383 / 443) (L1009-1039). */
    list: { x: 273, columns: [50, 110, 170], scale: 0.75 },
    /** Column headers at y 95 / 176 / 258, scale 0.7 (Kills L79, L283, L487), right-justified to the columns. */
    headerScale: 0.7, mvpHeaderY: 258,
    /** MVP caption (130, 258), scale 1.2, coloured (L727); MvpName (26, 291), 0.7 (L747); MvpTotals y 290 (L1507). */
    mvp: { caption: [130, 258], captionScale: 1.2, name: [26, 291], nameScale: 0.7, listY: 290 },
    /** TIME (85, 327) centred 0.75 (L768); TimePlayed + (-30, 50) = (55, 377), 0.8 (L810). */
    time: { caption: [85, 327], value: [55, 377], captionScale: 0.75, valueScale: 0.8 },
    /** SEALS (220, 327) centred, its counter centred + (0, 50) (L833, L875); TERRORISTS (360, 327), counter + (-5, 50) (L901, L943). */
    rounds: [
      { caption: [220, 327], value: [220, 377], valueAlign: 'centre' },
      { caption: [360, 327], value: [355, 377], valueAlign: 'left' },
    ] as const,
    /** RTGL at (340, 423), scale 1 (L61). */
    lobby: { x: 340, y: 423, scale: 1 },
  },
} as const;

/**
 * The colours, all the scoreboard's (research 87 §12): captions white at its header line's alpha 90, rows its (115, 115,
 * 115) alpha 110, the local player its yellow; the result words and the MVP caption (SOCOM 1's (255, 104, 51), L137,
 * L727) its nearest, the clan tag's (128, 64, 32).
 */
const c128 = (rgb: readonly number[], a: number): Rgba4 => [rgb[0]! / 128, rgb[1]! / 128, rgb[2]! / 128, a];
const c255 = (rgb: readonly number[], a: number): Rgba4 => [rgb[0]! / 255, rgb[1]! / 255, rgb[2]! / 255, a];
export const ROUND_COLOURS = {
  caption: [1, 1, 1, SCORE_LAYOUT.title.alpha] as Rgba4,
  row: c128(SCORE_LAYOUT.rowRgb, SCORE_LAYOUT.rowAlpha),
  local: c128(SCORE_LAYOUT.localRgb, SCORE_LAYOUT.rowAlpha),
  accent: c128(SCORE_LAYOUT.clanRgb, SCORE_LAYOUT.title.alpha),
  /** Over the whole frame, opaque: the screen replaces the game (91 §18 §2.4), its background bitmap missing. */
  backdrop: [0, 0, 0, 1] as Rgba4,
};

/**
 * The countdown's caption `secondsLeft` before the screen's end: `CountDown` sets "10" (or "20") at once and one less
 * every 0.5 s, "GO" at the end (5 s / 10 s; research 91 §18 §2.4, §3). None on GAME COMPLETE.
 */
export function countdownText(kind: RoundScreenKind, secondsLeft: number): string | null {
  if (kind === 'gameComplete') return null;
  const C = ROUND_SCREEN_LAYOUT.countdown;
  const n = Math.min(C.from[kind], Math.ceil(secondsLeft / C.every - 1e-9));
  return n <= 0 ? ROUND_STRINGS.go : String(n);
}

/** TIME PLAYED as `FUN_00224670` writes `TimeInGame` (L76431-76444): hh:mm:ss, whole seconds. */
export function timePlayedText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(Math.floor(s / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
}

/** A side's rows, by score descending, ties in the given (join) order, cut to 8 (as the scoreboard). */
function sideRows(rows: ScoreRowInfo[], team: 'seal' | 'terrorist'): ScoreRowInfo[] {
  return rows.filter((r) => r.team === team).sort((a, b) => b.score - a.score).slice(0, ROUND_SCREEN_LAYOUT.rows.max);
}

const numbers = (r: { kills: number; deaths: number; score: number }): string[] => COLUMN_ORDER_PLACEHOLDER.map((k) => String(r[k]));
const HEADERS: Record<(typeof COLUMN_ORDER_PLACEHOLDER)[number], string> = {
  kills: ROUND_STRINGS.kills, deaths: ROUND_STRINGS.deaths, score: ROUND_STRINGS.score,
};

/** The screen's strings, in the 640x448 frame. */
function screenTexts(screen: RoundScreen): { texts: RoundText[]; bars: { y: number; rgb: readonly number[] }[]; stripes: number[] } {
  const L = ROUND_SCREEN_LAYOUT, S = ROUND_STRINGS, K = ROUND_COLOURS;
  const texts: RoundText[] = [];
  const bars: { y: number; rgb: readonly number[] }[] = [];
  const stripes: number[] = [];
  const put = (role: RoundTextRole, text: string, x: number, y: number, scale: number, rgba: Rgba4, align: RoundText['align'] = 'left'): void => {
    if (text.trim()) texts.push({ text, x, y, scale, align, rgba, role });
  };

  const title = screen.kind === 'roundComplete' ? S.roundComplete : screen.kind === 'finalRound' ? S.finalRound : S.gameComplete;
  put('title', title, L.title.x, L.title.y, L.title.scale, K.caption);
  put('next', screen.kind === 'roundComplete' ? S.nextRound : S.finalTotals, L.next.x, L.next.y, L.next.scale, K.caption);

  if (screen.kind !== 'gameComplete') {
    put('countdown', countdownText(screen.kind, screen.secondsLeft)!, L.next.x + L.countdown.dx[screen.kind], L.next.y, L.countdown.scale, K.caption);
    const R = L.rows;
    for (const t of L.teams) {
      bars.push({ y: t.at[1] - TEAM_BAR_PLACEHOLDER.above, rgb: t.bar });
      put('team', t.caption, t.at[0], t.at[1], L.scales.caption, K.caption);
      // `CallRoundATie`: a draw (99 or a time-out) DRAW on both; else WINNER / LOSER (91 §18 §2.4).
      const word = screen.winner === null ? S.draw : screen.winner === t.team ? S.winner : S.loser;
      put('result', word, t.result[0], t.result[1], L.scales.result, K.accent);
      R.columns.forEach((c, i) => put('header', HEADERS[COLUMN_ORDER_PLACEHOLDER[i]!], R.x + c, t.headerY, L.scales.header, K.caption, 'right'));
      sideRows(screen.rows, t.team).forEach((r, k) => {
        const y = t.listY + R.pitch * k;
        if (k % 2 === 1) stripes.push(y);
        const rgba = r.self ? K.local : K.row;
        put('row', r.name, R.x + R.name, y, R.scale, rgba);
        numbers(r).forEach((n, i) => put('row', n, R.x + R.columns[i]!, y, R.scale, rgba, 'right'));
      });
    }
    return { texts, bars, stripes };
  }

  // GAME COMPLETE: the totals, the MVP, the bottom row, the lobby line.
  const F = L.final, cols = F.list.columns.map((c) => F.list.x + c);
  const headers = (y: number): void => cols.forEach((x, i) => put('header', HEADERS[COLUMN_ORDER_PLACEHOLDER[i]!], x, y, F.headerScale, K.caption, 'right'));
  // `CallRoundATie`: `mp_score00 > mp_score08` SEALs WINNER, the reverse Terrorists, equal " " on both (91 §18 §3).
  const winner = screen.wins.seal > screen.wins.terrorist ? 'seal' : screen.wins.terrorist > screen.wins.seal ? 'terrorist' : null;
  for (const t of F.totals) {
    bars.push({ y: t.at[1] - TEAM_BAR_PLACEHOLDER.above, rgb: t.bar });
    headers(t.headerY);
    put('totalsLabel', t.caption, t.at[0], t.at[1], F.labelScale, K.caption);
    if (winner === t.team) put('result', S.winner, t.result[0], t.result[1], F.resultScale, K.accent);
    const mine = screen.rows.filter((r) => r.team === t.team);
    const sum = mine.reduce((a, r) => ({ kills: a.kills + r.kills, deaths: a.deaths + r.deaths, score: a.score + r.score }), { kills: 0, deaths: 0, score: 0 });
    numbers(sum).forEach((n, i) => put('totals', n, cols[i]!, t.at[1], F.list.scale, K.row, 'right'));
  }

  headers(F.mvpHeaderY);
  put('mvpLabel', S.mvp, F.mvp.caption[0], F.mvp.caption[1], F.mvp.captionScale, K.accent);
  const best = screen.rows.reduce<ScoreRowInfo | null>((b, r) => (b === null || r.score > b.score ? r : b), null);
  const mvpName = screen.mvp === undefined ? best?.name ?? null : screen.mvp;
  if (mvpName) {
    put('mvp', mvpName, F.mvp.name[0], F.mvp.name[1], F.mvp.nameScale, K.row);
    const r = screen.rows.find((x) => x.name === mvpName);
    if (r) numbers(r).forEach((n, i) => put('mvp', n, cols[i]!, F.mvp.listY, F.list.scale, K.row, 'right'));
  }

  const B = BOTTOM_CAPTION_PLACEHOLDER;
  put('time', S.timePlayed, F.time.caption[0], B.y, F.time.captionScale, K.caption, 'centre');
  if (screen.timePlayed !== undefined) put('time', timePlayedText(screen.timePlayed), F.time.value[0], F.time.value[1], F.time.valueScale, K.row);
  [[S.sealRounds, screen.wins.seal], [S.terroristRounds, screen.wins.terrorist]].forEach(([caption, n], i) => {
    const R = F.rounds[i]!;
    put('rounds', String(caption), R.caption[0], B.y, F.time.captionScale, K.caption, 'centre');
    put('rounds', String(n), R.value[0], R.value[1], F.time.valueScale, K.row, R.valueAlign);
  });

  const self = screen.rows.find((r) => r.self);
  const you = screen.you === undefined ? (self ?? null) : screen.you;
  if (you) {
    const Y = YOUR_STATS_PLACEHOLDER;
    put('yourStats', S.yourStats, Y.x, Y.y, F.time.captionScale, K.caption, 'centre');
    numbers(you).forEach((n, i) => put('yourStats', n, Y.columns[i]!, Y.y + Y.valueDy, F.time.valueScale, K.local, 'right'));
  }

  put('lobby', S.lobby, F.lobby.x, F.lobby.y, F.lobby.scale, K.caption);
  return { texts, bars, stripes };
}

/**
 * A round screen's strings, quads and shapes (layer 1 of the HUD pass, over everything; element `roundScreen`) on a
 * frame: pure. `texts` are in the 640x448 frame and always given; the quads need `sizes` (the HUD's bitmaps) to hold
 * the font and the panel. Centred on the frame and scaled by height / 448, as the scoreboard.
 */
export function roundScreenLayout(
  screen: RoundScreen, frame: { width: number; height: number } = { width: 640, height: 448 },
  sizes: Record<string, { width: number; height: number }> = {},
): { quads: HudQuad[]; tris: HudTri[]; texts: RoundText[] } {
  const { texts, bars, stripes } = screenTexts(screen);
  const s = frame.height / 448;
  const X = (x: number): number => frame.width / 2 + (x - 320) * s, Y = (y: number): number => y * s;
  const quads: HudQuad[] = [];
  const tris: HudTri[] = [];
  const tri = (x0: number, y0: number, x1: number, y1: number, rgba: Rgba4): void => {
    tris.push({ layer: 1, p: [x0, y0, x1, y0, x1, y1], rgba }, { layer: 1, p: [x0, y0, x1, y1, x0, y1], rgba });
  };
  const rect = (texture: string, x0: number, y0: number, x1: number, y1: number, rgba: Rgba4, uv?: [number, number, number, number]): void => {
    const size = sizes[texture];
    if (!size || rgba[3] <= 0 || x1 <= x0 || y1 <= y0) return;
    const [u0, v0, u1, v1] = uv ?? [0, 0, size.width, size.height];
    quads.push({ element: 'roundScreen', texture, x: (X(x0) + X(x1)) / 2, y: (Y(y0) + Y(y1)) / 2, w: X(x1) - X(x0), h: Y(y1) - Y(y0),
      turn: 0, u0, v0, u1, v1, rgba, layer: 1 });
  };

  // The backdrop over the whole frame, then the team bars: shapes, drawn before the layer's bitmaps.
  tri(0, 0, frame.width, frame.height, ROUND_COLOURS.backdrop);
  const P = PANEL_PLACEHOLDER;
  for (const b of bars) tri(X(P.x0), Y(b.y), X(P.x1), Y(b.y + TEAM_BAR_PLACEHOLDER.h), c255(b.rgb, SCORE_LAYOUT.header.alpha));

  // The scoreboard's nine-slice, 20-pixel corners, the left column mirrored (scoreboard.ts).
  const panel = sizes['newweapnbkrnd.tif'];
  if (panel) {
    const c = SCORE_LAYOUT.panel.corner, W = panel.width, H = panel.height;
    const fu = SCORE_LAYOUT.cornerUv.u * W, fv = SCORE_LAYOUT.cornerUv.v * H;
    const xs: [number, number, number, number][] = [[P.x0, P.x0 + c, W, W - fu], [P.x0 + c, P.x1 - c, fu, W - fu], [P.x1 - c, P.x1, W - fu, W]];
    const ys: [number, number, number, number][] = [[P.y0, P.y0 + c, 0, fv], [P.y0 + c, P.y1 - c, fv, H - fv], [P.y1 - c, P.y1, H - fv, H]];
    for (const [x0, x1, u0, u1] of xs) for (const [y0, y1, v0, v1] of ys) rect('newweapnbkrnd.tif', x0, y0, x1, y1, [1, 1, 1, SCORE_LAYOUT.panel.alpha], [u0, v0, u1, v1]);
    const mid: [number, number, number, number] = [W / 2, H / 2, W / 2 + 0.01, H / 2 + 0.01];
    const St = SCORE_LAYOUT.stripe;
    for (const y of stripes) rect('newweapnbkrnd.tif', STRIPE_PLACEHOLDER.x0, y - St.up, STRIPE_PLACEHOLDER.x1, y + St.down, [1, 1, 1, St.alpha], mid);
  }

  // The strings, each with the font's drop shadow (the scoreboard's text path).
  if (sizes[FONT_TEXT_01.texture]) {
    const [dx, dy] = FONT_TEXT_01.dropShadow.pixels;
    for (const t of texts) {
      const w = textWidth(t.text, t.scale);
      const pen = t.align === 'right' ? t.x - w : t.align === 'centre' ? t.x - w / 2 : t.x;
      const { glyphs } = layoutText(t.text, pen, t.y, t.scale);
      for (const pass of ['shadow', 'text'] as const) {
        const [ox, oy] = pass === 'shadow' ? [dx * t.scale, dy * t.scale] : [0, 0];
        const c: Rgba4 = pass === 'shadow' ? [0, 0, 0, t.rgba[3]] : t.rgba;
        for (const g of glyphs) {
          const x0 = g.x + ox, y0 = g.y + oy;
          rect(FONT_TEXT_01.texture, x0, y0, x0 + g.w, y0 + g.h, c, [g.u0, g.v0, g.u1, g.v1]);
        }
      }
    }
  }
  return { quads, tris, texts };
}
