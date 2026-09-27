#!/usr/bin/env bash
# The Windows toolchain a fresh clone needs, fetched and verified (Sprint 10 H3; Sprint 11 Goal 0's third item).
#
#   bash scripts/bootstrap_windows.sh            fetch what is missing or at another version into tools/
#   bash scripts/bootstrap_windows.sh --check    say what is there and exit 0 iff all three match
#   bash scripts/bootstrap_windows.sh --restore-owner-tools [--dry-run]
#                                                the owner's installs (PCSX2, Ghidra, ...) back into tools/ from the
#                                                off-tree backup, entry by entry as scripts/tools_backup_manifest.txt
#                                                names them (Sprint 16 X1; the 2026-09-26 loss, docs/HAZARDS.md git)
#
# build.sh puts tools/llvm-mingw/bin, tools/cmake/bin and tools/ninja on its PATH and nothing else, so these three
# are the whole toolchain: the same llvm-mingw the owner's builds use (clang 23.1.0, ucrt), CMake and Ninja. Each
# archive is pinned by version AND sha256 -- a download that does not match is deleted, never used. Only these
# three directories under tools/ are touched; everything else there (Ghidra, PCSX2, the reference trees) is the
# owner's and is left alone. Python 3 is required (it does the extraction; there is no unzip on a bare Git Bash).
#
# The CMake tree fetches the rest itself at configure time (raylib, imgui, the FFmpeg prebuilt, ...): see
# third_party/ps2recomp/ps2xRuntime/CMakeLists.txt. What a fresh clone still cannot build is the game -- the
# recompiled code comes from your own disc (README "For developers").
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/python_env.sh"   # $PYTHON, resolved once for every script
socom_require_python bootstrap_windows
TOOLS="${SOCOM_TOOLS_DIR:-$ROOT/tools}"     # the override exists for the script's own test
CACHE="$TOOLS/.bootstrap"

# name | version | url | sha256 | top-level directory inside the archive ("" = files at the root)
LLVM_MINGW_VERSION=20260826
CMAKE_VERSION=4.4.3
NINJA_VERSION=1.13.2
ENTRIES=(
  "llvm-mingw|$LLVM_MINGW_VERSION|https://github.com/mstorsjo/llvm-mingw/releases/download/$LLVM_MINGW_VERSION/llvm-mingw-$LLVM_MINGW_VERSION-ucrt-x86_64.zip|ae601f4e0f72bbdf441ad2df8bb16f037e2e9251559ea6b37b4057aef39c06c3|llvm-mingw-$LLVM_MINGW_VERSION-ucrt-x86_64"
  "cmake|$CMAKE_VERSION|https://github.com/Kitware/CMake/releases/download/v$CMAKE_VERSION/cmake-$CMAKE_VERSION-windows-x86_64.zip|4d52ebab7193a698651639ed80d8d04fd903358843572cf44c7fd234cb7c26ab|cmake-$CMAKE_VERSION-windows-x86_64"
  "ninja|$NINJA_VERSION|https://github.com/ninja-build/ninja/releases/download/v$NINJA_VERSION/ninja-win.zip|07fc8261b42b20e71d1720b39068c2e14ffcee6396b76fb7a795fb460b78dc65|"
)

py="$PYTHON"

sha256_of() { "$py" -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"; }

stamp_of() { cat "$TOOLS/$1/.bootstrap-version" 2>/dev/null || echo "-"; }

check_only=0
restore=0
dry_run=0
for arg in "$@"; do
  case "$arg" in
    --check) check_only=1 ;;
    --restore-owner-tools) restore=1 ;;
    --dry-run) dry_run=1 ;;
    *) echo "bootstrap: unknown argument $arg (the header lists the three forms)" >&2; exit 2 ;;
  esac
done
# An unknown argument used to fall through to the fetch path: a typo would start a 190 MB download. It refuses now,
# and so does a flag that belongs to another form: --dry-run alone would have fetched, --check with the restore
# would have restored.
if [ "$dry_run" = 1 ] && [ "$restore" = 0 ]; then
  echo "bootstrap: --dry-run goes with --restore-owner-tools; nothing was fetched" >&2; exit 2
fi
if [ "$check_only" = 1 ] && [ "$restore" = 1 ]; then
  echo "bootstrap: --check and --restore-owner-tools are two different runs; nothing was done" >&2; exit 2
fi

