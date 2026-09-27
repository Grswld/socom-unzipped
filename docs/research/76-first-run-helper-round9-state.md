# 76 -- the first-run helper: R1b's round-9 state at the Sprint 16 wrap-up

2026-09-27 22:50Z. Where Sprint 16 R1b (#70, the first-run decrypt helper `socom2_build_elf.exe`) stood when the owner asked the loop to wrap up: the branch `agent/s16-r1b` at `3d17f192` in the worktree `C:/projects/wt-s16-r1b` (kept, unmerged, unpushed; every round to 8 reviewed PASS or PASS WITH FINDINGS), the helper past extraction, the byte-exact DNAS stage and the init stage, stopped in the package stage where the ftscore body decrypt's step 2 answers 0. The implementer's state file, verbatim (addresses, digests and counts only; no disc bytes), so the next session can resume from its "next step":

---

# R1b round 9 -- the ftscore step-2 answer of 0: state at wrap-up (2026-09-27 ~22:45Z)

Branch `agent/s16-r1b`, HEAD `3d17f192` (round 9 committed nothing: the diagnosis is not finished).
No helper run and no build happened in round 9: the one queued job (build + helper run + harness experiment, below)
waited its 30 minutes behind `s16-b4`'s merged chain and timed out (`logs/r9a_lock.log`, rc 75).

## The mechanism (read from the code and the generated output)

- The package stage (`third_party/ps2recomp/ps2xRuntime/src/tools/socom2_build_elf.cpp`, `startBlob`): four guest
  calls per entry. Step 1 `0x539d00(size, kBuf 0x01000000, kOut8 0x00f00000)` parses the signed header (>= 0);
  step 2 `0x539d50(size, out8 word, kBuf)` decrypts the body in place and answers the new size (> 0); step 3
  `0x534848`, step 4 `0x535018`. Rerun 8 (controller, 22:02-22:05Z): steps 1 passed, step 2 answered 0.
- `0x539d50` is a wrapper (generated file, 0x539d50-0x539e00): it stores its arguments in DNAS globals, calls
  `0x536e60` (key setup; a negative answer is returned as is), then `0x537700` and returns ITS answer. So the 0 is
  `0x537700`'s: the body decrypt proper (0x537700-0x538dd0), which calls the key-table dispatch through `jalr`
  (0x539e00, now the kept `target_00539e00`), `0x5412a0` (a decryptor entry: the host noop), `0x53c648`, `0x53f8f0`,
  `0x540210`, `0x5415f8`, and after each `0x53d3d0` the loader's soft-float helpers (`dptoul 0x1a1150`,
  `dpmul 0x1a0c18` twice, `litodp 0x1a1330`) -- a double-precision computation.
