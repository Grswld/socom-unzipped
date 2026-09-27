#include "ps2_runtime.h"
#include "games_database.h"
#if defined(PS2X_ENABLE_DEBUG_UI) && !defined(PLATFORM_VITA)
#include "ps2_debug_panel.h"
#endif

#ifdef _DEBUG
#include "ps2_log.h"
#endif

#include <iostream>
#include <string>
#include <filesystem>
#include <exception>
#include <algorithm>
#include <cstdlib>
#include <cstdio>
#include <cstring>

#include "ps2x/bare_run.h"
#include "ps2x/exe_dir.h"
#include "ps2x/exit_codes.h"
#include "ps2x/host_window.h"
#include "ps2x/knobs.h"
#include "ps2x/preflight.h"
#include "ps2x/process_fatal.h"

#if defined(__ANDROID__)
#include <android/log.h>
#include <unistd.h>
#include <thread>
#include <cstdio>
#include <cstring>
#endif

namespace
{
#if defined(__ANDROID__)
    int g_logcatPipeFds[2]{-1, -1};
    std::thread g_logcatThread;

    void stopLogcatRedirect()
    {
        std::fflush(stdout);
        std::fflush(stderr);
        close(STDOUT_FILENO);
        close(STDERR_FILENO);
        if (g_logcatPipeFds[1] >= 0)
        {
            close(g_logcatPipeFds[1]);
            g_logcatPipeFds[1] = -1;
        }
        if (g_logcatThread.joinable())
        {
            g_logcatThread.join();
        }
    }

    void redirectStdioToLogcat()
    {
        if (pipe(g_logcatPipeFds) != 0)
        {
            return;
        }

        setvbuf(stdout, nullptr, _IOLBF, 0);
        setvbuf(stderr, nullptr, _IONBF, 0);
        dup2(g_logcatPipeFds[1], STDOUT_FILENO);
        dup2(g_logcatPipeFds[1], STDERR_FILENO);

        g_logcatThread = std::thread([]()
                                     {
                                         FILE *reader = fdopen(g_logcatPipeFds[0], "r");
                                         if (!reader)
                                         {
                                             return;
                                         }
                                         char line[1024];
                                         while (fgets(line, sizeof(line), reader))
                                         {
                                             size_t len = std::strlen(line);
                                             if (len > 0 && line[len - 1] == '\n')
                                             {
                                                 line[len - 1] = '\0';
                                             }
                                             __android_log_write(ANDROID_LOG_INFO, "ps2x", line);
                                         }
                                         fclose(reader);
                                         g_logcatPipeFds[0] = -1;
                                     });
        if (std::atexit(stopLogcatRedirect) != 0)
        {
            close(STDOUT_FILENO);
            close(STDERR_FILENO);
            close(g_logcatPipeFds[1]);
            g_logcatPipeFds[1] = -1;
            if (g_logcatThread.joinable())
            {
                g_logcatThread.join();
            }
        }
    }
#endif

    void setupTerminateLogger() // to help on release build crashs
    {
        std::set_terminate([]()
                           {
                               std::cerr << "[terminate] unhandled exception" << std::endl;
                               const std::exception_ptr ep = std::current_exception();
                               if (ep)
                               {
                                   try
                                   {
                                       std::rethrow_exception(ep);
                                   }
                                   catch (const std::system_error &e)
                                   {
                                       std::cerr << "[terminate] std::system_error code=" << e.code().value()
                                                 << " category=" << e.code().category().name()
                                                 << " message=" << e.what() << std::endl;
                                   }
                                   catch (const std::exception &e)
                                   {
                                       std::cerr << "[terminate] std::exception: " << e.what() << std::endl;
                                   }
                                   catch (...)
                                   {
                                       std::cerr << "[terminate] non-std exception" << std::endl;
                                   }
                               }
                               std::abort(); });
    }

    std::string normalizeGameId(const std::string &folderName)
    {
        std::string result = folderName;

        size_t underscore = result.find('_');
        if (underscore != std::string::npos)
            result[underscore] = '-';

        size_t dot = result.find('.');
        if (dot != std::string::npos)
            result.erase(dot, 1);

        std::ranges::transform(result, result.begin(), [](unsigned char character)
                               { return static_cast<char>(std::toupper(character)); });

        return result;
    }

