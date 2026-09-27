// Sprint 8 Goal 9, the CONTROLLER page: the pad as the game will read it, and what changes it. Sprint 10 Goal 8
// (R174, part 2): the space under the drawn pad is two sections -- SETUP (the pad pick, the dead zone; the mouse
// controls left in Sprint 10 Q3, R210)
// and BUTTONS (the sixteen bindings, RESTORE DEFAULTS, and the crouch shortcut, which is a binding of a light
// Triangle and so belongs beside the others). The bind flow itself is pure (bind_flow.h); this file draws it.
#include "bind_flow.h"
#include "glyphs.h"
#include "pages.h"

#include <cstdio>
#include <cstring>
#include <string>

namespace ui
{
    namespace
    {
        using namespace launcher::mapping;

        // The host control that drives PS2 `button` under `m`, for the drawing's marks.
        int hostOf(const Mapping &m, uint8_t button)
        {
            const int row = rowOf(button);
            return row < 0 ? kHostNone : m.pad[static_cast<size_t>(row)].host;
        }

        // A binding cell: the game's button on the left, the pad's own name for what drives it on the right.
        // Listening, the right side is the countdown. Returns true on the frame it was acted on.
        bool bindCell(const Ctx &ctx, Rect r, const std::string &id, uint8_t button, const HostLabel &host, bool custom,
                      bool listening, int countdown)
        {
            if (!drawable(r))
                return false;
            const bool live = hovered(ctx, r) || focused(ctx, id);
            if (listening)
                fillRectGradient(ctx, r, theme::blueFill, theme::blueDeep);
            else
                fillRect(ctx, r, live ? theme::panelHi : theme::mix(theme::panel, theme::ground, 0.25f));
            strokeRect(ctx, r, listening ? theme::goldHi : (live ? theme::gold : theme::line), 2.0f);

            const float size = metrics::labelSize;
            const Ps2Label game = ps2Label(button);
            float x = r.x + 10.0f;
            const float textY = r.y + (r.h - size * 1.12f) * 0.5f;
            if (game.face >= 0)
            {
                drawShapeGlyph(ctx, game.face, Vec2{x + 8.0f, r.cy()}, 15.0f, theme::goldHi);
                x += 22.0f;
            }
            else
            {
                text(ctx, game.text, Vec2{x, textY}, size, theme::text, Face::Bold, 0.04f);
                x += textWidth(ctx, game.text, size, Face::Bold, 0.04f) + 6.0f;
            }

            if (listening)
            {
                char line[32];
                std::snprintf(line, sizeof(line), "PRESS...  %d", countdown);
                textRightIn(ctx, line, Rect{r.x, r.y, r.w - 10.0f, r.h}, size, theme::goldHi, Face::Bold);
                return hit(ctx, r, id);
            }

            // The pad's own name, right-aligned; a shape for a PlayStation pad's face buttons.
            const Rgba ink = custom ? theme::goldHi : (live ? theme::text : theme::caption);
            if (host.face >= 0)
                drawShapeGlyph(ctx, host.face, Vec2{r.right() - 18.0f, r.cy()}, 15.0f, ink);
            else
                textRightIn(ctx, host.text, Rect{r.x, r.y, r.w - 10.0f, r.h}, size - 1.0f, ink, Face::Bold);
            // A dot at the join says the row is not the default -- the same mark RESTORE DEFAULTS undoes.
            if (custom)
                fillCircle(ctx, Vec2{x + 4.0f, r.cy()}, 2.5f, theme::gold);
            return hit(ctx, r, id);
        }
    }

