// Sprint 8 Goal 9, the ONLINE page: which server, whose persona, and the second instance for testing.
#include "pages.h"

#include <ctime>
#include <string>

namespace ui
{
    namespace
    {
        // A record's server as its row says it: the preset's label for a preset's address, else the address.
        std::string serverText(const std::string &address)
        {
            return launcher::personas::serverCaption(address);
        }
    }

    void drawOnlinePage(const Ctx &ctx, App &app, const std::vector<Node> &nodes)
    {
        launcher::Config &c = app.config;

        // The first ROW, not the first node: a preset that cannot be played has a row but no node, and the
        // community one is first -- rectOf() answered an empty rect and this heading was drawn off the window.
        const Rect preset0 = onlinePresetRow(app.frame.window, 0);
        text(ctx, "SERVER", Vec2{preset0.x, preset0.y - 26.0f}, metrics::labelSize, theme::dim, Face::Bold, 0.06f);
        // Task 11: the revision mismatch, on the widest line this page has. It takes the strip from the
        // status line when both want it: "that server runs a different game" is about the choice the
        // player just made, and "the server is up" is not news while the pair cannot connect at all.
        const std::string mismatch = revisionMismatchLine(app);
        if (!mismatch.empty())
        {
            const float size = metrics::captionSize;
            const float w = textWidth(ctx, mismatch.c_str(), size);
            text(ctx, mismatch.c_str(), Vec2{app.frame.body.right() - w, preset0.y - 26.0f}, size, theme::warn);
        }
        // Sprint 9 Goal 8: the hosted server's own word on itself (GET /api/stats, fetched off this thread).
        // Blank when the site cannot be reached: a player who is offline is not told anything is wrong.
        else if (!app.serverStatus.empty())
        {
            const bool up = app.serverStatus.find(": online") != std::string::npos;
            const float size = metrics::captionSize;
            const float w = textWidth(ctx, app.serverStatus.c_str(), size);
            const float right = app.frame.body.right();
            fillCircle(ctx, Vec2{right - w - 12.0f, preset0.y - 17.0f}, 4.0f, up ? theme::lampGreen : theme::warn);
            text(ctx, app.serverStatus.c_str(), Vec2{right - w, preset0.y - 26.0f}, size, up ? theme::text : theme::caption);
        }

        // "Custom" -- the one with no address -- unless one of the ids matches.
        int presetSel = static_cast<int>(launcher::kServerPresetCount) - 1;
        for (size_t i = 0; i < launcher::kServerPresetCount; ++i)
            if (c.serverPreset == launcher::kServerPresets[i].id && launcher::presetAvailable(launcher::kServerPresets[i]))
                presetSel = static_cast<int>(i);
        for (int i = 0; i < static_cast<int>(launcher::kServerPresetCount); ++i)
        {
            const std::string id = "online.preset." + std::to_string(i);
            const bool available = launcher::presetAvailable(launcher::kServerPresets[i]);
            const Rect r = available ? rectOf(nodes, id) : onlinePresetRow(app.frame.window, i);
            if (!available)
            {
                // Drawn, but not on offer: the community server runs a game revision this client cannot
                // play, and a preset the player cannot use must say so rather than fail at launch.
                const Rgba off = theme::mix(theme::dim, theme::ground, 0.45f);
                strokeRect(ctx, Rect{r.x + 6.0f, r.cy() - 5.0f, 10.0f, 10.0f}, off, 2.0f);
                text(ctx, launcher::kServerPresets[i].label, Vec2{r.x + 34.0f, r.cy() - metrics::bodySize * 0.58f},
                     metrics::bodySize - 1.0f, off);
                textRightIn(ctx, launcher::kRevisionMissingNote, Rect{r.x, r.y, r.w - 12.0f, r.h},
                            metrics::captionSize - 1.0f, off);
                continue;
            }
            if (listRow(ctx, r, launcher::kServerPresets[i].label, id, i == presetSel) && i != presetSel)
            {
                c.serverPreset = launcher::kServerPresets[i].id;
                app.dirty = true;
                if (app.activeField == "online.server")
                    app.activeField.clear();   // the preset took the field away mid-edit
            }
            textRightIn(ctx, launcher::kServerPresets[i].note, Rect{r.x, r.y, r.w - 12.0f, r.h},
                        metrics::captionSize - 1.0f,
                        i == presetSel ? theme::caption : theme::mix(theme::caption, theme::ground, 0.3f));
        }

        // Task 11: the build this launcher will start, under the server list -- the two have to be the same
        // revision, and the warning above says so when they are not.
        gameVersionRow(ctx, app, nodes, Page::Online);

        const launcher::ServerPreset *preset = launcher::findServerPreset(c.serverPreset);
        const bool ownAddress = preset == nullptr || preset->address[0] == '\0';

        // Sprint 16 L1b (#73, R295): ADDRESS on its own shared row (it was anchored on PROFILE's rect, now gone).
        const Rect address = ownAddress ? rectOf(nodes, "online.server") : onlineAddressRow(app.frame.window);
        rowLabel(ctx, address, "ADDRESS");
        bool changed = false;
        if (ownAddress)
        {
            textField(ctx, address, c.server, "online.server", changed);
        }
        else
        {
            std::string shown = preset->address;
            textField(ctx, address, shown, "online.server", changed, false);
        }

        // Sprint 16 L1b (#73, R295; the L1 design note, section 2): the PERSONAS list replaces the PROFILE, PLAYER NAME
        // and PASSWORD fields -- one row per persona the cards hold (the persona-card plan, R-A), each card in its own
        // order, NEW PERSONA last, three visible and the rest scrolled to; the masked password beside the selected row
        // when the card does not hold it, and NEW PERSONA's NAME and PASSWORD beside it when it is selected.
        namespace ps = launcher::personas;
        const std::vector<ps::Persona> &rows = app.personas.rows;
        const int records = static_cast<int>(rows.size());
        const int scroll = app.layout.personaScroll;
        const int selected = static_cast<int>(ps::selectedRow(rows, c));
        const Rect first = onlinePersonaRow(app.frame.window, scroll, scroll);
        text(ctx, "PERSONAS", Vec2{first.x, first.y - 26.0f}, metrics::labelSize, theme::dim, Face::Bold, 0.06f);
        {
            // The heading line's right end: what the selected row means for the launch. A row made on another
            // server warns and does not block -- there the game's first login makes a persona by its own rule.
            std::string note;
            Rgba ink = theme::caption;
            if (selected == records && !app.personaNote.empty())
            {
                note = app.personaNote;   // CREATE ON CARD did not write: why, until the next try
                ink = theme::warn;
            }
            else if (selected < records)
            {
                const ps::Persona &r = rows[static_cast<size_t>(selected)];
                if (!ps::counts(r, c))
                {
                    note = "made on " + serverText(r.server) + "; on this server the game makes a new persona";
                    ink = theme::warn;
                }
                else
                    note = "LAUNCH, then pick " + ps::displayName(r.name) + " in the game's list";
            }
            else if (selected == records)
                note = app.running ? "the game is running: CREATE ON CARD waits until it exits"
                                   : "type a name and a password, then CREATE ON CARD";
            else if (records + 1 > kPersonaVisibleRows)
                note = std::to_string(records + 1) + " rows -- up and down scroll the list";
            if (!note.empty())
            {
                const float size = metrics::captionSize;
                const float w = textWidth(ctx, note.c_str(), size);
                text(ctx, note.c_str(), Vec2{app.frame.body.right() - w, first.y - 26.0f}, size, ink);
            }
        }
        for (int i = scroll; i <= records && i < scroll + kPersonaVisibleRows; ++i)
        {
            const std::string id = personaRowId(i, records);
            if (!hasNode(nodes, id))
                continue;
            const Rect r = rectOf(nodes, id);
            const Rect captionBox{r.x, r.y, r.w - 12.0f, r.h};
            const Rgba captionInk = i == selected ? theme::caption : theme::mix(theme::caption, theme::ground, 0.3f);
            if (i < records)
            {
                const ps::Persona &row = rows[static_cast<size_t>(i)];
                if (listRow(ctx, r, ps::displayName(row.name), id, i == selected) && i != selected)
                {
                    ps::pick(c, row);
                    app.requestPersonaFirst = i;   // R-C: main.cpp puts it first on its card, so the game's form arrives with it
                    app.dirty = true;
                    if (app.activeField == "online.persona.password" || app.activeField == "online.persona.name")
                        app.activeField.clear();
                }
                // A record no ledger dates has not logged in from this launcher yet: its age would be the epoch's.
                const std::string age = row.lastLogin > 0
                                            ? ps::ageCaption(static_cast<std::time_t>(row.lastLogin), static_cast<std::time_t>(app.personasNow))
                                            : std::string("on the card");
                const std::string line = serverText(row.server) + " -- " + age + (row.second ? " -- second instance" : "");
                textRightIn(ctx, line.c_str(), captionBox, metrics::captionSize - 1.0f, captionInk);
            }
            else
            {
                if (listRow(ctx, r, "NEW PERSONA", id, i == selected) && i != selected)
                {
                    ps::pickNewPersona(c);
                    app.dirty = true;
                }
                // Selected, the row is narrowed for the creator beside it and the heading line carries this caption.
                if (i != selected)
                    textRightIn(ctx, "type a name and a password, then CREATE", captionBox, metrics::captionSize - 1.0f, captionInk);
            }
        }
        // The empty viewer's one sentence, under NEW PERSONA where the rows would be.
        const char *sentence = ps::emptySentence(app.personas);
        if (sentence[0] != '\0')
        {
            const Rect slot = onlinePersonaRow(app.frame.window, 1, 0);
            float y = slot.y + 4.0f;
            for (const std::string &line : wrapText(ctx, sentence, slot.w - 24.0f, metrics::captionSize))
            {
                text(ctx, line.c_str(), Vec2{slot.x + 12.0f, y}, metrics::captionSize, theme::caption);
                y += metrics::captionSize * 1.3f;
            }
        }
        // The password (R179: plain in config.json only until the game remembers it; masked here), capped and
        // filtered as the game's own keyboard caps it (research/38).
        // The persona-card plan: NEW PERSONA's NAME, filtered as the game's name keyboard is (no double quote).
        if (hasNode(nodes, "online.persona.name"))
        {
            bool typed = false;
            textField(ctx, rectOf(nodes, "online.persona.name"), app.personaNameTyped, "online.persona.name", typed, true,
                      launcher::kLoginNameCap, false, [](char ch) { return launcher::keyboardAccepts(ch, false); });
            if (typed)
                app.personaNote.clear();   // not a setting: config.json does not keep it, so nothing is dirty
        }
        if (hasNode(nodes, "online.persona.password"))
        {
            const Rect password = rectOf(nodes, "online.persona.password");
            const std::string before = c.loginPassword;
            textField(ctx, password, c.loginPassword, "online.persona.password", changed, true, launcher::kLoginPasswordCap, true,
                      [](char ch) { return launcher::keyboardAccepts(ch, true); });
            if (c.loginPassword != before)
                app.personaNote.clear();
        }
        // The persona-card plan: CREATE ON CARD, live once a name and a password are typed and while no game holds the
        // card; main.cpp writes it (requestCreatePersona). "CREATE" alone where the strip is too narrow for the words.
        if (hasNode(nodes, "online.persona.create"))
        {
            const Rect create = rectOf(nodes, "online.persona.create");
            const bool ready = !app.personaNameTyped.empty() && !c.loginPassword.empty() && !app.running;
            const char *label =
                textWidth(ctx, "CREATE ON CARD", metrics::labelSize + 1.0f, Face::Bold, 0.04f) + 16.0f <= create.w ? "CREATE ON CARD" : "CREATE";
            if (button(ctx, create, label, "online.persona.create", ready))
                app.requestCreatePersona = true;
        }

        // Sprint 9 P4: everything above is a stranger's first run; everything below the rule is not. The
        // second instance is a testing tool -- it starts a whole second copy of the game -- so it lives
        // behind the disclosure rather than under the profile field a new player has just filled in.
        const bool forced = advancedForced(c);
        if (advancedHeader(ctx, rectOf(nodes, "online.advanced"), "online.advanced", app.advancedOpen || forced, forced))
            app.advancedOpen = !app.advancedOpen;

        // Shut, the toggle is not in the node list at all, so there is nothing to look up and nothing to
        // draw -- `hasNode` rather than a rect test, because absence is the point.
        if (hasNode(nodes, "online.second"))
        {
            const Rect second = rectOf(nodes, "online.second");
            if (toggle(ctx, second, "Second instance on this machine (for testing)", "online.second", c.secondInstance))
                changed = true;
            caption(ctx, Vec2{second.x, second.bottom() + 10.0f},
                    "A second instance shifts its UDP ports and uses its own card directory, so two copies can play here.");
        }

        if (changed)
            app.dirty = true;
    }
}
