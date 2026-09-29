#include <atomic>
extern std::atomic<uint64_t> g_xgkickCount;
extern std::atomic<uint64_t> g_vuInsnCount;
extern std::atomic<uint64_t> g_vuProgramsAtZero;
extern std::atomic<uint64_t> g_vuProgramsKickBit;
#include "runtime/ps2_vu1.h"
#include "runtime/gs/ps2_gif_arbiter.h"
#include "runtime/gs/gs_frontend.h"
#include "runtime/ps2_memory.h"
#include "runtime/ps2_guest_clock.h"
#include "runtime/vu1_native_warning.h"
#include "ps2_vu1_detail.h"
#include "ps2x/knobs.h"

#include <algorithm>
#include <cfenv>
#include <xmmintrin.h>
#include <cmath>
#include <cstdio>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <string>
#include <filesystem>
#include <limits>
#include <ps2_log.h>
#ifdef _WIN32
#include <windows.h>
#else
#include <ctime>
#endif

namespace
{
    constexpr uint8_t laneForComponent(uint32_t component)
    {
        return static_cast<uint8_t>(1u << (3u - component));
    }
}

void VU1Interpreter::addVfRead(InstructionUsage &usage, uint8_t reg, uint8_t lanes)
{
    if (lanes == 0u)
        return;
    for (uint32_t index = 0; index < usage.vfReadCount; ++index)
    {
        if (usage.vfRead[index].reg == reg)
        {
            usage.vfRead[index].lanes |= lanes;
            return;
        }
    }
    if (usage.vfReadCount < usage.vfRead.size())
        usage.vfRead[usage.vfReadCount++] = {reg, lanes};
}

void VU1Interpreter::addVfWrite(InstructionUsage &usage, uint8_t reg, uint8_t lanes)
{
    if (reg == 0u || lanes == 0u)
        return;
    if (usage.vfWrite.reg == 0u)
        usage.vfWrite = {reg, lanes};
    else if (usage.vfWrite.reg == reg)
        usage.vfWrite.lanes |= lanes;
}

uint8_t VU1Interpreter::vfReadLanes(const InstructionUsage &usage, uint8_t reg)
{
    for (uint32_t index = 0; index < usage.vfReadCount; ++index)
    {
        if (usage.vfRead[index].reg == reg)
            return usage.vfRead[index].lanes;
    }
    return 0u;
}

VU1Interpreter::VU1Interpreter(Unit unit)
    : m_unit(unit)
{
    reset();
}

void VU1Interpreter::resetScheduler()
{
    m_nextReadyCycle = ~0ull;
    m_maxReadyCycle = 0;
    m_flagPipeline = {};
    m_fastFlagHead = 0;
    m_fastFlagCount = 0;
    m_fdiv = {};
    m_efu = {};
    m_storePipeline = {};
    m_vfWritePipeline = {};
    m_viWritePipeline = {};
    m_accWritePipeline = {};
    m_xgkick.clear();
    m_vfReady = {};
    m_viReady = {};
    m_accReady = {};
    m_vfLatestWrite = {};
    m_viLatestWrite = {};
    m_accLatestWrite = {};
    m_nextWriteSequence = 0;
    m_efuResourceReady = 0;
    m_workingClip = m_state.clip;
    m_viBranchBackupValue = 0;
    m_viBranchBackupReg = 0;
    m_viBranchBackupValid = false;
    m_stopRequested = false;
    m_programPending = false;
    m_pendingHaltD = false;
    m_pendingHaltT = false;
}

void VU1Interpreter::reset()
{
    std::memset(&m_state, 0, sizeof(m_state));
    m_state.vf[0][3] = 1.0f;
    m_state.q = 1.0f;
    m_state.r = 0x3F800000u;
    m_cycle = 0;
    resetScheduler();
}

float VU1Interpreter::broadcast(const float *vf, uint8_t bc)
{
    return normalizeOperand(vf[bc & 3u]);
}

float VU1Interpreter::normalizeResult(float value, uint32_t &laneFlags) const
{
    uint32_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    const uint32_t sign = bits & 0x80000000u;
    const uint32_t magnitude = bits & 0x7FFFFFFFu;
    const uint32_t exponent = (bits >> 23) & 0xFFu;

    laneFlags = sign != 0u ? 0x2u : 0u;
    if (magnitude == 0u)
    {
        laneFlags |= 0x1u;
    }
    else if (exponent == 0u)
    {
        laneFlags |= 0x5u;
        bits = sign;
    }
    else if (exponent == 0xFFu)
    {
        laneFlags |= 0x8u;
        bits = sign | 0x7F7FFFFFu;
    }

    std::memcpy(&value, &bits, sizeof(value));
    return value;
}

int32_t VU1Interpreter::readBranchVi(uint8_t reg) const
{
    if (reg == 0u)
        return 0;
    if (m_viBranchBackupValid &&
        m_viBranchBackupReg == reg)
    {
        return m_viBranchBackupValue;
    }
    return m_state.vi[reg];
}

void VU1Interpreter::recordViWriteForBranch(uint8_t reg, int32_t oldValue)
{
    if (reg == 0u)
        return;
    m_viBranchBackupValue = oldValue;
    m_viBranchBackupReg = reg;
    m_viBranchBackupValid = true;
}

void VU1Interpreter::applyDestAcc(const float *result, uint8_t dest)
{
    applyDest(m_state.acc, result, dest);
}

void VU1Interpreter::normalizeFmacResult(float *result, uint8_t dest,
                                         uint8_t laneFlags[4])
{
    for (uint32_t component = 0; component < 4u; ++component)
    {
        laneFlags[component] = 0u;
        if ((dest & laneForComponent(component)) == 0u)
            continue;

        long double exactResult = 0.0L;
        if (calculateFmacExactResult(component, exactResult))
        {
            laneFlags[component] = normalizeFmacExactResult(result[component], exactResult);
            continue;
        }

        uint32_t flags = 0u;
        result[component] = normalizeResult(result[component], flags);
        laneFlags[component] = static_cast<uint8_t>(flags);
    }
}

bool VU1Interpreter::calculateFmacExactResult(uint32_t component,
                                               long double &result) const
{
    const uint32_t upper = m_currentUpperInstruction;
    const uint8_t op = static_cast<uint8_t>(upper & 0x3Fu);
    const uint8_t special = op >= 0x3Cu
                                ? static_cast<uint8_t>((upper & 3u) | ((upper >> 4) & 0x7Cu))
                                : 0xFFu;
    const uint8_t fs = FS(upper);
    const uint8_t ft = FT(upper);

    const auto operand = [this](float value)
    {
        return static_cast<long double>(normalizeOperand(value));
    };
    const auto vs = [&](uint32_t lane)
    {
        return operand(m_state.vf[fs][lane]);
    };
    const auto vt = [&](uint32_t lane)
    {
        return operand(m_state.vf[ft][lane]);
    };
    const auto acc = [&](uint32_t lane)
    {
        return operand(m_state.acc[lane]);
    };

    const long double q = operand(m_state.q);
    const long double i = operand(m_state.i);

    if (op < 0x3Cu)
    {
        if (op <= 0x03u)
            result = vs(component) + vt(op & 3u);
        else if (op <= 0x07u)
            result = vs(component) - vt(op & 3u);
        else if (op <= 0x0Bu)
            result = acc(component) + vs(component) * vt(op & 3u);
        else if (op <= 0x0Fu)
            result = acc(component) - vs(component) * vt(op & 3u);
        else if (op >= 0x18u && op <= 0x1Bu)
            result = vs(component) * vt(op & 3u);
        else
        {
            switch (op)
            {
            case 0x1Cu:
                result = vs(component) * q;
                break;
            case 0x1Eu:
                result = vs(component) * i;
                break;
            case 0x20u:
                result = vs(component) + q;
                break;
            case 0x21u:
                result = acc(component) + vs(component) * q;
                break;
            case 0x22u:
                result = vs(component) + i;
                break;
            case 0x23u:
                result = acc(component) + vs(component) * i;
                break;
            case 0x24u:
                result = vs(component) - q;
                break;
            case 0x25u:
                result = acc(component) - vs(component) * q;
                break;
            case 0x26u:
                result = vs(component) - i;
                break;
            case 0x27u:
                result = acc(component) - vs(component) * i;
                break;
            case 0x28u:
                result = vs(component) + vt(component);
                break;
            case 0x29u:
                result = acc(component) + vs(component) * vt(component);
                break;
            case 0x2Au:
                result = vs(component) * vt(component);
                break;
            case 0x2Cu:
                result = vs(component) - vt(component);
                break;
            case 0x2Du:
                result = acc(component) - vs(component) * vt(component);
                break;
            case 0x2Eu:
            {
                static constexpr uint8_t left[4] = {1u, 2u, 0u, 3u};
                static constexpr uint8_t right[4] = {2u, 0u, 1u, 3u};
                result = component == 3u
                             ? 0.0L
                             : acc(component) - vs(left[component]) * vt(right[component]);
                break;
            }
            default:
                return false;
            }
        }
        return true;
    }

    if (special <= 0x03u)
        result = vs(component) + vt(special & 3u);
    else if (special <= 0x07u)
        result = vs(component) - vt(special & 3u);
    else if (special <= 0x0Bu)
        result = acc(component) + vs(component) * vt(special & 3u);
    else if (special <= 0x0Fu)
        result = acc(component) - vs(component) * vt(special & 3u);
    else if (special >= 0x18u && special <= 0x1Bu)
        result = vs(component) * vt(special & 3u);
    else
    {
        switch (special)
        {
        case 0x1Cu:
            result = vs(component) * q;
            break;
        case 0x1Eu:
            result = vs(component) * i;
            break;
        case 0x20u:
            result = vs(component) + q;
            break;
        case 0x21u:
            result = acc(component) + vs(component) * q;
            break;
        case 0x22u:
            result = vs(component) + i;
            break;
        case 0x23u:
            result = acc(component) + vs(component) * i;
            break;
        case 0x24u:
            result = vs(component) - q;
            break;
        case 0x25u:
            result = acc(component) - vs(component) * q;
            break;
        case 0x26u:
            result = vs(component) - i;
            break;
        case 0x27u:
            result = acc(component) - vs(component) * i;
            break;
        case 0x28u:
            result = vs(component) + vt(component);
            break;
        case 0x29u:
            result = acc(component) + vs(component) * vt(component);
            break;
        case 0x2Au:
            result = vs(component) * vt(component);
            break;
        case 0x2Cu:
            result = vs(component) - vt(component);
            break;
        case 0x2Du:
            result = acc(component) - vs(component) * vt(component);
            break;
        case 0x2Eu:
        {
            static constexpr uint8_t left[4] = {1u, 2u, 0u, 3u};
            static constexpr uint8_t right[4] = {2u, 0u, 1u, 3u};
            result = component == 3u
                         ? 0.0L
                         : vs(left[component]) * vt(right[component]);
            break;
        }
        default:
            return false;
        }
    }
    return true;
}

uint8_t VU1Interpreter::normalizeFmacExactResult(float &value,
                                                  long double exactResult) const
{
    const bool negative = std::signbit(exactResult);
    const long double magnitude = std::fabs(exactResult);
    const long double maximum = static_cast<long double>(std::numeric_limits<float>::max());
    const long double minimum = static_cast<long double>(std::numeric_limits<float>::min());
    uint8_t flags = negative ? 0x2u : 0u;

    uint32_t bits = negative ? 0x80000000u : 0u;
    if (magnitude == 0.0L)
    {
        flags |= 0x1u;
        std::memcpy(&value, &bits, sizeof(value));
    }
    else if (magnitude > maximum)
    {
        flags |= 0x8u;
        bits |= 0x7F7FFFFFu;
        std::memcpy(&value, &bits, sizeof(value));
    }
    else if (magnitude < minimum)
    {
        flags |= 0x5u;
        std::memcpy(&value, &bits, sizeof(value));
    }

    return flags;
}

uint32_t VU1Interpreter::calculateFmacProductSticky(uint8_t dest) const
{
    uint32_t extraSticky = 0u;
    const uint32_t upper = m_currentUpperInstruction;
    const uint8_t op = static_cast<uint8_t>(upper & 0x3Fu);
    const uint8_t special = op >= 0x3Cu ? static_cast<uint8_t>((upper & 3u) | ((upper >> 4) & 0x7Cu)) : 0xFFu;
    const bool productSum =
        (op >= 0x08u && op <= 0x0Fu) ||
        op == 0x21u || op == 0x23u || op == 0x25u || op == 0x27u ||
        op == 0x29u || op == 0x2Du || op == 0x2Eu ||
        (special >= 0x08u && special <= 0x0Fu) ||
        special == 0x21u || special == 0x23u || special == 0x25u ||
        special == 0x27u || special == 0x29u || special == 0x2Du;
    if (!productSum)
        return 0u;

    const uint8_t fs = FS(upper);
    const uint8_t ft = FT(upper);
    for (uint32_t component = 0; component < 4u; ++component)
    {
        if ((dest & laneForComponent(component)) == 0u)
            continue;
        static constexpr uint8_t crossLeft[4] = {1u, 2u, 0u, 3u};
        static constexpr uint8_t crossRight[4] = {2u, 0u, 1u, 3u};
        const uint8_t leftComponent = op == 0x2Eu ? crossLeft[component] : static_cast<uint8_t>(component);
        const float left = normalizeOperand(m_state.vf[fs][leftComponent]);
        float right = 0.0f;
        if ((op >= 0x08u && op <= 0x0Fu) || (special >= 0x08u && special <= 0x0Fu))
        {
            right = normalizeOperand(m_state.vf[ft][(op >= 0x08u && op <= 0x0Fu ? op : special) & 3u]);
        }
        else if (op == 0x21u || op == 0x25u || special == 0x21u || special == 0x25u)
        {
            right = normalizeOperand(m_state.q);
        }
        else if (op == 0x23u || op == 0x27u || special == 0x23u || special == 0x27u)
        {
            right = normalizeOperand(m_state.i);
        }
        else if (op == 0x2Eu)
        {
            right = normalizeOperand(m_state.vf[ft][crossRight[component]]);
        }
        else
        {
            right = normalizeOperand(m_state.vf[ft][component]);
        }

        float product = left * right;
        const long double exactProduct = static_cast<long double>(left) * static_cast<long double>(right);
        const uint8_t productFlags = normalizeFmacExactResult(product, exactProduct);
        // Product-sum instructions report Z/S/U/O from the add/subtract result
        // as current flags, while every product condition accumulates into the
        // corresponding sticky flag.
        extraSticky |= productFlags & 0xFu;
    }
    return extraSticky;
}

