import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
// `src/hook.ts` is types only; its `declare global` is what makes `window.__viewer` exist inside `page.evaluate`.
import type {} from '../src/hook';

/**
 * The gunplay's effects on Frostfire (web/redotcom/docs/research/89): in walk mode at spawn A facing west, rounds from the M4A1 SD
 * play its `muzzle_m4SD` -- the casing thrown to the rifle's right and bouncing on the rig's metal deck -- and, where
 * each round meets the hull, the surface's `bullet_hit_<material>` from the map's `MZANIM` and the surface's mark from
 * `decals.rdr`. The screenshots are the evidence: a casing in the air, the sparks and the metal mark on the container.
 */

const SCREENS = fileURLToPath(new URL('../../../test-fixtures/screens/effects', import.meta.url));
const SPAWN_A: [number, number, number] = [796, 100, 614];
const EYE = 15.4;
const REST_PITCH = -9.167;

const settle = (page: Page): Promise<void> => page.evaluate(
  () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
);

test('Frostfire: the M4A1 SD throws its casings and marks the container by its material', async ({ page }) => {
  mkdirSync(SCREENS, { recursive: true });
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });

  await page.goto('/?map=MP2&redotcom&fly&devmode');
  const status = page.locator('#status');
  await expect(status).toContainText('FROSTFIRE (MP2)');
  await expect(status).toContainText('triangles');
  await expect.poll(() => page.evaluate(() => window.__viewer.effects().loaded), { timeout: 60_000 }).toBe(true);
  const loaded = await page.evaluate(() => window.__viewer.effects());
  expect(loaded.missing).toEqual([]);
  await page.keyboard.press('Shift');                                  // the gesture that unlocks the sound
  await expect.poll(() => page.evaluate(() => window.__viewer.audio().unlocked)).toBe(true);
  expect(loaded.models).toContain('bullet_shell_9m');

  expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(true);
  await page.evaluate(([x, y, z, eye, pitch]) => window.__viewer.setCamera({ x, y: y + eye, z, yaw: 90, pitch }),
    [...SPAWN_A, EYE, REST_PITCH] as const);
  await page.evaluate(() => window.__viewer.walkFor(0.5, { forward: 0 }));
  await page.waitForTimeout(1500);
  await settle(page);

  // One round: the muzzle animation, the casing in the air, the impact on the container.
  const shot = await page.evaluate(() => window.__viewer.shoot());
  expect(shot?.hit).not.toBeNull();
  await page.waitForTimeout(120);
  const flying = await page.evaluate(() => window.__viewer.effects());
  expect(flying.played['muzzle_m4SD']).toBe(1);
  expect(flying.played['shell_eject']).toBe(1);
  expect(flying.shells).toBe(1);
  await page.locator('#view').screenshot({ path: join(SCREENS, 'frostfire-casing-in-the-air.png') });
  const hitAnim = Object.keys(flying.played).find((k) => k.startsWith('bullet_hit_'));
  expect(hitAnim).toBeDefined();

  // A burst: the casings bounce on the deck (the metal's sound) and are gone once at rest or at 1.2 s.
  await page.evaluate(() => window.__viewer.trigger(true));
  await page.waitForTimeout(600);
  await page.locator('#view').screenshot({ path: join(SCREENS, 'frostfire-burst.png') });
  await page.evaluate(() => window.__viewer.trigger(false));
  await page.waitForTimeout(1600);
  const after = await page.evaluate(() => window.__viewer.effects());
  expect(after.shells).toBe(0);
  expect(after.bounces).toBeGreaterThan(0);
  // The casings land on the deck (METAL_THICK) with the bank's `.BUL_CAS_METAL` (the data's `.BUL_CASE_METAL`).
  expect(after.sounds).toContain('.BUL_CAS_METAL');
  expect((await page.evaluate(() => window.__viewer.audio())).byName['.BUL_CAS_METAL'] ?? 0).toBeGreaterThan(0);
  // The container's marks, a few degrees off the reticle.
  await page.evaluate((pitch) => window.__viewer.setCamera({ yaw: 88, pitch }), REST_PITCH);
  await settle(page);
  await page.locator('#view').screenshot({ path: join(SCREENS, 'frostfire-marks.png') });
  expect(problems).toEqual([]);
});

