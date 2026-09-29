// The launcher's Unix half of the win32glue interface (Sprint 8 Tasks 1 and 4).
//
// The same interface win32_glue.cpp implements on Windows, with the POSIX pieces: /proc/self/exe for the
// executable's directory, posix_spawn with file actions for the game (the log on fd 1 and 2, the working
// directory the launcher's own), waitpid on the pid for running/exitCode/close/terminate, zenity for the
// file dialog and xdg-open for the folder.
//
// The name win32glue stays: one header, one interface, two implementations.
//
// glibc note: posix_spawn_file_actions_addchdir_np is a GNU extension present since glibc 2.29. Ubuntu 24.04
// (the CI image and the VM) ships glibc 2.39, so it is used directly rather than through a fork/chdir/exec
// hand-rolled spawn. A libc without it will not compile this file; that is deliberate and visible.
#ifndef _WIN32

#include "win32_glue.h"
#include "ps2x/knobs.h"

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <filesystem>
#include <string>
#include <vector>

#include <dlfcn.h>      // Sprint 10 Q4: libX11 by hand, for the window switch
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

// Q4: the X11 types and atoms only (the library itself is dlopen'd above). The headers are on every machine
// that can build raylib's X11 platform, which the Linux client is (GLFW_BUILD_X11).
#if defined(__linux__)
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#endif

extern char **environ;

namespace fs = std::filesystem;

namespace
{
    // Is `name` an executable file in one of PATH's directories? access(2) over the entries, so no shell
    // is started merely to find out whether a program exists.
    bool onPath(const char *name)
    {
        const char *path = std::getenv("PATH");
        if (path == nullptr || *path == '\0')
            return false;
        const std::string all(path);
        size_t at = 0;
        while (at <= all.size())
        {
            const size_t sep = all.find(':', at);
            const std::string dir = all.substr(at, sep == std::string::npos ? std::string::npos : sep - at);
            // An empty PATH entry means the current directory, as the shell reads it.
            const std::string candidate = (dir.empty() ? std::string(".") : dir) + "/" + name;
            if (::access(candidate.c_str(), X_OK) == 0)
                return true;
            if (sep == std::string::npos)
                break;
            at = sep + 1;
        }
        return false;
    }

    std::string trimmed(std::string s)
    {
        const char *ws = " \t\r\n";
        const size_t first = s.find_first_not_of(ws);
        if (first == std::string::npos)
            return {};
        const size_t last = s.find_last_not_of(ws);
        return s.substr(first, last - first + 1);
    }

    // waitpid(WNOHANG) once, caching the status the first time it is reaped. True while the child is still
    // running. Safe to call after the child is gone (ECHILD reads as "not running").
    bool pollChild(int pid, bool &exited, int &status)
    {
        if (pid <= 0 || exited)
            return false;
        int raw = 0;
        const pid_t r = ::waitpid(static_cast<pid_t>(pid), &raw, WNOHANG);
        if (r == 0)
            return true;   // still alive
        if (r > 0)
            status = raw;
        // r < 0 (ECHILD, or an interrupted call that will not come back better): nothing left to wait for.
        exited = true;
        return false;
    }

    void sleepMs(long ms)
    {
        struct timespec ts;
        ts.tv_sec = ms / 1000;
        ts.tv_nsec = (ms % 1000) * 1000000L;
        while (::nanosleep(&ts, &ts) == -1 && errno == EINTR)
        {
        }
    }
}

namespace win32glue
{
    std::string exeDirectory()
    {
        char buf[4096];
        const ssize_t n = ::readlink("/proc/self/exe", buf, sizeof(buf) - 1);
        if (n > 0 && static_cast<size_t>(n) < sizeof(buf))
        {
            buf[n] = '\0';
            return fs::path(buf).parent_path().string();
        }
        // No /proc (a container without it, a BSD): the same fallback the Windows file uses when
        // GetModuleFileNameW fails.
        return fs::current_path().string();
    }

