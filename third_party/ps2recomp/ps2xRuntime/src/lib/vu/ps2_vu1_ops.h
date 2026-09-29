// Inline VU1 instruction building blocks shared by the interpreter (ps2_vu1_upper.cpp) and the
// generated known-program code (src/lib/vu/generated/vu1_<hash>.cpp, emitted by vu1_replay --gen).
// Everything here follows the fast path's semantics (runFast / execUpper / execLower) exactly; the
// generated code is only a static unrolling of those with constant register indices.
#ifndef PS2_VU1_OPS_H
#define PS2_VU1_OPS_H

#include "runtime/ps2_vu1.h"
#include "ps2_vu1_detail.h"
#include "ps2x/knobs.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <emmintrin.h>
#include <limits>

namespace vu1ops
{
    constexpr float kFltMax = std::numeric_limits<float>::max();
    constexpr double kFltMaxD = static_cast<double>(std::numeric_limits<float>::max());
    constexpr double kFltMinD = static_cast<double>(std::numeric_limits<float>::min());
    constexpr long double kFltMaxL = static_cast<long double>(std::numeric_limits<float>::max());

    inline uint32_t bitsOf(float value)
    {
        uint32_t bits = 0u;
        std::memcpy(&bits, &value, sizeof(bits));
        return bits;
    }

    // Lane order: SSE lane 0 = x .. lane 3 = w. The VU flag registers number the lanes the other way
    // round (bit 0 = w .. bit 3 = x, laneForComponent), so movemask results go through kRev4.
    constexpr uint8_t kRev4[16] = {0x0, 0x8, 0x4, 0xC, 0x2, 0xA, 0x6, 0xE, 0x1, 0x9, 0x5, 0xD, 0x3, 0xB, 0x7, 0xF};

    // movemask bit i (lane i) -> per-lane all-ones mask.
    alignas(16) constexpr int32_t kLaneMaskTable[16][4] = {
        {0, 0, 0, 0}, {-1, 0, 0, 0}, {0, -1, 0, 0}, {-1, -1, 0, 0},
        {0, 0, -1, 0}, {-1, 0, -1, 0}, {0, -1, -1, 0}, {-1, -1, -1, 0},
        {0, 0, 0, -1}, {-1, 0, 0, -1}, {0, -1, 0, -1}, {-1, -1, 0, -1},
        {0, 0, -1, -1}, {-1, 0, -1, -1}, {0, -1, -1, -1}, {-1, -1, -1, -1}};

    __attribute__((always_inline)) inline __m128i movemaskToLanes(uint32_t mask4)
    {
        return _mm_load_si128(reinterpret_cast<const __m128i *>(kLaneMaskTable[mask4 & 0xFu]));
    }

    // dest field (bit 3 = x .. bit 0 = w) -> per-lane all-ones mask.
    __attribute__((always_inline)) inline __m128i destMask4(uint8_t dest)
    {
        return movemaskToLanes(kRev4[dest & 0xFu]);
    }

    // normalizeOperand on four lanes: denormals -> +/-0, infinities/NaNs -> +/-FLT_MAX.
    __attribute__((always_inline)) inline __m128 normalize4(__m128 value)
    {
        const __m128i bits = _mm_castps_si128(value);
        const __m128i exponent = _mm_and_si128(bits, _mm_set1_epi32(0x7F800000));
        const __m128i zeroExp = _mm_cmpeq_epi32(exponent, _mm_setzero_si128());
        const __m128i maxExp = _mm_cmpeq_epi32(exponent, _mm_set1_epi32(0x7F800000));
        const __m128i sign = _mm_and_si128(bits, _mm_set1_epi32(static_cast<int>(0x80000000u)));
        __m128i out = _mm_andnot_si128(_mm_or_si128(zeroExp, maxExp), bits);
        out = _mm_or_si128(out, _mm_and_si128(sign, zeroExp));
        out = _mm_or_si128(out, _mm_and_si128(_mm_or_si128(sign, _mm_set1_epi32(0x7F7FFFFF)), maxExp));
        return _mm_castsi128_ps(out);
    }

    __attribute__((always_inline)) inline __m128 broadcastLane(__m128 v, uint32_t lane)
    {
        switch (lane & 3u)
        {
        case 0: return _mm_shuffle_ps(v, v, _MM_SHUFFLE(0, 0, 0, 0));
        case 1: return _mm_shuffle_ps(v, v, _MM_SHUFFLE(1, 1, 1, 1));
        case 2: return _mm_shuffle_ps(v, v, _MM_SHUFFLE(2, 2, 2, 2));
        default: return _mm_shuffle_ps(v, v, _MM_SHUFFLE(3, 3, 3, 3));
        }
    }

    // Two double-lane masks (lanes 0,1 and 2,3) -> one four-lane 32-bit mask.
    __attribute__((always_inline)) inline __m128i packMask(__m128d lo, __m128d hi)
    {
        return _mm_castps_si128(_mm_shuffle_ps(_mm_castpd_ps(lo), _mm_castpd_ps(hi), _MM_SHUFFLE(2, 0, 2, 0)));
    }

    struct FmacResult
    {
        __m128 value;     // lanes to store (only dest lanes meaningful)
        uint32_t mac;     // MAC register bits for the dest lanes
        uint32_t status;  // Z/S/U/O presence (bits 0..3)
        uint32_t sticky;  // product flags folded into the sticky bits (product-sum ops)
    };

