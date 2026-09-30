#pragma once

// Sprint 17 F (research/81 §3.4): why the native VU1 dispatcher refuses, counted.
//
// The hand-written dispatcher (src/lib/vu/native/socom2_dispatch_0x1b50.cpp) refuses a share of the mission's
// dispatcher entries, which then run the generated program instead. Under PS2X_VU1_NATIVE_REFUSALS=1 (a Dev
// Flag, default 0) every refusal site notes (entry pc, reason, command word) here, and VU1Interpreter::run adds
// the VU cycles and the host time the fallback then ran -- to the refusal's key, across every slice of a program
// a budget stop split -- so a reading says how much generated TIME each reason costs, not only how many entries.
//
//   [vu1-refuse] elapsed=1002ms entry=0x1b50 reason=unknown_command cmd=0x52 n=37 cycles=412345 host_us=5120
//
// one line per key with a count in the interval, once a second from the VU1 thread, sorted by n (the [gs-loop]
// instrument's pattern: atomic accumulators, the interval taken by one printer). vu1_replay prints the same
// fields as totals, `[vu1-refuse-total] ...`, at its end. tools_py/parity/vu1_refusals.py reads either into a
// table of reason, entries, share and cycles.
//
// With the knob off nothing is counted and nothing is printed: a refusal site pays one predictable branch on a
// relaxed load (the refusal is already the cold path), run() one more per call. Header-only, so ps2x_tests
// checks the table and the format directly.

#include "ps2x/knobs.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <mutex>
#include <string>
#include <vector>

namespace Vu1Refusals
{
    // Stable names: tools_py/parity/vu1_refusals.py and the Log read them. Append; never renumber a printed name.
    enum class Reason : uint8_t
    {
        None = 0,
        // VU1Interpreter::run (ps2_vu1_core.cpp): native never entered.
        NoNativeEntry,     // the image has a native program, but not at this entry pc (0x0000; 0x33c8 unless its knob)
        StateGuard,        // native registered at this pc, but a D/T bit, E bit, halt or branch is pending
        // The dispatcher's whole-list refusals: pc stays at the entry, nothing touched.
        NoDataMemory,      // no active VU data memory, or under 16 KB
        XgkickCycleExact,  // PS2X_VU1_XGKICK_CYCLE_EXACT=1: the per-triangle kicks would drop packets
        ListTooLong,       // the walk reached kMaxListQwords (64) list qwords
        UnknownCommand,    // a command word with no handler (0x52, 0x66): cmd= names it
        ClipBeforeWorld,   // 0x2a, 0x4c or 0x32 before any 0x02 (the clipper output is stale)
        ZeroBlockCount,    // 0x30/0x32/0x34 with N < 1 inline blocks
        SphereBlockCount,  // 0x34 with N != 1
        BlockPastList,     // an inline block runs past kMaxListQwords
        BlockNotOnePacket, // an inline block is not one EOP-terminated GIF packet inside its qwords
        NoEnd,             // no 0x42 within kMaxCommands (32) dispatches
        HeaderVertices,    // TOP+2.z outside 0..kMaxVertices (256)
        HeaderTriangles,   // TOP+2.w outside 0..kMaxTriangles (256)
        FamilyBZeroPrims,  // a family-B list with a zero primitive count
        InlineZeroVerts,   // a 0x30/0x34 list with a zero vertex count
        // The dispatcher's mid-list hand-backs, at 0x1b60: the microcode resumes the command.
        HandlerClamp,      // a handler's ceiling clamp (or 0x30/0x32's dead JR vi6 guard): cmd= names it
        MidUnknownCommand, // runCommand's default: a command the pre-scan let through with no handler
        // VU1Interpreter::run: a native program handed back without naming a reason (a test table's program).
        UnnamedHandBack,
        // Sprint 17 F N1 (research/82): the native program at entry 0x33c8, whole-program refusals, pc left there.
        SkinPass,          // vi5 bit 2 clear: the microcode's `B 0x3100`, another 0x52 bone pass (no native 0x52)
        RepackRange,       // vi9 outside 1..256, or the repack's records wrap VU memory or overlap the command list
        ResumeIndex,       // the live-in vi14 the dispatcher resumes at is outside the list's 64 qwords
        WriteRange,        // cmd='s stores would wrap VU memory or land on the list, TOP+2 or q329 (0x66, 0x08, 0x40)
        ResumeCommand,     // the resumed list holds a command outside 0x66 0x08 0x40 (write ranges unproven): cmd=
        kCount
    };

