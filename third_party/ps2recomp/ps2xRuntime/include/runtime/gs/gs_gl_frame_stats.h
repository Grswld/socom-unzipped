#pragma once
// macOS performance work, step 1: frame-time percentiles and the frame-drop breakdown.
//
// PS2X_GS_SLOW_FRAME_MS=<ms> reports every present interval past <ms> with what the render thread did in it
// (draws, batch ends by reason, uploads, palettes, texture decodes, readbacks, programs and first-use pipeline
// states) beside the frame before it. PS2X_GS_FLUSH_REASONS adds the per-second [gs-flush] line. Either one
// keeps frame-time percentiles per second and for the session, printed at exit.
//
// The render thread never formats or prints any of it: it fills fixed-size records and offers them to a
// single-producer ring that drops (and counts) when full, never waits; a logger thread drains, formats and
// writes (gs_gl_frame_stats.cpp). Header-only below the Logger: ps2x_tests drives it directly.
#include "runtime/gs/gs_gl_flush_reasons.h"

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>

namespace GsGlFrameStats
{
    // Present intervals in 0.25 ms bins to 250 ms, then one open bin; the longest is kept exactly.
    struct FrameTimeHistogram
    {
        static constexpr double kBinMs = 0.25;
        static constexpr int kBins = 1000;   // [0, 250) ms
        uint32_t bins[kBins + 1] = {};
        uint64_t n = 0u;
        double longest = 0.0;

        void add(double ms)
        {
            const int b = ms < 0.0 ? 0 : std::min(kBins, static_cast<int>(ms / kBinMs));
            ++bins[b];
            ++n;
            longest = std::max(longest, ms);
        }
        void merge(const FrameTimeHistogram &o)
        {
            for (int i = 0; i <= kBins; ++i)
                bins[i] += o.bins[i];
            n += o.n;
            longest = std::max(longest, o.longest);
        }
        uint64_t count() const { return n; }
        double maxMs() const { return longest; }
        static constexpr double overflowMs() { return kBins * kBinMs; }
        // The upper edge of the bin holding the q-quantile frame (the longest, for the open bin). 0 when empty.
        double percentile(double q) const
        {
            if (n == 0u)
                return 0.0;
            uint64_t rank = static_cast<uint64_t>(q * static_cast<double>(n) + 0.999999);
            rank = std::max<uint64_t>(1u, std::min<uint64_t>(rank, n));
            uint64_t seen = 0u;
            for (int i = 0; i < kBins; ++i)
            {
                seen += bins[i];
                if (seen >= rank)
                    return (i + 1) * kBinMs;
            }
            return longest;
        }
        void reset() { *this = FrameTimeHistogram{}; }
    };

    // What the render thread did between two presents.
    struct FrameCounts
    {
        uint32_t draws = 0u, vertices = 0u;
        uint32_t byField[GsGlFlushReasons::kFields] = {};
        uint32_t byCmd[GsGlFlushReasons::kCmds] = {};
        uint32_t uploads = 0u;
        uint64_t uploadBytes = 0u;
        uint32_t clutLoads = 0u;
        uint32_t texNew = 0u, texRedecoded = 0u, rtFeedback = 0u;
        uint32_t readbacks = 0u;
        uint64_t readbackPixels = 0u;
        uint32_t programsCreated = 0u, pipelineFirstUse = 0u;
        double busyMs = 0.0;   // inside executeCommands; the rest of the interval the render thread waited
    };

    struct FrameRecord
    {
        uint64_t frameIndex = 0u;
        double frameMs = 0.0;
        FrameCounts now{}, before{};
    };

    // Ends each present interval; a slow one yields a record with the frame before it for contrast.
    class SlowFrameDetector
    {
    public:
        explicit SlowFrameDetector(double thresholdMs) : m_threshold(thresholdMs) {}
        bool endFrame(double frameMs, const FrameCounts &counts, FrameRecord &out)
        {
            ++m_index;
            const bool slow = m_threshold > 0.0 && frameMs > m_threshold;
            if (slow)
            {
                out.frameIndex = m_index;
                out.frameMs = frameMs;
                out.now = counts;
                out.before = m_previous;
            }
            m_previous = counts;
            return slow;
        }
        double threshold() const { return m_threshold; }

    private:
        double m_threshold;
        uint64_t m_index = 0u;
        FrameCounts m_previous{};
    };

    // Single producer, single consumer, fixed capacity. tryPush never waits: a full ring drops and counts.
    template <typename T, size_t N>
    class Ring
    {
    public:
        bool tryPush(const T &v)
        {
            const size_t head = m_head.load(std::memory_order_relaxed);
            if (head - m_tail.load(std::memory_order_acquire) >= N)
            {
                m_dropped.fetch_add(1u, std::memory_order_relaxed);
                return false;
            }
            m_slots[head % N] = v;
            m_head.store(head + 1u, std::memory_order_release);
            return true;
        }
        bool tryPop(T &out)
        {
            const size_t tail = m_tail.load(std::memory_order_relaxed);
            if (tail == m_head.load(std::memory_order_acquire))
                return false;
            out = m_slots[tail % N];
            m_tail.store(tail + 1u, std::memory_order_release);
            return true;
        }
        uint64_t dropped() const { return m_dropped.load(std::memory_order_relaxed); }

    private:
        T m_slots[N]{};
        std::atomic<size_t> m_head{0u}, m_tail{0u};
        std::atomic<uint64_t> m_dropped{0u};
    };

    // One second of batches and frames, as the [gs-flush] / [gs-frame] lines print it; the histogram rides
    // along so the logger can keep the session's percentiles exactly.
    struct IntervalRecord
    {
        double seconds = 0.0;
        uint64_t batches = 0u, vertices = 0u, alphaBatches = 0u, rtFeedback = 0u;
        uint64_t byField[GsGlFlushReasons::kFields] = {}, vertsByField[GsGlFlushReasons::kFields] = {};
        uint64_t byCmd[GsGlFlushReasons::kCmds] = {}, vertsByCmd[GsGlFlushReasons::kCmds] = {};
        GsGlFlushReasons::MaskCount top[8] = {};
        uint32_t topCount = 0u;
        uint64_t pipelinesSession = 0u, pipelinesNew = 0u, programsCreated = 0u;
        FrameTimeHistogram frames{};
        bool flushLine = false;   // PS2X_GS_FLUSH_REASONS: print [gs-flush] too, not only [gs-frame]
    };

    // The logger thread (gs_gl_frame_stats.cpp). Started on first use and never destroyed, so a render thread
    // still offering records at process exit writes into live memory.
    namespace Logger
    {
        bool offerSlowFrame(const FrameRecord &r);     // false: the ring was full and the record was dropped
        bool offerInterval(const IntervalRecord &r);
        // Stop the thread, drain what is queued and print the session summary. The runner calls it before its
        // std::_Exit (which runs no atexit handler); an atexit hook calls it too for any other exit. True only
        // for the call that printed: false when already done, or when the logger never started (knobs off).
        bool shutdown();
    }
}
