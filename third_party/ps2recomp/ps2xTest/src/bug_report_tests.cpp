// Sprint 9 Goal 8: the launcher's REPORT A BUG payload and the ONLINE page's status line -- the contract of
// socomunzipped.com's /api/bugs and /api/stats (sites/s2u/src/report.ts, api/bugs.mjs, src/stats.ts), asserted
// on the pure half. Nothing here opens a socket; tools_py/tests/test_launcher_bug_report.py drives the
// transport against a loopback server.
#include "MiniTest.h"
#include "launcher/bug_report.h"
#include "launcher/launcher_config.h"

#include <cctype>
#include <string>
#include <vector>

namespace
{
    namespace br = launcher::bugreport;

    bool has(const std::string &hay, const std::string &needle) { return hay.find(needle) != std::string::npos; }

    br::Form goodForm()
    {
        br::Form f;
        f.title = " Crash on join ";
        f.description = "It closed when I joined a game.";
        f.contact = " me#1 ";
        return f;
    }

    launcher::Config config()
    {
        launcher::Config c;
        c.isoPath = "C:\\Users\\secretuser\\Games\\SOCOM II (USA).iso";
        c.gsScale = 2;
        c.windowSize = "1280x896";
        c.serverPreset = "unzipped";
        c.profile = "viper";
        c.crouchShortcut = "l3";
        c.micDevice = "Headset (secret mic)";
        return c;
    }

    br::Inputs inputs()
    {
        br::Inputs in;
        in.version = "SOCOM Unzipped 871f9f8 (2026-09-19)";
        in.platform = "windows";
        in.homeDir = "C:\\Users\\secretuser";
        in.logText = "INFO:     > Renderer: NVIDIA GeForce RTX 4070 SUPER/PCIe/SSE2\r\n"
                     "[socom2] CD image: C:\\Users\\secretuser\\Games\\SOCOM II (USA).iso\r\n"
                     "[crash] code=0xc0000005\r\n";
        in.haveLastExit = true;
        in.lastExit = static_cast<int>(0xC0000005u);
        return in;
    }
}

