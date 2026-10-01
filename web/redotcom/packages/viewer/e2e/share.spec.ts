import { expect, test, type Page } from '@playwright/test';
import type {} from '../src/hook';

/**
 * Shareable links (owner, 2026-09-29; `../src/shareUrl.ts`): the Mode, the map and the picture live in the address
 * and follow every change (`history.replaceState`: no reload, no history entries), so opening the address the page shows
 * reproduces the setup. The address beats what the browser remembers; with a parameter absent the remembered choice
 * applies and is written in. The online match's `online`, `mp` and `server` leave it on load (the local demo, owner
 * 2026-10-01, as the deployed teaser).
 */
test.use({ storageState: { cookies: [], origins: [] } });

async function open(page: Page, query: string): Promise<void> {
  await page.addInitScript(() => { localStorage.setItem('s2u.viewer.panelOpen', '1'); });
  await page.goto(`/${query}`);
  await expect(page.locator('#status')).toContainText(/triangles|tris/);
}
const params = (page: Page): URLSearchParams => new URL(page.url()).searchParams;

test('changing Mode, map and view updates the address, without history entries', async ({ page }) => {
  await open(page, '?devmode&fly');
  // A first visit: the defaults are written in.
  await expect.poll(() => params(page).get('mode')).toBe('explore');
  await expect.poll(() => params(page).get('view')).toBe('modern');
  await expect.poll(() => params(page).get('map')).toBeTruthy();
  expect(params(page).has('online')).toBe(false);
  const entries = await page.evaluate(() => history.length);

  await page.locator('#recom [data-recom="on"]').click();
  await expect.poll(() => params(page).get('mode')).toBe('play');
  await page.locator('#look [data-look="ps2"]').click();
  await expect.poll(() => params(page).get('view')).toBe('ps2');
  await page.locator('#maps').selectOption('RUN/MP6.ZDB');
  await expect(page.locator('#status')).toContainText('triangles');
  await expect.poll(() => params(page).get('map')).toBe('MP6');
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
    localStorage.setItem('s2u.viewer.lastMap', 'MP2');
  });
  await open(page, '?mode=play&map=MP6&view=ps2&fly&devmode');
  await expect(page.locator('#recom [data-recom="on"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#look [data-look="ps2"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#status')).toContainText('MP6');
  expect(await page.evaluate(() => window.__viewer.toggles().ps2look)).toBe(true);
  await context.close();
});

test('an unknown value falls back silently, and the old ?redotcom and rules= leave the address with no effect', async ({ page }) => {
  await open(page, '?redotcom&rules=respawn&view=crt&fly&devmode');
  await expect(page.locator('#recom [data-recom="off"]')).toHaveAttribute('aria-pressed', 'true');   // redotcom no longer means Play
  await expect.poll(() => params(page).get('mode')).toBe('explore');
  expect(params(page).has('redotcom')).toBe(false);
  expect(params(page).has('rules')).toBe(false);
  await expect.poll(() => params(page).get('view')).toBe('modern');
});

test('the online match\'s online=, &server= and &mp leave the address on load, and nothing joins a server', async ({ page }) => {
  const asked: string[] = [];
  // Any match server's address, read off the request's host and path -- not its query, where this page's own address
  // names one on purpose (the dev server's HMR socket, at `/` with a `?token=`, is Vite's and not counted).
  const match = /mp\.socomunzipped|:8787\b|\/rooms\b|\/ws\b/;
  const where = (u: string): string => { const x = new URL(u); return `${x.host}${x.pathname}`; };
  page.on('request', (r) => { if (match.test(where(r.url()))) asked.push(r.url()); });
  page.on('websocket', (ws) => { if (match.test(where(ws.url()))) asked.push(ws.url()); });
  await open(page, '?mode=explore&online=shared&server=ws://127.0.0.1:9/ws&mp&devmode');
  await expect.poll(() => params(page).has('server')).toBe(false);
  expect(params(page).has('online')).toBe(false);
  expect(params(page).has('mp')).toBe(false);
  expect(params(page).has('devmode')).toBe(true);                      // the developer's parameters stay
  await expect(page.locator('#online')).toHaveCount(0);
  expect(asked).toEqual([]);
});
