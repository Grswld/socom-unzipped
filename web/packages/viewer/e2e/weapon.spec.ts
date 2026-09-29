import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
// `src/hook.ts` is types only; its `declare global` is what makes `window.__viewer` exist inside `page.evaluate`.
import type {} from '../src/hook';

/**
 * The WEAPON workstream on Frostfire: the M4A1 SD in the SEAL's right hand at the low ready, raised to the shoulder
 * while the trigger is held (the Fire set, `seal_fp_stand`), a round from the muzzle, the aim kicked up and let back,
 * a reload playing its clip, and no satchel on the back (the game hides it until the bomb is picked up).
 */

const SCREENS = fileURLToPath(new URL('../../../test-fixtures/screens/weapon', import.meta.url));
const SPAWN_A: [number, number, number] = [796, 100, 614];
const EYE = 15.4;
const REST_PITCH = -9.167;

const settle = (page: Page): Promise<void> => page.evaluate(
  () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
);

test('the rifle in the hands, raised to fire, from the muzzle, kicked, reloaded; no satchel', async ({ page }) => {
  mkdirSync(SCREENS, { recursive: true });
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });

  await page.goto('/?redotcom&fly');
  const status = page.locator('#status');
  await expect(status).toContainText('triangles');
  await page.locator('#maps').selectOption('RUN/MP2.ZDB');
  await expect(status).toContainText('FROSTFIRE (MP2)');
  await expect(status).toContainText('triangles');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(true);
  await page.evaluate(([x, y, z, eye, pitch]) => window.__viewer.setCamera({ x, y: y + eye, z, yaw: 90, pitch }), [...SPAWN_A, EYE, REST_PITCH] as const);
  await expect.poll(async () => (await page.evaluate(() => window.__viewer.stats())).anim?.clip ?? null).toBe('seal_stand');
  await page.waitForTimeout(1500);                             // the props stream in
  await settle(page);

  // In hand, down; the satchel built and hidden.
  const low = await page.evaluate(() => window.__viewer.weapon());
  expect(low).toMatchObject({ held: true, raise: { state: 'down', weight: 0 }, pose: { fire: null } });
  expect(low.muzzle).not.toBeNull();
  const body = (await page.evaluate(() => window.__viewer.stats())).body!;
  expect(body.fittingNames).toContain('Satchel');
  expect(body.hiddenGear).toEqual(['Satchel']);
  await page.screenshot({ path: join(SCREENS, 'frostfire-a-low-ready.png') });

  // The trigger held: raised in 0.1 s, the Fire version at full weight, rounds from the muzzle, the aim kicked up.
  const pitch0 = (await page.evaluate(() => window.__viewer.camera()))!.pitch;
  await page.evaluate(() => window.__viewer.trigger(true));
  await page.waitForTimeout(300);
  const up = await page.evaluate(() => window.__viewer.weapon());
  expect(up).toMatchObject({ raise: { state: 'up', weight: 1 }, pose: { fire: 'seal_fp_stand', fireWeight: 1 } });
  // At the shoulder, over the low ready -- by less than a unit since the raise weight also turns the aim's twist on
  // (FUN_0057a330 439192, motion round 4): the spawn's -9.2 degree pitch dips the raised rifle's muzzle by about 0.3.
  expect(up.muzzle![1]).toBeGreaterThan(low.muzzle![1] + 0.5);
  await page.screenshot({ path: join(SCREENS, 'frostfire-a-fire-pose.png') });
  await page.evaluate(() => window.__viewer.trigger(false));
  const fired = await page.evaluate(() => window.__viewer.fire());
  expect(fired.shots).toBeGreaterThan(0);
  // Out of the scope the view does not kick: the recoil is the reticle's knock (research 84, FUN_005c5340).
  expect((await page.evaluate(() => window.__viewer.camera()))!.pitch).toBeCloseTo(pitch0, 3);

  // Still up after the release (the controller's 5 s), and the reload plays its clip.
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(400);
  const reloading = await page.evaluate(() => window.__viewer.weapon());
  expect(reloading).toMatchObject({ raise: { state: 'up' }, pose: { reload: 'seal_reload' } });
  expect((await page.evaluate(() => window.__viewer.fire())).magazine.reloading).toBe(true);
  await page.screenshot({ path: join(SCREENS, 'frostfire-a-reload.png') });

  // WEAPON round 2: L2's sidearm. The swap's clip, the pistol to the hand at its hand-off, the rifle slung on the back;
  // the Mark 23's record, reticle set 0 and icon; its rounds from its own muzzle.
  await expect.poll(async () => (await page.evaluate(() => window.__viewer.fire())).magazine.reloading, { timeout: 5000 }).toBe(false);
  expect(await page.evaluate(() => window.__viewer.selectWeapon('pistol'))).toBe(true);
  await expect.poll(async () => (await page.evaluate(() => window.__viewer.kit())).swap).toBeNull();
  const drawn = await page.evaluate(() => window.__viewer.weapon());
  expect(drawn).toMatchObject({ item: 'pistol', mounts: { rifle: 'carry', pistol: 'hand' } });
  expect(drawn.muzzle).not.toBeNull();
  expect((await page.evaluate(() => window.__viewer.fire())).magazine).toMatchObject({ rounds: 12, capacity: 12, spare: 2 });
  expect((await page.evaluate(() => window.__viewer.reticle())).type).toBe(0);
  const shot = await page.evaluate(() => window.__viewer.shoot());
  expect(shot).not.toBeNull();
  expect(Math.hypot(shot!.from[0] - drawn.muzzle![0], shot!.from[1] - drawn.muzzle![1], shot!.from[2] - drawn.muzzle![2])).toBeLessThan(2);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SCREENS, 'frostfire-a-mark23.png') });
  // L1: back to the rifle, the pistol holstered on the thigh.
  expect(await page.evaluate(() => window.__viewer.selectWeapon('rifle'))).toBe(true);
  await expect.poll(async () => (await page.evaluate(() => window.__viewer.kit())).swap).toBeNull();
  expect(await page.evaluate(() => window.__viewer.weapon())).toMatchObject({ item: 'rifle', mounts: { rifle: 'hand', pistol: 'holster' } });
  expect((await page.evaluate(() => window.__viewer.fire())).magazine.capacity).toBe(30);
  expect(problems).toEqual([]);
});

