#include "runtime/gs/gs_frame_backpressure.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>

uint32_t GsFrameBackpressure::parseMaxPendingFrames(const char *value, uint32_t fallback)
{
    if (!value || *value == 0)
        return fallback;
    char *end = nullptr;
    const unsigned long parsed = std::strtoul(value, &end, 10);
    // strtoul accepts a leading '-' (and wraps it): only plain decimal digits count.
    if (*value < '0' || *value > '9' || !end || *end != 0 || parsed > 0xFFFFul)
    {
        static bool s_logged = false;
        if (!s_logged)
        {
            s_logged = true;
            std::fprintf(stderr, "[gs-gl] PS2X_GS_MAX_PENDING_FRAMES=%s is not a decimal in 0..65535; using %u\n", value, fallback);
        }
        return fallback;
    }
    return static_cast<uint32_t>(parsed);
}

GsFrameBackpressure::GsFrameBackpressure(uint32_t maxPendingFrames, std::chrono::milliseconds waitCap)
    : m_maxPendingFrames(maxPendingFrames), m_waitCap(waitCap)
{
}

void GsFrameBackpressure::setMaxPendingFrames(uint32_t maxPendingFrames)
{
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_maxPendingFrames = maxPendingFrames;
    }
    m_cv.notify_all();
}

uint32_t GsFrameBackpressure::maxPendingFrames() const
{
    std::lock_guard<std::mutex> lock(m_mutex);
    return m_maxPendingFrames;
}

GsFrameBackpressure::WaitResult GsFrameBackpressure::frameRecorded()
{
    std::unique_lock<std::mutex> lock(m_mutex);
    ++m_recorded;
    ++m_stats.frames;
    const auto withinBound = [this]
    { return m_released || m_maxPendingFrames == 0u || m_recorded - m_replayed <= m_maxPendingFrames; };
    if (withinBound())
        return WaitResult::NotNeeded;
    // #67: the consumer's thread is in the host's modal move loop; it cannot replay until the loop ends, so the
    // frame does not wait for it (and no latch is taken: this is not a stall, it has a known end).
    if (m_suspended)
    {
        ++m_stats.skipped;
        return WaitResult::Skipped;
    }
    uint64_t lastProgress = m_progress.load(std::memory_order_relaxed);
    if (m_consumerStalled)
    {
        // R40: the latch clears as soon as the consumer shows any sign of life, not only when a
        // replay completes.
        if (lastProgress == m_progressAtLatch)
        {
            ++m_stats.skipped;
            return WaitResult::Skipped;
        }
        m_consumerStalled = false;
        ++m_stats.unlatched;
    }
    // Wait in slices so the heartbeat (a lock-free counter, no notify) is seen; the cap bounds the
    // time WITHOUT progress, so a live consumer replaying a big batch keeps the wait armed.
    const auto slice = std::clamp(m_waitCap / 8, std::chrono::milliseconds(1), std::chrono::milliseconds(50));
    const auto t0 = std::chrono::steady_clock::now();
    auto lastProgressTime = t0;
    ++m_waiters;
    WaitResult result = WaitResult::Waited;
    for (;;)
    {
        if (m_cv.wait_for(lock, slice, [&] { return withinBound() || m_suspended; }))
        {
            if (!withinBound())
                result = WaitResult::Skipped; // #67: woken by the move loop, not by the consumer
            break;
        }
        const auto now = std::chrono::steady_clock::now();
        const uint64_t progress = m_progress.load(std::memory_order_relaxed);
        if (progress != lastProgress)
        {
            lastProgress = progress;
            lastProgressTime = now;
        }
        else if (now - lastProgressTime >= m_waitCap)
        {
            result = WaitResult::TimedOut;
            break;
        }
    }
    --m_waiters;
    const auto waited = std::chrono::steady_clock::now() - t0;
    m_stats.waitMs += std::chrono::duration<double, std::milli>(waited).count();
    m_waitNsTotal.fetch_add(static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(waited).count()),
                            std::memory_order_relaxed);
    if (result == WaitResult::Waited)
    {
        ++m_stats.waits;
        return result;
    }
    if (result == WaitResult::Skipped)
    {
        ++m_stats.skipped;
        return result;
    }
    m_consumerStalled = true;
    m_progressAtLatch = lastProgress;
    ++m_stats.timeouts;
    return result;
}

uint64_t GsFrameBackpressure::recordedFrames() const
{
    std::lock_guard<std::mutex> lock(m_mutex);
    return m_recorded;
}

void GsFrameBackpressure::framesReplayed(uint64_t recordedCount)
{
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        if (recordedCount <= m_replayed)
            return;
        m_replayed = recordedCount;
        if (m_consumerStalled)
        {
            m_consumerStalled = false;
            ++m_stats.unlatched;
        }
    }
    m_cv.notify_all();
}

void GsFrameBackpressure::release()
{
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_released = true;
    }
    m_cv.notify_all();
}

void GsFrameBackpressure::setConsumerSuspended(bool suspended)
{
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_suspended = suspended;
    }
    // A producer already inside the wait re-checks its predicate now, not at the next slice.
    m_cv.notify_all();
}

bool GsFrameBackpressure::consumerSuspended() const
{
    std::lock_guard<std::mutex> lock(m_mutex);
    return m_suspended;
}

uint32_t GsFrameBackpressure::waiters() const
{
    std::lock_guard<std::mutex> lock(m_mutex);
    return m_waiters;
}

uint64_t GsFrameBackpressure::pendingFrames() const
{
    std::lock_guard<std::mutex> lock(m_mutex);
    return m_recorded - m_replayed;
}

GsFrameBackpressure::Stats GsFrameBackpressure::takeStats()
{
    std::lock_guard<std::mutex> lock(m_mutex);
    Stats s = m_stats;
    m_stats = Stats{};
    return s;
}

