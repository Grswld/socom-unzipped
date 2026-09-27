// Sprint 8 Goal 9: the layout and the focus model. Pure -- no raylib, no globals, no drawing.
#include "focus.h"

#include "bind_flow.h"                   // Sprint 10 Q4: the window switch's cell ids
#include "launcher/launcher_config.h"   // which server presets can be played at all

#include <algorithm>
#include <cmath>
#include <cstdlib>

namespace ui
{
    namespace
    {
        struct PageInfo
        {
            const char *name;
            const char *title;
            const char *id;
        };

        const PageInfo kPages[kPageCount] = {
            {"PLAY", "PLAY -- the state of the game and the button that starts it", "rail.play"},
            {"DISC", "DISC -- your SOCOM II image, checked file by file", "rail.disc"},
            {"VIDEO", "VIDEO -- detail, filtering and the window the game opens", "rail.video"},
            {"AUDIO", "AUDIO -- how loud the game is", "rail.audio"},
            {"CONTROLLER", "CONTROLLER -- what the game will read from your pad", "rail.controller"},
            {"MICROPHONE", "MICROPHONE -- the capture device, and proof it hears you", "rail.microphone"},
            {"ONLINE", "ONLINE -- the server, your profile, a second instance", "rail.online"},
            {"REPORT A BUG", "REPORT A BUG -- tell us what went wrong; nothing is sent until you press SEND", "rail.report"},
            {"ABOUT", "ABOUT -- what this is, where it keeps things", "rail.about"},
        };

        void add(std::vector<Node> &out, Page page, const std::string &id, Rect r)
        {
            out.push_back(Node{id, r, page, false});
        }

        // Task 11: the GAME VERSION cells. 176 is what holds "r0004 (community update)" unellipsized at
        // the design size and still leaves the ONLINE row room for the note beside it.
        constexpr float kRevisionCellW = 176.0f;

        // ONLINE's row sits between the server list and the fields under it. Sprint 10 Goal 9 had already
        // filled that page to the design height -- the second-instance toggle's caption ends 4 units above
        // the body's floor, and a test holds it there -- so the row could not simply be inserted: the
        // field pitch and the two gaps below it gave up the 34 units it needed. Nothing was moved above
        // the fold, so the preset rows (and their test) are untouched.
        float onlineRevisionRowY(Rect window)
        {
            return onlinePresetRow(window, static_cast<int>(launcher::kServerPresetCount) - 1).bottom() + 10.0f;
        }

        // One focusable cell per game version that can actually be started -- by the TABLE, not by a pair
        // of ifs (Sprint 11 review, Important 1). A version whose executable is missing is drawn greyed by
        // the page and is deliberately not a node, so the pad cannot reach a game that is not there; and a
        // cell with no room to be drawn is not a node either, so no window can leave a focusable control
        // that nothing paints (review, Minor 9).
        void addRevisionCells(std::vector<Node> &out, Page page, Rect window, const LayoutInputs &in)
        {
            for (size_t i = 0; i < launcher::kGameRevisionCount; ++i)
            {
                const Rect r = revisionCell(window, page, static_cast<int>(i));
                if (launcher::gameRevisionAvailable(i, in.gameRevisionsInstalled) && drawable(r))
                    add(out, page, pageSlug(page) + ".revision." + std::to_string(i), r);
            }
        }

        // Sprint 10 Goal 8: the BUTTONS grid's order -- bind_flow.cpp's kCells, which the tests hold equal to this.
        uint8_t bindCellButtonId(int cell)
        {
            using namespace launcher::mapping;
            static const uint8_t order[16] = {
                kPs2Cross, kPs2Circle, kPs2Square, kPs2Triangle,
                kPs2L1, kPs2R1, kPs2L2, kPs2R2,
                kPs2Up, kPs2Down, kPs2Left, kPs2Right,
                kPs2Select, kPs2Start, kPs2L3, kPs2R3,
            };
            return cell >= 0 && cell < 16 ? order[cell] : kPs2Cross;
        }

        // A row of `n` equal cells across `r`, with a gap between them: the grid the radio rows sit on.
        Rect cell(Rect r, int index, int n, float gap = 10.0f)
        {
            const float w = (r.w - gap * static_cast<float>(n - 1)) / static_cast<float>(n);
            return Rect{r.x + (w + gap) * static_cast<float>(index), r.y, w, r.h};
        }
    }

