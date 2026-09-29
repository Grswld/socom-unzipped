import { describe, expect, it } from 'vitest';
import { capturePointer, releasePointer, requestLock } from '../src/pointer';

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

describe('requestLock: a refused lock is never an uncaught rejection', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 20));
  const refused = (): Promise<never> => Promise.reject(new DOMException('The user has exited the lock before this request was completed.', 'SecurityError'));

  it('asks raw first and is done when it is granted', async () => {
    const asked: unknown[] = [];
    expect(requestLock({ requestPointerLock: (o) => { asked.push(o); return Promise.resolve(); } })).toBe(true);
    await settle();
    expect(asked).toEqual([{ unadjustedMovement: true }]);
  });

  it('falls back to the plain request when the raw one rejects, and swallows the rejection of that too', async () => {
    process.on('unhandledRejection', onUnhandled);
    const asked: unknown[] = [];
    requestLock({ requestPointerLock: (o) => { asked.push(o); return refused(); } });
    await settle();
    process.off('unhandledRejection', onUnhandled);
    expect(asked).toEqual([{ unadjustedMovement: true }, undefined]);     // the raw ask, then the plain one
    expect(unhandled).toEqual([]);
  });

  it('a call that throws at once falls back to the plain request, and a plain one that throws is swallowed', () => {
    const asked: unknown[] = [];
    expect(() => requestLock({ requestPointerLock: (o) => { asked.push(o); throw new DOMException('no', 'InvalidStateError'); } })).not.toThrow();
    expect(asked).toEqual([{ unadjustedMovement: true }, undefined]);
  });

  it('takes a browser whose request returns nothing, and one with no request at all', () => {
    expect(requestLock({ requestPointerLock: () => undefined })).toBe(true);
    expect(requestLock({})).toBe(false);
  });
});
