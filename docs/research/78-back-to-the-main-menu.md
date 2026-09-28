# 78. How SOCOM II goes back to the main menu (Sprint 17 Q0)

Date: 2026-09-28, the runs 03:2xZ–06:5xZ, this reading 07:07Z (by `date -u`). Sprint 17 Task Q0
(`docs/superpowers/plans/2026-09-27-sprint-17-tasks.md` "## Task Q0"). Class S by location. One exe for the trace,
`dist/socom2.exe` sha256 `2430919f…` (Sprint 16's batch-4 build; the player-kind `dist-release/portable/socom2/socom2.exe`
`f3276760…` for run 10). Every number carries the command in §6. Nothing of the disc is here; the decompilation is
read under `game/` and cited by address.

## 0. The answer

**Leaving SOCOM Online is a deliberate self-restart of the game, not a crash.** In the lobby, TRIANGLE opens "You will
be logging off of SOCOM II Online. Are you sure you want to do this?" with NO selected; LEFT selects YES; CROSS makes
the game tear down its sound system and its network socket and then call the SDK's own `LoadExecPS2` wrapper
(`0x1ACE88`) from `0x22ED54` with the arguments already prepared:

```
[call] 109.4s LoadExecPS2Wrap #0 a0=0x3e5c60 a1=0x3 a2=0x3dc9d0 a3=0x7cf140 ra=0x22ed54 ... a0="cdrom0:\SCUS_972.75;1"
[call] 109.4s SetArg         #0 a0=0x3e5c60 a1=0x3 a2=0x3dc9d0 ... ra=0x1acea0
[LoadExecPS2] path="cdrom0:\SCUS_972.75;1" argc=3 argv[0]="--menu_state" argv[1]="dlgAfterErrorReboot.rdr" argv[2]=""
[LoadExecPS2] REBOOT requested: ... -- this build cannot re-exec; exiting with 74 (reboot-requested).
```

No `[guest-fault]` precedes it on this exe. On a console the kernel reloads the ELF from the disc and the loader's
`main()` parses `--menu_state dlgAfterErrorReboot.rdr` (research/05 §"FTSCore"; the strings at `0x3E5B28`, `0x3E5C00`
in `socom2_game.elf.strings.txt`): the player sees the main menu again, with whatever the "after error reboot" dialog
state shows. Our runtime cannot re-exec and exits 74; the launcher then shows the exit-74 sentence. **The fix is Q2 as
the spec wrote it** -- `LoadExecPS2` as an in-process restart with the argument block handed to the reloaded ELF --
and Q1 (the kernel-patch prologue) does not fire on today's exe (§3).

The offline exit the owner reported ("exiting a mission after getting to the briefing page") is **not reproduced by
any offline route** (§2). Every historical log with the reboot request carries the online teardown (`DeleteSocket`)
first, and an online game's briefing is the BRIEFING ROOM's, so the two reports are most likely one route: the online
game's mission left through its briefing, which is the online logoff. The owner's exact steps decide it; until then Q2
fixes the evidenced route and the offline scripts stand as the negative control.

## 1. The runs

Ten single-instance runs under the loop lock (owner `s17-q0`), `PS2X_CALL_TRACE=0x1ACBF8:InitExecPS2,0x1ACCF8:SetArg,0x1ACE88:LoadExecPS2Wrap`,
`PS2X_CALL_TRACE_DUMP=LoadExecPS2Wrap:a2*:8`, `PS2X_SCHED_TRACE=1`, `PS2X_PC_SAMPLER=1`, `PS2X_HOST_GAMEPAD=0`; the
logs and captures under `logs/parity/s17_q0/` (git-ignored), one contact sheet per run (`sheet_*.png`).