    Page pageAt(int index)
    {
        if (index < 0)
            index = 0;
        if (index >= kPageCount)
            index = kPageCount - 1;
        return static_cast<Page>(index);
    }

    int pageIndex(Page page) { return static_cast<int>(page); }
    const char *pageName(Page page) { return kPages[pageIndex(page)].name; }
    const char *pageTitle(Page page) { return kPages[pageIndex(page)].title; }
    std::string railId(Page page) { return kPages[pageIndex(page)].id; }

    std::string pageSlug(Page page) { return railId(page).substr(5); }

    std::string barLaunchId(Page page) { return "bar.launch." + pageSlug(page); }

    Rect barLaunchRect(const Frame &f) { return Rect{f.bar.right() - metrics::margin - 220.0f, f.bar.y + 10.0f, 220.0f, 36.0f}; }

    Frame frameFor(Rect window)
    {
        using namespace metrics;
        Frame f;
        f.window = window;
        f.header = Rect{0.0f, 0.0f, window.w, barH};              // the launcher's own title bar
        f.bar = Rect{0.0f, window.h - bottomH, window.w, bottomH};
        f.rail = Rect{0.0f, barH, railW, window.h - barH - bottomH};
        f.content = Rect{railW + margin, barH + 20.0f, window.w - railW - margin - margin,
                         (window.h - bottomH - 16.0f) - (barH + 20.0f)};
        f.band = Rect{f.content.x + 2.0f, f.content.y + 2.0f, f.content.w - 4.0f, bandH};
        // The body starts metrics::bodyTop under the panel's top: the strip, its rule, and a clear gap
        // (owner, 2026-09-20: "the top padding may need to be applied to all pages" -- a row at b.y sat
        // two units under the rule and its focus outline touched it). One number here, not one per page.
        f.body = Rect{f.content.x + 20.0f, f.content.y + metrics::bodyTop, f.content.w - 40.0f,
                      f.content.h - metrics::bodyTop - 20.0f};
        return f;
    }

    std::vector<Node> railLayout(Rect window)
    {
        const Frame f = frameFor(window);
        std::vector<Node> out;
        for (int i = 0; i < kPageCount; ++i)
        {
            const Page p = pageAt(i);
            const Rect r{12.0f, f.rail.y + metrics::railTop + static_cast<float>(i) * (metrics::railRowH + metrics::railGap),
                         metrics::railW - 24.0f, metrics::railRowH};
            out.push_back(Node{railId(p), r, p, true});
        }
        return out;
    }

