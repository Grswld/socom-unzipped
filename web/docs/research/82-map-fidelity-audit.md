# 82 — Map fidelity audit: the viewer against the console's own frames (2026-09-28)

Goal: the map viewer's picture 1:1 with what the PS2 drew. This note is the ranked list of every divergence found by
putting the viewer beside console frames at the console's own camera, with the cause (decompilation, reCOM, the disc,
the console's memory) and the fix or the reason there is none yet. Items close as they are fixed; the commit hashes are
on the `claude/web-maps` branch.

## 1. The instrument

`tools/console-compare.ts` draws a map in the PS2 presentation (640x448, the map's own half-angles) from an eye and a
look-at target, hides the chrome and the site bar, and writes the viewer's frame, the console's, the absolute and the
signed luma difference side by side, and the mean colour and error per eighth of the frame (`diff.json`). It can route a
campaign archive in from the disc for the page alone (the served tree holds only the 22 MP archives) and set panel
switches and sliders. Throwaway probes behind the numbers below (the ray picker that names the draw under a pixel, the
per-context colour dump, the raw-alpha survey, the TEX1 survey) were run from the session scratch and are described
where they are used.

### 1.1 The reference frames and their cameras

| frame | what it is | camera | how the pose is known |
|---|---|---|---|
| `scripts/parity/refs/console_spawn_slot8.png` | **PCSX2**, the campaign's first mission (Seeding Chaos, `RUN/M51.ZDB`) at spawn, crouched | eye `939.439, -126.264, 832.160`, target `939.439, -130.489, 858.341` | read off the console's own memory, `logs/parity/spawn_pcsx2.rdram` (research 17 §1) -- exact |
| `logs/parity/s4_pcsx2/A_ready027.png` | **PCSX2**, Vigilance (MP51) round 1, spawn A, standing | eye `540.8, 185.6, 1480.2`, target `539.96, 181.48, 1454.73` | fitted: the measured spawn A (`scene/spawns.ts`), the game's standing camera (README, "The player"), the yaw scanned in 5-degree steps for the least structural error |
| `logs/parity/s11_r0004_round1/B_hold00.png` | the **recompiled game** (the real ELF, GS emulated), Frostfire (MP2) spawn B, crouched | eye `510.2, 162.6, 1258.9`, target `537.25, 158.4, 1253.78` | fitted as above, the crouched camera |
| `logs/parity/s11_r0004_round1/A_hold01.png` | the **recompiled game**, Frostfire spawn A, crouched | eye `796, 119.5, 589.8`, target `796, 115.38, 615.27` | fitted as above |

The task that opened this audit called the slot-8 frame "Frostfire"; it is not a multiplayer map. It is still the best
instrument there is: its camera is exact, and M51 is built from the same formats (after D4 the viewer draws it with every
texture). The HUD, the SEAL and the round banners are in the console frames and not in the viewer's; the bands and the
regional samples below avoid them.

## 2. Ranked divergences

Rank is visible impact on a multiplayer map, largest first. Status: **fixed** (commit), **open** (cause known, not yet
done), **not a divergence** (checked, the viewer matches), **unknown** (seen, cause not established).

### D1 — Every multiplayer frame was 1.73x too bright — **fixed** (`dd01316f`)

The viewer multiplied the whole frame by `1 + FIX/128`, FIX 93, the game's post-process brighten (research 31 §12-13).
That FIX was read off the campaign. The post-process state block at `0x488e48` (`FUN_0033cd50` fills it; `+0x31` is the
enable byte, `0x488e90` the pass count, `0x488e98` the ALPHA register it writes):

| dump | enable | pass count | ALPHA | exposure params |
|---|---|---|---|---|
| `spawn_pcsx2.rdram` (PCSX2, Seeding Chaos) | 1 | **2** | `0x5900000069` (FIX 89) | scale 200, band 0.4 / -0.1, current 0.444 |
| `frostA_probe600.rdram`, `frostB_probe600.rdram` (a live Frostfire round) | **0** | **0** | 0 | scale 200, band 0.01 / -0.5, current 0 |

So a multiplayer round never runs the pass, and the campaign runs it **twice** (`1.695^2 = 2.87`). Measured:

| frame | band ratio console / viewer at FIX 93 | at FIX 0 | MAE rgb 93 -> 0 |
|---|---|---|---|
| Vigilance, PCSX2 | 0.46-0.67 | 0.94-1.15 | 39.0/32.5/31.5 -> 19.1/16.2/15.7 |
| Frostfire, recompiled | 0.46-0.67 | 0.80-1.16 | 23.5 -> 10.7 |
| Frostfire spawn A, recompiled (after D1-D3) | -- | 0.95-1.07 in every band | 10.8/11.3/11.2 (edges and the HUD) |

And the campaign frame at the two passes' equivalent (FIX 239, `2.87 = 1 + 239/128`) matches band for band (0.96-1.05
in the unobstructed bands, MAE 45 -> 22). Regional samples on Vigilance after the fix: ground 1.00/1.00/1.00, house wall
1.03/1.00/0.96, roof 0.98/0.94/0.93, stone wall 1.00/1.00/0.96. The default FIX is now 0 (`lighting.ts`, the slider's
markup); the slider stays for the campaign's look.