bool GsFrameBackpressure::latched() const
{
    std::lock_guard<std::mutex> lock(m_mutex);
    return m_consumerStalled || m_suspended; // #67: a consumer in the move loop is stalled for the byte cap's purposes
}

// ---------------------------------------------------------------------------------------------
// GsPendingCap (Sprint 7 Task 1b)
// ---------------------------------------------------------------------------------------------

uint64_t GsPendingCap::parseCapMb(const char *value, uint64_t fallbackMb)
{
    if (!value || *value == 0)
        return fallbackMb;
    char *end = nullptr;
    const unsigned long long parsed = std::strtoull(value, &end, 10);
    // strtoull accepts a leading '-' (and wraps it): only plain decimal digits count. The upper
    // bound keeps the byte count (MB * 1024 * 1024) far away from a uint64_t overflow.
    if (*value < '0' || *value > '9' || !end || *end != 0 || parsed > 65535ull)
    {
        static bool s_logged = false;
        if (!s_logged)
        {
            s_logged = true;
            std::fprintf(stderr, "[gs-gl] PS2X_GS_PENDING_CAP_MB=%s is not a decimal in 0..65535; using %llu\n",
                         value, static_cast<unsigned long long>(fallbackMb));
        }
        return fallbackMb;
    }
    return static_cast<uint64_t>(parsed);
}

GsPendingCap::GsPendingCap(uint64_t capBytes, uint64_t hardCapBytes)
    : m_capBytes(capBytes), m_hardCapBytes(hardCapBytes)
{
}

// Sprint 8 Goal 5, ruling R124. A pure predicate, deliberately blind to the latch: the soft cap's
// drops only ever apply while the consumer is latched, but the unbounded growth this ceiling exists
// to stop is the state-carrying stream, which no latch state makes droppable. A replay that is
// merely slow reaches the ceiling the same way a latched one does, and the recorder waits either
// way. The caller (GSGlBackend::record) holds the queue mutex, so the load only has to be atomic,
// not ordered against anything else.
bool GsPendingCap::mustWait() const
{
    return m_hardCapBytes != 0u && m_bytes.load(std::memory_order_relaxed) >= m_hardCapBytes;
}

void GsPendingCap::noteHardWait() { m_hardWaits.fetch_add(1u, std::memory_order_relaxed); }

bool GsPendingCap::atCap() const
{
    return m_capBytes != 0u && m_bytes.load(std::memory_order_relaxed) >= m_capBytes;
}

void GsPendingCap::noteDropped(uint64_t bytes)
{
    m_droppedCommands.fetch_add(1u, std::memory_order_relaxed);
    m_droppedBytes.fetch_add(bytes, std::memory_order_relaxed);
}

// Sprint 10 Goal 11 (Q6): the verdict. Refuse everything while latched once the cap is reached,
// and keep refusing (absorbing) until the latch clears -- see the header for why the byte count
// alone cannot end it. A refused draw is a drop (as since Sprint 7); a refused state-carrying
// command is an absorption the caller hands to GsStallCoalescer.
bool GsPendingCap::admit(bool latched, bool carriesState, uint64_t bytes)
{
    if (latched && (m_absorbing.load(std::memory_order_relaxed) || atCap()))
    {
        if (!carriesState)
        {
            noteDropped(bytes);
            return false;
        }
        if (!m_absorbing.load(std::memory_order_relaxed))
        {
            m_absorbing.store(true, std::memory_order_relaxed);
            m_absorptions.fetch_add(1u, std::memory_order_relaxed);
        }
        m_absorbedCommands.fetch_add(1u, std::memory_order_relaxed);
        m_absorbedBytes.fetch_add(bytes, std::memory_order_relaxed);
        return false;
    }
    m_bytes.fetch_add(bytes, std::memory_order_relaxed);
    return true;
}

void GsPendingCap::admitWaited(uint64_t bytes) { m_bytes.fetch_add(bytes, std::memory_order_relaxed); }
bool GsPendingCap::absorbing() const { return m_absorbing.load(std::memory_order_relaxed); }
void GsPendingCap::endAbsorbing() { m_absorbing.store(false, std::memory_order_relaxed); }

void GsPendingCap::onReplayed(uint64_t bytes)
{
    // The replay takes the whole pending buffer, so the accounting never goes negative; clamp
    // anyway rather than wrap, since a lost byte would make the cap unreachable for good.
    uint64_t pending = m_bytes.load(std::memory_order_relaxed);
    while (true)
    {
        const uint64_t next = bytes >= pending ? 0u : pending - bytes;
        if (m_bytes.compare_exchange_weak(pending, next, std::memory_order_relaxed))
            return;
    }
}

uint64_t GsPendingCap::bytes() const { return m_bytes.load(std::memory_order_relaxed); }
uint64_t GsPendingCap::capBytes() const { return m_capBytes; }
uint64_t GsPendingCap::hardCapBytes() const { return m_hardCapBytes; }
uint64_t GsPendingCap::hardWaits() const { return m_hardWaits.load(std::memory_order_relaxed); }
uint64_t GsPendingCap::absorptions() const { return m_absorptions.load(std::memory_order_relaxed); }
uint64_t GsPendingCap::absorbedCommands() const { return m_absorbedCommands.load(std::memory_order_relaxed); }
uint64_t GsPendingCap::absorbedBytes() const { return m_absorbedBytes.load(std::memory_order_relaxed); }
uint64_t GsPendingCap::droppedCommands() const { return m_droppedCommands.load(std::memory_order_relaxed); }
uint64_t GsPendingCap::droppedBytes() const { return m_droppedBytes.load(std::memory_order_relaxed); }
