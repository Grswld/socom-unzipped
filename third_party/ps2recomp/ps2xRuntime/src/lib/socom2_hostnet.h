// Host socket table behind the SOCOM II libnetb HLE (Winsock on Windows, BSD sockets elsewhere).
//
// libnetb (SCE-RT, LIBNETB.IRX) offers the Medius client a small BSD-like socket API over the
// PS2 inet stack. The EE side reaches it through msifrpc (see game_overrides_socom2.cpp); the
// host answers each RPC with these primitives. Descriptors are small integers owned by this
// table (never raw SOCKET values), so the guest cannot tell them from the IOP's.
//
// Name resolution honours PS2X_SOCOM2_HOSTS ("name=ip,name=ip") and, by default, points the
// retail hostnames (socom2-prod*.pdonline.scea.com, gate1.*.dnas.playstation.org) at
// PS2X_SOCOM2_SERVER (default 127.0.0.1), so the exe reaches the local Horizon stack without a
// DNS stub. Everything else resolves through the OS.
#pragma once
#include <cstdint>
#include <string>

namespace socom2_hostnet
{
    enum class Proto { Tcp, Udp };

    struct Endpoint
    {
        uint32_t ip = 0;     // host byte order
        uint16_t port = 0;   // host byte order
    };

    bool init();
    void shutdown();
    // Sprint 17 Q2 (review finding 1): every socket the table holds, closed and its row cleared, the stack kept
    // up (unlike shutdown): what an in-process restart of the guest does so a logoff route that left one open
    // cannot keep the server session alive or use up the 64 slots. Returns how many it closed.
    int closeAllSockets();
    int openSocketCount();

    // All calls return >= 0 on success or a negative host errno-style value on failure.
    int createSocket(Proto proto);
    int closeSocket(int fd);
    int bindSocket(int fd, const Endpoint &local);
    int listenSocket(int fd, int backlog);
    int acceptSocket(int fd, Endpoint *peer);
    // Non-blocking connect: returns 0 when connected, 1 when still in progress, < 0 on error.
    int connectSocket(int fd, const Endpoint &remote);
    int connectStatus(int fd);                    // 0 connected, 1 pending, < 0 failed
    int send(int fd, const void *data, uint32_t size);
    int recv(int fd, void *data, uint32_t size);  // 0 = closed by peer, -EWOULDBLOCK = nothing
    int sendTo(int fd, const void *data, uint32_t size, const Endpoint &remote);
    int recvFrom(int fd, void *data, uint32_t size, Endpoint *remote);
    int localName(int fd, Endpoint *local);
    int peerName(int fd, Endpoint *peer);
    int setBlocking(int fd, bool blocking);
    // Readiness: bit 0 readable, bit 1 writable, bit 2 error; timeoutMs 0 = poll.
    int poll(int fd, int timeoutMs);
    int readable(int fd);                          // bytes available (FIONREAD)

    // Hostname -> IPv4 (host byte order); 0 on failure.
    uint32_t resolve(const std::string &name);
    // Monotonic count of bytes received on every socket in this table. SOCOM II polls
    // sceInetInterfaceControl code 0x200 once a frame and only cares whether the word CHANGED
    // since last time: FUN_0030be80 resets its "last network activity" timestamp when it does, and
    // the multiplayer movement scale (FUN_00553dc0 -> actor+0x1368) decays to zero when that
    // timestamp goes stale. A constant here therefore pins the local player in place.
    uint64_t rxBytes();
    uint32_t localIp();                            // the address the host would use for outbound
    std::string ipToString(uint32_t ip);
    const char *lastError();
}
