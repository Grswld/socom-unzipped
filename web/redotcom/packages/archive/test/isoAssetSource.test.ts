import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { FsAssetSource } from '../src/fsAssetSource';
import { IsoAssetSource, ISO_READ_CHUNK } from '../src/isoAssetSource';
import { listMaps } from '../src/mapIndex';
import { parseRdr } from '../src/rdr';
import { Zar } from '../src/zar';
import { parseZdb } from '../src/zdb';
import { buildDualLayerIso, buildIso, SECTOR, type IsoMember } from './isoImage';

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

/** Where the directory record whose identifier (BP34) is `id` starts (BP1), in a built image. */
const recordOf = (iso: Uint8Array, id: string): number => {
  const needle = new TextEncoder().encode(id);
  outer: for (let i = 33; i + needle.length <= iso.length; i++) {
    for (let j = 0; j < needle.length; j++) if (iso[i + j] !== needle[j]) continue outer;
    if (iso[i - 1] === needle.length) return i - 33;
  }
  throw new Error(`no record for ${id}`);
};

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

  it('refuses a multi-extent file by name, still lists it, and still reads its neighbours', async () => {
    const iso = buildIso(MEMBERS);
    // ECMA-119 §9.1.6 bit 7 on BP26: the file continues in a further record.
    iso[recordOf(iso, 'MP6.ZDB;1') + 25]! |= 0x80;
    const source = new IsoAssetSource(new Blob([iso]));
    await expect(source.read('RUN/MP6.ZDB')).rejects.toThrow(/several extents/);
    await expect(source.size('RUN/MP6.ZDB')).rejects.toThrow(/several extents/);
    await expect(source.readRange('RUN/MP6.ZDB', 0, 1)).rejects.toThrow(/several extents/);
    expect(await source.list()).toContain('RUN/MP6.ZDB');
    expect(await source.read('RUN/MP2.ZDB')).toEqual(MEMBERS[0]!.bytes);
  });

  it('refuses an interleaved file by name, whether the unit size or the gap is set', async () => {
    // §9.1.7-9.1.8: BP27 file unit size, BP28 interleave gap size; either one set means interleaved.
    for (const [unit, gap] of [[1, 1], [1, 0], [0, 1]] as const) {
      const iso = buildIso(MEMBERS);
      const at = recordOf(iso, 'README.;1');
      iso[at + 26] = unit;
      iso[at + 27] = gap;
      const source = new IsoAssetSource(new Blob([iso]));
      await expect(source.read('RUN/README'), `unit ${unit} gap ${gap}`).rejects.toThrow(/is interleaved/);
      expect(await source.read('RUN/MP2.ZDB')).toEqual(MEMBERS[0]!.bytes);
    }
  });

  it('refuses an image shorter than the volume its descriptor declares, naming the 4 GiB Node wrap', async () => {
    const iso = buildIso(MEMBERS);
    // A truncated file: the PVD (BP81) still counts the missing sector.
    await expect(new IsoAssetSource(new Blob([iso.subarray(0, iso.length - SECTOR)])).list())
      .rejects.toThrow(/the volume is \d+ bytes but the image is \d+.*truncated.*4 GiB/);
    // A Blob whose size under-reports the file, as Node's fs.openAsBlob does above 4 GiB on Windows (the
    // retail image's 4,380,753,920 bytes read as 85,786,624): the bytes are all there, the size is not.
    class WrappedBlob extends Blob { override get size(): number { return super.size - 3 * SECTOR; } }
    await expect(new IsoAssetSource(new WrappedBlob([iso])).read('RUN/MP2.ZDB')).rejects.toThrow(/fs\.openAsBlob/);
    // An image longer than its volume (padding after it) still reads.
    const padded = new Uint8Array(iso.length + 4 * SECTOR);
    padded.set(iso);
    const source = new IsoAssetSource(new Blob([padded]));
    expect(await source.read('RUN/MP2.ZDB')).toEqual(MEMBERS[0]!.bytes);
    expect(await source.list()).toEqual(MEMBERS.map((m) => m.path).sort());
    await expect(source.read('RUN/MP9.ZDB')).rejects.toThrow('RUN/MP9.ZDB');
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

/**
 * A dual-layer PS2 DVD dumped whole: layer 1's volume follows layer 0's, its PVD at the sector layer 0's
 * space size names and its LBNs counted from 16 sectors before that (PCSX2 `FindLayer1Start`, Open PS2
 * Loader's `layer1_start`; `buildDualLayerIso` has the cites). No retail SOCOM II disc is dual-layer, so the
 * layout is proven here on a synthetic image.
 */
describe('IsoAssetSource over a synthetic dual-layer image', () => {
  const LAYER0: IsoMember[] = [
    { path: 'RUN/MP2.ZDB', bytes: pattern(5000, 1) },
    { path: 'SYSTEM.CNF', bytes: pattern(40, 2) },
    { path: 'BOTH.BIN', bytes: pattern(100, 3) },
  ];
  const LAYER1: IsoMember[] = [
    { path: 'RUN/MP9.ZDB', bytes: pattern(7000, 4) },
    { path: 'LAYER1/DEEP.BIN', bytes: pattern(3000, 5) },
    { path: 'BOTH.BIN', bytes: pattern(100, 6) },
  ];

  it('finds a path layer 0 lacks in layer 1, at an LBN counted from layer 1\'s start', async () => {
    const { iso, layer1Start } = buildDualLayerIso(LAYER0, LAYER1);
    // The layout the readers expect: layer 1's PVD sits at the sector layer 0's BP81 names.
    const layer0Blocks = new DataView(iso.buffer).getUint32(16 * SECTOR + 80, true);
    expect(layer0Blocks).toBe(layer1Start + 16);
    expect(String.fromCharCode(...iso.subarray(layer0Blocks * SECTOR + 1, layer0Blocks * SECTOR + 6))).toBe('CD001');

    const source = new IsoAssetSource(new Blob([iso]));
    expect(await source.read('RUN/MP9.ZDB')).toEqual(LAYER1[0]!.bytes);
    expect(await source.read('layer1/deep.bin')).toEqual(LAYER1[1]!.bytes);
    expect(await source.readRange('RUN/MP9.ZDB', 2040, 20)).toEqual(LAYER1[0]!.bytes.subarray(2040, 2060));
    const extent = await source.extent('RUN/MP9.ZDB');
    expect(extent.lbn).toBeGreaterThan(layer1Start);
    expect(iso.subarray(extent.lbn * SECTOR, extent.lbn * SECTOR + extent.size)).toEqual(LAYER1[0]!.bytes);
    // Layer 0 still answers first, and a path neither volume holds is still named.
    expect(await source.read('RUN/MP2.ZDB')).toEqual(LAYER0[0]!.bytes);
    expect(await source.read('BOTH.BIN')).toEqual(LAYER0[2]!.bytes);
    await expect(source.read('RUN/MP7.ZDB')).rejects.toThrow('ISO: no RUN/MP7.ZDB on the disc image');
  });

  it('lists both volumes, a path both hold once', async () => {
    const source = new IsoAssetSource(new Blob([buildDualLayerIso(LAYER0, LAYER1).iso]));
    expect(await source.list()).toEqual(['BOTH.BIN', 'LAYER1/DEEP.BIN', 'RUN/MP2.ZDB', 'RUN/MP9.ZDB', 'SYSTEM.CNF']);
  });

  it('reads layer 1 only when a path needs it', async () => {
    const blob = new CountingBlob([buildDualLayerIso(LAYER0, LAYER1).iso]);
    await new IsoAssetSource(blob).read('SYSTEM.CNF');
    expect(blob.ranges.length).toBe(3);   // layer 0's PVD, its root, the file
  });

  it('refuses a layer 1 volume cut short', async () => {
    const { iso } = buildDualLayerIso(LAYER0, LAYER1);
    const source = new IsoAssetSource(new Blob([iso.subarray(0, iso.length - SECTOR)]));
    expect(await source.read('RUN/MP2.ZDB')).toEqual(LAYER0[0]!.bytes);
    await expect(source.read('RUN/MP9.ZDB')).rejects.toThrow(/layer 1's volume ends at byte \d+ but the image is \d+/);
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

/**
 * The retail image, when a developer points SOCOM_ISO at it (never in CI: no disc lives in the repository).
 * Read through an fs-backed Blob stand-in, one readSync per slice -- not fs.openAsBlob, whose size wraps
 * modulo 2^32 above 4 GiB on Windows. The pins are the disc record: the US image is 4,380,753,920 bytes, one
 * volume of 2,139,040 blocks, 349 files (DEVELOPING.md's extract count), 22 RUN/MP*.ZDB, and
 * `python tools_py/iso_lbn.py <image> list` prints `0x01cff3a 7985152 /RUN/MP2.ZDB`.
 */
const RETAIL = process.env.SOCOM_ISO;
describe.skipIf(!RETAIL || !existsSync(RETAIL))('IsoAssetSource over the retail image (SOCOM_ISO)', () => {
  const fsBlob = (path: string): Blob => {
    const fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const slice = (start = 0, end = size): Blob => ({
      size: end - start,
      arrayBuffer: async () => {
        const out = new Uint8Array(end - start);
        let got = 0;
        while (got < out.length) {
          const n = readSync(fd, out, got, out.length - got, start + got);
          if (n === 0) break;
          got += n;
        }
        return out.buffer;
      },
    }) as unknown as Blob;
    return { size, slice, close: () => closeSync(fd) } as unknown as Blob;
  };

  it('lists 349 files, names the 22 maps and puts MP2.ZDB where iso_lbn.py does', async () => {
    const blob = fsBlob(RETAIL!);
    try {
      expect(blob.size).toBe(4_380_753_920);
      const source = new IsoAssetSource(blob);
      expect((await source.list()).length).toBe(349);
      expect(await source.extent('RUN/MP2.ZDB')).toEqual({ lbn: 0x01cff3a, size: 7_985_152 });
      const problems: string[] = [];
      const maps = await listMaps(source, (path, message) => problems.push(`${path}: ${message}`));
      expect(problems).toEqual([]);
      expect(maps.length).toBe(22);
      expect(maps.find((m) => m.archive === 'MP1')?.name).toBe('BLIZZARD');
      expect(maps.find((m) => m.archive === 'MP83')?.name).toBe('REQUIEM');
      expect(maps.find((m) => m.archive === 'MP2')?.name).toBe('FROSTFIRE');
      // The two most-shared scripts on the disc (8.08x and 5.57x their node arrays) parse inside the rdr
      // visit budget (RDR_VISIT_FACTOR, PL-11).
      const ui = Zar.parse(await source.read('RUN/UI/READERC.ZAR'));
      for (const name of ['UiParams.rdr', 'mp_rooms.rdr']) expect(() => parseRdr(ui.data(ui.find(name)!)), name).not.toThrow();
    } finally {
      (blob as unknown as { close(): void }).close();
    }
  }, 120_000);

  it('holds 736 .rdr scripts under RUN/ but RUN/SOUNDS/, and every one parses inside the visit budget', async () => {
    // Research 93 section 1's count, the one rdr.ts's RDR_VISIT_FACTOR comment cites. A script is a ZAR/ZED
    // key named *.rdr that holds bytes, in a loose RUN/ archive or a member archive of a RUN/*.ZDB; the 672
    // zero-size keys named *.rdr, all in the ZANIM archives (UIZANIM.ZAR's Anim_Sets and its Name_Table
    // keys, EXTZANIM, MPZANIM, each ZDB's LDZANIM/CZANIM), hold no bytes and are not scripts.
    const blob = fsBlob(RETAIL!);
    try {
      const source = new IsoAssetSource(blob);
      const scripts: string[] = [];
      const failed: string[] = [];
      const scan = (where: string, bytes: Uint8Array) => {
        const zar = Zar.parse(bytes);
        zar.walk((key) => {
          if (!/\.rdr$/i.test(key.name) || key.size === 0) return;
          scripts.push(`${where}/${key.name}`);
          try { parseRdr(zar.data(key)); } catch (e) { failed.push(`${where}/${key.name}: ${String(e)}`); }
        });
      };
      for (const path of await source.list()) {
        if (!path.startsWith('RUN/') || path.startsWith('RUN/SOUNDS/')) continue;
        if (/\.(zar|zed)$/i.test(path)) scan(path, await source.read(path));
        else if (/\.zdb$/i.test(path)) {
          const bytes = await source.read(path);
          for (const e of parseZdb(bytes)) {
            if (/\.(zar|zed)$/i.test(e.name)) scan(`${path}:${e.name}`, bytes.subarray(e.offset, e.offset + e.size));
          }
        }
      }
      expect(failed).toEqual([]);
      expect(scripts.length).toBe(736);
    } finally {
      (blob as unknown as { close(): void }).close();
    }
  }, 600_000);
});
