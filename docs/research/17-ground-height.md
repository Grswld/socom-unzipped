# 17 — "Ground height": the player is at the right height; the third-person camera is 5.4 low

Sprint 4, Task 4. Research note. The only code change made for this note is none — see §7.

**Headline:** `mover+0x90` is not the player's position, it is the **camera** position, and the
player's body is at the *right* ground height on ours (`y = -145.875` vs the console's `-145.867`).
The whole 14.7-vs-20.1 divergence is one number: the player actor's **skeleton root node Y
translation** (`actor+0x2e8` → `+0x04`), which is `5.50391` on the console and `0.0` on ours.
`FUN_0029a950` (the third-person camera's local offset, `0x29a950`) turns that number into the
camera height with a ramp whose zero case is a hard-coded `10.0`, so ours lands on the engine's own
"there is no root node" fallback. A live trace shows *why* our value is 0 and narrows the search to
one function's two calls: the node's **saved** copy holds the console's `5.50391` exactly, while the
node's end-of-frame value walks away from it to 0 along a clean `saved × (1 − w)` curve as
`FUN_0028e040`'s blend weight ramps. **Two candidates remain and the evidence does not separate
them** — the lerp primitive `FUN_001c0768` dropping its `a·w` term, or a correct blend followed by a
second writer clobbering the node; §4.3 gives the one-run experiment that decides. Every figure
below is measured on both sides.

---

## 0. Corrections to the STATUS 01:30 / 02:10 model

| STATUS said | Actually |
| --- | --- |
| the "mover" at actor `+0xc0`, vtable `0x6694b0` | class **`CSealCtrl`** (RTTI name at `0x65c680`, size `0x250` at `0x65c6b4`) — the player's control/view object, not a mover |
| `mover+0x90` is the position | `CSealCtrl+0x80..+0xa4` is a **camera block**: `+0x80` = f, `+0x84` = f·aspect, `+0x88` = 25.0, `+0x8c` = 1/f, **`+0x90` = eye position**, `+0x9c` = view direction. Written by `FUN_005c9520` (`CSealCtrl` vtable `+0xa8`) / `FUN_005c9400`, which **copy** it from the global camera |
| the actor rests 14.7 above the hit vs 20.1 | that is the **camera**. The player's own world position (`actor+0x28` → matrix row 3) is `y = -145.8750` on ours vs `-145.8672` on the console — **0.008 apart** |
| `mover+0x5c` = 4.0 vs 6.3338 is a capsule radius / step height | it is a `rand()` draw (`base 4.0 + range 3.0 × rand()·2⁻³¹`) and is unrelated to height — but it *is* a real bug, see §6 |
| `actor+0x2bc..` holds a cached ground point | `(939.241, -145.875, 856.391)` = the actor's own position copy, also at `+0x1c` and `+0xb0` |

The `+0x84 = +0x68 × +0xa8` and `+0x8c = 1/+0x80` identities in `FUN_005c9400` match the dumped
object exactly (`0.8391 × 807.5 = 677.573`; `1/807.5 = 0.00123839`), which is what pins
`0x1785ee0` to that code.

### 0.1 Where 14.7 and 20.1 actually came from

The two numbers everyone has been quoting are not wrong measurements — they are **camera eye minus
collision hit**, and their own source says so. `docs/STATUS.md`'s 2026-09-09 01:30 entry (the
collision probe) reads "PCSX2 20.11
(y = −126.264), ours 14.69 (y = −131.68)", and those two y values are `CSealCtrl+0x90` /
`camera+0xd8`, the camera eye:

```
console:  -126.264 - (-146.371)  =  20.107     <- "20.1"
ours:     -131.68  - (-146.371)  =  14.691     <- "14.7"
```

The player stands at `-145.867` (console) / `-145.875` (ours), not at the hit, so the actor's own
clearance above the hit is `0.504` / `0.496` on the two sides — matching to 0.008, not differing by
5.4. Everything the project has recorded as "the actor rests 14.7 above the ground" has in fact been
"the camera eye sits 14.7 above the ground the camera stands over". `docs/HANDOFF.md`'s
"Previous open items (2026-09-09 03:40)" item 2 and that STATUS 2026-09-09 01:30 entry were
therefore known-wrong framings. ~~Correcting them is the close-out task's job, not this note's.~~
Close-out (Sprint 4 Task 9a, 2026-09-13) did: both now carry a Superseded blockquote in place
pointing here, and HANDOFF's item is renamed "Third-person camera height".

---

## 1. The measured numbers (both sides)

