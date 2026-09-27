/**
 * A/B the colour-space switch: one shot with the GS's own modulate, one with the linear-light
 * pipeline, from the same pose on the same map. Evidence for whether "closer to the original" is
 * actually what the change does.
 *
 *   npx tsx tools/compare-lighting.ts [MAPNAME]
 *
 * Writes test-fixtures/screens/lighting-{gs,linear}.png (git-ignored, like every other screenshot).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const MAP = process.argv[2] ?? 'FROSTFIRE';
const OUT = fileURLToPath(new URL('../test-fixtures/screens', import.meta.url));
const URL_BASE = process.env.VIEWER_URL ?? 'http://localhost:5173/';

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(URL_BASE);
await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('triangles'));

if (MAP !== 'FROSTFIRE') {
  const option = page.locator('#maps option', { hasText: MAP }).first();
  await page.selectOption('#maps', { value: await option.getAttribute('value') ?? '' });
  await page.waitForFunction(
    (m) => document.querySelector('#status')?.textContent?.includes(m), MAP,
  );
}

// A pose with both lit and shadowed surfaces in frame, not a top-down where everything faces the sky.
await page.evaluate(() => {
  const w = window as unknown as { __viewer: { setCamera(p: Record<string, number>): void } };
  w.__viewer.setCamera({ x: 0, y: 260, z: 900, yaw: 0, pitch: -12 });
});

const settle = (): Promise<void> => page.evaluate(
  () => new Promise<void>((d) => requestAnimationFrame(() => requestAnimationFrame(() => d()))),
);

for (const [name, linear] of [['gs', false], ['linear', true]] as const) {
  await page.evaluate((on) => {
    const box = document.getElementById('linearlight') as HTMLInputElement;
    box.checked = on;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  }, linear);
  await settle();
  await settle();
  const file = join(OUT, `lighting-${name}.png`);
  await page.screenshot({ path: file });
  console.log(`${name.padEnd(6)} linearLight=${String(linear).padEnd(5)} -> ${file}`);
}

await browser.close();
