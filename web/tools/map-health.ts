/**
 * Loads every served map in the viewer and reports what each one costs and complains about, so a map
 * that is broken is a row rather than a thing you have to fly to.
 *
 *   npx tsx tools/map-health.ts            # all of them
 *   npx tsx tools/map-health.ts MP5 MP9    # just these
 *
 * Writes a screenshot per map to test-fixtures/screens/health/ from a spawn, for eyeballing the rows
 * that look wrong.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import type { ViewerHook } from '../packages/viewer/src/hook';

const only = process.argv.slice(2).map((s) => s.toUpperCase());
const OUT = fileURLToPath(new URL('../test-fixtures/screens/health', import.meta.url));
mkdirSync(OUT, { recursive: true });

// The same launch the e2e uses (`playwright.config.ts`): SwiftShader for a host with no GPU, and `PW_CHROMIUM`
// for one whose Chromium is not the build this Playwright pins.
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  executablePath: process.env.PW_CHROMIUM || undefined,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const crashes: string[] = [];
page.on('pageerror', (e) => crashes.push(e.message));
await page.goto(process.env.VIEWER_URL ?? 'http://localhost:5173/');
await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('triangles'));
await page.evaluate(() => document.body.classList.add('chrome-hidden'));
// `HEALTH_TOGGLES=engineorder,wireframe` sets panel switches on for the whole sweep, the way the e2e sets them
// (the property and a change event), so a switch can be swept against the default's rows.
for (const id of (process.env.HEALTH_TOGGLES ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
  await page.evaluate((toggle) => {
    const box = document.getElementById(toggle) as HTMLInputElement | null;
    if (!box) throw new Error(`no toggle #${toggle}`);
    if (!box.checked) { box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); }
  }, id);
}

const options = await page.locator('#maps option').evaluateAll(
  (els) => els.map((e) => ({ value: (e as HTMLOptionElement).value, label: (e as HTMLOptionElement).textContent ?? '' })),
);

const settle = (p: Page): Promise<void> => p.evaluate(
  () => new Promise<void>((d) => requestAnimationFrame(() => requestAnimationFrame(() => d()))),
);

// `detail`: draws carrying a detail pass (W1.6, `WorldView.detailDraws`), the last fixed column so every
// earlier one reads as it did before it was added.
console.log('archive  name              tris    draws  untex  collis  diag  spawns  detail  notes');
for (const { value, label } of options) {
  const archive = /\(([^)]+)\)/.exec(label)?.[1] ?? value;
  if (only.length && !only.includes(archive.toUpperCase())) continue;
  const before = crashes.length;
  // The chrome is hidden for the screenshots, so the select is set through the DOM rather than
  // clicked -- Playwright refuses to act on an element it cannot see.
  await page.evaluate((v) => {
    const el = document.getElementById('maps') as HTMLSelectElement;
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  try {
    // The parenthesised archive, not the bare one: waiting for `MP1` matches `(MP12)` and, worse,
    // can match the line the previous map left behind, which reports the previous map's stats.
    await page.waitForFunction(
      (v) => document.querySelector('#status')?.textContent?.includes(`(${v})`), archive, { timeout: 30000 });
  } catch {
    console.log(`${archive.padEnd(8)} ${label.padEnd(17)} DID NOT LOAD`);
    continue;
  }
  await settle(page);

  const s = await page.evaluate(
    () => (window as unknown as { __viewer: ViewerHook }).__viewer.stats());
  // Stand at a spawn and look level, the way a player first sees the map.
  await page.evaluate(() => {
    const w = window as unknown as { __viewer: { stats(): { spawns: { a: [number, number, number] } | null }; setCamera(p: Record<string, number>): void } };
    const a = w.__viewer.stats().spawns?.a;
    if (a) w.__viewer.setCamera({ x: a[0], y: a[1] + 20, z: a[2], yaw: 40, pitch: -4 });
  });
  await settle(page);
  await settle(page);
  await page.screenshot({ path: join(OUT, `${archive}.png`) });

  const notes: string[] = [];
  if (!s.spawns) notes.push('no measured spawn');
  if (s.triangles < 5000) notes.push('very few triangles');
  if (s.untexturedDraws > 0) notes.push(`${s.untexturedDraws} untextured`);
  if (crashes.length > before) notes.push(`PAGEERROR: ${crashes[before]}`);
  console.log(
    `${archive.padEnd(8)} ${(s.map ?? '?').padEnd(17)} ${String(s.triangles).padStart(6)} `
    + `${String(s.diagnostics.length ? '-' : '-').padStart(6)} ${String(s.untexturedDraws).padStart(6)} `
    + `${String(s.collisionPolys).padStart(7)} ${String(s.diagnostics.length).padStart(5)} `
    + `${(s.spawns ? 'yes' : 'NO').padStart(6)} ${String(s.detailDraws).padStart(7)}  ${notes.join('; ')}`,
  );
  for (const d of s.diagnostics.slice(0, 3)) console.log(`           ! ${d.slice(0, 150)}`);
  if (s.diagnostics.length > 3) console.log(`           ! ... and ${s.diagnostics.length - 3} more`);
}

await browser.close();
console.log(`\nscreenshots: ${OUT}`);
