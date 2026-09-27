#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>

// Back-pressure between the thread that records a GPU backend's GS command stream (the EE
// executor, once per guest VBlankStart) and the thread that replays it (the GL/main thread, once
// per host frame). Sprint 5 ruling R35: without it the recorder runs vsync-paced at 60 guest
// frames/s whatever the replay costs, so when replay is slower (SP gameplay, ~14 frames/s) the
// pending command buffer grows without bound (275 MB -> 13 GB in 4 min) and every host frame
// drains a larger backlog (stall-report.md).
//
// Policy: after recording frame k, the recorder waits while more than maxPendingFrames frames are
// recorded but not yet replayed. The cap bounds how long the consumer may make NO progress
// (ruling R40): the consumer bumps a heartbeat (consumerProgress) while it executes, so a live GL
// thread replaying a big batch keeps the recorder waiting past the cap. Only a consumer silent for
// the whole cap (window drag in the modal pump, hang, exit) latches "consumer stalled": frames then
// do not wait, and the latch clears on the next heartbeat or completed replay. So a stuck GL
// thread costs one cap, not one cap per frame. release() ends all waiting for good (shutdown).
// maxPendingFrames == 0 is unbounded (the pre-R35 behaviour); PS2X_GS_MAX_PENDING_FRAMES sets it.
class GsFrameBackpressure
{
public:
    static constexpr uint32_t kDefaultMaxPendingFrames = 3u;
    static constexpr std::chrono::milliseconds kDefaultWaitCap{2000};

    enum class WaitResult
    {
        NotNeeded, // at or under the bound (or unbounded / released): returned at once
        Waited,    // over the bound; the consumer caught up (or release()) within the cap
        TimedOut,  // over the bound; no consumer progress for a whole cap (latches the stalled state)
        Skipped,   // over the bound, but the consumer is latched stalled: no wait
    };

    struct Stats
    {
        uint64_t frames = 0;   // frameRecorded calls
        uint64_t waits = 0;    // Waited results
        uint64_t timeouts = 0; // TimedOut results (= latches taken)
        uint64_t unlatched = 0; // latches cleared (heartbeat or replay after a latch)
        uint64_t skipped = 0;  // Skipped results
        double waitMs = 0.0;   // time spent inside Waited and TimedOut waits
    };

    // nullptr (unset) or an unparsable value -> fallback; "0" -> 0 (unbounded); "<n>" -> n.
    static uint32_t parseMaxPendingFrames(const char *value, uint32_t fallback = kDefaultMaxPendingFrames);

    explicit GsFrameBackpressure(uint32_t maxPendingFrames = kDefaultMaxPendingFrames,
                                 std::chrono::milliseconds waitCap = kDefaultWaitCap);

    void setMaxPendingFrames(uint32_t maxPendingFrames);
    uint32_t maxPendingFrames() const;

    // Recorder: one more guest frame's commands are fully recorded. May block (capped).
    WaitResult frameRecorded();

    // Consumer: the number of frames recorded so far. Read it while holding the lock that takes
    // the pending command buffer, so it counts exactly the frames that buffer holds.
    uint64_t recordedFrames() const;
    // Consumer: a heartbeat while it executes (lock-free; call per command chunk). Extends a
    // producer's wait past the cap and clears a stalled latch.
    void consumerProgress() { m_progress.fetch_add(1u, std::memory_order_relaxed); }
    // Consumer: every frame up to `recordedCount` (a recordedFrames() value) has been replayed.
    void framesReplayed(uint64_t recordedCount);

    // Shutdown: wake any waiter; no frame waits again.
    void release();

    // Issue #67 (Sprint 15 T2): the consumer's thread is inside the host's modal move/size loop (a title-bar
    // drag: WM_ENTERSIZEMOVE to WM_EXITSIZEMOVE on Windows), so it cannot replay or present until the mouse is
    // released. While suspended no frame waits: an over-bound frame returns Skipped at once, a producer already
    // waiting is woken, and latched() reads true so GsPendingCap bounds the queue in bytes exactly as for a
    // latched stall. Resuming only clears the flag: a latch taken before it clears on progress as ever (R40).
    void setConsumerSuspended(bool suspended);
    bool consumerSuspended() const;

