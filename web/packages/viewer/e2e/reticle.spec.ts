import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
// `src/hook.ts` is types only; its `declare global` is what makes `window.__viewer` exist inside `page.evaluate`.
import type {} from '../src/hook';

/**
 * The reticle on Frostfire (web sprint 2, W2.4): in walk mode, in the PS2 presentation, the game's rifle reticle is
 * drawn where the console frame at spawn draws it (`scripts/parity/refs/console_spawn_slot8.png`: the cross's
 * pixels x 288-352, y 192-256 of 640x448, `src/reticle.ts`), and not drawn in fly mode.
 */

/** Screenshots are evidence, not fixtures: `web/test-fixtures/` is git-ignored. */
const SCREENS = fileURLToPath(new URL('../../../test-fixtures/screens/reticle', import.meta.url));
/** A's spawn (KNOWN section 1), the feet; the walk's eye 15.4 over them (W1.R2). */
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

test('walk mode on Frostfire draws the rifle reticle at the console frame\'s place and size', async ({ page }) => {
  mkdirSync(SCREENS, { recursive: true });
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || (m.type() === 'warning' && /GL_INVALID|WebGPU.*(error|fail)/i.test(m.text()))) {
      problems.push(`console: ${m.text()}`);
    }
  });

  await page.goto('/');
  const status = page.locator('#status');
  await expect(status).toContainText('triangles');
  await page.locator('#maps').selectOption('RUN/MP2.ZDB');
  await expect(status).toContainText('FROSTFIRE (MP2)');
  await expect(status).toContainText('triangles');
  expect((await page.evaluate(() => window.__viewer.stats())).diagnostics).toEqual([]);

  await setToggle(page, 'ps2look', true);
  await settle(page);
  // Flying: no reticle.
  expect((await page.evaluate(() => window.__viewer.reticle())).visible).toBe(false);

  expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(true);
  await page.evaluate(([x, y, z, eye]) => window.__viewer.setCamera({ x, y: y + eye, z, yaw: 0, pitch: 0 }), [...SPAWN_A, EYE] as const);
  await settle(page);
  const shown = await page.evaluate(() => window.__viewer.reticle());
  expect(shown.visible).toBe(true);
  expect(shown.frame).toEqual({ width: 640, height: 448 });
  // `reticleLayout` at 640x448, the aim point at the centre: the console's 65 x 65 at (288, 192), within a pixel. The
  // aim point is W2.1's projected aim (the frame's centre at rest, to float rounding), so the corner is to 0.01. At
  // rest in third person the HUD's size is TargetMin 1 halved (research 84 section 3): the arms half a pixel out.
  expect(shown.size).toBe(0.5);
  expect(shown.rect!.x).toBeCloseTo(287.5, 2);
  expect(shown.rect!.y).toBeCloseTo(191.5, 2);
  expect(shown.rect!.width).toBeCloseTo(65, 6);
  expect(shown.rect!.height).toBeCloseTo(65, 6);
  await page.locator('#view').screenshot({ path: join(SCREENS, 'frostfire-ps2-spawn-reticle.png') });

  expect(await page.evaluate(() => window.__viewer.setMode('fly'))).toBe(true);
  await settle(page);
  expect((await page.evaluate(() => window.__viewer.reticle())).visible).toBe(false);
  expect(problems).toEqual([]);
});