    // dest field -> 16-byte pattern selecting, in each 4-byte flag group of the packed Z/S/U/O
    // masks (lanes reversed to w,z,y,x = bits 0..3), the lanes of the dest field.
    alignas(16) constexpr int8_t kDestPattern16[16][16] = {
#define VU1_DP(d) {(d) & 1 ? -1 : 0, (d) & 2 ? -1 : 0, (d) & 4 ? -1 : 0, (d) & 8 ? -1 : 0, \
                   (d) & 1 ? -1 : 0, (d) & 2 ? -1 : 0, (d) & 4 ? -1 : 0, (d) & 8 ? -1 : 0, \
                   (d) & 1 ? -1 : 0, (d) & 2 ? -1 : 0, (d) & 4 ? -1 : 0, (d) & 8 ? -1 : 0, \
                   (d) & 1 ? -1 : 0, (d) & 2 ? -1 : 0, (d) & 4 ? -1 : 0, (d) & 8 ? -1 : 0}
        VU1_DP(0), VU1_DP(1), VU1_DP(2), VU1_DP(3), VU1_DP(4), VU1_DP(5), VU1_DP(6), VU1_DP(7),
        VU1_DP(8), VU1_DP(9), VU1_DP(10), VU1_DP(11), VU1_DP(12), VU1_DP(13), VU1_DP(14), VU1_DP(15)
#undef VU1_DP
    };

    // MAC register bits (Z nibble | S << 4 | U << 8 | O << 12, bit 0 of each nibble = w lane) and the
    // status presence bits from the four lane masks, restricted to the dest lanes.
    __attribute__((always_inline)) inline void finishFlags(FmacResult &out, __m128i zeroM, __m128i signM, __m128i underM, __m128i overM, uint8_t dest)
    {
        const __m128i zr = _mm_shuffle_epi32(zeroM, _MM_SHUFFLE(0, 1, 2, 3));
        const __m128i sr = _mm_shuffle_epi32(signM, _MM_SHUFFLE(0, 1, 2, 3));
        const __m128i ur = _mm_shuffle_epi32(underM, _MM_SHUFFLE(0, 1, 2, 3));
        const __m128i orr = _mm_shuffle_epi32(overM, _MM_SHUFFLE(0, 1, 2, 3));
        const __m128i packed = _mm_packs_epi16(_mm_packs_epi32(zr, sr), _mm_packs_epi32(ur, orr));
        const __m128i pattern = _mm_load_si128(reinterpret_cast<const __m128i *>(kDestPattern16[dest & 0xFu]));
        const uint32_t mac = static_cast<uint32_t>(_mm_movemask_epi8(_mm_and_si128(packed, pattern)));
        out.mac = mac;
        uint32_t t = mac | (mac >> 1) | (mac >> 2) | (mac >> 3);
        t &= 0x1111u;
        out.status = (t | (t >> 3) | (t >> 6) | (t >> 9)) & 0xFu;
    }

    enum FmacKind
    {
        FmacAdd,
        FmacSub,
        FmacMul
    };

    // |r| == FLT_MAX lanes: the chop-rounded long double result decides the overflow flag.
    template <FmacKind Kind>
    __attribute__((noinline)) inline uint32_t singleOverflowLanes(__m128 a, __m128 b, uint32_t atMax)
    {
        alignas(16) float av[4], bv[4];
        _mm_store_ps(av, a);
        _mm_store_ps(bv, b);
        uint32_t overLanes = 0u;
        for (uint32_t lane = 0; lane < 4u; ++lane)
        {
            if ((atMax & (1u << lane)) == 0u)
                continue;
            long double exact;
            if (Kind == FmacAdd)
                exact = static_cast<long double>(av[lane]) + static_cast<long double>(bv[lane]);
            else if (Kind == FmacSub)
                exact = static_cast<long double>(av[lane]) - static_cast<long double>(bv[lane]);
            else
                exact = static_cast<long double>(av[lane]) * static_cast<long double>(bv[lane]);
            if (std::fabs(exact) > kFltMaxL)
                overLanes |= 1u << lane;
        }
        return overLanes;
    }

    template <bool Sub>
    __attribute__((noinline)) inline uint32_t productSumOverflowLanes(__m128 acc, __m128 a, __m128 b, uint32_t atMax)
    {
        alignas(16) float av[4], bv[4], cv[4];
        _mm_store_ps(av, a);
        _mm_store_ps(bv, b);
        _mm_store_ps(cv, acc);
        uint32_t overLanes = 0u;
        for (uint32_t lane = 0; lane < 4u; ++lane)
        {
            if ((atMax & (1u << lane)) == 0u)
                continue;
            const long double exact = Sub
                                          ? static_cast<long double>(cv[lane]) - static_cast<long double>(av[lane]) * static_cast<long double>(bv[lane])
                                          : static_cast<long double>(cv[lane]) + static_cast<long double>(av[lane]) * static_cast<long double>(bv[lane]);
            if (std::fabs(exact) > kFltMaxL)
                overLanes |= 1u << lane;
        }
        return overLanes;
    }

    // FMAC lanes of a single add, subtract or multiply, in chop rounding (the run() loop sets
    // FE_TOWARDZERO): the stored floats and the Z/S/U/O lane flags.
    //
    // Bit-identical to classifying the long double result (normalizeFmacExactResult over
    // calculateFmacExactResult) without computing it, because a single chop-rounded float op has
    // |r| <= |exact| < |r| + ulp(r):
    //   r == 0      : add/sub only when a == -b (the exact sum of two floats is otherwise >= 2^-149 and
    //                 representable as a denormal); mul when an operand is zero, or when the exact
    //                 product is below the denormal range (underflow, U|Z).
    //   r denormal  : 2^-149 <= |exact| < FLT_MIN, underflow (U|Z), the stored value is +/-0.
    //   |r| == FLT_MAX: the exact result is >= FLT_MAX; only here the long double decides (overflow
    //                 when its chop-rounded value exceeds FLT_MAX, exactly what the old path tested).
    //   otherwise   : FLT_MIN <= |r| <= |exact| < FLT_MAX, no flag but the sign.
    // The sign of r equals the sign of the exact result in every case (chop keeps the sign; an exact
    // zero sum is +0 unless both terms are -0, in float and long double alike).
    template <FmacKind Kind>
    __attribute__((always_inline)) inline void fmacSingle4(__m128 a, __m128 b, uint8_t dest, FmacResult &out)
    {
        const __m128i destM = destMask4(dest);
        __m128 r;
        if (Kind == FmacAdd)
            r = _mm_add_ps(a, b);
        else if (Kind == FmacSub)
            r = _mm_sub_ps(a, b);
        else
            r = _mm_mul_ps(a, b);
        const __m128i bits = _mm_castps_si128(r);
        const __m128i signBit = _mm_set1_epi32(static_cast<int>(0x80000000u));
        const __m128i magnitude = _mm_and_si128(bits, _mm_set1_epi32(0x7FFFFFFF));
        const __m128i signM = _mm_srai_epi32(bits, 31);
        const __m128i zeroM = _mm_cmpeq_epi32(magnitude, _mm_setzero_si128());
        const __m128i denormM = _mm_andnot_si128(zeroM, _mm_cmplt_epi32(magnitude, _mm_set1_epi32(0x00800000)));
        const __m128i maxM = _mm_cmpeq_epi32(magnitude, _mm_set1_epi32(0x7F7FFFFF));
        __m128i underM = denormM;
        if (Kind == FmacMul)
        {
            const __m128i operandsNonzero = _mm_castps_si128(_mm_and_ps(_mm_cmpneq_ps(a, _mm_setzero_ps()), _mm_cmpneq_ps(b, _mm_setzero_ps())));
            underM = _mm_or_si128(underM, _mm_and_si128(zeroM, operandsNonzero));
        }
        // Denormal results store as +/-0.
        __m128i value = _mm_or_si128(_mm_andnot_si128(denormM, bits), _mm_and_si128(denormM, _mm_and_si128(bits, signBit)));
        __m128i overM = _mm_setzero_si128();
        const uint32_t atMax = static_cast<uint32_t>(_mm_movemask_ps(_mm_castsi128_ps(_mm_and_si128(maxM, destM))));
        if (__builtin_expect(atMax != 0u, 0))
            overM = movemaskToLanes(singleOverflowLanes<Kind>(a, b, atMax));
        out.value = _mm_castsi128_ps(value);
        out.sticky = 0u;
        finishFlags(out, _mm_or_si128(zeroM, denormM), signM, underM, overM, dest);
    }

    // Product-sum lanes (acc +/- a*b). The float result keeps the old two-rounding form; the flags
    // come from the double sum: the product of two floats is exact in double, and a chop-rounded
    // double sum falls in the same class (zero / underflow / normal / overflow) as the chop-rounded
    // long double sum except when it lands exactly on FLT_MAX, where the long double decides. Every
    // product condition accumulates into the sticky flags (calculateFmacProductSticky).
    template <bool Sub>
    __attribute__((noinline)) inline void fmacProductSum4Slow(__m128 acc, __m128 a, __m128 b, uint8_t dest, FmacResult &out)
    {
        const __m128i destM = destMask4(dest);
        const __m128 r = Sub ? _mm_sub_ps(acc, _mm_mul_ps(a, b)) : _mm_add_ps(acc, _mm_mul_ps(a, b));

        const __m128d aLo = _mm_cvtps_pd(a);
        const __m128d aHi = _mm_cvtps_pd(_mm_movehl_ps(a, a));
        const __m128d bLo = _mm_cvtps_pd(b);
        const __m128d bHi = _mm_cvtps_pd(_mm_movehl_ps(b, b));
        const __m128d pLo = _mm_mul_pd(aLo, bLo);
        const __m128d pHi = _mm_mul_pd(aHi, bHi);
        const __m128d accLo = _mm_cvtps_pd(acc);
        const __m128d accHi = _mm_cvtps_pd(_mm_movehl_ps(acc, acc));
        const __m128d sLo = Sub ? _mm_sub_pd(accLo, pLo) : _mm_add_pd(accLo, pLo);
        const __m128d sHi = Sub ? _mm_sub_pd(accHi, pHi) : _mm_add_pd(accHi, pHi);

        const __m128d absMask = _mm_castsi128_pd(_mm_set_epi32(0x7FFFFFFF, -1, 0x7FFFFFFF, -1));
        const __m128d fltMax = _mm_set1_pd(kFltMaxD);
        const __m128d fltMin = _mm_set1_pd(kFltMinD);
        const __m128d zero = _mm_setzero_pd();

        // Product sticky: Z / S / U / O of a*b.
        {
            const __m128d pAbsLo = _mm_and_pd(pLo, absMask);
            const __m128d pAbsHi = _mm_and_pd(pHi, absMask);
            const __m128i pZero = packMask(_mm_cmpeq_pd(pLo, zero), _mm_cmpeq_pd(pHi, zero));
            const __m128i pOver = packMask(_mm_cmpgt_pd(pAbsLo, fltMax), _mm_cmpgt_pd(pAbsHi, fltMax));
            const __m128i pUnder = _mm_andnot_si128(pZero, packMask(_mm_cmplt_pd(pAbsLo, fltMin), _mm_cmplt_pd(pAbsHi, fltMin)));
            const uint32_t pSign = static_cast<uint32_t>(_mm_movemask_pd(pLo)) | (static_cast<uint32_t>(_mm_movemask_pd(pHi)) << 2);
            const __m128i pSignM = movemaskToLanes(pSign);
            const uint32_t z = static_cast<uint32_t>(_mm_movemask_ps(_mm_castsi128_ps(_mm_and_si128(_mm_or_si128(pZero, pUnder), destM))));
            const uint32_t s = static_cast<uint32_t>(_mm_movemask_ps(_mm_castsi128_ps(_mm_and_si128(pSignM, destM))));
            const uint32_t u = static_cast<uint32_t>(_mm_movemask_ps(_mm_castsi128_ps(_mm_and_si128(pUnder, destM))));
            const uint32_t o = static_cast<uint32_t>(_mm_movemask_ps(_mm_castsi128_ps(_mm_and_si128(pOver, destM))));
            out.sticky = (z ? 1u : 0u) | (s ? 2u : 0u) | (u ? 4u : 0u) | (o ? 8u : 0u);
        }

        const __m128d sAbsLo = _mm_and_pd(sLo, absMask);
        const __m128d sAbsHi = _mm_and_pd(sHi, absMask);
        const __m128i zeroM = packMask(_mm_cmpeq_pd(sLo, zero), _mm_cmpeq_pd(sHi, zero));
        __m128i overM = packMask(_mm_cmpgt_pd(sAbsLo, fltMax), _mm_cmpgt_pd(sAbsHi, fltMax));
        const __m128i underM = _mm_andnot_si128(zeroM, packMask(_mm_cmplt_pd(sAbsLo, fltMin), _mm_cmplt_pd(sAbsHi, fltMin)));
        const __m128i atMaxM = packMask(_mm_cmpeq_pd(sAbsLo, fltMax), _mm_cmpeq_pd(sAbsHi, fltMax));
        const uint32_t signBits = static_cast<uint32_t>(_mm_movemask_pd(sLo)) | (static_cast<uint32_t>(_mm_movemask_pd(sHi)) << 2);
        const __m128i signM = movemaskToLanes(signBits);

        const uint32_t atMax = static_cast<uint32_t>(_mm_movemask_ps(_mm_castsi128_ps(_mm_and_si128(atMaxM, destM))));
        if (__builtin_expect(atMax != 0u, 0))
            overM = _mm_or_si128(overM, movemaskToLanes(productSumOverflowLanes<Sub>(acc, a, b, atMax)));

        // Stored value: +/-0 for zero and underflow, +/-FLT_MAX for overflow, else the float result.
        const __m128i signOnly = _mm_and_si128(signM, _mm_set1_epi32(static_cast<int>(0x80000000u)));
        const __m128i zeroOrUnder = _mm_or_si128(zeroM, underM);
        __m128i value = _mm_andnot_si128(_mm_or_si128(zeroOrUnder, overM), _mm_castps_si128(r));
        value = _mm_or_si128(value, _mm_and_si128(zeroOrUnder, signOnly));
        value = _mm_or_si128(value, _mm_and_si128(overM, _mm_or_si128(signOnly, _mm_set1_epi32(0x7F7FFFFF))));
        out.value = _mm_castsi128_ps(value);
        finishFlags(out, _mm_or_si128(zeroM, underM), signM, underM, overM, dest);
    }

    // Product-sum fast path. With p = chop(a*b) (float), pp = the term actually added (p, or -p for
    // MSUB), x = acc + pp (real) and r = chop(x) (the float result), the exact sum s = acc + PP
    // differs from x by |PP - pp| < ulp(p). For a dest lane the double/long double classification
    // (fmacProductSum4Slow) is provably "no flag but the sign, value r" when all of
    //   (1) pp != -acc          : s == 0 needs PP == -acc, i.e. pp == -acc with an exact product
    //                             (and the zero-acc / zero-product cases fail it too: +0 == -0;
    //                             under PS2X_VU1_FMAC_ZERO_FAST=1 productSumZeroLanes takes those),
    //   (2) exp(r) >= 2         : |r| >= 2*FLT_MIN, so |s| >= |x| - |r|/4 > FLT_MIN (no underflow),
    //   (3) exp(r) <= 253       : |r| < 2^127, so |s| <= |x| + |r|/4 < FLT_MAX (no overflow),
    //   (4) exp(r) + 21 >= exp(p): no catastrophic cancellation, |PP - pp| < ulp(p) <= |r|/4,
    // and the sign of s is the sign of x, which is the sign of r. The product's own sticky flags are
    // the single-multiply classification of p (fmacSingle4<FmacMul>), except |p| == FLT_MAX, which
    // (like any lane failing (1)-(4)) takes the slow path.
    //
    // The lanes (SSE order, bit i = lane i) passing (1)-(5) above.
    template <bool Sub>
    __attribute__((always_inline)) inline uint32_t productSumFastLanes(__m128 acc, __m128 a, __m128 b)
    {
        const __m128 p = _mm_mul_ps(a, b);
        const __m128 r = Sub ? _mm_sub_ps(acc, p) : _mm_add_ps(acc, p);
        const __m128i signBit = _mm_set1_epi32(static_cast<int>(0x80000000u));
        const __m128i pb = _mm_castps_si128(p);
        const __m128i rb = _mm_castps_si128(r);
        const __m128 pp = Sub ? _mm_castsi128_ps(_mm_xor_si128(pb, signBit)) : p;
        const __m128i er = _mm_and_si128(_mm_srli_epi32(rb, 23), _mm_set1_epi32(0xFF));
        const __m128i ep = _mm_and_si128(_mm_srli_epi32(pb, 23), _mm_set1_epi32(0xFF));
        const __m128i c1 = _mm_castps_si128(_mm_cmpneq_ps(pp, _mm_castsi128_ps(_mm_xor_si128(_mm_castps_si128(acc), signBit))));
        const __m128i c2 = _mm_cmpgt_epi32(er, _mm_set1_epi32(1));
        const __m128i c3 = _mm_cmplt_epi32(er, _mm_set1_epi32(254));
        const __m128i c4 = _mm_cmpgt_epi32(_mm_add_epi32(er, _mm_set1_epi32(22)), ep);
        const __m128i pMag = _mm_and_si128(pb, _mm_set1_epi32(0x7FFFFFFF));
        const __m128i c5 = _mm_xor_si128(_mm_cmpeq_epi32(pMag, _mm_set1_epi32(0x7F7FFFFF)), _mm_set1_epi32(-1));
        const __m128i fast = _mm_and_si128(_mm_and_si128(_mm_and_si128(c1, c2), _mm_and_si128(c3, c4)), c5);
        return static_cast<uint32_t>(_mm_movemask_ps(_mm_castsi128_ps(fast)));
    }

    // S17 F C1 (research/81): the exact-zero lanes of a product-sum. acc == +/-0 and a or b == +/-0
    // (by bit pattern, whatever MXCSR.DAZ says) and p == +/-0 (so not Inf/NaN * 0): the product and
    // the sum are exact, and fmacProductSum4Slow's answer is fixed -- the double sum is a zero whose
    // sign is IEEE's zero-sum rule, the same rule the float r = acc +/- p obeys under the same
    // MXCSR, so value r, MAC Z plus S when r is -0, no U/O; the product sticky Z plus p's sign (the
    // double product's sign is the float one's). They fail (1) above (+0 == -0 under cmpneq) and
    // (2) (exp(r) = 0). A product that chops to zero from non-zero operands is NOT one of these
    // (the exact sum underflows: U|Z), nor is a denormal accumulator.
    __attribute__((always_inline)) inline uint32_t productSumZeroLanes(__m128 acc, __m128 a, __m128 b)
    {
        const __m128i magMask = _mm_set1_epi32(0x7FFFFFFF);
        const __m128i zero = _mm_setzero_si128();
        const __m128i accZero = _mm_cmpeq_epi32(_mm_and_si128(_mm_castps_si128(acc), magMask), zero);
        const __m128i aZero = _mm_cmpeq_epi32(_mm_and_si128(_mm_castps_si128(a), magMask), zero);
        const __m128i bZero = _mm_cmpeq_epi32(_mm_and_si128(_mm_castps_si128(b), magMask), zero);
        const __m128i pZero = _mm_cmpeq_epi32(_mm_and_si128(_mm_castps_si128(_mm_mul_ps(a, b)), magMask), zero);
        const __m128i lanes = _mm_and_si128(_mm_and_si128(accZero, pZero), _mm_or_si128(aZero, bZero));
        return static_cast<uint32_t>(_mm_movemask_ps(_mm_castsi128_ps(lanes)));
    }

    // Who decides whether the exact-zero lanes take the fast path: the knob (the runtime), or a
    // fixed answer (the tests, which run both against the slow classifier).
    enum class ZeroLanes : uint8_t
    {
        Knob,
        Slow,
        Fast
    };

    // PS2X_VU1_FMAC_ZERO_FAST (Dev, default 1 since R337 adopted C1): 1 lets the exact-zero lanes take
    // the fast path; 0 (developer mode only) is the old slow path. The default is the registry row's,
    // so a stranger (the knob hidden) runs the adopted path. Read once, on the first product-sum that
    // fails the fast test, so after the process set developer mode.
    inline bool fmacZeroFastKnob()
    {
        static const bool s_on = ps2x::knobs::flagValue(ps2x::knobOrDefault("PS2X_VU1_FMAC_ZERO_FAST"), false);
        return s_on;
    }

    // With the knob on: product-sums that failed the fast test (refused) and, of those, the ones
    // whose failing dest lanes were all exact-zero lanes (rescued) -- research/81's unmeasured share.
    // Plain counters (VU1 runs on one thread at a time); vu1_replay prints them.
    struct ProductSumZeroCounts
    {
        uint64_t refused;
        uint64_t rescued;
    };
    inline ProductSumZeroCounts &productSumZeroCounts()
    {
        static ProductSumZeroCounts s_counts{0u, 0u};
        return s_counts;
    }

    // The lanes fmacProductSum4<Sub, Zero> computes without the slow classifier.
    template <bool Sub, ZeroLanes Zero>
    __attribute__((always_inline)) inline uint32_t productSumPathLanes(__m128 acc, __m128 a, __m128 b)
    {
        return productSumFastLanes<Sub>(acc, a, b) | (Zero == ZeroLanes::Fast ? productSumZeroLanes(acc, a, b) : 0u);
    }

    template <bool Sub, ZeroLanes Zero = ZeroLanes::Knob>
    __attribute__((always_inline)) inline void fmacProductSum4(__m128 acc, __m128 a, __m128 b, uint8_t dest, FmacResult &out)
    {
        const __m128 p = _mm_mul_ps(a, b);
        const __m128 r = Sub ? _mm_sub_ps(acc, p) : _mm_add_ps(acc, p);
        const __m128i pb = _mm_castps_si128(p);
        const __m128i pMag = _mm_and_si128(pb, _mm_set1_epi32(0x7FFFFFFF));
        const uint32_t destBits = kRev4[dest & 0xFu];
        const uint32_t fastBits = productSumFastLanes<Sub>(acc, a, b);
        uint32_t zeroBits = 0u;   // dest lanes computed here as exact zeros (C1)
        if (__builtin_expect((fastBits & destBits) != destBits, 0))
        {
            const bool zeroFast = Zero == ZeroLanes::Fast || (Zero == ZeroLanes::Knob && fmacZeroFastKnob());
            if (!zeroFast)
            {
                fmacProductSum4Slow<Sub>(acc, a, b, dest, out);
                return;
            }
            zeroBits = productSumZeroLanes(acc, a, b) & destBits;
            if (Zero == ZeroLanes::Knob)
                ++productSumZeroCounts().refused;
            if (((fastBits | zeroBits) & destBits) != destBits)
            {
                fmacProductSum4Slow<Sub>(acc, a, b, dest, out);
                return;
            }
            if (Zero == ZeroLanes::Knob)
                ++productSumZeroCounts().rescued;
        }
        // Product sticky: single-multiply classification of p.
        const __m128i pZero = _mm_cmpeq_epi32(pMag, _mm_setzero_si128());
        const __m128i pDenorm = _mm_andnot_si128(pZero, _mm_cmplt_epi32(pMag, _mm_set1_epi32(0x00800000)));
        const __m128i operandsNonzero = _mm_castps_si128(_mm_and_ps(_mm_cmpneq_ps(a, _mm_setzero_ps()), _mm_cmpneq_ps(b, _mm_setzero_ps())));
        const __m128i pUnder = _mm_or_si128(pDenorm, _mm_and_si128(pZero, operandsNonzero));
        const uint32_t pz = static_cast<uint32_t>(_mm_movemask_ps(_mm_castsi128_ps(_mm_or_si128(pZero, pDenorm)))) & destBits;
        const uint32_t ps = static_cast<uint32_t>(_mm_movemask_ps(p)) & destBits;
        const uint32_t pu = static_cast<uint32_t>(_mm_movemask_ps(_mm_castsi128_ps(pUnder))) & destBits;
        out.sticky = (pz ? 1u : 0u) | (ps ? 2u : 0u) | (pu ? 4u : 0u);
        out.value = r;
        const uint32_t sr = static_cast<uint32_t>(_mm_movemask_ps(r)) & destBits;
        out.mac = (kRev4[sr] << 4) | kRev4[zeroBits];
        out.status = (sr ? 2u : 0u) | (zeroBits ? 1u : 0u);
    }

    enum ArithKind : uint8_t
    {
        ArithNone,
        ArithAdd,
        ArithSub,
        ArithMadd,
        ArithMsub,
        ArithMul
    };

    // Full arithmetic FMAC op on prepared operands: value lanes + flags (mac/status/sticky) with the
    // OPMULA/OPMSUB w-lane rule applied. `first`/`second` are the normalized (and, for opmul,
    // permuted) operands; `acc` the normalized accumulator (product-sum only).
    template <ArithKind Kind, bool Opmul>
    __attribute__((always_inline)) inline void fmacArith(__m128 first, __m128 second, __m128 acc, uint8_t dest, FmacResult &out)
    {
        if (Kind == ArithAdd)
            fmacSingle4<FmacAdd>(first, second, dest, out);
        else if (Kind == ArithSub)
            fmacSingle4<FmacSub>(first, second, dest, out);
        else if (Kind == ArithMul)
            fmacSingle4<FmacMul>(first, second, dest, out);
        else if (Kind == ArithMadd)
            fmacProductSum4<false>(acc, first, second, dest, out);
        else
            fmacProductSum4<true>(acc, first, second, dest, out);
        if (Opmul && (dest & 0x1u) != 0u)
        {
            // w lane: exact zero (Z flag only, +0 stored).
            out.mac = (out.mac & ~0x1111u) | 0x0001u;
            const uint32_t xyzMac = out.mac & 0xEEEEu;
            out.status = 1u | (((xyzMac >> 4) & 0xFu) ? 2u : 0u) | (((xyzMac >> 8) & 0xFu) ? 4u : 0u) | (((xyzMac >> 12) & 0xFu) ? 8u : 0u);
            out.value = _mm_castsi128_ps(_mm_and_si128(_mm_castps_si128(out.value), _mm_set_epi32(0, -1, -1, -1)));
        }
    }

    // Masked 16-byte register store (dest lanes only).
    __attribute__((always_inline)) inline void storeLanes(float *target, __m128 value, uint8_t dest)
    {
        const __m128i destM = destMask4(dest);
        const __m128i old = _mm_castps_si128(_mm_loadu_ps(target));
        const __m128i merged = _mm_or_si128(_mm_andnot_si128(destM, old), _mm_and_si128(destM, _mm_castps_si128(value)));
        _mm_storeu_ps(target, _mm_castsi128_ps(merged));
    }
}

