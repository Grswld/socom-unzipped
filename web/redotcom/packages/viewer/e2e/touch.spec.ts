import { expect, test, type CDPSession, type Page } from '@playwright/test';
// `src/hook.ts` is types only; its `declare global` is what makes `window.__viewer` exist inside `page.evaluate`.
import type {} from '../src/hook';
import { shortTurn } from '../src/yaw';

/**
 * Walk mode on a phone (owner, 2026-09-29: dual floating sticks, SHOOT and JUMP, the needed buttons tidied): with emulated
 * touch in landscape (812x375, 667x375, 915x412) and portrait (375x812), a finger on the left half moves, one on the right
 * half looks -- both at once -- and the buttons hold the lanes the pad's buttons hold. The page is loaded with
 * `?redotcom&fly`; the touches go through the browser's own input (`Input.dispatchTouchEvent`), so a hold is a hold.
 */

// A phone's first visit, the panel folded: opened (the specs' default, `playwright.config.ts`) it would cover the buttons.
test.use({ storageState: { cookies: [], origins: [] } });

const LANDSCAPES = [{ width: 812, height: 375 }, { width: 667, height: 375 }, { width: 915, height: 412 }];
const LANDSCAPE = LANDSCAPES[0]!;
const PORTRAIT = { width: 375, height: 812 };

type Rect = { x: number; y: number; width: number; height: number };
const hit = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

async function phone(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await page.goto('/?redotcom&fly&devmode');
  await expect(page.locator('#status')).toContainText(/triangles|tris/);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  // The tip is a first visit's (`./mobileTip`); these specs are about the controls under it.
  await page.evaluate(() => document.getElementById('mobile-tip-close')?.click());
}

/** Touches and holds: each id is a finger, at a selector's centre or at a point. */
class Fingers {
  constructor(private readonly cdp: CDPSession, private readonly page: Page) {}
  private points = new Map<number, { x: number; y: number }>();
  private async at(where: string | { x: number; y: number }): Promise<{ x: number; y: number }> {
    if (typeof where !== 'string') return where;
    const b = (await this.page.locator(where).boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }
  async down(id: number, where: string | { x: number; y: number }): Promise<void> {
    this.points.set(id, await this.at(where));
    await this.send('touchStart');
  }
  async move(id: number, to: { x: number; y: number }): Promise<void> {
    this.points.set(id, to);
    await this.send('touchMove');
  }
  /** Every finger up: the protocol's touchEnd carries no points and ends all that are down. */
  async up(_id?: number): Promise<void> {
    this.points.clear();
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  private send(type: 'touchStart' | 'touchMove'): Promise<unknown> {
    return this.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [...this.points.entries()].map(([id, p]) => ({ ...p, id })) });
  }
  async tap(id: number, selector: string, ms = 80): Promise<void> {
    await this.down(id, selector);
    await this.page.waitForTimeout(ms);
    await this.up(id);
  }
}

const input = (page: Page) => page.evaluate(() => window.__viewer.pad().input);
const buttonsShown = (page: Page): Promise<Array<{ id: string } & Rect>> => page.evaluate(() =>
  [...document.querySelectorAll<HTMLElement>('#touch button, #fullscreen')]
    .map((e) => { const r = e.getBoundingClientRect(); return { id: e.id, x: r.x, y: r.y, width: r.width, height: r.height, shown: getComputedStyle(e).display !== 'none' }; })
    .filter((c) => c.shown && c.width > 0 && c.height > 0)
    .map(({ shown: _, ...c }) => c));

