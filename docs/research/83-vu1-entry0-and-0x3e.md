# 83 — The entry-0 swarm and command `0x3e`: what they are, where the time goes, which lever (2026-10-01)

Sprint 17 F, after N1c and N2. A research note with a go/no-go per lever: no runtime code changed (branch
`agent/s17-entry0-swarm`). Inputs: the refusal walk `logs/parity/ab/vu1refuse/n1con` (2026-09-30 22:39Z,
`python -m tools_py.parity.vu1_refusals --stamp logs/parity/ab/vu1refuse/n1con --by key`, sampler window
297.0-365.3 s, 68 one-second rows) and its `[vu1-stats]` and per-second `[vu1-refuse]` lines over the same window;
the mission dumps `logs/vu1dump5` (4,000 consecutive programs, 2,712 at entry 0, the n1b capture of research/82 §8.4)
and `logs/vu1dump4` (300, 217 at entry 0); the microcode (`python tools_py/vu1dis.py <dump> --start 0x0 --count
150`); and the runtime source at this branch's base, 82b3c864. The new scorer
`python -m tools_py.parity.vu1_entry0_shapes <dir> [--groups] [--each]` (test
`tools_py/tests/test_vu1_entry0_shapes.py`) produced every shape table below.

Markings as in research/82: **[verified]** against a dump, the disassembly or the source; **[measured]** from the
walk's log; **[inferred]** from reading the code; **[estimate]** a number derived from the other three;
**[guess]** a name for what the code seems to do.

## 0. Headline

