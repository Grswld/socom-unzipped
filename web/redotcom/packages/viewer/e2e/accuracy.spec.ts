import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import type {} from '../src/hook';

/**
 * The gunplay on Frostfire (research 84, `src/accuracy.ts`, `src/zoom.ts`): the reticle at rest, opened by the walk,
 * climbed and opened by a burst, and the scope the zoom steps into -- in the PS2 presentation, so the HUD's pixels are
 * the console's. Screenshots of each go to `web/redotcom/test-fixtures/screens/accuracy` (git-ignored).
 */

const SCREENS = fileURLToPath(new URL('../../../test-fixtures/screens/accuracy', import.meta.url));
const SPAWN_A: [number, number, number] = [796, 100, 614];

const settle = (page: Page, frames = 2): Promise<void> => page.evaluate((n) => new Promise<void>((done) => {
  let left = n;
  const step = (): void => { if (--left <= 0) done(); else requestAnimationFrame(step); };
  requestAnimationFrame(step);
}), frames);

test('the reticle blooms with the walk and a burst, climbs with the knock, and the zoom steps into the scope', async ({ page }) => {
  mkdirSync(SCREENS, { recursive: true });
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto('/?mode=play&fly&devmode');
  const status = page.locator('#status');
  await expect(status).toContainText('triangles');
  await page.locator('#maps').selectOption('RUN/MP2.ZDB');
  await expect(status).toContainText('FROSTFIRE (MP2)');
  await expect(status).toContainText('triangles');
  await page.locator('#ps2look').evaluate((el) => {
    const box = el as HTMLInputElement;
    if (!box.checked) { box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(true);
  await page.evaluate(([x, y, z]) => window.__viewer.setCamera({ x, y: y + 15.4, z, yaw: 0, pitch: 0 }), SPAWN_A);
  await settle(page, 30);

  // At rest, third person: TargetMin 1 drawn at half -- the console frame's 65-pixel cross.
  const rest = await page.evaluate(() => ({ r: window.__viewer.reticle(), a: window.__viewer.accuracy(), z: window.__viewer.zoom() }));
  expect(rest.z.state).toBe(0);
  expect(rest.a.size).toBe(1);
  expect(rest.r.size).toBe(0.5);
  expect(rest.r.rect!.width).toBeCloseTo(65, 6);
  expect(rest.r.rect!.x).toBeCloseTo(287.5, 6);
  await page.screenshot({ path: join(SCREENS, '1-rest.png') });

  // Walking (W held): the 60 Hz walk opens it toward |v|^2 / 65 -- the standing run is past TargetMax.
  await page.locator('canvas').first().hover();
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(700);
  const moving = await page.evaluate(() => ({ a: window.__viewer.accuracy(), r: window.__viewer.reticle() }));
  await page.screenshot({ path: join(SCREENS, '2-moving.png') });
  await page.keyboard.up('KeyW');
  expect(moving.a.target).toBeGreaterThan(5);
  expect(moving.a.size).toBeGreaterThan(5);
  expect(moving.r.rect!.width).toBeGreaterThan(70);

  // Let it close, then a burst: the knock climbs the reticle and the bloom opens it.
  await settle(page, 180);
  const before = await page.evaluate(() => ({ a: window.__viewer.accuracy(), shots: window.__viewer.fire().shots }));
  expect(before.a.size).toBeLessThan(2);
  // The rifle comes up on burst (FUN_005c0250); automatic for the held trigger (0.8 x FireWait = 0.112 s a round).
  expect(await page.evaluate(() => window.__viewer.fireMode())).toBe('BURST');
  expect(await page.evaluate(() => window.__viewer.switchFireMode())).toBe('AUTO');
  expect((await page.evaluate(() => window.__viewer.hud())).model.fireMode).toBe('auto');
  await page.evaluate(() => window.__viewer.trigger(true));
  await page.waitForTimeout(450);
  const burst = await page.evaluate(() => ({ a: window.__viewer.accuracy(), r: window.__viewer.reticle(), shots: window.__viewer.fire().shots }));
  await page.screenshot({ path: join(SCREENS, '3-burst.png') });
  await page.evaluate(() => window.__viewer.trigger(false));
  expect(burst.shots - before.shots).toBeGreaterThanOrEqual(3);
  expect(burst.a.size).toBeGreaterThan(before.a.size);
  expect(burst.r.offset[1]).toBeLessThan(-10);                       // up the screen


  // The zoom: straight into the SD's 3x scope -- no first-person step (owner, 2026-09-29), drawn from the head.
  expect(await page.evaluate(() => window.__viewer.cycleZoom())).toBe(5);
  await settle(page, 30);
  expect((await page.evaluate(() => window.__viewer.camera()))!.mode).toBe('scope');
  const scoped = await page.evaluate(() => ({ z: window.__viewer.zoom(), r: window.__viewer.reticle() }));
  expect(scoped.z.magnification).toBe(3);
  expect(scoped.z.fov).toBeLessThan(20);
  expect(scoped.r.mode).toBe('scope');
  await page.screenshot({ path: join(SCREENS, '5-scope.png') });
  // A two-round pull scoped drops the scope (FUN_005c5340: to the game's first person, here third person).
  expect(await page.evaluate(() => window.__viewer.fireMode())).toBe('AUTO');
  expect(await page.evaluate(() => window.__viewer.switchFireMode())).toBe('AUTO');   // no switch while scoped
  await page.evaluate(() => window.__viewer.trigger(true));
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__viewer.trigger(false));
  expect((await page.evaluate(() => window.__viewer.zoom())).state).toBe(0);
  await settle(page, 5);
  expect((await page.evaluate(() => window.__viewer.camera()))!.mode).toBe('third');
  expect(await page.evaluate(() => window.__viewer.zoomOut())).toBe(0);
  expect(await page.evaluate(() => window.__viewer.switchFireMode())).toBe('SEMI');
  expect(problems).toEqual([]);
});

test('a night map: the zoom steps third person -> night vision -> scope, the goggles and the lens colour on the lit colours', async ({ page }) => {
  mkdirSync(SCREENS, { recursive: true });
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto('/?mode=play&fly&devmode');
  const status = page.locator('#status');
  await expect(status).toContainText('triangles');
  await page.locator('#maps').selectOption('RUN/MP1.ZDB');          // NightMission 1 (research 84 section 11)
  await expect(status).toContainText('(MP1)');
  await expect(status).toContainText('triangles');
  await page.locator('#ps2look').evaluate((el) => {
    const box = el as HTMLInputElement;
    if (!box.checked) { box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(true);
  await settle(page, 20);
  expect(await page.evaluate(() => window.__viewer.zoomIn())).toBe(3);
  await settle(page, 10);
  const night = await page.evaluate(() => ({ z: window.__viewer.zoom(), row: window.__viewer.stats().nightVision }));
  expect(night.z.view).toBe('nightvision');
  // The lens's row on every lit colour (VU1 command 0x5c, `./nightVision`): 0.33 x (0.2, 0.898, 0.2), 3.03 x 0.24.
  expect(night.row).not.toBeNull();
  expect(night.row![1]).toBeCloseTo(0.898 * 0.33, 3);
  expect(night.row![3]).toBeCloseTo(0.24 * 3.030303, 3);
  await page.screenshot({ path: join(SCREENS, '6-night-vision.png') });
  expect(await page.evaluate(() => window.__viewer.zoomIn())).toBe(5);
  await settle(page, 20);
  expect(await page.evaluate(() => window.__viewer.stats().nightVision)).toBeNull();
  expect(await page.evaluate(() => window.__viewer.zoomOut())).toBe(3);   // out of the scope, back to the night vision
  expect(await page.evaluate(() => window.__viewer.zoomOut())).toBe(0);   // and out to third person
  expect(problems).toEqual([]);
});