    std::vector<Node> layoutFor(Page page, Rect window, const LayoutInputs &in)
    {
        const Frame f = frameFor(window);
        const Rect b = f.body;
        std::vector<Node> out;

        switch (page)
        {
        case Page::Play:
        {
            // Four rows that say what the game is about to do, each one a jump to the page that changes it.
            for (int i = 0; i < 4; ++i)
            {
                static const char *ids[] = {"play.disc", "play.video", "play.pad", "play.server"};
                add(out, page, ids[i], Rect{b.x, b.y + 4.0f + static_cast<float>(i) * 66.0f, b.w, 56.0f});
            }
            // Task 11: what LAUNCH will start, just above the button that starts it.
            addRevisionCells(out, page, window, in);
            const float y = b.bottom() - 64.0f;
            add(out, page, "play.launch", Rect{b.x, y, 300.0f, 64.0f});
            add(out, page, "play.diagnostics", Rect{b.x + 320.0f, y + 12.0f, 200.0f, 40.0f});
            add(out, page, "play.logs", Rect{b.x + 536.0f, y + 12.0f, 150.0f, 40.0f});
            break;
        }
        case Page::Disc:
        {
            add(out, page, "disc.path", Rect{b.x + metrics::labelW, b.y + 8.0f, b.w - metrics::labelW - 140.0f, 40.0f});
            add(out, page, "disc.browse", Rect{b.right() - 128.0f, b.y + 8.0f, 128.0f, 40.0f});
            add(out, page, "disc.verify", Rect{b.x + metrics::labelW, b.y + 150.0f, 200.0f, 40.0f});
            break;
        }
        case Page::Video:
        {
            const float rowStep = metrics::rowH + 22.0f;
            const Rect ctrl0{b.x + metrics::labelW, b.y + 6.0f, b.w - metrics::labelW, 44.0f};
            for (int i = 0; i < 4; ++i)
                add(out, page, "video.detail." + std::to_string(i), cell(ctrl0, i, 4));
            Rect ctrl1 = ctrl0;
            ctrl1.y += rowStep;
            for (int i = 0; i < 3; ++i)
                add(out, page, "video.filter." + std::to_string(i), cell(ctrl1, i, 3));
            Rect ctrl2 = ctrl0;
            ctrl2.y += rowStep * 2.0f;
            for (int i = 0; i < 4; ++i)
                add(out, page, "video.window." + std::to_string(i), cell(ctrl2, i, 4));
            add(out, page, "video.fps", Rect{ctrl0.x, ctrl0.y + rowStep * 3.0f, b.w - metrics::labelW, 40.0f});
            break;
        }
        case Page::Audio:
        {
            add(out, page, "audio.volume", Rect{b.x + metrics::labelW, b.y + 22.0f, b.w - metrics::labelW - 90.0f, 32.0f});
            // Sprint 10 Q4: the launcher's own sounds, under the slider's scale and its two caption lines.
            add(out, page, "audio.sounds", Rect{b.x + metrics::labelW, b.y + 150.0f, b.w - metrics::labelW, 40.0f});
            break;
        }
        case Page::Controller:
        {
            // Under the drawn pad and its legend: the section switch, then the section. 300, not 330: Sprint 10
            // Goal 8 took 20 from the pad's band (page_controller.cpp draws it 262 tall) and 10 from the gap for
            // the section row. The row is at the same place in both sections, so the pad above never moves.
            const float below = b.y + 300.0f;
            if (in.padButtons && in.padDialogButtons > 0)
            {
                // A dialog: its buttons are the ONLY controls on the page. Nothing behind it can be focused or
                // activated, and the section switch waits until it is answered.
                const int n = in.padDialogButtons > 3 ? 3 : in.padDialogButtons;
                for (int i = 0; i < n; ++i)
                    add(out, page, "pad.dialog." + std::to_string(i), Rect{b.x + 20.0f + static_cast<float>(i) * 180.0f, below + 110.0f, 160.0f, 36.0f});
                break;
            }
            add(out, page, "pad.section.0", Rect{b.x, below, 150.0f, 28.0f});
            add(out, page, "pad.section.1", Rect{b.x + 160.0f, below, 150.0f, 28.0f});
            const float top = below + 40.0f;
            if (!in.padButtons)
            {
                const int pads = in.padChoices < 1 ? 1 : in.padChoices;
                for (int i = 0; i < pads; ++i)
                    add(out, page, "pad.pick." + std::to_string(i), Rect{b.x, top + static_cast<float>(i) * 30.0f, 400.0f, 26.0f});
                const float rx = b.x + 440.0f;
                const float rw = b.w - 440.0f;
                // Sprint 10 Q3 (R210): the dead zone alone -- the mouse-look toggle and its sensitivity slider left.
                add(out, page, "pad.deadzone", Rect{rx, top, rw, 28.0f});
                break;
            }
            // BUTTONS: RESTORE at the switch row's right end; the sixteen cells four across and four down; the
            // crouch row (R139) last, in the label column's grid like every other row with a label.
            // Sprint 10 Q4: the WINDOW SWITCH cell and its OFF sit on the section row between the section
            // switch and RESTORE -- the one strip of BUTTONS with room, and a binding belongs with the bindings.
            add(out, page, kSwitchCellId, Rect{b.x + 322.0f, below, 190.0f, 28.0f});
            add(out, page, kSwitchOffId, Rect{b.x + 522.0f, below, 50.0f, 28.0f});
            add(out, page, "pad.restore", Rect{b.right() - 200.0f, below, 200.0f, 28.0f});
            const Rect grid{b.x, top, b.w, 24.0f};
            for (int i = 0; i < 16; ++i)
            {
                Rect r = cell(grid, i % 4, 4);
                r.y += static_cast<float>(i / 4) * 28.0f;
                out.push_back(Node{"pad.bind." + std::string(launcher::mapping::ps2ButtonName(bindCellButtonId(i))), r, page, false});
            }
            const Rect crouch{b.x + metrics::labelW, top + 4.0f * 28.0f + 6.0f, b.w - metrics::labelW, 26.0f};
            for (int i = 0; i < 4; ++i)
                add(out, page, "pad.crouch." + std::to_string(i), cell(crouch, i, 4));
            break;
        }
        case Page::Microphone:
        {
            const int mics = in.micChoices < 1 ? 1 : in.micChoices;
            for (int i = 0; i < mics; ++i)
                add(out, page, "mic.pick." + std::to_string(i), Rect{b.x, b.y + 26.0f + static_cast<float>(i) * 32.0f, 400.0f, 28.0f});
            add(out, page, "mic.rescan", Rect{b.right() - 140.0f, b.y + 22.0f, 140.0f, 36.0f});
            break;
        }
        case Page::Online:
        {
            for (size_t i = 0; i < launcher::kServerPresetCount; ++i)
                if (launcher::presetAvailable(launcher::kServerPresets[i]))
                    add(out, page, "online.preset." + std::to_string(i), onlinePresetRow(window, static_cast<int>(i)));
            // Below the LAST row, whatever the count is -- the literal 3 here is what a fourth preset
            // would have been drawn on top of (Sprint 9 P6).
            // Sprint 10 Goal 9: five rows under the presets now (address, profile, name, password, ADVANCED),
            // on the REPORT page's 12-px pitch rather than the old 16, so the open ADVANCED section and its
            // caption still end inside the body at the design size (the small window scrolls, as before).
            // Task 11: the GAME VERSION row, between the server list and the fields -- the server and the
            // build have to agree, so the two choices sit together and the warning between them is short.
            addRevisionCells(out, page, window, in);
            const float y = revisionCell(window, page, 0).bottom() + 10.0f;
            if (in.customServer)
                add(out, page, "online.server", Rect{b.x + metrics::labelW, y, 420.0f, 40.0f});
            add(out, page, "online.profile", Rect{b.x + metrics::labelW, y + kOnlineRowPitch, 300.0f, 40.0f});
            // Sprint 10 Goal 9: the persona and its password, under the profile that keeps the card.
            add(out, page, "online.name", Rect{b.x + metrics::labelW, y + 2.0f * kOnlineRowPitch, 300.0f, 40.0f});
            add(out, page, "online.password", Rect{b.x + metrics::labelW, y + 3.0f * kOnlineRowPitch, 300.0f, 40.0f});
            // Sprint 9 P4: everything a stranger needs is above this line; the disclosure and what it
            // reveals are below it, last in reading order and last in the focus order.
            // Task 11 moved these two up (212 -> 188, 252 -> 224) to pay for the row above; the gaps they
            // keep -- 10 under the password, 8 under the header -- are what fits at the design height.
            add(out, page, "online.advanced", Rect{b.x, y + 188.0f, b.w, 28.0f});
            if (in.advancedOpen)
                add(out, page, "online.second", Rect{b.x + metrics::labelW, y + 224.0f, 460.0f, 34.0f});
            break;
        }
        case Page::Report:
        {
            // The site's own form, top to bottom (sites/s2u/src/report.ts FIELDS), plus the log checkbox.
            const float x = b.x + metrics::labelW;
            const float w = b.w - metrics::labelW;
            add(out, page, "report.title", Rect{x, b.y + 4.0f, w, 40.0f});
            add(out, page, "report.description", Rect{x, b.y + 56.0f, w, 148.0f});
            add(out, page, "report.contact", Rect{x, b.y + 216.0f, 420.0f, 40.0f});
            add(out, page, "report.attach", Rect{x, b.y + 268.0f, 420.0f, 34.0f});
            add(out, page, "report.send", Rect{x, b.y + 384.0f, 240.0f, 44.0f});
            break;
        }
        case Page::About:
        {
            add(out, page, "about.logs", Rect{b.x, b.bottom() - 48.0f, 200.0f, 40.0f});
            break;
        }
        }

        // The bottom bar's LAUNCH belongs to every page but PLAY, which has its own large one: there the bar
        // carries the run's state instead of the same button twice.
        if (page != Page::Play)
            add(out, page, barLaunchId(page), barLaunchRect(f));
        return out;
    }