void VU1Interpreter::updateFmacFlags(const uint8_t laneFlags[4], uint8_t dest,
                                     uint32_t extraSticky)
{
    if (dest == 0u)
        return;

    uint32_t mac = 0u;
    uint32_t status = 0u;
    for (uint32_t component = 0; component < 4u; ++component)
    {
        const uint8_t lane = laneForComponent(component);
        if ((dest & lane) == 0u)
            continue;

        const uint32_t flags = laneFlags[component];
        if ((flags & 0x1u) != 0u)
            mac |= lane;
        if ((flags & 0x2u) != 0u)
            mac |= static_cast<uint32_t>(lane) << 4;
        if ((flags & 0x4u) != 0u)
            mac |= static_cast<uint32_t>(lane) << 8;
        if ((flags & 0x8u) != 0u)
            mac |= static_cast<uint32_t>(lane) << 12;
        status |= flags;
    }
    pushFmacFlags(mac, status, extraSticky);
}

void VU1Interpreter::pushFmacFlagsExact(uint32_t mac, uint32_t status, uint32_t extraSticky)
{
    FlagPipelineEntry *entry = nullptr;
    for (FlagPipelineEntry &candidate : m_flagPipeline)
    {
        if (!candidate.valid)
        {
            entry = &candidate;
            break;
        }
    }
    if (!entry)
    {
        reportReservedInstruction(true, 0xFFFFFFFFu);
        return;
    }

    *entry = {};
    entry->valid = true;
    entry->issueCycle = m_cycle;
    entry->issuePc = m_state.pc;
    entry->readyCycle = m_cycle + kFmacLatency;
    noteQueued(entry->readyCycle);
    entry->mac = mac;
    entry->status = status;
    entry->extraSticky = extraSticky;
    entry->writesMac = true;
    entry->writesStatus = true;
}

void VU1Interpreter::fastPushOverflow()
{
    reportReservedInstruction(true, 0xFFFFFFFFu);
}

void VU1Interpreter::applyFmacDest(float *dst, float *result, uint8_t dest)
{
    uint8_t laneFlags[4]{};
    normalizeFmacResult(result, dest, laneFlags);
    updateFmacFlags(laneFlags, dest, calculateFmacProductSticky(dest));
    applyDest(dst, result, dest);
}

void VU1Interpreter::applyFmacDestAcc(float *result, uint8_t dest)
{
    uint8_t laneFlags[4]{};
    normalizeFmacResult(result, dest, laneFlags);
    updateFmacFlags(laneFlags, dest, calculateFmacProductSticky(dest));
    applyDestAcc(result, dest);
}

void VU1Interpreter::queueFsset(uint16_t immediate)
{
    for (FlagPipelineEntry &entry : m_flagPipeline)
    {
        if (entry.valid && entry.issueCycle == m_cycle)
            entry.writesStatus = false;
    }
    if (m_fast)
    {
        FlagPipelineEntry entry{};
        entry.valid = true;
        entry.issueCycle = m_cycle;
        entry.readyCycle = m_cycle + kFmacLatency;
        entry.status = static_cast<uint32_t>(immediate) & 0xFC0u;
        entry.writesSticky = true;
        fastPushFlags(entry);
        return;
    }

    for (FlagPipelineEntry &entry : m_flagPipeline)
    {
        if (!entry.valid)
        {
            entry = {};
            entry.valid = true;
            entry.issueCycle = m_cycle;
            entry.readyCycle = m_cycle + kFmacLatency;
            noteQueued(entry.readyCycle);
            entry.status = static_cast<uint32_t>(immediate) & 0xFC0u;
            entry.writesSticky = true;
            return;
        }
    }
    reportReservedInstruction(false, 0xFFFFFFFEu);
}

void VU1Interpreter::queueClip(uint32_t clip)
{
    m_workingClip = ((m_workingClip << 6) | (clip & 0x3Fu)) & 0xFFFFFFu;
    if (m_fast)
    {
        FlagPipelineEntry entry{};
        entry.valid = true;
        entry.issueCycle = m_cycle;
        entry.readyCycle = m_cycle + kFmacLatency;
        entry.clip = m_workingClip;
        entry.writesClip = true;
        fastPushFlags(entry);
        return;
    }
    for (FlagPipelineEntry &entry : m_flagPipeline)
    {
        if (!entry.valid)
        {
            entry = {};
            entry.valid = true;
            entry.issueCycle = m_cycle;
            entry.readyCycle = m_cycle + kFmacLatency;
            noteQueued(entry.readyCycle);
            entry.clip = m_workingClip;
            entry.writesClip = true;
            return;
        }
    }
    reportReservedInstruction(true, 0xFFFFFFFDu);
}

void VU1Interpreter::queueFcset(uint32_t clip)
{
    m_workingClip = clip & 0xFFFFFFu;
    for (FlagPipelineEntry &entry : m_flagPipeline)
    {
        if (entry.valid && entry.issueCycle == m_cycle)
            entry.writesClip = false;
    }
    if (m_fast)
    {
        FlagPipelineEntry entry{};
        entry.valid = true;
        entry.issueCycle = m_cycle;
        entry.readyCycle = m_cycle + kFmacLatency;
        entry.clip = m_workingClip;
        entry.writesClip = true;
        fastPushFlags(entry);
        return;
    }
    for (FlagPipelineEntry &entry : m_flagPipeline)
    {
        if (!entry.valid)
        {
            entry = {};
            entry.valid = true;
            entry.issueCycle = m_cycle;
            entry.readyCycle = m_cycle + kFmacLatency;
            noteQueued(entry.readyCycle);
            entry.clip = m_workingClip;
            entry.writesClip = true;
            return;
        }
    }
    reportReservedInstruction(false, 0xFFFFFFFAu);
}

void VU1Interpreter::queueQ(float value, uint32_t latency, uint32_t statusDi)
{
    uint32_t ignoredFlags = 0u;
    value = normalizeResult(value, ignoredFlags);
    m_fdiv.valid = true;
    m_fdiv.readyCycle = m_cycle + latency;
    noteQueued(m_fdiv.readyCycle);
    noteReady(m_fdiv.readyCycle);
    m_fdiv.value = value;
    m_fdiv.statusDi = statusDi & 0x30u;
}

void VU1Interpreter::queueP(float value, uint32_t latency)
{
    uint32_t ignoredFlags = 0u;
    value = normalizeResult(value, ignoredFlags);
    for (ScalarPipelineEntry &entry : m_efu)
    {
        if (!entry.valid)
        {
            entry.valid = true;
            entry.readyCycle = m_cycle + latency;
            noteQueued(entry.readyCycle);
            entry.value = value;
            // EFU throughput is one cycle shorter than result visibility.
            m_efuResourceReady = m_cycle + (latency > 0u ? latency - 1u : 0u);
            noteReady(entry.readyCycle);
            return;
        }
    }
    reportReservedInstruction(false, 0xFFFFFFF9u);
}

void VU1Interpreter::queueStore(uint32_t address, const uint32_t words[4], uint8_t laneMask)
{
    if (m_fast)
    {
        if (m_activeVuData && address + 16u <= m_activeVuDataSize)
        {
            uint32_t *dst = reinterpret_cast<uint32_t *>(m_activeVuData + address);
            if (laneMask == 0xFu)
                std::memcpy(dst, words, 16u);
            else
                for (uint32_t component = 0; component < 4u; ++component)
                    if ((laneMask & laneForComponent(component)) != 0u)
                        dst[component] = words[component];
        }
        return;
    }
    for (PendingStore &store : m_storePipeline)
    {
        if (!store.valid)
        {
            store.valid = true;
            store.readyCycle = m_cycle + 1u;
            noteQueued(store.readyCycle);
            store.address = address;
            store.laneMask = laneMask;
            std::copy(words, words + 4, store.words.begin());
            return;
        }
    }
    reportReservedInstruction(false, 0xFFFFFFFCu);
}

void VU1Interpreter::queueVfWrite(uint8_t reg, uint8_t laneMask,
                                  const float value[4], uint32_t latency)
{
    if (reg == 0u || laneMask == 0u)
        return;
    for (PendingVfWrite &write : m_vfWritePipeline)
    {
        if (!write.valid)
        {
            write = {};
            write.valid = true;
            write.readyCycle = m_cycle + latency;
            noteQueued(write.readyCycle);
            write.sequence = ++m_nextWriteSequence;
            write.reg = reg;
            write.laneMask = laneMask;
            std::copy(value, value + 4, write.value.begin());
            for (uint32_t component = 0; component < 4u; ++component)
            {
                if ((laneMask & laneForComponent(component)) != 0u)
                    m_vfLatestWrite[reg][component] = write.sequence;
            }
            return;
        }
    }
    reportReservedInstruction(false, 0xFFFFFFF7u);
}

void VU1Interpreter::queueViWrite(uint8_t reg, int32_t value, uint32_t latency)
{
    if (reg == 0u)
        return;
    for (PendingViWrite &write : m_viWritePipeline)
    {
        if (!write.valid)
        {
            write = {};
            write.valid = true;
            write.readyCycle = m_cycle + latency;
            noteQueued(write.readyCycle);
            write.sequence = ++m_nextWriteSequence;
            write.reg = reg;
            write.value = value;
            m_viLatestWrite[reg] = write.sequence;
            return;
        }
    }
    reportReservedInstruction(false, 0xFFFFFFF6u);
}

void VU1Interpreter::queueAccWrite(uint8_t laneMask, const float value[4], uint32_t latency)
{
    if (laneMask == 0u)
        return;
    for (PendingAccWrite &write : m_accWritePipeline)
    {
        if (!write.valid)
        {
            write = {};
            write.valid = true;
            write.readyCycle = m_cycle + latency;
            noteQueued(write.readyCycle);
            write.sequence = ++m_nextWriteSequence;
            write.laneMask = laneMask;
            std::copy(value, value + 4, write.value.begin());
            for (uint32_t component = 0; component < 4u; ++component)
            {
                if ((laneMask & laneForComponent(component)) != 0u)
                    m_accLatestWrite[component] = write.sequence;
            }
            return;
        }
    }
    reportReservedInstruction(true, 0xFFFFFFF5u);
}

void VU1Interpreter::commitReadyPipelines()
{
    if (m_cycle < m_nextReadyCycle)
        return;
    uint64_t next = ~0ull;
    const auto pending = [&next](uint64_t ready)
    {
        if (ready < next)
            next = ready;
    };
    for (FlagPipelineEntry &entry : m_flagPipeline)
    {
        if (!entry.valid)
            continue;
        if (entry.readyCycle > m_cycle)
        {
            pending(entry.readyCycle);
            continue;
        }

        if (entry.writesMac)
        {
            m_state.mac = entry.mac;
            m_lastMacPc = entry.issuePc;
        }
        if (entry.writesStatus)
        {
            const uint32_t current = entry.status & 0xFu;
            m_state.status = (m_state.status & 0xFF0u) | current | ((current | entry.extraSticky) << 6);
        }
        if (entry.writesSticky)
        {
            m_state.status = (m_state.status & 0x03Fu) | (entry.status & 0xFC0u);
        }
        if (entry.writesClip)
            m_state.clip = entry.clip;
        entry = {};
    }

    if (m_fdiv.valid && m_fdiv.readyCycle > m_cycle)
        pending(m_fdiv.readyCycle);
    if (m_fdiv.valid && m_fdiv.readyCycle <= m_cycle)
    {
        m_state.q = m_fdiv.value;
        const uint32_t currentDi = m_fdiv.statusDi & 0x30u;
        m_state.status = (m_state.status & 0xFCFu) | currentDi | (currentDi << 6);
        m_fdiv = {};
    }

    for (ScalarPipelineEntry &entry : m_efu)
    {
        if (!entry.valid)
            continue;
        if (entry.readyCycle > m_cycle)
        {
            pending(entry.readyCycle);
            continue;
        }
        m_state.p = entry.value;
        entry = {};
    }

    for (PendingStore &store : m_storePipeline)
    {
        if (!store.valid)
            continue;
        if (store.readyCycle > m_cycle)
        {
            pending(store.readyCycle);
            continue;
        }
        if (m_activeVuData && store.address + 16u <= m_activeVuDataSize)
        {
            uint32_t oldWords[4]{};
            std::memcpy(oldWords, m_activeVuData + store.address, sizeof(oldWords));
            for (uint32_t component = 0; component < 4u; ++component)
            {
                if ((store.laneMask & laneForComponent(component)) != 0u)
                    oldWords[component] = store.words[component];
            }
            std::memcpy(m_activeVuData + store.address, oldWords, sizeof(oldWords));
        }
        store = {};
    }

    for (PendingVfWrite &write : m_vfWritePipeline)
    {
        if (!write.valid)
            continue;
        if (write.readyCycle > m_cycle)
        {
            pending(write.readyCycle);
            continue;
        }
        for (uint32_t component = 0; component < 4u; ++component)
        {
            if ((write.laneMask & laneForComponent(component)) != 0u &&
                m_vfLatestWrite[write.reg][component] == write.sequence)
            {
                m_state.vf[write.reg][component] = write.value[component];
            }
        }
        write = {};
    }

    for (PendingViWrite &write : m_viWritePipeline)
    {
        if (!write.valid)
            continue;
        if (write.readyCycle > m_cycle)
        {
            pending(write.readyCycle);
            continue;
        }
        if (m_viLatestWrite[write.reg] == write.sequence)
            m_state.vi[write.reg] = static_cast<int16_t>(write.value);
        write = {};
    }

    for (PendingAccWrite &write : m_accWritePipeline)
    {
        if (!write.valid)
            continue;
        if (write.readyCycle > m_cycle)
        {
            pending(write.readyCycle);
            continue;
        }
        for (uint32_t component = 0; component < 4u; ++component)
        {
            if ((write.laneMask & laneForComponent(component)) != 0u &&
                m_accLatestWrite[component] == write.sequence)
            {
                m_state.acc[component] = write.value[component];
            }
        }
        write = {};
    }
    m_nextReadyCycle = next;
}

// First XGKICK overrun: print the program state and save VU1 data memory (vu1_overrun_data.bin)
// so the kicked address can be traced back to the handler that computed it.
void VU1Interpreter::dumpOverrunState()
{
    static bool s_done = false;
    if (s_done)
        return;
    s_done = true;
    std::fprintf(stderr, "[VU1 xgkick] state: pc=0x%x top=0x%x itop=0x%x vi=", m_state.pc, m_state.top, m_state.itop);
    for (int i = 0; i < 16; ++i)
        std::fprintf(stderr, "%s%d", i ? "," : "", (int)m_state.vi[i]);
    std::fprintf(stderr, "\n");
    const char *dir = ps2x::knob("PS2X_FRAME_DUMP");
    const std::string path = std::string(dir ? dir : "logs") + "/vu1_overrun_data.bin";
    if (FILE *fp = std::fopen(path.c_str(), "wb"))
    {
        std::fwrite(m_activeVuData, 1, m_activeVuDataSize, fp);
        std::fclose(fp);
    }
}

