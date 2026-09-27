#include "socom2_hostnet.h"
#include "ps2x/exit_codes.h"
#include "ps2x/knobs.h"
#include "socom2_persona_record.h"   // Sprint 16 L1b (#73): a plain login response is read here
#include "socom2_rt_frames.h"

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#define NOGDI
#define NOUSER
#include <winsock2.h>
#include <ws2tcpip.h>
#else
// The BSD half. Same call graph throughout; only the spellings differ.
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <errno.h>
#include <poll.h>
#endif

#include <array>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

namespace socom2_hostnet
{
    // Defined below, forward-declared here because loadHosts() (file-local) calls it. Not in the
    // public header: it exists so socom2_libnetb_tests.cpp can drive the PS2X_SOCOM2_SERVER
    // parse without touching the process environment or re-running init().
    uint32_t parseServerAddress(const std::string &value);

    // Sprint 13 V8: what PS2X_SOCOM2_SERVER becomes. Unset or empty: loopback, the local Horizon stack. An
    // IPv4 literal or a name that resolves: that address. Anything else is REFUSED: the answer is 0 and
    // `refusal` is the [notice] line (ExitCodes::kServerUnresolved) the launcher appends to LAST RUN -- a
    // notice, not an exit code (ruling S13-R9): the run goes on offline and its exit code is left alone. It
    // was loopback, silently, until then -- a stranger whose DNS failed met "the server is down" (KNOWN
    // section 4's hazard row). Not in the public header, for the same reason as parseServerAddress.
    uint32_t serverForKnob(const char *value, std::string &refusal);
    // The server half of loadHosts() with `value` in place of the knob, under the table's lock; for
    // socom2_libnetb_tests.cpp, since init() runs loadHosts() once per process.
    void testApplyServer(const char *value);

    // The platform's error reporting, at namespace scope for the same reason parseServerAddress
    // is: socom2_libnetb_tests.cpp drives them directly, and "what does this platform call
    // would-block" is the one piece of the BSD/Winsock split a test can check without a network.
    // hostnetLastError() is WSAGetLastError() on Windows and errno elsewhere.
    int hostnetLastError();
    bool hostnetWouldBlock(int err);

    namespace
    {
#ifdef _WIN32
        using SocketHandle = SOCKET;
        constexpr SocketHandle kInvalidSocket = INVALID_SOCKET;
        using SockLen = int;        // the address-length in/out parameter of accept/getsockname
        using IoLen = int;          // the size argument of send/recv
        using IoResult = int;       // what send/recv return
        using SendBuf = const char *;
        using RecvBuf = char *;
#else
        using SocketHandle = int;
        constexpr SocketHandle kInvalidSocket = -1;
        using SockLen = socklen_t;
        using IoLen = size_t;
        using IoResult = ssize_t;
        using SendBuf = const void *;
        using RecvBuf = void *;
#endif

        constexpr int kMaxSockets = 64;

        struct Entry
        {
            SocketHandle s = kInvalidSocket;
            Proto proto = Proto::Tcp;
            bool used = false;
            bool connecting = false;
            bool blocking = false;
            socom2_rt::Carry rx;   // Sprint 16 L1b: the RT frame walk of what arrives; closeSocket's reset starts it again
        };

        std::mutex g_mutex;
        // Total bytes received on every socket this table owns. The PS2 inet stack exposes
        // interface statistics through sceInetInterfaceControl, and SOCOM II uses one of them as a
        // "has anything arrived lately" tick (see rxBytes() in the header). Guarded by g_mutex,
        // which every receive path already holds.
        uint64_t g_rxBytes = 0;
        std::array<Entry, kMaxSockets> g_table;
        bool g_initialized = false;
        std::string g_lastError;
        std::map<std::string, uint32_t> g_hosts;

