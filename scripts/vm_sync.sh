#!/usr/bin/env bash
# Sprint 8 Goal 1: sync the tree (and, on request, the generated code and the ISO) into the socom-linux VM over SSH.
# The host has no rsync, so the tree travels as a tar stream; the generated code likewise; the ISO by scp once.
#   scripts/vm_sync.sh tree        # the repository minus build dirs, logs, vm/, dist*/ (a few seconds)
#                                  # ... and it deletes: what the host no longer has goes from the guest too
#                                  # (tools_py/vm_prune.py), or a moved file keeps shadowing its new home.
#   scripts/vm_sync.sh generated   # recomp/output (576 MB, 14,882 files; once, or after a re-recomp)
#   scripts/vm_sync.sh iso <path>  # the ISO to ~/socom2.iso (4 GB, once)
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/python_env.sh"   # $PYTHON, resolved once for every script
socom_require_python vm_sync
cd "$ROOT"
KEY="$ROOT/vm/keys/socom_linux"
SSH="ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -p 2222 socom@127.0.0.1"
case "${1:-tree}" in
  tree)
    # Sprint 9 Goal 2: tar carries the HOST's mtimes, so a file edited before the guest's last build but
    # synced after it arrives looking older than the object ninja built from its previous content -- and
    # ninja skips it (the VM linked a launcher whose pad_render.cpp.o held the old ui::drawPad signature
    # and the link failed on a symbol the source no longer has). Content is what the two machines agree
    # on: an md5 listing before and after the untar says what really changed, and that is touched below.
    MD5_LIST='cd ~/socom_pc 2>/dev/null && find third_party/ps2recomp tools_py scripts src -type d \( -name "build-*" -o -name "_deps" -o -name "__pycache__" \) -prune -o -type f -print0 2>/dev/null | xargs -0 md5sum 2>/dev/null'
    $SSH 'mkdir -p ~/socom_pc' &&
    $SSH "$MD5_LIST" > "$ROOT/vm/.sync_before.md5" &&
    tar --exclude=./third_party/ps2recomp/build-clang --exclude=./third_party/ps2recomp/build-tools \
        --exclude=./vm --exclude=./logs --exclude=./dist --exclude=./dist-linux --exclude=./recomp/output \
        --exclude=./dist-release --exclude=./dist-linux-release \
        --exclude=./dist-release-dev --exclude=./dist-linux-release-dev \
        --exclude=./third_party/ps2recomp/build-linux --exclude=./third_party/ps2recomp/build-linux-release \
        --exclude=./third_party/ps2recomp/build-linux-release-dev \
        --exclude=./tools/llvm-mingw --exclude=./tools/cmake --exclude=./tools/ninja --exclude=./tools/pcsx2 \
        --exclude=./server/config/simulated.db --exclude='./server/*/bin' --exclude='./server/*/obj' \
        --exclude=./research --exclude=./node_modules --exclude='*.wav' --exclude='*.iso' \
        -czf - . | $SSH 'tar -xzf - -C ~/socom_pc' && echo "tree synced" &&
    $SSH "$MD5_LIST" > "$ROOT/vm/.sync_after.md5" &&
    "$PYTHON" -m tools_py.vm_restamp "$ROOT/vm/.sync_before.md5" < "$ROOT/vm/.sync_after.md5" > "$ROOT/vm/.restamp_list" &&
    { [ ! -s "$ROOT/vm/.restamp_list" ] || { tr '\n' '\0' < "$ROOT/vm/.restamp_list" | $SSH 'cd ~/socom_pc && xargs -0 touch --' && echo "re-stamped $(wc -l < "$ROOT/vm/.restamp_list") changed guest files"; }; } &&
    # Sprint 9: the untar never deleted, so a `git mv` left the old file in the guest (a stale header shadowed
    # the moved one and broke the VM build). Prune what the host no longer has, under the synced roots.
    # Sprint 11 Task 18: docs/ was not one of those roots, so when fourteen documents moved into docs/archive/
    # the guest kept both copies and tools_py.docmaint failed there on every duplicate. The roots are
    # tools_py/vm_prune.py's ROOTS -- keep the two lists in step (tools_py/tests/test_vm_prune.py checks).
    # The decision is entirely vm_prune's: it compares this listing against the host's `git ls-files` and the
    # host's own walk, and prints the paths to remove. The count it removed is printed below.
    $SSH 'cd ~/socom_pc && find third_party/ps2recomp/ps2xLauncher third_party/ps2recomp/ps2xShared third_party/ps2recomp/ps2xRuntime third_party/ps2recomp/ps2xTest third_party/ps2recomp/ps2xIOP tools_py scripts docs tests ghidra_scripts -type d \( -name "__pycache__" -o -name "_deps" \) -prune -o -type f -print 2>/dev/null' \
      | "$PYTHON" -m tools_py.vm_prune "$ROOT" > "$ROOT/vm/.prune_list" &&
    { [ ! -s "$ROOT/vm/.prune_list" ] || { tr '\n' '\0' < "$ROOT/vm/.prune_list" | $SSH 'cd ~/socom_pc && xargs -0 rm -f --' && echo "pruned $(wc -l < "$ROOT/vm/.prune_list") stale guest files"; }; } ;;
  generated)
    $SSH 'mkdir -p ~/socom_pc/recomp/output' &&
    tar -C recomp -czf - output | $SSH 'tar -xzf - -C ~/socom_pc/recomp' && $SSH 'ls ~/socom_pc/recomp/output | wc -l' ;;
  iso)
    scp -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -P 2222 "$2" socom@127.0.0.1:~/socom2.iso && echo "iso copied" ;;
  ssh) shift; $SSH "$@" ;;
  *) echo "usage: vm_sync.sh tree|generated|iso <path>|ssh <cmd>" >&2; exit 2 ;;
esac