for (const size of LANDSCAPES) {
  test.describe(`walk mode on a phone, landscape ${size.width}x${size.height}`, () => {
    test.use({ hasTouch: true, isMobile: true, viewport: size });

    test('the layout: SHOOT and JUMP under the right thumb, nothing overlapping, the HUD clear', async ({ page }) => {
      await phone(page, size);
      await expect(page.locator('#touch-lift')).toBeVisible();                   // flying: the lift buttons
      await expect(page.locator('#touch-walk')).toBeHidden();
      await expect(page.locator('#aim-zone')).toBeHidden();                      // flying: the canvas's drag looks
      expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(true);
      await expect(page.locator('#tw-fire')).toBeVisible();
      await expect(page.locator('#tw-fire')).toHaveText('SHOOT');
      await expect(page.locator('#tw-jump')).toContainText('JUMP');
      await expect(page.locator('#aim-zone')).toBeVisible();
      await expect(page.locator('#touch-lift')).toBeHidden();
      await expect(page.locator('#rotate-hint')).toBeHidden();
      const shown = await buttonsShown(page);
      const ids = shown.map((b) => b.id);
      for (const id of ['tw-fire', 'tw-jump', 'tw-stance', 'tw-action', 'tw-zoom-in', 'tw-zoom-out', 'tw-reload', 'tw-inventory', 'fullscreen']) expect(ids, id).toContain(id);
      for (const b of shown) {
        expect(b.x, b.id).toBeGreaterThanOrEqual(0);
        expect(b.y, b.id).toBeGreaterThanOrEqual(0);
        expect(b.x + b.width, b.id).toBeLessThanOrEqual(size.width);
        expect(b.y + b.height, `${b.id} clears the HUD's bottom strip`).toBeLessThanOrEqual(size.height - 40);
        expect(Math.min(b.width, b.height), `${b.id} is a target`).toBeGreaterThanOrEqual(36);
      }
      for (const [i, a] of shown.entries()) for (const c of shown.slice(i + 1)) expect(hit(a, c), `${a.id} over ${c.id}`).toBe(false);
      const box = (id: string): Rect => shown.find((b) => b.id === id)!;
      // SHOOT the largest, at the right edge; JUMP beside it; both in the right half, where the right thumb is.
      expect(box('tw-fire').width).toBeGreaterThan(box('tw-jump').width);
      expect(box('tw-jump').width).toBeGreaterThan(box('tw-stance').width);
      expect(box('tw-fire').x + box('tw-fire').width).toBeGreaterThan(size.width - 24);
      expect(box('tw-jump').x + box('tw-jump').width).toBeLessThanOrEqual(box('tw-fire').x);
      for (const id of ['tw-fire', 'tw-jump', 'tw-stance', 'tw-action']) expect(box(id).x, id).toBeGreaterThan(size.width / 2);
      // The compass (top right) and the ammo box (bottom left) are the HUD's.
      for (const b of shown) {
        expect(hit(b, { x: 0, y: size.height - 70, width: 140, height: 70 }), `${b.id} over the ammo box`).toBe(false);
        expect(hit(b, { x: size.width - 100, y: 34, width: 100, height: 80 }), `${b.id} over the compass`).toBe(false);
      }
    });
  });
}