void VU1Interpreter::progressXgkick()
{
    if (!m_xgkick.active || !m_activeVuData || m_activeVuDataSize == 0u)
        return;

    ++m_xgkick.cycleCredit;
    while (m_xgkick.active && m_xgkick.cycleCredit >= 2u)
    {
        m_xgkick.cycleCredit -= 2u;
        if (m_xgkick.copiedBytes > XgkickPipeline::kBufferSize - 16u)
        {
            std::fprintf(stderr, "[VU1 xgkick] no EOP within buffer: src=0x%x copied=%u\n",
                         m_xgkick.sourceAddress, m_xgkick.copiedBytes);
            reportReservedInstruction(false, 0xFFFFFFFBu);
            m_xgkick.active = false;
            return;
        }

        const uint32_t qwordOffset = m_xgkick.copiedBytes;
        {
            const uint32_t source = (m_xgkick.sourceAddress + m_xgkick.copiedBytes) % m_activeVuDataSize;
            if (source + 16u <= m_activeVuDataSize)
                std::memcpy(m_xgkick.packet.data() + m_xgkick.copiedBytes, m_activeVuData + source, 16u);
            else
                for (uint32_t i = 0; i < 16u; ++i)
                    m_xgkick.packet[m_xgkick.copiedBytes + i] = m_activeVuData[(source + i) % m_activeVuDataSize];
        }
        m_xgkick.copiedBytes += 16u;

        if (m_xgkick.currentTagEnd == 0u)
        {
            uint64_t tagLo = 0;
            std::memcpy(&tagLo, m_xgkick.packet.data() + qwordOffset, sizeof(tagLo));
            const uint32_t nloop = static_cast<uint32_t>(tagLo & 0x7FFFu);
            const uint32_t format = static_cast<uint32_t>((tagLo >> 58) & 0x3u);
            uint32_t nreg = static_cast<uint32_t>((tagLo >> 60) & 0xFu);
            if (nreg == 0u)
                nreg = 16u;

            uint64_t tagBytes = 16u;
            if (format == 0u)
                tagBytes += static_cast<uint64_t>(nloop) * nreg * 16u;
            else if (format == 1u)
                tagBytes += ((static_cast<uint64_t>(nloop) * nreg + 1u) & ~1ull) * 8u;
            else if (format == GIF_FMT_IMAGE || format == GIF_FMT_IMAGE2)
                tagBytes += static_cast<uint64_t>(nloop) * 16u;
            else
            {
                reportReservedInstruction(false, 0xFFFFFFF8u);
                m_xgkick.active = false;
                return;
            }

            if (tagBytes > XgkickPipeline::kBufferSize - qwordOffset)
            {
                uint32_t t[4] = {0};
                std::memcpy(t, m_xgkick.packet.data() + qwordOffset, 16);
                dumpOverrunState();
                std::fprintf(stderr, "[VU1 xgkick] packet overrun: src=0x%x off=%u tag=[%08x %08x %08x %08x] nloop=%u fmt=%u nreg=%u tagBytes=%llu\n",
                             m_xgkick.sourceAddress, qwordOffset, t[0], t[1], t[2], t[3], nloop, format, nreg,
                             (unsigned long long)tagBytes);
                reportReservedInstruction(false, 0xFFFFFFFBu);
                m_xgkick.active = false;
                return;
            }
            m_xgkick.currentTagEnd = qwordOffset + static_cast<uint32_t>(tagBytes);
            m_xgkick.currentTagEop = ((tagLo >> 15) & 1u) != 0u;
            if (m_xgkick.currentTagEop)
                m_xgkick.totalBytes = m_xgkick.currentTagEnd;
        }

        if (m_xgkick.copiedBytes >= m_xgkick.currentTagEnd)
        {
            if (m_xgkick.currentTagEop)
                finishXgkick();
            else
            {
                // The next transferred qword is another GIFtag.
                m_xgkick.currentTagEnd = 0u;
                m_xgkick.currentTagEop = false;
            }
        }
    }
}

void VU1Interpreter::finishXgkick()
{
    if (!m_xgkick.active)
        return;

    if (m_activeMemory)
        m_activeMemory->submitGifPacket(GifPathId::Path1, m_xgkick.packet.data(), m_xgkick.totalBytes);
    else if (m_activeGs)
        m_activeGs->processGIFPacket(m_xgkick.packet.data(), m_xgkick.totalBytes);
    m_xgkick.active = false;
}

void VU1Interpreter::startXgkick(uint32_t qwordAddress)
{
    if (m_unit != Unit::VU1 || !m_activeVuData || m_activeVuDataSize < 16u)
        return;

    const uint32_t sourceAddress = (qwordAddress * 16u) % m_activeVuDataSize;
    m_xgkick.clear();
    m_xgkick.active = true;
    g_xgkickCount.fetch_add(1, std::memory_order_relaxed);
    m_xgkick.sourceAddress = sourceAddress;
    m_xgkick.cycleCredit = 1u; // XGKICK's issue cycle counts toward PATH1.
    m_xgkick.issueCycle = m_cycle;
    // The default: copy the whole packet at kick time (what most emulators do)
    // instead of one qword per two cycles while the program runs on. Experiment for SOCOM II's
    // object geometry, which arrives as 1700 identical degenerate vertices per frame — the
    // signature of a buffer re-templated by the program before the modeled transfer finished.
    // Default since 2026-09-08: the per-cycle model dropped SOCOM II's object geometry (buffers
    // re-templated before the modeled transfer finished); PS2X_VU1_XGKICK_CYCLE_EXACT=1 restores it.
    static const bool s_immediate = !ps2x::knobOn("PS2X_VU1_XGKICK_CYCLE_EXACT");
    if (s_immediate)
    {
        m_xgkick.cycleCredit = 0x40000000u;
        // Direct submit: walk the GIFtags in VU memory and hand the packet to the arbiter from
        // there (it copies once). Falls back to the copying paths when the packet wraps around the
        // end of VU memory, overruns the buffer or has a reserved tag format.
        if (m_activeMemory)
        {
            uint32_t off = 0u;
            bool ok = false;
            for (;;)
            {
                const uint32_t src = sourceAddress + off;
                if (src + 16u > m_activeVuDataSize || off > XgkickPipeline::kBufferSize - 16u)
                    break;
                uint64_t tagLo = 0;
                std::memcpy(&tagLo, m_activeVuData + src, sizeof(tagLo));
                const uint32_t nloop = static_cast<uint32_t>(tagLo & 0x7FFFu);
                const uint32_t format = static_cast<uint32_t>((tagLo >> 58) & 0x3u);
                uint32_t nreg = static_cast<uint32_t>((tagLo >> 60) & 0xFu);
                if (nreg == 0u)
                    nreg = 16u;
                uint64_t tagBytes = 16u;
                if (format == 0u)
                    tagBytes += static_cast<uint64_t>(nloop) * nreg * 16u;
                else if (format == 1u)
                    tagBytes += ((static_cast<uint64_t>(nloop) * nreg + 1u) & ~1ull) * 8u;
                else if (format == 2u)
                    tagBytes += static_cast<uint64_t>(nloop) * 16u;
                else
                    break;
                if (tagBytes > XgkickPipeline::kBufferSize - off || src + tagBytes > m_activeVuDataSize)
                    break;
                off += static_cast<uint32_t>(tagBytes);
                if (((tagLo >> 15) & 1u) != 0u)
                {
                    ok = true;
                    break;
                }
            }
            if (ok)
            {
                m_xgkick.totalBytes = off;
                m_xgkick.copiedBytes = off;
                m_activeMemory->submitGifPacket(GifPathId::Path1, m_activeVuData + sourceAddress, off);
                m_xgkick.active = false;
                return;
            }
        }
        // Bulk copy: one memcpy per GIFtag payload instead of one qword per step, as long as the
        // packet does not wrap around the end of VU memory (then the per-qword path takes over).
        while (m_xgkick.active)
        {
            const uint32_t off = m_xgkick.copiedBytes;
            const uint32_t src = m_xgkick.sourceAddress + off;
            if (src + 16u > m_activeVuDataSize || off > XgkickPipeline::kBufferSize - 16u)
                break;
            uint64_t tagLo = 0;
            std::memcpy(&tagLo, m_activeVuData + src, sizeof(tagLo));
            const uint32_t nloop = static_cast<uint32_t>(tagLo & 0x7FFFu);
            const uint32_t format = static_cast<uint32_t>((tagLo >> 58) & 0x3u);
            uint32_t nreg = static_cast<uint32_t>((tagLo >> 60) & 0xFu);
            if (nreg == 0u)
                nreg = 16u;
            uint64_t tagBytes = 16u;
            if (format == 0u)
                tagBytes += static_cast<uint64_t>(nloop) * nreg * 16u;
            else if (format == 1u)
                tagBytes += ((static_cast<uint64_t>(nloop) * nreg + 1u) & ~1ull) * 8u;
            else if (format == 2u)
                tagBytes += static_cast<uint64_t>(nloop) * 16u;
            else
                break; // reserved format: the per-qword path reports it
            if (tagBytes > XgkickPipeline::kBufferSize - off || src + tagBytes > m_activeVuDataSize)
                break; // overrun or wrap: the per-qword path handles/reports it
            std::memcpy(m_xgkick.packet.data() + off, m_activeVuData + src, static_cast<size_t>(tagBytes));
            m_xgkick.copiedBytes = off + static_cast<uint32_t>(tagBytes);
            if (((tagLo >> 15) & 1u) != 0u)
            {
                m_xgkick.totalBytes = m_xgkick.copiedBytes;
                finishXgkick();
            }
        }
        progressXgkick();
    }
}

void VU1Interpreter::advanceOneCycle()
{
    ++m_cycle;
    m_state.cycles = m_cycle;
    // LSU commits become visible at the cycle boundary before PATH1 consumes
    // its next qword from VU memory.
    commitReadyPipelines();
    progressXgkick();
}

void VU1Interpreter::advanceTo(uint64_t targetCycle)
{
    while (m_cycle < targetCycle)
        advanceOneCycle();
}

bool VU1Interpreter::pipelinesPending() const
{
    if (m_fdiv.valid || m_xgkick.active)
        return true;
    for (const ScalarPipelineEntry &entry : m_efu)
        if (entry.valid)
            return true;
    for (const FlagPipelineEntry &entry : m_flagPipeline)
        if (entry.valid)
            return true;
    for (const PendingStore &store : m_storePipeline)
        if (store.valid)
            return true;
    for (const PendingVfWrite &write : m_vfWritePipeline)
        if (write.valid)
            return true;
    for (const PendingViWrite &write : m_viWritePipeline)
        if (write.valid)
            return true;
    for (const PendingAccWrite &write : m_accWritePipeline)
        if (write.valid)
            return true;
    return false;
}

void VU1Interpreter::flushPipelines()
{
    while (pipelinesPending())
        advanceOneCycle();
}

uint64_t VU1Interpreter::calculatePairReadyCycle(const DecodedInstructionPair &decoded) const
{
    uint64_t ready = m_cycle;
    if (decoded.lowerUsage.pipeline == PipelineXgkick && m_xgkick.active)
        ready = m_cycle + 1u;
    // Every pending result has landed: nothing below can raise `ready`.
    if (m_cycle >= m_maxReadyCycle)
        return ready;

    const InstructionUsage *usages[2] = {
        &decoded.upperUsage,
        &decoded.lowerUsage};
    for (const InstructionUsage *usage : usages)
    {
        for (uint32_t index = 0; index < usage->vfReadCount; ++index)
        {
            const VfAccess &access = usage->vfRead[index];
            const uint64_t *readyLanes = m_vfReady[access.reg].data();
            if (access.lanes & 0x8u)
                ready = std::max(ready, readyLanes[0]);
            if (access.lanes & 0x4u)
                ready = std::max(ready, readyLanes[1]);
            if (access.lanes & 0x2u)
                ready = std::max(ready, readyLanes[2]);
            if (access.lanes & 0x1u)
                ready = std::max(ready, readyLanes[3]);
        }
        uint32_t viMask = usage->viRead & 0xFFFEu;
        while (viMask != 0u)
        {
            const uint32_t reg = static_cast<uint32_t>(__builtin_ctz(viMask));
            ready = std::max(ready, m_viReady[reg]);
            viMask &= viMask - 1u;
        }
        if (usage->accRead != 0u)
        {
            for (uint32_t component = 0; component < 4u; ++component)
            {
                if ((usage->accRead & laneForComponent(component)) != 0u)
                    ready = std::max(ready, m_accReady[component]);
            }
        }
    }

    if (decoded.lowerUsage.pipeline == PipelineFdiv && m_fdiv.valid)
        ready = std::max(ready, m_fdiv.readyCycle);
    if (decoded.lowerUsage.pipeline == PipelineEfu)
        ready = std::max(ready, m_efuResourceReady);
    if (decoded.lowerUsage.waitQ && m_fdiv.valid)
        ready = std::max(ready, m_fdiv.readyCycle);
    if (decoded.lowerUsage.waitP)
    {
        for (const ScalarPipelineEntry &entry : m_efu)
            if (entry.valid)
                ready = std::max(ready, entry.readyCycle);
    }
    return ready;
}

void VU1Interpreter::markPairWrites(const DecodedInstructionPair &decoded)
{
    const VfAccess lowerWrite = decoded.lowerUsage.vfWrite;
    if (lowerWrite.reg != 0u &&
        decoded.suppressedLowerVf != lowerWrite.reg)
    {
        const uint32_t latency = decoded.lowerUsage.vfLatency != 0u
                                     ? decoded.lowerUsage.vfLatency
                                     : decoded.lowerUsage.latency;
        for (uint32_t component = 0; component < 4u; ++component)
        {
            if ((lowerWrite.lanes & laneForComponent(component)) != 0u)
                m_vfReady[lowerWrite.reg][component] = m_cycle + latency;
        }
        noteReady(m_cycle + latency);
    }

    const VfAccess upperWrite = decoded.upperUsage.vfWrite;
    if (upperWrite.reg != 0u)
    {
        const uint32_t latency = decoded.upperUsage.vfLatency != 0u
                                     ? decoded.upperUsage.vfLatency
                                     : decoded.upperUsage.latency;
        for (uint32_t component = 0; component < 4u; ++component)
        {
            if ((upperWrite.lanes & laneForComponent(component)) != 0u)
                m_vfReady[upperWrite.reg][component] = m_cycle + latency;
        }
        noteReady(m_cycle + latency);
    }

    for (uint32_t reg = 1; reg < m_viReady.size(); ++reg)
    {
        if ((decoded.lowerUsage.viWrite & (1u << reg)) != 0u)
        {
            m_viReady[reg] = m_cycle + (decoded.lowerUsage.viLatency != 0u ? decoded.lowerUsage.viLatency : decoded.lowerUsage.latency);
            noteReady(m_viReady[reg]);
        }
    }
    for (uint32_t component = 0; component < 4u; ++component)
    {
        if ((decoded.upperUsage.accWrite & laneForComponent(component)) != 0u)
        {
            m_accReady[component] = m_cycle + kAccForwardLatency;
            noteReady(m_accReady[component]);
        }
    }
}

