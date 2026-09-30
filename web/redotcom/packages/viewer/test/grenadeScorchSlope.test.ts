import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BufferAttribute } from 'three';
import { FsAssetSource } from '@s2u/archive/node';
import { gridCast, type V3 } from '@s2u/scene';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { GrenadeThrower } from '../src/grenade';
import { GRENADE_BITMAPS } from '../src/grenadeAssets';
import { loadMap } from '../src/loadMap';
import { MarkClipper } from '../src/markClip';
import { groundGrid, type PlaySnapshot } from '../src/walk';
import { buildWorld } from '../src/world';

/**
 * The grenade's scorch on a slope (web/redotcom/docs/research/85 §7.3, 89 §15). The game's explosion (`FUN_003c7af0`, decomp
 * 318876) probes a vertical column under the blast (`FUN_0031df50(10.0, world, pos)`: a type-2 `DiIntersect` at the
 * blast's x and z), takes the highest candidate no more than 10 units above the blast (`FUN_002d4c20`), and hands that
 * record -- `point, t, normal, node` -- to `FUN_003d0ba0`, which frames the decal along its normal negated (323891,
 * `FUN_00307810`). So the scorch lies flat on the ground under the blast, whatever the slope. Projected straight down
 * instead, a big sloped triangle's far vertices pass the 4.8-unit depth test and the scorch is dropped whole: the bare
 * square at unity.
 *
 * Desert Glory's `g157` hillside at z 1700 (x 1010 -> 1040, y 36 -> 59, about 39 degrees), the traversal tests' slope.
 */
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures');
const MP6 = fixture('RUN/MP6.ZDB');

describe.skipIf(!MP6)(`the scorch on a sloped hillside${MP6 ? '' : ` (${FIXTURES_ABSENT})`}`, () => {
  it('MP6 g157 (about 39 degrees): a claymore\'s blast there clips to the drawn ground and takes its colour', async () => {
    const map = await loadMap(new FsAssetSource(FIXTURES), 'RUN/MP6.ZDB');
    const built = buildWorld(map);
    for (const task of [...built.revealWorld, ...built.revealProps]) task();
    built.group.updateMatrixWorld(true);
    const grid = groundGrid(map.ground!);
    const cast = gridCast(grid);
    const clipper = new MarkClipper(built.group);
    let steep = 0;
    for (const x of [1015, 1020, 1025, 1030, 1035]) {
      const hit = cast([x, 200, 1700], [x, -100, 1700])[0]!;
      expect(hit).toBeDefined();
      const ny = Math.abs(hit.normal[1]) / Math.hypot(...hit.normal);
      if (Math.acos(ny) > (25 * Math.PI) / 180) steep++;
      const feet: V3 = [hit.point[0] - 4, hit.point[1], hit.point[2]];
      const snap = (): PlaySnapshot => ({
        feet, yaw: 0, pitch: 0, vx: 0, vz: 0, vy: 0, airborne: false, crouched: false, stance: 'stand', landing: null, jumps: 0,
      } as PlaySnapshot);
      const g = new GrenadeThrower({ grid: () => grid, snapshot: snap, view: () => 'third', handPoint: () => [x, hit.point[1] + 8, 1700] });
      g.setMap(null, { models: [], bitmaps: { [GRENADE_BITMAPS.scorch]: { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(128) } }, defaultMaterial: '' });
      g.setClip(clipper);
      g.select('Claymore');
      g.pull();
      for (let t = 0; t < 1.5; t += 1 / 60) g.update(1 / 60);
      expect(g.detonateCharges()).toBe(1);
      for (let t = 0; t < 0.1; t += 1 / 60) g.update(1 / 60);
      expect(g.scorchMeshes()).toHaveLength(1);
      const geometry = g.scorchMeshes()[0]!.geometry;
      // Clipped (`markClip` keeps triangles), not the bare square of `squareInto` at unity: the scorch's colour is the
      // drawn ground's, under unity.
      const shade = g.stats().scorchShade;
      expect(shade, `x ${x}: the scorch was dropped whole (the bare square)`).not.toBeNull();
      for (const v of shade!.slice(0, 3)) { expect(v).toBeGreaterThan(0); expect(v).toBeLessThan(0.99); }
      const colour = geometry.getAttribute('color') as BufferAttribute;
      expect(colour.getX(0)).toBeLessThan(0.99);
      expect(geometry.drawRange.count).toBeGreaterThan(0);
    }
    expect(steep).toBeGreaterThan(0);
  }, 120_000);
});
