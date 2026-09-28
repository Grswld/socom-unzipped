# 78 — The character mesh, its skeleton and its gear: `CMesh`/`CSubMesh`, `CLIB_GEO`, `character.rdr` (2026-09-28)

Web sprint 2, W2.1 (spec `../specs/2026-09-28-web-sprint-2-the-player-design.md` §4). Research 72 §3 warned that the map
walker "produces garbage" on `CLIB_MDL.ZED`; this note is the format that replaces the warning, measured on all 22 maps'
character libraries (411 meshes) and cross-checked against the decompiled body of `zdb_CSubMesh_Read` (the owner's
handoff of 2026-09-28) and the game's own character-type file, `READERC.ZAR/character.rdr`.

Two kinds of claim, kept apart as SEMANTICS.md keeps them: **[data]** measured here with the tools named in §8, and
**[code]** read out of a named source -- reCOM (`research/recom/src/gamez/...`, a reference clone), research 13/15 (the
VU1 handlers), or the decomp (`decomp zdb_CSubMesh_Read_0x3b8c20`, cited by line, never copied). **[inference]** marks
what neither settles.

## 0. Headline

1. **A character is drawn in batches, one VU1 program each, and the skinning is on VU1.** Per bone a batch is skinned
   to, the chain sends that bone's matrix (relocation 9, filled from the palette at run time) and its vertex list
   (relocation 10); then one draw packet (relocation 11) with the index list, the GIFtag templates and the uvs. The bone
   lists are exactly what command `0x52` reads (research 15 §4.1): every vertex carries a position and a normal *in its
   bone's own frame*, a staging slot, and a weight. **[data]** 411 meshes, 24,061 batches, 176,319 tags, 0 failures.
2. **The palette is the bind pose.** `CLIB_GEO.ZED`'s `models/<name>` tree gives 26 nodes, each a `CSubMesh` (`vtype`
   2) whose `matrix_id` is its palette slot, in pre-order. Composing their `nparams` down the tree gives matrices under
   which every bone's own copy of every vertex lands on one point, to 0.0017 on all 411 meshes (a wrong palette misses
   by units). So one bind-space position per vertex plus inverse bind matrices -- three's `SkinnedMesh` -- is exactly the
   game's weighted sum for any pose.
3. **The decomp settles the record.** `zdb_CSubMesh_Read` (0x3b8c20) fetches one u32 into `this + 0x68` and tail-calls
   `zdb_CVisual_Read` (0x3c3570): no vertex, bone or weight lane is read on the EE. The key is `matrix_id` (§2.6).
4. **The gear is placed by `character.rdr`, in the character's own axes.** `mp2_seal1` (Frostfire's player,
   `chartype.rdr`) is `seal_A_scuba` in six pieces: two eyes, holster, assault belt, knife, satchel -- *no goggles*. Each
   piece is an `FLIB_MDL.ZED` model in the scaled VU1 form `0x70` (research 15 §2), hung from a named part at an offset
   whose turn undoes the part's bind turn to a few hundredths.
5. **The bind-pose SEAL is 19.431 tall, feet at 0, facing -z; its eyes are 18.16 up.** Not the 15.4 of W1.R2, which
   is research 17's camera target (§6.3).

## 1. Where the character is

| member | what | Frostfire |
|---|---|---|
| `CLIB_MDL.ZED` | one key a mesh, `MESH_<name>`: its data the whole DMA buffer, three u32 children | 17 meshes, 1,028,976 B |
| `CLIB_GEO.ZED` | `models/<name>`: the skeleton (§3) | 17 models, 3,487 keys |
| `FLIB_MDL.ZED` / `FLIB_GEO.ZED` | the gear, ordinary chunked models (`N%03d_%03d`) in the scaled form (§5.1) | 7 models |
| `CLIB_TXR`/`CLIB_PAL`, `FLIB_TXR`/`FLIB_PAL` | the textures, through the same GS path as the world | 7 + 7 on the SEAL |
| `RUN/READERC.ZAR` (not a map member) | `character.rdr`: gear offsets, characters' models and default gear (§5.2) | 1,026,848 B |
| `READERM.ZAR/chartype.rdr` (map member) | the characters a map fields, by side | `mp2_seal1` … `mp2_terror4` |

A mesh key's children **[data]**, all u32:

