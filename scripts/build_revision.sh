#!/usr/bin/env bash
# The pipeline, parameterised by disc revision (Sprint 11 Task 9, Goal B):
#
#   bash scripts/build_revision.sh <rev> <APACHE00.ZDB> [--check-against <elf>] [--dry-run] [--stop-after <step>]
#                                  [--force] [--out <dir>] [--game <disc tree>] [--loader <elf>] [--loader-text-end 0x..]
#                                  [--ghidra <csv>] [--ghidra-from-r0001] [--extra <extra_functions.txt>]
#                                  [--match <match.json>]
#
#   rev   r + four digits, optionally followed by a letter and then letters and digits (r0001, r0004, r0001check).
#         The suffix form exists so a check build of the r0001 disc never overwrites r0001's own products.
#   zdb   the revision's RUN/RAW/APACHE00.ZDB inside its extracted disc tree (scripts/disc_to_elf.sh makes the
#         tree; the tree must also hold OVERLAY/REL/DNAS.dec.bin and its loader under the name SCUS_972.75 --
#         the only name step 1 can decrypt with, because tools_py/decrypt_apache.py:206 joins it onto the tree
#         itself and then runs that loader's own code under Unicorn).
#
# Six steps, each skipped when its product is already there (--force redoes it), the last two under the machine's
# loop lock (scripts/loop_lock.sh, owner build-revision):
#   0 map               tools_py/fix_ghidra_csv.py --out                           -> recomp/build/socom2_ghidra_<rev>.fixed.csv
#                       The revision's function map (recomp/socom2_ghidra_<rev>.csv, or --ghidra <csv>) with its
#                       non-contiguous ranges cut to size, its FORCED ENTRY POINTS folded in and merge_ranges.txt
#                       applied. It is written EVERY run, before anything else, and it is a build PRODUCT:
#                       recomp/build/ is git-ignored and THE TRACKED MAP IS NEVER WRITTEN BY A BUILD. It used to be
#                       rewritten in place at step 4, so every r0004 build left `M recomp/socom2_ghidra_r0004.csv`
#                       in git status, the controller restored it by hand, and step 2's sidecar -- which hashes the
#                       map as a repair input -- then called the image stale and re-merged it to the same bytes.
#                       Steps 2-5 all read the fixed file: the ELF is repaired against exactly the rows the
#                       recompiler will compile, and its sha256 in the sidecar is stable across builds.
#                       Step 0 also places the display-name sidecar (recomp/socom2_names_<rev>.csv; r0001*
#                       reads recomp/socom2_names.csv) beside the toml step 3 writes, which names it by basename:
#                       under --out it is copied there (#48 -- it used to be left behind, and the out build's
#                       functions all came out FUN_/sub_); a revision without one is warned.
#                       The forced entry points are recomp/extra_functions_<rev>.txt when it is there, or
#                       --extra <file>, else recomp/extra_functions.txt -- which is r0001's, and 1,453 of whose
#                       1,619 entries are overlay addresses that mean nothing in another revision, so a foreign
#                       revision falling back to it is warned. tools_py/find_imm_targets.py writes a revision its own:
#                         python tools_py/find_imm_targets.py <rev elf> <rev csv> recomp/extra_functions_<rev>.txt
#   1 decrypt           tools_py.decrypt_apache.main(<tree>, game/overlays_<rev>)  -> ftscore.bin, zsealetc.bin
#                       Under --out, when the tree's own game/overlays_<rev>/ holds both overlays, the merged ELF
#                       and its repair.json, and that sidecar is current for this run's repair inputs (the test
#                       step 2 skips on), the four files are COPIED into <out>/overlays_<rev>/ and steps 1-2 skip
#                       (#56). The sidecar records no disc input, so the disc tree given is not matched: on the
#                       machine whose r0004 overlays come from the capsule, decrypting the given tree read r0001's
#                       package through a junction and the out ELF mismatched. --force decrypts regardless.
#   2 make_overlay_elf  loader + both overlays                                    -> game/overlays_<rev>/socom2_game_<rev>.elf
#     --check-against <elf>: sha256 of that ELF against the given one; a mismatch prints both digests and exits 1
#   3 toml              recomp/socom2.toml with input/output/ghidra_output rewritten -> recomp/socom2_<rev>.toml;
#                       ghidra_output names step 0's fixed map (build/socom2_ghidra_<rev>.fixed.csv, relative to
#                       the directory ps2_recomp runs in), never the tracked map.
#                       the revision's function map recomp/socom2_ghidra_<rev>.csv must already be there or be
#                       named with --ghidra <csv>. Only an r0001* revision falls back to r0001's own map
#                       silently; any other revision must ask for it with --ghidra-from-r0001, which warns that
#                       the generated code will be wrong until Task 10's matcher writes that revision a map.
#                       Rewriting the three paths is not the whole job: EVERY OTHER ADDRESS IN THAT FILE is an
#                       r0001 guest address too -- the stub selectors ps2_recomp binds by start address, the
#                       instruction patches, the jump-table sites, the [mmio] annotations. With an address
#                       match report (--match <json>, or game/<rev>/match.json when it is there) step 3 runs
#                       tools_py.revision_toml, which translates each of them and lists in [revision.unresolved]
#                       the ones it could not place. Without one it copies-and-renames as before, and warns.
#   4 recomp   [lock]   ps2_recomp socom2_<rev>.toml                               -> recomp/output_<rev>/
#                       against step 0's fixed map (the toml's ghidra_output names it); this step writes no map.
#   5 runtime  [lock]   cmake third_party/ps2recomp/build-clang-<rev>              -> dist/socom2_<rev>.exe (+ the ELF beside it)
#
#   Steps 4 and 5 mark their product with a .complete file when the step returns 0, and skip on that mark alone:
#   a tree or an exe left half-written by a failed or interrupted run is redone, never reported as done. The mark
#   is not generated code, so compare two generated trees with: diff -rq --exclude=.complete <a> <b>
#   Step 2's mark is different in kind: "<elf>.repair.json" is the ELF's own provenance (which capsule stub
#   writes were undone in it, from which r0001 twin), written by make_overlay_elf on every build including the
#   ones that repair nothing. It records the sha256 of every input the repair's answer depends on -- the
#   revision's decoded capsule stack, the r0001 image, both function maps, and overlay_repair.py /
#   make_overlay_elf.py / r0004/capsule.py -- and step 2 skips only when all of them still match
#   (tools_py.overlay_repair --check). So a re-decoded stack, a rebuilt r0001 image, a new function map or a
#   changed rule re-merges the ELF instead of silently carrying a stale image into steps 3-5; a sidecar that
#   cannot be parsed counts as stale.
#
#   --stop-after elf|toml|recomp|runtime   stop after that step (runtime is the default); elf and toml take
#                     no lock at all. elf covers step 0, so it is the cheapest way to see that a build leaves
#                     git status clean; toml goes one further and writes recomp/socom2_<rev>.toml -- r0004's is
#                     tracked (the others are git-ignored), and tools_py/tests/test_build_products.py regenerates
#                     it with step 3's arguments and holds the tracked bytes to the result (Sprint 13 C5).
#   --out <dir>       every product under <dir> instead (overlays_<rev>/, recomp_<rev>/, build-clang-<rev>/, dist/),
#                     so a check build run from the main tree can land in a worktree. The INPUTS stay the tree's
#                     (#56): the map is recomp/socom2_ghidra_<rev>.csv unless --ghidra names another (step 3
#                     copies it beside the out toml), and the tree's current game/overlays_<rev>/ is copied
#                     rather than decrypted again (step 1 above)
#   --dry-run         print the six steps with their paths and exit 0, touching nothing
#
# Exit 2 on a bad argument or a missing input, 1 on a failed step or a --check-against mismatch, 75 when the loop
# lock could not be taken within --wait (BUILD_REVISION_LOCK_WAIT, 60 minutes), 0 otherwise. The shape is
# scripts/disc_to_elf.sh's (idempotent stages, one line per stage, --force); the pieces are build.sh's recomp() and
# runtime() (build.sh:31-70), which this script mirrors for one revision at a time.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$ROOT/tools/llvm-mingw/bin:$ROOT/tools/cmake/bin:$ROOT/tools/ninja:$PATH"
. "$ROOT/scripts/python_env.sh"   # $PYTHON, resolved once for every script
socom_require_python build_revision

