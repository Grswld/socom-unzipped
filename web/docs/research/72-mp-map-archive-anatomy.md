# Multiplayer map archives at the byte level: what a browser viewer must implement (2026-09-20)

Read-only spike for the browser recreation (`71-browser-recreation-scoping.md`). Nothing in the tree was modified;
no build, no game run. Primary archive **MP2.ZDB = FROSTFIRE**; secondary **MP6 = DESERT GLORY** and
**MP72 = CROSSROADS**; MP1 and MP5 were dumped as extra samples. The throwaway scripts and the full dumps (key
trees of every member, per-chain VIF traces, decoded rdr scripts) live in the session scratchpad under `mapdump/`
and are reproducible from this write-up: `zarlib.py` (ZDB+ZAR parser), `vifscan.py` (chain walker), `rdr.py`.

## 0. Map name to ZDB (all 22 MP archives)

There are **22** MP archives (`MP3` and `MP4` do not exist). The display name is the `description` key of
`mission.rdr` inside each archive's `RUN\MP\<map>\READERM.ZAR`; the loading-screen path is `LoadingScreenAssets`.

| ZDB | name | loading assets | bytes |
|---|---|---|---|
| MP1 | BLIZZARD | ui/assetlib/ld/om01 | 9,084,928 |
| **MP2** | **FROSTFIRE** | ui/assetlib/ld/om02 | 7,985,152 |
| MP5 | ABANDONED | ui/assetlib/ld/om05 | 9,535,488 |
| **MP6** | **DESERT GLORY** | ui/assetlib/ld/om06 | 10,852,352 |
| MP7 | NIGHT STALKER | ui/assetlib/ld/om07 | 9,512,960 |
| MP8 | RAT'S NEST | ui/assetlib/ld/om08 | 11,732,992 |
| MP9 | BITTER JUNGLE | ui/assetlib/ld/om09 | 11,038,720 |
| MP10 | BLOOD LAKE | ui/assetlib/ld/om10 | 10,676,224 |
| MP11 | DEATH TRAP | ui/assetlib/ld/om11 | 9,822,208 |
| MP12 | THE RUINS | ui/assetlib/ld/om12 | 9,826,304 |
| MP51 | VIGILANCE | ui/assetlib/ld/lp51 | 10,074,112 |
| MP52 | THE MIXER | ui/assetlib/ld/lp52 | 12,677,120 |
| MP53 | FOXHUNT | ui/assetlib/ld/lp53 | 11,794,432 |
| MP61 | SUJO | ui/assetlib/ld/lp61 | 10,735,616 |
| MP62 | ENOWAPI | ui/assetlib/ld/lp62 | 10,362,880 |
| MP64 | SHADOW FALLS | ui/assetlib/ld/lp64 | 10,391,552 |
| MP71 | FISH HOOK | ui/assetlib/ld/lp71 | 11,046,912 |
| **MP72** | **CROSSROADS** | ui/assetlib/ld/lp72 | 11,612,160 |
| MP73 | SANDSTORM | ui/assetlib/ld/lp73 | 12,093,440 |
| MP81 | CHAIN REACTION | ui/assetlib/ld/lp81 | 9,381,888 |
| MP82 | GUIDANCE | ui/assetlib/ld/lp82 | 12,201,984 |
| MP83 | REQUIEM | ui/assetlib/ld/lp83 | 12,156,928 |

**MP1 is BLIZZARD, not Crossroads** (every model in `MP1_GEO.ZED` is `alaska4d_*`). Frostfire is MP2 (`cuba1a_*`
textures, `Ramps.map` / `Tunnels.map` AI maps).

## 1. Container layout (confirmed)

Both layers parse exactly as documented on all five archives, with no exceptions.

- **ZDB**: 0xA0 header, `u32 count` at 0x98, `entrySize=0x5C` at 0x9C, 92-byte entries
  (`03-socom2-technical.md:11`). MP2 has 53 members, MP6 53, MP72 62, MP1 53, MP5 60.
- **ZAR/ZED v2**: 100-byte head, string table, `key_count` 16-byte keys in pre-order, align to `padding`, data
  blob (`11-recom-applicability.md:69-101`; `research/recom/src/gamez/zArchive/zar.h:51-63`,
  `zar_main.cpp:45-71`, `:676-790`).