1. **Entry 0 is not a stub. It is the per-object setup program of research/12, and the game runs it four times for
   every object it draws.** It reads the header at `TOP` and takes one of four paths: **kick** (a GS render-state
   packet, two XGKICKs), **matrix** (composes the object's three matrices), **fade** (four parameter qwords) or
   **list** (uploads the command list to qword 340). The mission sends them in a fixed order, `matrix fade list
   kick`, then the `0x1b50` dispatcher (§1.3). Each one is a VIF chunk of its own: `TOP` flips 424/724 on every
   one of the 3,999 transitions in `vu1dump5`. **[verified]**
2. **The 53 cycles are the program's own pairs, with almost no stall.** The trace gives a mean of 52.8 pairs over
   `vu1dump5`'s 2,712 entry-0 programs and 52.1 over `vu1dump4`'s 217. The walk measured 52.7 cycles per entry
   (90,904,720 / 1,724,575). By path: kick 37 pairs, matrix 82, fade 34, list 46-144 (27 + 3.5 per qword of the
   list, plus 1.5 for an odd count). **[verified]** trace, **[measured]** cycles.
3. **The 0.66 µs is not mostly VU work.** The walk's 68 seconds hold the cycles per entry between 52.3 and 53.3, but
   the cost per entry ranges from 0.546 to 0.839 µs. So at least 0.29 µs of it varies with something other than the
   VU work. The rows charged after a native hand-back cost 4.3-5.6 ns per VU cycle with an intercept near zero
   (§2.2). At that rate the 53 cycles are 0.23-0.30 µs. The rest is in three places: run()'s head (this row alone
   is clocked from run()'s start), the GS work of the kick path's two XGKICKs (they run the GS register writes
   synchronously, inside the clock), and cache warmth. **[measured]** the spread and the rates; **[inferred]** the
   split, which is unmeasured.
4. **Levers.**
   - **Measure first: split the `entry=0x0` key by path.** This is a Dev instrumentation change, and the cheapest
     way to know the kick path's GS share. **GO.**
   - **(b) Trim run()'s fixed head.** Do not take a clock read per run for a warning that cannot fire, cache the
     native-table answers per image, and drop the lock-prefixed counters. This touches no VU semantics and helps
     all 54,000 programs a second. About 1.5-3 ms/s. **GO.** [estimate]
   - **(a) A native entry-0 program.** It needs four paths, the matrix path bit-exact in its flags and in the vf
     registers it hands to `0x1b50`, and about 150-200 lines. It saves about 1.5-5 ms/s of the 17, because run()'s head
     and the GS work stay. **NO-GO for now:** take it again after the split measurement. [estimate]
   - **(c) The GS work of the kick path is the game's own work.** It is a render-state change per object, and
     30 % of entry-0 programs carry one.
5. **`0x3e` is a projected-light pass over the clipped polygon** (§4). It is the family-B twin of `0x3c`, which
   does the same over the unclipped vertex array: 51 pairs per vertex with a DIV, then `JR` into `0x2a`'s flush.
   A native handler could take it. But its stake is 8.2 ms/s of fallback, and research/82's measured native share
   (83-85 % of generated) puts the saving at about 1.2-1.4 ms/s. No `0x3e` list is on disk to prove against: none
   of the 6,754 dumps in `vu1dump`-`vu1dump5`, `vu1refused1`, `vu1dump_online` and `vu1clamp` holds one.
   **NO-GO now.** First comes a capture, which needs `PS2X_VU1_DUMP_REFUSED` to admit `unknown_command`. That is
   a runtime change and not this branch's. **[verified]** the disassembly and the corpus scan; [estimate] the stake.

## 1. What runs at pc 0

### 1.1 The program

The image is the mission's: code MD5 prefix `638cb8f0` in every `vu1dump4`/`vu1dump5` dump and every in-tree
fixture under `tests/fixtures/vu1/`. It is FNV-1a `d418194495c25213`, `vu1_known_programs.cpp`. Research/12
§(a)-(b) documented the handler on the title screen. The mission runs the same code over other headers. The
prologue `0x00-0x38` does three things: `XTOP vi1`; `vi5 = TOP.w` (the flags); `vi3 = TOP.x`. Then it tests
bit 1. **[verified]**

| path | header | pairs | what it reads | what it writes | XGKICK |
|---|---|---|---|---|---|
| **kick** (`0x40-0x110`) | `w` bit 1 | 37 | `TOP+1..TOP+8` | qwords 330-337; `vf17`,`vf18`,`vf20`,`vf21` (left = `TOP+5..8`); `vi2`=330, `vi6`=423, `vi8`, `vi9` | `423`, then `330` |
| **matrix** (`0x118-0x378`, `0x490`) | `w` bit 0 | 82 | `TOP+1..TOP+13`; resident qwords 4-11, 16-23 | qwords 0-3 (local→clip), 30-36 (eye, near point, five plane normals), 327-328 (`TOP+12/13`); `vf1`-`vf28`; ACC, MAC, STATUS (44 FMACs); `vi7`, `vi8`, `vi9`, `vi11` | none |
| **fade** (`0x3c8-0x430`) | `w` bit 3 | 34 | `TOP+1..TOP+4` | qwords 27, 38, 28, 29 (research/13's dead clip mask, lighting scales, the rounding bias, fade point and scale); `vf20`-`vf23`; `vi4`, `vi7`, `vi8`, `vi9` | none |
| **list** (`0x438-0x488`) | `w` = 0, `z` > 0 | 48 for z = 6, 53 for z = 7 | `TOP+1..TOP+z` (and one qword past it, an odd `z`) | qwords 340 … 340+z-1, the command list and its inline blocks; `vf17`, `vf18`; `vi4`, `vi5`, `vi7`, `vi8` | none |

The four paths share one end: `B 0x1b40`, the E bit, then `pc = 0x1b50`. The kick path's first kick sends qword
423: a GIFtag with `NLOOP = 0, EOP = 1` and no data, research/13's terminator. The second kick sends the eight
qwords it just copied: a GIFtag `NLOOP = 5` (`6` in 51 of 816), `EOP = 1`, `REGS = A+D`, then `ALPHA_1`, `TEX1_1`,
`TEX0_1`, `TEST_1`, `CLAMP_1`, and `MIPTBP1_1` in the six-register form. That is the object's texture and blend
state, the packet research/13 §2 found the dispatcher's `0x64` kicks from the same qword 330. **[verified]** in all
816 kick programs.

The matrix path's outputs are the dispatcher's live-ins. Research/13 §6.1 lists `vf1`-`vf4` (read by `0x0a`) and
`vf5`-`vf7`, `vf9`-`vf12` (read by `0x1a`). So a native version must leave the same register file, and with it the
last FMAC's MAC and the sticky STATUS (research/82 §10.4). **[verified]** research/13.

### 1.2 The shapes in the mission

`python -m tools_py.parity.vu1_entry0_shapes logs/vu1dump5`:

| path | programs | share | pairs | share of pairs | header z |
|---|---|---|---|---|---|
| kick | 816 | 30.1 % | 37 | 21.1 % | 0 |
| list | 690 | 25.4 % | 46-144 (mean 62.8) | 30.2 % | 5, 6, 7, 8, 9, 10, 18, 20, 21, 23, 24, 33 |
| matrix | 581 | 21.4 % | 82 | 33.2 % | 0 |
| fade | 577 | 21.3 % | 34 | 13.7 % | 0 |
| fade+list | 48 | 1.8 % | 50, 55 | 1.8 % | 4, 5 |

The trace stopped on none of the programs, and no header has `y` > 0, so the vertex copy at `0x390` never runs.
`vu1dump4` gives the same four paths at 29/26/24/21 % (kick/list/fade/matrix), and its list lengths are 7-20.
The most common list lengths are z = 7 (260 programs, 239 of them the family-A list `68 08 10 54 18 28 42`,
research/82 §9.1) and z = 6 (167, 157 of them `68 08 54 18 28 42`). **[verified]** (the x lanes of `TOP+1..TOP+z`).

### 1.3 Why 25,000 a second

`--groups` reads the runs of entry-0 programs between two dispatcher entries, in file order:

| run, then | count |
|---|---|
| `matrix fade list kick -> 0x1b50` | 535 |
| `(none) -> 0x1b50` (a list re-entered with the state left as it was) | 312 |
| `(none) -> 0x33c8` (the skinning chain, research/82) | 198 |
| `list kick -> 0x1b50` | 113 |
| `kick -> 0x1b50` | 40 |
| `fade list kick kick -> 0x1b50` | 35 |
| `matrix fade+list kick -> 0x1b50` | 33 |

So the game sets up an object with four separate MSCAL 0s: the object's matrices, its fade parameters, its command
list and its GS state. Only then does it MSCAL `0x1b50` to draw it. The walk ran 1,724,575 entry-0 programs in
68 s: four per drawn object, a little less when only the list or the material changes. That is the game's
drawing convention. No count of objects changes it. **[verified]** from the order of the dumps; the EE-side
caller (the function that builds these VIF chunks) is **not identified**: a dump carries VU state only, no VIF or EE
address (§5).

## 2. Where the 0.66 µs goes

### 2.1 What the row's clock covers

The refusal row's clock starts at `runStart` (`ps2_vu1_core.cpp:2561`) only for this row. A fresh program at an
entry with no native program notes `no_native_entry` against `refusalStart = runStart` (`:2608`, `:2626-2628`). A
row charged after a native hand-back restarts the clock there instead (`:2687-2688`). So the entry-0 row carries
run()'s head, and the others do not. In order, inside the clock:

| step | where | what it costs | marking |
|---|---|---|---|
| the image check: the generation compare (a rehash only on an MPG upload) | `:2584-2600` | a load and a compare | [inferred] |
| the native table scan by (hash, pc), then `hashHasNativeEntry` twice, three walks of the two-entry table | `:2619-2628`, `:2640`; `vu1_native_warning.h:70-76` | a few ns | [inferred] |
| **a `steady_clock::now()` for the foreign-disc warning on every run**, though `shouldWarn` returns at once when the hash matched | `:2635-2640`; `vu1_native_warning.h:30-36` | one QueryPerformanceCounter, about 15-30 ns | [inferred] |
| `Vu1Refusals::note` (instrumentation, Dev only): one hash probe and one `lock xadd` | `vu1_native_refusals.h:161-183` | about 10-20 ns | [estimate: a typical figure, not measured on this host] |
| the generated function: `vf` copied in (512 bytes) and out, ACC, the computed-goto entry, `g_vuInsnCount.fetch_add` | `vu1_d418194495c25213.cpp:530-541`, `:16441-16445` | about 20-40 ns | [estimate: a typical figure, not measured on this host] |
| **the program: 53 pairs at the generated rate**, with `setVi`/`markVi`/`loadVf`/`markVf` bookkeeping per pair | `vu1_d418194495c25213.cpp:543ff` | 0.23-0.30 µs at 4.3-5.6 ns/cycle (§2.2) | [estimate] |
| **the kick path's two XGKICKs.** Each is a direct submit, and the arbiter calls the GS with the queue empty (`ps2_gif_arbiter.cpp:30-42`). The GS then takes `GS::processGIFPacket`'s recursive mutex (`gs_frontend.cpp:858-860`), parses the GIFtag and writes 5 or 6 A+D registers. `TEX0_1` runs `loadClutIfNeeded` (`:1464-1481`). | `ps2_vu1_core.cpp:1062-1125` | unmeasured. It is paid by 30 % of entries: 0.6 kicks per entry | — |
| `fastFlush` (the flag ring's last ready cycle, then `fastCommit`) and the rounding restore | `:2946`, `:2964`; `:2078-2091`, `:2152-2170` | small: the tail fit in §2.2 bounds the whole tail | [inferred] |
| the closing `steady_clock::now()` | `:2968` | about half of one read | [inferred] |

Outside the row's clock, but paid per program: the dump-knob test (`:2414-2450`), two atomic counters for pc 0
(`:2547-2549`), `VuRoundingScope`'s `fnstcw`/`fldcw`/`stmxcsr`/`ldmxcsr` (`:2556`), `runStart` itself, and under
the Dev knobs `addCost`, `maybePrint`'s `try_lock` and the `PS2X_VU_STATS` block's own `now()` (`:2971-2993`).
**[inferred]**

### 2.2 What the walk measures

Over the 68 one-second rows of the window, each row fitted as `host_us = A·n + B·cycles`:

| row | cycles per entry, range over the walk | fit | µs per entry, range over the walk |
|---|---|---|---|
| `entry=0x33c8 skin_pass` | 259-434 | A = -0.003 µs, B = 4.32 ns/cycle | 1.09-1.94 |
| `entry=0x1b50 unknown_command 0x52` | 549-820 | A = 0.074 µs, B = 5.64 ns/cycle | 3.16-4.85 |
| `entry=0x0 no_native_entry` | **52.3-53.3** | degenerate: the cycles per entry do not move | **0.546-0.839** |

**[measured]** The two rows clocked after a hand-back cost about 4.3-5.6 ns per cycle, and their tail (generated
entry and exit, `fastFlush`, the restore, the closing clock) is near zero. On entry 0's 53 cycles, that rate is
0.23-0.30 µs. Entry 0's own cost is 0.55-0.84 µs per entry, with constant VU work. So more than half of the 0.66 µs
is not the program's arithmetic. It is in the head (§2.1: about 50-80 ns), in the kick path's GS work, and in cache
and predictor warmth. Entry 0 runs in the gaps between other work, and the cost per entry is highest in the seconds
with the fewest entries: 0.77 µs at 17,137 entries, 0.60 µs at 41,565. **[estimate]** the split. Only the measurement
in §3.1 tells the kick path's GS work apart from the warmth.

For scale, from the `[vu1-stats]` lines of the window: 54,134 VU1 programs a second, and 243.5 ms/s of VU1 host
time. Entry 0 is 47 % of the programs (1,724,575 of 3,681,079) and 7 % of the VU1 host time (17 of 243.5 ms/s).
The mean over every program is 4.50 µs. **[measured]**

## 3. The levers

### 3.1 First: split the entry-0 key by path (Dev instrumentation) — GO

At `ps2_vu1_core.cpp:2626-2628`, pass a command code for entry 0's path to `Vu1Refusals::note`: `TOP.w`'s bits 0,
1 and 3, with a list bit for `z` > 0. The `cmd=` field already exists (`vu1_native_refusals.h:366`), so the row
becomes four rows (kick, matrix, fade, list). One walk then gives µs per path. Under §2's numbers, a kick row well
above 37 cycles × 5 ns, plus the head, is the GS work. A matrix row near 82 × 5 ns is VU work. That decides (a)
against (c) without a build of either. It costs one `ILW`-equivalent load per entry-0 run under the Dev knob only.
Risk: none to the game. Stake: the decision on (a).

### 3.2 (b) A cheaper dispatch for every program — GO, the safe half

These items are independent and change no VU semantics. Each applies to all 54,000 programs a second, entry 0 and
the rest:

| item | change | saving | risk |
|---|---|---|---|
| b1 | compute `nativeNowNs` only when `hashHasNativeEntry` is false (`:2635-2640`), so the matched image never reads the clock | one QPC per program: about 15-30 ns × 54k = 0.8-1.6 ms/s | none: the warning's state machine sees the same calls when unmatched |
| b2 | cache the (hash → has-native, (pc → fn)) answers per `m_knownGeneration` (`:2584-2628`) | about 5-10 ns per program: 0.3-0.5 ms/s | low: invalidated with the hash |
| b3 | `g_vuInsnCount` (the generated `end:`), `g_vuProgramsAtZero`/`KickBit` (`:2547-2549`), `g_xgkickDecoded`/`g_xgkickCount`: VU1 runs on one thread, so make them plain or thread-local counters that the stats line sums | 3-5 `lock xadd` per entry-0 run, about 5-8 ns each: 0.4-1 ms/s | low: the readers are the stats and debug lines, AND `vu1_replay.cpp:1209-1218` reads `g_vuInsnCount` for its pair totals, AND VU0 runs bump the same counters (`ps2_vu1_core.cpp:2384`, `:2752`) -- a per-thread or plain counter is safe only if both are settled first (the review of 0e1522bd) |
| b4 | the generated code's 1 KB `vf` copy in and out (`vu1_d418194495c25213.cpp:537`, `:16441-16443`): copy only the registers the reachable code touches, or work in `m_state` | at most the tail §2.2 bounds, ≤ 0.05 µs × 54k ≤ 2.7 ms/s | medium: a regenerated image, the whole VU1 path, the fence |

b1-b3 come to about 1.5-3 ms/s in all. One A/B on one exe measures them by `[vu1-stats] host=` and SYNCV, under
research/82 §6 item 4's rule. Leave b4 until the profile names it. Also left out: the rounding scope (about 10 ns) could
be held across back-to-back MSCALs, but EE code runs between them. **[estimate]**

### 3.3 (a) A native program for pc 0 — NO-GO for now

As one shape it is four paths and about 150-200 lines.

- **kick, fade, list** are copies and kicks: 79 % of the entries and 65 % of the pairs. They are bit-exact by
  construction. They have no FMAC, so MAC, STATUS and ACC are untouched, and they leave the same `vi` and the same
  last-loaded `vf`. That includes the list path's read one qword past an odd `z` into `vf18`. About 60 lines.
- **matrix** is 44 FMACs (MULA/MADDA/MADD; the review of 0e1522bd counted 44 on any one path, not 48) through `ps2_vu1_ops.h`'s flag-exact ops, plus the live-out `vf1`-`vf28`
  and the dispatcher's live-ins (§1.1). About 80 lines, and the proof that the 0x1b50 fixtures still pass after it.

What it saves is the VU-work part only. run()'s head, the kicks' GS work and the warmth stay, because a native
program is entered from the same run(). On copy code, the generated per-pair bookkeeping is a larger share than on
the FMAC code research/82 timed (native 83-91 % of generated there). Take 25-75 % of 0.23-0.30 µs, plus the
`vf` copy that native skips: about 0.06-0.2 µs per entry, × 25k, is **1.5-5 ms/s of the 17**. **[estimate]**
The risk: a third native entry in the registry (two today, `vu1_native_programs.cpp`), whose matrix path carries flags into the next program. Research/82
§10.4 notes that only the last MAC and the OR of the sticky bits survive into the next program. Reconsider
after §3.1: if the kick path is mostly GS work, the native win shrinks to the matrix and list paths.

### 3.4 (c) Nothing: the game's own work

The kick path's GS packet is the object's render state. The arbiter and the GS run it however the VU side does.
Two observations, neither a lever yet:

- 294 of 816 kick programs, and 157 of 577 fade programs, copy bytes their destination already holds. That is the
  game re-sending unchanged state. The kick must still reach the GS, because other paths may have changed GS state
  in between. [verified] the counts.
- The 423 kick is an empty GIFtag. Skipping it in `startXgkick` would save one `processGIFPacket` per kick path
  (mutex, tag parse): about 7,600 a second, under 1 ms/s. Any GS-side effect of an empty PATH1 packet would have to
  be ruled out first. [estimate]

## 4. Command `0x3e` at `0x1b50`

### 4.1 What it is

The jump table's slot 31 (`0x1d90: B 0x2e00`) is `0x3e`, and slot 30 (`0x1d80: B 0x2b80`) is `0x3c`. Research/12's
slot table lists neither, and research/13 never names them. **[verified]** by `vu1dis --start 0x1ba0 --count 122`.

```
0x3c  0x2b80: vi3 = vi1 + 4 (the vertex array), vi4 = 40 (staging), vi6 = 752 (-> 0x1780, cmd 0x28), vi9 = TOP+2.z
0x3e  0x2e00: vi3 = vi8 (the clipped polygon), vi4 = 150 (staging), vi6 = 847 (-> 0x1a78, cmd 0x2a), vi9 = vi10;
              B 0x2ba0, the shared body
0x2ba0: save vi3/vi4/vi9 to qword 339; vi5 = 340 + vi14; vi14 += 14     ; a 14-qword inline block in the list
        XGKICK vi5                                                       ; its leading GIF packet goes to the GS
        vf23 = -block[11]; vf21 = block[10]; vf17..vf20 = block[6..9]; vf27 = block[12]; vf28 = block[13]
  0x2c58, per vertex (51 pairs, vi9 times; position 0(vi3), normal 1(vi3), stride 3):
        vf22 = M(block[6..9]) x p ; vf29 = M(vf1..vf4) x p ; Q = 1 / vf29.w (DIV)
        ST = vf22.xy * Q           -> 0(vi4)                         ; the projector's texture coordinates
        a = (block[10] - p) . n    ; b = -block[11] . n ; c = (block[12].w - a) * block[12].z ; each clamped to [0, 1]
        colour = block[13], colour.w *= a * b * c   -> 1(vi4)        ; the light's intensity in alpha
  JR vi6                                                             ; into 0x28's packet build or 0x2a's flush
```

This reads as a projected-texture spotlight: a texture cast by a projector matrix, attenuated by facing, angle and
distance. It is drawn as an extra pass over geometry already set up, `0x3e` on family B's clipped polygons and
`0x3c` on family A's vertex arrays. **[verified]** the register flow; **[guess]** the name ("spotlight").

### 4.2 Its stake and whether native could take it

Walk: 14,124 lists in 68 s (42-420 a second, in 66 of the window's 68 seconds), 150.3 M cycles (10,644 per
list) and 559 ms (39.6 µs per list), **8.2 ms/s**. **[measured]** The cycles are the whole list's, not
`0x3e`'s alone. A refusal at `unknown_command` is the native pre-scan's, so it hands back the whole program
(`socom2_dispatch_0x1b50.cpp:922-926`). So everything
native already does in that list (`0x02`'s clipper, `0x0a`, `0x12`, `0x1a`, `0x2a`) runs generated as well.

Native could take it: the inline-block step is `0x30`/`0x32`'s (`kCmdInlineBlockOverA/B`,
`socom2_dispatch_0x1b50.cpp:286-288`), the tail is `0x28`/`0x2a`, and the loop is FMAC with a DIV, no flag read.
About 100-150 lines, with Q, I (`LOI -1` at `0x2c18`), the last MAC and sticky STATUS exact.

The gain is the whole list going native at research/82's measured native share (83-85 % of generated on
`0x1b50` lists), which is **about 1.2-1.4 ms/s**. [estimate] It also needs a capture first, and none exists. A scan
of every dump on disk walks no `0x1b50` list holding `0x3e`. `PS2X_VU1_DUMP_REFUSED` captures only `resume_command`
and `write_range` (`vu1_dump_refused.h:5-9`). At about 1 program in 260, a `PS2X_VU1_DUMP` window of 4,000 caught
none. **NO-GO now.** If it is taken up later: let the refused dumper admit `unknown_command 0x3e` (a runtime change),
capture, then size the native handler against the measured list.

## 5. Not done

- **The EE-side caller of the MSCAL 0s** is not identified. A dump has no VIF or EE address. Research/12, /13 and
  /15 name the VIF chunk's VU-side layout only. Finding it needs a VIF trace (`PS2X_TRACE_VU` prints the header and
  not the EE pc) or a symbol search for the chunk builder in `recomp/output`. Neither belongs in this branch.
- **The per-path split of the 0.66 µs** is the measurement §3.1 proposes, not taken. Every per-path figure in §2-3
  is an estimate from the walk's totals, the fit's rate and the trace's pairs.
- **The QPC cost** (about 15-30 ns) is a typical figure for an invariant-TSC host, not measured on this one.
- **No `vu1_replay` run** (the brief): the trace counts pairs and does not model stalls. The trace's 52.8 against
  the walk's measured 52.7 cycles shows the stalls are negligible. The menu's matrix-only seconds, at 83 cycles
  per program (`2490/30`) against the trace's 82 pairs, put them at about one cycle.

## 6. Done: b1, b2 and the split (branch `agent/s17-vu1-dispatch`, 2026-10-01)

b3 is left out: `vu1_replay` reads `g_vuInsnCount` for its pair totals and VU0 runs bump the same counters (the
review of 0e1522bd). What changed in `VU1Interpreter::run`:

- **b1.** The foreign-disc warning reads the clock only when the image's hash has no native entry
  (`Vu1NativeWarning::nowNs()`). `shouldWarn(true, ...)` never looked at the time, so the warning's text, its
  one-second window, its first line and its re-arm on a match are unchanged. A test counts the clock reads: none
  on five matched runs (five before), one on each unmatched run, the line out once past a second.
- **b2.** The native lookup's answers are kept per image and table. `m_nativeHashHas` holds whether any row has the
  hash. Eight slots indexed by pc hold the scan's answer for (hash, pc), with the row's gate asked once. A new MPG
  generation (the rehash) or `setNativeProgramsOverride` drops them. A test runs a three-row table (one row gated
  shut) over nine runs at four pcs, then an override, then new microcode. It takes the same program as the
  uncached scan on each run, counts the same `no_native_entry` rows and the same `native-entered`, and asks the
  gate once, not three times. A planted mutation (no drop on the rehash) fails that test.
- **The split.** Under `PS2X_VU1_NATIVE_REFUSALS=1` only, `no_native_entry` at entry 0 is keyed by the path the
  header at `TOP` selects: `cmd=kick`, `matrix`, `fade`, `list`, `fade+list` or `none`
  (`Vu1Refusals::entry0Path`). The tests are the microcode's own, in its order, on ILW's 16 bits. Every other
  `no_native_entry` keeps `cmd=-`. Over all 2,712 entry-0 dumps of `vu1dump5` and 217 of `vu1dump4`, the rule names
  the path `vu1_entry0_shapes`' trace names. `vu1_refusals` reads a path name as `cmd=`. **[verified]**

**Per-run cost** (scratch harness, not committed): `execute()` back to back, 1,000 runs, best of 9, three
rounds, `-O3`, the built-in registry (the image matches; entry 0 takes the head, then the generated code), knob off.
Base and branch cores compiled alike:

| program | base | branch | saving | the generated call alone (the floor) |
|---|---|---|---|---|
| kick (`vu1_prog_1`) | 146.5-148.5 ns | 130.0-130.3 ns | 16-18 ns | 58.6-58.9 ns |
| matrix (`vu1_prog_9`) | 488.6-502.5 ns | 491.9-495.3 ns | within the noise | 405.2-407.4 ns |
| fade (`vu1_prog_10`) | 120.9-126.3 ns | 103.5-104.7 ns | 17-22 ns | — |
| list (`vu1_prog_0`) | 138.2-144.2 ns | 120.6-121.4 ns | 17-23 ns | — |

`steady_clock::now()` measured 15.8-16.2 ns a read on this host. That replaces §5's 15-30 ns typical figure.
**[measured]**, a scratch reading. On the short paths the saving is about one clock read. On the matrix path
it does not show: one reading of that is that the read overlaps the program's 44-FMAC chain. **[inferred]** After
the change, run()'s head and tail around the kick's generated call are about 71 ns (130 − 59).

At research/83's rates (25,000 entry-0 programs a second, 79 % of them on the short paths), entry 0 saves about
0.35-0.4 ms/s of its 17. The other 29,000 programs a second take the same head. Their saving cannot be read at
this resolution (a 0x1b50 list is 15.7 µs), and it is at most 16 ns each. So b1 and b2 together come to roughly
0.4-0.9 ms/s, below §3.2's 1.1-2.1 ms/s for these two. **[estimate]** The walk with the split
(`PS2X_VU1_NATIVE_REFUSALS=1`) is the next reading. It also settles (a) against (c), §3.1.

Differentials, unchanged against the base, with packets compared and `PS2X_VU1_FAST=0` and `=1`:
- `0 of 25 differ, 3 taken natively`, `skin_pass` n=22 (the `vu1dump3` `0x33c8` dumps);
- `0 of 51 differ, 51 taken natively` (`vu1dump5/lastbone.txt`);
- `0 of 2000 differ, 2000 taken natively` (`vu1refused1`).