    std::filesystem::path getExecutablePath(int argc, char *argv[])
    {
        if (argc >= 2 && argv[1] && argv[1][0] != '\0')
        {
            std::cout << "Using argv boot path" << std::endl;
            return std::filesystem::path(argv[1]);
        }
#if defined(PS2X_DEFAULT_BOOT_ELF)
        std::cout << "Using default boot file" << std::endl;
        const std::filesystem::path configuredPath = std::filesystem::path(PS2X_DEFAULT_BOOT_ELF);
#if defined(PLATFORM_VITA)
        return configuredPath;
#endif
        if (configuredPath.is_absolute())
        {
            return configuredPath;
        }
        return (std::filesystem::current_path() / configuredPath).lexically_normal();
#else
        throw std::runtime_error("Unable to determine executable path. Pass the guest ELF as argv[1] or define PS2X_DEFAULT_BOOT_ELF.");
#endif
    }

    // Sprint 9 Goal 1: every early ending goes through here -- one log line in Preflight's shape, then
    // the code. _Exit, as the end of main() does: no static destructors race the runtime's threads.
    [[noreturn]] void leaveWith(int code, const std::string &detail)
    {
        Preflight::Result result;
        result.code = code;
        result.detail = detail;
        std::cout.flush();
        std::cerr << Preflight::logLine(result) << std::endl;
        std::cerr.flush();
        // _Exit flushes nothing: a bare run's stdout is a fully buffered file (BareRun::redirectOutput).
        std::fflush(stdout);
        std::fflush(stderr);
        std::_Exit(code);
    }
}

