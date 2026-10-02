// The macOS port: a display count asked before raylib's InitWindow, so a run started with every screen asleep
// refuses with ExitCodes::kNoDisplay instead of crashing in rlglInit (runtime/ps2_window_size.h).
#include "runtime/host_display.h"

#if defined(__APPLE__)
#include <CoreGraphics/CoreGraphics.h>
#endif

namespace ps2x_host
{
    int awakeDisplayCount()
    {
#if defined(__APPLE__)
        // The same scan as GLFW's _glfwPollMonitorsCocoa: every online display, minus the sleeping ones.
        uint32_t count = 0;
        if (CGGetOnlineDisplayList(0, nullptr, &count) != kCGErrorSuccess)
            return -1;
        if (count == 0)
            return 0;
        CGDirectDisplayID ids[32];
        if (count > 32)
            count = 32;
        if (CGGetOnlineDisplayList(count, ids, &count) != kCGErrorSuccess)
            return -1;
        int awake = 0;
        for (uint32_t i = 0; i < count; ++i)
            if (!CGDisplayIsAsleep(ids[i]))
                ++awake;
        return awake;
#else
        return -1;
#endif
    }
}
