#pragma once
// Sprint 8 Goal 9: what the pages share -- the whole state of the launcher, and one function per page.
//
// A page never touches the process glue, the microphone or the disc: it reads App and raises a request flag,
// and main.cpp's loop is the only thing that acts on the world.
#include "bind_flow.h"
#include "focus.h"
#include "launcher/bug_report.h"
#include "launcher/launcher_config.h"
#include "launcher/personas.h"   // Sprint 16 L1b (#73): the ONLINE page's PERSONAS list
#include "pad_render.h"
#include "widgets.h"

#include <string>
#include <utility>
#include <vector>

namespace ui
{
    // Sprint 9 Goal 8: the REPORT A BUG page's state. The page edits `form` and raises `requestSend`; the loop
    // owns everything else (the check, the payload, the worker thread, the reply).
    struct ReportUi
    {
        launcher::bugreport::Form form;   // attachLog is OFF by default
        enum class State
        {
            Idle,
            Sending,        // the request is on its worker thread; SEND is disabled
            Sent,           // `id` is the reference
            FieldError,     // `message` says what to fix; the focus went to the field
            RateLimited,    // `message` says when to retry
            SavedLocally    // could not send: `savedPath` is where the report was written
        };
        State state = State::Idle;
        std::string message;
        std::string id;
        std::string savedPath;
        bool copied = false;      // the reference is on the clipboard
        std::string preview;      // what SEND would send, rebuilt by the loop when `changed`
        bool changed = true;
        bool requestSend = false;
    };

    struct App
    {
        launcher::Config config;
        bool dirty = false;   // the unsaved-changes hint (saved on Launch and on close)

        // the disc check
        bool discChecked = false;
        bool discOk = false;
        std::string discMessage;
        // Task 11: whether socom2_r0004.exe sits beside the launcher. Asked of the world ONCE, in main.cpp,
        // and handed down -- a page never touches the disk (and under --screenshot it is fixed, like
        // everything else the walk draws).
        uint32_t gameRevisionsInstalled = 0;

        // the game
        bool running = false;
        // the last thing that happened, in the bottom bar. Set it only through setStatus: statusSerial counts the
        // assignments, so the same sentence said twice (a second launch failing the same way) is news again (#74).
        std::string status;
        unsigned statusSerial = 0;
        void setStatus(std::string line)
        {
            status = std::move(line);
            ++statusSerial;
        }
        std::string exitLine;   // the last run's exit message, on PLAY

        // the pads
        std::vector<std::string> padLabels;   // "first available", then "[0] <name>"
        std::vector<int> padSlots;            // -1, then the slot each label means
        PadSnapshot pad;                      // the one being drawn

        // the microphone
        std::vector<std::string> micLabels;   // "None", then the devices
        bool meterOn = false;
        float micDb = 0.0f;
        bool micDbValid = false;
        std::string micStatus;

        // Sprint 9 Goal 8: the hosted server's status line on ONLINE ("" = unreachable: nothing is drawn),
        // and the REPORT A BUG page
        std::string serverStatus;
        ReportUi report;

        // what ABOUT shows
        std::string configPath, logsPath, version, monitorSize;

        // what the loop must do after this frame (the pages raise these, nothing else)
        bool requestBrowse = false;
        bool requestVerify = false;
        bool requestLaunch = false;
        bool requestDiagnostics = false;
        bool requestOpenLogs = false;
        bool requestMicChanged = false;
        bool requestMicRescan = false;
        bool requestSave = false;   // the top bar's UNSAVED pill
        // Sprint 10 Q4: the AUDIO page's toggle moved; main.cpp (re)loads or drops the cues. The status line under
        // it is the loop's word on where the cues stand ("from your disc", "no disc set: silent", "off").
        bool requestMenuSounds = false;
        std::string menuSoundsStatus;

        // Sprint 16 L1b (#73, R295): the personas every card's ledger holds (read by main.cpp at start and after each
        // run -- a page never touches the disk), the list's scroll, and the clock the rows' ages are measured by.
        launcher::personas::Cards personas;
        int personaScroll = 0;
        long long personasNow = 0;
        // The persona-card plan: NEW PERSONA's creator. The name typed beside it (the password typed is
        // Config::loginPassword); CREATE ON CARD raises requestCreatePersona and main.cpp writes the card. A record
        // picked raises requestPersonaFirst (its row index) and main.cpp puts it first on its card (R-C). A creation
        // that failed leaves its one line in personaNote, shown at the PERSONAS heading's right end until the next try.
        std::string personaNameTyped;
        std::string personaNote;
        bool requestCreatePersona = false;
        int requestPersonaFirst = -1;
        // The review, finding 4: a pick made while the game runs (the game holds the card) is held here and main.cpp
        // puts it first at the next LAUNCH, before the game starts (personas::applyPendingFirst).
        launcher::personas::PendingFirst pendingFirst;

