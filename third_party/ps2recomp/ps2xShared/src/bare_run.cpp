#include "ps2x/bare_run.h"

#include "launcher/launcher_config.h"

#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <fstream>
#include <sstream>
#include <system_error>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <io.h>
#else
#include <unistd.h>
#endif

namespace BareRun
{
    namespace fs = std::filesystem;

    Plan plan(const fs::path &home)
    {
        return plan(home, "r0001");
    }

    Plan plan(const fs::path &home, const std::string &gameRevision)
    {
#ifdef _WIN32
        const char *const thisBuild = "socom2.exe";
#else
        const char *const thisBuild = "socom2";
#endif
        Plan p;
        p.home = home;
        p.elf = home / launcher::gameFilesFor(gameRevision, thisBuild).elf;   // issue #69: the build's own ELF
        p.logDir = home / "logs";

        launcher::Config config;
        const fs::path configPath = home / "config.json";
        std::error_code ec;
        if (fs::exists(configPath, ec))
        {
            std::ifstream in(configPath, std::ios::binary);
            std::stringstream text;
            if (in.is_open())
                text << in.rdbuf();
            if (!in.is_open() || !launcher::fromJson(text.str(), config))
            {
                p.code = ExitCodes::kConfigUnreadable;
                p.detail = configPath.string();
                return p;
            }
            p.configFound = true;
        }

        p.environment = launcher::environmentFor(config);
        const std::string cardKey = "PS2X_MC_DIR=";
        for (std::string &kv : p.environment)
        {
            if (kv.rfind(cardKey, 0) != 0)
                continue;
            const fs::path value(kv.substr(cardKey.size()));
            if (value.is_relative())
                kv = cardKey + (home / value).lexically_normal().string();
        }
        return p;
    }

    int applyEnvironment(const std::vector<std::string> &keyValues)
    {
        int set = 0;
        for (const std::string &kv : keyValues)
        {
            const size_t eq = kv.find('=');
            if (eq == std::string::npos || eq == 0)
                continue;
            const std::string key = kv.substr(0, eq);
            const std::string value = kv.substr(eq + 1);
            if (std::getenv(key.c_str()) != nullptr)
                continue;   // the caller's environment is the override (spec Goal 3's rule, applied early)
#ifdef _WIN32
            if (_putenv_s(key.c_str(), value.c_str()) == 0)
                ++set;
#else
            if (::setenv(key.c_str(), value.c_str(), 0) == 0)
                ++set;
#endif
        }
        return set;
    }

    std::string stamp()
    {
        const std::time_t now = std::time(nullptr);
        std::tm tm{};
#ifdef _WIN32
        localtime_s(&tm, &now);
#else
        localtime_r(&now, &tm);
#endif
        char buf[32];
        std::strftime(buf, sizeof(buf), "%Y%m%d_%H%M%S", &tm);
        return buf;
    }

    std::string redirectOutput(const fs::path &logDir)
    {
        std::error_code ec;
        fs::create_directories(logDir, ec);
        const std::string path = (logDir / ("run_" + stamp() + ".log")).string();
        std::fprintf(stderr, "socom2: logging to %s\n", path.c_str());
        std::fflush(stdout);
        std::fflush(stderr);
        if (std::freopen(path.c_str(), "w", stdout) == nullptr)
            return {};
#ifdef _WIN32
        _dup2(_fileno(stdout), _fileno(stderr));
#else
        ::dup2(fileno(stdout), fileno(stderr));
#endif
        std::setvbuf(stderr, nullptr, _IONBF, 0);
        return path;
    }

    void detachOwnConsole()
    {
#ifdef _WIN32
        DWORD clients[2];
        if (GetConsoleProcessList(clients, 2) == 1)
            FreeConsole();
#endif
    }
}
