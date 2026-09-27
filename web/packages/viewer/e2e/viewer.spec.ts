import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
// The shape `src/main.ts` puts on `window`, taken from the one declaration of it rather than copied.
// `src/hook.ts` is types only, and its `declare global` is what makes `window.__viewer` exist inside
// `page.evaluate`; the import is type-only, so nothing of the page's runtime is pulled into the test.
import type {} from '../src/hook';

/** Screenshots are evidence, not fixtures: `web/test-fixtures/` is git-ignored. */
const SCREENS = fileURLToPath(new URL('../../../test-fixtures/screens', import.meta.url));

/**
 * The three extracted fixtures, by the name `mission.rdr` shows (36 section 0). Frostfire is the map the
 * viewer opens on; the other two are picked from the list the way a player picks them.
 *
 * Desert Glory and Crossroads each cite a few textures their own `_TXR.ZED` does not contain, so their
 * diagnostics are *recorded* rather than asserted to be empty. Frostfire's must stay empty: it is the map
 * every earlier task was built on.
 */
const MAPS = [
  { name: 'FROSTFIRE', archive: 'MP2', screenshot: 'frostfire-spawnA.png', top: 'frostfire-top.png', clean: true },
  { name: 'DESERT GLORY', archive: 'MP6', screenshot: 'desert-glory-spawnA.png', top: 'desert-glory-top.png', clean: false },
  { name: 'CROSSROADS', archive: 'MP72', screenshot: 'crossroads-spawnA.png', top: 'crossroads-top.png', clean: false },
] as const;

/** Eye height above a spawn's feet, as `main.ts` stands the camera up. */
const EYE = 20;
/**
 * How high the top-down shot stands over the spawns. 800 units is 80 m: high enough to hold both spawns
 * in frame on all three maps, low enough to stay under Frostfire's sky chunk at y = 1442.7.
 */
const OVERHEAD = 800;

/**
 * The panel's controls live in sections that are collapsed by default, and the lighting and fog ones
 * are nested inside the options section, so every `details` is opened before anything is clicked.
 */
const openPanel = (page: Page): Promise<void> => page.evaluate(() => {
  // Not `#about`: it is prose, and opening it makes the panel taller than the viewport, which puts
  // the controls underneath out of reach of a click.
  for (const el of document.querySelectorAll('#panel details:not(#about)')) (el as HTMLDetailsElement).open = true;
});

/**
 * Sets a checkbox the way the page reads it -- the property and a `change` event -- rather than by a
 * click. The panel is taller than a 720px viewport once every section is open, and a control below
 * the fold cannot be clicked; what the test is about is the picture that follows, not the click.
 */
const setToggle = (page: Page, id: string, on: boolean): Promise<void> =>
  page.locator(`#${id}`).evaluate((el, checked) => {
    const box = el as HTMLInputElement;
    if (box.checked === checked) return;
    box.checked = checked;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  }, on);

/** Two frames with the new world in them before the canvas is worth photographing. */
const settle = (page: Page): Promise<void> => page.evaluate(
  () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
);

