// SOCOM II VU1 image d418194495c25213, entry pc 0x1b50: the command dispatcher and the handlers
// its "family A" (UI quad / 2D), "family B" (clipped world objects) and "family C" (either of
// those plus an inline GIF block and a second draw pass) command lists use.
//
// Structure, command encoding, register roles and the hand-back rules: docs/research/12-vu1-entry0-ui-path.md
// section (f) for family A, docs/research/13-vu1-family-b-world-objects.md for families B and C,
// the 0x3618 clipper and the shared packet-flush tail. Contract: emit exactly the GIF packets the
// microcode emits and leave the register file and VU data memory exactly as the microcode leaves
// them (verified by `vu1_replay --verify --native`, --regs all).
//
// Sprint-2 addition: PS2X_VU1_HOST_DRAW=1 makes command 0x28 draw each assembled triangle through
// GS::submitHostTriangle instead of XGKICKing its packet (see submitHostTriangleFromPacket). The
// packet is still assembled byte for byte, so the contract above is unchanged with the knob on --
// only the kick is replaced. `vu1_replay --vram-diff` compares the two renderings pixel for pixel.
// The hook falls back to the real kick for anything it cannot reproduce exactly, which now
// includes two cases the GIF path handles differently rather than not at all: a PRIM with FST set
// (UV in texel units, where the hook feeds S/T/Q) and a vertex whose FTOI4 X or Y word is outside
// 0..65535, which PACKED XYZF2 wraps at 16 bits and the host path's float would not.
//
// What runs natively: command lists whose decode from data qword 340 contains only command words
// this file implements and terminates on 0x42 (END) -- all seven family-A commands, all seven
// family-B ones (0x02, 0x0a, 0x12, 0x56, 0x1a, 0x2a, 0x4c, with the 0x3618 clipper and the 0x1980
// flush tail behind them), all six of family C's (0x64, 0x72, 0x74, 0x30, 0x32, 0x34) and, of the
// fourth family, 0x70 and 0x40 (research/15) -- which makes its two drawing shapes
// `70 06 08 40 42` and `70 08 40 42` fully native. "Decode" is
// not "linear decode" any more: 0x30 and 0x32 embed eight-qword GIF packets in the list itself and
// 0x34 an eleven-qword one, and all three advance vi14 past them, so the pre-scan applies that
// rewrite as it walks (scanCommandList).
//
// Two command words are still missing at 0x1b50, and a list containing either of them hands back
// WHOLE there before this file touches any state, so the generated microcode translation runs it
// exactly as before. Over the 166-run dispatcher corpus that residual is four programs:
//   * 0x52 (0x3100) and 0x66 (0x2e28), the skinning half of the fourth family, four programs.
//     Both are scope decisions with reasons, not gaps waiting to be filled -- see
//     isFamilyDCommand.
//
// Sprint 17 F N1 (docs/research/82): a second entry, 0x33c8, the MSCAL the EE issues after every
// 0x52 bone pass. With the previous chunk's flags (live-in vi5) marking the last bone it repacks
// the skinned staging array into the vertex block and resumes this dispatcher at 0x1b60 with the
// live-in vi14 -- the `66 08 40 42` tail of the `52 66 08 40 42` list -- so 0x66 has a handler
// here, admitted by that entry's pre-scan only (cmdFaceNormals). Otherwise the microcode branches
// to 0x3100 for another bone pass, which is refused whole as skin_pass. Behind
// PS2X_VU1_NATIVE_33C8 (Dev, default 0): off, the registry leaves the entry to the generated code.
//
// Within a family-A list the handlers are mutually independent (each re-derives its pointers from
// vi1). Family B is not: vi8 and vi10 (the clipped polygon and its vertex count, set inside
// 0x3618) cross every 0x02 -> 0x0a -> ... -> 0x2a edge, and vi12/vi15 (the primitive counter and
// the index cursor) cross the 0x4c back edge (research/13 6.2). That does not change the
// hand-back rule here, because this file reproduces the whole register file and all of VU data
// memory bit for bit: a command it cannot run hands back at 0x1b60 -- the pc at which the
// microcode reads the next command word -- and the microcode resumes from exact state. With every
// A and B command implemented that path is a safety net rather than a live one.
//
// An asymmetry in how the pre-scan treats that vi10: it requires 0x02 to have been walked before
// 0x2a, 0x4c or 0x32, but NOT before the four shims 0x0a, 0x12, 0x56 and 0x1a, which read vi10
// just as much. That is historical -- Task 5 added the requirement for the commands that end a
// primitive and Task 6 for 0x32, and this task made both order-based -- and it is left alone
// deliberately: on a list without 0x02 the shims are exactly what the microcode would run, on
// whatever vi10 the previous program left, and reproducing that is the contract. What was missing
// was a bound on the work, not a bound on the shape, and the vi10 clamps supply it: those loops
// exit on `> 0` or `!= 0` against a 16-bit register, so kMaxClippedVertices is what keeps a stale
// vi10 from being 65535 iterations. 0x2a and 0x4c keep their shape requirement because a stale
// vi10 there means a stale *packet* kicked at the GS, not just wasted work.
//
// Once a list is taken over it runs to its E bit: `budgetEnd` and `m_stopRequested` are ignored,
// because 0x1b60 is the only pc this program could legally stop at and stopping there buys
// nothing. That is only defensible while a list's work is bounded, and the counts that bound it
// (TOP+2.z vertices, TOP+2.w triangles, the latter also family B's primitive counter, plus 0x34's
// block count N) are guest
// data, not something the microcode validates -- a header with z = 32767 would mean ~11k
// template-fill iterations and up to 32767 uninterruptible XGKICKs. So the pre-scan checks them
// too, against a ceiling with plenty of margin over the corpus maxima: see kMaxVertices /
// kMaxTriangles. A header outside that range hands the list back whole, exactly like a family-C
// one.
//
// THE PER-HANDLER CLAMPS. The pre-scan's header check is not the only place those bounds are
// enforced. Every handler re-checks the count it is about to loop on, as its first statement,
// against kMaxVertices (TOP+2.z: 0x0b28, 0x0e08, 0x0f90, 0x05e0, 0x1458, 0x22b8, 0x26a8),
// kMaxTriangles (TOP+2.w: 0x1640, 0x17d0, 0x1f78) or kMaxClippedVertices (vi10: 0x0f38, 0x1120,
// 0x0650, 0x15d0, 0x1a98, 0x23d0). A violation hands the command back to the microcode at 0x1b60 with vi14 naming
// it again -- the same clean hand-back a command with no handler gets, which is why every clamp
// sits before its handler has written a register, stored a qword or kicked anything.
//   * For family A that is a hand-back research/12 already licenses at any command boundary.
//   * For family B the only boundary research/13 6.3 licenses outright is "immediately before
//     0x02 is dispatched", and that is exactly where the primitive-count clamp sits (0x1f78);
//     6.3 calls everything after it one indivisible unit for a program that reproduces only
//     vi1/vi14. So the clamps that sit *inside* a family-B list -- the vi10 ones -- are placed
//     ahead of their handler's first instruction and are unreachable on any accepted list:
//     vi10 comes from this file's own clipper, whose ping-pong buffers cap it at twelve, and the
//     pre-scan refuses a family-B list that could reach a shim without 0x02 having run. The
//     escape hatch the brief's other option would need -- finishing the primitive and stopping at
//     the 0x4c boundary -- is not taken, because 6.3 does not license that boundary either; the
//     list is refused before it starts instead (see the family-B clauses in isNativeRun).
//   * Commands 0x30, 0x32 and 0x34 check *both* their own per-vertex count and the count of the
//     draw handler they tail-jump into, at their own entry, because after their first XGKICK a
//     hand-back would replay the inline block. 0x32's and 0x34's checks are two-sided: their
//     per-vertex loops end on `!= 0`, so a count of zero is 65536 wrapping stores, and a 0x4c back
//     edge can reach a 0x32 with the zero the clipper's "clipped away entirely" path leaves.
//     0x34 additionally refuses any block count but 1 (cmdSphereMapBlock).
//
// On real data a clamp cannot fire, because the pre-scan reads the same two header words first
// and vi10 is bounded by the clipper that produced it. That is a property of the data, not of the
// code, so the clamps are exercised in `./build.sh test` through two TEST-ONLY environment knobs,
// PS2X_VU1_NATIVE_TEST_CEILING and PS2X_VU1_NATIVE_TEST_CLIP_CEILING, which lower the
// handler-side ceilings and leave the pre-scan's alone (see vertexCeiling / triangleCeiling /
// clippedVertexCeiling). Nothing in the game sets either, and both can only narrow.
//
// CAVEAT on any mid-list hand-back, clamp or otherwise: this file commits FMAC flags immediately
// (see commitFmacFlags) instead of queueing them for the interpreter's four-deep flag pipeline.
// At the E bit that is identical, because the interpreter flushes its queues in issue order. It
// is NOT identical at 0x1b60: the microcode resumes with m_state.mac holding the newest FMAC's
// flags, where hardware would still have an older entry in flight, so microcode whose next FMAND
// is within four pairs of the boundary would read a newer MAC than hardware. No handler in this
// image has an FMAND that close to 0x1b60 -- the only two are the cull's at 0x1718 and the
// clipper's pair inside 0x3ad0, all of them many pairs into their own command -- so the path is
// dead. It is stated because it is the one respect in which a hand-back from this file is not
// bit-exact, and a new handler could wake it.
//
// The program also requires the interpreter's default XGKICK model, which copies the whole packet
// at kick time. Under PS2X_VU1_XGKICK_CYCLE_EXACT=1 a kick streams as m_cycle advances and a new
// kick clears whatever is still in flight; this program never advances m_cycle, so command 0x28's
// back-to-back per-triangle kicks would silently drop packets. That mode therefore hands back
// whole as well.
//
// A consequence of never advancing m_cycle: a natively-run list consumes zero VU cycles, so to
// DMAC/VIF timing VU1 appears to finish instantaneously, and the cycles/s field of [vu1-stats]
// under-reports by whatever those lists would have cost on the microcode path.
#define private public
#include "../ps2_vu1_ops.h"
#undef private

#include "runtime/gs/gs_frontend.h"
#include "runtime/vu1_native_refusals.h"
#include "ps2x/knobs.h"

#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>

// ps2_vu1_core.cpp: XGKICKs whose packet this build decoded (the [vu1-stats] counter). The
// generated translation increments it at its L_0x1920; so does this program's command 0x28.
extern std::atomic<uint64_t> g_xgkickDecoded;

namespace
{
    // ---- dispatcher pcs -------------------------------------------------------------------
    // 0x1b50: XTOP vi1 / vi14 = 0.  0x1b60: ILW.x vi5, 340(vi14) -- the command read, and the only
    // legal mid-list hand-back point.  0x1b40: the E bit, which leaves pc = 0x1b50 behind.
    constexpr uint32_t kNextCommandPc = 0x1b60u;
    constexpr uint32_t kProgramEndPc = 0x1b50u;

    // ---- command list ---------------------------------------------------------------------
    constexpr int32_t kCommandListQword = 340;
    // Two bounds on the same walk, because a family-C list also contains the inline GIF blocks
    // 0x30/0x32/0x34 skip and those are qwords the scan steps over without ever dispatching: at
    // most this many dispatches, and at most this many list qwords. The longest list in the
    // corpus is 10 commands and 18 qwords (a C-over-A list: 10 commands with one eight-qword
    // block between them). A list that does not terminate inside both bounds is stale data, not a
    // list this file may run.
    constexpr uint32_t kMaxCommands = 32u;
    constexpr uint32_t kMaxListQwords = 64u;
    // The qwords one inline block occupies in the list -- 0x30 and 0x32 advance vi14 by eight per
    // block, 0x34 by eleven (six kicked plus five VU-only parameter qwords: research/15 6.1).
    constexpr uint32_t kInlineBlockQwords = 8u;
    constexpr uint32_t kSphereMapBlockQwords = 11u;

    // ---- the header work ceiling -----------------------------------------------------------
    // Every handler loops over TOP+2.z vertices or TOP+2.w triangles, both of them guest data.
    // These limits bound a native run to a few thousand iterations, which is what makes ignoring
    // budgetEnd and m_stopRequested defensible. A header outside the range (including a negative
    // count) hands the list back whole.
    //
    // The kick bound, stated in full rather than as the per-primitive figure alone, because a
    // family-C list kicks from three places:
    //     kicks <= 3 * kMaxTriangles          the draw commands -- one per triangle from 0x28
    //                                         (family A), or three per primitive for family B
    //                                         (423 from 0x0a, then 423 and 112 from 0x2a)
    //           +  kMaxListQwords / 8         one per inline GIF block from 0x30/0x32/0x34, and
    //                                         the blocks are eight list qwords each (eleven for
    //                                         0x34), so the list-qword bound caps how many a list
    //                                         can carry (8)
    //           +  kMaxCommands               one per 0x64, which kicks the render-state packet
    // i.e. at most 768 + 8 + 32 = 808 XGKICKs for any list this file will run, against 32767 for
    // an unbounded header. Each of the three terms is bounded by a constant here, none by data.
    //
    // The margin is measured, not asserted: `python -m tools_py.vu1_headers --quiet <dumps>`
    // prints the maxima over a dump set, and over the three dispatcher sets of
    // logs/vu1entry0/dispatch_dumps.txt it gives
    //
    //     dump2 (31 lists)        vertices  50   triangles  31
    //     dump3 (48 of 52)        vertices  78   triangles  73
    //     dump4 (83 lists)        vertices  76   triangles  44
    //
    // so the ceiling keeps a factor of 3.3 over the worst list this file will run. The fourth
    // family's drawing shapes are inside that row and move neither number: their maxima are 73
    // vertices (0x70) and 73 triangles (0x40) over the 38 dispatches of each (research/15 7).
    //
    // The four dump3 lists left out of that row are the `52 66 08 40 42` shape, whose 0x52 / 0x66
    // have no handlers here, and they are also the only lists in the corpus whose header is
    // outside the ceiling at all (vertices 12384, -21943 x2, -22066; triangles 0). That is not a
    // header at all: for a 0x52 list TOP+0..TOP+3 are a bone matrix, and reading TOP+2 as ILW
    // words reads matrix floats (research/15 4.1). They are refused on their first command word,
    // before any header check runs, so no list in the corpus is refused *by* these ceilings --
    // and if 0x52 is ever implemented, this ceiling has to be skipped for lists that start with
    // it or it will refuse every one of them. Re-run the scan if the corpus grows.
    constexpr int32_t kMaxVertices = 256;
    constexpr int32_t kMaxTriangles = 256;

    // The family-B counterpart: the clipped vertex count vi10, which the clipper at 0x3618 -- not
    // the header -- produces, so the pre-scan cannot see it. Its ceiling is the clipper's own
    // ping-pong buffers, qwords 40-75 and 76-111: 36 qwords, three per vertex, twelve vertices,
    // and the polygon-close at 0x3a90 needs one of them for the wrap copy. A convex polygon
    // clipped against one plane gains at most one vertex, so from a triangle the five planes can
    // only reach 3 -> 4 -> 5 -> 6 -> 7 -> 8; twelve is the buffer, and anything above it would
    // already have overrun the buffer inside the clipper. Read as a count by 0x0a, 0x12, 0x56,
    // 0x1a, 0x2a and 0x32 (research/13 6.2).
    constexpr int32_t kMaxClippedVertices = 12;

    // What running one command left behind. Most handlers only ever reach their own `B 0x1b60`,
    // but command 0x4c ends the program itself -- a family-B list's trailing 0x42 is never
    // dispatched -- so "the command ran" and "the program is over" have to be told apart.
    enum class Outcome
    {
        NotImplemented, // hand the command back to the microcode at 0x1b60
        NextCommand,    // the handler reached its `B 0x1b60`
        ProgramEnd,     // the handler reached the E bit at 0x1b40
    };

    enum Command : uint32_t
    {
        kCmdWorldObject = 0x02u,   // 0x1f70 world-object setup: cull, clip, per-primitive GIFtag
        kCmdCull = 0x06u,          // 0x1638 backface cull
        kCmdTransform = 0x08u,     // 0x0df8 transform by the clip matrix + perspective divide
        kCmdClippedTransform = 0x0au, // 0x0f08 family-B shim: XGKICK 423, then 0x08's kernel
        kCmdFade = 0x10u,          // 0x0f90 per-vertex distance fade (the XYZF2 fog lane)
        kCmdClippedFade = 0x12u,   // 0x1108 family-B shim: 0x10's fade on the 150 base
        kCmdLight = 0x18u,         // 0x1440 lighting
        kCmdClippedLight = 0x1au,  // 0x15b0 family-B shim: 0x18's lighting on the 150 base
        kCmdBuildPacket = 0x28u,   // 0x1780 triangle assembly -> GIF packet -> XGKICK per triangle
        kCmdFlushPacket = 0x2au,   // 0x1a78 family-B packet flush: staging 150 -> 113, XGKICK 112
        kCmdEnd = 0x42u,           // 0x1b40 E bit
        kCmdLoopBack = 0x4cu,      // 0x20c8 the primitive loop's back edge (and its E bit)
        kCmdTemplateFill = 0x54u,  // 0x05d8 broadcast data qword 327 into every RGBAQ slot
        kCmdClippedTemplateFill = 0x56u, // 0x0640 family-B shim: 0x54's fill on the 150 base
        kCmdUnpack = 0x68u,        // 0x0b20 int->float vertex unpack

        // The fourth family (research/15).
        kCmdUnpackScaled = 0x70u,  // 0x0cb8 scaled int->float vertex unpack: 0x68 with ITOF15
                                   //        positions and a multiply by TOP+3.w
        kCmdDrawUntextured = 0x40u, // 0x1968 a three-pair shim into 0x28's body at 0x1790: the
                                    //        same triangles again, untextured and unfogged
        kCmdFaceNormals = 0x66u,    // 0x2e28 per-triangle face normal (v2-v1) x (v0-v1), FTOI15,
                                    //        into index record [1]; run from entry 0x33c8 only

        // Family C.
        kCmdKickRenderState = 0x64u, // 0x04a8 XGKICK the render-state packet at data qword 330
        kCmdDrawGateOff = 0x72u,     // 0x2268 data qword 39.w := 0
        kCmdDrawGateOn = 0x74u,      // 0x2280 data qword 39.w := 2
        kCmdInlineBlockOverA = 0x30u, // 0x22a0 inline GIF block, S/T rescale, then JR 0x1780
        kCmdInlineBlockOverB = 0x32u, // 0x23b0 the same on the 150 base, then JR 0x1a78
        kCmdSphereMapBlock = 0x34u,   // 0x2690 the eleven-qword-block variant: sphere-map ST and a
                                      //        rim-alpha ramp per vertex, then JR 0x1780
    };

    // The command words a family-A list is allowed to contain. A list built only from these is
    // linear: none of them rewrites vi14 (only 0x4c and 0x32 do), and every one of them ends with
    // `B 0x1b60`, so the static decode below is also the executed order.
    bool isFamilyACommand(uint32_t command)
    {
        switch (command)
        {
        case kCmdCull:
        case kCmdTransform:
        case kCmdFade:
        case kCmdLight:
        case kCmdBuildPacket:
        case kCmdEnd:
        case kCmdTemplateFill:
        case kCmdUnpack:
            return true;
        default:
            return false;
        }
    }

    // ... and the ones a family-B list adds: `68 [06] 02 0a [12] [56] [1a] 2a 4c 42`.
    //
    // For family B the static decode is NOT the executed order -- 0x4c rewrites vi14 and the
    // 0x0a..0x4c run repeats once per primitive -- but it still visits every command word in the
    // list, which is all this scan has to establish.
    bool isFamilyBCommand(uint32_t command)
    {
        switch (command)
        {
        case kCmdWorldObject:
        case kCmdClippedTransform:
        case kCmdClippedFade:
        case kCmdClippedTemplateFill:
        case kCmdClippedLight:
        case kCmdFlushPacket:
        case kCmdLoopBack:
            return true;
        default:
            return false;
        }
    }

    // ... and the ones family C adds: `68 06 02 0a 64 12 2a 32 <block> 72 74 4c 42` (C over B),
    // `68 06 64 08 10 28 30 <block> 72 74 42` (C over A) and, with 0x34,
    // `68 06 64 08 10 28 72 34 <block> 74 42` -- the one sphere-map list in the corpus.
    bool isFamilyCCommand(uint32_t command)
    {
        switch (command)
        {
        case kCmdKickRenderState:
        case kCmdDrawGateOff:
        case kCmdDrawGateOn:
        case kCmdInlineBlockOverA:
        case kCmdInlineBlockOverB:
        case kCmdSphereMapBlock:
            return true;
        default:
            return false;
        }
    }

    // ... and the fourth family's, whose three shapes are `70 06 08 40 42` (30 lists of the 166),
    // `70 08 40 42` (8) and `52 66 08 40 42` (4) -- research/15 1.1. Like family A these are
    // linear: neither command rewrites vi14 and both end at their own `B 0x1b60`.
    //
    // The family's other two command words are deliberately absent, and that is a scope decision
    // rather than an omission (research/15 9.3):
    //   * 0x52 (0x3100, the weighted-skinning accumulator) never hands back to the dispatcher at
    //     all. It emits no GIF packet and falls into the E bit at 0x33b8, ending the program at
    //     pc 0x33c8 -- where the EE issues a SECOND MSCAL that reads vi5, vi9 and vi14 (and, on
    //     its accumulate path, vi2/vi3/vi4 and vf23-vf26) straight out of whatever the handler
    //     left behind. Its correctness condition spans two programs, which is not a contract this
    //     file can state, let alone one --verify over single programs can check.
    //   * 0x66 (0x2e28, the per-triangle face-normal rebuild) is dispatched from 0x1b50 exactly
    //     ZERO times in the 166-run corpus; its only three dispatches come from that 0x33c8 entry.
    //     A native 0x66 could only ever fire behind a native 0x52, so nothing here could verify it.
    // The four `52 66 08 40 42` lists therefore still hand back whole on their first command word,
    // a documented residual of 4 dumps.
    // Sprint 17 F N1 lifts the second half for the 0x33c8 entry: its last-bone path resumes the list
    // at the 0x66 and runs 0x66 here (cmdFaceNormals, admitted by that entry's pre-scan and Ctx flag
    // only); the corpus's three such programs are its fence (docs/research/82). 0x52 stays out.
    bool isFamilyDCommand(uint32_t command)
    {
        switch (command)
        {
        case kCmdUnpackScaled:
        case kCmdDrawUntextured:
            return true;
        default:
            return false;
        }
    }

    // Execution context: VU data memory plus the handful of accessors the handlers need.
    struct Ctx
    {
        VU1Interpreter &vu;
        // Entry 0x33c8's run: command 0x66 has a handler (research/82). False at 0x1b50, where a 0x66
        // stays the microcode's.
        bool faceNormals = false;

        int32_t &vi(uint32_t r) { return vu.m_state.vi[r]; }
        // VU1 data memory is 16 KB and every access wraps inside it, exactly like the microcode's
        // address arithmetic (Vu1Gen::dataAddress).
        uint8_t *qwordBytes(int32_t qword) { return vu.m_activeVuData + Vu1Gen::dataAddress(qword); }
        // ILW <comp>: the low 16 bits of one word of a qword, sign-extended into a VI register.
        int32_t loadWord(int32_t qword, uint32_t component)
        {
            uint32_t value = 0u;
            std::memcpy(&value, qwordBytes(qword) + component * 4u, 4u);
            return static_cast<int32_t>(static_cast<int16_t>(value & 0xFFFFu));
        }
    };

    // ---- VU instruction primitives --------------------------------------------------------
    //
    // One function per microcode op, with the same template parameters the generated code uses
    // (`Dest` is the VU dest field: bit 3 = x .. bit 0 = w), so the arithmetic is the interpreter's
    // own: vu1ops::fmacArith for the FMAC pipe, Vu1Gen::itof / ftoi / minmax for the conversions.
    //
    // The one deliberate difference from the generated code is timing: the FMAC flag registers and
    // Q commit here as soon as the op runs, instead of being queued for the interpreter's pipeline
    // model. The end-of-program values are identical either way (the interpreter flushes its
    // queues in issue order at the E bit), and the only family-A handler that reads a flag register
    // mid-stream is the backface cull's `FMAND vi13, vi5` at 0x1718, which reads its FMAC's flags
    // far enough downstream that immediate commit gives the same answer (see cmdBackfaceCull).
    // Keeping the scheduler out also means this file behaves the same whether the interpreter runs
    // its fast or its cycle-exact path.

    constexpr uint8_t kX = 0x8u, kY = 0x4u, kZ = 0x2u, kW = 0x1u;
    constexpr uint8_t kXY = kX | kY, kZW = kZ | kW, kXYZ = kX | kY | kZ, kXYZW = 0xFu;

    // FMAC flags as VU1Interpreter::fastCommit lands them: MAC is the newest op's lane flags,
    // STATUS keeps its sticky half (bits 6..11) and takes its current half (bits 0..3) from it.
    // KEEP IN SYNC with the FMAC half of VU1Interpreter::fastCommit (ps2_vu1_core.cpp): this is a
    // deliberate copy of that bit arithmetic, not a call, because the native path commits without
    // going through the flag pipeline. The interpreter is frozen for Sprint 1, so the duplication
    // stays; if fastCommit's formula changes, this must change with it.
    void commitFmacFlags(Ctx &c, const vu1ops::FmacResult &out)
    {
        c.vu.m_state.mac = out.mac;
        const uint32_t current = out.status & 0xFu;
        c.vu.m_state.status = (c.vu.m_state.status & 0xFF0u) | current | ((current | out.sticky) << 6);
    }

    // An arithmetic upper op (ADD/SUB/MUL/MADD/MSUB and their broadcast/I/Q forms). Mirrors
    // Vu1Gen::fmac; the result lanes are returned so the caller can store them after the pair's
    // lower op has run, which is how the VU resolves an upper/lower read-write pair.
    template <vu1ops::ArithKind Kind, Vu1Gen::FmacSrc Src, uint32_t Lane, uint8_t Dest,
              uint8_t Fs, uint8_t Ft, bool Opmul = false, bool NormS = true, bool NormT = true>
    __m128 fmac(Ctx &c)
    {
        float(*vf)[4] = c.vu.m_state.vf;
        __m128 first = _mm_loadu_ps(vf[Fs]);
        if (NormS)
            first = vu1ops::normalize4(first);
        __m128 second;
        if (Opmul)
        {
            __m128 vt = _mm_loadu_ps(vf[Ft]);
            if (NormT)
                vt = vu1ops::normalize4(vt);
            second = _mm_shuffle_ps(vt, vt, _MM_SHUFFLE(3, 1, 0, 2));
            first = _mm_shuffle_ps(first, first, _MM_SHUFFLE(3, 0, 2, 1));
        }
        else if (Src == Vu1Gen::SrcVt || Src == Vu1Gen::SrcBc)
        {
            __m128 vt = _mm_loadu_ps(vf[Ft]);
            if (NormT)
                vt = vu1ops::normalize4(vt);
            second = Src == Vu1Gen::SrcVt ? vt : vu1ops::broadcastLane(vt, Lane);
        }
        else if (Src == Vu1Gen::SrcQ)
            second = _mm_set1_ps(c.vu.m_state.q);
        else
            second = _mm_set1_ps(c.vu.m_state.i);

        vu1ops::FmacResult out;
        vu1ops::fmacArith<Kind, Opmul>(first, second, _mm_loadu_ps(c.vu.m_state.acc), Dest, out);
        if (Dest != 0u)
            commitFmacFlags(c, out);
        return out.value;
    }

    // Deferred ACC write of an upper op's result (MULA/MADDA/...).
    template <uint8_t Dest>
    void writeAcc(Ctx &c, __m128 value)
    {
        if (Dest != 0u)
            vu1ops::storeLanes(c.vu.m_state.acc, value, Dest);
    }

    // ITOF<n> / FTOI<n> / MINI / MAX / ABS: the non-arithmetic uppers, which push no flags.
    template <uint32_t Shift, uint8_t Fs>
    __m128 itof(Ctx &c) { return Vu1Gen::itof<Shift, Fs>(c.vu, c.vu.m_state.vf); }

    template <uint32_t Shift, uint8_t Fs>
    __m128 ftoi(Ctx &c) { return Vu1Gen::ftoi<Shift, Fs>(c.vu, c.vu.m_state.vf); }

    template <bool IsMax, Vu1Gen::MinMaxSrc Src, uint32_t Lane, uint8_t Fs, uint8_t Ft>
    __m128 minmax(Ctx &c) { return Vu1Gen::minmax<IsMax, Src, Lane, Fs, Ft>(c.vu, c.vu.m_state.vf); }

    // Deferred register write of an upper op's result (Vu1Gen::storeVf).
    template <uint8_t Reg, uint8_t Dest>
    void writeVf(Ctx &c, __m128 value)
    {
        if (Reg != 0u && Dest != 0u)
            vu1ops::storeLanes(c.vu.m_state.vf[Reg], value, Dest);
    }

    // LQ / SQ against VU data memory, addressed in qwords like the microcode.
    template <uint8_t Vf, uint8_t Dest>
    void loadQword(Ctx &c, int32_t qword)
    {
        if (Vf == 0u)
            return;
        float tmp[4];
        std::memcpy(tmp, c.qwordBytes(qword), 16);
        VU1Interpreter::applyDest(c.vu.m_state.vf[Vf], tmp, Dest);
    }

    template <uint8_t Vf, uint8_t Dest>
    void storeQword(Ctx &c, int32_t qword)
    {
        uint32_t words[4];
        std::memcpy(words, c.vu.m_state.vf[Vf], 16);
        uint32_t *dst = reinterpret_cast<uint32_t *>(c.qwordBytes(qword));
        if (Dest == kXYZW)
        {
            std::memcpy(dst, words, 16);
            return;
        }
        for (uint32_t component = 0; component < 4u; ++component)
            if ((Dest & (0x8u >> component)) != 0u)
                dst[component] = words[component];
    }

    // ISW: one 32-bit word of a qword, from a VI register.
    template <uint8_t Dest>
    void storeIntWord(Ctx &c, int32_t qword, int32_t value)
    {
        const uint32_t word = static_cast<uint32_t>(static_cast<uint16_t>(value & 0xFFFF));
        uint32_t *dst = reinterpret_cast<uint32_t *>(c.qwordBytes(qword));
        for (uint32_t component = 0; component < 4u; ++component)
            if ((Dest & (0x8u >> component)) != 0u)
                dst[component] = word;
    }

    // DIV Q, vfs<fsf>, vft<ftf> -- the FDIV unit, committed immediately instead of after the
    // seven-cycle latency. KEEP IN SYNC with Vu1Gen::div (ps2_vu1_ops.h) for the divide-by-zero
    // classification and the FLT_MAX saturation, and with the FDIV half of
    // VU1Interpreter::fastCommit for the STATUS D/I bits. Both are frozen for Sprint 1; this is a
    // deliberate copy rather than a call, because queueQ would never land without a cycle advance.
    template <uint8_t Fs, uint32_t Fsf, uint8_t Ft, uint32_t Ftf>
    void divQ(Ctx &c)
    {
        float(*vf)[4] = c.vu.m_state.vf;
        const float num = VU1Interpreter::normalizeOperand(vf[Fs][Fsf]);
        const float den = VU1Interpreter::normalizeOperand(vf[Ft][Ftf]);
        uint32_t statusDi = 0u;
        float result;
        if (den == 0.0f)
        {
            statusDi = num == 0.0f ? 0x10u : 0x20u;
            result = std::signbit(num) != std::signbit(den) ? -vu1ops::kFltMax : vu1ops::kFltMax;
        }
        else
            result = num / den;
        uint32_t ignored = 0u;
        c.vu.m_state.q = c.vu.normalizeResult(result, ignored);
        // fastCommit's FDIV half: the D/I bits land in both the current (4,5) and sticky (10,11)
        // halves of STATUS.
        c.vu.m_state.status = (c.vu.m_state.status & 0xFCFu) | statusDi | (statusDi << 6);
    }