Ambiguities resolved:
- **`key.offset` is relative to the data blob start**, not the file. In `MP2_TXR.ZED` (blob at 3280) the first
  `texdat` is at key offset 0x10 with size 65,696, and the next is at 0x100B0 = 0x10 + 65,696. Keys are
  contiguous in the blob, each padded to the 16-byte `padding`.
- **`child_count` nests properly**: each count is the number of immediate children, each itself a full pre-order
  record. Recursing from the root consumed exactly `key_count` records in all 281 members across five archives.
- **`flags == 0` everywhere** in retail; no "securify" pass.
- Every member of every archive is a plain v2 ZAR **except `AIMAPS.MPS`** (section 6).

## 2. Structure of the map's own files (Frostfire)

### `MP2.ZED`, the world root (4,240 B, 33 keys)
Matches `FUN_00318da0` and reCOM `CSaveLoad::Load` (`research/recom/src/gamez/zNode/node_saveload.cpp:236-341`)
field for field:

```
DefaultMaterial(str) FoliageSound(str) MetersPerUnit(f32) ShadowVector(3xf32)
GlobalLighting(112B) NightMission(u32) LensFX_NVG(16B) LensFX_StarlightScope(16B)
WorldTextSpecs(16B) cameras{camera 144B = tag_CAMERA_PARAMS} grid_params(20B)
assetlibs{11 names} world_tree(empty) LOD_Object(320B)
Material_Palette{palEntry_0{dat 60B}, palEntry_1{dat 60B}} TextureScroll_Object(2080B)
```

- `worldmodel`, `light_list` and `GriddedTerrain` are absent from all five maps. `worldmodel` is a key of
  `WORL_MDL.ZED`; the other two are optional fetches (`node_saveload.cpp:287`, `:317`) that miss on MP maps.
- `world_tree` is present but empty on all five. Placement lives in `MP*_GEO.ZED` and `CLUTTER.ZAR`.
- `grid_params` is `tag_GRID_PARAMS`, read by `CGrid::Read` (`research/recom/src/gamez/zGrid/grid_main.cpp:156`);
  cells are generated at load (`grid_main.cpp:138`), not stored.
- `assetlibs` = `//mp/mp2/{flib,clib,junkyard}`, `//common/assetlib/{font,hud,hud2,weapons,hudweaps,alpha_fx,
  effects}`, `//mp/mp2`.

### `MP2_GEO.ZED`, scene graph plus collision (445,856 B, 10,433 keys)
Root, then `models`, then one key per model prototype. Each is a `CNode` read by
`research/recom/src/gamez/zNode/node_io.cpp:251-320`:

```
<modelname>
  nparams      96 B   (matrix 64 B + bbox 32 B; node_io.cpp:275-276)
  model_name   str    (instance nodes only; node_io.cpp:29)
  regionmask   u32    (optional; node_io.cpp:31)
  visuals { vis { vparams 24B, detail_cnt u32, detail_size u32, detail_buff N B } }
  di { di { params 12B, points 16*N B } ... }
  children { <child node> ... }
```

> **Superseded 2026-09-21:** `nparams`' 96 bytes are the 64-byte matrix, a **24**-byte bbox (`CBBox` is two
> `CPnt3D`), then the u32 `m_type` (2 = instance node) and a u32 flag word -- not a 32-byte bbox. See
> `web/packages/mesh/SEMANTICS.md` §11.2 / the viewer spec §9.

`vparams` / `detail_cnt` / `detail_size` / `detail_buff` are exactly `CVisual::Read`
(`research/recom/src/gamez/zVisual/vis_main.cpp:276-297`). **`detail_buff` is not mesh data**: 28 bytes of LOD and
detail-texture parameters containing baked PS2 pointers, dead on disc.

| | MP2 | MP6 | MP72 | MP1 | MP5 |
|---|---|---|---|---|---|
| model prototypes | 46 | 87 | 70 | 47 | 29 |
| instance nodes (`model_name`) | 206 | 167 | 196 | 160 | 23 |
| visuals (`vparams`) | 177 | 604 | 263 | 218 | 205 |
| collision polys (`di`) | 2,756 | 5,442 | 8,168 | 7,773 | 7,319 |
| total keys | 10,433 | 21,114 | 27,497 | 25,945 | 23,580 |

