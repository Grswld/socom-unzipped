import { describe, expect, it } from 'vitest';
import { ClipPath, rootAt, shapeTravel, straightShape } from '../src/clipPath';

describe('a traversal clip\'s path (web research 86 section 1)', () => {
  const shape = straightShape('climb', 1.25, 11.5, 12.9, 11.3);

  it('reads the root\'s rise and travel ahead from key 0 to the last real key', () => {
    const t = shapeTravel(shape);
    expect(t.rise).toBeCloseTo(12.9, 6);
    expect(t.ahead).toBeCloseTo(11.3, 6);
    expect(rootAt(shape, 1e9)[1]).toBeCloseTo(24.4, 6);           // clamped at the last key, not the closing key 0
  });

  it('carries the feet from start to end and the body from the start root to the end root, stretched to the obstacle', () => {
    const path = new ClipPath(shape, [0, 100, 0], [0, 109, -10], 11.48, 11.48);   // a 9-unit crate: the clip rises 12.9
    const a = path.at(0), b = path.at(path.seconds);
    expect(a.feet).toEqual([0, 100, 0]);
    expect(a.rootY).toBeCloseTo(11.48, 6);
    expect(b.done).toBe(true);
    expect(b.feet[1]).toBeCloseTo(109, 6);
    expect(b.feet[2]).toBeCloseTo(-10, 6);
    expect(b.feet[1] + b.rootY).toBeCloseTo(109 + 11.48, 6);     // stands on the top in the stance's root: no pop
    // Monotone feet: they never go down on the way up.
    let last = -Infinity;
    for (let t = 0; t <= path.seconds; t += 1 / 60) { const y = path.at(t).feet[1]; expect(y).toBeGreaterThanOrEqual(last - 1e-9); last = y; }
  });
});