    // ERLENG P, vfs -- the EFU's reciprocal length, committed immediately instead of after its
    // 24-cycle latency. Three pieces of the interpreter are mirrored here, and all three are
    // KEEP IN SYNC targets:
    //   * the ERLENG case (opcode 0x73) of VU1Interpreter::execLower (ps2_vu1_lower.cpp) -- the
    //     normalizeOperand of each of the three lanes, and the `len != 0 ? 1/len : len` rule that
    //     makes a zero-length input yield P = 0 rather than an infinity;
    //   * VU1Interpreter::queueP (ps2_vu1_core.cpp) -- which normalizeResult()s the value BEFORE
    //     it enters the pipeline, so the normalisation is part of the stored result, not of the
    //     commit;
    //   * the EFU half of VU1Interpreter::fastCommit (ps2_vu1_core.cpp) -- `m_state.p =
    //     oldest->value` over the entries whose readyCycle has passed, newest last.
    // Collapsing the three is exact for this microcode because every MFP that reads an ERLENG in
    // it is far enough downstream that fastCommit has already landed the value: the first ERLENG
    // (0x2768) is read 26 pairs later at 0x2838 against a latency of 24, and the second (0x2880)
    // has an explicit WAITP in front of its MFP (research/15 6.3). A native handler whose MFP sat
    // inside the latency window would need the pipeline, not this.
    template <uint8_t Fs>
    void erlengP(Ctx &c)
    {
        const float(*vf)[4] = c.vu.m_state.vf;
        const float x = VU1Interpreter::normalizeOperand(vf[Fs][0]);
        const float y = VU1Interpreter::normalizeOperand(vf[Fs][1]);
        const float z = VU1Interpreter::normalizeOperand(vf[Fs][2]);
        const float len = std::sqrt(x * x + y * y + z * z);
        uint32_t ignored = 0u;
        c.vu.m_state.p = c.vu.normalizeResult(len != 0.0f ? 1.0f / len : len, ignored);
    }

    // MFP.<dest> vft, P -- opcode 0x64 of execLower, which reads m_state.p as it stands and
    // stalls on nothing.
    template <uint8_t Vf, uint8_t Dest>
    void moveFromP(Ctx &c)
    {
        const float p = c.vu.m_state.p;
        float result[4] = {p, p, p, p};
        VU1Interpreter::applyDest(c.vu.m_state.vf[Vf], result, Dest);
    }

    // MR32.<dest> vft, vfs -- the lanes rotated up by one (x <- y, y <- z, z <- w, w <- x).
    template <uint8_t Vf, uint8_t Fs, uint8_t Dest>
    void moveRotate32(Ctx &c)
    {
        const float *source = c.vu.m_state.vf[Fs];
        float result[4] = {source[1], source[2], source[3], source[0]};
        VU1Interpreter::applyDest(c.vu.m_state.vf[Vf], result, Dest);
    }

    // FMAND: an integer register masked with a MAC flag register value.
    int32_t fmandWith(uint32_t mac, int32_t mask)
    {
        return static_cast<int32_t>(mac & static_cast<uint32_t>(static_cast<uint16_t>(mask)));
    }

    // ... against the newest FMAC's flags, which is what this file's immediate commit leaves in
    // m_state.mac. Correct wherever the FMAND is at least four pairs downstream of the FMAC whose
    // flags it wants and nothing else has issued in between (command 0x06's cull test); the
    // clipper's two FMANDs are not, and pass a captured value to fmandWith instead.
    int32_t fmand(Ctx &c, int32_t mask) { return fmandWith(c.vu.m_state.mac, mask); }

    // CLIPw.xyz vfs, vft_w -- the clipping flag register. KEEP IN SYNC with Vu1Gen::clip
    // (ps2_vu1_ops.h) and VU1Interpreter::queueClip (ps2_vu1_core.cpp): this is their bit
    // arithmetic with an immediate commit, because a queued entry would never land without a
    // cycle advance. Nothing in this microcode image reads the register back -- there is no
    // FCAND/FCOR/FCEQ/FCGET anywhere in the 16 KB (research/13 4.4) -- but `--regs all` compares
    // it, so the three dead CLIPws in the clipper's prologue still have to run.
    template <uint8_t Fs, uint8_t Ft>
    void clipW(Ctx &c)
    {
        const float(*vf)[4] = c.vu.m_state.vf;
        uint32_t wBits = 0u;
        std::memcpy(&wBits, &vf[Ft][3], sizeof(wBits));
        const int32_t limit =
            (wBits & 0x7F800000u) != 0u ? static_cast<int32_t>(wBits & 0x7FFFFFFFu) : 0x007FFFFF;
        uint32_t flags = 0u;
        for (uint32_t lane = 0; lane < 3u; ++lane)
        {
            uint32_t bits = 0u;
            std::memcpy(&bits, &vf[Fs][lane], sizeof(bits));
            int32_t positive = 0, negative = 0;
            std::memcpy(&positive, &bits, 4);
            const uint32_t negated = bits ^ 0x80000000u;
            std::memcpy(&negative, &negated, 4);
            if (positive > limit)
                flags |= 1u << (2u * lane);
            if (negative > limit)
                flags |= 2u << (2u * lane);
        }
        c.vu.m_workingClip = ((c.vu.m_workingClip << 6) | (flags & 0x3Fu)) & 0xFFFFFFu;
        c.vu.m_state.clip = c.vu.m_workingClip;
    }

    // LOI: the pair's lower word is a float immediate in the I register.
    void loadImmediate(Ctx &c, uint32_t bits)
    {
        float value;
        std::memcpy(&value, &bits, sizeof(value));
        c.vu.m_state.i = VU1Interpreter::normalizeOperand(value);
    }

    // 16-bit wrap of the VI ALU.
    int32_t vi16(int32_t value) { return static_cast<int32_t>(static_cast<int16_t>(value)); }

    // ---- the per-handler work clamps --------------------------------------------------------
    //
    // Every handler that loops reads its trip count out of guest-controlled state -- TOP+2.z
    // (vertices), TOP+2.w (triangles/primitives) or vi10 (the clipped vertex count) -- and every
    // one of those loops tests `!= 0` or `> 0` on a 16-bit register, so an out-of-range count is
    // not a slow run, it is up to 65535 uninterruptible iterations and their XGKICKs. The pre-scan
    // checks the two header words before the list is accepted; these clamps check the same bound
    // again at the point the handler actually reads it, so the bound holds even if a count ever
    // comes from somewhere the scan cannot see (vi10 does; a future handler might).
    //
    // A clamp fires only at a handler's FIRST statement, before it has written any register, any
    // data qword or kicked anything -- so the hand-back is the same clean one a command with no
    // handler gets, and the microcode re-runs the whole command from its own entry.
    bool withinCeiling(int32_t count, int32_t ceiling) { return count >= 0 && count <= ceiling; }
    // ... and the two-sided form, for the one loop whose test is `!= 0` rather than `> 0` and for
    // which zero is therefore 65536 iterations, not none (the inline-block rescale at 0x2380).
    bool withinBounds(int32_t count, int32_t low, int32_t high)
    {
        return count >= low && count <= high;
    }

    // ---- test-only ceiling overrides ---------------------------------------------------------
    //
    // TEST-ONLY, and nothing in the game sets either of these. They lower the ceilings the
    // HANDLER CLAMPS use, and only those -- the pre-scan keeps the real constants. That gap is
    // exactly the point: on real data no count can pass the pre-scan and then fail a clamp,
    // because the pre-scan reads the same two header words first, so without a knob the clamp code
    // would ship untested. With one, `./build.sh test` can make a real corpus list take a real
    // clamp hand-back and check that it still matches the unmodified golden bit for bit.
    //
    //   PS2X_VU1_NATIVE_TEST_CEILING=<n>       lowers the handler-side vertex and triangle ceilings
    //   PS2X_VU1_NATIVE_TEST_CLIP_CEILING=<n>  lowers the handler-side clipped-vertex ceiling
    //
    // A value is clamped into [0, the real constant], so these can only ever narrow what this file
    // accepts, never widen it: the worst a bad value can do is hand more lists back.
    int32_t envCeiling(const char *name, int32_t fallback)
    {
        const char *value = ps2x::knob(name);
        if (value == nullptr)
            return fallback;
        const int32_t parsed = std::atoi(value);
        if (parsed < 0)
            return 0;
        return parsed > fallback ? fallback : parsed;
    }

    // ps2x_tests' hooks over the two process-wide inputs below (vu1native_socom2_force*ForTest, at the end of
    // this file). -1, the only value the game ever has, reads the latched knob exactly as before; a test sets a
    // value for one case and puts -1 back, so its result does not hang on the environment or on which case
    // latched the knob first.
    std::atomic<int> s_testXgkickImmediate{-1};
    std::atomic<int32_t> s_testVertexCeiling{-1};

    int32_t vertexCeiling()
    {
        static const int32_t value = envCeiling("PS2X_VU1_NATIVE_TEST_CEILING", kMaxVertices);
        const int32_t forced = s_testVertexCeiling.load(std::memory_order_relaxed);
        if (forced >= 0)
            return forced > kMaxVertices ? kMaxVertices : forced;   // narrows only, as envCeiling does
        return value;
    }

    int32_t triangleCeiling()
    {
        static const int32_t value = envCeiling("PS2X_VU1_NATIVE_TEST_CEILING", kMaxTriangles);
        return value;
    }

    int32_t clippedVertexCeiling()
    {
        static const int32_t value =
            envCeiling("PS2X_VU1_NATIVE_TEST_CLIP_CEILING", kMaxClippedVertices);
        return value;
    }

    // The single hand-back at 0x1b60, used by the clamps AND by the dispatcher's NotImplemented
    // path, so there is one place that decides what a hand-back leaves behind. vi14 has to name
    // the command again, because 0x1b60 re-reads it and 0x1b70 re-increments it; vi3/vi4/vi5 are
    // written by 0x1b60-0x1b80 before any use, so their value here does not matter.
    bool handBackAtCommandIndex(Ctx &c, int32_t index)
    {
        c.vi(14) = index;
        c.vu.m_viBranchBackupValid = false;
        c.vu.m_state.pc = kNextCommandPc;
        return false;
    }

    // The clamp sites' form. vi14 is one past the command (the dispatcher's 0x1b70 increment has
    // already run) and no clamp fires after its own handler has touched vi14 -- every one of them
    // is its handler's first statement -- so vi14 - 1 is this command's index.
    bool handBackAtNextCommand(Ctx &c) { return handBackAtCommandIndex(c, vi16(c.vi(14) - 1)); }

    // The command word the dispatcher would read for list index `index` (ILW.x: the low 16 bits of
    // the x word), read without disturbing any register.
    uint32_t peekCommand(Ctx &c, uint32_t index)
    {
        uint32_t value = 0u;
        std::memcpy(&value, c.qwordBytes(kCommandListQword + static_cast<int32_t>(index)), 4u);
        return value & 0xFFFFu;
    }

    // The z field of a list qword: 0x30/0x32/0x34 read it as the number of inline blocks that
    // follow the command (research/13 3.1). Read like the scan's command words, without touching
    // a register.
    int32_t peekBlockCount(Ctx &c, uint32_t index)
    {
        return c.loadWord(kCommandListQword + static_cast<int32_t>(index), 2);
    }

    // How many qwords of an embedded block its GIFtag hands to the GS: one for the tag plus the
    // payload NLOOP/NREG/FLG describe.
    uint32_t gifTagQwords(Ctx &c, int32_t qword)
    {
        uint64_t tagLo = 0u;
        std::memcpy(&tagLo, c.qwordBytes(qword), sizeof(tagLo));
        const uint64_t nloop = tagLo & 0x7FFFu;
        const uint32_t flg = static_cast<uint32_t>((tagLo >> 58) & 0x3u);
        uint64_t nreg = (tagLo >> 60) & 0xFu;
        if (nreg == 0u)
            nreg = 16u; // the GIF reads NREG = 0 as sixteen registers

        uint64_t payload = nloop;                       // FLG 2/3: IMAGE, one qword per loop
        if (flg == 0u)                                  // PACKED: one qword per register
            payload = nloop * nreg;
        else if (flg == 1u)                             // REGLIST: two registers per qword
            payload = (nloop * nreg + 1u) / 2u;
        payload += 1u;                                  // the tag itself
        return payload > 0xFFFFu ? 0xFFFFu : static_cast<uint32_t>(payload);
    }

    // Is the block starting at `qword` exactly one complete GIF packet, contained in the
    // `blockQwords` the command will step over (eight for 0x30/0x32, eleven for 0x34)? Two
    // conditions, and EOP is the one Task 6 left out:
    //
    //   * the tag's own packet fits inside the block -- otherwise the qwords the scan steps over
    //     are a truncated packet running into the commands after it, and
    //   * the tag sets EOP. Without it the GIF reads the qword after this packet as ANOTHER
    //     GIFtag and keeps going, so "these eight qwords are one packet" would be false even
    //     though the size check passed: the kick would run off the end of the block and into the
    //     rest of the command list.
    //
    // Every one of the 16 eight-qword blocks in the three dispatcher dump sets is NLOOP = 6,
    // NREG = 1, FLG = PACKED, EOP = 1 -- seven of the block's eight qwords, and self-terminating
    // -- so both conditions do real work rather than passing trivially. 0x34's single block is
    // NLOOP = 5, NREG = 1, PACKED, EOP = 1: six of its eleven qwords reach the GS and the other
    // five are VU-only parameters the handler loads with LQ. This is a soundness heuristic, not
    // microcode behaviour: the microcode kicks whatever the tag says. A list whose block failed
    // either check hands back whole rather than running natively.
    bool inlineBlockIsOnePacket(Ctx &c, int32_t qword, uint32_t blockQwords)
    {
        uint64_t tagLo = 0u;
        std::memcpy(&tagLo, c.qwordBytes(qword), sizeof(tagLo));
        if (((tagLo >> 15) & 1u) == 0u) // EOP
            return false;
        return gifTagQwords(c, qword) <= blockQwords;
    }

    // What the scan below learned about a list, for the work bounds isNativeRun applies after it.
    struct ListFacts
    {
        bool hasFamilyB = false;     // any of 0x02 0x0a 0x12 0x56 0x1a 0x2a 0x4c
        bool hasInlineOverA = false; // 0x30 -- its vertex count is TOP+2.z
        bool hasSphereMap = false;   // 0x34 -- likewise, and its loop also ends on `!= 0`
        Vu1Refusals::Refusal refusal; // why the answer is "no" (PS2X_VU1_NATIVE_REFUSALS counts it)
    };

    // Every "no" below names its reason on the way out: the stores cost nothing on the accepted path, and
    // the dispatcher counts them under PS2X_VU1_NATIVE_REFUSALS (runtime/vu1_native_refusals.h).
    bool refuse(Vu1Refusals::Refusal &out, Vu1Refusals::Reason reason, uint32_t command = 0u)
    {
        out.reason = reason;
        out.command = command;
        return false;
    }

    // Walks the command list the way the dispatcher and the handlers walk it, and says whether
    // every command it visits is one this file implements.
    //
    // For families A and B a linear walk is enough: 0x4c does rewrite vi14, but backwards, over
    // qwords the walk has already visited. Family C is different -- 0x30 and 0x32 advance vi14 by
    // eight qwords per inline block, and those qwords are a GIF packet, not commands. So the walk
    // applies that rewrite itself: on 0x30/0x32 it reads the block count N out of the command's
    // own z word exactly as the handler does, checks each block's GIFtag is one complete,
    // EOP-terminated packet inside its eight qwords (inlineBlockIsOnePacket), and resumes the walk
    // after the last block. The command that introduces a block
    // always precedes it, so the walk reaches the count before it could mistake a packet qword
    // for a command word.
    //
    // A "no" from here is a clean whole-program hand-back: the caller runs before anything is
    // written. (Handing back mid-list at 0x1b60 would in fact also be safe, since this file
    // reproduces the whole register file and all of VU data memory -- including the vi14 that
    // 0x30/0x32 rewrote -- but the walk makes that a safety net rather than the plan.)
    // `startIndex` is where the walk begins: 0 at entry 0x1b50 (its `IADDIU vi14, vi0, 0`), the live-in vi14 at
    // entry 0x33c8, which resumes the list at 0x1b60 past the 0x52 that ended the previous program. There
    // `c.faceNormals` also admits 0x66, whose handler runs only from that entry (research/82).
    bool scanCommandList(Ctx &c, ListFacts &facts, uint32_t startIndex = 0u)
    {
        uint32_t index = startIndex;
        // The three commands that consume the clipper's output -- 0x2a's flush count, 0x4c's
        // vi12/vi15 re-entry and 0x32's rescale count -- all read state only 0x02 writes. The
        // check is deliberately ORDER-based rather than a "the list contains 0x02 somewhere"
        // post-check: a shape like `68 2a 42` or `68 2a 02 4c 42` contains 0x02 but would still
        // run 0x2a's flushTail on whatever vi10 the previous program left in the register file.
        // The walk is the executed order for everything up to the first 0x4c. Past that the walk
        // is a superset rather than a transcript: 0x4c re-enters the list at a vi12 the clipper
        // computed, which the walk cannot evaluate, so the "has 0x02 run?" flag has to hold for
        // every target that re-entry can reach. It does, because there are only two outcomes and
        // neither can run a consumer of the clipper output before 0x02:
        //   - the target lands on a word that is not a command this file implements: the handler
        //     hands the whole program back before writing anything, and the interpreter re-runs it
        //     (an unvalidated target is a hand-back, never a mis-execution);
        //   - the target lands on a command, i.e. a qword the walk already visited on its way to
        //     the 0x4c -- a back edge into the walked prefix, whose 0x02 flag is therefore already
        //     correct -- and that cycle is bounded by 0x4c's own clamp on vi12.
        // So the flag set as the walk passes the 0x02 qword answers exactly "has 0x02 run by the
        // time this command runs?" for every path the program can actually take.
        bool seenWorldObject = false;
        for (uint32_t step = 0; step < kMaxCommands; ++step)
        {
            if (index >= kMaxListQwords)
                return refuse(facts.refusal, Vu1Refusals::Reason::ListTooLong);
            const uint32_t command = peekCommand(c, index);
            if (command == kCmdEnd)
                return true;
            if (!isFamilyACommand(command) && !isFamilyBCommand(command) &&
                !isFamilyCCommand(command) && !isFamilyDCommand(command) &&
                !(c.faceNormals && command == kCmdFaceNormals))
                return refuse(facts.refusal, Vu1Refusals::Reason::UnknownCommand, command);

            if (isFamilyBCommand(command))
                facts.hasFamilyB = true;
            if (command == kCmdWorldObject)
                seenWorldObject = true;
            if ((command == kCmdFlushPacket || command == kCmdLoopBack ||
                 command == kCmdInlineBlockOverB) &&
                !seenWorldObject)
                return refuse(facts.refusal, Vu1Refusals::Reason::ClipBeforeWorld, command);

            const bool introducesBlocks = command == kCmdInlineBlockOverA ||
                                          command == kCmdInlineBlockOverB ||
                                          command == kCmdSphereMapBlock;
            if (command == kCmdInlineBlockOverA)
                facts.hasInlineOverA = true;
            if (command == kCmdSphereMapBlock)
                facts.hasSphereMap = true;

            const int32_t blockCount = introducesBlocks ? peekBlockCount(c, index) : 0;
            const uint32_t blockQwords =
                command == kCmdSphereMapBlock ? kSphereMapBlockQwords : kInlineBlockQwords;
            ++index;
            if (!introducesBlocks)
                continue;

            // The handler's outer loop decrements N and tests `!= 0`, so N = 0 means 65536 blocks
            // and a vi14 that wraps: not a list this file runs. For 0x30/0x32, N > 1 is accepted
            // and implemented but was never dispatched in the corpus (research/13 8.1).
            if (blockCount < 1)
                return refuse(facts.refusal, Vu1Refusals::Reason::ZeroBlockCount, command);
            // 0x34 is the exception: it accepts N == 1 and nothing else. Its outer loop does NOT
            // recompute vi5 -- and its inner loop overwrites vi5 with the FMAND mask 32 at pc
            // 0x2848 -- so a second outer iteration would XGKICK data qword 32, a GIFtag that is
            // not in the command list and that this scan therefore never validated. Refusing N
            // != 1 keeps every kick this file makes one the scan has checked. Corpus maximum is 1
            // (research/15 7); see cmdSphereMapBlock for the same clamp at the handler.
            if (command == kCmdSphereMapBlock && blockCount != 1)
                return refuse(facts.refusal, Vu1Refusals::Reason::SphereBlockCount, command);
            for (int32_t block = 0; block < blockCount; ++block)
            {
                if (index + blockQwords > kMaxListQwords)
                    return refuse(facts.refusal, Vu1Refusals::Reason::BlockPastList, command);
                if (!inlineBlockIsOnePacket(c, kCommandListQword + static_cast<int32_t>(index),
                                            blockQwords))
                    return refuse(facts.refusal, Vu1Refusals::Reason::BlockNotOnePacket, command);
                index += blockQwords;
            }
        }
        return refuse(facts.refusal, Vu1Refusals::Reason::NoEnd); // no 0x42 inside the dispatch bound
    }

    // True when this run is one this file may take over: a list scanCommandList accepts, plus a
    // header whose counts keep the work inside kMaxVertices / kMaxTriangles.
    bool isNativeRun(Ctx &c, int32_t top, Vu1Refusals::Refusal &refusal, uint32_t startIndex = 0u)
    {
        ListFacts facts;
        if (!scanCommandList(c, facts, startIndex))
        {
            refusal = facts.refusal;
            return false;
        }

        // The two header words the handlers read as their loop counts: TOP+2.z is the vertex
        // count (0x68, 0x08, 0x10, 0x54, 0x18, 0x30) and TOP+2.w the primitive count (0x06, 0x28,
        // and family B's vi12). The clipper's own work is bounded by construction -- a stage emits
        // at most two vertices per input edge, so from a triangle the five stages run at most
        // 3 + 6 + 12 + 24 + 48 edge tests -- so bounding the primitive count bounds the list.
        const int32_t vertices = c.loadWord(top + 2, 2);  // TOP+2.z
        const int32_t triangles = c.loadWord(top + 2, 3); // TOP+2.w
        if (vertices < 0 || vertices > kMaxVertices)
            return refuse(refusal, Vu1Refusals::Reason::HeaderVertices);
        if (triangles < 0 || triangles > kMaxTriangles)
            return refuse(refusal, Vu1Refusals::Reason::HeaderTriangles);

        // A family-B list's primitive counter is vi12, and 0x4c's back edge is a post-decrement
        // `IBNE vi12, vi0`: a header triangle count of 0 decrements to -1 and runs 65536
        // primitives, each with a clipper call and up to three XGKICKs, with no way out. So a
        // list that uses any family-B command needs at least one primitive. Family A keeps
        // accepting 0 -- its loops are `IBGTZ`, which a zero count simply falls out of -- so the
        // family-A baseline does not move. No family-B list in the corpus has a zero header.
        if (facts.hasFamilyB && triangles < 1)
            return refuse(refusal, Vu1Refusals::Reason::FamilyBZeroPrims);

        // 0x30 and 0x32 end their rescale loop on `vi9 != 0`, not `vi9 > 0`, so a zero count walks
        // 65536 staging triples instead of none -- bounded, but not a run to start uninterruptibly.
        // 0x30's count is TOP+2.z, which therefore has to be at least one. 0x32's is vi10, which
        // is only a count at all when 0x02 has run: that is the scan's order-based 0x02 check
        // above, and 0x02 itself hands back to 0x32 only with vi10 != 0. 0x34's per-vertex loop
        // ends the same way (`IBNE vi9, vi0` at 0x2928) on the same TOP+2.z.
        if ((facts.hasInlineOverA || facts.hasSphereMap) && vertices < 1)
            return refuse(refusal, Vu1Refusals::Reason::InlineZeroVerts);
        return true;
    }

    // The interpreter's XGKICK model, read the way ps2_vu1_core.cpp's startXgkick reads it: the
    // default copies the whole packet at kick time, PS2X_VU1_XGKICK_CYCLE_EXACT=1 streams it as
    // m_cycle advances. This program never advances m_cycle, so only the default is safe for
    // command 0x28's per-triangle kicks.
    bool xgkickIsImmediate()
    {
        static const bool immediate = !ps2x::knobOn("PS2X_VU1_XGKICK_CYCLE_EXACT");
        const int forced = s_testXgkickImmediate.load(std::memory_order_relaxed);
        return forced < 0 ? immediate : forced != 0;
    }

    // ---- command 0x68 -> 0x0b20: int -> float vertex unpack --------------------------------
    //
    // Converts the raw vertex records in place: three qwords per vertex starting at TOP+4, two
    // vertices per loop iteration ("a" and "b"). Per vertex the conversion is
    //   record[0] -> (ITOF4(.xyz) + bias.xyz, ITOF15(.w))    position, 4 fractional bits
    //   record[1] -> (ITOF12(.xy), ITOF15(.zw))              texture coordinates + extras
    //   record[2] ->  ITOF0(.xyzw)                           colour, unscaled
    // with the bias taken from TOP+3 and the vertex count from TOP+2.z.
    //
    // The microcode is software-pipelined: an iteration stores the pair the previous iteration
    // converted while converting the next one, so on exit the register file holds the conversion
    // of one pair of records past the end of the array. That is reproduced here -- those registers
    // are part of the compared end-of-program state.
    namespace unpack
    {
        // The raw record qwords in flight, and the converted quads stored back over them.
        constexpr uint8_t kBias = 27;
        constexpr uint8_t kRawA0 = 20, kRawA1 = 30, kRawA2 = 19;
        constexpr uint8_t kRawB0 = 26, kRawB1 = 18, kRawB2 = 24;
        constexpr uint8_t kOutA0 = 21, kOutA1 = 31, kOutA2 = 22;
        constexpr uint8_t kOutB0 = 25, kOutB1 = 17, kOutB2 = 23;
        constexpr uint8_t kCursor = 3;    // vi3: the record cursor, in qwords
        constexpr uint8_t kRemaining = 9; // vi9: vertices left, decremented by two per iteration

        // Command 0x70 (0x0cb8) reuses this whole allocation register for register. The only
        // difference is what TOP+3 means there: a per-object scale whose .w lane multiplies the
        // position, rather than an offset whose .xyz lanes are added to it (research/15 2.1).
        constexpr uint8_t kScale = kBias;
    }

    bool cmdUnpackVertices(Ctx &c)
    {
        using namespace unpack;
        __m128 up;

        // Clamp: 0x0b28's vertex count, read before the handler touches anything.
        if (!withinCeiling(c.loadWord(c.vi(1) + 2, 2), vertexCeiling()))
            return handBackAtNextCommand(c);

        c.vi(kCursor) = vi16(c.vi(1) + 4);                   // 0x0b20
        c.vi(kRemaining) = c.loadWord(c.vi(1) + 2, 2);       // 0x0b28: TOP+2.z, the vertex count
        loadQword<kBias, kXYZW>(c, c.vi(1) + 3);             // 0x0b30: TOP+3, the position bias

        // 0x0b38-0x0b88: load the first pair of records and convert them.
        loadQword<kRawA0, kXYZW>(c, c.vi(kCursor) + 0);
        loadQword<kRawA1, kXYZW>(c, c.vi(kCursor) + 1);
        loadQword<kRawA2, kXYZW>(c, c.vi(kCursor) + 2);
        loadQword<kRawB0, kXYZW>(c, c.vi(kCursor) + 3);
        loadQword<kRawB1, kXYZW>(c, c.vi(kCursor) + 4);
        up = itof<4, kRawA0>(c);
        loadQword<kRawB2, kXYZW>(c, c.vi(kCursor) + 5);
        writeVf<kOutA0, kXYZ>(c, up);
        up = itof<15, kRawA1>(c); writeVf<kOutA1, kZW>(c, up);
        up = itof<0, kRawA2>(c);  writeVf<kOutA2, kXYZW>(c, up);
        up = itof<4, kRawB0>(c);  writeVf<kOutB0, kXYZ>(c, up);
        up = itof<15, kRawB1>(c); writeVf<kOutB1, kZW>(c, up);
        up = itof<0, kRawB2>(c);  writeVf<kOutB2, kXYZW>(c, up);

        // 0x0b90-0x0bc8: bias both positions, step the cursor, and prefetch the next pair's
        // record[0]/record[1] (its record[2] is fetched inside the loop).
        up = fmac<vu1ops::ArithAdd, Vu1Gen::SrcVt, 0, kXYZ, kOutA0, kBias, false, false, true>(c);
        writeVf<kOutA0, kXYZ>(c, up);
        up = fmac<vu1ops::ArithAdd, Vu1Gen::SrcVt, 0, kXYZ, kOutB0, kBias, false, false, true>(c);
        c.vi(kCursor) = vi16(c.vi(kCursor) + 6);
        writeVf<kOutB0, kXYZ>(c, up);
        up = itof<15, kRawB0>(c); writeVf<kOutB0, kW>(c, up);
        up = itof<12, kRawB1>(c); writeVf<kOutB1, kXY>(c, up);
        up = itof<15, kRawA0>(c);
        loadQword<kRawA0, kXYZW>(c, c.vi(kCursor) + 0);
        writeVf<kOutA0, kW>(c, up);
        up = itof<12, kRawA1>(c);
        loadQword<kRawA1, kXYZW>(c, c.vi(kCursor) + 1);
        writeVf<kOutA1, kXY>(c, up);
        loadQword<kRawB0, kXYZW>(c, c.vi(kCursor) + 3);
        loadQword<kRawB1, kXYZW>(c, c.vi(kCursor) + 4);

        for (;;)
        {
            c.vi(kRemaining) = vi16(c.vi(kRemaining) - 2);   // 0x0bd0

            // 0x0bd8-0x0be0: store vertex a's first two quads while converting the next pair's.
            up = itof<4, kRawA0>(c);
            storeQword<kOutA0, kXYZW>(c, c.vi(kCursor) - 6);
            writeVf<kOutA0, kXYZ>(c, up);
            up = itof<15, kRawA1>(c);
            storeQword<kOutA1, kXYZW>(c, c.vi(kCursor) - 5);
            writeVf<kOutA1, kZW>(c, up);

            // 0x0be8 `IBLTZ vi9, 0x1b60`, with vertex a's third quad in the delay slot: an odd
            // vertex count leaves here, having stored vertex a only.
            const bool oddVertexLeft = c.vi(kRemaining) < 0;
            storeQword<kOutA2, kXYZW>(c, c.vi(kCursor) - 4);
            if (oddVertexLeft)
                return true;

            // 0x0bf8-0x0c08: vertex b's three quads, and the next pair's positions biased.
            up = itof<4, kRawB0>(c);
            storeQword<kOutB0, kXYZW>(c, c.vi(kCursor) - 3);
            writeVf<kOutB0, kXYZ>(c, up);
            up = itof<15, kRawB1>(c);
            storeQword<kOutB1, kXYZW>(c, c.vi(kCursor) - 2);
            writeVf<kOutB1, kZW>(c, up);
            up = fmac<vu1ops::ArithAdd, Vu1Gen::SrcVt, 0, kXYZ, kOutA0, kBias, false, false, true>(c);
            storeQword<kOutB2, kXYZW>(c, c.vi(kCursor) - 1);
            writeVf<kOutA0, kXYZ>(c, up);

            // 0x0c10-0x0c48: step the cursor, then fetch and convert the pair after the one now
            // in flight.
            up = fmac<vu1ops::ArithAdd, Vu1Gen::SrcVt, 0, kXYZ, kOutB0, kBias, false, false, true>(c);
            c.vi(kCursor) = vi16(c.vi(kCursor) + 6);
            writeVf<kOutB0, kXYZ>(c, up);
            up = itof<15, kRawB0>(c);
            loadQword<kRawA2, kXYZW>(c, c.vi(kCursor) - 4);
            writeVf<kOutB0, kW>(c, up);
            up = itof<12, kRawB1>(c);
            loadQword<kRawB2, kXYZW>(c, c.vi(kCursor) - 1);
            writeVf<kOutB1, kXY>(c, up);
            up = itof<15, kRawA0>(c);
            loadQword<kRawA0, kXYZW>(c, c.vi(kCursor) + 0);
            writeVf<kOutA0, kW>(c, up);
            up = itof<12, kRawA1>(c);
            loadQword<kRawA1, kXYZW>(c, c.vi(kCursor) + 1);
            writeVf<kOutA1, kXY>(c, up);
            up = itof<0, kRawA2>(c);
            loadQword<kRawB0, kXYZW>(c, c.vi(kCursor) + 3);
            writeVf<kOutA2, kXYZW>(c, up);

            // 0x0c40 `IBGTZ vi9, 0x0bd0`, delay slot 0x0c48; falling through is 0x0c50 `B 0x1b60`.
            up = itof<0, kRawB2>(c);
            const bool more = c.vi(kRemaining) > 0;
            writeVf<kOutB2, kXYZW>(c, up);
            loadQword<kRawB1, kXYZW>(c, c.vi(kCursor) + 4);
            if (!more)
                return true;
        }
    }