### D2 — Instanced props drew one placement's baked light at every placement; Frostfire's tank rails neon — **fixed** (`176e188d`)

Owner-reported: on Frostfire some yellow catwalks near-saturated, others mustard, same `crane1.tif`. A model instanced in
several places carries a chunk per instance context (`N000_I###_V##`) that differs only in its prelit vertex colours;
the viewer numbered the contexts from the world's traversal at 0 and drew a group's first member's chunk everywhere.
`hookupVisuals` numbers them by the model's `m_list`, the instances in load order (`vis_main.cpp:77-111`); the models are
read in file order with `worldmodel` last, so the copies inside the prototypes (never placed, never prelit) take the low
numbers. `tankrailbarshi`'s `I000` is the bare material colour, (128, 109, 35) on every vertex; `I001`-`I017`, the
seventeen world rails, are prelit at 35-50 red -- drawn at 128 they came out at (253, 193, 10) against the bridges'
(89, 68, 4). The engine draws record2 untouched on these nodes (no `m_dynamic_*` bit: `FUN_003b6d10`, `FUN_003b5f20`
emit no light command; `m_prelight` is read by nothing at run time), so the fix is purely which chunk. Over the 22 maps,
19 of MP2's 20 pre-world contexts are the unity material colour and none of its 88 world contexts is (MP7: 19/20, 0/27).
Clutter and the held weapon realise their own model as the root and number after the models read before it, as the
engine does.

### D3 — Mipmapped textures blurred by the GPU's derivative LOD — **fixed** (`52f36219`)

The GS picks a level from the depth: `LOD = (log2(1/|Q|) << L) + K` (`TEX1`, `LCM = 0`), `Q = 1/clip.w` (VU1 `0x08`).
The corpus's K runs -12 to about -6.5 with L 0, so Vigilance's `rockwall.tif` (K -12) is the base level to 4,096 units,
where three's derivative LOD had it two levels down at 150. Far wall's mean |Laplacian|: 5.77 -> 10.69, PCSX2's 15.44.
The `w` units are confirmed (round 2): the VU1 dumps hold the register file, and entry 0's clip matrix at the Seeding
Chaos spawn (`logs/vu1dump3/vu1_prog_1.bin`, `vf1`-`vf4`) has a w column (-0.0001, -0.1602, 0.9871) of length 1.000 --
the camera's look at -9.2 degrees -- so `clip.w` is the view depth in world units.

### D3b — The mip levels are the disc's own records, and a detail texture's fade out — **fixed** (`d8816a33`)

Every mipmapped texture's bind packet writes `MIPTBP1_1` (0x34), whose TBP1-3 are the gsaddrs of records the exporter
wrote beside the base: Vigilance's `rockwall.tif` (gsaddr 6) names `rockwall_mip1.tif` (7) and `rockwall_mip2.tif` (8).
Most are a plain downsample, but every **detail** texture's level 1 is authored with alpha 0 (Crossroads'
`detail_brick1` 104 -> 0, `rooftile_d1` 104 -> 0, `cobblestone_rock_d1` 255 -> 0; Vigilance's `cobble_road_det` 136 -> 0),
so on the console the detail pass fades out as the GS LOD crosses 0..1 -- 90-181 units at Crossroads' K -6.5. The viewer
now uploads the disc's levels (`LoadedMap.textureMips`, `mipChain`); Crossroads' three street views change in 7,361 /
9,881 / 36,061 pixels, the far cobbles and walls losing their detail layer. Two maps carry a mip record that is not half
the level above (Foxhunt's `stone01_mip1`, The Mixer's `mp52_concrete_detail1_mip`): those keep a generated chain, with a
diagnostic.

### D4 — The campaign archive drew untextured — **fixed** (`0e561d0d`)

`zdbEntry` threw on `M51_TXR.ZED`, whose name ends `ZM51_TXR.ZED` as well; the exact file name now wins. Not a
multiplayer bug (no MP archive has such a pair), but it is what lets the one exactly-posed console frame be used at all.

