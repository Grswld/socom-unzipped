// SOCOM Unzipped launcher (Task 8b, packaging outline section 3; redesigned in Sprint 8 Goal 9): one window
// that owns config.json, verifies the disc image, shows what the game will read from the controller, and
// starts socom2.exe with the PS2X_* environment.
// raylib on purpose: the controller page calls the same functions the game's input poll does.
//
//   socom_unzipped_launcher.exe              the window
//   socom_unzipped_launcher.exe --selftest   load config.json, verify the ISO if one is set, print the environment, exit
//   socom_unzipped_launcher.exe --screenshot <dir>   every page at both sizes, on a fixed fake state, as PNGs
//   socom_unzipped_launcher.exe --screenshot <dir> --shot-frames 2   capture the FIRST frame drawn after each
//                                                   page change rather than the settled one (Sprint 9 P4:
//                                                   the default is why a one-frame defect never showed up)
//   socom_unzipped_launcher.exe --diagnostics <out.zip> [dir]   write the diagnostics zip for <dir> (default: this folder), no window
//   socom_unzipped_launcher.exe --report-bug <form.json> [dir]   send one bug report for <dir>, print the reply, no window
//                                                                (a PROOF unless the form says "test": false)
//   socom_unzipped_launcher.exe --server-status                  print the hosted server's status line, no window
//   socom_unzipped_launcher.exe --fetch-patch <dest> <bytes> <sha256>   download the r0004 package and check it,
//                                                                no window (loopback tests only until R2: R293)
//
// This file is setup, the loop and the page dispatch. Everything drawn lives in src/ui/.
#include "launcher/bug_report.h"
#include "launcher/diagnostics.h"
#include "launcher/iso9660.h"
#include "launcher/launcher_config.h"
#include "launcher/launcher_layout.h"
#include "launcher/menu_sounds.h"
#include "launcher/mic_devices.h"
#include "launcher/patch_fetch.h"
#include "launcher/sha256.h"
#include "ps2x/app_icon_embedded.h"   // Sprint 10 Q4: the window icon both executables wear
#include "ps2x/exe_dir.h"
#include "ps2x/knobs.h"
#include "ps2x/zip_store.h"
#include "win32_glue.h"

#include "ui/chrome.h"
#include "ui/fonts.h"
#include "ui/focus.h"
#include "ui/glyphs.h"
#include "ui/logo_embedded/socom_unzipped_logo.h"
#include "ui/pad_input.h"
#include "ui/pad_render.h"
#include "ui/pages.h"
#include "ui/theme.h"
#include "ui/tips.h"
#include "ui/widgets.h"

#include "raylib.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <functional>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace fs = std::filesystem;

namespace
{
    // What the Win32 window procedure needs to answer WM_NCHITTEST between frames. The system asks in real
    // pixels, the UI works in screen units, so the scale it is asked with carries the DPI factor too.
    float g_uiScale = 1.0f;
    float g_uiDpi = 1.0f;
    bool g_uiMaximized = false;
    bool g_nativeChrome = false;
    // Sprint 10: the SOCOM Unzipped logo at the head of the rail (owner: "use the socom unzipped logo from
    // s2u.scotho.com"). Embedded like the type is, decoded once the window exists, and drawn scaled with
    // mipmaps so the rail's 204 units read clean at any window size. id 0 = it would not decode: the rail
    // then draws its head empty rather than crash, and stderr says so.
    Texture2D g_logo{};

    int chromeHitForSystem(int x, int y, int w, int h)
    {
        return static_cast<int>(ui::chromeHitTest(x, y, w, h, g_uiScale * g_uiDpi, g_uiMaximized));
    }

    std::string readText(const fs::path &p)
    {
        std::ifstream in(p, std::ios::binary);
        if (!in)
            return {};
        std::stringstream ss;
        ss << in.rdbuf();
        return ss.str();
    }

    // The first `maxBytes` of a file: the run log's head, where the boot lines (GL, audio, notices) are.
    std::string readHead(const fs::path &p, size_t maxBytes)
    {
        std::ifstream in(p, std::ios::binary);
        if (!in)
            return {};
        std::string out(maxBytes, '\0');
        in.read(out.data(), static_cast<std::streamsize>(maxBytes));
        out.resize(static_cast<size_t>(in.gcount()));
        return out;
    }

    bool writeText(const fs::path &p, const std::string &text)
    {
        std::ofstream out(p, std::ios::binary | std::ios::trunc);
        if (!out)
            return false;
        out << text;
        return static_cast<bool>(out);
    }

    // The disc check: SCUS_972.75 in the root directory, hashed against the revisions the launcher knows
    // (launcher::kDiscRevisions -- one row today, r0001). Task 11: what it answers is now WHICH revision the
    // image is, not merely whether it is the pinned one, because the launcher has a GAME VERSION to name.
    // An image in no row is refused exactly as before, with the same sentence, and the runner's own
    // preflight still exits 67 on it (ps2xShared/src/preflight.cpp; ExitCodes::kDiscNotR0001 unchanged).
    struct DiscStatus
    {
        bool checked = false;
        bool ok = false;
        std::string revision;   // "r0001" for an image in the table; empty for anything else
        std::string message;
    };

    DiscStatus checkDisc(const std::string &isoPath)
    {
        DiscStatus st;
        st.checked = true;
        if (isoPath.empty())
        {
            st.message = ui::kDiscNotChosen;
            return st;
        }
        iso9660::Reader read = iso9660::fileReader(isoPath);
        if (!read)
        {
            st.message = ui::kDiscCannotOpen;
            return st;
        }
        iso9660::FileEntry e;
        if (!iso9660::findRootFile(read, launcher::kSocom2ElfName, e))
        {
            st.message = ui::kDiscNoElf;
            return st;
        }
        std::vector<uint8_t> bytes;
        if (!iso9660::readFile(read, e, bytes))
        {
            st.message = ui::kDiscCannotReadElf;
            return st;
        }
        const std::string digest = sha256::hex(bytes.data(), bytes.size());
        st.revision = launcher::discRevisionForDigest(digest);
        if (st.revision.empty())
        {
            st.message = ui::kDiscWrongRevision;
            return st;
        }
        st.ok = true;
        st.message = "SOCOM II U.S. Navy SEALs NTSC " + st.revision;
        return st;
    }

    // The newest logs/run_<stamp>.log by name (the stamp sorts), for a launcher that has not started a
    // game this session -- or a game that was double-clicked (the bare run writes the same names).
    std::string newestRunLog(const fs::path &logs)
    {
        std::string best;
        std::error_code ec;
        for (fs::directory_iterator it(logs, ec), end; !ec && it != end; it.increment(ec))
        {
            const std::string name = it->path().filename().string();
            if (name.rfind("run_", 0) == 0 && it->path().extension() == ".log" && name > best)
                best = name;
        }
        return best.empty() ? std::string() : (logs / best).string();
    }

    std::string homeDirectory();   // USERPROFILE, else HOME (defined with the bug report's helpers below)

    // "Save diagnostics": one zip -- the last log, config.json through the allowlist, the GL lines, the
    // crash record if any, versions (launcher/diagnostics.h). `outZip` empty = diagnostics/ under `home`.
    // The log goes in whole: diagnostics::entries() is what clips it to its head and tail and scrubs the
    // home directory out of every entry, and it must see the real byte count to say how much it dropped.
    bool saveDiagnostics(const fs::path &home, const fs::path &outZip, const std::string &lastLog,
                         bool haveLastExit, long long lastExit, std::string &message)
    {
        namespace diag = launcher::diagnostics;
        const std::string stamp = win32glue::stamp();
        const fs::path out = outZip.empty() ? home / "diagnostics" / ("socom_unzipped_" + stamp + ".zip") : outZip;
        std::error_code ec;
        if (out.has_parent_path())
            fs::create_directories(out.parent_path(), ec);

        diag::Inputs in;
        const std::string log = (!lastLog.empty() && fs::exists(lastLog)) ? lastLog : newestRunLog(home / "logs");
        if (!log.empty())
        {
            in.logName = fs::path(log).filename().string();
            in.logText = readText(log);
        }
        in.configText = readText(home / "config.json");
        in.version = readText(home / "version.txt");
        while (!in.version.empty() && (in.version.back() == '\n' || in.version.back() == '\r'))
            in.version.pop_back();
        in.platform = ExeDir::platformName();
        in.homeDir = homeDirectory();
        in.haveLastExit = haveLastExit;
        in.lastExit = lastExit;

        uint16_t date = 0x0021, time = 0;
        ZipStore::dosDateTime(stamp, date, time);
        const std::string bytes = ZipStore::build(diag::entries(in), date, time);
        std::ofstream file(out, std::ios::binary | std::ios::trunc);
        if (bytes.empty() || !file)
        {
            message = "cannot write " + out.string();
            return false;
        }
        file.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
        file.flush();
        if (!file)
        {
            message = "cannot write " + out.string();
            return false;
        }
        message = "saved " + out.string();
        return true;
    }

    // ---- Sprint 9 Goal 8: the bug report and the server's status line ----------------------------------------
    namespace br = launcher::bugreport;

    std::string homeDirectory()
    {
        const char *homeDir = std::getenv("USERPROFILE");
        if (homeDir == nullptr || *homeDir == '\0')
            homeDir = std::getenv("HOME");
        return homeDir ? homeDir : "";
    }

    // The log as the report needs it: the head (where the GL lines are) and the tail (what went wrong, and
    // what is attached), without reading a gigabyte to get them.
    std::string readLogForReport(const fs::path &p)
    {
        constexpr size_t kHead = 256u * 1024u, kTail = 256u * 1024u;
        std::error_code ec;
        const uintmax_t size = fs::file_size(p, ec);
        if (ec)
            return {};
        if (size <= kHead + kTail)
            return readText(p);
        std::ifstream in(p, std::ios::binary);
        if (!in)
            return {};
        std::string tail(kTail, '\0');
        in.seekg(static_cast<std::streamoff>(size - kTail));
        in.read(tail.data(), static_cast<std::streamsize>(kTail));
        tail.resize(static_cast<size_t>(in.gcount()));
        return launcher::diagnostics::joinClipped(readHead(p, kHead), tail, size - kHead - kTail);
    }

    br::Inputs reportInputs(const fs::path &home, const std::string &lastLog, bool haveLastExit, long long lastExit)
    {
        br::Inputs in;
        in.version = readText(home / "version.txt");
        while (!in.version.empty() && (in.version.back() == '\n' || in.version.back() == '\r'))
            in.version.pop_back();
        in.platform = ExeDir::platformName();
        in.homeDir = homeDirectory();
        const std::string log = (!lastLog.empty() && fs::exists(lastLog)) ? lastLog : newestRunLog(home / "logs");
        if (!log.empty())
            in.logText = readLogForReport(log);
        in.haveLastExit = haveLastExit;
        in.lastExit = lastExit;
        return in;
    }

    std::string apiUrl(const char *path)
    {
        return br::apiBase(ps2x::knob(br::kApiBaseEnv)) + path;
    }

    struct ReportOutcome
    {
        br::Reply reply;
        std::string savedPath;        // set when the report was written to logs/ instead
        std::string transportError;   // for stderr; never shown as the reason on the page
    };

    // Blocking: the POST, and on anything but a receipt or a field to fix, the file. Runs on the worker
    // thread (the page) or on the main one (--report-bug).
    ReportOutcome sendReport(const fs::path &home, const std::string &json)
    {
        ReportOutcome out;
        const win32glue::HttpResult http = win32glue::httpRequest("POST", apiUrl(br::kBugsPath), json, 15000);
        out.transportError = http.error;
        out.reply = br::parseReply(http.status, http.body, http.retryAfter);
        if (out.reply.kind == br::Reply::Kind::Failed || out.reply.kind == br::Reply::Kind::RateLimited)
        {
            std::error_code ec;
            fs::create_directories(home / "logs", ec);
            const fs::path file = home / "logs" / br::savedFileName(win32glue::stamp());
            if (writeText(file, json))
                out.savedPath = file.string();
        }
        return out;
    }

    // GET /api/stats -> the body, or "" when there was no 200. Blocking; the page runs it on a worker.
    std::string fetchStats()
    {
        const win32glue::HttpResult http = win32glue::httpRequest("GET", apiUrl(br::kStatsPath), std::string(), 4000);
        return http.status == 200 ? http.body : std::string();
    }

    // One request at a time, off the UI thread. The UI thread starts it and polls the slot; nothing else is
    // shared. join() waits for the request's own timeout at most, so closing the launcher mid-send neither
    // crashes (the thread never outlives what it writes to) nor hangs for longer than that.
    template <typename T>
    class Worker
    {
    public:
        ~Worker() { join(); }
        bool busy() const { return m_busy; }
        void start(std::function<T()> fn)
        {
            join();
            m_busy = true;
            m_done = false;
            m_thread = std::thread([this, fn]()
            {
                T result{};
                try
                {
                    result = fn();
                }
                catch (...)
                {
                }
                std::lock_guard<std::mutex> lock(m_mutex);
                m_result = std::move(result);
                m_done = true;
            });
        }
        bool poll(T &out)
        {
            if (!m_busy)
                return false;
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                if (!m_done)
                    return false;
            }
            m_thread.join();
            m_busy = false;
            out = std::move(m_result);
            return true;
        }
        void join()
        {
            if (m_thread.joinable())
                m_thread.join();
            m_busy = false;
        }

