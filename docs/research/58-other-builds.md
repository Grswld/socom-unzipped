# 58. The two SOCOM II builds not in hand: the Aug 28 2003 beta and the Nov 25 2003 prototype

Date: 2026-09-24. Sprint 12 research wave, question 13 of the cloud handoff §4
(`docs/superpowers/plans/2026-09-24-sprint-12-cloud-handoff.md`). This note works only from documents. Nothing
was downloaded, no external site was opened and no server was contacted. The only inputs are the repository and
the four images in hand. No game bytes are quoted: only names, addresses, counts, and version or banner strings.
The spec (§5) says the sprint "does not fetch the Nov 25 2003 prototype or the Aug 28 2003 beta". This note
covers what each build would add, so that the owner can decide whether to look for either one.

**The one-line answer.** Both builds sit on the SOCOM II side of the SOCOM 1 → SOCOM II edit, so neither can
serve as a bridge. research/45 §7 shows that the Aug 18 2003 demo, which is closer to SOCOM 1 than either,
already adds 0 names that way. **Only a copy that still has its `.symtab` is worth having.** A named copy would
be worth a lot: it would carry SOCOM II's own names, which do not have to cross the year of edits that stops
research/44 at 78 %. A body-byte proxy measured here puts it at **at least ~5,200 of our 14,879 rows**,
against the 987 that SOCOM 1 reaches. Zipper's record points to both builds being stripped. The evidence for
that is thin: three images (one named, two stripped), and the one named image is a *public beta* disc, the same
kind of build as the Aug 28 one. An unnamed copy of either build is corroboration, not discovery. By date the
Nov 25 build is closer to r0001 than r0004 is (45 days against 389), so R262's objection to r0004 applies to
it even more strongly.

The commands (run from the repository root, on the git-ignored inputs under `game/`):

```
# A -- each image's section table and symbol census (§1, §3)
python -m tools_py.elf_symbols game/demo_scus_972_05/SCUS_972.05
python -m tools_py.elf_symbols game/demo_scus_973_68/SCUS_973.68
python -m tools_py.elf_symbols game/disc/socom2_game.elf
python -m tools_py.elf_symbols game/overlays_r0004/socom2_game_r0004.elf

# B -- .comment, build banners, the memory-card title and middleware versions (§1, §3); prints strings only
python3 - <<'EOF'
import re
from tools_py.elf_symbols import read_elf
for p in ["game/demo_scus_972_05/SCUS_972.05", "game/demo_scus_973_68/SCUS_973.68",
          "game/disc/socom2_game.elf", "game/overlays_r0004/socom2_game_r0004.elf"]:
    e = read_elf(p); c = e.section(".comment")
    print(p, "sections", len(e.sections), ".comment",
          None if c is None else e.data[c.offset:c.offset + c.size].split(b"\0")[:2])
    for va, b in e.segments:
        for m in re.finditer(rb"SOCOM 2 [vr]\d{4} [0-9:]{8} [A-Z][a-z]{2} [ 0-9]\d \d{4}|SOCOM:2002 Public Beta"
                             rb"|[A-Za-z_0-9]+ version: [0-9A-Za-z.]+", b):
            print("  0x%08x %s" % (va + m.start(), m.group().decode()))
EOF

# C -- research/45's bridge, reduced to the lever-2 lines (no --positional/--holdout, no output file) (§2)
python -m tools_py.ghidra_symbol_match \
    game/demo_scus_972_05/SCUS_972.05 game/disc/socom2_game.elf recomp/socom2_ghidra.csv \
    --prefix --top 0 --bridge game/demo_scus_973_68/SCUS_973.68

# D -- demo2 (stripped, byte-scanned) placed onto r0001 and onto r0004: body drift inside SOCOM II (§2)
PYTHONPATH=. python3 - <<'EOF'
from collections import Counter
from tools_py import address_matcher as am, symbol_levers as sl
from tools_py.elf_symbols import read_elf
d2 = read_elf("game/demo_scus_973_68/SCUS_973.68"); d2f = sl.scan_functions(d2.segments)
for label, elf, csv in [("r0001", "game/disc/socom2_game.elf", "recomp/socom2_ghidra.csv"),
                        ("r0004", "game/overlays_r0004/socom2_game_r0004.elf", "recomp/socom2_ghidra_r0004.csv")]:
    f, s = am._read_side(elf, csv); m = am.match(d2f, d2.segments, f, s)
    hows = Counter(h for b, h in m.values() if b is not None)
    print("demo2 (%d ranges) -> %s (%d rows): placed %d, %s" % (len(d2f), label, len(f), sum(hows.values()), dict(hows)))
EOF

# E -- the day counts (§1, §2)
python3 -c "from datetime import date as d; print((d(2003,8,18)-d(2002,5,13)).days, (d(2003,8,28)-d(2003,8,18)).days, \
(d(2003,10,11)-d(2003,8,28)).days, (d(2003,11,25)-d(2003,10,11)).days, (d(2004,11,3)-d(2003,11,25)).days, \
(d(2004,11,3)-d(2003,10,11)).days)"
```

