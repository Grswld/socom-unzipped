# The LLE oracle -- the disc's 989SND.IRX on #254's LLE IOP, compared with our HLE

Landed 2026-09-26 (Sprint 15 Task T1c) from the spike `docs/research/70-lle-oracle-spike.md`, on the owner's word
(2026-09-26): "yes, adopt it as an oracle if it has proven value". Class S, as the note: what these files did on
that day; a later run gets a new table, not an edit of these.

## What this is

An **out-of-tree oracle**, never the product. #254's LLE IOP -- the `ps2xIOP/src/lle/` slice of
`Sinan-Karakaya/PS2Recomp` at commit `e42efbe` (GPL-3.0) -- runs the disc's own `989SND.IRX` (with `LIBSD.IRX`,
`989DSTRM.IRX` and the rest of the game's sound-path load order), with our provider serving the imports the fork's
kernel answers 0 for: `cdvdman`'s seven (read, sync, error, callback, stop, status, break), `ioman`'s four and
`sifman`'s `sceSifSetDmaIntr` (research/70 §3-§4). The replay driver feeds it the 989snd RPC sequence a real run
logged and counts where the IRX's answers differ from the ones our HLE model gave in that run. It is research/40's
comparison harness (`docs/research/assets/40-irx-differential/`, on #244's IOP) moved onto a better IOP.

| File | What | Whose |
|---|---|---|
| `harness_lle.cpp` | the harness: research/40's line protocol (`load`, `rpc`, `tick`, `peek`, `snap`) and the provider; `ORACLE_NO_PROVIDER=1` leaves the provider off | ours |
| `CMakeLists.txt` | target `lle_pristine` (the slice as shipped, from `../fork`) and target `harness_lle` (the patched copy in `lle/` plus the harness) | ours |
| `build.sh` | the build, run under the lock; writes `build.log` beside itself | ours |
| `replay_lle.py` | the replay driver: research/40's `replay.py` with its root, its title and a `--no-usb` switch changed | ours |
| `oracle-patch.diff` | our patch to five of the fork's files (`iop.h`, `iop.cpp`, `kernel.cpp`, `kernel_handlers.inc`, `spu2.cpp`): the host-import hook, deferred host work on the IOP clock, `printf` formats, the two missing `#include <cstdlib>` | ours, over the fork's: its context lines are the fork's code |
| `build-record.txt` | build 2's record: the fork commit, the date, `HARNESS EXIT 0` | the record |
| `results_lle_run_20260922_232655.md` | the mission replay's table (`logs/run_20260922_232655.log`, 16,607 calls) | the record |
| `results_lle_run_20260922_150258.md` | the menus' replay's table (`logs/run_20260922_150258.log`, 2,007 calls) | the record |
| `results_lle_run_20260922_232655_noprovider.md` | the mission replay with `ORACLE_NO_PROVIDER=1` (research/70 §9.3) | the record |
| `replay_lle_run_20260922_232655.out`, `replay_lle_run_20260922_150258.out` | the driver's console output for the two replays: every disagreeing call with the IRX's log lines (research/70 C11 reads the classes from it) | the record |

Nothing of the fork's files is here: the slice stays in a clone outside the repository (R287, research/70 §6). No
file here carries the disc's bytes: the tables quote RPC arguments and answers, as research/40's tables do.

## The numbers as of 2026-09-26

Each is the table's own line, read from the repository's root:

- **Mission, with the provider: 832 disagreements in 13,044 compared answers**
  (`grep -m1 "Compared answers" docs/research/assets/70-lle-oracle/results_lle_run_20260922_232655.md`).
  815 of the 832 are stream lifetimes on the replay's clock; at least 655 of the 699 "the IRX stopped first" polls are
  that clock's own (research/70 §9.2, §9.4). On #244's blind oracle the same replay read 12,643
  (`grep -m1 "Compared answers" docs/research/assets/40-irx-differential/results_run_20260922_232655.md`).
- **Menus, with the provider: 17 disagreements in 1,794**
  (`grep -m1 "Compared answers" docs/research/assets/70-lle-oracle/results_lle_run_20260922_150258.md`), every one in
  a class research/40 §9.1 named (research/70 §9.1).
- **Mission, no provider: 12,619 disagreements in 13,044**
  (`grep -m1 "Compared answers" docs/research/assets/70-lle-oracle/results_lle_run_20260922_232655_noprovider.md`):
  the refused-read case by execution -- 5 of 5 bank loads fail cleanly, no call spins (research/70 §9.3).

## Rebuild from a scratch clone

Everything below runs outside the repository except where a command names a repository path. `$SCRATCH` is a
directory outside the repository (the spike used one beside it); `$REPO` is the repository's root.

1. The fork, at the commit, outside the repository:
   `git clone https://github.com/Sinan-Karakaya/PS2Recomp.git "$SCRATCH/fork"` then
   `git -C "$SCRATCH/fork" checkout e42efbe` (the head of the fork's `main` and `feat/sound-and-vu-programs` on
   2026-09-26; the checkout's `git -C "$SCRATCH/fork" log --oneline -1` reads `e42efbe Merge branch
   'feat/native-iop' into feat/sound-and-vu-programs`).
2. The glue beside it:
   `mkdir -p "$SCRATCH/oracle" && cp "$REPO"/docs/research/assets/70-lle-oracle/{harness_lle.cpp,CMakeLists.txt,build.sh,replay_lle.py} "$SCRATCH/oracle/"`.
3. The patch, applied in the clone, the patched slice copied, the clone put back as shipped (the pristine target
   reads it): `git -C "$SCRATCH/fork" apply "$REPO/docs/research/assets/70-lle-oracle/oracle-patch.diff"`, then
   `cp -r "$SCRATCH/fork/ps2xIOP/src/lle" "$SCRATCH/oracle/lle"`, then
   `git -C "$SCRATCH/fork" checkout -- ps2xIOP/src/lle`. The patched copy matches the spike's `oracle/lle/` in
   content, all 11 files (checked in T1c by applying the patch to a fresh clone); byte for byte only on a clone made
   with `core.autocrlf=false` -- on an autocrlf clone the fork's files carry CRLF line endings, so the copy differs
   from the spike's by line endings alone (`diff --strip-trailing-cr` shows no difference).
4. The build, **under the lock only** (llvm-mingw, CMake and Ninja from the repository's `tools/`), from the
   repository's root with `SCRATCH` exported:
   `bash scripts/loop_lock.sh run <holder> --purpose "LLE oracle build" --class build -- bash "$SCRATCH/oracle/build.sh"`;
   `grep EXIT "$SCRATCH/oracle/build.log"` should read `HARNESS EXIT 0` (compare `build-record.txt`). `build.sh` builds
   only `harness_lle`; building `lle_pristine` reproduces build 1's two missing-include errors.
5. The replays, from the repository's root. The run logs live under the build machine's `logs/` (git-ignored; they
   are not in the tree), and the disc under its `game/` (the defaults of `--cdroot` and `--iso`):
   - `python "$SCRATCH/oracle/replay_lle.py" --log logs/run_20260922_232655.log --harness "$SCRATCH/oracle/build/harness_lle.exe" --out "$SCRATCH/oracle/results_lle_232655.md" > "$SCRATCH/oracle/replay_232655.out"`
   - `python "$SCRATCH/oracle/replay_lle.py" --log logs/run_20260922_150258.log --harness "$SCRATCH/oracle/build/harness_lle.exe" --out "$SCRATCH/oracle/results_lle_150258.md" > "$SCRATCH/oracle/replay_150258.out"`
   - `ORACLE_NO_PROVIDER=1 python "$SCRATCH/oracle/replay_lle.py" --log logs/run_20260922_232655.log --harness "$SCRATCH/oracle/build/harness_lle.exe" --out "$SCRATCH/oracle/results_lle_232655_noprovider.md" > "$SCRATCH/oracle/replay_232655_noprovider.out"`
   - then `grep -m1 "Compared answers"` on each table. Nothing a replay writes comes back into the tree except as a
     new, dated table under a new name.

## Licence

Our glue -- `harness_lle.cpp`, `CMakeLists.txt`, `build.sh`, `replay_lle.py` and the added lines of
`oracle-patch.diff` -- is under the repository's `LICENSE`. The patch carries 94 lines of the fork's code -- its 92
context lines and the 2 lines it removes -- GPL-3.0 (`Sinan-Karakaya/PS2Recomp`, its `LICENSE`); the patch as a whole is a derivative of the fork's files and
applies only to them.

## What it does not do

- **No frame stamps.** The replay advances the IOP one NTSC frame (4,920,000 EE cycles) per logged call, not per
  frame the game ran, so a stream's life on the oracle is not its life in the game. **RPC latency and the tick's
  phase against the EE frame are untested.** The next experiment is the frame-stamped replay (research/70 §7, §9.4):
  advance the IOP by the game's own frames between calls, from the run log's `[audio] 989snd stream <h>
  start|done frame=N` lines, and compare the frame at which each stem's poll first answers 0.
- Not the console: the IRX runs on an emulated IOP with our provider's timing (1 ms plus 4 MB/s per read), so a
  result here is Believed, not Proven (research/68, "the IOP host's audio path").
- Not the product: the runtime is untouched and nothing here is built by `build.sh` at the repository's root or by CI.
