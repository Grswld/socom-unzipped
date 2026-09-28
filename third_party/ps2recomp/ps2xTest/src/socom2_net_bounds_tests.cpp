// runtime/socom2_net_bounds.h: the wraps that bound what the game's network receive path hands its handlers. The
// game's functions are not in this binary, so each case registers a stand-in at the revision's address, installs the
// bound through the same function-table registry the runner uses, and calls the entry the way the game's caller would.
#include "MiniTest.h"
#include "ps2_runtime.h"
#include "runtime/ps2_memory.h"
#include "runtime/socom2_addresses.h"
#include "runtime/socom2_net_bounds.h"

#include <cstdint>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace
{
    constexpr uint32_t kReturnTo = 0x00123450u;      // $ra: where a call that returned leaves the pc
    constexpr uint32_t kStandInReturn = 0x00005EEDu;  // what the stand-ins return; no bound returns it
    constexpr uint32_t kBodyAt = 0x00100000u;         // where a synthetic body sits in guest memory

    std::vector<uint8_t> &guestRam()
    {
        static std::vector<uint8_t> ram(PS2_RAM_SIZE, 0u);
        return ram;
    }

    void setReg(R5900Context &ctx, int reg, uint32_t value) { ctx.r[reg] = _mm_set_epi64x(0, static_cast<int64_t>(value)); }

    template <typename Body>
    std::string captureOut(Body body)
    {
        std::ostringstream sink;
        std::streambuf *old = std::cout.rdbuf(sink.rdbuf());
        body();
        std::cout.rdbuf(old);
        return sink.str();
    }

    size_t count(const std::string &text, const std::string &what)
    {
        size_t n = 0;
        for (size_t at = text.find(what); at != std::string::npos; at = text.find(what, at + 1))
            ++n;
        return n;
    }

    // The stand-in: records that it ran and what it was handed, returns its own code.
    struct StandInSeen
    {
        bool ran = false;
        uint32_t a2 = 0, a3 = 0, t0 = 0;
    };
    StandInSeen g_seen;

    void standIn(uint8_t *, R5900Context *ctx, PS2Runtime *)
    {
        g_seen.ran = true;
        g_seen.a2 = getRegU32(ctx, 6);
        g_seen.a3 = getRegU32(ctx, 7);
        g_seen.t0 = getRegU32(ctx, 8);
        setReturnU32(ctx, kStandInReturn);
        ctx->pc = getRegU32(ctx, 31);
    }

    struct CallResult
    {
        bool ran = false;
        uint32_t v0 = 0;
        uint32_t pc = 0;
        std::string out;
    };

    // One call of the RT dispatcher's entry: (conn, peer, type byte, body, length) in a0..a3, t0.
    CallResult rtCall(PS2Runtime &runtime, uint32_t entry, uint32_t typeByte, uint32_t length)
    {
        R5900Context ctx;
        std::memset(&ctx, 0, sizeof(ctx));
        setReg(ctx, 4, 0x00200000u);
        setReg(ctx, 5, 0x00200100u);
        setReg(ctx, 6, typeByte);
        setReg(ctx, 7, kBodyAt);
        setReg(ctx, 8, length);
        setReg(ctx, 31, kReturnTo);
        setReturnU32(&ctx, 0xFFFFFFFFu);
        ctx.pc = entry;
        g_seen = StandInSeen{};
        CallResult r;
        r.out = captureOut([&] { runtime.lookupFunction(entry)(guestRam().data(), &ctx, &runtime); });
        r.ran = g_seen.ran;
        r.v0 = getRegU32(&ctx, 2);
        r.pc = ctx.pc;
        return r;
    }

    const socom2_net_bounds::Sites *const kAllSites[] = {&socom2_net_bounds::kR0001Sites, &socom2_net_bounds::kR0004Sites};

    void put32(uint32_t at, uint32_t v) { std::memcpy(guestRam().data() + at, &v, 4); }
    void put16(uint32_t at, uint16_t v) { std::memcpy(guestRam().data() + at, &v, 2); }

    // One call of a game-packet handler's entry: (net, a1, sender, payload) in a0..a3, as the game-packet dispatcher
    // passes them.
    CallResult handlerCall(PS2Runtime &runtime, uint32_t entry, uint32_t payload)
    {
        R5900Context ctx;
        std::memset(&ctx, 0, sizeof(ctx));
        setReg(ctx, 4, 0u);
        setReg(ctx, 5, 0u);
        setReg(ctx, 6, 1u);
        setReg(ctx, 7, payload);
        setReg(ctx, 31, kReturnTo);
        setReturnU32(&ctx, 0x0BADu);
        ctx.pc = entry;
        g_seen = StandInSeen{};
        CallResult r;
        r.out = captureOut([&] { runtime.lookupFunction(entry)(guestRam().data(), &ctx, &runtime); });
        r.ran = g_seen.ran;
        r.v0 = getRegU32(&ctx, 2);
        r.pc = ctx.pc;
        return r;
    }

    // The object update's two indexes: the class byte at +1 and the object number at +8.
    void objectPayload(uint8_t cls, uint16_t object)
    {
        std::memset(guestRam().data() + kBodyAt, 0, 0x40);
        guestRam()[kBodyAt + 1] = cls;
        put16(kBodyAt + 8, object);
    }

    // The animation update: the walk length at +0 and the entry index (signed 16-bit) at +4; the entry table holds
    // `entries` entries; `inRound` sets the state the game walks the update in.
    constexpr uint32_t kAnimEntries = 0x00300000u, kRoundRecord = 0x00310000u;
    void animSetup(const socom2_net_bounds::Sites &s, uint32_t entries, bool inRound)
    {
        put32(s.animTable + 0x1cu, kAnimEntries);
        put32(s.animTable + 0x34u, kAnimEntries + entries * 0x34u);
        put32(s.roundState, kRoundRecord);
        guestRam()[kRoundRecord + 0x113u] = inRound ? 3u : 2u;
    }
    void animPayload(uint32_t walk, int16_t index)
    {
        std::memset(guestRam().data() + kBodyAt, 0, 0x40);
        put32(kBodyAt, walk);
        put16(kBodyAt + 4, static_cast<uint16_t>(index));
    }
}