        // Would-block is tested before the switch rather than as a case of it because EWOULDBLOCK
        // and EAGAIN are the same value on Linux, which a switch cannot spell twice. The Windows
        // arm maps the same codes to the same guest errnos it always did.
        int mapError()
        {
            const int e = hostnetLastError();
            if (hostnetWouldBlock(e))
                return -11;                       // EAGAIN
#ifdef _WIN32
            switch (e)
            {
            case WSAEINPROGRESS: return -115;     // EINPROGRESS
            case WSAECONNREFUSED: return -111;
            case WSAETIMEDOUT: return -110;
            case WSAEHOSTUNREACH: return -113;
            case WSAENOTCONN: return -107;
            case WSAECONNRESET: return -104;
            case WSAEADDRINUSE: return -98;
            default: return -5;                   // EIO
            }
#else
            switch (e)
            {
            case EINPROGRESS: return -115;
            case ECONNREFUSED: return -111;
            case ETIMEDOUT: return -110;
            case EHOSTUNREACH: return -113;
            case ENOTCONN: return -107;
            case ECONNRESET: return -104;
            case EADDRINUSE: return -98;
            default: return -5;                   // EIO
            }
#endif
        }

        void hostnetSetLastError(int err)
        {
#ifdef _WIN32
            WSASetLastError(err);
#else
            errno = err;
#endif
        }

        void hostnetClose(SocketHandle s)
        {
#ifdef _WIN32
            ::closesocket(s);
#else
            ::close(s);
#endif
        }

        // 0 on success, non-zero on failure -- the ioctlsocket convention the call sites expect.
        int hostnetSetNonBlocking(SocketHandle s, bool nonBlocking)
        {
#ifdef _WIN32
            u_long nb = nonBlocking ? 1u : 0u;
            return ::ioctlsocket(s, FIONBIO, &nb);
#else
            const int flags = ::fcntl(s, F_GETFL, 0);
            if (flags < 0)
                return -1;
            const int want = nonBlocking ? (flags | O_NONBLOCK) : (flags & ~O_NONBLOCK);
            return ::fcntl(s, F_SETFL, want) < 0 ? -1 : 0;
#endif
        }

        int hostnetReadableBytes(SocketHandle s, int *bytes)
        {
#ifdef _WIN32
            u_long n = 0;
            if (::ioctlsocket(s, FIONREAD, &n) != 0)
                return -1;
            *bytes = static_cast<int>(n);
#else
            int n = 0;
            if (::ioctl(s, FIONREAD, &n) != 0)
                return -1;
            *bytes = n;
#endif
            return 0;
        }

        Entry *entry(int fd)
        {
            if (fd < 0 || fd >= kMaxSockets || !g_table[fd].used)
                return nullptr;
            return &g_table[fd];
        }

        // Sprint 16 L1b (#73; logs/l1b_seam_reading.md, section 4): Horizon's MAS and MLS send the login response PLAIN,
        // so it never crosses the RC4 seam. Every TCP byte received is walked as RT frames (socom2_rt_frames.h) and each
        // plain RT_MSG_SERVER_APP body is kept for socom2_persona::onServerApp, which the caller runs AFTER g_mutex is
        // released (the ledger write must not sit under the socket table's lock); encrypted frames are the RC4 seam's.
        void walkFrames(socom2_rt::Carry &carry, const void *bytes, std::size_t n, std::vector<std::vector<uint8_t>> *apps)
        {
            socom2_rt::splitRtFrames(carry, static_cast<const uint8_t *>(bytes), n, true, [&](const socom2_rt::Frame &f) {
                if (f.kept)
                    apps->emplace_back(f.body, f.body + f.len);
            });
        }

        sockaddr_in toAddr(const Endpoint &ep)
        {
            sockaddr_in a{};
            a.sin_family = AF_INET;
            a.sin_port = htons(ep.port);
            a.sin_addr.s_addr = htonl(ep.ip);
            return a;
        }

