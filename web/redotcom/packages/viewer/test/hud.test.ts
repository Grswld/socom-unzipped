import { describe, expect, it } from 'vitest';
import { parseZdb } from '@s2u/archive';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import {
  ACTION_ICONS, AT_REST, DEFAULT_MODEL, FIRE_MODE_ROUNDS, HUD_LAYOUT, Hud, ammoLines, hudLayout, roundStartAt, timerText, capLines, messageAlpha,
  type HudModel,
} from '../src/hud';
import { flipRows, HUD_LIBRARIES, readHud } from '../src/hudAssets';
import { PEN_NUDGE } from '../src/hudFont';

/**
 * The in-game HUD (web/redotcom/docs/research/87-hud.md): its layout against `CHUD`'s constants and the console frames, and its
 * bitmaps off Frostfire's four HUD libraries.
 */

const PS2 = { width: 640, height: 448 };
/** The bitmaps' sizes as Frostfire's archive decodes them (research 87 §2). */
const SIZES: Record<string, { width: number; height: number }> = {
  'newweapnbkrnd.tif': { width: 128, height: 64 }, 'm4carbine_icon.tif': { width: 128, height: 32 },
  'firemode.tif': { width: 32, height: 16 }, 'compass_lo.tif': { width: 128, height: 128 },
  'font_text_01.tif': { width: 512, height: 128 }, 'action_climb.tif': { width: 64, height: 64 },
  'action_x.tif': { width: 32, height: 32 }, white: { width: 1, height: 1 },
};
const model = (over: Partial<HudModel> = {}): HudModel => ({ ...DEFAULT_MODEL, ...over });

describe('the ammo box', () => {
  it('formats the console\'s lines: "30/30", "2 MAGS", "1 MAG", and no magazine line with none spare', () => {
    expect(ammoLines({ rounds: 30, capacity: 30, spare: 2 })).toEqual({ rounds: '30/30', mags: '2 MAGS' });
    expect(ammoLines({ rounds: 7, capacity: 30, spare: 1 }).mags).toBe('1 MAG');
    expect(ammoLines({ rounds: 0, capacity: 30, spare: 0 }).mags).toBeNull();
    expect(timerText(289)).toBe('04:49');
    expect(timerText(360)).toBe('06:00');
  });

  it('puts the panel, the icon and the rounds where CHUD does (the console frame\'s pixels, research 87 §1)', () => {
    const { rects, scale } = hudLayout(PS2, model(), SIZES);
    expect(scale).toBe(1);
    // DAT_003dcb90..a8: -10, 364, 170, 75 -- the frame's panel x 0-159 (its left edge off-screen), y 364-438.
    expect(rects.panel).toEqual({ x: -10, y: 364, width: 170, height: 75 });
    expect(rects.icon).toEqual({ x: 20, y: 389, width: 128, height: 32 });
    // Three rounds at x 10, 51, 87 (15 + 36i, the first moved to 10), y 422: the frame's burst.
    expect(rects.firemode).toEqual({ x: 10, y: 422, width: 87 + 32 - 10, height: 16 });
  });

  it('shows one, three or four rounds by fire mode (FUN_00237b40)', () => {
    for (const [mode, n] of Object.entries(FIRE_MODE_ROUNDS)) {
      const { quads } = hudLayout(PS2, model({ fireMode: mode as HudModel['fireMode'] }), SIZES);
      expect(quads.filter((q) => q.element === 'firemode')).toHaveLength(n);
    }
  });

  it('draws the two lines at scale 0.9 from pens 15 and 95 on the baseline 382', () => {
    const { rects } = hudLayout(PS2, model(), SIZES);
    expect(rects.rounds!.x).toBeCloseTo(15 + PEN_NUDGE, 9);                // the first glyph's quad (the shadow falls right)
    expect(rects.rounds!.y + rects.rounds!.height).toBeGreaterThan(382);   // the cell's foot below the baseline
    expect(rects.rounds!.y).toBeLessThan(370);
    expect(rects.mags!.x).toBeGreaterThan(94);
    expect(rects.mags!.x).toBeLessThan(96);
  });

  it('fades in on a spawn: nothing at fade 0', () => {
    const { quads } = hudLayout(PS2, model(), SIZES, { ...AT_REST, fade: 0 });
    expect(quads.filter((q) => ['panel', 'icon', 'firemode', 'rounds', 'mags'].includes(q.element))).toEqual([]);
  });
});

