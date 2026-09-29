import type { RangedAssetSource, ReadProgress } from './assetSource';

/**
 * The player's own disc image as an `AssetSource` (design spec §3.1, milestone M5): a `Blob` -- a `File`
 * from the page's file input or a drop is one -- read as ISO9660 (ECMA-119) in the browser, so the site
 * serves no game bytes and the image never leaves the machine. Nothing here needs the DOM beyond `Blob`,
 * so the same class runs under node for the tests.
 *
 * What it reads is what `tools_py/iso_lbn.py`, the repository's reference reader, reads, and what the
 * SOCOM II engine itself relies on when it loads everything by LBN: the Primary Volume Descriptor at
 * sector 16, the root directory record inside it, and the directory records under that, each naming a
 * file's extent (first logical block and length). Every byte is fetched with `blob.slice(a, b)`, so an
 * archive costs one range of the file and nothing is read that no one asked for: the tree is walked
 * lazily, one directory at a time as a path passes through it, and the path table is not used.
 *
 * Out of scope, and refused by name rather than misread: a raw 2352-byte-sector image (`.bin`/`.img`
 * from a CD ripper), a logical block size other than 2048, and files recorded as multiple extents or
 * interleaved. The Joliet and UDF descriptors a DVD also carries are ignored: the primary volume holds
 * every file under its ISO9660 name, which is the name the engine asks for.
 */
export class IsoAssetSource implements RangedAssetSource {
  private volume: Promise<Directory> | null = null;
  /** Each directory read so far, by the LBN of its extent. */
  private readonly directories = new Map<number, Promise<Map<string, IsoRecord>>>();

  constructor(private readonly blob: Blob) {}

  /** Every file on the disc, `RUN/MP2.ZDB` style: upper case, forward slashes, no `;1`. Walks the whole tree. */
  async list(): Promise<string[]> {
    const out: string[] = [];
    const seen = new Set<number>();
    const walk = async (dir: Directory, prefix: string): Promise<void> => {
      // A directory whose extent points back up the tree would loop for ever; a real disc has none.
      if (seen.has(dir.lbn)) return;
      seen.add(dir.lbn);
      for (const [name, record] of await this.entries(dir)) {
        if (record.directory) await walk(record, `${prefix}${name}/`);
        else out.push(`${prefix}${name}`);
      }
    };
    await walk(await this.root(), '');
    return out.sort();
  }

  /**
   * A file's bytes. With `onProgress` the extent is read `ISO_READ_CHUNK` bytes at a time and each chunk
   * reported against the file's length, as `HttpAssetSource` streams its body for the load overlay; a
   * local file arrives fast, but a 13 MB archive off a slow disk or a network share still takes a while.
   */
  async read(path: string, onProgress?: ReadProgress): Promise<Uint8Array> {
    const file = await this.file(path);
    if (!onProgress) return this.bytes(file.lbn * ISO_SECTOR, file.size, path);
    const out = new Uint8Array(file.size);
    for (let at = 0; at < file.size; at += ISO_READ_CHUNK) {
      const chunk = await this.bytes(file.lbn * ISO_SECTOR + at, Math.min(ISO_READ_CHUNK, file.size - at), path);
      out.set(chunk, at);
      onProgress(at + chunk.length, file.size);
    }
    if (file.size === 0) onProgress(0, 0);
    return out;
  }

  async size(path: string): Promise<number> {
    return (await this.file(path)).size;
  }

