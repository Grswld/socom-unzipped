// socom2_msg_bounds.h -- bounds on the game's message dispatcher and the sub-message handlers it calls.
//
// The dispatcher walks one message buffer as a run of sub-messages (a class byte, a type byte, then the record the
// handler for that class and type reads); each handler returns how many bytes it consumed, and a negative return is
// the game's own refusal (the dispatcher then drops the rest of the buffer). The guards here decide on the bytes a
// handler is handed BEFORE it runs: a sub-message outside its bound is refused with the handler's own -1, the first
// refusal of each kind is said in one line naming the function and the value, every one is counted, and everything
// inside its bounds reaches the handler unchanged. Their reasons are kept out of the tree (SECURITY.md).
//
// Same shape as runtime/socom2_net_bounds.h (the precedent for installing through the function-table registry, and
// the helpers used here). A wrap decides before the original runs, never after: a wrap's code after the original's
// call runs at the scheduler's unwind, not at the return.
#pragma once
#include "ps2_runtime.h"
#include "runtime/ps2_memory.h"
#include "runtime/socom2_addresses.h"
#include "runtime/socom2_net_bounds.h"

#include <atomic>
#include <cstdint>
#include <cstring>
#include <iostream>

namespace socom2_msg_bounds
{
    // ---- where the wraps go, per revision -----------------------------------------------------------------------------
    // Sites a revision could not establish are socom2_addresses::kUnavailable, and install() says which it skipped.
    struct Sites
    {
        const char *revision;
        // The dispatcher's class/type lookup, and the return addresses of its two calls to it and of the two handler
        // calls that follow them: the dispatcher's own walk, and the re-dispatch of a reassembled fragment.
        uint32_t dispatchLookup;
        uint32_t walkLookupReturn;      // in the walk: s2 = the offset past the 2-byte header, s4 = the buffer length
        uint32_t walkHandlerReturn;     // in the walk: the same two registers, the record copied to the scratch
        uint32_t fragmentLookupReturn;  // in the fragment handler: its frame's word at sp+0 is the reassembly record
        uint32_t fragmentHandlerReturn; // the same frame; the record's +8 is the reassembled length
        // Class 0 handlers, by type.
        uint32_t dmeType01;             // Ping
        uint32_t dmeType02;             // PacketFragment
        uint32_t dmeType03;
        uint32_t dmeType05;
        uint32_t dmeType0e;
        uint32_t dmeType0f;
        // Class 2 handlers.
        uint32_t appRadio;
        uint32_t appNames;
        // Class 1 handlers.
        uint32_t lobbyTypeA9;
        uint32_t lobbyTypeAd;
        uint32_t lobbyTypeE7;
        // DATA.
        uint32_t objectClassTable;      // 0x10 class records of 0x228 bytes: +4 the entry count, +0x28 the entry array
        uint32_t objectState;           // one byte per object number (0x1000)
        uint32_t objectTable;           // one word per object number: the object, its first byte its class
        uint32_t streamSlots;           // the word holding the stream slot array (0x800 slots of 0x44 bytes)
        uint32_t uploadSize;            // s32: the bytes of the upload in progress
        uint32_t uploadState;           // u32: 1 while an upload is in progress
    };

    inline constexpr Sites kR0001Sites = {
        "r0001",
        0x0063cb48u,   // dispatchLookup
        0x0063ca70u,   // walkLookupReturn
        0x0063caccu,   // walkHandlerReturn
        0x0061e618u,   // fragmentLookupReturn
        0x0061e638u,   // fragmentHandlerReturn
        0x0061e300u,   // dmeType01
        0x0061e510u,   // dmeType02
        0x0061ed48u,   // dmeType03
        0x0061f2b8u,   // dmeType05
        0x0061efb0u,   // dmeType0e
        0x0061de60u,   // dmeType0f
        0x0030e8e0u,   // appRadio
        0x002b9b20u,   // appNames
        0x0064d490u,   // lobbyTypeA9
        0x0064d620u,   // lobbyTypeAd
        0x0064d330u,   // lobbyTypeE7
        0x0067c5c8u,   // objectClassTable
        0x0067a7a8u,   // objectState
        0x006766e0u,   // objectTable
        0x006511d0u,   // streamSlots
        0x00686adcu,   // uploadSize
        0x00656188u,   // uploadState
    };

    // r0004 has not had these sites established: every one is unavailable, so install() binds none of them there and
    // says so. (The r0004 twins exist -- runtime/socom2_net_bounds.h found several -- but each of these needs its own
    // evidence, and the return addresses and frame offsets besides.)
    inline constexpr Sites kR0004Sites = {
        "r0004",
        socom2_addresses::kUnavailable, socom2_addresses::kUnavailable, socom2_addresses::kUnavailable,
        socom2_addresses::kUnavailable, socom2_addresses::kUnavailable, socom2_addresses::kUnavailable,
        socom2_addresses::kUnavailable, socom2_addresses::kUnavailable, socom2_addresses::kUnavailable,
        socom2_addresses::kUnavailable, socom2_addresses::kUnavailable, socom2_addresses::kUnavailable,
        socom2_addresses::kUnavailable, socom2_addresses::kUnavailable, socom2_addresses::kUnavailable,
        socom2_addresses::kUnavailable, socom2_addresses::kUnavailable, socom2_addresses::kUnavailable,
        socom2_addresses::kUnavailable, socom2_addresses::kUnavailable, socom2_addresses::kUnavailable,
        socom2_addresses::kUnavailable,
    };