test('all three extracted maps render from the served archives', async ({ page }) => {
  mkdirSync(SCREENS, { recursive: true });
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  // A GL error reaches the console as a *warning*, not an error, and one per draw: the wireframe
  // blank-out of 2026-09-26 was 250 `GL_INVALID_ENUM: glDrawElements` warnings and no error at all.
  page.on('console', (m) => {
    if (m.type() === 'error' || (m.type() === 'warning' && /GL_INVALID|WebGPU.*(error|fail)/i.test(m.text()))) {
      problems.push(`console: ${m.text()}`);
    }
  });

  await page.goto('/');
  const maps = page.locator('#maps');
  const status = page.locator('#status');
  await expect(status).toContainText('triangles');

  for (const map of MAPS) {
    const label = `${map.name} (${map.archive})`;
    await expect(maps.locator('option', { hasText: map.name })).toHaveCount(1);
    await maps.selectOption(`RUN/${map.archive}.ZDB`); // by value: the option label now carries the game type too
    await expect(status).toContainText(label);
    await expect(status).toContainText('triangles');

    const stats = await page.evaluate(() => window.__viewer.stats());
    expect(stats.map).toBe(map.name);
    expect(stats.triangles).toBeGreaterThan(2000);
    expect(stats.collisionPolys).toBeGreaterThan(1000);
    // The spawn table is the reason the camera knows where to stand; every fixture has one.
    expect(stats.spawns).not.toBeNull();

    console.log(`${map.name}: backend ${stats.backend}, ${stats.triangles} triangles, ` +
      `${stats.collisionPolys} collision polys, ${stats.untexturedDraws} untextured draws, ` +
      `${stats.loadMs} ms load, ${stats.diagnostics.length} diagnostics`);
    for (const line of stats.diagnostics.slice(0, 5)) console.log(`  ${map.name} diagnostic: ${line}`);
    test.info().annotations.push({ type: `${map.name} triangles`, description: String(stats.triangles) });
    test.info().annotations.push({ type: `${map.name} diagnostics`, description: String(stats.diagnostics.length) });
    // Section 9 of the spec carries the counts and the first five lines of each; only Frostfire, which
    // every earlier task was built on, has to be clean.
    if (map.clean) expect(stats.diagnostics).toEqual([]);

    // `main.ts` stands the camera at spawn A and faces it at B whenever the map has measured spawns.
    const pose = await page.evaluate(() => window.__viewer.pose());
    const [ax, ay, az] = stats.spawns!.a;
    expect([pose.x, pose.y, pose.z]).toEqual([ax, ay + EYE, az]);

    await settle(page);
    await page.screenshot({ path: join(SCREENS, map.screenshot) });

    // And the same map from above the two spawns: the view that would show a map collapsed on the
    // origin, or props floating off their ground, which a view from inside it can hide.
    await page.evaluate((high) => {
      const spawns = window.__viewer.stats().spawns!;
      window.__viewer.setCamera({
        x: (spawns.a[0] + spawns.b[0]) / 2, y: Math.max(spawns.a[1], spawns.b[1]) + high,
        z: (spawns.a[2] + spawns.b[2]) / 2, yaw: 0, pitch: -90,
      });
    }, OVERHEAD);
    // The overhead shot stands further off than any map's fog far plane -- Frostfire's is 640 and
    // this is 800 up -- so with fog on it photographs the fog colour and nothing else. The point of
    // the shot is the placement underneath it, so fog comes off for it and goes back on after.
    await openPanel(page);
    await setToggle(page, 'fog', false);
    await settle(page);
    await page.screenshot({ path: join(SCREENS, map.top) });
    await setToggle(page, 'fog', true);
  }

  // The line strips and the shadows are on by default -- Desert Glory's power lines and Crossroads'
  // guy ropes are in the two shots above -- and the alternate states and the experimental order are off.
  expect(await page.evaluate(() => window.__viewer.toggles())).toMatchObject({
    linestrips: true, shadows: true, alternate: false, discorder: false,
  });

  // The wireframe, on and off again, from the spawn. It used to blank the frame on the second draw --
  // the check on `problems` at the end is what catches that, the screenshot is what shows it drew.
  await page.evaluate(() => {
    const spawns = window.__viewer.stats().spawns!;
    window.__viewer.setCamera({ x: spawns.a[0], y: spawns.a[1] + 20, z: spawns.a[2], yaw: 0, pitch: 0 });
  });
  await setToggle(page, 'wireframe', true);
  await settle(page);
  await settle(page);
  await page.screenshot({ path: join(SCREENS, 'crossroads-wireframe.png') });
  await setToggle(page, 'wireframe', false);
  await settle(page);

  // Back to Frostfire with the two map-derived overlays on: the collision hull over the deck it guards,
  // and the two spawn markers. The same camera as `frostfire-top.png`, so the pair is a before and after.
  await maps.selectOption('RUN/MP2.ZDB');
  await expect(status).toContainText('FROSTFIRE (MP2)');
  await openPanel(page);
  await setToggle(page, 'collision', true);
  await setToggle(page, 'spawns', true);
  expect(await page.evaluate(() => window.__viewer.toggles())).toMatchObject({ collision: true, spawns: true });
  await page.evaluate((high) => {
    const spawns = window.__viewer.stats().spawns!;
    window.__viewer.setCamera({
      x: (spawns.a[0] + spawns.b[0]) / 2, y: Math.max(spawns.a[1], spawns.b[1]) + high,
      z: (spawns.a[2] + spawns.b[2]) / 2, yaw: 0, pitch: -90,
    });
  }, OVERHEAD);
  await settle(page);
  await page.screenshot({ path: join(SCREENS, 'frostfire-overlays.png') });

  expect(problems).toEqual([]);
});
