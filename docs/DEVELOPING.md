# Developing SOCOM Unzipped

The developer reference: the repository layout, a map of `tools_py/`, the build and test commands, the first hour on
a fresh checkout, the runtime knobs (`PS2X_*`) that need more than their one line in `docs/KNOBS.md`, the online
harness flags, the loop lock, and the launcher internals. **This file is class L** (`docs/DOC_MAINTENANCE.md` §3): it
says what is true of the tree now. A date in parentheses is when a behaviour landed, not when the sentence was
written; a number carries the date it was measured. It **owns the suite counts** — no other registered document
states them. For orientation start at `docs/HANDOFF.md`; for what is proven and what is only believed, `docs/KNOWN.md`,
which wins on any disagreement.

> Superseded 2026-09-25 (Sprint 13 R2): this paragraph said the file was "kept as written by the sprints that added
> each entry; the dates in it are when a behaviour landed" — a dated history in a class-L file, which the 2026-09-25
> audit found six wrong facts in (its documents report, rows 3–8 and 67). It was rewritten as current truth; each
> sentence that had been wrong is marked where it stood.

## How it works (one paragraph)
The retail ELF is only a loader; the game is two Metrowerks overlays that the loader decrypts
from `RUN/RAW/APACHE00.ZDB` with libdnas2. The tooling recovers the plaintext overlays from the player's own disc
(`tools_py/decrypt_apache.py`, Unicorn-driven), merges them with the loader into one ELF
(`game/overlays/socom2_game.elf`), and statically recompiles that ELF to C++ with a vendored fork
of PS2Recomp (`third_party/ps2recomp`, GPL-3.0). The fork's runtime provides the EE kernel,
DMAC/VIF/GIF, a GS (an OpenGL backend with an integer up-scale is the default path; the CPU
rasteriser is the test path), a VU1 interpreter and IOP services emulated at the SIF-RPC level.
SOCOM-specific behaviour lives in `third_party/ps2recomp/ps2xRuntime/src/lib/game_overrides_socom2.cpp`
(EE-side hooks) and `third_party/ps2recomp/ps2xIOP/src/modules/*.cpp` (IOP services). The
online server is Horizon Private Server configured for SOCOM II under `server/`.

## Layout
| Path | What |
|---|---|
| `build.sh`, `run.sh` | Build (`tools`, `recomp`, `runtime`, `release`, `test`, `all`; `--no-runner` builds without generated code) and run (`./run.sh <seconds>`) — Git Bash. Linux: `scripts/build_linux.sh` |
| `recomp/` | Recompiler config (`socom2.toml`, hand-maintained; `socom2_r0004.toml` is derived from it by `build_revision.sh` step 3 and held to those bytes by `tools_py/tests/test_build_products.py`), Ghidra function map (`socom2_ghidra.csv`, a source the build never writes), forced entry points (`extra_functions.txt`), the readable names with their provenance (`socom2_names.csv`, `socom2_names_r0004.csv`; the holds `socom2_name_holds.csv`; the r0004 seeds `r0004_seeds.txt` — "Names in the generated code" below), generated C++ in `output/` and the build's products under `build/` (both ignored; the fixed function map is `build/socom2_ghidra.fixed.csv`) |
| `third_party/ps2recomp/` | Vendored PS2Recomp fork (our changes are committed in place; see `git log -- third_party`) |
| `tools_py/` | Python tooling: 165 modules (2026-09-25 after Sprint 13 Task H4, `git ls-files 'tools_py/*.py'` less the tests and `__init__.py`), mapped by purpose in "The `tools_py/` map" below; the tests in `tools_py/tests/` |
| `scripts/` | Shell and PowerShell entry points: the disc chain, the revision build, packaging, the loop lock, the VM sync, the hooks; `scripts/parity/` holds the harness's launch scripts, step scripts and reference images |
| `ghidra_scripts/` | Headless Ghidra scripts (export, pointer/vtable scan, function forcing) |
| `server/` | Horizon Private Server sources+config for app id 10472, `start-servers.ps1`, README |
| `docs/` | The live documents (`HANDOFF`, `KNOWN`, `STATUS`, `CURRENT_SPRINT`, `HUMAN_TASKS`, this file), the player pages (`INSTALL`, `FAQ`), the research notes under `docs/research/`, each sprint's spec and plan under `docs/superpowers/`, dated audits under `docs/audits/`; `docs/DOC_MAINTENANCE.md` classifies every one |
| `game/` (ignored) | ISO, extracted disc tree, decrypted overlays, Ghidra decompilation exports |
| `tools/` (ignored) | Portable toolchain: llvm-mingw clang 20260826, CMake 4.4.3, Ninja 1.13.2 (the three `scripts/bootstrap_windows.sh` fetches), plus on the maintainer's machine Ghidra 12.1.3 with ghidra-emotionengine-reloaded v2.1.37 and PCSX2 2.8.2 (`tools/pcsx2`, `tools/pcsx2_b`); an off-tree copy of the whole folder is `D:\socom_archive\tools_backup_2026-09-26` (`docs/HAZARDS.md` git) |
| `ghidra_proj/` (ignored) | Ghidra project `socom` (programs: SCUS_972.75, DNAS.BIN/.dec.bin, socom2_game.elf, 989SND.IRX) |
| `dist/` (ignored) | `socom2.exe`, the launcher, their DLLs |