    inline const Sites &sitesFor(const char *revision)
    {
        if (revision && std::strcmp(revision, kR0004Sites.revision) == 0)
            return kR0004Sites;
        return kR0001Sites;
    }

    // ---- the bounds --------------------------------------------------------------------------------------------------
    constexpr uint32_t kHandlerRefused = 0xFFFFFFFFu;   // -1: the handler's own refusal
    constexpr uint32_t kLookupRefused = 2u;             // the lookup's own "no handler" code
    constexpr uint32_t kScratchBytes = 0x600u;          // the dispatcher's scratch and its longest buffer
    constexpr uint32_t kObjectClassLimit = 0x10u;       // the object class table's records
    constexpr uint32_t kObjectClassStride = 0x228u;
    constexpr uint32_t kObjectLimit = 0x1000u;          // the object tables' entries
    constexpr uint32_t kPingSlots = 0x7fu;              // the ping slot table's entries
    constexpr uint32_t kStreamCallbacks = 0x10u;        // each stream callback table's entries
    constexpr uint32_t kStreamSlotBytes = 0x44u;
    constexpr uint32_t kRadioChannels = 12u;            // the radio channel records
    constexpr uint32_t kChunkBytes = 0x1d0u;            // a file chunk's data field

    // One kind of refusal each; the first of each kind is said.
    enum class Kind : uint8_t
    {
        WalkHeader, FragmentLength,
        FragmentOffset, FragmentSpan, FragmentIndex, FragmentRecord,
        PingSlot, StreamCallback, StreamRecord, WalkRecord, ObjectClass, StreamSlotCallback, NameUnterminated, ObjectSpan,
        RadioChannel, NamesSize, NamesWalk,
        UploadIdle, UploadStart, ChunkStart, ChunkSize, ChunkEnd, RecordSize,
        OutsideRam,
        Count
    };

    inline const char *kindLine(Kind k)
    {
        switch (k)
        {
        case Kind::WalkHeader: return "0x63c950 sub-message header: bytes left";
        case Kind::FragmentLength: return "0x61e510 reassembled length";
        case Kind::FragmentOffset: return "0x61e510 fragment offset";
        case Kind::FragmentSpan: return "0x61e510 fragment end";
        case Kind::FragmentIndex: return "0x61e510 fragment index";
        case Kind::FragmentRecord: return "0x61e510 fragment record end";
        case Kind::PingSlot: return "0x61e300 ping slot";
        case Kind::StreamCallback: return "0x61efb0 stream callback";
        case Kind::StreamRecord: return "0x61efb0 record end";
        case Kind::WalkRecord: return "0x61ed48 record end";
        case Kind::ObjectClass: return "0x61ed48 class index";
        case Kind::StreamSlotCallback: return "0x61f2b8 stream slot callback";
        case Kind::NameUnterminated: return "0x61de60 name: no terminator in its field, first byte";
        case Kind::ObjectSpan: return "0x61de60 object range end";
        case Kind::RadioChannel: return "0x30e8e0 radio channel";
        case Kind::NamesSize: return "0x2b9b20 record size";
        case Kind::NamesWalk: return "0x2b9b20 name list end";
        case Kind::UploadIdle: return "0x64d490 upload state";
        case Kind::UploadStart: return "0x64d490 start index";
        case Kind::ChunkStart: return "0x64d620 start index";
        case Kind::ChunkSize: return "0x64d620 data size";
        case Kind::ChunkEnd: return "0x64d620 start plus size";
        case Kind::RecordSize: return "0x64d330 record size";
        case Kind::OutsideRam: return "a sub-message outside guest RAM, at";
        default: return "?";
        }
    }

    // A decision: refuse, of this kind, with this value in the line.
    struct Refusal
    {
        bool refuse = false;
        Kind kind = Kind::Count;
        uint32_t value = 0;
    };
    inline Refusal refuse(Kind kind, uint32_t value) { return Refusal{true, kind, value}; }

    namespace detail
    {
        using socom2_net_bounds::ramSpanFits;
        using socom2_net_bounds::detail::readU32;

        inline uint8_t readU8(const uint8_t *rdram, uint32_t addr)
        {
            return ramSpanFits(addr, 1u) ? rdram[addr & PS2_RAM_MASK] : 0u;
        }
        inline uint16_t readU16(const uint8_t *rdram, uint32_t addr)
        {
            uint16_t v = 0;
            if (ramSpanFits(addr, 2u))
                std::memcpy(&v, rdram + (addr & PS2_RAM_MASK), 2);
            return v;
        }
        inline int32_t readS32(const uint8_t *rdram, uint32_t addr) { return static_cast<int32_t>(readU32(rdram, addr)); }