### `MP2_MDL.ZED`, prop meshes (230,544 B, 479 keys)
Root, then one key per model; the key's **data is that model's DMA chain buffer**. Children named `N%03d_%03d` or
`N%03d_I%03d_V%02d` each hold a **4-byte u32: the byte offset of that node's chain header inside the buffer**. The
naming is the `sprintf` in `hookupVisuals` (`vis_main.cpp:88-105`); an `_L` suffix marks a dynamically lit node
(`vis_main.cpp:97-101`).

### `WORL_MDL.ZED`, the world mesh (490,800 B, 125 keys)
One model key, **`worldmodel`** (485,600 B of DMA chain), with 123 `N%03d_000` chunk offsets. MP6 has 318 chunks,
MP72 116, MP1 80, MP5 141.

### `CLUTTER.ZAR`
`Clutter -> <modelname> -> a_clutter -> {params 96B, scale_inverse f32}`, one per instance. **Frostfire and
Crossroads have none** (192-byte stub); Desert Glory 6 models / 110 instances; Blizzard 12 / 211.

### `READERM.ZAR`
Flat, 13 or 14 compiled `.rdr` keys: `aimaps, vehicles, actions, chartype, dyntex, layers, lod, mission, mp2,
mp2_lib, sndjukeboxm, valves` (plus `clutter`, `lensflare`, `net_000`, `*_lib` elsewhere). See section 6.

## 3. DMA chains: VIF histogram and MSCAL entries

**The chains are in `WORL_MDL.ZED` and `MP*_MDL.ZED`, not in `MP*_GEO.ZED`**, which contains no DMA tags at all.

Each `N...` offset points at a **count quadword**, then that many 16-byte DMA source tags
(`CVisual::GetChainData`, `vis_main.cpp:380-392`: `m_dmaQwc = *tag[0].u8; m_dmaChain = &tag[1];`).

Each tag is a real DMAtag with the relocation type stashed in the DMAC-ignored bits 16-23:

| tag word 0 | meaning |
|---|---|
| bits 0-15 | QWC |
| bits 16-23 | **relocation type**, read as `chainPkt.u8[2]` by `CVisual::SetBuffer` (`vis_main.cpp:325-370`) |
| bits 28-30 | DMA ID (`cnt`, `ref`, ...) |
| word 1 | ADDR, a **byte offset inside this model's buffer**; types 1/2/4/7 are patched to `buffer+offset`, type 6 is a texture-name offset resolved by `CVisual::ResolveTextureName` (`vis_main.cpp:418-430`) |
| words 2-3 | the two tag-transfer VIF1 codes |

Relocation types observed: **2, 3, 4, 6** everywhere, plus **1** on MP6 (31 tags) and MP72 (163 tags).

A complete chain (Frostfire `worldmodel` node `N000_000`):

```
tag1 ID=cnt QWC=0  reloc=6 ADDR=0x11A0   TEXNAME "cuba1a_sky01.tif"
tag2 ID=ref QWC=3  reloc=3 ADDR=0x1170   tte: STCYCL 0x0101 ; UNPACK V4-32 num=2 addr=2 (FLG)
                                         data: MSCAL imm=0x0000 ; NOP NOP NOP
tag3 ID=ref QWC=9  reloc=4 ADDR=0x11C0   tte: STCYCL 0x0103 ; UNPACK V4-8 num=36 addr=6 (FLG,USN)
tag4 ID=ref QWC=50 reloc=2 ADDR=0x0      STCYCL 0x0101 ; UNPACK V4-32 num=4  addr=0   (FLG)
                                         STCYCL 0x0203 ; UNPACK V4-16 num=72 addr=4   (FLG)
                                         STCYCL 0x0102 ; UNPACK V4-8  num=12 addr=112 (FLG,USN)
                                         STCYCL 0x0102 ; UNPACK V3-16 num=12 addr=113 (FLG)
                                         MSCNT ; NOP
... tag5/tag6 repeat the (colours, geometry+MSCNT) pair for the next sub-packet
```

A drawn sub-mesh is: 4 quadwords of header and matrix (V4-32), N vertices as V4-16 pairs at `STCYCL CL=3 WL=2`,
per-vertex RGBA as unsigned V4-8, and a V3-16 block interleaved at `STCYCL CL=2 WL=1`, then `MSCNT`. Every unpack
is `FLG=1` (TOPS-relative), the classic VIF1 double-buffered path. Ref addresses point back into the same buffer,
so a chunk's vertex block usually sits before its chain header.

