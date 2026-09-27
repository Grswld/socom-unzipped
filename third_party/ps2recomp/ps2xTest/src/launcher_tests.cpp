// Task 8b: the launcher's logic -- the ISO 9660 lookup, SHA-256, config.json and the environment it becomes.
#include "MiniTest.h"
#include "launcher/bug_report.h"
#include "launcher/iso9660.h"
#include "ps2x/exit_codes.h"   // the selftest lists one line per row of that table
#include "launcher/launcher_config.h"
#include "launcher/launcher_layout.h"
#include "launcher/personas.h"   // Sprint 16 L1b (#73): the persona ledgers beside the cards
#include "launcher/mic_devices.h"
#include "launcher/sha256.h"
// Sprint 8 Goal 9: the redesigned launcher's pure halves -- the layout and the focus model, the pad's
// geometry, the glyph family, the scale factor. None of these headers touches raylib.
#include "ui/bind_flow.h"
#include "ui/chrome.h"
#include "ui/focus.h"
#include "ui/glyphs.h"
#include "ui/pad_input.h"
#include "ui/pad_render.h"
#include "ui/theme.h"
#include "ui/tips.h"   // issue #74: the tooltips
#include "font_advances.h"   // issue #74: the footer tip, measured in the launcher's face
#include "ps2x/host_window.h"   // Sprint 10 Q4: the game window's chrome holds the launcher's palette
#ifndef _WIN32
#include "../../ps2xLauncher/src/win32_glue.h"   // Sprint 8 Task 4: the POSIX glue, tested where it is built
#include <cerrno>
#include <chrono>
#include <csignal>
#include <fstream>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>
#endif

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <chrono>
#include <fstream>
#include <iterator>
#include <iostream>
#include <string>
#include <vector>

namespace
{
    // A 20-sector image: PVD at 16, root directory at 18 with ".", ".." and SCUS_972.75;1 -> sector 19, 5 bytes.
    std::vector<uint8_t> syntheticImage(bool withPvd = true)
    {
        std::vector<uint8_t> img(20u * 2048u, 0u);
        uint8_t *pvd = img.data() + 16u * 2048u;
        pvd[0] = 1;
        if (withPvd)
            std::memcpy(pvd + 1, "CD001", 5);
        auto put32both = [](uint8_t *at, uint32_t v)
        {
            at[0] = static_cast<uint8_t>(v); at[1] = static_cast<uint8_t>(v >> 8); at[2] = static_cast<uint8_t>(v >> 16); at[3] = static_cast<uint8_t>(v >> 24);
            at[4] = static_cast<uint8_t>(v >> 24); at[5] = static_cast<uint8_t>(v >> 16); at[6] = static_cast<uint8_t>(v >> 8); at[7] = static_cast<uint8_t>(v);
        };
        auto record = [&](uint8_t *at, uint32_t extent, uint32_t size, const char *name)
        {
            const size_t nameLen = std::strlen(name);
            const uint8_t len = static_cast<uint8_t>((33 + nameLen + 1) & ~1u);
            at[0] = len;
            put32both(at + 2, extent);
            put32both(at + 10, size);
            at[25] = 0;   // flags: a file
            at[32] = static_cast<uint8_t>(nameLen);
            std::memcpy(at + 33, name, nameLen);
            return len;
        };
        // the root directory record inside the PVD (34 bytes at 156): extent 18, size 2048
        uint8_t *root = pvd + 156;
        root[0] = 34;
        put32both(root + 2, 18u);
        put32both(root + 10, 2048u);
        root[25] = 2;
        root[32] = 1;
        root[33] = 0;
        uint8_t *dir = img.data() + 18u * 2048u;
        size_t off = 0;
        off += record(dir + off, 18u, 2048u, "\0");
        off += record(dir + off, 18u, 2048u, "\1");
        off += record(dir + off, 19u, 5u, "SCUS_972.75;1");
        off += record(dir + off, 19u, 3u, "SYSTEM.CNF;1");
        std::memcpy(img.data() + 19u * 2048u, "hello", 5);
        return img;
    }

    // Issue #74: every line the CONTROLLER page's tooltips can say, walked through the page's own focus list in every
    // shape it takes (SETUP with three pads, BUTTONS under each crouch value, each of the three dialogs), each crouch
    // value, each pad family, and the default mapping and two custom ones. `where` names the shape and the control, for a failure message.
    struct TipSeen
    {
        std::string where;
        std::string id;
        std::string line;
    };

    std::vector<TipSeen> controllerTipWalk()
    {
        using namespace launcher::mapping;
        const ui::Rect window{0.0f, 0.0f, 1100.0f, 700.0f};
        static ui::BindFlow idle;
        static ui::BindFlow conflict;
        conflict.state = ui::BindFlow::State::Conflict;
        conflict.button = kPs2L1;
        conflict.host = kHostR1;
        conflict.takenBy = kPs2R1;
        static ui::BindFlow switchConflict;
        switchConflict = conflict;
        switchConflict.button = ui::kSwitchTarget;
        static ui::BindFlow restore;
        restore.state = ui::BindFlow::State::ConfirmRestore;

        struct Shape
        {
            const char *what;
            ui::LayoutInputs in;
            const ui::BindFlow *flow;
        };
        std::vector<Shape> shapes;
        ui::LayoutInputs setup;
        setup.padChoices = 3;
        shapes.push_back(Shape{"SETUP", setup, &idle});
        ui::LayoutInputs buttons;
        buttons.padButtons = true;
        shapes.push_back(Shape{"BUTTONS", buttons, &idle});
        for (const ui::BindFlow *flow : {&conflict, &switchConflict, &restore})
        {
            ui::LayoutInputs dialog = buttons;
            dialog.padDialogButtons = ui::dialogButtonCount(*flow);
            shapes.push_back(Shape{"a dialog", dialog, flow});
        }

        // The bind and SWITCH lines name the pad button bound now, so their width depends on the mapping: the
        // defaults, and a player's own layout with Triangle and the switch on the two longest names ("D-PAD RIGHT",
        // "RS CLICK"), each way round.
        struct Layout
        {
            const char *what;
            int triangle;       // the host button Triangle is on; kHostNone keeps the default
            const char *toggle; // the switch's host button name
        };
        const Layout layouts[] = {
            {"default mapping", kHostNone, "guide"},
            {"Triangle on D-PAD RIGHT, switch on RS CLICK", kHostDpadRight, "r3"},
            {"Triangle on RS CLICK, switch on D-PAD RIGHT", kHostR3, "dpad_right"},
        };

        std::vector<TipSeen> out;
        for (const Layout &layout : layouts)
            for (const char *crouch : launcher::kCrouchShortcuts)
                for (const ui::GlyphFamily family : {ui::GlyphFamily::Xbox, ui::GlyphFamily::PlayStation, ui::GlyphFamily::Generic})
                    for (const Shape &shape : shapes)
                    {
                        launcher::Config c;
                        c.crouchShortcut = crouch;
                        c.focusToggle = layout.toggle;
                        if (layout.triangle != kHostNone)
                        {
                            Mapping m = launcher::activeMapping(c);
                            rebind(m, kPs2Triangle, layout.triangle, Resolution::Replace);
                            launcher::setActiveMapping(c, m);
                        }
                        const ui::TipState state{&c, family, shape.flow};
                        for (const ui::Node &n : ui::layoutFor(ui::Page::Controller, window, shape.in))
                            out.push_back(TipSeen{std::string(layout.what) + ", " + shape.what + ", crouch " + crouch + ": " + n.id,
                                                  n.id, ui::tipFor(ui::Page::Controller, n.id, state)});
                    }
        return out;
    }

    iso9660::Reader memoryReader(const std::vector<uint8_t> &img)
    {
        return [&img](uint64_t offset, void *dst, size_t size)
        {
            if (offset + size > img.size())
                return false;
            std::memcpy(dst, img.data() + offset, size);
            return true;
        };
    }
    // Sprint 16 L1b (#73): a cards/ directory under the temp folder, built by hand -- empty save files, synthetic
    // ledgers, never a real card (the portable pattern of preflight_tests.cpp's makeHome/removeHome).
    std::filesystem::path makeCardsDir()
    {
        static int counter = 0;
        const auto ticks = std::chrono::steady_clock::now().time_since_epoch().count();
        const std::filesystem::path root = std::filesystem::temp_directory_path() /
                                           ("ps2x_personas_" + std::to_string(ticks) + "_" + std::to_string(counter++));
        std::error_code ec;
        std::filesystem::create_directories(root / "cards", ec);
        return root / "cards";
    }

    void removeCardsDir(const std::filesystem::path &cards)
    {
        std::error_code ec;
        std::filesystem::remove_all(cards.parent_path(), ec);
    }

    void writeFileText(const std::filesystem::path &p, const std::string &text)
    {
        std::ofstream out(p, std::ios::binary | std::ios::trunc);
        out.write(text.data(), static_cast<std::streamsize>(text.size()));
    }