| key | meaning | seal_A_scuba |
|---|---|---|
| `MESH_<name>_START` | the byte offset of the chain's count quadword in the buffer | 83,008 of 89,504 |
| `ref_count` | the chain's tag count, equal to the count quadword's low half on all 411 | 405 |
| `mtx_count` | the palette's size, the model's `vtype`-2 node count | 26 on all 411 |

**[code]** reCOM's `hookupMesh` (`zVisual/vis_main.cpp:31-55`) builds the key with `sprintf "MESH_%s"` (`:38`) and
appends `_START` (`:46`), but then fetches `m_mtx_count` under that same `_START` key (`:49`) and indexes the buffer as
u32s (`:51`); the disc has a separate `mtx_count` and a *byte* offset (as a u32 index 83,008 would be 332 KB past the
buffer). Both are reCOM slips; the disc is the authority.

## 2. The `CMesh` chain

### 2.1 The count quadword and the tags

```
seal_A_scuba, from _START (0x14440):
14440  70000195 00000000 00000000 00000000   DMA id 7 (end), low half 0x195 = 405 tags = ref_count
14450  10060000 00000000 00000000 00000000   reloc 6, cnt, QWC 0: texture name at 0x0, "seal_scuba_glove.tif"
14460  30090004 00000010 01000101 6c048000   reloc 9, ref, QWC 4, ADDR = palette slot 16; STCYCL 1,1; UNPACK V4-32 num=4 addr=0
14470  300a0030 00000020 00000010 0000002e   reloc 10, ref, QWC 48 at 0x20; words 2-3 = (slot 16, 46 vertices)
14480  30090004 00000011 01000101 6c048000   reloc 9: slot 17
14490  300a0027 00000320 00000011 00000025   reloc 10: 39 QW at 0x320, (slot 17, 37 vertices)
144a0  300b001b 00000590 00000004 00000000   reloc 11, ref, QWC 27 at 0x590; word 2 = 4 = 2 x 2 bones
```

The count is a **u16**, which is what `CMesh::SetMeshTextureSelects` loops over (`zVisual/vis_mesh.cpp:5-24`, `u16[0]`,
checking `u8[2] == 6` for each tag); research 72's walker reads the map form's **u8**, `m_dmaQwc = *tag[0].u8`
(`vis_main.cpp:380-392`), which is where its garbage came from. **[data]** the high half is `0x7000` on all 411.

