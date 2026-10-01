#pragma once

// Audit 2026-09-17 section 2.2 F7: the VU1 native-program registry (src/lib/vu/native) is keyed by
// the FNV-1a hash of one disc's 16 KB microcode image, so any other revision of the disc matched
// nothing and silently fell back to the interpreter -- a much lower frame rate with nothing on
// screen, in a log, or anywhere else to say why. This prints one line that names the hash it saw
// and the disc the table was built from.
//
// The line is held back until a full second of uninterrupted misses has passed: a boot uploads
// plenty of microprograms that have no native counterpart by design (the menus, the loaders) long
// before the gameplay microcode arrives, and a match anywhere in the window means the table is fine
// and rearms it. One second of nothing but misses is gameplay running on the interpreter.

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <string>

namespace Vu1NativeWarning
{
    // One second of uninterrupted misses before the warning is allowed out.
    constexpr uint64_t kWindowNs = 1000000000ull;

    class State
    {
    public:
        // Call once per native-program lookup with whether it matched and a steady clock reading in
        // nanoseconds. Returns true exactly once: on the first lookup that closes a full window of
        // misses, and never again once warned() has been called. A match (matched == true) throws
        // the window away, so the next miss starts a new one.
        bool shouldWarn(bool matched, uint64_t nowNs)
        {
            if (matched)
            {
                m_armed = false;
                return false;
            }
            if (m_warned)
                return false;
            if (!m_armed)
            {
                m_armed = true;
                m_missStartNs = nowNs;
                return false;
            }
            // A clock that went backwards (it should not, this is a steady clock) restarts the
            // window rather than reporting an enormous one.
            if (nowNs < m_missStartNs)
            {
                m_missStartNs = nowNs;
                return false;
            }
            return nowNs - m_missStartNs > kWindowNs;
        }

        // The caller says it has printed the line; nothing is printed after this.
        void warned() { m_warned = true; }

        bool warnedAlready() const { return m_warned; }

    private:
        bool m_warned = false;
        bool m_armed = false;
        uint64_t m_missStartNs = 0ull;
    };

    // Whether any entry of a native table (entries with .hash and .fn) carries this image hash: the
    // supported disc's image has entries at some pcs and, by design, none at others (entry 0 is left
    // to generated code), so the foreign-disc question is asked of the hash, never of a (hash, pc).
    template <class Entry>
    inline bool hashHasNativeEntry(const Entry *table, uint32_t count, uint64_t hash)
    {
        for (uint32_t i = 0; i < count; ++i)
            if (table[i].hash == hash && table[i].fn)
                return true;
        return false;
    }

    // The warning itself: the hash of the image that matched nothing, the entry pc it was entered
    // at, and the disc the table in vu1_native_programs.cpp was built from.
    inline std::string line(uint64_t hash, uint32_t entryPc)
    {
        char buffer[192];
        std::snprintf(buffer, sizeof(buffer),
                      "[vu1] no native program for code hash 0x%016llx entry 0x%04x"
                      " -- running the interpreter (supported disc: SOCOM II NTSC r0001, SCUS_972.75)",
                      static_cast<unsigned long long>(hash), static_cast<unsigned>(entryPc));
        return std::string(buffer);
    }

    // ---- the process's instance (VU1Interpreter::run), and its test seams -----------------------------------
    // Sprint 17 F b1 (docs/research/83 section 3.2): run() reads the clock only for a lookup whose hash matched
    // nothing -- shouldWarn(true, ...) never reads its nowNs -- so the supported disc pays no clock read per program.

    // The one window the runtime keeps (VU1 runs on one thread). ps2x_tests resets it (live() = State{}).
    inline State &live()
    {
        static State s_state;
        return s_state;
    }

    // Every clock read the warning takes, counted (ps2x_tests: none on a matched run, one on an unmatched one).
    inline std::atomic<uint64_t> &clockReads()
    {
        static std::atomic<uint64_t> s_reads{0};
        return s_reads;
    }

    // ps2x_tests: a clock in nanoseconds in place of steady_clock (nullptr = steady_clock), for the cadence.
    using ClockFn = uint64_t (*)();
    inline ClockFn &clockForTest()
    {
        static ClockFn s_clock = nullptr;
        return s_clock;
    }

    // The warning's clock: steady_clock in nanoseconds (or the test's), counted.
    inline uint64_t nowNs()
    {
        clockReads().fetch_add(1u, std::memory_order_relaxed);
        if (const ClockFn clock = clockForTest())
            return clock();
        return static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch())
                .count());
    }

    // The lines printed so far and the last one (ps2x_tests reads them; printed at most once per window state).
    inline uint64_t &printedCount()
    {
        static uint64_t s_count = 0u;
        return s_count;
    }
    inline std::string &lastPrinted()
    {
        static std::string s_line;
        return s_line;
    }

    // Prints the line for (hash, entry pc) to stderr and remembers it. Unsynchronized on purpose: VU1 runs on one
    // thread, and the worst a second one could do is print the same line twice.
    inline void print(uint64_t hash, uint32_t entryPc)
    {
        lastPrinted() = line(hash, entryPc);
        ++printedCount();
        std::fprintf(stderr, "%s\n", lastPrinted().c_str());
        std::fflush(stderr);
    }
}