  async readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    const file = await this.file(path);
    if (offset < 0 || length < 0 || offset + length > file.size) {
      throw new Error(`ISO: ${length} bytes at ${offset} of ${path} run past its ${file.size} bytes`);
    }
    return this.bytes(file.lbn * ISO_SECTOR + offset, length, path);
  }

  /** Where a file sits on the disc: its first logical block and its length, as `iso_lbn.py list` prints them. */
  async extent(path: string): Promise<IsoExtent> {
    const { lbn, size } = await this.file(path);
    return { lbn, size };
  }

  /** The record for a file, found by walking only the directories its path passes through. */
  private async file(path: string): Promise<IsoRecord> {
    const parts = normalise(path);
    if (parts.length === 0) throw new Error(`ISO: no file at ${JSON.stringify(path)}`);
    let dir: Directory = await this.root();
    for (let i = 0; i < parts.length; i++) {
      const record = (await this.entries(dir)).get(parts[i]!);
      if (!record) throw new Error(`ISO: no ${parts.join('/')} on the disc image`);
      if (i < parts.length - 1) {
        if (!record.directory) throw new Error(`ISO: no ${parts.join('/')} on the disc image (${parts[i]} is a file)`);
        dir = record;
        continue;
      }
      if (record.directory) throw new Error(`ISO: ${parts.join('/')} is a directory, not a file`);
      // ECMA-119 §9.1.6 bit 7: the file continues in further records. Every archive the viewer reads is
      // far below the 4 GB that forces a split, so this is refused rather than half-read.
      if (record.multiExtent) throw new Error(`ISO: ${parts.join('/')} is recorded in several extents, which this reader does not join`);
      // §9.1.7-9.1.8: an interleaved file alternates its units with gaps. Mastering tools for a PS2 disc
      // do not write them; if one ever appears, a contiguous read would return the gaps too.
      if (record.interleaved) throw new Error(`ISO: ${parts.join('/')} is interleaved, which this reader does not follow`);
      return record;
    }
    throw new Error(`ISO: no ${parts.join('/')} on the disc image`);
  }

  /**
   * The root directory, from the Primary Volume Descriptor (ECMA-119 §8.4). The volume descriptor set
   * starts at sector 16 (§6.2.1, §8); the primary is normally first, but an El Torito disc may put a boot
   * record (type 0) ahead of it, so the set is scanned up to its terminator (type 255, §8.3).
   */
  private root(): Promise<Directory> {
    this.volume ??= (async () => {
      for (let sector = 16; sector < 16 + MAX_DESCRIPTORS; sector++) {
        if ((sector + 1) * ISO_SECTOR > this.blob.size) {
          if (sector === 16) throw new Error(await this.notIso());
          break;
        }
        const d = await this.bytes(sector * ISO_SECTOR, ISO_SECTOR, 'the volume descriptor');
        if (!isCd001(d, 1)) {
          if (sector === 16) throw new Error(await this.notIso());
          break;
        }
        const type = d[0]!;
        if (type === 255) break;
        if (type !== 1) continue;
        // BP129-132: the logical block size, both-endian (§8.4.12, §7.2.3). Every LBN below is in these
        // units; 2048 is what every CD and DVD image a PS2 reads is mastered with.
        const block = u16(d, 128);
        if (block !== ISO_SECTOR) {
          throw new Error(`ISO: a logical block size of ${block} bytes; this reader takes 2048-byte blocks only`);
        }
        // BP157-190: the directory record for the root directory (§8.4.18), 34 bytes.
        const root = parseRecord(d, 156);
        if (!root?.directory) throw new Error('ISO: the primary volume descriptor has no root directory record');
        return root;
      }
      throw new Error('not an ISO9660 image: its volume descriptor set has no primary volume descriptor');
    })();
    return this.volume;
  }

  /** Why sector 16 held no `CD001`, as precisely as the bytes can say. */
  private async notIso(): Promise<string> {
    // A raw CD image keeps every 2352-byte sector whole: 12 bytes of sync, a 4-byte header and then the
    // 2048 user bytes in mode 1, or 8 more bytes of subheader first in mode 2 form 1 (ECMA-130 §14).
    for (const skip of [16, 24]) {
      const at = 16 * RAW_SECTOR + skip;
      if (at + ISO_SECTOR > this.blob.size) continue;
      if (isCd001(await this.bytes(at, 8, 'the volume descriptor'), 1)) {
        return 'not an ISO9660 image of 2048-byte sectors: this is a raw 2352-byte-sector CD image (a .bin/.img); '
          + 'convert it to a .iso first';
      }
    }
    return this.blob.size < 17 * ISO_SECTOR
      ? `not an ISO9660 image: ${this.blob.size} bytes is too short to hold a volume descriptor at sector 16`
      : 'not an ISO9660 image: no CD001 volume descriptor at sector 16';
  }

  /** A directory's records by upper-case name, read once and kept. */
  private entries(dir: Directory): Promise<Map<string, IsoRecord>> {
    let known = this.directories.get(dir.lbn);
    if (!known) {
      known = (async () => {
        const data = await this.bytes(dir.lbn * ISO_SECTOR, dir.size, 'a directory');
        const out = new Map<string, IsoRecord>();
        let at = 0;
        while (at < data.length) {
          const length = data[at]!;
          if (length === 0) {
            // §6.8.1: no record crosses a sector boundary, and the rest of a sector after its last one
            // is zero. Skip to the next sector, as `iso_lbn.py` does.
            at = (Math.floor(at / ISO_SECTOR) + 1) * ISO_SECTOR;
            continue;
          }
          const record = parseRecord(data, at);
          if (!record) throw new Error(`ISO: a malformed directory record at byte ${at} of the directory at LBN ${dir.lbn}`);
          at += length;
          // §7.6.2: 0x00 and 0x01 are the directory itself and its parent. §9.1.6 bit 2: an associated
          // file (a Macintosh resource fork and the like) shares its file's name and is not the file.
          if (record.name === '' || record.associated) continue;
          // The first record of a multi-extent file carries the flag; the ones after it repeat the name.
          if (!out.has(record.name)) out.set(record.name, record);
        }
        return out;
      })();
      this.directories.set(dir.lbn, known);
    }
    return known;
  }

  private async bytes(offset: number, length: number, what: string): Promise<Uint8Array> {
    if (offset + length > this.blob.size) {
      throw new Error(`ISO: ${what} runs past the end of the image (${offset + length} > ${this.blob.size} bytes): a truncated image?`);
    }
    if (length === 0) return new Uint8Array(0);
    return new Uint8Array(await this.blob.slice(offset, offset + length).arrayBuffer());
  }
}