    inline const char *name(Reason r)
    {
        switch (r)
        {
        case Reason::None: return "none";
        case Reason::NoNativeEntry: return "no_native_entry";
        case Reason::StateGuard: return "state_guard";
        case Reason::NoDataMemory: return "no_data_memory";
        case Reason::XgkickCycleExact: return "xgkick_cycle_exact";
        case Reason::ListTooLong: return "list_too_long";
        case Reason::UnknownCommand: return "unknown_command";
        case Reason::ClipBeforeWorld: return "clip_before_world";
        case Reason::ZeroBlockCount: return "zero_block_count";
        case Reason::SphereBlockCount: return "sphere_block_count";
        case Reason::BlockPastList: return "block_past_list";
        case Reason::BlockNotOnePacket: return "block_not_one_packet";
        case Reason::NoEnd: return "no_end";
        case Reason::HeaderVertices: return "header_vertices";
        case Reason::HeaderTriangles: return "header_triangles";
        case Reason::FamilyBZeroPrims: return "family_b_zero_prims";
        case Reason::InlineZeroVerts: return "inline_zero_verts";
        case Reason::HandlerClamp: return "handler_clamp";
        case Reason::MidUnknownCommand: return "mid_unknown_command";
        case Reason::UnnamedHandBack: return "unnamed_handback";
        case Reason::SkinPass: return "skin_pass";
        case Reason::RepackRange: return "repack_range";
        case Reason::ResumeIndex: return "resume_index";
        case Reason::WriteRange: return "write_range";
        case Reason::ResumeCommand: return "resume_command";
        default: return "unknown";
        }
    }

    // Whether a reason's key carries the command word it refused on (cmd= is `-` otherwise).
    inline bool hasCommand(Reason r)
    {
        return r == Reason::UnknownCommand || r == Reason::ClipBeforeWorld || r == Reason::ZeroBlockCount ||
               r == Reason::SphereBlockCount || r == Reason::BlockPastList || r == Reason::BlockNotOnePacket ||
               r == Reason::HandlerClamp || r == Reason::MidUnknownCommand || r == Reason::WriteRange ||
               r == Reason::ResumeCommand;
    }

    // A refusal as a site reports it.
    struct Refusal
    {
        Reason reason = Reason::None;
        uint32_t command = 0u;
    };

    // One row: the key and its counters. `key` is 0 while the slot is free, else packKey()+1.
    constexpr uint32_t kSlots = 128u;

    inline uint64_t packKey(uint32_t entryPc, Reason reason, uint32_t command)
    {
        return (static_cast<uint64_t>(entryPc & 0xFFFFu) << 24) | (static_cast<uint64_t>(reason) << 16) |
               (hasCommand(reason) ? (command & 0xFFFFu) : 0u);
    }

    struct Row
    {
        uint32_t entryPc = 0u;
        Reason reason = Reason::None;
        uint32_t command = 0u;
        uint64_t n = 0u;
        uint64_t cycles = 0u;
        uint64_t hostNs = 0u;
    };

