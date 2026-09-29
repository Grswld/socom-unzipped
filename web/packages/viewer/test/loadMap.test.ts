import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsAssetSource } from '@s2u/archive/node';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { loadMap, type LoadedMap } from '../src/loadMap';

/**
 * The draw order a map carries out of `loadMap`, which is the order the engine drew it in.
 *
 * reCOM's `CPipe::RenderNode` (`zRender/zrndr_pipe.cpp`) walks the scene graph depth first, draws each
 * node's visuals as it reaches them, and defers only a node whose opacity is under 1 -- it sorts
 * nothing. So every drawn part records where in that walk it fell (`order`), and the merge that turns
 * hundreds of world packets into a few dozen draws must not let an opaque draw straddle a blended one,
 * or the blended surface would be drawn before or after geometry the hardware drew on the other side.
 */
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures');
const absent = fixture('RUN/MP6.ZDB') === null;

const load = (path: string): Promise<LoadedMap> => loadMap(new FsAssetSource(FIXTURES), path);

describe.skipIf(absent)(`the draw order out of loadMap${absent ? ` (${FIXTURES_ABSENT})` : ''}`, () => {
  it.skipIf(absent)('every world draw and every prop carries a place in the scene walk, and the lists are in that order', async () => {
    const map = await load('RUN/MP6.ZDB');
    const orders = map.world.map((m) => m.order);
    expect(orders.every((o) => Number.isFinite(o) && o >= 0)).toBe(true);
    for (let i = 1; i < orders.length; i++) expect(orders[i]).toBeGreaterThan(orders[i - 1]!);
    for (const m of map.world) expect(m.orderEnd).toBeGreaterThanOrEqual(m.order);
    const props = map.props.map((p) => p.order);
    for (let i = 1; i < props.length; i++) expect(props[i]).toBeGreaterThan(props[i - 1]!);
  });

  it.skipIf(absent)('a blended world part keeps its own draw, and no opaque draw straddles one', async () => {
    const map = await load('RUN/MP72.ZDB');
    const blended = map.world.filter((m) => {
      const f = m.textureName === null ? undefined : map.textureFlags[m.textureName];
      return (f?.graded ?? false) && !(f?.opaque ?? true);
    });
    expect(blended.length).toBeGreaterThan(0);
    for (const b of blended) expect(b.orderEnd).toBe(b.order);
    for (const a of map.world) {
      if (a.orderEnd === a.order) continue;
      for (const b of blended) expect(b.order > a.order && b.order < a.orderEnd, `${a.textureName} straddles ${b.textureName}`).toBe(false);
    }
  });

  it.skipIf(absent)('every draw carries its cull flag and its state, the alternate states are the ones the game switches to', async () => {
    const map = await load('RUN/MP72.ZDB');            // Crossroads: destructible crates, lamps with an unlit copy
    const draws = [...map.world, ...map.props.flatMap((p) => p.parts)];
    expect(draws.some((m) => m.cull)).toBe(true);
    expect(draws.some((m) => !m.cull)).toBe(true);
    const alternate = map.props.filter((p) => p.alternate);
    expect(alternate.length).toBeGreaterThan(0);
    expect(map.props.filter((p) => !p.alternate).length).toBeGreaterThan(alternate.length);
  });

  it.skipIf(absent)('every placement of a prop is drawn with its own context\'s prelit colours, not the first one\'s', async () => {
    // Frostfire's tank rails: one model, seventeen placements, a chunk per placement whose baked light differs
    // (`N000_I001`..`I017`). Drawing the first member's chunk at every matrix drew the prototype's own bare
    // material colour -- (128, 109, 35), unity red -- on all seventeen, twice to three times the prelit rails
    // around them. Each placement must carry the colours of its own chunk.
    const map = await load('RUN/MP2.ZDB');
    const rails = map.props.filter((p) => p.modelName === 'tankrailbarshi');
    expect(rails.reduce((n, p) => n + p.matrices.length / 16, 0)).toBe(17);
    const meanRed = (c: Float32Array): number => { let s = 0; for (let i = 0; i < c.length; i += 4) s += c[i]!; return (s / (c.length / 4)) * 128; };
    for (const p of rails) for (const part of p.parts) expect(meanRed(part.colors)).toBeLessThan(64);
    // And each its own: the seventeen chunks' baked light takes a dozen distinct values, one per placement.
    const drawn = rails.flatMap((p) => Array.from({ length: p.matrices.length / 16 }, () => meanRed(p.parts[0]!.colors).toFixed(2)));
    expect(new Set(drawn).size).toBeGreaterThanOrEqual(10);
    // The supports (24 placements): no world placement is drawn with a bare prototype context's unity colour.
    const supports = map.props.filter((p) => p.modelName === 'tankrailsupport');
    expect(supports.reduce((n, p) => n + p.matrices.length / 16, 0)).toBe(24);
    for (const p of supports) for (const part of p.parts) expect(meanRed(part.colors)).toBeLessThan(100);
  });

  it.skipIf(absent)('the LOD pairs of the Frostfire railings carry their bands, and the facades and scrolls are marked', async () => {
    const map = await load('RUN/MP2.ZDB');
    // `railings_low` fades in at 100-120 units where `railings_high` fades out; the graph places both
    // sets on the same rails (10 placements each). `grate_lowlod` is in the table but never placed.
    const by = (name: string) => map.props.filter((p) => p.modelName === name);
    expect(by('railstraitlo1').length).toBeGreaterThan(0);
    expect(by('railstraitlo1').every((p) => p.lod?.nearFade[0] === 100 && p.lod.farFade[1] === 440)).toBe(true);
    expect(by('railstraithi1').length).toBe(by('railstraitlo1').length);
    expect(by('railstraithi1').every((p) => p.lod?.nearFade[0] === 0 && p.lod.farFade[0] === 100)).toBe(true);
    expect(by('railstraitlo1').every((p) => !p.alternate)).toBe(true);   // a LOD copy is not a state
    // The copies of one object share a placement: every low rail stands within 5 units of a high rail,
    // which is what lets `world.ts` tell a copy with a successor from the last one at its spot. The
    // grate has no low copy placed at all, so past 360 units it is the last one and stays.
    const spots = (name: string): [number, number, number][] => by(name).flatMap((p) => {
      const out: [number, number, number][] = [];
      for (let i = 0; i < p.matrices.length; i += 16) out.push([p.matrices[i + 12]!, p.matrices[i + 13]!, p.matrices[i + 14]!]);
      return out;
    });
    const near = (a: [number, number, number], b: [number, number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 5;
    const highs = spots('railstraithi1');
    expect(spots('railstraitlo1').every((lo) => highs.some((hi) => near(lo, hi)))).toBe(true);
    expect(by('grate_midlod').length).toBeGreaterThan(0);
    expect(by('grate_lowlod').length).toBe(0);
    expect(map.props.filter((p) => p.lod === null).length).toBeGreaterThan(map.props.filter((p) => p.lod !== null).length);
    // The facade flag reaches the props; the scroll bands reach the world chunks they name.
    expect(map.props.some((p) => p.facade !== 0)).toBe(true);
    const scrolled = map.world.filter((m) => m.scroll !== null);
    expect(scrolled.length).toBeGreaterThan(0);
    expect(scrolled.every((m) => m.orderEnd === m.order || m.scroll !== null)).toBe(true);
  });

  it.skipIf(absent)('the line strips come out grouped by texture and fog, with a uv per point and a place in the walk', async () => {
    const map = await load('RUN/MP6.ZDB');           // Desert Glory: power lines, lamp brackets, the cuffs
    expect(map.lines).not.toBeNull();
    const groups = map.lines!;
    expect(groups.length).toBeGreaterThan(1);
    const keys = new Set(groups.map((g) => `${g.textureName}|${g.fog}`));
    expect(keys.size).toBe(groups.length);
    for (const g of groups) {
      const points = g.positions.length / 3;
      expect(points % 2).toBe(0);                       // two points a segment
      expect(g.uvs.length).toBe(points * 2);
      expect(g.colors.length).toBe(points * 4);
      expect(g.normals.length).toBe(points * 3);
      expect(Number.isFinite(g.order)).toBe(true);
    }
    expect(groups.some((g) => g.textureName !== null)).toBe(true);
  });
});

/**
 * Night Stalker (MP7) stores its tent and table chunks under `<key>_L` only, the name `hookupVisuals`
 * gives a dynamically lit node (`vis_main.cpp:93-102`). None of the three committed fixtures has such a
 * key, so this reads the served copy `npm run extract-maps` writes to the git-ignored `public/maps`, and
 * skips where it is absent (CI). `resolveChunk`'s own test covers the rule without a disc.
 */
const MAPS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../public/maps');
const noMp7 = !existsSync(resolve(MAPS, 'RUN/MP7.ZDB'));

describe.skipIf(noMp7)(`the _L chunks out of loadMap${noMp7 ? ' (public/maps absent: run npm run extract-maps)' : ''}`, () => {
  it.skipIf(noMp7)('Night Stalker draws its tent_seals and seal_table chunks, lit, and reports no missing chain', async () => {
    const map = await loadMap(new FsAssetSource(MAPS), 'RUN/MP7.ZDB');
    expect(map.diagnostics.filter((d) => d.includes('no such chain'))).toEqual([]);
    // The `_L` chunks: tent_seals N001 and N011 (one context), seal_table N000 in both of its contexts,
    // N003 and N005 in the first, N004 in the second -- the suffix is per context, so a lit context is a
    // prop group of its own. Each lit group was drawn from no chain or an unlit one before; every part
    // of it is lit now, and the plain groups are not.
    for (const [name, litNodes] of [['tent_seals', 2], ['seal_table', 4]] as const) {
      const groups = map.props.filter((p) => p.modelName === name);
      const lit = groups.filter((p) => p.parts.some((m) => m.lit));
      expect(lit.length).toBe(litNodes);
      for (const p of lit) expect(p.parts.every((m) => m.lit)).toBe(true);
      expect(groups.length).toBeGreaterThan(litNodes);
    }
  });
});