test.describe('the dual sticks and the buttons, landscape', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: LANDSCAPE });

  test('the left thumb moves and the right thumb looks, at once, each born where it lands', async ({ page }) => {
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await phone(page, LANDSCAPE);
    await page.evaluate(() => window.__viewer.setMode('walk'));
    await page.waitForTimeout(500);
    const fingers = new Fingers(await page.context().newCDPSession(page), page);
    const yaw0 = (await page.evaluate(() => window.__viewer.pose())).yaw;
    const feet0 = await page.evaluate(() => { const p = window.__viewer.pose(); return [p.x, p.z]; });

    await fingers.down(1, { x: 150, y: 280 });                                  // the left half: the move stick
    await expect(page.locator('#stick-base')).toBeVisible();
    const base = (await page.locator('#stick-base').boundingBox())!;
    expect(base.x + base.width / 2).toBeCloseTo(150, 0);
    expect(base.y + base.height / 2).toBeCloseTo(280, 0);
    await fingers.move(1, { x: 150, y: 200 });                                  // pushed up: forward
    await fingers.down(2, { x: 560, y: 220 });                                  // the right half, a second finger: the look
    await expect(page.locator('#aim-base')).toBeVisible();
    await fingers.move(2, { x: 640, y: 220 });                                  // pushed right: turn right
    await expect.poll(async () => { const i = await input(page); return i.moveY > 0.9 && i.lookX > 0.9; }).toBe(true);
    await page.waitForTimeout(800);
    const yaw1 = (await page.evaluate(() => window.__viewer.pose())).yaw;
    expect(Math.abs(shortTurn(yaw0, yaw1)), 'the look stick turned the view').toBeGreaterThan(5);
    const feet1 = await page.evaluate(() => { const p = window.__viewer.pose(); return [p.x, p.z]; });
    expect(Math.hypot(feet1[0]! - feet0[0]!, feet1[1]! - feet0[1]!), 'the move stick walked').toBeGreaterThan(2);
    await fingers.up();
    await expect.poll(async () => { const i = await input(page); return [i.moveX, i.moveY, i.lookX, i.lookY]; }).toEqual([0, 0, 0, 0]);
    await expect(page.locator('#stick-base')).toBeHidden();
    await expect(page.locator('#aim-base')).toBeHidden();

    // A thumb that lands inside the dead zone and stays there moves nothing: the pad's dead zone.
    await fingers.down(1, { x: 150, y: 280 });
    await fingers.move(1, { x: 153, y: 278 });
    await page.waitForTimeout(100);
    expect((await input(page)).moveY).toBe(0);
    await fingers.up();
    expect(problems).toEqual([]);
  });

  test('SHOOT and JUMP hold their lanes, together, and a stick starting on a button is no stick', async ({ page }) => {
    await phone(page, LANDSCAPE);
    await page.evaluate(() => window.__viewer.setMode('walk'));
    await page.waitForTimeout(500);
    const fingers = new Fingers(await page.context().newCDPSession(page), page);
    const shots = (): Promise<number> => page.evaluate(() => window.__viewer.fire().shots);
    const s0 = await shots();
    await fingers.down(1, '#tw-fire');
    await expect.poll(async () => (await input(page)).fire).toBe(true);
    await expect.poll(shots).toBeGreaterThan(s0);
    await expect(page.locator('#aim-base')).toBeHidden();                       // a button press starts no stick
    await fingers.down(2, '#tw-jump');
    await expect.poll(async () => { const i = await input(page); return i.fire && i.jump; }).toBe(true);
    await fingers.up();
    await expect.poll(async () => (await input(page)).fire).toBe(false);
    await expect.poll(() => page.evaluate(() => window.__viewer.mover()!.airborne), { timeout: 3000 }).toBe(false);

    // A look stick dragged across SHOOT presses nothing.
    const s1 = await shots();
    const fire = (await page.locator('#tw-fire').boundingBox())!;
    await fingers.down(1, { x: fire.x - 120, y: fire.y + fire.height / 2 });
    await fingers.move(1, { x: fire.x + fire.width / 2, y: fire.y + fire.height / 2 });
    await page.waitForTimeout(300);
    expect((await input(page)).fire).toBe(false);
    expect(await shots()).toBe(s1);
    await fingers.up();
  });

  test('the other buttons: stance, action, zoom, next item, reload', async ({ page }) => {
    await phone(page, LANDSCAPE);
    await page.evaluate(() => window.__viewer.setMode('walk'));
    await page.waitForTimeout(500);
    const fingers = new Fingers(await page.context().newCDPSession(page), page);
    const stance = (): Promise<string> => page.evaluate(() => window.__viewer.stance());
    await fingers.tap(1, '#tw-stance', 100);
    await expect.poll(stance).toBe('crouch');
    await fingers.tap(1, '#tw-stance', 100);
    await expect.poll(stance).toBe('stand');
    await fingers.down(1, '#tw-action');
    await expect.poll(async () => (await input(page)).action).toBe(true);
    await fingers.up(1);
    const zoom = (): Promise<number> => page.evaluate(() => window.__viewer.zoom().state);
    const z0 = await zoom();
    await fingers.tap(1, '#tw-zoom-in', 1);
    await expect.poll(zoom).toBeGreaterThan(z0);
    await fingers.tap(1, '#tw-zoom-out', 60);
    await expect.poll(zoom).toBe(z0);
    const item = (): Promise<string> => page.evaluate(() => window.__viewer.hud().model.weaponIcon);
    const rifle = await item();
    await fingers.tap(1, '#tw-inventory', 60);
    await expect.poll(item, { timeout: 5000 }).not.toBe(rifle);
    await page.waitForTimeout(1500);
    for (let i = 0; i < 4 && (await item()) !== rifle; i++) { await fingers.tap(1, '#tw-inventory', 60); await page.waitForTimeout(1500); }
    await fingers.tap(1, '#tw-reload');
    await expect.poll(() => page.evaluate(() => window.__viewer.fire().magazine.reloading), { timeout: 3000 }).toBe(true);
  });

  test('a pad connecting hides the touch layer and drives the walk; its leaving brings the layer back', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __pad: unknown };
      w.__pad = null;
      Object.defineProperty(navigator, 'getGamepads', { value: () => [w.__pad] });
    });
    await phone(page, LANDSCAPE);
    await page.evaluate(() => window.__viewer.setMode('walk'));
    await expect(page.locator('#tw-fire')).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { __pad: unknown }).__pad = {
        id: 'Test pad', index: 0, connected: true, mapping: 'standard', axes: [0, -1, 0, 0],
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
      };
    });
    // Never assert visibility on `#touch` itself: it is a zero-size box (its sticks and buttons are fixed-position
    // children), so Playwright reads it hidden whether the layer shows or not. The switch is `body.pad-on`
    // (`src/styles.css`: `body.touch.pad-on #touch { display: none }`), and a control inside the layer shows it.
    await expect(page.locator('body')).toHaveClass(/(^|\s)pad-on(\s|$)/);
    await expect(page.locator('#tw-fire')).toBeHidden();
    await expect.poll(async () => (await input(page)).moveY).toBe(1);
    await page.evaluate(() => { (window as unknown as { __pad: unknown }).__pad = null; });
    await expect(page.locator('body')).not.toHaveClass(/(^|\s)pad-on(\s|$)/);
    await expect(page.locator('#tw-fire')).toBeVisible();
  });
});