/** Desert Glory at spawn A: a stone wall 20 units off at yaw 40 and the sand under it -- the concrete's mark and dust. */
test('Desert Glory: stone and sand take their own marks and impacts; the M4A1 flash plays on demand', async ({ page }) => {
  mkdirSync(SCREENS, { recursive: true });
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  await page.goto('/?map=MP6&redotcom&fly&devmode');
  await expect(page.locator('#status')).toContainText('triangles');
  await expect.poll(() => page.evaluate(() => window.__viewer.effects().loaded), { timeout: 60_000 }).toBe(true);
  expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(true);
  await page.evaluate(() => window.__viewer.walkFor(0.4, { forward: 0 }));
  await page.waitForTimeout(1500);

  const shootAt = async (yaw: number, pitch: number): Promise<number | undefined> => {
    await page.evaluate(([y, p]) => window.__viewer.setCamera({ yaw: y, pitch: p }), [yaw, pitch]);
    await settle(page);
    await page.evaluate(() => window.__viewer.shoot());
    return (await page.evaluate(() => window.__viewer.fire())).lastHit?.material;
  };
  // Materials by the SOILS index (research 81 §4): 7 STONE, 5 SAND.
  expect(await shootAt(40, -5)).toBe(7);
  await page.waitForTimeout(90);
  await page.locator('#view').screenshot({ path: join(SCREENS, 'desert-glory-stone-impact.png') });
  for (let i = 0; i < 4; i++) { await page.waitForTimeout(160); await shootAt(40 + i, -5 - i); }
  await page.waitForTimeout(1200);                     // the kick settles
  expect(await shootAt(220, -45)).toBe(5);
  await page.waitForTimeout(90);
  await page.locator('#view').screenshot({ path: join(SCREENS, 'desert-glory-sand-impact.png') });
  await page.waitForTimeout(1500);
  const played = (await page.evaluate(() => window.__viewer.effects())).played;
  expect(played['bullet_hit_stone']).toBeGreaterThanOrEqual(5);
  expect(played['bullet_hit_sand']).toBe(1);
  await page.evaluate(() => window.__viewer.setCamera({ yaw: 38, pitch: -6 }));
  await settle(page);
  await page.locator('#view').screenshot({ path: join(SCREENS, 'desert-glory-stone-marks.png') });

  // The M4A1's flash (`muzzle_m4` calls `flash_fire_hider`), played ahead of the camera as a muzzle effect.
  // The flash lives three or four frames, so the effects are held for the picture: played inside a frame (after its
  // update) and held right after the next frame's update, so it has run exactly one frame's step. Two slow frames under
  // SwiftShader (each clamped to 0.1 s) outlast it.
  await page.evaluate(() => window.__viewer.setCamera({ yaw: 38, pitch: 10 }));
  await settle(page);
  expect(await page.evaluate(() => new Promise<boolean>((done) => requestAnimationFrame(() => {
    const played = window.__viewer.playEffect('muzzle_m4', undefined, 'muzzle');
    requestAnimationFrame(() => { window.__viewer.pauseEffects(true); done(played); });
  })))).toBe(true);
  expect((await page.evaluate(() => window.__viewer.effects())).shown).toContain('muzzle_flash_hider');
  await page.locator('#view').screenshot({ path: join(SCREENS, 'desert-glory-m4a1-flash.png') });
  await page.evaluate(() => window.__viewer.pauseEffects(false));
  expect((await page.evaluate(() => window.__viewer.effects())).played['flash_fire_hider']).toBe(1);
  expect(problems).toEqual([]);
});

/** The frag's flash (`light_flash_large`: the game's light pass over the ground), held for its picture on Frostfire. */
test('Frostfire: the frag grenade explosion lights the deck around it', async ({ page }) => {
  mkdirSync(SCREENS, { recursive: true });
  await page.goto('/?map=MP2&redotcom&fly&devmode');
  await expect(page.locator('#status')).toContainText('triangles');
  await expect.poll(() => page.evaluate(() => window.__viewer.effects().loaded), { timeout: 60_000 }).toBe(true);
  expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(true);
  await page.evaluate(([x, y, z, eye, pitch]) => window.__viewer.setCamera({ x, y: y + eye, z, yaw: 90, pitch }), [...SPAWN_A, EYE, REST_PITCH] as const);
  await page.evaluate(() => window.__viewer.walkFor(0.5, { forward: 0 }));
  await page.waitForTimeout(2500);
  await settle(page);
  await page.locator('#view').screenshot({ path: join(SCREENS, 'frostfire-frag-before.png') });
  expect(await page.evaluate(() => window.__viewer.playEffect('frag_grenade_metal_thick', [790, 101, 614]))).toBe(true);
  // The metal's own puff, 0.05 s, then frag_grenade's parts: held once the light is up.
  await expect.poll(() => page.evaluate(() => {
    const on = window.__viewer.effects().lights.live > 0;
    if (on) window.__viewer.pauseEffects(true);
    return on;
  }), { timeout: 3_000, intervals: [10] }).toBe(true);
  const lit = (await page.evaluate(() => window.__viewer.effects())).lights;
  expect(lit.live).toBe(1);
  expect(lit.overlays).toBeGreaterThan(0);
  expect(lit.ranges[0]![1]).toBeGreaterThan(100);                    // 190 shrinking to nothing by 0.5 s
  await page.locator('#view').screenshot({ path: join(SCREENS, 'frostfire-frag-flash.png') });
  await page.evaluate(() => window.__viewer.pauseEffects(false));
  await page.waitForTimeout(1500);
  expect((await page.evaluate(() => window.__viewer.effects())).lights.live).toBe(0);
});

