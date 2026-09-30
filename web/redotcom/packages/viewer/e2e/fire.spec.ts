import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
// `src/hook.ts` is types only; its `declare global` is what makes `window.__viewer` exist inside `page.evaluate`.
import type {} from '../src/hook';

/**
 * A shot on Frostfire (web sprint 2, W2.5): in walk mode at spawn A, facing west at the rest pitch, one round through
 * the hook meets the side of `container_blue01` 12 units west of A (`test/fire.test.ts` records the same hit off the
 * hull), leaves one mark, and the ammo box counts it. The screenshot is the evidence: the mark under the reticle.
 */

/** Screenshots are evidence, not fixtures: `web/test-fixtures/` is git-ignored. */
const SCREENS = fileURLToPath(new URL('../../../test-fixtures/screens/fire', import.meta.url));
/** A's spawn (KNOWN section 1), the feet; the pose drops the mover from 15.4 over them (W1.R2). */
const SPAWN_A: [number, number, number] = [796, 100, 614];
const EYE = 15.4;
/** `dynamics.rdr`'s `init_aim_pitch` (W2.1). */
const REST_PITCH = -9.167;

const settle = (page: Page): Promise<void> => page.evaluate(
  () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
);

test('walk mode on Frostfire: one round marks the container west of spawn A and the ammo box counts it', async ({ page }) => {
  mkdirSync(SCREENS, { recursive: true });
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || (m.type() === 'warning' && /GL_INVALID|WebGPU.*(error|fail)/i.test(m.text()))) {
      problems.push(`console: ${m.text()}`);
    }
  });

  await page.goto('/?mode=play&fly&devmode');
  const status = page.locator('#status');
  await expect(status).toContainText('triangles');
  await page.locator('#maps').selectOption('RUN/MP2.ZDB');
  await expect(status).toContainText('FROSTFIRE (MP2)');
  await expect(status).toContainText('triangles');
  expect((await page.evaluate(() => window.__viewer.stats())).diagnostics).toEqual([]);

  // Flying: no shot, no box.
  expect(await page.evaluate(() => window.__viewer.shoot())).toBeNull();
  expect((await page.evaluate(() => window.__viewer.hud())).visible).toBe(false);

  expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(true);
  await page.evaluate(([x, y, z, eye, pitch]) => window.__viewer.setCamera({ x, y: y + eye, z, yaw: 90, pitch }),
    [...SPAWN_A, EYE, REST_PITCH] as const);
  await page.evaluate(() => window.__viewer.walkFor(0.5, { forward: 0 }));
  // The status line is written when the world is drawn; the props (the container among them) stream in over the
  // frames after it (`main.ts`'s reveal), and the screenshot is evidence only once they are in.
  await page.waitForTimeout(1500);
  await settle(page);
  // The ammo box is the in-game HUD's (`src/hud.ts`, research 87): "30/30" and "2 MAGS".
  expect((await page.evaluate(() => window.__viewer.hud())).model).toMatchObject({ rounds: 30, capacity: 30, spare: 2 });

  // WEAPON: the round leaves the rifle's muzzle in the SEAL's right hand (`./heldItem`), not the eye, toward the point
  // under the reticle -- the container's side 37.379 along the eye's ray, where it lands.
  const eye = (await page.evaluate(() => window.__viewer.camera()))!.eye;
  const shot = await page.evaluate(() => window.__viewer.shoot());
  expect(shot).not.toBeNull();
  expect(shot!.hit).not.toBeNull();
  const muzzle = (await page.evaluate(() => window.__viewer.weapon())).muzzle!;
  expect(muzzle).not.toBeNull();
  expect(Math.hypot(shot!.from[0] - eye[0], shot!.from[1] - eye[1], shot!.from[2] - eye[2])).toBeGreaterThan(3);
  expect(Math.hypot(shot!.from[0] - SPAWN_A[0], shot!.from[2] - SPAWN_A[2])).toBeLessThan(12);   // at the body
  expect(Math.hypot(shot!.hit!.point[0] - eye[0], shot!.hit!.point[1] - eye[1], shot!.hit!.point[2] - eye[2])).toBeCloseTo(37.379, 1);
  const state = await page.evaluate(() => window.__viewer.fire());
  expect(state.shots).toBe(1);
  expect(state.decals).toBe(1);
  expect(state.magazine).toEqual({ rounds: 29, capacity: 30, spare: 2, reloading: false });
  await settle(page);
  expect((await page.evaluate(() => window.__viewer.hud())).model).toMatchObject({ rounds: 29, capacity: 30, spare: 2 });
  await page.locator('#view').screenshot({ path: join(SCREENS, 'frostfire-spawn-a-west-one-round.png') });
  // A few degrees' turn takes the reticle off the mark, so the second frame shows the mark alone.
  await page.evaluate((pitch) => window.__viewer.setCamera({ yaw: 86, pitch }), REST_PITCH);
  await settle(page);
  await page.locator('#view').screenshot({ path: join(SCREENS, 'frostfire-spawn-a-west-the-mark.png') });

  expect(await page.evaluate(() => window.__viewer.setMode('fly'))).toBe(true);
  await settle(page);
  expect((await page.evaluate(() => window.__viewer.hud())).visible).toBe(false);
  expect(problems).toEqual([]);
});