VU1Interpreter::InstructionUsage VU1Interpreter::decodeUpperUsage(uint32_t upper) const
{
    InstructionUsage usage;
    usage.pipeline = PipelineFmac;
    usage.latency = kFmacLatency;

    const uint8_t op = static_cast<uint8_t>(upper & 0x3Fu);
    const uint8_t dest = DEST(upper);
    const uint8_t fs = FS(upper);
    const uint8_t ft = FT(upper);
    const uint8_t fd = FD(upper);

    if (op <= 0x2Fu)
    {
        addVfRead(usage, fs, dest);
        addVfWrite(usage, fd, dest);
        if (op <= 0x1Bu)
            addVfRead(usage, ft, laneForComponent(op & 3u));
        else if (op >= 0x28u)
            addVfRead(usage, ft, op == 0x2Eu ? 0xEu : dest);
        if (op == 0x08u || op == 0x09u || op == 0x0Au || op == 0x0Bu ||
            op == 0x0Cu || op == 0x0Du || op == 0x0Eu || op == 0x0Fu ||
            op == 0x21u || op == 0x23u || op == 0x25u || op == 0x27u ||
            op == 0x29u || op == 0x2Du || op == 0x2Eu)
        {
            usage.accRead = dest;
        }
        return usage;
    }

    if (op >= 0x3Cu)
    {
        const uint8_t special = static_cast<uint8_t>((upper & 3u) | ((upper >> 4) & 0x7Cu));
        const bool writesAcc =
            special <= 0x0Fu ||
            (special >= 0x18u && special <= 0x1Cu) ||
            special == 0x1Eu ||
            (special >= 0x20u && special <= 0x2Au) ||
            (special >= 0x2Cu && special <= 0x2Eu);
        if (writesAcc)
        {
            addVfRead(usage, fs, dest);
            if (special <= 0x1Bu)
                addVfRead(usage, ft, laneForComponent(special & 3u));
            else if ((special >= 0x28u && special <= 0x2Eu))
                addVfRead(usage, ft, special == 0x2Eu ? 0xEu : dest);
            usage.accWrite = dest;
            if ((special >= 0x08u && special <= 0x0Fu) ||
                special == 0x21u || special == 0x23u || special == 0x25u ||
                special == 0x27u || special == 0x29u || special == 0x2Du)
            {
                usage.accRead = dest;
            }
        }
        else if (special >= 0x10u && special <= 0x17u)
        {
            addVfRead(usage, fs, dest);
            addVfWrite(usage, ft, dest);
        }
        else if (special == 0x1Du)
        {
            addVfRead(usage, fs, dest);
            addVfWrite(usage, ft, dest);
        }
        else if (special == 0x1Fu)
        {
            addVfRead(usage, fs, 0xEu);
            addVfRead(usage, ft, 0x1u);
            usage.writesClip = true;
        }
        else if (special != 0x2Fu && special != 0x30u)
        {
            usage.reserved = true;
        }
        return usage;
    }

    usage.reserved = true;
    return usage;
}

VU1Interpreter::InstructionUsage VU1Interpreter::decodeLowerUsage(uint32_t lower) const
{
    InstructionUsage usage;
    if (lower == 0u || lower == 0x8000033Cu)
        return usage;

    const uint8_t opHi = static_cast<uint8_t>((lower >> 25) & 0x7Fu);
    const uint8_t vfT = FT(lower);
    const uint8_t vfS = FS(lower);
    const uint8_t viT = VIT(lower);
    const uint8_t viS = VIS(lower);
    const uint8_t viD = VID(lower);
    const uint8_t dest = DEST(lower);
    auto readVi = [&](uint8_t reg)
    {
        if (reg != 0u)
            usage.viRead |= static_cast<uint16_t>(1u << reg);
    };
    auto writeVi = [&](uint8_t reg)
    {
        if (reg != 0u)
            usage.viWrite |= static_cast<uint16_t>(1u << reg);
    };

    switch (opHi)
    {
    case 0x00:
        usage.pipeline = PipelineLsu;
        usage.latency = 4u;
        readVi(viS);
        addVfWrite(usage, vfT, dest);
        return usage;
    case 0x01:
        usage.pipeline = PipelineLsu;
        usage.latency = 1u;
        readVi(viT);
        addVfRead(usage, vfS, dest);
        return usage;
    case 0x04:
        usage.pipeline = PipelineLsu;
        usage.latency = 4u;
        readVi(viS);
        writeVi(viT);
        return usage;
    case 0x05:
        usage.pipeline = PipelineLsu;
        usage.latency = 1u;
        readVi(viS);
        readVi(viT);
        return usage;
    case 0x08:
    case 0x09:
        usage.pipeline = PipelineIalu;
        usage.latency = 1u;
        usage.delaysNextBranchRead = true;
        readVi(viS);
        writeVi(viT);
        return usage;
    case 0x10:
    case 0x12:
    case 0x13:
        usage.pipeline = PipelineIalu;
        usage.latency = 1u;
        usage.readsClip = true;
        writeVi(1u);
        return usage;
    case 0x11:
        usage.pipeline = PipelineFmac;
        usage.latency = kFmacLatency;
        usage.writesClip = true;
        return usage;
    case 0x14:
    case 0x16:
    case 0x17:
        usage.pipeline = PipelineIalu;
        usage.latency = 1u;
        writeVi(viT);
        return usage;
    case 0x15:
        usage.pipeline = PipelineFmac;
        usage.latency = kFmacLatency;
        return usage;
    case 0x18:
    case 0x1A:
    case 0x1B:
        usage.pipeline = PipelineIalu;
        usage.latency = 1u;
        readVi(viS);
        writeVi(viT);
        return usage;
    case 0x1C:
        usage.pipeline = PipelineIalu;
        usage.latency = 1u;
        usage.readsClip = true;
        writeVi(viT);
        return usage;
    case 0x20:
        usage.pipeline = PipelineBranch;
        return usage;
    case 0x21:
        usage.pipeline = PipelineBranch;
        usage.latency = 1u;
        writeVi(viT);
        return usage;
    case 0x24:
        usage.pipeline = PipelineBranch;
        readVi(viS);
        return usage;
    case 0x25:
        usage.pipeline = PipelineBranch;
        usage.latency = 1u;
        readVi(viS);
        writeVi(viT);
        return usage;
    case 0x28:
    case 0x29:
        usage.pipeline = PipelineBranch;
        readVi(viS);
        readVi(viT);
        return usage;
    case 0x2C:
    case 0x2D:
    case 0x2E:
    case 0x2F:
        usage.pipeline = PipelineBranch;
        readVi(viS);
        return usage;
    case 0x40:
        break;
    default:
        usage.reserved = true;
        return usage;
    }

    const uint8_t direct = static_cast<uint8_t>(lower & 0x3Fu);
    if (direct == 0x30u || direct == 0x31u || direct == 0x34u || direct == 0x35u)
    {
        usage.pipeline = PipelineIalu;
        usage.latency = 1u;
        usage.delaysNextBranchRead = true;
        readVi(viS);
        readVi(viT);
        writeVi(viD);
        return usage;
    }
    if (direct == 0x32u)
    {
        usage.pipeline = PipelineIalu;
        usage.latency = 1u;
        usage.delaysNextBranchRead = true;
        readVi(viS);
        writeVi(viT);
        return usage;
    }
    if (direct < 0x3Cu)
    {
        usage.reserved = true;
        return usage;
    }

    const uint8_t special = static_cast<uint8_t>((lower & 3u) | ((lower >> 4) & 0x7Cu));
    switch (special)
    {
    case 0x30:
    case 0x31:
        usage.pipeline = PipelineFmac;
        usage.latency = 4u;
        addVfRead(usage, vfS, special == 0x31u ? 0xFu : dest);
        addVfWrite(usage, vfT, dest);
        break;
    case 0x34:
    case 0x36:
        usage.pipeline = PipelineLsu;
        usage.latency = 4u;
        usage.viLatency = 1u;
        usage.delaysNextBranchRead = true;
        readVi(viS);
        writeVi(viS);
        addVfWrite(usage, vfT, dest);
        break;
    case 0x35:
    case 0x37:
        usage.pipeline = PipelineLsu;
        usage.latency = 1u;
        usage.delaysNextBranchRead = true;
        readVi(viT);
        writeVi(viT);
        addVfRead(usage, vfS, dest);
        break;
    case 0x38:
        usage.pipeline = PipelineFdiv;
        usage.latency = 7u;
        addVfRead(usage, vfS, laneForComponent((lower >> 21) & 3u));
        addVfRead(usage, vfT, laneForComponent((lower >> 23) & 3u));
        break;
    case 0x39:
        usage.pipeline = PipelineFdiv;
        usage.latency = 7u;
        addVfRead(usage, vfT, laneForComponent((lower >> 23) & 3u));
        break;
    case 0x3A:
        usage.pipeline = PipelineFdiv;
        usage.latency = 13u;
        addVfRead(usage, vfS, laneForComponent((lower >> 21) & 3u));
        addVfRead(usage, vfT, laneForComponent((lower >> 23) & 3u));
        break;
    case 0x3B:
        usage.pipeline = PipelineFdiv;
        usage.waitQ = true;
        break;
    case 0x3C:
        usage.pipeline = PipelineIalu;
        usage.latency = 1u;
        usage.delaysNextBranchRead = true;
        addVfRead(usage, vfS, laneForComponent((lower >> 21) & 3u));
        writeVi(viT);
        break;
    case 0x3D:
        usage.pipeline = PipelineFmac;
        usage.latency = 4u;
        readVi(viS);
        addVfWrite(usage, vfT, dest);
        break;
    case 0x3E:
        usage.pipeline = PipelineLsu;
        usage.latency = 4u;
        readVi(viS);
        writeVi(viT);
        break;
    case 0x3F:
        usage.pipeline = PipelineLsu;
        usage.latency = 1u;
        readVi(viS);
        readVi(viT);
        break;
    case 0x40:
    case 0x41:
        usage.pipeline = PipelineFmac;
        usage.latency = 4u;
        addVfWrite(usage, vfT, dest);
        break;
    case 0x42:
    case 0x43:
        usage.pipeline = PipelineIalu;
        usage.latency = 1u;
        addVfRead(usage, vfS, laneForComponent((lower >> 21) & 3u));
        break;
    case 0x64:
        if (m_unit == Unit::VU0)
        {
            usage.reserved = true;
            break;
        }
        usage.pipeline = PipelineFmac;
        usage.latency = 4u;
        addVfWrite(usage, vfT, dest);
        break;
    case 0x68:
    case 0x69:
        usage.pipeline = PipelineIalu;
        usage.latency = 1u;
        writeVi(viT);
        break;
    case 0x6C:
        if (m_unit == Unit::VU0)
        {
            usage.reserved = true;
            break;
        }
        usage.pipeline = PipelineXgkick;
        usage.latency = 2u;
        readVi(viS);
        break;
    case 0x70:
    case 0x71:
    case 0x72:
    case 0x73:
    case 0x74:
    case 0x75:
    case 0x76:
    case 0x77:
    case 0x78:
    case 0x79:
    case 0x7A:
    case 0x7C:
    case 0x7D:
        if (m_unit == Unit::VU0)
        {
            usage.reserved = true;
            break;
        }
        usage.pipeline = PipelineEfu;
        switch (special)
        {
        case 0x70:
            usage.latency = 11u;
            break;
        case 0x71:
        case 0x72:
        case 0x77:
            usage.latency = 18u;
            break;
        case 0x73:
            usage.latency = 24u;
            break;
        case 0x74:
        case 0x75:
        case 0x7C:
            usage.latency = 54u;
            break;
        case 0x76:
        case 0x78:
        case 0x7A:
            usage.latency = 12u;
            break;
        case 0x79:
            usage.latency = 29u;
            break;
        case 0x7D:
            usage.latency = 44u;
            break;
        default:
            break;
        }
        if (special >= 0x70u && special <= 0x73u)
            addVfRead(usage, vfS, 0xEu);
        else if (special == 0x74u)
            addVfRead(usage, vfS, 0xCu);
        else if (special == 0x75u)
            addVfRead(usage, vfS, 0xAu);
        else if (special == 0x76u)
            addVfRead(usage, vfS, 0xFu);
        else
            addVfRead(usage, vfS, laneForComponent((lower >> 21) & 3u));
        break;
    case 0x7B:
        if (m_unit == Unit::VU0)
        {
            usage.reserved = true;
            break;
        }
        usage.pipeline = PipelineEfu;
        usage.waitP = true;
        break;
    default:
        usage.reserved = true;
        break;
    }
    return usage;
}

VU1Interpreter::DecodedInstructionPair VU1Interpreter::decodeInstructionPair(const uint8_t *vuCode, uint32_t pc) const
{
    DecodedInstructionPair decoded;
    std::memcpy(&decoded.lower, vuCode + pc, sizeof(decoded.lower));
    std::memcpy(&decoded.upper, vuCode + pc + sizeof(decoded.lower), sizeof(decoded.upper));
    decoded.iBit = (decoded.upper & 0x80000000u) != 0u;
    decoded.eBit = (decoded.upper & 0x40000000u) != 0u;
    decoded.mBit = (decoded.upper & 0x20000000u) != 0u;
    decoded.dBit = (decoded.upper & 0x10000000u) != 0u;
    decoded.tBit = (decoded.upper & 0x08000000u) != 0u;
    decoded.upperUsage = decodeUpperUsage(decoded.upper);
    if (!decoded.iBit)
        decoded.lowerUsage = decodeLowerUsage(decoded.lower);

    const uint8_t upperWriteReg = decoded.upperUsage.vfWrite.reg;
    if (upperWriteReg != 0u && (vfReadLanes(decoded.lowerUsage, upperWriteReg) != 0u || decoded.lowerUsage.vfWrite.reg == upperWriteReg))
    {
        decoded.upperVfShadowReg = upperWriteReg;
        if (decoded.lowerUsage.vfWrite.reg == upperWriteReg)
            decoded.suppressedLowerVf = upperWriteReg;
    }
    return decoded;
}

void VU1Interpreter::rebuildDecodedCodeCache(const uint8_t *vuCode, uint32_t codeSize,
                                             const PS2Memory *memory, uint64_t generation)
{
    const uint32_t pairCount = std::min<uint32_t>(codeSize / 8u, kMaxDecodedPairs);
    for (uint32_t i = 0; i < pairCount; ++i)
        m_decodedCodeCache[i] = decodeInstructionPair(vuCode, i * 8u);

    m_cachedVuCode = vuCode;
    m_cachedMemory = memory;
    m_cachedCodeSize = codeSize;
    m_cachedCodeGeneration = generation;
    m_decodedCodeCacheValid = true;
}

