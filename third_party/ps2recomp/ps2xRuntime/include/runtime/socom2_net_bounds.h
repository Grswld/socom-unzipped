// socom2_net_bounds.h -- bounds on what the network receive path may do with guest memory.
//
// Every decision here is made on plain values so ps2xTest can prove it without the game. A refusal copies nothing
// and says so in one log line; the rest of this file's reasons are kept out of the tree (SECURITY.md).
//
// The wraps are here rather than in game_overrides_socom2.cpp so that ps2xTest can install them through the same
// function-table registry the runner uses and drive them the way the game's callers do (runtime/socom2_server_records.h
// is the precedent). Each wrap decides BEFORE the original runs, never after: a wrap's code after the original's call
// runs at the scheduler's unwind, not at the return.
#pragma once
#include "ps2_runtime.h"
#include "runtime/ps2_memory.h"
#include "runtime/socom2_addresses.h"

#include <atomic>
#include <cstdint>
#include <cstring>
#include <iostream>

namespace socom2_net_bounds
{
    // [addr, addr + len) lies inside guest RAM, the start taken as the receive path indexes RAM (masked).
    inline bool ramSpanFits(uint32_t addr, uint32_t len)
    {
        const uint32_t start = addr & PS2_RAM_MASK;
        return len <= PS2_RAM_SIZE - start;
    }

    // A receive of `len` bytes after a `header` inside a buffer of `stated` bytes fits that buffer.
    inline bool statedFits(uint32_t stated, uint32_t header, uint32_t len)
    {
        return stated >= header && len <= stated - header;
    }

    // Counts a refusal (stopping at the top rather than coming round) and answers whether this one is logged: the
    // first sixteen, then every 1024th, so a loop of refusals cannot turn the log into this line.
    inline bool countRefusal(std::atomic<uint32_t> &count)
    {
        uint32_t prev = count.load();
        while (prev != UINT32_MAX && !count.compare_exchange_weak(prev, prev + 1))
        {
        }
        const uint32_t n = prev == UINT32_MAX ? prev : prev + 1;
        return n <= 16u || (n % 1024u) == 0u;
    }

    // ---- where the wraps go, per revision ----------------------------------------------------------------------------
    // The address table (runtime/socom2_addresses.h) holds the fields every shipped column has established; these sites
    // live here, in their own two rows, so that table's completeness check keeps its meaning. Same rule as the table: a
    // site a revision could not establish is socom2_addresses::kUnavailable, and install() says which it skipped.
    struct Sites
    {
        const char *revision;
        uint32_t rtDispatch;   // the RT message dispatcher: (conn, peer, type byte, body, length) in a0..a3, t0
    };

    inline constexpr Sites kR0001Sites = {
        "r0001",
        0x006364c0u,   // rtDispatch
    };

    // r0004, against game/overlays_r0004/socom2_game_r0004.elf:
    //   rtDispatch  the call at +0xf4 of the frame loop's twin (0x0063dcd0, relinked-body unique in match.json); the
    //               twin's own calls at +0x330 / +0x350 are the address table's serverMemRead / serverMemWrite.
    inline constexpr Sites kR0004Sites = {
        "r0004",
        0x0063dea0u,   // rtDispatch
    };

    // The row for the address table's revision; r0001's for any other, as the table does.
    inline const Sites &sitesFor(const char *revision)
    {
        if (revision && std::strcmp(revision, kR0004Sites.revision) == 0)
            return kR0004Sites;
        return kR0001Sites;
    }

    namespace detail
    {
        // Which of the 128 message types a line has been said for, per kind of line.
        struct TypeSet
        {
            std::atomic<uint32_t> words[4];
            bool first(uint32_t type)
            {
                const uint32_t bit = 1u << (type & 31u);
                return (words[(type >> 5) & 3u].fetch_or(bit) & bit) == 0u;
            }
            void clear()
            {
                for (auto &w : words)
                    w.store(0u);
            }
        };

        inline void bump(std::atomic<uint32_t> &n)
        {
            uint32_t prev = n.load();
            while (prev != UINT32_MAX && !n.compare_exchange_weak(prev, prev + 1))
            {
            }
        }

        // Replace the function at `addr` with `wrap`, keeping what was there in `original`. One line either way.
        inline bool wrapSite(PS2Runtime &runtime, uint32_t addr, const char *field, const char *what,
                             PS2Runtime::RecompiledFunction wrap, PS2Runtime::RecompiledFunction &original)
        {
            if (!socom2_addresses::available(addr))
            {
                std::cout << "[socom2] net bounds: no address for " << field << "; " << what << " not bound" << std::endl;
                return false;
            }
            if (!runtime.hasFunction(addr))
            {
                std::cout << "[socom2] no function for " << field << "; " << what << " not bound" << std::endl;
                return false;
            }
            const PS2Runtime::RecompiledFunction current = runtime.lookupFunction(addr);
            if (current != wrap)
            {
                if (!runtime.replaceFunction(addr, wrap))
                {
                    std::cout << "[socom2] " << field << " could not be replaced; " << what << " not bound" << std::endl;
                    return false;
                }
                original = current;
            }
            std::cout << "[socom2] " << what << " bound" << std::endl;
            return true;
        }
    }

    // ---- RT frames: the length each message type may carry --------------------------------------------------------
    // The dispatcher is handed one whole frame; its handlers each read a fixed record, or pass the body on. A frame whose
    // length is outside its type's bound is refused before the dispatcher runs: the handler is skipped, the walk
    // consumes the frame and goes on (kRtSkipped), the first refusal of each type is said, every one is counted. A type
    // with no bound here passes through unchanged, said once. Types 0x1d and 0x1e are refused at any length (their
    // handlers are refused by runtime/socom2_server_records.h as well).
    constexpr uint32_t kRtSkipped = 0u;