    void drawControllerPage(const Ctx &ctx, App &app, const std::vector<Node> &nodes)
    {
        launcher::Config &c = app.config;
        const Rect b = app.frame.body;
        Mapping m = launcher::activeMapping(c);
        const GlyphFamily family = glyphFamilyFor(app.pad.name);
        const bool buttons = app.padSection == 1;
        const bool listening = app.bind.state == BindFlow::State::Listening;
        const bool dialog = dialogButtonCount(app.bind) > 0;

        // ---- the drawn pad ------------------------------------------------------------------------------
        // The pad fills the band above the sections: 560 units wide, centred on the body, with the glyph
        // legend in its own strip underneath so nothing ever sits on top of the drawing. 262 tall, not 282: the
        // section row under it took 20 (focus.cpp lays the row at body + 300).
        const Rect padArea{b.x + b.w * 0.5f - 280.0f, b.y, 560.0f, 262.0f};
        const std::string crouch = launcher::normalizeCrouchShortcut(c.crouchShortcut);
        // R139: the crouch shortcut's control is whichever host button the mapping binds to PS2 L3 (or L2), so a
        // player who moved L3 sees the CROUCH tag move with it.
        const int markHost = crouch == "l3" ? hostOf(m, kPs2L3)
                                            : (crouch == "touchpad" ? kPadAnchorTouchpad : (crouch == "l2" ? hostOf(m, kPs2L2) : kHostNone));
        // The callouts: in BUTTONS, every row that is not the default gets the game's button drawn on the
        // control that now drives it, and the last binding made is ringed for two seconds.
        std::vector<PadCallout> callouts;
        if (buttons)
        {
            const Mapping def = defaults();
            for (size_t i = 0; i < m.pad.size(); ++i)
            {
                if (m.pad[i].host == kHostNone || m.pad[i] == def.pad[i])
                    continue;
                const Ps2Label game = ps2Label(m.pad[i].button);
                callouts.push_back(PadCallout{m.pad[i].host, game.face, game.text, false});
            }
            if (app.bind.lastHost != kHostNone && ctx.time - app.bind.lastAt < 2.0)
            {
                bool marked = false;
                for (PadCallout &call : callouts)
                    if (call.host == app.bind.lastHost)
                        call.highlight = marked = true;
                if (!marked)
                    callouts.push_back(PadCallout{app.bind.lastHost, -1, "", true});
            }

            // W9 (the owner: "clearer indication of which button is bound to what"): the cell the focus is
            // on, lit on the drawing. Walking the sixteen cells now walks the pad, so the answer to "which
            // control is this row?" is a glance rather than a guess -- and it costs no clutter, because only
            // ever one cell holds the focus.
            const int focusCell = bindCellOf(app.nav.focus);
            const int focusHost = focusCell >= 0 ? hostOf(m, bindCellButton(focusCell))
                                                 : (app.nav.focus == kSwitchCellId ? launcher::focusToggleHost(c) : kHostNone);
            if (focusHost != kHostNone)
            {
                const Ps2Label game = focusCell >= 0 ? ps2Label(bindCellButton(focusCell)) : ps2Label(kSwitchTarget);
                bool merged = false;
                for (PadCallout &call : callouts)
                    if (call.host == focusHost)
                        call.focus = merged = true;
                if (!merged)
                    callouts.push_back(PadCallout{focusHost, game.face, game.text, false, true});
            }
        }
        // While a hold is building, the ring closing on that control is the drawing's half of the hint.
        const bool holding = app.holdHost != kHostNone && app.holdProgress > 0.12f && !listening && !dialog;
        drawPad(ctx, padArea, app.pad, static_cast<float>(c.padDeadZone), markHost,
                callouts.empty() ? nullptr : &callouts, holding ? app.holdHost : 0, app.holdProgress);

        // Listening: the ask, across the drawing, where the eye already is. W9: and under it, in words, the
        // two ways out -- the bottom bar says them too, but a player who has just triggered this by ACCIDENT
        // (a long press they did not mean) is looking at the middle of the screen, not at the bar.
        if (listening && app.pad.present)
        {
            const Ps2Label game = ps2Label(app.bind.button);
            char line[96];
            std::snprintf(line, sizeof(line), "PRESS THE BUTTON FOR %s   %d", game.text, bindCountdown(app.bind, ctx.time));
            const float size = 24.0f;
            const Rect band{padArea.x + 20.0f, padArea.cy() - size * 1.25f, padArea.w - 40.0f, size * 2.5f};
            fillRect(ctx, band, theme::alpha(theme::ground, 225));
            strokeRect(ctx, band, theme::gold, 1.5f);
            textCenteredIn(ctx, line, Rect{band.x, band.y, band.w, band.h - 16.0f}, size, theme::goldHi, Face::Display);
            const char *out = "HOLD CIRCLE OR PRESS ESC TO CANCEL";
            text(ctx, out, Vec2{band.cx() - textWidth(ctx, out, metrics::captionSize - 2.0f, Face::Bold, 0.06f) * 0.5f,
                                band.bottom() - 17.0f},
                 metrics::captionSize - 2.0f, theme::caption, Face::Bold, 0.06f);
        }

        // W9: a hold is building. The same band, in the same place, because it is the same conversation one
        // step earlier -- which button, how far along, and how to stop. Nothing is committed until the bar
        // fills, and letting go before it does is the whole cancel.
        if (holding && app.pad.present)
        {
            const HostLabel held = hostLabel(family, app.holdHost);
            char line[96];
            std::snprintf(line, sizeof(line), "HOLD TO REMAP  %s", held.text);
            const float size = 22.0f;
            const Rect band{padArea.x + 60.0f, padArea.cy() - size * 1.5f, padArea.w - 120.0f, size * 3.0f};
            fillRect(ctx, band, theme::alpha(theme::ground, 225));
            strokeRect(ctx, band, theme::gold, 1.5f);
            textCenteredIn(ctx, line, Rect{band.x, band.y + 2.0f, band.w, size * 1.4f}, size, theme::goldHi, Face::Display);
            const char *out = "LET GO TO CANCEL";
            text(ctx, out, Vec2{band.x + 16.0f, band.bottom() - 30.0f}, metrics::captionSize - 3.0f, theme::caption,
                 Face::Bold, 0.06f);
            meterBar(ctx, Rect{band.x + 16.0f, band.bottom() - 16.0f, band.w - 32.0f, 10.0f}, app.holdProgress, theme::gold);
        }

        // The legend: the owner plays on an Xbox pad and the game prompts with PlayStation shapes.
        if (app.pad.present && family != GlyphFamily::PlayStation)
        {
            const float y = padArea.bottom() + 4.0f;
            text(ctx, "YOUR PAD / THE GAME", Vec2{padArea.x + 14.0f, y}, metrics::labelSize, theme::dim, Face::Bold, 0.06f);
            float x = padArea.x + 200.0f;
            static const int order[4] = {1, 3, 2, 0};   // cross, circle, square, triangle
            for (int k = 0; k < 4; ++k)
            {
                const int i = order[k];
                text(ctx, faceLetter(family, i), Vec2{x, y - 2.0f}, 18.0f, theme::text, Face::Bold);
                text(ctx, "=", Vec2{x + 17.0f, y - 2.0f}, 18.0f, theme::dim);
                drawShapeGlyph(ctx, i, Vec2{x + 44.0f, y + 9.0f}, 17.0f, theme::goldHi);
                x += 74.0f;
            }
        }

        // W9, the at-rest hint: the gesture is invisible until someone says it exists. It goes in the strip
        // under the drawing, right-aligned to the body's edge -- the glyph legend above ends around
        // padArea.x + 500 and the body runs ~110 units past padArea's right, so the two never meet. The
        // bottom bar's prompt row carries the short form (main.cpp, drawPrompts: HOLD / REMAP), and this is
        // the sentence that says what "HOLD" means.
        if (app.pad.present && !listening && !dialog && !holding)
            textRightIn(ctx, "HOLD A BUTTON TO REMAP IT", Rect{b.x, padArea.bottom() + 2.0f, b.w, 20.0f},
                        metrics::captionSize - 3.0f, theme::dim, Face::Bold);

        // ---- the section switch ---------------------------------------------------------------------------
        for (int i = 0; i < 2; ++i)
        {
            const std::string id = "pad.section." + std::to_string(i);
            // Not while listening: the session is the pad's, and a switch under it would abandon it half-way.
            if (radioCell(ctx, rectOf(nodes, id), i == 0 ? "SETUP" : "BUTTONS", id, app.padSection == i) && app.padSection != i && !listening)
                app.padSection = i;   // the focus stays on the switch, which both sections keep
        }

        if (!buttons)
        {
            // ---- SETUP: the pad picker ------------------------------------------------------------------------
            const Rect firstPick = rectOf(nodes, "pad.pick.0");
            const Rect deadZone = rectOf(nodes, "pad.deadzone");
            // No "CONTROLLER" label over the list any more: the SETUP cell sits where it was, and the list's
            // check marks say what it is.
            int padSel = 0;
            for (size_t i = 0; i < app.padSlots.size(); ++i)
                if (app.padSlots[i] == c.gamepadIndex)
                    padSel = static_cast<int>(i);
            for (size_t i = 0; i < app.padLabels.size(); ++i)
            {
                const std::string id = "pad.pick." + std::to_string(i);
                const Rect r = rectOf(nodes, id);
                if (r.w <= 0.0f)
                    continue;
                if (listRow(ctx, r, app.padLabels[i], id, static_cast<int>(i) == padSel) && static_cast<int>(i) != padSel)
                {
                    c.gamepadIndex = app.padSlots[i];
                    app.dirty = true;
                }
            }

            // ---- SETUP: the knobs -----------------------------------------------------------------------------
            char label[64];
            std::snprintf(label, sizeof(label), "DEAD ZONE  %.2f", c.padDeadZone);
            text(ctx, label, Vec2{deadZone.x, deadZone.y - 22.0f}, metrics::labelSize, theme::dim, Face::Bold, 0.06f);
            if (slider(ctx, deadZone, "pad.deadzone", c.padDeadZone, 0.0, 0.40, 0.01))
                app.dirty = true;

            // Sprint 10 Q3 (R210): the keyboard is menus and typing only, and the mouse is gone -- so the SETUP
            // section says so once, where the mouse-look toggle used to be (its row was 44 under the dead zone).
            // Two lines: the column is 340 units wide and one line of it ran off the panel (the first capture).
            // Sprint 13 V8 (stranger audit row 13): the first line said "only ... Z/X/C/V" while the crouch hint sent
            // fire mode to "the keyboard's 2 key" -- the default map (mapping.cpp, kDefaultKeys) binds Q/E and 1-4
            // to the shoulders and the stick clicks. The line now names them; test_launcher_wording.py holds it
            // to the map.
            text(ctx, "KEYBOARD", Vec2{deadZone.x, deadZone.y + 44.0f}, metrics::labelSize, theme::dim, Face::Bold, 0.06f);
            caption(ctx, Vec2{deadZone.x, deadZone.y + 44.0f + metrics::labelSize + 8.0f},
                    "Menus and typing: arrows, Enter, Esc, Backspace, Space, Z/X/C/V.");
            caption(ctx, Vec2{deadZone.x, deadZone.y + 44.0f + metrics::labelSize + 8.0f + metrics::captionSize * 1.4f},
                    "Q/E/1/2/3/4: L1/R1/L2/L3/R2/R3. Playing needs a controller.");

            // One line under it all: the crouch shortcut's trade while one is on (the mark on the drawing is
            // explained where it is seen), else what the drawing is for. Where the sensitivity slider's bottom was.
            const char *hint = crouch == "off" ? nullptr : launcher::crouchShortcutHint(crouch);
            caption(ctx, Vec2{firstPick.x, deadZone.y + 92.0f + 28.0f + 10.0f},
                    hint != nullptr
                        ? hint
                        : (app.pad.present
                               ? "Press a button: what lights up above is what the game reads. The ring is the dead zone."
                               : "No controller found. The keyboard walks the menus; playing needs a pad -- connect one."));
            return;
        }

        // ---- BUTTONS: the dialog, when one is open ----------------------------------------------------------
        if (dialog)
        {
            const Rect d0 = rectOf(nodes, "pad.dialog.0");
            const Rect panelR{b.x, d0.y - 56.0f, b.w, d0.h + 74.0f};
            if (drawable(panelR))
            {
                fillRect(ctx, panelR, theme::panelHi);
                strokeRect(ctx, panelR, theme::gold, 2.0f);
                const std::string sentence = dialogSentence(app.bind, family);
                const std::vector<std::string> lines = wrapText(ctx, sentence, panelR.w - 40.0f, metrics::bodySize - 1.0f);
                float y = panelR.y + 14.0f;
                for (size_t i = 0; i < lines.size() && i < 2u; ++i, y += (metrics::bodySize - 1.0f) * 1.3f)
                    text(ctx, lines[i].c_str(), Vec2{panelR.x + 20.0f, y}, metrics::bodySize - 1.0f, theme::text);
            }
            const int count = dialogButtonCount(app.bind);
            for (int i = 0; i < count; ++i)
            {
                const std::string id = "pad.dialog." + std::to_string(i);
                if (!button(ctx, rectOf(nodes, id), dialogButtonLabel(app.bind, i), id))
                    continue;
                if (app.bind.state == BindFlow::State::Conflict && app.bind.button == kSwitchTarget)
                {
                    // Sprint 10 Q4: the window switch's two answers -- REPLACE frees the button from the game
                    // and the switch takes it; CANCEL leaves both as they were.
                    if (bindResolve(app.bind, m, i == 0 ? Resolution::Replace : Resolution::Ask, ctx.time) == BindEvent::Bound)
                    {
                        launcher::setActiveMapping(c, m);
                        c.focusToggle = hostButtonName(app.bind.lastHost);
                        app.dirty = true;
                        app.setStatus(std::string("the window switch is now ") + hostLabel(family, app.bind.lastHost).text);
                    }
                    app.nav.focus = kSwitchCellId;
                }
                else if (app.bind.state == BindFlow::State::Conflict)
                {
                    const Resolution r = i == 0 ? Resolution::Swap : (i == 1 ? Resolution::Replace : Resolution::Ask);
                    const uint8_t bound = app.bind.button;
                    if (bindResolve(app.bind, m, r, ctx.time) == BindEvent::Bound)
                    {
                        launcher::setActiveMapping(c, m);
                        app.dirty = true;
                        app.setStatus(std::string(ps2Label(bound).text) + " is now " + hostLabel(family, hostOf(m, bound)).text);
                    }
                    app.nav.focus = "pad.bind." + std::string(ps2ButtonName(bound));
                }
                else
                {
                    restoreAnswer(app.bind, m, i == 0);
                    if (i == 0)
                    {
                        launcher::setActiveMapping(c, m);
                        app.dirty = true;
                        app.setStatus("every button back to the defaults");
                    }
                    app.nav.focus = "pad.restore";
                }
            }
            return;
        }

        // ---- BUTTONS: the sixteen cells -------------------------------------------------------------------
        const Mapping def = defaults();
        const int countdown = bindCountdown(app.bind, ctx.time);
        for (int i = 0; i < kBindCells; ++i)
        {
            const uint8_t button = bindCellButton(i);
            const std::string id = bindCellId(i);
            const int row = rowOf(button);
            const int host = row < 0 ? kHostNone : m.pad[static_cast<size_t>(row)].host;
            const bool custom = row >= 0 && m.pad[static_cast<size_t>(row)] != def.pad[static_cast<size_t>(row)];
            const bool mine = listening && app.bind.button == button;
            if (bindCell(ctx, rectOf(nodes, id), id, button, hostLabel(family, host), custom, mine, countdown) && !listening)
            {
                if (!app.pad.present)
                    app.setStatus("connect a controller to bind its buttons");
                else
                    app.requestBind = static_cast<int>(button);   // main.cpp starts the session, with the pad's state
            }
        }

        // ---- BUTTONS: the window switch (Sprint 10 Q4) -----------------------------------------------------
        // The seventeenth cell: the launcher's own binding, drawn like the sixteen so it is bound like them. "Not
        // the default" here is any button but the guide; OFF is a radio cell beside it, selected when it is off.
        {
            const int switchHost = launcher::focusToggleHost(c);
            const bool mine = listening && app.bind.button == kSwitchTarget;
            if (bindCell(ctx, rectOf(nodes, kSwitchCellId), kSwitchCellId, kSwitchTarget, hostLabel(family, switchHost),
                         switchHost != kHostGuide, mine, countdown) && !listening)
            {
                if (!app.pad.present)
                    app.setStatus("connect a controller to bind the window switch");
                else
                    app.requestBind = static_cast<int>(kSwitchTarget);
            }
            if (radioCell(ctx, rectOf(nodes, kSwitchOffId), "OFF", kSwitchOffId, switchHost == kHostNone) && switchHost != kHostNone && !listening)
            {
                c.focusToggle = "none";
                app.dirty = true;
                app.setStatus("the window switch is off");
            }
        }

        // ---- BUTTONS: restore -----------------------------------------------------------------------------
        if (button(ctx, rectOf(nodes, "pad.restore"), "RESTORE DEFAULTS", "pad.restore", !isDefault(m) && !listening))
        {
            restoreAsk(app.bind);
            app.nav.focus = dialogFocusId(app.bind);
        }

        // ---- BUTTONS: the crouch shortcut (owner request 2026-09-19, R139) ---------------------------------
        // A binding of a LIGHT Triangle -- the press the game reads as crouch and no pad button can make -- so
        // it sits with the bindings. Each cell's trade is its help (the band above), shown where the focus is.
        const Rect crouch0 = rectOf(nodes, "pad.crouch.0");
        if (crouch0.w > 0.0f)
        {
            text(ctx, "CROUCH = LIGHT", Vec2{b.x, crouch0.y + 3.0f}, metrics::labelSize - 1.0f, theme::dim, Face::Bold, 0.04f);
            drawShapeGlyph(ctx, 0, Vec2{b.x + textWidth(ctx, "CROUCH = LIGHT", metrics::labelSize - 1.0f, Face::Bold, 0.04f) + 12.0f, crouch0.cy()},
                           14.0f, theme::goldHi);
            for (int i = 0; i < launcher::kCrouchShortcutCount; ++i)
            {
                const std::string id = "pad.crouch." + std::to_string(i);
                const char *value = launcher::kCrouchShortcuts[i];
                const bool selected = crouch == value;
                if (radioCell(ctx, rectOf(nodes, id), launcher::crouchShortcutLabel(value), id, selected) && !selected && !listening)
                {
                    c.crouchShortcut = value;
                    app.dirty = true;
                }
            }
        }
    }
}
