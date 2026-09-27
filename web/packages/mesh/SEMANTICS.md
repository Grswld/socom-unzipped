# Vertex semantics of a SOCOM II map DMA packet (Task 11, M3)

What every lane of a pre-baked VIF1/VU1 geometry packet means, so a TypeScript decoder can turn a
`WORL_MDL.ZED`/`MP*_MDL.ZED` chain into triangles with positions, UVs, normals and colours
**without running VU1**.

Date 2026-09-20. Read-only research. Nothing in `C:\projects\socom_pc` was modified, built or run.

## 0. How to read this document

Two kinds of claim, kept apart everywhere:

- **[code]** — read out of the project's own translation of the VU1 microprogram or of its VIF1
  interpreter. Every one carries `file:line`.
- **[data]** — measured by decoding Frostfire's `worldmodel` (123 chunks, 416 drawn packets,
  15,071 vertices, 8,765 triangles) with a throwaway Python decoder in the session scratchpad
  (`.../scratchpad/mapdump/pktdump.py`, `sem.py`, `wind.py`, `probe2.py`, `di.py`). Measurements
  are stated with their counts.

Citations are relative to the game tree root `C:\projects\socom_pc`. Short names used below:

| short | file |
|---|---|
| **NAT** | `third_party/ps2recomp/ps2xRuntime/src/lib/vu/native/socom2_dispatch_0x1b50.cpp` (hand-written translation of the dispatcher at VU1 pc `0x1b50`) |
| **VIF** | `third_party/ps2recomp/ps2xRuntime/src/lib/ps2_vif1_interpreter.cpp` |
| **R12** | `docs/research/12-vu1-entry0-ui-path.md` |
| **R13** | `docs/research/13-vu1-family-b-world-objects.md` |
| **R15** | `docs/research/15-vu1-fourth-family.md` |
| **R31** | `docs/research/31-flat-grey-geometry.md` |
| **PD** | `tools_py/research/terrain/patch_dump.py` (an existing tool that decodes the same record) |

## 1. Headline

1. **Position** = `int16 xyz / 16` + `header[3].xyz`. Verified on data: Frostfire's two spawn
   floors come out at **y = 100.0** and **y = 142.0** exactly. NAT:934, NAT:979, PD:11.
2. **Primitive** = an **indexed triangle list**. The 12-entry tail is the index list, two quadwords
   per triangle: three byte vertex offsets (stride 3 quadwords, so `index = byte / 3`) plus a flag
   byte, then the triangle's face normal in 1.15 fixed point. No strips, no fans on disc, no
   restart flag, no ADC bit. NAT:2309-2314, NAT:2347-2348.
3. **UV** = `int16 / 4096`, **normalised** (0..1 spans the texture), fed to the GS as perspective
   `S/w, T/w, 1/w` with `FST = 0`. `TW`/`TH` do not enter the decode. NAT:1211, NAT:1262-1266,
   NAT:1301-1303.
4. The header quadwords are **not a matrix**. They are two GIFtag templates, three counts and a
   position bias. The object matrix lives in `MP*_GEO.ZED` `nparams`, not in the DMA chain.
5. A world chunk's packet is built to be drawn by **either** VU1 family B (clipped, `0x02`) **or**
   family A (unclipped, `0x08`/`0x28`); the EE picks per object per frame. Both produce the same
   triangles. R31:409, R31:416, R31:466.

## 2. The packet on disc (recap, for lane addressing)

Frostfire `worldmodel` chunk `N000_000`, the first drawn packet (trace reproduced from
`mapdump/MP2_WORL_MDL_vif.txt`):

```
tag1 reloc=6                     TEXNAME "cuba1a_sky01.tif"
tag2 reloc=3  STCYCL 0x0101 ; UNPACK V4-32 num=2  addr=2   (FLG)      ; then MSCAL imm=0
tag3 reloc=4  STCYCL 0x0103 ; UNPACK V4-8  num=36 addr=6   (FLG,USN)  ; the vertex colours
tag4 reloc=2  STCYCL 0x0101 ; UNPACK V4-32 num=4  addr=0   (FLG)      ; the header
              STCYCL 0x0203 ; UNPACK V4-16 num=72 addr=4   (FLG)      ; positions + UV + normal
              STCYCL 0x0102 ; UNPACK V4-8  num=12 addr=112 (FLG,USN)  ; index list, entry [0]
              STCYCL 0x0102 ; UNPACK V3-16 num=12 addr=113 (FLG)      ; index list, entry [1]
              MSCNT                                                    ; -> VU1 pc 0x1b50
```

Unpack semantics a decoder must reproduce, all **[code]**:

- `imm` bit 15 (`FLG`) makes the address `TOPS`-relative; every unpack in map geometry has it set,
  so all addresses below are written `TOP+n`. VIF:651-653.
- `imm` bit 14 (`USN`) selects zero-extend; clear means sign-extend. VIF:655, VIF:697-709.
- Skipping write with `CL >= WL`: destination quadword = `addr + floor(i/WL)*CL + (i%WL)`.
  VIF:663-669.
- A `V3` unpack writes only lanes x,y,z; **lane w keeps whatever was in that VU quadword before**.
  VIF:684-686 (the destination is pre-loaded) with VIF:752-758 (only `components` lanes are
  overwritten). Never read the `w` of a `V3-16` record.

Applying that, the writes land as:

| unpack | STCYCL | lands on |
|---|---|---|
| `V4-32 num=4 addr=0` | CL=1 WL=1 | `TOP+0 … TOP+3` — the header |
| `V4-16 num=2V addr=4` | CL=3 WL=2 | quadwords `TOP+4+3k+0` and `TOP+4+3k+1` for vertex `k` |
| `V4-8 num=V addr=6` | CL=3 WL=1 | quadword `TOP+4+3k+2` for vertex `k` |
| `V4-8 num=P addr=4+3V` | CL=2 WL=1 | index entry `[0]` of triangle `t`, at `TOP+(4+3V)+2t` |
| `V3-16 num=P addr=5+3V` | CL=2 WL=1 | index entry `[1]` of triangle `t`, at `TOP+(5+3V)+2t+... ` (i.e. `+2t` from `5+3V`) |

