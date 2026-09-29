import { expect, test } from '@playwright/test';
// `src/hook.ts` is types only; its `declare global` is what makes `window.__viewer` exist inside `page.evaluate`.
import type {} from '../src/hook';

/**
 * The walk's sound on Frostfire (web/docs/research/81): the map's own banks come in by range, a click unlocks the
 * output, and each event plays the sound the game names for it -- the rifle's round and reload, the jump's whoosh,
 * the landing and the footfalls on the rig's metal. Audio cannot be heard here, so the hook's stats are the evidence:
 * what was rendered and started, by name.
 */
test('the walk sounds: the M4A1 SD, the reload, the jump, the landing, the steps', async ({ page }) => {
  await page.goto('/?map=MP2&redotcom');
  await page.waitForFunction(() => window.__viewer?.stats().map === 'FROSTFIRE' && window.__viewer.audio().banks.length === 3);
  const loaded = await page.evaluate(() => window.__viewer.audio());
  expect(loaded.banks.map((b) => b.name)).toEqual(['MP2_AM', 'MP2_FX', 'MP2_VC']);
  expect(loaded.missing).toEqual([]);
  expect(loaded.unlocked).toBe(false);

  await page.mouse.click(640, 400);                                   // the gesture that unlocks the output
  await expect.poll(() => page.evaluate(() => window.__viewer.audio().unlocked)).toBe(true);
  expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(true);

  await page.evaluate(() => window.__viewer.shoot());
  await expect.poll(() => page.evaluate(() => window.__viewer.audio().byName['.M4A1_SIL'] ?? 0)).toBeGreaterThan(0);
  await page.keyboard.press('KeyR');
  await expect.poll(() => page.evaluate(() => window.__viewer.audio().byName['.M4A1_SIL_RLD'] ?? 0)).toBe(1);

  // A running jump (research 80: from 15 units a second the feet leave the floor; the standing jump's never do, so it
  // lands nothing): the launch's whoosh, then the landing.
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => window.__viewer.jump())).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__viewer.audio().byName['.JUMP_WHOOSH'] ?? 0)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__viewer.audio().events.land)).toBe(1);

  await expect.poll(() => page.evaluate(() => window.__viewer.audio().events.footstep), { timeout: 30_000 }).toBeGreaterThan(1);
  await page.keyboard.up('KeyW');

  const s = await page.evaluate(() => window.__viewer.setAudio({ muted: true }));
  expect(s.muted).toBe(true);
  expect(s.dropped.unknown).toBe(0);
  expect(s.played).toBeGreaterThan(4);
  // The rig's deck is metal (the SOILS table's METAL_THICK): its step, and its landing.
  expect(Object.keys(s.byName).some((n) => n.startsWith('.STEP_'))).toBe(true);
  expect(Object.keys(s.byName).some((n) => n.endsWith('_JUMP'))).toBe(true);
});
