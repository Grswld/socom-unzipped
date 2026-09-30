import { chromium, expect, test, type Page } from '@playwright/test';
// `src/hook.ts` is types only; its `declare global` is what makes `window.__viewer` exist inside `page.evaluate`.
import type {} from '../src/hook';

/**
 * Both presentations draw the world, under both backends (owner, 2026-09-29: "the PS2 presentation renders a black
 * screen"). The PS2 picture is the world drawn into a 640x448 target and copied onto the canvas; in walk mode the
 * reticle and the HUD are drawn over the copy with `autoClear` off. Under WebGPU three drew the copy as a fullscreen
 * pass (a `QuadMesh`: no multisampling, straight into the canvas texture) and the overlays as a multisampled pass that
 * loads the canvas's multisample buffer -- which never held the copy -- and resolves over it: the world went black and
 * the HUD stayed. The check: the canvas as the page shows it, sampled on a grid, lit in the PS2 presentation about as
 * much as in the Modern one, in the walk (HUD and reticle up) and in the fly.
 *
 * The WebGPU half needs a browser with an adapter: the new headless mode (`channel: 'chromium'`) exposes the host's
 * GPU; where there is none it lands on WebGL2 and the half is skipped, saying so.
 */

const setToggle = (page: Page, id: string, on: boolean): Promise<void> =>
  page.locator(`#${id}`).evaluate((el, checked) => {
    const box = el as HTMLInputElement;
    if (box.checked === checked) return;
    box.checked = checked;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  }, on);

/** The share of a 64x48 grid over the canvas, as composited, whose luma is over 16 (of 255): 0 for a black picture. */
async function lit(page: Page): Promise<number> {
  const png = (await page.locator('#view').screenshot()).toString('base64');
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height).data;
    let on = 0, n = 0;
    for (let j = 0; j < 48; j++) for (let i = 0; i < 64; i++) {
      const x = Math.floor(((i + 0.5) / 64) * img.width), y = Math.floor(((j + 0.5) / 48) * img.height);
      const k = (y * img.width + x) * 4;
      if ((d[k]! + d[k + 1]! + d[k + 2]!) / 3 > 16) on++;
      n++;
    }
    return on / n;
  }, png);
}

async function check(page: Page, archive: string, want: 'webgpu' | 'webgl2'): Promise<void> {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`/?mode=play&fly&map=${archive}&devmode`);
  const status = page.locator('#status');
  await expect(status).toContainText(`(${archive})`);
  await expect(status).toContainText('triangles');
  const backend = (await page.evaluate(() => window.__viewer.stats())).backend;
  test.skip(backend !== want, `this browser drew with ${backend}, not ${want}`);

  await setToggle(page, 'ps2look', false);
  await page.waitForTimeout(1000);
  const flyNative = await lit(page);
  await setToggle(page, 'ps2look', true);
  await page.waitForTimeout(500);
  const flyPs2 = await lit(page);

  expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(true);
  await page.waitForTimeout(2500);   // past the spawn's fade from black, the HUD faded in
  const walkPs2 = await lit(page);
  await page.locator('#view').screenshot({ path: test.info().outputPath(`${archive}-${backend}-walk-ps2.png`) });
  await setToggle(page, 'ps2look', false);
  await page.waitForTimeout(500);
  const walkNative = await lit(page);

  const shares = { flyNative, flyPs2, walkNative, walkPs2 };
  console.log(`${archive} ${backend}: ${JSON.stringify(shares)}`);
  // The Modern picture is the reference that the pose shows a lit world at all.
  expect(flyNative, JSON.stringify(shares)).toBeGreaterThan(0.2);
  expect(walkNative, JSON.stringify(shares)).toBeGreaterThan(0.2);
  // The PS2 picture shows the same world: not black, lit about as much (the frames differ in shape, not in content).
  expect(flyPs2, JSON.stringify(shares)).toBeGreaterThan(flyNative * 0.6);
  expect(walkPs2, JSON.stringify(shares)).toBeGreaterThan(walkNative * 0.6);
  expect(problems).toEqual([]);
}

const MAPS = ['MP2', 'MP1'];

test.describe('WebGL2 (SwiftShader)', () => {
  for (const archive of MAPS) {
    test(`${archive}: the PS2 and Modern presentations both draw the world, flying and walking`, async ({ page }) => {
      await check(page, archive, 'webgl2');
    });
  }
});

test.describe('WebGPU (the host adapter)', () => {
  for (const archive of MAPS) {
    test(`${archive}: the PS2 and Modern presentations both draw the world, flying and walking`, async ({ baseURL, storageState }) => {
      // A browser of its own: a group cannot `use` a channel (it forces a worker), and the config's is the headless shell.
      const browser = await chromium.launch({
        channel: 'chromium', args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'], executablePath: process.env.PW_CHROMIUM || undefined,
      });
      try {
        const context = await browser.newContext({ baseURL, storageState, viewport: { width: 1280, height: 720 } });
        await check(await context.newPage(), archive, 'webgpu');
      } finally {
        await browser.close();
      }
    });
  }
});
