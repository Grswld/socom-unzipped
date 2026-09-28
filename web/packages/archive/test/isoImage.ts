/**
 * A small ISO9660 writer for the tests: no disc image lives in the repository (no game data does), so
 * `IsoAssetSource` is proven against images this builds in memory, from synthetic members or from the
 * extracted fixtures.
 *
 * It writes what ECMA-119 (ISO 9660:1988) asks of a level-1 image, as mastering tools write it: an empty
 * system area (sectors 0-15), the Primary Volume Descriptor at sector 16 (§8.4) and the set terminator
 * after it (§8.3), a type L and a type M path table (§9.4), every directory as an extent of 2048-byte
 * sectors holding `.` and `..` first and then its entries in identifier order (§6.8.1, §9.3), with no
 * record crossing a sector boundary (§6.8.1), and every file as one extent padded to the next sector.
 * Numeric fields are written in the byte orders §7.2-7.3 name: both-endian where the standard records
 * both, little-endian in the L table and big-endian in the M table. File identifiers carry the `;1`
 * version (§7.5.1), which is what a real retail disc holds and what `tools_py/iso_lbn.py` strips.
 *
 * It is test support, not a product: names are upper-cased and taken as given (no 8.3 check), and every
 * file is one extent. It is pure TypeScript over `Uint8Array`, so the vitest suite and the Playwright spec
 * can both import it.
 */
export const SECTOR = 2048;

export interface IsoMember { path: string; bytes: Uint8Array }

interface Dir {
  name: string;
  parent: Dir | null;
  dirs: Map<string, Dir>;
  files: Map<string, Uint8Array>;
  /** Its number in the path table, from 1 (§9.4.4). */
  number: number;
  lbn: number;
  size: number;
}

/** One entry a directory records, in the order §9.3 wants them. */
interface Entry { id: Uint8Array; lbn: () => number; size: () => number; flags: number }

const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

/** §9.1: 33 fixed bytes, the identifier, and a pad byte when the identifier's length is even. */
const recordLength = (idLength: number): number => 33 + idLength + (idLength % 2 === 0 ? 1 : 0);

/** §9.4: 8 fixed bytes, the identifier, and a pad byte when its length is odd. */
const pathRecordLength = (idLength: number): number => 8 + idLength + (idLength % 2 === 1 ? 1 : 0);

/** 2004-01-01 00:00:00 GMT, in the seven-byte form of §9.1.5. A fixed date keeps the image reproducible. */
const RECORD_DATE = [104, 1, 1, 0, 0, 0, 0];
/** The same instant in the seventeen-byte form of §8.4.26: sixteen digits and the GMT offset. */
const VOLUME_DATE = [...ascii('2004010100000000'), 0];

function both16(view: DataView, at: number, v: number): void { view.setUint16(at, v, true); view.setUint16(at + 2, v, false); }
function both32(view: DataView, at: number, v: number): void { view.setUint32(at, v, true); view.setUint32(at + 4, v, false); }

/** Pads a string field with spaces, as §7.4 fills the unused positions of an a- or d-character field. */
function text(out: Uint8Array, at: number, length: number, s: string): void {
  out.fill(0x20, at, at + length);
  out.set(ascii(s.toUpperCase()).subarray(0, length), at);
}

/** A directory record (§9.1) at `at`; returns its length. */
function writeRecord(out: Uint8Array, at: number, id: Uint8Array, lbn: number, size: number, flags: number): number {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const length = recordLength(id.length);
  out[at] = length;                    // BP1 length of the record
  out[at + 1] = 0;                     // BP2 extended attribute record length
  both32(view, at + 2, lbn);           // BP3-10 location of extent
  both32(view, at + 10, size);         // BP11-18 data length
  out.set(RECORD_DATE, at + 18);       // BP19-25 recording date and time
  out[at + 25] = flags;                // BP26 file flags: bit 1 is a directory
  out[at + 26] = 0;                    // BP27 file unit size: not interleaved
  out[at + 27] = 0;                    // BP28 interleave gap size
  both16(view, at + 28, 1);            // BP29-32 volume sequence number
  out[at + 32] = id.length;            // BP33 length of file identifier
  out.set(id, at + 33);                // BP34- file identifier
  return length;
}

/** Lays records into sectors with none crossing a boundary (§6.8.1); returns the byte offset of each and the size. */
function layOut(lengths: number[]): { offsets: number[]; size: number } {
  const offsets: number[] = [];
  let at = 0;
  for (const length of lengths) {
    if (Math.floor(at / SECTOR) !== Math.floor((at + length - 1) / SECTOR)) at = Math.ceil(at / SECTOR) * SECTOR;
    offsets.push(at);
    at += length;
  }
  return { offsets, size: Math.max(1, Math.ceil(at / SECTOR)) * SECTOR };
}

const sectors = (bytes: number): number => Math.ceil(bytes / SECTOR);

/**
 * An ISO9660 image holding `members`, each at its forward-slash path (`RUN/MP2.ZDB`). Directories are
 * made as the paths need them, to any depth.
 */
