#pragma once
// Issue #74 (owner, 2026-09-26: "launcher controller buttons on hover should show a tooltip for what they do"):
// a one-line tooltip for a control, in the launcher's own voice -- what it does and, where it applies, what its
// current value means. Two ways to see it: the mouse resting on a control for kTipDelaySeconds draws it beside
// the control, and the keyboard or pad focus puts the same line in the bottom bar, so a pad-driven launcher gets
// the text too.
//
// This is not focus.h's helpFor. That is the two-line "?" answer in the title strip, for the few controls a
// stranger has a real question about; this is the one line EVERY control on a page carries.
//
// The strings live with the page that draws the control, one table per page (page_<slug>_tips.cpp beside
// page_<slug>.cpp). Each table is pure -- no raylib -- so a test walks the page's own focus list and holds
// every control to a line. A page without its own file has an empty table: the mechanism is there, and the
// footer and the hover simply show nothing for it.
#include "bind_flow.h"
#include "focus.h"
#include "glyphs.h"
#include "launcher/launcher_config.h"

#include <cstddef>
#include <string>
#include <vector>

namespace ui
{
    // What a line may say about "now": the settings, the pad in the player's hands (its own button names), and
    // the bind flow (a dialog's buttons mean different things in a conflict and in a restore). Null pointers read
    // as the defaults, so a caller with nothing to hand still gets a line.
    struct TipState
    {
        const launcher::Config *config = nullptr;
        GlyphFamily family = GlyphFamily::Xbox;
        const BindFlow *bind = nullptr;
    };

    // One row: a control's id, or a prefix ending in '.' for a family of them ("pad.crouch." is the four crouch
    // cells). `text` is the line; `live`, when set, builds it instead -- a line that names the current value.
    struct TipRow
    {
        const char *id;
        const char *text;
        std::string (*live)(const std::string &id, const TipState &state);
    };

    struct TipTable
    {
        const TipRow *rows = nullptr;
        std::size_t count = 0;
    };

    // Each page's own table (page_controller_tips.cpp for CONTROLLER); an empty one for a page that has none yet.
    TipTable tipTable(Page page);
    TipTable controllerTips();

    // The line for `id` on `page`: the page's table first, then the bottom bar's (LAUNCH is on every page).
    // "" when nothing answers -- the footer and the hover then show nothing, never a placeholder.
    std::string tipFor(Page page, const std::string &id, const TipState &state);

    // One line: the footer's slot is one line wide and the hover box is one line tall. The test holds every
    // CONTROLLER line under this.
    constexpr std::size_t kTipMaxChars = 110;

    // "About half a second" over one control before the box appears.
    constexpr double kTipDelaySeconds = 0.5;

    // The hover timer. Fed the control under the mouse every frame ("" for none); the clock restarts whenever
    // that changes, so sweeping across a row shows nothing until the mouse rests.
    struct HoverTip
    {
        std::string id;
        double since = 0.0;

        void update(const std::string &over, double now);
        bool shows(double now) const;
    };

    // The node under `at` (the first in the list, which is reading order), or "" for none.
    std::string nodeAt(const std::vector<Node> &nodes, Vec2 at);

    // Where the hover box goes: under the control, left edges aligned, and kept inside `window` -- above the
    // control when there is no room below, slid left when it would run off the right edge.
    Rect tipBox(Rect control, float w, float h, Rect window);
}
