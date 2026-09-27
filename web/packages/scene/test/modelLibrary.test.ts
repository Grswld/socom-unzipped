import { describe, it, expect } from 'vitest';
import { resolveChunk, type ModelEntry } from '../src/index';

/**
 * The `_L` suffix (`zVisual/vis_main.cpp:93-102`): `hookupVisuals` fetches `<key>_L` first and, when it
 * is there, marks the node dynamically lit; only then does it fetch `<key>`. Five maps carry such keys
 * (MP1, MP7, MP11, MP62, MP83; 278 in all) and none of the three fixtures does, so the entry is built.
 */
const entry = (nodes: { name: string; offset: number }[]): ModelEntry => ({ name: 'tent_seals', buffer: new Uint8Array(0), nodes });

describe('resolveChunk: the chunk key the scene graph predicts, against the names the buffer holds', () => {
  const tent = entry([
    { name: 'N000_I000_V00', offset: 0 },
    { name: 'N001_I000_V00_L', offset: 64 },
    { name: 'N001_I000_V01_L', offset: 128 },
  ]);

  it('a plain key resolves to its offset, unlit', () => {
    expect(resolveChunk(tent, 'N000_I000_V00')).toEqual({ offset: 0, lit: false });
  });

  it('a key stored only under its _L name resolves to that offset and reports lit', () => {
    expect(resolveChunk(tent, 'N001_I000_V00')).toEqual({ offset: 64, lit: true });
    expect(resolveChunk(tent, 'N001_I000_V01')).toEqual({ offset: 128, lit: true });
  });

  it('a key with neither name present still misses', () => {
    expect(resolveChunk(tent, 'N002_I000_V00')).toBeNull();
    expect(resolveChunk(entry([]), 'N001_I000_V00')).toBeNull();
  });

  it('with both names present the _L one wins, the order the engine fetches in', () => {
    const both = entry([{ name: 'N003_I000_V00', offset: 8 }, { name: 'N003_I000_V00_L', offset: 16 }]);
    expect(resolveChunk(both, 'N003_I000_V00')).toEqual({ offset: 16, lit: true });
  });
});