die2() { echo "build_revision: $*" >&2; exit 2; }
say() { echo "$*"; }

py="$PYTHON"

REV="" ZDB="" CHECK="" DRY=0 STOP="runtime" FORCE=0 OUT="" GAME="" LOADER="" LTE="" TAIL=0 GHIDRA="" GHIDRA_R0001=0 EXTRA="" MATCH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check-against) [ $# -ge 2 ] || die2 "--check-against needs a path"; CHECK="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --stop-after) [ $# -ge 2 ] || die2 "--stop-after needs one of elf, toml, recomp, runtime"; STOP="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --out) [ $# -ge 2 ] || die2 "--out needs a directory"; OUT="$2"; shift 2 ;;
    --game) [ $# -ge 2 ] || die2 "--game needs the extracted disc tree"; GAME="$2"; shift 2 ;;
    --loader) [ $# -ge 2 ] || die2 "--loader needs the loader ELF"; LOADER="$2"; shift 2 ;;
    --loader-text-end) [ $# -ge 2 ] || die2 "--loader-text-end needs a hex address"; LTE="$2"; shift 2 ;;
    --ghidra) [ $# -ge 2 ] || die2 "--ghidra needs the revision's function map (a Ghidra ExportPS2Functions CSV)"; GHIDRA="$2"; shift 2 ;;
    --ghidra-from-r0001) GHIDRA_R0001=1; shift ;;
    --extra) [ $# -ge 2 ] || die2 "--extra needs the revision's forced entry points (one hex address per line)"; EXTRA="$2"; shift 2 ;;
    --match) [ $# -ge 2 ] || die2 "--match needs an address match report (tools_py.address_matcher --out)"; MATCH="$2"; shift 2 ;;
    --_tail) TAIL=1; shift ;;      # internal: the lock-bound steps, re-entered under loop_lock.sh run
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    -*) die2 "unknown option $1" ;;
    *) if [ -z "$REV" ]; then REV="$1"; elif [ -z "$ZDB" ]; then ZDB="$1"; else die2 "unexpected argument $1"; fi; shift ;;
  esac
done

if [ "$TAIL" = 1 ]; then
  REV="$BR_REV"; STOP="$BR_STOP"; FORCE="$BR_FORCE"; OUT="$BR_OUT"; EXTRA="${BR_EXTRA:-}"
fi

[ -n "$REV" ] || die2 "usage: build_revision.sh <rev> <APACHE00.ZDB> [--check-against <elf>] [--dry-run] [--stop-after <step>]"
[[ "$REV" =~ ^r[0-9]{4}([a-z][a-z0-9]*)?$ ]] || die2 "revision must look like r0004 (r + four digits, an optional suffix that starts with a letter, such as r0001check): got '$REV'"
case "$STOP" in elf|toml|recomp|runtime) ;; *) die2 "--stop-after must be one of elf, toml, recomp, runtime: got '$STOP'" ;; esac

