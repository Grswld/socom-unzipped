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
}

void register_socom2_net_bounds_tests()
{
    MiniTest::Case("Socom2NetBoundsSites", [](TestCase &tc)
    {
        tc.Run("both revisions name every site, and no r0004 site is an r0001 address", [](TestCase &t)
        {
            const socom2_net_bounds::Sites &a = socom2_net_bounds::kR0001Sites;
            const socom2_net_bounds::Sites &b = socom2_net_bounds::kR0004Sites;
            t.IsTrue(socom2_addresses::available(a.rtDispatch) && socom2_addresses::available(b.rtDispatch), "rtDispatch");
            t.IsTrue(a.rtDispatch != b.rtDispatch, "rtDispatch moved with the relink");
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
}
