"""PLAYTEST's build block, rendered from make_portable's manifest (Sprint 14 Task D5).

`python -m tools_py.playtest_block [--manifest PATH] [--check]` rewrites the text between `<!-- build:begin -->`
and `<!-- build:end -->` in docs/PLAYTEST.md from the manifest scripts/make_portable.sh writes last, beside the
build it packaged (`dist/manifest.json` by default): the archive, its sha256, the runner's sha256, the commit and
branch it was built from, when, and whether the tree was dirty. With no manifest the block says **NOT BUILT** and
how to build. Either way the exit is 0: the point is that the block always says the truth. `--check` exits 1 when
the block on disk differs from a fresh render and writes nothing; 2 is a page without the markers or a manifest
that cannot be read.

The render does not depend on the day (`today` is accepted and unused), so `--check` never goes stale overnight;
it goes stale only when a build lands or goes away. scripts/parity/playtest_block.sh is the chain step that builds
and then runs this. The sitting page's reader (tools_py/sitting.py, D3) takes the block between the same markers.
"""
import argparse
import difflib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = "docs/PLAYTEST.md"
DEFAULT_MANIFEST = "dist/manifest.json"
BEGIN = "<!-- build:begin -->"
END = "<!-- build:end -->"

NOT_BUILT = "\n".join([
    "**NOT BUILT** -- no release archive has been packaged from this tree, so there is no build to play or to check",
    "against. The merged chain's last step (`scripts/parity/playtest_block.sh`) packages the build it made and writes",
    "this block. By hand, after `./build.sh release`: `bash scripts/make_portable.sh --release` under the lock",
    "(`bash scripts/loop_lock.sh run <name> --purpose \"release archive\" -- bash scripts/make_portable.sh --release`),",
    "then `python -m tools_py.playtest_block --manifest dist-release/manifest.json` writes this block from the",
    "manifest the packaging leaves in `dist-release/`.",
])


def render(manifest, today=None):
    """The block's text (between the markers, without them). `manifest` is make_portable's dict or None."""
    del today   # the render is day-independent, so --check is stable (see the module docstring)
    if not manifest:
        return NOT_BUILT
    commit = str(manifest.get("commit", "?"))
    dirty = int(manifest.get("tree_dirty", 0) or 0)
    build = "build:    %s   commit %s (%s)" % (manifest.get("built_at", "?"), commit[:12],
                                               manifest.get("branch", "?"))
    if dirty > 0:
        build += "   dirty tree: %d uncommitted path%s" % (dirty, "" if dirty == 1 else "s")
    # Sprint 16 R3a (R295): a --release run packages the player and the developer archive; the manifest lists each
    # under "archives" with its kind (the first, the player, is also the top level). An older manifest has one.
    archives = manifest.get("archives") or [manifest]
    lines = ["```", build]
    for a in archives:
        archive = "archive:  %s" % a.get("archive", "?")
        if a.get("kind"):
            archive += "   [%s]" % a["kind"]
        if a.get("archive_path"):
            archive += "   (%s)" % a["archive_path"]
        lines += [
            archive,
            "          sha256: %s" % a.get("archive_sha256", "?"),
            "exe:      %s sha256: %s" % (a.get("exe", "socom2.exe"), a.get("exe_sha256", "?")),
        ]
    play = ("play that archive" if len(archives) == 1 else
            "play the %s archive (the first)" % (archives[0].get("kind") or "first"))
    lines += [
        "```",
        "",
        "Written by `python -m tools_py.playtest_block` from the manifest `scripts/make_portable.sh` wrote with this "
        "archive (the chain's last step); %s, unzipped to a new folder." % play,
    ]
    return "\n".join(lines)


def load(path):
    """The manifest dict, or None when there is no file. A file that is not a JSON object raises ValueError."""
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError("not a JSON object")
    return data


def splice(page, block):
    """The page with `block` between the markers; ValueError when the markers are missing or out of order.
    The block takes the page's own line ending (core.autocrlf checks markdown out CRLF on Windows, LF elsewhere),
    so the rewrite and `--check` agree in every checkout."""
    if "\r\n" in page:
        block = block.replace("\r\n", "\n").replace("\n", "\r\n")
        nl = "\r\n"
    else:
        nl = "\n"
    b = page.find(BEGIN)
    e = page.find(END)
    if b < 0 or e < 0 or e < b or page.count(BEGIN) != 1 or page.count(END) != 1:
        raise ValueError("%s needs exactly one %s followed by one %s" % (PAGE, BEGIN, END))
    return page[:b + len(BEGIN)] + nl + block + nl + page[e:]


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m tools_py.playtest_block", description=__doc__.split("\n")[0])
    ap.add_argument("--manifest", default=None, help="make_portable's manifest (default: <root>/%s)" % DEFAULT_MANIFEST)
    ap.add_argument("--check", action="store_true", help="exit 1 when %s's block differs from a fresh render" % PAGE)
    ap.add_argument("--root", default=None, help="the tree to read and write (default: this repository)")
    args = ap.parse_args(argv)
    root = args.root or ROOT
    manifest_path = args.manifest or os.path.join(root, DEFAULT_MANIFEST)
    target = os.path.join(root, PAGE)
    try:
        manifest = load(manifest_path)
    except (OSError, ValueError) as e:
        print("playtest_block: cannot read the manifest %s: %s" % (manifest_path, e))
        return 2
    try:
        with open(target, "r", encoding="utf-8", newline="") as fh:
            current = fh.read()
        fresh = splice(current, render(manifest))
    except (OSError, ValueError) as e:
        print("playtest_block: %s" % e)
        return 2
    state = "NOT BUILT" if manifest is None else "built %s" % manifest.get("archive", "?")
    if args.check:
        if current == fresh:
            print("playtest_block: %s's build block is current (%s)" % (PAGE, state))
            return 0
        diff = list(difflib.unified_diff(current.split("\n"), fresh.split("\n"),
                                         "%s (on disk)" % PAGE, "%s (fresh render)" % PAGE, lineterm=""))
        sys.stdout.write("\n".join(diff[:40]) + "\n")
        print("playtest_block: %s's build block is stale (%s); run python -m tools_py.playtest_block" % (PAGE, state))
        return 1
    if current != fresh:
        with open(target, "w", encoding="utf-8", newline="") as fh:
            fh.write(fresh)
    print("playtest_block: %s's build block says %s" % (PAGE, state))
    return 0


if __name__ == "__main__":
    sys.exit(main())