A, B and E each take under a second, C takes about 20 s and D about 8 s. None of them writes a file. D is the
only new measurement in this note. It uses the same `scan_functions` and `address_matcher.match` that research/45
§7's hop 2 uses.

## 1. Every SOCOM II build the project knows of

| build | date | build id / banner (command B) | symbol status | where the project learned of it |
|---|---|---|---|---|
| SOCOM 1 `SCUS_972.05` (the "demo"; reCOM's basis) | May 13 2002 (research/03) | no `SOCOM n vNNNN` banner. Its memory-card title is **`SOCOM:2002 Public Beta`** @0x00459710, beside `icon.sys`. `.comment` = `MW MIPS C Compiler (2.4.1.01)`, `PlayStation2` | **full**: `.symtab` 350,304 B, 21,894 entries, 9,703 `STT_FUNC`; `.debug` 5,093,034 B; `.line`; `.relmain` 115,142 relocations; 11 named sections (command A) | research/03 (listed on Hidden Palace), research/19 §4; **in hand** (the owner's disc, Zero1UP's dump: `docs/CURRENT_SPRINT.md` Sprint 11 open) |
| SOCOM II demo `SCUS_973.68` | Aug 18 2003 | `SOCOM 2 v0001 17:30:02 Aug 18 2003` @0x005135E0. `.comment` is the same compiler pair as above | **stripped**: `.symtab` and `.strtab` headers present at size 0, no `.debug`/`.line`, 5 named sections, `0 symbol table entries` (command A); its code section's header has lost its name too (8 headers incl. the null one, command B) | research/03 (Hidden Palace); **in hand** |
| SOCOM II beta, serial `SCES-973.66` (research/03) or `SCUS_973.66` (research/02) | Aug 28 2003 | **unknown** | **unknown** | research/03 ("Prototypes on Hidden Palace"), research/02 (serial only). **Not in hand** |
| SOCOM II retail r0001, `SCUS_972.75` v1.02 | Oct 11 2003 (redump EXE date, research/03) | `SOCOM 2 r0001 17:22:21 Oct 11 2003` @0x003E17E0 (command B; research/43b §1) | boot ELF **`.symtab` empty** (research/03). The game code is two DNAS-encrypted zlib overlays in `RUN/RAW/APACHE00.ZDB`, and the Metrowerks overlay header that research/03 decodes has no symbol field. `game/disc/socom2_game.elf` is the project's assembly of loader + overlays (`tools_py/disc_to_elf.py`) and has no section table at all: command A shows `0 symbol table entries` | the owner's disc; **in hand** |
| SOCOM II prototype | Nov 25 2003 | **unknown** (serial, region and revision token also unknown) | **unknown** | research/03 ("Prototypes on Hidden Palace", date only). **Not in hand** |
| SOCOM II r0004 (the online update) | Nov 3 2004 | `SOCOM 2 r0004 10:14:38 Nov  3 2004` @0x0040CC60 (command B; research/43b §1) | same layout as r0001, no symbols (command A) | pushed to memory card on login (research/02); **in hand** |

The gaps between those dates, from command E: SOCOM 1 → Aug 18 2003 demo **462 days**; demo → Aug 28 beta
**10**; beta → r0001 **44**; r0001 → Nov 25 prototype **45**; prototype → r0004 **344**; r0001 → r0004 **389**.

research/02 mentions two more builds whose dates and images the project does not have: the PAL, JP and KOR
retail discs (`SCES_523.06`/`SCES-51904`, `SCPS_150.65`, `SCKA_200.20`), and online betas. The only trace of the
betas is two Medius app IDs, "NTSC beta 10202" and "PAL beta 10540". Whether the Aug 28 build is the NTSC online
beta is **unknown**. Its disc's `SYSTEM.CNF` and banner would settle that, and the two notes' serial prefixes
disagree (SCES vs SCUS). Both SOCOM II and SOCOM 1 discs in hand carry `SCUS-97xxx` serials, which fits research/02's spelling. That is
a pattern, not proof.

**Middleware ladder (command B):** this is a second, banner-independent way to place a build.

| string | demo Aug 18 2003 | r0001 Oct 11 2003 | r0004 Nov 3 2004 |
|---|---|---|---|
| `dme version:` | 1.32.0050 | 1.32.0070 | 1.32.SJ84 |
| `rt_msg_client version:` | 1.08.0201 | 1.08.0204 | 1.08.0210 |
| `rt_udp version:` | 01.02.0041 | 01.02.0048 | 01.02.0053 |
| `rt_audio version:` | 1.08.0003 | 1.08.0009 | 1.08.0012 |
| `rt_comm version:` | 1.03.0024 | 1.03.0029 | 1.03.0029 |
| `libnetb version:` | 1.09.0005 | 1.10.0000 | 1.10.0000 |
| `rt_lpc10 version:` | 1.00.0002 | absent | absent |

The SOCOM 1 disc carries `dme 1.16.S033`, `rt_msg_client 1.06.S016` and `libnetb 1.05.0005`. A candidate
from Aug 28 should read at or between the first two columns, and one from Nov 25 at or between the last two.
A reading outside those ranges means the dating or the provenance is wrong.

**A correction to the brief and to research/44's addendum.** In both demos in hand, `.comment` holds the
compiler pair (`MW MIPS C Compiler (2.4.1.01)`, `PlayStation2`; 43 bytes), not the build id. The
`SOCOM 2 v0001 …` id is a string in the loaded image at 0x005135E0. research/44's addendum says the id was read
from `.comment`. That applies to the compiler only. The banner is found with command B's regular expression.

## 2. The two builds, one at a time

### Where they sit relative to the edit (research/45 §7)

research/45 §7 shows the SOCOM 1 → SOCOM II edit happens before Aug 18 2003: "the Aug 2003 demo is already on
the far side of it". Its hop 1 (demo1 → demo2) resolves 859 functions, fewer than Task 7's direct 987, and 130
of the 131 fresh candidates die on hop 2. Command C reproduces those lines exactly:
`hop1 resolved 859, hop2 resolved 5206, … new 0`. The Aug 28 beta comes 10 days later and the Nov 25
prototype 45 days after r0001, so **both are further from SOCOM 1 than the demo already in hand.** research/45
§7's transitivity argument (masked-hash matching is transitive, so a bridge adds a name only when a direct match
is ambiguous and both hops are unique, which happened 0 times) applies to them with a *worse* hop 1. Neither can
add a SOCOM 1 name as a bridge. research/45 §7 also says a *named* intermediate build is the only kind that adds
names, and that is the whole case for looking.