const VU1Interpreter::DecodedInstructionPair &VU1Interpreter::getDecodedInstructionPairForPc(
    const uint8_t *vuCode, uint32_t codeSize, PS2Memory *memory, uint32_t pc)
{
    if ((pc & 7u) != 0u)
        return m_uncachedDecoded = decodeInstructionPair(vuCode, pc);

    const bool trackedVu1Code = memory != nullptr &&
                                ((m_unit == Unit::VU1 && vuCode == memory->getVU1Code()) ||
                                 (m_unit == Unit::VU0 && vuCode == memory->getVU0Code()));
    if (!trackedVu1Code)
        return m_uncachedDecoded = decodeInstructionPair(vuCode, pc);

    const uint64_t generation = m_unit == Unit::VU1 ? memory->getVU1CodeGeneration() : memory->getVU0CodeGeneration();
    if (!m_decodedCodeCacheValid ||
        m_cachedVuCode != vuCode ||
        m_cachedMemory != memory ||
        m_cachedCodeSize != codeSize ||
        m_cachedCodeGeneration != generation)
    {
        rebuildDecodedCodeCache(vuCode, codeSize, memory, generation);
    }
    const uint32_t pairIndex = pc / 8u;
    if (pairIndex >= kMaxDecodedPairs)
        return m_uncachedDecoded = decodeInstructionPair(vuCode, pc);
    return m_decodedCodeCache[pairIndex];
}

void VU1Interpreter::reportReservedInstruction(bool upper, uint32_t instruction)
{
    RUNTIME_ERROR(
        "[VU" << (m_unit == Unit::VU1 ? "1" : "0")
              << " reserved " << (upper ? "upper" : "lower")
              << "] cycle=" << m_cycle
              << " pc=0x" << std::hex << m_state.pc
              << " instruction=0x" << instruction
              << std::dec << '\n');
    m_stopRequested = true;
}

void VU1Interpreter::execute(uint8_t *vuCode, uint32_t codeSize,
                             uint8_t *vuData, uint32_t dataSize,
                             GS &gs, PS2Memory *memory,
                             uint32_t startPC, uint32_t top, uint32_t itop,
                             uint32_t maxCycles)
{
    resetScheduler();
    m_state.pc = startPC & microAddressMask();
    m_state.ebit = false;
    m_state.haltAfterDelaySlot = false;
    m_state.stoppedByD = false;
    m_state.stoppedByT = false;
    m_state.top = top;
    m_state.itop = itop;
    m_state.branchPending = false;
    m_state.branchTarget = 0;
    m_state.branchDelay = 0;
    m_state.vf[0][0] = 0.0f;
    m_state.vf[0][1] = 0.0f;
    m_state.vf[0][2] = 0.0f;
    m_state.vf[0][3] = 1.0f;
    run(vuCode, codeSize, vuData, dataSize, gs, memory, maxCycles);
}

void VU1Interpreter::resume(uint8_t *vuCode, uint32_t codeSize,
                            uint8_t *vuData, uint32_t dataSize,
                            GS &gs, PS2Memory *memory,
                            uint32_t top, uint32_t itop, uint32_t maxCycles)
{
    m_state.top = top;
    m_state.itop = itop;
    m_state.stoppedByD = false;
    m_state.stoppedByT = false;
    run(vuCode, codeSize, vuData, dataSize, gs, memory, maxCycles);
}

void VU1Interpreter::runToEnd(uint8_t *vuCode, uint32_t codeSize, uint8_t *vuData, uint32_t dataSize,
                              GS &gs, PS2Memory *memory)
{
    const uint64_t guardEnd = m_cycle + kVifCycleGuard;
    while (m_programPending)
    {
        const uint64_t before = m_cycle;
        run(vuCode, codeSize, vuData, dataSize, gs, memory, kVifCycleSlice);
        if (m_programPending && (m_cycle == before || m_cycle >= guardEnd))
        {
            // No progress (a program that ran off its code) or a runaway program: dropped, so the VIF
            // can go on. Logged once; the hardware would hang here.
            static bool s_logged = false;
            if (!s_logged)
            {
                s_logged = true;
                std::fprintf(stderr, "[vu1] program at pc=0x%x dropped: %s\n", m_state.pc,
                             m_cycle == before ? "no progress" : "past the runaway guard");
            }
            m_programPending = false;
            break;
        }
    }
}

void VU1Interpreter::executeProgram(uint8_t *vuCode, uint32_t codeSize, uint8_t *vuData, uint32_t dataSize,
                                    GS &gs, PS2Memory *memory, uint32_t startPC, uint32_t top, uint32_t itop)
{
    if (m_programPending)
        runToEnd(vuCode, codeSize, vuData, dataSize, gs, memory);
    execute(vuCode, codeSize, vuData, dataSize, gs, memory, startPC, top, itop, kVifCycleSlice);
    runToEnd(vuCode, codeSize, vuData, dataSize, gs, memory);
}

void VU1Interpreter::continueProgram(uint8_t *vuCode, uint32_t codeSize, uint8_t *vuData, uint32_t dataSize,
                                     GS &gs, PS2Memory *memory, uint32_t top, uint32_t itop)
{
    if (m_programPending)
        runToEnd(vuCode, codeSize, vuData, dataSize, gs, memory);
    resume(vuCode, codeSize, vuData, dataSize, gs, memory, top, itop, kVifCycleSlice);
    runToEnd(vuCode, codeSize, vuData, dataSize, gs, memory);
}

// ============================================================================
// Fast path: same instruction semantics, no per-cycle scheduler.
// ============================================================================

// The fast path's flag ring (m_flagPipeline, m_fastFlagHead, m_fastFlagCount): its invariants, which
// both drains below keep (S17 F C2, research/81; ps2xTest vu1_ops_tests.cpp "flag ring" cases).
//
// Producers (fast mode only; the exact path allocates the first !valid slot instead):
//   * fastPushMacFlags -- every FMAC with a dest (execUpper via pushFmacFlags, Vu1Gen::fmac):
//     writesMac + writesStatus, mac, the lane status, the product's extraSticky, issuePc.
//   * queueFsset (FSSET), queueClip (CLIP), queueFcset (FCSET) -- through fastPushFlags:
//     writesSticky (status & 0xFC0), writesClip (the 24-bit working clip).
//   Not producers: queueStore and the VF/VI/ACC writes land at once in fast mode; Q (m_fdiv) and P
//   (m_efu) have their own slots, drained after the ring, in ready order.
// Order: the live entries are slots head .. head + count - 1 (mod 64), in issue order. Entries land
//   in that order and a later one wins: MAC and m_lastMacPc (overwrite), STATUS bits 0-3 (overwrite),
//   STATUS bits 6-11 (FMAC ORs (current | extraSticky) << 6 into them; FSSET replaces them),
//   bits 4-5 (FDIV's D/I) untouched by the ring, CLIP (overwrite). Two FMACs in one cycle: the
//   second's MAC and current bits win, both OR their sticky bits. An FSSET or FCSET clears
//   writesStatus / writesClip of every valid entry issued in the same cycle (so an FMAC beside
//   an FSSET lands its MAC but not its STATUS); an entry may therefore write nothing.
// Delay: every entry is ready at issueCycle + kFmacLatency (4); m_cycle does not go back while the
//   ring is live, so ready cycles do not decrease along it -- but a drain stops at the first entry
//   not yet ready and never lands one behind it. m_nextReadyCycle is at most the head's ready cycle.
// valid: set by every push, and true exactly for the live slots. Its readers: queueFsset and
//   queueFcset (all 64 slots, `valid && issueCycle == m_cycle`), pipelinesPending (any valid slot is
//   pending work), and the exact path (first !valid slot to fill; commitReadyPipelines skips
//   !valid) should m_fast change between programs. No reader looks at any other field of a !valid
//   slot, and every push writes all of an entry's fields, so a drain need only clear `valid` --
//   but it must clear it: a stale valid bit is a phantom entry to all three readers.
template <bool Batch>
void VU1Interpreter::fastCommitWith()
{
    if (m_cycle < m_nextReadyCycle)
        return;
    if (!Batch)
    {
        // The old path: every landed entry writes the state, clears its 48 bytes and moves the head.
        while (m_fastFlagCount != 0u)
        {
            FlagPipelineEntry &entry = m_flagPipeline[m_fastFlagHead];
            if (entry.readyCycle > m_cycle)
                break;
            if (entry.writesMac)
            {
                m_state.mac = entry.mac;
                m_lastMacPc = entry.issuePc;
            }
            if (entry.writesStatus)
            {
                const uint32_t current = entry.status & 0xFu;
                m_state.status = (m_state.status & 0xFF0u) | current | ((current | entry.extraSticky) << 6);
            }
            if (entry.writesSticky)
                m_state.status = (m_state.status & 0x03Fu) | (entry.status & 0xFC0u);
            if (entry.writesClip)
                m_state.clip = entry.clip;
            entry = {};
            m_fastFlagHead = (m_fastFlagHead + 1u) % kMaxFlagEntries;
            --m_fastFlagCount;
        }
    }
    else if (m_fastFlagCount != 0u)
    {
        // PS2X_VU1_COMMIT_BATCH=1: the ready run folds into locals with the same per-entry formulas
        // (the native file's commitFmacFlags copy stays in sync), the state, head and count are
        // written once, and a landed slot only loses its valid bit.
        uint32_t count = m_fastFlagCount;
        uint32_t head = m_fastFlagHead;
        uint32_t mac = m_state.mac;
        uint32_t status = m_state.status;
        uint32_t clip = m_state.clip;
        uint32_t lastMacPc = m_lastMacPc;
        const uint64_t now = m_cycle;
        do
        {
            FlagPipelineEntry &entry = m_flagPipeline[head];
            if (entry.readyCycle > now)
                break;
            if (entry.writesMac)
            {
                mac = entry.mac;
                lastMacPc = entry.issuePc;
            }
            if (entry.writesStatus)
            {
                const uint32_t current = entry.status & 0xFu;
                status = (status & 0xFF0u) | current | ((current | entry.extraSticky) << 6);
            }
            if (entry.writesSticky)
                status = (status & 0x03Fu) | (entry.status & 0xFC0u);
            if (entry.writesClip)
                clip = entry.clip;
            entry.valid = false;
            head = (head + 1u) % kMaxFlagEntries;
        } while (--count != 0u);
        m_state.mac = mac;
        m_state.status = status;
        m_state.clip = clip;
        m_lastMacPc = lastMacPc;
        m_fastFlagHead = head;
        m_fastFlagCount = count;
    }
    if (m_fdiv.valid && m_fdiv.readyCycle <= m_cycle)
    {
        m_state.q = m_fdiv.value;
        const uint32_t currentDi = m_fdiv.statusDi & 0x30u;
        m_state.status = (m_state.status & 0xFCFu) | currentDi | (currentDi << 6);
        m_fdiv = {};
    }
    // EFU results land in ready order (the exact path commits one cycle at a time).
    for (;;)
    {
        ScalarPipelineEntry *oldest = nullptr;
        for (ScalarPipelineEntry &entry : m_efu)
            if (entry.valid && entry.readyCycle <= m_cycle && (!oldest || entry.readyCycle < oldest->readyCycle))
                oldest = &entry;
        if (!oldest)
            break;
        m_state.p = oldest->value;
        *oldest = {};
    }
    uint64_t next = ~0ull;
    if (m_fastFlagCount != 0u)
        next = m_flagPipeline[m_fastFlagHead].readyCycle;
    if (m_fdiv.valid && m_fdiv.readyCycle < next)
        next = m_fdiv.readyCycle;
    for (const ScalarPipelineEntry &entry : m_efu)
        if (entry.valid && entry.readyCycle < next)
            next = entry.readyCycle;
    m_nextReadyCycle = next;
}
template void VU1Interpreter::fastCommitWith<false>();
template void VU1Interpreter::fastCommitWith<true>();

// PS2X_VU1_COMMIT_BATCH (Dev Flag, default 0 = the per-entry drain, R334), read once; run() copies
// it into s_vu1CommitBatch so fastCommit reads a plain bool.
bool VU1Interpreter::fastCommitBatchKnob()
{
    static const bool s_on = ps2x::knobOn("PS2X_VU1_COMMIT_BATCH");
    return s_on;
}

namespace
{
    bool s_vu1CommitBatch = false;
}

void VU1Interpreter::fastCommit()
{
    if (s_vu1CommitBatch)
        fastCommitWith<true>();
    else
        fastCommitWith<false>();
}

// Program end: every queued result lands; the cycle counter advances to the last landing like the
// exact path's flushPipelines().
void VU1Interpreter::fastFlush()
{
    uint64_t last = m_cycle;
    for (uint32_t i = 0; i < m_fastFlagCount; ++i)
        last = std::max(last, m_flagPipeline[(m_fastFlagHead + i) % kMaxFlagEntries].readyCycle);
    if (m_fdiv.valid)
        last = std::max(last, m_fdiv.readyCycle);
    for (const ScalarPipelineEntry &entry : m_efu)
        if (entry.valid)
            last = std::max(last, entry.readyCycle);
    m_cycle = last;
    m_state.cycles = m_cycle;
    m_nextReadyCycle = 0;
    fastCommit();
}

uint64_t VU1Interpreter::fastReadyCycle(const DecodedInstructionPair &decoded) const
{
    uint64_t ready = m_cycle;
    if (decoded.lowerUsage.pipeline == PipelineXgkick && m_xgkick.active)
        ready = m_cycle + 1u;
    if (m_cycle >= m_maxReadyCycle)
        return ready;

    const InstructionUsage *usages[2] = {&decoded.upperUsage, &decoded.lowerUsage};
    for (const InstructionUsage *usage : usages)
    {
        for (uint32_t index = 0; index < usage->vfReadCount; ++index)
        {
            const VfAccess &access = usage->vfRead[index];
            const uint64_t *readyLanes = m_vfReady[access.reg].data();
            if (access.lanes & 0x8u)
                ready = std::max(ready, readyLanes[0]);
            if (access.lanes & 0x4u)
                ready = std::max(ready, readyLanes[1]);
            if (access.lanes & 0x2u)
                ready = std::max(ready, readyLanes[2]);
            if (access.lanes & 0x1u)
                ready = std::max(ready, readyLanes[3]);
        }
        uint32_t viMask = usage->viRead & 0xFFFEu;
        while (viMask != 0u)
        {
            const uint32_t reg = static_cast<uint32_t>(__builtin_ctz(viMask));
            ready = std::max(ready, m_viReady[reg]);
            viMask &= viMask - 1u;
        }
        // ACC is forwarded one cycle after its write: the next pair never stalls on it.
    }

    if (decoded.lowerUsage.pipeline == PipelineFdiv && m_fdiv.valid)
        ready = std::max(ready, m_fdiv.readyCycle);
    if (decoded.lowerUsage.pipeline == PipelineEfu)
        ready = std::max(ready, m_efuResourceReady);
    if (decoded.lowerUsage.waitQ && m_fdiv.valid)
        ready = std::max(ready, m_fdiv.readyCycle);
    if (decoded.lowerUsage.waitP)
    {
        for (const ScalarPipelineEntry &entry : m_efu)
            if (entry.valid)
                ready = std::max(ready, entry.readyCycle);
    }
    return ready;
}

// Presented-frame counters for the PS2X_VU_STATS line (incremented in Kernel/Stubs/GS.cpp).
std::atomic<uint64_t> g_gsSwapDBuffCount{0};
std::atomic<uint64_t> g_gsSyncVCount{0};
std::atomic<uint64_t> g_vu0Programs{0};

