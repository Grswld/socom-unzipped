import { Reader } from './bytes';

/** One member of a ZDB archive: its disc path, and where its bytes sit in the archive. */
export interface ZdbEntry { name: string; offset: number; size: number }

const HEADER = 0xa0, COUNT_AT = 0x98, ENTRY_SIZE_AT = 0x9c, ENTRY_SIZE = 0x5c; // 36 §1

/** Reads a ZDB archive's table of contents. */
export function parseZdb(bytes: Uint8Array): ZdbEntry[] {
  const r = new Reader(bytes);
  const entrySize = r.u32(ENTRY_SIZE_AT);
  if (entrySize !== ENTRY_SIZE) throw new Error(`ZDB entrySize ${entrySize}, expected 0x5C`);
  const count = r.u32(COUNT_AT);
  const out: ZdbEntry[] = [];
  for (let i = 0; i < count; i++) {
    const o = HEADER + i * ENTRY_SIZE;
    if (r.u32(o) !== ENTRY_SIZE) throw new Error(`ZDB entry ${i} size field ${r.u32(o)}`);
    const name = r.cstr(o + 4, 64);            // char name[64], garbage after the NUL
    const offset = r.u32(o + 68);              // absolute, 2048-aligned
    const size = r.u32(o + 72);                // 36 §1: the member's length in bytes
    if (offset + size > bytes.byteLength) throw new Error(`ZDB entry ${name} runs past the file`);
    out.push({ name, offset, size });
  }
  return out;
}

/** The one member whose disc path ends with `suffix` (case-insensitive); throws if absent or ambiguous. */
export function zdbMember(bytes: Uint8Array, entries: ZdbEntry[], suffix: string): Uint8Array {
  const s = suffix.toLowerCase();
  const hits = entries.filter((e) => e.name.toLowerCase().endsWith(s));
  if (hits.length !== 1) throw new Error(`ZDB member ${suffix}: ${hits.length} matches`);
  const e = hits[0]!;
  return bytes.subarray(e.offset, e.offset + e.size);
}
