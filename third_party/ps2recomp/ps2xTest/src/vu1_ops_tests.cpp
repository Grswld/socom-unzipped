// VU1 ops: the product-sum fast path (vu1ops::fmacProductSum4) against its slow classifier
// (vu1ops::fmacProductSum4Slow), the oracle. Sprint 17 F, research/81 candidate C1: a lane whose
// accumulator and product are both exact zeros used to fail the fast path's `pp != -acc` test
// (+0 == -0) and pay for the double-precision classifier; it now may take the fast path, with the
// slow path's value and flags bit for bit. The near shapes -- acc == -p non-zero, a product that
// underflows to zero, a denormal result -- must still go slow.
// Candidate C2 (the "flag ring" cases): fastCommit's flag-ring drain, entry by entry against in one
// step (PS2X_VU1_COMMIT_BATCH=1), through Vu1FlagRingProbe below.
#include "MiniTest.h"
#include "ps2x/knobs.h"
#include "vu/ps2_vu1_ops.h"
#include "runtime/gs/gs_frontend.h"
#include "runtime/ps2_memory.h"
#include "runtime/ps2_vu1.h"
#include "runtime/vu1_native_refusals.h"   // Sprint 17 F: the native dispatcher's refusal count
#include "runtime/vu1_dump_refused.h"      // Sprint 17 F N1c: PS2X_VU1_DUMP_REFUSED
#include "runtime/vu1_native_warning.h"    // Sprint 17 F b1: the foreign-disc warning's clock

#include <algorithm>
#include <cfloat>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <emmintrin.h>
#include <limits>
#include <memory>
#include <string>
#include <vector>

namespace
{
    using vu1ops::FmacResult;
    using vu1ops::ZeroLanes;

    float fromBits(uint32_t bits)
    {
        float value = 0.0f;
        std::memcpy(&value, &bits, sizeof(value));
        return value;
    }

    // MXCSR rounding control for the scope (0x6000 = toward zero, the VU's; 0 = nearest).
    struct RoundingScope
    {
        uint32_t saved;
        explicit RoundingScope(uint32_t rc) : saved(_mm_getcsr()) { _mm_setcsr((saved & ~0x6000u) | rc); }
        ~RoundingScope() { _mm_setcsr(saved); }
    };

    // One lane shape; the other three lanes hold a filler that takes the fast path either way.
    struct Shape
    {
        float acc, a, b;
    };
    constexpr Shape kFiller = {2.0f, 1.5f, 3.0f};

    struct Lanes
    {
        __m128 acc, a, b;
    };

    Lanes place(const Shape &shape, uint32_t lane)
    {
        alignas(16) float acc[4], a[4], b[4];
        for (uint32_t i = 0; i < 4u; ++i)
        {
            const Shape &s = i == lane ? shape : kFiller;
            acc[i] = s.acc;
            a[i] = s.a;
            b[i] = s.b;
        }
        Lanes out{_mm_load_ps(acc), _mm_load_ps(a), _mm_load_ps(b)};
        // Opaque to the optimiser: no constant folding under an assumed rounding mode.
        __asm__ __volatile__("" : "+x"(out.acc), "+x"(out.a), "+x"(out.b));
        return out;
    }

    // Empty when fmacProductSum4<Sub, Zero> and the slow classifier agree on the dest lanes' value
    // bits, MAC, status and sticky; else what differs.
    template <bool Sub, ZeroLanes Zero>
    std::string diffAgainstSlow(const Lanes &in, uint8_t dest)
    {
        FmacResult fast{};
        FmacResult slow{};
        vu1ops::fmacProductSum4<Sub, Zero>(in.acc, in.a, in.b, dest, fast);
        vu1ops::fmacProductSum4Slow<Sub>(in.acc, in.a, in.b, dest, slow);
        alignas(16) float fv[4], sv[4];
        _mm_store_ps(fv, fast.value);
        _mm_store_ps(sv, slow.value);
        const uint32_t destBits = vu1ops::kRev4[dest & 0xFu];
        std::string why;
        for (uint32_t i = 0; i < 4u; ++i)
            if ((destBits >> i) & 1u)
                if (vu1ops::bitsOf(fv[i]) != vu1ops::bitsOf(sv[i]))
                    why += " value lane " + std::to_string(i);
        if (fast.mac != slow.mac)
            why += " mac " + std::to_string(fast.mac) + "!=" + std::to_string(slow.mac);
        if (fast.status != slow.status)
            why += " status " + std::to_string(fast.status) + "!=" + std::to_string(slow.status);
        if (fast.sticky != slow.sticky)
            why += " sticky " + std::to_string(fast.sticky) + "!=" + std::to_string(slow.sticky);
        return why;
    }

    std::string describe(const Shape &s, bool sub, uint32_t lane, uint8_t dest, uint32_t rc)
    {
        return std::string(sub ? "MSUB" : "MADD") + " acc=" + std::to_string(vu1ops::bitsOf(s.acc)) +
               " a=" + std::to_string(vu1ops::bitsOf(s.a)) + " b=" + std::to_string(vu1ops::bitsOf(s.b)) +
               " lane=" + std::to_string(lane) + " dest=" + std::to_string(dest) + " rc=" + std::to_string(rc);
    }

    // Every exact-zero shape: acc = +/-0, and a or b = +/-0 (the other +/-0 or +/-1.5).
    std::vector<Shape> zeroShapes()
    {
        const float zeros[2] = {0.0f, -0.0f};
        const float operands[4] = {0.0f, -0.0f, 1.5f, -1.5f};
        std::vector<Shape> shapes;
        for (float acc : zeros)
            for (float a : operands)
                for (float b : operands)
                    if (vu1ops::bitsOf(a) << 1 == 0u || vu1ops::bitsOf(b) << 1 == 0u)
                        shapes.push_back({acc, a, b});
        return shapes;
    }

    struct Tally
    {
        uint32_t checked = 0;
        uint32_t failed = 0;
        std::string first;
        void fail(const std::string &what)
        {
            if (failed++ == 0u)
                first = what;
        }
        std::string report(const char *what) const
        {
            return std::string(what) + ": " + std::to_string(failed) + " of " + std::to_string(checked) + "; first:" + first;
        }
    };

    template <bool Sub>
    void sweepZeroShapes(Tally &taken, Tally &same, uint32_t rc)
    {
        for (const Shape &shape : zeroShapes())
            for (uint32_t lane = 0; lane < 4u; ++lane)
            {
                const Lanes in = place(shape, lane);
                ++taken.checked;
                if (vu1ops::productSumPathLanes<Sub, ZeroLanes::Fast>(in.acc, in.a, in.b) != 0xFu)
                    taken.fail(" " + describe(shape, Sub, lane, 0xF, rc));
                for (uint8_t dest = 1; dest < 16u; ++dest)
                {
                    ++same.checked;
                    const std::string why = diffAgainstSlow<Sub, ZeroLanes::Fast>(in, dest);
                    if (!why.empty())
                        same.fail(" " + describe(shape, Sub, lane, dest, rc) + ":" + why);
                }
            }
    }

    // The near shapes: each lane must stay off the fast path, and the whole op must still match.
    template <bool Sub>
    std::vector<Shape> nearShapes()
    {
        const float fltMin = std::numeric_limits<float>::min();
        return {
            {Sub ? 4.5f : -4.5f, 1.5f, 3.0f},       // acc == -p, non-zero: an exact zero sum, slow as before
            {0.0f, 1e-30f, 1e-30f},                 // p chops to +0 but a*b != 0: the sum underflows (U|Z)
            {-0.0f, -1e-30f, 1e-30f},               // the same, negative
            {1.5f * fltMin, -fltMin, Sub ? -1.0f : 1.0f}, // r = 0.5 * FLT_MIN, a denormal: underflow
            {fromBits(0x00000001u), 0.0f, 1.5f},    // acc a denormal (never normalized away here): not an exact zero
            {0.0f, 1.5f, 3.0f},                     // acc zero, product not: the ordinary fast path
        };
    }

    template <bool Sub>
    void sweepNearShapes(Tally &slowTaken, Tally &same, uint32_t rc)
    {
        const std::vector<Shape> shapes = nearShapes<Sub>();
        for (size_t k = 0; k < shapes.size(); ++k)
            for (uint32_t lane = 0; lane < 4u; ++lane)
            {
                const Lanes in = place(shapes[k], lane);
                const bool mustBeSlow = k + 1u < shapes.size();   // the last one is the fast control
                ++slowTaken.checked;
                const bool fastLane = ((vu1ops::productSumPathLanes<Sub, ZeroLanes::Fast>(in.acc, in.a, in.b) >> lane) & 1u) != 0u;
                if (fastLane == mustBeSlow)
                    slowTaken.fail(" " + describe(shapes[k], Sub, lane, 0xF, rc) + (mustBeSlow ? " went fast" : " went slow"));
                for (uint8_t dest = 1; dest < 16u; ++dest)
                {
                    ++same.checked;
                    const std::string why = diffAgainstSlow<Sub, ZeroLanes::Fast>(in, dest);
                    if (!why.empty())
                        same.fail(" " + describe(shapes[k], Sub, lane, dest, rc) + ":" + why);
                }
            }
    }

    // Every normalized lane value the VU can hold, one lane at a time, both zero-lane modes.
    template <bool Sub, ZeroLanes Zero>
    void sweepAll(Tally &same, uint32_t rc)
    {
        const float fltMin = std::numeric_limits<float>::min();
        const float fltMax = std::numeric_limits<float>::max();
        const float values[] = {0.0f, -0.0f, 1.5f, -1.5f, 3.0f, fltMin, -fltMin, 1.5f * fltMin,
                                1e-30f, -1e-30f, 1e20f, fltMax, -fltMax};
        for (float acc : values)
            for (float a : values)
                for (float b : values)
                    for (uint32_t lane = 0; lane < 4u; ++lane)
                    {
                        const Shape shape{acc, a, b};
                        const Lanes in = place(shape, lane);
                        for (uint8_t dest = 1; dest < 16u; ++dest)
                        {
                            ++same.checked;
                            const std::string why = diffAgainstSlow<Sub, Zero>(in, dest);
                            if (!why.empty())
                                same.fail(" " + describe(shape, Sub, lane, dest, rc) + ":" + why);
                        }
                    }
    }

    FmacResult runOne(bool sub, const Shape &shape, uint32_t lane, uint8_t dest)
    {
        const Lanes in = place(shape, lane);
        FmacResult out{};
        if (sub)
            vu1ops::fmacProductSum4<true, ZeroLanes::Fast>(in.acc, in.a, in.b, dest, out);
        else
            vu1ops::fmacProductSum4<false, ZeroLanes::Fast>(in.acc, in.a, in.b, dest, out);
        return out;
    }
}

// Sprint 17 F, research/81 candidate C2: the fast path's flag ring drained entry by entry
// (fastCommitWith<false>, the old path) and in one step (fastCommitWith<true>, PS2X_VU1_COMMIT_BATCH=1).
// VU1Interpreter befriends this probe; it drives two interpreters through the same pushes, cycle
// advances and commits and compares everything a later reader can see: the flag registers and
// m_lastMacPc, Q and P, the head, count and next-ready cycle, and each slot's valid bit plus, for a
// live slot, its fields. A !valid slot's other fields are not compared: no reader looks at them (the
// invariants block in ps2_vu1_core.cpp), and the one-step drain leaves them as they were.
struct Vu1FlagRingProbe
{
    using VU = VU1Interpreter;
    using Entry = VU1Interpreter::FlagPipelineEntry;

    static std::unique_ptr<VU> make()
    {
        auto vu = std::make_unique<VU>(VU::Unit::VU1);
        vu->m_fast = true;
        return vu;
    }
    static uint32_t count(const VU &vu) { return vu.m_fastFlagCount; }
    static bool efuFree(const VU &vu) { return !vu.m_efu[0].valid || !vu.m_efu[1].valid; }
    static void pushMac(VU &vu, uint32_t mac, uint32_t status, uint32_t extra, uint32_t pc)
    {
        vu.m_state.pc = pc;
        vu.fastPushMacFlags(mac, status, extra);
    }
    // An FMAC-shaped entry with its own delay (the fast producers all use kFmacLatency; this puts
    // a later entry ahead of the head's ready cycle, or one ready in its own issue cycle).
    static void pushDelayed(VU &vu, uint32_t delay, uint32_t mac, uint32_t status, uint32_t pc)
    {
        Entry e{};
        e.valid = true;
        e.issueCycle = vu.m_cycle;
        e.readyCycle = vu.m_cycle + delay;
        e.issuePc = pc;
        e.mac = mac;
        e.status = status;
        e.writesMac = true;
        e.writesStatus = true;
        vu.fastPushFlags(e);
    }
    static void fsset(VU &vu, uint16_t imm) { vu.queueFsset(imm); }
    static void clip(VU &vu, uint32_t c) { vu.queueClip(c); }
    static void fcset(VU &vu, uint32_t c) { vu.queueFcset(c); }
    static void q(VU &vu, float v, uint32_t latency, uint32_t di) { vu.queueQ(v, latency, di); }
    static void p(VU &vu, float v, uint32_t latency) { vu.queueP(v, latency); }
    static void advance(VU &vu, uint32_t n) { vu.m_cycle += n; }
    template <bool Batch>
    static void commit(VU &vu) { vu.fastCommitWith<Batch>(); }
    static void commitKnob(VU &vu) { vu.fastCommit(); }
    static bool knob() { return VU::fastCommitBatchKnob(); }
    static void setBatch(bool on) { VU::setFastCommitBatch(on); }   // what run() does with the knob

    // Every field of every slot, valid or not: the two drains differ here by design (the old one
    // zeroes a landed slot, the one-step one clears only its valid bit), which is what tells which
    // drain fastCommit dispatched to.
    static std::string rawDiff(const VU &a, const VU &b)
    {
        for (uint32_t slot = 0; slot < VU::kMaxFlagEntries; ++slot)
        {
            const Entry &x = a.m_flagPipeline[slot];
            const Entry &y = b.m_flagPipeline[slot];
            if (x.valid != y.valid || x.readyCycle != y.readyCycle || x.issueCycle != y.issueCycle ||
                x.issuePc != y.issuePc || x.mac != y.mac || x.status != y.status || x.extraSticky != y.extraSticky ||
                x.clip != y.clip || x.writesMac != y.writesMac || x.writesStatus != y.writesStatus ||
                x.writesSticky != y.writesSticky || x.writesClip != y.writesClip)
                return " slot " + std::to_string(slot) + " raw contents";
        }
        return {};
    }
    static bool pending(const VU &vu) { return vu.pipelinesPending(); }
    static uint32_t status(const VU &vu) { return vu.m_state.status; }
    static uint32_t mac(const VU &vu) { return vu.m_state.mac; }
    static uint32_t clipReg(const VU &vu) { return vu.m_state.clip; }
    static uint32_t lastMacPc(const VU &vu) { return vu.m_lastMacPc; }

    // Empty when a slot is valid exactly inside the live window head .. head + count - 1.
    static std::string windowFault(const VU &vu)
    {
        for (uint32_t slot = 0; slot < VU::kMaxFlagEntries; ++slot)
        {
            const uint32_t offset = (slot + VU::kMaxFlagEntries - vu.m_fastFlagHead) % VU::kMaxFlagEntries;
            const bool live = offset < vu.m_fastFlagCount;
            if (vu.m_flagPipeline[slot].valid != live)
                return " slot " + std::to_string(slot) + (live ? " live but !valid" : " valid outside the live window") +
                       " (head " + std::to_string(vu.m_fastFlagHead) + ", count " + std::to_string(vu.m_fastFlagCount) + ")";
        }
        return {};
    }

    // Empty when the two interpreters agree on everything a reader of the ring can see.
    static std::string diff(const VU &a, const VU &b)
    {
        std::string why;
        const auto field = [&why](const char *name, uint64_t x, uint64_t y)
        {
            if (x != y)
                why += std::string(" ") + name + " " + std::to_string(x) + "!=" + std::to_string(y);
        };
        field("mac", a.m_state.mac, b.m_state.mac);
        field("status", a.m_state.status, b.m_state.status);
        field("clip", a.m_state.clip, b.m_state.clip);
        field("lastMacPc", a.m_lastMacPc, b.m_lastMacPc);
        field("q", vu1ops::bitsOf(a.m_state.q), vu1ops::bitsOf(b.m_state.q));
        field("p", vu1ops::bitsOf(a.m_state.p), vu1ops::bitsOf(b.m_state.p));
        field("head", a.m_fastFlagHead, b.m_fastFlagHead);
        field("count", a.m_fastFlagCount, b.m_fastFlagCount);
        field("nextReady", a.m_nextReadyCycle, b.m_nextReadyCycle);
        field("fdiv.valid", a.m_fdiv.valid, b.m_fdiv.valid);
        for (uint32_t i = 0; i < 2u; ++i)
            field("efu.valid", a.m_efu[i].valid, b.m_efu[i].valid);
        field("pending", a.pipelinesPending(), b.pipelinesPending());
        for (uint32_t slot = 0; slot < VU::kMaxFlagEntries; ++slot)
        {
            const Entry &x = a.m_flagPipeline[slot];
            const Entry &y = b.m_flagPipeline[slot];
            if (x.valid != y.valid)
            {
                why += " slot " + std::to_string(slot) + " valid " + std::to_string(x.valid) + "!=" + std::to_string(y.valid);
                continue;
            }
            if (!x.valid)
                continue;
            if (x.readyCycle != y.readyCycle || x.issueCycle != y.issueCycle || x.issuePc != y.issuePc ||
                x.mac != y.mac || x.status != y.status || x.extraSticky != y.extraSticky || x.clip != y.clip ||
                x.writesMac != y.writesMac || x.writesStatus != y.writesStatus ||
                x.writesSticky != y.writesSticky || x.writesClip != y.writesClip)
                why += " slot " + std::to_string(slot) + " fields";
        }
        return why;
    }
};

namespace
{
    // The old drain and the one-step drain side by side; every step is checked on both.
    struct RingPair
    {
        using P = Vu1FlagRingProbe;
        std::unique_ptr<VU1Interpreter> perEntry = P::make();
        std::unique_ptr<VU1Interpreter> oneStep = P::make();
        uint32_t step = 0;
        uint32_t commits = 0;
        std::string first;
        uint32_t failed = 0;

        void check(const char *what)
        {
            ++step;
            std::string why = P::diff(*perEntry, *oneStep);
            const std::string windowOld = P::windowFault(*perEntry);
            const std::string windowNew = P::windowFault(*oneStep);
            if (!windowOld.empty())
                why += " per-entry ring:" + windowOld;
            if (!windowNew.empty())
                why += " one-step ring:" + windowNew;
            if (!why.empty() && failed++ == 0u)
                first = "step " + std::to_string(step) + " (" + what + "):" + why;
        }
        template <class F>
        void both(const char *what, F f)
        {
            f(*perEntry);
            f(*oneStep);
            check(what);
        }
        void commit()
        {
            ++commits;
            P::commit<false>(*perEntry);
            P::commit<true>(*oneStep);
            check("commit");
        }
        void mac(uint32_t mac, uint32_t status, uint32_t extra, uint32_t pc)
        {
            both("fmac", [&](VU1Interpreter &vu) { P::pushMac(vu, mac, status, extra, pc); });
        }
        void advance(uint32_t n) { both("advance", [&](VU1Interpreter &vu) { P::advance(vu, n); }); }
        std::string report() const { return std::to_string(failed) + " of " + std::to_string(step) + " steps differ; first: " + first; }
    };

    // A deterministic generator for the mixed-sequence case.
    struct Lcg
    {
        uint64_t s;
        uint32_t next()
        {
            s = s * 6364136223846793005ull + 1442695040888963407ull;
            return static_cast<uint32_t>(s >> 33);
        }
        uint32_t below(uint32_t n) { return next() % n; }
    };

    // Sprint 17 F N1c, the real shapes: RealDump, and last-bone 0x33c8 entry states from the walk's refused capture.
#include "vu1_33c8_real_dumps.inc"
    // Sprint 17 F N2: 0x52 bone passes, 0x52 lists and one mesh's MSCAL chain from logs/vu1dump3.
#include "vu1_52_real_dumps.inc"
}

