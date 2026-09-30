# 82 — Native entry `0x33c8`: two programs behind one MSCAL, and the half that is the dispatcher (2026-09-30)

Sprint 17 F, candidate N1 (the lever `docs/research/81-vu1-program-d418-cost.md` §3.4's superseding note names).
A spike with a decision, and the code for the half that passed it (branch `agent/s17-n1-33c8`). Inputs: the
microcode (`python tools_py/vu1dis.py --start 0x3100 --count 80 logs/vu1dump3/vu1_prog_141.bin`), the 25
`startPc = 0x33c8` dumps in `logs/vu1dump3` (research/15 §1.3, §4.4), the refusal walk `logs/parity/ab/vu1refuse/on`
(`python -m tools_py.parity.vu1_refusals --stamp logs/parity/ab/vu1refuse/on --by key`, sampler window
277.6-346.3 s = 68.7 s) and its `[vu1-stats]` lines over the same window.

## 0. Headline

1. **`0x33c8` is not the dispatcher behind a prologue: it is a six-pair test choosing between two programs.**
   `XTOP vi1`, then `vi7 = vi5 & 4` on a LIVE-IN `vi5` (the previous chunk's flags word, left by the program that
   ended at `0x33c8`), then `IBEQ vi7, vi0, 0x3100`. **(A) not the last bone:** the branch goes to `0x3100`, the
   `0x52` skinning body -- another bone pass, no dispatcher, zero packets, ending at `0x33c8` again through the E
   bit at `0x33b8`. **(B) the last bone:** three pairs of setup and a 16-pair repack loop (`vi9` iterations), then
   `B 0x1b60`: the dispatcher resumed at the LIVE-IN `vi14`, which runs `66 08 40 42`. The brief's premise ("the
   follow-ons dispatch `66 08 40 42`") holds for (B) only. **[verified]** disassembly §1, dumps §2.
2. **By entries (A) dominates; by cycles (B) does.** Corpus: 22 (A) and 3 (B) of 25; (A) 6,120 VU cycles in all
   (278 per entry), (B) 7,976 (2,846 + 3,693 + 1,437). The walk: 950,896 `0x33c8` entries, 2.154 G cycles (2,266
   per entry, 7.84 µs of generated code each); one (B) closes each skinned mesh, and each mesh opens with one
   `0x1b50` list refused on `0x52` (294,653 over the window), so about 295k (B) and 656k (A) entries. **[verified]**
   for the corpus; **[inferred]** the walk split (one (B) per mesh, from research/15 §4.4's flag sequence); (B)'s
   share of the walk's cycles is then 70-91 % for an (A) mean of 1,000 down to 278 cycles. **[estimate]**
3. **Decision: GO for (B), done here; NO-GO for (A) this sprint.** (B) is the brief's case: the same dispatcher
   entered at another pc after 27 pairs of prologue (the test, the setup, the loop, the branch), needing one
   handler native lacked (`0x66`, 33 pairs) beside `0x08`, `0x40` and `0x42`, which it has. (A) is a different program -- the `0x52` body -- and belongs with the
   `0x52` lists native refuses at `0x1b50` (N2, §7). Implemented behind `PS2X_VU1_NATIVE_33C8` (Dev, default 0).
4. **The stake is below the 108 ms/s bound.** The bound is the `0x33c8` fallback's host time over the walk, 7,452
   ms / 68.7 s. Native is not free: in a scratch harness on the three (B) dumps its `execute()` took 54-70 % of
   the generated code's time (§5), so (B) native saves an estimated 30-45 % of (B)'s, **about 23-45 ms/s** of the
   game thread's VU1 time -- if the walk's (B) lists behave like the corpus's three. The walk (rung two) decides.
   **They do not (N1b, §8):** the walk's (B) lists hold the backface cull `0x06`, which N1 refused whole; with
   `0x06` admitted the stake is about 30-35 ms/s (the review corrected 30-39). **[estimate]**

## 1. The microcode

Image `d418194495c25213`, pairs as `vu1dis` prints them (upper NOPs and `MOVE. vf0, vf0` omitted):

```
0x33c8  XTOP vi1                         ; the entry
0x33d0  IADDIU vi7, vi0, 4
0x33d8  IAND vi7, vi5, vi7               ; vi5 LIVE-IN: bit 2 = the previous chunk was the last bone
0x33e8  IBEQ vi7, vi0, 0x3100            ; (A): another 0x52 pass (0x3100-0x33b0), E bit 0x33b8, ends at 0x33c8
0x33f8  ILW.x vi2, 37(vi0)               ; (B): the staging base, 40 (0x3178 persisted it on the first pass)
0x3400  IADDIU vi3, vi1, 4               ; the vertex block, three qwords a vertex
0x3408  LQ vf28, 338(vi0)                ; the colour quad every vertex gets
0x3410  LQ vf27, 1(vi3)                  ; loop, vi9 times: the record's UV qword (integers)
0x3418  LQ vf30, 1(vi2)                  ; skinned normal
0x3420  LQ vf29, 0(vi2)                  ; skinned position
0x3428  IADDIU vi2, vi2, 2
0x3430  MULz.w vf30, vf0, vf30z | ISUBIU vi9, vi9, 1      ; FMAC: MAC/STATUS move
0x3438  ADDy.z vf30, vf0, vf30y                            ; FMAC
0x3440  ITOF12.xy vf27, vf27
0x3458  MR32.w vf29, vf30                ; position.w = normal.x
0x3460  SQ.xy vf27, 1(vi3) ; 0x3468 SQ.zw vf30, 1(vi3) ; 0x3470 SQ vf28, 2(vi3) ; 0x3478 SQ vf29, 0(vi3)
0x3480  IBNE vi9, vi0, 0x3410  / 0x3488 IADDIU vi3, vi3, 3 (delay slot)
0x3490  B 0x1b60                         ; the dispatcher's command read, at vi14 as the last program left it
```

`0x66` at `0x2e28` (research/15 §5, 33 pairs to its `B 0x1b60` and delay slot): `vi4 = TOP + TOP+2.x`, `vi3 = TOP+4`, `vi13 = TOP+2.w`; per
index record (two qwords) `(v2 - v1) x (v0 - v1)` by `SUB.xyz` x2, `OPMULA.xyz`, `OPMSUB.xyz`, `FTOI15.xyz`, stored
`SQ.xyzw` to record [1] in the delay slot of `IBGTZ vi13` -- after the body, so a zero count still runs once; the
next record's three vertices are loaded before the test (vi5-vi7, vf17-vf19 live-out past the end); record [1].w is
`vf29.w` from before the handler, the repack's last `MR32.w`. **[verified]**

## 2. Preconditions and effects

| | entry (B) | marking |
|---|---|---|
| live-in registers | `vi5` bit 2 set (5 in all three dumps), `vi9` = the vertex count the first `0x52` pass saved (29, 46, 15), `vi14` = the resume index (1: q341 = `0x66`), TOP (XTOP) | **[verified]** |
| live-in memory | q37.x (40), the staging array from q40 (position, normal a vertex), q338, the records at TOP+4 (UV integers in [1].xy), the header TOP+2 (x index offset, z vertices, w triangles), the list at q340 | **[verified]** |
| writes before the dispatcher | `vi1` = TOP, `vi7` = 4, `vi2` = q37.x + 2 vi9, `vi3` = TOP+4+3 vi9, `vi9` = 0; vf27-vf30 the last vertex's; MAC/STATUS from the last `ADDy.z`; records TOP+4 .. TOP+4+3 vi9-1 | **[verified]** |
| the dispatcher from 0x1b60 | exactly as at `0x1b50` after its `vi14 = 0`, but from the live-in index | **[verified]** |

The corpus TOPs are 424 and 724 and the list sits at q340-q403: no store of the program touches the list, the
header or the packet pointers at q329, but nothing in the microcode guarantees it, so native proves it (§3).
**[verified]**

## 3. What was implemented (`agent/s17-n1-33c8`)

- `socom2_dispatch_0x1b50.cpp`: `vu1native_socom2_entry_0x33c8` (the six-pair test, the refusals, the repack,
  then the shared loop `runFromNextCommand`, extracted unchanged from the `0x1b50` entry), `repackSkinnedVertices`,
  `cmdFaceNormals` (`0x66`, with the triangle clamp every handler has) and `repackFits`. The pre-scan starts at the
  live-in `vi14` and admits `0x66` only for this entry (`Ctx::faceNormals`); at `0x1b50` a `0x66` is still
  `unknown_command` and a list holding one still hands back whole (a test holds it).
- Refusals, whole-program with pc left at `0x33c8` and nothing written (`runtime/vu1_native_refusals.h`,
  appended): `skin_pass` (A), `repack_range` (`vi9` outside 1..256, or the records failing the write proof below),
  `resume_index` (`vi14` outside the list), `write_range cmd=` (that command's stores would fail the proof) and
  `resume_command cmd=` (the resumed list holds a command other than `0x66`, `0x08`, `0x40`); the dispatcher's own
  (`xgkick_cycle_exact`, `unknown_command`, the header ceilings, ...) are keyed `entry=0x33c8`.
- **The write proof (fix round, 2026-09-30).** The pre-scan validates by reading the list, the header TOP+2 and
  the packet pointers at q329; a later store landing on any of them would let a command run on something the scan
  never saw. So before the repack's first store every store range of the program is proven not to wrap VU memory
  and not to touch those three (`writeRangeClear`): the repack's records; `0x66`'s index records [1],
  TOP+TOP+2.x+1+2k for k < max(TOP+2.w, 1); `0x08`'s staging triples, q40 + 3 max(TOP+2.z, 1); `0x40`'s tag qwords
  290 and 300 and the nine packet qwords after each of q329.x and q329.y (its own rewrite of q329 keeps the pair).
  Only those three commands are admitted after the resume, because only their ranges are derived (N1b, §8, adds
  `0x06`). The handler-side
  ceilings (lowered only by the test knobs) are checked there too, so no clamp can hand back mid-list after the
  repack has stored: the program is accepted with every write proven, or refused before the first write.
- The gate: `Vu1NativeProgram` gained an optional `enabled()`, asked after the (hash, pc) match (`ps2_vu1.h`,
  `ps2_vu1_core.cpp`); the registry's `0x33c8` row points it at `PS2X_VU1_NATIVE_33C8`, read once. Off, run()
  finds no program there, exactly as before: `no_native_entry` counted, no `native-entered` count, the generated
  code runs it.

## 4. Risk

- **The fence is three real programs.** Every (B) dump of the corpus is `66 08 40 42` from index 1 with 15-46
  vertices; the walk's (B) entries run two to two and a half times the corpus's cycles (§0 item 2's estimate), so
  bigger meshes, same code path. Any command other than `0x66`, `0x06` (N1b, §8), `0x08`, `0x40` and `0x42` in the resumed list is refused (`resume_command`); a list made only of those, in any order or count, is accepted with every write proven (the review of 7e894298, 2026-09-30).
- The handlers' known caveats carry over unchanged (the file's header): FMAC flags committed immediately (no FMAND
  in `0x66` or the repack), `m_cycle` not advanced (VU cycles/s under-reports by what these lists cost), the
  immediate XGKICK model required.
- Knob off, every `0x33c8` entry pays the gate: one indirect call and a static load. Knob on, (A) entries also pay
  the native call and its refusal (a few compares) before the generated code runs them.

## 5. Evidence (no build under the lock, no game, no `vu1_replay`)

- `ps2xTest/src/vu1_ops_tests.cpp`, six cases on the real image (the fixture `vu1dump3_prog_31.bin` with a last-bone
  state written over it): the gate; (B) against the interpreter (register file and VU data memory; packets too under
  the immediate XGKICK model); a zero triangle count; (A) refused as `skin_pass` with the microcode's own end state;
  thirteen unprovable states (the repack's, `0x66`'s, `0x08`'s and `0x40`'s ranges, the resume index, a `0x28` (N1b: was `0x06`) in
  the list, a lowered vertex ceiling) each refused under its reason with the register file and VU data memory
  unchanged against a snapshot taken as the program was entered; `0x1b50` unchanged. RED on a stub, GREEN on the code, and
  three planted mutations (no `MR32.w`, `OPMSUB` operands swapped, `SQ.xyz` for `SQ.xyzw` in `0x66`) each fail.
- Scratch, not committed: the same comparison over the 25 real `0x33c8` dumps, `PASS: 0 of 25 differ, 3 taken
  natively`, `skin_pass n=22 cycles=6120`, against the interpreter (`PS2X_VU1_FAST=0`) and against the generated
  code (the main tree's library), packets included. Timing of `execute()` alone, 1,000 runs, `-O3`, on the loaded
  host: `vu1_prog_128` 8.9-9.9 µs generated against 5.4-6.1 native, `141` 11.6-12.1 against 7.8-8.5, `144`
  4.7-5.6 against 2.6-3.1. **[measured]**, a scratch reading, not rung one.
- The walk's native path, for scale: `[vu1-stats]` means over the window, `host=275.1 ms/s`, `native-entered/s=14288`,
  `native-ended/s=9754`; less the fallback's 152.0 ms/s that is at most 8.6 µs per native entry (12.6 per list it
  ended) against 7.84 µs per generated `0x33c8` entry. **[measured]** from `mission.game.log`. That per-entry figure
  does not carry across the knob: with it on, EVERY `0x33c8` entry counts as `native-entered`, about 13.8k/s over
  the walk, the (A) skin passes included (about 9.5k/s of them, each refused and handed back) -- so `native-entered/s`, `native-handbacks/s` and
  any cost per native entry change meaning between the two legs (§6.4).

## 6. The controller's fence and pick (after a build)

1. Goldens per set, interpreted, native off (research/15 item 7's correction):
   `PS2X_VU1_FAST=0 PS2X_VU1_GEN=0 dist/vu1_replay.exe --batch logs/vu1golden/n1_33c8 --no-native <the 25>`, the 25
   being `logs/vu1dump3/vu1_prog_<n>.bin` for n in 122-128, 130-141, 143, 144, 146-149.
2. `PS2X_VU1_NATIVE_33C8=1 PS2X_VU1_NATIVE_REFUSALS=1 dist/vu1_replay.exe --verify logs/vu1golden/n1_33c8/state.txt
   --native --regs all <the 25>`: 25 `OK`, `PASS: 0 mismatching field(s)`, and `[vu1-refuse-total] entry=0x33c8
   reason=skin_pass ... n=22`; the same without `PS2X_VU1_NATIVE_33C8`: 25 `OK` and `entry=0x33c8
   reason=no_native_entry ... n=25`. `vu1_replay` sets
   developer mode itself, so the Dev knob is honoured. Both under the lock.
3. The full `ps2x_tests` binary (its main latches the cycle-exact XGKICK; the rig forces the dispatcher's model) and
   the existing `--native --regs all` fixture sets, unchanged by construction.
4. Rung two: the mission walk knob off then on, one exe, `PS2X_DEV=1`; SYNCV decides, `ee: work=` and `[vu1-stats]
   host=` say why; with `PS2X_VU1_NATIVE_REFUSALS=1` the `0x33c8 no_native_entry` row becomes `skin_pass`, at about
   two thirds of its entries. Compare the legs by `[vu1-stats] host=` ms/s and `ee: work=` ms/s only: knob on, every
   `0x33c8` entry, (A) included, is counted in `native-entered/s` (about 13.8k/s more than knob off) and each (A) in
   `native-handbacks/s` (about 9.5k/s more), so the native counters and any per-entry native cost are not comparable across the
   knob.

## 7. Not done: (A), the `0x52` body (N2)

A native `0x52` serves both (A) and the lists refused at `0x1b50` on `0x52` (1,275 ms over the window, 18.6 ms/s).
Size: the header and branch (14 pairs), the first-pass loop (20 pairs a vertex, 4x4 and 3x3 MADD chains with the
`LOI 10.0` scale), the accumulate loop (30 pairs a vertex, the staging value pre-multiplied into ACC), the E-bit
exit; about 250-350 lines and a test like §5's. The difficulty is not size: its live-out (vi2-vi12, vf19-vf30, ACC,
I, MAC/STATUS) is read by the next MSCAL (research/15 §4.5), each MSCAL being one dump the fence compares
`--regs all`. The stake is 18.6 ms/s plus (A)'s share of the 108, 10-32 ms/s, less what native costs. Entry `0x0`
(11 % of the fallback, 1.68 M tiny entries) is not a candidate.

**LATER candidate: the `0x1b50` entry's unproven writes.** The fix round's write proof (§3) is `0x33c8`'s only.
The `0x1b50` entry carries the same hole, in the base and unchanged by this branch: its pre-scan reads the list, the
header and q329 once and then trusts them, while its handlers store to ranges nothing bounds against them --
`0x08` stages at q40 + 3k for up to 256 vertices (q340, the list, from the 101st vertex); `0x68`/`0x70` convert the
records at TOP+4 in place (the list from any TOP below 340 with TOP+4+3·TOP+2.z past 340; TOP+2 itself is never
hit, being below); `0x28`/`0x40` write nine qwords after each packet pointer read from q329, guest data. The input
that reaches it: a `0x1b50` list with `0x08` and TOP+2.z of 101 to 256 (the pre-scan allows 256), or TOP at most
336 with `0x68`/`0x70` and enough vertices, or q329.x/.y within nine qwords below the list. The microcode does the
same stores, so every handler native runs stays exact; the proof is what breaks -- the list re-read at `0x1b60` can
then hold a command, or a `0x30`/`0x32`/`0x34` block, the scan never checked. No corpus list comes near (maxima 78
vertices, TOP 424/724, q329 = 300/290). The fix would be `0x33c8`'s: derive each admitted command's store range
and refuse whole, a pre-scan change to the most-covered entry, so it waits for its own task and fence.

## 8. N1b -- the backface cull `0x06` in the resumed list (2026-09-30, branch `agent/s17-n1b-cull`)

**Why.** The walk with N1 on (`logs/parity/ab/vu1refuse/n1on`, 09:34Z, the same 68 s window) refused
`entry=0x33c8 resume_command cmd=0x6` 270,898 times: 5,876 ms of fallback host time, 85.5 ms/s, 71 % of the
fallback's VU cycles, about 21.7 µs a list against 9.5 µs for the corpus's largest (B). The refusal names the first
command the write proof has no range for, so the walk's last-bone lists hold `0x06`, after any `0x66`. No dump in
`logs/vu1dump`, `vu1dump2`, `vu1dump3` or `vu1dump4` holds one: every skinned list on disk is `52 66 08 40 42`.
**[verified]**

**The shapes.** The dispatcher at `0x1b60` runs whatever the list holds from the live-in `vi14`. Nothing in the
microcode fixes what follows `0x52`. The repack leaves the vertex block in the float layout `0x70` leaves: position,
UV, colour. So every family-A consumer can follow. The 42-dump mix gives the order: `0x06` sits after the unpack and
before `0x08` (`70 06 08 40 42`, 30 lists), and it reads the normals `0x66` rebuilds. The likely walk shape is
therefore `66 06 08 40 42`. **[inferred]** The proof walks the resumed list in order and admits `0x66`, `0x06`,
`0x08` and `0x40` in any order or count, so `06 08 40 42` is taken too. Any other command is still refused before
anything is written. If the walk's lists hold one after the `0x06`, the next walk's refusal lines name it (§8.4).

### 8.1 What `0x06` does (`0x1638-0x1768`, `cmdBackfaceCull`)

- **Reads.** `TOP+2.x` (the index list), `TOP+2.w` (the triangle count), the eye at q30 and each index record's
  `[0].x` (the reference vertex) and `[0].w` (the flag word). It also reads `[1]`, the normal as 1.15 integers,
  converted by `ITOF15`, and the reference vertex's position at `TOP+4+[0].x`. Software-pipelined: the next
  record's `.x`, normal and vertex are loaded before the test, one record past the end.
- **Stores: one per triangle,** `ISW.w vi12, 0(vi4)` at `0x1738`: record `[0].w` = flag word & 32766, or'd with 1
  unless the dot product `(eye - vertex) . normal` is negative. The body runs before the `IBGTZ vi9` at `0x1750`, so
  the store set is qwords `TOP + TOP+2.x + 2k` for `k < max(TOP+2.w, 1)`. It does not store anything else.
- **Leaves** `vi3` = TOP+4, `vi4` past the last record, `vi5` = 16, `vi8` = 1, `vi9` = 0 (or -1 for a zero count),
  `vi11`, `vi12`, `vi13`; `vf26` (the eye) to `vf30`; `ACC.w`; MAC/STATUS from its last `SUB.xyzw` at `0x1740`.
  `0x08` next reads none of the registers (research/15 §2.3: its live-in is `vf1-vf4`). `0x40` reads the flag words.
  **[verified]** disassembly (`vu1dis --start 0x1638 --count 40`), the handler, the tests below.

### 8.2 The flag read at `0x1718`, after the repack or `0x66`

`FMAND vi13, vi5` reads the MAC sign bit of the w lane that `MADDz.w vf30` at `0x16f8` wrote, four pairs before.
Native commits flags immediately, so it reads the newest FMAC's MAC. The interpreter reads the newest *landed* entry.
The two agree whatever ran before `0x1638`:

1. **No newer flag writer.** The pairs between are `0x1700` (NOP), `0x1708` (`ITOF15`) and `0x1710` (NOP). The
   interpreter pushes a flag entry only for an FMAC with a dest (`ps2_vu1_upper.cpp`: `pushFmacFlags` after
   `fmacArith`). `ITOF`, `FTOI` and `MR32` push none.
2. **It has landed.** An entry is ready at issue + `kFmacLatency` (4). Every pair advances `m_cycle` by at least one,
   and a stall only adds cycles. So the FMAND issues at least 4 cycles after the `MADDz.w`, and `fastCommit` or
   `commitReadyPipelines` runs before it.
3. **Nothing older is still in flight.** Entries land in issue order. The previous command's last FMAC is 23 or more
   pairs back: the repack's `ADDy.z` at `0x3438`, then the dispatcher (8 pairs) and the prologue to `0x16a8`
   (15 pairs); or `0x66`'s `OPMSUB` at `0x2ed8`. Every older entry has landed.

So the FMAND reads the `MADDz.w`'s flags in both models, on the first pass and every later one. The reasoning at the
file's line ~392 holds after N1's repack as it does after `0x70`. **[verified]** by reading and by test: in the
bit-exact cases below the cull splits the fixture's 38 triangles (16 drawn under `66 06`), so both outcomes of the
FMAND are compared, on the exact (`PS2X_VU1_FAST=0`) and the fast interpreter path. Nothing hands back mid-list, so
the E bit's in-order flush leaves the same flags in both.

### 8.3 What changed

- `socom2_dispatch_0x1b50.cpp`: `proveResumedWrites` admits `0x06` (`kCmdCull`). Its range is
  `writeRangeClear(top, indexBase, 2 * max(TOP+2.w, 1) - 1)`, the flag words as whole qwords, checked before the
  repack's first store like the others. The entry's ceiling check already covers `0x06`'s triangle clamp (`TOP+2.w`
  against `triangleCeiling()`), so no clamp can fire after the repack. `cmdBackfaceCull`'s comment carries §8.2. No
  knob, reason or registry row changed. `PS2X_VU1_NATIVE_33C8` still gates it, and its one-line description in
  `knobs.h` ("its 66 08 40 42 list") now undersells it: left as is, since `docs/KNOBS.md` is generated from it.
- `vu1_ops_tests.cpp`:
  - three cases on the real image: `06 08 40 42`, `66 06 08 40 42`, and the latter with a zero triangle count.
    Each is native and bit-exact against the interpreter, with packets compared under the immediate model.
  - `0x1b50` taking the fixture's own `70 06 08 40 42`, bit-exact.
  - four new unprovable-`0x06` states refused before any write: the flag words on the list, on `TOP+2` and wrapping
    VU memory, and a one-triangle list whose only flag word is q403.
  - The old "a `0x06` in the resumed list" refusal now uses `0x28`, still refused.

  RED on the base: the three shapes handed back and the four `0x06` states counted as `resume_command`. GREEN: 35 of
  35 under the test binary's defaults, with `PS2X_VU1_XGKICK_CYCLE_EXACT=0`, and with that plus `PS2X_VU1_FAST=1`.
  Two planted mutations each fail: the proof starting one qword late fails the q403 case, and the inverted sign test
  fails all three shapes and the `0x1b50` case.
- Scratch, not committed: the 25-dump differential is unchanged, `PASS: 0 of 25 differ, 3 taken natively`, against
  the interpreter and the generated code. The rig's three states as dumps: `execute()` over 1,000 runs, generated
  against native, `66 08 40 42` 9.54 against 6.23 µs, `06 08 40 42` 8.05 against 4.75, `66 06 08 40 42` 9.69 against
  5.75. Native is 59-65 % of the generated time. **[measured]** on the loaded host, not rung one.

**The stake, corrected.** The bound is the walk's `0x06` last-bone fallback, 85.5 ms/s. At 35-41 % saved (native at 59-65 % of the generated time; the review's repeat 57-65 %) it is
**about 30-35 ms/s** of game-thread time, if no command beyond these four hides behind the `0x06`. **[estimate]**
The walk (rung two) decides. `skin_pass` (1,089 ms, 16 ms/s) is (A), still N2's.

### 8.4 The fence: a real `0x06` last-bone dump (the controller's, a game run under the lock)

The dumper (`VU1Interpreter::run`, `ps2_vu1_core.cpp`) saves each VU1 program's *entry* state before the native
lookup. It saves every program, with no filter by start pc, the next `<count>` after it arms
(`PS2X_VU1_DUMP=<dir>:<count>`, default 150), about 33 KB each. `PS2X_VU1_DUMP_AFTER` counts seconds from the first
VU1 run, near boot. The walk runs about 87k programs/s, and about one in fifteen (4.4-6.8k/s near t=290, the review's count) is a `0x06` last-bone list. So 4,000 dumps
(about 130 MB, 1.4 frames) inside the sampler window hold a few hundred. Capture on one exe, knob off:

```
mkdir -p logs/vu1dump5   # the dumper does not create the directory: without it every fopen fails silently (the review)
bash scripts/loop_lock.sh run <owner> --purpose n1b-dump -- bash logs/s17_controller/f1_stats_walk_ab.sh vu1dump n1b PS2X_VU1_DUMP=logs/vu1dump5:4000 PS2X_VU1_DUMP_AFTER=290
```

Pick the `0x33c8` last-bone dumps whose resumed list holds `0x06`. This prints each path and its resumed list:

```
python -c "import glob,struct,sys
for p in sorted(glob.glob(sys.argv[1]+'/vu1_prog_*.bin'),key=lambda s:int(s.rsplit('_',1)[1][:-4])):
    b=open(p,'rb').read(); vi=struct.unpack_from('<16i',b,32784); cmds=[]
    if struct.unpack_from('<I',b,0)[0]!=0x33C8 or not vi[5]&4: continue
    for k in range(vi[14]&0xFFFF,64):
        cmds.append(struct.unpack_from('<I',b,16400+(340+k)*16)[0]&0xFFFF)
        if cmds[-1]==0x42: break
    if 0x06 in cmds: print(p,' '.join('%02x'%c for c in cmds))" logs/vu1dump5
```

On `logs/vu1dump3` it prints nothing; with `0x66` for `0x06` it prints `vu1_prog_128`, `141` and `144`. Take the
picked set (all, or the first 50) as `<P>`. Then, under the lock:

1. Goldens, interpreted, native off: `PS2X_VU1_FAST=0 PS2X_VU1_GEN=0 dist/vu1_replay.exe --batch
   logs/vu1golden/n1b_cull --no-native <P>`.
2. Knob on: `PS2X_VU1_NATIVE_33C8=1 PS2X_VU1_NATIVE_REFUSALS=1 dist/vu1_replay.exe --verify
   logs/vu1golden/n1b_cull/state.txt --native --regs all <P>`. Expect every `OK`, `PASS: 0 mismatching field(s)`,
   and no `entry=0x33c8` refusal line. A `resume_command cmd=<c>` line names a command the walk's lists hold beyond
   `0x06`, and that is the next derivation. A `write_range cmd=0x6` line is a real list the proof is too strict for.
3. Knob off: the same without `PS2X_VU1_NATIVE_33C8`: every `OK`, and `entry=0x33c8 reason=no_native_entry n=<|P|>`.
4. The 25 `vu1dump3` dumps as §6 item 2, unchanged. Then rung two: the mission walk, knob off then on, one exe. With
   `PS2X_VU1_NATIVE_REFUSALS=1` the `resume_command cmd=0x6` row should be gone.

## 9. N1c -- the world-object loop, the fill and the fade in the resumed list (2026-09-30, branch `agent/s17-n1c-dump-refused`)

**Why.** With N1b on, the walk (`logs/parity/ab/vu1refuse/n1bon`, 12:10Z, the same 68 s window, `--by key`) still
refuses at `0x33c8`: `resume_command cmd=0x2` 108,236 times (51.5 % of the fallback's VU cycles, 4,023 ms, about
59 ms/s), `cmd=0x54` 145,086 (19.1 %, 1,764 ms, about 26 ms/s) and `cmd=0x10` 5,556 (0.4 %). `skin_pass` is 9.7 %
(N2's). A refusal names only the FIRST command the proof has no range for, so a `cmd=0x54` list may still hold a `0x02`
further on. The controller's 4,000 dumps at one instant (`logs/vu1dump5`) hold 51 last-bone `0x33c8` entries, all
`66 08 40 42`. So these lists cluster in time, by mesh or by moment. None is on disk, and nobody has seen their full
shape. **[verified]** (the refusal table; `vu1_refused_shapes --last-bone` on `vu1dump5` prints one shape, 51 dumps.)

### 9.1 What this branch adds (the instrument, not the admission)

- **`PS2X_VU1_DUMP_REFUSED=<dir>[:<count>[:<entrypc>]]`** (Dev Path, default empty = off;
  `runtime/vu1_dump_refused.h`). A program refused whole as `resume_command` or `write_range` is written in the
  `PS2X_VU1_DUMP` format, so `vu1_replay` reads it. The file is `<dir>/vu1_refused_<n>_<reason>_<cmd>.bin`, and each
  gets one line in `<dir>/refused.txt`: file, `entry=`, `reason=`, `cmd=`, `resume=` (vi14 at `0x33c8`), and
  `list=` (the list words from the resume index through the first `0x42`/`0x4c`). At most `<count>` files (default
  150). `<entrypc>` narrows the capture; without it any entry is taken, and today only `0x33c8` gives these reasons.
  The directory is created, unlike `PS2X_VU1_DUMP`'s.
- **Arming.** `PS2X_VU1_DUMP_AFTER=<s>` now arms this capture too. It counts seconds from the first native entry,
  about boot. The walk refuses about 3.7k of these lists a second, so without the delay the count would be spent on
  the first scene that refuses.
- **No copy per run.** The brief asked for the entry state to be buffered and then written or dropped. That is not
  needed: a whole-program refusal leaves pc, the register file and VU data memory exactly as the entry found them.
  That is the dispatcher's contract, pinned by §3's "nothing touched before the hand-back" cases. So `run()` writes
  after the hand-back, before the fallback runs. The refusal sites record (entry, reason, cmd) through
  `Vu1Refusals::rememberWhole`, whether or not `PS2X_VU1_NATIVE_REFUSALS` is on. Off, the capture costs one relaxed
  load per native entry and one per refusal. `PS2X_VU1_DUMP` now writes through the same `writeProgram`.
- **`tools_py/parity/vu1_refused_shapes.py <dir> [--entry <pc>] [--last-bone] [--quiet]`** walks each list the way
  the dispatcher runs it:
  - It steps over inline blocks (8 or 11 qwords each, the count in z).
  - It prints the `0x02` loop once, bracketed from `0x4c`'s target (the y of the qword AFTER the `0x4c`) to the
    `0x4c`.
  - It adds `y=mixed` when a culled or clipped-away primitive would read another target (§9.3).
  - It prints a table of distinct shapes: count, refusal, and the TOP+2.w/TOP+2.z seen.

  On `logs/vu1dump4` at `0x1b50` it prints seven shapes (two of family A, `68 08 10 54 18 28 42` and `68 06 08 10 54 18 28 42`, and five of the `0x02` family; research/13 §1.2's seven span `vu1dump2`-`vu1dump4`, so two of those are absent here; the review of ff3006bc). Example: `68 06 02 [0a 12 56 1a 2a 4c]`
  (12 lists). Every loop has uniform y. **[verified]**
- Tests: the `VU1Ops` rig has six cases. RED on the base (the capture API present, `run()` not offering): 2 of 41
  fail. GREEN: 41 of 41 under the test binary's defaults, with `PS2X_VU1_XGKICK_CYCLE_EXACT=0`, and with that plus
  `PS2X_VU1_FAST=1`. A planted mutation that dumps every reason fails the skin-pass case. The picker has 12 unittest
  cases on synthetic dumps. Scratch, not committed: the 25-dump differential is unchanged, `0 of 25 differ, 3 taken
  natively`, with the capture off and on (it writes 0: those refusals are `skin_pass`). Over `vu1dump5`'s 198 `0x33c8`
  entries: `0 of 198 differ, 51 taken natively`, and the capture writes 0. **[measured]**

### 9.2 What a last-bone `0x02`-family list does after the repack

- **Assumed shape.** From research/13 §4.3-4.7 and §5, a skinned world-object list is presumably
  `66 06 02 [0a (12) (56) (1a) 2a 4c]` after the `0x52`, the family-B body with the repacked vertex block standing in
  for `0x68`'s. **[inferred]** (the shape is unread: §9.4).
- **`0x02` (`0x1f70`).** It runs once: it reads TOP+2.x and TOP+2.w into the cursor `vi15` and the counter `vi12`,
  then enters the per-primitive body at `0x1f98`.
- **Per primitive.** The body does four things:
  1. It reads the index record: the three vertex offsets and the flag word, whose bit 0 is `0x06`'s.
  2. It saves the cursor to **329.z on both paths** (the delay slot at `0x1fe0`).
  3. If the primitive is visible, it stashes flag bit 1 in **112.w**, loads the triangle and calls the five-plane
     clipper `0x3618`. The clipper writes its ping-pong buffers **40-111** and leaves `vi8` (the polygon) and `vi10`
     (its count).
  4. If anything survives clipping, it writes the per-primitive GIFtag **112.x** (NLOOP = `vi10`, EOP) and
     **112.yz** (from TOP+0), then hands back to `0x1b60`.
- **The body commands.** `0x0a` kicks 423 and transforms into the staging **150..**. `0x12` fades the F lanes of
  150... `0x56` fills slot +1 of 150.. from q327, overshooting to a multiple of 3. `0x1a` lights slot +1 of 150...
  `0x2a` flushes 150.. into **113..** and kicks 423 and 112.
- **`0x4c` (`0x20c8`) stores nothing.** It decrements `vi12`, restores `vi15` from 329.z, ends the program at zero
  (`B 0x1b40`), or sets `vi14` from the qword after it and re-enters `0x1f98`. The static `0x42` is never dispatched.
- **Culled or clipped-away primitives.** These fall into `0x20c8` WITHOUT a dispatch. `vi14` is then whatever the
  last dispatch left: one past the `0x02` on the first primitive, or the target on a later one.
- The native dispatcher already runs all of this for entry `0x1b50` (`cmdWorldObject`, `primitiveLoop`, the shims),
  bit-exact on the corpus's 39 family-B lists. N1c is a proof extension, not new handlers.

### 9.3 Can the linear write proof take a loop?

**Yes, and more simply than the linear commands.** Every store the `0x02` family makes lands at a FIXED address, and
none depends on the primitive count:
- 40-111 (the clipper);
- 112 (the GIFtag);
- 113 .. 113+3·`vi10`-1 (`0x2a`);
- 150 .. about 190 (the `0x0a`/`0x12`/`0x56`/`0x1a` staging, `vi10`-bounded, `0x56`'s overshoot included);
- 329.z; 39.w (`0x72`/`0x74`); 339 (an inline block's scratch).

So the union of the body's stores is proven once and holds for every iteration, and the primitive count bounds only
the time. The proof has to:

1. **Bound the loop.** Require TOP+2.w in 1..`triangleCeiling()` as a whole-program check before the repack.
   `0x4c` tests `== 0` after a decrement, so a zero count is 65,536 primitives. `cmdWorldObject`'s clamp does this
   today, but it fires mid-list.
2. **Fix the loop's shape statically.** The list is proven unwritten (all the fixed ranges lie below q340). So:
   - The target `t` = y(`b`+1), where `b` is the `0x4c`'s index. `t` must lie after the `0x02` and at or before `b`.
   - y(`t`) and y(`i02`+1) must equal `t`, where `i02` is the `0x02`'s index. Those are the qwords a fall-in reads
     (`0x20e8`, `ILW.y 340(vi14)`), and research/13 §4.7's invariant is data, not microcode. Otherwise refuse:
     `vu1_refused_shapes` prints `y=mixed` for exactly this.
   - Any `0x30`/`0x32`/`0x34` in the body moves `vi14` by the block count in its z, read from the list. The walk
     follows it as the pre-scan does.
3. **Prove each body command's store set once** against the proof's read set:
   - the list 340-403;
   - TOP+2;
   - the packet pointers **329.x/.y** that `0x40` reads.

   `writeRangeClear` treats q329 as a whole qword. `0x02`'s 329.z store would fail it, although the proof never reads
   329.z. So the range check must become **lane-aware for q329**: allow `.z`, keep refusing `.x`/`.y`. One more
   condition: TOP+2 must not fall inside the fixed ranges (TOP of about 190 or more; the corpus's TOPs are 424 and 724).
4. **No clamp after the repack.**
   - `0x0a`, `0x12`, `0x56`, `0x1a`, `0x2a` and `0x32` each clamp `vi10` against `clippedVertexCeiling()` (12).
     `vi10` is computed at run time by the clipper, so it cannot be checked up front: it must be shown unreachable.
   - The count argument: a Sutherland-Hodgman stage that classifies each vertex once and emits the inside vertices
     plus one intersection per sign change emits at most ⌊4n/3⌋ (I + 2·min(I, O) with I + O = n). Over five stages:
     3 → 4 → 5 → 6 → 8 → 10, and 10 ≤ 12. The research/13 §2 buffer bound, 12 slots, agrees.
     **[inferred]**: `primSubroutine3618`'s emission (`0x3ad0`) must be read to confirm the one-classification
     property, and planted degenerate triangles (NaN, zero-area, on-plane vertices) tested.
   - Under a lowered test ceiling (`PS2X_VU1_NATIVE_TEST_CLIP_CEILING`) the program must refuse whole, the way
     `HeaderVertices` does today.
5. **The flag reads after the repack**, as §8.2 did for `0x06`. The clipper gates on flag state (research/13 §4.4);
   each flag read in the `0x02` path must be shown to read its own FMAC's result, landed, and not the repack's
   `ADDy.z`. **[unknown until read]**

**The linear commands.** `0x54` and `0x10` fit the existing linear walk, each one range:
- **`0x54`** (`0x05d8`) writes slot +1, the RGBAQ template from q327, of each staging triple from q40, three
  vertices an iteration. The body runs before its `IBGTZ`, so the range is
  `[41, 40 + 9·max(⌈V/3⌉, 1) - 2]` as whole qwords. Both it and `0x08` are refused from V ≥ 97, where their ranges reach q329 (`writeRangeClear` checks it too); the list itself only from V ≥ 101 (the review of ff3006bc).
- **`0x10`** (`0x0f90`) writes only the fog lane `.w` of slot +2: qwords 42 + 3k for k < max(V, 1) (an odd count
  exits after vertex a). That lies inside `0x08`'s `[40, 40 + 3·max(V, 1))`. Its reads are q28 and q29, the vertex
  block and the staging ST.w that `0x08` wrote. It has no flag read.

Both loop on TOP+2.z only, which the entry's `HeaderVertices` check already bounds.

### 9.4 What is unknown until the shapes are read

- The actual lists. The questions:
  - Is it the family-B body, or a family-C one with `0x64`/`0x32`/`0x72`/`0x74`?
  - Does a skinned `0x02` list mix the 40-base staging (`0x08`/`0x54`/`0x10`/`0x40`) with the clipper, which writes
    the same qwords? Research/13 §2 found them exclusive in the corpus.
  - What follows the `0x54` in the 145k `cmd=0x54` lists, and whether a `0x02` hides behind it?
- The primitive and vertex counts: whether any exceeds the ceilings (a whole-program refusal, not a loss).
- Whether the uniform-y invariant holds.
- Capture on one exe, knob on, then read (the controller's, a game run under the lock):

```
bash scripts/loop_lock.sh run <owner> --purpose n1c-refused -- bash logs/s17_controller/f1_stats_walk_ab.sh vu1refuse n1cdump PS2X_VU1_NATIVE_33C8=1 PS2X_VU1_NATIVE_REFUSALS=1 PS2X_VU1_DUMP_REFUSED=logs/vu1refused1:2000:0x33c8 PS2X_VU1_DUMP_AFTER=290
python -m tools_py.parity.vu1_refused_shapes logs/vu1refused1 --quiet
```

2,000 files is about 67 MB and about half a second of refusals from t=290 s, inside the sampler window. Every file
is a refused list, where `vu1dump5`'s 4,000 held none. If the table shows one scene only, a second run with a later
`PS2X_VU1_DUMP_AFTER` widens it. The picked files are also N1c's fence: goldens, then `--verify --native --regs all`,
as §8.4.

### 9.5 Size and risk

- **Size.** `0x54` and `0x10` are two cases in `proveResumedWrites` and tests, about 40 lines. The loop is larger:
  - the walk with the target and y checks;
  - the fixed-range table;
  - the lane-aware q329;
  - the whole-program primitive and clip-ceiling checks;
  - bit-exact shapes on a family-B fixture with a last-bone state grafted on (research/13's `vu1dump4` dumps carry
    the clip planes and TOP+0; `vu1dump3_prog_31` does not);
  - planted refusals.

  About 150-250 lines of code and 250 of tests: one task, one review.
- **Risk.**
  - Low for `0x54`/`0x10`: linear, with no flag reads.
  - Moderate for `0x02`, for four reasons: the clipper bound is an argument yet to be checked against the code;
    the flag reads are unread; the fall-in invariant is guest data; and a family-B hand-back is only safe whole
    (research/13 §6.3). The whole-or-nothing rule keeps a wrong proof to a refusal. A wrong admission is caught only
    by the bit-exact tests and the fence.
- **Stake.** If the lists are what §9.2 infers and native keeps §8.3's 59-65 % of the generated time:
  - `0x02`: about 21-24 ms/s saved of its 59 ms/s;
  - `0x54`: about 9-11 ms/s of 26 ms/s;
  - `0x10`: noise.
  - **[estimate]**, before the shapes are read.

  N1c is not implemented in this branch.

### 9.6 N1c's linear half: `0x54` and `0x10` admitted (2026-09-30, branch `agent/s17-n1c-linear`)

The brief named this "§9.1 the linear half". §9.1 already holds the instrument, so it is §9.6 here. Both commands
are re-derived from the microcode (`python tools_py/vu1dis.py --start 0x5d8 --count 14` and `--start 0xf90 --count 45`
over `logs/vu1dump3/vu1_prog_31.bin`) and from the native handlers (`cmdTemplateFill`, `cmdDistanceFade`), which
agree pair for pair.

- **`0x54` (`0x05d8-0x0638`).** `vi4 = 40`, `vi9 = TOP+2.z`, `vf28 = q327`, then a four-pair body: `IADDI vi9 -3`,
  `SQ.xyzw vf28` at `1(vi4)`, `4(vi4)`, `7(vi4)`, `IBGTZ vi9` with `IADDI vi4 +9` in its delay slot. With
  n = max(⌈V/3⌉, 1) passes (the body runs before the test, so V = 0 still stores once), the stores are qwords
  41 + 3j for j < 3n, whole qwords. The proof takes `[41, 40 + 9n - 2]`, which is §9.3's. It leaves `vi4 = 40 + 9n`,
  `vi9 = V - 3n` and `vf28`. It has no FMAC and reads no flag. **[verified]**
- **`0x10` (`0x0f90-0x1100`).** `vi9 = TOP+2.z`, `vi3 = TOP+4`, `vi4 = 40`, two vertices a pass. After
  `vi4 += 6` it stores `SQ.w vf14, -4(vi4)` (vertex a, `0x10c8`). Then `IADDI vi9 -2` has run, and `IBLTZ vi9, 0x10f8`
  leaves on an odd or zero count. Otherwise `SQ.w vf15, -1(vi4)` (vertex b, `0x10e0`) and `IBGTZ vi9, 0x1008`. The
  stores are the fog lane `.w` of qwords 42 + 3k for k < max(V, 1). The proof takes the whole qwords
  `[42, 39 + 3·max(V, 1)]`, which lies inside `0x08`'s `[40, 40 + 3·max(V, 1))`. Its loads (q28, q29, the vertex
  block, the staging ST and XYZF2 quads, one pair past the end) write nothing. It leaves `vi3`, `vi4`, `vi9`,
  `vf14`/`vf15`, `vf17`/`vf18`, `vf20-vf31`, `ACC.w`, `I` = 1.0 and the MAC/STATUS of its last FMAC. `MINI`/`MAX`
  set no flags. **[verified]**
- **Flags.** The whole image has six flag reads, all `FMAND`: `0x1718` (`0x06`), `0x2858` (`0x34`), `0x2fa8` and
  `0x2fd8`, and `0x3b60` and `0x3b78` (the clipper). There is no `FSAND`, `FSEQ`, `FSOR`, `FCAND`, `FCEQ`, `FCOR`
  or `FCGET` (a `grep` over the full disassembly). Neither `0x54` nor `0x10` holds one. The only flag read among the
  admitted commands is `0x06`'s at `0x1718`, which reads its own `MADDz.w` four pairs back (§8.2). `0x10`'s last FMAC
  (`0x10f0`, or `0x10b0` on the odd exit) issues 40 or more pairs before that `FMAND`, so it has landed and is older
  than the `MADDz.w`. That is the position the repack's `ADDy.z` holds in §8.2, and the reading is the same in both
  models. **[verified]** by reading and by the `66 06 08 10 40 42` shapes below, where the cull still splits the
  triangles.
- **Order.** Every proven range is a function of TOP, TOP+2 and q329 only, never of data another command wrote.
  `0x10` reads the ST.w `0x08` left, and `0x40` reads `0x06`'s flag words, but as values, not addresses. So the proof
  walks the admitted set in any order and count and needs no order check. A `0x10` with no `0x08` before it fades
  whatever the staging holds, as the microcode does.
- **Clamps.** Both loop on TOP+2.z only. The entry's whole-program `HeaderVertices` check (TOP+2.z against
  `vertexCeiling()`) covers their clamps at `0x05e0` and `0x0f90`, as it covers `0x08`'s.
- **Surprise (small).** §9.3's "the list itself only from V ≥ 101" is `0x08`'s bound. `0x54`'s fill reaches the
  list from V = 100: 34 passes, whose store at q341 lies inside the list. Both refuse from V ≥ 97 on q329 first, so
  nothing admitted changes. `0x10`'s actual stores never land on q329 (329 - 42 is not a multiple of 3), but the
  whole-qword range refuses it from V ≥ 97 too. That is conservative, and a lane-exact check would buy nothing while
  `0x08` shares the bound.

**What changed.**
- `socom2_dispatch_0x1b50.cpp`: `proveResumedWrites` admits `kCmdFade` and `kCmdTemplateFill` with the two ranges
  above. The derivation is in its comment.
- `knobs.h`: `PS2X_VU1_NATIVE_33C8`'s meaning names the admitted set (§8.3's "undersells" is fixed), and
  `docs/KNOBS.md` is regenerated.
- `vu1_ops_tests.cpp`: six shapes on the real image, each native and bit-exact against the interpreter:
  - `66 06 08 10 40 42` at V = 41 (the odd exit) and 42;
  - `54 66 06 08 40 42` at V = 40 and 96 (the largest V clear of q329);
  - `54 66 06 08 10 40 42` at V = 40 and 0.

  Where visible, `0x54`'s last store past `0x08`'s triples must hold q327, and `0x10`'s fog lanes must differ from
  the same list without it. There are five new refusals, each before any write: `0x54` at V = 97 (q329) and V = 101
  (the list), `0x54` and `0x10` against a TOP+2 at q102, and `10 66 06 08 40 42` at V = 97. `0x1b50` is unchanged on
  `vu1dump4_prog_11`'s own `68 08 10 54 18 28 42`, bit-exact.

**Evidence.** RED on the base: the six shapes handed back and the five refusals were counted as `resume_command`
(7 of 48 cases failed). GREEN: 48 of 48 under the test binary's defaults, with `PS2X_VU1_XGKICK_CYCLE_EXACT=0`, and
with that plus `PS2X_VU1_FAST=1`. A planted mutation (⌊V/3⌋ passes for `0x54`) fails the V = 97 refusal. Scratch,
not committed: `0 of 25 differ, 3 taken natively` (`vu1dump3`) and `0 of 51 differ, 51 taken natively` (the
`vu1dump5` last-bone dumps). None of them holds a `0x54` or a `0x10`, so these show only that nothing else moved.
**[measured]**

**Not known.** None of the walk's `cmd=0x54` or `cmd=0x10` lists has been seen. If one holds a `0x02` (§9.4), it is
still refused, now as `resume_command cmd=0x2` rather than `cmd=0x54`. The fence is the refused capture (§9.4) with
this branch's build. The stake stays §9.5's estimate, about 9-11 ms/s for `0x54`. **[estimate]**