        inline const Sites *&sites()
        {
            static const Sites *s = &kR0001Sites;
            return s;
        }
        inline std::atomic<uint32_t> &refused()
        {
            static std::atomic<uint32_t> n{0};
            return n;
        }
        inline std::atomic<uint32_t> &said()
        {
            static std::atomic<uint32_t> bits{0};
            return bits;
        }

        // One original per wrapped site.
        enum Site : uint8_t
        {
            kLookup, kType01, kType02, kType03, kType05, kType0e, kType0f, kRadio, kNames, kTypeA9, kTypeAd, kTypeE7,
            kSites
        };
        inline PS2Runtime::RecompiledFunction &original(Site s)
        {
            static PS2Runtime::RecompiledFunction fns[kSites] = {};
            return fns[s];
        }

        inline void count(const Refusal &r)
        {
            socom2_net_bounds::detail::bump(refused());
            const uint32_t bit = 1u << static_cast<uint32_t>(r.kind);
            if ((said().fetch_or(bit) & bit) == 0u)
                std::cout << "[socom2] message bounded: " << kindLine(r.kind) << " 0x" << std::hex << r.value << std::dec
                          << " refused (first of this kind; every one is)" << std::endl;
        }

        inline void resetForTest()
        {
            refused().store(0u);
            said().store(0u);
        }
    }

    inline uint32_t messagesRefused() { return detail::refused().load(); }

    // The bytes the handler's record may take: in the dispatcher's walk, what the buffer has left past the header; in
    // a fragment's re-dispatch, the reassembled length; from any other caller, the scratch.
    inline uint32_t remainingFor(const uint8_t *rdram, const R5900Context *ctx, const Sites &s)
    {
        const uint32_t ra = getRegU32(ctx, 31);
        if (ra == s.walkHandlerReturn)
        {
            const uint32_t past = getRegU32(ctx, 18), length = getRegU32(ctx, 20);
            return past <= length ? length - past : 0u;
        }
        if (ra == s.fragmentHandlerReturn)
        {
            const uint32_t record = detail::readU32(rdram, getRegU32(ctx, 29));
            const int32_t total = detail::readS32(rdram, record + 8u);
            return total > 0 ? static_cast<uint32_t>(total) : 0u;
        }
        return kScratchBytes;
    }

    // ---- G1: the dispatcher's walk and a fragment's re-dispatch --------------------------------------------------------
    // Called at the lookup's entry. In the walk: the 2-byte header just read must lie inside the buffer, so that the
    // copy of the rest that follows has a length. In a re-dispatch: the reassembled length must be one the scratch
    // could hold, as the walk's own entry check requires of a buffer.
    inline Refusal checkLookup(const uint8_t *rdram, const R5900Context *ctx, const Sites &s)
    {
        const uint32_t ra = getRegU32(ctx, 31);
        if (ra == s.walkLookupReturn)
        {
            const uint32_t past = getRegU32(ctx, 18), length = getRegU32(ctx, 20);
            if (past > length)
                return refuse(Kind::WalkHeader, length + 2u - past);
        }
        else if (ra == s.fragmentLookupReturn)
        {
            const uint32_t record = detail::readU32(rdram, getRegU32(ctx, 29));
            const int32_t total = detail::readS32(rdram, record + 8u);
            if (total < 0 || static_cast<uint32_t>(total) > kScratchBytes)
                return refuse(Kind::FragmentLength, static_cast<uint32_t>(total));
        }
        return {};
    }

    // ---- the wraps -----------------------------------------------------------------------------------------------------
    namespace detail
    {
        inline void lookupBound(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
        {
            const Refusal r = checkLookup(rdram, ctx, *sites());
            if (r.refuse)
            {
                count(r);
                const uint32_t out = getRegU32(ctx, 6);   // the lookup clears its out-parameter first, as the game's does
                if (out != 0u && ramSpanFits(out, 4u))
                    std::memset(rdram + (out & PS2_RAM_MASK), 0, 4);
                setReturnU32(ctx, kLookupRefused);
                ctx->pc = getRegU32(ctx, 31);
                return;
            }
            if (original(kLookup))
                original(kLookup)(rdram, ctx, runtime);
        }
    }

    // Install every bound on the row's sites; each is independent of the others. Returns how many were installed.
    inline int install(PS2Runtime &runtime, const Sites &sites)
    {
        using socom2_net_bounds::detail::wrapSite;
        detail::sites() = &sites;
        struct Bind
        {
            uint32_t addr;
            const char *field;
            const char *what;
            PS2Runtime::RecompiledFunction fn;
            detail::Site site;
        };
        const Bind binds[] = {
            {sites.dispatchLookup, "dispatchLookup", "message walk", detail::lookupBound, detail::kLookup},
        };
        int installed = 0;
        for (const Bind &b : binds)
            if (wrapSite(runtime, b.addr, b.field, b.what, b.fn, detail::original(b.site)))
                ++installed;
        return installed;
    }
}
