#!/usr/bin/env bash
# Task 8b Step 5 / packaging outline section 2 A: the portable folder. Assembles <out>/socom2/ from dist/ --
# socom2.exe, socom2_game.elf, the DLLs, the launcher, README.txt, LICENSES/, empty cards/ and logs/ -- and zips
# it. No registry, no admin; the user points the launcher at their ISO once. Usage:
#   scripts/make_portable.sh [--release] [out dir]   (default: dist/portable, dist-linux/portable on Linux;
#                                                     --release: dist-release/portable, dist-linux-release/portable)
# Sprint 9 Goal 2: the folder carries the import closure of socom2 and the launcher and nothing else
# (tools_py/portable_audit.py: closure, then an audit of what was assembled -- exit 4 on a finding), and
# SHA256SUMS is written beside the archive. Exit 2 = no build, 3 = an imported library is nowhere,
# 4 = the folder failed its import audit, 5 = the folder failed the leak check (Sprint 10 H6).
# Sprint 8 Goal 1 item 5: on Linux it assembles dist-linux/portable/socom2-linux/ instead -- the same three
# binaries with their executable bits, lib/ filled from ldd through scripts/portable_libs.py, and a .tar.gz
# instead of a zip. (Both branches' here-docs need column-0 terminators.)
# Sprint 10 Q7: the Linux branch takes its platform from MAKE_PORTABLE_SYSTEM (default `uname -s`) and its ldd
# from LDD, so tools_py/tests/test_make_portable_linux.py can drive it on the Windows host with a synthetic
# dist-linux/ and an ldd that answers for it; a real run sets neither. The interpreter is $PYTHON like
# everywhere else (scripts/python_env.sh) -- there was a second rule here, PYTHON3, and it disagreed.
# Sprint 16 R3a (R295): the release is two configurations (build.sh release, PS2X_RELEASE_KIND): the PLAYER exe with
# the debug UI and the probes compiled out in dist-release/, and the DEVELOPER exe with them in dist-release-dev/
# (DEVDIST; dist-linux-release-dev/ and LDEVDIST on Linux). `--release` packages both from one run when both exist --
# socom2-portable.zip from the player and socom2-developer.zip (socom2-linux.tar.gz / socom2-linux-developer.tar.gz)
# from the developer -- each folder through its own closure, audit and leak check, one SHA256SUMS line each, and one
# manifest naming both with a `kind` each; with no developer build it packages the player and says so. The ELF
# ships in both for now (its removal is issue #70). Without PowerShell (a Linux host driving the Windows branch,
# as tools_py/tests/test_make_portable.py does) the zip is written by Python's zipfile instead of Compress-Archive.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/python_env.sh"   # $PYTHON, resolved once for every script
socom_require_python make_portable
SUFFIX=""
if [ "${1:-}" = "--release" ]; then SUFFIX="-release"; shift; fi
AUDIT="$ROOT/tools_py/portable_audit.py"
PY="$PYTHON"
# Sprint 14 D5: <build dir>/manifest.json (dist/manifest.json by default; dist-linux/ on Linux) describes the archives
# this run made -- each one's name and sha256 and its runner's sha256 (Sprint 16 R3a: under "archives", with its kind;
# the first also at the top level), the commit, branch and time, and how many paths of the tree were uncommitted.
# tools_py/playtest_block.py writes docs/PLAYTEST.md's build block from it. A run removes the previous manifest
# before it starts and writes the new one LAST, only once the archives exist, so a failed packaging leaves no manifest
# and the block says NOT BUILT instead of naming the previous archive.
write_manifest() {   # <manifest> <kind> <archive> <runner exe> [<kind> <archive> <runner exe>]...
  local manifest="$1" apath kind archive exe first=1; shift
  # Captured first: a git failing inside the printf's $(...) would not trip set -e and would write "commit": "".
  local commit branch dirty
  commit="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" || commit=""
  branch="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)" || branch=""
  if [ -z "$commit" ] || [ -z "$branch" ]; then
    echo "make_portable: no commit from git rev-parse HEAD in $ROOT -- no manifest written" >&2
    return 1
  fi
  dirty="$(git -C "$ROOT" status --porcelain | wc -l | tr -d ' ')" \
    || { echo "make_portable: git status failed in $ROOT -- no manifest written" >&2; return 1; }
  # One object per archive; the first (the player on a release run) is also written at the top level, the shape
  # every reader of the one-archive manifest (tools_py/playtest_block.py, tools_py/sitting.py) already reads.
  local entries="" top="" sep=""
  while [ $# -ge 3 ]; do
    kind="$1" archive="$2" exe="$3"; shift 3
    [ -f "$archive" ] || { echo "make_portable: no archive at $archive -- no manifest written" >&2; return 1; }
    # forward slashes: an OUT given as C:\... would put backslashes (JSON escapes) into the file
    apath="${archive//\\//}"; case "$apath" in "$ROOT"/*) apath="${apath#"$ROOT"/}" ;; esac
    local k=(kind archive archive_path archive_sha256 exe exe_sha256)
    local v=("$kind" "$(basename "$archive")" "$apath" "$(sha256sum < "$archive" | cut -d' ' -f1)"
             "$(basename "$exe")" "$(sha256sum < "$exe" | cut -d' ' -f1)")
    local i one=""
    for i in 0 1 2 3 4 5; do
      [ "$first" = 1 ] && top+="$(printf '  "%s": "%s",' "${k[$i]}" "${v[$i]}")"$'\n'
      one+="$(printf '%s"%s": "%s"' "${one:+, }" "${k[$i]}" "${v[$i]}")"
    done
    entries+="$sep    {$one}"; sep=$',\n'; first=0
  done
  {
    printf '{\n%s' "$top"
    printf '  "archives": [\n%s\n  ],\n' "$entries"
    printf '  "commit": "%s",\n' "$commit"
    printf '  "branch": "%s",\n' "$branch"
    printf '  "built_at": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '  "tree_dirty": %s\n' "$dirty"
    printf '}\n'
  } > "$manifest.tmp"
  mv -f "$manifest.tmp" "$manifest"
  echo "manifest: $manifest"
}
# A --release run packages the player build and, when it exists, the developer build beside it; a plain run packages
# the developer tree (dist/, dist-linux/: the debug UI and the probes are in it), recorded as kind "developer".
TOPKIND="developer"; [ -n "$SUFFIX" ] && TOPKIND="player"
no_developer_build() {   # <the folder that was looked for> <the build script>
  echo "make_portable: no developer build in $1 -- packaging the player archive only" \
       "(PS2X_RELEASE_KIND=developer $2 release makes it)"
}

package_linux() {   # <build dir> <out dir> <folder name>: assembles <out>/<folder>/ and <out>/<folder>.tar.gz
  local ldist="$1" out="$2" name="$3" pkg="$2/$3" f so nlibs ldd_out missing
  if [ ! -f "$ldist/socom2_game.elf" ] && [ -f "$DIST/socom2_game.elf" ]; then
    cp "$DIST/socom2_game.elf" "$ldist/socom2_game.elf"
  fi
  for f in socom2 socom2_game.elf socom_unzipped_launcher; do
    [ -f "$ldist/$f" ] || { echo "make_portable: $ldist/$f missing -- run scripts/build_linux.sh first${SUFFIX:+ (or scripts/build_linux.sh release)}" >&2; exit 2; }
  done
  rm -rf "${out:?}/${name:?}"
  mkdir -p "$pkg/lib" "$pkg/cards" "$pkg/logs" "$pkg/LICENSES"
  # -p keeps the executable bits; the tarball must unpack runnable.
  cp -p "$ldist/socom2" "$ldist/socom2_game.elf" "$ldist/socom_unzipped_launcher" "$pkg/"
  chmod +x "$pkg/socom2" "$pkg/socom_unzipped_launcher"
  # Sprint 9 Goal 1: the launcher's About page and its diagnostics zip read version.txt; until now nothing wrote it.
  printf 'SOCOM Unzipped %s (%s)\n' "$(git -C "$ROOT" describe --always --dirty 2>/dev/null || echo unknown)" "$(date -u +%Y-%m-%d)" > "$pkg/version.txt"
  # Every shared library the runner AND the launcher pull in, minus the host's own stack.
  # RPATH $ORIGIN/lib (set by CMake) is what finds these at run time.
  ldd_out="$("$LDD" "$ldist/socom2"; "$LDD" "$ldist/socom_unzipped_launcher")"
  if missing="$(printf '%s\n' "$ldd_out" | "$PY" "$ROOT/scripts/portable_libs.py" --missing)"; then
    :
  else
    echo "make_portable: ldd cannot resolve these libraries for $ldist -- install them and rebuild:" >&2
    printf '  %s\n' $missing >&2
    exit 3
  fi
  # The executables are the roots of the walk: a library is carried only when they reach it through
  # libraries we carry ourselves (ldd's flat list also names what only a host library needs -- libXau).
  # (tr: a Windows python prints CRLF, and the test drives this branch there -- as the Windows branch's NEEDED.)
  printf '%s\n' "$ldd_out" | "$PY" "$ROOT/scripts/portable_libs.py" \
    "$ldist/socom2" "$ldist/socom_unzipped_launcher" | tr -d '\r' > "$out/.libs.txt"
  while read -r so; do
    [ -n "$so" ] || continue
    cp -L "$so" "$pkg/lib/"
  done < "$out/.libs.txt"
  nlibs="$(ls "$pkg/lib" | wc -l)"
  rm -f "${out:?}/.libs.txt"
  # Sprint 10 H5: the inventory is THIRD_PARTY_NOTICES.md at the root (tools_py/tests/test_third_party_notices.py keeps
  # it complete) and the licence texts are LICENSES/<SPDX id>.txt; both ship as they are.
  cp "$ROOT/THIRD_PARTY_NOTICES.md" "$pkg/"
  cp "$ROOT"/LICENSES/*.txt "$pkg/LICENSES/"
  cat > "$pkg/README.txt" <<'RD'
SOCOM Unzipped -- SOCOM II: U.S. Navy SEALs on PC (Linux)

1. Open a terminal in this folder and run ./socom_unzipped_launcher
2. Point it at your SOCOM II ISO (NTSC, SCUS-97275 r0001). The launcher checks the disc and says so.
3. Pick the video size and quality, plug in a controller (the test area shows what the game will see), press Launch.

What your machine must already have: a working OpenGL driver (the distribution's mesa or the vendor's),
PulseAudio or ALSA for sound, and the distribution's libstdc++ (every desktop distribution ships it; shipping
our own would break your GL driver). Everything else the game needs is in lib/ next to the binaries.
Optional: zenity for the launcher's file picker -- without it, type the ISO path into the field.

Online: enter the server address in the launcher's Online panel; your profile name picks the memory card
directory under cards/. Logs land in logs/ -- send the newest run_*.log with any report.
Nothing is installed and nothing is written outside this folder; delete the folder to remove it.
RD
  "$PY" "$AUDIT" audit "$pkg" --system Linux || { echo "make_portable: the assembled folder $pkg failed its audit" >&2; exit 4; }
  ( cd "$ROOT" && "$PY" -m tools_py.release.leakcheck artifact "$pkg" ) \
    || { echo "make_portable: the assembled folder $pkg failed the leak check (exit $?) -- nothing archived" >&2; exit 5; }
  rm -f "${out:?}/${name:?}.tar.gz"
  # (from inside OUT: a drive-letter path after -f reads as a remote host to GNU tar on the Windows host.)
  ( cd "$out" && tar -czf "$name.tar.gz" "$name" )
  echo "portable folder: $pkg ($(ls "$pkg" | wc -l) entries, $nlibs libraries in lib/), tarball: $out/$name.tar.gz ($(wc -c < "$out/$name.tar.gz") bytes)"
}

package_windows() {   # <build dir> <out dir> <folder name> <zip name>: assembles <out>/<folder>/ and zips it
  local dist="$1" out="$2" name="$3" zip="$4" pkg="$2/$3" f needed
  for f in socom2.exe socom2_game.elf socom_unzipped_launcher.exe; do
    [ -f "$dist/$f" ] || { echo "make_portable: $dist/$f missing -- run ./build.sh runtime first${SUFFIX:+ (or ./build.sh release)}" >&2; exit 2; }
  done
  rm -rf "${out:?}/${name:?}"
  mkdir -p "$pkg/cards" "$pkg/logs" "$pkg/LICENSES"
  cp "$dist/socom2.exe" "$dist/socom2_game.elf" "$dist/socom_unzipped_launcher.exe" "$pkg/"
  # Sprint 9 Goal 2: only what the two executables reach through their import tables (16 of dist/'s 31 DLLs on
  # 2026-09-19 -- the rest is the FFmpeg zip's whole bin/ and a libwinpthread nothing imports).
  if needed="$("$PY" "$AUDIT" closure --system Windows --dir "$dist" "$dist/socom2.exe" "$dist/socom_unzipped_launcher.exe")"; then
    :
  else
    echo "make_portable: an imported library is neither in $dist nor part of Windows (see above)" >&2
    exit 3
  fi
  printf '%s\n' "$needed" | tr -d '\r' | while read -r dll; do
    [ -n "$dll" ] || continue
    cp "$dist/$dll" "$pkg/"
  done
  # Sprint 9 Goal 1: the launcher's About page and its diagnostics zip read version.txt; until now nothing wrote it.
  printf 'SOCOM Unzipped %s (%s)\n' "$(git -C "$ROOT" describe --always --dirty 2>/dev/null || echo unknown)" "$(date -u +%Y-%m-%d)" > "$pkg/version.txt"
  # Sprint 10 H5: the inventory is THIRD_PARTY_NOTICES.md at the root (tools_py/tests/test_third_party_notices.py keeps
  # it complete) and the licence texts are LICENSES/<SPDX id>.txt; both ship as they are.
  cp "$ROOT/THIRD_PARTY_NOTICES.md" "$pkg/"
  cp "$ROOT"/LICENSES/*.txt "$pkg/LICENSES/"
  cat > "$pkg/README.txt" <<'RD'
SOCOM Unzipped -- SOCOM II: U.S. Navy SEALs on PC

1. Run socom_unzipped_launcher.exe.
2. Point it at your SOCOM II ISO (NTSC, SCUS-97275 r0001). The launcher checks the disc and says so.
3. Pick the video size and quality, plug in a controller (the test area shows what the game will see), press Launch.

Online: enter the server address in the launcher's Online panel; your profile name picks the memory card
directory under cards/. Logs land in logs/ -- send the newest run_*.log with any report.
Everything lives in this folder; delete it to uninstall.
RD
  "$PY" "$AUDIT" audit "$pkg" --system Windows || { echo "make_portable: the assembled folder $pkg failed its audit" >&2; exit 4; }
  ( cd "$ROOT" && "$PY" -m tools_py.release.leakcheck artifact "$pkg" ) \
    || { echo "make_portable: the assembled folder $pkg failed the leak check (exit $?) -- nothing archived" >&2; exit 5; }
  rm -f "${out:?}/${zip:?}"
  if command -v powershell >/dev/null 2>&1; then
    ( cd "$out" && powershell -NoProfile -Command "Compress-Archive -Path '$name' -DestinationPath '$zip' -Force" )
  else
    ( cd "$out" && "$PY" -m zipfile -c "$zip" "$name" )
  fi
  echo "portable folder: $pkg ($(ls "$pkg" | wc -l) entries), zip: $out/$zip ($(wc -c < "$out/$zip") bytes)"
}

case "${MAKE_PORTABLE_SYSTEM:-$(uname -s)}" in
  Linux)
    LDD="${LDD:-ldd}"
    # Sprint 8 Goal 1 item 5: the same folder as a tarball. dist-linux/ holds the native build;
    # socom2_game.elf is platform-neutral, so take dist/'s copy when only Windows has built it.
    DIST="${DIST:-$ROOT/dist}"
    LDIST="${LDIST:-$ROOT/dist-linux$SUFFIX}"
    LDEVDIST="${LDEVDIST:-$ROOT/dist-linux-release-dev}"
    OUT="${1:-$LDIST/portable}"
    MANIFEST="$LDIST/manifest.json"
    mkdir -p "$LDIST" "$OUT"
    rm -f "$MANIFEST" "$MANIFEST.tmp" "$OUT/SHA256SUMS"
    command -v "$LDD" >/dev/null || { echo "make_portable: ldd not found" >&2; exit 2; }
    package_linux "$LDIST" "$OUT" socom2-linux
    ARCHIVES=("$TOPKIND" "$OUT/socom2-linux.tar.gz" "$LDIST/socom2")
    NAMES=(socom2-linux.tar.gz)
    if [ -n "$SUFFIX" ]; then
      if [ -f "$LDEVDIST/socom2" ]; then
        package_linux "$LDEVDIST" "$OUT" socom2-linux-developer
        ARCHIVES+=(developer "$OUT/socom2-linux-developer.tar.gz" "$LDEVDIST/socom2")
        NAMES+=(socom2-linux-developer.tar.gz)
      else
        no_developer_build "$LDEVDIST" "scripts/build_linux.sh"
        rm -rf "${OUT:?}/socom2-linux-developer" "${OUT:?}/socom2-linux-developer.tar.gz"   # never a previous run's
      fi
    fi
    "$PY" "$AUDIT" sha256sums "$OUT" "${NAMES[@]}" >/dev/null
    echo "archives: ${NAMES[*]} in $OUT, $OUT/SHA256SUMS"
    write_manifest "$MANIFEST" "${ARCHIVES[@]}"
    ;;
  *)
    DIST="${DIST:-$ROOT/dist$SUFFIX}"
    DEVDIST="${DEVDIST:-$ROOT/dist-release-dev}"
    OUT="${1:-$ROOT/dist$SUFFIX/portable}"
    MANIFEST="$DIST/manifest.json"
    mkdir -p "$OUT"
    rm -f "$MANIFEST" "$MANIFEST.tmp" "$OUT/SHA256SUMS"
    package_windows "$DIST" "$OUT" socom2 socom2-portable.zip
    ARCHIVES=("$TOPKIND" "$OUT/socom2-portable.zip" "$DIST/socom2.exe")
    NAMES=(socom2-portable.zip)
    if [ -n "$SUFFIX" ]; then
      if [ -f "$DEVDIST/socom2.exe" ]; then
        package_windows "$DEVDIST" "$OUT" socom2-developer socom2-developer.zip
        ARCHIVES+=(developer "$OUT/socom2-developer.zip" "$DEVDIST/socom2.exe")
        NAMES+=(socom2-developer.zip)
      else
        no_developer_build "$DEVDIST" "./build.sh"
        rm -rf "${OUT:?}/socom2-developer" "${OUT:?}/socom2-developer.zip"   # never a previous run's beside SHA256SUMS
      fi
    fi
    "$PY" "$AUDIT" sha256sums "$OUT" "${NAMES[@]}" >/dev/null
    echo "archives: ${NAMES[*]} in $OUT, $OUT/SHA256SUMS"
    write_manifest "$MANIFEST" "${ARCHIVES[@]}"
    ;;
esac
