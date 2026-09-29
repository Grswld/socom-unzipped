import { describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsAssetSource } from '@s2u/archive/node';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { loadMap } from '../src/loadMap';
import { groundGrid, Walker, type WalkInput } from '../src/walk';
import { loadSimClips, loadSimMap, SIM_CLIPS, Traversal, groundPolygons } from '../src/sim';

/**
 * The server's map (web sprint 3, M2): `loadSimMap` reads the same hull `loadMap` packs for the page's walk, and the
 * mover on it takes the same steps, bit for bit, from the same inputs -- the precondition for prediction to agree
 * with the server with no correction at all.
 */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures');
const MP2 = fixture('RUN/MP2.ZDB'), PACK = fixture('RUN/MOTION_P.ZAR');

/** Ten seconds of scripted play: runs, strafes, a turn a tick, stance changes and jumps at fixed ticks. */
function script(w: Walker): number[] {
  const trace: number[] = [];
  for (let t = 0; t < 600; t++) {
    const input: WalkInput = {
      forward: t < 200 ? 1 : t < 300 ? -0.5 : t < 450 ? 0.7 : 0,
      right: t >= 200 && t < 350 ? 0.8 : t > 500 ? -1 : 0,
      boost: false,
    };
    w.state.yaw += t < 300 ? 0.4 : -0.3;
    if (t === 120 || t === 400) w.jump();
    if (t === 250) w.changeStance('crouch');
    if (t === 330) w.changeStance('stand');
    if (t === 480) w.changeStance('prone');
    if (t === 560) w.changeStance('stand');
    w.tick(input);
    trace.push(w.state.x, w.state.y, w.state.z, w.state.vx, w.state.vy, w.state.vz);
  }
  return trace;
}

describe.skipIf(!MP2 || !PACK)(`the server's Frostfire${MP2 && PACK ? '' : ` (${FIXTURES_ABSENT})`}`, () => {
  it('is the page\'s hull: the same polygons, fields, nodes and grid', async () => {
    const source = new FsAssetSource(FIXTURES);
    const [page, sim] = await Promise.all([loadMap(source, 'RUN/MP2.ZDB'), loadSimMap(source, 'RUN/MP2.ZDB')]);
    expect(sim.name).toBe('FROSTFIRE');
    expect(groundPolygons(sim.ground).length).toBe(3318);
    expect(sim.ground.grid).toEqual(page.ground!.grid);
    expect(sim.ground.owners).toEqual(page.ground!.owners);
    expect(Buffer.from(sim.ground.points.buffer).equals(Buffer.from(page.ground!.points.buffer))).toBe(true);
    expect(Buffer.from(sim.ground.fields.buffer).equals(Buffer.from(page.ground!.fields.buffer))).toBe(true);
    expect(sim.slots.length).toBeGreaterThan(0);
    expect(new Set(sim.slots.map((s) => s.side))).toEqual(new Set([0, 1]));
    expect(sim.respawns.length).toBeGreaterThan(sim.slots.length);   // Frostfire: hundreds of twins (research 75 §5.5)
  });

  it('walks ten scripted seconds on it bit for bit as the page\'s mover does, with the clips\' root motion and the moves', async () => {
    const source = new FsAssetSource(FIXTURES);
    const [page, sim, clips] = await Promise.all([loadMap(source, 'RUN/MP2.ZDB'), loadSimMap(source, 'RUN/MP2.ZDB'), loadSimClips(source)]);
    // One traversal name has no clip in the pack (the page asks for it too, and its moves fall back the same way).
    expect(clips.clips.length).toBeGreaterThanOrEqual(SIM_CLIPS.length - 1);
    const make = (grid: ReturnType<typeof groundGrid>, polys: ReturnType<typeof groundPolygons>): Walker => {
      const w = new Walker(grid);
      w.actionRoots = clips.roots;
      const moves = new Traversal(grid, polys);
      moves.setClips(clips.clips, clips.table);
      w.driver = moves;
      expect(w.place(796, 115.4, 614)).toBe(true);
      return w;
    };
    const a = script(make(groundGrid(page.ground!), groundPolygons(page.ground!)));
    const b = script(make(sim.grid, groundPolygons(sim.ground)));
    expect(b).toEqual(a);
    // It went somewhere: the script is not a stand-still.
    expect(Math.hypot(a[a.length - 6]! - 796, a[a.length - 4]! - 614)).toBeGreaterThan(50);
  });
});