// Static-parameter building blocks for the generated known-program code. `friend struct Vu1Gen` in
// VU1Interpreter gives them the interpreter's private state; every helper mirrors one piece of
// runFast()/execUpper()/execLower(). The VF register file is passed as `vf`: the generated
// function keeps a local copy (loaded at entry, written back at every exit and around the
// interpreter fallbacks) so the compiler can keep hot registers in xmm registers across pairs.
struct Vu1Gen
{
    using VU = VU1Interpreter;
    enum FmacSrc : uint8_t
    {
        SrcVt,
        SrcBc,
        SrcQ,
        SrcI
    };

    // Arithmetic upper op: computes the result lanes and pushes the flag entry (issue cycle = the
    // current cycle, like execUpper); the caller stores the value after the lower op ran.
    // NormS / NormT: the generator proved every lane read of vs / vt already normalized (written by an
    // FMAC-family result), so normalize4 is the identity and is skipped. ACC only ever holds FMAC
    // results (reset() zeroes it), Q/P/I are normalized when written: never normalized here.
    template <vu1ops::ArithKind Kind, FmacSrc Src, uint32_t Lane, uint8_t Dest, uint8_t Fs, uint8_t Ft, bool Opmul, bool NormS = true, bool NormT = true>
    __attribute__((always_inline)) static inline __m128 fmac(VU &vu, float (*vf)[4], __m128 accIn)
    {
        using namespace vu1ops;
        __m128 first = _mm_loadu_ps(vf[Fs]);
        if (NormS)
            first = normalize4(first);
        __m128 second;
        if (Opmul)
        {
            __m128 vt = _mm_loadu_ps(vf[Ft]);
            if (NormT)
                vt = normalize4(vt);
            second = _mm_shuffle_ps(vt, vt, _MM_SHUFFLE(3, 1, 0, 2));
            first = _mm_shuffle_ps(first, first, _MM_SHUFFLE(3, 0, 2, 1));
        }
        else if (Src == SrcVt || Src == SrcBc)
        {
            __m128 vt = _mm_loadu_ps(vf[Ft]);
            if (NormT)
                vt = normalize4(vt);
            second = Src == SrcVt ? vt : broadcastLane(vt, Lane);
        }
        else if (Src == SrcQ)
            second = _mm_set1_ps(vu.m_state.q);
        else
            second = _mm_set1_ps(vu.m_state.i);
        const __m128 acc = accIn;
        FmacResult out;
        fmacArith<Kind, Opmul>(first, second, acc, Dest, out);
        if (Dest != 0u)
            vu.pushFmacFlags(out.mac, out.status, out.sticky);
        return out.value;
    }