    std::string browseForIso()
    {
        // Empty means "keep what was typed" -- so a desktop without zenity is not a dead end: the ISO field
        // accepts a typed path, which is what the empty return leaves in place.
        if (!onPath("zenity"))
            return {};
        // zenity prints the chosen path on stdout and exits 1 on Cancel. The whole command is a literal:
        // nothing the player typed reaches it, so there is nothing here for the shell to expand.
        FILE *pipe = ::popen("zenity --file-selection --title='Choose the SOCOM II ISO' "
                             "--file-filter='Disc images | *.iso *.ISO' --file-filter='All files | *' 2>/dev/null",
                             "r");
        if (pipe == nullptr)
            return {};
        char line[4096] = {};
        const char *got = std::fgets(line, sizeof(line), pipe);
        const int rc = ::pclose(pipe);
        if (got == nullptr || rc != 0)
            return {};   // Cancel, or zenity could not open a display
        return trimmed(line);
    }

    void openFolder(const std::string &path)
    {
        if (path.empty())
            return;
        // Detached, so the launcher never collects a zombie and never blocks: fork once, spawn xdg-open from
        // the intermediate child and let it exit immediately, which reparents xdg-open to init. The parent
        // reaps only the intermediate, which is already gone.
        const pid_t middle = ::fork();
        if (middle < 0)
            return;
        if (middle == 0)
        {
            pid_t child = 0;
            char *argv[] = {const_cast<char *>("xdg-open"), const_cast<char *>(path.c_str()), nullptr};
            ::posix_spawnp(&child, "xdg-open", nullptr, nullptr, argv, environ);
            ::_exit(0);
        }
        int ignored = 0;
        ::waitpid(middle, &ignored, 0);
    }

    // Sprint 8 Goal 9, third pass: X11/Wayland have no equivalent of the Windows caption trick, and this
    // file must stay free of raylib (the tests link it without one). So: no native chrome here -- main.cpp
    // asks raylib for an undecorated window and moves it itself when the drag region is held.
    bool installCustomChrome(void *, ChromeHitFn) { return false; }
    void minimizeWindow() {}
    void maximizeToggleWindow() {}
    bool isWindowMaximized() { return false; }

    std::string stamp()
    {
        char buf[32];
        const std::time_t t = std::time(nullptr);
        std::tm tm{};
        localtime_r(&t, &tm);
        std::strftime(buf, sizeof(buf), "%Y%m%d_%H%M%S", &tm);
        return buf;
    }

    bool GameProcess::running() const
    {
        return pollChild(pid, exited, status);
    }

    int GameProcess::exitCode() const
    {
        if (pid <= 0)
            return 0;
        if (!exited && pollChild(pid, exited, status))
            return 0;   // still running: 0, as the Windows side answers for STILL_ACTIVE
        if (!exited)
            return 0;
        if (WIFEXITED(status))
            return WEXITSTATUS(status);
        if (WIFSIGNALED(status))
            return 128 + WTERMSIG(status);   // the shell's convention, so a SIGSEGV reads as 139
        return 0;
    }

    void GameProcess::close()
    {
        // F9: this used to poll once with WNOHANG and then clear the pid, which ABANDONS a game that
        // is still running -- the launcher drops the only handle it has, so nothing can stop the
        // child, its exit status is never collected (a zombie until the launcher itself exits), and
        // the player is left with an idle launcher while the game still owns the screen and the pad.
        // A child that has not exited is ended the way terminate() ends one -- SIGTERM, two seconds
        // to flush its log, then SIGKILL -- and reaped before the pid is dropped.
        if (pollChild(pid, exited, status))
            terminate(*this);
        if (logFd >= 0)
            ::close(logFd);
        logFd = -1;
        pid = 0;
        exited = false;
        status = 0;
        process = nullptr;
        log = nullptr;
    }

    bool gameRunningFrom(const std::string &dir, std::string &which)
    {
        // /proc/<pid>/exe of every process this user can read (another user's is unreadable, and is not one the
        // launcher started from this folder).
        which.clear();
        std::error_code ec;
        const std::string home = fs::absolute(fs::path(dir), ec).string();
        fs::directory_iterator it(fs::path("/proc"), fs::directory_options::skip_permission_denied, ec);
        for (; !ec && it != fs::directory_iterator() && which.empty(); it.increment(ec))
        {
            const std::string pid = it->path().filename().string();
            if (pid.empty() || !std::all_of(pid.begin(), pid.end(), [](char c) { return c >= '0' && c <= '9'; }))
                continue;
            std::error_code linkEc;
            const fs::path image = fs::read_symlink(it->path() / "exe", linkEc);
            if (!linkEc && launcher::isGameImage(home, image.string(), "socom2"))
                which = image.string() + " (pid " + pid + ")";
        }
        return !which.empty();
    }