    enum class RtCheck : uint8_t { Unmapped, Length, Echo, Refused };
    struct RtRule
    {
        RtCheck check;
        uint16_t min;
        uint16_t max;
    };

    inline RtRule rtRule(uint32_t type)
    {
        switch (type)
        {
        case 0x02: case 0x03: return {RtCheck::Length, 0, 0x602};
        case 0x0a: return {RtCheck::Length, 0, 0x600};
        case 0x05: return {RtCheck::Echo, 0, 1};
        case 0x06: return {RtCheck::Length, 0, 0x16};
        case 0x07: return {RtCheck::Length, 0, 0x17};
        case 0x08: return {RtCheck::Length, 0, 0x52};
        case 0x09: return {RtCheck::Length, 0, 0x12};
        case 0x11: return {RtCheck::Length, 0, 1};
        case 0x13: return {RtCheck::Length, 0, 0x40};
        case 0x14: return {RtCheck::Length, 0x40, 0x40};
        case 0x18: return {RtCheck::Length, 0, 0x12};
        case 0x19: return {RtCheck::Length, 0, 0x19};
        case 0x1a: return {RtCheck::Length, 0, 2};
        case 0x1b: return {RtCheck::Length, 0, 0x42};
        case 0x1c: return {RtCheck::Length, 4, 0x104};   // the upper bound is provisional
        case 0x1d: case 0x1e: return {RtCheck::Refused, 0, 0};
        default: return {RtCheck::Unmapped, 0, 0xffff};
        }
    }

    enum class RtVerdict : uint8_t { Pass, Unmapped, PassLong, Refuse };

    inline RtVerdict rtVerdict(uint32_t typeByte, uint32_t length)
    {
        const uint32_t type = typeByte & 0x7fu;
        const bool encrypted = (typeByte & 0x80u) != 0u;
        length &= 0xffffu;
        const RtRule rule = rtRule(type);
        if (rule.check == RtCheck::Refused)
            return RtVerdict::Refuse;
        if (encrypted && (type == 0x03u || type == 0x1bu) && length < 2u)
            return RtVerdict::Refuse;                    // an encrypted body of these two starts with two bytes
        switch (rule.check)
        {
        case RtCheck::Unmapped: return RtVerdict::Unmapped;
        case RtCheck::Echo: return length > rule.max ? RtVerdict::PassLong : RtVerdict::Pass;
        default: return (length < rule.min || length > rule.max) ? RtVerdict::Refuse : RtVerdict::Pass;
        }
    }

    namespace detail
    {
        inline PS2Runtime::RecompiledFunction &rtOriginal()
        {
            static PS2Runtime::RecompiledFunction fn = nullptr;
            return fn;
        }
        inline std::atomic<uint32_t> &rtRefused()
        {
            static std::atomic<uint32_t> n{0};
            return n;
        }
        inline TypeSet &rtRefusedSaid()
        {
            static TypeSet s{};
            return s;
        }
        inline TypeSet &rtUnmappedSaid()
        {
            static TypeSet s{};
            return s;
        }
        inline TypeSet &rtLongSaid()
        {
            static TypeSet s{};
            return s;
        }
        // The suite's hook: the counters and the said-once sets are process-wide.
        inline void resetRtForTest()
        {
            rtRefused().store(0u);
            rtRefusedSaid().clear();
            rtUnmappedSaid().clear();
            rtLongSaid().clear();
        }
    }

    inline uint32_t rtFramesRefused() { return detail::rtRefused().load(); }

    inline void rtDispatchBound(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        const uint32_t typeByte = getRegU32(ctx, 6) & 0xffu;
        const uint32_t length = getRegU32(ctx, 8) & 0xffffu;
        const uint32_t type = typeByte & 0x7fu;
        switch (rtVerdict(typeByte, length))
        {
        case RtVerdict::Refuse:
            detail::bump(detail::rtRefused());
            if (detail::rtRefusedSaid().first(type))
                std::cout << "[socom2] rt frame bounded: type 0x" << std::hex << type << std::dec << " length " << length
                          << ((typeByte & 0x80u) ? " (encrypted)" : "") << " refused (first of this type; every one is)"
                          << std::endl;
            setReturnU32(ctx, kRtSkipped);
            ctx->pc = getRegU32(ctx, 31);
            return;
        case RtVerdict::Unmapped:
            if (detail::rtUnmappedSaid().first(type))
                std::cout << "[socom2] rt frame type 0x" << std::hex << type << std::dec
                          << " unmapped: passed through (said once per type)" << std::endl;
            break;
        case RtVerdict::PassLong:
            if (detail::rtLongSaid().first(type))
                std::cout << "[socom2] rt frame type 0x" << std::hex << type << std::dec << " length " << length
                          << " longer than its record: passed (said once)" << std::endl;
            break;
        case RtVerdict::Pass:
            break;
        }
        if (detail::rtOriginal())
            detail::rtOriginal()(rdram, ctx, runtime);
        // Nothing here: the original may leave through a scheduler checkpoint and resume later.
    }

    // Install every bound on the row's sites; each is independent of the others. Returns how many were installed.
    inline int install(PS2Runtime &runtime, const Sites &sites)
    {
        int installed = 0;
        if (detail::wrapSite(runtime, sites.rtDispatch, "rtDispatch", "rt frame length", rtDispatchBound, detail::rtOriginal()))
            ++installed;
        return installed;
    }
}
