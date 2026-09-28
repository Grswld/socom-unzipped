#pragma once

// Sprint 17 F1 attempt 2: the two tags setupDrawState writes for the [gs-gl stats] states= and blends= fields.
//
// executeCommands prints those two logs (and clears them) only under PS2X_GS_STATS, every 60 command buffers;
// before attempt 2 setupDrawState formatted both tags with snprintf and searched the logs for them on every
// draw whatever the knob said -- formatting nobody read (the task book's "unconditional formatting", setup=).
// Now it calls these only when enabled() says the line will print them, or when PS2X_GS_SETUP_FORMAT=1
// restores the old per-draw formatting for the A/B. Pure functions, so ps2x_tests checks the decision and the
// tags without a GL context.

#include <cstdint>
#include <cstdio>
#include <string>

namespace GsGlStateTags
{
    // `statsKnob`: ps2x::knob("PS2X_GS_STATS") -- a Presence knob, so any value (0 too) turns the line on.
    // `setupFormatOn`: ps2x::knobOn("PS2X_GS_SETUP_FORMAT"), the A/B back to formatting on every draw.
    inline bool enabled(const char *statsKnob, bool setupFormatOn)
    {
        return statsKnob != nullptr || setupFormatOn;
    }

    // " T<TEST & 0x7FFFF>/M<FBMSK>/tfx<TFX>[t]", appended once per distinct value while the log is under 600.
    inline void noteState(std::string &log, uint64_t test, uint32_t fbmsk, uint32_t tfx, bool tme)
    {
        char tag[64];
        std::snprintf(tag, sizeof(tag), " T%05llx/M%08x/tfx%u%s", (unsigned long long)(test & 0x7FFFFu), fbmsk,
                      tfx & 3u, tme ? "t" : "");
        if (log.find(tag) == std::string::npos && log.size() < 600u)
            log += tag;
    }

    // " A<a>B<b>C<c>D<d>/fix<FIX>" from the ALPHA register, appended once per distinct value while under 400.
    inline void noteBlend(std::string &log, uint64_t alpha)
    {
        const uint32_t asel = alpha & 3u, bsel = (alpha >> 2) & 3u, csel = (alpha >> 4) & 3u, dsel = (alpha >> 6) & 3u;
        char tag[48];
        std::snprintf(tag, sizeof(tag), " A%uB%uC%uD%u/fix%02llx", asel, bsel, csel, dsel,
                      (unsigned long long)((alpha >> 32) & 0xFFu));
        if (log.find(tag) == std::string::npos && log.size() < 400u)
            log += tag;
    }
}