describe('the compass', () => {
  it('is compass_lo at 0.75 (96x96) centred on (565, 90), turned clockwise by the heading', () => {
    const at = (yaw: number) => hudLayout(PS2, model({ yaw }), SIZES).quads.find((q) => q.element === 'compass')!;
    const q = at(0);
    expect([q.x, q.y, q.w, q.h, q.turn]).toEqual([565, 90, 96, 96, 0]);
    // The console frame at spawn looks down +z (research 17: the eye's z 832 behind the target's 858) and shows N at the
    // bottom: +z is the viewer's yaw 180, a half turn.
    expect(at(180).turn).toBeCloseTo(Math.PI, 12);
    expect(at(90).turn).toBeCloseTo(Math.PI / 2, 12);
    expect(q.rgba[3]).toBeCloseTo(100 / 128, 12);
  });

  it('keeps its margin to the right edge on a wide native frame', () => {
    const q = hudLayout({ width: 1600, height: 896 }, model(), SIZES).quads.find((x) => x.element === 'compass')!;
    expect(q.w).toBe(192);
    expect(1600 - q.x).toBeCloseTo((640 - 565) * 2, 9);
    expect(q.y).toBe(180);
  });
});

describe('the info box, the stance word, the prompt and the banner', () => {
  it('the health bar is (488, 396) 134x18, green (0, 128, 64) at alpha 80; the timer and range on 433', () => {
    const { rects, quads } = hudLayout(PS2, model({ range: 2 }), SIZES);
    expect(rects.bar).toEqual({ x: 488, y: 396, width: 134, height: 18 });
    expect(quads.find((q) => q.element === 'bar')!.rgba).toEqual([0, 128 / 255, 64 / 255, 80 / 128]);
    expect(rects.timer).toBeDefined();
    expect(rects.range).toBeDefined();
    expect(hudLayout(PS2, model({ range: null }), SIZES).rects.range).toBeUndefined();
  });

  it('the stance word is right-aligned to x 480 and only while its alpha lasts', () => {
    expect(hudLayout(PS2, model({ stance: 'crouch' }), SIZES).rects.stance).toBeUndefined();
    const { rects } = hudLayout(PS2, model({ stance: 'crouch' }), SIZES, { ...AT_REST, stance: 1 });
    // The shadow's glyphs run 0.765 px past the text's right end.
    expect(rects.stance!.x + rects.stance!.width).toBeGreaterThan(478);
    expect(rects.stance!.x + rects.stance!.width).toBeLessThan(482);
  });

  it('the climb prompt is action_climb, 50x50 centred on x 306, y 365..415, blue pulsing', () => {
    const rest = hudLayout(PS2, model({ action: 'climb' }), SIZES);
    expect(rest.rects.action).toEqual({ x: 281, y: 365, width: 50, height: 50 });
    const q = rest.quads.find((x) => x.element === 'action')!;
    expect(q.texture).toBe(ACTION_ICONS.climb);
    expect(q.rgba).toEqual([20 / 128, 50 / 128, 60 / 128, 1]);
    const lit = hudLayout(PS2, model({ action: 'climb' }), SIZES, { ...AT_REST, pulse: 1 }).quads.find((x) => x.element === 'action')!;
    expect(lit.rgba).toEqual([55 / 128, 130 / 128, 140 / 128, 1]);
    // An icon the archive lacks falls back to action_x, as the game's does.
    expect(hudLayout(PS2, model({ action: 'knife' }), SIZES).quads.find((x) => x.element === 'action')!.texture).toBe('action_x.tif');
  });

  it('the message banner is centred under the top edge', () => {
    const { rects } = hudLayout(PS2, model({ message: 'STARTING ROUND 1 OF 11' }), SIZES);
    expect(rects.banner).toEqual({ x: 147, y: 0, width: 345, height: 99 });
    const m = rects.message!;
    expect(Math.abs(m.x + m.width / 2 - HUD_LAYOUT.message.text.x)).toBeLessThan(1.5);
  });
});

