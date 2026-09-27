/**
 * Samples matching surfaces in a PS2 capture and in ours, so "too dark" becomes a ratio.
 *
 *   npx tsx tools/compare-to-ref.ts <ps2.png> <ours.png>
 *
 * The two shots are framed differently, so what is compared is not brightness at a pixel but the
 * *relation* between surfaces that face different ways: ground against wall is the number that says
 * the lighting has the right shape: the PS2 draws a vertical wall brighter than the ground, and
 * a rig that does not is wrong however bright it is overall.
 *
 * Decoding happens in Chromium rather than through an image library, so this needs no dependency the
 * repo does not already have.
 */
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const [refPath, oursPath] = process.argv.slice(2);
if (!refPath || !oursPath) {
  console.error('usage: npx tsx tools/compare-to-ref.ts <ps2.png> <ours.png>');
  process.exit(2);
}

/**
 * Patches as fractions of width/height, so the two resolutions do not have to match -- but the two
 * *framings* still do. These are set for one pair of shots; point the tool at a render from a
 * different pose and the patches land somewhere else, which shows up as a surface reading the fog
 * colour exactly. Re-aim them before believing a row.
 */
const PATCHES: Record<string, { ref: [number, number]; ours: [number, number] }> = {
  'ground (up-facing)': { ref: [0.47, 0.66], ours: [0.44, 0.85] },
  'silo body (vertical)': { ref: [0.36, 0.35], ours: [0.44, 0.42] },
  'right wall (vertical)': { ref: [0.73, 0.50], ours: [0.79, 0.62] },
  'sky': { ref: [0.12, 0.06], ours: [0.30, 0.06] },
  'wall facing away (dark)': { ref: [0.03, 0.42], ours: [0.30, 0.62] },
};
const R = 0.02;

const dataUrl = (p: string): string => `data:image/png;base64,${readFileSync(p).toString('base64')}`;

const browser = await chromium.launch();
const page = await browser.newPage();

const sample = async (p: string, points: [number, number][]): Promise<[number, number, number][]> =>
  page.evaluate(async (a) => {
    const img = new Image();
    img.src = a.url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const half = Math.round(Math.min(img.width, img.height) * a.r);
    const out: [number, number, number][] = [];
    for (const [fx, fy] of a.points) {
      const x = Math.max(0, Math.round(fx * img.width) - half);
      const y = Math.max(0, Math.round(fy * img.height) - half);
      const d = ctx.getImageData(x, y, half * 2, half * 2).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]!; g += d[i + 1]!; b += d[i + 2]!; }
      const n = d.length / 4;
      out.push([r / n, g / n, b / n]);
    }
    return out;
  }, { url: dataUrl(p), r: R, points });

const names = Object.keys(PATCHES);
const refs = await sample(refPath, names.map((n) => PATCHES[n]!.ref));
const ours = await sample(oursPath, names.map((n) => PATCHES[n]!.ours));
await browser.close();

const luma = ([r, g, b]: [number, number, number]): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const out: Record<string, { ref: number; ours: number }> = {};

names.forEach((name, i) => {
  out[name] = { ref: luma(refs[i]!), ours: luma(ours[i]!) };
  console.log(`${name.padEnd(24)} ps2 ${luma(refs[i]!).toFixed(1).padStart(6)}   ours ${luma(ours[i]!).toFixed(1).padStart(6)}`
    + `   ps2 rgb ${refs[i]!.map((v) => v.toFixed(0)).join(',').padStart(11)}   ours rgb ${ours[i]!.map((v) => v.toFixed(0)).join(',')}`);
});

const ratio = (a: string, b: string, which: 'ref' | 'ours'): number => out[a]![which] / out[b]![which];
console.log('\nthe relation between a surface facing up and one facing sideways:');
for (const wall of ['silo body (vertical)', 'right wall (vertical)']) {
  console.log(`  ground / ${wall.padEnd(22)}  ps2 ${ratio('ground (up-facing)', wall, 'ref').toFixed(2)}`
    + `   ours ${ratio('ground (up-facing)', wall, 'ours').toFixed(2)}`);
}
