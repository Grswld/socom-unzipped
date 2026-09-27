#include "MiniTest.h"
#include "runtime/gs/gs_frame_backpressure.h"
#include "runtime/gs/gs_stall_coalescer.h"
#include "runtime/gs/gs_gl_backend.h"
#include "runtime/socom2_freeze_fields.h"
#include "runtime/gs/gs_frontend.h"
#include "runtime/gs/gs_cpu_backend.h"
#include "runtime/ee_scheduler.h"
#include "ps2_runtime.h"
#include "ps2_stubs.h"
#include "ps2_syscalls.h"
#include "Stubs/Helpers/Support.h"
#include "Stubs/GS.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <atomic>
#include <chrono>
#include <memory>
#include <random>
#include <string>
#include <thread>
#include <vector>

namespace
{
    using bp_clock = std::chrono::steady_clock;

    // A CPU backend whose recorder hook stalls once for 600 ms (a stand-in for GSGlBackend's
    // back-pressure wait, or for any other executor stall such as a level load when it reports no
    // wait), optionally followed on the next VBlank by a short reported wait, so the scheduler's R41
    // re-anchor can be observed.
    constexpr uint32_t kBpStallAt = 20u;
    constexpr size_t kBpWakes = 75u;
    constexpr uint32_t kBpVSyncLoopPc = 0x0011F200u;
    std::vector<bp_clock::time_point> g_bpWakes;
    std::vector<uint64_t> g_bpWakeTicks;
    std::vector<uint64_t> g_bpWakeIdleWaits;

    void bpSetRegU32(R5900Context &ctx, int reg, uint32_t value)
    {
        ctx.r[reg] = _mm_set_epi64x(0, static_cast<int64_t>(value));
    }

    class StallingFrameBackend final : public GSRasterBackend
    {
    public:
        StallingFrameBackend(bool stallReportsWait, bool followupWait)
            : m_stallReportsWait(stallReportsWait), m_followupWait(followupWait)
        {
        }
        uint32_t calls = 0u;
        bp_clock::time_point stallEnd{};
        void Initialize(uint8_t *vram, uint32_t vramSize) override { m_cpu.Initialize(vram, vramSize); }
        void Reset() override { m_cpu.Reset(); }
        void Submit(const GSPrimitiveBatch &batch) override { m_cpu.Submit(batch); }
        void BeginTransfer(const GSTransferCommand &command) override { m_cpu.BeginTransfer(command); }
        void UploadImage(const uint8_t *data, uint32_t sizeBytes) override { m_cpu.UploadImage(data, sizeBytes); }
        void Flush() override { m_cpu.Flush(); }
        void TextureFlush() override { m_cpu.TextureFlush(); }
        void Sync(GSSyncReason reason) override { m_cpu.Sync(reason); }
        PresentationFrame Present(const GSPresentationRequest &request) override { return m_cpu.Present(request); }
        bool ClearFramebuffer(const GSContext &context, uint32_t rgba) override { return m_cpu.ClearFramebuffer(context, rgba); }
        uint32_t ConsumeLocalToHostBytes(uint8_t *dst, uint32_t maxBytes) override { return m_cpu.ConsumeLocalToHostBytes(dst, maxBytes); }
        uint32_t ReadVram(uint32_t psm, uint32_t base, uint32_t bw, uint32_t x, uint32_t y) const override { return m_cpu.ReadVram(psm, base, bw, x, y); }
        void WriteVram(uint32_t psm, uint32_t base, uint32_t bw, uint32_t x, uint32_t y, uint32_t value) override { m_cpu.WriteVram(psm, base, bw, x, y, value); }
        void SnapshotVram(std::vector<uint8_t> &out) const override { m_cpu.SnapshotVram(out); }
        GSTransferSnapshot GetTransferSnapshot() const override { return m_cpu.GetTransferSnapshot(); }
        bool GuestFrameBoundary() override
        {
            ++calls;
            if (calls == kBpStallAt)
            {
                std::this_thread::sleep_for(std::chrono::milliseconds(600));
                stallEnd = bp_clock::now();
                return m_stallReportsWait;
            }
            if (calls == kBpStallAt + 1u && m_followupWait)
            {
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
                stallEnd = bp_clock::now();
                return true;
            }
            return false;
        }

    private:
        GSCpuBackend m_cpu;
        bool m_stallReportsWait;
        bool m_followupWait;
    };

    // Guest loop: note the host time of each return from sceGsSyncV, then wait for the next VBlank.
    void bpVSyncLoop(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        g_bpWakes.push_back(bp_clock::now());
        g_bpWakeTicks.push_back(runtime->eeScheduler().currentVSyncTick());
        g_bpWakeIdleWaits.push_back(runtime->eeScheduler().idleWaitCount());
        if (g_bpWakes.size() >= kBpWakes)
        {
            ctx->pc = 0u;
            runtime->requestStop();
            return;
        }
        ctx->pc = kBpVSyncLoopPc;
        ps2_stubs::sceGsSyncV(rdram, ctx, runtime);
    }