| reloc | DMA id | count on 22 maps | what the tag is |
|---|---|---|---|
| 6 | cnt, QWC 0 | 8,026 | a texture citation, the name at ADDR in the same buffer (36 §3's type 6) |
| 9 | ref, QWC 4 | 72,116 | a bone's matrix: ADDR is the **palette slot**, words 2-3 the two VIF codes that land it on `TOP+0..3` |
| 10 | ref | 72,116 | a bone's vertex list, words 2-3 `(slot, vertex count)` as two NOPs with immediates |
| 11 | ref | 24,061 | the draw packet, word 2 = 2 x the batch's bones, word 3 = 0 |

Every matrix tag is followed by one bone tag; a batch closes on its draw tag; the texture in force is the last reloc-6
before the draw. The relocation byte is what `CVisual::SetBuffer` switches on (`vis_main.cpp:325-370`): 9, 10 and 11
are new beside the map's 1-7. **[inference]** the EE patches a reloc-9 ADDR to the palette matrix's address at run time
-- the tag transfers four quadwords the file does not hold.

### 2.2 A bone list (reloc 10) -- VU1 `0x52`'s input

```
0x20:  01000101 6d5d8004 | 0002 0026 0010 002e | 2ada f82a 0027 0000 | e389 8b99 d30a 20e0 | ...
       STCYCL 1,1; UNPACK V4-16 num=93 addr=4 FLG | TOP+4                | vertex 0, qw a     | vertex 0, qw b
```

| quadword | lanes (i16) | meaning | conversion |
|---|---|---|---|
| `TOP+4` | `(flags, triangles, slot, count)` | the pass header | flags: bit 1 **first** pass (writes), bit 0 accumulate, bit 2 last |
| `TOP+5+2k` | `(x, y, z, dst)` | the vertex in **this bone's frame**; its staging quadword | `ITOF15 x 10`; vertex = dst / 2 |
| `TOP+6+2k` | `(nx, ny, nz, w)` | its normal in the bone's frame; its **weight** | `ITOF15` |

**[code]** research 15 §4.1-4.4: the header, the pairs, the `LOI 10.0` on the position alone, the accumulate pass, the
repack at `0x33c8`. Two things the data adds: the header's y lane is the **batch's triangle count** (equal to the draw's
`TOP+2.w` on all 72,116), and flag bit 1 marks the **first** pass -- 15 §4.1 saw only `2`, `1` and `5`; a batch of one
bone is `6` (first and last), 5,074 of the 24,061. **[data]** On every batch: the first pass lists every vertex exactly
once (its count is the draw's vertex count -- the repack loops over it, 15 §4.4), later passes list subsets, and a
vertex's weights sum to one to a lane's last bit per influence. 1.0 is stored as 32767.

Bones per batch run 1 to 14; bones per vertex 1 to 6 (seal_A_scuba: 995 vertices on one bone, 773 on two, 263 on
three, 62 on four, 1 on five).

### 2.3 The draw packet (reloc 11)

```
0x590: 01000102 6e26c08e <38 index entries>  STCYCL 2,1; UNPACK V4-8 USN num=38 addr=142 (= 4 + 3 x 46)
       01000101 6c048000 <4 qw>              STCYCL 1,1; UNPACK V4-32 num=4 addr=0: the header
       01000103 652e8005 <46 uvs>            STCYCL 3,1; UNPACK V2-16 num=46 addr=5: TOP+5+3k
       17000000                              MSCNT
```

The header is SEMANTICS §3's, lane for lane **[data]**, all 24,061: `TOP+0` a `TRIANGLE_FAN` template, `PRIM 125`
(`IIP|TME|FGE|ABE`), `NLOOP 0`, `EOP 1`; `TOP+1` a `TRIANGLE` template, `PRIM 123`, `NLOOP` = the vertex count; `REGS
0x412`, `NREG 3`; `TOP+2 = (4 + 3V, 0, V, T)`; `TOP+3 = 0`. The index entries are SEMANTICS §5's (byte / 3, flag byte 3
on all). What is **not** there: no position or normal (the staging repack writes them, 15 §4.4), **no colour** (the
repack stores one constant quad, data quadword 338, in every vertex's colour slot), and **no face normal** (`0x66`
recomputes it, 15 §5). The uv is `ITOF12`, as a map's. Fogged on every batch.

**[data]** Winding: the CCW normal of a triangle's bind-pose vertices agrees with its skinned vertex normals on
17,323 of 17,336 Frostfire triangles (99.9 %): CCW is front, as on the map, and `0x66`'s `(v2-v1) x (v0-v1)` is that
same normal. 8 triangles on Crossroads are zero-area in the bind pose; none repeats an index.

### 2.4 The batches and the sub-meshes

A batch is one VU1 program: `MSCAL` of the command list `52 66 08 40 42` (research 15 §1.1), each bone list's `MSCNT`
resuming at `0x33c8`, which re-runs `0x52` until the last-bone flag, and the draw packet's `MSCNT` running the repack and
then `66 08 …`. **[inference]** the EE sends that command list before the chain; it is not in the file. The decoder
merges the batches that share a (texture, fog) into one **sub-mesh** -- 56 batches in 7 on seal_A_scuba (glove, sleeve,
shirt, boot, pants, mask, face) -- re-basing indices; a vertex is never shared across batches.

### 2.5 `vtype` 1 and 2

**[code]** `CVisual::Create` (`vis_main.cpp:246-265`) reads `vtype` and builds a `CSubMesh` for 2, a `CMesh` for 1, a
plain `CVisual` for 0 or -1 (reCOM's switch lacks its `break`s; the game's does not, or `zdb_CSubMesh_Read` would never
run). **[data]** In `CLIB_GEO` the model node's one visual is `vtype` 1 -- the `CMesh`, whose buffer is `MESH_<name>` --
and every node below it has one visual of `vtype` 2 with a `matrix_id`. `vparams` word 0 is `0x0009c0fa` on both (bit 3,
the cull, set).

### 2.6 What the decomp body settles

`decomp zdb_CSubMesh_Read_0x3b8c20` is 19 instructions:

- lines 46-48: `a2 = this + 0x68`; lines 49-51 and 61-62: `a1 = 0x3fc2d0`, a string in the image; line 54: `a0` = the
  archive; line 55: `jal 0x25aa30` -- a fetch of one u32 (the same `(archive, key, &field)` shape as `zar_CZAR_Fetch`
  0x25a5d0, an overload the names table does not list) into `this + 0x68`;
- lines 72-80: `jal 0x3c3570` with `(this, archive)` -- `zdb_CVisual_Read` (`socom2_names.csv`): `vparams` and the detail
  keys (`vis_main.cpp:276-297`).

So the `CSubMesh` record on disc is **one u32 plus the visual's own keys**, and the only per-`CSubMesh` key in
`CLIB_GEO` besides `vtype` (read by the factory before `Read`) and `vparams` (read by `CVisual::Read`) is `matrix_id`:
that is the string at 0x3fc2d0, and `+0x68` is reCOM's `m_matrix_id` (`zvis.h:269`, defaulted to `0xabcd` by the
constructor, `vis_mesh.cpp:38-42`). **[inference]** for the string itself, which is not in the tree; by elimination.

