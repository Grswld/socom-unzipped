// Sprint 17 F0 Step 5b (LATER 43): the harness's screenshot PNG encode leaves the GL thread. The GL thread keeps
// the read (LoadImageFromScreen) and pushes the pixels; ShotQueue's worker encodes, writes and renames. These cases
// hold the worker inside a job on a latch, so what waits behind it is observable without a sleep.
#include "MiniTest.h"
#include "runtime/shot_queue.h"

#include <condition_variable>
#include <mutex>
#include <string>
#include <vector>

namespace
{
    // The writer every case installs: it records each job's destination in run order, and the first job whose
    // finalPath is "hold.png" blocks until release() -- the worker is then busy and every push queues behind it.
    struct HeldWriter
    {
        std::mutex mu;
        std::condition_variable cv;
        bool entered = false;
        bool released = false;
        std::vector<std::string> ran;   // "<finalPath>#<first byte>" per job, in the order the worker ran them

        bool write(ps2x::ShotJob &job)
        {
            std::unique_lock<std::mutex> lock(mu);
            ran.push_back(job.finalPath + "#" + std::to_string(job.bytes.empty() ? -1 : int(job.bytes[0])));
            if (job.finalPath == "hold.png")
            {
                entered = true;
                cv.notify_all();
                cv.wait(lock, [this] { return released; });
            }
            return true;
        }
        void waitEntered()
        {
            std::unique_lock<std::mutex> lock(mu);
            cv.wait(lock, [this] { return entered; });
        }
        void release()
        {
            std::lock_guard<std::mutex> lock(mu);
            released = true;
            cv.notify_all();
        }
    };

    ps2x::ShotJob job(const std::string &finalPath, uint8_t tag)
    {
        ps2x::ShotJob j;
        j.w = 1;
        j.h = 1;
        j.format = 7;   // raylib's PIXELFORMAT_UNCOMPRESSED_R8G8B8A8; the queue never reads it
        j.bytes = {tag, 0, 0, 255};
        j.tmpPath = finalPath + ".tmp.png";
        j.finalPath = finalPath;
        return j;
    }
}

void register_shot_queue_tests()
{
    MiniTest::Case("ShotQueue", [](TestCase &tc)
    {
        tc.Run("a held worker: three pushes to one file leave one waiting job, the newest", [](TestCase &t)
        {
            HeldWriter w;
            ps2x::ShotQueue q([&w](ps2x::ShotJob &j) { return w.write(j); });
            q.push(job("hold.png", 9));
            w.waitEntered();   // the worker is inside the first job: nothing below can start
            q.push(job("latest.png", 1));
            q.push(job("latest.png", 2));
            q.push(job("latest.png", 3));
            t.Equals(q.waiting(), size_t(1), "one job waits behind the held one");
            t.Equals(q.pushed(), uint64_t(4), "four pushes counted");
            t.Equals(q.replaced(), uint64_t(2), "the two older frames were replaced, not queued");
            t.Equals(q.written(), uint64_t(0), "nothing written while the worker is held");
            w.release();
            q.stop();   // drains what waits, then joins
            t.Equals(q.written(), uint64_t(2), "the held job and the newest frame were written");
            t.Equals(q.waiting(), size_t(0), "stop() returns with nothing waiting");
            const std::vector<std::string> want{"hold.png#9", "latest.png#3"};
            t.IsTrue(w.ran == want, "the jobs ran in push order, the newest frame in place of the older two");
        });

        tc.Run("another destination is never replaced (PS2X_HOST_SCREENSHOT's numbered files share the worker)",
               [](TestCase &t)
        {
            HeldWriter w;
            ps2x::ShotQueue q([&w](ps2x::ShotJob &j) { return w.write(j); });
            q.push(job("hold.png", 9));
            w.waitEntered();
            q.push(job("latest.png", 1));
            q.push(job("host_000.png", 4));
            q.push(job("latest.png", 2));
            q.push(job("host_001.png", 5));
            t.Equals(q.waiting(), size_t(3), "latest.png once, and both numbered shots");
            t.Equals(q.replaced(), uint64_t(1), "only the older latest.png frame was replaced");
            w.release();
            q.stop();
            t.Equals(q.written(), uint64_t(4), "all four remaining jobs written");
            const std::vector<std::string> want{"hold.png#9", "latest.png#2", "host_000.png#4", "host_001.png#5"};
            t.IsTrue(w.ran == want, "the newest latest.png frame keeps the older one's place in the order");
        });

        tc.Run("stop() without a push starts no worker; a push after stop() is refused", [](TestCase &t)
        {
            int calls = 0;
            ps2x::ShotQueue q([&calls](ps2x::ShotJob &) { ++calls; return true; });
            t.IsFalse(q.running(), "no push, no worker thread");
            q.stop();
            t.IsFalse(q.push(job("latest.png", 1)), "a push after stop() returns false");
            t.Equals(q.waiting(), size_t(0), "and leaves nothing waiting");
            t.Equals(calls, 0, "the writer never ran");
        });

        tc.Run("a writer that fails is counted as failed, not written", [](TestCase &t)
        {
            ps2x::ShotQueue q([](ps2x::ShotJob &) { return false; });
            t.IsTrue(q.push(job("latest.png", 1)), "the push is accepted");
            q.stop();
            t.Equals(q.written(), uint64_t(0), "nothing written");
            t.Equals(q.failed(), uint64_t(1), "one failure counted");
        });
    });
}