    bool startGame(const std::string &dirStr, const launcher::Config &config, GameProcess &out)
    {
        out.error.clear();
        const fs::path dir(dirStr);
        // Issue #69: the chosen GAME VERSION's own pair, not socom2 + socom2_game.elf whatever it said.
        const launcher::GameFiles files = launcher::gameFilesFor(config.gameRevision, "socom2");   // no .exe here
        const fs::path exe = dir / files.exe;
        const fs::path elf = dir / files.elf;
        if (!fs::exists(exe))
        {
            out.error = files.exe + " is not next to the launcher (" + exe.string() + ")";
            return false;
        }
        if (!fs::exists(elf))
        {
            out.error = files.elf + " is not next to the launcher (" + elf.string() + ")";
            return false;
        }
        std::error_code ec;
        fs::create_directories(dir / "logs", ec);
        fs::create_directories(dir / "cards", ec);

        // The environment: this process's block plus our knobs, ours winning by key -- the same pure rule
        // the Windows glue applies to its own block. Sprint 9 Goal 3 (R156): an inherited PS2X_* variable
        // reaches the game only when this launcher was itself started in developer mode (PS2X_DEV=1).
        const std::vector<std::string> merged = launcher::mergeEnvironment(environ, launcher::environmentFor(config), ps2x::knobs::devMode());
        std::vector<char *> envp;
        envp.reserve(merged.size() + 1);
        for (const std::string &kv : merged)
            envp.push_back(const_cast<char *>(kv.c_str()));
        envp.push_back(nullptr);

        out.logPath = (dir / "logs" / ("run_" + stamp() + ".log")).string();
        // F9: O_CLOEXEC. The spawn dup2s this descriptor onto the child's 1 and 2, and dup2 clears
        // close-on-exec on the copies, so the game still writes its log -- but the descriptor itself
        // no longer leaks into every other process the launcher starts, where it would pin the log
        // file open long after close().
        const int logFd = ::open(out.logPath.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
        if (logFd < 0)
        {
            out.error = "cannot create the log file (" + std::string(std::strerror(errno)) + ")";
            return false;
        }

        posix_spawn_file_actions_t actions;
        if (::posix_spawn_file_actions_init(&actions) != 0)
        {
            ::close(logFd);
            out.error = "cannot prepare the child's file actions";
            return false;
        }
        // stdout and stderr to the log, stdin left as the launcher's; then the child's working directory is
        // the launcher's folder, which is what makes the runner's relative paths (cards/, the ISO beside it)
        // resolve the way they do on Windows. addchdir_np is glibc >= 2.29; Ubuntu 24.04 has 2.39.
        ::posix_spawn_file_actions_adddup2(&actions, logFd, STDOUT_FILENO);
        ::posix_spawn_file_actions_adddup2(&actions, logFd, STDERR_FILENO);
        ::posix_spawn_file_actions_addchdir_np(&actions, dir.c_str());

        const std::string exePath = exe.string();
        const std::string elfPath = elf.string();
        char *argv[] = {const_cast<char *>(exePath.c_str()), const_cast<char *>(elfPath.c_str()), nullptr};

        pid_t child = 0;
        const int rc = ::posix_spawn(&child, exePath.c_str(), &actions, nullptr, argv, envp.data());
        ::posix_spawn_file_actions_destroy(&actions);
        if (rc != 0)
        {
            ::close(logFd);
            out.error = "posix_spawn failed (" + std::string(std::strerror(rc)) + ")";
            return false;
        }

        out.pid = static_cast<int>(child);
        out.logFd = logFd;
        out.exited = false;
        out.status = 0;
        // main.cpp reads `process` as "a game was started"; on POSIX the pid carries that.
        out.process = reinterpret_cast<void *>(static_cast<std::intptr_t>(child));
        out.log = reinterpret_cast<void *>(static_cast<std::intptr_t>(logFd + 1));
        return true;
    }

    void terminate(GameProcess &game)
    {
        if (game.pid <= 0 || game.exited)
            return;
        ::kill(static_cast<pid_t>(game.pid), SIGTERM);
        // Two seconds to leave on its own terms (the runner flushes its log on SIGTERM), then SIGKILL.
        for (int i = 0; i < 20; ++i)
        {
            if (!pollChild(game.pid, game.exited, game.status))
                return;
            sleepMs(100);
        }
        ::kill(static_cast<pid_t>(game.pid), SIGKILL);
        int raw = 0;
        if (::waitpid(static_cast<pid_t>(game.pid), &raw, 0) > 0)
            game.status = raw;
        game.exited = true;
    }

    // ---- Sprint 10 Q4: the window switch ------------------------------------------------------------------
    // The guide button needs nothing here: GLFW reads evdev's BTN_MODE and its Linux mapping rows carry it, so
    // raylib's GAMEPAD_BUTTON_MIDDLE is the button. The swap is X11 (EWMH), through dlopen so the link line and
    // the portable folder's lib/ closure do not change: both windows are found by _NET_WM_PID in the root's
    // _NET_CLIENT_LIST (raylib's GetWindowHandle is the GLFWwindow* on Linux, not the X window), the one in
    // front is _NET_ACTIVE_WINDOW, and the other is asked for with the ClientMessage a pager sends (source 2),
    // which focus-stealing prevention honours where an application's own request (source 1) may be refused.
    // Wayland has no X display to open: the switch then does nothing and says so.
    bool xinputGuideReadable() { return false; }
    bool xinputGuideDown() { return false; }

#if !defined(__linux__)
    bool toggleForeground(void *, const GameProcess &, std::string &why)
    {
        why = "the window switch is Linux (X11) only in this build";
        return false;
    }
#else
    namespace
    {
        struct X11
        {
            void *lib = nullptr;
            Display *(*openDisplay)(const char *) = nullptr;
            int (*closeDisplay)(Display *) = nullptr;
            Atom (*internAtom)(Display *, const char *, int) = nullptr;
            int (*getWindowProperty)(Display *, Window, Atom, long, long, int, Atom, Atom *, int *, unsigned long *,
                                     unsigned long *, unsigned char **) = nullptr;
            int (*free)(void *) = nullptr;
            int (*sendEvent)(Display *, Window, int, long, XEvent *) = nullptr;
            int (*flush)(Display *) = nullptr;

            bool load()
            {
                if (lib != nullptr)
                    return true;
                lib = dlopen("libX11.so.6", RTLD_NOW);
                if (lib == nullptr)
                    return false;
                auto sym = [&](const char *name) { return dlsym(lib, name); };
                openDisplay = reinterpret_cast<Display *(*)(const char *)>(sym("XOpenDisplay"));
                closeDisplay = reinterpret_cast<int (*)(Display *)>(sym("XCloseDisplay"));
                internAtom = reinterpret_cast<Atom (*)(Display *, const char *, int)>(sym("XInternAtom"));
                getWindowProperty = reinterpret_cast<int (*)(Display *, Window, Atom, long, long, int, Atom, Atom *, int *,
                                                             unsigned long *, unsigned long *, unsigned char **)>(sym("XGetWindowProperty"));
                free = reinterpret_cast<int (*)(void *)>(sym("XFree"));
                sendEvent = reinterpret_cast<int (*)(Display *, Window, int, long, XEvent *)>(sym("XSendEvent"));
                flush = reinterpret_cast<int (*)(Display *)>(sym("XFlush"));
                return openDisplay && closeDisplay && internAtom && getWindowProperty && free && sendEvent && flush;
            }

            // A 32-bit-format property as longs (Xlib hands 32-bit items back as C longs).
            std::vector<unsigned long> longs(Display *dpy, Window w, Atom prop, Atom type)
            {
                std::vector<unsigned long> out;
                Atom actualType = 0;
                int actualFormat = 0;
                unsigned long count = 0, after = 0;
                unsigned char *data = nullptr;
                if (getWindowProperty(dpy, w, prop, 0, 4096, 0, type, &actualType, &actualFormat, &count, &after, &data) != 0 || data == nullptr)
                    return out;
                if (actualFormat == 32)
                    out.assign(reinterpret_cast<unsigned long *>(data), reinterpret_cast<unsigned long *>(data) + count);
                free(data);
                return out;
            }
        };
        X11 g_x11;
    }

    bool toggleForeground(void *launcherWindow, const GameProcess &game, std::string &why)
    {
        (void)launcherWindow;
        if (game.pid <= 0 || game.exited)
        {
            why = "no game window to switch to";
            return false;
        }
        if (!g_x11.load())
        {
            why = "libX11 is not available (Wayland?): the window switch needs an X display";
            return false;
        }
        Display *dpy = g_x11.openDisplay(nullptr);
        if (dpy == nullptr)
        {
            why = "no X display: the window switch needs one";
            return false;
        }
        const Window root = DefaultRootWindow(dpy);
        const Atom clientList = g_x11.internAtom(dpy, "_NET_CLIENT_LIST", 0);
        const Atom wmPid = g_x11.internAtom(dpy, "_NET_WM_PID", 0);
        const Atom activeWindow = g_x11.internAtom(dpy, "_NET_ACTIVE_WINDOW", 0);
        Window mine = 0, theirs = 0;
        const unsigned long myPid = static_cast<unsigned long>(::getpid());
        for (const unsigned long w : g_x11.longs(dpy, root, clientList, XA_WINDOW))
        {
            const std::vector<unsigned long> pid = g_x11.longs(dpy, static_cast<Window>(w), wmPid, XA_CARDINAL);
            if (pid.empty())
                continue;
            if (pid[0] == myPid && mine == 0)
                mine = static_cast<Window>(w);
            else if (pid[0] == static_cast<unsigned long>(game.pid) && theirs == 0)
                theirs = static_cast<Window>(w);
        }
        bool ok = false;
        if (mine == 0 || theirs == 0)
        {
            why = theirs == 0 ? "the game has no window yet" : "the launcher's own window was not found";
        }
        else
        {
            const std::vector<unsigned long> active = g_x11.longs(dpy, root, activeWindow, XA_WINDOW);
            const Window front = active.empty() ? 0 : static_cast<Window>(active[0]);
            const Window target = front == mine ? theirs : mine;
            XEvent ev{};
            ev.xclient.type = ClientMessage;
            ev.xclient.window = target;
            ev.xclient.message_type = activeWindow;
            ev.xclient.format = 32;
            ev.xclient.data.l[0] = 2;   // source: a pager -- the request focus-stealing prevention honours
            ev.xclient.data.l[1] = 0;   // CurrentTime
            ev.xclient.data.l[2] = static_cast<long>(front);
            ok = g_x11.sendEvent(dpy, root, 0, SubstructureRedirectMask | SubstructureNotifyMask, &ev) != 0;
            g_x11.flush(dpy);
            if (!ok)
                why = "the window manager did not take the request";
        }
        g_x11.closeDisplay(dpy);
        return ok;
    }
#endif

    // ---- Sprint 9 Goal 8: one HTTPS request (the bug report, the server's status line) ---------------------
    // No TLS library is vendored: the request is `curl`, started with an argv (posix_spawnp -- no shell, so
    // nothing the player typed is ever interpreted), the body on its stdin, certificate checks at curl's
    // default (ON: there is no -k here). stdout carries the response headers, the body, and a last line
    // from -w with the status. A machine without curl gets `error` and the report is saved to disk instead.
    HttpResult httpRequest(const std::string &method, const std::string &url, const std::string &body, int timeoutMs)
    {
        HttpResult out;
        const bool secure = url.rfind("https://", 0) == 0;
        const bool loopback = url.rfind("http://127.0.0.1:", 0) == 0 || url.rfind("http://localhost:", 0) == 0;
        if (!secure && !loopback)
        {
            out.error = "plain http is refused for anything but a loopback test server";
            return out;
        }
        if (!onPath("curl"))
        {
            out.error = "curl is not installed, so nothing can be sent from here";
            return out;
        }

        int toChild[2] = {-1, -1}, fromChild[2] = {-1, -1};
        if (::pipe2(toChild, O_CLOEXEC) != 0)
        {
            out.error = "pipe failed";
            return out;
        }
        if (::pipe2(fromChild, O_CLOEXEC) != 0)
        {
            ::close(toChild[0]);
            ::close(toChild[1]);
            out.error = "pipe failed";
            return out;
        }

        const int seconds = timeoutMs > 0 ? (timeoutMs + 999) / 1000 : 15;
        const std::string maxTime = std::to_string(seconds);
        std::vector<std::string> args = {"curl", "--silent", "--show-error", "--fail-with-body", "--max-time", maxTime,
                                         "--proto", "=http,https", "--max-filesize", "1048576",
                                         "--request", method, "--dump-header", "-", "--write-out", "\n%{http_code}"};
        if (!body.empty())
        {
            args.insert(args.end(), {"--header", "Content-Type: application/json", "--header", "Expect:", "--data-binary", "@-"});
        }
        args.push_back("--");
        args.push_back(url);
        std::vector<char *> argv;
        for (std::string &a : args)
            argv.push_back(a.data());
        argv.push_back(nullptr);

        posix_spawn_file_actions_t actions;
        ::posix_spawn_file_actions_init(&actions);
        ::posix_spawn_file_actions_adddup2(&actions, toChild[0], STDIN_FILENO);
        ::posix_spawn_file_actions_adddup2(&actions, fromChild[1], STDOUT_FILENO);
        ::posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0);
        pid_t child = 0;
        const int rc = ::posix_spawnp(&child, "curl", &actions, nullptr, argv.data(), environ);
        ::posix_spawn_file_actions_destroy(&actions);
        ::close(toChild[0]);
        ::close(fromChild[1]);
        if (rc != 0)
        {
            ::close(toChild[1]);
            ::close(fromChild[0]);
            out.error = "curl could not be started (" + std::string(std::strerror(rc)) + ")";
            return out;
        }

        // The body goes in whole before anything is read back: curl reads all of stdin before it answers.
        // A curl that died early closes the pipe; MSG_NOSIGNAL has no equivalent for pipes, so SIGPIPE is
        // blocked on this thread for the duration of the write and any pending one is consumed.
        sigset_t pipeSet, oldSet;
        sigemptyset(&pipeSet);
        sigaddset(&pipeSet, SIGPIPE);
        ::pthread_sigmask(SIG_BLOCK, &pipeSet, &oldSet);
        size_t sent = 0;
        while (sent < body.size())
        {
            const ssize_t n = ::write(toChild[1], body.data() + sent, body.size() - sent);
            if (n < 0 && errno == EINTR)
                continue;
            if (n <= 0)
                break;
            sent += static_cast<size_t>(n);
        }
        ::close(toChild[1]);
        {
            const struct timespec none = {0, 0};
            while (::sigtimedwait(&pipeSet, nullptr, &none) > 0)
            {
            }
        }
        ::pthread_sigmask(SIG_SETMASK, &oldSet, nullptr);

        std::string raw;
        char buf[4096];
        for (;;)
        {
            const ssize_t n = ::read(fromChild[0], buf, sizeof(buf));
            if (n < 0 && errno == EINTR)
                continue;
            if (n <= 0)
                break;
            raw.append(buf, static_cast<size_t>(n));
            if (raw.size() > 2u * 1024u * 1024u)
                break;
        }
        ::close(fromChild[0]);
        int status = 0;
        while (::waitpid(child, &status, 0) < 0 && errno == EINTR)
        {
        }

        // The last line is -w's status; before it, one header block per response (a proxy's "200 Connection
        // established" comes first), then the body.
        const size_t lastLine = raw.rfind('\n');
        const int code = lastLine == std::string::npos ? 0 : std::atoi(raw.c_str() + lastLine + 1);
        std::string rest = lastLine == std::string::npos ? std::string() : raw.substr(0, lastLine);
        std::string headers;
        while (rest.rfind("HTTP/", 0) == 0)
        {
            size_t end = rest.find("\r\n\r\n");
            size_t skip = 4;
            if (end == std::string::npos)
            {
                end = rest.find("\n\n");
                skip = 2;
            }
            if (end == std::string::npos)
                break;
            headers = rest.substr(0, end + skip);
            rest.erase(0, end + skip);
        }
        if (code <= 0)
        {
            const int exitCode = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
            out.error = "curl exited with " + std::to_string(exitCode) + " and no answer (6 = no such host, 7 = refused, "
                        "28 = timed out, 60 = the certificate was not trusted)";
            return out;
        }
        out.status = code;
        out.body = rest;
        for (size_t at = 0; at < headers.size();)
        {
            size_t end = headers.find('\n', at);
            if (end == std::string::npos)
                end = headers.size();
            std::string line = headers.substr(at, end - at);
            at = end + 1;
            for (char &c : line)
                c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
            if (line.rfind("retry-after:", 0) == 0)
            {
                const long secondsToWait = std::atol(line.c_str() + 12);
                out.retryAfter = secondsToWait > 0 && secondsToWait < 7 * 24 * 3600 ? static_cast<int>(secondsToWait) : 0;
            }
        }
        return out;
    }