| archive | chains | DMA tags | VIF command histogram |
|---|---|---|---|
| MP2 `worldmodel` | 123 | 1,450 | NOP 2953, STCYCL 2389, UNPACK 2389, MSCNT 416, MSCAL 309 |
| MP2 `MP2_MDL` (35 models) | 433 | 2,532 | NOP 4644, STCYCL 3810, UNPACK 3810, MSCNT 636, MSCAL 630 |
| MP2 `FLIB_MDL` (7 models) | 12 | 82 | NOP 175, STCYCL 137, UNPACK 137, MSCNT 24, MSCAL 17 |
| MP6 `worldmodel` | 318 | 1,952 | NOP 3987, STCYCL 3300, UNPACK 3300, MSCNT 581, MSCAL 395 |
| MP6 `MP6_MDL` (67 models) | 555 | 3,164 | NOP 5849, STCYCL 4852, UNPACK 4852, MSCNT 833, MSCAL 749 |
| MP72 `worldmodel` | 116 | 3,618 | NOP 7602, STCYCL 6509, UNPACK 6509, MSCNT 1175, MSCAL 634 |
| MP72 `MP72_MDL` (62 models) | 373 | 2,976 | NOP 6231, STCYCL 4902, UNPACK 4902, MSCNT 935, MSCAL 553 |
| MP1 `worldmodel` | 80 | 948 | NOP 2053, STCYCL 1722, UNPACK 1722, MSCNT 312, MSCAL 162 |
| MP5 `worldmodel` | 141 | 1,344 | NOP 2878, STCYCL 2424, UNPACK 2424, MSCNT 438, MSCAL 234 |

**Only five VIF commands exist in map geometry: NOP, STCYCL, UNPACK, MSCAL, MSCNT.** Zero decode errors.

UNPACK formats, **exactly five**, on every map:

| format | role | count (MP2 world) |
|---|---|---|
| `V4-32 FLG` num=2 addr=2 | per-packet parameter/command quadwords preceding `MSCAL` | 309 |
| `V4-32 FLG` num=4 addr=0 | packet header + object matrix | 416 |
| `V4-16 FLG` (`CL=3 WL=2`) | vertex positions, 16-bit fixed point, 2 qw per vertex | 416 |
| `V4-8 FLG USN` (`CL=3 WL=1` / `CL=2 WL=1`) | per-vertex RGBA | 416 + 309 |
| `V3-16 FLG` (`CL=2 WL=1`) | interleaved normal/UV block | 416 |

**MSCAL immediates:** every archive yields only `imm=0`. **Every MSCAL in every map archive is `MSCAL 0`, VU1 micro
address 0.** No `MSCALF`. **Zero `MPG` packets** in any map archive: the microprogram comes from game code, never the
map. **Zero `DIRECT`/`DIRECTHL`, therefore zero GIFtags in map geometry**: VU1 builds every GIF packet and
`XGKICK`s it. GS register addresses appear only inside texture records (section 5).

**Caveat:** `CLIB_MDL.ZED` (character models) uses a different chain form (`vtype` 1/2, `CMesh`/`CSubMesh`,
`vis_main.cpp:246-265`, hooked up through `MESH_%s` keys by `hookupMesh`, `vis_main.cpp:31-55`); the walker above
produces garbage on it. Map geometry is unaffected.

## 4. VU1: what the map targets versus what the project translates

The runtime keys programs on (16 KB code-image hash, entry pc) (`ps2xRuntime/include/runtime/ps2_vu1.h:461-472`).

| | coverage |
|---|---|
| generated whole-image translation | one image, hash `0xd418194495c25213` ("SOCOM II mission image"), `vu1gen_d418194495c25213` (`ps2xRuntime/src/lib/vu/generated/vu1_known_programs.cpp:15-18`; 16,446 lines) |
| hand-written native entry | exactly one: `{0xd418194495c25213, 0x1b50, &vu1native_socom2_dispatch}` (`vu/native/vu1_native_programs.cpp:13-20`; 3,503 lines) |
| entry pc 0 | not hand-written: "a command-list upload stub that emits nothing and is left to the generated code" (`vu1_native_programs.cpp:15-17`) |

| MSCAL found in the map | VU1 pc | covered by | as what |
|---|---|---|---|
| `MSCAL imm=0` (every one, all 5 maps) | 0x0000 | generated image | entry 0: matrix setup and command-list upload |
| the `MSCNT` after it | 0x1b50 (where entry 0 ends) | hand-written dispatcher and the generated image | the command dispatcher, families A/B/C, the actual drawing |

