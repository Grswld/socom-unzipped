// SOCOM II libnetb (SCE-RT network layer) HLE: answers the msifrpc service 0x80001201 and
// replaces the libnetb_ex ring-buffer path on the EE with direct host socket calls.
// Contract: docs/research/10-libnetb-rpc.md.
//
// Environment knobs answered here (one rule: unset or empty = default; "0"/"false"/"off" = off):
//   PS2X_SOCOM2_NET_TRACE        any value  enable the netcode trace (counters + peer hex)
//   PS2X_SOCOM2_NET_TRACE_PEERS  <n>        how many datagrams to hex-dump per direction (default 16)
//   PS2X_SOCOM2_NET_TRACE_ALL    default off  hex-dump EVERY datagram, not just ports < 10000
//   PS2X_SOCOM2_UDP_SHIFT        <n>        shift this instance's peer UDP ports by n
//   PS2X_SOCOM2_NET_STATS        default ON   sceInetInterfaceControl code 0x200 returns a real RX
//                                            byte count. Setting it to 0 restores the old constant
//                                            and REPRODUCES the online movement defect: the guest's
//                                            "ms since network activity" never resets, the
//                                            multiplayer movement scale decays to 0 and the local
//                                            player cannot move (docs/research/18 section 3.12).
//                                            Kept as an opt-out so the fix can be A/B'd on one
//                                            binary without a rebuild.
#pragma once
#include <cstdint>
#include <utility>

struct R5900Context;
class PS2Runtime;

namespace socom2_libnetb
{
    // sceSifMCallRpc payload for service 0x80001201: dispatch by function number, fill recv.
    // A sceInetRecv/RecvFrom (fno 4/0xd) with a timeout waits here at most one guest tick (16 ms); see rpcFromGuest.
    void call(uint8_t *rdram, uint32_t fno, uint32_t send, uint32_t sendSize, uint32_t recv, uint32_t recvSize);

    // The msifrpc call for this service from guest code (socom2_MsifCall, FUN_001bd320: a1 fno, a3 send, t0 sendSize,
    // t1 recv, t2 recvSize). Runs call() and returns to ra with v0 = 0 (transport ok) -- except that a sceInetRecv or
    // sceInetRecvFrom with a timeout over one tick, on a socket with nothing to read, parks the calling guest thread
    // until the next VBlank and then issues itself again, until data arrives or the game's own timeout passes (#34,
    // research/29 shape 2). The EE executor is never held past one guest tick: VBlanks and the other guest threads run
    // through the wait, and the game still sees exactly the result and the timeout it asked for. What the CALLING
    // thread would have done meanwhile still waits -- research/29 puts this recv on thread 1, which submits frames.
    void rpcFromGuest(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);

    // Test only: forget the cached PS2X_SOCOM2_NET_STATS so the next call() re-reads the environment.
    void testResetKnobs();
    // Sprint 17 Q2 (review finding 1): an in-process restart of the guest. Every cid still open is closed with its
    // host socket (the game's own logoff closes them one by one; a route that leaves one behind would otherwise keep
    // the server session alive), the parked receives are dropped, then the host table's strays go too
    // (socom2_hostnet::closeAllSockets). Returns how many cids and host sockets it closed, together.
    size_t closeAllForGuestRestart();
    size_t openCidCount();

    // The pc-sampler's net_wait= field (research/29 section 4 item 8): {1 while a guest thread is inside one of
    // the host-BLOCKING waits here (waitReadable's poll loop, one guest tick at most since #34; doOpen's connect poll),
    // else 0; cumulative milliseconds spent in them}. While the flag is 1 no guest instruction runs, so the
    // sampled thread table and live pc are stale -- freeze shape 2 in docs/research/29-online-freeze.md.
    std::pair<int, uint64_t> netWaitState();

    // The pc-sampler's net_park= field (#34): {guest threads parked in a recv RPC right now; cumulative milliseconds
    // parked, live parks included}. net_park=1 with vsync and seq moving is the executor free while a thread waits
    // on a quiet peer -- what freeze shape 2 looks like since the bound.
    std::pair<int, uint64_t> netParkState();

    // EE function replacements (libnetb_ex path used by the SCE-RT platform layer).
    void exOpen(uint8_t *rdram, R5900Context *ctx, PS2Runtime *);        // FUN_002472c8
    void exTcpRecv(uint8_t *rdram, R5900Context *ctx, PS2Runtime *);     // FUN_002474f8
    void exTcpSend(uint8_t *rdram, R5900Context *ctx, PS2Runtime *);     // FUN_00247738
    void exUdpRecv(uint8_t *rdram, R5900Context *ctx, PS2Runtime *);     // FUN_00247d30
    void exUdpSend(uint8_t *rdram, R5900Context *ctx, PS2Runtime *);     // FUN_00247fe8
    void exAvailable(uint8_t *rdram, R5900Context *ctx, PS2Runtime *);   // FUN_002479b8
    void exConnected(uint8_t *rdram, R5900Context *ctx, PS2Runtime *);   // FUN_00247bd8
    void exStartAsync(uint8_t *rdram, R5900Context *ctx, PS2Runtime *);  // FUN_00248350 / FUN_002483f8
}
