// macOS performance work, step 1: the logger thread behind PS2X_GS_FLUSH_REASONS / PS2X_GS_SLOW_FRAME_MS
// (runtime/gs/gs_gl_frame_stats.h). The render thread only offers fixed-size records to two rings that never
// block it; this thread drains them every 50 ms, formats, and writes each line with one fputs (stdio locks per
// call, so a line never interleaves with the game's own output). At exit it drains, then prints the session.
#include "runtime/gs/gs_gl_frame_stats.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace GsGlFrameStats
{
namespace
{
    using namespace GsGlFlushReasons;

    struct Session
    {
        double seconds = 0.0;
        uint64_t batches = 0u, vertices = 0u, alphaBatches = 0u, rtFeedback = 0u, slowFrames = 0u;
        uint64_t byField[kFields] = {}, vertsByField[kFields] = {};
        uint64_t byCmd[kCmds] = {}, vertsByCmd[kCmds] = {};
        uint64_t pipelines = 0u, programs = 0u;
        FrameTimeHistogram frames{};
    };

    struct State
    {
        Ring<FrameRecord, 256> slow;
        Ring<IntervalRecord, 16> intervals;
        std::atomic<bool> stop{false};
        std::thread thread;
        Session session;          // the logger thread's alone until atExit has joined it
        IntervalRecord scratch;   // too big for the logger thread's stack frame to want twice
        FrameRecord slowScratch;
    };

    State *g_state = nullptr;
    std::once_flag g_once;

    void emit(const std::string &line) { std::fputs(line.c_str(), stdout); }

    std::string fmt(const char *f, double v)
    {
        char b[32];
        std::snprintf(b, sizeof b, f, v);
        return b;
    }
    std::string perBatch(uint64_t verts, uint64_t batches)
    {
        return batches ? fmt("%.1f", static_cast<double>(verts) / static_cast<double>(batches)) : std::string("-");
    }
    std::string maskLabel(uint32_t mask)
    {
        std::string s;
        for (int i = 0; i < kFields; ++i)
            if (mask & (1u << i))
                s += (s.empty() ? "" : "+") + std::string(kFieldLabels[i]);
        return s.empty() ? std::string("none") : s;
    }

    // "label=count(verts/batch) ..." for the non-zero entries, most first.
    template <int N>
    std::string ranked(const uint64_t (&count)[N], const uint64_t (&verts)[N], const char *const (&labels)[N],
                       double perSecond)
    {
        std::vector<int> idx;
        for (int i = 0; i < N; ++i)
            if (count[i])
                idx.push_back(i);
        std::sort(idx.begin(), idx.end(), [&](int a, int b) { return count[a] > count[b]; });
        std::string s;
        for (int i : idx)
            s += std::string(" ") + labels[i] + "=" +
                 std::to_string(static_cast<uint64_t>(static_cast<double>(count[i]) * perSecond)) + "(" +
                 perBatch(verts[i], count[i]) + ")";
        return s.empty() ? std::string(" -") : s;
    }
    template <int N>
    std::string ranked32(const uint32_t (&count)[N], const char *const (&labels)[N])
    {
        uint64_t c[N];
        for (int i = 0; i < N; ++i)
            c[i] = count[i];
        std::string s;
        std::vector<int> idx;
        for (int i = 0; i < N; ++i)
            if (c[i])
                idx.push_back(i);
        std::sort(idx.begin(), idx.end(), [&](int a, int b) { return c[a] > c[b]; });
        for (size_t k = 0; k < idx.size() && k < 6; ++k)
            s += std::string(" ") + labels[idx[k]] + "=" + std::to_string(c[idx[k]]);
        return s.empty() ? std::string(" -") : s;
    }

    std::string countsLine(const FrameCounts &c)
    {
        return "uploads=" + std::to_string(c.uploads) + " (" + std::to_string(c.uploadBytes / 1024u) +
               " KB) clut_loads=" + std::to_string(c.clutLoads) + " tex_new=" + std::to_string(c.texNew) +
               " redecoded=" + std::to_string(c.texRedecoded) + " rt_feedback=" + std::to_string(c.rtFeedback) +
               " readbacks=" + std::to_string(c.readbacks) + " (" + std::to_string(c.readbackPixels / 1000u) +
               "k px) programs=" + std::to_string(c.programsCreated) +
               " pipelines_new=" + std::to_string(c.pipelineFirstUse);
    }

    void writeSlow(Session &s, const FrameRecord &r)
    {
        ++s.slowFrames;
        const FrameCounts &n = r.now, &p = r.before;
        emit("[gs-slow-frame] #" + std::to_string(r.frameIndex) + " ms=" + fmt("%.1f", r.frameMs) +
             " busy=" + fmt("%.1f", n.busyMs) + " wait=" + fmt("%.1f", r.frameMs - n.busyMs) +
             " | draws=" + std::to_string(n.draws) + " (prev " + std::to_string(p.draws) + ") verts=" +
             std::to_string(n.vertices) + " (prev " + std::to_string(p.vertices) + ") | key:" +
             ranked32(n.byField, kFieldLabels) + " | cmd:" + ranked32(n.byCmd, kCmdLabels) + " | " +
             countsLine(n) + " | prev: " + countsLine(p) + "\n");
    }

    void writeInterval(Session &s, const IntervalRecord &r)
    {
        s.seconds += r.seconds;
        s.batches += r.batches;
        s.vertices += r.vertices;
        s.alphaBatches += r.alphaBatches;
        s.rtFeedback += r.rtFeedback;
        for (int i = 0; i < kFields; ++i)
        {
            s.byField[i] += r.byField[i];
            s.vertsByField[i] += r.vertsByField[i];
        }
        for (int i = 0; i < kCmds; ++i)
        {
            s.byCmd[i] += r.byCmd[i];
            s.vertsByCmd[i] += r.vertsByCmd[i];
        }
        s.pipelines = r.pipelinesSession;
        s.programs += r.programsCreated;
        s.frames.merge(r.frames);

        const double perSec = r.seconds > 0.0 ? 1.0 / r.seconds : 0.0;
        if (r.flushLine)
        {
            std::string top;
            for (uint32_t i = 0; i < r.topCount; ++i)
                top += " " + maskLabel(r.top[i].mask) + "=" +
                       std::to_string(static_cast<uint64_t>(static_cast<double>(r.top[i].batches) * perSec)) + "(" +
                       perBatch(r.top[i].vertices, r.top[i].batches) + ")";
            emit("[gs-flush] batches=" + std::to_string(static_cast<uint64_t>(static_cast<double>(r.batches) * perSec)) +
                 "/s verts/batch=" + perBatch(r.vertices, r.batches) + " | key:" +
                 ranked(r.byField, r.vertsByField, kFieldLabels, perSec) + " | cmd:" +
                 ranked(r.byCmd, r.vertsByCmd, kCmdLabels, perSec) + " | alpha=" +
                 std::to_string(static_cast<uint64_t>(static_cast<double>(r.alphaBatches) * perSec)) +
                 " rt_feedback=" + std::to_string(static_cast<uint64_t>(static_cast<double>(r.rtFeedback) * perSec)) +
                 " | top:" + (top.empty() ? std::string(" -") : top) + " | pipelines=" +
                 std::to_string(r.pipelinesSession) + " (+" + std::to_string(r.pipelinesNew) + ") programs=" +
                 std::to_string(r.programsCreated) + "\n");
        }
        const FrameTimeHistogram &h = r.frames;
        emit("[gs-frame] n=" + std::to_string(h.count()) + " p50=" + fmt("%.2f", h.percentile(0.50)) +
             " p95=" + fmt("%.2f", h.percentile(0.95)) + " p99=" + fmt("%.2f", h.percentile(0.99)) +
             " max=" + fmt("%.1f", h.maxMs()) + "\n");
    }

    void drain(State &st)
    {
        while (st.intervals.tryPop(st.scratch))
            writeInterval(st.session, st.scratch);
        while (st.slow.tryPop(st.slowScratch))
            writeSlow(st.session, st.slowScratch);
        std::fflush(stdout);
    }

    void run(State *st)
    {
        while (!st->stop.load(std::memory_order_acquire))
        {
            drain(*st);
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
    }

    void atExit()
    {
        State &st = *g_state;
        st.stop.store(true, std::memory_order_release);
        if (st.thread.joinable())
            st.thread.join();
        drain(st);
        const Session &s = st.session;
        const double perSec = s.seconds > 0.0 ? 1.0 / s.seconds : 0.0;
        const FrameTimeHistogram &h = s.frames;
        emit("[gs-summary] seconds=" + fmt("%.0f", s.seconds) + " frames=" + std::to_string(h.count()) +
             " p50=" + fmt("%.2f", h.percentile(0.50)) + " p95=" + fmt("%.2f", h.percentile(0.95)) +
             " p99=" + fmt("%.2f", h.percentile(0.99)) + " max=" + fmt("%.1f", h.maxMs()) + " | batches=" +
             std::to_string(static_cast<uint64_t>(static_cast<double>(s.batches) * perSec)) + "/s verts/batch=" +
             perBatch(s.vertices, s.batches) + " | key:" + ranked(s.byField, s.vertsByField, kFieldLabels, perSec) +
             " | cmd:" + ranked(s.byCmd, s.vertsByCmd, kCmdLabels, perSec) + " | alpha=" +
             std::to_string(static_cast<uint64_t>(static_cast<double>(s.alphaBatches) * perSec)) + "/s rt_feedback=" +
             std::to_string(static_cast<uint64_t>(static_cast<double>(s.rtFeedback) * perSec)) +
             "/s | pipelines_session=" + std::to_string(s.pipelines) + " programs=" + std::to_string(s.programs) +
             " slow_frames=" + std::to_string(s.slowFrames) + " | dropped: intervals=" +
             std::to_string(st.intervals.dropped()) + " slow=" + std::to_string(st.slow.dropped()) +
             " (the last partial second is not included)\n");
        std::fflush(stdout);
    }

    State &state()
    {
        std::call_once(g_once, [] {
            g_state = new State();   // never deleted: a late offer at exit must write into live memory
            g_state->thread = std::thread(run, g_state);
            std::atexit(atExit);
        });
        return *g_state;
    }
}

namespace Logger
{
    bool offerSlowFrame(const FrameRecord &r) { return state().slow.tryPush(r); }
    bool offerInterval(const IntervalRecord &r) { return state().intervals.tryPush(r); }
}
}