What the body settles, then: the palette index is `matrix_id` and nothing else on the EE side; **no bone index or weight
is read by the reader** -- they are the reloc-9 slot and the w lanes of §2.2, consumed by VU1 alone; `mtx_count` is the
mesh's (read by `hookupMesh`, not by the `CSubMesh`); `vtype` 1 vs 2 is `CVisual::Create`'s. Everything in §2.1-2.4 is the
data's, and the decomp does not contradict any of it.

## 3. The skeleton

### 3.1 The tree

Frostfire's `seal_A_scuba` **[data]**, the palette slot = the pre-order index, parents in brackets:

```
 0 skel_root   [model]      1 hips [0]        2 rthigh [1]      3 rcalf [2]       4 rfoot [3]      5 rtoe [4]
 6 lthigh [1]  7 lcalf [6]  8 lfoot [7]       9 ltoe [8]       10 aimnodes [1]   11 spinelo [10]  12 spinehi [11]
13 rshoulder_wgt [12]      14 rscap [12]     15 rbicep [12]    16 rforearm [15]  17 rhand [16]
18 neck [12]  19 head [18] 20 lshoulder_wgt [12]  21 lscap [12] 22 lbicep [12] 23 lforearm [22]  24 lhand [23]
25 body       [model]
```

All 411 meshes of the 22 maps have this skeleton, names and parents; three (`con_torturer_mp_2` on MP9, MP10, MP11)
name slot 25 `body_1`. The model node's matrix is the identity on all 411. `mtx_count` 26 = these 26.

**The 25 parts.** `character.rdr`'s `body_items` lists exactly the 25 nodes under `skel_root` (then `rifle`, `pistol`,
`grenade`, `weapon` and the `gear_nodes`): the 25 body-part pointers `CZSealBody`'s constructor stores, `m_root` …
`m_rtoe` (research 50 §4a). `body`, the 26th slot, is a sibling of `skel_root` at the model origin with the identity.
**[data]** slots 0 (`skel_root`), 10 (`aimnodes`) and 25 (`body`) carry no vertex on any of the 411 meshes; the other 23
do: 18 of them on all 411, `spinelo`, `rtoe`, `ltoe`, `lshoulder_wgt` and `rshoulder_wgt` on 408 to 375.

### 3.2 The bind pose

Each node's `nparams` matrix is local to its parent, row-major, row-vector (24 §1.1); the bind world is
`local x parent`. **[data]** every one of the 21,372 bind matrices (local and world) is a rotation to 7e-7 plus a
translation. seal_A_scuba: `skel_root` at (0, 11.67, 0.5334), `head` at y 17.625, the toes ahead of the ankles along
**-z** (`rtoe` z -0.576, `rfoot` z 1.091): the model faces -z, which is facing step 0 of research 75 §11. The skinned
bind pose spans x -8.005 … 7.974 (arms out and down), y **0 … 19.431** (soles to crown), z -1.702 … 2.174.

### 3.3 The palette is the bind pose -- the proof

Carry each influence's own position through its own bone's bind world and compare with the weighted mean of them all:
**[data]** the largest distance over every vertex of every mesh of the 22 maps is **0.0017** (MP6; 0.00154 on MP2).
Three `1.15 x 10` lanes round at 1.5e-4 each; the matrices are f32. Any other palette puts the copies whole units
apart. This is what makes the game's sum `Σ w (p_b x M_b)` equal three's `Σ w (P x B_b^-1 x M_b)` with `P` the one
bind position, and why the viewer skins rather than posing on the CPU (§6.1).

## 4. The 22 maps (`tools/dump-characters.ts`)

