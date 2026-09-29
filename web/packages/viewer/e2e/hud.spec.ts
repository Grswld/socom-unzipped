import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
// `src/hook.ts` is types only; its `declare global` is what makes `window.__viewer` exist inside `page.evaluate`.
import type {} from '../src/hook';

/**
 * The in-game HUD on Frostfire (web/docs/research/87-hud.md): in walk mode, in the PS2 presentation, the ammo box, the
 * compass, the info box and the prompts are drawn at `CHUD`'s places, and the drawn pixels are checked against the
 * console's own frame at spawn (`scripts/parity/refs/console_spawn_slot8.png`, 640x448): each element's sub-pixel
 * offset, by cross-correlation of the two frames over the element's box, within a pixel. Not drawn in fly mode.
 */

const SCREENS = fileURLToPath(new URL('../../../test-fixtures/screens/hud', import.meta.url));
const CONSOLE = fileURLToPath(new URL('../../../../scripts/parity/refs/console_spawn_slot8.png', import.meta.url));
/** A's spawn (KNOWN section 1), the feet; the eye over them. */
const SPAWN_A: [number, number, number] = [796, 100, 614];
const EYE = 15.4;

const settle = (page: Page): Promise<void> => page.evaluate(
  () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
);

const setToggle = (page: Page, id: string, on: boolean): Promise<void> =>
  page.locator(`#${id}`).evaluate((el, checked) => {
    const box = el as HTMLInputElement;
    if (box.checked === checked) return;
    box.checked = checked;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  }, on);

/** The drawing buffer as a PNG data URL, read in the frame it was drawn (the canvas keeps no copy after). */
const grab = (page: Page): Promise<string> => page.evaluate(() => new Promise<string>((done) =>
  requestAnimationFrame(() => done((document.querySelector('#view') as HTMLCanvasElement).toDataURL('image/png')))));

/**
 * Where each box's content sits in the second frame against the first: the shift (dx, dy) of the first, with a
 * 9-pixel box blur taken off both (the worlds under the HUD differ), that best correlates with the second.
 */
async function offsets(page: Page, ours: string, theirs: string, boxes: Record<string, [number, number, number, number]>) {
  return page.evaluate(async ({ ours, theirs, boxes }) => {
    const pixels = async (url: string): Promise<ImageData> => {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      return g.getImageData(0, 0, img.width, img.height);
    };
    const [a, b] = await Promise.all([pixels(ours), pixels(theirs)]);
    const luma = (d: ImageData, x0: number, y0: number, w: number, h: number): Float64Array => {
      const out = new Float64Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = ((y0 + y) * d.width + x0 + x) * 4;
        out[y * w + x] = (d.data[i]! + d.data[i + 1]! + d.data[i + 2]!) / 3;
      }
      const k = 4, flat = new Float64Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let v = Math.max(0, y - k); v <= Math.min(h - 1, y + k); v++) for (let u = Math.max(0, x - k); u <= Math.min(w - 1, x + k); u++) { s += out[v * w + u]!; n++; }
        flat[y * w + x] = out[y * w + x]! - s / n;
      }
      return flat;
    };
    const result: Record<string, { dx: number; dy: number; r: number }> = {};
    for (const [name, [x0, x1, y0, y1]] of Object.entries(boxes)) {
      const pad = 4, w = x1 - x0 + 2 * pad, h = y1 - y0 + 2 * pad;
      const A = luma(a, x0 - pad, y0 - pad, w, h), B = luma(b, x0 - pad, y0 - pad, w, h);
      const at = (img: Float64Array, x: number, y: number): number => {
        const fx = Math.floor(x), fy = Math.floor(y), tx = x - fx, ty = y - fy;
        const p = (u: number, v: number): number => img[Math.min(h - 1, Math.max(0, v)) * w + Math.min(w - 1, Math.max(0, u))]!;
        return p(fx, fy) * (1 - tx) * (1 - ty) + p(fx + 1, fy) * tx * (1 - ty) + p(fx, fy + 1) * (1 - tx) * ty + p(fx + 1, fy + 1) * tx * ty;
      };
      let best = { dx: 0, dy: 0, r: -2 };
      const search = (cx: number, cy: number, span: number, step: number): void => {
        for (let dx = cx - span; dx <= cx + span + 1e-9; dx += step) for (let dy = cy - span; dy <= cy + span + 1e-9; dy += step) {
          let sa = 0, sb = 0, n = 0;
          const va: number[] = [], vb: number[] = [];
          for (let y = pad; y < h - pad; y++) for (let x = pad; x < w - pad; x++) {
            const p = at(A, x - dx, y - dy), q = B[y * w + x]!;
            va.push(p); vb.push(q); sa += p; sb += q; n++;
          }
          const ma = sa / n, mb = sb / n;
          let ab = 0, aa = 0, bb = 0;
          for (let i = 0; i < n; i++) { const p = va[i]! - ma, q = vb[i]! - mb; ab += p * q; aa += p * p; bb += q * q; }
          const r = ab / Math.sqrt(aa * bb);
          if (r > best.r) best = { dx, dy, r };
        }
      };
      search(0, 0, 2.5, 0.25);
      search(best.dx, best.dy, 0.25, 0.05);
      result[name] = best;
    }
    return result;
  }, { ours, theirs, boxes });
}

