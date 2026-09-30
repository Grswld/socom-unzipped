import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
// `src/hook.ts` is types only; its `declare global` is what makes `window.__viewer` exist inside `page.evaluate`.
import type {} from '../src/hook';

/**
 * The yellow arc on Frostfire (web/redotcom/docs/research/85 §11, `FUN_005970b0`): with the M67 up and the trigger held the arc
 * shows -- the game's (0.78, 0.78, 0), its 100 steps and the closing one -- and grows as the power builds; let go, it is
 * gone, and the grenade that leaves follows it. The screenshot is the evidence.
 */

const SCREENS = fileURLToPath(new URL('../../../test-fixtures/screens/grenade', import.meta.url));
const SPAWN_A: [number, number, number] = [796, 100, 614];
const EYE = 15.4;

const settle = (page: Page): Promise<void> => page.evaluate(
  () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
);

test('walk mode on Frostfire: the yellow arc shows while the throw is held and is gone once it is thrown', async ({ page }) => {
  mkdirSync(SCREENS, { recursive: true });
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || (m.type() === 'warning' && /GL_INVALID|WebGPU.*(error|fail)/i.test(m.text()))) problems.push(`console: ${m.text()}`);
  });

  await page.goto('/?mode=play&fly&devmode');
  const status = page.locator('#status');
  await expect(status).toContainText('triangles');
  await page.locator('#maps').selectOption('RUN/MP2.ZDB');
  await expect(status).toContainText('FROSTFIRE (MP2)');
  await expect(status).toContainText('triangles');

  // West-south-west of A the dock is open (grenade.spec.ts), aimed a little up.
  expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(true);
  await page.evaluate(([x, y, z, eye]) => window.__viewer.setCamera({ x, y: y + eye, z, yaw: 240, pitch: 12 }), [...SPAWN_A, EYE] as const);
  await page.evaluate(() => window.__viewer.walkFor(0.3, { forward: 0 }));
  await page.waitForTimeout(1000);
  await page.keyboard.press('Backquote');                    // the panel away: the picture is the evidence
  expect(await page.evaluate(() => window.__viewer.equipGrenade(true))).toBe(true);
  await settle(page);
  expect((await page.evaluate(() => window.__viewer.grenade())).arc).toBeNull();   // up, not held: no arc

  // The trigger held: the arc, yellow, and longer as the power builds.
  await page.evaluate(() => window.__viewer.trigger(true));
  await expect.poll(() => page.evaluate(() => window.__viewer.grenade().arc?.visible ?? false)).toBe(true);
  const early = (await page.evaluate(() => window.__viewer.grenade())).arc!;
  expect(early.segments).toBe(101);
  expect(early.color[0]).toBeCloseTo(0.78, 5);
  expect(early.color[1]).toBeCloseTo(0.78, 5);
  expect(early.color[2]).toBe(0);
  expect((await page.evaluate(() => window.__viewer.grenade())).phase).toBe('holding');
  await page.waitForTimeout(700);
  await settle(page);
  const late = (await page.evaluate(() => window.__viewer.grenade())).arc!;
  expect(late.visible).toBe(true);
  expect(Math.hypot(...late.velocity)).toBeGreaterThan(Math.hypot(...early.velocity));
  await page.locator('#view').screenshot({ path: join(SCREENS, 'frostfire-grenade-arc.png') });

  // Let go: the arc is gone at once (the clip starts), and the grenade leaves.
  await page.evaluate(() => window.__viewer.trigger(false));
  await expect.poll(() => page.evaluate(() => window.__viewer.grenade().arc)).toBeNull();
  await expect.poll(() => page.evaluate(() => window.__viewer.grenade().lastThrow !== null), { timeout: 5_000 }).toBe(true);
  const after = await page.evaluate(() => window.__viewer.grenade());
  expect(after.arc).toBeNull();
  expect(after.live.length).toBe(1);
  // It flies the arc's way: the same heading over the ground (the release is the posed hand's, the arc the table's).
  const t = after.lastThrow!;
  const heading = (v: readonly number[]): number => Math.atan2(v[0]!, v[2]!);
  expect(Math.abs(heading(t.velocity) - heading(late.velocity))).toBeLessThan(0.1);
  expect(problems).toEqual([]);
});