    // Non-arithmetic uppers (execUpper's scalar cases), result returned for the deferred store.
    enum MinMaxSrc : uint8_t
    {
        MmVt,
        MmBc,
        MmI
    };
    template <bool IsMax, MinMaxSrc Src, uint32_t Lane, uint8_t Fs, uint8_t Ft>
    __attribute__((always_inline)) static inline __m128 minmax(VU &vu, float (*vf)[4])
    {
        using namespace vu1ops;
        const __m128 vs = normalize4(_mm_loadu_ps(vf[Fs]));
        __m128 other;
        if (Src == MmVt)
            other = normalize4(_mm_loadu_ps(vf[Ft]));
        else if (Src == MmBc)
            other = broadcastLane(normalize4(_mm_loadu_ps(vf[Ft])), Lane);
        else
            other = _mm_set1_ps(VU::normalizeOperand(vu.m_state.i));
        // (vs > other) ? vs : other  /  (vs < other) ? vs : other, lane-wise (no NaNs after normalize)
        const __m128 pick = IsMax ? _mm_cmpgt_ps(vs, other) : _mm_cmplt_ps(vs, other);
        return _mm_or_ps(_mm_and_ps(pick, vs), _mm_andnot_ps(pick, other));
    }

    template <uint32_t Shift, uint8_t Fs>
    __attribute__((always_inline)) static inline __m128 itof(VU &vu, float (*vf)[4])
    {
        alignas(16) float r[4];
        for (int c = 0; c < 4; ++c)
        {
            int32_t iv;
            std::memcpy(&iv, &vf[Fs][c], 4);
            r[c] = Shift == 0u ? static_cast<float>(iv) : static_cast<float>(iv) / static_cast<float>(1u << Shift);
        }
        return _mm_load_ps(r);
    }

