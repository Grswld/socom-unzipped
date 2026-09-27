# 46. The readable image, day one: what the symbol work is, what it found, and how Sprint 12 will run

Date: 2026-09-24. Written by the peer session socom-pc-6c at the owner's request, as the record of one day's
review, measurement and decisions around the SOCOM 1 demo's symbols — the findings that are not in research/44
or /45, the two outside analyses that were audited against the tree, one retraction, the copies of the inputs
that exist, and the procedure Sprint 12 opens under. Read-only throughout: no game ran, no recompile happened,
`recomp/socom2_ghidra.csv` is unchanged. Every number names the command or script that produces it; the scripts
live in `tools_py/research/symbols/` (kept tracked by R263) and run from the repository root with the four
git-ignored ELFs in place.

## 0. What this work is, in two sentences

SOCOM Unzipped is a static recompilation, not a decompilation: the game's original instructions run as they
were, translated to native code, and no source is reconstructed. Sprint 12 is symbol recovery on top of that
recompilation: names, types and their provenance carried onto the generated code so a reader can follow it and
the runtime can hook it by name, while the bytes it executes stay the game's own.

The community's words for the pieces, for anyone searching: *symbol porting* or *symbol propagation* (what
BinDiff and Diaphora call carrying names between builds), *debug-info transfer* (the types half), and
*symbolication* (replacing an address with a name). Decompilation is what reCOM does for SOCOM 1
(research/11), and it is not what this repository does.

## 1. What Task 7's 479 proposals are worth, measured against the compiled code

The generated code is almost entirely anonymous today (`toml_overlap.py`, the `recomp/output` census):

