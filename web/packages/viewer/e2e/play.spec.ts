import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
// `src/hook.ts` is types only; its `declare global` is what makes `window.__viewer` exist inside `page.evaluate`.
import type {} from '../src/hook';

/**
 * The play mode on Frostfire (web sprint 2, W2.2b and W2.6; ruling W2.R1): walk entered at A's spawn shows the SEAL at
 * the feet in the stand clip, seen over its shoulder; W held walks it in a locomotion clip; the jump puts it in the
 * air in a jump clip; aiming draws the frame from its eyes with the body hidden; fly mode hides it. Pictures from the
 * shoulder and from the eyes.
 *
 * Needs the owner's `RUN/MOTION_P.ZAR` and `RUN/READERC.ZAR` beside the maps: without the pack the body stands in its
 * bind pose and `stats().anim` stays null.
 */

/** Screenshots are evidence, not fixtures: `web/test-fixtures/` is git-ignored. */
const SCREENS = fileURLToPath(new URL('../../../test-fixtures/screens/play', import.meta.url));

/** A's spawn on Frostfire (KNOWN section 1), the feet, and the eye 15.4 over them (W1.R2), as `walk.spec.ts` has them. */
const SPAWN_A: [number, number, number] = [796, 100, 614];
const EYE = 15.4;
/** Facing research 24 section 6.1's first waypoint, (806, 665), from A: the floor at 100 runs all the way. */
const YAW_TO_1 = Math.atan2(-(806 - 796), -(665 - 614)) * 180 / Math.PI;
const LOCOMOTION = ['seal_walk', 'seal_jog', 'seal_run'];
const TAKE_OFF = ['seal_jump', 'seal_runningjump_launch'];

/** Two frames with the pose in them before the canvas is worth photographing. */
const settle = (page: Page): Promise<void> => page.evaluate(
  () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
);
const stats = (page: Page) => page.evaluate(() => window.__viewer.stats());

test('the play mode: the SEAL at A in the game\'s clips, over its shoulder, jumping and aiming (W2.2b, W2.6)', async ({ page }) => {
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
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // Fly mode: the body is not shown (the panel's switch is off), the fly camera draws.
  expect((await stats(page)).body?.visible).toBe(false);
  expect((await stats(page)).camera.kind).toBe('fly');

  // Walk at A: the body at the feet, in the stand clip once the clips are in, the shoulder camera drawing.
  expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(true);
  await page.evaluate(([x, y, z, eye, yaw]) => window.__viewer.setCamera({ x, y: y + eye, z, yaw, pitch: 0 }), [...SPAWN_A, EYE, YAW_TO_1] as const);
  expect(await page.evaluate(() => window.__viewer.feet())).toEqual(SPAWN_A);
  await expect.poll(async () => (await stats(page)).anim?.clip ?? null).toBe('seal_stand');
  const standing = await stats(page);
  expect(standing.body?.visible).toBe(true);
  expect(standing.body?.at).toEqual(SPAWN_A);
  expect(standing.camera.kind).toBe('third');
  // the hook's pose stays the look and the walk's eye (walk.spec.ts reads it there)
  expect((await page.evaluate(() => window.__viewer.pose())).y).toBeCloseTo(SPAWN_A[1] + EYE, 3);
  // over the shoulder: behind the feet along the look, above them, within the measured rig's reach (25 up, 23.1 back)
  const cam = standing.camera.pose;
  const fx = -Math.sin(YAW_TO_1 * Math.PI / 180), fz = -Math.cos(YAW_TO_1 * Math.PI / 180);
  const back = -((cam.x - SPAWN_A[0]) * fx + (cam.z - SPAWN_A[2]) * fz);
  expect(back).toBeGreaterThan(0);
  expect(back).toBeLessThan(26);
  expect(cam.y - SPAWN_A[1]).toBeGreaterThan(5);
  expect(cam.y - SPAWN_A[1]).toBeLessThan(28);
  await settle(page);
  await page.screenshot({ path: join(SCREENS, 'frostfire-play-shoulder-a.png') });

  // W held for a second: a locomotion clip while held, and the feet moved along the floor at 100.
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1000);
  const walking = await stats(page);
  await page.keyboard.up('KeyW');
  expect(LOCOMOTION).toContain(walking.anim?.clip);
  await page.waitForTimeout(600);                  // the glide runs out
  const moved = (await page.evaluate(() => window.__viewer.feet()))!;
  expect(Math.hypot(moved[0] - SPAWN_A[0], moved[2] - SPAWN_A[2])).toBeGreaterThan(2);
  expect(moved[1]).toBeCloseTo(100, 3);

  // The jump: in the air, in a take-off clip, two frames on (at most 0.2 s of game time: the page caps a frame's time).
  const jumped = await page.evaluate(() => {
    const v = window.__viewer;
    const ok = v.jump();
    return new Promise<{ ok: boolean; airborne: boolean | undefined; clip: string | undefined }>((done) => requestAnimationFrame(() => requestAnimationFrame(() => {
      done({ ok, airborne: v.mover()?.airborne, clip: v.stats().anim?.clip });
    })));
  });
  expect(jumped.ok).toBe(true);
  expect(jumped.airborne).toBe(true);
  expect(TAKE_OFF).toContain(jumped.clip);
  await expect.poll(async () => (await page.evaluate(() => window.__viewer.mover()))?.airborne).toBe(false);

  // The picture from the shoulder, standing again.
  await page.waitForTimeout(1500);
  await settle(page);
  await page.screenshot({ path: join(SCREENS, 'frostfire-play-shoulder.png') });

  // Aiming: from the eyes, the body hidden; then back over the shoulder.
  expect(await page.evaluate(() => window.__viewer.setAim(true))).toBe('aim');
  await settle(page);
  const aiming = await stats(page);
  expect(aiming.camera.kind).toBe('aim');
  expect(aiming.body?.visible).toBe(false);
  const feet = (await page.evaluate(() => window.__viewer.feet()))!;
  expect(aiming.camera.pose.y - feet[1]).toBeGreaterThan(15);         // the eyes, 18.16 over the feet standing (78 §6.3)
  expect(aiming.camera.pose.y - feet[1]).toBeLessThan(20);
  await page.screenshot({ path: join(SCREENS, 'frostfire-play-aim.png') });
  expect(await page.evaluate(() => window.__viewer.setAim(null))).toBe('third');

  // Fly mode again: the body hidden, the fly camera drawing, left where the eye was.
  const eye = await page.evaluate(() => window.__viewer.pose());
  expect(await page.evaluate(() => window.__viewer.setMode('fly'))).toBe(true);
  await settle(page);
  const flying = await stats(page);
  expect(flying.camera.kind).toBe('fly');
  expect(flying.body?.visible).toBe(false);
  expect(await page.evaluate(() => window.__viewer.pose())).toEqual(eye);

  expect(problems).toEqual([]);
});
