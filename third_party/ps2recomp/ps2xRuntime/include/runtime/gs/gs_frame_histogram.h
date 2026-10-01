#pragma once

// Sprint 17 F0: the present-interval histogram.
//
// [gs-gl stats] prints an fps figure that is a 60-call mean; a 2.5 s freeze between two presents
// vanishes into it. This counts the time between consecutive presents (executePresent's
// steady_clock stamps) into seven buckets, and keeps the longest, so the stats block can print a
// sibling line
//
//   frames n=<n> le17=<c0> le20=<c1> le25=<c2> le33=<c3> le50=<c4> le100=<c5> over=<c6> longest_ms=<x.x>
//
// per interval and reset it. The edges are whole milliseconds and an interval's milliseconds are
// truncated before the compare, so a 60 Hz present (16.67 ms) is le17 and a 30 Hz one (33.33 ms)
// is le33, not le50. Anything past the last edge lands in the open bucket (over=): it is never
// dropped and never wraps. Header-only, no GL, no runtime includes: ps2x_tests drives it directly.

#include <cstdint>
#include <cstdio>
#include <string>

struct GsFrameHistogram
{
    static constexpr uint32_t kEdgesMs[6] = {17, 20, 25, 33, 50, 100};
    uint64_t counts[7] = {};
    uint64_t longestNs = 0;
    uint64_t n = 0;

    void add(uint64_t intervalNs)
    {
        ++n;
        if (intervalNs > longestNs)
            longestNs = intervalNs;
        const uint64_t ms = intervalNs / 1'000'000ull;
        int b = 0;
        while (b < 6 && ms > kEdgesMs[b])
            ++b;
        ++counts[b];
    }

    void reset()
    {
        for (uint64_t &c : counts)
            c = 0;
        longestNs = 0;
        n = 0;
    }

    std::string line() const
    {
        char buf[256];
        std::snprintf(buf, sizeof(buf),
                      "frames n=%llu le17=%llu le20=%llu le25=%llu le33=%llu le50=%llu le100=%llu over=%llu longest_ms=%.1f",
                      (unsigned long long)n, (unsigned long long)counts[0], (unsigned long long)counts[1],
                      (unsigned long long)counts[2], (unsigned long long)counts[3], (unsigned long long)counts[4],
                      (unsigned long long)counts[5], (unsigned long long)counts[6],
                      static_cast<double>(longestNs) / 1.0e6);
        return std::string(buf);
    }
};
