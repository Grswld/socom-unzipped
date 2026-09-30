#pragma once

// Sprint 17 F3: the [gs-loop] line -- the frame hand-off between the GL (main) thread and the EE (game) thread,
// accounted in milliseconds per second.
//
// [gs-gl stats] times the replayed commands and [gs-submit] splits the draws inside them; neither says where the
// rest of the GL thread's second goes, nor how long the game thread waits at a frame boundary. The two
// profiles of the mission walk (logs/parity/prof/gl1, ee1) say both threads wait a large share of their samples,
// the GL thread in EndDrawing and the game thread in one condition-variable wait, and cannot say on what. This
// line splits both seconds, once per stats interval, under PS2X_GS_STATS (no clock is read without it):
//
//   GL thread, one host-loop iteration (ps2_runtime.cpp), five disjoint phases:
//     latch=   GS::latchHostPresentationFrame: GS::m_stateMutex (latch_lock=, a part of latch=, is the wait to
//              take it -- the game thread holds it across a whole GIF packet), the request, Present's record
//     queue=   GSGlBackend::HostRenderFrame's command-buffer swap under m_queueMutex, and its notify
//     replay=  HostRenderFrame's executeCommands (the whole [gs-gl stats] ms: column), framesReplayed, GL restore
//     draw=    BeginDrawing up to EndDrawing: the window blit, the overlays, the screenshot push
//     end=     EndDrawing: raylib's buffer swap, its SetTargetFPS(60) sleep, the input poll
//     other=   the interval's second less the five (the loop's own glue, and anything this line does not see)
//   iters= host-loop iterations a second; capped= those whose work before EndDrawing was under one 60 Hz frame
//   (16.67 ms), so raylib's frame limiter slept the rest inside end=.
//
//   EE thread, its four waits:
//     bp=      GSGlBackend::GuestFrameBoundary: GsFrameBackpressure::frameRecorded at each VBlankStart (the
//              replay more than PS2X_GS_MAX_PENDING_FRAMES guest frames behind)
//     token=   GSGlBackend::waitForToken off the render thread: a Reset, a blocking Readback, a dumped Present
//     idle=    EeScheduler::waitForEvent: no guest thread ready (sceGsSyncV, a semaphore) until the next event;
//              idles= counts them
//     pace=    EeScheduler::processDueDeadlines: a cycle-due deadline sleeping to its host time
//     work=    the interval's second less the four: the game thread running (guest code, VU1, the GS front end),
//              and any lock it waits on that no column stamps (GSGlBackend::record's m_queueMutex, m_stateMutex)
//
// Header-only, no GL and no runtime includes, so ps2x_tests checks the arithmetic directly (the
// GsGlUploadTrace::Accum and GsFrameHistogram pattern). The live accumulator is atomic: the GL-thread phases are
// added on the GL thread, the EE waits on the game thread, and the stats printer (GL thread) takes both.

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <string>

namespace GsLoopPhases
{
    enum Phase : int
    {
        Latch = 0,
        Queue,
        Replay,
        Draw,
        End,
        LatchLock, // inside Latch: not one of the five disjoint GL phases
        EeBackpressure,
        EeToken,
        EeIdle,
        EePace,
        kPhaseCount
    };

    // raylib's SetTargetFPS(60) target, the limiter end= sleeps to.
    constexpr uint64_t kHostFrameNs = 1'000'000'000ull / 60ull;

    struct Accum
    {
        uint64_t ns[kPhaseCount] = {};
        uint64_t counts[kPhaseCount] = {};
        uint64_t iterations = 0; // host-loop iterations
        uint64_t capped = 0;     // ... whose work before EndDrawing was under kHostFrameNs
    };

    inline void add(Accum &a, Phase phase, uint64_t ns)
    {
        a.ns[phase] += ns;
        ++a.counts[phase];
    }

    // One host-loop iteration: `beforeEndNs` is its time from the loop's top to EndDrawing's call.
    inline void noteIteration(Accum &a, uint64_t beforeEndNs)
    {
        ++a.iterations;
        if (beforeEndNs < kHostFrameNs)
            ++a.capped;
    }