        std::string activeField;   // the text field holding the keyboard, by node id
        Nav nav;
        Frame frame;   // the bands of this frame's window, in design units
        LayoutInputs layout;
        bool padPrompts = false;   // the last input came from a pad: the bar shows its glyphs
        bool fake = false;         // --screenshot: fixed state, no config written, no devices touched
        // Sprint 9 P4: whether the player has opened a page's ADVANCED section this session. Deliberately
        // NOT in Config: which drawers you left open is not a setting, and a launcher that reopens them for
        // a stranger would defeat the point. `advancedForced` can override it -- see focus.h.
        bool advancedOpen = false;
        // Sprint 10 Goal 8: the CONTROLLER page's section (0 SETUP, 1 BUTTONS -- not a setting either) and the
        // bind flow. The page asks for a session with `requestBind` (the PS2 button, or -1) and main.cpp starts
        // it, because only the loop knows which host buttons are down at that moment.
        int padSection = 0;
        BindFlow bind;
        int requestBind = -1;
        // W9 (owner, 2026-09-22): "hold the button to remap the button while on the controller page". The
        // detector is ui::padHold, behind the pad gate in main.cpp; these two are what the page is allowed to
        // know about it -- which host button is building a hold, and how far along it is (0..1). The page
        // draws the progress and names the button; it never reads a pad.
        int holdHost = 0;
        float holdProgress = 0.0f;
    };

    // ---- the shared furniture of a settings page ----------------------------------------------------------
    // Every settings row has the same label column, one metrics::labelW to the left of its control: that is
    // the grid the pages line up on.
    inline void rowLabel(const Ctx &ctx, Rect control, const char *label)
    {
        text(ctx, label, Vec2{control.x - metrics::labelW, control.y + (control.h - metrics::labelSize * 1.12f) * 0.5f},
             metrics::labelSize, theme::dim, Face::Bold, 0.06f);
    }

    inline void caption(const Ctx &ctx, Vec2 at, const char *s)
    {
        text(ctx, s, at, metrics::captionSize, theme::caption);
    }

    // Sprint 9 P4 (owner: "move 'Second instance on this machine (for testing)' into an advanced section").
    // The head of one: a caret, the word, and a rule to the edge of the body. Returns true on the frame it
    // was acted on. `forced` means something inside is not at its default -- it is then drawn open, marked
    // "in use", and refuses to close, because a disclosure that can hide a live setting is a trap.
    inline bool advancedHeader(const Ctx &ctx, Rect r, const std::string &id, bool open, bool forced)
    {
        if (!drawable(r))
            return false;
        const bool live = hovered(ctx, r) || focused(ctx, id);
        const Rgba ink = forced ? theme::gold : (live ? theme::text : theme::dim);
        const float cx = r.x + 7.0f;
        const float cy = r.cy();
        // Wound the way fillQuad documents for this backend -- top-left, then the lower point, then the
        // top-right. The other order draws nothing at all: the first pass of this caret was invisible.
        if (open)   // pointing down: the section below is showing
            fillTriangle(ctx, Vec2{cx - 5.0f, cy - 2.5f}, Vec2{cx, cy + 3.5f}, Vec2{cx + 5.0f, cy - 2.5f}, ink);
        else        // pointing right: there is more this way
            fillTriangle(ctx, Vec2{cx - 2.5f, cy - 5.0f}, Vec2{cx - 2.5f, cy + 5.0f}, Vec2{cx + 3.5f, cy}, ink);

        const float wordX = r.x + 20.0f;
        text(ctx, "ADVANCED", Vec2{wordX, r.y + (r.h - metrics::labelSize * 1.12f) * 0.5f}, metrics::labelSize, ink,
             Face::Bold, 0.12f);
        float ruleRight = r.right();
        if (forced)
        {
            const char *note = "in use";
            const float noteW = textWidth(ctx, note, metrics::captionSize - 1.0f);
            textRightIn(ctx, note, r, metrics::captionSize - 1.0f, theme::gold);
            ruleRight -= noteW + 14.0f;
        }
        const float ruleX = wordX + textWidth(ctx, "ADVANCED", metrics::labelSize, Face::Bold, 0.12f) + 14.0f;
        if (ruleRight > ruleX)
            fillRect(ctx, Rect{ruleX, cy, ruleRight - ruleX, 1.0f}, theme::alpha(theme::line, live ? 220 : 130));

        // A forced-open section still takes the focus (it is a landmark on the page); it just will not shut.
        return hit(ctx, r, id) && !forced;
    }

