import { expect, test, type Page } from '@playwright/test';
// `src/hook.ts` is types only; its `declare global` is what makes `window.__viewer` exist inside `page.evaluate`.
import type {} from '../src/hook';

/**
 * The settings panel on a phone held sideways (the open issue from round 3): opened, it docks in the top middle band --
 * right of the left edge's fullscreen and peek buttons, left of the zoom row under the compass, above the stick's zone
 * and the kit's row -- and scrolls inside itself, so no touch control is under it, flying or walking. Held upright it is
 * as it was: the full width under the bar.
 */

test.use({ storageState: { cookies: [], origins: [] } });

type Rect = { x: number; y: number; width: number; height: number };
const hit = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** Every touch control on the screen now: the buttons, the stick's zone and the fullscreen button, with their rects. */
function controls(page: Page): Promise<Array<{ id: string } & Rect>> {
  return page.evaluate(() => {
    const els = [...document.querySelectorAll<HTMLElement>('#touch button, #stick-zone, #fullscreen')];
    return els
      .map((e) => { const r = e.getBoundingClientRect(); return { id: e.id, x: r.x, y: r.y, width: r.width, height: r.height, shown: getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' }; })
      .filter((c) => c.shown && c.width > 0 && c.height > 0)
      .map(({ shown: _, ...c }) => c);
  });
}

async function openPanel(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await page.goto('/?redotcom');
  await expect(page.locator('#status')).toContainText(/triangles|tris/);
  await expect(page.locator('#panel')).toBeHidden();
  await page.locator('#panel-toggle').click();
  await expect(page.locator('#panel')).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

for (const size of [{ width: 812, height: 375 }, { width: 667, height: 375 }, { width: 915, height: 412 }]) {
  test.describe(`the panel on a phone held sideways, ${size.width}x${size.height}`, () => {
    test.use({ hasTouch: true, isMobile: true, viewport: size });

    test('open, it covers no touch control, flying or walking, and still scrolls to its end', async ({ page }) => {
      await openPanel(page, size);
      for (const mode of ['fly', 'walk'] as const) {
        expect(await page.evaluate((m) => window.__viewer.setMode(m), mode)).toBe(true);
        await expect(page.locator(mode === 'walk' ? '#tw-fire' : '#touch-lift')).toBeVisible();
        await page.waitForTimeout(100);
        const panel = (await page.locator('#panel').boundingBox())!;
        // On the screen, and a usable size.
        expect(panel.x).toBeGreaterThanOrEqual(0);
        expect(panel.y).toBeGreaterThanOrEqual(0);
        expect(panel.x + panel.width).toBeLessThanOrEqual(size.width);
        expect(panel.y + panel.height).toBeLessThanOrEqual(size.height);
        expect(panel.width, 'the panel is wide enough to read').toBeGreaterThanOrEqual(240);
        expect(panel.height, 'the panel is tall enough to use').toBeGreaterThanOrEqual(110);
        const shown = await controls(page);
        expect(shown.length, `${mode}: the touch controls are there`).toBeGreaterThan(mode === 'walk' ? 14 : 2);
        for (const c of shown) expect(hit(panel, c), `${mode}: the panel over #${c.id} ${JSON.stringify(c)} vs ${JSON.stringify(panel)}`).toBe(false);
        // The body scrolls to its last section: nothing in it is out of reach.
        const reach = await page.evaluate(() => {
          const body = document.getElementById('panel-body')!;
          body.scrollTop = body.scrollHeight;
          return Math.abs(body.scrollHeight - body.clientHeight - body.scrollTop) <= 1;
        });
        expect(reach).toBe(true);
      }
      // Folded, nothing of it shows.
      await page.locator('#panel-toggle').click();
      await expect(page.locator('#panel')).toBeHidden();
    });
  });
}

test.describe('the panel on a phone held upright', () => {
  const size = { width: 375, height: 812 };
  test.use({ hasTouch: true, isMobile: true, viewport: size });

  test('is as it was: the full width under the bar', async ({ page }) => {
    await openPanel(page, size);
    const panel = (await page.locator('#panel').boundingBox())!;
    expect(panel.x).toBeCloseTo(8, 0);
    expect(panel.y).toBeCloseTo(60, 0);
    expect(panel.width).toBeCloseTo(size.width - 16, 0);
  });
});