    // ---- command 0x70 -> 0x0cb8: scaled int -> float vertex unpack --------------------------
    //
    // 0x68 with two instructions changed (research/15 0.1 and 2.1). Same 40-pair body, same
    // software-pipelined two-vertices-per-iteration loop, same in-place stores over the three-qword
    // records at TOP+4, same thirteen registers. Only the position conversion differs:
    //
    //   0x68   record[0] -> (ITOF4 (.xyz) + TOP+3.xyz, ITOF15(.w))   12.4 local coords + an offset
    //   0x70   record[0] -> (ITOF15(.xyz) * TOP+3.w,   ITOF15(.w))   1.15 coords * an object scale
    //
    // record[1] (ITOF12 on .xy, ITOF15 on .zw) and record[2] (ITOF0) are byte-identical to 0x68's.
    // Note the position's .w lane is ITOF15 in BOTH and is written after the multiply, so it is
    // never scaled -- it carries the vertex normal's x (research/15 4.4).
    //
    // Diffing the full 40 pairs of 0x0b20-0x0c58 against 0x0cb8-0x0df0 gives 30 identical and 10
    // differing: the eight substitution sites above, the prologue's `IADDIU vi3, vi3, 6` two pairs
    // earlier, and the relocated loop head (0x0bd0 -> 0x0d68). The cursor move is scheduling only
    // and is transcribed at its real position below for the sake of the disassembly line numbers.
    // The invariant that makes it inert is NOT "every LQ that uses vi3 follows it" -- the prologue
    // loads at 0x0cd0-0x0cf8 precede it, in this handler and in 0x68 -- it is that NOTHING between
    // the two candidate positions reads vi3 at all: the increment sits at 0x0d18 here and at
    // 0x0b98's counterpart 0x0d30 in 0x68's schedule, and the pairs in between (0x0d20's ITOF0 and
    // the two MULw.xyz) touch only vf registers. So the two orders are the same program.
    //
    // Only TOP+3's .w lane is read here -- poisoning .x or .y changes nothing, poisoning .w changes
    // the packets -- but the whole quad is loaded, because vf27 is compared state.
    //
    // Like 0x68 this reads one pair of records past the end of the array and leaves their
    // conversion in the register file on exit. That is not an accident of the transcription: nine
    // of the thirteen registers hold that over-read pair at the hand-back, and `--regs all`
    // compares every one of them.
    bool cmdUnpackScaledVertices(Ctx &c)
    {
        using namespace unpack;
        using vu1ops::ArithMul;
        __m128 up;

        // Clamp: 0x0cc0's vertex count, read before the handler touches anything. The loop exits
        // on `IBLTZ` / `IBGTZ`, so zero is safe -- it is the ceiling that matters, and the corpus
        // maximum over the 38 dispatches is 73 (research/15 7).
        if (!withinCeiling(c.loadWord(c.vi(1) + 2, 2), vertexCeiling()))
            return handBackAtNextCommand(c);

        c.vi(kCursor) = vi16(c.vi(1) + 4);                   // 0x0cb8
        c.vi(kRemaining) = c.loadWord(c.vi(1) + 2, 2);       // 0x0cc0: TOP+2.z, the vertex count
        loadQword<kScale, kXYZW>(c, c.vi(1) + 3);            // 0x0cc8: TOP+3, the position scale

        // 0x0cd0-0x0d20: load the first pair of records and convert them.
        loadQword<kRawA0, kXYZW>(c, c.vi(kCursor) + 0);
        loadQword<kRawA1, kXYZW>(c, c.vi(kCursor) + 1);
        loadQword<kRawA2, kXYZW>(c, c.vi(kCursor) + 2);
        loadQword<kRawB0, kXYZW>(c, c.vi(kCursor) + 3);
        loadQword<kRawB1, kXYZW>(c, c.vi(kCursor) + 4);
        up = itof<15, kRawA0>(c);
        loadQword<kRawB2, kXYZW>(c, c.vi(kCursor) + 5);
        writeVf<kOutA0, kXYZ>(c, up);
        up = itof<15, kRawA1>(c); writeVf<kOutA1, kZW>(c, up);
        up = itof<0, kRawA2>(c);  writeVf<kOutA2, kXYZW>(c, up);
        up = itof<15, kRawB0>(c); writeVf<kOutB0, kXYZ>(c, up);
        up = itof<15, kRawB1>(c);
        c.vi(kCursor) = vi16(c.vi(kCursor) + 6);             // 0x0d18's lower half
        writeVf<kOutB1, kZW>(c, up);
        up = itof<0, kRawB2>(c);  writeVf<kOutB2, kXYZW>(c, up);

        // 0x0d28-0x0d60: scale both positions by TOP+3.w, then prefetch the next pair's
        // record[0]/record[1] (its record[2] is fetched inside the loop).
        up = fmac<ArithMul, Vu1Gen::SrcBc, 3, kXYZ, kOutA0, kScale, false, false, true>(c);
        writeVf<kOutA0, kXYZ>(c, up);
        up = fmac<ArithMul, Vu1Gen::SrcBc, 3, kXYZ, kOutB0, kScale, false, false, true>(c);
        writeVf<kOutB0, kXYZ>(c, up);
        up = itof<15, kRawB0>(c); writeVf<kOutB0, kW>(c, up);
        up = itof<12, kRawB1>(c); writeVf<kOutB1, kXY>(c, up);
        up = itof<15, kRawA0>(c);
        loadQword<kRawA0, kXYZW>(c, c.vi(kCursor) + 0);
        writeVf<kOutA0, kW>(c, up);
        up = itof<12, kRawA1>(c);
        loadQword<kRawA1, kXYZW>(c, c.vi(kCursor) + 1);
        writeVf<kOutA1, kXY>(c, up);
        loadQword<kRawB0, kXYZW>(c, c.vi(kCursor) + 3);
        loadQword<kRawB1, kXYZW>(c, c.vi(kCursor) + 4);

        for (;;)
        {
            c.vi(kRemaining) = vi16(c.vi(kRemaining) - 2);   // 0x0d68

            // 0x0d70-0x0d78: store vertex a's first two quads while converting the next pair's.
            up = itof<15, kRawA0>(c);
            storeQword<kOutA0, kXYZW>(c, c.vi(kCursor) - 6);
            writeVf<kOutA0, kXYZ>(c, up);
            up = itof<15, kRawA1>(c);
            storeQword<kOutA1, kXYZW>(c, c.vi(kCursor) - 5);
            writeVf<kOutA1, kZW>(c, up);

            // 0x0d80 `IBLTZ vi9, 0x1b60`, with vertex a's third quad in the delay slot: an odd
            // vertex count leaves here, having stored vertex a only.
            const bool oddVertexLeft = c.vi(kRemaining) < 0;
            storeQword<kOutA2, kXYZW>(c, c.vi(kCursor) - 4);
            if (oddVertexLeft)
                return true;

            // 0x0d90-0x0da0: vertex b's three quads, and the next pair's positions scaled.
            up = itof<15, kRawB0>(c);
            storeQword<kOutB0, kXYZW>(c, c.vi(kCursor) - 3);
            writeVf<kOutB0, kXYZ>(c, up);
            up = itof<15, kRawB1>(c);
            storeQword<kOutB1, kXYZW>(c, c.vi(kCursor) - 2);
            writeVf<kOutB1, kZW>(c, up);
            up = fmac<ArithMul, Vu1Gen::SrcBc, 3, kXYZ, kOutA0, kScale, false, false, true>(c);
            storeQword<kOutB2, kXYZW>(c, c.vi(kCursor) - 1);
            writeVf<kOutA0, kXYZ>(c, up);

            // 0x0da8-0x0dd0: step the cursor, then fetch and convert the pair after the one now
            // in flight.
            up = fmac<ArithMul, Vu1Gen::SrcBc, 3, kXYZ, kOutB0, kScale, false, false, true>(c);
            c.vi(kCursor) = vi16(c.vi(kCursor) + 6);
            writeVf<kOutB0, kXYZ>(c, up);
            up = itof<15, kRawB0>(c);
            loadQword<kRawA2, kXYZW>(c, c.vi(kCursor) - 4);
            writeVf<kOutB0, kW>(c, up);
            up = itof<12, kRawB1>(c);
            loadQword<kRawB2, kXYZW>(c, c.vi(kCursor) - 1);
            writeVf<kOutB1, kXY>(c, up);
            up = itof<15, kRawA0>(c);
            loadQword<kRawA0, kXYZW>(c, c.vi(kCursor) + 0);
            writeVf<kOutA0, kW>(c, up);
            up = itof<12, kRawA1>(c);
            loadQword<kRawA1, kXYZW>(c, c.vi(kCursor) + 1);
            writeVf<kOutA1, kXY>(c, up);
            up = itof<0, kRawA2>(c);
            loadQword<kRawB0, kXYZW>(c, c.vi(kCursor) + 3);
            writeVf<kOutA2, kXYZW>(c, up);

            // 0x0dd8 `IBGTZ vi9, 0x0d68`, delay slot 0x0de0; falling through is 0x0de8 `B 0x1b60`.
            up = itof<0, kRawB2>(c);
            const bool more = c.vi(kRemaining) > 0;
            writeVf<kOutB2, kXYZW>(c, up);
            loadQword<kRawB1, kXYZW>(c, c.vi(kCursor) + 4);
            if (!more)
                return true;
        }
    }

    // ---- command 0x08 -> 0x0df8: transform by the clip matrix + perspective divide ---------
    //
    // Per vertex: clip = M(vf1..vf4) x position, Q = 1/clip.w, and the three staging quads
    //   +0 ST     = (uv * Q, clip.w)        perspective-correct texture coordinates
    //   +1 RGBAQ  = the source colour quad, copied through untouched
    //   +2 XYZF2  = clip.xyz * Q            screen position ( .w = 254, the fog default )
    // The source records are the three-qword ones command 0x68 converted, from TOP+4; the staging
    // array starts at qword 40, three qwords per vertex, in the GIFtag's REGS order.
    //
    // The microcode runs the transform two vertices ahead of the stores, with clip positions in a
    // two-deep delay line (vf27 -> vf28 -> vf29) and Q one vertex ahead of its use, so the loop
    // never waits on the divider. That schedule is kept here: it decides which vertex's values the
    // registers hold on exit, and it is what keeps the DIV/Q pairing unambiguous.
    namespace transform
    {
        constexpr uint8_t kSrcPos = 20;     // prefetched source position (two vertices ahead)
        constexpr uint8_t kSrcTex = 30;     // prefetched source texture coordinates (.xy; .z = 1)
        constexpr uint8_t kSrcColour = 24;  // source colour quad, passed through to RGBAQ
        constexpr uint8_t kClip = 27;       // clip-space position of the newest transform
        constexpr uint8_t kClipPrev = 28;   // ... one vertex behind
        constexpr uint8_t kClipCurr = 29;   // ... two vertices behind: the one being stored
        constexpr uint8_t kInvW = 17;       // 1/clip.w, broadcast over xyz
        constexpr uint8_t kScreen = 26;     // XYZF2: clip.xyz * 1/w, with .w = 254
        constexpr uint8_t kSt = 31;         // ST: uv * 1/w, with .w = clip.w
        constexpr uint8_t kSrcCursor = 3;   // vi3, in qwords (stride 3)
        constexpr uint8_t kStageCursor = 4; // vi4, in qwords (stride 3)
        constexpr uint8_t kRemaining = 9;   // vi9
    }

    // 0x0e10 onward -- the loop proper, entered with vi3 = the source records, vi4 = the staging
    // base and vi9 = the vertex count already set. Command 0x08 sets them to TOP+4 / 40 / TOP+2.z;
    // command 0x0a (family B, 0x0f08) sets them to the clipped polygon / 150 / the clipped vertex
    // count and branches straight here. One kernel, two bases (research/13 4.5).
    bool transformDivideLoop(Ctx &c)
    {
        using namespace transform;
        using vu1ops::ArithAdd;
        using vu1ops::ArithMadd;
        using vu1ops::ArithMul;
        __m128 up;

        loadQword<kSrcPos, kXYZW>(c, c.vi(kSrcCursor) + 0);    // 0x0e10
        loadQword<kSrcTex, kXY>(c, c.vi(kSrcCursor) + 1);      // 0x0e18

        // 0x0e20-0x0e38: vertex 0's clip position, ACC = vf1*x + vf2*y + vf3*z, then + vf4*1.
        up = fmac<ArithMul, Vu1Gen::SrcBc, 0, kXYZW, 1, kSrcPos>(c);  writeAcc<kXYZW>(c, up);
        up = fmac<ArithMadd, Vu1Gen::SrcBc, 1, kXYZW, 2, kSrcPos>(c);
        c.vi(kSrcCursor) = vi16(c.vi(kSrcCursor) + 3);
        writeAcc<kXYZW>(c, up);
        up = fmac<ArithMadd, Vu1Gen::SrcBc, 2, kXYZW, 3, kSrcPos>(c); writeAcc<kXYZW>(c, up);
        up = fmac<ArithMadd, Vu1Gen::SrcBc, 3, kXYZW, 4, 0, false, true, false>(c);
        loadQword<kSrcPos, kXYZW>(c, c.vi(kSrcCursor));
        writeVf<kClip, kXYZW>(c, up);

        // 0x0e40-0x0e48: the two constants the loop reuses -- the texture quad's third lane is 1,
        // and the screen quad's fog lane is 254.
        up = fmac<ArithAdd, Vu1Gen::SrcBc, 3, kZ, 0, 0, false, false, false>(c);
        loadImmediate(c, 0x437e0000u); // 254.0f
        writeVf<kSrcTex, kZ>(c, up);
        up = fmac<ArithAdd, Vu1Gen::SrcI, 0, kW, 0, 0, false, false, false>(c);
        writeVf<kScreen, kW>(c, up);

        // 0x0e58-0x0e98: start vertex 0's divide, transform vertex 1, and fill the delay line.
        up = fmac<ArithAdd, Vu1Gen::SrcBc, 0, kXYZW, kClip, 0, false, false, false>(c);
        divQ<0, 3, kClip, 3>(c);
        writeVf<kClipPrev, kXYZW>(c, up);
        up = fmac<ArithMul, Vu1Gen::SrcBc, 0, kXYZW, 1, kSrcPos>(c);  writeAcc<kXYZW>(c, up);
        up = fmac<ArithMadd, Vu1Gen::SrcBc, 1, kXYZW, 2, kSrcPos>(c);
        c.vi(kSrcCursor) = vi16(c.vi(kSrcCursor) + 3);
        writeAcc<kXYZW>(c, up);
        up = fmac<ArithMadd, Vu1Gen::SrcBc, 2, kXYZW, 3, kSrcPos>(c); writeAcc<kXYZW>(c, up);
        up = fmac<ArithMadd, Vu1Gen::SrcBc, 3, kXYZW, 4, 0, false, true, false>(c);
        loadQword<kSrcPos, kXYZW>(c, c.vi(kSrcCursor));
        writeVf<kClip, kXYZW>(c, up);
        up = fmac<ArithAdd, Vu1Gen::SrcBc, 0, kXYZW, kClipPrev, 0, false, false, false>(c);
        writeVf<kClipCurr, kXYZW>(c, up);
        up = fmac<ArithAdd, Vu1Gen::SrcQ, 0, kXYZ, 0, 0, false, false, false>(c);
        writeVf<kInvW, kXYZ>(c, up);
        up = fmac<ArithAdd, Vu1Gen::SrcBc, 0, kXYZW, kClip, 0, false, false, false>(c);
        writeVf<kClipPrev, kXYZW>(c, up);

        for (;;)
        {
            // 0x0ea0: the divide for the vertex one ahead of the one being stored.
            divQ<0, 3, kClip, 3>(c);

            // 0x0ea8-0x0eb8: build this vertex's ST and XYZF2 quads and fetch its colour.
            up = fmac<ArithMul, Vu1Gen::SrcBc, 3, kW, 0, kClipCurr, false, false, false>(c);
            loadQword<kSrcColour, kXYZW>(c, c.vi(kSrcCursor) - 4);
            writeVf<kSt, kW>(c, up);
            up = fmac<ArithMul, Vu1Gen::SrcVt, 0, kXYZ, kClipCurr, kInvW, false, false, true>(c);
            c.vi(kRemaining) = vi16(c.vi(kRemaining) - 1);
            writeVf<kScreen, kXYZ>(c, up);
            up = fmac<ArithMul, Vu1Gen::SrcBc, 0, kXYZ, kSrcTex, kInvW>(c);
            c.vi(kStageCursor) = vi16(c.vi(kStageCursor) + 3);
            writeVf<kSt, kXYZ>(c, up);

            // 0x0ec0-0x0ed8: transform the vertex two ahead while the stores of this one go out.
            up = fmac<ArithMul, Vu1Gen::SrcBc, 0, kXYZW, 1, kSrcPos>(c);
            loadQword<kSrcTex, kXY>(c, c.vi(kSrcCursor) - 2);
            writeAcc<kXYZW>(c, up);
            up = fmac<ArithMadd, Vu1Gen::SrcBc, 1, kXYZW, 2, kSrcPos>(c);
            c.vi(kSrcCursor) = vi16(c.vi(kSrcCursor) + 3);
            writeAcc<kXYZW>(c, up);
            up = fmac<ArithMadd, Vu1Gen::SrcBc, 2, kXYZW, 3, kSrcPos>(c);
            storeQword<kSrcColour, kXYZW>(c, c.vi(kStageCursor) - 2); // +1 RGBAQ
            writeAcc<kXYZW>(c, up);
            up = fmac<ArithMadd, Vu1Gen::SrcBc, 3, kXYZW, 4, 0, false, true, false>(c);
            loadQword<kSrcPos, kXYZW>(c, c.vi(kSrcCursor));
            writeVf<kClip, kXYZW>(c, up);

            // 0x0ee0-0x0ef0: pick up the new Q, shift the clip delay line, store the rest.
            up = fmac<ArithAdd, Vu1Gen::SrcQ, 0, kXYZ, 0, 0, false, false, false>(c);
            storeQword<kScreen, kXYZW>(c, c.vi(kStageCursor) - 1);    // +2 XYZF2
            writeVf<kInvW, kXYZ>(c, up);

            // 0x0ee8 `IBGTZ vi9, 0x0ea0`; 0x0ef0 is its delay slot and runs on both paths.
            up = fmac<ArithAdd, Vu1Gen::SrcBc, 0, kXYZW, kClipPrev, 0, false, true, false>(c);
            const bool more = c.vi(kRemaining) > 0;
            writeVf<kClipCurr, kXYZW>(c, up);
            up = fmac<ArithAdd, Vu1Gen::SrcBc, 0, kXYZW, kClip, 0, false, true, false>(c);
            storeQword<kSt, kXYZW>(c, c.vi(kStageCursor) - 3);        // +0 ST
            writeVf<kClipPrev, kXYZW>(c, up);
            if (!more)
                return true;                                          // 0x0ef8: B 0x1b60
        }
    }

    bool cmdTransformDivide(Ctx &c)
    {
        using namespace transform;
        // Clamp: 0x0e08's vertex count.
        if (!withinCeiling(c.loadWord(c.vi(1) + 2, 2), vertexCeiling()))
            return handBackAtNextCommand(c);
        c.vi(kSrcCursor) = vi16(c.vi(1) + 4);                  // 0x0df8
        c.vi(kStageCursor) = 40;                               // 0x0e00
        c.vi(kRemaining) = c.loadWord(c.vi(1) + 2, 2);         // 0x0e08: TOP+2.z, the vertex count
        return transformDivideLoop(c);
    }

    // ---- command 0x0a -> 0x0f08: flush tag, then 0x08's kernel on the clipped polygon --------
    //
    // Four instructions plus an XGKICK (research/13 4.5): kick the NLOOP=0/EOP=1 terminator tag at
    // data qword 423, then point 0x08's loop at the polygon the clipper left (vi8) and the
    // family-B staging array at 150, with the clipped vertex count (vi10) as the loop count.
    bool cmdClippedTransform(Ctx &c)
    {
        using namespace transform;

        // Clamp: 0x0f38's count is the clipper's vi10, which the pre-scan cannot see. Checked
        // here, ahead of the microcode's own first instruction, because 0x0f10's XGKICK would
        // otherwise have happened twice once the microcode re-ran the command.
        if (!withinCeiling(vi16(c.vi(10)), clippedVertexCeiling()))
            return handBackAtNextCommand(c);

        c.vi(4) = 423;                                         // 0x0f08
        // 0x0f10: XGKICK vi4. Same model as command 0x28's kick -- the whole packet is copied at
        // kick time, which the entry check guarantees.
        g_xgkickDecoded.fetch_add(1, std::memory_order_relaxed);
        c.vu.startXgkick(static_cast<uint32_t>(static_cast<uint16_t>(c.vi(4))));
        c.vi(kSrcCursor) = vi16(c.vi(8));                      // 0x0f20: vi3 = vi8
        c.vi(kStageCursor) = 150;                              // 0x0f28
        c.vi(kRemaining) = vi16(c.vi(10));                     // 0x0f38: the B 0xe10 delay slot
        return transformDivideLoop(c);                         // 0x0f30
    }

    // ---- command 0x10 -> 0x0f90: per-vertex distance fade ----------------------------------
    //
    // Writes one lane and one lane only: the F (fog) field of each vertex's XYZF2 staging quad.
    // Per vertex, with the reference point at data qword 28 and the per-axis scale at qword 29:
    //   fog   = clamp((ST.w * scale.w) + reference.w, 0, 255)      ST.w is the clip w
    //   fade  = clamp(dot((position - reference).xyz * scale.xyz, (1,1,1)), 0, 1)
    //   XYZF2.w = fog * fade
    // Two vertices per iteration ("a" and "b"); an odd vertex count leaves after storing a only.
    //
    // The two loads of the XYZF2 quads themselves (vf24/vf25) are dead -- nothing reads them, the
    // fog lane is written with a masked SQ.w -- but they are kept because the register file they
    // leave behind is compared.
    namespace fade
    {
        constexpr uint8_t kRef = 17;   // data qword 28: reference point, .w = the fog offset
        constexpr uint8_t kScale = 18; // data qword 29: per-axis scale, .w = the fog scale
        constexpr uint8_t kPosA = 20, kPosB = 21;     // source positions (TOP+4 + 3k)
        constexpr uint8_t kStA = 30, kStB = 31;       // staging +0 (ST); only .w, the clip w, is used
        constexpr uint8_t kDeadA = 24, kDeadB = 25;   // staging +2 loaded and never read
        constexpr uint8_t kDeltaA = 22, kDeltaB = 23; // position - reference
        constexpr uint8_t kDistA = 26, kDistB = 27;   // scaled delta, then its .w = x + y + z
        constexpr uint8_t kFogA = 14, kFogB = 15;     // the fog value being built, in .w
        constexpr uint8_t kFadeA = 28, kFadeB = 29;   // the clamped distance factor, in .w
        constexpr uint8_t kSrcCursor = 3;             // vi3, stride 6 (two vertices)
        constexpr uint8_t kStageCursor = 4;           // vi4, stride 6
        constexpr uint8_t kRemaining = 9;             // vi9
    }

    // 0x0fa8 onward -- the loop proper, entered with vi3 = the source records, vi4 = the staging
    // base and vi9 = the vertex count already set. Command 0x10 sets them to TOP+4 / 40 /
    // TOP+2.z; command 0x12 (family B, 0x1108) to the clipped polygon / 150 / vi10
    // (research/13 4.5).
    bool distanceFadeLoop(Ctx &c)
    {
        using namespace fade;
        using vu1ops::ArithAdd;
        using vu1ops::ArithMadd;
        using vu1ops::ArithMul;
        using vu1ops::ArithSub;
        __m128 up;

        loadQword<kRef, kXYZW>(c, 28);                           // 0x0fa8
        loadQword<kScale, kXYZW>(c, 29);                         // 0x0fb0

        // 0x0fb8-0x1000: the first pair's inputs, and the two fog values started from the clip w
        // the transform left in the ST quads.
        loadQword<kPosA, kXYZW>(c, c.vi(kSrcCursor) + 0);
        loadQword<kPosB, kXYZW>(c, c.vi(kSrcCursor) + 3);
        loadQword<kDeadA, kXYZW>(c, c.vi(kStageCursor) + 2);
        loadQword<kDeadB, kXYZW>(c, c.vi(kStageCursor) + 5);
        loadQword<kStA, kXYZW>(c, c.vi(kStageCursor) + 0);
        loadQword<kStB, kXYZW>(c, c.vi(kStageCursor) + 3);
        up = fmac<ArithSub, Vu1Gen::SrcVt, 0, kXYZ, kPosA, kRef>(c);  writeVf<kDeltaA, kXYZ>(c, up);
        up = fmac<ArithSub, Vu1Gen::SrcVt, 0, kXYZ, kPosB, kRef>(c);  writeVf<kDeltaB, kXYZ>(c, up);
        up = fmac<ArithMul, Vu1Gen::SrcBc, 3, kW, kStA, kScale>(c);   writeVf<kFogA, kW>(c, up);
        up = fmac<ArithMul, Vu1Gen::SrcBc, 3, kW, kStB, kScale>(c);   writeVf<kFogB, kW>(c, up);

        for (;;)
        {
            // 0x1008-0x1020: scale the deltas, finish the fog bases, prefetch the next positions.
            up = fmac<ArithMul, Vu1Gen::SrcVt, 0, kXYZ, kDeltaA, kScale, false, false, true>(c);
            c.vi(kSrcCursor) = vi16(c.vi(kSrcCursor) + 6);
            writeVf<kDistA, kXYZ>(c, up);
            up = fmac<ArithMul, Vu1Gen::SrcVt, 0, kXYZ, kDeltaB, kScale, false, false, true>(c);
            c.vi(kStageCursor) = vi16(c.vi(kStageCursor) + 6);
            writeVf<kDistB, kXYZ>(c, up);
            up = fmac<ArithAdd, Vu1Gen::SrcBc, 3, kW, kFogA, kRef, false, false, true>(c);
            loadQword<kPosA, kXYZW>(c, c.vi(kSrcCursor) + 0);
            writeVf<kFogA, kW>(c, up);
            up = fmac<ArithAdd, Vu1Gen::SrcBc, 3, kW, kFogB, kRef, false, false, true>(c);
            loadQword<kPosB, kXYZW>(c, c.vi(kSrcCursor) + 3);
            writeVf<kFogB, kW>(c, up);

            // 0x1028-0x1038: vertex a's distance = x + y + z of the scaled delta, in .w.
            up = fmac<ArithMul, Vu1Gen::SrcBc, 0, kW, 0, kDistA, false, false, false>(c);
            writeAcc<kW>(c, up);
            up = fmac<ArithMadd, Vu1Gen::SrcBc, 1, kW, 0, kDistA, false, false, false>(c);
            writeAcc<kW>(c, up);
            up = fmac<ArithMadd, Vu1Gen::SrcBc, 2, kW, 0, kDistA, false, false, false>(c);
            writeVf<kDistA, kW>(c, up);
            loadImmediate(c, 0x437f0000u); // 255.0f

            // 0x1040-0x1060: clamp both fog values to 255, then vertex b's distance.
            up = minmax<false, Vu1Gen::MmI, 0, kFogA, 0>(c);
            loadQword<kDeadA, kXYZW>(c, c.vi(kStageCursor) + 2);
            writeVf<kFogA, kW>(c, up);
            up = minmax<false, Vu1Gen::MmI, 0, kFogB, 0>(c);
            loadQword<kDeadB, kXYZW>(c, c.vi(kStageCursor) + 5);
            writeVf<kFogB, kW>(c, up);
            up = fmac<ArithMul, Vu1Gen::SrcBc, 0, kW, 0, kDistB, false, false, false>(c);
            loadQword<kStA, kXYZW>(c, c.vi(kStageCursor) + 0);
            writeAcc<kW>(c, up);
            up = fmac<ArithMadd, Vu1Gen::SrcBc, 1, kW, 0, kDistB, false, false, false>(c);
            loadQword<kStB, kXYZW>(c, c.vi(kStageCursor) + 3);
            writeAcc<kW>(c, up);
            up = fmac<ArithMadd, Vu1Gen::SrcBc, 2, kW, 0, kDistB, false, false, false>(c);
            writeVf<kDistB, kW>(c, up);
            loadImmediate(c, 0x3f800000u); // 1.0f

            // 0x1068-0x1090: clamp the distances to [0,1] and the fog values to >= 0.
            up = minmax<false, Vu1Gen::MmI, 0, kDistA, 0>(c);          writeVf<kDistA, kW>(c, up);
            up = minmax<true, Vu1Gen::MmBc, 0, kFogA, 0>(c);           writeVf<kFogA, kW>(c, up);
            up = minmax<true, Vu1Gen::MmBc, 0, kFogB, 0>(c);           writeVf<kFogB, kW>(c, up);
            up = minmax<false, Vu1Gen::MmI, 0, kDistB, 0>(c);          writeVf<kDistB, kW>(c, up);
            up = minmax<true, Vu1Gen::MmBc, 0, kDistA, 0>(c);          writeVf<kFadeA, kW>(c, up);
            up = minmax<true, Vu1Gen::MmBc, 0, kDistB, 0>(c);          writeVf<kFadeB, kW>(c, up);

            // 0x1098-0x10b0: start the next pair's deltas, then fog *= fade.
            up = fmac<ArithSub, Vu1Gen::SrcVt, 0, kXYZ, kPosA, kRef>(c);  writeVf<kDeltaA, kXYZ>(c, up);
            up = fmac<ArithSub, Vu1Gen::SrcVt, 0, kXYZ, kPosB, kRef>(c);
            c.vi(kRemaining) = vi16(c.vi(kRemaining) - 2);
            writeVf<kDeltaB, kXYZ>(c, up);
            up = fmac<ArithMul, Vu1Gen::SrcBc, 3, kW, kFogA, kFadeA, false, false, false>(c);
            writeVf<kFogA, kW>(c, up);
            up = fmac<ArithMul, Vu1Gen::SrcBc, 3, kW, kFogB, kFadeB, false, false, false>(c);
            writeVf<kFogB, kW>(c, up);

            // 0x10c8-0x10d0: vertex a's fog lane; an odd vertex count leaves here.
            storeQword<kFogA, kW>(c, c.vi(kStageCursor) - 4);
            if (c.vi(kRemaining) < 0)
                return true;

            // 0x10e0-0x10f0: vertex b's fog lane, then the next pair's fog bases (0x10f0 is the
            // branch's delay slot and runs on both paths).
            storeQword<kFogB, kW>(c, c.vi(kStageCursor) - 1);
            up = fmac<ArithMul, Vu1Gen::SrcBc, 3, kW, kStA, kScale>(c);
            const bool more = c.vi(kRemaining) > 0;
            writeVf<kFogA, kW>(c, up);
            up = fmac<ArithMul, Vu1Gen::SrcBc, 3, kW, kStB, kScale>(c);
            writeVf<kFogB, kW>(c, up);
            if (!more)
                return true;                                           // 0x10f8: B 0x1b60
        }
    }