export function buildIso(members: IsoMember[], volumeId = 'S2U_TEST'): Uint8Array<ArrayBuffer> {
  const root: Dir = { name: '', parent: null, dirs: new Map(), files: new Map(), number: 1, lbn: 0, size: 0 };
  for (const { path, bytes } of members) {
    const parts = path.toUpperCase().split('/').filter((p) => p.length > 0);
    const file = parts.pop();
    if (!file) throw new Error(`buildIso: empty path ${path}`);
    let dir = root;
    for (const part of parts) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = { name: part, parent: dir, dirs: new Map(), files: new Map(), number: 0, lbn: 0, size: 0 };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.set(file, bytes);
  }

  // §9.4.4: the path table orders directories by level, then by their parent's number, then by name.
  const order: Dir[] = [root];
  for (let i = 0; i < order.length; i++) {
    const children = [...order[i]!.dirs.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) order.push(child);
  }
  order.forEach((d, i) => { d.number = i + 1; });

  // The entries of each directory: `.` and `..` (identifiers 0x00 and 0x01, §7.6.2), then the rest by
  // identifier, a file's including its `;1`.
  const entriesOf = new Map<Dir, Entry[]>();
  const fileLbn = new Map<Uint8Array, number>();
  for (const d of order) {
    const named: Entry[] = [
      ...[...d.dirs.values()].map((c) => ({ id: ascii(c.name), lbn: () => c.lbn, size: () => c.size, flags: 2 })),
      ...[...d.files.entries()].map(([name, bytes]) => {
        // §7.5.1: the first separator is recorded even when there is no extension.
        const id = ascii(`${name.includes('.') ? name : `${name}.`};1`);
        return { id, lbn: () => fileLbn.get(bytes) ?? 0, size: () => bytes.length, flags: 0 };
      }),
    ].sort((a, b) => compareIds(a.id, b.id));
    const parent = d.parent ?? d;
    entriesOf.set(d, [
      { id: new Uint8Array([0]), lbn: () => d.lbn, size: () => d.size, flags: 2 },
      { id: new Uint8Array([1]), lbn: () => parent.lbn, size: () => parent.size, flags: 2 },
      ...named,
    ]);
    d.size = layOut(entriesOf.get(d)!.map((e) => recordLength(e.id.length))).size;
  }

  const pathTableSize = order.reduce((n, d) => n + pathRecordLength(d === root ? 1 : d.name.length), 0);
  const L = 18;
  const M = L + sectors(pathTableSize);
  let next = M + sectors(pathTableSize);
  for (const d of order) { d.lbn = next; next += d.size / SECTOR; }
  for (const d of order) {
    for (const bytes of d.files.values()) {
      if (fileLbn.has(bytes)) continue;
      fileLbn.set(bytes, next);
      next += sectors(bytes.length);
    }
  }
  const total = next;

  const out = new Uint8Array(total * SECTOR);
  const view = new DataView(out.buffer);

  // §8.4: the Primary Volume Descriptor.
  const pvd = 16 * SECTOR;
  out[pvd] = 1;                                   // BP1 volume descriptor type
  out.set(ascii('CD001'), pvd + 1);               // BP2-6 standard identifier
  out[pvd + 6] = 1;                               // BP7 volume descriptor version
  text(out, pvd + 8, 32, 'PLAYSTATION');          // BP9-40 system identifier
  text(out, pvd + 40, 32, volumeId);              // BP41-72 volume identifier
  both32(view, pvd + 80, total);                  // BP81-88 volume space size
  both16(view, pvd + 120, 1);                     // BP121-124 volume set size
  both16(view, pvd + 124, 1);                     // BP125-128 volume sequence number
  both16(view, pvd + 128, SECTOR);                // BP129-132 logical block size
  both32(view, pvd + 132, pathTableSize);         // BP133-140 path table size
  view.setUint32(pvd + 140, L, true);             // BP141-144 location of the type L path table
  view.setUint32(pvd + 148, M, false);            // BP149-152 location of the type M path table
  writeRecord(out, pvd + 156, new Uint8Array([0]), root.lbn, root.size, 2); // BP157-190 the root's record
  for (const [at, length] of [[190, 128], [318, 128], [446, 128], [574, 128], [702, 37], [739, 37], [776, 37]] as const) {
    text(out, pvd + at, length, '');              // BP191-813 the identifiers, left blank
  }
  for (const at of [813, 830]) out.set(VOLUME_DATE, pvd + at);   // BP814-847 creation and modification
  for (const at of [847, 864]) out.set([...ascii('0000000000000000'), 0], pvd + at); // expiration, effective: unset
  out[pvd + 881] = 1;                             // BP882 file structure version

  // §8.3: the Volume Descriptor Set Terminator.
  const end = 17 * SECTOR;
  out[end] = 255;
  out.set(ascii('CD001'), end + 1);
  out[end + 6] = 1;

  // §9.4: the path tables, L little-endian and M big-endian.
  for (const [lbn, little] of [[L, true], [M, false]] as const) {
    let at = lbn * SECTOR;
    for (const d of order) {
      const id = d === root ? new Uint8Array([0]) : ascii(d.name);
      out[at] = id.length;
      out[at + 1] = 0;
      view.setUint32(at + 2, d.lbn, little);
      view.setUint16(at + 6, (d.parent ?? d).number, little);
      out.set(id, at + 8);
      at += pathRecordLength(id.length);
    }
  }

  // The directories and the files.
  for (const d of order) {
    const entries = entriesOf.get(d)!;
    const { offsets } = layOut(entries.map((e) => recordLength(e.id.length)));
    entries.forEach((e, i) => writeRecord(out, d.lbn * SECTOR + offsets[i]!, e.id, e.lbn(), e.size(), e.flags));
    for (const bytes of d.files.values()) out.set(bytes, fileLbn.get(bytes)! * SECTOR);
  }
  return out;
}

/** §9.3's order, near enough for d-characters: byte by byte, the shorter first on a tie. */
function compareIds(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}
