/**
 * A v2 ZAR/ZED writer for tests (web/docs/research/72 §1): 100-byte head, the string table, 16-byte keys in
 * pre-order, the data blob aligned to the padding. Enough to stand a synthetic `CLIB_GEO.ZED` model tree
 * up in front of the reader that parses the real one.
 */
export interface ZarTree { name: string; data?: Uint8Array; children?: ZarTree[] }

export function writeZar(children: ZarTree[]): Uint8Array {
  const PADDING = 16, TABLE_AT = 0x1000;
  const names: string[] = [];
  const records: { name: number; offset: number; size: number; count: number }[] = [];
  const blobs: Uint8Array[] = [];
  let blobLength = 0;
  const nameOf = (n: string): number => {
    let at = 0;
    for (const x of names) { if (x === n) return at; at += x.length + 1; }
    names.push(n);
    return at;
  };
  const visit = (node: ZarTree): void => {
    let offset = 0, size = 0;
    if (node.data) {
      offset = blobLength;
      size = node.data.byteLength;
      blobs.push(node.data);
      blobLength += Math.ceil(size / PADDING) * PADDING;
    }
    records.push({ name: TABLE_AT + nameOf(node.name), offset, size, count: node.children?.length ?? 0 });
    for (const c of node.children ?? []) visit(c);
  };
  records.push({ name: 0, offset: 0, size: 0, count: children.length });
  for (const c of children) visit(c);
  const table = new TextEncoder().encode(names.map((n) => `${n}\0`).join(''));
  const keysAt = 100 + table.byteLength;
  const dataAt = Math.ceil((keysAt + 16 * records.length) / PADDING) * PADDING;
  const out = new Uint8Array(dataAt + blobLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(4, records.length, true);
  dv.setUint32(8, table.byteLength, true);
  dv.setUint32(12, TABLE_AT, true);
  dv.setUint32(16, PADDING, true);
  dv.setUint32(84, blobLength, true);
  dv.setUint32(96, 0x20002, true);
  out.set(table, 100);
  records.forEach((k, i) => {
    const o = keysAt + 16 * i;
    dv.setInt32(o, k.name, true); dv.setUint32(o + 4, k.offset, true); dv.setUint32(o + 8, k.size, true); dv.setInt32(o + 12, k.count, true);
  });
  let at = dataAt;
  for (const b of blobs) { out.set(b, at); at += Math.ceil(b.byteLength / PADDING) * PADDING; }
  return out;
}

/** Little-endian u32 and f32 payloads. */
export const u32 = (x: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, x, true); return b; };
export function nparams(matrix: number[], opts: { bbox?: number[]; type?: number; flags?: number } = {}): Uint8Array {
  const b = new Uint8Array(96);
  const dv = new DataView(b.buffer);
  matrix.forEach((x, i) => dv.setFloat32(i * 4, x, true));
  (opts.bbox ?? [0, 0, 0, 0, 0, 0]).forEach((x, i) => dv.setFloat32(64 + i * 4, x, true));
  dv.setUint32(88, opts.type ?? 1, true);
  dv.setUint32(92, opts.flags ?? 0x80840051, true);
  return b;
}
