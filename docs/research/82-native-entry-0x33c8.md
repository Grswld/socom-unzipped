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

The corpus TOPs are 424 and 724 and the list sits at q340-q403: the repack's records never touch the list or the
header, but nothing in the microcode guarantees it, so native checks it (§3). **[verified]**

## 3. What was implemented (`agent/s17-n1-33c8`)

- `socom2_dispatch_0x1b50.cpp`: `vu1native_socom2_entry_0x33c8` (the six-pair test, the refusals, the repack,
  then the shared loop `runFromNextCommand`, extracted unchanged from the `0x1b50` entry), `repackSkinnedVertices`,
  `cmdFaceNormals` (`0x66`, with the triangle clamp every handler has) and `repackFits`. The pre-scan starts at the
  live-in `vi14` and admits `0x66` only for this entry (`Ctx::faceNormals`); at `0x1b50` a `0x66` is still
  `unknown_command` and a list holding one still hands back whole (a test holds it).
- Refusals, whole-program with pc left at `0x33c8` (`runtime/vu1_native_refusals.h`, appended): `skin_pass` (A),
  `repack_range` (`vi9` outside 1..256, the records wrapping VU memory or overlapping the list's 64 qwords),
  `resume_index` (`vi14` outside the list); the dispatcher's own (`xgkick_cycle_exact`, `unknown_command`, the
  header ceilings, ...) are keyed `entry=0x33c8`. Mid-list hand-backs at `0x1b60` are exact, as at `0x1b50`.
- The gate: `Vu1NativeProgram` gained an optional `enabled()`, asked after the (hash, pc) match (`ps2_vu1.h`,
  `ps2_vu1_core.cpp`); the registry's `0x33c8` row points it at `PS2X_VU1_NATIVE_33C8`, read once. Off, run()
  finds no program there, exactly as before: `no_native_entry` counted, no `native-entered` count, the generated
  code runs it.

## 4. Risk

- **The fence is three real programs.** Every (B) dump of the corpus is `66 08 40 42` from index 1 with 15-46
  vertices; the walk's (B) entries run two to two and a half times the corpus's cycles (§0 item 2's estimate), so
  bigger meshes, same code path. A
  list shape outside the corpus passes the same pre-scan rules the `0x1b50` entry applies.
- The handlers' known caveats carry over unchanged (the file's header): FMAC flags committed immediately (no FMAND
  in `0x66` or the repack), `m_cycle` not advanced (VU cycles/s under-reports by what these lists cost), the
  immediate XGKICK model required.
- Knob off, every `0x33c8` entry pays the gate: one indirect call and a static load. Knob on, (A) entries also pay
  the native call and its refusal (a few compares) before the generated code runs them.

## 5. Evidence (no build under the lock, no game, no `vu1_replay`)

- `ps2xTest/src/vu1_ops_tests.cpp`, six cases on the real image (the fixture `vu1dump3_prog_31.bin` with a last-bone
  state written over it): the gate; (B) against the interpreter (register file and VU data memory; packets too under
  the immediate XGKICK model); a zero triangle count; (A) refused as `skin_pass` with the microcode's own end state;
  six unboundable states refused under their reason; `0x1b50` unchanged. RED on a stub, GREEN on the code, and
  three planted mutations (no `MR32.w`, `OPMSUB` operands swapped, `SQ.xyz` for `SQ.xyzw` in `0x66`) each fail.
- Scratch, not committed: the same comparison over the 25 real `0x33c8` dumps, `PASS: 0 of 25 differ, 3 taken
  natively`, `skin_pass n=22 cycles=6120`, against the interpreter (`PS2X_VU1_FAST=0`) and against the generated
  code (the main tree's library), packets included. Timing of `execute()` alone, 1,000 runs, `-O3`, on the loaded
  host: `vu1_prog_128` 8.9-9.9 µs generated against 5.4-6.1 native, `141` 11.6-12.1 against 7.8-8.5, `144`
  4.7-5.6 against 2.6-3.1. **[measured]**, a scratch reading, not rung one.
- The walk's native path, for scale: `[vu1-stats]` means over the window, `host=275.1 ms/s`, `native-entered/s=14288`,
  `native-ended/s=9754`; less the fallback's 152.0 ms/s that is at most 8.6 µs per native entry (12.6 per list it
  ended) against 7.84 µs per generated `0x33c8` entry. **[measured]** from `mission.game.log`.

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
   two thirds of its entries.

## 7. Not done: (A), the `0x52` body (N2)

A native `0x52` serves both (A) and the lists refused at `0x1b50` on `0x52` (1,275 ms over the window, 18.6 ms/s).
Size: the header and branch (14 pairs), the first-pass loop (20 pairs a vertex, 4x4 and 3x3 MADD chains with the
`LOI 10.0` scale), the accumulate loop (30 pairs a vertex, the staging value pre-multiplied into ACC), the E-bit
exit; about 250-350 lines and a test like §5's. The difficulty is not size: its live-out (vi2-vi12, vf19-vf30, ACC,
I, MAC/STATUS) is read by the next MSCAL (research/15 §4.5), each MSCAL being one dump the fence compares
`--regs all`. The stake is 18.6 ms/s plus (A)'s share of the 108, 10-32 ms/s, less what native costs. Entry `0x0`
(11 % of the fallback, 1.68 M tiny entries) is not a candidate.
