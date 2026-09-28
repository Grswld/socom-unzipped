# 75 — `AIMAPS.MPS`: the AI map file read to its last byte, and the spawn slots in it (2026-09-28)

Web sprint 1, task W1.5 (spec `../specs/2026-09-28-web-sprint-1-the-engines-world-design.md` §4, ruling W1.R4).
Research 72 §6 left `AIMAPS.MPS` as "the one format gap for a viewer that wants to draw spawns": a `version 2`
head, sub-map records, a table at 0x159D8 on Frostfire naming `PlayerStart`, `spectator`, `Charlie`...`Foxtrot`,
and some strings it took for a 2D briefing overlay. This note is the whole file. No game run; the bytes are the
owner's extraction under `web/public/maps/RUN` (all 22 `MP*.ZDB`); nothing of them is in the tree beyond the
short hex excerpts quoted here.

## 0. The answer, for W1.R4

- **There is no `PlayerStart` region.** `PlayerStart` (`startPlayer` on 20 maps, `StartPlayer` on Requiem) is a
  *named cell*: one 10 x 10 cell, with no extent field anywhere in its record (§5.1). It holds neither measured
  spawn on any of the 22 maps: **0 of 44** positions fall inside it (§7). The file does have rectangles with
  extents -- the `Safety` zones of seven maps (§5.4) -- but none is a start region.
- **The spawns are a list.** Each file ends with a list of 12-byte spawn records (§5.5, §6); those with bit 4
  clear are **24 slots a side** (25 for side 0 on Blood Lake and Vigilance), each a cell with a side bit and one
  of eight facings. **All 44 measured positions are explained by a slot of their own side**: the 4 positions
  of `KNOWN.md` §1 (Frostfire, Vigilance) sit at a slot's centre, 0.26-0.51 units off; the 40 of the 2026-09-17
  sweep sit 20.1-28.0 units *behind* a slot along its facing and 1.0-3.2 units to one side of that line, the
  same side every time -- they are the orbit camera behind an actor on the slot, not the actor (corrected
  2026-09-28: this said *ahead*, with the facing turned 180 degrees; §11). The other side's nearest slot is
  824.6 units away or more, for every position. A is side 0 and B side 1 on all 22 maps.
- **So W1.R4's condition, as written, is not met, and `spawns.ts` stays the source** (§9 says what a ruling would
  need to change that). What stopped the check is the premise, not the decode: the regions the ruling names
  are cells, and the list that does match says where a side *may* start, not which slot a player *got*.

## 1. Method, and the standard every claim here meets

- `web/tools/dump-aimaps.ts` prints every field below per sub-map, a hex window around each named record
  (`--hex`), and every printable run of six bytes or more with the section of the file it lies in
  (`--strings`); `--all` prints one line per archive. `web/tools/aimaps-spawns.ts` prints §7's table.
  The reader is `web/packages/scene/src/aimaps.ts`; its tests are `web/packages/scene/test/aimaps.test.ts`
  (a hand-built file for CI, and Frostfire, Desert Glory and Crossroads).