| map | meshes | vertices | triangles | batches | max bones/vertex | spread | player (chartype) | gear drawn |
|---|---|---|---|---|---|---|---|---|
| MP1 | 16 | 19,571 | 15,450 | 963 | 6 | 0.00160 | mp1_seal1 = seal_A_arc | 4/4 |
| MP2 | 17 | 22,087 | 17,336 | 948 | 6 | 0.00154 | mp2_seal1 = seal_A_scuba | 6/6 |
| MP5 | 22 | 32,625 | 23,925 | 1,411 | 5 | 0.00168 | mp5_seal1 = seal_A | 7/7 |
| MP6 | 30 | 44,973 | 32,191 | 1,784 | 5 | 0.00170 | mp6_seal1 = seal_A_des | 7/7 |
| MP7 | 21 | 30,558 | 22,777 | 1,251 | 5 | 0.00163 | mp7_seal1 = seal_A_des | 7/7 |
| MP8 | 21 | 30,558 | 22,777 | 1,251 | 5 | 0.00163 | mp8_seal1 = seal_A_des | 7/7 |
| MP9 | 20 | 33,453 | 23,989 | 1,337 | 5 | 0.00168 | mp9_seal1 = seal_A | 7/7 |
| MP10 | 24 | 39,302 | 28,216 | 1,535 | 5 | 0.00168 | mp10_seal1 = seal_A | 7/7 |
| MP11 | 24 | 39,302 | 28,216 | 1,535 | 5 | 0.00168 | mp11_seal1 = seal_A | 7/7 |
| MP12 | 22 | 32,625 | 23,925 | 1,411 | 5 | 0.00168 | mp12_seal1 = seal_A | 7/7 |
| MP51 | 15 | 25,860 | 17,717 | 727 | 5 | 0.00165 | mp51_seal1 = seal_B_woodland | 6/6 |
| MP52 | 18 | 33,332 | 23,311 | 969 | 5 | 0.00165 | mp52_seal1 = seal_B_woodland | 6/6 |
| MP53 | 18 | 33,332 | 23,311 | 969 | 5 | 0.00165 | mp53_seal1 = seal_B_woodland_LO | 6/6 |
| MP61 | 14 | 26,447 | 18,975 | 768 | 5 | 0.00155 | mp61_seal1 = seal_A_tiger_jungle | 6/6 |
| MP62 | 14 | 26,447 | 18,975 | 768 | 5 | 0.00155 | mp62_seal1 = seal_A_tiger_jungle | 6/6 |
| MP64 | 14 | 26,447 | 18,975 | 768 | 5 | 0.00155 | mp64_seal1 = seal_A_tiger_jungle | 6/6 |
| MP71 | 20 | 34,640 | 25,389 | 1,222 | 5 | 0.00163 | mp71_seal1 = seal_A_des | 6/6 |
| MP72 | 17 | 27,168 | 19,795 | 980 | 5 | 0.00160 | mp72_seal1 = seal_A_des | 6/6 |
| MP73 | 17 | 27,168 | 19,795 | 980 | 5 | 0.00160 | mp73_seal1 = seal_A_des | 6/6 |
| MP81 | 15 | 25,900 | 18,298 | 736 | 6 | 0.00160 | mp81_seal1 = seal_A_scuba | 6/6 |
| MP82 | 17 | 32,327 | 23,019 | 938 | 6 | 0.00160 | mp82_seal1 = seal_A_arc | 5/5 |
| MP83 | 15 | 27,009 | 19,363 | 810 | 6 | 0.00160 | mp83_seal1 = seal_A_arc | 5/5 |
| **22** | **411** | **671,131** | **485,725** | **24,061** | 6 | 0.00170 | every player's mesh on its map | every piece in its `FLIB` |

Zero diagnostics on every map. `seal_A_scuba` on Frostfire: **2,094 vertices, 1,523 triangles, 56 batches, 7 textures,
up to 5 bones a vertex** (`mesh/test/skin.test.ts`).

## 5. The gear

### 5.1 The scaled form

