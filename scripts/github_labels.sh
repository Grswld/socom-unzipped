#!/usr/bin/env bash
# Sprint 11 Goal 7, the bug pipeline's GitHub half: the repository's label set, as code -- plus, since 2026-09-23,
# the known-issue stack's four extra areas and its two markers (docs/GIT_STRATEGY.md section 7).
#
# Run once per repository (and again whenever a label is added or its wording changes):
#
#     bash scripts/github_labels.sh              # the real repository, github.com/Scotho/socom-unzipped
#     bash scripts/github_labels.sh --dry-run    # print the gh commands and touch nothing
#     GITHUB_LABELS_REPO=me/fork bash scripts/github_labels.sh
#
# GitHub's own default labels `help wanted` and `good first issue` are NOT in this set: they exist on every
# repository, their names carry spaces (this set is lower-case hyphenated), and the sprint-close review hands them
# out under docs/DOC_MAINTENANCE.md section 7 step 6 (2026-09-25, Sprint 13 S3).
# Every label is created with `gh label create --force`, so the script is IDEMPOTENT: a second run updates the
# colour and the description of a label that already exists instead of failing, and nothing is ever deleted --
# a label this file does not name is left alone, because issues may already carry it.
#
# Labels are repository metadata, not permissions: this touches no ruleset, no branch protection and no
# collaborator (docs/HANDOFF.md rule 13 -- those stay the owner's). It needs `gh auth login` with write access
# to issues; tools_py/tests/test_github_labels.py only parses the list below and never runs gh.
set -euo pipefail

REPO="${GITHUB_LABELS_REPO:-Scotho/socom-unzipped}"
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "usage: $0 [--dry-run]   (repository: \$GITHUB_LABELS_REPO, default $REPO)" >&2; exit 2 ;;
  esac
done

# name|colour|description -- the two kinds in the first block, the areas in the second. The colours are the
# GitHub defaults' family: red for a defect, green for a request, yellow for "we cannot act yet", grey for area.
LABELS=(
  "bug|d73a4a|Something does not work. A launcher report's BR- id may be quoted in the body."
  "from-launcher|d73a4a|Opened from a report sent through the launcher or socomunzipped.com; the BR- id is the reference."
  "feature|0e8a16|Something the project should do, or do differently. Not something broken: that is a bug."
  "needs-repro|fbca04|Not yet reproduced from our own code and harness. Not a confirmed defect until it is."
  "needs-disc-gate|fbca04|Cannot be checked without a disc: needs a run of the parity gate on real game data."
  "audio|c5def5|Sound: the 989snd path, streams, music, voice."
  "render|c5def5|The GS and the GL host: geometry, textures, timing, the window."
  "online|c5def5|Multiplayer: the server, matchmaking, the lobby, in-game networking."
  "launcher|c5def5|The launcher application: its pages, its settings, the disc check, REPORT A BUG."
  "input|c5def5|Controllers and the keyboard: mapping, dead zones, the on-screen keyboard."
  "linux|c5def5|The Linux build and anything specific to it, including the Steam Deck."
  "packaging|c5def5|The portable build, the release artefacts, installation and first run."
  "docs|c5def5|Documentation: the README, the guides, the site's pages."
  "harness|c5def5|The parity harness, the gate, the ladder, the loop lock, CI and the VM ring."
  "server|c5def5|The Horizon server we host and its box; never a server the project does not run."
  "build|c5def5|build.sh, CMake, the toolchains, the recompile pipeline from a disc to an exe."
  "recomp|c5def5|The recompiled game and its HLE: the emitter, VU, the kernel stubs, memory cards, GS registers."
  "known-issue|b60205|Known-issue stack (GIT_STRATEGY 7): a defined, evidenced, unresolved defect cited by a KNOWN row."
  "carried|b60205|Survived a sprint close unresolved; the close review said why and set the next milestone or none."
)

if [ "$DRY_RUN" -eq 0 ] && ! command -v gh >/dev/null 2>&1; then
  echo "github_labels.sh: gh is not installed -- see https://cli.github.com (or run with --dry-run)" >&2
  exit 2
fi

for entry in "${LABELS[@]}"; do
  name="${entry%%|*}"
  rest="${entry#*|}"
  colour="${rest%%|*}"
  description="${rest#*|}"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "gh label create $name --repo $REPO --color $colour --description \"$description\" --force"
    continue
  fi
  gh label create "$name" --repo "$REPO" --color "$colour" --description "$description" --force
done

echo "github_labels.sh: ${#LABELS[@]} labels applied to $REPO$([ "$DRY_RUN" -eq 1 ] && echo ' (dry run)')"