    bool cmdDistanceFade(Ctx &c)
    {
        using namespace fade;
        // Clamp: 0x0f90's vertex count.
        if (!withinCeiling(c.loadWord(c.vi(1) + 2, 2), vertexCeiling()))
            return handBackAtNextCommand(c);
        c.vi(kRemaining) = c.loadWord(c.vi(1) + 2, 2);           // 0x0f90: TOP+2.z, the vertex count
        c.vi(kSrcCursor) = vi16(c.vi(1) + 4);                    // 0x0f98
        c.vi(kStageCursor) = 40;                                 // 0x0fa0
        return distanceFadeLoop(c);
    }

    // ---- command 0x12 -> 0x1108: 0x10's fade over the clipped polygon ----------------------
    //
    // Four instructions (research/13 4.5). Note that the fog base this loop reads is the staging
    // ST quad's .w -- the clip-space w command 0x0a stored there -- so 0x12 only ever runs after
    // 0x0a has filled the 150-base array.
    bool cmdClippedFade(Ctx &c)
    {
        using namespace fade;
        // Clamp: 0x1120's count is vi10.
        if (!withinCeiling(vi16(c.vi(10)), clippedVertexCeiling()))
            return handBackAtNextCommand(c);
        c.vi(kSrcCursor) = vi16(c.vi(8));                        // 0x1108: vi3 = vi8
        c.vi(kStageCursor) = 150;                                // 0x1110
        c.vi(kRemaining) = vi16(c.vi(10));                       // 0x1120: the B 0xfa8 delay slot
        return distanceFadeLoop(c);                              // 0x1118
    }

    // ---- command 0x54 -> 0x05d8: template fill ---------------------------------------------
    //
    // Broadcasts data qword 327 (the list's RGBAQ template, which entry 0 copied from TOP+12) into
    // the +1 slot of every vertex's staging triple, three vertices per iteration from base 40. The
    // loop overshoots to the next multiple of three -- for 68 vertices it writes the slot of
    // vertices 68 and 69 as well, i.e. up to qword 245 -- which is reproduced here because the
    // extra qwords are part of the compared data memory.
    namespace fill
    {
        constexpr uint8_t kTemplate = 28;
        constexpr uint8_t kStageCursor = 4; // vi4, three vertices (9 qwords) per iteration
        constexpr uint8_t kRemaining = 9;   // vi9
    }

    // 0x05e8 onward -- the loop proper, entered with vi4 = the staging base and vi9 = the vertex
    // count already set. Command 0x54 sets them to 40 / TOP+2.z; command 0x56 (family B, 0x0640)
    // to 150 / vi10, the clipped vertex count (research/13 4.5).
    bool templateFillLoop(Ctx &c)
    {
        using namespace fill;

        loadQword<kTemplate, kXYZW>(c, 327);                     // 0x05e8

        for (;;)
        {
            c.vi(kRemaining) = vi16(c.vi(kRemaining) - 3);       // 0x0600
            storeQword<kTemplate, kXYZW>(c, c.vi(kStageCursor) + 1);
            storeQword<kTemplate, kXYZW>(c, c.vi(kStageCursor) + 4);
            storeQword<kTemplate, kXYZW>(c, c.vi(kStageCursor) + 7);
            // 0x0620 `IBGTZ vi9, 0x0600`, with the cursor step in its delay slot.
            const bool more = c.vi(kRemaining) > 0;
            c.vi(kStageCursor) = vi16(c.vi(kStageCursor) + 9);
            if (!more)
                return true;                                     // 0x0630: B 0x1b60
        }
    }

    bool cmdTemplateFill(Ctx &c)
    {
        using namespace fill;
        // Clamp: 0x05e0's vertex count.
        if (!withinCeiling(c.loadWord(c.vi(1) + 2, 2), vertexCeiling()))
            return handBackAtNextCommand(c);
        c.vi(kStageCursor) = 40;                                 // 0x05d8
        c.vi(kRemaining) = c.loadWord(c.vi(1) + 2, 2);           // 0x05e0: TOP+2.z
        return templateFillLoop(c);
    }

    // ---- command 0x56 -> 0x0640: 0x54's fill over the family-B staging array ----------------
    //
    // Three instructions (research/13 4.5). The loop still overshoots to the next multiple of
    // three, which on the 150 base lands inside the array's headroom (150 + 3*12 = 186).
    bool cmdClippedTemplateFill(Ctx &c)
    {
        using namespace fill;
        // Clamp: 0x0650's count is vi10. The loop decrements by three and tests `> 0`, so it also
        // overshoots to the next multiple of three -- 150 + 3*12 = 186 is inside the array's
        // headroom only because vi10 is bounded here.
        if (!withinCeiling(vi16(c.vi(10)), clippedVertexCeiling()))
            return handBackAtNextCommand(c);
        c.vi(kStageCursor) = 150;                                // 0x0640
        c.vi(kRemaining) = vi16(c.vi(10));                       // 0x0650: the B 0x5e8 delay slot
        return templateFillLoop(c);                              // 0x0648
    }

    // ---- command 0x18 -> 0x1440: lighting --------------------------------------------------
    //
    // Modulates every vertex's RGBAQ staging quad by a lit colour. The per-list light parameters
    // are data qword 27; the matrices are the two entry 0 leaves live in the register file: the
    // normal/light matrix in vf5-vf7 and the colour block in vf9-vf12.
    //
    // Once per command:
    //   light[0..2] = vf9/vf10/vf11 * params.y,  light[3] = vf12 * params.z
    // then per vertex, from the record's qwords 0 and 1 (position and texture quads):
    //   normal  = max(vf5 * record0.w + vf6 * record1.z + vf7 * record1.w, 0) on xyz
    //   lit     = light[0]*normal.x + light[1]*normal.y + light[2]*normal.z + light[3] (xyz),
    //             with the w lane taken from the staging RGBAQ quad instead
    //   staging +1 = record2 * lit
    // Two vertices per iteration, and the loop runs the next pair's normals before storing this
    // pair's colours.
    namespace lighting
    {
        constexpr uint8_t kParams = 31;                 // data qword 27
        constexpr uint8_t kLight0 = 13, kLight1 = 14, kLight2 = 15, kLight3 = 16;
        constexpr uint8_t kPosA = 20, kTexA = 21;       // source record qwords 0 and 1, vertex a
        constexpr uint8_t kPosB = 22, kTexB = 23;       // ... vertex b
        constexpr uint8_t kNormalA = 29, kNormalB = 30; // clamped to >= 0 on xyz
        constexpr uint8_t kRgbaA = 17, kRgbaB = 28;     // the staging +1 quads being modulated
        constexpr uint8_t kSrcColourA = 18, kSrcColourB = 19; // the record's qword 2
        constexpr uint8_t kLitA = 24, kLitB = 25;
        constexpr uint8_t kOutA = 26, kOutB = 27;
        constexpr uint8_t kSrcCursor = 3; // vi3, stride 6
        constexpr uint8_t kStageCursor = 4; // vi4, stride 6
        constexpr uint8_t kRemaining = 9; // vi9
    }

    // 0x1460 onward -- the loop proper, entered with vf31 = the light parameters (data qword 27),
    // vi3 = the source records, vi4 = the staging base and vi9 = the vertex count already set.
    // Command 0x18 sets them from TOP; command 0x1a (family B, 0x15b0) loads qword 27 itself and
    // points the loop at the clipped polygon / 150 / vi10 (research/13 4.5).
    bool lightingLoop(Ctx &c)
    {
        using namespace lighting;
        using vu1ops::ArithMadd;
        using vu1ops::ArithMul;
        __m128 up;

        // 0x1460-0x1478: scale the colour block into this list's light matrix, and load the first
        // pair of source records.
        up = fmac<ArithMul, Vu1Gen::SrcBc, 1, kXYZW, 9, kParams>(c);
        loadQword<kPosA, kXYZW>(c, c.vi(kSrcCursor) + 0);
        writeVf<kLight0, kXYZW>(c, up);
        up = fmac<ArithMul, Vu1Gen::SrcBc, 1, kXYZW, 10, kParams>(c);
        loadQword<kTexA, kXYZW>(c, c.vi(kSrcCursor) + 1);
        writeVf<kLight1, kXYZW>(c, up);
        up = fmac<ArithMul, Vu1Gen::SrcBc, 1, kXYZW, 11, kParams>(c);
        loadQword<kPosB, kXYZW>(c, c.vi(kSrcCursor) + 3);
        writeVf<kLight2, kXYZW>(c, up);
        up = fmac<ArithMul, Vu1Gen::SrcBc, 2, kXYZW, 12, kParams>(c);
        loadQword<kTexB, kXYZW>(c, c.vi(kSrcCursor) + 4);
        writeVf<kLight3, kXYZW>(c, up);

        // 0x1480-0x14c8: the first pair's normals, clamped to >= 0.
        up = fmac<ArithMul, Vu1Gen::SrcBc, 3, kXYZW, 5, kPosA>(c);   writeAcc<kXYZW>(c, up);
        up = fmac<ArithMadd, Vu1Gen::SrcBc, 2, kXYZW, 6, kTexA>(c);  writeAcc<kXYZW>(c, up);
        up = fmac<ArithMadd, Vu1Gen::SrcBc, 3, kXYZW, 7, kTexA>(c);  writeVf<kNormalA, kXYZW>(c, up);
        up = fmac<ArithMul, Vu1Gen::SrcBc, 3, kXYZW, 5, kPosB>(c);   writeAcc<kXYZW>(c, up);
        up = fmac<ArithMadd, Vu1Gen::SrcBc, 2, kXYZW, 6, kTexB>(c);  writeAcc<kXYZW>(c, up);
        up = fmac<ArithMadd, Vu1Gen::SrcBc, 3, kXYZW, 7, kTexB>(c);  writeVf<kNormalB, kXYZW>(c, up);
        c.vi(kSrcCursor) = vi16(c.vi(kSrcCursor) + 6);
        c.vi(kStageCursor) = vi16(c.vi(kStageCursor) + 6);
        up = minmax<true, Vu1Gen::MmBc, 0, kNormalA, 0>(c);          writeVf<kNormalA, kXYZ>(c, up);
        up = minmax<true, Vu1Gen::MmBc, 0, kNormalB, 0>(c);          writeVf<kNormalB, kXYZ>(c, up);

        for (;;)
        {
            // 0x14d0-0x1510: vertex a -- light the normal, keep the staging quad's own w, and
            // modulate the record's colour by the result.
            loadQword<kRgbaA, kXYZW>(c, c.vi(kStageCursor) - 5);
            loadQword<kRgbaB, kXYZW>(c, c.vi(kStageCursor) - 2);
            up = fmac<ArithMul, Vu1Gen::SrcBc, 0, kXYZW, kLight0, kNormalA, false, true, false>(c);
            c.vi(kRemaining) = vi16(c.vi(kRemaining) - 2);
            writeAcc<kXYZW>(c, up);
            up = fmac<ArithMadd, Vu1Gen::SrcBc, 1, kXYZW, kLight1, kNormalA, false, true, false>(c);
            loadQword<kSrcColourA, kXYZW>(c, c.vi(kSrcCursor) - 4);
            writeAcc<kXYZW>(c, up);
            up = fmac<ArithMadd, Vu1Gen::SrcBc, 2, kXYZW, kLight2, kNormalA, false, true, false>(c);
            loadQword<kSrcColourB, kXYZW>(c, c.vi(kSrcCursor) - 1);
            writeAcc<kXYZW>(c, up);
            up = fmac<ArithMadd, Vu1Gen::SrcBc, 3, kXYZ, kLight3, 0, false, true, false>(c);
            loadQword<kPosA, kXYZW>(c, c.vi(kSrcCursor) + 0);
            writeAcc<kXYZ>(c, up);
            up = fmac<ArithMul, Vu1Gen::SrcBc, 0, kW, 0, 0, false, false, false>(c);
            loadQword<kTexA, kXYZW>(c, c.vi(kSrcCursor) + 1);
            writeAcc<kW>(c, up);
            up = fmac<ArithMadd, Vu1Gen::SrcBc, 3, kXYZW, kRgbaA, 0, false, true, false>(c);
            loadQword<kPosB, kXYZW>(c, c.vi(kSrcCursor) + 3);
            writeVf<kLitA, kXYZW>(c, up);
            up = fmac<ArithMul, Vu1Gen::SrcVt, 0, kXYZW, kSrcColourA, kLitA, false, true, false>(c);
            loadQword<kTexB, kXYZW>(c, c.vi(kSrcCursor) + 4);
            writeVf<kOutA, kXYZW>(c, up);

            // 0x1518-0x1548: vertex b, the same way.
            up = fmac<ArithMul, Vu1Gen::SrcBc, 0, kXYZW, kLight0, kNormalB, false, true, false>(c);
            writeAcc<kXYZW>(c, up);
            up = fmac<ArithMadd, Vu1Gen::SrcBc, 1, kXYZW, kLight1, kNormalB, false, true, false>(c);
            writeAcc<kXYZW>(c, up);
            up = fmac<ArithMadd, Vu1Gen::SrcBc, 2, kXYZW, kLight2, kNormalB, false, true, false>(c);
            c.vi(kSrcCursor) = vi16(c.vi(kSrcCursor) + 6);
            writeAcc<kXYZW>(c, up);
            up = fmac<ArithMadd, Vu1Gen::SrcBc, 3, kXYZ, kLight3, 0, false, true, false>(c);
            c.vi(kStageCursor) = vi16(c.vi(kStageCursor) + 6);
            writeAcc<kXYZ>(c, up);
            up = fmac<ArithMul, Vu1Gen::SrcBc, 0, kW, 0, 0, false, false, false>(c);
            writeAcc<kW>(c, up);
            up = fmac<ArithMadd, Vu1Gen::SrcBc, 3, kXYZW, kRgbaB, 0, false, true, false>(c);
            writeVf<kLitB, kXYZW>(c, up);
            up = fmac<ArithMul, Vu1Gen::SrcVt, 0, kXYZW, kSrcColourB, kLitB, false, true, false>(c);
            writeVf<kOutB, kXYZW>(c, up);

            // 0x1550-0x1578: the next pair's normals, before this pair's colours are stored.
            up = fmac<ArithMul, Vu1Gen::SrcBc, 3, kXYZW, 5, kPosA>(c);   writeAcc<kXYZW>(c, up);
            up = fmac<ArithMadd, Vu1Gen::SrcBc, 2, kXYZW, 6, kTexA>(c);  writeAcc<kXYZW>(c, up);
            up = fmac<ArithMadd, Vu1Gen::SrcBc, 3, kXYZW, 7, kTexA>(c);  writeVf<kNormalA, kXYZW>(c, up);
            up = fmac<ArithMul, Vu1Gen::SrcBc, 3, kXYZW, 5, kPosB>(c);   writeAcc<kXYZW>(c, up);
            up = fmac<ArithMadd, Vu1Gen::SrcBc, 2, kXYZW, 6, kTexB>(c);  writeAcc<kXYZW>(c, up);
            up = fmac<ArithMadd, Vu1Gen::SrcBc, 3, kXYZW, 7, kTexB>(c);  writeVf<kNormalB, kXYZW>(c, up);

            // 0x1580-0x1598: store both colours and clamp the new normals (0x1598 is the branch's
            // delay slot and runs on both paths).
            storeQword<kOutA, kXYZW>(c, c.vi(kStageCursor) - 11);
            storeQword<kOutB, kXYZW>(c, c.vi(kStageCursor) - 8);
            up = minmax<true, Vu1Gen::MmBc, 0, kNormalA, 0>(c);
            const bool more = c.vi(kRemaining) > 0;
            writeVf<kNormalA, kXYZ>(c, up);
            up = minmax<true, Vu1Gen::MmBc, 0, kNormalB, 0>(c);
            writeVf<kNormalB, kXYZ>(c, up);
            if (!more)
                return true;                                            // 0x15a0: B 0x1b60
        }
    }

    bool cmdLighting(Ctx &c)
    {
        using namespace lighting;
        // Clamp: 0x1458's vertex count.
        if (!withinCeiling(c.loadWord(c.vi(1) + 2, 2), vertexCeiling()))
            return handBackAtNextCommand(c);
        loadQword<kParams, kXYZW>(c, 27);                        // 0x1440
        c.vi(kSrcCursor) = vi16(c.vi(1) + 4);                    // 0x1448
        c.vi(kStageCursor) = 40;                                 // 0x1450
        c.vi(kRemaining) = c.loadWord(c.vi(1) + 2, 2);           // 0x1458: TOP+2.z
        return lightingLoop(c);
    }

    // ---- command 0x1a -> 0x15b0: 0x18's lighting over the clipped polygon ------------------
    //
    // Five instructions (research/13 4.5): the light parameters at data qword 27 (which 0x18's
    // own prologue at 0x1440 loads), then the three family-B pointers. In the B/C corpus this is
    // the only entry into 0x1460 -- command 0x18 is never dispatched there.
    bool cmdClippedLighting(Ctx &c)
    {
        using namespace lighting;
        // Clamp: 0x15d0's count is vi10.
        if (!withinCeiling(vi16(c.vi(10)), clippedVertexCeiling()))
            return handBackAtNextCommand(c);
        loadQword<kParams, kXYZW>(c, 27);                        // 0x15b0
        c.vi(kSrcCursor) = vi16(c.vi(8));                        // 0x15b8: vi3 = vi8
        c.vi(kStageCursor) = 150;                                // 0x15c0
        c.vi(kRemaining) = vi16(c.vi(10));                       // 0x15d0: the B 0x1460 delay slot
        return lightingLoop(c);                                  // 0x15c8
    }

    // ---- command 0x28 -> 0x1780: triangle assembly, GIF packet, XGKICK ---------------------
    //
    // Walks the triangle index list at TOP + TOP+2.x and emits one ten-qword GIF packet per
    // surviving triangle: the list's GIFtag from TOP+1 with NLOOP patched to 3 and EOP set,
    // followed by three vertices of (ST, RGBAQ, XYZF2) taken from the staging array. RGBAQ goes
    // through MADD by the rounding bias at data qword 38 (whose .w comes from the RGBAQ template
    // at 327) and FTOI0; XYZF2 through FTOI4; ST is copied as is.
    //
    // Two gates per triangle, both from the index qword's w word: bit 0 (set by the backface cull)
    // and bit 1, the latter OR-ed with data qword 39.w so a list can force everything through.
    //
    // The two packet buffers at 290 and 300 ping-pong -- their bases live in data qword 329.x/.y
    // and are swapped per triangle and written back at the end -- so the GS can still be reading
    // one while the next is being built. One XGKICK per triangle.
    namespace packet
    {
        constexpr uint8_t kBias = 20;      // data qword 38; .w replaced from qword 327
        constexpr uint8_t kGifTag = 19;    // the GIFtag template from TOP+1 (vf19 before the loop)
        constexpr uint8_t kSt0 = 17, kSt1 = 26, kSt2 = 29;
        constexpr uint8_t kRgba0 = 18, kRgba1 = 27, kRgba2 = 30;
        constexpr uint8_t kXyz0 = 19, kXyz1 = 28, kXyz2 = 31; // vf19 again, once the tag is stored
        constexpr uint8_t kIndexCursor = 4;  // vi4, two qwords per triangle
        constexpr uint8_t kTriangles = 13;   // vi13
        constexpr uint8_t kPacket = 2;       // vi2: the buffer being built and kicked
        constexpr uint8_t kOtherPacket = 8;  // vi8: the one the GS may still be reading
        constexpr uint8_t kVertex0 = 5, kVertex1 = 6, kVertex2 = 7; // staging qword offsets
        constexpr uint8_t kFlags = 12, kGate = 3, kForce = 9, kScratch = 11;
    }

    // ---- PS2X_VU1_HOST_DRAW=1: draw the assembled triangle instead of kicking it ------------
    //
    // The packet is still built qword for qword -- every data-memory write, the ping-pong swap and
    // vi2/vi8 happen exactly as before, so the goldens stay green with the knob on -- but instead
    // of XGKICKing it, the ten qwords are decoded the way GS::writeRegisterPacked decodes them and
    // handed to GS::submitHostTriangle. The one thing the hook does NOT take from the packet is
    // the screen position: it gets the floats the microcode held before FTOI4, so the host
    // rasteriser keeps the fraction the GIF path has to truncate to 1/16 of a pixel.
    //
    // Anything the hook cannot reproduce one for one -- a tag that is not this list's PACKED
    // (ST, RGBAQ, XYZF2) x 3 template with PRE set, a primitive that is not a triangle, a vertex
    // with the ADC bit set (which suppresses the draw), or no GS at all -- falls back to the real
    // XGKICK, so the knob can only ever change how a triangle is drawn, never whether it is.
    bool hostDrawEnabled()
    {
        static const bool enabled = []() {
            const char *value = ps2x::knob("PS2X_VU1_HOST_DRAW");
            return value != nullptr && std::atoi(value) != 0;
        }();
        return enabled;
    }

    // The GIFtag's PRIM field (bits 47-57), decoded exactly like gs_frontend.cpp's
    // decodePrimRegister -- the same bits the GIF path feeds to the PRIM register through PRE.
    GSPrimReg primFromGifTag(uint64_t tagLo)
    {
        const uint64_t value = (tagLo >> 47) & 0x7FFu;
        GSPrimReg prim{};
        prim.type = static_cast<GSPrimType>(value & 0x7u);
        prim.iip = ((value >> 3) & 1u) != 0u;
        prim.tme = ((value >> 4) & 1u) != 0u;
        prim.fge = ((value >> 5) & 1u) != 0u;
        prim.abe = ((value >> 6) & 1u) != 0u;
        prim.aa1 = ((value >> 7) & 1u) != 0u;
        prim.fst = ((value >> 8) & 1u) != 0u;
        prim.ctxt = ((value >> 9) & 1u) != 0u;
        prim.fix = ((value >> 10) & 1u) != 0u;
        return prim;
    }

    float loadPacketFloat(const uint8_t *p)
    {
        float value;
        std::memcpy(&value, p, sizeof(value));
        return value;
    }

    uint32_t loadPacketWord(const uint8_t *p)
    {
        uint32_t value;
        std::memcpy(&value, p, sizeof(value));
        return value;
    }

    uint64_t loadPacketDword(const uint8_t *p)
    {
        uint64_t value;
        std::memcpy(&value, p, sizeof(value));
        return value;
    }

    // Returns false when the packet is not the shape the hook can reproduce; the caller then kicks.
    bool submitHostTriangleFromPacket(Ctx &c, int32_t packetQword, const float screenXY[3][2])
    {
        GS *gs = c.vu.activeGs();
        if (gs == nullptr)
            return false;

        const uint8_t *tagBytes = c.qwordBytes(packetQword);
        const uint64_t tagLo = loadPacketDword(tagBytes);
        const uint64_t tagHi = loadPacketDword(tagBytes + 8);
        if ((tagLo & 0x7FFFu) != 3u ||          // NLOOP: three vertices
            ((tagLo >> 46) & 1u) == 0u ||       // PRE: the tag carries the PRIM field
            ((tagLo >> 58) & 3u) != 0u ||       // FLG: PACKED
            ((tagLo >> 60) & 0xFu) != 3u ||     // NREG
            (tagHi & 0xFFFu) != 0x412u)         // REGS: ST, RGBAQ, XYZF2
            return false;

        const GSPrimReg prim = primFromGifTag(tagLo);
        if (prim.type != GS_PRIM_TRIANGLE)
            return false;
        // FST means the vertices carry UV in texel units instead of ST/Q in normalised ones, and
        // the hook below fills S/T/Q. The corpus tag never sets it; if one ever does, kick.
        if (prim.fst)
            return false;

        GSVertex vertices[3];
        for (int i = 0; i < 3; ++i)
        {
            const uint8_t *st = c.qwordBytes(packetQword + 1 + i * 3);
            const uint8_t *rgbaq = c.qwordBytes(packetQword + 2 + i * 3);
            const uint8_t *xyzf = c.qwordBytes(packetQword + 3 + i * 3);
            GSVertex &v = vertices[i];

            // PACKED ST (0x02): S = lo[0:32], T = lo[32:64], Q = hi[0:32]; a zero Q reads as 1.0.
            v.s = loadPacketFloat(st);
            v.t = loadPacketFloat(st + 4);
            v.q = loadPacketFloat(st + 8);
            if (v.q == 0.0f)
                v.q = 1.0f;

            // PACKED RGBAQ (0x01): the low byte of each of the four words.
            v.r = rgbaq[0];
            v.g = rgbaq[4];
            v.b = rgbaq[8];
            v.a = rgbaq[12];

            // PACKED XYZF2 (0x04): Z = hi[4:28], F = hi[36:44], ADC = hi[47]. FTOI4 put X/Y/Z/F
            // in 1/16 units, which is why the GS reads Z and F four bits up.
            const uint32_t zWord = loadPacketWord(xyzf + 8);
            const uint32_t fWord = loadPacketWord(xyzf + 12);
            if (((fWord >> 15) & 1u) != 0u)
                return false;

            // PACKED XYZF2 takes X from the low 16 bits of word 0 and Y from the low 16 bits of
            // word 1, so the GIF path silently WRAPS an FTOI4 result outside 0..65535 -- a vertex
            // at -1/16 of a pixel arrives at 4095.9375. The host path below uses the pre-FTOI4
            // float, which does not wrap, and would draw the triangle where the geometry says it
            // is rather than where the GS would have put it. Kick instead, so the two renderings
            // stay comparable: --vram-diff must not score a difference the GIF path created.
            if (loadPacketWord(xyzf) > 0xFFFFu || loadPacketWord(xyzf + 4) > 0xFFFFu)
                return false;
            v.z = static_cast<double>((zWord >> 4) & 0xFFFFFFu);
            v.fog = static_cast<uint8_t>((fWord >> 4) & 0xFFu);

            // X/Y in XYOFFSET space: the packet words are (uint16)(xy * 16) and the GIF path reads
            // them back as word / 16, so these floats are the same coordinate without the truncation.
            v.x = screenXY[i][0];
            v.y = screenXY[i][1];
        }

        // The GS register state a host-drawn triangle leaves behind has to be the state the kicked
        // packet would have left, because the next packet the game builds may rely on it: the tag's
        // PRE bit writes PRIM before the vertices, and each PACKED ST / RGBAQ descriptor updates the
        // GS's sticky vertex latches (m_curS/m_curT/m_curQ, m_curR/G/B/A -- gs_frontend.cpp
        // writeRegisterPacked cases 0x02 and 0x01). What survives the packet is the LAST vertex's
        // pair, so replay those two writes with that vertex's own packet words.
        //
        // Through writeRegister (not writeRegisterPacked) the 64-bit values differ from the packet
        // qwords: ST is S | T<<32 (Q rides in RGBAQ instead), RGBAQ is R | G<<8 | B<<16 | A<<24 |
        // Q<<32. Writing ST first and RGBAQ second reproduces the packed pair exactly, including
        // the Q==0 -> 1.0 fixup both paths apply.
        gs->writeRegister(GS_REG_PRIM, (tagLo >> 47) & 0x7FFu);
        {
            const uint8_t *st = c.qwordBytes(packetQword + 1 + 2 * 3);
            const uint8_t *rgbaq = c.qwordBytes(packetQword + 2 + 2 * 3);
            const uint64_t stValue = static_cast<uint64_t>(loadPacketWord(st)) |
                                     (static_cast<uint64_t>(loadPacketWord(st + 4)) << 32);
            const uint64_t rgbaqValue = static_cast<uint64_t>(rgbaq[0]) |
                                        (static_cast<uint64_t>(rgbaq[4]) << 8) |
                                        (static_cast<uint64_t>(rgbaq[8]) << 16) |
                                        (static_cast<uint64_t>(rgbaq[12]) << 24) |
                                        (static_cast<uint64_t>(loadPacketWord(st + 8)) << 32);
            gs->writeRegister(GS_REG_ST, stValue);
            gs->writeRegister(GS_REG_RGBAQ, rgbaqValue);
        }
        gs->submitHostTriangle(prim, vertices[0], vertices[1], vertices[2]);
        return true;
    }

