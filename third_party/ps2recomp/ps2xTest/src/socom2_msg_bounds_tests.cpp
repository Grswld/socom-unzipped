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
}
