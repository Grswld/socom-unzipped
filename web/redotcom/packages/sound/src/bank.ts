import { Reader } from '@s2u/archive';

/**
 * A 989snd sound bank as SOCOM II ships it: one `.bnk` member of `RUN/SOUNDS/BNKSTORE.ZAR` (web/docs/research/81 §1).
 *
 * The file is 989snd's `FileAttributes` head -- `u32 type` (3), `u32 chunk count` (2), then an `(offset, size)` pair
 * per chunk -- over two chunks: the `SBlk` sound block (version 3, the `SFXBlock2` of research/989snd-ziemas
 * `iop/types.h:428-449`, research/32 §1) and the VAG sample data its tones index. Read off the disc:
 *
 * - the block head: `DataID "SBlk"`, `Version 3`, `Flags` (0x104: bit 8 `BLOCK_HAS_NAMES`), `BlockID`, `BlockNum`,
 *   `NumSounds` s16 at 0x16, `NumGrains` 0x18, `NumVAGs` 0x1a, then offsets from the block's start: `FirstSound`
 *   0x1c, `FirstGrain` 0x20, `VagsInSR` 0x24 (the SPU address), `VagDataSize` 0x28, `SRAMAllocSize` 0x2c,
 *   `NextBlock` 0x30, `GrainData` 0x34, `BlockNames` 0x38, `SFXUD` 0x3c;
 * - a sound, 12 bytes (`SFX2`): `s8 Vol, s8 VolGroup, s16 Pan, s8 NumGrains, s8 InstanceLimit, u16 Flags,
 *   s32 FirstGrain` (a byte offset into the grain array);
 * - a grain, 8 bytes (`SFXGrain2`): `u32 Opcode` = `type << 24 | arg24`, `s32 Delay` in 240 Hz ticks;
 * - a tone, 24 bytes in the grain-data pool at a TONE grain's `arg24`: `s8 Priority, Vol, CenterNote, CenterFine,
 *   s16 Pan, s8 MapLow, MapHigh, PBLow, PBHigh, u16 ADSR1, ADSR2, Flags, u32 VAGInSR` (the sample's byte offset
 *   in the VAG chunk: the loader adds `VagsInSR` to it, `loader.c:1047-1050`);
 * - the names (`SFXBlockNames`, `types.h:324-332`, at `BlockNames`): `BlockName[8]`, `SFXNameTableOffset`
 *   (from `BlockName`), three tables SOCOM leaves empty, and 32 `s16` hash-bucket starts; a name entry
 *   (`SFXName`, 20 bytes) is `char Name[16]` and `s16 Index`. The hash (`snd_CalcSoundNameHash`,
 *   `playsnd.c:652-660`) is `abs(name[0] + name[4] + name[8] + name[12]) % 32` over signed chars, and a bucket runs
 *   to the first empty name (`snd_FindSoundByName`, `playsnd.c:595-650`). SOCOM's names carry a sigil: `.STEP_STONE`,
 *   `~AK47_1`, `!SMK_CANISTER`.
 */

/** The grain types (research/32 §1; OpenGOAL `sfxgrain.h`). */
export const GRAIN = {
  TONE: 1, XREF_ID: 2, XREF_NUM: 3, LFO_SETTINGS: 4, STARTCHILDSOUND: 5, STOPCHILDSOUND: 6, PLUGIN_MESSAGE: 7,
  BRANCH: 8, TONE2: 9, CONTROL_NULL: 20, LOOP_START: 21, LOOP_END: 22, LOOP_CONTINUE: 23, STOP: 24, RAND_PLAY: 25,
  RAND_DELAY: 26, RAND_PB: 27, PB: 28, ADD_PB: 29, SET_REGISTER: 30, SET_REGISTER_RAND: 31, INC_REGISTER: 32,
  DEC_REGISTER: 33, TEST_REGISTER: 34, MARKER: 35, GOTO_MARKER: 36, GOTO_RANDOM_MARKER: 37, WAIT_FOR_ALL_VOICES: 38,
  PLAY_CYCLE: 39, ADD_REGISTER: 40, KEY_OFF_VOICES: 41, KILL_VOICES: 42, ON_STOP_MARKER: 43, COPY_REGISTER: 44,
} as const;

export interface Tone {
  priority: number; vol: number; centerNote: number; centerFine: number; pan: number;
  mapLow: number; mapHigh: number; pbLow: number; pbHigh: number;
  adsr1: number; adsr2: number; flags: number;
  /** Byte offset of the sample in the VAG chunk. */
  sampleOffset: number;
}

export interface Grain {
  type: number;
  /** The 24-bit operand: a grain-data offset for a TONE, three signed bytes for the control grains. */
  arg: number;
  /** Ticks at 240 Hz before the grain runs. */
  delay: number;
}

export interface BankSound {
  vol: number; volGroup: number; pan: number; instanceLimit: number; flags: number;
  grains: Grain[];
}

