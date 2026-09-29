# 81 — The generated VU1 program `vu1gen_d418194495c25213`: what it runs, where its time goes (2026-09-29)

Sprint 17, the F row after F1-F3. A scoping note: research only, no code changed. Inputs: the game-thread profile
`logs/parity/prof/ee1/` (`hostprof_at_hud.txt` 14:04:52Z, `hostprof_end.txt` 14:08:52Z: the 240 s from the HUD to
the end, walk and standing tail together, 127,338 samples, 530/s) and the stats walk `logs/parity/ab/gsloop2/off/`.
"ms/s" below is a share of the game thread's wall time over that window (1 ms/s = 127.3 samples).

## 0. Headline

1. **It is not one microprogram but the whole 16 KB mission image** (`vu1_known_programs.cpp:14-17`, keyed by the
   FNV-1a of the code memory, `ps2_vu1_core.cpp:2480-2497`). It runs every VU1 slice the native dispatcher does not
   end (`ps2_vu1_core.cpp:2528-2576`): the entry-0 stub, the dispatcher lists native refuses, the `0x33c8`
   skinning follow-ons (never native: the native key is `0x1b50` only, `vu1_native_programs.cpp:18`).
2. **Its self time is 152 ms/s (15.2 %), and 71 % of that is the inlined FMAC op itself** (`Vu1Gen::fmac`,
   `ps2_vu1_ops.h:409-442`): the lane arithmetic, the MAC/STATUS packing (`finishFlags`, 29 ms/s) and the flag-ring
   push (14 ms/s). Beside it `VU1Interpreter::fastCommit` 41 ms/s and `vu1ops::fmacProductSum4Slow<false>` 28 ms/s.
3. **By microcode address, 36 % is the `0x52` skinning code and ~56 % is handlers native already implements**
   (clipper 26 %, transform 11 %, lighting 8 %, cull 4 %, draw 4 %) running generated because their lists carry
   `0x52`/`0x66`. That is a native-coverage lever after all, outside this note's three candidates (§3.4).
4. **The profile must be symbolized against the exe that ran.** `dist/socom2.exe` was rebuilt after it; the stock
   tools now read `fastCommit` as 0.19 % instead of 4.1 % (§2.1). Every figure here is shift-corrected.
5. Smallest and safest first: **C1**, a fast path for the zero-accumulator/zero-operand lanes of the product-sum
   (est. 15-22 ms/s, bit-exact by construction, also speeds native lighting); then **C2**, a collapsed
   `fastCommit` drain (15-20 ms/s); **C3**, flag liveness in the generator, is the largest (30-45 ms/s) and riskiest.

## 1. What it is and how often it runs

The generator (`src/tools/vu1_gen.cpp:1-12`) unrolls `runFast` over every reachable pair of the image with constant
register indices; a computed-goto table enters at any pc (`vu1_d418194495c25213.cpp:529-541`), unsupported pairs
and budget/stall exits bail to the interpreter with `m_state.pc` set (`:16434-16440`). VF and ACC live in locals
(`:535-537`); VI, the ready cycles and the cycle counter live in `VU1Interpreter` memory.

The code behind the hot addresses: `0x3100-0x3498` the `0x52` weighted-skinning accumulator and its `0x33c8`
re-entries (`docs/research/15-vu1-fourth-family.md` lines 30-40, 146-148); `0x3618-0x3d20` the five-plane
Sutherland-Hodgman clipper, `0x3ad0` "clip one edge" (`docs/research/13-vu1-family-b-world-objects.md` lines 93,
483); `0x0df8-0x0f00` transform + perspective divide and `0x1440-0x15a8` lighting
(`docs/research/12-vu1-entry0-ui-path.md` lines 391-392); `0x2e28` the `0x66` face normals (research/15 line 37).
So yes: the vertex transform / lighting / clipping path, for the skinned (character) meshes.

**How often** (`[vu1-stats]`, `ps2_vu1_core.cpp:2816-2892`, the 66 lines inside `frame_time`'s scripted walk,
sampler t=252.2-318.2 s, SYNCV 22.7). `programs/s` counts `run()` calls, slices and not MSCALs (`:2825`).

| per second (walk) | value | per drawn frame (/22.7) |
|---|---|---|
| `run()` calls | 53,724 | ~2,370 |
| native dispatcher entered / ended / handed back | 14,670 / 9,989 / 4,681 | ~646 / 440 / 206 |
| slices reaching the generated code (calls minus native-ended) | ~43,700 | ~1,930 |
| VU1 host time (`host=`) | 273 ms/s | ~12 ms |