    // The body from 0x1790 on, entered with vf19 holding the GIFtag template and vf20 the quad
    // the RGBAQ bias is taken from. Command 0x28 (0x1780) loads both, from data qword 38 and
    // TOP+1. Command 0x40 (0x1968) loads only the tag, from data qword 26, and branches here --
    // i.e. it enters TWO PAIRS PAST 0x28's head and runs on an INHERITED vf20. That is the whole
    // difference between the two commands, and the reason this split exists rather than a flag:
    // see cmdDrawUntexturedTriangles.
    bool buildPacketBody(Ctx &c)
    {
        using namespace packet;
        using vu1ops::ArithAdd;
        using vu1ops::ArithMadd;
        using vu1ops::ArithSub;
        __m128 up;

        // Read once per run (hostDrawEnabled caches the env), and only meaningful while a GS is
        // attached -- activeGs() is valid for the length of this execute()/resume() call.
        const bool hostDraw = hostDrawEnabled() && c.vu.activeGs() != nullptr;

        // 0x1790-0x1798: ACC holds the fixed-point rounding term the RGBAQ MADDs add; it is set
        // once and never rewritten inside this command.
        up = fmac<ArithAdd, Vu1Gen::SrcBc, 3, kXYZ, 0, kBias, false, false, true>(c);
        c.vi(kIndexCursor) = c.loadWord(c.vi(1) + 2, 0);         // TOP+2.x
        writeAcc<kXYZ>(c, up);
        up = fmac<ArithSub, Vu1Gen::SrcBc, 3, kW, 0, 0, false, false, false>(c);
        c.vi(kScratch) = 32767;
        writeAcc<kW>(c, up);
        c.vi(kScratch) = vi16(c.vi(kScratch) + 4);               // 0x17a0: 0x8003 = EOP | NLOOP 3
        c.vi(kIndexCursor) = vi16(c.vi(kIndexCursor) + c.vi(1)); // 0x17a8

        // 0x17b0-0x17c8: both packet buffers get the tag, with NLOOP patched to three vertices.
        storeQword<kGifTag, kXYZW>(c, 290);
        storeQword<kGifTag, kXYZW>(c, 300);
        storeIntWord<kX>(c, 290, c.vi(kScratch));
        storeIntWord<kX>(c, 300, c.vi(kScratch));

        c.vi(kTriangles) = c.loadWord(c.vi(1) + 2, 3);           // 0x17d0: TOP+2.w
        loadQword<kBias, kW>(c, 327);                            // 0x17d8
        c.vi(kPacket) = c.loadWord(329, 0);                      // 0x17e0: 300
        c.vi(kOtherPacket) = c.loadWord(329, 1);                 // 0x17e8: 290

        for (;;)
        {
            // 0x17f0-0x1828: the triangle's three vertex offsets and its visibility gate.
            c.vi(kFlags) = c.loadWord(c.vi(kIndexCursor), 3);
            c.vi(kScratch) = 1;
            c.vi(kVertex0) = c.loadWord(c.vi(kIndexCursor), 0);
            c.vi(kVertex1) = c.loadWord(c.vi(kIndexCursor), 1);
            c.vi(kGate) = c.vi(kFlags) & c.vi(kScratch);
            c.vi(kForce) = c.loadWord(39, 3);
            const bool visible = static_cast<int16_t>(c.vi(kGate)) != 0;
            c.vi(kVertex2) = c.loadWord(c.vi(kIndexCursor), 2); // 0x1828, the branch's delay slot

            bool emit = false;
            if (visible)
            {
                // 0x1830-0x1860: the second gate, then the first RGBAQ load in the delay slot.
                c.vi(kScratch) = 2;
                c.vi(kGate) = c.vi(kFlags) & c.vi(kScratch);
                c.vi(kGate) = c.vi(kGate) | c.vi(kForce);
                emit = static_cast<int16_t>(c.vi(kGate)) != 0;
                loadQword<kRgba0, kXYZW>(c, c.vi(kVertex0) + 41);
            }

            if (emit)
            {
                // 0x1868-0x1890: the other two RGBAQ quads and the three XYZF2 quads, with the
                // rounding bias folded in.
                loadQword<kRgba1, kXYZW>(c, c.vi(kVertex1) + 41);
                loadQword<kRgba2, kXYZW>(c, c.vi(kVertex2) + 41);
                loadQword<kXyz0, kXYZW>(c, c.vi(kVertex0) + 42);
                up = fmac<ArithMadd, Vu1Gen::SrcVt, 0, kXYZW, kRgba0, kBias>(c);
                loadQword<kXyz1, kXYZW>(c, c.vi(kVertex1) + 42);
                writeVf<kRgba0, kXYZW>(c, up);
                up = fmac<ArithMadd, Vu1Gen::SrcVt, 0, kXYZW, kRgba1, kBias>(c);
                loadQword<kXyz2, kXYZW>(c, c.vi(kVertex2) + 42);
                writeVf<kRgba1, kXYZW>(c, up);
                up = fmac<ArithMadd, Vu1Gen::SrcVt, 0, kXYZW, kRgba2, kBias>(c);
                loadQword<kSt0, kXYZW>(c, c.vi(kVertex0) + 40);
                writeVf<kRgba2, kXYZW>(c, up);

                // The three XYZF2 quads are loaded and not yet converted: this is the last point
                // at which the screen position is still the float the perspective divide produced.
                // PS2X_VU1_HOST_DRAW hands those floats to the GS instead of the FTOI4 words.
                float screenXY[3][2] = {};
                if (hostDraw)
                {
                    const float(*vf)[4] = c.vu.m_state.vf;
                    screenXY[0][0] = vf[kXyz0][0];
                    screenXY[0][1] = vf[kXyz0][1];
                    screenXY[1][0] = vf[kXyz1][0];
                    screenXY[1][1] = vf[kXyz1][1];
                    screenXY[2][0] = vf[kXyz2][0];
                    screenXY[2][1] = vf[kXyz2][1];
                }

                // 0x1898-0x18c0: to fixed point (XYZF2 with 4 fractional bits, RGBAQ with none),
                // while the ST quads load and the two packet buffers swap roles.
                up = ftoi<4, kXyz0>(c);
                loadQword<kSt1, kXYZW>(c, c.vi(kVertex1) + 40);
                writeVf<kXyz0, kXYZW>(c, up);
                up = ftoi<0, kRgba0>(c);
                loadQword<kSt2, kXYZW>(c, c.vi(kVertex2) + 40);
                writeVf<kRgba0, kXYZW>(c, up);
                up = ftoi<4, kXyz1>(c);
                c.vi(kScratch) = vi16(c.vi(kPacket));
                writeVf<kXyz1, kXYZW>(c, up);
                up = ftoi<0, kRgba1>(c);
                c.vi(kPacket) = vi16(c.vi(kOtherPacket));
                writeVf<kRgba1, kXYZW>(c, up);
                up = ftoi<4, kXyz2>(c);
                c.vi(kOtherPacket) = vi16(c.vi(kScratch));
                writeVf<kXyz2, kXYZW>(c, up);
                up = ftoi<0, kRgba2>(c);
                storeQword<kSt0, kXYZW>(c, c.vi(kPacket) + 1);
                writeVf<kRgba2, kXYZW>(c, up);

                // 0x18c8-0x1900: the nine register qwords, in the tag's REGS order per vertex.
                storeQword<kSt1, kXYZW>(c, c.vi(kPacket) + 4);
                storeQword<kSt2, kXYZW>(c, c.vi(kPacket) + 7);
                storeQword<kRgba0, kXYZW>(c, c.vi(kPacket) + 2);
                storeQword<kRgba1, kXYZW>(c, c.vi(kPacket) + 5);
                storeQword<kRgba2, kXYZW>(c, c.vi(kPacket) + 8);
                storeQword<kXyz0, kXYZW>(c, c.vi(kPacket) + 3);
                storeQword<kXyz1, kXYZW>(c, c.vi(kPacket) + 6);
                storeQword<kXyz2, kXYZW>(c, c.vi(kPacket) + 9);

                // 0x1920: XGKICK vi2. The interpreter's default model copies the whole packet at
                // kick time, so this is a complete GIF submission (the entry check refuses the
                // cycle-exact model, under which back-to-back kicks would drop packets). With
                // PS2X_VU1_HOST_DRAW=1 the packet is drawn through the host hook instead; the
                // counter counts the triangle either way so [vu1-stats] stays comparable.
                g_xgkickDecoded.fetch_add(1, std::memory_order_relaxed);
                if (!hostDraw || !submitHostTriangleFromPacket(c, c.vi(kPacket), screenXY))
                    c.vu.startXgkick(static_cast<uint32_t>(static_cast<uint16_t>(c.vi(kPacket))));
            }

            // 0x1930-0x1940: next triangle.
            c.vi(kTriangles) = vi16(c.vi(kTriangles) - 1);
            c.vi(kIndexCursor) = vi16(c.vi(kIndexCursor) + 2);
            if (!(static_cast<int16_t>(c.vi(kTriangles)) > 0))
                break;
        }

        // 0x1950-0x1960: hand the swapped buffer bases back to data qword 329.
        storeIntWord<kX>(c, 329, c.vi(kPacket));
        storeIntWord<kY>(c, 329, c.vi(kOtherPacket));
        return true;                                             // 0x1958: B 0x1b60
    }

    bool cmdBuildPacket(Ctx &c)
    {
        using namespace packet;
        loadQword<kBias, kXYZW>(c, 38);                          // 0x1780: (1, 1, 1, 0.5)
        loadQword<kGifTag, kXYZW>(c, c.vi(1) + 1);               // 0x1788: TOP+1
        return buildPacketBody(c);                               // falls into 0x1790
    }

    // ---- command 0x40 -> 0x1968: the same triangles again, untextured ----------------------
    //
    // Three pairs (research/15 3): load the GIFtag template from data qword 26 and branch into
    // 0x28's body at 0x1790. So 0x40 draws the same index list from the same staging array as
    // 0x28, and differs from it in exactly two ways.
    //
    // One is the tag. Qword 26 is `00008000 3025c000 00000412 00000000` in all 38 dumps -- the
    // same PACKED (ST, RGBAQ, XYZF2) x 3 with PRE set that 0x28's TOP+1 template carries, and the
    // same NLOOP patch to 3 -- except that its PRIM is 0x4B rather than 0x7B: TME 0 and FGE 0,
    // i.e. untextured and unfogged.
    //
    // The other is the trap. 0x40 enters PAST 0x1780's `LQ vf20, 38(vi0)`, so the RGBAQ
    // computation that 0x1790's ADDAw and 0x1880's MADD perform runs on a vf20 INHERITED from
    // whatever handler ran before it -- there is no vf20 of 0x40's own. In all 38 dispatches that
    // handler is 0x08, whose software-pipelined loop exits with vf20 holding one qword past the
    // end of the vertex block, data[TOP+4 + 3*(TOP+2.z + 2)]; in every one of the 38 that lands
    // inside the index list, on four small integers which reinterpreted as floats are denormals,
    // which the VU flushes to zero. Hence ACC.xyz = 0, R' = G' = B' = 0, and A' = A * qword 327.w:
    // 798 packets, 2394 vertices, exactly one distinct (R,G,B) triple in the whole corpus, (0,0,0).
    //
    // None of that is hardcoded here, deliberately. The inheritance is reproduced instead -- this
    // handler does not load vf20, and buildPacketBody computes ACC.xyz from the inherited vf20.w
    // before 0x17d8 overwrites vf20.w from qword 327, exactly as the microcode does -- because
    // "RGB comes out black" is a property of this corpus's data, not of the microcode, and the
    // first list that puts a different handler in front of 0x40 would break a shortcut. The
    // denormal flush is the interpreter's own: fmac normalises its vft operand through
    // vu1ops::normalize4, the same normalizeOperand semantics the microcode path uses, so the
    // zeros are produced rather than assumed.
    //
    // Everything else -- the index walk, the two visibility gates, the 290/300 ping-pong and its
    // write-back to qword 329, one XGKICK per surviving triangle -- is 0x28's, unchanged.
    bool cmdDrawUntexturedTriangles(Ctx &c)
    {
        using namespace packet;
        // Clamp: 0x17d0's triangle count, read before the shim's LQ, so the hand-back is clean.
        // The loop exits on `IBGTZ`, so zero is safe and only the ceiling matters; the corpus
        // maximum over the 38 dispatches is 73, inside kMaxTriangles = 256 (research/15 7).
        if (!withinCeiling(c.loadWord(c.vi(1) + 2, 3), triangleCeiling()))
            return handBackAtNextCommand(c);
        loadQword<kGifTag, kXYZW>(c, 26);                        // 0x1968
        return buildPacketBody(c);                               // 0x1970: B 0x1790
    }

    // Clamp wrapper for 0x28 as a *dispatched* command: 0x17d0's triangle count, checked before
    // 0x17b0's stores so the hand-back is clean. 0x1780 is also the tail target of command 0x30's
    // `JR vi6`, and on that path a hand-back would not be clean -- 0x30 has already kicked its
    // inline block and rescaled the staging array in place -- so 0x30 does this check itself, at
    // its own entry, and the tail jump goes to the unwrapped body.
    bool cmdBuildPacketDispatched(Ctx &c)
    {
        if (!withinCeiling(c.loadWord(c.vi(1) + 2, 3), triangleCeiling()))
            return handBackAtNextCommand(c);
        return cmdBuildPacket(c);
    }

    // ---- the shared packet-flush tail 0x1980, and command 0x2a -> 0x1a78 --------------------
    //
    // Converts a run of staging triples into GS-format ones and kicks them. Entered with vi3 = the
    // staging base, vi4 = the packet-body base and vi9 = the vertex count. Per vertex:
    //   +0 ST     copied verbatim (the PACKED ST descriptor takes floats)
    //   +1 RGBAQ  (source * (1,1,1,alphaScale)) + (0.5,0.5,0.5,0), then FTOI0 -- round-to-nearest
    //             on R,G,B and truncate on A, the alpha scale being data qword 327's .w
    //   +2 XYZF2  FTOI4 -- float to 12.4 fixed point
    // then XGKICK 423 (the NLOOP=0/EOP=1 terminator tag) followed by XGKICK of the GIFtag one
    // qword below the body base, i.e. qword 112, which command 0x02 built (research/13 4.6).
    //
    // The microcode pipelines this one vertex deep, so it over-reads one staging triple past the
    // end and leaves vi3 three qwords past where a naive loop would: reproduced here, because the
    // registers and the source cursor are part of the compared end-of-program state.
    namespace flush
    {
        constexpr uint8_t kBias = 28;      // data qword 38 = (1,1,1,0.5); .w replaced from 327
        constexpr uint8_t kSrcSt = 17, kSrcRgba = 18, kSrcXyz = 19;  // the staging triple in flight
        constexpr uint8_t kBiasedRgba = 31;                          // RGBAQ before FTOI0
        constexpr uint8_t kOutSt = 21, kOutRgba = 29, kOutXyz = 30;  // the GS-format triple
        constexpr uint8_t kSrcCursor = 3;  // vi3, stride 3
        constexpr uint8_t kDstCursor = 4;  // vi4, stride 3
        constexpr uint8_t kRemaining = 9;  // vi9
        constexpr uint8_t kTag = 5;        // vi5 = vi4 - 1: the GIFtag qword that gets kicked
        constexpr uint8_t kTermTag = 6;    // vi6 = 423
    }

    bool flushTail(Ctx &c)
    {
        using namespace flush;
        using vu1ops::ArithAdd;
        using vu1ops::ArithMadd;
        using vu1ops::ArithSub;
        __m128 up;

        loadQword<kBias, kXYZW>(c, 38);                          // 0x1980

        // 0x1988-0x1990: ACC becomes the rounding bias (0.5, 0.5, 0.5, 0) -- the .w lane is
        // vf0.w - vf0.w, an exact zero, so alpha is truncated rather than rounded -- and vf28's
        // own .w is replaced by the alpha scale from the colour template at qword 327.
        up = fmac<ArithAdd, Vu1Gen::SrcBc, 3, kXYZ, 0, kBias, false, false, true>(c);
        loadQword<kSrcRgba, kXYZW>(c, c.vi(kSrcCursor) + 1);
        writeAcc<kXYZ>(c, up);
        up = fmac<ArithSub, Vu1Gen::SrcBc, 3, kW, 0, 0, false, false, false>(c);
        loadQword<kBias, kW>(c, 327);
        writeAcc<kW>(c, up);

        c.vi(kTag) = vi16(c.vi(kDstCursor) - 1);                 // 0x1998
        loadQword<kSrcXyz, kXYZW>(c, c.vi(kSrcCursor) + 2);      // 0x19a0
        loadQword<kSrcSt, kXYZW>(c, c.vi(kSrcCursor) + 0);       // 0x19a8

        // 0x19b0-0x19e8: convert the first vertex and fetch the second, so the loop below always
        // has a converted triple ready to store.
        up = fmac<ArithMadd, Vu1Gen::SrcVt, 0, kXYZW, kSrcRgba, kBias>(c);
        writeVf<kBiasedRgba, kXYZW>(c, up);
        up = ftoi<4, kSrcXyz>(c);
        c.vi(kSrcCursor) = vi16(c.vi(kSrcCursor) + 3);
        writeVf<kOutXyz, kXYZW>(c, up);
        up = fmac<ArithAdd, Vu1Gen::SrcBc, 0, kXYZW, kSrcSt, 0, false, true, false>(c);
        writeVf<kOutSt, kXYZW>(c, up);
        loadQword<kSrcRgba, kXYZW>(c, c.vi(kSrcCursor) + 1);
        up = ftoi<0, kBiasedRgba>(c);
        loadQword<kSrcXyz, kXYZW>(c, c.vi(kSrcCursor) + 2);
        writeVf<kOutRgba, kXYZW>(c, up);
        loadQword<kSrcSt, kXYZW>(c, c.vi(kSrcCursor) + 0);
        c.vi(kSrcCursor) = vi16(c.vi(kSrcCursor) + 3);

        for (;;)
        {
            // 0x19f0-0x1a00: store the triple converted last time round ...
            up = fmac<ArithMadd, Vu1Gen::SrcVt, 0, kXYZW, kSrcRgba, kBias>(c);
            storeQword<kOutXyz, kXYZW>(c, c.vi(kDstCursor) + 2);
            writeVf<kBiasedRgba, kXYZW>(c, up);
            storeQword<kOutRgba, kXYZW>(c, c.vi(kDstCursor) + 1);
            storeQword<kOutSt, kXYZW>(c, c.vi(kDstCursor) + 0);

            // 0x1a08-0x1a28: ... while the next one converts and the one after it loads.
            up = ftoi<4, kSrcXyz>(c);
            loadQword<kSrcRgba, kXYZW>(c, c.vi(kSrcCursor) + 1);
            writeVf<kOutXyz, kXYZW>(c, up);
            up = fmac<ArithAdd, Vu1Gen::SrcBc, 0, kXYZW, kSrcSt, 0, false, true, false>(c);
            loadQword<kSrcXyz, kXYZW>(c, c.vi(kSrcCursor) + 2);
            writeVf<kOutSt, kXYZW>(c, up);
            loadQword<kSrcSt, kXYZW>(c, c.vi(kSrcCursor) + 0);
            up = ftoi<0, kBiasedRgba>(c);
            c.vi(kRemaining) = vi16(c.vi(kRemaining) - 1);
            writeVf<kOutRgba, kXYZW>(c, up);
            c.vi(kDstCursor) = vi16(c.vi(kDstCursor) + 3);

            // 0x1a30 `IBGTZ vi9, 0x19f0`, with the source-cursor step in its delay slot.
            const bool more = static_cast<int16_t>(c.vi(kRemaining)) > 0;
            c.vi(kSrcCursor) = vi16(c.vi(kSrcCursor) + 3);
            if (!more)
                break;
        }

        // 0x1a40-0x1a58: the terminator tag, then the primitive's own packet.
        c.vi(kTermTag) = 423;
        g_xgkickDecoded.fetch_add(1, std::memory_order_relaxed);
        c.vu.startXgkick(static_cast<uint32_t>(static_cast<uint16_t>(c.vi(kTermTag))));
        g_xgkickDecoded.fetch_add(1, std::memory_order_relaxed);
        c.vu.startXgkick(static_cast<uint32_t>(static_cast<uint16_t>(c.vi(kTag))));
        return true;                                             // 0x1a68: B 0x1b60
    }

    // Command 0x2a: point the tail at the family-B staging array and the qword-112 packet, behind
    // a visibility gate that ORs the global draw gate (qword 39.w, set by 0x72/0x74) with the
    // per-primitive software flag command 0x02 stashed in the GIFtag's REGS[8..15] word. The gate
    // passed on all 961 entries in the research corpus; the "draw nothing" path exists but was
    // never exercised there (research/13 4.6).
    bool cmdFlushPacket(Ctx &c)
    {
        using namespace flush;

        c.vi(kDstCursor) = 113;                                  // 0x1a78
        c.vi(kTag) = c.loadWord(c.vi(kDstCursor) - 1, 3);        // 0x1a80: qword 112 .w
        c.vi(kTermTag) = c.loadWord(39, 3);                      // 0x1a88: the global draw gate
        c.vi(kSrcCursor) = 150;                                  // 0x1a90
        c.vi(kRemaining) = vi16(c.vi(10));                       // 0x1a98
        c.vi(kTermTag) = c.vi(kTermTag) | c.vi(kTag);            // 0x1aa8

        // 0x1ab8 `IBNE vi6, vi0, 0x1980`; falling through is 0x1ac8's `B 0x1b60`.
        if (static_cast<int16_t>(c.vi(kTermTag)) == 0)
            return true;
        return flushTail(c);
    }

    // Clamp wrapper for 0x2a as a *dispatched* command: 0x1a98's count is the clipper's vi10.
    // 0x1a78 is also command 0x32's `JR vi6` tail target, where a hand-back would not be clean, so
    // 0x32 makes the same check at its own entry and tail-jumps to the unwrapped body.
    bool cmdFlushPacketDispatched(Ctx &c)
    {
        if (!withinCeiling(vi16(c.vi(10)), clippedVertexCeiling()))
            return handBackAtNextCommand(c);
        return cmdFlushPacket(c);
    }

    // ---- command 0x06 -> 0x1638: backface cull ---------------------------------------------
    //
    // Sets bit 0 of every triangle's flag word -- the gate command 0x28 reads -- from the sign of
    // dot(eye - vertex, normal). The eye position is data qword 30 (research/07's cull eye); the
    // index list is the same two-qword-per-triangle one 0x28 walks, with the reference vertex
    // index in .x of qword 0 and the normal, in 15-bit fixed point, in qword 1.
    //
    // The sign test is the microcode's own: `FMAND vi13, vi5` with vi5 = 16 reads the S flag of
    // the w lane of the MAC register, i.e. the sign of the dot product that the MADDz.w four pairs
    // earlier produced. Four pairs is exactly the FMAC latency, so the interpreter has that entry
    // committed at the FMAND and no other FMAC is in flight -- this file's immediate flag commit
    // reads the same value.
    // That holds whatever ran before 0x1638 (entry 0x33c8's repack or 0x66, research/82 "N1b", as
    // well as 0x1b50's 0x70), because it depends on nothing outside this loop: the pairs between the
    // MADDz.w at 0x16f8 and the FMAND at 0x1718 are a NOP, an ITOF15 and a NOP, none of which queues
    // a flag entry (the interpreter pushes one only for an FMAC with a dest; ITOF/FTOI/MR32 push
    // none); every pair advances m_cycle by at least one, so the FMAND issues at least kFmacLatency
    // (4) cycles after the MADDz.w, whose entry is then ready; and flag entries land in issue order,
    // so every older one -- the previous command's last FMAC is 20+ pairs back, behind the
    // dispatcher and this prologue -- has landed before it. MAC at the FMAND is therefore the
    // MADDz.w's in both models, on the first pass and every later one.
    namespace cull
    {
        constexpr uint8_t kEye = 26;     // data qword 30
        constexpr uint8_t kNormal = 29;  // the triangle normal (ITOF15 of the index qword +1)
        constexpr uint8_t kVertex = 28;  // the reference vertex's position
        constexpr uint8_t kToEye = 27;   // eye - vertex
        constexpr uint8_t kDot = 30;     // the product, then its .w = x + y + z
        constexpr uint8_t kRecordBase = 3;  // vi3 = TOP+4
        constexpr uint8_t kIndexCursor = 4; // vi4, two qwords per triangle
        constexpr uint8_t kRemaining = 9;   // vi9
        constexpr uint8_t kMacSignW = 5;    // vi5 = 16: the MAC bit for the w lane's sign
        constexpr uint8_t kScratch = 8, kVertexPtr = 11, kFlags = 12, kSign = 13;
    }

    bool cmdBackfaceCull(Ctx &c)
    {
        using namespace cull;
        using vu1ops::ArithMadd;
        using vu1ops::ArithMul;
        using vu1ops::ArithSub;
        __m128 up;

        // Clamp: 0x1640's triangle count.
        if (!withinCeiling(c.loadWord(c.vi(1) + 2, 3), triangleCeiling()))
            return handBackAtNextCommand(c);

        c.vi(kIndexCursor) = c.loadWord(c.vi(1) + 2, 0);         // 0x1638: TOP+2.x
        c.vi(kRemaining) = c.loadWord(c.vi(1) + 2, 3);           // 0x1640: TOP+2.w
        loadQword<kEye, kXYZW>(c, 30);                           // 0x1648
        c.vi(kRecordBase) = vi16(c.vi(1) + 4);                   // 0x1650
        c.vi(kIndexCursor) = vi16(c.vi(kIndexCursor) + c.vi(1)); // 0x1658

        // 0x1660-0x16a8: the first triangle's normal and reference vertex.
        c.vi(kScratch) = c.loadWord(c.vi(kIndexCursor), 0);
        loadQword<kNormal, kXYZW>(c, c.vi(kIndexCursor) + 1);
        c.vi(kMacSignW) = 16;
        c.vi(kVertexPtr) = vi16(c.vi(kRecordBase) + c.vi(kScratch));
        up = itof<15, kNormal>(c);
        loadQword<kVertex, kXYZW>(c, c.vi(kVertexPtr));
        writeVf<kNormal, kXYZW>(c, up);
        up = fmac<ArithSub, Vu1Gen::SrcVt, 0, kXYZW, kEye, kVertex>(c);
        writeVf<kToEye, kXYZW>(c, up);

        for (;;)
        {
            // 0x16c8-0x16f8: dot(eye - vertex, normal) in .w, while the next triangle's normal and
            // reference vertex are fetched.
            up = fmac<ArithMul, Vu1Gen::SrcVt, 0, kXYZW, kToEye, kNormal, false, false, false>(c);
            c.vi(kScratch) = c.loadWord(c.vi(kIndexCursor) + 2, 0);
            writeVf<kDot, kXYZW>(c, up);
            loadQword<kNormal, kXYZW>(c, c.vi(kIndexCursor) + 3);
            c.vi(kFlags) = c.loadWord(c.vi(kIndexCursor), 3);
            up = fmac<ArithMul, Vu1Gen::SrcBc, 0, kW, 0, kDot, false, false, false>(c);
            c.vi(kVertexPtr) = vi16(c.vi(kRecordBase) + c.vi(kScratch));
            writeAcc<kW>(c, up);
            up = fmac<ArithMadd, Vu1Gen::SrcBc, 1, kW, 0, kDot, false, false, false>(c);
            loadQword<kVertex, kXYZW>(c, c.vi(kVertexPtr));
            writeAcc<kW>(c, up);
            up = fmac<ArithMadd, Vu1Gen::SrcBc, 2, kW, 0, kDot, false, false, false>(c);
            c.vi(kScratch) = 32766;
            writeVf<kDot, kW>(c, up);

            // 0x1700-0x1738: clear the visibility bit, set it again unless the dot came out
            // negative, and write the flag word back.
            c.vi(kFlags) = c.vi(kFlags) & c.vi(kScratch);
            up = itof<15, kNormal>(c);
            c.vi(kScratch) = 1;
            writeVf<kNormal, kXYZW>(c, up);
            c.vi(kSign) = fmand(c, c.vi(kMacSignW));
            if (!(static_cast<int16_t>(c.vi(kSign)) > 0))
                c.vi(kFlags) = c.vi(kFlags) | c.vi(kScratch);
            storeIntWord<kW>(c, c.vi(kIndexCursor), c.vi(kFlags));

            // 0x1740-0x1750: the next triangle's eye vector, then loop.
            up = fmac<ArithSub, Vu1Gen::SrcVt, 0, kXYZW, kEye, kVertex>(c);
            c.vi(kRemaining) = vi16(c.vi(kRemaining) - 1);
            writeVf<kToEye, kXYZW>(c, up);
            c.vi(kIndexCursor) = vi16(c.vi(kIndexCursor) + 2);
            if (!(static_cast<int16_t>(c.vi(kRemaining)) > 0))
                return true;                                     // 0x1760: B 0x1b60
        }
    }

    // ---- 0x3618: the five-plane Sutherland-Hodgman clipper ---------------------------------
    //
    // Called only from command 0x02's `BAL vi15, 0x3618`, once per front-facing primitive, and by
    // a wide margin the most expensive thing in a family-B list (60 % of all VU1 work in the
    // research corpus). It clips the triangle against five planes in turn, ping-ponging between
    // the buffers at data qwords 40 and 76, and hands back vi8 = the surviving polygon's base
    // qword and vi10 = its vertex count (research/13 4.4).
    //
    // Each vertex is three qwords -- position, texture coordinates, colour -- and all three are
    // interpolated with the same parameter, so the helpers below move them as a unit.
    namespace clip
    {
        // Registers whose role is stable across the whole subroutine.
        constexpr uint8_t kMask = 4;      // vi4: the plane-enable mask from qword 27.x -- dead
        constexpr uint8_t kInBuffer = 5;  // vi5: the stage's input buffer base (40 or 76)
        constexpr uint8_t kOutBuffer = 6; // vi6: ... its output buffer base, swapped per stage
        constexpr uint8_t kLink = 2;      // vi2: the BAL link register of the two inner helpers
        constexpr uint8_t kRead = 8;      // vi8: the input cursor; also the returned polygon base
        constexpr uint8_t kWrite = 9;     // vi9: the output cursor
        constexpr uint8_t kInCount = 10;  // vi10: input vertices left in this stage
        constexpr uint8_t kOutCount = 11; // vi11: vertices this stage has emitted
        constexpr uint8_t kSide = 13;     // vi13: the edge's code, 0 | 16 | 32 | 48
        constexpr uint8_t kSideC = 7;     // vi7: its C half, then the 48 and 16 constants

        // The edge's two endpoints while the helper runs: P (the previous vertex, saved) and C
        // (the next one, loaded over P's registers), plus the plane and the working distances.
        constexpr uint8_t kPrev0 = 17, kPrev1 = 18, kPrev2 = 19;
        constexpr uint8_t kCurr0 = 21, kCurr1 = 22, kCurr2 = 23;
        constexpr uint8_t kPlanePoint = 28, kPlaneNormal = 30;
        constexpr uint8_t kDistC = 25, kDistP = 26, kLerp2 = 27;
    }

    // 0x3a90 -- close the polygon: append a copy of output vertex 0 after the last emitted one,
    // so the next stage's edge loop wraps. vi8 = the output buffer base, vi9 = the write cursor.
    void clipClosePolygon(Ctx &c)
    {
        using namespace clip;
        loadQword<kCurr0, kXYZW>(c, c.vi(kRead) + 0);
        loadQword<kCurr1, kXYZW>(c, c.vi(kRead) + 1);
        loadQword<kCurr2, kXYZW>(c, c.vi(kRead) + 2);
        storeQword<kCurr0, kXYZW>(c, c.vi(kWrite)); c.vi(kWrite) = vi16(c.vi(kWrite) + 1);
        storeQword<kCurr1, kXYZW>(c, c.vi(kWrite)); c.vi(kWrite) = vi16(c.vi(kWrite) + 1);
        storeQword<kCurr2, kXYZW>(c, c.vi(kWrite)); c.vi(kWrite) = vi16(c.vi(kWrite) + 1);
    }