export interface SoundBank {
  /** The block's own name, `BlockName` (`MP2_FX`). */
  name: string;
  /** `BlockID` as four characters, as the file spells it (`20EM`). */
  blockId: string;
  flags: number;
  sounds: BankSound[];
  /** The grain-data pool the TONE grains index (and the child-sound specs). */
  grainData: Uint8Array;
  /** Sound name (with its sigil) to index, every name the hash buckets reach. */
  names: Map<string, number>;
  /** The VAG chunk: headerless ADPCM, indexed by `Tone.sampleOffset`. */
  vag: Uint8Array;
}

const SBLK = 0x6b6c4253, BLOCK_HAS_NAMES = 0x100;

/** Reads a whole `.bnk`: the head, the block, its names, and a view of the VAG chunk. */
export function parseBankFile(bytes: Uint8Array): SoundBank {
  const r = new Reader(bytes);
  const type = r.u32(0), chunks = r.u32(4);
  if (type !== 3 || chunks !== 2) throw new Error(`bank: FileAttributes type ${type} with ${chunks} chunks, expected 3 and 2`);
  const block = r.slice(r.u32(8), r.u32(12));
  const vag = r.slice(r.u32(16), r.u32(20));
  return { ...parseBlock(block), vag };
}

/** The `SBlk` chunk alone. */
export function parseBlock(block: Uint8Array): Omit<SoundBank, 'vag'> {
  const r = new Reader(block);
  if (r.u32(0) !== SBLK) throw new Error('bank: no SBlk block');
  if (r.u32(4) !== 3) throw new Error(`bank: SBlk version ${r.u32(4)}, expected 3`);
  const flags = r.u32(8);
  const blockId = String.fromCharCode(...block.subarray(0x0c, 0x10));
  const numSounds = r.i16(0x16), numGrains = r.i16(0x18);
  const firstSound = r.u32(0x1c), firstGrain = r.u32(0x20), grainDataAt = r.u32(0x34), namesAt = r.u32(0x38);
  if (numSounds < 0 || numGrains < 0) throw new Error('bank: negative sound or grain count');
  const grainEnd = firstGrain + 8 * numGrains;
  if (grainEnd > block.byteLength || firstSound + 12 * numSounds > block.byteLength) throw new Error('bank: a table runs off the block');
  const sounds: BankSound[] = [];
  for (let i = 0; i < numSounds; i++) {
    const o = firstSound + 12 * i;
    const n = (r.u8(o + 4) << 24) >> 24, first = r.i32(o + 8);
    const grains: Grain[] = [];
    if (n > 0 && first >= 0) {
      for (let g = 0; g < n; g++) {
        const q = firstGrain + first + 8 * g;
        if (q + 8 > grainEnd) throw new Error(`bank: sound ${i}'s grains run off the grain table`);
        const opcode = r.u32(q);
        grains.push({ type: opcode >>> 24, arg: opcode & 0xffffff, delay: r.i32(q + 4) });
      }
    }
    sounds.push({
      vol: (r.u8(o) << 24) >> 24, volGroup: (r.u8(o + 1) << 24) >> 24, pan: r.i16(o + 2),
      instanceLimit: (r.u8(o + 5) << 24) >> 24, flags: r.u16(o + 6), grains,
    });
  }
  const hasNames = (flags & BLOCK_HAS_NAMES) !== 0 && namesAt > 0 && namesAt < block.byteLength;
  const poolEnd = hasNames && namesAt > grainDataAt ? namesAt : block.byteLength;
  const grainData = block.subarray(Math.min(grainDataAt, block.byteLength), poolEnd);
  let name = '';
  const names = new Map<string, number>();
  if (hasNames) {
    name = r.cstr(namesAt, Math.min(8, block.byteLength - namesAt));
    const table = namesAt + r.u32(namesAt + 8);
    for (let b = 0; b < 32; b++) {
      for (let e = r.i16(namesAt + 0x18 + 2 * b); e >= 0; e++) {
        const o = table + 20 * e;
        if (o + 20 > block.byteLength || block[o] === 0) break;
        names.set(r.cstr(o, 16), r.i16(o + 16));
      }
    }
  }
  return { name, blockId, flags, sounds, grainData, names };
}

/** `snd_CalcSoundNameHash` (`playsnd.c:652-660`): the bucket a name is filed under. */
export function soundNameHash(name: string): number {
  const c = (i: number): number => (((name.charCodeAt(i) || 0) & 0xff) << 24) >> 24;
  return Math.abs(c(0) + c(4) + c(8) + c(12)) % 32;
}

/** The tone a TONE or TONE2 grain names, or null for another grain or an operand outside the pool. */
export function bankTone(bank: Pick<SoundBank, 'grainData'>, grain: Grain): Tone | null {
  if (grain.type !== GRAIN.TONE && grain.type !== GRAIN.TONE2) return null;
  if (grain.arg + 24 > bank.grainData.byteLength) return null;
  const r = new Reader(bank.grainData), o = grain.arg;
  const s8 = (at: number): number => (r.u8(o + at) << 24) >> 24;
  return {
    priority: s8(0), vol: s8(1), centerNote: s8(2), centerFine: s8(3), pan: r.i16(o + 4),
    mapLow: s8(6), mapHigh: s8(7), pbLow: s8(8), pbHigh: s8(9),
    adsr1: r.u16(o + 10), adsr2: r.u16(o + 12), flags: r.u16(o + 14), sampleOffset: r.u32(o + 16),
  };
}
