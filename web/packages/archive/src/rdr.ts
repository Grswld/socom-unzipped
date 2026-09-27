import { Reader } from './bytes';

/** A decoded compiled script: a token, or a list of them. Numbers keep their source spelling, the way
 *  the uncompiled `.rdr` text had them -- callers that want a number call `Number()`. */
export type RdrNode = string | RdrNode[];

// 36 §6. The codes are the ones the scratch rdr.py decoded five maps' scripts with.
const TYPE_INT = 1, TYPE_FLOAT = 2, TYPE_STRING = 3, TYPE_LIST = 4;
const STRINGS_AT = 12;   // 36 §6: a string's `value` is a byte offset from the end of the 12-byte head
const NODE_SIZE = 8;
const MAX_DEPTH = 64;    // a list may point back at itself; nothing else stops the walk

/** The shortest decimal that still reads back as this f32, so `0.1` stays `0.1` and not `0.10000000149011612`. */
function f32Text(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  for (let digits = 1; digits <= 9; digits++) {
    const short = Number(v.toPrecision(digits));
    if (Math.fround(short) === v) return String(short);
  }
  return String(v);
}

/**
 * Reads a compiled `.rdr` script out of `READERM.ZAR` (36 §6):
 * `{u32 version=1; u32 string_table_size; u32 node_array_offset}`, the string table, then 8-byte nodes
 * `{u32 (type:8, isclone:1, packed:1, unused:6, length:16); u32 value}`. Returns the root node, a list.
 */
export function parseRdr(bytes: Uint8Array): RdrNode {
  const r = new Reader(bytes);
  const version = r.u32(0);
  if (version !== 1) throw new Error(`rdr version ${version}, expected 1`);
  const stringTableSize = r.u32(4), nodesAt = r.u32(8);

  const node = (byteOfs: number, depth: number): RdrNode => {
    if (depth > MAX_DEPTH) throw new Error(`rdr nesting deeper than ${MAX_DEPTH} at node byte ${byteOfs}`);
    const word = r.u32(nodesAt + byteOfs), value = r.u32(nodesAt + byteOfs + 4);
    const type = word & 0xff, length = word >>> 16;   // the isclone/packed flags in bits 8-9 are load-time hints
    switch (type) {
      case TYPE_INT: return String(r.i32(nodesAt + byteOfs + 4));
      case TYPE_FLOAT: return f32Text(r.f32(nodesAt + byteOfs + 4));
      case TYPE_STRING: {
        if (value >= stringTableSize) throw new Error(`rdr string at ${value} outside the ${stringTableSize}-byte table`);
        return r.cstr(STRINGS_AT + value, stringTableSize - value);
      }
      case TYPE_LIST: {
        const out: RdrNode[] = [];
        for (let i = 0; i < length; i++) out.push(node(value + NODE_SIZE * i, depth + 1));
        return out;
      }
      default: throw new Error(`rdr node type ${type} at node byte ${byteOfs}`);
    }
  };
  return node(0, 0);
}

/**
 * Fetches a key out of a decoded script. A record is a flat list alternating a key string with the list of
 * values that followed it -- `("description" ("FROSTFIRE") "elevation" ("max" (100) "min" (142)))` -- so the
 * result is that value list, or its single element when it holds exactly one. A list that only wraps another
 * list is looked through, which is how the root of every compiled file wraps its one record.
 */
export function rdrGet(node: RdrNode, key: string): RdrNode | undefined {
  let current = node;
  for (let depth = 0; depth <= MAX_DEPTH; depth++) {
    if (typeof current === 'string') return undefined;
    for (let i = 0; i + 1 < current.length; i++) {
      if (current[i] === key) {
        const value = current[i + 1]!;
        return Array.isArray(value) && value.length === 1 ? value[0]! : value;
      }
    }
    const only = current.length === 1 ? current[0]! : undefined;
    if (only === undefined || typeof only === 'string') return undefined;
    current = only;
  }
  return undefined;
}