/** The frame's luma at points (x, y) of the drawing buffer, read in the frame it was drawn. */
const lumaAt = (page: Page, points: [number, number][]): Promise<{ width: number; height: number; luma: number[] }> => page.evaluate(
  (pts) => new Promise((done) => requestAnimationFrame(async () => {
    const canvas = document.querySelector('#view') as HTMLCanvasElement;
    const img = new Image();
    img.src = canvas.toDataURL('image/png');
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height);
    const luma = pts.map(([fx, fy]) => {
      const x = Math.round(fx * (img.width - 1)), y = Math.round(fy * (img.height - 1)), i = (y * img.width + x) * 4;
      return (d.data[i]! + d.data[i + 1]! + d.data[i + 2]!) / 3;
    });
    done({ width: img.width, height: img.height, luma });
  })), points);

test('the owner\'s rulings of 2026-09-29: keys 1-4, no scope on the Mark 23, the scope\'s black to the frame\'s sides', async ({ page }) => {
  mkdirSync(SCREENS, { recursive: true });
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  await page.setViewportSize({ width: 1280, height: 720 });     // the modern presentation at 16:9
  await page.goto('/?map=MP2&redotcom&fly');
  const status = page.locator('#status');
  await expect(status).toContainText('FROSTFIRE (MP2)');
  await expect(status).toContainText('triangles');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(true);
  await page.evaluate(([x, y, z, eye, pitch]) => window.__viewer.setCamera({ x, y: y + eye, z, yaw: 90, pitch }), [...SPAWN_A, EYE, REST_PITCH] as const);
  await expect.poll(async () => (await page.evaluate(() => window.__viewer.stats())).anim?.clip ?? null).toBe('seal_stand');
  await page.waitForTimeout(1500);

  // The rifle's scope on a 16:9 frame: its black reaches the frame's left and right edges (the bars were culled).
  expect(await page.evaluate(() => window.__viewer.zoomIn())).toBe(5);
  await expect.poll(async () => (await page.evaluate(() => window.__viewer.zoom())).magnification).toBe(3);
  expect((await page.evaluate(() => window.__viewer.reticle())).mode).toBe('scope');
  const edges: [number, number][] = [[0.002, 0.2], [0.002, 0.5], [0.002, 0.8], [0.998, 0.2], [0.998, 0.5], [0.998, 0.8], [0.1, 0.5], [0.9, 0.5]];
  const wide = await lumaAt(page, [...edges, [0.5, 0.35]]);
  expect(wide.width / wide.height).toBeGreaterThan(1.7);
  for (const [i, l] of wide.luma.slice(0, edges.length).entries()) expect(l, `edge ${edges[i]}`).toBeLessThan(4);
  expect(wide.luma[edges.length]!).toBeGreaterThan(20);           // the world inside the tube
  await page.screenshot({ path: join(SCREENS, 'frostfire-a-scope-16x9.png') });
  expect(await page.evaluate(() => window.__viewer.zoomOut())).toBe(0);

  // 2: the Mark 23 (L2's swap), and no scope on it: the zoom does nothing, the sidearm's reticle.
  await page.keyboard.press('Digit2');
  expect((await page.evaluate(() => window.__viewer.kit())).swap).not.toBeNull();
  await expect.poll(async () => (await page.evaluate(() => window.__viewer.kit())).swap).toBeNull();
  expect(await page.evaluate(() => window.__viewer.weapon())).toMatchObject({ item: 'pistol', mounts: { rifle: 'carry', pistol: 'hand' } });
  expect(await page.evaluate(() => window.__viewer.zoomIn())).toBe(0);
  expect(await page.evaluate(() => window.__viewer.zoomIn())).toBe(0);
  await page.waitForTimeout(300);
  const pistolView = await page.evaluate(() => ({ z: window.__viewer.zoom(), r: window.__viewer.reticle() }));
  expect(pistolView.z).toMatchObject({ state: 0, view: 'third', magnification: 1 });
  expect(pistolView.r).toMatchObject({ mode: 'reticle', type: 0 });   // the sidearm's set, not the scope or the binoculars

  // 3 and 4: the kit's equipment slots 1 and 2 (the M67, the HE); 1 the rifle back.
  await page.keyboard.press('Digit3');
  expect(await page.evaluate(() => window.__viewer.grenade())).toMatchObject({ equipped: true, item: 'M67' });
  await page.keyboard.press('Digit4');
  expect(await page.evaluate(() => window.__viewer.grenade())).toMatchObject({ equipped: true, item: 'HE' });
  for (const code of ['Digit5', 'Digit6', 'Digit9']) await page.keyboard.press(code);   // no per-type keys any more
  expect(await page.evaluate(() => window.__viewer.grenade())).toMatchObject({ equipped: true, item: 'HE' });
  await page.keyboard.press('Digit1');
  expect((await page.evaluate(() => window.__viewer.grenade())).equipped).toBe(false);
  await expect.poll(async () => (await page.evaluate(() => window.__viewer.kit())).swap).toBeNull();
  expect(await page.evaluate(() => window.__viewer.weapon())).toMatchObject({ item: 'rifle', mounts: { rifle: 'hand', pistol: 'holster' } });
  expect(problems).toEqual([]);
});
