/**
 * A hand-built `AIMAPS.MPS` (web/docs/research/75), shared by `aimaps.test.ts` and the viewer's
 * `spawnSlots.test.ts`, which packs it into a hand-built ZDB to read it the way the worker does. It is the
 * file CI runs: no byte of it comes from the disc.
 */

/** Little-endian writer for the synthetic file. */
export class Out {
  private readonly bytes: number[] = [];
  u32(v: number): this { const x = v >>> 0; this.bytes.push(x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, x >>> 24); return this; }
  f32(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    this.bytes.push(...b);
    return this;
  }
  text(s: string, n: number): this {
    for (let i = 0; i < n; i++) this.bytes.push(i < s.length ? s.charCodeAt(i) : 0);
    return this;
  }
  get length(): number { return this.bytes.length; }
  done(): Uint8Array { return Uint8Array.from(this.bytes); }
}

/** CAiMapLoc as the file stores it: map in the low 6 bits, then x (13), then z (13) -- 75 §4. */
export const loc = (map: number, x: number, z: number): number => (map | (x << 6) | (z << 19)) >>> 0;

const STAMP = 0x2f2d8537;   // Frostfire BaseMap's word at +0x7c: 2003-09-13 16:41:46 as an MS-DOS date-time

/** A sub-map header, 0xA8 bytes (75 §3), with the pad at +0x88 holding text the reader must ignore. */
function head(o: Out, name: string, min: number[], max: number[], cellsX: number, cellsZ: number, id: number, cells: number): void {
  const at = o.length;
  o.u32(0x17);
  for (const v of min) o.f32(v);
  for (const v of max) o.f32(v);
  o.u32(cellsX).u32(cellsZ).f32(10).f32(10).f32(0.1).f32(0.1).u32(id).text(name, 32);
  o.f32(0.5).u32(2).f32(Math.PI / 4).u32(4).u32(0).u32(0).u32(1).u32(cells);
  o.u32(0x20280920).u32(STAMP).u32(STAMP).u32(0).text('lor( 87 112 176 )\tOpacity( 0.5 )', 32);
  if (o.length - at !== 0xa8) throw new Error(`test header is ${o.length - at} bytes`);
}

/**
 * Two sub-maps. BaseMap: 4 x 3 cells of 10 units from (100, 200); row 0 stores x 1-2, row 1 x 0-3, row 2
 * nothing; one named point, one marker, one link to Ramps, one zone, three spawn records, one polyline.
 * Ramps: one cell. Then the trailer: the link block (one link word) and the spawn list again.
 */
export function syntheticAiMaps(): Uint8Array {
  const o = new Out();
  o.u32(2).u32(2).text('', 32);

  head(o, 'BaseMap', [100, 0, 200], [140, 50, 230], 4, 3, 0, 6);
  // cells: row 0 x 1..2, row 1 x 0..3; (2,1) is the named point's cell, marker 3 in bits 5-7.
  for (const w of [0x8000000a, 0x80000001, 0x80000001, 0x80000001, 0x80000061, 0x80000001]) o.u32(w).u32(0xffffffff);
  o.u32(1 | (3 << 16)).u32(0).u32(0xaac9e8);
  o.u32(0 | (4 << 16)).u32(2).u32(0xaacba0);
  o.u32(4 | (4 << 16)).u32(6).u32(0xaacd58);                 // an empty row: x0 == x1 == cellsX
  o.u32(1).u32(loc(0, 2, 1)).text('PlayerStart', 16).u32(0x00990208);
  o.u32(1).u32(loc(0, 1, 0)).u32(0x608ffff0).text('(sat', 32);
  o.u32(1).u32(loc(0, 3, 1)).u32(loc(1, 0, 0)).u32(8);
  o.u32(1).u32(loc(0, 0, 1)).u32(2 | (1 << 16)).u32(1).text('Safety', 16);
  const spawns = [[loc(0, 1, 0), 0x00, 0x0012f97c], [loc(0, 2, 0), 0x10, 0x0012f97c], [loc(0, 3, 1), 0x24, 0x00dd020a]];
  o.u32(3);
  for (const s of spawns) o.u32(s[0]!).u32(s[1]!).u32(s[2]!);
  o.u32(1).u32(2).u32(loc(0, 0, 0)).u32(loc(0, 3, 2)).u32(0);
  o.u32(0).u32(0);
  for (let i = 0; i < 6; i++) o.u32(0x197fff7f);

  head(o, 'Ramps', [110, 20, 200], [130, 20, 210], 2, 1, 3, 1);
  o.u32(0x80000001).u32(0xffffffff);
  o.u32(0 | (1 << 16)).u32(0).u32(0);
  for (let t = 0; t < 8; t++) o.u32(0);
  o.u32(0x007fff7f);

  o.u32(1).u32(16 + 4).u32(1).u32(0).u32(0x000e8090);
  o.u32(3);
  for (const s of [spawns[2]!, spawns[0]!, spawns[1]!]) o.u32(s[0]!).u32(s[1]!).u32(s[2]!);
  return o.done();
}
