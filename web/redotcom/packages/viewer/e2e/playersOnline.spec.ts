import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type {} from '../src/hook';

/**
 * PLAYERS ONLINE (owner, 2026-09-29; `../src/playersOnline.ts`): the panel's kicker is the players in the server's
 * matches, and the map picker says each map's after its name. The run turns the shared server's list off
 * (`playwright.config.ts` `VITE_S2U_ROOMS=off`: it is not live yet), so this spec sets Online to Local and answers the
 * local server's `/rooms` itself (`page.route`): no server is started. `e2e/online.spec.ts` reads a real one.
 */

const WEB = fileURLToPath(new URL('../../..', import.meta.url));
const HAVE = existsSync(join(WEB, 'test-fixtures', 'RUN', 'MP2.ZDB')) || existsSync(join(WEB, 'public', 'maps', 'RUN', 'MP2.ZDB'));
const ROOMS = 'http://localhost:8787/rooms';

test.skip(!HAVE, 'maps absent: run npm run extract-maps');

test('the kicker counts the players (not the watchers), the picker says each map\'s, and Off turns them back to a dash', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let asked = 0;
  await page.route(ROOMS, (route) => {
    asked++;
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=10', etag: '"e2e"' },
      body: JSON.stringify([
        { map: 'MP2', rules: 'classic', players: 3, spectators: 4, round: 2 },
        { map: 'MP6', rules: 'classic', players: 0, spectators: 1, round: 1 },
      ]),
    });
  });
  // The page's own socket to Local finds nobody and retries: that is the Online line's business, not this spec's.
  await page.addInitScript(() => { localStorage.setItem('s2u.viewer.panelOpen', '1'); localStorage.setItem('s2u.viewer.online', 'local'); });
  await page.goto('/?devmode&fly&map=MP2');
  await expect(page.locator('#status')).toContainText(/triangles|tris/);

  await expect(page.locator('#players-online')).toHaveText('3');
  await expect(page.locator('#panel-kicker')).toHaveText(/^Players online\s*3$/i);
  await expect(page.locator('#maps option[value="RUN/MP2.ZDB"]')).toContainText('· 3 playing');
  await expect(page.locator('#maps option[value="RUN/MP6.ZDB"]')).not.toContainText('playing');
  // The count is in the option's accessible name.
  await expect(page.getByRole('option', { name: /FROSTFIRE.*3 playing/i })).toHaveCount(1);
  expect(await page.evaluate(() => window.__viewer.playersOnline!())).toEqual({ total: 3, byMap: { MP2: 3 } });

  // One request per period: about 20 s, so no more than two in the first 21 s.
  await page.waitForTimeout(21_000);
  expect(asked).toBeGreaterThanOrEqual(1);
  expect(asked).toBeLessThanOrEqual(2);

  // Off reads the shared list, which this run has turned off: not known, so the dash (never 0) and no counts on the maps.
  await page.locator('#online [data-online="off"]').click();
  await expect(page.locator('#players-online')).toHaveText('–');
  await expect(page.locator('#maps option[value="RUN/MP2.ZDB"]')).not.toContainText('playing');
  expect(errors).toEqual([]);
});

test('a server that does not answer shows the dash, never 0, and no page error', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(ROOMS, (route) => route.abort('connectionrefused'));
  await page.addInitScript(() => { localStorage.setItem('s2u.viewer.panelOpen', '1'); localStorage.setItem('s2u.viewer.online', 'local'); });
  await page.goto('/?devmode&fly&map=MP2');
  await expect(page.locator('#status')).toContainText(/triangles|tris/);
  await page.waitForTimeout(2000);
  await expect(page.locator('#players-online')).toHaveText('–');
  expect(await page.evaluate(() => window.__viewer.playersOnline!())).toBeNull();
  expect(errors).toEqual([]);
});
