# 77 — The HDD maps: what the game does, and how we would serve them (scope, 2026-09-28)

Written by the main-tree controller (session socom-pc-e0) on the owner's word of 2026-09-28 03:30Z: "scope out how
we will implement the hdd maps." A research note (class S, `docs/DOC_MAINTENANCE.md` §3): dated, superseded rather
than rewritten. Facts come from a read-only sweep of the tree, the local decompilation under `game/analysis/` and the
disc's own files (nothing built, run, edited or fetched, except one public guide page); each carries its source.
The Sprint 11 spec's Goal G (`docs/superpowers/specs/2026-09-21-sprint-11-r0004-and-the-community-server-design.md`
§ Goal G) proposed the same design in 2026-09-21 and was never scheduled (D4 "out of scope for v1"; the owner's
"HDD maps far future", 2026-09-26). This note re-reads it against the tree of 2026-09-28, corrects it where the
decompilation says otherwise, and sizes the work.

## 1. What the three maps are

- **After Hours** (Suppression), **Last Bastion** (Breach) and **Liberation** (Escort): the three online maps Sony
  added with the r0004 update in 2004 for players with a PlayStation 2 hard disk. The viewer's map list already names
  them and marks them absent from the r0001 disc (`web/packages/viewer/src/mapOrder.ts:8-9, 40-42`).
