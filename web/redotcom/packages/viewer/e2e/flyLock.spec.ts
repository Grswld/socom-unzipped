import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type {} from '../src/hook';
import { buildIso } from '../../archive/test/isoImage';

/**
 * Owner, 2026-09-29: "Block the fly automatically and disable it while in play mode" (`../src/flyAccess.ts`). A player's
 * page -- no `?devmode`, so the game comes from the player's own disc image, as on the deployed site -- has no way into
 * the free camera in Play: no Fly / Walk switch, `G` and the hook refused, `&fly` ignored and taken out of the address,
 * and the Controls lists name no toggle. The developer's `?devmode` keeps all of it.
 *
 * The disc is Frostfire's archive packed into an ISO9660 image (as `iso.spec.ts` makes it; game bytes, so under the
 * git-ignored `test-fixtures/`), opened through the disc page's file input.
 */
const FIXTURES = fileURLToPath(new URL('../../../test-fixtures', import.meta.url));
const MP2 = join(FIXTURES, 'RUN', 'MP2.ZDB');
const ISO = join(FIXTURES, 'iso', 'frostfire-flylock.iso');

test.skip(!existsSync(MP2), 'fixtures absent: run npm run extract-maps');
test.use({ storageState: { cookies: [], origins: [] } });

test.beforeAll(() => {
  mkdirSync(dirname(ISO), { recursive: true });
  writeFileSync(ISO, buildIso([{ path: 'RUN/MP2.ZDB', bytes: new Uint8Array(readFileSync(MP2)) }], 'SCUS_97275'));
});

test('a player in Play cannot reach the fly camera by any input', async ({ page }) => {
  await page.goto('/?mode=play&fly&nomatch');
  await expect(page.locator('#disc-page')).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.has('fly')).toBe(false);     // ignored, and out of the address
  await page.locator('#disc-page-file').setInputFiles(ISO);
  await expect(page.locator('#status')).toContainText('triangles', { timeout: 60_000 });
  // Play opens on foot (the &fly was not honoured).
  await expect.poll(() => page.evaluate(() => window.__viewer.mode()), { timeout: 60_000 }).toBe('walk');
  await expect(page.locator('#mode')).toHaveCount(0);                                     // no Fly / Walk switch
  await page.locator('#view').click();
  await page.keyboard.press('KeyG');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__viewer.mode())).toBe('walk');                 // G does nothing
  expect(await page.evaluate(() => window.__viewer.setMode('fly'))).toBe(false);          // nor the hook
  expect(await page.evaluate(() => window.__viewer.mode())).toBe('walk');
  await page.keyboard.press('Escape');
  await page.locator('#controls-toggle').click();
  await expect(page.locator('#keys-list')).not.toContainText(/fly camera|Gwalk/);
  await page.locator('#controls-tab-pad').click();
  await expect(page.locator('#pad-list')).not.toContainText('Start');
});

test('the developer (devmode) keeps the switch, G and &fly', async ({ page }) => {
  await page.goto('/?mode=play&fly&devmode&map=MP2');
  await expect(page.locator('#status')).toContainText('triangles');
  expect(new URL(page.url()).searchParams.has('fly')).toBe(true);
  expect(await page.evaluate(() => window.__viewer.mode())).toBe('fly');                  // &fly: the free camera
  await expect(page.locator('#mode')).toHaveCount(1);
  expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(true);
  expect(await page.evaluate(() => window.__viewer.setMode('fly'))).toBe(true);
  await page.keyboard.press('KeyG');
  await expect.poll(() => page.evaluate(() => window.__viewer.mode())).toBe('walk');
});
