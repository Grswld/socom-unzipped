# 74. The first-run decrypt -- recompile the loader's routines, or port them? (Sprint 16 R1a, the spike)

Date: 2026-09-27 (reading 06:50Z-07:20Z; the static walk, the harness sample and the recompiler run 07:05Z-07:30Z;
the compile under the lock queued 07:24Z; round 2 after the fresh review, 08:39Z; round 3 after the second
review, 09:43Z; by `date -u`). Sprint 16 Task R1a
(`docs/superpowers/plans/2026-09-27-sprint-16-tasks.md` "## Task R1a"; the facts it rests on in
`2026-09-27-sprint-16-tree-facts.md` "## Task R1a"; the spec's R1 and its Superseded blockquote). Class S, the
shape of `docs/research/14-gs-render-target-scale-spike.md`: the decision first,
then the enumeration, the cost, the outline, the open questions. A half-day box. Nothing of the disc is in the
tree: the numbers below come from the main tree's `game/disc/SCUS_972.75`, `game/disc/OVERLAY/REL/DNAS.dec.bin`,
`game/analysis/DNAS.dec.bin.functions.txt` (1,980 rows), `SCUS_972.75.functions.txt` (1,056 rows) and the two
decompilations, read in place, and from a recompiler run into the agent worktree's ignored scratch
`C:/projects/wt-s16-r1a/recomp/build/r1a/` (the scripts named in §7 live there; every number cites its command).

## Decision (short)

**RECOMPILE (route a)**, because the loader's own routines already produce the right bytes under emulation
(`tools_py/decrypt_apache.py`, 473 s of the 483 s chain, the digests of `tools_py/disc_to_elf_expected.json`) and
the project's recompiler turns exactly those routines into native code in 1.8 s with no new instruction handling:
the graph the decrypt actually executes is **329 functions** (267 of the DNAS image, 62 of the loader), the
recompiler emits a file for every one of them, and the only HLE the generated code asks for that the runtime does
not already have is the cdvd answers on two sids, `0x80000592` (fno 0) and the S-command server `0x80000593` (fno 1,
`0x24`, `0x26`), about 30 lines (§3). What enters the tree is about 890-930 lines of our own (the driver after
`decrypt_apache.py:260-353` with its 131-block pass and the four table slots of §5.2 and the scheduler invocations
of §5.3, the answers, the ELF merge, the build glue, a headless mode of the runtime's `initialize` and its test, the
packaging of a fourth binary, the DISC page's progress and the tests) and nothing vendored: the inflate is raylib's
`zsinflate()`, which the runtime already links (§6 Q3); the generated code is a build product from the developer's
disc, ignored like `recomp/output/`, so the public repository carries none of Sony's libdnas2. The port (route b)
would carry a rewrite of 2,562 decompiled lines of Sony's self-encrypted "unique"/finalize layer (12 functions, one
of them doing double arithmetic through the loader's soft-float library) into a public tree, on top of the library
primitives (SHA-1, DES-EDE3, a bignum RSA public operation) it would replace: 3,500-4,500 lines whose only oracle is
the same digests file. The recompile runs the instructions the harnesses ran once its configuration keeps the
harness's boundary -- the three SIF calls the Python hooks and the syscalls answered by the runtime, every other
loader routine the harness ran recompiled as code (§3); the port is bit-exact only when the digests say so, and the
digests say nothing about which line was wrong.

Two things the experiment found that the plan did not expect, both handled in §5-§6: the static `jal` closure
(127 functions) undercounts by a factor of 2.6 because the DNAS image is an OpenSSL derivative and calls its
primitives through method tables (`jalr`; 157 executed functions are reachable only that way), so the helper's
function set is measured, not walked; and the helper cannot be a flag on `socom2.exe` as R1b's "the runner,
`socom2.exe --build-elf`" had it, because the generated code's symbol names and the one global function table
collide with the game's (the DNAS overlay sits in zsealetc's slot at `0x4c5380`). The home is
`socom2_build_elf.exe`, a second small executable built from the runner's runtime library `libps2_runtime.a`
(beside it in CMake, as `vu1_replay.exe` is), driven by the launcher as a subprocess with progress lines, and it
needs a headless mode of `PS2Runtime::initialize`, which today opens a window, the audio device and the microphone
on every non-Vita build (§5.1; `vu1_replay.exe` never constructs a `PS2Runtime`, so it proves nothing about
running without a window, as the first draft had it). It moves two earlier sentences, the spec's "one implementation in
`ps2xShared`" and R1b's "`socom2.exe --build-elf`", and puts a fourth binary in the portable folder (§4); the
Sprint 16 plan's ruling on D3's outcome names both moves.

The D3 ruling's text for the Log: "R1's route is the recompile: the decrypt's executed set plus the static closure
(340 functions, 329 of them measured under the harness) recompiled by `ps2_recomp` from the developer's
`DNAS.dec.bin` into `socom2_build_elf.exe` from the runtime library; the player's run is the configuration the
harnesses proved -- the three SIF calls the harness hooked stay the runtime's stubs and the fifteen loader routines
it ran as code are recompiled, the 131 blocks decrypted by the four recompiled cores and checked against
`dnas.output.sha256`, then the four self-decryptors neutralised through their function-table slots -- and the raw
self-decryptors are an experiment, not the default; the cdvd answers on two sids are the one new HLE; verification
is the digests of `tools_py/disc_to_elf_expected.json` in a test that says 'skipped' where the disc is not (R222).
R1b builds it."

## 1. The question and the box

`#70`: `socom2_game.elf` must be built on the player's machine from the player's own r0001 ISO, natively, because
the ELF never ships (R290) and the player has no Python and no Unicorn. Today the chain is
`tools_py/disc_to_elf.py`: extract (8 s), the DNAS overlay's self-decrypt (`dnas_selfdecrypt.py`, 2 s, the four core
routines `0x4ef348 0x52c330 0x53acb8 0x540938` under Unicorn), the package decrypt (`decrypt_apache.py`, 473 s, the
loader's `0x534830` init then per blob `0x539d00 0x539d50 0x534848 0x535018` under Unicorn, zlib in Python), the
merge (`make_overlay_elf.py`, instant). Two routes were in the spec: (a) recompile the routines with
`ps2_recomp` into a helper linked with the runtime; (b) port them from the Ghidra decompilation onto known
primitives. The box was half a day; the bar was the route, the lines that enter, the HLE each needs, and the
verification without disc bytes.

What the recompiler needs and gives (`third_party/ps2recomp/ps2xRecomp/src/lib/elf_parser.cpp:1138-1143`,
`function_emitter.cpp:89`): a MIPS ELF in, `void f(uint8_t* rdram, R5900Context* ctx, PS2Runtime* runtime)` per
function out, calls through `runtime->dispatchGuestBranch(...)` for `jal`, `jalr` and returns (§2.3),
`runtime->handleSyscall(rdram, ctx, code)` for `syscall`, the runtime stubs named by the toml's `stubs` list reached
through the function table. `ps2xShared` may not link
`PS2Runtime` (`ps2xShared/CMakeLists.txt:1-4`), which is why the helper is not there.

## 2. Route (a), the experiment

### 2.1 The static walk (`graph.py`, §7 C1)

Over the loader ELF plus `DNAS.dec.bin` loaded at `0x4c5380`, a breadth-first walk of `jal`/`j` targets from the
five loader entries and the four self-decrypt cores, stopping at the toml's loader stubs, the Python HLE's hooked
functions (`decrypt_apache.py:126-166`) and the four self-decryptors, with the 255 key/flag constant ranges that live
inside `.text` (`decrypt_apache.py:110`, `find_encrypted_blocks`) excluded from the scans:

| walk | functions | bytes | R5900-only words | `jalr` sites | HLE hit |
|---|---|---|---|---|---|
| the 9 roots | 127 (119 DNAS, 8 loader) | 38,244 | 6 | 44 in 21 functions | 17 |
| + the loader's inflate `FUN_001ca2a0` | 144 (119 DNAS, 25 loader) | 52,412 | 122 | 77 in 31 | 17 |
| upper bound: 9 roots + every function-pointer word in DNAS data (313 targets) | 947 (916 DNAS, 31 loader) | 210,180 | 78 | 209 | 38 |

The 17 HLE hits are the loader's `cmd_sem_init`, `sceCdSyncS`, `sceCdReadClock`, `memcmp`, `memcpy`, `memmove`,
`memset`, `__muldi3`, `dpmul`, `litodp`, `dptoul`, `scePrintf`, `sceSifInitRpc`, `sceSifBindRpc`, `sceSifCallRpc`
(all names in `recomp/socom2.toml`'s `stubs` or `untracked_stubs`, where the walk stopped; which of the two lists
decides what the recompiler makes of a name, §2.2) and two of the four self-decryptors. Seven inline `syscall`
sites, six with `v1` = `0x40 0x41 0x42 0x44 0x45 0x30` (CreateSema, DeleteSema, SignalSema, WaitSema, PollSema,
ReferThreadStatus) and one whose preceding `v1` load is stale.
The 44 `jalr` sites are the reason the walk is a lower bound: the image is an OpenSSL derivative (its object-name
table is in `game/analysis/DNAS.dec.bin.strings.txt`, read in place and quoted nowhere: an RSA public-key method's
display name, the triple-DES CBC cipher under both a display name and an object name, an MD5 module's version
banner, a compression method's name and the object name of a SHA-1-with-RSA signature, among others) and EVP/RSA
methods are called through tables.

### 2.2 The measured set (`dyn.py`, §7 C2)

The harness of `decrypt_apache.py` with a `UC_HOOK_BLOCK` over both text ranges, one blob (ftscore; the second blob
runs the same code): init 4 s (crt0, `sceSifInitRpc`, `sceCdInit`, `0x534830`), the blob 236 s under the hook
(`0x539d00` 3.7 s, `0x539d50` 142.1 s, `0x534848` 3.6 s, `0x535018` 86.4 s; the recorded chain is 473 s for both
blobs without it), 2,233,472 bytes inflated, the same head as the recorded overlay.

- **329 function entries executed**: 267 DNAS, 62 loader; 61 by the end of init, 268 only after it. 116 of the 127
  static-closure functions ran. The 11 that did not are the four self-decrypt cores, one callee of each (`0x4eebb8`,
  `0x52bba0`, `0x53a528`, `0x5408d0`), `0x540660`, and the loader's `SetAlarm` and `DeleteSema` wrappers; the cores
  run under `dnas_selfdecrypt.py`'s harness, never under this one, which loads the image already decrypted (a
  correction in round 2: the first draft called all 11 error paths). **157 executed DNAS functions are outside
  the `jal` closure** (39,524 bytes, 6,233 decompiled lines): the method-table targets.
- Bytes 86,068 (75,852 DNAS); decompiled lines 13,228 (11,315 DNAS); **R5900-only words 130 in 19 functions** --
  the encodings the harness trap-patches (`ee_unicorn.py:167-196`: MMI, `lq`/`sq`, 3-op `mult`, ...) and the
  recompiler translates natively, as it does for the whole game.
- **The kernel surface after init**: SignalSema 5,478, WaitSema 5,449, PollSema 29, ReferThreadStatus 29 (the
  run's totals are 5,479, 5,449, 30 and 30: init makes one SignalSema, one PollSema and one ReferThreadStatus;
  `dyn.log`'s two `syscalls` lines) -- the libdnas2 code brackets every chunk with a semaphore. Nothing else.
- **The SIF/cdvd surface**: one bind of `0x80000592` (sceCdInit's N-command client, during init) and one of
  `0x80000593` (the S-command client); 31 calls: 30 on `0x80000593` (26 + 2 + 2), 1 on `0x80000592` (fno 0, inside
  sceCdInit). The 26 are `fno 1` from the loader's `sceCdReadClock@0x18f6e0` (a 16-byte reply; the first draft
  called them a status poll), the 2 + 2 `fno 0x24` (`sceCdReadConsoleID`) and `fno 0x26` (`sceCdMV`), issued by the
  DNAS image's own RPC wrappers. Exactly what `decrypt_apache.py:226-234` answers, and "any values work"
  (research/05 §DNAS, KNOWN §1 2026-09-27).
- **The loader's 62**: 35 carry a name in `recomp/socom2.toml`, and the list the name sits in decides what the
  recompiler makes of it -- `ps2_recomp` reads only `stubs` (`ps2xRecomp/src/lib/config_manager.cpp:69-76`) and
  turns each entry into a one-line call to the runtime's stub; `untracked_stubs` is informational, "PS2Recomp ignores
  this list" (`socom2.toml:259-260`), so its entries are recompiled as code. 18 of the 35 are `stubs` entries: the
  three SIF calls the Python hooks (`sceSifBindRpc`, `sceSifCallRpc`, `sceSifCheckStatRpc`), the four libc routines
  and three cdvd routines (`sceCdInit`, `sceCdSyncS`, `sceCdReadClock`) it ran as the loader's code, and eight crt0
  and SIF-initialisation routines (`InitThread`, `InitAlarm`, `sceSifInitRpc` and five SIF-command routines). 17 are
  `untracked_stubs` entries: `cmd_sem_init`, the seven soft-float and integer helpers (`__muldi3`, `__udivdi3`,
  `__pack_d`, `__unpack_d`, `dpmul`, `litodp`, `dptoul`), `PowerOffCB` and eight crt0 routines -- all recompiled
  in this run (the first two drafts called three of the helpers "unstubbed" and missed that all seven are). The
  other 27 carry no name there: the kernel wrappers (`CreateSema@0x1a3b20` ... `FlushCache@0x1a3da0`, each a
  `syscall` the runtime's numeric dispatch answers), four SIF register and DMA wrappers (`sceSifSetDma` to
  `sceSifGetReg`, which the recompiler stubs by their map names), crt0, and `FUN_0018e878`, the S-command client's
  bind loop, which the DNAS image calls (§3). The loader's `malloc@0x194c30` never ran: the image has its own
  allocator.

### 2.3 The recompiler run (`build_helper.py`, `ps2_recomp helper.toml`, §7 C3-C4)

The helper ELF: `make_overlay_elf.build(out, SCUS_972.75, [DNAS.dec.bin], loader_text_end=0x1d5000)` -- three
segments, entry `0x180008`, zero repairs. The config: `recomp/socom2.toml`'s `[general]` with the input, output and
map replaced, its 636 loader selectors kept (212 `stubs`, 424 `untracked_stubs`; the first drafts' 645 counted the
nine `@0x` mentions in the toml's comments), its seven loader jump tables kept, nothing of the overlays. The map:
every row of both images (`full.csv`, 3,036 rows), because `ps2_recomp` bounds a function by the next row and a
sparse map of the closure alone made `FUN_001ca2a0` (232 bytes) run on to the section end (978 errors, the first
attempt). The run: **1.8 s wall**, 3,036 functions discovered, 3,037 files, 1,854,327 lines (84 MB) for the whole
image -- the size of the DNAS overlay recompiled entire, 15 % of the game's `recomp/output` (14,880 files,
12,533,990 lines in the main tree).

| subset | files | generated lines | without blanks and comments |
|---|---|---|---|
| the 9-root static closure | 127 of 127 | 106,369 | 87,773 |
| **the executed set (329)** | 329 of 329 | **198,940** | 161,051 |
| the upper bound (947) | 947 of 947 | 487,575 | -- |

What the generated code asks of the runtime (grep, §7 C5): `runtime->dispatchGuestBranch(...)` for every call and
indirect jump -- of the 253 sites in `sub_00535018` alone, 239 are `jal` (`DirectCall`), 8 `jalr` (`IndirectCall`,
the method-table calls) and 6 returns (`JR $ra`), so a direct call also finds its callee through the function
table -- `runtime->handleSyscall(rdram, ctx, 0x0u)` for the inline `syscall`s (the number in `v1`, the runtime's
numeric dispatch `dispatchNumericSyscall`),
`runtime->eeCheckpointDue`, `runtime->SignalException`; **no `ps2_stubs::` or `ps2_syscalls::` call by name** in the
closure's files -- a call into a stub goes through the function table (issue #40, `function_emitter.cpp:250`).

The errors, triaged against the rows (`stats2.py`, `stats3.py`, §7 C6): 3,037 "unhandled instruction" errors in 53
functions across the whole image; **in the executed set, 32, and every one is a data word** -- 28 inside the
key/flag constant ranges `find_encrypted_blocks` lists and 4 of the same shape (`key, 1, key'` at
`0x537544-0x53754c` in `FUN_00536e60`, a re-encrypt trailer the scanner's pattern missed). The 32 errors sit at
**31 distinct addresses**: the log names `0x537544` twice, so the trailer is 3 distinct non-key words. Each becomes a
`throw std::runtime_error("Unhandled ...")` at a spot the real control flow jumps over. That covers the throw sites
only: the executed set's files also hold 72 `handleSyscall` sites with a non-zero code, 110 `handleTrap` and 25
`handleBreak` sites that decode as valid instructions and raise nothing when recompiled (§6 Q6). By their
disassembly comments the syscalls and the traps (`teq`/`tge` on `$zero, $zero`) are small data words; the 25 breaks
carry code 7, the compiler's divide-by-zero check.

Six functions of the helper's set (§6 Q2) also have errors *past* their row's end, every one in an unmapped gap of
`full.csv` -- the recompiler's "promoted fallback entries" after an unresolved `jr` -- at **160 distinct
addresses in six gaps**. (The distinct figures are R1b's tool's, `tools_py/first_run_recomp.py` on `agent/s16-r1b`
at f3bf8231, re-derived from the same exports and this run's log; `pastrow.py` counts the log's error lines, 175,
because the log names some addresses twice.) Five run on into the gap that directly follows their own row:
`FUN_0052af00` 70 (77 lines; 2,720 bytes from `0x52af30`), `FUN_00539d50` 25 (29 lines; 1,368 from `0x539e00`)
and `FUN_00540938` 42 (46 lines; 2,192 from `0x540a10`), key tables all three, and `FUN_00536e60` 4 (348 from
`0x5375a4`) and `FUN_0053b678` 2 (84 from `0x53b7bc`). The sixth, `FUN_004ef348` 17, is past its row but not next
to it: its row ends where `FUN_004ef420`'s begins, and the 17 sit eight rows on, in the gap `0x4efac8-0x4effb0`
(1,256 bytes) after `FUN_004ef9a0` -- the `0x4ee9e8` variant's key table (its `keytab` in
`tools_py/disc_to_elf_expected.json`), reached by the candidate scan of the unresolved `jr` at `0x4ef3d8`
(`recomp_run.log:546`, 794 promoted entries). One rule covers all six: **a boundary row at the start of every gap
a run-past's errors land in, after the gap's owner** (the `extra_functions.txt` mechanism `fix_ghidra_csv.py`
already has) -- six rows, five right after the run-past function's own row and one after `FUN_004ef9a0` at
`0x4efac8`. The set is derived from the recompiler's error log against the map, as `pastrow.py` does, never typed;
R1b's tool does so, and its classification of this run's log against the new map puts all 160 addresses inside the
six boundary rows (past-row 0): the rows cover every address. That is the same log re-read, not a re-run. Whether
the rows remove the errors -- a candidate scan is not bounded by its function's row, as the sixth shows -- is
proven only by re-running `ps2_recomp` over the new map and counting the throw sites: the tool's
`--recomp-log-after` check (exit 1 unless the count fell), which R1b owes. The loader's inflate `FUN_001ca2a0` adds
978 in the map's unmapped tail `0x1ca3cc-0x1ccf20`; only the 144-function walk holds it, and with `zsinflate()` it
is outside the helper's set. (A correction in round 2: the first draft named four functions, "in the executed
set", and "the key tables that follow them"; two of the four are closure-only cores, the inflate is in neither
set, `FUN_004ef348`'s table does not follow it, and three run-past functions were missing.) No real R5900
instruction was unhandled.

> Superseded 2026-09-27 09:58Z by R1b's real re-run (socom-pc-42, `agent/s16-r1b`: `helper.elf` built from the
> loader and the decrypted DNAS image, the derived pair with the six boundary rows, `ps2_recomp.exe helper.toml`
> 3.7 s, rc 0, "Functions processed: 3042, recompiled: 1478, stubs: 205, skipped: 1359"): the boundary rows do NOT
> remove the past-row sites. The after-log names the same 160 addresses, still attributed to the kept functions and
> now lying inside the rows' extents (the tool: "past-row + bounded: 160 -> 160 (DID NOT FALL)"). The mechanism is
> not a linear run-past a next row stops but the recompiler's indirect-jump fallback promotion ("Indirect fallback
> promotions: 544 (189524 fallback entries)"), which promotes candidate targets past any row and has no config knob.
> So the throw sites raised by the kept functions are 31 in-row + 160 promoted = 191 distinct addresses, all inside
> the kept functions' own files (`sub_00539D50`'s carries 29 `runtime_error` throws), each a resume entry real
> control flow never takes -- which the real-disc run proves or disproves (a reached throw fails the run and the
> digests). The pin is the 191; the six rows stay derived (harmless, 14-line files); marking the words as data in
> `fix_ghidra_csv` is LATER row 36. The recompiler also un-skips the callees it reaches statically from the kept set
> (`ps2_recompiler.cpp:488`, `:998`), so 1,478 functions are recompiled, not 340; a `--missing-callees` check
> (declared names without a file) guards the build.

