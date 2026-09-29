import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
// The debug hook's shape, types only (see `viewer.spec.ts`).
import type {} from '../src/hook';
// The same ISO9660 writer the archive package's tests use: pure TypeScript, no DOM, no dependencies.
import { buildIso } from '../../archive/test/isoImage';

/**
 * W1.7, milestone M5: the player's own disc image, opened from the panel's file input, lists its maps and
 * draws one exactly as the served tree does.
 *
 * No disc image exists in the repository, so the test makes one: Frostfire's extracted archive alone,
 * packed as `RUN/MP2.ZDB` into an ISO9660 image. That image is game bytes, so it is written under the
 * git-ignored `test-fixtures/`, as the screenshots are, and the test is skipped where the fixture is absent.
 */
const FIXTURES = fileURLToPath(new URL('../../../test-fixtures', import.meta.url));
const MP2 = join(FIXTURES, 'RUN', 'MP2.ZDB');
const ISO = join(FIXTURES, 'iso', 'frostfire-only.iso');
/** Frostfire's triangles as the served source draws them (the e2e's own count, W1 plan). */
const FROSTFIRE_TRIANGLES = 16931;

test.skip(!existsSync(MP2), 'fixtures absent: run npm run extract-maps');

test.beforeAll(() => {
  mkdirSync(dirname(ISO), { recursive: true });
  writeFileSync(ISO, buildIso([{ path: 'RUN/MP2.ZDB', bytes: new Uint8Array(readFileSync(MP2)) }], 'SCUS_97275'));
});

/**
 * The problems `viewer.spec.ts` fails on, collected the same way: page errors, console errors, and the GL
 * or WebGPU warnings a broken draw leaves. `expected` lets one test excuse a message it provoked.
 */
function watch(page: Page, expected: (m: ConsoleMessage) => boolean = () => false): string[] {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (expected(m)) return;
    if (m.type() === 'error' || (m.type() === 'warning' && /GL_INVALID|WebGPU.*(error|fail)/i.test(m.text()))) {
      problems.push(`console: ${m.text()}`);
    }
  });
  return problems;
}

test('a disc image opened from the file input lists its maps and draws Frostfire as the served tree does', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/?devmode');                         // the served tree: the developer's switch (`../src/source.ts`)
  const maps = page.locator('#maps');
  const status = page.locator('#status');

  // The served tree is the default while it exists: Frostfire from `maps/`, the count to match.
  await expect(status).toContainText('FROSTFIRE (MP2)');
  await expect(status).toContainText('triangles');
  const served = await page.evaluate(() => window.__viewer.stats());
  expect(served.source).toBe('http');
  expect(served.triangles).toBe(FROSTFIRE_TRIANGLES);
  expect(await maps.locator('option').count()).toBeGreaterThan(1);

  // Something that is not a disc is refused with the reader's own words, and the served map stays up.
  await page.locator('#disc-file').setInputFiles({
    name: 'not-a-disc.iso', mimeType: 'application/octet-stream', buffer: Buffer.alloc(40 * 2048),
  });
  await expect(status).toContainText('not an ISO9660 image');
  expect(await page.evaluate(() => window.__viewer.stats().source)).toBe('http');

  await page.locator('#disc-file').setInputFiles(ISO);
  // The picker is the disc's now: one archive on it, named from its own mission.rdr.
  await expect(maps.locator('option')).toHaveCount(1);
  await expect(maps.locator('option', { hasText: 'FROSTFIRE' })).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => window.__viewer.stats().source)).toBe('iso');
  await expect(status).toContainText('FROSTFIRE (MP2)');
  await expect(status).toContainText('triangles');

  const stats = await page.evaluate(() => window.__viewer.stats());
  console.log(`FROSTFIRE from the ISO: ${stats.triangles} triangles, ${stats.collisionPolys} collision polys, ` +
    `${stats.loadMs} ms load (served: ${served.triangles}, ${served.loadMs} ms)`);
  expect(stats.map).toBe('FROSTFIRE');
  expect(stats.triangles).toBe(FROSTFIRE_TRIANGLES);
  expect(stats.triangles).toBe(served.triangles);
  expect(stats.collisionPolys).toBe(served.collisionPolys);
  expect(stats.slots).toEqual(served.slots);
  expect(stats.diagnostics).toEqual([]);
  expect(problems).toEqual([]);
});