test('walk mode on Frostfire draws the console\'s HUD at the console frame\'s pixels, within a pixel', async ({ page }) => {
  mkdirSync(SCREENS, { recursive: true });
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || (m.type() === 'warning' && /GL_INVALID|WebGPU.*(error|fail)/i.test(m.text()))) {
      problems.push(`console: ${m.text()}`);
    }
  });

  await page.goto('/?redotcom');
  const status = page.locator('#status');
  await expect(status).toContainText('triangles');
  await page.locator('#maps').selectOption('RUN/MP2.ZDB');
  await expect(status).toContainText('FROSTFIRE (MP2)');
  await expect(status).toContainText('triangles');
  expect((await page.evaluate(() => window.__viewer.stats())).diagnostics).toEqual([]);

  await setToggle(page, 'ps2look', true);
  await settle(page);
  // Flying: no HUD, and no HTML pill stands in for the ammo box any more.
  expect((await page.evaluate(() => window.__viewer.hud())).visible).toBe(false);
  await expect(page.locator('#ammo')).toHaveCount(0);

  expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(true);
  // The console frame's heading: it looks down +z (research 17), the viewer's yaw 180; its N at the ring's foot.
  await page.evaluate(([x, y, z, eye]) => window.__viewer.setCamera({ x, y: y + eye, z, yaw: 180, pitch: -9.167 }), [...SPAWN_A, EYE] as const);
  // The HUD fades in over 1.5 s after a spawn (DAT_003dc380).
  await page.waitForTimeout(1700);
  const live = await page.evaluate(() => window.__viewer.hud());
  expect(live.visible).toBe(true);
  expect(live.timing.fade).toBe(1);
  expect(live.frame).toEqual({ width: 640, height: 448 });
  expect(live.model).toMatchObject({ rounds: 30, capacity: 30, spare: 2, fireMode: 'burst', weaponIcon: 'm4carbine_icon.tif' });
  expect(Math.abs((((live.model.yaw % 360) + 360) % 360) - 180)).toBeLessThan(1e-6);

  // The console's still: its magazine and heading held.
  const shown = await page.evaluate(() => window.__viewer.setHud({ frozen: true, settled: true, yaw: 180, rounds: 30, capacity: 30, spare: 2, range: null }));
  expect(shown.rects.panel).toEqual({ x: -10, y: 364, width: 170, height: 75 });
  expect(shown.rects.icon).toEqual({ x: 20, y: 389, width: 128, height: 32 });
  expect(shown.rects.firemode).toEqual({ x: 10, y: 422, width: 109, height: 16 });
  expect(shown.rects.bar).toEqual({ x: 488, y: 396, width: 134, height: 18 });
  const compass = shown.rects.compass!;
  expect(compass.x + compass.width / 2).toBeCloseTo(565, 6);
  expect(compass.y + compass.height / 2).toBeCloseTo(90, 6);
  await settle(page);
  const ours = await grab(page);
  writeFileSync(join(SCREENS, 'frostfire-ps2-spawn-hud.png'), Buffer.from(ours.split(',')[1]!, 'base64'));

  // Each element against the console's own pixels (research 87 §6's table): the content's offset within a pixel.
  const theirs = `data:image/png;base64,${readFileSync(CONSOLE).toString('base64')}`;
  const found = await offsets(page, ours, theirs, {
    'rounds "30/30"': [12, 58, 366, 386], 'magazines "2 MAGS"': [92, 146, 366, 386], 'rifle icon': [20, 148, 389, 421],
    'fire-mode rounds': [8, 122, 423, 437],
  });
  writeFileSync(join(SCREENS, 'offsets.json'), `${JSON.stringify(found, null, 2)}
`);
  for (const [name, { dx, dy, r }] of Object.entries(found)) {
    expect(r, `${name}: correlation`).toBeGreaterThan(0.7);
    expect(Math.hypot(dx, dy), `${name}: offset (${dx.toFixed(2)}, ${dy.toFixed(2)})`).toBeLessThanOrEqual(1);
  }

  // The climb prompt (the traversal's `climbPrompt()` fed through `setHud`): action_climb, 50x50 on x 306.
  const prompted = await page.evaluate(() => window.__viewer.setHud({ climb: { visible: true, kind: 'med' } }));
  expect(prompted.model.action).toBe('climb');
  expect(prompted.rects.action).toEqual({ x: 281, y: 365, width: 50, height: 50 });
  await settle(page);
  writeFileSync(join(SCREENS, 'frostfire-ps2-spawn-hud-climb.png'), Buffer.from((await grab(page)).split(',')[1]!, 'base64'));
  await page.evaluate(() => window.__viewer.setHud({ climb: { visible: false, kind: 'med' }, frozen: false }));

  // The native presentation: the HUD scaled by the height / 448, the compass kept to the right edge.
  await setToggle(page, 'ps2look', false);
  await settle(page);
  await settle(page);
  const native = await page.evaluate(() => window.__viewer.hud());
  const s = native.frame.height / 448;
  expect(native.rects.compass!.width).toBeCloseTo(96 * s, 6);
  expect(native.frame.width - (native.rects.compass!.x + native.rects.compass!.width / 2)).toBeCloseTo(75 * s, 6);
  expect(native.rects.panel!.y).toBeCloseTo(364 * s, 6);

  expect(await page.evaluate(() => window.__viewer.setMode('fly'))).toBe(true);
  await settle(page);
  expect((await page.evaluate(() => window.__viewer.hud())).visible).toBe(false);
  expect(problems).toEqual([]);
});