    private:
        std::thread m_thread;
        std::mutex m_mutex;
        bool m_done = false;
        bool m_busy = false;
        T m_result{};
    };

    int exitCodeFor(const br::Reply &reply)
    {
        switch (reply.kind)
        {
        case br::Reply::Kind::Sent: return 0;
        case br::Reply::Kind::FieldError: return 2;
        case br::Reply::Kind::RateLimited: return 3;
        case br::Reply::Kind::Failed: return 4;
        }
        return 4;
    }

    // --report-bug <form.json> [dir]: one report, built exactly as the page builds it, and the reply's line.
    int reportBugHeadless(const fs::path &formFile, const fs::path &home)
    {
        br::Form form;
        if (!br::formFromJson(readText(formFile), form))
        {
            std::printf("cannot read the form file %s\n", formFile.string().c_str());
            return 5;
        }
        const std::string problem = br::checkForm(form);
        if (!problem.empty())
        {
            std::printf("NOT SENT. %s\n", problem.c_str());
            return 2;
        }
        launcher::Config config;
        launcher::fromJson(readText(home / "config.json"), config);
        const br::Payload payload = br::build(config, form, reportInputs(home, std::string(), false, 0));
        std::printf("%s\n", br::previewLine(payload, form).c_str());
        const ReportOutcome outcome = sendReport(home, payload.json);
        if (!outcome.transportError.empty())
            std::fprintf(stderr, "[report] %s\n", outcome.transportError.c_str());
        std::printf("%s\n", outcome.reply.text.c_str());
        if (!outcome.savedPath.empty())
            std::printf("%s\n", br::savedLocallyLine(outcome.savedPath).c_str());
        return exitCodeFor(outcome.reply);
    }

    // --fetch-patch <dest> <bytes> <sha256>: Sprint 16 R2a (#71), the r0004 package download and its check, for
    // tools_py/tests/test_patch_fetch.py. Until R2 lands a player-facing path this mode serves the loopback tests
    // ONLY: a base that is not the loopback seam is refused before any request, because the first live fetch
    // from PSRewired is the owner's hand (R293).
    int fetchPatchHeadless(const fs::path &dest, const char *bytesArg, const std::string &sha256Hex)
    {
        namespace pf = launcher::patchfetch;
        const std::string base = pf::patchBase(ps2x::knob(pf::kPatchBaseEnv));
        if (base == pf::kDefaultPatchBase)
        {
            std::printf("NOT FETCHED. The first live fetch from PSRewired is the owner's (R293); set %s to a "
                        "loopback test server in developer mode.\n", pf::kPatchBaseEnv);
            return 3;
        }
        char *end = nullptr;
        const unsigned long long expected = std::strtoull(bytesArg, &end, 10);
        if (end == bytesArg || *end != '\0' || sha256Hex.size() != 64)
        {
            std::printf("usage: --fetch-patch <dest> <bytes> <sha256 hex>\n");
            return 5;
        }
        // The body lands under the staging name and is checked there; only a package that passes is renamed onto
        // <dest>, so a refusal leaves whatever <dest> already held byte-identical (#88 review).
        const fs::path staged = pf::stagingPath(dest);
        const win32glue::DownloadResult got =
            win32glue::httpDownload(pf::patchUrl(base), staged, pf::kPatchUserAgent, 120000, nullptr);
        if (!got.error.empty())
        {
            std::error_code ec;
            fs::remove(staged, ec);
            std::printf("NOT FETCHED. %s\n", got.error.c_str());
            return 1;
        }
        const pf::Verdict verdict = pf::installPackage(staged, dest, expected, sha256Hex);
        if (!verdict.ok)
        {
            std::printf("REFUSED. %s\n", verdict.reason.c_str());
            return 2;
        }
        std::printf("FETCHED %llu bytes, sha256 %s\n", static_cast<unsigned long long>(got.bytes), verdict.sha256.c_str());
        return 0;
    }

    // ---- the chrome around the pages ----------------------------------------------------------------------

    // ---- the launcher's own title bar (there is no OS caption above it) -----------------------------------

    void drawWindowButton(const ui::Ctx &ctx, ui::Rect r, int kind, bool hover, bool maximized)
    {
        using namespace ui;
        if (hover)
            fillRect(ctx, r, kind == 2 ? theme::bad : theme::panelHi);
        const Rgba ink = hover && kind == 2 ? Rgba{0xFF, 0xFF, 0xFF, 0xFF} : theme::text;
        const float cx = r.cx();
        const float cy = r.cy();
        const float s = 5.0f;
        if (kind == 0)   // minimise
        {
            drawLine(ctx, Vec2{cx - s, cy + 0.5f}, Vec2{cx + s, cy + 0.5f}, ink, 1.5f);
        }
        else if (kind == 1)   // maximise / restore
        {
            if (maximized)
            {
                strokeRect(ctx, Rect{cx - s + 1.5f, cy - s - 1.0f, s * 2.0f - 1.5f, s * 2.0f - 1.5f}, ink, 1.5f);
                strokeRect(ctx, Rect{cx - s - 1.5f, cy - s + 2.0f, s * 2.0f - 1.5f, s * 2.0f - 1.5f}, ink, 1.5f);
            }
            else
            {
                strokeRect(ctx, Rect{cx - s, cy - s, s * 2.0f, s * 2.0f}, ink, 1.5f);
            }
        }
        else   // close
        {
            drawLine(ctx, Vec2{cx - s, cy - s}, Vec2{cx + s, cy + s}, ink, 1.6f);
            drawLine(ctx, Vec2{cx - s, cy + s}, Vec2{cx + s, cy - s}, ink, 1.6f);
        }
    }

    void drawTopBar(const ui::Ctx &ctx, ui::App &app, ui::ChromeHit hover, bool maximized)
    {
        using namespace ui;
        const ChromeLayout l = chromeLayout(app.frame.window.w);
        fillRect(ctx, l.bar, theme::mix(theme::panel, theme::ground, 0.5f));
        fillRect(ctx, Rect{0.0f, l.bar.bottom() - 1.0f, l.bar.w, 1.0f}, theme::line);

        // The mark, small: the big wordmark lives at the head of the rail. Neither word is drawn yet --
        // where the second one goes depends on where the first one's BASELINE falls, and that is
        // arithmetic ui::topBarPlaces does and the top-bar test asserts (Sprint 9 P4, from the owner's
        // screenshot: "the UNZIPPED part after SOCOM II is lower than the SOCOM II text").
        const float markX = 16.0f;
        const float markY = 10.0f;
        const float markW = textWidth(ctx, "SOCOM II", 15.0f, Face::Bold, 0.08f);
        const float subX = markX + markW + 10.0f;

        // Where the measured halves of the bar go: the tab group and the state cluster, from the widths this
        // font actually draws (ui::topBarPlaces does the arithmetic, and the tests assert on it).
        const char *state = app.running ? "RUNNING" : (app.discOk ? "READY" : "NOT READY");
        const char *name = pageName(app.nav.page);
        TopBarText measured;
        measured.markRight = subX + textWidth(ctx, "UNZIPPED", 13.0f, Face::Bold, 0.10f);
        measured.statusW = textWidth(ctx, state, 14.0f, Face::Bold, 0.06f);
        measured.showPill = app.dirty;
        measured.tabW.push_back(textWidth(ctx, name, 13.0f, Face::Bold, 0.12f));
        // The ink, not the line box: what a reader lines up is the capitals, and the face's ascent above
        // them is not its descender space below (Sprint 9 P4). The bar hands the measurements over exactly
        // as it already hands over the widths, and the arithmetic stays where the test can reach it.
        const InkBox markInk = capInk(ctx, 15.0f, Face::Bold);
        const InkBox subInk = capInk(ctx, 13.0f, Face::Bold);
        const InkBox stateInk = capInk(ctx, 14.0f, Face::Bold);
        measured.markY = markY;
        measured.markCapTop = markInk.top;
        measured.markCapH = markInk.height;
        measured.markSubCapTop = subInk.top;
        measured.markSubCapH = subInk.height;
        measured.statusCapTop = stateInk.top;
        measured.statusCapH = stateInk.height;
        const TopBarPlaces places = topBarPlaces(l, measured);

        text(ctx, "SOCOM II", Vec2{markX, markY}, 15.0f, theme::gold, Face::Bold, 0.08f);
        text(ctx, "UNZIPPED", Vec2{subX, places.markSubY}, 13.0f, theme::dim, Face::Bold, 0.10f);

        // The page tab: where you are, without taking a click.
        if (!places.tab.empty())
            textCenteredIn(ctx, name, places.tab[0], 13.0f, theme::alpha(theme::caption, 150), Face::Bold, 0.12f);

        // The state lamp and its word, moved here from the old header band.
        const Rgba lamp = app.running ? theme::goldHi : (app.discOk ? theme::lampGreen : theme::warn);
        fillCircle(ctx, places.lamp, 5.0f, lamp);
        strokeCircle(ctx, places.lamp, chrome::lampR, theme::alpha(lamp, 110), 1.5f);
        // Not textCenteredIn: that centres the LINE box in the bar, and an all-caps word's line box carries
        // empty descender space that pushes its letters above the lamp they sit beside (owner, 2026-09-20:
        // "the running text is not aligned with the yellow circle, it appears higher"). places.status is
        // exactly the measured width, so its left edge IS the centred position.
        text(ctx, state, Vec2{places.status.x, places.statusY}, 14.0f, theme::text, Face::Bold, 0.06f);

        // UNSAVED: only when there is something to save, and clicking it saves.
        if (app.dirty)
        {
            const bool over = hover == ChromeHit::UnsavedPill;
            fillRound(ctx, l.pill, l.pill.h * 0.5f, over ? theme::mix(theme::panelHi, theme::gold, 0.25f) : theme::panel);
            strokeRound(ctx, l.pill, l.pill.h * 0.5f, theme::gold, 1.5f);
            textCenteredIn(ctx, "UNSAVED", l.pill, 13.0f, theme::goldHi, Face::Bold, 0.06f);
        }

        drawWindowButton(ctx, l.minimize, 0, hover == ChromeHit::Minimize, maximized);
        drawWindowButton(ctx, l.maximize, 1, hover == ChromeHit::Maximize, maximized);
        drawWindowButton(ctx, l.close, 2, hover == ChromeHit::Close, maximized);
    }

    void drawRail(const ui::Ctx &ctx, ui::App &app, const std::vector<ui::Node> &rail)
    {
        using namespace ui;
        fillRect(ctx, app.frame.rail, theme::alpha(theme::panel, 170));
        fillRect(ctx, Rect{app.frame.rail.right() - 2.0f, app.frame.rail.y, 2.0f, app.frame.rail.h}, theme::line);

        // Sprint 10: the logo itself at the head of the rail, where the drawn wordmark was -- the site's
        // artwork, fitted to the rail's width with its own teal splash behind the trident, so the glow
        // that stood in for it is gone. The head is metrics::railTop tall; the rows start under it.
        const Rect head{app.frame.rail.x, app.frame.rail.y, app.frame.rail.w, metrics::railTop};
        drawImage(ctx, g_logo, Rect{head.x + 8.0f, head.y + 8.0f, head.w - 16.0f, head.h - 16.0f}, Rgba{0xFF, 0xFF, 0xFF, 0xFF});
        for (const Node &n : rail)
        {
            const bool current = n.page == app.nav.page;
            const bool live = hovered(ctx, n.r) || focused(ctx, n.id);
            if (current)
                fillRectGradient(ctx, n.r, theme::panelHi, theme::mix(theme::panelHi, theme::blue, 0.22f));
            else
                fillRect(ctx, n.r, live ? theme::panel : theme::alpha(theme::panel, 190));
            strokeRect(ctx, n.r, current ? theme::gold : (live ? theme::line : theme::alpha(theme::line, 120)), 2.0f);
            fillRect(ctx, Rect{n.r.x, n.r.y, 5.0f, n.r.h}, current ? theme::gold : theme::alpha(theme::line, 160));
            // Rajdhani, not the stencil: at this size the stencil's gaps eat the letters (the owner's
            // "illegible at smaller resolutions").
            const float size = metrics::bodySize - 1.0f;
            const float drawn = size;
            text(ctx, pageName(n.page), Vec2{n.r.x + 20.0f, n.r.y + (n.r.h - drawn * 1.2f) * 0.5f}, size,
                 current ? theme::goldHi : (live ? theme::text : theme::caption), Face::Bold, 0.06f);
            // Asked for, not done: the page changes in the next frame's input phase (focus.h, Nav::request).
            if (hit(ctx, n.r, n.id))
                app.nav.request(n.page);
        }
    }

    // The prompts: what the keys or the pad buttons do to whatever holds the focus.
    void drawPrompts(const ui::Ctx &ctx, ui::App &app, float x, float y, float height)
    {
        using namespace ui;
        const ui::GlyphFamily family = glyphFamilyFor(app.pad.name);
        const bool typing = !app.activeField.empty();
        const bool onRail = app.nav.onRail();
        const bool adjusts = adjustsHorizontally(app.nav.focus);

        struct Prompt
        {
            const char *key;
            const char *verb;
            int padFace;   // -1: not a face button
        };
        Prompt prompts[3];
        int count = 0;
        if (app.bind.state == ui::BindFlow::State::Listening)
        {
            // Sprint 10 Goal 8: the pad is being listened to, so the pad's own buttons cannot be prompts here --
            // every one of them is a candidate. Words instead: what to do, and the two ways out.
            prompts[count++] = Prompt{"ANY", "BIND", -1};
            prompts[count++] = Prompt{"HOLD B", "CANCEL", -1};
            prompts[count++] = Prompt{"ESC", "CANCEL", -1};
        }
        else if (app.holdHost != 0 && app.holdProgress > 0.12f)
        {
            // W9: a hold is building. Same reasoning as the listening row above -- every pad button is a
            // candidate right now, so the row speaks words: what is happening, and the way out of it.
            prompts[count++] = Prompt{"HOLDING", "REMAP", -1};
            prompts[count++] = Prompt{"LET GO", "CANCEL", -1};
        }
        else if (typing)
        {
            prompts[count++] = Prompt{"TYPE", "EDIT", -1};
            // padFace 1 = the bottom face button: a pad player leaves the field with it (2026-09-22), and the
            // prompt has to say so, or the way out is invisible to the player who needs it most.
            prompts[count++] = Prompt{"ENTER", "DONE", 1};
        }
        else if (onRail)
        {
            prompts[count++] = Prompt{"UP/DN", "MOVE", -1};
            prompts[count++] = Prompt{"ENTER", "OPEN", 1};
        }
        else
        {
            prompts[count++] = Prompt{adjusts ? "LT/RT" : "ARROWS", adjusts ? "ADJUST" : "MOVE", -1};
            prompts[count++] = Prompt{"ENTER", "SELECT", 1};
            // W9: on the CONTROLLER page the third slot is the gesture, not BACK. The gesture is the one
            // thing on that page a player cannot discover by looking; BACK is on every other page, is the
            // rail entry one step to the left, and is Escape, which no player has to be told about.
            if (app.nav.page == ui::Page::Controller && app.pad.present)
                prompts[count++] = Prompt{"HOLD", "REMAP", -1};
            else
                prompts[count++] = Prompt{"ESC", "BACK", 3};
        }
        for (int i = 0; i < count; ++i)
        {
            float w = 0.0f;
            if (app.padPrompts && prompts[i].padFace >= 0)
                w = drawPadPrompt(ctx, Vec2{x, y}, family, prompts[i].padFace, height, theme::text);
            else
                w = drawKeyCap(ctx, Vec2{x, y}, prompts[i].key, height, theme::text);
            x += w + 8.0f;
            text(ctx, prompts[i].verb, Vec2{x, y + (height - 15.0f * 1.12f) * 0.5f}, 15.0f, theme::dim, Face::Bold);
            x += textWidth(ctx, prompts[i].verb, 15.0f, Face::Bold) + 22.0f;
        }
    }

    void drawBar(const ui::Ctx &ctx, ui::App &app, const std::vector<ui::Node> &nodes)
    {
        using namespace ui;
        const Rect bar = app.frame.bar;
        fillRect(ctx, bar, theme::panel);
        fillRect(ctx, Rect{0.0f, bar.y, bar.w, 2.0f}, theme::line);

        const std::string profile = app.config.profile.empty() ? std::string("player") : app.config.profile;
        text(ctx, "PROFILE", Vec2{metrics::margin, bar.y + 10.0f}, 13.0f, theme::dim, Face::Bold);
        text(ctx, profile.c_str(), Vec2{metrics::margin, bar.y + 26.0f}, 19.0f, theme::text, Face::Bold);

        const bool onPlay = app.nav.page == Page::Play;
        const Rect launch = onPlay ? barLaunchRect(app.frame) : rectOf(nodes, barLaunchId(app.nav.page));
        // Issue #74: the focused control's tooltip -- the same line the hover box shows, here so a keyboard or a
        // pad gets it too. Whole, never cut: wrapped into the slot (footerTipSlot, tips.h), one line or two; the
        // test measures every CONTROLLER line in the real face against it. One line: the status steps under it.
        // Two lines fill the slot, so the status gives way -- but from each time it is said until the focus next
        // moves (StatusWatch), when it shows alone and the tip waits. Not on the rail, not while typing, not while
        // the pad is being listened to (the prompts are the whole story then).
        const bool quiet = app.nav.onRail() || !app.activeField.empty() || app.bind.state == BindFlow::State::Listening;
        const std::string tip =
            quiet ? std::string() : tipFor(app.nav.page, app.nav.focus, TipState{&app.config, glyphFamilyFor(app.pad.name), &app.bind});
        // The columns come from the slot, so the slot the test measures is the one drawn (tips.h, kBar*).
        const Rect slot = footerTipSlot(app.frame);
        const float statusX = slot.x;
        const float promptsX = slot.right() + kBarTipGap;
        std::vector<std::string> lines;
        if (!tip.empty())
            lines = wrapWords(tip, slot.w, [&ctx](const std::string &s) { return textWidth(ctx, s.c_str(), kFooterTipSize); });
        static StatusWatch statusWatch;
        statusWatch.update(app.statusSerial, app.nav.focus);
        if (lines.size() > 1u && !app.status.empty() && !ctx.fake && statusWatch.fresh())
            lines.clear();
        if (lines.size() > kFooterTipLines)
        {
            // Only a line the test has not seen (another page's, one day): the rest of it is still better than a
            // third line through the bar's edge.
            lines.resize(kFooterTipLines);
            lines.back() = ellipsizeEnd(ctx, lines.back() + " ...", slot.w, kFooterTipSize);
        }
        // The type never drops under 13 real pixels, so at the minimum window a line is taller than its size says.
        const float drawn = std::max(kFooterTipSize, static_cast<float>(metrics::minTextPx) / (ctx.scale * ctx.dpi));
        const float lineH = drawn * 1.12f;
        const float top = lines.size() > 1u ? bar.y + (bar.h - lineH * static_cast<float>(lines.size())) * 0.5f : bar.y + 9.0f;
        for (size_t i = 0; i < lines.size(); ++i)
            text(ctx, lines[i].c_str(), Vec2{slot.x, top + lineH * static_cast<float>(i)}, kFooterTipSize, theme::text);
        if (!app.status.empty() && lines.size() < 2u)
        {
            const float size = lines.empty() ? 16.0f : 14.0f;
            const std::string shown = ellipsizeEnd(ctx, app.status, slot.w, size);
            text(ctx, shown.c_str(), Vec2{statusX, bar.y + (lines.empty() ? 20.0f : 30.0f)}, size, theme::dim);
        }
        drawPrompts(ctx, app, promptsX, bar.y + 12.0f, 26.0f);

        const std::string blocked = launchBlockedReason(app.discOk, app.running, app.config.isoPath.empty(), app.discMessage);
        if (onPlay)
        {
            // PLAY has its own large LAUNCH; a second one here would be the same button twice. The state of
            // the last run goes in its place.
            const std::string state = app.running
                                          ? std::string("the game is running")
                                          : (!blocked.empty() ? blocked
                                                              : (app.exitLine.empty() ? std::string("ready to launch") : app.exitLine));
            const Rgba ink = app.running ? theme::goldHi : (blocked.empty() ? theme::dim : theme::warn);
            const std::string shown = ellipsizeEnd(ctx, state, launch.w + 40.0f, 17.0f);
            text(ctx, shown.c_str(), Vec2{launch.right() - textWidth(ctx, shown.c_str(), 17.0f), launch.y + 9.0f}, 17.0f, ink);
        }
        else if (button(ctx, launch, app.running ? "RUNNING" : "LAUNCH", barLaunchId(app.nav.page), blocked.empty(), true))
            app.requestLaunch = true;
    }

    // Issue #74: the hover box -- the control's one line, beside it, once the mouse has rested there for
    // kTipDelaySeconds. Drawn last in the frame, over the focus ring, with the page's own panel and gold rule.
    void drawHoverTip(const ui::Ctx &ctx, ui::App &app, const std::vector<ui::Node> &nodes, const ui::HoverTip &hover)
    {
        using namespace ui;
        if (!hover.shows(ctx.time))
            return;
        const std::string line = tipFor(app.nav.page, hover.id, TipState{&app.config, glyphFamilyFor(app.pad.name), &app.bind});
        const Rect control = rectOf(nodes, hover.id);
        if (line.empty() || !drawable(control))
            return;
        const float size = metrics::captionSize - 1.0f;
        const float maxW = app.frame.window.w - 32.0f;
        const std::string shown = ellipsizeEnd(ctx, line, maxW - 24.0f, size);
        const Rect box = tipBox(control, textWidth(ctx, shown.c_str(), size) + 24.0f, size * 1.12f + 14.0f, app.frame.window);
        fillRect(ctx, box, theme::alpha(theme::panelHi, 245));
        strokeRect(ctx, box, theme::gold, 1.5f);
        text(ctx, shown.c_str(), Vec2{box.x + 12.0f, box.y + 7.0f}, size, theme::text);
    }

    // The content panel and its title strip: the page's name, then either the page's one-line subtitle or --
    // Sprint 10 (owner, 2026-09-20: "the alert overlays the disc area") -- the help for whatever holds the
    // focus. P4 anchored the help under the focused control, and under DISC IMAGE is the verdict panel;
    // under PROFILE the ADVANCED disclosure; under DEAD ZONE the mouse-look toggle: four of the six helps
    // sat on top of the page. The strip is the one place on every page that nothing else is drawn in
    // (Frame::band; the tests hold every page's layout out of it), so the help lives there, with the "?"
    // badge that says what it is, and the subtitle steps aside while it shows.
    void drawContentFrame(const ui::Ctx &ctx, ui::App &app)
    {
        using namespace ui;
        const Rect c = app.frame.content;
        panel(ctx, c);
        const Rect band = app.frame.band;
        fillRect(ctx, band, theme::panelHi);
        fillRect(ctx, Rect{band.x, band.bottom(), band.w, 2.0f}, theme::line);

        // The name, its capitals centred in the strip (capInk: what a reader lines up is the ink).
        const float nameSize = 22.0f;
        const InkBox nameInk = capInk(ctx, nameSize, Face::Bold);
        const float mid = band.cy();
        text(ctx, pageName(app.nav.page), Vec2{band.x + 18.0f, mid - nameInk.height * 0.5f - nameInk.top}, nameSize,
             theme::goldHi, Face::Bold, 0.08f);
        const float nameW = textWidth(ctx, pageName(app.nav.page), nameSize, Face::Bold, 0.08f);
        const float afterName = band.x + 30.0f + nameW;

        const std::string help = helpFor(app.nav.focus);
        if (help.empty())
        {
            const char *title = pageTitle(app.nav.page);
            const char *dash = std::strstr(title, "-- ");
            const std::string sub = dash != nullptr ? std::string(dash + 3) : std::string(title);
            const float room = band.right() - 30.0f - afterName;
            const InkBox subInk = capInk(ctx, metrics::captionSize, Face::Body);
            text(ctx, ellipsizeEnd(ctx, sub, room, metrics::captionSize).c_str(),
                 Vec2{afterName, mid - subInk.height * 0.5f - subInk.top}, metrics::captionSize, theme::caption);
            return;
        }

        // The badge, then the help in at most two lines. Every help text is two lines at the design width;
        // a longer one (or a narrower strip) drops one type size before it is cut, never a third line.
        const Vec2 badge{afterName + 12.0f, mid};
        fillCircle(ctx, badge, 9.0f, theme::alpha(theme::gold, 45));
        strokeCircle(ctx, badge, 9.0f, theme::alpha(theme::gold, 200), 1.5f);
        const InkBox q = capInk(ctx, 14.0f, Face::Bold);
        const float qW = textWidth(ctx, "?", 14.0f, Face::Bold);
        text(ctx, "?", Vec2{badge.x - qW * 0.5f, badge.y - q.height * 0.5f - q.top}, 14.0f, theme::goldHi, Face::Bold);

        const float x = badge.x + 20.0f;
        const float w = band.right() - 18.0f - x;
        float size = metrics::captionSize;
        std::vector<std::string> lines = wrapText(ctx, help, w, size);
        if (lines.size() > 2u)
        {
            size = metrics::captionSize - 2.0f;
            lines = wrapText(ctx, help, w, size);
        }
        if (lines.size() > 2u)
        {
            lines.resize(2);
            lines[1] = ellipsizeEnd(ctx, lines[1] + " ...", w, size);
        }
        const float lineH = size * 1.30f;
        const float top = mid - lineH * static_cast<float>(lines.size()) * 0.5f;
        for (size_t i = 0; i < lines.size(); ++i)
            text(ctx, lines[i].c_str(), Vec2{x, top + lineH * static_cast<float>(i)}, size, theme::text);
    }

    void drawPage(const ui::Ctx &ctx, ui::App &app, const std::vector<ui::Node> &nodes)
    {
        switch (app.nav.page)
        {
        case ui::Page::Play: ui::drawPlayPage(ctx, app, nodes); break;
        case ui::Page::Disc: ui::drawDiscPage(ctx, app, nodes); break;
        case ui::Page::Video: ui::drawVideoPage(ctx, app, nodes); break;
        case ui::Page::Audio: ui::drawAudioPage(ctx, app, nodes); break;
        case ui::Page::Controller: ui::drawControllerPage(ctx, app, nodes); break;
        case ui::Page::Microphone: ui::drawMicrophonePage(ctx, app, nodes); break;
        case ui::Page::Online: ui::drawOnlinePage(ctx, app, nodes); break;
        case ui::Page::Report: ui::drawReportPage(ctx, app, nodes); break;
        case ui::Page::About: ui::drawAboutPage(ctx, app, nodes); break;
        }
    }

    // ---- the pad, as the drawing and the navigation both see it ---------------------------------------------

    int shownSlot(const launcher::Config &config)
    {
        if (config.gamepadIndex >= 0)
            return config.gamepadIndex;
        for (int i = 0; i < 4; ++i)
            if (IsGamepadAvailable(i))
                return i;
        return -1;
    }

    float triggerValue(int slot, int axis, int button)
    {
        if (GetGamepadAxisCount(slot) > axis)
        {
            const float v = (GetGamepadAxisMovement(slot, axis) + 1.0f) * 0.5f;
            if (v > 0.001f)
                return v > 1.0f ? 1.0f : v;
        }
        return IsGamepadButtonDown(slot, button) ? 1.0f : 0.0f;
    }

    ui::PadSnapshot pollPad(int slot)
    {
        ui::PadSnapshot pad;
        if (slot < 0 || !IsGamepadAvailable(slot))
            return pad;
        pad.present = true;
        const char *name = GetGamepadName(slot);
        pad.name = name != nullptr ? name : "";
        auto set = [&](ui::PadElement e, int button) { pad.down[static_cast<int>(e)] = IsGamepadButtonDown(slot, button); };
        set(ui::PadElement::DpadUp, GAMEPAD_BUTTON_LEFT_FACE_UP);
        set(ui::PadElement::DpadDown, GAMEPAD_BUTTON_LEFT_FACE_DOWN);
        set(ui::PadElement::DpadLeft, GAMEPAD_BUTTON_LEFT_FACE_LEFT);
        set(ui::PadElement::DpadRight, GAMEPAD_BUTTON_LEFT_FACE_RIGHT);
        set(ui::PadElement::FaceUp, GAMEPAD_BUTTON_RIGHT_FACE_UP);
        set(ui::PadElement::FaceDown, GAMEPAD_BUTTON_RIGHT_FACE_DOWN);
        set(ui::PadElement::FaceLeft, GAMEPAD_BUTTON_RIGHT_FACE_LEFT);
        set(ui::PadElement::FaceRight, GAMEPAD_BUTTON_RIGHT_FACE_RIGHT);
        set(ui::PadElement::Select, GAMEPAD_BUTTON_MIDDLE_LEFT);
        set(ui::PadElement::Start, GAMEPAD_BUTTON_MIDDLE_RIGHT);
        set(ui::PadElement::LeftStickClick, GAMEPAD_BUTTON_LEFT_THUMB);
        set(ui::PadElement::RightStickClick, GAMEPAD_BUTTON_RIGHT_THUMB);
        pad.shoulder[0] = IsGamepadButtonDown(slot, GAMEPAD_BUTTON_LEFT_TRIGGER_1);
        pad.shoulder[1] = IsGamepadButtonDown(slot, GAMEPAD_BUTTON_RIGHT_TRIGGER_1);
        pad.trigger[0] = triggerValue(slot, GAMEPAD_AXIS_LEFT_TRIGGER, GAMEPAD_BUTTON_LEFT_TRIGGER_2);
        pad.trigger[1] = triggerValue(slot, GAMEPAD_AXIS_RIGHT_TRIGGER, GAMEPAD_BUTTON_RIGHT_TRIGGER_2);
        pad.leftStick = ui::Vec2{GetGamepadAxisMovement(slot, GAMEPAD_AXIS_LEFT_X), GetGamepadAxisMovement(slot, GAMEPAD_AXIS_LEFT_Y)};
        pad.rightStick = ui::Vec2{GetGamepadAxisMovement(slot, GAMEPAD_AXIS_RIGHT_X), GetGamepadAxisMovement(slot, GAMEPAD_AXIS_RIGHT_Y)};
        return pad;
    }

    // ---- the fake state the screenshots are taken on (it never touches config.json) --------------------------

    ui::PadSnapshot fakeXboxPad()
    {
        ui::PadSnapshot pad;
        pad.present = true;
        pad.name = "Xbox Wireless Controller";
        pad.down[static_cast<int>(ui::PadElement::FaceDown)] = true;   // A
        pad.down[static_cast<int>(ui::PadElement::DpadUp)] = true;
        pad.shoulder[0] = true;   // LB
        pad.trigger[1] = 0.7f;
        pad.leftStick = ui::Vec2{0.6f, -0.4f};
        return pad;
    }

    ui::PadSnapshot fakePlayStationPad()
    {
        ui::PadSnapshot pad = fakeXboxPad();
        pad.name = "Wireless Controller";
        return pad;
    }

    void fillFakeState(ui::App &app)
    {
        app.fake = true;
        app.config = launcher::Config{};
        app.config.isoPath = "D:\\games\\SOCOM II - U.S. Navy SEALs (USA).iso";
        // the default preset (the project's hosted server), so the ONLINE page's screenshot shows what a stranger sees
        app.config.profile = "player";
        app.config.micDevice = "Headset (USB)";
        app.discChecked = true;
        app.discOk = true;
        app.discMessage = "SOCOM II U.S. Navy SEALs NTSC r0001";
        app.setStatus("ready");
        app.exitLine = launcher::exitMessage(0);
        app.padLabels = {"first available", "[0] Xbox Wireless Controller"};
        app.padSlots = {-1, 0};
        app.pad = fakeXboxPad();
        app.micLabels = {"None", "Headset (USB)", "Microphone (Realtek High Definition Audio)"};
        app.meterOn = true;
        app.micDb = -18.0f;
        app.micDbValid = true;
        app.micStatus = "listening";
        app.configPath = "C:\\games\\socom2\\config.json";
        app.logsPath = "C:\\games\\socom2\\logs";
        app.version = "SOCOM Unzipped -- sprint 8 build";
        app.monitorSize = "2560x1440";
        app.layout.padChoices = static_cast<int>(app.padLabels.size());
        app.layout.micChoices = static_cast<int>(app.micLabels.size());
        app.layout.customServer = false;   // the default preset owns the address
        // Sprint 10 Q4: the AUDIO page's line under the sounds toggle, as a first run with a verified disc shows it.
        app.menuSoundsStatus = "from your disc: cache/menu_sounds/8c1f2a9b4d3e7f60";
    }

    // ---- Sprint 10 Q4: the launcher's own cues, out of the player's disc -------------------------------------
    // The four HUD sounds (launcher/menu_sounds.h), decoded the first time a verified disc is seen and cached
    // under <home>/cache/menu_sounds/<key>/, loaded through raylib's audio and played on the events below.
    // No disc, a disc that did not verify, the setting off, or no audio device: nothing is loaded and the
    // AUDIO page's line says which. Quiet on purpose (kMenuSoundVolume): these are the launcher's clicks, not
    // the game's mix, and the owner asked for the game's voice, not its loudness.
    constexpr float kMenuSoundVolume = 0.45f;

    struct MenuSounds
    {
        bool deviceReady = false;
        bool loaded = false;
        Sound cue[static_cast<int>(launcher::menusounds::Cue::Count)]{};

        void unload()
        {
            if (!loaded)
                return;
            for (Sound &s : cue)
                UnloadSound(s);
            loaded = false;
        }

        void play(launcher::menusounds::Cue c) const
        {
            if (loaded)
                PlaySound(cue[static_cast<int>(c)]);
        }
    };

    // (Re)loads the cues from the cache, building it from the ISO when it is not there. Sets the page's line.
    void refreshMenuSounds(MenuSounds &menu, ui::App &app, const fs::path &home)
    {
        namespace ms = launcher::menusounds;
        menu.unload();
        if (!app.config.menuSounds)
        {
            app.menuSoundsStatus = "off";
            return;
        }
        if (!menu.deviceReady)
        {
            app.menuSoundsStatus = "no audio device: silent";
            return;
        }
        if (!app.discOk)
        {
            app.menuSoundsStatus = app.config.isoPath.empty() ? "no disc set yet: silent until one is (DISC page)"
                                                              : "the disc did not verify: silent";
            return;
        }
        const iso9660::Reader read = iso9660::fileReader(app.config.isoPath);
        const std::string key = ms::isoKey(read);
        if (key.empty())
        {
            app.menuSoundsStatus = "the disc image cannot be read: silent";
            return;
        }
        const std::string dir = ms::cacheDir(home.string(), key);
        std::string why;
        if (!ms::cacheComplete(dir) && !ms::buildCache(read, dir, why))
        {
            app.menuSoundsStatus = "no HUD sounds in this image (" + why + "): silent";
            std::fprintf(stderr, "[launcher] menu sounds: %s\n", why.c_str());
            return;
        }
        for (int i = 0; i < static_cast<int>(ms::Cue::Count); ++i)
        {
            const fs::path file = fs::path(dir) / ms::cueFile(static_cast<ms::Cue>(i));
            menu.cue[i] = LoadSound(file.string().c_str());
            SetSoundVolume(menu.cue[i], kMenuSoundVolume);
        }
        menu.loaded = true;
        app.menuSoundsStatus = "from your disc: " + fs::path(dir).lexically_relative(home).generic_string();
    }
}