This is the hand-off in `12-vu1-entry0-ui-path.md:29-40`: entry 0 copies `header.z` quadwords into data quadword
340 onward and ends on the E bit at `0x1b40` with `pc = 0x1b50` (`12:62-80`). On the title screen `header.z == 0`
so the dispatcher is never reached; **in a map every packet supplies a command list, so the following `MSCNT`
resumes at `0x1b50`.** The two-quadword `V4-32 addr=2` unpack before each `MSCAL 0` carries small even words
(`0x44 0x42 0x60 0x14`) with the shape of the dispatcher's command words (`12:80-95`); the exact quadword-to-command
mapping was not proved here.

So: **the VU1 microprograms the map geometry targets are already covered**, both the entry the map names (0) and
the entry it continues into (0x1b50). The map's chains use the entries the docs call world objects and terrain:
`13-vu1-family-b-world-objects.md` covers the `0x1b50` handlers, `15-vu1-fourth-family.md` the remaining commands,
and terrain specifically is family B (`tools_py/research/terrain/README.md:11`). Coverage is for **one image hash**,
r0001; another revision's microcode runs on the interpreter (`vu1_native_programs.cpp:10-12`).

A browser viewer does not have to run VU1 at all: VU1 only adds transform, lighting, clipping and GIFtag assembly.
The translations matter as the **reference** for the fixed-point vertex semantics, not as code to port.

## 5. Textures and palettes

### Texture record (`MP2_TXR.ZED -> textures -> <name>.tif -> texdat`)
Starts with the 16-byte `TEXTURE_PARAMS` of `research/recom/src/gamez/zTexture/ztex.h:20-37`, read verbatim by
`CTexture::Read` (`ztex_main.cpp:64-80`):

```
u16 m_width; u16 m_height;
u32 m_size;              // pixel bytes; always exactly w*h*bpp/8
u32 m_gsaddr;            // GS TBP0 in 64-word blocks, assigned by the exporter (1,2,3,...)
u32 { m_texelBitSize:8, m_selectQwc:8, m_pal_offset:8,
      m_transparent:1, m_palettized:1, m_is_mip_child:1, m_bumpmap:1,
      m_bilinear:1, m_transp_1bit:1, m_dynamic:1, m_context:1 }
```

`a_floor.tif`: header `00400040 00001000 00000001 12000608` = 64x64, 4,096 pixel bytes, gsaddr 1, 8 bpp,
`m_selectQwc=6`, palettized, bilinear.

- ~~**Pixel data follows the header immediately** (`ztex_main.cpp:77-79`)~~ **[SUPERSEDED
  2026-09-21.]** It does not. **One quadword of the texture's GIF upload packet sits between
  `TEXTURE_PARAMS` and the texels**, so the pixels begin at **offset 32**, not 16.

  **[data]** Those 16 bytes are byte-identical in every texture of every extracted map:

  ```
  08 00 00 00  00 00 00 00  AF AF AF AF  AF AF AF AF
  ```

  Measured with `web/tools/probe-head.ts` over all **83 direct 32bpp textures across the 22 maps**
  (83 of 83) and all **53 palettised textures in MP2** (53 of 53). Sixteen bytes that do not vary
  with the map, the size, the format or the content are not image data.

  **The image runs to `HEADER + PREFIX + size`, so `size` counts texels alone.** The bytes
  immediately past the old slice continue the image rather than starting the bind packet: for
  `lightrays.tif` (32x32, `size` 4096) the four texels at record offsets 4112-4127 read
  `199,203,181,0`, the same glow colour and zero alpha as the rest of its last row.

  **What the quadword is.** reCOM names it only by the variable it reads it through:
  `ztex_main.cpp:76-79` sets `_word128* texGifPtr = &texturePacket;` then
  `m_buffer = &texGifPtr[1].u32[0]` -- `m_buffer` is `texdat + 16`, i.e. the **GIF packet**, and the
  texels are one quadword further in. `TEXTURE_PARAMS` is exactly 16 bytes (`ztex.h:20-37`:
  `u16 + u16 + u32 + u32 + u32`), which is the quadword `&texGifPtr[1]` skips. The original bullet
  read `m_buffer` as "the pixels"; it is the packet whose first quadword is the tag.

  **reCOM does not define the quadword's fields** -- searched `zTexture/` and found no struct for
  it, so the reading below is inference, not citation. Read as a GIFtag the low word gives
  `NLOOP = 8`, `EOP = 0`; the high word, `0xAF` repeated, is not a meaningful `REGS` descriptor (no
  GS register is 0xA), which fits a tag the exporter leaves as fill for the engine to patch at
  upload time. `0xAF` is a fill byte, not data.

  Note the palette path has no such prefix: `ztex_palette.cpp:29-30` does
  `m_buffer = zmalloc(m_size); Fetch("buf", m_buffer, m_size)` straight into the buffer.

  **What it cost.** Reading the prefix as pixels shifted every texture by 16 bytes -- four texels at
  32bpp, sixteen at 8bpp. That is a fraction of one row, which is why the M2 contact sheets passed;
  but on a 32x32 lamp flare the four stray texels land on the top edge as two fully opaque dots, and
  those are what made the glows draw as squares with a bright corner.

  The pixels are otherwise as described: exactly `w*h*bpp/8` bytes, no mip chain inside the key, no
  page padding. Mips are separate keys flagged `m_is_mip_child`.
