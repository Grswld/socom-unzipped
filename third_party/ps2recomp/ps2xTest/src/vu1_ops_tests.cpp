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

#include <cfloat>
#include <cstdint>
#include <cstring>
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

        tc.Run("PS2X_VU1_FMAC_ZERO_FAST is a Dev Flag defaulting to the old path", [](TestCase &t)
        {
            const ps2x::knobs::Entry *e = ps2x::knobs::find("PS2X_VU1_FMAC_ZERO_FAST");
            t.IsTrue(e != nullptr && e->cls == ps2x::knobs::Class::Dev && e->kind == ps2x::knobs::Kind::Flag &&
                         std::string(e->dflt) == "0",
                     "a Dev Flag, default 0 (R334: the A/B knob defaults to today's behaviour)");
            if (ps2x::knob("PS2X_VU1_FMAC_ZERO_FAST") == nullptr)
                t.IsFalse(vu1ops::fmacZeroFastKnob(), "unset: the zero lanes still take the slow classifier");
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
    });
}
