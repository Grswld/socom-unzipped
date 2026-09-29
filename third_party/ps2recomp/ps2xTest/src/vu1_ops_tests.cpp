// VU1 ops: the product-sum fast path (vu1ops::fmacProductSum4) against its slow classifier
// (vu1ops::fmacProductSum4Slow), the oracle. Sprint 17 F, research/81 candidate C1: a lane whose
// accumulator and product are both exact zeros used to fail the fast path's `pp != -acc` test
// (+0 == -0) and pay for the double-precision classifier; it now may take the fast path, with the
// slow path's value and flags bit for bit. The near shapes -- acc == -p non-zero, a product that
// underflows to zero, a denormal result -- must still go slow.
#include "MiniTest.h"
#include "ps2x/knobs.h"
#include "vu/ps2_vu1_ops.h"

#include <cfloat>
#include <cstdint>
#include <cstring>
#include <emmintrin.h>
#include <limits>
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
    });
}