        Endpoint fromAddr(const sockaddr_in &a)
        {
            Endpoint ep;
            ep.ip = ntohl(a.sin_addr.s_addr);
            ep.port = ntohs(a.sin_port);
            return ep;
        }

        uint32_t parseIp(const std::string &s)
        {
            in_addr a{};
            if (inet_pton(AF_INET, s.c_str(), &a) == 1)
                return ntohl(a.s_addr);
            return 0;
        }

        // The seven retail names all go to one server. On a refusal they go to 0, which resolve() answers as
        // a failed lookup (sceInetName2Address -> kErrDns): the game's own "cannot connect" path, never
        // loopback and never the OS's DNS for Sony's names. The refusal is printed once: the value on stderr
        // for the log, and the [notice] line on stdout, as ps2_runtime.cpp prints no-audio-device, which the
        // launcher's LAST RUN appends to whatever the exit was. Callers hold g_mutex.
        void applyServerLocked(const char *value)
        {
            std::string refusal;
            const uint32_t server = serverForKnob(value, refusal);
            if (!refusal.empty())
            {
                std::cerr << "[socom2/hostnet] PS2X_SOCOM2_SERVER=" << value
                          << " is neither an IPv4 address nor a name that resolves; the retail names are refused"
                          << std::endl;
                std::cout << refusal << std::endl;
            }
            for (const char *name : {"socom2-prod.pdonline.scea.com", "socom2-prod.svo.pdonline.scea.com",
                                     "socom2-prod.muis.pdonline.scea.com", "gate1.us.dnas.playstation.org",
                                     "gate1.jp.dnas.playstation.org", "gate1.eu.dnas.playstation.org",
                                     "updates.pdonline.scea.com"})
                g_hosts[name] = server;
        }

        void loadHosts()
        {
            applyServerLocked(ps2x::knob("PS2X_SOCOM2_SERVER"));
            if (const char *env = ps2x::knob("PS2X_SOCOM2_HOSTS"))
            {
                std::stringstream ss(env);
                std::string item;
                while (std::getline(ss, item, ','))
                {
                    const auto eq = item.find('=');
                    if (eq == std::string::npos)
                        continue;
                    const uint32_t ip = parseIp(item.substr(eq + 1));
                    if (ip)
                        g_hosts[item.substr(0, eq)] = ip;
                }
            }
        }
    }

    int hostnetLastError()
    {
#ifdef _WIN32
        return WSAGetLastError();
#else
        return errno;
#endif
    }

    bool hostnetWouldBlock(int err)
    {
#ifdef _WIN32
        return err == WSAEWOULDBLOCK;
#else
        return err == EWOULDBLOCK || err == EAGAIN;
#endif
    }

#ifndef _WIN32
    // F6: poll(2) is NOT restarted by SA_RESTART -- a signal always makes it return EINTR. The
    // Linux host sampler (PS2X_HOST_PROF) raises SIGPROF on every thread hundreds of times a
    // second, so without this retry every online poll() that overlapped a tick fell out of
    // mapError()'s default arm as -5 (EIO) and the guest read a live socket as dead: turning the
    // profiler on broke multiplayer. The retry recomputes the timeout from a MONOTONIC deadline,
    // so an interrupted 100 ms wait still lasts 100 ms in total rather than 100 ms per signal,
    // and a deadline already passed answers "timeout" (0) rather than an error.
    //
    // Not in socom2_hostnet.h: exposed at namespace scope so socom2_libnetb_tests.cpp can drive
    // it with a real signal, which is the only way to observe an EINTR at all.
    int hostnetPollRestarting(int nativeFd, short events, short *revents, int timeoutMs)
    {
        pollfd pfd{};
        pfd.fd = nativeFd;
        pfd.events = events;
        if (revents)
            *revents = 0;
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs < 0 ? 0 : timeoutMs);
        int remaining = timeoutMs;
        for (;;)
        {
            pfd.revents = 0;
            const int n = ::poll(&pfd, 1, remaining);
            if (n >= 0)
            {
                if (revents)
                    *revents = pfd.revents;
                return n;
            }
            if (errno != EINTR)
                return n;
            if (timeoutMs < 0)
                continue;   // an infinite wait has no deadline to recompute
            const auto left = std::chrono::duration_cast<std::chrono::milliseconds>(
                                  deadline - std::chrono::steady_clock::now())
                                  .count();
            if (left <= 0)
                return 0;   // the wait the caller asked for has elapsed: a timeout, not an error
            remaining = static_cast<int>(left);
        }
    }