**[data]** Over all 416 drawn packets of Frostfire's `worldmodel` this holds exactly: the `V4-16`
count is always `2 × TOP+2.z`, the colour `V4-8` count always `TOP+2.z`, the tail `V4-8` and
`V3-16` counts always `TOP+2.w`, and the index-list base `TOP+2.x` is always `4 + 3 × TOP+2.z`
(416/416 for each). Largest packet seen: 76 vertices, 66 triangles.

## 3. Header quadwords `TOP+0 … TOP+3`

Unpacked as `V4-32`, so each lane is a raw 32-bit word; whether it is an integer or a float depends
on the lane.

### `TOP+0` — the per-primitive GIFtag template (family B)

| lane | type | meaning | conversion | citation |
|---|---|---|---|---|
| x | u32 | GIFtag low word: `NLOOP` (bits 0-14), `EOP` (bit 15). **Overwritten** by VU1 with the drawn vertex count. | — | NAT:2833-2841, R13:162 |
| y | u32 | GIFtag bits 32-63: `PRE` (bit 46-32=14), `PRIM` (bits 47-57 → 15-25), `FLG` (58 → 26), `NREG` (60 → 28) | bitfield | NAT:2840-2842 |
| z | u32 | `REGS[0..7]`, 4 bits each. Observed `0x412` = `ST(2), RGBAQ(1), XYZF2(4)` | bitfield | R12:536, R13:173 |
| w | u32 | `REGS[8..15]`; unused with `NREG=3`, and VU1 **overwrites it with a software flag** | — | R13 §4.3 (`ISW.w vi13, 112`) |

**[data]** All 416 packets: `EOP=1`, `PRE=1`, `FLG=0` (PACKED), `NREG=3`, `REGS=0x412`. `PRIM` is
`125 = 0b1111101` in 383 packets — **prim type 5 = `TRIANGLE_FAN`**, `IIP|TME|FGE|ABE` — and
`93` in 33 packets (the same with `FGE` off: `a_water.tif` ×18, `cuba1a_sky01.tif` ×9, plus
`a_ceiling`, `monitor_01`, `monitor_02`). `FST` is 0 in every packet (see §6).

### `TOP+1` — the whole-object GIFtag template (family A)

Same fields; `PRIM` is **`123` = prim type 3 = `TRIANGLE`** with the same `IIP|TME|FGE|ABE`, and
`NLOOP` is preset to the vertex count. Family A's `0x28` copies it and patches `NLOOP` to 3 per
triangle. **[code]** NAT:1774-1777, NAT:1984-1996; R12:536.
**[data]** `PRIM = 123` and `NLOOP == TOP+2.z` in 416/416 packets.

### `TOP+2` — the counts

| lane | type | meaning | conversion | citation |
|---|---|---|---|---|
| x | u32 | **index-list quadword offset**, relative to `TOP` | `indexBase = TOP + x` | NAT:2347, NAT:1608, R13:175 |
| y | u32 | unread by every handler in the corpus (= 1 in the VU1 dumps, **= 0 in every map packet**) | — | R13 §8.6 |
| z | u32 | **vertex count** | — | NAT:970, NAT:1344, NAT:2348 context |
| w | u32 | **triangle/primitive count** | — | NAT:2344-2348, R13:177 |

### `TOP+3` — the position bias

| lane | type | meaning | conversion | citation |
|---|---|---|---|---|
| x,y,z | f32 | added to every unpacked position, **after** the `ITOF4` | `pos.xyz += bias.xyz` | NAT:934, NAT:971, NAT:990-994, PD:11 |
| w | f32 | unused by `0x68`. (Command `0x70`, the character-model unpack, multiplies the position by this lane instead — irrelevant to map geometry.) | — | NAT:1073-1077, R15 §0.1 |

**[data]** Frostfire uses nine distinct biases: `(0,0,0)` in 384 packets and `(±2000, 0, ±2000)` /
`(±2000,0,0)` / `(0,0,±2000)` in 4 packets each — the tiled sky/ocean skirt. The bias exists
because `int16/16` saturates at ±2047.9 units.

## 4. The vertex triple `TOP+4+3k … TOP+4+3k+2`

Command `0x68` (`0x0b20`) converts all three quadwords **in place** before anything reads them, so
"conversion" below is exactly what a decoder must do to the raw bytes. **[code]** NAT:930-937,
NAT:960-1004.

### Vertex quadword **a** — `TOP+4+3k+0`, from the `V4-16` unpack (signed)

| lane | raw | meaning | conversion | citation |
|---|---|---|---|---|
| x | i16 | position X | `x / 16 + bias.x` (`ITOF4`) | NAT:934, NAT:979 |
| y | i16 | position Y | `y / 16 + bias.y` | NAT:979, NAT:990 |
| z | i16 | position Z | `z / 16 + bias.z` | NAT:979, NAT:990 |
| w | i16 | **normal X** | `w / 32768` (`ITOF15`) | NAT:934, NAT:995, NAT:1612 |

### Vertex quadword **b** — `TOP+4+3k+1`, from the `V4-16` unpack (signed)

| lane | raw | meaning | conversion | citation |
|---|---|---|---|---|
| x | i16 | texture **U** | `x / 4096` (`ITOF12`) | NAT:935, NAT:996 |
| y | i16 | texture **V** | `y / 4096` | NAT:996, PD:12 |
| z | i16 | **normal Y** | `z / 32768` (`ITOF15`) | NAT:935, NAT:982, NAT:1612 |
| w | i16 | **normal Z** | `w / 32768` | NAT:935, NAT:982, NAT:1612 |