    uint64_t pendingFrames() const;
    // Consumer latched stalled, or suspended in the host's move loop (#67) (Sprint 7 Task 1b reads it to bound the
    // pending BYTES too).
    bool latched() const;
    uint32_t waiters() const; // producers currently inside the wait (tests)
    Stats takeStats(); // returns and clears the counters
    // Cumulative time spent inside Waited/TimedOut waits, in nanoseconds, NEVER cleared. Stats::waitMs is only
    // reachable through takeStats(), which clears and belongs to the 60-present [gs-gl stats] printer; the
    // pc-sampler reads this instead so the two instruments do not race each other (research/29 section 4 item 7).
    uint64_t waitNsTotal() const { return m_waitNsTotal.load(std::memory_order_relaxed); }

private:
    mutable std::mutex m_mutex;
    std::condition_variable m_cv;
    uint32_t m_maxPendingFrames;
    std::chrono::milliseconds m_waitCap;
    uint64_t m_recorded = 0;
    uint64_t m_replayed = 0;
    bool m_consumerStalled = false;
    uint64_t m_progressAtLatch = 0;
    uint32_t m_waiters = 0;
    std::atomic<uint64_t> m_progress{0};
    std::atomic<uint64_t> m_waitNsTotal{0};
    bool m_released = false;
    bool m_suspended = false; // #67: the consumer's thread is inside the host's modal move loop
    Stats m_stats{};
};

// Sprint 7 Task 1b (audit 2026-09-17 section 2.2 F3, gap G7): the byte side of the same queue.
// GsFrameBackpressure bounds how many guest FRAMES may be recorded ahead of the replay, but once
// the consumer latches stalled (a title-bar drag holds the GL thread in the modal size-move loop
// for as long as the mouse is down) frames stop waiting and the pending command buffer used to
// grow for the whole drag (the ~15 GB working set KNOWN section 4 recorded before Sprint 7).
// GsPendingCap bounds it in bytes instead.
//
// Policy: while the consumer is latched, a command that carries no state (draw work: it will be
// re-submitted next guest frame) is dropped once the pending bytes reach the cap; a command that
// carries state (an upload, a transfer, a CLUT load, a VRAM write, anything the replay cannot
// reconstruct from the queue alone) is never dropped -- from Sprint 10 Goal 11 (Q6) on it is
// ABSORBED past the cap instead of pended: GsStallCoalescer (gs_stall_coalescer.h) remembers where
// it wrote and re-anchors the replay from the game thread's VRAM when the latch clears, so the
// queue stays at the cap plus one command for as long as the stall lasts and no drag can corrupt
// what the game draws after it. Nothing is ever dropped or absorbed while the consumer is live.
// capBytes == 0 is unbounded (the pre-1b behaviour, and the coalescer never engages);
// PS2X_GS_PENDING_CAP_MB sets it, default 64 MB.
//
// The counters are atomic: admit() runs on the recorder's thread (under the queue lock) and the
// stats line reads them on the render thread.
// Sprint 8 Goal 5, ruling R124: before Q6 the soft cap dropped only state-free draw work, so a
// replay that stayed latched for minutes still grew without bound on the state-carrying commands
// it could never drop (KNOWN's "GsPendingCap::admit keeps every state-carrying command unbounded",
// which ended in std::bad_alloc on the 8 GB VM). R124's answer was a HARD ceiling the RECORDER
// waits at: above hardCapBytes the recorder blocks until the replay drains the queue, whatever the
// latch says. It stays as the last line -- for a replay that is merely slow (unlatched, so the
// coalescer never engages) and for PS2X_GS_PENDING_CAP_MB=0 -- but a latched stall no longer
// reaches it. mustWait() is the pure predicate; the waiting itself lives in GSGlBackend::record,
// which owns the queue mutex and the condition variable the replay notifies.
// hardCapBytes == 0 is no ceiling; PS2X_GS_PENDING_HARD_CAP_MB sets it, default 1024 MB.
class GsPendingCap
{
public:
    static constexpr uint64_t kDefaultCapMb = 64u;
    static constexpr uint64_t kDefaultHardCapMb = 1024u;