# --restore-owner-tools: everything under tools/ that is NOT the pinned toolchain is the owner's (PCSX2, Ghidra,
# whatever else the owner keeps there), and nothing re-fetches it. On 2026-09-26 the whole of tools/ was deleted through a
# worktree's junction (docs/HAZARDS.md, git); the toolchain came back with this script in a minute, the rest by hand
# from the off-tree backup. This flag makes that one command: the manifest names each entry with its file count and
# one probe file's size and sha256; every entry is verified in the backup BEFORE anything is copied (a failed
# manifest copies nothing), copied where tools/<name> is absent (an entry already there is left alone -- it may be
# newer than the backup; PCSX2 rewrites its ini and card as it runs, so a present entry is never re-checked against
# the manifest), and verified again after the copy. A copy in flight is marked by tools/<name>/.restore-incomplete,
# written before the first byte and removed only after the post-copy check passes, so an interrupted copy reads as
# absent next time and is replaced, never as "present". A destination that is a link, a junction or a file is
# refused before anything is copied (an agent worktree's tools/ is a junction -- the very trap this flag answers).
# The backup is only ever read. --dry-run prints the plan and copies nothing. The toolchain itself is the fetch
# path's: run without the flag for that.
if [ "$restore" = 1 ]; then
  BACKUP="${SOCOM_TOOLS_BACKUP:-D:/socom_archive/tools_backup_2026-09-26}"
  MANIFEST="${SOCOM_TOOLS_MANIFEST:-$ROOT/scripts/tools_backup_manifest.txt}"
  BACKUP="${BACKUP//\\//}"; MANIFEST="${MANIFEST//\\//}"      # printed and passed with forward slashes
  [ -d "$BACKUP" ] || { echo "restore: no backup at $BACKUP -- nothing was copied" >&2; exit 1; }
  [ -f "$MANIFEST" ] || { echo "restore: no manifest at $MANIFEST -- nothing was copied" >&2; exit 1; }
  echo "restore: verifying $BACKUP against $MANIFEST"
  "$py" - "$BACKUP" "$TOOLS" "$MANIFEST" "$dry_run" <<'PY'
import hashlib, os, shutil, sys
backup, tools, manifest, dry_run = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"