The normal is the biggest correction to the brief's assumption. Nothing in the drawing path reads
`b.z`/`b.w` — command `0x08`'s kernel loads only `.xy` of this quadword (NAT:1250, NAT:1307) — but
the **lighting** handler does, and it names them: *"normal = max(vf5 * record0.w + vf6 * record1.z
+ vf7 * record1.w, 0) on xyz"* (NAT:1612, code at NAT:1661-1666). So the per-vertex normal is
`(a.w, b.z, b.w)` in 1.15 fixed point, transformed by the light/normal matrix `vf5..vf7`.

**[data]** Decisive: over 15,071 Frostfire vertices, `|(a.w, b.z, b.w)| / 32768` has length 1.000
for all but 17 (which are exactly `(0,0,0)`, in two chunks). Nothing else in the record is a unit
vector. Independently, the per-vertex normal agrees in sign with the triangle's own face normal
(dot > 0) for 99.8 % of the 26,295 vertex/triangle pairs.

**2026-09-20: the matrix `vf5..vf7` is not the identity, and its numbers are on the disc.** Read
against a live VU1 capture, its *columns* are three unit light directions, so `normal.k` comes out
as `dot(direction[k], n)` and the lighting is three directional lights plus an ambient, not three
axis lights. They come from `MP*.ZED`'s 112-byte `GlobalLighting` key (`_globalLight` in
`zNode/znode.h:66`, fetched at `node_saveload.cpp:289`): `-normalize(dir[k])` and the colours
verbatim reproduce VU1 quadwords 16 to 23 bit-exactly. Section 9's "game state, not map data" was
wrong about these. See the map viewer's spec, "The lighting values are on the disc".


### Vertex quadword **c** — `TOP+4+3k+2`, from the `V4-8 USN` unpack (unsigned bytes)

| lane | raw | meaning | conversion | citation |
|---|---|---|---|---|
| x | u8 | **R** | `ITOF0` → float 0..255 | NAT:936, NAT:983 |
| y | u8 | **G** | as above | NAT:983 |
| z | u8 | **B** | as above | NAT:983 |
| w | u8 | **A**, PS2 convention: **128 = opaque** | `alpha01 = min(a / 128, 1)` | NAT:2176-2178 |

The colour is a *material* colour, not a final one: the draw path multiplies it by the lit colour
(`staging+1 = record2 * lit`, NAT:1615) and the flush tail then does
`FTOI0((rgba * (1,1,1,alphaScale)) + (0.5,0.5,0.5,0))` — round-to-nearest on RGB, truncate on A,
`alphaScale` being data quadword 327's `.w` (1.0 in the whole VU1 corpus). NAT:2176-2178,
NAT:2216, NAT:2233.

For a viewer that does not emulate lighting, use the raw RGB as a baked vertex colour; the GS reads
`RGBAQ` as 0..255 with 128 = 1.0 alpha, so `rgb/255` and `a/128` are the browser values.

**[corrected 2026-09-20]** Read that as a statement about *alpha*. 128 is unity on RGB too: every texture
binds `TEX0.TFX = MODULATE` (every one of the 241 TEX0 register writes in the three maps' bind packets,
`web/tools/dump-bindpacket.ts`) and MODULATE is `C = (Ct × Cf) >> 7`,
so `rgb/128` is the browser value and `rgb/255` draws 1.992× dark. See §11's bullet.

**[data]** Alpha is 128 for 14,423 of 15,071 Frostfire vertices; the remainder (20, 0, 35, 30, …)
are genuinely translucent surfaces.

## 5. The tail: the index list, `TOP+(4+3V)+2t` and `+1`

Two quadwords per triangle, interleaved by `STCYCL CL=2 WL=1`. This is **not** per-strip data,
lights or per-triangle colour.

### Entry `[0]` — the `V4-8 USN` quadword

| lane | raw | meaning | conversion | citation |
|---|---|---|---|---|
| x | u8 | vertex 0, as a **quadword offset from `TOP+4`** | `i0 = x / 3` | NAT:2313-2314, NAT:2354, PD:15 |
| y | u8 | vertex 1 | `i1 = y / 3` | R13 §4.3 (`ILW.y 0(vi15)`) |
| z | u8 | vertex 2 | `i2 = z / 3` | R13 §4.3 (`ILW.z 0(vi15)`) |
| w | u8 | **flags**. bit 0 = front-facing, *rewritten every frame* by the cull handler `0x06`. bit 1 = a second gate the EE presets. bit 15 and the rest are cleared by the cull (`& 32766`). | mask | NAT:2311-2314, NAT:2383-2392, R13 §4.2 |

Because the lane is an unsigned byte, a packet can hold at most `(255-?)/3 ≈ 85` vertices; the
largest in Frostfire is 76. **[data]** Every one of the 8,765 index triples is a multiple of 3 and
in range, 416/416 packets.

**The flag byte is not a "do not draw" hint a decoder should honour.** It is the runtime cull
result: `0x06` recomputes bit 0 each frame from `dot(eye - v0, faceNormal) >= 0` and the EE's
preset value is `3` (both bits set) in **every** Frostfire triangle — i.e. "draw". NAT:2390-2392.

### Entry `[1]` — the `V3-16` quadword

| lane | raw | meaning | conversion | citation |
|---|---|---|---|---|
| x | i16 | face normal X | `/ 32768` (`ITOF15`) | NAT:2324, NAT:2358, PD:16 |
| y | i16 | face normal Y | `/ 32768` | NAT:2358 |
| z | i16 | face normal Z | `/ 32768` | NAT:2358 |
| w | — | **not written by the unpack**; holds stale VU memory. Do not read. | — | VIF:684-686, VIF:752-758 |

**[data]** All 8,765 face normals are unit length (one exception: a single `(0,0,0)` in
`N048_000`).

## 6. Primitive assembly

**The rule, in full:**

