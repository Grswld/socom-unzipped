// sceInetInterfaceControl code 0x200 (socom2_libnetb.cpp) must MOVE when traffic arrives. SOCOM II
// resets its "last network activity" timestamp only when this word changes; a constant pinned the
// online player in place (Sprint 4, abf35bb). PS2X_SOCOM2_NET_STATS=0 restores the constant on purpose.
#include "MiniTest.h"
#include "launcher/launcher_config.h"
#include "ps2_runtime.h"
#include "ps2x/exit_codes.h"
#include "runtime/ee_scheduler.h"
#include "socom2_hostnet.h"
#include "socom2_libnetb.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#ifndef _WIN32
// F6: the EINTR case below needs a raw socket, a real signal and a real timer.
#include <arpa/inet.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
#endif

namespace socom2_hostnet
{
    // Not in socom2_hostnet.h: the PS2X_SOCOM2_SERVER parse used by loadHosts(), exposed for this
    // test so the value can be passed straight in instead of poking the process environment and
    // re-running init() (init() is one-shot, so an env-based test would depend on case order).
    uint32_t parseServerAddress(const std::string &value);

    // Also not in socom2_hostnet.h, for the same reason: the Winsock/BSD error split. Every guest
    // error code the table returns is produced by these two, so they are the one piece of the
    // platform half a test can pin down without a network.
    int hostnetLastError();
    bool hostnetWouldBlock(int err);

    // Sprint 13 V8, also not in the header: what PS2X_SOCOM2_SERVER becomes, and the table half of it.
    uint32_t serverForKnob(const char *value, std::string &refusal);
    void testApplyServer(const char *value);

#ifndef _WIN32
    // F6, also not in the header: the poll(2) wrapper that resumes across EINTR. A signal
    // is the only way to observe the retry, so the test drives this directly -- the public
    // poll() would answer "writable" at once on any socket and never reach the wait.
    int hostnetPollRestarting(int nativeFd, short events, short *revents, int timeoutMs);
#endif
}

namespace
{
    constexpr uint32_t kSendAddr = 0x1000u;
    constexpr uint32_t kRecvAddr = 0x2000u;
    constexpr uint32_t kRecvSize = 0x40u;

    void setNetStatsEnv(const char *value)
    {
#ifdef _WIN32
        _putenv_s("PS2X_SOCOM2_NET_STATS", value ? value : "");
#else
        if (value)
            setenv("PS2X_SOCOM2_NET_STATS", value, 1);
        else
            unsetenv("PS2X_SOCOM2_NET_STATS");
#endif
        socom2_libnetb::testResetKnobs();
    }

    // sceInetInterfaceControl(id 1, code 0x200, len 4) through the RPC dispatcher; the word is p[3].
    uint32_t queryStatsWord(std::vector<uint8_t> &rdram)
    {
        const uint32_t send[3] = {1u, 0x200u, 4u};
        std::memcpy(rdram.data() + kSendAddr, send, sizeof(send));
        socom2_libnetb::call(rdram.data(), 9u, kSendAddr, sizeof(send), kRecvAddr, kRecvSize);
        uint32_t word = 0u;
        std::memcpy(&word, rdram.data() + kRecvAddr + 12u, sizeof(word));
        return word;
    }

    // One UDP datagram over loopback, received through the host socket table every libnetb receive
    // path uses. Returns the byte count recvFrom reported (<= 0 on failure).
    int deliverPacket()
    {
        using namespace socom2_hostnet;
        if (!init())
            return -1;
        const int rx = createSocket(Proto::Udp);
        const int tx = createSocket(Proto::Udp);
        int got = -1;
        Endpoint local;
        if (rx >= 0 && tx >= 0 && bindSocket(rx, Endpoint{0x7f000001u, 0u}) == 0 && localName(rx, &local) == 0)
        {
            static const char kPayload[] = "moves";
            if (sendTo(tx, kPayload, sizeof(kPayload), local) == static_cast<int>(sizeof(kPayload)))
            {
                const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
                while (readable(rx) <= 0 && std::chrono::steady_clock::now() < deadline)
                    std::this_thread::sleep_for(std::chrono::milliseconds(2));
                char buf[64];
                Endpoint from;
                got = recvFrom(rx, buf, sizeof(buf), &from);
            }
        }
        if (rx >= 0)
            closeSocket(rx);
        if (tx >= 0)
            closeSocket(tx);
        return got;
    }
}

namespace
{
    // ---- #34 (Sprint 13 V7), research/29 shape 2 ------------------------------------------------------------------
    // A peer that stops sending held the EE executor inside waitReadable for up to 10 s: no guest instruction ran, no
    // VBlank was delivered, no frame was drawn -- the 3-17 s online freeze. Here a guest "main" thread issues
    // sceInetRecvFrom through socom2_libnetb::rpcFromGuest (the path socom2_MsifCall takes) on a loopback UDP socket,
    // and a lower-priority "ticker" thread stamps the host time on every VBlank. While the recv is outstanding the
    // executor must keep delivering VBlanks and running the ticker; the recv must still end the way the game asked.
    constexpr uint32_t kParkMainPc = 0x00170000u;
    constexpr uint32_t kParkAfterPc = 0x00170010u;
    constexpr uint32_t kParkTickerPc = 0x00170020u;
    constexpr uint32_t kParkBufAddr = 0x3000u;   // send == recv, as the game's CallRpc (0x245ad8) passes them
    constexpr uint32_t kParkBufSize = 0x80u;
    constexpr uint32_t kParkClientAddr = 0x3400u;
    constexpr int32_t kErrTimeout = -500;

