import { describe, expect, it } from 'vitest';
import { capturePointer, releasePointer } from '../src/pointer';

/** The guards around pointer capture: a pointer that is gone is a refusal, never an uncaught throw. */
const notFound = (): never => { throw new DOMException('No active pointer with the given id is found.', 'NotFoundError'); };

describe('capturePointer', () => {
  it('captures and says so', () => {
    const seen: number[] = [];
    expect(capturePointer({ setPointerCapture: (id) => { seen.push(id); } }, 4)).toBe(true);
    expect(seen).toEqual([4]);
  });
  it('says false, and throws nothing, when the pointer is gone', () => {
    expect(capturePointer({ setPointerCapture: notFound }, 9)).toBe(false);
  });
  it('is a yes where there is no capture to ask for: the drag goes on without', () => {
    expect(capturePointer({}, 1)).toBe(true);
  });
});

describe('releasePointer', () => {
  it('lets go of a pointer it holds', () => {
    const seen: number[] = [];
    releasePointer({ hasPointerCapture: () => true, releasePointerCapture: (id) => { seen.push(id); } }, 2);
    expect(seen).toEqual([2]);
  });
  it('leaves a pointer it does not hold alone', () => {
    const seen: number[] = [];
    releasePointer({ hasPointerCapture: () => false, releasePointerCapture: (id) => { seen.push(id); } }, 2);
    expect(seen).toEqual([]);
  });
  it('swallows a refusal, from either call', () => {
    expect(() => releasePointer({ hasPointerCapture: notFound }, 1)).not.toThrow();
    expect(() => releasePointer({ hasPointerCapture: () => true, releasePointerCapture: notFound }, 1)).not.toThrow();
    expect(() => releasePointer({}, 1)).not.toThrow();
  });
});