## Run it (players)
The player's page is `docs/INSTALL.md`, and what goes wrong is `docs/FAQ.md`. For a developer: `scripts/make_portable.sh`
builds `dist/portable/socom2/` (and a zip) from a finished build — the game, its DLLs, the launcher, a README and the
licences, with empty `cards/` and `logs/` — which is the folder INSTALL describes. The release is two kinds (R295):
`./build.sh release` builds the **player** exe into `dist-release/` with `-DPS2X_ENABLE_DEBUG_UI=OFF`, and
`PS2X_RELEASE_KIND=developer ./build.sh release` the **developer** exe with it ON, into `dist-release-dev/`:
the player exe drops the debug UI; the probes stay in both kinds because the gate reads them (R315 (R295's probe half withdrawn, 2026-09-27)). Each writes its kind beside the exe in `RELEASE_KIND`, which make_portable refuses to package without (exit 2);
`scripts/make_portable.sh --release` then writes `socom2-portable.zip` and `socom2-developer.zip` from one run, one
`SHA256SUMS` line and one manifest entry (with its `kind`) each. The ELF ships in both for now (#70).

## Publishing anything: the leak check

The repository is public. `python -m tools_py.release.leakcheck <mode>` is the gate (Sprint 10 hardening; the design is
Sprint 11 Goal 9): `tree` every tracked file, `staged` the index (the pre-commit hook), `ignored` proves the paths that
hold real secrets (`SENSITIVE_IGNORED` in `leakcheck.py`; the never-commit list is `docs/GIT_STRATEGY.md` section
3's) are ignored, untracked and never committed, `metadata` the commit identities, `history [range]` every added
line of every commit (the pre-push hook),
`artifact <dir>` an unpacked release, `external` the sibling repositories' own scanners (`../scotho`'s
`scripts/check-secrets.mjs` and `../socom_monitor`'s `leakcheck.py`, folded into this report with their excerpts
masked), `all` the four repository modes plus `external`. A sibling that is not beside this repository prints
SKIPPED and leaves the exit code alone -- CI has neither, and SKIPPED is never "clean"; `external --require` makes
a missing one exit 2, and a sibling that IS there whose scanner could not scan is exit 2 either way. `--siblings-root`
(or `$SOCOM_LEAK_SIBLINGS`) says where they are. Exit 0 clean, 1 findings, **2 did not run** (a
shallow clone, a missing target, a missed planted control, an external scanner that never ran) -- a caller never
reads 2 as a pass. Output is masked;
`--reveal` for the terminal, `--json` for a report. Decisions live in `tools_py/release/leak_allow.txt` with reasons;
owner-specific literals in the git-ignored `leak_extra.txt`. Install the hooks with `bash scripts/install_hooks.sh`.

## Names in the generated code (Sprint 12, since 2026-09-24)

**Where a function's name comes from.** `recomp/socom2_names.csv`, the provenance sidecar, and nowhere else.
`[general] names = "socom2_names.csv"` in `recomp/socom2.toml` (opened relative to the directory the recompiler
runs in, which `build.sh` makes `recomp/`; the r0004 toml names `socom2_names_r0004.csv`) makes the recompiler use
the sidecar's `Name` for the generated identifier, the output filename and the `// Function:` comment —
`<Name>_0x<start>.cpp`, headed (since Sprint 13 N2, `a517291a`; `function_emitter.cpp`) by two lines:

```
// Function: <Name>
// Name source: socom2_names.csv row 0x<8-digit start> (map name <map name>)
```

The row is the sidecar's own padded spelling of the address, so it greps; the map name is the one the recompiler
still reads for extent and stubbing.
**The `Name` column of `recomp/socom2_ghidra.csv` is not where a name goes:** it is Ghidra's export, and to this
recompiler a name there is the function's identity — it decides the extent and can stub the body by name
(research/57 §4, ruling S12-R13). Do not rename anything there. A function still called `FUN_…` or `sub_…` has no
sidecar row; one at a toml-bound stub address is a stub file with no comment header, only the identifier.

**Why is it called that?** Pad the identifier's address to eight hex digits and grep the sidecar:
`CZOnlineLobby_JoinRoom_0x2e3790` → `grep -i '^0x002e3790,' recomp/socom2_names.csv`. The row is
`Address, Name, Mangled, Pass, Score, Evidence, Source, Date`: the demo's mangled original, the pass that proposed
it (several passes that agreed are joined with `&`; a `+` is part of one pass's name, as in `prefix+offsets`), the
pass's score (each pass's own scale, set by its note or ruling — compare scores within a pass, not across passes,
and do not read one as a probability), the evidence in that pass's own words, the proposals file and the note that
states its rule, and the day it was applied. `Pass=ghidra` rows are Ghidra's own syscall-stub names, backfilled so every name has a row. The
proposals files under `game/` are git-ignored and regenerated by each lever's command; the note is the durable
pointer. `recomp/socom2_names_r0004.csv` is the same for r0004, `Pass=carried:<pass>`, written by
`tools_py/carry_names.py`. If a name you expected is absent, check `recomp/socom2_name_holds.csv` — the
(address, name) pairs the evidence overturned, each with its reason and source.

**Proposing a name.** Never edit the sidecar by hand. A name arrives as a row in a proposals file under a rule
stated in code — each lever is `tools_py/*_lever.py`, and research/44 §2 (the six hurdles) and research/45 §2 (the
positional rule) are the two rules the rest are modelled on — and `tools_py/apply_names.py` is the only writer:

```
python -m tools_py.apply_names recomp/socom2_ghidra.csv recomp/socom2_names.csv <proposals.csv> ... \
    --holds recomp/socom2_name_holds.csv --demo game/demo_scus_972_05/SCUS_972.05 --report-only
```

prints every decision (applied, held, refused with its reason, deferred, contradiction) and writes nothing; drop
`--report-only` to write, which it does only when the re-audit of the whole file is clean. A name given by hand is
a proposals file like any other (Sprint 13 N1; `recomp/names_proposals_hand_2026-09-25.csv` is the model): columns
`Address,Current,Proposed,Mangled,Pass,Evidence`, `Pass=hand`, no `Score` (a hand row with a score is refused), the
reason as a `file:line` in `Evidence`, and a `#` header line saying what the file is. For r0004, apply the same
r0001 rows with `--through game/r0004/match.json`: each address travels only where the matcher placed it `exact`,
as `Pass=carried:hand`, and every other is printed `NOT CARRIED`. The applier will not rename a
name it already wrote (`refused: sidecar disagrees`): a wrong applied name is a finding for the controller, settled
by a ruling and a holds-file line, not a second proposal.

**The checks.** `python -m tools_py.name_provenance audit recomp/socom2_ghidra.csv recomp/socom2_names.csv` (and the
`_r0004` pair) must print `0 findings`: every sidecar row names a function start in the map, every non-placeholder
map name has its one row, and a rename is to a legal non-placeholder name. Two agreement tests hold it in the Python
suite: `test_the_tracked_csv_and_sidecar_agree` (`tools_py/tests/test_name_provenance.py`) runs that audit over both
tracked pairs, and `tools_py/tests/test_toml_names_agree.py` holds every `[general].stubs` selector of
`recomp/socom2.toml` that has a sidecar row to that row's `Mangled` name, so the handler selector and the name
cannot drift. **`./build.sh recomp` reads the sidecar**: `recomp/recomp_run.log` says `Loaded <n> display names from …socom2_names.csv`, and
`build.sh` prints that line as `recomp: names: Loaded <n> display names …`. If the toml's path does not resolve, the
recompiler writes a `[warning] names` event (since `9cafac47`, #48) and `build.sh` prints
`WARNING: names: names file does not resolve: …`; the output then carries the map's placeholder names. The build
does not fail on it, so look for the line.

How many names are applied, by which pass, and what is proven on the owner's machine: the task table and the Log of
`docs/superpowers/plans/2026-09-24-sprint-12.md`, and research/47–61 for what each pass measured. Two recomps are
compared with `python -m tools_py.recomp_census <output> <recomp_run.log> --json a.json` then `--diff a.json b.json`:
a rename is accepted only when it prints `S12-R11 … OK` (no extent moved, no function dropped, no new `unhandled` or
`unmapped`); the 2026-09-25 proof read `renamed 1771`, `extents_changed: 0`.

## The `tools_py/` map

Every tracked module under `tools_py/` except the tests, one line each, grouped by what it is for — 165 on
2026-09-25 after Sprint 13 Task H4, 177 on 2026-09-26 at the Sprint 14 close, 178 on 2026-09-26 with Sprint 15 T2's `window_drag.py` (`git ls-files 'tools_py/*.py'`, less `tools_py/tests/` and the five package
`__init__.py` files: hooks, parity, r0004, release, story). The one line is the module's own docstring, shortened; the docstring is the reference. Run a
module as `python -m tools_py.<name>` (or `tools_py.parity.<name>`, …) from the repository root unless its docstring
says otherwise.

**Entry points.** A module whose name no other code file contains (no module, script, workflow, `build.sh` or test
-- the harness audit's Appendix A rule, `docs/audits/2026-09-25-project-audit/harness-tools.md`) is run by a person or
not at all. Its row below says **Run it as:** `python -m …`, and its docstring carries the same `Run: python -m …` line.
`tools_py/tests/test_tools_py_inventory.py` fails on any module outside `tests/` and `research/` that has neither a
caller nor that row, and on any file in `docs/archive/tools/` without its banner and its row in
`docs/archive/README.md`. The research scripts are run by hand from their notes; the ones the audit flagged carry the
same line.
> Superseded 2026-09-25 (Sprint 13 Task H4): this paragraph marked 28 modules **†**, the audit's "invoked by nothing"
> flag, and said "`movie_blocks` has tests but no caller (issue #46 (closed)); the † modules have no issue yet". H4 archived
> nine of the 28 to `docs/archive/tools/` (the four `patch_*` source patchers, the four `dbg_*` decryptor probes and
> `parity/blue_marker.py`) and made the other nineteen entry points; `movie_blocks` has run in `build.sh test` through
> `tools_py/tests/test_movie_blocks_fixture.py` since `bd27443e` (2026-09-17).
> Superseded 2026-09-25 (Sprint 13 R2, fix round 1): this paragraph gave the method as "`git grep -l -w <name>`,
> zero hits outside the module itself", which does not yield 28 (seventeen more modules pass it, most of them
> research scripts), and said issue #46 (closed) carried one of the 28; `movie_blocks` is not among them.

Beside the modules, `tools_py/screenshot.ps1` captures a window by hand.
> Superseded 2026-09-25 (Sprint 13 Task H4): this also said "`tools_py/decrypt.log` / `decrypt2.log` are tracked
> because a KNOWN §1 evidence manifest hashes them". The manifest (`docs/research/assets/22-first-kill-evidence.txt`)
> hashes copies under a harness snapshot in `logs/`, not the tracked files; the two logs, with the owner's absolute
> paths in them, were deleted (harness audit H29).

**From the disc to the ELF** (the chain `scripts/disc_to_elf.sh` runs; section "From your own disc" below):

| Module | What it is for |
|---|---|
| `disc_to_elf.py` | The one command: your ISO → the extracted tree, the decrypted overlays and `socom2_game.elf`, each stage verified |
| `iso_lbn.py` | Map disc LBNs to file names (ISO9660), look an LBN up, and annotate a run log's CD reads |
| `dnas_selfdecrypt.py` | Decrypt the self-encrypting code blocks of the DNAS.BIN overlay (stage 2) |
| `decrypt_apache.py` | Run the retail loader's own decryption of `APACHE00.ZDB` under Unicorn and write the plain overlays (stage 3) |
| `ee_unicorn.py` | The minimal R5900 execution harness on Unicorn that the decryptors run on |
| `make_overlay_elf.py` | Wrap the loader and the decrypted `MWo3` overlays into one synthetic MIPS ELF (stage 4) |
| `decrypt_card_package.py` | Decrypt the update package the server writes to the memory card, through the loader's memory-card path |
| `overlay_repair.py` | Undo the r0004 capsule's baked-in stub writes in a decrypted overlay |
| `r0004/capsule.py` | Decode the encrypted code stack inside PSRewired's r0004 patch capsule |

**The function map and the recompiler's inputs:**

| Module | What it is for |
|---|---|
| `fix_ghidra_csv.py` | Normalise Ghidra's function export for PS2Recomp (End = Start + Size, the forced entries, the merge ranges) into a build product (`--out`, required); on the `./build.sh recomp` path and `build_revision.sh` step 0 |
| `find_imm_targets.py` | Find code addresses built as immediates (`lui`/`addiu`) that no function covers and append them to the forced entry points |
| `find_escaping_branches.py` | Report conditional branches whose target lies outside their own function range |
| `find_gap_functions.py` | Report executable gaps between functions that look like real function bodies |
| `find_interior_functions.py` | Report function starts hidden inside another function's range |
| `find_data_entries.py` | Find entry points no branch names (data-referenced entries, and their kin) |
| `find_ctor_thunks.py` | Enumerate an overlay's static-constructor thunks from its `MWo3` header and force each as an entry |
| `resolve_mmio.py` | Re-derive the true effective address of every `[mmio]` override in `recomp/socom2.toml` (r0001; no diff means the table is right). Run it as: `python -m tools_py.resolve_mmio [--write]` |
| `hle_constants.py` | Census of every HLE stub bound in the toml: its callers and what they do with the return value |
| `recomp_census.py` | Census of a recompiler output directory and its log, and the diff of two (the S12-R11 bar) |

**Another revision of the disc (r0004):**

| Module | What it is for |
|---|---|
| `address_matcher.py` | Match one build's functions onto another's (fingerprints, then seed+delta) |
| `fingerprint.py` | The per-function fingerprint: the instruction stream with address-carrying immediates zeroed |
| `derive_seeds.py` | Derive the matcher's `--seed` list from its own seedless run |
| `addresses_from_match.py` | Print the r0004 column of `runtime/socom2_addresses.h` from the match report |
| `data_via_twin.py` | Place an r0001 data address in r0004 by way of a twin function |
| `translate_extras.py` | Carry one build's forced entry points onto another build's addresses |
| `revision_toml.py` | Carry the recompiler's config from one build's addresses onto another's (`scripts/build_revision.sh` step 3) |
| `carry_names.py` | Carry one build's function names onto another build's matched addresses |

**Names** (Sprint 12; "Names in the generated code" above):

| Module | What it is for |
|---|---|
| `readable_names.py` | The renderer: a demo mangled name → the readable `Name` (research/47's rules) |
| `apply_names.py` | The only writer of the sidecar: proposals files → applied, held, refused or deferred names |
| `name_provenance.py` | The sidecar's schema and its `audit` against the function map |
| `elf_symbols.py` | The function table of an ELF that still has its `.symtab` (the SOCOM 1 demo) |
| `ghidra_symbol_match.py` | Name our anonymous functions from the demo's symbols by body match (Task 7) |
| `symbol_levers.py` | Two more levers on the demo's names: position between anchors, and a third build |
| `bindiff_lever.py` | BinDiff as the second signal, never a proposer alone (S12-R22) |
| `callgraph_lever.py` | Callers and callees of placed pairs name the bodies between |
| `offset_lever.py` | The `offset-multiset` and `prefix+offsets` passes (research/54) |
| `string_lever.py` | Names from the set of shared strings a body references |
| `toml_stub_lever.py` | The toml's own `name@addr` stub selectors as proposals |
| `ui_binding_lever.py` | Name r0001's UI script handlers from the demo's dispatch table |
| `vtable_lever.py` | Name a virtual function by its vtable slot |

**Reading what the runtime writes** (logs, dumps, profiles):

| Module | What it is for |
|---|---|
| `gif_packets.py` | List the vertices a `vu1_replay` packet file kicks. Run it as: `python -m tools_py.gif_packets <packets.bin> [--verts] [--limit N]` |
| `gif_submit_timeline.py` | Reduce a run log's `[gif-submit]` lines (`PS2X_GIF_TRACE`) to the title-label events. Run it as: `python -m tools_py.gif_submit_timeline <run.log> [--from N] [--count M]` |
| `gsdump_extract.py` | Turn a PCSX2 GS dump into the console-replay fixture `ps2x_tests` reads |
| `gsdump_timeline.py` | Per frame of a PCSX2 GS dump, every transfer, texture bind and kick. Run it as: `python -m tools_py.gsdump_timeline <dump.gs> [--pages P:N] [--all]` |
| `hostprof_symbolize.py` | Symbolise a `PS2X_HOST_PROF` histogram against `dist/socom2.exe` |
| `hostprof_diff.py` | Symbolise the difference of two `PS2X_HOST_PROF` histograms. Run it as: `python -m tools_py.hostprof_diff <pre.txt> <end.txt> [--top N] [--exe dist/socom2.exe] [--start-exe <pre's exe>]`; functions pair by the `_0x<start>` guest-address suffix, so a renamed function pairs with its old profile (Sprint 13 N1) |
| `hostprof_stacks.py` | Fold and symbolise the stacks of a `PS2X_HOST_PROF_STACKS=1` histogram. Run it as: `python -m tools_py.hostprof_stacks [logs/hostprof.txt] [--exe dist/socom2.exe] [--top N]` |
| `marker_timeline.py` | Merge a run log's game-thread events into one stream for the texture-set marker protocol. Run it as: `python -m tools_py.marker_timeline <run.log> [--from-frame N] [--frames M]` |
| `rdr_tree.py` | Print a parsed `.rdr` tree from a guest RAM dump (`PS2X_RDRAM_DUMP`) |
| `ra2fun.py` | Map guest addresses (a call trace's `ra=`) to the decompiled function holding them (reads `game/analysis/`). Run it as: `python -m tools_py.ra2fun 0x357028 …` |
| `vu1dis.py` | A minimal VU0/VU1 micro-program disassembler. Run it as: `python -m tools_py.vu1dis <dump.bin> [--start 0xPC] [--count N] [--raw]` |
| `vu1_headers.py` | Print the VU1 dispatcher header counts of a set of program dumps |
| `vu1stats_summary.py` | Summarise a run log's `[vu1-stats]` lines by phase. Run it as: `python -m tools_py.vu1stats_summary [run.log]` (default: the newest `logs/run_*.log`) |

**Early-bring-up one-offs** -- archived 2026-09-25 (Sprint 13 Task H4) to `docs/archive/tools/`: the four `dbg_*` decryptor probes and the four `patch_*` source patchers of the first week, which still wrote into the
vendored runtime when run. `docs/archive/README.md` lists them with what each was.

**The project's own records and gates:**

| Module | What it is for |
|---|---|
| `docmaint.py` | The document registry held to the tree (`docs/DOC_MAINTENANCE.md` §4's eleven checks) |
| `issues.py` | The known-issue stack on GitHub, held to the live documents (`skeleton`, `open`, `close`, `audit`) |
| `knobs.py` | The `PS2X_*` registry read out of `knobs.h`; `write` regenerates `docs/KNOBS.md` |
| `exit_codes.py` | The game's exit codes read out of `exit_codes.h` |
| `portable_audit.py` | What the portable folder carries, decided from import tables, and checked |
| `release/leakcheck.py` | The leak check ("Publishing anything" above) |
| `release/leakrules.py` | The leak shapes, as one set of regular expressions |
| `vm_prune.py` | What `scripts/vm_sync.sh tree` must delete in the VM |
| `vm_restamp.py` | What `scripts/vm_sync.sh tree` must re-stamp in the VM so ninja rebuilds it |
| `rulings.py` | Every ruling with its status and home, generated into `docs/RULINGS.md` (`--check`) |
| `changelog.py` | Every merge commit grouped by release tag, generated from git into `docs/CHANGELOG.md` (`--check`) |
| `sitting.py` | The owner's sitting page, generated into `docs/SITTING.md` (`--check`) |
| `flow.py` | How work moves through this repository, measured from git into `docs/FLOW.md` (`--check`) |
| `playtest_block.py` | `docs/PLAYTEST.md`'s build block, rendered from the manifest `scripts/make_portable.sh` writes (`--check`) |

**The guards** ("Guards" below):

| Module | What it is for |
|---|---|
| `hooks/pretool.py` | The PreToolUse guard: refuse a Bash call that breaks one of the repository's git or lock rules |
| `hooks/reap.py` | The SessionEnd/Stop reaper: kill orphaned watcher processes, never a shell |
| `hooks/commitmsg.py` | The commit-msg hook: a commit subject over 120 characters is refused |
| `bashpath.py` | Where `bash` is, for Python that runs the repository's shell scripts (Git Bash before WSL's) |

**The story** (`docs/STORY.md` and its checks):

| Module | What it is for |
|---|---|
| `story/cite.py` | The citation test for `docs/STORY.md` |
| `story/remap.py` | Carry the story's commit citations across a history rewrite |
| `story/site.py` | Render the story as one page in the site's chrome |
| `story/timeline.py` | Rebuild `docs/story/timeline.json` from `docs/STORY.md` |
| `story/witness.py` | Freeze a witness for every run, gate and log the story cites |

**The parity harness, `tools_py/parity/` — the gate and its scorers:**

| Module | What it is for |
|---|---|
| `gate.py` | The three-stage gate (title, transition, mission): PASS/FAIL, stamps under `logs/parity/gate/` |
| `pins.py` | What a measurement was computed against, and the refusal when it drifted |
| `frame_time.py` | The mission stage's `FRAME` line: VBlank pacing (host ms per guest VBlank, a lower bound on the time between presents) over the scripted walk, from the `[pc-sampler]` rows (informational, S13-R3). Run it on saved stamps as: `python -m tools_py.parity.frame_time <stamp dir> ...` |
| `submit_split.py` | The draw path's split (Sprint 17 F1): every `[gs-submit]` field (`setup`, `dirty_rows`, `resolve`, `draw`, `readback` ms/s; `flushes`, `readbacks`, `readback_rows`, `readback_px`, `rt_direct` /s), elapsed-weighted over the lines attributed to the `[pc-sampler]` rows in a `t=` window, so an attempt's before/after is one command (`PS2X_GS_STATS=1`). Run it as: `python -m tools_py.parity.submit_split <game log> [--from <t>] [--to <t>]` |
| `window_drag.py` | Issue #67 (closed): a scripted title-bar drag of the game window, and the readout of what the guest clock (`[pc-sampler]` `t=`/`vsync=`) and the `[audio-trace]` counters did through it -- FROZEN / SLOWED / ADVANCING. Run it as: `python -m tools_py.parity.window_drag drag --log <game log> --seconds 10 --stamps <file>`, then `python -m tools_py.parity.window_drag readout <game log> --stamps <file>` |
| `compare.py` | Score screens against the golden set and write `docs/parity/REPORT.md` |
| `guest_probe.py` | The gate's guest-value probe against console numbers on disk |
| `guest_addresses.py` | One home for the guest addresses the instruments read, and the per-revision rule |
| `addresses.py` | Guest addresses shared by the PCSX2 driver and our runtime |
| `black_rows.py` | The brightest pixel in the band that must stay black on the transition |
| `screen_bands.py` | The letterbox-band test: gameplay or the intro cinematic |
| `mission_fail.py` | Does a mission capture show the MISSION FAILURE screen |
| `console_compare.py` | Console against ours at the Seeding Chaos spawn view |
| `make_gate_fixtures.py` | Build the committed fixtures `test_gate.py` runs on |
| `montage.py` | Tile a directory's PNGs into one labelled contact sheet |
| `motion_diff.py` | Is our player seen moving on the console client |
| `scale_compare.py` | Is a 1280x896 frame the 640x448 frame, or a different render |
| `scale_shot.py` | One screen captured at 640x448 and at 1280x896 from the runtime |
| `resize_window.py` | Give the running game window a client area of a given size (captures to look at, not gate results). Run it as: `python -m tools_py.parity.resize_window <w> <h>` |
| `frame_burst.py` | Capture the game window at a fixed rate for a while (`docs/HAZARDS.md` harness: check a burst on ours by its first frame). Run it as: `python -m tools_py.parity.frame_burst <pcsx2\|ours> <out_dir> <start_after_s> <count> <interval_s>` |
| `movie_blocks.py` | Find 16x16 movie blocks the GL target lacks but shadow VRAM has; runs in `build.sh test` over the saved fixture `tests/fixtures/movie/` (`test_movie_blocks_fixture.py`), and by hand over a `PS2X_GS_DUMP_DISPLAY` capture |
| `motion_pack_check.py` | Is the motion pack intact in an RDRAM image |
| `object_diff.py` | Object-keyed uninitialised-field diff between our heap and the console's |
| `facing_check.py` | Validate the at-rest facing estimate offline |
| `mc_trace.py` | Read the runtime's `[MC]` trace lines out of a run log |
| `freeze_trace.py` | Where and for how long an instance's round clock stood still |
| `host_samples.py` | Read `run_detached.sh`'s host sampler CSV |

**The parity harness, `tools_py/parity/` — driving a game and PCSX2:**

| Module | What it is for |
|---|---|
| `drive.py` | Drive one side (PCSX2 or our exe) through a step script and capture each screen |
| `keys.py` | Post keyboard messages to a game window without changing focus |
| `winshot.py` | Focus-free capture of a window's client area (Windows) |
| `x11shot.py` | winshot's Linux half, under X11 |
| `hostplatform.py` | Which host the harness drives on, and the two things it does to the OS |
| `pcsx2_ctl.py` | Stepwise control of the two PCSX2 instances |
| `pcsx2_keys.py` | Post keyboard messages to PCSX2's window |
| `pcsx2_shell.py` | The console side of the mixed match, pressing on what its screen shows |
| `pine.py` | A minimal PCSX2 PINE client |
| `cam_poll.py` | Poll guest memory over PINE while PCSX2 runs |
| `state_poll.py` | Load a PCSX2 savestate and sample pointer chains as `[peek]` rows (needs a savestate; none exist since 2026-09-26 -- the harness boots from the disc) |
| `probe_poll.py` | Poll the collision query object on PCSX2 at a savestate (needs a savestate; none exist since 2026-09-26 -- the harness boots from the disc) |
| `gsdump_capture.py` | Capture a multi-frame PCSX2 GS dump at a savestate (needs a savestate; none exist since 2026-09-26 -- the harness boots from the disc) |
| `find_dialog_ptr.py` | Find a static pointer chain to the current dialog's name in a RAM dump |
| `capture_env.py` | The `PS2X_*` environment a capture ran with, written beside its output in the gate's pin format (issue #38 (closed); `scripts/parity/write_env.sh` for the shell scripts) |
| `p2s_extract.py` | Extract a member from a PCSX2 `.p2s` savestate (zstd entries). Run it as: `python -m tools_py.parity.p2s_extract <state.p2s> <out.bin> [member]` (needs a savestate; none exist since 2026-09-26 -- the harness boots from the disc) |
| `dns_stub.py` | A tiny DNS responder that points the PCSX2 guest at the Horizon host |

**The parity harness, `tools_py/parity/` — online:**

| Module | What it is for |
|---|---|
| `online_login_ours.py` | Drive our exe from boot to the lobby, CREATE GAME or JOIN GAME |
| `online_match_ours.py` | Two instances of our exe play a match ("Online" below) |
| `online_ladder.py` | The engagement ladder's round loop and stop rules |
| `ladder_ledger.py` | The scheduled ladder's ledger, rendered to `docs/LADDER.md` |
| `lobby_report.py` | Per-launch lobby summary from a two-instance drive log |
| `verdict_core.py` | The pure online verdict scorers the harness and the replay share |
| `verdict_replay.py` | The independent, valve-primary kill scorer over two stored logs |
| `sim_walk_to_b.py` | A closed-loop dry run of the approach loop against a simulated world |
| `sp_death_probe.py` | One single-player run that confirms the kill readout |
| `two_machine_readout.py` | The readout for the first two-machine match |
| `control_round_readout.py` | The verdict lines of Sprint 13's two control rounds, read off the rounds' own logs |
| `peer_pause.py` | Pause the peer of a running online round and record A through it (Sprint 13 V7's bar) |
| `online_login.py` | Drive the PCSX2 client from savestate 9 through login (needs a savestate; none exist since 2026-09-26 -- the harness boots from the disc) |
| `online_match.py` | Two PCSX2 clients on the local Horizon stack: host, join, READY |

**The parity harness, `tools_py/parity/` — audio:**

| Module | What it is for |
|---|---|
| `audio_parity.py` | The audio parity test against PCSX2, in the gate's shape |
| `audio_envelope.py` | The mission music's two reported symptoms as numbers with timestamps |
| `audio_dips.py` | Level dips in an endpoint capture, aligned to the mixer's dump and classified |
| `audio_corr.py` | How faithful the mixed audio is to the disc's own PCM |
| `cb_trace.py` | The host audio callback trace: where a 50 ms hole at the endpoint went |
| `stream_events.py` | The mixer's stream-event trace → stem-boundary holes and starvation |
| `pcm_dump.py` | Read a `PS2X_AUDIO_PCM_DUMP` file |
| `music_state_poll.py` | Poll the game's EE-side sound decision machines and log every change |
| `loopback_record.py` | Record what Windows sends to an output device (WASAPI loopback) |
| `endpoint_route.py` | Move the game's audio to a chosen endpoint for one run, and put it back |
| `app_volume.py` | List or hold one exe's per-app session volume |

**Research scripts, `tools_py/research/`** — each backs a research note and is run by hand from it; none has a test,
by design:

| Module | What it is for |
|---|---|
| `research/symbols/bindiff_join.py` | BinDiff's demo → r0001 matches joined to Task 7's pairs (research/49) |
| `research/symbols/callgraph_propagation.py` | Call-graph propagation from anchors (research/52) |
| `research/symbols/class_inventory.py` | The demo's class inventory as an architecture map (research/55) |
| `research/symbols/debug_paths.py` | What the demo's `.debug` section covers, by source path |
| `research/symbols/dwarf_types.py` | The demo's DWARF1 types and the raw guest offsets they name (research/50) |
| `research/symbols/link_order.py` | Does link order survive between the demo and our image |
| `research/symbols/name_consumers.py` | Who reads a function name or a raw guest offset (research/46) |
| `research/symbols/offset_multiset.py` | Member-offset multisets as a looser body key (research/54) |
| `research/symbols/readable_names.py` | Mangled name → `Class_Method`, with the overload-collision census |
| `research/symbols/readable_proof.py` | The readable-name scheme proven over four name sets (research/47) |
| `research/symbols/sase_probe.py` | SASE, the voice codec: what the images say about it (research/56) |
| `research/symbols/sidecar_census.py` | The provenance sidecar checked against the tree (research/48) |
| `research/symbols/string_correlator.py` | A shared-string correlator between the demo and r0001 (research/53) |
| `research/symbols/toml_names.py` | The recompiler's naming pipeline re-derived (research/57) |
| `research/symbols/toml_overlap.py` | How much of Task 7's proposals the toml already named |
| `research/symbols/vtable_anchors.py` | How far body-matched pairs get a vtable-slot matcher |
| `research/symbols/vtable_coverage.py` | Vtable coverage after 7c (research/51) |
| `research/symbols/vtable_rtti.py` | Locate retail vtables from a class-name string |
| `research/terrain/classify2.py` | Both terrain program families replayed with clipping and culling off, matched to the console's fans |
| `research/terrain/clip_planes.py` | A terrain dump's clip planes and each primitive's distances to them |
| `research/terrain/cull_trace_scan.py` | Scan a `PS2X_CULL_TRACE` log: the guest's cull results against a recomputation |
| `research/terrain/deferred_trace_scan.py` | Per frame, the deferred-list enqueues and flushes of a cull trace (research/31 §16-17). Run it as: `python -m tools_py.research.terrain.deferred_trace_scan <trace> [comp,…]` |
| `research/terrain/detail_sections_scan.py` | Per frame, every component the object renderer sized. Run it as: `python -m tools_py.research.terrain.detail_sections_scan <trace>` |
| `research/terrain/detail_trace_scan.py` | Components whose triangle count the distance table cut. Run it as: `python -m tools_py.research.terrain.detail_trace_scan <trace>` |
| `research/terrain/ee_compare.py` | Our guest RAM at the spawn view against the PCSX2 savestate's. Run it as: `python -m tools_py.research.terrain.ee_compare <ours.bin> <console.bin> [c8,ca;…]` |
| `research/terrain/eye_experiment.py` | Does the under-water fan's kick count depend on the cull's eye position |
| `research/terrain/fan_detail.py` | Parse a GIF packet stream for fan primitives (no docstring) |
| `research/terrain/fan_sizes.py` | Per stream, the terrain texture's fan packets and their first vertex |
| `research/terrain/lod_trace_scan.py` | Components the LOD band test rejected, with their distances. Run it as: `python -m tools_py.research.terrain.lod_trace_scan <trace>` |
| `research/terrain/node_trace_scan.py` | Pair each cull call with its scene node and find the node holding a point. Run it as: `python -m tools_py.research.terrain.node_trace_scan <trace> [x,y,z]` |
| `research/terrain/patch_dump.py` | Print one VU1 terrain dump's header and vertices (no docstring) |
| `research/terrain/terrain_dumps.py` | Terrain VU1 dumps: header counts, command list, the fans emitted |
| `research/terrain/unproject.py` | Fit the world→screen map and unproject the console's absent fans |
| `research/ladder/r242_speed_freeze.py` | R242: the two-instance speed freeze re-measured from the ladder streak's logs (KNOWN §1) |

> Superseded 2026-09-25 (Sprint 13 R2): the Layout table's `tools_py/` row said "Python tooling: Unicorn EE harness,
> APACHE00 decryptor, DNAS self-decryptor, ELF builder, Ghidra CSV fixers, screenshot helper" — six things, for a
> directory that held 172 modules (harness audit H50). The map above replaces it.

## Build and run (developer machine)
```
./build.sh recomp      # regenerate the ELF, normalise the function map, run ps2_recomp
                       # (273 s and 352 s, two runs on 2026-09-21 -- minutes, not seconds)
./build.sh runtime     # cmake+ninja, clang, LTO off -> dist/socom2.exe and the launcher
                       # (624 s and 983 s from an empty build tree, 2026-09-21; this line said
                       # "~15 min from scratch, ~3 min runtime-only" until 2026-09-25 -- the 3 min
                       # had no measurement behind it)
./build.sh test        # the Python suite first (unittest, verbose), then ps2x_tests and vu1_replay
                       # (builds both, copies vu1_replay to dist/) and replays the VU1 fixtures against
                       # their goldens, native path on and off, plus a --vram-diff equivalence check
                       # (checked=15 skipped=0; a [vu1_replay] WARNING about a texture inside the
                       # replay's blanked framebuffer/z region fails the suite). PS2X_TEST_REPEAT=N runs
                       # the C++ unit suite N times (determinism check).
python -m tools_py.parity.gate   # in-game gate: title / transition / mission, PASS or FAIL.
                       # Run `./build.sh runtime` first -- the gate launches dist/socom2.exe and
                       # `./build.sh test` does NOT rebuild it.
PS2X_PC_SAMPLER=5 ./run.sh 40    # run 40 s; logs/latest.log; prints guest thread PCs every 5 s
```
`build.sh` refuses (exit 3) while another holder has the loop lock unless it runs as that holder's child; `--dry-run` prints the plan.

> Superseded 2026-09-25 (Sprint 13 R2): the block above said `./build.sh recomp` took "~10 s" (the same file measured
> 352 s, and `docs/KNOWN.md` §1 273 s) and that `build.sh test` "runs NO Python tests: python -m unittest discover
> ... (by hand, for now)". `build.sh`'s `test_step` runs `python -m unittest discover -s tools_py/tests -t . -v`
> before the C++ suite, and has since Sprint 5 (`docs/HAZARDS.md` build, "`build.sh test` runs zero Python tests",
> struck as fixed) — documents audit rows 3 and 7.

**A re-recomp rebuilds only what changed (issue #57, 2026-09-26).** `./build.sh recomp` no longer deletes
`recomp/output/`: `ps2_recomp` rewrites a file only when its bytes change and removes the `.cpp`/`.h` files an earlier
run left that this one did not produce (`[recompiler] removed N stale output file(s)` in `recomp/recomp_run.log`). A
generated function file includes the runtime headers and then declares only the functions it tail-calls by name, one
`void NAME(uint8_t*, R5900Context*, PS2Runtime*);` line each, sorted; `ps2_recompiled_functions.h` and
`ps2_recompiled_stubs.h` are included by `register_functions.cpp` alone and are not in the runner's precompiled
header; the runner's unity batches (32 files) are ordered by the guest address each file name ends in, so a rename
keeps its file in its batch. Measured on the worktree build: a recomp with nothing changed rebuilds 0 objects; one
display name changed in `recomp/socom2_names.csv` rebuilds 2 (the function's batch and the table's) and relinks in
27 s; a name 17 files tail-call rebuilds 10 in 44 s; the full build is 622 s. `scripts/build_revision.sh` step 4 keeps
its `recomp/output_<rev>/` the same way (it removes only the `.complete` mark first). A clean rebuild of the generated code means deleting `recomp/output/` by hand; there is no
flag. The prune touches only the output folder itself (not its subfolders) and only the names the emitter writes
(`<name>_0x<hex>.cpp` and the four fixed files).

`./run.sh` is a developer-mode launch (`PS2X_DEV=1` unless set): it runs `dist/socom2.exe` (or `$SOCOM_EXE`) on
`game/disc/socom2_game.elf` (or `$SOCOM_GAME_ELF`) and writes `logs/run_<stamp>.log` (or `$PS2X_RUN_LOG`, which a
driver sets to tail the game's own `[peek]` rows), with `logs/latest.log` pointing at it.

### From your own disc to a buildable ELF — one command (2026-09-21)

```
bash scripts/disc_to_elf.sh "/path/to/SOCOM II - U.S. Navy SEALs (USA).iso"
```

`./build.sh recomp` reads `game/disc/SCUS_972.75`, `game/overlays/ftscore.bin` and `game/overlays/zsealetc.bin` and
writes `game/overlays/socom2_game.elf`. None of them is in this repository -- they are the game's own bytes -- and the
command above is how you produce all four from your own disc. About eight minutes and 4.2 GB the first time -- 473 of
those 483 seconds are the third stage, where the game decrypts itself on an emulated R5900 (2026-09-21). It verifies
every step, and a second run is a no-op that still verifies: if it stops, or you stop it, type the same line again and
it picks up where it left off. `python -m tools_py.disc_to_elf` is the same command with the same arguments; `--out
<dir>` writes the tree and the overlays somewhere other than `game/`, `--check` says which stages are already done,
`--force` redoes them, and `--stages extract,dnas,overlays,elf` runs a subset.

**What you need:** Python 3 with `python -m pip install -r requirements.txt` (its `unicorn` row, 2.1.4, is what
stages 2 and 3 need: they run the game's own decryption code on an emulated R5900); 4.2 GB free; and your own NTSC r0001 image (SCUS-97275). No 7z
and no other extractor -- the ISO9660 reader is part of the command.

| # | stage | what it does | measured 2026-09-21 |
|---|---|---|---|
| 1 | `extract` | the ISO's filesystem to `game/disc/` -- 349 files, 4173 MB. A plain ISO9660 reader (`tools_py/iso_lbn.py` still maps a file to its LBN when you need one by hand) | 8 s (4173 MB at 554 MB/s; minutes on a slower disk) |
| 2 | `dnas` | `OVERLAY/REL/DNAS.BIN` -> `DNAS.dec.bin`: `tools_py/dnas_selfdecrypt.py` runs each of the DNAS overlay's 131 self-encrypting code blocks through its own cipher under Unicorn | 2s |
| 3 | `overlays` | `RUN/RAW/APACHE00.ZDB` -> `ftscore.bin` + `zsealetc.bin`: `tools_py/decrypt_apache.py` runs the retail loader's own decryption (four emulated passes per blob; its docstring names the loader functions it mirrors) and inflates the result | 473s |
| 4 | `elf` | the loader + both overlays -> `socom2_game.elf`: `tools_py/make_overlay_elf.py` with the `--loader-text-end=recomp/loader_text_end.txt` that `build.sh recomp` also passes | 0.0s |

**What it prints.** The two emulated stages print thousands of progress lines; those go to
`game/disc_to_elf-dnas.log` and `game/overlays/disc_to_elf-overlays.log`, and what you see is:

```
extract: SOCOM II - U.S. Navy SEALs (USA).iso: volume 'SOCOM_II', 349 files, 4173 MB
extract: SCUS_972.75 is the r0001 boot ELF (sha256 0172dc0bec19c83d...)
  13% (543 of 4173 MB, 1293 MB/s)
  ... one line per tenth ...
extract: 349 files written, 0 already there (4173 MB in the tree)
dnas: decrypting the DNAS overlay's code blocks under Unicorn (a few seconds)
  (chatter -> game\disc_to_elf-dnas.log)
dnas: 131 blocks, 667136 bytes -> OVERLAY\REL\DNAS.dec.bin (2s)
overlays: running the loader's decryption under Unicorn (about eight minutes; four emulated passes over two blobs)
  (chatter -> game\overlays\disc_to_elf-overlays.log)
overlays: ftscore.bin + zsealetc.bin written, build id 'SOCOM 2 r0001 17:22:21 Oct 11 2003' (473s)
elf: merging the loader and the two overlays (loader text ends at 0x1d5000)
  (chatter -> game\overlays\disc_to_elf-elf.log)
elf: game\overlays\socom2_game.elf: 4835072 bytes, 4 segments, entry 0x180008, build id 'SOCOM 2 r0001 17:22:21 Oct 11 2003' (0.0s)
done in 483s. Next: ./build.sh recomp  (then ./build.sh runtime)
```

The second run of the same line, with everything already there, is the four "already there / matches -- skipped"
lines and `done in 0s`; `--check` prints one `ok`/`todo` row per stage and leaves with 0 only when every row is `ok`.

**What it checks.** `tools_py/disc_to_elf_expected.json` holds what the r0001 disc produces: the sizes and sha256
digests of the three files the chain reads and of everything it writes, the number of DNAS blocks, the ELF's entry
point and segment count, and the build id. `SCUS_972.75` is hashed **out of the image before 4 GB is written**, against
the same digest the launcher pins (`launcher::kSocom2R0001ElfSha256`), so a wrong disc costs you seconds. A value the
file does not hold yet is recorded and the run says so; a value that disagrees is a refusal naming both sides.

**When it refuses,** it prints one sentence saying what to do and leaves with a code from
`ps2x/exit_codes.h`: **66** the path is not a file; **67** not an ISO9660 image, a logical block that is not 2048, no
`SCUS_972.75` in the root, a boot ELF that is not r0001's, or a `DNAS.BIN` / `APACHE00.ZDB` / ZDB entry table that is
not the recorded one; **68** a merged ELF whose size, digest, entry point, segment count or build id is wrong; **2**
no Unicorn (it prints the `pip install` line), no Python, a bad argument; **1** a truncated image -- checked both from
the volume descriptor's own size and file by file -- or any other output that does not match what was recorded.

**Another revision of the disc -- `scripts/build_revision.sh` (Sprint 11 Task 9).** The chain above is r0001's;
`bash scripts/build_revision.sh <rev> <tree>/RUN/RAW/APACHE00.ZDB` runs the same pieces for any revision under names
that never collide with r0001's: `game/overlays_<rev>/{ftscore,zsealetc}.bin` and `socom2_game_<rev>.elf`,
`recomp/socom2_<rev>.toml` (`input`, `output` and `ghidra_output` rewritten), `recomp/output_<rev>/`,
`third_party/ps2recomp/build-clang-<rev>/` and `dist/socom2_<rev>.exe` with the ELF beside it. Each step is skipped
when its product is already there (`--force` redoes it) — the recomp and the runtime build skip only on the
`.complete` mark they write when they finish, so a tree left half-written by a failed run is redone rather than
reported as done; both take the loop lock themselves. `--stop-after elf|toml|recomp` stops early (`elf` and `toml`
take no lock at all; `toml` is the last step that does not, and it is how the tracked `recomp/socom2_r0004.toml` is
checked against the tree -- every other revision's derived config is git-ignored; `test_build_products.py`
regenerates r0004's from `game/r0004/match.json` and the two images with step 3's arguments and fails on a byte of
drift, skipping where those git-ignored inputs are absent, `SOCOM_DATA_ROOT` naming a checkout that has them), `--check-against <elf>`
compares the produced ELF's sha256 with a known one, `--out <dir>` puts every product under one directory
(`overlays_<rev>/`, `recomp_<rev>/`, `build-clang-<rev>/`, `dist/`) while the inputs stay the tree's (issue #56 (closed) 2026-09-26, `9b566459`):
the map is the tracked `recomp/socom2_ghidra_<rev>.csv` unless `--ghidra` names another, and when the tree's
`game/overlays_<rev>/` holds both overlays, the merged ELF and an `<elf>.repair.json` that is current for the run's
repair inputs (the sha256 test step 2 skips on), those four files are copied into `<out>/overlays_<rev>/` and
nothing is decrypted again -- the sidecar records no disc input, so the disc tree given is not matched, and
`--force` decrypts regardless.
`--dry-run` prints the six steps with their paths. `<rev>` is `r` and four digits with an optional suffix that
starts with a letter. The package must sit in its extracted disc tree, whose loader must be named `SCUS_972.75`
(`tools_py/decrypt_apache.py` joins that name onto the tree and runs that loader's own code on the package, after
making `OVERLAY/REL/DNAS.dec.bin` when the tree lacks it). The revision's function map
`recomp/socom2_ghidra_<rev>.csv` must already be there or be named with `--ghidra <csv>`: only an `r0001*` revision
falls back to r0001's map silently, any other revision has to ask for it with `--ghidra-from-r0001` and is warned
that the generated code will be wrong until the matcher (`tools_py/address_matcher.py`) writes that revision its own
map. The **forced entry points** are a per-revision input for the same reason (`recomp/extra_functions.txt` is 1,619
addresses, 1,453 of them inside the overlays): step 0 takes `recomp/extra_functions_<rev>.txt` when it is there, or
`--extra <file>`, else r0001's with a warning. `python tools_py/find_imm_targets.py <rev elf> <rev csv>
recomp/extra_functions_<rev>.txt` writes a revision its own.
**A build never writes its own inputs (since 2026-09-24, Sprint 11 Task 19).** Step 0 folds those forced entry points
into the map, cuts the non-contiguous ranges to size and applies `recomp/merge_ranges.txt`, and writes the result to
**`recomp/build/socom2_ghidra_<rev>.fixed.csv`** — a build product, under a git-ignored directory. Steps 2-5 all
read that file: the merged ELF is repaired against exactly the rows the recompiler will compile, the config's
`ghidra_output` names it, and `<elf>.repair.json` records its sha256. The tracked
`recomp/socom2_ghidra_<rev>.csv` is read, never written. `build.sh`'s r0001 lane follows the same rule since Sprint 13
Task C5: it writes `recomp/build/socom2_ghidra.fixed.csv`, which `recomp/socom2.toml`'s `ghidra_output` names, and
`fix_ghidra_csv.py` refuses to run without `--out` or with `--out` naming its own input (until then the lane rewrote
the tracked `recomp/socom2_ghidra.csv` in place -- a fixed point today, byte-identical, but issue #54's nested rows
are what that habit left in a tracked file). `tools_py/tests/test_build_products.py` reads `build.sh`'s recomp step
and holds every file it writes to an ignored, untracked path, so `git status` is empty after `./build.sh recomp`.
**The executable knows which pressing it was recompiled from, and refuses another one (Sprint 11 Task 19).** Step 5 passes `-DPS2X_GAME_REVISION=<rev>` to the cmake configure (`build.sh` passes `r0001`, the default chain's), so `PS2X_GAME_REVISION` is a PUBLIC compile definition on `ps2_runtime` and the recompiled game carries the revision its generated code came from. At boot, right after `socom2_addresses::selectFromImage` has read the loaded image's own build banner, `runtime/socom2_revision_guard.h` compares the two. They agree, or the image names no revision at all (an image this table has no column for): the run carries on, the second case with the r0001 fallback and its existing warning, unchanged. They name **different** revisions and the run stops on one line -- `[socom2] REFUSED: this executable was recompiled from r0004 but the image at <path> is r0001 (banner "..."); pass the matching image (SOCOM_GAME_ELF) or the matching executable` -- and the process leaves with **73** (`revision-mismatch`, `ps2x/exit_codes.h`, distinct from the preflight's 66/67/68). A refusal rather than a warning because nothing past a mismatch is meaningful: every override address, every static-constructor table and every function body belongs to the other build -- run anyway, such a pairing boots, walks one build's constructor table into the other's bodies and hangs at the loading screen with nothing in the log to say so (the guard since 2026-09-24). A `<rev>` with a suffix compares as its base, so an `r0001check` build belongs on an r0001 image.
**A revision's function map comes out of Ghidra with `bash scripts/ghidra_export_functions.sh <elf> <out.csv>`** —
the recipe that made `recomp/socom2_ghidra.csv` (stock ELF loader → `r5900:LE:32:default:default` from the EE
extension, `MakeFunctions.java` on the three entry points no flow reaches before analysis, then two
`FindPointerTargets.java` passes and `ExportPS2Functions.java`), written down from Ghidra's own log. It writes the
**raw** export; `tools_py/carry_names.py <match.json> <raw.csv> <out.csv>` then carries the named functions of an
older revision onto their matched addresses (`tools_py/address_matcher.py` says which) and leaves every
address-derived Ghidra name where it is.
**The recompiler's own config is a per-revision input too, and `tools_py/revision_toml.py` carries it over
(Sprint 11 Task 19).** Rewriting `input`/`output`/`ghidra_output` is three lines of `recomp/socom2.toml`; the other
~1,900 are r0001 guest addresses — the stub selectors `ps2_recomp` binds by start address, the 19 overlay
instruction patches, the 24 overlay jump-table sites, the `[mmio]` annotations — and in a build relinked from
changed source they point at whatever the new build happens to have put there. With an address match report
(`--match <json>`, or `game/<rev>/match.json` when it is there) step 3 runs
`python -m tools_py.revision_toml recomp/socom2.toml <match.json> --out recomp/socom2_<rev>.toml`, which moves a
function-start address by its own match, an address *inside* a matched function's body by that function's delta
(marked `(weak)` when the function was placed by `seed+delta` rather than by fingerprint), and leaves an address in
a region that is byte-identical in both images alone. Every line it rewrites carries the r0001 address and the
method in a comment; `--dry-run` prints the table and writes nothing. **Its limit is the matcher's:** what the
match report cannot place, this tool does not guess — the r0001 number stays, the line says `UNRESOLVED`, and the
address is listed in `[revision.unresolved]` with the role the config gave it, so the config states what it does not
know. The `[revision]` table names the two files it was written from **relative to the repository root** — that file
is tracked and step 3 rewrites it on every build, so one machine's absolute paths in it are a modification in every
other clone. Without a report the step copies-and-renames, and warns. On r0004 (2026-09-23): of the config's
1,985 addresses, 1,357 are in the loader and do not move, **91 of the remaining 628 were translated and 537 were
left as r0001's** (371 distinct addresses in `[revision.unresolved]`) — including all 24 overlay jump-table base
addresses, none of which is a function start in r0001's map.
**Proven on r0001 (2026-09-23):** `bash scripts/build_revision.sh r0001check game/disc/RUN/RAW/APACHE00.ZDB
--check-against dist/socom2_game.elf` -- the ELF identical (sha256 `06b83684...8872`), `diff -rq --exclude=.complete` of the 14,882
generated files against `recomp/output` empty, the exe built (236,856,320 B; not byte-identical to `dist/socom2.exe`,
which embeds its own build's paths and source revision). Measured in that run (2026-09-23): DNAS 2 s, the decryption
6.5 min, the ELF instant, the runtime build about twenty minutes from a cold build tree; the recomp's time was not
recorded (the r0001 recomp's measured time is the build block's, 273 s and 352 s on 2026-09-21).
> Superseded 2026-09-25 (Sprint 13 R2, fix round 1): this listed "the recomp seconds" -- the same claim the build
> block's "~10 s" made, which two measured runs put at minutes (documents audit row 7).

### Build, run, verify — a newcomer's first hour

**Without a disc (any fresh clone):** `bash scripts/bootstrap_windows.sh` puts the pinned llvm-mingw, CMake and Ninja
under `tools/` (sha256-verified, ~245 MB once; `--check` says what is there), `python -m pip install -r requirements.txt`
installs the pinned Python packages, then `./build.sh runtime --no-runner` builds the runtime library and the launcher and `./build.sh test --no-runner` runs both suites and the VU1 fixture
verify. That is what the `windows` and `linux` workflows do. Since Sprint 13 C1 their `build` / `build-windows` jobs
also run `bash scripts/build_synthetic_runner.sh --build-dir <the job's tree>`: the runner (`ps2EntryRunner`) is
configured against `tests/fixtures/synthetic_recomp/` -- three hand-written functions in the recompiler's shape (an
entry, a leaf, a stub wrapper) with the function table and the two generated headers, nothing from the disc -- so the
files only the runner compiles (`game_overrides_socom2.cpp`, `socom2_crypto.cpp`, the host input, libnetb and host
socket files, `main.cpp`) compile and link on every code push, and the linked runner must refuse a missing ELF with
68 (`elf-missing`). Before C1 nothing on CI compiled them (the 2026-09-25 audit, `code-runtime.md` F7): a syntax
error in the overrides file reached `main` unbuilt. Run with no `--build-dir` locally it uses its own tree
(`build-synthetic` / `build-linux-synthetic`), never `build-clang`, whose real generated set would be recompiled on the
way back; `tools_py/tests/test_workflows.py` pins the step and the fixture's shape. The Python harness, the
documentation checks and the leak check also need no disc. **Everything else needs your own r0001 disc:** the disc chain above, `./build.sh
recomp`, a `./build.sh runtime` that builds the game, and the gate.

**The dependencies are pinned to bytes** (Sprint 13 C6; `tools_py/tests/test_supply_chain_pins.py` fails on one that
is not). Each CMake `FetchContent_Declare` names a full 40-hex commit in `GIT_TAG`, the tag's name in a comment
beside it (resolve a new one with `git ls-remote <repo> <tag> '<tag>^{}'`; the `^{}` line is the commit of an
annotated tag), and never with `GIT_SHALLOW TRUE` (a shallow clone cannot check out a bare commit). The Windows
FFmpeg is `ffmpeg-7.1.5` of System233/ffmpeg-msvc-prebuilt with a `URL_HASH SHA256=` (a bump: `gh api
repos/System233/ffmpeg-msvc-prebuilt/releases/tags/<tag>` gives the asset's `digest`; download the file and check
`sha256sum` matches it). CI's `pip install` takes `==` pins (through the root `requirements.txt`).
`linux.yml`'s `apt-get install` is deliberately not version-pinned -- a -dev pin holds back a runtime package the
runner image upgrades itself, which ends in a downgrade conflict -- so the step records the last green run's
versions in a comment and prints the FFmpeg family's installed versions (`dpkg-query -W`) into every run's log; the
Linux release tarball is built in the socom-linux VM, not on CI. A pin change moves `THIRD_PARTY_NOTICES.md` in the
same commit (its test walks the release DLLs and the Linux tarball's `lib/`, both ways); an FFmpeg move is a
runtime build, `./build.sh release` (so `dist-release/` drops DLLs the new closure no longer has) and the gate 3/3,
the movies playing.

> Superseded 2026-09-25 (Sprint 13 R2): a line here said "Everything below this line works on a fresh clone with no
> disc at all", above a table whose rows 1, 2 and 5 (`./build.sh recomp`, the game build, the gate) need the disc
> (stranger audit S36).

**Reading a CI run** (Sprint 13 H1, pinned by `tools_py/tests/test_workflows.py`). GitHub calls a run `success` when
any job in it passed and `skipped` only when every job was skipped, so the word alone never said whether anything
was built. What each case now looks like: a push touching only `docs/` starts **no** `linux` or `windows` run --
`gh run list --commit <sha>` shows `secrets` and `docs` (`python -m tools_py.docmaint` and the doc tests, which read
the real `docs/` tree; not a required check), and the absence of `linux`/`windows` is the "not built" signal; any
other push runs `changes` then `build` / `build-windows`, so its `success` means built and tested. A pull request
always runs both build workflows (`build`, `build-windows` and `leakcheck` are `main`'s required checks and must
report), and its `changes` job compares the pull request's `base.sha...head.sha` -- three dots, from the merge base,
so the whole branch counts and `main`'s own movement since the fork does not -- and the step's first log line says
`pull_request: comparing <base>...<head>`. A docs-only pull request is the one green run with nothing built: read the
job list (`gh run view <id>`), where the build shows as skipped. A pull request's check list mixes its
`pull_request` runs with the branch's `push` runs on the same commit; before H1 a docs-only last push put a `build
skipping` row beside the pull request's real build (PR #50, runs 36110474156 and 36110478507) -- the `pull_request`
row is the one that answers "was this branch built".

**How long the whole thing takes, measured.** On 2026-09-21 the entire newcomer path was run from a genuine `git clone`
of this repository into an empty directory on a 28-core Windows machine, nothing pre-existing, and every step passed:
clone 5 s (115 MB) · `install_hooks.sh` 1 s · `bootstrap_windows.sh` **16 s** from no cache at all (the real download;
1126 MB of toolchain on disk) · `--check` 1 s · `build.sh runtime --no-runner` **392 s** · `build.sh test --no-runner`
**339 s** (764/764) · the Python suite **280 s** · `disc_to_elf.sh` **415 s** · `build.sh recomp` **352 s** ·
`build.sh runtime` **624 s** → `dist/socom2.exe`, 236,852,224 bytes. **42 minutes from `git clone` to the game**, and
about 15 GB of disk for the clone, the toolchain, the disc tree, the generated code and the build trees. (That run
timed `build.sh test` and the Python suite separately; `build.sh test` runs the Python suite itself, so on today's
tree the one command costs both.)

The Linux side, in the VM (`socom-linux`, 8 cores of the same host, llvmpipe), 2026-09-23: `scripts/build_linux.sh runtime` from **wiped** build trees **1261 s** → `dist-linux/socom2` and the launcher; the test step (both suites) **284 s** — and not green there yet: the Linux-only residue is `docs/KNOWN.md` §2's row of that date (issue #25). The tree reaches the VM by `scripts/vm_sync.sh tree` (seconds; since 2026-09-23 it also prunes what the host removed).

With a disc, five commands, in this order, on a clean checkout with the tools under `tools/` on the PATH
(`export PATH="$PWD/tools/llvm-mingw/bin:$PWD/tools/cmake/bin:$PWD/tools/ninja:$PATH"`; `build.sh` does this itself) and the disc image at
your own ISO (the command in the previous section puts the disc tree and the overlays where these expect them). The
expected lines are the ones to look for; each count carries the date and the tree it was read on, and the test counts
only ever grow, so more than the number here is fine and fewer is a regression to report.

| # | command | the line that says it worked |
|---|---|---|
| 1 | `./build.sh recomp` | `recomp: 14882 files, unhandled=114399, unmapped=<n>` — and `Recompilation completed successfully` at the end of `recomp/recomp_run.log`, which also carries `Loaded 1871 display names from socom2_names.csv` (2026-09-25, after Sprint 13 N1; r0004's reads `Loaded 1736`; the number grows with the sidecar — its absence means the names were not applied and every function is still `FUN_`/`sub_`). **`unhandled=` is not a failure**: it counts `unhandled-instruction` lines in the log, which the recompiler emits and carries on from, and the exe built from exactly this generated code is the one the gate passes 3/3 on (measured twice on 2026-09-21, identically, in two working trees). What would be a failure is a non-zero exit (the last 20 log lines are printed then) or a file count that fell. `unmapped=` (since 2026-09-24) counts `unmapped-continuation` warnings: continuation pcs — a call's return, a syscall's return, a not-taken branch's fallthrough — that no recompiled row owns, each one a `[guest-branch:missing-target]` waiting for a thread to reach it. It is read, not gated, like `unhandled=`; r0001 printed `unmapped=0` on 2026-09-24 (chain 18), and a value that climbs after a map change is the map's holes, not the recompiler's. |
| 2 | `./build.sh runtime` | `built dist/socom2.exe` (the launcher lands beside it) |
| 3 | `./build.sh test` | First the Python suite's `OK` (row 4), then `Total Tests: 1025` / `Passed: 1025` / `Failed: 0` (2026-09-27 19:5xZ, the batch-3 merged chain `s16_b3` on `aa030d1a`; before it 969 on the `build-windows` run 36305306914 of #74's merge ref, the tree `main` became at `bb675dbd`; its Linux count was 971 — the Linux build runs two platform-guarded cases more, so a Linux count two above this is not a mismatch. Before: 967 on `8b65501` (run 36305304109); 966 on `9bb8511` (run 36303145546); 964 on `6168f2e` (run 36300160191); 940 on 2026-09-25 23:31Z, this machine, the tree at `2eca9389`, Sprint 13 V3's green run), then `PASS: vram diff against 1.00% tolerance, checked=15 skipped=0` |
| 4 | `python -m unittest discover -s tools_py/tests -t .` | The same suite `./build.sh test` runs first — run it alone when you changed only Python. **`OK`, with no failures, is the bar** — match that, not a number. The count only ever grows: 3766 tests, `OK` with 161 skipped (2026-09-28 10:36Z, this machine, the tree at `69be57cc`, web sprint 2's tip with its speed probe's two modules, 85 tests; 3530 with 93 skipped at `3bdf80e8` on 2026-09-26). Before it: `Ran 2795 tests` (2026-09-25, the tree at `eb190a42`, this machine and the Windows runner; the Linux runner ran 2797 at the same head). The **skip** count is not a constant and is not worth matching, because cases skip on what you have (a disc extracted into `game/`, a worktree without one). |
| 5 | `python -m tools_py.parity.gate --stamp first_run` | `GATE PASS (3/3) -> logs\parity\gate\first_run` (15 to 17 minutes: three gates on 2026-09-25 took about 15, 17 and 16 — `s12_names_gate`, `s11_close_gate`, `s12_names_r0004_gate`, from the first file each wrote under `logs/parity/gate/<stamp>/` to its `summary.txt`; the game window opens and closes three times; do not touch the keyboard) |

> Superseded 2026-09-25 (Sprint 13 R2, fix round 1): rows 1, 3 and 4 carried every earlier count (881, 880, 876 and
> 764 C++; 2553, 1832, 1723 and 1104 Python; three skip counts) and three "this row said ... until 2026-09-21" notes
> (`unhandled=0`, the C++ 500, the Python 1104 / `skipped=63`). One dated count per row stays; the earlier ones are
> in this file's git history (`git log -p -- docs/DEVELOPING.md`).
>
> Superseded 2026-09-25 (Sprint 13 R2): row 5 said "about 15 min", README said "about 15 minutes" and HANDOFF's
> per-stage figures add to 17 (documents audit row 39); the three measured gates above are the reading.

**The Python packages** are `requirements.txt` at the root, pinned: `python -m pip install -r requirements.txt` (numpy,
pillow, zstandard, unicorn, capstone, PyYAML; on Windows also pycaw, comtypes, psutil and PyAudioWPatch for the audio
tools). CI installs exactly that file on both runners; `tools_py/tests/test_requirements.py` fails on an import the
file lacks, a row nothing imports, an unpinned row or a workflow that installs by hand. There is no pytest: the runner
is unittest.

**The fast subset** (Sprint 13 H7): `python -m tools_py.tests.fast` runs every test that needs no build product and no
disc and is not in a module measured slow -- 2360 tests, `OK`, **84 s** wall on this machine (2026-09-25, the tree at
H7's commits), against about eleven minutes for the whole suite. It is the check to run while somebody else holds the
lock: its command line is not on `scripts/loop_lock.sh`'s busy list (a python whose command line says `unittest` or
`tools_py.parity` is), and `tools_py/tests/test_fast_subset.py` pins that. What it leaves out is `EXCLUDED` in
`tools_py/tests/fast.py`, each entry with its reason: the modules that took 10 s or more alone (the bash-, git- and
process-driving ones) and the cases that need `dist/`, `dist-release/`, the launcher, the .NET server or `game/`. A new
test file is in the subset until it is measured slow. `--list` prints the modules, `-v` the verbose runner. Row 4 (the
whole suite) is still the bar before a commit that touches anything the subset leaves out.

**The gate's fixtures** (`tests/fixtures/gate/`, what `tools_py/tests/test_gate.py` scores on a fresh clone) are 102
files, 3.37 MB (2026-09-25, H7's review round; 106 files and 3.69 MB before identical captures were stored once --
a fixture's `shared.txt` lists `<name> <kept name>` and `make_gate_fixtures.materialize` expands it). They are rebuilt
from real runs by `python -m tools_py.parity.make_gate_fixtures [--only BUILDER ...] [--search DIR ...]`, which scores
each fixture and refuses one that does not reach its source run's verdict.

`python -m tools_py.docmaint` checks the documentation registry (`docs/DOC_MAINTENANCE.md`): every document
classified, the ruling counter one past the highest in use, no undated suite count outside **this file**, every
snapshot dated and every archive banded, every ruling number defined once and every cited one defined. It needs no
build and the Python suite runs it; **this table is the single source for the suite counts, which is why no other
document may state one without a date beside it.**

`python -m tools_py.parity.gate --baseline first_run` re-scores that saved run without launching, which is the
fastest way to check a scoring change. A gate refuses to start under 4 GB free on C: (`RUN_MIN_FREE_GB`) and
while another launch holds the loop lock (`scripts/loop_lock.sh status`). **Freshness (Sprint 14 E4):** a launch also
refuses when the exe (`dist/socom2.exe`, or `$SOCOM_EXE`) is older than the newest file it is built from. For every
revision (`gate.FRESHNESS_COMMON`): under `third_party/ps2recomp/`, the top-level `CMakeLists.txt`, and for
`ps2xRuntime` (which carries the `ps2x_snd989` sources in `src/lib`), `ps2xIOP`, `ps2xShared` and the recompiler
`ps2xRecomp` their `CMakeLists.txt`, `src` and `include` (plus `ps2xRuntime/cmake`); `build.sh`,
`tools_py/make_overlay_elf.py`, `tools_py/fix_ghidra_csv.py`, `recomp/loader_text_end.txt` and
`recomp/merge_ranges.txt`. Then that revision's own inputs only (`gate.FRESHNESS_BY_REVISION`). For r0001:
`recomp/output`, `socom2.toml`, `socom2_ghidra.csv`, `socom2_names.csv`, `extra_functions.txt` and
`game/overlays/socom2_game.elf`. For r0004: `recomp/output_r0004`, `socom2.toml` (the source of the derived toml),
the `_r0004` toml, csvs and extra-functions list, `scripts/build_revision.sh`, the tools it runs and
`game/overlays_r0004/socom2_game_r0004.elf`. So `build_revision.sh r0004` rewriting its tracked toml never refuses an
r0001 gate. **The revision** is read from the exe's own path: `socom2_r0004.exe`, or a folder named for it
(`dist-r0004/socom2.exe`); neither means r0001. **The tree** is the exe's own: the nearest directory above it that
holds `build.sh`, so a gate run from the main tree against a worktree's exe compares that worktree's sources (this
checkout when there is none). Still outside the set: the build configuration in the CMake cache (`PS2X_GENERATED_OPT`,
LTO), the compiler, and the FetchContent/ffmpeg downloads -- each changes only with a deliberate reconfigure. A stale
exe prints `gate: exe older than source (<exe mtime> < <path> <mtime>): rebuild, or --stale-ok`, before the lock and
before anything is written.
`--stale-ok` launches anyway and the summary carries `gate: STALE exe accepted (--stale-ok)`; the merged-chain
template never passes it. Every summary and `pins.json` carries `TREE <head> dirty=<n>` (the short HEAD and the count
of `git status --porcelain` lines outside `logs/` and `game/`), so a record says which tree it measured. The gate's
exit codes: 0 PASS, 1 a stage FAILed, 2 the lock busy, 3 low disk, 4 a `--baseline` with nothing to score, **5 a
stale exe**, 7 a pin drift, 8 an unknown revision. Anything else: `docs/CHANGELOG.md` has what merged and
the plan's Log why, `docs/KNOWN.md` what is proven and what is believed, `docs/HUMAN_TASKS.md` the checks only a person can do.

**The pinned references (Sprint 13 H3):** `scripts/parity/pins.json` (r0001; `pins_r0004.json` for r0004) is the gate's standard and the gate refuses on a drift; `scripts/parity/pins_refs.json` pins every OTHER reference PNG under `scripts/parity/` -- a tripwire, not a refusal: `test_gate_pins.EveryReferenceIsPinned` fails the suite when one changes and the file does not, so re-pin in the same commit.

## Recompiler reference

Since Sprint 14 Task E3 the `linux` workflow's `recomp-ref` job re-derives a synthetic program on every code push:
it builds `ps2_recomp` alone (`-DPS2X_BUILD_RUNTIME=OFF -DPS2X_BUILD_ANALYZER=OFF -DPS2X_BUILD_TEST=OFF`, `--target
ps2_recomp`), runs it on `tests/fixtures/recomp_ref/` and `diff -r`s the output against that directory's `expected/`.
**Any difference fails the job and prints the diff** -- a codegen change nobody meant, and equally one somebody did
mean but did not regenerate. It is not a required check.

The fixture is synthetic, nothing from the disc: `make_fixture.py` writes `input.elf` (4,268 bytes; ps2xTest's
Sprint 12 3b ELF -- eight MIPS words at `0x00100000`, a `jal 0x00100010` and two returns), `functions.csv` (a
two-row Ghidra-shaped map), `names.csv` (one sidecar row naming `0x00100010` `sceVu0MulMatrix`) and
`recomp_ref.toml` (`recomp/socom2.toml`'s shape). `tools_py/tests/test_workflows.py` holds the inputs to the
generator's bytes, `expected/` free of absolute paths, dates and the game's addresses and LF in the index, and the
job's shape. ps2_recomp resolves the toml's paths against the **current directory**, not the toml's, so it runs in a
copy of the fixture and writes `out/`; the output carries no path but the sidecar's file name, no date and no host.
The recompiler writes text-mode files, so a Windows run's `expected/` is CRLF in the working tree; `core.autocrlf`
makes it LF on `git add`, which is what the Linux job compares (a CRLF blob fails `test_expected_is_lf_in_the_index`).

**When a codegen change is intended**, regenerate `expected/` in the same commit, with a recompiler built from that
tree (`./build.sh tools`; on Linux `scripts/build_linux.sh tools` and `build-linux-tools/ps2xRecomp/ps2_recomp`):

```bash
RECOMP="$PWD/third_party/ps2recomp/build-tools/ps2xRecomp/ps2_recomp.exe"    # llvm-mingw's bin/ on PATH, as build.sh sets
python tests/fixtures/recomp_ref/make_fixture.py                             # only when the inputs change
WORK="$(mktemp -d)" && cp -r tests/fixtures/recomp_ref/. "$WORK" && rm -rf "$WORK/expected"
(cd "$WORK" && "$RECOMP" recomp_ref.toml)
rm -rf tests/fixtures/recomp_ref/expected && cp -r "$WORK/out" tests/fixtures/recomp_ref/expected
git diff --stat -- tests/fixtures/recomp_ref/expected                       # the change you meant, and only it
```

## Instruments and diagnostics

*(Moved verbatim from `docs/HANDOFF.md` §7 on 2026-09-26, Sprint 14 I3, when HANDOFF became transient; the file as it was is `docs/archive/HANDOFF-to-2026-09-26.md`. "Section 7" in an older citation means this section.)*

- **Developer mode (Sprint 10 Q2, 2026-09-21).** Every recipe below that sets a `PS2X_*` probe works through `./run.sh`
  unchanged (it is a developer-mode launch: `drive.py` adds `PS2X_DEV=1` below the gate's env pin, R203) and needs
  `--dev` or `PS2X_DEV=1` when the runner is started any other way -- a stranger's environment cannot switch a probe
  on (proved by `s9_g3_poisoned_env`: six probes set, `[knobs] dev=0 ... ignored without --dev: <the six>`, the game
  ran 90 s clean). `docs/KNOBS.md` is the list. Five names are gone and will still appear in STATUS's history:
  `PS2X_GS_TEX_FROM_CPU`, `PS2X_GS_PROBE`, `PS2X_GS_GL_DEBUG_NODEPTH`, `PS2X_MPEG_PIC_TRACE` and `PS2X_TIMER_*` (the plan's Task 6
  commit names them exactly), plus two ghosts the README had already lost.

- **The leak check** (`python -m tools_py.release.leakcheck <mode>`; modes `tree`, `staged`, `ignored`, `metadata`,
  `history [range]`, `artifact <dir>`, `all`): exit 0 clean, 1 findings, **2 the scanner did not run -- never a
  pass**. Every run starts with a planted control of 28 secret shapes; `--reveal` shows a hit unmasked on the terminal;
  `--json FILE` writes the masked report. `tree` ~20 s, `history` ~16 s over 920 commits. Rules: `leakrules.py`;
  decisions: `leak_allow.txt`; tests: `tools_py/tests/test_leakcheck.py` (25). gitleaks is CI's second opinion
  (`.gitleaks.toml`), a local copy runs in ~2 s: `gitleaks git --log-opts=--all --redact .`.

- **Build:** `./build.sh tools | recomp | runtime | release | test | all` (Git Bash; `all` = recomp + runtime).
  Runtime about 3 minutes incremental, 10-15 for a header change or a full generated rebuild. Linux:
  `scripts/build_linux.sh [tools|runtime|release|test|all] [--no-runner]`. Release kind: `PS2X_RELEASE_KIND=player`
  (default; `dist-release/`) or `developer` (`dist-release-dev/`; `dist-linux-release[-dev]/` on Linux). Packaging:
  `scripts/make_portable.sh [--release]` (both kinds' archives when both are built), `scripts/make_server_zip.sh`.
- **The gate** (`python -m tools_py.parity.gate`, `--only <stage>`, `--stamp <name>`, `--baseline <stamp>` to re-score
  without a launch; `SOCOM_EXE` points it at another exe): title about 3 min, transition about 3, mission about 11.
  The project's only regression bar. Refuses under 4 GB free on C: (exit 3) and on an exe older than its sources
  (exit 5 unless `--stale-ok`). Results under `logs/parity/gate/<stamp>/`, each with its `TREE <head> dirty=<n>` line.
- **The merged chain** (`scripts/parity/merged_chain.sh`, Sprint 14 W2) is the gate unit: recomp, runtime, the suites,
  the gate on the exe it just built, the fourth leg (its references, when present; named only in the gate), a release
  build, then the release archive and PLAYTEST's block (`scripts/parity/playtest_block.sh --release`, over
  `python -m tools_py.playtest_block`),
  run once per batch of merged branches, from a copy, under one holding of the lock (its header says how); a green
  end writes the commit it proved to `logs/merged_chain.last_green`. The four generated pages -- `docs/RULINGS.md`,
  `docs/CHANGELOG.md`, `docs/SITTING.md`, `docs/FLOW.md` -- are written by `python -m tools_py.rulings`, `changelog`,
  `sitting` and `flow`, and each one's `--check` exits 1 when the page on disk differs from a fresh render.
- **The ladder** (`scripts/parity/ladder_frostfire.sh`, pins HEAD's harness first) and **control rounds**
  (`scripts/parity/online_control_round.sh "<map>"`): two instances, online, against our server only.
  `scripts/parity/env.sh` sets the server address for the harness. `mixed_match.sh` (ours against PCSX2) **runs both ways on
  the hosted server** -- the console joins a game we host and we join a game it hosts, both proven 2026-09-20
  (Sprint 10 Goal 3; `docs/KNOWN.md` §1, `logs/parity/mixed2_ours_hosts_d` and `mixed2_pcsx2_hosts_f`). This line
  said it had never produced a result until 2026-09-23.
- **Audio (rebuilt 2026-09-20, Q0/Q1):** the ear's path is measured now, not the mixer's. `tools_py/parity/audio_envelope.py`
  scores any WAV reference-free (envelope oscillation, splices, silences, sub-second holes); `loopback_record.py`
  records what Windows sends to the default endpoint (WASAPI loopback -- this is what the owner hears);
  `stream_events.py` reads the runtime's stream trace (`[audio] 989snd stream <h> start|done|UNDERRUN frame=N`, on
  the WAV clock) into boundary gaps and starvation per stem; and **`scripts/parity/audio_parity.sh capture|compare`**
  is the audio parity check against PCSX2: the same step script on both targets, per-step windows scored, ours
  compared to the console's pinned scores (`scripts/parity/refs/audio_<script>.pcsx2.json`) with tolerances --
  PASS/FAIL per window. `audio_corr.py` (correlation, `--repeat`) still exists for the title path. The old driven
  dump alone (`PS2X_AUDIO_DUMP`) cannot see the device path; record the endpoint beside it.
- **The LLE oracle (Sprint 15 T1c, 2026-09-26):** `docs/research/assets/70-lle-oracle/README.md` -- an adopted
  out-of-tree oracle, never the product: #254's LLE IOP runs the disc's own `989SND.IRX` and the replay driver compares
  its RPC answers with our HLE's from a run log. The README holds the build (from a scratch clone, under the lock) and
  the replay steps; `tools_py/tests/test_lle_oracle_assets.py` (9) pins what landed: the files, the README's fork commit and numbers,
  no machine path and no disc bytes.
- **Run recipes, the env-gated diagnostics list, landmarks and gotchas from the first two weeks:**
  `docs/archive/HANDOFF-reference-to-2026-09-13.md` ("The run you will repeat", "Diagnostics", "Gotchas",
  "Landmarks"). Every recipe there that sets a `PS2X_*` probe works through `./run.sh` unchanged; a runner started
  any other way needs `--dev` or `PS2X_DEV=1` for a probe to be honoured (developer mode, since 2026-09-21).
  > Superseded 2026-09-25 (Sprint 13 R2): this said "once Goal 3 lands"; it landed as Sprint 10's Q2 on 2026-09-21
  > (the first bullet of this section) -- documents audit row 18.
- **The ladder, scheduled (Sprint 10 Goal 1) -- retired 2026-09-26 (R294, R296):** the Task Scheduler entry `SOCOM
  Unzipped ladder` stays disabled, and the online tests run when a task needs them. What the entry fired, kept for a
  hand-started run: `scripts/ladder_job.sh [rounds]` -- quiet gate, lock free, no game, then
  `scripts/parity/ladder_frostfire.sh` pinned and detached against the hosted server, then
  `tools_py/parity/ladder_ledger.py add` -- one record per run in `logs/ladder/ledger.jsonl`, the three rates and
  the clean streak rendered to `docs/LADDER.md` (a person commits it). The bar is seven consecutive runs with no
  LOBBY-FAIL and no CRASH.
- **Logs:** `logs/` is 27 GB and git-ignored. `scripts/archive_logs.ps1` (dry-run by default; refuses to move anything
  KNOWN §1 names as evidence) has not been applied since it was written. Run its dry run, read it, then `-Apply` in a
  quiet window -- it is filler, and it is evidence you are moving, so read before you apply.
- **Bug reports:** `.claude/skills/s2u-bug-reports/` (git-ignored, local). Read its SKILL.md before use.
- **The known-issue stack** (2026-09-23): `python -m tools_py.issues skeleton | check-body | open | close | audit`
  over the repository's issues labelled `known-issue`, one milestone per sprint. `audit` exits 0 or names the row,
  citation, label or body that is wrong; `--json FILE` replays a saved `gh issue list` listing offline.
- **The hosted box:** agent instructions are git-ignored in `vm/lightsail/README.md`. It is the server session's.

## Measuring a change without a chain

*(Owner's word 2026-09-28 ~21:00Z, ruled as this sprint's defaults in R334; the plan's Global Constraints cite this
section. It goes between "Instruments and diagnostics" and "Knobs".)* A performance attempt is measured on the
cheapest rung that can decide it, and only adoption and the day's proof pay for the dear ones. Each rung below says
what it decides, its metric, its command and what enforces it; **gap** marks a rule that nothing refuses yet.

**The ladder, cheapest first.**

| Rung | Cost | Decides | Metric |
|---|---|---|---|
| 1. The replay bench | minutes, no game | a draw-path change's first read: worth an exe or not | the bench's own time per replayed frame |
| 2. One mission walk, knob off then on, one exe | ~25 min, one holding | **the attempt pick** | `SYNCV mean=` (the game's own frame rate); the phase's ms/s beside it |
| 3. The full gate | ~17 min + the build of the new default | **adoption** (the default flipped) | 3/3 `PINS MATCH`, and the fence of the plan's "A failing test first" bullet |
| 4. The merged chain | ~90 min | **the day's proof** of everything merged that day | all green, `logs/merged_chain.last_green` |
| (close) Three quiet gates, one exe | three gates | the sprint's frame-rate bar (R322, F6) | `FRAME mean=` / `worst1s=` |

- **Rung 1, the replay bench:** a headless replay of a recorded GS stream through the draw path. **Gap:** it is
  being built on `agent/s17-replay-bench` (no commit at 2026-09-28 21:07Z); until it merges the ladder starts at
  rung 2, and its command and metric are written here in the commit that lands it.
- **SYNCV decides a pick, host-ms decides only the close.** `FRAME` is host ms per guest VBlank and drifts with host
  load (about 20 % between single gates: the controller's estimate on 2026-09-28, no `docs/KNOWN.md` row); `SYNCV`
  counts the frames the game drew (`[vu1-stats] syncv/s` over the same walk, `tools_py/parity/frame_time.py`). A
  pick compares knob off and knob on **inside one holding**, back to back; a difference near the attempt's stop rule
  is run again in the reverse order before it is ruled. The phase's ms/s (`python -m tools_py.parity.submit_split`,
  `PS2X_GS_STATS=1`) says why SYNCV moved; it is not the decision. Home: R334. **Gap:** nothing refuses a pick made
  on host-ms or across two holdings.

**An attempt is a knob on one exe, not a build.** An attempt lands behind a Dev knob in
`third_party/ps2recomp/ps2xShared/include/ps2x/knobs.h` whose default is the old behaviour (the precedent: Sprint 16
F2's `PS2X_GS_RT_TEXTURE`); `python -m tools_py.knobs write` regenerates `docs/KNOBS.md`, and
`tools_py/tests/test_knobs_registry.py` fails on a read with no row. With the default off, the attempt changes
nothing, so it merges on its review and module tests, and every pending attempt shares the one exe the day's chain
builds; each rung-2 run flips one knob. Adoption is a one-line commit flipping the default, then rung 3 on the exe
built with it. A second attempt on the same phase waits for the first's ruling (one knob per run, never two).

**The gate cannot take a knob today.** The gate pins the `PS2X_*` environment of its mission stage
(`tools_py/parity/pins.py` `env_pin`, standard `scripts/parity/pins.json`), so
`PS2X_GS_STATS=1 python -m tools_py.parity.gate --only mission` refuses with exit 7 (`pins drifted: env`) before it
launches, and `--accept-pins` would rewrite the shared standard (a ruling, never a reflex). **Gap:** no gate flag
declares an attempt knob as recorded-not-compared. Until one exists, rung 2 is the gate's own mission drive with
the gate's mission environment, laid out as a stamp so `frame_time` reads it (the shape of Sprint 16's
`logs/s16_controller/s16_f2_ab.sh`). A copy under `logs/`, never edited while it runs:

```
#!/usr/bin/env bash
# logs/<seat>/<attempt>_ab.sh -- rung 2: the mission walk with <KNOB> off, then on, on ONE exe, one holding
set -u; cd /c/Projects/socom_pc || exit 2
A=logs/parity/ab/<attempt>
kill_drivers() { powershell -NoProfile -ExecutionPolicy Bypass -File scripts/kill_stale_drivers.ps1 >/dev/null 2>&1; }
walk() {   # <side> [KNOB=value]
  local out="$A/$1"; shift
  rm -rf "$out"; mkdir -p "$out"; cp -r game/disc/mc0_parity "$out/mc0"; kill_drivers
  env "$@" PS2X_MC_DIR="$out/mc0" PS2X_HOST_GAMEPAD=0 PS2X_PC_SAMPLER=1 PS2X_VU_STATS=1 PS2X_GS_STATS=1 \
      PS2X_RUN_LOG="$out/mission.game.log" \
      python -m tools_py.parity.drive --target ours --script scripts/parity/gameplay_probe.txt \
      --out "$out/mission" --seconds 480 --tail 170 > "$out/mission.drive.log" 2>&1
}
walk off; walk on <KNOB>=<attempt value>; kill_drivers
python -m tools_py.parity.frame_time "$A/off" "$A/on"
```

launched as `RUN_MIN_FREE_MEM_GB=4 bash scripts/run_detached.sh --owner <seat> --purpose "launch: <attempt> A/B"
--wait 60 logs/<seat>/<attempt>_ab.sh logs/<seat>/<attempt>_ab.detached` (a `launch` purpose writes the quiet
marker). The readout is `frame_time`'s `SYNCV` line per side, then
`python -m tools_py.parity.submit_split $A/<side>/mission.game.log --from <HUD t> --to <last step t>` for the
phase. The Log line names the exe hash, the knob, both SYNCV means and the stop rule's verdict; TRIED, NOT ADOPTED
is an outcome. A game run still needs a window the owner named (O20, R297).

**Profile before designing the next attempt.** The next attempt is designed from a sampled profile of the GL thread
over the walk, so attempts are ranked by measured cost, not by guess (F1 Step 1's ranking, 2026-09-28, moved
`setup` above `resolve` that way). The same walk, the profiler on the main (GL) thread; the histogram
(`PS2X_HOST_PROF_OUT`) is rewritten every 10 s, so a copy taken at the HUD step isolates the walk:

```
out=logs/parity/prof/<name>; rm -rf "$out"; mkdir -p "$out"; cp -r game/disc/mc0_parity "$out/mc0"
( until grep -q '^s28_' "$out/mission.drive.log" 2>/dev/null; do sleep 5; done
  cp "$out/hostprof.txt" "$out/hostprof_pre.txt" ) & snap=$!
PYTHONUNBUFFERED=1 PS2X_HOST_PROF=1 PS2X_HOST_PROF_MAIN=1 PS2X_HOST_PROF_STACKS=1 \
    PS2X_HOST_PROF_OUT="$out/hostprof.txt" PS2X_MC_DIR="$out/mc0" PS2X_HOST_GAMEPAD=0 PS2X_PC_SAMPLER=1 \
    PS2X_VU_STATS=1 PS2X_GS_STATS=1 PS2X_RUN_LOG="$out/mission.game.log" \
    python -m tools_py.parity.drive --target ours --script scripts/parity/gameplay_probe.txt \
    --out "$out/mission" --seconds 480 --tail 170 > "$out/mission.drive.log" 2>&1
kill "$snap" 2>/dev/null
python -m tools_py.hostprof_diff "$out/hostprof_pre.txt" "$out/hostprof.txt" --top 40 --exe dist/socom2.exe
python -m tools_py.hostprof_stacks "$out/hostprof.txt" --exe dist/socom2.exe --top 40
```

in a `logs/` script launched like rung 2. The profiler suspends the thread it samples, so a profiled walk's SYNCV
and FRAME are not measurements. Home: R334. **Gap:** nothing refuses an attempt designed without a profile, and the
walk-only snapshot is the script's `until` loop above, not a tool.

**Preflight: memory, and the owner's game closed.** Nothing lock-bound starts under 4 GB free physical memory:
`powershell.exe -NoProfile -Command "[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB,2)"`.
Before a chain or a game run, `tasklist | grep -i -E 'socom_unzipped_launcher|socom2'` prints nothing: two chains
died on 2026-09-28 with the launcher and the game open. If they are open they are the owner's -- wait for them to
close; `scripts/kill_stale_drivers.ps1` kills every `socom2*.exe`, so it runs only after this check. Guard:
`scripts/run_detached.sh` refuses below `RUN_MIN_FREE_MEM_GB` (exit 3, test
`test_memory_refusal_below_threshold_does_not_launch` in `tools_py/tests/test_loop_lock.py`), **default 3**, so a
launch passes `RUN_MIN_FREE_MEM_GB=4`. **Gaps:** the default is not 4; `loop_lock.sh run` and `build.sh` check no
memory; nothing refuses a start while the launcher runs. Home: R334, and `docs/HAZARDS.md`'s memory-floor
hazard (2026-09-27: children failing `0xC0000142` at 3.3-3.6 GB free).

**The suites.** At a merge: the module tests the brief names (`python -m unittest tools_py.tests.test_<module> ...`),
lock-free, never beside a build or a game run. The full Python suite runs only inside the day's chain (its `test`
step, `./build.sh test`) and on CI on every push (`linux` and `windows` when anything outside `docs/` moved), never
under the lock outside a chain and never beside a build. Guard: `build.sh test` refuses under the quiet marker of a
running launch (exit 3, `FORCE_QUIET=1` overrides). Home: R334. **Gap:** nothing refuses a full
`python -m unittest discover` beside a build or outside the chain.

**One merged chain a day.** The merge bar is a clean review plus the module tests; the chain proves the day: one
`scripts/parity/merged_chain.sh` copy over everything merged since `logs/merged_chain.last_green`, once a day, in a
window. A red chain bisects by branch and evicts by `docs/GIT_STRATEGY.md` "Slices", as before. Home: R334 (it
replaces "per batch" and "the full Python suite after every merge" in the `loop-iteration` skill's step 4 for this
sprint). **Gap:** nothing refuses a second chain in a day.

**Builds a fresh worktree does not need.** Attempts share the day's exe, so no rung needs a worktree build of its
own; a worktree keeps its `third_party/ps2recomp/build-clang/` for its whole life (a re-recomp rebuilds only what
changed, issue #57). **Gap:** there is no compiler cache and no shared build directory, so a fresh worktree's first
`./build.sh runtime` is a full build (624-983 s from an empty tree, 2026-09-21; about an hour with the recomp and a
loaded host).

**When a second machine exists.** It takes the builds and the CPU-side suites (`./build.sh recomp|runtime`, the
module tests, `./build.sh test`); game runs, the gate and the chain's gate step stay on the machine that holds the
disc image and the exe. The lock is per machine already: `scripts/loop_lock.sh` lives beside a clone's git common
dir, so each machine serialises its own work. Nothing derived from the disc enters the tree on either machine.
**Gap:** the chain runs all its steps in one tree under one holding, so it cannot yet split its build from its gate
across two machines; until it can, the chain runs whole on the gate's machine.

## Knobs

**`docs/KNOBS.md` is the complete, generated list** (since Sprint 10 Q2, 2026-09-21), and it states its own count by
class on its first lines -- read it there rather than here (`python -m tools_py.knobs write` regenerates it from
`third_party/ps2recomp/ps2xShared/include/ps2x/knobs.h`, and `test_knobs_registry` fails when the source and the
registry disagree in either direction: a `PS2X_*` name the source reads with no row, a raw `getenv` outside the one
accessor `ps2x::knob`, or a row nothing reads). The **Shipping** names are `config.json` settings the launcher sends.
Everything else is a **Dev** knob (or Test) and is ignored unless the run is in developer mode -- `--dev` on
`socom2`'s command line or `PS2X_DEV=1`; `run.sh`, the gate and every script under `scripts/parity/` are
developer-mode launches already. The game's first log line, `[knobs] dev=<0|1> set: ... | ignored without --dev:
...`, says what was honoured and what was not; the launcher passes the game none of its own inherited `PS2X_*`
environment unless developer mode is on. An on/off knob is a flag: `X=1` is on, anything else off (since
2026-09-21). A Path knob's value must lie under the game folder unless developer mode is on (R207).

A few `PS2X_*` names are **not knobs**: `PS2X_ENABLE_DEBUG_UI` and `PS2X_IOP_ENABLE_PLUGINS` are CMake options,
`PS2X_DEFAULT_BOOT_ELF` a CMake cache string and `PS2X_GAME_REVISION` a compile definition (above) — set at build
time, never read from the environment. `PS2X_RUN_LOG` is read by `run.sh`, not by the game, and
`PS2X_SOCOM2_RSA_KEY_B` by `tools_py/parity/online_login_ours.py`, which hands it to instance B as `PS2X_SOCOM2_RSA_KEY`.

> Superseded 2026-09-25 (Sprint 13 R2): the knob paragraph here said the list below was "not the complete list --
> other behaviour-changing knobs exist under `getenv("PS2X_`", named `PS2X_GS_TEX_FROM_CPU` (deleted in Sprint 10 Q2)
> and `PS2X_VU1_XGKICK_IMMEDIATE` (read nowhere in the tree), and counted build options as knobs; `test_knobs_registry`
> has refused a raw `getenv` since Q2 (documents audit row 6). It also said the prose below was "what each knob did
> when it was added, kept as history"; the prose is now current, and the corrections are marked where they stand.

What follows is what `docs/KNOBS.md`'s one line cannot hold. Defaults are the registry's.

**Rendering.** `PS2X_GS_BACKEND=cpu` picks the CPU rasteriser (anything else, including unset, is the GL backend;
`build.sh test` and `vu1_replay` force `cpu`; the GL probe falls back to it by itself and the game exits 65).
`PS2X_VU1_NATIVE=0` reverts the native VU1 dispatcher to the generated/interpreted path (it runs 162 of the corpus's
166 lists natively, bit-exact; the residual 4 are documented in `docs/research/15-vu1-fourth-family.md`);
`PS2X_VU1_FAST=0` and `PS2X_VU1_GEN=0` drop to the exact interpreter, which with `--no-native` is how `vu1_replay`
goldens are made; `PS2X_VU1_HOST_DRAW=1` draws the native dispatcher's triangles through `GS::submitHostTriangle`
in host space instead of building/kicking a GIF packet (default off, GIF path unchanged).
`PS2X_VU1_NATIVE_TEST_CEILING=<n>` / `PS2X_VU1_NATIVE_TEST_CLIP_CEILING=<n>` lower the native dispatcher's
per-handler vertex/triangle and clipped-vertex ceilings so `build.sh test` can reach the refusal path on the normal
fixtures -- test-only, never set them for a real run. `vu1_replay --vram-diff <outdir> [--vram-tol <pct>]` proves the
host-draw and GIF paths render the same pixels offline; `vu1_replay --no-native` forces the interpreted path for
comparison.

**Presentation and scale.** `PS2X_PRESENT_FILTER=linear|integer|point` (Shipping) picks how the PS2 frame is
stretched to the window: `linear` (default) is the single aspect-fit draw with the render target's own linear
sampling, `point` samples it nearest straight to the window, and `integer` point-samples it into an off-screen stage
at floor(fit scale) times its size first and then fits that stage with linear filtering. Presentation only -- it
changes no rendering. `PS2X_WINDOW_SIZE=<w>x<h>` (Shipping) opens the window at that size, `fullscreen` borderless
over the desktop; the default and the launcher's default are 640x448 (R236, 2026-09-22), the frame the menus present,
so at the default the fit scale is 1.0 and the three filters are the same 1:1 blit; the filter bites on a larger or
resized window. `python -m tools_py.parity.resize_window <w> <h>` resizes a running instance for that comparison --
captures only, the title gate cannot score a pillarboxed window.
`PS2X_GS_SCALE=1..4` (Shipping; GL backend only, default 1; the VIDEO page's DETAIL row) is the integer render-target
scale: every render target's GL texture is allocated at that multiple of its native GS extent and every draw
rasterises into it at that scale, so geometry is sharper while VRAM addressing, page/row bookkeeping and every byte
the guest can read back stay native. Anything the guest can observe -- the two VRAM downloads, a render target sampled
as a texture, the display dump, the frame capture -- goes through a native-sized mirror first, and
`PS2X_GS_SCALE_FILTER=point|box` picks how that mirror is produced (`point`, the default, is a `GL_NEAREST` blit;
`box` averages the SxS host texels behind each native pixel). Any value other than the exact string `box` silently
selects `point`. Textures are still decoded at native resolution, so an RT sampled as a texture (the full-screen
display copies) gains no detail from the scale, and an image upload into a render target only ever carries native
pixels, so it destroys the sub-native detail in the rows it covers (the movie path re-uploads a full frame every
frame). Memory cost is S^2 per colour and depth target. `PS2X_GS_SCALE_SELFTEST=1` checks, on every native-view
read, that the mirror is not stale by a batch and that each native pixel lies inside its host block -- diagnostics
only. The CPU backend ignores both knobs and always rasterises at 1x. The value is read once and clamped into 1..4.
`S=2` is verified on both draw paths (gate stamps `s3d_2x_host` for host-draw; `s3d_2x_gif` title + mission and
`s3d_2x_gif_t2` transition for the GIF path, 2026-09-12) and sharpens geometry but **not** the HUD, menus or title,
which are textured quads drawn at native texel density; `S=3` and `S=4` are admitted by the clamp and have no gate
stamp -- at `S=4` a colour target is 67 MB and `getDepthTarget`'s zero-fill is a 67 MB one-off per ZBP.
`PS2X_GS_DEPTH_LEGACY=1` restores the GL backend's pre-2026-09-15 depth mapping, which rounded window depth to
multiples of 128 GS z units for every z below ~2^30. The default carries integer GS z exactly into the
`GL_DEPTH_COMPONENT32F` test: `glClipControl(GL_ZERO_TO_ONE)` with z passed through when GL 4.5 /
`ARB_clip_control` is available (logged as `[gs-gl] depth mapping: clip-control`), else `gl_FragDepth` from the
interpolated z (exact, no early-z). The mapping is replicated on the CPU in `runtime/gs/gs_gl_depth.h` and pinned by
the `GSGlDepth` unit suite. It is a precision fix, **not** the Seeding Chaos water fix (`docs/research/27`).

**The render backlog and the guest clock.** `PS2X_GS_MAX_PENDING_FRAMES=<n>` (default **3**) bounds the GS command
backlog: the EE waits at `VBlankStart` while more than `n` guest frames are recorded ahead of the GL replay thread;
`0` restores unbounded back-pressure, the pre-fix backlog that let `m_pending` grow to gigabytes
(`8281254`/`7448601`/`92d30f0`), but **not** the pre-`R54` idle wait -- the idle-spin fix (`92d30f0`) stays in
either way, so `0` is not a full A/B of the pre-fix runtime. `PS2X_CYCLE_CLOCK=guest` makes the idle wait account the
remaining cycles itself instead of a host-clock deadline -- an alternate accounting mode on top of the idle-spin
fix, **not** an A/B of the pre-`R54` scheduler path.
**The guest clock follows wall time by default** (`PS2X_CLOCK_EXCLUDE` default 0): timer T0 -- the game's frame dt --
is not reduced by the host time VU1 runs or the render back-pressure waits. `PS2X_CLOCK_EXCLUDE=1` restores the
2026-09-08 behaviour for an A/B: it subtracts that time (`ps2GuestClockExcludedNs`) from the guest clock, which ran an
online round at two thirds speed (research/34 section 6: 195 ms of VU1 and 290 ms of back-pressure per second
excluded). `PS2X_CLOCK_CAP_MS=<ms>` (default 100) bounds a single gap (a stall must not become a 300 ms dt).
`PS2X_CLOCK_TRACE=1` prints, once a second, `gap_ms` / `excluded_ms` / `lost_ms` beside the cycle clock.

> Superseded 2026-09-25 (Sprint 13 R2): this paragraph said "`PS2X_CLOCK_EXCLUDE=0` stops subtracting ... the default
> (1) is the 2026-09-08 behaviour" — backwards. `knobs.h` registers the default as 0 and its meaning as "1 restores
> the 2026-09-08 exclusion ... (A/B)", and `docs/KNOWN.md` §2 says the scheduler counts wall time by default
> (documents audit row 4).

**Input.** `PS2X_SOCOM2_PAD` (Shipping, default on; `0` boots with no controller) is the libpad2 HLE and host input
path. Gamepad 0 -- an Xbox/XInput or DirectInput pad (since 2026-09-16) -- is OR-ed with the keyboard, and sticks
past the dead zone (`PS2X_PAD_DEADZONE`, default 0.15) override the keyboard axes; the start banner names the pad or
says `gamepad none`. **`PS2X_HOST_GAMEPAD=0` disables every host gamepad read** -- the gate and the online launch
scripts set it, because a plugged-in controller makes the game skip its controller-configuration screens at boot.
The keyboard's **full** map (arrows/WASD/IJKL, Enter=START, Backspace=SELECT, ZXCV=Square/Cross/Circle/Triangle,
QE=L1/R1, 13=L2/R2, 24=L3/R3) is honoured only in developer mode, which every harness launch is; a player's
keyboard is menus and typing only -- the d-pad, Enter, Backspace and Z/X/C/V (R210, 2026-09-21). The input banner
says which: `[socom2-input] keyboard full, developer mode (...)` or `[socom2-input] keyboard menus and typing only
(...)` (`socom2_host_input.cpp`). The mouse and its two knobs are gone (Sprint 10 Q3, R210).

> Superseded 2026-09-25 (Sprint 13 R2): the input sentence said "setting `PS2X_SOCOM2_PAD` (to any value) enables the
> host input path" and listed the keyboard's gameplay keys with no mention of developer mode; the knob is on by
> default and the gameplay keys have been developer-mode-only since R210.

**Audio.** `PS2X_AUDIO_DUMP=<file.wav>` writes the host mix (48 kHz stereo, 16-bit) as it is rendered -- the mix
before the device, so it cannot see what the device path loses (record the endpoint beside it:
`tools_py/parity/loopback_record.py`). A run the harness kills leaves the WAV header's sizes at zero, so read the file
by its length. `PS2X_AUDIO_PCM_DUMP=<file>` writes the first 16 MiB the EE DMAs into the 989snd PCM ring, raw with a
wall-clock stamp per write (`tools_py/parity/pcm_dump.py` reads it). `PS2X_HLE_STATS=1` prints, per bound HLE stub
(`recomp/socom2.toml`), its call count, distinct returns (saturating at 64) and first/last value, including zero-call
stubs -- a varying-but-wrong return still passes a distinct count, and tail-called stubs (a recompiled `J` straight
to a C++ function) undercount because they skip the dispatch table.

> Superseded 2026-09-25 (Sprint 13 R2): the audio sentences said the dump held "bank sounds only until the VAG streams
> land" (the streams landed long ago; the dump is the whole mix) and that the PCM dump holds "the first 256 KiB"
> (`ps2_audio.cpp` and `knobs.h` say 16 MiB).

**Online (two instances on one host, or on the hosted server).** `PS2X_SOCOM2_SERVER` (Shipping) is the address or
name every Medius/DNAS host name resolves to; the launcher sends its preset's. `PS2X_SOCOM2_NET_STATS` (default
**on**) makes `sceInetInterfaceControl` code `0x200` return a real RX byte count; `0` restores the old constant and
**reproduces the online movement defect** (the guest's ms-since-network-activity never resets, the multiplayer
movement scale decays to 0 and the local player cannot move) -- an opt-out kept so the fix can be A/B'd on one
binary (`socom2_libnetb.cpp`, the `0x200` case). *(Corrected 2026-09-25, Sprint 13 C9, `5ece5e3e`: `docs/KNOBS.md`'s
one-line meaning for this knob said "the periodic [net-stats] line"; it now names the `0x200` counter.)* `PS2X_SOCOM2_NET_TRACE` (any value) enables the netcode
trace, `PS2X_SOCOM2_NET_TRACE_PEERS=<n>` sets how many datagrams are hex-dumped per direction (default 16), and
`PS2X_SOCOM2_NET_TRACE_ALL` (default off) hex-dumps **every** datagram rather than only the peer ports (the only way
to content-inspect the DME aux-UDP traffic). *(Reworded 2026-09-25, Sprint 13 R2: "only the peer ports" was "only
ports below 10000".)* `PS2X_SOCOM2_UDP_SHIFT=<n>` shifts an instance's peer UDP ports
(instance B uses 2), and `PS2X_SOCOM2_RSA_KEY=b` gives an instance the second precomputed RSA key pair so two exes on
one host do not publish the same public key; the launcher's "Second instance" box sends both. The drivers give
instance B its key through `PS2X_SOCOM2_RSA_KEY_B=b` (the launch scripts under `scripts/parity/` export it).

> Superseded 2026-09-25 (Sprint 13 R2): this paragraph said the drivers also pass `PS2X_SOCOM2_NET_STATS_B=0` to turn
> the `0x200` fix off for instance B alone; nothing in `tools_py/` or `scripts/` reads or sets that name.

## The online harness

`python -m tools_py.parity.online_match_ours` drives instance A (host) and B (joiner) through login, lobby and a
match; `docs/research/18-online-round-start.md` §3.6 and §4.9 have the full recipes. Its flags:

- `--converge` (both instances walk toward each other); `--until-kill` (implies `--converge`; runs until a kill or
  round end is observed, captures both screens and prints one `RESULT` line naming the signal -- **`RESULT PASS` is
  reserved for a kill**, a round that ends on its clock prints `ROUND-END (unattributed -- NOT a kill)` and exits
  non-zero, and expiry of `--kill-timeout` (default 420 s) is a clean FAIL); `--engage`/`--engage-dy` (true 3-D
  actor-to-actor range and height tolerance for contact), `--fight-seconds` (default 150), `--no-route` (ignore the
  mined corridor and walk the straight line).
- `--map <name>` (default **`frostfire`**, the owner's test map since 2026-09-13): the highlighted row is verified
  against a reference crop `scripts/parity/refs/map_<name>.png` before CROSS is pressed, and a map with no reference
  aborts. References are committed for the 24 maps under `scripts/parity/refs/map_*.png` (2026-09-25, `ls`) plus a
  PCSX2 crop for Frostfire. `--map-scan <n>` (with `--only A`) walks the map list n rows and captures each, which is
  how a new reference crop is made.
- The health watch: `--health-offset` (default `0x1044`) and `--alive-offset` (default `0xF7A`), `'none'` disarms
  either (armed by default since Sprint 5 Task 2; `docs/research/19` sources the offsets); `--health-range lo:hi`
  (default `-1e9:0.0`). A health death counts only as a transition (the same actor address must read alive, `0 < v <=
  1`, before a dead-range read), so a first read of `0.0` or of uninitialised heap is not a kill
  (`tools_py/tests/test_kill_watch.py`), and `PS2X_PEEK` must cover the offset or the run refuses to launch rather
  than failing later with `reads=0`.
- The engagement ladder: `--rounds N` (default 4) plays N rounds on one lobby success,
  re-finding the actor by vtable and re-arming the move-path disarm window after each round or kill, with one
  `LADDER round=<n> …` line per round and a `LADDER-SUMMARY`; `--route <file>` picks the waypoint route for
  `--endgame route`/`cooperative` (default `tools_py/parity/routes/frostfire_v2.json` for `--map frostfire`, derived
  from collision geometry in `docs/research/24`, else `routes/<map>.json`; the older 3c-derived `routes/frostfire.json`
  stays loadable); `--endgame route` (the default) has the stander wait at spawn while the mover follows the route,
  closes into the contact band, aims with partial-`rx` pulses read from the actor matrix and fires, teleport-checked
  throughout; `--endgame cooperative` adds victim strafe-oscillation and shooter micro-strafing between bursts so each
  side keeps feeding the other's starvation counter; `--endgame converge` has both sides approach and sweep-fire;
  `--mover {A,B}` (default A, the host) picks which side walks and shoots; `--auto-swap` swaps `--mover` once on a
  `SWAP-MOVER` stop instead of ending the run; `--control-round` (implies `--converge`) runs the clock round-end
  negative control -- nobody fires, both sides alternate strafe legs until the round ends on its own clock, and
  `RESULT CONTROL-ROUND` requires `total_mp_kills`, `aiteam_*` and the health word to stay unchanged; `--dry-run`
  validates the arguments, the route, the peek/trace spec and `PS2X_GS_STATS` and launches nothing.

> Superseded 2026-09-25 (Sprint 13 R2): the `--rounds N` sentence was cut in two, with the window-size knob and the
> whole launcher paragraph spliced into the middle of it (documents audit row 5); and the map sentence said
> references were committed "for Frostfire and Medley" only.

**Two independent kill scorers.** A ladder match's kill is scored twice: by KillWatch on the actor fields above,
and by `verdict_replay.py` on the round-state valves (the acceptance test these two met, 2026-09-13, is
`docs/KNOWN.md` §1's). `tools_py/parity/verdict_replay.py <run_A.log> <run_B.log> [--per-round]`
is the second, independent kill scorer (primary signal: the round-state valves -- `total_mp_kills`, `aiteam_*`, the
clock -- corroborated by the actor fields), test-driven against synthetic and real fixtures, and importing nothing from
`online_match_ours.py` or `verdict_core.py` by design, so a parser bug in one cannot hide behind agreement with the
other. `tools_py/parity/verdict_core.py` holds the pure, IO-free scorers (`score-control`, `move-path`, `contact`,
`starvation`) the harness's own preconditions and the offline scoring share, with a CLI for offline replay of any
stored log pair. Harness pieces: `drive.py` scripts have an `ifburst` step (fire a capture burst only if the preceding
`ifref` matched), and `python -m tools_py.parity.movie_blocks <dumpdir>` checks a `PS2X_GS_DUMP_DISPLAY` capture for
16x16 blocks black on the GL target but present in shadow VRAM (limits: `docs/research/16` §9.1.1; `build.sh test`
runs it over the saved fixture `tests/fixtures/movie/` with its furniture baseline, issue #46 (closed)).
> Superseded 2026-09-25 (Sprint 13 Task H4): this said the check was "wired into no automation"; it has run in
> `build.sh test` through `tools_py/tests/test_movie_blocks_fixture.py` since `bd27443e` (2026-09-17).

**The ladder launch.** `scripts/parity/ladder_frostfire.sh --pinned <outdir>` is the ladder launch template: it pins
the harness, proves the snapshot imports, dry-runs first, then runs the pinned `online_match_ours.py --rounds …
--endgame route --route … --auto-swap` under `run_detached.sh` (which does the disk and lock checks) and returns;
nothing polls -- the caller watches `logs/<name>.done`. Killing stale drivers (`scripts/kill_stale_drivers.ps1`), a
running Horizon stack and persona B are preconditions the caller meets, not steps the template takes; its header
carries the exit codes and knobs. `scripts/pin_harness.sh` archives `tools_py`/`scripts` at a given commit into
`<out_dir>/harness` and records `HARNESS_COMMIT`/`EXE_BUILD`; it does not run or re-exec anything. The template runs
that snapshot with `PYTHONPATH=<snapshot>` plus **`PYTHONSAFEPATH=1`** from the repo root, so a pinned run cannot
accidentally import the live tree instead (Python otherwise puts the current directory ahead of `PYTHONPATH`). The
scheduled form was `scripts/ladder_job.sh`, whose runs `tools_py/parity/ladder_ledger.py` renders to `docs/LADDER.md`;
the schedule is retired (R294, R296 -- the Task Scheduler entry stays disabled) and a run is started by hand when a
task needs it.

## The loop lock

`scripts/loop_lock.sh` serialises every build and every game run on the machine (its header is the reference and the
rules' one home; the commands a controller runs are the `run-gate` skill, `.claude/skills/run-gate/SKILL.md`). `LOOP_LOCK_PATH` overrides the lock's base path (tests use it to
avoid touching the real lock). `tools_py/tests/test_loop_lock.py` runs a smoke subset by default (plus the always-on
`TestQueueClassFast`, Sprint 14 W1: the WIP cap's class rule and exit-4 refusal against planted tickets) and the whole lock
suite with `LOOP_LOCK_SLOW_TESTS=1` (every race, interleaving, queue, `run`/`run_detached`/`ladder_job` test and the
real-scale `run -- sleep 130` renewal; ~16 min before Sprint 13's queue tests, longer now, and much longer on a
host whose process starts are slow -- stray `tail -f` watchers once made it fail the stale-mutex cases outright, so
check `Get-Process tail` before trusting a red), plus a hygiene test that fails when `scripts/loop_lock.sh`'s git blob differs from
`tools_py/tests/fixtures/loop_lock_slow_green.txt`, the blob of the last green slow run -- so an edit to the lock
script needs a green slow run before its commit. `scripts/run_detached.sh` (launched with `--purpose launch*` for an
online match) writes a quiet marker (the MAIN tree's `logs/.quiet`, found through git's common dir like the lock, keyed
to the Windows pid) that tells other agents to stay off `build.sh test`, the gate, `unittest` and large-log parsing
while a match runs (`build.sh test` refuses to start under it unless `FORCE_QUIET=1`). The marker is machine-wide:
**in an agent worktree, `build.sh test` exits 3 while ANY launch runs, including one from the main tree** -- wait
for it, do not force it; `run_detached.sh` can queue for the lock instead of refusing (the lock's rules are
`scripts/loop_lock.sh`'s header); records a host CPU sampler into the run directory; refuses to start below 4 GB free on
`C:`; and takes the loop lock for the job. It also refuses (exit 3, before touching the lock) below 3 GB of free
physical memory (`RUN_MIN_FREE_MEM_GB`). **The WIP cap** (Sprint 14 W1): at most `LOOP_LOCK_MAX_QUEUE` (default 2)
build tickets queue at once; a third build waiter writes no ticket and exits 4 ("queue full: do lock-free work"),
and every ticket carries a class, `build` or `run` (`--class` overrides).

## Guards

Claude Code runs `scripts/hooks/claude_pretool.sh` (-> `tools_py/hooks/pretool.py`) before every Bash (and, since
Sprint 17 G1, PowerShell) tool call, wired by the tracked `.claude/settings.json` (Sprint 14 G1). It refuses with exit 2 and one sentence naming the rule's
home; anything it cannot parse or judge is allowed. A call whose JSON names none of `git`, `gh pr`, `loop_lock` and `logs/`
exits 0 in the shell before Python starts (about 0.1 s; a judged call costs about 1 s). The command is split on `;`, `&&`, `||`,
`|`, `&`, parentheses, brace groups and newlines (heredoc bodies and quoted strings are data); the wrappers `time`,
`timeout`, `nice`, `nohup`, `stdbuf`, `ionice`, `env`, `sudo`, `command`, `exec` and `xargs` are stripped; a `bash -c`, `sh -c` or `eval` string is judged
as a command; `cd`, `pushd`/`popd` and `git -C <dir>` are followed for the worktree rules, and a subshell's `cd` ends
at its `)`. Each rule is proved by planted commands in `tools_py/tests/test_hooks.py` (`PretoolPlantedTest`: the
`CASES`, `MORE_CASES` and `REVIEW_CASES` tables); `PretoolWiringTest` drives the shell script with a hook JSON
document on stdin. The repository's `.gitignore` owns `.claude/`: `settings.json`, `agents/` and `skills/` are
tracked, the harness's local state is not (`ClaudeDirIgnoreTest`), whatever a global excludes file says.

- **Bulk add** -- `git add` with no pathspec, a whole-tree pathspec (`.`, `:/`), or `-A`/`--all`/`-u`/`--update`
  without a `-- <paths>` limiting it (`git add -A -- a` passes); `xargs git add` shows no pathspec, so a computed
  list goes through `git add --pathspec-from-file=<list>`; test `git add -A`, `.`, `-u`; home
  `docs/GIT_STRATEGY.md` section 3.
- **Commit everything** -- `git commit -a`/`--all` (and `-am`); test `git commit -a -m 'x'`; home
  `docs/GIT_STRATEGY.md` section 3.
- **Commit without paths** -- `git commit` (and `--amend`) with no `-- <paths>`, since a bare commit takes whatever
  any session staged; allowed while `MERGE_HEAD` exists in the directory the commit works in, after `cd`/`git -C`
  (git refuses a partial commit mid-merge); test
  `git commit -m 'x'`, `git commit --no-edit`; home `docs/HANDOFF.md` section 4 rule 1.
- **No-verify** -- in any git command, `--no-verify` or any abbreviation of it from `--no-v` up (git accepts unique
  prefixes), commit's `-n`, and `-c core.hooksPath=...` (any case, `-ckey=` too); test `git commit --no-verif ...`,
  `git push --no-verify`, `git -c core.hooksPath=/dev/null commit ...`; home `docs/GIT_STRATEGY.md` section 3.
- **Push from a worktree** -- `git push` when the session's cwd or the command's directory (after `cd`/`git -C`) is a
  linked worktree (`--git-dir` differs from `--git-common-dir`); a worktree session never pushes, even with
  `git -C <main tree>`; test `git push origin sprint-14` with is_worktree; home `docs/GIT_STRATEGY.md` section 3.
- **Rewriting a shared branch** -- `git push` with `--force`, `-f`, `--force-with-lease`, `--force-if-includes`
  or a `+refspec` whose target is `main`, `sprint-*` or not named (HEAD, no refspec); a delete of `main` or
  `sprint-*` (`--delete`/`-d`, or an empty-source refspec `:main`); `--mirror` to any remote; `agent/*`, `fix/*`,
  `feat/*`, `docs/*`, `spike/*` pass; test `git push -f origin main`, `git push origin +HEAD:sprint-14`,
  `git push origin :main`, `git push --mirror origin`; home `docs/GIT_STRATEGY.md` section 2.
- **Config in a worktree** -- in a worktree, a `git config` that writes: a `key value` pair, `--unset`,
  `--unset-all`, `--add`, `--replace-all`, `--remove-section`, `--rename-section`, `-e`/`--edit`, or the `set`,
  `unset`, `edit`, `rename-section`, `remove-section` subcommands -- unless `--worktree`, `--global`, `--system` or
  `--file` is given; reads pass (`--get*`, `--list`/`-l`, `get`/`list`, a lone key); test
  `git config remote.origin.pushurl x`, `git config --unset ...`; home `scripts/agent_worktree.sh`.
- **Worktree lifecycle** -- `git worktree remove`/`prune`/`add` outside `scripts/agent_worktree.sh`; test
  `git worktree remove --force ...`; home `scripts/agent_worktree.sh`.
- **The lock by hand** -- `loop_lock.sh take` or `release` called directly (`check`, `run`, `wait`, `version` pass);
  test `bash scripts/loop_lock.sh take`, `... release`; home `scripts/loop_lock.sh` (`run`, or `run_detached.sh`).
- **gh merge deleting the branch** -- `gh pr merge` with `--delete-branch` or `-d` (`-md` too); test `GH_MERGE_CASES`
  (`test_gh_pr_merge_delete_branch_is_refused`); home `docs/HAZARDS.md` git (the worktree junction, 2026-09-26).

The same script also runs before every Edit, Write, MultiEdit and NotebookEdit call (a second PreToolUse entry,
Sprint 14 G2; the path from `tool_input.file_path`, or `notebook_path`). It judges the path relative to the root of
the repository that holds it, and only a repository with `scripts/loop_lock.sh`; the JSON reaches Python when it
names `git`, `logs/` or `loop_lock` (the fast path is shared with the Bash half), and `loop_lock.sh check` runs only
for a script under `logs/` or the lock script. The lock is shared by every worktree, so both rules refuse only what
something is actually running. An edit through Bash (`sed -i`, a heredoc) is not seen. `EditWritePlantedTest` holds the planted calls;
`PretoolWiringTest` drives them through the shell script against a stub `scripts/loop_lock.sh` in a temp repo.

- **A running chain script** -- an edit of an EXISTING `logs/**/*.sh` while `bash scripts/loop_lock.sh check` says
  `HELD` (the holder is named in the refusal): bash reads a running script by offset, so an edit breaks it at the
  edit point. A new file cannot be running, and a `QUEUED` waiter has not started its chain (`run_detached.sh
  --wait` launches it only after the grant), so neither refuses; test `decide("Edit", {"file_path":
  "logs/x.sh"}, ..., lock_holder="agent-x51")` with the file existing (2), new (0), and `lock_holder="queued:1"` (0);
  home `docs/HAZARDS.md` lock (the running-chain hazard).
- **The lock script in use** -- an edit of `scripts/loop_lock.sh` when a `QUEUED` line's `blob=<12 hex>` equals the
  file's `git hash-object` (that waiter is a live bash reading this exact copy by offset), or while the lock is
  `HELD` and the file is the MAIN tree's copy (`--git-dir` equals `--git-common-dir`: the loop's `run` wrappers and
  chains start there); a worktree's copy under `HELD` with no matching waiter passes; test `decide("Write",
  {"file_path": "scripts/loop_lock.sh"}, ...)` with a matching and a non-matching queued blob, and `HELD` with
  `main_tree_of` true and false, plus the wiring tests on a temp repo and its linked worktree; home the
  `scripts/loop_lock.sh` header (the rollout procedure).
- **Landing the lock script** (the Bash half) -- a `git commit` whose `--` pathspec names `loop_lock.sh`, unless
  `logs/.loop_lock_slow_green` is newer than the script; a complete green
  `LOOP_LOCK_SLOW_TESTS=1 python -m unittest tools_py.tests.test_loop_lock` writes that marker (`SlowGreenSuite`;
  never a smoke, `-k` or single-class run); the marker is the one of the repository the commit works in (after
  `cd`/`pushd`/`git -C`, as the merge exception is judged), looked at only for a commit naming `loop_lock.sh`; test
  `git commit -m x -- scripts/loop_lock.sh` with and without `slow_tests_ran`, the four rows of a marker in M or W
  with `cd W` and `git -C W` from M, and the wiring tests with no marker, a fresh one, one older than the script,
  and a linked worktree; home the `scripts/loop_lock.sh` header (the rollout procedure). Limits: the marker gates
  the commit form the loop uses, not every landing -- a glob pathspec (`-- 'scripts/*.sh'`), `git commit -i`, and a
  `git merge` or `git cherry-pick` of a commit that changes the script land it without a commit naming it.

The subject cap (Sprint 14 S2): git's `commit-msg` hook, `scripts/hooks/commit-msg` (-> `tools_py/hooks/commitmsg.py`,
live in every clone that ran `scripts/install_hooks.sh`), refuses a subject (git's first paragraph, joined as `%s`
shows it) over 120 characters with one sentence (a default merge, revert or reapply subject with a body is exempt;
`fixup!`/`squash!` judge the subject they wrap); test `CommitMsgTest` and `CommitMsgWiringTest` in `tools_py/tests/test_hooks.py`; home `docs/GIT_STRATEGY.md` section 3.

The chain's tree (Sprint 17 G1): `scripts/parity/merged_chain.sh` reds on a tracked file changed in its tree, then on
HEAD moved, so a peer's edit or commit there costs a 90-minute rerun (five on 2026-09-27/28; the multi-session
collisions audit of 2026-09-28, sections 3.1 and 5). The chain writes `logs/.merged_chain.running`
in its own tree after it fixes HEAD0 (`pid`, `start`, `head`, `stamp`, `root`, `held`; the pid is the Windows one under
Git Bash) and removes it in an EXIT trap; `tools_py/hooks/chainmark.py` judges it live when the pid is alive and was
created no later than the write -- in-process, no child, and the lock's state is not consulted. Two refusals key on
it: git's `pre-commit` hook runs `tools_py/hooks/precommit.py` before the leak check, and
`scripts/hooks/pre-merge-commit` runs the same, so they refuse `git commit` and a non-fast-forward `git merge` in that
tree (cherry-pick, revert, rebase, am, a fast-forward, reset and checkout move HEAD unguarded -- the audit's 3.1(b),
not this task); the Edit/Write entry refuses an edit of a TRACKED file in it (untracked files, `logs/` and other trees pass --
an agent worktree never refuses). The shell fast path starts Python for an editing call only while a marker exists in
the hook's own tree or the main tree (`PRETOOL_CHAIN_TREE` replaces both for tests). Test `ChainMarkerTest`,
`PrecommitChainGuardTest`, `PrecommitWiringTest`, `PinnedTreeEditTest`, `PinnedTreeWiringTest` in
`tools_py/tests/test_hooks.py`, and the marker's lifetime (green, red, refused, dry) in `tools_py/tests/test_merged_chain.py`;
home this section. Limits: a tree without `tools_py/hooks/precommit.py` (a branch older than G1, whose commits run
the main tree's hooks through an absolute `core.hooksPath`) is skipped, not refused; a hard kill (`taskkill /F`)
skips the trap and leaves the marker behind -- it pins nothing once its pid is gone, or is reused (a process
created after the marker, or one we may not open, is not the chain), and every refusal names the marker and says
to delete it if no chain runs (`bash scripts/loop_lock.sh check` FREE); an
edit through Bash or PowerShell (`sed -i`, `Set-Content`) is not seen; a chain in a third tree is judged only when the
call reaches Python for another reason.

The PowerShell tool (Sprint 17 G1): the PreToolUse matcher is `Bash|PowerShell`, and a PowerShell `command` is judged by
every Bash rule above (`Set-Location`/`sl`/`chdir`, `Push-Location`, `Pop-Location` followed as `cd`/`pushd`/`popd`);
until then each rule was a sentence for that tool (the audit's 3.2). Test `PowerShellToolTest` in
`tools_py/tests/test_hooks.py`.

The reaper (Sprint 14 G3): at `SessionEnd` and every `Stop`, `scripts/hooks/claude_session_end.sh` runs
`python -m tools_py.hooks.reap`, which `kill -9`s every orphaned watcher -- an MSYS `tail`, `grep`, `sleep` or
`inotifywait` whose ppid is not in `ps -W`, or is 1 without leading its own process group (a watcher started directly
by a Windows program leads its group and is kept) -- and never a `bash`/`sh`/`python`/`git`, a native Windows
process, pid 1 or itself. No live session's process is on the list: live Monitor watchers sit under a live bash, the
lock renewer's `sleep 1` under a live subshell, run_detached's child is a `nohup bash`, and the parity scripts'
background jobs are python/powershell. It prints one `reap: ...` line and always exits 0 (exit 2 on `Stop` would keep
Claude going); test `tools_py/tests/test_reap.py` (the plan's twelve-row planted table, a captured `ps -W` sample);
home the Sprint 14 plan, Task G3 (213 orphans on 2026-09-25; no `docs/KNOWN.md` row exists).

## The launcher

`dist/socom_unzipped_launcher.exe` (`socom_unzipped_launcher` on Linux), built by `./build.sh runtime` next to
`socom2.exe`: one window that owns `config.json` beside it and starts the chosen GAME VERSION's pair — `socom2.exe socom2_game.elf` for r0001, `socom2_r0004.exe socom2_game_r0004.elf` for r0004 (`gameFilesFor`, PR #86) — with the `PS2X_*`
environment `launcher::environmentFor` writes (`ps2xShared/src/launcher_config.cpp`), so nobody sets a variable by
hand. Its pages are on a rail -- PLAY, DISC, VIDEO, AUDIO, CONTROLLER, MICROPHONE, ONLINE, REPORT A BUG, ABOUT
(`docs/INSTALL.md` walks them in a player's order and quotes their sentences). DISC: the ISO path (BROWSE...),
verified by hashing `SCUS_972.75` out of the image against the r0001 digest -- LAUNCH stays off until it matches.
VIDEO: DETAIL (`PS2X_GS_SCALE`: NATIVE, SHARP 2x, SHARPER 3x, SHARPEST 4x), FILTER (`PS2X_PRESENT_FILTER`), WINDOW
(640x448, 1280x896, fullscreen, or MATCH the display) and the frame-rate OVERLAY. CONTROLLER: the pad the launcher
sees, drawn live, the dead zone, and BUTTONS (per-profile rebinding, `PS2X_INPUT_MAPPING`, and the crouch shortcut).
ONLINE: the server preset (`PS2X_SOCOM2_SERVER`), PERSONAS (one row per record in the cards' ledgers,
`cards/<profile>.personas.json`, which the runtime writes on a login the server accepts; a pick sets the profile --
`cards/<profile>/` becomes `PS2X_MC_DIR` -- and the name, `PS2X_SOCOM2_LOGIN_NAME`; NEW PERSONA last; a new card only
by hand in `config.json`), the masked PASSWORD beside the selected row only while the card does not hold the password
(`PS2X_SOCOM2_LOGIN_PASS`, plain in `config.json` until a login records the card holds it), GAME VERSION (which
executable LAUNCH starts, r0001 or `socom2_r0004.exe` when it is beside the launcher), and under ADVANCED the second-instance box (UDP
shift 2, key b, `cards/<profile>_b`). LAUNCH writes `logs/run_<stamp>.log`; SAVE DIAGNOSTICS writes a zip into
`diagnostics/` (the last log clipped, the settings through an allowlist, the GL report, the crash record, the
versions, the home directory scrubbed). `--diagnostics <out.zip>` writes the same zip with no window; `--selftest`
prints the verified disc and the environment and exits; `--launch-test [seconds]` starts the game the way the button
does and reports whether it is still running after that long.

`socom2.exe` takes the ELF path as argv[1]; it mounts `PS2X_CD_IMAGE` when set, else the first `.iso` next to the
ELF or one directory up (`configureCdImage`, `game_overrides_socom2.cpp`); the memory card is `PS2X_MC_DIR` when set (the launcher always sets it, to `cards/<profile>`), else
`mc0` beside the ELF -- `game/disc/mc0` for `./run.sh`'s default ELF.
PCSX2 reference: `tools/pcsx2/pcsx2-qt.exe -batch -nogui -fastboot -logfile <log> "<iso>"`.

> Superseded 2026-09-25 (Sprint 13 R2): the launcher paragraph described the pre-redesign launcher -- a "Copy
> diagnostics" button that copied the last log and `config.json` into `diagnostics/`, "Native / Sharp (2x) / Sharper
> (3x, untested)", three window sizes, an online page with a plain checkbox -- and said "memory cards live in
> `game/disc/mc0`" without saying that holds only when no `PS2X_MC_DIR` is set (documents audit row 8). The rail,
> SAVE DIAGNOSTICS and `cards/<profile>` have been the launcher since Sprints 8 and 9.
