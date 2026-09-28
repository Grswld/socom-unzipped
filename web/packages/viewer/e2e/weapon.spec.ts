import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
// `src/hook.ts` is types only; its `declare global` is what makes `window.__viewer` exist inside `page.evaluate`.
import type {} from '../src/hook';

/**
 * The WEAPON workstream on Frostfire: the M4A1 SD in the SEAL's right hand at the low ready, raised to the shoulder
 * while the trigger is held (the Fire set, `seal_fp_stand`), a round from the muzzle, the aim kicked up and let back,
 * a reload playing its clip, and no satchel on the back (the game hides it until the bomb is picked up).
 */

const SCREENS = fileURLToPath(new URL('../../../test-fixtures/screens/weapon', import.meta.url));
const SPAWN_A: [number, number, number] = [796, 100, 614];
const EYE = 15.4;
const REST_PITCH = -9.167;

const settle = (page: Page): Promise<void> => page.evaluate(
  () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
);

test('the rifle in the hands, raised to fire, from the muzzle, kicked, reloaded; no satchel', async ({ page }) => {
  mkdirSync(SCREENS, { recursive: true });
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });

  await page.goto('/');
  const status = page.locator('#status');
  await expect(status).toContainText('triangles');
  await page.locator('#maps').selectOption('RUN/MP2.ZDB');
  await expect(status).toContainText('FROSTFIRE (MP2)');
  await expect(status).toContainText('triangles');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(true);
  await page.evaluate(([x, y, z, eye, pitch]) => window.__viewer.setCamera({ x, y: y + eye, z, yaw: 90, pitch }), [...SPAWN_A, EYE, REST_PITCH] as const);
  await expect.poll(async () => (await page.evaluate(() => window.__viewer.stats())).anim?.clip ?? null).toBe('seal_stand');
  await page.waitForTimeout(1500);                             // the props stream in
  await settle(page);

  // In hand, down; the satchel built and hidden.
  const low = await page.evaluate(() => window.__viewer.weapon());
  expect(low).toMatchObject({ held: true, raise: { state: 'down', weight: 0 }, pose: { fire: null } });
  expect(low.muzzle).not.toBeNull();
  const body = (await page.evaluate(() => window.__viewer.stats())).body!;
  expect(body.fittingNames).toContain('Satchel');
  expect(body.hiddenGear).toEqual(['Satchel']);
  await page.screenshot({ path: join(SCREENS, 'frostfire-a-low-ready.png') });

  // The trigger held: raised in 0.1 s, the Fire version at full weight, rounds from the muzzle, the aim kicked up.
  const pitch0 = (await page.evaluate(() => window.__viewer.camera()))!.pitch;
  await page.evaluate(() => window.__viewer.trigger(true));
  await page.waitForTimeout(300);
  const up = await page.evaluate(() => window.__viewer.weapon());
  expect(up).toMatchObject({ raise: { state: 'up', weight: 1 }, pose: { fire: 'seal_fp_stand', fireWeight: 1 } });
  expect(up.muzzle![1]).toBeGreaterThan(low.muzzle![1] + 1);   // at the shoulder, over the low ready
  await page.screenshot({ path: join(SCREENS, 'frostfire-a-fire-pose.png') });
  await page.evaluate(() => window.__viewer.trigger(false));
  const fired = await page.evaluate(() => window.__viewer.fire());
  expect(fired.shots).toBeGreaterThan(0);
  expect((await page.evaluate(() => window.__viewer.camera()))!.pitch).toBeGreaterThan(pitch0 + 1);

  // Still up after the release (the controller's 5 s), and the reload plays its clip.
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(400);
  const reloading = await page.evaluate(() => window.__viewer.weapon());
  expect(reloading).toMatchObject({ raise: { state: 'up' }, pose: { reload: 'seal_reload' } });
  expect((await page.evaluate(() => window.__viewer.fire())).magazine.reloading).toBe(true);
  await page.screenshot({ path: join(SCREENS, 'frostfire-a-reload.png') });
  expect(problems).toEqual([]);
});