test.describe('the tip on a phone', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: LANDSCAPE });

  test('recommends a controller and landscape once a visit, and a dismissal is remembered', async ({ page }) => {
    await page.setViewportSize(LANDSCAPE);
    await page.goto('/?redotcom&fly&devmode');
    const tip = page.locator('#mobile-tip');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText(/controller/i);
    await expect(tip).toContainText(/landscape/i);
    await page.reload();                                                        // the same visit: not again
    await expect(page.locator('#status')).toContainText(/triangles|tris/);
    await expect(tip).toBeHidden();
    await page.setViewportSize(PORTRAIT);                                       // a turn to portrait: again
    await expect(tip).toBeVisible();
    await page.locator('#mobile-tip-close').click();
    await expect(tip).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('s2u.viewer.mobileTipDismissed'))).toBe('1');
    await page.setViewportSize(LANDSCAPE);
    await page.setViewportSize(PORTRAIT);
    await page.waitForTimeout(200);
    await expect(tip).toBeHidden();
  });

  test('is not shown on a desktop', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await page.goto('/?redotcom&fly&devmode');
    await expect(page.locator('#status')).toContainText(/triangles|tris/);
    await expect(page.locator('#mobile-tip')).toBeHidden();
    await context.close();
  });
});

test.describe('walk mode on a phone, portrait', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: PORTRAIT });

  test('asks for a turn while walking, and the buttons are still there, none overlapping', async ({ page }) => {
    await phone(page, PORTRAIT);
    await expect(page.locator('#rotate-hint')).toBeHidden();                      // flying: no ask
    await page.evaluate(() => window.__viewer.setMode('walk'));
    await expect(page.locator('#rotate-hint')).toBeVisible();
    await expect(page.locator('#rotate-hint')).toContainText('sideways');
    await expect(page.locator('#tw-fire')).toBeVisible();
    const shown = await buttonsShown(page);
    for (const b of shown) {
      expect(b.x, b.id).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width, b.id).toBeLessThanOrEqual(PORTRAIT.width);
      expect(b.y + b.height, b.id).toBeLessThanOrEqual(PORTRAIT.height);
    }
    for (const [i, a] of shown.entries()) for (const c of shown.slice(i + 1)) expect(hit(a, c), `${a.id} over ${c.id}`).toBe(false);
    await page.evaluate(() => window.__viewer.setMode('fly'));
    await expect(page.locator('#rotate-hint')).toBeHidden();
  });
});

test.describe('without ?redotcom&fly', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: LANDSCAPE });

  test('the phone has no walk layout, no look stick, no hint, and the fly touch UI as it was', async ({ page }) => {
    await page.goto('/?devmode');
    await expect(page.locator('#status')).toContainText(/triangles|tris/);
    for (const id of ['touch-walk', 'rotate-hint', 'tw-fire', 'tw-jump', 'aim-zone']) await expect(page.locator(`#${id}`)).toHaveCount(0);
    await expect(page.locator('#touch-lift')).toBeVisible();
    expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(false);
  });
});