32 % of dispatcher entries hand back whole (research/15 found 4 of 166 in its corpus); in the standing tail it is
10.1k/s of 23.3k (`mission.game.log` lines 23832-25182). 93 % of vu1gen's inclusive samples arrive through
`continueProgram`, 7 % through `executeProgram` (stacks: 19,817 vs 1,511). The split by entry pc is not in the log.

## 2. Where its time goes

### 2.1 Method: the exe moved under the profile

The profile ran on `881c5a18` (the plan's Log, 14:18Z); `dist/socom2.exe` was rebuilt at 15:00Z with the F3 and A1
merges (`543e1710`, `567b127c`: six runtime files changed), so functions after them moved. The shift per region is
the offset that puts every sampled rva on an instruction boundary of today's exe (100 % at the shift, 16-32 % at
zero): +0x380 around the GS front end, +0x650 for `ps2_vu1_core.cpp`, +0xec0 for vu1gen and `GSMem`. Uncorrected,
`hostprof_symbolize` reads `GSMem::WriteSpan` as `ReadSpan`, `GS::loadClutIfNeeded` as `GS::vertexKick` and
`fastCommit` at 0.19 %; corrected, the controller's 14:18Z whole-run figures reproduce (fastCommit 1.9 %).
The generated file is compiled with `-g1` line tables (`ps2xRuntime/CMakeLists.txt:245-246`), so
`llvm-symbolizer --inlining` maps each vu1gen sample to its generated line, hence its `L_0x...` pair and helper.

### 2.2 Self time over the window (flat; walk = end minus at-HUD)

| symbol | samples | ms/s |
|---|---|---|
| `vu1gen_d418194495c25213` | 19,349 | 152 |
| `VU1Interpreter::fastCommit` | 5,222 | 41 |
| `vu1ops::fmacProductSum4Slow<false>` (`<true>` is negligible) | 3,595 | 28 |
| `clipOneEdge` / `transformDivideLoop` / `lightingLoop` (native) | 3,230 / 2,203 / 1,482 | 25 / 17 / 12 |
| `VU1Interpreter::execUpper` / `runFast` (interpreter fallback) | 1,685 / 1,113 | 13 / 9 |
| `VU1Interpreter::queueStore` | 556 | 4 |

vu1gen's own 152 ms/s, by the helper its sample is inlined from: `fmac` 71.1 % (108 ms/s), the generated body
13.2 %, `readyVf` 3.7 %, `markVf` 2.4 %, `ftoi` 1.6 %, `markVi` 1.4 %, `readyVi` 1.0 %, the rest under 1 % each.
Inside `fmac`: `fmacSingle4` arithmetic 29 % (MUL is half of all fmac samples), `finishFlags` 27 % (29 ms/s,
`ps2_vu1_ops.h:107-120`), the product-sum fast path 21 % (`:303-340`), `fastPushMacFlags` 11 % (`ps2_vu1.h:351-373`),
`normalize4` 9 % (`ps2_vu1_ops.h:55-66`). By microcode range: skinning `0x3100-0x34ff` 36.1 % (55 ms/s), clipper
26.0 % (40), transform 10.9 % (17), lighting 8.3 % (13), cull `0x1638` 3.7 %, draw `0x1780-0x1960` 3.7 %, `0x66`
3.6 %, the entry prologue's 512-byte VF copy 2.4 %, other pcs 4.8 %.

### 2.3 Samples by callee (folded stacks, walk; lower bounds: the end file keeps 20,000 stack lines, 81 % of samples)

| leaf | immediate caller | samples |
|---|---|---|
| `fastCommit` | vu1gen | 3,727 |
| `transformDivideLoop` | native `runCommand` | 1,550 |
| `clipOneEdge` | native `primitiveLoop` | 1,176 |
| `fmacProductSum4Slow<false>` | native `lightingLoop` | 1,079 |
| `fmacProductSum4Slow<false>` | vu1gen | 1,034 |
| `execUpper` | `runFast` | 569 |
| `queueStore` | vu1gen | 388 |
| `fastCommit` | `runFast` | 251 |

vu1gen inclusive is 21,328 (167 ms/s); its leaves beyond itself include the GS front end its XGKICKs run
synchronously (`loadClutIfNeeded` 1,208, `markRtDirtyFromFrame` 615).

### 2.4 Why "Slow", and the commit protocol

