import { Reader } from './bytes';

/** One key of a ZAR/ZED archive: its name, where its bytes sit in the data blob, and its children. */
export interface ZarKey { name: string; offset: number; size: number; children: ZarKey[] }

const HEAD = 100, V2 = 0x20002; // 36 §1

/** A v2 ZAR/ZED archive: a pre-order key tree over one data blob. */
export class Zar {
  private constructor(readonly root: ZarKey, readonly keyCount: number, readonly version: number,
                      private readonly blob: Uint8Array) {}

  static parse(bytes: Uint8Array): Zar {
    const r = new Reader(bytes);
    // 36 §1: 100-byte head, string table, key_count 16-byte keys in pre-order, align to padding, data blob.
    const flags = r.u32(0), keyCount = r.u32(4), stableSize = r.u32(8), stableOfs = r.u32(12), padding = r.u32(16);
    const dataSize = r.u32(84), version = r.u32(96);
    if (version !== V2) throw new Error(`ZAR version 0x${version.toString(16)}, only 0x20002 supported`);
    if (flags !== 0) throw new Error(`ZAR flags ${flags}: securified archives are not supported`);
    if (padding <= 0) throw new Error(`ZAR padding ${padding}: the data blob's alignment must be positive`);
    const stableAt = HEAD, keysAt = stableAt + stableSize;
    const dataAt = Math.ceil((keysAt + 16 * keyCount) / padding) * padding;
    const blob = r.slice(dataAt, Math.min(dataSize, bytes.byteLength - dataAt));
    let i = 0;
    const readKey = (isRoot: boolean): ZarKey => {
      if (i >= keyCount) throw new Error(`ZAR key tree overran key_count ${keyCount}`);
      const index = i, o = keysAt + 16 * i++;
      // The root record carries only its child count: the engine leaves its name, offset and size unread
      // (zar_main.cpp:57-62), and retail writes a null name pointer there. Every other name is a pointer
      // into the string table, relative to the address the table was packed at (36 §1).
      let key: ZarKey;
      if (isRoot) key = { name: '', offset: 0, size: 0, children: [] };
      else {
        const nameOfs = r.i32(o) - stableOfs;
        if (nameOfs < 0 || nameOfs >= stableSize) throw new Error(`ZAR key ${index}: name offset ${nameOfs} outside the ${stableSize}-byte string table`);
        key = { name: r.cstr(stableAt + nameOfs, stableSize - nameOfs), offset: r.u32(o + 4), size: r.u32(o + 8), children: [] };
      }
      const n = r.i32(o + 12);                  // immediate children, each a full pre-order record (36 §1)
      for (let c = 0; c < n; c++) key.children.push(readKey(false));
      return key;
    };
    const root = readKey(true);
    if (i !== keyCount) throw new Error(`ZAR key tree consumed ${i} of key_count ${keyCount}`);
    return new Zar(root, keyCount, version, blob);
  }

  /** The key's bytes: a view into the data blob (36 §1: key.offset is blob-relative). */
  data(key: ZarKey): Uint8Array {
    if (key.offset + key.size > this.blob.byteLength) throw new RangeError(`key ${key.name} outside data blob`);
    return this.blob.subarray(key.offset, key.offset + key.size);
  }

  child(key: ZarKey, name: string): ZarKey | undefined { return key.children.find((k) => k.name === name); }

  /** "models/alaska4d_x/nparams", names matched exactly, walked from the root's children. */
  find(path: string): ZarKey | undefined {
    let k: ZarKey | undefined = this.root;
    for (const part of path.split('/')) { if (!k) return undefined; k = this.child(k, part); }
    return k;
  }

  /** Pre-order, the root at depth 0. */
  walk(visit: (key: ZarKey, depth: number) => void): void {
    const rec = (k: ZarKey, d: number) => { visit(k, d); for (const c of k.children) rec(c, d + 1); };
    rec(this.root, 0);
  }
}
