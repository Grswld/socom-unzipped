// Issue #74: the CONTROLLER page's tooltips -- one line per control page_controller.cpp draws, in the launcher's
// own voice: what it does and, where it applies, what the value it holds now means. Pure (tips.h), so
// launcher_tests.cpp walks the page's focus list and holds every control to a line.
#include "tips.h"

#include <cstdio>
#include <cstdlib>
#include <string>

namespace ui
{
    namespace
    {
        using namespace launcher::mapping;

        launcher::Config configOf(const TipState &s)
        {
            return s.config != nullptr ? *s.config : launcher::Config{};
        }

        // The pad button that sends PS2 `button` now, in the pad's own words ("A", "LB", "CROSS").
        std::string drivenBy(const TipState &s, uint8_t button)
        {
            const Mapping m = launcher::activeMapping(configOf(s));
            const int row = rowOf(button);
            const int host = row < 0 ? kHostNone : m.pad[static_cast<size_t>(row)].host;
            return host == kHostNone ? std::string() : std::string(hostLabel(s.family, host).text);
        }

        std::string bindLine(const std::string &id, const TipState &s)
        {
            const int cell = bindCellOf(id);
            if (cell < 0)
                return std::string();
            const uint8_t button = bindCellButton(cell);
            const std::string game = ps2Label(button).text;
            const std::string host = drivenBy(s, button);
            std::string line = game + ": ";
            line += host.empty() ? "no pad button sends the game's " + game + " now" : "your pad's " + host + " sends the game's " + game;
            // R139: the one cell whose press the game weighs -- a pad's Triangle is always firm.
            if (button == kPs2Triangle)
                return line + "; a firm press, so prone. Crouch is the row below.";
            return line + ". Press to bind another button.";
        }

        std::string switchLine(const std::string &, const TipState &s)
        {
            const launcher::Config c = configOf(s);
            const int host = launcher::focusToggleHost(c);
            if (host == kHostNone)
                return "SWITCH: off, so no pad button swaps the windows. Press to put it on a button.";
            return std::string("SWITCH: your pad's ") + hostLabel(s.family, host).text +
                   " swaps the game and the launcher; the game never reads it. Press to rebind.";
        }

        std::string switchOffLine(const std::string &, const TipState &s)
        {
            const bool off = launcher::focusToggleHost(configOf(s)) == kHostNone;
            return off ? "OFF: the window switch is off now; bind the SWITCH cell to put it back."
                       : "OFF: turns the window switch off, leaving that button to Steam or the Game Bar.";
        }

        // The crouch shortcut's cells, by value (launcher_config.h, kCrouchShortcuts). Each says what the value
        // means; the chosen one says so. The keyboard keys are the ones test_launcher_wording.py holds to the map.
        std::string crouchLine(const std::string &id, const TipState &s)
        {
            const int i = std::atoi(id.c_str() + std::string("pad.crouch.").size());
            if (i < 0 || i >= launcher::kCrouchShortcutCount)
                return std::string();
            const std::string value = launcher::kCrouchShortcuts[i];
            std::string line;
            if (value == "l3")
                line = "L3: press the left stick to crouch; the game's own crouch key stays. Fire mode goes to key 2.";
            else if (value == "touchpad")
                line = "TOUCHPAD: click the touchpad to crouch (DualShock 4 / DualSense); nothing else moves.";
            else if (value == "l2")
                line = "L2: press L2 to crouch; the second weapon swap goes to the keyboard's 1 key.";
            else
                line = "OFF: no pad control crouches -- a pad cannot make the light Triangle press crouch needs.";
            const bool chosen = launcher::normalizeCrouchShortcut(configOf(s).crouchShortcut) == value;
            return chosen ? line + " (Set.)" : line;
        }

        std::string deadZoneLine(const std::string &, const TipState &s)
        {
            char line[128];
            std::snprintf(line, sizeof(line),
                          "DEAD ZONE %.2f: stick travel under this is ignored. Raise it if your aim drifts.",
                          configOf(s).padDeadZone);
            return line;
        }

        std::string pickLine(const std::string &id, const TipState &)
        {
            if (id == "pad.pick.0")
                return "FIRST AVAILABLE: the game plays the first pad it finds when it starts.";
            return "This pad plays, by its slot, whatever else is plugged in.";
        }

        std::string restoreLine(const std::string &, const TipState &s)
        {
            if (isDefault(launcher::activeMapping(configOf(s))))
                return "RESTORE DEFAULTS: nothing to restore -- every button is on its default now.";
            return "RESTORE DEFAULTS: every button back to the default layout. It asks first.";
        }

        // The dialog's buttons mean what the open dialog says they mean (bind_flow.h, dialogButtonLabel).
        std::string dialogLine(const std::string &id, const TipState &s)
        {
            const BindFlow flow = s.bind != nullptr ? *s.bind : BindFlow{};
            const int i = std::atoi(id.c_str() + std::string("pad.dialog.").size());
            const std::string label = dialogButtonLabel(flow, i);
            if (label == "SWAP")
                return "SWAP: the two game buttons trade pad buttons; nothing is left unbound.";
            if (label == "REPLACE")
                return flow.button == kSwitchTarget
                           ? "REPLACE: the switch takes the button, and the game button that had it goes unbound."
                           : "REPLACE: this button takes the pad button; the other game button goes unbound.";
            if (label == "RESTORE")
                return "RESTORE: every button back to the default layout, now.";
            if (label == "CANCEL")
                return "CANCEL: nothing changes; every button stays where it was.";
            return "Answers the question above.";
        }

        const TipRow kRows[] = {
            {"pad.section.0", "SETUP: which pad plays, and its dead zone.", nullptr},
            {"pad.section.1", "BUTTONS: which pad button sends each of the game's, and the crouch shortcut.", nullptr},
            {"pad.pick.", nullptr, pickLine},
            {"pad.deadzone", nullptr, deadZoneLine},
            {"pad.bind.", nullptr, bindLine},
            {kSwitchCellId, nullptr, switchLine},
            {kSwitchOffId, nullptr, switchOffLine},
            {"pad.restore", nullptr, restoreLine},
            {"pad.crouch.", nullptr, crouchLine},
            {"pad.dialog.", nullptr, dialogLine},
        };
    }

    TipTable controllerTips()
    {
        return TipTable{kRows, sizeof(kRows) / sizeof(kRows[0])};
    }
}
