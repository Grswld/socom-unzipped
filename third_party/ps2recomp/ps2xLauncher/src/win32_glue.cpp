// Sprint 8 Task 1: the whole file is Windows-only. On Linux src/posix_glue.cpp defines the same
// win32glue interface, so this translation unit must contribute nothing there -- the per-function
// "#else" arms below are unreachable now and their behaviour lives in posix_glue.cpp.
#ifdef _WIN32
#include "win32_glue.h"
#include "ps2x/knobs.h"

#include <ctime>
#include <cwchar>
#include <filesystem>
#include <string>
#include <vector>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <commdlg.h>
#include <shellapi.h>
#include <tlhelp32.h>   // the persona-card review, finding 5: the headless creator looks for a running game
#include <winhttp.h>
#include <xinput.h>   // Sprint 10 Q4: XINPUT_STATE for the guide button (the DLL is loaded by hand, never linked)
#endif

namespace fs = std::filesystem;

namespace win32glue
{
    std::string exeDirectory()
    {
#ifdef _WIN32
        wchar_t buf[MAX_PATH];
        const DWORD n = GetModuleFileNameW(nullptr, buf, MAX_PATH);
        if (n > 0 && n < MAX_PATH)
            return fs::path(buf).parent_path().string();
#endif
        return fs::current_path().string();
    }

    std::string browseForIso()
    {
#ifdef _WIN32
        char file[MAX_PATH] = {};
        OPENFILENAMEA ofn{};
        ofn.lStructSize = sizeof(ofn);
        ofn.lpstrFilter = "Disc images (*.iso;*.bin)\0*.iso;*.bin\0All files\0*.*\0";
        ofn.lpstrFile = file;
        ofn.nMaxFile = MAX_PATH;
        ofn.lpstrTitle = "Choose the SOCOM II ISO";
        ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
        if (GetOpenFileNameA(&ofn))
            return file;
#endif
        return {};
    }

    void openFolder(const std::string &path)
    {
#ifdef _WIN32
        ShellExecuteA(nullptr, "open", path.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
#else
        (void)path;
#endif
    }

    // ---- Sprint 8 Goal 9, third pass: the custom title bar -------------------------------------------------
    // The technique: keep WS_OVERLAPPEDWINDOW (so Windows keeps resize, snap, the drop shadow and the
    // animations) and take the caption away by answering WM_NCCALCSIZE with a client area that covers the
    // whole window. WM_NCHITTEST then has to say which part of our own bar the mouse is over -- that answer
    // comes from ui::chromeHitTest through the callback, the same function the drawing uses.
    namespace
    {
        HWND g_chromeWindow = nullptr;
        WNDPROC g_originalProc = nullptr;
        ChromeHitFn g_hitTest = nullptr;

        // ui::ChromeHit, as an int, without including the header here (windows.h and raylib.h do not mix,
        // and this file must stay free of both the UI and raylib).
        enum ChromeHitCode
        {
            HitClient = 0,
            HitCaption,
            HitMinimize,
            HitMaximize,
            HitClose,
            HitUnsavedPill,
            HitLeft,
            HitRight,
            HitTop,
            HitBottom,
            HitTopLeft,
            HitTopRight,
            HitBottomLeft,
            HitBottomRight
        };

        int frameThickness(HWND window)
        {
            // The maximised window hangs its frame off-screen; without this inset the top row of our bar
            // would be cut off by exactly that much.
            UINT dpi = 96;
            HMODULE user32 = GetModuleHandleW(L"user32.dll");
            if (user32 != nullptr)
            {
                using GetDpiForWindowFn = UINT(WINAPI *)(HWND);
                auto getDpi = reinterpret_cast<GetDpiForWindowFn>(
                    reinterpret_cast<void *>(GetProcAddress(user32, "GetDpiForWindow")));
                if (getDpi != nullptr)
                    dpi = getDpi(window);
                using GetMetricsFn = int(WINAPI *)(int, UINT);
                auto getMetric = reinterpret_cast<GetMetricsFn>(
                    reinterpret_cast<void *>(GetProcAddress(user32, "GetSystemMetricsForDpi")));
                if (getMetric != nullptr)
                    return getMetric(SM_CXSIZEFRAME, dpi) + getMetric(SM_CXPADDEDBORDER, dpi);
            }
            return GetSystemMetrics(SM_CXSIZEFRAME) + GetSystemMetrics(SM_CXPADDEDBORDER);
        }

        LRESULT CALLBACK chromeProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam)
        {
            switch (message)
            {
            case WM_NCCALCSIZE:
                if (wParam == TRUE)
                {
                    // The client area becomes the whole window: no caption, no top border drawn by Windows.
                    if (IsZoomed(window))
                    {
                        NCCALCSIZE_PARAMS *params = reinterpret_cast<NCCALCSIZE_PARAMS *>(lParam);
                        const int inset = frameThickness(window);
                        params->rgrc[0].left += inset;
                        params->rgrc[0].top += inset;
                        params->rgrc[0].right -= inset;
                        params->rgrc[0].bottom -= inset;
                    }
                    return 0;
                }
                break;
            case WM_NCHITTEST:
            {
                if (g_hitTest != nullptr)
                {
                    POINT p{static_cast<int>(static_cast<short>(LOWORD(lParam))), static_cast<int>(static_cast<short>(HIWORD(lParam)))};
                    ScreenToClient(window, &p);
                    RECT client{};
                    GetClientRect(window, &client);
                    switch (g_hitTest(p.x, p.y, client.right - client.left, client.bottom - client.top))
                    {
                    case HitCaption: return HTCAPTION;
                    case HitLeft: return HTLEFT;
                    case HitRight: return HTRIGHT;
                    case HitTop: return HTTOP;
                    case HitBottom: return HTBOTTOM;
                    case HitTopLeft: return HTTOPLEFT;
                    case HitTopRight: return HTTOPRIGHT;
                    case HitBottomLeft: return HTBOTTOMLEFT;
                    case HitBottomRight: return HTBOTTOMRIGHT;
                    default: return HTCLIENT;   // our own buttons and the pages: raylib gets the clicks
                    }
                }
                return HTCLIENT;
            }
            default:
                break;
            }
            return CallWindowProcW(g_originalProc, window, message, wParam, lParam);
        }
    }