    struct ParkRun
    {
        int32_t cid = 0;
        int32_t timeoutMs = 0;
        std::chrono::steady_clock::time_point start{};
        std::chrono::steady_clock::time_point end{};
        std::vector<std::chrono::steady_clock::time_point> ticks;
        int32_t result = 0;
        std::string payload;
        bool done = false;
    };
    ParkRun g_park;

    void setGpr(R5900Context *ctx, int reg, uint32_t value)
    {
        ctx->r[reg] = _mm_set_epi64x(0, static_cast<int64_t>(value));
    }

    void parkTicker(uint8_t *, R5900Context *ctx, PS2Runtime *runtime)
    {
        g_park.ticks.push_back(std::chrono::steady_clock::now());
        EeScheduler &ee = runtime->eeScheduler();
        ctx->pc = kParkTickerPc;
        ee.waitVSync(ee.currentVSyncTick());
    }

    void parkMain(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        EeScheduler &ee = runtime->eeScheduler();
        EeThreadCreateParams ticker{};
        ticker.entry = kParkTickerPc;
        ticker.stack = 0x1E000u;
        ticker.stackSize = 0x1000u;
        ticker.priority = 100;   // lower than main's 0: it runs only while main is not runnable
        ee.startThread(ee.createThread(ticker), 0u, *ctx, false);

        // sceInetRecvFrom(cid, flags 0, len 64, timeout): SEND p[0..3] (docs/research/10-libnetb-rpc.md, fno 0xd)
        const uint32_t send[4] = {static_cast<uint32_t>(g_park.cid), 0u, 64u, static_cast<uint32_t>(g_park.timeoutMs)};
        std::memcpy(rdram + kParkBufAddr, send, sizeof(send));
        setGpr(ctx, 4, kParkClientAddr);
        setGpr(ctx, 5, 0xdu);
        setGpr(ctx, 6, 0u);
        setGpr(ctx, 7, kParkBufAddr);
        setGpr(ctx, 8, 0x10u);
        setGpr(ctx, 9, kParkBufAddr);
        setGpr(ctx, 10, kParkBufSize);
        setGpr(ctx, 31, kParkAfterPc);
        g_park.start = std::chrono::steady_clock::now();
        socom2_libnetb::rpcFromGuest(rdram, ctx, runtime);
    }

    void parkAfter(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        g_park.end = std::chrono::steady_clock::now();
        std::memcpy(&g_park.result, rdram + kParkBufAddr, sizeof(g_park.result));
        if (g_park.result > 0 && g_park.result <= 64)
            g_park.payload.assign(reinterpret_cast<const char *>(rdram + kParkBufAddr + 0x1cu), static_cast<size_t>(g_park.result));
        g_park.done = true;
        ctx->pc = 0u;
        runtime->requestStop();
    }

    // sceInetCreate(type 0 = datagram, no local port), then bound to loopback through the host table (cid = host
    // descriptor + 1). Returns the cid (<= 0 on failure) and the socket's endpoint.
    int32_t openLoopbackCid(std::vector<uint8_t> &rdram, socom2_hostnet::Endpoint *local)
    {
        const uint32_t create[8] = {};
        std::memcpy(rdram.data() + kSendAddr, create, sizeof(create));
        socom2_libnetb::call(rdram.data(), 1u, kSendAddr, sizeof(create), kRecvAddr, kRecvSize);
        int32_t cid = 0;
        std::memcpy(&cid, rdram.data() + kRecvAddr, sizeof(cid));
        if (cid <= 0)
            return cid;
        if (socom2_hostnet::bindSocket(cid - 1, socom2_hostnet::Endpoint{0x7f000001u, 0u}) != 0 ||
            socom2_hostnet::localName(cid - 1, local) != 0)
            return -1;
        return cid;
    }

    void closeCid(std::vector<uint8_t> &rdram, int32_t cid)
    {
        const uint32_t close[2] = {static_cast<uint32_t>(cid), 0u};
        std::memcpy(rdram.data() + kSendAddr, close, sizeof(close));
        socom2_libnetb::call(rdram.data(), 3u, kSendAddr, sizeof(close), kRecvAddr, kRecvSize);
    }

    // Runs main + ticker on a real EE executor until main's recv returns (a watchdog stops a run that never does).
    void runParkedRecv(std::vector<uint8_t> &rdram, PS2Runtime &runtime)
    {
        runtime.registerFunction(kParkMainPc, parkMain);
        runtime.registerFunction(kParkAfterPc, parkAfter);
        runtime.registerFunction(kParkTickerPc, parkTicker);
        std::atomic<bool> finished{false};
        std::thread watchdog([&finished, &runtime]
        {
            const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(20);
            while (!finished.load() && std::chrono::steady_clock::now() < deadline)
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
            if (!finished.load())
                runtime.requestStop();
        });
        R5900Context mainContext{};
        mainContext.pc = kParkMainPc;
        runtime.eeScheduler().reset(rdram.data(), mainContext);
        runtime.eeScheduler().run();
        finished.store(true);
        watchdog.join();
    }

    // The ticker stamps inside the recv's window, and the longest stretch of that window with no VBlank run at all.
    size_t ticksDuringWait(const ParkRun &run)
    {
        size_t n = 0;
        for (const auto &tick : run.ticks)
            if (tick >= run.start && tick <= run.end)
                ++n;
        return n;
    }

