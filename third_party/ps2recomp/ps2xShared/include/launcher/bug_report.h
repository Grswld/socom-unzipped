#pragma once

// Sprint 9 Goal 8: the launcher's REPORT A BUG page and the ONLINE page's status line, as pure functions.
// The service is the owner's own site (socomunzipped.com); its client-side reference is sites/s2u/src/report.ts
// (checkForm, buildPayload, replyText) and its inbox sites/s2u/api/bugs.mjs -- the field names, the limits and
// the wording here mirror those two files. Nothing in this header opens a socket: the transport lives in the
// launcher's glues (win32glue::httpRequest), and nothing leaves the machine until SEND is pressed.
//
// Privacy is Goal 1's machinery (launcher/diagnostics.h): the context comes from an allowlist of Config
// fields, the ISO is cut to its file name, the log is clipLog + scrub(homeDir) and then the contract's last
// 65,536 bytes. There is no credential in Config, and the memory card is never read.

#include "launcher/launcher_config.h"

#include <cstddef>
#include <string>
#include <utility>
#include <vector>

namespace launcher::bugreport
{
    // sites/s2u/api/bugs.mjs LIMITS. "Characters" are UTF-16 code units there (JavaScript's .length), and here.
    constexpr size_t kTitleMin = 4, kTitleMax = 120;
    constexpr size_t kDescriptionMin = 10, kDescriptionMax = 4000;
    constexpr size_t kContactMax = 120;
    constexpr size_t kShortMax = 64;              // version, platform
    constexpr size_t kContextPairs = 16, kContextKeyMax = 32, kContextValueMax = 256;
    constexpr size_t kLogMax = 65536;
    constexpr size_t kBodyMax = 98304;            // the whole POST, 96 KB

    constexpr const char *kDefaultApiBase = "https://socomunzipped.com";
    constexpr const char *kApiBaseEnv = "PS2X_LAUNCHER_API_BASE";   // TEST-ONLY, loopback only: see apiBase()
    constexpr const char *kBugsPath = "/api/bugs";
    constexpr const char *kStatsPath = "/api/stats";
    constexpr int kStatsPollSeconds = 10;         // the contract allows 5 s; the launcher asks half as often

    // The page's labels, the site's own (report.ts FIELDS).
    constexpr const char *kLabelTitle = "TITLE";
    constexpr const char *kLabelDescription = "WHAT HAPPENED";
    constexpr const char *kLabelContact = "CONTACT (OPTIONAL)";
    constexpr const char *kLabelSend = "SEND REPORT";
    constexpr const char *kLabelAttach = "Attach the last run's log";

    struct Form
    {
        std::string title;
        std::string description;
        std::string contact;
        bool attachLog = false;   // OFF by default: the log leaves the machine only when the player ticks it
        bool test = false;        // "test": true -- an end-to-end proof, stored apart from real reports
    };

    // What the launcher read off the disk and the last run; none of it typed by the player.
    struct Inputs
    {
        std::string version;      // version.txt's line; empty for a development build
        std::string platform;     // ExeDir::platformName()
        std::string homeDir;      // USERPROFILE / HOME; scrubbed out of everything
        std::string logText;      // the last run's log, whole; used only when Form::attachLog
        bool haveLastExit = false;
        long long lastExit = 0;   // GameProcess::exitCode(), raw
    };

    // UTF-16 code units in a UTF-8 string: what JavaScript's .length says, so both ends count alike.
    size_t utf16Length(const std::string &utf8);
    // "" when the form can be sent; otherwise what to fix, in report.ts checkForm's words.
    std::string checkForm(const Form &form);
    // Which field a checkForm / server message names: "title", "description", "contact", "log" or "".
    std::string fieldOf(const std::string &message);

    // A JSON string literal, quotes included: control characters escaped, valid UTF-8 passed through,
    // bytes that are not UTF-8 replaced (U+FFFD) so the body is always valid JSON.
    std::string jsonString(const std::string &utf8);

    // The log attachment: diagnostics::clipLog, scrub(homeDir), then the LAST maxBytes cut on a line boundary.
    // The runner prints the disc's path, so the folder of `isoPath` is cut out as well, leaving the file name: the
    // payload never says where on the machine the image is kept, only what it is called.
    std::string logAttachment(const std::string &logText, const std::string &homeDir, const std::string &isoPath = std::string(),
                              size_t maxBytes = kLogMax);

