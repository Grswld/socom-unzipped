#include "runtime/ps2_vu1.h"
#include "ps2_vu1_detail.h"
#include "ps2_vu1_ops.h"
#include "ps2x/knobs.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#if defined(USE_SSE2NEON)
#include "sse2neon.h"
#else
#include <emmintrin.h>
#endif
#include <limits>

namespace
{
    int32_t vuFloatToInt(float value, float scale)
    {
        const double scaled = static_cast<double>(value) * static_cast<double>(scale);
        if (scaled >= static_cast<double>(std::numeric_limits<int32_t>::max()))
            return std::numeric_limits<int32_t>::max();
        if (scaled <= static_cast<double>(std::numeric_limits<int32_t>::min()))
            return std::numeric_limits<int32_t>::min();
        return static_cast<int32_t>(scaled);
    }

}

using namespace vu1ops;

// PS2X_VU1_FMAC_CHECK=1: recompute through the long double path (it reads the register file, so this
// runs before the write-back) and report any difference in stored value, MAC/status or sticky bits.
__attribute__((noinline)) void VU1Interpreter::checkFmac(uint32_t instr, uint8_t kindValue, bool opmul, __m128 first, __m128 second,
                                                          __m128 value, uint32_t mac, uint32_t status, uint32_t sticky)
{
    const ArithKind kind = static_cast<ArithKind>(kindValue);
    const uint8_t dest = DEST(instr);
    FmacResult out;
    out.value = value;
    out.mac = mac;
    out.status = status;
    out.sticky = sticky;
    alignas(16) float fa[4], sb[4], ca[4], nv[4];
    _mm_store_ps(fa, first);
    _mm_store_ps(sb, second);
    _mm_store_ps(nv, out.value);
    for (uint32_t c = 0; c < 4u; ++c)
        ca[c] = normalizeOperand(m_state.acc[c]);
    float checkResult[4] = {0.0f, 0.0f, 0.0f, 0.0f};
    for (uint32_t c = 0; c < 4u; ++c)
    {
        switch (kind)
        {
        case ArithAdd: checkResult[c] = fa[c] + sb[c]; break;
        case ArithSub: checkResult[c] = fa[c] - sb[c]; break;
        case ArithMul: checkResult[c] = fa[c] * sb[c]; break;
        case ArithMadd: checkResult[c] = ca[c] + fa[c] * sb[c]; break;
        case ArithMsub: checkResult[c] = ca[c] - fa[c] * sb[c]; break;
        default: break;
        }
    }
    if (opmul)
        checkResult[3] = 0.0f;
    uint8_t checkFlags[4]{};
    normalizeFmacResult(checkResult, dest, checkFlags);
    const uint32_t checkSticky = calculateFmacProductSticky(dest);
    uint32_t checkMac = 0u, checkStatus = 0u;
    for (uint32_t c = 0; c < 4u; ++c)
    {
        const uint32_t lane = 1u << (3u - c);
        if ((dest & lane) == 0u)
            continue;
        if (bitsOf(checkResult[c]) != bitsOf(nv[c]))
            std::fprintf(stderr, "[vu-fmac-check] pc=0x%x instr=%08x lane %u value: fast %08x exact %08x\n",
                         m_state.pc, instr, c, bitsOf(nv[c]), bitsOf(checkResult[c]));
        const uint32_t f = checkFlags[c];
        if (f & 1u) checkMac |= lane;
        if (f & 2u) checkMac |= lane << 4;
        if (f & 4u) checkMac |= lane << 8;
        if (f & 8u) checkMac |= lane << 12;
        checkStatus |= f;
    }
    if (checkMac != out.mac || checkStatus != out.status || checkSticky != out.sticky)
        std::fprintf(stderr, "[vu-fmac-check] pc=0x%x instr=%08x flags: fast mac=%03x st=%x sticky=%x exact mac=%03x st=%x sticky=%x\n",
                     m_state.pc, instr, out.mac, out.status, out.sticky, checkMac, checkStatus, checkSticky);
}

