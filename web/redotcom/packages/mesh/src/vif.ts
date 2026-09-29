import type { Chain } from './dma';

/**
 * The VIF1 side of a model chunk: the command stream a chain transfers, decoded and unpacked into the VU1
 * data memory each packet hands to the microprogram.
 *
 * Format reference: `web/docs/research/72-mp-map-archive-anatomy.md` §3. Map geometry uses **five** VIF commands
 * (NOP, STCYCL, UNPACK, MSCAL, MSCNT) and **five** unpack formats (V4-32, V4-16, V4-8 USN, V3-16, and the
 * V4-32 parameter unpack before each MSCAL); there are no MPG, DIRECT, STMASK, STROW or STCOL commands and no
 * masked unpacks. Anything else in a stream means the walker is reading something that is not map geometry,
 * so this decoder throws rather than guessing.
 *
 * VIF1 unpack rules as the task brief states them:
 * - code word: CMD = bits 24-30 (bit 31 is the `i` interrupt bit, ignored), NUM = bits 16-23, IMMEDIATE =
 *   bits 0-15. UNPACK is CMD 0x60..0x7F, with VN = (CMD >> 2) & 3, VL = CMD & 3 and the mask bit CMD & 0x10.
 * - immediate: ADDR = bits 0-9, USN = bit 14, FLG = bit 15. STCYCL: CL = bits 0-7, WL = bits 8-15.
 * - element sizes: V4-32 16 B, V4-16 8 B, V4-8 4 B, V3-32 12 B, V3-16 6 B, V3-8 3 B, V2-32 8 B, V2-16 4 B,
 *   V2-8 2 B, S-32 4 B, S-16 2 B, S-8 1 B. 16- and 8-bit lanes sign-extend unless USN.
 * - lanes a format does not name (V3, V2, S) are left as earlier unpacks wrote them, not zeroed.
 * - skipping write, CL >= WL: element `i` lands at `addr + floor(i / WL) * CL + (i % WL)`. CL < WL is a
 *   filling write, which map geometry never uses.
 * - NUM of 0 means 256. After an unpack's data the stream re-aligns to a 4-byte boundary.
 */

/** VU1 data memory as VIF1 addresses it: 1024 quadwords of four 32-bit lanes. */
const VU_QUADWORDS = 1024;
const LANES = 4;
/** 36 §3: relocation type 6 is a texture-name citation, and it names the packet that follows it. */
const TEXTURE_RELOC = 6;

const CMD_NOP = 0x00, CMD_STCYCL = 0x01, CMD_MSCAL = 0x14, CMD_MSCNT = 0x17, CMD_UNPACK = 0x60;
/** CMD bit 4 of an UNPACK: the write-mask bit, which map geometry never sets. */
const UNPACK_MASK_BIT = 0x10;
/** The bytes one lane of each VL occupies; VL 3 is V4-5, which map geometry does not use. */
const LANE_BYTES = [4, 2, 1];
const VL_NAMES = ['32', '16', '8', '5'];
/** VU1 micro memory is addressed in 64-bit instruction pairs, so an MSCAL immediate is eight bytes a step. */
const MSCAL_ENTRY_STEP = 8;

/** The commands a map's VIF1 stream may not contain, named so an error says what it found. */
const REJECTED_COMMANDS: Record<number, string> = {
  0x02: 'OFFSET', 0x03: 'BASE', 0x04: 'ITOP', 0x05: 'STMOD', 0x06: 'MSKPATH3', 0x07: 'MARK',
  0x10: 'FLUSHE', 0x11: 'FLUSH', 0x13: 'FLUSHA', 0x15: 'MSCALF', 0x20: 'STMASK', 0x30: 'STROW',
  0x31: 'STCOL', 0x4a: 'MPG', 0x50: 'DIRECT', 0x51: 'DIRECTHL',
};

/** A decode this stream cannot support, carrying the byte offset in the stream where it was found. */
export class VifError extends Error {
  readonly code: string;
  readonly offset: number;
  constructor(code: string, offset: number, message: string) {
    super(`${message} (VIF offset 0x${offset.toString(16)})`);
    this.name = 'VifError';
    this.code = code;
    this.offset = offset;
  }
}

/** One UNPACK, as it was decoded and applied. `dataOffset` is where its elements start in the stream. */
export interface Unpack {
  addr: number; num: number; vn: number; vl: number;
  usn: boolean; flg: boolean; cl: number; wl: number; dataOffset: number;
}

/** Everything unpacked since the previous MSCAL/MSCNT, and the microprogram call that consumed it. */
export interface VuPacket {
  kind: 'mscal' | 'mscnt';
  /** MSCAL's micro entry address in bytes (immediate * 8), or -1 for MSCNT, which continues where it left off. */
  entry: number;
  /** 1024 quadwords * 4 lanes of raw, sign-extended integers. */
  mem: Int32Array;
  /** The same bytes viewed as floats, for the V4-32 lanes that carry them. */
  f32: Float32Array;
  /** 1024 flags: whether this packet wrote that quadword. */
  written: Uint8Array;
  unpacks: Unpack[];
  /** The last texture this chain cited before the packet, or null when the chain cited none. */
  textureName: string | null;
}