```
for t in 0 .. TOP+2.w - 1:
    e0 = u8 quadword at  indexBase + 2t          # indexBase = TOP + TOP+2.x
    e1 = i16 quadword at indexBase + 2t + 1
    emit ONE triangle with vertices e0.x/3, e0.y/3, e0.z/3
    faceNormal = (e1.x, e1.y, e1.z) / 32768
    # e0.w is the runtime cull/gate byte: ignore it, or treat bit1 == 0 as "hidden"
```

- **It is a triangle list, not a strip or a fan.** The on-disc primitive is always exactly three
  indices (NAT:2313, NAT:1613, R13 §4.2/§4.3). The `TRIANGLE_FAN` in `TOP+0`'s `PRIM` is not a
  strip encoding: family B clips each triangle against five planes and the survivor — a convex
  polygon of 3 to 8 vertices — is emitted as a fan (R13 §0.3, NAT:2404-2413, NAT:2833-2841).
  Without clipping the fan degenerates to the same triangle. **[data]** indices are shared between
  triangles in 376 of 416 packets (only 40 packets are "expanded", `V == 3P`), so the list really
  is indexed.
- **There is no restart flag and no ADC bit anywhere in the on-disc data.** ADC lives in bit 47 of
  a PACKED `XYZF2` word that VU1 builds at kick time (NAT:1907); the map never supplies a GIFtag or
  a vertex in GS format (R36 §3: zero `DIRECT`/`DIRECTHL`, zero GIFtags in map geometry).
- **Winding.** **[data]** For all 8,764 non-degenerate Frostfire triangles,
  `normalize((v1-v0) × (v2-v0)) · faceNormal = 1.000` — the right-handed cross product of the
  vertices in index order **is** the stored face normal, with no exception and no sign flip.
  Combined with the cull test (front-facing when the eye is on the normal's side, NAT:2311,
  NAT:2390), the rule for a browser is: **feed `(x, y, z)` unchanged into a right-handed renderer
  and use counter-clockwise = front** (three.js / WebGL default). Equivalently: render
  double-sided and use the stored face normal for shading, which is what the game effectively does
  (the GS has no backface cull; culling happens on VU1 against the eye).

  **2026-09-20, correction to that last sentence.** Double-sided is *not* equivalent, and the
  parenthesis is why: culling happens, it just happens on VU1. A solid two-sided surface is modelled
  as two coincident single-sided sheets -- Crossroads' `tent_red` awning draws the same five quads
  twice, opposite normals, the top baked at mean vertex colour 0.6 and the underside at 0.2 -- and
  drawing both makes them z-fight into a plaid. Front-face-only is the hardware's behaviour for any
  object whose command list carries the `0x06` cull; a cutout sheet (a leaf card) is drawn once and
  needs both faces. Which list a draw gets is not on the disc. See the map viewer's spec,
  "Crossroads' awning was a plaid".

- **Degenerate triangles exist** (1 in Frostfire) and should be dropped.

## 7. UV convention

- **Normalised, not texel units.** The GS `PRIM` has `FST = 0` in every map packet **[data]**, so
  the GS consumes `ST` + the `Q` register, and `S`, `T` are normalised by the texture size the
  `TEX0` `TW`/`TH` fields declare. **TW/TH do not enter the decode** — a browser samples with the
  decoded `(u, v)` directly against the texture's own dimensions. NAT:17 names the distinction
  explicitly ("a `PRIM` with `FST` set (UV in texel units, where the hook feeds S/T/Q)").
- **Scale is `ITOF12`, i.e. `/4096`.** NAT:935, NAT:996, PD:12. The representable range is
  therefore ±8.0.
- **Perspective correction is applied by VU1, not by the data.** `0x08` computes
  `ST = (u, v, 1) * (1/clipW)` and leaves `ST.w = clipW` (NAT:1211, NAT:1262-1268 sets the third
  lane to the constant 1.0, NAT:1295-1303 does the multiply). `S/Q` and `T/Q` inside the GS give
  back `u` and `v`. A browser rasteriser is already perspective-correct, so it uses `(u, v)`
  as-is.
- **Tiling is the norm.** **[data]** 65.6 % of Frostfire's 15,071 vertices have a `u` or `v`
  outside 0..1. Wrap modes are not in the geometry: they are `typeU`/`typeV` in `mp2_lib.rdr`
  inside `READERM.ZAR` (R36 §6). Default to `REPEAT` and read the `.rdr` for the exceptions.
- **A second textured pass exists** for some objects: family C's `0x30`/`0x32` re-run the draw
  handler with `S`,`T` multiplied by a float from an inline block (4.0 in every sample) and new GS
  state — a detail/lightmap pass. The inline block lives in the *command list*, which the map file
  does not carry (§9), so a first-cut viewer simply does not draw it. R13 §4.8, NAT:249-250.

## 8. Matrix and coordinate frame

**The header contains no matrix.** `TOP+0..TOP+3` are two GIFtag templates, three counts and a
float bias (§3). The 4×4 object matrix and the clip matrix are supplied by the EE to VU1 entry 0,
which concatenates `M_proj × M_obj` into data quadwords 0..3 and leaves `M_view × M_obj` in
`vf13..vf16` (R12:66-68). Neither is in the archive.

**Where the object matrix actually is, for a viewer:** `MP*_GEO.ZED`, in each node's `nparams`
(96 bytes = a 4×4 row-major matrix followed by a 32-byte bbox; R36 §2, `node_io.cpp:275-276`).

> **Superseded 2026-09-21:** the tail is a **24**-byte bbox (`CBBox` is two `CPnt3D`) followed by the u32
> `m_type` and a u32 flag word; `m_type == 2` marks an instance node. See §11.2 / the viewer spec §9.

**[data]**, Frostfire:

- All **118** `nparams` in the `worldmodel` subtree's direct children carry the **same** matrix:
  identity 3×3, translation **(960, 0, 800)**. Deeper descendants (instanced props referencing
  `MP2_MDL` prototypes) have their own.
  **Superseded 2026-09-21:** they do not. The 123 chunks belong to 101 visual-bearing nodes carrying
  **6** distinct matrices; (960, 0, 800) is only the modal one, and "one translation serves all" held
  by luck of arithmetic. The `N%03d_%03d` → node mapping is `hookupVisuals`. See §11.2 / the
  viewer spec §9, and `web/packages/scene/`.
- With that translation applied, the decoded floor under spawn A `(796, 100, 614)` is
  **`floor_oilgrime.tif` at y = 100.0** (chunk `N013_000`) and under spawn B `(536, 143, 1254)` is
  **`floor_oilgrime.tif` at y = 142.0** (chunk `N038_000`). The known spawn heights are 100 and
  143.
- Independent confirmation from a completely different part of the archive: the `di` collision
  polygons of the same nodes, transformed by the same `nparams`, put exactly one surface under
  spawn A at **y = 100.0** and under spawn B at **y = 142.0** — the same numbers. The render
  geometry and the collision geometry share a frame, and that frame is the game's world frame.
- The sky chunk `N000_000` (`cuba1a_sky01.tif`) sits at a constant **y = 1442.7** spanning
  ±1400 in x and z: large and far, as expected.
- Playable extent (excluding sky and the ±2000-biased skirt): x −840..242, z −480..480, y −284..323
  in local coordinates — about 1000 × 1000 units = **100 m × 100 m** at `MetersPerUnit = 0.1`
  (`MP2.ZED/MetersPerUnit` reads 0.1, confirmed by decoding the key).

**Summary rule:**

```
worldPos = (int16.xyz / 16) + header[3].xyz        // chunk-local
worldPos = nodeMatrix * worldPos                   // MP*_GEO.ZED nparams; (960,0,800) for MP2
metres   = worldPos * MetersPerUnit                // 0.1
```

**Axes:** **y is up** (floors 100/142, sky 1442, water −283). The frame behaves **right-handed
with counter-clockwise front faces** in the sense established in §6 — the RH cross product of a
triangle's edges in index order is the outward normal, and the cull keeps the triangle when the eye
is on that side. No axis negation or swap is needed: both spawn probes land on the correct floor
at the correct height with a pure translation.

## 9. What the `MSCAL 0` parameter quadwords select

**What is certain [code]:**

- Every `MSCAL` in every map archive is `MSCAL 0`, VU1 micro address 0, and the map contains no
  `MPG`: the microprogram comes from game code (R36 §3).
- VU1 entry 0 is a setup routine whose input block is **14 quadwords plus a command list**:
  `TOP+0` = header (flags in `.w`, alternate-matrix select in `.x`, two copy counts in `.y`/`.z`),
  `TOP+1..TOP+4` = the object matrix, `TOP+5..TOP+11` = the camera/clip-plane block copied to data
  quadwords 30..36, `TOP+12/13` → data 327/328, then `header.z` quadwords copied to data quadword
  **340 onward — that is the command list the dispatcher at `0x1b50` executes**. R12:66-68,
  R12:132-137, R12:80-90.
- The map's `MSCAL` packet supplies **only two** of those quadwords (`V4-32 num=2 addr=2`). It
  therefore cannot be carrying the command list, which is at `TOP+14…`. The command list is
  supplied by the EE.

**What the EE does [code, R31]:** `FUN_003b5f20` writes the family-B/C command lists, taking the
clipped path when `DAT_004b4eb0 == 0` (R31:416); per-object visibility (`FUN_00290c30` →
`FUN_00294a30`) decides **clipped vs unclipped VU1 path** per object per frame (R31:417-420), and
on hardware every partially visible object takes the clipped family (R31:466). R31:409 states it
directly: *"Every terrain program of the frame (both the clipped `0x02` family and the unclipped
`0x08`/`0x28` one)"*.

**Therefore:**