test('with devmode and no maps served, the page offers the disc page instead of booting for ever', async ({ page }) => {
  // The one console line this test provokes: Chromium reports the 404 it is served for the index.
  const problems = watch(page, (m) => m.type() === 'error' && /maps\/index\.json$/.test(m.location().url));
  await page.route('**/maps/index.json', (route) => route.fulfill({ status: 404, body: '' }));
  await page.goto('/?devmode');
  const status = page.locator('#status');

  await expect(status).toContainText('open your own SOCOM II disc image');
  await expect(page.locator('#disc-page')).toBeVisible();
  await expect(page.locator('#disc')).toHaveCount(1);                 // the panel's own control is still there

  await page.locator('#disc-page-file').setInputFiles(ISO);
  await expect(status).toContainText('FROSTFIRE (MP2)');
  await expect(status).toContainText('triangles');
  await expect(page.locator('#disc-page')).toBeHidden();
  const stats = await page.evaluate(() => window.__viewer.stats());
  expect(stats.source).toBe('iso');
  expect(stats.triangles).toBe(FROSTFIRE_TRIANGLES);
  expect(problems).toEqual([]);
});

/**
 * The owner's 2026-09-29 default: opened by the plain URL the page asks nothing of the served tree -- not even its index
 * -- and shows the disc page; the ISO dropped anywhere on the window (a synthetic drag and drop carrying the file) is
 * read in the browser, the page says so, and Frostfire is drawn from it.
 */
test('by default no request goes to maps/: the disc page takes a dropped ISO and draws Frostfire from it', async ({ page }) => {
  const problems = watch(page);
  const served: string[] = [];
  page.on('request', (r) => { if (/\/maps\//.test(new URL(r.url()).pathname)) served.push(r.url()); });
  await page.goto('/');

  const discPage = page.locator('#disc-page');
  await expect(discPage).toBeVisible();
  await expect(discPage).toContainText('your own copy of the disc');
  await expect(discPage).toContainText('Nothing is uploaded');
  await expect(page.locator('#status')).toContainText('open your own SOCOM II disc image');
  expect(await page.evaluate(() => window.__viewer.discPage?.())).toBe(true);
  await expect(page.locator('#fps')).toBeHidden();                    // nothing drawn over the page

  const dataTransfer = await page.evaluateHandle((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'frostfire-only.iso', { type: 'application/octet-stream' }));
    return dt;
  }, readFileSync(ISO).toString('base64'));
  // On the page's background, not a control: the whole window is the drop target, lit while the file is over it.
  await page.dispatchEvent('#disc-page', 'dragover', { dataTransfer });
  await expect(page.locator('body')).toHaveClass(/\bdisc-over\b/);
  await page.dispatchEvent('#disc-page', 'drop', { dataTransfer });
  await expect(page.locator('body')).not.toHaveClass(/\bdisc-over\b/);
  await expect(page.locator('#disc-state')).toContainText('reading the disc image frostfire-only.iso');

  await expect(page.locator('#status')).toContainText('FROSTFIRE (MP2)');
  await expect(page.locator('#status')).toContainText('triangles');
  await expect(discPage).toBeHidden();
  const stats = await page.evaluate(() => window.__viewer.stats());
  expect(stats.source).toBe('iso');
  expect(stats.triangles).toBe(FROSTFIRE_TRIANGLES);
  expect(served).toEqual([]);
  expect(problems).toEqual([]);
});

test('by default a file that is not a disc is refused on the disc page itself, in the reader words', async ({ page }) => {
  const served: string[] = [];
  page.on('request', (r) => { if (/\/maps\//.test(new URL(r.url()).pathname)) served.push(r.url()); });
  await page.goto('/');
  await page.locator('#disc-page-file').setInputFiles({
    name: 'not-a-disc.iso', mimeType: 'application/octet-stream', buffer: Buffer.alloc(40 * 2048),
  });
  await expect(page.locator('#disc-state')).toContainText('not an ISO9660 image');
  await expect(page.locator('#disc-state')).toHaveClass(/is-bad/);
  await expect(page.locator('#disc-page')).toBeVisible();
  await expect(page.locator('#status')).not.toHaveClass(/is-bad/);      // the panel's line is not the error's (no unfold)
  expect(served).toEqual([]);
});
