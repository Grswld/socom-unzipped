import { expect, test, type Page } from '@playwright/test';
import type {} from '../src/hook';

/**
 * Shareable links (owner, 2026-09-29; `../src/shareUrl.ts`): the Mode, the map, the picture and Online live in the address
 * and follow every change (`history.replaceState`: no reload, no history entries), so opening the address the page shows
 * reproduces the setup. The address beats what the browser remembers; with a parameter absent the remembered choice
 * applies and is written in.
 */
test.use({ storageState: { cookies: [], origins: [] } });

async function open(page: Page, query: string): Promise<void> {
  await page.addInitScript(() => { localStorage.setItem('s2u.viewer.panelOpen', '1'); });
  await page.goto(`/${query}`);
  await expect(page.locator('#status')).toContainText(/triangles|tris/);
}
const params = (page: Page): URLSearchParams => new URL(page.url()).searchParams;

test('changing Mode, map, view and Online updates the address, without history entries', async ({ page }) => {
  await open(page, '?devmode&fly');
  // A first visit: the defaults are written in.
  await expect.poll(() => params(page).get('mode')).toBe('explore');
  await expect.poll(() => params(page).get('view')).toBe('modern');
  await expect.poll(() => params(page).get('online')).toBe('off');
  await expect.poll(() => params(page).get('map')).toBeTruthy();
  const entries = await page.evaluate(() => history.length);

  await page.locator('#recom [data-recom="on"]').click();
  await expect.poll(() => params(page).get('mode')).toBe('play');
  await page.locator('#look [data-look="ps2"]').click();
  await expect.poll(() => params(page).get('view')).toBe('ps2');
  await page.locator('#maps').selectOption('RUN/MP6.ZDB');
  await expect(page.locator('#status')).toContainText('triangles');
  await expect.poll(() => params(page).get('map')).toBe('MP6');
  await page.locator('#online [data-online="local"]').click();
  await expect.poll(() => params(page).get('online')).toBe('local');
  expect(await page.evaluate(() => history.length)).toBe(entries);             // replaced, never pushed
  // The developer's parameters are kept as they were.
  expect(page.url()).toMatch(/[?&]fly(&|$)/);
  expect(params(page).has('devmode')).toBe(true);
});

test('opening that address reproduces the state, over what this browser remembers', async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  // The friend's browser remembers the opposite of everything.
  await page.addInitScript(() => {
    localStorage.setItem('s2u.viewer.recom', '0');
    localStorage.setItem('s2u.viewer.look', 'modern');
    localStorage.setItem('s2u.viewer.online', 'local');
    localStorage.setItem('s2u.viewer.lastMap', 'MP2');
  });
  await open(page, '?mode=play&map=MP6&view=ps2&online=off&fly&devmode');
  await expect(page.locator('#recom [data-recom="on"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#look [data-look="ps2"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#online [data-online="off"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#status')).toContainText('MP6');
  expect(await page.evaluate(() => window.__viewer.toggles().ps2look)).toBe(true);
  await context.close();
});

test('an unknown value falls back silently, and the old ?redotcom and rules= leave the address with no effect', async ({ page }) => {
  await open(page, '?redotcom&rules=respawn&view=crt&online=everywhere&fly&devmode');
  await expect(page.locator('#recom [data-recom="off"]')).toHaveAttribute('aria-pressed', 'true');   // redotcom no longer means Play
  await expect.poll(() => params(page).get('mode')).toBe('explore');
  expect(params(page).has('redotcom')).toBe(false);
  expect(params(page).has('rules')).toBe(false);
  await expect.poll(() => params(page).get('view')).toBe('modern');
  await expect.poll(() => params(page).get('online')).toBe('off');
});

test('&server= beats online= and is kept, never added', async ({ page }) => {
  await open(page, '?mode=explore&online=off&devmode');
  expect(params(page).has('server')).toBe(false);
  expect(params(page).has('mp')).toBe(false);
});

test('an Online choice takes &server= and &mp out of the address, so a reload joins the choice (PL-12)', async ({ page }) => {
  await open(page, '?mode=explore&online=shared&server=ws://127.0.0.1:9/ws&mp&devmode');
  expect(params(page).get('server')).toBe('ws://127.0.0.1:9/ws');       // on load the named server is kept
  await page.locator('#online button[data-online="off"]').click();
  await expect.poll(() => params(page).get('online')).toBe('off');
  expect(params(page).has('server')).toBe(false);
  expect(params(page).has('mp')).toBe(false);
  expect(params(page).has('devmode')).toBe(true);                      // the other developer parameters stay
  await page.reload();
  await expect(page.locator('#status')).toContainText(/triangles|tris/);
  await expect(page.locator('#online button[data-online="off"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#online-text')).toContainText('single player: no server');
});