    namespace
    {
        struct Help
        {
            const char *id;
            const char *text;
        };

        // Kept short enough to read in one glance under the page. Each one answers a question a stranger
        // actually has on their first run -- not a restatement of the label above it.
        const Help kHelp[] = {
            {"online.profile",
             "A profile is one save: it picks the memory card kept in cards/<profile>, and it is the persona "
             "other players see online. Change it and you start again on a fresh card."},
            {"online.server",
             "Which Horizon server the game logs in to. The project hosts one; a different address is for a "
             "server you run yourself."},
            {"online.second",
             "Starts a second copy of the game on this machine, on its own ports and its own memory card, so "
             "two players here can meet in the same match. For testing."},
            // Sprint 10 Goal 9 (R179, R180): the game's keyboards open already holding these; ENTER is the player's.
            {"online.name",
             "The persona other players see, and the name the game logs in with. Leave it empty and the game "
             "asks on its own keyboard, as it always did. Up to 14 characters, no spaces."},
            {"online.password",
             "The persona's password, up to 12 characters. Kept in config.json next to the launcher, in plain "
             "text, masked here; the game's keyboard opens with it already typed and you press ENTER."},
            {"disc.path",
             "Your own SOCOM II disc image. Nothing from the game is shipped with this program, so it reads "
             "the movies, sounds and levels out of the file you point it at."},
            {"pad.deadzone",
             "How far a stick must move before the game sees it at all. Raise it if your aim drifts while you "
             "are not touching the stick."},
            {"report.attach",
             "Sends the last run's log with your report. It is cut to the last 64 KB and your home folder's "
             "name is taken out of it; the line above says exactly how much will go."},
            // Sprint 10 Goal 8, R139: the analogue truth. SOCOM II reads how HARD Triangle is pressed; a pad
            // button is always a full press, so the cell cannot give a player crouch -- the row under it can.
            {"pad.bind.triangle",
             "The game reads how hard Triangle is pressed: a light press crouches, a firm one goes prone. A pad "
             "button is always firm, so crouch is the CROUCH row below, not this cell."},
            {"pad.restore",
             "Puts every button back to the defaults for this profile. It asks first, and the answer it lands on "
             "is CANCEL."},
            // Sprint 10 Q4: the window switch. What it does, and the one platform fact a player will hit: an Xbox
            // pad's guide button is hidden by Windows' XInput, so the launcher asks for it another way; if that
            // way is missing on their machine, this cell is where they put the switch on a button that works.
            {"pad.switch.bind",
             "While the game runs, this pad button brings the launcher in front of it, and again sends the game "
             "back. The XBOX / PS button by default. Press to bind another one; the game never reads it."},
            {"pad.switch.off",
             "Turns the window switch off: no pad button swaps the windows, and the XBOX / PS button is left to "
             "whatever else listens for it (Steam, the Xbox Game Bar)."},
            // Sprint 10 Q4: where the launcher's sounds come from, and why there are none before a disc is set.
            {"audio.sounds",
             "The game's own menu clicks, read out of YOUR disc image the first time it is verified and kept in "
             "cache/ next to this program. Nothing ships with the download, so with no disc set there is silence."},
        };
    }