    // ---- Sprint 16 R2a (#71): one streamed download to a file (the r0004 package) ---------------------------
    // `curl` again, started with an argv (no shell): --output to the temporary name, --fail so an HTTP error
    // writes nothing and exits 22, and curl's own Content-Length check (a short body exits 18). No --location:
    // a redirect is refused, as the WinHTTP half refuses it (#88 review). No body cap: the bytes go to the
    // file, never through this process. stdout carries only -w's status code.
    DownloadResult httpDownload(const std::string &url, const std::filesystem::path &dest, const std::string &userAgent,
                                int timeoutMs, const DownloadProgress &progress)
    {
        DownloadResult out;
        if (url.rfind("https://", 0) != 0 && url.rfind("http://", 0) != 0)
        {
            out.error = "not an http(s) URL: " + url;
            return out;
        }
        if (!onPath("curl"))
        {
            out.error = "curl is not installed, so nothing can be downloaded from here";
            return out;
        }
        const fs::path temp = downloadTempPath(dest);
        std::error_code ec;
        fs::remove(temp, ec);

        int fromChild[2] = {-1, -1};
        if (::pipe2(fromChild, O_CLOEXEC) != 0)
        {
            out.error = "pipe failed";
            return out;
        }
        const int seconds = timeoutMs > 0 ? (timeoutMs + 999) / 1000 : 300;
        std::vector<std::string> args = {"curl", "--silent", "--show-error", "--fail", "--max-time", std::to_string(seconds),
                                         "--proto", "=http,https", "--user-agent", userAgent,
                                         "--output", temp.string(), "--write-out", "%{http_code}", "--", url};
        std::vector<char *> argv;
        for (std::string &a : args)
            argv.push_back(a.data());
        argv.push_back(nullptr);

        posix_spawn_file_actions_t actions;
        ::posix_spawn_file_actions_init(&actions);
        ::posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0);
        ::posix_spawn_file_actions_adddup2(&actions, fromChild[1], STDOUT_FILENO);
        ::posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0);
        pid_t child = 0;
        const int rc = ::posix_spawnp(&child, "curl", &actions, nullptr, argv.data(), environ);
        ::posix_spawn_file_actions_destroy(&actions);
        ::close(fromChild[1]);
        if (rc != 0)
        {
            ::close(fromChild[0]);
            out.error = "curl could not be started (" + std::string(std::strerror(rc)) + ")";
            return out;
        }

        // -w writes a few bytes when curl is done, well inside a pipe's buffer, so the wait comes first; while
        // curl runs, the temporary file's size is the progress (curl does not hand this process the header).
        int status = 0;
        for (;;)
        {
            const pid_t done = ::waitpid(child, &status, WNOHANG);
            if (done == child || (done < 0 && errno != EINTR))
                break;
            if (progress)
            {
                const auto size = fs::file_size(temp, ec);
                progress(ec ? 0 : static_cast<uint64_t>(size), -1);
            }
            ::usleep(100 * 1000);
        }
        std::string raw;
        char buf[256];
        for (;;)
        {
            const ssize_t n = ::read(fromChild[0], buf, sizeof(buf));
            if (n < 0 && errno == EINTR)
                continue;
            if (n <= 0)
                break;
            raw.append(buf, static_cast<size_t>(n));
        }
        ::close(fromChild[0]);

        out.status = std::atoi(raw.c_str());
        const int exitCode = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
        if (exitCode != 0 || out.status != 200)
        {
            fs::remove(temp, ec);
            if (exitCode == 0 && out.status >= 300 && out.status < 400)   // no --location: a 3xx is never followed
                out.error = redirectRefusal(out.status);
            else if (out.status >= 400 || exitCode == 22)
                out.error = "the server answered HTTP " + std::to_string(out.status);
            else if (exitCode == 18)
                out.error = "the body was shorter than its Content-Length (curl exit 18)";
            else
                out.error = "curl exited with " + std::to_string(exitCode) + " (6 = no such host, 7 = refused, "
                            "28 = timed out, 60 = the certificate was not trusted), HTTP " + std::to_string(out.status);
            return out;
        }
        const auto size = fs::file_size(temp, ec);
        if (ec)
        {
            out.error = "the download left no file";
            return out;
        }
        out.bytes = static_cast<uint64_t>(size);
        fs::rename(temp, dest, ec);
        if (ec)
        {
            fs::remove(temp, ec);
            out.error = "could not move the download to " + dest.string();
            return out;
        }
        if (progress)
            progress(out.bytes, static_cast<int64_t>(out.bytes));
        return out;
    }
}

#endif // !_WIN32