- **After the pixels is a 144-byte (9-quadword) prebuilt bind packet.** One quadword is a GS `TEX0` register
  value: `a_floor.tif` gives `0x201026E599304001` = `TBP0=1`, `PSM=0x13` (PSMT8), `TW=6`, `TH=6`, `TBW=1`,
  `CBP=311`, `CPSM=2` (PSMCT16). `flooroil_detail.tif` gives `PSM=0` (PSMCT32), `CBP=0`. The rest are VU1
  parameter words of the same shape the geometry packets unpack before `MSCAL 0`.
- **Settled 2026-09-20 (M2):** the pixel bytes are **plain raster rows**, not pre-swizzled. All 65 Frostfire
  textures were decoded both ways and looked at: raster gives materials you can name -- `sign04.tif` reads
  "DANGER / FLAMMABLE LIQUID" -- while reading the same bytes as the GS PSMT8 page layout (16x16 blocks inside
  128x64 pages) shuffles every 8-bit texture into block hash. The rows are stored **bottom-up**: `sign04.tif`
  decodes upside down, so a viewer flips V.
  **Superseded 2026-09-21:** "bottom-up" is the same thing GL and glTF call V = 0, so a viewer that uploads
  the rows in memory order with `flipY = false` needs no flip at all, and the UVs go up unchanged. See
  `web/packages/mesh/SEMANTICS.md` §11.2 / the viewer spec §9 (M3).
- **The 8-bit palettes do carry the GS `csm1` CLUT layout** (settled the same way): entries sit in blocks of 32
  whose two middle 8-entry groups are swapped, undone by `(i & ~0x18) | ((i & 0x08) << 1) | ((i & 0x10) >> 1)`.
  `cuba1a_sky01.tif` is the witness -- a smooth cloud sky with the swap undone, a hard-banded contour map
  without it. Every other field is certain.

### Palette record (`MP2_PAL.ZED -> palettes -> texpal_<id> -> {par, buf}`)
`par` is the 8-byte `PALETTE_PARAMS` of `ztex.h:39-47` (`ztex_palette.cpp:27-30`):

```
u32 m_gsaddr;    // == the numeric suffix in the key name
u32 { m_size:16, m_format:8, m_combo_pal:1, m_dynamic:1, m_unused:6 }
```

`m_format=2` means a 512-byte `buf` of 256 x 16-bit PSMCT16 (RGBA5551); `m_format=0` a 1,024-byte `buf` of 256 x
32-bit PSMCT32 with alpha pre-scaled to 0..0x80.

### The TXR to PAL to GEO link
1. **Geometry to texture**: a `reloc=6` DMA tag whose `ADDR` is the byte offset of a NUL-terminated `.tif` name in
   the same model buffer. `CVisual::ResolveTextureName` (`vis_main.cpp:418-430`) looks it up by string in the world
   texture table, falling back to `null_xmas.bmp`.
2. **Texture to palette**: `TEX0.CBP` equals the palette's `par.m_gsaddr`, which equals the number in `texpal_<n>`.
   Verified on Frostfire: `a_dumpster.tif` gives 106 = `texpal_106`; `crane1.tif` 97; `a_steel20.tif` 98.
3. The gsaddr id space is **global across every PAL archive loaded for the map**: `MP2_PAL.ZED` holds ids 94..318
   while `CLIB_TXR` textures cite ids from `CLIB_PAL`. Build one id-to-palette map over all `*_PAL.ZED` members
   before resolving any texture.