    std::string helpFor(const std::string &id)
    {
        for (const Help &h : kHelp)
            if (id == h.id)
                return h.text;
        // The crouch cells: each one's trade, the line the page's caption used to carry (R139).
        if (id.rfind("pad.crouch.", 0) == 0)
        {
            const int i = std::atoi(id.c_str() + 11);
            if (i >= 0 && i < launcher::kCrouchShortcutCount)
                return launcher::crouchShortcutHint(launcher::kCrouchShortcuts[i]);
        }
        return std::string();
    }

    std::vector<std::string> helpedIds()
    {
        std::vector<std::string> out;
        out.reserve(sizeof(kHelp) / sizeof(kHelp[0]) + 4);
        for (const Help &h : kHelp)
            out.push_back(h.id);
        for (int i = 0; i < launcher::kCrouchShortcutCount; ++i)
            out.push_back("pad.crouch." + std::to_string(i));
        return out;
    }

    bool advancedForced(const launcher::Config &c)
    {
        // One line today. Every setting that moves into an ADVANCED section joins this disjunction, and the
        // test that pins the rule joins it with them.
        return c.secondInstance;
    }

    std::vector<Node> nodesForFrame(std::vector<Node> computed, Page page, Rect window, const LayoutInputs &in)
    {
        // Every node a page's layout emits carries that page, so the front one answers whose list this is.
        if (!computed.empty() && computed.front().page == page)
            return computed;
        return layoutFor(page, window, in);
    }