**Body drift inside SOCOM II (command D, new):**

```
demo2 (12250 ranges) -> r0001 (14879 rows): placed 5206, {'exact': 3828, 'hash+callees': 157, 'relinked-body': 1221}
demo2 (12250 ranges) -> r0004 (16417 rows): placed 4966, {'exact': 3700, 'hash+callees': 150, 'relinked-body': 1116}
```

The demo is 54 days from r0001 and 443 from r0004, yet it places only 240 fewer functions onto r0004. Once
past the edit, SOCOM II builds stay close to each other at the body level. research/43b §1 shows the same thing
from the other side: r0004 against r0001 has 5,105 byte-identical and 6,810 relocation-only bodies. The
5,206 figure is a **floor** for a build as close as the demo. That is because the demo's table comes from the
byte scan, which gets both boundaries right for only 94.6 % of functions (research/45 §7, reprinted by command
C), and a mis-bounded range can only lose a match. A `.symtab` would give exact boundaries.

### The Aug 28 2003 beta

- **Position:** SOCOM II side of the edit. It is 10 days after the demo in hand and 44 days before r0001.
- **(a) If named.** It would name SOCOM II functions directly on our image, with no year of edits to cross.
  The demo-as-proxy floor is **~5,206 r0001 rows** (command D), about 5.3× the 987 that SOCOM 1 places and
  10.9× the 479 proposed (research/44 §3). `carry_names` would take them on to r0004. Two further gains, if it
  kept a `.debug` like SOCOM 1's: SOCOM II's own struct layouts, which removes R262's layout-age caveat on
  Goal 5; and names for the **SASE** voice codec, which SOCOM 1 cannot supply because it speaks LPC-10
  (research/44 addendum; research Q11/Q5).
  **Probability that it is named:** Zipper's record is: the 2002 build is named in full, and both 2003 images
  read (Aug 18 demo, r0001 boot ELF) are stripped. The demo keeps empty `.symtab`/`.strtab` headers, drops
  `.debug`/`.line` and its code section's name, which looks like a deliberate strip step in the 2003 pipeline (an inference from commands A and B,
  not a document). **The pattern predicts stripped.** Confidence is **low**, because the sample is three images,
  and the one named image is the one whose memory-card title says `SOCOM:2002 Public Beta`. That is the same
  kind of build as the Aug 28 beta, which comes 10 days after a stripped demo. Only the build itself, or a description
  of it where it circulates, can settle this.