    static inline int32_t floatToInt(float value, float scale)
    {
        const double scaled = static_cast<double>(value) * static_cast<double>(scale);
        if (scaled >= static_cast<double>(std::numeric_limits<int32_t>::max()))
            return std::numeric_limits<int32_t>::max();
        if (scaled <= static_cast<double>(std::numeric_limits<int32_t>::min()))
            return std::numeric_limits<int32_t>::min();
        return static_cast<int32_t>(scaled);
    }

    template <uint32_t Shift, uint8_t Fs>
    __attribute__((always_inline)) static inline __m128 ftoi(VU &vu, float (*vf)[4])
    {
        alignas(16) float vs[4];
        _mm_store_ps(vs, vu1ops::normalize4(_mm_loadu_ps(vf[Fs])));
        alignas(16) int32_t r[4];
        for (int c = 0; c < 4; ++c)
            r[c] = floatToInt(vs[c], static_cast<float>(1u << Shift));
        return _mm_castsi128_ps(_mm_load_si128(reinterpret_cast<const __m128i *>(r)));
    }

    template <uint8_t Fs>
    __attribute__((always_inline)) static inline __m128 absVf(VU &vu, float (*vf)[4])
    {
        const __m128 vs = vu1ops::normalize4(_mm_loadu_ps(vf[Fs]));
        return _mm_and_ps(vs, _mm_castsi128_ps(_mm_set1_epi32(0x7FFFFFFF)));
    }

