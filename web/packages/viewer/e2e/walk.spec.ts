import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
// `src/hook.ts` is types only; its `declare global` is what makes `window.__viewer` exist inside `page.evaluate`.
import type {} from '../src/hook';

/**
 * Walk mode on Frostfire (web sprint 1, W1.4 step 6): research 24 section 6.1's route from A's spawn to B's floor,
 * the mover driven through the debug hook, the floor checked at each leg's end, the door leaf between B's region
 * and the building met head on, and pictures on B's ramp and at the door. Web sprint 2 (W2.2b): the same route at
 * the game's speeds, `C` and the hook's stance, and a walk off the 142 deck that falls onto the 100 floor.
 *
 * The legs are driven with `walkFor`, which runs the mover's 60 Hz ticks at once rather than over frames: under
 * SwiftShader a frame can take longer than the page's 0.1 s cap on a frame's time, and a held key would then walk
 * a different distance on every host. The keys themselves are checked once, with a short hold of W.
 */

/** Screenshots are evidence, not fixtures: `web/test-fixtures/` is git-ignored. */
const SCREENS = fileURLToPath(new URL('../../../test-fixtures/screens/walk', import.meta.url));

/** Research 24 section 6.1: A's spawn to B's floor, the 20 waypoints, each with the floor its leg ends on. */
const ROUTE: [number, number, number][] = [
  [806, 100, 665], [806, 100, 712], [760, 100, 720], [745, 100, 720], [695, 100, 730], [690, 100, 780],
  [685, 100, 830], [718, 100, 872], [720, 100, 915], [720, 100, 960], [720, 100, 1005], [735, 100, 1055],
  [720, 100, 1100], [715, 100, 1155], [712, 100, 1190], [705, 100, 1223], [680, 102, 1223.5], [640, 122, 1223.5],
  [600, 142, 1223.5], [565, 142, 1235],
];
/** A's spawn (KNOWN section 1), the feet; the eye stands 15.4 over them (W1.R2). */
const SPAWN_A: [number, number, number] = [796, 100, 614];
const EYE = 15.4;

/** Two frames with the pose in them before the canvas is worth photographing. */
const settle = (page: Page): Promise<void> => page.evaluate(
  () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
);

/**
 * Steers the mover at (x, z) a tick at a time, facing it each tick and easing off as it nears, until the feet are
 * within 2 of it; the feet at the end, or null when 20 seconds of ticks did not get there.
 */
const steer = (page: Page, x: number, z: number): Promise<[number, number, number] | null> => page.evaluate(([tx, tz]) => {
  const v = window.__viewer;
  for (let i = 0; i < 1200; i++) {
    const f = v.feet();
    if (!f) return null;
    const d = Math.hypot(tx - f[0], tz - f[2]);
    if (d <= 2) return f;
    v.setCamera({ yaw: Math.atan2(-(tx - f[0]), -(tz - f[2])) * 180 / Math.PI, pitch: 0 });
    v.walkFor(1 / 60, { forward: Math.min(1, d / 10) });
  }
  return null;
}, [x, z] as const);

