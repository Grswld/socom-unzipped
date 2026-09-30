#pragma once
// The launcher's Win32 pieces, kept away from raylib.h (windows.h redefines Rectangle, CloseWindow, ShowCursor,
// DrawText): the executable's directory, the file dialog, starting socom2.exe with an environment and a log,
// opening a folder in Explorer.
#include "launcher/launcher_config.h"

#include <cstdint>
#include <filesystem>
#include <functional>
#include <string>

namespace win32glue
{
    std::string exeDirectory();
    std::string browseForIso();
    void openFolder(const std::string &path);

    struct GameProcess
    {
        void *process = nullptr;   // HANDLE on Windows; the pid, cast, on POSIX (main.cpp tests it for "a game was started")
        void *log = nullptr;       // HANDLE
        std::string logPath;
        std::string error;
#ifndef _WIN32
        // Sprint 8 Task 4: POSIX has a pid and a file descriptor where Windows has two handles, and
        // running()/exitCode() are const -- so the one reap that can be done is cached here.
        int pid = 0;               // pid_t; 0 = nothing started
        int logFd = -1;
        mutable bool exited = false;
        mutable int status = 0;    // the raw wait(2) status, valid once `exited`
#endif
        bool running() const;
        int exitCode() const;   // Task 1a: the code the game left with (0 while it is still running)
        void close();
    };

    // Starts the chosen GAME VERSION's pair (gameFilesFor: <dir>/socom2.exe <dir>/socom2_game.elf for r0001,
    // <dir>/socom2_r0004.exe <dir>/socom2_game_r0004.elf for r0004) with the config's environment on top of the current one,
    // stdout+stderr to <dir>/logs/run_<stamp>.log. False with `error` set when it cannot.
    bool startGame(const std::string &dir, const launcher::Config &config, GameProcess &out);
    // The persona-card review, finding 5: is a game running from `dir` (any revision's executable in that folder,
    // launcher::isGameImage) -- the headless --create-persona's stand-in for the window's GameProcess::running(),
    // since that process has no game of its own to ask. True with `which` naming the image and its pid. Windows: a
    // Toolhelp snapshot and QueryFullProcessImageNameW; POSIX: /proc/<pid>/exe. A process this user cannot open is
    // not counted.
    bool gameRunningFrom(const std::string &dir, std::string &which);


    // Sprint 8 Goal 9, third pass: the custom title bar. The window keeps the system's borders, snap and
    // shadow -- only the caption is removed (WM_NCCALCSIZE), and WM_NCHITTEST is answered from the launcher's
    // own ui::chromeHitTest through this callback, so the system and the drawing agree by construction.
    //   `hitTest` takes client-area pixels and the client size and returns a ui::ChromeHit as an int.
    using ChromeHitFn = int (*)(int x, int y, int w, int h);
    // True when native chrome was installed (Windows). False elsewhere: the caller then asks raylib for an
    // undecorated window and drags it itself.
    bool installCustomChrome(void *windowHandle, ChromeHitFn hitTest);
    void minimizeWindow();
    void maximizeToggleWindow();
    bool isWindowMaximized();

    std::string stamp();
    void terminate(GameProcess &game);   // kills the game (the launch test)

