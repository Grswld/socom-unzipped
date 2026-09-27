/**
 * Stands a short way off a map's first flare and photographs it, so the thing being argued about is
 * big enough in frame to see.
 *
 *   npx tsx tools/shoot-flare.ts <out.png> [MAP] [index] [distance]
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from '@playwright/test';
import type { ViewerHook } from '../packages/viewer/src/hook';

const [out, map = 'FROSTFIRE', index = '0', distance = '55'] = process.argv.slice(2);
if (!out) { console.error('usage: npx tsx tools/shoot-flare.ts <out.png> [MAP] [index] [distance]'); process.exit(2); }
mkdirSync(dirname(out), { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto(process.env.VIEWER_URL ?? 'http://localhost:5173/');
await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('triangles'));

if (map !== 'FROSTFIRE') {
  await page.evaluate((v) => {
    const el = document.getElementById('maps') as HTMLSelectElement;
    const hit = Array.from(el.options).find((o) => (o.textContent ?? "").includes(v));
    if (hit) { el.value = hit.value; el.dispatchEvent(new Event('change', { bubbles: true })); }
  }, map);
  await page.waitForFunction((m) => document.querySelector('#status')?.textContent?.includes(m), map);
}

const placed = await page.evaluate((v) => {
  const w = window as unknown as { __viewer: ViewerHook };
  const flares = w.__viewer.flares();
  if (!flares.length) return null;
  const at = flares[Math.min(v.i, flares.length - 1)]!;
  document.body.classList.add('chrome-hidden');
  // Stand off along +z and a little above, looking back at it.
  w.__viewer.setCamera({ x: at[0], y: at[1] + 6, z: at[2] + v.d, yaw: 0, pitch: -6 });
  return { count: flares.length, at };
}, { i: Number(index), d: Number(distance) });

if (!placed) { console.log(`${map}: no flares`); await browser.close(); process.exit(0); }
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => new Promise<void>((d) => requestAnimationFrame(() => requestAnimationFrame(() => d()))));
}
await page.screenshot({ path: out });
console.log(`${map}: ${placed.count} flares, shot #${index} at ${placed.at.map((v) => v.toFixed(0)).join(',')} -> ${out}`);
await browser.close();