`fmacProductSum4` (`ps2_vu1_ops.h:303-340`) proves a lane flag-free only if (1) `pp != -acc`, (2) the exponent of
r is at least 2, (3) at most 253, (4) no cancellation, (5) `|p| != FLT_MAX` (`:314-320`); a dest lane failing any
calls the `noinline` double-precision classifier (`:230-289`, `:322-326`). Condition (1) also fails when acc and p
are both zero (`+0 == -0`), which is every `MADDA.xyzw` whose matrix has a zero column: `MULAx` leaves `acc.w = 0`,
then `MADDAy`/`MADDAz` add `0 * v` to it and go slow for the w lane. The image has 83 `MADD*` sites with dest
`xyzw` and 38 with dest `w` (the `fmac<ArithMadd, ...>` instances in the generated file). The native lighting loop
inlines the same function (`socom2_dispatch_0x1b50.cpp:121` includes `ps2_vu1_ops.h`). This is a hypothesis: no
counter says which condition fails (§5 step 2 measures it before any code).

Every FMAC with a dest pushes a 48-byte entry onto a 64-slot ring (`ps2_vu1_ops.h:439-440`, `ps2_vu1.h:153-167`,
`:244`). The generator commits lazily: at direct branch targets, before a Q reader or a flag/Q/P lower op, and
every 16 pushes (`vu1_gen.cpp:632-638`, `:1050-1061`, `:278-293`), as `if (m_cycle >= m_nextReadyCycle)
vu.fastCommit()` (`vu1_d418194495c25213.cpp:544`); with a push nearly every pair and a 4-cycle latency the
condition is nearly always true. `fastCommit` (`ps2_vu1_core.cpp:1912-1967`) drains entry by entry: MAC,
`m_lastMacPc`, a STATUS read-modify-write, a 48-byte clear, head and count stored per entry (the samples at
`+0x50..+0xfd` of its body, about 64 %); then it scans the FDIV slot and the two EFU slots twice (`:1939-1966`,
~10 %). The program reads MAC six times (`FMAND`, `vu1_d418194495c25213.cpp:5583, 9349, 10777, 10809, 13562,
13585`) and STATUS and CLIP never; all other flag work is for the end state, the hand-backs and the sticky bits.

## 3. Three candidates (estimates are ms/s of the game thread over the §0 window)

### C1 — the zero lanes of the product-sum take the fast path (first)

