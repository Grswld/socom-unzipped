/**
 * A hand-built v2 ZAR (research 36 §1, the layout `@s2u/archive`'s `Zar.parse` reads): a 100-byte head, the string
 * table, one 16-byte record per key in pre-order, the data blob aligned to `padding`. The motion and zAnim tests
 * pack their synthetic members with it, so CI reads the same container path the fixtures do with no disc byte.
 */

/** One key: its name, its bytes (a key with none has size 0), its children in order. */
export interface KeySpec { name: string; data?: Uint8Array; children?: KeySpec[] }

/** Little-endian scalars for building member bytes. */
export const u32 = (...v: number[]): Uint8Array => {
  const b = new Uint8Array(4 * v.length);
  const dv = new DataView(b.buffer);
  v.forEach((x, i) => dv.setUint32(4 * i, x >>> 0, true));
  return b;
};
export const i16 = (...v: number[]): Uint8Array => {
  const b = new Uint8Array(2 * v.length);
  const dv = new DataView(b.buffer);
  v.forEach((x, i) => dv.setInt16(2 * i, x, true));
  return b;
};
export const u16 = (...v: number[]): Uint8Array => {
  const b = new Uint8Array(2 * v.length);
  const dv = new DataView(b.buffer);
  v.forEach((x, i) => dv.setUint16(2 * i, x, true));
  return b;
};
export const f32 = (...v: number[]): Uint8Array => {
  const b = new Uint8Array(4 * v.length);
  const dv = new DataView(b.buffer);
  v.forEach((x, i) => dv.setFloat32(4 * i, x, true));
  return b;
};
export const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** Packs the root's children into a ZAR. Every member's bytes start 16-aligned in the blob. */
export function buildZar(children: KeySpec[]): Uint8Array {
  const flat: { spec: KeySpec; count: number }[] = [];
  const walk = (k: KeySpec): void => { flat.push({ spec: k, count: k.children?.length ?? 0 }); for (const c of k.children ?? []) walk(c); };
  for (const c of children) walk(c);

  const names: number[] = [];
  const nameOfs = flat.map(({ spec }) => {
    const at = names.length;
    for (const ch of spec.name) names.push(ch.charCodeAt(0) & 0xff);
    names.push(0);
    return at;
  });
  const blobParts: Uint8Array[] = [];
  let blobSize = 0;
  const dataOfs = flat.map(({ spec }) => {
    if (!spec.data?.length) return 0;
    const at = blobSize;
    const padded = Math.ceil(spec.data.length / 16) * 16;
    const chunk = new Uint8Array(padded);
    chunk.set(spec.data);
    blobParts.push(chunk);
    blobSize += padded;
    return at;
  });

  const HEAD = 100, padding = 16, STABLE_AT = 0x1000;
  const keyCount = flat.length + 1;
  const keysAt = HEAD + names.length;
  const dataAt = Math.ceil((keysAt + 16 * keyCount) / padding) * padding;
  const out = new Uint8Array(dataAt + blobSize);
  const dv = new DataView(out.buffer);
  dv.setUint32(4, keyCount, true);
  dv.setUint32(8, names.length, true);
  dv.setUint32(12, STABLE_AT, true);
  dv.setUint32(16, padding, true);
  dv.setUint32(84, blobSize, true);
  dv.setUint32(96, 0x20002, true);
  out.set(names, HEAD);
  dv.setInt32(keysAt + 12, children.length, true);           // the root record: child count only
  flat.forEach(({ spec, count }, i) => {
    const o = keysAt + 16 * (i + 1);
    dv.setInt32(o, STABLE_AT + nameOfs[i]!, true);
    dv.setUint32(o + 4, dataOfs[i]!, true);
    dv.setUint32(o + 8, spec.data?.length ?? 0, true);
    dv.setInt32(o + 12, count, true);
  });
  out.set(cat(...blobParts), dataAt);
  return out;
}
