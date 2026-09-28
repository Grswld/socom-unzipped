import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { FsAssetSource } from '../src/fsAssetSource';
import { IsoAssetSource, ISO_READ_CHUNK } from '../src/isoAssetSource';
import { listMaps } from '../src/mapIndex';
import { parseZdb } from '../src/zdb';
import { buildIso, SECTOR, type IsoMember } from './isoImage';

/** A member whose every byte says where it is, so a read from the wrong offset cannot pass by luck. */
const pattern = (length: number, seed: number): Uint8Array => {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed * 7 + (i >>> 8)) & 0xff;
  return out;
};

/**
 * One directory level as the retail disc has it (`RUN/`), a file at the root, a file with no extension
 * (recorded `NAME.;1`, ECMA-119 §7.5.1), an empty file, and a directory two deep. Sixty more members in
 * `RUN/` put its directory past one sector, so the reader has to skip the unused tail of the first
 * (§6.8.1) the way `tools_py/iso_lbn.py` does.
 */
const MEMBERS: IsoMember[] = [
  { path: 'RUN/MP2.ZDB', bytes: pattern(5000, 1) },
  { path: 'RUN/MP6.ZDB', bytes: pattern(2048, 2) },
  { path: 'SYSTEM.CNF', bytes: new TextEncoder().encode('BOOT2 = cdrom0:\\SCUS_972.75;1\r\n') },
  { path: 'RUN/README', bytes: pattern(17, 3) },
  { path: 'RUN/EMPTY.TXT', bytes: new Uint8Array(0) },
  { path: 'DEEP/ER/LEAF.BIN', bytes: pattern(4097, 4) },
  ...Array.from({ length: 60 }, (_, i) => ({ path: `RUN/F${String(i).padStart(2, '0')}.DAT`, bytes: pattern(i + 1, 10 + i) })),
];

const image = (members = MEMBERS): Blob => new Blob([buildIso(members)]);

/** A `Blob` that records every range it is asked for, to show what a read touched. */
class CountingBlob extends Blob {
  readonly ranges: [number, number][] = [];
  override slice(start?: number, end?: number, type?: string): Blob {
    this.ranges.push([start ?? 0, end ?? this.size]);
    return super.slice(start, end, type);
  }
}

describe('IsoAssetSource over a synthetic ISO9660 image', () => {
  it('lists every file by its upper-case forward-slash path, the ;1 versions and directories left out', async () => {
    const paths = await new IsoAssetSource(image()).list();
    expect(paths).toEqual(MEMBERS.map((m) => m.path).sort());
    expect(paths).toContain('RUN/README');           // `README.;1` on disc
  });

  it('reads every member back byte for byte', async () => {
    const source = new IsoAssetSource(image());
    for (const m of MEMBERS) expect(await source.read(m.path)).toEqual(m.bytes);
  });

  it('matches a path whatever its case and with or without a leading slash', async () => {
    const source = new IsoAssetSource(image());
    expect(await source.read('run/mp2.zdb')).toEqual(MEMBERS[0]!.bytes);
    expect(await source.read('/RUN/MP2.ZDB')).toEqual(MEMBERS[0]!.bytes);
  });

  it('names the path it cannot find, and will not read a directory as a file', async () => {
    const source = new IsoAssetSource(image());
    await expect(source.read('RUN/MP9.ZDB')).rejects.toThrow('RUN/MP9.ZDB');
    await expect(source.read('NOPE/MP2.ZDB')).rejects.toThrow('NOPE/MP2.ZDB');
    await expect(source.read('RUN')).rejects.toThrow(/directory/);
  });

  it('gives the extent a file sits at, sector-aligned, as the engine reads it by LBN', async () => {
    const iso = buildIso(MEMBERS);
    const extent = await new IsoAssetSource(new Blob([iso])).extent('RUN/MP6.ZDB');
    expect(extent.size).toBe(2048);
    expect(iso.subarray(extent.lbn * SECTOR, extent.lbn * SECTOR + extent.size)).toEqual(MEMBERS[1]!.bytes);
  });

  it('walks only the directories a path passes through', async () => {
    const blob = new CountingBlob([buildIso(MEMBERS)]);
    await new IsoAssetSource(blob).read('SYSTEM.CNF');
    // The volume descriptor, the root directory, the file: `RUN/` and `DEEP/` are never read.
    expect(blob.ranges.length).toBe(3);
    expect(blob.ranges[0]).toEqual([16 * SECTOR, 17 * SECTOR]);
  });

  it('reads a range of a file, and refuses one that runs past its end', async () => {
    const source = new IsoAssetSource(image());
    const leaf = MEMBERS[5]!.bytes;
    expect(await source.size('DEEP/ER/LEAF.BIN')).toBe(4097);
    expect(await source.readRange('DEEP/ER/LEAF.BIN', 2040, 20)).toEqual(leaf.subarray(2040, 2060));
    expect(await source.readRange('DEEP/ER/LEAF.BIN', 4097, 0)).toEqual(new Uint8Array(0));
    await expect(source.readRange('DEEP/ER/LEAF.BIN', 4090, 8)).rejects.toThrow(/past/);
  });

  it('streams a large file in chunks from the same extent, reporting bytes against the file size', async () => {
    const big = pattern(ISO_READ_CHUNK * 2 + 12_345, 9);
    const source = new IsoAssetSource(image([{ path: 'RUN/BIG.ZDB', bytes: big }]));
    const seen: [number, number][] = [];
    const bytes = await source.read('RUN/BIG.ZDB', (loaded, total) => seen.push([loaded, total]));
    // `Buffer.equals`, not `toEqual`: a deep equal walks two megabytes an element at a time.
    expect(Buffer.from(bytes).equals(Buffer.from(big))).toBe(true);
    expect(seen).toEqual([
      [ISO_READ_CHUNK, big.length], [ISO_READ_CHUNK * 2, big.length], [big.length, big.length],
    ]);
  });

  it('refuses an image with no CD001 at sector 16', async () => {
    const iso = buildIso(MEMBERS);
    iso.set([0x58, 0x58, 0x58, 0x58, 0x58], 16 * SECTOR + 1);
    await expect(new IsoAssetSource(new Blob([iso])).list()).rejects.toThrow(/not an ISO9660 image.*CD001/);
  });

  it('refuses a file too short to hold a volume descriptor', async () => {
    await expect(new IsoAssetSource(new Blob([new Uint8Array(4096)])).list()).rejects.toThrow(/not an ISO9660 image/);
  });

  it('refuses a logical block size other than 2048', async () => {
    const iso = buildIso(MEMBERS);
    const view = new DataView(iso.buffer);
    view.setUint16(16 * SECTOR + 128, 2352, true);
    view.setUint16(16 * SECTOR + 130, 2352, false);
    await expect(new IsoAssetSource(new Blob([iso])).list()).rejects.toThrow(/2352.*2048/);
  });

  it('names a raw 2352-byte-sector image (.bin) as such rather than calling it garbage', async () => {
    // A MODE1/2352 track: each 2048-byte sector behind 12 bytes of sync and a 4-byte header.
    const cooked = buildIso(MEMBERS);
    const raw = new Uint8Array(18 * 2352);
    for (let s = 0; s < 18; s++) {
      raw.set([0, ...new Array<number>(10).fill(0xff), 0], s * 2352);
      raw.set(cooked.subarray(s * SECTOR, (s + 1) * SECTOR), s * 2352 + 16);
    }
    await expect(new IsoAssetSource(new Blob([raw])).list()).rejects.toThrow(/2352-byte.*\.bin/);
  });

  it('finds the primary descriptor behind a boot record, as an El Torito disc orders them', async () => {
    const iso = buildIso(MEMBERS);
    // Move the PVD to sector 17 and put a boot record (type 0, ECMA-119 §8.2) at 16; the terminator
    // it displaces goes to 18, which is the L path table's sector -- harmless, nothing reads it.
    const pvd = iso.slice(16 * SECTOR, 17 * SECTOR);
    const end = iso.slice(17 * SECTOR, 18 * SECTOR);
    iso.set(pvd, 17 * SECTOR);
    iso.set(end, 18 * SECTOR);
    iso.fill(0, 16 * SECTOR, 17 * SECTOR);
    iso.set([0, 0x43, 0x44, 0x30, 0x30, 0x31, 1], 16 * SECTOR);
    expect(await new IsoAssetSource(new Blob([iso])).read('RUN/MP2.ZDB')).toEqual(MEMBERS[0]!.bytes);
  });
});