    long long longestGapMs(const ParkRun &run)
    {
        std::vector<std::chrono::steady_clock::time_point> points{run.start};
        for (const auto &tick : run.ticks)
            if (tick >= run.start && tick <= run.end)
                points.push_back(tick);
        points.push_back(run.end);
        long long longest = 0;
        for (size_t i = 1; i < points.size(); ++i)
            longest = std::max<long long>(longest,
                std::chrono::duration_cast<std::chrono::milliseconds>(points[i] - points[i - 1]).count());
        return longest;
    }

    long long elapsedMs(const ParkRun &run)
    {
        return std::chrono::duration_cast<std::chrono::milliseconds>(run.end - run.start).count();
    }
}

namespace
{
    // ---- the receive path's bounds (socom2_libnetb.cpp) -----------------------------------------------------------
    // Guest RAM plus a watched margin past its end: a receive that stays inside RAM leaves the margin as it was.
    constexpr uint32_t kGuardBytes = 0x1000u;
    constexpr uint8_t kGuardByte = 0xA5u;
    constexpr int32_t kErrInvalidBuffer = -0x200;
    constexpr uint32_t kBoundRa = 0x00171000u;
    constexpr uint32_t kHandleAddr = 0x5000u;   // a libnetb_ex platform handle; +8 holds the cid

    struct GuardedRam
    {
        std::vector<uint8_t> bytes = std::vector<uint8_t>(PS2_RAM_SIZE + kGuardBytes, 0u);
        GuardedRam() { std::memset(bytes.data() + PS2_RAM_SIZE, kGuardByte, kGuardBytes); }
        uint8_t *data() { return bytes.data(); }
        bool marginUntouched() const
        {
            for (uint32_t i = 0; i < kGuardBytes; ++i)
                if (bytes[PS2_RAM_SIZE + i] != kGuardByte)
                    return false;
            return true;
        }
        int32_t word(uint32_t at) const
        {
            int32_t v = 0;
            std::memcpy(&v, bytes.data() + at, sizeof(v));
            return v;
        }
    };

    uint8_t payloadByte(uint32_t i) { return static_cast<uint8_t>(0x30u + (i % 64u)); }

    // A loopback datagram cid with one datagram of `n` bytes waiting on it (cid <= 0 on failure).
    int32_t cidWithDatagram(std::vector<uint8_t> &ram, uint32_t n)
    {
        socom2_hostnet::Endpoint local{};
        const int32_t cid = openLoopbackCid(ram, &local);
        if (cid <= 0)
            return cid;
        std::vector<uint8_t> payload(n);
        for (uint32_t i = 0; i < n; ++i)
            payload[i] = payloadByte(i);
        const int tx = socom2_hostnet::createSocket(socom2_hostnet::Proto::Udp);
        const int sent = tx >= 0 ? socom2_hostnet::sendTo(tx, payload.data(), n, local) : -1;
        if (tx >= 0)
            socom2_hostnet::closeSocket(tx);
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
        while (socom2_hostnet::readable(cid - 1) <= 0 && std::chrono::steady_clock::now() < deadline)
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        return sent == static_cast<int>(n) ? cid : -1;
    }

    bool payloadAt(const GuardedRam &ram, uint32_t at, uint32_t n)
    {
        for (uint32_t i = 0; i < n; ++i)
            if (ram.bytes[at + i] != payloadByte(i))
                return false;
        return true;
    }

    // sceInetRecv (fno 4) or sceInetRecvFrom (fno 0xd) with timeout 0: SEND p[0] cid, p[1] flags, p[2] len, p[3]
    // timeout at kSendAddr; the receive buffer is the caller's (recv, recvSize).
    void recvRpc(GuardedRam &ram, uint32_t fno, int32_t cid, uint32_t len, uint32_t recv, uint32_t recvSize)
    {
        const uint32_t send[4] = {static_cast<uint32_t>(cid), 0u, len, 0u};
        std::memcpy(ram.data() + kSendAddr, send, sizeof(send));
        socom2_libnetb::call(ram.data(), fno, kSendAddr, sizeof(send), recv, recvSize);
    }

    // exTcpRecv(cd, buf, handle, dst, len, flagsOut) / exUdpRecv(handle, dst, maxlen, flags*, addr*, port*, len*,
    // result*) through their register ABI; returns v0.
    uint32_t exTcp(GuardedRam &ram, int32_t cid, uint32_t dst, uint32_t len)
    {
        const uint32_t handle[4] = {1u, 0u, static_cast<uint32_t>(cid), 0u};
        std::memcpy(ram.data() + kHandleAddr, handle, sizeof(handle));
        R5900Context ctx{};
        setGpr(&ctx, 6, kHandleAddr);
        setGpr(&ctx, 7, dst);
        setGpr(&ctx, 8, len);
        setGpr(&ctx, 9, 0x5100u);
        setGpr(&ctx, 31, kBoundRa);
        socom2_libnetb::exTcpRecv(ram.data(), &ctx, nullptr);
        return static_cast<uint32_t>(_mm_extract_epi32(ctx.r[2], 0));
    }