#endif

    // PS2X_SOCOM2_SERVER is a numeric IPv4 literal or a DNS name -- a hosted server is reached by
    // name. Returns host byte order IPv4, or 0 when the value is neither; serverForKnob() turns that
    // 0 into a refusal (Sprint 13 V8; it was "keep loopback" until then). Winsock is already up where
    // it has to be: init() runs WSAStartup before loadHosts(), which is the only caller inside the
    // runtime, and getaddrinfo needs nothing
    // earlier than that. On BSD sockets there is nothing to start.
    uint32_t parseServerAddress(const std::string &value)
    {
        if (const uint32_t ip = parseIp(value))
            return ip;

        addrinfo hints{};
        hints.ai_family = AF_INET;
        hints.ai_socktype = SOCK_STREAM;
        addrinfo *res = nullptr;
        uint32_t ip = 0;
        if (getaddrinfo(value.c_str(), nullptr, &hints, &res) == 0 && res)
        {
            for (const addrinfo *p = res; p; p = p->ai_next)
            {
                if (p->ai_family == AF_INET && p->ai_addr)
                {
                    ip = ntohl(reinterpret_cast<const sockaddr_in *>(p->ai_addr)->sin_addr.s_addr);
                    break;
                }
            }
        }
        if (res)
            freeaddrinfo(res);
        return ip;
    }

    uint32_t serverForKnob(const char *value, std::string &refusal)
    {
        refusal.clear();
        if (value == nullptr || *value == '\0')
            return 0x7f000001u;   // unset: the local Horizon stack (knobs.h's default)
        if (const uint32_t ip = parseServerAddress(value))
            return ip;
        refusal = ExitCodes::noticeLine(ExitCodes::kServerUnresolved);
        return 0;
    }

    void testApplyServer(const char *value)
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        applyServerLocked(value);
    }

    bool init()
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        if (g_initialized)
            return true;
#ifdef _WIN32
        WSADATA wsa{};
        if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0)
        {
            g_lastError = "WSAStartup failed";
            return false;
        }
        const char *stackName = "Winsock";
#else
        // BSD sockets need no start-up call at all.
        const char *stackName = "BSD sockets";
#endif
        loadHosts();
        g_initialized = true;
        const uint32_t retail = g_hosts["socom2-prod.muis.pdonline.scea.com"];
        std::cout << "[socom2/hostnet] " << stackName << " ready; retail hostnames -> "
                  << (retail ? ipToString(retail) : std::string("refused (server-unresolved notice)")) << std::endl;
        return true;
    }

    void shutdown()
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        for (auto &e : g_table)
        {
            if (e.used && e.s != kInvalidSocket)
                hostnetClose(e.s);
            e = Entry{};
        }
#ifdef _WIN32
        if (g_initialized)
            WSACleanup();