- **Coverage:** 22 files, 83 sub-maps, 946,155 stored cells, 206 named points, 4,591 spawn records.
- **The proof of the layout** is that the reader consumes each of the 22 files to its last byte and refuses a
  file when a count, a size or the length disagrees; it does so on all 22 (`dump-aimaps.ts --all`: "parsed to
  the last byte" 22 times). Every field asserted below is shown by the dump on more than one map; a field seen
  on one map only, or whose meaning is inferred, says so.
- **What reCOM gives:** `research/recom/src/gamez/zAI/zai.h:297-307` -- `CAiMap` (an empty class) and
  `CAiMapLoc { u32 m_mapid:6; u32 m_x:13; u32 m_y:13; }`. Its `ai_map.cpp`, `ai_mapio.cpp` and `ai_maps.cpp`
  are empty files in the checkout, so the format itself comes from the bytes, not from reCOM. SOCOM 1's DWARF
  sizes `CAiMap` at 0x12C bytes (`docs/research/50` §2); that image is not in the tree and was not used.

## 2. The file

| offset | size | field | over the 22 |
|---|---|---|---|
| 0x00 | 4 | u32 version | 2 on all 22 |
| 0x04 | 4 | u32 sub-map count | 1-10; equals the number of `map_list` entries in the map's own `aimaps.rdr`, and sub-map *i* is entry *i* (Frostfire: `aimap.map`, `Ramps.map`, `Tunnels.map` -> `BaseMap`, `Ramps`, `Tunnels`) |
| 0x08 | 32 | zero | all 22 |
| 0x28 | ... | the sub-maps, each: header (§3), cells and rows (§4), eight tables (§5), second cell words (§4) | |
| ... | ... | the trailer: the link block and the spawn list (§6) | |

Sub-map counts: 1 (Bitter Jungle, Shadow Falls), 2 (3 maps), 3 (10), 4 (Sandstorm), 5 (3), 7 (Death Trap),
9 (Desert Glory), 10 (The Mixer).

## 3. The sub-map header (0xA8 bytes)

| +off | type | field | over the 83 sub-maps |
|---|---|---|---|
| 0x00 | u32 | flags | 0x17 on all 83; not decoded |
| 0x04 | f32 x 3 | bounding box minimum (x, y, z) | the grid's origin in x and z (§4) |
| 0x10 | f32 x 3 | bounding box maximum | |
| 0x1C | u32 | cells in x | 12-729 |
| 0x20 | u32 | cells in z | 9-627 |
| 0x24 | f32 x 2 | cell size x, z | 10, 10 on all 83 |
| 0x2C | f32 x 2 | 1 / cell size | 0.1, 0.1 on all 83 |
| 0x34 | i32 | id | 0-46, or -1 (Chain Reaction's first); **not** the index a loc carries (Frostfire's Ramps is 3 and Tunnels 7; their records say 1 and 2, §4) |
| 0x38 | char[32] | name, NUL-padded | `BaseMap`, `Ramps`, `Jail House - Basement`, ...; `Unknown` on 17 |
| 0x58 | f32 | not decoded | 0.5 on 76, 0.75 on 3, 1.0 on 2, 1.1 on 2 |
| 0x5C | u32 | | 2 on all 83 |
| 0x60 | f32 | | pi/4 (0.785398) on all 83 |
| 0x64 | u32 | | 4 on all 83 |
| 0x68 | u32 x 2 | not decoded | zero on most; differs between sub-maps |
| 0x70 | u32 | | 1 on all 83 |
| 0x74 | u32 | stored cell count N | 45-105,152 |
| 0x78 | u32 | unread | varies; text bytes on some (Frostfire's Ramps: `20 09 28 20`) |
| 0x7C | u32 | an MS-DOS date-time | decodes to a plausible time on all 83: 2002-05-17 12:29:48 to 2003-10-09 20:20:02; a file's sub-maps are seconds apart (Frostfire: 16:41:46, :48, :52 on 2003-09-13) |
| 0x80 | u32 | a second date-time | equal to +0x7C on 77 of 83; different on 6 (on two of Abandoned's it is text) |
| 0x84 | u32 | | 0 on all 83 |
| 0x88 | 32 bytes | **unread: uninitialised memory** | `80 80 ...` fill on Frostfire's BaseMap, `78 78 ...` on Blizzard's, text on 13 sub-maps (§8) |

Frostfire's first header, from `dump-aimaps.ts MP2 --hex`:

```
000020  00000000 00000000 00000017 424aebc0   flags 0x17; min x 50.73
000030  42c80000 43954924 44b0b57c 43655600   min y 100, z 298.57; max x 1413.67, y 229.34
000040  44a19b6e 00000089 00000064 41200000   max z 1292.86; 137 x 100 cells; 10.0
000050  41200000 3dcccccd 3dcccccd 00000000   10.0; 0.1, 0.1; id 0
000060  65736142 0070614d 00000000 00000000   "BaseMap"
0000a0  8080809f 2f2d8537 2f2d8537 00000000   +0x78 unread; 2003-09-13 16:41:46 twice; 0
```

## 4. The grid

- **Cells.** N records of 8 bytes, `{u32 word; u32 -1}`: the second word is 0xFFFFFFFF on all 946,155.
- **Rows.** Then one 12-byte record per grid row: `{u16 x0; u16 x1; u32 first; u32 unread}`. The row's stored
  cells are columns `[x0, x1)`, at cell indices `first ...`. On all 7,807 non-empty rows `first` is the running
  total and `x1 <= cells in x`; the 5,599 empty rows have `x0 = x1 = cells in x`; the rows' cells sum to N on all
  83. The unread word is pointer-like (Frostfire BaseMap: 0x00AAC9E8, then +0x1B8 per row) -- the writer's memory.
  So a sub-map stores only the cells inside its walkable outline: Frostfire's BaseMap is 137 x 100 = 13,700
  cells of box and 10,890 stored, columns 7-116, rows 0-98.
- **A cell's address is a `CAiMapLoc`** (reCOM `zai.h:302-307`): the sub-map's index in the file in bits 0-5,
  x in bits 6-18, the second axis (reCOM's `y`, world z) in bits 19-31. Shown by: every one of the 206 named
  points, the 216 link ends and the 4,591 spawn records of the trailer names a *stored* cell of the sub-map its
  index names; Frostfire's Tunnels records carry 2, its BaseMap's 0.
- **World position:** a cell's centre is `min + (cell + 0.5) x size` in x and z. Shown by the four `KNOWN.md` §1
  spawns (Frostfire, Vigilance), each 0.26-0.51 units from a slot's centre computed that way (§7), and by the 40
  sweep positions' consistent offsets from their slots. No record carries a height; the header's y range is the
  sub-map's, not a floor.
- **The cell word** has bit 31 set on all 946,155. Bits 5-7 are a **marker**: 2 under 164 named points, 3 under
  42 (the 21 `hostage*Start` points and 21 of the 22 start points), 4 under all 35 markers of §5.2; one cell
  (Chain Reaction's first sub-map) carries 1 with no record over it. The other bits (0-3, 9-18, 21-27 vary) are
  not decoded.
- **Second cell words.** After the tables, one u32 per stored cell, in the same order; not decoded (Frostfire's
  BaseMap has 18 distinct values, 10,344 of them 0x197FFF7F or 0x007FFF7F).

## 5. The eight tables of a sub-map

Each is `{u32 count; count records}`, in this order.

### 5.1 Named points (24 bytes): `{u32 loc; char name[16]; u32 word}`

206 over the 22 maps: one start point per map (`startPlayer` 20, `PlayerStart` Frostfire, `StartPlayer`
Requiem), one `spectator` per map, `StartBomb`/`startbomb` on 9, `hostageStart`/`hostage2Start`/`hostage3Start`
on 7, and NATO letters (`Charlie`, `Delta`, `Echo`, `Foxtrot`, `Juliet`, `Romeo`, `Whiskey`). Byte 1 of `word`
is a kind: 2 on all 21 hostage starts and 21 of the 22 start points (Abandoned's reads 0), 1 on every letter, 0
on every `spectator` and `StartBomb`; the other bytes vary between maps and are not decoded. **A named point is
one cell**: the record has nothing else to hold an extent, and the cell under it carries the §4 marker. Frostfire:

```
0159d0  00000006 01180b00 79616c50 74537265   count 6; loc (0, 44, 35); "PlayerSt
0159e0  00747261 00000000 00990208 01c80ac0   art"; word 0x00990208 (kind 2); next loc
0159f0  63657073 6f746174 00000072 00000000   "spectator"
```

### 5.2 Markers (40 bytes): `{u32 loc; u32 word; 32 bytes unread}`

35 over 8 maps; the cell under each carries marker 4. Bits 4-19 of `word` are 0xFFFF on all 35, the low
nibble is 0, 2, 3, 4, 6 or 7; the 32 unread bytes hold pointer-like values and short text (`(sat`, `HL t`) that
differ between maps -- the writer's memory again. What a marker is, is not known.

### 5.3 Links (12 bytes): `{u32 from; u32 to; u32 word}`

108 over the 8 maps with more than one walkable level joined (Desert Glory 16, The Mixer 36, ...). `from` is a
cell of this sub-map, `to` a cell of another; every link is stored at both ends (Desert Glory:
`0:(66,98) -> 7:(13,15)` in `Base Map`, `7:(13,15) -> 0:(66,98)` in `SEAL sanctuary`). `word` is 8 on 82 and
pointer-like on 26. Links between floors, by every appearance; not otherwise decoded.

### 5.4 Zones (28 bytes): `{u32 corner; u16 width; u16 height; u32 kind; char name[16]}`

15 over 7 maps (Desert Glory, Blood Lake, Death Trap, The Mixer, Foxhunt, Fish Hook, Guidance), all named
`Safety`...`Safety4`; `kind` 1 on 10, 5 on 5. Read as a rectangle of cells `[x, x + width) x [z, z + height)`
from the corner cell, 14 of the 15 fall 97-100 % on stored cells (Desert Glory's 68 %, its corner off the
outline) -- which is what the rectangle reading predicts; a rectangle centred on the loc falls below 60 % on
five of them. The only records in the file with an extent. The seven maps are exactly the seven with hostage
starts (§5.1); what the game does with a `Safety` zone is not in this file.

### 5.5 Spawn records (12 bytes): `{u32 loc; u32 flags; u32 word}`

`flags` <= 0x37 on all 4,591: **bits 0-2 a facing** (§7), **bit 4 a twin**, **bit 5 the side**. `word` is not
decoded (0x0012F97C-like on some maps, float-like on others: the writer's memory). The records with bit 4 clear
are the **slots**: 24 per side on 20 maps, 25 on side 0 of Blood Lake and Vigilance. 1,036 of the 1,058 slots
have a record with bit 4 set -- a twin -- in a neighbouring cell, 1,020 of them with the same facing (Frostfire:
A's slot `0:(74,31)` flags 0x04, its twin `0:(75,31)` 0x14); the other 22 have one two or three cells away, or in
the same cell. Sixteen maps have 96 records (48 slots and 48 twins; Blood Lake 49 and 47); six have hundreds of
twin-flagged records more (Frostfire 572 in all, Rat's Nest 722), spread over each side's half of the map. The side bit is
reliable on slots only: on The Mixer all 48 twins carry side 1.

### 5.6 Polylines: `{u32 n; u32 loc[n]; u32 value}`

553 over three maps only: Blizzard 79, Frostfire 253, Bitter Jungle 56 (all in the first sub-map); `value` 0 on
534, 1-3 on 19. §8 is what they might be.

### 5.7 Two more counts

Zero in all 83 sub-maps, so their record size is unknown; the reader refuses a file where either is not zero.

## 6. The trailer

```
{u32 1; u32 size; u32 words; u32 records; words x 4 bytes; records x 16 bytes}   the link block
{u32 count; count x 12 bytes}                                                   the spawn list
```

`size = 16 + 4 x words + 16 x records` on all 22; `words` is the number of §5.3 links in the file on all 22 (0
on 14, 2-36 on 8), so the block belongs to the links; neither its words nor its records are decoded. The
spawn list is every sub-map's §5.5 records again, in another order: the same set on 21 maps; on Rat's Nest 62
of `Floor1`'s records carry sub-map 0 where the trailer's copy says 1 (its `Base Map` and `Floor1` share an
origin, so the cells are the same places). The reader takes the trailer's list as the file's.

## 7. The 44 measured spawns against the file (W1.R4)

`tools/aimaps-spawns.ts`, all 22 maps. *PlayerStart*: the start point's cell and whether the position is in it.
*Slot*: of the position's side's slots with `along` in [-30, 1], the one with the least `|perp|`, where `along`
and `perp` are the position's offset from the slot's centre along and across its facing
(`perp = dz * ux - dx * uz`); *other* is the nearest slot of the other side. (Corrected 2026-09-28, §11: the
window was [-1, 30] and every `along` and `perp` below had the other sign, under the facing turned 180 degrees;
the slot each row fits is the same.)

| map | side | measured (x, y, z) | PlayerStart cell | in? | slot | flags | along | perp | dist | other |
|---|---|---|---|---|---|---|---|---|---|---|
| MP1 BLIZZARD | A 0 | 2562, 272, 3113 | 0:(145,150) | no | 0:(215,217) | 0x00 | -24.2 | 1.1 | 24.2 | 1815.5 |
| | B 1 | 1789, 75, 1385 | | no | 0:(138,49) | 0x24 | -23.8 | 1.9 | 23.9 | 1819.8 |
| MP2 FROSTFIRE | A 0 | 796, 100, 614 | 0:(44,35) | no | 0:(74,31) | 0x04 | 0.4 | -0.3 | **0.5** | 586.7 |
| | B 1 | 536, 143, 1254 | | no | 0:(48,95) | 0x22 | 0.3 | 0.4 | **0.5** | 589.0 |
| MP5 ABANDONED | A 0 | 1172, 82, 2260 | 0:(44,98) | no | 0:(84,191) | 0x00 | -23.9 | 2.2 | 24.0 | 1435.7 |
| | B 1 | 927, 168, 622 | | no | 0:(60,32) | 0x24 | -24.1 | 2.8 | 24.3 | 1331.2 |
| MP6 DESERT GLORY | A 0 | 837, -5, 1901 | 0:(69,75) | no | 0:(15,77) | 0x02 | -23.3 | 1.3 | 23.3 | 952.0 |
| | B 1 | 1865, 66, 1221 | | no | 0:(114,11) | 0x25 | -23.7 | 2.8 | 23.8 | 917.7 |
| MP7 NIGHT STALKER | A 0 | 648, 124, 1675 | 0:(186,61) | no | 0:(13,57) | 0x03 | -23.3 | 2.2 | 23.4 | 1543.1 |
| | B 1 | 2310, 163, 1458 | | no | 0:(175,34) | 0x26 | -24.0 | 2.0 | 24.1 | 1304.3 |
| MP8 RAT'S NEST | A 0 | 1601, 166, 905 | 1:(48,123) | no | 1:(158,86) | 0x05 | -24.3 | 2.9 | 24.5 | 1262.6 |
| | B 1 | 188, 165, 948 | | no | 1:(18,86) | 0x20 | -23.8 | 2.2 | 23.9 | 1392.5 |
| MP9 BITTER JUNGLE | A 0 | 1065, 30, 1253 | 0:(62,75) | no | 0:(39,69) | 0x00 | -23.3 | 1.3 | 23.4 | 1533.5 |
| | B 1 | 2749, 31, 911 | | no | 0:(206,39) | 0x25 | -24.0 | 2.4 | 24.2 | 1491.3 |
| MP10 BLOOD LAKE | A 0 | 1098, 35, 626 | 0:(109,121) | no | 0:(113,68) | 0x04 | -24.0 | 3.2 | 24.2 | 1218.7 |
| | B 1 | 884, 52, 2004 | | no | 0:(91,201) | 0x20 | -24.0 | 2.8 | 24.1 | 1220.0 |
| MP11 DEATH TRAP | A 0 | 1170, 163, 1572 | 0:(143,86) | no | 0:(118,149) | 0x01 | -23.8 | 1.4 | 23.8 | 824.6 |
| | B 1 | 1628, 1, 247 | | no | 1:(58,18) | 0x22 | -27.8 | 2.8 | 28.0 | 1358.3 |
| MP12 THE RUINS | A 0 | 2063, 68, 1114 | 0:(172,82) | no | 0:(185,88) | 0x06 | -23.2 | 2.1 | 23.3 | 1424.2 |
| | B 1 | 486, 69, 1309 | | no | 0:(32,107) | 0x22 | -23.8 | 2.9 | 23.9 | 1412.4 |
| MP51 VIGILANCE | A 0 | 540, 160, 1456 | 0:(109,103) | no | 0:(71,163) | 0x00 | 0.1 | 0.2 | **0.3** | 1283.7 |
| | B 1 | 1130, 65, 96 | | no | 0:(130,27) | 0x25 | -0.2 | -0.1 | **0.3** | 1358.5 |
| MP52 THE MIXER | A 0 | 2254, 40, 2688 | 0:(305,205) | no | 0:(227,269) | 0x01 | -23.7 | 1.3 | 23.7 | 1478.8 |
| | B 1 | 3802, 101, 2044 | | no | 8:(43,59) | 0x20 | -23.7 | 2.2 | 23.8 | 1280.0 |
| MP53 FOXHUNT | A 0 | 3407, 144, 4904 | 0:(324,472) | no | 0:(342,495) | 0x00 | -23.9 | 3.0 | 24.1 | 3070.0 |
| | B 1 | 3212, 212, 1817 | | no | 0:(323,191) | 0x24 | -23.1 | 2.0 | 23.2 | 2923.8 |
| MP61 SUJO | A 0 | 873, 143, 279 | 0:(83,54) | no | 0:(89,50) | 0x04 | -24.5 | 3.0 | 24.6 | 1367.9 |
| | B 1 | 658, -25, 2245 | | no | 0:(69,242) | 0x21 | -28.0 | 2.5 | 28.1 | 1681.8 |
| MP62 ENOWAPI | A 0 | 802, 4, 340 | 0:(154,55) | no | 0:(99,53) | 0x03 | -24.0 | 1.2 | 24.0 | 1119.7 |
| | B 1 | 1442, 277, 1231 | | no | 0:(163,142) | 0x23 | -23.2 | 1.9 | 23.3 | 942.8 |
| MP64 SHADOW FALLS | A 0 | 1607, 36, 2160 | 0:(120,96) | no | 0:(162,223) | 0x00 | -25.0 | 1.0 | 25.0 | 1655.4 |
| | B 1 | 445, 38, 811 | | no | 0:(46,93) | 0x24 | -24.0 | 1.0 | 24.0 | 1701.9 |
| MP71 FISH HOOK | A 0 | 1199, 73, 1450 | 0:(196,93) | no | 0:(125,148) | 0x01 | -23.9 | 1.8 | 24.0 | 941.6 |
| | B 1 | 1892, 175, 758 | | no | 0:(193,83) | 0x24 | -23.8 | 2.6 | 23.9 | 883.8 |
| MP72 CROSSROADS | A 0 | 1972, 68, 2150 | 0:(87,107) | no | 0:(164,180) | 0x00 | -23.9 | 2.2 | 24.0 | 1793.4 |
| | B 1 | 748, 93, 766 | | no | 0:(42,46) | 0x24 | -20.1 | 1.8 | 20.2 | 1734.4 |
| MP73 SANDSTORM | A 0 | 2303, 201, 2017 | 0:(111,94) | no | 0:(232,205) | 0x07 | -23.8 | 2.3 | 23.9 | 1400.7 |
| | B 1 | 857, 85, 1306 | | no | 0:(91,137) | 0x23 | -23.6 | 1.3 | 23.6 | 1383.9 |
| MP81 CHAIN REACTION | A 0 | 1256, 272, 1254 | 4:(30,12) | no | 4:(28,30) | 0x00 | -23.8 | 1.4 | 23.8 | 956.7 |
| | B 1 | 1457, 26, 2374 | | no | 1:(46,140) | 0x20 | -23.8 | 2.4 | 23.9 | 1153.9 |
| MP82 GUIDANCE | A 0 | 900, 55, 2803 | 0:(122,172) | no | 0:(93,288) | 0x01 | -24.1 | 1.4 | 24.1 | 1238.5 |
| | B 1 | 2011, 21, 1377 | | no | 0:(201,149) | 0x25 | -23.3 | 2.1 | 23.4 | 1637.0 |
| MP83 REQUIEM | A 0 | 1928, 224, 2591 | 0:(120,70) | no | 0:(188,245) | 0x07 | -23.4 | 2.4 | 23.5 | 2181.5 |
| | B 1 | 676, 187, 789 | | no | 0:(67,66) | 0x22 | -23.8 | 2.9 | 23.9 | 2171.6 |

**Counts:** 0 of 44 inside their map's start-point cell. 44 of 44 fitted by a slot of their own side: 4 at the
centre (<= 0.51 units, the `KNOWN.md` §1 rows), 40 behind it along its facing (`along` -28.0 to -20.1, median
-23.8; `perp` 1.0 to 3.2, positive on all 40). 44 of 44 nearer their own side's slots than the other side's (by
824.6 units at the least).

**The facing.** Facing *k* points along `(sin 45k°, -cos 45k°)` in (x, z): 0 is -z, 2 is +x, 4 is +z, 6 is -x.
That is not assumed; with the 40 sweep rows known to be the orbit camera behind the actor (§11), it is the
one convention under which all 40 lie behind a slot of their own side, over all eight facings on side 0 and
facings 0-6 on side 1. A wrong convention scatters them. (Corrected 2026-09-28, §11: this said
`(-sin 45k°, cos 45k°)`, 0 is +z -- the negation, derived by taking the 40 rows for the actor ahead of its slot.)

**The 20-28 units.** The 40 sweep rows are the third-person orbit camera, which sits behind the actor along its
facing (§11), and the two `KNOWN.md` rows the actor's feet; about 24 units back and 1-3 across is the camera's
offset from an actor standing on the slot. (Corrected 2026-09-28, §11: this read them as the actor after each side
had been moved -- research 33 "Method": the controllability holds, then alternating strafes -- "this one, then
moved forward". The rows are read from the camera record, not the actor, and are not a movement.)

## 8. The 2D briefing overlay

Research 72 §6 read `Opacity( 0.5 )`, `Color( 87 112 176 )` and `blue - water rivers and sea` as the briefing
map's overlay. **They are not records.** `dump-aimaps.ts MP2 --strings` places them in the header pad at +0x88
of Frostfire's `Ramps` and `Tunnels`, each cut at the field's edge (`lor( 87 112 176 )\tOpacity( 0.5 )`,
`) ); blue - water rivers and sea`) -- the field that holds `80 80 ...` on the same file's `BaseMap`. Over the
22 files the same 32 bytes hold stale text on 13 sub-maps (`loadable "resource".  It will`,
`( Type( 6 ) Color( 176 60`, `the little arrows filled w/outli`, `rcs_MSG`, `LeftMargin`,
`_ANIM_SHOTGUN_MSG`): the uninitialised buffers of the tool that wrote the file, which also left the pointer-like
words of §4 and §5.2. Every other printable run of six bytes or more in the 22 files is a name field, but
three: Vigilance's two date-time pairs, which happen to spell `je(/je(/`, and one spawn record's third word on
Bitter Jungle.

The only line data in the file is §5.6's polylines -- on 3 of the 22 maps, in cell coordinates. They are the one
candidate the file offers for a drawn briefing map; they are **not** the overlay of the other 19, which have
none. Located, described, not drawn; whether they outline the map's buildings (their shapes are rectangles and
walls in an ASCII plot of Frostfire's) is for the viewer to show by drawing them over the world. The other
candidate is outside this file: the loading-screen assets research 72 §0 lists (`ui/assetlib/ld/om02` ...).

## 9. Not decoded, and the next step

- **Not decoded:** the cell word beyond bit 31 and the marker (bits 0-3, 9-18, 21-27); the second cell words;
  the header's +0x58 and +0x68; a marker's word and its 32 bytes; a link's word; the link block's entries; a
  zone's kind; a spawn record's third word; the polylines' `value`. None is needed for spawns.
- **The next step for W1.R4 is a ruling, not a decode.** The file is read; what it says about spawns is the
  slot list. Two readings for the controller and the owner: (a) the table stays the source, as now; (b) the bar
  becomes "all 44 fitted by a slot of their own side" -- met, 44 of 44 -- and the viewer draws each side's
  slots from the disc (`spawnSlots`), a map never measured gets them too, and `spawns.ts` becomes the test
  oracle it already is in `aimaps.test.ts`. A single "the spawn" per side needs the game's slot choice, which
  is not in the file: the next research step is the recomp's reader of the trailer's list (a loop over 12-byte
  records testing flags bits 4 and 5).
- **Heights:** no record has a y; a slot's floor comes from W1.4's ground probe.

## 10. The trailer's order, and the slots as drawn (2026-09-28, W1.5b)

- **A stood on side 0's first slot and B on side 1's second, on all 22 maps.** Numbering each side's slots from 0
  in the trailer's order (§6; `placeSpawnSlots`' `index`), the one slot that accounts for the measured A (the spec's
  W1.R9: at its centre, or up to 30 units behind it along its facing within 5 across -- *ahead* until §11
  corrected the facing; the same slot either way) is side 0's **#0**, and for B side
  1's **#1** -- 44 of 44, `tools/spawn-slots.ts`. On every map exactly one slot of the side qualifies, #0 and #1 of
  a side are 22-851 units apart, and in the sub-maps' own lists (§5.5) the same slots sit at scattered positions
  (0-23), so the order that carries it is the trailer's alone. In the 2026-09-17 sweep and `KNOWN.md` §1's rows A is
  the host and B the joiner; that the game hands the n-th player slot n of their side's list fits all 44 and is not
  shown here -- the recomp's reader of the list (§9) is where it would be. The viewer does not act on it: the
  opening stand stays `spawns.ts`'s A (W1.R9).
- **The slots as drawn.** `LoadedMap.slots` (`placeSpawnSlots`, read in the worker by `spawnSlotsOf`): 1,058 slots
  over the 22 maps. No record holds a height (§4), so the y is the side's measured y held inside the slot's
  sub-map's y range (§3) -- held on 101 of the 1,058: Death Trap's B, measured at y 1, has 11 slots on sub-map 1
  (y -100 to -20) and 9 on sub-map 2 (-140 to -100.5), drawn at -20 and -100.5; Rat's Nest's 48 on `Floor1` come
  down 11-12 units to 154.5, Chain Reaction's A 24 on `floor4` 6 to 266.1, The Mixer's B 9 on `terrw` 20 to 81.2 --
  and the range's floor on a map with no measured spawn. A rough check against the collision hull (every hull
  polygon whose footprint holds the point, the plane height nearest the estimate) puts that estimate within 3
  units of a floor at 67 of the 1,058 slots, 48 of them Frostfire's: the y is a placeholder for W1.4's probe, and
  the overlay draws the slots without a depth test so that a wrong one cannot hide a slot. The same check puts
  the 40 sweep rows of `spawns.ts` 12.7-38.1 units above the only floor under their own (x, z) (median 25.0; 3
  have a surface 12-25 units above them instead), and the 4 `KNOWN.md` §1 rows 0.0-1.1: the sweep's y is not the
  feet, as its (x, z) is not the slot (§7) -- §11 says what it is.

## 11. Correction: the 40 sweep rows are the orbit camera, and the facing turns the other way (2026-09-28, later)

**What changed.** §7 derived the facing as `(-sin 45k°, cos 45k°)` by reading the 40 rows of the 2026-09-17 sweep
as the actor, standing 20-28 units *ahead* of its slot. They are not the actor. The sweep's spawn column is the
`PS2X_PEEK=0x416054:3` record, which `tools_py/parity/online_match_ours.py:42-45` names "the local player's
ORBITING CAMERA record ... the camera sits CAMERA_ORBIT_RADIUS units behind the player along its facing"; research
18's calibration measured that orbit radius at 23.09 (three fits, 22.16-24.91). W1.4's ground probe settled it
from the other side: the recorded y is a median 25.000 above the floor under the row (exactly 25.000 on flat
ground), and 36 of the 40 rows have a floor at y - 25 on the 23.1-unit orbit ring behind the actor. The rough
hull check of §10 agrees (37 of the 40 rows 12.7-38.1 above their floor, median 25.0). The 4 `KNOWN.md` §1 rows
(Frostfire, Vigilance) are the actor's feet, 0.0-1.1 above the floor, and sit at a slot's centre.

**The facing, derived again.** With the camera behind the actor, an actor on a slot faces from the camera toward
the slot. Of the sixteen conventions "step 0 along one of eight axes, 45 degrees a step either way", exactly one
puts all 40 camera rows behind a slot of their own side (`along` in [-30, 1], `|perp|` <= 5): step k points along
**`(sin 45k°, -cos 45k°)`** -- 0 is -z, 2 is +x, 4 is +z, 6 is -x -- with the camera 20.1-28.0 units back
(median 23.8) and the bearing from camera to slot 2.2-7.6 degrees off the facing, to the same side on all 40
(mean 5.0; research 18's calibration read the camera's bearing a few degrees off the walk heading too, -3.56 on
average). The next best convention places 22 of the 40. It is the exact negation of §7's, so every row fits the
same slot as before and only the signs of `along` and `perp` change.

**Where it was corrected** (each place says so): `facingVector`, `fitSpawn`, `fitSlot` and `accountsFor` in
`web/packages/scene/src/aimaps.ts` (the W1.R9 oracle: an actor row at a slot's centre, a camera row up to 30 units
*behind* one along its facing); the viewer's slot arrows, which follow `facingVector`; `tools/aimaps-spawns.ts` and
`tools/spawn-slots.ts`; §0, §7 (the window, the table's `along` and `perp` columns negated -- checked row by row
against the re-run tool -- the counts, "The facing" and "The 20-28 units") and §10 here; and
`web/packages/scene/src/spawns.ts`, whose comment called the 40 rows "the actor block of both players" at "the
players' feet". Nothing in §2-§6 depended on the facing's direction; §10's slot order (A on side 0's #0, B on side
1's #1) is unchanged, the fitted slots being the same.
