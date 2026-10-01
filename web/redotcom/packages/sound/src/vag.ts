/**
 * SPU ADPCM ("VAG"), the sample format of every 989snd bank's second chunk (web/redotcom/docs/research/81 §2). A run of
 * 16-byte blocks: byte 0 is `shift | filter << 4`, byte 1 the flags, then 14 bytes = 28 four-bit samples, low nibble
 * first. Each sample is `nibble << 12 >> shift` plus the filter's prediction from the two before it, over 64, with
 * the five filter pairs (0,0) (60,0) (115,-52) (98,-55) (122,-60). The flags: bit 2 marks the block a loop goes back
 * to, bit 0 ends the run, and bit 1 with it says the run repeats from that block.
 *
 * The recurrence is the repository's proven one (`third_party/ps2recomp/ps2xRuntime/src/lib/ps2_audio_vag.cpp`,
 * `ps2_vag::decodeBlocks`, research/32 §3 and §5; docs/KNOWN §1 "the ADPCM decode is Proven"), transliterated: the
 * division truncates toward zero as C's does, a shift over 12 is read as 9 and a filter over 4 as 0, as it does.
 * A bank's samples carry no `VAGp` header: a tone names its sample by byte offset into the chunk.
 */

/** One decoded sample: 16-bit PCM, and where it loops back to when it loops. */
export interface VagSample {
  pcm: Int16Array;
  /** The end block's bit 1: the run repeats from `loopStart`. */
  loops: boolean;
  /** The sample index of the block flagged loop start (bit 2), 0 when none is. */
  loopStart: number;
  /** Bytes of ADPCM read, the end block included. */
  bytes: number;
}

const F0 = [0, 60, 115, 98, 122] as const;
const F1 = [0, 0, -52, -55, -60] as const;

/** Decodes the run of blocks at `offset` in `data` up to its end block (or the data's end). */
export function decodeVag(data: Uint8Array, offset = 0): VagSample {
  const blocks = Math.max(0, Math.floor((data.byteLength - offset) / 16));
  const out = new Int16Array(blocks * 28);
  let n = 0, s1 = 0, s2 = 0, loops = false, loopStart = 0, used = 0;
  for (let b = 0; b < blocks; b++) {
    const at = offset + b * 16;
    let shift = data[at]! & 0x0f;
    if (shift > 12) shift = 9;
    let filter = (data[at]! >> 4) & 0x07;
    if (filter > 4) filter = 0;
    const flags = data[at + 1]!;
    if (flags & 0x04) loopStart = n;
    const f0 = F0[filter]!, f1 = F1[filter]!;
    for (let i = 0; i < 28; i++) {
      const byte = data[at + 2 + (i >> 1)]!;
      const nibble = (i & 1) ? byte >> 4 : byte & 0x0f;
      const raw = (nibble << 28) >> 28;                      // sign-extend the four bits
      const shifted = raw * (1 << (12 - shift));             // raw << (12 - shift), in range for any shift 0..12
      const filtered = shifted + Math.trunc((f0 * s1 + f1 * s2 + 32) / 64);
      const v = filtered < -32768 ? -32768 : filtered > 32767 ? 32767 : filtered;
      s2 = s1;
      s1 = v;
      out[n++] = v;
    }
    used = (b + 1) * 16;
    if (flags & 0x01) {
      loops = (flags & 0x02) !== 0;
      break;
    }
  }
  return { pcm: out.subarray(0, n), loops, loopStart, bytes: used };
}