test('walks Frostfire from A\'s spawn to B\'s floor, and the door leaf stops it', async ({ page }) => {
  mkdirSync(SCREENS, { recursive: true });
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || (m.type() === 'warning' && /GL_INVALID|WebGPU.*(error|fail)/i.test(m.text()))) {
      problems.push(`console: ${m.text()}`);
    }
  });

  await page.goto('/');
  const status = page.locator('#status');
  await expect(status).toContainText('triangles');
  await page.locator('#maps').selectOption('RUN/MP2.ZDB');
  await expect(status).toContainText('FROSTFIRE (MP2)');
  await expect(status).toContainText('triangles');

  // G toggles the mode and the panel's switch mirrors it; the switch drives it too. The picker keeps the focus
  // after a pick, and the keys ignore a SELECT (as a player's would reach the page after a click on the canvas).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  expect(await page.evaluate(() => window.__viewer.mode())).toBe('fly');
  await page.keyboard.press('KeyG');
  expect(await page.evaluate(() => window.__viewer.mode())).toBe('walk');
  await expect(page.locator('#walk')).toBeChecked();
  await page.keyboard.press('KeyG');
  expect(await page.evaluate(() => window.__viewer.mode())).toBe('fly');
  await expect(page.locator('#walk')).not.toBeChecked();
  await page.locator('#walk').evaluate((el) => {
    const box = el as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(await page.evaluate(() => window.__viewer.mode())).toBe('walk');

  // At A's spawn: the feet on the floor at 100, the eye 15.4 over them.
  await page.evaluate(([x, y, z, eye]) => window.__viewer.setCamera({ x, y: y + eye, z, yaw: 0, pitch: 0 }), [...SPAWN_A, EYE] as const);
  const start = await page.evaluate(() => ({ feet: window.__viewer.feet(), pose: window.__viewer.pose() }));
  expect(start.feet).toEqual(SPAWN_A);
  expect(start.pose.y).toBeCloseTo(SPAWN_A[1] + EYE, 3);

  // The keys drive it: W held for a moment, facing waypoint 1, moves the feet toward it on the same floor.
  await page.evaluate(([x, z]) => window.__viewer.setCamera({ yaw: Math.atan2(-(x - 796), -(z - 614)) * 180 / Math.PI }), [806, 665] as const);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(600);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(600);                  // a full stick let go stops at once (FUN_00586c10's snap)
  const held = (await page.evaluate(() => window.__viewer.feet()))!;
  expect(Math.hypot(held[0] - SPAWN_A[0], held[2] - SPAWN_A[2])).toBeGreaterThan(2);
  expect(held[2]).toBeGreaterThan(SPAWN_A[2]);
  expect(held[1]).toBeCloseTo(100, 3);

  // The stance (W2.2b): C cycles it while walking, and the hook reads and sets it.
  expect(await page.evaluate(() => window.__viewer.stance())).toBe('stand');
  await page.keyboard.press('KeyC');
  expect(await page.evaluate(() => window.__viewer.stance())).toBe('crouch');
  expect(await page.evaluate(() => window.__viewer.setStance('stand'))).toBe(true);

  // The route, from the spawn again, at the game's 65 a second (the steer eases in over the last 10 units).
  await page.evaluate(([x, y, z, eye]) => window.__viewer.setCamera({ x, y: y + eye, z, yaw: 0, pitch: 0 }), [...SPAWN_A, EYE] as const);
  for (const [i, [x, y, z]] of ROUTE.entries()) {
    const feet = await steer(page, x, z);
    expect(feet, `leg ${i + 1} to (${x}, ${z})`).not.toBeNull();
    expect(Math.abs(feet![1] - y), `leg ${i + 1}: feet at ${feet![1]}, floor ${y}`).toBeLessThanOrEqual(1.5);
    test.info().annotations.push({ type: `leg ${i + 1}`, description: feet!.map((v) => v.toFixed(2)).join(', ') });
    if (i === 16) {
      // At the foot of B's ramp (research 24 section 6.1 waypoints 17-19, the centreline z 1223.5), looking up it.
      await page.evaluate(() => window.__viewer.setCamera({ yaw: 90, pitch: 0 }));
      await settle(page);
      await page.screenshot({ path: join(SCREENS, 'frostfire-walk-b-ramp.png') });
    }
  }

  // The door leaf `door_slab` (research 24 sections 0.3 and 7.2: x 576-589, z 1117-1118, y 142-165, closed): from
  // B's side, squarely in front of it, straight at it. It stops the feet a body's radius short of its face.
  expect(await steer(page, 582.5, 1140)).not.toBeNull();
  await page.evaluate(() => window.__viewer.setCamera({ yaw: 0, pitch: 0 }));
  const door = await page.evaluate(() => { window.__viewer.walkFor(3, { forward: 1 }); return window.__viewer.feet(); });
  expect(door![2]).toBeGreaterThan(1118);
  expect(door![2]).toBeLessThan(1118 + 3.5 + 1);
  expect(door![1]).toBeCloseTo(142, 3);
  expect(Math.abs(door![2] - 1117)).toBeLessThan(6);                 // "stops it at z ~ 1117" (the plan)
  await settle(page);
  await page.screenshot({ path: join(SCREENS, 'frostfire-walk-door.png') });

  // The fall (W2.2b): the 142 deck east of A's spawn (x 630-675, z 725-815) is open on its east side over the 100
  // floor. Walked off it facing +x, the feet fall 42 under gravity 235 and land on the floor.
  await page.evaluate(([eye]) => window.__viewer.setCamera({ x: 660, y: 142 + eye, z: 725, yaw: 270, pitch: 0 }), [EYE] as const);
  expect((await page.evaluate(() => window.__viewer.feet()))![1]).toBeCloseTo(142, 3);
  const fell = await page.evaluate(() => { window.__viewer.walkFor(1.5, { forward: 1 }); return window.__viewer.feet(); });
  expect(fell![0]).toBeGreaterThan(675);
  expect(fell![1]).toBeCloseTo(100, 3);

  // Back to flying leaves the camera where the eye was.
  const eye = await page.evaluate(() => window.__viewer.pose());
  expect(await page.evaluate(() => window.__viewer.setMode('fly'))).toBe(true);
  expect(await page.evaluate(() => window.__viewer.pose())).toEqual(eye);

  expect(problems).toEqual([]);
});
