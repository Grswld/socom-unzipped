// socom2_net_bounds.h -- bounds on what the network receive path may do with guest memory.
//
// Every decision here is made on plain values so ps2xTest can prove it without the game. A refusal copies nothing
// and says so in one log line; the rest of this file's reasons are kept out of the tree (SECURITY.md).
#pragma once
#include "runtime/ps2_memory.h"

#include <atomic>
#include <cstdint>

namespace socom2_net_bounds
{
    // [addr, addr + len) lies inside guest RAM, the start taken as the receive path indexes RAM (masked).
    inline bool ramSpanFits(uint32_t addr, uint32_t len)
    {
        const uint32_t start = addr & PS2_RAM_MASK;
        return len <= PS2_RAM_SIZE - start;
    }

    // A receive of `len` bytes after a `header` inside a buffer of `stated` bytes fits that buffer.
    inline bool statedFits(uint32_t stated, uint32_t header, uint32_t len)
    {
        return stated >= header && len <= stated - header;
    }

    // Counts a refusal (stopping at the top rather than coming round) and answers whether this one is logged: the
    // first sixteen, then every 1024th, so a loop of refusals cannot turn the log into this line.
    inline bool countRefusal(std::atomic<uint32_t> &count)
    {
        uint32_t prev = count.load();
        while (prev != UINT32_MAX && !count.compare_exchange_weak(prev, prev + 1))
        {
        }
        const uint32_t n = prev == UINT32_MAX ? prev : prev + 1;
        return n <= 16u || (n % 1024u) == 0u;
    }
}