describe('the round start', () => {
  it('fades up from black; STARTING ROUND at 0.36 s, the objective at 5.36 s, each 0.357 s in, out from 7 s on', () => {
    const at = (t: number) => roundStartAt(t);
    const alphas = (t: number) => at(t).banner.map((m) => Math.round(m.alpha * 100) / 100);
    expect(at(0).fader).toBe(1);
    expect(at(0.75).fader).toBeCloseTo(0.5, 9);
    expect(at(1.5).fader).toBe(0);
    expect(at(0.3).banner).toEqual([]);
    expect(at(0.54).banner.map((m) => m.lines.map((l) => l.text))).toEqual([['STARTING ROUND 1 OF 11']]);
    expect(alphas(0.54)).toEqual([0.5]);
    expect(alphas(3)).toEqual([1]);
    // The console's frame 26 (t = 5.58): the first line full, the objective coming in (0.62).
    expect(alphas(5.58)).toEqual([1, 0.62]);
    expect(at(5.58).banner[1]!.lines).toEqual([{ text: 'OBJECTIVE:', scale: 1 }, { text: 'ELIMINATE THE TERRORISTS', scale: 0.765 }]);
    // Frame 28 (7.58): the first line fading (0.39 measured); frame 33 (12.58): the objective fading (0.39).
    expect(alphas(7.58)).toEqual([0.38, 1]);
    expect(alphas(12.58)).toEqual([0.38]);
    expect(at(12.8).banner).toEqual([]);
  });

  it('stacks the lines up from the bottom: one line on 94; three on 61.5, 76.5 and 91.5 (the ink feet on the Vigilance frames)', () => {
    const baselines = (t: number): number[] => {
      const { banner } = roundStartAt(t);
      const q = hudLayout(PS2, model({ banner }), SIZES).quads.filter((x) => x.element === 'message' && x.rgba[0] === 1);
      // Each line's glyph quads share a top; the baseline is that top + 20 rows x scale x 448/480 - 0.3.
      const tops = [...new Set(q.map((x) => Math.round((x.y - x.h / 2) * 100) / 100))];
      return tops.map((top) => {
        const h = q.find((x) => Math.round((x.y - x.h / 2) * 100) / 100 === top)!.h;
        return Math.round((top + (h * 20) / 25 - 0.3) * 10) / 10;
      });
    };
    expect(baselines(3)).toEqual([94]);
    expect(baselines(6.5).sort((a, b) => a - b)).toEqual([61.5, 76.5, 91.5]);
  });
});

describe('the zoom readout and the scope range (research 87 §13)', () => {
  it('writes "ZOOM: %2.1fx" at (20, 420) and "RANGE(m): %.0f" at (415, 215), scale 0.9, only over 1.01', () => {
    expect(hudLayout(PS2, model({ zoom: 1 }), SIZES).rects.zoom).toBeUndefined();
    expect(hudLayout(PS2, model({ zoom: 1.01 }), SIZES).rects.zoom).toBeUndefined();
    const { quads, rects } = hudLayout(PS2, model({ zoom: 3, range: 37.4 }), SIZES);
    expect(rects.zoom!.x).toBeCloseTo(20 - 0.6, 6);                    // the pen at 20 (PEN_NUDGE)
    expect(rects.scopeRange!.x).toBeCloseTo(415 - 0.6, 6);
    // "ZOOM: 3.0x" is 10 glyphs less the space; "RANGE(m): 37" 12 less the space, each with its shadow.
    expect(quads.filter((q) => q.element === 'zoom')).toHaveLength(2 * 9);
    expect(quads.filter((q) => q.element === 'scopeRange')).toHaveLength(2 * 11);
    const dashes = hudLayout(PS2, model({ zoom: 9, range: null }), SIZES).quads.filter((q) => q.element === 'scopeRange');
    expect(dashes).toHaveLength(2 * 13);                                // "RANGE(m): ----"
  });
});

describe('the message window', () => {
  it('fades a posted line in over 0.357 s and out from 7 s, and keeps the newest 8 lines', () => {
    expect(messageAlpha(-0.1)).toBeNull();
    expect(messageAlpha(50 / 280)).toBeCloseTo(0.5, 9);
    expect(messageAlpha(3)).toBe(1);
    expect(messageAlpha(7 + 50 / 280)).toBeCloseTo(0.5, 9);
    expect(messageAlpha(7.4)).toBeNull();
    const m = (n: number) => ({ lines: Array.from({ length: n }, (_, i) => ({ text: String(i), scale: 1 })), alpha: 1 });
    expect(capLines([m(3), m(3), m(3)]).map((x) => x.lines.length)).toEqual([3, 3]);
    expect(capLines([m(1), m(7)]).map((x) => x.lines.length)).toEqual([1, 7]);
  });

  it('shows a posted message under those of the round start, and drops it 7.36 s later', () => {
    const hud = new Hud();
    hud.setVisible(true);
    hud.step(6);
    hud.postMessage('Satchel');
    hud.step(1);
    const texts = hud.state().model.banner.map((b) => b.lines.map((l) => l.text).join('/'));
    expect(texts).toEqual(['STARTING ROUND 1 OF 11', 'OBJECTIVE:/ELIMINATE THE TERRORISTS', 'Satchel']);
    expect(hud.state().model.banner[2]!.lines[0]!.scale).toBe(0.9);
    hud.step(6.5);
    expect(hud.state().model.banner.map((b) => b.lines[0]!.text)).toEqual([]);
  });
});