    bool installCustomChrome(void *windowHandle, ChromeHitFn hitTest)
    {
        HWND window = reinterpret_cast<HWND>(windowHandle);
        if (window == nullptr || g_originalProc != nullptr)
            return window != nullptr;
        g_chromeWindow = window;
        g_hitTest = hitTest;
        g_originalProc = reinterpret_cast<WNDPROC>(
            SetWindowLongPtrW(window, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(chromeProc)));
        if (g_originalProc == nullptr)
            return false;
        // Ask for the frame to be recalculated now that WM_NCCALCSIZE answers differently.
        SetWindowPos(window, nullptr, 0, 0, 0, 0,
                     SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
        return true;
    }

    void minimizeWindow()
    {
        if (g_chromeWindow != nullptr)
            ShowWindow(g_chromeWindow, SW_MINIMIZE);
    }

    void maximizeToggleWindow()
    {
        if (g_chromeWindow == nullptr)
            return;
        ShowWindow(g_chromeWindow, IsZoomed(g_chromeWindow) ? SW_RESTORE : SW_MAXIMIZE);
    }

    bool isWindowMaximized()
    {
        return g_chromeWindow != nullptr && IsZoomed(g_chromeWindow) != 0;
    }

    std::string stamp()
    {
        char buf[32];
        const std::time_t t = std::time(nullptr);
        std::tm tm{};
#ifdef _WIN32
        localtime_s(&tm, &t);
#else
        localtime_r(&t, &tm);
#endif
        std::strftime(buf, sizeof(buf), "%Y%m%d_%H%M%S", &tm);
        return buf;
    }

    bool GameProcess::running() const
    {
#ifdef _WIN32
        if (!process)
            return false;
        return WaitForSingleObject(static_cast<HANDLE>(process), 0) == WAIT_TIMEOUT;
#else
        return false;
#endif
    }

    int GameProcess::exitCode() const
    {
#ifdef _WIN32
        if (!process)
            return 0;
        DWORD code = 0;
        if (!GetExitCodeProcess(static_cast<HANDLE>(process), &code) || code == STILL_ACTIVE)
            return 0;
        return static_cast<int>(code);
#else
        return 0;
#endif
    }

    void GameProcess::close()
    {
#ifdef _WIN32
        if (process)
            CloseHandle(static_cast<HANDLE>(process));
        if (log)
            CloseHandle(static_cast<HANDLE>(log));
#endif
        process = nullptr;
        log = nullptr;
    }

    bool gameRunningFrom(const std::string &dir, std::string &which)
    {
        which.clear();
        std::error_code ec;
        const std::string home = fs::absolute(fs::path(dir), ec).string();
        HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == INVALID_HANDLE_VALUE)
            return false;
        PROCESSENTRY32W entry{};
        entry.dwSize = sizeof(entry);
        for (BOOL more = Process32FirstW(snap, &entry); more && which.empty(); more = Process32NextW(snap, &entry))
        {
            // A process this user cannot open is not one the launcher started from this folder.
            HANDLE p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, entry.th32ProcessID);
            if (p == nullptr)
                continue;
            wchar_t image[MAX_PATH * 4];
            DWORD size = static_cast<DWORD>(sizeof(image) / sizeof(image[0]));
            if (QueryFullProcessImageNameW(p, 0, image, &size))
            {
                const std::string path = fs::path(std::wstring(image, size)).string();
                if (launcher::isGameImage(home, path, "socom2.exe"))
                    which = path + " (pid " + std::to_string(entry.th32ProcessID) + ")";
            }
            CloseHandle(p);
        }
        CloseHandle(snap);
        return !which.empty();
    }

    bool startGame(const std::string &dirStr, const launcher::Config &config, GameProcess &out)
    {
        out.error.clear();
#ifdef _WIN32
        const fs::path dir(dirStr);
        // Issue #69: the chosen GAME VERSION's own pair, not socom2.exe + socom2_game.elf whatever it said.
        const launcher::GameFiles files = launcher::gameFilesFor(config.gameRevision, "socom2.exe");
        const fs::path exe = dir / files.exe;
        const fs::path elf = dir / files.elf;
        if (!fs::exists(exe))
        {
            out.error = files.exe + " is not next to the launcher";
            return false;
        }
        if (!fs::exists(elf))
        {
            out.error = files.elf + " is not next to the launcher";
            return false;
        }
        std::error_code ec;
        fs::create_directories(dir / "logs", ec);
        fs::create_directories(dir / "cards", ec);
        // the environment: the current block plus our knobs (ours win). Sprint 9 Goal 3 (R156): an inherited
        // PS2X_* variable reaches the game only when this launcher was itself started in developer mode.
        const std::vector<std::string> ours = launcher::environmentFor(config);
        const bool keepInheritedKnobs = ps2x::knobs::devMode();   // R156
        std::string block;
        {
            std::vector<std::string> merged;
            LPWCH env = GetEnvironmentStringsW();
            for (LPWCH p = env; p && *p;)
            {
                const std::wstring w(p);
                p += w.size() + 1;
                const int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, nullptr, 0, nullptr, nullptr);
                std::string s(static_cast<size_t>(n > 0 ? n - 1 : 0), '\0');
                if (n > 1)
                    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, s.data(), n, nullptr, nullptr);
                const size_t eq = s.find('=');
                const std::string key = eq == std::string::npos ? s : s.substr(0, eq);
                bool overridden = false;
                for (const std::string &o : ours)
                    if (o.rfind(key + "=", 0) == 0)
                        overridden = true;
                if (!overridden && !key.empty() && key[0] != '=' && (keepInheritedKnobs || !launcher::isKnobKey(key)))
                    merged.push_back(s);
            }
            if (env)
                FreeEnvironmentStringsW(env);
            for (const std::string &o : ours)
                merged.push_back(o);
            for (const std::string &m : merged)
            {
                block += m;
                block.push_back('\0');
            }
            block.push_back('\0');
        }
        out.logPath = (dir / "logs" / ("run_" + stamp() + ".log")).string();
        SECURITY_ATTRIBUTES sa{};
        sa.nLength = sizeof(sa);
        sa.bInheritHandle = TRUE;
        HANDLE log = CreateFileA(out.logPath.c_str(), GENERIC_WRITE, FILE_SHARE_READ, &sa, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (log == INVALID_HANDLE_VALUE)
        {
            out.error = "cannot create the log file";
            return false;
        }
        STARTUPINFOA si{};
        si.cb = sizeof(si);
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdOutput = log;
        si.hStdError = log;
        si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        PROCESS_INFORMATION pi{};
        std::string cmd = "\"" + exe.string() + "\" \"" + elf.string() + "\"";
        std::vector<char> cmdBuf(cmd.begin(), cmd.end());
        cmdBuf.push_back('\0');
        const BOOL ok = CreateProcessA(exe.string().c_str(), cmdBuf.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW,
                                       block.data(), dir.string().c_str(), &si, &pi);
        if (!ok)
        {
            CloseHandle(log);
            out.error = "CreateProcess failed (" + std::to_string(GetLastError()) + ")";
            return false;
        }
        CloseHandle(pi.hThread);
        out.process = pi.hProcess;
        out.log = log;
        return true;
#else
        (void)dirStr; (void)config;
        out.error = "launching is Windows-only in this build";
        return false;
#endif
    }

    void terminate(GameProcess &game)
    {
#ifdef _WIN32
        if (game.process)
            TerminateProcess(static_cast<HANDLE>(game.process), 0);
#else
        (void)game;
#endif
    }

    // ---- Sprint 10 Q4: the window switch ------------------------------------------------------------------
    namespace
    {
        // XInputGetStateEx: ordinal 100 of xinput1_4.dll (and 1_3), the documented signature with the guide
        // bit 0x0400 in wButtons. Loaded once; a machine without it (documented as possible) reads "no".
        struct XInputGuide
        {
            bool tried = false;
            HMODULE dll = nullptr;
            DWORD(WINAPI *getStateEx)(DWORD, XINPUT_STATE *) = nullptr;
            // A user index that answered ERROR_DEVICE_NOT_CONNECTED is asked again only every 120 frames:
            // XInput's own guidance, a disconnected slot is the slow one to poll.
            unsigned skip[4] = {};
        };
        XInputGuide g_xinput;
        constexpr WORD kXInputGuideBit = 0x0400;

        void loadXInputGuide()
        {
            if (g_xinput.tried)
                return;
            g_xinput.tried = true;
            for (const wchar_t *name : {L"xinput1_4.dll", L"xinput1_3.dll"})
            {
                g_xinput.dll = LoadLibraryW(name);
                if (g_xinput.dll == nullptr)
                    continue;
                g_xinput.getStateEx = reinterpret_cast<DWORD(WINAPI *)(DWORD, XINPUT_STATE *)>(
                    reinterpret_cast<void *>(GetProcAddress(g_xinput.dll, reinterpret_cast<LPCSTR>(100))));
                if (g_xinput.getStateEx != nullptr)
                    return;
                FreeLibrary(g_xinput.dll);
                g_xinput.dll = nullptr;
            }
        }

        // The first visible, unowned, titled top-level window of a process: the game's raylib window.
        struct FindByPid
        {
            DWORD pid;
            HWND found;
        };
        BOOL CALLBACK findWindowByPid(HWND hwnd, LPARAM lParam)
        {
            FindByPid *f = reinterpret_cast<FindByPid *>(lParam);
            DWORD pid = 0;
            GetWindowThreadProcessId(hwnd, &pid);
            if (pid != f->pid || !IsWindowVisible(hwnd) || GetWindow(hwnd, GW_OWNER) != nullptr || GetWindowTextLengthW(hwnd) == 0)
                return TRUE;
            f->found = hwnd;
            return FALSE;
        }

        bool bringToFront(HWND target)
        {
            const HWND front = GetForegroundWindow();
            if (front == target)
                return true;
            // A process that is not in front may not take the foreground (SetForegroundWindow's rules) unless
            // its input queue is attached to the one that is. Attached for the call only.
            const DWORD me = GetCurrentThreadId();
            const DWORD frontThread = front != nullptr ? GetWindowThreadProcessId(front, nullptr) : 0;
            const bool attached = frontThread != 0 && frontThread != me && AttachThreadInput(frontThread, me, TRUE);
            if (IsIconic(target))
                ShowWindow(target, SW_RESTORE);
            BringWindowToTop(target);
            SetForegroundWindow(target);
            if (attached)
                AttachThreadInput(frontThread, me, FALSE);
            return GetForegroundWindow() == target;
        }
    }

    bool xinputGuideReadable()
    {
        loadXInputGuide();
        return g_xinput.getStateEx != nullptr;
    }

    bool xinputGuideDown()
    {
        loadXInputGuide();
        if (g_xinput.getStateEx == nullptr)
            return false;
        bool down = false;
        for (DWORD user = 0; user < 4; ++user)
        {
            if (g_xinput.skip[user] > 0)
            {
                --g_xinput.skip[user];
                continue;
            }
            XINPUT_STATE state{};
            const DWORD result = g_xinput.getStateEx(user, &state);
            if (result != ERROR_SUCCESS)
            {
                g_xinput.skip[user] = 120;
                continue;
            }
            down = down || (state.Gamepad.wButtons & kXInputGuideBit) != 0;
        }
        return down;
    }

    bool toggleForeground(void *launcherWindow, const GameProcess &game, std::string &why)
    {
        const HWND mine = reinterpret_cast<HWND>(launcherWindow);
        if (mine == nullptr || game.process == nullptr)
        {
            why = "no game window to switch to";
            return false;
        }
        FindByPid f{GetProcessId(static_cast<HANDLE>(game.process)), nullptr};
        EnumWindows(findWindowByPid, reinterpret_cast<LPARAM>(&f));
        if (f.found == nullptr)
        {
            why = "the game has no window yet";
            return false;
        }
        const HWND target = GetForegroundWindow() == mine ? f.found : mine;
        if (!bringToFront(target))
        {
            why = target == mine ? "Windows refused to bring the launcher forward" : "Windows refused to bring the game forward";
            return false;
        }
        return true;
    }

    // ---- Sprint 9 Goal 8: one HTTPS request (the bug report, the server's status line) ---------------------
    // WinHTTP, which ships with Windows: no vendored TLS. Certificate validation is WinHTTP's default and is
    // left alone -- nothing here sets WINHTTP_OPTION_SECURITY_FLAGS, so an expired, self-signed or
    // wrong-host certificate fails the request (ERROR_WINHTTP_SECURE_FAILURE) and the report is saved to disk.
    namespace
    {
        std::wstring widen(const std::string &s)
        {
            if (s.empty())
                return {};
            const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
            std::wstring out(static_cast<size_t>(n > 0 ? n : 0), L'\0');
            if (n > 0)
                MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), n);
            return out;
        }

        struct InternetHandle
        {
            HINTERNET h = nullptr;
            ~InternetHandle()
            {
                if (h != nullptr)
                    WinHttpCloseHandle(h);
            }
        };