#endif
        g_initialized = false;
    }

    int createSocket(Proto proto)
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        for (int i = 0; i < kMaxSockets; ++i)
        {
            if (g_table[i].used)
                continue;
            SocketHandle s = ::socket(AF_INET, proto == Proto::Tcp ? SOCK_STREAM : SOCK_DGRAM,
                                      proto == Proto::Tcp ? IPPROTO_TCP : IPPROTO_UDP);
            if (s == kInvalidSocket)
                return mapError();
            hostnetSetNonBlocking(s, true);
            g_table[i] = Entry{s, proto, true, false, false};
            return i;
        }
        return -24; // EMFILE
    }

    int closeSocket(int fd)
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        Entry *e = entry(fd);
        if (!e)
            return -9;
        hostnetClose(e->s);
        *e = Entry{};   // the frame walk's carry goes with it
        return 0;
    }

    int bindSocket(int fd, const Endpoint &local)
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        Entry *e = entry(fd);
        if (!e)
            return -9;
        sockaddr_in a = toAddr(local);
        if (local.ip == 0)
            a.sin_addr.s_addr = INADDR_ANY;
        return ::bind(e->s, reinterpret_cast<sockaddr *>(&a), sizeof(a)) == 0 ? 0 : mapError();
    }

    int listenSocket(int fd, int backlog)
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        Entry *e = entry(fd);
        if (!e)
            return -9;
        return ::listen(e->s, backlog) == 0 ? 0 : mapError();
    }

    int acceptSocket(int fd, Endpoint *peer)
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        Entry *e = entry(fd);
        if (!e)
            return -9;
        sockaddr_in a{};
        SockLen len = sizeof(a);
        SocketHandle s = ::accept(e->s, reinterpret_cast<sockaddr *>(&a), &len);
        if (s == kInvalidSocket)
            return mapError();
        for (int i = 0; i < kMaxSockets; ++i)
        {
            if (g_table[i].used)
                continue;
            hostnetSetNonBlocking(s, true);
            g_table[i] = Entry{s, Proto::Tcp, true, false, false};
            if (peer)
                *peer = fromAddr(a);
            return i;
        }
        hostnetClose(s);
        return -24;
    }

    int connectSocket(int fd, const Endpoint &remote)
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        Entry *e = entry(fd);
        if (!e)
            return -9;
        sockaddr_in a = toAddr(remote);
        if (::connect(e->s, reinterpret_cast<sockaddr *>(&a), sizeof(a)) == 0)
        {
            e->connecting = false;
            return 0;
        }
        const int err = hostnetLastError();
        if (e->proto == Proto::Udp)
            return mapError();
#ifdef _WIN32
        if (hostnetWouldBlock(err) || err == WSAEINPROGRESS || err == WSAEALREADY)
#else
        // A repeated connect() on a socket that finished connecting answers EISCONN here, where
        // Winsock answers WSAEISCONN only from a blocking retry the guest never makes.
        if (err == EISCONN)
        {
            e->connecting = false;
            return 0;
        }
        if (hostnetWouldBlock(err) || err == EINPROGRESS || err == EALREADY)
#endif
        {
            e->connecting = true;
            return 1;
        }
        return mapError();
    }

    int connectStatus(int fd)
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        Entry *e = entry(fd);
        if (!e)
            return -9;
        if (!e->connecting)
            return 0;
#ifdef _WIN32
        fd_set w, x;
        FD_ZERO(&w);
        FD_ZERO(&x);
        FD_SET(e->s, &w);
        FD_SET(e->s, &x);
        timeval tv{0, 0};
        const int n = ::select(0, nullptr, &w, &x, &tv);
        if (n <= 0)
            return 1;
        if (FD_ISSET(e->s, &x))
        {
            int err = 0;
            SockLen len = sizeof(err);
            getsockopt(e->s, SOL_SOCKET, SO_ERROR, reinterpret_cast<char *>(&err), &len);
            e->connecting = false;
            hostnetSetLastError(err);
            return mapError();
        }
#else
        // select(0, ...) is a Winsock spelling -- POSIX counts descriptors -- and poll() says the
        // same thing without the FD_SETSIZE ceiling. A refused connect surfaces as POLLERR here
        // and, on some kernels, only as SO_ERROR on a descriptor that also reads as writable, so
        // both are consulted before the socket is called connected.
        // F6: through hostnetPollRestarting so a SIGPROF tick cannot turn "still connecting"
        // into an EIO. A zero timeout is still interruptible.
        short revents = 0;
        const int n = hostnetPollRestarting(e->s, POLLOUT, &revents, 0);
        if (n <= 0)
            return 1;
        int err = 0;
        SockLen len = sizeof(err);
        getsockopt(e->s, SOL_SOCKET, SO_ERROR, reinterpret_cast<char *>(&err), &len);
        if ((revents & (POLLERR | POLLHUP | POLLNVAL)) != 0 || err != 0)
        {
            e->connecting = false;
            hostnetSetLastError(err);
            return mapError();
        }