    std::string readFileText(const std::filesystem::path &p)
    {
        std::ifstream in(p, std::ios::binary);
        return std::string(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
    }

    // cards/<leaf>/BASCUS-97275SOCOMII/, with an empty SaveGame0 when asked (no disc bytes, only a name).
    void makeCard(const std::filesystem::path &cards, const std::string &leaf, bool withSaveGame = false)
    {
        std::error_code ec;
        std::filesystem::create_directories(cards / leaf / launcher::personas::kSaveFolder, ec);
        if (withSaveGame)
            writeFileText(cards / leaf / launcher::personas::kSaveFolder / "SaveGame0", "");
    }

    std::string ledgerText(const std::vector<launcher::personas::Persona> &records)
    {
        return launcher::personas::toJson(records);
    }

    launcher::personas::Persona persona(const std::string &name, const std::string &server, std::time_t lastLogin,
                                        bool savedPassword = false, bool second = false)
    {
        launcher::personas::Persona p;
        p.name = name;
        p.server = server;
        p.lastLogin = lastLogin;
        p.savedPassword = savedPassword;
        p.second = second;
        return p;
    }
}

void register_launcher_tests()
{
    MiniTest::Case("Launcher", [](TestCase &tc)
    {
        tc.Run("sha256: the FIPS vectors", [](TestCase &t)
        {
            t.Equals(sha256::hex(reinterpret_cast<const uint8_t *>("abc"), 3), std::string("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"), "abc");
            t.Equals(sha256::hex(reinterpret_cast<const uint8_t *>(""), 0), std::string("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"), "empty");
            const char *two = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
            t.Equals(sha256::hex(reinterpret_cast<const uint8_t *>(two), std::strlen(two)), std::string("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"), "two blocks");
            std::vector<uint8_t> million(1000000u, static_cast<uint8_t>('a'));
            t.Equals(sha256::hex(million.data(), million.size()), std::string("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"), "a million a's");
        });

        tc.Run("the controller pick and the dead zone round-trip and reach the environment", [](TestCase &t)
        {
            launcher::Config c;
            t.Equals(c.gamepadIndex, -1, "no pick by default: the first available pad, as before this task");
            t.IsTrue(c.padDeadZone > 0.1499 && c.padDeadZone < 0.1501, "the default dead zone is the runtime's 0.15");
            std::vector<std::string> env = launcher::environmentFor(c);
            auto has = [](const std::vector<std::string> &e, const std::string &kv) { return std::find(e.begin(), e.end(), kv) != e.end(); };
            auto hasKey = [](const std::vector<std::string> &e, const std::string &k) { return std::any_of(e.begin(), e.end(), [&](const std::string &s) { return s.rfind(k + "=", 0) == 0; }); };
            t.IsTrue(!hasKey(env, "PS2X_HOST_GAMEPAD_INDEX"), "no pick: the runtime is not told one, so it keeps its own rule");
            t.IsTrue(has(env, "PS2X_PAD_DEADZONE=0.15"), "the dead zone always ships, so what the player tuned is what the game gets");
            c.gamepadIndex = 2;
            c.padDeadZone = 0.3;
            env = launcher::environmentFor(c);
            t.IsTrue(has(env, "PS2X_HOST_GAMEPAD_INDEX=2"), "the picked slot");
            t.IsTrue(has(env, "PS2X_PAD_DEADZONE=0.3"), "the tuned dead zone");
            launcher::Config back;
            t.IsTrue(launcher::fromJson(launcher::toJson(c), back), "parses its own output");
            t.Equals(back.gamepadIndex, 2, "the pick survives the round trip");
            t.IsTrue(back.padDeadZone > 0.2999 && back.padDeadZone < 0.3001, "and so does the dead zone");
            launcher::Config partial;
            t.IsTrue(launcher::fromJson("{\"gsScale\": 1}", partial), "an older config.json parses");
            t.Equals(partial.gamepadIndex, -1, "a config written before this task keeps the old behaviour");
        });

        // Owner request 2026-09-19, R139: the crouch shortcut.
        tc.Run("the crouch shortcut: the stick click by default (owner 2026-09-20), off is sent as =off, tolerant of junk, round-trips, reaches the environment", [](TestCase &t)
        {
            auto has = [](const std::vector<std::string> &e, const std::string &kv) { return std::find(e.begin(), e.end(), kv) != e.end(); };

            launcher::Config c;
            t.Equals(c.crouchShortcut, std::string("l3"), "the left stick click by default: without it a pad cannot crouch at all (owner 2026-09-20)");
            t.IsTrue(has(launcher::environmentFor(c), "PS2X_PAD_CROUCH_SHORTCUT=l3"), "and the default reaches the game");
            launcher::Config offConfig;
            offConfig.crouchShortcut = "off";
            const std::vector<std::string> before = launcher::environmentFor(offConfig);
            // O12: the runtime's unset is l3 now, so OFF has to be said -- sending nothing would crouch on L3.
            t.IsTrue(has(before, "PS2X_PAD_CROUCH_SHORTCUT=off"), "off is sent as off: an unset variable means l3 to the game");

            const char *values[3] = {"l3", "touchpad", "l2"};
            for (const char *v : values)
            {
                c.crouchShortcut = v;
                const std::vector<std::string> env = launcher::environmentFor(c);
                t.IsTrue(has(env, std::string("PS2X_PAD_CROUCH_SHORTCUT=") + v), std::string("reaches the environment: ") + v);
                t.Equals(env.size(), before.size(), "and replaces off's line: nothing else changes");
                launcher::Config back;
                t.IsTrue(launcher::fromJson(launcher::toJson(c), back), "parses its own output");
                t.Equals(back.crouchShortcut, std::string(v), std::string("survives the round trip: ") + v);
            }

            t.Equals(launcher::normalizeCrouchShortcut("l3"), std::string("l3"), "a known value is itself");
            t.Equals(launcher::normalizeCrouchShortcut("R3"), std::string("off"), "an unknown value is off");
            t.Equals(launcher::normalizeCrouchShortcut(""), std::string("off"), "and so is an empty one");
            launcher::Config junk;
            junk.crouchShortcut = "l3";
            t.IsTrue(launcher::fromJson("{\"crouchShortcut\": \"banana\"}", junk), "a config with a value from nowhere still parses");
            t.Equals(junk.crouchShortcut, std::string("off"), "and the value is off, not kept and not guessed");
            junk.crouchShortcut = "banana";   // set in memory by a bug, not by the file
            t.IsTrue(has(launcher::environmentFor(junk), "PS2X_PAD_CROUCH_SHORTCUT=off") && !has(launcher::environmentFor(junk), "PS2X_PAD_CROUCH_SHORTCUT=banana"),
                     "junk never reaches the game: it is sent as off");
            launcher::Config partial;
            t.IsTrue(launcher::fromJson("{\"gsScale\": 1}", partial), "an older config.json parses");
            t.Equals(partial.crouchShortcut, std::string("l3"), "a config written before the option gets the default, like a new one");

            // The words on the page: a label per cell, and the one line that states the trade (R139).
            for (int i = 0; i < launcher::kCrouchShortcutCount; ++i)
            {
                t.IsTrue(std::strlen(launcher::crouchShortcutLabel(launcher::kCrouchShortcuts[i])) > 0, "every value has a label");
                t.IsTrue(std::strlen(launcher::crouchShortcutHint(launcher::kCrouchShortcuts[i])) > 0, "and a hint");
                t.IsTrue(std::strlen(launcher::crouchShortcutHint(launcher::kCrouchShortcuts[i])) <= 104, "that fits one caption line");
            }
            t.IsTrue(std::string(launcher::crouchShortcutHint("l3")).find("fire mode") != std::string::npos ||
                         std::string(launcher::crouchShortcutHint("l3")).find("Fire mode") != std::string::npos,
                     "l3 says what it costs: fire mode leaves the pad");
            t.IsTrue(std::string(launcher::crouchShortcutHint("l3")).find("2") != std::string::npos, "and where it went: the keyboard's 2");
            t.IsTrue(std::string(launcher::crouchShortcutHint("l2")).find("weapon") != std::string::npos, "l2 says what it costs: the second weapon swap");
            t.IsTrue(std::string(launcher::crouchShortcutHint("touchpad")).find("othing") != std::string::npos, "touchpad says it costs nothing");
        });

        tc.Run("the profile names a directory, so it cannot leave cards/: separators, dots and junk are refused", [](TestCase &t)
        {
            // PS2X_MC_DIR is built as "cards/" + profile (launcher_config.cpp) and the runner resolves a relative
            // value under its own home (bare_run.cpp). The profile is free text in a config.json a player may well
            // have been sent by someone else, so "../.." there would put the game's memory-card writes anywhere the
            // player can write. It is a name, not a path: it stays one.
            t.Equals(launcher::normalizeProfile("craig"), std::string("craig"), "an ordinary name is itself");
            t.Equals(launcher::normalizeProfile("Craig 2_b-a.1"), std::string("Craig 2_b-a.1"), "letters, digits, space, _ - . are kept");
            t.Equals(launcher::normalizeProfile(""), std::string("player"), "an empty profile is the default");
            t.Equals(launcher::normalizeProfile(".."), std::string("player"), "so is the parent directory");
            t.Equals(launcher::normalizeProfile("."), std::string("player"), "and the current one");
            t.Equals(launcher::normalizeProfile("../../Windows"), std::string("player"), "a climb out is refused whole, not patched up");
            t.Equals(launcher::normalizeProfile("a/b"), std::string("player"), "a separator is refused");
            t.Equals(launcher::normalizeProfile("a\\b"), std::string("player"), "the other separator too");
            t.Equals(launcher::normalizeProfile("C:evil"), std::string("player"), "and a drive letter");
            t.Equals(launcher::normalizeProfile(std::string(300, 'x')).size(), static_cast<size_t>(64), "a very long name is cut to 64");

            launcher::Config c;
            c.profile = "../../../Users/Public";
            const std::vector<std::string> env = launcher::environmentFor(c);
            auto has = [&env](const std::string &kv) {
                return std::find(env.begin(), env.end(), kv) != env.end();
            };
            t.IsTrue(has("PS2X_MC_DIR=cards/player"), "the environment carries the safe name, never the climb");

            launcher::Config loaded;
            t.IsTrue(launcher::fromJson("{\"profile\": \"../../../etc\"}", loaded), "such a config still parses");
            t.Equals(loaded.profile, std::string("player"), "and what it loaded is already safe");
        });

        tc.Run("iso9660: the root directory lookup finds SCUS_972.75 (with its ;1), rejects the rest", [](TestCase &t)
        {
            const std::vector<uint8_t> img = syntheticImage();
            iso9660::FileEntry e;
            t.IsTrue(iso9660::findRootFile(memoryReader(img), "SCUS_972.75", e), "found");
            t.Equals(e.extent, 19u, "extent");
            t.Equals(e.size, 5u, "size");
            std::vector<uint8_t> bytes;
            t.IsTrue(iso9660::readFile(memoryReader(img), e, bytes) && bytes.size() == 5u && std::memcmp(bytes.data(), "hello", 5) == 0, "read");
            t.IsTrue(iso9660::findRootFile(memoryReader(img), "SYSTEM.CNF", e) && e.size == 3u, "another root file");
            t.IsTrue(!iso9660::findRootFile(memoryReader(img), "NOPE.BIN", e), "an absent name");
            const std::vector<uint8_t> noPvd = syntheticImage(false);
            t.IsTrue(!iso9660::findRootFile(memoryReader(noPvd), "SCUS_972.75", e), "no CD001: not an ISO");
            std::vector<uint8_t> shortImg(img.begin(), img.begin() + 17u * 2048u);
            t.IsTrue(!iso9660::findRootFile(memoryReader(shortImg), "SCUS_972.75", e), "a truncated image is refused, not read past its end");
            t.IsTrue(!iso9660::fileReader("no_such_file_here.iso"), "a missing file gives no reader");
        });

        tc.Run("the real disc's SCUS_972.75 hashes to the pinned r0001 digest (skipped without the ISO)", [](TestCase &t)
        {
            const char *candidates[] = {"../../../../game/SOCOM II - U.S. Navy SEALs (USA).iso", "game/SOCOM II - U.S. Navy SEALs (USA).iso"};
            iso9660::Reader read;
            for (const char *c : candidates)
            {
                read = iso9660::fileReader(c);
                if (read)
                    break;
            }
            if (!read)
                return;   // no disc on this machine
            iso9660::FileEntry e;
            t.IsTrue(iso9660::findRootFile(read, launcher::kSocom2ElfName, e), "SCUS_972.75 is in the root directory");
            t.Equals(e.size, 874792u, "its size");
            std::vector<uint8_t> bytes;
            t.IsTrue(iso9660::readFile(read, e, bytes), "read");
            t.Equals(sha256::hex(bytes.data(), bytes.size()), std::string(launcher::kSocom2R0001ElfSha256), "the r0001 digest");
        });

        tc.Run("config.json round-trips, tolerates unknown keys, and defaults on a malformed file", [](TestCase &t)
        {
            launcher::Config c;
            c.isoPath = "D:\\games\\socom2.iso";
            c.gsScale = 2;
            c.presentFilter = "integer";
            c.windowSize = "1280x896";
            c.server = "192.0.2.10";
            c.profile = "craig";
            c.secondInstance = true;
            const std::string json = launcher::toJson(c);
            t.IsTrue(json.find("\"isoPath\"") != std::string::npos && json.find("D:\\\\games\\\\socom2.iso") != std::string::npos, "the path is escaped");
            t.IsTrue(json.find("mouse") == std::string::npos, "Sprint 10 Q3 (R210): no mouse key is written any more");
            launcher::Config back;
            t.IsTrue(launcher::fromJson(json, back), "parses its own output");
            t.IsTrue(back.isoPath == c.isoPath && back.gsScale == 2 && back.presentFilter == "integer" && back.windowSize == "1280x896" && back.server == c.server && back.profile == "craig" && back.secondInstance, "every field survives");
            // Sprint 10 Q3 (R210): a config.json written before the mouse left still carries "mouseLook" and
            // "mouseSensitivity" (every launcher up to 2026-09-21 wrote both, in this position). It loads without
            // complaint, the two keys are ignored, and everything after them is still read.
            launcher::Config old;
            t.IsTrue(launcher::fromJson("{\"gsScale\": 2, \"mouseLook\": true, \"mouseSensitivity\": 1.5, \"gamepadIndex\": 1, \"profile\": \"craig\"}", old),
                     "an old config with the mouse keys loads");
            t.IsTrue(old.gsScale == 2 && old.gamepadIndex == 1 && old.profile == "craig", "and the keys around them are read");
            t.IsTrue(launcher::toJson(old).find("mouse") == std::string::npos, "the next save drops them");
            launcher::Config partial;
            t.IsTrue(launcher::fromJson("{\"gsScale\": 3, \"future\": [1,2,3], \"profile\": \"x\"}", partial), "unknown keys are ignored");
            t.IsTrue(partial.gsScale == 3 && partial.profile == "x" && partial.windowSize == "640x448" && partial.server == "127.0.0.1", "missing keys keep their defaults");
            t.Equals(launcher::Config{}.windowSize, std::string("640x448"), "the launcher's default is the game's own 640x448 (the owner, 2026-09-22)");
            launcher::Config broken;
            broken.gsScale = 2;
            t.IsTrue(!launcher::fromJson("{\"gsScale\": ", broken), "malformed JSON is refused");
            t.Equals(broken.gsScale, 1, "... and the config is the defaults");
        });

        tc.Run("the environment: the knobs the runtime reads, the pad always, the second instance's shift and key", [](TestCase &t)
        {
            launcher::Config c;
            std::vector<std::string> env = launcher::environmentFor(c);
            auto has = [&](const std::string &kv) { return std::find(env.begin(), env.end(), kv) != env.end(); };
            auto hasKey = [&](const std::string &k) { return std::any_of(env.begin(), env.end(), [&](const std::string &e) { return e.rfind(k + "=", 0) == 0; }); };
            t.IsTrue(has("PS2X_SOCOM2_PAD=1"), "the SOCOM input path is always on");
            t.IsTrue(has("PS2X_GS_SCALE=1"), "native scale");
            t.IsTrue(has("PS2X_PRESENT_FILTER=linear"), "the filter");
            t.IsTrue(has("PS2X_WINDOW_SIZE=640x448"), "the window size: the launcher sends the game's own 640x448, the same size the gate runs at");
            t.IsTrue(has("PS2X_SOCOM2_SERVER=socom.scotho.com"),
                     "the server: a fresh config plays on the project's hosted server, reached by name (Sprint 9 P6, R175)");
            t.IsTrue(has("PS2X_MC_DIR=cards/player"), "the profile's card directory");
            t.IsTrue(!hasKey("PS2X_SOCOM2_UDP_SHIFT") && !hasKey("PS2X_SOCOM2_RSA_KEY"), "first instance: no shift, no second key");
            c.gsScale = 2;
            c.secondInstance = true;
            c.profile = "craig";
            c.windowSize = "fullscreen";
            env = launcher::environmentFor(c);
            t.IsTrue(has("PS2X_GS_SCALE=2") && has("PS2X_WINDOW_SIZE=fullscreen"), "scale, fullscreen");
            // Sprint 10 Q3 (R210): the mouse left -- no configuration sends a PS2X_SOCOM2_MOUSE* variable any more.
            t.IsTrue(!hasKey("PS2X_SOCOM2_MOUSE") && !hasKey("PS2X_SOCOM2_MOUSE_SENS"), "no mouse knobs, whatever the config says");
            t.IsTrue(has("PS2X_SOCOM2_UDP_SHIFT=2") && has("PS2X_SOCOM2_RSA_KEY=b") && has("PS2X_MC_DIR=cards/craig_b"), "the second instance: shift 2, key b, its own cards");
        });

        tc.Run("server presets: the picker's choice round-trips and an unknown one falls back to custom", [](TestCase &t)
        {
            launcher::Config c;
            t.Equals(c.serverPreset, std::string("unzipped"), "the default preset is the project's hosted server, now that it is real");
            // A config.json from before the picker existed carries a typed server and no preset: it must stay the player's own.
            launcher::Config legacy;
            t.IsTrue(launcher::fromJson("{\"server\": \"192.0.2.10\"}", legacy), "a pre-picker config parses");
            t.Equals(legacy.serverPreset, std::string("custom"), "a typed server with no preset stays custom");
            t.Equals(launcher::effectiveServer(legacy), std::string("192.0.2.10"), "and its address still applies");
            c.serverPreset = "unzipped";
            c.server = "192.0.2.10";
            launcher::Config back;
            t.IsTrue(launcher::fromJson(launcher::toJson(c), back), "parses its own output");
            t.Equals(back.serverPreset, std::string("unzipped"), "the preset survives the round trip");
            t.Equals(back.server, std::string("192.0.2.10"), "... and so does the custom address behind it");
            launcher::Config odd;
            t.IsTrue(launcher::fromJson("{\"serverPreset\": \"horizon-2\"}", odd), "an unknown preset parses");
            t.Equals(odd.serverPreset, std::string("custom"), "... as custom, so the player's own address still applies");
            t.IsTrue(launcher::findServerPreset("nope") == nullptr, "an unknown id has no preset");
            const launcher::ServerPreset *community = launcher::findServerPreset("community");
            t.IsTrue(community != nullptr && std::string(community->address) == "COMMUNITY_SERVER_ADDRESS_TBC", "the community preset's address is the placeholder, not a guess");
        });

        // Sprint 7 Task 4 Step 5: the assertion that goes live the moment the owner supplies the hosted address.
        // Until then it reports itself as skipped rather than failing - MiniTest has no Skip, so the reason is
        // printed and nothing is asserted (docs/archive/HUMAN_TASKS-to-2026-09-25.md: "The two server addresses for the
        // launcher's picker"; ours is real since 2026-09-19, the community one is row O5 of docs/HUMAN_TASKS.md).
        tc.Run("server presets: the Unzipped preset ships a real address and is the default", [](TestCase &t)
        {
            const launcher::ServerPreset *unzipped = launcher::findServerPreset("unzipped");
            t.IsTrue(unzipped != nullptr, "the Unzipped preset exists");
            if (unzipped == nullptr)
                return;
            if (std::string(unzipped->address) == "UNZIPPED_SERVER_ADDRESS_TBC")
            {
                std::cout << "[skipped: the owner has not supplied the hosted address yet (docs/archive/HUMAN_TASKS-to-2026-09-25.md)] ";
            }
            else
            {
                t.IsTrue(std::string(unzipped->address).find("TBC") == std::string::npos, "no placeholder ships");
                t.Equals(launcher::Config{}.serverPreset, std::string("unzipped"), "the default preset is ours once it is real");
            }
        });

        tc.Run("the environment: the chosen preset decides PS2X_SOCOM2_SERVER", [](TestCase &t)
        {
            auto serverOf = [](const launcher::Config &c)
            {
                for (const std::string &kv : launcher::environmentFor(c))
                    if (kv.rfind("PS2X_SOCOM2_SERVER=", 0) == 0)
                        return kv.substr(std::strlen("PS2X_SOCOM2_SERVER="));
                return std::string("<missing>");
            };
            launcher::Config c;
            c.serverPreset = "community";
            c.server = "198.51.100.5";
            // Fourth pass: a preset still carrying a placeholder is not playable, so it does not win the
            // field -- it resolves to the project's own server rather than sending the game a placeholder.
            t.Equals(serverOf(c), std::string("socom.scotho.com"), "an unavailable preset resolves to the one that exists");
            c.serverPreset = "unzipped";
            t.Equals(serverOf(c), std::string("socom.scotho.com"), "our own hosted server, by name (Lightsail, US East)");
            t.Equals(launcher::effectiveServer(launcher::Config{}), std::string("socom.scotho.com"), "a fresh config resolves to it");
            // Sprint 10 (owner, 2026-09-20): the by-address preset is gone; its id is retired, not unknown,
            // so a config that names it still plays on the same server (by name) rather than falling to Custom.
            t.IsTrue(launcher::findServerPreset("unzipped-ip") == nullptr, "the by-address preset is no longer offered");
            launcher::Config retired;
            launcher::fromJson("{\"serverPreset\": \"unzipped-ip\", \"server\": \"3.143.65.100\"}", retired);
            t.Equals(retired.serverPreset, std::string("unzipped"), "a config naming the retired id heals to the project server");
            t.Equals(serverOf(retired), std::string("socom.scotho.com"), "and reaches it by name");
            c.serverPreset = "custom";
            t.Equals(serverOf(c), std::string("198.51.100.5"), "custom uses the typed address");
            c.server.clear();
            t.Equals(serverOf(c), std::string("127.0.0.1"), "custom with nothing typed: the loopback default");
            t.Equals(launcher::effectiveServer(c), std::string("127.0.0.1"), "effectiveServer agrees");
        });

        tc.Run("exit code 65 tells the player the GL probe fell back to the CPU renderer", [](TestCase &t)
        {
            t.Equals(launcher::exitMessage(65),
                     std::string("Your GPU or driver is missing OpenGL 3.3 with dual-source blending; the game ran on the slow CPU renderer."),
                     "65 (GsGlCaps::kExitCode) names the missing capability and what happened");
            t.Equals(launcher::exitMessage(0), std::string("The last run exited normally."), "a clean exit says so");
            t.IsTrue(launcher::exitMessage(1).find("SAVE DIAGNOSTICS") != std::string::npos, "an unnamed failure points at the diagnostics (Sprint 9 Goal 1: no ending is silent)");
        });

        tc.Run("LAST RUN: the code's sentence, a crash by its native status, a stranger by number, a notice appended", [](TestCase &t)
        {
            t.Equals(launcher::lastRunLine(0, ""), std::string("The last run exited normally."), "a clean run");
            t.Equals(launcher::lastRunLine(67, ""),
                     std::string("That disc image is not SOCOM II NTSC r0001 (SCUS-97275). This build plays only that disc."), "67");
            t.Equals(launcher::lastRunLine(static_cast<int>(0xC0000005u), ""),
                     std::string("The game crashed. Press SAVE DIAGNOSTICS and send the zip; it holds the crash record."), "Windows' access violation");
            t.Equals(launcher::lastRunLine(139, ""), launcher::lastRunLine(static_cast<int>(0xC0000005u), ""), "and Linux's SIGSEGV read the same");
            t.Equals(launcher::lastRunLine(42, ""), std::string("The game closed with code 42. Press SAVE DIAGNOSTICS to collect the log."), "never 'the game exited'");
            const std::string log = "INFO: AUDIO: Failed to initialize playback device\n[notice] no-audio-device: No audio device was found; the game ran without sound.\n";
            t.Equals(launcher::lastRunLine(0, log),
                     std::string("The last run exited normally. No audio device was found; the game ran without sound."),
                     "audio absent is not an exit: it rides on whatever the exit was");
        });

        tc.Run("the selftest lists every exit code with its sentence", [](TestCase &t)
        {
            const std::vector<std::string> lines = launcher::selftestExitLines();
            t.Equals(static_cast<int>(lines.size()), ExitCodes::kTableSize, "one line per code in the table");
            auto has = [&](const std::string &l) { return std::find(lines.begin(), lines.end(), l) != lines.end(); };
            t.IsTrue(has("exit   0 ok: The last run exited normally."), "0");
            t.IsTrue(has("exit  65 no-usable-gl: Your GPU or driver is missing OpenGL 3.3 with dual-source blending; the game ran on the slow CPU renderer."), "65");
            t.IsTrue(has("exit  72 card-dir-unwritable: The memory-card folder cannot be written. Move the game out of a protected folder and try again."), "72");
            t.IsTrue(has("exit  73 revision-mismatch: These game files are a different disc revision than this copy of the game was built for. Unpack the download again."), "73");
            t.IsTrue(has("exit  74 reboot-requested: The game asked to restart itself after an error. This build cannot restart, so it stopped; the log says why."), "74");
        });

        tc.Run("the environment: the verified ISO reaches the runtime as PS2X_CD_IMAGE", [](TestCase &t)
        {
            launcher::Config c;
            c.isoPath = "C:/discs/socom2.iso";
            std::vector<std::string> env = launcher::environmentFor(c);
            auto has = [&](const std::string &kv) { return std::find(env.begin(), env.end(), kv) != env.end(); };
            auto hasKey = [&](const std::string &k) { return std::any_of(env.begin(), env.end(), [&](const std::string &e) { return e.rfind(k + "=", 0) == 0; }); };
            t.IsTrue(has("PS2X_CD_IMAGE=C:/discs/socom2.iso"), "the disc the launcher verified is the disc the runtime mounts");
            launcher::Config empty;
            env = launcher::environmentFor(empty);
            t.IsTrue(!hasKey("PS2X_CD_IMAGE"), "no ISO configured: the runtime keeps its own .iso search");
        });

        tc.Run("the FPS overlay is off unless the player asks for it", [](TestCase &t)
        {
            launcher::Config c;
            t.IsTrue(!c.fpsOverlay, "off by default: nothing is drawn over anyone's game unasked");
            std::vector<std::string> env = launcher::environmentFor(c);
            auto hasKey = [](const std::vector<std::string> &e, const std::string &k) { return std::any_of(e.begin(), e.end(), [&](const std::string &s) { return s.rfind(k + "=", 0) == 0; }); };
            t.IsTrue(!hasKey(env, "PS2X_FPS_OVERLAY"), "off: the knob is not set at all, rather than set to 0");
            c.fpsOverlay = true;
            env = launcher::environmentFor(c);
            t.IsTrue(std::find(env.begin(), env.end(), std::string("PS2X_FPS_OVERLAY=1")) != env.end(), "on: exactly the value the runtime tests for");
            launcher::Config back;
            t.IsTrue(launcher::fromJson(launcher::toJson(c), back), "parses its own output");
            t.IsTrue(back.fpsOverlay, "the choice survives the round trip");
        });

        tc.Run("the fourth scale, the matched display size, and the master volume reach the environment", [](TestCase &t)
        {
            launcher::Config c;
            t.Equals(c.audioVolume, 100, "full volume by default: the mixer is untouched unless the player moves it");
            std::vector<std::string> env = launcher::environmentFor(c);
            auto has = [](const std::vector<std::string> &e, const std::string &kv) { return std::find(e.begin(), e.end(), kv) != e.end(); };
            t.IsTrue(has(env, "PS2X_AUDIO_VOLUME=100"), "unity always ships, so config.json is the one source of the value");
            c.gsScale = 4;
            c.windowSize = "2560x1440";      // what "Match display" resolved to on the player's monitor
            c.audioVolume = 35;
            env = launcher::environmentFor(c);
            t.IsTrue(has(env, "PS2X_GS_SCALE=4"), "the fourth radio reaches the backend's top clamp");
            t.IsTrue(has(env, "PS2X_WINDOW_SIZE=2560x1440"), "a matched display is an ordinary <w>x<h>, not a magic word");
            t.IsTrue(has(env, "PS2X_AUDIO_VOLUME=35"), "the volume the player set");
            launcher::Config back;
            t.IsTrue(launcher::fromJson(launcher::toJson(c), back), "parses its own output");
            t.IsTrue(back.gsScale == 4 && back.windowSize == "2560x1440" && back.audioVolume == 35, "all three survive the round trip");
            launcher::Config partial;
            t.IsTrue(launcher::fromJson("{\"gsScale\": 2}", partial), "an older config.json parses");
            t.Equals(partial.audioVolume, 100, "a config written before this task is still full volume");
        });

        tc.Run("the microphone pick round-trips and only reaches the environment when there is one", [](TestCase &t)
        {
            launcher::Config c;
            t.Equals(c.micDevice, std::string(""), "no microphone by default");
            std::vector<std::string> env = launcher::environmentFor(c);
            auto hasKey = [](const std::vector<std::string> &e, const std::string &k) { return std::any_of(e.begin(), e.end(), [&](const std::string &s) { return s.rfind(k + "=", 0) == 0; }); };
            t.IsTrue(!hasKey(env, "PS2X_MIC_DEVICE"), "no pick: the runtime opens no capture device at all");
            c.micDevice = "Microphone (USB Headset)";
            env = launcher::environmentFor(c);
            t.IsTrue(std::find(env.begin(), env.end(), std::string("PS2X_MIC_DEVICE=Microphone (USB Headset)")) != env.end(), "the device name, spaces and brackets and all");
            launcher::Config back;
            t.IsTrue(launcher::fromJson(launcher::toJson(c), back), "parses its own output");
            t.Equals(back.micDevice, c.micDevice, "the device name survives the round trip");
        });

        // Sprint 10 Goal 9 (research/37, /38): the persona name and its password, typed once on ONLINE, handed to
        // the game as PS2X_SOCOM2_LOGIN_NAME / _PASS for the keyboard prefill (R179: plain in the player's own
        // config.json; R180: prefilled, never submitted). Unset when empty, so a config that never typed them is
        // the game exactly as before the option.
        tc.Run("the persona name and password round-trip the config and reach the game only when set", [](TestCase &t)
        {
            auto has = [](const std::vector<std::string> &e, const std::string &kv) { return std::find(e.begin(), e.end(), kv) != e.end(); };
            auto hasKey = [](const std::vector<std::string> &e, const std::string &k) { return std::any_of(e.begin(), e.end(), [&](const std::string &s) { return s.rfind(k + "=", 0) == 0; }); };
            launcher::Config c;
            t.IsTrue(c.loginName.empty() && c.loginPassword.empty(), "a fresh config has neither");
            std::vector<std::string> env = launcher::environmentFor(c);
            t.IsFalse(hasKey(env, "PS2X_SOCOM2_LOGIN_NAME"), "nothing typed: the game is not told a name");
            t.IsFalse(hasKey(env, "PS2X_SOCOM2_LOGIN_PASS"), "nor a password -- the keyboards open empty, as today");

            c.loginName = "socomc";
            c.loginPassword = "socom";
            env = launcher::environmentFor(c);
            t.IsTrue(has(env, "PS2X_SOCOM2_LOGIN_NAME=socomc"), "the name reaches the game");
            t.IsTrue(has(env, "PS2X_SOCOM2_LOGIN_PASS=socom"), "and the password");

            launcher::Config back;
            t.IsTrue(launcher::fromJson(launcher::toJson(c), back), "parses its own output");
            t.Equals(back.loginName, std::string("socomc"), "the name survives the round trip");
            t.Equals(back.loginPassword, std::string("socom"), "and the password (R179: plain, in the player's own file)");
            t.IsTrue(launcher::toJson(c).find("\"loginPassword\": \"socom\"") != std::string::npos, "written under its own key, so the sanitiser can find it");

            // The name is what the game's keyboard could have typed: its characters, its cap (research/38: the
            // keyboard has every printable ASCII key but the space, refuses the double quote, and caps at 14).
            t.Equals(launcher::kLoginNameCap, static_cast<size_t>(14), "the name keyboard's MaxChars");
            t.Equals(launcher::kLoginPasswordCap, static_cast<size_t>(12), "the password keyboard's MaxChars");
            t.Equals(launcher::normalizeLoginName("socomc"), std::string("socomc"), "a plain name is kept");
            t.Equals(launcher::normalizeLoginName("Sgt_Rock-1.5"), std::string("Sgt_Rock-1.5"), "the marks the keyboard has are kept");
            t.Equals(launcher::normalizeLoginName("so com"), std::string("socom"), "a space is not a keyboard character");
            t.Equals(launcher::normalizeLoginName("a\"b"), std::string("ab"), "nor is the double quote on the name keyboard (NoDQuote)");
            t.Equals(launcher::normalizeLoginName("caf\xc3\xa9"), std::string("caf"), "nor anything outside ASCII");
            t.Equals(launcher::normalizeLoginName("abcdefghijklmnopqrstuvwxyz"), std::string("abcdefghijklmn"), "cut to the keyboard's cap");
            t.Equals(launcher::normalizeLoginName(""), std::string(), "empty stays empty");
            t.Equals(launcher::normalizeLoginPassword("hunter2"), std::string("hunter2"), "a plain password is kept");
            t.Equals(launcher::normalizeLoginPassword("pa ss\"w"), std::string("pass\"w"), "the password keyboard has the double quote but no space");
            t.Equals(launcher::normalizeLoginPassword("abcdefghijklmnop"), std::string("abcdefghijkl"), "cut to the password keyboard's cap");
            c.loginName = "so com";
            c.loginPassword = "hun ter2";
            env = launcher::environmentFor(c);
            t.IsTrue(has(env, "PS2X_SOCOM2_LOGIN_NAME=socom"), "what reaches the game is the normalised name");
            t.IsTrue(has(env, "PS2X_SOCOM2_LOGIN_PASS=hunter2"), "and the normalised password");
            c.loginName = "   ";
            env = launcher::environmentFor(c);
            t.IsFalse(hasKey(env, "PS2X_SOCOM2_LOGIN_NAME"), "a name that normalises to nothing is not sent");
        });

        tc.Run("micLevelDb: RMS in dB full scale, -inf for silence", [](TestCase &t)
        {
            // A full-scale sine has RMS 1/sqrt(2), i.e. -3.0103 dB, whatever its frequency or phase.
            std::vector<float> sine(1600);   // 0.1 s at 16 kHz, ten whole cycles: no partial-cycle bias
            for (size_t i = 0; i < sine.size(); ++i)
                sine[i] = std::sin(2.0f * 3.14159265358979f * 100.0f * static_cast<float>(i) / 16000.0f);
            const float full = launcher::micLevelDb(sine.data(), sine.size());
            t.IsTrue(std::fabs(full + 3.0103f) < 0.05f, "a full-scale sine reads -3.01 dB");
            std::vector<float> half = sine;
            for (float &v : half)
                v *= 0.5f;
            t.IsTrue(std::fabs(launcher::micLevelDb(half.data(), half.size()) - (full - 6.0206f)) < 0.01f, "halving the amplitude drops it exactly 6.02 dB");
            const std::vector<float> quiet(1600, 0.0f);
            const float silent = launcher::micLevelDb(quiet.data(), quiet.size());
            t.IsTrue(std::isinf(silent) && silent < 0.0f, "silence is -inf, not 0 and not a crash");
            const float none = launcher::micLevelDb(nullptr, 0);
            t.IsTrue(std::isinf(none) && none < 0.0f, "no frames is -inf too");
        });

        // Sprint 7 review finding: with Windows DPI scaling at 125-150% the 932 px window is 1165-1398 px
        // tall on a 768 or 1080 laptop panel, so the Launch row sits below the screen and nothing resizes.
        // The window opens at whatever the monitor allows and the body scrolls to reach the rest.
        tc.Run("the launcher fits a short display and scrolls its body", [](TestCase &t)
        {
            t.Equals(launcher::fitWindowHeight(932, 768, 80), 688, "a 768 px panel opens the window at 688, not 932 with the Launch row off-screen");
            t.Equals(launcher::fitWindowHeight(932, 1440, 80), 932, "a tall display still gets the full content height");
            t.Equals(launcher::scrollClamp(-10, 932, 688), 0, "scrolling up past the top stops at the top");
            t.Equals(launcher::scrollClamp(999, 932, 688), 244, "scrolling down stops with the last pixel of content visible");
            t.Equals(launcher::scrollClamp(5, 500, 688), 0, "content shorter than the window does not scroll at all");
        });

        tc.Run("the microphone list is whatever MicDevices reports, with None first", [](TestCase &t)
        {
            struct FakeMic final : launcher::MicDevices
            {
                std::vector<std::string> list() override { return {"Microphone (USB Headset)", "Stereo Mix"}; }
                bool startMeter(const std::string &name) override { started = name; return name == "Stereo Mix"; }
                float levelDb() const override { return -12.5f; }
                void stopMeter() override { started.clear(); }
                std::string started;
            };
            FakeMic mic;
            const std::vector<std::string> labels = launcher::micLabels(mic);
            t.Equals(labels.size(), static_cast<size_t>(3), "None plus the two devices");
            t.Equals(labels[0], std::string("None"), "None is first, so 'no microphone' is a click, not an empty field");
            t.Equals(labels[1], std::string("Microphone (USB Headset)"), "the device names come through unchanged");
            // Sprint 7 review finding F9: the two startMeter assertions that used to stand here asserted the
            // FAKE's own return value ("Stereo Mix" opens, anything else does not), which is this test file's
            // code and not the launcher's. micLabels is the launcher logic under test here.
            // Review finding F8: stopMeter() is the half main.cpp calls on Launch, so it has to be safe to call
            // at any time -- before any start, and twice in a row.
            mic.stopMeter();
            mic.stopMeter();
            t.IsTrue(mic.started.empty(), "stopMeter before any start, and twice over, is a no-op");
        });

        // Sprint 8 Task 4: the environment the game is started with. Windows built its block inline and the
        // POSIX spawn needs exactly the same rule, so the rule is one pure function shared by both glues.
        tc.Run("mergeEnvironment: ours win by key, base order kept, ours appended", [](TestCase &t)
        {
            const char *const base[] = {"A=1", "B=2", nullptr};
            const std::vector<std::string> merged = launcher::mergeEnvironment(base, {"B=3", "C=4"});
            t.Equals(merged.size(), static_cast<size_t>(3), "one A, one B, one C -- the overridden base B is gone, not duplicated");
            t.Equals(merged[0], std::string("A=1"), "a base entry nobody overrides survives unchanged");
            t.Equals(merged[1], std::string("B=3"), "ours wins B");
            t.Equals(merged[2], std::string("C=4"), "ours that the base lacks is appended, in our order");

            // A key with no '=' is not an environment entry: execve would take it, the child could not read it.
            const std::vector<std::string> skipped = launcher::mergeEnvironment(base, {"D"});
            t.Equals(skipped.size(), static_cast<size_t>(2), "a key-only entry is dropped, not spawned");
            t.Equals(skipped[0], std::string("A=1"), "the base is otherwise untouched");
            t.Equals(skipped[1], std::string("B=2"), "and B keeps its base value when nothing overrides it");

            const char *const none[] = {nullptr};
            t.Equals(launcher::mergeEnvironment(none, {"A=1"}).size(), static_cast<size_t>(1), "an empty base is just ours");
            t.Equals(launcher::mergeEnvironment(base, {}).size(), static_cast<size_t>(2), "no knobs is just the base");
        });

        // Sprint 9 Goal 3 Task 7 (R156): the launcher stops handing the game its whole inherited environment.
        // A stale PS2X_GS_BACKEND=cpu, or a PS2X_SOCOM2_UDP_SHIFT=2 left over from a two-instance session,
        // must not reach a stranger's game; a developer who started the launcher with PS2X_DEV=1 keeps it all.
        tc.Run("mergeEnvironment: an inherited PS2X_* variable reaches the game only when the launcher is in developer mode (R156)", [](TestCase &t)
        {
            const char *base[] = {"PATH=/bin", "PS2X_GS_BACKEND=cpu", "ps2x_peek=0x100:4", "PS2X_GS_SCALE=4", "PS2XX=kept", nullptr};
            const std::vector<std::string> ours = {"PS2X_GS_SCALE=2"};
            auto has = [](const std::vector<std::string> &env, const char *kv)
            { return std::find(env.begin(), env.end(), std::string(kv)) != env.end(); };

            const std::vector<std::string> stranger = launcher::mergeEnvironment(base, ours, false);
            t.Equals(static_cast<int>(stranger.size()), 3, "PATH, the near-miss name, and ours");
            t.IsTrue(has(stranger, "PATH=/bin") && has(stranger, "PS2XX=kept") && has(stranger, "PS2X_GS_SCALE=2"), "what belongs there");
            t.IsFalse(has(stranger, "PS2X_GS_BACKEND=cpu"), "a forgotten probe does not reach the game");
            t.IsFalse(has(stranger, "ps2x_peek=0x100:4"), "Windows variable names are case-insensitive, so the filter is too");

            const std::vector<std::string> developer = launcher::mergeEnvironment(base, ours, true);
            t.Equals(static_cast<int>(developer.size()), 5, "everything inherited, ours winning by key as before");
            t.IsTrue(has(developer, "PS2X_GS_BACKEND=cpu") && has(developer, "PS2X_GS_SCALE=2") && !has(developer, "PS2X_GS_SCALE=4"), "as before");

            t.IsTrue(launcher::isKnobKey("PS2X_MC_DIR") && launcher::isKnobKey("ps2x_mc_dir"), "the prefix, either case");
            t.IsFalse(launcher::isKnobKey("PS2XX") || launcher::isKnobKey("PS2") || launcher::isKnobKey(""), "and nothing shorter or different");
        });


        // ---- Sprint 8 Goal 9: the redesigned launcher -----------------------------------------------------

        tc.Run("the scale factor: 1.0 at the design size, 2.0 at double, never below the minimum window's", [](TestCase &t)
        {
            auto close = [](float a, float b) { return std::fabs(a - b) < 0.0005f; };
            t.IsTrue(close(ui::scaleFor(1100, 700), 1.0f), "1100x700 is the design: everything is drawn 1:1");
            t.IsTrue(close(ui::scaleFor(2200, 1400), 2.0f), "twice the design is twice the scale");
            t.IsTrue(close(ui::scaleFor(1100, 1400), 1.0f), "the smaller axis decides: a tall window does not stretch");
            t.IsTrue(close(ui::scaleFor(2200, 700), 1.0f), "and neither does a wide one");
            const float minimum = ui::scaleFor(800, 520);
            t.IsTrue(close(minimum, 800.0f / 1100.0f), "the 800x520 minimum's own factor is width-bound");
            t.IsTrue(close(ui::scaleFor(640, 400), minimum), "smaller than the minimum draws the minimum, not a squashed window");
            t.IsTrue(close(ui::scaleFor(320, 200), minimum), "and however small the ask, the clamp holds");
        });

        tc.Run("the focus model: each direction lands where the layout says, and nothing is unreachable", [](TestCase &t)
        {
            const ui::Rect window{0.0f, 0.0f, 1100.0f, 700.0f};
            ui::LayoutInputs in;
            in.padChoices = 2;    // "first available" and one connected pad
            in.micChoices = 3;    // "None" and two capture devices
            in.customServer = true;
            const ui::FocusGraph g = ui::FocusGraph::build(window, in);

            // VIDEO: a row of cells, three rows down the page, and the rail to the left of all of them.
            t.Equals(g.move("rail.video", ui::Dir::Right), std::string("video.detail.0"), "the rail opens onto the page's first control");
            t.Equals(g.move("video.detail.0", ui::Dir::Right), std::string("video.detail.1"), "right walks the detail row");
            t.Equals(g.move("video.detail.1", ui::Dir::Left), std::string("video.detail.0"), "and left walks back");
            t.Equals(g.move("video.detail.0", ui::Dir::Left), std::string("rail.video"), "left off the first cell goes back to the rail");
            t.Equals(g.move("video.detail.0", ui::Dir::Down), std::string("video.filter.0"), "down from detail is the filter row under it");
            t.Equals(g.move("video.filter.0", ui::Dir::Down), std::string("video.window.0"), "and the window row under that");
            t.Equals(g.move("video.window.0", ui::Dir::Up), std::string("video.filter.0"), "up retraces it");
            t.Equals(g.move("video.window.3", ui::Dir::Down), std::string("video.fps"), "the overlay toggle is the last row");
            t.Equals(g.move("video.fps", ui::Dir::Down), std::string("bar.launch.video"), "and below the last row is the bar's LAUNCH");
            t.Equals(g.move("bar.launch.video", ui::Dir::Up), std::string("video.fps"), "which comes back up into the page");
            t.IsTrue(ui::barLaunchId(ui::Page::Play) != ui::barLaunchId(ui::Page::Video),
                     "the bar is on every page, so its node is named per page -- one id, one node, one rect");
            t.IsTrue(!hasNode(ui::layoutFor(ui::Page::Play, window, in), ui::barLaunchId(ui::Page::Play)),
                     "PLAY has its own large LAUNCH, so the bar shows the run's state there instead of a second button");
            t.IsTrue(hasNode(ui::layoutFor(ui::Page::Video, window, in), ui::barLaunchId(ui::Page::Video)),
                     "every other page keeps the bar's LAUNCH");

            // CONTROLLER, SETUP (the graph's default section): the section switch, a list on the left, one knob
            // on the right (Sprint 10 Q3, R210: the mouse-look toggle and its sensitivity slider left; the dead zone
            // is what remains). Sprint 10 Goal 8 moved the crouch row into BUTTONS -- its own case below.
            t.Equals(g.move("rail.controller", ui::Dir::Right), std::string("pad.section.0"), "the section switch is the first control");
            t.Equals(g.move("pad.section.0", ui::Dir::Down), std::string("pad.pick.0"), "under it, the pad list");
            t.Equals(g.move("pad.pick.0", ui::Dir::Down), std::string("pad.pick.1"), "down walks the pad list");
            t.Equals(g.move("pad.pick.0", ui::Dir::Right), std::string("pad.deadzone"), "right crosses to the knobs");
            t.Equals(g.move("pad.deadzone", ui::Dir::Left), std::string("pad.pick.0"), "and left crosses back to the list");
            t.Equals(g.move("pad.deadzone", ui::Dir::Down), std::string("bar.launch.controller"), "below the one knob is the bar's LAUNCH");
            t.IsFalse(ui::hasNode(ui::layoutFor(ui::Page::Controller, window, in), "pad.mouselook") ||
                          ui::hasNode(ui::layoutFor(ui::Page::Controller, window, in), "pad.sensitivity"),
                      "no mouse-look toggle and no sensitivity slider: the mouse left (Q3, R210)");
            t.IsFalse(ui::hasNode(ui::layoutFor(ui::Page::Controller, window, in), "pad.crouch.0"), "the crouch row is not in SETUP");
            t.IsTrue(!ui::adjustsHorizontally("pad.section.0") && !ui::adjustsHorizontally("pad.crouch.0"), "cells navigate; they are not a slider");
            t.IsTrue(ui::adjustsHorizontally("pad.deadzone") && ui::adjustsHorizontally("audio.volume") &&
                         !ui::adjustsHorizontally("pad.sensitivity") && !ui::adjustsHorizontally("pad.mouselook"),
                     "left/right ADJUSTS the two sliders rather than navigating away from them; the gone ids adjust nothing");

            // The rail itself walks up and down and stops at its ends.
            t.Equals(g.move("rail.play", ui::Dir::Down), std::string("rail.disc"), "the rail walks down");
            t.Equals(g.move("rail.disc", ui::Dir::Up), std::string("rail.play"), "and up");
            t.Equals(g.move("rail.play", ui::Dir::Up), std::string("rail.play"), "the top of the rail stays put");
            t.Equals(g.move("rail.about", ui::Dir::Down), std::string("rail.about"), "and so does the bottom");

            // Sprint 9 Goal 8: REPORT A BUG sits after ONLINE and before ABOUT, and is a column of the site's
            // own fields -- TITLE, WHAT HAPPENED, CONTACT (OPTIONAL), the log checkbox, SEND REPORT.
            t.Equals(ui::kPageCount, 9, "nine pages");
            t.Equals(std::string(ui::pageName(ui::Page::Report)), std::string("REPORT A BUG"), "the rail's label");
            t.Equals(ui::pageSlug(ui::Page::Report), std::string("report"), "the page's short name: screenshots and ids");
            t.Equals(ui::pageSlug(ui::Page::Play), std::string("play"), "as every other page's already was");
            t.Equals(g.move("rail.online", ui::Dir::Down), std::string("rail.report"), "below ONLINE");
            t.Equals(g.move("rail.report", ui::Dir::Down), std::string("rail.about"), "above ABOUT");
            t.Equals(g.move("rail.report", ui::Dir::Right), std::string("report.title"), "the rail opens onto TITLE");
            t.Equals(g.move("report.title", ui::Dir::Down), std::string("report.description"), "then WHAT HAPPENED");
            t.Equals(g.move("report.description", ui::Dir::Down), std::string("report.contact"), "then CONTACT");
            t.Equals(g.move("report.contact", ui::Dir::Down), std::string("report.attach"), "then the log checkbox");
            t.Equals(g.move("report.attach", ui::Dir::Down), std::string("report.send"), "then SEND REPORT");
            t.Equals(g.move("report.send", ui::Dir::Up), std::string("report.attach"), "and back up");
            t.Equals(g.move("report.send", ui::Dir::Down), std::string("bar.launch.report"), "the bar's LAUNCH is under it");
            t.Equals(g.move("report.title", ui::Dir::Left), std::string("rail.report"), "left goes back to the rail");
            t.IsTrue(!ui::adjustsHorizontally("report.description"), "a text field is not a slider");
            {
                const ui::Node *what = g.find("report.description");
                const ui::Node *title = g.find("report.title");
                t.IsTrue(what != nullptr && title != nullptr && what->r.h >= title->r.h * 2.5f,
                         "WHAT HAPPENED has room for several lines");
            }

            // Nothing is stranded: from its rail entry, every control on every page is reachable by moving.
            for (int i = 0; i < ui::kPageCount; ++i)
            {
                const ui::Page page = ui::pageAt(i);
                std::vector<std::string> seen = {ui::railId(page)};
                for (size_t head = 0; head < seen.size(); ++head)
                {
                    const ui::Dir dirs[4] = {ui::Dir::Up, ui::Dir::Down, ui::Dir::Left, ui::Dir::Right};
                    for (ui::Dir d : dirs)
                    {
                        const std::string to = g.move(seen[head], d);
                        if (std::find(seen.begin(), seen.end(), to) == seen.end())
                            seen.push_back(to);
                    }
                }
                for (const std::string &id : g.idsOn(page))
                    t.IsTrue(std::find(seen.begin(), seen.end(), id) != seen.end(),
                             std::string("reachable from the rail: ") + id);
            }

            // A page change keeps the rail in step, and Back returns to the page's own rail entry.
            ui::Nav nav;
            nav.goTo(g, ui::Page::Video);
            t.IsTrue(nav.page == ui::Page::Video, "goTo picks the page");
            t.Equals(nav.focus, std::string("video.detail.0"), "and focuses its first control");
            nav.back(g);
            t.Equals(nav.focus, std::string("rail.video"), "Back from a page returns focus to its rail entry");
            t.IsTrue(nav.page == ui::Page::Video, "without changing the page under it");
            nav.move(g, ui::Dir::Down);
            t.Equals(nav.focus, std::string("rail.audio"), "moving down the rail moves the rail selection");
            t.IsTrue(nav.page == ui::Page::Audio, "and the page follows it: the highlight and the pane never disagree");
            nav.move(g, ui::Dir::Right);
            t.Equals(nav.focus, std::string("audio.volume"), "right enters the page the rail landed on");

            // And every control is inside the window's bands at both sizes -- nothing hangs off the panel.
            const float minScale = ui::scaleFor(800, 520);
            const ui::Rect sizes[2] = {ui::Rect{0.0f, 0.0f, 1100.0f, 700.0f},
                                       ui::Rect{0.0f, 0.0f, ui::metrics::minW / minScale, ui::metrics::minH / minScale}};
            for (const ui::Rect &win : sizes)
            {
                const ui::Frame f = ui::frameFor(win);
                for (int i = 0; i < ui::kPageCount; ++i)
                    for (const ui::Node &n : ui::layoutFor(ui::pageAt(i), win, in))
                        t.IsTrue(n.r.inside(f.content) || n.r.inside(f.bar),
                                 std::string("inside the content pane or the bottom bar: ") + n.id);
            }
        });

        // Sprint 8, owner feedback: "the yellow circle ... takes too long to adjust and awkwardly flys with a
        // delay". There is no travel left to see: the ring is at the focused control's rect on the very frame
        // the focus changes, inside a page and across a page change alike, whatever the frame time was.
        tc.Run("the focus ring does not travel: it is on the focused control's rect the frame focus changes", [](TestCase &t)
        {
            const ui::Rect window{0.0f, 0.0f, 1100.0f, 700.0f};
            ui::LayoutInputs in;
            in.padChoices = 2;
            in.micChoices = 3;
            in.customServer = true;
            const ui::FocusGraph g = ui::FocusGraph::build(window, in);
            auto same = [](ui::Rect a, ui::Rect b)
            {
                return std::fabs(a.x - b.x) < 0.001f && std::fabs(a.y - b.y) < 0.001f &&
                       std::fabs(a.w - b.w) < 0.001f && std::fabs(a.h - b.h) < 0.001f;
            };
            const float tinyDt = 0.001f;   // one millisecond: a fast frame must not hold the ring back

            ui::Nav nav;
            nav.goTo(g, ui::Page::Video);
            ui::FocusRing ring;
            ring.update(g, nav.focus, tinyDt);
            t.IsTrue(ring.visible, "the ring is drawn wherever the focus is");
            t.IsTrue(same(ring.shown, g.find(nav.focus)->r), "the first frame is already on the focused control");

            // A move inside the page: one update, one millisecond, and the ring is there.
            nav.move(g, ui::Dir::Down);
            t.IsTrue(same(g.find(nav.focus)->r, ui::rectOf(ui::layoutFor(ui::Page::Video, window, in), nav.focus)),
                     "the rect the ring aims at is the rect the page draws");
            ring.update(g, nav.focus, tinyDt);
            t.IsTrue(same(ring.shown, g.find(nav.focus)->r),
                     "a move inside a page puts the ring on the new control at once, with no interpolation");

            // A page change: onto the new page's control, never a stale rect, never collapsed at the origin.
            const ui::Rect before = ring.shown;
            nav.goTo(g, ui::Page::Online);
            ring.update(g, nav.focus, tinyDt);
            t.IsTrue(same(ring.shown, g.find(nav.focus)->r),
                     "a page change puts the ring straight onto the new page's focused control");
            t.IsFalse(same(ring.shown, before), "not on the rect it held on the page before");
            t.IsTrue(ring.shown.w > 1.0f && ring.shown.h > 1.0f, "and never collapsed at 0,0 for a frame");

            // The rail is a page change too: back out of a page and the ring is on the rail entry immediately.
            nav.back(g);
            ring.update(g, nav.focus, tinyDt);
            t.IsTrue(same(ring.shown, g.find("rail.online")->r), "Back lands the ring on the rail entry the same frame");

            // Whatever the frame time was, the whole move happens: a zero-length frame moves it all the way.
            ui::FocusRing fresh;
            fresh.update(g, "rail.play", 0.0f);
            fresh.update(g, "play.launch", 0.0f);
            t.IsTrue(same(fresh.shown, g.find("play.launch")->r),
                     "a zero-length frame still moves the ring the whole way: nothing is eased");

            // And a focus id the graph does not know draws nothing, rather than a stale rect.
            ui::FocusRing unknown;
            unknown.update(g, "nothing.at.all", tinyDt);
            t.IsFalse(unknown.visible, "an id the graph does not know draws no ring at all");
        });

        tc.Run("the pad's outline: one symmetric closed path, every input on it, the sticks a mirrored pair", [](TestCase &t)
        {
            const ui::Rect bounds{100.0f, 50.0f, 540.0f, 262.0f};
            const ui::PadGeometry g = ui::padGeometry(bounds);

            t.IsTrue(g.outlineCount > 300, "the curve is flattened finely enough to read as a curve");
            t.IsTrue(g.hull.inside(bounds) && g.header.inside(bounds), "the silhouette and the shoulder strip stay inside what was asked for");
            t.IsTrue(g.header.bottom() <= g.hull.y + 0.001f, "the strip is above the pad, not on it");
            t.IsTrue(std::fabs(g.width / g.height - 1.55f) < 0.02f, "a DualShock is about 1.55:1");

            // Symmetric about the centre line, to within half a pixel.
            float worst = 0.0f;
            for (int i = 0; i < g.outlineCount; ++i)
            {
                const ui::Vec2 p = g.outline[i];
                const ui::Vec2 mirrored{2.0f * g.centre.x - p.x, p.y};
                float best = 1e9f;
                for (int j = 0; j < g.outlineCount; ++j)
                {
                    const float dx = g.outline[j].x - mirrored.x;
                    const float dy = g.outline[j].y - mirrored.y;
                    const float d = std::sqrt(dx * dx + dy * dy);
                    if (d < best)
                        best = d;
                }
                if (best > worst)
                    worst = best;
            }
            t.IsTrue(worst < 0.5f, "every point on the outline has its mirror image on the other half");

            // A simple polygon: no segment crosses another (adjacent ones share an endpoint).
            auto crosses = [](ui::Vec2 a, ui::Vec2 b, ui::Vec2 c, ui::Vec2 d)
            {
                auto side = [](ui::Vec2 p, ui::Vec2 q, ui::Vec2 r)
                {
                    const float v = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
                    return v > 1e-4f ? 1 : (v < -1e-4f ? -1 : 0);
                };
                return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
            };
            bool selfIntersects = false;
            for (int i = 0; i < g.outlineCount && !selfIntersects; ++i)
            {
                const ui::Vec2 a = g.outline[i];
                const ui::Vec2 b = g.outline[(i + 1) % g.outlineCount];
                for (int j = i + 2; j < g.outlineCount; ++j)
                {
                    if (i == 0 && j == g.outlineCount - 1)
                        continue;
                    if (crosses(a, b, g.outline[j], g.outline[(j + 1) % g.outlineCount]))
                    {
                        selfIntersects = true;
                        break;
                    }
                }
            }
            t.IsFalse(selfIntersects, "the outline is a simple closed path: it never crosses itself");

            // Every interactive element is ON the pad: its whole hit circle inside the polygon.
            auto circleInside = [&](const ui::PadCircle &c, const char *what)
            {
                bool ok = ui::padContains(g, c.c);
                for (int k = 0; k < 16 && ok; ++k)
                {
                    const float a = static_cast<float>(k) * 3.14159265f / 8.0f;
                    ok = ui::padContains(g, ui::Vec2{c.c.x + std::cos(a) * c.r, c.c.y + std::sin(a) * c.r});
                }
                t.IsTrue(ok, std::string("on the pad's outline: ") + what);
            };
            for (int i = 0; i < 4; ++i)
            {
                circleInside(g.dpad[i], "a d-pad segment");
                circleInside(g.face[i], "a face button");
            }
            for (int i = 0; i < 2; ++i)
            {
                circleInside(g.center[i], "select or start");
                circleInside(g.stickClick[i], "a stick cap");
                circleInside(ui::PadCircle{ui::PadElement::LeftStickClick, g.well[i], g.wellRadius}, "a whole stick well");
                t.IsTrue(g.shoulder[i].inside(g.header), "the shoulder bar is in the strip");
                t.IsTrue(g.trigger[i].inside(g.header), "and so is the trigger");
                t.IsTrue(g.trigger[i].bottom() <= g.shoulder[i].y + 0.001f, "the trigger is drawn above its shoulder");
            }
            t.IsTrue(ui::padContains(g, ui::Vec2{g.plate.x, g.plate.y}) && ui::padContains(g, ui::Vec2{g.plate.right(), g.plate.bottom()}),
                     "the centre plate is on the pad");
            t.IsFalse(ui::padContains(g, ui::Vec2{g.hull.x + 1.0f, g.hull.bottom() - 1.0f}),
                      "and the corner between a handle and the hull's box is NOT on the pad -- the outline is the shape, not the box");

            // The wells are where a DualShock has them, and the sticks are a mirrored pair.
            t.IsTrue(g.dpadWell.x < g.faceWell.x, "the d-pad well is left of the face well");
            t.IsTrue(std::fabs((g.centre.x - g.well[0].x) - (g.well[1].x - g.centre.x)) < 0.001f,
                     "the two sticks are symmetric about the pad's centre line");
            t.IsTrue(std::fabs(g.well[0].y - g.well[1].y) < 0.001f, "and level with each other");
            t.IsTrue(g.well[0].x > g.dpadWell.x && g.well[1].x < g.faceWell.x, "and inboard of the two wells");
            t.IsTrue(g.well[0].y > g.dpadWell.y && g.well[1].y > g.faceWell.y, "and below them");

            t.IsTrue(std::fabs(ui::deadZoneRingRadius(0.15f, 40.0f) - 6.0f) < 0.001f, "the ring is deadZone x the well's radius");
            t.IsTrue(std::fabs(ui::deadZoneRingRadius(0.0f, 40.0f)) < 0.001f, "no dead zone, no ring");

            auto close = [](float a, float b) { return std::fabs(a - b) < 0.001f; };
            const float well = 40.0f;
            ui::Vec2 off = ui::stickOffset(ui::Vec2{0.1f, 0.0f}, 0.2f, well);
            t.IsTrue(close(off.x, 0.0f) && close(off.y, 0.0f), "inside the dead zone the dot does not move at all");
            off = ui::stickOffset(ui::Vec2{0.6f, 0.0f}, 0.2f, well);
            t.IsTrue(close(off.x, 20.0f), "outside it the axis is rescaled over the travel that is left: (0.6-0.2)/0.8 = half");
            off = ui::stickOffset(ui::Vec2{-0.6f, 0.0f}, 0.2f, well);
            t.IsTrue(close(off.x, -20.0f), "and the sign is kept");
            off = ui::stickOffset(ui::Vec2{0.5f, 0.0f}, 0.0f, well);
            t.IsTrue(close(off.x, 20.0f), "with no dead zone it is simply the axis times the radius");
            off = ui::stickOffset(ui::Vec2{2.0f, 0.0f}, 0.0f, well);
            t.IsTrue(close(off.x, well), "and it never leaves the well, whatever the driver reports");
        });

        tc.Run("the theme's contrast: every text colour clears 4.5:1 on the surface it is drawn on", [](TestCase &t)
        {
            using namespace ui::theme;
            auto pair = [&t](ui::Rgba ink, ui::Rgba on, const char *what)
            {
                const float ratio = ui::contrastRatio(ink, on);
                t.IsTrue(ratio >= 4.5f, std::string(what) + " must clear 4.5:1");
            };
            t.IsTrue(std::fabs(ui::contrastRatio(ui::Rgba{0, 0, 0, 255}, ui::Rgba{255, 255, 255, 255}) - 21.0f) < 0.01f,
                     "black on white is 21:1 -- the ratio itself is right");
            t.IsTrue(std::fabs(ui::contrastRatio(panel, panel) - 1.0f) < 0.001f, "a colour on itself is 1:1");

            pair(text, ground, "body text on the ground");
            pair(text, panel, "body text on a panel");
            pair(text, panelHi, "body text on a raised panel");
            pair(caption, ground, "captions on the ground");
            pair(caption, panel, "captions on a panel");
            pair(caption, panelHi, "captions on a raised panel");
            pair(dim, ground, "secondary text on the ground");
            pair(dim, panel, "secondary text on a panel");
            pair(gold, panel, "the accent on a panel");
            pair(goldHi, panel, "the bright accent on a panel");
            pair(goldHi, panelHi, "the bright accent on a raised panel");
            pair(ground, gold, "dark ink on a gold button");
            pair(ground, goldHi, "dark ink on a hovered gold button");
            pair(lampGreen, panel, "the ready lamp on a panel");
            pair(badInk, panel, "an error on a panel");
            pair(text, blueDeep, "the LAUNCH label on the bottom of its gradient");
            pair(text, blueFill, "the LAUNCH label on the top of its gradient");
        });

        tc.Run("the custom title bar's hit test: the buttons, the drag region, the resize edges", [](TestCase &t)
        {
            const int w = 1100, h = 700;
            const ui::ChromeLayout l = ui::chromeLayout(1100.0f);
            auto at = [&](float x, float y, float scale = 1.0f, bool maximized = false)
            {
                return ui::chromeHitTest(static_cast<int>(x), static_cast<int>(y), static_cast<int>(w * scale),
                                         static_cast<int>(h * scale), scale, maximized);
            };

            t.IsTrue(at(l.close.cx(), l.close.cy()) == ui::ChromeHit::Close, "the close button");
            t.IsTrue(at(l.maximize.cx(), l.maximize.cy()) == ui::ChromeHit::Maximize, "the maximise button");
            t.IsTrue(at(l.minimize.cx(), l.minimize.cy()) == ui::ChromeHit::Minimize, "the minimise button");
            t.IsTrue(at(l.pill.cx(), l.pill.cy()) == ui::ChromeHit::UnsavedPill, "the unsaved pill");
            t.IsTrue(at(l.caption.cx(), l.caption.cy()) == ui::ChromeHit::Caption, "the drag region between the mark and the status");
            t.IsTrue(at(l.mark.cx(), l.mark.cy()) == ui::ChromeHit::Client, "the mark is not draggable");
            t.IsTrue(at(l.status.cx(), l.status.cy()) == ui::ChromeHit::Client, "and neither is the status block");
            t.IsTrue(at(l.caption.cx(), l.bar.bottom() + 40.0f) == ui::ChromeHit::Client, "below the bar is the page");

            // The same boxes at 1.5x: the bar scales with everything else.
            t.IsTrue(at(l.close.cx() * 1.5f, l.close.cy() * 1.5f, 1.5f) == ui::ChromeHit::Close, "the close button at 1.5x");
            t.IsTrue(at(l.minimize.cx() * 1.5f, l.minimize.cy() * 1.5f, 1.5f) == ui::ChromeHit::Minimize, "the minimise button at 1.5x");
            t.IsTrue(at(l.caption.cx() * 1.5f, l.caption.cy() * 1.5f, 1.5f) == ui::ChromeHit::Caption, "the drag region at 1.5x");
            t.IsTrue(at(l.close.cx(), l.close.cy(), 1.5f) != ui::ChromeHit::Close,
                     "and a 1x position is NOT the close button once the window is scaled");

            // The resize frame.
            t.IsTrue(at(1.0f, 300.0f) == ui::ChromeHit::Left, "the left edge resizes");
            t.IsTrue(at(w - 1.0f, 300.0f) == ui::ChromeHit::Right, "so does the right");
            t.IsTrue(at(400.0f, 1.0f) == ui::ChromeHit::Top, "so does the top, above the bar");
            t.IsTrue(at(400.0f, h - 1.0f) == ui::ChromeHit::Bottom, "and the bottom");
            t.IsTrue(at(1.0f, 1.0f) == ui::ChromeHit::TopLeft, "the corners are corners");
            t.IsTrue(at(w - 1.0f, 1.0f) == ui::ChromeHit::TopRight, "top right");
            t.IsTrue(at(1.0f, h - 1.0f) == ui::ChromeHit::BottomLeft, "bottom left");
            t.IsTrue(at(w - 1.0f, h - 1.0f) == ui::ChromeHit::BottomRight, "bottom right");
            t.IsTrue(at(400.0f, 8.0f) == ui::ChromeHit::Caption, "past the 6 px border the bar takes over");

            // A maximised window has no resize frame at all.
            t.IsTrue(at(1.0f, 300.0f, 1.0f, true) == ui::ChromeHit::Client, "maximised: no left edge");
            t.IsTrue(at(400.0f, 1.0f, 1.0f, true) == ui::ChromeHit::Caption, "maximised: the top row is still the drag region");
            t.IsTrue(at(w - 1.0f, h - 1.0f, 1.0f, true) == ui::ChromeHit::Client, "maximised: no corner");

            // The buttons win over the top resize border, except in its top two pixels.
            t.IsTrue(at(l.close.cx(), 4.0f) == ui::ChromeHit::Close, "the close button wins inside its box");
            t.IsTrue(at(l.close.cx(), 1.0f) == ui::ChromeHit::Top, "but the top two pixels still resize");
            t.IsTrue(at(l.minimize.cx(), 1.0f) == ui::ChromeHit::Top, "away from the corner, that is the top edge too");
            t.IsTrue(at(1099.0f, 1.0f) == ui::ChromeHit::TopRight, "and the very corner is the corner grab");
        });

        // Sprint 8, owner feedback: the READY label "sits too far right", and the PLAY tab is "in a weird
        // spot". Both are placed from widths measured with the real font, so the arithmetic is asserted here.
        tc.Run("the top bar: the tab group is centred in the free width, the state word one padding from the buttons", [](TestCase &t)
        {
            auto close = [](float a, float b, float tol) { return std::fabs(a - b) <= tol; };
            // What the bar's font actually draws, in design units: the mark's two words, "READY", "PLAY".
            const float markRight = 16.0f + 86.0f + 10.0f + 74.0f;
            const float statusW = 46.0f;
            const float tabW = 34.0f;

            const float widths[2] = {1100.0f, ui::metrics::minW / ui::scaleFor(800, 520)};
            for (float barW : widths)
            {
                const ui::ChromeLayout l = ui::chromeLayout(barW);
                ui::TopBarText m;
                m.markRight = markRight;
                m.statusW = statusW;
                m.tabW.push_back(tabW);
                const ui::TopBarPlaces p = ui::topBarPlaces(l, m);

                // The state word: right-aligned against the window buttons, one padding away, measured.
                t.IsTrue(close(p.status.right(), l.minimize.x - ui::chrome::pad, 0.001f),
                         "the state word's right edge is exactly one padding left of the caption buttons");
                t.IsTrue(close(p.status.w, statusW, 0.001f), "its box is the width the font measured, not a fixed guess");
                t.IsTrue(close(p.status.y, 0.0f, 0.001f) && close(p.status.h, ui::metrics::barH, 0.001f),
                         "and it is the full height of the bar, so the word sits on its centre line");
                t.IsTrue(close(p.lamp.y, l.bar.cy(), 0.001f), "the lamp is on the bar's centre line");
                t.IsTrue(close(p.lamp.x, p.status.x - ui::chrome::lampGap, 0.001f), "and one gap to the left of the word");

                // The tab group: centred in what is free between the mark and the state cluster.
                const float freeL = markRight + ui::chrome::pad;
                const float freeR = p.lamp.x - ui::chrome::lampR - ui::chrome::pad;
                t.IsTrue(p.tabsCentred, "there is room at this width, so the group is centred");
                t.IsTrue(close(p.tabs.cx(), std::clamp(l.bar.cx(), freeL + p.tabs.w * 0.5f, freeR - p.tabs.w * 0.5f), 1.0f),
                         "the tab group is on the BAR's middle (the window's), pushed aside only as far as the mark or the cluster requires");
                t.IsTrue(p.tabs.x >= freeL - 0.001f, "it never runs into the wordmark");
                t.IsTrue(p.tabs.right() <= freeR + 0.001f, "nor into the state cluster");
                t.IsTrue(close(p.tabs.w, tabW, 0.001f) && p.tab.size() == 1u, "one tab, its own measured width");
                t.IsTrue(close(p.tab[0].x, p.tabs.x, 0.001f) && close(p.tab[0].w, tabW, 0.001f),
                         "and the group is the tab itself when there is only one");
            }

            // With unsaved changes the pill is in the bar, so the state word clears it by the same padding
            // and the two never overlap.
            {
                const ui::ChromeLayout l = ui::chromeLayout(1100.0f);
                ui::TopBarText m;
                m.markRight = markRight;
                m.statusW = statusW;
                m.showPill = true;
                m.tabW.push_back(tabW);
                const ui::TopBarPlaces p = ui::topBarPlaces(l, m);
                t.IsTrue(close(p.status.right(), l.pill.x - ui::chrome::pad, 0.001f),
                         "the UNSAVED pill takes the slot by the buttons, and the state word clears it by one padding");
                t.IsTrue(p.status.right() <= l.pill.x + 0.001f, "the word and the pill never overlap");
                t.IsTrue(p.tabs.right() <= p.lamp.x - ui::chrome::lampR - ui::chrome::pad + 0.001f,
                         "and the tab group still clears the cluster that just grew");
            }

            // Several tabs: laid out in order, one gap apart, the group still centred.
            {
                const ui::ChromeLayout l = ui::chromeLayout(1100.0f);
                ui::TopBarText m;
                m.markRight = markRight;
                m.statusW = statusW;
                m.tabW = {34.0f, 30.0f, 40.0f};
                const ui::TopBarPlaces p = ui::topBarPlaces(l, m);
                t.IsTrue(p.tab.size() == 3u, "a tab box for every label");
                t.IsTrue(close(p.tabs.w, 34.0f + 30.0f + 40.0f + 2.0f * ui::chrome::tabGap, 0.001f),
                         "the group is the labels plus the gaps between them");
                t.IsTrue(close(p.tab[1].x, p.tab[0].right() + ui::chrome::tabGap, 0.001f), "the second follows the first");
                t.IsTrue(close(p.tab[2].x, p.tab[1].right() + ui::chrome::tabGap, 0.001f), "and the third the second");
                t.IsTrue(close(p.tabs.x, p.tab[0].x, 0.001f) && close(p.tabs.right(), p.tab[2].right(), 0.001f),
                         "the group's box is exactly what the tabs span");
                const float freeL = markRight + ui::chrome::pad;
                const float freeR = p.lamp.x - ui::chrome::lampR - ui::chrome::pad;
                t.IsTrue(close(p.tabs.cx(), std::clamp(l.bar.cx(), freeL + p.tabs.w * 0.5f, freeR - p.tabs.w * 0.5f), 1.0f), "and it is on the bar's middle unless the mark or the cluster pushes it");
            }

            // No room: the group falls back to sitting after the wordmark rather than sliding under it.
            {
                const ui::ChromeLayout l = ui::chromeLayout(1100.0f);
                ui::TopBarText m;
                m.markRight = markRight;
                m.statusW = statusW;
                m.tabW.push_back(900.0f);
                const ui::TopBarPlaces p = ui::topBarPlaces(l, m);
                t.IsFalse(p.tabsCentred, "a group too wide for the free width is not pretending to be centred");
                t.IsTrue(close(p.tabs.x, markRight + ui::chrome::pad, 0.001f),
                         "it is left-aligned one padding after the wordmark instead");
            }
        });

        // Sprint 9 P4 (owner, 2026-09-20): "changing between menus causes a weird graphical bug that's
        // visible for a moment somewhere around the top left of the page." The frame's node list is built
        // from the page that was current at the top of the frame (main.cpp:1010), and the page changes
        // AFTER that -- during input (main.cpp:1149-1173) or inside the draw itself, when a rail entry is
        // clicked (main.cpp:517). On that one frame the NEW page's controls are looked up in the OLD page's
        // list; rectOf answers Rect{}, the origin with no size; and textCenteredIn duly puts a label at
        // (0,0), which is the top left of the window, for exactly one frame. Two defences, both pure: the
        // frame draws from the page's own list, and a rect that is not drawable places no ink anywhere.
        tc.Run("a page change does not leave the frame drawing from the previous page's node list", [](TestCase &t)
        {
            const ui::Rect window{0.0f, 0.0f, 1100.0f, 700.0f};
            ui::LayoutInputs in;
            const std::vector<ui::Node> onPlay = ui::layoutFor(ui::Page::Play, window, in);

            // What the defect did: the bar asks for the NEW page's LAUNCH in the OLD page's list.
            t.IsFalse(ui::hasNode(onPlay, ui::barLaunchId(ui::Page::Online)),
                      "the PLAY page's list does not hold the ONLINE page's bar LAUNCH -- this is the lookup that failed");
            t.IsFalse(ui::drawable(ui::rectOf(onPlay, ui::barLaunchId(ui::Page::Online))),
                      "and what it answers is not a rect anything may draw from");

            // The fix: the frame's list is the list of the page the input left behind.
            const std::vector<ui::Node> forFrame = ui::nodesForFrame(onPlay, ui::Page::Online, window, in);
            t.IsTrue(!forFrame.empty(), "the frame has a list to draw from");
            bool allOnline = true;
            for (const ui::Node &n : forFrame)
                allOnline = allOnline && n.page == ui::Page::Online;
            t.IsTrue(allOnline, "every node in it belongs to the page being drawn");
            const ui::Rect launch = ui::rectOf(forFrame, ui::barLaunchId(ui::Page::Online));
            t.IsTrue(ui::drawable(launch), "the bar's LAUNCH is found, with a rect of its own");
            t.IsTrue(launch.x > 0.0f && launch.y > 0.0f, "and it is on the bar, not at the window's origin");

            // A frame whose page did not change gets the list it already had, unchanged: the rebuild costs
            // a page change, not every frame.
            const std::vector<ui::Node> same = ui::nodesForFrame(onPlay, ui::Page::Play, window, in);
            t.IsTrue(same.size() == onPlay.size() && !same.empty() && same.front().id == onPlay.front().id,
                     "a frame whose page did not change draws from the same list");
        });

        tc.Run("an unknown id answers a rect nothing may draw from, and the origin is not a rect", [](TestCase &t)
        {
            const ui::Rect window{0.0f, 0.0f, 1100.0f, 700.0f};
            ui::LayoutInputs in;
            const std::vector<ui::Node> nodes = ui::layoutFor(ui::Page::Online, window, in);

            t.IsFalse(ui::drawable(ui::Rect{}), "a default Rect -- the origin, zero by zero -- is not drawable");
            t.IsFalse(ui::drawable(ui::Rect{10.0f, 10.0f, 0.0f, 40.0f}), "nor is one with no width");
            t.IsFalse(ui::drawable(ui::Rect{10.0f, 10.0f, 40.0f, 0.0f}), "nor one with no height");
            t.IsFalse(ui::drawable(ui::Rect{10.0f, 10.0f, -40.0f, 40.0f}), "nor one turned inside out");
            t.IsTrue(ui::drawable(ui::Rect{10.0f, 10.0f, 40.0f, 40.0f}), "a real rect is");

            t.IsFalse(ui::drawable(ui::rectOf(nodes, "online.no.such.control")),
                      "an id the list does not hold answers a rect nothing may draw from");
            t.IsTrue(ui::drawable(ui::rectOf(nodes, "online.persona.new")), "an id it does hold answers a real one");
        });

        // Sprint 10 (owner, 2026-09-20): "text from a selected tab displays inline around the top left before
        // snapping to the right location. switching tabs is jarring visually." The same flash as P4's, from
        // the one path P4's two defences did not close: a page change INSIDE the draw. drawRail() and the
        // PLAY page's CHANGE rows called Nav::goTo when they were clicked, part-way through drawing a frame
        // whose node list was the old page's; nodesForFrame had already run, and text() takes a point, not
        // a rect, so a caption placed from an empty rect went to the origin with nothing to refuse it. The
        // fix is that a draw cannot change the page at all: it asks (Nav::request), and the next frame's
        // input phase applies the ask before the frame's list is built (Nav::applyRequest, main.cpp).
        tc.Run("a page change asked for during a draw lands in the next input phase, never in the draw", [](TestCase &t)
        {
            const ui::Rect window{0.0f, 0.0f, 1100.0f, 700.0f};
            ui::LayoutInputs in;
            const ui::FocusGraph g = ui::FocusGraph::build(window, in);
            ui::Nav nav;
            nav.goTo(g, ui::Page::Play);
            const std::string focusBefore = nav.focus;

            nav.request(ui::Page::Disc);   // what a rail click does now
            t.IsTrue(nav.page == ui::Page::Play, "the request changes nothing the draw can see: the page is still PLAY");
            t.IsTrue(nav.focus == focusBefore, "and the focus has not moved");
            t.IsTrue(nav.requested == ui::pageIndex(ui::Page::Disc), "it is recorded, for the input phase");

            t.IsTrue(nav.applyRequest(g), "the input phase finds a request and applies it");
            t.IsTrue(nav.page == ui::Page::Disc, "the page is DISC");
            t.IsTrue(nav.focus == "disc.path", "focused on its first control, as goTo would have");
            t.IsTrue(nav.requested < 0, "and the request is spent");
            t.IsFalse(nav.applyRequest(g), "a frame with no request applies nothing");
            t.IsTrue(nav.page == ui::Page::Disc && nav.focus == "disc.path", "and changes nothing");

            // The last request wins when two land in one draw (a click and a CHANGE row cannot both be hit
            // in one frame, but the rule should still be one and simple).
            nav.request(ui::Page::Online);
            nav.request(ui::Page::About);
            nav.applyRequest(g);
            t.IsTrue(nav.page == ui::Page::About, "two requests in one draw: the later one is the one applied");
        });

        // Sprint 10 (owner, 2026-09-20): "see how the alert overlays the disc area in disc section." P4's
        // help was a floating box under the focused control, and under DISC IMAGE is the verdict panel; four
        // of the six helps covered something. The help now lives in the content panel's title strip
        // (Frame::band, next to the page's name), which is the one place nothing a page lays out may enter.
        // This holds every page's layout out of the strip at both window sizes, so the help can never sit on
        // a control again, whatever page adds what row later.
        tc.Run("the title strip is clear of every control on every page, so the help there covers nothing", [](TestCase &t)
        {
            const float sizes[2][2] = {{1100.0f, 700.0f}, {800.0f / (800.0f / 1100.0f), 520.0f / (800.0f / 1100.0f)}};
            for (const auto &size : sizes)
            {
                const ui::Rect window{0.0f, 0.0f, size[0], size[1]};
                const ui::Frame f = ui::frameFor(window);
                t.IsTrue(ui::drawable(f.band), "the strip is a real rect");
                t.IsTrue(f.band.inside(f.content), "inside the content panel");
                t.IsTrue(f.body.y >= f.band.bottom() + 2.0f, "and the body starts below it, past the rule under it");
                t.IsTrue(std::fabs(f.band.h - ui::metrics::bandH) < 0.001f, "it is metrics::bandH tall");

                ui::LayoutInputs in;
                in.padChoices = 3;
                in.micChoices = 3;
                in.customServer = true;
                in.advancedOpen = true;
                for (int i = 0; i < ui::kPageCount; ++i)
                {
                    const ui::Page page = ui::pageAt(i);
                    for (const ui::Node &n : ui::layoutFor(page, window, in))
                    {
                        const bool clear = n.r.y >= f.band.bottom() || n.r.bottom() <= f.band.y ||
                                           n.r.x >= f.band.right() || n.r.right() <= f.band.x;
                        t.IsTrue(clear, ("no control enters the title strip: " + n.id).c_str());
                    }
                }
            }
        });

        // Sprint 9 P4, from the owner's screenshot: "the UNZIPPED part after SOCOM II is lower than the
        // SOCOM II text", and "the running text is not aligned with the yellow circle, it appears higher".
        // Both are the same mistake -- a word placed by its LINE BOX rather than by the ink a reader sees.
        // text()'s y is the top of the line box, so two different sizes drawn at the same y do NOT share a
        // baseline; and an all-caps word centred in a bar-height box sits high of centre, because the
        // font's ascent above the capitals and its descender space below it are not equal. The arithmetic
        // therefore lives with the bar's other measured placements, and this test asserts the very numbers
        // the bar draws, which is the spec's bar for this item ("asserted in the top-bar tests, not eyeballed").
        tc.Run("the top bar: UNZIPPED shares SOCOM II's baseline, and the state word's ink is centred on its lamp", [](TestCase &t)
        {
            auto close = [](float a, float b, float tol) { return std::fabs(a - b) <= tol; };
            const ui::ChromeLayout l = ui::chromeLayout(1100.0f);
            ui::TopBarText m;
            m.markRight = 16.0f + 86.0f + 10.0f + 74.0f;
            m.statusW = 46.0f;
            m.tabW.push_back(34.0f);
            // Deliberately asymmetric ink, and nothing here is zero or equal: a face whose capitals begin
            // 3.1 units below the line box's top and stand 10.4 tall at size 15, 2.7/9.0 at 13, 2.9/9.7 at
            // 14. An implementation that ignores the measurements cannot pass this by accident.
            m.markY = 10.0f;
            m.markCapTop = 3.1f;
            m.markCapH = 10.4f;
            m.markSubCapTop = 2.7f;
            m.markSubCapH = 9.0f;
            m.statusCapTop = 2.9f;
            m.statusCapH = 9.7f;
            const ui::TopBarPlaces p = ui::topBarPlaces(l, m);

            const float markBaseline = m.markY + m.markCapTop + m.markCapH;
            t.IsTrue(close(p.markSubY + m.markSubCapTop + m.markSubCapH, markBaseline, 0.001f),
                     "UNZIPPED is drawn at the y that puts its baseline on SOCOM II's");
            t.IsFalse(close(p.markSubY, m.markY, 0.001f),
                      "which is not the same y as SOCOM II's -- equal tops at two sizes is the defect the owner saw");

            t.IsTrue(close(p.statusY + m.statusCapTop + m.statusCapH * 0.5f, p.lamp.y, 0.001f),
                     "the state word's capitals are centred on the lamp's centre, not its line box on the bar's");
            t.IsTrue(p.statusY > 0.0f && p.statusY + m.statusCapTop + m.statusCapH < l.bar.h,
                     "and the word's ink is still inside the bar");
        });

        // Sprint 9 P4 (owner, 2026-09-20): "move 'Second instance on this machine (for testing)' into an
        // advanced section". There was no advanced anything in the launcher, so this makes one: a labelled
        // disclosure at the foot of a page, shut by default, holding the settings a stranger should not
        // meet on their first run. The rule that keeps a disclosure honest is that it never hides a setting
        // that is DOING something -- a section holding a non-default value opens itself and cannot be shut,
        // so nobody turns on a second instance, collapses the section and then wonders why two games start.
        tc.Run("ONLINE's ADVANCED section is shut by default, and the second instance lives inside it", [](TestCase &t)
        {
            const ui::Rect window{0.0f, 0.0f, 1100.0f, 700.0f};
            ui::LayoutInputs in;
            in.advancedOpen = false;

            const std::vector<ui::Node> shut = ui::layoutFor(ui::Page::Online, window, in);
            t.IsTrue(ui::hasNode(shut, "online.advanced"), "the disclosure itself is always there to be focused");
            t.IsFalse(ui::hasNode(shut, "online.second"),
                      "and while it is shut the second-instance toggle is not a control on the page at all");

            in.advancedOpen = true;
            const std::vector<ui::Node> open = ui::layoutFor(ui::Page::Online, window, in);
            t.IsTrue(ui::hasNode(open, "online.second"), "opened, the toggle is back");
            const ui::Rect disclosure = ui::rectOf(open, "online.advanced");
            const ui::Rect second = ui::rectOf(open, "online.second");
            t.IsTrue(ui::drawable(disclosure) && ui::drawable(second), "both are real rects");
            t.IsTrue(second.y > disclosure.y, "the toggle sits below the disclosure that reveals it");
            t.IsTrue(second.y > ui::rectOf(open, "online.persona.new").y,
                     "and the whole section is below the settings a stranger does need");

            // The focus order: ADVANCED is the last thing on the page before the bottom bar's LAUNCH, so
            // walking down the page never lands in it on the way to something ordinary.
            const ui::FocusGraph g = ui::FocusGraph::build(window, in);
            const std::vector<std::string> ids = g.idsOn(ui::Page::Online);
            t.IsTrue(!ids.empty(), "the page has controls");
            size_t advancedAt = ids.size(), profileAt = ids.size();
            for (size_t i = 0; i < ids.size(); ++i)
            {
                if (ids[i] == "online.advanced") advancedAt = i;
                if (ids[i] == "online.persona.new") profileAt = i;   // Sprint 16 L1b: the viewer's last row
            }
            t.IsTrue(advancedAt < ids.size() && profileAt < ids.size(), "both are in the graph");
            t.IsTrue(advancedAt > profileAt, "ADVANCED comes after the ordinary settings, not before them");
        });

        tc.Run("an ADVANCED section holding a non-default setting opens itself and cannot be shut", [](TestCase &t)
        {
            launcher::Config c;
            t.IsFalse(c.secondInstance, "a fresh config does not run a second instance");
            t.IsFalse(ui::advancedForced(c), "so nothing forces the section open");

            c.secondInstance = true;
            t.IsTrue(ui::advancedForced(c),
                     "a second instance switched on forces it open -- a disclosure must never hide a setting that is doing something");

            // And the layout agrees: forced open, the toggle is present whatever the player last chose.
            const ui::Rect window{0.0f, 0.0f, 1100.0f, 700.0f};
            ui::LayoutInputs in;
            in.advancedOpen = ui::advancedForced(c);   // the player's collapse does not get a vote here
            t.IsTrue(ui::hasNode(ui::layoutFor(ui::Page::Online, window, in), "online.second"),
                     "the toggle a player switched on is always on the page they switched it on");
        });

        // Sprint 16 L1b (#73, R295): the PERSONAS list replaces Sprint 10 Goal 9's PROFILE, PLAYER NAME and PASSWORD fields
        // in the same 142 units under the address: three visible rows at the presets' pitch, NEW PERSONA last, the masked
        // password beside the selected row, ADVANCED where it was -- still inside the body at the design size.
        tc.Run("the ONLINE page holds the PERSONAS rows and a masked password under the address, above ADVANCED, clear of each other", [](TestCase &t)
        {
            for (const ui::Rect window : {ui::Rect{0.0f, 0.0f, 1100.0f, 700.0f}, ui::Rect{0.0f, 0.0f, 800.0f, 520.0f}})
            {
                ui::LayoutInputs in;
                in.advancedOpen = true;
                in.customServer = true;   // the tallest form: the address field is on the page too
                in.personaRows = 2;       // two records, NEW PERSONA third: the three visible rows full
                in.personaSelected = 0;
                in.personaPasswordShown = true;
                const std::vector<ui::Node> nodes = ui::layoutFor(ui::Page::Online, window, in);
                for (const char *gone : {"online.profile", "online.name", "online.password"})
                    t.IsFalse(ui::hasNode(nodes, gone), std::string("the old field is gone: ") + gone);
                const ui::Rect address = ui::rectOf(nodes, "online.server");
                const ui::Rect row0 = ui::rectOf(nodes, "online.persona.0");
                const ui::Rect row1 = ui::rectOf(nodes, "online.persona.1");
                const ui::Rect fresh = ui::rectOf(nodes, "online.persona.new");
                const ui::Rect password = ui::rectOf(nodes, "online.persona.password");
                const ui::Rect advanced = ui::rectOf(nodes, "online.advanced");
                const ui::Rect second = ui::rectOf(nodes, "online.second");
                t.IsTrue(ui::drawable(row0) && ui::drawable(row1) && ui::drawable(fresh) && ui::drawable(password), "every row and the field are laid out");
                t.IsTrue(address.y == ui::onlineAddressRow(window).y, "ADDRESS sits on its own shared row");
                t.IsTrue(row0.y >= address.bottom() + 26.0f, "the rows start below the address with room for the PERSONAS heading");
                t.IsTrue(row1.y >= row0.bottom() && fresh.y >= row1.bottom(), "in reading order, NEW PERSONA last");
                t.IsTrue(advanced.y >= fresh.bottom() + 8.0f, "ADVANCED is below the three rows, 8 clear");
                t.IsTrue(password.y == row0.y && password.x >= row0.right(), "the password sits beside the selected row, which narrows for it");
                t.IsTrue(std::fabs(row1.right() - password.right()) < 0.01f, "an unselected row spans what the two share");
                t.IsTrue(second.y >= advanced.bottom(), "and the second-instance toggle below that");
                const ui::Frame f = ui::frameFor(window);
                if (window.w >= 1100.0f)   // the small window scrolls its body; the design size must not need to
                    t.IsTrue(second.bottom() + 40.0f <= f.body.bottom(), "with its caption still inside the body");
                const std::vector<std::string> ids = ui::FocusGraph::build(window, in).idsOn(ui::Page::Online);
                size_t addressAt = ids.size(), row0At = ids.size(), freshAt = ids.size(), advancedAt = ids.size();
                for (size_t i = 0; i < ids.size(); ++i)
                {
                    if (ids[i] == "online.server") addressAt = i;
                    if (ids[i] == "online.persona.0") row0At = i;
                    if (ids[i] == "online.persona.new") freshAt = i;
                    if (ids[i] == "online.advanced") advancedAt = i;
                }
                t.IsTrue(addressAt < row0At && row0At < freshAt && freshAt < advancedAt, "focus walks address, the rows, NEW PERSONA, ADVANCED");
            }
            t.IsFalse(ui::helpFor("online.persona.new").empty() || ui::helpFor("online.persona.password").empty(), "the new nodes have help");
            t.IsFalse(ui::helpFor("online.persona.0").empty(), "and so does a row, by its prefix");
            t.IsTrue(ui::helpFor("online.persona.password").find("config.json") != std::string::npos, "the password's says where it is kept");
        });

        tc.Run("the empty viewer: NEW PERSONA and its masked field, and none of the old three fields", [](TestCase &t)
        {
            const ui::Rect window{0.0f, 0.0f, 1100.0f, 700.0f};
            const ui::LayoutInputs in;   // no records: NEW PERSONA is the list and the selected row
            const std::vector<ui::Node> nodes = ui::layoutFor(ui::Page::Online, window, in);
            t.IsTrue(ui::hasNode(nodes, "online.persona.new"), "the NEW PERSONA row");
            t.IsTrue(ui::hasNode(nodes, "online.persona.password"), "and its password field");
            t.IsFalse(ui::hasNode(nodes, "online.persona.0"), "no record row");
            for (const char *gone : {"online.profile", "online.name", "online.password"})
                t.IsFalse(ui::hasNode(nodes, gone), std::string("no ") + gone);
            t.IsTrue(ui::rectOf(nodes, "online.persona.new").y == ui::onlinePersonaRow(window, 0, 0).y, "in the first slot");
        });

        tc.Run("readCards (k): four records -> three rows visible; a focus move onto the fourth scrolls by one and no other node moves", [](TestCase &t)
        {
            const ui::Rect window{0.0f, 0.0f, 1100.0f, 700.0f};
            ui::LayoutInputs in;
            in.customServer = true;
            in.personaRows = 4;
            in.personaSelected = 4;   // NEW PERSONA
            in.personaPasswordShown = true;
            const std::vector<ui::Node> top = ui::layoutFor(ui::Page::Online, window, in);
            int visible = 0;
            for (const ui::Node &n : top)
                if (n.id.rfind("online.persona.", 0) == 0 && n.id != "online.persona.password")
                    ++visible;
            t.Equals(visible, ui::kPersonaVisibleRows, "three rows of five");
            t.IsTrue(ui::hasNode(top, "online.persona.2") && !ui::hasNode(top, "online.persona.3"), "the fourth is below the fold");
            t.IsFalse(ui::hasNode(top, "online.persona.password"), "the selected row (NEW PERSONA) is not visible, nor its field");
            std::string to;
            int scroll = 0;
            t.IsTrue(ui::personaMove(in, "online.persona.2", ui::Dir::Down, to, scroll), "down from the last visible row is the list's own move");
            t.Equals(to, std::string("online.persona.3"), "onto the fourth");
            t.Equals(scroll, 1, "scrolled by one");
            in.personaScroll = scroll;
            const std::vector<ui::Node> down = ui::layoutFor(ui::Page::Online, window, in);
            t.IsTrue(ui::hasNode(down, "online.persona.3") && !ui::hasNode(down, "online.persona.0"), "the list moved inside itself");
            t.IsTrue(ui::rectOf(down, "online.persona.3").y == ui::rectOf(top, "online.persona.2").y, "the fourth takes the last slot");
            for (const ui::Node &n : top)
            {
                if (n.id.rfind("online.persona.", 0) == 0)
                    continue;
                const ui::Rect after = ui::rectOf(down, n.id);
                t.IsTrue(after.x == n.r.x && after.y == n.r.y && after.w == n.r.w && after.h == n.r.h, "no other node moves: " + n.id);
            }
            t.IsTrue(ui::personaMove(in, "online.persona.2", ui::Dir::Down, to, scroll) && to == "online.persona.3" && scroll == 1,
                     "a move to a row already showing keeps the scroll");
            scroll = 0;
            t.IsFalse(ui::personaMove(in, "online.persona.0", ui::Dir::Up, to, scroll), "up from the first row the layout takes over (ADDRESS)");
            scroll = 1;
            t.IsTrue(ui::personaMove(in, "online.persona.1", ui::Dir::Up, to, scroll) && to == "online.persona.0" && scroll == 0,
                     "up from the first visible row scrolls back");
            in.personaScroll = 2;
            scroll = 2;
            t.IsTrue(ui::personaMove(in, "online.persona.3", ui::Dir::Down, to, scroll) && to == "online.persona.new" && scroll == 2,
                     "NEW PERSONA is the last row");
            t.IsFalse(ui::personaMove(in, "online.persona.new", ui::Dir::Down, to, scroll), "and below it the layout takes over (ADVANCED)");
            t.Equals(ui::personaScrollToShow(4, 0, 5), 2, "showing the last row scrolls to its page");
            t.Equals(ui::personaScrollToShow(0, 2, 5), 0, "and the first back to the top");
        });

        tc.Run("readPersonas' scroll (RED first): a selected row at index 3 or later starts in view, its password field with it", [](TestCase &t)
        {
            const ui::Rect window{0.0f, 0.0f, 1100.0f, 700.0f};
            ui::LayoutInputs in;
            in.personaRows = 6;
            in.personaSelected = 4;
            in.personaPasswordShown = true;
            in.personaScroll = ui::personaScrollOnRead(in, 0);
            const std::vector<ui::Node> nodes = ui::layoutFor(ui::Page::Online, window, in);
            t.IsTrue(ui::hasNode(nodes, "online.persona.4"), "the selected row is visible");
            t.IsTrue(ui::hasNode(nodes, "online.persona.password"), "and the password it will send is on screen");
            if (ui::hasNode(nodes, "online.persona.password"))
                t.IsTrue(ui::rectOf(nodes, "online.persona.password").y == ui::rectOf(nodes, "online.persona.4").y, "beside it");
            t.Equals(ui::personaScrollOnRead(in, 3), 3, "a scroll already showing it is kept");
            in.personaSelected = 6;   // NEW PERSONA, last
            t.Equals(ui::personaScrollOnRead(in, 0), 4, "NEW PERSONA scrolls to the list's end");
            in.personaSelected = 0;
            t.Equals(ui::personaScrollOnRead(in, 4), 0, "the first row back to the top");
            in.personaRows = 1;
            in.personaSelected = 1;
            t.Equals(ui::personaScrollOnRead(in, 5), 0, "a list that shrank under the scroll is clamped");
        });

        tc.Run("the per-frame scroll (RED first): a selection that moves without a reread brings its row and password into view", [](TestCase &t)
        {
            const ui::Rect window{0.0f, 0.0f, 1100.0f, 700.0f};
            ui::LayoutInputs in;
            in.personaRows = 3;   // three records: NEW PERSONA is the fourth row, hidden at scroll 0
            in.personaSelected = 0;
            in.personaPasswordShown = false;
            in.personaScroll = ui::personaScrollPerFrame(in, 0, 0);
            t.Equals(in.personaScroll, 0, "the selection unchanged: the scroll is kept");
            in.personaSelected = 3;   // 'Second instance' toggled: no _b record, so NEW PERSONA is selected
            in.personaPasswordShown = true;
            in.personaScroll = ui::personaScrollPerFrame(in, 0, in.personaScroll);
            t.Equals(in.personaScroll, 1, "the moved selection scrolls into view");
            const std::vector<ui::Node> nodes = ui::layoutFor(ui::Page::Online, window, in);
            t.IsTrue(ui::hasNode(nodes, "online.persona.new"), "NEW PERSONA is visible");
            t.IsTrue(ui::hasNode(nodes, "online.persona.password"), "and the password it will send is on screen");
            if (ui::hasNode(nodes, "online.persona.password") && ui::hasNode(nodes, "online.persona.new"))
                t.IsTrue(ui::rectOf(nodes, "online.persona.password").y == ui::rectOf(nodes, "online.persona.new").y, "beside it");
            t.Equals(ui::personaScrollPerFrame(in, 3, 0), 0, "a list scrolled by hand, the selection unchanged, stays");
            in.personaSelected = 0;
            t.Equals(ui::personaScrollPerFrame(in, 3, 1), 0, "back to the first row: back to the top");
            in.personaRows = 1;
            t.Equals(ui::personaScrollPerFrame(in, 0, 5), 0, "clamped to a list that shrank");
        });

        tc.Run("the password field shows for NEW PERSONA and a record without a saved password on this server, never beside a hidden row", [](TestCase &t)
        {
            const ui::Rect window{0.0f, 0.0f, 1100.0f, 700.0f};
            ui::LayoutInputs in;
            in.personaRows = 2;
            in.personaSelected = 1;
            in.personaPasswordShown = false;   // the record says the card holds it
            const std::vector<ui::Node> held = ui::layoutFor(ui::Page::Online, window, in);
            t.IsFalse(ui::hasNode(held, "online.persona.password"), "no field when the card holds the password");
            t.IsTrue(std::fabs(ui::rectOf(held, "online.persona.1").w - ui::onlinePersonaRow(window, 1, 0).w) < 0.01f, "and the row spans the body");
            in.personaPasswordShown = true;
            const std::vector<ui::Node> typed = ui::layoutFor(ui::Page::Online, window, in);
            t.IsTrue(ui::hasNode(typed, "online.persona.password"), "the field for a record without one");
            t.IsTrue(ui::rectOf(typed, "online.persona.password").y == ui::rectOf(typed, "online.persona.1").y, "beside that row");
            t.IsTrue(ui::rectOf(typed, "online.persona.1").w < ui::onlinePersonaRow(window, 1, 0).w, "which narrows");
        });

        // Sprint 9 P4 (owner, 2026-09-20): "tooltips where the launcher is unclear, 'what is a profile?'
        // first". The help is DATA, keyed by the control's own id, so the test can hold it to two rules a
        // tooltip set always breaks eventually: help that explains nothing, and help attached to a control
        // that no longer exists.
        tc.Run("the launcher's help is keyed by control id, and every id it answers for is a real control", [](TestCase &t)
        {
            t.IsTrue(ui::helpFor("no.such.control").empty(), "an id with no help answers nothing, not a placeholder");
            t.IsTrue(ui::helpFor("").empty(), "and neither does an empty id");

            // The owner's first ask, by name: a profile is the card directory AND the persona. Sprint 16 L1b: the answer
            // moved with the fields it explained, to the PERSONAS list's NEW PERSONA row.
            const std::string profile = ui::helpFor("online.persona.new");
            t.IsFalse(profile.empty(), "'what is a profile?' is answered");
            t.IsTrue(profile.find("cards/") != std::string::npos, "it says where the profile puts the memory card");
            t.IsTrue(profile.find("persona") != std::string::npos, "and that it is the name the server sees");

            // Nothing drifts: every id with help is a control the focus graph actually holds. A renamed or
            // deleted control would otherwise leave help that can never be shown, and nobody would notice.
            const ui::Rect window{0.0f, 0.0f, 1100.0f, 700.0f};
            ui::LayoutInputs in;
            in.advancedOpen = true;   // the ADVANCED sections' controls count too
            const ui::FocusGraph g = ui::FocusGraph::build(window, in);
            in.padButtons = true;     // Sprint 10 Goal 8: and the CONTROLLER page's other section
            const ui::FocusGraph gButtons = ui::FocusGraph::build(window, in);
            const std::vector<std::string> helped = ui::helpedIds();
            t.IsTrue(helped.size() >= 3u, "there is a help set to check");
            for (const std::string &id : helped)
            {
                const bool real = g.find(id) != nullptr || gButtons.find(id) != nullptr;
                t.IsTrue(real, ("help is attached to a control that exists: " + id).c_str());
                t.IsFalse(ui::helpFor(id).empty(), ("and it is not empty: " + id).c_str());
                // A sentence, not a restatement of the label: short help that just repeats the control is
                // noise, and this is the cheapest bar that catches it.
                t.IsTrue(ui::helpFor(id).size() >= 25u, ("help says something: " + id).c_str());
            }
        });

        // Sprint 9 P6 / Goal 7 (R175): the project's server is reached BY NAME. The switch is safe because
        // the preset string never reaches the game -- `loadHosts()` resolves it to a uint32 and maps the
        // seven retail hostnames to that (socom2_hostnet.cpp:303-316) -- so no persona can be orphaned.
        // What the switch DOES introduce is a name that might not resolve, and `parseServerAddress`
        // answering 0 leaves the runtime pointing at 127.0.0.1 with only a stderr line. Hence a second
        // preset carrying the raw address, on offer, for exactly that case.
        tc.Run("the project's server is reached by name; the by-address preset is retired, and a config naming it heals", [](TestCase &t)
        {
            const launcher::ServerPreset *byName = launcher::findServerPreset("unzipped");
            t.IsTrue(byName != nullptr, "the default preset is still called 'unzipped' -- an old config must keep working");
            t.IsTrue(std::string(byName->address) == "socom.scotho.com", "and it now names the server instead of numbering it");
            t.IsTrue(launcher::presetAvailable(*byName), "it is playable");

            // Sprint 10 (owner, 2026-09-20): "just remove the by address line for now in online". Three presets,
            // and the fourth's id is on the retired list rather than simply unknown.
            t.IsTrue(launcher::kServerPresetCount == 3u, "three presets are offered");
            t.IsTrue(launcher::findServerPreset("unzipped-ip") == nullptr, "the by-address one is not among them");
            t.IsTrue(launcher::kRetiredPresetCount >= 1u && std::string(launcher::kRetiredPresets[0].id) == "unzipped-ip" &&
                         std::string(launcher::kRetiredPresets[0].now) == "unzipped",
                     "and it is retired to the project server, not dropped");

            // A config written before the switch names "unzipped" and must come back playing by name --
            // the id is the stable thing, not the address.
            launcher::Config old;
            launcher::fromJson("{\"serverPreset\": \"unzipped\", \"server\": \"3.143.65.100\"}", old);
            t.IsTrue(old.serverPreset == "unzipped", "an old config still selects it");
            t.IsTrue(launcher::effectiveServer(old) == "socom.scotho.com",
                     "and what reaches the game is the name, without the player touching anything");

            // A fresh install plays on the hosted server by name.
            launcher::Config fresh;
            t.IsTrue(fresh.serverPreset == "unzipped", "a fresh config picks the project's server");
            t.IsTrue(launcher::effectiveServer(fresh) == "socom.scotho.com", "by name");
        });

        // Nothing may assume how many presets there are: P6 added a fourth, the page and its layout both
        // used to count to three in a literal, and Sprint 10 took the fourth away again. The count is the
        // table's, whatever it is; this test only asks that the rows follow it.
        tc.Run("the ONLINE page lays out a row for every preset there is, not for a literal count", [](TestCase &t)
        {
            const size_t n = launcher::kServerPresetCount;
            t.IsTrue(n >= 2u, "there is more than one preset to lay out");

            const ui::Rect window{0.0f, 0.0f, 1100.0f, 700.0f};
            ui::LayoutInputs in;
            const std::vector<ui::Node> nodes = ui::layoutFor(ui::Page::Online, window, in);
            size_t rows = 0;
            for (size_t i = 0; i < n; ++i)
                if (ui::hasNode(nodes, "online.preset." + std::to_string(i)))
                    ++rows;
            size_t playable = 0;
            for (size_t i = 0; i < n; ++i)
                if (launcher::presetAvailable(launcher::kServerPresets[i]))
                    ++playable;
            t.IsTrue(rows == playable, "every playable preset has a focusable row, and the unplayable one has none");

            // The rows must not collide with the fields under them: the last row ends above the address.
            const ui::Rect last = ui::onlinePresetRow(window, static_cast<int>(n) - 1);
            const ui::Rect address = ui::rectOf(nodes, "online.server");
            t.IsTrue(ui::drawable(address), "the address field is there");
            t.IsTrue(last.bottom() <= address.y,
                     "the last preset row ends above the address field -- a fourth preset must not sit on top of it");
        });

        // Sprint 8 Goal 9, fourth pass: a preset whose address is still a placeholder must never reach the
        // game. The community server runs r0004, which this client cannot play yet.
        tc.Run("an unavailable server preset cannot be played, and a config that names one heals itself", [](TestCase &t)
        {
            const launcher::ServerPreset *community = launcher::findServerPreset("community");
            const launcher::ServerPreset *unzipped = launcher::findServerPreset("unzipped");
            const launcher::ServerPreset *custom = launcher::findServerPreset("custom");
            t.IsTrue(community != nullptr && unzipped != nullptr && custom != nullptr, "the three presets are there");
            t.IsFalse(launcher::presetAvailable(*community), "community is not playable: its address is still a placeholder");
            t.IsTrue(launcher::presetAvailable(*unzipped), "the project's own server is");
            t.IsTrue(launcher::presetAvailable(*custom), "and so is an address the player types");

            launcher::Config c;
            c.serverPreset = "community";
            c.server = "192.0.2.10";
            t.Equals(launcher::effectiveServer(c), std::string("socom.scotho.com"),
                     "a config still naming community plays on the project's server, not on a placeholder");
            const std::vector<std::string> env = launcher::environmentFor(c);
            for (const std::string &kv : env)
                t.IsTrue(kv.find("_TBC") == std::string::npos, "no placeholder ever reaches the game's environment");

            // Every preset id, including one that is not ours at all.
            for (const char *id : {"community", "unzipped", "custom", "nonsense"})
            {
                launcher::Config each;
                each.serverPreset = id;
                for (const std::string &kv : launcher::environmentFor(each))
                    t.IsTrue(kv.find("_TBC") == std::string::npos, std::string("no placeholder for preset ") + id);
            }

            launcher::Config loaded;
            t.IsTrue(launcher::fromJson("{\"serverPreset\": \"community\"}", loaded), "a saved community config parses");
            t.Equals(loaded.serverPreset, std::string("unzipped"),
                     "and is healed on load: the owner's saved choice moves to the server that exists");
            launcher::Config kept;
            t.IsTrue(launcher::fromJson("{\"serverPreset\": \"custom\", \"server\": \"192.0.2.10\"}", kept), "a custom config parses");
            t.Equals(kept.serverPreset, std::string("custom"), "and a playable preset is left alone");
            t.Equals(launcher::effectiveServer(kept), std::string("192.0.2.10"), "with the address the player typed");
        });

        // ---- Task 11 (Sprint 11 Goal D): the launcher's revision plumbing --------------------------------
        // The launcher has to say WHICH SOCOM II this is, in two places that have to agree: the disc it
        // verifies and the game code it starts. Both are tables with one row per revision, so the second
        // revision is a row rather than a branch -- the shape is the point, not today's single entry.
        tc.Run("the revision tables: one disc digest today, and every preset says which revision it needs", [](TestCase &t)
        {
            t.IsTrue(launcher::kDiscRevisionCount == 1u, "one disc revision is known today: the r0001 NTSC image");
            t.Equals(std::string(launcher::kDiscRevisions[0].sha256), std::string(launcher::kSocom2R0001ElfSha256),
                     "and it is the digest the disc check has always pinned");
            t.Equals(std::string(launcher::kDiscRevisions[0].revision), std::string("r0001"), "named r0001");
            t.Equals(launcher::discRevisionForDigest(launcher::kSocom2R0001ElfSha256), std::string("r0001"),
                     "the pinned digest resolves to its revision");
            t.IsTrue(launcher::discRevisionForDigest("0000000000000000000000000000000000000000000000000000000000000000").empty(),
                     "an unknown digest resolves to nothing at all -- the disc is refused exactly as before");
            t.IsTrue(launcher::discRevisionForDigest("").empty(), "and an empty digest is not a revision either");

            // Every preset, including one a later sprint adds: the field is always there to read, and
            // whatever it holds is either a revision the launcher knows or the empty "we do not know".
            for (const launcher::ServerPreset &p : launcher::kServerPresets)
            {
                t.IsTrue(p.requiresRevision != nullptr, std::string("preset ") + p.id + " carries the field");
                // Empty is a legitimate answer -- "unknown, say nothing". Anything else has to be a
                // revision the launcher knows, or the selector would compare against a name it cannot draw.
                t.IsTrue(p.requiresRevision[0] == '\0' || launcher::findGameRevision(p.requiresRevision) != nullptr,
                         std::string("preset ") + p.id + " names a revision the launcher knows, or none at all");
            }
            t.Equals(std::string(launcher::findServerPreset("community")->requiresRevision), std::string("r0004"),
                     "PSRewired runs r0004");
            t.Equals(std::string(launcher::findServerPreset("unzipped")->requiresRevision), std::string("r0001"),
                     "the project's own server runs the disc's own revision");
            // Custom is NOT r0001 (the brief said it was; the Sprint 11 review overruled that). A typed
            // address is any server on earth -- including PSRewired, which is precisely how a player will
            // reach r0004 before the community preset is enabled -- so the launcher cannot state its
            // revision and must not guess one.
            t.IsTrue(std::string(launcher::findServerPreset("custom")->requiresRevision).empty(),
                     "a custom address names no revision: the launcher does not know what it is");
        });

        // Issue #69: the launcher started socom2.exe + socom2_game.elf whatever GAME VERSION said, so
        // picking r0004 played r0001. startGame now asks the table which two files to spawn; the answer is
        // pure, so it is proved here on both platforms with no process started.
        tc.Run("startGame spawns the chosen GAME VERSION's own exe and ELF (issue #69)", [](TestCase &t)
        {
            const launcher::GameFiles r1 = launcher::gameFilesFor("r0001", "socom2.exe");
            t.Equals(r1.exe, std::string("socom2.exe"), "r0001 is this build: the platform's own exe");
            t.Equals(r1.elf, std::string("socom2_game.elf"), "and the disc's own ELF");
            const launcher::GameFiles r4 = launcher::gameFilesFor("r0004", "socom2.exe");
            t.Equals(r4.exe, std::string("socom2_r0004.exe"), "r0004 starts its own exe, not socom2.exe");
            t.Equals(r4.elf, std::string("socom2_game_r0004.elf"), "with its own ELF, the name build_revision.sh packages");
            const launcher::GameFiles empty = launcher::gameFilesFor("", "socom2");
            t.Equals(empty.exe, std::string("socom2"), "an empty revision is r0001, with the POSIX default exe");
            t.Equals(empty.elf, std::string("socom2_game.elf"), "and r0001's ELF");
            const launcher::GameFiles typo = launcher::gameFilesFor("r0O04", "socom2");
            t.Equals(typo.exe, std::string("socom2"), "a typo is r0001 too -- never a half-guessed r0004");
            t.Equals(typo.elf, std::string("socom2_game.elf"), "and r0001's ELF");
        });

        // Issue #69, the runtime half: the runner decided "this is SOCOM II" (the disc preflight) on the exact
        // name socom2_game.elf, so the launcher's r0004 pair started with no disc check. It asks the table now.
        tc.Run("the runtime knows every revision's ELF by name, in any case (issue #69)", [](TestCase &t)
        {
            const launcher::GameRevision *r1 = launcher::gameRevisionForElfName("socom2_game.elf");
            t.IsTrue(r1 != nullptr && std::string(r1->id) == "r0001", "socom2_game.elf is r0001's");
            const launcher::GameRevision *r4 = launcher::gameRevisionForElfName("SOCOM2_GAME_R0004.ELF");
            t.IsTrue(r4 != nullptr && std::string(r4->id) == "r0004", "SOCOM2_GAME_R0004.ELF is r0004's: the case is not the name");
            t.IsTrue(launcher::gameRevisionForElfName("socom2.elf") == nullptr, "a name in no row is no revision");
            t.IsTrue(launcher::gameRevisionForElfName("") == nullptr, "and neither is an empty one");
        });

        tc.Run("the GAME VERSION selector offers r0004 only when its build sits beside the launcher", [](TestCase &t)
        {
            t.IsTrue(launcher::kGameRevisionCount == 2u, "two game versions are named");
            t.Equals(std::string(launcher::kGameRevisions[0].id), std::string("r0001"), "the disc's own build is first");
            t.Equals(std::string(launcher::kGameRevisions[0].label), std::string("r0001 (your disc)"),
                     "and is labelled for a player who has never heard the word revision");
            t.Equals(std::string(launcher::kGameRevisions[1].id), std::string("r0004"), "the community update is second");
            t.Equals(std::string(launcher::kGameRevisions[1].label), std::string("r0004 (community update)"), "labelled the same way");
            t.IsTrue(std::string(launcher::kGameRevisions[0].exeName).empty(),
                     "r0001 is this launcher's own game: there is no second executable to look for");
            t.Equals(std::string(launcher::kGameRevisions[1].exeName), std::string("socom2_r0004.exe"),
                     "r0004 is one beside the launcher, in dist/");
            // Issue #69: every row names its ELF, and no two rows the same one -- two revisions sharing an
            // ELF is the defect that issue was, one level down.
            t.Equals(std::string(launcher::kGameRevisions[0].elfName), std::string("socom2_game.elf"), "r0001's ELF");
            t.Equals(std::string(launcher::kGameRevisions[1].elfName), std::string("socom2_game_r0004.elf"),
                     "r0004's ELF, the name build_revision.sh packages");
            for (size_t i = 0; i < launcher::kGameRevisionCount; ++i)
            {
                const std::string elf = launcher::kGameRevisions[i].elfName;
                t.IsFalse(elf.empty(), std::string("row ") + launcher::kGameRevisions[i].id + " names its ELF");
                for (size_t j = i + 1; j < launcher::kGameRevisionCount; ++j)
                    t.IsFalse(elf == launcher::kGameRevisions[j].elfName,
                              std::string("rows ") + launcher::kGameRevisions[i].id + " and " + launcher::kGameRevisions[j].id +
                                  " name different ELFs");
            }
            t.Equals(std::string(launcher::kRevisionMissingNote), std::string("needs the r0004 game update -- planned"),
                     "and the greyed cell says why, in the sentence the ONLINE page already used");

            // Availability is a pure question of a bool, not of the disk: the pages ask the world once and
            // hand the answer down, so a test drives both states with no file anywhere.
            t.IsTrue(launcher::gameRevisionAvailable(0, 0u),
                     "the disc's own build is playable with nothing else installed: it IS this launcher");
            t.IsFalse(launcher::gameRevisionAvailable(1, 0u),
                      "the community build is not, while its executable is missing");
            t.IsTrue(launcher::gameRevisionAvailable(1, 1u << 1), "and is, once its own executable is there");
            t.IsFalse(launcher::gameRevisionAvailable(launcher::kGameRevisionCount, ~0u),
                      "a row that is not in the table is never available, whatever is installed");

            // The mask, not a bool (Sprint 11 review, Important 1). This is the assertion the old
            // `bool present` could not make: plant the presence of a row this build does not have yet and
            // no OTHER row may claim it. With a single flag, every executable-bearing row went available
            // together -- a third revision would have been reported installed the moment r0004 was.
            const uint32_t onlyAThirdRow = 1u << 2;
            t.IsFalse(launcher::gameRevisionAvailable(1, onlyAThirdRow),
                      "another row's executable does not make r0004 installed");
            for (size_t i = 0; i < launcher::kGameRevisionCount; ++i)
            {
                if (launcher::kGameRevisions[i].exeName[0] == '\0')
                    continue;   // that row is this build; it needs no file and no bit
                t.IsTrue(launcher::gameRevisionAvailable(i, 1u << i),
                         std::string("row ") + launcher::kGameRevisions[i].id + " is available on its own bit");
                t.IsFalse(launcher::gameRevisionAvailable(i, ~(1u << i)),
                          std::string("row ") + launcher::kGameRevisions[i].id +
                              " is NOT available on every other bit -- each row is gated by its own file alone");
            }
            t.IsTrue(launcher::gameRevisionIndex("r0004") == 1u, "the id names its row");
            t.IsTrue(launcher::gameRevisionIndex("nope") == launcher::kGameRevisionCount, "and an id of no row says so");

            t.Equals(launcher::normalizeGameRevision("r0007"), std::string("r0001"), "an unknown revision plays the disc's own");
            t.Equals(launcher::normalizeGameRevision(""), std::string("r0001"), "and so does an empty one");
            t.Equals(launcher::Config{}.gameRevision, std::string("r0001"), "a fresh config plays the disc's own build");
            launcher::Config c;
            c.gameRevision = "r0004";
            launcher::Config back;
            t.IsTrue(launcher::fromJson(launcher::toJson(c), back), "the choice round-trips through config.json");
            t.Equals(back.gameRevision, std::string("r0004"), "... and comes back as it went in");
            launcher::Config older;
            t.IsTrue(launcher::fromJson("{\"gsScale\": 1}", older), "a config written before this task parses");
            t.Equals(older.gameRevision, std::string("r0001"), "and plays the disc's own build");

            // The layout: the r0004 cell is DRAWN either way -- greyed, with the note -- but it is only a
            // focusable control when the build it names exists. A cell a player cannot use must not be
            // reachable by the pad; that is how a launcher comes to offer a game it cannot start.
            for (const ui::Page page : {ui::Page::Play, ui::Page::Online})
            {
                const std::string slug = ui::pageSlug(page);
                for (const ui::Rect window : {ui::Rect{0.0f, 0.0f, 1100.0f, 700.0f}, ui::Rect{0.0f, 0.0f, 900.0f, 600.0f},
                                              ui::Rect{0.0f, 0.0f, 800.0f, 520.0f}})
                {
                    ui::LayoutInputs in;
                    in.gameRevisionsInstalled = 0u;
                    std::vector<ui::Node> nodes = ui::layoutFor(page, window, in);
                    t.IsTrue(ui::hasNode(nodes, slug + ".revision.0"), "the disc's own build is always on offer");
                    t.IsFalse(ui::hasNode(nodes, slug + ".revision.1"),
                              "the community build is not, with no executable for it");
                    t.IsTrue(ui::drawable(ui::revisionCell(window, page, 1)),
                             "but its cell is still drawn, greyed, so the player learns the version exists");
                    in.gameRevisionsInstalled = 1u << 1;
                    nodes = ui::layoutFor(page, window, in);
                    t.IsTrue(ui::hasNode(nodes, slug + ".revision.1"),
                             "with the executable beside the launcher the cell becomes a control");
                    const ui::Rect node = ui::rectOf(nodes, slug + ".revision.1");
                    const ui::Rect drawn = ui::revisionCell(window, page, 1);
                    t.IsTrue(std::fabs(node.x - drawn.x) < 0.01f && std::fabs(node.y - drawn.y) < 0.01f,
                             "at the very cell it was drawn in");
                    t.IsTrue(ui::revisionCell(window, page, 0).right() <= drawn.x,
                             "the two cells sit side by side, in the table's order");
                    const ui::Frame f = ui::frameFor(window);
                    if (window.w >= 1100.0f && window.h >= 700.0f)
                        t.IsTrue(drawn.inside(f.body), std::string("and the row is inside the body on ") + slug);
                    // Sprint 11 review, Minor 8: hold the re-tuned ONLINE rhythm -- the row belongs above
                    // the fields, not among them, whatever a later edit does to the pitch.
                    if (page == ui::Page::Online)
                        t.IsTrue(ui::revisionCell(window, page, 0).bottom() <= ui::onlineAddressRow(window).y,
                                 "the GAME VERSION row sits above ADDRESS in the same column");
                }
            }
        });

        // The two mismatch warnings. Neither can fire in today's shipped build -- the community preset is
        // not playable and there is no r0004 executable -- and both are what makes the pair safe to ship:
        // the moment either half arrives, a player who picks one without the other is told, in the launcher,
        // rather than by a login that fails with nothing on screen.
        tc.Run("the community server on the r0001 build says which revision that server runs", [](TestCase &t)
        {
            t.Equals(launcher::revisionWarning("community", "r0001"),
                     std::string("the community server runs r0004; this is the r0001 build"),
                     "the warning names both sides, in that order");
            t.IsTrue(launcher::revisionWarning("unzipped", "r0001").empty(),
                     "the project's own server runs r0001: there is nothing to warn about");
            t.IsTrue(launcher::revisionWarning("custom", "r0001").empty(), "and neither has an address the player typed");
            t.IsTrue(launcher::revisionWarning("nonsense", "r0001").empty(), "a preset that is not ours is not warned about");
            t.IsTrue(launcher::revisionWarning("community", "").empty(), "nor is a revision that is not ours");
            t.IsTrue(launcher::revisionWarning("", "").empty(), "nor nothing at all");
        });

        tc.Run("the r0004 build against a server that runs r0001 warns the other way", [](TestCase &t)
        {
            t.Equals(launcher::revisionWarning("unzipped", "r0004"),
                     std::string("the r0001 servers run r0001; this is the r0004 build"),
                     "the reverse warning, with the server named first exactly as the forward one is");
            t.IsTrue(launcher::revisionWarning("community", "r0004").empty(),
                     "the community server and the community build agree: no warning");

            // A preset whose required revision is empty is never warned about, on either build. Custom is
            // how a player reaches PSRewired before the community preset is enabled, so warning them that
            // "the r0001 servers run r0001" would be wrong about the one route that works.
            t.IsTrue(launcher::revisionWarning("custom", "r0004").empty(),
                     "a typed address on the r0004 build is not second-guessed");
            t.IsTrue(launcher::revisionWarning("custom", "r0001").empty(),
                     "nor on the r0001 build: the launcher does not know what that server runs");
            t.Equals(launcher::revisionWarning("unzipped", "r0004"),
                     std::string("the r0001 servers run r0001; this is the r0004 build"),
                     "while a server whose revision we DO know still warns");
            // Both sentences are in the table, once each: the pages read them, nothing retypes them.
            t.IsTrue(launcher::kRevisionWarningCount == 2u, "two mismatches are named");
            for (const launcher::RevisionMismatch &m : launcher::kRevisionWarnings)
            {
                t.IsTrue(launcher::findGameRevision(m.serverRevision) != nullptr, "each names a revision the launcher knows");
                t.IsTrue(launcher::findGameRevision(m.buildRevision) != nullptr, "on both sides");
                t.IsTrue(std::string(m.warning).find(m.serverRevision) != std::string::npos &&
                             std::string(m.warning).find(m.buildRevision) != std::string::npos,
                         "and the sentence names them both, so a player can tell which half they are missing");
            }
        });

        tc.Run("the ONLINE page does not offer the preset that cannot be played", [](TestCase &t)
        {
            const ui::Rect window{0.0f, 0.0f, 1100.0f, 700.0f};
            ui::LayoutInputs in;
            in.padChoices = 2;
            in.micChoices = 3;
            in.customServer = false;
            const std::vector<ui::Node> nodes = ui::layoutFor(ui::Page::Online, window, in);
            t.IsFalse(ui::hasNode(nodes, "online.preset.0"), "community has no focusable row: it cannot be chosen");
            t.IsTrue(ui::hasNode(nodes, "online.preset.1"), "the project's server has one");
            t.IsTrue(ui::hasNode(nodes, "online.preset.2"), "and so does Custom");
            // The row is still drawn, in its own place, so the page can say why it is unavailable.
            const ui::Rect disabled = ui::onlinePresetRow(window, 0);
            const ui::Rect enabled = ui::rectOf(nodes, "online.preset.1");
            t.IsTrue(disabled.y < enabled.y && std::fabs(disabled.x - enabled.x) < 0.001f,
                     "and it is drawn above the others, on the same grid");

            // Nothing on the page is stranded by the gap in the list.
            const ui::FocusGraph g = ui::FocusGraph::build(window, in);
            std::vector<std::string> seen = {ui::railId(ui::Page::Online)};
            for (size_t head = 0; head < seen.size(); ++head)
                for (ui::Dir d : {ui::Dir::Up, ui::Dir::Down, ui::Dir::Left, ui::Dir::Right})
                {
                    const std::string to = g.move(seen[head], d);
                    if (std::find(seen.begin(), seen.end(), to) == seen.end())
                        seen.push_back(to);
                }
            for (const std::string &id : g.idsOn(ui::Page::Online))
                t.IsTrue(std::find(seen.begin(), seen.end(), id) != seen.end(),
                         std::string("still reachable from the rail: ") + id);
        });

        tc.Run("the glyph family follows the pad's name: Xbox letters, PlayStation shapes, neither otherwise", [](TestCase &t)
        {
            t.IsTrue(ui::glyphFamilyFor("Xbox Wireless Controller") == ui::GlyphFamily::Xbox, "the owner's pad");
            t.IsTrue(ui::glyphFamilyFor("XINPUT CONTROLLER (Controller)") == ui::GlyphFamily::Xbox, "XInput, in any case");
            t.IsTrue(ui::glyphFamilyFor("X-Box 360 pad") == ui::GlyphFamily::Xbox, "the hyphenated spelling");
            t.IsTrue(ui::glyphFamilyFor("Microsoft SideWinder") == ui::GlyphFamily::Xbox, "and the maker's own name");
            t.IsTrue(ui::glyphFamilyFor("Sony DualShock 4") == ui::GlyphFamily::PlayStation, "DualShock");
            t.IsTrue(ui::glyphFamilyFor("DualSense Edge") == ui::GlyphFamily::PlayStation, "DualSense");
            t.IsTrue(ui::glyphFamilyFor("PLAYSTATION(R)3 Controller") == ui::GlyphFamily::PlayStation, "PlayStation, in any case");
            t.IsTrue(ui::glyphFamilyFor("PS4 Controller") == ui::GlyphFamily::PlayStation, "ps4");
            t.IsTrue(ui::glyphFamilyFor("ps5 controller") == ui::GlyphFamily::PlayStation, "ps5");
            t.IsTrue(ui::glyphFamilyFor("Wireless Controller") == ui::GlyphFamily::PlayStation,
                     "the bare name SDL reports for a DualShock 4 -- but only when it is the whole name");
            t.IsTrue(ui::glyphFamilyFor("8BitDo Pro 2") == ui::GlyphFamily::Generic, "anything else is generic");
            t.IsTrue(ui::glyphFamilyFor("") == ui::GlyphFamily::Generic, "and so is no pad at all");
        });

        tc.Run("why LAUNCH is disabled, in the player's words", [](TestCase &t)
        {
            t.Equals(ui::launchBlockedReason(false, false, true, ""), std::string("choose your SOCOM II disc image first"),
                     "no image chosen: the first thing to do, not an error about a file");
            t.Equals(ui::launchBlockedReason(true, true, false, ""), std::string("the game is running"), "one game at a time");
            t.Equals(ui::launchBlockedReason(false, true, true, ""), std::string("the game is running"),
                     "the running game comes first: it is the blocker the player just created");
            t.Equals(ui::launchBlockedReason(true, false, false, ui::kDiscCannotOpen), std::string(),
                     "verified and idle: nothing in the way");
        });

        // Sprint 13 V8 (stranger audit row 10): a path that does not exist was "cannot open the file" on DISC and
        // "that file is not SOCOM II (NTSC, r0001)" under LAUNCH -- a moved ISO reported as the wrong disc. One
        // state, one sentence: LAUNCH says what the DISC page says, for every state the disc check can end in.
        tc.Run("LAUNCH's blocked reason is the DISC page's sentence for the same state", [](TestCase &t)
        {
            t.Equals(ui::launchBlockedReason(false, false, false, ui::kDiscCannotOpen), std::string("cannot open the file"),
                     "a path that does not exist (or cannot be read) is a file that cannot be opened, not the wrong disc");
            for (const char *state : {ui::kDiscCannotOpen, ui::kDiscNoElf, ui::kDiscCannotReadElf, ui::kDiscWrongRevision})
                t.Equals(ui::launchBlockedReason(false, false, false, state), std::string(state),
                         std::string("LAUNCH repeats the DISC page: ") + state);
            t.Equals(ui::launchBlockedReason(false, false, false, ""), std::string(ui::kDiscNotChecked),
                     "a disc not checked yet is said as the DISC page says it");
            t.Equals(ui::launchBlockedReason(false, false, true, ui::kDiscNotChosen), std::string(ui::kDiscNotChosen),
                     "no image: the DISC page and LAUNCH share the sentence too");
        });


        // Sprint 9 Goal 9 (P3), the owner's defect, 2026-09-20: "When the game is active, both the game
        // and the launcher receive input commands from the controller." The launcher reads the pad through
        // raylib/GLFW, which reads it whether or not the window has focus -- so a stick push walked the
        // launcher's focus ring while the player was aiming with it. The gate is `ui::padIntent`: every pad
        // reading in the frame loop goes through it, and while the game runs it answers with nothing.
        tc.Run("the pad drives the launcher only while no game is running", [](TestCase &t)
        {
            ui::PadFrame pad;
            pad.present = true;
            pad.pressed[static_cast<int>(ui::PadNav::Right)] = true;

            double repeatAt = 0.0;
            const ui::PadIntent idle = ui::padIntent(pad, /*gameRunning=*/false, /*now=*/1.0, repeatAt);
            t.Equals(idle.dx, 1, "with no game running, a d-pad right is one step right");
            t.IsTrue(idle.prompts, "and a pad that moved the focus asks for the pad's prompts");

            double repeatAtRunning = 0.0;
            const ui::PadIntent running = ui::padIntent(pad, /*gameRunning=*/true, /*now=*/1.0, repeatAtRunning);
            t.Equals(running.dx, 0, "while the game runs the same press moves nothing");
            t.Equals(running.dy, 0, "and nothing vertically either");
            t.IsFalse(running.activate, "it does not activate");
            t.IsFalse(running.back, "it does not go back");
            t.IsFalse(running.launch, "and Start does not ask for a second launch");
            t.IsFalse(running.prompts, "a pad the launcher did not read cannot change the prompts");
        });

        // The same gate, for the half that is easy to get wrong: a HELD stick. The repeat clock must not
        // run while the game has the pad, or the frame the game exits would deliver the burst it banked.
        tc.Run("a stick held through a whole game session delivers nothing, and no burst when it ends", [](TestCase &t)
        {
            ui::PadFrame pad;
            pad.present = true;
            pad.leftX = -1.0f;   // hard left, well past the 0.55 threshold

            double repeatAt = 0.0;
            for (double now = 0.0; now < 5.0; now += 0.1)
            {
                const ui::PadIntent held = ui::padIntent(pad, /*gameRunning=*/true, now, repeatAt);
                t.Equals(held.dx, 0, "a stick held while the game runs never steps the launcher's focus");
            }
            t.Equals(repeatAt, 0.0, "and the repeat clock never started, so nothing is owed");

            const ui::PadIntent after = ui::padIntent(pad, /*gameRunning=*/false, /*now=*/5.0, repeatAt);
            t.Equals(after.dx, -1, "the frame the game ends, the still-held stick is one step, not a burst");
        });


        // ---- Sprint 10 Goal 8 (R174, part 2): the controller mapping UI --------------------------------------
        // The CONTROLLER page keeps the drawn pad and splits what is under it into two sections: SETUP (the pad
        // pick, the dead zone) and BUTTONS (the sixteen bindings, RESTORE DEFAULTS, and the crouch
        // shortcut -- which is a binding too, of a light Triangle, so it lives beside the others rather than as
        // a leftover under the knobs). The layout is pure, so what the tests assert on is what the player sees.
        tc.Run("CONTROLLER: SETUP and BUTTONS are two sections under the pad; the bindings, RESTORE and the crouch row live in BUTTONS", [](TestCase &t)
        {
            const ui::Rect window{0.0f, 0.0f, 1100.0f, 700.0f};
            ui::LayoutInputs in;
            in.padChoices = 2;
            in.padButtons = false;
            const std::vector<ui::Node> setup = ui::layoutFor(ui::Page::Controller, window, in);
            t.IsTrue(ui::hasNode(setup, "pad.section.0") && ui::hasNode(setup, "pad.section.1"), "the two section cells are always there");
            t.IsTrue(ui::hasNode(setup, "pad.pick.0") && ui::hasNode(setup, "pad.pick.1"), "SETUP: the pad list");
            t.IsTrue(ui::hasNode(setup, "pad.deadzone"), "SETUP: the dead zone");
            t.IsFalse(ui::hasNode(setup, "pad.mouselook") || ui::hasNode(setup, "pad.sensitivity"), "SETUP: no mouse controls (Q3, R210)");
            t.IsFalse(ui::hasNode(setup, "pad.bind.cross"), "SETUP has no binding cells");
            t.IsFalse(ui::hasNode(setup, "pad.restore"), "and no RESTORE");
            t.IsFalse(ui::hasNode(setup, "pad.crouch.0"), "and the crouch row moved out of it");

            in.padButtons = true;
            const std::vector<ui::Node> buttons = ui::layoutFor(ui::Page::Controller, window, in);
            for (int i = 0; i < ui::kBindCells; ++i)
                t.IsTrue(ui::hasNode(buttons, ui::bindCellId(i)), "BUTTONS: a cell per PS2 button: " + ui::bindCellId(i));
            t.IsTrue(ui::hasNode(buttons, "pad.restore"), "BUTTONS: RESTORE DEFAULTS");
            for (int i = 0; i < launcher::kCrouchShortcutCount; ++i)
                t.IsTrue(ui::hasNode(buttons, "pad.crouch." + std::to_string(i)), "BUTTONS: the crouch row");
            t.IsFalse(ui::hasNode(buttons, "pad.pick.0") || ui::hasNode(buttons, "pad.deadzone"), "and none of SETUP's controls");

            // Every PS2 button exactly once, and the cells named by the game's own words.
            bool seen[16] = {};
            for (int i = 0; i < ui::kBindCells; ++i)
            {
                const uint8_t b = ui::bindCellButton(i);
                t.IsTrue(b < 16 && !seen[b], "cell " + std::to_string(i) + " is a PS2 button not seen before");
                if (b < 16) seen[b] = true;
                t.Equals(ui::bindCellOf(ui::bindCellId(i)), i, "the id reads back to its cell");
            }
            t.Equals(ui::bindCellId(0), std::string("pad.bind.cross"), "the first cell is Cross, the button a player presses most");
            // The layout emits the cells in the flow's order (focus.cpp carries its own copy of the order, so a
            // drift between the two would put a cell's rect under another cell's name).
            std::vector<std::string> emitted;
            for (const ui::Node &n : buttons)
                if (n.id.rfind("pad.bind.", 0) == 0)
                    emitted.push_back(n.id);
            t.Equals(emitted.size(), static_cast<size_t>(ui::kBindCells), "sixteen cells emitted");
            for (size_t i = 0; i < emitted.size(); ++i)
                t.Equals(emitted[i], ui::bindCellId(static_cast<int>(i)), "cell " + std::to_string(i) + " is the flow's cell " + std::to_string(i));
            t.Equals(ui::bindCellOf("pad.bind.banana"), -1, "an id that is not a cell is -1");

            // Four across, four down, all under the section row, the crouch row last, the pad band above untouched.
            const ui::Rect section = ui::rectOf(buttons, "pad.section.1");
            const ui::Rect first = ui::rectOf(buttons, ui::bindCellId(0));
            const ui::Rect fourth = ui::rectOf(buttons, ui::bindCellId(3));
            const ui::Rect fifth = ui::rectOf(buttons, ui::bindCellId(4));
            const ui::Rect last = ui::rectOf(buttons, ui::bindCellId(15));
            const ui::Rect crouch = ui::rectOf(buttons, "pad.crouch.0");
            t.IsTrue(first.y >= section.bottom(), "the grid starts under the section row");
            t.IsTrue(std::fabs(fourth.y - first.y) < 0.001f && fourth.x > first.x, "cells 0-3 are one row");
            t.IsTrue(fifth.y > first.y && std::fabs(fifth.x - first.x) < 0.001f, "cell 4 starts the next row");
            t.IsTrue(crouch.y >= last.bottom(), "the crouch row is under the grid");
            const ui::Frame f = ui::frameFor(window);
            for (const ui::Node &n : buttons)
                t.IsTrue(n.r.inside(f.content) || n.r.inside(f.bar), "inside the panel: " + n.id);
            const float padBandBottom = ui::rectOf(setup, "pad.section.0").y;
            t.IsTrue(std::fabs(padBandBottom - section.y) < 0.001f, "the section row is at the same place in both sections, so the pad above never moves");

            // The focus walks it: from the section cell down into the grid, right along a row, down to the crouch row.
            const ui::FocusGraph g = ui::FocusGraph::build(window, in);
            t.Equals(g.move("rail.controller", ui::Dir::Right), std::string("pad.section.0"), "the rail opens onto the section switch");
            t.Equals(g.move("pad.section.0", ui::Dir::Right), std::string("pad.section.1"), "right is BUTTONS");
            // Sprint 10 Q4 put the window switch and its OFF on the row between BUTTONS and RESTORE.
            t.Equals(g.move("pad.section.1", ui::Dir::Right), std::string(ui::kSwitchCellId), "then the window switch (Q4)");
            t.Equals(g.move(ui::kSwitchCellId, ui::Dir::Right), std::string(ui::kSwitchOffId), "then its OFF");
            t.Equals(g.move(ui::kSwitchOffId, ui::Dir::Right), std::string("pad.restore"), "then RESTORE, at the row's right end");
            t.Equals(g.move("pad.section.0", ui::Dir::Down), ui::bindCellId(0), "down from the switch is the first cell");
            t.Equals(g.move(ui::bindCellId(0), ui::Dir::Right), ui::bindCellId(1), "right walks the row");
            t.Equals(g.move(ui::bindCellId(3), ui::Dir::Down), ui::bindCellId(7), "down is the cell under it");
            t.Equals(g.move(ui::bindCellId(12), ui::Dir::Down), std::string("pad.crouch.0"), "under the last row is the crouch row");
            t.Equals(g.move("pad.crouch.0", ui::Dir::Down), std::string("bar.launch.controller"), "and under that the bar's LAUNCH");
            t.Equals(g.move(ui::bindCellId(0), ui::Dir::Left), std::string("rail.controller"), "left off the first column is the rail");
            for (const std::string &id : g.idsOn(ui::Page::Controller))
                t.IsTrue(!ui::adjustsHorizontally(id) || id == "pad.deadzone", "cells navigate: " + id);
        });

        tc.Run("CONTROLLER: a dialog takes the BUTTONS section's controls out of the layout and puts its own in", [](TestCase &t)
        {
            const ui::Rect window{0.0f, 0.0f, 1100.0f, 700.0f};
            ui::LayoutInputs in;
            in.padButtons = true;
            in.padDialogButtons = 3;   // a conflict: SWAP, REPLACE, CANCEL
            const std::vector<ui::Node> nodes = ui::layoutFor(ui::Page::Controller, window, in);
            t.IsTrue(ui::hasNode(nodes, "pad.dialog.0") && ui::hasNode(nodes, "pad.dialog.1") && ui::hasNode(nodes, "pad.dialog.2"), "three dialog buttons");
            t.IsFalse(ui::hasNode(nodes, "pad.dialog.3"), "and not a fourth");
            t.IsFalse(ui::hasNode(nodes, "pad.bind.cross") || ui::hasNode(nodes, "pad.restore") || ui::hasNode(nodes, "pad.crouch.0"),
                      "nothing behind the dialog can be focused or activated");
            t.IsFalse(ui::hasNode(nodes, "pad.section.0"), "nor the section switch: the dialog is answered first");
            const ui::FocusGraph g = ui::FocusGraph::build(window, in);
            t.Equals(g.move("pad.dialog.0", ui::Dir::Right), std::string("pad.dialog.1"), "right walks the dialog's buttons");
            t.Equals(g.move("pad.dialog.1", ui::Dir::Right), std::string("pad.dialog.2"), "to the last");
            t.Equals(g.move("rail.controller", ui::Dir::Right), std::string("pad.dialog.0"), "the rail opens onto the dialog");
            const ui::Frame f = ui::frameFor(window);
            for (const ui::Node &n : nodes)
                t.IsTrue(n.r.inside(f.content) || n.r.inside(f.bar), "inside the panel: " + n.id);

            in.padDialogButtons = 2;   // the restore confirm: RESTORE, CANCEL
            const std::vector<ui::Node> two = ui::layoutFor(ui::Page::Controller, window, in);
            t.IsTrue(ui::hasNode(two, "pad.dialog.1") && !ui::hasNode(two, "pad.dialog.2"), "two buttons for the confirm");
            in.padButtons = false;
            in.padDialogButtons = 3;
            t.IsFalse(ui::hasNode(ui::layoutFor(ui::Page::Controller, window, in), "pad.dialog.0"), "a dialog belongs to BUTTONS; SETUP never shows one");
        });

        // The flow, driven a frame at a time with no window. Released, not pressed, so that B can mean both
        // "bind me" (a tap) and "cancel" (a hold).
        tc.Run("press-the-button-to-bind: a released button binds, B held cancels, a tap of B binds it, Escape cancels, the countdown runs out", [](TestCase &t)
        {
            using namespace launcher::mapping;
            ui::BindFlow flow;
            Mapping m = defaults();
            t.IsTrue(flow.state == ui::BindFlow::State::Idle, "idle to begin with");
            t.Equals(ui::bindCountdown(flow, 0.0), 0, "and no countdown");
            t.IsTrue(ui::bindStep(flow, m, ui::BindInput{kHostL3, 0.1, false}, 0.0) == ui::BindEvent::None, "a release while idle is nothing");
            t.IsTrue(m == defaults(), "and moves nothing");

            ui::bindStart(flow, kPs2Triangle, 10.0);
            t.IsTrue(flow.state == ui::BindFlow::State::Listening, "activating a cell listens");
            t.Equals(ui::bindCountdown(flow, 10.0), 5, "five seconds on the clock");
            t.Equals(ui::bindCountdown(flow, 12.2), 3, "counting down in whole seconds, rounded up");
            t.IsTrue(ui::bindStep(flow, m, ui::BindInput{}, 11.0) == ui::BindEvent::None, "a frame with nothing released keeps listening");
            t.IsTrue(flow.state == ui::BindFlow::State::Listening, "still listening");
            t.IsTrue(ui::bindStep(flow, m, ui::BindInput{kHostGuide, 0.1, false}, 12.0) == ui::BindEvent::Bound, "a free button released binds");
            t.IsTrue(flow.state == ui::BindFlow::State::Idle, "and the flow is idle again");
            t.Equals(m.pad[rowOf(kPs2Triangle)].host, kHostGuide, "Triangle is on the guide button");
            t.Equals(flow.lastHost, kHostGuide, "the drawing is told which control it landed on");
            t.IsTrue(flow.lastAt == 12.0, "and when");

            // The countdown runs out.
            m = defaults();
            ui::bindStart(flow, kPs2Triangle, 20.0);
            t.IsTrue(ui::bindStep(flow, m, ui::BindInput{}, 24.9) == ui::BindEvent::None, "still waiting at 4.9 s");
            t.IsTrue(ui::bindStep(flow, m, ui::BindInput{}, 25.0) == ui::BindEvent::TimedOut, "at five seconds it gives up");
            t.IsTrue(flow.state == ui::BindFlow::State::Idle && m == defaults(), "idle, nothing moved");

            // Escape.
            ui::bindStart(flow, kPs2Triangle, 30.0);
            t.IsTrue(ui::bindStep(flow, m, ui::BindInput{0, 0.0, true}, 30.5) == ui::BindEvent::Cancelled, "Escape cancels");
            t.IsTrue(flow.state == ui::BindFlow::State::Idle && m == defaults(), "idle, nothing moved");

            // B held cancels; B tapped binds B (and Circle, which had it, is the conflict -- see the next case).
            ui::bindStart(flow, kPs2Triangle, 40.0);
            t.IsTrue(ui::bindStep(flow, m, ui::BindInput{ui::kCancelHost, 0.6, false}, 41.0) == ui::BindEvent::Cancelled, "B held over half a second cancels");
            t.IsTrue(flow.state == ui::BindFlow::State::Idle && m == defaults(), "idle, nothing moved");
            ui::bindStart(flow, kPs2Triangle, 50.0);
            t.IsTrue(ui::bindStep(flow, m, ui::BindInput{ui::kCancelHost, 0.1, false}, 51.0) == ui::BindEvent::Conflict, "a tap of B is a bind of B -- which Circle already has");
            t.IsTrue(flow.state == ui::BindFlow::State::Conflict, "so the flow stops to ask");
            t.Equals(flow.takenBy, static_cast<int>(kPs2Circle), "and says who has it");
            ui::bindCancel(flow);

            // Binding the button it already has is a bind, not a conflict with itself.
            ui::bindStart(flow, kPs2Triangle, 60.0);
            t.IsTrue(ui::bindStep(flow, m, ui::BindInput{kHostFaceUp, 0.1, false}, 61.0) == ui::BindEvent::Bound, "the same button again binds");
            t.IsTrue(m == defaults(), "and changes nothing");

            // An unknown PS2 button cannot start a session.
            ui::bindStart(flow, 99, 70.0);
            t.IsTrue(flow.state == ui::BindFlow::State::Idle, "an id out of range starts nothing");
        });

        tc.Run("a conflict says what the button already does and offers swap, replace or cancel", [](TestCase &t)
        {
            using namespace launcher::mapping;
            ui::BindFlow flow;
            Mapping m = defaults();
            ui::bindStart(flow, kPs2Triangle, 0.0);
            t.IsTrue(ui::bindStep(flow, m, ui::BindInput{kHostL3, 0.1, false}, 1.0) == ui::BindEvent::Conflict, "the stick click is L3's");
            t.IsTrue(m == defaults(), "asking moved nothing");
            t.Equals(ui::dialogButtonCount(flow.state), 3, "three answers");
            t.Equals(std::string(ui::dialogButtonLabel(flow.state, 0)), std::string("SWAP"), "swap");
            t.Equals(std::string(ui::dialogButtonLabel(flow.state, 1)), std::string("REPLACE"), "replace");
            t.Equals(std::string(ui::dialogButtonLabel(flow.state, 2)), std::string("CANCEL"), "cancel");
            t.Equals(ui::dialogFocusId(flow.state), std::string("pad.dialog.0"), "the focus lands on SWAP, the likely intent");
            const std::string sentence = ui::dialogSentence(flow, ui::GlyphFamily::Xbox);
            t.IsTrue(sentence.find("LS CLICK") != std::string::npos, "the sentence names the pad's own button: " + sentence);
            t.IsTrue(sentence.find("L3") != std::string::npos, "and what the game already has it as");
            t.IsTrue(sentence.find("TRIANGLE") != std::string::npos, "and what is being bound");

            // Cancel: nothing moves.
            t.IsTrue(ui::bindResolve(flow, m, Resolution::Ask, 2.0) == ui::BindEvent::Cancelled, "cancel");
            t.IsTrue(flow.state == ui::BindFlow::State::Idle && m == defaults(), "idle, nothing moved");

            // Swap.
            ui::bindStart(flow, kPs2Triangle, 3.0);
            ui::bindStep(flow, m, ui::BindInput{kHostL3, 0.1, false}, 4.0);
            t.IsTrue(ui::bindResolve(flow, m, Resolution::Swap, 5.0) == ui::BindEvent::Bound, "swap binds");
            t.Equals(m.pad[rowOf(kPs2Triangle)].host, kHostL3, "Triangle is on the stick click");
            t.Equals(m.pad[rowOf(kPs2L3)].host, kHostFaceUp, "and L3 is on the top face button");
            t.Equals(flow.lastHost, kHostL3, "the drawing is told");

            // Replace.
            m = defaults();
            ui::bindStart(flow, kPs2Triangle, 6.0);
            ui::bindStep(flow, m, ui::BindInput{kHostL3, 0.1, false}, 7.0);
            t.IsTrue(ui::bindResolve(flow, m, Resolution::Replace, 8.0) == ui::BindEvent::Bound, "replace binds");
            t.Equals(m.pad[rowOf(kPs2Triangle)].host, kHostL3, "Triangle is on the stick click");
            t.Equals(m.pad[rowOf(kPs2L3)].host, kHostNone, "and L3 has no button");
            t.IsTrue(ui::bindResolve(flow, m, Resolution::Swap, 9.0) == ui::BindEvent::None, "resolving with no conflict open is nothing");
        });

        tc.Run("restore defaults is a two-step whose focus lands on CANCEL", [](TestCase &t)
        {
            using namespace launcher::mapping;
            ui::BindFlow flow;
            Mapping m = defaults();
            m.pad[rowOf(kPs2Triangle)].host = kHostGuide;
            ui::restoreAsk(flow);
            t.IsTrue(flow.state == ui::BindFlow::State::ConfirmRestore, "the first press asks");
            t.IsFalse(isDefault(m), "and moves nothing");
            t.Equals(ui::dialogButtonCount(flow.state), 2, "two answers");
            t.Equals(std::string(ui::dialogButtonLabel(flow.state, 0)), std::string("RESTORE"), "restore");
            t.Equals(std::string(ui::dialogButtonLabel(flow.state, 1)), std::string("CANCEL"), "cancel");
            t.Equals(ui::dialogFocusId(flow.state), std::string("pad.dialog.1"),
                     "the focus lands on CANCEL: a second press of the same button cannot wipe a layout");
            t.IsFalse(ui::dialogSentence(flow, ui::GlyphFamily::Xbox).empty(), "and it asks in words");
            ui::restoreAnswer(flow, m, false);
            t.IsTrue(flow.state == ui::BindFlow::State::Idle && !isDefault(m), "no: idle, the layout kept");
            ui::restoreAsk(flow);
            ui::restoreAnswer(flow, m, true);
            t.IsTrue(flow.state == ui::BindFlow::State::Idle && isDefault(m), "yes: idle, the defaults");
            t.Equals(ui::dialogFocusId(ui::BindFlow::State::Idle), std::string(), "no dialog, no focus to land");
            t.Equals(ui::dialogButtonCount(ui::BindFlow::State::Listening), 0, "listening is not a dialog");
        });

        tc.Run("the pad's own names for its buttons follow the glyph family, and the game's buttons have their words and shapes", [](TestCase &t)
        {
            using namespace launcher::mapping;
            auto textOf = [](ui::GlyphFamily f, int host) { return std::string(ui::hostLabel(f, host).text); };
            t.Equals(textOf(ui::GlyphFamily::Xbox, kHostFaceUp), std::string("Y"), "Xbox: Y on top");
            t.Equals(textOf(ui::GlyphFamily::Xbox, kHostFaceDown), std::string("A"), "A at the bottom");
            t.Equals(textOf(ui::GlyphFamily::Xbox, kHostL1), std::string("LB"), "LB");
            t.Equals(textOf(ui::GlyphFamily::Xbox, kHostR2), std::string("RT"), "RT");
            t.Equals(textOf(ui::GlyphFamily::Xbox, kHostSelect), std::string("VIEW"), "VIEW");
            t.Equals(textOf(ui::GlyphFamily::Xbox, kHostStart), std::string("MENU"), "MENU");
            t.Equals(textOf(ui::GlyphFamily::Xbox, kHostL3), std::string("LS CLICK"), "the stick click");
            t.Equals(ui::hostLabel(ui::GlyphFamily::Xbox, kHostFaceUp).face, -1, "an Xbox pad's face button is a letter, not a shape");
            t.Equals(ui::hostLabel(ui::GlyphFamily::PlayStation, kHostFaceUp).face, 0, "a PlayStation pad's top face button is the triangle, drawn");
            t.Equals(ui::hostLabel(ui::GlyphFamily::PlayStation, kHostFaceRight).face, 3, "and its right one the circle");
            t.Equals(textOf(ui::GlyphFamily::PlayStation, kHostL1), std::string("L1"), "PlayStation: L1");
            t.Equals(textOf(ui::GlyphFamily::PlayStation, kHostStart), std::string("OPTIONS"), "OPTIONS");
            t.Equals(textOf(ui::GlyphFamily::Generic, kHostFaceUp), std::string("1"), "a generic pad's buttons are numbered");
            t.Equals(textOf(ui::GlyphFamily::Generic, kHostSelect), std::string("SELECT"), "SELECT");
            t.Equals(textOf(ui::GlyphFamily::Xbox, kHostNone), std::string("NOT BOUND"), "an unbound row says so");
            for (int h = 1; h <= kHostButtonMax; ++h)
                for (ui::GlyphFamily f : {ui::GlyphFamily::Xbox, ui::GlyphFamily::PlayStation, ui::GlyphFamily::Generic})
                    t.IsTrue(std::strlen(ui::hostLabel(f, h).text) > 0, "every host button has a label in every family");

            t.Equals(ui::ps2Label(kPs2Triangle).face, 0, "Triangle is the shape");
            t.Equals(ui::ps2Label(kPs2Cross).face, 1, "Cross is the shape");
            t.Equals(ui::ps2Label(kPs2L1).face, -1, "L1 is a word");
            t.Equals(std::string(ui::ps2Label(kPs2L1).text), std::string("L1"), "L1");
            t.Equals(std::string(ui::ps2Label(kPs2Right).text), std::string("RIGHT"), "and libpad2's 5 is RIGHT, not DOWN");
            for (int b = 0; b < 16; ++b)
                t.IsTrue(std::strlen(ui::ps2Label(static_cast<uint8_t>(b)).text) > 0, "every PS2 button has a word");
        });

        // R139 on the same page: SOCOM II reads how HARD Triangle is pressed, a pad button is always firm, so the
        // Triangle cell's help says so and points at the crouch row under it -- which is where the light press is.
        tc.Run("the Triangle cell's help tells the analogue truth (R139), and the crouch cells' help states each trade", [](TestCase &t)
        {
            const std::string triangle = ui::helpFor("pad.bind.triangle");
            t.IsFalse(triangle.empty(), "the Triangle cell has help");
            t.IsTrue(triangle.find("hard") != std::string::npos || triangle.find("pressure") != std::string::npos, "it says the game reads pressure");
            t.IsTrue(triangle.find("crouch") != std::string::npos || triangle.find("CROUCH") != std::string::npos, "and where crouch lives");
            t.IsTrue(ui::helpFor("pad.bind.cross").empty(), "an ordinary cell explains itself");
            for (int i = 0; i < launcher::kCrouchShortcutCount; ++i)
                t.Equals(ui::helpFor("pad.crouch." + std::to_string(i)), std::string(launcher::crouchShortcutHint(launcher::kCrouchShortcuts[i])),
                         "a crouch cell's help is its trade, the line the caption used to carry");
            t.IsFalse(ui::helpFor("pad.restore").empty(), "RESTORE says what it restores");
        });

        // Issue #74 (owner, 2026-09-26): every control on the CONTROLLER page says what it does in one line -- the
        // hover box and the bottom bar's line are both tipFor's answer. Walked through the page's own focus list in
        // every shape it takes (SETUP with three pads, BUTTONS under each crouch value, each of the three dialogs),
        // so a control added to the layout without a line fails here.
        tc.Run("issue #74: every focusable control on the CONTROLLER page has a non-empty one-line tooltip", [](TestCase &t)
        {
            using namespace launcher::mapping;
            t.IsTrue(ui::tipTable(ui::Page::Controller).count > 0u, "the CONTROLLER page has its own table");
            size_t walked = 0;
            for (const TipSeen &seen : controllerTipWalk())
            {
                t.IsFalse(seen.line.empty(), ("the control has a line -- " + seen.where).c_str());
                t.IsTrue(seen.line.find('\n') == std::string::npos, ("and it is one line of text -- " + seen.where).c_str());
                ++walked;
            }
            t.IsTrue(walked > 100u, "the walk covered the page's controls");

            // The bar's own example: the crouch shortcut's cell says what the value means, not just its name.
            launcher::Config c;
            const ui::BindFlow idle;
            const ui::TipState state{&c, ui::GlyphFamily::Xbox, &idle};
            const std::string l3 = ui::tipFor(ui::Page::Controller, "pad.crouch.1", state);
            t.IsTrue(l3.rfind("L3:", 0) == 0 && l3.find("left stick") != std::string::npos && l3.find("crouch") != std::string::npos,
                     "the L3 crouch cell: 'L3: press the left stick to crouch ...'");
            // A binding cell names the pad button that drives it now, in the pad's own words.
            const std::string cross = ui::tipFor(ui::Page::Controller, "pad.bind.cross", state);
            t.IsTrue(cross.find(" A") != std::string::npos, "an Xbox pad's CROSS cell names A, the button that sends it");
            t.IsTrue(ui::tipFor(ui::Page::Controller, "no.such.control", state).empty(), "an id no page draws answers nothing");
        });

        // Issue #74, review round 1: the bar's "the same line in the footer" is the WHOLE line. The bottom bar's slot is
        // measured here in the launcher's own face (Rajdhani Medium, loaded at the pixel size the window draws it at,
        // measured as MeasureTextEx does) and every line the walk can produce must wrap into at most two lines of it --
        // at 1100x700, at the 800x520 minimum (type held at 13 real pixels, so larger there) and maximized at
        // 1920x1080. The hover box's single line must fit the window too.
        tc.Run("issue #74: every CONTROLLER tooltip is whole in the bottom bar's slot, measured in the launcher's face", [](TestCase &t)
        {
            const std::vector<TipSeen> walk = controllerTipWalk();
            struct Window
            {
                int w, h;
            };
            for (const Window win : {Window{1100, 700}, Window{800, 520}, Window{1920, 1080}})
            {
                const float scale = ui::scaleFor(win.w, win.h);
                const ui::Rect window{0.0f, 0.0f, static_cast<float>(win.w) / scale, static_cast<float>(win.h) / scale};
                const ui::Rect slot = ui::footerTipSlot(ui::frameFor(window));
                const std::string at = std::to_string(win.w) + "x" + std::to_string(win.h);
                t.IsTrue(slot.w >= 300.0f, "the slot is the gap the bar leaves: " + at + " gives " + std::to_string(slot.w));
                const auto pixelsFor = [scale](float size)
                {
                    const int wanted = static_cast<int>(std::lround(size * scale));
                    return std::max(wanted, ui::metrics::minTextPx);
                };
                const std::vector<int> footer = font_advances::rajdhaniMedium(pixelsFor(ui::kFooterTipSize));
                const std::vector<int> hover = font_advances::rajdhaniMedium(pixelsFor(ui::metrics::captionSize - 1.0f));
                t.Equals(footer.size(), static_cast<size_t>(95), "the embedded face loads (" + at + ")");
                if (footer.size() != 95u || hover.size() != 95u)
                    continue;
                t.IsTrue(std::all_of(footer.begin(), footer.end(), [](int a) { return a > 0; }),
                         "every glyph advances, so MeasureTextEx sums advances as widthOf does (" + at + ")");
                const auto width = [&footer, scale](const std::string &s)
                { return static_cast<float>(font_advances::widthOf(footer, s)) / scale; };
                for (const TipSeen &seen : walk)
                {
                    t.IsTrue(font_advances::widthOf(footer, seen.line) >= 0, "plain ASCII, which the face draws -- " + seen.where);
                    const std::vector<std::string> lines = ui::wrapWords(seen.line, slot.w, width);
                    t.IsTrue(lines.size() <= ui::kFooterTipLines,
                             at + ": at most " + std::to_string(ui::kFooterTipLines) + " lines in the bar, got " +
                                 std::to_string(lines.size()) + " -- " + seen.where + ": " + seen.line);
                    for (const std::string &l : lines)
                        t.IsTrue(width(l) <= slot.w, at + ": each line inside the slot -- " + seen.where + ": " + l);
                    const float boxText = static_cast<float>(font_advances::widthOf(hover, seen.line)) / scale;
                    t.IsTrue(boxText <= window.w - 56.0f, at + ": the hover box's line is whole in the window -- " + seen.where);
                }
            }
            // The walk reached the custom layouts: the widest names the bind and SWITCH lines can carry were measured.
            const auto said = [&walk](const std::string &part)
            { return std::any_of(walk.begin(), walk.end(), [&part](const TipSeen &s) { return s.line.find(part) != std::string::npos; }); };
            t.IsTrue(said("your pad's D-PAD RIGHT sends the game's TRIANGLE"), "a bind line naming D-PAD RIGHT was measured");
            t.IsTrue(said("SWITCH: your pad's RS CLICK swaps"), "a SWITCH line naming RS CLICK was measured");
            t.IsTrue(said("SWITCH: your pad's D-PAD RIGHT swaps"), "a SWITCH line naming D-PAD RIGHT was measured");
            // The bar's columns are the slot's: the prompts start kBarTipGap past its right edge and end
            // kBarPromptsW later, at LAUNCH (main.cpp's drawBar reads the same numbers).
            const ui::Frame f = ui::frameFor(ui::Rect{0.0f, 0.0f, 1100.0f, 700.0f});
            const ui::Rect slot = ui::footerTipSlot(f);
            t.IsTrue(std::fabs(slot.right() + ui::kBarTipGap + ui::kBarPromptsW - ui::barLaunchRect(f).x) < 0.001f,
                     "the slot ends where the prompts' column, which ends at LAUNCH, begins");

            // The wrap itself: greedy, word by word, trailing spaces dropped.
            const auto chars = [](const std::string &s) { return static_cast<float>(s.size()); };
            const std::vector<std::string> wrapped = ui::wrapWords("aa bb cc", 5.0f, chars);
            t.Equals(wrapped.size(), static_cast<size_t>(2), "'aa bb ' is 6 wide, over 5: the line breaks after 'aa '");
            t.Equals(wrapped.front(), std::string("aa"), "the first line, its trailing space dropped");
            t.Equals(wrapped.back(), std::string("bb cc"), "the rest");
        });

        // Issue #74, review round 1: a mouse left resting over a cell must not keep a box over the pad's focus ring.
        // The hover is armed by the mouse moving that frame, disarmed by keyboard or pad steering until it moves again.
        tc.Run("issue #74: keyboard or pad steering cancels the hover until the mouse moves again", [](TestCase &t)
        {
            ui::HoverTip tip;
            tip.frame(false, false, "pad.bind.cross", 1.0);
            t.IsFalse(tip.shows(5.0), "a mouse that never moved hovers nothing");
            tip.frame(true, false, "pad.bind.cross", 10.0);
            tip.frame(false, false, "pad.bind.cross", 10.6);
            t.IsTrue(tip.shows(10.6), "moved onto a cell and rested half a second: shown");
            tip.frame(false, true, "pad.bind.cross", 10.7);
            t.IsFalse(tip.shows(10.7), "the pad moved the focus: gone at once");
            tip.frame(false, false, "pad.bind.cross", 12.0);
            t.IsFalse(tip.shows(12.0), "and it stays gone while the mouse rests there");
            tip.frame(true, false, "pad.bind.cross", 13.0);
            t.IsFalse(tip.shows(13.2), "the mouse moves again: the half-second starts over");
            t.IsTrue(tip.shows(13.5), "then it shows");
            tip.frame(true, true, "pad.bind.cross", 14.0);
            t.IsTrue(tip.shows(14.0), "a frame where the mouse moved counts as the mouse's");
        });

        // Issue #74, review round 2: a two-line tip gives the slot back to the status each time a status is SAID (App's
        // statusSerial, bumped by setStatus -- test_launcher_wording.py holds every assignment to it), not each time
        // the string changes, and the status keeps it until the focus next moves, with no clock. The reviewer's
        // case: LAUNCH fails, the player presses LAUNCH again, and the same error must show again (R238).
        tc.Run("issue #74: a status said again shows again, and holds the footer until the focus moves", [](TestCase &t)
        {
            ui::StatusWatch watch;
            watch.update(0u, "bar.launch.controller");
            t.IsFalse(watch.fresh(), "nothing said yet: the tip has the slot");
            watch.update(1u, "bar.launch.controller");   // LAUNCH pressed; startGame failed
            t.IsTrue(watch.fresh(), "the failure shows");
            for (int frame = 0; frame < 600; ++frame)
                watch.update(1u, "bar.launch.controller");
            t.IsTrue(watch.fresh(), "and holds with no clock while the focus rests (the player was in the game window)");
            watch.update(1u, "pad.bind.cross");
            t.IsFalse(watch.fresh(), "the focus moves: the tip takes the slot back");
            watch.update(1u, "bar.launch.controller");
            t.IsFalse(watch.fresh(), "and moving back does not resurrect an old status");
            watch.update(2u, "bar.launch.controller");   // pressed again: the SAME error string, said again
            t.IsTrue(watch.fresh(), "the same sentence said a second time shows again");
            watch.update(3u, "pad.bind.triangle");
            t.IsTrue(watch.fresh(), "a status said in the frame the focus moves (a bind landing) shows");
            watch.update(3u, "pad.bind.cross");
            t.IsFalse(watch.fresh(), "until the next move");
        });

        // Issue #74: the hover half. About half a second resting on one control; the clock restarts on every change.
        tc.Run("issue #74: the hover tip waits half a second on one control, and its box stays inside the window", [](TestCase &t)
        {
            ui::HoverTip tip;
            tip.update("pad.restore", 10.0);
            t.IsFalse(tip.shows(10.2), "not yet at 0.2 s");
            t.IsTrue(tip.shows(10.0 + ui::kTipDelaySeconds), "shown at the delay");
            tip.update("pad.restore", 11.0);
            t.IsTrue(tip.shows(11.0), "resting on the same control keeps it shown");
            tip.update("pad.section.0", 11.1);
            t.IsFalse(tip.shows(11.3), "a new control starts the clock again");
            tip.update("", 12.0);
            t.IsFalse(tip.shows(20.0), "over nothing, nothing is shown");

            const ui::Rect window{0.0f, 0.0f, 1100.0f, 700.0f};
            ui::LayoutInputs in;
            in.padButtons = true;
            const std::vector<ui::Node> nodes = ui::layoutFor(ui::Page::Controller, window, in);
            const ui::Rect restore = ui::rectOf(nodes, "pad.restore");
            t.Equals(ui::nodeAt(nodes, ui::Vec2{restore.cx(), restore.cy()}), std::string("pad.restore"), "the node under the mouse");
            t.Equals(ui::nodeAt(nodes, ui::Vec2{-5.0f, -5.0f}), std::string(), "and none off every control");
            // RESTORE is at the body's right edge: a wide box slides left to stay in the window.
            const ui::Rect box = ui::tipBox(restore, 600.0f, 26.0f, window);
            t.IsTrue(box.x >= 0.0f && box.right() <= window.right() && box.y >= restore.bottom(), "under the control, inside the window");
            const ui::Rect low{100.0f, 680.0f, 100.0f, 18.0f};
            t.IsTrue(ui::tipBox(low, 200.0f, 26.0f, window).bottom() <= low.y, "no room below: above the control");
        });

        // The drawing: every host button has a place on the pad the callouts hang off, inside the pad's bounds.
        tc.Run("every host button has an anchor on the drawn pad", [](TestCase &t)
        {
            using namespace launcher::mapping;
            const ui::Rect bounds{100.0f, 50.0f, 560.0f, 262.0f};
            const ui::PadGeometry g = ui::padGeometry(bounds);
            for (int h = 1; h <= kHostButtonMax; ++h)
            {
                const ui::PadAnchor a = ui::padAnchor(g, h);
                t.IsTrue(a.valid, "host " + std::to_string(h) + " has an anchor");
                t.IsTrue(a.r > 0.0f, "with a radius");
                t.IsTrue(bounds.contains(a.c), "inside the pad's bounds");
            }
            t.IsFalse(ui::padAnchor(g, kHostNone).valid, "none has no place");
            t.IsTrue(ui::padAnchor(g, ui::kPadAnchorTouchpad).valid, "the touchpad's place is the centre plate");
            const ui::PadAnchor up = ui::padAnchor(g, kHostDpadUp);
            const ui::PadAnchor down = ui::padAnchor(g, kHostDpadDown);
            t.IsTrue(up.c.y < down.c.y && std::fabs(up.c.x - down.c.x) < 0.001f, "d-pad up is above d-pad down");
            const ui::PadAnchor l1 = ui::padAnchor(g, kHostL1);
            const ui::PadAnchor r1 = ui::padAnchor(g, kHostR1);
            t.IsTrue(l1.c.x < g.centre.x && r1.c.x > g.centre.x, "L1 is on the left, R1 on the right");
            t.IsTrue(l1.c.y < up.c.y, "and the shoulders are above the d-pad");

            // W9: the hold gesture draws a ring closing on the control being held, so every button the
            // gesture ARMS must have somewhere on the drawing for that ring to go. (It is the same table,
            // which is the point -- the gesture invented no second one.)
            for (int h = 1; h <= kHostButtonMax; ++h)
                if (ui::holdArms(h))
                    t.IsTrue(ui::padAnchor(g, h).valid, "an armed host has a ring to draw: " + std::to_string(h));
        });

        // ---- W9 (owner, 2026-09-22): hold a pad button to remap it -------------------------------------------
        // "The controller page is a good improvement, but let's try to improve the graphic just a bit if
        // possible. I'd also like to add a new remapping mechanism, hold the button to remap the button while
        // on the controller page." The gesture lives behind the SAME gate as every other pad reading
        // (ui::padHold, beside ui::padIntent in pad_input.cpp) so that a page never reaches for raylib and a
        // button held through a firefight can never arm anything in the launcher.
        tc.Run("hold-to-remap: the buttons the UI navigates with are never armed, and a hold fires once at 750 ms", [](TestCase &t)
        {
            using namespace launcher::mapping;
            // The five the launcher's own navigation spends on the PRESS edge. Cross and circle are the
            // crux: cross activates and circle goes back, so a gesture that stole either would make the page
            // it is meant to improve unusable -- and circle is also the bind flow's own cancel (kCancelHost
            // held past kCancelHoldSeconds), so a hold of it would collide with the way OUT of a session.
            t.IsFalse(ui::holdArms(kHostFaceDown), "cross activates: the gesture never takes it");
            t.IsFalse(ui::holdArms(kHostFaceRight), "circle goes back, and is the flow's own hold-to-cancel");
            t.IsFalse(ui::holdArms(kHostL1), "L1 has already changed the page before a hold could build");
            t.IsFalse(ui::holdArms(kHostR1), "and so has R1");
            t.IsFalse(ui::holdArms(kHostStart), "Start has already asked for a launch");
            t.IsFalse(ui::holdArms(kHostNone), "there is no button 0");
            t.IsFalse(ui::holdArms(kHostButtonMax + 1), "nor one past the last");
            int armed = 0;
            for (int h = 1; h <= kHostButtonMax; ++h)
                if (ui::holdArms(h))
                    ++armed;
            t.Equals(armed, kHostButtonMax - 5, "twelve of the seventeen arm it");
            t.IsTrue(ui::holdArms(kHostDpadUp) && ui::holdArms(kHostDpadLeft), "the d-pad does: the launcher reads only its edge, so a HELD d-pad is free");
            t.IsTrue(ui::holdArms(kHostL2) && ui::holdArms(kHostR2), "and both triggers, which the launcher reads not at all");
            t.IsTrue(ui::holdArms(kHostGuide) && ui::holdArms(kHostSelect) && ui::holdArms(kHostL3), "and the guide, select and the stick clicks");

            t.IsTrue(ui::kRemapHoldSeconds >= 0.6 && ui::kRemapHoldSeconds <= 1.0,
                     "the hold is between 600 ms and a second: past a fumbled press, short of a punishment");

            ui::HoldWatch w;
            ui::HoldFrame f;
            f.present = true;
            f.down[kHostFaceUp] = true;

            ui::HoldIntent got = ui::padHold(w, f, /*gameRunning=*/false, /*typing=*/false, /*pageArmed=*/true, 100.0);
            t.Equals(got.host, kHostFaceUp, "the frame it goes down it is the button building");
            t.IsFalse(got.fired, "nothing has fired yet");
            t.IsTrue(got.progress < 0.01f, "and the bar the page draws is empty");

            got = ui::padHold(w, f, false, false, true, 100.0 + ui::kRemapHoldSeconds * 0.5);
            t.IsTrue(std::fabs(got.progress - 0.5f) < 0.01f, "halfway through is half a bar");
            t.IsFalse(got.fired, "and still nothing committed");

            got = ui::padHold(w, f, false, false, true, 100.0 + ui::kRemapHoldSeconds);
            t.IsTrue(got.fired, "at the hold's length it fires");
            t.Equals(got.host, kHostFaceUp, "for the button that was held");
            t.IsTrue(std::fabs(got.progress - 1.0f) < 0.001f, "with a full bar");

            got = ui::padHold(w, f, false, false, true, 100.0 + ui::kRemapHoldSeconds * 4.0);
            t.IsFalse(got.fired, "and it fires ONCE: holding on does not open session after session");
            t.Equals(got.host, kHostFaceUp, "though the page still names the button it was");

            // A second armed button pressed during a hold changes nothing: the first keeps the watch.
            f.down[kHostL2] = true;
            got = ui::padHold(w, f, false, false, true, 100.0 + ui::kRemapHoldSeconds * 5.0);
            t.Equals(got.host, kHostFaceUp, "one gesture at a time");
        });

        tc.Run("hold-to-remap: letting go is the cancel, and the gate takes the gesture away with the pad", [](TestCase &t)
        {
            using namespace launcher::mapping;
            ui::HoldWatch w;
            ui::HoldFrame f;
            f.present = true;
            f.down[kHostL2] = true;

            // Letting go before the bar fills is the whole cancel, and it leaves nothing banked: the next
            // press starts its own clock rather than finishing the abandoned one.
            ui::padHold(w, f, false, false, true, 10.0);
            ui::HoldIntent got = ui::padHold(w, f, false, false, true, 10.0 + ui::kRemapHoldSeconds * 0.9);
            t.IsFalse(got.fired, "nine tenths of the way is not a remap");
            f.down[kHostL2] = false;
            got = ui::padHold(w, f, false, false, true, 10.0 + ui::kRemapHoldSeconds * 0.95);
            t.Equals(got.host, 0, "let go and nothing is building");
            f.down[kHostL2] = true;
            got = ui::padHold(w, f, false, false, true, 10.0 + ui::kRemapHoldSeconds);
            t.IsFalse(got.fired, "and pressing again does not collect the abandoned hold");
            t.IsTrue(got.progress < 0.01f, "the clock started over");

            // Every refusal CLEARS the watch rather than pausing it, so a hold begun under one condition can
            // never complete under another -- the same rule padIntent keeps for the stick's repeat clock.
            auto refuses = [&t](bool gameRunning, bool typing, bool pageArmed, bool present, const char *why)
            {
                ui::HoldWatch watch;
                ui::HoldFrame frame;
                frame.present = present;
                frame.down[kHostL2] = true;
                ui::padHold(watch, frame, gameRunning, typing, pageArmed, 0.0);
                const ui::HoldIntent late = ui::padHold(watch, frame, gameRunning, typing, pageArmed, ui::kRemapHoldSeconds * 3.0);
                t.IsFalse(late.fired, std::string("no hold ") + why);
                t.Equals(late.host, 0, std::string("and nothing is shown as building ") + why);
            };
            refuses(true, false, true, true, "while the game runs: the pad is the game's (P3)");
            refuses(false, true, true, true, "while a text field holds the keyboard: the pad's buttons are its way out");
            refuses(false, false, false, true, "anywhere but the CONTROLLER page with no session already open");
            refuses(false, false, true, false, "with no pad connected");

            // ... and one that was building when the condition changed is gone, not banked.
            ui::HoldWatch watch;
            ui::HoldFrame frame;
            frame.present = true;
            frame.down[kHostL2] = true;
            ui::padHold(watch, frame, false, false, true, 0.0);
            ui::padHold(watch, frame, /*gameRunning=*/true, false, true, ui::kRemapHoldSeconds * 0.5);
            const ui::HoldIntent back = ui::padHold(watch, frame, false, false, true, ui::kRemapHoldSeconds * 0.9);
            t.IsFalse(back.fired, "the game started mid-hold, so the hold did not survive it");
            t.IsTrue(back.progress < 0.01f, "it began again from zero when the page came back");
        });

        tc.Run("hold-to-remap opens the flow that already existed: the PS2 button the held control drives, and the same conflict", [](TestCase &t)
        {
            // The gesture decides WHEN to bind, never HOW: main.cpp turns a fired hold into exactly the
            // bindStart() the BUTTONS cell has always called, on the PS2 button that control drives now. So
            // "hold the button to remap the button" means: hold the one you want to MOVE, then press where
            // you want it -- and a clash is Goal 8's Conflict dialog, unchanged.
            using namespace launcher::mapping;
            Mapping m = defaults();
            const int target = boundTo(m, kHostL2);
            t.Equals(target, kPs2L2, "holding the left trigger is a session for the PS2 button it drives");
            t.IsTrue(target >= 0, "which is what main hands bindStart");

            ui::BindFlow flow;
            ui::bindStart(flow, static_cast<uint8_t>(target), 0.0);
            t.IsTrue(flow.state == ui::BindFlow::State::Listening, "the held button opens the same listening session a click does");

            // Press a button the mapping already uses: the same three answers, the same focus, the same words.
            t.IsTrue(ui::bindStep(flow, m, ui::BindInput{kHostR2, 0.1, false}, 1.0) == ui::BindEvent::Conflict,
                     "the right trigger is R2's, so the flow stops to ask");
            t.Equals(ui::dialogButtonCount(flow), 3, "swap, replace, cancel -- nothing new was invented for the gesture");
            t.Equals(ui::dialogFocusId(flow), std::string("pad.dialog.0"), "opening on SWAP as ever");
            const std::string sentence = ui::dialogSentence(flow, ui::GlyphFamily::Xbox);
            t.IsTrue(sentence.find("RT") != std::string::npos, "the sentence names the pad's own button: " + sentence);
            t.IsTrue(sentence.find("R2") != std::string::npos, "and what the game already has it as");
            t.IsTrue(ui::bindResolve(flow, m, Resolution::Swap, 2.0) == ui::BindEvent::Bound, "and swap still swaps");
            t.Equals(m.pad[rowOf(kPs2L2)].host, kHostR2, "L2 moved to the right trigger");
            t.Equals(m.pad[rowOf(kPs2R2)].host, kHostL2, "and R2 took the left one");

            // A control the mapping does not drive has nothing to remap: main says so rather than opening an
            // empty session. (kHostNone is never bound, by construction -- boundTo's own contract.)
            Mapping bare = defaults();
            rebind(bare, kPs2L2, kHostNone, Resolution::Replace);
            t.Equals(boundTo(bare, kHostL2), -1, "with L2 unbound, holding the left trigger has nothing to move");
            t.Equals(boundTo(bare, kHostNone), -1, "and 'none' is never bound to anything");
        });

        // ---- Sprint 10 Q4: the window switch -----------------------------------------------------------------
        // Owner 2026-09-20: "Pressing the XBOX or PLAYSTATION button should toggle the launcher focus if
        // possible, and again should swap back to the game." The measurement (win32_glue.h, the Q4 plan): the
        // guide arrives through raylib on Linux and for a DirectInput pad on Windows, and NOT for an XInput pad,
        // which the launcher reads through XInput's hidden entry point instead -- and when neither works, the
        // switch is a binding the player can move (kSwitchTarget through Goal 8's flow). The gate opens exactly
        // one button wide while the game runs: the rest of the pad stays the game's (P3), because the runtime
        // reads it whether or not its window is in front.
        tc.Run("the window switch is the one button the pad gate passes while the game runs, and nothing when it does not", [](TestCase &t)
        {
            ui::PadFrame pad;
            pad.present = true;
            pad.pressed[static_cast<int>(ui::PadNav::Toggle)] = true;
            pad.pressed[static_cast<int>(ui::PadNav::Right)] = true;
            pad.pressed[static_cast<int>(ui::PadNav::Activate)] = true;

            double repeatAt = 0.0;
            const ui::PadIntent running = ui::padIntent(pad, /*gameRunning=*/true, /*now=*/1.0, repeatAt);
            t.IsTrue(running.toggle, "while the game runs, the switch's press asks for the swap");
            t.Equals(running.dx, 0, "and the d-pad pressed with it still moves nothing: the pad is the game's");
            t.IsFalse(running.activate, "and A activates nothing");
            t.IsFalse(running.prompts, "and the prompts are not the pad's -- the launcher read one button, not the pad");

            double repeatAtIdle = 0.0;
            const ui::PadIntent idle = ui::padIntent(pad, /*gameRunning=*/false, /*now=*/1.0, repeatAtIdle);
            t.IsFalse(idle.toggle, "with no game there is nothing to swap to, so the press is not a swap");
            t.Equals(idle.dx, 1, "and the launcher is driven as before");

            ui::PadFrame none;
            none.present = true;
            const ui::PadIntent quiet = ui::padIntent(none, /*gameRunning=*/true, /*now=*/2.0, repeatAt);
            t.IsFalse(quiet.toggle, "no press, no swap");
        });

        tc.Run("the window switch is a config field: the guide by default, a host button name, none, and nonsense heals", [](TestCase &t)
        {
            using namespace launcher::mapping;
            launcher::Config c;
            t.Equals(c.focusToggle, std::string("guide"), "the guide button by default (the owner's XBOX / PS button)");
            t.Equals(launcher::focusToggleHost(c), static_cast<int>(kHostGuide), "which is raylib's GAMEPAD_BUTTON_MIDDLE");
            t.IsTrue(launcher::toJson(c).find("\"focusToggle\": \"guide\"") != std::string::npos, "written to config.json");

            c.focusToggle = "select";
            launcher::Config back;
            t.IsTrue(launcher::fromJson(launcher::toJson(c), back), "parses its own output");
            t.Equals(back.focusToggle, std::string("select"), "a bound button survives the round trip");
            t.Equals(launcher::focusToggleHost(back), static_cast<int>(kHostSelect), "and names raylib's button");

            c.focusToggle = "none";
            t.IsTrue(launcher::fromJson(launcher::toJson(c), back), "parses");
            t.Equals(back.focusToggle, std::string("none"), "off is kept");
            t.Equals(launcher::focusToggleHost(back), static_cast<int>(kHostNone), "and presses nothing");

            t.Equals(launcher::normalizeFocusToggle("banana"), std::string("guide"), "a word this build does not know is the default");
            t.Equals(launcher::normalizeFocusToggle(""), std::string("guide"), "and so is nothing");
            launcher::Config old;
            t.IsTrue(launcher::fromJson("{\"gsScale\": 1}", old), "a config written before Q4 parses");
            t.Equals(old.focusToggle, std::string("guide"), "and gets the guide");
            // Launcher-only: the game never sees the switch, so no variable carries it.
            for (const std::string &kv : launcher::environmentFor(c))
                t.IsTrue(kv.find("TOGGLE") == std::string::npos && kv.find("SWITCH") == std::string::npos, "no environment variable: " + kv);
        });

        tc.Run("the window switch binds through the press-the-button flow: a free button binds, a button the game reads is a two-answer conflict", [](TestCase &t)
        {
            using namespace launcher::mapping;
            ui::BindFlow flow;
            Mapping m = defaults();
            ui::bindStart(flow, ui::kSwitchTarget, 0.0);
            t.IsTrue(flow.state == ui::BindFlow::State::Listening, "the switch is a target the flow accepts");
            t.Equals(std::string(ui::ps2Label(ui::kSwitchTarget).text), std::string("SWITCH"), "and its cell reads SWITCH");
            t.IsTrue(ui::bindStep(flow, m, ui::BindInput{kHostGuide, 0.1, false}, 1.0) == ui::BindEvent::Bound, "the guide (no row of the mapping) binds");
            t.Equals(flow.lastHost, kHostGuide, "and the caller is told which button, to write into Config::focusToggle");
            t.IsTrue(m == defaults(), "the mapping is untouched: the switch takes no row");

            // A button the game reads: the conflict has two answers, opens on CANCEL, and REPLACE frees it.
            ui::bindStart(flow, ui::kSwitchTarget, 2.0);
            t.IsTrue(ui::bindStep(flow, m, ui::BindInput{kHostSelect, 0.1, false}, 3.0) == ui::BindEvent::Conflict, "VIEW / SHARE drives SELECT");
            t.Equals(flow.takenBy, static_cast<int>(kPs2Select), "which the flow names");
            t.Equals(ui::dialogButtonCount(flow), 2, "two answers -- there is nothing to swap the switch with");
            t.Equals(std::string(ui::dialogButtonLabel(flow, 0)), std::string("REPLACE"), "replace");
            t.Equals(std::string(ui::dialogButtonLabel(flow, 1)), std::string("CANCEL"), "cancel");
            t.Equals(ui::dialogFocusId(flow), std::string("pad.dialog.1"), "the focus lands on CANCEL: REPLACE takes a button from the game");
            t.Equals(ui::dialogButtonCount(flow.state), 3, "the state alone still says three: the overload on the flow is the one to ask");
            const std::string sentence = ui::dialogSentence(flow, ui::GlyphFamily::Xbox);
            t.IsTrue(sentence.find("VIEW") != std::string::npos && sentence.find("SELECT") != std::string::npos, "the sentence names both: " + sentence);
            t.IsTrue(ui::bindResolve(flow, m, Resolution::Swap, 4.0) == ui::BindEvent::Cancelled, "swap is refused for the switch: it is a cancel");
            t.IsTrue(m == defaults(), "and moved nothing");

            ui::bindStart(flow, ui::kSwitchTarget, 5.0);
            ui::bindStep(flow, m, ui::BindInput{kHostSelect, 0.1, false}, 6.0);
            t.IsTrue(ui::bindResolve(flow, m, Resolution::Replace, 7.0) == ui::BindEvent::Bound, "replace binds the switch");
            t.Equals(flow.lastHost, kHostSelect, "to VIEW / SHARE");
            t.Equals(m.pad[rowOf(kPs2Select)].host, kHostNone, "and SELECT lost its pad button: the game must not read the switch");
            t.Equals(boundTo(m, kHostSelect), -1, "nothing in the mapping drives it any more");
        });

        tc.Run("CONTROLLER: the window switch's cell and its OFF sit on BUTTONS' section row, clear of the section switch and RESTORE; the switch's conflict lays out two buttons", [](TestCase &t)
        {
            const ui::Rect window{0.0f, 0.0f, 1100.0f, 700.0f};
            ui::LayoutInputs in;
            in.padButtons = true;
            const std::vector<ui::Node> buttons = ui::layoutFor(ui::Page::Controller, window, in);
            t.IsTrue(ui::hasNode(buttons, ui::kSwitchCellId) && ui::hasNode(buttons, ui::kSwitchOffId), "both cells are in BUTTONS");
            const ui::Rect sw = ui::rectOf(buttons, ui::kSwitchCellId);
            const ui::Rect off = ui::rectOf(buttons, ui::kSwitchOffId);
            const ui::Rect section1 = ui::rectOf(buttons, "pad.section.1");
            const ui::Rect restore = ui::rectOf(buttons, "pad.restore");
            t.IsTrue(std::fabs(sw.y - section1.y) < 0.001f && std::fabs(off.y - section1.y) < 0.001f, "on the section row");
            t.IsTrue(sw.x >= section1.right() + 8.0f, "right of BUTTONS, with a gap");
            t.IsTrue(off.x >= sw.right() + 8.0f, "OFF right of the cell, with a gap");
            t.IsTrue(restore.x >= off.right() + 8.0f, "and RESTORE right of OFF, with a gap");
            in.padButtons = false;
            const std::vector<ui::Node> setup = ui::layoutFor(ui::Page::Controller, window, in);
            t.IsFalse(ui::hasNode(setup, ui::kSwitchCellId) || ui::hasNode(setup, ui::kSwitchOffId), "SETUP has neither: a binding lives with the bindings");
            in.padButtons = true;
            in.padDialogButtons = 2;
            const std::vector<ui::Node> dialog = ui::layoutFor(ui::Page::Controller, window, in);
            t.IsTrue(ui::hasNode(dialog, "pad.dialog.0") && ui::hasNode(dialog, "pad.dialog.1") && !ui::hasNode(dialog, "pad.dialog.2"),
                     "the switch's two-answer dialog lays out exactly two buttons");
            t.IsFalse(ui::hasNode(dialog, ui::kSwitchCellId), "and nothing behind it");
            t.IsTrue(ui::helpFor(ui::kSwitchCellId).find("XBOX / PS") != std::string::npos, "the cell's help names the button the owner asked for");
            t.IsFalse(ui::helpFor(ui::kSwitchOffId).empty(), "and OFF says what it leaves alone");
        });

        // Sprint 10 Q4 (b): the game window's caption, where the system lets a window colour it, wears the
        // launcher's top bar. The runtime cannot include ui/theme.h, so ps2x/host_window.h carries the three
        // numbers and this is what keeps them the theme's when the theme moves.
        tc.Run("the game window's chrome colours are the launcher's top bar, its text and its rule", [](TestCase &t)
        {
            using namespace ps2x::host_window;
            const ui::Rgba bar = ui::theme::mix(ui::theme::panel, ui::theme::ground, 0.5f);
            t.IsTrue(kCaption.r == bar.r && kCaption.g == bar.g && kCaption.b == bar.b, "the caption is the top bar's ground");
            t.IsTrue(kCaptionText.r == ui::theme::text.r && kCaptionText.g == ui::theme::text.g && kCaptionText.b == ui::theme::text.b,
                     "the caption's text is theme::text");
            t.IsTrue(kBorder.r == ui::theme::line.r && kBorder.g == ui::theme::line.g && kBorder.b == ui::theme::line.b,
                     "the border is theme::line, the rule under the bar");
            t.IsTrue(ui::contrastRatio(ui::Rgba{kCaptionText.r, kCaptionText.g, kCaptionText.b, 0xFF},
                                       ui::Rgba{kCaption.r, kCaption.g, kCaption.b, 0xFF}) >= 4.5f,
                     "and the title reads on it (4.5:1, the theme's own bar)");
        });

#ifndef _WIN32
        // Sprint 8 Task 4: the POSIX glue. These two need a real /proc and a real filesystem, so they run in
        // the Linux VM and in CI, never on Windows (where win32_glue.cpp owns the interface).
        tc.Run("startGame refuses a directory with no socom2 next to the launcher", [](TestCase &t)
        {
            const std::string dir = (std::filesystem::temp_directory_path() / ("ps2x_task4_" + win32glue::stamp())).string();
            std::error_code ec;
            std::filesystem::create_directories(dir, ec);
            launcher::Config config;
            win32glue::GameProcess game;
            t.IsTrue(!win32glue::startGame(dir, config, game), "no socom2 in the folder is a false, not a spawn");
            t.IsTrue(game.error.find("socom2") != std::string::npos, "the message names socom2, so the player knows what is missing");
            std::filesystem::remove_all(dir, ec);
        });

        // F9: close() used to poll once with WNOHANG and then set pid = 0, abandoning a child that
        // was still running -- the launcher lost its only handle on the game, nothing could stop it,
        // and its status was never collected. close() must end the child and reap it.
        tc.Run("close() ends and reaps a game that is still running", [](TestCase &t)
        {
            namespace fs = std::filesystem;
            const fs::path dir = fs::temp_directory_path() / ("ps2x_f9_" + win32glue::stamp());
            std::error_code ec;
            fs::create_directories(dir, ec);

            // A stand-in for the game: it outlives the test on purpose, so an abandoned child would
            // still be alive when the assertions run.
            {
                std::ofstream script((dir / "socom2").string());
                script << "#!/bin/sh\n" << "sleep 30\n";
            }
            fs::permissions(dir / "socom2",
                            fs::perms::owner_all | fs::perms::group_read | fs::perms::group_exec,
                            fs::perm_options::replace, ec);
            { std::ofstream elf((dir / "socom2_game.elf").string()); }   // startGame only checks that it exists

            launcher::Config config;
            win32glue::GameProcess game;
            const bool started = win32glue::startGame(dir.string(), config, game);
            t.IsTrue(started, "the stand-in game must spawn (" + game.error + ")");
            if (!started)
            {
                fs::remove_all(dir, ec);
                return;
            }
            const pid_t child = static_cast<pid_t>(game.pid);
            t.IsTrue(child > 0, "and report a pid");
            t.IsTrue(game.running(), "and be running before close() is called");

            const auto start = std::chrono::steady_clock::now();
            game.close();
            const long long closeMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                                          std::chrono::steady_clock::now() - start)
                                          .count();

            // Reaped by close() means there is nothing left to wait for: ECHILD, not a live pid.
            bool gone = false;
            for (int i = 0; i < 30 && !gone; ++i)
            {
                int raw = 0;
                errno = 0;
                const pid_t r = ::waitpid(child, &raw, WNOHANG);
                gone = (r < 0 && errno == ECHILD) || r == child;
                if (!gone)
                    std::this_thread::sleep_for(std::chrono::milliseconds(100));
            }
            t.IsTrue(gone, "close() must have reaped the child: waitpid has nothing left to report");
            t.IsTrue(closeMs < 3000, "and it must not have taken longer than the SIGTERM grace period");
            t.IsFalse(game.running(), "and the launcher must no longer believe a game is running");

            // Nothing of the stand-in survives: an abandoned `sleep 30` would still answer kill(0).
            t.IsTrue(::kill(child, 0) != 0 && errno == ESRCH,
                     "and the process itself must be gone, not left running without a handle");

            fs::remove_all(dir, ec);
        });

        tc.Run("exeDirectory is a directory that exists", [](TestCase &t)
        {
            const std::string dir = win32glue::exeDirectory();
            t.IsTrue(!dir.empty(), "exeDirectory answers something");
            std::error_code ec;
            t.IsTrue(std::filesystem::is_directory(dir, ec), "and it is a directory that exists (/proc/self/exe's parent, or the fallback)");
        });
#endif

        tc.Run("a text field lets go: the pad's two face buttons, a click away, and the three keys", [](TestCase &t)
        {
            // 2026-09-22, the owner's playthrough finding 1: "When you click a field with text (like in
            // online tab), and exit the field, controller no longer functions in the launcher." While a field
            // holds the keyboard, main's navigation branch -- the only consumer of PadIntent's dx, dy and
            // activate -- is skipped entirely, so a field that never lets go IS a dead pad. Before this the
            // ways out were ENTER, ESCAPE and TAB: three keyboard keys, none of them on a controller.
            const ui::PadIntent idle{};
            t.IsTrue(!ui::releasesField(false, false, false, idle, false), "nothing pressed: the field keeps the keyboard");
            t.IsTrue(ui::releasesField(true, false, false, idle, false), "ENTER");
            t.IsTrue(ui::releasesField(false, true, false, idle, false), "ESCAPE");
            t.IsTrue(ui::releasesField(false, false, true, idle, false), "TAB");
            t.IsTrue(ui::releasesField(false, false, false, idle, true), "a click no editable widget took is a click away");
            ui::PadIntent cross{};
            cross.activate = true;
            t.IsTrue(ui::releasesField(false, false, false, cross, false), "the pad's cross commits and lets go");
            ui::PadIntent circle{};
            circle.back = true;
            t.IsTrue(ui::releasesField(false, false, false, circle, false), "the pad's circle abandons and lets go");
            ui::PadIntent moving{};
            moving.dx = 1;
            moving.dy = -1;
            t.IsTrue(!ui::releasesField(false, false, false, moving, false),
                     "the stick alone does not leave the field -- only the two face buttons do");
        });

        tc.Run("the login fields take exactly what the game's keyboard can hold: no space, no quote in the name", [](TestCase &t)
        {
            // The 2026-09-22 audit's finding 1. typeInto accepted every character from 32 to 126, so a space
            // entered the field and was saved to config.json; keyboardText dropped it at environmentFor. The
            // field showed one string and the game was handed another, the keyboard opened with the wrong
            // text, and the login failed with nothing on screen to explain it.
            t.IsTrue(!launcher::keyboardAccepts(' ', false), "the name refuses a space");
            t.IsTrue(!launcher::keyboardAccepts(' ', true), "so does the password: neither keyboard has one");
            t.IsTrue(!launcher::keyboardAccepts('"', false), "the name keyboard's NoDQuote flag refuses the double quote");
            t.IsTrue(launcher::keyboardAccepts('"', true), "the password keyboard offers it");
            t.IsTrue(launcher::keyboardAccepts('a', false) && launcher::keyboardAccepts('Z', false)
                         && launcher::keyboardAccepts('7', false) && launcher::keyboardAccepts('-', false),
                     "printable ASCII passes");
            t.IsTrue(!launcher::keyboardAccepts('\t', false) && !launcher::keyboardAccepts('\n', false)
                         && !launcher::keyboardAccepts(static_cast<char>(0x7F), false),
                     "a control character and DEL do not");

            // The invariant that makes the field trustworthy: whatever is in the config is ALREADY what the
            // game will be handed, so what the player reads in the field is what the keyboard will hold.
            launcher::Config loaded;
            t.IsTrue(launcher::fromJson("{\"loginName\": \"my name\", \"loginPassword\": \"pass word\"}", loaded),
                     "a config.json with spaces in both fields loads");
            t.Equals(loaded.loginName, std::string("myname"), "the name is normalised on the way IN, not on the way out");
            t.Equals(loaded.loginPassword, std::string("password"), "and so is the password");
            t.Equals(launcher::normalizeLoginName(loaded.loginName), loaded.loginName,
                     "the stored name is a fixed point: the field cannot differ from what is sent");
            t.Equals(launcher::normalizeLoginPassword(loaded.loginPassword), loaded.loginPassword,
                     "and so is the stored password");
            launcher::Config quoted;
            t.IsTrue(launcher::fromJson("{\"loginName\": \"a\\\"b\"}", quoted), "a name with a double quote loads");
            t.Equals(quoted.loginName, std::string("ab"), "and loses the quote its keyboard has no key for");
        });

        tc.Run("a received report invites a public issue; a report that was not received never does", [](TestCase &t)
        {
            // Sprint 11 Goal 7, the bug pipeline's GitHub half. Reports are private and their content is
            // untrusted, so nothing crosses from the inbox to GitHub by itself. The only bridge is one
            // sentence under SEND, inviting whoever filed the report to open an issue themselves and quote
            // the reference. (The site's form is asked to say the same thing; that half is the site's.)
            //
            // It belongs to the reply that was ACCEPTED AND carries a reference -- which is exactly the
            // reference the page prints above it. A rate-limited, refused or undelivered SEND has no id to
            // quote, and sending someone to the issue tracker empty-handed would cost a stranger a trip and
            // us an issue nobody can reproduce.
            namespace br = launcher::bugreport;
            // The suffix the service mints is lower-case hex (bug_report.cpp looksLikeOurId); parseReply
            // upper-cases it for the screen, and an id shaped any other way leaves `id` empty.
            const br::Reply sent = br::parseReply(201, "{\"ok\":true,\"id\":\"BR-20260923-abc123\"}");
            t.IsTrue(sent.kind == br::Reply::Kind::Sent && sent.id == "BR-20260923-ABC123",
                     "201 with ok and one of our ids is a received report with a reference");
            t.Equals(br::githubLine(sent.id),
                     std::string("Contributors can also open an issue at github.com/Scotho/socom-unzipped and quote this id"
                                 " -- unless it is a security report: those go through SECURITY.md, never a public issue."),
                     "the success text carries the sentence, word for word");
            // Owner ruling O4 I1 (2026-09-26): the invitation excepts security reports, which SECURITY.md
            // keeps out of the public tracker -- the sentence must never steer an exploit into a public issue.
            const std::string invitation = br::kGithubIssueLine;
            t.IsTrue(invitation.find("SECURITY.md") != std::string::npos, "the line names SECURITY.md");
            t.IsTrue(invitation.find("never a public issue") != std::string::npos,
                     "and says a security report is never a public issue");
            t.Equals(br::githubLine(sent.id), std::string(br::kGithubIssueLine),
                     "and it is the header's single literal, so the launcher and the site cannot drift apart");

            const br::Reply rateLimited = br::parseReply(429, "", 1500);
            const br::Reply fieldError = br::parseReply(400, "{\"error\":\"title is too short\"}");
            const br::Reply failed = br::parseReply(0, "");
            t.IsTrue(rateLimited.kind == br::Reply::Kind::RateLimited && fieldError.kind == br::Reply::Kind::FieldError
                         && failed.kind == br::Reply::Kind::Failed,
                     "the three ways a SEND does not land");
            t.Equals(br::githubLine(rateLimited.id), std::string(), "too many reports from here: no id, no invitation");
            t.Equals(br::githubLine(fieldError.id), std::string(), "a form the service refused: nothing to quote");
            t.Equals(br::githubLine(failed.id), std::string(), "a report that never arrived: nothing to quote");
            t.IsTrue(rateLimited.text.find("github") == std::string::npos
                         && fieldError.text.find("github") == std::string::npos
                         && failed.text.find("github") == std::string::npos,
                     "and no failure line names the repository anywhere in it");

            // 201 with an id that is not ours: the service answered, but there is no reference on screen,
            // so "quote this id" would be a lie. This is the same empty id the page checks, which is why
            // the page can ask about the reference and get the reply's own answer.
            const br::Reply anonymous = br::parseReply(201, "{\"ok\":true,\"id\":\"thanks\"}");
            t.IsTrue(anonymous.kind == br::Reply::Kind::Sent && anonymous.id.empty(), "received, but with no reference");
            t.Equals(br::githubLine(anonymous.id), std::string(), "no reference on screen means no invitation to quote one");
            t.IsTrue(sent.text.find("github") == std::string::npos,
                     "the reply's own line stays the site's words; the invitation is the page's second line");
        });
    });

