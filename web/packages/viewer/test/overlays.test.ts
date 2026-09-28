import { describe, expect, it } from 'vitest';
import { LineBasicMaterial, LineSegments, Scene } from 'three';
import { facingVector, type SpawnSlot } from '@s2u/scene';
import { Overlays, SLOT_ARROW, SLOT_CELL, slotSegments } from '../src/overlays';

/**
 * The spawn overlay's second half (W1.5b): the disc's spawn slots, each drawn as its cell's outline and
 * an arrow along its facing, in the side's colour, under the same toggle as the measured A and B.
 */
const slot = (side: 0 | 1, x: number, y: number, z: number, step: number, index = 0): SpawnSlot => ({
  side, index, position: [x, y, z], step, facing: facingVector(step), loc: { map: 0, x: 0, z: 0 },
});

/** The segments of a position list, each as its two endpoints rounded to a thousandth. */
function segments(p: Float32Array): [number, number, number][][] {
  const r = (v: number) => Math.round(v * 1000) / 1000 + 0;
  const out: [number, number, number][][] = [];
  for (let i = 0; i < p.length; i += 6) out.push([[r(p[i]!), r(p[i + 1]!), r(p[i + 2]!)], [r(p[i + 3]!), r(p[i + 4]!), r(p[i + 5]!)]]);
  return out;
}

describe('slotSegments: a slot in game units', () => {
  it('outlines the slot\'s 10-unit cell and runs a shaft of one cell along the facing, with two barbs', () => {
    expect(SLOT_CELL).toBe(10);                              // research 75 §3: 10 x 10 on all 83 sub-maps
    expect(SLOT_ARROW).toBe(10);
    const s = segments(slotSegments([slot(0, 100, 50, 200, 2)]));   // step 2 faces -x
    expect(s.length).toBe(7);
    // the cell: four sides at +-5 around the centre, at the slot's y
    const corners = new Set(s.slice(0, 4).flat().map((p) => p.join(',')));
    expect(corners).toEqual(new Set(['95,50,195', '105,50,195', '105,50,205', '95,50,205']));
    // the shaft: centre to 10 units along -x
    expect(s[4]).toEqual([[100, 50, 200], [90, 50, 200]]);
    // the barbs start at the tip and fall back toward +x, one to each side
    for (const barb of s.slice(5)) {
      expect(barb[0]).toEqual([90, 50, 200]);
      expect(barb[1]![0]).toBeGreaterThan(90);
    }
    expect(Math.sign(s[5]![1]![2] - 200)).toBe(-Math.sign(s[6]![1]![2] - 200));
  });

  it('turns the arrow with the facing: step 1 is 45 degrees from +z toward -x (75 §7)', () => {
    const s = segments(slotSegments([slot(1, 0, 0, 0, 1)]));
    const t = SLOT_ARROW * Math.SQRT1_2;
    expect(s[4]![1]![0]).toBeCloseTo(-t, 3);
    expect(s[4]![1]![2]).toBeCloseTo(t, 3);
  });

  it('is empty for no slots', () => {
    expect(slotSegments([]).length).toBe(0);
  });
});

describe('Overlays.placeSpawns with the disc\'s slots', () => {
  const lines = (scene: Scene): LineSegments[] => {
    const out: LineSegments[] = [];
    scene.traverse((o) => { if (o instanceof LineSegments) out.push(o); });
    return out;
  };

  it('draws one line set per side in the side\'s colour, hidden until the spawns toggle shows it, and counts them', () => {
    const scene = new Scene();
    const overlays = new Overlays(scene);
    overlays.placeSpawns(null, [slot(0, 0, 0, 0, 0, 0), slot(0, 50, 0, 0, 4, 1), slot(1, 900, 0, 900, 2, 0)]);
    expect(overlays.slotCounts()).toEqual({ a: 2, b: 1 });
    const drawn = lines(scene);
    expect(drawn.map((l) => (l.material as LineBasicMaterial).color.getHex()).sort()).toEqual([0x4d9bff, 0xff6a3d].sort());
    expect(drawn.map((l) => l.geometry.getAttribute('position').count).sort()).toEqual([14, 28]);
    // The y is not the file's (75 §4), so a slot is not hidden behind a floor it may be drawn under.
    for (const l of drawn) expect((l.material as LineBasicMaterial).depthTest).toBe(false);
    // ... and last of all, so no blended world draw placed after it in the walk paints over it.
    for (const l of drawn) expect(l.renderOrder).toBe(Number.MAX_SAFE_INTEGER);
    const shown = (): boolean => drawn.every((l) => { let v = true; l.traverseAncestors((a) => { v &&= a.visible; }); return v && l.visible; });
    expect(shown()).toBe(false);                             // the toggle is off by default
    overlays.setSpawns(true);
    expect(shown()).toBe(true);
    overlays.setSpawns(false);
    expect(shown()).toBe(false);
  });

  it('a new map replaces the slots and keeps the toggle\'s state; a map with none draws none', () => {
    const scene = new Scene();
    const overlays = new Overlays(scene);
    overlays.setSpawns(true);
    overlays.placeSpawns(null, [slot(0, 0, 0, 0, 0)]);
    overlays.placeSpawns(null, [slot(1, 0, 0, 0, 0), slot(1, 20, 0, 0, 0, 1)]);
    expect(overlays.slotCounts()).toEqual({ a: 0, b: 2 });
    expect(lines(scene).length).toBe(1);
    expect(lines(scene)[0]!.parent!.visible).toBe(true);
    overlays.placeSpawns(null, []);
    expect(overlays.slotCounts()).toEqual({ a: 0, b: 0 });
    expect(lines(scene).length).toBe(0);
  });
});