    // Task 11 (Sprint 11 Goal D): the GAME VERSION selector, drawn the same way on PLAY and on ONLINE.
    // One function, because two copies of a control that must agree about which build the game will start
    // is how they come to disagree. The cell for a version whose executable is missing is DRAWN -- greyed,
    // with the note beside it -- rather than hidden: a player has to learn the version exists and why it is
    // not there, which is the rule the unplayable server preset already follows (page_online.cpp).
    inline void gameVersionRow(const Ctx &ctx, App &app, const std::vector<Node> &nodes, Page page)
    {
        const std::string slug = pageSlug(page);
        const std::string chosen = launcher::normalizeGameRevision(app.config.gameRevision);
        const Rect first = revisionCell(app.frame.window, page, 0);
        if (!drawable(first))
            return;
        // ONLINE keeps its label column -- the row lines up with ADDRESS, PROFILE and the rest, and a
        // heading above the cells would sit inside the last preset row. PLAY has no label column, so its
        // heading goes above, where LAST RUN's does.
        if (page == Page::Online)
            rowLabel(ctx, first, "GAME VERSION");
        else
            text(ctx, "GAME VERSION", Vec2{first.x, first.y - 20.0f}, metrics::labelSize, theme::dim, Face::Bold, 0.06f);

        float right = first.right();
        bool anyGreyed = false;
        for (size_t i = 0; i < launcher::kGameRevisionCount; ++i)
        {
            const launcher::GameRevision &rev = launcher::kGameRevisions[i];
            const bool available = launcher::gameRevisionAvailable(i, app.gameRevisionsInstalled);
            const std::string id = slug + ".revision." + std::to_string(i);
            const Rect r = revisionCell(app.frame.window, page, static_cast<int>(i));
            if (!drawable(r))
                continue;
            right = r.right();
            if (!available)
            {
                anyGreyed = true;
                const Rgba off = theme::mix(theme::dim, theme::ground, 0.45f);
                strokeRect(ctx, r, off, 2.0f);
                const float size = metrics::labelSize + 1.0f;
                textCenteredIn(ctx, ellipsizeEnd(ctx, rev.label, r.w - 16.0f, size, Face::Bold).c_str(), r, size, off,
                               Face::Bold, 0.04f);
                continue;
            }
            if (radioCell(ctx, r, rev.label, id, chosen == rev.id) && chosen != rev.id)
            {
                app.config.gameRevision = rev.id;
                app.dirty = true;
            }
        }

        // Beside the cells: why a greyed one is greyed. The mismatch WARNING is not drawn here -- it is a
        // whole sentence, and on ONLINE this strip is 254 units wide -- so each page places it where it
        // has room (PLAY under the row, ONLINE on the SERVER strip, which is the widest line it has).
        //
        // ONLINE already prints this very sentence on the row of every server that cannot be played,
        // right-aligned to nearly the same column two rows above, so a copy here was the same words twice
        // in one picture (Sprint 11 review, Minor 4).
        bool alreadyOnPage = false;
        if (page == Page::Online)
            for (const launcher::ServerPreset &p : launcher::kServerPresets)
                alreadyOnPage = alreadyOnPage || !launcher::presetAvailable(p);
        const Rect strip{right + 12.0f, first.y, app.frame.body.right() - right - 12.0f, first.h};
        if (anyGreyed && !alreadyOnPage && drawable(strip))
        {
            const float size = metrics::captionSize - 1.0f;
            textRightIn(ctx, ellipsizeEnd(ctx, launcher::kRevisionMissingNote, strip.w, size).c_str(), strip, size,
                        theme::mix(theme::dim, theme::ground, 0.45f));
        }
    }

    // The sentence to draw when the chosen server and the chosen build are different revisions; "" when
    // they agree. Both pages ask this, each drawing it where its own layout has room for a full line.
    inline std::string revisionMismatchLine(const App &app)
    {
        return launcher::revisionWarning(app.config.serverPreset, launcher::normalizeGameRevision(app.config.gameRevision));
    }

    // ---- one per page -------------------------------------------------------------------------------------
    void drawPlayPage(const Ctx &ctx, App &app, const std::vector<Node> &nodes);
    void drawDiscPage(const Ctx &ctx, App &app, const std::vector<Node> &nodes);
    void drawVideoPage(const Ctx &ctx, App &app, const std::vector<Node> &nodes);
    void drawAudioPage(const Ctx &ctx, App &app, const std::vector<Node> &nodes);
    void drawControllerPage(const Ctx &ctx, App &app, const std::vector<Node> &nodes);
    void drawMicrophonePage(const Ctx &ctx, App &app, const std::vector<Node> &nodes);
    void drawOnlinePage(const Ctx &ctx, App &app, const std::vector<Node> &nodes);
    void drawReportPage(const Ctx &ctx, App &app, const std::vector<Node> &nodes);
    void drawAboutPage(const Ctx &ctx, App &app, const std::vector<Node> &nodes);
}