> **Superseded in its reading, 2026-09-28** (web sprint 2 W2.3, ruling W2.R9;
> `web/redotcom/docs/specs/2026-09-28-web-sprint-2-the-seal-in-the-world-design.md` §7, "The SEAL is 19.6 units tall, and
> the console's spawn dump holds a crouched player"). The numbers below stand; what changes is what they are of.
> The console's root Y `5.50391`, read here and in §4.2 as the console's rest (resting) value, is the **crouched**
> spawn's root: it is under the game's own stance test `node[0].y < 9.0` (§8) and the player's right knee is on the
> ground at 0.54 on the same dump. The **standing** root is **11.484** (the 24 actors at the bind pose on the dump;
> also where our root began in §4.1). So the camera measured here -- the target 15.378 over the feet -- is the
> crouched player's camera; standing, `FUN_0029a950`'s ramp saturates and the target is 21.484. The sentences
> below are left as written (`docs/HANDOFF.md` §4 rule 11).

Ours: `logs/parity/rest_ours.rdram` (mission_s21, 400 s, at rest). Console:
`logs/parity/spawn_pcsx2.rdram` (PCSX2 spawn image). Player actor `0x1a5e4b0` / `0x1713ce0`,
`CSealCtrl` `0x1785ee0` / `0x170d510`, global camera `[0x415ff0]` → `0xd5f920` / `0xfd5cb0`.

| quantity | ours | console | Δ |
| --- | --- | --- | --- |
| player world position (actor matrix row 3) | `939.2407, -145.8750, 856.3910` | `939.4391, -145.8672, 857.0661` | y: **0.008** |
| camera look-at target (`cam+0x38`) | `939.241, -135.875, 857.665` | `939.439, -130.489, 858.341` | y: **5.386** |
| camera eye (`cam+0x2c`) | `939.241, -131.770, 832.225` | `939.439, -126.384, 832.900` | y: **5.386** |
| camera eye, smoothed (`cam+0xd8` = `CSealCtrl+0x90`) | `939.241, -131.725, 831.951` | `939.439, -126.264, 832.160` | y: **5.461** |
| target height above the player | **10.0000** | **15.3782** | **5.3782** |
| **player skeleton root node Y** (`actor+0x2e8` → `+0x04`) (the crouched player's; standing 11.484 — 2026-09-28) | **0.00000** | **5.50391** | **5.50391** |

All console figures in this table are **measured** from `spawn_pcsx2.rdram`. The only inferred
console figure anywhere in this note is the statement that the console's rest height equals its
spawn height, which comes from STATUS 01:30 ("PCSX2 never drops").

---

## 2. The writer chain of `CSealCtrl+0x90`

```
FUN_00296f10   (camera mode 3rd-person; traced live as "CamC", called every frame)
  ├─ FUN_0029a950(&eyeLocal, camera, &targetLocal, &dist)      <-- THE DIVERGENCE IS HERE
  │     └─ FUN_002869d0(actor+0x170, actor+0x2e8, 0, &p, 0)    <-- reads the skeleton ROOT node
  ├─ FUN_00297410(dt, camera, &eyeLocal, &targetLocal, &target) ("CamD")
  │     └─ FUN_00308640(actorMatrix, ..., 1)                    local -> world
  ├─ FUN_0029bf70(dt, camera, &target, &eye, &eye)              camera collision (4 segment probes,
  │                                                             the 0x416050.. records STATUS saw)
  └─ FUN_0029bc90(camera, &eye, &target, outMatrix)   ("CamPlace")
        └─ writes the view matrix and  camera+0xd8..+0xe0 = eye
FUN_005c9520 (CSealCtrl vtable +0xa8)
  └─ copies  *(cam+0xb4) row 3  ->  CSealCtrl+0x90 , and the third row -> CSealCtrl+0x9c
```

Verified live: in `logs/run_20260912_120411.log` (`PS2X_CALL_TRACE="…0x296f10:CamC,0x297410:CamD,
0x29bc90:CamPlace"`, `scripts/parity/gameplay_probe.txt`) the per-frame order is
`CamPlace ← CamD ← CamC`, `ra=0x297314` and `ra=0x296f68`;
`FUN_00295b00`/`FUN_00295f20`/`FUN_0029ae50` never fire in gameplay (they are the other camera
modes and the *other* anchor helper — `FUN_0029ae50` looks like the right function and is not on
the live path; don't trace it).

---

## 3. `FUN_0029a950` — where the 5.38 is created

```c
iVar6 = camera[0xc8];
if (iVar6 != actor[0x2e8]) iVar6 = actor[0x2e8];        // the actor's skeleton ROOT node
if (camera[0xc0] == 0 || iVar6 == 0)                    // early-out: no followed actor / no node
    fStack_10 = fStack_c = fStack_8 = 0.0;              //   -> rootY is 0 here too (see below)
else
    FUN_002869d0(actor + 0x170, iVar6, 0, &fStack_10, 0);   // fStack_10.. = (x, rootY, z) local

fVar9 = 10.0;                                           // <-- the "no root node" fallback
if (fStack_c != 0.0) {                                  // rootY != 0
    fVar9 = 1.0;
    if (fStack_c < 5.6) {                               // below standing: ramp down
        fVar9 = (fStack_c - 2.169155) * 0.2914734;      // 2.169 -> 0 , 5.601 -> 1
        clamp(fVar9, 0, 1);
    }
    fVar9 = fVar9 * 4.5 + 5.5;                          // -> 5.5 .. 10.0
}
fStack_10 += (DAT_004161c0 < 0) ? DAT_004161c0 * 2.5    // lean/peek offset, x only
                                : DAT_004161c0 * 2.8;
fStack_8 = fStack_8 + 28.0;                             // 28 units behind
pfVar7[1] = fStack_c + fVar9;                           // CAMERA HEIGHT = rootY + fVar9
```

Note there are **two** routes to `fVar9 = 10.0`: the early-out above (no followed actor, or the
actor has no root-node handle), and a root node whose Y is genuinely `0.0`. Ours is the second —
the live trace in §4.1 dumps the node itself and it exists, with `+0x04 == 0.0`.

Substituting the two measured root-node values:

* **console** `rootY = 5.50391` → `(5.50391 − 2.169155) × 0.2914734 = 0.971928` →
  `fVar9 = 0.971928 × 4.5 + 5.5 = 9.873676` → height `= 5.50391 + 9.873676 = ` **`15.37759`**.
  Measured console target height above the player: **15.3782**.
* **ours** `rootY = 0.0` → the `!= 0.0` test fails → `fVar9 = 10.0` → height `= 0 + 10.0 = ` **`10.0`**.
  Measured ours: **10.0000**.

Ours is exact; the console agrees to three decimals (`15.37759` computed vs `15.3782` measured —
the 0.0006 is the constants as Ghidra renders them). That is the whole defect: we take the engine's
*own* "there is no root node" branch. The residual difference between the target Δ (5.378) and the
eye Δ (5.461) comes from the camera-collision pass `FUN_0029bf70` and the boom, not from another
bug.

---

## 4. The real divergence: the SEALs' skeleton root node, and where it is written

Node layout (confirmed by `FUN_0028e370` / `FUN_0028e040`):
`+0x00` vec3 local translation, `+0x0c` derived-matrix ptr, `+0x10` saved translation,
`+0x1c` parent, `+0x20` quat, `+0x30` saved quat, `+0x40` u16 node index, `+0x42` u16 flags.
The actor's node handles live at `actor+0x2e8..+0x354`; `+0x2e8` is the root (index 0).

Scanning every actor (vtable `0x6691a0`; 37 in each image) for `actor+0x2e8 → +0x04`:

| | ours (`rest_ours.rdram`) | console (`spawn_pcsx2.rdram`) |
| --- | --- | --- |
| the 4 SEALs (player + squad, around (939,856)) | **0.00000** ×4, root quat `(0.321,−0.455,−0.458,0.693)` — unit, but non-identity, and the same on all four | **5.50391 / 4.70703 / 5.03125 / 5.03125**, root quat identity |
| the other 33 actors | 11.48438 / 11.37109 (bind), quat identity | 11.48438 / 11.37109 / 11.0855 / 11.3498 / 11.535, quat identity |

`11.48438` is the untouched bind value on both sides — it is not the bug. Every one of these
values is `k/256`, i.e. 8.8 fixed point out of the compressed animation data.

Two more ours dumps for stability: `rest_ours_gq.rdram` (same run, GroundQuery #350) has the four
SEALs at `11.205 / 11.463 / 11.479 / 11.484` — i.e. **still at bind**, never in the 4.7–5.6 band
the console uses; `spawn_ours3.rdram` and `postload_ours.rdram` match the console's pre-spawn state
(`11.48 / 11.62`), so the divergence appears only once the SEALs start animating.

### 4.1 Live trace — the root node decays to zero and stops there

Second run, `logs/run_20260912_121304.log` / `logs/task4_camoff.drive.log`:

```
PS2X_CALL_TRACE="0x29a950:CamOff,0x29bc90:CamPlace"  PS2X_CALL_TRACE_EVERY=120
PS2X_CALL_TRACE_DUMP="CamOff:a0:3,CamOff:a2:3,CamOff:a1+0xbc*+0x2e8*:8,CamOff:a1+0xbc*+0x1c:3"
```

(`a0` = eye local out, `a2` = target local out, third = the player's root node, fourth = the
player's position.) Extract, `rootY` = the root node's `+0x04`:

| t (s) | # | rootY | target local (a2) | eye local (a0) | player y |
| --- | --- | --- | --- | --- | --- |
| 211.5 | 0 | 11.4845 | (1.460, **21.485**, −1.273) | (2.808, 25.452, 23.315) | −145.605 |
| 301.9 | 3 | 11.4651 | (1.282, 21.465, −1.273) | (2.465, 25.450, 23.418) | −145.539 |
| 302.1 | 6 | 10.0623 | (0.510, 20.062, −1.274) | (0.980, 24.120, 23.868) | −145.551 |
| 302.2 | 9 | 6.5996 | (0.005, 16.600, −1.274) | (0.010, 20.705, 24.163) | −145.766 |
| **302.5** | **13** | **5.5039** | (0.000, **15.378**, −1.274) | (0.000, 19.483, 24.166) | −145.852 |
| 302.8 | 17 | 3.7458 | (0.000, 11.314, −1.274) | (0.000, 15.419, 24.166) | −145.852 |
| 303.1 | 23 | 0.1118 | (0.000, 5.612, −1.274) | (0.000, 9.717, 24.166) | −145.852 |
| 303.2 | 24 | 0.0000 | (0.000, **5.500**, −1.274) | (0.000, 9.605, 24.166) | −145.852 |
| 303.4 | 25 | 0.0000 | (0.000, **10.000**, −1.274) | (0.000, **14.105**, 24.166) | −145.852 |
| … 304.6 | 48 | 0.0000 | (0.000, 10.000, −1.274) | (0.000, 14.105, 24.166) | −145.852 |

Read that table twice. The root node's Y **decays monotonically from the bind value 11.4845 to
exactly 0 over about 1.4 s of game time and then stays at 0 forever**. On the way down it passes
through **5.5039 at sample #13 — the console's resting value to five significant figures — and does
not stop there**; the target height at that sample is **15.378**, the console's number exactly. One
frame after it reaches 0 the `rootY != 0.0` test flips and the height jumps from 5.500 to the
hard-coded **10.0** (the little 5.5→10.0 step between #24 and #25 in the table is that branch
firing). The final eye height above the player, **14.105**, is the 14.7 STATUS measured.

### 4.2 The same dump narrows it to one function's two calls

The 8-word node dump covers `+0x00..+0x1c`, so word 1 is the **current** translation Y and word 5
the **saved** translation Y (`+0x14`). Putting the two side by side across the decay:

| # | current `+0x04` | saved `+0x14` | current / 5.50391 |
| --- | --- | --- | --- |
| 0…9 | 11.4845 → 6.5996 | 11.4844 (frozen) | — |
| 10 | 6.00808 | 6.00808 | — |
| 11 | 5.66299 | 5.66299 | — |
| 12 | 5.53185 | 5.53185 | — |
| **13** | **5.50391** | **5.50391** | 1.0000 |
| 14 | 5.39402 | 5.50391 | 0.9800 |
| 15 | 5.06438 | 5.50391 | 0.9201 |
| 16 | 4.51497 | 5.50391 | 0.8203 |
| 17 | 3.74579 | 5.50391 | 0.6806 |
| 18 | 2.75685 | 5.50391 | 0.5009 |
| 19 | 1.76595 | 5.50391 | 0.3209 |
| 20 | 0.99482 | 5.50391 | 0.1808 |
| 21 | 0.60282 | 5.50391 | 0.1095 |
| 22 | 0.30850 | 5.50391 | 0.0561 |
| 23 | 0.11185 | 5.50391 | 0.0203 |
| 24 | 0.00001 | 5.50391 | 0.0000 |
| 25+ | 0 | 0 (re-snapshotted) | — |

Two things fall out of that:

1. **The snapshot captured the right value.** At #10..#13 `FUN_0028e370` runs (saved tracks
   current) and parks `saved = 5.50391` — *the console's resting value* — where it then stays,
   frozen, for the next eleven frames. So the blend's source data is correct; nothing upstream of
   the blend is wrong about 5.50391.
2. **The node's end-of-frame value then walks away from it.** From #13 both endpoints of the blend
   are `5.50391` (current == saved), and **any** convex combination of two equal values is that
   value. Ours reaches 0, along exactly `current = saved × (1 − w)` with `w` tracing a clean
   symmetric smoothstep 0→1 (1 − ratio: 0.020, 0.080, 0.180, 0.319, 0.499, 0.681, 0.819, 0.891,
   0.944, 0.980, 1.000).

That says the corruption is on `nodeArray[0]` somewhere between the snapshot and the next frame's
read. It does **not** by itself say the blend is what corrupts it — see §4.3.

`FUN_0028e040` is the blend. Register-exact, from its disassembly at `0x28e040`:

```
a0 = skeleton (actor+0x170), a1 = handle node, f12 = weight
a1 = lh [a1+0x40]                     ; the handle's node index
s0 = [ [a0+0x64] + index*4 ]          ; THE NODE ACTUALLY WRITTEN (indirection through the array)
if (s0 && ([s0+0x42] & 1)) {
    f20 = lwc1 [s0+0x0c]                              ; save the matrix ptr word
    jal FUN_001c0768   a0=s0, a1=s0+0x10, a2=s0       ; translation, weight still in f12
    swc1 f20 -> [s0+0x0c]                             ; restore it
    jal FUN_00306ae0   a0=s0+0x20, a1=s0+0x30, a2=s0+0x20, f12=f21 ; quaternion
}
```

`FUN_001c0768` is VU0 macro-mode (`vmulabc` / `vmaddbc` against `vf0`) — a two-term weighted sum —
which is the shape of instruction the recompiler has already been caught mishandling once on this
project (STATUS 2026-09-09 00:10, VU0 macro-mode MAC/STATUS flags never written). That is a motive,
not a conviction: §4.3 sets out what is actually proven and what is not. The weight comes from
`actor+0x10d0`, counted down by `actor+0x2e0` per frame in `FUN_00576860` (with a second timer at
`actor+0x178`).

### 4.3 What the evidence proves, and the two candidates it does *not* separate

**Proved.** `rootY` on `nodeArray[0]` of the player actor ends every frame at `saved × (1 − w)`
with `saved` frozen at the console's `5.50391` and `w` ramping 0→1, so the node's end-of-frame
value walks from `saved` to `0`. The snapshot data is right; something between it and the next
frame's read is not. Nothing here is inferred — every number is in the trace.

**Not proved: *which* something.** All samples are taken at `FUN_0029a950`, i.e. once per frame,
well after `FUN_0028e040` has returned. Two mechanisms produce the identical per-frame series:

1. **The lerp primitive drops a term.** If `FUN_001c0768` computes `out = a·w + b·(1−w)` and the
   `a·w` term is lost with `b` = the surviving input, the result is exactly `b·(1−w)`. Which of
   `a1`(=`node+0x10`) / `a2`(=`node`) feeds which term is *not* established — that assignment is
   assumed, not measured, and the VU0 macro-mode shape (`vmulabc` / `vmaddbc` against `vf0`) only
   makes it plausible, not proven.
2. **The blend is correct and a second writer clobbers the node afterwards.** If
   `FUN_0028e040` leaves `node+0x00` at `5.50391` and some later per-frame writer scales or
   overwrites it before anything reads it, the once-per-frame sample looks the same. Nothing in
   this note's data excludes that, and `FUN_001c0768` would then be innocent.

There is a third, cheaper possibility folded into both: the weight `f12` itself could be wrong
(running past 1, or inverted) even with a correct lerp. The trace below reads it directly.

**The experiment that separates them — read the node on return from the blend, and again later in
the same frame.** One `gameplay_probe.txt` run:

```
PS2X_CALL_TRACE="0x28e040:Blend,0x29a950:CamOff"   PS2X_CALL_TRACE_EVERY=20
PS2X_CALL_TRACE_DUMP="Blend:a0+0x64**:16,Blend:a1:2,CamOff:a1+0xbc*+0x2e8*:8"
```

`Blend`'s dump is taken **on return from `FUN_0028e040`**; `CamOff`'s is the same node **later in
the same frame**. Then, per frame:

* value already wrong on return from the blend → **candidate 1** (or a bad weight — check `f12`,
  which the `[call]` line prints for free: if it runs past 1 or inverts, it is the timer in
  `FUN_00576860`, not the lerp);
* value **correct** on return (`5.50391`) and wrong at `CamOff` → **candidate 2**; the next step is
  then to find the second writer, not to audit a VU macro-mode primitive.

Dump layout: `a0+0x64**` is `nodeArray[0]`, the root node, and 16 words covers `+0x00..+0x3c` —
current translation (0..2), saved translation (4..6), current quat (8..11), saved quat (12..15), so
the same run also says whether `FUN_00306ae0` shares the fault. (The handle in `a1` is *not* the
node written — `FUN_0028e040` indexes the array by `a1+0x40`; for the root that index is 0, which is
why `**` works. `Blend:a1:2` tells the twenty handles apart.)

`FUN_005765f0` / `FUN_00576700` / `FUN_00576860` are pure dispatch wrappers over the twenty handles
at `actor+0x2e8..+0x354` — they contain no arithmetic and are the subsystem's address, not the
defect. That narrowing stands under either candidate; what is still open is only whether the
corruption happens *inside* `FUN_0028e040`'s two calls or *after* them.

Corroborating, and possibly the *same* bug rather than a second one (RDRAM image, walking up the
chain from `actor+0x308` to the root): the player's bone quaternions on ours are **not unit** —
magnitudes `0.916, 1.000, 0.000, 0.930, 0.756, 0.000, 1.000` against the console's `1.000` for all
seven, two of them exactly zero — while the bone *translations* match the console to within
4–10 ulps. Both candidates predict that: a weighted sum that loses a term shortens the quaternion
toward zero as `w → 1`, and so does a second writer scaling the node. Either way it is one bug
rather than several. (The root node's own quaternion at `+0x20` is **not** zero — the
RDRAM image gives it as `(0.321, −0.455, −0.458, 0.693)`, a unit quat; the zeros are on two of the
other override nodes. The 8-word live dump does not reach `+0x20` at all, so it says nothing about
quaternions either way.)

---

## 5. What this rules out

* **Not the collision probe** — STATUS 01:30 already showed hit `y = -146.371` identical to PCSX2.
* **Not the player's ground height** — the player's world y matches to 0.008 (§1).
* **Not the seal tuning table** — `0x44c250..0x44c3d8` (`gravity`, `ground_touch_distance`,
  `step_height`, `max_slope`, `cam_back_height`, `min_stand_height`, … 96 words) is **identical**
  between the two images except 16 one-ulp float differences and `+0x11c`. So the config data
  (`FUN_0059ba80`, named lookups through `FUN_0032ea80`) loads correctly. The names and offsets of
  that table are listed in §8 for whoever needs them next.
* **Not `CSealCtrl+0x5c`** — see §6.

One incidental find in that comparison, **worth its own ticket — the soft-double routines are
broken**. `param+0x11c = 1/(exp_lut(throt_exp) − 1)` is `0.0344864` on ours vs `0.581809` on the
console, i.e. `FUN_00309370` (a LUT lerp over the 257-entry table at `0x451090`, scale
`DAT_003df340 = 25.6`) returns ≈ **30.0** for input 1.0 where the console returns ≈ **e**. Dumping
the table itself from both images:

```
i        0        1        2        3        4        5        6        7        8        9
ours  1.00000  1.03984 -3.17809  0.86499  1.16912  1.21569  0.72590 -3.73796  1.23116  8.19356
pcsx2 1.00000  1.03984  1.08126  1.12433  1.16912  1.21569  1.26412  1.31448  1.36684  1.42129
```

— and it only gets worse (entry 28 is `-1189.6` on ours). The builder is `FUN_00309420`, one loop
that fills three tables: the **`sinf`/`cosf`** tables at `0x4514a0`/`0x4518b0` (single precision,
stubbed as `sinf@0x001B3720`/`cosf@0x001B3548`) come out **bit-correct**, while the `exp` table —
the only one that goes through the EE soft-double chain `FUN_001a1150` (litodp) → `FUN_001a0c18`
(dpmul) → `FUN_001a0ea0` (dpdiv) → `FUN_001b3880` (exp) → `FUN_001a12d8` (dptofp) — is garbage from
entry 2 on. Those five are *named* in `recomp/socom2.toml` but have no `ps2_stubs::` implementation,
so they run as recompiled EE integer code; the defect is therefore in our 64-bit integer
recompilation, not in a stub. It feeds the movement throttle curve (`throt_exp`) and anything else
that touches a double.

### 5.1 Settled by Sprint 4 Task 4c — a *latent* ABI defect, not the 22-site hazard it was billed as

> **Correction to this note's own "worth its own ticket" framing, and to the severity it was given
> when it was carried forward.** Task 4c (`db7a992`) found the mechanism and then had to argue its
> own rating down. The defect was a binding ABI mismatch: five soft-double routines were bound so
> that the stub returned a **stale register** rather than computing anything. It was rated "more
> severe than `rand`, 22 sites consuming an uninitialised register". **That rating was overstated.**

- **19 of the 22 call sites had `$a0 == $v0` at entry**, so the mis-bound stub silently behaved as
  the **identity** — which is the correct answer for `fabs` on a non-negative input, and merely a
  sign flip on a negative one. Settled by disassembly of every site, not by sampling: `daddu
  a0,v0,zero` in the delay slot at 17 sites, and `daddu s2,v0,zero` / `daddu a0,v0,zero`
  immediately before it at 2 more. (Reading only the delay slot gives 17/5; reading one instruction
  further gives **19 identity / 3 garbage**. The delay slot is a sufficient test for identity, not
  a necessary one — `0x00308064`'s delay slot is `daddu a0,s2,zero`.)
- **The 3 genuine-garbage sites are unreachable.** They sit inside `__kernel_tan`
  (`0x001B1A78`) and `__kernel_rem_pio2` (`0x001B0C50`), whose only callers are inside `tan` /
  `__ieee754_rem_pio2` — both stubbed, so those bodies never execute.

**The live divergences are exactly three, and they are worth knowing individually:**

| site | what it computes | what the mis-binding did |
|---|---|---|
| `FUN_00308020` @ `0x00308064` | matrix → Euler angles; the gimbal-lock guard `\|sin pitch\| < 1.0` | tested `sinPitch < 1.0` instead. For `sinPitch <= -1` — the straight-down pole — the guard does not fire and the `else` branch calls `asinf` outside `[-1, 1]`. A **control-flow** divergence reached by exactly the values the guard exists to catch |
| `FUN_00294070` | projection-matrix setup, `matrix[0] = (m470 * m290) / (m4b0 + fabs(m480))` (4 `fabs` calls at `0x00294284`/`0x002942D8`/`0x00294528`/`0x002945E8`) | denominator becomes `m4b0 + m480`, so any negative `m480` gives a different projection matrix |
| `FUN_003C7280` @ `0x003C72C4` | the single `tan` call site | returned its own argument instead of the tangent |

**The trap this leaves primed.** Those libm bodies are unreachable *because* `sin`/`cos`/`tan` are
stubbed. The obvious follow-up — unbind the transcendentals so the guest's own libm runs — makes
`__ieee754_rem_pio2`, `__kernel_tan` and `__kernel_rem_pio2` live, and with them the three
genuine-garbage sites and an argument reduction that an identity `floor` collapses to exactly zero
(`z -= floor(z*0.125)*8`). Fixing the binding removed that trap before anyone sprang it; do not
re-introduce it by unbinding the transcendentals without re-checking these sites. Eight further
`$f12`/`$f0` maths stubs (`sqrt`, `ceil`, …) carry the identical latent defect and none is live
today — all eight checked.

**The generalisation is in `docs/KNOWN.md` §4 and is the more useful output than any of the above:**
this is the third instance in one sprint of *our HLE returning a constant or wrong-shaped value
where the guest expects a live one*, and like the other two it was invisible to the parity gate.
Full working: `.superpowers/sdd/2026-09-12-sprint-4-visible-defects-and-first-kill/task-4c-report.md`
(gitignored — this section is the durable copy).

---

## 6. `CSealCtrl+0x5c` = 4.0 vs 6.3338 — a `rand()` range bug, not a height

The constructor `FUN_00598280` contains this idiom three times (at `+0x54/+0x58/+0x5c`,
`+0x1b8/+0x1bc/+0x1c0`, `+0x22c/+0x230/+0x234`):

```c
if (range == 0.0) v = base;
else { int r = FUN_00197740(); v = base + range * (float)r * 4.656613e-10; }   // 2^-31
```

`FUN_00197740` is newlib `rand()` (`FUN_0019eb18` 64×64 multiply by `0x5851f42d4c957f2d`,
returns `(uint)(state >> 32) & 0x7fffffff`) — a **31-bit** value, which is why the game scales by
`2⁻³¹`. `recomp/socom2.toml`'s stub list names it `rand@0x00197740`, and the stub as of this note
(`ps2_stubs::rand` in `third_party/ps2recomp/ps2xRuntime/src/lib/Kernel/Stubs/LibC.cpp`; fixed
since, see below) was

```cpp
void rand(...) { setReturnS32(ctx, std::rand() & 0x7FFF); }   // 15 bits, 65536x too small
```

Measured proof: our dumped `+0x5c` is `0x4080002d = 4.00002146`, i.e. `4.0 + 3.0·r` with
`r = 7.153e-6` ⇒ the guest saw `rand() = 15361` — inside `[0, 32767]`. The console's `6.3338`
needs `r = 0.77793` ⇒ `rand() ≈ 1.67e9`.

This is not "our draw happened to be low". With the 15-bit mask the field's **maximum possible**
value is `4.0 + 3.0 × 32767 × 2⁻³¹ = 4.0000458`: under our stub, `6.3338` is **unreachable by
construction**, so the capsule-radius / step-height reading of STATUS 02:10 is dead on arithmetic
alone. **Every `rand()`-derived float in the game is pinned to within 1/65536 of its minimum**:
`grep -c 4.656613e-10` over the decomp gives **249** sites.

> **Applied 2026-09-12 (Sprint 4 Task 4b, `ede2096`, bounds check `60a19f2`):** the stub now runs
> newlib's own 31-bit LCG over the guest's `_rand_next`. The paragraph below is the note's original
> recommendation.

Fix (not applied here — see §7): either return a 31-bit value from the stub, or better, drop
`rand@0x00197740` from `recomp/socom2.toml`'s stub list so the guest's own LCG runs and the
sequence matches the console's. The latter needs a re-recompile.

This is **not** the ground/camera height: `+0x54/+0x58/+0x5c` sits among camera FOV constants
(`+0x50`/`+0x60` = 0.349066 = 20°, `+0x64` = 1.39626 = 80°, `+0x6c` = cos 40°) and behaves like a
jitter/blink timer. It is reported here because this task is where it was found and because it has
a 249-site blast radius.

**Fixed in Sprint 4 Task 4b** (stub route, no re-recompile): `ps2_stubs::rand` now runs newlib's own
LCG over the guest's `_rand_next` (`_impure_ptr` `0x001cc750` → `+0xa8`), which `srand` — never
stubbed — was already writing. `+0x5c` re-measured at 400 s on the same probe: **5.5314**
(`0x40b10150`, implied `rand()` = 1 096 226 133) against the old build's 4.000021 and its 4.0000458
ceiling; the field's range is now the full 4.0 .. 7.0 that the console's 6.3338 needs. Gate
`s4_rand` PASS 3/3. See `.superpowers/sdd/2026-09-12-sprint-4-visible-defects-and-first-kill/task-4b-report.md`.

### 6.1 The mechanism, and the reproducibility caveat that is easy to get wrong

Carried out of Task 4b's report (gitignored) because both halves will be needed again.

**The mechanism.** The stub no longer draws from the host CRT at all — it runs newlib's own LCG
over **the guest's** `_rand_next`, in guest memory:

```c
_rand_next = _rand_next * 6364136223846793005 + 1;      // 0x5851F42D4C957F2D
return (int)((_rand_next >> 32) & 0x7fffffff);
```

`_rand_next` lives in newlib's `struct _reent` at **`+0xA8`**, reached through **`_impure_ptr` =
`0x001CC750`** (so the word itself is at `0x001CC508` in this build). `applySocom2` registers that
pair; `LibC.cpp` does the arithmetic. This matters because **`srand` was never in the stub list** —
it runs recompiled and has always written `_rand_next` in guest memory, so before the fix the game
was seeding a generator nothing read. Measured: `_rand_next = 0x29` (41) in four of our RDRAM
images, live in all three PCSX2 images. 41 is the host CRT's first unseeded draw, arriving through
the game's own `srand(rand())` at boot — the game seeded correctly from `sceCdReadClock`, then
immediately overwrote that seed with a constant.

**The caveat: a fixed clock pins the *seed*, not the *stream*.** The boot seed comes from
`sceCdReadClock`, whose stub (`Kernel/Stubs/CD.cpp`) returns the host wall clock in BCD, so it
changes every run. The tempting fix for bit-exact console comparison — env-gate a fixed date — gives
a **reproducible seed and still not a reproducible sequence**: what any given call returns also
depends on *how many draws have been consumed by that point*, and that count moves with boot drift,
frame timing and any code path that draws conditionally. Pinning the clock is necessary for
reproducibility and nowhere near sufficient; do not quote it as "rand is now deterministic".

---

## 7. Why no fix was landed

Task 4's fix gate is "one hypothesis, one build, one `gameplay_probe.txt` run showing the rest
height at ~20.1". The localisation lands the defect on the **player actor's skeleton root node
(`nodeArray[0]`), written once per frame by `FUN_0028e040`** — not in the camera, not in collision,
and not in anything this task was scoped to touch. But there is no single hypothesis to build
against yet, because the evidence supports **two**:

1. the lerp primitive `FUN_001c0768` (and its quaternion sibling `FUN_00306ae0`) drops its `a·w`
   term, so the blend itself writes `saved × (1 − w)`; or
2. the blend is correct and a **second writer** overwrites the node later in the frame, before
   anything reads it.

Every sample in §4.1 is taken once per frame at `FUN_0029a950`, long after `FUN_0028e040` returns,
so it cannot tell the two apart — and picking one blind would send the next person to audit a VU0
macro-mode primitive that may be innocent. §4.3 gives the single `gameplay_probe.txt` run that
decides it: dump the node **on return from the blend** and **again later in the same frame**; wrong
already on return ⇒ candidate 1 (or a bad weight — `f12` is printed for free), correct on return and
wrong later ⇒ candidate 2. A clamp bolted into `FUN_0029a950` would paper over either while still
leaving the SEALs' override bones shrinking to zero. Per the brief, the note is the deliverable and
no speculative change was made.

Two bounded fixes *were* found (§6 `rand()` 15-bit stub, §5 soft-double routines). Neither moves the
camera height, and the `rand()` one changes every random draw in the game (enemy behaviour, weapon
spread, timers), so both belong to a task that can run a full gate rather than to this one.

## 8. Handles for the follow-up

* **Reproduce the measurement in one run** (this is what §4.1 is):
  `PS2X_CALL_TRACE="0x29a950:CamOff"`,
  `PS2X_CALL_TRACE_DUMP="CamOff:a0:3,CamOff:a2:3,CamOff:a1+0xbc*+0x2e8*:8,CamOff:a1+0xbc*+0x1c:3"`,
  `PS2X_CALL_TRACE_EVERY=120`, `scripts/parity/gameplay_probe.txt`. Script:
  `logs/run_task4_camoff.sh`. The number to watch is word 1 of the third dump (the root node's Y);
  it must settle near **5.5**, not 0. `a2[1]` is the camera height and must settle near **15.38**.
  Camera height formula: `FUN_0029a950` @ `0x29a950`.
* **Start here — but run §4.3's experiment before auditing anything.** The node whose value is
  wrong is written by `FUN_0028e040` @ `0x28e040` through `FUN_001c0768` @ `0x1c0768` (the two-term
  VU0 macro-mode weighted sum, `out = a·w + b·(1−w)`, args `a0` = out, `a1` = a, `a2` = b, weight in
  `f12`) and `FUN_00306ae0` @ `0x306ae0` (its quaternion sibling); those are the only two callers of
  the primitives. Whether the corruption happens inside them or in a later writer to the same node
  is **not** settled by this note — §4.3's single run settles it, and guessing wrong costs a day
  auditing a VU macro-mode primitive that may be innocent.
* Root node: `actor+0x2e8`, node index 0 of the skeleton instance at `actor+0x170`
  (node array ptr at `+0x64`, count at `+0x60`); `FUN_0028e040` writes
  `nodeArray[handle->[0x40]]`, not the handle itself. Save/restore helpers: `FUN_0028e370`
  (current → saved), `FUN_0028e040` (the blend), `FUN_0028dfc0` (flag bit 0 at node `+0x42`, which
  gates the blend). Weights/timers: `actor+0x10d0`, `actor+0x178`, decremented by `actor+0x2e0`.
  SEAL-level dispatch wrappers over the twenty handles (no arithmetic in them — the subsystem's
  address, not the defect): `FUN_005765f0`, `FUN_00576700`, `FUN_00576860`.
* Other readers of the root Y (they will all be wrong too): `actor+0x20 + node[0].y` is the AI aim
  point (decomp lines 416880, 465173, 465209) and `node[0].y < 9.0` is a stance test (line 444146).
* Seal tuning table at `0x44c250` (loaded by `FUN_0059ba80` through the by-name getter
  `FUN_0032ea80`): `+0x00 gravity` 235, `+0x04 DamageToNewtons` 360, `+0x08 jump_factor` 0.85,
  `+0x0c land_fall_rate` 40, `+0x10 land_hard_fall_rate` 115, `+0x14 ground_touch_distance` 8,
  `+0x18 max_slope` 0.642788, `+0x1c step_height` 6.5, `+0x20 vertical_blast_boost` 3,
  `+0x24/0x28/0x2c FALLING_DAMAGE_LIGHT/HEAVY/DEATH`, `+0x3c stand_turn_factor`,
  `+0x40 turn_maxrate`, `+0x44..0x50` accel limits, `+0x54..0x70` aim limits (radians),
  `+0x74..0x90` look/blink limits, `+0xc4..0xd8` zoom aim limits, `+0xf4..0x104` throttle curves,
  `+0x108 min_water_factor`, `+0x10c water_factor_slope`, `+0x110 fb_accel`, `+0x114 lr_accel`,
  `+0x118 throt_exp`, `+0x120 camera_roll`, `+0x124 zoom_factor`, `+0x128 zoom_rate`,
  `+0x12c..0x158` the `cam_back/side/first/peekl/peekr` side/height/dist triples,
  `+0x15c cam_tether_stiff`, `+0x160 cam_look_dwell`, `+0x164 cam_net_pos_smooth`,
  `+0x168 cam_net_release_rad`, `+0x16c cam_peek_decay_rate`, `+0x170/0x174` min running
  reload/chgweapon speed, `+0x178/0x17c/0x180` low/med/high `climb_height`,
  `+0x184 min_stand_height`, `+0x188 min_jump_height`.
