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
Open within it: the mip images are three's box filter of the base, not the disc's `_mip1`/`_mip2` records (the same
downsampling on the one texture compared), and `w`'s scale is read as world units (a perspective `w` is the view depth;
no dump of the clip matrix was at hand to confirm the constant).

### D4 — The campaign archive drew untextured — **fixed** (`0e561d0d`)

`zdbEntry` threw on `M51_TXR.ZED`, whose name ends `ZM51_TXR.ZED` as well; the exact file name now wins. Not a
multiplayer bug (no MP archive has such a pair), but it is what lets the one exactly-posed console frame be used at all.

### D5 — The residual on the campaign frame: the stream's water — **open** (campaign)

At two passes the Seeding Chaos frame differs mostly in the stream: the console draws one dark translucent grey surface
over the bed, the viewer a brown opaque one. That is the `0x34` environment-map water pass (research 26 §3.1,
`FUN_003b5b90`), which the viewer does not draw. Frostfire's `a_water.tif` ocean is an ordinary FGE-clear packet and
matches in the near band.

### D6 — Multisampling in the PS2 presentation — **open**

The renderer is created with `antialias: true`; the console had none (`DTHE = 0`, no AA on the GS). Edges in the PS2
picture are softer than the console's. MSAA is fixed at context creation under the WebGL2 fallback, so turning it off
for the PS2 presentation means recreating the renderer on the switch (`renderer.ts`); not done this pass.

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

## 3. What would settle the open items

- An exactly-posed multiplayer PCSX2 frame: a savestate at a spawn with its RDRAM (the camera at `0x415ff0` -> `cam+0x2c`
  / `+0x38`, research 17), as slot 8 is for the campaign. The owner runs PCSX2; the viewer side is
  `tools/console-compare.ts --map MP<n> --ref <frame> --eye .. --target ..`.
- A VU1 data dump holding the clip matrix (`vf1`-`vf4` from entry 0) for the `w` scale in D3.