/** Enowapi's river (MP62, water at y -14): wading ripples, a fall into it splashes; Desert Glory's sand takes footprints. */
test('water and footprints: the splash and the ripples on Enowapi, the prints on Desert Glory sand', async ({ page }) => {
  mkdirSync(SCREENS, { recursive: true });
  await page.goto('/?map=MP62&redotcom&fly&devmode');
  await expect(page.locator('#status')).toContainText('triangles');
  await expect.poll(() => page.evaluate(() => window.__viewer.effects().loaded), { timeout: 60_000 }).toBe(true);
  expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(true);
  // Standing in the shallows (1.6 over the feet): the big ripple.
  await page.evaluate(() => window.__viewer.setCamera({ x: 1791, y: 40, z: 804, yaw: 0, pitch: -20 }));
  await expect.poll(() => page.evaluate(() => window.__viewer.effects().water.ripples)).toMatch(/big_ripple_anim/);
  await page.waitForTimeout(500);
  // A fall into the water is the traversal's `waterLand` on `s2u:traversal` (its detection is the traversal's, tested
  // there): sent here as it sends it, standing where the SEAL stands in the river.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('s2u:traversal', { detail: { type: 'waterLand', depth: 1.6 } })));
  expect((await page.evaluate(() => window.__viewer.effects())).water.splashes).toBe(1);
  // At the feet it is under the body from the game's camera; the same splash 25 ahead on the river is the picture.
  expect(await page.evaluate(() => window.__viewer.playEffect('seal_fall_in_water', [1791, -14, 779]))).toBe(true);
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__viewer.pauseEffects(true));
  await page.locator('#view').screenshot({ path: join(SCREENS, 'enowapi-splash.png') });
  await page.evaluate(() => window.__viewer.pauseEffects(false));
  expect((await page.evaluate(() => window.__viewer.effects())).played['seal_fall_in_water']).toBe(2);

  await page.goto('/?map=MP6&redotcom&fly&devmode');
  await expect(page.locator('#status')).toContainText('DESERT GLORY');
  await expect.poll(() => page.evaluate(() => window.__viewer.effects().loaded), { timeout: 60_000 }).toBe(true);
  expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(true);
  await page.evaluate(() => window.__viewer.walkFor(0.4, { forward: 0 }));
  await page.evaluate(() => window.__viewer.setCamera({ yaw: 200, pitch: -10 }));
  // The footfalls come off the run clip's phase, so the walk is the keyboard's, frame by frame.
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2500);
  await page.keyboard.up('KeyW');
  await page.evaluate(() => window.__viewer.setCamera({ yaw: 20, pitch: -40 }));
  await page.waitForTimeout(500);
  expect((await page.evaluate(() => window.__viewer.effects())).water.footprints).toBeGreaterThan(2);
  await page.locator('#view').screenshot({ path: join(SCREENS, 'desert-glory-footprints.png') });
});

/**
 * The smoke grenade's screen (`smoke_grenade` -> `smoke_stream`: two sources on the canister, a puff each every 0.4 s
 * growing tenfold over 5-7 s, 20 s of it) on Desert Glory, from outside and from inside; and a mission's ambient
 * effects, started with the map (Frostfire's tower flames).
 */
test('the smoke screen reads as a screen; the mission ambient effects burn', async ({ page }) => {
  test.setTimeout(170_000);
  mkdirSync(SCREENS, { recursive: true });
  await page.goto('/?map=MP6&redotcom&fly&devmode');
  await expect(page.locator('#status')).toContainText('triangles');
  await expect.poll(() => page.evaluate(() => window.__viewer.effects().loaded), { timeout: 60_000 }).toBe(true);
  expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(true);
  await page.evaluate(() => window.__viewer.walkFor(0.4, { forward: 0 }));
  await page.evaluate(() => window.__viewer.setCamera({ yaw: 200, pitch: -5 }));
  await page.waitForTimeout(1000);
  const feet = (await page.evaluate(() => window.__viewer.feet()))!;
  const r = (200 * Math.PI) / 180;
  const at: [number, number, number] = [feet[0] - Math.sin(r) * 60, feet[1] + 1, feet[2] - Math.cos(r) * 60];
  expect(await page.evaluate((p) => window.__viewer.playEffect('smoke_grenade', p), at)).toBe(true);
  await page.waitForTimeout(6000);
  expect((await page.evaluate(() => window.__viewer.effects())).particles).toBeGreaterThan(25);
  await page.locator('#view').screenshot({ path: join(SCREENS, 'desert-glory-smoke-screen.png') });
  await page.evaluate(() => window.__viewer.walkFor(1.4, { forward: 1 }));   // into it
  await page.waitForTimeout(300);
  await page.locator('#view').screenshot({ path: join(SCREENS, 'desert-glory-smoke-inside.png') });

  await page.goto('/?map=MP2&redotcom&fly&devmode');
  await expect(page.locator('#status')).toContainText('triangles');
  await expect.poll(() => page.evaluate(() => window.__viewer.effects().loaded), { timeout: 60_000 }).toBe(true);
  await page.evaluate(() => window.__viewer.setCamera({ x: 1055, y: 250, z: 1530, yaw: 0, pitch: -6 }));
  await page.waitForTimeout(2500);
  const fx = await page.evaluate(() => window.__viewer.effects());
  expect(fx.ambient).toContain('firey_flames');
  expect(fx.particles).toBeGreaterThan(20);
  await page.locator('#view').screenshot({ path: join(SCREENS, 'frostfire-tower-flames.png') });
});