> A world chunk is handled by **family B** (`68 [06] 02 0a 12 56 1a 2a 4c 42` — unpack, cull,
> per-primitive clip, transform, fade, template fill, light, flush, loop) when the EE judges it
> partially visible, and by **family A** (`68 [06] 08 10 54 18 28 42`) when it is wholly inside the
> frustum. The packet is built to serve both: that is why `TOP+0` carries a `TRIANGLE_FAN`
> template (read only by family B's `0x02`, NAT:2836) *and* `TOP+1` a `TRIANGLE` one (read only by
> family A's `0x28`, NAT:1774) in every single packet. **[data]**: 416/416.

It is **not** family D / the "fourth family" (`70 06 08 40 42`): that one converts positions with
`ITOF15` and multiplies by `TOP+3.w` (NAT:1073-1077, R15 §0.1), which would put Frostfire's floors
at y ≈ 0.003 instead of 100. Command `0x68`'s `ITOF4` is the one the data fits.

**What the two parameter quadwords contain [data]:** across all 123 Frostfire chunks there are only
**two distinct pairs**, `(0x44, 0, 0x42, 0) / (0x60, 0, 0x14, 0)` in 296 packets and
`(0, 0, 0x42, 0) / (0x60, 0, 0x14, 0)` in 13. The words are small and even — the shape of
dispatcher command words (`0x44` = restart dispatcher, `0x42` = END, R12:110-112) — but they land
at `TOP+2`/`TOP+3`, where R12 places object-matrix rows 1 and 2, and nothing in the translated
microcode reads a command from there. **Unsettled; see §11.1.** It does not affect the decode:
every lane a decoder needs comes from the `MSCNT` packet's own header, vertex block and index list.

## 10. Reference decoder (what Task 12 should implement)

```ts
// after the VIF1 unpack has filled a Map<qword, Int32Array(4)> for one MSCNT packet
const idxBase = h2[0], V = h2[2], P = h2[3];        // TOP+2 .x .z .w
const bias = f32(h3);                               // TOP+3 .xyz

for (let k = 0; k < V; k++) {
  const a = i16x4(mem[4 + 3*k]);                    // signed
  const b = i16x4(mem[5 + 3*k]);                    // signed
  const c = u8x4 (mem[6 + 3*k]);                    // unsigned
  position[k] = [a[0]/16 + bias[0], a[1]/16 + bias[1], a[2]/16 + bias[2]];
  normal  [k] = [a[3]/32768,        b[2]/32768,        b[3]/32768];
  uv      [k] = [b[0]/4096,         b[1]/4096];
  colour  [k] = [c[0]/255, c[1]/255, c[2]/255, Math.min(c[3]/128, 1)];
}
for (let t = 0; t < P; t++) {
  const e0 = u8x4 (mem[idxBase + 2*t]);
  const e1 = i16x4(mem[idxBase + 2*t + 1]);
  indices.push(e0[0]/3, e0[1]/3, e0[2]/3);          // one triangle, CCW = front
  faceNormal[t] = [e1[0]/32768, e1[1]/32768, e1[2]/32768];
  // e0[3] bit0 = runtime cull result (ignore), bit1 = EE gate (3 in all Frostfire data)
}
// then: worldPos = nodeMatrix(MP*_GEO.ZED nparams) * position
// texture: the chain's reloc=6 DMA tag names the .tif for every packet that follows it
```

Cross-checks a test should assert on Frostfire, all measured here:

| assertion | value |
|---|---|
| packets decoded from `worldmodel` | 416, zero failures |
| vertices / triangles | 15,071 / 8,765 |
| every index a multiple of 3 and `< 3V` | true |
| `\|(a.w, b.z, b.w)\|/32768 == 1` | 15,054 of 15,071 (17 are exactly zero) |
| `normalize((v1-v0)×(v2-v0)) · faceNormal` | 1.000 for all 8,764 non-degenerate triangles |
| floor height under `(796, ·, 614) − (960,0,800)` | **100.0** (`floor_oilgrime.tif`, `N013_000`) |
| floor height under `(536, ·, 1254) − (960,0,800)` | **142.0** (`floor_oilgrime.tif`, `N038_000`) |
| sky chunk `N000_000` y | 1442.7, x/z span ±1400 |

## 11. Unknowns

### 11.1 What the two `MSCAL 0` parameter quadwords are for
Only two distinct pairs exist across Frostfire's 123 chunks (§9), the words look like dispatcher
command words, and they land where R12 places object-matrix rows. Either the EE's setup packet sets
`header.x != 0` (which moves the matrix source to `TOP+14..TOP+21` and frees `TOP+2`/`TOP+3`,
R12:134), or the `MSCAL` packet writes a different VIF double-buffer than entry 0's input frame.
**Test:** capture a `PS2X_VU1_DUMP` of a map frame, look at `TOP+0..TOP+13` and data quadword 340
onward for a program whose `startPc == 0` while a map is loaded; or hook `FUN_003b5f20` and log the
packet it builds. Either settles it in one run. **Does not block Task 12.**

### 11.2 Which chunk gets which node matrix on other maps
Frostfire's 118 `worldmodel` children all share `(960, 0, 800)`, so one translation serves all 123
chunks. Other maps may not be uniform. **Test:** for each map, group the `worldmodel` subtree's
`nparams`; if more than one distinct matrix appears, the `N%03d_%03d` → node mapping must be
reconstructed from `hookupVisuals`' naming order (`vis_main.cpp:88-105`) before positions are
placed.

**Resolved, 2026-09-20 (Task 15).** The mapping is `hookupVisuals`
(`research/recom/src/gamez/zVisual/vis_main.cpp:58-175`), and the archive agrees to the key:

- `N%03d_%03d` is (node, visual). `node_index` counts the model's **visual-bearing nodes**, depth first,
  the model itself first, and **never descending through an instance node** (`m_type == 2`); the second
  field is the visual's index within that node. Frostfire's `worldmodel` subtree has **101** such nodes
  carrying **123** visuals, and `WORL_MDL.ZED` holds exactly `N000_000 … N100_000` with `_001`/`_002`
  appearing precisely where a node has more than one visual. So §8's "one translation serves all 123
  chunks" was right only by luck of arithmetic: the chunks belong to 101 nodes carrying **6** distinct
  matrices, not one.
- `N%03d_I%03d_V%02d` is the same with an instance index between. A model's `I` count is **not** its
  count of instance nodes: a prototype's subtree is realised once for itself and once more for every
  context its container is realised in, so `contexts(C) = Σ over containers M of (1 + contexts(M)) × times`.
  That recursion reproduces all 46 of Frostfire's key sets exactly — including `tankrailsupport`, which
  has 4 instance nodes in the graph and 28 `I` keys in the buffer, and `railstraithi1`, 1 and 15.
- A model whose chunks are all `_I000_` down to `_I(n-1)_` differ **only in baked vertex lighting**: the
  positions of every `I` of a model are identical, so a viewer may decode one and instance the rest.

Two corrections to this document's neighbours fell out of the same work. `nparams`' 96 bytes are a
64-byte matrix, a **24**-byte bbox (`CBBox` is two `CPnt3D`, `zMath/zmath.h:253-258`) and then the u32
`m_type` and the u32 flag word (`zNode/znode.h:73-105`) — §8 and 36 §2 call the tail "a 32-byte bbox",
which is why nothing had noticed that `m_type == 2` is what marks an instance node. And 36 §6's
`m_refcount` "0x2d in every sample read" does not hold over all 2,756: the sample was narrow.

Evidence the placement is right rather than merely different: the `di` collision polygons carried through
the same matrices put a surface **directly under spawn A at y = 100.00** and **under spawn B at
y = 142.00** (feet 100 and 143), and the render geometry still has `floor_oilgrime.tif` under A in chunk
`N013_000` at y = 100 and under B in `N038_000` at y = 142 — the same two chunks and heights §8 reached
with the modal translation. See `web/packages/scene/`.

### 11.3 Handedness against the console image
The frame is self-consistent (§6, §8) and matches the collision geometry and both spawn points, but
nothing here compares a rendered frame against a console screenshot, so a global mirror that
happens to preserve both probes is not formally excluded. **Test:** render Frostfire with the rule
in §6 and compare the silhouette against `logs/`'s PCSX2 GS dump (research/31 §15 has the frame),
or check that the AI-map briefing overlay in `AIMAPS.MPS` lines up.

### 11.4 `TOP+0.PRIM`'s `FGE` bit — settled 2026-09-26: a per-surface "no fog"
33 of 416 packets clear `FGE` on the family-B template while the family-A template keeps it
(water, sky, a ceiling and two monitors). Run over all 22 maps (`web/tools/dump-fge.ts`), the packets
that clear it are exactly the skies (`*sky*`, `skycap`, `clouds`, `moon`, `star`, `sunglow`), the
self-lit surfaces (`lightrays`, `lightglow*`, `light_bulb`, `bomb_glow`, `monitor_*`,
`tex_computer*`, `metallight`) and water, on every map that has them, plus a few interior surfaces.
That is a deliberate flag, and `interpretPacket` carries it as `MeshData.fog`. The family-A template
never clears it, and does not need to: a dome or a water plane is always partially visible, so it
always takes the family-B path. The scene-graph node flag `m_fog` (bit 6) is set on every drawn node
of every map and adds nothing.

### 11.5 The 17 zero vertex normals and the 1 zero face normal
Two chunks contain them. Probably degenerate exporter output. **Test:** check whether the affected
triangles are zero-area; if not, fall back to the geometric normal.

### 11.6 The second (detail) pass
`0x30`/`0x32` scale `S`,`T` by a float from a list-embedded GIF block and redraw (§7). The block is
in the EE's command list, not the archive, so its per-surface bindings must come from
`mp2_lib.rdr`'s `detail{name, uv, range, bmode}` instead. **Test:** decode `mp2_lib.rdr` and check
that the detail `uv` scale is 4.0 for the surfaces whose VU1 dumps use `0x30`/`0x32`.

### 11.7 `TOP+2.y`
Read by no handler in any corpus (R13 §8.6); 1 in the VU1 dumps, **0 in every map packet**.
Ignored. **Test:** none needed unless a future handler is found reading it.

---

## Implementation notes (Task 12)

Everything above is Task 11's research document, copied verbatim. This section records what the decoder in
`src/interpret.ts` had to decide beyond it, and the two places where the data did not quite match the text.

### Decisions the document did not make

- **128 is unity on every lane, and the array is floats.** *(Corrected 2026-09-20.)* `MeshData.colors` is
  a `Float32Array` of RGBA where **1.0 is the PS2's unity** — the stored byte over 128, RGB and alpha
  alike. RGB is **not** clamped, because the GS clamps the product of texel and vertex rather than the
  vertex; alpha **is**, because nothing is more opaque than opaque.

  **[data]** Every texture in Frostfire, Desert Glory and Crossroads binds `TEX0.TFX = MODULATE`. The
  measurement is over the **TEX0 register writes** in the maps' texture bind packets — 241 of 241, both
  `TEX0_1` and `TEX0_2`, across the 240 textures research/72 counts — with
  `web/tools/dump-bindpacket.ts`. MODULATE is `C = (Ct × Cf) >> 7`, so a lane
  of 128 leaves the texel unchanged and 255 doubles it. Alpha's "128 is opaque" is that same unity point,
  not a second convention: the blend equation simply has nowhere to put a value above opaque.

  This corrects an earlier reading of §4's "`rgb/255` and `a/128` are the browser values", which was taken
  to mean the lanes had different unity points. They do not. A decoder that divides RGB by 255 draws the
  world 1.992× dark. A consumer that wants the raw PS2 byte must read the packet, not the mesh.
- **UV is not flipped.** §7 gives no V flip, so `(u, v)` leave the decoder exactly as `int16 / 4096`. A
  renderer whose texture origin is bottom-left (GL's default) has to flip at upload time; nothing here has
  been compared against a console frame, so the flip is the renderer's call and is not baked in. See §11.3.
- **Degenerate = exactly zero area.** §6 says degenerate triangles exist and should be dropped. The test used
  is the right-handed cross product of the two edges being exactly `(0,0,0)` in float arithmetic, which also
  catches a repeated index. Frostfire's `worldmodel` loses exactly one triangle this way — the one §11.5
  names, in `N048_000`, which is also the only triangle with a zero face normal. `faceNormals` and `indices`
  stay in step because a dropped triangle contributes to neither.
- **The tail's flag byte is read by nothing.** §5 is explicit that `e0.w` is the runtime cull result the VU
  rewrites each frame, not a "do not draw" hint, so the decoder neither reads nor exposes it.
- **`MeshData` is model space.** Ruling (a) of the task: `interpretChain` knows nothing about `MP*_GEO.ZED`.
  The node translation of §8 is applied by whoever places the chunk — in `test/interpret.test.ts` by a helper
  that reads `MP2_GEO.ZED`'s `models/worldmodel/children/<node>/nparams` (96 B = a 64-byte row-major matrix
  plus a 32-byte bbox) and takes the matrix's fourth row, floats 12, 13, 14.
- **One `MeshData` per `MSCNT` packet** (ruling (b)), carrying `VuPacket.textureName`. The `MSCAL 0` packets
  (§9) hold no geometry and produce nothing. `mergeMeshes` keeps a texture name only when every part names
  the same one, and `bounds` of an empty mesh is the empty extent, `min = +Infinity`, `max = -Infinity`.
- **`TOP+1` and `TOP+2.y` are not read, and `TOP+0` only for its `PRIM`.** The two GIFtag templates only
  tell a VU1 which family is drawing (§3, §9) and `TOP+2.y` is read by no handler (§11.7). The decoder
  still requires all four header quadwords to have been unpacked, because a packet missing them is not map
  geometry and should say so rather than decode to nonsense. `TOP+0.PRIM`'s primitive type *is* read, and
  only to tell a mesh packet from the line packet of §12.

### Where the data disagreed with the document

Both are counting slips in the `[data]` lines, not decode errors. The rules themselves all hold.

- **16 zero vertex normals, not 17.** §4, §10 and §11.5 say "17 are exactly zero" and "15,054 of 15,071".
  Decoding all 416 packets with this implementation gives **16 exactly zero and 15,055 of unit length**
  (every one within 1e-3 of 1; there is no third category). `test/interpret.test.ts` asserts 16 and 15,055.
- **§8's "all 118 `nparams` in the `worldmodel` subtree's direct children carry the same matrix" is
  narrower than it reads.** `models/worldmodel/children` has **194** direct children, each with a 96-byte
  `nparams`, and they carry **70 distinct** matrices; 118 of them are the identity-plus-`(960, 0, 800)` one.
  Of the 91 children that carry a `visuals` key, 87 use that translation and 4 do not
  (`(720,100,400)`, `(560,100,560)`, and two at `(1068, 99.97, 655.3)`). Since the `N%03d_000` → node mapping
  is still open (§11.2), a viewer that places every chunk with the modal translation will misplace at most
  those few chunks. Both spawn probes are unaffected, and the numbers §8 and §10 quote still reproduce
  exactly.


---

## 12. The `LINE_STRIP` packet (chain relocation type 1)

Added 2026-09-20 (M6). Everything above describes the **mesh** packet, the one a chain tag of relocation
type 2 carries (36 §3). Desert Glory and Crossroads also carry a second packet shape, on tags of
relocation type **1** — 31 tags in `MP6_MDL.ZED`, 163 in `MP72_MDL.ZED`, none anywhere in Frostfire,
none in any `worldmodel`. It is a GS line strip, not a mesh, and the mesh decoder read its point 0 as a
counts quadword and reported billions of vertices.

**Relocation type 1 is not a different DMA layout.** `CVisual::SetBuffer` (`vis_main.cpp:325-370`) patches
types 1, 2, 4 and 7 identically — `chainPkt.u32[1] = buffer + pktOffset` — and a type-1 tag is written
exactly like a type-2 one: `id = ref`, tag words 2-3 `NOP NOP`, and a payload that is a complete VIF1
sub-packet ending in `MSCNT`. The DMA walk needs no special case; what differs is only what the packet
that arrives means. The relocation byte is the exporter's label for that, and the packet says the same
thing itself, in its GIFtag.

**How to tell them apart.** `TOP+0.PRIM`'s primitive type. **[data]** across all three shipped maps: every
one of the 194 packets a type-1 tag carries has `PRIM = 122` in *both* templates — prim type **2**
(`LINE_STRIP`), `IIP|TME|FGE|ABE`, `FST = 0`, `NREG = 3`, `REGS = 0x412` — and no packet outside those 194
has prim type 2. Mesh packets keep §3's `TRIANGLE_FAN`/`TRIANGLE` pair.

**The layout.**

| quadword | lanes | **[data]**, 194 packets / 1,071 points |
|---|---|---|
| `TOP+0` | GIFtag template, the per-primitive one | `NLOOP = 0` in all 194 |
| `TOP+1` | GIFtag template, the whole-object one | `NLOOP` = the point count in all 194; `EOP = 1` on both |
| `TOP+2+3k` | `V4-32` float `(x, y, z, normal.x)` | positions are final, no `ITOF`, no bias |
| `TOP+3+3k` | `V4-32` float `(u, v, normal.y, normal.z)` | `u` −1.8…12.4, `v` −4.5…4.3: the texture repeats along the strip |
| `TOP+4+3k` | `V4-8 USN` `(r, g, b, a)` | the same two scales §4 gives a mesh vertex |

Unpacked by three codes, `STCYCL 3,1; UNPACK V4-8 USN num=P addr=4` (from the type-4 tag before it),
then inside the type-1 payload `STCYCL 1,1; UNPACK V4-32 num=2 addr=0` and
`STCYCL 3,2; UNPACK V4-32 num=2P addr=2`.

So it is §4's vertex triple lane for lane — position, UV, the split `(a.w, b.z, b.w)` normal, RGBA — with
three differences: the numbers arrive as 32-bit floats, so none of `ITOF4`, `ITOF12` or `ITOF15` applies
and nothing is divided; there is no `TOP+3` bias to add, there being no `TOP+3`; and there is **no index
list and no face normal**, the points being drawn in stored order, segment `k` from point `k` to `k+1`.
The §4 normal invariant survives: over all 1,071 points the normal is unit length (within 1.4e-8) or
exactly zero.

Point counts run 2…9. What they draw: Desert Glory's power lines (`mp6_pole_lines`,
`mp6_pole_line2garage`, `mp6_pole_line2building`), lamp brackets (`mp6_light_neck`, `mp6_light_hangout`)
and the `cuffs_left`/`cuffs_right` chains; Crossroads' tent guy ropes (`tent_beige`, `tent_gray`) and
light filaments (`light_bright`, `light_off`, `light_dim`). Every chunk that failed before this section
was written holds **only** line strips — not one triangle is recovered by reading them, and not one was
ever lost.

**What the decoder does with them.** `interpretLinePacket` returns a `LineStrip`, not a `MeshData`:
positions, UVs, colours, normals and the texture, with the topology left implicit in the point order.
It is deliberately not widened into geometry here. The GS draws these one pixel wide however far away
they are, so turning a strip into triangles means choosing a width and a facing — a renderer's decision,
made with a camera in hand, not a decode. `interpretChain` therefore returns no mesh for a line packet;
`interpretChainLines` and `interpretChainParts` are how a consumer asks for them.