/** ECMA-119 §6.1.2: the logical sector, and here the logical block too (checked in the PVD). */
export const ISO_SECTOR = 2048;
/** A raw CD sector with its sync, header and error correction (ECMA-130). */
const RAW_SECTOR = 2352;
/** How much of an extent `read` asks the `Blob` for at a time when it is reporting progress: 512 sectors. */
export const ISO_READ_CHUNK = 1 << 20;
/** How far past sector 16 to look for the primary descriptor before calling the set malformed. */
const MAX_DESCRIPTORS = 32;

/** Where a file lies on the disc: its first logical block and its length in bytes. */
export interface IsoExtent { lbn: number; size: number }

interface Directory { lbn: number; size: number }

interface IsoRecord extends IsoExtent {
  /** Upper case, `;1` and a bare trailing `.` removed; '' for the `.` and `..` records. */
  name: string;
  directory: boolean;
  associated: boolean;
  multiExtent: boolean;
  interleaved: boolean;
}

/**
 * One directory record (ECMA-119 §9.1), or null when its length byte cannot hold the fixed part. The
 * both-endian fields are read from their little-endian half (§7.2.3, §7.3.3), as `iso_lbn.py` does.
 */
function parseRecord(bytes: Uint8Array, at: number): IsoRecord | null {
  const length = bytes[at] ?? 0;                      // BP1
  if (length < 34 || at + length > bytes.length) return null;
  const idLength = bytes[at + 32]!;                   // BP33
  if (33 + idLength > length) return null;
  const ear = bytes[at + 1]!;                         // BP2: an extended attribute record ahead of the data
  const extent = u32(bytes, at + 2);                  // BP3-10
  const size = u32(bytes, at + 10);                   // BP11-18
  const flags = bytes[at + 25]!;                      // BP26
  const unit = bytes[at + 26]!;                       // BP27
  const gap = bytes[at + 27]!;                        // BP28
  const id = bytes.subarray(at + 33, at + 33 + idLength);
  return {
    name: idLength === 1 && id[0]! <= 1 ? '' : identifier(id),
    // §9.5 (via §9.1.2): the extended attribute record is recorded at the start of the extent, and
    // the file's data follows it.
    lbn: extent + ear,
    size,
    directory: (flags & 0x02) !== 0,
    associated: (flags & 0x04) !== 0,
    multiExtent: (flags & 0x80) !== 0,
    interleaved: unit !== 0 || gap !== 0,
  };
}

/** A recorded file identifier as a name (§7.5.1). */
function identifier(id: Uint8Array): string {
  return clean(String.fromCharCode(...id));
}

/** `NAME.EXT;1` -> `NAME.EXT`, and `NAME.;1` -> `NAME`. Upper case, so a lookup ignores case. */
function clean(name: string): string {
  const version = name.indexOf(';');
  const bare = version >= 0 ? name.slice(0, version) : name;
  return (bare.endsWith('.') ? bare.slice(0, -1) : bare).toUpperCase();
}

/** `/run//mp2.zdb` -> `['RUN', 'MP2.ZDB']`; backslashes too, as the archives' own member names use them. */
function normalise(path: string): string[] {
  return path.split(/[\\/]+/).filter((p) => p.length > 0).map(clean);
}

/** `CD001` at `at` (ECMA-119 §8.1.2, the standard identifier). */
function isCd001(bytes: Uint8Array, at: number): boolean {
  return bytes[at] === 0x43 && bytes[at + 1] === 0x44 && bytes[at + 2] === 0x30 && bytes[at + 3] === 0x30 && bytes[at + 4] === 0x31;
}

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8);
}

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;
}