    // Runs the guest VBlank loop against a StallingFrameBackend and checks that after the stall
    // (and the optional reported wait) the guest wakes on every VBlank at real time.
    void runVBlankStallScenario(TestCase &t, bool stallReportsWait, bool followupWait)
    {
        PS2Runtime runtime;
        t.IsTrue(runtime.memory().initialize(), "runtime memory initialize should succeed");
        std::vector<uint8_t> rdram(PS2_RAM_SIZE, 0u);
        R5900Context resetCtx{};
        bpSetRegU32(resetCtx, 4, 0u);
        bpSetRegU32(resetCtx, 5, 1u);
        bpSetRegU32(resetCtx, 6, 2u);
        bpSetRegU32(resetCtx, 7, 1u);
        ps2_stubs::sceGsResetGraph(rdram.data(), &resetCtx, &runtime);
        auto backend = std::make_unique<StallingFrameBackend>(stallReportsWait, followupWait);
        StallingFrameBackend *stalling = backend.get();
        runtime.gs().setRasterBackend(std::move(backend));
        g_bpWakes.clear();
        g_bpWakeTicks.clear();
        g_bpWakeIdleWaits.clear();
        runtime.registerFunction(kBpVSyncLoopPc, bpVSyncLoop);
        R5900Context mainContext{};
        mainContext.pc = kBpVSyncLoopPc;
        runtime.eeScheduler().reset(rdram.data(), mainContext);
        runtime.eeScheduler().run();

        t.IsTrue(stalling->calls >= kBpStallAt + 20u, "the hook must run once per VBlank, calls=" + std::to_string(stalling->calls));
        t.Equals(g_bpWakes.size(), kBpWakes, "the guest loop ran to its end");
        if (g_bpWakes.size() != kBpWakes || stalling->stallEnd == bp_clock::time_point{})
            return;
        size_t first = 0;
        while (first < g_bpWakes.size() && g_bpWakes[first] < stalling->stallEnd)
            ++first;
        t.IsTrue(first > 0 && first + 21 <= g_bpWakes.size(), "enough wakes before and after the stall");
        if (first == 0 || first + 21 > g_bpWakes.size())
            return;
        // Every VBlank after the stall reaches the guest. A host hiccup in a loaded test run can
        // legitimately merge two VBlanks, so the loose bound is 2 per wake; right after the
        // re-anchor (R54, Minor 2) there must be exactly one: the re-anchored VBlank is a full
        // period away on both clocks, not already due.
        //
        // Sprint 8, the Linux port: a wake is only as prompt as the host's scheduler gives it, and on
        // a VM sharing its cores (or under ASan) a wake lands tens of ms late and then carries every
        // VBlank whose host period has already passed -- 3 to 6 of them, where an idle host sees 1.
        // The same binary passes on a quiet VM and on Windows, so the bound below is per wake and is
        // paid for in host time: one VBlank, plus one for each further period (with a quarter period
        // of grace) that the wake itself was late by. The defect these two lines guard -- the
        // re-anchored VBlank already due, delivered back to back with the next one -- costs no host
        // time at all and still fails here. Wake 0's lateness is measured from the end of the stall,
        // not from the wake before it: the stall itself is the excluded time the re-anchor drops.
        auto ticksAllowed = [&](size_t k)
        {
            const auto since = (k == first && g_bpWakes[k - 1] < stalling->stallEnd) ? stalling->stallEnd : g_bpWakes[k - 1];
            const double lateMs = std::chrono::duration<double, std::milli>(g_bpWakes[k] - since).count();
            return 1u + static_cast<uint64_t>(lateMs / (16.667 * 1.25));
        };
        uint64_t maxTicksPerWake = 0u;
        bool everyWakeWithinItsHostTime = true;
        for (size_t k = first; k < first + 20; ++k)
        {
            const uint64_t wakeTicks = g_bpWakeTicks[k + 1] - g_bpWakeTicks[k];
            maxTicksPerWake = std::max<uint64_t>(maxTicksPerWake, wakeTicks);
            if (wakeTicks > std::max<uint64_t>(2u, ticksAllowed(k + 1)))
                everyWakeWithinItsHostTime = false;
        }
        t.IsTrue(everyWakeWithinItsHostTime, "after the stall the guest must wake on every VBlank (no VBlank before its host period), saw up to " + std::to_string(maxTicksPerWake) + " VBlanks per wake");
        for (size_t k = first; k <= first + 1; ++k)
        {
            const uint64_t wakeTicks = g_bpWakeTicks[k] - g_bpWakeTicks[k - 1];
            const uint64_t allowed = ticksAllowed(k);
            t.IsTrue(wakeTicks <= allowed, "the wakes right after the re-anchor must each see one VBlank per host period (no immediate second VBlank), wake " + std::to_string(k - first) + " saw " + std::to_string(wakeTicks) + " in " + std::to_string(allowed) + " periods of host time");
        }

        // R54: an idle guest sleeps between VBlanks after a wait. When the host deadline was ahead of
        // the cycle deadline, waitForEvent returned at once and re-entered until the cycle clock caught
        // up (a spin of thousands of idle waits per frame); a sleeping guest needs a handful.
        uint64_t maxIdleWaitsPerWake = 0u;
        for (size_t k = first + 1; k < first + 20; ++k)
            maxIdleWaitsPerWake = std::max<uint64_t>(maxIdleWaitsPerWake, g_bpWakeIdleWaits[k + 1] - g_bpWakeIdleWaits[k]);
        t.IsTrue(maxIdleWaitsPerWake <= 20u, "an idle frame after the stall must not busy-loop, saw up to " + std::to_string(maxIdleWaitsPerWake) + " idle waits per frame");

        // The VBlank rate is unchanged: real time, neither repaying debt nor oversleeping.
        const double spanMs = std::chrono::duration<double, std::milli>(g_bpWakes[first + 20] - g_bpWakes[first]).count();
        const uint64_t ticks = g_bpWakeTicks[first + 20] - g_bpWakeTicks[first];
        const double rate = ticks * 1000.0 / std::max(1.0, spanMs);
        t.IsTrue(rate < 75.0 && rate > 45.0, "after the stall VBlanks run at real time (~60/s), were " + std::to_string(rate) + "/s");
        t.IsTrue(spanMs < 1000.0, "20 wakes after the stall take about 333 ms, took " + std::to_string(spanMs) + " ms");
    }
}

