import { describe, expect, it } from 'vitest';
import { Group, Scene } from 'three';
import { createWorldSwap, type SwappableWorld } from '../src/worldSwap';

/**
 * The map switch's bookkeeping (`../src/worldSwap`, the release review's MJ-3): a switch made while the previous one is
 * still preparing (the disc opened during a load) must not leave the older map drawn and undisposed.
 */

function world(name: string): SwappableWorld & { disposed: number; name: string } {
  const group = new Group();
  group.name = name;
  const w = { name, group, disposed: 0, dispose: () => { w.disposed++; } };
  return w;
}

function up(scene: Scene, w: SwappableWorld): void {
  scene.add(w.group);
}

describe('createWorldSwap', () => {
  it('the normal switch: B up, A waits for B\'s first meshes, then goes', () => {
    const scene = new Scene();
    const swap = createWorldSwap<ReturnType<typeof world>>(scene);
    const a = world('A'), b = world('B');
    swap.begin(a); up(scene, a);
    swap.retirePrevious(a);                                     // nothing before A: nothing goes
    swap.begin(b); up(scene, b);
    expect(scene.children).toEqual([a.group, b.group]);         // both drawn while B prepares (no blank frame)
    swap.retirePrevious(b);
    expect(scene.children).toEqual([b.group]);
    expect(a.disposed).toBe(1);
    expect(b.disposed).toBe(0);
    expect(swap.current()).toBe(b);
    expect(swap.waiting()).toBeNull();
  });

  it('an interrupted switch: C over B\'s prepare takes A down at once, B waits for C, and nothing is left behind', () => {
    const scene = new Scene();
    const swap = createWorldSwap<ReturnType<typeof world>>(scene);
    const a = world('A'), b = world('B'), c = world('C');
    swap.begin(a); up(scene, a);
    swap.begin(b); up(scene, b);                                // B's prepare never finishes: no retirePrevious(b)
    swap.begin(c); up(scene, c);
    expect(scene.children).toEqual([b.group, c.group]);         // at most two worlds in the scene
    expect(a.disposed).toBe(1);
    expect(b.disposed).toBe(0);
    swap.retirePrevious(b);                                     // B's stale closure: overtaken, does nothing
    expect(b.disposed).toBe(0);
    swap.retirePrevious(c);
    expect(scene.children).toEqual([c.group]);
    expect([a.disposed, b.disposed, c.disposed]).toEqual([1, 1, 0]);
    swap.retirePrevious(c);                                     // again: nothing more goes
    expect([a.disposed, b.disposed, c.disposed]).toEqual([1, 1, 0]);
  });

  it('a run of interrupted switches disposes every world but the last two exactly once', () => {
    const scene = new Scene();
    const swap = createWorldSwap<ReturnType<typeof world>>(scene);
    const all = Array.from({ length: 6 }, (_, i) => world(`M${i}`));
    for (const w of all) { swap.begin(w); up(scene, w); }
    expect(scene.children).toHaveLength(2);
    expect(all.map((w) => w.disposed)).toEqual([1, 1, 1, 1, 0, 0]);
  });
});