| Run | Route | What happened |
|---|---|---|
| `mission` | boot → the briefing → TRIANGLE, CROSS | TRIANGLE opens "Are you sure you want to leave the mission?" with NO selected; CROSS answered NO |
| `mission2` | the briefing → TRIANGLE, LEFT, CROSS | the MAIN MENU, in-process; no trace line |
| `ingame1` | the fast path to the HUD → START, six DOWNs | the pause menu: RESUME / REPLAY MISSION / ABORT / INVERT PITCH / HELP / AIM ASSIST / VIBRATION / FIREMODE-TACMAP |
| `ingame2` | START, DOWN, DOWN, CROSS (ABORT), LEFT, CROSS | "Are you sure you want to abort the game?" → YES → the MISSION FAILURE statistics page; the game alive |
| `ingame3` | the statistics page → CIRCLE, TRIANGLE, LEFT, CROSS | TRIANGLE went through LOADING to the briefing; the exit presses were spent before it |
| `ingame4` | the statistics page → CROSS | REPLAY: the mission restarted |
| `ingame5` | the statistics page → LEFT, CROSS | REPLAY again: the page's legend is a button legend, TRIANGLE = MISSION BRIEFING, CROSS = REPLAY (`sheet_legend.png`) |
| `ingame6` | abort → TRIANGLE → the briefing → TRIANGLE, LEFT, CROSS | the MAIN MENU, in-process; no `[LoadExecPS2]`, no `[guest-fault]`, the process alive to 210 s |
| `ingame7_player` | the same on the player-kind exe `f3276760…` | the same: the MAIN MENU, no reboot request |
| `online1` | `online_login_ours.py --prefilled --existing` to the lobby → TRIANGLE, TRIANGLE, LEFT, CROSS | the logoff prompt; YES; the teardown; **the reboot request; exit 74 at 153 s** |

The two drive scripts that reproduce the offline routes on demand are `scripts/parity/quit_mission.txt` (the
briefing's exit) and `scripts/parity/quit_mission_ingame.txt` (abort, MISSION BRIEFING, the briefing's exit). The
online route is `online_login_ours.py`'s `--then triangle:5,triangle:5,left:2,cross:8` after the lobby.

## 2. The offline routes are clean

Both offline exits return to the main menu inside the process on both exe kinds: the game's briefing-page exit and
its in-mission abort do not re-exec. The five historical logs with the reboot request
(`logs/run_20260920_120734.log`, `run_20260923_233814`, `_234126`, `_234854`, `run_20260924_021655`) all carry
`snd_StopSoundSystem` and `[DBCMAN] DeleteSocket` before it and were launched with `PS2X_MC_DIR=mc0` -- the owner's own
launches (three within ten minutes on 2026-09-23 23:38–23:48Z), each ended by the logoff. The offline report is
therefore unreproduced, not refuted: the owner's exact steps (which menu, which mission, online or not) are the
one thing that can move it, and the two scripts above are the control to run beside them.

## 3. The fault of the old logs is not on today's exe

Those five logs show `[guest-fault] store8 vaddr=0xffffffff pc=0x1accd0` inside `kCopy@0x1ACCB8` right after
`DeleteSocket`, then the reboot request with the same argv. On today's exe the same route shows **no fault**: the
wrapper `0x1ACE88` (`FUN_001ace88`) is `SetArg` (`0x1ACCF8`), a flush, then the kernel `_LoadExecPS2`; the SDK's
`InitExecPS2` (`0x1ACBF8`) runs **once, at boot**, from `_InitSys` (`0x1ACAE8`, `ra=0x1acb18`), not at the exit. So
the search that returned −1 in September's logs was in the boot-time prologue's copy, and whatever moved it (the
kernel-table model, the syscall-entry work of Sprint 13 C8) has already left today's exe without the fault. **Q1 does
not fire**; the row stays as a note here.

## 4. What the restart needs (for Q2)

Read from the decompilation (`game/analysis/SCUS_972.75.decomp.c`, cited by address) and the recompiled
`recomp/output/SetArg_0x1accf8.cpp`:

