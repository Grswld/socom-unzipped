import { Reader } from './bytes';

/** One member of a ZDB archive: its disc path, and where its bytes sit in the archive. */
export interface ZdbEntry { name: string; offset: number; size: number }

const HEADER = 0xa0, COUNT_AT = 0x98, ENTRY_SIZE_AT = 0x9c, ENTRY_SIZE = 0x5c; // 36 §1

/** The bytes a ZDB's header takes: enough to learn how long its table of contents is (36 §1). */
export const ZDB_HEAD = HEADER;

/**
 * How many bytes from the start of an archive its table of contents runs to, from the header alone:
 * a source that reads by range (the ISO) fetches this much and then only the members it wants.
 */
export function zdbTocLength(head: Uint8Array): number {
  const r = new Reader(head);
  return HEADER + r.u32(COUNT_AT) * r.u32(ENTRY_SIZE_AT);
}

/**
 * Reads a ZDB archive's table of contents. `bytes` is the archive, or its first `zdbTocLength` bytes and
 * then `fileSize` is the archive's whole length, which every member is still checked against.
 */
export function parseZdb(bytes: Uint8Array, fileSize = bytes.byteLength): ZdbEntry[] {
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
    if (offset + size > fileSize) throw new Error(`ZDB entry ${name} runs past the file`);
    out.push({ name, offset, size });
  }
  return out;
}

/**
 * The one entry whose disc path ends with `suffix` (case-insensitive); throws if absent or ambiguous. Where
 * several end with it, the one whose file name *is* the suffix wins: a mission's `M51_TXR.ZED` beside its
 * `ZM51_TXR.ZED`.
 */
export function zdbEntry(entries: ZdbEntry[], suffix: string): ZdbEntry {
  const s = suffix.toLowerCase();
  let hits = entries.filter((e) => e.name.toLowerCase().endsWith(s));
  if (hits.length > 1) {
    const exact = hits.filter((e) => /[\\/]/.test(e.name.charAt(e.name.length - s.length - 1)));
    if (exact.length > 0) hits = exact;
  }
  if (hits.length !== 1) throw new Error(`ZDB member ${suffix}: ${hits.length} matches`);
  return hits[0]!;
}

/** The one member whose disc path ends with `suffix` (case-insensitive); throws if absent or ambiguous. */
export function zdbMember(bytes: Uint8Array, entries: ZdbEntry[], suffix: string): Uint8Array {
  const e = zdbEntry(entries, suffix);
  return bytes.subarray(e.offset, e.offset + e.size);
}