void register_vu1_ops_tests()
{
    MiniTest::Case("VU1Ops", [](TestCase &tc)
    {
        tc.Run("product-sum: every exact-zero lane takes the fast path, bit-identical to the slow classifier", [](TestCase &t)
        {
            Tally taken, same;
            for (uint32_t rc : {0x6000u, 0x0000u})
            {
                RoundingScope scope(rc);
                sweepZeroShapes<false>(taken, same, rc);
                sweepZeroShapes<true>(taken, same, rc);
            }
            t.IsTrue(taken.checked == 2u * 2u * 24u * 4u, "the sweep covers 24 zero shapes x 4 lanes x MADD/MSUB x 2 roundings");
            t.IsTrue(taken.failed == 0u, taken.report("zero lanes refused by the fast path"));
            t.IsTrue(same.failed == 0u, same.report("zero lanes differing from the slow classifier"));
        });

        tc.Run("product-sum: a zero lane's flags are Z (and S for -0), product sticky Z plus p's sign", [](TestCase &t)
        {
            RoundingScope scope(0x6000u);
            // MADDA.w, acc.w = +0, a.w = 0, b.w = 1.5: +0, MAC Z(w), status Z, sticky Z.
            FmacResult out = runOne(false, {0.0f, 0.0f, 1.5f}, 3u, 0x1u);
            t.Equals(out.mac, 0x0001u, "+0 + +0: MAC Z for w only");
            t.Equals(out.status, 0x1u, "+0 + +0: status Z");
            t.Equals(out.sticky, 0x1u, "+0 + +0: product sticky Z");
            // acc.w = -0, a.w = -0, b.w = 1.5: -0 + -0 = -0, MAC Z|S, status Z|S, sticky Z|S.
            out = runOne(false, {-0.0f, -0.0f, 1.5f}, 3u, 0x1u);
            t.Equals(out.mac, 0x0011u, "-0 + -0: MAC Z and S for w");
            t.Equals(out.status, 0x3u, "-0 + -0: status Z and S");
            t.Equals(out.sticky, 0x3u, "-0 + -0: product sticky Z and S");
            // acc.w = -0, p = +0: +0 under chop (only round-down makes -0).
            out = runOne(false, {-0.0f, 0.0f, 1.5f}, 3u, 0x1u);
            t.Equals(out.mac, 0x0001u, "-0 + +0 is +0: MAC Z only");
            t.Equals(out.sticky, 0x1u, "p = +0: sticky Z only");
            // MSUB: acc = +0, p = +0 -> +0 - +0 = +0; acc = -0, p = +0 -> -0 - +0 = -0.
            out = runOne(true, {-0.0f, 0.0f, 1.5f}, 3u, 0x1u);
            t.Equals(out.mac, 0x0011u, "MSUB -0 - +0 is -0: MAC Z and S");
            // xyzw with the zero in w: the filler lanes keep their fast-path result (no flags).
            out = runOne(false, {0.0f, 0.0f, 1.5f}, 3u, 0xFu);
            t.Equals(out.mac, 0x0001u, "MADDA.xyzw with a zero w: only w's Z");
        });

        tc.Run("PS2X_VU1_FMAC_ZERO_FAST is a Dev Flag defaulting to the adopted fast path", [](TestCase &t)
        {
            const ps2x::knobs::Entry *e = ps2x::knobs::find("PS2X_VU1_FMAC_ZERO_FAST");
            t.IsTrue(e != nullptr && e->cls == ps2x::knobs::Class::Dev && e->kind == ps2x::knobs::Kind::Flag &&
                         std::string(e->dflt) == "1",
                     "a Dev Flag, default 1 (R337: C1 picked, the zero-lane fast path adopted; 0 = the old path)");
            if (ps2x::knob("PS2X_VU1_FMAC_ZERO_FAST") == nullptr)
                t.IsTrue(vu1ops::fmacZeroFastKnob(), "unset: the zero lanes take the fast path");
        });

        tc.Run("product-sum: the near shapes (acc == -p, an underflowing product, a denormal result) stay slow", [](TestCase &t)
        {
            Tally slowTaken, same;
            for (uint32_t rc : {0x6000u, 0x0000u})
            {
                RoundingScope scope(rc);
                sweepNearShapes<false>(slowTaken, same, rc);
                sweepNearShapes<true>(slowTaken, same, rc);
            }
            t.IsTrue(slowTaken.failed == 0u, slowTaken.report("near shapes on the wrong path"));
            t.IsTrue(same.failed == 0u, same.report("near shapes differing from the slow classifier"));
        });

        tc.Run("product-sum: every normalized lane value matches the slow classifier, zero lanes fast or slow", [](TestCase &t)
        {
            Tally fastMode, slowMode, knobMode;
            for (uint32_t rc : {0x6000u, 0x0000u})
            {
                RoundingScope scope(rc);
                sweepAll<false, ZeroLanes::Fast>(fastMode, rc);
                sweepAll<true, ZeroLanes::Fast>(fastMode, rc);
                sweepAll<false, ZeroLanes::Slow>(slowMode, rc);
                sweepAll<true, ZeroLanes::Slow>(slowMode, rc);
                sweepAll<false, ZeroLanes::Knob>(knobMode, rc);   // what the runtime runs, knob as set
                sweepAll<true, ZeroLanes::Knob>(knobMode, rc);
            }
            t.IsTrue(fastMode.failed == 0u, fastMode.report("PS2X_VU1_FMAC_ZERO_FAST=1 shape differing"));
            t.IsTrue(slowMode.failed == 0u, slowMode.report("the old path differing"));
            t.IsTrue(knobMode.failed == 0u, knobMode.report("the knob-selected path differing"));
        });

        using P = Vu1FlagRingProbe;

        tc.Run("flag ring: two FMACs in one cycle land in issue order, the later one's MAC wins", [](TestCase &t)
        {
            RingPair r;
            r.mac(0x0F0u, 0x1u, 0x0u, 0x10u);
            r.mac(0x00Fu, 0x8u, 0x2u, 0x18u);   // same cycle
            r.advance(3u);
            r.commit();                          // issue + 3: neither is ready (4-cycle latency)
            t.IsTrue(P::count(*r.oneStep) == 2u && P::mac(*r.oneStep) == 0u, "nothing lands before issue + 4");
            r.advance(1u);
            r.commit();
            t.IsTrue(r.failed == 0u, r.report());
            t.IsTrue(P::count(*r.oneStep) == 0u, "both landed");
            t.IsTrue(P::mac(*r.oneStep) == 0x00Fu && P::lastMacPc(*r.oneStep) == 0x18u, "MAC and its pc from the later FMAC");
            // 0x41 after the first; then (0x41 & 0xFF0) | 0x8 | ((0x8 | 0x2) << 6).
            t.IsTrue(P::status(*r.oneStep) == 0x2C8u, "STATUS: the later current half, both sticky halves ORed");
        });

        tc.Run("flag ring: an FMAC and an FSSET in one cycle (both orders), a CLIP and an FCSET in one cycle", [](TestCase &t)
        {
            RingPair r;
            r.mac(0x111u, 0x1u, 0x0u, 0x08u);
            r.advance(4u);
            r.commit();                                        // STATUS 0x41
            r.mac(0x123u, 0x2u, 0x0u, 0x20u);
            r.both("fsset", [](VU1Interpreter &vu) { P::fsset(vu, 0x540u); });   // clears the FMAC's writesStatus
            r.advance(4u);
            r.commit();
            t.IsTrue(P::mac(*r.oneStep) == 0x123u, "the FMAC beside the FSSET still lands its MAC");
            t.IsTrue(P::status(*r.oneStep) == 0x541u, "but not its STATUS: (0x41 & 0x3F) | 0x540");
            r.both("fsset", [](VU1Interpreter &vu) { P::fsset(vu, 0x000u); });   // FSSET first, FMAC after: both land
            r.mac(0x456u, 0x4u, 0x1u, 0x28u);
            r.advance(4u);
            r.commit();
            t.IsTrue(P::status(*r.oneStep) == ((0x001u & 0xFF0u) | 0x4u | (0x5u << 6)), "FSSET then the FMAC's STATUS");
            r.both("clip", [](VU1Interpreter &vu) { P::clip(vu, 0x15u); });
            r.both("fcset", [](VU1Interpreter &vu) { P::fcset(vu, 0xABCDEFu); });  // the CLIP entry now writes nothing
            r.advance(4u);
            r.commit();
            t.IsTrue(P::clipReg(*r.oneStep) == 0xABCDEFu, "FCSET wins over the CLIP of its cycle");
            t.IsTrue(r.failed == 0u, r.report());
        });

        tc.Run("flag ring: a full ring of 64 lands in one commit, and a full ring in one cycle", [](TestCase &t)
        {
            RingPair r;
            for (uint32_t i = 0; i < 64u; ++i)
            {
                r.mac(0x1000u + i, i & 0xFu, (i * 7u) & 0x3Fu, i * 8u);
                r.advance(1u);
            }
            t.IsTrue(P::count(*r.oneStep) == 64u, "64 queued");
            r.advance(3u);
            r.commit();
            t.IsTrue(P::count(*r.oneStep) == 0u && P::mac(*r.oneStep) == 0x103Fu, "all 64 landed, the last MAC");
            t.IsFalse(P::pending(*r.oneStep), "nothing pending after the drain");
            for (uint32_t i = 0; i < 64u; ++i)
                r.mac(0x2000u + i, (i >> 2) & 0xFu, i & 0x3u, i * 8u);   // one cycle, 64 entries
            r.advance(3u);
            r.commit();
            t.IsTrue(P::count(*r.oneStep) == 64u, "a cycle short: none");
            r.advance(1u);
            r.commit();
            t.IsTrue(P::count(*r.oneStep) == 0u, "then all");
            t.IsTrue(r.failed == 0u, r.report());
        });

        tc.Run("flag ring: holes -- entries writing nothing or MAC only, partial drains, a head wrapping past 63", [](TestCase &t)
        {
            RingPair r;
            for (uint32_t i = 0; i < 40u; ++i)
                r.mac(i, i & 0xFu, 0u, i * 8u);
            r.advance(4u);
            r.commit();                                           // head 40
            for (uint32_t i = 0; i < 30u; ++i)                    // slots 40 .. 63, 0 .. 5
            {
                switch (i % 5u)
                {
                case 0: r.mac(0x300u + i, 0x3u, 0x4u, 0x100u + i); break;
                case 1: r.both("clip", [](VU1Interpreter &vu) { P::clip(vu, 0x2Au); });
                        r.both("fcset", [](VU1Interpreter &vu) { P::fcset(vu, 0x777u); }); break;
                case 2: r.mac(0x400u + i, 0xFu, 0x0u, 0x200u + i);
                        r.both("fsset", [](VU1Interpreter &vu) { P::fsset(vu, 0xFC0u); }); break;
                case 3: r.both("fsset", [](VU1Interpreter &vu) { P::fsset(vu, 0x0C0u); }); break;
                default: r.mac(0x500u + i, 0x0u, 0x3Fu, 0x300u + i); break;
                }
                r.advance(1u);
                if (i % 7u == 6u)
                    r.commit();                                   // drains the entries issued 4+ cycles ago
            }
            t.IsTrue(P::count(*r.oneStep) != 0u, "a partial drain leaves the recent entries");
            r.advance(4u);
            r.commit();
            t.IsTrue(P::count(*r.oneStep) == 0u, "then none");
            t.IsTrue(r.failed == 0u, r.report());
        });

        tc.Run("flag ring: a drain stops at the first entry not ready; Q and P land by their own delays", [](TestCase &t)
        {
            RingPair r;
            r.both("delay 10", [](VU1Interpreter &vu) { P::pushDelayed(vu, 10u, 0x0AAu, 0x1u, 0x40u); });
            r.advance(1u);
            r.mac(0x0BBu, 0x2u, 0x0u, 0x48u);                     // ready at 5, behind a head ready at 10
            r.both("delay 0", [](VU1Interpreter &vu) { P::pushDelayed(vu, 0u, 0x0CCu, 0x4u, 0x50u); });
            r.both("q", [](VU1Interpreter &vu) { P::q(vu, 3.0f, 7u, 0x10u); });
            r.both("p", [](VU1Interpreter &vu) { P::p(vu, 5.0f, 12u); });
            r.both("p", [](VU1Interpreter &vu) { P::p(vu, 6.0f, 3u); });
            r.commit();
            t.IsTrue(P::count(*r.oneStep) == 3u, "the head (ready at 10) blocks the entries behind it");
            r.advance(5u);
            r.commit();                                           // cycle 6: P(3) lands, the ring waits
            t.IsTrue(P::count(*r.oneStep) == 3u && P::mac(*r.oneStep) == 0u, "still blocked at cycle 6");
            r.advance(4u);
            r.commit();                                           // cycle 10: all three, Q
            t.IsTrue(P::count(*r.oneStep) == 0u && P::mac(*r.oneStep) == 0x0CCu, "all three in issue order at 10");
            r.advance(3u);
            r.commit();                                           // cycle 13: the second P
            t.IsFalse(P::pending(*r.oneStep), "nothing pending");
            t.IsTrue(r.failed == 0u, r.report());
        });

        tc.Run("flag ring: after a drain no slot outside the live window is valid (a stale bit is a phantom entry)", [](TestCase &t)
        {
            RingPair r;
            for (uint32_t i = 0; i < 12u; ++i)
                r.both("delay 0", [i](VU1Interpreter &vu) { P::pushDelayed(vu, 0u, 0x600u + i, 0x1u, i * 8u); });
            r.commit();                                           // lands all twelve in their issue cycle
            // The scanners: FSSET/FCSET in the drained entries' issue cycle, and pipelinesPending.
            r.both("fsset", [](VU1Interpreter &vu) { P::fsset(vu, 0x040u); });
            r.both("fcset", [](VU1Interpreter &vu) { P::fcset(vu, 0x1u); });
            t.IsTrue(P::windowFault(*r.oneStep).empty(), "one-step drain:" + P::windowFault(*r.oneStep));
            t.IsTrue(P::count(*r.oneStep) == 2u, "only the FSSET and FCSET are live");
            r.advance(4u);
            r.commit();
            t.IsFalse(P::pending(*r.oneStep), "an empty ring is not pending work");
            t.IsTrue(P::windowFault(*r.oneStep).empty(), "one-step drain, empty:" + P::windowFault(*r.oneStep));
            t.IsTrue(r.failed == 0u, r.report());
        });

        tc.Run("flag ring: 20,000 mixed steps, the two drains identical after every step", [](TestCase &t)
        {
            RingPair r;
            Lcg g{0x5C2F00Du};
            for (uint32_t i = 0; i < 20000u; ++i)
            {
                const uint32_t roll = g.below(100u);
                const bool room = P::count(*r.oneStep) < 64u;
                const uint32_t a = g.next(), b = g.next(), c = g.next();
                if (roll < 40u && room)
                    r.mac(a & 0xFFFFu, b & 0xFu, c & 0x3Fu, (a >> 16) & 0x3FF8u);
                else if (roll < 48u && room)
                    r.both("fsset", [a](VU1Interpreter &vu) { P::fsset(vu, static_cast<uint16_t>(a & 0xFFFu)); });
                else if (roll < 53u && room)
                    r.both("clip", [a](VU1Interpreter &vu) { P::clip(vu, a & 0x3Fu); });
                else if (roll < 56u && room)
                    r.both("fcset", [a](VU1Interpreter &vu) { P::fcset(vu, a & 0xFFFFFFu); });
                else if (roll < 61u && room)
                    r.both("delayed", [a, b](VU1Interpreter &vu) { P::pushDelayed(vu, b % 13u, a & 0xFFFFu, b & 0xFu, 0x10u); });
                else if (roll < 64u)
                    r.both("q", [b](VU1Interpreter &vu) { P::q(vu, static_cast<float>(b & 0xFFu), 7u + (b & 0x7u), b & 0x30u); });
                else if (roll < 67u && P::efuFree(*r.oneStep))
                    r.both("p", [b](VU1Interpreter &vu) { P::p(vu, static_cast<float>(b & 0xFFu), 3u + (b % 29u)); });
                else if (roll < 82u)
                    r.advance(g.below(8u));
                else
                    r.commit();
            }
            r.advance(64u);
            r.commit();
            t.IsTrue(r.commits > 3000u, "enough commits: " + std::to_string(r.commits));
            t.IsTrue(r.failed == 0u, r.report());
        });

        tc.Run("flag ring: PS2X_VU1_COMMIT_BATCH is a Dev Flag, default 0; fastCommit runs the drain the bool run() sets selects", [](TestCase &t)
        {
            const ps2x::knobs::Entry *e = ps2x::knobs::find("PS2X_VU1_COMMIT_BATCH");
            t.IsTrue(e != nullptr && e->cls == ps2x::knobs::Class::Dev && e->kind == ps2x::knobs::Kind::Flag &&
                         std::string(e->dflt) == "0",
                     "a Dev Flag, default 0 (R334: the A/B knob defaults to today's behaviour)");
            if (ps2x::knob("PS2X_VU1_COMMIT_BATCH") == nullptr)
                t.IsFalse(P::knob(), "unset: the per-entry drain");
            // The dispatch: with the bool set as run() sets it, the public fastCommit must run that
            // drain -- the same visible state as the drain run directly after every step, AND the same
            // raw slot contents, which differ between the two drains (so the wrong one is caught).
            for (const bool batch : {false, true})
            {
                P::setBatch(batch);
                auto viaFastCommit = P::make();
                auto direct = P::make();
                Lcg g{0xC2D15Au + batch};
                uint32_t steps = 0, visible = 0, raw = 0, commits = 0;
                std::string first;
                for (uint32_t i = 0; i < 2000u; ++i)
                {
                    const uint32_t roll = g.below(10u);
                    const uint32_t a = g.next();
                    if (roll < 5u && P::count(*direct) < 64u)
                    {
                        P::pushMac(*viaFastCommit, a & 0xFFFFu, a & 0xFu, (a >> 8) & 0x3Fu, (a >> 16) & 0x3FF8u);
                        P::pushMac(*direct, a & 0xFFFFu, a & 0xFu, (a >> 8) & 0x3Fu, (a >> 16) & 0x3FF8u);
                    }
                    else if (roll < 6u && P::count(*direct) < 64u)
                    {
                        P::fsset(*viaFastCommit, static_cast<uint16_t>(a & 0xFFFu));
                        P::fsset(*direct, static_cast<uint16_t>(a & 0xFFFu));
                    }
                    else if (roll < 8u)
                    {
                        P::advance(*viaFastCommit, a & 0x3u);
                        P::advance(*direct, a & 0x3u);
                    }
                    else
                    {
                        ++commits;
                        P::commitKnob(*viaFastCommit);
                        if (batch)
                            P::commit<true>(*direct);
                        else
                            P::commit<false>(*direct);
                    }
                    ++steps;
                    const std::string why = P::diff(*direct, *viaFastCommit);
                    const std::string rawWhy = P::rawDiff(*direct, *viaFastCommit);
                    visible += why.empty() ? 0u : 1u;
                    raw += rawWhy.empty() ? 0u : 1u;
                    if ((!why.empty() || !rawWhy.empty()) && first.empty())
                        first = "step " + std::to_string(steps) + ":" + why + rawWhy;
                }
                const std::string name = batch ? "set 1: fastCommit against the one-step drain"
                                               : "set 0: fastCommit against the per-entry drain";
                t.IsTrue(commits > 100u, name + ", commits " + std::to_string(commits));
                t.IsTrue(visible == 0u && raw == 0u, name + ": " + std::to_string(visible) + " visible and " +
                                                         std::to_string(raw) + " raw differences of " +
                                                         std::to_string(steps) + " steps; first " + first);
            }
            P::setBatch(P::knob());   // back to what run() would set
        });

        // ---- Sprint 17 F (research/81 §3.4): the native dispatcher's refusals, counted -------------------------
        // PS2X_VU1_NATIVE_REFUSALS (runtime/vu1_native_refusals.h). A real refusal is driven through
        // VU1Interpreter::execute with the SOCOM II dispatcher registered at pc 0 of a three-pair image: the
        // dispatcher refuses the planted list before touching anything, the microcode (the E bit at pair 8) runs
        // as the fallback, and its cycles are charged to the refusal. The table is process-wide, so every case
        // reads a before/after delta.
        // The dispatcher's two process-wide inputs are set by the rig, never read from the environment: the
        // XGKICK model (ps2x_tests' main sets PS2X_VU1_XGKICK_CYCLE_EXACT=1 for the PATH1 tests, and under it the
        // dispatcher refuses every list as xgkick_cycle_exact before its pre-scan) and the handler-side vertex
        // ceiling. Each rig forces the default immediate model and the real ceiling, and gives both back to the
        // knobs when it goes out of scope.
        struct RefusalRig
        {
            static void forceXgkickImmediate(int state)   // -1 = the knob, 0 = cycle-exact, 1 = immediate
            {
                void vu1native_socom2_forceXgkickImmediateForTest(int state);
                vu1native_socom2_forceXgkickImmediateForTest(state);
            }
            static void forceVertexCeiling(int32_t ceiling)   // -1 = the knob (PS2X_VU1_NATIVE_TEST_CEILING)
            {
                void vu1native_socom2_forceVertexCeilingForTest(int32_t ceiling);
                vu1native_socom2_forceVertexCeilingForTest(ceiling);
            }
            static void forceClipCeiling(int32_t ceiling)   // -1 = the knob (PS2X_VU1_NATIVE_TEST_CLIP_CEILING)
            {
                void vu1native_socom2_forceClipCeilingForTest(int32_t ceiling);
                vu1native_socom2_forceClipCeilingForTest(ceiling);
            }
            RefusalRig()
            {
                forceXgkickImmediate(1);
                forceVertexCeiling(256);
            }
            ~RefusalRig()
            {
                forceXgkickImmediate(-1);
                forceVertexCeiling(-1);
            }
            RefusalRig(const RefusalRig &) = delete;
            RefusalRig &operator=(const RefusalRig &) = delete;

            PS2Memory mem;
            GS gs;
            uint8_t *code = nullptr;
            uint8_t *data = nullptr;

            bool init()
            {
                if (!mem.initialize())
                    return false;
                gs.init(mem.getGSVRAM(), static_cast<uint32_t>(PS2_GS_VRAM_SIZE), &mem.gs());
                code = mem.getVU1Code();
                data = mem.getVU1Data();
                if (code == nullptr || data == nullptr)
                    return false;
                std::memset(code, 0, PS2_VU1_CODE_SIZE);
                std::memset(data, 0, PS2_VU1_DATA_SIZE);
                // NOP / NOP+E / NOP: entered at 0 the microcode ends after the pair at 16.
                const uint32_t lowerNop = 0x8000033Cu, upperNop = 0x000002FFu, eBit = 1u << 30;
                const uint32_t pairs[3][2] = {{lowerNop, upperNop}, {lowerNop, upperNop | eBit}, {lowerNop, upperNop}};
                std::memcpy(code, pairs, sizeof(pairs));
                mem.markVU1CodeModified();
                return true;
            }
            uint64_t hash() const
            {
                uint64_t h = 1469598103934665603ull;
                for (uint32_t i = 0; i < PS2_VU1_CODE_SIZE; ++i)
                {
                    h ^= code[i];
                    h *= 1099511628211ull;
                }
                return h;
            }
            // Command list word i (qword 340 + i, x lane) and a header word at TOP (= 0) + qword, lane.
            void command(uint32_t index, uint32_t word) { std::memcpy(data + (340u + index) * 16u, &word, 4u); }
            void header(uint32_t qword, uint32_t lane, int32_t value) { std::memcpy(data + qword * 16u + lane * 4u, &value, 4u); }
            // A code pair written after init(): the image's generation moves so run() rehashes it.
            void pair(uint32_t pc, uint32_t lower, uint32_t upper)
            {
                std::memcpy(code + pc, &lower, 4u);
                std::memcpy(code + pc + 4u, &upper, 4u);
                mem.markVU1CodeModified();
            }
            static bool dispatcher(VU1Interpreter &vu, uint64_t budgetEnd)
            {
                bool vu1native_socom2_dispatch(VU1Interpreter &vu, uint64_t budgetEnd);
                return vu1native_socom2_dispatch(vu, budgetEnd);
            }
            // Runs the image at pc 0 with the native table {hash, nativePc, fn}; dBit sets the D-bit enable, one of
            // the states run() does not enter a native program in. Returns the VU cycles the whole program took.
            uint64_t run(uint32_t nativePc, VU1Interpreter::KnownProgramFn fn = &dispatcher, bool dBit = false)
            {
                const Vu1NativeProgram table[] = {{hash(), nativePc, fn}};
                VU1Interpreter vu;
                vu.setNativeProgramsOverride(table, 1u);
                vu.state().dBitEnabled = dBit;
                const uint64_t start = vu.state().cycles;
                vu.execute(code, PS2_VU1_CODE_SIZE, data, PS2_VU1_DATA_SIZE, gs, &mem, 0u, 0u, 0u, 4096u);
                vu.setNativeProgramsOverride(nullptr, 0u);
                return vu.state().cycles - start;
            }
            // The running total of one (entry, reason, command) key.
            static Vu1Refusals::Row row(uint32_t entry, Vu1Refusals::Reason reason, uint32_t command)
            {
                for (const Vu1Refusals::Row &r : Vu1Refusals::live().totals())
                    if (r.entryPc == entry && r.reason == reason && r.command == Vu1Refusals::keyCommand(reason, command))
                        return r;
                return Vu1Refusals::Row{};
            }
        };

        tc.Run("PS2X_VU1_NATIVE_REFUSALS is a Dev Flag defaulting to 0 (off: nothing counted)", [](TestCase &t)
        {
            const ps2x::knobs::Entry *e = ps2x::knobs::find("PS2X_VU1_NATIVE_REFUSALS");
            t.IsTrue(e != nullptr && e->cls == ps2x::knobs::Class::Dev && e->kind == ps2x::knobs::Kind::Flag &&
                         std::string(e->dflt) == "0",
                     "a Dev Flag, default 0 (the refusal count is an instrument, off unless asked for)");
            if (ps2x::knob("PS2X_VU1_NATIVE_REFUSALS") == nullptr)
            {
                Vu1Refusals::enabledState().store(-1);   // forget any earlier decision: read the knob now
                t.IsTrue(!Vu1Refusals::enabled(), "unset: the instrument is off");
            }
        });

        tc.Run("native refusals: knob off, a refused 0x52 list leaves every counter at zero", [](TestCase &t)
        {
            RefusalRig rig;
            t.IsTrue(rig.init(), "rig should initialize");
            rig.command(0u, 0x52u);
            rig.command(1u, 0x42u);
            Vu1Refusals::setEnabledForTest(false);
            const uint64_t before = Vu1Refusals::live().totalCount();
            rig.run(0u);
            t.Equals(Vu1Refusals::live().totalCount(), before, "off: the refusal is not counted");
            t.Equals(Vu1Refusals::takeNoted(), -1, "off: no slot is left for run() to charge");
        });

        tc.Run("native refusals: knob on, a 0x52 list counts unknown_command cmd=0x52 and the fallback's cycles", [](TestCase &t)
        {
            RefusalRig rig;
            t.IsTrue(rig.init(), "rig should initialize");
            rig.command(0u, 0x52u);   // `52 42`: 0x52 has no native handler (the skinning accumulator)
            rig.command(1u, 0x42u);
            Vu1Refusals::setEnabledForTest(true);
            const Vu1Refusals::Row before = RefusalRig::row(0u, Vu1Refusals::Reason::UnknownCommand, 0x52u);
            const uint64_t otherBefore = Vu1Refusals::live().totalCount() - before.n;
            rig.run(0u);
            const Vu1Refusals::Row after = RefusalRig::row(0u, Vu1Refusals::Reason::UnknownCommand, 0x52u);
            Vu1Refusals::setEnabledForTest(false);
            t.Equals(after.n - before.n, 1ull, "one refusal under (entry 0x0, unknown_command, cmd 0x52)");
            t.Equals(Vu1Refusals::live().totalCount() - after.n, otherBefore, "and under no other key");
            t.IsTrue(after.cycles > before.cycles, "the microcode that ran instead is charged to it");
        });

        tc.Run("native refusals: knob on, a 300-vertex header counts header_vertices, not unknown_command", [](TestCase &t)
        {
            RefusalRig rig;
            t.IsTrue(rig.init(), "rig should initialize");
            rig.command(0u, 0x68u);   // `68 42`: every command native, the header over kMaxVertices
            rig.command(1u, 0x42u);
            rig.header(2u, 2u, 300);  // TOP+2.z
            Vu1Refusals::setEnabledForTest(true);
            const uint64_t before = Vu1Refusals::live().countFor(Vu1Refusals::Reason::HeaderVertices);
            const uint64_t unknownBefore = Vu1Refusals::live().countFor(Vu1Refusals::Reason::UnknownCommand);
            rig.run(0u);
            Vu1Refusals::setEnabledForTest(false);
            t.Equals(Vu1Refusals::live().countFor(Vu1Refusals::Reason::HeaderVertices) - before, 1ull, "header_vertices +1");
            t.Equals(Vu1Refusals::live().countFor(Vu1Refusals::Reason::UnknownCommand), unknownBefore, "unknown_command unmoved");
        });

        tc.Run("native refusals: knob on, the cycle-exact XGKICK model counts xgkick_cycle_exact before the pre-scan", [](TestCase &t)
        {
            // What a run with PS2X_VU1_XGKICK_CYCLE_EXACT=1 (and ps2x_tests' own main) reads: every list the
            // dispatcher is entered for is refused whole under xgkick_cycle_exact, whatever its commands.
            RefusalRig rig;
            RefusalRig::forceXgkickImmediate(0);
            t.IsTrue(rig.init(), "rig should initialize");
            rig.command(0u, 0x52u);   // a list the pre-scan would refuse as unknown_command
            rig.command(1u, 0x42u);
            Vu1Refusals::setEnabledForTest(true);
            const Vu1Refusals::Row before = RefusalRig::row(0u, Vu1Refusals::Reason::XgkickCycleExact, 0u);
            const uint64_t total = Vu1Refusals::live().totalCount();
            rig.run(0u);
            const Vu1Refusals::Row after = RefusalRig::row(0u, Vu1Refusals::Reason::XgkickCycleExact, 0u);
            Vu1Refusals::setEnabledForTest(false);
            t.Equals(after.n - before.n, 1ull, "xgkick_cycle_exact at entry 0x0 +1");
            t.Equals(Vu1Refusals::live().totalCount() - total, 1ull, "and nothing else: the pre-scan never ran");
            t.IsTrue(after.cycles > before.cycles, "the microcode's cycles are charged to it");
        });

        tc.Run("native refusals: knob on, an entry pc the image has no native program at counts no_native_entry", [](TestCase &t)
        {
            RefusalRig rig;
            t.IsTrue(rig.init(), "rig should initialize");
            Vu1Refusals::setEnabledForTest(true);
            // research/83 section 3.1: entry 0's key carries its path; the rig's header at TOP 0 is all zero, `none`.
            const uint32_t none = static_cast<uint32_t>(Vu1Refusals::Entry0Path::None);
            const Vu1Refusals::Row before = RefusalRig::row(0u, Vu1Refusals::Reason::NoNativeEntry, none);
            rig.run(8u);              // native registered at pc 8 only; the program is entered at 0
            const Vu1Refusals::Row after = RefusalRig::row(0u, Vu1Refusals::Reason::NoNativeEntry, none);
            Vu1Refusals::setEnabledForTest(false);
            t.Equals(after.n - before.n, 1ull, "no_native_entry at entry 0x0 +1");
            t.IsTrue(after.cycles > before.cycles, "the whole program's cycles are charged to it");
        });

        tc.Run("native refusals: the line's fields and the per-interval take", [](TestCase &t)
        {
            Vu1Refusals::Table table;
            const int slot = table.note(0x1b50u, Vu1Refusals::Reason::UnknownCommand, 0x52u);
            table.note(0x1b50u, Vu1Refusals::Reason::UnknownCommand, 0x52u);
            table.note(0x33c8u, Vu1Refusals::Reason::NoNativeEntry, 0x1234u);   // no command: cmd is not keyed
            table.addCost(slot, 900u, 12000u);
            std::vector<Vu1Refusals::Row> rows = table.take();
            t.Equals(rows.size(), size_t{2}, "two keys moved");
            t.Equals(Vu1Refusals::formatRow("[vu1-refuse]", rows[0], 1002.4),
                     std::string("[vu1-refuse] elapsed=1002ms entry=0x1b50 reason=unknown_command cmd=0x52 n=2 cycles=900 host_us=12"),
                     "sorted by n; the per-second line");
            t.Equals(Vu1Refusals::formatRow("[vu1-refuse-total]", rows[1], -1.0),
                     std::string("[vu1-refuse-total] entry=0x33c8 reason=no_native_entry cmd=- n=1 cycles=0 host_us=0"),
                     "vu1_replay's total line");
            t.Equals(table.take().size(), size_t{0}, "an interval with nothing new prints nothing");
            table.note(0x1b50u, Vu1Refusals::Reason::UnknownCommand, 0x52u);
            rows = table.take();
            t.IsTrue(rows.size() == 1u && rows[0].n == 1u && rows[0].cycles == 0u, "the next interval is a delta");
            t.Equals(table.totals()[0].n, 3ull, "totals keep running");
        });

        tc.Run("native refusals: a full table's overflow is on vu1_replay's total lines", [](TestCase &t)
        {
            Vu1Refusals::Table table;
            for (uint32_t entry = 0; entry <= Vu1Refusals::kSlots; ++entry)   // kSlots + 1 distinct keys
                table.note(entry * 8u, Vu1Refusals::Reason::NoNativeEntry, 0u);
            t.Equals(table.overflow(), 1ull, "the key past the last slot is not counted, only tallied");
            const std::vector<std::string> lines = Vu1Refusals::formatTotals(table);
            t.Equals(lines.size(), size_t{Vu1Refusals::kSlots + 1u}, "one line per key, then the overflow line");
            t.Equals(lines.back(), std::string("[vu1-refuse-total] overflow=1 (keys past 128 slots not counted)"),
                     "the overflow line, in the form the scorer reads");
            Vu1Refusals::Table empty;
            t.Equals(Vu1Refusals::formatTotals(empty).size(), size_t{0}, "no overflow, no line");
        });

        tc.Run("native refusals: a native program handing back unnamed is charged to unnamed_handback, not a stale key", [](TestCase &t)
        {
            RefusalRig rig;
            t.IsTrue(rig.init(), "rig should initialize");
            Vu1Refusals::setEnabledForTest(true);
            // A refusal noted outside any run leaves a slot behind (the stale key).
            Vu1Refusals::note(0x7770u, Vu1Refusals::Reason::UnknownCommand, 0x99u);
            const Vu1Refusals::Row staleBefore = RefusalRig::row(0x7770u, Vu1Refusals::Reason::UnknownCommand, 0x99u);
            const Vu1Refusals::Row before = RefusalRig::row(0u, Vu1Refusals::Reason::UnnamedHandBack, 0u);
            rig.run(0u, +[](VU1Interpreter &, uint64_t) { return false; });   // hands back at pc 0, names nothing
            const Vu1Refusals::Row staleAfter = RefusalRig::row(0x7770u, Vu1Refusals::Reason::UnknownCommand, 0x99u);
            const Vu1Refusals::Row after = RefusalRig::row(0u, Vu1Refusals::Reason::UnnamedHandBack, 0u);
            Vu1Refusals::setEnabledForTest(false);
            Vu1Refusals::takeNoted();
            t.Equals(after.n - before.n, 1ull, "unnamed_handback at entry 0x0 +1");
            t.IsTrue(after.cycles > before.cycles, "the fallback's cycles go to unnamed_handback");
            t.IsTrue(staleAfter.n == staleBefore.n && staleAfter.cycles == staleBefore.cycles,
                     "the stale key is neither counted again nor charged");
        });

        tc.Run("native refusals: knob on, a pending D-bit enable counts state_guard", [](TestCase &t)
        {
            RefusalRig rig;
            t.IsTrue(rig.init(), "rig should initialize");
            rig.command(0u, 0x68u);   // a list native would take: only the state keeps it out
            rig.command(1u, 0x42u);
            rig.header(2u, 2u, 2);
            Vu1Refusals::setEnabledForTest(true);
            const Vu1Refusals::Row before = RefusalRig::row(0u, Vu1Refusals::Reason::StateGuard, 0u);
            const uint64_t total = Vu1Refusals::live().totalCount();
            rig.run(0u, &RefusalRig::dispatcher, true);
            const Vu1Refusals::Row after = RefusalRig::row(0u, Vu1Refusals::Reason::StateGuard, 0u);
            Vu1Refusals::setEnabledForTest(false);
            t.Equals(after.n - before.n, 1ull, "state_guard at entry 0x0 +1");
            t.Equals(Vu1Refusals::live().totalCount() - total, 1ull, "and nothing else");
            t.IsTrue(after.cycles > before.cycles, "the microcode's cycles are charged to it");
        });

        tc.Run("native refusals: a program split by its cycle budget is one refusal charged with every slice", [](TestCase &t)
        {
            RefusalRig rig;
            t.IsTrue(rig.init(), "rig should initialize");
            // 64 NOP pairs, the E bit on the 64th: longer than the first slice's 16-cycle budget.
            const uint32_t lowerNop = 0x8000033Cu, upperNop = 0x000002FFu, eBit = 1u << 30;
            for (uint32_t k = 0; k < 64u; ++k)
                rig.pair(k * 8u, lowerNop, k == 63u ? (upperNop | eBit) : upperNop);
            rig.pair(64u * 8u, lowerNop, upperNop);
            rig.command(0u, 0x52u);
            rig.command(1u, 0x42u);
            Vu1Refusals::setEnabledForTest(true);
            const Vu1Refusals::Row before = RefusalRig::row(0u, Vu1Refusals::Reason::UnknownCommand, 0x52u);
            const uint64_t total = Vu1Refusals::live().totalCount();
            const Vu1NativeProgram table[] = {{rig.hash(), 0u, &RefusalRig::dispatcher}};
            VU1Interpreter vu;
            vu.setNativeProgramsOverride(table, 1u);
            const uint64_t start = vu.state().cycles;
            vu.execute(rig.code, PS2_VU1_CODE_SIZE, rig.data, PS2_VU1_DATA_SIZE, rig.gs, &rig.mem, 0u, 0u, 0u, 16u);
            const bool pendingAfterFirst = vu.programPending();
            const uint64_t firstSlice = vu.state().cycles - start;
            vu.resume(rig.code, PS2_VU1_CODE_SIZE, rig.data, PS2_VU1_DATA_SIZE, rig.gs, &rig.mem, 0u, 0u, 4096u);
            vu.setNativeProgramsOverride(nullptr, 0u);
            const uint64_t allSlices = vu.state().cycles - start;
            const Vu1Refusals::Row after = RefusalRig::row(0u, Vu1Refusals::Reason::UnknownCommand, 0x52u);
            Vu1Refusals::setEnabledForTest(false);
            t.IsTrue(pendingAfterFirst, "the first slice stops on its budget, the program pending");
            t.IsTrue(!vu.programPending(), "the second slice ends it");
            t.IsTrue(allSlices > firstSlice, "the second slice ran cycles of its own");
            t.Equals(after.n - before.n, 1ull, "one refusal, counted at the program's start");
            t.Equals(Vu1Refusals::live().totalCount() - total, 1ull, "the continuation is not a second refusal");
            t.Equals(after.cycles - before.cycles, allSlices, "every slice's cycles are charged to it");
        });

        tc.Run("native refusals: knob on, a handler's ceiling clamp counts handler_clamp with its command", [](TestCase &t)
        {
            // The handler-side vertex ceiling lowered to 4 through the rig (what PS2X_VU1_NATIVE_TEST_CEILING=4 does):
            // the pre-scan keeps 256, so a 5-vertex header passes it and the 0x68 handler's clamp hands back.
            const int32_t ceiling = 4;
            RefusalRig rig;
            RefusalRig::forceVertexCeiling(ceiling);
            t.IsTrue(rig.init(), "rig should initialize");
            const uint32_t lowerNop = 0x8000033Cu, upperNop = 0x000002FFu, eBit = 1u << 30;
            rig.pair(0x1b60u, lowerNop, upperNop | eBit);   // where the microcode resumes the clamped command
            rig.pair(0x1b68u, lowerNop, upperNop);
            rig.command(0u, 0x68u);                          // `68 42`, past the pre-scan (vertices <= 256)
            rig.command(1u, 0x42u);
            rig.header(2u, 2u, ceiling + 1);                 // ... and over the lowered handler ceiling
            Vu1Refusals::setEnabledForTest(true);
            const Vu1Refusals::Row before = RefusalRig::row(0u, Vu1Refusals::Reason::HandlerClamp, 0x68u);
            const uint64_t total = Vu1Refusals::live().totalCount();
            rig.run(0u);
            const Vu1Refusals::Row after = RefusalRig::row(0u, Vu1Refusals::Reason::HandlerClamp, 0x68u);
            Vu1Refusals::setEnabledForTest(false);
            t.Equals(after.n - before.n, 1ull, "handler_clamp cmd=0x68 at entry 0x0 +1");
            t.Equals(Vu1Refusals::live().totalCount() - total, 1ull, "and nothing else");
            t.IsTrue(after.cycles > before.cycles, "the microcode that resumed at 0x1b60 is charged to it");
        });

        // ---- Sprint 17 F (docs/research/83 section 3): run()'s head, paid by every VU1 program ------------------
        // b1: the foreign-disc warning's clock is read only when the image's hash has no native entry at all (a
        // matched hash makes shouldWarn throw the window away without looking at the time). b2: the native lookup's
        // answers -- the program at (hash, pc), whether the hash has one anywhere -- are kept per image generation
        // and table override, so a run does one probe: the same program taken and the same refusals noted as the
        // scan, the registry's gate asked once per (generation, pc). The split: no_native_entry at entry 0 keyed by
        // the entry-0 program's path. Every case drives VU1Interpreter::execute over RefusalRig's NOP image.
        struct HeadRig
        {
            static int &calls(int which)   // 0..2: fnA..fnC entered; 3: the closed gate asked
            {
                static int s_calls[4] = {};
                return s_calls[which];
            }
            static void resetCalls()
            {
                for (int i = 0; i < 4; ++i)
                    calls(i) = 0;
            }
            static bool fnA(VU1Interpreter &, uint64_t) { ++calls(0); return true; }
            static bool fnB(VU1Interpreter &, uint64_t) { ++calls(1); return true; }
            static bool fnC(VU1Interpreter &, uint64_t) { ++calls(2); return true; }
            static bool gateClosed() { ++calls(3); return false; }
            static uint64_t &fakeNs()
            {
                static uint64_t s_ns = 0u;
                return s_ns;
            }
            static uint64_t fakeClock() { return fakeNs(); }
            // The scan run() did on every run before b2, uncached: the last row with (hash, pc), a fn and an open
            // gate (the oracle; it asks no gate, so it does not move calls(3)).
            static VU1Interpreter::KnownProgramFn scan(const Vu1NativeProgram *t, uint32_t n, uint64_t h, uint32_t pc,
                                                       bool gateOpen)
            {
                VU1Interpreter::KnownProgramFn fn = nullptr;
                for (uint32_t i = 0; i < n; ++i)
                    if (t[i].hash == h && t[i].entryPc == pc && t[i].fn && (!t[i].enabled || gateOpen))
                        fn = t[i].fn;
                return fn;
            }
            static int which(VU1Interpreter::KnownProgramFn fn)
            {
                return fn == &fnA ? 0 : fn == &fnB ? 1 : fn == &fnC ? 2 : -1;
            }
            static void execute(VU1Interpreter &vu, RefusalRig &rig, uint32_t pc, uint32_t top = 0u)
            {
                vu.execute(rig.code, PS2_VU1_CODE_SIZE, rig.data, PS2_VU1_DATA_SIZE, rig.gs, &rig.mem, pc, top, 0u, 4096u);
            }
            // NOP+E programs at 0x20 and 0x40 besides the rig's at 0 and 8.
            static void morePrograms(RefusalRig &rig)
            {
                const uint32_t lowerNop = 0x8000033Cu, upperNop = 0x000002FFu, eBit = 1u << 30;
                rig.pair(0x20u, lowerNop, upperNop | eBit);
                rig.pair(0x28u, lowerNop, upperNop);
                rig.pair(0x40u, lowerNop, upperNop | eBit);
                rig.pair(0x48u, lowerNop, upperNop);
            }
        };

        tc.Run("run() head b1: a matched image reads no clock for the foreign-disc warning; an unmatched one reads one a run",
               [](TestCase &t)
        {
            RefusalRig rig;
            t.IsTrue(rig.init(), "rig should initialize");
            const uint64_t h = rig.hash();
            // The supported disc: the hash has a native entry (at 8), none at the entry run (0) -- research/83's
            // entry-0 swarm. Another disc: no entry carries its hash.
            const Vu1NativeProgram matched[] = {{h, 8u, &HeadRig::fnB}};
            const Vu1NativeProgram foreign[] = {{h ^ 1u, 8u, &HeadRig::fnB}};
            Vu1NativeWarning::live() = Vu1NativeWarning::State{};
            Vu1NativeWarning::clockForTest() = &HeadRig::fakeClock;
            const uint64_t printedBefore = Vu1NativeWarning::printedCount();
            VU1Interpreter vu;
            vu.setNativeProgramsOverride(matched, 1u);
            uint64_t reads = Vu1NativeWarning::clockReads().load();
            for (int i = 0; i < 5; ++i)
                HeadRig::execute(vu, rig, 0u);
            t.Equals(Vu1NativeWarning::clockReads().load() - reads, 0ull, "five matched runs read no clock (one each before b1)");
            t.Equals(Vu1NativeWarning::printedCount() - printedBefore, 0ull, "and the supported disc never warns");

            // The cadence, unchanged: armed on the first miss, quiet at half a second, out once past a full second.
            vu.setNativeProgramsOverride(foreign, 1u);
            reads = Vu1NativeWarning::clockReads().load();
            HeadRig::fakeNs() = 0u;
            HeadRig::execute(vu, rig, 0u);
            HeadRig::fakeNs() = 500000000u;
            HeadRig::execute(vu, rig, 0u);
            t.Equals(Vu1NativeWarning::printedCount() - printedBefore, 0ull, "half a second of misses: quiet");
            HeadRig::fakeNs() = 1000000001u;
            HeadRig::execute(vu, rig, 0u);
            t.Equals(Vu1NativeWarning::printedCount() - printedBefore, 1ull, "past a second of misses: one line");
            t.Equals(Vu1NativeWarning::lastPrinted(),
                     std::string("[vu1] no native program for code hash 0x") + [&] {
                         char hex[17];
                         std::snprintf(hex, sizeof(hex), "%016llx", static_cast<unsigned long long>(h));
                         return std::string(hex);
                     }() + " entry 0x0000 -- running the interpreter (supported disc: SOCOM II NTSC r0001, SCUS_972.75)",
                     "the line's text, unchanged");
            HeadRig::fakeNs() = 5000000000u;
            HeadRig::execute(vu, rig, 0u);
            t.Equals(Vu1NativeWarning::printedCount() - printedBefore, 1ull, "never a second line");
            t.Equals(Vu1NativeWarning::clockReads().load() - reads, 4ull, "four unmatched runs, one clock read each");

            // A match between misses still throws the window away, though it reads no clock.
            Vu1NativeWarning::live() = Vu1NativeWarning::State{};
            HeadRig::fakeNs() = 10000000000u;
            HeadRig::execute(vu, rig, 0u);                 // arms at 10 s
            vu.setNativeProgramsOverride(matched, 1u);
            reads = Vu1NativeWarning::clockReads().load();
            HeadRig::execute(vu, rig, 0u);                 // a match: the window is gone
            t.Equals(Vu1NativeWarning::clockReads().load() - reads, 0ull, "the match reads no clock");
            vu.setNativeProgramsOverride(foreign, 1u);
            HeadRig::fakeNs() = 11500000000u;
            HeadRig::execute(vu, rig, 0u);                 // a new window opens at 11.5 s
            t.Equals(Vu1NativeWarning::printedCount() - printedBefore, 1ull, "1.5 s after the first miss, but a match between: quiet");
            HeadRig::fakeNs() = 12600000000u;
            HeadRig::execute(vu, rig, 0u);
            t.Equals(Vu1NativeWarning::printedCount() - printedBefore, 2ull, "a full second of the new window: the line");
            vu.setNativeProgramsOverride(nullptr, 0u);
            Vu1NativeWarning::clockForTest() = nullptr;
            Vu1NativeWarning::live() = Vu1NativeWarning::State{};
        });

        tc.Run("run() head b2: the cached lookup takes the scan's program and notes its refusals, the gate asked once",
               [](TestCase &t)
        {
            extern std::atomic<uint64_t> g_vu1NativeEntered;
            RefusalRig rig;
            t.IsTrue(rig.init(), "rig should initialize");
            HeadRig::morePrograms(rig);
            const uint64_t h = rig.hash();
            // Two rows taken (0, 0x20), one behind a closed gate (8, the 0x33c8 row's form); 0x40 has none.
            const Vu1NativeProgram rows[] = {{h, 0u, &HeadRig::fnA}, {h, 0x20u, &HeadRig::fnC}, {h, 8u, &HeadRig::fnB, &HeadRig::gateClosed}};
            const uint32_t pcs[] = {0u, 8u, 0x20u, 0x40u, 0u, 8u, 0u, 8u, 0x40u};
            VU1Interpreter vu;
            vu.setNativeProgramsOverride(rows, 3u);
            Vu1Refusals::setEnabledForTest(true);
            HeadRig::resetCalls();
            int expected[3] = {};
            uint64_t expectedRefused[2] = {};   // pc 8, pc 0x40
            for (uint32_t pc : pcs)
            {
                const int w = HeadRig::which(HeadRig::scan(rows, 3u, h, pc, false));
                if (w >= 0)
                    ++expected[w];
                else
                    ++expectedRefused[pc == 8u ? 0 : 1];
            }
            const Vu1Refusals::Row r8 = RefusalRig::row(8u, Vu1Refusals::Reason::NoNativeEntry, 0u);
            const Vu1Refusals::Row r40 = RefusalRig::row(0x40u, Vu1Refusals::Reason::NoNativeEntry, 0u);
            const uint64_t entered = g_vu1NativeEntered.load();
            const uint64_t total = Vu1Refusals::live().totalCount();
            for (uint32_t pc : pcs)
                HeadRig::execute(vu, rig, pc);
            t.IsTrue(HeadRig::calls(0) == expected[0] && HeadRig::calls(1) == expected[1] && HeadRig::calls(2) == expected[2],
                     "the scan's program each run: fnA x" + std::to_string(HeadRig::calls(0)) + " (scan " +
                         std::to_string(expected[0]) + "), fnB x" + std::to_string(HeadRig::calls(1)) + " (" +
                         std::to_string(expected[1]) + "), fnC x" + std::to_string(HeadRig::calls(2)) + " (" +
                         std::to_string(expected[2]) + ")");
            t.Equals(g_vu1NativeEntered.load() - entered, 4ull, "native-entered counts the four runs taken");
            t.Equals(RefusalRig::row(8u, Vu1Refusals::Reason::NoNativeEntry, 0u).n - r8.n, expectedRefused[0],
                     "the gated row's pc: no_native_entry each run, as the scan");
            t.Equals(RefusalRig::row(0x40u, Vu1Refusals::Reason::NoNativeEntry, 0u).n - r40.n, expectedRefused[1],
                     "a pc with no row: no_native_entry each run");
            t.Equals(Vu1Refusals::live().totalCount() - total, expectedRefused[0] + expectedRefused[1], "and no other refusal");
            t.Equals(HeadRig::calls(3), 1, "the gate is asked once for the image's pc 8, not once a run (3)");

            // A table override is a new generation: the next run scans the new table.
            const Vu1NativeProgram bumped[] = {{h, 8u, &HeadRig::fnB}};
            vu.setNativeProgramsOverride(bumped, 1u);
            const uint32_t none = static_cast<uint32_t>(Vu1Refusals::Entry0Path::None);
            const Vu1Refusals::Row r0 = RefusalRig::row(0u, Vu1Refusals::Reason::NoNativeEntry, none);
            HeadRig::execute(vu, rig, 8u);
            HeadRig::execute(vu, rig, 0u);
            t.Equals(HeadRig::calls(1), 1, "after the override, pc 8 takes the new table's fnB");
            t.Equals(HeadRig::calls(0), expected[0], "and pc 0 no longer takes fnA");
            t.Equals(RefusalRig::row(0u, Vu1Refusals::Reason::NoNativeEntry, none).n - r0.n, 1ull,
                     "pc 0 is no_native_entry against the new table");

            // New microcode (the VIF's MPG): the hash moves, the table no longer matches, nothing is taken or noted.
            const uint32_t lowerNop = 0x8000033Cu, upperNop = 0x000002FFu;
            rig.pair(0x80u, lowerNop, upperNop);
            const uint64_t afterImage = Vu1Refusals::live().totalCount();
            HeadRig::execute(vu, rig, 8u);
            t.Equals(HeadRig::calls(1), 1, "a new image: fnB is not taken");
            t.Equals(Vu1Refusals::live().totalCount() - afterImage, 0ull, "and nothing is noted (the hash has no entry)");
            vu.setNativeProgramsOverride(nullptr, 0u);
            Vu1Refusals::setEnabledForTest(false);
            Vu1Refusals::takeNoted();   // leave no slot for the next case
            Vu1NativeWarning::live() = Vu1NativeWarning::State{};
        });

        // The real entry-0 headers: the qword at TOP of five mission programs (logs/vu1dump5, the n1b capture of
        // research/82 section 8.4), one per path vu1_entry0_shapes' trace names. The split reads only this qword,
        // so the rest of each dump is not carried. Each is the x, y, z, w words.
        struct Entry0Header
        {
            const char *dump;
            uint32_t top;
            uint32_t words[4];
            Vu1Refusals::Entry0Path path;
            const char *name;
        };
        static const Entry0Header kEntry0Headers[] = {
            {"vu1_prog_1", 724u, {0u, 0u, 0u, 2u}, Vu1Refusals::Entry0Path::Kick, "kick"},
            {"vu1_prog_0", 424u, {0u, 0u, 8u, 0u}, Vu1Refusals::Entry0Path::List, "list"},
            {"vu1_prog_9", 724u, {0u, 0u, 0u, 1u}, Vu1Refusals::Entry0Path::Matrix, "matrix"},
            {"vu1_prog_10", 424u, {0u, 0u, 0u, 8u}, Vu1Refusals::Entry0Path::Fade, "fade"},
            {"vu1_prog_413", 724u, {0u, 0u, 5u, 8u}, Vu1Refusals::Entry0Path::FadeList, "fade+list"},
        };

        for (const Entry0Header &hdr : kEntry0Headers)
        {
            tc.Run(std::string("native refusals: entry 0's no_native_entry is split by path, vu1dump5/") + hdr.dump +
                       " counts cmd=" + hdr.name,
                   [&hdr](TestCase &t)
            {
                RefusalRig rig;
                t.IsTrue(rig.init(), "rig should initialize");
                std::memcpy(rig.data + hdr.top * 16u, hdr.words, sizeof(hdr.words));
                const Vu1NativeProgram table[] = {{rig.hash(), 0x1b50u, &RefusalRig::dispatcher}};
                const uint32_t code = static_cast<uint32_t>(hdr.path);
                Vu1Refusals::setEnabledForTest(true);
                const Vu1Refusals::Row before = RefusalRig::row(0u, Vu1Refusals::Reason::NoNativeEntry, code);
                const uint64_t total = Vu1Refusals::live().totalCount();
                VU1Interpreter vu;
                vu.setNativeProgramsOverride(table, 1u);
                HeadRig::execute(vu, rig, 0u, hdr.top);
                vu.setNativeProgramsOverride(nullptr, 0u);
                const Vu1Refusals::Row after = RefusalRig::row(0u, Vu1Refusals::Reason::NoNativeEntry, code);
                Vu1Refusals::setEnabledForTest(false);
                Vu1Refusals::takeNoted();   // leave no slot for the next case
                t.Equals(after.n - before.n, 1ull, std::string("no_native_entry at entry 0x0, path ") + hdr.name + " +1");
                t.Equals(Vu1Refusals::live().totalCount() - total, 1ull, "and under no other key");
                t.IsTrue(after.cycles > before.cycles, "the program's cycles are charged to its path");
                const std::string line = Vu1Refusals::formatRow("[vu1-refuse]", after, 1000.0);
                t.IsTrue(line.find(std::string(" reason=no_native_entry cmd=") + hdr.name + " n=") != std::string::npos,
                         "the line names the path: " + line);
            });
        }

        tc.Run("native refusals: the entry-0 path rule -- the microcode's order, ILW's 16 bits; other entries stay cmd=-",
               [](TestCase &t)
        {
            using P = Vu1Refusals::Entry0Path;
            t.IsTrue(Vu1Refusals::entry0Path(0u, 3u) == P::Kick, "w bit 1 is kick, whatever else is set");
            t.IsTrue(Vu1Refusals::entry0Path(7u, 0xBu) == P::Kick, "kick takes no list and no fade");
            t.IsTrue(Vu1Refusals::entry0Path(7u, 9u) == P::Matrix, "w bit 0 (bit 1 clear) is matrix, its z unread");
            t.IsTrue(Vu1Refusals::entry0Path(0u, 8u) == P::Fade, "w bit 3 alone is fade");
            t.IsTrue(Vu1Refusals::entry0Path(5u, 8u) == P::FadeList, "fade falls into the list test: fade+list");
            t.IsTrue(Vu1Refusals::entry0Path(0xFFFFu, 0u) == P::List, "a negative 16-bit z is non-zero: list");
            t.IsTrue(Vu1Refusals::entry0Path(0x10000u, 0x20000u) == P::None, "bits above ILW's 16 are not read: none");
            t.Equals(std::string(Vu1Refusals::pathName(P::FadeList)), std::string("fade+list"), "the printed name");
            uint8_t data[64] = {};
            t.IsTrue(Vu1Refusals::entry0Path(data, 64u, 4u) == P::Unsplit, "TOP past the data memory: unsplit");

            // Entered at 8 (not 0) with a kick header at TOP: no_native_entry, but its key is not split.
            RefusalRig rig;
            t.IsTrue(rig.init(), "rig should initialize");
            rig.header(0u, 3u, 2);
            Vu1Refusals::setEnabledForTest(true);
            const Vu1Refusals::Row before = RefusalRig::row(8u, Vu1Refusals::Reason::NoNativeEntry, 0u);
            const Vu1NativeProgram table[] = {{rig.hash(), 0x1b50u, &RefusalRig::dispatcher}};
            VU1Interpreter vu;
            vu.setNativeProgramsOverride(table, 1u);
            HeadRig::execute(vu, rig, 8u);
            vu.setNativeProgramsOverride(nullptr, 0u);
            const Vu1Refusals::Row after = RefusalRig::row(8u, Vu1Refusals::Reason::NoNativeEntry, 0u);
            Vu1Refusals::setEnabledForTest(false);
            Vu1Refusals::takeNoted();   // leave no slot for the next case
            t.Equals(after.n - before.n, 1ull, "no_native_entry at entry 0x8 +1, unsplit");
            t.IsTrue(Vu1Refusals::formatRow("[vu1-refuse]", after, 1000.0).find(" cmd=- ") != std::string::npos,
                     "its line keeps cmd=-");
            Vu1Refusals::Table table2;
            const int slot = table2.note(0u, Vu1Refusals::Reason::NoNativeEntry, static_cast<uint32_t>(P::Kick));
            table2.note(0u, Vu1Refusals::Reason::NoNativeEntry, static_cast<uint32_t>(P::Matrix));
            table2.addCost(slot, 37u, 650u);
            const std::vector<Vu1Refusals::Row> rows = table2.totals();
            t.Equals(rows.size(), size_t{2}, "kick and matrix are two keys");
            bool kickLine = false;
            for (const Vu1Refusals::Row &r : rows)
                kickLine |= Vu1Refusals::formatRow("[vu1-refuse-total]", r, -1.0) ==
                            "[vu1-refuse-total] entry=0x0 reason=no_native_entry cmd=kick n=1 cycles=37 host_us=0";
            t.IsTrue(kickLine, "vu1_replay's total line for the kick path");
        });

        // ---- Sprint 17 F N1 (docs/research/82): the native program at entry 0x33c8 ------------------------------
        // The EE MSCALs 0x33c8 after every 0x52 bone pass. With the previous chunk's flags (vi5, live-in) marking the
        // last bone, the microcode repacks the skinned staging array into the vertex block and resumes the dispatcher
        // at 0x1b60 with the live-in vi14 -- `66 08 40 42` of the original `52 66 08 40 42` list; otherwise it branches
        // to 0x3100 for another bone pass, which native refuses as skin_pass. The oracle is the interpreter over the
        // REAL microcode image: the fixture dump tests/fixtures/vu1/dispatch_0x1b50/vu1dump3_prog_31.bin (code, data
        // and registers of a `70 06 08 40 42` list, TOP 424, 42 vertices, 38 triangles), with a last-bone state
        // written over it: the list, vi5/vi9/vi14, and a staging array of skinned positions and normals.
        // Packets are compared only under the immediate XGKICK model: ps2x_tests' main latches the cycle-exact one,
        // and the interpreter's startXgkick, which the native handlers call, streams a kick per cycle there -- a native
        // run never advances the cycle, so its kicks do not reach the GS in this process. Everything a kick is built
        // from is in VU data memory, which is compared whole, as is the register file (vu1_replay's --regs all).
        struct Entry33c8Rig
        {
            std::vector<uint8_t> code, data;
            int32_t vi[16] = {};
            float vf[32][4] = {};
            uint32_t top = 0u;

            Entry33c8Rig() { RefusalRig::forceXgkickImmediate(1); }
            ~Entry33c8Rig() { RefusalRig::forceXgkickImmediate(-1); }
            Entry33c8Rig(const Entry33c8Rig &) = delete;
            Entry33c8Rig &operator=(const Entry33c8Rig &) = delete;

            bool load()
            {
                return loadFrom(std::string(PS2X_TEST_FIXTURES_DIR) +
                                "/../../../../tests/fixtures/vu1/dispatch_0x1b50/vu1dump3_prog_31.bin");
            }
            // Any PS2X_VU1_DUMP-format file (vu1_replay's loadDump layout): the fixture, or a dump this suite wrote.
            bool loadFrom(const std::string &path)
            {
                FILE *f = std::fopen(path.c_str(), "rb");
                if (!f)
                    return false;
                std::vector<uint8_t> blob(16u + PS2_VU1_CODE_SIZE + PS2_VU1_DATA_SIZE + sizeof(vi) + sizeof(vf));
                const size_t got = std::fread(blob.data(), 1, blob.size(), f);
                std::fclose(f);
                if (got != blob.size())
                    return false;
                uint32_t hdr[4];
                std::memcpy(hdr, blob.data(), sizeof(hdr));
                top = hdr[1] & 0x3FFu;
                code.assign(blob.begin() + 16, blob.begin() + 16 + PS2_VU1_CODE_SIZE);
                data.assign(blob.begin() + 16 + PS2_VU1_CODE_SIZE, blob.begin() + 16 + PS2_VU1_CODE_SIZE + PS2_VU1_DATA_SIZE);
                std::memcpy(vi, blob.data() + 16 + PS2_VU1_CODE_SIZE + PS2_VU1_DATA_SIZE, sizeof(vi));
                std::memcpy(vf, blob.data() + 16 + PS2_VU1_CODE_SIZE + PS2_VU1_DATA_SIZE + sizeof(vi), sizeof(vf));
                return true;
            }
            // A real refused capture (vu1_33c8_real_dumps.inc): its TOP, register file and the qwords its program
            // reads, written over the fixture image.
            bool loadReal(const RealDump &d)
            {
                if (!load())
                    return false;
                top = d.top;
                std::memcpy(vi, d.vi, sizeof(vi));
                std::memcpy(vf, d.vf, sizeof(vf));
                for (size_t s = 0; s < d.spanCount; ++s)
                {
                    const std::string hex = d.spans[s].hex;
                    for (size_t w = 0; w + 8u <= hex.size(); w += 8u)
                        setWord(d.spans[s].first + static_cast<uint32_t>(w / 32u), static_cast<uint32_t>((w / 8u) % 4u),
                                static_cast<int32_t>(std::stoul(hex.substr(w, 8u), nullptr, 16)));
                }
                return true;
            }
            // The list the dispatcher resumes: the command words from vi14 through the first 0x42.
            std::vector<uint32_t> resumedList() const
            {
                std::vector<uint32_t> list;
                for (int32_t k = vi[14]; k >= 0 && k < 64; ++k)
                {
                    list.push_back(static_cast<uint32_t>(word(340u + static_cast<uint32_t>(k), 0u)) & 0xFFFFu);
                    if (list.back() == 0x42u)
                        break;
                }
                return list;
            }
            int32_t word(uint32_t qword, uint32_t lane) const
            {
                int32_t v;
                std::memcpy(&v, data.data() + ((qword * 16u) & 0x3FFFu) + lane * 4u, 4u);
                return v;
            }
            void setWord(uint32_t qword, uint32_t lane, int32_t v) { std::memcpy(data.data() + ((qword * 16u) & 0x3FFFu) + lane * 4u, &v, 4u); }
            void setFloat(uint32_t qword, uint32_t lane, float v) { std::memcpy(data.data() + ((qword * 16u) & 0x3FFFu) + lane * 4u, &v, 4u); }
            int32_t vertices() const { return static_cast<int16_t>(word(top + 2u, 2u) & 0xFFFF); }

            // The last-bone MSCAL: `52 66 08 40 42` at qword 340, vi14 = 1 (0x52 was dispatched by the 0x1b50
            // program that ended at 0x33c8), vi5 = 5 (the previous chunk's flags: accumulate + last), vi9 = the
            // vertex count the first pass saved, qword 37.x = 40 (the staging base), and the staging array
            // (qwords 40 + 2k, 41 + 2k) holding each vertex's skinned position and normal: here the fixture's own
            // positions as 0x70 would scale them (ITOF15 x TOP+3.w), so the transform draws the fixture's mesh.
            void makeLastBone()
            {
                const uint32_t list[5] = {0x52u, 0x66u, 0x08u, 0x40u, 0x42u};
                for (uint32_t k = 0; k < 5u; ++k)
                    setWord(340u + k, 0u, static_cast<int32_t>(list[k]));
                vi[5] = 5;
                vi[9] = vertices();
                vi[14] = 1;
                setWord(37u, 0u, 40);
                float scale;
                std::memcpy(&scale, data.data() + (top + 3u) * 16u + 12u, 4u);
                for (int32_t k = 0; k < vertices(); ++k)
                {
                    const uint32_t rec = top + 4u + 3u * static_cast<uint32_t>(k);
                    for (uint32_t lane = 0; lane < 3u; ++lane)
                        setFloat(40u + 2u * k, lane, static_cast<float>(word(rec, lane)) / 32768.0f * scale);
                    setFloat(40u + 2u * k, 3u, 1.0f);
                    setFloat(41u + 2u * k, 0u, 0.25f + 0.001f * static_cast<float>(k));
                    setFloat(41u + 2u * k, 1u, -0.5f);
                    setFloat(41u + 2u * k, 2u, 0.75f - 0.002f * static_cast<float>(k));
                    setFloat(41u + 2u * k, 3u, 0.0f);
                }
            }
            // The list at qword 340 as `52 <resumed...>`, vi14 = 1 still naming the first resumed command.
            void setResumedList(const std::vector<uint32_t> &resumed)
            {
                setWord(340u, 0u, 0x52);
                uint32_t k = 1u;
                for (uint32_t command : resumed)
                    setWord(340u + k++, 0u, static_cast<int32_t>(command));
            }
            // Triangles whose index record [0].w has bit 0 (0x40's draw gate, 0x06's output) set.
            uint32_t visibleTriangles(const std::vector<uint8_t> &mem) const
            {
                const int32_t base = static_cast<int32_t>(top) + static_cast<int16_t>(word(top + 2u, 0u) & 0xFFFF);
                const int32_t n = static_cast<int16_t>(word(top + 2u, 3u) & 0xFFFF);
                uint32_t visible = 0u;
                for (int32_t k = 0; k < n; ++k)
                {
                    int32_t w;
                    std::memcpy(&w, mem.data() + (((base + 2 * k) * 16) & 0x3FFF) + 12, 4u);
                    visible += (w & 1) != 0 ? 1u : 0u;
                }
                return visible;
            }

            struct End
            {
                VU1State s{};
                std::vector<uint8_t> data;
                std::vector<uint8_t> packets;
                bool nativeRan = false;
                bool nativeEnded = false;
                // A hand-back only: what the native program changed before it returned, against a snapshot of
                // the register file and VU data memory taken as it was entered ("" = nothing; a whole-program
                // refusal must leave it empty -- pc included, which stays 0x33c8).
                std::string touchedBeforeHandBack;
            };
            static End &current()
            {
                static End s_end;
                return s_end;
            }
            static uint8_t *&activeData()
            {
                static uint8_t *s_data = nullptr;
                return s_data;
            }
            static bool entry(VU1Interpreter &vu, uint64_t budgetEnd)
            {
                bool vu1native_socom2_entry_0x33c8(VU1Interpreter &vu, uint64_t budgetEnd);
                End before;
                before.s = vu.state();
                before.data.assign(activeData(), activeData() + PS2_VU1_DATA_SIZE);
                current().nativeRan = true;
                current().nativeEnded = vu1native_socom2_entry_0x33c8(vu, budgetEnd);
                if (!current().nativeEnded)
                {
                    End after;
                    after.s = vu.state();
                    after.data.assign(activeData(), activeData() + PS2_VU1_DATA_SIZE);
                    current().touchedBeforeHandBack = diff(before, after, false);
                }
                return current().nativeEnded;
            }
            static bool dispatcher(VU1Interpreter &vu, uint64_t budgetEnd)
            {
                current().nativeRan = true;
                current().nativeEnded = RefusalRig::dispatcher(vu, budgetEnd);
                return current().nativeEnded;
            }
            // The 0x1b50 dispatcher with entry()'s snapshot: a refusal must leave the entry's state untouched.
            static bool dispatcherChecked(VU1Interpreter &vu, uint64_t budgetEnd)
            {
                End before;
                before.s = vu.state();
                before.data.assign(activeData(), activeData() + PS2_VU1_DATA_SIZE);
                current().nativeRan = true;
                current().nativeEnded = RefusalRig::dispatcher(vu, budgetEnd);
                if (!current().nativeEnded)
                {
                    End after;
                    after.s = vu.state();
                    after.data.assign(activeData(), activeData() + PS2_VU1_DATA_SIZE);
                    current().touchedBeforeHandBack = diff(before, after, false);
                }
                return current().nativeEnded;
            }
            // Runs the program from `startPc` with the native table {hash, nativePc, fn}; fn == nullptr runs the
            // interpreter alone (a table whose one row matches nothing).
            End run(uint32_t startPc, uint32_t nativePc, VU1Interpreter::KnownProgramFn fn, uint32_t budget = 1u << 28) const
            {
                current() = End{};
                PS2Memory mem;
                GS gs;
                End &end = current();
                if (!mem.initialize())
                    return end;
                gs.init(mem.getGSVRAM(), static_cast<uint32_t>(PS2_GS_VRAM_SIZE), &mem.gs());
                uint8_t *vuCode = mem.getVU1Code();
                uint8_t *vuData = mem.getVU1Data();
                std::memcpy(vuCode, code.data(), PS2_VU1_CODE_SIZE);
                mem.markVU1CodeModified();
                std::memcpy(vuData, data.data(), PS2_VU1_DATA_SIZE);
                activeData() = vuData;
                mem.setGifPacketCallback([&end](const uint8_t *p, uint32_t n) {
                    const uint32_t len = n;
                    end.packets.insert(end.packets.end(), reinterpret_cast<const uint8_t *>(&len),
                                       reinterpret_cast<const uint8_t *>(&len) + 4);
                    end.packets.insert(end.packets.end(), p, p + n);
                });
                uint64_t h = 1469598103934665603ull;
                for (uint32_t i = 0; i < PS2_VU1_CODE_SIZE; ++i)
                {
                    h ^= code[i];
                    h *= 1099511628211ull;
                }
                const Vu1NativeProgram table[] = {{fn ? h : 0u, nativePc, fn ? fn : &entry}};
                VU1Interpreter vu;
                vu.reset();
                std::memcpy(vu.state().vi, vi, sizeof(vi));
                std::memcpy(vu.state().vf, vf, sizeof(vf));
                vu.setNativeProgramsOverride(table, 1u);
                vu.execute(vuCode, PS2_VU1_CODE_SIZE, vuData, PS2_VU1_DATA_SIZE, gs, &mem, startPc, top, 0u, budget);
                vu.setNativeProgramsOverride(nullptr, 0u);
                mem.setGifPacketCallback(nullptr);
                end.s = vu.state();
                end.data.assign(vuData, vuData + PS2_VU1_DATA_SIZE);
                return end;
            }

            // Every field vu1_replay's --regs all compares, plus VU data memory whole; "" when identical.
            static std::string diff(const End &a, const End &b, bool packets)
            {
                std::string why;
                auto bits = [](float f) { uint32_t w; std::memcpy(&w, &f, 4); return w; };
                if (a.s.pc != b.s.pc) why += " pc";
                if (a.s.mac != b.s.mac) why += " mac";
                if (a.s.status != b.s.status) why += " status";
                if (a.s.clip != b.s.clip) why += " clip";
                if (a.s.r != b.s.r) why += " r";
                if (bits(a.s.q) != bits(b.s.q)) why += " q";
                if (bits(a.s.p) != bits(b.s.p)) why += " p";
                if (bits(a.s.i) != bits(b.s.i)) why += " i";
                for (int r = 0; r < 16; ++r)
                    if ((a.s.vi[r] & 0xFFFF) != (b.s.vi[r] & 0xFFFF))
                        why += " vi" + std::to_string(r) + "(" + std::to_string(a.s.vi[r]) + "/" + std::to_string(b.s.vi[r]) + ")";
                for (int c = 0; c < 4; ++c)
                    if (bits(a.s.acc[c]) != bits(b.s.acc[c]))
                        why += " acc" + std::to_string(c);
                for (int r = 0; r < 32; ++r)
                    for (int c = 0; c < 4; ++c)
                        if (bits(a.s.vf[r][c]) != bits(b.s.vf[r][c]))
                            why += " vf" + std::to_string(r) + "." + "xyzw"[c];
                if (a.data.size() != b.data.size())
                    why += " data size";
                else
                    for (size_t q = 0; q + 16u <= a.data.size(); q += 16u)
                        if (std::memcmp(a.data.data() + q, b.data.data() + q, 16u) != 0)
                        {
                            why += " data q" + std::to_string(q / 16u);
                            if (why.size() > 400u)
                                break;
                        }
                if (packets && a.packets != b.packets)
                    why += " packets(" + std::to_string(a.packets.size()) + "/" + std::to_string(b.packets.size()) + " bytes)";
                return why;
            }
            static bool packetsComparable() { return !ps2x::knobOn("PS2X_VU1_XGKICK_CYCLE_EXACT"); }
            // The XGKICKs a run's GIF callback saw (each record is a u32 length, then that many bytes).
            static size_t kicks(const std::vector<uint8_t> &packets)
            {
                size_t n = 0u;
                for (size_t o = 0u; o + 4u <= packets.size(); ++n)
                {
                    uint32_t len = 0u;
                    std::memcpy(&len, packets.data() + o, 4u);
                    o += 4u + len;
                }
                return n;
            }
        };

        tc.Run("PS2X_VU1_NATIVE_33C8 is a Dev Flag defaulting to 1 (N1c adopted): unset, the registry's 0x33c8 entry is present; 0, absent", [](TestCase &t)
        {
            const ps2x::knobs::Entry *e = ps2x::knobs::find("PS2X_VU1_NATIVE_33C8");
            t.IsTrue(e != nullptr && e->cls == ps2x::knobs::Class::Dev && e->kind == ps2x::knobs::Kind::Flag &&
                         std::string(e->dflt) == "1",
                     "a Dev Flag, default 1 (N1c picked 2026-10-01, the native entry adopted; 0 = the generated code)");
            t.IsTrue(e != nullptr && std::string(e->meaning).size() <= 110u, "its meaning fits the registry's 110 characters");
            extern const Vu1NativeProgram g_vu1NativePrograms[];
            extern const uint32_t g_vu1NativeProgramCount;
            const Vu1NativeProgram *row = nullptr;
            for (uint32_t i = 0; i < g_vu1NativeProgramCount; ++i)
                if (g_vu1NativePrograms[i].hash == 0xd418194495c25213ull && g_vu1NativePrograms[i].entryPc == 0x33c8u)
                    row = &g_vu1NativePrograms[i];
            t.IsTrue(row != nullptr && row->fn != nullptr && row->enabled != nullptr,
                     "the SOCOM II image registers entry 0x33c8, gated");
            // The gate reads once per process, so a run covers the environment it was started with:
            // ps2x_tests unset (the default), and PS2X_VU1_NATIVE_33C8=0 (the developer's fallback).
            const char *v = ps2x::knob("PS2X_VU1_NATIVE_33C8");
            if (row && row->enabled && v == nullptr)
                t.IsTrue(row->enabled(), "unset: the gate is open (the registry's default), run() takes the entry");
            if (row && row->enabled && v != nullptr && !ps2x::knobs::flagValue(v, true))
                t.IsTrue(!row->enabled(), "=0: the gate is closed, run() does not take the entry");
        });

        tc.Run("native 0x33c8: a last-bone entry repacks, resumes at vi14 and ends bit-exact with the interpreter", [](TestCase &t)
        {
            Entry33c8Rig rig;
            t.IsTrue(rig.load(), "the fixture tests/fixtures/vu1/dispatch_0x1b50/vu1dump3_prog_31.bin is present");
            if (rig.code.empty())
                return;
            rig.makeLastBone();
            const Entry33c8Rig::End oracle = rig.run(0x33c8u, 0x33c8u, nullptr);
            t.Equals(oracle.s.pc, 0x1b50u, "the oracle took the last-bone path and ended through 0x42 (pc 0x1b50)");
            const Entry33c8Rig::End native = rig.run(0x33c8u, 0x33c8u, &Entry33c8Rig::entry);
            t.IsTrue(native.nativeRan && native.nativeEnded, "the native program ran the whole list and ended it");
            const std::string why = Entry33c8Rig::diff(oracle, native, Entry33c8Rig::packetsComparable());
            t.IsTrue(why.empty(), "native = interpreter, register file and VU data memory:" + why);
            if (Entry33c8Rig::packetsComparable())
                t.IsTrue(!native.packets.empty(), "the list drew (0x40 kicks one packet per triangle)");
        });

        tc.Run("native 0x33c8: a zero triangle count still runs 0x66 once, as the microcode does", [](TestCase &t)
        {
            // 0x66's loop body runs before its IBGTZ: TOP+2.w = 0 computes one face normal and stores it.
            Entry33c8Rig rig;
            t.IsTrue(rig.load(), "fixture present");
            if (rig.code.empty())
                return;
            rig.makeLastBone();
            rig.setWord(rig.top + 2u, 3u, 0);
            const Entry33c8Rig::End oracle = rig.run(0x33c8u, 0x33c8u, nullptr);
            const Entry33c8Rig::End native = rig.run(0x33c8u, 0x33c8u, &Entry33c8Rig::entry);
            t.IsTrue(native.nativeEnded, "taken natively");
            const std::string why = Entry33c8Rig::diff(oracle, native, Entry33c8Rig::packetsComparable());
            t.IsTrue(why.empty(), "native = interpreter:" + why);
        });

        tc.Run("native 0x33c8: a bone-pass entry (vi5 bit 2 clear) is refused whole as skin_pass", [](TestCase &t)
        {
            Entry33c8Rig rig;
            t.IsTrue(rig.load(), "fixture present");
            if (rig.code.empty())
                return;
            rig.makeLastBone();
            rig.vi[5] = 1;                          // the previous chunk accumulated, and was not the last bone
            rig.setWord(rig.top + 4u, 0u, 1);       // this chunk: accumulate, two vertices, destinations 0 and 2
            rig.setWord(rig.top + 4u, 3u, 2);
            rig.setWord(rig.top + 5u, 3u, 0);
            rig.setWord(rig.top + 7u, 3u, 2);
            rig.setWord(rig.top + 9u, 3u, 0);
            Vu1Refusals::setEnabledForTest(true);
            const Vu1Refusals::Row before = RefusalRig::row(0x33c8u, Vu1Refusals::Reason::SkinPass, 0u);
            const uint64_t total = Vu1Refusals::live().totalCount();
            const Entry33c8Rig::End native = rig.run(0x33c8u, 0x33c8u, &Entry33c8Rig::entry);
            const Vu1Refusals::Row after = RefusalRig::row(0x33c8u, Vu1Refusals::Reason::SkinPass, 0u);
            const uint64_t totalAfter = Vu1Refusals::live().totalCount();
            Vu1Refusals::setEnabledForTest(false);
            const Entry33c8Rig::End oracle = rig.run(0x33c8u, 0x33c8u, nullptr);
            t.IsTrue(native.nativeRan && !native.nativeEnded, "native was asked and handed the program back");
            t.IsTrue(native.touchedBeforeHandBack.empty(), "nothing touched before the hand-back:" + native.touchedBeforeHandBack);
            t.Equals(after.n - before.n, 1ull, "skin_pass at entry 0x33c8 +1");
            t.Equals(totalAfter - total, 1ull, "and nothing else");
            t.Equals(oracle.s.pc, 0x33c8u, "the bone pass ends at 0x33c8 again");
            const std::string why = Entry33c8Rig::diff(oracle, native, true);
            t.IsTrue(why.empty(), "the fallback is the microcode's own run:" + why);
        });

        // ---- Sprint 17 F N1b (docs/research/82 "N1b"): the backface cull 0x06 in the resumed list ---------------------
        // The walk's last-bone lists hold 0x06 (1.78 M `resume_command cmd=0x6` refusals with N1 on). Its only stores are
        // the flag words, record [0].w of every triangle; its one flag read, `FMAND vi13, vi5` at 0x1718, reads the
        // MADDz.w four pairs before it in its own loop, whatever ran before 0x1638. Each shape runs natively against the
        // interpreter on the real image, and the cull must have split the triangles (some drawn, some not) so both
        // outcomes of that FMAND are compared.
        {
            struct Shape
            {
                const char *what;
                std::vector<uint32_t> resumed;
                int32_t triangles; // -1: the fixture's 38
            };
            static const Shape shapes[] = {
                {"06 08 40 42 (the cull on the fixture's normals)", {0x06u, 0x08u, 0x40u, 0x42u}, -1},
                {"66 06 08 40 42 (normals rebuilt from the skinned positions, then culled)", {0x66u, 0x06u, 0x08u, 0x40u, 0x42u}, -1},
                {"66 06 08 40 42 with a zero triangle count (0x66 and 0x06 each run their body once)",
                 {0x66u, 0x06u, 0x08u, 0x40u, 0x42u}, 0},
            };
            for (const Shape &shape : shapes)
            {
                tc.Run(std::string("native 0x33c8: a last-bone ") + shape.what + " is taken natively, bit-exact", [&shape](TestCase &t)
                {
                    Entry33c8Rig rig;
                    t.IsTrue(rig.load(), "fixture present");
                    if (rig.code.empty())
                        return;
                    rig.makeLastBone();
                    rig.setResumedList(shape.resumed);
                    if (shape.triangles >= 0)
                        rig.setWord(rig.top + 2u, 3u, shape.triangles);
                    const Entry33c8Rig::End oracle = rig.run(0x33c8u, 0x33c8u, nullptr);
                    t.Equals(oracle.s.pc, 0x1b50u, "the oracle took the last-bone path and ended through 0x42 (pc 0x1b50)");
                    const Entry33c8Rig::End native = rig.run(0x33c8u, 0x33c8u, &Entry33c8Rig::entry);
                    t.IsTrue(native.nativeRan && native.nativeEnded, "the native program ran the whole list and ended it");
                    const std::string why = Entry33c8Rig::diff(oracle, native, Entry33c8Rig::packetsComparable());
                    t.IsTrue(why.empty(), "native = interpreter, register file and VU data memory:" + why);
                    if (shape.triangles < 0)
                    {
                        const uint32_t visible = rig.visibleTriangles(oracle.data);
                        const uint32_t all = static_cast<uint32_t>(static_cast<int16_t>(rig.word(rig.top + 2u, 3u) & 0xFFFF));
                        t.IsTrue(visible > 0u && visible < all,
                                 "the cull split the triangles (" + std::to_string(visible) + " of " + std::to_string(all) +
                                     " drawn): both outcomes of the FMAND at 0x1718 are compared");
                        if (Entry33c8Rig::packetsComparable())
                            t.IsTrue(!native.packets.empty(), "the list drew (0x40 kicks one packet per drawn triangle)");
                    }
                });
            }
        }

        // ---- Sprint 17 F N1c, the linear half (docs/research/82 section 9.6): 0x54 and 0x10 in the resumed list --------
        // 0x54 (0x05d8) broadcasts q327 into slot +1 of the staging triples from q40, three vertices an iteration with the
        // body before its IBGTZ: stores 41 + 3j for j < 3 max(ceil(V/3), 1), proven as [41, 40 + 9 max(ceil(V/3), 1) - 2].
        // 0x10 (0x0f90) writes only the fog lane .w of slot +2, 42 + 3k for k < max(V, 1), proven as [42, 39 + 3 max(V, 1)].
        // V is TOP+2.z. Neither reads a flag, and neither's addresses depend on what another command wrote, so the proof
        // takes them in any order. Each shape runs natively against the interpreter on the real image; where the list
        // leaves it visible, 0x54's last store (past 0x08's triples) must hold q327, and 0x10's fog lanes must differ
        // from the same list run without its 0x10.
        {
            struct Shape
            {
                const char *what;
                std::vector<uint32_t> resumed;
                int32_t vertices; // TOP+2.z; the repack's vi9 stays the fixture's 42
                bool fillVisible; // 0x54's last store lies past 0x08's triples
            };
            static const Shape linearShapes[] = {
                {"66 06 08 10 40 42, V = 41 (odd: 0x10's last pass stores vertex a only)",
                 {0x66u, 0x06u, 0x08u, 0x10u, 0x40u, 0x42u}, 41, false},
                {"66 06 08 10 40 42, V = 42", {0x66u, 0x06u, 0x08u, 0x10u, 0x40u, 0x42u}, 42, false},
                {"54 66 06 08 40 42, V = 40 (0x54 overshoots to vertices 40 and 41)",
                 {0x54u, 0x66u, 0x06u, 0x08u, 0x40u, 0x42u}, 40, true},
                {"54 66 06 08 10 40 42, V = 40", {0x54u, 0x66u, 0x06u, 0x08u, 0x10u, 0x40u, 0x42u}, 40, true},
                {"54 66 06 08 10 40 42, V = 0 (every body runs once)", {0x54u, 0x66u, 0x06u, 0x08u, 0x10u, 0x40u, 0x42u}, 0, true},
                {"54 66 06 08 40 42, V = 96 (0x54's last store q326: the largest V clear of q329)",
                 {0x54u, 0x66u, 0x06u, 0x08u, 0x40u, 0x42u}, 96, false},
                // N1c, the real shapes: shape A on the fixture's mesh, at the edges of 0x18's range.
                {"66 06 08 54 18 28 42, V = 41 (odd: 0x18's last pass lights vertex 41 as well)",
                 {0x66u, 0x06u, 0x08u, 0x54u, 0x18u, 0x28u, 0x42u}, 41, false},
                {"66 06 08 54 18 28 42, V = 96 (0x18's last store q326: the largest V clear of q329)",
                 {0x66u, 0x06u, 0x08u, 0x54u, 0x18u, 0x28u, 0x42u}, 96, false},
            };
            for (const Shape &shape : linearShapes)
            {
                tc.Run(std::string("native 0x33c8: a last-bone ") + shape.what + " is taken natively, bit-exact", [&shape](TestCase &t)
                {
                    Entry33c8Rig rig;
                    t.IsTrue(rig.load(), "fixture present");
                    if (rig.code.empty())
                        return;
                    rig.makeLastBone();
                    rig.setResumedList(shape.resumed);
                    rig.setWord(rig.top + 2u, 2u, shape.vertices);
                    const float fill[4] = {0.5f, 0.25f, 0.125f, 64.0f}; // q327, so 0x54's stores are recognisable
                    for (uint32_t lane = 0; lane < 4u; ++lane)
                        rig.setFloat(327u, lane, fill[lane]);
                    const Entry33c8Rig::End oracle = rig.run(0x33c8u, 0x33c8u, nullptr);
                    t.Equals(oracle.s.pc, 0x1b50u, "the oracle took the last-bone path and ended through 0x42 (pc 0x1b50)");
                    const Entry33c8Rig::End native = rig.run(0x33c8u, 0x33c8u, &Entry33c8Rig::entry);
                    t.IsTrue(native.nativeRan && native.nativeEnded, "the native program ran the whole list and ended it");
                    const std::string why = Entry33c8Rig::diff(oracle, native, Entry33c8Rig::packetsComparable());
                    t.IsTrue(why.empty(), "native = interpreter, register file and VU data memory:" + why);
                    auto qword = [](const std::vector<uint8_t> &mem, int32_t q) { return mem.data() + ((q * 16) & 0x3FFF); };
                    const int32_t passes = shape.vertices > 0 ? shape.vertices : 1;
                    if (shape.fillVisible)
                    {
                        const int32_t last = 40 + 9 * ((passes + 2) / 3) - 2;
                        t.IsTrue(std::memcmp(qword(rig.data, last), qword(rig.data, 327), 16u) != 0 &&
                                     std::memcmp(qword(native.data, last), qword(rig.data, 327), 16u) == 0,
                                 "0x54 filled its last slot, q" + std::to_string(last) + ", with q327");
                    }
                    const bool fades = std::find(shape.resumed.begin(), shape.resumed.end(), 0x10u) != shape.resumed.end();
                    if (fades)
                    {
                        std::vector<uint32_t> without;
                        for (uint32_t command : shape.resumed)
                            if (command != 0x10u)
                                without.push_back(command);
                        rig.setResumedList(without);
                        const Entry33c8Rig::End plain = rig.run(0x33c8u, 0x33c8u, nullptr);
                        int32_t changed = 0;
                        for (int32_t k = 0; k < passes; ++k)
                            changed += std::memcmp(qword(oracle.data, 42 + 3 * k) + 12, qword(plain.data, 42 + 3 * k) + 12, 4u) != 0 ? 1 : 0;
                        t.IsTrue(changed > 0, "0x10 wrote the fog lane: " + std::to_string(changed) + " of " +
                                                  std::to_string(passes) + " differ from the list without it");
                    }
                });
            }
        }

        // ---- Sprint 17 F N1c, the real shapes (docs/research/82 section 9.7): shape A --------------------------------
        // The walk's refused capture (logs/vu1refused1, 2,000 last-bone lists) holds two shapes. Shape A (816) is
        // `66 06 08 54 18 28 42` from index 1: the transform, the template fill, then 0x18's lighting (0x1440, SQ.xyzw
        // at -11(vi4) and -8(vi4): slot +1 of two staging triples a pass from q40, the body before its IBGTZ, so qwords
        // 41 + 3j for j < 2 max(ceil(V/2), 1), proven as [41, 38 + 6 max(ceil(V/2), 1)]) and 0x28's triangle assembly
        // (0x1780, 0x40's body from 0x1790 behind two loads: the tags at 290/300, nine packet qwords after each of
        // q329.x/.y, q329.x/.y rewritten with the same pair, one XGKICK per drawn triangle). Neither reads a flag. Three
        // real captures, their entry state written over the fixture image, run natively against the interpreter.
        {
            struct RealCase
            {
                const char *what;
                const RealDump *dump;
            };
            static const RealCase shapeA[] = {
                {"1 triangle, 3 vertices, TOP 424 (vu1_refused_1078)", &kA1},
                {"5 triangles, 9 vertices, TOP 724 (vu1_refused_1076)", &kA5},
                {"19 triangles, 24 vertices, TOP 724 (vu1_refused_104)", &kA19},
            };
            for (const RealCase &real : shapeA)
            {
                tc.Run(std::string("native 0x33c8: the walk's shape A, 66 06 08 54 18 28 42, ") + real.what +
                           ": taken natively, bit-exact",
                       [&real](TestCase &t)
                {
                    Entry33c8Rig rig;
                    t.IsTrue(rig.loadReal(*real.dump), "fixture present");
                    if (rig.code.empty())
                        return;
                    const std::vector<uint32_t> shape = {0x66u, 0x06u, 0x08u, 0x54u, 0x18u, 0x28u, 0x42u};
                    t.IsTrue(rig.resumedList() == shape, "the capture resumes 66 06 08 54 18 28 42 at vi14 = 1");
                    const Entry33c8Rig::End oracle = rig.run(0x33c8u, 0x33c8u, nullptr);
                    t.Equals(oracle.s.pc, 0x1b50u, "the oracle took the last-bone path and ended through 0x42 (pc 0x1b50)");
                    const Entry33c8Rig::End native = rig.run(0x33c8u, 0x33c8u, &Entry33c8Rig::entry);
                    t.IsTrue(native.nativeRan && native.nativeEnded, "the native program ran the whole list and ended it");
                    const std::string why = Entry33c8Rig::diff(oracle, native, Entry33c8Rig::packetsComparable());
                    t.IsTrue(why.empty(), "native = interpreter, register file, VU data memory and packets:" + why);
                    if (Entry33c8Rig::packetsComparable())
                        t.IsTrue(!native.packets.empty(), "the list drew (0x28 kicks one packet per drawn triangle)");
                });
            }
        }

        // ---- Sprint 17 F N1c, the real shapes: shape L, the 0x02 loop (docs/research/82 section 9.7) -------------------
        // Shape L (1,184 of the capture) is `66 06 02 [0a 56 1a 2a 4c]` from index 1, the world-object loop. Every store
        // of the 0x02 family lands at a fixed address -- q329.z and q112 (0x02), the clipper's buffers (q40-138: its
        // output count is at most 20, kClipperOutputBound), the 150 staging (0x0a, 0x12, 0x56, 0x1a) and q113.. (0x2a)
        // -- so their union, [40, 211] and q329.z, is proven once at the 0x02 and holds for every primitive, q329 lane
        // by lane (0x02 stores .z, the proof reads .x/.y). The loop target, the y after the 0x4c, must lie in the body
        // and be the y a skipped primitive reads (the qword after the 0x02's, and its own). Three real captures and a
        // fourth whose only primitive is culled -- its program ends through 0x20c8's fall-in, nothing dispatched after
        // the 0x02 -- run natively against the interpreter, three XGKICKs per drawn primitive (q423 from 0x0a, q423
        // and q112 from 0x2a).
        {
            struct RealCase
            {
                const char *what;
                const RealDump *dump;
                size_t kicks; // under the immediate model, three per drawn primitive
            };
            static const RealCase shapeL[] = {
                {"1 primitive, drawn, 3 vertices, TOP 424 (vu1_refused_1032)", &kL1, 3u},
                {"7 primitives, 4 culled, 2 clipped away, 1 drawn, 18 vertices, TOP 424 (vu1_refused_1060)", &kL7, 3u},
                {"8 primitives, 1 culled, 7 drawn, 15 vertices, TOP 724 (vu1_refused_174)", &kL8, 21u},
                {"1 primitive, culled: the loop exits through the fall-in (vu1_refused_1064)", &kS1, 0u},
            };
            for (const RealCase &real : shapeL)
            {
                tc.Run(std::string("native 0x33c8: the walk's shape L, 66 06 02 [0a 56 1a 2a 4c], ") + real.what +
                           ": taken natively, bit-exact",
                       [&real](TestCase &t)
                {
                    Entry33c8Rig rig;
                    t.IsTrue(rig.loadReal(*real.dump), "fixture present");
                    if (rig.code.empty())
                        return;
                    const std::vector<uint32_t> shape = {0x66u, 0x06u, 0x02u, 0x0au, 0x56u, 0x1au, 0x2au, 0x4cu, 0x42u};
                    t.IsTrue(rig.resumedList() == shape, "the capture resumes 66 06 02 0a 56 1a 2a 4c 42 at vi14 = 1");
                    const Entry33c8Rig::End oracle = rig.run(0x33c8u, 0x33c8u, nullptr);
                    t.Equals(oracle.s.pc, 0x1b50u, "the oracle ended through 0x4c's E bit (pc 0x1b50)");
                    const Entry33c8Rig::End native = rig.run(0x33c8u, 0x33c8u, &Entry33c8Rig::entry);
                    t.IsTrue(native.nativeRan && native.nativeEnded, "the native program ran the whole loop and ended it");
                    const std::string why = Entry33c8Rig::diff(oracle, native, Entry33c8Rig::packetsComparable());
                    t.IsTrue(why.empty(), "native = interpreter, register file, VU data memory and packets:" + why);
                    if (Entry33c8Rig::packetsComparable())
                        t.Equals(Entry33c8Rig::kicks(native.packets), real.kicks,
                                 "three XGKICKs per drawn primitive, none for a skipped one");
                });
            }

            tc.Run("native 0x33c8: shape L with research/13's fade, 66 06 02 [0a 12 56 1a 2a 4c], is taken natively, bit-exact",
                   [](TestCase &t)
            {
                // vu1_refused_174's list with 0x12 (0x10's fade on the 150 base, the fog lanes of [152, 149 + 3n]) inserted
                // after the 0x0a, every loop word's y still 4: the target, the qword after the 0x02 and the target's own.
                Entry33c8Rig rig;
                t.IsTrue(rig.loadReal(kL8), "fixture present");
                if (rig.code.empty())
                    return;
                const uint32_t body[6] = {0x12u, 0x56u, 0x1au, 0x2au, 0x4cu, 0x42u};
                for (uint32_t k = 0; k < 6u; ++k)
                {
                    rig.setWord(345u + k, 0u, static_cast<int32_t>(body[k]));
                    rig.setWord(345u + k, 1u, 4);
                }
                const Entry33c8Rig::End oracle = rig.run(0x33c8u, 0x33c8u, nullptr);
                t.Equals(oracle.s.pc, 0x1b50u, "the oracle ended through 0x4c's E bit");
                const Entry33c8Rig::End native = rig.run(0x33c8u, 0x33c8u, &Entry33c8Rig::entry);
                t.IsTrue(native.nativeRan && native.nativeEnded, "taken natively");
                const std::string why = Entry33c8Rig::diff(oracle, native, Entry33c8Rig::packetsComparable());
                t.IsTrue(why.empty(), "native = interpreter:" + why);
                rig.setWord(345u, 0u, 0x56); // the same list without the 0x12, for the fog lanes it wrote
                for (uint32_t k = 1; k < 6u; ++k)
                    rig.setWord(345u + k - 1u, 0u, static_cast<int32_t>(body[k]));
                const Entry33c8Rig::End plain = rig.run(0x33c8u, 0x33c8u, nullptr);
                t.IsTrue(std::memcmp(oracle.data.data() + 152u * 16u, plain.data.data() + 152u * 16u, 16u * 60u) != 0,
                         "0x12 changed the 150 staging");
            });

            tc.Run("native 0x33c8: a loop the proof cannot follow is refused before anything is touched", [](TestCase &t)
            {
                // Each case edits vu1_refused_1060's list (index 3 the 0x02, index 8 the 0x4c, y = 4 from index 4 on) or
                // its state; each is refused whole, under its reason, with the register file and VU data memory as the
                // entry found them.
                using R = Vu1Refusals::Reason;
                struct Case
                {
                    const char *what;
                    R reason;
                    uint32_t cmd;
                    void (*setup)(Entry33c8Rig &);
                    int32_t clipCeiling;
                };
                const Case cases[] = {
                    {"mixed y: the qword after the 0x02 carries y = 5, where a culled first primitive would resume",
                     R::LoopShape, 0x4cu, [](Entry33c8Rig &r) { r.setWord(344u, 1u, 5); }, -1},
                    {"the loop target (the y after the 0x4c) is 2, before the 0x02", R::LoopShape, 0x4cu,
                     [](Entry33c8Rig &r) { r.setWord(349u, 1u, 2); }, -1},
                    {"the loop target is 5 and the qword after the 0x02 agrees, but the target's own y is 4",
                     R::LoopShape, 0x4cu, [](Entry33c8Rig &r) { r.setWord(349u, 1u, 5); r.setWord(344u, 1u, 5); }, -1},
                    {"the loop target is 5 and its own y agrees, but the qword after the 0x02 says 4",
                     R::LoopShape, 0x4cu, [](Entry33c8Rig &r) { r.setWord(349u, 1u, 5); r.setWord(345u, 1u, 5); }, -1},
                    {"a 0x06 in the loop body (it rewrites vi12, the primitive counter)", R::LoopShape, 0x06u,
                     [](Entry33c8Rig &r) { r.setWord(345u, 0u, 0x06); }, -1},
                    {"a 0x0a before the 0x02 (its vi10 is the live-in, unbounded)", R::LoopShape, 0x0au,
                     [](Entry33c8Rig &r) { r.setWord(342u, 0u, 0x0a); }, -1},
                    {"no 0x4c: the 0x2a is followed by the 0x42", R::LoopShape, 0x42u,
                     [](Entry33c8Rig &r) { r.setWord(348u, 0u, 0x42); }, -1},
                    {"a second 0x02 in the body", R::LoopShape, 0x02u, [](Entry33c8Rig &r) { r.setWord(345u, 0u, 0x02); }, -1},
                    {"TOP 100 (the header copied to q102): the family's stores [40, 211] would overwrite TOP+2",
                     R::WriteRange, 0x02u,
                     [](Entry33c8Rig &r) {
                         for (uint32_t lane = 0; lane < 4u; ++lane)
                             r.setWord(102u, lane, r.word(r.top + 2u, lane));
                         r.top = 100u;
                     }, -1},
                    {"the test clip ceiling lowered to 8 (PS2X_VU1_NATIVE_TEST_CLIP_CEILING): refused whole, not clamped",
                     R::ClipCeiling, 0u, [](Entry33c8Rig &) {}, 8},
                };
                for (const Case &k : cases)
                {
                    Entry33c8Rig rig;
                    t.IsTrue(rig.loadReal(kL7), "fixture present");
                    if (rig.code.empty())
                        return;
                    k.setup(rig);
                    if (k.clipCeiling >= 0)
                        RefusalRig::forceClipCeiling(k.clipCeiling);
                    Vu1Refusals::setEnabledForTest(true);
                    const Vu1Refusals::Row before = RefusalRig::row(0x33c8u, k.reason, k.cmd);
                    const Entry33c8Rig::End native = rig.run(0x33c8u, 0x33c8u, &Entry33c8Rig::entry, 64u);
                    const Vu1Refusals::Row after = RefusalRig::row(0x33c8u, k.reason, k.cmd);
                    Vu1Refusals::setEnabledForTest(false);
                    RefusalRig::forceClipCeiling(-1);
                    t.IsTrue(native.nativeRan && !native.nativeEnded, std::string(k.what) + ": handed back");
                    t.Equals(after.n - before.n, 1ull, std::string(k.what) + ": counted under its reason");
                    t.IsTrue(native.touchedBeforeHandBack.empty(),
                             std::string(k.what) + ": nothing touched before the hand-back:" + native.touchedBeforeHandBack);
                }
            });
        }

        tc.Run("native 0x1b50 is unchanged: vu1dump4_prog_134's own 68 06 02 0a 12 56 1a 2a 4c 42 runs natively, bit-exact",
               [](TestCase &t)
        {
            Entry33c8Rig rig;
            t.IsTrue(rig.loadFrom(std::string(PS2X_TEST_FIXTURES_DIR) +
                                  "/../../../../tests/fixtures/vu1/dispatch_0x1b50/vu1dump4_prog_134.bin"),
                     "the fixture tests/fixtures/vu1/dispatch_0x1b50/vu1dump4_prog_134.bin is present");
            if (rig.code.empty())
                return;
            const Entry33c8Rig::End oracle = rig.run(0x1b50u, 0x1b50u, nullptr);
            const Entry33c8Rig::End native = rig.run(0x1b50u, 0x1b50u, &Entry33c8Rig::dispatcher);
            t.IsTrue(native.nativeRan && native.nativeEnded, "the 0x1b50 dispatcher took the list whole");
            const std::string why = Entry33c8Rig::diff(oracle, native, Entry33c8Rig::packetsComparable());
            t.IsTrue(why.empty(), "native = interpreter:" + why);
        });

        tc.Run("native 0x1b50 is unchanged: vu1dump4_prog_11's own 68 08 10 54 18 28 42 runs natively, bit-exact", [](TestCase &t)
        {
            Entry33c8Rig rig;
            t.IsTrue(rig.loadFrom(std::string(PS2X_TEST_FIXTURES_DIR) +
                                  "/../../../../tests/fixtures/vu1/dispatch_0x1b50/vu1dump4_prog_11.bin"),
                     "the fixture tests/fixtures/vu1/dispatch_0x1b50/vu1dump4_prog_11.bin is present");
            if (rig.code.empty())
                return;
            const Entry33c8Rig::End oracle = rig.run(0x1b50u, 0x1b50u, nullptr);
            const Entry33c8Rig::End native = rig.run(0x1b50u, 0x1b50u, &Entry33c8Rig::dispatcher);
            t.IsTrue(native.nativeRan && native.nativeEnded, "the 0x1b50 dispatcher took the list whole");
            const std::string why = Entry33c8Rig::diff(oracle, native, Entry33c8Rig::packetsComparable());
            t.IsTrue(why.empty(), "native = interpreter:" + why);
        });

        tc.Run("native 0x1b50 is unchanged: the fixture's own 70 06 08 40 42 runs natively, bit-exact", [](TestCase &t)
        {
            Entry33c8Rig rig;
            t.IsTrue(rig.load(), "fixture present");
            if (rig.code.empty())
                return;
            const Entry33c8Rig::End oracle = rig.run(0x1b50u, 0x1b50u, nullptr);
            const Entry33c8Rig::End native = rig.run(0x1b50u, 0x1b50u, &Entry33c8Rig::dispatcher);
            t.IsTrue(native.nativeRan && native.nativeEnded, "the 0x1b50 dispatcher took the list whole");
            const std::string why = Entry33c8Rig::diff(oracle, native, Entry33c8Rig::packetsComparable());
            t.IsTrue(why.empty(), "native = interpreter:" + why);
        });

        tc.Run("native 0x33c8: a state whose writes it cannot bound is refused before anything is touched", [](TestCase &t)
        {
            // Every write range of the program is proven before the repack's first store: the repack's records, 0x66's
            // index records, 0x08's staging triples and 0x40's packets must not wrap VU memory or land on what the
            // proof itself read (the list's 64 qwords, the header TOP+2, the packet pointers at q329); the resumed
            // list may hold only 0x66, 0x06, 0x08, 0x10, 0x40, 0x54 and its 0x42 (0x06's flag words, record [0] of
            // every triangle, proven like 0x66's record [1]: N1b; 0x54's fill and 0x10's fog lanes, from q41 and q42
            // on TOP+2.z: N1c); and no handler clamp may be able to fire after the repack. Each refusal leaves the
            // register file and VU data memory exactly as the entry found them.
            using R = Vu1Refusals::Reason;
            struct Case
            {
                const char *what;
                R reason;
                uint32_t cmd;
                void (*setup)(Entry33c8Rig &);
                int32_t vertexCeiling;
            };
            const Case cases[] = {
                {"vi9 = 0 (the loop's IBNE would run 65536 times)", R::RepackRange, 0u, [](Entry33c8Rig &r) { r.vi[9] = 0; }, -1},
                {"vi9 = 257 (over the vertex ceiling)", R::RepackRange, 0u, [](Entry33c8Rig &r) { r.vi[9] = 257; }, -1},
                {"TOP 330: the records from qword 334 would overwrite the list at 340", R::RepackRange, 0u, [](Entry33c8Rig &r) { r.top = 330u; }, -1},
                {"TOP 1000: the records would wrap past the end of VU memory", R::RepackRange, 0u, [](Entry33c8Rig &r) { r.top = 1000u; }, -1},
                {"TOP 322, vi9 = 2: the records would overwrite the packet pointers at q329", R::RepackRange, 0u,
                 [](Entry33c8Rig &r) { r.top = 322u; r.vi[9] = 2; }, -1},
                {"vi14 = 64 (past the list's qwords)", R::ResumeIndex, 0u, [](Entry33c8Rig &r) { r.vi[14] = 64; }, -1},
                {"vi14 = -1", R::ResumeIndex, 0u, [](Entry33c8Rig &r) { r.vi[14] = -1; }, -1},
                {"TOP+2.x = -124: 0x66's records from q301 would overwrite the list", R::WriteRange, 0x66u,
                 [](Entry33c8Rig &r) { r.setWord(r.top + 2u, 0u, -124); }, -1},
                {"TOP+2.x = 560: 0x66's records would wrap past the end of VU memory", R::WriteRange, 0x66u,
                 [](Entry33c8Rig &r) { r.setWord(r.top + 2u, 0u, 560); }, -1},
                {"TOP+2.z = 101: 0x08's staging triples from q40 would reach the list", R::WriteRange, 0x08u,
                 [](Entry33c8Rig &r) { r.setWord(r.top + 2u, 2u, 101); }, -1},
                {"q329.x = 335: 0x40's packet would overwrite the list", R::WriteRange, 0x40u,
                 [](Entry33c8Rig &r) { r.setWord(329u, 0u, 335); }, -1},
                {"a 0x64 in the resumed list (no store range derived for it)", R::ResumeCommand, 0x64u,
                 [](Entry33c8Rig &r) { r.setResumedList({0x66u, 0x06u, 0x08u, 0x64u, 0x42u}); }, -1},
                // N1c, the real shapes: shape A's 0x18 and 0x28.
                {"18 66 06 08 40 42, TOP+2.z = 97: 0x18's lit colours [41, 332] would overwrite the packet pointers at q329",
                 R::WriteRange, 0x18u,
                 [](Entry33c8Rig &r) { r.setResumedList({0x18u, 0x66u, 0x06u, 0x08u, 0x40u, 0x42u}); r.setWord(r.top + 2u, 2u, 97); }, -1},
                {"18 66 06 08 40 42, TOP 100 (the header copied to q102): 0x18's lit colours [41, 164] would overwrite TOP+2",
                 R::WriteRange, 0x18u,
                 [](Entry33c8Rig &r) {
                     r.setResumedList({0x18u, 0x66u, 0x06u, 0x08u, 0x40u, 0x42u});
                     for (uint32_t lane = 0; lane < 4u; ++lane)
                         r.setWord(102u, lane, r.word(r.top + 2u, lane));
                     r.top = 100u;
                 }, -1},
                {"66 06 08 54 18 28 42, q329.x = 335: 0x28's packet would overwrite the list", R::WriteRange, 0x28u,
                 [](Entry33c8Rig &r) {
                     r.setResumedList({0x66u, 0x06u, 0x08u, 0x54u, 0x18u, 0x28u, 0x42u});
                     r.setWord(329u, 0u, 335);
                 }, -1},
                {"66 06 08 54 18 28 42, q329.y = 1020: 0x28's packet would wrap past the end of VU memory", R::WriteRange, 0x28u,
                 [](Entry33c8Rig &r) {
                     r.setResumedList({0x66u, 0x06u, 0x08u, 0x54u, 0x18u, 0x28u, 0x42u});
                     r.setWord(329u, 1u, 1020);
                 }, -1},
                {"06 08 40 42, TOP+2.x = -84: 0x06's flag words from q340 would overwrite the list", R::WriteRange, 0x06u,
                 [](Entry33c8Rig &r) { r.setResumedList({0x06u, 0x08u, 0x40u, 0x42u}); r.setWord(r.top + 2u, 0u, -84); }, -1},
                {"06 08 40 42, TOP+2.x = -10: 0x06's seventh flag word (q426) would overwrite the header TOP+2", R::WriteRange, 0x06u,
                 [](Entry33c8Rig &r) { r.setResumedList({0x06u, 0x08u, 0x40u, 0x42u}); r.setWord(r.top + 2u, 0u, -10); }, -1},
                {"06 08 40 42, TOP+2.x = 600: 0x06's flag words would wrap past the end of VU memory", R::WriteRange, 0x06u,
                 [](Entry33c8Rig &r) { r.setResumedList({0x06u, 0x08u, 0x40u, 0x42u}); r.setWord(r.top + 2u, 0u, 600); }, -1},
                {"06 08 40 42, one triangle, TOP+2.x = -21: 0x06's one flag word is q403, the list's last qword", R::WriteRange, 0x06u,
                 [](Entry33c8Rig &r) {
                     r.setResumedList({0x06u, 0x08u, 0x40u, 0x42u});
                     r.setWord(r.top + 2u, 0u, -21);
                     r.setWord(r.top + 2u, 3u, 1);
                 }, -1},
                {"54 66 06 08 40 42, TOP+2.z = 97: 0x54's fill [41, 335] would overwrite the packet pointers at q329",
                 R::WriteRange, 0x54u,
                 [](Entry33c8Rig &r) { r.setResumedList({0x54u, 0x66u, 0x06u, 0x08u, 0x40u, 0x42u}); r.setWord(r.top + 2u, 2u, 97); }, -1},
                {"54 66 06 08 40 42, TOP+2.z = 101: 0x54's fill [41, 344] would overwrite the list", R::WriteRange, 0x54u,
                 [](Entry33c8Rig &r) { r.setResumedList({0x54u, 0x66u, 0x06u, 0x08u, 0x40u, 0x42u}); r.setWord(r.top + 2u, 2u, 101); }, -1},
                {"54 66 06 08 40 42, TOP 100 (the header copied to q102): 0x54's fill [41, 164] would overwrite TOP+2",
                 R::WriteRange, 0x54u,
                 [](Entry33c8Rig &r) {
                     r.setResumedList({0x54u, 0x66u, 0x06u, 0x08u, 0x40u, 0x42u});
                     for (uint32_t lane = 0; lane < 4u; ++lane)
                         r.setWord(102u, lane, r.word(r.top + 2u, lane));
                     r.top = 100u;
                 }, -1},
                {"10 66 06 08 40 42, TOP+2.z = 97: 0x10's fog lanes [42, 330], proven as whole qwords, cover q329",
                 R::WriteRange, 0x10u,
                 [](Entry33c8Rig &r) { r.setResumedList({0x10u, 0x66u, 0x06u, 0x08u, 0x40u, 0x42u}); r.setWord(r.top + 2u, 2u, 97); }, -1},
                {"10 66 06 08 40 42, TOP 100 (the header copied to q102): 0x10's fog lanes [42, 165] would overwrite TOP+2",
                 R::WriteRange, 0x10u,
                 [](Entry33c8Rig &r) {
                     r.setResumedList({0x10u, 0x66u, 0x06u, 0x08u, 0x40u, 0x42u});
                     for (uint32_t lane = 0; lane < 4u; ++lane)
                         r.setWord(102u, lane, r.word(r.top + 2u, lane));
                     r.top = 100u;
                 }, -1},
                {"the handler vertex ceiling at 10 (0x08's clamp would fire after the repack)", R::HeaderVertices, 0u,
                 [](Entry33c8Rig &) {}, 10},
            };
            for (const Case &k : cases)
            {
                Entry33c8Rig rig;
                t.IsTrue(rig.load(), "fixture present");
                if (rig.code.empty())
                    return;
                rig.makeLastBone();
                k.setup(rig);
                if (k.vertexCeiling >= 0)
                    RefusalRig::forceVertexCeiling(k.vertexCeiling);
                Vu1Refusals::setEnabledForTest(true);
                const Vu1Refusals::Row before = RefusalRig::row(0x33c8u, k.reason, k.cmd);
                // Budget-bounded: the fallback is the microcode on a state it was never meant to see (vi9 = 0 is
                // its own 65536-iteration repack); the refusal and the untouched state are what is checked.
                const Entry33c8Rig::End native = rig.run(0x33c8u, 0x33c8u, &Entry33c8Rig::entry, 64u);
                const Vu1Refusals::Row after = RefusalRig::row(0x33c8u, k.reason, k.cmd);
                Vu1Refusals::setEnabledForTest(false);
                RefusalRig::forceVertexCeiling(-1);
                t.IsTrue(native.nativeRan && !native.nativeEnded, std::string(k.what) + ": handed back");
                t.Equals(after.n - before.n, 1ull, std::string(k.what) + ": counted under its reason");
                t.IsTrue(native.touchedBeforeHandBack.empty(),
                         std::string(k.what) + ": nothing touched before the hand-back:" + native.touchedBeforeHandBack);
            }
        });

        tc.Run("native 0x1b50 is unchanged: a list holding 0x66 is still refused whole as unknown_command 0x66", [](TestCase &t)
        {
            Entry33c8Rig rig;
            t.IsTrue(rig.load(), "fixture present");
            if (rig.code.empty())
                return;
            const uint32_t list[4] = {0x66u, 0x08u, 0x40u, 0x42u};
            for (uint32_t k = 0; k < 4u; ++k)
                rig.setWord(340u + k, 0u, static_cast<int32_t>(list[k]));
            Vu1Refusals::setEnabledForTest(true);
            const Vu1Refusals::Row before = RefusalRig::row(0x1b50u, Vu1Refusals::Reason::UnknownCommand, 0x66u);
            rig.run(0x1b50u, 0x1b50u, &Entry33c8Rig::dispatcher);
            const Vu1Refusals::Row after = RefusalRig::row(0x1b50u, Vu1Refusals::Reason::UnknownCommand, 0x66u);
            Vu1Refusals::setEnabledForTest(false);
            t.Equals(after.n - before.n, 1ull, "unknown_command cmd=0x66 at entry 0x1b50 +1: 0x66 is admitted only at 0x33c8");
        });

        // ---- Sprint 17 F N2 (docs/research/82 section 10): the skinning pass 0x52 (0x3100-0x33c0) --------------------
        // Both of 0x52's entries run the same pass: at 0x1b50 as the list's first command (`52 66 08 40 42`: the pass
        // ends the program at its E bit, pc 0x33c8, and the rest of the list runs in a later MSCAL), and at 0x33c8 when
        // the live-in vi5 (the previous chunk's flags) has bit 2 clear, the microcode's `B 0x3100` -- (A), another bone.
        // Behind PS2X_VU1_NATIVE_SKIN (Dev, default 0), forced here through vu1native_socom2_forceSkinForTest. The pass
        // emits nothing, so what is compared is the register file and VU data memory whole. Its stores -- q37.x on the
        // first pass, then xyz of the staging pair base + dst, base + dst + 1 of each vertex -- are proven before the
        // first write: inside VU memory without wrapping, clear of the bone chunk it reads (TOP .. TOP + 6 + 2n, the
        // read-ahead vertex included) and of q37. The states are real dumps (vu1_52_real_dumps.inc).
        struct SkinScope
        {
            static void force(int state)   // -1 = PS2X_VU1_NATIVE_SKIN as latched, 0 = off, 1 = on
            {
                void vu1native_socom2_forceSkinForTest(int state);
                vu1native_socom2_forceSkinForTest(state);
            }
            explicit SkinScope(int state) { force(state); }
            ~SkinScope() { force(-1); }
            SkinScope(const SkinScope &) = delete;
            SkinScope &operator=(const SkinScope &) = delete;
        };

        tc.Run("PS2X_VU1_NATIVE_SKIN is a Dev Flag defaulting to 0 (off: both 0x52 entries as before)", [](TestCase &t)
        {
            const ps2x::knobs::Entry *e = ps2x::knobs::find("PS2X_VU1_NATIVE_SKIN");
            t.IsTrue(e != nullptr && e->cls == ps2x::knobs::Class::Dev && e->kind == ps2x::knobs::Kind::Flag &&
                         std::string(e->dflt) == "0",
                     "a Dev Flag, default 0 (measured apart from PS2X_VU1_NATIVE_33C8)");
            t.IsTrue(e != nullptr && std::string(e->meaning).size() <= 110u, "its meaning fits the registry's 110 characters");
        });

        {
            struct SkinCase
            {
                const char *what;
                const RealDump *dump;
                uint32_t entry;
            };
            static const SkinCase skinCases[] = {
                {"a bone pass at 0x33c8, vi5 2, flags 1 (accumulate), 12 vertices, TOP 724 (vu1dump3 prog 122)", &kB122, 0x33c8u},
                {"a bone pass at 0x33c8, vi5 1, flags 5 (accumulate, last), 1 vertex, TOP 424 (vu1dump3 prog 127)", &kB127, 0x33c8u},
                {"a bone pass at 0x33c8, vi5 1, flags 1, 9 vertices, destinations 44-90, TOP 424 (vu1dump3 prog 135)", &kB135, 0x33c8u},
                {"52 66 08 40 42 at 0x1b50, flags 2 (the first pass), 29 vertices (vu1dump3 prog 121)", &kS121, 0x1b50u},
                {"52 66 08 40 42 at 0x1b50, flags 2, 46 vertices (vu1dump3 prog 129)", &kS129, 0x1b50u},
                {"52 66 08 40 42 at 0x1b50, flags 2, 49 vertices, destinations to 96 (vu1dump3 prog 145)", &kS145, 0x1b50u},
            };
            for (const SkinCase &k : skinCases)
            {
                tc.Run(std::string("native 0x52: ") + k.what + ": taken natively, bit-exact", [&k](TestCase &t)
                {
                    SkinScope on(1);
                    Entry33c8Rig rig;
                    t.IsTrue(rig.loadReal(*k.dump), "fixture present");
                    if (rig.code.empty())
                        return;
                    if (k.entry == 0x33c8u)
                        t.Equals(rig.vi[5] & 4, 0, "the live-in vi5 has bit 2 clear: the microcode's B 0x3100");
                    else
                        t.Equals(rig.word(340u, 0u) & 0xFFFF, 0x52, "the list starts with 0x52");
                    const Entry33c8Rig::End oracle = rig.run(k.entry, k.entry, nullptr);
                    t.Equals(oracle.s.pc, 0x33c8u, "the oracle ended at 0x52's E bit (pc 0x33c8)");
                    const Entry33c8Rig::End native =
                        rig.run(k.entry, k.entry, k.entry == 0x33c8u ? &Entry33c8Rig::entry : &Entry33c8Rig::dispatcherChecked);
                    t.IsTrue(native.nativeRan && native.nativeEnded, "the native pass ran and ended the program");
                    const std::string why = Entry33c8Rig::diff(oracle, native, true);
                    t.IsTrue(why.empty(), "native = interpreter, register file and VU data memory (and no packet):" + why);
                });
            }
        }

        tc.Run("native 0x52: one mesh's three MSCALs -- 0x1b50's first pass, a bone pass, the last bone's list -- bit-exact end to end",
               [](TestCase &t)
        {
            // vu1dump3 prog 142, 143 and 144: `52 66 08 40 42` at 0x1b50 (the first bone, TOP 724), then 0x33c8 with vi5 =
            // 2 (another bone, TOP 424, flags 5), then 0x33c8 with vi5 = 5 (the repack and `66 08 40 42`, TOP 724). One
            // interpreter and one VU data memory across the three, the VIF's uploads written between them, as the game
            // runs them: the register file each program leaves is the next one's live-in (vi5, vi9, vi14, q37, the
            // staging array), so every step is compared, the oracle's chain against the native one.
            SkinScope on(1);
            Entry33c8Rig rig;
            t.IsTrue(rig.loadReal(kChain142), "fixture present");
            if (rig.code.empty())
                return;
            struct Step
            {
                uint32_t startPc, top;
                const RealDumpSpan *uploads;
                size_t uploadCount;
                uint32_t endPc;
            };
            const Step steps[] = {
                {0x1b50u, 724u, nullptr, 0u, 0x33c8u},
                {0x33c8u, 424u, kChain143UploadsSpans, sizeof(kChain143UploadsSpans) / sizeof(kChain143UploadsSpans[0]), 0x33c8u},
                {0x33c8u, 724u, kChain144UploadsSpans, sizeof(kChain144UploadsSpans) / sizeof(kChain144UploadsSpans[0]), 0x1b50u},
            };
            struct Chain
            {
                std::vector<Entry33c8Rig::End> ends;
                uint32_t nativeEnded = 0u;
            };
            static uint32_t s_nativeEnded = 0u;
            auto runChain = [&](bool native) {
                Chain chain;
                s_nativeEnded = 0u;
                PS2Memory mem;
                GS gs;
                if (!mem.initialize())
                    return chain;
                gs.init(mem.getGSVRAM(), static_cast<uint32_t>(PS2_GS_VRAM_SIZE), &mem.gs());
                uint8_t *vuCode = mem.getVU1Code();
                uint8_t *vuData = mem.getVU1Data();
                std::memcpy(vuCode, rig.code.data(), PS2_VU1_CODE_SIZE);
                mem.markVU1CodeModified();
                std::memcpy(vuData, rig.data.data(), PS2_VU1_DATA_SIZE);
                std::vector<uint8_t> packets;
                mem.setGifPacketCallback([&packets](const uint8_t *p, uint32_t n) {
                    const uint32_t len = n;
                    packets.insert(packets.end(), reinterpret_cast<const uint8_t *>(&len), reinterpret_cast<const uint8_t *>(&len) + 4);
                    packets.insert(packets.end(), p, p + n);
                });
                uint64_t h = 1469598103934665603ull;
                for (uint32_t i = 0; i < PS2_VU1_CODE_SIZE; ++i)
                {
                    h ^= rig.code[i];
                    h *= 1099511628211ull;
                }
                const auto at1b50 = +[](VU1Interpreter &vu, uint64_t b) {
                    bool vu1native_socom2_dispatch(VU1Interpreter &vu, uint64_t budgetEnd);
                    const bool ended = vu1native_socom2_dispatch(vu, b);
                    s_nativeEnded += ended ? 1u : 0u;
                    return ended;
                };
                const auto at33c8 = +[](VU1Interpreter &vu, uint64_t b) {
                    bool vu1native_socom2_entry_0x33c8(VU1Interpreter &vu, uint64_t budgetEnd);
                    const bool ended = vu1native_socom2_entry_0x33c8(vu, b);
                    s_nativeEnded += ended ? 1u : 0u;
                    return ended;
                };
                const Vu1NativeProgram table[] = {{native ? h : 0u, 0x1b50u, at1b50}, {native ? h : 0u, 0x33c8u, at33c8}};
                VU1Interpreter vu;
                vu.reset();
                std::memcpy(vu.state().vi, rig.vi, sizeof(rig.vi));
                std::memcpy(vu.state().vf, rig.vf, sizeof(rig.vf));
                vu.setNativeProgramsOverride(table, 2u);
                for (const Step &s : steps)
                {
                    for (size_t k = 0; k < s.uploadCount; ++k)
                    {
                        const std::string hex = s.uploads[k].hex;
                        for (size_t w = 0; w + 8u <= hex.size(); w += 8u)
                        {
                            const uint32_t q = s.uploads[k].first + static_cast<uint32_t>(w / 32u);
                            const uint32_t v = static_cast<uint32_t>(std::stoul(hex.substr(w, 8u), nullptr, 16));
                            std::memcpy(vuData + ((q * 16u) & 0x3FFFu) + ((w / 8u) % 4u) * 4u, &v, 4u);
                        }
                    }
                    packets.clear();
                    vu.execute(vuCode, PS2_VU1_CODE_SIZE, vuData, PS2_VU1_DATA_SIZE, gs, &mem, s.startPc, s.top, 0u, 1u << 28);
                    Entry33c8Rig::End end;
                    end.s = vu.state();
                    end.data.assign(vuData, vuData + PS2_VU1_DATA_SIZE);
                    end.packets = packets;
                    chain.ends.push_back(end);
                }
                vu.setNativeProgramsOverride(nullptr, 0u);
                mem.setGifPacketCallback(nullptr);
                chain.nativeEnded = s_nativeEnded;
                return chain;
            };
            t.Equals(rig.top, 724u, "the chain starts at prog 142's TOP");
            const Chain oracle = runChain(false);
            const Chain native = runChain(true);
            t.IsTrue(oracle.ends.size() == 3u && native.ends.size() == 3u, "three MSCALs each");
            if (oracle.ends.size() != 3u || native.ends.size() != 3u)
                return;
            t.Equals(native.nativeEnded, 3u, "all three taken natively (0x1b50's 0x52, the bone pass, the last bone's list)");
            for (size_t k = 0; k < 3u; ++k)
            {
                t.Equals(oracle.ends[k].s.pc, steps[k].endPc, "MSCAL " + std::to_string(k + 1) + ": the oracle's end pc");
                const std::string why = Entry33c8Rig::diff(oracle.ends[k], native.ends[k], Entry33c8Rig::packetsComparable());
                t.IsTrue(why.empty(), "MSCAL " + std::to_string(k + 1) + ": native = interpreter:" + why);
            }
            if (Entry33c8Rig::packetsComparable())
                t.IsTrue(!native.ends[2].packets.empty(), "the last bone's list drew");
        });

        tc.Run("native 0x52: pairs at the edge of the proof are taken, bit-exact", [](TestCase &t)
        {
            // kB122 (TOP 724, 12 vertices: the chunk q724-754, the staging base q37.x = 40): vertex 3 to q722-723, just
            // below the chunk, and the last vertex to q755-756, just past its read-ahead qword -- each clear, so taken.
            SkinScope on(1);
            Entry33c8Rig rig;
            t.IsTrue(rig.loadReal(kB122), "fixture present");
            if (rig.code.empty())
                return;
            rig.setWord(rig.top + 5u + 6u, 3u, 682);
            rig.setWord(rig.top + 5u + 22u, 3u, 715);
            const Entry33c8Rig::End oracle = rig.run(0x33c8u, 0x33c8u, nullptr);
            const Entry33c8Rig::End native = rig.run(0x33c8u, 0x33c8u, &Entry33c8Rig::entry);
            t.IsTrue(native.nativeRan && native.nativeEnded, "taken natively");
            const std::string why = Entry33c8Rig::diff(oracle, native, true);
            t.IsTrue(why.empty(), "native = interpreter:" + why);
        });

        tc.Run("native 0x52: at 0x1b50 the first pass persists the staging base, q37.x = 40, bit-exact", [](TestCase &t)
        {
            // Every dump already holds q37.x = 40 from the mesh before; cleared, the first pass's ISW.x at 0x3178 is seen.
            SkinScope on(1);
            Entry33c8Rig rig;
            t.IsTrue(rig.loadReal(kS121), "fixture present");
            if (rig.code.empty())
                return;
            for (uint32_t lane = 0; lane < 4u; ++lane)
                rig.setWord(37u, lane, 0);
            const Entry33c8Rig::End oracle = rig.run(0x1b50u, 0x1b50u, nullptr);
            const Entry33c8Rig::End native = rig.run(0x1b50u, 0x1b50u, &Entry33c8Rig::dispatcherChecked);
            t.IsTrue(native.nativeRan && native.nativeEnded, "taken natively");
            int32_t base = 0;
            std::memcpy(&base, oracle.data.data() + 37u * 16u, 4u);
            t.Equals(base, 40, "the oracle's q37.x is 40");
            const std::string why = Entry33c8Rig::diff(oracle, native, true);
            t.IsTrue(why.empty(), "native = interpreter:" + why);
        });

        tc.Run("native 0x52: knob off, a bone pass is still skin_pass and a 0x52 list still unknown_command 0x52", [](TestCase &t)
        {
            SkinScope off(0);
            {
                Entry33c8Rig rig;
                t.IsTrue(rig.loadReal(kB122), "fixture present");
                if (rig.code.empty())
                    return;
                Vu1Refusals::setEnabledForTest(true);
                const Vu1Refusals::Row before = RefusalRig::row(0x33c8u, Vu1Refusals::Reason::SkinPass, 0u);
                const uint64_t total = Vu1Refusals::live().totalCount();
                const Entry33c8Rig::End native = rig.run(0x33c8u, 0x33c8u, &Entry33c8Rig::entry);
                const Vu1Refusals::Row after = RefusalRig::row(0x33c8u, Vu1Refusals::Reason::SkinPass, 0u);
                const uint64_t totalAfter = Vu1Refusals::live().totalCount();
                Vu1Refusals::setEnabledForTest(false);
                const Entry33c8Rig::End oracle = rig.run(0x33c8u, 0x33c8u, nullptr);
                t.IsTrue(native.nativeRan && !native.nativeEnded, "0x33c8: handed back");
                t.IsTrue(native.touchedBeforeHandBack.empty(), "0x33c8: nothing touched:" + native.touchedBeforeHandBack);
                t.Equals(after.n - before.n, 1ull, "skin_pass at entry 0x33c8 +1");
                t.Equals(totalAfter - total, 1ull, "and nothing else");
                const std::string why = Entry33c8Rig::diff(oracle, native, true);
                t.IsTrue(why.empty(), "0x33c8: the fallback is the microcode's own run:" + why);
            }
            {
                Entry33c8Rig rig;
                t.IsTrue(rig.loadReal(kS121), "fixture present");
                if (rig.code.empty())
                    return;
                Vu1Refusals::setEnabledForTest(true);
                const Vu1Refusals::Row before = RefusalRig::row(0x1b50u, Vu1Refusals::Reason::UnknownCommand, 0x52u);
                const uint64_t total = Vu1Refusals::live().totalCount();
                const Entry33c8Rig::End native = rig.run(0x1b50u, 0x1b50u, &Entry33c8Rig::dispatcherChecked);
                const Vu1Refusals::Row after = RefusalRig::row(0x1b50u, Vu1Refusals::Reason::UnknownCommand, 0x52u);
                const uint64_t totalAfter = Vu1Refusals::live().totalCount();
                Vu1Refusals::setEnabledForTest(false);
                const Entry33c8Rig::End oracle = rig.run(0x1b50u, 0x1b50u, nullptr);
                t.IsTrue(native.nativeRan && !native.nativeEnded, "0x1b50: handed back");
                t.IsTrue(native.touchedBeforeHandBack.empty(), "0x1b50: nothing touched:" + native.touchedBeforeHandBack);
                t.Equals(after.n - before.n, 1ull, "unknown_command cmd=0x52 at entry 0x1b50 +1");
                t.Equals(totalAfter - total, 1ull, "and nothing else");
                const std::string why = Entry33c8Rig::diff(oracle, native, true);
                t.IsTrue(why.empty(), "0x1b50: the fallback is the microcode's own run:" + why);
            }
        });

        tc.Run("native 0x52: a pass whose stores it cannot bound is refused before anything is touched", [](TestCase &t)
        {
            // Before the first write: the vertex count TOP+4.w in 1..the vertex ceiling (the loop is an IBNE after a
            // decrement: 0 is 65536 passes), the bone chunk TOP .. TOP + 6 + 2n inside VU memory, and each vertex's pair
            // base + dst, base + dst + 1 inside VU memory without wrapping and clear of that chunk and of q37 (base = 40 on
            // the first pass, q37.x on an accumulate one). At 0x1b50 the 0x52 must be the list's first command. Each
            // refusal leaves the register file and VU data memory exactly as the entry found them.
            using R = Vu1Refusals::Reason;
            struct Case
            {
                const char *what;
                const RealDump *dump;
                uint32_t entry;
                R reason;
                uint32_t cmd;
                void (*setup)(Entry33c8Rig &);
                int32_t vertexCeiling;
            };
            // kB122: TOP 724, accumulate, 12 vertices, destinations 0-46 on base q37.x = 40. kS121: TOP 424, first pass,
            // 29 vertices.
            const Case cases[] = {
                {"0x33c8, TOP+4.w = 0 (65536 passes)", &kB122, 0x33c8u, R::SkinCount, 0u,
                 [](Entry33c8Rig &r) { r.setWord(r.top + 4u, 3u, 0); }, -1},
                {"0x33c8, TOP+4.w = 257 (over the vertex ceiling)", &kB122, 0x33c8u, R::SkinCount, 0u,
                 [](Entry33c8Rig &r) { r.setWord(r.top + 4u, 3u, 257); }, -1},
                {"0x33c8, TOP+4.w = -3 (a 16-bit count the loop reads as 65533 passes)", &kB122, 0x33c8u, R::SkinCount, 0u,
                 [](Entry33c8Rig &r) { r.setWord(r.top + 4u, 3u, 0xFFFD); }, -1},
                {"0x33c8, 12 vertices over a vertex ceiling lowered to 8", &kB122, 0x33c8u, R::SkinCount, 0u,
                 [](Entry33c8Rig &) {}, 8},
                {"0x33c8, vertex 3's destination 683: its pair q723-724 reaches the chunk's first qword", &kB122, 0x33c8u,
                 R::SkinRange, 0u, [](Entry33c8Rig &r) { r.setWord(r.top + 5u + 6u, 3u, 683); }, -1},
                {"0x33c8, the last vertex's destination 714: its pair starts on q754, the read-ahead vertex's normal", &kB122,
                 0x33c8u, R::SkinRange, 0u, [](Entry33c8Rig &r) { r.setWord(r.top + 5u + 22u, 3u, 714); }, -1},
                {"0x33c8, vertex 1's destination -4: its pair q36-37 would overwrite the staging base q37", &kB122, 0x33c8u,
                 R::SkinRange, 0u, [](Entry33c8Rig &r) { r.setWord(r.top + 5u + 2u, 3u, 0xFFFC); }, -1},
                {"0x33c8, vertex 0's destination -41: its pair would wrap below q0", &kB122, 0x33c8u, R::SkinRange, 0u,
                 [](Entry33c8Rig &r) { r.setWord(r.top + 5u, 3u, 0xFFD7); }, -1},
                {"0x33c8, vertex 5's destination 983: its pair q1023-1024 would wrap past the end", &kB122, 0x33c8u,
                 R::SkinRange, 0u, [](Entry33c8Rig &r) { r.setWord(r.top + 5u + 10u, 3u, 983); }, -1},
                {"0x33c8, the accumulate base q37.x = 1000: the pairs would wrap past the end", &kB122, 0x33c8u, R::SkinRange,
                 0u, [](Entry33c8Rig &r) { r.setWord(37u, 0u, 1000); }, -1},
                {"0x33c8, the accumulate base q37.x = 700: vertex pairs from q700 reach the chunk at q724", &kB122, 0x33c8u,
                 R::SkinRange, 0u, [](Entry33c8Rig &r) { r.setWord(37u, 0u, 700); }, -1},
                {"0x33c8, TOP 1010 with 12 vertices: the chunk q1010-1040 wraps past the end", &kB122, 0x33c8u, R::SkinRange,
                 0u,
                 [](Entry33c8Rig &r) {
                     r.top = 1010u;
                     r.setWord(1014u, 0u, 1);
                     r.setWord(1014u, 3u, 12);
                 }, -1},
                {"0x1b50, TOP+4.w = 0", &kS121, 0x1b50u, R::SkinCount, 0u, [](Entry33c8Rig &r) { r.setWord(r.top + 4u, 3u, 0); }, -1},
                {"0x1b50, vertex 2's destination 384: its pair q424-425 is the bone matrix", &kS121, 0x1b50u, R::SkinRange, 0u,
                 [](Entry33c8Rig &r) { r.setWord(r.top + 5u + 4u, 3u, 384); }, -1},
                {"0x1b50, TOP 30 with one vertex: the first pass's ISW.x of q37 lands inside the chunk q30-38", &kS121, 0x1b50u,
                 R::SkinRange, 0u,
                 [](Entry33c8Rig &r) {
                     r.top = 30u;
                     r.setWord(34u, 0u, 2);
                     r.setWord(34u, 3u, 1);
                     r.setWord(35u, 3u, 60);
                 }, -1},
                {"0x1b50, 70 52 42: the 0x52 after another command", &kS121, 0x1b50u, R::SkinNotFirst, 0x52u,
                 [](Entry33c8Rig &r) {
                     r.setWord(340u, 0u, 0x70);
                     r.setWord(341u, 0u, 0x52);
                     r.setWord(342u, 0u, 0x42);
                 }, -1},
            };
            for (const Case &k : cases)
            {
                SkinScope on(1);
                Entry33c8Rig rig;
                t.IsTrue(rig.loadReal(*k.dump), "fixture present");
                if (rig.code.empty())
                    return;
                k.setup(rig);
                if (k.vertexCeiling >= 0)
                    RefusalRig::forceVertexCeiling(k.vertexCeiling);
                Vu1Refusals::setEnabledForTest(true);
                const Vu1Refusals::Row before = RefusalRig::row(k.entry, k.reason, k.cmd);
                const uint64_t total = Vu1Refusals::live().totalCount();
                // Budget-bounded: the fallback is the microcode on a state it was never meant to see (a zero count is its
                // own 65536 passes); the refusal and the untouched state are what is checked.
                const Entry33c8Rig::End native =
                    rig.run(k.entry, k.entry, k.entry == 0x33c8u ? &Entry33c8Rig::entry : &Entry33c8Rig::dispatcherChecked, 64u);
                const Vu1Refusals::Row after = RefusalRig::row(k.entry, k.reason, k.cmd);
                const uint64_t totalAfter = Vu1Refusals::live().totalCount();
                Vu1Refusals::setEnabledForTest(false);
                RefusalRig::forceVertexCeiling(-1);
                t.IsTrue(native.nativeRan && !native.nativeEnded, std::string(k.what) + ": handed back");
                t.Equals(after.n - before.n, 1ull, std::string(k.what) + ": counted under its reason");
                t.Equals(totalAfter - total, 1ull, std::string(k.what) + ": and under no other");
                t.IsTrue(native.touchedBeforeHandBack.empty(),
                         std::string(k.what) + ": nothing touched before the hand-back:" + native.touchedBeforeHandBack);
            }
        });

        // ---- Sprint 17 F N1c (docs/research/82 section 9): PS2X_VU1_DUMP_REFUSED -------------------------------------
        // The walk's last-bone lists entry 0x33c8 still refuses (resume_command 0x02, 0x54, 0x10) were never on disk:
        // 4,000 dumps at one instant held none. The capture writes a refused program's entry state -- a refused one's
        // only -- in PS2X_VU1_DUMP's format, and an index line naming the reason, the command and the resumed list.
        struct DumpDir
        {
            std::filesystem::path path;
            explicit DumpDir(const char *name)
            {
                path = std::filesystem::temp_directory_path() / (std::string("ps2x_dump_refused_") + name);
                std::error_code ec;
                std::filesystem::remove_all(path, ec);
            }
            ~DumpDir()
            {
                Vu1DumpRefused::resetForTest();
                std::error_code ec;
                std::filesystem::remove_all(path, ec);
            }
            DumpDir(const DumpDir &) = delete;
            DumpDir &operator=(const DumpDir &) = delete;
            std::string knob(const char *suffix) const { return path.generic_string() + suffix; }
            std::vector<std::string> bins() const
            {
                std::vector<std::string> names;
                std::error_code ec;
                for (const auto &e : std::filesystem::directory_iterator(path, ec))
                    if (e.path().extension() == ".bin")
                        names.push_back(e.path().filename().string());
                std::sort(names.begin(), names.end());
                return names;
            }
            std::vector<std::string> indexLines() const
            {
                std::vector<std::string> lines;
                FILE *f = std::fopen((path / "refused.txt").string().c_str(), "rb");
                if (!f)
                    return lines;
                std::string text;
                char buf[512];
                size_t got;
                while ((got = std::fread(buf, 1, sizeof(buf), f)) > 0)
                    text.append(buf, got);
                std::fclose(f);
                size_t start = 0;
                for (size_t i = 0; i < text.size(); ++i)
                    if (text[i] == '\n')
                    {
                        lines.push_back(text.substr(start, i - start));
                        start = i + 1;
                    }
                return lines;
            }
        };
        // A last-bone entry whose resumed list holds a 0x64 (no store range derived: refused as resume_command 0x64).
        // It held a 0x28 until N1c's real shapes admitted that one.
        static const std::vector<uint32_t> kRefusedList = {0x66u, 0x06u, 0x08u, 0x64u, 0x42u};

        tc.Run("PS2X_VU1_DUMP_REFUSED is a Dev Path defaulting to empty (off)", [](TestCase &t)
        {
            const ps2x::knobs::Entry *e = ps2x::knobs::find("PS2X_VU1_DUMP_REFUSED");
            t.IsTrue(e != nullptr && e->cls == ps2x::knobs::Class::Dev && e->kind == ps2x::knobs::Kind::Path &&
                         std::string(e->dflt).empty(),
                     "a Dev Path, default empty (a capture instrument, off unless asked for)");
            if (ps2x::knob("PS2X_VU1_DUMP_REFUSED") == nullptr)
            {
                Vu1DumpRefused::resetForTest();
                t.IsTrue(!Vu1DumpRefused::enabled(), "unset: the capture is off");
                t.IsTrue(!Vu1Refusals::wholeListening().load(), "unset: no refusal site remembers anything");
            }
        });

        tc.Run("PS2X_VU1_DUMP_REFUSED's value: <dir>[:<count>[:<entrypc>]], a drive letter is not a separator", [](TestCase &t)
        {
            const Vu1DumpRefused::Config bare = Vu1DumpRefused::parse("C:/logs/refused");
            t.IsTrue(bare.on() && bare.dir == "C:/logs/refused" && bare.maxFiles == 150 && bare.anyEntry,
                     "a bare dir: 150 files, any entry");
            const Vu1DumpRefused::Config counted = Vu1DumpRefused::parse("logs/refused:40");
            t.IsTrue(counted.dir == "logs/refused" && counted.maxFiles == 40 && counted.anyEntry, "dir:count");
            const Vu1DumpRefused::Config narrowed = Vu1DumpRefused::parse("C:/r:5:0x33c8");
            t.IsTrue(narrowed.dir == "C:/r" && narrowed.maxFiles == 5 && !narrowed.anyEntry && narrowed.entryPc == 0x33c8u,
                     "dir:count:entrypc narrows to one entry");
            t.IsTrue(!Vu1DumpRefused::parse("").on() && !Vu1DumpRefused::parse(nullptr).on(), "empty: off");
            t.IsTrue(!Vu1DumpRefused::parse("logs/r:0").on(), "a zero count: off");
        });

        tc.Run("dump refused: knob off, a refused last-bone list writes nothing", [](TestCase &t)
        {
            DumpDir dir("off");
            Entry33c8Rig rig;
            t.IsTrue(rig.load(), "fixture present");
            if (rig.code.empty())
                return;
            rig.makeLastBone();
            rig.setResumedList(kRefusedList);
            Vu1DumpRefused::setForTest(nullptr);
            const Entry33c8Rig::End native = rig.run(0x33c8u, 0x33c8u, &Entry33c8Rig::entry, 64u);
            t.IsTrue(native.nativeRan && !native.nativeEnded, "the list was refused (handed back)");
            t.IsTrue(!std::filesystem::exists(dir.path), "off: no directory, no file");
        });

        tc.Run("dump refused: a refused last-bone list writes one entry-state .bin that replays, and one index line", [](TestCase &t)
        {
            DumpDir dir("one");
            Entry33c8Rig rig;
            t.IsTrue(rig.load(), "fixture present");
            if (rig.code.empty())
                return;
            rig.makeLastBone();
            rig.setResumedList(kRefusedList);
            Vu1DumpRefused::setForTest(dir.knob(":10").c_str());
            const Entry33c8Rig::End native = rig.run(0x33c8u, 0x33c8u, &Entry33c8Rig::entry, 64u);
            t.IsTrue(native.nativeRan && !native.nativeEnded, "the list was refused (handed back)");
            const std::vector<std::string> bins = dir.bins();
            t.Equals(bins.size(), static_cast<size_t>(1), "one file");
            if (bins.size() != 1u)
                return;
            t.IsTrue(bins[0] == "vu1_refused_0_resume_command_0x64.bin", "named by reason and command: " + bins[0]);
            const std::vector<std::string> lines = dir.indexLines();
            t.Equals(lines.size(), static_cast<size_t>(1), "one index line");
            if (!lines.empty())
                t.IsTrue(lines[0] == "vu1_refused_0_resume_command_0x64.bin entry=0x33c8 reason=resume_command cmd=0x64 "
                                     "resume=1 list=66,06,08,64,42",
                         "the index line: " + lines[0]);

            // The dump reader's layout: the header, then the entry state exactly as the rig handed it to execute().
            const std::string path = (dir.path / bins[0]).string();
            uint32_t hdr[4] = {};
            if (FILE *f = std::fopen(path.c_str(), "rb"))
            {
                t.IsTrue(std::fread(hdr, sizeof(hdr), 1, f) == 1, "header read");
                std::fclose(f);
            }
            t.Equals(hdr[0], 0x33c8u, "header startPc = the entry");
            t.Equals(hdr[1], rig.top, "header top");
            t.Equals(hdr[3], static_cast<uint32_t>(PS2_VU1_CODE_SIZE), "header codeSize");
            Entry33c8Rig back;
            t.IsTrue(back.loadFrom(path), "the dump reads back whole (PS2X_VU1_DUMP's size)");
            t.IsTrue(back.code == rig.code, "code = the entry's");
            t.IsTrue(back.data == rig.data, "VU data memory = the entry's (nothing touched before the write)");
            t.IsTrue(std::memcmp(back.vi, rig.vi, sizeof(rig.vi)) == 0, "vi[16] = the entry's (vi5, vi9, vi14 live-in)");
            t.IsTrue(std::memcmp(back.vf, rig.vf, sizeof(rig.vf)) == 0, "vf[32] = the entry's");

            // And it replays: the interpreter over the dump ends where it ends over the rig's own state.
            Vu1DumpRefused::setForTest(nullptr);
            const Entry33c8Rig::End fromRig = rig.run(0x33c8u, 0x33c8u, nullptr);
            const Entry33c8Rig::End fromDump = back.run(0x33c8u, 0x33c8u, nullptr);
            const std::string why = Entry33c8Rig::diff(fromRig, fromDump, true);
            t.IsTrue(why.empty(), "the dumped state replays to the same end:" + why);
        });

        tc.Run("dump refused: an accepted list and a skin pass write nothing", [](TestCase &t)
        {
            DumpDir dir("accepted");
            Entry33c8Rig rig;
            t.IsTrue(rig.load(), "fixture present");
            if (rig.code.empty())
                return;
            rig.makeLastBone();
            rig.setResumedList({0x66u, 0x06u, 0x08u, 0x40u, 0x42u});
            Vu1DumpRefused::setForTest(dir.knob(":10").c_str());
            const Entry33c8Rig::End native = rig.run(0x33c8u, 0x33c8u, &Entry33c8Rig::entry);
            t.IsTrue(native.nativeRan && native.nativeEnded, "66 06 08 40 42 is taken natively");
            rig.vi[5] = 1; // bit 2 clear: another bone pass, refused whole as skin_pass -- not a list shape
            const Entry33c8Rig::End skin = rig.run(0x33c8u, 0x33c8u, &Entry33c8Rig::entry, 64u);
            t.IsTrue(skin.nativeRan && !skin.nativeEnded, "the skin pass was refused");
            t.IsTrue(dir.bins().empty() && dir.indexLines().empty(), "nothing written for either");
        });

        tc.Run("dump refused: at most <count> files, <entrypc> narrows the capture, PS2X_VU1_DUMP_AFTER arms it", [](TestCase &t)
        {
            Entry33c8Rig rig;
            t.IsTrue(rig.load(), "fixture present");
            if (rig.code.empty())
                return;
            rig.makeLastBone();
            rig.setResumedList(kRefusedList);
            {
                DumpDir dir("cap");
                Vu1DumpRefused::setForTest(dir.knob(":2").c_str());
                for (int i = 0; i < 3; ++i)
                    rig.run(0x33c8u, 0x33c8u, &Entry33c8Rig::entry, 64u);
                t.Equals(dir.bins().size(), static_cast<size_t>(2), "three refusals, a count of 2: two files");
                t.Equals(dir.indexLines().size(), static_cast<size_t>(2), "and two index lines");
                t.Equals(Vu1DumpRefused::live().written(), 2, "the capture counts two");
            }
            {
                DumpDir dir("other_entry");
                Vu1DumpRefused::setForTest(dir.knob(":10:0x1b50").c_str());
                rig.run(0x33c8u, 0x33c8u, &Entry33c8Rig::entry, 64u);
                t.IsTrue(dir.bins().empty(), "narrowed to 0x1b50: a 0x33c8 refusal is not written");
            }
            {
                DumpDir dir("this_entry");
                Vu1DumpRefused::setForTest(dir.knob(":10:0x33c8").c_str());
                rig.run(0x33c8u, 0x33c8u, &Entry33c8Rig::entry, 64u);
                t.Equals(dir.bins().size(), static_cast<size_t>(1), "narrowed to 0x33c8: written");
            }
            {
                DumpDir dir("armed_later");
                Vu1DumpRefused::setForTest(dir.knob(":10").c_str(), 3600.0); // PS2X_VU1_DUMP_AFTER=3600
                rig.run(0x33c8u, 0x33c8u, &Entry33c8Rig::entry, 64u);
                t.IsTrue(dir.bins().empty(), "PS2X_VU1_DUMP_AFTER not yet reached: not written");
            }
        });
    });
}