**[data]** Every `FLIB_MDL.ZED` packet on the 22 maps (737) and every `WEAP_MDL.ZED` one (14,184) has `TOP+3 = (0, 0,
0, s)`, `s` 1.0 to 4.1 on the gear and to 10.3 on the weapons, and positions that fill the i16 range (max |lane| 32,767).
Read as command `0x70` -- `ITOF15` times `TOP+3.w`, research 15 §2 -- each Frostfire fitting lands inside its `FLIB_GEO`
bbox; read as the map's `0x68` it is 500 to 2,048 times too big (`mesh/test/scaled.test.ts`). The world and prop packets
have `TOP+3.w = 1` on all 29,967, so `w` alone cannot tell the forms apart (the eyes have `s = 1`): the form is the
library's, as the EE's command list is the object type's (`interpretScaledChain`). Every one of the 916 fitting vertices'
colours on Frostfire is (128, 128, 128, 128), unity, and 25,043 of the 30,953 weapon vertices' (81 %) (§6.2).

### 5.2 `character.rdr`

`READERC.ZAR` (not in a map archive; the extractor now copies it beside them) holds `character.rdr`: `AngleUnits`
(`DEG`), `body_items` (§3.1), `gear` (49 pieces: `name`, `model`, `ofs` = part, translation, three angles) and
`characters` (`name [":" base] record`, a character taking from its base whatever it does not state). The map's own
`READERM.ZAR/chartype.rdr` lists its sides' characters; the player's is the first of `navyseals`. Frostfire's
`mp2_seal1 : mp_seal1` is:

```
model_name ("seal_A_scuba.xsi") lods (("seal_A_scuba_1.xsi" "150") ("seal_A_scuba_2.xsi" "200")) texture_asset ("scbaseal")
default_gear ("seal_A_right_eye" "seal_A_left_eye" "seal_holster" "seal_scuba_aslt_gear" "seal_scuba_knife" "Satchel")
```

| gear | model | part | translation | angles (deg) |
|---|---|---|---|---|
| `seal_A_right_eye` | `right_eye` | head | (0.5406, 1.014, -0.359) | (45.1331, 90, -45.1331) |
| `seal_A_left_eye` | `left_eye` | head | (0.5302, 1.0131, 0.3343) | (45.1331, 90, -45.1331) |
| `seal_holster` | `gear_holster` | rthigh | 0 | (-82.47, 84.57, 14.08) |
| `seal_scuba_aslt_gear` | `seal_scuba_aslt_gear` | hips | 0 | (0, 0.1, 0) |
| `seal_scuba_knife` | `seal_scuba_knife` | rcalf | (1.61, 0.388, -0.93) | (-82.4, 84.57, -6.51) |
| `Satchel` | `Satchel` | spinehi | (-1.287, -1.333, 0) | (45.2, 90, -45.2) |

`seal_goggles` is in Frostfire's `FLIB` but in `mp2_seal3`'s gear (`seal_D_scuba`), not the player's. The `lods` are
`seal_A_scuba_1`/`_2`, the `_1`/`_2` meshes of §1; **[inference]** the 150 and 200 beside them are their switch ranges.

### 5.3 The offset's convention

The angles are **x, then y, then z about the fixed axes**: `R = Rz(c) Ry(b) Rx(a)` on a column vector, stored as the
engine stores a matrix (row i = the image of axis i), translation in the fourth row; a gear point lands at
`p x offset x part_world`. **[data]** that order is the one of the twelve (six orders, two readings) under which every
piece the player wears undoes its part's bind turn -- `offset x bind` has an identity 3x3 to 0.005 (left eye), 0.009
(holster), 0.012 (knife), 0.021 (belt, which keeps the hips' 1.19° tilt where `seal_woodland_gear`'s `(-1.185, 0, 0)`
undoes it exactly), 0.041 (satchel); the next best order misses by 0.7 to 1. So **the gear is modelled in the
character's own axes about the part's bind position**, which is also what the data showed before the file was on hand:
translated to its part's bind position alone the belt ringed the waist, the holster rode the right thigh and the goggles
sat on the eyes, while carried through the part's full bind matrix they stood on end (`tools/zz-*` probes, 2026-09-28).

On the bind body **[data]**, `scene/test/character.test.ts`: every piece touches it (nearest vertex 0.08-0.29); belt,
holster and knife lie within a vertex spacing of the skin (median 0.52, 0.65, 0.43); the satchel is a pack 2.5 thick
on the back; the eyes sit in the face at x ±0.33, 1.01 forward of the head joint.

A gear model's own nodes place its chunks (`N%03d_…` by `hookupVisuals`' order): the eyelid (`right_lid`, textured
`brown_eye_shut.tif`) hangs 0.0289 in front of its eyeball and covers its upper half. `gear_nodes` names the lids,
eyeballs, `rifle_out` and `back` as nodes the body animates. **[inference]** the lid at its bind matrix is the open eye's
upper lid, the blink closing it.

