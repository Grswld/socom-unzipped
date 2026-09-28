#pragma once
// Sprint 17 F0 Step 5b (LATER 43): the harness's screenshots, encoded off the GL thread.
//
// research/73 measured PS2X_HOST_SCREENSHOT_LATEST's PNG encode (ExportImage -> stbi_zlib_compress) at ~169 ms of
// every second of the GL replay thread, 17 % of it, inside every gate's FRAME number. The GL thread still reads the
// frame (LoadImageFromScreen is a GL call and must stay there); it pushes the pixels here, and one worker thread
// runs the writer (the encode, the write, the rename) and frees them.
//
// The policy: at most one job waits per destination file. A newer job for a file that already has one waiting
// REPLACES it in place (the newest frame wins, and the harness's latest.png never falls behind); a job for another
// file queues behind (PS2X_HOST_SCREENSHOT's numbered files share the worker and are never dropped). A job the
// worker is already running is not "waiting" and is never replaced. No raylib types: the writer is the caller's,
// so the queue is testable without a window (ps2xTest/src/shot_queue_tests.cpp).
#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace ps2x
{
    // One frame to write: the pixels as read on the GL thread, and where they go. The writer encodes to tmpPath and
    // renames it over finalPath (the atomic replace the harness relies on); an empty tmpPath writes finalPath itself.
    struct ShotJob
    {
        int w = 0;
        int h = 0;
        int format = 0;   // the caller's pixel format code (raylib's PixelFormat in the runtime)
        std::vector<uint8_t> bytes;
        std::string tmpPath;
        std::string finalPath;
    };

    class ShotQueue
    {
    public:
        // Runs on the worker thread, one job at a time, in push order; true when the file was written.
        using Writer = std::function<bool(ShotJob &)>;

        explicit ShotQueue(Writer writer) : m_writer(std::move(writer)) {}
        ~ShotQueue() { stop(); }
        ShotQueue(const ShotQueue &) = delete;
        ShotQueue &operator=(const ShotQueue &) = delete;

        // Hands a job to the worker, starting it on the first push. False after stop(): the job is dropped.
        bool push(ShotJob job)
        {
            std::lock_guard<std::mutex> lock(m_mu);
            if (m_stopping)
                return false;
            m_pushed.fetch_add(1, std::memory_order_relaxed);
            bool replacedOne = false;
            for (ShotJob &waiting : m_waiting)
            {
                if (waiting.finalPath == job.finalPath)
                {
                    waiting = std::move(job);
                    replacedOne = true;
                    break;
                }
            }
            if (replacedOne)
                m_replaced.fetch_add(1, std::memory_order_relaxed);
            else
                m_waiting.push_back(std::move(job));
            if (!m_worker.joinable())
                m_worker = std::thread([this] { workerLoop(); });
            m_cv.notify_one();
            return true;
        }

        // Refuses further pushes, lets the worker finish every waiting job, and joins it. Idempotent; call it from
        // the thread that pushes (the GL thread), never from the writer.
        void stop()
        {
            {
                std::lock_guard<std::mutex> lock(m_mu);
                m_stopping = true;
            }
            m_cv.notify_all();
            if (m_worker.joinable())
                m_worker.join();
        }

        size_t waiting() const
        {
            std::lock_guard<std::mutex> lock(m_mu);
            return m_waiting.size();
        }
        bool running() const
        {
            std::lock_guard<std::mutex> lock(m_mu);
            return m_worker.joinable();
        }
        uint64_t pushed() const { return m_pushed.load(std::memory_order_relaxed); }
        uint64_t replaced() const { return m_replaced.load(std::memory_order_relaxed); }
        uint64_t written() const { return m_written.load(std::memory_order_relaxed); }
        uint64_t failed() const { return m_failed.load(std::memory_order_relaxed); }

    private:
        void workerLoop()
        {
            for (;;)
            {
                ShotJob job;
                {
                    std::unique_lock<std::mutex> lock(m_mu);
                    m_cv.wait(lock, [this] { return m_stopping || !m_waiting.empty(); });
                    if (m_waiting.empty())
                        return;   // stopping, and drained
                    job = std::move(m_waiting.front());
                    m_waiting.pop_front();
                }
                const bool ok = m_writer ? m_writer(job) : false;
                (ok ? m_written : m_failed).fetch_add(1, std::memory_order_relaxed);
            }
        }

        Writer m_writer;
        mutable std::mutex m_mu;
        std::condition_variable m_cv;
        std::deque<ShotJob> m_waiting;
        bool m_stopping = false;
        std::thread m_worker;
        std::atomic<uint64_t> m_pushed{0};
        std::atomic<uint64_t> m_replaced{0};
        std::atomic<uint64_t> m_written{0};
        std::atomic<uint64_t> m_failed{0};
    };
}
