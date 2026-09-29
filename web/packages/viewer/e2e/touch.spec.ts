import { expect, test, type CDPSession, type Page } from '@playwright/test';
// `src/hook.ts` is types only; its `declare global` is what makes `window.__viewer` exist inside `page.evaluate`.
import type {} from '../src/hook';

/**
 * Walk mode on a phone (round 3): with emulated touch at 812x375 (landscape, the play mode) and 375x812 (portrait, where
 * the page asks for a turn), the touch layout's buttons hold the lanes the pad's buttons hold, and the page does what it does
 * for a pad. The page is loaded with `?redotcom&fly`; the buttons are real touches, sent through the browser's own input
 * (`Input.dispatchTouchEvent`), so a hold is a hold.
 */

// A phone's first visit, the panel folded: opened (the specs' default, `playwright.config.ts`) it would cover the buttons.
test.use({ storageState: { cookies: [], origins: [] } });

const LANDSCAPE = { width: 812, height: 375 };
const PORTRAIT = { width: 375, height: 812 };

async function phone(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await page.goto('/?redotcom&fly');
  await expect(page.locator('#status')).toContainText(/triangles|tris/);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** Touches and holds: each id is a finger. */
class Fingers {
  constructor(private readonly cdp: CDPSession, private readonly page: Page) {}
  private async at(selector: string): Promise<{ x: number; y: number }> {
    const b = (await this.page.locator(selector).boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }
  private points = new Map<number, { x: number; y: number }>();
  async down(id: number, selector: string): Promise<void> {
    this.points.set(id, await this.at(selector));
    await this.send('touchStart');
  }
  /** Every finger up: the protocol's touchEnd carries no points and ends all that are down. */
  async up(_id?: number): Promise<void> {
    this.points.clear();
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  private send(type: 'touchStart'): Promise<unknown> {
    return this.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [...this.points.entries()].map(([id, p]) => ({ ...p, id })) });
  }
  async tap(id: number, selector: string, ms = 80): Promise<void> {
    await this.down(id, selector);
    await this.page.waitForTimeout(ms);
    await this.up(id);
  }
}

const input = (page: Page) => page.evaluate(() => window.__viewer.pad().input);

test.describe('walk mode on a phone, landscape', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: LANDSCAPE });

  test('the layout: flying keeps the lift buttons; walking swaps in the pad\'s positions and clears the HUD', async ({ page }) => {
    await phone(page, LANDSCAPE);
    // Flying: the touch UI as it was.
    await expect(page.locator('#touch-lift')).toBeVisible();
    await expect(page.locator('#touch-walk')).toBeHidden();
    await expect(page.locator('#rotate-hint')).toBeHidden();
    const flyFab = (await page.locator('#fullscreen').boundingBox())!;
    expect(flyFab.x).toBeGreaterThan(LANDSCAPE.width / 2);                       // bottom right, above the lift buttons
    // Walking.
    expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(true);
    await expect(page.locator('#tw-fire')).toBeVisible();
    await expect(page.locator('#touch-lift')).toBeHidden();
    await expect(page.locator('#touch-stance')).toBeHidden();
    await expect(page.locator('#touch-fire')).toBeHidden();
    await expect(page.locator('#rotate-hint')).toBeHidden();                      // sideways: nothing to ask
    const box = async (id: string) => (await page.locator(`#${id}`).boundingBox())!;
    const buttons = await page.locator('#touch-walk button').evaluateAll((els) => els.map((e) => e.id));
    expect(buttons).toHaveLength(14);
    // Everything is on the screen and clear of the HUD's bottom strip (the range and the timer) and of each other.
    const boxes = new Map<string, { x: number; y: number; width: number; height: number }>();
    for (const id of buttons) {
      const b = await box(id);
      boxes.set(id, b);
      expect(b.x, id).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width, id).toBeLessThanOrEqual(LANDSCAPE.width);
      expect(b.y, id).toBeGreaterThanOrEqual(0);
      expect(b.y + b.height, `${id} clears the HUD's bottom strip`).toBeLessThanOrEqual(LANDSCAPE.height - 40);
      expect(Math.min(b.width, b.height), `${id} is a target`).toBeGreaterThanOrEqual(36);
    }
    const hit = (a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean =>
      a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    for (const [i, a] of buttons.entries()) for (const c of buttons.slice(i + 1)) expect(hit(boxes.get(a)!, boxes.get(c)!), `${a} over ${c}`).toBe(false);
    // The pad's positions: Triangle over Cross, Square to their left, fire the largest and at the right edge.
    const t = boxes.get('tw-stance')!, s = boxes.get('tw-jump')!, x = boxes.get('tw-action')!, f = boxes.get('tw-fire')!;
    expect(t.y).toBeLessThan(x.y);
    expect(Math.abs(t.x - x.x)).toBeLessThan(1);
    expect(s.x).toBeLessThan(t.x);
    expect(f.width).toBeGreaterThan(t.width);
    expect(f.x + f.width).toBeGreaterThan(LANDSCAPE.width - 16);
    expect(f.x).toBeGreaterThan(t.x + t.width);
    // The fullscreen button has left the HUD's corner (the range readout) for the left edge, over the peeks.
    const fab = await box('fullscreen');
    expect(fab.x).toBeLessThan(40);
    for (const id of buttons) expect(hit(fab, boxes.get(id)!), `fullscreen over ${id}`).toBe(false);
    // The compass (top right) and the ammo box (bottom left) are the HUD's: none of the buttons sits on them.
    const hud = await page.evaluate(() => window.__viewer.hud());
    expect(hud).toBeTruthy();
    for (const id of buttons) {
      const b = boxes.get(id)!;
      expect(hit(b, { x: 0, y: LANDSCAPE.height - 70, width: 140, height: 70 }), `${id} over the ammo box`).toBe(false);
      expect(hit(b, { x: LANDSCAPE.width - 100, y: 34, width: 100, height: 80 }), `${id} over the compass`).toBe(false);
    }
    // Flying again brings the lift buttons back.
    await page.evaluate(() => window.__viewer.setMode('fly'));
    await expect(page.locator('#touch-lift')).toBeVisible();
    await expect(page.locator('#touch-walk')).toBeHidden();
  });

  test('each button does what its pad button does', async ({ page }) => {
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await phone(page, LANDSCAPE);
    await page.evaluate(() => window.__viewer.setMode('walk'));
    await page.waitForTimeout(500);
    const cdp = await page.context().newCDPSession(page);
    const fingers = new Fingers(cdp, page);

    // Square: the jump lane, held; a tap leaves the ground.
    await fingers.down(1, '#tw-jump');
    await expect.poll(async () => (await input(page)).jump).toBe(true);
    await fingers.up(1);
    await expect.poll(async () => (await input(page)).jump).toBe(false);
    await expect.poll(() => page.evaluate(() => window.__viewer.mover()!.airborne), { timeout: 3000 }).toBe(false);   // it has landed again

    // Triangle: a tap crouches, a tap again stands, a hold goes prone, a tap from prone stands.
    const stance = (): Promise<string> => page.evaluate(() => window.__viewer.stance());
    await fingers.tap(1, '#tw-stance', 100);
    await expect.poll(stance).toBe('crouch');
    await fingers.tap(1, '#tw-stance', 100);
    await expect.poll(stance).toBe('stand');
    await fingers.down(1, '#tw-stance');
    await expect.poll(stance, { timeout: 5000 }).toBe('prone');
    await fingers.up(1);
    await page.waitForTimeout(300);
    expect(await stance()).toBe('prone');
    await fingers.tap(1, '#tw-stance', 100);
    await expect.poll(stance).toBe('stand');

    // A tap shorter than a frame is still a press: quick taps on the action and the zoom register.
    await fingers.tap(1, '#tw-action', 1);
    // Fire: held, the rifle fires at its rate; let go, it stops.
    const shots = (): Promise<number> => page.evaluate(() => window.__viewer.fire().shots);
    const s0 = await shots();
    await fingers.down(1, '#tw-fire');
    await expect.poll(async () => (await input(page)).fire).toBe(true);
    await expect.poll(shots).toBeGreaterThan(s0);
    await fingers.up(1);
    await page.waitForTimeout(200);
    const s1 = await shots();
    await page.waitForTimeout(400);
    expect(await shots()).toBe(s1);

    // Fire and jump at once, by two fingers.
    await fingers.down(1, '#tw-fire');
    await fingers.down(2, '#tw-jump');
    await expect.poll(async () => { const i = await input(page); return i.fire && i.jump; }).toBe(true);
    await fingers.up();                                                        // both fingers, as the protocol ends them
    await expect.poll(async () => (await input(page)).fire).toBe(false);
    await expect.poll(() => page.evaluate(() => window.__viewer.mover()!.airborne), { timeout: 3000 }).toBe(false);

    // Reload: no lane, the R key's call: the magazine goes into its reload.
    await fingers.tap(1, '#tw-reload');
    await expect.poll(() => page.evaluate(() => window.__viewer.fire().magazine.reloading), { timeout: 3000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__viewer.fire().magazine.reloading), { timeout: 15000 }).toBe(false);

    // Zoom in, zoom in again, out: a step a tap, as d-pad Up and Down.
    const zoom = (): Promise<number> => page.evaluate(() => window.__viewer.zoom().state);
    const z0 = await zoom();
    await fingers.tap(1, '#tw-zoom-in', 1);
    await expect.poll(zoom).toBeGreaterThan(z0);
    const z1 = await zoom();
    await fingers.tap(1, '#tw-zoom-out', 60);
    await expect.poll(zoom).toBeLessThan(z1);
    await fingers.tap(1, '#tw-zoom-out', 60);
    await expect.poll(zoom).toBe(z0);

    // Fire mode steps as L3 does.
    const mode0 = await page.evaluate(() => window.__viewer.fireMode());
    await fingers.tap(1, '#tw-fire-mode', 60);
    await expect.poll(() => page.evaluate(() => window.__viewer.fireMode())).not.toBe(mode0);

    // The kit: RIFLE, M67, NEXT as L1, L2, R2.
    const item = (): Promise<string> => page.evaluate(() => window.__viewer.hud().model.weaponIcon);
    const rifle = await item();
    await fingers.tap(1, '#tw-swap2', 60);
    await expect.poll(item, { timeout: 5000 }).not.toBe(rifle);
    const m67 = await item();
    await fingers.tap(1, '#tw-inventory', 60);
    await expect.poll(item, { timeout: 5000 }).not.toBe(m67);
    await page.waitForTimeout(1500);
    await fingers.tap(1, '#tw-swap1', 60);
    await expect.poll(item, { timeout: 5000 }).toBe(rifle);

    // Peek, held, standing still: the side buttons.
    const peek = (): Promise<number> => page.evaluate(() => window.__viewer.traversal()?.peek ?? 0);
    await fingers.down(1, '#tw-peek-left');
    await expect.poll(peek, { timeout: 3000 }).toBeLessThan(0);
    await fingers.up(1);
    await expect.poll(peek, { timeout: 3000 }).toBe(0);
    await fingers.down(1, '#tw-peek-right');
    await expect.poll(peek, { timeout: 3000 }).toBeGreaterThan(0);
    await fingers.up(1);
    await expect.poll(peek, { timeout: 3000 }).toBe(0);

    // The action's lane, held.
    await fingers.down(1, '#tw-action');
    await expect.poll(async () => (await input(page)).action).toBe(true);
    await fingers.up(1);
    await expect.poll(async () => (await input(page)).action).toBe(false);

    expect(problems).toEqual([]);
  });

  test('a touch on the canvas does not throw, and the stick still looks and moves', async ({ page }) => {
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await phone(page, LANDSCAPE);
    await page.evaluate(() => window.__viewer.setMode('walk'));
    const yaw0 = (await page.evaluate(() => window.__viewer.pose())).yaw;
    const cdp = await page.context().newCDPSession(page);
    // A drag across the right half looks.
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 500, y: 200, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 420, y: 200, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(200);
    expect(Math.abs((await page.evaluate(() => window.__viewer.pose())).yaw - yaw0)).toBeGreaterThan(1);
    expect(problems).toEqual([]);
  });
});