    // The accumulator. note() and addCost() are safe from any thread (a slot is claimed by CAS); take() and
    // totals() read it.
    class Table
    {
    public:
        // Counts one refusal under its key; returns the slot, or -1 when all kSlots keys are taken (overflow()).
        int note(uint32_t entryPc, Reason reason, uint32_t command)
        {
            const uint64_t key = packKey(entryPc, reason, command) + 1u;
            uint32_t h = static_cast<uint32_t>((key * 0x9E3779B97F4A7C15ull) >> 57) % kSlots;
            for (uint32_t probe = 0; probe < kSlots; ++probe, h = (h + 1u) % kSlots)
            {
                uint64_t seen = m_key[h].load(std::memory_order_acquire);
                if (seen == 0u)
                {
                    uint64_t expected = 0u;
                    if (m_key[h].compare_exchange_strong(expected, key, std::memory_order_acq_rel))
                        seen = key;
                    else
                        seen = expected;
                }
                if (seen == key)
                {
                    m_n[h].fetch_add(1u, std::memory_order_relaxed);
                    return static_cast<int>(h);
                }
            }
            m_overflow.fetch_add(1u, std::memory_order_relaxed);
            return -1;
        }

        void addCost(int slot, uint64_t cycles, uint64_t hostNs)
        {
            if (slot < 0 || slot >= static_cast<int>(kSlots))
                return;
            m_cycles[slot].fetch_add(cycles, std::memory_order_relaxed);
            m_ns[slot].fetch_add(hostNs, std::memory_order_relaxed);
        }

        // Every key's running totals (n > 0 or cost > 0), sorted by n, then cycles, descending.
        std::vector<Row> totals() const
        {
            std::vector<Row> rows;
            for (uint32_t s = 0; s < kSlots; ++s)
            {
                const uint64_t key = m_key[s].load(std::memory_order_acquire);
                if (key == 0u)
                    continue;
                rows.push_back(rowFor(key - 1u, m_n[s].load(std::memory_order_relaxed),
                                      m_cycles[s].load(std::memory_order_relaxed),
                                      m_ns[s].load(std::memory_order_relaxed)));
            }
            sortRows(rows);
            return rows;
        }

        // The interval since the last take(): the rows whose counters moved, sorted. One caller at a time
        // (the printer holds printMutex()).
        std::vector<Row> take()
        {
            std::vector<Row> rows;
            for (uint32_t s = 0; s < kSlots; ++s)
            {
                const uint64_t key = m_key[s].load(std::memory_order_acquire);
                if (key == 0u)
                    continue;
                const uint64_t n = m_n[s].load(std::memory_order_relaxed);
                const uint64_t cycles = m_cycles[s].load(std::memory_order_relaxed);
                const uint64_t ns = m_ns[s].load(std::memory_order_relaxed);
                if (n != m_lastN[s] || cycles != m_lastCycles[s])
                    rows.push_back(rowFor(key - 1u, n - m_lastN[s], cycles - m_lastCycles[s], ns - m_lastNs[s]));
                m_lastN[s] = n;
                m_lastCycles[s] = cycles;
                m_lastNs[s] = ns;
            }
            sortRows(rows);
            return rows;
        }

        uint64_t overflow() const { return m_overflow.load(std::memory_order_relaxed); }

        // Counts for one reason over every key (tests; the scorer does its own sums).
        uint64_t countFor(Reason reason) const
        {
            uint64_t sum = 0u;
            for (const Row &r : totals())
                if (r.reason == reason)
                    sum += r.n;
            return sum;
        }

        uint64_t cyclesFor(Reason reason) const
        {
            uint64_t sum = 0u;
            for (const Row &r : totals())
                if (r.reason == reason)
                    sum += r.cycles;
            return sum;
        }

        uint64_t totalCount() const
        {
            uint64_t sum = 0u;
            for (const Row &r : totals())
                sum += r.n;
            return sum;
        }

    private:
        static Row rowFor(uint64_t packed, uint64_t n, uint64_t cycles, uint64_t ns)
        {
            Row row;
            row.entryPc = static_cast<uint32_t>((packed >> 24) & 0xFFFFu);
            row.reason = static_cast<Reason>((packed >> 16) & 0xFFu);
            row.command = static_cast<uint32_t>(packed & 0xFFFFu);
            row.n = n;
            row.cycles = cycles;
            row.hostNs = ns;
            return row;
        }

