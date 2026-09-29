import { expect, test, type Page } from '@playwright/test';
import type {} from '../src/hook';

/**
 * The Mode switch (owner, 2026-09-29): Map viewer / reCOM in the settings, the picture switch's markup, switched at run
 * time both ways without a reload (`../src/features.ts` `PlayUi`), remembered in this browser, `?redotcom` forcing it on.
 * A clean context but for the panel's "open" (the switch is in it), so no remembered mode leaks in from another spec.
 */
test.use({ storageState: { cookies: [], origins: [] } });

async function open(page: Page, query: string): Promise<void> {
  await page.addInitScript(() => { localStorage.setItem('s2u.viewer.panelOpen', '1'); });
  await page.goto(`/${query}`);
  await expect(page.locator('#status')).toContainText(/triangles|tris/);
}
const recom = (page: Page, which: 'on' | 'off') => page.locator(`#recom [data-recom="${which}"]`);

test('a first visit is the map viewer; reCOM comes on and off at run time and is remembered', async ({ page }) => {
  await open(page, '?devmode&map=MP2');
  await expect(recom(page, 'off')).toHaveAttribute('aria-pressed', 'true');
  for (const id of ['mode', 'sound-section', 'look-section', 'touch-walk']) await expect(page.locator(`#${id}`)).toHaveCount(0);
  expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(false);

  await recom(page, 'on').click();
  await expect(recom(page, 'on')).toHaveAttribute('aria-pressed', 'true');
  for (const id of ['mode', 'sound-section', 'look-section']) await expect(page.locator(`#${id}`)).toHaveCount(1);
  // reCOM opens on foot, as a ?redotcom visit does, once the SEAL's clips are in.
  await expect.poll(() => page.evaluate(() => window.__viewer.mode()), { timeout: 60_000 }).toBe('walk');
  await expect(page.locator('#mode [data-mode="walk"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => localStorage.getItem('s2u.viewer.recom'))).toBe('1');
  await page.locator('#controls-toggle').click();
  await expect(page.locator('#keys-list')).toContainText('fly');                   // G: back to the fly camera
  await page.locator('#controls-toggle').click();

  await recom(page, 'off').click();
  await expect.poll(() => page.evaluate(() => window.__viewer.mode())).toBe('fly');
  for (const id of ['mode', 'sound-section', 'look-section', 'touch-walk']) await expect(page.locator(`#${id}`)).toHaveCount(0);
  expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(false);
  await page.keyboard.press('KeyG');
  expect(await page.evaluate(() => window.__viewer.mode())).toBe('fly');           // G is not bound in the map viewer
  expect(await page.evaluate(() => localStorage.getItem('s2u.viewer.recom'))).toBe('0');

  // The same Frostfire all along: no reload, no second load.
  expect(await page.evaluate(() => window.__viewer.stats().map)).toBe('FROSTFIRE');

  await recom(page, 'on').click();
  await page.reload();
  await expect(page.locator('#status')).toContainText(/triangles|tris/);
  await expect(recom(page, 'on')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#mode')).toHaveCount(1);
});

test('?redotcom forces reCOM on over a remembered map viewer, and switching it off takes it out of the address', async ({ page }) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('s2u.viewer.recom', '0'); sessionStorage.setItem('seeded', '1'); } });
  await open(page, '?redotcom&fly&devmode&map=MP2');
  await expect(recom(page, 'on')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#mode')).toHaveCount(1);
  expect(await page.evaluate(() => window.__viewer.mode())).toBe('fly');           // &fly: the free camera at the start
  await recom(page, 'off').click();
  await expect(page.locator('#mode')).toHaveCount(0);
  const url = new URL(page.url());
  expect(url.searchParams.has('redotcom')).toBe(false);
  expect(url.searchParams.has('devmode')).toBe(true);
  expect(url.search).toMatch(/[?&]fly(&|$)/);
});
