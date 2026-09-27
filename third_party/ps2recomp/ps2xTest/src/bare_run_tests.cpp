// Sprint 9 Goal 1: socom2 with no argument reads the launcher's config.json beside it.
#include "MiniTest.h"
#include "ps2x/bare_run.h"
#include "ps2x/exe_dir.h"
#include "ps2x/exit_codes.h"
#include "launcher/launcher_config.h"

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

namespace
{
    namespace fs = std::filesystem;

    fs::path makeHome()
    {
        static int counter = 0;
        const auto ticks = std::chrono::steady_clock::now().time_since_epoch().count();
        const fs::path home = fs::temp_directory_path() / ("ps2x_bare_" + std::to_string(ticks) + "_" + std::to_string(counter++));
        std::error_code ec;
        fs::create_directories(home, ec);
        return home;
    }

    void writeText(const fs::path &p, const std::string &text)
    {
        std::ofstream out(p, std::ios::binary | std::ios::trunc);
        out << text;
    }

    std::string valueOf(const std::vector<std::string> &env, const std::string &key)
    {
        for (const std::string &kv : env)
            if (kv.rfind(key + "=", 0) == 0)
                return kv.substr(key.size() + 1);
        return "<absent>";
    }
}

void register_bare_run_tests()
{
    MiniTest::Case("BareRun", [](TestCase &tc)
    {
        tc.Run("the launcher's config.json becomes the same environment the launcher would have set", [](TestCase &t)
        {
            const fs::path home = makeHome();
            launcher::Config c;
            c.isoPath = "D:/discs/socom2.iso";
            c.gsScale = 2;
            c.profile = "viper";
            c.serverPreset = "custom";
            c.server = "198.51.100.5";
            c.crouchShortcut = "l3";
            writeText(home / "config.json", launcher::toJson(c));
            const BareRun::Plan p = BareRun::plan(home);
            t.Equals(p.code, 0, "a readable config is a plan");
            t.IsTrue(p.configFound, "and it says it read one");
            t.Equals(p.elf, home / "socom2_game.elf", "the ELF is the one beside it");
            t.Equals(p.logDir, home / "logs", "the log goes where the launcher puts it");
            t.Equals(valueOf(p.environment, "PS2X_CD_IMAGE"), std::string("D:/discs/socom2.iso"), "the verified ISO");
            t.Equals(valueOf(p.environment, "PS2X_GS_SCALE"), std::string("2"), "the render scale");
            t.Equals(valueOf(p.environment, "PS2X_SOCOM2_SERVER"), std::string("198.51.100.5"), "the server");
            t.Equals(valueOf(p.environment, "PS2X_SOCOM2_PAD"), std::string("1"), "the pad, always");
            t.Equals(valueOf(p.environment, "PS2X_PAD_CROUCH_SHORTCUT"), std::string("l3"),
                     "the crouch shortcut (R139): a double-clicked game crouches the way the launcher's does");
            t.Equals(fs::path(valueOf(p.environment, "PS2X_MC_DIR")), (home / "cards" / "viper").lexically_normal(),
                     "cards/<profile> is made absolute against the folder: a double-click promises no working directory");
            std::vector<std::string> theirs = launcher::environmentFor(c);
            t.Equals(p.environment.size(), theirs.size(), "nothing added, nothing dropped relative to environmentFor");
            std::error_code ec;
            fs::remove_all(home, ec);
        });

        // Issue #69: a double-clicked socom2_r0004.exe loaded r0001's socom2_game.elf beside it. The plan now
        // takes the build's own revision (PS2X_GAME_REVISION) and asks the launcher's table for its ELF.
        tc.Run("the bare run plans the build's own revision's ELF (issue #69)", [](TestCase &t)
        {
            const fs::path home = makeHome();
            t.Equals(BareRun::plan(home, "r0004").elf, home / "socom2_game_r0004.elf",
                     "an r0004 build loads r0004's ELF, the name build_revision.sh packages");
            t.Equals(BareRun::plan(home, "r0001").elf, home / "socom2_game.elf", "an r0001 build loads the disc's own");
            t.Equals(BareRun::plan(home).elf, home / "socom2_game.elf", "and plan(home) is r0001's plan");
            t.Equals(BareRun::plan(home, "r0O04").elf, home / "socom2_game.elf", "an unknown revision is r0001, as everywhere");
            std::error_code ec;
            fs::remove_all(home, ec);
        });

        tc.Run("no config.json is the defaults, not an error", [](TestCase &t)
        {
            const fs::path home = makeHome();
            const BareRun::Plan p = BareRun::plan(home);
            t.Equals(p.code, 0, "a stranger who never opened the launcher still gets a run");
            t.IsTrue(!p.configFound, "and the plan says there was no file");
            t.Equals(valueOf(p.environment, "PS2X_CD_IMAGE"), std::string("<absent>"), "no ISO configured: Preflight's *.iso hunt decides");
            t.Equals(valueOf(p.environment, "PS2X_SOCOM2_SERVER"), launcher::effectiveServer(launcher::Config{}), "the default server");
            std::error_code ec;
            fs::remove_all(home, ec);
        });

        tc.Run("69: a config.json that is there and cannot be read", [](TestCase &t)
        {
            const fs::path home = makeHome();
            writeText(home / "config.json", "{ \"isoPath\": \"D:/x.iso\", ");
            BareRun::Plan p = BareRun::plan(home);
            t.Equals(p.code, ExitCodes::kConfigUnreadable, "malformed JSON");
            t.Equals(p.code, 69, "is 69");
            t.IsTrue(p.detail.find("config.json") != std::string::npos, "and the detail names the file");
            t.IsTrue(p.environment.empty(), "no half-read settings reach the environment");
            writeText(home / "config.json", "");
            p = BareRun::plan(home);
            t.Equals(p.code, 69, "an empty file is unreadable too, not 'the defaults'");
            t.Equals(std::string(ExitCodes::find(69)->sentence),
                     std::string("config.json could not be read. Delete it and start the launcher, which writes a new one."), "the sentence the player sees");
            std::error_code ec;
            fs::remove_all(home, ec);
        });

        tc.Run("applyEnvironment sets what is unset and leaves what the caller already chose", [](TestCase &t)
        {
#ifdef _WIN32
            _putenv_s("PS2X_BARE_TEST_KEPT", "theirs");
            _putenv_s("PS2X_BARE_TEST_NEW", "");
#else
            setenv("PS2X_BARE_TEST_KEPT", "theirs", 1);
            unsetenv("PS2X_BARE_TEST_NEW");
#endif
            const int set = BareRun::applyEnvironment({"PS2X_BARE_TEST_KEPT=ours", "PS2X_BARE_TEST_NEW=ours", "not-a-pair"});
            t.Equals(set, 1, "one variable was unset, so one was set; a bare word is skipped");
            t.Equals(std::string(std::getenv("PS2X_BARE_TEST_KEPT")), std::string("theirs"), "the environment wins over config.json");
            const char *fresh = std::getenv("PS2X_BARE_TEST_NEW");
            t.Equals(std::string(fresh ? fresh : ""), std::string("ours"), "config.json fills what was not set");
        });

        tc.Run("the stamp and the executable's folder", [](TestCase &t)
        {
            const std::string s = BareRun::stamp();
            t.Equals(s.size(), static_cast<size_t>(15), "YYYYMMDD_HHMMSS");
            t.IsTrue(s.size() == 15 && s[8] == '_', "with the underscore where the launcher's log names have it");
            t.IsTrue(fs::is_directory(ExeDir::get()), "ExeDir::get() is a directory that exists");
            t.IsTrue(std::string(ExeDir::platformName()) == "windows" || std::string(ExeDir::platformName()) == "linux", "and the platform has a name on both hosts we build on");
#ifdef _WIN32
            const char *self = "ps2x_tests.exe";
#else
            const char *self = "ps2x_tests";
#endif
            t.IsTrue(fs::exists(ExeDir::get() / self), "and it is the one this test binary is in");
        });
    });
}