# ---- where everything is ------------------------------------------------------------------------------------
PS2R="$ROOT/third_party/ps2recomp"
TOOLBUILD="$PS2R/build-tools"
# The recompiler step 4 runs. BR_PS2_RECOMP names another one -- a test seam (tools_py/tests/test_build_revision.py
# drives step 4 with a stand-in that writes like ps2_recomp); a build never sets it. With it set, step 4 builds
# NOTHING: the two cmake lines that configure and build ps2_recomp in build-tools/ are skipped and the named
# recompiler runs as-is, so a test never builds the real one outside the loop lock. Unset, step 4 is unchanged.
PS2_RECOMP="${BR_PS2_RECOMP:-$TOOLBUILD/ps2xRecomp/ps2_recomp.exe}"
if [ -n "$OUT" ]; then
  OUT="$(mkdir -p "$OUT" && cd "$OUT" && pwd)"
  OVERLAYS="$OUT/overlays_$REV"; RECOMP_DIR="$OUT/recomp_$REV"; GEN="$RECOMP_DIR/output"
  RTBUILD="$OUT/build-clang-$REV"; DIST="$OUT/dist"
  TOML_INPUT="../overlays_$REV/socom2_game_$REV.elf"; TOML_OUTPUT="./output/"
else
  OVERLAYS="$ROOT/game/overlays_$REV"; RECOMP_DIR="$ROOT/recomp"; GEN="$ROOT/recomp/output_$REV"
  RTBUILD="$PS2R/build-clang-$REV"; DIST="$ROOT/dist"
  TOML_INPUT="../game/overlays_$REV/socom2_game_$REV.elf"; TOML_OUTPUT="./output_$REV/"
fi
ELF="$OVERLAYS/socom2_game_$REV.elf"
TOML="$RECOMP_DIR/socom2_$REV.toml"
CSV="$RECOMP_DIR/socom2_ghidra_$REV.csv"
# #56: the tree's own inputs, which an --out build reads rather than looking for them under <out>. In-tree they
# are the same paths as $CSV and $OVERLAYS, and nothing below changes.
TREE_CSV="$ROOT/recomp/socom2_ghidra_$REV.csv"
TREE_OVERLAYS="$ROOT/game/overlays_$REV"
# Step 0's product. The tracked map above is a SOURCE: the build reads it and never writes it. This one is
# git-ignored (.gitignore /recomp/build/) and is what steps 2-5 read -- including the repair sidecar's input
# hash, so the ELF is repaired against the same rows the recompiler compiles.
FIXED="$RECOMP_DIR/build/socom2_ghidra_$REV.fixed.csv"
TOML_GHIDRA="build/socom2_ghidra_$REV.fixed.csv"   # as ps2_recomp reads it: relative to $RECOMP_DIR, its cwd
EXE="$DIST/socom2_$REV.exe"
# The revision's display-name sidecar (#48). Step 3 writes its basename into the toml's [general] names, which
# ps2_recomp resolves against $RECOMP_DIR; in-tree that is recomp/ where the sidecar lives, and under --out step 0
# copies it there -- before, an --out build's toml named a file that was not beside it and every function came
# out FUN_/sub_. The r0001 disc under a suffix (r0001check) reads r0001's own recomp/socom2_names.csv.
NAMES_SRC=""
if [ -f "$ROOT/recomp/socom2_names_$REV.csv" ]; then
  NAMES_SRC="$ROOT/recomp/socom2_names_$REV.csv"
else
  case "$REV" in r0001*) [ -f "$ROOT/recomp/socom2_names.csv" ] && NAMES_SRC="$ROOT/recomp/socom2_names.csv" ;; esac