#endif
        e->connecting = false;
        return 0;
    }

    int send(int fd, const void *data, uint32_t size)
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        Entry *e = entry(fd);
        if (!e)
            return -9;
        const IoResult n = ::send(e->s, static_cast<SendBuf>(data), static_cast<IoLen>(size), 0);
        return n >= 0 ? static_cast<int>(n) : mapError();
    }

    int recv(int fd, void *data, uint32_t size)
    {
        std::vector<std::vector<uint8_t>> apps;   // plain SERVER_APP bodies, handed on once g_mutex is released
        IoResult n = 0;
        {
            std::lock_guard<std::mutex> lock(g_mutex);
            Entry *e = entry(fd);
            if (!e)
                return -9;
            n = ::recv(e->s, static_cast<RecvBuf>(data), static_cast<IoLen>(size), 0);
            if (n <= 0)
                return n == 0 ? 0 : mapError();
            g_rxBytes += static_cast<uint64_t>(n);
            if (e->proto == Proto::Tcp)
                walkFrames(e->rx, data, static_cast<std::size_t>(n), &apps);
        }
        for (const std::vector<uint8_t> &body : apps)
            socom2_persona::onServerApp(fd, body.data(), body.size());
        return static_cast<int>(n);
    }

    int sendTo(int fd, const void *data, uint32_t size, const Endpoint &remote)
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        Entry *e = entry(fd);
        if (!e)
            return -9;
        sockaddr_in a = toAddr(remote);
        const IoResult n = ::sendto(e->s, static_cast<SendBuf>(data), static_cast<IoLen>(size), 0,
                                    reinterpret_cast<sockaddr *>(&a), sizeof(a));
        return n >= 0 ? static_cast<int>(n) : mapError();
    }

    int recvFrom(int fd, void *data, uint32_t size, Endpoint *remote)
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        Entry *e = entry(fd);
        if (!e)
            return -9;
        sockaddr_in a{};
        SockLen len = sizeof(a);
        const IoResult n = ::recvfrom(e->s, static_cast<RecvBuf>(data), static_cast<IoLen>(size), 0,
                                      reinterpret_cast<sockaddr *>(&a), &len);
        if (n < 0)
            return mapError();
        if (n > 0)
            g_rxBytes += static_cast<uint64_t>(n);
        if (remote)
            *remote = fromAddr(a);
        return static_cast<int>(n);
    }

    int localName(int fd, Endpoint *local)
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        Entry *e = entry(fd);
        if (!e)
            return -9;
        sockaddr_in a{};
        SockLen len = sizeof(a);
        if (getsockname(e->s, reinterpret_cast<sockaddr *>(&a), &len) != 0)
            return mapError();
        if (local)
        {
            *local = fromAddr(a);
            if (local->ip == 0)
                local->ip = localIp();
        }
        return 0;
    }

    int peerName(int fd, Endpoint *peer)
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        Entry *e = entry(fd);
        if (!e)
            return -9;
        sockaddr_in a{};
        SockLen len = sizeof(a);
        if (getpeername(e->s, reinterpret_cast<sockaddr *>(&a), &len) != 0)
            return mapError();
        if (peer)
            *peer = fromAddr(a);
        return 0;
    }

    int setBlocking(int fd, bool blocking)
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        Entry *e = entry(fd);
        if (!e)
            return -9;
        e->blocking = blocking;
        return hostnetSetNonBlocking(e->s, !blocking) == 0 ? 0 : mapError();
    }

    int poll(int fd, int timeoutMs)
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        Entry *e = entry(fd);
        if (!e)
            return -9;