    // Sprint 10 Q4: the window switch (owner 2026-09-20: "pressing the XBOX or PLAYSTATION button should toggle
    // the launcher focus"). Two halves the measurement in the Q4 plan bounds:
    //
    //   The guide button. raylib (5.5, the GLFW desktop platform) maps GLFW_GAMEPAD_BUTTON_GUIDE to
    //   GAMEPAD_BUTTON_MIDDLE, so it arrives like any button -- WHEN the backend delivers it. Linux does: GLFW
    //   reads evdev and every Xbox/DualShock row of its mapping table carries `guide:b<n>` (BTN_MODE). Windows
    //   does for a DirectInput pad with a mapping row (the PS4/PS5 rows carry `guide:b12`), and does NOT for an
    //   XInput pad: GLFW polls XInputGetState, whose wButtons never carries the guide bit, and its XInput row has
    //   no `guide:` at all. xinput1_4.dll's ordinal 100 (the undocumented XInputGetStateEx, which SDL and every
    //   emulator use) does report it as 0x0400, so the launcher asks that directly, for every XInput user, and
    //   ORs it into the pad's guide. `xinputGuideReadable` says whether the entry point was found (the CONTROLLER
    //   page's status says so when it was not); POSIX answers false to both and leaves the guide to raylib.
    bool xinputGuideReadable();
    bool xinputGuideDown();
    //   The swap. Windows: the launcher's HWND is raylib's GetWindowHandle(); the game's is found by its process
    //   id (EnumWindows). SetForegroundWindow is refused to a process that is not in front unless it attaches its
    //   input queue to the one that is (AttachThreadInput) -- the standard way, and the only one that needs no
    //   change to the game. POSIX: X11 through dlopen (no new link line), both windows found by _NET_WM_PID in
    //   _NET_CLIENT_LIST, the front one read from _NET_ACTIVE_WINDOW and the other asked for with the same
    //   message a pager sends; on Wayland (no X display) it does nothing and says so.
    //   True when the swap was made; false with `why` set otherwise.
    bool toggleForeground(void *launcherWindow, const GameProcess &game, std::string &why);

    // Sprint 9 Goal 8: one blocking HTTP(S) request, for the bug report and the server's status line. Call it
    // off the UI thread. Windows: WinHTTP, certificate validation ON (no SECURITY_FLAG_IGNORE_* is ever set).
    // POSIX: a `curl` subprocess started with an argv (no shell), the body on its stdin; no curl = `error`.
    // Plain http:// is refused unless the host is 127.0.0.1 or localhost (the tests' loopback server).
    struct HttpResult
    {
        int status = 0;          // the HTTP status; 0 when there was no answer
        std::string body;        // the response body, at most 1 MB
        int retryAfter = 0;      // the Retry-After header in seconds, 0 when absent
        std::string error;       // why there was no answer, for the log; empty when status != 0
    };
    HttpResult httpRequest(const std::string &method, const std::string &url, const std::string &body, int timeoutMs);

    // Sprint 16 R2a (#71): one blocking GET streamed to a file, for the r0004 package (1,605,944 bytes -- above
    // httpRequest's 1 MB cap). Call it off the UI thread. No body cap; `userAgent` is sent as given (the package
    // server is asked the way the r0001 client asks it). The body goes to downloadTempPath(dest) and is renamed
    // onto `dest` only when it is complete: HTTP 200, and exactly Content-Length bytes when the server sent one
    // (a shorter body is a failure). On any failure the temporary file is deleted and `dest` is left as it was.
    // Plain http:// is allowed to any host here, unlike httpRequest: the package server speaks only http, and
    // what arrives is checked by size and sha256 (launcher::patchfetch::verifyPackage) before anything reads it.
    // A 3xx is never followed, on either platform: `error` is redirectRefusal(status) (#88 review).
    // Windows: WinHTTP. POSIX: a `curl` subprocess (--output, --fail, --max-time); no curl = `error`.
    struct DownloadResult
    {
        int status = 0;          // the HTTP status; 0 when there was no answer
        uint64_t bytes = 0;      // the bytes written to `dest` (so far, on a failure)
        std::string error;       // why the download failed; empty on success
    };
    // Bytes so far and the Content-Length (-1 when not known: always on POSIX, where curl keeps the header).
    using DownloadProgress = std::function<void(uint64_t bytesSoFar, int64_t contentLength)>;
    DownloadResult httpDownload(const std::string &url, const std::filesystem::path &dest, const std::string &userAgent,
                                int timeoutMs, const DownloadProgress &progress);
    // The one sentence both glues give for a 3xx: "the server answered HTTP 302: redirects are refused".
    inline std::string redirectRefusal(int status)
    {
        return "the server answered HTTP " + std::to_string(status) + ": redirects are refused";
    }
    // "<dest>.part", beside dest: the name the body is written under until it is complete.
    inline std::filesystem::path downloadTempPath(const std::filesystem::path &dest)
    {
        std::filesystem::path temp = dest;
        temp += ".part";
        return temp;
    }
}
