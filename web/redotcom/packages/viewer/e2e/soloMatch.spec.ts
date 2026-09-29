import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type {} from '../src/hook';

/**
 * The single-player match (`../src/net/loopback`; research 91 section 20, 85 section 12): offline, reCOM mode joins the
 * match server's own room run in the page -- no `&fly`, no `&nomatch` -- as the host's SEAL, stood at a slot, the round
 * on; a grenade tossed at the feet hurts (or kills) the player, as the owner asked on 2026-09-29.
 */

const FIXTURES = join(fileURLToPath(new URL('../../..', import.meta.url)), 'test-fixtures');
const HAVE = existsSync(join(FIXTURES, 'RUN', 'MP2.ZDB'));

test('offline: the page plays its own match, and a grenade at the feet hurts the player', async ({ page }) => {
  test.skip(!HAVE, 'needs the fixtures (npm run extract-maps)');
  test.setTimeout(120_000);
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  await page.goto('/?map=MP2&redotcom&devmode');
  await expect(page.locator('#status')).toContainText('FROSTFIRE (MP2)', { timeout: 60_000 });
  await expect.poll(async () => page.evaluate(() => window.__viewer.net?.()?.state ?? null), { timeout: 30_000 }).toBe('open');
  const net = await page.evaluate(() => window.__viewer.net!()!);
  expect(net.role).toBe('player');
  expect(net.team).toBe('seal');
  await expect.poll(async () => page.evaluate(() => window.__viewer.feet()), { timeout: 30_000 }).not.toBeNull();
  expect((await page.evaluate(() => window.__viewer.hud())).model.health).toBe(1);

  // A short toss: it lands at the SEAL's feet, and the room's blast reaches the thrower (FUN_005ac070 asks no thrower).
  await page.evaluate(() => window.__viewer.throwGrenade(0, true));
  await expect.poll(async () => (await page.evaluate(() => window.__viewer.hud())).model.health, { timeout: 8_000 }).toBeLessThan(1);
  expect(problems).toEqual([]);
});