    // 0x3ad0 -- clip one edge P->C against the current plane, appending 0, 1 or 2 vertices at the
    // output cursor. The hot loop: 12,492 calls and ~46 % of all pair-executions in the corpus.
    void clipOneEdge(Ctx &c)
    {
        using namespace clip;
        using vu1ops::ArithAdd;
        using vu1ops::ArithMadd;
        using vu1ops::ArithMul;
        using vu1ops::ArithSub;
        __m128 up;

        // 0x3ad0-0x3ae0: P moves into vf17-19 (`ADDx vf0.x` -- a copy that still pushes FMAC
        // flags) while C loads over vf21-23.
        up = fmac<ArithAdd, Vu1Gen::SrcBc, 0, kXYZW, kCurr0, 0, false, true, false>(c);
        loadQword<kCurr0, kXYZW>(c, c.vi(kRead)); c.vi(kRead) = vi16(c.vi(kRead) + 1);
        writeVf<kPrev0, kXYZW>(c, up);
        up = fmac<ArithAdd, Vu1Gen::SrcBc, 0, kXYZW, kCurr1, 0, false, true, false>(c);
        loadQword<kCurr1, kXYZW>(c, c.vi(kRead)); c.vi(kRead) = vi16(c.vi(kRead) + 1);
        writeVf<kPrev1, kXYZW>(c, up);
        up = fmac<ArithAdd, Vu1Gen::SrcBc, 0, kXYZW, kCurr2, 0, false, true, false>(c);
        loadQword<kCurr2, kXYZW>(c, c.vi(kRead)); c.vi(kRead) = vi16(c.vi(kRead) + 1);
        writeVf<kPrev2, kXYZW>(c, up);

        // 0x3ae8-0x3b58: the two signed plane distances, dot((vertex - point), normal): dC in
        // vf25 (.w, then copied to .z) and dP in vf26 (.w).
        up = fmac<ArithSub, Vu1Gen::SrcVt, 0, kXYZW, kCurr0, kPlanePoint>(c);
        writeVf<kDistC, kXYZW>(c, up);
        up = fmac<ArithSub, Vu1Gen::SrcVt, 0, kXYZW, kPrev0, kPlanePoint>(c);
        writeVf<kDistP, kXYZW>(c, up);
        up = fmac<ArithMul, Vu1Gen::SrcVt, 0, kXYZ, kDistC, kPlaneNormal, false, false, true>(c);
        writeVf<kDistC, kXYZ>(c, up);
        up = fmac<ArithMul, Vu1Gen::SrcVt, 0, kXYZ, kDistP, kPlaneNormal, false, false, true>(c);
        writeVf<kDistP, kXYZ>(c, up);
        up = fmac<ArithMul, Vu1Gen::SrcBc, 0, kW, 0, kDistC, false, false, false>(c);
        writeAcc<kW>(c, up);
        up = fmac<ArithMadd, Vu1Gen::SrcBc, 1, kW, 0, kDistC, false, false, true>(c);
        c.vi(kSideC) = 32;                                       // 0x3b30: the MAC bit for Sz
        writeAcc<kW>(c, up);
        up = fmac<ArithMadd, Vu1Gen::SrcBc, 2, kW, 0, kDistC, false, false, true>(c);
        writeVf<kDistC, kW>(c, up);
        up = fmac<ArithAdd, Vu1Gen::SrcBc, 3, kZ, 0, kDistC, false, false, false>(c);
        const uint32_t macDistC = c.vu.m_state.mac;              // 0x3b40, read by the first FMAND
        writeVf<kDistC, kZ>(c, up);
        up = fmac<ArithMul, Vu1Gen::SrcBc, 0, kW, 0, kDistP, false, false, true>(c);
        writeAcc<kW>(c, up);
        up = fmac<ArithMadd, Vu1Gen::SrcBc, 1, kW, 0, kDistP, false, false, true>(c);
        writeAcc<kW>(c, up);
        up = fmac<ArithMadd, Vu1Gen::SrcBc, 2, kW, 0, kDistP, false, false, true>(c);
        const uint32_t macDistP = c.vu.m_state.mac;              // 0x3b58, read by the second
        writeVf<kDistP, kW>(c, up);

        // 0x3b60-0x3b88: the side code. FMAC flags are four pairs deep, so the FMAND at 0x3b60
        // reads the flags of the ADDw.z at 0x3b40 (dC's sign, MAC bit 5 = Sz) and the one at
        // 0x3b78 those of the MADDz.w at 0x3b58 (dP's sign, MAC bit 4 = Sw) -- hence the two
        // captured MAC values above rather than the newest one.
        //
        // Taking the sign from the VU's own MAC bit, instead of comparing the float with zero, is
        // also what settles -0.0 (research/13 open question 4, not exercised by the corpus): the
        // MAC sign bit is set for -0.0, so such a lane counts as OUTSIDE, where `dC < 0.0f` would
        // have called it inside. Everything here goes through vu1ops::fmacArith, which is the
        // interpreter's own flag arithmetic, so the two agree by construction rather than by a
        // rule restated here.
        c.vi(kSideC) = fmandWith(macDistC, c.vi(kSideC));        // 0x3b60: 32 iff dC < 0
        c.vi(kSide) = 16;                                        // 0x3b68
        up = fmac<ArithSub, Vu1Gen::SrcBc, 2, kW, kDistP, kDistC>(c);  // 0x3b78: vf25.w = dP - dC
        c.vi(kSide) = fmandWith(macDistP, c.vi(kSide));          // 16 iff dP < 0
        writeVf<kDistC, kW>(c, up);
        up = fmac<ArithSub, Vu1Gen::SrcBc, 3, kZ, kDistC, kDistP>(c);  // 0x3b80: vf26.z = dC - dP
        c.vi(kSide) = c.vi(kSide) | c.vi(kSideC);
        writeVf<kDistP, kZ>(c, up);
        c.vi(kSideC) = 48;                                       // 0x3b88

        // 0x3b90 `IBEQ vi13, vi0, 0x3cf8` with `DIV Q, vf26w, vf25w` (= dP / (dP - dC)) in its
        // delay slot: the divide is issued on every path, including the two that never use it.
        const bool bothInside = static_cast<int16_t>(c.vi(kSide)) == 0;
        divQ<kDistP, 3, kDistC, 3>(c);
        if (bothInside)
        {
            // 0x3cf8: P is emitted unchanged, C becomes the next call's P.
            storeQword<kPrev0, kXYZW>(c, c.vi(kWrite)); c.vi(kWrite) = vi16(c.vi(kWrite) + 1);
            storeQword<kPrev1, kXYZW>(c, c.vi(kWrite)); c.vi(kWrite) = vi16(c.vi(kWrite) + 1);
            storeQword<kPrev2, kXYZW>(c, c.vi(kWrite)); c.vi(kWrite) = vi16(c.vi(kWrite) + 1);
            c.vi(kOutCount) = vi16(c.vi(kOutCount) + 1);
            return;
        }

        // 0x3ba0: 48 -- both outside, nothing is emitted.
        if (static_cast<int16_t>(c.vi(kSide)) == static_cast<int16_t>(c.vi(kSideC)))
            return;

        c.vi(kSideC) = 16;                                       // 0x3bb0
        if (static_cast<int16_t>(c.vi(kSide)) != static_cast<int16_t>(c.vi(kSideC)))
        {
            // 0x3c68: 32 -- P inside, C outside. Emit P, then the crossing point
            // I = P + (C - P) * Q with the Q the delay slot above computed.
            up = fmac<ArithSub, Vu1Gen::SrcVt, 0, kXYZW, kCurr0, kPrev0>(c);
            writeVf<kDistC, kXYZW>(c, up);
            up = fmac<ArithSub, Vu1Gen::SrcVt, 0, kXYZW, kCurr1, kPrev1>(c);
            writeVf<kDistP, kXYZW>(c, up);
            up = fmac<ArithSub, Vu1Gen::SrcVt, 0, kXYZW, kCurr2, kPrev2>(c);
            writeVf<kLerp2, kXYZW>(c, up);
            storeQword<kPrev0, kXYZW>(c, c.vi(kWrite)); c.vi(kWrite) = vi16(c.vi(kWrite) + 1);
            up = fmac<ArithMul, Vu1Gen::SrcQ, 0, kXYZW, kDistC, 0, false, false, false>(c);
            writeVf<kDistC, kXYZW>(c, up);
            up = fmac<ArithMul, Vu1Gen::SrcQ, 0, kXYZW, kDistP, 0, false, false, false>(c);
            writeVf<kDistP, kXYZW>(c, up);
            up = fmac<ArithMul, Vu1Gen::SrcQ, 0, kXYZW, kLerp2, 0, false, false, false>(c);
            writeVf<kLerp2, kXYZW>(c, up);
            storeQword<kPrev1, kXYZW>(c, c.vi(kWrite)); c.vi(kWrite) = vi16(c.vi(kWrite) + 1);
            up = fmac<ArithAdd, Vu1Gen::SrcVt, 0, kXYZW, kDistC, kPrev0, false, false, true>(c);
            writeVf<kDistC, kXYZW>(c, up);
            up = fmac<ArithAdd, Vu1Gen::SrcVt, 0, kXYZW, kDistP, kPrev1, false, false, true>(c);
            writeVf<kDistP, kXYZW>(c, up);
            up = fmac<ArithAdd, Vu1Gen::SrcVt, 0, kXYZW, kLerp2, kPrev2, false, false, true>(c);
            writeVf<kLerp2, kXYZW>(c, up);
            storeQword<kPrev2, kXYZW>(c, c.vi(kWrite)); c.vi(kWrite) = vi16(c.vi(kWrite) + 1);
            storeQword<kDistC, kXYZW>(c, c.vi(kWrite)); c.vi(kWrite) = vi16(c.vi(kWrite) + 1);
            storeQword<kDistP, kXYZW>(c, c.vi(kWrite)); c.vi(kWrite) = vi16(c.vi(kWrite) + 1);
            storeQword<kLerp2, kXYZW>(c, c.vi(kWrite)); c.vi(kWrite) = vi16(c.vi(kWrite) + 1);
            c.vi(kOutCount) = vi16(c.vi(kOutCount) + 2);
            return;
        }

        // 0x3bd0: 16 -- P outside, C inside. Q is recomputed the other way round,
        // dC / (dC - dP), and only the crossing point I = C + (P - C) * Q is emitted.
        divQ<kDistC, 2, kDistP, 2>(c);
        up = fmac<ArithSub, Vu1Gen::SrcVt, 0, kXYZW, kPrev0, kCurr0>(c);
        writeVf<kDistC, kXYZW>(c, up);
        up = fmac<ArithSub, Vu1Gen::SrcVt, 0, kXYZW, kPrev1, kCurr1>(c);
        writeVf<kDistP, kXYZW>(c, up);
        up = fmac<ArithSub, Vu1Gen::SrcVt, 0, kXYZW, kPrev2, kCurr2>(c);
        writeVf<kLerp2, kXYZW>(c, up);
        // 0x3bf0 WAITQ: the divide above has landed, which immediate commit makes a no-op here.
        up = fmac<ArithMul, Vu1Gen::SrcQ, 0, kXYZW, kDistC, 0, false, false, false>(c);
        writeVf<kDistC, kXYZW>(c, up);
        up = fmac<ArithMul, Vu1Gen::SrcQ, 0, kXYZW, kDistP, 0, false, false, false>(c);
        writeVf<kDistP, kXYZW>(c, up);
        up = fmac<ArithMul, Vu1Gen::SrcQ, 0, kXYZW, kLerp2, 0, false, false, false>(c);
        writeVf<kLerp2, kXYZW>(c, up);
        up = fmac<ArithAdd, Vu1Gen::SrcVt, 0, kXYZW, kDistC, kCurr0, false, false, true>(c);
        writeVf<kDistC, kXYZW>(c, up);
        up = fmac<ArithAdd, Vu1Gen::SrcVt, 0, kXYZW, kDistP, kCurr1, false, false, true>(c);
        writeVf<kDistP, kXYZW>(c, up);
        up = fmac<ArithAdd, Vu1Gen::SrcVt, 0, kXYZW, kLerp2, kCurr2, false, false, true>(c);
        writeVf<kLerp2, kXYZW>(c, up);
        storeQword<kDistC, kXYZW>(c, c.vi(kWrite)); c.vi(kWrite) = vi16(c.vi(kWrite) + 1);
        storeQword<kDistP, kXYZW>(c, c.vi(kWrite)); c.vi(kWrite) = vi16(c.vi(kWrite) + 1);
        storeQword<kLerp2, kXYZW>(c, c.vi(kWrite)); c.vi(kWrite) = vi16(c.vi(kWrite) + 1);
        c.vi(kOutCount) = vi16(c.vi(kOutCount) + 1);
    }

    // One clip stage: read the previous stage's polygon out of one buffer and write the clipped
    // one into the other. Returns false when the stage emptied the polygon, which is the
    // subroutine's early return with vi10 == 0.
    //
    // The gate at the head of every stage -- `IAND vi8, vi4, <bit>` immediately followed by
    // `IBEQ vi8, vi0, <next stage>` -- is DEAD. On the VU a branch reading an integer register
    // written by the instruction right before it sees the stale value, here the bit constant,
    // which is never zero; so all five planes are always clipped against and data qword 27.x,
    // which vi4 holds, has no effect at all. Proved by differential run (research/13 4.4). The
    // IAND still runs because vi8 is a compared register until the stage overwrites it.
    //
    // EdgeLink / CloseLink are the two `BAL vi2` return addresses (pc / 8) -- vi2 is compared, and
    // it differs per stage. EarlyOutInDelaySlot marks stages 1 and 2, where the emptiness test
    // sits in the polygon-close BAL's delay slot and a taken branch cancels the call; stages 3-5
    // have a NOP there and test after the call returns.
    template <int32_t MaskBit, int32_t PlanePoint, int32_t PlaneNormal, bool FirstStage,
              int32_t EdgeLink, int32_t CloseLink, bool EarlyOutInDelaySlot>
    bool clipStage(Ctx &c)
    {
        using namespace clip;

        c.vi(kRead) = MaskBit;
        c.vi(kRead) = c.vi(kMask) & c.vi(kRead);                 // the dead gate's IAND
        loadQword<kPlanePoint, kXYZW>(c, PlanePoint);
        loadQword<kPlaneNormal, kXYZW>(c, PlaneNormal);
        c.vi(kRead) = vi16(c.vi(kInBuffer));
        c.vi(kWrite) = vi16(c.vi(kOutBuffer));
        // Stage 1 knows it has the three source vertices; every later stage takes the count the
        // stage before it emitted, immediately before zeroing that counter.
        c.vi(kInCount) = FirstStage ? 3 : vi16(c.vi(kOutCount));
        c.vi(kOutCount) = 0;

        // The first "previous" vertex; the wrap copy at the end of the buffer means vi10 calls to
        // the edge helper cover v0->v1 ... v(vi10-1)->v0.
        loadQword<kCurr0, kXYZW>(c, c.vi(kRead)); c.vi(kRead) = vi16(c.vi(kRead) + 1);
        loadQword<kCurr1, kXYZW>(c, c.vi(kRead)); c.vi(kRead) = vi16(c.vi(kRead) + 1);
        loadQword<kCurr2, kXYZW>(c, c.vi(kRead)); c.vi(kRead) = vi16(c.vi(kRead) + 1);

        do
        {
            c.vi(kLink) = EdgeLink;
            clipOneEdge(c);
            c.vi(kInCount) = vi16(c.vi(kInCount) - 1);
        } while (static_cast<int16_t>(c.vi(kInCount)) != 0);

        c.vi(kRead) = vi16(c.vi(kOutBuffer));
        c.vi(kLink) = CloseLink;
        const bool empty = static_cast<int16_t>(c.vi(kOutCount)) == 0;
        if (EarlyOutInDelaySlot)
        {
            if (empty)
            {
                c.vi(kRead) = vi16(c.vi(kOutBuffer));            // the taken branch's delay slot
                return false;
            }
            clipClosePolygon(c);
            c.vi(kRead) = vi16(c.vi(kOutBuffer));
        }
        else
        {
            clipClosePolygon(c);
            c.vi(kRead) = vi16(c.vi(kOutBuffer));
            if (empty)
                return false;
        }

        // The output becomes the next stage's input.
        c.vi(kOutBuffer) = vi16(c.vi(kInBuffer));
        c.vi(kInBuffer) = vi16(c.vi(kRead));
        return true;
    }

    // Live-in: the triangle's three vertices in vf17/vf18/vf19, vf26/vf27/vf28, vf29/vf30/vf31.
    // Live-out: vi8 = the final polygon's base qword, vi10 = its vertex count (0 when the
    // triangle was clipped away entirely).
    void primSubroutine3618(Ctx &c)
    {
        using namespace clip;
        using vu1ops::ArithMadd;
        using vu1ops::ArithMul;
        __m128 up;

        // 0x3618-0x3690. The local->view transform into vf23/vf24/vf25 and the three CLIPws over
        // its results are DEAD -- vf23 and vf25 are overwritten before any read, vf24 is never
        // read again, and no FCAND/FCOR/FCEQ/FCGET exists anywhere in the image, so the clipping
        // flag register is never consumed (research/13 4.4). They stay because the register file
        // and the clip register are compared. Interleaved with them, the three vertices are laid
        // out at buffer A with vertex 0 repeated at the end: the wrap copy.
        up = fmac<ArithMul, Vu1Gen::SrcBc, 0, kXYZW, 13, 17>(c);
        c.vi(kMask) = c.loadWord(27, 0);                         // the dead plane-enable mask
        writeAcc<kXYZW>(c, up);
        up = fmac<ArithMadd, Vu1Gen::SrcBc, 1, kXYZW, 14, 17>(c);
        c.vi(kInBuffer) = 40;
        writeAcc<kXYZW>(c, up);
        up = fmac<ArithMadd, Vu1Gen::SrcBc, 2, kXYZW, 15, 17>(c);
        c.vi(kRead) = vi16(c.vi(kInBuffer));
        writeAcc<kXYZW>(c, up);
        up = fmac<ArithMadd, Vu1Gen::SrcBc, 3, kXYZW, 16, 0, false, true, false>(c);
        c.vi(kOutBuffer) = 76;
        writeVf<23, kXYZW>(c, up);

        up = fmac<ArithMul, Vu1Gen::SrcBc, 0, kXYZW, 13, 26>(c);
        storeQword<17, kXYZW>(c, c.vi(kRead) + 0);               // vertex 0
        writeAcc<kXYZW>(c, up);
        up = fmac<ArithMadd, Vu1Gen::SrcBc, 1, kXYZW, 14, 26>(c);
        storeQword<18, kXYZW>(c, c.vi(kRead) + 1);
        writeAcc<kXYZW>(c, up);
        up = fmac<ArithMadd, Vu1Gen::SrcBc, 2, kXYZW, 15, 26>(c);
        storeQword<19, kXYZW>(c, c.vi(kRead) + 2);
        writeAcc<kXYZW>(c, up);
        up = fmac<ArithMadd, Vu1Gen::SrcBc, 3, kXYZW, 16, 0, false, true, false>(c);
        storeQword<26, kXYZW>(c, c.vi(kRead) + 3);               // vertex 1
        writeVf<24, kXYZW>(c, up);

        up = fmac<ArithMul, Vu1Gen::SrcBc, 0, kXYZW, 13, 29>(c);
        storeQword<27, kXYZW>(c, c.vi(kRead) + 4);
        writeAcc<kXYZW>(c, up);
        up = fmac<ArithMadd, Vu1Gen::SrcBc, 1, kXYZW, 14, 29>(c);
        storeQword<28, kXYZW>(c, c.vi(kRead) + 5);
        writeAcc<kXYZW>(c, up);
        up = fmac<ArithMadd, Vu1Gen::SrcBc, 2, kXYZW, 15, 29>(c);
        storeQword<29, kXYZW>(c, c.vi(kRead) + 6);               // vertex 2
        writeAcc<kXYZW>(c, up);
        up = fmac<ArithMadd, Vu1Gen::SrcBc, 3, kXYZW, 16, 0, false, true, false>(c);
        storeQword<30, kXYZW>(c, c.vi(kRead) + 7);
        writeVf<25, kXYZW>(c, up);

        clipW<23, 23>(c);
        storeQword<31, kXYZW>(c, c.vi(kRead) + 8);
        clipW<24, 24>(c);
        storeQword<17, kXYZW>(c, c.vi(kRead) + 9);               // the wrap copy of vertex 0
        storeQword<18, kXYZW>(c, c.vi(kRead) + 10);
        clipW<25, 25>(c);
        storeQword<19, kXYZW>(c, c.vi(kRead) + 11);

        // The five planes: qword 31 + normal 32 for the near plane, then the eye (qword 30) with
        // normals 33-36. The mask bits are the ones the dead gates test.
        if (!clipStage<0x20, 31, 32, true, 1761, 1768, true>(c))
            return;
        if (!clipStage<0x02, 30, 33, false, 1785, 1792, true>(c))
            return;
        if (!clipStage<0x01, 30, 34, false, 1809, 1816, false>(c))
            return;
        if (!clipStage<0x08, 30, 35, false, 1834, 1841, false>(c))
            return;
        if (!clipStage<0x04, 30, 36, false, 1859, 1866, false>(c))
            return;

        c.vi(kRead) = vi16(c.vi(kInBuffer));                     // 0x3a70: the final polygon
        c.vi(kInCount) = vi16(c.vi(kOutCount));                  // 0x3a78: its vertex count
    }

    // ---- command 0x02 -> 0x1f70: world-object setup, one primitive per round trip -----------
    //
    // 0x02 walks the two-qword index records: cull test, load the triangle, clip it, build the
    // per-primitive GIFtag at data qword 112, hand back. Command 0x4c (0x20c8) is the loop's back
    // edge -- decrement the primitive counter, restore the index cursor, and either re-enter the
    // body at 0x1f98 (*after* the prologue, so vi12 and vi15 are not recomputed) or end the
    // program. 0x02's own two skip branches, culled and clipped-away, fall into that back edge
    // without a dispatch, which is why both halves live in one function here (research/13 4.3,
    // 4.7).
    namespace world
    {
        constexpr uint8_t kRecordBase = 3;  // vi3 = TOP+4, the vertex block
        constexpr uint8_t kVertex0 = 5, kVertex1 = 6, kVertex2 = 7; // qword offsets, then pointers
        constexpr uint8_t kClipCount = 10;  // vi10: the clipper's vertex count
        constexpr uint8_t kScratch = 11;    // vi11
        constexpr uint8_t kPrimitives = 12; // vi12: the primitive counter, crosses the hand-back
        constexpr uint8_t kFlags = 13;      // vi13: the index record's w word
        constexpr uint8_t kCursor = 15;     // vi15: the index cursor, and the BAL link register

        constexpr int32_t kSavedCursorQword = 329; // .z: vi15 mirrored across the clipper's BAL
        constexpr int32_t kGifTagQword = 112;
        constexpr int32_t kClipReturnLink = 1040;  // 0x2080 / 8, what `BAL vi15, 0x3618` stores
        constexpr uint8_t kYZ = kY | kZ;           // SQ.yz: PRE/PRIM/FLG/NREG and REGS
    }

    Outcome primitiveLoop(Ctx &c, bool startAtBackEdge)
    {
        using namespace world;

        for (bool atBackEdge = startAtBackEdge;; atBackEdge = false)
        {
            if (!atBackEdge)
            {
                // 0x1f98-0x1fd0: this primitive's three vertex offsets and its flag word.
                c.vi(kRecordBase) = vi16(c.vi(1) + 4);
                c.vi(kScratch) = 1;
                c.vi(kFlags) = c.loadWord(c.vi(kCursor), 3);
                c.vi(kVertex0) = c.loadWord(c.vi(kCursor), 0);
                c.vi(kVertex1) = c.loadWord(c.vi(kCursor), 1);
                c.vi(kVertex2) = c.loadWord(c.vi(kCursor), 2);
                c.vi(kScratch) = c.vi(kFlags) & c.vi(kScratch);  // bit 0: command 0x06's cull bit
                c.vi(kCursor) = vi16(c.vi(kCursor) + 2);

                // 0x1fd8 `IBEQ vi11, vi0, 0x20c8`, and 0x1fe0 -- its DELAY SLOT -- saves the
                // cursor to 329.z on BOTH paths. Saving it only when the primitive is visible
                // would leave 329.z at the previous primitive's value and the back edge would
                // rewind the index list; 320 of the corpus's 1224 iterations are culled.
                const bool visible = static_cast<int16_t>(c.vi(kScratch)) != 0;
                storeIntWord<kZ>(c, kSavedCursorQword, c.vi(kCursor));
                if (visible)
                {
                    // 0x1fe8-0x1ff8: the second flag bit, stashed in the GIFtag's REGS[8..15]
                    // word for command 0x2a's gate to read back. With NREG = 3 the GS ignores it.
                    c.vi(kScratch) = 2;
                    c.vi(kFlags) = c.vi(kFlags) & c.vi(kScratch);
                    storeIntWord<kW>(c, kGifTagQword, c.vi(kFlags));

                    // 0x2000-0x2058: the triangle, three qwords per vertex.
                    c.vi(kVertex0) = vi16(c.vi(kRecordBase) + c.vi(kVertex0));
                    loadQword<17, kXYZW>(c, c.vi(kVertex0) + 0);
                    loadQword<18, kXYZW>(c, c.vi(kVertex0) + 1);
                    loadQword<19, kXYZW>(c, c.vi(kVertex0) + 2);
                    c.vi(kVertex1) = vi16(c.vi(kRecordBase) + c.vi(kVertex1));
                    loadQword<26, kXYZW>(c, c.vi(kVertex1) + 0);
                    loadQword<27, kXYZW>(c, c.vi(kVertex1) + 1);
                    loadQword<28, kXYZW>(c, c.vi(kVertex1) + 2);
                    c.vi(kVertex2) = vi16(c.vi(kRecordBase) + c.vi(kVertex2));
                    loadQword<29, kXYZW>(c, c.vi(kVertex2) + 0);
                    loadQword<30, kXYZW>(c, c.vi(kVertex2) + 1);
                    loadQword<31, kXYZW>(c, c.vi(kVertex2) + 2);

                    // 0x2060-0x2070: vi10 = vi11 = 3 is redundant -- the clipper's first stage
                    // sets vi10 itself and zeroes vi11 -- but both registers are written.
                    c.vi(kClipCount) = 3;
                    c.vi(kScratch) = 3;
                    c.vi(kCursor) = kClipReturnLink;             // BAL vi15, 0x3618
                    primSubroutine3618(c);

                    // 0x2080 `IBEQ vi10, vi0, 0x20c8`: clipped away entirely.
                    if (static_cast<int16_t>(c.vi(kClipCount)) != 0)
                    {
                        // 0x2090-0x20b0: the per-primitive GIFtag. NLOOP = the clipped vertex
                        // count with EOP set (`+ 32767` then `+ 1` is the 16-bit wraparound that
                        // sets bit 15), and PRE/PRIM/FLG/NREG plus REGS copied from the
                        // TRIANGLE_FAN template at TOP+0.
                        loadQword<22, kXYZW>(c, c.vi(1));
                        c.vi(kScratch) = vi16(c.vi(kClipCount) + 32767);
                        c.vi(kScratch) = vi16(c.vi(kScratch) + 1);
                        storeIntWord<kX>(c, kGifTagQword, c.vi(kScratch));
                        storeQword<22, kYZ>(c, kGifTagQword);
                        return Outcome::NextCommand;             // 0x20b8: B 0x1b60
                    }
                }
            }

            // 0x20c8-0x20f0: the back edge. Note that 0x20d0's `ILW.z vi15, 329(vi0)` WRITES
            // vi15 -- it restores the cursor the clipper's BAL clobbered.
            c.vi(kPrimitives) = vi16(c.vi(kPrimitives) - 1);
            c.vi(kCursor) = c.loadWord(kSavedCursorQword, 2);
            if (static_cast<int16_t>(c.vi(kPrimitives)) == 0)
                return Outcome::ProgramEnd;                      // 0x2100: B 0x1b40, the E bit

            // 0x20e8 reads `340(vi14)` with vi14 already past the 0x4c command, so the loop
            // target is the y of the qword AFTER it, not 0x4c's own (research/13 3.4). On a
            // fall-in from one of the skip branches above, vi14 is whatever the last *dispatched*
            // command left, so this reads yet another list qword; the loop still lands on the
            // right index only because every command qword in a family-B list carries the same y.
            // Taking the microcode's arithmetic literally keeps that an accident of the guest
            // data rather than something this file has baked in.
            c.vi(14) = c.loadWord(340 + c.vi(14), 1);
        }
    }

    Outcome cmdWorldObject(Ctx &c)
    {
        using namespace world;
        // Clamp: 0x1f78's primitive count, the one that crosses every 0x4c back edge in vi12.
        // 0x4c decrements it and tests `== 0`, so a zero or negative count is 65536 primitives,
        // each of them a clipper call and up to three XGKICKs. This is the one family-B clamp
        // whose hand-back research/13 6.3 licenses outright: "immediately before 0x02 is
        // dispatched" is its third safe boundary, because 0x1f70 recomputes vi15/vi12/vi3 from
        // vi1 and nothing else is live.
        if (!withinCeiling(c.loadWord(c.vi(1) + 2, 3), triangleCeiling()))
        {
            handBackAtNextCommand(c);
            return Outcome::NotImplemented;
        }
        c.vi(kCursor) = c.loadWord(c.vi(1) + 2, 0);              // 0x1f70: TOP+2.x
        c.vi(kPrimitives) = c.loadWord(c.vi(1) + 2, 3);          // 0x1f78: TOP+2.w
        c.vi(kCursor) = vi16(c.vi(kCursor) + c.vi(1));           // 0x1f90
        return primitiveLoop(c, false);
    }

    // ---- command 0x4c -> 0x20c8: the primitive loop's back edge ----------------------------
    //
    // Nothing but an entry into the loop above at 0x20c8, which is where 0x02's skip branches
    // already land. `B 0x1f98` re-enters 0x02's body *after* its prologue, so vi12 (the primitive
    // counter) and vi15 (the index cursor, restored from 329.z) are carried over rather than
    // recomputed -- which is exactly why family B cannot be handed back in the middle of a list
    // by a program that is not reproducing the whole register file.
    Outcome cmdPrimitiveLoopBack(Ctx &c) { return primitiveLoop(c, true); }

    // ---- family C: the three stateless commands, 0x64, 0x72 and 0x74 -----------------------
    //
    // Three instructions each and completely order-independent with respect to registers: the only
    // things they order are data qword 39.w and the GS state their packet sets (research/13 6.2).
    //
    // 0x64 -> 0x04a8 kicks the render-state packet the EE uploaded at data qword 330 -- a GIFtag
    // with NLOOP = 5, EOP = 1, NREG = 1, REGS = A+D, so six qwords of GS register writes.
    bool cmdKickRenderState(Ctx &c)
    {
        c.vi(2) = 330;                                           // 0x04a8
        g_xgkickDecoded.fetch_add(1, std::memory_order_relaxed);
        c.vu.startXgkick(static_cast<uint32_t>(static_cast<uint16_t>(c.vi(2)))); // 0x04b8
        return true;                                             // 0x04c8: B 0x1b60
    }

    // 0x72 -> 0x2268 and 0x74 -> 0x2280: the global draw gate at data qword 39.w, which commands
    // 0x28 and 0x2a OR into their per-primitive visibility test. 0x74 forces everything to draw;
    // 0x72 restores per-primitive gating. 0x72's store takes its value from vi0, so it clobbers
    // nothing; 0x74 writes vi3 = 2 first, and vi3 is dead afterwards but still a compared register.
    bool cmdDrawGateOff(Ctx &c)
    {
        storeIntWord<kW>(c, 39, 0);                              // 0x2268: ISW.w vi0, 39(vi0)
        return true;                                             // 0x2270: B 0x1b60
    }

