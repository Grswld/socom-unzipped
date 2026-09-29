import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import type {} from '../src/hook';

/**
 * The traversal on Frostfire (web research 86): the sniper ladder at (547.5, 854.4) from the 100 floor to the 160
 * deck, the 11.9 crate at x 922.8-940.6, z 761-778.1 with the climb icon and the X key, and the peek on E, driven
 * through the debug hook with `walkFor` (frame-rate proof) and photographed mid-ladder, mid-climb and peeking.
 */

const SCREENS = fileURLToPath(new URL('../../../test-fixtures/screens/traversal', import.meta.url));

const settle = (page: Page, frames = 4): Promise<void> => page.evaluate((n) => new Promise<void>((done) => {
  let left = n;
  const next = (): void => { if (--left <= 0) done(); else requestAnimationFrame(next); };
  requestAnimationFrame(next);
}), frames);

test('the ladder, the climb and the peek on Frostfire (web research 86)', async ({ page }) => {
  mkdirSync(SCREENS, { recursive: true });
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  await page.goto('/?map=MP2&redotcom');
  const status = page.locator('#status');
  await expect(status).toContainText('FROSTFIRE (MP2)');
  await expect(status).toContainText('triangles');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(true);

  // The ladder: five on the map; walked into from +z facing it, mounted, climbed, off onto the deck.
  await page.evaluate(() => window.__viewer.setCamera({ x: 547.5, y: 115.4, z: 869, yaw: 0, pitch: -5 }));
  expect(await page.evaluate(() => window.__viewer.traversal()?.ladders)).toBe(5);
  const mounted = await page.evaluate(() => {
    const v = window.__viewer;
    for (let i = 0; i < 90; i++) { v.walkFor(1 / 60, { forward: 1 }); if (v.traversal()?.kind !== 'none') return v.traversal()?.kind; }
    return null;
  });
  expect(mounted).toBe('ladderMount');
  await page.evaluate(() => window.__viewer.walkFor(3, { forward: 1 }));
  const onLadder = await page.evaluate(() => ({ t: window.__viewer.traversal(), feet: window.__viewer.feet(), anim: window.__viewer.stats().anim }));
  expect(onLadder.t?.kind).toBe('ladder');
  expect(onLadder.anim?.clip).toBe('seal_climbladder');
  expect(onLadder.feet![1]).toBeGreaterThan(110);
  expect(onLadder.t?.events.filter((e) => e.type === 'ladderRung').length).toBeGreaterThan(3);
  await settle(page);
  expect((await page.evaluate(() => window.__viewer.hud())).model.action).toBe('ladder_slide');
  await page.screenshot({ path: join(SCREENS, 'e2e-ladder-mid.png') });
  await page.evaluate(() => window.__viewer.walkFor(5, { forward: 1 }));
  await page.evaluate(() => window.__viewer.walkFor(1, { forward: 0 }));
  const top = await page.evaluate(() => ({ t: window.__viewer.traversal(), feet: window.__viewer.feet() }));
  expect(top.t?.kind).toBe('none');
  expect(top.feet![1]).toBeCloseTo(160, 3);

  // The crate: the icon once its side is touched, X climbs it.
  await page.evaluate(() => window.__viewer.setCamera({ x: 938, y: 115.4, z: 795, yaw: 0, pitch: -5 }));
  await page.evaluate(() => window.__viewer.walkFor(0.6, { forward: 1 }));
  expect(await page.evaluate(() => window.__viewer.traversal()?.prompt)).toEqual({ visible: true, kind: 'low', automatic: false });
  await settle(page);
  expect((await page.evaluate(() => window.__viewer.hud())).model.action).toBe('climb');   // the HUD's action_climb.tif
  await page.keyboard.press('KeyX');
  await settle(page, 2);
  await page.evaluate(() => window.__viewer.walkFor(0.45, { forward: 0 }));
  expect(await page.evaluate(() => window.__viewer.traversal()?.clip)).toBe('seal_climbcrate');
  await page.evaluate(() => window.__viewer.setCamera({ pitch: -45 }));
  await settle(page);
  await page.screenshot({ path: join(SCREENS, 'e2e-climb-mid.png') });
  await page.evaluate(() => window.__viewer.walkFor(2, { forward: 0 }));
  expect((await page.evaluate(() => window.__viewer.feet()))![1]).toBeCloseTo(111.85, 2);
  // The walk's own jump still works after a climb: the standing jump (research 80) on the crate's top.
  expect(await page.evaluate(() => window.__viewer.jump())).toBe(true);
  expect(await page.evaluate(() => window.__viewer.traversal()?.kind)).toBe('none');

  // The peek: E held on the open floor at spawn A; the camera's target shifts 2.8 to the right.
  await page.evaluate(() => window.__viewer.setCamera({ x: 796, y: 115.4, z: 614, yaw: 180, pitch: -5 }));
  await page.keyboard.down('KeyE');
  await settle(page, 3);
  await page.evaluate(() => window.__viewer.walkFor(1, { forward: 0 }));
  const peek = await page.evaluate(() => ({ t: window.__viewer.traversal(), anim: window.__viewer.stats().anim }));
  expect(peek.t?.peek).toBeGreaterThan(0.99);
  expect(peek.anim?.clip).toBe('seal_stand2rlean');
  await settle(page);
  await page.screenshot({ path: join(SCREENS, 'e2e-peek-right.png') });
  await page.keyboard.up('KeyE');
  await settle(page, 3);
  await page.evaluate(() => window.__viewer.walkFor(1, { forward: 0 }));
  expect(await page.evaluate(() => window.__viewer.traversal()?.peek)).toBeLessThan(0.01);
  expect(problems).toEqual([]);
});