namespace
{
    // Saves the x87 control word and MXCSR, sets both rounding controls to "toward zero"
    // (x87 RC = 11b at bits 10-11, MXCSR RC = 11b at bits 13-14) and restores them on request.
    struct VuRoundingScope
    {
        uint16_t x87 = 0;
        uint32_t mxcsr = 0;
        VuRoundingScope()
        {
            __asm__ __volatile__("fnstcw %0" : "=m"(x87));
            mxcsr = _mm_getcsr();
            const uint16_t x87Tz = static_cast<uint16_t>(x87 | 0x0C00u);
            __asm__ __volatile__("fldcw %0" : : "m"(x87Tz));
            _mm_setcsr(mxcsr | 0x6000u);
        }
        void restore() const
        {
            __asm__ __volatile__("fldcw %0" : : "m"(x87));
            _mm_setcsr(mxcsr);
        }
    };
}

// vu1_replay --pchist: per-pair execution counts of the fast path (2048 entries, VU1 only).
uint32_t *g_vu1PcHist = nullptr;
// vu1_replay --gen: per-pc counts of JR/JALR targets (the generated code needs the set of pcs a
// computed jump can land on; other targets hand back to the interpreter).
uint32_t *g_vu1JrHist = nullptr;
// vu1_replay --bailhist: per-pc count of generated-code hand-backs to the interpreter.
uint32_t *g_vu1BailHist = nullptr;
uint64_t g_vu1GenEntered = 0, g_vu1GenEnded = 0, g_vu1GenSkipped = 0; // known-program dispatch counters
uint64_t g_vu1UnknownImagePrograms = 0; // programs run by the interpreter because their image has no generated code
uint64_t g_vu1GenHandBacks = 0;          // generated code handed the rest of a program to the interpreter

// Known-program table (src/lib/vu/generated/vu1_known_programs.cpp).
struct Vu1KnownProgram
{
    uint64_t hash;
    VU1Interpreter::KnownProgramFn fn;
};
extern const Vu1KnownProgram g_vu1KnownPrograms[];
extern const uint32_t g_vu1KnownProgramCount;

// Native-program registry (src/lib/vu/native/vu1_native_programs.cpp): hand-written host
// replacements of one microprogram entry point, keyed by (image hash, entry pc).
extern const Vu1NativeProgram g_vu1NativePrograms[];
extern const uint32_t g_vu1NativeProgramCount;
std::atomic<uint64_t> g_vu1NativeEntered{0}, g_vu1NativeEnded{0}, g_vu1NativeHandBacks{0};
// PS2X_VU1_NATIVE selects them; on by default since the 0x1b50 dispatcher was verified against
// the microcode (76/76 family-A lists native across dump2/3/4) and gated green on title,
// transition and mission. PS2X_VU1_NATIVE=0 reverts to the generated path.
constexpr bool kVu1NativeDefault = true;

void VU1Interpreter::setNativeProgramsOverride(const Vu1NativeProgram *table, uint32_t count)
{
    m_nativeTable = table;
    m_nativeCount = count;
    m_knownGeneration = ~0ull; // force the image hash to be recomputed on the next run
}

void VU1Interpreter::runFast(uint8_t *vuCode, uint32_t codeSize,
                             uint8_t *vuData, uint32_t dataSize,
                             GS &gs, PS2Memory *memory, uint64_t budgetEnd, bool &programEnded)
{
    uint64_t pairs = 0;
    // The microprogram cannot change while it runs: validate the decoded-code cache once and index
    // it directly (pc is always pair-aligned: it advances by 8 and every branch target is a pair).
    const bool cached = memory != nullptr && vuCode == memory->getVU1Code() && codeSize / 8u <= kMaxDecodedPairs;
    if (cached)
        (void)getDecodedInstructionPairForPc(vuCode, codeSize, memory, 0u);
    const uint32_t codeMask = microAddressMask();
    while (m_cycle < budgetEnd && !m_stopRequested)
    {
        if (m_state.pc + 8u > codeSize)
            break;

        const DecodedInstructionPair &decoded = (cached && (m_state.pc & 7u) == 0u)
                                                    ? m_decodedCodeCache[m_state.pc >> 3]
                                                    : getDecodedInstructionPairForPc(vuCode, codeSize, memory, m_state.pc);
        if (g_vu1PcHist)
            ++g_vu1PcHist[(m_state.pc >> 3) & 0x7FFu];
        if (decoded.upperUsage.reserved || decoded.lowerUsage.reserved)
        {
            reportReservedInstruction(decoded.upperUsage.reserved, decoded.upperUsage.reserved ? decoded.upper : decoded.lower);
            break;
        }
        ++pairs;

        const uint64_t readyCycle = fastReadyCycle(decoded);
        if (readyCycle > m_cycle)
        {
            if (readyCycle >= budgetEnd)
            {
                m_cycle = budgetEnd;
                break;
            }
            m_cycle = readyCycle;
        }
        fastCommit();

        uint8_t writtenVi = 0u;
        int32_t oldVi = 0;
        const uint32_t viWriteMask = decoded.lowerUsage.viWrite & 0xFFFEu;
        if (viWriteMask != 0u)
        {
            writtenVi = static_cast<uint8_t>(__builtin_ctz(viWriteMask));
            oldVi = m_state.vi[writtenVi];
        }

        if (decoded.iBit)
        {
            execUpper(decoded.upper);
            float immediate = 0.0f;
            std::memcpy(&immediate, &decoded.lower, sizeof(immediate));
            m_state.i = normalizeOperand(immediate);
        }
        else if (decoded.upperVfShadowReg != 0u)
        {
            // The lower instruction reads (or writes) the upper's destination: it sees the old
            // value, and the upper's result wins over a lower write to the same register.
            float oldVf[4]{};
            float upperVf[4]{};
            std::memcpy(oldVf, m_state.vf[decoded.upperVfShadowReg], sizeof(oldVf));
            execUpper(decoded.upper);
            std::memcpy(upperVf, m_state.vf[decoded.upperVfShadowReg], sizeof(upperVf));
            std::memcpy(m_state.vf[decoded.upperVfShadowReg], oldVf, sizeof(oldVf));
            execLower(decoded.lower, vuData, dataSize, gs, memory, decoded.upper);
            std::memcpy(m_state.vf[decoded.upperVfShadowReg], upperVf, sizeof(upperVf));
        }
        else
        {
            execUpper(decoded.upper);
            execLower(decoded.lower, vuData, dataSize, gs, memory, decoded.upper);
        }

        m_viBranchBackupValid = false;

        // Ready cycles of the written registers (the only scheduler state the fast path keeps).
        {
            const VfAccess lowerWrite = decoded.lowerUsage.vfWrite;
            if (lowerWrite.reg != 0u && decoded.suppressedLowerVf != lowerWrite.reg)
            {
                const uint64_t ready = m_cycle + (decoded.lowerUsage.vfLatency != 0u ? decoded.lowerUsage.vfLatency : decoded.lowerUsage.latency);
                uint64_t *lanes = m_vfReady[lowerWrite.reg].data();
                if (lowerWrite.lanes & 0x8u) lanes[0] = ready;
                if (lowerWrite.lanes & 0x4u) lanes[1] = ready;
                if (lowerWrite.lanes & 0x2u) lanes[2] = ready;
                if (lowerWrite.lanes & 0x1u) lanes[3] = ready;
                noteReady(ready);
            }
            const VfAccess upperWrite = decoded.upperUsage.vfWrite;
            if (upperWrite.reg != 0u)
            {
                const uint64_t ready = m_cycle + (decoded.upperUsage.vfLatency != 0u ? decoded.upperUsage.vfLatency : decoded.upperUsage.latency);
                uint64_t *lanes = m_vfReady[upperWrite.reg].data();
                if (upperWrite.lanes & 0x8u) lanes[0] = ready;
                if (upperWrite.lanes & 0x4u) lanes[1] = ready;
                if (upperWrite.lanes & 0x2u) lanes[2] = ready;
                if (upperWrite.lanes & 0x1u) lanes[3] = ready;
                noteReady(ready);
            }
            uint32_t mask = viWriteMask;
            if (mask != 0u)
            {
                const uint64_t ready = m_cycle + (decoded.lowerUsage.viLatency != 0u ? decoded.lowerUsage.viLatency : decoded.lowerUsage.latency);
                while (mask != 0u)
                {
                    m_viReady[__builtin_ctz(mask)] = ready;
                    mask &= mask - 1u;
                }
                noteReady(ready);
            }
        }
        if (writtenVi != 0u && decoded.lowerUsage.delaysNextBranchRead)
            recordViWriteForBranch(writtenVi, oldVi);

        // vf0/vi0 are constant; one 16-byte store (four scalar stores followed by the FMAC's vector
        // load of vf0 would stall store forwarding).
        _mm_storeu_ps(m_state.vf[0], _mm_set_ps(1.0f, 0.0f, 0.0f, 0.0f));
        m_state.vi[0] = 0;

        uint32_t nextPc = m_state.pc + 8u;
        if (nextPc >= codeSize)
            nextPc = 0u;
        m_state.pc = nextPc;

        if (m_state.branchPending)
        {
            if (m_state.branchDelay == 0u)
            {
                m_state.pc = m_state.branchTarget & codeMask;
                m_state.branchPending = false;
            }
            else
            {
                --m_state.branchDelay;
            }
        }

        ++m_cycle;
        // Program end: E bit (one more pair runs), D/T bits when enabled, or a pending halt.
        if (decoded.eBit | decoded.dBit | decoded.tBit | m_state.ebit | m_state.haltAfterDelaySlot)
        {
            const bool dHalt = decoded.dBit && m_state.dBitEnabled;
            const bool tHalt = decoded.tBit && m_state.tBitEnabled;
            const bool haltBit = dHalt || tHalt;
            const bool haltBranch = haltBit && decoded.lowerUsage.pipeline == PipelineBranch;

            if (m_state.haltAfterDelaySlot)
            {
                m_state.stoppedByD = m_pendingHaltD;
                m_state.stoppedByT = m_pendingHaltT;
                programEnded = true;
            }
            else if (m_state.ebit)
                programEnded = true;
            else if (haltBit && !haltBranch)
            {
                m_state.stoppedByD = dHalt;
                m_state.stoppedByT = tHalt;
                programEnded = true;
            }
            else if (decoded.eBit)
                m_state.ebit = true;
            else if (haltBranch)
            {
                m_state.haltAfterDelaySlot = true;
                m_pendingHaltD = dHalt;
                m_pendingHaltT = tHalt;
            }
            if (programEnded)
                break;
        }
    }
    m_state.cycles = m_cycle;
    g_vuInsnCount.fetch_add(pairs, std::memory_order_relaxed);
}