    bool cmdDrawGateOn(Ctx &c)
    {
        c.vi(3) = 2;                                             // 0x2280
        storeIntWord<kW>(c, 39, c.vi(3));                        // 0x2288
        return true;                                             // 0x2290: B 0x1b60
    }

    // ---- command 0x30 -> 0x22a0: inline GIF block, S/T rescale, second draw pass -----------
    //
    // The family-C mechanism with teeth. The command's own list qword carries a block count N in
    // its z word (research/13 3.1 -- vi14 is already one past the command, so `ILW.z 339(vi14)`
    // addresses the command itself), and the N eight-qword blocks that follow it *in the command
    // list* are GIF packets rather than commands: each block's first qword is a real GIFtag and
    // is XGKICKed (NLOOP = 6, NREG = 1, REGS = A+D in the corpus, so six GS register writes reach
    // the GS), and the block's eighth qword holds, in .x, a float that every staging S and T is
    // multiplied by. vi14 advances by 8 per block, so the list resumes after the last one.
    //
    // **This is the handler that rewrites vi14**, and the reason a linear decode of a family-C
    // list is wrong (research/13 3.3): the qwords it skips would otherwise be read as commands.
    //
    // Then `JR vi6` tail-jumps into a *draw* handler -- 0x1780 (command 0x28's body) for 0x30,
    // 0x1a78 (command 0x2a's) for 0x32 -- which redraws the same geometry with the rescaled UVs
    // and the GS state the block just installed. Those handlers end at their own `B 0x1b60`, so
    // the command still hands back to the dispatcher like every other one.
    //
    // Data qword 339 -- the one immediately below the command list at 340, written by nothing
    // else -- is the handler's scratch: vi3/vi4/vi9 go into its x/y/z before the outer loop and
    // come back out at the head of every iteration, which is what makes a second block start from
    // the staging base again rather than from where the first one left off.
    namespace inlineBlock
    {
        constexpr uint8_t kSrcCursor = 3;  // vi3, stride 3: the staging quad being rescaled
        constexpr uint8_t kDstCursor = 4;  // vi4, stride 3: where it goes back -- the same array
        constexpr uint8_t kBlock = 5;      // vi5: the embedded block's first qword
        constexpr uint8_t kReturnPc = 6;   // vi6: the draw handler to tail-jump into, as pc / 8
        constexpr uint8_t kBlocks = 7;     // vi7: N
        constexpr uint8_t kRemaining = 9;  // vi9: the vertex count
        constexpr uint8_t kQuad = 25;      // vf25: the staging ST quad
        constexpr uint8_t kScale = 30;     // vf30: .x = the scale from the block's eighth qword

        constexpr int32_t kScratchQword = 339;
        constexpr int32_t kBuildPacketPc = 752; // 0x1780 / 8
        constexpr int32_t kFlushPacketPc = 847; // 0x1a78 / 8
    }

    // The shared body at 0x22c0. Entered with vi3 and vi4 at the staging base, vi9 the vertex
    // count and vi6 the draw handler to end in.
    bool inlineBlockPass(Ctx &c)
    {
        using namespace inlineBlock;
        using vu1ops::ArithMul;

        storeIntWord<kX>(c, kScratchQword, c.vi(kSrcCursor));     // 0x22c0
        storeIntWord<kY>(c, kScratchQword, c.vi(kDstCursor));     // 0x22c8
        storeIntWord<kZ>(c, kScratchQword, c.vi(kRemaining));     // 0x22d0
        c.vi(kBlocks) = c.loadWord(kScratchQword + c.vi(14), 2);  // 0x22d8: N

        for (;;)
        {
            // 0x22e0-0x2308: this block's address, the vi14 rewrite, and the three pointers read
            // back out of the scratch qword.
            c.vi(kBlock) = vi16(c.vi(14) + kCommandListQword);
            c.vi(14) = vi16(c.vi(14) + static_cast<int32_t>(kInlineBlockQwords));
            c.vi(kSrcCursor) = c.loadWord(kScratchQword, 0);
            c.vi(kDstCursor) = c.loadWord(kScratchQword, 1);
            c.vi(kRemaining) = c.loadWord(kScratchQword, 2);
            c.vi(kBlocks) = vi16(c.vi(kBlocks) - 1);

            // 0x2310: the block's own GIFtag decides how much of it reaches the GS.
            g_xgkickDecoded.fetch_add(1, std::memory_order_relaxed);
            c.vu.startXgkick(static_cast<uint32_t>(static_cast<uint16_t>(c.vi(kBlock))));

            loadQword<kQuad, kXYZW>(c, c.vi(kSrcCursor));         // 0x2320
            loadQword<kScale, kX>(c, c.vi(kBlock) + 7);           // 0x2328

            for (;;)
            {
                // 0x2330-0x2350: S and T only. The quad's .z (Q) and .w (the clip-space w that
                // 0x08/0x0a left there for the distance fade) are not touched.
                __m128 up = fmac<ArithMul, Vu1Gen::SrcBc, 0, kXY, kQuad, kScale>(c);
                writeVf<kQuad, kXY>(c, up);
                c.vi(kRemaining) = vi16(c.vi(kRemaining) - 1);
                c.vi(kSrcCursor) = vi16(c.vi(kSrcCursor) + 3);
                storeQword<kQuad, kXY>(c, c.vi(kDstCursor));

                // 0x2370: the next quad, which on the last iteration is one triple past the end
                // -- the microcode's own over-read, and vf25 is a compared register.
                loadQword<kQuad, kXYZW>(c, c.vi(kSrcCursor));

                // 0x2380 `IBNE vi9, vi0, 0x2330`, with the destination step in its delay slot.
                // The test is "!= 0", not "> 0": a zero vertex count would walk 65536 triples
                // rather than none, which is why the pre-scan insists on at least one.
                const bool more = static_cast<int16_t>(c.vi(kRemaining)) != 0;
                c.vi(kDstCursor) = vi16(c.vi(kDstCursor) + 3);
                if (!more)
                    break;
            }

            // 0x2390 `IBNE vi7, vi0, 0x22e0`: the next inline block. N was 1 in all 187 corpus
            // dispatches (research/13 8.1), so this loop is transcribed from the disassembly and
            // the generated C++ at L_0x22e0 and has never been exercised by a dump.
            if (static_cast<int16_t>(c.vi(kBlocks)) == 0)
                break;
        }

        // 0x23a0 `JR vi6`. Only two values can reach here: 0x30 and 0x32 are the only ways in,
        // each writes vi6 itself (0x22b0 / 0x23c0), and nothing between there and here touches
        // vi6 -- the loop above uses vi3/vi4/vi5/vi7/vi9. Any other value is a jump this file
        // cannot reconstruct, so it gets its own branch rather than falling into 0x1a78 by
        // default. The hand-back it takes is NOT a clean one -- the inline block has been kicked
        // and the staging array rescaled, so the microcode would redo both -- but there is no
        // clean stop left at this point and running the wrong draw handler is worse. Dead code.
        // (`false` rather than handBackAtNextCommand: vi14 has been advanced by 8*N by now, so the
        // dispatcher's own NotImplemented path -- which restores vi14 to this command's index --
        // is the one that gets the re-dispatch right.)
        if (c.vi(kReturnPc) == kBuildPacketPc)
            return cmdBuildPacket(c);
        if (c.vi(kReturnPc) == kFlushPacketPc)
            return cmdFlushPacket(c);
        return false;
    }

    bool cmdInlineBlockOverA(Ctx &c)
    {
        using namespace inlineBlock;
        // Clamp, for both halves of this command: 0x22b8's rescale count (TOP+2.z) and the
        // triangle count of the 0x1780 body it tail-jumps into (TOP+2.w). Both are checked here,
        // at the only point in the command where a hand-back is still clean -- after the first
        // XGKICK of an inline block, re-running 0x30 from the microcode would kick it twice and
        // rescale the staging array twice.
        if (!withinCeiling(c.loadWord(c.vi(1) + 2, 2), vertexCeiling()) ||
            !withinCeiling(c.loadWord(c.vi(1) + 2, 3), triangleCeiling()))
            return handBackAtNextCommand(c);
        c.vi(kSrcCursor) = 40;                                   // 0x22a0: the family-A staging
        c.vi(kDstCursor) = 40;                                   // 0x22a8: array, rescaled in place
        c.vi(kReturnPc) = kBuildPacketPc;                        // 0x22b0
        c.vi(kRemaining) = c.loadWord(c.vi(1) + 2, 2);           // 0x22b8: TOP+2.z
        return inlineBlockPass(c);                               // falls into 0x22c0
    }

    // ---- command 0x32 -> 0x23b0: 0x30 on the family-B staging array ------------------------
    //
    // Four instructions and then `B 0x22c0`: the same inline-block walk over the 150-base staging
    // array that the clipped-polygon shims fill, ending in 0x1a78 (command 0x2a's flush) rather
    // than 0x1780. The vertex count is the clipped one in vi10, which reaches here across the
    // hand-back from 0x02's clipper (research/13 6.2).
    bool cmdInlineBlockOverB(Ctx &c)
    {
        using namespace inlineBlock;
        // Clamp: vi10 is both 0x23d0's rescale count and the count of the 0x1a78 body this tail-
        // jumps into, so one check at the entry covers both -- and it has to be here, for the same
        // reason as 0x30's.
        //
        // The lower bound is NOT decoration. 0x2380's `IBNE vi9, vi0` ends the rescale loop on
        // `!= 0`, so vi10 == 0 decrements to -1 and walks 65536 staging triples with wrapping
        // stores. The pre-scan cannot rule that out the way it rules out 0x30's zero (whose count
        // is the header word `hasInlineOverA && vertices < 1` rejects): vi10 is the clipper's
        // output, and although 0x02 only reaches its `B 0x1b60` with vi10 != 0, a 0x4c back-edge
        // `y` landing on a 0x32 would arrive here with whatever vi10 the last clipper call left --
        // including the zero the "clipped away entirely" path at 0x2080 leaves. So 0x32 requires
        // at least one, here, where the hand-back is still clean.
        if (!withinBounds(vi16(c.vi(10)), 1, clippedVertexCeiling()))
            return handBackAtNextCommand(c);
        c.vi(kSrcCursor) = 150;                                  // 0x23b0
        c.vi(kDstCursor) = 150;                                  // 0x23b8
        c.vi(kReturnPc) = kFlushPacketPc;                        // 0x23c0
        c.vi(kRemaining) = vi16(c.vi(10));                       // 0x23d0: the B 0x22c0 delay slot
        return inlineBlockPass(c);                               // 0x23c8
    }

    // ---- command 0x34 -> 0x2690: sphere-map ST + rim alpha over an eleven-qword block -------
    //
    // The third inline-block command, and the only one that computes rather than rescales
    // (research/15 6). Its block is ELEVEN list qwords, not eight: a six-qword GIF packet the
    // handler kicks (a PACKED A+D tag plus five GS register writes -- ALPHA_1, TEX1_1, TEX0_1,
    // TEST_1, CLAMP_1) followed by five qwords that never reach the GS and are read with LQ as
    // per-object parameters:
    //     +6..+8  three basis rows (vf17/vf18/vf19), whose .w lanes are the EYE position
    //     +9      the base colour (vf27), whose .w seeds the alpha
    //     +10     (UV scale, rim offset, -, rim slope) -> vf23, loaded .xyw only
    //
    // Per vertex, over the SAME three-qword records 0x68/0x70 unpack and the same 40-based
    // staging array the rest of family A writes:
    //     V  = position - eye                      R  = V - 2 dot(V, N) N          (N = the
    //     R' = R in the (vf17, vf18, vf19) basis        packed normal, (pos.w, uv.z, uv.w))
    //     ST = R'.xy * (1/|R'|) * scale + 0.5, then * Q          -> staging[+0].xy
    //     A  = (1 + block[9].w) * colour.w/128 * ramp(R'.z)      -> staging[+1] (whole RGBAQ)
    // and nothing else: XYZF2 (+2) and the ST quad's .z/.w come from the 0x08 that always
    // precedes it. The 1/|V| and 1/|R'| are EFU ERLENGs (erlengP above); the ramp is skipped
    // entirely, reusing 1/|V|, when the MADDz at 0x2838 leaves the Sz MAC bit clear, i.e. when
    // R'.z >= 0.
    //
    // Two things in here are decided by the code rather than by the algebra:
    //
    // * THE SAME-LANE WRITE CONFLICT AT pc 0x2760. That pair is
    //       upper  ADDx.w vf27, vf0, vf30x   ->  vf27.w = 1.0f + vf30.x
    //       lower  MR32.w  vf27, vf30        ->  vf27.w = vf30.x
    //   -- both halves writing vf27.w, one 1.0f apart. The UPPER WINS: the interpreter's pair
    //   decoder sets decoded.suppressedLowerVf when the lower's vf write names the upper's
    //   destination register, and `hasLowerWrite` then drops the lower's queueVfWrite entirely
    //   (ps2_vu1_core.cpp); the generated translation's L_0x2760 emits the ADDx.w and no
    //   execLower at all. research/15 6.4 also separates the two hypotheses by experiment -- with
    //   block[9].w patched to 0 the measured alpha is non-zero, which only the upper produces.
    //   So this handler emits the FMAC and no MR32. The suppression is register-granular, not
    //   lane-granular, so there is deliberately no lane merge here.
    //
    // * N > 1 IS REFUSED, by the pre-scan and again below. vi5 holds the block's base address
    //   for the XGKICK at 0x26f8, is computed ONCE at 0x26b0 outside the outer loop, and is then
    //   overwritten with the constant 32 at 0x2848 -- the FMAND mask -- on the first pass through
    //   the inner loop. A second outer iteration would therefore kick data qword 32 and read its
    //   five parameter qwords from 38..42, not re-kick the block. (research/15 6.2's last bullet
    //   says it would "re-kick the same block"; that is wrong, and the note is corrected in the
    //   same commit as this handler.) Since that target is not in the command list, the scan can
    //   never have validated its GIFtag, so N != 1 hands the list back whole. N was 1 in the only
    //   dispatch in the corpus (research/15 7).
    //
    // Ends with `JR vi6` at 0x2948 to pc 0x1780 -- command 0x28's FULL body, including its
    // `LQ vf20, 38(vi0)` and `LQ vf19, 1(vi1)` -- so unlike 0x40 there is no inherited vf20 here,
    // and the draw is the ordinary textured/fogged one. vi6 is loaded with 752 at 0x26a0 and
    // nothing between there and the jump writes it (the loops use vi3/vi4/vi5/vi7/vi9/vi13/vi14),
    // so the tail target is a constant and cmdBuildPacket is called directly.
    namespace sphereMap
    {
        constexpr uint8_t kSrcCursor = 3;  // vi3, stride 3: the source vertex record
        constexpr uint8_t kDstCursor = 4;  // vi4, stride 3: the staging triple it feeds
        constexpr uint8_t kBlock = 5;      // vi5: the block's first qword -- until 0x2848 reuses
                                           //      it as the FMAND mask (see above)
        constexpr uint8_t kReturnPc = 6;   // vi6: the tail-jump target, as pc / 8
        constexpr uint8_t kBlocks = 7;     // vi7: N
        constexpr uint8_t kRemaining = 9;  // vi9: vertices left
        constexpr uint8_t kSign = 13;      // vi13: the Sz MAC bit of the 0x2838 MADDz

        constexpr uint8_t kBasis0 = 17, kBasis1 = 18, kBasis2 = 19; // .xyz basis, .w = eye
        constexpr uint8_t kEye = 20;       // vf20: .xyz the eye, .w the vertex colour's w
        constexpr uint8_t kDot = 21;       // vf21: .xyz V*N lanewise, .w -2 dot(V, N)
        constexpr uint8_t kScaledN = 22;   // vf22: -2 dot(V, N) N
        constexpr uint8_t kParams = 23;    // vf23: .x UV scale, .y rim offset, .z ramp, .w slope
        constexpr uint8_t kPos = 24;       // vf24: the vertex position, then its clip-space form
        constexpr uint8_t kUv = 25;        // vf25: the vertex UV quad (.zw = normal.y/z)
        constexpr uint8_t kReflect = 26;   // vf26: R, then R' in the basis, then the final ST
        constexpr uint8_t kColour = 27;    // vf27: the staged RGBAQ
        constexpr uint8_t kView = 28;      // vf28: V = position - eye
        constexpr uint8_t kNormal = 29;    // vf29: (pos.w, uv.z, uv.w)
        constexpr uint8_t kAlphaSeed = 30; // vf30: .x = block[9].w
        constexpr uint8_t kConst = 31;     // vf31: .y = 0.5, .w = the EFU reciprocal length

        constexpr int32_t kScratchQword = 339; // the same slot 0x30/0x32 use
    }

    bool cmdSphereMapBlock(Ctx &c)
    {
        using namespace sphereMap;
        using vu1ops::ArithAdd;
        using vu1ops::ArithMadd;
        using vu1ops::ArithMul;
        using vu1ops::ArithSub;
        __m128 up;

        // Clamps, all three of them here at the entry, before a register is written or the block
        // is kicked -- after the XGKICK at 0x26f8 a hand-back would kick the block twice.
        //   * the per-vertex count (TOP+2.z, read at 0x26a8): 0x2928's `IBNE vi9, vi0` makes zero
        //     65536 iterations, so it is two-sided, like 0x32's vi10;
        //   * the triangle count (TOP+2.w) of the 0x1780 body this tail-jumps into, exactly as
        //     0x30 checks the body it jumps into;
        //   * N, which must be 1 -- see the note above; the pre-scan refuses the list first, so
        //     this is defence in depth against a count read from somewhere it cannot see.
        if (!withinBounds(c.loadWord(c.vi(1) + 2, 2), 1, vertexCeiling()) ||
            !withinCeiling(c.loadWord(c.vi(1) + 2, 3), triangleCeiling()) ||
            c.loadWord(kScratchQword + c.vi(14), 2) != 1)
            return handBackAtNextCommand(c);

        c.vi(kSrcCursor) = vi16(c.vi(1) + 4);                    // 0x2690
        c.vi(kDstCursor) = 40;                                   // 0x2698
        c.vi(kReturnPc) = inlineBlock::kBuildPacketPc;           // 0x26a0: 752 = 0x1780 / 8
        c.vi(kRemaining) = c.loadWord(c.vi(1) + 2, 2);           // 0x26a8: TOP+2.z
        c.vi(kBlock) = vi16(c.vi(14) + kCommandListQword);       // 0x26b0: the qword after the
                                                                 //         command -- and NOT
                                                                 //         recomputed per block
        storeIntWord<kX>(c, kScratchQword, c.vi(kSrcCursor));    // 0x26b8
        storeIntWord<kY>(c, kScratchQword, c.vi(kDstCursor));    // 0x26c0
        storeIntWord<kZ>(c, kScratchQword, c.vi(kRemaining));    // 0x26c8
        c.vi(kBlocks) = c.loadWord(kScratchQword + c.vi(14), 2); // 0x26d0: N, from the command's
                                                                 //         own list qword
        for (;;)
        {
            // 0x26d8-0x26f0: the three pointers back out of the scratch qword, so a second block
            // would start from the staging base again.
            c.vi(kSrcCursor) = c.loadWord(kScratchQword, 0);
            c.vi(kDstCursor) = c.loadWord(kScratchQword, 1);
            c.vi(kRemaining) = c.loadWord(kScratchQword, 2);
            c.vi(kBlocks) = vi16(c.vi(kBlocks) - 1);

            // 0x26f8: the block's own GIFtag decides how much of it reaches the GS -- six qwords
            // of the eleven for the one block in the corpus.
            g_xgkickDecoded.fetch_add(1, std::memory_order_relaxed);
            c.vu.startXgkick(static_cast<uint32_t>(static_cast<uint16_t>(c.vi(kBlock))));

            // 0x2708-0x2728: the five VU-only parameter qwords. vf23 is .xyw only -- its .z is
            // the ramp the per-vertex body computes, and the block's .z is never read.
            loadQword<kBasis0, kXYZW>(c, c.vi(kBlock) + 6);
            loadQword<kBasis1, kXYZW>(c, c.vi(kBlock) + 7);
            loadQword<kBasis2, kXYZW>(c, c.vi(kBlock) + 8);
            loadQword<kColour, kXYZW>(c, c.vi(kBlock) + 9);
            loadQword<kParams, kXY | kW>(c, c.vi(kBlock) + 10);

            // 0x2730-0x2748: the eye position out of the three basis rows' .w lanes, vi14 past
            // the whole eleven-qword block, and the first vertex's three qwords -- the prologue
            // of a loop pipelined one vertex deep.
            up = fmac<ArithAdd, Vu1Gen::SrcBc, 3, kX, 0, kBasis0, false, false, true>(c);
            loadQword<kPos, kXYZW>(c, c.vi(kSrcCursor));
            writeVf<kEye, kX>(c, up);
            up = fmac<ArithAdd, Vu1Gen::SrcBc, 3, kY, 0, kBasis1, false, false, true>(c);
            loadQword<kUv, kXYZW>(c, c.vi(kSrcCursor) + 1);
            writeVf<kEye, kY>(c, up);
            up = fmac<ArithAdd, Vu1Gen::SrcBc, 3, kZ, 0, kBasis2, false, false, true>(c);
            c.vi(14) = vi16(c.vi(14) + static_cast<int32_t>(kSphereMapBlockQwords));
            writeVf<kEye, kZ>(c, up);
            up = fmac<ArithAdd, Vu1Gen::SrcBc, 3, kX, 0, kColour, false, false, true>(c);
            loadQword<kEye, kW>(c, c.vi(kSrcCursor) + 2);
            writeVf<kAlphaSeed, kX>(c, up);

            for (;;)
            {
                // 0x2758: V = position - eye, and the normal's y/z out of the UV quad's z/w.
                up = fmac<ArithSub, Vu1Gen::SrcVt, 0, kXYZ, kPos, kEye, false, true, false>(c);
                moveRotate32<kNormal, kUv, kY | kZ>(c);
                writeVf<kView, kXYZ>(c, up);

                // 0x2760: the same-lane conflict. The upper wins and the lower `MR32.w vf27,
                // vf30` is dropped, so this is 1.0f + vf30.x, not vf30.x. See the note above.
                up = fmac<ArithAdd, Vu1Gen::SrcBc, 0, kW, 0, kAlphaSeed, false, false, false>(c);
                writeVf<kColour, kW>(c, up);

                // 0x2768: the normal's x lane, and the first ERLENG -- 1/|V|, read 26 pairs later
                // at 0x2838 with no WAITP in between (research/15 6.3).
                up = fmac<ArithAdd, Vu1Gen::SrcBc, 3, kX, 0, kPos, false, false, true>(c);
                erlengP<kView>(c);
                writeVf<kNormal, kX>(c, up);

                // 0x2770-0x2788: the position into clip space through entry 0's vf1..vf4.
                up = fmac<ArithMul, Vu1Gen::SrcBc, 0, kXYZW, 1, kPos, false, true, true>(c);
                writeAcc<kXYZW>(c, up);
                up = fmac<ArithMadd, Vu1Gen::SrcBc, 1, kXYZW, 2, kPos, false, true, true>(c);
                writeAcc<kXYZW>(c, up);
                up = fmac<ArithMadd, Vu1Gen::SrcBc, 2, kXYZW, 3, kPos, false, true, true>(c);
                writeAcc<kXYZW>(c, up);
                up = fmac<ArithMadd, Vu1Gen::SrcBc, 3, kXYZW, 4, 0, false, true, false>(c);
                writeVf<kPos, kXYZW>(c, up);

                // 0x2790-0x27a8: dot(V, N) in vf21.w, and Q = 1 / w_clip.
                up = fmac<ArithMul, Vu1Gen::SrcVt, 0, kXYZ, kView, kNormal, false, false, true>(c);
                writeVf<kDot, kXYZ>(c, up);
                up = fmac<ArithMul, Vu1Gen::SrcBc, 0, kW, 0, kDot, false, false, false>(c);
                writeAcc<kW>(c, up);
                up = fmac<ArithMadd, Vu1Gen::SrcBc, 1, kW, 0, kDot, false, false, false>(c);
                writeAcc<kW>(c, up);
                loadImmediate(c, 0x3c000000u);                   // 0x27a0: 1/128
                up = fmac<ArithMadd, Vu1Gen::SrcBc, 2, kW, 0, kDot, false, false, false>(c);
                divQ<0, 3, kPos, 3>(c);
                writeVf<kDot, kW>(c, up);

                // 0x27b0-0x27e0: the colour scale, -2 dot(V, N), and the 0.5 the ST lands on.
                up = fmac<ArithMul, Vu1Gen::SrcI, 0, kW, kEye, 0, false, true, false>(c);
                writeVf<kEye, kW>(c, up);
                loadImmediate(c, 0xc0000000u);                   // 0x27b8: -2
                up = fmac<ArithMul, Vu1Gen::SrcI, 0, kW, kDot, 0, false, false, false>(c);
                writeVf<kDot, kW>(c, up);
                loadImmediate(c, 0x3f000000u);                   // 0x27d0: 0.5
                up = fmac<ArithAdd, Vu1Gen::SrcI, 0, kY, 0, 0, false, false, false>(c);
                writeVf<kConst, kY>(c, up);

                // 0x27e8-0x2800: -2 dot(V, N) N, the cursors, and the read-ahead of the NEXT
                // vertex's position -- the last iteration reads one record past the end, which is
                // the microcode's own over-read and part of the compared register state.
                up = fmac<ArithMul, Vu1Gen::SrcBc, 3, kXYZ, kNormal, kDot, false, true, false>(c);
                c.vi(kRemaining) = vi16(c.vi(kRemaining) - 1);
                writeVf<kScaledN, kXYZ>(c, up);
                c.vi(kSrcCursor) = vi16(c.vi(kSrcCursor) + 3);
                c.vi(kDstCursor) = vi16(c.vi(kDstCursor) + 3);
                loadQword<kPos, kXYZW>(c, c.vi(kSrcCursor));

                // 0x2808-0x2818: R = V - 2 dot(V, N) N, and the ramp's default of 1.0.
                up = fmac<ArithAdd, Vu1Gen::SrcVt, 0, kXYZ, kScaledN, kView, false, false,
                          false>(c);
                writeVf<kReflect, kXYZ>(c, up);
                loadImmediate(c, 0x3f800000u);                   // 0x2810: 1.0
                up = fmac<ArithAdd, Vu1Gen::SrcI, 0, kZ, 0, 0, false, false, false>(c);
                writeVf<kParams, kZ>(c, up);

                // 0x2828-0x2838: R into the basis, and the first ERLENG's 1/|V| into vf31.w. The
                // MADDz's MAC is what the FMAND four pairs later reads.
                up = fmac<ArithMul, Vu1Gen::SrcBc, 0, kXYZ, kBasis0, kReflect, false, true,
                          false>(c);
                writeAcc<kXYZ>(c, up);
                up = fmac<ArithMadd, Vu1Gen::SrcBc, 1, kXYZ, kBasis1, kReflect, false, true,
                          false>(c);
                writeAcc<kXYZ>(c, up);
                up = fmac<ArithMadd, Vu1Gen::SrcBc, 2, kXYZ, kBasis2, kReflect, false, true,
                          false>(c);
                moveFromP<kConst, kW>(c);
                writeVf<kReflect, kXYZ>(c, up);

                // 0x2848-0x2860: mask 32 = MAC bit 5 = Sz, i.e. "is R'.z negative?". This is the
                // pair that destroys vi5's block base; nothing reads it as an address again.
                c.vi(kBlock) = 32;
                loadImmediate(c, 0x3f000000u);                   // 0x2850: 0.5
                c.vi(kSign) = fmand(c, c.vi(kBlock));
                if (static_cast<int16_t>(c.vi(kSign)) != 0)
                {
                    // 0x2870-0x2890: the rim block. R'.z is clamped to >= 0 before the second
                    // ERLENG, whose WAITP at 0x2888 makes it synchronous.
                    up = fmac<ArithAdd, Vu1Gen::SrcBc, 1, kZ, kReflect, kParams, false, false,
                              true>(c);
                    writeVf<kParams, kZ>(c, up);
                    writeVf<kReflect, kZ>(c, minmax<true, Vu1Gen::MmBc, 1, kReflect, 0>(c));
                    loadImmediate(c, 0x40000000u);               // 0x2878: 2.0
                    erlengP<kReflect>(c);                        // 0x2880, then 0x2888 WAITP
                    up = fmac<ArithMul, Vu1Gen::SrcBc, 3, kZ, kParams, kParams, false, false,
                              true>(c);
                    moveFromP<kConst, kW>(c);
                    writeVf<kParams, kZ>(c, up);
                }

                // 0x28b0-0x2910: normalise R'.xy, ramp the alpha, scale and bias the ST, and
                // perspective-correct it. The three read-aheads of the next vertex sit in the
                // lower halves, so they run on the already-incremented vi3.
                up = fmac<ArithMul, Vu1Gen::SrcBc, 3, kXY, kReflect, kConst, false, false,
                          true>(c);
                writeVf<kReflect, kXY>(c, up);
                writeVf<kParams, kZ>(c, minmax<true, Vu1Gen::MmBc, 1, kParams, 0>(c));
                up = fmac<ArithMul, Vu1Gen::SrcBc, 3, kW, kColour, kEye, false, false, false>(c);
                writeVf<kColour, kW>(c, up);
                up = fmac<ArithMul, Vu1Gen::SrcBc, 0, kXY, kReflect, kParams, false, false,
                          true>(c);
                loadQword<kUv, kXYZW>(c, c.vi(kSrcCursor) + 1);
                writeVf<kReflect, kXY>(c, up);
                up = fmac<ArithMul, Vu1Gen::SrcBc, 2, kW, kColour, kParams, false, false,
                          false>(c);
                writeVf<kColour, kW>(c, up);
                up = fmac<ArithAdd, Vu1Gen::SrcBc, 1, kXY, kReflect, kConst, false, false,
                          false>(c);
                writeVf<kReflect, kXY>(c, up);
                loadQword<kEye, kW>(c, c.vi(kSrcCursor) + 2);
                up = fmac<ArithMul, Vu1Gen::SrcQ, 0, kXY, kReflect, 0, false, false, false>(c);
                writeVf<kReflect, kXY>(c, up);

                // 0x2920-0x2928: the whole RGBAQ at +1 and the ST's xy ONLY at +0. XYZF2 (+2) and
                // the ST quad's z/w are left exactly as the earlier 0x08 wrote them. The second
                // store is the branch's delay slot, so it runs whichever way the test goes.
                storeQword<kColour, kXYZW>(c, c.vi(kDstCursor) - 2);
                const bool more = static_cast<int16_t>(c.vi(kRemaining)) != 0;
                storeQword<kReflect, kXY>(c, c.vi(kDstCursor) - 3);
                if (!more)
                    break;
            }

            if (static_cast<int16_t>(c.vi(kBlocks)) == 0)        // 0x2938
                break;
        }

        // 0x2948 `JR vi6` -> pc 0x1780, command 0x28's full body, which ends at its own B 0x1b60.
        return cmdBuildPacket(c);
    }