fi
if [ -n "$NAMES_SRC" ]; then TOML_NAMES="$(basename "$NAMES_SRC")"; else TOML_NAMES="socom2_names_$REV.csv"; fi
rel() { case "$1" in "$ROOT"/*) echo "${1#"$ROOT"/}" ;; *) echo "$1" ;; esac; }
# The revision's forced entry points, settled here so both halves of the script (and the dry run) say the
# same thing. r0001's list is address-keyed like its map is: handed to another revision, its 1,453 overlay
# entries land inside whatever r0004 put at those addresses and truncate the real functions there.
EXTRA_BORROWED=0
if [ -n "$EXTRA" ]; then
  [ -f "$EXTRA" ] || die2 "no such forced-entry-point list: $EXTRA"
  EXTRA="$(cd "$(dirname "$EXTRA")" && pwd)/$(basename "$EXTRA")"
elif [ -f "$ROOT/recomp/extra_functions_$REV.txt" ]; then
  EXTRA="$ROOT/recomp/extra_functions_$REV.txt"
else
  EXTRA="$ROOT/recomp/extra_functions.txt"
  case "$REV" in r0001*) ;; *) EXTRA_BORROWED=1 ;; esac
fi
# The revision's address match report, settled here for the same reason. recomp/socom2.toml's ~1,900
# addresses are r0001's; with a report, step 3 translates them (tools_py/revision_toml.py). r0001 needs
# none -- translating a build onto itself is the identity -- so only another revision is warned.
if [ -n "$MATCH" ]; then
  [ -f "$MATCH" ] || die2 "no such address match report: $MATCH (tools_py.address_matcher --out writes one)"
  MATCH="$(cd "$(dirname "$MATCH")" && pwd)/$(basename "$MATCH")"
elif [ -f "$ROOT/game/$REV/match.json" ]; then
  MATCH="$ROOT/game/$REV/match.json"
fi
TOML_BORROWED=0
if [ -z "$MATCH" ]; then
  case "$REV" in r0001*) ;; *) TOML_BORROWED=1 ;; esac
fi
sha() { sha256sum "$1" | cut -d' ' -f1; }

if [ "$TAIL" = 0 ]; then
  [ -n "$ZDB" ] || die2 "usage: build_revision.sh <rev> <APACHE00.ZDB> [--check-against <elf>] [--dry-run] [--stop-after <step>]"
  [ -f "$ZDB" ] || die2 "no such package: $ZDB"
  ZDB="$(cd "$(dirname "$ZDB")" && pwd)/$(basename "$ZDB")"
  [ -n "$GAME" ] || GAME="$(dirname "$(dirname "$(dirname "$ZDB")")")"
  if [ -z "$LOADER" ]; then
    for cand in "$GAME"/SCUS_* "$GAME"/SCES_* "$GAME"/SLUS_* "$GAME"/SLES_*; do
      if [ -f "$cand" ]; then LOADER="$cand"; break; fi
    done
  fi
  if [ -z "$LTE" ]; then
    [ -f "$ROOT/recomp/loader_text_end.txt" ] || die2 "recomp/loader_text_end.txt is missing -- pass --loader-text-end 0x..."
    LTE="$(cat "$ROOT/recomp/loader_text_end.txt")"
  fi
  if [ -n "$CHECK" ] && [ "$DRY" = 0 ]; then
    [ -f "$CHECK" ] || die2 "no such ELF to check against: $CHECK"
  fi
  # The revision's function map, decided here so a wrong one is refused before the eight minutes of step 1 and
  # not after them. r0001's map is the right starting point for the r0001 disc and for nothing else: handed to
  # another revision it is a knowingly wrong map whose recompiled code still exits 0, so it must be asked for.
  GHIDRA_SRC="" GHIDRA_NEED=0
  if [ -n "$GHIDRA" ]; then
    [ -f "$GHIDRA" ] || die2 "no such function map: $GHIDRA"
    GHIDRA_SRC="$(cd "$(dirname "$GHIDRA")" && pwd)/$(basename "$GHIDRA")"
  elif [ "$CSV" != "$TREE_CSV" ] && [ -f "$TREE_CSV" ]; then
    # --out: the tracked map is the tree's (#56). <out>/recomp_<rev>/ holds only the copy step 3 makes of it, so
    # looking there refused every first out run unless --ghidra named the tracked map by hand.
    GHIDRA_SRC="$TREE_CSV"
  elif [ ! -f "$CSV" ]; then
    case "$REV" in
      r0001*) GHIDRA_SRC="$ROOT/recomp/socom2_ghidra.csv" ;;
      *) if [ "$GHIDRA_R0001" = 1 ]; then
           GHIDRA_SRC="$ROOT/recomp/socom2_ghidra.csv"
           echo "WARNING: $REV has no function map of its own; starting from r0001's. The generated code will be wrong until Sprint 11 Task 10's matcher writes socom2_ghidra_$REV.csv." >&2
         else
           GHIDRA_NEED=1
         fi ;;
    esac
  fi
  [ "$GHIDRA_NEED" = 0 ] || [ "$DRY" = 1 ] \
    || die2 "$REV has no function map of its own ($(rel "$CSV")): pass --ghidra <csv>, or --ghidra-from-r0001 to start from r0001's map knowing the generated code will be wrong until Sprint 11 Task 10's matcher writes one"
  [ "$EXTRA_BORROWED" = 0 ] || [ "$DRY" = 1 ] \
    || echo "WARNING: $REV has no forced entry points of its own (recomp/extra_functions_$REV.txt); using r0001's, whose overlay entries are another build's addresses. Write one with: $PYTHON tools_py/find_imm_targets.py $(rel "$ELF") $(rel "$CSV") recomp/extra_functions_$REV.txt" >&2
  [ "$TOML_BORROWED" = 0 ] || [ "$DRY" = 1 ] \
    || echo "WARNING: $REV has no address match report (game/$REV/match.json, or --match <json>); $(rel "$TOML") will keep r0001's stub selectors, instruction patches, jump-table sites and [mmio] annotations, which are another build's addresses. Write one in two passes (the second reads the seeds the first derives): $PYTHON -m tools_py.address_matcher game/disc/socom2_game.elf recomp/socom2_ghidra.csv $(rel "$ELF") $(rel "$CSV") --out game/$REV/match_noseed.json && $PYTHON -m tools_py.derive_seeds game/$REV/match_noseed.json --out recomp/${REV}_seeds.txt && $PYTHON -m tools_py.address_matcher game/disc/socom2_game.elf recomp/socom2_ghidra.csv $(rel "$ELF") $(rel "$CSV") \$(sed 's/^/--seed /' recomp/${REV}_seeds.txt | grep -v '^--seed #') --out game/$REV/match.json" >&2
fi

# ---- dry run ------------------------------------------------------------------------------------------------
if [ "$DRY" = 1 ]; then
  say "build_revision $REV (dry run): nothing is touched"
  say "  package        $(rel "$ZDB")"
  say "  disc tree      $(rel "$GAME")   loader $(rel "${LOADER:-<none found: SCUS_*/SCES_*/SLUS_*/SLES_* in the tree, or --loader>}")"
  say "  step 0  map               $(rel "${GHIDRA_SRC:-$CSV}") + forced entry points $(rel "$EXTRA")$([ "$EXTRA_BORROWED" = 1 ] && echo ' (r0001'"'"'s -- another build'"'"'s overlay addresses)') -> $(rel "$FIXED") (a build product; the tracked map is never written)"
  say "  step 1  decrypt           tools_py.decrypt_apache.main(tree, overlays) -> $(rel "$OVERLAYS")/{ftscore,zsealetc}.bin"
  [ "$TREE_OVERLAYS" = "$OVERLAYS" ] || say "                            (or $(rel "$TREE_OVERLAYS")/ copied there when its repair.json is current -- no decrypt)"
  say "  step 2  make_overlay_elf  loader + overlays (--loader-text-end=$LTE) -> $(rel "$ELF")${CHECK:+   check-against $(rel "$CHECK")}"
  if [ "$GHIDRA_NEED" = 1 ]; then
    MAPNOTE="$(rel "$CSV") is not there -- the run will refuse it: pass --ghidra <csv>, or --ghidra-from-r0001"
  elif [ "$GHIDRA_SRC" = "$CSV" ]; then
    MAPNOTE="$(rel "$CSV") is the map named by --ghidra -- nothing to copy"
  elif [ -n "$GHIDRA_SRC" ]; then
    MAPNOTE="$(rel "$CSV") copied from $(rel "$GHIDRA_SRC")"
  else
    MAPNOTE="$(rel "$CSV") is already there"
  fi
  if [ -n "$MATCH" ]; then
    TOMLNOTE="every address translated through $(rel "$MATCH") (tools_py.revision_toml)"
  else
    TOMLNOTE="input/output/ghidra_output rewritten; every other address stays r0001's"
  fi
  say "  step 3  toml              recomp/socom2.toml -> $(rel "$TOML") ($TOMLNOTE); $MAPNOTE"
  say "                            names $(rel "${NAMES_SRC:-$ROOT/recomp/socom2_names_$REV.csv}")$([ -z "$NAMES_SRC" ] && echo ' is not there -- every function will keep its placeholder name')$([ -n "$NAMES_SRC" ] && [ "$RECOMP_DIR" != "$ROOT/recomp" ] && echo " (copied to $(rel "$RECOMP_DIR/$TOML_NAMES") at step 0)")"
  say "  step 4  recomp   [lock]   ps2_recomp socom2_$REV.toml -> $(rel "$GEN")/; function map $(rel "$FIXED")"
  say "  step 5  runtime  [lock]   cmake $(rel "$RTBUILD") -> $(rel "$EXE") (+ $(rel "$DIST")/socom2_game_$REV.elf)"
  [ "$STOP" = runtime ] || say "  stop after $STOP"
  exit 0
