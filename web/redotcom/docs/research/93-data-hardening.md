# 93 -- Data hardening: what the parsers refuse in a dropped image, and why (2026-09-29)

Written 2026-09-29 for the pre-launch fix list's PL-11 (batch B13). None of this is a game rule: the game reads
only its own disc. Each limit here is a hardening bound for a hostile or damaged file the player drops on the disc
page, sourced from the file formats (ECMA-119, research 72's rdr layout, reCOM's grid) and measured against the
retail US image (`SOCOM II - U.S. Navy SEALs (USA).iso`, 4,380,753,920 bytes). No value here is a placeholder:
each is either a format rule or a named hardening ceiling with its measurement.

## 1. rdr: a visit budget (`packages/archive/src/rdr.ts`, `RDR_VISIT_FACTOR`)

A compiled `.rdr` (research 72, "Spawns": `{u32 version; u32 string_table_size; u32 node_array_offset}`, the
string table, 8-byte nodes `{type:8, isclone:1, packed:1, unused:6, length:16; value}`) lets a list point at any
child array, so two lists may share one (the `isclone` bit). The depth cap (64) stops a cycle; it does not stop a
wide shared tree: 6 levels of 64-wide lists all aimed at the next level ran Node out of heap from a 3 KB file.

`parseRdr` now counts the nodes it visits and throws past `RDR_VISIT_FACTOR` x the node array's size. Measured
2026-09-29 over every `.rdr` on the US disc (736 scripts, every ZAR/ZED/ZDB under `RUN/` but `RUN/SOUNDS/`):

| script | visits / nodes | ratio |
|---|---|---|
| `RUN/UI/READERC.ZAR/UiParams.rdr` | 22,554 / 2,791 | 8.08 |
| `RUN/UI/READERC.ZAR/mp_rooms.rdr` | 4,240 / 761 | 5.57 |
| `RUN/MP5.ZDB .../READERM.ZAR/clutter.rdr` | 811 / 370 | 2.19 (the most shared map script) |
| `RUN/READERC.ZAR/character.rdr` | 27,377 / 14,291 | 1.92 |

`RDR_VISIT_FACTOR = 16`, twice the worst retail file, so the cost is linear in the file's size. Pins:
`packages/archive/test/rdr.test.ts` (the wide DAG, the shared subtree, the depth cap), and the gated retail test
in `isoAssetSource.test.ts` parses the two most-shared scripts.

## 2. grid_params: `GRID_CELLS_MAX` (`packages/scene/src/worldRoot.ts`)

`tag_GRID_PARAMS` carries two i32 cell counts; reCOM's `CGrid::Create` allocates whatever they say
(`research/recom/src/gamez/zGrid/grid_main.cpp:82-142`), so the game gives no bound. Every disc map is at most
36 x 25 = 900 cells (M51, research 23 section 2.1). `GRID_CELLS_MAX = 65536` (70 times that) is the ceiling;
`decodeGridParams` returns null above it and `parseGridParams` throws `grid_params: X x Z cells is not a grid
this reads` rather than falling back silently to 8 x 8 (the viewer's loaders turn it into a named diagnostic).
Pin: `packages/scene/test/grid.test.ts`.

## 3. ISO: the volume size, and layer 1 (`packages/archive/src/isoAssetSource.ts`)

- **Volume space size** (ECMA-119 section 8.4.8, BP81-84): an image shorter than `blocks x 2048` is refused at
  open with a message naming both causes -- a truncated file, or a Node `fs.openAsBlob` Blob over a file above
  4 GiB, whose `size` Node (v24, Windows) reports modulo 2^32: the retail image reads as 85,786,624 bytes, and the
  reader now says so instead of failing later with "runs past the end of the image". A browser's `File.size` is
  exact. The retail PVD: 2,139,040 blocks = the whole file, one volume; 349 files; no multi-extent or interleaved
  record; `RUN/MP2.ZDB` at LBN 0x1cff3a, 7,985,152 bytes (as `tools_py/iso_lbn.py list` prints).
- **Multi-extent and interleaved records** (section 9.1.6 bit 7; 9.1.7-9.1.8): refused by name, now pinned.
- **A dual-layer dump.** PCSX2 (`pcsx2/CDVD/CDVDisoReader.cpp`, `FindLayer1Start`) reads the layer-0 PVD's
  volume space size and, when the image is longer, finds layer 1's PVD at exactly that sector. Open PS2 Loader
  (`src/bdmsupport.c`) takes 16 off that sector as `layer1_start`, and its cdvdman
  (`modules/iopcore/cdvdman/searchfile.c`) reads the layer-1 PVD at `layer1_start + 16` and adds `layer1_start`
  to the layer-1 root's and files' LBNs. The reader does the same: a path the first volume lacks is resolved in
  the second, with LBNs counted from its start. No retail SOCOM II disc is dual-layer, so this is proven on a
  synthetic image (`buildDualLayerIso` in `packages/archive/test/isoImage.ts`).
- The gated retail test runs with `SOCOM_ISO` set to the image path (an fs-backed Blob stand-in, never
  `openAsBlob`).

## 4. The map listing (`packages/archive/src/mapIndex.ts`)

`listMaps` names each `RUN/MP*.ZDB` in its own try: one archive that will not name itself is offered under its
archive id (as `parseServedIndex` names a bare path) and its reason goes to the optional `onProblem` callback, the
contract a map's own load keeps. `tools/extract-maps.ts` throws from `onProblem`, so a served index is never
partial. Pin: `packages/archive/test/mapIndex.test.ts` (junk archive alone; junk beside the MP6 fixture, whole and
by range through an ISO).