// The system's proxy settings where WinHTTP can read them itself (Windows 8.1 and later).
#ifdef WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY
        constexpr DWORD kProxyAccess = WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY;
#else
        constexpr DWORD kProxyAccess = WINHTTP_ACCESS_TYPE_DEFAULT_PROXY;
#endif

        std::string winHttpError(const char *what)
        {
            return std::string(what) + " failed (WinHTTP error " + std::to_string(GetLastError()) + ")";
        }
    }

    HttpResult httpRequest(const std::string &method, const std::string &url, const std::string &body, int timeoutMs)
    {
        HttpResult out;
        const std::wstring wideUrl = widen(url);
        wchar_t host[256] = {};
        wchar_t path[2048] = {};
        URL_COMPONENTS parts{};
        parts.dwStructSize = sizeof(parts);
        parts.lpszHostName = host;
        parts.dwHostNameLength = static_cast<DWORD>(sizeof(host) / sizeof(host[0]));
        parts.lpszUrlPath = path;
        parts.dwUrlPathLength = static_cast<DWORD>(sizeof(path) / sizeof(path[0]));
        if (!WinHttpCrackUrl(wideUrl.c_str(), static_cast<DWORD>(wideUrl.size()), 0, &parts))
        {
            out.error = "not a URL: " + url;
            return out;
        }
        const bool secure = parts.nScheme == INTERNET_SCHEME_HTTPS;
        const std::wstring hostName = host;
        if (!secure && hostName != L"127.0.0.1" && hostName != L"localhost")
        {
            out.error = "plain http is refused for anything but a loopback test server";
            return out;
        }

        InternetHandle session, connection, request;
        session.h = WinHttpOpen(L"SOCOM-Unzipped-Launcher/1.0", kProxyAccess, WINHTTP_NO_PROXY_NAME,
                                WINHTTP_NO_PROXY_BYPASS, 0);
        if (session.h == nullptr)
        {
            out.error = winHttpError("WinHttpOpen");
            return out;
        }
        const int each = timeoutMs > 0 ? timeoutMs : 15000;
        WinHttpSetTimeouts(session.h, each, each, each, each);
        connection.h = WinHttpConnect(session.h, host, parts.nPort, 0);
        if (connection.h == nullptr)
        {
            out.error = winHttpError("WinHttpConnect");
            return out;
        }
        request.h = WinHttpOpenRequest(connection.h, widen(method).c_str(), path[0] != L'\0' ? path : L"/", nullptr,
                                       WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, secure ? WINHTTP_FLAG_SECURE : 0);
        if (request.h == nullptr)
        {
            out.error = winHttpError("WinHttpOpenRequest");
            return out;
        }
        const wchar_t *headers = body.empty() ? WINHTTP_NO_ADDITIONAL_HEADERS : L"Content-Type: application/json\r\n";
        const DWORD headersLength = body.empty() ? 0 : static_cast<DWORD>(-1L);
        if (!WinHttpSendRequest(request.h, headers, headersLength,
                                body.empty() ? WINHTTP_NO_REQUEST_DATA : const_cast<char *>(body.data()),
                                static_cast<DWORD>(body.size()), static_cast<DWORD>(body.size()), 0) ||
            !WinHttpReceiveResponse(request.h, nullptr))
        {
            out.error = winHttpError("the request");
            return out;
        }

        DWORD status = 0, size = sizeof(status);
        if (!WinHttpQueryHeaders(request.h, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX,
                                 &status, &size, WINHTTP_NO_HEADER_INDEX))
        {
            out.error = winHttpError("reading the status");
            return out;
        }
        wchar_t retry[32] = {};
        DWORD retrySize = sizeof(retry) - sizeof(wchar_t);
        if (WinHttpQueryHeaders(request.h, WINHTTP_QUERY_CUSTOM, L"Retry-After", retry, &retrySize, WINHTTP_NO_HEADER_INDEX))
        {
            const long seconds = std::wcstol(retry, nullptr, 10);
            out.retryAfter = seconds > 0 && seconds < 7 * 24 * 3600 ? static_cast<int>(seconds) : 0;
        }

        constexpr size_t kMaxBody = 1024u * 1024u;
        const ULONGLONG deadline = GetTickCount64() + static_cast<ULONGLONG>(each);
        for (;;)
        {
            DWORD available = 0;
            if (!WinHttpQueryDataAvailable(request.h, &available) || available == 0)
                break;
            std::string chunk(available, '\0');
            DWORD got = 0;
            if (!WinHttpReadData(request.h, chunk.data(), available, &got) || got == 0)
                break;
            out.body.append(chunk.data(), got);
            if (out.body.size() > kMaxBody || GetTickCount64() > deadline)
                break;
        }
        out.status = static_cast<int>(status);
        return out;
    }

    // Sprint 16 R2a (#71): the same WinHTTP calls as httpRequest, streamed to a file in 64 KiB chunks with no
    // cap, the caller's User-Agent, a GET only, and Content-Length honoured.
    DownloadResult httpDownload(const std::string &url, const std::filesystem::path &dest, const std::string &userAgent,
                                int timeoutMs, const DownloadProgress &progress)
    {
        DownloadResult out;
        const std::wstring wideUrl = widen(url);
        wchar_t host[256] = {};
        wchar_t path[2048] = {};
        URL_COMPONENTS parts{};
        parts.dwStructSize = sizeof(parts);
        parts.lpszHostName = host;
        parts.dwHostNameLength = static_cast<DWORD>(sizeof(host) / sizeof(host[0]));
        parts.lpszUrlPath = path;
        parts.dwUrlPathLength = static_cast<DWORD>(sizeof(path) / sizeof(path[0]));
        if (!WinHttpCrackUrl(wideUrl.c_str(), static_cast<DWORD>(wideUrl.size()), 0, &parts) ||
            (parts.nScheme != INTERNET_SCHEME_HTTPS && parts.nScheme != INTERNET_SCHEME_HTTP))
        {
            out.error = "not an http(s) URL: " + url;
            return out;
        }
        const bool secure = parts.nScheme == INTERNET_SCHEME_HTTPS;

        InternetHandle session, connection, request;
        session.h = WinHttpOpen(widen(userAgent).c_str(), kProxyAccess, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
        if (session.h == nullptr)
        {
            out.error = winHttpError("WinHttpOpen");
            return out;
        }
        const int each = timeoutMs > 0 ? timeoutMs : 300000;
        WinHttpSetTimeouts(session.h, each, each, each, each);
        connection.h = WinHttpConnect(session.h, host, parts.nPort, 0);
        if (connection.h == nullptr)
        {
            out.error = winHttpError("WinHttpConnect");
            return out;
        }
        request.h = WinHttpOpenRequest(connection.h, L"GET", path[0] != L'\0' ? path : L"/", nullptr, WINHTTP_NO_REFERER,
                                       WINHTTP_DEFAULT_ACCEPT_TYPES, secure ? WINHTTP_FLAG_SECURE : 0);
        if (request.h == nullptr)
        {
            out.error = winHttpError("WinHttpOpenRequest");
            return out;
        }
        // WinHTTP follows a 3xx to any host by default; curl on POSIX runs without --location. Both refuse it the
        // same way (#88 review): with redirects disabled the 3xx surfaces as its own status, refused below.
        DWORD noRedirects = WINHTTP_DISABLE_REDIRECTS;
        if (!WinHttpSetOption(request.h, WINHTTP_OPTION_DISABLE_FEATURE, &noRedirects, static_cast<DWORD>(sizeof(noRedirects))))
        {
            out.error = winHttpError("disabling redirects");
            return out;
        }
        if (!WinHttpSendRequest(request.h, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) ||
            !WinHttpReceiveResponse(request.h, nullptr))
        {
            out.error = winHttpError("the request");
            return out;
        }
        DWORD status = 0, size = sizeof(status);
        if (!WinHttpQueryHeaders(request.h, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX,
                                 &status, &size, WINHTTP_NO_HEADER_INDEX))
        {
            out.error = winHttpError("reading the status");
            return out;
        }
        out.status = static_cast<int>(status);
        if (status >= 300 && status < 400)
        {
            out.error = redirectRefusal(out.status);
            return out;
        }
        if (status != 200)
        {
            out.error = "the server answered HTTP " + std::to_string(status);
            return out;
        }
        int64_t total = -1;
        DWORD length = 0;
        size = sizeof(length);
        if (WinHttpQueryHeaders(request.h, WINHTTP_QUERY_CONTENT_LENGTH | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX,
                                &length, &size, WINHTTP_NO_HEADER_INDEX))
            total = static_cast<int64_t>(length);

        const std::filesystem::path temp = downloadTempPath(dest);
        std::error_code ec;
        std::filesystem::remove(temp, ec);
        HANDLE file = CreateFileW(temp.wstring().c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (file == INVALID_HANDLE_VALUE)
        {
            out.error = "could not create " + temp.string() + " (error " + std::to_string(GetLastError()) + ")";
            return out;
        }
        std::vector<char> chunk(64u * 1024u);
        const ULONGLONG deadline = GetTickCount64() + static_cast<ULONGLONG>(each);
        bool failed = false;
        for (;;)
        {
            DWORD available = 0;
            if (!WinHttpQueryDataAvailable(request.h, &available))
            {
                out.error = winHttpError("reading the body");
                failed = true;
                break;
            }
            if (available == 0)
                break;
            const DWORD want = available < chunk.size() ? available : static_cast<DWORD>(chunk.size());
            DWORD got = 0;
            if (!WinHttpReadData(request.h, chunk.data(), want, &got))
            {
                out.error = winHttpError("reading the body");
                failed = true;
                break;
            }
            if (got == 0)
                break;
            DWORD written = 0;
            if (!WriteFile(file, chunk.data(), got, &written, nullptr) || written != got)
            {
                out.error = "could not write " + temp.string() + " (error " + std::to_string(GetLastError()) + ")";
                failed = true;
                break;
            }
            out.bytes += got;
            if (progress)
                progress(out.bytes, total);
            if (GetTickCount64() > deadline)
            {
                out.error = "the download took longer than " + std::to_string(each / 1000) + " s";
                failed = true;
                break;
            }
        }
        CloseHandle(file);
        if (!failed && total >= 0 && out.bytes != static_cast<uint64_t>(total))
        {
            out.error = "the body was " + std::to_string(out.bytes) + " bytes, shorter than its Content-Length " +
                        std::to_string(total);
            failed = true;
        }
        if (failed)
        {
            std::filesystem::remove(temp, ec);
            return out;
        }
        if (!MoveFileExW(temp.wstring().c_str(), dest.wstring().c_str(), MOVEFILE_REPLACE_EXISTING))
        {
            out.error = "could not move the download to " + dest.string() + " (error " + std::to_string(GetLastError()) + ")";
            std::filesystem::remove(temp, ec);
            return out;
        }
        return out;
    }
}
#endif // _WIN32