/** One decoded VIF code and the span of stream bytes its data occupies. */
interface VifCode {
  name: 'NOP' | 'STCYCL' | 'UNPACK' | 'MSCAL' | 'MSCNT';
  cmd: number; imm: number;
  /** NUM, already read as 256 when the field is 0. Only UNPACK uses it. */
  num: number;
  /** Where the code word sits, and where the bytes after it start. */
  codeOffset: number; dataOffset: number;
}

/** Decodes the stream code by code, stepping over each unpack's data. Throws on anything map geometry lacks. */
function* vifCodes(vif: Uint8Array): Generator<VifCode> {
  const dv = new DataView(vif.buffer, vif.byteOffset, vif.byteLength);
  let pos = 0;
  while (pos + 4 <= vif.byteLength) {
    const word = dv.getUint32(pos, true);
    const codeOffset = pos;
    const cmd = (word >>> 24) & 0x7f;        // CMD: bits 24-30, bit 31 being the `i` interrupt bit
    const num = (word >>> 16) & 0xff;        // NUM: bits 16-23
    const imm = word & 0xffff;               // IMMEDIATE: bits 0-15
    pos += 4;

    if (cmd >= CMD_UNPACK) {
      if (cmd & UNPACK_MASK_BIT) throw new VifError('masked-unpack', codeOffset, `masked UNPACK (CMD 0x${cmd.toString(16)}, m=1): map geometry writes no masked unpacks`);
      const vl = cmd & 3;                    // VL: CMD bits 0-1, the lane width
      const vn = (cmd >>> 2) & 3;            // VN: CMD bits 2-3, one less than the lane count
      const laneBytes = LANE_BYTES[vl];
      if (laneBytes === undefined) throw new VifError('unsupported-format', codeOffset, `UNPACK V${vn + 1}-5 is not a format map geometry uses`);
      const count = num === 0 ? 256 : num;   // NUM of 0 means 256 elements
      const dataBytes = (count * (vn + 1) * laneBytes + 3) & ~3;   // ... then re-align to 4 bytes
      if (pos + dataBytes > vif.byteLength) throw new VifError('truncated-data', codeOffset, `UNPACK V${vn + 1}-${VL_NAMES[vl]} num=${count} wants ${dataBytes} bytes but only ${vif.byteLength - pos} remain`);
      yield { name: 'UNPACK', cmd, num: count, imm, codeOffset, dataOffset: pos };
      pos += dataBytes;
      continue;
    }

    if (cmd === CMD_NOP) yield { name: 'NOP', cmd, num, imm, codeOffset, dataOffset: pos };
    else if (cmd === CMD_STCYCL) yield { name: 'STCYCL', cmd, num, imm, codeOffset, dataOffset: pos };
    else if (cmd === CMD_MSCAL) yield { name: 'MSCAL', cmd, num, imm, codeOffset, dataOffset: pos };
    else if (cmd === CMD_MSCNT) yield { name: 'MSCNT', cmd, num, imm, codeOffset, dataOffset: pos };
    else {
      const name = REJECTED_COMMANDS[cmd] ?? 'unknown';
      throw new VifError('unsupported-command', codeOffset, `VIF command ${name} (0x${cmd.toString(16).padStart(2, '0')}): only NOP, STCYCL, UNPACK, MSCAL and MSCNT appear in map geometry`);
    }
  }
}

/** How many of each command a stream holds, by the five names map geometry uses (36 §3's histogram). */
export function vifHistogram(vif: Uint8Array): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const code of vifCodes(vif)) counts[code.name] = (counts[code.name] ?? 0) + 1;
  return counts;
}

/** The VU memory a packet is filling, before its MSCAL/MSCNT closes it. */
interface OpenPacket {
  mem: Int32Array; f32: Float32Array; written: Uint8Array; unpacks: Unpack[];
  /** Where the packet's first unpack code sits, so an unterminated packet can name it; -1 while empty. */
  firstCodeOffset: number;
}

function openPacket(): OpenPacket {
  const buffer = new ArrayBuffer(VU_QUADWORDS * LANES * 4);
  return { mem: new Int32Array(buffer), f32: new Float32Array(buffer), written: new Uint8Array(VU_QUADWORDS), unpacks: [], firstCodeOffset: -1 };
}