- Today a player gets them from PSRewired: their guide ships "SOCOM II HDD UNZIP ME FIRST.zip", a PCSX2 hard-disk
  image (about 15 MB compressed) the player points PCSX2's Network & HDD setting at; then, in the game's Options,
  HDD is turned on and the setting saved to the memory card; the maps then appear online
  (https://psrewired.com/guides/socom2, read 2026-09-28; the image itself was never fetched — `docs/archive/HUMAN_TASKS-to-2026-09-25.md:298`).
- Our tree never names them as work: no KNOWN, LATER, BACKLOG or HAZARDS row, no issue. Only the Sprint 11 spec's
  Goal G and the audit's carried row 26 ("NEGLECTED", `docs/audits/2026-09-25-project-audit/carry-backlog.md:63`).

## 2. What the game already does (r0001 and r0004 alike — verified in the decompilation)

The whole hard-disk path ships on the r0001 disc and is compiled into the game we have already recompiled. r0004
changes none of it (the `hdd` string count is 3 in both images, research/43 §5; the r0004 sidecar has no
`UIHardDriveOperation` row, `recomp/socom2_names_r0004.csv`).

| Step | What the code does | Where |
|---|---|---|
| The modules | `RUN\IRX\HDD\ATAD.IRX` (12,085 B), `HDD.IRX` (30,117 B, args `-o 1 -n 3`), `PFS.IRX` (49,417 B, args `-m 1 -o 1 -n 10`) are on the disc; `DEV9.IRX` loads at boot already | `game/disc/RUN/IRX/HDD/`; strings 0x3f7f60/0x3f7f80/0x3f7fa0/0x3f7ec0; the load table at 0x3e0250 |
| The probe | `FUN_0034f230` loads the three modules (only when `DAT_003e01b4 != 1`; the image holds 0), then `sceDevctl("hdd0:", 0x4807)` into `DAT_0049e2dc`; "HDD present" is `DAT_0049e2dc == 0`. These are the only loads of the HDD modules; neither PCSX2 reference log loads them at boot | decomp :249268-249315; `logs/pcsx2_reference_boot.txt:366-448` |
| The install/mount | `FUN_0039d050` builds `hdd0:PP.SCUS-97275..SOCOM_II,<8 complemented bytes from 0x3e0620>`, tries `sceMount("pfs0:", …)`; on failure creates the partition (`,%dM`, `,PFS`), `sceFormat("pfs:")`, mounts, `sceMkdir("pfs0:/RUN", 0x1ff)`, unmounts, remounts. **On success** it sets `DAT_0049e2e0 = 1` (the "mounted" flag) and issues devctl `0x4803` — the Sprint 11 spec's "on failure" at its line 221 is wrong | decomp :293426-293508; `FUN_0034f1e0` unmounts only when the flag is set (:249251-249263) |
| The UI command | `UIHardDriveOperation` (UI action 0xCD, 0x278980) has `OPEN` (the probe+mount; a non-zero result sets `hard_disk_error_code` 1/2/3/5 and raises `HDD_ERROR`), `GET_MISSION_DATA`, `CLOSE` (unmount, then `FUN_002c90b0` drops the entries flagged at +0x1C) | decomp :123581-123656 |
| The map list | At init `missionlist.rdr` (0x3f1b30) fills the list object 0x441650; each record has `NAME`, `NUMBER`, `VERSION`, `MULTIPLAYER`, `TYPE` (BREACH 1, DEMOLITION 2, ESCORT 3, EXTRACTION 4, SUPPRESSION 5); the level id is `mp%d` from `NUMBER` | decomp :152649-152651, :168846-168910, :123866-123877 |
| The extra maps | `GET_MISSION_DATA` → `FUN_0039ce80(".ZDB")`: `sceDopen("pfs0:RUN")`, `sceDread` every entry ending `.ZDB`, `sceOpen` each, read its first 0xFC bytes, copy a 0x27-byte record from offset 0x14 and add it to the same list flagged +0x1C (`FUN_002c91a0`: number at +2, multiplayer at +5, type at +6). **So the HDD holds whole map packs, each self-describing in its header; the game discovers them by listing a directory, not from a manifest** | decomp :293367-293411, :168716-168789 |
| File opens | `FUN_0039e9b0`: when the mounted flag is set, a path is tried as `pfs0:/<path>` first (backslashes to slashes), then the cdrom (`;1`) or `host0:.\` fallback | decomp ~:294336-294400 |
| The EE client | The `sce*` fileio calls (Sony's libfileio over SIF RPC, not fileXio as the spec said): `sceOpen` 0x1a7cc0, `sceRead`, `sceMkdir`, `sceFormat`, `sceDopen/Dclose/Dread`, `sceMount` 0x1a9fd0, `sceUmount` 0x1aa240, `sceDevctl` 0x1aa498 — all in the loader, so r0004-proof | `recomp/socom2_names.csv` rows 453-481 |

**What our runtime has and lacks (`third_party/ps2recomp`).** `sceOpen/Close/Lseek/Read/Write` and
`_sceSifLoadModule` are runtime stubs (`recomp/socom2.toml:191-203`); `sceMkdir`, `sceFormat`, `sceDopen/Dclose/Dread`,
`sceGetstat`, `sceSync`, `sceMount`, `sceDevctl` are recompiled as guest code whose RPCs no IOP service answers
(`ps2xIOP/src/builtin_profiles.cpp:6-31` registers MCSERV/DBCMAN/LIBSD/989snd/lgaud/eznetcnf only; an unhandled RPC is
logged, `RPC.cpp:105-139`). Path translation knows `host0:`, `cdrom0:`, `mc0:` and refuses any other prefix
(`ps2xRuntime/src/lib/Kernel/Syscalls/Helpers/Runtime.h:216-281`). Every IRX load is answered with a fake module id and
never refused, and `SifLoadModule` never writes the caller's result word (`Helpers/Loader.h:78-122`). No log under
`logs/` shows the HDD modules loading or a `pfs0:` access, so **what the probe returns under our runtime today is
unmeasured** — the one fact a first run must establish.

## 3. Where the map data would come from — the question that decides the scope

The disc carries **ten** MP packs `MP1, 2, 5, 6, 7, 8, 9, 10, 11, 12` plus the twelve `MP5x–MP8x`; `MP10.ZDB`
(10,676,224 B, 68 entries), `MP11.ZDB` (9,822,208 B, 61) and `MP12.ZDB` (9,826,304 B, 53) are full packs whose first
entry is `RUN\MP\MP1x\READERM.ZAR` like every other (read from each pack's own table of contents with the recipe of
research/03: count at 0x98, 0x5c-byte entries from 0xa0; command in §6). r0004 adds the id strings `mp10 mp11 mp12`
to its per-map fixup block (research/43 §5). No map name is stored in any pack (a search for the three names and
twenty-five r0001 names, plain and byte-inverted, found nothing in the ten packs): names live in `missionlist.rdr`
inside a reader archive, keyed by `NUMBER`. So two readings remain open, exactly the spec's two:

1. **The data shipped on the disc** and the HDD is an install cache: `pfs0:RUN/MP1x.ZDB` are copies (or the
   PSRewired image holds them), and r0004 only lists them. Then serving `pfs0:` from a host folder that the launcher
   fills **from the player's own disc** ships no Sony byte we lack, and the whole feature is ours to build.
2. **The data is HDD-only content**: the image's packs differ from the disc's. Then the packs are Sony content the
   project never sources or ships (Global Constraint, "nothing derived from the disc enters the tree"; the spec's
   stop rule); the player supplies the PSRewired image, and our part is to read it.

The disc's three unexplained packs make reading 1 likelier than the spec thought, but nothing proves it: the packs'
`READERM.ZAR` and the 0x27-byte header record have not been decoded, and `missionlist.rdr` has not been located.

## 4. The design — (A) a host folder behind `pfs0:`, as `mc0:` is served today

Unchanged from the spec's recommendation, with the layer corrected: answer Sony's **libfileio** RPCs (the IOP
`fileio` server the loader binds — its SID to be read off the bind with a trace) for the `hdd0:` and `pfs0:` devices,
from a git-ignored folder beside the exe (`hdd/`, knob `PS2X_HDD_DIR`, a launcher switch "HDD"), the way the
simulated memory cards serve `mc0:` (Sprint 8 Goal 11). No ATA, no APA partition table, no on-disk PFS, no DEV9
registers, no IRX execution — the project HLEs IOP modules and does not run them (research/01 §, research/40).

What it needs, in the runtime:

- `sceDevctl("hdd0:", 0x4807)` → 0 when the folder exists (the probe); `0x4803` accepted and ignored.
- `sceMount("pfs0:", "hdd0:PP.SCUS-97275..SOCOM_II,…")` → 0; `sceUmount` → 0; `sceFormat("pfs:")` → 0 (creates the
  folder); `sceMkdir("pfs0:/RUN")` → the subfolder.
- `sceDopen/Dread/Dclose` over `pfs0:RUN` returning the folder's `*.ZDB` names in the dirent shape the loop reads.
- `pfs0:/…` in path translation (`Runtime.h:250-281`): `pfs0:/RUN/MP10.ZDB` → `<PS2X_HDD_DIR>/RUN/MP10.ZDB`; the
  existing `sceOpen/Read/Lseek/Close` stubs then serve the packs like `cdrom0:` ones.
- The result word of `SifLoadModule` written (0 on success) so `FUN_0034f230`'s abort branch reads a real value.
- A `[hdd]` trace line per call, so a run's log is the evidence.

And in the launcher/tools: an "HDD" switch that sets the knob; a one-shot **import** that fills `hdd/RUN/` either
from the player's disc (reading 1: copy `MP10–12.ZDB` from the ISO the launcher already reads) or from a PCSX2
HDD image the player supplies (reading 2: a pure-Python APA + PFS reader in `tools_py/hdd/` that extracts
`RUN/*.ZDB` from a `.raw`; PFS is documented by ps2-hdd tooling (hdl_dump, pfsshell) and is a bounded parser, testable
on a synthetic image built by the test itself).

**(B) LLE** — emulating the SPEED/ATA registers and running ATAD/HDD/PFS as IRX code — stays rejected: no IOP that
executes IRX exists here and none is wanted (research/40 §: DEV9 "must stay EE-side HLE").

## 5. Sizing and order (a proposal; the owner schedules)

| Step | What | Marker, size | Bar |
|---|---|---|---|
| H0 spike, lock-free | decode `MP10–12.ZDB`'s `READERM.ZAR` and the 0x27-byte header record; locate `missionlist.rdr` (inside a UI/reader ZAR) and read its `NUMBER`→`NAME` rows; state which reading of §3 holds for the disc's three packs | [A] Opus, S (half a day) | a table pack → number → name → mode, with the commands; the §3 verdict for the disc side |
| H1 spike, one run | the r0001 build with an empty `hdd/` and the `[hdd]` trace: what the probe returns today, whether Options→HDD reaches `UIHardDriveOperation OPEN`, every `sce*` call the game makes and with what arguments | [L] one window, S | the trace on disk; the RPC SID of fileio |
| H2 the HLE | §4's runtime part, test-first in `ps2xTest` (a fake folder: probe, format, mount, mkdir, dopen loop, open); merged chain green with the knob off (no pixel moves) | [A] Opus then [L] one chain, M (2-3 days) | with `hdd/RUN/MP10.ZDB` present the game lists a fourth map in the online map picker on the local Horizon; with the folder absent nothing changes (the gate 3/3) |
| H3 the import | the launcher switch and the import: from the disc if H0 says reading 1; the PCSX2 `.raw` reader (APA+PFS) either way, since players have the image | [A] Opus, M | a synthetic-image test; the real PSRewired image is the player's file, read on their machine, never fetched by the loop (R293's boundary applies to the download too — an owner's row if we want it for a check) |
| H4 the proof | one control round on one of the three maps against the local Horizon with two instances, the gate's fourth leg | [L] Fable, S | the round ends by a kill (the standing bar) |

Stop rules, as the spec had them: if H1 shows the probe cannot be reached from the UI under our runtime within a
day, file the trace and stop; if H0 proves reading 2 and no player-supplied image is on hand, stop at H2's "lists a
map from a folder" and leave H3's disc branch out. Nothing here blocks Sprint 17; the earliest sensible slot is a
sprint after the frame-rate work, or H0 alone as idle-time work (it needs no lock).

## 6. Commands behind the numbers

```
# the packs' tables of contents (read-only; research/03's TOC layout)
python - <<'EOF'
import struct, os
for pack in ["MP1","MP2","MP5","MP6","MP7","MP8","MP9","MP10","MP11","MP12"]:
    p = os.path.join("game/disc/RUN", pack + ".ZDB"); head = open(p, "rb").read(0xa0 + 0x5c*400)
    n = struct.unpack_from("<I", head, 0x98)[0]
    first = head[0xa4:0xa4+64].split(b"\0")[0].decode()
    print(pack, os.path.getsize(p), n, first)
EOF
# the name search (nothing found in any of the ten packs, plain or byte-inverted)
```

Sources: the Explore sweep of 2026-09-28 03:35-03:47Z (this session's subagent, 83 reads, no writes); `game/analysis/
socom2_game.elf.decomp.c` and `.strings.txt` (local, untracked); the Sprint 11 spec Goal G; research/02, 03, 43a/43b,
40, 01, 05; `recomp/socom2.toml`, `recomp/socom2_names*.csv`; the PSRewired guide page.
