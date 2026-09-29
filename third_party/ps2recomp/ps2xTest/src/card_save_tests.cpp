// The persona-card plan (docs/superpowers/plans/2026-09-28-persona-card-creator.md) Task 1: the card's save file --
// the scrambler, the ZAR v2 archive, the AcctInfo.rdr records and the whole-file read and write (launcher/card_save.h)
// -- on the three fixture cards under ps2xTest/fixtures/cards/ (virgin: no persona; one: s27pa; two: s16pc then s16pd)
// and a temp directory, never a real card (section 2).
#include "MiniTest.h"
#include "launcher/card_save.h"

#include <chrono>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

namespace
{
    namespace fs = std::filesystem;
    namespace card = launcher::card;

    std::vector<uint8_t> fixture(const std::string &leaf)
    {
        std::ifstream in(fs::path(PS2X_TEST_FIXTURES_DIR) / "cards" / leaf, std::ios::binary);
        return std::vector<uint8_t>(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
    }

    int32_t word(const std::vector<uint8_t> &b, std::size_t i)
    {
        int32_t v = 0;
        if (b.size() >= (i + 1) * 4)
            std::memcpy(&v, b.data() + i * 4, 4);
        return v;
    }

    // The keys in the archive's pre-order, as tools_py/card_save.py --keys lists them.
    void preorder(const card::ZarKey &k, std::vector<const card::ZarKey *> &out)
    {
        out.push_back(&k);
        for (const auto &c : k.children)
            preorder(c, out);
    }

    std::vector<std::string> names(const card::ZarKey &root)
    {
        std::vector<const card::ZarKey *> keys;
        preorder(root, keys);
        std::vector<std::string> out;
        for (const auto *k : keys)
            out.push_back(k->name);
        return out;
    }

    const card::ZarKey *findKey(const card::ZarKey &root, const std::string &name)
    {
        std::vector<const card::ZarKey *> keys;
        preorder(root, keys);
        for (const auto *k : keys)
            if (k->name == name)
                return k;
        return nullptr;
    }

    std::vector<uint8_t> acctInfoOf(const std::string &leaf)
    {
        card::ZarKey root;
        std::string why;
        if (!card::parseZar(card::unscramble(fixture(leaf)), root, why))
            return {};
        const card::ZarKey *k = findKey(root, "AcctInfo.rdr");
        return k ? k->data : std::vector<uint8_t>{};
    }

    card::Persona persona(const std::string &name, const std::string &password)
    {
        card::Persona p;
        p.host = "3.143.65.100";
        p.name = name;
        p.password = password;
        return p;
    }

    fs::path makeHome()
    {
        static int counter = 0;
        const auto ticks = std::chrono::steady_clock::now().time_since_epoch().count();
        const fs::path root = fs::temp_directory_path() / ("ps2x_card_save_" + std::to_string(ticks) + "_" + std::to_string(counter++));
        std::error_code ec;
        fs::create_directories(root / "cards" / "player" / "BASCUS-97275SOCOMII", ec);
        return root;
    }

    void removeHome(const fs::path &home)
    {
        std::error_code ec;
        fs::remove_all(home, ec);
    }

    const std::vector<std::string> kTwoKeys = {
        "", "zSaveHeader", "CSaveModuleList", "CUIVarManager",
        "MPLOCALSOP1.rdr", "MPLOCALSOP2.rdr", "MPLOCALSOP3.rdr", "MPLOCALSOP4.rdr", "MPLOCALSOP5.rdr",
        "MPTAUNTMSG1.rdr", "MPTAUNTMSG2.rdr", "MPTAUNTMSG3.rdr", "MPTAUNTMSG4.rdr", "MPTAUNTMSG5.rdr",
        "CValveSaveManager", "PersistentValves.rdr", "CAcctDB", "AcctInfo.rdr"};
}

void register_card_save_tests()
{
    MiniTest::Case("CardSave", [](TestCase &tc)
    {
        tc.Run("(a) the scrambler: two.bin decodes to a V2 head with 18 keys; scramble(unscramble(x)) == x for all three", [](TestCase &t)
        {
            const std::vector<uint8_t> two = fixture("two.bin");
            t.Equals(two.size(), size_t(6400), "the fixture is there (6400 bytes)");
            const std::vector<uint8_t> plain = card::unscramble(two);
            t.Equals(plain.size(), two.size(), "the cipher keeps the length");
            t.Equals(word(plain, 24), card::kZarVersion2, "HEAD word 24 is version 0x20002");
            t.Equals(word(plain, 1), int32_t(18), "HEAD word 1: 18 keys");
            t.Equals(word(plain, 23), int32_t(14), "HEAD word 23: appversion 14");
            t.Equals(word(plain, 4), int32_t(16), "HEAD word 4: padding 16");
            for (const char *leaf : {"virgin.bin", "one.bin", "two.bin"})
            {
                const std::vector<uint8_t> x = fixture(leaf);
                t.IsFalse(x.empty(), std::string(leaf) + " is there");
                t.IsTrue(card::scramble(card::unscramble(x)) == x, std::string(leaf) + ": scramble(unscramble(x)) == x");
                t.IsTrue(card::unscramble(card::scramble(x)) == x, std::string(leaf) + ": and the other way round");
            }
            t.IsTrue(card::unscramble({}).empty() && card::scramble({}).empty(), "the empty input is the empty output");
            t.IsTrue(card::scramble(card::unscramble({0x41})) == std::vector<uint8_t>{0x41}, "one byte: the forward pass alone");
        });

        tc.Run("(b) parseZar names the keys in pre-order; buildZar(parse(x)) re-parses to the same tree", [](TestCase &t)
        {
            card::ZarKey two;
            std::string why;
            t.IsTrue(card::parseZar(card::unscramble(fixture("two.bin")), two, why), "two.bin parses: " + why);
            t.Equals(names(two), kTwoKeys, "root, zSaveHeader, CSaveModuleList -> CUIVarManager (10), CValveSaveManager, CAcctDB");
            t.Equals(two.children.size(), size_t(2), "the root holds zSaveHeader and CSaveModuleList");
            const card::ZarKey *header = findKey(two, "zSaveHeader");
            t.IsTrue(header && header->data.size() == 268 && word(header->data, 0) == 268 && word(header->data, 1) == 14,
                     "zSaveHeader: 268 bytes, word 0 = 268, word 1 = 14");
            const card::ZarKey *valves = findKey(two, "PersistentValves.rdr");
            t.IsTrue(valves && valves->data.size() == 4144, "PersistentValves.rdr: 4144 bytes");
            const card::ZarKey *acct = findKey(two, "AcctInfo.rdr");
            t.IsTrue(acct && acct->data.size() == 688, "AcctInfo.rdr: 688 bytes");

            for (const char *leaf : {"virgin.bin", "one.bin", "two.bin"})
            {
                card::ZarKey a, b;
                std::string w1, w2;
                t.IsTrue(card::parseZar(card::unscramble(fixture(leaf)), a, w1), std::string(leaf) + " parses: " + w1);
                const std::vector<uint8_t> rebuilt = card::buildZar(a);
                t.IsTrue(card::parseZar(rebuilt, b, w2), std::string(leaf) + " rebuilt parses: " + w2);
                t.IsTrue(a == b, std::string(leaf) + ": the rebuilt archive is the same tree, bytes and all");
                t.Equals(word(rebuilt, 24), card::kZarVersion2, std::string(leaf) + ": the rebuild is V2");
                t.Equals(word(rebuilt, 23), int32_t(14), std::string(leaf) + ": appversion 14");
                t.Equals(word(rebuilt, 3), int32_t(0), std::string(leaf) + ": stable_ofs 0");
                t.Equals(rebuilt.size() % 16, size_t(0), std::string(leaf) + ": the data padded to 16, as the game's file");
            }

            card::ZarKey junk;
            t.IsFalse(card::parseZar(fixture("two.bin"), junk, why), "the scrambled file is not an archive");
            t.IsFalse(why.empty(), "and says why");
            std::vector<uint8_t> cut = card::unscramble(fixture("two.bin"));
            cut.resize(300);
            t.IsFalse(card::parseZar(cut, junk, why), "a truncated archive is refused, not read past its end");
            t.IsFalse(card::parseZar({}, junk, why), "the empty input is refused");
        });

        tc.Run("(c) readPersonas: two.bin gives s16pc then s16pd on 3.143.65.100:10075; virgin gives none", [](TestCase &t)
        {
            std::vector<card::Persona> rows;
            std::string why;
            t.IsTrue(card::readPersonas(acctInfoOf("two.bin"), rows, why), "two.bin's AcctInfo.rdr reads: " + why);
            t.Equals(rows.size(), size_t(2), "two records");
            if (rows.size() == 2)
            {
                t.Equals(rows[0].name, std::string("s16pc"), "the first NAME");
                t.Equals(rows[0].password, std::string("pwsixc"), "its PASSWORD, plain");
                t.Equals(rows[0].host, std::string("3.143.65.100"), "its HOST");
                t.Equals(rows[0].port, 10075, "its PORT");
                t.IsTrue(rows[0].savePassword, "SAVEPASSWORD 1");
                t.Equals(rows[0].town, std::string(""), "TOWN empty");
                t.Equals(rows[0].gender, 0, "GENDER 0");
                t.IsTrue(rows[0].checksum == std::array<int32_t, 16>{}, "PROFILE_CHECKSUM all zero");
                t.Equals(rows[1].name, std::string("s16pd"), "the second NAME");
                t.Equals(rows[1].password, std::string("pwsixd"), "its PASSWORD (the game's shared nodes followed)");
                t.Equals(rows[1].host, std::string("3.143.65.100"), "its HOST, a node shared with the first (flags 4)");
                t.Equals(rows[1].port, 10075, "its PORT, shared too");
            }
            t.IsTrue(card::readPersonas(acctInfoOf("one.bin"), rows, why) && rows.size() == 1 && rows[0].name == "s27pa" &&
                         rows[0].password == "s27pa2",
                     "one.bin: s27pa");
            t.IsTrue(card::readPersonas(acctInfoOf("virgin.bin"), rows, why), "virgin's 24-byte blob reads: " + why);
            t.IsTrue(rows.empty(), "and holds no persona");

            std::vector<uint8_t> cut = acctInfoOf("two.bin");
            cut.resize(200);
            t.IsFalse(card::readPersonas(cut, rows, why), "a truncated blob is refused, not read past its end");
            t.IsFalse(card::readPersonas({1, 0, 0}, rows, why), "a blob shorter than its header is refused");
        });

        tc.Run("(d) writePersonas(readPersonas(two)) re-reads equal; one.bin's record writes the game's own bytes", [](TestCase &t)
        {
            std::vector<card::Persona> rows, again;
            std::string why;
            card::readPersonas(acctInfoOf("two.bin"), rows, why);
            const std::vector<uint8_t> blob = card::writePersonas(rows);
            t.IsTrue(card::readPersonas(blob, again, why), "the written blob reads: " + why);
            t.IsTrue(rows == again && rows.size() == 2, "the same two records, in order");
            t.Equals(word(blob, 0), int32_t(1), "header word 0 is 1");
            t.Equals(word(blob, 2) % 16, int32_t(0), "node_ofs is 16-aligned");
            t.Equals(word(blob, 2), (12 + word(blob, 1) + 15) / 16 * 16, "node_ofs = 12 + stable_size rounded up to 16");

            // One record has nothing to share, so a writer laying the nodes out as the game does writes its bytes.
            card::readPersonas(acctInfoOf("one.bin"), rows, why);
            t.IsTrue(card::writePersonas(rows) == acctInfoOf("one.bin"), "one.bin: byte for byte the game's AcctInfo.rdr");
            t.IsTrue(card::writePersonas({}) == acctInfoOf("virgin.bin"), "no record: byte for byte virgin's 24-byte blob");

            card::Persona odd = persona("x", "");
            odd.gender = 1;
            odd.port = 10078;
            odd.savePassword = false;
            odd.town = "t";
            odd.checksum[0] = -5;
            odd.checksum[15] = 0x12345678;
            t.IsTrue(card::readPersonas(card::writePersonas({odd}), again, why) && again.size() == 1 && again[0] == odd,
                     "every field round-trips: gender, port, save flag off, empty password, a town, signed checksums");
        });

        tc.Run("(e) writeCardFile({}, {p}) starts from the virgin template; the file on disk reads back {p}", [](TestCase &t)
        {
            const fs::path home = makeHome();
            const fs::path file = home / "cards" / "player" / "BASCUS-97275SOCOMII" / "BASCUS-97275SOCOMII";
            const card::Persona p = persona("s17pc", "hunter2");
            const std::vector<uint8_t> bytes = card::writeCardFile({}, {p});
            t.IsFalse(bytes.empty(), "the template makes a card file");
            {
                std::ofstream out(file, std::ios::binary | std::ios::trunc);
                out.write(reinterpret_cast<const char *>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
            }
            std::vector<uint8_t> disk;
            {
                std::ifstream in(file, std::ios::binary);
                disk.assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
            }
            t.IsTrue(disk == bytes, "written and read back");
            std::vector<card::Persona> rows;
            std::string why;
            t.IsTrue(card::readCardFile(disk, rows, why), "readCardFile reads it: " + why);
            t.IsTrue(rows.size() == 1 && rows[0] == p, "{p}");

            card::ZarKey mine, virgin;
            card::parseZar(card::unscramble(disk), mine, why);
            card::parseZar(card::unscramble(fixture("virgin.bin")), virgin, why);
            t.Equals(names(mine), names(virgin), "the virgin card's keys, in its order");
            const card::ZarKey *h1 = findKey(mine, "zSaveHeader"), *h2 = findKey(virgin, "zSaveHeader");
            const card::ZarKey *v1 = findKey(mine, "PersistentValves.rdr"), *v2 = findKey(virgin, "PersistentValves.rdr");
            t.IsTrue(h1 && h2 && h1->data == h2->data, "the template's zSaveHeader");
            t.IsTrue(v1 && v2 && v1->data == v2->data, "the template's PersistentValves.rdr");

            // The cross-check with the Python reference: created.bin is tools_py/card_save.py's write_card_file(virgin.bin,
            // [s17pc]) (tools_py/tests/test_card_save.py holds it to that and --dump reads it as the one record).
            t.IsTrue(bytes == fixture("created.bin"), "byte for byte the card the Python encoder writes for the same fields");
            t.IsTrue(card::writeCardFile(fixture("virgin.bin"), {p}) == bytes, "the embedded template is virgin.bin decoded");

            t.IsTrue(card::readCardFile(card::writeCardFile({}, {}), rows, why) && rows.empty(), "no persona: a virgin card");
            t.IsTrue(card::writeCardFile({1, 2, 3}, {p}).empty(), "a file that is not a card is not overwritten");
            t.IsFalse(card::readCardFile({1, 2, 3}, rows, why), "nor read");
            removeHome(home);
        });

        tc.Run("(f) writeCardFile(one.bin, {q, p}) reads q then p and keeps every other key's bytes", [](TestCase &t)
        {
            const std::vector<uint8_t> one = fixture("one.bin");
            const card::Persona q = persona("s17pq", "pwq"), p = persona("s17pc", "hunter2");
            const std::vector<uint8_t> bytes = card::writeCardFile(one, {q, p});
            std::vector<card::Persona> rows;
            std::string why;
            t.IsTrue(card::readCardFile(bytes, rows, why), "the rewritten card reads: " + why);
            t.IsTrue(rows.size() == 2 && rows[0] == q && rows[1] == p, "q then p");

            card::ZarKey before, after;
            card::parseZar(card::unscramble(one), before, why);
            card::parseZar(card::unscramble(bytes), after, why);
            std::vector<const card::ZarKey *> a, b;
            preorder(before, a);
            preorder(after, b);
            t.Equals(a.size(), b.size(), "the same 18 keys");
            int kept = 0;
            for (std::size_t i = 0; i < a.size() && i < b.size(); ++i)
            {
                t.Equals(a[i]->name, b[i]->name, "key " + std::to_string(i) + " keeps its name and place");
                t.Equals(a[i]->children.size(), b[i]->children.size(), "and its child count");
                if (a[i]->name != "AcctInfo.rdr")
                    kept += a[i]->data == b[i]->data ? 1 : 0;
            }
            t.Equals(kept, 17, "zSaveHeader, the ten CUIVarManager children, PersistentValves.rdr and the empty keys: identical");
        });
    });
}