- **(b) If unnamed.** It gives body evidence only, from a third SOCOM II point between Aug 18 and Oct 11 2003.
  It could split research/45's 704 bridge confirmations and the demo → r0001 drift into "edited by Aug 28" and
  "edited after". That is history, which is useful for research/43b §9 item 2 ("which functions are genuinely
  new"), but it is not names. Expected new names: **0**, since it is a worse bridge than the demo, which already
  gives 0. The Medius beta app ID it may carry (research/02) is an online-server question, not a naming one.

### The Nov 25 2003 prototype

- **Position:** SOCOM II side of the edit. It is **45 days after r0001 and 344 days before r0004** (command E),
  so by date it is much closer to r0001. It comes after the NTSC master (Oct 11 2003). Whether it continues the
  NTSC line (an r000N between r0001 and r0004) or belongs to a sibling branch for another region (research/02
  lists PAL, JP and KOR discs) is **unknown**. Its banner token and its `SYSTEM.CNF` serial would settle that.
- **(a) If named.** This is the largest possible prize. By date it is at least as close to r0001 as r0004 is,
  and research/43b §1 places 12,071 of r0001's 14,879 rows against r0004 (81.1 %). So a named Nov 25 build would
  be expected to name most of our image, and r0004 through `carry_names`. That is an **expectation, not a
  measurement**: a regional branch could differ more. **Probability that it is named:** the same pattern
  predicts stripped. Whether this "prototype" is an internal debug build (the kind most likely to keep symbols)
  or a release candidate is **unknown**. research/03 records only its date.
- **(b) If unnamed, and R262's point.** R262 declined r0004 as a corpus because it is "99.66 % identical to
  r0001, no independent evidence against SOCOM 1", and said the Nov 25 prototype "would be" that evidence. The
  dates argue against that last clause. The prototype is closer to r0001 than r0004 is (45 days against 389), and
  command D shows even a year of SOCOM II drift is small. By research/45 §7's transitivity argument, any SOCOM 1
  body it matched, r0001 would also match. The exception is a routine that r0001 changed and the prototype
  changed *back*, which is not plausible. So an unnamed Nov 25 build **carries no independent evidence against
  SOCOM 1**. It inherits R262's objection to r0004 in stronger form. What it *could* do is split research/43b's
  r0001 → r0004 changes into "by Nov 25 2003" and "after". That is again history, not names.
- **A number in R262 to correct.** The only 99.66 % in the tree is **r0001 matched against itself**
  (14,828 / 14,879, the 51 unreadable bodies: `docs/KNOWN.md`'s chat-bound row, `docs/CURRENT_SPRINT.md` Task
  10). r0004 against r0001 is **81.1 %** placed (research/43b §1: 12,071 / 14,879; 5,105 byte-identical). R262's
  conclusion still holds, because r0004 descends from r0001 and carries nothing against SOCOM 1 that r0001
  lacks, but its number belongs to a different measurement. One side note: `game/r0004/match.json` as
  regenerated in this checkout reports `resolved 10008` of 14,879 (rate 0.672626, read from its `summary`), not
  research/43b's 12,071, and `recomp/socom2_ghidra_r0004.csv` now has 16,417 rows, not 16,423 (regenerated in
  `ced43a0`). This question does not need to reconcile those, but the handoff's "regenerate and compare the
  counts" rule has caught a difference.