- The harness (`tools_py/decrypt_apache.py`, the same four calls, the same BUF/OUT8/OUT4 addresses): ftscore step 1
  -> 0 with out8 0xd0b70; step 2 -> 854,896 (187 s under the trace's block hook); step 3 -> 0 (out4 0xcf779);
  step 4 -> 0; both entries inflate to the recorded sizes.

## Established (no helper run needed)

- The cdvd S-command answers are the same: the harness's `cdvd_scmd` and the helper's `cdvdAnswers` both answer
  result word 1 plus the same console ID, i.link ID, mechacon version and model name; zeros for fno 1.
- The harness's RPCs during step 2 (from its narration in `logs/trace_r8.txt`, lines 62-85): sid 0x80000593 only --
  fno 1 x4, fno 0x24, fno 0x26, fno 1 x5 (11 calls). No memory-card RPC in the whole harness run.
- The DNAS stage is byte-exact in the helper (131/131 blocks, round 7), so the DNAS code the passes run is the same.

## Differences between the harness and the helper, not yet tested by a helper run (the hypotheses)

1. **ReferThreadStatus (syscall 0x30)**: the harness has no handler -- it answers 0 and writes nothing
   (`tools_py/ee_unicorn.py:281-316`, unhandled syscalls -> 0); the runtime answers KE_OK and fills the whole
   `ee_thread_status_t` with the invocation thread's real status, entry, stack, stack size and priorities
   (`ps2xRuntime/src/lib/Kernel/Syscalls/Thread.cpp:382-415`). research/74 lists ReferThreadStatus among the
   libdnas2 syscalls (29-30 calls). GetThreadId (0x2f): harness 1, runtime the real id.
2. **The stack**: the helper's passes run with sp 0, so the scheduler gives each a 16 KB invocation stack reserved
   at the top of RAM (`ps2xRuntime/src/lib/Kernel/EeScheduler.cpp:1344-1366`, kInvocationStackSize 0x4000); the
   harness runs them on the thread's own stack (sp near 0x1fffff0, heap end 0x1f80000). Step 2's stack use is
   unknown -- the harness experiment below measures it (painting 512 KB below sp).
3. **WaitSema**: never blocks in the harness; blocks in the runtime (a block would hang, not answer 0 -- low odds).
4. **_InitSys's FindAddress loop `0x1ac9d8`**: hooked out in the harness (`decrypt_apache.py:288`); run for real in the
   helper, which installs the loader's syscall overrides (0x83 -> 0x1ac950, 0x5a -> 0x1ac0d0, both recompiled now;
   0x5b -> 0x80075000, kernel space, the runtime's built-in). Only matters if step 2 makes one of those syscalls.
5. **MCSERV `op=0 -> 0`** (three lines in the helper's stderr, two before crt0's SetSyscall note, one after): no
   memory-card RPC in the harness at all. Origin not yet known (the runtime's IOP boot, or guest code).
6. **The soft-float path** in 0x537700 (dpmul/litodp/dptoul after 0x53d3d0), recompiled vs Unicorn -- the
   numeric result feeds a size or a clock computation.

## The next step (one lock take, then one hypothesis per helper run)

1. `git apply logs/r1b_round9_trace.patch` (36 lines, not committed: `--dump-stage` also prints each cdvd RPC as
   `rpc N sid fno send recv`, and the steps' answers and out8 -- numbers only), then
   `bash scripts/loop_lock.sh run agent-s16-r1b --purpose "R1b diagnosis: rebuild the helper (step traces), run it,
   measure the harness's step 2" --class build --wait 90 -- bash logs/r9a_job.sh`.
   It rebuilds the helper, runs it with `--expect-dnas` (logs/r9a_run.err: `pass ftscore 1: ...`, the `rpc` lines,
   `pass ftscore 2: -> v0 0`), and runs the harness experiment (logs/r9a_harness.txt: step 2's syscalls with the
   harness's answers, and the stack bytes step 2 used below sp).
   CAUTION, logs/r9a_job.sh as it stands: its harness line names the session's scratchpad copy of the experiment
   (`<the session scratchpad>/harness_step2.py`), which may be gone, and it does not
   check that the patch is applied -- the PreToolUse guard refused an edit to it while s16-b4's chain held the lock.
   Before running it, change that line to `python logs/r1b_round9_harness_step2.py` (the kept copy, identical).
2. Read: (a) the helper's step-1 out8 against the harness's 0xd0b70 (a different out8 moves the failure to step 1);
   (b) how many of the 11 step-2 RPCs the helper made before its 0 (an early 0 is a setup or key check, a late one a
   final hash); (c) whether step 2 makes syscall 0x30 and what it reads back; (d) whether step 2 needs more than 16 KB
   of stack.
3. The likely fixes, in order of the evidence: give the passes the stack the harness gave them (a stack argument to
   `Driver::call` below the heap end, as the DNAS cores get `kCoreStack`); or answer ReferThreadStatus as the harness
   did for the helper's invocation thread (a helper-side syscall override, not a runtime change). Test RED first in
   `ps2xTest/src/first_run_tests.cpp`, then one helper rerun per hypothesis.

## Housekeeping done in round 9

- Byte-like lines deleted from the worktree's `logs/`: `r1b_red.log` 20 lines (10 "compressed head", 10 "inflated
  ... head"), `trace_r8.txt` 1 line (a harness `[RPC call ... data=...]`). A grep of all of `logs/` for `data=<hex>]`,
  `compressed head <hex>`, `inflated N bytes, head <hex>` and `raw=0x<hex>` now finds nothing; the remaining 8+-digit
  hex runs are addresses, digests, git hashes, CMake refs and temp-dir names (checked by sample). `first_run_trace.py`
  already silences the harness's narration (3d17f192).
- The "22 end in jr/j, five run into a kept row" claim is in 3d17f192's commit body only; no docstring or tracked file
  repeats it, so nothing in the tree needed correcting. The reviewer's figures stand: by reachability all 27 target
  rows end in a jr/j inside the row; by final words 26 do and `target_00539e00` (its tail is the key table, running
  into the kept FUN_0053a358) does not.