const fixtures = resolve(import.meta.dirname, '../../../test-fixtures');
const FIXTURE_PATHS = ['RUN/MP2.ZDB', 'RUN/MP6.ZDB', 'RUN/MP72.ZDB'];
const haveFixtures = FIXTURE_PATHS.every((p) => existsSync(resolve(fixtures, p)));
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * M5's bar (design §6): the three extracted archives packed into an ISO in memory -- never onto disk --
 * and read back through `IsoAssetSource` give the same bytes as `FsAssetSource` does from the tree, whole
 * and member by member.
 */
describe.skipIf(!haveFixtures)('IsoAssetSource over the fixture archives', () => {
  const fs = new FsAssetSource(fixtures);
  const iso = async (): Promise<IsoAssetSource> =>
    new IsoAssetSource(new Blob([buildIso(await Promise.all(FIXTURE_PATHS.map(async (path) => ({ path, bytes: await fs.read(path) }))))]));

  it('holds the same bytes as the served tree, a sha256 per archive and per ZDB member', async () => {
    const source = await iso();
    expect(await source.list()).toEqual(FIXTURE_PATHS.slice().sort());
    for (const path of FIXTURE_PATHS) {
      const want = await fs.read(path);
      const got = await source.read(path);
      expect(sha256(got)).toBe(sha256(want));
      // The streamed read is the same bytes.
      expect(sha256(await source.read(path, () => undefined))).toBe(sha256(want));
      // And every member of the archive, read on its own by range, as `listMaps` reads READERM.ZAR.
      const toc = parseZdb(want);
      expect(toc.length).toBeGreaterThan(10);
      for (const e of toc) {
        expect(sha256(await source.readRange(path, e.offset, e.size)), `${path} ${e.name}`)
          .toBe(sha256(want.subarray(e.offset, e.offset + e.size)));
      }
    }
  }, 60_000);

  it('names the maps from the ISO, reading each archive\'s TOC and READERM.ZAR rather than all of it', async () => {
    const source = await iso();
    const whole = vi.spyOn(source, 'read');
    const ranged = vi.spyOn(source, 'readRange');
    const maps = await listMaps(source);
    expect(maps).toEqual([
      { archive: 'MP2', path: 'RUN/MP2.ZDB', name: 'FROSTFIRE' },
      { archive: 'MP6', path: 'RUN/MP6.ZDB', name: 'DESERT GLORY' },
      { archive: 'MP72', path: 'RUN/MP72.ZDB', name: 'CROSSROADS' },
    ]);
    expect(whole).not.toHaveBeenCalled();
    let read = 0;
    for (const call of ranged.mock.calls) read += call[2];
    let archives = 0;
    for (const path of FIXTURE_PATHS) archives += await source.size(path);
    expect(read).toBeLessThan(archives / 20);
    // The same answer the whole-archive path gives over the tree.
    expect(await listMaps(fs)).toEqual(maps);
  }, 60_000);
});