        static void sortRows(std::vector<Row> &rows)
        {
            std::stable_sort(rows.begin(), rows.end(), [](const Row &a, const Row &b) {
                return a.n != b.n ? a.n > b.n : a.cycles > b.cycles;
            });
        }

        std::atomic<uint64_t> m_key[kSlots] = {};
        std::atomic<uint64_t> m_n[kSlots] = {};
        std::atomic<uint64_t> m_cycles[kSlots] = {};
        std::atomic<uint64_t> m_ns[kSlots] = {};
        std::atomic<uint64_t> m_overflow{0};
        uint64_t m_lastN[kSlots] = {};
        uint64_t m_lastCycles[kSlots] = {};
        uint64_t m_lastNs[kSlots] = {};
    };

    // One line per row. `tag` is "[vu1-refuse]" (the runtime, per interval, with elapsed=) or
    // "[vu1-refuse-total]" (vu1_replay's end, elapsedMs < 0 leaves elapsed= out).
    inline std::string formatRow(const char *tag, const Row &r, double elapsedMs)
    {
        char cmd[16];
        if (hasCommand(r.reason))
            std::snprintf(cmd, sizeof(cmd), "0x%x", r.command);
        else
            std::snprintf(cmd, sizeof(cmd), "-");
        char elapsed[32] = "";
        if (elapsedMs >= 0.0)
            std::snprintf(elapsed, sizeof(elapsed), " elapsed=%.0fms", elapsedMs);
        char buf[256];
        std::snprintf(buf, sizeof(buf), "%s%s entry=0x%x reason=%s cmd=%s n=%llu cycles=%llu host_us=%llu", tag,
                      elapsed, r.entryPc, name(r.reason), cmd, static_cast<unsigned long long>(r.n),
                      static_cast<unsigned long long>(r.cycles), static_cast<unsigned long long>(r.hostNs / 1000u));
        return std::string(buf);
    }

    // The refusals a full table could not key: cumulative, so a reader takes the last (largest) value it sees.
    inline std::string formatOverflow(const char *tag, uint64_t lost)
    {
        char buf[128];
        std::snprintf(buf, sizeof(buf), "%s overflow=%llu (keys past %u slots not counted)", tag,
                      static_cast<unsigned long long>(lost), kSlots);
        return std::string(buf);
    }

    // ---- the process's instrument ----------------------------------------------------------------------------

    // The knob, read once (on the first refusal site or run() that asks, so after the process set developer
    // mode). -1 = not read yet. setEnabledForTest overrides it (ps2x_tests).
    inline std::atomic<int> &enabledState()
    {
        static std::atomic<int> s_state{-1};
        return s_state;
    }

    inline bool enabled()
    {
        int state = enabledState().load(std::memory_order_relaxed);
        if (__builtin_expect(state < 0, 0))
        {
            state = ps2x::knobs::flagValue(ps2x::knobOrDefault("PS2X_VU1_NATIVE_REFUSALS"), false) ? 1 : 0;
            enabledState().store(state, std::memory_order_relaxed);
        }
        return state != 0;
    }

    inline void setEnabledForTest(bool on) { enabledState().store(on ? 1 : 0, std::memory_order_relaxed); }

    // The process's one table (C++17 inline: one instance across translation units).
    inline Table &live()
    {
        static Table s_table;
        return s_table;
    }

    // The slot the last note() on this thread took, until run() takes it at the native hand-back.
    inline int &lastNotedSlot()
    {
        static thread_local int t_slot = -1;
        return t_slot;
    }

    // The slot a program that a budget stop left pending keeps accruing to, across its run() slices.
    inline int &programSlot()
    {
        static thread_local int t_slot = -1;
        return t_slot;
    }