## 3. What the owner would need to decide

**Whether to look.** Look only for a copy that can be shown to keep its `.symtab`. An unnamed copy of either
build is worth about 0 names (§2). A named one is worth thousands. If a candidate turns up, check it first
(below) before anything else is done with it. Of the two, the Nov 25 prototype has the larger prize if named,
and the Aug 28 beta has the better-documented identity (a serial number, even if the prefix is disputed).

**Where.** The cited notes name one place only: research/03 lists all three pre-release SOCOM II builds as
"Prototypes on Hidden Palace", and research/19 §4 uses the same wording for the SOCOM 1 disc. research/19 §4
also says that such a disc "is copyrighted game code" and that the project "should keep consuming reCOM's
*names*, not the disc". The project took SOCOM 1 in through the owner's own dump instead
(`docs/archive/CURRENT_SPRINT-sprints-9-to-11.md`: "Zero1UP's dump"). The notes give no other source, and this note adds none. How to
obtain a build, and whether it is legal to, is the owner's decision.

**What to check first on a candidate** (read-only, on a copy outside the repository):

1. Read `SYSTEM.CNF`'s `BOOT2` line to get the boot ELF (for retail: `cdrom0:\SCUS_972.75;1`, research/03).
2. `python -m tools_py.elf_symbols <that ELF>`. The first lines give the answer:
   - **Named**, like `SCUS_972.05`:
     ```
     type 2 machine 8 entry 0x00140010
       .shstrtab    type 3          addr 0x00000000 size 85
       .strtab      type 3          addr 0x00000000 size 576267
       .symtab      type 2          addr 0x00000000 size 350304
       main         type 1          addr 0x00100000 size 3626496
       .relmain     type 9          addr 0x00000000 size 921136
       ...
       .debug       type 1879048197 addr 0x00000000 size 5093034
       .line        type 1879048197 addr 0x00000000 size 194940
     21894 symbol table entries: 9703 STT_FUNC (9703 sized and named), 10182 STT_OBJECT (10179 sized and named); 115142 relocations
       0x002c0970   29668  DefineFPAnims__7AnimSetFv
     ```
     followed by the twenty largest functions by name.
   - **Stripped**, like `SCUS_973.68`:
     ```
     type 2 machine 8 entry 0x00180008
       .shstrtab    type 3          addr 0x00000000 size 45
       .strtab      type 3          addr 0x00000000 size 0
       .symtab      type 2          addr 0x00000000 size 0
       .comment     type 1          addr 0x00000000 size 43
       .reginfo     type 1879048198 addr 0x00000000 size 24
     0 symbol table entries: 0 STT_FUNC (0 sized and named), 0 STT_OBJECT (0 sized and named); 0 relocations
     ```
   A non-zero `.symtab` size and a non-zero `STT_FUNC` count mean a named build. `.debug` means types as well.
3. Read the banner and the middleware ladder with command B. The id is **not** in `.comment` (§1). Expect
   `SOCOM 2 v…`/`r… Aug 28 2003` or `… Nov 25 2003`, and versions within the ranges in §1's table.