    template <uint8_t Fs, uint8_t Ft>
    __attribute__((always_inline)) static inline void clip(VU &vu, float (*vf)[4])
    {
        uint32_t wBits = 0u;
        std::memcpy(&wBits, &vf[Ft][3], sizeof(wBits));
        const int32_t limit = (wBits & 0x7F800000u) != 0u ? static_cast<int32_t>(wBits & 0x7FFFFFFFu) : 0x007FFFFF;
        uint32_t flags = 0u;
        for (uint32_t c = 0; c < 3u; ++c)
        {
            uint32_t bits = 0u;
            std::memcpy(&bits, &vf[Fs][c], sizeof(bits));
            int32_t pos = 0, neg = 0;
            std::memcpy(&pos, &bits, 4);
            const uint32_t nb = bits ^ 0x80000000u;
            std::memcpy(&neg, &nb, 4);
            if (pos > limit)
                flags |= 1u << (2u * c);
            if (neg > limit)
                flags |= 2u << (2u * c);
        }
        vu.queueClip(flags);
    }

    template <uint8_t Reg, uint8_t Dest>
    static inline void storeVf(VU &vu, float (*vf)[4], __m128 value)
    {
        if (Reg != 0u && Dest != 0u)
            vu1ops::storeLanes(vf[Reg], value, Dest);
    }

