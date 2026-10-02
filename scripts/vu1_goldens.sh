#!/usr/bin/env bash
# The VU1 replay goldens (build.sh's test step, runs 1-9), as one script any platform's build runs with its own
# vu1_replay binary: bash scripts/vu1_goldens.sh <vu1_replay>. macOS port, phase 1: build_macos.sh calls this;
# build.sh keeps its inline copy for now (its Python test copies build.sh alone into a temp tree).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VU1="${1:?usage: vu1_goldens.sh <vu1_replay>}"
mkdir -p "$ROOT/logs"
# Four verify runs over the two fixture sets, then the two host-draw checks. The native registry is ON by default
# (kVu1NativeDefault), so the path a run takes has to be selected explicitly: --no-native forces
# the generated/interpreted path, --native forces the registry. Both flags must follow the golden
# path -- --verify consumes the next argument. Every run prints
# "[vu1_replay] native entered=.. ended=.. handbacks=..", which says which path actually ran.
#
#   1-2 (--no-native): the generated/interpreted path over both sets; both report entered=0.
#   3   (--native):    the title set enters at pc 0, which no native program claims, so it is a
#                      no-op for the registry and also reports entered=0 -- this line is a
#                      regression check that the native programs do NOT intercept the title set,
#                      not native coverage.
#   Runs 3-5 pass --regs all (runs 8-9 always did): without it --verify compares only end pc,
#   data memory and the packets, so a native program that got a register right in the packet and
#   wrong in the file would pass. The goldens were taken on the interpreted path, so this is the
#   check that the native path reproduces the whole register file, not just what it kicked.
#   4   (--native):    the 0x1b50 dispatcher set is the one with native coverage; it reports a
#                      non-zero entered=.. (entered = ended + handbacks) and must still match the
#                      same golden packets and registers as run 2.
"$VU1" --verify "$ROOT/tests/fixtures/vu1/title/golden.txt" --no-native "$ROOT"/tests/fixtures/vu1/title/*.bin
"$VU1" --verify "$ROOT/tests/fixtures/vu1/dispatch_0x1b50/golden.txt" --no-native "$ROOT"/tests/fixtures/vu1/dispatch_0x1b50/*.bin
"$VU1" --verify "$ROOT/tests/fixtures/vu1/title/golden.txt" --native --regs all "$ROOT"/tests/fixtures/vu1/title/*.bin
"$VU1" --verify "$ROOT/tests/fixtures/vu1/dispatch_0x1b50/golden.txt" --native --regs all "$ROOT"/tests/fixtures/vu1/dispatch_0x1b50/*.bin
# 5: the same set with PS2X_VU1_HOST_DRAW=1 (command 0x28 draws through GS::submitHostTriangle
#    instead of kicking its packet). There are no packets to compare then, so this run checks end
#    pc, VU data memory and the register file -- the knob must not change any of them.
"$VU1" --verify "$ROOT/tests/fixtures/vu1/dispatch_0x1b50/golden.txt" --native --host-draw --regs all "$ROOT"/tests/fixtures/vu1/dispatch_0x1b50/*.bin
# 6: and what the two paths actually draw, pixel for pixel, into a 640x448 framebuffer. The host
#    path keeps the sub-1/16-pixel fraction the GIF path truncates, so edge and gouraud-rounding
#    pixels differ by design; anything past the tolerance means a wrong lane or a wrong context.
#    The score is hard / drawn, NOT differing / whole frame: these dumps paint 26..3291 pixels of
#    a 286720-pixel frame, so a frame-relative score tops out at 0.32% here and could not fail at
#    1% however wrong the drawing was (measured: forcing the host path +8 px in x leaves 9 of the
#    10 dumps that existed then at 0.0000-0.2570% of frame).
#    "hard" excludes the two differences the two paths produce by design, both measured on this
#    fixture set rather than assumed. Each has an opaque form and a form that only appears once
#    the draw is blended or the seam is interior (Sprint 4 task 3 widened both; before that,
#    vu1dump4_prog_182 scored 1.488% and was held out of this set):
#      - rounding: max channel delta <= 1 -- one step of gouraud interpolation -- which is
#        174/179, 897/922, 67/69 and 63/66 of those dumps' differing pixels. Plus, on a dump
#        whose kicked packets set PRIM.ABE and only where BOTH passes drew the pixel, max channel
#        delta <= 2: the blend turns that one source step into two destination steps (the
#        measured cases are alpha 127 against 128). Gated on ABE because on an opaque draw a
#        delta of 2 is a real difference -- though note that every dump in this corpus kicks
#        PRIM 0x7b (prog_31: 0x4b), i.e. ABE = 1, so the gate does not discriminate here yet.
#      - edge: a differing pixel whose 3x3 neighbourhood is not uniformly drawn in one of the two
#        renderings, i.e. sub-pixel coverage at a triangle edge (delta 127/128 = drawn vs blank).
#        Plus the interior form of the same thing: a colour seam between two adjacent triangles
#        that sits one pixel over with both sides drawn, so the 3x3 is uniformly drawn and no
#        coverage boundary fires. It is recognised as each rendering's colour at the pixel
#        appearing within 2 on a DRAWN pixel of the other rendering's eight neighbours, in both
#        directions (a seam that moved swaps the two sides' colours) and never the centre pixel
#        (matching the centre would silently mean "delta <= 2 is always fine"). That clause is
#        BUDGETED at 1% of drawn and reported as seam=N on the VRAMDIFF line: a real seam is a
#        few pixels along one edge, but a UNIFORM one-pixel offset of the whole drawing
#        satisfies it EVERYWHERE, so past the budget every pixel it accepted goes back to hard
#        and the line says OVER-BUDGET. On a clean build the clause is used on three dumps only
#        -- 4 px on prog_11 (0.12%), 3 on prog_177 (0.24%), 3 on prog_182 (0.50%) -- so the
#        thinnest margin to the budget is 2x. Thin, and deliberately visible.
#    What is left on a clean build is 0 on all fifteen dumps. Sensitivity, measured by shifting
#    the host path inside the hook (dumps over the 1% tolerance, of fifteen, and their range):
#        +1 px x   8 fail, 1.64-11.65%        +1 px y   6 fail, 1.42-16.74%
#        +2 px x   7 fail, 1.64-19.01%        +8 px x   9 fail, 7.07-55.48%
#    The six that never fail are the six whose host path the hook never takes -- their two
#    renderings are already bit-identical -- so no offset can move them. The +8 px column is
#    within 0.7 points of what the pre-widening buckets score on the same renders (7.07-56.19%).
#    Read the +-1 px column as the reason the budget exists: WITHOUT it, the seam clause scores
#    those same +-1 px renders at 0.00-0.08% and fails NOTHING, and the +8 px experiment alone
#    would never have shown that -- a systematic one-pixel offset (a wrong XYOFFSET constant, an
#    off-by-one in the >>4 truncation, a wrong lane feeding x) would have been invisible
#    corpus-wide. If either bucket is widened again, re-measure +-1 px FIRST: it is the tightest
#    of these by an order of magnitude. Dropped geometry, colour errors of 4 steps or more and
#    shifts of 3 px and up are not close calls -- they fail by 7x-84x either way.
#
#    Family C (vu1dump4_prog_165 over B, prog_177 and prog_252 over A) used to SKIP here: its
#    0x64 / 0x30 / 0x32 render-state packets point TEX0 at a texture the dump does not carry, so
#    every texel read back 0 and the ALPHA_1 = 0x44 those packets also set -- (Cs - Cd) * As + Cd
#    with As = 0 -- left the framebuffer untouched. vu1_replay now fills VRAM outside the frame
#    and z buffers with 0x80808080 (so any TEX0 samples a neutral texel, the same identity
#    MODULATE family A already got from its parked 1x1) and gives the z buffer its own pages
#    (those packets also switch TEST from ALWAYS to GEQUAL). vu1dump3_prog_31 is the fourth
#    family, whose 0x40 draws through the host hook with an untextured PRIM 0x4B.
#    vu1dump4_prog_182 (the fourth C-over-A dump in the corpus) is in this set as of Sprint 4
#    task 3. It used to score 1.488% because both by-design buckets were calibrated on opaque,
#    edge-only differences: 6 of its 9 hard pixels were the blend-amplified delta-2 class and 3
#    were interior seams at 8, 12 and 14 steps. Note for whoever calibrates the buckets again:
#    the delta-2 class is partly an artifact of this synthetic context, not of the game's blend
#    alone, because Cd = 0 on a first write and the neutral texel's At = 128 reduce
#    (Cs - Cd) * As + Cd to Cv * Av >> 7.
#    Still a known gap: a patterned rather than uniform neutral fill, which is what a uniform
#    texel cannot cover -- any ST/UV/Q divergence between the two paths is invisible against a
#    constant texture.
#    The run also has to be read, not just exited: vu1_replay warns on stderr when a fixture's
#    TEX0 resolves below the zeroed framebuffer/z region (see warnIfTextureInBlankRegion), which
#    degrades that dump's comparison silently -- it can go back to drawing nothing and SKIPping,
#    which is the one failure mode --vram-diff cannot score. Nothing in the fixture set trips it
#    today, so the check below costs nothing now and turns that into a hard stop the day a
#    fixture's texture lands in the blank region. Same shape as expect_native: capture, print,
#    then assert on the output rather than trusting the exit code alone.
vram_diff_check() {
  local out status=0
  out="$("$@" 2>&1)" || status=$?
  printf '%s\n' "$out"
  if [ "$status" -ne 0 ]; then
    echo "vram diff: FAILED (exit $status)" >&2
    return "$status"
  fi
  if printf '%s\n' "$out" | grep -qF '[vu1_replay] WARNING'; then
    printf '%s\n' "$out" | grep -F '[vu1_replay] WARNING' >&2
    cat >&2 <<'MSG'
vram diff: the dump named above has a TEX0 that resolves below the zeroed framebuffer/z region,
so it samples 0 and that dump's GIF-vs-host comparison is degraded -- at the limit it draws
nothing and SKIPs, which is exactly the blank-frame hole this check exists to keep closed.
Fix the layout, not this assertion: revisit setupReplayGsContext in
third_party/ps2recomp/ps2xRuntime/src/tools/vu1_replay.cpp and move the replay framebuffer and z
buffer (kZBufferPage / kBlankBytes, and kTextureBlock with them, which the static_assert ties
together) so that the fixture's texture lands in the neutral fill above them.
MSG
    return 1
  fi
}
vram_diff_check "$VU1" --vram-diff "$ROOT/logs/vramdiff_fixtures" "$ROOT"/tests/fixtures/vu1/dispatch_0x1b50/*.bin
# 7: the work-ceiling refusal path. tests/fixtures/vu1/clamp holds vu1dump4_prog_11 with TOP+2.z
#    rewritten from 76 to 300 -- above kMaxVertices -- and a golden taken from the microcode path
#    on that patched dump (which runs 5.6M cycles to produce nothing, i.e. exactly the runaway
#    the ceiling exists to stop). The native path must refuse it: this run has to report
#    "entered=1 ended=0 handbacks=1" and still match end pc, VU data memory and every register.
#    Regenerate with:
#      python -m tools_py.vu1_headers --set-vertices 300 --out tests/fixtures/vu1/clamp \
#          tests/fixtures/vu1/dispatch_0x1b50/vu1dump4_prog_11.bin
#      PS2X_VU1_FAST=0 PS2X_VU1_GEN=0 dist/vu1_replay.exe --batch tests/fixtures/vu1/clamp \
#          --no-native tests/fixtures/vu1/clamp/*.bin     # then state.txt -> golden.txt
"$VU1" --verify "$ROOT/tests/fixtures/vu1/clamp/golden.txt" --native --regs all "$ROOT"/tests/fixtures/vu1/clamp/*.bin
# 8-9: the per-handler clamps. Run 7 exercises the PRE-SCAN's ceiling -- a header above it is
#    refused whole at 0x1b50 and no handler is ever entered -- so it says nothing about the
#    clamps inside the handlers. Those cannot be reached with data at all: the pre-scan reads
#    the same two header words first, and vi10 is bounded by the clipper that produces it. They
#    are reached instead with the two test-only ceiling overrides, which lower the HANDLER-side
#    ceilings and leave the pre-scan's real constants alone (socom2_dispatch_0x1b50.cpp:
#    vertexCeiling / triangleCeiling / clippedVertexCeiling). Nothing in the game sets either.
#
#    Both runs check against run 4's own unmodified golden, with no new fixture bytes, because
#    that is the whole claim: a clamp hand-back has to leave exactly the state the microcode then
#    finishes the list from, so the end state must be the microcode's to the last register.
#
#    8: PS2X_VU1_NATIVE_TEST_CEILING=2 trips cmdUnpackVertices' clamp at 0x0b28 (TOP+2.z is 8..76
#       across the set) on the FIRST command of all fifteen lists, fourteen of which start
#       68 and one (the fourth family) 70, whose 0x0cb8 unpack clamps on the same count.
#    9: PS2X_VU1_NATIVE_TEST_CLIP_CEILING=2 leaves every family-A count alone and trips
#       cmdClippedTransform's clamp at 0x0f38 (vi10) MID-LIST on the six lists that contain
#       family-B commands -- after 68/06/02 have run and the clipper has written qwords 40-111,
#       112 and 329.z and left vi8/vi10/vi12/vi15 live. That is the hand-back research/13 6.3
#       calls the inside of an indivisible unit, and the one this file's whole-state
#       reproduction is what makes safe; the other nine (family A, C-over-A and the fourth
#       family) still run to
#       their E bit, which is what makes the run a two-sided check rather than a blanket refusal.
expect_native() { # $1 = the exact counts to require, then the command
  local want="$1"; shift
  local out
  out="$("$@" 2>&1)"
  printf '%s\n' "$out" | grep -E 'native entered|PASS|FAIL' || true
  if ! printf '%s\n' "$out" | grep -q "\[vu1_replay\] native $want"; then
    printf 'clamp check: expected "native %s", got: %s\n' \
      "$want" "$(printf '%s\n' "$out" | grep 'native entered')" >&2
    return 1
  fi
  printf '%s\n' "$out" | grep -q '^PASS' || { echo "clamp check: verify did not PASS" >&2; return 1; }
}
expect_native "entered=15 ended=0 handbacks=15" \
  env PS2X_VU1_NATIVE_TEST_CEILING=2 "$VU1" \
    --verify "$ROOT/tests/fixtures/vu1/dispatch_0x1b50/golden.txt" --native --regs all \
    "$ROOT"/tests/fixtures/vu1/dispatch_0x1b50/*.bin
expect_native "entered=15 ended=9 handbacks=6" \
  env PS2X_VU1_NATIVE_TEST_CLIP_CEILING=2 "$VU1" \
    --verify "$ROOT/tests/fixtures/vu1/dispatch_0x1b50/golden.txt" --native --regs all \
    "$ROOT"/tests/fixtures/vu1/dispatch_0x1b50/*.bin
echo "vu1 goldens: ok"