test.describe('walk mode on a phone, portrait', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: PORTRAIT });

  test('asks for a turn while walking, and the buttons are still there', async ({ page }) => {
    await phone(page, PORTRAIT);
    await expect(page.locator('#rotate-hint')).toBeHidden();                      // flying: no ask
    await page.evaluate(() => window.__viewer.setMode('walk'));
    await expect(page.locator('#rotate-hint')).toBeVisible();
    await expect(page.locator('#rotate-hint')).toContainText('sideways');
    await expect(page.locator('#tw-fire')).toBeVisible();
    for (const id of await page.locator('#touch-walk button').evaluateAll((els) => els.map((e) => e.id))) {
      const b = (await page.locator(`#${id}`).boundingBox())!;
      expect(b.x, id).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width, id).toBeLessThanOrEqual(PORTRAIT.width);
      expect(b.y + b.height, id).toBeLessThanOrEqual(PORTRAIT.height);
    }
    await page.evaluate(() => window.__viewer.setMode('fly'));
    await expect(page.locator('#rotate-hint')).toBeHidden();
  });
});

test.describe('without ?redotcom&fly', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: LANDSCAPE });

  test('the phone has no walk layout, no hint, and the fly touch UI as it was', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#status')).toContainText(/triangles|tris/);
    for (const id of ['touch-walk', 'rotate-hint', 'tw-fire', 'tw-jump']) await expect(page.locator(`#${id}`)).toHaveCount(0);
    await expect(page.locator('#touch-lift')).toBeVisible();
    expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(false);
  });
});
