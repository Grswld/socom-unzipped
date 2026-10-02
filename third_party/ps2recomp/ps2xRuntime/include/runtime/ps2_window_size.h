#pragma once
// PS2X_WINDOW_SIZE (Task 8b, the launcher's window-size choice): "<w>x<h>" opens the host window at that size,
// "fullscreen" opens it borderless over the desktop; anything else (or unset) keeps the runtime's default, which
// the parity gate depends on (640x448 client area).
#include <cstdint>

namespace ps2_window
{
    struct Size
    {
        int width = 0;
        int height = 0;
        bool borderless = false;
        bool set = false;   // false: the spec was empty or malformed; keep the defaults
    };

    inline Size parseWindowSize(const char *spec, int defaultWidth, int defaultHeight)
    {
        Size s;
        s.width = defaultWidth;
        s.height = defaultHeight;
        if (!spec || !*spec)
            return s;
        // "fullscreen", any case
        {
            const char *f = "fullscreen";
            const char *q = spec;
            bool same = true;
            for (; *f && *q; ++f, ++q)
                if ((*q | 0x20) != *f)
                {
                    same = false;
                    break;
                }
            if (same && !*f && !*q)
            {
                s.set = true;
                s.borderless = true;
                return s;
            }
        }
        // "<w>x<h>": decimal digits, one x or X, decimal digits, nothing else
        long w = 0, h = 0;
        const char *q = spec;
        int digits = 0;
        for (; *q >= '0' && *q <= '9'; ++q, ++digits)
            w = w * 10 + (*q - '0');
        if (digits == 0 || (*q != 'x' && *q != 'X'))
            return s;
        ++q;
        digits = 0;
        for (; *q >= '0' && *q <= '9'; ++q, ++digits)
            h = h * 10 + (*q - '0');
        if (digits == 0 || *q != '\0')
            return s;
        if (w < 64 || h < 64 || w > 16384 || h > 16384)
            return s;
        s.set = true;
        s.width = static_cast<int>(w);
        s.height = static_cast<int>(h);
        return s;
    }

    // The macOS port: with every display asleep (or none attached) GLFW finds no monitor, raylib 5.5's InitWindow
    // ignores the failure and calls a GL that was never loaded. `awakeDisplays` is ps2x_host::awakeDisplayCount():
    // refuse only when it is known to be zero; -1 (no query on this platform) lets InitWindow try, as before.
    inline bool noDisplayToOpen(int awakeDisplays)
    {
        return awakeDisplays == 0;
    }
}