| | textures | bpp mix | palettes | fmt (CT16/CT32) | texdat total |
|---|---|---|---|---|---|
| MP2 Frostfire | 65 | 53x8, 5x16, 7x32 | 53 (ids 94-318) | 48 / 5 | 651 KB |
| MP6 Desert Glory | 69 | 65x8, 4x32 | 65 (ids 94-330) | 56 / 9 | 696 KB |
| MP72 Crossroads | 106 | 106x8 | 105 (ids 103-383) | 78 / 27 | 783 KB |
| MP1 Blizzard | 90 | 83x8, 2x16, 5x32 | 81 (ids 94-346) | 68 / 13 | 687 KB |
| MP5 Abandoned | 45 | 37x8, 2x16, 6x32 | 38 (ids 98-307) | 22 / 16 | 614 KB |

Dimensions are all powers of two, 16x16 to 256x256, plus a few 64x32 and 128x64.

## 6. Collision and spawns

### Collision: `di` keys in `MP*_GEO.ZED`, per model
A `di` group holds one `di` child per convex polygon with `params` (12 B) and `points` (16 B per point), read by
`CDI::Read` (`research/recom/src/gamez/zIntersect/int_main.cpp:52-67`). The on-disc `params` is **12 bytes, not
the 28 of reCOM's `DI_PARAMS`** (`zintersect.h:16-29`): the leading normal is not stored, it is derived at load.

```
u32 m_region;
u32 m_refcount;   // 0x2d in every sample read -- superseded 2026-09-21, see below
u32 { m_ditype:2, m_ptcount:8, m_material:8, m_cameratype:2,
      m_appflags:3, m_inside:1, m_shadow:2, m_reserved:6 }
```

> **Superseded 2026-09-21:** `m_refcount` is **not** 0x2d in every polygon -- the sample that said so was
> narrow; over all 2,756 it varies. See `web/packages/mesh/SEMANTICS.md` §11.2 / the viewer spec §9.

Decoded `m_ptcount` equals `sizeof(points)/16` in **all 2,756 Frostfire polygons** and all polygons of the other
four maps. `points` are `CPnt4D` (4 x f32, `w` unused) in model space.

| map | most common (ditype, npts) |
|---|---|
| MP2 | (2,4) 1743, (3,4) 736, (2,3) 184, (3,3) 43, (3,6) 22, (3,5) 15 |
| MP6 | (3,3) 2621, (2,4) 1587, (3,4) 664, (2,3) 468, (2,5) 54 |
| MP72 | (2,4) 4528, (2,3) 1383, (3,4) 1111, (3,3) 901, (2,5) 66 |

Largest polygon seen: 12 points. **There is no `CCell`, `CDIBBox` or `GriddedTerrain` data on disc**; cells are
created at load from `grid_params`.

### Spawns: not in any `.ZED`
- No key in `MP2_GEO.ZED` or the world root matches `spawn|start|team|respawn|seal|terror|insert|extract`.
- `READERM.ZAR` holds the gameplay script as compiled `.rdr`: `{u32 version=1; u32 string_table_size;
  u32 node_array_offset}`, then the string table, then 8-byte nodes `{u32 (type:8, isclone:1, packed:1, unused:6,
  length:16); u32 value}`; for strings `value` is a byte offset from 12, for lists a byte offset from
  `node_array_offset` to the first of `length` children. `tools_py/rdr_tree.py:4-6` documents the same node struct
  but expects a RAM dump with absolute pointers, so it does not parse a file straight from the archive. Content:
  `mission.rdr` (`description "FROSTFIRE"`, elevation, the `Valves` list, `navyseals`/`terrorists` rosters);
  `vehicles.rdr` (`(name "player") (character "mp2_seal1") (setup ((playerstart 3))) (team 1 2)`: a **named
  reference**, not coordinates); `mp2.rdr` (`world_params`: `MetersPerUnit 0.1`, `ShadowVector`, the full
  `GlobalLighting`, `DefaultMaterial "METAL_THICK"`, NVG and starlight tints); `mp2_lib.rdr` (the texture manifest:
  `name`, `dim2 (w h bpp)`, `typeU/typeV`, `pal`, `detail{name,uv,range,bmode}`), so **wrap modes and detail-texture
  bindings can be read instead of guessed**.
