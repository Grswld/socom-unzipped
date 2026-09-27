// Sprint 8 Goal 9, the ABOUT page: what this is, what it is built from, where it keeps its two files.
#include "pages.h"

namespace ui
{
    void drawAboutPage(const Ctx &ctx, App &app, const std::vector<Node> &nodes)
    {
        const Rect logs = rectOf(nodes, "about.logs");
        const Rect b = app.frame.body;
        const float x = b.x;
        float y = b.y;

        text(ctx, "SOCOM UNZIPPED", Vec2{x, y}, 34.0f, theme::gold, Face::Display);
        y += 44.0f;
        text(ctx, app.version.empty() ? "development build" : app.version.c_str(), Vec2{x, y}, metrics::bodySize - 1.0f, theme::caption);
        y += 34.0f;
        text(ctx, "SOCOM II: U.S. Navy SEALs, recompiled for the PC. Not affiliated with Sony or Zipper Interactive.",
             Vec2{x, y}, 17.0f, theme::text);
        y += 26.0f;
        text(ctx, "The game's disc image is yours and stays yours: nothing from it ships here.",
             Vec2{x, y}, 17.0f, theme::text);

        // Sprint 13 V8 review: the credits grew by a row, and the flow ran under OPEN LOGS (b.bottom() - 48); the
        // gaps and the credit pitch are tightened so the last line ends above b.bottom() - 56 at the design size.
        y += 30.0f;
        text(ctx, "BUILT FROM", Vec2{x, y}, 15.0f, theme::dim, Face::Bold);
        y += 22.0f;
        // Two columns on the same grid: what it is on the left, the licence it carries on the right, as the
        // SPDX id THIRD_PARTY_NOTICES.md gives it. Sprint 13 V8 (stranger audit row 14): this credited SDL2, which
        // does not ship, and left out Dear ImGui, libjxl, libwebp and Brotli, which do. One row per licence;
        // test_third_party_notices.py holds these rows and the notices' "yes" rows to each other (winpthreads
        // is "when the closure needs it", and nothing imports it today: scripts/make_portable.sh).
        static const char *credits[][2] = {
            {"the PS2Recomp fork", "GPL-3.0-only"},
            {"raylib (window, input, audio), rlImGui, zlib", "Zlib"},
            {"FFmpeg (video)", "LGPL-3.0-or-later"},
            {"libjxl, libwebp (via FFmpeg)", "BSD-3-Clause"},
            {"Dear ImGui, Brotli", "MIT"},
            {"libc++, libunwind (LLVM)", "Apache-2.0 WITH LLVM-exception"},
            {"Saira Stencil One, Rajdhani (type)", "OFL-1.1"},
        };
        for (const auto &line : credits)
        {
            text(ctx, line[0], Vec2{x, y}, 16.0f, theme::text);
            text(ctx, line[1], Vec2{x + 300.0f, y}, 16.0f, theme::dim);
            y += 20.0f;
        }
        text(ctx, "Every licence text ships in LICENSES/ next to the game.", Vec2{x, y}, 15.0f, theme::dim);

        y += 26.0f;
        text(ctx, "WHERE THINGS LIVE", Vec2{x, y}, 15.0f, theme::dim, Face::Bold);
        y += 24.0f;
        text(ctx, "config", Vec2{x, y}, 16.0f, theme::dim);
        text(ctx, ellipsizeStart(ctx, app.configPath, logs.w * 2.6f, 16.0f).c_str(), Vec2{x + 80.0f, y}, 16.0f, theme::text);
        y += 20.0f;
        // Sprint 10 Goal 9, R179: the one file a player might hand to someone else, and what is in it. Sprint 16 L1b:
        // the password only until the game remembers it on the card.
        text(ctx, "server, persona, and a typed password until the game remembers it -- in plain text", Vec2{x + 80.0f, y}, 14.0f, theme::dim);
        y += 22.0f;
        text(ctx, "logs", Vec2{x, y}, 16.0f, theme::dim);
        text(ctx, ellipsizeStart(ctx, app.logsPath, logs.w * 2.6f, 16.0f).c_str(), Vec2{x + 80.0f, y}, 16.0f, theme::text);
        y += 28.0f;
        text(ctx, "Nothing is installed; delete the folder to remove it.", Vec2{x, y}, 17.0f, theme::goldHi, Face::Bold);

        if (button(ctx, logs, "OPEN LOGS", "about.logs"))
            app.requestOpenLogs = true;
    }
}
