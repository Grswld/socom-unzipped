// runtime/socom2_msg_bounds.h: the bounds on the game's message dispatcher and the sub-message handlers it calls. The
// game's functions are not in this binary, so each case registers a stand-in at the revision's address, installs the
// bound through the same function-table registry the runner uses, and calls the entry the way the game's caller
// would: the dispatcher's walk (its return address and its two registers), a fragment's re-dispatch (its frame), or
// another caller.
#include "MiniTest.h"
#include "ps2_runtime.h"
#include "runtime/ps2_memory.h"
#include "runtime/socom2_addresses.h"
#include "runtime/socom2_msg_bounds.h"

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace
{
    namespace mb = socom2_msg_bounds;
    const mb::Sites &S = mb::kR0001Sites;

    constexpr uint32_t kOtherCaller = 0x00123450u;   // a return address that is neither the walk nor a re-dispatch
    constexpr uint32_t kStandInReturn = 0x00005EEDu; // what the stand-ins return; no bound returns it
    constexpr uint32_t kMsg = 0x00100000u;           // where a synthetic record sits in guest memory
    constexpr uint32_t kOut = 0x00100800u;           // the lookup's out-parameter
    constexpr uint32_t kFrame = 0x00101000u;         // the fragment handler's stack frame
    constexpr uint32_t kRecord = 0x00101100u;        // its reassembly record

    std::vector<uint8_t> &guestRam()
    {
        static std::vector<uint8_t> ram(PS2_RAM_SIZE, 0u);
        return ram;
    }
    uint8_t *at(uint32_t addr) { return guestRam().data() + addr; }
    void put8(uint32_t addr, uint8_t v) { guestRam()[addr] = v; }
    void put16(uint32_t addr, uint16_t v) { std::memcpy(at(addr), &v, 2); }
    void put32(uint32_t addr, uint32_t v) { std::memcpy(at(addr), &v, 4); }
    uint32_t get32(uint32_t addr)
    {
        uint32_t v = 0;
        std::memcpy(&v, at(addr), 4);
        return v;
    }
    void clearMsg() { std::memset(at(kMsg), 0, 0x800); }

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
        for (size_t p = text.find(what); p != std::string::npos; p = text.find(what, p + 1))
            ++n;
        return n;
    }

    struct StandInSeen
    {
        bool ran = false;
        uint32_t a3 = 0;
    };
    StandInSeen g_seen;

    void standIn(uint8_t *, R5900Context *ctx, PS2Runtime *)
    {
        g_seen.ran = true;
        g_seen.a3 = getRegU32(ctx, 7);
        setReturnU32(ctx, kStandInReturn);
        ctx->pc = getRegU32(ctx, 31);
    }

    // Who calls: the dispatcher's walk with `left` bytes past the header, a fragment's re-dispatch of `left` bytes, or
    // another caller.
    enum class From { Walk, Fragment, Other };
    struct Caller
    {
        From from = From::Other;
        uint32_t left = 0;
        bool lookup = false;   // the lookup's call rather than the handler's
    };
    Caller walk(uint32_t left) { return Caller{From::Walk, left, false}; }
    Caller fragment(uint32_t left) { return Caller{From::Fragment, left, false}; }
    Caller other() { return Caller{}; }

    struct CallResult
    {
        bool ran = false;
        uint32_t v0 = 0;
        uint32_t pc = 0;
        std::string out;
    };

    CallResult call(PS2Runtime &runtime, uint32_t entry, const Caller &c, uint32_t a2 = 1u)
    {
        R5900Context ctx;
        std::memset(&ctx, 0, sizeof(ctx));
        uint32_t ra = kOtherCaller;
        switch (c.from)
        {
        case From::Walk:
            ra = c.lookup ? S.walkLookupReturn : S.walkHandlerReturn;
            setReg(ctx, 20, 0x200u);            // s4: the buffer's length
            setReg(ctx, 18, 0x200u - c.left);   // s2: the offset past the header
            break;
        case From::Fragment:
            ra = c.lookup ? S.fragmentLookupReturn : S.fragmentHandlerReturn;
            put32(kFrame, kRecord);
            put32(kRecord + 8u, c.left);
            setReg(ctx, 29, kFrame);
            break;
        case From::Other:
            setReg(ctx, 18, 0x300u);   // registers that would read as a walk past its end
            setReg(ctx, 20, 0x200u);
            break;
        }
        setReg(ctx, 4, 0u);
        setReg(ctx, 5, 0u);
        setReg(ctx, 6, a2);
        setReg(ctx, 7, kMsg);
        setReg(ctx, 31, ra);
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

    // A runtime with a stand-in at `site` and the bounds installed.
    void installAt(PS2Runtime &runtime, uint32_t site)
    {
        runtime.registerFunction(site, standIn);
        captureOut([&] { mb::install(runtime, S); });
        mb::detail::resetForTest();
    }

    void expectRefused(TestCase &t, const CallResult &r, uint32_t ra, const std::string &what)
    {
        t.IsFalse(r.ran, what + ": the handler never runs");
        t.Equals(r.v0, mb::kHandlerRefused, what + ": v0 is the handler's own refusal");
        t.Equals(r.pc, ra, what + ": the call returns to its caller");
    }
    void expectPassed(TestCase &t, const CallResult &r, const std::string &what)
    {
        t.IsTrue(r.ran, what + ": the handler runs");
        t.Equals(r.v0, kStandInReturn, what + ": with its own return");
        t.Equals(g_seen.a3, kMsg, what + ": and the record as given");
        t.IsTrue(r.out.empty(), what + ": nothing said: '" + r.out + "'");
    }
}