fi

# ---- steps 1-3, lock-free -----------------------------------------------------------------------------------
if [ "$TAIL" = 0 ]; then
  mkdir -p "$OVERLAYS" "$RECOMP_DIR" "$DIST" "$(dirname "$FIXED")"
  # 0 map -- before step 1 for the same reason the map's source was settled before it: a map this step cannot
  # read is a refusal in a second, not eight minutes of Unicorn later. Written every run (it is seconds over
  # 16,000 rows, and a map derived from stale inputs is worse than none), and written OUT OF TREE: the tracked
  # map keeps its bytes, so `git status` after a build is empty and step 2's sidecar hash stays put.
  MAP_SRC="${GHIDRA_SRC:-$CSV}"
  [ -f "$MAP_SRC" ] || die2 "step 0: $(rel "$MAP_SRC") is not there, and steps 2-5 all need the revision's function map. Name the map they will use: --ghidra <csv> (or --ghidra-from-r0001 to start from r0001's)"
  say "map: $(rel "$MAP_SRC") + forced entry points $(rel "$EXTRA")"
  "$py" "$ROOT/tools_py/fix_ghidra_csv.py" "$MAP_SRC" "$EXTRA" --out "$FIXED"
  say "map: $(rel "$FIXED") sha256 $(sha "$FIXED") -- a build product; $(rel "$MAP_SRC") was not written"
  # 0 names -- the sidecar step 3's toml names, placed where ps2_recomp resolves it (#48). In-tree it is already
  # there; under --out it is copied beside the toml, every run, so the out tree carries its own names.
  if [ -z "$NAMES_SRC" ]; then
    echo "WARNING: $REV has no names sidecar (recomp/socom2_names_$REV.csv); the toml will name one that is not there and every function will keep its placeholder (FUN_/sub_) name" >&2
  elif [ "$NAMES_SRC" != "$RECOMP_DIR/$TOML_NAMES" ]; then
    cp "$NAMES_SRC" "$RECOMP_DIR/$TOML_NAMES"
    say "names: $(rel "$NAMES_SRC") copied to $(rel "$RECOMP_DIR/$TOML_NAMES"), beside the toml that names it"
  else
    say "names: $(rel "$NAMES_SRC"), beside the toml that names it"
  fi
  # Step 2's repair inputs, settled before step 1 because the --out reuse below is decided by them too: the
  # revision's own decoded capsule stack names the addresses, the r0001 image supplies the replacement words,
  # and the two function maps bound the functions. All four or none -- make_overlay_elf rewrites nothing
  # without --stub-writes.
  #
  # The revision's map is step 0's fixed one -- the rows the recompiler will actually compile, derived from
  # "$GHIDRA_SRC" when --ghidra named one and from "$CSV" otherwise. Reading "$CSV" here instead would refuse
  # a revision being bootstrapped with --ghidra (its own map does not exist yet), and -- worse -- would
  # silently repair against the OLD map when --ghidra names a new one. Reading the fixed file rather than
  # either source is what makes the sidecar's "rows" digest stable: it is derived, not edited under the image.
  REPAIR_ARGS=()
  STACK="$ROOT/game/$REV/decoded/stack.txt"
  TWIN_ELF="$ROOT/game/disc/socom2_game.elf"
  TWIN_ROWS="$ROOT/recomp/socom2_ghidra.csv"
  ROWS_CSV="$FIXED"
  if [ -f "$STACK" ]; then
    [ -f "$TWIN_ELF" ] || die2 "step 2: the repair takes its replacement words from the r0001 image, but $(rel "$TWIN_ELF") is not there. Build the r0001 lane first (bash build.sh elf), or drop $(rel "$STACK") to merge without a repair"
    [ -f "$TWIN_ROWS" ] || die2 "step 2: the repair needs r0001's own function map to find the twin function, but $(rel "$TWIN_ROWS") is not there. It is tracked: git checkout -- $(rel "$TWIN_ROWS") (or regenerate it with the r0001 Ghidra pass, docs/DEVELOPING.md)"
    REPAIR_ARGS=(--stub-writes "$STACK" --twin "$TWIN_ELF" --rows "$ROWS_CSV" --twin-rows "$TWIN_ROWS")
    say "elf: repair inputs -- stack $(rel "$STACK"), twin $(rel "$TWIN_ELF"), map $(rel "$ROWS_CSV") sha256 $(sha "$ROWS_CSV")"
  fi
  # 1 reuse (#56) -- under --out, the tree's own overlays when they are current, instead of decrypting the disc
  # tree again. "Current" is the sidecar's test, the one step 2 skips on: every repair input it records (stack,
  # twin, both maps, the three modules) still has the recorded sha256. The sidecar records no disc input (no
  # package, no loader), so the tree given is not part of the match -- and on the machine where it mattered the
  # r0004 overlays were never decrypted from a package at all (they come from the capsule).
  if [ "$TREE_OVERLAYS" != "$OVERLAYS" ] && [ "$FORCE" = 0 ] && [ -d "$TREE_OVERLAYS" ]; then
    if [ -f "$OVERLAYS/ftscore.bin" ] && [ -f "$OVERLAYS/zsealetc.bin" ]; then
      say "overlays: $(rel "$OVERLAYS") already holds ftscore.bin and zsealetc.bin -- the tree's are not copied (delete them, or --force)"
    else
      TREE_ELF="$TREE_OVERLAYS/socom2_game_$REV.elf"
      REUSE_WHY=""
      for f in ftscore.bin zsealetc.bin "socom2_game_$REV.elf" "socom2_game_$REV.elf.repair.json"; do
        [ -f "$TREE_OVERLAYS/$f" ] || { REUSE_WHY="it holds no $f"; break; }
      done
      if [ -z "$REUSE_WHY" ]; then
        if REUSE_WHY="$(cd "$ROOT" && "$py" -m tools_py.overlay_repair --check "$TREE_ELF.repair.json" ${REPAIR_ARGS[@]+"${REPAIR_ARGS[@]}"} 2>&1)"; then
          # Staged: a copy that fails half-way (a full disk, a Ctrl-C) leaves nothing in $OVERLAYS for step 1 to
          # skip on. The four arrive by rename, the repair.json LAST -- its presence marks the copy complete.
          STAGE="$OVERLAYS/.reuse.$$"
          rm -rf "$STAGE"; mkdir -p "$STAGE"
          cp -p "$TREE_OVERLAYS/ftscore.bin" "$TREE_OVERLAYS/zsealetc.bin" "$TREE_ELF" "$TREE_ELF.repair.json" "$STAGE/"
          mv "$STAGE/ftscore.bin" "$STAGE/zsealetc.bin" "$STAGE/socom2_game_$REV.elf" "$OVERLAYS/"
          mv "$STAGE/socom2_game_$REV.elf.repair.json" "$OVERLAYS/"
          rmdir "$STAGE"
          say "overlays: $(rel "$TREE_OVERLAYS")/ is current (${REUSE_WHY#current: }) -- copied ftscore.bin, zsealetc.bin, socom2_game_$REV.elf and its repair.json into $(rel "$OVERLAYS")/; no decrypt"
          REUSE_WHY=""
        fi
      fi
      [ -z "$REUSE_WHY" ] || say "overlays: $(rel "$TREE_OVERLAYS")/ not reused -- ${REUSE_WHY#stale: }; step 1 decrypts from the disc tree"
    fi
  fi
  # 1 decrypt
  if [ "$FORCE" = 0 ] && [ -f "$OVERLAYS/ftscore.bin" ] && [ -f "$OVERLAYS/zsealetc.bin" ]; then
    say "decrypt: ftscore.bin and zsealetc.bin are already in $(rel "$OVERLAYS") -- skipped (--force redoes it)"
  else
    [ -n "$LOADER" ] || die2 "no loader ELF (SCUS_*, SCES_*, SLUS_*, SLES_*) in $GAME -- pass --loader, or --game with the extracted disc tree"
    # decrypt_apache.py:206 is load_elf(ee, os.path.join(game, 'SCUS_972.75')) -- the name is hardcoded, so a
    # tree whose loader is any other one cannot get past step 1, and says so here rather than eight minutes in.
    [ -f "$GAME/SCUS_972.75" ] || die2 "step 1 can only decrypt with SCUS_972.75 (tools_py/decrypt_apache.py:206 joins that name onto the tree): $GAME holds $(basename "$LOADER") -- decrypt that tree with scripts/disc_to_elf.sh first, or give decrypt_apache a loader parameter"
    if [ ! -f "$GAME/OVERLAY/REL/DNAS.dec.bin" ]; then
      # The decryption loads the decrypted DNAS overlay first; a tree made before disc_to_elf's dnas stage existed
      # (or one whose derived files were cleaned) lacks it. It is two seconds under Unicorn, verified against
      # tools_py/disc_to_elf_expected.json, so make it here rather than send the reader to another command.
      [ -f "$GAME/OVERLAY/REL/DNAS.BIN" ] || die2 "$GAME/OVERLAY/REL/DNAS.BIN is missing: $GAME is not an extracted disc tree (scripts/disc_to_elf.sh makes one)"
      say "dnas: $(rel "$GAME")/OVERLAY/REL/DNAS.dec.bin is missing -- decrypting the DNAS overlay first (tools_py.disc_to_elf.stage_dnas, a few seconds)"
      if ! (cd "$ROOT" && "$py" -c 'import json, sys; from tools_py import disc_to_elf as d; e = json.load(open(d.EXPECTED_PATH, encoding="utf-8")); d.stage_dnas(sys.argv[1], sys.argv[2], e)' "$GAME" "$OVERLAYS") > "$OVERLAYS/build_revision-dnas.log" 2>&1; then
        tail -20 "$OVERLAYS/build_revision-dnas.log" >&2
        echo "build_revision: the DNAS stage failed (the log above); a disc whose DNAS.BIN is not r0001's needs its own entry in tools_py/disc_to_elf_expected.json (Sprint 11 Task 10) -- the stage refuses an unrecorded one" >&2; exit 1
      fi
    fi
    [ "$ZDB" = "$GAME/RUN/RAW/APACHE00.ZDB" ] || die2 "the package must be the tree's own RUN/RAW/APACHE00.ZDB ($GAME/RUN/RAW/APACHE00.ZDB): the decryption runs that tree's SCUS_972.75 on it"
    say "decrypt: running the loader's decryption under Unicorn (about eight minutes; the progress lines go to $(rel "$OVERLAYS")/build_revision-decrypt.log)"
    if ! (cd "$ROOT" && "$py" -c 'import sys; from tools_py import decrypt_apache; decrypt_apache.main(sys.argv[1], sys.argv[2])' "$GAME" "$OVERLAYS") > "$OVERLAYS/build_revision-decrypt.log" 2>&1; then
      tail -20 "$OVERLAYS/build_revision-decrypt.log" >&2
      echo "build_revision: decrypt failed (the log above)" >&2; exit 1
    fi
    say "decrypt: ftscore.bin ($(stat -c %s "$OVERLAYS/ftscore.bin") B) + zsealetc.bin ($(stat -c %s "$OVERLAYS/zsealetc.bin") B) written"
  fi
  # 2 elf (its step-2 half is below)
  # Freshness is decided by the sha256s the sidecar records for every one of those inputs (and for
  # the three modules that turn them into bytes), not by an mtime against two files: a re-decoded
  # stack or a new function map changes the answer a merged ELF has already baked in. A sidecar that
  # cannot be read is stale, so a malformed one re-merges instead of dying.
  ELF_REPAIR_JSON="$ELF.repair.json"
  ELF_FRESH=0
  ELF_FRESH_WHY="there is no $(rel "$ELF_REPAIR_JSON") beside the image"
  if [ "$FORCE" = 0 ] && [ -f "$ELF" ] && [ -f "$ELF_REPAIR_JSON" ]; then
    if ELF_FRESH_WHY="$(cd "$ROOT" && "$py" -m tools_py.overlay_repair --check "$ELF_REPAIR_JSON" ${REPAIR_ARGS[@]+"${REPAIR_ARGS[@]}"} 2>&1)"; then
      ELF_FRESH=1
    fi
  fi
  if [ "$ELF_FRESH" = 1 ]; then
    say "elf: $(rel "$ELF") is already there and $(rel "$ELF_REPAIR_JSON") is $ELF_FRESH_WHY -- skipped (--force redoes it)"
    say "elf: $(rel "$ELF_REPAIR_JSON") sha256 $(sha "$ELF_REPAIR_JSON"), $("$py" -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["repairs"]))' "$ELF_REPAIR_JSON") repair(s)"
  else
    [ -n "$LOADER" ] || die2 "no loader ELF (SCUS_*, SCES_*, SLUS_*, SLES_*) in $GAME -- pass --loader"
    if [ -f "$ELF" ]; then
      say "elf: re-merging $(rel "$ELF") -- $ELF_FRESH_WHY"
    fi
    rm -f "$ELF" "$ELF_REPAIR_JSON"
    "$py" "$ROOT/tools_py/make_overlay_elf.py" "--loader-text-end=$LTE" \
      ${REPAIR_ARGS[@]+"${REPAIR_ARGS[@]}"} "$ELF" "$LOADER" "$OVERLAYS/ftscore.bin" "$OVERLAYS/zsealetc.bin"
  fi
  ELF_SHA="$(sha "$ELF")"
  say "elf: sha256 $ELF_SHA  $(rel "$ELF")"
  if [ -n "$CHECK" ]; then
    CHECK_SHA="$(sha "$CHECK")"
    if [ "$ELF_SHA" = "$CHECK_SHA" ]; then
      say "check-against: identical to $(rel "$CHECK")"
    else
      echo "check-against: MISMATCH" >&2
      echo "  produced  $ELF_SHA  $(rel "$ELF")" >&2
      echo "  expected  $CHECK_SHA  $(rel "$CHECK")" >&2
      exit 1
    fi
  fi
  [ "$STOP" = elf ] && { say "stop after elf"; exit 0; }
  # 3 toml (+ the revision's function map, whose source was settled before step 1)
  if [ -n "$GHIDRA_SRC" ] && [ "$GHIDRA_SRC" != "$CSV" ]; then
    cp "$GHIDRA_SRC" "$CSV"
    say "toml: $(rel "$CSV") copied from $(rel "$GHIDRA_SRC")"
  elif [ -n "$GHIDRA_SRC" ]; then
    # `--ghidra recomp/socom2_ghidra_<rev>.csv` names the map the run would use anyway. cp refuses a file
    # onto itself, which under `set -e` killed the run between step 2 and step 3.
    say "toml: $(rel "$CSV") is the map named by --ghidra -- nothing to copy"
  fi
  if [ -n "$MATCH" ]; then
    # The three paths AND every guest address in the file, in one pass. The tool prints its own counts
    # and writes [revision.unresolved]: what it could not place stays r0001's number and says so.
    say "toml: translating r0001's addresses through $(rel "$MATCH") (tools_py.revision_toml)"
    if ! (cd "$ROOT" && "$py" -m tools_py.revision_toml "$ROOT/recomp/socom2.toml" "$MATCH" \
            --elf-b "$ELF" \
            --set-input "$TOML_INPUT" --set-output "$TOML_OUTPUT" \
            --set-ghidra-output "$TOML_GHIDRA" --set-names "$TOML_NAMES" --out "$TOML"); then
      echo "build_revision: step 3 could not translate the config through $(rel "$MATCH") -- run tools_py.revision_toml by hand to see why, or drop --match to copy r0001's addresses across unchanged" >&2
      exit 1
    fi
  else
    sed -e "s|^input *=.*|input = \"$TOML_INPUT\"|" \
        -e "s|^output *=.*|output = \"$TOML_OUTPUT\"|" \
        -e "s|^ghidra_output *=.*|ghidra_output = \"$TOML_GHIDRA\"|" \
        -e "s|^names *= *\"[^\"]*\"|names = \"$TOML_NAMES\"|" \
        "$ROOT/recomp/socom2.toml" > "$TOML"
  fi
  say "toml: $(rel "$TOML") (input $TOML_INPUT, output $TOML_OUTPUT, ghidra_output $TOML_GHIDRA)"
  # The last lock-free product. recomp/socom2_r0004.toml is tracked and step 3 rewrites it every run (every other
  # revision's is git-ignored), so --stop-after toml is how a change to what step 3 writes is checked against the
  # tree without the lock; test_build_products.py makes the same check without a build.
  [ "$STOP" = toml ] && { say "stop after toml"; exit 0; }
  # 4-5 under the lock, re-entering this script
  export BR_REV="$REV" BR_STOP="$STOP" BR_FORCE="$FORCE" BR_OUT="$OUT" BR_EXTRA="$EXTRA"
  exec bash "$ROOT/scripts/loop_lock.sh" run build-revision --purpose "build_revision $REV: recomp$([ "$STOP" = runtime ] && echo ' + runtime')" \
       --wait "${BUILD_REVISION_LOCK_WAIT:-60}" -- bash "$ROOT/scripts/build_revision.sh" --_tail