void register_bug_report_tests()
{
    MiniTest::Case("BugReport", [](TestCase &tc)
    {
        tc.Run("checkForm: the site's limits and the site's words", [](TestCase &t)
        {
            br::Form f = goodForm();
            t.Equals(br::checkForm(f), std::string(""), "a good form can be sent");
            f.title = "abc";
            t.Equals(br::checkForm(f), std::string("TITLE: 4 TO 120 CHARACTERS."), "a 3-character title");
            f.title = "   abc   ";
            t.Equals(br::checkForm(f), std::string("TITLE: 4 TO 120 CHARACTERS."), "the title is trimmed before it is counted");
            f.title = std::string(120, 'x');
            t.Equals(br::checkForm(f), std::string(""), "120 is allowed");
            f.title = std::string(121, 'x');
            t.Equals(br::checkForm(f), std::string("TITLE: 4 TO 120 CHARACTERS."), "121 is not");
            f = goodForm();
            f.description = "short";
            t.Equals(br::checkForm(f), std::string("WHAT HAPPENED: AT LEAST 10 CHARACTERS."), "a 5-character description");
            f.description = std::string(4000, 'x');
            t.Equals(br::checkForm(f), std::string(""), "4000 is allowed");
            f.description = std::string(4001, 'x');
            t.Equals(br::checkForm(f), std::string("WHAT HAPPENED: AT MOST 4000 CHARACTERS."), "4001 is not");
            // JavaScript counts UTF-16 units: e-acute is 2 bytes and 1 unit, an emoji 4 bytes and 2 units.
            t.Equals(br::utf16Length("caf\xC3\xA9"), static_cast<size_t>(4), "two bytes, one unit");
            t.Equals(br::utf16Length("\xF0\x9F\x98\x80"), static_cast<size_t>(2), "four bytes, a surrogate pair");
            f = goodForm();
            f.title = "";
            for (int i = 0; i < 120; ++i)
                f.title += "\xC3\xA9";
            t.Equals(br::checkForm(f), std::string(""), "120 accented characters are 240 bytes and still 120 characters");

            t.Equals(br::fieldOf("TITLE: 4 TO 120 CHARACTERS."), std::string("title"), "the page's own message names the field");
            t.Equals(br::fieldOf("WHAT HAPPENED: AT LEAST 10 CHARACTERS."), std::string("description"), "WHAT HAPPENED is the description");
            t.Equals(br::fieldOf("description: 10 to 4000 characters"), std::string("description"), "and so does the server's");
            t.Equals(br::fieldOf("rate limited"), std::string(""), "a message with no field names none");
        });

        tc.Run("jsonString: quotes, backslashes, control characters, UTF-8 through, junk bytes replaced", [](TestCase &t)
        {
            t.Equals(br::jsonString("plain"), std::string("\"plain\""), "plain text is quoted");
            t.Equals(br::jsonString("a\"b\\c"), std::string("\"a\\\"b\\\\c\""), "quotes and backslashes are escaped");
            t.Equals(br::jsonString("l1\nl2\r\tx"), std::string("\"l1\\nl2\\r\\tx\""), "newline, return and tab use the short escapes");
            t.Equals(br::jsonString(std::string("a\0b\x1b" "c", 5)), std::string("\"a\\u0000b\\u001bc\""), "NUL and ESC become \\u00XX");
            t.Equals(br::jsonString("caf\xC3\xA9 \xF0\x9F\x98\x80"), std::string("\"caf\xC3\xA9 \xF0\x9F\x98\x80\""), "valid UTF-8 passes through as it is");
            t.Equals(br::jsonString("bad\xFFyte"), std::string("\"bad\xEF\xBF\xBDyte\""), "a byte that is not UTF-8 becomes U+FFFD");
            t.Equals(br::jsonString("cut\xC3"), std::string("\"cut\xEF\xBF\xBD\""), "and so does a sequence cut short");
        });

        tc.Run("the payload: the site's field names, the launcher's source, an empty honeypot", [](TestCase &t)
        {
            const br::Payload p = br::build(config(), goodForm(), inputs());
            t.IsTrue(has(p.json, "\"title\":\"Crash on join\""), "the title, trimmed");
            t.IsTrue(has(p.json, "\"description\":\"It closed when I joined a game.\""), "the description");
            t.IsTrue(has(p.json, "\"contact\":\"me#1\""), "the contact, trimmed");
            t.IsTrue(has(p.json, "\"source\":\"launcher\""), "the source is the launcher");
            t.IsTrue(has(p.json, "\"version\":\"SOCOM Unzipped 871f9f8 (2026-09-19)\""), "the version");
            t.IsTrue(has(p.json, "\"platform\":\"windows\""), "the platform");
            t.IsTrue(has(p.json, "\"website\":\"\""), "the honeypot is there and empty");
            t.IsTrue(!has(p.json, "\"test\""), "a real report carries no test mark");
            t.IsTrue(!has(p.json, "\"log\""), "and no log: the checkbox is off by default");
            t.Equals(p.logBytes, static_cast<size_t>(0), "no log bytes");
            t.IsTrue(!br::Form{}.attachLog, "Form's default is OFF");
            t.IsTrue(p.json.front() == '{' && p.json.back() == '}', "one JSON object");

            br::Form proof = goodForm();
            proof.test = true;
            t.IsTrue(has(br::buildPayload(config(), proof, inputs()), "\"test\":true"), "a proof marks itself with a JSON boolean");

            // The honeypot can never be emitted non-empty: there is no input that reaches it.
            br::Form nasty = goodForm();
            nasty.title = "x\",\"website\":\"spam";
            nasty.contact = "website";
            const std::string j = br::buildPayload(config(), nasty, inputs());
            t.IsTrue(has(j, "\"website\":\"\""), "still empty");
            t.IsTrue(!has(j, "\"website\":\"spam"), "a quote in the title cannot forge the field");
            size_t count = 0;
            for (size_t at = j.find("\"website\":"); at != std::string::npos; at = j.find("\"website\":", at + 1))
                ++count;
            t.Equals(count, static_cast<size_t>(1), "exactly one website key");

            // The version and the platform are cut to the contract's 64.
            br::Inputs longIn = inputs();
            longIn.version = std::string(100, 'v');
            t.IsTrue(has(br::buildPayload(config(), goodForm(), longIn), "\"version\":\"" + std::string(64, 'v') + "\""), "version <= 64");
            br::Form longContact = goodForm();
            longContact.contact = std::string(200, 'c');
            t.IsTrue(has(br::buildPayload(config(), longContact, inputs()), "\"contact\":\"" + std::string(120, 'c') + "\""), "contact <= 120");
        });

        tc.Run("the context: the allowlist, the ISO's file name only, never the home directory", [](TestCase &t)
        {
            const auto pairs = br::contextPairs(config(), inputs());
            auto value = [&](const std::string &key) -> std::string
            {
                for (const auto &kv : pairs)
                    if (kv.first == key)
                        return kv.second;
                return "<absent>";
            };
            t.Equals(value("serverPreset"), std::string("unzipped"), "the preset");
            t.Equals(value("server"), std::string("socom.scotho.com"),
                     "the server the game is pointed at -- by name since Sprint 9 P6, and still reported verbatim");
            t.Equals(value("gsScale"), std::string("2"), "the detail level");
            t.Equals(value("windowSize"), std::string("1280x896"), "the window");
            t.Equals(value("profile"), std::string("viper"), "the profile");
            t.Equals(value("crouchShortcut"), std::string("l3"), "the crouch shortcut");
            t.Equals(value("iso"), std::string("SOCOM II (USA).iso"), "the ISO, cut to its file name");
            t.IsTrue(has(value("lastExit"), "crashed"), "the last exit's slug");
            t.IsTrue(value("lastExitMeaning") == launcher::exitMessage(-1) || !value("lastExitMeaning").empty(), "and its sentence");
            t.Equals(value("glRenderer"), std::string("NVIDIA GeForce RTX 4070 SUPER/PCIe/SSE2"), "the GL renderer out of the last log");
            t.Equals(value("micDevice"), std::string("<absent>"), "a device name is not on the list");
            t.IsTrue(pairs.size() <= br::kContextPairs, "at most 16 pairs");
            for (const auto &kv : pairs)
            {
                t.IsTrue(!kv.first.empty() && kv.first.size() <= br::kContextKeyMax, "key <= 32: " + kv.first);
                t.IsTrue(br::utf16Length(kv.second) <= br::kContextValueMax, "value <= 256: " + kv.first);
            }

            br::Inputs none;
            const auto bare = br::contextPairs(launcher::Config{}, none);
            for (const auto &kv : bare)
                t.IsTrue(kv.first != "lastExit" && kv.first != "glRenderer" && kv.first != "iso",
                         "no run, no log, no ISO: no such pair (" + kv.first + ")");

            launcher::Config longOne = config();
            longOne.profile = std::string(400, 'p');
            for (const auto &kv : br::contextPairs(longOne, inputs()))
                if (kv.first == "profile")
                    t.Equals(kv.second.size(), br::kContextValueMax, "a long value is cut to 256");

            // With the log attached and every path in play, neither directory appears anywhere in the body.
            br::Form f = goodForm();
            f.attachLog = true;
            launcher::Config posix = config();
            const br::Payload p = br::build(posix, f, inputs());
            t.IsTrue(p.logBytes > 0 && has(p.json, "\"log\":\""), "the log is attached when asked for");
            t.IsTrue(!has(p.json, "secretuser"), "the home directory's name is nowhere in the payload");
            t.IsTrue(!has(p.json, "Games"), "and neither is the ISO's directory");
            t.IsTrue(has(p.json, "SOCOM II (USA).iso"), "the file name is");
            t.IsTrue(!has(p.json, "secret mic"), "a field off the allowlist is nowhere");
            posix.isoPath = "/home/secretuser/isos/socom2.iso";
            br::Inputs pin = inputs();
            pin.homeDir = "/home/secretuser";
            pin.logText = "[socom2] CD image: /home/secretuser/isos/socom2.iso\n";
            const std::string pj = br::buildPayload(posix, f, pin);
            t.IsTrue(!has(pj, "secretuser") && !has(pj, "\"iso\":\"/"), "the same on a POSIX path");
        });

        // Sprint 10 Goal 9, R179: the payload adds named fields from Config rather than the whole file, so the
        // password is out unless someone adds it. This is the guard that says so, with a planted value -- and the
        // persona name, which the server already knows, is likewise not on the allowlist.
        tc.Run("a bug report never carries the password", [](TestCase &t)
        {
            launcher::Config c = config();
            c.loginName = "socomc";
            c.loginPassword = "hunter2";
            br::Form form;
            form.title = "the lobby";
            form.description = "a description long enough to pass the form check, with detail";
            form.attachLog = true;
            br::Inputs in = inputs();
            in.logText += "[launcher] env PS2X_SOCOM2_LOGIN_PASS=hunter2 (a line a future launcher might log)\r\n";
            const std::string json = br::build(c, form, in).json;
            t.IsTrue(!has(json, "hunter2"), "the password is not in the payload");
            t.IsTrue(!has(json, "loginPassword"), "nor its key");
            for (const auto &kv : br::contextPairs(c, in))
                t.IsTrue(kv.first != "loginName" && kv.first != "loginPassword", "no context pair for either -- the name is the server's to know, not the site's (" + kv.first + ")");
        });

        tc.Run("the log attachment: scrubbed, the last 65,536 bytes, cut on a line boundary", [](TestCase &t)
        {
            std::string log;
            for (int i = 0; i < 4000; ++i)
                log += "line " + std::to_string(i) + " of the run, C:\\Users\\secretuser\\x\n";
            const std::string cut = br::logAttachment(log, "C:\\Users\\secretuser");
            t.IsTrue(cut.size() <= br::kLogMax, "at most 65,536 bytes");
            t.IsTrue(cut.size() > br::kLogMax - 200, "and not much less");
            t.IsTrue(cut.rfind("line ", 0) == 0, "it starts at the start of a line");
            t.IsTrue(has(cut, "line 3999 of the run"), "it is the TAIL: the ending is what went wrong");
            t.IsTrue(!has(cut, "line 0 of the run"), "the head is what was dropped");
            t.IsTrue(!has(cut, "secretuser") && has(cut, "~\\x"), "the home directory is scrubbed");
            t.Equals(br::logAttachment("short\n", ""), std::string("short\n"), "a log that fits is left alone");
            const std::string disc = br::logAttachment("[socom2] CD image: D:\\roms\\ps2\\socom2.iso\nopen D:/roms/ps2/socom2.iso\n",
                                                       "C:\\Users\\u", "D:\\roms\\ps2\\socom2.iso");
            t.IsTrue(!has(disc, "roms") && has(disc, "socom2.iso"), "the disc's folder is cut out of the log too, either slash: " + disc);
            t.Equals(br::logAttachment(std::string(70000, 'x'), "").size(), br::kLogMax, "one endless line is still cut to the limit");
            // A multi-byte character is never cut in half.
            std::string accents;
            for (int i = 0; i < 40000; ++i)
                accents += "\xC3\xA9";
            const std::string a = br::logAttachment(accents, "", "", 1001);
            t.IsTrue(a.size() <= 1001 && (static_cast<unsigned char>(a[0]) & 0xC0) != 0x80, "the cut lands on a character");
        });

        tc.Run("the 96 KB guard: the log shrinks, the description never does", [](TestCase &t)
        {
            br::Form f = goodForm();
            f.attachLog = true;
            f.description = "";
            for (int i = 0; i < 4000; ++i)
                f.description += "\xE2\x82\xAC";   // 4000 characters, 12,000 bytes
            br::Inputs in = inputs();
            in.logText.clear();
            for (int i = 0; i < 3000; ++i)
                in.logText += "C:\\path" + std::string(30, '\\') + "\"q\"\t" + std::to_string(i) + "\n";   // nearly doubles when escaped
            const br::Payload p = br::build(config(), f, in);
            t.IsTrue(p.json.size() <= br::kBodyMax, "the body is at most 98,304 bytes");
            t.IsTrue(p.json.size() > br::kBodyMax - 400, "and the guard dropped only what it had to");
            t.IsTrue(has(p.json, f.description), "the description is whole");
            t.IsTrue(p.logBytes > 0 && p.logBytes < br::kLogMax, "the log is what shrank");
            t.IsTrue(has(p.json, "\\t2999\\n"), "and it kept its tail");
            t.IsTrue(has(p.json, "\"log\":\"C:\\\\path"), "still cut on a line boundary");
        });

        tc.Run("the preview says what will be sent before it is sent", [](TestCase &t)
        {
            br::Form f = goodForm();
            const br::Payload p = br::build(config(), f, inputs());
            const std::string line = br::previewLine(p, f);
            t.IsTrue(has(line, std::to_string(p.json.size()) + " bytes"), "the size of the body: " + line);
            for (const std::string &key : p.contextKeys)
                t.IsTrue(has(line, key), "names the context key " + key);
            t.IsTrue(has(line, "no log"), "and says there is no log");
            f.attachLog = true;
            const br::Payload withLog = br::build(config(), f, inputs());
            t.IsTrue(has(br::previewLine(withLog, f), std::to_string(withLog.logBytes) + " bytes of the last run's log"), "or how much of it");
            br::Inputs noLog = inputs();
            noLog.logText.clear();
            t.IsTrue(has(br::previewLine(br::build(config(), f, noLog), f), "no log"), "a ticked box with no log on disk still says no log");
        });

        // Sprint 13 V8 (stranger audit row 15): the id the screenshots show must be one the launcher could show.
        // The check is the launcher's own: parseReply keeps an id only when it passes report.ts's regex
        // (lower-case hex), then upper-cases it for the screen -- so the sample, lower-cased and sent back
        // through parseReply, must come out as itself.
        tc.Run("the screenshots' sample reference id is one the launcher's own id check accepts", [](TestCase &t)
        {
            // As the site issues it: "BR-" and the date as they are, the six hex digits lower-case.
            std::string lower = br::kSampleShownId;
            for (size_t k = 12; k < lower.size(); ++k)
                lower[k] = static_cast<char>(std::tolower(static_cast<unsigned char>(lower[k])));
            const br::Reply r = br::parseReply(201, "{\"ok\":true,\"id\":\"" + lower + "\"}");
            t.IsTrue(r.kind == br::Reply::Kind::Sent, "a 201 with the sample id is a receipt");
            t.Equals(r.id, std::string(br::kSampleShownId), "the sample, as the site issues it, passes the id check and shows as itself");
        });

        tc.Run("parseReply: 201, 400, 413, 429, 500, no connection, garbage", [](TestCase &t)
        {
            using Kind = br::Reply::Kind;
            br::Reply r = br::parseReply(201, "{\"ok\":true,\"id\":\"BR-20260919-abc123\"}");
            t.IsTrue(r.kind == Kind::Sent, "201 ok is sent");
            t.Equals(r.id, std::string("BR-20260919-ABC123"), "the id, upper-cased as the site shows it");
            t.Equals(r.text, std::string("REPORT RECEIVED. REFERENCE BR-20260919-ABC123."), "the site's line");
            r = br::parseReply(201, "{\"ok\":true,\"id\":\"<img src=x>\"}");
            t.IsTrue(r.kind == Kind::Sent && r.id.empty(), "an id that is not ours is not shown");
            t.Equals(r.text, std::string("REPORT RECEIVED."), "the site's line without it");
            r = br::parseReply(201, "<html>a captive portal</html>");
            t.IsTrue(r.kind == Kind::Failed, "a 201 that is not the service's JSON is not a receipt");

            r = br::parseReply(400, "{\"ok\":false,\"error\":\"title: 4 to 120 characters\"}");
            t.IsTrue(r.kind == Kind::FieldError, "400 is a field error");
            t.Equals(r.field, std::string("title"), "it names the field");
            t.Equals(r.text, std::string("NOT SENT. TITLE: 4 TO 120 CHARACTERS"), "the site's line");
            r = br::parseReply(400, "{\"ok\":false,\"error\":\"" + std::string(200, 'e') + "\"}");
            t.Equals(r.text.size(), std::string("NOT SENT. ").size() + 80, "the server's words are cut to 80");
            r = br::parseReply(400, "not json");
            t.IsTrue(r.kind == Kind::Failed, "a 400 with no message is a failure to send");

            r = br::parseReply(429, "{\"ok\":false,\"error\":\"rate limited\"}", 1500);
            t.IsTrue(r.kind == Kind::RateLimited, "429 is rate limited");
            t.Equals(r.retryAfterSeconds, 1500, "Retry-After is kept");
            t.Equals(r.text, std::string("NOT SENT. TOO MANY REPORTS FROM HERE; TRY AGAIN IN 25 MINUTES."), "and said in minutes");
            r = br::parseReply(429, "", 30);
            t.Equals(r.text, std::string("NOT SENT. TOO MANY REPORTS FROM HERE; TRY AGAIN IN 1 MINUTE."), "under a minute is one minute");
            r = br::parseReply(429, "");
            t.Equals(r.text, std::string("NOT SENT. TOO MANY REPORTS FROM HERE; TRY AGAIN IN AN HOUR."), "without the header, the site's line");

            const std::string notAnswered = "NOT SENT. THE REPORT SERVICE DID NOT ANSWER; YOUR TEXT IS STILL HERE.";
            r = br::parseReply(413, "{\"ok\":false,\"error\":\"body: too large\"}");
            t.IsTrue(r.kind == Kind::Failed, "413 is a failure");
            t.Equals(r.text, std::string("NOT SENT. THE REPORT WAS TOO LARGE; YOUR TEXT IS STILL HERE."), "that says why");
            r = br::parseReply(500, "oops");
            t.IsTrue(r.kind == Kind::Failed, "500 is a failure");
            t.Equals(r.text, notAnswered, "the site's line");
            r = br::parseReply(0, "");
            t.IsTrue(r.kind == Kind::Failed, "no connection is a failure");
            t.Equals(r.text, notAnswered, "the same line");
            r = br::parseReply(200, "{\"ok\":true,\"id\":\"BR-20260919-abc123\"}");
            t.IsTrue(r.kind == Kind::Failed, "only 201 is a receipt");
            r = br::parseReply(201, "{\"ok\":\"true\",\"id\":\"BR-20260919-abc123\"}");
            t.IsTrue(r.kind == Kind::Failed, "ok must be the JSON boolean");

            t.IsTrue(has(br::savedLocallyLine("C:\\game\\logs\\bugreport_x.json"), "C:\\game\\logs\\bugreport_x.json"), "the saved line says where");
            t.Equals(br::savedFileName("20260919_101500"), std::string("bugreport_20260919_101500.json"), "the file's name");
        });

        tc.Run("statusLine: online with counts, offline, and nothing at all on junk", [](TestCase &t)
        {
            const std::string live =
                "{\"status\":\"online\",\"server\":\"SOCOM Unzipped\",\"location\":\"US East (Ohio) - AWS us-east-2\","
                "\"uptimeSeconds\":1234,\"players\":{\"online\":3,\"inGame\":2,\"inLobby\":1,\"names\":[\"a\",\"b\",\"c\"]},"
                "\"games\":[{\"name\":\"room$~x\",\"players\":2}],\"channels\":[],\"sinceStart\":{\"gamesCreated\":4}}";
            t.Equals(br::statusLine(live), std::string("SOCOM Unzipped: online, 3 players, 1 game"), "the brief's line");
            t.Equals(br::statusLine("{\"status\":\"online\",\"players\":{\"online\":1},\"games\":[{},{}]}"),
                     std::string("SOCOM Unzipped: online, 1 player, 2 games"), "singular and plural");
            t.Equals(br::statusLine("{\"status\":\"online\",\"players\":{\"online\":\"many\"},\"games\":7}"),
                     std::string("SOCOM Unzipped: online, 0 players, 0 games"), "wrong types are zero, as parseStats has it");
            t.Equals(br::statusLine("{\"status\":\"online\",\"players\":{\"online\":-4.5},\"games\":[1,\"x\",{}]}"),
                     std::string("SOCOM Unzipped: online, 0 players, 1 game"), "negative is zero; only objects are games");
            t.Equals(br::statusLine("{\"status\":\"offline\"}"), std::string("SOCOM Unzipped: offline"), "offline says so");
            t.Equals(br::statusLine("{\"status\":\"online\"}"), std::string("SOCOM Unzipped: offline"), "online without players is offline, as parseStats has it");
            t.Equals(br::statusLine(""), std::string(""), "nothing is nothing");
            t.Equals(br::statusLine("<html>502 Bad Gateway</html>"), std::string(""), "a proxy's error page is nothing");
            t.Equals(br::statusLine("[1,2,3]"), std::string(""), "an array is nothing");
            t.Equals(br::statusLine("{\"status\":\"online\",\"players\":{\"online\":3"), std::string(""), "a cut-off body is nothing");
            std::string deep;
            for (int i = 0; i < 5000; ++i)
                deep += "[";
            t.Equals(br::statusLine(deep), std::string(""), "and a bomb of brackets does not recurse to death");
            std::string games = "{\"status\":\"online\",\"players\":{\"online\":2},\"games\":[";
            for (int i = 0; i < 100; ++i)
                games += (i ? ",{}" : "{}");
            games += "]}";
            t.Equals(br::statusLine(games), std::string("SOCOM Unzipped: online, 2 players, 32 games"), "the list is cut at parseStats's 32");
        });

        tc.Run("apiBase: the test seam is loopback or nothing", [](TestCase &t)
        {
            const std::string live = "https://socomunzipped.com";
            t.Equals(br::apiBase(nullptr), live, "unset is the live site");
            t.Equals(br::apiBase(""), live, "empty is the live site");
            t.Equals(br::apiBase("http://127.0.0.1:8123"), std::string("http://127.0.0.1:8123"), "a loopback test server is accepted");
            t.Equals(br::apiBase("http://localhost:8123/"), std::string("http://localhost:8123"), "by name too, the slash dropped");
            t.Equals(br::apiBase("https://evil.example"), live, "anywhere else is refused");
            t.Equals(br::apiBase("http://127.0.0.1:80@evil.example"), live, "userinfo dressed as loopback is refused");
            t.Equals(br::apiBase("http://127.0.0.1:8123/x"), live, "a path is refused");
            t.Equals(br::apiBase("http://127.0.0.1.evil.example:80"), live, "a look-alike host is refused");
            t.Equals(br::apiBase("http://localhost:"), live, "a port is required");
            t.Equals(br::apiBase("http://localhost:123456"), live, "a real one");
        });

        tc.Run("--report-bug's form file: test is the default there", [](TestCase &t)
        {
            br::Form f;
            t.IsTrue(br::formFromJson("{\"title\":\"T \\u00e9\",\"description\":\"line1\\nline2\",\"contact\":\"c\",\"attachLog\":true}", f), "a form parses");
            t.Equals(f.title, std::string("T \xC3\xA9"), "\\u escapes become UTF-8");
            t.Equals(f.description, std::string("line1\nline2"), "the description keeps its lines");
            t.IsTrue(f.attachLog, "attachLog is read");
            t.IsTrue(f.test, "test defaults to TRUE in the headless mode");
            t.IsTrue(br::formFromJson("{\"title\":\"x\",\"test\":false}", f) && !f.test, "unless the file says otherwise");
            t.IsTrue(!f.attachLog, "and a missing attachLog is off");
            t.IsTrue(!br::formFromJson("nonsense", f), "junk is refused");
            t.IsTrue(!br::formFromJson("[]", f), "and so is an array");
        });
    });
}
