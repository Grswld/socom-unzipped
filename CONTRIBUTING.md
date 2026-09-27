# Contributing to SOCOM Unzipped

SOCOM Unzipped is a static recompilation of SOCOM II: U.S. Navy SEALs (NTSC, SCUS-97275, disc revision r0001) into a
native PC program, with online play on a hosted Horizon server. **No game code or game data is in this repository, and
none may be added**: not the ISO, not the ELF, not the recompiler's generated C++, not textures, audio or movies cut from
the disc, not memory-card saves. A pull request that contains any of it is closed unread.

## What you can build without the disc

The playable executable needs code generated from your own disc, so a fresh clone cannot build the game. It **can**
build and test everything else, which is where most contributions land:

| You have | You can build | How |
|---|---|---|
| A clone, Linux (Ubuntu 24.04 is what CI uses) | the runtime library, the C++ suite, the launcher, the tools; the Python suite | `bash scripts/build_linux.sh --no-runner`, then `bash scripts/build_linux.sh test --no-runner`. The package list is in `.github/workflows/linux.yml`. |
| A clone, Windows (Git Bash, Python 3) | the runtime library, the C++ suite, the launcher, the tools; the Python suite | `bash scripts/bootstrap_windows.sh` (fetches llvm-mingw, CMake and Ninja into `tools/`, each pinned by sha256; ~245 MB once), then `python -m pip install -r requirements.txt`, `./build.sh runtime --no-runner` and `./build.sh test --no-runner`. The `windows` workflow does exactly this on a bare runner. |
| Your own r0001 disc as well | the game | `pip install -r requirements.txt`, then `bash scripts/disc_to_elf.sh "<your ISO>"` (eight minutes and 4.2 GB: it extracts the disc and decrypts the overlays), then `./build.sh recomp`, `./build.sh runtime`, `./build.sh test` (Windows, Git Bash) or `scripts/build_linux.sh`; the recipe is `docs/DEVELOPING.md` "From your own disc to a buildable ELF". |

**The game from your own disc**, step by step with the line that says each step worked, is `docs/DEVELOPING.md`'s "a newcomer's first hour"; if a step refuses on your machine, open an issue with the line it refused on.

Not sure your disc is r0001? The launcher checks it and says so (exit code 67 is "not r0001").

## Before you open a pull request

0. **Install the hooks, once per clone:** `bash scripts/install_hooks.sh`. It points git at `scripts/hooks/`, where a
   leak check (`python -m tools_py.release.leakcheck`) runs over what you are about to commit and, again, over every
   commit you are about to push: key material, tokens, a home directory with your user name in it, an address, a
   file the `.gitignore` refuses. One command covers all of it: `python -m tools_py.release.leakcheck all` --
   the tree, the ignored paths, the commit identities, the full history, and `external`, which calls the site's
   and the monitor's own scanners when those repositories sit beside this one. You almost certainly do not have
   them, so `external` prints SKIPPED and changes nothing: **SKIPPED is not clean**, it is the gate saying it did
   not look, and a maintainer who does have them runs `leakcheck external --require`, where a missing one is
   exit 2. CI runs the same check plus gitleaks on every push. If it stops you, fix the hit;
   if the hit is a reviewed non-secret (a test fixture, a version string it misread), add one line with its reason
   to `tools_py/release/leak_allow.txt` in the same PR. Do not bypass it with `--no-verify` -- the push hook and CI
   will refuse the same thing, and a secret in a pushed commit means rewriting history.