fi

# ---- steps 4-5, under the lock -------------------------------------------------------------------------------
command -v clang >/dev/null 2>&1 && command -v cmake >/dev/null 2>&1 && command -v ninja >/dev/null 2>&1 \
  || die2 "no toolchain under tools/ -- run: bash scripts/bootstrap_windows.sh"
# 4 recomp
if [ "$FORCE" = 0 ] && [ -f "$GEN/.complete" ]; then
  say "recomp: $(ls "$GEN" | wc -l) files already in $(rel "$GEN") -- skipped (--force redoes it)"
else
  # Step 0 wrote the map; this step only reads it. It used to run fix_ghidra_csv.py over "$CSV" in place here,
  # which is why every build left the tracked map modified in git status.
  [ -f "$FIXED" ] || die2 "recomp: $(rel "$FIXED") is not there. Step 0 writes it; run scripts/build_revision.sh from the top rather than re-entering the lock-bound tail with --_tail"
  say "recomp: function map $(rel "$FIXED") sha256 $(sha "$FIXED")"
  if [ -z "${BR_PS2_RECOMP:-}" ]; then   # the test seam builds nothing (its comment, under "where everything is")
    cmake -S "$PS2R" -B "$TOOLBUILD" -G Ninja -DCMAKE_BUILD_TYPE=Release \
          -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ >/dev/null
    cmake --build "$TOOLBUILD" --target ps2_recomp ps2_analyzer -j "$(nproc)"
  fi
  # The output directory is NOT deleted first (issue #57, as build.sh's recomp()): ps2_recomp rewrites a file only
  # when its bytes change and removes the function files an earlier run left that this one did not produce, so an
  # unchanged file keeps its timestamp and step 5 after a rename recompiles only what the rename touched. The one
  # thing that must go first is the mark: a --force run that fails here must not leave the last run's .complete.
  rm -f "$GEN/.complete"
  (cd "$RECOMP_DIR" && "$PS2_RECOMP" "socom2_$REV.toml" > "recomp_run_$REV.log" 2>&1) \
      || { tail -20 "$RECOMP_DIR/recomp_run_$REV.log" >&2; echo "build_revision: recomp failed (the log above)" >&2; exit 1; }
  # unmapped= : continuation pcs no recompiled row owns (build.sh has the same field and why)
  say "recomp: $(ls "$GEN" | wc -l) files in $(rel "$GEN"), unhandled=$(grep -c unhandled-instruction "$RECOMP_DIR/recomp_run_$REV.log" || true), unmapped=$(grep -c unmapped-continuation "$RECOMP_DIR/recomp_run_$REV.log" || true)"
  # The names sidecar's events (#48): "Loaded N display names", or the WARNING that the toml's names path does not resolve.
  grep -E '^ *\[(info|warning)\] names - ' "$RECOMP_DIR/recomp_run_$REV.log" | sed -e 's/^ *\[warning\] names - /WARNING: names: /' -e 's/^ *\[info\] names - /recomp: names: /' || true
  : > "$GEN/.complete"      # the mark the skip above trusts: written only when ps2_recomp returned 0