/** Applies one UNPACK's elements to the open packet's VU memory, and records what it did. */
function applyUnpack(dv: DataView, code: VifCode, cl: number, wl: number, packet: OpenPacket): void {
  const vl = code.cmd & 3;                   // VL: CMD bits 0-1
  const vn = (code.cmd >>> 2) & 3;           // VN: CMD bits 2-3
  const addr = code.imm & 0x3ff;             // ADDR: immediate bits 0-9
  const usn = ((code.imm >>> 14) & 1) === 1; // USN: immediate bit 14
  const flg = ((code.imm >>> 15) & 1) === 1; // FLG: immediate bit 15, TOPS-relative; the per-packet base is 0
  const lanes = vn + 1;
  const laneBytes = LANE_BYTES[vl]!;         // vifCodes already rejected VL 3
  if (wl === 0) throw new VifError('bad-cycle', code.codeOffset, 'STCYCL left WL at 0, so no element has a destination');
  if (cl < wl) throw new VifError('filling-write', code.codeOffset, `CL ${cl} < WL ${wl} is a filling write, which map geometry does not use`);

  for (let i = 0; i < code.num; i++) {
    const qw = addr + Math.floor(i / wl) * cl + (i % wl);   // skipping write, CL >= WL
    if (qw >= VU_QUADWORDS) throw new VifError('vu-memory-overflow', code.codeOffset, `element ${i} lands at quadword ${qw}, past the ${VU_QUADWORDS} quadwords of VU data memory`);
    const at = code.dataOffset + i * lanes * laneBytes;
    for (let lane = 0; lane < lanes; lane++) {
      const from = at + lane * laneBytes;
      packet.mem[qw * LANES + lane] =
        vl === 0 ? dv.getInt32(from, true)                              // 32-bit lanes keep their raw bits
        : vl === 1 ? (usn ? dv.getUint16(from, true) : dv.getInt16(from, true))
        : (usn ? dv.getUint8(from) : dv.getInt8(from));
    }
    packet.written[qw] = 1;
  }
  if (packet.firstCodeOffset < 0) packet.firstCodeOffset = code.codeOffset;
  packet.unpacks.push({ addr, num: code.num, vn, vl, usn, flg, cl, wl, dataOffset: code.dataOffset });
}

/** Splits a stream into packets, asking `textureAt` which texture was in force where each one ended. */
function splitPackets(vif: Uint8Array, textureAt: (offset: number) => string | null): VuPacket[] {
  const dv = new DataView(vif.buffer, vif.byteOffset, vif.byteLength);
  const packets: VuPacket[] = [];
  let cl = 1, wl = 1;                        // STCYCL's reset value; every real unpack sets it first
  let packet = openPacket();
  for (const code of vifCodes(vif)) {
    switch (code.name) {
      case 'NOP':                            // NOP carries an immediate; VIF ignores it, and so does this
        break;
      case 'STCYCL':
        cl = code.imm & 0xff;                // CL: immediate bits 0-7
        wl = (code.imm >>> 8) & 0xff;        // WL: immediate bits 8-15
        break;
      case 'UNPACK':
        applyUnpack(dv, code, cl, wl, packet);
        break;
      case 'MSCAL':
      case 'MSCNT':
        packets.push({
          kind: code.name === 'MSCAL' ? 'mscal' : 'mscnt',
          entry: code.name === 'MSCAL' ? code.imm * MSCAL_ENTRY_STEP : -1,
          mem: packet.mem, f32: packet.f32, written: packet.written, unpacks: packet.unpacks,
          textureName: textureAt(code.codeOffset),
        });
        packet = openPacket();               // each packet starts from a fresh, zeroed VU memory
        break;
    }
  }
  // Trailing NOPs and a trailing STCYCL are the chain's padding. Data with nothing to run it is not.
  if (packet.firstCodeOffset >= 0) throw new VifError('unterminated-packet', packet.firstCodeOffset, 'the stream ends with unpacked data no MSCAL or MSCNT runs');
  return packets;
}

/**
 * Unpacks a chunk's chain into the packets it draws, each with the texture in force: the name of the last
 * reloc-6 citation whose `vifOffset` is at or before the packet's MSCAL/MSCNT (36 §3 — a citation contributes
 * no bytes, so its `vifOffset` is where the packet it names begins).
 */
export function unpackVif(chain: Chain): VuPacket[] {
  const citations: { vifOffset: number; name: string }[] = [];
  let cited = 0;
  for (const tag of chain.tags) {
    if (tag.reloc !== TEXTURE_RELOC) continue;
    const name = chain.textureNames[cited++];
    if (name !== undefined) citations.push({ vifOffset: tag.vifOffset, name });
  }
  const textureAt = (offset: number): string | null => {
    for (let i = citations.length - 1; i >= 0; i--) if (citations[i]!.vifOffset <= offset) return citations[i]!.name;
    return null;
  };
  return splitPackets(chain.vif, textureAt);
}

/** The same, for a bare stream with no chain around it to name textures. */
export function unpackVifStream(vif: Uint8Array): VuPacket[] {
  return splitPackets(vif, () => null);
}