### D5 — The environment-map pass: water, glass and ice reflect their sky — **fixed** (`7e12a6f0`)

At two passes the Seeding Chaos frame differed mostly in the stream: the console draws a dark grey translucent sheet over
the bed, the viewer drew the brown bed alone. That is the `0x34`/`0x36` pass (research 15 §6, research 26 §3.2,
`FUN_003b5b90`): a visual whose `vparams` byte 7 names a `Material_Palette` entry gets a second pass whose ST is the sphere
map of the eye ray's reflection off the vertex normal and whose alpha is `(1 + a) * vertex alpha * rim`. The block's
numbers are the palette entry's: M51's `palEntry_5` is base (33, 33, 33, 65), uv scale 1.5, rim 100 / 0.01, `sky01.tif` --
the live dump's block word for word. On the multiplayer maps the textured entries are bound to the water (Blood Lake,
Foxhunt, Fish Hook, Enowapi, Shadow Falls, Bitter Jungle, Abandoned, Night Stalker, Requiem, Sandstorm, The Ruins, The
Mixer, Chain Reaction), Sujo's glass and car panels, and Guidance's icy terrain. Measured on the campaign frame (the
stream's mean): console (50,44,37), without the pass (48,35,22), with it (60,53,48) -- the hue now the console's, 20 %
bright. Open within it: the untextured entries (kind word 2: truck bodies, chrome, lockers) are not drawn -- what the
engine gives them is not established; Vigilance's `cloud_scroll.tif` entry names a texture no library holds (a
diagnostic, no pass); and no multiplayer console frame of water exists to check the MP maps against.

### D6 — Multisampling in the PS2 presentation — **fixed** (`8394f141`)

The renderer is created with `antialias: true` for the Modern picture, and under WebGL2 the canvas's multisampling is
fixed at context creation; the GS had none. The PS2 presentation now renders the world into a 640x448 target with no
samples and copies it texel for texel onto the canvas, the HUD drawing onto the copy. Checked under WebGPU in the
Browser pane; headless SwiftShader never multisampled, so its pixels are unchanged (0 of 286,720 at the spawn-A compare).
The copy to the 4:3 box is still the page's CSS stretch (bilinear), as a television's analogue scale was not nearest.

### D7 — Vigilance's grass beside spawn A — **unknown**

The console shows a tall dense clump along the wall to the SEAL's right; the viewer's `grass_bush` there (553, 163, 1454)
is shorter in the frame. It is 13 units from the camera, so the fitted pose's error of a few units could account for it;
MP51 has no `CLUTTER.ZAR` instances. Needs an exactly-posed MP frame to settle.

### Checked and not a divergence

- **Texture colour and CLUT alpha.** Regional colour ratios on Vigilance after D1 are within 0.93-1.03 on every lit
  surface. No texture on any of the 22 maps has a raw CLUT or texel alpha above 0x80 (the GS would blend with As > 1
  there, and the viewer clamps), so the clamp in `gs/palette.ts` loses nothing.
- **The skies.** An apparent 2.4x on Vigilance's sky was the site bar in the sample; with the frame alone the sky band
  is 1.1 of the console's.
- **The Frostfire ramp rails and crane** (prelit `crane1.tif`) match the recompiled frame's mustard.
- **Fog colour.** `FOGCOL = 0x484a4a` in the console's Seeding Chaos GS dump (research 31 §8) is the disc's (74, 74, 72),
  what the viewer uses.

