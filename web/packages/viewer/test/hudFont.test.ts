import { describe, expect, it } from 'vitest';
import { Zar, parseRdr, rdrGet, type RdrNode } from '@s2u/archive';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { FONT_TEXT_01, layoutText, PEN_NUDGE, textWidth, TEXT_V } from '../src/hudFont';
import { GS_SAMPLE_OFFSET } from '../src/hud';

/**
 * The HUD's font (web/docs/research/87-hud.md §3): `fonts.rdr`'s `font_text_01`, transcribed, and the text model
 * fitted on the console frame's "30/30" and "2 MAGS".
 */

const readerc = fixture('RUN/READERC.ZAR');

describe('layoutText', () => {
  it('moves the pen by int((width + DispPos - 1) x scale + 0.5), as FUN_00363c20 does', () => {
    // '3' 9 wide, '0' 10, '/' 12 with DispPos -1: at 0.9 the advances are 7, 8 and 9.
    const { glyphs, width } = layoutText('30/30', 15, 382, 0.9);
    glyphs.forEach((g, i) => expect(g.x - PEN_NUDGE).toBeCloseTo([15, 22, 30 - 0.9, 39, 46][i]!, 9));
    expect(width).toBe(7 + 8 + 9 + 7 + 8);
    expect(textWidth('30/30', 0.9)).toBe(width);
  });

  it('draws each glyph (width - 1) x scale + 0.5 wide over texels UL.x .. UL.x + width - 1', () => {
    const { glyphs } = layoutText('0', 0, 0, 0.9);
    expect(glyphs[0]).toMatchObject({ char: '0', u0: 389, u1: 398, v0: 0, v1: 25 });
    expect(glyphs[0]!.w).toBeCloseTo(9 * 0.9 + 0.5, 9);
  });

  it('stands the glyphs on the baseline: row 20 of the cell at the baseline + 0.3, 25 rows at scale x 448/480', () => {
    const { glyphs } = layoutText('A', 0, 382, 0.9);
    const k = 0.9 * TEXT_V;
    expect(glyphs[0]!.h).toBeCloseTo(25 * k, 9);
    expect(glyphs[0]!.y + 20 * k).toBeCloseTo(382.3, 9);
  });

  it('a space advances by int((10 - 3 - 1) x scale + 0.5) and draws nothing', () => {
    const { glyphs } = layoutText('2 MAGS', 0, 0, 0.9);
    expect(glyphs.map((g) => g.char).join('')).toBe('2MAGS');
    expect(glyphs[1]!.x - PEN_NUDGE).toBeCloseTo(7 + 5, 9);
  });

  it('at the ammo box scale 0.9 the glyphs land on the console frame glyph centroids (within half a pixel)', () => {
    // research 87 §3: the frame's glyph centroids (x) and the atlas's (texels from UL.x); the pens at 15 and 95.
    const atlas: Record<string, number> = { '3': 4.39, '0': 4.76, '/': 4.63, '2': 4.34, M: 5.9, A: 4.91, G: 5.17, S: 4.51 };
    const frame = [[19.34, 26.75, 33.75, 43.34, 50.75], [99.31, 112.96, 122.93, 132.19, 140.54]];
    [['30/30', 15], ['2 MAGS', 95]].forEach(([line, pen], i) => {
      const { glyphs } = layoutText(line as string, pen as number, 382, 0.9);
      glyphs.forEach((g, j) => {
        const texels = g.u1 - g.u0;                                 // the width - 1 texels the quad spans
        // The GS samples at the pixel's corner: the drawn texels sit GS_SAMPLE_OFFSET right of the quad's (./hud).
        const x = g.x + GS_SAMPLE_OFFSET + ((atlas[g.char]! + 0.5) / (texels + 1)) * g.w;
        expect(Math.abs(x - frame[i]![j]!), `${line} ${g.char}`).toBeLessThan(0.5);
      });
    });
  });
});

describe.skipIf(readerc === null)(`FONT_TEXT_01 against READERC.ZAR/fonts.rdr${readerc === null ? ` (${FIXTURES_ABSENT})` : ''}`, () => {
  it('every transcribed glyph is the archive\'s, and the header too', () => {
    const zar = Zar.parse(readerc!);
    const key = zar.root.children.find((k) => k.name.toLowerCase() === 'fonts.rdr')!;
    const root = parseRdr(zar.data(key)) as RdrNode[];
    const face = rdrGet(rdrGet(root[0]!, 'faces')!, 'font_text_01')!;
    expect(rdrGet(face, 'opacity')).toBe('0.7');
    expect(rdrGet(face, 'xspacing')).toBe('0');
    const list = rdrGet(face, 'charoffsets') as RdrNode[];
    const firstOf = new Map<number, number[]>();
    for (const c of list) {
      const code = Number(rdrGet(c, 'Code'));
      if (firstOf.has(code)) continue;
      const e0 = rdrGet(c, 'Elems') as RdrNode[];
      const e = (typeof e0[0] === 'string' ? e0 : e0[0]) as RdrNode[];
      const [ux, uy] = (rdrGet(e, 'UL') as string[]).map(Number);
      const [lx, ly] = (rdrGet(e, 'LR') as string[]).map(Number);
      const [dx] = (rdrGet(e, 'DispPos') as string[]).map(Number);
      firstOf.set(code, [code, ux!, uy!, lx!, ly!, dx!]);
    }
    expect(FONT_TEXT_01.glyphs).toHaveLength(95);
    for (const g of FONT_TEXT_01.glyphs) expect(g).toEqual(firstOf.get(g[0]));
  });
});
