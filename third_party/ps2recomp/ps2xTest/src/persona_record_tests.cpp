// Sprint 16 L1b (#73, R295): the runtime's persona record (socom2_persona_record.cpp) on synthetic bytes -- a
// 104-byte login request laid out as the server's MediusAccountLoginRequest reads it, a response as
// MediusAccountLoginResponse does -- and a ledger under the temp folder, never a real card (the design note, section 4).
#include "MiniTest.h"
#include "launcher/personas.h"
#include "socom2_persona_record.h"

#include <chrono>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

namespace
{
    namespace fs = std::filesystem;
    namespace pr = socom2_persona;

    constexpr uint32_t kState = 0x00655a00u;   // an RC4 state's guest address (any value: the recorder keys on it)

    std::vector<uint8_t> loginRequest(const std::string &messageId, const std::string &username, const std::string &password,
                                      uint8_t cls = 0x01, uint8_t type = 0x07, std::size_t len = 104)
    {
        std::vector<uint8_t> m(len, 0u);
        if (len >= 2)
        {
            m[0] = cls;
            m[1] = type;
        }
        auto put = [&](std::size_t at, const std::string &s, std::size_t width) {
            for (std::size_t i = 0; i < s.size() && i < width && at + i < m.size(); ++i)
                m[at + i] = static_cast<uint8_t>(s[i]);
        };
        put(2, messageId, 21);
        put(23, "13088", 17);   // the SessionKey the server's model defaults to
        put(40, username, 32);
        put(72, password, 32);
        return m;
    }

    std::vector<uint8_t> loginResponse(const std::string &messageId, int32_t status, uint8_t type = 0x08)
    {
        std::vector<uint8_t> m(64, 0u);   // MessageID, pad, StatusCode, then AccountID and the rest
        m[0] = 0x01;
        m[1] = type;
        std::memcpy(m.data() + 2, messageId.data(), messageId.size() < 21 ? messageId.size() : 21);
        std::memcpy(m.data() + 26, &status, 4);
        return m;
    }

    fs::path makeCardRoot()
    {
        static int counter = 0;
        const auto ticks = std::chrono::steady_clock::now().time_since_epoch().count();
        const fs::path root = fs::temp_directory_path() / ("ps2x_persona_record_" + std::to_string(ticks) + "_" + std::to_string(counter++));
        std::error_code ec;
        fs::create_directories(root / "cards" / "player", ec);
        return root;
    }

    void removeCardRoot(const fs::path &root)
    {
        std::error_code ec;
        fs::remove_all(root, ec);
    }

    std::vector<launcher::personas::Persona> ledgerAt(const std::string &path)
    {
        std::vector<launcher::personas::Persona> out;
        std::string note;
        launcher::personas::readLedger(path, out, note);
        return out;
    }

    struct Fixture
    {
        fs::path root = makeCardRoot();
        std::string ledger = launcher::personas::ledgerPathFor((root / "cards" / "player").string() + "/");
        pr::Recorder rec{pr::Context{ledger, "socom.scotho.com", false}, [] { return std::time_t(1790000000); }};
        ~Fixture() { removeCardRoot(root); }

        void send(const std::vector<uint8_t> &m, uint32_t counter = 0) { rec.encrypt(kState, counter, m.data(), m.size()); }
        void receive(const std::vector<uint8_t> &m, uint32_t counter = 0) { rec.decrypt(kState + 0x200u, counter, m.data(), m.size()); }
    };
}

