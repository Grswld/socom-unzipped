#pragma once

// Sprint 17 F1 attempt 2: the two tags setupDrawState writes for the [gs-gl stats] states= and blends= fields.
//
// executeCommands prints those two logs (and clears them) only under PS2X_GS_STATS, every 60 command buffers;
// before attempt 2 setupDrawState formatted both tags with snprintf and searched the logs for them on every
// draw whatever the knob said -- formatting nobody read (the task book's "unconditional formatting", setup=).
// Now it calls these only when enabled() says the line will print them, or when PS2X_GS_SETUP_FORMAT=1
// restores the old per-draw formatting for the A/B. Pure functions, so ps2x_tests checks the decision and the
// tags without a GL context.

#include "ps2x/knobs.h"

#include <cstdint>
#include <cstdio>
#include <string>

namespace GsGlStateTags
{
    // `statsKnob`: ps2x::knob("PS2X_GS_STATS") -- a Presence knob, so any value (0 too) turns the line on.
    // `setupFormatOn(dflt)`: reads the PS2X_GS_SETUP_FORMAT flag by the one flag rule with `dflt` for unset --
    // setupDrawState passes ps2x::knobOn on that name, the test passes ps2x::knobs::flagValue on a planted value.
    // Three-way so the A/B can be read under PS2X_GS_STATS (the [gs-submit] setup= column prints only there):
    // unset follows PS2X_GS_STATS; 0/false/off never formats (the stats line's states= and blends= print empty);
    // anything else formats on every draw, as before attempt 2. The production line calls this, so the case pins it.
    template<typename SetupFormatOn>
    inline bool enabled(const char *statsKnob, SetupFormatOn setupFormatOn)
    {
        return setupFormatOn(statsKnob != nullptr);
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
