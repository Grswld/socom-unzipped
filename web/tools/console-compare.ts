/**
 * The viewer beside a console frame, from the console's own camera, in the PS2 presentation -- and a pixel diff.
 *
 *   npx tsx tools/console-compare.ts <out-dir> [--map M51] [--ref ../scripts/parity/refs/console_spawn_slot8.png]
 *                                    [--eye x,y,z] [--target x,y,z] [--toggles a,b] [--off a,b]
 *
 * The default pose is the console's spawn dump behind `console_spawn_slot8.png` (research 17 §1: the placed eye
 * `cam+0xd8` 939.439, -126.264, 832.160 and the look-at target `cam+0x38` 939.439, -130.489, 858.341, read off
 * `logs/parity/spawn_pcsx2.rdram`). That frame is the campaign's first mission (Seeding Chaos, `RUN/M51.ZDB`), not a
 * multiplayer map: it is the one console frame whose camera is known to the unit, and M51 is built from the same
 * formats, so the viewer reads it as it reads the MP archives. The served tree holds only the 22 MP archives, so the
 * mission archive is routed in from the disc (`SOCOM_DISC`, default `C:/projects/socom_pc/game/disc`) and added to the
 * map list for this page only -- nothing is written under `public/`.
 *
 * Writes `<out>/ours.png` (the viewer's 640x448 frame), `<out>/ref.png`, `<out>/side.png` (the two side by side and
 * the diff under them) and `<out>/diff.json` (mean absolute error per channel, overall and per band of rows, and the
 * mean colour of each band in both). The HUD and the SEAL are in the console frame and not in ours; the bands say
 * where the difference lives.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
if (!out) {
  console.error('usage: npx tsx tools/console-compare.ts <out-dir> [--map M51] [--ref png] [--eye x,y,z] [--target x,y,z]');
  process.exit(2);
}
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const vec = (s: string): [number, number, number] => s.split(',').map(Number) as [number, number, number];

const map = opt('map', 'M51').toUpperCase();
const refPath = resolve(opt('ref', join(import.meta.dirname, '../../scripts/parity/refs/console_spawn_slot8.png')));
const eye = vec(opt('eye', '939.439,-126.264,832.160'));
const target = vec(opt('target', '939.439,-130.489,858.341'));
const toggles = opt('toggles', '').split(',').filter(Boolean);
const off = opt('off', '').split(',').filter(Boolean);
/** `--slider brighten=0,fogfar=900`: panel sliders set before the shot. */
const sliders = opt('slider', '').split(',').filter(Boolean).map((kv) => kv.split('=') as [string, string]);
const disc = process.env.SOCOM_DISC ?? 'C:/projects/socom_pc/game/disc';
const url = process.env.VIEWER_URL ?? 'http://localhost:5173/';
mkdirSync(out, { recursive: true });

const dx = target[0] - eye[0], dy = target[1] - eye[1], dz = target[2] - eye[2];
const pose = {
  x: eye[0], y: eye[1], z: eye[2],
  yaw: (Math.atan2(-dx, -dz) * 180) / Math.PI,            // the viewer's camera looks down its own -z (camera.ts)
  pitch: (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI,
};

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  executablePath: process.env.PW_CHROMIUM || undefined,
});
// 640x480 CSS is the 4:3 box the PS2 presentation stretches its 640x448 frame onto.
const context = await browser.newContext({ viewport: { width: 640, height: 480 } });
const errors: string[] = [];
// tsx keeps function names with an `__name` helper the page does not have; give the page one.
await context.addInitScript('globalThis.__name = (f) => f');

const zdb = join(disc, 'RUN', `${map}.ZDB`);
if (!/^MP\d+$/.test(map)) {
  if (!existsSync(zdb)) throw new Error(`${zdb} not found (SOCOM_DISC)`);
  await context.route('**/maps/index.json', async (route) => {
    const res = await route.fetch();
    const index = await res.json() as { maps: { archive: string; path: string; name: string }[] };
    index.maps.push({ archive: map, path: `RUN/${map}.ZDB`, name: map });
    await route.fulfill({ response: res, json: index });
  });
  await context.route(`**/maps/RUN/${map}.ZDB`, (route) =>
    route.fulfill({ status: 200, body: readFileSync(zdb), contentType: 'application/octet-stream' }));
}