    // The ONLINE page's field pitch: a 40-px field and a 6-px gap. It was the REPORT page's 12 (Sprint 10
    // Goal 9) until Task 11 put the GAME VERSION row above these fields; the page was already full to the
    // design height, so the row is paid for out of this pitch and the two gaps below the password.
    const float kOnlineRowPitch = 46.0f;

    Rect onlinePresetRow(Rect window, int index)
    {
        const Frame f = frameFor(window);
        return Rect{f.body.x, f.body.y + 26.0f + static_cast<float>(index) * 38.0f, f.body.w, 32.0f};
    }

    // Task 11. The two pages place the row differently because they are shaped differently: PLAY anchors it
    // to the LAUNCH button (the page's bottom block is what the row belongs to -- it says what LAUNCH will
    // start), and ONLINE puts it under the server list, where the choice it interacts with is.
    Rect revisionCell(Rect window, Page page, int index)
    {
        const Frame f = frameFor(window);
        const float w = kRevisionCellW, gap = 10.0f;
        const float x = f.body.x + (page == Page::Online ? metrics::labelW : 0.0f) +
                        static_cast<float>(index) * (w + gap);
        if (page == Page::Online)
            return Rect{x, onlineRevisionRowY(window), w, 24.0f};
        // PLAY: above LAUNCH (body.bottom() - 64, as the page lays it out), clear of the LAST RUN line.
        return Rect{x, f.body.bottom() - 140.0f, w, 30.0f};
    }

    Rect rectOf(const std::vector<Node> &nodes, const std::string &id)
    {
        for (const Node &n : nodes)
            if (n.id == id)
                return n.r;
        return Rect{};
    }

    bool hasNode(const std::vector<Node> &nodes, const std::string &id)
    {
        for (const Node &n : nodes)
            if (n.id == id)
                return true;
        return false;
    }

    FocusGraph FocusGraph::build(Rect window, const LayoutInputs &in)
    {
        FocusGraph g;
        g.m_nodes = railLayout(window);
        for (int i = 0; i < kPageCount; ++i)
        {
            const std::vector<Node> page = layoutFor(pageAt(i), window, in);
            g.m_nodes.insert(g.m_nodes.end(), page.begin(), page.end());
        }
        return g;
    }

    const Node *FocusGraph::find(const std::string &id) const
    {
        for (const Node &n : m_nodes)
            if (n.id == id)
                return &n;
        return nullptr;
    }

    std::vector<std::string> FocusGraph::idsOn(Page page) const
    {
        std::vector<std::string> out;
        for (const Node &n : m_nodes)
            if (!n.rail && n.page == page)
                out.push_back(n.id);
        return out;
    }

    std::string FocusGraph::firstOn(Page page) const
    {
        for (const Node &n : m_nodes)
            if (!n.rail && n.page == page)
                return n.id;
        return railId(page);
    }