describe('Hud', () => {
  it('shows the ledge prompt while the traversal says so, without taking another prompt\'s slot', () => {
    const hud = new Hud();
    hud.setClimbPrompt({ visible: true, kind: 'high' });
    expect(hud.state().model.action).toBe('climb');
    hud.setClimbPrompt({ visible: false, kind: 'high' });
    expect(hud.state().model.action).toBeNull();
    hud.setAction('pickup');
    hud.setClimbPrompt({ visible: true, kind: 'low' });
    expect(hud.state().model.action).toBe('pickup');
  });

  it('fades in over 1-1.5 s, flashes the stance word on a change and lets it go in 2 s', () => {
    const hud = new Hud();
    hud.setVisible(true);
    hud.step(0.5);
    expect(hud.timing().fade).toBe(0);
    hud.step(0.75);
    expect(hud.timing().fade).toBeCloseTo(0.5, 9);
    hud.step(1);
    expect(hud.timing().fade).toBe(1);
    hud.setStance('prone');
    expect(hud.timing().stance).toBeCloseTo(127 / 128, 9);
    hud.step(1);
    expect(hud.timing().stance).toBeCloseTo(63 / 128, 9);
    hud.step(1);
    expect(hud.timing().stance).toBe(0);
  });

  it('pulses the prompt 0 to 1 and back at 5 a second, and drops a message when its time is up', () => {
    const hud = new Hud();
    hud.setAction('climb');
    hud.step(0.1);
    expect(hud.timing().pulse).toBeCloseTo(0.5, 9);
    hud.step(0.1);
    expect(hud.timing().pulse).toBe(1);
    hud.step(0.1);
    expect(hud.timing().pulse).toBeCloseTo(0.5, 9);
    hud.flashMessage('area secured', 1);
    expect(hud.state().model.message).toBe('AREA SECURED');
    hud.step(1.01);
    expect(hud.state().model.message).toBeNull();
  });

  it('feeds from the live state and holds still when frozen', () => {
    const hud = new Hud();
    hud.feed({ magazine: { rounds: 12, capacity: 30, spare: 1, reloading: false }, yaw: 45, stance: 'crouch', range: 7 });
    expect(hud.state().model).toMatchObject({ rounds: 12, spare: 1, yaw: 45, stance: 'crouch', range: 7 });
    hud.patch({ frozen: true, rounds: 30 });
    hud.feed({ magazine: { rounds: 1, capacity: 30, spare: 0, reloading: false }, yaw: 0 });
    expect(hud.state().model.rounds).toBe(30);
  });
});

const bytes = fixture('RUN/MP2.ZDB');
describe.skipIf(bytes === null)(`the HUD's bitmaps off Frostfire${bytes === null ? ` (${FIXTURES_ABSENT})` : ''}`, () => {
  it('reads every bitmap the HUD names, at its size, with no diagnostic', () => {
    const { bitmaps, diagnostics } = readHud(bytes!, parseZdb(bytes!));
    expect(diagnostics).toEqual([]);
    for (const names of Object.values(HUD_LIBRARIES)) for (const n of names) expect(bitmaps[n], n).toBeDefined();
    for (const [name, size] of Object.entries(SIZES)) {
      if (name === 'white') continue;
      expect({ width: bitmaps[name]!.width, height: bitmaps[name]!.height }, name).toEqual(size);
    }
  });

  it('turns them top row first: the font\'s "A" (fonts.rdr UL 2,0 - LR 13,25) is inked in rows 0-25', () => {
    const font = readHud(bytes!, parseZdb(bytes!)).bitmaps['font_text_01.tif']!;
    const inked = (y0: number, y1: number, x0: number, x1: number): number => {
      let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (font.data[(y * font.width + x) * 4 + 3]! > 60) n++;
      return n;
    };
    expect(inked(0, 25, 2, 13)).toBeGreaterThan(40);
    // The glyph's ink: rows 5-19 of its cell, nothing in its top five rows.
    expect(inked(0, 5, 2, 13)).toBe(0);
    // The white ramp of palette 139: the brightest texel is opaque white.
    let max = 0;
    for (let i = 3; i < font.data.length; i += 4) max = Math.max(max, font.data[i]!);
    expect(max).toBe(255);
  });

  it('flipRows reverses the rows and nothing else', () => {
    const rgba = { width: 1, height: 3, data: new Uint8ClampedArray([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]) };
    expect(Array.from(flipRows(rgba).data)).toEqual([3, 3, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1]);
  });
});
