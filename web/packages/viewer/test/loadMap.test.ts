import { describe, expect, it } from 'vitest';
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