    // A refusal site: count it under (entry, reason, command) and remember the slot for run().
    inline int note(uint32_t entryPc, Reason reason, uint32_t command = 0u)
    {
        const int slot = live().note(entryPc, reason, command);
        lastNotedSlot() = slot;
        return slot;
    }

    // ---- the whole-program refusal, for PS2X_VU1_DUMP_REFUSED (runtime/vu1_dump_refused.h) ----------------------
    // A whole-program refusal site (pc left at the entry, nothing touched) remembers (entry, reason, command) here
    // whether or not the count above is on, but only while a listener asked for it: with nobody listening the site
    // pays one relaxed load on its already-cold path. run() takes it after the hand-back.
    struct WholeRefusal
    {
        uint32_t entryPc = 0u;
        Reason reason = Reason::None;
        uint32_t command = 0u;
    };

    inline std::atomic<bool> &wholeListening()
    {
        static std::atomic<bool> s_on{false};
        return s_on;
    }

    inline WholeRefusal &lastWhole()
    {
        static thread_local WholeRefusal t_last;
        return t_last;
    }

    inline void rememberWhole(uint32_t entryPc, const Refusal &refusal)
    {
        if (wholeListening().load(std::memory_order_relaxed))
            lastWhole() = WholeRefusal{entryPc, refusal.reason, refusal.command};
    }

    // The last whole-program refusal on this thread (reason None when there was none), forgotten as it is taken.
    inline WholeRefusal takeWhole()
    {
        const WholeRefusal last = lastWhole();
        lastWhole() = WholeRefusal{};
        return last;
    }

    // run(), after a native program handed back: the slot its refusal site noted (and forget it), or -1.
    inline int takeNoted()
    {
        const int slot = lastNotedSlot();
        lastNotedSlot() = -1;
        return slot;
    }

    // run()'s end: the fallback's cycles and host time go to the refusal's slot; a program still pending keeps
    // the slot for its next slice.
    inline void addCost(int slot, uint64_t cycles, uint64_t hostNs, bool programPending)
    {
        live().addCost(slot, cycles, hostNs);
        programSlot() = programPending ? slot : -1;
    }

    inline std::mutex &printMutex()
    {
        static std::mutex s_mutex;
        return s_mutex;
    }

    // Once a second: the interval's rows to stderr. Called from run()'s end with the knob on.
    inline void maybePrint(std::chrono::steady_clock::time_point now)
    {
        static std::chrono::steady_clock::time_point s_last{};
        std::unique_lock<std::mutex> lock(printMutex(), std::try_to_lock);
        if (!lock.owns_lock())
            return;
        if (s_last.time_since_epoch().count() == 0)
        {
            s_last = now;
            return;
        }
        if (now - s_last < std::chrono::seconds(1))
            return;
        const double elapsedMs = std::chrono::duration<double, std::milli>(now - s_last).count();
        s_last = now;
        for (const Row &r : live().take())
            std::fprintf(stderr, "%s\n", formatRow("[vu1-refuse]", r, elapsedMs).c_str());
        if (const uint64_t lost = live().overflow())
            std::fprintf(stderr, "%s\n", formatOverflow("[vu1-refuse]", lost).c_str());
    }

    // vu1_replay's end: the running totals, one line per key, then the overflow line when anything was lost.
    inline std::vector<std::string> formatTotals(const Table &table)
    {
        std::vector<std::string> lines;
        for (const Row &r : table.totals())
            lines.push_back(formatRow("[vu1-refuse-total]", r, -1.0));
        if (const uint64_t lost = table.overflow())
            lines.push_back(formatOverflow("[vu1-refuse-total]", lost));
        return lines;
    }

    inline void printTotals(FILE *out)
    {
        std::lock_guard<std::mutex> lock(printMutex());
        for (const std::string &line : formatTotals(live()))
            std::fprintf(out, "%s\n", line.c_str());
    }
}
