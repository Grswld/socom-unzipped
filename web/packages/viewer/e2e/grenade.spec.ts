import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
// `src/hook.ts` is types only; its `declare global` is what makes `window.__viewer` exist inside `page.evaluate`.
import type {} from '../src/hook';

/**
 * The frag grenade on Frostfire (web/docs/research/85): from spawn A, walking, a full throw (the button held a
 * second) leaves the standing hand at `ComputeMaxVel`'s speed, arcs over the map's hull, bounces, lies still and goes
 * off 3 s after it left the hand; a light one is an underhand toss. The screenshots are the evidence: the arc (the
 * debug trail, seen from beside it) and the explosion.
 */

const SCREENS = fileURLToPath(new URL('../../../test-fixtures/screens/grenade', import.meta.url));
const SPAWN_A: [number, number, number] = [796, 100, 614];
const EYE = 15.4;
const REST_PITCH = -9.167;

const settle = (page: Page): Promise<void> => page.evaluate(
  () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
);

test('walk mode on Frostfire: a held throw arcs, bounces, rests and explodes at 3 s; a light one is a toss', async ({ page }) => {
  mkdirSync(SCREENS, { recursive: true });
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || (m.type() === 'warning' && /GL_INVALID|WebGPU.*(error|fail)/i.test(m.text()))) problems.push(`console: ${m.text()}`);
  });

  await page.goto('/');
  const status = page.locator('#status');
  await expect(status).toContainText('triangles');
  await page.locator('#maps').selectOption('RUN/MP2.ZDB');
  await expect(status).toContainText('FROSTFIRE (MP2)');
  await expect(status).toContainText('triangles');
  expect((await page.evaluate(() => window.__viewer.stats())).diagnostics).toEqual([]);
  const idle = await page.evaluate(() => window.__viewer.grenade());
  expect(idle.model).toBe(true);
  expect(idle.left).toBe(3);
  expect(idle.record).toMatchObject({ name: 'M67', fuse: 3, removal: 3.1, gravity: 98, explosionRadius: 150, explosionDamage: 10 });
  expect(idle.defaultMaterial).toBe('METAL_THICK');

  // Flying: nothing to throw from.
  expect(await page.evaluate(() => window.__viewer.throwGrenade(1))).toBeNull();

  // West-south-west of A the dock is open for a full throw's 600 units (the directions were scanned: most of the
  // others meet a container within 50).
  const stand = async (yaw: number, pitch: number): Promise<void> => {
    expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(true);
    await page.evaluate(([x, y, z, eye, yaw, pitch]) => window.__viewer.setCamera({ x, y: y + eye, z, yaw, pitch }), [...SPAWN_A, EYE, yaw, pitch] as const);
    await page.evaluate(() => window.__viewer.walkFor(0.3, { forward: 0 }));
  };
  const lookAt = async (eye: number[], at: number[]): Promise<void> => {
    expect(await page.evaluate(() => window.__viewer.setMode('fly'))).toBe(true);
    const yaw = (Math.atan2(-(at[0]! - eye[0]!), -(at[2]! - eye[2]!)) * 180) / Math.PI;
    const pitch = (Math.atan2(at[1]! - eye[1]!, Math.hypot(at[0]! - eye[0]!, at[2]! - eye[2]!)) * 180) / Math.PI;
    await page.evaluate(([x, y, z, yaw, pitch]) => window.__viewer.setCamera({ x, y, z, yaw, pitch }), [eye[0]!, eye[1]!, eye[2]!, yaw, pitch] as const);
    await settle(page);
  };
  await stand(240, 12);
  await page.waitForTimeout(1500);
  await settle(page);
  await page.keyboard.press('Backquote');                    // the panel away: the picture is the evidence

  expect(await page.evaluate(() => window.__viewer.equipGrenade(true))).toBe(true);
  await settle(page);
  await expect(page.locator('#ammo')).toHaveText('M67 x3');
  await page.locator('#view').screenshot({ path: join(SCREENS, 'frostfire-grenade-up.png') });
  await page.evaluate(() => window.__viewer.grenadeTrail(true));
  const thrown = await page.evaluate(() => window.__viewer.throwGrenade(1));
  expect(thrown).not.toBeNull();
  expect(thrown!.anim.clip).toBe('seal_throwgrenade');
  expect(thrown!.power).toBeCloseTo(1 - 0.95 ** 60, 6);
  expect(thrown!.launch.maxSpeed).toBeCloseTo(238.66, 1);
  expect(thrown!.launch.speed).toBeCloseTo(238.66, 1);
  const after = await page.evaluate(() => window.__viewer.grenade());
  expect(after.left).toBe(2);
  expect(after.live.length).toBe(1);

  // The arc from beside it, above the warehouse roofs: the debug trail drawn over the world.
  await page.waitForTimeout(2300);
  const from = thrown!.from, v = thrown!.velocity;
  const h = Math.hypot(v[0], v[2]), dx = v[0] / h, dz = v[2] / h;
  const mid = [from[0] + dx * 230, from[1] + 40, from[2] + dz * 230];
  await lookAt([mid[0]! - dz * 360, mid[1]! + 200, mid[2]! + dx * 360], mid);
  await page.locator('#view').screenshot({ path: join(SCREENS, 'frostfire-full-throw-arc.png') });
  await expect.poll(() => page.evaluate(() => window.__viewer.grenade().explosions.length), { timeout: 10_000 }).toBe(1);
  const first = await page.evaluate(() => window.__viewer.grenade());
  expect(first.bounces.length).toBeGreaterThan(0);
  expect(first.explosions[0]!.radius).toBe(150);
  expect(first.explosions[0]!.damageToPlayer).toBe(0);            // the camera is flying: no SEAL on the ground

  // South-west, at the rest pitch: it comes down short, rolls to rest in the warehouse and goes off there.
  await stand(210, REST_PITCH);
  const second = await page.evaluate(() => window.__viewer.throwGrenade(1));
  expect(second).not.toBeNull();
  await expect.poll(() => page.evaluate(() => window.__viewer.grenade().live.at(-1)?.state), { timeout: 5_000 }).toBe('rest');
  const lie = (await page.evaluate(() => window.__viewer.grenade())).live.at(-1)!.pos;
  const ex = lie[0] - second!.from[0], ez = lie[2] - second!.from[2], el = Math.hypot(ex, ez);
  await lookAt([lie[0] - (ex / el) * 70, lie[1] + 55, lie[2] - (ez / el) * 70], [lie[0], lie[1] + 10, lie[2]]);
  await expect.poll(() => page.evaluate(() => window.__viewer.grenade().explosions.length), { timeout: 10_000 }).toBe(2);
  await page.waitForTimeout(60);
  await settle(page);
  await page.locator('#view').screenshot({ path: join(SCREENS, 'frostfire-explosion.png') });
  const boom = await page.evaluate(() => window.__viewer.grenade());
  expect(boom.explosions[1]!.pos).toEqual(lie);
  expect(boom.explosions[1]!.material).toBe('METAL_THICK');         // Frostfire's DefaultMaterial, byte 0
  expect(boom.explosions[1]!.anim).toBe('frag_grenade_metal_thick');
  expect(boom.effects).toBeGreaterThan(20);
  await page.waitForTimeout(500);
  await settle(page);
  await page.locator('#view').screenshot({ path: join(SCREENS, 'frostfire-explosion-smoke.png') });

  // A light press aimed low: the underhand toss.
  await stand(210, -20);
  const toss = await page.evaluate(() => window.__viewer.throwGrenade(0.1));
  expect(toss!.anim.clip).toBe('seal_tossgrenade');
  expect(toss!.anim.toss).toBe(true);
  expect((await page.evaluate(() => window.__viewer.grenade())).left).toBe(0);
  expect(problems).toEqual([]);
});