- **The argument block.** `_InitSys` ends with `DAT_001cd0f0 = RFU091(3)` -- syscall `0x5B` (the runtime's
  `Dispatcher.cpp:231`, the `GetEntryAddress` family; `System.cpp:438`) answers the address of the kernel's
  boot-argument area, and the game keeps it at `0x1CD0F0`.
- **`SetArg(filename, argc, argv)`** (`FUN_001accf8`): with `base = *0x1CD0F0`: it writes a pointer at `base+0` to
  the string area at `base+0x40`, copies the filename there, then for each of at most 15 arguments a pointer at
  `base+4*(i+1)` and the string appended after the previous one; it returns `base+0x40` (the filename's copy).
- **The kernel call.** `FUN_001ace88`: `_LoadExecPS2(SetArg(...), argc, base+4)` -- the ELF path, `argc`, and the
  pointer table from `base+4` (argv[0] at `base+4`, argv[1] at `base+8`, ...). The runtime's `LoadExecPS2` syscall
  already decodes exactly that (its log line prints the three strings).
- **At boot the crt0 reads the same area** through the same syscall answer: a restarted guest sees its `argc`/`argv`
  if the block at the answered address holds what `SetArg` wrote. So Q2's restart keeps the block's bytes across the
  reset (or rewrites them from the decoded argv), answers syscall `0x5B` with the same address, reloads the ELF and
  restarts the game thread; the loader's `main()` then does on our runtime what it does on the console.
- **What else the game tore down before asking:** `snd_PcmStreamStop`, `snd_StopAllSounds`, `snd_UnloadBank`,
  `snd_StopAllVAGStreams`, `snd_StopSoundSystem`, `[DBCMAN] DeleteSocket` -- so the IOP HLE modules and the mixer
  are already quiet at the request; the restart still resets them (the boot re-loads the IRXs).

## 5. What this changes in the plan

- **Q0 DONE**: the route, the argv, the caller, the fault's absence, the block's layout.
- **Q1 does not fire** (§3); its row records this note.
- **Q2 is the whole fix**, as designed (D3: the in-process restart first): its RED case plants the block and asserts
  the reloaded guest reads `argc=3` and the three strings through syscall `0x5B`'s answer; its run is `online1`'s
  route ending on the main menu with `ref_main_menu_ours.png` matched.
- **The owner's word** decides the offline report: the two scripts are the control.

## 6. Commands

From `C:/Projects/socom_pc`, `$OUT=logs/parity/s17_q0`:

- The offline runs: `bash scripts/loop_lock.sh run s17-q0 --class run -- env PS2X_CALL_TRACE=... PS2X_SCHED_TRACE=1 PS2X_PC_SAMPLER=1 PS2X_HOST_GAMEPAD=0 PS2X_RUN_LOG=$OUT/<run>.log python -m tools_py.parity.drive --target ours --script scripts/parity/quit_mission_ingame.txt --out $OUT/<run> --seconds 280` (`quit_mission.txt` for the briefing's exit; `SOCOM_EXE=dist-release/portable/socom2/socom2.exe` for the player kind).
- The online run: the same lock and knobs around `python -m tools_py.parity.online_login_ours --name socomc --password socom --prefilled --existing --instance A --out $OUT/online1 --seconds 420 --hold 5 --then triangle:5,triangle:5,left:2,cross:8`, `source scripts/parity/env.sh` first (the hosted server, ours).
- The reading: `grep -n -E "call-trace\]|\[call\]|guest-fault|LoadExecPS2\]|DeleteSocket|snd_StopSoundSystem" $OUT/<run>.log`; the contact sheets by the PIL snippet in the Log (one thumbnail per capture).
- The decompilation: `grep -n "FUN_001accf8 @\|FUN_001ace88 @\|FUN_001acae8 @\|DAT_001cd0f0" game/analysis/SCUS_972.75.decomp.c`; the strings `grep -n "menu_state\|AfterErrorReboot" game/analysis/socom2_game.elf.strings.txt`.
