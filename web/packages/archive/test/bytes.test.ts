import { describe, it, expect } from 'vitest';
import { Reader } from '../src/bytes';

describe('Reader', () => {
  const bytes = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x41, 0x42, 0x00, 0xff, 0x00, 0x00, 0x80, 0x3f]);
  const r = new Reader(bytes);
  it('reads little-endian scalars', () => {
    expect(r.u8(0)).toBe(1);
    expect(r.u16(0)).toBe(0x0201);
    expect(r.u32(0)).toBe(0x04030201);
    expect(r.i32(4)).toBe(-16760255); // 0xff004241 as signed
    expect(r.f32(8)).toBeCloseTo(1.0);
  });
  it('reads a NUL-terminated string bounded by max', () => {
    expect(r.cstr(4, 4)).toBe('AB');
    expect(r.cstr(4, 1)).toBe('A');
  });
  it('slices as a view', () => {
    const s = r.slice(4, 2);
    expect(Array.from(s)).toEqual([0x41, 0x42]);
    expect(s.buffer).toBe(bytes.buffer);
  });
  it('throws on out-of-bounds', () => {
    expect(() => r.u32(10)).toThrow(RangeError);
    expect(() => r.slice(10, 4)).toThrow(RangeError);
  });
});