    explicit GsPendingCap(uint64_t capBytes, uint64_t hardCapBytes = 0u);

    // Returns false when the command must NOT be pended. Before Q6 that was only ever draw work
    // at the cap while the consumer is latched (dropped; the next guest frame records it again).
    // Q6: at the cap while latched a state-carrying command is refused too -- the caller ABSORBS
    // it (GsStallCoalescer: the game VRAM already holds its effect) -- and from that first refusal
    // the cap is "absorbing": everything is refused until the latch clears, whatever the byte
    // count. (The replay's swap empties this accounting before the replay clears the latch, and a
    // state command admitted in that window would go into the queue AHEAD of the older writes
    // the re-anchor carries.) The caller asks reanchorDue() before admit(): true means the latch
    // has cleared with an absorption open, so it pushes the re-anchor and calls endAbsorbing()
    // first. Nothing is ever refused while the consumer is live and nothing is absorbing.
    bool admit(bool latched, bool carriesState, uint64_t bytes);
    // Token-waited commands (Reset, the blocking Readback): accounted, never refused.
    void admitWaited(uint64_t bytes);
    // Q6: true iff a cap is configured and the pending bytes have reached it.
    bool atCap() const;
    bool absorbing() const;
    bool reanchorDue(bool latched) const { return absorbing() && !latched; }
    void endAbsorbing();
    // Q6: something the caller discarded on its own (a Present while absorbing): counted with the
    // drops, which is what it is.
    void noteDropped(uint64_t bytes);
    // The replay took `bytes` of the pending buffer (call it with the buffer's size at the swap).
    void onReplayed(uint64_t bytes);

    // R124: true iff a hard ceiling is configured and the pending bytes have reached it. Pure and
    // independent of the latch -- an unlatched replay that is merely slow hits the same ceiling.
    bool mustWait() const;
    // One command waited at the ceiling (counted once per command, not once per wait slice).
    void noteHardWait();

    uint64_t bytes() const;    // pending, as accounted by admit()/onReplayed()
    uint64_t capBytes() const; // 0 = unbounded
    uint64_t hardCapBytes() const; // 0 = no ceiling
    uint64_t droppedCommands() const;
    uint64_t droppedBytes() const;
    uint64_t hardWaits() const;
    uint64_t absorptions() const;      // Q6: times the cap turned absorbing (one per latched stall that reached it)
    uint64_t absorbedCommands() const; // Q6: state-carrying commands refused for the coalescer
    uint64_t absorbedBytes() const;

    // nullptr (unset) or an unparsable value -> fallbackMb; "0" -> 0 (unbounded); "<n>" -> n.
    static uint64_t parseCapMb(const char *value, uint64_t fallbackMb = kDefaultCapMb);

private:
    uint64_t m_capBytes;
    uint64_t m_hardCapBytes;
    std::atomic<uint64_t> m_bytes{0};
    std::atomic<uint64_t> m_droppedCommands{0};
    std::atomic<uint64_t> m_droppedBytes{0};
    std::atomic<uint64_t> m_hardWaits{0};
    // Q6. Written and read on the recorder's thread under the queue lock; atomic for the stats line.
    std::atomic<bool> m_absorbing{false};
    std::atomic<uint64_t> m_absorptions{0};
    std::atomic<uint64_t> m_absorbedCommands{0};
    std::atomic<uint64_t> m_absorbedBytes{0};
};