void VU1Interpreter::run(uint8_t *vuCode, uint32_t codeSize,
                         uint8_t *vuData, uint32_t dataSize,
                         GS &gs, PS2Memory *memory, uint32_t maxCycles)
{
    // Valid only for the length of this call: every user (the XGKICK pipeline, execLower, and
    // activeGs() in the native VU1 programs) reads them from inside run(). ActiveScope clears them
    // again on every way out, so nothing outside a run can be handed a stale GS pointer or a stale
    // VU data pointer the caller may since have freed or repurposed.
    m_activeVuData = vuData;
    m_activeVuDataSize = dataSize;
    m_activeGs = &gs;
    m_activeMemory = memory;
    struct ActiveScope
    {
        VU1Interpreter *vu;
        ~ActiveScope()
        {
            vu->m_activeVuData = nullptr;
            vu->m_activeVuDataSize = 0u;
            vu->m_activeGs = nullptr;
            vu->m_activeMemory = nullptr;
        }
    } activeScope{this};

    // PS2X_VU1_DUMP=<dir>[:<count>]: once PS2X_TRIGGER has armed the traces, save the next <count>
    // (default 150) VU1 program runs as <dir>/vu1_prog_<n>.bin: 16 bytes header (startPc, top,
    // itop, codeSize) + code (16 KB) + data (16 KB) + vi[16] + vf[32][4]. Replay offline with
    // vu1_replay + tools_py/gif_packets.py.
    if (m_unit == Unit::VU1)
    {
        static const char *s_dumpEnv = ps2x::knob("PS2X_VU1_DUMP");
        extern std::atomic<bool> g_ps2xTraceArmed;
        // PS2X_VU1_DUMP_AFTER=<seconds>: arm the dump on a timer instead of PS2X_TRIGGER (title /
        // online screens have no convenient trigger value).
        static const double s_dumpAfter = ps2x::knob("PS2X_VU1_DUMP_AFTER") ? std::atof(ps2x::knob("PS2X_VU1_DUMP_AFTER")) : 0.0;
        static const auto s_dumpStart = std::chrono::steady_clock::now();
        const bool timerArmed = s_dumpAfter > 0.0 &&
                                std::chrono::duration<double>(std::chrono::steady_clock::now() - s_dumpStart).count() >= s_dumpAfter;
        if (s_dumpEnv && (g_ps2xTraceArmed.load(std::memory_order_relaxed) || timerArmed))
        {
            static std::string s_dumpDir;
            static int s_dumpMax = 150;
            static int s_dumped = 0;
            if (s_dumpDir.empty())
            {
                s_dumpDir = s_dumpEnv;
                const size_t colon = s_dumpDir.find_last_of(':');
                if (colon != std::string::npos && colon > 1)   // not the drive letter
                {
                    s_dumpMax = std::atoi(s_dumpDir.c_str() + colon + 1);
                    s_dumpDir = s_dumpDir.substr(0, colon);
                }
            }
            if (s_dumped < s_dumpMax)
            {
                const std::string path = s_dumpDir + "/vu1_prog_" + std::to_string(s_dumped) + ".bin";
                if (FILE *fp = std::fopen(path.c_str(), "wb"))
                {
                    const uint32_t hdr[4] = {m_state.pc, m_state.top, m_state.itop, codeSize};
                    std::fwrite(hdr, sizeof(hdr), 1, fp);
                    std::fwrite(vuCode, 1, std::min<uint32_t>(codeSize, 0x4000u), fp);
                    std::fwrite(vuData, 1, std::min<uint32_t>(dataSize, 0x4000u), fp);
                    std::fwrite(m_state.vi, sizeof(m_state.vi), 1, fp);
                    std::fwrite(m_state.vf, sizeof(m_state.vf), 1, fp);
                    std::fclose(fp);
                    if (s_dumped < 3 || s_dumped + 1 == s_dumpMax)
                        std::fprintf(stderr, "[vu1-dump] #%d pc=0x%x top=0x%x itop=0x%x -> %s\n", s_dumped, m_state.pc, m_state.top, m_state.itop, path.c_str());
                }
                ++s_dumped;
            }
        }
    }

    // PS2X_TRACE_VU: dump the executed PC path of the first VU1 program that contains a reachable
    // XGKICK, to locate where control flow diverges from the geometry-kick (xgDec stays 0).
    // PS2X_TRACE_VU=<skip>: skip that many VU1 programs first (0 = trace from boot), then dump
    // the next three, so the trace can be aimed at a later screen (menu, mission).
    static std::atomic<int> s_vuTraceDumped{0};
    static std::atomic<uint64_t> s_vuTraceSeen{0};
    static const int s_vuTraceSkip = ps2x::knob("PS2X_TRACE_VU") ? std::atoi(ps2x::knob("PS2X_TRACE_VU")) : 0;
    bool traceThis = false;
    uint32_t traceFirstXg = 0xFFFFFFFFu;
    static const bool s_vuTraceEnv = ps2x::knob("PS2X_TRACE_VU") != nullptr;
    if (m_unit == Unit::VU1 && s_vuTraceEnv &&
        s_vuTraceSeen.fetch_add(1, std::memory_order_relaxed) >= static_cast<uint64_t>(s_vuTraceSkip) &&
        s_vuTraceDumped.load(std::memory_order_relaxed) < 3)
    {
        for (uint32_t p = m_state.pc & ~0x7u; p + 8u <= codeSize; p += 8u)
        {
            uint32_t lo, up;
            std::memcpy(&lo, vuCode + p, 4);
            std::memcpy(&up, vuCode + p + 4, 4);
            const uint32_t opHi = (lo >> 25) & 0x7Fu, funct = lo & 0x3Fu;
            const uint32_t funct2 = (lo & 3u) | ((lo >> 4) & 0x7Cu);
            if (opHi == 0x40u && funct >= 0x3Cu && funct2 == 0x6Cu) { traceFirstXg = p; break; }
            if (up & 0x40000000u) break;
        }
        if (traceFirstXg != 0xFFFFFFFFu)
        {
            traceThis = true;
            // Dump the input header the program reads (VU data memory at TOP*16 and at buffer 0),
            // to tell whether the branch-over-XGKICK is due to empty input (data not reaching VU
            // memory) or a legitimately idle frame.
            const uint32_t topOff = (m_state.top & 0x3FFu) * 16u;
            uint32_t h0[4] = {0}, hT[4] = {0};
            if (16u <= dataSize) std::memcpy(h0, vuData, 16);
            if (topOff + 16u <= dataSize) std::memcpy(hT, vuData + topOff, 16);
            std::fprintf(stderr, "[vu-trace] start pc=0x%x firstXGKICK=0x%x top=0x%x itop=0x%x "
                         "hdr@0=[%08x %08x %08x %08x] hdr@TOP=[%08x %08x %08x %08x]\n",
                         m_state.pc, traceFirstXg, m_state.top, m_state.itop,
                         h0[0], h0[1], h0[2], h0[3], hT[0], hT[1], hT[2], hT[3]);
            // Constants the shell program reads by absolute address (eye position at 30, viewport at 27/38...).
            for (uint32_t q = 24u; q < 48u; ++q)
            {
                uint32_t w[4] = {0};
                if ((q + 1u) * 16u <= dataSize) std::memcpy(w, vuData + q * 16u, 16);
                std::fprintf(stderr, "[vu-trace]   data@%u=[%08x %08x %08x %08x]\n", q, w[0], w[1], w[2], w[3]);
            }
            // The 32 qwords behind the header at TOP (the packet body the program consumes).
            for (uint32_t q = 0u; q < 32u; ++q)
            {
                uint32_t w[4] = {0};
                if (topOff + (q + 1u) * 16u <= dataSize)
                    std::memcpy(w, vuData + topOff + q * 16u, 16);
                std::fprintf(stderr, "[vu-trace]   data@TOP+%u=[%08x %08x %08x %08x]\n", q, w[0], w[1], w[2], w[3]);
            }
            // Dump the whole VU1 data memory for each traced program (vu1_data_<n>.bin).
            {
                const char *dir = ps2x::knob("PS2X_FRAME_DUMP");
                const std::string path = std::string(dir ? dir : "logs") + "/vu1_data_" +
                                         std::to_string(s_vuTraceDumped.load(std::memory_order_relaxed)) + ".bin";
                if (FILE *fp = std::fopen(path.c_str(), "wb"))
                {
                    std::fwrite(vuData, 1, dataSize, fp);
                    std::fclose(fp);
                    std::fprintf(stderr, "[vu-trace] wrote %s (%u bytes)\n", path.c_str(), dataSize);
                }
            }
            // Dump the whole microprogram once (disassemble with tools_py/vu1dis.py).
            static bool s_codeDumped = false;
            if (!s_codeDumped)
            {
                s_codeDumped = true;
                const char *dir = ps2x::knob("PS2X_FRAME_DUMP");
                const std::string path = std::string(dir ? dir : "logs") + "/vu1_code.bin";
                if (FILE *fp = std::fopen(path.c_str(), "wb"))
                {
                    std::fwrite(vuCode, 1, codeSize, fp);
                    std::fclose(fp);
                    std::fprintf(stderr, "[vu-trace] wrote %s (%u bytes)\n", path.c_str(), codeSize);
                }
            }
        }
    }
    uint32_t traceSteps = 0u;

    // Frame-dump counters: how many VU1 programs start with the "kick" bit (bit 1 of the input
    // header's w word at TOP) set, versus all programs. The game's shell microprogram only reaches
    // its XGKICK when that bit is set (IAND vi09, hdr.w, 2; IBEQ vi09, vi00 -> skip).
    if (m_unit == Unit::VU1 && m_state.pc == 0u)
    {
        const uint32_t topOff = (m_state.top & 0x3FFu) * 16u;
        uint32_t hdrW = 0u;
        if (topOff + 16u <= dataSize)
            std::memcpy(&hdrW, vuData + topOff + 12u, 4);
        g_vuProgramsAtZero.fetch_add(1, std::memory_order_relaxed);
        if (hdrW & 2u)
            g_vuProgramsKickBit.fetch_add(1, std::memory_order_relaxed);
    }

    // Round toward zero on both the x87 control word (the long double FMAC slow path) and MXCSR
    // (the SSE fast path) — what fesetround(FE_TOWARDZERO) does, without the two ucrtbase calls
    // (fegetround + 2x fesetround measured 142 ns per run(); VU0 macro programs run per frame
    // by the thousand).
    const VuRoundingScope roundingScope;
    const uint64_t budgetEnd = m_cycle + maxCycles;
    const uint64_t runStartCycle = m_cycle;
    // Only VU1 accounts its host time (guest clock exclusion, [vu1-stats]); VU0 macro programs
    // run far more often and took two clock reads each.
    const auto runStart = m_unit == Unit::VU1 ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
    if (m_unit != Unit::VU1)
        g_vu0Programs.fetch_add(1, std::memory_order_relaxed);
    bool programEnded = false;
    // Fast path on by default since 2026-09-09 (verified in the mission: title, intro and gameplay
    // clean, 18 ns/cycle vs 100); PS2X_VU1_FAST=0 selects the cycle-exact scheduler, which a VU
    // trace also forces.
    static const bool s_fastEnv = ps2x::knob("PS2X_VU1_FAST") == nullptr || std::atoi(ps2x::knob("PS2X_VU1_FAST")) != 0;
    // VU0 micro programs (VCALLMS) share the same instruction semantics; PS2X_VU0_FAST=0 keeps them on
    // the cycle-exact scheduler (they were ~4.5% of the game thread on it, STATUS 2026-09-09).
    static const bool s_vu0FastEnv = ps2x::knob("PS2X_VU0_FAST") == nullptr || std::atoi(ps2x::knob("PS2X_VU0_FAST")) != 0;
    m_fast = s_fastEnv && (m_unit == Unit::VU1 || s_vu0FastEnv) && !traceThis;
    // S17 F C2: which flag-ring drain fastCommit runs (the knob is read once, on the first run).
    s_vu1CommitBatch = fastCommitBatchKnob();
    static const bool s_genEnv = ps2x::knob("PS2X_VU1_GEN") == nullptr || std::atoi(ps2x::knob("PS2X_VU1_GEN")) != 0;
    // Hand-written native programs (src/lib/vu/native) replace a microprogram entry point on
    // both the fast and the cycle-exact path: what they produce does not depend on how the
    // microcode would have been interpreted. On by default (kVu1NativeDefault);
    // PS2X_VU1_NATIVE=0 reverts to the generated/interpreted path.
    static const bool s_nativeEnv = ps2x::knob("PS2X_VU1_NATIVE") ? std::atoi(ps2x::knob("PS2X_VU1_NATIVE")) != 0 : kVu1NativeDefault;
    // Both registries are keyed by the FNV-1a hash of the 16 KB code image, rehashed only when
    // the VIF MPG generation counter changes.
    const bool hashableImage = memory != nullptr && vuCode == memory->getVU1Code();
    if (hashableImage && (s_nativeEnv || (s_genEnv && g_vu1KnownProgramCount != 0u)))
    {
        const uint64_t generation = memory->getVU1CodeGeneration();
        if (generation != m_knownGeneration)
        {
            m_knownGeneration = generation;
            uint64_t hash = 1469598103934665603ull;
            for (uint32_t i = 0; i < codeSize; ++i)
            {
                hash ^= vuCode[i];
                hash *= 1099511628211ull;
            }
            m_knownFn = nullptr;
            for (uint32_t i = 0; i < g_vu1KnownProgramCount; ++i)
                if (g_vu1KnownPrograms[i].hash == hash)
                    m_knownFn = g_vu1KnownPrograms[i].fn;
            m_knownHash = hash;
        }
    }
    // The entry pc is part of the native key, so this resolves on every run.
    m_nativeFn = nullptr;
    if (s_nativeEnv && hashableImage)
    {
        const Vu1NativeProgram *table = m_nativeTable ? m_nativeTable : g_vu1NativePrograms;
        const uint32_t count = m_nativeTable ? m_nativeCount : g_vu1NativeProgramCount;
        for (uint32_t i = 0; i < count; ++i)
            if (table[i].hash == m_knownHash && table[i].entryPc == m_state.pc && table[i].fn)
                m_nativeFn = table[i].fn;
        // Audit 2026-09-17 section 2.2 F7: the table is keyed to one disc's microcode hash, so
        // another revision ran the interpreter with nothing to say why. One line, once, and only
        // after a second of uninterrupted misses -- a boot whose gameplay microcode has not been
        // uploaded yet is all misses by design and must stay quiet. PS2X_VU1_NATIVE=0 is a
        // deliberate choice and never reaches here.
        static Vu1NativeWarning::State s_warn;
        const uint64_t nativeNowNs = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                                                               std::chrono::steady_clock::now().time_since_epoch())
                                                               .count());
        // s7_gl_gate: keyed on the (hash, pc) match this fired on the supported disc at entry 0x0000, which the
        // table leaves to generated code on purpose. The question is whether the hash is known at all.
        if (s_warn.shouldWarn(Vu1NativeWarning::hashHasNativeEntry(table, count, m_knownHash), nativeNowNs))
        {
            // Unsynchronized on purpose: VU1 runs on one thread, and the worst a second one could
            // do is print the same line twice.
            std::fprintf(stderr, "%s\n", Vu1NativeWarning::line(m_knownHash, m_state.pc).c_str());
            std::fflush(stderr);
            s_warn.warned();
        }
    }
    if (m_nativeFn && !m_state.dBitEnabled && !m_state.tBitEnabled && !m_state.ebit &&
        !m_state.haltAfterDelaySlot && !m_state.branchPending)
    {
        g_vu1NativeEntered.fetch_add(1, std::memory_order_relaxed);
        programEnded = m_nativeFn(*this, budgetEnd);
        if (programEnded)
            g_vu1NativeEnded.fetch_add(1, std::memory_order_relaxed);
        else
            g_vu1NativeHandBacks.fetch_add(1, std::memory_order_relaxed);
    }
    if (m_fast)
    {
        // Known program (recompiled image): run the generated code until it ends the program or
        // hands back to the interpreter (budget, unsupported pair) with m_state.pc set.
        if (!programEnded && s_genEnv && hashableImage && g_vu1KnownProgramCount != 0u)
        {
            if (!m_knownFn)
            {
                // Image with no generated code: count it for the stats line (and, once per hash,
                // name it so it can be dumped with PS2X_VU1_DUMP and recompiled).
                ++g_vu1UnknownImagePrograms;
                static uint64_t s_reported[8] = {0};
                static int s_reportedCount = 0;
                bool seen = false;
                for (int i = 0; i < s_reportedCount; ++i)
                    seen |= s_reported[i] == m_knownHash;
                if (!seen && s_reportedCount < 8)
                {
                    s_reported[s_reportedCount++] = m_knownHash;
                    std::fprintf(stderr, "[vu1] program image %016llx (entry pc=0x%x) has no generated code\n",
                                 (unsigned long long)m_knownHash, m_state.pc);
                }
            }
            static const bool s_bailHistEnv = ps2x::knob("PS2X_VU1_BAILHIST") != nullptr;
            if (s_bailHistEnv && !g_vu1BailHist)
            {
                static uint32_t s_bailHist[2048] = {0};
                g_vu1BailHist = s_bailHist;
            }
            if (m_knownFn && !m_state.dBitEnabled && !m_state.tBitEnabled && !m_state.ebit &&
                !m_state.haltAfterDelaySlot && !m_state.branchPending)
            {
                ++g_vu1GenEntered;
                programEnded = m_knownFn(*this, budgetEnd);
                if (programEnded)
                    ++g_vu1GenEnded;
                else
                    ++g_vu1GenHandBacks;
            }
            else
                ++g_vu1GenSkipped;
        }
        if (!programEnded && m_cycle < budgetEnd && !m_stopRequested)
            runFast(vuCode, codeSize, vuData, dataSize, gs, memory, budgetEnd, programEnded);
    }
    // A native program that ended the program leaves nothing for the cycle-exact loop to run.
    while (!m_fast && !programEnded && m_cycle < budgetEnd && !m_stopRequested)
    {
        commitReadyPipelines();
        if (m_state.pc + 8u > codeSize)
            break;

        const DecodedInstructionPair &decoded = getDecodedInstructionPairForPc(vuCode, codeSize, memory, m_state.pc);
        if (decoded.upperUsage.reserved || decoded.lowerUsage.reserved)
        {
            reportReservedInstruction(decoded.upperUsage.reserved, decoded.upperUsage.reserved ? decoded.upper : decoded.lower);
            break;
        }
        g_vuInsnCount.fetch_add(1, std::memory_order_relaxed);

        static const uint32_t s_traceStepCap = ps2x::knob("PS2X_TRACE_VU_STEPS") ? static_cast<uint32_t>(std::atoi(ps2x::knob("PS2X_TRACE_VU_STEPS"))) : 1200u;
        if (traceThis && traceSteps < s_traceStepCap)
        {
            uint32_t lo, up;
            std::memcpy(&lo, vuCode + m_state.pc, 4);
            std::memcpy(&up, vuCode + m_state.pc + 4, 4);
            std::fprintf(stderr, "[vu-trace] pc=0x%x lo=%08x up=%08x%s\n", m_state.pc, lo, up,
                         m_state.pc == traceFirstXg ? "  <-- XGKICK" : "");
            ++traceSteps;
        }

        uint64_t readyCycle = calculatePairReadyCycle(decoded);
        while (readyCycle > m_cycle)
        {
            if (readyCycle >= budgetEnd)
            {
                advanceTo(budgetEnd);
                break;
            }
            advanceTo(readyCycle);
            readyCycle = calculatePairReadyCycle(decoded);
        }
        if (m_cycle >= budgetEnd)
            break;

        uint8_t writtenVi = 0u;
        int32_t oldVi = 0;
        for (uint32_t reg = 1; reg < 16u; ++reg)
        {
            if ((decoded.lowerUsage.viWrite & (1u << reg)) != 0u)
            {
                writtenVi = static_cast<uint8_t>(reg);
                oldVi = m_state.vi[reg];
                break;
            }
        }

        const VfAccess upperWrite = decoded.upperUsage.vfWrite;
        const VfAccess lowerWrite = decoded.lowerUsage.vfWrite;
        const bool hasUpperWrite = upperWrite.reg != 0u;
        const bool hasLowerWrite = lowerWrite.reg != 0u && decoded.suppressedLowerVf != lowerWrite.reg;
        const bool hasDistinctLowerWrite = hasLowerWrite && (!hasUpperWrite || lowerWrite.reg != upperWrite.reg);
        float oldUpperVf[4]{};
        float newUpperVf[4]{};
        float oldLowerVf[4]{};
        float newLowerVf[4]{};
        float oldAcc[4]{};
        float newAcc[4]{};
        if (hasUpperWrite)
            std::memcpy(oldUpperVf, m_state.vf[upperWrite.reg], sizeof(oldUpperVf));
        if (hasDistinctLowerWrite)
            std::memcpy(oldLowerVf, m_state.vf[lowerWrite.reg], sizeof(oldLowerVf));
        if (decoded.upperUsage.accWrite != 0u)
            std::memcpy(oldAcc, m_state.acc, sizeof(oldAcc));

        if (decoded.iBit)
        {
            execUpper(decoded.upper);
            float immediate = 0.0f;
            std::memcpy(&immediate, &decoded.lower, sizeof(immediate));
            m_state.i = normalizeOperand(immediate);
        }
        else if (decoded.upperVfShadowReg != 0u)
        {
            float oldVf[4]{};
            float upperVf[4]{};
            std::memcpy(oldVf,
                        m_state.vf[decoded.upperVfShadowReg],
                        sizeof(oldVf));
            execUpper(decoded.upper);
            std::memcpy(upperVf,
                        m_state.vf[decoded.upperVfShadowReg],
                        sizeof(upperVf));
            std::memcpy(m_state.vf[decoded.upperVfShadowReg],
                        oldVf,
                        sizeof(oldVf));
            execLower(decoded.lower, vuData, dataSize, gs, memory, decoded.upper);
            std::memcpy(m_state.vf[decoded.upperVfShadowReg],
                        upperVf,
                        sizeof(upperVf));
        }
        else
        {
            execUpper(decoded.upper);
            execLower(decoded.lower, vuData, dataSize, gs, memory, decoded.upper);
        }

        m_viBranchBackupValid = false;

        if (hasUpperWrite)
        {
            std::memcpy(newUpperVf, m_state.vf[upperWrite.reg], sizeof(newUpperVf));
            std::memcpy(m_state.vf[upperWrite.reg], oldUpperVf, sizeof(oldUpperVf));
            const uint32_t latency =
                decoded.upperUsage.vfLatency != 0u
                    ? decoded.upperUsage.vfLatency
                    : decoded.upperUsage.latency;
            queueVfWrite(upperWrite.reg, upperWrite.lanes, newUpperVf, latency);
        }
        if (hasDistinctLowerWrite)
        {
            std::memcpy(newLowerVf, m_state.vf[lowerWrite.reg], sizeof(newLowerVf));
            std::memcpy(m_state.vf[lowerWrite.reg], oldLowerVf, sizeof(oldLowerVf));
            const uint32_t latency = decoded.lowerUsage.vfLatency != 0u
                                         ? decoded.lowerUsage.vfLatency
                                         : decoded.lowerUsage.latency;
            queueVfWrite(lowerWrite.reg, lowerWrite.lanes, newLowerVf, latency);
        }
        if (decoded.upperUsage.accWrite != 0u)
        {
            std::memcpy(newAcc, m_state.acc, sizeof(newAcc));
            std::memcpy(m_state.acc, oldAcc, sizeof(oldAcc));
            // ACC is forwarded to the next upper instruction. Its arithmetic
            // flags still use the normal four-cycle FMAC timeline.
            queueAccWrite(decoded.upperUsage.accWrite, newAcc,
                          kAccForwardLatency);
        }
        if (writtenVi != 0u)
        {
            const int32_t newVi = m_state.vi[writtenVi];
            m_state.vi[writtenVi] = oldVi;
            const uint32_t latency =
                decoded.lowerUsage.viLatency != 0u
                    ? decoded.lowerUsage.viLatency
                    : decoded.lowerUsage.latency;
            queueViWrite(writtenVi, newVi, latency);
        }

        markPairWrites(decoded);
        if (writtenVi != 0u && decoded.lowerUsage.delaysNextBranchRead)
            recordViWriteForBranch(writtenVi, oldVi);

        m_state.vf[0][0] = 0.0f;
        m_state.vf[0][1] = 0.0f;
        m_state.vf[0][2] = 0.0f;
        m_state.vf[0][3] = 1.0f;
        m_state.vi[0] = 0;

        uint32_t nextPc = m_state.pc + 8u;
        if (nextPc >= codeSize)
            nextPc = 0u;
        m_state.pc = nextPc;

        if (m_state.branchPending)
        {
            if (m_state.branchDelay == 0u)
            {
                m_state.pc = m_state.branchTarget & microAddressMask();
                m_state.branchPending = false;
            }
            else
            {
                --m_state.branchDelay;
            }
        }

        const bool dHalt = decoded.dBit && m_state.dBitEnabled;
        const bool tHalt = decoded.tBit && m_state.tBitEnabled;
        const bool haltBit = dHalt || tHalt;
        const bool haltBranch = haltBit && decoded.lowerUsage.pipeline == PipelineBranch;

        if (m_state.haltAfterDelaySlot)
        {
            m_state.stoppedByD = m_pendingHaltD;
            m_state.stoppedByT = m_pendingHaltT;
            programEnded = true;
        }
        else if (m_state.ebit)
            programEnded = true;
        else if (haltBit && !haltBranch)
        {
            m_state.stoppedByD = dHalt;
            m_state.stoppedByT = tHalt;
            programEnded = true;
        }
        else if (decoded.eBit)
            m_state.ebit = true;
        else if (haltBranch)
        {
            m_state.haltAfterDelaySlot = true;
            m_pendingHaltD = dHalt;
            m_pendingHaltT = tHalt;
        }

        advanceOneCycle();
        if (programEnded)
            break;
    }

    if (programEnded)
    {
        if (m_fast)
            fastFlush();
        else
            flushPipelines();
        m_state.ebit = false;
        m_state.haltAfterDelaySlot = false;
        m_pendingHaltD = false;
        m_pendingHaltT = false;
    }
    if (traceThis)
    {
        std::fprintf(stderr, "[vu-trace] END pc=0x%x steps=%u ended=%d (firstXGKICK was 0x%x)\n",
                     m_state.pc, traceSteps, (int)programEnded, traceFirstXg);
        s_vuTraceDumped.fetch_add(1, std::memory_order_relaxed);
    }
    m_state.cycles = m_cycle;
    // A budget stop before the E bit (not a reserved-instruction stop) leaves the program pending;
    // the VIF entry points below finish it before the next MSCAL / MSCNT takes effect.
    m_programPending = !programEnded && !m_stopRequested;
    roundingScope.restore();
    // Guest time must not include the host time this interpreter took (see ps2GuestClockExcludedNs).
    if (m_unit == Unit::VU1)
    {
        const auto runEnd = std::chrono::steady_clock::now();
        ps2GuestClockExcludedNs().fetch_add(
            std::chrono::duration_cast<std::chrono::nanoseconds>(runEnd - runStart).count(), std::memory_order_relaxed);
    }
    // PS2X_VU_STATS=1: once a second, VU1 programs / cycles executed and host time spent in run().
    {
        static const bool s_stats = ps2x::knob("PS2X_VU_STATS") != nullptr;
        if (s_stats && m_unit == Unit::VU1)
        {
            static uint64_t s_programs = 0, s_cycles = 0;
            static double s_hostMs = 0.0;
            static auto s_last = std::chrono::steady_clock::now();
            static auto s_runStart = std::chrono::steady_clock::now();
            ++s_programs;
            s_cycles += m_cycle - runStartCycle;
            const auto now = std::chrono::steady_clock::now();
            s_hostMs += std::chrono::duration<double, std::milli>(now - runStart).count();
            if (now - s_last >= std::chrono::seconds(1))
            {
                static uint64_t s_lastFlips = 0, s_lastSyncV = 0, s_lastVu0 = 0;
                const uint64_t flips = g_gsSwapDBuffCount.load(std::memory_order_relaxed);
                const uint64_t syncs = g_gsSyncVCount.load(std::memory_order_relaxed);
                const double seconds = std::chrono::duration<double>(now - s_last).count();
                // CPU time of this (game) thread and of the whole process per wall second: tells
                // whether the frame rate is bound by this thread or by another (GL) thread.
                double threadMs = 0.0, procMs = 0.0;
#ifdef _WIN32
                {
                    static uint64_t s_lastThread = 0, s_lastProc = 0;
                    FILETIME c, e, k, u;
                    if (GetThreadTimes(GetCurrentThread(), &c, &e, &k, &u))
                    {
                        const uint64_t t = ((static_cast<uint64_t>(k.dwHighDateTime) << 32) | k.dwLowDateTime) +
                                           ((static_cast<uint64_t>(u.dwHighDateTime) << 32) | u.dwLowDateTime);
                        threadMs = static_cast<double>(t - s_lastThread) / 10000.0 / seconds;
                        s_lastThread = t;
                    }
                    if (GetProcessTimes(GetCurrentProcess(), &c, &e, &k, &u))
                    {
                        const uint64_t t = ((static_cast<uint64_t>(k.dwHighDateTime) << 32) | k.dwLowDateTime) +
                                           ((static_cast<uint64_t>(u.dwHighDateTime) << 32) | u.dwLowDateTime);
                        procMs = static_cast<double>(t - s_lastProc) / 10000.0 / seconds;
                        s_lastProc = t;
                    }
                }
#else
                {
                    // Sprint 8 Goal 1 design item 3: the same two numbers on Linux. The POSIX CPU
                    // clocks are the equivalent of GetThreadTimes/GetProcessTimes, and, like them,
                    // count kernel + user time; ns here instead of 100 ns ticks.
                    static uint64_t s_lastThread = 0, s_lastProc = 0;
                    struct timespec ts;
                    if (::clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts) == 0)
                    {
                        const uint64_t t = static_cast<uint64_t>(ts.tv_sec) * 1000000000ull + static_cast<uint64_t>(ts.tv_nsec);
                        threadMs = static_cast<double>(t - s_lastThread) / 1000000.0 / seconds;
                        s_lastThread = t;
                    }
                    if (::clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &ts) == 0)
                    {
                        const uint64_t t = static_cast<uint64_t>(ts.tv_sec) * 1000000000ull + static_cast<uint64_t>(ts.tv_nsec);
                        procMs = static_cast<double>(t - s_lastProc) / 1000000.0 / seconds;
                        s_lastProc = t;
                    }
                }
#endif
                static uint64_t s_lastUnknown = 0, s_lastHandBacks = 0;
                static uint64_t s_lastNativeEntered = 0, s_lastNativeEnded = 0, s_lastNativeHandBacks = 0;
                const uint64_t nativeEntered = g_vu1NativeEntered.load(std::memory_order_relaxed);
                const uint64_t nativeEnded = g_vu1NativeEnded.load(std::memory_order_relaxed);
                const uint64_t nativeHandBacks = g_vu1NativeHandBacks.load(std::memory_order_relaxed);
                std::fprintf(stderr, "[vu1-stats] programs/s=%llu cycles/s=%llu host=%.0f ms/s (%.1f ns/cycle) flips/s=%.1f syncv/s=%.1f thread=%.0f ms/s proc=%.0f ms/s interp-programs/s=%llu handbacks/s=%llu vu0/s=%llu native-entered/s=%llu native-ended/s=%llu native-handbacks/s=%llu\n",
                             (unsigned long long)s_programs, (unsigned long long)s_cycles, s_hostMs,
                             s_cycles ? s_hostMs * 1e6 / static_cast<double>(s_cycles) : 0.0,
                             static_cast<double>(flips - s_lastFlips) / seconds, static_cast<double>(syncs - s_lastSyncV) / seconds,
                             threadMs, procMs, (unsigned long long)(g_vu1UnknownImagePrograms - s_lastUnknown),
                             (unsigned long long)(g_vu1GenHandBacks - s_lastHandBacks),
                             (unsigned long long)(g_vu0Programs.load(std::memory_order_relaxed) - s_lastVu0),
                             (unsigned long long)(nativeEntered - s_lastNativeEntered),
                             (unsigned long long)(nativeEnded - s_lastNativeEnded),
                             (unsigned long long)(nativeHandBacks - s_lastNativeHandBacks));
                s_lastUnknown = g_vu1UnknownImagePrograms;
                s_lastHandBacks = g_vu1GenHandBacks;
                s_lastVu0 = g_vu0Programs.load(std::memory_order_relaxed);
                s_lastNativeEntered = nativeEntered;
                s_lastNativeEnded = nativeEnded;
                s_lastNativeHandBacks = nativeHandBacks;
                if (g_vu1BailHist)
                {
                    // top hand-back pcs so far (PS2X_VU1_BAILHIST=1): seeds for vu1_replay --gen --seeds
                    uint32_t top[6] = {0, 0, 0, 0, 0, 0};
                    for (int k = 0; k < 6; ++k)
                    {
                        uint32_t best = 0, bestPc = 0;
                        for (uint32_t i = 0; i < 2048u; ++i)
                        {
                            bool taken = false;
                            for (int j = 0; j < k; ++j)
                                taken |= top[j] == i * 8u && g_vu1BailHist[i] != 0u;
                            if (!taken && g_vu1BailHist[i] > best)
                            {
                                best = g_vu1BailHist[i];
                                bestPc = i * 8u;
                            }
                        }
                        top[k] = bestPc;
                        if (best == 0u)
                            break;
                        std::fprintf(stderr, "[vu1-bail] pc=0x%04x count=%u\n", bestPc, best);
                    }
                }
                s_lastFlips = flips;
                s_lastSyncV = syncs;
                s_last = now;
                s_programs = 0;
                s_cycles = 0;
                s_hostMs = 0.0;
            }
        }
    }
}