    // ACC lives in a local of the generated function (synced to m_state.acc at hand-backs, at the
    // program end and around interpreter fallbacks).
    template <uint8_t Dest>
    __attribute__((always_inline)) static inline void storeAcc(__m128 &acc, __m128 value)
    {
        if (Dest == 0xFu)
            acc = value;
        else if (Dest != 0u)
        {
            const __m128i destM = vu1ops::destMask4(Dest);
            acc = _mm_castsi128_ps(_mm_or_si128(_mm_andnot_si128(destM, _mm_castps_si128(acc)), _mm_and_si128(destM, _mm_castps_si128(value))));
        }
    }

    // Ready-cycle bookkeeping (fastReadyCycle / the write marks in runFast).
    template <uint8_t Reg, uint8_t Lanes>
    static inline void readyVf(const VU &vu, const float (*vf)[4], uint64_t &ready)
    {
        const uint64_t *lanes = vu.m_vfReady[Reg].data();
        if (Lanes & 0x8u)
            ready = std::max(ready, lanes[0]);
        if (Lanes & 0x4u)
            ready = std::max(ready, lanes[1]);
        if (Lanes & 0x2u)
            ready = std::max(ready, lanes[2]);
        if (Lanes & 0x1u)
            ready = std::max(ready, lanes[3]);
    }

    template <uint8_t Reg>
    static inline void readyVi(const VU &vu, const float (*vf)[4], uint64_t &ready)
    {
        if (Reg != 0u)
            ready = std::max(ready, vu.m_viReady[Reg]);
    }

    template <uint8_t Reg, uint8_t Lanes, uint32_t Latency>
    static inline void markVf(VU &vu, float (*vf)[4])
    {
        if (Reg == 0u || Lanes == 0u)
            return;
        const uint64_t ready = vu.m_cycle + Latency;
        uint64_t *lanes = vu.m_vfReady[Reg].data();
        if (Lanes & 0x8u)
            lanes[0] = ready;
        if (Lanes & 0x4u)
            lanes[1] = ready;
        if (Lanes & 0x2u)
            lanes[2] = ready;
        if (Lanes & 0x1u)
            lanes[3] = ready;
    }

