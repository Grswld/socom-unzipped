import { describe, expect, it } from 'vitest';
import { Zar } from '@s2u/archive';
import { parseCameraParams } from '../src/cameraParams';

/**
 * Nine hand-derived offsets and a bitfield whose order depends on the target's endianness, so the
 * record is built here byte by byte from known values and read back. The numbers are Frostfire's, which
 * `READERM.ZAR -> mp2.rdr` states in text:
 *
 *   camera (fov (0.6109 0.4276) clip (4 640) mid_clip (640)
 *           fog_standard (enabled (1) range (200 640) mid (270) RGB (7 7 12))
 *           fog_altitude (enabled (0) range (100 0) ...))
 */
const RECORD_BYTES = 144;

function record(over: Partial<{
  rgb: [number, number, number]; near: number; far: number; top: number; bottom: number;
  flags: number; hfov: number; vfov: number; nearPlane: number; farPlane: number;
}> = {}): Uint8Array {
  const bytes = new Uint8Array(RECORD_BYTES);
  const view = new DataView(bytes.buffer);
  const [r, g, b] = over.rgb ?? [7, 7, 12];
  view.setFloat32(0x10, r / 255, true);
  view.setFloat32(0x14, g / 255, true);
  view.setFloat32(0x18, b / 255, true);
  view.setFloat32(0x1c, 1, true);                      // alpha, which the parser ignores
  view.setFloat32(0x20, over.hfov ?? 0.6109, true);
  view.setFloat32(0x24, over.vfov ?? 0.42763, true);
  view.setFloat32(0x28, over.nearPlane ?? 4, true);
  view.setFloat32(0x2c, 640, true);                    // mid plane, between near and far in the struct
  view.setFloat32(0x30, over.farPlane ?? 640, true);
  view.setFloat32(0x64, over.near ?? 200, true);
  view.setFloat32(0x68, over.far ?? 640, true);
  view.setFloat32(0x6c, 270, true);                    // fog_mid, dead
  view.setFloat32(0x78, 1, true);                      // fog_density, dead
  view.setFloat32(0x7c, over.top ?? 100, true);
  view.setFloat32(0x80, over.bottom ?? 0, true);
  view.setUint32(0x8c, over.flags ?? 0x20000000, true);
  return bytes;
}

/** A Zar whose one key is the record, standing in for `MP*.ZED`. */
const zarOf = (bytes: Uint8Array): Zar => ({
  find: (name: string) => (name === 'cameras/camera' ? { name, size: bytes.length } : null),
  data: () => bytes,
} as unknown as Zar);

describe('parseCameraParams', () => {
  it('reads Frostfire\'s record the way mp2.rdr states it', () => {
    const c = parseCameraParams(zarOf(record()))!;
    expect(c).not.toBeNull();
    expect(c.fogColor).toEqual([7, 7, 12]);
    expect(c.fogNear).toBe(200);
    expect(c.fogFar).toBe(640);
    expect(c.fogTop).toBe(100);
    expect(c.fogBottom).toBe(0);
    expect(c.fogEnabled).toBe(true);
    expect(c.fogAltitude).toBe(false);
    expect(c.fogDirectional).toBe(false);
    expect(c.nearPlane).toBe(4);
    expect(c.farPlane).toBe(640);
    expect(c.hfov).toBeCloseTo(0.6109, 5);
    expect(c.vfov).toBeCloseTo(0.42763, 5);
  });

  it('rounds the 0..1 colour back to the GS register\'s 0..255', () => {
    // The values on disc are exact n/255, so the round-trip has to land on the integer.
    for (const rgb of [[0, 0, 0], [46, 47, 59], [170, 165, 120], [255, 255, 255]] as const) {
      expect(parseCameraParams(zarOf(record({ rgb: [...rgb] })))!.fogColor).toEqual([...rgb]);
    }
  });

  it('reads the three flags from bits 29, 30 and 31', () => {
    const flagsOf = (word: number) => {
      const c = parseCameraParams(zarOf(record({ flags: word })))!;
      return [c.fogEnabled, c.fogDirectional, c.fogAltitude];
    };
    expect(flagsOf(0x00000000)).toEqual([false, false, false]);
    expect(flagsOf(0x20000000)).toEqual([true, false, false]);    // MP2: fog on, altitude off
    expect(flagsOf(0xa0000000)).toEqual([true, false, true]);     // MP1: fog on, altitude on
    expect(flagsOf(0x40000000)).toEqual([false, true, false]);
    expect(flagsOf(0x80000000)).toEqual([false, false, true]);
    // The low 29 bits are `m_flags_unused` and must not leak into any of the three.
    expect(flagsOf(0x1fffffff)).toEqual([false, false, false]);
  });

  it('returns null rather than throwing when the key is missing or short', () => {
    expect(parseCameraParams({ find: () => null } as unknown as Zar)).toBe(null);
    const short = { find: () => ({ name: 'cameras/camera', size: 100 }), data: () => new Uint8Array(100) };
    expect(parseCameraParams(short as unknown as Zar)).toBe(null);
  });
});
