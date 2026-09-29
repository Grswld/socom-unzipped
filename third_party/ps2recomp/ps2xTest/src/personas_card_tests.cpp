// The persona-card plan (docs/superpowers/plans/2026-09-28-persona-card-creator.md) Task 2: the creator writes the
// persona into the card's own save file, the PERSONAS list reads the cards, and a pick puts its record first. Every
// case builds its own home under the temp folder (preflight_tests.cpp's makeHome pattern), never a real card, and
// every server is a dotted documentation address or a name the test's resolver answers -- no lookup leaves the host.
#include "MiniTest.h"
#include "launcher/card_save.h"
#include "launcher/launcher_config.h"
#include "launcher/personas.h"

#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

namespace
{
    namespace fs = std::filesystem;
    namespace ps = launcher::personas;
    namespace card = launcher::card;

    fs::path makeHome()
    {
        static int counter = 0;
        const auto ticks = std::chrono::steady_clock::now().time_since_epoch().count();
        const fs::path root = fs::temp_directory_path() / ("ps2x_personas_card_" + std::to_string(ticks) + "_" + std::to_string(counter++));
        std::error_code ec;
        fs::create_directories(root / "home", ec);
        return root / "home";
    }

    void removeHome(const fs::path &home)
    {
        std::error_code ec;
        fs::remove_all(home.parent_path(), ec);
    }

