import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Scene } from 'three';
import { FsAssetSource } from '@s2u/archive/node';
import { materialTable, spawnsFor } from '@s2u/scene';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { FlyCamera } from '../src/camera';
import { effectsFromDisc } from '../src/effectData';
import { Effects } from '../src/effects';
import { Fire } from '../src/fire';
import { loadMap } from '../src/loadMap';
import { MarkClipper } from '../src/markClip';
import { openingStand } from '../src/stand';
import { WalkMode } from '../src/walk';
import { buildWorld } from '../src/world';
import { surfaceShade } from '../src/surfaceShade';

/**
 * The clipped mark on the game's own maps, wired as `main.ts` wires it (research 89 §13-§14): the map's built group, every
 * world and prop draw revealed, `new MarkClipper(built.group)`, the Fire with `decals.rdr`'s marks and the SOILS'
 * penetration, the walk stood at spawn A, the camera turned as `e2e/effects.spec.ts` ("the marks take the colour of
 * the wall they are on") turns it. The synthetic worlds of `markClip.test.ts` are small triangles square to the round;
 * the maps' walls are 15-20 unit triangles hit at a slant.
 *
 * The regression (2026-09-29, the page): every `lastShade` null, the bare square at unity -- the whole container side
 * dropped by the 4.8 test, its far vertex 4.88 units along the round from the plane square to the round. The game's
 * projection (`FUN_003d0ba0` 323919 hands `FUN_003139e0` the hit record's +0x10 negated -- the hit polygon's normal, the
 * record `point, t, normal, node` -- and `FUN_00307810` looks along that same vector, choosing its up by it) is along
 * the surface normal: a flat wall lies at depth 0 whatever its size and whatever the round's slant.
 */
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures');
const absent = fixture('RUN/MP2.ZDB') === null || fixture('RUN/MP6.ZDB') === null;
const PENETRATION = new Map(materialTable().map((m) => [m.name, m.penetration]));

async function rig(stem: string, name: string) {
  const src = new FsAssetSource(FIXTURES);
  const map = await loadMap(src, `RUN/${stem}.ZDB`);
  const built = buildWorld(map);
  const scene = new Scene();
  scene.add(built.group);
  for (const task of [...built.revealWorld, ...built.revealProps]) task();
  scene.updateMatrixWorld(true);
  const data = await effectsFromDisc(src, `RUN/${stem}.ZDB`, stem);
  const effects = new Effects(() => 0.5, () => {});
  effects.setData({ ...data, ambient: [] });
  const spawn = spawnsFor(name)!;
  const stand = map.stand ?? openingStand(spawn.a, undefined);
  const fly = new FlyCamera(document.createElement('canvas'));
  fly.lookFrom(stand.position, spawn.b);
  const walk = new WalkMode(fly);
  walk.setGround(map.ground, [spawn.a[0], stand.floor ?? spawn.a[1], spawn.a[2]]);
  expect(walk.setMode('walk')).toBe(true);
  walk.walkFor(0.4, { forward: 0, right: 0, boost: false });
  let r = 0;
  const fire = new Fire({ grid: () => walk.grid(), aim: () => walk.fireAim() }, undefined, undefined, () => ((r = (r * 9301 + 49297) % 233280) / 233280));
  fire.setMarks(effects.marks());
  fire.setPenetration((byte) => {
    const n = byte === undefined ? undefined : effects.materialName(byte);
    return n ? (PENETRATION.get(n) ?? 0) : 0;
  });
  fire.setClip(new MarkClipper(built.group));
  return { walk, fire, shade: surfaceShade(built.group) };
}

describe.skipIf(absent)(`the clipped mark on the maps, as the page builds it${absent ? ` (${FIXTURES_ABSENT})` : ''}`, () => {
  const cases = [
    { stem: 'MP2', name: 'FROSTFIRE', what: 'Frostfire\'s container (METAL_THICK)', yaw: 100, pitch: -3, material: 25, shade: [0.508, 0.508, 0.523] },
    { stem: 'MP6', name: 'DESERT GLORY', what: 'Desert Glory\'s stone wall', yaw: 40, pitch: -5, material: 7, shade: [0.126, 0.123, 0.11] },
  ];
  for (const c of cases) {
    it(`clips to ${c.what} hit at a slant and takes its colour, round after round`, async () => {
      const { walk, fire, shade } = await rig(c.stem, c.name);
      for (let i = 0; i < 4; i++) {
        walk.setCamera({ yaw: c.yaw + i * 2.5 - 3.75, pitch: c.pitch });
        // The e2e's `settle`: the look turns over the frames after `setCamera`.
        walk.walkFor(0.25, { forward: 0, right: 0, boost: false });
        fire.update(1);
        const shot = fire.shoot();
        expect(shot?.hit).not.toBeNull();
        const f = fire.state();
        expect(f.lastHit?.material).toBe(c.material);
        expect(f.lastShade).not.toBeNull();
        f.lastShade!.slice(0, 3).forEach((v, k) => expect(v).toBeCloseTo(c.shade[k]!, 2));
        expect(f.lastShade![3]).toBeCloseTo(1, 6);
        // The same colour the probe along the normal reads there (`surfaceShade`, the page's single shade before the clip).
        shade(f.lastHit!.point, f.lastHit!.normal)!.forEach((v, k) => expect(f.lastShade![k]).toBeCloseTo(v, 5));
        // Clipped, not the bare square: the mark lies on the wall's triangles (`markClip`), not the two of `squareInto`.
        const mark = fire.decalMeshes().find((m) => m.visible && m.position.toArray().every((v, k) => Math.abs(v - f.lastHit!.point[k]!) < 1e-9))!;
        const colour = mark.geometry.getAttribute('color');
        expect(colour.getX(0)).toBeCloseTo(c.shade[0]!, 1);
      }
    }, 60_000);
  }
});
