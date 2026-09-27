# SOCOM Unzipped

**SOCOM II: U.S. Navy SEALs, statically recompiled from your own disc into a native PC program, with online play on a
hosted server.**

[![linux](https://github.com/Scotho/socom-unzipped/actions/workflows/linux.yml/badge.svg)](https://github.com/Scotho/socom-unzipped/actions/workflows/linux.yml)
[![windows](https://github.com/Scotho/socom-unzipped/actions/workflows/windows.yml/badge.svg)](https://github.com/Scotho/socom-unzipped/actions/workflows/windows.yml)
[![secrets](https://github.com/Scotho/socom-unzipped/actions/workflows/secrets.yml/badge.svg)](https://github.com/Scotho/socom-unzipped/actions/workflows/secrets.yml)

A green badge means everything that builds without the game built and passed its tests on a clean machine. The game
itself is checked on the maintainer's machine, with a disc.

> ## ⚠️ Multiplayer disclaimer
>
> Online play is at your own risk. The game's network code is twenty years old, recompiled as it was, and it runs as
> a native program on your PC. Some known problems have been addressed and others have not; what is known, and what
> to do if you find something, is in `SECURITY.md`. Play only with people you trust, on the project's server or one
> you run yourself, never with a build you did not compile or verify, and never against a community server.

> **Early stage.** This is a working prototype, not a finished port. It boots, plays the menus and the missions, and
> two copies of the game have finished online rounds against each other on the hosted server, driven by the project's
> own test harness on one machine. No two people have played each other yet, audio and some maps still have rough
> edges, and things break between builds. Read [Status](#status) before you expect anything.

## What it is, and what it is not

- **A static recompilation.** The game's PS2 executable is translated to C++ once and compiled natively; the result runs
  the game's own code as a normal Windows (and, in progress, Linux) program. There is no PS2 emulator underneath -- the
  runtime provides the hardware the code expects (EE kernel, DMA, a software/OpenGL GS, VU1, the IOP services), and
  SOCOM-specific hooks on top of that.
- **Your own disc.** The game reads its assets from the ISO of the US retail release (`SCUS-97275`, disc revision
  r0001); the launcher verifies the disc before it will launch. **No game code or game data is in this repository**:
  not the executable, not the recompiled C++, not textures, audio, movies or saves -- the recompiled program is built
  by each developer from their own disc. A contribution that adds any of it is closed unread (`CONTRIBUTING.md`); the
  release will carry the program, never the disc's own files (issue #70).
- **Online play on a server we host.** The game's original network (DNAS / Medius) is gone; this project runs a
  [Horizon Private Server](https://github.com/Horizon-Private-Server/horizon-server) configured for SOCOM II and points
  the game at it. The launcher's default server is `socom.scotho.com`.
- **Not affiliated** with Sony Interactive Entertainment, Zipper Interactive, or the SOCOM community servers. SOCOM is
  their trademark; this is a fan project for people who own the disc.

## Status

As of 2026-09-26 the game boots from your own disc to the title, through the menus and into the missions, with a pad
(the keyboard walks the menus), and renders through OpenGL at up to four times the console's resolution. Online login, the lobby and
full rounds work on the hosted server, so far only between copies of the game driven by the test harness on one
machine; a build of the community's r0004 revision plays a round too. Not yet: the console's full frame rate in
missions, a finished Linux client, and any disc other than the NTSC r0001 release.
The game does not send your voice yet.

The audited version of this, with the evidence for each claim, is `docs/KNOWN.md`.

## For players: get it

**[`docs/INSTALL.md`](docs/INSTALL.md)** is the whole setup, in the order a first run happens, and
**[`docs/FAQ.md`](docs/FAQ.md)** answers what goes wrong — every exit code, the disc revision, SmartScreen, ports,
saves and audio.

There is no public download yet. When there is, it will be announced at <https://s2u.scotho.com>, which also carries the
setup guide and the server's live status. The shape of it: unzip a folder, run `socom_unzipped_launcher.exe`, point it
at your SOCOM II ISO, pick video and controller settings, Launch. Nothing is installed; delete the folder to uninstall.
The launcher refuses any disc that is not r0001 and says so.

## For developers

You need your own r0001 disc to build the game; without it you can still build and test the runtime, the tools, the
launcher and the Python harness (that is what CI does, on Linux and on Windows). A fresh clone on Windows, in Git Bash
with Python 3:

```
bash scripts/install_hooks.sh          # the leak check before every commit and push (the repository is public)
bash scripts/bootstrap_windows.sh      # llvm-mingw, CMake and Ninja into tools/, pinned by sha256 (~245 MB, once)
python -m pip install -r requirements.txt   # the Python packages the tools and the suite import, pinned
./build.sh runtime --no-runner         # the runtime library and the launcher, no game
./build.sh test --no-runner            # both suites and the VU1 replay goldens
```

With your own ISO, the game itself:

```
bash scripts/disc_to_elf.sh "<your ISO>"   # the disc tree and the decrypted overlays (eight minutes, 4.2 GB)
./build.sh recomp      # build the merged ELF from the disc and run the recompiler
./build.sh runtime     # cmake + ninja + clang -> dist/socom2.exe and the launcher
./build.sh test        # the Python suite, then the C++ suite and the VU1 replay goldens
python -m tools_py.parity.gate --stamp first_run     # the in-game gate, 15 to 17 minutes
```

`docs/DEVELOPING.md` is the full developer reference: repository layout, the first hour on a clean checkout with the
lines that say each step worked, every runtime knob (`PS2X_*`) and its exact effect, the online harness, and the
launcher internals. `CONTRIBUTING.md` says what a pull request needs; `docs/GIT_STRATEGY.md` how branches are cut.

### How it works, in one paragraph

The retail ELF is only a loader; the game itself is two encrypted overlays the loader decrypts from the disc. The
tooling under `tools_py/` recovers the plaintext overlays from the player's disc, merges them with the loader into one
ELF, and hands that to a vendored fork of [PS2Recomp](https://github.com/ran-j/PS2Recomp) (`third_party/ps2recomp`)
which emits C++. The fork's runtime supplies the PS2 the code expects; SOCOM's own quirks live in
`third_party/ps2recomp/ps2xRuntime/src/lib/game_overrides_socom2.cpp` (EE side) and
`third_party/ps2recomp/ps2xIOP/src/modules/` (IOP services: sound, network, memory cards). The server under `server/`
is Horizon configured for SOCOM II's app id, with a seed script for a local instance.

### Where things are

| Path | What |
|---|---|
| `build.sh`, `run.sh` | Build and run on Windows (Git Bash); `scripts/build_linux.sh` on Linux |
| `recomp/` | Recompiler configuration, the function map, and the readable names with their provenance (`socom2_names.csv`; `docs/DEVELOPING.md` "Names in the generated code") |
| `third_party/ps2recomp/` | The vendored PS2Recomp fork with this project's runtime changes (`git log -- third_party`) |
| `tools_py/` | Python tooling: the disc-to-ELF chain, the recompiler's inputs, the naming levers, the parity gate and the online harness, tests (`docs/DEVELOPING.md` has a map of every module). |
| `ghidra_scripts/` | Headless Ghidra scripts used for the reverse engineering |
| `server/` | Horizon Private Server sources and the SOCOM II configuration |
| `docs/` | Player pages `docs/INSTALL.md` and `docs/FAQ.md`; the developer reference `docs/DEVELOPING.md`; the record `docs/KNOWN.md` |
| `tests/` | Fixtures for the C++ suite |
| `web/` | The experimental browser map viewer, a separate project that lives here: its own npm workspace, tests, README, docs and CI (`web.yml`). It decodes the disc's map archives and needs nothing from the recompilation, which needs nothing from it. Working on the recomp? Skip it. |

### How it was built

`docs/HOW_IT_WAS_BUILT.md` is the honest account: AI agents (Claude, through Claude Code) working in sprints under a
human owner, what each side did, and what went wrong.

## Contributing and security

Issues and pull requests are welcome -- see `CONTRIBUTING.md` for what can be built without a disc and what a PR must
not contain. Security problems go through GitHub's private vulnerability reporting, not a public issue: `SECURITY.md`.

## License and credits

The port -- the runtime fork and everything that generates or drives it -- is **GPL-3.0**, because PS2Recomp is
(`LICENSE`). The Horizon server is MIT (`server/horizon-server/LICENSE`). Every third-party component in the tree and
in the download, with its licence, is in `THIRD_PARTY_NOTICES.md` and `LICENSES/` (a test keeps that list complete).
No game data is distributed and none is licensed here; SOCOM II remains the property of its rights holders.

Built on [PS2Recomp](https://github.com/ran-j/PS2Recomp) and
[Horizon Private Server](https://github.com/Horizon-Private-Server/horizon-server), with
[Ziemas's 989snd decompilation](https://github.com/Ziemas/989snd) as the reference for the sound driver, and the
knowledge the SOCOM community has kept alive for twenty years.
