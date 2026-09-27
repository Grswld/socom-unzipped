import { Reader, type Zar, type ZarKey } from '@s2u/archive';

/**
 * One 16-byte DMA source tag of a model chunk's chain, as `CVisual::SetBuffer` reads it (36 §3).
 * `id` is the DMAC tag id: 0 refe, 1 cnt, 2 next, 3 ref, 4 refs, 5 call, 6 ret, 7 end.
 *
 * `vifOffset` is where this tag's contribution starts in the chain's assembled `vif` stream. A texture
 * citation contributes nothing, so its `vifOffset` is where the *next* tag's bytes land: the packet it
 * names is the one that begins there.
 */
export interface DmaTag {
  qwc: number; reloc: number; id: number; addr: number; vif0: number; vif1: number;
  tagOffset: number; vifOffset: number;
}

/** One chunk of a model: its chain of DMA tags, the textures it cites, and the VIF1 stream they transfer. */
export interface Chain {
  nodeName: string;
  headerOffset: number;
  tags: DmaTag[];
  /** The first texture the chain cites, i.e. the one its first sub-packet draws with. */
  textureName: string | null;
  /** Every texture the chain cites, in tag order: one per sub-packet, and a chunk draws several (36 §3). */
  textureNames: string[];
  /** The linear VIF1 byte stream: per tag the two tag-transfer codes, then the quadwords they transfer. */
  vif: Uint8Array;
}

const TAG_SIZE = 16;              // 36 §3: the count quadword and every DMA tag are one quadword
const QUADWORD = 16;              // 36 §3: QWC counts quadwords
const TEXTURE_RELOC = 6;          // 36 §3: ADDR is a texture-name offset, resolved by CVisual::ResolveTextureName
const MAX_TEXTURE_NAME = 64;      // the engine's name buffer
const ID_REFE = 0, ID_CNT = 1, ID_REF = 3;
const ID_NAMES = ['refe', 'cnt', 'next', 'ref', 'refs', 'call', 'ret', 'end'];

/**
 * The chunk offsets of a model: each child key of the model key holds a single u32, the byte offset of that
 * chunk's chain header inside the model's buffer (36 §3). A child whose bytes are not exactly 4 long is not
 * a chunk pointer and is skipped.
 */
export function modelNodes(zar: Zar, model: ZarKey): { name: string; offset: number }[] {
  const nodes: { name: string; offset: number }[] = [];
  for (const child of model.children) {
    if (child.size !== 4) continue;
    nodes.push({ name: child.name, offset: new Reader(zar.data(child)).u32(0) });
  }
  return nodes;
}

/**
 * Walks one chunk's DMA chain and assembles the VIF1 stream the DMAC would have fed VIF1.
 *
 * 36 §3: `headerOffset` points at a count quadword whose first byte is the tag count
 * (`m_dmaQwc = *tag[0].u8`); the tags start one quadword later (`m_dmaChain = &tag[1]`). Tag word 0 carries
 * QWC in bits 0-15, the relocation type in bits 16-23 and the DMA id in bits 28-30; word 1 is ADDR, a byte
 * offset inside this same buffer; words 2-3 are the two tag-transfer VIF1 codes.
 */
export function walkChain(buffer: Uint8Array, headerOffset: number, nodeName: string): Chain {
  const r = new Reader(buffer);
  const where = (tagOffset: number) => `chain ${nodeName} tag at 0x${tagOffset.toString(16)}`;
  const count = r.u8(headerOffset);                        // 36 §3: m_dmaQwc = *tag[0].u8
  const tags: DmaTag[] = [];
  const textureNames: string[] = [];
  const parts: Uint8Array[] = [];
  let vifLength = 0;                                       // how much of the VIF stream the tags so far built
  let cursor = headerOffset + TAG_SIZE;                    // 36 §3: m_dmaChain = &tag[1]
  for (let i = 0; i < count; i++) {
    const o = cursor;
    if (o + TAG_SIZE > buffer.byteLength) throw new RangeError(`${where(o)} runs past the ${buffer.byteLength}-byte model buffer`);
    const w0 = r.u32(o);                                   // 36 §3: QWC | reloc | id
    const tag: DmaTag = {
      qwc: w0 & 0xffff, reloc: (w0 >>> 16) & 0xff, id: (w0 >>> 28) & 7,
      addr: r.u32(o + 4), vif0: r.u32(o + 8), vif1: r.u32(o + 12), tagOffset: o, vifOffset: vifLength,
    };
    tags.push(tag);
    cursor = o + TAG_SIZE;

    // A texture citation, not a transfer: retail writes these as `cnt` tags with QWC=0, so the relocation
    // type decides before the DMA id does (36 §3).
    if (tag.reloc === TEXTURE_RELOC) {
      // Retail never pairs a citation with a transfer. If one did, returning here would leave the cursor
      // inside its payload and every later tag in the chain would be read out of rubbish, so it throws.
      if (tag.qwc !== 0) throw new Error(`${where(o)}: texture citation with QWC ${tag.qwc}, expected 0`);
      if (tag.addr >= buffer.byteLength) throw new RangeError(`${where(o)}: texture name at 0x${tag.addr.toString(16)} outside the ${buffer.byteLength}-byte model buffer`);
      textureNames.push(r.cstr(tag.addr, Math.min(MAX_TEXTURE_NAME, buffer.byteLength - tag.addr)));
      continue;
    }

    parts.push(r.slice(o + 8, 8));                         // 36 §3: words 2-3, the tag-transfer VIF1 codes
    const bytes = tag.qwc * QUADWORD;
    vifLength += 8 + bytes;
    if (tag.id === ID_REF || tag.id === ID_REFE) {
      if (tag.addr + bytes > buffer.byteLength) throw new RangeError(`${where(o)}: ${bytes} bytes at 0x${tag.addr.toString(16)} outside the ${buffer.byteLength}-byte model buffer`);
      parts.push(r.slice(tag.addr, bytes));
    } else if (tag.id === ID_CNT) {
      if (cursor + bytes > buffer.byteLength) throw new RangeError(`${where(o)}: ${bytes} bytes following the tag outside the ${buffer.byteLength}-byte model buffer`);
      parts.push(r.slice(cursor, bytes));
      cursor += bytes;
    } else {
      throw new Error(`${where(o)}: DMA id ${tag.id} (${ID_NAMES[tag.id]}) is not part of a model chain`);
    }
  }

  const vif = new Uint8Array(vifLength);
  let at = 0;
  for (const p of parts) { vif.set(p, at); at += p.byteLength; }
  return { nodeName, headerOffset, tags, textureName: textureNames[0] ?? null, textureNames, vif };
}

/** Every chunk of a model, in key order. */
export function walkModel(buffer: Uint8Array, nodes: { name: string; offset: number }[]): Chain[] {
  return nodes.map((n) => walkChain(buffer, n.offset, n.name));
}
