// Sprint 9 Goal 3: the knob registry -- one table that is the accessor's lookup, the generated docs/KNOBS.md
// and the launcher's list of settings at once.
#include "MiniTest.h"
#include "launcher/launcher_config.h"
#include "ps2x/knobs.h"

#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <set>
#include <string>
#include <vector>

namespace
{
    void setVar(const char *name, const char *value)
    {
#ifdef _WIN32
        _putenv_s(name, value ? value : "");   // an empty value removes the variable on Windows
#else
        if (value)
            setenv(name, value, 1);
        else
            unsetenv(name);
#endif
    }

    // Every case here moves process-wide switches; the suites after this one must find them as they were.
    struct KnobStateGuard
    {
        bool dev = ps2x::knobs::devMode();
        bool enforce = ps2x::knobs::enforcement();
        ~KnobStateGuard()
        {
            ps2x::knobs::setEnforcement(enforce);
            ps2x::knobs::setDevMode(dev);
        }
    };

    const char *kDevName = "PS2X_WATCH_HUGE";             // Dev, read once at start-up by the runner only
    const char *kShippingName = "PS2X_PAD_DEADZONE";      // Shipping, read once by host_gamepad_select's hostPadDeadZone
}

void register_knobs_tests()
{
    MiniTest::Case("Knobs", [](TestCase &tc)
    {
        tc.Run("the table: sorted, unique, every row well formed", [](TestCase &t)
        {
            std::set<std::string> seen;
            for (size_t i = 0; i < ps2x::knobs::kTableSize; ++i)
            {
                const ps2x::knobs::Entry &e = ps2x::knobs::kTable[i];
                const std::string name = e.name;
                t.IsTrue(name.rfind("PS2X_", 0) == 0, name + ": starts with PS2X_");
                t.IsTrue(seen.insert(name).second, name + ": appears once");
                if (i > 0)
                    t.IsTrue(std::strcmp(ps2x::knobs::kTable[i - 1].name, e.name) < 0, name + ": sorted after its predecessor (find() is a binary search)");
                const std::string meaning = e.meaning;
                t.IsTrue(!meaning.empty() && meaning.size() <= 110, name + ": a meaning of at most 110 characters");
                t.IsTrue(meaning.find('"') == std::string::npos, name + ": no double quote (tools_py/knobs.py reads the row with a regex)");
            }
            // 140 shipped names after Task 6 (145 at the tree this landed on, the plan counted 134 at 8e5d778, five
            // dead ones deleted), the test-only ones and PS2X_DEV.
            t.IsTrue(ps2x::knobs::kTableSize >= 140u, "the shipped names, the test-only ones and PS2X_DEV");
        });

        tc.Run("find: a registered name, an unregistered one, null", [](TestCase &t)
        {
            const ps2x::knobs::Entry *scale = ps2x::knobs::find("PS2X_GS_SCALE");
            t.IsNotNull(scale, "PS2X_GS_SCALE is registered");
            if (scale)
            {
                t.IsTrue(scale->cls == ps2x::knobs::Class::Shipping, "and is a shipping setting");
                t.Equals(std::string(scale->dflt), std::string("1"), "whose default is 1");
            }
            const ps2x::knobs::Entry *first = ps2x::knobs::find(ps2x::knobs::kTable[0].name);
            const ps2x::knobs::Entry *last = ps2x::knobs::find(ps2x::knobs::kTable[ps2x::knobs::kTableSize - 1].name);
            t.IsTrue(first == &ps2x::knobs::kTable[0], "the first row is found");
            t.IsTrue(last == &ps2x::knobs::kTable[ps2x::knobs::kTableSize - 1], "the last row is found");
            t.IsNull(ps2x::knobs::find("PS2X_NO_SUCH_KNOB"), "an unregistered name is not");
            t.IsNull(ps2x::knobs::find(nullptr), "null is not");
            const ps2x::knobs::Entry *dev = ps2x::knobs::find("PS2X_DEV");
            t.IsTrue(dev != nullptr && dev->cls == ps2x::knobs::Class::Switch, "PS2X_DEV is the switch");
        });

        tc.Run("the flag rule: unset or empty is the default; 0, false, off are false; anything else is true", [](TestCase &t)
        {
            using ps2x::knobs::flagValue;
            t.IsTrue(flagValue(nullptr, true) && !flagValue(nullptr, false), "unset -> the default");
            t.IsTrue(flagValue("", true) && !flagValue("", false), "empty -> the default");
            t.IsFalse(flagValue("0", true), "0");
            t.IsFalse(flagValue("false", true), "false");
            t.IsFalse(flagValue("off", true), "off");
            t.IsTrue(flagValue("1", false), "1");
            t.IsTrue(flagValue("yes", false), "anything else");
        });

        tc.Run("enforcement off: knob() is getenv -- a Dev knob is readable with no developer mode", [](TestCase &t)
        {
            KnobStateGuard guard;
            ps2x::knobs::setEnforcement(false);
            ps2x::knobs::setDevMode(false);
            setVar(kDevName, "0x100:4");
            const char *v = ps2x::knob(kDevName);
            t.IsTrue(v != nullptr && std::string(v) == "0x100:4", "the value, untouched");
            setVar(kDevName, nullptr);
            t.IsNull(ps2x::knob(kDevName), "and unset is null");
        });

        tc.Run("enforcement on: Dev needs developer mode, Shipping never does, empty is unset, unregistered is null", [](TestCase &t)
        {
            KnobStateGuard guard;
            ps2x::knobs::setEnforcement(true);
            setVar(kDevName, "0x100:4");
            setVar(kShippingName, "2.5");
            ps2x::knobs::setDevMode(false);
            t.IsNull(ps2x::knob(kDevName), "a stranger's environment cannot switch a probe on");
            const char *s = ps2x::knob(kShippingName);
            t.IsTrue(s != nullptr && std::string(s) == "2.5", "the launcher's channel is always open");
            ps2x::knobs::setDevMode(true);
            const char *d = ps2x::knob(kDevName);
            t.IsTrue(d != nullptr && std::string(d) == "0x100:4", "developer mode opens the probe");
#ifndef _WIN32
            setenv(kShippingName, "", 1);   // Windows cannot hold an empty variable; POSIX can, and a shell's `export X=` makes one
            t.IsNull(ps2x::knob(kShippingName), "empty is unset (R162)");
#endif
            setVar("PS2X_NO_SUCH_KNOB", "1");
            t.IsNull(ps2x::knob("PS2X_NO_SUCH_KNOB"), "a name the registry does not hold reads as unset");
            setVar("PS2X_NO_SUCH_KNOB", nullptr);
            setVar(kDevName, nullptr);
            setVar(kShippingName, nullptr);
        });

        tc.Run("knobOn: the flag rule on top of knob(), the default when the knob is hidden", [](TestCase &t)
        {
            KnobStateGuard guard;
            ps2x::knobs::setEnforcement(true);
            ps2x::knobs::setDevMode(true);
            setVar("PS2X_SOCOM2_NET_STATS", "0");
            t.IsFalse(ps2x::knobOn("PS2X_SOCOM2_NET_STATS", true), "0 is off even where the default is on");
            ps2x::knobs::setDevMode(false);
            t.IsTrue(ps2x::knobOn("PS2X_SOCOM2_NET_STATS", true), "hidden from a stranger: the default");
            setVar("PS2X_SOCOM2_NET_STATS", nullptr);
        });

        tc.Run("developer mode: PS2X_DEV decides until someone says otherwise", [](TestCase &t)
        {
            KnobStateGuard guard;
            setVar("PS2X_DEV", "1");
            ps2x::knobs::resetDevModeForTests();
            t.IsTrue(ps2x::knobs::devMode(), "PS2X_DEV=1");
            setVar("PS2X_DEV", "0");
            ps2x::knobs::resetDevModeForTests();
            t.IsFalse(ps2x::knobs::devMode(), "PS2X_DEV=0 is off: the flag rule, not presence");
            setVar("PS2X_DEV", nullptr);
            ps2x::knobs::resetDevModeForTests();
            t.IsFalse(ps2x::knobs::devMode(), "unset is off");
            ps2x::knobs::setDevMode(true);
            t.IsTrue(ps2x::knobs::devMode(), "--dev (setDevMode) wins over the environment");
        });

        tc.Run("consumeDevFlag: --dev is taken out of argv wherever it stands, argv[0] never", [](TestCase &t)
        {
            char a0[] = "socom2", a1[] = "--dev", a2[] = "--home", a3[] = "dir", a4[] = "--dev";
            char *argv[] = {a0, a1, a2, a3, a4, nullptr};
            int argc = 5;
            t.IsTrue(ps2x::knobs::consumeDevFlag(argc, argv), "found");
            t.Equals(argc, 3, "both copies removed");
            t.Equals(std::string(argv[1]), std::string("--home"), "what follows moves up");
            t.Equals(std::string(argv[2]), std::string("dir"), "in order");
            t.IsNull(argv[3], "argv stays null-terminated");
            char b0[] = "--dev", b1[] = "game.elf";
            char *argv2[] = {b0, b1, nullptr};
            int argc2 = 2;
            t.IsFalse(ps2x::knobs::consumeDevFlag(argc2, argv2), "argv[0] is the program, whatever it is called");
            t.Equals(argc2, 2, "and nothing moved");
        });

        tc.Run("describe: what is in effect, what was ignored, paths cut to their file name, long values clipped", [](TestCase &t)
        {
            const ps2x::knobs::Pairs set = {
                {"PS2X_CD_IMAGE", "C:\\Users\\someone\\Games\\SOCOM II (USA).iso"},
                {"PS2X_GS_BACKEND", "cpu"},
                {"PS2X_GS_SCALE", "1"},
                {"PS2X_PEEK", "0x416054:3,*0x408c58:64,*0x408c58+0xc0*:32,*0x408c58+0x400:12"},
                {"PS2X_SOCOM2_LOGIN_PASS", "socom"},   // Goal 9's password: five characters, under the zip scrubber's floor (R208)
                {"PS2X_TEST_SUITE", "Knobs"},
                {"PS2X_WINDOW_SIZE", "1280x896"},
            };
            t.Equals(ps2x::knobs::describe(set, false),
                     std::string("[knobs] dev=0 set: PS2X_CD_IMAGE=\"SOCOM II (USA).iso\" PS2X_SOCOM2_LOGIN_PASS=[redacted] PS2X_WINDOW_SIZE=1280x896"
                                 " | ignored without --dev: PS2X_GS_BACKEND PS2X_PEEK"),
                     "a stranger: the default-valued scale is not news, the test-only name never is, the path keeps no directory, the password is never written");
            t.Equals(ps2x::knobs::describe(set, true),
                     std::string("[knobs] dev=1 set: PS2X_CD_IMAGE=\"SOCOM II (USA).iso\" PS2X_GS_BACKEND=cpu"
                                 " PS2X_PEEK=0x416054:3,*0x408c58:64,*0x408c58+0xc0*:... PS2X_SOCOM2_LOGIN_PASS=[redacted] PS2X_WINDOW_SIZE=1280x896"),
                     "a developer: every set knob, values clipped at 40 characters, the password redacted for a developer too");
            t.Equals(ps2x::knobs::describe({}, false), std::string("[knobs] dev=0 set: none"), "nothing set");
        });

        tc.Run("a Path knob: for a stranger a value outside the game folder is refused, the disc image excepted (R207)", [](TestCase &t)
        {
            KnobStateGuard guard;
            ps2x::knobs::setEnforcement(true);
            ps2x::knobs::setDevMode(false);
            using ps2x::knobs::pathInsideHome;
            const char *had = std::getenv("PS2X_MC_DIR");   // an operator's own value, put back at the end
            const std::string kept = had ? had : "";
            t.IsTrue(pathInsideHome("PS2X_MC_DIR", "cards/viper"), "a relative folder under the game folder");
            t.IsTrue(pathInsideHome("PS2X_MC_DIR", (std::filesystem::current_path() / "cards" / "viper_b").string().c_str()), "the same, absolute");
            t.IsFalse(pathInsideHome("PS2X_MC_DIR", ".."), "the parent folder is outside");
            t.IsFalse(pathInsideHome("PS2X_MC_DIR", "cards/../../elsewhere"), "and so is a folder that climbs out through .. (the profile trap, KNOWN 110c)");
            t.IsFalse(pathInsideHome("PS2X_MC_DIR", (std::filesystem::temp_directory_path() / "socom_cards").string().c_str()), "an absolute folder elsewhere");
            t.IsTrue(pathInsideHome("PS2X_CD_IMAGE", (std::filesystem::temp_directory_path() / "SOCOM II.iso").string().c_str()), "the disc image is only read and lives where the player keeps it");
            setVar("PS2X_MC_DIR", "..");
            t.IsNull(ps2x::knob("PS2X_MC_DIR"), "refused: read as unset, so the default card folder is used");
            setVar("PS2X_MC_DIR", "cards/viper");
            const char *inside = ps2x::knob("PS2X_MC_DIR");
            t.IsTrue(inside != nullptr && std::string(inside) == "cards/viper", "inside: the value");
            setVar("PS2X_MC_DIR", "..");
            ps2x::knobs::setDevMode(true);
            const char *dev = ps2x::knob("PS2X_MC_DIR");
            t.IsTrue(dev != nullptr && std::string(dev) == "..", "a developer's run keeps any path (the gate's card lives under logs/)");
            ps2x::knobs::setDevMode(false);
            const ps2x::knobs::Pairs set = {{"PS2X_MC_DIR", ".."}, {"PS2X_GS_SCALE", "2"}};
            t.Equals(ps2x::knobs::describe(set, false),
                     std::string("[knobs] dev=0 set: PS2X_GS_SCALE=2 | refused, outside the game folder: PS2X_MC_DIR"),
                     "the line says what was refused");
            setVar("PS2X_MC_DIR", had ? kept.c_str() : nullptr);
        });

        tc.Run("the Shipping class is exactly what the launcher can send", [](TestCase &t)
        {
            launcher::Config c;
            c.isoPath = "game.iso";
            c.fpsOverlay = true;
            c.gamepadIndex = 0;
            c.crouchShortcut = "l2";
            c.micDevice = "Microphone";
            c.secondInstance = true;
            c.loginName = "socomc";          // Goal 9: sent only when the ONLINE fields are filled
            c.loginPassword = "hunter2";
            // Sprint 10 Goal 8 (R174): the mapping is sent only when it is not the default.
            launcher::mapping::Mapping custom = launcher::mapping::defaults();
            custom.pad[4].host = launcher::mapping::kHostL3;
            launcher::setActiveMapping(c, custom);
            std::set<std::string> sent;
            for (const std::string &kv : launcher::environmentFor(c))
                sent.insert(kv.substr(0, kv.find('=')));
            std::set<std::string> shipping;
            for (const ps2x::knobs::Entry &e : ps2x::knobs::kTable)
                if (e.cls == ps2x::knobs::Class::Shipping)
                    shipping.insert(e.name);
            for (const std::string &name : sent)
                t.IsTrue(shipping.count(name) == 1, name + ": sent by the launcher, so it must be Shipping");
            for (const std::string &name : shipping)
                t.IsTrue(sent.count(name) == 1, name + ": Shipping, so config.json must be able to set it");
            t.Equals(static_cast<int>(shipping.size()), 18, "eighteen settings: the plan's seventeen, PS2X_INPUT_MAPPING (Goal 8) and the two login knobs (Goal 9), less the two mouse knobs (Q3, R210)");
        });

        // ---- Sprint 9 Goal 3 Task 7: the flip ---------------------------------------------------------------

        tc.Run("enforcement is on by default: a process that says nothing is a stranger's", [](TestCase &t)
        {
            // ps2x_tests' main calls setDevMode(true) and nothing calls setEnforcement: what is read here is the default.
            t.IsTrue(ps2x::knobs::enforcement(), "Sprint 9 Goal 3 Task 7");
        });

        tc.Run("the behaviour-changing switches are Flags: 0 no longer switches one on", [](TestCase &t)
        {
            for (const char *name : {"PS2X_GIF_PRIORITY_SORT", "PS2X_GS_NO_DIRTY_REFRESH", "PS2X_GS_NO_TEX_REVALIDATE", "PS2X_GS_NO_ZTEST",
                                     "PS2X_SOCOM2_PAD", "PS2X_VIF1_NO_IRQ_STALL", "PS2X_VU1_FMAC_CHECK", "PS2X_VU1_XGKICK_CYCLE_EXACT"})
            {
                const ps2x::knobs::Entry *e = ps2x::knobs::find(name);
                t.IsTrue(e != nullptr && e->kind == ps2x::knobs::Kind::Flag, std::string(name) + ": Kind::Flag, read with knobOn");
            }
            const ps2x::knobs::Entry *pad = ps2x::knobs::find("PS2X_SOCOM2_PAD");
            t.IsTrue(pad != nullptr && std::string(pad->dflt) == "1", "the pad is on unless someone turns it off (R160)");
        });
    });
}