void register_socom2_net_bounds_tests()
{
    MiniTest::Case("Socom2NetBoundsSites", [](TestCase &tc)
    {
        tc.Run("both revisions name every site, and no r0004 site is an r0001 address", [](TestCase &t)
        {
            const socom2_net_bounds::Sites &a = socom2_net_bounds::kR0001Sites;
            const socom2_net_bounds::Sites &b = socom2_net_bounds::kR0004Sites;
            struct Field { const char *name; uint32_t a, b; };
            const Field fields[] = {
                {"rtDispatch", a.rtDispatch, b.rtDispatch},
                {"objectUpdate", a.objectUpdate, b.objectUpdate},
                {"objectClassCount", a.objectClassCount, b.objectClassCount},
                {"animUpdate", a.animUpdate, b.animUpdate},
                {"animTable", a.animTable, b.animTable},
                {"roundState", a.roundState, b.roundState},
                {"gameChat", a.gameChat, b.gameChat},
            };
            for (const Field &f : fields)
            {
                t.IsTrue(socom2_addresses::available(f.a) && socom2_addresses::available(f.b), std::string(f.name) + " established on both");
                t.IsTrue(f.a != f.b, std::string(f.name) + " moved with the relink");
            }
            t.Equals(std::string(a.revision), std::string("r0001"), "the r0001 row");
            t.Equals(std::string(b.revision), std::string("r0004"), "the r0004 row");
        });

        tc.Run("the sites follow the address table's revision", [](TestCase &t)
        {
            t.IsTrue(&socom2_net_bounds::sitesFor("r0004") == &socom2_net_bounds::kR0004Sites, "r0004");
            t.IsTrue(&socom2_net_bounds::sitesFor("r0001") == &socom2_net_bounds::kR0001Sites, "r0001");
            t.IsTrue(&socom2_net_bounds::sitesFor("r9999") == &socom2_net_bounds::kR0001Sites, "an unknown revision is r0001's, as the table's");
        });

        tc.Run("with no function at a site nothing is installed there and the log says so", [](TestCase &t)
        {
            PS2Runtime runtime;
            int n = -1;
            const std::string out = captureOut([&] { n = socom2_net_bounds::install(runtime, socom2_net_bounds::kR0001Sites); });
            t.Equals(n, 0, "nothing installed");
            t.IsFalse(runtime.hasFunction(socom2_net_bounds::kR0001Sites.rtDispatch), "no entry created where there was none");
            t.IsTrue(out.find("not bound") != std::string::npos, "the log says the bound is missing: " + out);
        });
    });

    MiniTest::Case("Socom2RtFrameBound", [](TestCase &tc)
    {
        tc.Run("a frame outside its type's length bound is refused before the handler, on both revisions", [](TestCase &t)
        {
            struct Frame { uint32_t type; uint32_t length; };
            const Frame refused[] = {
                {0x14u, 3u}, {0x14u, 0x41u}, {0x07u, 0x18u}, {0x06u, 0x17u}, {0x08u, 0x53u}, {0x09u, 0x13u},
                {0x11u, 2u}, {0x13u, 0x41u}, {0x1bu, 0x43u}, {0x18u, 0x13u}, {0x19u, 0x1au}, {0x1au, 3u},
                {0x1cu, 3u}, {0x1cu, 0x105u}, {0x02u, 0x603u}, {0x03u, 0x603u}, {0x0au, 0x601u},
                {0x83u, 1u}, {0x9bu, 0u}, {0x94u, 3u}, {0x14u, 0xffffu},
            };
            for (const socom2_net_bounds::Sites *s : kAllSites)
            {
                PS2Runtime runtime;
                runtime.registerFunction(s->rtDispatch, standIn);
                captureOut([&] { socom2_net_bounds::install(runtime, *s); });
                for (const Frame &f : refused)
                {
                    const std::string what = std::string(s->revision) + " type " + std::to_string(f.type) + " length " + std::to_string(f.length);
                    const CallResult r = rtCall(runtime, s->rtDispatch, f.type, f.length);
                    t.IsFalse(r.ran, what + ": the handler never runs");
                    t.Equals(r.v0, socom2_net_bounds::kRtSkipped, what + ": v0 is the walk's go-on value");
                    t.Equals(r.pc, kReturnTo, what + ": the call returns to its caller");
                }
                runtime.registerFunction(s->rtDispatch, nullptr);
            }
        });

        tc.Run("the two refused record types never reach their handler, at any length", [](TestCase &t)
        {
            PS2Runtime runtime;
            const socom2_net_bounds::Sites &s = socom2_net_bounds::kR0001Sites;
            runtime.registerFunction(s.rtDispatch, standIn);
            captureOut([&] { socom2_net_bounds::install(runtime, s); });
            const uint32_t types[] = {0x1du, 0x9du, 0x1eu, 0x9eu};
            const uint32_t lengths[] = {0u, 0xdu, 0x20u, 0x1f3u};
            for (uint32_t type : types)
                for (uint32_t length : lengths)
                {
                    const CallResult r = rtCall(runtime, s.rtDispatch, type, length);
                    t.IsFalse(r.ran, "type " + std::to_string(type) + " length " + std::to_string(length) + ": refused");
                }
            runtime.registerFunction(s.rtDispatch, nullptr);
        });

        tc.Run("a frame within its type's bound reaches the handler with its registers unchanged", [](TestCase &t)
        {
            struct Frame { uint32_t type; uint32_t length; };
            const Frame passed[] = {
                {0x14u, 0x40u}, {0x07u, 0x17u}, {0x06u, 0x16u}, {0x08u, 0x52u}, {0x09u, 0x12u}, {0x11u, 1u},
                {0x13u, 0x40u}, {0x1bu, 0x42u}, {0x18u, 0x12u}, {0x19u, 0x19u}, {0x1au, 2u}, {0x1cu, 4u},
                {0x1cu, 0x104u}, {0x02u, 0x602u}, {0x03u, 2u}, {0x0au, 0x600u}, {0x83u, 0x10u}, {0x05u, 1u},
                {0x94u, 0x40u}, {0x8au, 0u},
            };
            PS2Runtime runtime;
            const socom2_net_bounds::Sites &s = socom2_net_bounds::kR0001Sites;
            runtime.registerFunction(s.rtDispatch, standIn);
            captureOut([&] { socom2_net_bounds::install(runtime, s); });
            for (const Frame &f : passed)
            {
                const std::string what = "type " + std::to_string(f.type) + " length " + std::to_string(f.length);
                const CallResult r = rtCall(runtime, s.rtDispatch, f.type, f.length);
                t.IsTrue(r.ran, what + ": the handler runs");
                t.Equals(r.v0, kStandInReturn, what + ": its return is the caller's");
                t.Equals(g_seen.a2, f.type, what + ": the type byte as given");
                t.Equals(g_seen.t0, f.length, what + ": the length as given");
                t.Equals(g_seen.a3, kBodyAt, what + ": the body as given");
            }
            runtime.registerFunction(s.rtDispatch, nullptr);
        });

        tc.Run("an unmapped type passes through unchanged and is said once", [](TestCase &t)
        {
            PS2Runtime runtime;
            const socom2_net_bounds::Sites &s = socom2_net_bounds::kR0001Sites;
            runtime.registerFunction(s.rtDispatch, standIn);
            captureOut([&] { socom2_net_bounds::install(runtime, s); });
            socom2_net_bounds::detail::resetRtForTest();
            const CallResult first = rtCall(runtime, s.rtDispatch, 0x20u, 0x700u);
            const CallResult second = rtCall(runtime, s.rtDispatch, 0x20u, 5u);
            const CallResult other = rtCall(runtime, s.rtDispatch, 0x04u, 9u);
            t.IsTrue(first.ran && second.ran && other.ran, "every unmapped frame reaches the handler");
            t.Equals(first.v0, kStandInReturn, "with the handler's own return");
            t.IsTrue(first.out.find("rt frame type 0x20 unmapped") != std::string::npos, "the first is said: " + first.out);
            t.IsTrue(second.out.empty(), "the second of the same type is silent: '" + second.out + "'");
            t.IsTrue(other.out.find("rt frame type 0x4 unmapped") != std::string::npos, "another type is said too: " + other.out);
            runtime.registerFunction(s.rtDispatch, nullptr);
        });

        tc.Run("a refusal is said once per type and counted every time", [](TestCase &t)
        {
            PS2Runtime runtime;
            const socom2_net_bounds::Sites &s = socom2_net_bounds::kR0001Sites;
            runtime.registerFunction(s.rtDispatch, standIn);
            captureOut([&] { socom2_net_bounds::install(runtime, s); });
            socom2_net_bounds::detail::resetRtForTest();
            std::string out;
            for (int i = 0; i < 3; ++i)
                out += rtCall(runtime, s.rtDispatch, 0x14u, 3u).out;
            t.Equals(count(out, "rt frame bounded"), static_cast<size_t>(1), "one line for three refusals: " + out);
            t.IsTrue(out.find("type 0x14") != std::string::npos && out.find("length 3") != std::string::npos,
                     "the line names the type and the length: " + out);
            t.Equals(socom2_net_bounds::rtFramesRefused(), 3u, "every refusal is counted");
            const std::string next = rtCall(runtime, s.rtDispatch, 0x18u, 0x13u).out;
            t.Equals(count(next, "rt frame bounded"), static_cast<size_t>(1), "another type's first refusal is said: " + next);
            runtime.registerFunction(s.rtDispatch, nullptr);
        });

        tc.Run("an echo longer than its record passes and is said once", [](TestCase &t)
        {
            PS2Runtime runtime;
            const socom2_net_bounds::Sites &s = socom2_net_bounds::kR0001Sites;
            runtime.registerFunction(s.rtDispatch, standIn);
            captureOut([&] { socom2_net_bounds::install(runtime, s); });
            socom2_net_bounds::detail::resetRtForTest();
            const CallResult first = rtCall(runtime, s.rtDispatch, 0x05u, 4u);
            const CallResult second = rtCall(runtime, s.rtDispatch, 0x05u, 9u);
            t.IsTrue(first.ran && second.ran, "the echo reaches the handler");
            t.IsTrue(first.out.find("longer than its record") != std::string::npos, "and is said: " + first.out);
            t.IsTrue(second.out.empty(), "once: '" + second.out + "'");
            t.Equals(socom2_net_bounds::rtFramesRefused(), 0u, "not a refusal");
            runtime.registerFunction(s.rtDispatch, nullptr);
        });
    });

    MiniTest::Case("Socom2ObjectUpdateBound", [](TestCase &tc)
    {
        tc.Run("an object update whose class or object index is out of its table is refused, on both revisions", [](TestCase &t)
        {
            struct Case { uint8_t cls; uint16_t object; const char *what; };
            const Case refused[] = {
                {0x10u, 5u, "class 0x10"}, {0xffu, 5u, "class 0xff"}, {3u, 5u, "class == the registered count"},
                {2u, 0x1000u, "object 0x1000"}, {2u, 0xffffu, "object 0xffff"},
            };
            for (const socom2_net_bounds::Sites *s : kAllSites)
            {
                PS2Runtime runtime;
                runtime.registerFunction(s->objectUpdate, standIn);
                captureOut([&] { socom2_net_bounds::install(runtime, *s); });
                put32(s->objectClassCount, 3u);
                for (const Case &c : refused)
                {
                    const std::string what = std::string(s->revision) + " " + c.what;
                    objectPayload(c.cls, c.object);
                    const CallResult r = handlerCall(runtime, s->objectUpdate, kBodyAt);
                    t.IsFalse(r.ran, what + ": the handler never runs");
                    t.Equals(r.v0, socom2_net_bounds::kHandlerRefused, what + ": v0 is the handler's own refusal");
                    t.Equals(r.pc, kReturnTo, what + ": the call returns to its caller");
                }
                // A registered count past the table's size does not widen the bound.
                put32(s->objectClassCount, 0x20u);
                objectPayload(0x10u, 5u);
                t.IsFalse(handlerCall(runtime, s->objectUpdate, kBodyAt).ran, std::string(s->revision) + ": class 0x10 with a count of 0x20");
                runtime.registerFunction(s->objectUpdate, nullptr);
            }
        });

        tc.Run("an object update inside both tables reaches the handler unchanged", [](TestCase &t)
        {
            for (const socom2_net_bounds::Sites *s : kAllSites)
            {
                PS2Runtime runtime;
                runtime.registerFunction(s->objectUpdate, standIn);
                captureOut([&] { socom2_net_bounds::install(runtime, *s); });
                put32(s->objectClassCount, 3u);
                objectPayload(2u, 0xfffu);
                const CallResult r = handlerCall(runtime, s->objectUpdate, kBodyAt);
                t.IsTrue(r.ran, std::string(s->revision) + ": the handler runs");
                t.Equals(r.v0, kStandInReturn, std::string(s->revision) + ": with its own return");
                t.Equals(g_seen.a3, kBodyAt, std::string(s->revision) + ": and the payload as given");
                t.IsTrue(r.out.empty(), std::string(s->revision) + ": nothing said: '" + r.out + "'");
                runtime.registerFunction(s->objectUpdate, nullptr);
            }
        });

        tc.Run("an object update refusal is said once per index and counted every time", [](TestCase &t)
        {
            PS2Runtime runtime;
            const socom2_net_bounds::Sites &s = socom2_net_bounds::kR0001Sites;
            runtime.registerFunction(s.objectUpdate, standIn);
            captureOut([&] { socom2_net_bounds::install(runtime, s); });
            socom2_net_bounds::detail::resetPacketsForTest();
            put32(s.objectClassCount, 3u);
            std::string out;
            for (int i = 0; i < 3; ++i)
            {
                objectPayload(0x40u, 1u);
                out += handlerCall(runtime, s.objectUpdate, kBodyAt).out;
                objectPayload(1u, 0x2000u);
                out += handlerCall(runtime, s.objectUpdate, kBodyAt).out;
            }
            t.Equals(count(out, "object update bounded"), static_cast<size_t>(2), "one line per index for six refusals: " + out);
            t.Equals(socom2_net_bounds::packetsRefused(), 6u, "every refusal is counted");
            runtime.registerFunction(s.objectUpdate, nullptr);
        });
    });

    MiniTest::Case("Socom2AnimUpdateBound", [](TestCase &tc)
    {
        tc.Run("an animation update whose walk passes the message buffer is refused, on both revisions", [](TestCase &t)
        {
            const uint32_t walks[] = {0x601u, 0x10000u, 0xffffffffu};
            for (const socom2_net_bounds::Sites *s : kAllSites)
            {
                PS2Runtime runtime;
                runtime.registerFunction(s->animUpdate, standIn);
                captureOut([&] { socom2_net_bounds::install(runtime, *s); });
                for (bool inRound : {true, false})
                {
                    animSetup(*s, 4u, inRound);
                    for (uint32_t walk : walks)
                    {
                        animPayload(walk, 1);
                        const CallResult r = handlerCall(runtime, s->animUpdate, kBodyAt);
                        const std::string what = std::string(s->revision) + " walk " + std::to_string(walk);
                        t.IsFalse(r.ran, what + ": the handler never runs");
                        t.Equals(r.v0, socom2_net_bounds::kHandlerRefused, what + ": v0 is the handler's own refusal");
                        t.Equals(r.pc, kReturnTo, what + ": the call returns to its caller");
                    }
                }
                runtime.registerFunction(s->animUpdate, nullptr);
            }
        });

        tc.Run("in a round, an animation update whose entry index is out of the table is refused", [](TestCase &t)
        {
            const int16_t indexes[] = {-1, -0x8000, 4, 0x7fff};
            for (const socom2_net_bounds::Sites *s : kAllSites)
            {
                PS2Runtime runtime;
                runtime.registerFunction(s->animUpdate, standIn);
                captureOut([&] { socom2_net_bounds::install(runtime, *s); });
                animSetup(*s, 4u, true);
                for (int16_t index : indexes)
                {
                    animPayload(0x10u, index);
                    const CallResult r = handlerCall(runtime, s->animUpdate, kBodyAt);
                    const std::string what = std::string(s->revision) + " index " + std::to_string(index);
                    t.IsFalse(r.ran, what + ": the handler never runs");
                    t.Equals(r.v0, socom2_net_bounds::kHandlerRefused, what + ": v0 is the handler's own refusal");
                }
                animSetup(*s, 0u, true);
                animPayload(0x10u, 0);
                t.IsFalse(handlerCall(runtime, s->animUpdate, kBodyAt).ran, std::string(s->revision) + ": an empty table has no entry 0");
                runtime.registerFunction(s->animUpdate, nullptr);
            }
        });

        tc.Run("an animation update inside its bounds, or its index outside a round, reaches the handler", [](TestCase &t)
        {
            for (const socom2_net_bounds::Sites *s : kAllSites)
            {
                PS2Runtime runtime;
                runtime.registerFunction(s->animUpdate, standIn);
                captureOut([&] { socom2_net_bounds::install(runtime, *s); });
                animSetup(*s, 4u, true);
                animPayload(0x10u, 1);
                CallResult r = handlerCall(runtime, s->animUpdate, kBodyAt);
                t.IsTrue(r.ran && r.v0 == kStandInReturn, std::string(s->revision) + ": walk 0x10, index 1");
                animPayload(0x600u, 3);
                t.IsTrue(handlerCall(runtime, s->animUpdate, kBodyAt).ran, std::string(s->revision) + ": walk 0x600, index 3");
                animSetup(*s, 4u, false);
                animPayload(0x10u, 0x7fff);
                r = handlerCall(runtime, s->animUpdate, kBodyAt);
                t.IsTrue(r.ran, std::string(s->revision) + ": outside a round the game does not read the index");
                runtime.registerFunction(s->animUpdate, nullptr);
            }
        });
    });

    MiniTest::Case("Socom2GameChatBound", [](TestCase &tc)
    {
        // The chat packet: u16 size at +0, u16 channel at +2, the text from +4.
        auto chatPacket = [](uint32_t at, uint16_t size, const std::string &text, bool terminate)
        {
            std::memset(guestRam().data() + at, 0, 0x700);
            std::memcpy(guestRam().data() + at, &size, 2);
            std::memcpy(guestRam().data() + at + 4, text.data(), text.size());
            if (!terminate)
                guestRam()[at + 4 + text.size()] = 'Z';
        };

        tc.Run("a chat packet whose size or text does not fit is refused, on both revisions", [=](TestCase &t)
        {
            struct Case { uint16_t size; std::string text; bool terminate; const char *what; };
            const Case refused[] = {
                {5u, "", true, "size 5"},
                {0x601u, "hi", true, "size 0x601"},
                {0xffffu, "hi", true, "size 0xffff"},
                {0x20u, std::string(0x40, 'A'), true, "no terminator inside the size"},
                {0x20u, std::string(0x1c, 'A'), false, "the text runs to the size's end"},
            };
            for (const socom2_net_bounds::Sites *s : kAllSites)
            {
                PS2Runtime runtime;
                runtime.registerFunction(s->gameChat, standIn);
                captureOut([&] { socom2_net_bounds::install(runtime, *s); });
                for (const Case &c : refused)
                {
                    chatPacket(kBodyAt, c.size, c.text, c.terminate);
                    const CallResult r = handlerCall(runtime, s->gameChat, kBodyAt);
                    const std::string what = std::string(s->revision) + " " + c.what;
                    t.IsFalse(r.ran, what + ": the handler never runs");
                    t.Equals(r.v0, socom2_net_bounds::kHandlerRefused, what + ": v0 is the handler's own refusal");
                    t.Equals(r.pc, kReturnTo, what + ": the call returns to its caller");
                }
                // A packet whose size runs past the end of guest RAM.
                const uint32_t top = PS2_RAM_SIZE - 8u;
                std::memset(guestRam().data() + top, 0, 8);
                const uint16_t size = 0x40u;
                std::memcpy(guestRam().data() + top, &size, 2);
                t.IsFalse(handlerCall(runtime, s->gameChat, top).ran, std::string(s->revision) + ": a size past the end of RAM");
                runtime.registerFunction(s->gameChat, nullptr);
            }
        });

        tc.Run("a chat packet whose text is longer than the line keeps is cut there and delivered", [=](TestCase &t)
        {
            for (const socom2_net_bounds::Sites *s : kAllSites)
            {
                PS2Runtime runtime;
                runtime.registerFunction(s->gameChat, standIn);
                captureOut([&] { socom2_net_bounds::install(runtime, *s); });
                socom2_net_bounds::detail::resetPacketsForTest();
                const std::string text(200, 'A');
                chatPacket(kBodyAt, static_cast<uint16_t>(text.size() + 6u), text, true);
                const CallResult r = handlerCall(runtime, s->gameChat, kBodyAt);
                const uint32_t cut = kBodyAt + 4u + socom2_net_bounds::kChatTextMax - 1u;
                t.IsTrue(r.ran, std::string(s->revision) + ": the handler runs");
                t.Equals(r.v0, kStandInReturn, std::string(s->revision) + ": with its own return");
                t.Equals(static_cast<unsigned>(guestRam()[cut]), 0u, std::string(s->revision) + ": the terminator is forced at the cut");
                t.Equals(static_cast<unsigned>(guestRam()[cut - 1u]), static_cast<unsigned>('A'), std::string(s->revision) + ": the text before it is kept");
                t.IsTrue(r.out.find("chat packet bounded") != std::string::npos, std::string(s->revision) + ": and said: " + r.out);
                t.IsTrue(handlerCall(runtime, s->gameChat, kBodyAt).out.empty(), std::string(s->revision) + ": once");
                runtime.registerFunction(s->gameChat, nullptr);
            }
        });

        tc.Run("a chat line within its bounds reaches the handler unchanged", [=](TestCase &t)
        {
            for (const socom2_net_bounds::Sites *s : kAllSites)
            {
                PS2Runtime runtime;
                runtime.registerFunction(s->gameChat, standIn);
                captureOut([&] { socom2_net_bounds::install(runtime, *s); });
                const std::string longest(socom2_net_bounds::kChatTextMax - 1u, 'B');
                for (const std::string &text : {std::string("hello"), std::string(""), longest})
                {
                    chatPacket(kBodyAt, static_cast<uint16_t>(text.size() + 6u), text, true);
                    const std::vector<uint8_t> before(guestRam().begin() + kBodyAt, guestRam().begin() + kBodyAt + 0x100);
                    const CallResult r = handlerCall(runtime, s->gameChat, kBodyAt);
                    const std::vector<uint8_t> after(guestRam().begin() + kBodyAt, guestRam().begin() + kBodyAt + 0x100);
                    const std::string what = std::string(s->revision) + " text of " + std::to_string(text.size());
                    t.IsTrue(r.ran, what + ": the handler runs");
                    t.Equals(r.v0, kStandInReturn, what + ": with its own return");
                    t.IsTrue(after == before, what + ": the packet is unchanged");
                    t.IsTrue(r.out.empty(), what + ": nothing said: '" + r.out + "'");
                }
                runtime.registerFunction(s->gameChat, nullptr);
            }
        });
    });
}