1. **Branch from `main`**, named `fix/<slug>`, `feat/<slug>` or `docs/<slug>`. One topic per PR. (`sprint-N` branches
   are the maintainers' integration branches; do not target them.) The whole scheme is `docs/GIT_STRATEGY.md`.
2. **A failing test first** for any change to behaviour. C++ cases live in `third_party/ps2recomp/ps2xTest/src/`,
   Python ones in `tools_py/tests/` (unittest only, no pytest). Say in the PR what the test failed with before your fix.
3. **Both suites green.** CI runs them on Linux. A change that touches the runtime, `recomp/`, `tools_py/parity/`,
   `scripts/parity/` or `build.sh` also has to pass the three-stage in-game gate (`python -m tools_py.parity.gate`),
   which needs the disc -- if you do not have one, say so and a maintainer runs it.
4. **Say what you measured.** This project does not accept "should be faster" or "looks right": give the number, the
   command that produced it, and what it was before. If you moved a default or skipped a measurement, say that too.
5. **Commits:** `type(scope): what changed and why`, types `feat fix refactor test docs build ci chore`. Outside PRs
   are squash-merged, so a tidy history is welcome but not required.
6. **New environment knobs** (`PS2X_*`) need a reason and a row: `docs/KNOBS.md` is generated from `ps2x/knobs.h`,
   and a name with no row, a row nothing reads, or a read that goes around `ps2x::knob` fails the suite. A knob that
   names a path must stay inside the portable folder.
7. **Third-party code** needs its licence text under `LICENSES/` and a row in the notices file in the same PR. The
   vendored recompiler (`third_party/ps2recomp`) is GPL-3.0 and the executable links it, so contributions are accepted
   under GPL-3.0-compatible terms.

## What is most useful

Reproducible bug reports, fixes with a test, Linux and Steam Deck results on real GPUs, controller mappings, and
documentation that a stranger followed successfully. Large refactors and new features: open an issue first.

## Reporting a bug

- **As a player:** use REPORT A BUG in the launcher (or on https://s2u.scotho.com). It goes to a private inbox, can
  attach a scrubbed log if you tick the box, and gives you a `BR-` id. Nothing is sent until you press SEND.
- **As a contributor:** open a GitHub issue with the bug template. If you also sent a launcher report, put its `BR-`
  id in the issue instead of pasting your log in public. SAVE DIAGNOSTICS in the launcher writes a zip with your home
  directory and credentials removed; attach that if a maintainer asks.
- **Security problems:** not in a public issue -- see `SECURITY.md`.

## Known issues, and taking one

The open defects the project knows about are the issues labelled
[`known-issue`](https://github.com/Scotho/socom-unzipped/issues?q=is%3Aissue+is%3Aopen+label%3Aknown-issue): each
says what happens, what evidence shows it, where it is written in `docs/KNOWN.md`, and the **closing bar** -- the
test, measurement or gate result that would show it fixed. The milestone says which sprint intends to close it; no
milestone is the backlog.

[`help wanted`](https://github.com/Scotho/socom-unzipped/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22)
marks the ones you can close without a disc. The rule is `docs/DOC_MAINTENANCE.md` §7 step 6, applied at every sprint
close: the label goes on an issue only when its closing bar needs no disc, no run of the in-game gate and nothing
that lives on the maintainer's machine, and `good first issue` only where that bar is a test you can run yourself.
Each labelled issue carries a comment saying what you can do there without a disc and what you cannot. `needs-disc-gate` marks the ones that need the disc.
An issue whose body opens with "Internal:" is the maintainer's loop lock or gate harness: public for the record, not
something a contributor can run. Some Evidence sections cite paths under `logs/`: those are git-ignored files on the
maintainer's machine, and the same section says so and names what a clone holds instead (the test, the KNOWN row, a
fixture under `tools_py/tests/fixtures/`).

**What you can do without a disc.** Everything in `docs/DEVELOPING.md`'s "a newcomer's first hour" that is not the
disc chain: `bash scripts/bootstrap_windows.sh`, then `./build.sh runtime --no-runner` (the runtime library and the
launcher) and `./build.sh test --no-runner` (the C++ suite, the Python suite and the VU1 fixture verify), or
`bash scripts/build_linux.sh --no-runner` and its `test` step on Linux; the Python suite alone,
`python -m unittest discover -s tools_py/tests -t .` (cases that need an extracted disc skip themselves, so a skip
count different from CI's is not a failure); the documentation checks, `python -m tools_py.docmaint`; the leak check,
`python -m tools_py.release.leakcheck all`; and an issue body's shape, `python -m tools_py.issues check-body FILE`.
What needs your own r0001 disc: `scripts/disc_to_elf.sh`, `./build.sh recomp`, a `./build.sh runtime` that builds
the game, and the gate (`python -m tools_py.parity.gate`). The conventions behind the list are `docs/GIT_STRATEGY.md` §7, and the stack is reviewed in full at every
sprint close.

To take one: comment on the issue first so two people do not do the same work; your pull request says `Closes #N`
and quotes the bar it met. If you find a defect that is not listed, open it with the bug template -- the maintainers
move it onto the stack once it is reproduced from the project's own code and harness.

## Conduct

Be civil and specific. This is a preservation project run by one person and a set of AI agents working under that
person's direction (`docs/HOW_IT_WAS_BUILT.md` describes how); agent-written commits carry a
`Co-Authored-By` trailer. Cheats, exploits against other players, and anything aimed at a server the project does not
run are out of scope and unwelcome. SOCOM, PlayStation and related marks belong to their owners; this project is not
affiliated with or endorsed by Sony Interactive Entertainment.
