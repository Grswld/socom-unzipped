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

    // ---- G2: class 0 ---------------------------------------------------------------------------------------------------
    // Type 0x02: u16 length at +2, u16 count at +4, u16 index at +6, s32 total at +0xc, s32 offset at +0x10, the data
    // at +0x14. The data lands at offset inside a buffer of total bytes; the index marks one of count flags.
    inline Refusal checkType02(const uint8_t *rdram, uint32_t msg, uint32_t remaining)
    {
        const uint32_t length = detail::readU16(rdram, msg + 2u);
        const uint32_t count = detail::readU16(rdram, msg + 4u);
        const uint32_t index = detail::readU16(rdram, msg + 6u);
        const int32_t total = detail::readS32(rdram, msg + 0xcu);
        const int32_t offset = detail::readS32(rdram, msg + 0x10u);
        if (0x14u + length > remaining)
            return refuse(Kind::FragmentRecord, 0x14u + length);
        if (offset < 0)
            return refuse(Kind::FragmentOffset, static_cast<uint32_t>(offset));
        if (total < 0 || static_cast<int64_t>(offset) + length > static_cast<int64_t>(total))
            return refuse(Kind::FragmentSpan, static_cast<uint32_t>(offset) + length);
        if (index >= count)
            return refuse(Kind::FragmentIndex, index);
        return {};
    }

    // Type 0x01: the byte at +4 selects a ping slot when the byte at +5 is 0.
    inline Refusal checkType01(const uint8_t *rdram, uint32_t msg, uint32_t)
    {
        const uint8_t slot = detail::readU8(rdram, msg + 4u);
        if (detail::readU8(rdram, msg + 5u) == 0u && slot >= kPingSlots)
            return refuse(Kind::PingSlot, slot);
        return {};
    }

    // Type 0x0e: the byte at +2 selects a stream callback; u16 at +10 is the data after the 0xc-byte header.
    inline Refusal checkType0e(const uint8_t *rdram, uint32_t msg, uint32_t remaining)
    {
        const uint8_t callback = detail::readU8(rdram, msg + 2u);
        if (callback >= kStreamCallbacks)
            return refuse(Kind::StreamCallback, callback);
        const uint32_t end = 0xcu + detail::readU16(rdram, msg + 10u);
        if (end > remaining)
            return refuse(Kind::StreamRecord, end);
        return {};
    }

    // Type 0x03: u16 object at +2, a count of entries at +1, then per entry an index byte and that entry's bytes as the
    // object class's table sizes them. The class is the object's own when the object exists, else the byte at +0.
    inline Refusal checkType03(const uint8_t *rdram, const R5900Context *ctx, uint32_t msg, uint32_t remaining,
                               const Sites &s)
    {
        const uint32_t object = detail::readU16(rdram, msg + 2u);
        if (getRegU32(ctx, 6) >= 0x100u || object >= kObjectLimit)
            return {};                                   // the handler refuses these itself
        uint32_t cls = 0;
        if (detail::readU8(rdram, s.objectState + object) == 2u)
        {
            const uint32_t record = detail::readU32(rdram, s.objectTable + object * 4u);
            if (record == 0u)
                return {};                               // the handler refuses this itself
            cls = detail::readU8(rdram, record);
            if (cls >= kObjectClassLimit)
                return {};                               // the game's own object; not a message field
        }
        else
        {
            cls = detail::readU8(rdram, msg);
            if (cls >= kObjectClassLimit)
                return refuse(Kind::ObjectClass, cls);
        }
        const uint32_t entries = detail::readU8(rdram, msg + 1u);
        const uint32_t classRecord = s.objectClassTable + cls * kObjectClassStride;
        const int32_t known = detail::readS32(rdram, classRecord + 4u);
        uint64_t at = 4u;
        for (uint32_t i = 0; i < entries; ++i)
        {
            if (at + 1u > remaining)
                return refuse(Kind::WalkRecord, static_cast<uint32_t>(at + 1u));
            const uint32_t index = detail::readU8(rdram, msg + static_cast<uint32_t>(at));
            if (static_cast<int32_t>(index) >= known)
                return {};                               // the handler stops and refuses here itself
            const uint32_t entry = detail::readU32(rdram, classRecord + 0x28u + index * 4u);
            if (entry == 0u)
                return {};                               // likewise
            const int64_t size = static_cast<int64_t>(detail::readS32(rdram, entry + 4u)) * detail::readS32(rdram, entry + 8u);
            at += 1u + static_cast<uint64_t>(size < 0 ? INT64_C(0x100000000) : size);
            if (at > remaining)
                return refuse(Kind::WalkRecord, at > 0xffffffffu ? 0xffffffffu : static_cast<uint32_t>(at));
        }
        return {};
    }

    // Type 0x05: the byte at +0 selects a stream slot, whose byte +3 (stored when the stream began) selects a callback.
    inline Refusal checkType05(const uint8_t *rdram, uint32_t msg, uint32_t, const Sites &s)
    {
        const uint32_t base = detail::readU32(rdram, s.streamSlots);
        if (base == 0u)
            return {};
        const uint32_t slot = base + detail::readU8(rdram, msg) * kStreamSlotBytes;
        const uint8_t callback = detail::readU8(rdram, slot + 3u);
        if (detail::readU8(rdram, slot) == 2u && callback >= kStreamCallbacks)
            return refuse(Kind::StreamSlotCallback, callback);
        return {};
    }

    // Type 0x0f: a name terminated inside its field [+0x16, +0x24); u16 at +10 and u16 at +0xc a range of objects.
    inline Refusal checkType0f(const uint8_t *rdram, uint32_t msg, uint32_t)
    {
        const uint32_t name = msg + 0x16u;
        if (!socom2_net_bounds::ramSpanFits(name, 0xeu) || !std::memchr(rdram + (name & PS2_RAM_MASK), 0, 0xeu))
            return refuse(Kind::NameUnterminated, detail::readU8(rdram, name));
        const uint32_t end = static_cast<uint32_t>(detail::readU16(rdram, msg + 10u)) + detail::readU16(rdram, msg + 0xcu);
        if (end > kObjectLimit)
            return refuse(Kind::ObjectSpan, end);
        return {};
    }

    // ---- G3: class 2 ---------------------------------------------------------------------------------------------------
    // Radio: the byte at +2 is the kind; kinds 1 to 4 index a channel record by the byte at +1.
    inline Refusal checkRadio(const uint8_t *rdram, uint32_t msg, uint32_t)
    {
        const uint8_t kind = detail::readU8(rdram, msg + 2u);
        const uint8_t channel = detail::readU8(rdram, msg + 1u);
        if (kind >= 1u && kind <= 4u && channel >= kRadioChannels)
            return refuse(Kind::RadioChannel, channel);
        return {};
    }

    // Names: u16 size at +0 (the record's, returned as consumed), three counts at +2..+4, then that many terminated
    // names from +5; every one ends inside the size, and the size inside what the buffer holds.
    inline Refusal checkNames(const uint8_t *rdram, uint32_t msg, uint32_t remaining)
    {
        const uint32_t size = detail::readU16(rdram, msg);
        if (size < 5u || size > remaining)
            return refuse(Kind::NamesSize, size);
        if (!socom2_net_bounds::ramSpanFits(msg, size))
            return refuse(Kind::OutsideRam, msg);
        const uint8_t *p = rdram + (msg & PS2_RAM_MASK);
        const uint32_t names = static_cast<uint32_t>(p[2]) + p[3] + p[4];
        uint32_t at = 5u;
        for (uint32_t i = 0; i < names; ++i)
        {
            const void *nul = at < size ? std::memchr(p + at, 0, size - at) : nullptr;
            if (!nul)
                return refuse(Kind::NamesWalk, i);
            at = static_cast<uint32_t>(static_cast<const uint8_t *>(nul) - p) + 1u;
        }
        return {};
    }

    // ---- the wraps -----------------------------------------------------------------------------------------------------
    namespace detail
    {
        // The least of the record a check reads, so that a record lying across the end of guest RAM is refused whole.
        inline uint32_t headerBytes(Site site)
        {
            switch (site)
            {
            case kType01: return 6u;
            case kType02: return 0x14u;
            case kType03: return 4u;
            case kType05: return 1u;
            case kType0e: return 0xcu;
            case kType0f: return 0x24u;
            case kRadio: return 3u;
            case kNames: return 5u;
            default: return 0u;
            }
        }

        inline Refusal decide(Site site, const uint8_t *rdram, const R5900Context *ctx)
        {
            const Sites &s = *sites();
            const uint32_t msg = getRegU32(ctx, 7);
            if (!ramSpanFits(msg, headerBytes(site)))
                return refuse(Kind::OutsideRam, msg);
            const uint32_t remaining = remainingFor(rdram, ctx, s);
            switch (site)
            {
            case kType01: return checkType01(rdram, msg, remaining);
            case kType02: return checkType02(rdram, msg, remaining);
            case kType03: return checkType03(rdram, ctx, msg, remaining, s);
            case kType05: return checkType05(rdram, msg, remaining, s);
            case kType0e: return checkType0e(rdram, msg, remaining);
            case kType0f: return checkType0f(rdram, msg, remaining);
            case kRadio: return checkRadio(rdram, msg, remaining);
            case kNames: return checkNames(rdram, msg, remaining);
            default: return {};
            }
        }

        template <Site S>
        void handlerBound(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
        {
            if (getRegU32(ctx, 7) != 0u)   // a null record is the handler's own refusal already
            {
                const Refusal r = decide(S, rdram, ctx);
                if (r.refuse)
                {
                    count(r);
                    setReturnU32(ctx, kHandlerRefused);
                    ctx->pc = getRegU32(ctx, 31);
                    return;
                }
            }
            if (original(S))
                original(S)(rdram, ctx, runtime);
            // Nothing here: the original may leave through a scheduler checkpoint and resume later.
        }

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
            {sites.dmeType01, "dmeType01", "message 0.01", detail::handlerBound<detail::kType01>, detail::kType01},
            {sites.dmeType02, "dmeType02", "message 0.02", detail::handlerBound<detail::kType02>, detail::kType02},
            {sites.dmeType03, "dmeType03", "message 0.03", detail::handlerBound<detail::kType03>, detail::kType03},
            {sites.dmeType05, "dmeType05", "message 0.05", detail::handlerBound<detail::kType05>, detail::kType05},
            {sites.dmeType0e, "dmeType0e", "message 0.0e", detail::handlerBound<detail::kType0e>, detail::kType0e},
            {sites.dmeType0f, "dmeType0f", "message 0.0f", detail::handlerBound<detail::kType0f>, detail::kType0f},
            {sites.appRadio, "appRadio", "message 2.radio", detail::handlerBound<detail::kRadio>, detail::kRadio},
            {sites.appNames, "appNames", "message 2.names", detail::handlerBound<detail::kNames>, detail::kNames},
        };
        int installed = 0;
        for (const Bind &b : binds)
            if (wrapSite(runtime, b.addr, b.field, b.what, b.fn, detail::original(b.site)))
                ++installed;
        return installed;
    }
}
