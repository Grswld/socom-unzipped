/**
 * The same pose on the same map, with one toggle off and then on. For telling "this map always looked
 * like that" from "I broke it".
 *
 *   npx tsx tools/ab-toggle.ts <outdir> <toggleId> <MAP> <x> <y> <z> <yaw> <pitch>
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [outDir, toggle, map, x, y, z, yaw, pitch] = process.argv.slice(2);
if (!outDir || !toggle || !map) {
  console.error('usage: npx tsx tools/ab-toggle.ts <outdir> <toggleId> <MAP> <x> <y> <z> <yaw> <pitch>');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto(process.env.VIEWER_URL ?? 'http://localhost:5173/');
await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('triangles'));

if (map !== 'FROSTFIRE') {
  const option = page.locator('#maps option', { hasText: map }).first();
  await page.selectOption('#maps', { value: await option.getAttribute('value') ?? '' });
  await page.waitForFunction((m) => document.querySelector('#status')?.textContent?.includes(m), map);
}

for (const on of [false, true]) {
  await page.evaluate((v) => {
    document.body.classList.add('chrome-hidden');
    const box = document.getElementById(v.id) as HTMLInputElement;
    if (box && box.checked !== v.on) { box.checked = v.on; box.dispatchEvent(new Event('change', { bubbles: true })); }
    (window as unknown as { __viewer: { setCamera(p: Record<string, number>): void } }).__viewer.setCamera({
      x: Number(v.x), y: Number(v.y), z: Number(v.z), yaw: Number(v.yaw), pitch: Number(v.pitch),
    });
  }, { id: toggle, on, x, y, z, yaw, pitch });
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => new Promise<void>((d) => requestAnimationFrame(() => requestAnimationFrame(() => d()))));
  }
  const file = join(outDir, `${toggle}-${on ? 'on' : 'off'}.png`);
  await page.screenshot({ path: file });
  console.log(`${toggle}=${String(on).padEnd(5)} -> ${file}`);
}
await browser.close();