/**
 * The marks' colour (web/redotcom/docs/research/89 §5): the game modulates a mark's texel by the wall's own vertex colour
 * (`FUN_003beca0` puts the clipped world vertices' colour words in the mark's packet), so a mark is as dark as the wall
 * under it is lit. Frostfire's container (METAL_THICK) at spawn A and Desert Glory's stone wall: each round's mark takes
 * the drawn wall's colour -- 0x41 on the container, 0x10 on the stone in the wall's shade -- not unity (the old mark,
 * two to eight times lighter). The pictures: `marks-after-*.png`; the old look beside them is `marks-before-*.png`
 * and `marks-pair-*.png` (made once against the tree before the fix).
 */
test('the marks take the colour of the wall they are on: metal and stone', async ({ page }) => {
  mkdirSync(SCREENS, { recursive: true });
  const cases = [
    { map: 'MP2', slug: 'frostfire-metal', yaw: 100, pitch: -3, material: 25, shade: [0.508, 0.508, 0.523] },
    { map: 'MP6', slug: 'desert-glory-stone', yaw: 40, pitch: -5, material: 7, shade: [0.126, 0.123, 0.11] },
  ];
  for (const c of cases) {
    await page.goto(`/?map=${c.map}&redotcom&fly&devmode`);
    await expect(page.locator('#status')).toContainText('triangles');
    await expect.poll(() => page.evaluate(() => window.__viewer.effects().loaded), { timeout: 60_000 }).toBe(true);
    expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(true);
    await page.evaluate(() => window.__viewer.walkFor(0.4, { forward: 0 }));
    // The props stream in over the frames after the status line (`main.ts`'s reveal): a round before the container is
    // drawn finds no drawn wall under its mark. Rounds until one does.
    await page.evaluate(([y, p]) => window.__viewer.setCamera({ yaw: y, pitch: p }), [c.yaw, c.pitch]);
    await expect.poll(async () => {
      await page.evaluate(() => window.__viewer.shoot());
      await page.waitForTimeout(250);
      return (await page.evaluate(() => window.__viewer.fire())).lastShade !== null;
    }, { timeout: 90_000 }).toBe(true);
    let first: { point: number[]; normal: number[] } | null = null;
    for (let i = 0; i < 4; i++) {
      await page.evaluate(([y, p]) => window.__viewer.setCamera({ yaw: y, pitch: p }), [c.yaw + i * 2.5 - 3.75, c.pitch]);
      await settle(page);
      await expect.poll(() => page.evaluate(() => window.__viewer.shoot() !== null)).toBe(true);
      const f = await page.evaluate(() => window.__viewer.fire());
      expect(f.lastHit?.material).toBe(c.material);
      expect(f.lastShade).not.toBeNull();
      f.lastShade!.slice(0, 3).forEach((v, k) => expect(v).toBeCloseTo(c.shade[k]!, 2));
      expect(f.lastShade![3]).toBeCloseTo(1, 6);
      first ??= f.lastHit;
    }
    // The picture: the free camera 22 units off the first mark, square to the wall.
    await page.evaluate(() => window.__viewer.clearEffects());
    expect(await page.evaluate(() => window.__viewer.setMode('fly'))).toBe(true);
    const [px, py, pz] = first!.point, [nx, ny, nz] = first!.normal;
    await page.evaluate(([x, y, z, yaw, pitch]) => window.__viewer.setCamera({ x, y, z, yaw, pitch }),
      [px! + nx! * 22, py! + ny! * 22, pz! + nz! * 22, (Math.atan2(nx!, nz!) * 180) / Math.PI, (-Math.asin(ny!) * 180) / Math.PI] as const);
    await page.waitForTimeout(500);
    await settle(page);
    await page.locator('#view').screenshot({ path: join(SCREENS, `marks-after-${c.slug}.png`) });
  }
});