// Sprint 5 rulings R35/R40/R41: the GS command queue between the EE executor (records) and the GL
// thread (replays) is bounded in frames recorded but not yet replayed, with a wait capped on consumer
// silence, and the time spent waiting is dropped from the VBlank deadline chain.
void register_gs_frame_backpressure_tests()
{
    MiniTest::Case("GsFrameBackpressure", [](TestCase &tc)
    {
        using clock = std::chrono::steady_clock;
        using ms = std::chrono::milliseconds;
        auto msSince = [](clock::time_point t0)
        { return static_cast<long long>(std::chrono::duration_cast<ms>(clock::now() - t0).count()); };

        tc.Run("a producer faster than the consumer stays bounded at N pending frames", [](TestCase &t)
        {
            GsFrameBackpressure bp(3u, ms(5000));
            const uint64_t kFrames = 60u;
            std::atomic<bool> producerDone{false};
            uint64_t maxPendingAfterRecord = 0u;
            uint64_t timeouts = 0u;
            std::thread producer([&]
            {
                for (uint64_t i = 0; i < kFrames; ++i)
                {
                    if (bp.frameRecorded() == GsFrameBackpressure::WaitResult::TimedOut)
                        ++timeouts;
                    maxPendingAfterRecord = std::max(maxPendingAfterRecord, bp.pendingFrames());
                }
                producerDone.store(true);
            });
            // The fake consumer takes what is recorded, "replays" it slowly, then reports it.
            std::thread consumer([&]
            {
                while (!producerDone.load() || bp.pendingFrames() != 0u)
                {
                    const uint64_t taken = bp.recordedFrames();
                    std::this_thread::sleep_for(ms(15));
                    bp.framesReplayed(taken);
                }
            });
            producer.join();
            consumer.join();
            const GsFrameBackpressure::Stats stats = bp.takeStats();
            t.IsTrue(maxPendingAfterRecord <= 3u, "pending frames seen by the producer must stay <= N=3, was " + std::to_string(maxPendingAfterRecord));
            t.Equals(timeouts, uint64_t{0}, "a live consumer must never hit the cap");
            t.Equals(bp.recordedFrames(), kFrames, "every frame is recorded");
            t.IsTrue(stats.waits > 0u, "the producer must actually have waited");
        });

        tc.Run("the wait times out when the consumer stops, then does not wait again until progress", [msSince](TestCase &t)
        {
            GsFrameBackpressure bp(2u, ms(100));
            t.IsTrue(bp.frameRecorded() == GsFrameBackpressure::WaitResult::NotNeeded, "frame 1 is under the bound");
            t.IsTrue(bp.frameRecorded() == GsFrameBackpressure::WaitResult::NotNeeded, "frame 2 is at the bound");
            auto t0 = clock::now();
            const auto third = bp.frameRecorded();
            const long long waited = msSince(t0);
            t.IsTrue(third == GsFrameBackpressure::WaitResult::TimedOut, "frame 3 is over the bound with no consumer: TimedOut");
            t.IsTrue(waited >= 80 && waited < 1500, "the timed-out wait honours the 100 ms cap, took " + std::to_string(waited) + " ms");
            t0 = clock::now();
            const auto fourth = bp.frameRecorded();
            const long long skippedMs = msSince(t0);
            t.IsTrue(fourth == GsFrameBackpressure::WaitResult::Skipped, "a latched-stalled consumer is not waited on again");
            t.IsTrue(skippedMs < 50, "the skipped frame returns at once, took " + std::to_string(skippedMs) + " ms");
            bp.framesReplayed(bp.recordedFrames());
            t.IsTrue(bp.frameRecorded() == GsFrameBackpressure::WaitResult::NotNeeded, "progress clears the latch");
            bp.frameRecorded();
            t0 = clock::now();
            t.IsTrue(bp.frameRecorded() == GsFrameBackpressure::WaitResult::TimedOut, "after progress an over-bound frame waits again");
            const long long again = msSince(t0);
            t.IsTrue(again >= 80, "the second wait honours the cap again, took " + std::to_string(again) + " ms");
        });

        tc.Run("R40: a slow big-batch consumer that keeps making progress keeps the producer bounded, with no latch", [msSince](TestCase &t)
        {
            // Each replay batch takes 4x the cap, but the consumer heartbeats every 10 ms.
            GsFrameBackpressure bp(3u, ms(100));
            const uint64_t kFrames = 24u;
            std::atomic<bool> producerDone{false};
            uint64_t maxPendingAfterRecord = 0u;
            uint64_t notWaitedOverBound = 0u;
            std::thread producer([&]
            {
                for (uint64_t i = 0; i < kFrames; ++i)
                {
                    const auto r = bp.frameRecorded();
                    if (r == GsFrameBackpressure::WaitResult::TimedOut || r == GsFrameBackpressure::WaitResult::Skipped)
                        ++notWaitedOverBound;
                    maxPendingAfterRecord = std::max(maxPendingAfterRecord, bp.pendingFrames());
                }
                producerDone.store(true);
            });
            std::thread consumer([&]
            {
                while (!producerDone.load() || bp.pendingFrames() != 0u)
                {
                    const uint64_t taken = bp.recordedFrames();
                    const auto t0 = clock::now();
                    while (msSince(t0) < 400)
                    {
                        bp.consumerProgress();
                        std::this_thread::sleep_for(ms(10));
                    }
                    bp.framesReplayed(taken);
                }
            });
            producer.join();
            consumer.join();
            const GsFrameBackpressure::Stats stats = bp.takeStats();
            t.Equals(notWaitedOverBound, uint64_t{0}, "a progressing consumer must never time out or be skipped");
            t.Equals(stats.timeouts, uint64_t{0}, "no latch while the consumer makes progress");
            t.IsTrue(maxPendingAfterRecord <= 3u, "pending frames must stay <= N=3, was " + std::to_string(maxPendingAfterRecord));
        });

        tc.Run("R40: a consumer that progresses then stops latches one cap after its last heartbeat", [msSince](TestCase &t)
        {
            GsFrameBackpressure bp(1u, ms(150));
            bp.frameRecorded();
            std::thread consumer([&]
            {
                const auto t0 = clock::now();
                while (msSince(t0) < 400)
                {
                    bp.consumerProgress();
                    std::this_thread::sleep_for(ms(10));
                }
            });
            const auto t0 = clock::now();
            const auto r = bp.frameRecorded();
            const long long took = msSince(t0);
            consumer.join();
            t.IsTrue(r == GsFrameBackpressure::WaitResult::TimedOut, "a consumer silent for the whole cap latches");
            t.IsTrue(took >= 450 && took < 2000, "the latch comes a cap after the last heartbeat (~550 ms), took " + std::to_string(took) + " ms");
        });

        tc.Run("R40: a heartbeat clears the latch before any replay completes", [msSince](TestCase &t)
        {
            GsFrameBackpressure bp(1u, ms(100));
            bp.frameRecorded();
            t.IsTrue(bp.frameRecorded() == GsFrameBackpressure::WaitResult::TimedOut, "no consumer: latch");
            t.IsTrue(bp.frameRecorded() == GsFrameBackpressure::WaitResult::Skipped, "latched: skipped");
            bp.consumerProgress();
            const auto t0 = clock::now();
            const auto r = bp.frameRecorded();
            t.IsTrue(r != GsFrameBackpressure::WaitResult::Skipped, "a heartbeat after the latch must re-arm the wait");
            t.IsTrue(msSince(t0) >= 80, "the re-armed frame waits again for a cap");
            t.IsTrue(bp.takeStats().unlatched >= 1u, "the unlatch is counted");
        });

        tc.Run("release wakes a blocked producer at once and ends waiting (shutdown)", [msSince](TestCase &t)
        {
            GsFrameBackpressure bp(1u, ms(10000));
            bp.frameRecorded();
            GsFrameBackpressure::WaitResult result = GsFrameBackpressure::WaitResult::NotNeeded;
            long long elapsed = 0;
            std::thread producer([&]
            {
                const auto t0 = clock::now();
                result = bp.frameRecorded();
                elapsed = msSince(t0);
            });
            // Release only once the producer is inside the wait (no sleep-and-hope).
            const auto pollStart = clock::now();
            while (bp.waiters() == 0u && msSince(pollStart) < 5000)
                std::this_thread::yield();
            t.Equals(bp.waiters(), uint32_t{1}, "the producer must be inside the wait before release");
            bp.release();
            producer.join();
            t.IsTrue(elapsed < 2000, "the producer woke on release (not the 10 s cap), took " + std::to_string(elapsed) + " ms");
            t.IsTrue(result == GsFrameBackpressure::WaitResult::Waited, "a released wait reports Waited, not TimedOut");
            const auto t0 = clock::now();
            t.IsTrue(bp.frameRecorded() == GsFrameBackpressure::WaitResult::NotNeeded, "after release no frame waits");
            t.IsTrue(msSince(t0) < 50, "after release frameRecorded returns at once");
        });

        tc.Run("#67: a consumer held in a host move loop longer than the cap does not hold the producer", [msSince](TestCase &t)
        {
            // A title-bar drag parks the GL thread in the modal move loop: no replay, no heartbeat. Before #67 the
            // first over-bound frame waited out a whole cap (2 s in the game) and every blocking wait after it
            // stalled again, so the guest clock stood still for the drag. Suspended, nothing waits at all.
            GsFrameBackpressure bp(3u, ms(300));
            for (int i = 0; i < 3; ++i)
                bp.frameRecorded();
            bp.setConsumerSuspended(true);
            t.IsTrue(bp.consumerSuspended(), "the suspension reads back");
            t.IsTrue(bp.latched(), "a suspended consumer reads latched, so the byte cap (GsPendingCap) engages");
            // The simulated drag: 60 guest frames (a second at 60 Hz) with the consumer silent, three caps long in
            // wall time if any frame waited out the cap.
            const auto t0 = clock::now();
            uint64_t timedOut = 0u, waited = 0u;
            for (int i = 0; i < 60; ++i)
            {
                const auto r = bp.frameRecorded();
                if (r == GsFrameBackpressure::WaitResult::TimedOut)
                    ++timedOut;
                if (r == GsFrameBackpressure::WaitResult::Waited)
                    ++waited;
            }
            const long long took = msSince(t0);
            t.Equals(timedOut, uint64_t{0}, "no frame waits out the cap while the host is in its move loop");
            t.Equals(waited, uint64_t{0}, "no frame waits at all while the host is in its move loop");
            t.IsTrue(took < 150, "60 frames through a suspended consumer return at once (under half the 300 ms cap), took " + std::to_string(took) + " ms");
            t.Equals(bp.pendingFrames(), uint64_t{63}, "the frames stay counted as pending: the replay catches up after the drag");
            bp.consumerProgress();
            t.IsTrue(bp.frameRecorded() == GsFrameBackpressure::WaitResult::Skipped, "a stray heartbeat does not end the suspension");
            bp.framesReplayed(bp.recordedFrames());
            t.IsTrue(bp.latched(), "nor does a replay: only the host's WM_EXITSIZEMOVE does");
            bp.setConsumerSuspended(false);
            t.IsTrue(!bp.consumerSuspended() && !bp.latched(), "resumed with the queue drained: live again");
            bp.frameRecorded();
            bp.frameRecorded();
            bp.frameRecorded();
            const auto t1 = clock::now();
            t.IsTrue(bp.frameRecorded() == GsFrameBackpressure::WaitResult::TimedOut, "after the drag an over-bound frame waits for the consumer again");
            t.IsTrue(msSince(t1) >= 250, "and honours the cap again, took " + std::to_string(msSince(t1)) + " ms");
        });

        tc.Run("#67: entering the move loop wakes a producer already waiting on the consumer", [msSince](TestCase &t)
        {
            GsFrameBackpressure bp(1u, ms(3000));
            bp.frameRecorded();
            GsFrameBackpressure::WaitResult result = GsFrameBackpressure::WaitResult::NotNeeded;
            long long elapsed = 0;
            std::thread producer([&]
            {
                const auto t0 = clock::now();
                result = bp.frameRecorded();
                elapsed = msSince(t0);
            });
            const auto pollStart = clock::now();
            while (bp.waiters() == 0u && msSince(pollStart) < 5000)
                std::this_thread::yield();
            t.Equals(bp.waiters(), uint32_t{1}, "the producer must be inside the wait before the drag starts");
            bp.setConsumerSuspended(true);
            producer.join();
            t.IsTrue(elapsed < 1000, "the waiting producer woke when the move loop began (not at the 3 s cap), took " + std::to_string(elapsed) + " ms");
            t.IsTrue(result == GsFrameBackpressure::WaitResult::Skipped, "a wait ended by the move loop reports Skipped, not TimedOut or Waited");
            t.Equals(bp.takeStats().timeouts, uint64_t{0}, "no latch was taken: the suspension is not a stall");
        });

        tc.Run("R41/R54: reanchorVBlankDeadline drops deadline debt but never moves a future deadline", [](TestCase &t)
        {
            const auto now = clock::now();
            const auto period = std::chrono::microseconds(16667);
            const auto past = now - std::chrono::seconds(30);
            t.IsTrue(EeScheduler::reanchorVBlankDeadline(past, now) == now, "a deadline 30 s behind is re-anchored to now");
            t.IsTrue(EeScheduler::reanchorVBlankDeadline(past, now) + period > now, "so the next VBlank is a full period away, not due at once");
            const auto recent = now - std::chrono::microseconds(5000);
            t.IsTrue(EeScheduler::reanchorVBlankDeadline(recent, now) == now, "a deadline a few ms behind is re-anchored to now too (R54)");
            const auto future = now + std::chrono::milliseconds(10);
            t.IsTrue(EeScheduler::reanchorVBlankDeadline(future, now) == future, "a future deadline is unchanged");
        });

        tc.Run("R41: after a long back-pressure wait the scheduler does not fire the missed VBlanks back to back", [](TestCase &t)
        {
            // 600 ms (~36 periods) spent in the wait. Without the re-anchor the missed VBlanks fire
            // back to back once it ends (~172/s until repaid). Re-anchoring the host deadline alone
            // left the wait on the guest cycle clock, so ~36 VBlanks stayed cycle-due and
            // processDueDeadlines paced through them one host period apart without returning to the
            // guest, re-accruing the debt every round: the guest woke once per ~36 VBlanks, forever.
            runVBlankStallScenario(t, true, false);
        });

        tc.Run("R41: a short wait after an unrelated executor stall (level load) re-anchors both clocks", [](TestCase &t)
        {
            // The 600 ms stall is not a back-pressure wait, so it is ordinary guest time and debt on
            // both clocks; the 10 ms wait on the next VBlank then re-anchors. Re-anchoring only the
            // host deadline there left the whole load stall as cycle debt: the same pacing lock-up
            // (the s5_gsbp2 and s5_gsbp2b mission hang right after the intro movie).
            runVBlankStallScenario(t, false, true);
        });

        tc.Run("PS2X_GS_MAX_PENDING_FRAMES=0 restores unbounded behaviour", [msSince](TestCase &t)
        {
            t.Equals(GsFrameBackpressure::parseMaxPendingFrames(nullptr), uint32_t{3}, "unset -> default N=3");
            t.Equals(GsFrameBackpressure::parseMaxPendingFrames("0"), uint32_t{0}, "'0' -> 0 (unbounded)");
            t.Equals(GsFrameBackpressure::parseMaxPendingFrames("2"), uint32_t{2}, "'2' -> 2");
            t.Equals(GsFrameBackpressure::parseMaxPendingFrames(""), uint32_t{3}, "empty -> default");
            t.Equals(GsFrameBackpressure::parseMaxPendingFrames("abc"), uint32_t{3}, "garbage -> default");
            t.Equals(GsFrameBackpressure::parseMaxPendingFrames("-1"), uint32_t{3}, "negative -> default");
            t.Equals(GsFrameBackpressure::parseMaxPendingFrames("70000"), uint32_t{3}, "above 65535 -> default (logged once)");
            t.Equals(GsFrameBackpressure::parseMaxPendingFrames("65535"), uint32_t{65535}, "65535 is accepted");

            GsFrameBackpressure bp(GsFrameBackpressure::parseMaxPendingFrames("0"), ms(200));
            const auto t0 = clock::now();
            bool anyWait = false;
            for (int i = 0; i < 1000; ++i)
                anyWait = (bp.frameRecorded() != GsFrameBackpressure::WaitResult::NotNeeded) || anyWait;
            t.IsFalse(anyWait, "unbounded: no frame ever waits");
            t.Equals(bp.pendingFrames(), uint64_t{1000}, "unbounded: 1000 frames pend with no consumer");
            t.IsTrue(msSince(t0) < 150, "unbounded: 1000 frames record without blocking");
        });

        // Sprint 10 Goal 11 (Q6). This case used to be "a latched queue drops guest frames and keeps
        // uploads" and asserted `cap.bytes() <= 1024 + 200 * 64` -- "only uploads may exceed the cap":
        // it codified the unbounded state stream (KNOWN: "once the replay latches stalled,
        // GsPendingCap::admit keeps every state-carrying command unbounded"). Now it asserts the bound.
        tc.Run("a latched queue drops guest frames and, past the cap, refuses uploads for the coalescer instead of pending them (Q6)", [](TestCase &t)
        {
            GsPendingCap cap(1024u);            // 1 KiB, so the cap is reachable in a test
            uint64_t admittedDraws = 0, admittedUploads = 0;
            for (int frame = 0; frame < 200; ++frame)
            {
                if (cap.admit(true, false, 64u)) ++admittedDraws;      // a guest frame's draw work
                if (cap.admit(true, true, 64u))  ++admittedUploads;    // an upload: state -- absorbed past the cap, never pended
            }
            t.IsTrue(cap.bytes() <= 1024u + 64u, "the queue stays at the cap plus one command, was " + std::to_string(cap.bytes()));
            t.IsTrue(admittedUploads > 0u && admittedUploads < 200u,
                     "uploads are admitted up to the cap and refused past it (" + std::to_string(admittedUploads) + " admitted)");
            t.IsTrue(admittedDraws < 200u, "draws stop being admitted at the cap (" + std::to_string(admittedDraws) + ")");
            t.IsTrue(cap.droppedCommands() > 0u, "the drops are counted");
            t.Equals(static_cast<int>(cap.droppedBytes()), static_cast<int>((200u - admittedDraws) * 64u), "the dropped bytes are counted, refused uploads are not drops");
        });

        tc.Run("Q6: across N frames of a latched stall the pending bytes stay under the cap plus one command", [](TestCase &t)
        {
            // The title movie's frame as the recorder sees it (research/16 section 9: ~1040 16x16
            // CT32 tiles of 1 KB, each a BeginTransfer and an Upload), two palette snapshots, ~500
            // draws and one Present; 600 of them = 10 s of a hung GL thread, which is what killed
            // the 8 GB VM (s8_vm_title_audio3, std::bad_alloc). The command record's size only
            // scales how many frames reach the cap; it is GSGlBackend's own Cmd here.
            const uint64_t cmd = GSGlBackend::kCommandBytes;
            const uint64_t capBytes = 64ull * 1024u * 1024u;
            GsPendingCap cap(capBytes);
            uint64_t peak = 0u, stateBytesOffered = 0u;
            for (int frame = 0; frame < 600; ++frame)
            {
                for (int tile = 0; tile < 1040; ++tile)
                {
                    cap.admit(true, true, cmd);           // BeginTransfer
                    cap.admit(true, true, cmd + 1024u);   // Upload, one tile
                    stateBytesOffered += 2u * cmd + 1024u;
                }
                for (int c = 0; c < 2; ++c)
                {
                    cap.admit(true, true, cmd + 2048u);   // ClutLoad
                    stateBytesOffered += cmd + 2048u;
                }
                for (int d = 0; d < 500; ++d)
                    cap.admit(true, false, cmd);          // Submit: dropped at the cap since Sprint 7
                cap.admit(true, true, cmd);               // Present (postAndGetToken accounts it)
                stateBytesOffered += cmd;
                peak = std::max(peak, cap.bytes());
            }
            const uint64_t bound = capBytes + cmd + 2048u;
            t.IsTrue(peak <= bound, "peak pending bytes over 600 stalled frames must stay under the cap plus one command: peak " +
                                        std::to_string(peak) + " > " + std::to_string(bound) + " (the state stream offered " +
                                        std::to_string(stateBytesOffered) + " bytes)");
            t.Equals(cap.absorptions(), uint64_t{1}, "one stall, one absorption");
            t.IsTrue(cap.absorbedBytes() + cap.bytes() >= stateBytesOffered - cmd - 2048u,
                     "everything the state stream offered past the cap was refused for the coalescer, not lost");
            std::printf("\n      [q6] a command record is %zu bytes; one title frame offers %llu bytes of state, 600 of them %llu",
                        GSGlBackend::kCommandBytes, static_cast<unsigned long long>(stateBytesOffered / 600u),
                        static_cast<unsigned long long>(stateBytesOffered));
        });

        tc.Run("Q6: the cap stays absorbing until the latch clears, even when the replay empties the queue first", [](TestCase &t)
        {
            GsPendingCap cap(1024u);
            t.IsFalse(cap.reanchorDue(false), "nothing is due before anything was absorbed");
            for (int i = 0; i < 16; ++i)
                cap.admit(true, true, 64u); // 1024 bytes: at the cap, all admitted
            t.IsFalse(cap.absorbing(), "reaching the cap alone absorbs nothing");
            t.IsFalse(cap.admit(true, true, 64u), "the first state command past the cap is refused");
            t.IsTrue(cap.absorbing(), "... and the cap is absorbing");
            t.Equals(cap.absorptions(), uint64_t{1}, "one absorption began");
            cap.onReplayed(cap.bytes()); // the replay's swap: the accounting is empty, the latch is still set
            t.Equals(cap.bytes(), uint64_t{0}, "the swap emptied the accounting");
            t.IsFalse(cap.admit(true, true, 64u), "still refused: absorbing outlives the byte count while latched");
            t.IsFalse(cap.admit(true, false, 64u), "draw work too");
            t.Equals(cap.droppedCommands(), uint64_t{1}, "the draw is a drop");
            t.Equals(cap.absorbedCommands(), uint64_t{2}, "the two state commands are absorptions");
            t.Equals(cap.absorptions(), uint64_t{1}, "still the same absorption");
            t.IsFalse(cap.reanchorDue(true), "not due while latched");
            t.IsTrue(cap.reanchorDue(false), "due the moment the latch clears");
            cap.endAbsorbing();
            t.IsFalse(cap.absorbing(), "endAbsorbing closes it");
            t.IsTrue(cap.admit(false, true, 64u), "a live consumer's state command is admitted again");
            cap.admitWaited(64u);
            t.Equals(cap.bytes(), uint64_t{128}, "admitWaited accounts and never refuses");

            GsPendingCap live(1024u);
            for (int i = 0; i < 100; ++i)
                t.IsTrue(live.admit(false, true, 64u), "nothing is ever refused while the consumer is live");
            t.Equals(live.absorptions(), uint64_t{0}, "a live consumer never starts an absorption");
            GsPendingCap unbounded(0u);
            for (int i = 0; i < 100; ++i)
                t.IsTrue(unbounded.admit(true, true, 64u), "PS2X_GS_PENDING_CAP_MB=0: no cap, nothing refused (R124's ceiling is the last line)");
        });

        tc.Run("Q6: the coalescer remembers where a stall wrote, not what -- the movie's tiles become one rectangle, a palette one snapshot per id", [](TestCase &t)
        {
            // 600 frames of the title movie: 40x26 tiles of 16x16 CT32 into the staging buffer
            // (dbp 0x3c0, dbw 10: research/16 section 9), two palettes alternating every load.
            GsStallCoalescer co;
            co.engage();
            const uint64_t cmd = GSGlBackend::kCommandBytes;
            GSTransferCommand tile;
            tile.bitbltbuf.dbp = 0x3c0u;
            tile.bitbltbuf.dbw = 10u;
            tile.bitbltbuf.dpsm = static_cast<uint8_t>(GS_PSM_CT32);
            tile.trxreg.rrw = 16u;
            tile.trxreg.rrh = 16u;
            tile.direction = 0u;
            GSClutLoad a, b;
            a.id = 7u; a.cbp = 0x100u; a.cpsm = static_cast<uint8_t>(GS_PSM_CT32); a.bytes.fill(0xAAu);
            b.id = 9u; b.cbp = 0x100u; b.cpsm = static_cast<uint8_t>(GS_PSM_CT32); b.bytes.fill(0xBBu);
            uint64_t peakWorkingSet = 0u;
            for (int frame = 0; frame < 600; ++frame)
            {
                for (uint32_t ty = 0; ty < 26u; ++ty)
                    for (uint32_t tx = 0; tx < 40u; ++tx)
                    {
                        tile.trxpos.dsax = static_cast<uint16_t>(tx * 16u);
                        tile.trxpos.dsay = static_cast<uint16_t>(ty * 16u);
                        const uint32_t page = tile.bitbltbuf.dbp >> 5;
                        co.noteTransfer(tile, page, 1u, cmd);
                        co.noteUpload(tile, page, 1u, cmd + 1024u);
                    }
                co.noteClut(a, cmd + sizeof(GSClutLoad));
                co.noteClut(b, cmd + sizeof(GSClutLoad));
                peakWorkingSet = std::max(peakWorkingSet, co.workingSetBytes());
            }
            t.IsTrue(peakWorkingSet < 16u * 1024u, "the coalescer's tables stay under 16 KB over 600 frames, peaked at " + std::to_string(peakWorkingSet));
            t.Equals(co.rectCount(), size_t{1}, "the tiles merged into one rectangle, have " + std::to_string(co.rectCount()));
            t.Equals(co.clutCount(), size_t{2}, "two palette ids, two snapshots");
            t.IsFalse(co.pagesOnly(), "no fallback was needed");
            const GsStallCoalescer::Plan plan = co.finish();
            t.IsFalse(co.active(), "finish() ends the engagement");
            t.Equals(plan.rects.size(), size_t{1}, "one synthesized transfer");
            if (!plan.rects.empty())
            {
                const GsStallCoalescer::Rect &r = plan.rects[0];
                t.IsTrue(r.dbp == 0x3c0u && r.dbw == 10u && r.dpsm == GS_PSM_CT32 && r.x0 == 0u && r.y0 == 0u && r.x1 == 640u && r.y1 == 416u,
                         "the rectangle is the whole 640x416 frame at the staging buffer");
                t.Equals(GsStallCoalescer::rectBytes(r), uint64_t{640u * 416u * 4u}, "its re-anchor carries the frame's bytes once");
                const GSTransferCommand tr = GsStallCoalescer::transferFor(r);
                t.IsTrue(tr.direction == 0u && tr.trxreg.rrw == 640u && tr.trxreg.rrh == 416u && tr.trxpos.dsax == 0u && tr.trxpos.dsay == 0u,
                         "transferFor is the host->local transfer of that rectangle");
            }
            t.Equals(plan.cluts.size(), size_t{2}, "both palettes are re-anchored");
            if (plan.cluts.size() == 2u)
                t.IsTrue(plan.cluts[0].id == 7u && plan.cluts[1].id == 9u, "oldest load first (the replay evicts by age)");
            t.Equals(plan.absorbedCommands, uint64_t{600u * (1040u * 2u + 2u)}, "every absorbed command is counted in the plan");
            t.Equals(plan.absorbedBytes, uint64_t{600u * (1040u * (2u * cmd + 1024u) + 2u * (cmd + sizeof(GSClutLoad)))}, "... with its bytes");
        });

        tc.Run("Q6: the re-anchor's bytes are exact -- a rectangle packed from one VRAM and uploaded into another reproduces it, every format", [](TestCase &t)
        {
            const uint32_t kVram = 4u * 1024u * 1024u;
            const uint8_t psms[] = {GS_PSM_CT32, GS_PSM_CT24, GS_PSM_CT16, GS_PSM_CT16S, GS_PSM_T8, GS_PSM_T4, GS_PSM_T8H,
                                    GS_PSM_T4HL, GS_PSM_T4HH, GS_PSM_Z32, GS_PSM_Z24, GS_PSM_Z16, GS_PSM_Z16S};
            std::mt19937 rng(20260921u);
            for (const uint8_t psm : psms)
            {
                std::vector<uint8_t> vramA(kVram, 0u), vramB(kVram, 0u);
                GSCpuBackend a, b;
                a.Initialize(vramA.data(), kVram);
                b.Initialize(vramB.data(), kVram);
                // Odd sizes and an odd origin so the 4-bit formats cross byte boundaries mid-row.
                GsStallCoalescer::Rect r;
                r.dbp = 0x1000u;
                r.dbw = 8u;
                r.dpsm = psm;
                r.x0 = 3u; r.y0 = 5u; r.x1 = 3u + 37u; r.y1 = 5u + 11u;
                const GSTransferCommand tr = GsStallCoalescer::transferFor(r);
                const uint64_t bytes = GsStallCoalescer::rectBytes(r);
                std::vector<uint8_t> data(static_cast<size_t>(bytes));
                for (uint8_t &v : data)
                    v = static_cast<uint8_t>(rng());
                if (GsStallCoalescer::streamBitsPerPixel(psm) == 4u && ((37u * 11u) & 1u))
                    data.back() &= 0x0Fu; // the stream's trailing nibble is never written: keep the comparison honest
                // The game's upload, in three chunks, as the frontend splits a rectangle across GIF
                // tags -- at whole pixels (a multiple of 12 bytes is whole in every format), since
                // UploadImage drops a partial pixel at the end of a packet.
                a.BeginTransfer(tr);
                const size_t c1 = (data.size() / 3u) / 12u * 12u, c2 = (2u * data.size() / 3u) / 12u * 12u;
                a.UploadImage(data.data(), static_cast<uint32_t>(c1));
                a.UploadImage(data.data() + c1, static_cast<uint32_t>(c2 - c1));
                a.UploadImage(data.data() + c2, static_cast<uint32_t>(data.size() - c2));
                t.IsTrue(a.GetTransferSnapshot().direction == 3u, "psm " + std::to_string(psm) + ": the game's transfer completed");
                // The re-anchor: pack from A's VRAM, upload into B.
                std::vector<uint8_t> packed;
                t.IsTrue(GsStallCoalescer::packRect(vramA.data(), r, packed), "psm " + std::to_string(psm) + ": packRect reads the format");
                t.Equals(packed.size(), data.size(), "psm " + std::to_string(psm) + ": the packed stream is the upload's size");
                t.IsTrue(packed == data, "psm " + std::to_string(psm) + ": the packed stream IS the upload's bytes");
                b.BeginTransfer(tr);
                b.UploadImage(packed.data(), static_cast<uint32_t>(packed.size()));
                t.IsTrue(std::memcmp(vramA.data(), vramB.data(), kVram) == 0, "psm " + std::to_string(psm) + ": the re-anchored VRAM equals the game's, byte for byte");
            }
            // The page fallback: one 64x32 CT32 rectangle is exactly a page's 8 KB, whatever was in it.
            {
                std::vector<uint8_t> vramA(kVram, 0u), vramB(kVram, 0u);
                for (size_t i = 0; i < kVram; ++i)
                    vramA[i] = static_cast<uint8_t>(rng());
                GSCpuBackend b;
                b.Initialize(vramB.data(), kVram);
                for (uint32_t page = 0; page < 512u; page += 97u)
                {
                    const GsStallCoalescer::Rect r = GsStallCoalescer::pageRect(page);
                    t.Equals(GsStallCoalescer::rectBytes(r), uint64_t{8192}, "a page rectangle is 8 KB");
                    std::vector<uint8_t> packed;
                    t.IsTrue(GsStallCoalescer::packRect(vramA.data(), r, packed), "the page packs");
                    b.BeginTransfer(GsStallCoalescer::transferFor(r));
                    b.UploadImage(packed.data(), static_cast<uint32_t>(packed.size()));
                    t.IsTrue(std::memcmp(vramA.data() + page * 8192u, vramB.data() + page * 8192u, 8192u) == 0,
                             "page " + std::to_string(page) + " arrives intact through the CT32 view");
                }
            }
        });

        tc.Run("Q6: an in-flight transfer is restored to the game thread's position -- the chunk after the re-anchor lands in its own row", [](TestCase &t)
        {
            const uint32_t kVram = 4u * 1024u * 1024u;
            std::vector<uint8_t> vramA(kVram, 0u), vramB(kVram, 0u);
            GSCpuBackend a, b;
            a.Initialize(vramA.data(), kVram);
            b.Initialize(vramB.data(), kVram);
            GSTransferCommand tr;
            tr.bitbltbuf.dbp = 0x2000u;
            tr.bitbltbuf.dbw = 4u;
            tr.bitbltbuf.dpsm = static_cast<uint8_t>(GS_PSM_CT16);
            tr.trxpos.dsax = 8u;
            tr.trxpos.dsay = 2u;
            tr.trxreg.rrw = 50u;
            tr.trxreg.rrh = 8u;
            tr.direction = 0u;
            std::mt19937 rng(7u);
            std::vector<uint8_t> data(50u * 8u * 2u);
            for (uint8_t &v : data)
                v = static_cast<uint8_t>(rng());
            // The game: BeginTransfer, then three and a half rows (the stall's absorbed chunks).
            const size_t taken = 3u * 100u + 50u; // 175 pixels of 400
            a.BeginTransfer(tr);
            a.UploadImage(data.data(), static_cast<uint32_t>(taken));
            const GSTransferSnapshot snap = a.GetTransferSnapshot();
            t.Equals(snap.copiedPixels, uint32_t{175}, "the game thread is 175 pixels in");
            t.Equals(snap.direction, uint32_t{0}, "... with the transfer open");
            // The re-anchor for the open transfer: BeginTransfer plus the prefix re-read from A.
            std::vector<uint8_t> prefix;
            t.IsTrue(GsStallCoalescer::packPrefix(vramA.data(), tr, snap.copiedPixels, prefix), "packPrefix reads the prefix");
            t.Equals(prefix.size(), taken, "the prefix is the bytes taken so far");
            b.BeginTransfer(tr);
            b.UploadImage(prefix.data(), static_cast<uint32_t>(prefix.size()));
            const GSTransferSnapshot restored = b.GetTransferSnapshot();
            t.IsTrue(restored.copiedPixels == snap.copiedPixels && restored.x == snap.x && restored.y == snap.y &&
                         restored.totalPixels == snap.totalPixels && restored.direction == snap.direction,
                     "the receiver's transfer state is the game thread's");
            // The game's next chunk, applied to both: it must land in the same rows.
            a.UploadImage(data.data() + taken, static_cast<uint32_t>(data.size() - taken));
            b.UploadImage(data.data() + taken, static_cast<uint32_t>(data.size() - taken));
            t.IsTrue(a.GetTransferSnapshot().direction == 3u && b.GetTransferSnapshot().direction == 3u, "both transfers completed");
            t.IsTrue(std::memcmp(vramA.data(), vramB.data(), kVram) == 0, "the two VRAMs agree byte for byte after the chunk");
        });

        tc.Run("Q6: the bounds hold under a hostile stall -- too many destinations fall back to pages under 4 MB, palettes keep the newest 256, a Reset forgets", [](TestCase &t)
        {
            GsStallCoalescer co;
            co.engage();
            GSTransferCommand tr;
            tr.bitbltbuf.dbw = 1u;
            tr.bitbltbuf.dpsm = static_cast<uint8_t>(GS_PSM_CT32);
            tr.trxreg.rrw = 8u;
            tr.trxreg.rrh = 8u;
            tr.direction = 0u;
            uint64_t peak = 0u;
            for (uint32_t i = 0; i < 4000u; ++i)
            {
                tr.bitbltbuf.dbp = (i * 4u) % (512u * 32u); // a new destination every time, over the first 512 pages' blocks
                tr.trxpos.dsax = static_cast<uint16_t>((i % 5u) * 8u);
                tr.trxpos.dsay = static_cast<uint16_t>((i % 3u) * 8u);
                co.noteTransfer(tr, tr.bitbltbuf.dbp >> 5, 1u, 100u);
                co.noteUpload(tr, tr.bitbltbuf.dbp >> 5, 1u, 356u);
                peak = std::max(peak, co.workingSetBytes());
            }
            t.IsTrue(co.pagesOnly(), "past kMaxRects destinations the plan is per page");
            t.IsTrue(co.rectCount() == 0u, "the rectangle table was let go");
            t.IsTrue(co.plannedRectBytes() <= GsStallCoalescer::kVramBytes, "the re-anchor is at most VRAM's size: " + std::to_string(co.plannedRectBytes()));
            t.IsTrue(peak < 64u * 1024u, "the tables never passed 64 KB, peaked at " + std::to_string(peak));
            for (uint64_t id = 1; id <= 1000u; ++id)
            {
                GSClutLoad load;
                load.id = id;
                co.noteClut(load, 2100u);
            }
            t.Equals(co.clutCount(), GsStallCoalescer::kMaxCluts, "only the newest kMaxCluts palettes are kept");
            GsStallCoalescer::Plan plan = co.finish();
            t.IsTrue(plan.pagesOnly, "the plan says so");
            t.IsTrue(plan.rects.size() <= 512u && !plan.rects.empty(), "one rectangle per touched page: " + std::to_string(plan.rects.size()));
            bool allPages = true;
            uint64_t planBytes = 0u;
            for (const GsStallCoalescer::Rect &r : plan.rects)
            {
                allPages = allPages && r.dbw == 1u && r.dpsm == GS_PSM_CT32 && r.x0 == 0u && r.y0 == 0u && r.x1 == 64u && r.y1 == 32u && (r.dbp % 32u) == 0u;
                planBytes += GsStallCoalescer::rectBytes(r);
            }
            t.IsTrue(allPages, "each is a whole page in the CT32 view");
            t.IsTrue(planBytes <= GsStallCoalescer::kVramBytes, "and together at most 4 MB: " + std::to_string(planBytes));
            t.Equals(plan.cluts.size(), GsStallCoalescer::kMaxCluts, "256 palettes in the plan");
            if (plan.cluts.size() == GsStallCoalescer::kMaxCluts)
                t.IsTrue(plan.cluts.front().id == 1000u - 255u && plan.cluts.back().id == 1000u, "the newest 256, oldest first");

            // A format the packer cannot read forces the page plan too.
            GsStallCoalescer odd;
            odd.engage();
            tr.bitbltbuf.dpsm = 0x05u; // no such storage format
            odd.noteTransfer(tr, 0u, 1u, 100u);
            t.IsTrue(odd.pagesOnly(), "an unreadable format goes the page way");

            // A Reset between: what was written before it is moot; the engagement stays open.
            GsStallCoalescer reset;
            reset.engage();
            tr.bitbltbuf.dpsm = static_cast<uint8_t>(GS_PSM_CT32);
            reset.noteTransfer(tr, 0u, 1u, 100u);
            GSClutLoad load;
            load.id = 3u;
            reset.noteClut(load, 2100u);
            reset.noteReset();
            t.IsTrue(reset.active(), "still engaged after a Reset");
            t.Equals(reset.rectCount(), size_t{0}, "the rectangles before the Reset are forgotten");
            t.Equals(reset.clutCount(), size_t{0}, "so are the palettes");
            tr.bitbltbuf.dbp = 0x40u;
            reset.noteTransfer(tr, 2u, 1u, 100u);
            const GsStallCoalescer::Plan after = reset.finish();
            t.Equals(after.rects.size(), size_t{1}, "only what came after the Reset is re-anchored");
        });

        // Sprint 8 Goal 5 (ruling R124): the hard ceiling. The soft cap above may never drop a
        // state-carrying command, so a replay that stays stalled grows the queue until
        // std::bad_alloc. Above the ceiling the recorder WAITS instead; GsPendingCap only owns the
        // predicate (mustWait) and the counter, because the waiting needs the backend's queue lock.
        tc.Run("R124: the hard ceiling makes the recorder wait and drains again after a replay", [](TestCase &t)
        {
            GsPendingCap cap(0u, 1024u); // no soft cap, a 1 KiB ceiling
            t.Equals(static_cast<int>(cap.hardCapBytes()), 1024, "the ceiling is reported in bytes");
            t.IsFalse(cap.mustWait(), "an empty queue never waits");
            for (int i = 0; i < 15; ++i)
                cap.admit(false, true, 64u); // 960 bytes: still under the ceiling
            t.IsFalse(cap.mustWait(), "below the ceiling: no wait");
            cap.admit(false, true, 64u); // 1024 bytes: at the ceiling
            t.IsTrue(cap.mustWait(), "at the ceiling: wait");
            cap.admit(false, true, 4096u); // far above it
            t.IsTrue(cap.mustWait(), "above the ceiling: wait");
            cap.onReplayed(cap.bytes());
            t.IsFalse(cap.mustWait(), "the replay drained the queue: no wait");
        });

        tc.Run("R124: a zero hard ceiling never waits, however much pends", [](TestCase &t)
        {
            GsPendingCap cap(0u, 0u);
            t.Equals(static_cast<int>(cap.hardCapBytes()), 0, "0 = no ceiling");
            for (int i = 0; i < 1000; ++i)
                cap.admit(true, true, 1024u * 1024u); // a gigabyte of state-carrying commands
            t.IsFalse(cap.mustWait(), "no ceiling: a gigabyte pending still does not wait");
        });

        tc.Run("R124: the hard ceiling is independent of the latch", [](TestCase &t)
        {
            GsPendingCap unlatched(0u, 1024u);
            for (int i = 0; i < 16; ++i)
                unlatched.admit(false, true, 64u);
            t.IsTrue(unlatched.mustWait(), "an unlatched but slow replay hits the same ceiling");
            t.Equals(static_cast<int>(unlatched.droppedCommands()), 0, "the ceiling drops nothing");

            GsPendingCap latched(0u, 1024u);
            for (int i = 0; i < 16; ++i)
                latched.admit(true, true, 64u);
            t.IsTrue(latched.mustWait(), "a latched replay hits it too");
            t.Equals(static_cast<int>(latched.droppedCommands()), 0, "state-carrying commands are still never dropped");
        });

        tc.Run("R124: noteHardWait counts the commands that waited", [](TestCase &t)
        {
            GsPendingCap cap(0u, 1024u);
            t.Equals(static_cast<int>(cap.hardWaits()), 0, "nothing waited yet");
            cap.noteHardWait();
            t.Equals(static_cast<int>(cap.hardWaits()), 1, "one command waited");
            for (int i = 0; i < 9; ++i)
                cap.noteHardWait();
            t.Equals(static_cast<int>(cap.hardWaits()), 10, "ten commands waited");
        });

        tc.Run("PS2X_GS_PENDING_HARD_CAP_MB parses with the 1024 MB fallback", [](TestCase &t)
        {
            t.Equals(static_cast<int>(GsPendingCap::kDefaultHardCapMb), 1024, "the default ceiling is 1024 MB");
            t.Equals(static_cast<int>(GsPendingCap::parseCapMb(nullptr, GsPendingCap::kDefaultHardCapMb)), 1024,
                     "unset -> the 1024 MB default");
            t.Equals(static_cast<int>(GsPendingCap::parseCapMb("0", GsPendingCap::kDefaultHardCapMb)), 0,
                     "'0' -> no ceiling");
            t.Equals(static_cast<int>(GsPendingCap::parseCapMb("2048", GsPendingCap::kDefaultHardCapMb)), 2048,
                     "a decimal is taken");
            t.Equals(static_cast<int>(GsPendingCap::parseCapMb("abc", GsPendingCap::kDefaultHardCapMb)), 1024,
                     "garbage -> the 1024 MB default");
        });

        tc.Run("an unlatched queue admits everything and the replay releases bytes", [](TestCase &t)
        {
            GsPendingCap cap(1024u);
            for (int i = 0; i < 1000; ++i)
                t.IsTrue(cap.admit(false, false, 64u), "nothing is dropped while the consumer is live");
            t.Equals(static_cast<int>(cap.droppedCommands()), 0, "no drops");
            cap.onReplayed(cap.bytes());
            t.Equals(static_cast<int>(cap.bytes()), 0, "a replay empties the accounting");
        });

        tc.Run("PS2X_GS_PENDING_CAP_MB parses like the frame knob", [](TestCase &t)
        {
            t.Equals(static_cast<int>(GsPendingCap::parseCapMb("128", 64u)), 128, "a decimal is taken");
            t.Equals(static_cast<int>(GsPendingCap::parseCapMb("-1", 64u)), 64, "a negative falls back");
            t.Equals(static_cast<int>(GsPendingCap::parseCapMb(nullptr, 64u)), 64, "unset falls back");
        });

        // Sprint 7 Task 2e (research/29 section 4): the [pc-sampler]'s freeze fields are built by a pure
        // function, so the line's shape is a test rather than a launch (the sampler prints from its own thread).
        tc.Run("the pc-sampler's freeze fields print research/29 section 4's values in order", [](TestCase &t)
        {
            FreezeFields::Sample s;
            s.hostSeconds = 612.5;
            s.vsyncTick = 41233ull;
            s.eeSeconds = 612.1;
            s.sequence = 8891ull;
            s.debugPc = 0x350d90u;
            s.idleWaits = 140ull;
            s.bpPending = 0ull;
            s.bpWaiters = 0u;
            s.bpWaitMs = 12ull;
            s.netWait = 1;
            s.netWaitMs = 3300ull;
            s.netPark = 1;
            s.netParkMs = 9800ull;
            t.Equals(FreezeFields::line(s),
                     std::string(" t=612.50 vsync=41233 ee=612.10 seq=8891 dpc=0x350d90 idle=140"
                                 " bp_pending=0 bp_waiters=0 bp_wait_ms=12 net_wait=1/3300 net_park=1/9800"),
                     "freeze_trace.parse reads exactly this (test_freeze_trace.py: SAMPLE without net_park=, the net_park cases with it)");
            FreezeFields::Sample quiet;
            quiet.hostSeconds = 3.0;
            quiet.eeSeconds = 2.5;
            t.Equals(FreezeFields::line(quiet),
                     std::string(" t=3.00 vsync=0 ee=2.50 seq=0 dpc=0x0 idle=0 bp_pending=0 bp_waiters=0"
                                 " bp_wait_ms=0 net_wait=0/0 net_park=0/0"),
                     "a quiet sample still prints every field: a missing one would read as a parse failure");
        });

        tc.Run("waitNsTotal is cumulative and takeStats() does not clear it (the sampler never races the printer)", [](TestCase &t)
        {
            GsFrameBackpressure bp(1u, ms(60));
            t.Equals(bp.waitNsTotal(), uint64_t{0}, "nothing has waited yet");
            bp.frameRecorded();                                   // frame 1: at the bound
            bp.frameRecorded();                                   // frame 2: over it, waits the cap out
            const uint64_t afterWait = bp.waitNsTotal();
            t.IsTrue(afterWait >= 40000000ull, "the 60 ms cap is counted in ns, was " + std::to_string(afterWait));
            const GsFrameBackpressure::Stats stats = bp.takeStats();
            t.IsTrue(stats.waitMs > 0.0, "the 60-present printer still gets its clearing counter");
            t.Equals(bp.waitNsTotal(), afterWait, "the sampler's counter survives that takeStats()");
            t.IsTrue(bp.takeStats().waitMs == 0.0, "... while the clearing one is back to zero");
        });

        tc.Run("a frontend with no GPU back-pressure reports zero pending frames and zero waiters", [](TestCase &t)
        {
            GS gs;
            t.Equals(gs.pendingGuestFrames(), uint64_t{0}, "the CPU path has no pending guest frames");
            t.Equals(static_cast<int>(gs.backpressureWaiters()), 0, "and nobody inside the wait");
        });
    });
}