fi
[ "$STOP" = recomp ] && { say "stop after recomp"; exit 0; }
# 5 runtime
if [ "$FORCE" = 0 ] && [ -f "$EXE" ] && [ -f "$EXE.complete" ]; then
  say "runtime: $(rel "$EXE") is already there -- skipped (--force redoes it)"
else
  cmake -S "$PS2R" -B "$RTBUILD" -G Ninja -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ \
        -DPS2X_RUNNER_GENERATED_DIR="$GEN" -DPS2X_ENABLE_LTO="${LTO:-OFF}" -DPS2X_GENERATED_OPT="${GENOPT:--O1}" \
        -DPS2X_GAME_REVISION="$REV" >/dev/null
  cmake --build "$RTBUILD" --target ps2EntryRunner -j "$(nproc)"
  mkdir -p "$DIST"
  cp "$RTBUILD/ps2xRuntime/ps2EntryRunner.exe" "$EXE"
  cp "$ELF" "$DIST/socom2_game_$REV.elf"
  : > "$EXE.complete"       # after both copies, so an interrupted copy is redone rather than shipped
  say "runtime: $(rel "$EXE") ($(stat -c %s "$EXE") B) + $(rel "$DIST")/socom2_game_$REV.elf"
fi
say "build_revision $REV: done"