## 6. Drawing it (the viewer, W2.1)

### 6.1 Skinned

`@s2u/mesh`'s `decodeSkinnedMesh` keeps every influence (bone, weight, the bone-frame position and normal);
`skinSubMesh` is the `0x52` arithmetic for any palette. The viewer takes the bind positions and hands three a
`SkinnedMesh` per sub-mesh on one `Skeleton` of 26 `Bone`s, `boneInverses` the inverse bind worlds: in the bind pose
every bone matrix is the placement itself, so what is drawn is the decoded vertex (`viewer/test/body.test.ts`). three
skins with four influences: a vertex with more keeps its four largest, renormalised (`topInfluences`, the dropped
weight in `stats().body.droppedWeight`). **[data]** In the bind pose the cut costs nothing -- every copy lands on one
point, whatever the weights. Posed, it will: 1,257 vertices of the 411 meshes have five or six influences, and the
largest weight dropped is 0.151 (MP51's `seal_B_woodland`, a player body); seal_A_scuba's one five-bone vertex weighs
0 on its fifth, so its cut is exact. W2.2 decides whether a posed body needs the full sum (`skinSubMesh` on the CPU,
or a six-influence shader). The gear hangs off its bones under its
offset, so a motion (W2.2) moves it with them.

### 6.2 Shaded, with two placeholders

The same GS path as the world: MODULATE, clamped, times the frame brighten, each texture's bind-packet state
(`materialSpec`), backface-culled by each visual's own `vparams` bit 3 -- set on every `CMesh`/`CSubMesh` of the 411,
clear on the gear's eyelids, the holster's strap, the sheath's loop and the goggles (`FLIB_GEO`) -- CCW being front (§2.3). The vertex colour is the character's
colour lane, which is **data quadword 338**, an EE upload (15 §4.4) not on disc: **placeholder: unity (128)**, the value
every fitting vertex stores (§5.1). And a unity material only makes sense lit, so the body and its gear take the
map's `GlobalLighting` rig as a `lit` part does (`viewer/src/lighting.ts`): **placeholder: lit**. A console frame of a
SEAL would settle both.

### 6.3 Where it stands, and the eye

At spawn slot A -- side 0, slot #0 of `LoadedMap.slots` -- the model origin (its soles) on the slot's floor, turned by
`atan2(-fx, -fz)` so the model's -z lies along the slot's facing. Which slot a player gets is game logic (W1.R9).

The eye line: the eye gear's offsets, 0.530 (left) and 0.541 (right) up the head's axis from its joint and 1.01
forward, put the eyes **18.16 over the feet** in the bind pose (the mean of the two, 18.161). W1.R2's 15.4 is not this: it is research 17 §1's camera *target* over the actor, 15.378 with the
console's root node at 5.5 of its 11.48 bind height (a stance the motion sets). The two are kept apart; the viewer's walk
keeps 15.4 until W2.6 wires the camera.

## 7. Settled and open

**Settled:** the chain (§2.1), the bone lists and their lanes (§2.2), the draw packet (§2.3), the batches (§2.4), `vtype`
(§2.5), the `CSubMesh` record (§2.6, the decomp), the skeleton and its palette (§3), the gear's placement (§5), on all 22
maps with no failure.

**Open:** (a) data quadword 338, the character's colour, and whether the SEAL takes the light command (§6.2) -- a VU1
dump of a skinned draw, or the EE's `FUN_003b5f20` path for a `CMesh`; (b) the 0x3fc2d0 string, `matrix_id` by
elimination (§2.6) -- one read of the image; (c) the lids at rest (§5.3); (d) motion: the local transforms a clip sets
per part (W2.2a, research 77) -- the skeleton here is built to take them (`@s2u/scene`'s `Skeleton.setLocal`, by name or
slot, the bind pose kept beside); research 17 §4's node carries a translation and a quaternion (`+0x00`, `+0x20`) and a u16
index (`+0x40`).

## 8. Tools and tests

- `web/tools/dump-characters.ts [--models]`: §4's table, every mesh decoded, every skeleton read, the palette checked,
  each map's player and gear.
- `mesh/test/skin.test.ts` (synthetic chains and the three fixtures), `mesh/test/scaled.test.ts` (§5.1),
  `scene/test/skeleton.test.ts` (§3), `scene/test/character.test.ts` (§5), `viewer/test/body.test.ts` (§6).
