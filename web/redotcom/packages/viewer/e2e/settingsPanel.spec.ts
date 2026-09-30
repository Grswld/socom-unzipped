import { expect, test, type Page } from '@playwright/test';
import type {} from '../src/hook';

/**
 * The settings panel's polish pass (owner, 2026-09-29: "Give the full settings panel another polish pass for usability
 * and readability"), measured in the browser at the phone sizes (812x375, 667x375 sideways, 390x844 upright) and two
 * desktops (1280, 1920): nothing in the panel is cut off or scrolls sideways, every control of a touch screen is at least
 * 44 px tall, and the keyboard walks the panel top to bottom with a visible ring. The unit twin is
 * `test/settingsPanel.test.ts`.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const SIZES = [
  { width: 812, height: 375, touch: true }, { width: 667, height: 375, touch: true }, { width: 390, height: 844, touch: true },
  { width: 1280, height: 800, touch: false }, { width: 1920, height: 1080, touch: false },
];

async function openPanel(page: Page): Promise<void> {
  await page.goto('/?mode=play&fly&devmode');
  await expect(page.locator('#status')).toContainText(/triangles|tris/);
  await page.evaluate(() => document.getElementById('mobile-tip-close')?.click());
  await page.locator('#panel-toggle').click();
  await expect(page.locator('#panel')).toBeVisible();
}

for (const size of SIZES) {
  test.describe(`the settings panel at ${size.width}x${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, hasTouch: size.touch, isMobile: size.touch });

    test('nothing is cut off and nothing scrolls sideways; touch targets are 44 px', async ({ page }) => {
      await openPanel(page);
      await page.evaluate(() => { for (const d of document.querySelectorAll<HTMLDetailsElement>('#panel details')) d.open = true; });
      const report = await page.evaluate(() => {
        const body = document.getElementById('panel-body')!;
        const clipped: string[] = [];
        for (const el of body.querySelectorAll<HTMLElement>('.s2u-tab, .s2u-check, .s2u-range, .s2u-field__label, .s2u-field__note, #disc, summary')) {
          if (el.offsetParent === null) continue;
          if (el.scrollWidth > el.clientWidth + 1) clipped.push(`${el.id || el.className}: ${el.textContent?.trim().slice(0, 30)}`);
        }
        const small: string[] = [];
        for (const el of body.querySelectorAll<HTMLElement>('.s2u-tab, .s2u-check, .s2u-range, summary, select, input[type="text"], #disc')) {
          if (el.offsetParent === null) continue;
          if (el.getBoundingClientRect().height < 43.5) small.push(`${el.id || el.tagName}: ${Math.round(el.getBoundingClientRect().height)}`);
        }
        return { sideways: body.scrollWidth > body.clientWidth + 1, clipped, small };
      });
      expect(report.sideways, 'the panel scrolls sideways').toBe(false);
      expect(report.clipped).toEqual([]);
      if (size.touch) expect(report.small).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  });
}

test('the keyboard walks the panel top to bottom, each stop with a visible ring', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openPanel(page);
  await page.locator('#recom [data-recom="off"]').focus();
  const stops: string[] = [];
  for (let i = 0; i < 12; i++) {
    const at = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      return { id: el.id || el.dataset['recom'] || el.dataset['look'] || el.dataset['law'] || el.dataset['online'] || el.tagName, ring: getComputedStyle(el).outlineStyle !== 'none' || getComputedStyle(el.closest('label') ?? el).outlineStyle !== 'none', top: el.getBoundingClientRect().top };
    });
    stops.push(at.id);
    expect(at.ring, `${at.id} shows no focus ring`).toBe(true);
    await page.keyboard.press('Tab');
  }
  // Mode's two options come before the map picker, and the map before the picture.
  expect(stops.indexOf('off')).toBeLessThan(stops.indexOf('maps'));
  expect(stops.indexOf('maps')).toBeLessThan(stops.indexOf('modern'));
});