Where: `fmacProductSum4` only (`ps2_vu1_ops.h:303-340`). A lane with `acc == ±0` and `a == ±0 or b == ±0` has an
exact zero product and an exact sum: value `acc ± p` in float (chop keeps the IEEE zero sign, as the double sum
does), MAC Z (and S for -0), status Z/S, product sticky Z (S from p's sign), no U/O. Handle it with the other fast
lanes; call the slow classifier only when a dest lane is neither. **Estimate:** 15-22 ms/s of the 28 (both
callers) if at least 80 % of slow calls are this shape. **Risk:** low; one pure function, and the slow classifier
is the oracle for an exhaustive lane-shape test. **Fence:** bit-exact values and flags; `vu1_replay --verify --regs
all`, both `--native` and `--no-native`, over the fixture sets and a skinned set (§4).

### C2 — a collapsed `fastCommit` drain

Where: `ps2_vu1_core.cpp:1912-1967` (optionally inlined into `ps2_vu1.h`). For a run of FMAC entries the result is
closed-form: MAC and `m_lastMacPc` from the last, STATUS `(s & 0xFF0) | cur_last | (OR(cur_i | extra_i) << 6)`;
advance head and count once, and replace the 48-byte clear with `valid = false` (the one fast-mode reader of a
drained slot is `queueFsset`'s scan of all 64, `:559-563`). Entries writing sticky or clip keep the sequential
loop; the FDIV/EFU scans go behind a pending count. **Estimate:** 15-20 ms/s of 41. **Risk:** low-medium; `fastPushOverflow`
(`:536-539`) and the native file's "KEEP IN SYNC with fastCommit" note (`socom2_dispatch_0x1b50.cpp:383-388`) name
formulas this must not change. **Fence:** as C1; the flag state is in every `--regs all` line.

### C3 — flag liveness in the generator

Where: `vu1_gen.cpp` (an analysis pass beside `slackVf`/`normVf`, `:44-53`) and a flag-free `fmac` variant. A
pushed MAC/STATUS entry is dead when every path reaches a later push before an `FMAND`, the E bit, or a bail; since
the program has no STATUS/CLIP reader, a dead entry needs only its sticky contribution (four movemasks OR-ed into a
local, folded in at exits). **Estimate:** 30-45 ms/s (`finishFlags` 29, push 14, part of `fastCommit`).
**Risk:** high: flag timing across hand-backs, stalls and the 4-cycle latency; the generated file regenerates
whole. **Fence:** as C1, plus a golden over every dump in `logs/vu1dump3` and `logs/vu1dump4`.

### 3.4 Outside the brief's frame: why the generated code runs at all

~56 % of vu1gen's self time (~85 ms/s) is in handlers the native dispatcher implements, reached through lists
native refuses whole because they contain `0x52`/`0x66` (`socom2_dispatch_0x1b50.cpp:30-35`), and through the
`0x33c8` entry. Research/15 made that residual a scope decision on a corpus where it was 4 of 166 dumps (lines
67-70); over the walk it is 32 % of dispatcher entries. A native `0x66` plus a native resume at `0x1b60` would move
that work to native; the saving depends on native's speed per vertex, which nothing here measures.

## 4. How a candidate is measured (R334, `docs/DEVELOPING.md` lines 868-902)

- **Rung 1 is not the replay bench:** it replays the GS stream only (`docs/DEVELOPING.md` lines 885-887). The VU1
  analogue is `vu1_replay --batch <out> --repeat N <dumps>`, host ns/cycle (`src/tools/vu1_replay.cpp:17`), headless but on
  the lock's busy list (`scripts/loop_lock.sh:121-122`). The dumps must include `0x52` and `0x33c8` programs: the
  in-tree fixtures (`tests/fixtures/vu1/title`, `dispatch_0x1b50`, `clamp`) have none; `logs/vu1dump3` (300 files)
  holds the 25 follow-ons research/15 names.
- **Rung 2 decides the pick:** the mission walk, knob off then on, one exe; SYNCV from `frame_time`. The why is
  `[gs-loop] ee: work=` (the game-thread instrument) and `[vu1-stats] host=` over **the scripted walk only**: the
  862 ms/s `work=` of `docs/KNOWN.md` line 133 averages all 175 lines, walk plus the 160 s standing tail; the 54
  lines inside `frame_time`'s window read 742. VU1 host time is subtracted from the guest clock
  (`ps2_vu1_core.cpp:2809-2815`, research/34 line 26), so a VU1 saving reaches SYNCV only through the frame budget.
- **The profile** (`docs/DEVELOPING.md` lines 941-962) confirms where a saving came from; symbolize it against the
  exe that ran it (§2.1). The hostprof tools cannot tell; the exe has a `.buildid` section the histogram header
  could carry.
- **The fence, per program:** bit-exact against goldens taken interpreted. The chain's `--no-native` runs compare
  packets, data memory and end pc only (`build.sh:302-303`); only the `--native` runs add `--regs all`
  (`:304-305`, `:415`), so the generated path's register file (MAC/STATUS included) is unfenced today. A candidate
  adds `--no-native --regs all` over the three sets and a skinned set with its golden taken `--no-native`
  (research/15 item 7's correction), then the plan's moved-pixel fence
  (`docs/superpowers/plans/2026-09-27-sprint-17.md` lines 50-53: the gate 3/3 PINS MATCH, `--vram-diff` 15/15).

## 5. C1, RED first, in five lines

1. RED: a `ps2xTest` case sweeping `fmacProductSum4<Sub>` against `fmacProductSum4Slow<Sub>` over dest 1-15 and
   lanes from {±0, ±1.5, a denormal, ±FLT_MAX, an underflowing product}, bit for bit, and asserting a new pure
   `vu1ops::productSumFastLanes(acc, a, b)` covers the `acc = ±0, a or b = ±0` lanes: fails today.
2. Before the branch: count slow calls by failed condition over `logs/vu1dump3` with a scratch `vu1_replay` build
   (not committed); the Log names today's share of the zero-zero shape and the rung-1 ns/cycle.
3. GREEN: the zero lanes join the fast mask in `fmacProductSum4`, behind a Dev knob defaulting to today's path
   (`knobs.h`, `docs/KNOBS.md`), read once into a file-static bool.
4. Fence: the sweep, then `vu1_replay --verify --regs all`, `--native` and `--no-native`, over the three fixture
   sets and the skinned set; any mismatch ends the attempt.
5. Rung 1 on the skinned dumps (stop rule: under 3 % ns/cycle, no exe), then rung 2 off/on: SYNCV decides,
   `work=` and `host=` over the walk say why; TRIED, NOT ADOPTED is an outcome.

## 6. Not answered here

- Which entry pcs the ~1,930 slices a frame start at: the game log has no per-entry count (`PS2X_VU1_BAILHIST`
  counts bails only; `--pchist` is a `vu1_replay` flag).
- The share of slow product-sum calls that are the zero-lane shape (§2.4 argues it; §5 step 2 measures it).
- The profile window mixes the 66 s walk with the 160 s tail; the tail runs more VU1 work (host 465 ms/s), so the
  ms/s here are the window's, not the walk's.