def rows():
    with open(manifest, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            name, files, probe, size, sha = line.split("|")
            if "/" in name or "\\" in name or name in (".", "..") or ".." in probe.split("/") or probe.startswith("/"):
                raise SystemExit("restore: refusing manifest row %r -- nothing was copied" % line)
            yield name, int(files), probe, int(size), sha

MARKER = ".restore-incomplete"

def count_files(root):
    return sum(len([f for f in fs if f != MARKER]) for _, _, fs in os.walk(root))

def is_reparse(path):
    """A symlink or a Windows junction (a reparse point), by lstat -- os.path.islink misses junctions."""
    if os.path.islink(path) or getattr(os.path, "isjunction", lambda p: False)(path):
        return True
    attrs = getattr(os.lstat(path), "st_file_attributes", 0)
    return bool(attrs & 0x400)            # FILE_ATTRIBUTE_REPARSE_POINT

def check(name, root, files, probe, size, sha, where):
    """The entry under root against its manifest row; the reason it fails, or None."""
    if not os.path.isdir(root):
        return "%s: missing from %s" % (name, where)
    n = count_files(root)
    if n != files:
        return "%s: %d files in %s, the manifest says %d" % (name, n, where, files)
    p = os.path.join(root, *probe.split("/"))
    if not os.path.isfile(p):
        return "%s: probe %s missing from %s" % (name, probe, where)
    got = os.path.getsize(p)
    if got != size:
        return "%s: probe %s is %d bytes in %s, the manifest says %d" % (name, probe, got, where, size)
    with open(p, "rb") as fh:
        digest = hashlib.sha256(fh.read()).hexdigest()
    if digest != sha:
        return "%s: probe %s sha256 %s in %s, the manifest says %s" % (name, probe, digest, where, sha)
    return None

fwd = lambda p: p.replace("\\", "/")

# Plan first, copy second: every refusal -- a bad backup entry, a destination that is a link, a junction or a
# file -- happens here, before the first byte moves, in the dry run and the real run alike.
entries = list(rows())
plan = []
for name, files, probe, size, sha in entries:
    src = os.path.join(backup, name)
    why = check(name, src, files, probe, size, sha, "the backup")
    if why:
        raise SystemExit("restore: %s -- nothing was copied" % why)
    print("restore: %s ok (%d files; %s %d bytes)" % (name, files, probe, size))
    dst = os.path.join(tools, name)
    if os.path.lexists(dst) and (is_reparse(dst) or not os.path.isdir(dst)):
        raise SystemExit("restore: %s: tools/%s is a link, a junction or not a directory -- nothing was copied"
                         % (name, name))
    if os.path.isdir(dst) and os.path.exists(os.path.join(dst, MARKER)):
        action = "replace"                # an earlier copy died half-way: absent, not present
    elif os.path.isdir(dst) and os.listdir(dst):
        action = "skip"
    else:
        action = "copy"
    plan.append((name, files, probe, size, sha, src, dst, action))

for name, files, probe, size, sha, src, dst, action in plan:
    if action == "skip":
        print("restore: %s present in tools/, left alone (%s)" % (name, fwd(dst)))
        continue
    if dry_run:
        if action == "replace":
            print("restore: %s: would replace the incomplete copy %s -> %s (%d files)" % (name, fwd(src), fwd(dst), files))
        else:
            print("restore: would copy %s -> %s (%d files)" % (fwd(src), fwd(dst), files))
        continue
    if action == "replace":
        # The marker must outlive the deletions: rmtree(dst) would take it first and a Ctrl-C in the middle would
        # leave a half-deleted entry with no marker, which the next run would call "present". So every child but
        # the marker goes, one by one, and the copy lands in the directory that still holds it.
        print("restore: %s incomplete from an earlier run, replaced" % name)
        for child in os.listdir(dst):
            if child == MARKER:
                continue
            p = os.path.join(dst, child)
            if os.path.isdir(p) and not is_reparse(p):
                shutil.rmtree(p)
            else:
                os.remove(p)
        if os.environ.get("SOCOM_RESTORE_FAULT") == "after-delete":     # the test's seam, nothing else sets it
            raise SystemExit("restore: %s: fault injected after the deletion step (tests only)" % name)
    elif os.path.isdir(dst):
        os.rmdir(dst)                     # empty: the planted case
    os.makedirs(dst, exist_ok=True)
    with open(os.path.join(dst, MARKER), "w") as fh:
        fh.write("a restore of %s from %s is in flight; if this file is here, the copy did not finish\n"
                 % (name, fwd(src)))
    shutil.copytree(src, dst, dirs_exist_ok=True)
    why = check(name, dst, files, probe, size, sha, "tools/")
    if why:
        raise SystemExit("restore: after the copy, %s -- the entry keeps its %s marker; run again" % (why, MARKER))
    os.remove(os.path.join(dst, MARKER))
    print("restore: %s restored (%d files)" % (name, files))
print("restore: done; the toolchain is the fetch path's own -- run this script without the flag to fetch or --check it")
PY
  exit $?
fi

status=0
for entry in "${ENTRIES[@]}"; do
  IFS='|' read -r name version url sha top <<< "$entry"
  have="$(stamp_of "$name")"
  if [ "$have" = "$version" ]; then
    echo "bootstrap: $name $version present"
    continue
  fi
  if [ "$check_only" = 1 ]; then
    echo "bootstrap: $name wanted $version, have $have"
    status=1
    continue
  fi
  mkdir -p "$CACHE"
  archive="$CACHE/$(basename "$url")"
  if [ ! -f "$archive" ] || [ "$(sha256_of "$archive")" != "$sha" ]; then
    echo "bootstrap: fetching $name $version ($(basename "$url"))"
    rm -f "$archive"
    curl -sSL --fail --retry 3 -o "$archive.part" "$url"
    mv -f "$archive.part" "$archive"
  fi
  got="$(sha256_of "$archive")"
  if [ "$got" != "$sha" ]; then
    rm -f "$archive"
    echo "bootstrap: $name: sha256 mismatch -- wanted $sha, got $got. The download is deleted; nothing was installed." >&2
    exit 1
  fi
  echo "bootstrap: $name $version verified; extracting into tools/$name"
  # Extract straight into the final directory and write the version stamp LAST. There used to be an
  # extract-then-`mv` here, and on this machine `mv` refused to rename llvm-mingw's 9,314 files in a second working
  # tree ("Permission denied", destination absent, no reparse point and no read-only bit; PowerShell's Rename-Item
  # on the same path succeeded instantly) -- it stopped a fresh clone at its very first command. No rename, no
  # failure mode: an interrupted extraction leaves no stamp, `--check` reports the version missing, and the next run
  # redoes it from the cached, sha256-verified archive.
  rm -rf "$TOOLS/$name"
  "$py" - "$archive" "$TOOLS/$name" "$top" <<'PY'
import os, sys, zipfile
archive, dest, top = sys.argv[1], sys.argv[2], sys.argv[3]
with zipfile.ZipFile(archive) as z:
    for info in z.infolist():
        rel = info.filename
        if top:
            if not rel.startswith(top + "/"):
                continue
            rel = rel[len(top) + 1:]
        if not rel or rel.endswith("/"):
            continue
        if ".." in rel.split("/") or rel.startswith("/"):
            raise SystemExit(f"refusing archive member {info.filename!r}")
        out = os.path.join(dest, *rel.split("/"))
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with z.open(info) as src, open(out, "wb") as dst:
            dst.write(src.read())
PY
  printf '%s\n' "$version" > "$TOOLS/$name/.bootstrap-version"
done

if [ "$check_only" = 1 ]; then
  exit "$status"
fi
export PATH="$TOOLS/llvm-mingw/bin:$TOOLS/cmake/bin:$TOOLS/ninja:$PATH"
echo "bootstrap: $(clang --version | head -1)"
echo "bootstrap: $(cmake --version | head -1)"
echo "bootstrap: ninja $(ninja --version)"
