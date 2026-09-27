/**
 * One screenshot of the running viewer from an exact pose, with the panel hidden.
 *
 *   npx tsx tools/shoot.ts <out.png> <x> <y> <z> <yaw> <pitch> [MAPNAME] [w] [h]
 *
 * For lining a render up against a capture: the pose is the only thing that has to be matched by hand.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from '@playwright/test';

const [out, x, y, z, yaw, pitch, map = 'FROSTFIRE', w = '1600', h = '848'] = process.argv.slice(2);
if (!out) {
  console.error('usage: npx tsx tools/shoot.ts <out.png> <x> <y> <z> <yaw> <pitch> [MAP] [w] [h]');
  process.exit(2);
}
mkdirSync(dirname(out), { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto(process.env.VIEWER_URL ?? 'http://localhost:5173/');
await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('triangles'));

if (map !== 'FROSTFIRE') {
  const option = page.locator('#maps option', { hasText: map }).first();
  await page.selectOption('#maps', { value: await option.getAttribute('value') ?? '' });
  await page.waitForFunction((m) => document.querySelector('#status')?.textContent?.includes(m), map);
}

await page.evaluate((p) => {
  document.body.classList.add('chrome-hidden');
  (window as unknown as { __viewer: { setCamera(v: Record<string, number>): void } }).__viewer.setCamera(p);
}, { x: Number(x), y: Number(y), z: Number(z), yaw: Number(yaw), pitch: Number(pitch) });

for (let i = 0; i < 3; i++) {
  await page.evaluate(() => new Promise<void>((d) => requestAnimationFrame(() => requestAnimationFrame(() => d()))));
}
await page.screenshot({ path: out });
console.log(`${out}  pose ${x},${y},${z} yaw ${yaw} pitch ${pitch}  map ${map}`);
await browser.close();