    // The allowlisted context, in order, at most kContextPairs pairs, every value at most kContextValueMax.
    std::vector<std::pair<std::string, std::string>> contextPairs(const Config &config, const Inputs &inputs);

    struct Payload
    {
        std::string json;                       // the POST body, never above kBodyMax
        size_t logBytes = 0;                    // the attached log's size after every cut; 0 = none
        std::vector<std::string> contextKeys;   // what the PREVIEW line names
    };
    Payload build(const Config &config, const Form &form, const Inputs &inputs);
    inline std::string buildPayload(const Config &config, const Form &form, const Inputs &inputs)
    {
        return build(config, form, inputs).json;
    }
    // What SEND would send, said before it is sent: the size, the fields, the context keys, the log or "no log".
    std::string previewLine(const Payload &payload, const Form &form);

    struct Reply
    {
        enum class Kind
        {
            Sent,
            FieldError,
            RateLimited,
            Failed
        };
        Kind kind = Kind::Failed;
        std::string id;                 // Sent: the site's id upper-cased, as kSampleShownId; "" when it did not look like ours
        std::string field;              // FieldError: "title" | "description" | ... | ""
        int retryAfterSeconds = 0;      // RateLimited: the Retry-After header, 0 when absent
        std::string text;               // one line for the screen, report.ts replyText's words
    };
    // The id the launcher's screenshots show on a sent report (main.cpp's --screenshot walk). The site issues ids
    // lower-case (report.ts: /^BR-\d{8}-[0-9a-f]{6}$/) and the launcher shows them upper-cased, as the site does;
    // this sample is one such shown id, and bug_report_tests.cpp holds it to that (Sprint 13 V8, stranger row 15).
    inline constexpr const char *kSampleShownId = "BR-20260919-A1B2C3";
    // `status` 0 = no connection. `retryAfterSeconds` is the Retry-After header as a number, 0 when absent.
    Reply parseReply(int status, const std::string &body, int retryAfterSeconds = 0);
    // The line that follows a report that could not be sent and was written to `path` instead.
    std::string savedLocallyLine(const std::string &path);

    // Sprint 11 Goal 7, the bug pipeline's GitHub half. The inbox is private and every word in it is
    // untrusted, so nothing crosses from a report to the public issue tracker by itself: the whole bridge is
    // this one sentence, shown under SEND after a report is received, inviting the person who filed it to
    // open the issue themselves and quote the reference. (The site's own form is asked to say the same
    // thing -- that request belongs to the site session, sites/s2u; this is the launcher's half.)
    // Owner ruling O4 I1 (2026-09-26): the invitation excepts security reports -- SECURITY.md keeps those out
    // of the public tracker, and this line must never steer an exploit into a public issue. Longer than one
    // line at the page's width: page_report.cpp wraps it over two.
    constexpr const char *kGithubIssueLine =
        "Contributors can also open an issue at github.com/Scotho/socom-unzipped and quote this id"
        " -- unless it is a security report: those go through SECURITY.md, never a public issue.";
    // kGithubIssueLine for a reply's reference, "" when there is none: a rate-limited, refused or undelivered
    // SEND has no reference, and neither has a report the service received under an id that is not one of
    // ours (parseReply leaves `id` empty there). With no reference on the screen there is nothing to quote,
    // and the invitation would cost a stranger a wasted trip.
    std::string githubLine(const std::string &referenceId);

    // GET /api/stats -> "SOCOM Unzipped: online, 3 players, 1 game" | "SOCOM Unzipped: offline" | "" on junk
    // (stats.ts parseStats's rules: online only when status == "online" and players is an object).
    std::string statusLine(const std::string &statsJson);

    // The service's base URL. `envValue` (PS2X_LAUNCHER_API_BASE, may be null) is honoured ONLY when it is
    // exactly http://127.0.0.1:<port> or http://localhost:<port> -- a loopback test server -- so nobody can
    // point a player's reports somewhere else with an environment variable.
    std::string apiBase(const char *envValue);

    // --report-bug's form file: {"title", "description", "contact", "attachLog", "test"}. `test` defaults to
    // TRUE here: the headless mode exists for proofs. False when the text is not a JSON object.
    bool formFromJson(const std::string &text, Form &out);
    // "bugreport_<stamp>.json"
    std::string savedFileName(const std::string &stamp);
}
