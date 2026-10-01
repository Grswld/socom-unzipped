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
        uint32_t rtDispatch;         // the RT message dispatcher: (conn, peer, type byte, body, length) in a0..a3, t0
        uint32_t objectUpdate;       // the network object full-update packet handler: payload in a3
        uint32_t objectClassCount;   // DATA: how many object classes are registered (u32)
        uint32_t animUpdate;         // the animation packet handler: payload in a3
        uint32_t animTable;          // DATA: the animation holder; +0x1c the entry array, +0x20 how many entries it
                                     // holds (the count the game grows it by and bounds its own lookups with); +0x34
                                     // is the entry currently active, a pointer into the array, not its end
        uint32_t roundState;         // DATA: the pointer to the round record; its byte +0x113 is 3 in a round
        uint32_t gameChat;           // the game's chat packet handler (lobby and round): payload in a3
        uint32_t playerNames;        // DATA: the player slot table the chat handler takes the sender's name from: 24
                                     // slots of 8 bytes, a slot's first word the player record, its name at +0xe
    };

    inline constexpr Sites kR0001Sites = {
        "r0001",
        0x006364c0u,   // rtDispatch
        0x0061e8b8u,   // objectUpdate
        0x0067c5a0u,   // objectClassCount
        0x002bb7f0u,   // animUpdate
        0x00414bb0u,   // animTable
        0x00437ce8u,   // roundState
        0x002ba9d0u,   // gameChat
        0x004414c4u,   // playerNames
    };

    // r0004, against game/overlays_r0004/socom2_game_r0004.elf:
    //   rtDispatch        the call at +0xf4 of the frame loop's twin (0x0063dcd0, relinked-body unique in match.json);
    //                     the twin's own calls at +0x330 / +0x350 are the address table's serverMemRead / serverMemWrite.
    //   objectUpdate      the address its registering function's twin (0x006274b8, exact) loads at the same offset
    //                     (+0x6c/+0x74); 292 of 292 instructions agree in opcode with r0001's.
    //   objectClassCount  data-via-twin (one twin), 0x28 below the class table, as in r0001; the handler's twin reads
    //                     that table (0x0067be08) at the same offset as r0001's.
    //   animUpdate        the address the game-packet registration's twin (0x002ba1b0, relinked-body unique) loads at
    //                     the same offset (+0x15c); 36 of 36 instructions agree.
    //   animTable         data-via-twin, 289 twins unanimous; the handler's twin loads it at the same two offsets.
    //   roundState        the handler's twin reads it at the same offset (+60).
    //   gameChat          relinked-body unique in match.json, and the address the game-packet registration's twin
    //                     loads at the same offset (+0x460); 156 of 156 instructions agree.
    //   playerNames       the chat handler's twin calls the sender-name lookup's twin (0x002c56e0) at the same offset
    //                     (+0xb8); that twin's lui/addiu pair loads this table where r0001's loads 0x004414c4, and adds
    //                     the same +0xe; the twin formats into the same 144-byte stack line with the same two formats.
    inline constexpr Sites kR0004Sites = {
        "r0004",
        0x0063dea0u,   // rtDispatch
        0x00626190u,   // objectUpdate
        0x0067bde0u,   // objectClassCount
        0x002bd490u,   // animUpdate
        0x00441570u,   // animTable
        0x004446f8u,   // roundState
        0x002bc5e0u,   // gameChat
        0x0044dee4u,   // playerNames
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
    // The dispatcher is handed one whole frame; its handlers each read a fixed record, or pass the body on. Only what a
    // handler can hold is bounded: a type whose handler passes the body on by its length (Length) is refused above its
    // bound; a type whose handler reads a fixed record and checks the length itself (Record) is refused only below the
    // record it reads without checking, and a longer frame passes, said once per type (a server that is not ours may pad
    // them). A refused frame is skipped before the dispatcher runs: the handler is skipped, the walk consumes the frame
    // and goes on (kRtSkipped), the first refusal of each type is said, every one is counted. A type with no bound here
    // passes through unchanged, said once. Types 0x1d and 0x1e are refused at any length (their handlers are refused by
    // runtime/socom2_server_records.h as well).
    constexpr uint32_t kRtSkipped = 0u;

    enum class RtCheck : uint8_t { Unmapped, Length, Record, Refused };
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
        // Handlers that pass the body on by its length.
        case 0x02: case 0x03: return {RtCheck::Length, 0, 0x602};
        case 0x0a: return {RtCheck::Length, 0, 0x600};
        case 0x1c: return {RtCheck::Length, 4, 0x104};   // the upper bound is provisional
        // Handlers that read a fixed record: {the least they read unchecked, the record}.
        case 0x05: return {RtCheck::Record, 0, 1};
        case 0x06: return {RtCheck::Record, 0, 0x16};
        case 0x07: return {RtCheck::Record, 0, 0x17};
        case 0x08: return {RtCheck::Record, 0, 0x52};
        case 0x09: return {RtCheck::Record, 0, 0x12};
        case 0x11: return {RtCheck::Record, 0, 1};
        case 0x13: return {RtCheck::Record, 0, 0x40};
        case 0x14: return {RtCheck::Record, 0x40, 0x40};   // its handler reads the whole record with no length check
        case 0x18: return {RtCheck::Record, 0, 0x12};
        case 0x19: return {RtCheck::Record, 0, 0x19};
        case 0x1a: return {RtCheck::Record, 0, 2};
        case 0x1b: return {RtCheck::Record, 0, 0x42};
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
        case RtCheck::Record:
            if (length < rule.min)
                return RtVerdict::Refuse;
            return length > rule.max ? RtVerdict::PassLong : RtVerdict::Pass;
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

    // ---- game packets: the indexes a handler takes from its payload ------------------------------------------------
    // These handlers are given a pointer to the message's bytes and return how many they consumed; a negative return is
    // the game's own refusal (the game-packet dispatcher then drops the rest of the message). A payload whose index is
    // outside the table it selects from is refused with that value before the handler runs; the first refusal of each
    // kind is said, every one counted.
    constexpr uint32_t kHandlerRefused = 0xFFFFFFFFu;   // -1
    constexpr uint32_t kMessageBytes = 0x600u;          // the game-packet dispatcher's message buffer
    constexpr uint32_t kObjectClassLimit = 0x10u;       // the object class table's entries
    constexpr uint32_t kObjectIndexLimit = 0x1000u;     // the object tables' entries

    enum class PacketVerdict : uint8_t { Pass, ClassRefused, ObjectRefused, WalkRefused, IndexRefused, NameRefused };

    // The object update's name field: [+0x14, +0x24), copied into a 16-byte slot, terminator included.
    constexpr uint32_t kObjectNameOffset = 0x14u;
    constexpr uint32_t kObjectNameBytes = 0x10u;

    // Class index < the registered count (never more than the table holds); object index < the tables' size.
    inline PacketVerdict objectVerdict(uint32_t cls, uint32_t classCount, uint32_t object)
    {
        const uint32_t limit = classCount < kObjectClassLimit ? classCount : kObjectClassLimit;
        if (cls >= limit)
            return PacketVerdict::ClassRefused;
        if (object >= kObjectIndexLimit)
            return PacketVerdict::ObjectRefused;
        return PacketVerdict::Pass;
    }

    // The walk length stays inside the message buffer; in a round (the only time the game reads it) the entry index
    // is inside the entry table.
    inline PacketVerdict animVerdict(uint32_t walk, int16_t index, uint32_t entries, bool inRound)
    {
        if (walk > kMessageBytes)
            return PacketVerdict::WalkRefused;
        if (inRound && (index < 0 || static_cast<uint32_t>(index) >= entries))
            return PacketVerdict::IndexRefused;
        return PacketVerdict::Pass;
    }

    // The entry table's length: the holder's count, read as the game reads it (a signed int; a negative one holds none).
    inline uint32_t animEntries(uint32_t count)
    {
        return static_cast<int32_t>(count) > 0 ? count : 0u;
    }

    namespace detail
    {
        inline uint32_t readU32(const uint8_t *rdram, uint32_t addr)
        {
            uint32_t v = 0;
            if (ramSpanFits(addr, 4u))
                std::memcpy(&v, rdram + (addr & PS2_RAM_MASK), 4);
            return v;
        }

        inline const Sites *&packetSites()
        {
            static const Sites *s = &kR0001Sites;
            return s;
        }
        inline PS2Runtime::RecompiledFunction &objectOriginal()
        {
            static PS2Runtime::RecompiledFunction fn = nullptr;
            return fn;
        }
        inline PS2Runtime::RecompiledFunction &animOriginal()
        {
            static PS2Runtime::RecompiledFunction fn = nullptr;
            return fn;
        }
        inline std::atomic<uint32_t> &packetRefused()
        {
            static std::atomic<uint32_t> n{0};
            return n;
        }
        // One bit per PacketVerdict (and one for a payload outside RAM): said once each.
        inline std::atomic<uint32_t> &packetSaid()
        {
            static std::atomic<uint32_t> bits{0};
            return bits;
        }
        inline void resetPacketsForTest()
        {
            packetRefused().store(0u);
            packetSaid().store(0u);
        }

        inline void refusePacket(R5900Context *ctx, uint32_t kind, const char *line, uint32_t value)
        {
            bump(packetRefused());
            const uint32_t bit = 1u << (kind & 31u);
            if ((packetSaid().fetch_or(bit) & bit) == 0u)
                std::cout << "[socom2] " << line << " " << value << " refused (first of this kind; every one is)" << std::endl;
            setReturnU32(ctx, kHandlerRefused);
            ctx->pc = getRegU32(ctx, 31);
        }
    }

    inline uint32_t packetsRefused() { return detail::packetRefused().load(); }

    inline void objectUpdateBound(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        const uint32_t payload = getRegU32(ctx, 7);
        if (payload != 0u)   // a null payload is the game's own refusal already
        {
            if (!ramSpanFits(payload, 10u))
            {
                detail::refusePacket(ctx, 31u, "object update bounded: a payload outside guest RAM, length", 10u);
                return;
            }
            const uint8_t *p = rdram + (payload & PS2_RAM_MASK);
            uint16_t object = 0;
            std::memcpy(&object, p + 8, 2);
            const uint32_t classCount = detail::readU32(rdram, detail::packetSites()->objectClassCount);
            switch (objectVerdict(p[1], classCount, object))
            {
            case PacketVerdict::ClassRefused:
                detail::refusePacket(ctx, static_cast<uint32_t>(PacketVerdict::ClassRefused), "object update bounded: class index", p[1]);
                return;
            case PacketVerdict::ObjectRefused:
                detail::refusePacket(ctx, static_cast<uint32_t>(PacketVerdict::ObjectRefused), "object update bounded: object index", object);
                return;
            default:
                break;
            }
            // The name is terminated inside its field (and the field inside guest RAM).
            const uint32_t name = payload + kObjectNameOffset;
            if (!ramSpanFits(name, kObjectNameBytes) || !std::memchr(rdram + (name & PS2_RAM_MASK), 0, kObjectNameBytes))
            {
                detail::refusePacket(ctx, static_cast<uint32_t>(PacketVerdict::NameRefused),
                                     "object update bounded: name not terminated in its field, length at least", kObjectNameBytes);
                return;
            }
        }
        if (detail::objectOriginal())
            detail::objectOriginal()(rdram, ctx, runtime);
        // Nothing here: the original may leave through a scheduler checkpoint and resume later.
    }

    inline void animUpdateBound(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        const uint32_t payload = getRegU32(ctx, 7);
        if (payload != 0u)
        {
            if (!ramSpanFits(payload, 8u))
            {
                detail::refusePacket(ctx, 30u, "animation update bounded: a payload outside guest RAM, length", 8u);
                return;
            }
            const uint8_t *p = rdram + (payload & PS2_RAM_MASK);
            uint32_t walk = 0;
            int16_t index = 0;
            std::memcpy(&walk, p, 4);
            std::memcpy(&index, p + 4, 2);
            const Sites &s = *detail::packetSites();
            const uint32_t round = detail::readU32(rdram, s.roundState);
            const bool inRound = round != 0u && ramSpanFits(round + 0x113u, 1u) && rdram[(round + 0x113u) & PS2_RAM_MASK] == 3u;
            const uint32_t entries = animEntries(detail::readU32(rdram, s.animTable + 0x20u));
            switch (animVerdict(walk, index, entries, inRound))
            {
            case PacketVerdict::WalkRefused:
                detail::refusePacket(ctx, static_cast<uint32_t>(PacketVerdict::WalkRefused), "animation update bounded: length", walk);
                return;
            case PacketVerdict::IndexRefused:
                detail::refusePacket(ctx, static_cast<uint32_t>(PacketVerdict::IndexRefused), "animation update bounded: entry index",
                                     static_cast<uint32_t>(static_cast<int32_t>(index)));
                return;
            default:
                break;
            }
        }
        if (detail::animOriginal())
            detail::animOriginal()(rdram, ctx, runtime);
        // Nothing here: the original may leave through a scheduler checkpoint and resume later.
    }

    // ---- the game's chat packet ----------------------------------------------------------------------------------------
    // u16 size at +0, u16 channel at +2, the text from +4. The packet is refused (the handler's own -1) unless its size
    // is at least the header and a terminator (5), at most the message buffer, inside guest RAM, and the text is
    // terminated inside that size. The handler formats the sender's name and the text into one stack line of
    // kChatLineBytes, whose fixed characters and terminator take at most kChatFormatBytes: a text longer than
    // kChatTextMax - 1, or than the line leaves beside the sender's name, is cut there (its terminator forced), said
    // once, counted. A name that leaves no room empties the text, and the game then formats nothing.
    constexpr uint32_t kChatHeaderBytes = 4u;
    constexpr uint32_t kChatMinBytes = 5u;
    constexpr uint32_t kChatTextMax = 0x60u;       // bytes of text kept, the terminator included
    constexpr uint32_t kChatLineBytes = 144u;      // the handler's stack line
    constexpr uint32_t kChatFormatBytes = 16u;     // the longer format's fixed characters and the terminator
    constexpr uint32_t kChatNameAndText = kChatLineBytes - kChatFormatBytes;
    constexpr uint32_t kChatPlayerSlots = 0x18u;
    constexpr uint32_t kChatNameOffset = 0xeu;
    constexpr uint32_t kChatDefaultName = 7u;      // the game's own name for a slot with no record ("Unknown")

    enum class ChatVerdict : uint8_t { Pass, Cut, Refuse };

    // The characters of text the line keeps beside a name of `nameLen`.
    inline uint32_t chatTextRoom(uint32_t nameLen)
    {
        const uint32_t room = nameLen < kChatNameAndText ? kChatNameAndText - nameLen : 0u;
        return room < kChatTextMax - 1u ? room : kChatTextMax - 1u;
    }

    // `bytes` is the packet as it lies in guest RAM, `available` how many of them are inside RAM; `room` how many
    // characters of text the line keeps. On Cut, `*cutAt` is the text offset the terminator goes to.
    inline ChatVerdict chatVerdict(const uint8_t *bytes, uint32_t available, uint32_t room, uint32_t *cutAt = nullptr)
    {
        if (available < kChatHeaderBytes)
            return ChatVerdict::Refuse;
        uint16_t size = 0;
        std::memcpy(&size, bytes, 2);
        if (size < kChatMinBytes || size > kMessageBytes || size > available)
            return ChatVerdict::Refuse;
        const void *nul = std::memchr(bytes + kChatHeaderBytes, 0, size - kChatHeaderBytes);
        if (!nul)
            return ChatVerdict::Refuse;
        const uint32_t textLen = static_cast<uint32_t>(static_cast<const uint8_t *>(nul) - (bytes + kChatHeaderBytes));
        if (textLen <= room)
            return ChatVerdict::Pass;
        if (cutAt)
            *cutAt = room;
        return ChatVerdict::Cut;
    }

    namespace detail
    {
        inline PS2Runtime::RecompiledFunction &chatOriginal()
        {
            static PS2Runtime::RecompiledFunction fn = nullptr;
            return fn;
        }
        inline std::atomic<uint32_t> &chatCut()
        {
            static std::atomic<uint32_t> n{0};
            return n;
        }

        // The length of the name the handler will format for `sender`, as its name lookup finds it; a name not
        // terminated within the line (or within guest RAM) measures past the line.
        inline uint32_t chatNameLength(const uint8_t *rdram, uint32_t sender)
        {
            const int32_t slot = static_cast<int32_t>(sender);
            if (slot < 0 || slot >= static_cast<int32_t>(kChatPlayerSlots))
                return kChatDefaultName;
            const uint32_t record = readU32(rdram, packetSites()->playerNames + static_cast<uint32_t>(slot) * 8u);
            if (record == 0u)
                return kChatDefaultName;
            const uint32_t name = record + kChatNameOffset;   // wraps as the game's address does; masked below
            const uint32_t at = name & PS2_RAM_MASK;
            const uint32_t inRam = PS2_RAM_SIZE - at;
            const uint32_t look = inRam < kChatNameAndText + 1u ? inRam : kChatNameAndText + 1u;
            const void *nul = std::memchr(rdram + at, 0, look);
            return nul ? static_cast<uint32_t>(static_cast<const uint8_t *>(nul) - (rdram + at)) : kChatNameAndText + 1u;
        }
    }

    inline uint32_t chatTextsCut() { return detail::chatCut().load(); }

    inline void gameChatBound(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        const uint32_t payload = getRegU32(ctx, 7);
        if (payload != 0u)
        {
            const uint32_t at = payload & PS2_RAM_MASK;
            uint8_t *p = rdram + at;
            const uint32_t available = PS2_RAM_SIZE - at;
            const uint32_t room = chatTextRoom(detail::chatNameLength(rdram, getRegU32(ctx, 6)));
            uint32_t cutAt = 0u;
            switch (chatVerdict(p, available, room, &cutAt))
            {
            case ChatVerdict::Refuse:
            {
                uint16_t size = 0;
                if (available >= 2u)
                    std::memcpy(&size, p, 2);
                detail::refusePacket(ctx, 20u, "chat packet bounded: size", size);
                return;
            }
            case ChatVerdict::Cut:
                p[kChatHeaderBytes + cutAt] = 0;
                detail::bump(detail::chatCut());
                if ((detail::packetSaid().fetch_or(1u << 21) & (1u << 21)) == 0u)
                    std::cout << "[socom2] chat packet bounded: text cut to " << cutAt
                              << " characters (first one; every one is)" << std::endl;
                break;
            case ChatVerdict::Pass:
                break;
            }
        }
        if (detail::chatOriginal())
            detail::chatOriginal()(rdram, ctx, runtime);
        // Nothing here: the original may leave through a scheduler checkpoint and resume later.
    }

    // Install every bound on the row's sites; each is independent of the others. Returns how many were installed.
    inline int install(PS2Runtime &runtime, const Sites &sites)
    {
        detail::packetSites() = &sites;
        int installed = 0;
        if (detail::wrapSite(runtime, sites.rtDispatch, "rtDispatch", "rt frame length", rtDispatchBound, detail::rtOriginal()))
            ++installed;
        if (detail::wrapSite(runtime, sites.objectUpdate, "objectUpdate", "object update index", objectUpdateBound, detail::objectOriginal()))
            ++installed;
        if (detail::wrapSite(runtime, sites.animUpdate, "animUpdate", "animation update", animUpdateBound, detail::animOriginal()))
            ++installed;
        if (detail::wrapSite(runtime, sites.gameChat, "gameChat", "chat packet", gameChatBound, detail::chatOriginal()))
            ++installed;
        return installed;
    }
}