    uint32_t exUdp(GuardedRam &ram, int32_t cid, uint32_t dst, uint32_t maxlen)
    {
        const uint32_t handle[4] = {0u, 0u, static_cast<uint32_t>(cid), 0u};
        std::memcpy(ram.data() + kHandleAddr, handle, sizeof(handle));
        R5900Context ctx{};
        setGpr(&ctx, 4, kHandleAddr);
        setGpr(&ctx, 5, dst);
        setGpr(&ctx, 6, maxlen);
        setGpr(&ctx, 7, 0x5100u);
        setGpr(&ctx, 8, 0x5110u);
        setGpr(&ctx, 9, 0x5120u);
        setGpr(&ctx, 10, 0x5124u);
        setGpr(&ctx, 11, 0x5128u);
        setGpr(&ctx, 31, kBoundRa);
        socom2_libnetb::exUdpRecv(ram.data(), &ctx, nullptr);
        return static_cast<uint32_t>(_mm_extract_epi32(ctx.r[2], 0));
    }

    template <typename Body>
    std::string captureStdout(Body body)
    {
        std::ostringstream sink;
        std::streambuf *old = std::cout.rdbuf(sink.rdbuf());
        body();
        std::cout.rdbuf(old);
        return sink.str();
    }
}

void register_socom2_libnetb_tests()
{
    MiniTest::Case("SOCOM2Libnetb", [](TestCase &tc)
    {
        tc.Run("InterfaceControl 0x200 moves when a packet is delivered", [](TestCase &t)
        {
            setNetStatsEnv(nullptr); // the shipped default: stats on
            std::vector<uint8_t> rdram(PS2_RAM_SIZE, 0u);
            const uint32_t before = queryStatsWord(rdram);
            const int n = deliverPacket();
            t.IsTrue(n > 0, "a loopback UDP datagram should be received");
            const uint32_t after = queryStatsWord(rdram);
            t.IsTrue(after != before, "code 0x200 must change after a delivered packet (a constant pins the online player)");
            t.Equals(after - before, static_cast<uint32_t>(n), "code 0x200 should advance by the bytes received");
        });

        tc.Run("InterfaceControl 0x200 stays constant with PS2X_SOCOM2_NET_STATS=0", [](TestCase &t)
        {
            setNetStatsEnv("0");
            std::vector<uint8_t> rdram(PS2_RAM_SIZE, 0u);
            const uint32_t before = queryStatsWord(rdram);
            const int n = deliverPacket();
            t.IsTrue(n > 0, "a loopback UDP datagram should be received");
            const uint32_t after = queryStatsWord(rdram);
            t.Equals(after, before, "PS2X_SOCOM2_NET_STATS=0 must keep code 0x200 constant (the defect's reproduction knob)");
            setNetStatsEnv(nullptr);
        });

        // A hosted server is reached by DNS name, so PS2X_SOCOM2_SERVER must accept one. The
        // inet_pton-only parse dropped every non-numeric value and left the retail hostnames
        // pointed at the 127.0.0.1 default -- silently, which reads as "online is just broken".
        // The host socket table, end to end, through the public API only -- create, bind to an
        // ephemeral loopback port, read the port back, send a datagram to itself, wait for it to
        // become readable, receive it, close. On Windows this is the Winsock half that has always
        // shipped and it passes today; it is here because the same case has to pass on Linux once
        // socom2_hostnet.cpp grows its BSD half, and there it does not even compile yet (Task 8
        // watches it in the VM). No platform guard: this is the contract, not an implementation.
        tc.Run("hostnet UDP loopback round-trip through the public socket table", [](TestCase &t)
        {
            using namespace socom2_hostnet;
            t.IsTrue(init(), "hostnet init must succeed");

            const int fd = createSocket(Proto::Udp);
            t.IsTrue(fd >= 0, "createSocket(Udp) must return a table descriptor");
            if (fd < 0)
                return;

            t.Equals(bindSocket(fd, Endpoint{0x7f000001u, 0u}), 0, "bind to 127.0.0.1 port 0 must succeed");

            Endpoint bound{};
            t.Equals(localName(fd, &bound), 0, "localName must report the bound address");
            t.IsTrue(bound.port != 0, "port 0 must come back as the ephemeral port the OS chose");

            static const char kPayload[] = "hostnet";
            const int sent = sendTo(fd, kPayload, sizeof(kPayload), Endpoint{0x7f000001u, bound.port});
            t.Equals(sent, static_cast<int>(sizeof(kPayload)), "sendTo must report the whole datagram");

            const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
            while (readable(fd) <= 0 && std::chrono::steady_clock::now() < deadline)
                std::this_thread::sleep_for(std::chrono::milliseconds(2));
            t.IsTrue(readable(fd) > 0, "the socket must become readable within a second");

            char buf[32] = {};
            Endpoint from{};
            const int got = recvFrom(fd, buf, sizeof(buf), &from);
            t.Equals(got, static_cast<int>(sizeof(kPayload)), "recvFrom must return the bytes that were sent");
            t.Equals(std::memcmp(buf, kPayload, sizeof(kPayload)), 0, "the payload must come back unchanged");
            t.Equals(from.port, bound.port, "the datagram must be reported as coming from the sending port");

            t.Equals(closeSocket(fd), 0, "closeSocket must release the table entry");
        });

        // The platform error split, with no network in it: a non-blocking socket with nothing
        // queued reports the platform's would-block code (WSAEWOULDBLOCK on Windows, EWOULDBLOCK
        // / EAGAIN on Linux), and hostnetWouldBlock() is the one place that difference lives.
        // Without it mapError() would need a switch that says EWOULDBLOCK and EAGAIN separately,
        // which on Linux is the same value twice and does not compile.
        tc.Run("hostnetWouldBlock answers for the platform's would-block code", [](TestCase &t)
        {
            using namespace socom2_hostnet;
            t.IsTrue(init(), "hostnet init must succeed");

            const int fd = createSocket(Proto::Udp);
            t.IsTrue(fd >= 0, "createSocket(Udp) must return a table descriptor");
            if (fd < 0)
                return;
            t.Equals(bindSocket(fd, Endpoint{0x7f000001u, 0u}), 0, "bind to 127.0.0.1 port 0 must succeed");

            char buf[8] = {};
            Endpoint from{};
            const int got = recvFrom(fd, buf, sizeof(buf), &from);
            // F8: the platform error code belongs to THAT recvFrom, so it is read before any
            // assertion -- MiniTest reports through stdio, which is free to set errno itself.
            const int err = hostnetLastError();
            t.Equals(got, -11, "an empty non-blocking socket must map to the guest's EAGAIN");
            t.IsTrue(hostnetWouldBlock(err), "hostnetWouldBlock must recognise the code the empty socket just set");

            t.Equals(closeSocket(fd), 0, "closeSocket must release the table entry");
        });

        // F6: SA_RESTART does not restart poll(2). The Linux host sampler (PS2X_HOST_PROF) raises
        // SIGPROF on every thread ~200 times a second, so a bare ::poll() came back -1/EINTR and
        // mapError() turned that into -5 (EIO): switching the profiler on killed online play. The
        // wait must instead resume with the time it has left and end as a plain timeout.
        tc.Run("a poll wait interrupted by a signal times out rather than failing", [](TestCase &t)
        {
#ifdef _WIN32
            t.IsTrue(true, "skipped on Windows: EINTR is a POSIX condition -- Winsock select() never "
                           "returns it, and the SIGPROF sampler that provokes it is Linux-only");
            return;
#else
            using namespace socom2_hostnet;
            const int fd = ::socket(AF_INET, SOCK_DGRAM, 0);
            t.IsTrue(fd >= 0, "a UDP socket to wait on");
            if (fd < 0)
                return;
            sockaddr_in addr{};
            addr.sin_family = AF_INET;
            addr.sin_addr.s_addr = htonl(0x7f000001u);
            addr.sin_port = 0;
            ::bind(fd, reinterpret_cast<sockaddr *>(&addr), sizeof(addr));

            // A 10 ms repeating SIGALRM stands in for the sampler: the 100 ms wait below is
            // interrupted roughly ten times. The handler does nothing; being delivered is the point.
            struct sigaction sa;
            struct sigaction previous;
            std::memset(&sa, 0, sizeof(sa));
            std::memset(&previous, 0, sizeof(previous));
            sa.sa_handler = [](int) {};
            sigemptyset(&sa.sa_mask);
            sa.sa_flags = 0;   // SA_RESTART would change nothing here: poll() is never restarted
            ::sigaction(SIGALRM, &sa, &previous);
            itimerval timer{};
            timer.it_value.tv_usec = 10000;
            timer.it_interval.tv_usec = 10000;
            ::setitimer(ITIMER_REAL, &timer, nullptr);

            const auto start = std::chrono::steady_clock::now();
            short revents = 0;
            const int n = hostnetPollRestarting(fd, POLLIN, &revents, 100);
            const long long elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                                            std::chrono::steady_clock::now() - start)
                                            .count();

            const itimerval off{};
            ::setitimer(ITIMER_REAL, &off, nullptr);
            ::sigaction(SIGALRM, &previous, nullptr);
            ::close(fd);

            t.Equals(n, 0, "an interrupted wait on a socket with no data must report a timeout (0), "
                           "not an error the guest reads as a dead socket");
            t.IsTrue(elapsedMs >= 90, "and it must have waited out the 100 ms it was given, not "
                                      "returned at the first signal");
            t.IsTrue(elapsedMs < 2000, "and it must recompute the remaining time, not restart the "
                                       "full timeout on every signal");
#endif
        });

        tc.Run("PS2X_SOCOM2_SERVER accepts a DNS name as well as a numeric IP", [](TestCase &t)
        {
            // getaddrinfo needs Winsock up; init() does WSAStartup and is idempotent.
            t.IsTrue(socom2_hostnet::init(), "hostnet init must succeed");

            const uint32_t numeric = socom2_hostnet::parseServerAddress("192.0.2.10");
            t.Equals(numeric, 0xc000020au, "a numeric IPv4 literal must still parse unchanged");

            // getaddrinfo("localhost") yields 127.0.0.1 or ::1; we ask for AF_INET, so 127.0.0.1.
            const uint32_t named = socom2_hostnet::parseServerAddress("localhost");
            t.Equals(named, 0x7f000001u, "a hostname must resolve, not be discarded");

            // A name that cannot resolve returns 0; serverForKnob turns that into a refusal (below).
            const uint32_t bad = socom2_hostnet::parseServerAddress("no-such-host.invalid");
            t.Equals(bad, 0u, "an unresolvable name must report failure rather than a stale address");
        });

        // Sprint 13 V8 (KNOWN section 4's hazard row; carry-backlog row 91): a PS2X_SOCOM2_SERVER that does not
        // resolve silently became 127.0.0.1, so a stranger whose DNS failed met an unexplained "cannot connect".
        // Now the value is refused: the retail names resolve to nothing and the log carries the server-unresolved
        // [notice] line, which the launcher's LAST RUN appends to the run's own exit sentence. Ruling S13-R9: a
        // notice, not an exit code -- the process's exit code is left as it was (65 or 72 say more).
        tc.Run("a PS2X_SOCOM2_SERVER that does not resolve is refused with a LAST RUN notice, never loopback", [](TestCase &t)
        {
            t.IsTrue(socom2_hostnet::init(), "hostnet init must succeed");
            std::string refusal;
            t.Equals(socom2_hostnet::serverForKnob(nullptr, refusal), 0x7f000001u, "unset: the local Horizon stack, as always");
            t.IsTrue(refusal.empty(), "unset is not a refusal");
            t.Equals(socom2_hostnet::serverForKnob("", refusal), 0x7f000001u, "empty is unset");
            t.Equals(socom2_hostnet::serverForKnob("192.0.2.5", refusal), 0xc0000205u, "an address is taken as it is (TEST-NET-1)");
            t.IsTrue(refusal.empty(), "an address is not a refusal");

            const uint32_t bad = socom2_hostnet::serverForKnob("no-such-host.invalid", refusal);
            t.Equals(bad, 0u, "a name that does not resolve is refused, not loopback");
            t.Equals(refusal, ExitCodes::noticeLine(ExitCodes::kServerUnresolved),
                     "the refusal is the server-unresolved [notice] line: " + refusal);
            t.Equals(launcher::lastRunLine(0, "boot\n" + refusal + "\n"),
                     std::string("The last run exited normally. The server name on the ONLINE page did not resolve, so the "
                                 "game stayed offline. Check your connection or the name."),
                     "LAST RUN appends the sentence to a clean exit");
            t.Equals(launcher::lastRunLine(65, refusal + "\n"),
                     std::string(ExitCodes::find(65)->sentence) + " " + ExitCodes::kServerUnresolved.sentence,
                     "and to the slow renderer's 65, which it no longer overwrites");
            t.IsNull(ExitCodes::find(75), "no exit code 75 anywhere");

            // The table half: every retail name refused, the exit code untouched; then put back as init() left it.
            const int exitBefore = ps2ProcessExitCode();
            setPs2ProcessExitCode(65);
            socom2_hostnet::testApplyServer("no-such-host.invalid");
            t.Equals(socom2_hostnet::resolve("socom2-prod.muis.pdonline.scea.com"), 0u,
                     "the game's lookup of the retail name fails (kErrDns), instead of reaching loopback or Sony");
            t.Equals(socom2_hostnet::resolve("gate1.us.dnas.playstation.org"), 0u, "every retail name, DNAS too");
            t.Equals(ps2ProcessExitCode(), 65, "the process's exit code is left as it was");
            socom2_hostnet::testApplyServer(nullptr);
            t.Equals(socom2_hostnet::resolve("socom2-prod.muis.pdonline.scea.com"), 0x7f000001u, "restored to loopback");
            setPs2ProcessExitCode(exitBefore);
        });

        // #34 (Sprint 13 V7): the peer never sends. The recv times out when the game said (1200 ms), and for the whole
        // of it the EE executor keeps running: VBlanks keep coming and the ticker thread keeps running, no stretch of
        // the wait longer than a few guest ticks (250 ms is slack for a loaded host; before the fix it was all 1200).
        tc.Run("a recv whose peer never sends does not hold the EE executor past one guest tick", [](TestCase &t)
        {
            std::vector<uint8_t> rdram(PS2_RAM_SIZE, 0u);
            PS2Runtime runtime;
            t.IsTrue(runtime.memory().initialize(), "runtime memory initialize should succeed");
            socom2_hostnet::Endpoint local;
            g_park = ParkRun{};
            g_park.cid = openLoopbackCid(rdram, &local);
            g_park.timeoutMs = 1200;
            t.IsTrue(g_park.cid > 0, "a loopback UDP cid should open");
            const std::pair<int, uint64_t> parkBefore = socom2_libnetb::netParkState();

            runParkedRecv(rdram, runtime);
            closeCid(rdram, g_park.cid);
            const std::pair<int, uint64_t> parkAfter = socom2_libnetb::netParkState();

            t.IsTrue(g_park.done, "the recv must return to the guest (the watchdog stopped the run otherwise)");
            t.Equals(g_park.result, kErrTimeout, "no data: the game's own timeout (-500), as before");
            t.IsTrue(elapsedMs(g_park) >= 1150, "not earlier than the timeout the game asked for: " + std::to_string(elapsedMs(g_park)) + " ms");
            t.IsTrue(ticksDuringWait(g_park) >= 10,
                     "VBlanks must reach the other guest threads during the wait; ticker ran " +
                         std::to_string(ticksDuringWait(g_park)) + " times in " + std::to_string(elapsedMs(g_park)) + " ms");
            t.IsTrue(longestGapMs(g_park) < 250,
                     "the executor must not be held: longest stretch with no VBlank run was " + std::to_string(longestGapMs(g_park)) + " ms");
            t.Equals(parkAfter.first, 0, "no thread is left parked (net_park=0/...)");
            t.IsTrue(parkAfter.second - parkBefore.second >= 1100,
                     "the wait is on the sampler's net_park= ms (it grew " + std::to_string(parkAfter.second - parkBefore.second) + ")");
        });

        // A recv whose timeout is one tick or less is served whole inside waitReadable: parking it would cost a
        // VBlank (a lost frame on the render thread) to save at most 16 ms.
        tc.Run("a recv with a timeout of one tick or less is not parked", [](TestCase &t)
        {
            std::vector<uint8_t> rdram(PS2_RAM_SIZE, 0u);
            PS2Runtime runtime;
            t.IsTrue(runtime.memory().initialize(), "runtime memory initialize should succeed");
            socom2_hostnet::Endpoint local;
            g_park = ParkRun{};
            g_park.cid = openLoopbackCid(rdram, &local);
            g_park.timeoutMs = 10;
            t.IsTrue(g_park.cid > 0, "a loopback UDP cid should open");
            const uint64_t parkedMsBefore = socom2_libnetb::netParkState().second;

            runParkedRecv(rdram, runtime);
            closeCid(rdram, g_park.cid);

            t.IsTrue(g_park.done, "the recv must return to the guest");
            t.Equals(g_park.result, kErrTimeout, "no data: the game's timeout");
            t.Equals(ticksDuringWait(g_park), static_cast<size_t>(0), "no park: nothing else ran inside the call");
            t.Equals(socom2_libnetb::netParkState().second, parkedMsBefore, "nothing on net_park=");
            t.IsTrue(elapsedMs(g_park) < 200, "served in about its own 10 ms: " + std::to_string(elapsedMs(g_park)) + " ms");
        });

        // The same wait ended by data mid-way: the re-issued call must still read the guest's own arguments (send ==
        // recv, nothing written before the wait is over) and deliver the datagram when it arrives, not at the deadline.
        tc.Run("a parked recv returns the datagram that arrives during its wait", [](TestCase &t)
        {
            std::vector<uint8_t> rdram(PS2_RAM_SIZE, 0u);
            PS2Runtime runtime;
            t.IsTrue(runtime.memory().initialize(), "runtime memory initialize should succeed");
            socom2_hostnet::Endpoint local;
            g_park = ParkRun{};
            g_park.cid = openLoopbackCid(rdram, &local);
            g_park.timeoutMs = 5000;
            t.IsTrue(g_park.cid > 0, "a loopback UDP cid should open");

            std::chrono::steady_clock::time_point sent{};
            std::thread peer([local, &sent]
            {
                std::this_thread::sleep_for(std::chrono::milliseconds(300));
                const int tx = socom2_hostnet::createSocket(socom2_hostnet::Proto::Udp);
                if (tx >= 0)
                {
                    sent = std::chrono::steady_clock::now();
                    socom2_hostnet::sendTo(tx, "stopped", 7u, local);
                    socom2_hostnet::closeSocket(tx);
                }
            });
            runParkedRecv(rdram, runtime);
            peer.join();
            closeCid(rdram, g_park.cid);

            t.IsTrue(g_park.done, "the recv must return to the guest");
            t.Equals(g_park.result, 7, "the datagram's length");
            t.Equals(g_park.payload, std::string("stopped"), "the datagram itself, at recv byte 0x1c");
            t.IsTrue(sent != std::chrono::steady_clock::time_point{} && g_park.end >= sent,
                     "returned after the datagram was sent, not before");
            t.IsTrue(elapsedMs(g_park) < 2000,
                     "returned when the data came, not at the 5 s deadline: " + std::to_string(elapsedMs(g_park)) + " ms");
            t.IsTrue(ticksDuringWait(g_park) >= 5,
                     "the other guest threads ran while it waited; ticker ran " + std::to_string(ticksDuringWait(g_park)) + " times");
        });
    });

    // Every receive into guest RAM is bounded: by the end of guest RAM, and for the two RPCs by the receive buffer the
    // call states. A receive outside either is refused whole (nothing copied) with one log line.
    MiniTest::Case("SOCOM2LibnetbBounds", [](TestCase &tc)
    {
        // fno 4 carries its data at recv + 8, fno 0xd at recv + 0x1c (docs/research/10-libnetb-rpc.md).
        struct Rpc { uint32_t fno; uint32_t header; const char *name; };
        const Rpc rpcs[] = {{4u, 8u, "sceInetRecv"}, {0xdu, 0x1cu, "sceInetRecvFrom"}};

        tc.Run("the two receive RPCs refuse a range past the end of guest RAM", [rpcs](TestCase &t)
        {
            for (const Rpc &rpc : rpcs)
            {
                GuardedRam ram;
                const int32_t cid = cidWithDatagram(ram.bytes, 0x80u);
                t.IsTrue(cid > 0, std::string(rpc.name) + ": a loopback cid with a datagram waiting");
                const uint32_t recv = PS2_RAM_SIZE - 0x40u;
                const uint32_t before = socom2_libnetb::receivesRefused();
                const std::string out = captureStdout([&] { recvRpc(ram, rpc.fno, cid, 0x100u, recv, 0x140u); });
                t.IsTrue(ram.marginUntouched(), std::string(rpc.name) + ": nothing is written past the end of guest RAM");
                t.Equals(ram.word(recv), kErrInvalidBuffer, std::string(rpc.name) + ": the result is the bad-buffer error");
                t.Equals(socom2_libnetb::receivesRefused(), before + 1u, std::string(rpc.name) + ": the refusal is counted");
                t.IsTrue(out.find(std::string(rpc.name) + " bounded") != std::string::npos && out.find("256") != std::string::npos,
                         std::string(rpc.name) + ": one line names the function and the length: " + out);
                closeCid(ram.bytes, cid);
            }
        });

        tc.Run("the two receive RPCs refuse a length larger than the buffer they state", [rpcs](TestCase &t)
        {
            for (const Rpc &rpc : rpcs)
            {
                GuardedRam ram;
                const int32_t cid = cidWithDatagram(ram.bytes, 0x80u);
                t.IsTrue(cid > 0, std::string(rpc.name) + ": a loopback cid with a datagram waiting");
                const uint32_t recv = 0x2000u, stated = 0x40u;
                std::memset(ram.data() + recv + stated, 0x5A, 0x100u);
                const std::string out = captureStdout([&] { recvRpc(ram, rpc.fno, cid, 0x100u, recv, stated); });
                bool untouched = true;
                for (uint32_t i = 0; i < 0x100u; ++i)
                    untouched = untouched && ram.bytes[recv + stated + i] == 0x5A;
                t.IsTrue(untouched, std::string(rpc.name) + ": nothing is written past the stated buffer");
                t.Equals(ram.word(recv), kErrInvalidBuffer, std::string(rpc.name) + ": the result is the bad-buffer error");
                t.IsTrue(out.find(std::string(rpc.name) + " bounded") != std::string::npos,
                         std::string(rpc.name) + ": one line names the function: " + out);
                closeCid(ram.bytes, cid);
            }
        });

        tc.Run("a receive inside its buffer still delivers the same bytes", [rpcs](TestCase &t)
        {
            for (const Rpc &rpc : rpcs)
            {
                GuardedRam ram;
                const int32_t cid = cidWithDatagram(ram.bytes, 0x80u);
                t.IsTrue(cid > 0, std::string(rpc.name) + ": a loopback cid with a datagram waiting");
                const uint32_t recv = 0x2000u;
                const uint32_t before = socom2_libnetb::receivesRefused();
                recvRpc(ram, rpc.fno, cid, 0x100u, recv, 0x140u);
                t.Equals(ram.word(recv), 0x80, std::string(rpc.name) + ": the datagram's length");
                t.IsTrue(payloadAt(ram, recv + rpc.header, 0x80u), std::string(rpc.name) + ": the datagram's bytes");
                t.Equals(socom2_libnetb::receivesRefused(), before, std::string(rpc.name) + ": nothing refused");
                t.IsTrue(ram.marginUntouched(), std::string(rpc.name) + ": the margin is untouched");
                closeCid(ram.bytes, cid);
            }
        });

        tc.Run("the ring-buffer receives refuse a range past the end of guest RAM", [](TestCase &t)
        {
            {
                GuardedRam ram;
                const int32_t cid = cidWithDatagram(ram.bytes, 0x80u);
                t.IsTrue(cid > 0, "exTcpRecv: a loopback cid with data waiting");
                std::string out;
                uint32_t v0 = 0;
                out = captureStdout([&] { v0 = exTcp(ram, cid, PS2_RAM_SIZE - 0x20u, 0x100u); });
                t.IsTrue(ram.marginUntouched(), "exTcpRecv: nothing is written past the end of guest RAM");
                t.Equals(v0, static_cast<uint32_t>(kErrInvalidBuffer), "exTcpRecv: the bad-buffer error");
                t.IsTrue(out.find("netbExTcpRecv bounded") != std::string::npos && out.find("256") != std::string::npos,
                         "exTcpRecv: one line names the function and the length: " + out);
                closeCid(ram.bytes, cid);
            }
            {
                GuardedRam ram;
                const int32_t cid = cidWithDatagram(ram.bytes, 0x80u);
                t.IsTrue(cid > 0, "exUdpRecv: a loopback cid with a datagram waiting");
                std::string out;
                uint32_t v0 = 0;
                out = captureStdout([&] { v0 = exUdp(ram, cid, PS2_RAM_SIZE - 0x20u, 0x248u); });
                t.IsTrue(ram.marginUntouched(), "exUdpRecv: nothing is written past the end of guest RAM");
                t.Equals(v0, 2u, "exUdpRecv: its own failure code");
                t.Equals(ram.word(0x5124u), 0, "exUdpRecv: no length reported");
                t.IsTrue(out.find("netbExUdpRecv bounded") != std::string::npos && out.find("584") != std::string::npos,
                         "exUdpRecv: one line names the function and the length: " + out);
                closeCid(ram.bytes, cid);
            }
        });

        tc.Run("the ring-buffer receives inside guest RAM still deliver the same bytes", [](TestCase &t)
        {
            {
                GuardedRam ram;
                const int32_t cid = cidWithDatagram(ram.bytes, 0x80u);
                t.IsTrue(cid > 0, "exTcpRecv: a loopback cid with data waiting");
                t.Equals(exTcp(ram, cid, 0x6000u, 0x100u), 0x80u, "exTcpRecv: the byte count");
                t.IsTrue(payloadAt(ram, 0x6000u, 0x80u), "exTcpRecv: the bytes");
                closeCid(ram.bytes, cid);
            }
            {
                GuardedRam ram;
                const int32_t cid = cidWithDatagram(ram.bytes, 0x80u);
                t.IsTrue(cid > 0, "exUdpRecv: a loopback cid with a datagram waiting");
                t.Equals(exUdp(ram, cid, 0x6000u, 0x248u), 0u, "exUdpRecv: success");
                t.Equals(ram.word(0x5124u), 0x80, "exUdpRecv: the length reported");
                t.IsTrue(payloadAt(ram, 0x6000u, 0x80u), "exUdpRecv: the bytes");
                closeCid(ram.bytes, cid);
            }
        });
    });
}