const page = await context.newPage();
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${url}?map=${map}`);
await page.waitForFunction((m) => document.querySelector('#status')?.textContent?.includes(`(${m})`), map, { timeout: 120_000 });

const setBox = (id: string, on: boolean) => page.evaluate(([i, v]) => {
  const box = document.getElementById(i as string) as HTMLInputElement | null;
  if (!box) throw new Error(`no toggle #${i}`);
  if (box.checked !== v) { box.checked = v as boolean; box.dispatchEvent(new Event('change', { bubbles: true })); }
}, [id, on] as const);
await setBox('ps2look', true);
for (const t of toggles) await setBox(t, true);
for (const t of off) await setBox(t, false);
for (const [id, value] of sliders) {
  await page.evaluate(([i, v]) => {
    const input = document.getElementById(i!) as HTMLInputElement | null;
    if (!input) throw new Error(`no slider #${i}`);
    input.value = v!; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
  }, [id, value]);
}
await page.evaluate((p) => {
  document.body.classList.add('chrome-hidden');
  (window as unknown as { __viewer: { setCamera(v: Record<string, number>): void } }).__viewer.setCamera(p);
}, pose);
// The props arrive a few per frame (scheduler.ts); give them time to land.
for (let i = 0; i < 90; i++) await page.evaluate(() => new Promise<void>((d) => requestAnimationFrame(() => d())));

const stats = await page.evaluate(() => (window as unknown as { __viewer: { stats(): unknown } }).__viewer.stats());
const shot = await page.locator('#view').screenshot();

const result = await page.evaluate(async ({ ours, ref }) => {
  const load = async (u: string): Promise<ImageData> => {
    const img = new Image();
    img.src = u;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 640; c.height = 448;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, 640, 448);
    return ctx.getImageData(0, 0, 640, 448);
  };
  const a = await load(ours);
  const b = await load(ref);
  const W = 640, H = 448;
  const side = document.createElement('canvas');
  side.width = W * 2; side.height = H * 2;
  const s = side.getContext('2d')!;
  s.putImageData(a, 0, 0);
  s.putImageData(b, W, 0);
  const diff = s.createImageData(W, H);
  const signed = s.createImageData(W, H);
  const bands = 8;
  const acc = Array.from({ length: bands }, () => ({ n: 0, err: [0, 0, 0], ours: [0, 0, 0], ref: [0, 0, 0] }));
  let total = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    const band = acc[Math.floor((y * bands) / H)]!;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let lumA = 0, lumB = 0;
      for (let k = 0; k < 3; k++) {
        const e = Math.abs(a.data[i + k]! - b.data[i + k]!);
        band.err[k]! += e; total[k]! += e;
        band.ours[k]! += a.data[i + k]!; band.ref[k]! += b.data[i + k]!;
        diff.data[i + k] = Math.min(255, e * 3);
        lumA += a.data[i + k]!; lumB += b.data[i + k]!;
      }
      band.n++;
      // Signed luma: red where ours is brighter, blue where the console is.
      const d = (lumA - lumB) / 3;
      signed.data[i] = d > 0 ? Math.min(255, d * 4) : 0;
      signed.data[i + 2] = d < 0 ? Math.min(255, -d * 4) : 0;
      signed.data[i + 1] = 0;
      diff.data[i + 3] = 255; signed.data[i + 3] = 255;
    }
  }
  s.putImageData(diff, 0, H);
  s.putImageData(signed, W, H);
  const n = W * H;
  const r = (v: number[], m: number) => v.map((x) => Math.round((x / m) * 10) / 10);
  return {
    side: side.toDataURL('image/png'),
    ours: (() => { const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d')!.putImageData(a, 0, 0); return c.toDataURL('image/png'); })(),
    mae: r(total, n),
    bands: acc.map((b, i) => ({ rows: `${Math.round((i * H) / bands)}-${Math.round(((i + 1) * H) / bands) - 1}`, mae: r(b.err, b.n), ours: r(b.ours, b.n), ref: r(b.ref, b.n) })),
  };
}, { ours: `data:image/png;base64,${shot.toString('base64')}`, ref: `data:image/png;base64,${readFileSync(refPath).toString('base64')}` });

const png = (d: string) => Buffer.from(d.replace(/^data:image\/png;base64,/, ''), 'base64');
writeFileSync(join(out, 'side.png'), png(result.side));
writeFileSync(join(out, 'ours.png'), png(result.ours));
writeFileSync(join(out, 'ref.png'), readFileSync(refPath));
writeFileSync(join(out, 'diff.json'), JSON.stringify({ map, pose, mae: result.mae, bands: result.bands, errors, stats }, null, 2));
console.log(`${map} pose ${JSON.stringify(pose)}\nMAE rgb ${result.mae.join(', ')}`);
for (const b of result.bands) console.log(`rows ${b.rows.padEnd(8)} mae ${b.mae.join(',').padEnd(16)} ours ${b.ours.join(',').padEnd(18)} ref ${b.ref.join(',')}`);
if (errors.length) console.log('PAGEERRORS:', errors.slice(0, 3));
await browser.close();