#ifdef _WIN32
        fd_set r, w, x;
        FD_ZERO(&r);
        FD_ZERO(&w);
        FD_ZERO(&x);
        FD_SET(e->s, &r);
        FD_SET(e->s, &w);
        FD_SET(e->s, &x);
        timeval tv{timeoutMs / 1000, (timeoutMs % 1000) * 1000};
        const int n = ::select(0, &r, &w, &x, &tv);
        if (n < 0)
            return mapError();
        int mask = 0;
        if (FD_ISSET(e->s, &r)) mask |= 1;
        if (FD_ISSET(e->s, &w)) mask |= 2;
        if (FD_ISSET(e->s, &x)) mask |= 4;
        return mask;
#else
        // F6: hostnetPollRestarting, not ::poll -- an interrupted wait resumes with the time it
        // has left instead of falling through mapError() as -5 (EIO).
        short revents = 0;
        const int n = hostnetPollRestarting(e->s, POLLIN | POLLOUT, &revents, timeoutMs);
        if (n < 0)
            return mapError();
        int mask = 0;
        if (revents & POLLIN) mask |= 1;
        if (revents & POLLOUT) mask |= 2;
        if (revents & (POLLERR | POLLHUP | POLLNVAL)) mask |= 4;
        return mask;
#endif
    }

    int readable(int fd)
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        Entry *e = entry(fd);
        if (!e)
            return -9;
        int n = 0;
        if (hostnetReadableBytes(e->s, &n) != 0)
            return mapError();
        return n;
    }

    uint32_t resolve(const std::string &name)
    {
        {
            std::lock_guard<std::mutex> lock(g_mutex);
            auto it = g_hosts.find(name);
            if (it != g_hosts.end())
                return it->second;
        }
        if (const uint32_t ip = parseIp(name))
            return ip;
        addrinfo hints{};
        hints.ai_family = AF_INET;
        addrinfo *res = nullptr;
        if (getaddrinfo(name.c_str(), nullptr, &hints, &res) != 0 || !res)
            return 0;
        const uint32_t ip = ntohl(reinterpret_cast<sockaddr_in *>(res->ai_addr)->sin_addr.s_addr);
        freeaddrinfo(res);
        return ip;
    }

    uint64_t rxBytes()
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        return g_rxBytes;
    }

    uint32_t localIp()
    {
        // The address a UDP socket would use towards the server: connect() on a datagram socket
        // performs no traffic but picks the source interface.
        uint32_t target = 0x7f000001u;
        {
            std::lock_guard<std::mutex> lock(g_mutex);
            auto it = g_hosts.find("socom2-prod.muis.pdonline.scea.com");
            if (it != g_hosts.end() && it->second != 0)   // 0: the server was refused; ask about loopback
                target = it->second;
        }
        SocketHandle s = ::socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
        if (s == kInvalidSocket)
            return 0x7f000001u;
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_port = htons(53);
        a.sin_addr.s_addr = htonl(target);
        uint32_t ip = 0x7f000001u;
        if (::connect(s, reinterpret_cast<sockaddr *>(&a), sizeof(a)) == 0)
        {
            sockaddr_in l{};
            SockLen len = sizeof(l);
            if (getsockname(s, reinterpret_cast<sockaddr *>(&l), &len) == 0)
                ip = ntohl(l.sin_addr.s_addr);
        }
        hostnetClose(s);
        return ip;
    }

    std::string ipToString(uint32_t ip)
    {
        std::ostringstream o;
        o << ((ip >> 24) & 255) << '.' << ((ip >> 16) & 255) << '.' << ((ip >> 8) & 255) << '.' << (ip & 255);
        return o.str();
    }

    const char *lastError()
    {
        return g_lastError.c_str();
    }
}