void register_socom2_msg_bounds_tests()
{
    MiniTest::Case("Socom2MsgBoundsSites", [](TestCase &tc)
    {
        tc.Run("r0001 names every site; r0004 names none and binds none", [](TestCase &t)
        {
            const uint32_t *a = &mb::kR0001Sites.dispatchLookup;
            const uint32_t *b = &mb::kR0004Sites.dispatchLookup;
            const size_t fields = (offsetof(mb::Sites, uploadState) - offsetof(mb::Sites, dispatchLookup)) / sizeof(uint32_t) + 1u;
            for (size_t i = 0; i < fields; ++i)
            {
                t.IsTrue(socom2_addresses::available(a[i]), "r0001 field " + std::to_string(i) + " established");
                t.IsFalse(socom2_addresses::available(b[i]), "r0004 field " + std::to_string(i) + " not claimed");
            }
            t.IsTrue(&mb::sitesFor("r0004") == &mb::kR0004Sites, "r0004's row for r0004");
            t.IsTrue(&mb::sitesFor("r0001") == &mb::kR0001Sites, "r0001's row for r0001 and any other");
            PS2Runtime runtime;
            runtime.registerFunction(mb::kR0001Sites.dispatchLookup, standIn);
            int n = -1;
            const std::string out = captureOut([&] { n = mb::install(runtime, mb::kR0004Sites); });
            t.Equals(n, 0, "nothing bound on r0004");
            t.IsTrue(out.find("not bound") != std::string::npos, "and the log says so: " + out);
        });

        tc.Run("with no function at a site nothing is installed there and the log says so", [](TestCase &t)
        {
            PS2Runtime runtime;
            int n = -1;
            const std::string out = captureOut([&] { n = mb::install(runtime, S); });
            t.Equals(n, 0, "nothing installed");
            t.IsFalse(runtime.hasFunction(S.dispatchLookup), "no entry created where there was none");
            t.IsTrue(out.find("not bound") != std::string::npos, "the log says the bound is missing: " + out);
        });
    });

    // ---- G1 ----------------------------------------------------------------------------------------------------------
    MiniTest::Case("Socom2MessageWalkBound", [](TestCase &tc)
    {
        auto lookupCall = [](PS2Runtime &runtime, Caller c)
        {
            c.lookup = true;
            put32(kOut, 0xDEADBEEFu);
            return call(runtime, S.dispatchLookup, c, kOut);   // the lookup is handed its out-parameter in a2
        };

        tc.Run("the walk's lookup with one byte left past the last record is refused before the copy", [=](TestCase &t)
        {
            PS2Runtime runtime;
            installAt(runtime, S.dispatchLookup);
            Caller c = walk(0);
            c.left = static_cast<uint32_t>(-1);   // s2 one past s4: the header's second byte lay outside the buffer
            const CallResult r = lookupCall(runtime, c);
            t.IsFalse(r.ran, "the lookup never runs");
            t.Equals(r.v0, mb::kLookupRefused, "v0 is the lookup's own no-handler code");
            t.Equals(r.pc, S.walkLookupReturn, "the call returns to the walk");
            t.Equals(get32(kOut), 0u, "the out-parameter is cleared, as the lookup's own refusal leaves it");
            t.IsTrue(r.out.find("message bounded") != std::string::npos, "and it is said: " + r.out);
        });

        tc.Run("the walk's lookup with the header inside the buffer reaches the lookup", [=](TestCase &t)
        {
            PS2Runtime runtime;
            installAt(runtime, S.dispatchLookup);
            for (uint32_t left : {0u, 1u, 0x1feu})
            {
                const CallResult r = lookupCall(runtime, walk(left));
                t.IsTrue(r.ran, std::to_string(left) + " bytes past the header: the lookup runs");
                t.Equals(r.v0, kStandInReturn, std::to_string(left) + ": with its own return");
                t.IsTrue(r.out.empty(), std::to_string(left) + ": nothing said");
            }
        });

        tc.Run("a fragment's re-dispatch longer than the scratch, or negative, is refused at the lookup", [=](TestCase &t)
        {
            PS2Runtime runtime;
            installAt(runtime, S.dispatchLookup);
            for (uint32_t total : {0x601u, 0x10000u, 0xFFFFFFFFu, 0x80000000u})
            {
                const CallResult r = lookupCall(runtime, fragment(total));
                const std::string what = "reassembled " + std::to_string(total);
                t.IsFalse(r.ran, what + ": the lookup never runs, so no handler is called");
                t.Equals(r.v0, mb::kLookupRefused, what + ": the lookup's own no-handler code");
                t.Equals(get32(kOut), 0u, what + ": no handler handed back");
            }
            for (uint32_t total : {0u, 0x20u, 0x600u})
                t.IsTrue(lookupCall(runtime, fragment(total)).ran, "reassembled " + std::to_string(total) + " reaches the lookup");
        });

        tc.Run("another caller of the lookup passes through whatever its registers hold", [=](TestCase &t)
        {
            PS2Runtime runtime;
            installAt(runtime, S.dispatchLookup);
            const CallResult r = lookupCall(runtime, other());
            t.IsTrue(r.ran && r.v0 == kStandInReturn && r.out.empty(), "unchanged: '" + r.out + "'");
        });

        tc.Run("a refusal is said once per kind and counted every time", [=](TestCase &t)
        {
            PS2Runtime runtime;
            installAt(runtime, S.dispatchLookup);
            Caller c = walk(0);
            c.left = static_cast<uint32_t>(-1);
            std::string out;
            for (int i = 0; i < 3; ++i)
                out += lookupCall(runtime, c).out;
            t.Equals(count(out, "message bounded"), static_cast<size_t>(1), "one line for three: " + out);
            t.IsTrue(out.find("0x63c950") != std::string::npos, "the line names the function: " + out);
            t.Equals(mb::messagesRefused(), 3u, "every one counted");
            const std::string next = lookupCall(runtime, fragment(0x700u)).out;
            t.Equals(count(next, "message bounded"), static_cast<size_t>(1), "another kind's first is said: " + next);
        });
    });

    // ---- G2 ----------------------------------------------------------------------------------------------------------
    MiniTest::Case("Socom2DmeMessageBound", [](TestCase &tc)
    {
        // Type 0x02: u16 length +2, u16 count +4, u16 index +6, s32 total +0xc, s32 offset +0x10, the data from +0x14.
        auto fragmentMsg = [](uint16_t length, uint16_t count, uint16_t index, int32_t total, int32_t offset)
        {
            clearMsg();
            put16(kMsg + 2u, length);
            put16(kMsg + 4u, count);
            put16(kMsg + 6u, index);
            put32(kMsg + 0xcu, static_cast<uint32_t>(total));
            put32(kMsg + 0x10u, static_cast<uint32_t>(offset));
        };

        tc.Run("a fragment outside its reassembly buffer, its flags or the bytes the walk holds is refused", [=](TestCase &t)
        {
            PS2Runtime runtime;
            installAt(runtime, S.dmeType02);
            struct Case { uint16_t length, count, index; int32_t total, offset; uint32_t left; const char *what; };
            const Case refused[] = {
                {0x10u, 4u, 3u, 0x40, -1, 0x24u, "a negative offset"},
                {0x10u, 4u, 3u, 0x40, 0x31, 0x24u, "an end past the total"},
                {0x10u, 4u, 3u, 0x40, 0x7ffffff8, 0x24u, "an end past an int"},
                {0x10u, 4u, 4u, 0x40, 0x30, 0x24u, "an index at the count"},
                {0x10u, 0u, 0u, 0x40, 0x0, 0x24u, "no flags at all"},
                {0x10u, 4u, 3u, -0x40, 0x0, 0x24u, "a negative total"},
                {0x10u, 4u, 3u, 0x40, 0x30, 0x23u, "data past the bytes the walk holds"},
                {0xffffu, 4u, 3u, 0x40, 0x0, 0x600u, "data past the scratch"},
            };
            for (const Case &c : refused)
            {
                fragmentMsg(c.length, c.count, c.index, c.total, c.offset);
                expectRefused(t, call(runtime, S.dmeType02, walk(c.left)), S.walkHandlerReturn, c.what);
            }
            fragmentMsg(0x10u, 4u, 3u, 0x40, 0x30);
            expectRefused(t, call(runtime, S.dmeType02, fragment(0x23u)), S.fragmentHandlerReturn, "re-dispatched past its record");
        });

        tc.Run("a fragment inside every bound reaches the handler unchanged", [=](TestCase &t)
        {
            PS2Runtime runtime;
            installAt(runtime, S.dmeType02);
            fragmentMsg(0x10u, 4u, 3u, 0x40, 0x30);
            expectPassed(t, call(runtime, S.dmeType02, walk(0x24u)), "the last fragment, to the byte");
            fragmentMsg(0x10u, 4u, 0u, 0x40, 0x0);
            expectPassed(t, call(runtime, S.dmeType02, other()), "the first, from another caller");
            fragmentMsg(0u, 1u, 0u, 0, 0);
            expectPassed(t, call(runtime, S.dmeType02, walk(0x14u)), "an empty fragment of an empty message");
        });

        tc.Run("a ping whose slot is past the ping table is refused; its echo is not a slot", [=](TestCase &t)
        {
            PS2Runtime runtime;
            installAt(runtime, S.dmeType01);
            for (uint8_t slot : {uint8_t(0x7f), uint8_t(0xff)})
            {
                clearMsg();
                put8(kMsg + 4u, slot);
                expectRefused(t, call(runtime, S.dmeType01, walk(8u)), S.walkHandlerReturn, "slot " + std::to_string(slot));
            }
            clearMsg();
            put8(kMsg + 4u, 0x7eu);
            expectPassed(t, call(runtime, S.dmeType01, walk(8u)), "the last slot");
            put8(kMsg + 4u, 0xffu);
            put8(kMsg + 5u, 1u);
            expectPassed(t, call(runtime, S.dmeType01, walk(8u)), "an echo carries any byte");
        });

        tc.Run("a stream record whose callback or data is past its bound is refused", [=](TestCase &t)
        {
            PS2Runtime runtime;
            installAt(runtime, S.dmeType0e);
            clearMsg();
            put8(kMsg + 2u, 0x10u);
            expectRefused(t, call(runtime, S.dmeType0e, walk(0x20u)), S.walkHandlerReturn, "callback 0x10");
            clearMsg();
            put8(kMsg + 2u, 0xffu);
            expectRefused(t, call(runtime, S.dmeType0e, walk(0x20u)), S.walkHandlerReturn, "callback 0xff");
            clearMsg();
            put16(kMsg + 10u, 0x15u);
            expectRefused(t, call(runtime, S.dmeType0e, walk(0x20u)), S.walkHandlerReturn, "data one past the walk's bytes");
            put16(kMsg + 10u, 0xffffu);
            expectRefused(t, call(runtime, S.dmeType0e, other()), kOtherCaller, "data past the scratch");
            clearMsg();
            put8(kMsg + 2u, 0x0fu);
            put16(kMsg + 10u, 0x14u);
            expectPassed(t, call(runtime, S.dmeType0e, walk(0x20u)), "the last callback, data to the byte");
        });

        // Type 0x03 walks the entries of an object class: class 2 has three entries, entry 0 of 2 x 4 bytes.
        constexpr uint32_t kEntry = 0x00102000u, kObject = 0x00102100u;
        constexpr uint16_t kObjectNumber = 5u;
        auto objectClasses = [](bool objectExists)
        {
            const uint32_t cls = S.objectClassTable + 2u * mb::kObjectClassStride;
            std::memset(at(S.objectClassTable), 0, 0x10u * mb::kObjectClassStride);
            put32(cls + 4u, 3u);
            put32(cls + 0x28u, kEntry);
            put32(kEntry + 4u, 2u);
            put32(kEntry + 8u, 4u);
            put8(S.objectState + kObjectNumber, objectExists ? 2u : 0u);
            put32(S.objectTable + kObjectNumber * 4u, objectExists ? kObject : 0u);
            put8(kObject, 2u);
        };
        auto walkMsg = [](uint8_t cls, uint8_t entries)
        {
            clearMsg();
            put8(kMsg, cls);
            put8(kMsg + 1u, entries);
            put16(kMsg + 2u, kObjectNumber);   // entries follow from +4: index 0, then its 8 bytes
        };

        tc.Run("an object record whose entries run past the bytes the walk holds, or whose class is past the table, is refused", [=](TestCase &t)
        {
            PS2Runtime runtime;
            installAt(runtime, S.dmeType03);
            objectClasses(false);
            walkMsg(2u, 2u);   // 4 + 9 + 9 = 22 bytes
            expectRefused(t, call(runtime, S.dmeType03, walk(21u)), S.walkHandlerReturn, "one byte short");
            walkMsg(2u, 0xffu);
            expectRefused(t, call(runtime, S.dmeType03, other()), kOtherCaller, "255 entries past the scratch");
            walkMsg(0x10u, 1u);
            expectRefused(t, call(runtime, S.dmeType03, walk(0x20u)), S.walkHandlerReturn, "class 0x10");
            walkMsg(0xffu, 1u);
            expectRefused(t, call(runtime, S.dmeType03, walk(0x20u)), S.walkHandlerReturn, "class 0xff");
            objectClasses(true);   // the object exists: its own class sizes the walk
            walkMsg(0xffu, 2u);
            expectRefused(t, call(runtime, S.dmeType03, walk(21u)), S.walkHandlerReturn, "an existing object, one byte short");
        });

        tc.Run("an object record inside its bounds, or one the handler refuses itself, reaches the handler", [=](TestCase &t)
        {
            PS2Runtime runtime;
            installAt(runtime, S.dmeType03);
            objectClasses(false);
            walkMsg(2u, 2u);
            expectPassed(t, call(runtime, S.dmeType03, walk(22u)), "two entries, to the byte");
            walkMsg(2u, 0u);
            expectPassed(t, call(runtime, S.dmeType03, walk(4u)), "no entries");
            walkMsg(2u, 2u);
            put8(kMsg + 4u, 3u);   // an entry index at the class's count: the handler's own refusal
            expectPassed(t, call(runtime, S.dmeType03, walk(4u + 1u)), "an index the handler refuses");
            objectClasses(true);
            walkMsg(0xffu, 2u);    // the byte at +0 is not read when the object exists
            expectPassed(t, call(runtime, S.dmeType03, walk(22u)), "an existing object's own class");
        });

        tc.Run("a stream end whose stored slot selects a callback past its table is refused", [=](TestCase &t)
        {
            PS2Runtime runtime;
            installAt(runtime, S.dmeType05);
            constexpr uint32_t kSlots = 0x00103000u;
            const uint32_t slot = kSlots + 3u * mb::kStreamSlotBytes;
            put32(S.streamSlots, kSlots);
            std::memset(at(kSlots), 0, 0x400);
            clearMsg();
            put8(kMsg, 3u);
            put8(slot, 2u);
            put8(slot + 3u, 0x10u);
            expectRefused(t, call(runtime, S.dmeType05, walk(1u)), S.walkHandlerReturn, "a live slot's callback 0x10");
            put8(slot + 3u, 0x0fu);
            expectPassed(t, call(runtime, S.dmeType05, walk(1u)), "a live slot's callback 0x0f");
            put8(slot, 1u);
            put8(slot + 3u, 0xffu);
            expectPassed(t, call(runtime, S.dmeType05, walk(1u)), "a slot that is not live");
            put32(S.streamSlots, 0u);
            expectPassed(t, call(runtime, S.dmeType05, walk(1u)), "no slots yet");
        });

        tc.Run("a record whose name is not terminated in its field, or whose object range passes the table, is refused", [=](TestCase &t)
        {
            PS2Runtime runtime;
            installAt(runtime, S.dmeType0f);
            clearMsg();
            std::memset(at(kMsg + 0x16u), 'N', 0xeu);
            expectRefused(t, call(runtime, S.dmeType0f, walk(0x24u)), S.walkHandlerReturn, "a 14-byte name with no terminator");
            clearMsg();
            put16(kMsg + 10u, 0xff0u);
            put16(kMsg + 0xcu, 0x11u);
            expectRefused(t, call(runtime, S.dmeType0f, walk(0x24u)), S.walkHandlerReturn, "a range one past the table");
            put16(kMsg + 0xcu, 0x10u);
            std::memset(at(kMsg + 0x16u), 'N', 0xdu);
            expectPassed(t, call(runtime, S.dmeType0f, walk(0x24u)), "13 characters and a range to the table's end");
        });

        tc.Run("a class 0 refusal is said once per kind and counted every time", [=](TestCase &t)
        {
            PS2Runtime runtime;
            installAt(runtime, S.dmeType01);
            clearMsg();
            put8(kMsg + 4u, 0x80u);
            std::string out;
            for (int i = 0; i < 3; ++i)
                out += call(runtime, S.dmeType01, walk(8u)).out;
            t.Equals(count(out, "message bounded"), static_cast<size_t>(1), "one line for three: " + out);
            t.IsTrue(out.find("0x61e300") != std::string::npos && out.find("0x80") != std::string::npos,
                     "the line names the function and the value: " + out);
            t.Equals(mb::messagesRefused(), 3u, "every one counted");
        });
    });

    // ---- G3 ----------------------------------------------------------------------------------------------------------
    MiniTest::Case("Socom2AppMessageBound", [](TestCase &tc)
    {
        tc.Run("a radio record whose channel is past the channel records is refused", [](TestCase &t)
        {
            PS2Runtime runtime;
            installAt(runtime, S.appRadio);
            for (uint8_t kind : {uint8_t(1), uint8_t(2), uint8_t(3), uint8_t(4)})
                for (uint8_t channel : {uint8_t(12), uint8_t(0xff)})
                {
                    clearMsg();
                    put8(kMsg + 1u, channel);
                    put8(kMsg + 2u, kind);
                    expectRefused(t, call(runtime, S.appRadio, walk(3u)), S.walkHandlerReturn,
                                  "kind " + std::to_string(kind) + " channel " + std::to_string(channel));
                }
        });

        tc.Run("a radio record inside its channels, or of a kind that takes none, reaches the handler", [](TestCase &t)
        {
            PS2Runtime runtime;
            installAt(runtime, S.appRadio);
            clearMsg();
            put8(kMsg + 1u, 11u);
            put8(kMsg + 2u, 3u);
            expectPassed(t, call(runtime, S.appRadio, walk(3u)), "kind 3, the last channel");
            put8(kMsg + 1u, 0xffu);
            put8(kMsg + 2u, 5u);
            expectPassed(t, call(runtime, S.appRadio, walk(3u)), "kind 5 takes no channel");
            put8(kMsg + 2u, 0u);
            expectPassed(t, call(runtime, S.appRadio, walk(3u)), "kind 0 takes no channel");
        });

        // Names: u16 size, three counts, the names from +5.
        auto namesMsg = [](uint16_t size, uint8_t a, uint8_t b, uint8_t c, const std::string &names)
        {
            clearMsg();
            put16(kMsg, size);
            put8(kMsg + 2u, a);
            put8(kMsg + 3u, b);
            put8(kMsg + 4u, c);
            std::memcpy(at(kMsg + 5u), names.data(), names.size());
        };
        const std::string two("ab\0cd\0", 6);

        tc.Run("a names record whose size or names pass its bounds is refused", [=](TestCase &t)
        {
            PS2Runtime runtime;
            installAt(runtime, S.appNames);
            namesMsg(4u, 0u, 0u, 0u, "");
            expectRefused(t, call(runtime, S.appNames, walk(0x20u)), S.walkHandlerReturn, "size 4");
            namesMsg(11u, 1u, 1u, 0u, two);
            expectRefused(t, call(runtime, S.appNames, walk(10u)), S.walkHandlerReturn, "size past the walk's bytes");
            namesMsg(0x601u, 0u, 0u, 0u, "");
            expectRefused(t, call(runtime, S.appNames, other()), kOtherCaller, "size past the scratch");
            namesMsg(10u, 1u, 1u, 0u, two);
            expectRefused(t, call(runtime, S.appNames, walk(0x20u)), S.walkHandlerReturn, "the second name ends past the size");
            namesMsg(11u, 1u, 1u, 1u, two);
            expectRefused(t, call(runtime, S.appNames, walk(0x20u)), S.walkHandlerReturn, "a third name with no room");
            namesMsg(0x20u, 0xffu, 0xffu, 0xffu, std::string(0x1b, 'X'));
            expectRefused(t, call(runtime, S.appNames, walk(0x20u)), S.walkHandlerReturn, "unterminated names");
        });

        tc.Run("a names record inside its bounds reaches the handler", [=](TestCase &t)
        {
            PS2Runtime runtime;
            installAt(runtime, S.appNames);
            namesMsg(11u, 1u, 1u, 0u, two);
            expectPassed(t, call(runtime, S.appNames, walk(11u)), "two names, to the byte");
            namesMsg(5u, 0u, 0u, 0u, "");
            expectPassed(t, call(runtime, S.appNames, walk(5u)), "no names");
            namesMsg(11u, 0u, 2u, 0u, two);
            expectPassed(t, call(runtime, S.appNames, fragment(11u)), "re-dispatched, to the byte");
        });
    });

    // ---- G4 ----------------------------------------------------------------------------------------------------------
    MiniTest::Case("Socom2FileTransferBound", [](TestCase &tc)
    {
        auto upload = [](uint32_t state, int32_t size)
        {
            put32(S.uploadState, state);
            put32(S.uploadSize, static_cast<uint32_t>(size));
        };
        auto chunkRequest = [](int32_t start, uint32_t wants)
        {
            clearMsg();
            put32(kMsg, static_cast<uint32_t>(start));
            put32(kMsg + 8u, wants);
        };

        tc.Run("a chunk request outside the upload in progress, or with none in progress, is refused", [=](TestCase &t)
        {
            PS2Runtime runtime;
            installAt(runtime, S.lobbyTypeA9);
            upload(1u, 0x100);
            for (int32_t start : {-1, INT32_MIN, 0x101, INT32_MAX})
            {
                chunkRequest(start, 1u);
                expectRefused(t, call(runtime, S.lobbyTypeA9, walk(0x28u)), S.walkHandlerReturn, "start " + std::to_string(start));
            }
            upload(0u, 0x100);
            chunkRequest(0, 1u);
            expectRefused(t, call(runtime, S.lobbyTypeA9, walk(0x28u)), S.walkHandlerReturn, "no upload in progress");
        });

        tc.Run("a chunk request inside the upload, or one asking for nothing, reaches the handler", [=](TestCase &t)
        {
            PS2Runtime runtime;
            installAt(runtime, S.lobbyTypeA9);
            upload(1u, 0x100);
            for (int32_t start : {0, 0x80, 0x100})
            {
                chunkRequest(start, 1u);
                expectPassed(t, call(runtime, S.lobbyTypeA9, walk(0x28u)), "start " + std::to_string(start));
            }
            upload(0u, 0);
            chunkRequest(-1, 0u);
            expectPassed(t, call(runtime, S.lobbyTypeA9, walk(0x28u)), "no chunk asked for");
        });

        auto chunk = [](int32_t start, int32_t size)
        {
            clearMsg();
            put32(kMsg + mb::kChunkBytes, static_cast<uint32_t>(start));
            put32(kMsg + mb::kChunkBytes + 4u, static_cast<uint32_t>(size));
        };

        tc.Run("a file chunk whose start, size or end passes its bounds is refused", [=](TestCase &t)
        {
            PS2Runtime runtime;
            installAt(runtime, S.lobbyTypeAd);
            struct Case { int32_t start, size; const char *what; };
            const Case refused[] = {
                {-1, 0x10, "a negative start"}, {INT32_MIN, 0x1d0, "the least start"}, {0, -1, "a negative size"},
                {0, 0x1d1, "a size past the data field"}, {INT32_MAX - 0x1cf, 0x1d0, "an end past an int"},
            };
            for (const Case &c : refused)
            {
                chunk(c.start, c.size);
                expectRefused(t, call(runtime, S.lobbyTypeAd, walk(0x1fcu)), S.walkHandlerReturn, c.what);
            }
        });

        tc.Run("a file chunk inside its bounds reaches the handler", [=](TestCase &t)
        {
            PS2Runtime runtime;
            installAt(runtime, S.lobbyTypeAd);
            chunk(0, 0);
            expectPassed(t, call(runtime, S.lobbyTypeAd, walk(0x1fcu)), "an empty first chunk");
            chunk(0x400, 0x1d0);
            expectPassed(t, call(runtime, S.lobbyTypeAd, walk(0x1fcu)), "a full chunk");
            chunk(INT32_MAX - 0x1d0, 0x1d0);
            expectPassed(t, call(runtime, S.lobbyTypeAd, walk(0x1fcu)), "a full chunk ending at the int's top");
        });

        tc.Run("a sized record smaller than its size field or past the bytes it has is refused", [](TestCase &t)
        {
            PS2Runtime runtime;
            installAt(runtime, S.lobbyTypeE7);
            for (uint16_t size : {uint16_t(0), uint16_t(1), uint16_t(9)})
            {
                clearMsg();
                put16(kMsg, size);
                expectRefused(t, call(runtime, S.lobbyTypeE7, walk(8u)), S.walkHandlerReturn, "size " + std::to_string(size));
            }
            clearMsg();
            put16(kMsg, 0x11u);
            expectRefused(t, call(runtime, S.lobbyTypeE7, fragment(0x10u)), S.fragmentHandlerReturn, "re-dispatched past its record");
            put16(kMsg, 0x601u);
            expectRefused(t, call(runtime, S.lobbyTypeE7, other()), kOtherCaller, "past the scratch");
        });

        tc.Run("a sized record inside the bytes it has reaches the handler", [](TestCase &t)
        {
            PS2Runtime runtime;
            installAt(runtime, S.lobbyTypeE7);
            clearMsg();
            put16(kMsg, 2u);
            expectPassed(t, call(runtime, S.lobbyTypeE7, walk(8u)), "size 2");
            put16(kMsg, 8u);
            expectPassed(t, call(runtime, S.lobbyTypeE7, walk(8u)), "size 8, to the byte");
            put16(kMsg, 0x10u);
            expectPassed(t, call(runtime, S.lobbyTypeE7, fragment(0x10u)), "re-dispatched, to the byte");
        });
    });
}