| generated function files in `recomp/output` | count |
|---|---|
| `FUN_xxxxxxxx` (Ghidra's placeholder, from the CSV) | 7,958 |
| `sub_xxxxxxxx` (the recompiler's own gap-fill placeholder) | 6,750 |
| `caseD_*` (switch labels) | 42 |
| real names | 130 |

Two facts the Task 7 note did not state:

- **272 of the 479 proposals repeat a name `recomp/socom2.toml` already carries.** The toml's stub list names 656
  addresses, mostly Sony SDK; 273 proposals land on them and 272 agree name for name (the one difference,
  `setD3_CHCR` against `setD4_CHCR`, is a sibling helper). That is an independent confirmation of the matcher
  — 272 of 273 — and it means the genuinely new names number about 206, of which 50 are engine routines.
- **The toml's names never reached the generated code.** `recomp/output/ps2_recompiled_stubs.h` declares
  `sceCdDelayThread` as `sub_0018DBB8`. Applying the CSV renames puts readable names into the output for the
  first time, even for functions the project already knew. Carrying the toml's 656 into the output is a Sprint
  12 task of its own (the handoff, §3 item 5).

Readable form (`readable_names.py`): the demo's names are Metrowerks mangling in the old GNU style; a short
parser yields `Class_Method` (`CQuat_Mul`, `CZSealBody_CanClimbWall`). Overloads collide — 2 names over 4 rows
inside the 479 (`C2DBitmapPoly_SetUV`, the `CAiMapLoc` constructor), 255 names over 607 functions across the
demo's 9,703 — so an argument suffix is needed only where the readable name is not unique. The recompiler
sanitises identifiers itself (`ps2xRecomp/src/lib/code_generator.cpp`, `sanitizeIdentifierBody`), so the
mangled spelling would also compile; the readable one is for the filenames and the reader. The demo's table
names 1,212 classes; the largest are CZSealBody (351 methods), CSealCtrlAi (140), CZKit (110), CSealCtrl (92),
CZWeapon (91), CZOnlineLobby (65), CNetCnf (38) — an architecture map the engine had never given up before.

## 2. The two outside analyses, audited

Two ChatGPT analyses of the symbol work were read against the tree. What they got right, what the repository
had already settled, and what was new:

**Settled before they arrived.** The compiler: all three builds say `MW MIPS C Compiler (2.4.1.01)` — retail
(research/05), the SOCOM 1 demo's `.comment`, and the SOCOM II Aug 18 demo's `.comment` (read this day:
`SOCOM 2 v0001 17:30:02 Aug 18 2003`, stripped, `.symtab` of size 0). The 3.0.x hypothesis is closed. One
oddity: the SOCOM 1 demo's `.debug` names a path under `C:\apps\cw301`, so a CodeWarrior 3.0.1 install sat on
Zipper's build machine in 2002 while the producer string stayed 2.4.1.01. reCOM is cloned and assessed
(research/11). The three prototypes are listed (research/03); only the Aug 18 demo is in hand; the Nov 25
2003 build sits between r0001 (Oct 11 2003) and r0004 (`SOCOM 2 r0004 10:14:38 Nov 3 2004`). DWARF1 and the
ccc route are in research/44 §1. Matching recompilation and the preserved Metrowerks compiler corpus serve a
decompilation, which this is not (research/01).

**New and measured** (each became a task or a ruling, R257–R263):

- *Link order survives* (`link_order.py`): sorting the 987 pairs by our address, consecutive pairs keep the
  demo's order 97.9 % in the boot loader, 91.6 % in FTSCore, 92.1 % in ZSealEtc; 151 anchor gaps hold the same
  function count in both builds, 510 functions between them. Task 7b then showed that a correspondence is not
  evidence: under a body key unique across the whole image, position adds **6** names and the bridge through
  the Aug 18 demo adds **0** (research/45). The lever is real and small.
- *Vtable slots through RTTI* (`vtable_anchors.py`, `vtable_rtti.py`): Metrowerks lays a vtable out as
  `[pointer to the class's __RTTI__ object, 0, slot0, slot1, …]` (checked on the demo's `__vt__10CZSealBody`,
  0x472110, 108 bytes). The class-name strings survive in retail, so **string → RTTI object → vtable** locates a
  retail vtable with no function anchor: `"CZSealBody"` at 0x65c240 → RTTI object 0x65c288 → vtables 0x6691a0
  (26 slots) and 0x669210 (7 slots). Over all 248 demo `__vt__` objects: 111 classes resolve to exactly one
  retail vtable (1,154 demo slots against 1,496 retail; 41 with equal counts), 54 to several (multiple
  inheritance, or a bare name shared across namespaces), 66 names absent in retail, 14 templates skipped.
  Body-matched anchors alone would have opened 19 vtables and 49 slots. This is Task 7c (R260): an edited
  virtual method keeps its slot, which attacks the 78 % of demo bodies that have no byte-identical twin.
- *Provenance* (R261): the proposals file carries score, pass, size and the mangled original, but
  `recomp/socom2_ghidra.csv` carries only a name and `carry_names` moves only names. The rename commit writes
  a tracked sidecar so no name exists without its reason once passes stack.

**Declined with reasons** (R262): a custom Ghidra Function ID database (it re-derives the fingerprint plus
the callee-set pass and cannot cross the 78 % ceiling); r0004 as a version-tracking corpus (99.66 % identical
to r0001, so no independent evidence against SOCOM 1). BinDiff replaces Ghidra Version Tracking in the
deferred cross-check because flow-graph similarity survives edits where byte hashes do not.

## 3. The debug section is thinner than "full symbols", and the voice codecs — with a retraction

`debug_paths.py` over the demo's 5.1 MB `.debug`: 114 path strings, 95 source files, from
`Z:\dev\Apps\FTS` (37), `C:\dev\libpttclient` (35), and the gamez engine directories a handful (zcamera 5,
zfts 2, one each for zgame, ztwod, zentity, znode, zmath, zseal, zui, zutil). Engine class names do occur in
it (CZSealBody 109 times, CMission 116, CEntity 96, CPnt3D 69), so some struct types exist, but the ccc prize
is mostly the FTS application layer and the codec, not the whole engine — and SOCOM 1's layouts are a year
older than SOCOM II's, so every field offset must be confirmed against SOCOM II access patterns before a hook
trusts it (R262's caveat).

**The codecs, as verified against all four images** (a regex over the raw files for source-path strings;
the libpttclient unit list is the 34 files of the public LPC-10 reference implementation):

| build | voice codec evidence |
|---|---|
| SOCOM 1 demo, May 2002 | `libpttclient.c` plus all 34 LPC-10 reference units (`analys.c … vparms.c`, with `f2clib.c`, the Fortran-to-C runtime); 48 named functions (`PTT_Init`, `PTT_JoinGame`, `PTT_PushToTalk`, `lpc10_encode`, `lpc10_decode`, …). **None of the 48 is placed in our image**, and retail carries no `PTT_` or `lpc10` string |
| SOCOM II Aug 18 demo, r0001, r0004 | 25–26 source paths `../../SaseEncVad/source/*.c` and `../../SaseDec/source/*.c` (`Coder.c LDPDA.c PtchCand.c QP0SC3.c RefineC0.c Voicing.c PostFilt.c PreProc.c BitPackC.c PackSC.c DecSC.c SWSynth.c SetAmps.c libspeech.c libquan.c libsigproc.c libsnd.c libmath.c`; r0004 adds `CalcCost.c`, `EncSC.c`): a codec called **SASE**, an encoder with voice-activity detection plus a decoder; the file names say a sinusoidal low-rate speech coder; no vendor is named by the strings. The Aug 18 demo alone also carries `rt_lpc10 version: 1.00.0002` |

> **Retraction.** The first version of this finding, sent to the Sprint 11 controller in the afternoon, said the
> codec was GSM 06.10. It was an identification from five file names out of thirty-five, and it was wrong;
> the full list is LPC-10's, and SOCOM II ships neither. The controller corrected research/44's addendum and
> R259 the same evening (`b4be600`). The lesson is the one research/44 already carries: an identification is a
> number with a command, or it is not made.

For voice chat (the site's Q5 goal): SOCOM II's codec is SASE; the SOCOM 1 demo's debug types for its own codec
describe LPC-10 and do not help. Question 11 of the Sprint 12 research wave is the SASE note.

## 4. The copies that exist, and where

All git-ignored; none may ever enter the repository in any form. Sizes are the filesystem's; digests are those
the served `SHA256SUMS` carries (research/44 §1 names the demo's).

| what | where on the owner's machine | size |
|---|---|---|
| our r0001 image, merged from the disc | `game/disc/`, `game/overlays/socom2_game.elf` | 4,835,072 B |
| the r0004 image | `game/overlays_r0004/socom2_game_r0004.elf` | 5,016,016 B |
| the SOCOM 1 demo ELF (the symbol source; Zero1UP's dump, reCOM's credited source) | `game/demo_scus_972_05/SCUS_972.05` | 10,765,300 B |
| the SOCOM II Aug 18 demo ELF (stripped) | `game/demo_scus_973_68/SCUS_973.68` | 4,559,408 B |
| the two demo disc images they came from | the same two directories, raw 2352-byte MODE2 `.bin` + `.cue` | 717,635,584 B and 565,035,008 B — **both tail-truncated downloads** (16,064 B and 64 B short of the archive's sizes, so their md5s differ from the archive's); the ELFs extracted whole |
| the retail ISO | `game/` | 4.38 GB |
| PSRewired's r0004 capsule and its decoding | `game/r0004/` | research/43a |

A second copy of the four ELFs and their `SHA256SUMS` is served from a password-protected HTTPS location
on the project's site, behind an unguessable path segment and HTTP basic auth, with no listing, no caching and a
`noindex` header; the files and the password file live on that box outside the site's deploy tree. It exists
for Claude cloud sessions, whose sandbox reaches the network only through an HTTPS proxy with a domain
allowlist (no FTP, no SSH). `scripts/fetch_private_inputs.sh` pulled the four into their `game/` paths and
verified each against the served digests *(retired 2026-09-27, issue #75, owner ruling O18/R296: no cloud session since 2026-09-26, the script deleted, the location removed by the site session)*; the URL and credential are environment variables and appear in no
tracked file (the owner's git-ignored `vm/` note holds them). Probed after the deploy: 401 without the
credential, 404 on a wrong path, 403 on the directory, 200 with the credential; the full fetch takes 33 s.

Two cloud-environment facts learned the hard way, for the next person: the sandbox runs an environment's
setup script **before the repository is cloned** and **without the environment's variables** (exit 6, "not a
git repository", curl with an empty user), so the session itself runs the fetch after checking out its branch;
and a session copies the environment's variables once at start, so a session started on the wrong environment
cannot be repaired, only replaced.

## 5. How Sprint 12 runs, in one paragraph

R263 made the naming programme Sprint 12, "the readable image". A Claude cloud session owns it end to end
under `docs/superpowers/plans/2026-09-24-sprint-12-cloud-handoff.md` (on `sprint-11` until that sprint's close reaches `main`) <!-- docmaint: future -->, ratified with amendments by the local
Sprint 11 controller: `sprint-12` off `origin/sprint-11`, pushes only there, never to `sprint-11` or `main`;
Sprint 11's live files off limits; rulings numbered `S12-Rn` in the Sprint 12 plan and folded into the global
sequence at the merge; a task whose proof needs the machine (recomp, runtime, the r0001 gate) gets a
`PROOF REQUESTED` row that the local controller pays at the owner's build windows and answers on the row; Task 7c
is the cloud's; research numbers **47 onward** are the cloud's (this note took 46). The sprint opens with the
rename pass so every later gate runs on the renamed tree, then a fourteen-question research wave with the
authority to add or retire tasks by ruling, then the tasks.

## 6. What this note does not claim

No rename is applied; the 479 plus 7b's six are proposals until the rename commit lands with its sidecar and
its gate. The vtable numbers count candidate slots, not names: alignment on body-matched fixed points and the
equal-count rule decide what is proposed, and the false-pair rate against the 828 proved pairs decides what is
kept. SASE's vendor, frame size and bit rate are not established here. The Nov 25 2003 prototype and the
Aug 28 2003 beta are not in hand, and nothing about their contents is known beyond research/03's listing.