- `AIMAPS.MPS` (212,828 B for Frostfire) is **not a ZAR**: `u32 version=2; u32 map_count=3;` zero words, a flags
  word, bbox floats, counts, cell sizes, then a 32-byte NUL-padded name. Frostfire's three maps are `BaseMap`,
  `Ramps`, `Tunnels`, matching `map_list` in `aimaps.rdr`. At 0x159D8 there is a region/layer table including
  **`PlayerStart`**, **`spectator`**, `Charlie`, `Delta`, `Echo`, `Foxtrot`. The file also carries the 2D
  briefing-map overlay (literal `Opacity( 0.5 )` / `Color( 87 112 176 )` / `blue - water rivers and sea` strings).
  **Spawn and insertion regions are named regions of the AI map, in `AIMAPS.MPS`, whose format is undocumented in
  this repo**: the one format gap for a viewer that wants to draw spawns.

## 7. What a viewer must implement

- **ZDB TOC reader**: small, about 20 lines, fully specified.
- **ZAR/ZED v2 reader**: small, about 40 lines, verified against 281 members
  (`research/recom/src/gamez/zArchive/zar_main.cpp:676-790`).
- **World-root reader**: small; flat key fetches; the only structs are `GlobalLighting` (112 B), `camera` (144 B)
  and `grid_params` (20 B) (`node_saveload.cpp:236-341`).
- **Scene-graph reader (`MP*_GEO.ZED`)**: small; `nparams` is a 4x4 matrix plus bbox; recurse `children`;
  `model_name` is the prototype reference (`node_io.cpp:251-320`).
  **Superseded 2026-09-21:** the 96 bytes are matrix 64 + bbox **24** + `m_type` u32 + flags u32, and
  `m_type == 2` is what marks an instance node -- which the reader needs. See
  `web/packages/mesh/SEMANTICS.md` §11.2 / the viewer spec §9.
- **DMA-chain walker plus VIF1 unpack**: medium. Only NOP, STCYCL, UNPACK, MSCAL, MSCNT and five UNPACK formats,
  all `FLG=1`, plus STCYCL skipping-write. The relocation byte and the ref-into-own-buffer convention are the only
  non-standard parts (`vis_main.cpp:325-370`). The repo's VIF1 lives in the C++ runtime
  (`ps2_vif1_interpreter.cpp`); the scratch `vifscan.py` decodes every chain of five maps with zero errors.
- **Vertex-layout interpretation** (fixed-point scale, V3-16 lane meaning, the header quadword's GIFtag template):
  medium, **and the main unknown**. Bit layout is certain; meaning comes from the VU1 translation
  (`vu/generated/vu1_d418194495c25213.cpp`, `13-vu1-family-b-world-objects.md`, and `15-vu1-fourth-family.md:17-22`
  on `ITOF15` versus `ITOF4` for position lanes). `tools_py/research/terrain/patch_dump.py` prints a family-B
  dump's vertex block: the fastest way to check a decode against a known-good one.
- **Texture decode** (PSMT8 with PSMCT16/PSMCT32 palettes, plus 16 and 32-bit direct): medium. Header exact,
  palette link exact; open questions are raster versus GS-swizzled byte order and the PS2 CLUT 32-entry interleave
  for 8-bit palettes. The runtime's swizzlers (`ps2_gs_psmct32/16/psmt8/psmt4.h`) are the reference.
- **Collision overlay (`di` polys)**: small; 12-byte params plus N x 16-byte points, verified.
- **Clutter placement (`CLUTTER.ZAR`)**: small; 96-byte matrix plus inverse scale per instance. Zero work for
  Frostfire and Crossroads.
- **Compiled `.rdr` reader**: small, about 30 lines. Gives map name, lighting, `MetersPerUnit`, texture wrap modes
  and detail bindings.
- **`AIMAPS.MPS`**: large and unspecified. Needed only for spawn points and the 2D minimap; everything else ships
  without it.
- **VU1 emulation**: not needed for a viewer. The VU1 work is the specification for vertex semantics.

**Suggested first slice for Frostfire:** `WORL_MDL.ZED -> worldmodel`, 123 chains, 485 KB. Needs only the ZDB
reader, the ZAR reader, the chain walker, the vertex decode and the texture decode: no scene graph, no clutter, no
`.rdr`, no `.MPS`. The 37 distinct texture names its chains cite all resolve inside `MP2_TXR.ZED` and
`MP2_PAL.ZED`.