    // Sprint 16 L1b (#73, R295): the persona ledgers beside the cards -- the reader over cards/, the JSON both ends
    // share and the atomic write. Every case builds its own cards/ under the temp folder (the design note, section 4).
    MiniTest::Case("Personas", [](TestCase &tc)
    {
        namespace ps = launcher::personas;
        namespace fs = std::filesystem;

        tc.Run("the ledger sits BESIDE the card: a trailing separator is stripped before the suffix", [](TestCase &t)
        {
            t.Equals(ps::ledgerPathFor("cards/player/"), std::string("cards/player.personas.json"), "not inside cards/player/");
            t.Equals(ps::ledgerPathFor("cards/player"), std::string("cards/player.personas.json"), "the plain root");
            t.Equals(ps::ledgerPathFor("cards/player_b"), std::string("cards/player_b.personas.json"), "the second instance's card");
            t.Equals(ps::ledgerPathFor("C:\\games\\cards\\player\\"), std::string("C:\\games\\cards\\player.personas.json"), "a Windows separator too");
            t.Equals(ps::ledgerPathFor("/x/mc0//"), std::string("/x/mc0.personas.json"), "every trailing separator");
        });

        tc.Run("readCards (a): no cards/, no ledger, a 0-byte ledger and [] all read as no rows and the plain sentence", [](TestCase &t)
        {
            const fs::path cards = makeCardsDir();
            ps::Cards none = ps::readCards((cards / "absent").string());
            t.IsTrue(none.rows.empty() && none.notes.empty(), "no cards/ at all: nothing, and nothing to say");
            t.Equals(std::string(ps::emptySentence(none)), std::string(ps::kEmptySentence), "the one sentence");
            makeCard(cards, "player");
            t.IsTrue(ps::readCards(cards.string()).rows.empty(), "a card and no ledger");
            writeFileText(cards / "player.personas.json", "");
            ps::Cards zero = ps::readCards(cards.string());
            t.IsTrue(zero.rows.empty() && zero.notes.empty(), "a 0-byte ledger is an empty one, not a corrupt one");
            writeFileText(cards / "player.personas.json", "[]");
            ps::Cards empty = ps::readCards(cards.string());
            t.IsTrue(empty.rows.empty() && empty.notes.empty(), "[] is no records");
            t.Equals(std::string(ps::emptySentence(empty)), std::string(ps::kEmptySentence), "and the plain sentence");
            removeCardsDir(cards);
        });

        tc.Run("readCards (b, c): one record is one row; two are two rows, newest login first, carrying their card", [](TestCase &t)
        {
            const fs::path cards = makeCardsDir();
            makeCard(cards, "player");
            writeFileText(cards / "player.personas.json", ledgerText({persona("alpha", "socom.scotho.com", 1000)}));
            ps::Cards one = ps::readCards(cards.string());
            t.Equals(one.rows.size(), size_t(1), "one row");
            if (one.rows.size() == 1)
            {
                t.Equals(one.rows[0].name, std::string("alpha"), "its name");
                t.Equals(one.rows[0].server, std::string("socom.scotho.com"), "its server");
                t.Equals(one.rows[0].card, std::string("player"), "its card, from the ledger's file name");
                t.Equals(static_cast<long long>(one.rows[0].lastLogin), 1000LL, "its last login");
            }
            t.Equals(std::string(ps::emptySentence(one)), std::string(), "no sentence over a row");
            writeFileText(cards / "player.personas.json",
                          ledgerText({persona("older", "socom.scotho.com", 1000), persona("newer", "socom.scotho.com", 5000)}));
            makeCard(cards, "sgt");
            writeFileText(cards / "sgt.personas.json", ledgerText({persona("middle", "192.0.2.20", 3000)}));
            ps::Cards three = ps::readCards(cards.string());
            t.Equals(three.rows.size(), size_t(3), "every ledger's records");
            if (three.rows.size() == 3)
            {
                t.Equals(three.rows[0].name, std::string("newer"), "newest first");
                t.Equals(three.rows[1].name, std::string("middle"), "across ledgers");
                t.Equals(three.rows[2].name, std::string("older"), "oldest last");
                t.Equals(three.rows[1].card, std::string("sgt"), "each row names its own card");
            }
            removeCardsDir(cards);
        });

        tc.Run("one record per (name, server): two servers are two rows, a second login updates its record", [](TestCase &t)
        {
            std::vector<ps::Persona> records;
            ps::upsert(records, persona("alpha", "socom.scotho.com", 100, false));
            ps::upsert(records, persona("alpha", "192.0.2.20", 200, false));
            t.Equals(records.size(), size_t(2), "one name on two servers is two records");
            ps::upsert(records, persona("alpha", "socom.scotho.com", 300, true));
            t.Equals(records.size(), size_t(2), "the same pair again is an update");
            if (records.size() == 2)
            {
                t.IsTrue(records[0].lastLogin == 300 && records[0].savedPassword, "carrying the new login and its answer");
                t.IsTrue(records[1].lastLogin == 200 && !records[1].savedPassword, "and the other server's record untouched");
            }
        });

        tc.Run("readCards (e): every keyboard character and an accented name round-trip toJson/fromJson byte for byte", [](TestCase &t)
        {
            std::string keyboard;
            for (int ch = 0x21; ch <= 0x7E; ++ch)
                if (ch != '"')
                    keyboard.push_back(static_cast<char>(ch));
            const std::string latin1 = std::string("xmf") + static_cast<char>(0xFB);            // the game's byte for u-circumflex
            const std::string utf8 = std::string("xmf") + static_cast<char>(0xC3) + static_cast<char>(0xBB);
            const std::vector<ps::Persona> in = {persona(keyboard, "a\\b\"c{d}:e,f", 1, true, false),
                                                 persona(latin1, "socom.scotho.com", 2), persona(utf8, "socom.scotho.com", 3)};
            const std::string json = ps::toJson(in);
            t.IsTrue(json.find("\\u00fb") != std::string::npos, "a byte past ASCII is written \\u00XX");
            std::vector<ps::Persona> back;
            t.IsTrue(ps::fromJson(json, back), "the ledger parses");
            t.Equals(back.size(), size_t(3), "all three records");
            if (back.size() == 3)
            {
                t.Equals(back[0].name, keyboard, "the backslash, braces, colon and comma survive");
                t.Equals(back[0].server, in[0].server, "and in the server");
                t.Equals(back[1].name, latin1, "the accented byte comes back itself, not '?' (json_reader.h's \\u branch)");
                t.Equals(back[2].name, utf8, "and a two-byte sequence as its two bytes");
                t.IsTrue(back[0].savedPassword && !back[1].savedPassword, "savedPassword is kept");
            }
            t.Equals(ps::displayName(latin1), std::string("xmf?"), "shown with what the glyph set has, never refused");
            t.Equals(ps::displayName(keyboard), keyboard, "printable ASCII is shown as is");
        });

        tc.Run("readCards (f): a truncated ledger, a record with no name or no server, a ledger with no card -- skipped with a note", [](TestCase &t)
        {
            const fs::path cards = makeCardsDir();
            makeCard(cards, "good");
            writeFileText(cards / "good.personas.json", ledgerText({persona("kept", "socom.scotho.com", 10)}));
            makeCard(cards, "trunc");
            const std::string whole = ledgerText({persona("lost", "socom.scotho.com", 10)});
            writeFileText(cards / "trunc.personas.json", whole.substr(0, whole.size() / 2));
            makeCard(cards, "noname");
            writeFileText(cards / "noname.personas.json", "[{\"server\": \"socom.scotho.com\", \"lastLogin\": 1}]");
            makeCard(cards, "noserver");
            writeFileText(cards / "noserver.personas.json", "[{\"name\": \"x\", \"lastLogin\": 1}]");
            writeFileText(cards / "old.personas.json", ledgerText({persona("orphan", "socom.scotho.com", 10)}));   // no cards/old/
            ps::Cards read;
            bool threw = false;
            try { read = ps::readCards(cards.string()); } catch (...) { threw = true; }
            t.IsFalse(threw, "never a throw");
            t.Equals(read.rows.size(), size_t(1), "only the good ledger's record");
            if (!read.rows.empty())
                t.Equals(read.rows[0].name, std::string("kept"), "that one");
            t.Equals(read.notes.size(), size_t(4), "one line per skipped ledger");
            bool namesOld = false;
            for (const std::string &n : read.notes)
                namesOld = namesOld || n.find("old.personas.json") != std::string::npos;
            t.IsTrue(namesOld, "the note names the ledger whose card is gone");
            removeCardsDir(cards);
        });

        tc.Run("readCards (f2, RED first): a ledger nested 200,000 deep and one over 1 MiB are refused with a note, never a crash", [](TestCase &t)
        {
            const fs::path cards = makeCardsDir();
            makeCard(cards, "deep");
            const std::string deep = "[{\"name\": \"x\", \"server\": \"s\", \"junk\": " + std::string(200000, '[') + std::string(200000, ']') + "}]";
            writeFileText(cards / "deep.personas.json", deep);
            std::vector<ps::Persona> out;
            std::string note;
            t.IsFalse(ps::readLedger((cards / "deep.personas.json").string(), out, note), "the deep ledger is refused");
            t.IsTrue(out.empty() && note.find("deep.personas.json") != std::string::npos, "with a note naming it");
            const std::string nested = "[{\"name\": \"x\", \"server\": \"s\", \"later\": " + std::string(20, '[') + std::string(20, ']') + "}]";
            t.IsTrue(ps::fromJson(nested, out) && out.size() == 1, "a field a later writer nests 20 deep is still skipped whole");
            makeCard(cards, "huge");
            std::string huge = ledgerText({persona("big", "socom.scotho.com", 10)});
            huge += std::string(static_cast<size_t>(ps::kLedgerMostBytes) + 1 - huge.size(), ' ');
            writeFileText(cards / "huge.personas.json", huge);
            note.clear();
            t.IsTrue(ps::fromJson(huge, out) && out.size() == 1, "the text itself is a ledger");
            t.IsFalse(ps::readLedger((cards / "huge.personas.json").string(), out, note), "but a file over 1 MiB is refused unread");
            t.IsTrue(note.find("huge.personas.json") != std::string::npos && note.find("MiB") != std::string::npos, "one line saying why");
            huge.resize(static_cast<size_t>(ps::kLedgerMostBytes));
            writeFileText(cards / "huge.personas.json", huge);
            t.IsTrue(ps::readLedger((cards / "huge.personas.json").string(), out, note) && out.size() == 1, "at the cap it is read");
            const ps::Cards read = ps::readCards(cards.string());
            t.Equals(read.rows.size(), size_t(1), "readCards keeps the rest");
            removeCardsDir(cards);
        });

        tc.Run("readCards (g): a save folder with a SaveGame file and no ledger is the 'again' sentence; the folder alone is the plain one", [](TestCase &t)
        {
            const fs::path cards = makeCardsDir();
            makeCard(cards, "player", false);
            ps::Cards plain = ps::readCards(cards.string());
            t.IsFalse(plain.savesWithoutLedger, "every booted card has the folder, persona or not");
            t.Equals(std::string(ps::emptySentence(plain)), std::string(ps::kEmptySentence), "the plain sentence");
            makeCard(cards, "player", true);
            ps::Cards again = ps::readCards(cards.string());
            t.IsTrue(again.savesWithoutLedger, "a SaveGame file and no ledger");
            t.Equals(std::string(ps::emptySentence(again)), std::string(ps::kEmptyAgainSentence), "the 'again' sentence");
            t.IsTrue(std::string(ps::kEmptyAgainSentence).find("again") != std::string::npos, "which says so");
            writeFileText(cards / "player.personas.json", "[]");
            t.IsFalse(ps::readCards(cards.string()).savesWithoutLedger, "a ledger beside it answers for that card");
            removeCardsDir(cards);
        });

        tc.Run("readCards (h): the record's `second` is read from the record, never from the _b suffix", [](TestCase &t)
        {
            const fs::path cards = makeCardsDir();
            makeCard(cards, "player_b");
            writeFileText(cards / "player_b.personas.json", ledgerText({persona("bravo", "socom.scotho.com", 10, false, true)}));
            makeCard(cards, "sgt_b");
            writeFileText(cards / "sgt_b.personas.json", ledgerText({persona("sierra", "socom.scotho.com", 5, false, false)}));
            ps::Cards read = ps::readCards(cards.string());
            t.Equals(read.rows.size(), size_t(2), "both ledgers");
            if (read.rows.size() == 2)
            {
                t.IsTrue(read.rows[0].second && read.rows[0].card == "player_b", "the second instance's record says so");
                t.IsTrue(!read.rows[1].second && read.rows[1].card == "sgt_b", "a hand-made sgt_b card is a card like any other");
            }
            removeCardsDir(cards);
        });

        tc.Run("selection (c, h, i, j): a row is selected by its card and name; picking sets the launch and clears the password", [](TestCase &t)
        {
            launcher::Config c;   // profile "player", the project's server
            const std::string server = launcher::effectiveServer(c);
            std::vector<ps::Persona> rows = {persona("alpha", server, 20), persona("bravo", server, 10)};
            rows[0].card = "player";
            rows[1].card = "player";
            t.Equals(ps::selectedRow(rows, c), rows.size(), "an empty name matches no record: NEW PERSONA is selected");
            t.IsTrue(ps::passwordShown(rows, c), "and the field shows");
            c.loginPassword = "old1";   // a config from before this build: its plain password
            c.loginName = "zulu";
            t.Equals(ps::selectedRow(rows, c), rows.size(), "a name the ledger never held selects NEW PERSONA too");
            ps::pick(c, rows[0]);
            t.IsTrue(c.profile == "player" && c.loginName == "alpha" && c.loginPassword.empty(), "(c) picking sets the card and the name, clears the password");
            t.Equals(ps::selectedRow(rows, c), size_t(0), "and the row is the selected one");
            c.loginPassword = "typed";   // typed for alpha
            ps::pick(c, rows[1]);
            t.IsTrue(c.loginName == "bravo" && c.loginPassword.empty(), "(i) B picked after A never launches with A's password");
            t.Equals(ps::selectedRow(rows, c), size_t(1), "B is selected");

            ps::Persona accented = persona(std::string("xmf") + static_cast<char>(0xFB), server, 5);
            accented.card = "player";
            c.loginPassword = "x";
            ps::pick(c, accented);
            t.IsTrue(c.loginName.empty(), "(j) a name normalizeLoginName would change leaves loginName EMPTY, never 'xmf'");
            bool sendsName = false;
            for (const std::string &e : launcher::environmentFor(c))
                sendsName = sendsName || e.rfind("PS2X_SOCOM2_LOGIN_NAME=", 0) == 0;
            t.IsFalse(sendsName, "so no PS2X_SOCOM2_LOGIN_NAME is sent");

            ps::Persona b = persona("bravo", server, 30, false, true);
            b.card = "player_b";
            ps::pick(c, b);
            t.IsTrue(c.profile == "player" && c.secondInstance, "(h) second: true in player_b -> profile player, the toggle on");
            std::vector<ps::Persona> withB = rows;
            withB.push_back(b);
            t.Equals(ps::selectedRow(withB, c), size_t(2), "and the _b row is the selected one after its pick");
            bool cardB = false;
            for (const std::string &e : launcher::environmentFor(c))
                cardB = cardB || e == "PS2X_MC_DIR=cards/player_b";
            t.IsTrue(cardB, "environmentFor appends _b itself");
            ps::Persona sgt = persona("sierra", server, 1, false, false);
            sgt.card = "sgt_b";
            ps::pick(c, sgt);
            t.IsTrue(c.profile == "sgt_b" && !c.secondInstance, "second: false in sgt_b -> sgt_b, the toggle off");

            c.loginPassword = "keep";
            ps::pickNewPersona(c);
            t.IsTrue(c.loginName.empty() && c.loginPassword.empty() && c.profile == "sgt_b", "NEW PERSONA clears the name and password and keeps the card");
        });

        tc.Run("a record counts only on effectiveServer: the field and the saved password follow the server", [](TestCase &t)
        {
            launcher::Config c;
            const std::string here = launcher::effectiveServer(c);
            std::vector<ps::Persona> rows = {persona("alpha", "192.0.2.10", 50, true), persona("alpha", here, 40, true), persona("bravo", here, 30, false)};
            for (ps::Persona &r : rows)
                r.card = "player";
            c.loginName = "alpha";
            t.Equals(ps::selectedRow(rows, c), size_t(1), "one name on two servers: the one on effectiveServer wins");
            t.IsFalse(ps::passwordShown(rows, c), "its card holds the password: no field");
            t.IsTrue(ps::counts(rows[1], c) && !ps::counts(rows[0], c), "a record counts only on the server the game is pointed at");
            std::vector<ps::Persona> elsewhere = {rows[0]};
            t.Equals(ps::selectedRow(elsewhere, c), size_t(0), "alone, the other server's record is still the selected row (else the first)");
            t.IsTrue(ps::passwordShown(elsewhere, c), "but it is 'no record' there: the field shows");
            c.loginName = "bravo";
            t.IsTrue(ps::passwordShown(rows, c), "a record without a saved password: the field shows");
        });

        tc.Run("readCards (d), the config write rule: a true record on effectiveServer -> \"loginPassword\": \"\"; false, absent or elsewhere -> kept", [](TestCase &t)
        {
            launcher::Config c;
            const std::string here = launcher::effectiveServer(c);
            auto sendsPass = [](const std::vector<std::string> &env) {
                for (const std::string &e : env)
                    if (e.rfind("PS2X_SOCOM2_LOGIN_PASS=", 0) == 0)
                        return true;
                return false;
            };
            std::vector<ps::Persona> rows = {persona("alpha", here, 10, true)};
            rows[0].card = "player";
            c.loginName = "alpha";
            c.loginPassword = "hunter2";
            t.IsTrue(ps::cardHoldsPassword(rows, c), "the selected record on this server says the card holds it");
            t.IsTrue(launcher::toJson(c, rows).find("\"loginPassword\": \"\"") != std::string::npos, "config.json keeps the key, empty");
            t.IsFalse(sendsPass(launcher::environmentFor(c, rows)), "and no PS2X_SOCOM2_LOGIN_PASS: the game fills its own form from the card");
            t.IsTrue(ps::dropSavedPassword(c, rows) && c.loginPassword.empty(), "the migration clears the plain copy at the read");
            t.IsFalse(ps::dropSavedPassword(c, rows), "once");

            c.loginPassword = "hunter2";
            rows[0].savedPassword = false;
            t.IsTrue(launcher::toJson(c, rows).find("\"loginPassword\": \"hunter2\"") != std::string::npos, "a false record: the typed value is kept");
            t.IsTrue(sendsPass(launcher::environmentFor(c, rows)), "and sent");
            t.IsFalse(ps::dropSavedPassword(c, rows), "and never dropped");
            rows[0].savedPassword = true;
            rows[0].server = "192.0.2.10";
            t.IsTrue(launcher::toJson(c, rows).find("\"loginPassword\": \"hunter2\"") != std::string::npos,
                     "a true record on ANOTHER server is no record here: kept (a server switch never drops the plain password)");
            t.IsTrue(sendsPass(launcher::environmentFor(c, rows)), "and sent");
            t.IsFalse(ps::dropSavedPassword(c, rows), "and not dropped");
            const std::vector<ps::Persona> none;
            t.IsTrue(launcher::toJson(c, none).find("\"loginPassword\": \"hunter2\"") != std::string::npos, "no record at all: kept");
            t.Equals(launcher::toJson(c, none), launcher::toJson(c), "and the file is what it always was");
        });

        tc.Run("a row's server is shown by its preset's label, matched by address; any other address as it is", [](TestCase &t)
        {
            const launcher::ServerPreset *unzipped = launcher::findServerPresetByAddress("socom.scotho.com");
            t.IsTrue(unzipped != nullptr && std::string(unzipped->id) == "unzipped", "the project server's address is its preset");
            t.IsTrue(launcher::findServerPresetByAddress("192.0.2.10") == nullptr, "a typed address is no preset");
            t.IsTrue(launcher::findServerPresetByAddress("") == nullptr, "and Custom's empty address matches nothing");
            t.Equals(ps::serverCaption("socom.scotho.com"), std::string(unzipped != nullptr ? unzipped->label : "?"), "the label");
            t.Equals(ps::serverCaption("192.0.2.10"), std::string("192.0.2.10"), "else the address");
        });

        tc.Run("the row's captions: the age of the last login", [](TestCase &t)
        {
            t.Equals(ps::ageCaption(1000, 1000 + 3600), std::string("last played today"), "the same day");
            t.Equals(ps::ageCaption(1000, 1000 + 86400), std::string("last played 1 day ago"), "one day");
            t.Equals(ps::ageCaption(1000, 1000 + 5 * 86400 + 7), std::string("last played 5 days ago"), "five");
        });

        tc.Run("the atomic write: the ledger is unchanged until the rename, and nothing is left behind", [](TestCase &t)
        {
            const fs::path cards = makeCardsDir();
            const std::string path = (cards / "player.personas.json").string();
            const std::string before = ledgerText({persona("old", "socom.scotho.com", 1)});
            const std::string after = ledgerText({persona("old", "socom.scotho.com", 1), persona("new", "socom.scotho.com", 2)});
            t.IsTrue(ps::writeAtomic(path, before), "the first write");
            t.Equals(readFileText(path), before, "lands whole");
            t.IsTrue(ps::writeTemp(path, after), "the second one's text is written aside");
            t.Equals(readFileText(path), before, "and the ledger is still the old one");
            t.IsTrue(fs::exists(ps::tempPathFor(path)), "the temp file is beside it");
            t.IsTrue(ps::commitTemp(path), "the rename");
            t.Equals(readFileText(path), after, "replaces it whole");
            t.IsFalse(fs::exists(ps::tempPathFor(path)), "and leaves no temp file");
            t.IsFalse(ps::writeAtomic((cards / "no_such_dir" / "x.personas.json").string(), after), "a write that cannot land says so");
            removeCardsDir(cards);
        });
    });
}