The compile of the executed set's files against the runtime's headers (`compile.sh`, §7 C7; the flags of
`build-clang/compile_commands.json`'s Unity entry for the runner, no PCH) **did not run**: queued on the loop lock
behind two builds at 07:24Z with `--wait 30`, the wait expired at 07:54Z with the lock still held (§7 C7 has the
line). The task's rule for that case is that the count decides, and the count is that the recompiler produced a
file for every executed function with no new instruction handling and every in-row error a data word; the
generated contract is the one 14,880 files of the game already compile under (`function_emitter.cpp:89`). R1b's
first build is the proof, and it is a build R1b makes anyway.

## 3. Route (b), reading

- **The size**: the executed set is 13,228 decompiled lines over 329 functions (11,315 in DNAS); the `jal` closure
  5,439 over 127; the whole DNAS decompilation is 81,853 lines over 1,980 functions. A port is written against the
  executed set: nothing smaller decrypts a blob.
- **Which layers are known primitives**: by the string table and the constants, the library half is OpenSSL's --
  **SHA-1** runs over the body in `0x539d50` and again in `0x535018`; the header step enters no SHA-1, and no
  decompiled function carries an MD5 constant (the round constants `0x5a827999 0x6ed9eba1 0x8f1bbcdc 0xca62c1d6` sit
  in `FUN_0053ebf8`'s body, the initial values in `FUN_0053ebb8`; the review's per-step harness counted the
  transform 13,352 times inside `0x539d50`, 13,329 inside `0x535018` and 0 inside `0x539d00`). That corrects
  research/05's "RSA/MD5" label, there too, and this note's first draft, which gave the SHA-1 to the header check;
  the RSA public operation on a bignum (the largest untagged executed functions, `FUN_005286d0` 2,912 bytes with
  its forty-four `>> 0x1d` word shifts, `FUN_005273a0`, `FUN_0051cb98`); DES-EDE3-CBC chunked at 0x80
  (research/05); the EVP/OBJ/ERR plumbing around them.
  254 executed DNAS functions, 54,632 bytes, 8,740 decompiled lines are this half (`layers.py`, §7 C8: "untagged").
- **Which are the loader's own**: the 12 executed functions that carry a self-encrypted block -- `FUN_00535018`
  (5,596 bytes, 680 lines), `FUN_00537700` (4,988/567), `FUN_00538dd0` (3,596/378), `FUN_00536e60` (1,860/253),
  `FUN_00534848` (1,652/209), `FUN_0053c648` (1,508/218) and six smaller: **21,156 bytes, 2,562 decompiled lines**.
  These are the "unique" layer and the finalize, the part no library implements, protected exactly because it is
  Sony's. `FUN_00538dd0` calls the loader's soft-float `dpmul` sixteen times and reads two double tables
  (`0x5fa010`, `0x5e9340`): the layer does floating-point arithmetic.
- **The bit-exactness risk**: a port has one oracle, the digests. Ghidra shows the code through a MIPS64 lens
  (`long`, `ulong`, sign extension at every `int` boundary) and the layer's double arithmetic through soft-float
  calls whose rounding the port would have to reproduce; the DES key parity, the 0x80 chunking, the transform chain
  selected by descriptor nibbles are each a place to be off by one bit, and the digests would say only "the
  overlays differ". The recompile has the same oracle and far less to be off by, once its default configuration
  carries the harness's boundary to the loader's selectors. `decrypt_apache.py:132-166` hooks exactly three loader
  functions, `sceSifBindRpc@0x1a6aa8`, `sceSifCallRpc@0x1a6c78` and `sceSifCheckStatRpc@0x1a6e68`, plus the
  syscalls; everything else ran as the loader's own code. So the helper toml keeps those three selectors and, by one
  rule, drops the names of the fifteen executed loader functions the harness ran as code that `socom2.toml` names:
  the four libc (`memcpy`, `memset`, `memcmp`, `memmove`), the seven soft-float and integer helpers (`dpmul`,
  `litodp`, `dptoul`, `__muldi3`, and `socom2.toml:397,406,407`'s `__udivdi3@0x0019F8B8`, `__pack_d@0x001A0760`,
  `__unpack_d@0x001A0838`) and the four cdvd and semaphore routines (`cmd_sem_init`, `sceCdInit`, `sceCdSyncS`,
  `sceCdReadClock`). Seven of the fifteen change the generated code: the four libc and the three `sceCd` routines
  are `stubs` entries (`socom2.toml:57-58,65,105-108`), which this run turned into one-line stub calls. The other
  eight are `untracked_stubs` entries, which `ps2_recomp` does not read (§2.2), and this run already recompiled
  them -- `FUN_0018df80`'s file is `cmd_sem_init`'s 261-line body, `dpmul`'s is 781 lines, as in the game's
  `recomp/output` -- so their drop is the rule's guard against a derivation that ever moves them into `stubs`, not a
  change. The guard matters for `cmd_sem_init`: it is not a name in
  `third_party/ps2recomp/ps2xRuntime/include/ps2_call_list.h`, so as a `stubs` entry the recompiler would emit
  `ps2_stubs::TODO_NAMED("cmd_sem_init")`, a no-op (`ps2xRecomp/src/lib/ps2_recompiler.cpp:1195-1205`), where the
  body creates the cdvd semaphores at `DAT_001ca860/868/86c/870` (-1 in .data). The S-command wrapper
  `FUN_0018e878` has no name in the toml, is recompiled, and is what the DNAS image calls for the console ID and the
  MV (`func_0x0018e878(0x24)`/`(0x26)`, lines 66375, 66414, 73001 and 73040 of its decompilation): it calls
  `cmd_sem_init`, then `PollSema(DAT_001ca86c)`, and proceeds only on that id (`SCUS_972.75.decomp.c:8278-8290`) --
  with the no-op, `PollSema(-1)` is `KE_UNKNOWN_SEMID`, the wrapper returns 0 and the identity read returns 0 without
  any RPC, a path no harness ran. The three `stubs` drops matter by what the stubs do: `sceCdInit`'s sets
  `cd.initialized` only (`Kernel/Stubs/CD.cpp:463-472`) where the body sets the cdvd globals, stores
  `uRam001d5f98 = GetThreadId()` for the wrapper's `ReferThreadStatus`, and binds and calls the N-command server;
  `sceCdReadClock`'s writes the host's local time (`CD.cpp:582-610`) where the harness's `fno 1` reply was zeros,
  and the DNAS image turns the clock into a time (`FUN_00507300`, decompilation lines 41840-41862), stores it in a
  session struct (47250) and mixes it into a pool (31434) -- unproven with a 2026 clock. With those bodies
  recompiled, the runtime's one new HLE answers what the Python answers: sid `0x80000592` fno 0 with zeros
  (`decrypt_apache.py:160-161`) and `0x80000593` fno 1, `0x24` and `0x26` (and `0x22`, `0x0c`) with result word 1
  and the payload. The rest is there: the binds already succeed (`Kernel/Syscalls/RPC.cpp:313-335` allocates a
  dummy server and writes `client->server`, on which the loader's loop at `SCUS_972.75.decomp.c:8293-8305` spins),
  the numeric dispatch has `0x2F`, `0x30`, `0x40`-`0x45` and `0x64` (`Kernel/Syscalls/Dispatcher.cpp:117-257`), and
  an unserved sid returns `{}` (`ps2xIOP/src/iop_subsystem.cpp:282-287`). `sceSifInitRpc` and the SIF-command
  routines keep their `stubs` entries: the runtime answers SIF at the RPC calls, the game's own path, where the
  harness answered one level down, at the SIF register and DMA syscalls (`decrypt_apache.py:133-139`); the binds
  and calls reach the three kept selectors either way. What stays different, and is caught only by the digests:
  the harness registered no handler for syscall `0x30` (`tools_py/ee_unicorn.py:311-315` maps `0x23`, not `0x30`),
  so its 30 `ReferThreadStatus` calls (29 after init) got v0 = 0 and an unwritten struct where the runtime writes a
  real `ee_thread_status_t` (`Kernel/Syscalls/Thread.cpp:382-416`); and `WaitSema` never met a zero count under the
  harness (no `would block` in the verbose `dyn.log`), so on the same inputs the runtime's blocking path is never
  entered, and a block on the single invocation thread would hang rather than fail (§5.3's timeout).
- **The public tree**: a port puts a readable rewrite of the protected layer into a public repository; the
  recompile keeps it a build product of the developer's own disc, like the game (R290's line: the exe ships, the
  ELF never does, and neither does its source).

## 4. The cost: what enters the tree

| route | lines that enter the tree | generated (ignored, a build product) | the HLE it needs |
|---|---|---|---|
| (a) recompile | **about 850-890 lines** of ours (about 890-930 with the packaging row below): the driver after `decrypt_apache.py:260-353` (~120: load the loader's segments and `DNAS.BIN` into rdram, `gp`/`sp`, init, four calls per blob, inflate, write), the scheduler path those calls run on (~60-100: `EeScheduler::reset` and `run()` on the helper's thread, one `HleCall` invocation per guest call with its `onComplete` and a timeout, §5.3), the 131-block pass (~60: `find_blocks`/`skip_list` after `dnas_selfdecrypt.py:66-99`, the four cores' calls, the `dnas.blocks` and `dnas.output` checks, §5.2), the four self-decryptors' table slots (~15, after `decrypt_apache.py:117-123`), the cdvd answers on two sids (~30), the identity constants (3 lines, `decrypt_apache.py:175-177`), the inflate through raylib's `zsinflate()` (~10, §6 Q3), the ELF merge after `make_overlay_elf.build` (~80), the helper toml derived from `socom2.toml` by a script, with the fifteen names of §3 dropped (~40), `build.sh`'s step (~30) and the CMake target (~40), the headless mode of `PS2Runtime::initialize` (~30 in the runtime) and its `ps2xTest` case (~30, §5.1), the DISC page's subprocess and progress (~100), the tests (~200); nothing vendored | 216,108 lines for the helper's 340 (the executed 329 plus the static closure's other 11, §6 Q2), 198,940 for the 329 alone (161,051 code), 487,575 for the upper bound, 1,854,327 for the whole image; 1.8 s to generate | **SIF**: `sceSifInitRpc`/`BindRpc`/`CallRpc`/`CheckStatRpc` are the runtime's stubs already (`ps2_call_list.h:92,533-549`), and the binds succeed (`Kernel/Syscalls/RPC.cpp:313-335`), 0 new. **cdvd**: answers on two sids, ~30 new lines behind `PS2IopTransport::handleRpc` -- the N-command server `0x80000592`'s fno 0 with zeros (`sceCdInit`'s body, recompiled) and the S-command server `0x80000593`'s `fno 1` (`sceCdReadClock`'s body), `0x24`, `0x26` (and `0x22`, `0x0c` as the Python has them) with result word 1 and the payload; nothing in `ps2xIOP/src/modules` answers either sid today, and an unserved sid returns `{}` (`ps2xIOP/src/iop_subsystem.cpp:282-287`, §3). **kernel**: CreateSema/SignalSema/WaitSema/PollSema/ReferThreadStatus/FlushCache exist as `ps2_syscalls::` and the numeric dispatch, 0 new; the fifteen loader routines the harness ran as code -- libc `memcpy`/`memset`/`memcmp`/`memmove`, the seven soft-float and integer helpers, `cmd_sem_init` and the three `sceCd` routines -- are recompiled from the loader rather than stubbed (§3, §6 Q5), 0 new |
| (a) packaging | **about 40 lines**: `scripts/make_portable.sh:146-151` checks for and copies three binaries (`socom2.exe`, `socom2_game.elf`, the launcher) and the helper is a fourth -- the check and the copy, the import-closure audit's list of executables (`portable_audit.py closure`, line 154), `SHA256SUMS`, the Linux branch, and the tests that pin the folder (`test_make_portable*`, `test_portable_folder`) | none | none |
| (b) port | **3,500-4,500 lines** of ours: the protected layer's 2,562 decompiled lines rewritten (~1,800 C++), SHA-1 (~200), DES-EDE3-CBC (~400), a bignum with the RSA public operation (~800, or vendored), the signed-container parse and EVP glue (~300), and the same driver, merge, DISC page and tests as (a) minus the guest memory model (~500); plus the same ~10-line `zsinflate()` call, reached through the launcher's raylib (`ps2xShared` links none) | none | none: no SIF, no cdvd and no kernel answer -- the console identity is three constants and the semaphores go away with the guest; the price is that every one of those 3,500-4,500 lines is a place to be off by one bit |

Neither route touches the launcher's tested core beyond the DISC page; both keep `tools_py/disc_to_elf.py` as the
developer's chain and the oracle's producer.

## 5. The outline (R1b)

1. **The helper's home: `socom2_build_elf.exe`**, a second executable from `libps2_runtime.a` (6.3 MB static) plus
   the helper's generated code plus a `main` of the driver; it ships in both archives (§4's packaging row).
   `vu1_replay.exe` is a precedent for one thing only: a second executable linking the runtime library, built
   beside it in CMake (`ps2xRuntime/CMakeLists.txt:601-602`). It constructs a `GS` and a `PS2Memory`
   (`vu1_replay.cpp:1004-1008`) and never a `PS2Runtime`, so neither its windowless run nor its 3.1 MB says anything
   about the helper (the first draft leaned on "the shape of `vu1_replay.exe`" for both). The helper constructs a
   `PS2Runtime`, and `PS2Runtime::initialize` (`ps2_runtime.cpp:775-860`) calls `SetConfigFlags` and `InitWindow`
   (806, 810), `SetExitKey` (814), the move-loop hook (822), `InitAudioDevice` (828) and
   `startHostMicFromEnvironment` (839) on every non-Vita build, with no headless, hidden or offscreen path in the
   file. So the helper needs **a headless mode of `PS2Runtime::initialize`** (the Sprint 16 plan's ruling of
   2026-09-27 08:42Z on the helper's headless runtime): taken by an explicit argument the helper's `main` passes,
   off by default, it keeps `m_memory.initialize()` and `syncCoreSubsystems()` (the IOP transport and the SIF RPC
   path the decrypt needs) and skips the window, the exit key, the move-loop hook, the audio device, the microphone
   and the debug UI; one `ps2xTest` case shows a headless runtime reaching the SIF bind of `0x80000593` with no
   window. About 30 lines in the runtime and 30 in the test (§4). Not `socom2.exe --build-elf`: the game's
   `recomp/output` already has `FUN_00534830_0x534830.cpp` and `memcpy_0x195800.cpp` (zsealetc's and the
   loader's), the generated table is one global `g_ps2RecompiledFunctionTable[]` read by
   `PS2Runtime::lookupFunction` (`ps2_runtime.cpp:1221-1233`), and the
   registration file defines it -- two images in one link collide by name and by table (§6 Q1 has the alternative).
   Not `ps2xShared`: the generated contract needs `PS2Runtime`. Not a "minimal context": the stubs and syscalls
   are free functions over `PS2Runtime`'s state (`m_libcRuntimeState`, `m_cdRuntimeState`, ...), so a fake would be
   the runtime again.
2. **The build**: `build.sh recomp` runs `ps2_recomp` a second time over `helper.toml` (derived from `socom2.toml`
   by `tools_py/revision_toml.py`'s pattern: the loader selectors and jump tables carried across less the fifteen
   names of §3 -- 621 of the 636 selectors (R1b's tool prints 630, the same count with the nine comment mentions of
   §2.3), the three SIF selectors kept -- the input the helper ELF that `make_overlay_elf.build` wraps from
   `game/disc/SCUS_972.75` and `game/disc/OVERLAY/REL/DNAS.dec.bin`, the map `full.csv` from the two Ghidra exports
   with the six boundary rows of §2.3 (one rule, derived from the recompiler's error log, never typed), the `skip`
   list everything outside the helper's 340, the executed set plus the static closure) into
   `recomp/output_helper/` (ignored); the `dnas` stage of `disc_to_elf.py` stays as the developer's producer of
   `DNAS.dec.bin` (2 s, once), so the recompiler's input is the decrypted image. **The player's run is the
   configuration the harnesses proved**: the driver loads `DNAS.BIN` raw at `0x4c5380`, decrypts its 131 blocks
   in guest memory by calling the four recompiled cores (`0x4ef348 0x52c330 0x53acb8 0x540938`) with the
   parameters `find_blocks` and `skip_list` compute (ported from `dnas_selfdecrypt.py:66-99`), checks the image
   against `dnas.blocks` and `dnas.output.sha256` (an intermediate digest the player's run gains), then neutralises
   the four self-decryptors through their function-table slots with a native no-op that writes the "decrypted"
   flag, as `decrypt_apache.py:117-123` does. The slot is the one
   place to swap: a generated `jal` reaches its callee through `dispatchGuestBranch` and the table (§2.3). No
   Unicorn stage exists on the player's machine. The raw path -- `DNAS.BIN` loaded and the recompiled
   self-decryptors left to run for real over the guest copy, as the first draft had it -- is unproven, because no
   harness has ever run the self-decryptors' bodies: `decrypt_apache.py` replaces them with that no-op,
   `dnas_selfdecrypt.py` calls only the cores with parameters Python computes, and `graph.py` stops its walk at
   them. The 329 holds `0x53a358` and `0x5412a0` only because the block hook fires on the trap planted at their
   entries (`ee_unicorn.py:760-768`), and the union set (340, §6 Q2) lacks their helpers `0x53a430`, `0x53a590`,
   `0x541378` and `0x541430`, so a raw `DNAS.BIN` would stop at `lookupFunction`'s miss. The raw path is an
   experiment, and it needs the set widened to 344 functions (220,778 generated lines).
3. **The driver** (`socom2_build_elf.exe "<iso>" --out <dir>`): the three files read out of the ISO through
   `ps2xShared`'s `iso9660` reader (no 4.2 GB extraction) -- not `findRootFile`, which walks the root directory
   only (`iso9660.h:25`), while `DNAS.BIN` and `APACHE00.ZDB` sit in subdirectories, but R1b's planned `findFile`
   (`findFile(read, "OVERLAY/REL/DNAS.BIN", out)`, the port of `tools_py/iso_lbn.py:24`'s `parse_dir`; the tasks
   plan's "## Task R1b") and `readFile` -- each pinned by the `inputs.*.sha256` of
   `tools_py/disc_to_elf_expected.json` before anything runs (exit 67 where it differs, 66 where the image is not
   there, as `disc_to_elf.py:63-74`); rdram from the runtime (headless, §5.1), the loader's PT_LOADs and
   `DNAS.BIN` at `0x4c5380`, the 131-block pass with its two checks and the four table slots (§5.2), `gp` from
   `.reginfo`, `sp` at the top; `sceSifInitRpc(0)`, `sceCdInit(0)`, `0x534830()`; per ZDB entry
   (`zdb_entries`, `decrypt_apache.py:237-248`) the four calls with the same checks and sentences as
   `decrypt_blob`; inflate (`zsinflate()`, §6 Q3); the merge after `make_overlay_elf.build` with
   `recomp/loader_text_end.txt`'s value; `socom2_game.elf` written through R1b's `writeVerified(path, bytes, sha)`
   (the tasks plan's "## Task R1b"): under a temporary name beside the exe, renamed to the final one only after its
   sha256 matches `elf.sha256` (exit 68 where it differs), so every risk §3 names is caught before any file carries
   the final name.
   The guest calls run on the scheduler's executor, never straight from `main`: generated code unwinds at every
   due checkpoint (`dispatchGuestBranch` returns false, `ps2_runtime.cpp:1476-1480`) to the loop that services the
   scheduler's events and re-enters at `ctx->pc`, `EeScheduler::run()` (`Kernel/EeScheduler.cpp:174`), and
   `WaitSema`/`SignalSema`/`PollSema` reach `EeScheduler::waitSemaphore` and its siblings, which `assertExecutor()`
   and assert a current guest thread (`Kernel/EeScheduler.cpp:1053-1119`), so `lookupFunction(0x539d00)(rdram,
   ctx, runtime)` from the helper's own thread is not a call that returns finished (on a scheduler nobody has reset
   it gets past the asserts only through `bindMainContextForSyscall`'s lazy reset, lines 1703-1722, and then leaves
   at the first due checkpoint); the helper's thread takes the executor with `EeScheduler::reset` and runs
   `EeScheduler::run()`, as `PS2Runtime::run()` does on its game thread (`ps2_runtime.cpp:2640-2641`), each guest
   call a `GuestInvocationKind::HleCall` invocation queued with `queueInvocation` and an `onComplete` that reads v0
   (`include/runtime/ee_scheduler.h:84-105, 362-365`), under a timeout, because a `WaitSema` block on the single
   invocation thread would hang rather than fail (§3); `PS2Runtime::run()` itself cannot be reused headless, since
   it makes a raylib texture (`ps2_runtime.cpp:2600-2660`), and R317's headless `ps2xTest` case passes only through
   this path, since the bind of `0x80000593` it asserts happens inside the recompiled `FUN_0018e878`.
   Time: the belief is seconds -- the emulated 3DES pass over 855 KB took 142 s, the native one is milliseconds;
   the run is bounded by reading 2.4 MB out of the ISO and inflating 4 MB.
4. **How the DISC page drives it**: a subprocess, the way the launcher already starts the runner, through the
   `Worker` of `ps2xLauncher/src/main.cpp:324-371` (one request off the UI thread, polled); the helper prints
   `progress <stage> <done>/<total>` lines on stdout (`extract`, `init`, `ftscore 1/4` ... `zsealetc 4/4`,
   `inflate`, `merge`, `verify`), the page's verdict panel (`page_disc.cpp:22-33`) gains the bar and the sentence,
   the lamp goes green on exit 0 with the digest line; exit 68's sentence becomes "the program image is not built
   yet: open the DISC page" (spec §2 R).
5. **The verification, without disc bytes**: `tools_py/disc_to_elf_expected.json` unchanged as the oracle --
   `overlays.ftscore.bin.sha256`, `overlays.zsealetc.bin.sha256`, `elf.sha256`, `elf.size`, `elf.entry`,
   `elf.segments` and the build id must match what the helper writes; `dnas.blocks` and `dnas.output` stay the
   Python stage's record and are now checked by the helper too, in memory, after its 131-block pass (§5.2; it
   writes no `DNAS.dec.bin`). A test `tools_py/tests/test_first_run_decrypt.py` runs the helper where
   `game/disc` (or `PS2X_CD_IMAGE`) exists and prints `first run: skipped -- no disc` where it does not, the
   console-replay pattern (R222); the container parse (the 0x580 signed header, the ZDB entry walk), the exit codes
   and the progress states are tested from fixtures that hold no disc bytes (a synthetic ZDB, as
   `test_disc_to_elf.py` builds a synthetic ISO). The generated `throw` sites are asserted to be exactly the 31
   known data-word addresses (§2.3; the in-row ones, the same 31 over the whole 340-function set), and beside them
   the map's boundary rows are asserted to be exactly the six gap addresses `0x4efac8`, `0x52af30`, `0x5375a4`,
   `0x539e00`, `0x53b7bc` and `0x540a10` (derived by R1b's tool from the recompiler's log, pinned by the test), so a
   real unhandled instruction can never hide among them; the pin covers
   throw sites only, not the syscall, trap and break sites that decode as valid instructions (§2.3), which the
   digests alone answer for. The r0004 served package (#71, R2) goes through the same helper and records its own
   digests.

## 6. Open questions, each with a default

- **Q1 the home, if two executables are one too many.** Default: `socom2_build_elf.exe` (§5.1). The alternative
  is `socom2.exe --build-elf` with the helper's map names prefixed (`dnas_FUN_...`, the map's Name column is ours),
  the table symbol made an option of `function_table_emitter.cpp` and `lookupFunction` reading a pointer that
  `--build-elf` points at the helper's table: about 30 lines of tool and runtime change instead of a CMake target.
  Its risk either way was `PS2Runtime` without a window, and the runtime does insist on one (§5.1): the headless
  mode of `PS2Runtime::initialize` is needed by either home (the first draft's "the helper runs hidden the way the
  bare run does" named a path `ps2_runtime.cpp` does not have). *Review:* agreed.
- **Q2 which functions to recompile.** Default: the executed set plus the static closure (340 functions, 216,108
  generated lines, 1.7 % of the game's), everything else in `skip`; the static closure brings the four self-decrypt
  cores and their callees, which the player's run calls (§5.2) and `decrypt_apache.py`'s harness never runs. An
  unknown target is `lookupFunction`'s existing "No exact recompiled function" sentence and a non-zero exit, and the
  inputs are fixed bytes (the r0001 disc, the served r0004 package, three constant identity values), so the
  executed set is the whole path; the upper bound (947, 487,575 lines) or the whole image (1,854,327 lines, 15 % of
  the game's compile) buys nothing the digests do not already prove. *Review:* kept -- the 329 is identical over
  r0001's two blobs and the served r0004 package (0 extra, 0 missing); widen, to the 344 of §5.2, only if the raw
  path stays.
- **Q3 the inflate.** Default: no vendored inflate. raylib 5.5 is fetched in `ps2xRuntime/CMakeLists.txt:46-52`,
  reaches `ps2_runtime` through `ps2_host_backend` (lines 107 and 506), is built with `SUPPORT_COMPRESSION_API 1`
  and exports `zsinflate()` (the zlib-wrapped stream, what the Python's `zlib.decompress` reads) and
  `DecompressData()` (`rcore.c:2485`); it is Zlib-licensed and already has its `THIRD_PARTY_NOTICES.md:30` row. About
  10 lines call `zsinflate`. The alternative, the loader's own `FUN_001ca2a0`, needs map rows for the unmapped
  `0x1ca3cc-0x1ccf20` and was never exercised (the Python does the inflate), so it is the one part of the loader's
  path the harness has not proven. *Review:* overturned for `zsinflate` -- the first draft's default was to vendor
  zlib's `contrib/puff.c` or `tinf` (800-1,000 lines) in `ps2xShared` with a new notices row.
- **Q4 the DNAS stage on the player's machine.** Default: the 131-block pass with the four recompiled cores,
  checked against `dnas.blocks` and `dnas.output.sha256` in memory, then the four table slots (§5.2); no
  `DNAS.dec.bin` written and no Unicorn. `DNAS.dec.bin` stays the recompiler's input on the developer's machine and
  `disc_to_elf_expected.json`'s `dnas.*` rows stay as they are, now checked on both machines. *Review:* overturned
  for the proven configuration with the checked `dnas.output` digest -- the first draft's default was no stage at
  all, `DNAS.BIN` loaded raw with the recompiled self-decryptors left to run, the path no harness has run.
- **Q5 the soft-float helpers, and the rest of the loader's code.** Default: §3's rule, the harness's boundary
  carried to the selectors -- the three SIF selectors the Python hooks (`0x1a6aa8`, `0x1a6c78`, `0x1a6e68`) stay,
  and the fifteen loader routines it ran as code are recompiled, their names dropped from the helper toml. For the
  seven soft-float and integer helpers (`dpmul@0x1a0c18`, `litodp@0x1a1150`, `dptoul@0x1a1330`,
  `__muldi3@0x19eb18`, `__udivdi3`, `__pack_d`, `__unpack_d`) that is already so: they are `untracked_stubs`
  entries, which `ps2_recomp` does not read (§2.2), so this run and the game's own `recomp/output` carry their
  bodies (`dpmul_0x1a0c18.cpp`, 782 lines, in the game's) and `FUN_00538dd0`'s doubles are computed as the PS2
  computed them; the drop keeps any derivation from making them stubs. The selectors the rule actually changes are
  the seven `stubs` entries of §3, the four libc and the three `sceCd` routines. *Review:* agreed -- the harness ran
  the loader's own `dpmul`/`litodp`/`dptoul`/`__muldi3` (the Python hooks none of them), and `docs/KNOWN.md:88`
  records that soft-double stubs were once bound with the wrong ABI. *Round 3:* the first two drafts had the four
  as stubbed selectors to drop, "the game keeps its native stubs" and "if the digests match with the stubs in place
  ... may stay"; there are no such stubs, in the helper or the game.
- **Q6 the map's data words.** Default: accept the 32 dead `throw` sites, at 31 distinct addresses, and pin the 31
  by address in the test (§5.5; throw sites only, §2.3); the six boundary rows of §2.3, one rule for the six
  run-past functions of the helper's set (a row at the start of every gap a run-past's errors land in, after the
  gap's owner), derived from the recompiler's log and pinned by their six addresses beside the 31; that the rows
  remove the 160 past-row errors is R1b's re-run to show (§2.3). The alternative -- rows that mark the key/flag
  words as data so the recompiler skips them -- is `fix_ghidra_csv.py` work the game would also want
  (`recomp/output` has the same 131 blocks in zsealetc's image) and belongs to LATER. *Review:* agreed, with 31.
  *Superseded 2026-09-27 09:58Z (§2.3's blockquote): the rows do not remove the 160 promoted sites; the pin is the
  191 distinct throw addresses, the data-marking is LATER row 36.*
- **Q7 the card path.** Default: not built. `decrypt_apache.py:15-18`'s card path (only `0x534848` and `0x535018`)
  is for a package that came off a memory card; the served r0004 package is the disc-path form (KNOWN §1
  2026-09-27), so #71 needs nothing the disc path does not. *Review:* agreed.

## 7. The commands (the scripts live in the worktree's ignored scratch `C:/projects/wt-s16-r1a/recomp/build/r1a/`)

- C1 the static walk: `python recomp/build/r1a/graph.py` -> `graph.log` (the three walks, the decomp line sums,
  `graph.csv`, `graph_upper.csv`, `full.csv`, `graph.json`); the R5900 predicate is `tools_py/ee_unicorn.py`'s
  `EE._needs_emulation`, the excluded ranges `tools_py/decrypt_apache.py`'s `find_encrypted_blocks`.
- C2 the measured set: `python recomp/build/r1a/dyn.py > recomp/build/r1a/dyn.log 2>&1` (one blob, ~4 min;
  `dyn.json`: `executed`, `init`, `syscalls`, `rpc`); the RPC tally `grep -c "\[RPC call" dyn.log` = 31.
- C3 the helper ELF and config: `python recomp/build/r1a/build_helper.py full.csv` (`helper.elf`, `helper.toml`).
- C4 the recompiler, in Git Bash: `cd recomp/build/r1a && PATH="/c/Projects/socom_pc/tools/llvm-mingw/bin:$PATH"
  C:/Projects/socom_pc/third_party/ps2recomp/build-tools/ps2xRecomp/ps2_recomp.exe helper.toml > recomp_run.log`
  (1.8 s; `grep -n "Functions discovered" recomp_run.log` = 3036; `ls output | wc -l` = 3039;
  `cat output/*.cpp | wc -l` = 1854327). The first draft wrote the PATH entry as `C:/Projects/...`, which bash
  splits at the drive's colon, so `ps2_recomp.exe` found no `libunwind.dll` and exited 127.
- C5 the counts: `python recomp/build/r1a/count.py` (files, lines, `ps2_stubs::`/`ps2_syscalls::`/`handleSyscall`/
  `lookupFunction` per subset); `grep -o "runtime->[a-zA-Z]*(" output/sub_00535018_0x535018.cpp | sort | uniq -c`.
- C6 the triage: `python recomp/build/r1a/stats2.py` (errors against row extents, the dynamic set against the
  closure, code-only lines) and `python recomp/build/r1a/stats3.py` (the 32 in-row words against the data ranges,
  the executed set's 130 R5900-only words); `grep -c 537544 recomp_run.log` = 2 (the 31 distinct addresses);
  round 2's `python recomp/build/r1a/pastrow.py` (the 340-function set's errors, in-row 32 at 31 distinct, and
  each past-row error placed in the row or unmapped gap of `full.csv` that holds it: the six functions of §2.3;
  it counts error lines, 175, where R1b's tool counts the 160 distinct addresses).
- C6b round 3's stub lists, in `recomp/build/r1a/`: `wc -l output/FUN_0018df80_0x18df80.cpp
  output/sub_001A0C18_0x1a0c18.cpp` = 261 and 781 (`cmd_sem_init` and `dpmul`, bodies); `grep -c "ps2_stubs::"
  output/FUN_00195800_0x195800.cpp output/FUN_0018ea98_0x18ea98.cpp` = 1 each (`memcpy`, `sceCdInit`, 14-line
  stubs); every one of the 62 executed loader functions in `dyn.json` classified against the toml's two lists: 18
  `stubs` files are 14-line stub calls, 17 `untracked_stubs` files are bodies; the toml's `[general]` holds 647
  `name@0x...` selectors, 636 below the loader's text end, and nine more `@0x` in its comments.
- C7 the compile under the lock: `bash scripts/loop_lock.sh run agent-s16-r1a --purpose "build: R1a helper compile"
  --class build --wait 30 -- bash recomp/build/r1a/compile.sh > recomp/build/r1a/compile.log` (329 files, `-c`
  each in Unity batches of 48, the runner's flags without the PCH). Outcome: **did not run** -- `compile.log`:
  `[loop_lock] TIMEOUT waiting for lock (1800 s, 27 attempt(s)): agent-t1b-review taken 27 min ago ... lock run
  exit 75`, at 07:54Z; the lock was held by another session's build for the whole wait, the box said skip and let
  the count decide, and §2.3's count is the decision's evidence. R1b's first build compiles these files; the script
  and its batches are in the scratch for it.
- C8 the layers: `python recomp/build/r1a/layers.py` (self-encrypt-protected vs untagged, the largest sixteen).
- The main tree's game output for scale, read-only: `ls C:/Projects/socom_pc/recomp/output/*.cpp | wc -l` = 14880;
  `cat C:/Projects/socom_pc/recomp/output/*.cpp | wc -l` = 12533990; `ls -la .../build-clang/ps2xRuntime/*.a *.exe`.
- The test of this note: `python -m unittest tools_py.tests.test_decrypt_spike_note`.