    // The five disjoint GL phases (latch_lock is inside latch).
    inline uint64_t glAccountedNs(const Accum &a)
    {
        return a.ns[Latch] + a.ns[Queue] + a.ns[Replay] + a.ns[Draw] + a.ns[End];
    }

    inline uint64_t eeWaitNs(const Accum &a)
    {
        return a.ns[EeBackpressure] + a.ns[EeToken] + a.ns[EeIdle] + a.ns[EePace];
    }

    // One line; phases in ms per second of the interval, counts per second. other= and work= are signed: a phase
    // straddling the interval's edge lands in the next one, so a remainder near zero may read a little negative.
    inline std::string format(const Accum &a, double elapsedMs)
    {
        const double perSec = elapsedMs > 0.0 ? 1000.0 / elapsedMs : 0.0;
        auto ms = [&](uint64_t ns) { return static_cast<double>(ns) / 1.0e6 * perSec; };
        const double second = elapsedMs > 0.0 ? 1000.0 : 0.0;
        char buf[512];
        std::snprintf(buf, sizeof(buf),
                      "[gs-loop] elapsed=%.0fms iters=%.1f/s capped=%.1f/s"
                      " gl: latch=%.1f latch_lock=%.1f queue=%.1f replay=%.1f draw=%.1f end=%.1f other=%.1f ms/s"
                      " ee: bp=%.1f token=%.1f idle=%.1f pace=%.1f work=%.1f ms/s idles=%.1f/s",
                      elapsedMs, static_cast<double>(a.iterations) * perSec, static_cast<double>(a.capped) * perSec,
                      ms(a.ns[Latch]), ms(a.ns[LatchLock]), ms(a.ns[Queue]), ms(a.ns[Replay]), ms(a.ns[Draw]),
                      ms(a.ns[End]), second - ms(glAccountedNs(a)),
                      ms(a.ns[EeBackpressure]), ms(a.ns[EeToken]), ms(a.ns[EeIdle]), ms(a.ns[EePace]),
                      second - ms(eeWaitNs(a)), static_cast<double>(a.counts[EeIdle]) * perSec);
        return std::string(buf);
    }

    // The live accumulator both threads add into; take() hands the interval to the printer and starts the next.
    class Live
    {
    public:
        void add(Phase phase, uint64_t ns)
        {
            m_ns[phase].fetch_add(ns, std::memory_order_relaxed);
            m_counts[phase].fetch_add(1u, std::memory_order_relaxed);
        }

        void noteIteration(uint64_t beforeEndNs)
        {
            m_iterations.fetch_add(1u, std::memory_order_relaxed);
            if (beforeEndNs < kHostFrameNs)
                m_capped.fetch_add(1u, std::memory_order_relaxed);
        }

        Accum take()
        {
            Accum a{};
            for (int p = 0; p < kPhaseCount; ++p)
            {
                a.ns[p] = m_ns[p].exchange(0u, std::memory_order_relaxed);
                a.counts[p] = m_counts[p].exchange(0u, std::memory_order_relaxed);
            }
            a.iterations = m_iterations.exchange(0u, std::memory_order_relaxed);
            a.capped = m_capped.exchange(0u, std::memory_order_relaxed);
            return a;
        }

    private:
        std::atomic<uint64_t> m_ns[kPhaseCount] = {};
        std::atomic<uint64_t> m_counts[kPhaseCount] = {};
        std::atomic<uint64_t> m_iterations{0};
        std::atomic<uint64_t> m_capped{0};
    };

    // The process's one live accumulator (C++17 inline: one instance across translation units).
    inline Live &live()
    {
        static Live s_live;
        return s_live;
    }

    // Nanoseconds between two steady_clock readings, as the stamps take them.
    template <typename TimePoint>
    inline uint64_t nsBetween(TimePoint from, TimePoint to)
    {
        const auto d = to - from;
        const long long n = static_cast<long long>(std::chrono::duration_cast<std::chrono::nanoseconds>(d).count());
        return n > 0 ? static_cast<uint64_t>(n) : 0u;
    }
}