    // ---- command 0x66 -> 0x2e28: per-triangle face normals (research/15 5, research/82) ------
    //
    // For every index record (two qwords from TOP + TOP+2.x): v0, v1, v2 = the vertex records its
    // x/y/z words name (qword offsets from TOP+4), normal = (v2 - v1) x (v0 - v1) by OPMULA/OPMSUB,
    // FTOI15.xyz, stored to record [1] with SQ.xyzw -- so its w lane is whatever vf29.w held before
    // the handler (the repack's last MR32.w at entry 0x33c8), a data-memory byte the golden compares.
    // Software-pipelined: the loop loads the next record's three vertices before testing, so on exit
    // vi5-vi7 and vf17-vf19 hold the record past the end. The body runs once before the IBGTZ, so a
    // zero triangle count still computes one normal. Run only from entry 0x33c8 (Ctx::faceNormals).
    bool cmdFaceNormals(Ctx &c)
    {
        using vu1ops::ArithMsub;
        using vu1ops::ArithMul;
        using vu1ops::ArithSub;
        __m128 up;

        // Clamp: 0x2e40's triangle count, read before the handler touches anything.
        if (!withinCeiling(c.loadWord(c.vi(1) + 2, 3), triangleCeiling()))
            return handBackAtNextCommand(c);

        c.vi(4) = c.loadWord(c.vi(1) + 2, 0);            // 0x2e28 ILW.x vi4, 2(vi1): the index list offset
        c.vi(3) = vi16(c.vi(1) + 4);                     // 0x2e30 the vertex block
        c.vi(4) = vi16(c.vi(4) + c.vi(1));               // 0x2e38
        c.vi(13) = c.loadWord(c.vi(1) + 2, 3);           // 0x2e40 ILW.w: the triangle count
        c.vi(5) = c.loadWord(c.vi(4), 0);                // 0x2e48
        c.vi(6) = c.loadWord(c.vi(4), 1);                // 0x2e50
        c.vi(7) = c.loadWord(c.vi(4), 2);                // 0x2e58
        c.vi(5) = vi16(c.vi(3) + c.vi(5));               // 0x2e68
        loadQword<17, kXYZW>(c, c.vi(5));                // 0x2e70
        c.vi(6) = vi16(c.vi(3) + c.vi(6));               // 0x2e78
        loadQword<18, kXYZW>(c, c.vi(6));                // 0x2e80
        c.vi(7) = vi16(c.vi(3) + c.vi(7));               // 0x2e88
        loadQword<19, kXYZW>(c, c.vi(7));                // 0x2e90
        for (;;)
        {
            up = fmac<ArithSub, Vu1Gen::SrcVt, 0, kXYZ, 17, 18>(c);         // 0x2ea8 SUB.xyz vf26, vf17, vf18
            c.vi(13) = vi16(c.vi(13) - 1);                                 //        IADDI vi13, vi13, -1
            writeVf<26, kXYZ>(c, up);
            up = fmac<ArithSub, Vu1Gen::SrcVt, 0, kXYZ, 19, 18>(c);         // 0x2eb0 SUB.xyz vf28, vf19, vf18
            c.vi(4) = vi16(c.vi(4) + 2);                                   //        IADDI vi4, vi4, 2
            writeVf<28, kXYZ>(c, up);
            c.vi(5) = c.loadWord(c.vi(4), 0);                              // 0x2ec0
            c.vi(6) = c.loadWord(c.vi(4), 1);                              // 0x2ec8
            up = fmac<ArithMul, Vu1Gen::SrcVt, 0, kXYZ, 28, 26, true>(c);   // 0x2ed0 OPMULA.xyz ACC, vf28, vf26
            c.vi(7) = c.loadWord(c.vi(4), 2);                              //        ILW.z vi7, 0(vi4)
            writeAcc<kXYZ>(c, up);
            up = fmac<ArithMsub, Vu1Gen::SrcVt, 0, kXYZ, 26, 28, true>(c);  // 0x2ed8 OPMSUB.xyz vf29, vf26, vf28
            writeVf<29, kXYZ>(c, up);
            c.vi(5) = vi16(c.vi(3) + c.vi(5));                             // 0x2ee0
            loadQword<17, kXYZW>(c, c.vi(5));                              // 0x2ee8
            c.vi(6) = vi16(c.vi(3) + c.vi(6));                             // 0x2ef0
            up = ftoi<15, 29>(c);                                          // 0x2ef8 FTOI15.xyz vf29, vf29
            loadQword<18, kXYZW>(c, c.vi(6));                              //        LQ vf18, 0(vi6)
            writeVf<29, kXYZ>(c, up);
            c.vi(7) = vi16(c.vi(3) + c.vi(7));                             // 0x2f00
            loadQword<19, kXYZW>(c, c.vi(7));                              // 0x2f08
            const bool again = c.vi(13) > 0;                               // 0x2f10 IBGTZ vi13, 0x2ea8
            storeQword<29, kXYZW>(c, c.vi(4) - 1);                         // 0x2f18 (delay slot) SQ.xyzw vf29, -1(vi4)
            if (!again)
                break;
        }
        return true;                                                       // 0x2f20: B 0x1b60
    }

    // ---- entry 0x33c8's last-bone path, 0x33f8-0x3498 (research/15 4.4, research/82) ---------
    //
    // Repacks the staging array the 0x52 passes accumulated (qword 37.x = its base, 40; position,
    // normal per vertex) into the vi9 three-qword vertex records at TOP+4: position xyz with w =
    // normal.x (MR32.w), the record's UV xy through ITOF12 with zw = normal.y, normal.z, and the
    // colour quad of data qword 338. MULz.w and ADDy.z are FMAC ops (MAC/STATUS move); ITOF12 and
    // MR32 are not. Falls into `B 0x1b60` with vi3 past the last record and vi9 = 0. The caller has
    // proved vi9 in 1..kMaxVertices and the record range clear of the command list.
    void repackSkinnedVertices(Ctx &c)
    {
        using vu1ops::ArithAdd;
        using vu1ops::ArithMul;
        __m128 up;
        c.vi(2) = c.loadWord(37, 0);                                       // 0x33f8 ILW.x vi2, 37(vi0)
        c.vi(3) = vi16(c.vi(1) + 4);                                       // 0x3400
        loadQword<28, kXYZW>(c, 338);                                      // 0x3408 LQ vf28, 338(vi0)
        for (;;)
        {
            loadQword<27, kXYZW>(c, c.vi(3) + 1);                          // 0x3410 the record's UV qword
            loadQword<30, kXYZW>(c, c.vi(2) + 1);                          // 0x3418 skinned normal
            loadQword<29, kXYZW>(c, c.vi(2));                              // 0x3420 skinned position
            c.vi(2) = vi16(c.vi(2) + 2);                                   // 0x3428
            up = fmac<ArithMul, Vu1Gen::SrcBc, 2, kW, 0, 30, false, false, true>(c); // 0x3430 MULz.w vf30, vf0, vf30z
            c.vi(9) = vi16(c.vi(9) - 1);                                   //        ISUBIU vi9, vi9, 1
            writeVf<30, kW>(c, up);
            up = fmac<ArithAdd, Vu1Gen::SrcBc, 1, kZ, 0, 30, false, false, true>(c); // 0x3438 ADDy.z vf30, vf0, vf30y
            writeVf<30, kZ>(c, up);
            up = itof<12, 27>(c);                                          // 0x3440 ITOF12.xy vf27, vf27
            writeVf<27, kXY>(c, up);
            moveRotate32<29, 30, kW>(c);                                   // 0x3458 MR32.w vf29, vf30
            storeQword<27, kXY>(c, c.vi(3) + 1);                           // 0x3460
            storeQword<30, kZW>(c, c.vi(3) + 1);                           // 0x3468
            storeQword<28, kXYZW>(c, c.vi(3) + 2);                         // 0x3470
            storeQword<29, kXYZW>(c, c.vi(3));                             // 0x3478
            const bool again = c.vi(9) != 0;                               // 0x3480 IBNE vi9, vi0, 0x3410
            c.vi(3) = vi16(c.vi(3) + 3);                                   // 0x3488 (delay slot)
            if (!again)
                break;
        }
        // 0x3490: B 0x1b60, a NOP in its delay slot.
    }

    // ---- entry 0x33c8's write proof (research/82 section 3) ------------------------------------
    //
    // The pre-scan validates the list, the header and the packet pointers by READING them before anything
    // runs; a store that later lands on one of them would let a command run on something the scan never saw
    // (the list read again at 0x1b60, a loop count re-read from TOP+2). At 0x1b50 that hole is the base's and
    // stays (research/82 section 7, a LATER candidate); at 0x33c8 every store range of the program is proven
    // clear before the repack's first store, or the whole program is refused.
    constexpr int32_t kPacketPointerQword = 329; // 0x28/0x40's two packet buffers, x and y (0x17e0/0x17e8)
    constexpr int32_t kVuDataQwords = 1024;

    // A store range [first, first + count) that may be written after the proof: inside VU data memory without
    // wrapping (a negative start wraps too), and clear of what the proof read -- the list's kMaxListQwords, the
    // header TOP+2 and the packet pointers at q329.
    bool writeRangeClear(int32_t top, int32_t first, int32_t count)
    {
        if (count < 1)
            return true;
        const int32_t last = first + count - 1;
        if (first < 0 || last >= kVuDataQwords)
            return false;
        auto hits = [&](int32_t lo, int32_t hi) { return first <= hi && last >= lo; };
        return !hits(kCommandListQword, kCommandListQword + static_cast<int32_t>(kMaxListQwords) - 1) &&
               !hits(top + 2, top + 2) && !hits(kPacketPointerQword, kPacketPointerQword);
    }

    // The repack's vi9 records, TOP+4 .. TOP+4+3*vi9-1: a count the loop can end on (IBNE vi9 after a
    // decrement: 0 is 65536 iterations) under the vertex ceiling, and a range writeRangeClear accepts. The
    // corpus's TOPs are 424 and 724, clear of all three.
    bool repackFits(int32_t top, int32_t count)
    {
        if (count < 1 || count > kMaxVertices)
            return false;
        return writeRangeClear(top, top + 4, 3 * count);
    }

    // The resumed list's commands, walked from vi14 to its 0x42 as the dispatcher will run them (the pre-scan has
    // already proved the walk ends), each one's stores proven by writeRangeClear. Only the eight commands whose
    // store ranges are derived here are admitted -- the corpus's three, the walk's 0x06 (research/82 N1b), the
    // walk's 0x54 and 0x10 (research/82 section 9.6, N1c's linear half) and shape A's 0x18 and 0x28 (research/82
    // section 9.7, `66 06 08 54 18 28 42`, 816 of the refused capture's 2,000):
    //   0x66  index record [1] of every triangle, TOP+TOP+2.x+1+2k for k < max(TOP+2.w, 1) (the body runs once
    //         before its IBGTZ);
    //   0x06  index record [0] of every triangle, TOP+TOP+2.x+2k for k < max(TOP+2.w, 1): its one store, the
    //         ISW.w of the flag word at 0x1738 (proven as the whole qword), also once before its IBGTZ at 0x1750.
    //         Its loads (the eye q30, the records' .x and .w, the normals, the vertices) write nothing;
    //   0x08  the staging triples from q40, three a vertex, max(TOP+2.z, 1) of them (likewise);
    //   0x10  (0x0f90-0x1100) the fog lane .w of slot +2 of each staging triple, SQ.w at 0x10c8 (vertex a, -4(vi4))
    //         and 0x10e0 (vertex b, -1(vi4)) after vi4 += 6 from 40: qwords 42 + 3k for k < max(TOP+2.z, 1) -- two a
    //         pass, IADDI vi9 -2 then IBLTZ at 0x10d0 leaving after vertex a on an odd count or a zero one, IBGTZ
    //         at 0x10e8 looping. Proven as the whole qwords [42, 39 + 3 max(V, 1)], inside 0x08's range. Its loads
    //         (q28, q29, the vertex block, the staging ST and XYZF2 quads, one pair past the end) write nothing;
    //   0x54  (0x05d8-0x0638) slot +1 of each staging triple, SQ.xyzw of q327 at 1(vi4), 4(vi4) and 7(vi4) from
    //         vi4 = 40, vi4 += 9 in the IBGTZ's delay slot, the body before the test: qwords 41 + 3j for
    //         j < 3 max(ceil(V/3), 1), overshooting to a multiple of three. Proven as
    //         [41, 40 + 9 max(ceil(V/3), 1) - 2];
    //   0x18  (0x1440-0x15a0) slot +1 of two staging triples a pass, SQ.xyzw at -11(vi4) (vertex a, 0x1580) and
    //         -8(vi4) (vertex b, 0x1588) after vi4 = 40 (0x1450) += 6 before the loop (0x14b8) and += 6 in it (0x1530),
    //         IADDI vi9 -2 (0x14e0) with the body before its IBGTZ (0x1590): qwords 41 + 3j for j < 2 max(ceil(V/2), 1),
    //         an odd count lighting vertex V as well. Proven as [41, 38 + 6 max(ceil(V/2), 1)]; q329 from V = 97, as
    //         0x08. Its loads (q27, the records from TOP+4 and the staging RGBA, one pair past the end) write nothing;
    //         it leaves vi3/vi4/vi9, vf13-vf31, ACC and the MAC/STATUS of its last FMAC (0x1578's MADDw; the MAXx
    //         after it set none), and reads no flag;
    //   0x28  (0x1780) two loads (vf20 = q38, vf19 = TOP+1) and 0x40's body from 0x1790 unchanged, so 0x40's range;
    //   0x40  (0x28's body from 0x1790) the tag qwords 290 and 300, the packets' nine qwords after each of the
    //         two pointers at q329.x and q329.y, and q329 itself -- rewritten with the same pair, swapped, so the
    //         proof's reading of it holds for a later 0x28 or 0x40 too. Its XGKICKs (0x1920, one per drawn triangle)
    //         store nothing: under the immediate model the entry requires, each copies its packet to the GIF at
    //         kick time, before the next triangle is built over the other buffer.
    // TOP+2 and q329 are proven unwritten, so the counts and pointers read here are the ones the handlers read.
    // Order: every range above is a function of TOP, TOP+2 and q329 alone, never of data another command wrote --
    // 0x10 reads the ST.w 0x08 left and 0x40 the flag words 0x06 left, but as values, not addresses -- so the walk
    // proves them in any order and count. Registers: 0x54 leaves vi4 = 40 + 9n, vi9 = V - 3n and vf28 = q327; 0x10
    // leaves vi3/vi4/vi9, vf14/15, vf17/18, vf20-31, ACC.w, I = 1.0 and the MAC/STATUS of its last FMAC. No admitted
    // command takes any of them as an input it has not rewritten first but through the data path the native handler
    // reproduces bit for bit (0x40's inherited vf20 included: native keeps it, as the microcode does). Flags: neither
    // 0x54 (no FMAC) nor 0x10 (MINI/MAX set none; no FMAND/FSAND/FCAND) reads a flag, nor do 0x18 and 0x28 -- the
    // image's six flag reads are all FMAND, at 0x1718 (0x06), 0x2858 (0x34's sphere map, not 0x28's), 0x2fa8/0x2fd8
    // and the clipper's 0x3b60/0x3b78 -- and the one among the admitted, 0x06's FMAND at 0x1718, reads its own
    // MADDz.w four pairs back (research/82 8.2): 0x10's last FMAC (0x10f0, or 0x10b0 on the odd exit), 0x18's
    // (0x1578) and 0x28's (the RGBAQ MADD of its last drawn triangle, or 0x1798's SUBAw.w) issue 20 or more pairs
    // before that FMAND and before the MADDz.w -- the dispatcher's eight and 0x06's prologue between -- so they have
    // landed and are older, as the repack's ADDy.z is.
    bool proveResumedWrites(Ctx &c, int32_t top, uint32_t startIndex, Vu1Refusals::Refusal &refusal)
    {
        const int32_t indexBase = vi16(top + c.loadWord(top + 2, 0)); // 0x2e38: vi4 = TOP+2.x + vi1
        const int32_t vertices = c.loadWord(top + 2, 2);
        const int32_t triangles = c.loadWord(top + 2, 3);
        const int32_t facePasses = triangles > 1 ? triangles : 1;
        const int32_t stagePasses = vertices > 1 ? vertices : 1;
        const int32_t fillPasses = vertices > 3 ? (vertices + 2) / 3 : 1; // 0x54: three vertices a pass
        const int32_t lightPasses = vertices > 2 ? (vertices + 1) / 2 : 1; // 0x18: two vertices a pass
        const int32_t packetA = c.loadWord(kPacketPointerQword, 0);
        const int32_t packetB = c.loadWord(kPacketPointerQword, 1);
        uint32_t index = startIndex;
        for (uint32_t step = 0; step < kMaxCommands && index < kMaxListQwords; ++step, ++index)
        {
            const uint32_t command = peekCommand(c, index);
            switch (command)
            {
            case kCmdEnd:
                return true;
            case kCmdFaceNormals:
                if (!writeRangeClear(top, indexBase + 1, 2 * facePasses - 1))
                    return refuse(refusal, Vu1Refusals::Reason::WriteRange, command);
                break;
            case kCmdCull:
                if (!writeRangeClear(top, indexBase, 2 * facePasses - 1))
                    return refuse(refusal, Vu1Refusals::Reason::WriteRange, command);
                break;
            case kCmdTransform:
                if (!writeRangeClear(top, 40, 3 * stagePasses))
                    return refuse(refusal, Vu1Refusals::Reason::WriteRange, command);
                break;
            case kCmdFade:
                if (!writeRangeClear(top, 42, 3 * stagePasses - 2))
                    return refuse(refusal, Vu1Refusals::Reason::WriteRange, command);
                break;
            case kCmdTemplateFill:
                if (!writeRangeClear(top, 41, 9 * fillPasses - 2))
                    return refuse(refusal, Vu1Refusals::Reason::WriteRange, command);
                break;
            case kCmdLight:
                if (!writeRangeClear(top, 41, 6 * lightPasses - 2))
                    return refuse(refusal, Vu1Refusals::Reason::WriteRange, command);
                break;
            case kCmdBuildPacket:
            case kCmdDrawUntextured:
                if (!writeRangeClear(top, 290, 1) || !writeRangeClear(top, 300, 1) ||
                    !writeRangeClear(top, packetA + 1, 9) || !writeRangeClear(top, packetB + 1, 9))
                    return refuse(refusal, Vu1Refusals::Reason::WriteRange, command);
                break;
            default:
                return refuse(refusal, Vu1Refusals::Reason::ResumeCommand, command);
            }
        }
        return refuse(refusal, Vu1Refusals::Reason::NoEnd);
    }

    Outcome fromHandler(bool reachedNextCommand)
    {
        return reachedNextCommand ? Outcome::NextCommand : Outcome::NotImplemented;
    }

    // Runs one command. NotImplemented hands back to the microcode at 0x1b60 with vi1/vi14
    // already set for this command's re-read; every other register and every data qword is
    // already what the microcode would have left, so the resume is exact.
    Outcome runCommand(Ctx &c, uint32_t command)
    {
        switch (command)
        {
        case kCmdWorldObject:
            return cmdWorldObject(c);
        case kCmdLoopBack:
            return cmdPrimitiveLoopBack(c);
        case kCmdUnpack:
            return fromHandler(cmdUnpackVertices(c));
        case kCmdUnpackScaled:
            return fromHandler(cmdUnpackScaledVertices(c));
        case kCmdDrawUntextured:
            return fromHandler(cmdDrawUntexturedTriangles(c));
        case kCmdCull:
            return fromHandler(cmdBackfaceCull(c));
        case kCmdTransform:
            return fromHandler(cmdTransformDivide(c));
        case kCmdClippedTransform:
            return fromHandler(cmdClippedTransform(c));
        case kCmdFade:
            return fromHandler(cmdDistanceFade(c));
        case kCmdClippedFade:
            return fromHandler(cmdClippedFade(c));
        case kCmdTemplateFill:
            return fromHandler(cmdTemplateFill(c));
        case kCmdClippedTemplateFill:
            return fromHandler(cmdClippedTemplateFill(c));
        case kCmdLight:
            return fromHandler(cmdLighting(c));
        case kCmdClippedLight:
            return fromHandler(cmdClippedLighting(c));
        case kCmdBuildPacket:
            return fromHandler(cmdBuildPacketDispatched(c));
        case kCmdFlushPacket:
            return fromHandler(cmdFlushPacketDispatched(c));
        case kCmdKickRenderState:
            return fromHandler(cmdKickRenderState(c));
        case kCmdDrawGateOff:
            return fromHandler(cmdDrawGateOff(c));
        case kCmdDrawGateOn:
            return fromHandler(cmdDrawGateOn(c));
        case kCmdInlineBlockOverA:
            return fromHandler(cmdInlineBlockOverA(c));
        case kCmdInlineBlockOverB:
            return fromHandler(cmdInlineBlockOverB(c));
        case kCmdSphereMapBlock:
            return fromHandler(cmdSphereMapBlock(c));
        case kCmdFaceNormals:
            if (!c.faceNormals)
                return Outcome::NotImplemented; // at 0x1b50 a 0x66 stays the microcode's
            return fromHandler(cmdFaceNormals(c));
        default:
            return Outcome::NotImplemented;
        }
    }
}

namespace
{
    // 0x1b60 onward: the dispatcher's read-dispatch loop from the vi1/vi14 the entry left, to the E bit or a
    // hand-back at 0x1b60. Both entries share it: 0x1b50 after XTOP and `vi14 = 0`, 0x33c8 after its repack
    // with the live-in vi14. `entryPc` keys PS2X_VU1_NATIVE_REFUSALS' mid-list hand-backs.
    bool runFromNextCommand(Ctx &c, uint32_t entryPc)
    {
        for (;;)
        {
            // 0x1b60-0x1b90: read the command word, form the jump-table address, jump.
            //   vi5 = data[340 + vi14].x (low 16)   vi4 = 884 (= 0x1ba0 / 8, the jump table)
            //   vi14 += 1                           vi3 = vi5 + vi4 -> JR
            // The jump-table slot is a `B <handler>` pair, so handler pc = 0x1ba0 + 8 * command.
            const int32_t index = c.vi(14);
            const uint32_t command = static_cast<uint32_t>(c.loadWord(kCommandListQword + index, 0)) & 0xFFFFu;

            // The dispatcher's own register writes, in microcode order and before the handler runs.
            c.vi(5) = static_cast<int32_t>(static_cast<int16_t>(command));
            c.vi(4) = 884;
            c.vi(14) = static_cast<int32_t>(static_cast<int16_t>(index + 1));
            c.vi(3) = static_cast<int32_t>(static_cast<int16_t>(c.vi(5) + c.vi(4)));

            if (command == kCmdEnd)
            {
                // 0x1b40's E bit: one more pair, then the program ends leaving pc = 0x1b50.
                c.vu.m_viBranchBackupValid = false;
                c.vu.m_state.pc = kProgramEndPc;
                return true;
            }

            const Outcome outcome = runCommand(c, command);
            if (outcome == Outcome::ProgramEnd)
            {
                // Command 0x4c's `B 0x1b40`: a family-B list ends here, with its trailing 0x42 never
                // dispatched.
                c.vu.m_viBranchBackupValid = false;
                c.vu.m_state.pc = kProgramEndPc;
                return true;
            }
            if (outcome == Outcome::NotImplemented)
            {
                // Give the microcode the command back, through the same helper the clamps use -- one
                // place decides what a hand-back leaves behind. `index` rather than the helper's
                // vi14 - 1, because a handler that got as far as rewriting vi14 (0x30/0x32) can reach
                // here too, and this command's index is what the re-dispatch needs.
                // PS2X_VU1_NATIVE_REFUSALS: every mid-list hand-back passes here. A command with a handler got
                // here through that handler's ceiling clamp (or 0x30/0x32's dead JR vi6 guard); one without is
                // runCommand's default, which the pre-scan makes unreachable.
                if (Vu1Refusals::enabled())
                    Vu1Refusals::note(entryPc,
                                      isFamilyACommand(command) || isFamilyBCommand(command) ||
                                              isFamilyCCommand(command) || isFamilyDCommand(command) ||
                                              (c.faceNormals && command == kCmdFaceNormals)
                                          ? Vu1Refusals::Reason::HandlerClamp
                                          : Vu1Refusals::Reason::MidUnknownCommand,
                                      command);
                return handBackAtCommandIndex(c, index);
            }
        }
    }
}

// Registered for (image d418194495c25213, entry pc 0x1b50). Returns true when the program ended
// (the interpreter then runs its own end epilogue), false to hand back at vu.m_state.pc.
bool vu1native_socom2_dispatch(VU1Interpreter &vu, uint64_t /*budgetEnd*/)
{
    Ctx c{vu};
    // 0x1b50's XTOP result: the VIF double-buffered input base. Needed by the pre-scan (the header
    // counts live at TOP+2) before it is committed to vi1.
    const int32_t top = static_cast<int32_t>(vu.m_state.top & 0x3FFu);
    // The pc this program was entered at (0x1b50 in the registry), the key PS2X_VU1_NATIVE_REFUSALS counts under.
    const uint32_t entryPc = vu.m_state.pc;
    Vu1Refusals::Refusal refusal;
    if (!vu.m_activeVuData || vu.m_activeVuDataSize < 16u * 1024u)
        refuse(refusal, Vu1Refusals::Reason::NoDataMemory);
    else if (!xgkickIsImmediate())
        refuse(refusal, Vu1Refusals::Reason::XgkickCycleExact);
    else
        isNativeRun(c, top, refusal);
    if (refusal.reason != Vu1Refusals::Reason::None)
    {
        if (Vu1Refusals::enabled())
            Vu1Refusals::note(entryPc, refusal.reason, refusal.command);
        Vu1Refusals::rememberWhole(entryPc, refusal); // PS2X_VU1_DUMP_REFUSED (one relaxed load when off)
        return false; // whole-program hand-back: pc is still 0x1b50 and nothing has been touched
    }

    // 0x1b50: vi1 is the base every handler derives its pointers from.
    // 0x1b58: the command index starts at 0.
    c.vi(1) = top;
    c.vi(14) = 0;

    return runFromNextCommand(c, entryPc);
}

// ps2x_tests only (vu1_ops_tests.cpp's RefusalRig): force the XGKICK model the dispatcher's whole-list guard
// reads (-1 = PS2X_VU1_XGKICK_CYCLE_EXACT as latched, 0 = cycle-exact, 1 = immediate) and the handler-side
// vertex ceiling (-1 = PS2X_VU1_NATIVE_TEST_CEILING as latched, else clamped into [0, kMaxVertices]).
void vu1native_socom2_forceXgkickImmediateForTest(int state)
{
    s_testXgkickImmediate.store(state < 0 ? -1 : (state != 0 ? 1 : 0), std::memory_order_relaxed);
}

void vu1native_socom2_forceVertexCeilingForTest(int32_t ceiling)
{
    s_testVertexCeiling.store(ceiling < 0 ? -1 : ceiling, std::memory_order_relaxed);
}

// Sprint 17 F N1 (docs/research/82): registered for (image d418194495c25213, entry pc 0x33c8) behind
// PS2X_VU1_NATIVE_33C8 (the registry asks this gate after the (hash, pc) match; read once, after developer mode).
bool vu1native_socom2_entry_0x33c8_enabled()
{
    static const bool s_on = ps2x::knobOn("PS2X_VU1_NATIVE_33C8");
    return s_on;
}

// The EE's MSCAL after a 0x52 bone pass. 0x33c8 XTOP vi1; 0x33d0/0x33d8 vi7 = vi5 & 4 -- vi5 is LIVE-IN, the
// previous chunk's flags word; 0x33e8 IBEQ vi7, vi0, 0x3100: not the last bone -> another bone pass, which
// ends at 0x33c8 again (the 0x52 body, no native handler: refused whole as skin_pass). The last bone falls
// through into the repack (repackSkinnedVertices) and `B 0x1b60`, the dispatcher resumed at the LIVE-IN vi14
// (1 in the corpus: q341 = 0x66 of `52 66 08 40 42`). Every refusal is whole-program, before anything is
// written: pc stays 0x33c8 and the generated code runs it. Contract as 0x1b50's: packets, register file and
// VU data memory bit for bit (`vu1_replay --verify --native --regs all` over the 0x33c8 dumps).
bool vu1native_socom2_entry_0x33c8(VU1Interpreter &vu, uint64_t /*budgetEnd*/)
{
    Ctx c{vu};
    c.faceNormals = true;
    const int32_t top = static_cast<int32_t>(vu.m_state.top & 0x3FFu);
    const uint32_t entryPc = vu.m_state.pc;
    // The repack's count (IBNE on a 16-bit register) and the dispatcher's resume index, both live-in.
    const int32_t repackCount = vi16(c.vi(9));
    const int32_t resumeIndex = vi16(c.vi(14));
    Vu1Refusals::Refusal refusal;
    if (!vu.m_activeVuData || vu.m_activeVuDataSize < 16u * 1024u)
        refuse(refusal, Vu1Refusals::Reason::NoDataMemory);
    else if (!xgkickIsImmediate())
        refuse(refusal, Vu1Refusals::Reason::XgkickCycleExact);
    else if ((c.vi(5) & 4) == 0)
        refuse(refusal, Vu1Refusals::Reason::SkinPass);
    else if (!repackFits(top, repackCount))
        refuse(refusal, Vu1Refusals::Reason::RepackRange);
    else if (resumeIndex < 0 || resumeIndex >= static_cast<int32_t>(kMaxListQwords))
        refuse(refusal, Vu1Refusals::Reason::ResumeIndex);
    else if (isNativeRun(c, top, refusal, static_cast<uint32_t>(resumeIndex)))
    {
        // No handler clamp may fire after the repack has stored: the handler-side ceilings (lowered only by the
        // test knobs) are checked here, whole-program, against the header the scan read. 0x66, 0x06, 0x08, 0x10, 0x18,
        // 0x28, 0x40 and 0x54 -- all proveResumedWrites admits -- loop on these two counts and nothing else (0x10's,
        // 0x54's and 0x18's clamps, at 0x0f90, 0x05e0 and 0x1458, are TOP+2.z against vertexCeiling(), as 0x08's;
        // 0x28's, at 0x17d0, is TOP+2.w against triangleCeiling(), as 0x40's).
        if (c.loadWord(top + 2, 2) > vertexCeiling())
            refuse(refusal, Vu1Refusals::Reason::HeaderVertices);
        else if (c.loadWord(top + 2, 3) > triangleCeiling())
            refuse(refusal, Vu1Refusals::Reason::HeaderTriangles);
        else
            // Every store range the program can make, proven off the list, the header and the packet pointers.
            proveResumedWrites(c, top, static_cast<uint32_t>(resumeIndex), refusal);
    }
    if (refusal.reason != Vu1Refusals::Reason::None)
    {
        if (Vu1Refusals::enabled())
            Vu1Refusals::note(entryPc, refusal.reason, refusal.command);
        Vu1Refusals::rememberWhole(entryPc, refusal); // PS2X_VU1_DUMP_REFUSED: the state is still the entry's
        return false; // whole-program hand-back: pc is still 0x33c8 and nothing has been touched
    }

    c.vi(1) = top;                                  // 0x33c8 XTOP vi1
    c.vi(7) = vi16(c.vi(5) & 4);                    // 0x33d0 IADDIU vi7, vi0, 4; 0x33d8 IAND vi7, vi5, vi7 (= 4)
    repackSkinnedVertices(c);                       // 0x33e8 IBEQ not taken; 0x33f8-0x3498
    return runFromNextCommand(c, entryPc);          // 0x3490 B 0x1b60, vi14 as the previous program left it
}