4. **Layout.** If the boot ELF has one large `PT_LOAD`, as the demo does (4,558,848 B), the whole game is in it
   and step 2 is the whole answer. If it is a small loader, as retail is (the loader's `PT_LOAD0` is 872,448 B,
   research/43b §1), with a `RUN/RAW/APACHE00.ZDB` beside it, then the game code is in encrypted overlays.
   `.symtab` would then name the loader only, and whether the overlays carry anything is **unknown**. Opening
   another build's package is new work: `tools_py/disc_to_elf.py` verifies every stage against r0001's recorded
   digests (`disc_to_elf_expected.json`), so it is built to refuse a different build (not tried).

**What not to do.** Nothing from a build enters the repository: no image, no extracted section, no symbol dump.
research/44's rule applies: names, addresses and counts only, in notes and git-ignored proposal files. The route
for a fifth input is the one the four take now. The owner places the file at the private location and adds its
line to that location's `SHA256SUMS`. `scripts/fetch_private_inputs.sh` then needed one new `DEST` entry (served
name → `game/<dir>/<file>`) *(the location and the script are retired since 2026-09-27, issue #75; a fifth input now travels by the owner's hand into `game/` on this machine)*. Its map lists exactly four files today, and it verifies each fetched file against
`SHA256SUMS`. The `DEST` line is a tracked-file edit for the owner or controller, not for a research agent. No
agent fetches a build (spec §5).

## What this means for a task

| task | finding | what it changes |
|---|---|---|
| Owner decision (spec §3 / §5) | Only a **named** copy of either build adds names. An unnamed copy adds 0 names (a worse bridge than the demo in hand, which adds 0: research/45 §7, command C) | Look only for a copy whose symbol status can be checked before it is used. Otherwise do not look |
| Owner decision | If named, the prize is large: at least ~5,206 r0001 rows for an Aug-2003-distance build (command D floor) against 987 from SOCOM 1. A named Nov 25 build is expected to cover most of the image (by date, closer to r0001 than r0004's 81.1 %) | If a named copy exists, it beats every remaining lever, including 7c, on count |
| Owner decision | Zipper's record predicts **stripped** for both (2002 named, both 2003 images stripped), at **low** confidence. The one named build is a public beta, and so is the Aug 28 build | Do not count on it. A description of the build where it circulates, or check step 2, settles it |
| R262 (Sprint 11 plan) | "99.66 % identical to r0001" is r0001's **self**-match (14,828/14,879). r0004 against r0001 is 81.1 % placed (research/43b §1) | Amend the number. The decline stands |
| R262 | By date, the Nov 25 build is closer to r0001 (45 days) than r0004 is (389). An unnamed copy carries **no** independent evidence against SOCOM 1 | Strike "the Nov 25 2003 prototype would be [independent evidence]" unless it is named |
| research/44 addendum | The SOCOM II demo's build id is **not** in `.comment` (which holds `MW MIPS C Compiler (2.4.1.01)`/`PlayStation2`). It is the string at 0x005135E0 | A one-line correction when the note is next touched. Check step 3 above uses the banner |
| Goal 5 (ccc/DWARF1) and Q11 (SASE) | Only a named SOCOM II build with `.debug` would give SOCOM II layouts and SASE names. SOCOM 1's give neither | No change unless a named copy turns up. R262's layout-age caveat stands |
| Task 10 / research/43b (regeneration check) | Regenerated `game/r0004/match.json` reports `resolved 10008` (0.6726), not research/43b's 12,071. The r0004 table is 16,417 rows, not 16,423 (`ced43a0`) | The controller should reconcile before any task quotes research/43b's 81.1 %. Not this question's to resolve |
| ~~`scripts/fetch_private_inputs.sh`~~ (retired 2026-09-27, issue #75) | ~~Its `DEST` map has exactly four files. A fifth needs a `SHA256SUMS` line at the private location plus one `DEST` entry~~ | The route is gone with the cloud sessions; a fifth input is placed under `game/` by hand |