int main(int argc, char **argv)
{
    const fs::path dir = win32glue::exeDirectory();
    const fs::path configPath = dir / "config.json";
    if (argc > 2 && std::strcmp(argv[1], "--diagnostics") == 0)
    {
        // Sprint 9 Goal 1: the zip without the window -- for a report from a machine where the launcher
        // itself will not open, and for tools_py/tests/test_diagnostics_zip.py. Answered before this
        // launcher's own config.json is read, so <dir> is the only folder it looks at.
        std::string message;
        const bool ok = saveDiagnostics(argc > 3 ? fs::path(argv[3]) : dir, fs::path(argv[2]), std::string(), false, 0, message);
        std::printf("%s\n", message.c_str());
        return ok ? 0 : 1;
    }

    if (argc > 2 && std::strcmp(argv[1], "--report-bug") == 0)
        return reportBugHeadless(fs::path(argv[2]), argc > 3 ? fs::path(argv[3]) : dir);
    if (argc > 4 && std::strcmp(argv[1], "--fetch-patch") == 0)
        return fetchPatchHeadless(fs::path(argv[2]), argv[3], argv[4]);
    if (argc > 1 && std::strcmp(argv[1], "--server-status") == 0)
    {
        const std::string line = br::statusLine(fetchStats());
        if (!line.empty())
            std::printf("%s\n", line.c_str());
        return line.empty() ? 1 : 0;   // silent when unreachable, as the ONLINE page is
    }

    // Task 11: which game builds are installed beside the launcher -- one bit per kGameRevisions row, each
    // probed by that row's OWN exeName. Asked here, once, and handed to the UI: a page never touches the
    // disk. The loop is the point (Sprint 11 review, Important 1): this named kGameRevisions[1] directly
    // until then, so a third revision would have been invisible here and reported installed whenever
    // r0004 was. A row is a row -- adding one needs no change in this file.
    uint32_t gameRevisionsInstalled = 0;
    for (size_t i = 0; i < launcher::kGameRevisionCount; ++i)
    {
        const char *exe = launcher::kGameRevisions[i].exeName;
        std::error_code ec;
        if (exe[0] != '\0' && fs::is_regular_file(dir / exe, ec))
            gameRevisionsInstalled |= 1u << i;
    }

    launcher::Config config;
    {
        const std::string text = readText(configPath);
        if (!text.empty() && !launcher::fromJson(text, config))
            std::fprintf(stderr, "config.json is malformed; using the defaults\n");
        // Task 11: fromJson cannot see the disk, so the clamp is here -- a config naming a build that is
        // not installed (a folder copied from a machine that had it) plays the disc's own build rather
        // than leaving the launcher pointing at an executable that is not there.
        if (!launcher::gameRevisionAvailable(launcher::gameRevisionIndex(config.gameRevision), gameRevisionsInstalled))
            config.gameRevision = launcher::kGameRevisions[0].id;
    }

    if (argc > 1 && std::strcmp(argv[1], "--selftest") == 0)
    {
        std::printf("config: %s\n", configPath.string().c_str());
        const DiscStatus st = checkDisc(config.isoPath);
        std::printf("disc: %s -> %s\n", config.isoPath.c_str(), st.message.c_str());
        for (const std::string &kv : launcher::environmentFor(config))
            std::printf("env: %s\n", kv.c_str());
        for (const std::string &line : launcher::selftestExitLines())
            std::printf("%s\n", line.c_str());
        return writeText(configPath, launcher::toJson(config)) ? 0 : 1;
    }

    if (argc > 1 && std::strcmp(argv[1], "--launch-test") == 0)
    {
        // Starts the game the way the Launch button does, waits, and reports whether it ran: the environment
        // plumbing end to end, without a hand on the button.
        const int seconds = argc > 2 ? std::atoi(argv[2]) : 12;
        win32glue::GameProcess game;
        if (!win32glue::startGame(dir.string(), config, game))
        {
            std::printf("launch failed: %s\n", game.error.c_str());
            return 2;
        }
        std::printf("started; log %s\n", game.logPath.c_str());
        const auto until = std::chrono::steady_clock::now() + std::chrono::seconds(seconds);
        while (game.running() && std::chrono::steady_clock::now() < until)
            std::this_thread::sleep_for(std::chrono::milliseconds(200));
        const bool stillRunning = game.running();
        std::printf("after %d s: %s\n", seconds, stillRunning ? "running" : "exited");
        win32glue::terminate(game);
        game.close();
        return stillRunning ? 0 : 3;
    }

    const char *screenshotDir = (argc > 2 && std::strcmp(argv[1], "--screenshot") == 0) ? argv[2] : nullptr;
    // How many frames the walk settles before it captures. Three by default, as it always was -- and that
    // default is exactly why a one-frame defect never appeared in a screenshot. The page is set AFTER the
    // frame at count 0 is drawn, so count 1 is the last frame of the OLD page and count 2 is the FIRST
    // frame of the new one: --shot-frames 2 is the repro for the top-left flash, and the proof it is gone.
    int shotFrames = 3;
    for (int i = 1; i + 1 < argc; ++i)
        if (std::strcmp(argv[i], "--shot-frames") == 0)
            shotFrames = std::max(1, std::atoi(argv[i + 1]));

    // HIGHDPI is what a player wants and what a screenshot must not have: the PNGs are asked for at exact
    // pixel sizes.
    // MSAA for every curved edge (the owner: "the circle at the top right ... jagged at odd resolutions");
    // HIGHDPI so the type is rasterised at real pixels, except under --screenshot where the PNGs must come
    // out at exactly the asked-for size.
    SetConfigFlags(FLAG_MSAA_4X_HINT | FLAG_WINDOW_RESIZABLE | (screenshotDir != nullptr ? 0u : FLAG_WINDOW_HIGHDPI));
    InitWindow(static_cast<int>(ui::metrics::designW), static_cast<int>(ui::metrics::designH), "SOCOM Unzipped");
    SetWindowMinSize(static_cast<int>(ui::metrics::minW), static_cast<int>(ui::metrics::minH));
    if (screenshotDir == nullptr)
    {
        // Sprint 7 review finding, kept: a 700 px window plus DPI scaling can still be taller than a laptop
        // panel, so the window opens at whatever the monitor allows.
        const int monitorHeight = GetMonitorHeight(GetCurrentMonitor());
        if (monitorHeight > 0)
            SetWindowSize(static_cast<int>(ui::metrics::designW),
                          launcher::fitWindowHeight(static_cast<int>(ui::metrics::designH), monitorHeight, 80));
    }
    SetTargetFPS(60);
    SetExitKey(KEY_NULL);
    // Sprint 10 Q4: raylib's audio for the menu cues. Not under --screenshot (no device is touched there), and a
    // machine with no output device simply has no cues (IsAudioDeviceReady says so; nothing else is affected).
    MenuSounds menu;
    if (screenshotDir == nullptr)
    {
        InitAudioDevice();
        menu.deviceReady = IsAudioDeviceReady();
        if (!menu.deviceReady)
            std::fprintf(stderr, "[launcher] no audio device: the menu sounds stay silent\n");
    }

    // The custom title bar. On Windows the window keeps its frame (resize, snap, shadow) and only loses the
    // caption; everywhere else raylib gives us an undecorated window and we drag it ourselves.
    // --screenshot asks for exact client sizes; the Windows frame trick makes the client cover the whole
    // window, and the two disagree by the frame's thickness for a frame or two -- which lands in the PNG as
    // a shifted capture. The screenshots use an undecorated window instead: the bar below is ours either way.
    if (screenshotDir == nullptr)
    {
        g_nativeChrome = win32glue::installCustomChrome(GetWindowHandle(), chromeHitForSystem);
        if (!g_nativeChrome)
            SetWindowState(FLAG_WINDOW_UNDECORATED);
    }
    else
    {
        SetWindowState(FLAG_WINDOW_UNDECORATED);
    }

    {
        // The owner's report was "illegible at the default resolution", so the default resolution says so.
        const Vector2 dpi = GetWindowScaleDPI();
        std::fprintf(stderr, "[launcher] window %dx%d screen, %dx%d render, dpi %.2f, scale %.3f, monitor %dx%d\n",
                     GetScreenWidth(), GetScreenHeight(), GetRenderWidth(), GetRenderHeight(), dpi.x,
                     static_cast<double>(ui::scaleFor(GetScreenWidth(), GetScreenHeight())),
                     GetMonitorWidth(GetCurrentMonitor()), GetMonitorHeight(GetCurrentMonitor()));
    }

    ui::Fonts fonts;   // rasterised per pixel size, rebuilt when the scale changes
    {
        // Sprint 10 Q4: the crest as the window's icon (taskbar, title bar), the same one the game window gets.
        Image icon = LoadImageFromMemory(".png", kImage_SocomUnzippedIcon, kImage_SocomUnzippedIcon_len);
        if (icon.data != nullptr)
        {
            if (icon.format != PIXELFORMAT_UNCOMPRESSED_R8G8B8A8)
                ImageFormat(&icon, PIXELFORMAT_UNCOMPRESSED_R8G8B8A8);
            SetWindowIcon(icon);
            UnloadImage(icon);
        }
        Image logo = LoadImageFromMemory(".png", kImage_SocomUnzippedLogo, kImage_SocomUnzippedLogo_len);
        if (logo.data != nullptr)
        {
            g_logo = LoadTextureFromImage(logo);
            UnloadImage(logo);
            GenTextureMipmaps(&g_logo);
            SetTextureFilter(g_logo, TEXTURE_FILTER_TRILINEAR);
        }
        if (g_logo.id == 0)
            std::fprintf(stderr, "[launcher] the embedded logo would not decode; the rail's head stays empty\n");
    }

    ui::App app;
    app.config = config;
    app.configPath = configPath.string();
    app.logsPath = (dir / "logs").string();
    app.version = readText(dir / "version.txt");
    while (!app.version.empty() && (app.version.back() == '\n' || app.version.back() == '\r'))
        app.version.pop_back();

    win32glue::GameProcess game;
    std::string lastLog;
    long long lastExitRaw = 0;
    bool haveLastExit = false;
    std::unique_ptr<launcher::MicDevices> mic;
    bool meterOn = false;

    if (screenshotDir != nullptr)
    {
        fillFakeState(app);
    }
    else
    {
        app.gameRevisionsInstalled = gameRevisionsInstalled;   // Task 11 (the walk fixes it per shot instead)
        const DiscStatus st = checkDisc(app.config.isoPath);
        app.discChecked = st.checked;
        app.discOk = st.ok;
        app.discMessage = st.message;
        app.setStatus(st.ok ? "ready" : "");
        mic = launcher::makeMicDevices();
        app.micLabels = launcher::micLabels(*mic);
        meterOn = !app.config.micDevice.empty() && mic->startMeter(app.config.micDevice);
        app.meterOn = meterOn;
        refreshMenuSounds(menu, app, dir);
    }

    // Sprint 9 Goal 8: the two requests this window ever makes, each on its own worker.
    Worker<ReportOutcome> reportJob;
    Worker<std::string> statsJob;
    br::Inputs reportIn;
    double statsAskedAt = -1000.0;
    ui::Page previousPage = ui::Page::Play;

    ui::Nav &nav = app.nav;
    nav.page = ui::Page::Play;
    nav.focus = ui::railId(ui::Page::Play);

    ui::FocusRing ring;
    ui::HoverTip hoverTip;   // issue #74: which control the mouse rests on, and since when
    float lastScale = -1.0f;
    bool quitRequested = false;
    bool dragging = false;
    Vector2 dragGrab{};
    double pageChangedAt = -1.0;
    ui::Page lastPage = nav.page;
    Vector2 lastMouse = GetMousePosition();
    double padRepeatAt = 0.0;

    // --screenshot walks the pages itself; the interactive loop runs until the window closes.
    struct Shot
    {
        ui::Page page;
        int w, h;
        const char *suffix;
    };
    std::vector<Shot> shots;
    if (screenshotDir != nullptr)
    {
        const int sizes[2][2] = {{1100, 700}, {800, 520}};
        for (const auto &size : sizes)
            for (int i = 0; i < ui::kPageCount; ++i)
                shots.push_back(Shot{ui::pageAt(i), size[0], size[1], ""});
        shots.push_back(Shot{ui::Page::Controller, 1100, 700, "_playstation"});
        // R139: the crouch shortcut on each control -- the row, the trade's line, and the mark on the drawing.
        shots.push_back(Shot{ui::Page::Controller, 1100, 700, "_crouch_l3"});
        shots.push_back(Shot{ui::Page::Controller, 800, 520, "_crouch_l3"});
        shots.push_back(Shot{ui::Page::Controller, 1100, 700, "_crouch_touchpad"});
        shots.push_back(Shot{ui::Page::Controller, 1100, 700, "_crouch_l2"});
        // Sprint 10 Goal 8: the BUTTONS section -- the defaults, a custom layout with its callouts, a cell
        // listening with its countdown, a conflict's three answers, the restore confirm, and the PlayStation
        // family's shapes in the cells.
        shots.push_back(Shot{ui::Page::Controller, 1100, 700, "_buttons"});
        shots.push_back(Shot{ui::Page::Controller, 800, 520, "_buttons"});
        shots.push_back(Shot{ui::Page::Controller, 1100, 700, "_buttons_custom"});
        shots.push_back(Shot{ui::Page::Controller, 1100, 700, "_buttons_listening"});
        shots.push_back(Shot{ui::Page::Controller, 1100, 700, "_buttons_conflict"});
        shots.push_back(Shot{ui::Page::Controller, 1100, 700, "_buttons_restore"});
        shots.push_back(Shot{ui::Page::Controller, 1100, 700, "_buttons_playstation"});
        // Sprint 10 Q4: the window switch's cell bound to VIEW (a custom binding, its callout on the drawing),
        // and its two-answer conflict dialog.
        shots.push_back(Shot{ui::Page::Controller, 1100, 700, "_buttons_switch"});
        shots.push_back(Shot{ui::Page::Controller, 1100, 700, "_buttons_switch_conflict"});
        // Task 11: the GAME VERSION selector at the plan's two sizes, on both pages that carry it. The
        // 1100x700 captures are the plain ones above; 900x600 is not in the generic pair (which is
        // 1100x700 and the 800x520 minimum), so it is asked for here.
        shots.push_back(Shot{ui::Page::Play, 900, 600, ""});
        shots.push_back(Shot{ui::Page::Online, 900, 600, ""});
        // ... and the state the selector cannot reach until an r0004 build exists: that build installed and
        // chosen, against the project server, which is the REVERSE mismatch warning. The forward one (the
        // community server on the r0001 build) gets no picture on purpose -- it cannot be reached without
        // forcing a preset the launcher heals away, and the forced page then shows a placeholder address
        // that misrepresents it. Its sentence is asserted in launcher_tests.cpp instead.
        shots.push_back(Shot{ui::Page::Play, 1100, 700, "_r0004"});
        shots.push_back(Shot{ui::Page::Online, 1100, 700, "_r0004"});
        // The owner's own config named the community server; this is what the page does with it.
        shots.push_back(Shot{ui::Page::Online, 1100, 700, "_community_healed"});
        // Sprint 9 P4: the ADVANCED section in both of its states. Shut is the ordinary `online`
        // capture above; this one has the second instance switched ON, which forces the section open
        // and marks it "in use" -- the state a disclosure must never be able to hide.
        shots.push_back(Shot{ui::Page::Online, 1100, 700, "_advanced"});
        // Sprint 9 P4: the focus on the profile field, which is the one the owner asked for by name
        // ("what is a profile?"). The help is shown where the FOCUS is, so a capture of it needs one.
        shots.push_back(Shot{ui::Page::Online, 1100, 700, "_help"});
        // Sprint 10 Goal 9: both fields filled -- the name readable, the password as marks -- at both sizes.
        shots.push_back(Shot{ui::Page::Online, 1100, 700, "_credentials"});
        shots.push_back(Shot{ui::Page::Online, 800, 520, "_credentials"});
        // Sprint 9 Goal 8: the hosted server's status line, and the REPORT A BUG page in each of its states
        // (the plain report_<size>.png above is the empty form).
        shots.push_back(Shot{ui::Page::Online, 1100, 700, "_status"});
        shots.push_back(Shot{ui::Page::Online, 800, 520, "_status"});
        for (const char *state : {"_filled", "_sent", "_saved", "_fielderror", "_ratelimited", "_sending"})
        {
            shots.push_back(Shot{ui::Page::Report, 1100, 700, state});
            shots.push_back(Shot{ui::Page::Report, 800, 520, state});
        }
    }
    const char *selfShot = ps2x::knob("PS2X_LAUNCHER_SHOT");
    unsigned selfShotFrames = 0;
    size_t shotIndex = 0;
    int shotFrame = 0;
    int resizeWaits = 0;
    // Sprint 9 P4: the walk used to change the page straight after a frame was drawn, which is a
    // moment no player can produce -- the next frame then built its node list from the new page and
    // everything lined up. Real input changes the page in the MIDDLE of a frame, after that list is
    // built, and that is the frame the owner's top-left flash lives on. The walk now asks for the
    // page the same way, so a PNG can see what a player sees.
    int shotPendingPage = -1;
    std::string shotPendingFocus;

    while (!WindowShouldClose() && !quitRequested)
    {
        const float scale = ui::scaleFor(GetScreenWidth(), GetScreenHeight());
        if (scale != lastScale)
        {
            fonts.clear();   // every raster in the cache is the wrong size now
            lastScale = scale;
        }
        const float dpiScale = GetWindowScaleDPI().x > 0.1f ? GetWindowScaleDPI().x : 1.0f;
        g_uiScale = scale;
        g_uiDpi = dpiScale;
        g_uiMaximized = win32glue::isWindowMaximized() || IsWindowMaximized();
        const ui::Rect window{0.0f, 0.0f, static_cast<float>(GetScreenWidth()) / scale,
                              static_cast<float>(GetScreenHeight()) / scale};
        app.frame = ui::frameFor(window);

        // ---- what the world says this frame ---------------------------------------------------------------
        if (screenshotDir == nullptr)
        {
            const int slot = shownSlot(app.config);
            app.pad = pollPad(slot);
            app.padLabels.assign(1, "first available");
            app.padSlots.assign(1, -1);
            for (int i = 0; i < 4; ++i)
                if (IsGamepadAvailable(i))
                {
                    app.padLabels.push_back(std::string("[") + std::to_string(i) + "] " + GetGamepadName(i));
                    app.padSlots.push_back(i);
                }
            app.running = game.running();
            if (!app.running && game.process)
            {
                // Sprint 9 Goal 1: every ending has a sentence (ps2x/exit_codes.h), and a non-fatal notice
                // in the log -- no audio device -- rides along with it.
                lastExitRaw = game.exitCode();
                haveLastExit = true;
                game.close();
                app.exitLine = launcher::lastRunLine(lastExitRaw, readHead(lastLog, 256u * 1024u));
                app.setStatus(app.exitLine);
                // Review F8: the meter gives the capture device back to the game while it runs; take it now.
                meterOn = !app.config.micDevice.empty() && mic->startMeter(app.config.micDevice);
            }
            app.meterOn = meterOn;
            const float db = meterOn ? mic->levelDb() : -INFINITY;
            app.micDbValid = std::isfinite(db);
            app.micDb = app.micDbValid ? db : -60.0f;
            app.monitorSize = launcher::monitorSizeOrEmpty(GetMonitorWidth(GetCurrentMonitor()),
                                                           GetMonitorHeight(GetCurrentMonitor()));
            app.layout.padChoices = static_cast<int>(app.padLabels.size());
            app.layout.micChoices = static_cast<int>(app.micLabels.size());
            const launcher::ServerPreset *preset = launcher::findServerPreset(app.config.serverPreset);
            app.layout.customServer = preset == nullptr || preset->address[0] == '\0';
        }

        // Sprint 9 P4: the player's drawer, unless something inside it is doing something. This is
        // derived from state the launcher already holds, not polled from the world, so it belongs
        // OUT here -- inside the block above it would be skipped under --screenshot, and the
        // ADVANCED capture would show a section that says "in use" over nothing at all.
        app.layout.advancedOpen = app.advancedOpen || ui::advancedForced(app.config);
        app.layout.gameRevisionsInstalled = app.gameRevisionsInstalled;   // Task 11: a greyed cell is drawn, never focusable
        // Sprint 10 Goal 8: the CONTROLLER page's section, and whether a bind dialog has replaced its controls.
        app.layout.padButtons = app.padSection == 1;
        app.layout.padDialogButtons = ui::dialogButtonCount(app.bind);

        const ui::FocusGraph graph = ui::FocusGraph::build(window, app.layout);
        // A page the last frame's draw asked for (a rail click, a PLAY row's CHANGE) lands here, before
        // the frame's list is built, so the list and the page never disagree (focus.h, Nav::request).
        nav.applyRequest(graph);
        const std::vector<ui::Node> rail = ui::railLayout(window);
        std::vector<ui::Node> nodes = ui::layoutFor(nav.page, window, app.layout);
        if (graph.find(nav.focus) == nullptr)
            nav.focus = ui::railId(nav.page);   // the list under the focus changed (a pad was unplugged)

        // ---- input ----------------------------------------------------------------------------------------
        const std::string focusBefore = nav.focus;   // Q4: a move is a focus that changed by the end of the frame
        bool cueSelect = false, cueBack = false;
        ui::Ctx ctx;
        ctx.scale = scale;
        ctx.dpi = dpiScale;
        ctx.fonts = &fonts;
        const Vector2 mouse = GetMousePosition();
        ctx.mouse = ui::Vec2{mouse.x / scale, mouse.y / scale};
        ctx.mouseMoved = (mouse.x != lastMouse.x || mouse.y != lastMouse.y);
        if (ctx.mouseMoved)
            lastMouse = mouse;
        const bool mouseMovedNow = ctx.mouseMoved;   // issue #74: the hover's arming reads this frame's, not the sticky one
        static bool mouseEverMoved = false;
        mouseEverMoved = mouseEverMoved || ctx.mouseMoved;
        ctx.mouseMoved = mouseEverMoved;
        ctx.click = IsMouseButtonPressed(MOUSE_BUTTON_LEFT);
        ctx.held = IsMouseButtonDown(MOUSE_BUTTON_LEFT);
        ctx.focus = nav.focus;
        ctx.focusOut = &nav.focus;
        ctx.activeField = &app.activeField;
        bool fieldTookClick = false;
        ctx.fieldTookClick = &fieldTookClick;
        ctx.time = GetTime();
        ctx.fake = app.fake;

        // The bar's own mouse handling: the same hit test the system asks, in screen units.
        const ui::ChromeHit chromeHover =
            app.fake ? ui::ChromeHit::Client
                     : ui::chromeHitTest(static_cast<int>(mouse.x), static_cast<int>(mouse.y), GetScreenWidth(),
                                         GetScreenHeight(), scale, g_uiMaximized);
        if (!app.fake && ctx.click)
        {
            switch (chromeHover)
            {
            case ui::ChromeHit::Minimize:
                if (g_nativeChrome)
                    win32glue::minimizeWindow();
                else
                    MinimizeWindow();
                ctx.click = false;
                break;
            case ui::ChromeHit::Maximize:
                if (g_nativeChrome)
                    win32glue::maximizeToggleWindow();
                else if (IsWindowMaximized())
                    RestoreWindow();
                else
                    MaximizeWindow();
                ctx.click = false;
                break;
            case ui::ChromeHit::Close:
                quitRequested = true;
                ctx.click = false;
                break;
            case ui::ChromeHit::UnsavedPill:
                if (app.dirty)
                    app.requestSave = true;
                ctx.click = false;
                break;
            case ui::ChromeHit::Caption:
                // Without native chrome the launcher drags its own window.
                if (!g_nativeChrome)
                {
                    dragging = true;
                    dragGrab = Vector2{mouse.x, mouse.y};
                }
                ctx.click = false;
                break;
            default:
                break;
            }
        }
        if (dragging)
        {
            if (!IsMouseButtonDown(MOUSE_BUTTON_LEFT))
                dragging = false;
            else
            {
                const Vector2 at = GetWindowPosition();
                SetWindowPosition(static_cast<int>(at.x + mouse.x - dragGrab.x),
                                  static_cast<int>(at.y + mouse.y - dragGrab.y));
            }
        }

        // Sprint 10 Goal 8: while a bind session listens, every host button is a candidate and none of them
        // navigates -- the frame's pad reading goes to the flow and nowhere else, and the keyboard's only word
        // is Escape. Released, not pressed (bind_flow.h says why); the button that STARTED the session (A on
        // the cell) is still down on this frame and is ignored until it comes back up.
        static double s_downSince[18] = {};
        static bool s_ignoreDown[18] = {};
        // W9 (2026-09-22): the hold-a-button-to-remap watch, carried between frames like padRepeatAt. The
        // decision is ui::padHold's (pure, behind the pad gate); this loop only feeds it what raylib says
        // and turns a fired hold into the bind session that already existed.
        static ui::HoldWatch s_hold;
        app.holdHost = 0;
        app.holdProgress = 0.0f;
        const bool listening = app.bind.state == ui::BindFlow::State::Listening;
        // Sprint 10 Q4: the guide button, once a frame, from raylib (a DirectInput pad on Windows, any pad on
        // Linux) OR from XInput's hidden entry point (an Xbox pad on Windows, whose guide bit XInputGetState
        // hides -- win32_glue.h has the measurement). Its edges feed the bind loop and the pad gate below.
        static bool s_guideWasDown = false;
        bool guideDown = false, guidePressed = false, guideReleased = false;
        if (!app.fake)
        {
            const int padSlot = shownSlot(app.config);
            const bool padPresent = padSlot >= 0 && IsGamepadAvailable(padSlot);
            guideDown = (padPresent && IsGamepadButtonDown(padSlot, GAMEPAD_BUTTON_MIDDLE)) || win32glue::xinputGuideDown();
            guidePressed = guideDown && !s_guideWasDown;
            guideReleased = !guideDown && s_guideWasDown;
            s_guideWasDown = guideDown;
        }
        bool toggleWindows = false;
        if (!app.fake && listening)
        {
            const int padSlot = shownSlot(app.config);
            const bool padPresent = padSlot >= 0 && IsGamepadAvailable(padSlot);
            ui::BindInput in;
            in.escape = IsKeyPressed(KEY_ESCAPE);
            for (int h = 1; h <= launcher::mapping::kHostButtonMax; ++h)
            {
                const bool guide = h == launcher::mapping::kHostGuide;
                const bool down = padPresent && (guide ? guideDown : IsGamepadButtonDown(padSlot, h));
                if (down && s_downSince[h] == 0.0)
                    s_downSince[h] = ctx.time;
                if (padPresent && (guide ? guideReleased : IsGamepadButtonReleased(padSlot, h)))
                {
                    if (s_ignoreDown[h])
                        s_ignoreDown[h] = false;
                    else if (in.releasedHost == 0)
                    {
                        in.releasedHost = h;
                        in.heldSeconds = s_downSince[h] > 0.0 ? ctx.time - s_downSince[h] : 0.0;
                    }
                }
                if (!down)
                    s_downSince[h] = 0.0;
            }
            launcher::mapping::Mapping m = launcher::activeMapping(app.config);
            const uint8_t bound = app.bind.button;
            const ui::GlyphFamily family = ui::glyphFamilyFor(app.pad.name);
            switch (ui::bindStep(app.bind, m, in, ctx.time))
            {
            case ui::BindEvent::Bound:
            {
                if (bound == ui::kSwitchTarget)
                {
                    // Sprint 10 Q4: the window switch is the launcher's, not the mapping's.
                    app.config.focusToggle = launcher::mapping::hostButtonName(app.bind.lastHost);
                    app.dirty = true;
                    app.setStatus(std::string("the window switch is now ") + ui::hostLabel(family, app.bind.lastHost).text);
                    break;
                }
                launcher::setActiveMapping(app.config, m);
                app.dirty = true;
                const int row = launcher::mapping::rowOf(bound);
                const int host = row >= 0 ? m.pad[static_cast<size_t>(row)].host : launcher::mapping::kHostNone;
                app.setStatus(std::string(ui::ps2Label(bound).text) + " is now " + ui::hostLabel(family, host).text);
                break;
            }
            case ui::BindEvent::Conflict:
                nav.focus = ui::dialogFocusId(app.bind);
                break;
            case ui::BindEvent::Cancelled:
                app.setStatus("binding cancelled");
                break;
            case ui::BindEvent::TimedOut:
                app.setStatus("no button pressed; binding unchanged");
                break;
            default:
                break;
            }
            app.padPrompts = true;
            s_hold = ui::HoldWatch{};   // a session is open: the gesture has nothing left to start
        }
        else if (!app.fake)
        {
            const bool typing = !app.activeField.empty();
            const int padSlot = shownSlot(app.config);
            const bool padPresent = padSlot >= 0 && IsGamepadAvailable(padSlot);

            // Sprint 9 Goal 9 (P3): every pad reading goes through ONE gate, which knows the game may own
            // the pad. raylib reads the pad whether or not this window has focus, so before this the
            // player's stick walked the launcher's focus ring while they were aiming with it.
            ui::PadFrame padFrame;
            padFrame.present = padPresent;
            if (padPresent)
            {
                auto edge = [&](ui::PadNav nav_, int button)
                { padFrame.pressed[static_cast<int>(nav_)] = IsGamepadButtonPressed(padSlot, button); };
                edge(ui::PadNav::Left, GAMEPAD_BUTTON_LEFT_FACE_LEFT);
                edge(ui::PadNav::Right, GAMEPAD_BUTTON_LEFT_FACE_RIGHT);
                edge(ui::PadNav::Up, GAMEPAD_BUTTON_LEFT_FACE_UP);
                edge(ui::PadNav::Down, GAMEPAD_BUTTON_LEFT_FACE_DOWN);
                edge(ui::PadNav::Activate, GAMEPAD_BUTTON_RIGHT_FACE_DOWN);
                edge(ui::PadNav::Back, GAMEPAD_BUTTON_RIGHT_FACE_RIGHT);
                edge(ui::PadNav::PagePrev, GAMEPAD_BUTTON_LEFT_TRIGGER_1);
                edge(ui::PadNav::PageNext, GAMEPAD_BUTTON_RIGHT_TRIGGER_1);
                edge(ui::PadNav::Launch, GAMEPAD_BUTTON_MIDDLE_RIGHT);
                // Sprint 10 Q4: the window switch's button -- the guide (through the read above) or whatever the
                // player bound in its place; "none" presses nothing.
                const int toggleHost = launcher::focusToggleHost(app.config);
                padFrame.pressed[static_cast<int>(ui::PadNav::Toggle)] =
                    toggleHost == launcher::mapping::kHostGuide ? guidePressed
                                                                : (toggleHost != launcher::mapping::kHostNone && IsGamepadButtonPressed(padSlot, toggleHost));
                padFrame.leftX = GetGamepadAxisMovement(padSlot, GAMEPAD_AXIS_LEFT_X);
                padFrame.leftY = GetGamepadAxisMovement(padSlot, GAMEPAD_AXIS_LEFT_Y);
            }
            const ui::PadIntent padWants = ui::padIntent(padFrame, app.running, ctx.time, padRepeatAt);
            toggleWindows = padWants.toggle;

            // ---- W9: hold a pad button to remap it (the owner, 2026-09-22) -------------------------------
            // The same gate, one gesture wide. A hold is a duration, not an edge, so this reads the frame's
            // DOWN state for every host button (the guide through the read above, which XInput hides);
            // ui::padHold refuses it while the game runs, while a field holds the keyboard, and anywhere but
            // the CONTROLLER page with no session already open. No page ever reaches for raylib itself.
            ui::HoldFrame holdFrame;
            holdFrame.present = padPresent;
            if (padPresent)
                for (int h = 1; h <= launcher::mapping::kHostButtonMax; ++h)
                    holdFrame.down[h] = h == launcher::mapping::kHostGuide ? guideDown : IsGamepadButtonDown(padSlot, h);
            const bool holdPageArmed = nav.page == ui::Page::Controller
                                       && app.bind.state == ui::BindFlow::State::Idle && app.requestBind < 0;
            const ui::HoldIntent holdWants =
                ui::padHold(s_hold, holdFrame, app.running, typing, holdPageArmed, ctx.time);
            app.holdHost = holdWants.host;
            app.holdProgress = holdWants.progress;
            if (holdWants.fired)
            {
                // What the held control DRIVES is what the session is for: hold the button you want to move,
                // then press where you want it -- and a clash is Goal 8's own Conflict dialog, because this
                // is Goal 8's own flow. The window switch is checked first: it takes no row of the mapping,
                // so boundTo would answer -1 for the very button a player is most likely to hold.
                const launcher::mapping::Mapping heldMapping = launcher::activeMapping(app.config);
                const int target = launcher::focusToggleHost(app.config) == holdWants.host
                                       ? static_cast<int>(ui::kSwitchTarget)
                                       : launcher::mapping::boundTo(heldMapping, holdWants.host);
                const ui::GlyphFamily heldFamily = ui::glyphFamilyFor(app.pad.name);
                if (target < 0)
                    app.setStatus(std::string(ui::hostLabel(heldFamily, holdWants.host).text) +
                                  " drives nothing yet -- open its row below to give it a button");
                else
                {
                    // BUTTONS is where the cell and any conflict dialog live; a hold begun in SETUP lands
                    // the player where the answer is (the section switch applies on the next frame's
                    // layout, exactly as it does when the player clicks it).
                    app.padSection = 1;
                    app.requestBind = target;
                    nav.focus = target == static_cast<int>(ui::kSwitchTarget)
                                    ? std::string(ui::kSwitchCellId)
                                    : "pad.bind." + std::string(launcher::mapping::ps2ButtonName(
                                                        static_cast<uint8_t>(target)));
                }
                app.padPrompts = true;
            }

            if (typing)
            {
                if (ui::releasesField(IsKeyPressed(KEY_ENTER), IsKeyPressed(KEY_ESCAPE), IsKeyPressed(KEY_TAB),
                                      padWants, false))
                    app.activeField.clear();
            }
            else
            {
                const bool adjusts = ui::adjustsHorizontally(nav.focus);
                int dx = 0, dy = 0;
                if (IsKeyPressed(KEY_LEFT) || IsKeyPressedRepeat(KEY_LEFT))
                    dx -= 1;
                if (IsKeyPressed(KEY_RIGHT) || IsKeyPressedRepeat(KEY_RIGHT))
                    dx += 1;
                if (IsKeyPressed(KEY_UP) || IsKeyPressedRepeat(KEY_UP))
                    dy -= 1;
                if (IsKeyPressed(KEY_DOWN) || IsKeyPressedRepeat(KEY_DOWN))
                    dy += 1;
                // The d-pad and the left stick (with its repeat) arrive already gated.
                dx += padWants.dx;
                dy += padWants.dy;
                if (dx != 0 || dy != 0)
                    app.padPrompts = padWants.prompts && !(IsKeyDown(KEY_LEFT) || IsKeyDown(KEY_RIGHT) || IsKeyDown(KEY_UP) || IsKeyDown(KEY_DOWN));

                if (adjusts && dx != 0)
                    ctx.adjust = dx;
                else if (dx < 0)
                    nav.move(graph, ui::Dir::Left);
                else if (dx > 0)
                    nav.move(graph, ui::Dir::Right);
                if (dy < 0)
                    nav.move(graph, ui::Dir::Up);
                else if (dy > 0)
                    nav.move(graph, ui::Dir::Down);

                if (IsKeyPressed(KEY_TAB))
                {
                    const std::vector<std::string> ids = graph.idsOn(nav.page);
                    size_t at = 0;
                    for (size_t i = 0; i < ids.size(); ++i)
                        if (ids[i] == nav.focus)
                            at = i + 1;
                    if (!ids.empty())
                        nav.focus = ids[at % ids.size()];
                }
                ctx.activate = IsKeyPressed(KEY_ENTER) || IsKeyPressed(KEY_SPACE) || padWants.activate;
                cueSelect = ctx.activate;
                if (IsKeyPressed(KEY_ESCAPE) || padWants.back)
                {
                    nav.back(graph);
                    cueBack = true;
                }
                if (padWants.pagePrev)
                    nav.goTo(graph, ui::pageAt(ui::pageIndex(nav.page) - 1));
                if (padWants.pageNext)
                    nav.goTo(graph, ui::pageAt(ui::pageIndex(nav.page) + 1));
                if (padWants.launch)
                    app.requestLaunch = true;
                if (IsKeyPressed(KEY_F5))
                    app.requestVerify = true;
                if (padWants.activate || padWants.back)
                    app.padPrompts = true;
            }
            if (IsKeyPressed(KEY_ENTER) || IsKeyPressed(KEY_ESCAPE) || IsKeyPressed(KEY_TAB) ||
                IsKeyPressed(KEY_LEFT) || IsKeyPressed(KEY_RIGHT) || IsKeyPressed(KEY_UP) || IsKeyPressed(KEY_DOWN))
                app.padPrompts = false;
        }
        // --screenshot's page change, applied exactly where the pad's and the keyboard's is.
        if (shotPendingPage >= 0)
        {
            nav.goTo(graph, ui::pageAt(shotPendingPage));
            if (!shotPendingFocus.empty())
                nav.focus = shotPendingFocus;
            shotPendingPage = -1;
            shotPendingFocus.clear();
        }
        ctx.focus = nav.focus;

        // The input above can have changed the page (the pad's shoulder tabs, Escape, a rail entry). The
        // list built at the top of this frame is then the PREVIOUS page's, and drawing the new page out of
        // it makes every lookup miss: rectOf answers the origin, and a label centred there is the one-frame
        // flash at the top left the owner reported (Sprint 9 P4). The list the frame draws from is the
        // page's own; widgets.cpp's drawable() guard covers what this cannot -- the rail click at
        // drawRail(), which changes the page in the middle of the draw itself.
        nodes = ui::nodesForFrame(std::move(nodes), nav.page, window, app.layout);

        // ---- draw -----------------------------------------------------------------------------------------
        BeginDrawing();
        ClearBackground(ui::rl(ui::theme::ground));
        ui::groundGrid(ctx, window);
        drawTopBar(ctx, app, chromeHover, g_uiMaximized);
        drawRail(ctx, app, rail);
        drawContentFrame(ctx, app);
        drawPage(ctx, app, nodes);
        drawBar(ctx, app, nodes);

        // Clicking away from a text field releases the keyboard (2026-09-22). Every widget has now been
        // offered this frame's click; if none of the editable ones took it, the click was elsewhere and the
        // field that held the keyboard lets go -- which is what makes the pad work again without a keypress.
        if (!app.activeField.empty()
            && ui::releasesField(false, false, false, ui::PadIntent{}, !app.fake && ctx.click && !fieldTookClick))
            app.activeField.clear();

        // A 120 ms wipe on a page change, so the pane arrives rather than snapping.
        if (nav.page != lastPage)
        {
            lastPage = nav.page;
            pageChangedAt = ctx.time;
        }
        if (!app.fake && pageChangedAt > 0.0)
        {
            const float t = static_cast<float>((ctx.time - pageChangedAt) / 0.12);
            if (t < 1.0f)
                ui::fillRect(ctx, app.frame.content, ui::theme::alpha(ui::theme::ground,
                                                                     static_cast<unsigned char>(200.0f * (1.0f - t))));
            else
                pageChangedAt = -1.0;
        }

        // The focus ring: on the focused control's rect, this frame, whole -- and drawn last, after the
        // pane's wipe, so nothing fades it in on the frame it lands (Sprint 8 owner feedback).
        ring.update(graph, nav.focus, GetFrameTime());
        if (ring.visible)
            ui::focusRing(ctx, ring.shown);
        // Issue #74: the hover is armed by the mouse moving this frame and disarmed by any keyboard or pad steering
        // (a focus the input moved, an activation, an adjust, back) until the mouse moves again, so a box never
        // sits over the pad's focus ring. Never under --screenshot, and not while the pad is being listened to.
        const bool steered = (nav.focus != focusBefore && !ctx.click) || ctx.activate || ctx.adjust != 0 || cueBack;
        hoverTip.frame(mouseMovedNow, steered,
                       !app.fake && app.bind.state != ui::BindFlow::State::Listening ? ui::nodeAt(nodes, ctx.mouse) : std::string(),
                       ctx.time);
        drawHoverTip(ctx, app, nodes, hoverTip);
        EndDrawing();

        // ---- Sprint 10 Q4: the cues, from what the frame did. One per frame, in this order: a refused LAUNCH
        // (the thing the player just tried), back, select (Enter / A, or a click that took), then a focus that
        // moved -- never a move on top of a select, so opening a page is one click, not two.
        if (!app.fake && menu.loaded)
        {
            namespace ms = launcher::menusounds;
            // A click counts when it landed on a control (hit() takes the focus, but a control that already
            // had it is still a click); a click on nothing is nothing.
            bool clicked = false;
            if (ctx.click)
            {
                for (const ui::Node &n : nodes)
                    clicked = clicked || n.r.contains(ctx.mouse);
                for (const ui::Node &n : rail)
                    clicked = clicked || n.r.contains(ctx.mouse);
            }
            const bool refused = app.requestLaunch && (app.running || !app.discOk);
            if (refused)
                menu.play(ms::Cue::Refuse);
            else if (cueBack)
                menu.play(ms::Cue::Back);
            else if (cueSelect || clicked)
                menu.play(ms::Cue::Select);
            else if (nav.focus != focusBefore)
                menu.play(ms::Cue::Move);
        }

        // ---- what the pages asked for ---------------------------------------------------------------------
        if (!app.fake)
        {
            if (app.requestBrowse)
            {
                const std::string chosen = win32glue::browseForIso();
                if (!chosen.empty())
                {
                    app.config.isoPath = chosen;
                    app.dirty = true;
                    app.requestVerify = true;
                }
            }
            if (app.requestVerify)
            {
                const DiscStatus st = checkDisc(app.config.isoPath);
                app.discChecked = st.checked;
                app.discOk = st.ok;
                app.discMessage = st.message;
                app.setStatus(st.ok ? "disc verified" : st.message);
                refreshMenuSounds(menu, app, dir);   // Q4: a new disc is a new set of cues (or none)
            }
            if (app.requestMenuSounds)
                refreshMenuSounds(menu, app, dir);
            if (app.requestMicRescan)
            {
                app.micLabels = launcher::micLabels(*mic);
                app.micStatus = TextFormat("%d capture device(s)", static_cast<int>(app.micLabels.size()) - 1);
            }
            if (app.requestMicChanged)
            {
                mic->stopMeter();
                meterOn = !app.config.micDevice.empty() && mic->startMeter(app.config.micDevice);
                app.micStatus = app.config.micDevice.empty() ? "" : (meterOn ? "listening" : "that device will not open");
            }
            if (app.requestSave)
            {
                writeText(configPath, launcher::toJson(app.config));
                app.dirty = false;
                app.setStatus("settings saved");
            }
            if (app.requestDiagnostics)
            {
                std::string message;
                if (saveDiagnostics(dir, fs::path(), lastLog, haveLastExit, lastExitRaw, message))
                    win32glue::openFolder((dir / "diagnostics").string());
                app.setStatus(message);
            }
            if (app.requestOpenLogs)
                win32glue::openFolder((dir / "logs").string());
            // Sprint 10 Q4: the window switch. padIntent only ever raises it while the game runs; the glue
            // decides which of the two windows is behind and brings it forward.
            if (toggleWindows)
            {
                std::string why;
                if (win32glue::toggleForeground(GetWindowHandle(), game, why))
                    app.setStatus("switched windows");
                else
                {
                    app.setStatus("window switch: " + why);
                    std::fprintf(stderr, "[launcher] window switch: %s\n", why.c_str());
                }
            }

            // ---- Sprint 9 Goal 8: the status line. Asked for when ONLINE opens (never within 5 s of the
            // last ask) and every 10 s while it stays open; the answer lands in a slot this thread polls.
            const bool pageEntered = nav.page != previousPage;
            previousPage = nav.page;
            if (nav.page == ui::Page::Online && !statsJob.busy() &&
                ctx.time - statsAskedAt >= (pageEntered ? 5.0 : static_cast<double>(br::kStatsPollSeconds)))
            {
                statsAskedAt = ctx.time;
                statsJob.start(fetchStats);
            }
            std::string statsBody;
            if (statsJob.poll(statsBody))
                app.serverStatus = br::statusLine(statsBody);   // "" when unreachable: the line is not drawn

            // ---- the report: what would be sent, the send, the reply ------------------------------------
            ui::ReportUi &report = app.report;
            if (nav.page == ui::Page::Report && pageEntered)
            {
                reportIn = reportInputs(dir, lastLog, haveLastExit, lastExitRaw);
                report.changed = true;
            }
            if (nav.page == ui::Page::Report && report.changed)
            {
                report.preview = br::previewLine(br::build(app.config, report.form, reportIn), report.form);
                report.changed = false;
            }
            if (report.requestSend && report.state != ui::ReportUi::State::Sending)
            {
                const std::string problem = br::checkForm(report.form);
                if (!problem.empty())
                {
                    report.state = ui::ReportUi::State::FieldError;
                    report.message = problem;
                    const std::string field = br::fieldOf(problem);
                    if (field == "title" || field == "description" || field == "contact")
                        nav.focus = app.activeField = "report." + field;
                }
                else
                {
                    reportIn = reportInputs(dir, lastLog, haveLastExit, lastExitRaw);
                    const std::string json = br::buildPayload(app.config, report.form, reportIn);
                    report.state = ui::ReportUi::State::Sending;
                    report.message.clear();
                    report.savedPath.clear();
                    app.activeField.clear();
                    reportJob.start([dir, json]() { return sendReport(dir, json); });
                }
            }
            report.requestSend = false;
            ReportOutcome outcome;
            if (reportJob.poll(outcome))
            {
                if (!outcome.transportError.empty())
                    std::fprintf(stderr, "[report] %s\n", outcome.transportError.c_str());
                report.message = outcome.reply.text;
                report.savedPath = outcome.savedPath;
                switch (outcome.reply.kind)
                {
                case br::Reply::Kind::Sent:
                    report.state = ui::ReportUi::State::Sent;
                    report.id = outcome.reply.id;
                    report.copied = !report.id.empty();
                    if (report.copied)
                        SetClipboardText(report.id.c_str());
                    // The report is in: the form empties so a second press cannot send it twice.
                    report.form.title.clear();
                    report.form.description.clear();
                    report.changed = true;
                    app.setStatus(outcome.reply.text);
                    break;
                case br::Reply::Kind::FieldError:
                {
                    report.state = ui::ReportUi::State::FieldError;
                    const std::string field = outcome.reply.field;
                    if (nav.page == ui::Page::Report && (field == "title" || field == "description" || field == "contact"))
                        nav.focus = app.activeField = "report." + field;
                    break;
                }
                case br::Reply::Kind::RateLimited:
                    report.state = ui::ReportUi::State::RateLimited;
                    break;
                case br::Reply::Kind::Failed:
                    report.state = ui::ReportUi::State::SavedLocally;
                    break;
                }
            }
            if (app.requestLaunch && !app.running && app.discOk)
            {
                writeText(configPath, launcher::toJson(app.config));
                app.dirty = false;
                mic->stopMeter();   // Review F8: two processes must not hold the same microphone
                meterOn = false;
                if (win32glue::startGame(dir.string(), app.config, game))
                {
                    lastLog = game.logPath;
                    app.setStatus("started; log " + fs::path(game.logPath).filename().string());
                    app.exitLine.clear();
                }
                else
                    app.setStatus(game.error);
            }
        }
        // Sprint 10 Goal 8: a cell asked to bind. The host buttons down right now (A, which activated the cell)
        // are remembered so their release does not bind them.
        if (app.requestBind >= 0)
        {
            if (!app.fake)
            {
                const int padSlot = shownSlot(app.config);
                const bool padPresent = padSlot >= 0 && IsGamepadAvailable(padSlot);
                for (int h = 1; h <= launcher::mapping::kHostButtonMax; ++h)
                {
                    s_ignoreDown[h] = padPresent && (h == launcher::mapping::kHostGuide ? guideDown : IsGamepadButtonDown(padSlot, h));
                    s_downSince[h] = 0.0;
                }
            }
            ui::bindStart(app.bind, static_cast<uint8_t>(app.requestBind), ctx.time);
            app.setStatus("press the button on your pad");
            app.requestBind = -1;
        }
        app.requestBrowse = app.requestVerify = app.requestLaunch = app.requestSave = false;
        app.requestDiagnostics = app.requestOpenLogs = app.requestMenuSounds = false;
        app.requestMicChanged = app.requestMicRescan = false;

        // PS2X_LAUNCHER_SHOT=<file>: the REAL window, with its own chrome, at whatever size it opened at --
        // a GDI or BitBlt grab of a GL window comes back white on this machine, so the launcher takes it.
        if (selfShot != nullptr && ++selfShotFrames == 120u)
        {
            Image shot = LoadImageFromScreen();
            if (!ExportImage(shot, selfShot))
                std::fprintf(stderr, "[launcher] could not write %s\n", selfShot);
            UnloadImage(shot);
            quitRequested = true;
        }

        // ---- --screenshot: three frames a page, then the PNG ------------------------------------------------
        if (screenshotDir != nullptr)
        {
            if (shotIndex >= shots.size())
                break;
            const Shot &shot = shots[shotIndex];
            if (shotFrame == 0)
            {
                if ((GetScreenWidth() != shot.w || GetScreenHeight() != shot.h) && resizeWaits < 90)
                {
                    SetWindowSize(shot.w, shot.h);
                    ++resizeWaits;
                    continue;   // let the resize land before the state is set
                }
                resizeWaits = 0;
                shotPendingPage = ui::pageIndex(shot.page);
                shotPendingFocus.clear();
                {
                    // Sprint 9 Goal 8: canned states, no request made.
                    const std::string suffix = shot.suffix;
                    app.activeField.clear();
                    app.serverStatus = suffix == "_status" ? "SOCOM Unzipped: online, 3 players, 1 game" : "";
                    ui::ReportUi &report = app.report;
                    report = ui::ReportUi{};
                    br::Inputs fakeIn;
                    fakeIn.version = app.version;
                    fakeIn.platform = "windows";
                    fakeIn.logText = "INFO:     > Renderer: NVIDIA GeForce RTX 4070 SUPER/PCIe/SSE2\nthe last run\n";
                    fakeIn.haveLastExit = true;
                    if (shot.page == ui::Page::Report && !suffix.empty())
                    {
                        report.form.title = "The game closes when I join a second round";
                        report.form.description =
                            "I hosted a Suppression room on Frostfire, played one round to the end, and when the second round "
                            "started loading the game window closed without a message. It happened twice in a row. The first "
                            "round was fine both times and voice chat worked.";
                        report.form.contact = "viper#1234 on Discord";
                        report.form.attachLog = true;
                    }
                    if (suffix == "_filled")
                        shotPendingFocus = app.activeField = "report.description";
                    else if (shot.page == ui::Page::Report)
                        shotPendingFocus = "report.send";
                    if (suffix == "_sending")
                        report.state = ui::ReportUi::State::Sending;
                    if (suffix == "_sent")
                    {
                        report.state = ui::ReportUi::State::Sent;
                        report.id = launcher::bugreport::kSampleShownId;
                        report.copied = true;
                        report.form.title.clear();
                        report.form.description.clear();
                    }
                    if (suffix == "_saved")
                    {
                        report.state = ui::ReportUi::State::SavedLocally;
                        report.message = br::parseReply(0, "").text;
                        report.savedPath = "C:\\games\\socom2\\logs\\bugreport_20260919_101500.json";
                    }
                    if (suffix == "_fielderror")
                    {
                        report.form.title = "abc";
                        report.state = ui::ReportUi::State::FieldError;
                        report.message = br::checkForm(report.form);
                        shotPendingFocus = app.activeField = "report.title";
                    }
                    if (suffix == "_ratelimited")
                    {
                        report.state = ui::ReportUi::State::RateLimited;
                        report.message = br::parseReply(429, "", 1500).text;
                        report.savedPath = "C:\\games\\socom2\\logs\\bugreport_20260919_101500.json";
                    }
                    report.preview = br::previewLine(br::build(app.config, report.form, fakeIn), report.form);
                    report.changed = false;
                }
                const bool touchpadShot = std::strcmp(shot.suffix, "_crouch_touchpad") == 0;
                const bool playstationShot = std::strcmp(shot.suffix, "_playstation") == 0 || std::strcmp(shot.suffix, "_buttons_playstation") == 0;
                app.pad = (playstationShot || touchpadShot) ? fakePlayStationPad() : fakeXboxPad();
                app.config.crouchShortcut = std::strncmp(shot.suffix, "_crouch_", 8) == 0 ? shot.suffix + 8 : "off";
                // Sprint 10 Goal 8: the BUTTONS section's states. Every shot starts from SETUP, the defaults and an
                // idle flow; the _buttons* shots set what they show.
                {
                    const std::string suffix = shot.suffix;
                    app.padSection = suffix.rfind("_buttons", 0) == 0 ? 1 : 0;
                    app.bind = ui::BindFlow{};
                    app.config.mappings.clear();
                    launcher::mapping::Mapping m = launcher::mapping::defaults();
                    if (suffix == "_buttons_custom" || suffix == "_buttons_playstation")
                    {
                        // Triangle on the left stick click (swapped with L3), Select on the guide button.
                        launcher::mapping::rebind(m, launcher::mapping::kPs2Triangle, launcher::mapping::kHostL3, launcher::mapping::Resolution::Swap);
                        launcher::mapping::rebind(m, launcher::mapping::kPs2Select, launcher::mapping::kHostGuide, launcher::mapping::Resolution::Replace);
                        app.bind.lastHost = launcher::mapping::kHostL3;
                        app.bind.lastAt = 1.0e12;   // "just now", whatever the clock says: the ring is in the picture
                        shotPendingFocus = ui::bindCellId(3);   // Triangle's cell
                    }
                    if (suffix == "_buttons_listening")
                    {
                        ui::bindStart(app.bind, launcher::mapping::kPs2Triangle, 0.0);
                        app.bind.deadline = GetTime() + 3.2;   // three frames later the cell reads 4, then 3
                        shotPendingFocus = ui::bindCellId(3);
                    }
                    if (suffix == "_buttons_conflict")
                    {
                        app.bind.state = ui::BindFlow::State::Conflict;
                        app.bind.button = launcher::mapping::kPs2Triangle;
                        app.bind.host = launcher::mapping::kHostL3;
                        app.bind.takenBy = launcher::mapping::kPs2L3;
                        shotPendingFocus = ui::dialogFocusId(app.bind.state);
                    }
                    if (suffix == "_buttons_restore")
                    {
                        launcher::mapping::rebind(m, launcher::mapping::kPs2Triangle, launcher::mapping::kHostGuide, launcher::mapping::Resolution::Replace);
                        ui::restoreAsk(app.bind);
                        shotPendingFocus = ui::dialogFocusId(app.bind.state);
                    }
                    // Issue #74: Triangle's cell, whose tip wraps to two lines at 1100x700 -- the record that the
                    // bottom bar draws a two-line tip whole. Not the page's longest: the chosen crouch cell's
                    // "... (Set.)" line is; the measuring test in launcher_tests.cpp holds every line to two.
                    if (suffix == "_buttons")
                        shotPendingFocus = ui::bindCellId(3);
                    // Q4: the switch. Every shot starts from the guide; _buttons_switch has it on VIEW with the
                    // cell focused, _buttons_switch_conflict caught VIEW while SELECT still drives it.
                    app.config.focusToggle = suffix == "_buttons_switch" ? "select" : "guide";
                    if (suffix == "_buttons_switch")
                    {
                        // As the REPLACE answer leaves things: SELECT lost its pad button to the switch.
                        launcher::mapping::rebind(m, launcher::mapping::kPs2Select, launcher::mapping::kHostNone, launcher::mapping::Resolution::Replace);
                        app.bind.lastHost = launcher::mapping::kHostSelect;
                        app.bind.lastAt = 1.0e12;
                        shotPendingFocus = ui::kSwitchCellId;
                    }
                    if (suffix == "_buttons_switch_conflict")
                    {
                        app.bind.state = ui::BindFlow::State::Conflict;
                        app.bind.button = ui::kSwitchTarget;
                        app.bind.host = launcher::mapping::kHostSelect;
                        app.bind.takenBy = launcher::mapping::kPs2Select;
                        shotPendingFocus = ui::dialogFocusId(app.bind);
                    }
                    launcher::setActiveMapping(app.config, m);
                }
                app.config.secondInstance = std::strcmp(shot.suffix, "_advanced") == 0;
                if (std::strcmp(shot.suffix, "_help") == 0)
                    shotPendingFocus = "online.profile";
                // Sprint 10 Goal 9: the fake persona and password (invented values; the file is never written).
                const bool credentialsShot = std::strcmp(shot.suffix, "_credentials") == 0;
                app.config.loginName = credentialsShot ? "socomc" : "";
                app.config.loginPassword = credentialsShot ? "hunter2" : "";
                if (credentialsShot)
                    shotPendingFocus = "online.password";
                // Task 11: "_r0004" installs the community build and picks it, against the project server
                // that runs r0001 -- the reverse mismatch warning. Set on EVERY shot, not only that one:
                // the walk reuses a single App, so a version left behind by one capture would otherwise
                // reappear in every picture after it.
                const bool r0004Shot = std::strcmp(shot.suffix, "_r0004") == 0;
                app.gameRevisionsInstalled = r0004Shot ? (1u << launcher::gameRevisionIndex("r0004")) : 0u;
                app.config.gameRevision = r0004Shot ? "r0004" : "r0001";
                if (std::strcmp(shot.suffix, "_community_healed") == 0)
                {
                    // A saved config naming the unplayable preset: fromJson moves it to the one that exists.
                    launcher::Config saved;
                    launcher::fromJson("{\"serverPreset\": \"community\", \"server\": \"192.0.2.10\"}", saved);
                    app.config.serverPreset = saved.serverPreset;
                    app.config.server = saved.server;
                }
            }
            if (++shotFrame >= shotFrames)
            {
                char path[512];
                // The page's slug ("play", "report"): every page's name but REPORT A BUG's was already that.
                std::snprintf(path, sizeof(path), "%s/%s%s_%dx%d.png", screenshotDir, ui::pageSlug(shot.page).c_str(),
                              shot.suffix, shot.w, shot.h);
                for (char *p = path; *p != '\0'; ++p)
                    *p = static_cast<char>(*p >= 'A' && *p <= 'Z' ? *p + 32 : *p);
                Image frame = LoadImageFromScreen();
                if (!ExportImage(frame, path))
                    std::fprintf(stderr, "[launcher] could not write %s\n", path);
                UnloadImage(frame);
                ++shotIndex;
                shotFrame = 0;
            }
        }
    }

    if (!app.fake)
        writeText(configPath, launcher::toJson(app.config));
    if (mic)
        mic->stopMeter();
    game.close();
    fonts.clear();
    if (g_logo.id != 0)
        UnloadTexture(g_logo);
    menu.unload();
    if (menu.deviceReady)
        CloseAudioDevice();
    CloseWindow();
    // A request still in flight: the window is gone already, and each join is bounded by its request's timeout.
    reportJob.join();
    statsJob.join();
    return 0;
}
