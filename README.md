# SOCOM Unzipped - MacOS

**A macOS port of [SOCOM Unzipped](https://github.com/Scotho/socom-unzipped)**, the project that statically recompiles
SOCOM II: U.S. Navy SEALs from your own disc into a PC program. This fork builds and runs it on Apple Silicon Macs.

> **All credit for SOCOM Unzipped goes to its original author, [Scotho](https://github.com/Scotho), and the project's
> contributors**: the recompilation, the runtime, the disc tooling, the online server, the reverse engineering and
> the research this fork stands on are theirs. This fork adds a macOS build, a few performance and audio fixes, and
> notes; everything else is the upstream project, unchanged. Please direct your support and thanks there.

> ## ⚠️ Multiplayer disclaimer
>
> Online play is at your own risk. The game's network code is twenty years old, recompiled as it was, and it runs as
> a native program on your PC. Some known problems have been addressed and others have not; what is known, and what
> to do if you find something, is in `SECURITY.md`. Play only with people you trust, on the project's test server or
> one you run yourself, never with a build you did not compile or verify, and not yet against a community server: the
> launcher does not offer one until it can install the r0004 update (see [Status](#status)).

## Status

As of 2026-10-02, on an M2 Pro running macOS 15, with the US retail disc (`SCUS-97275`, revision r0001):

**What works**
- The game builds on macOS from your own disc, and the recompiler's output matches the upstream Windows reference.
- It boots to the title, plays the intro movie and walks the menus by keyboard.
- Missions play, with picture, sound effects, voice and ambience.
- The mission music plays correctly: each cue from its start to its composed ending, with the game's own fades
  between cues (fixed 2026-10-02; see the changelog below).
- Rendering is smooth most of the time: the window presents at about 55 frames a second in a mission.

**What is rough**
- **The game's own frame rate is low.** The game logic runs at about 15–29 frames a second in a mission (about 19
  on average; upstream measured about 23 on Windows), so movement can feel heavy in busy scenes.
- **Brief frame drops about every 2 seconds**, when the game uploads a large batch of textures and the renderer
  reads frames back from the GPU in the same frame.
- **Controls:** the keyboard works; there is no mouse support yet, and a gamepad has not been tested on macOS.

**Not available on macOS yet**
- The launcher program (it builds, but it is not ported): the game is started from the command line.
- Online play has not been tried on macOS.
- An app bundle (`.app`), code signing, and Retina (2x) displays (a fix is in, but it has not been verified on one).

For the upstream project's own status on Windows and Linux, see `docs/KNOWN.md` and the upstream README.

## Changelog (this fork)

**2026-10-01: the macOS port (phase 1)**
SOCOM Unzipped built for Windows, with Linux in progress; there was no way to play it on a Mac.
- A macOS build script, `scripts/build_macos.sh`, with the arm64 Homebrew tools.
- FFmpeg built from pinned source, for the movies.
- The SSE vector code through sse2neon on Apple Silicon, and the x87 rounding control made x86-only.
- macOS versions of the few Linux-only pieces.
- A Retina-safe viewport, and a clean refusal (exit code 76) instead of a crash when the display is asleep.
- `run.sh` working without GNU `timeout`.

**2026-10-02: smoother rendering**
A profile showed the render thread spending 42–49% of its time inside Apple's OpenGL
driver, issuing about 4,000 draw calls a frame. 87% of those draws were split apart by a byte-for-byte comparison of
the draw state that also compared the structures' padding bytes, so identical states looked different.
*What:*
- Draw batches are now compared by value: about 530 draws a frame instead of about 4,150, and half the render
  thread's time per frame (21.5 ms to 11.0 ms on a recorded firefight).
- Every frame of that firefight is pixel-identical before and after the fix.
- Diagnostics behind knobs: why batches end, what makes a frame slow, frame-time percentiles.
- A recording hotkey (`P`), and frame dumps in the replay bench for image comparisons.

**2026-10-02: the mission music**
In-game music skipped about every 1.2 seconds, the start of every music cue was missing, and the music stopped
dead halfway through.
The music streamer misread three fields of the game's music file header:
- where the audio starts (it skipped the first 1.1 s);
- the size, which is per channel (only half of every track played);
- where the right channel sits in the last buffer.

All three were checked against all 210 music files on the disc. The bug affects every platform, not only macOS.

The full, generated record of every merge, upstream's and this fork's, is `docs/CHANGELOG.md`.

## Planned (or at least attempted)

- **Fewer frame drops:** spread or avoid the texture-upload and GPU-readback bursts that cause the drops about every
  2 seconds.
- **A faster game thread:** speed up the vector-unit and runtime work that holds the game's own frame rate near 19.
- **Fewer OpenGL calls:** skip the state and uniform calls that repeat what is already set.
- **A Metal renderer**, keeping the OpenGL renderer as a reference so that both can render the same recorded frames
  and any difference is caught automatically.
- **Mouse look and mouse menu navigation.**
- **Gamepad support verified on macOS.**
- **The launcher on macOS**, and a proper `.app` bundle.
- **Retina (2x) displays verified.**
- **Online play on macOS.**
- **Automated macOS builds and tests (CI).**
- **Offer the fixes to the upstream project**, starting with the music fix (the branch `upstream-vpk-fix`).

## Building it

You need an Apple Silicon Mac, the Xcode Command Line Tools, the arm64 Homebrew at `/opt/homebrew`
(`brew install cmake ninja pkgconf`, plus `bash coreutils` for the test suite) and **your own SOCOM II disc image**:
the US release, `SCUS-97275`, revision r0001.

```
python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt
PATH="$PWD/.venv/bin:$PATH" bash scripts/disc_to_elf.sh "<your ISO>"
scripts/build_macos.sh            # tools, recompile, runtime -> dist-macos/socom2
scripts/build_macos.sh test       # the test suites
PS2X_CD_IMAGE="<your ISO>" bash run.sh 60
```

`docs/DEVELOPING.md`, section "macOS (Apple Silicon)", has the details. **No game code or game data is in this
repository**, as upstream: the program is built by each person from their own disc.

## How it works, in one paragraph (from upstream)

The retail ELF is only a loader; the game itself is two encrypted overlays the loader decrypts from the disc. The
tooling under `tools_py/` recovers the plaintext overlays from the player's disc, merges them with the loader into one
ELF, and hands that to a vendored fork of [PS2Recomp](https://github.com/ran-j/PS2Recomp) (`third_party/ps2recomp`)
which emits C++. The fork's runtime supplies the PS2 the code expects; SOCOM's own quirks live in
`third_party/ps2recomp/ps2xRuntime/src/lib/game_overrides_socom2.cpp` (EE side) and
`third_party/ps2recomp/ps2xIOP/src/modules/` (IOP services: sound, network, memory cards). The server under `server/`
is Horizon configured for SOCOM II's app id, with a seed script for a local instance.

## License and credits

**SOCOM Unzipped is the work of [Scotho](https://github.com/Scotho) and its contributors**
([upstream repository](https://github.com/Scotho/socom-unzipped)); this fork only adds to it, under the same terms.

The port -- the runtime fork and everything that generates or drives it -- is **GPL-3.0**, because PS2Recomp is
(`LICENSE`). The Horizon server is MIT (`server/horizon-server/LICENSE`). Every third-party component in the tree and
in the download, with its licence, is in `THIRD_PARTY_NOTICES.md` and `LICENSES/` (a test keeps that list complete).
No game data is distributed and none is licensed here; SOCOM II remains the property of its rights holders.

Built on [PS2Recomp](https://github.com/ran-j/PS2Recomp) and
[Horizon Private Server](https://github.com/Horizon-Private-Server/horizon-server), with
[Ziemas's 989snd decompilation](https://github.com/Ziemas/989snd) as the reference for the sound driver, and the
knowledge the SOCOM community has kept alive for twenty years.

**Not affiliated** with Sony Interactive Entertainment, Zipper Interactive, or the SOCOM community servers. SOCOM is
their trademark; this is a fan project for people who own the disc.