    std::vector<uint8_t> readBytes(const fs::path &p)
    {
        std::ifstream in(p, std::ios::binary);
        return std::vector<uint8_t>(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
    }

    void writeText(const fs::path &p, const std::string &text)
    {
        std::ofstream out(p, std::ios::binary | std::ios::trunc);
        out.write(text.data(), static_cast<std::streamsize>(text.size()));
    }

    fs::path cardFile(const fs::path &home, const std::string &leaf)
    {
        return home / "cards" / leaf / ps::kSaveFolder / ps::kSaveFolder;
    }

    // A custom server at a documentation address: effectiveServer answers it as typed, and it resolves to itself.
    launcher::Config customAt(const std::string &address)
    {
        launcher::Config c;
        c.serverPreset = "custom";
        c.server = address;
        return c;
    }

    // The test's resolver: one invented name, and nothing else resolves.
    std::string testResolver(const std::string &host)
    {
        return host == "persona-card.test" ? std::string("203.0.113.5") : std::string();
    }

    // Review finding 6's resolver and clock: the name fails until `g_upNow` is set (the network came back), and every
    // question it is asked is counted; the clock is the test's own seconds.
    bool g_upNow = false;
    int g_asked = 0;
    std::int64_t g_now = 1000;
    std::string flakyResolver(const std::string &host)
    {
        ++g_asked;
        return g_upNow && host == "later.test" ? std::string("203.0.113.8") : std::string();
    }
    std::int64_t testClock()
    {
        return g_now;
    }
}

void register_personas_card_tests()
{
    MiniTest::Case("PersonasCard", [](TestCase &tc)
    {
        tc.Run("(i) createPersona from no cards/ at all writes the card; readCards lists it, password saved, host resolved", [](TestCase &t)
        {
            const fs::path home = makeHome();
            const launcher::Config c = customAt("203.0.113.5");
            t.Equals(launcher::effectiveServer(c), std::string("203.0.113.5"), "the custom address is the server");
            std::string note;
            t.IsTrue(ps::createPersona(home.string(), c, "s17pc", "pwsevc", note), "created");
            const fs::path file = cardFile(home, "player");
            t.IsTrue(fs::is_regular_file(file), "the card file exists under cards/player/BASCUS-97275SOCOMII/");
            t.IsTrue(note.find("BASCUS-97275SOCOMII") != std::string::npos, "the note names the file written: " + note);
            t.IsFalse(fs::exists(fs::path(file.string() + ".tmp")), "and no temp file is left");
            std::vector<card::Persona> records;
            std::string why;
            t.IsTrue(card::readCardFile(readBytes(file), records, why), "the codec reads what was written: " + why);
            t.Equals(records.size(), size_t(1), "one record");
            if (records.size() == 1)
            {
                t.Equals(records[0].host, std::string("203.0.113.5"), "HOST, the resolved address");
                t.Equals(records[0].name, std::string("s17pc"), "NAME");
                t.Equals(records[0].password, std::string("pwsevc"), "PASSWORD, plain, as the game keeps it");
                t.Equals(records[0].port, 10075, "PORT 10075");
                t.IsTrue(records[0].savePassword && records[0].gender == 0 && records[0].town.empty(), "SAVEPASSWORD 1, GENDER 0, TOWN empty");
            }
            const ps::Cards read = ps::readCards((home / "cards").string());
            t.Equals(read.rows.size(), size_t(1), "one row");
            if (read.rows.size() == 1)
            {
                t.Equals(read.rows[0].name, std::string("s17pc"), "its name");
                t.Equals(read.rows[0].card, std::string("player"), "its card");
                t.Equals(read.rows[0].server, std::string("203.0.113.5"), "its server is the card's HOST");
                t.IsTrue(read.rows[0].savedPassword, "the card holds its password");
                t.IsFalse(read.rows[0].second, "player is not a second instance's card");
                t.IsTrue(ps::counts(read.rows[0], c), "it counts on the server the config points at");
            }
            t.Equals(std::string(ps::emptySentence(read)), std::string(), "no empty sentence over a row");
            removeHome(home);
        });

        tc.Run("(ii) a second createPersona on the same card puts the new one first and keeps the other; the same pair is an update", [](TestCase &t)
        {
            const fs::path home = makeHome();
            const launcher::Config c = customAt("203.0.113.5");
            std::string note;
            t.IsTrue(ps::createPersona(home.string(), c, "alpha", "pwa", note), "the first");
            t.IsTrue(ps::createPersona(home.string(), c, "bravo", "pwb", note), "the second");
            ps::Cards read = ps::readCards((home / "cards").string());
            t.Equals(read.rows.size(), size_t(2), "two rows");
            if (read.rows.size() == 2)
            {
                t.Equals(read.rows[0].name, std::string("bravo"), "the new one first, in the card's order");
                t.Equals(read.rows[1].name, std::string("alpha"), "the other kept");
            }
            t.IsTrue(ps::createPersona(home.string(), c, "alpha", "pwa2", note), "alpha again, a new password");
            std::vector<card::Persona> records;
            std::string why;
            t.IsTrue(card::readCardFile(readBytes(cardFile(home, "player")), records, why), "read back");
            t.Equals(records.size(), size_t(2), "still two: (host, name) is the key");
            if (records.size() == 2)
                t.IsTrue(records[0].name == "alpha" && records[0].password == "pwa2" && records[1].name == "bravo", "alpha first, updated");
            launcher::Config second = c;
            second.secondInstance = true;
            t.IsTrue(ps::createPersona(home.string(), second, "charlie", "pwc", note), "the second instance's card");
            t.IsTrue(fs::is_regular_file(cardFile(home, "player_b")), "written to cards/player_b/");
            read = ps::readCards((home / "cards").string());
            t.Equals(read.rows.size(), size_t(3), "three rows across two cards");
            if (read.rows.size() == 3)
                t.IsTrue(read.rows[2].name == "charlie" && read.rows[2].card == "player_b" && read.rows[2].second,
                         "cards in name order; the _b card's row is a second instance's");
            removeHome(home);
        });

        tc.Run("(iii) picking the second row rewrites the card with it first; readCards then lists it first", [](TestCase &t)
        {
            const fs::path home = makeHome();
            const std::string cards = (home / "cards").string();
            launcher::Config c = customAt("203.0.113.5");
            std::string note;
            t.IsTrue(ps::createPersona(home.string(), c, "alpha", "pwa", note) && ps::createPersona(home.string(), c, "bravo", "pwb", note), "two");
            const ps::Cards before = ps::readCards(cards);
            t.Equals(before.rows.size(), size_t(2), "bravo, alpha");
            if (before.rows.size() != 2)
            {
                removeHome(home);
                return;
            }
            c.loginPassword = "stale";
            t.IsTrue(ps::pick(c, before.rows[1], cards, note), "the pick of alpha: " + note);
            t.IsTrue(c.loginName == "alpha" && c.profile == "player" && c.loginPassword.empty(), "the pure pick's effect, as before");
            const ps::Cards after = ps::readCards(cards);
            t.Equals(after.rows.size(), size_t(2), "still two");
            if (after.rows.size() == 2)
                t.IsTrue(after.rows[0].name == "alpha" && after.rows[1].name == "bravo", "alpha is first on the card now");
            const std::vector<uint8_t> bytes = readBytes(cardFile(home, "player"));
            t.IsTrue(ps::pick(c, after.rows[0], cards, note), "picking the first row");
            t.IsTrue(readBytes(cardFile(home, "player")) == bytes, "leaves the file untouched");
            removeHome(home);
        });

        tc.Run("(iv) the ledger beside a card supplies lastLogin by name and host (or a name resolving to it); a ledger-only record is no row", [](TestCase &t)
        {
            const fs::path home = makeHome();
            const std::string cards = (home / "cards").string();
            ps::setResolverForTests(&testResolver);
            const launcher::Config c = customAt("203.0.113.5");
            std::string note;
            t.IsTrue(ps::createPersona(home.string(), c, "alpha", "pwa", note) && ps::createPersona(home.string(), c, "bravo", "pwb", note), "two on the card");
            std::vector<ps::Persona> ledger(3);
            ledger[0].name = "alpha";
            ledger[0].server = "203.0.113.5";
            ledger[0].lastLogin = 5000;
            ledger[1].name = "bravo";
            ledger[1].server = "persona-card.test";   // a hostname the game was pointed at; it resolves to the card's HOST
            ledger[1].lastLogin = 7000;
            ledger[2].name = "ghost";                  // logged in once, never on this card
            ledger[2].server = "203.0.113.5";
            ledger[2].lastLogin = 9000;
            writeText(home / "cards" / "player.personas.json", ps::toJson(ledger));
            writeText(home / "cards" / "gone.personas.json", ps::toJson({ledger[0]}));   // no cards/gone/
            const ps::Cards read = ps::readCards(cards);
            t.Equals(read.rows.size(), size_t(2), "the card's two records, not the ledger's three");
            if (read.rows.size() == 2)
            {
                t.IsTrue(read.rows[0].name == "bravo" && static_cast<long long>(read.rows[0].lastLogin) == 7000,
                         "bravo's last login, by a ledger server that resolves to the HOST");
                t.IsTrue(read.rows[1].name == "alpha" && static_cast<long long>(read.rows[1].lastLogin) == 5000, "alpha's, by the address");
            }
            bool ghostNoted = false, goneNoted = false;
            for (const std::string &n : read.notes)
            {
                ghostNoted = ghostNoted || n.find("player.personas.json") != std::string::npos;
                goneNoted = goneNoted || n.find("gone.personas.json") != std::string::npos;
            }
            t.IsTrue(ghostNoted, "the ledger record with no card record is one note, not a row");
            t.IsTrue(goneNoted, "a ledger with no card is one note");
            ledger[0].server = "198.51.100.7";   // alpha's login on another server: no lastLogin for the card's record
            writeText(home / "cards" / "player.personas.json", ps::toJson({ledger[0]}));
            const ps::Cards other = ps::readCards(cards);
            t.IsTrue(other.rows.size() == 2 && other.rows[1].lastLogin == 0, "a login on another host is not this record's");
            ps::setResolverForTests(nullptr);
            removeHome(home);
        });

        tc.Run("(v) an empty name or password is refused with a note and writes nothing; an unreadable card is never overwritten", [](TestCase &t)
        {
            const fs::path home = makeHome();
            const launcher::Config c = customAt("203.0.113.5");
            std::string note;
            t.IsFalse(ps::createPersona(home.string(), c, "", "pw", note), "no name");
            t.IsFalse(note.empty(), "says why");
            note.clear();
            t.IsFalse(ps::createPersona(home.string(), c, "   ", "pw", note), "a name the keyboard cannot type is empty after normalisation");
            t.IsFalse(note.empty(), "says why");
            note.clear();
            t.IsFalse(ps::createPersona(home.string(), c, "alpha", "", note), "no password");
            t.IsFalse(note.empty(), "says why");
            t.IsFalse(fs::exists(home / "cards"), "and nothing was written, not even the directory");
            std::error_code ec;
            fs::create_directories(cardFile(home, "player").parent_path(), ec);
            writeText(cardFile(home, "player"), "not a card");
            note.clear();
            t.IsFalse(ps::createPersona(home.string(), c, "alpha", "pw", note), "a card file this build cannot read");
            t.IsFalse(note.empty(), "says why");
            const std::vector<uint8_t> kept = readBytes(cardFile(home, "player"));
            t.Equals(std::string(kept.begin(), kept.end()), std::string("not a card"), "and is left as it was");
            const ps::Cards read = ps::readCards((home / "cards").string());
            t.IsTrue(read.rows.empty() && !read.notes.empty(), "readCards lists nothing from it, with a note");
            t.IsTrue(std::string(ps::emptySentence(read)).find("CREATE ON CARD") != std::string::npos, "the empty sentence names the creator");
            removeHome(home);
        });

        tc.Run("the resolved server: a dotted address as is, a port kept apart, a name through the resolver, a failure empty", [](TestCase &t)
        {
            ps::setResolverForTests(&testResolver);
            t.Equals(ps::resolveIPv4("203.0.113.9"), std::string("203.0.113.9"), "a dotted quad is itself");
            t.Equals(ps::resolveIPv4("203.0.113.9:10080"), std::string("203.0.113.9"), "the port is not the host");
            t.Equals(ps::serverPort("203.0.113.9:10080"), 10080, "and is the PORT");
            t.Equals(ps::serverPort("203.0.113.9"), 10075, "10075 when none is given");
            t.Equals(ps::resolveIPv4("persona-card.test"), std::string("203.0.113.5"), "a name resolves");
            t.Equals(ps::resolveIPv4("nowhere.test"), std::string(), "a name that does not is empty");
            t.Equals(ps::resolvedServer(customAt("persona-card.test")), std::string("203.0.113.5"), "resolvedServer resolves effectiveServer");
            ps::Persona row;
            row.name = "alpha";
            row.server = "203.0.113.5";
            t.IsTrue(ps::counts(row, customAt("persona-card.test")), "a card row counts on the name that resolves to its HOST");
            t.IsFalse(ps::counts(row, customAt("198.51.100.7")), "and not on another address");
            t.IsTrue(ps::counts(row, customAt("203.0.113.5:10075")), "an address with its port counts on the HOST without it");
            t.IsTrue(ps::counts(row, customAt("persona-card.test:10075")), "and so does a name with its port");
            std::string note;
            const fs::path home = makeHome();
            t.IsFalse(ps::createPersona(home.string(), customAt("nowhere.test"), "alpha", "pw", note), "an unresolvable server writes nothing");
            t.IsTrue(note.find("nowhere.test") != std::string::npos, "and the note names it");
            t.IsFalse(fs::exists(home / "cards"), "not even the directory");
            removeHome(home);
            ps::setResolverForTests(nullptr);
        });

        tc.Run("(vi) review finding 1: a Custom server with a MUIS Endpoint writes HOST from the Endpoint; a row on it counts", [](TestCase &t)
        {
            // A self-hosted server: the launcher reaches it at 127.0.0.1, its muis.json names the LAN address, and the
            // game connects to (and the card's HOST holds) the Endpoint -- never the loopback address.
            const fs::path home = makeHome();
            ps::setResolverForTests(&testResolver);   // the preset's name below must not leave the host
            launcher::Config c = customAt("127.0.0.1");
            c.serverEndpoint = "198.51.100.20";   // a documentation address standing in for the LAN one
            t.Equals(ps::cardHost(c), std::string("198.51.100.20"), "the card's HOST is the Endpoint");
            std::string note;
            t.IsTrue(ps::createPersona(home.string(), c, "lanpc", "pwlan", note), "created: " + note);
            std::vector<card::Persona> records;
            std::string why;
            t.IsTrue(card::readCardFile(readBytes(cardFile(home, "player")), records, why), "read back: " + why);
            t.IsTrue(records.size() == 1 && records[0].host == "198.51.100.20", "HOST 198.51.100.20, not 127.0.0.1");
            const ps::Cards read = ps::readCards((home / "cards").string());
            t.IsTrue(read.rows.size() == 1 && ps::counts(read.rows[0], c), "the row counts on the server the config points at");
            t.IsTrue(read.rows.size() == 1 && !ps::counts(read.rows[0], customAt("127.0.0.1")),
                     "and not on 127.0.0.1 with no Endpoint: that is the address the game would not match");
            launcher::Config plain = customAt("203.0.113.5");
            t.Equals(ps::cardHost(plain), std::string("203.0.113.5"), "no Endpoint: HOST is the resolved address, as before");
            launcher::Config preset;
            preset.serverPreset = "unzipped";
            preset.serverEndpoint = "198.51.100.20";   // left over from a Custom server
            t.IsTrue(ps::cardHost(preset) != "198.51.100.20", "a preset's HOST is its own address; a Custom Endpoint does not follow it");
            launcher::Config loaded;
            t.IsTrue(launcher::fromJson(launcher::toJson(c), loaded), "config.json round-trips");
            t.Equals(loaded.serverEndpoint, std::string("198.51.100.20"), "and keeps the Endpoint under its own key");
            ps::setResolverForTests(nullptr);
            removeHome(home);
        });

        tc.Run("(vii) review finding 4: a pick made while the game runs is held and put first at LAUNCH, while it is still the pick", [](TestCase &t)
        {
            const fs::path home = makeHome();
            const std::string cards = (home / "cards").string();
            launcher::Config c = customAt("203.0.113.5");
            std::string note;
            t.IsTrue(ps::createPersona(home.string(), c, "alpha", "pwa", note) && ps::createPersona(home.string(), c, "bravo", "pwb", note), "two");
            const ps::Cards before = ps::readCards(cards);
            if (before.rows.size() != 2)
            {
                t.IsTrue(false, "bravo, alpha");
                removeHome(home);
                return;
            }
            ps::PendingFirst pending;
            t.IsTrue(ps::applyPendingFirst(pending, c, cards, note), "nothing held: nothing to do");
            // The game is running: the pick switches the config and the card is left alone -- but the pick is held.
            ps::pick(c, before.rows[1]);
            ps::holdFirst(pending, before.rows[1]);
            t.IsTrue(pending.held, "held");
            t.IsTrue(ps::readCards(cards).rows[0].name == "bravo", "the card untouched while the game runs");
            // LAUNCH: the same moveFirst the pick uses, before the game starts.
            t.IsTrue(ps::applyPendingFirst(pending, c, cards, note), "applied at LAUNCH: " + note);
            t.IsFalse(pending.held, "and let go");
            const ps::Cards after = ps::readCards(cards);
            t.IsTrue(after.rows.size() == 2 && after.rows[0].name == "alpha", "alpha is first on the card now");
            // A held pick the player then moved away from (NEW PERSONA, another row) is dropped, not applied.
            ps::holdFirst(pending, after.rows[1]);   // bravo
            ps::pickNewPersona(c);
            const std::vector<uint8_t> bytes = readBytes(cardFile(home, "player"));
            t.IsTrue(ps::applyPendingFirst(pending, c, cards, note), "a stale pick is no failure");
            t.IsFalse(pending.held, "it is let go");
            t.IsTrue(readBytes(cardFile(home, "player")) == bytes, "and the card is left as it was");
            removeHome(home);
        });

        tc.Run("(viii) review finding 6: a failed lookup is asked again after kResolveRetrySeconds, and CREATE asks at once", [](TestCase &t)
        {
            ps::setResolverForTests(&flakyResolver);
            ps::setClockForTests(&testClock);
            g_upNow = false;
            g_asked = 0;
            g_now = 1000;
            t.Equals(ps::resolveIPv4("later.test"), std::string(), "offline: no address");
            t.Equals(g_asked, 1, "asked once");
            t.Equals(ps::resolveIPv4("later.test"), std::string(), "asked again at once: still none");
            t.Equals(g_asked, 1, "from the failure's memory -- the frame path does not ask every frame");
            g_upNow = true;
            g_now += ps::kResolveRetrySeconds;
            t.Equals(ps::resolveIPv4("later.test"), std::string("203.0.113.8"), "the network is back: the next need asks again");
            t.Equals(g_asked, 2, "one more question");
            // CREATE ON CARD is a player's press, not a frame: it asks at once even inside the retry interval.
            ps::setResolverForTests(&flakyResolver);   // clears the cache
            g_upNow = false;
            g_asked = 0;
            t.Equals(ps::resolveIPv4("later.test"), std::string(), "offline again");
            g_upNow = true;
            const fs::path home = makeHome();
            std::string note;
            t.IsTrue(ps::createPersona(home.string(), customAt("later.test"), "alpha", "pw", note), "CREATE resolves now: " + note);
            t.Equals(g_asked, 2, "by asking, not by reading the failure");
            removeHome(home);
            ps::setClockForTests(nullptr);
            ps::setResolverForTests(nullptr);
            g_upNow = false;
        });

        tc.Run("(ix) review finding 5: the headless creator's running-game test knows a game image in the home by its folder and name", [](TestCase &t)
        {
            const std::string home = fs::path("C:/games/socom").string();
            t.IsTrue(launcher::isGameImage(home, (fs::path(home) / "socom2.exe").string(), "socom2.exe"), "r0001's exe in the home");
            t.IsTrue(launcher::isGameImage(home, (fs::path(home) / "socom2_r0004.exe").string(), "socom2.exe"), "r0004's exe in the home");
#ifdef _WIN32
            t.IsTrue(launcher::isGameImage(home, (fs::path(home) / "SOCOM2.EXE").string(), "socom2.exe"), "Windows names ignore case");
#endif
            t.IsFalse(launcher::isGameImage(home, (fs::path(home) / "socom_unzipped_launcher.exe").string(), "socom2.exe"), "the launcher is not the game");
            t.IsFalse(launcher::isGameImage(home, (fs::path("C:/other") / "socom2.exe").string(), "socom2.exe"), "a game in another folder writes another card");
            t.IsFalse(launcher::isGameImage(home, std::string(), "socom2.exe"), "an image with no path is nothing");
        });
    });
}
