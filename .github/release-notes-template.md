**SOCOM Unzipped {{TAG}}** -- a DRAFT, created by the `release-draft` workflow from commit `{{SHA}}`. Nothing here
is published until the owner clicks Publish, and the checklist below is what has to be true first.

## Before publishing

- [ ] The archives were built on the owner's machine from this exact commit: `./build.sh release` then
      `scripts/make_portable.sh --release` (Windows), the Linux pair in the VM. CI cannot build them: the game's
      recompiled code comes from the owner's disc and is not in the repository.
- [ ] The three-stage gate passed 3/3 on the exe INSIDE the archive (`python -m tools_py.parity.gate --stamp <name>`);
      the stamp is named here: `________`.
- [ ] `socom2-portable.zip` (the player), `socom2-developer.zip` (the developer: the debug UI in),
      `socom2-linux.tar.gz` and `socom2-linux-developer.tar.gz` (the same two kinds on Linux) and `SHA256SUMS` are
      attached to this draft.
- [ ] The `release-draft` workflow was run by hand with this tag and appended **Verified** below (SHA256SUMS, the
      import audit and the leak check on each archive, THIRD_PARTY_NOTICES.md and LICENSES/ present).
- [ ] The legal position on distributing recompiled code (Sprint 11 decision D2) stands as decided.
- [ ] `docs/STATUS.md` and `docs/STORY.md` carry this release.

## What is in it

<!-- the release notes: what a player gets that the last release did not, what is known not to work -->

## Known issues

See `docs/KNOWN.md` at this tag, and the multiplayer warning at the top of the README.