- **The texture scroll rate.** The engine steps a band by `du * param` once a frame (`FUN_003c0120`, called from
  `FUN_00313c60` with the frame's time), so `du` is per second -- what `SCROLL_TICKS_PER_SECOND = 1` in `world.ts`
  assumed.

### The 22-map survey

Every map from each measured spawn at eye height looking toward the other, after D1-D3 (and `tools/map-health.ts`): all
22 load with no diagnostics and no untextured draw, and nothing reads as broken -- no missing sky, black texture, hole or
z-fight in the 44 views. The night maps are as dark as the console draws them now that the brighten is gone.

## 3. What would settle the open items

- An exactly-posed multiplayer PCSX2 frame: a savestate at a spawn with its RDRAM (the camera at `0x415ff0` -> `cam+0x2c`
  / `+0x38`, research 17), as slot 8 is for the campaign. The owner runs PCSX2; the viewer side is
  `tools/console-compare.ts --map MP<n> --ref <frame> --eye .. --target ..`.
- A multiplayer water frame from the console (Blood Lake, Fish Hook), for D5's pass on the MP maps.
- The runtime layout of a `Material_Palette` record (`0x45c380+0x5a4`, stride 0x3c) for the untextured kind-2 entries.

## 4. Round 2 (after the merge of the integration branch)

The 22-map sweep after D3b, D5 and D6: all 22 load with no untextured draw; three maps carry one diagnostic each (the two
odd mip records above, Vigilance's missing `cloud_scroll.tif`); no console warning beyond "WebGPU is not available" on 17
maps with a reflection pass. Unit tests 1,073 pass. Of the e2e, 19 pass and 5 fail -- `audio`, `grenade`, `hud`,
`weapon` and `walk`'s "camera at spawn A in the PS2 presentation" -- all at `setMode('walk')` returning false, and the four
tried (`hud`, `walk:186`, `grenade`, `weapon`) fail identically on the integration merge `8e1af4c5` without this round's
commits; walk mode is not this workstream's.

## 5. Round 3

- **The SEAL is lit as the VU lights it** (`4ed5d9e2`). Per vertex, every frame, on the GPU, from the posed (skinned)
  normal (`rigShading.ts`); the colour lane is the material alone. Data quadword 338 -- the character's colour the EE
  uploads -- is (128,128,128,128) in all 26 skinning dumps of `logs/vu1dump3`: research 78's unity placeholder, now
  read. Against the recompiled game at Frostfire spawn A (crouched, the console camera), five body regions: the back
  (19,18,20) -> (26,25,28) against the console's (27,26,29), the lower back (10,10,11) -> (19,18,20) against (19,17,20),
  the head, both arms within 1-2 of the console. The fog and the brighten take the world's path (they did already).
  Whether the SEAL takes the light command at all (`FUN_003b6d10` on the actor's node) is the one reading left; the
  numbers say it does.
- **The characters' shadow is a render-to-texture pass, not a blob.** The world init makes 256x256 targets named
  `ShadowX_%d` (the string at 0x3f6e78, `FUN_003553a0`), reCOM's `CPipe::RenderWorld` renders `m_shadows` render maps
  before the world, and the whole of `logs/vu1dump3`'s fourth family (`70 06 08 40 42`, `52 66 08 40 42`: the skinned
  and scaled models drawn as `0x40`'s untextured black triangles, research 15 §3) is that pass. The viewer draws none;
  the projection of the targets onto the ground (`ShadowVector`, `ShadowWeight` on the world root) is still to read.
  **Open.**
- **The 142 deck's east corner is the engine's own hole** (`501b73d1`, research 90 #2). The deck and a box top under
  its corner are one node's `di`; SOCOM II's AddDI appends (`FUN_00313d60`), so the file's order is the surface order
  and the probe's first hit is the box top at 112 -- where reCOM's SOCOM I transcription prepends and would find the
  deck. The viewer matches the engine; a PCSX2 walk into the corner is the one check left.
- **First-sight hitches** (`ab14e47a`, research 90 #3). Every program and upload is made after the reveal
  (`ViewerRenderer.warm`); the turn and walk spikes are gone on Desert Glory, Crossroads, Blood Lake and Frostfire. Left:
  117-267 ms at entering walk (the HUD and reticle scenes' first draw) and a 0.9-3.3 s frame at the first key on Desert
  Glory (`audio.ts`'s unlock).
- **The water pass's 20 % on the Seeding Chaos stream** -- **open**. Removing the pass leaves the stream's R at the
  console's and G/B low; with it, all three are 10-20 % high, as if the pass were about twice as strong as the console's.
  Its alpha is `(1 + a) * vertex alpha * rim`, 66 x 100/128 = 51 at the most, the dump's own range (research 15 §6.4's
  upper-wins reading; lower-wins would give 65, 1.5 % less), so the excess is more likely the base water pass or the bed
  under it than this one.
- **The untextured palette entries** (kind word 2: truck bodies, chrome, lockers) -- **open**. The env gate is the
  runtime record's `+0x14 == 2` (`FUN_003b6a00`), and a record with no texture falls back to `DAT_004b4d90`
  (`FUN_003b5b90`); the disc's `dat[5]` is 2 on exactly these entries and 0 on the textured ones that the one live
  block shows drawing -- so either both kinds get the pass (the untextured with the default texture) or `+0x14` is not
  `dat[5]`. The palette-to-record copy is the function to read next.
- **Vigilance's grass** -- no multiplayer savestate with a camera exists, so it stays a pose question; the play mode
  at the measured spawn A reproduces the SEAL and the house but not the console's framing within a few units.