void register_persona_record_tests()
{
    MiniTest::Case("PersonaRecord", [](TestCase &tc)
    {
        tc.Run("the request parse: class 0x01, type 0x07, 104 bytes; Username at 40, Password at 72, the MessageID", [](TestCase &t)
        {
            const std::vector<uint8_t> m = loginRequest("msgid-0001", "alpha", "hunter2");
            pr::LoginRequest r;
            t.IsTrue(pr::parseLoginRequest(m.data(), m.size(), r), "a login request");
            t.Equals(r.username, std::string("alpha"), "the Username field, to its terminator");
            t.Equals(r.password, std::string("hunter2"), "the Password field");
            t.Equals(r.messageId.substr(0, 10), std::string("msgid-0001"), "the MessageID");
            t.Equals(r.messageId.size(), size_t(21), "all 21 bytes of it");
            const std::string full(32, 'n');
            const std::vector<uint8_t> wide = loginRequest("m", full, "p");
            t.IsTrue(pr::parseLoginRequest(wide.data(), wide.size(), r) && r.username == full, "a name filling its 32 bytes");
            const std::vector<uint8_t> wrongClass = loginRequest("m", "a", "p", 0x02, 0x07);
            const std::vector<uint8_t> wrongType = loginRequest("m", "a", "p", 0x01, 0x08);
            const std::vector<uint8_t> shortOne = loginRequest("m", "a", "p", 0x01, 0x07, 103);
            const std::vector<uint8_t> longOne = loginRequest("m", "a", "p", 0x01, 0x07, 105);
            t.IsFalse(pr::parseLoginRequest(wrongClass.data(), wrongClass.size(), r), "a wrong class is not a login");
            t.IsFalse(pr::parseLoginRequest(wrongType.data(), wrongType.size(), r), "nor a wrong type");
            t.IsFalse(pr::parseLoginRequest(shortOne.data(), shortOne.size(), r), "nor a wrong length, short");
            t.IsFalse(pr::parseLoginRequest(longOne.data(), longOne.size(), r), "or long");
        });

        tc.Run("the response parse: type 0x08, the MessageID, StatusCode little-endian at 26", [](TestCase &t)
        {
            const std::vector<uint8_t> ok = loginResponse("msgid-0001", 0);
            pr::LoginResponse r;
            t.IsTrue(pr::parseLoginResponse(ok.data(), ok.size(), r), "a login response");
            t.Equals(r.status, int32_t(0), "success");
            t.Equals(r.messageId.substr(0, 10), std::string("msgid-0001"), "its MessageID");
            const std::vector<uint8_t> refused = loginResponse("msgid-0001", -1003);
            t.IsTrue(pr::parseLoginResponse(refused.data(), refused.size(), r) && r.status == -1003, "a refusal's status");
            const std::vector<uint8_t> other = loginResponse("msgid-0001", 0, 0x0A);
            t.IsFalse(pr::parseLoginResponse(other.data(), other.size(), r), "another type is not a login response");
            t.IsFalse(pr::parseLoginResponse(ok.data(), 29, r), "nor 29 bytes, short of the StatusCode");
        });

        tc.Run("the writer: pending on the request, committed on the matching success, keyed by (name, server) with the instance", [](TestCase &t)
        {
            Fixture f;
            f.send(loginRequest("msgid-0001", "alpha", "hunter2"));
            t.IsTrue(f.rec.pending().has_value(), "the request is held pending");
            t.IsFalse(fs::exists(f.ledger), "and nothing is written yet");
            f.receive(loginResponse("msgid-0002", 0));
            t.IsTrue(f.rec.pending().has_value() && !fs::exists(f.ledger), "an unmatched MessageID leaves it pending");
            f.receive(loginResponse("msgid-0001", 0));
            t.IsFalse(f.rec.pending().has_value(), "the match commits it");
            t.Equals(f.ledger, (f.root / "cards" / "player.personas.json").string(), "BESIDE the card, the trailing separator stripped");
            const auto rows = ledgerAt(f.ledger);
            t.Equals(rows.size(), size_t(1), "one record");
            if (rows.size() == 1)
            {
                t.Equals(rows[0].name, std::string("alpha"), "the request's name");
                t.Equals(rows[0].server, std::string("socom.scotho.com"), "the knob's server");
                t.Equals(static_cast<long long>(rows[0].lastLogin), 1790000000LL, "the commit's time");
                t.IsTrue(rows[0].savedPassword, "no keyboard opened and a password sent: the card holds it");
                t.IsFalse(rows[0].second, "the first instance");
            }
            t.IsFalse(fs::exists(launcher::personas::tempPathFor(f.ledger)), "written temp-then-rename, no temp left");
            t.IsTrue(fs::is_directory(f.root / "cards" / "player") && fs::is_empty(f.root / "cards" / "player"), "and nothing inside the card");

            // The same persona on a second server is its own record; the same pair again updates it.
            pr::Recorder other{pr::Context{f.ledger, "192.0.2.10", true}, [] { return std::time_t(1790000500); }};
            const std::vector<uint8_t> req = loginRequest("msgid-0003", "alpha", "hunter2");
            other.encrypt(kState, 0, req.data(), req.size());
            const std::vector<uint8_t> res = loginResponse("msgid-0003", 0);
            other.decrypt(kState, 0, res.data(), res.size());
            const auto two = ledgerAt(f.ledger);
            t.Equals(two.size(), size_t(2), "(alpha, another server) is a second record");
            if (two.size() == 2)
                t.IsTrue(two[1].server == "192.0.2.10" && two[1].second, "carrying its server and the instance (RSA key b)");
        });

        tc.Run("the writer: a refusal (StatusCode < 0) drops the pending record and writes nothing", [](TestCase &t)
        {
            Fixture f;
            f.send(loginRequest("msgid-0001", "alpha", "wrong"));
            f.receive(loginResponse("msgid-0001", -1003));
            t.IsFalse(f.rec.pending().has_value(), "dropped");
            t.IsFalse(fs::exists(f.ledger), "no phantom row from a wrong password or a refused create");
            t.Equals(f.rec.commits(), 0, "no commit");
        });

        tc.Run("savedPassword: the password keyboard opened -> false; a retry after a refused CONNECT stays false; a commit clears the flag", [](TestCase &t)
        {
            t.IsTrue(pr::savedPasswordFor(false, "x") && !pr::savedPasswordFor(true, "x") && !pr::savedPasswordFor(false, ""),
                     "the inference: nothing typed and a password sent");
            Fixture f;
            f.rec.passwordKeyboardOpened();
            f.send(loginRequest("msgid-0001", "alpha", "typed1"));
            t.IsTrue(f.rec.pending().has_value() && !f.rec.pending()->record.savedPassword, "typed: false");
            f.receive(loginResponse("msgid-0001", -1003));   // CONNECT refused
            t.IsTrue(f.rec.keyboardFlag(), "a refusal keeps the flag");
            f.send(loginRequest("msgid-0002", "alpha", "typed1"));   // retried untyped under SAVE PASSWORD NO
            t.IsTrue(f.rec.pending().has_value() && !f.rec.pending()->record.savedPassword, "the retry stays false");
            f.receive(loginResponse("msgid-0002", 0));
            const auto rows = ledgerAt(f.ledger);
            t.IsTrue(rows.size() == 1 && !rows[0].savedPassword, "committed false");
            t.IsFalse(f.rec.keyboardFlag(), "and the committed success clears the flag");
            f.send(loginRequest("msgid-0003", "alpha", "typed1"));   // the next launch's login, nothing typed (V6's *****)
            f.receive(loginResponse("msgid-0003", 0));
            const auto again = ledgerAt(f.ledger);
            t.IsTrue(again.size() == 1 && again[0].savedPassword, "then true: the card holds it");
            f.send(loginRequest("msgid-0004", "alpha", ""));   // CONNECT with an empty password reaches the wire
            t.IsTrue(f.rec.pending().has_value() && !f.rec.pending()->record.savedPassword, "an empty password is false");
        });

        tc.Run("reassembly (RED first): 50 + 54 bytes on one RC4 state after a rekey are one pending record", [](TestCase &t)
        {
            Fixture f;
            const std::vector<uint8_t> m = loginRequest("msgid-0001", "alpha", "hunter2");
            f.rec.encrypt(kState, 0, m.data(), 50);          // the counter at 0: a message opens
            t.IsFalse(f.rec.pending().has_value(), "half a message is not a record");
            f.rec.encrypt(kState, 50, m.data() + 50, 54);    // the counter says it continues
            t.IsTrue(f.rec.pending().has_value(), "the two halves are the login");
            if (f.rec.pending().has_value())
                t.Equals(f.rec.pending()->record.name, std::string("alpha"), "with its name across the seam");
            // A response in two pieces as well.
            const std::vector<uint8_t> r = loginResponse("msgid-0001", 0);
            f.rec.decrypt(kState + 0x200u, 0, r.data(), 20);
            f.rec.decrypt(kState + 0x200u, 20, r.data() + 20, r.size() - 20);
            t.Equals(f.rec.commits(), 1, "and commits");
        });

        tc.Run("reassembly (RED first): a second rekey on that state after the 50 discards the half message", [](TestCase &t)
        {
            Fixture f;
            const std::vector<uint8_t> m = loginRequest("msgid-0001", "alpha", "hunter2");
            f.rec.encrypt(kState, 0, m.data(), 50);
            // rc4SetKeyHash zeroes the counter, so the next call on the state opens a NEW message.
            f.rec.encrypt(kState, 0, m.data() + 50, 54);
            t.IsFalse(f.rec.pending().has_value(), "no record from the half and a stranger's tail");
            const std::vector<uint8_t> other = loginRequest("msgid-0009", "bravo", "x");
            f.rec.encrypt(kState + 0x40u, 50, other.data() + 50, 54);   // a continuation on a state with nothing open
            t.IsFalse(f.rec.pending().has_value(), "a tail with no head is nothing");
        });
    });
}