    std::string FocusGraph::move(const std::string &from, Dir dir) const
    {
        const Node *f = find(from);
        if (f == nullptr)
            return from;

        if (f->rail)
        {
            const int i = pageIndex(f->page);
            switch (dir)
            {
            case Dir::Up:
                return railId(pageAt(i - 1 < 0 ? 0 : i - 1));
            case Dir::Down:
                return railId(pageAt(i + 1 >= kPageCount ? kPageCount - 1 : i + 1));
            case Dir::Right:
                return firstOn(f->page);
            case Dir::Left:
                return from;
            }
            return from;
        }

        // Inside a page: the nearest node that way, preferring one whose band overlaps this control's.
        auto scan = [&](bool requireOverlap) -> std::string
        {
            std::string best;
            float bestScore = 0.0f;
            for (const Node &n : m_nodes)
            {
                if (n.rail || n.page != f->page || n.id == f->id)
                    continue;
                float primary = 0.0f, perp = 0.0f;
                bool overlap = false;
                switch (dir)
                {
                case Dir::Right:
                    primary = n.r.cx() - f->r.cx();
                    perp = std::fabs(n.r.cy() - f->r.cy());
                    overlap = n.r.bottom() > f->r.y && n.r.y < f->r.bottom();
                    break;
                case Dir::Left:
                    primary = f->r.cx() - n.r.cx();
                    perp = std::fabs(n.r.cy() - f->r.cy());
                    overlap = n.r.bottom() > f->r.y && n.r.y < f->r.bottom();
                    break;
                case Dir::Down:
                    primary = n.r.cy() - f->r.cy();
                    perp = std::fabs(n.r.cx() - f->r.cx());
                    overlap = n.r.right() > f->r.x && n.r.x < f->r.right();
                    break;
                case Dir::Up:
                    primary = f->r.cy() - n.r.cy();
                    perp = std::fabs(n.r.cx() - f->r.cx());
                    overlap = n.r.right() > f->r.x && n.r.x < f->r.right();
                    break;
                }
                if (primary <= 1.0f)
                    continue;
                if (requireOverlap && !overlap)
                    continue;
                // Sprint 9 Goal 8: a control stacked above or below this one (their spans overlap across the
                // move) is not "to the left" of it merely because it is narrower -- REPORT A BUG is a column
                // of fields of different widths, and left off any of them is the rail.
                if (!overlap && (dir == Dir::Left || dir == Dir::Right) && n.r.right() > f->r.x && n.r.x < f->r.right())
                    continue;
                // Distance in the direction moved dominates: the row under this control wins even when a
                // row further down happens to line up with it exactly (the VIDEO page's cells do).
                const float score = primary * 4.0f + perp;
                if (best.empty() || score < bestScore)
                {
                    best = n.id;
                    bestScore = score;
                }
            }
            return best;
        };

        std::string best = scan(true);
        if (best.empty())
            best = scan(false);
        if (!best.empty())
            return best;
        if (dir == Dir::Left)
            return railId(f->page);   // nothing further left: back out to the rail
        return from;
    }

    void Nav::goTo(const FocusGraph &g, Page p)
    {
        page = p;
        focus = g.firstOn(p);
    }

    void Nav::request(Page p) { requested = pageIndex(p); }

    bool Nav::applyRequest(const FocusGraph &g)
    {
        if (requested < 0)
            return false;
        const Page p = pageAt(requested);
        requested = -1;
        goTo(g, p);
        return true;
    }

    void Nav::move(const FocusGraph &g, Dir d)
    {
        const std::string next = g.move(focus, d);
        focus = next;
        const Node *n = g.find(next);
        if (n != nullptr)
            page = n->page;   // a rail entry IS its page: the highlight and the pane never disagree
    }

    void Nav::back(const FocusGraph &g)
    {
        (void)g;
        focus = railId(page);
    }

    bool Nav::onRail() const { return focus == railId(page); }

    void FocusRing::update(const FocusGraph &g, const std::string &focusId, float dt)
    {
        const Node *n = g.find(focusId);
        if (n == nullptr)
        {
            visible = false;
            return;
        }
        // No travel, by owner's request ("takes too long to adjust and awkwardly flys with a delay"): the
        // ring is the focused control's rect, whole, on the frame the focus changed. `dt` is taken and
        // ignored on purpose, so no frame time can put a delay back without the test noticing.
        (void)dt;
        shown = n->r;
        visible = true;
    }

    std::string launchBlockedReason(bool discOk, bool running, bool isoPathEmpty, const std::string &discMessage)
    {
        if (running)
            return "the game is running";
        if (isoPathEmpty)
            return kDiscNotChosen;
        if (!discOk)
            return discMessage.empty() ? std::string(kDiscNotChecked) : discMessage;
        return std::string();
    }

    bool adjustsHorizontally(const std::string &id)
    {
        return id == "audio.volume" || id == "pad.deadzone";
    }
}