int main(int argc, char *argv[])
{
#if defined(__ANDROID__)
    redirectStdioToLogcat();
#endif
    setupTerminateLogger();
    // Sprint 9 Goal 1: running out of memory is exit 71 with a sentence, from whichever thread it happens on.
    ProcessFatal::installOutOfMemoryHandler();

    // Sprint 9 Goal 3: --dev, anywhere after argv[0], is developer mode (the same as PS2X_DEV=1): Dev-class
    // knobs are honoured. Taken out of argv here, before anything below looks at argv[1].
    if (ps2x::knobs::consumeDevFlag(argc, argv))
        ps2x::knobs::setDevMode(true);

    // socom2 --fail-test crash|oom: drives codes 70 and 71 for tools_py/tests/test_runner_exit_codes.py.
    if (argc > 2 && std::strcmp(argv[1], "--fail-test") == 0)
    {
        const int code = ProcessFatal::failTest(argv[2]);
        std::_Exit(code);
    }

    try
    {
        std::filesystem::path pathObj;
#if !defined(PS2X_DEFAULT_BOOT_ELF) && !defined(PLATFORM_VITA) && !defined(__ANDROID__)
        // The bare run: no argument (a double-click), or --home <dir> (the same, as if the executable lived
        // in <dir>). The launcher's config.json beside it becomes the environment -- only where the
        // environment has not already chosen -- and the output goes where the launcher would have put it.
        const bool homeArg = argc > 2 && std::strcmp(argv[1], "--home") == 0;
        if (argc < 2 || homeArg)
        {
            std::filesystem::path home = homeArg ? std::filesystem::path(argv[2]) : ExeDir::get();
            {
                // BareRun::plan makes the card folder absolute by joining it to home, and the process
                // changes directory below: a relative --home must be pinned first.
                std::error_code homeEc;
                const std::filesystem::path pinned = std::filesystem::absolute(home, homeEc);
                if (!homeEc && !pinned.empty())
                    home = pinned;
            }
            const BareRun::Plan plan = BareRun::plan(home);
            BareRun::redirectOutput(plan.logDir);
            if (!homeArg)
                BareRun::detachOwnConsole();
            std::cout << "[bare-run] home " << plan.home.string() << ", config.json "
                      << (plan.configFound ? "read" : (plan.code == ExitCodes::kOk ? "absent: the defaults" : "unreadable")) << std::endl;
            if (plan.code != ExitCodes::kOk)
                leaveWith(plan.code, plan.detail);
            const int applied = BareRun::applyEnvironment(plan.environment);
            std::cout << "[bare-run] " << applied << " of " << plan.environment.size()
                      << " settings taken from config.json (the rest were already in the environment)" << std::endl;
            std::error_code cwdEc;
            std::filesystem::current_path(plan.home, cwdEc);   // what both launcher glues give the child
            pathObj = plan.elf;
        }
        else
#endif
        {
            pathObj = getExecutablePath(argc, argv);
        }

        // One line, so a bug report says which knobs were in effect and which were ignored (docs/KNOBS.md).
        std::cout << ps2x::knobs::startupLine() << std::endl;

#if !defined(PLATFORM_VITA) && !defined(__ANDROID__)
        // Before a window exists: the ELF, the card folder, the disc, and that the disc is r0001 (R130).
        {
            Preflight::Input pre;
            pre.elfPath = pathObj;
            // The same rule as configureCdImage (game_overrides_socom2.cpp): an empty value is unset.
            if (const char *cd = ps2x::knob("PS2X_CD_IMAGE"); cd != nullptr && *cd != '\0')
                pre.cdImageEnv = cd;
            std::error_code absEc;
            const char *mc = ps2x::knob("PS2X_MC_DIR");   // the same rule as PS2Runtime::configureIoPathsFromElf
            pre.cardDir = (mc != nullptr && *mc != '\0')
                              ? std::filesystem::absolute(std::filesystem::path(mc), absEc)
                              : std::filesystem::absolute(pathObj, absEc).parent_path() / "mc0";
            pre.checkDisc = pathObj.filename() == "socom2_game.elf";   // the override's own key (PS2_REGISTER_GAME_OVERRIDE, game_overrides_socom2.cpp)
            const Preflight::Result checked = Preflight::run(pre);
            if (checked.code != ExitCodes::kOk)
                leaveWith(checked.code, checked.detail);
            if (!checked.disc.empty())
                std::cout << "[preflight] ok: " << checked.disc.lexically_normal().string() << " is SOCOM II NTSC r0001" << std::endl;
        }
#endif

        std::string filePathStr = pathObj.string();
        std::string elfName = pathObj.filename().string();
        std::string normalizedId = normalizeGameId(elfName);

        // Sprint 10 Q4: "<game> -- SOCOM Unzipped" (ps2x/host_window.h), the launcher's name on the game's
        // window. It was "PS2-Recomp | <elf>" -- the harness's key moved with it (keys.py, pinned by
        // test_host_window_title.py). PS2X_WINDOW_TITLE=tag still goes in front: a second instance's window
        // is found by its tag, as it always was.
        const char *gameName = getGameName(normalizedId);
#if defined(PLATFORM_VITA)
        gameName = nullptr;
#endif
        const std::string windowTitle = ps2x::host_window::title(ps2x::knob("PS2X_WINDOW_TITLE"), gameName, elfName);

        PS2Runtime runtime;
#if defined(PS2X_ENABLE_DEBUG_UI) && !defined(PLATFORM_VITA)
        // This hook is to prevent leak rlimgui deps to recompiler etc
        PS2DebugPanel debugPanel;
        runtime.setDebugUiCallbacks(
            [](PS2Runtime &rt, void *userData)
            {
                (void)rt;
                static_cast<PS2DebugPanel *>(userData)->initialize();
            },
            [](PS2Runtime &rt, void *userData)
            {
                static_cast<PS2DebugPanel *>(userData)->draw(rt);
            },
            [](PS2Runtime &rt, void *userData)
            {
                (void)rt;
                static_cast<PS2DebugPanel *>(userData)->shutdown();
            },
            &debugPanel);
#endif
        if (!runtime.initialize(windowTitle.c_str()))
        {
            std::cerr << "Failed to initialize PS2 runtime" << std::endl;
            leaveWith(ExitCodes::kFailed, "PS2Runtime::initialize");
        }

        if (!runtime.loadELF(filePathStr))
        {
            std::cerr << "Failed to load ELF file: " << filePathStr << std::endl;
            leaveWith(ExitCodes::kElfMissing, filePathStr);
        }

        runtime.run();

#ifdef _DEBUG
        ps2_log::print_saved_location();
#endif
        std::cout.flush();
        std::cerr.flush();
        // Task 1a: 0 normally; 65 when the GL probe fell back to the CPU rasterizer.
        std::_Exit(ps2ProcessExitCode());
    }
    catch (const std::exception &e)
    {
        std::cerr << "[main] fatal exception: " << e.what() << std::endl;
    }
    catch (...)
    {
        std::cerr << "[main] fatal exception: unknown" << std::endl;
    }

    std::cout.flush();
    std::cerr.flush();
    std::_Exit(ExitCodes::kFailed);
}