// ============================================================================
// Upper instructions (FMAC pipeline)
// ============================================================================
void VU1Interpreter::execUpper(uint32_t instr)
{
    m_currentUpperInstruction = instr;
    const uint8_t dest = DEST(instr);
    const uint8_t ft = FT(instr);
    const uint8_t fs = FS(instr);
    const uint8_t fd = FD(instr);
    const uint8_t op = instr & 0x3F;

    // PS2X_VU1_FMAC_CHECK=1: cross-check the SIMD lane classifier against the long double path.
    static const bool s_check = ps2x::knobOn("PS2X_VU1_FMAC_CHECK");

    const __m128 vsRaw = _mm_loadu_ps(m_state.vf[fs]);
    const __m128 vtRaw = _mm_loadu_ps(m_state.vf[ft]);
    const __m128 vs = normalize4(vsRaw);
    const __m128 vt = normalize4(vtRaw);

    ArithKind kind = ArithNone;
    __m128 second = _mm_setzero_ps();
    bool toAcc = false;
    bool opmul = false; // OPMULA / OPMSUB cross-product lane wiring

    // Non-arithmetic ops use scalar code on normalized lanes (copied out only on those paths).
    alignas(16) float vsA[4];
    alignas(16) float vtA[4];
    const auto scalarOperands = [&]()
    {
        _mm_store_ps(vsA, vs);
        _mm_store_ps(vtA, vt);
    };
    float *vd = m_state.vf[fd];
    float result[4] = {0.0f, 0.0f, 0.0f, 0.0f};

    if (op <= 0x2Fu)
    {
        switch (op)
        {
        case 0x00: case 0x01: case 0x02: case 0x03: kind = ArithAdd; second = broadcastLane(vt, op); break;   // ADDbc
        case 0x04: case 0x05: case 0x06: case 0x07: kind = ArithSub; second = broadcastLane(vt, op); break;   // SUBbc
        case 0x08: case 0x09: case 0x0A: case 0x0B: kind = ArithMadd; second = broadcastLane(vt, op); break;  // MADDbc
        case 0x0C: case 0x0D: case 0x0E: case 0x0F: kind = ArithMsub; second = broadcastLane(vt, op); break;  // MSUBbc
        case 0x10: case 0x11: case 0x12: case 0x13: // MAXbc
        {
            scalarOperands();
            const float bc = vtA[op & 3];
            for (int c = 0; c < 4; c++)
                result[c] = (vsA[c] > bc) ? vsA[c] : bc;
            applyDest(vd, result, dest);
            return;
        }
        case 0x14: case 0x15: case 0x16: case 0x17: // MINIbc
        {
            scalarOperands();
            const float bc = vtA[op & 3];
            for (int c = 0; c < 4; c++)
                result[c] = (vsA[c] < bc) ? vsA[c] : bc;
            applyDest(vd, result, dest);
            return;
        }
        case 0x18: case 0x19: case 0x1A: case 0x1B: kind = ArithMul; second = broadcastLane(vt, op); break;   // MULbc
        case 0x1C: kind = ArithMul; second = _mm_set1_ps(normalizeOperand(m_state.q)); break;                 // MULq
        case 0x1D: // MAXi
        {
            scalarOperands();
            const float i = normalizeOperand(m_state.i);
            for (int c = 0; c < 4; c++)
                result[c] = (vsA[c] > i) ? vsA[c] : i;
            applyDest(vd, result, dest);
            return;
        }
        case 0x1E: kind = ArithMul; second = _mm_set1_ps(normalizeOperand(m_state.i)); break;                 // MULi
        case 0x1F: // MINIi
        {
            scalarOperands();
            const float i = normalizeOperand(m_state.i);
            for (int c = 0; c < 4; c++)
                result[c] = (vsA[c] < i) ? vsA[c] : i;
            applyDest(vd, result, dest);
            return;
        }
        case 0x20: kind = ArithAdd; second = _mm_set1_ps(normalizeOperand(m_state.q)); break;   // ADDq
        case 0x21: kind = ArithMadd; second = _mm_set1_ps(normalizeOperand(m_state.q)); break;  // MADDq
        case 0x22: kind = ArithAdd; second = _mm_set1_ps(normalizeOperand(m_state.i)); break;   // ADDi
        case 0x23: kind = ArithMadd; second = _mm_set1_ps(normalizeOperand(m_state.i)); break;  // MADDi
        case 0x24: kind = ArithSub; second = _mm_set1_ps(normalizeOperand(m_state.q)); break;   // SUBq
        case 0x25: kind = ArithMsub; second = _mm_set1_ps(normalizeOperand(m_state.q)); break;  // MSUBq
        case 0x26: kind = ArithSub; second = _mm_set1_ps(normalizeOperand(m_state.i)); break;   // SUBi
        case 0x27: kind = ArithMsub; second = _mm_set1_ps(normalizeOperand(m_state.i)); break;  // MSUBi
        case 0x28: kind = ArithAdd; second = vt; break;   // ADD
        case 0x29: kind = ArithMadd; second = vt; break;  // MADD
        case 0x2A: kind = ArithMul; second = vt; break;   // MUL
        case 0x2B: // MAX
            scalarOperands();
            for (int c = 0; c < 4; c++)
                result[c] = (vsA[c] > vtA[c]) ? vsA[c] : vtA[c];
            applyDest(vd, result, dest);
            return;
        case 0x2C: kind = ArithSub; second = vt; break;   // SUB
        case 0x2D: kind = ArithMsub; second = vt; break;  // MSUB
        case 0x2E: kind = ArithMsub; opmul = true; break; // OPMSUB
        case 0x2F: // MINI
            scalarOperands();
            for (int c = 0; c < 4; c++)
                result[c] = (vsA[c] < vtA[c]) ? vsA[c] : vtA[c];
            applyDest(vd, result, dest);
            return;
        default:
            break;
        }
    }
    else if (op >= 0x3Cu)
    {
        // Upper special group (low op 0x3C..0x3F). Like lower1 special, the real selector is not just
        // bits 5:0: op = (instr & 0x3) | ((instr >> 4) & 0x7C). Several of these use FT as the
        // destination, not FD.
        const uint8_t specialOp = static_cast<uint8_t>((instr & 0x3u) | ((instr >> 4) & 0x7Cu));
        float *vtDest = m_state.vf[ft];
        toAcc = true;
        switch (specialOp)
        {
        case 0x00: case 0x01: case 0x02: case 0x03: kind = ArithAdd; second = broadcastLane(vt, specialOp); break;   // ADDAbc
        case 0x04: case 0x05: case 0x06: case 0x07: kind = ArithSub; second = broadcastLane(vt, specialOp); break;   // SUBAbc
        case 0x08: case 0x09: case 0x0A: case 0x0B: kind = ArithMadd; second = broadcastLane(vt, specialOp); break;  // MADDAbc
        case 0x0C: case 0x0D: case 0x0E: case 0x0F: kind = ArithMsub; second = broadcastLane(vt, specialOp); break;  // MSUBAbc
        case 0x10: // ITOF0
            for (int c = 0; c < 4; c++)
            {
                int32_t iv;
                std::memcpy(&iv, &m_state.vf[fs][c], 4);
                result[c] = static_cast<float>(iv);
            }
            applyDest(vtDest, result, dest);
            return;
        case 0x11: // ITOF4
            for (int c = 0; c < 4; c++)
            {
                int32_t iv;
                std::memcpy(&iv, &m_state.vf[fs][c], 4);
                result[c] = static_cast<float>(iv) / 16.0f;
            }
            applyDest(vtDest, result, dest);
            return;
        case 0x12: // ITOF12
            for (int c = 0; c < 4; c++)
            {
                int32_t iv;
                std::memcpy(&iv, &m_state.vf[fs][c], 4);
                result[c] = static_cast<float>(iv) / 4096.0f;
            }
            applyDest(vtDest, result, dest);
            return;
        case 0x13: // ITOF15
            for (int c = 0; c < 4; c++)
            {
                int32_t iv;
                std::memcpy(&iv, &m_state.vf[fs][c], 4);
                result[c] = static_cast<float>(iv) / 32768.0f;
            }
            applyDest(vtDest, result, dest);
            return;
        case 0x14: // FTOI0
            scalarOperands();
            for (int c = 0; c < 4; c++)
            {
                int32_t iv = vuFloatToInt(vsA[c], 1.0f);
                std::memcpy(&result[c], &iv, 4);
            }
            applyDest(vtDest, result, dest);
            return;
        case 0x15: // FTOI4
            scalarOperands();
            for (int c = 0; c < 4; c++)
            {
                int32_t iv = vuFloatToInt(vsA[c], 16.0f);
                std::memcpy(&result[c], &iv, 4);
            }
            applyDest(vtDest, result, dest);
            return;
        case 0x16: // FTOI12
            scalarOperands();
            for (int c = 0; c < 4; c++)
            {
                int32_t iv = vuFloatToInt(vsA[c], 4096.0f);
                std::memcpy(&result[c], &iv, 4);
            }
            applyDest(vtDest, result, dest);
            return;
        case 0x17: // FTOI15
            scalarOperands();
            for (int c = 0; c < 4; c++)
            {
                int32_t iv = vuFloatToInt(vsA[c], 32768.0f);
                std::memcpy(&result[c], &iv, 4);
            }
            applyDest(vtDest, result, dest);
            return;
        case 0x18: case 0x19: case 0x1A: case 0x1B: kind = ArithMul; second = broadcastLane(vt, specialOp); break;   // MULAbc
        case 0x1C: kind = ArithMul; second = _mm_set1_ps(normalizeOperand(m_state.q)); break;                        // MULAq
        case 0x1D: // ABS
            scalarOperands();
            for (int c = 0; c < 4; c++)
                result[c] = std::fabs(vsA[c]);
            applyDest(vtDest, result, dest);
            return;
        case 0x1E: kind = ArithMul; second = _mm_set1_ps(normalizeOperand(m_state.i)); break;                        // MULAi
        case 0x1F: // CLIP
        {
            uint32_t wBits = 0u;
            std::memcpy(&wBits, &m_state.vf[ft][3], sizeof(wBits));
            const int32_t limit = (wBits & 0x7F800000u) != 0u ? static_cast<int32_t>(wBits & 0x7FFFFFFFu) : 0x007FFFFF;

            const auto exceedsClipPlane = [limit](float value, uint32_t signMask)
            {
                uint32_t bits = 0u;
                std::memcpy(&bits, &value, sizeof(bits));
                bits ^= signMask;
                int32_t orderedBits = 0;
                std::memcpy(&orderedBits, &bits, sizeof(orderedBits));
                return orderedBits > limit;
            };

            uint32_t flags = 0u;
            if (exceedsClipPlane(m_state.vf[fs][0], 0x00000000u))
                flags |= 0x01u;
            if (exceedsClipPlane(m_state.vf[fs][0], 0x80000000u))
                flags |= 0x02u;
            if (exceedsClipPlane(m_state.vf[fs][1], 0x00000000u))
                flags |= 0x04u;
            if (exceedsClipPlane(m_state.vf[fs][1], 0x80000000u))
                flags |= 0x08u;
            if (exceedsClipPlane(m_state.vf[fs][2], 0x00000000u))
                flags |= 0x10u;
            if (exceedsClipPlane(m_state.vf[fs][2], 0x80000000u))
                flags |= 0x20u;
            queueClip(flags);
            return;
        }
        case 0x20: kind = ArithAdd; second = _mm_set1_ps(normalizeOperand(m_state.q)); break;   // ADDAq
        case 0x21: kind = ArithMadd; second = _mm_set1_ps(normalizeOperand(m_state.q)); break;  // MADDAq
        case 0x22: kind = ArithAdd; second = _mm_set1_ps(normalizeOperand(m_state.i)); break;   // ADDAi
        case 0x23: kind = ArithMadd; second = _mm_set1_ps(normalizeOperand(m_state.i)); break;  // MADDAi
        case 0x24: kind = ArithSub; second = _mm_set1_ps(normalizeOperand(m_state.q)); break;   // SUBAq
        case 0x25: kind = ArithMsub; second = _mm_set1_ps(normalizeOperand(m_state.q)); break;  // MSUBAq
        case 0x26: kind = ArithSub; second = _mm_set1_ps(normalizeOperand(m_state.i)); break;   // SUBAi
        case 0x27: kind = ArithMsub; second = _mm_set1_ps(normalizeOperand(m_state.i)); break;  // MSUBAi
        case 0x28: kind = ArithAdd; second = vt; break;   // ADDA
        case 0x29: kind = ArithMadd; second = vt; break;  // MADDA
        case 0x2A: kind = ArithMul; second = vt; break;   // MULA
        case 0x2C: kind = ArithSub; second = vt; break;   // SUBA
        case 0x2D: kind = ArithMsub; second = vt; break;  // MSUBA
        case 0x2E: kind = ArithMul; opmul = true; break; // OPMULA
        case 0x2F:
        case 0x30: // NOP
            return;
        default:
            reportReservedInstruction(true, instr);
            return;
        }
    }

    if (kind == ArithNone)
    {
        reportReservedInstruction(true, instr);
        return;
    }

    __m128 first = vs;
    if (opmul)
    {
        // OPMULA: acc = vs.yzx * vt.zxy ; OPMSUB: acc - vs.yzx * vt.zxy ; the w lane is an exact zero
        // (its product still feeds the OPMSUB sticky flags, like the old path).
        first = _mm_shuffle_ps(vs, vs, _MM_SHUFFLE(3, 0, 2, 1));
        second = _mm_shuffle_ps(vt, vt, _MM_SHUFFLE(3, 1, 0, 2));
    }
    FmacResult out;
    const __m128 acc = (kind == ArithMadd || kind == ArithMsub) ? normalize4(_mm_loadu_ps(m_state.acc)) : _mm_setzero_ps();
    if (opmul)
    {
        if (kind == ArithMsub)
            fmacArith<ArithMsub, true>(first, second, acc, dest, out);
        else
            fmacArith<ArithMul, true>(first, second, acc, dest, out);
    }
    else
    {
        switch (kind)
        {
        case ArithAdd: fmacArith<ArithAdd, false>(first, second, acc, dest, out); break;
        case ArithSub: fmacArith<ArithSub, false>(first, second, acc, dest, out); break;
        case ArithMul: fmacArith<ArithMul, false>(first, second, acc, dest, out); break;
        case ArithMadd: fmacArith<ArithMadd, false>(first, second, acc, dest, out); break;
        case ArithMsub: fmacArith<ArithMsub, false>(first, second, acc, dest, out); break;
        default: break;
        }
    }

    if (__builtin_expect(s_check, 0))
        checkFmac(instr, static_cast<uint8_t>(kind), opmul, first, second, out.value, out.mac, out.status, out.sticky);

    if (dest != 0u)
        pushFmacFlags(out.mac, out.status, out.sticky);
    storeLanes(toAcc ? m_state.acc : vd, out.value, dest);
}