    template <uint8_t Reg, uint32_t Latency>
    static inline void markVi(VU &vu, float (*vf)[4])
    {
        if (Reg != 0u)
            vu.m_viReady[Reg] = vu.m_cycle + Latency;
    }

    // Branch-source VI read (one-instruction bypass of the previous pair's IALU write).
    template <uint8_t Reg>
    static inline int32_t branchVi(const VU &vu, const float (*vf)[4])
    {
        if (Reg == 0u)
            return 0;
        if (vu.m_viBranchBackupValid && vu.m_viBranchBackupReg == Reg)
            return vu.m_viBranchBackupValue;
        return vu.m_state.vi[Reg];
    }

    static inline int32_t vi(const VU &vu, const float (*vf)[4], uint8_t reg) { return reg == 0u ? 0 : vu.m_state.vi[reg]; }

    template <uint8_t Reg>
    static inline void setVi(VU &vu, float (*vf)[4], int32_t value)
    {
        if (Reg != 0u)
            vu.m_state.vi[Reg] = value;
    }

    static inline uint32_t dataAddress(int32_t qword)
    {
        return (static_cast<uint32_t>(qword) * 16u) & 0x3FFFu;
    }

    // VU data memory loads/stores (fast path: immediate).
    template <uint8_t Vf, uint8_t Dest>
    static inline void loadVf(VU &vu, float (*vf)[4], uint32_t addr)
    {
        if (Vf == 0u)
            return;
        float tmp[4];
        std::memcpy(tmp, vu.m_activeVuData + addr, 16);
        VU::applyDest(vf[Vf], tmp, Dest);
    }

    template <uint8_t Vf, uint8_t Dest>
    static inline void storeVfMem(VU &vu, float (*vf)[4], uint32_t addr)
    {
        uint32_t words[4];
        std::memcpy(words, vf[Vf], 16);
        vu.queueStore(addr, words, Dest);
    }

    template <uint8_t Dest>
    static inline int32_t loadWord(const VU &vu, const float (*vf)[4], uint32_t addr)
    {
        const int comp = (Dest & 0x8u) ? 0 : (Dest & 0x4u) ? 1 : (Dest & 0x2u) ? 2 : 3;
        uint32_t v;
        std::memcpy(&v, vu.m_activeVuData + addr + comp * 4, 4);
        return static_cast<int32_t>(static_cast<int16_t>(v & 0xFFFFu));
    }

    template <uint8_t Dest>
    static inline void storeWord(VU &vu, float (*vf)[4], uint32_t addr, int32_t value)
    {
        const uint32_t val = static_cast<uint32_t>(static_cast<uint16_t>(value & 0xFFFF));
        const uint32_t words[4] = {val, val, val, val};
        vu.queueStore(addr, words, Dest);
    }

    // FDIV unit (execLower's DIV/SQRT/RSQRT without the PS2X_FPU_TRAP diagnostics).
    template <uint8_t Fs, uint32_t Fsf, uint8_t Ft, uint32_t Ftf>
    static inline void div(VU &vu, float (*vf)[4])
    {
        const float num = VU::normalizeOperand(vf[Fs][Fsf]);
        const float den = VU::normalizeOperand(vf[Ft][Ftf]);
        uint32_t statusDi = 0u;
        float result;
        if (den == 0.0f)
        {
            statusDi = num == 0.0f ? 0x10u : 0x20u;
            result = std::signbit(num) != std::signbit(den) ? -std::numeric_limits<float>::max() : std::numeric_limits<float>::max();
        }
        else
            result = num / den;
        uint32_t ignored = 0u;
        result = vu.normalizeResult(result, ignored);
        vu.queueQ(result, 7u, statusDi);
    }
    template <uint8_t Ft, uint32_t Ftf>
    static inline void sqrtQ(VU &vu, float (*vf)[4])
    {
        const float val = VU::normalizeOperand(vf[Ft][Ftf]);
        vu.queueQ(std::sqrt(std::fabs(val)), 7u, val < 0.0f ? 0x10u : 0u);
    }
    template <uint8_t Fs, uint32_t Fsf, uint8_t Ft, uint32_t Ftf>
    static inline void rsqrt(VU &vu, float (*vf)[4])
    {
        const float num = VU::normalizeOperand(vf[Fs][Fsf]);
        const float radicand = VU::normalizeOperand(vf[Ft][Ftf]);
        const float den = std::sqrt(std::fabs(radicand));
        uint32_t statusDi = radicand < 0.0f ? 0x10u : 0u;
        float result = 0.0f;
        if (den != 0.0f)
            result = num / den;
        else
        {
            statusDi = num == 0.0f ? 0x10u : 0x20u;
            result = std::signbit(num) ? -std::numeric_limits<float>::max() : std::numeric_limits<float>::max();
        }
        uint32_t ignored = 0u;
        result = vu.normalizeResult(result, ignored);
        vu.queueQ(result, 13u, statusDi);
    }

    // Generic fallbacks: run one instruction through the interpreter's own switch.
    // The local register file is written back before and reloaded after the interpreter ran.
    static inline void execUpper(VU &vu, float (*vf)[4], uint32_t word)
    {
        std::memcpy(vu.m_state.vf, vf, sizeof(vu.m_state.vf));
        vu.execUpper(word);
        std::memcpy(vf, vu.m_state.vf, sizeof(vu.m_state.vf));
    }
    static inline void execLower(VU &vu, float (*vf)[4], uint32_t word)
    {
        std::memcpy(vu.m_state.vf, vf, sizeof(vu.m_state.vf));
        vu.execLower(word, vu.m_activeVuData, vu.m_activeVuDataSize, *vu.m_activeGs, vu.m_activeMemory, 0u);
        std::memcpy(vf, vu.m_state.vf, sizeof(vu.m_state.vf));
    }
};

#endif
