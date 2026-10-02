# Sprint 19 design — "two cartographers": Harry62's names joined to ours, with their provenance, their tests and a way back

Date: 2026-10-02 02:35Z. Status: **PROPOSED** (R-numbers at the open; the owner's word owed). Drafted by a
read-only research agent for the main-tree controller; nothing in either tree was changed. Inputs: research/84 and its
assets on the unmerged branch `agent/wizard-harry` (worktree `C:\Projects\wt-wizard-harry`, head `40684620`), and the
main tree on `sprint-17` at `6004bbd5`. The vocabulary is `docs/KNOWN.md`'s; KNOWN wins on any disagreement. Every
count below was re-read from the file named on 2026-10-01; none is carried from memory.

## The owner's word / why now

*(To be filled with the owner's word when he gives it. The case the controller would put to him:)*

A community reverse-engineer has handed the project, by the owner's hand, the largest body of human function names we
have had from outside since the SOCOM 1 demo's `.symtab` (research/44): 5,956 hand-written labels on an r0004 memory
image, of which 1,334 sit on a function start in our r0004 map and **512 name a function we still call `FUN_`/`thunk_`**
(`new_function_names.csv`, 512 rows). He is strongest exactly where we are weakest: the game's own network layer
(`NetI*`), RTime's message client (`rt_msg_client_*`, `rt_comm_*`), the Medius request wrappers, the in-game packet
senders/receivers and the voice path (research/84 §3; `return_set_README.md`'s table: netcode 187 of his against 213
of ours with only 76 shared). Today research/84 is a note on a side branch and the names live in a CSV nobody's tool
reads. The project's naming rules (`docs/DEVELOPING.md` "Names in the generated code": one sidecar, one writer,
levers whose acceptance rules are code) exist precisely so a corpus like this can be taken in without trusting it
blindly. Doing it now, while Sprint 17 waits on the owner's close and Sprint 18 is launcher-only, costs one chain and
otherwise runs lock-free beside both.

## Why this is a sprint and not a task

It touches five homes in one order: a parser and exporter (`tools_py/`), a name lever and the sidecars
(`recomp/socom2_names*.csv`), a ruling per disagreement (holds file, a research table), a protocol map against our
own server (`server/horizon-server/`), and the documents (DEVELOPING, README credits, KNOWN). The names change the
generated code, so the one lock-bound step needs a recomp, a build and both revisions' gates; everything before it
must be decided first so the chain runs once.

## 1. What is established (2026-10-01) — [verified: the files named]

### 1.1 The corpus

- `SOCOM2.ide` is kept git-ignored at `game/harry62/SOCOM2.ide` (present; beside it `return_set/`,
  `return_set.zip`, `return_set_2026-10-01.zip`, `return_set_summary.txt`). It is a 32 MB EE RAM image plus
  annotations; the image is r0004 (overlay and data segments 99.8 % matched, research/84 §2), so **every label address
  is an r0004 address**.
- User labels (`user_labels.csv`, 5,956 rows + header; kinds verified by `awk`): identifier 3,004, annotation 1,914,
  mangled 624, numeric 414. By placement: on a function start 1,334 (846 identifier, 212 mangled, 265 annotation,
  11 numeric), inside 4,047, outside 575.
- Of the 1,180 identifier/mangled labels on a function start (research/84 §3, `summary.txt`): new to us **512**, agree
  **514**, disagree **32** (`disagreements.csv`, 32 rows).
- The 512 by region: 62 in the shared loader (below `0x1e7000`; sce/libc), 450 in the overlays; 194 of the 512 are
  mangled (`__` in the row). Their r0001 twins (`TwinHow`): exact 299, relinked-body 80, seed+delta 31,
  hash+callees 1, none 101.
- Three object definitions (`objects.txt`): `cAppCamera` (1 field) via `0x4429b0`, `GameObject` (40 fields) via
  `0x4446f8`, `PlayerObject` (118 fields) via `0x44d648`. Two of the three statics are **already ours, independently**:
  `0x004429b0` is `cameraHolder` in `third_party/ps2recomp/ps2xRuntime/include/runtime/socom2_addresses.h:229`
  (r0001 `0x00415ff0`, `data-via-twin`), and `0x004446f8` is the r0004 `roundState` in
  `.../runtime/socom2_net_bounds.h:102` (r0001 `0x00437ce8`, line 74; KNOWN §1's round-state row). They are
  gameplay-state objects, **not** the VU1/draw path: his set is thin on the engine (42 render names against our 95,
  `return_set_README.md`).

### 1.2 Our names today

- r0001: 14,879 functions in `recomp/socom2_ghidra.csv`, 14,766 still placeholder in the map, **1,871 sidecar rows**
  in `recomp/socom2_names.csv` (12.6 % named).
- r0004: 16,417 functions in `recomp/socom2_ghidra_r0004.csv`, 16,327 placeholder in the map, **1,736 sidecar rows**
  in `recomp/socom2_names_r0004.csv` (10.6 % named). Top passes: exact 328, toml-stub 268, vtable-slot 194,
  string-set 186, offset-multiset 169, callgraph 168.
- Holds: `recomp/socom2_name_holds.csv`, 6 rows.
- The only writer is `tools_py/apply_names.py`. A proposals file with a `Pass` that has no `PASS_SCORE` entry
  (`PASS_SCORE = {"positional": 0.80}`, line 72) and no score is refused as strict; a loose row (`LOOSE_DEFAULT = 0.75`)
  promotes only when a strict row of a *different lever family* agrees (lines 26-29, 253-258). r0001 rows travel to
  r0004 only with `--through game/r0004/match.json` on an `exact` placement; r0004-only names go to the r0004 sidecar
  directly as `Pass=hand` (the N2 precedent, `recomp/names_proposals_hand_r0004_2026-09-25.csv`).
- Checks: `python -m tools_py.name_provenance audit <map> <sidecar>` must print `0 findings`;
  `tools_py/tests/test_name_provenance.py` and `test_toml_names_agree.py` hold it in the suite; `tools_py/recomp_census.py`
  proves a rename moved nothing but identifiers (Sprint 12: `extents_changed: 0`). Every lever has a test beside it
  (16 `test_*lever*`/`*name*`/`*symbol*` files under `tools_py/tests/`). `tools_py/research/symbols/sidecar_census.py`
  already exists as the place for a coverage count.

### 1.3 The tooling that came with research/84 (all in `docs/research/assets/84-ps2dis-ide/`, none tested)

- `ide_extract.py` (195 lines): a dependency-free reader of the ps2dis# project format (version 5), argparse CLI,
  writes the label/object/summary tables and the joins against our map and sidecar. **No tests**, no writer.
- `cds_export.py` (98 lines): our names as Code Designer Lite `address`/`label:` lines (`cds_label`, `write_cds`);
  it also carries a second function this draft does not take (§5).
- `build_return_set.py` (326 lines): the one-off builder of the set the owner sent back (research/84 §8): it writes a
  `.ide` from his file plus our labels, our vtables as his object definitions (83 on r0004, 102 on r0001), and
  `CleanupImportedLabel`-safe text (`clean_ok`, `sanitize`). **No tests**; it copies his whole project through
  byte for byte, which is why it stays a research asset and is not promoted as is.
- Nothing under `tools_py/` imports any of the three (`grep -rln "ide_extract\|cds_export\|build_return_set" tools_py`: empty).

### 1.4 Our server against his network map

- `server/horizon-server/RT.Models/Lobby/` holds 213 message files; `RT.Common/Types.cs` holds the `RT_MSG_TYPE`
  enum and the Medius id enums (`AccountUpdateStats = 0x11`, line 591). `RT.Models/DME/` holds five classes.
- Our server tests: `server/horizon-server/Server.Test/` (BuildId, ChatClamp, FixedWidthString, MediusText,
  NonHostRename, RelayCaps, ScertFrame).
- His map names, on the client side, the request wrappers (`MediusUpdateAccountStats`, `MediusGetPolicy`,
  `MediusGetNatServiceAddress`, `UpdateStatsRequest`, `CreateGameRequest`), two packet-type tables
  (`PacketTypeHit`..`PacketTypeGameSignal` at `0x47598c`..`0x4759cc`, 17 words; `var_PacketTypeServerResponse`..
  at `0x686248`..`0x686298`, 21 words), and the receive path for issue #26 (`rt_msg_client_process_app_message`
  `0x63ea48`). Our source has hits for `GetPolicy` (4 files), `CreateGame` (16), `GetMyClans` (5), `UpdateStats` (5)
  and none for `NatService` -- which may be a local client call, not a message; the protocol map is what settles it.
- KNOWN §1 already proves the game-level packet traffic is opaque to the server (DME relays it; the peer channel
  carries zero application data, research/18 §3). The in-game packet types are therefore documentation of what our
  relay carries, not new server handlers.

### 1.5 What the backlog already holds

No `docs/LATER.md` row names this corpus. Adjacent rows: **7** (#26, where the received chat line enters the
client), **16** (#54 nested rows in the r0001 map), **17** (#55 map bounds lose to carvings), **20** (#52 `exact` is a
fingerprint match, not a proof), **21** (#58 BinExport on Ghidra 12, trigger "the next naming pass"). KNOWN §2 holds
#52, #54, #55, #58 and #26 as Believed rows. Sprint 17's spec §5 put #52, #54, #55, #58 out of its scope; Sprint 18
is launcher/server-linux/docs only (no runtime, recomp or parity change). This sprint duplicates neither.

## 2. The sprint

### 2.1 Goal

Every human name Harry62's project gives a function start in our map is either in a sidecar with a provenance tag
that says it is his, or refused/held with a written reason; the tool that reads his format is a tested `tools_py`
module; the 32 disagreements each carry a ruling; our Horizon server's coverage of the client's network calls is a
table with tests for every gap that is a real message; the coverage moves are counted; and he is credited.

### 2.2 Milestones

- **T — the tools, tested (first, lock-free).** `tools_py/ps2dis_ide.py`: the reader promoted from `ide_extract.py`
  plus a writer, with a round-trip test on a synthetic fixture (a few KB of made-up memory and labels; no game bytes
  in the tree). The parser keeps every block it does not interpret as opaque bytes for a byte-identical round trip
  and **writes no text table of them**. `tools_py/cds_names.py`: the names/labels half of `cds_export.py` only.
  Both under `unittest` in `tools_py/tests/`.
- **N — the names (second; its apply is the one lock-bound step).** `tools_py/ps2dis_lever.py` turns his labels into
  proposals files under the house rules: only identifier/mangled labels on a function start (annotations, numeric
  referrals, inside and outside labels are never proposed); a screening pass that drops labels naming what patching a
  function does rather than what it is (§4's nine "purpose note" rows are the model and the test fixture); the
  pass name `ps2dis-harry62`. Default (D2): **loose**, so a name lands only where a strict lever of ours agrees; the
  62 loader names with self-evident bodies (sce/libc/libm) go as a hand file with a `file:line` per row; the 101
  no-twin and 112 non-exact names go to the r0004 sidecar as r0004 `Pass=hand` only after a body read each, or stay
  out. First a `--report-only` census, then the apply, the recomp, the census (`extents_changed: 0`) and both gates.
- **D — the disagreements, ruled (lock-free, beside N).** One disposition row per address in a tracked table, a test
  that every row of `disagreements.csv` has one, and the five genuine conflicts (`0x27b310`, `0x27ba30`, `0x184f20`,
  `0x3045a0`, `0x2a0b10`) each settled by a body read against `game/demo_scus_972_05`'s symbol of the same name; a
  name of ours that moves does so by ruling + a holds-file line, never a second proposal (DEVELOPING's rule).
- **P — the protocol map for our server (lock-free).** A research note tabling the client's network functions and
  packet-type tables (r0004 and their r0001 twins) against `RT_MSG_TYPE`, the Medius ids and the `RT.Models` classes:
  modelled / relayed opaque / client-local / missing. Each *missing* row that is a real Medius or RT message gets a
  `Server.Test` case (serialise/deserialise against a captured or constructed frame) or a `docs/LATER.md` row with
  its trigger. #26's receive path written down as the first map entry (LATER row 7), not run.
- **C — coverage, credit and the record (last, lock-free).** `sidecar_census.py` prints named/total per revision, per
  region (loader/overlay) and per provenance, before and after; DEVELOPING gains "Names from outside the tree" (the
  import and export round trip, the owner the only sender); README's "License and credits" gains one line; KNOWN
  gets the proven row with its artefacts; research/84's tables are superseded by a note that states what landed.

### 2.3 Decisions for the owner — each with the default the sprint proceeds on

| # | Decision | Default |
|---|---|---|
| D1 | Publishing his names in the public tree | Only function names on function starts, each row tagged `ps2dis-harry62` in `Pass` and `Source`; no annotation text, no memory bytes, no `.ide` in the tree; **waits for Harry62's yes, asked by the owner** (H0) |
| D2 | How strong his lever is | Loose (promotes only with a second, different lever of ours); the 62 self-evident loader names as a hand file; nothing strict on his word alone |
| D3 | r0004-only names | Into `recomp/socom2_names_r0004.csv` as r0004 `Pass=hand` after one body read each (N2 precedent); a name without a read stays out and is counted |
| D4 | Placement | A third branch `sprint-19` off `sprint-17` after Sprint 18's open settles, lock-free tasks in `agent/s19-*` worktrees, one chain for N's apply in a window the owner names, merged forward like Sprint 18 |
| D5 | The way back to him | An export of our names/labels only (CSV + `.cds`, optionally a labels-only `.ide` overlay), built by the promoted module; the owner alone sends anything, each time (HUMAN_TASKS) |

### 2.4 Scope — in

Tools (`tools_py/ps2dis_ide.py`, `tools_py/cds_names.py`, `tools_py/ps2dis_lever.py`, extensions to
`tools_py/research/symbols/sidecar_census.py`) with tests; proposals files under `game/` (git-ignored, regenerated);
the sidecars, the holds file, and one recomp/build/gate chain; a disposition table for the 32; a protocol-map research
note and `Server.Test` cases; DEVELOPING, README credits, KNOWN, LATER rows.

### 2.5 Scope — out

Any runtime behaviour change (the generated identifiers change; the code they name does not); the VU1/draw perf
threads (his objects are not on that path -- Sprint 17's F milestone keeps them); new server handlers beyond what the
map proves missing *and* a client actually sends; the in-game packet payloads (relayed opaque, KNOWN §1); #52, #54,
#55, #58 (LATER 16, 17, 20, 21 stay where they are; 21's trigger "the next naming pass" is noted at the close);
promoting `build_return_set.py`; anything from the files listed in §5.

### 2.6 What it touches

Recomp output: identifiers and file names only (census-proven); every generated file recompiles (#57's header cost),
so the build is a long one. Runtime source: none. Parity: none (pins must match unchanged). Server: tests and at most
model classes for a proven-missing message. Docs: DEVELOPING (L), README (L), KNOWN (L), LATER (L), a new research
note (S by location, `docs/research/**`, so no registry row is owed; DOC_MAINTENANCE §2).

### 2.7 Lock-bound vs lock-free

Lock-free: T1-T3, N1-N3, D1-D3, P1-P3, C1-C4 (suites in worktrees per the build.sh rule; the slow Python suite once,
not under a build -- the memory-floor and throughput rules). Lock-bound: **N4 only** (recomp + build + r0001 and r0004
gates in one chain). Server `dotnet test`: outside the loop lock as today's `Server.Test` runs are (confirm at the open).

### 2.8 Order and shape

H0 (the owner asks Harry62) in parallel with T1 → T2 → N1 (report-only) and D1/D2; P1 → P2 beside them; N2/N3 once
D's rulings are in; N4 the chain; C last. Three to four loop days, one window.

## 3. The acceptance bar, per milestone

- **T:** `python -m unittest tools_py.tests.test_ps2dis_ide tools_py.tests.test_cds_names` green; a synthetic `.ide`
  read → write is byte-identical; reading the real `game/harry62/SOCOM2.ide` reproduces `summary.txt`'s counts
  (5,956 user / 63,099 auto labels, 3 objects) and `new_function_names.csv`'s 512 rows exactly; no table of an
  uninterpreted block is written.
- **N:** `apply_names --report-only` prints applied / deferred / held / refused for every one of the 1,180 candidate
  rows (512 new + 514 agree + 32 disagree + the remainder accounted for), screened rows listed with the reason;
  `name_provenance audit` `0 findings` on both pairs; `recomp_census` `extents_changed: 0`, `kind_changed: 0`; the
  r0001 and r0004 gates 3/3 PINS MATCH on the chain's exe; `recomp_run.log` `Loaded <n> display names` with n the
  new row count.
- **D:** 32/32 rows dispositioned in the tracked table with a test; each of the five conflicts with its body-read
  artefact; any moved name has its ruling number and holds line.
- **P:** the map note exists with every function and table of research/84 §3's network families classified; every
  `missing` row has a `Server.Test` case or a LATER row; `dotnet test` green.
- **C:** the census prints before/after per revision (baseline r0004 1,736/16,417, r0001 1,871/14,879); the README
  credit line and DEVELOPING section in; KNOWN's row names the artefacts; LATER re-sorted.

## 4. Risks

- **Consent and licence.** His labels are his work and the repo is public. D1's default waits for his yes; until it,
  N's apply does not merge (T, D, P and the census can).
- **A wrong name in the generated code.** Mitigated by D2 (loose; two levers), the screening pass, the holds file, and
  the census; a cheat-maker's purpose label is a hint about what a body gates, never a name (research/84 §4).
- **The chain.** One long build (every generated file recompiles), two gates; a merged-chain pin blocks commits in the
  main tree while it runs; host memory floor (one suite at a time). Schedule N4 in an owner-named window.
- **Branch sprawl.** Three open sprint branches (17, 18, 19) is one more than precedent; D4 is the owner's call, and
  the fallback is to queue this behind Sprint 18 with only T and D started.
- **Scope creep into r0004-only body reads.** 213 names need a read before they can land; the sprint counts them and
  takes only what the time box allows, the rest a LATER row with its trigger.

## 5. Task table

Sizes in agent-hours: S ≤ 2, M 2-6, L > 6. [A] autonomous, [O] owner-only.

| id | title | size | lock | who | verification command / artefact | cites |
|---|---|---|---|---|---|---|
| H0 | Ask Harry62 whether his function names may be published in the public repo, tagged with his name; record the answer | S | free | [O] | a HUMAN_TASKS row struck with his answer and date | new (HUMAN_TASKS row) |
| H1 | Decide what of `agent/wizard-harry` merges (research/84, which assets); this draft assumes only the names tables, the parser and the objects table | S | free | [O] | the owner's ruling in the plan; a merge commit naming paths with `-- <paths>` | new |
| T1 | `tools_py/ps2dis_ide.py`: reader + writer of the ps2dis# v5 project; uninterpreted blocks kept opaque, never written as text | M | free | [A] | `python -m unittest tools_py.tests.test_ps2dis_ide` (synthetic round trip byte-identical; real-file counts = `summary.txt`) | new |
| T2 | `tools_py/cds_names.py`: our names/labels as Code Designer `.cds` (the `cds_label`/`write_cds` half of `cds_export.py` only) | S | free | [A] | `python -m unittest tools_py.tests.test_cds_names` (label legality, case-folded uniqueness) | new |
| T3 | Labels-only export (CSV + `.cds`; optional labels-only `.ide` overlay with `CleanupImportedLabel`-safe text) for D5 | M | free | [A] | unittest on a synthetic project: no memory or uninterpreted block in the output; `clean_ok` holds for every label | new |
| N1 | `tools_py/ps2dis_lever.py`: proposals from function-start identifier/mangled labels, screening pass, `Pass=ps2dis-harry62`, loose | M | free | [A] | `python -m unittest tools_py.tests.test_ps2dis_lever`; `python -m tools_py.apply_names ... --report-only` census pasted in the plan's Log | new; KNOWN §1 sidecar row |
| N2 | Hand file for the 62 loader names whose bodies are self-evident (sce/libc/libm), `file:line` evidence each, r0001 and r0004 (`--through`) | M | free | [A] | `apply_names --report-only` on the hand file: applied count, 0 refused | KNOWN §1 sidecar row (N1/N2 precedent) |
| N3 | Body reads for the r0004-only candidates (101 no-twin + 112 non-exact) within the time box; an r0004 `Pass=hand` file for those read | L | free | [A] | `name_provenance audit recomp/socom2_ghidra_r0004.csv recomp/socom2_names_r0004.csv` `0 findings` after a report-only apply; uncovered count recorded | LATER 20 (#52) adjacent |
| N4 | Apply N1-N3, recomp, census, build, r0001 + r0004 gates in one chain | L | **bound** | [A] (window [O]) | `recomp_census` `extents_changed: 0`; both gates 3/3 PINS MATCH; `Loaded <n> display names` | KNOWN §1 sidecar row |
| D1 | Disposition table for the 32 disagreements (alias / purpose note / conflict / excluded) + a test that every row has one | S | free | [A] | `python -m unittest tools_py.tests.test_ps2dis_disagreements` | new |
| D2 | The five genuine conflicts: one body read each against `game/demo_scus_972_05`; a ruling per moved name with a holds line | M | free | [A] | the five artefacts in the table; `apply_names --report-only` shows no unruled change | new |
| D3 | The 18 alias rows: record his short name beside ours in the research note (no sidecar schema change) | S | free | [A] | the note's table; sidecar unchanged for those 18 addresses (`git diff` empty on them) | new |
| S1 | Objects cross-check: a test that the r0004 statics `cameraHolder` and `roundState` (socom2_addresses.h:229, socom2_net_bounds.h:102) equal his `cAppCamera`/`GameObject` statics, and the field offsets the harness already reads agree with his field names | S | free | [A] | `python -m unittest tools_py.tests.test_ps2dis_objects` (reads a tracked 3-row statics table, not the `.ide`) | KNOWN §1 round-state row |
| P1 | Protocol map note: his network families and packet-type tables against `RT_MSG_TYPE`, the Medius ids and `RT.Models` (modelled / relayed / client-local / missing) | M | free | [A] | `docs/research/<n>-client-network-map-vs-horizon.md` with every row classified | new; KNOWN §1 research/18 rows |
| P2 | `Server.Test` cases for each `missing` row that is a real message; else a LATER row with trigger | M | free | [A] | `dotnet test server/horizon-server/Server.Test` green | new |
| P3 | #26's receive path written as the map's first entry (functions and order only; no run) | S | free | [A] | the note's §; LATER row 7 updated with the pointer | LATER 7, issue #26, KNOWN §2 #26 row |
| C1 | Coverage census: named/total per revision, region, provenance; before and after | S | free | [A] | `python -m tools_py.research.symbols.sidecar_census` output in the plan's Log (baseline r0004 1,736/16,417, r0001 1,871/14,879) | new |
| C2 | DEVELOPING "Names from outside the tree": import, lever, rulings, export, owner as the only sender | S | free | [A] | `python -m unittest tools_py.tests.test_doc_maintenance` green | new |
| C3 | Credit line in README "License and credits" (wording the owner approves) | S | free | [O] approves, [A] writes | the line in README; leakcheck passes | new |
| C4 | KNOWN proven row with artefacts; LATER re-sort (row 21's trigger noted fired or not) | S | free | [A] | `docmaint` checks green | LATER 21 (#58) |

## 6. What I read and what I deliberately left out

**Read** (worktree `C:\Projects\wt-wizard-harry`): `docs/research/84-harry62-ps2dis-project.md` sections 1, 2, 3, 4, <!-- docmaint: future -->
6, 7, 8; `docs/research/assets/84-ps2dis-ide/new_function_names.csv` (head and counts), `disagreements.csv` (all 32), <!-- docmaint: future -->
`objects.txt` (head and line count), `summary.txt`, `return_set_README.md` (its first 60 lines), and the docstrings,
function lists and imports of `ide_extract.py`, `cds_export.py`, `build_return_set.py`; `user_labels.csv` sampled
(head, kind/placement counts, greps for Net, Lobby, Medius, Vu, Snd, Sound, Draw, Render, Mission, Packet).
**Read** (main tree): `docs/CURRENT_SPRINT.md` header and Sprint 18 block; `docs/KNOWN.md` §1-§3 (skimmed by row,
the sidecar row in full); `docs/LATER.md`; both specs named in the brief (Sprint 18 in full to §3, Sprint 17's header,
milestone H, decisions, bar, out-of-scope, pointers); `docs/DOC_MAINTENANCE.md` §1-§3; DEVELOPING's "Names in the
generated code" section; `recomp/` sidecars, maps and holds (counted); `tools_py/apply_names.py` (lever rules);
`tools_py/` listing and tests listing; `server/horizon-server/` layout, `RT.Common/Types.cs` greps, `Server.Test/`
listing; `README.md` credits; the two runtime headers by grep.

**Deliberately left out, unopened:** `codes.txt`, `your_r0005_hooks.csv`, research/84 section 5 and section 9. Also
not taken from the tools: the second function of `cds_export.py` and the parts of `build_return_set.py` that copy
his project through whole; the return set's own README sections that refer to those files were not used. Nine of the
32 disagreements and two hand-named rows are carried in this draft only as counts and dispositions ("ours stand, not
imported"), not by name.

## 7. Open questions for the owner

1. Will you ask Harry62 whether his function names may go into the public repo under his name (H0)? Until he says
   yes, the tooling, rulings and server map can land and the names wait.
2. Sprint 19 as a third open branch beside 17 and 18, or queued behind Sprint 18's close (D4)?
3. Which parts of `agent/wizard-harry` should merge at all (H1)? This draft assumes the names tables, the parser and
   the objects table, and nothing I left unread.
4. Is a loose lever (his name lands only where one of ours agrees) the right strength, or do you want the 299
   exact-twin names taken on his word (D2)?
5. Is one window for the N4 chain (a recomp, a long build, two gates) acceptable in the next few days, given the
   throughput rule of one chain a day and Sprint 17's own chains?
