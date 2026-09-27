// Sprint 16 L1b (#73, R295): the runtime's persona record (socom2_persona_record.cpp) on synthetic bytes -- a
// 104-byte login request laid out as the server's MediusAccountLoginRequest reads it, a response as
// MediusAccountLoginResponse does -- and a ledger under the temp folder, never a real card (the design note, section 4).
#include "MiniTest.h"
#include "launcher/personas.h"
#include "socom2_persona_record.h"
#include "socom2_rt_frames.h"

#include <algorithm>
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

    // len 198 is the Medius 1.50 answer (the seam reading, section 2): class, type, then 196 bytes of body.
    std::vector<uint8_t> loginResponse(const std::string &messageId, int32_t status, uint8_t type = 0x08, std::size_t len = 64)
    {
        std::vector<uint8_t> m(len, 0u);   // MessageID, pad, StatusCode, then AccountID and the rest
        m[0] = 0x01;
        m[1] = type;
        // What the server writes (BinaryWriterExt.Write(str, 21)): a string of 21 or more characters is cut to 20 and
        // a NUL, so the echo never carries all 21 bytes.
        std::memcpy(m.data() + 2, messageId.data(), messageId.size() < 20 ? messageId.size() : 20);
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
        Fixture() { rec.keyboardObserverWraps(2, 2); }   // the runner's case: both keyboard entries wrapped
        ~Fixture() { removeCardRoot(root); }

        void send(const std::vector<uint8_t> &m, uint32_t counter = 0) { rec.encrypt(kState, counter, m.data(), m.size()); }
        void receive(const std::vector<uint8_t> &m, uint32_t counter = 0) { rec.decrypt(kState + 0x200u, counter, m.data(), m.size()); }
    };

    // An RT frame as Horizon writes one (BaseScertMessage.Serialize): the id (0x80 set when encrypted), the body's length
    // little-endian, a 4-byte hash only on an encrypted frame with a body (ScertTcpFrameDecoder), then the body.
    std::vector<uint8_t> rtFrame(uint8_t id, const std::vector<uint8_t> &body)
    {
        std::vector<uint8_t> f{id, static_cast<uint8_t>(body.size()), static_cast<uint8_t>(body.size() >> 8)};
        if ((id & 0x80u) != 0 && !body.empty())
            f.insert(f.end(), {0xA1, 0xB2, 0xC3, 0xD4});   // a hash: any four bytes
        f.insert(f.end(), body.begin(), body.end());
        return f;
    }

    // One descriptor's receive side as socom2_hostnet::recv runs it, without the socket or the global recorder: the
    // walk, and each kept (plain SERVER_APP) body handed to decrypt() under the descriptor's socket state at counter 0.
    struct Wire
    {
        pr::Recorder &rec;
        int fd = 7;
        socom2_rt::Carry carry;
        std::vector<socom2_rt::Frame> seen;   // their body pointers dangle after the call: id, len and kept only
        void recv(const std::vector<uint8_t> &bytes, std::size_t from = 0, std::size_t to = SIZE_MAX)
        {
            to = std::min(to, bytes.size());
            socom2_rt::splitRtFrames(carry, bytes.data() + from, to - from, true, [&](const socom2_rt::Frame &f) {
                seen.push_back(f);
                if (f.kept)
                    rec.decrypt(pr::socketState(fd), 0, f.body, f.len);
            });
        }
    };

    std::vector<uint8_t> cat(std::initializer_list<std::vector<uint8_t>> parts)
    {
        std::vector<uint8_t> out;
        for (const auto &p : parts)
            out.insert(out.end(), p.begin(), p.end());
        return out;
    }
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
            t.Equals(r.messageId, std::string("msgid-0001"), "the MessageID, to its terminator (the server reads a C string)");
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
            t.Equals(r.messageId, std::string("msgid-0001"), "its MessageID, to its terminator");
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

        tc.Run("the MessageID is a C string (RED first): garbage after the request's NUL still commits on the server's zero-padded answer", [](TestCase &t)
        {
            // MessageId.Deserialize reads to the NUL and Serialize pads with zeros, so the answer never echoes what
            // the game left after its terminator.
            Fixture f;
            f.send(loginRequest(std::string("msgid-0001\0\xAA\xBB\x5A\x01\xFF", 16), "alpha", "hunter2"));
            t.IsTrue(f.rec.pending().has_value(), "the request is held pending");
            f.receive(loginResponse("msgid-0001", 0));
            t.Equals(f.rec.commits(), 1, "the zero-padded answer matches it and commits");
            t.Equals(ledgerAt(f.ledger).size(), size_t(1), "one record");
            f.send(loginRequest("msgid-0002", "alpha", "hunter2"));
            f.receive(loginResponse(std::string("msgid-0002\0\x33", 12), -1003));
            t.Equals(f.rec.commits(), 1, "bytes after the answer's NUL are ignored too: this refusal is matched and drops it");
            t.IsFalse(f.rec.pending().has_value(), "dropped");
            f.send(loginRequest("msgid-0003", "alpha", "hunter2"));
            f.receive(loginResponse("msgid-00031", 0));
            t.IsTrue(f.rec.pending().has_value() && f.rec.commits() == 1, "a longer MessageID is another message's");
        });

        tc.Run("a MessageID filling all 21 bytes (RED first): the server's echo keeps 20 and a NUL, and it still commits", [](TestCase &t)
        {
            Fixture f;
            const std::string full(21, 'x');
            f.send(loginRequest(full, "alpha", "hunter2"));   // all 21 bytes significant, no NUL in the field
            t.IsTrue(f.rec.pending().has_value(), "the request is held pending");
            const std::vector<uint8_t> echo = loginResponse(full, 0);
            t.Equals(std::string(reinterpret_cast<const char *>(echo.data() + 2), 21), std::string(20, 'x') + '\0',
                     "the answer carries 20 'x' and a NUL, as the server writes it");
            f.receive(echo);
            t.Equals(f.rec.commits(), 1, "the 20-byte echo matches the 21-byte request and commits");
            t.IsFalse(f.rec.pending().has_value(), "answered");
            t.Equals(ledgerAt(f.ledger).size(), size_t(1), "one record");
        });

        tc.Run("savedPassword (RED first): false, never true, while the keyboard observer is not live (no wrap, half a wrap)", [](TestCase &t)
        {
            Fixture f;
            pr::Recorder cold{pr::Context{f.ledger, "socom.scotho.com", false}, [] { return std::time_t(1790000000); }};
            const std::vector<uint8_t> req = loginRequest("msgid-0001", "alpha", "hunter2");
            cold.encrypt(kState, 0, req.data(), req.size());
            t.IsFalse(cold.observerLive(), "never told: not live");
            t.IsTrue(cold.pending().has_value() && !cold.pending()->record.savedPassword, "no observer: false, though nothing was seen typed");
            cold.keyboardObserverWraps(0, 2);   // oskOpen is not a function
            cold.encrypt(kState, 0, req.data(), req.size());
            t.IsTrue(cold.pending().has_value() && !cold.pending()->record.savedPassword, "no entry wrapped: false");
            cold.keyboardObserverWraps(1, 2);   // the handler alone: the thunk the action table calls is unwatched
            cold.encrypt(kState, 0, req.data(), req.size());
            t.IsFalse(cold.observerLive(), "one of two is not live");
            t.IsTrue(cold.pending().has_value() && !cold.pending()->record.savedPassword, "half a wrap: false");
            const std::vector<uint8_t> res = loginResponse("msgid-0001", 0);
            cold.decrypt(kState, 0, res.data(), res.size());
            const auto rows = ledgerAt(f.ledger);
            t.IsTrue(rows.size() == 1 && !rows[0].savedPassword, "committed false: the launcher keeps the plain password");
            cold.keyboardObserverWraps(2, 2);
            t.IsTrue(cold.observerLive(), "both entries: live");
            cold.encrypt(kState, 0, req.data(), req.size());
            t.IsTrue(cold.pending().has_value() && cold.pending()->record.savedPassword, "and only then the inference runs");
        });

        tc.Run("reassembly (RED first): a counter-0 message that is not the lobby login copies nothing, either direction", [](TestCase &t)
        {
            Fixture f;
            std::vector<uint8_t> other(600, 0x5Au);
            other[0] = 0x02;   // another class
            f.rec.encrypt(kState, 0, other.data(), other.size());
            f.rec.decrypt(kState + 0x200u, 0, other.data(), other.size());
            other[0] = 0x01;
            other[1] = 0x0A;   // the lobby class, another type
            f.rec.encrypt(kState, 0, other.data(), other.size());
            f.rec.decrypt(kState + 0x200u, 0, other.data(), other.size());
            t.Equals(f.rec.bufferedBytes(), size_t(0), "the class and type bytes are read before any copy");
            other[1] = 0x07;   // the login's class and type, but longer than a login can be
            f.rec.encrypt(kState, 0, other.data(), other.size());
            t.Equals(f.rec.bufferedBytes(), size_t(0), "nor a first chunk past the message's size");
            const std::vector<uint8_t> m = loginRequest("msgid-0001", "alpha", "hunter2");
            f.rec.encrypt(kState, 0, m.data(), 1);   // one byte: the type is still to come
            f.rec.encrypt(kState, 1, m.data() + 1, 103);
            t.Equals(f.rec.bufferedBytes(), size_t(104), "the login itself is put together");
            t.IsTrue(f.rec.pending().has_value(), "and held");
            const std::vector<uint8_t> m2 = loginRequest("msgid-0002", "alpha", "hunter2");
            f.rec.encrypt(kState, 0, m2.data(), 50);
            f.rec.encrypt(kState, 0, other.data(), other.size());   // a stranger opens on that state
            f.rec.encrypt(kState, 50, m2.data() + 50, 54);
            t.IsTrue(f.rec.pending().has_value() && f.rec.pending()->messageId == "msgid-0001" && f.rec.bufferedBytes() == 154,
                     "the stranger still drops the half message open there");
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

    // The seam reading (logs/l1b_seam_reading.md, section 4): Horizon's MAS and MLS answer PLAIN, so the login response
    // never crosses rc4DecryptFn; socom2_hostnet walks the RT frames and hands a plain SERVER_APP body to decrypt().
    MiniTest::Case("PersonaSocket", [](TestCase &tc)
    {
        tc.Run("the walk (RED first): a 23-byte accept and a 2-byte complete in one chunk are two frames, neither handed on", [](TestCase &t)
        {
            Fixture f;
            Wire w{f.rec};
            std::vector<uint8_t> accept(23, 0u);   // UNK_07 {01 08 10}, PlayerId 2, PlayerCount 2, IP 16
            accept[0] = 0x01;
            accept[1] = 0x08;
            accept[2] = 0x10;
            w.recv(cat({rtFrame(0x07, accept), rtFrame(0x1A, {0x01, 0x00})}));
            t.Equals(w.seen.size(), size_t(2), "two frames in one chunk");
            if (w.seen.size() == 2)
            {
                t.IsTrue(w.seen[0].id == 0x07 && w.seen[0].len == 23 && !w.seen[0].kept, "CONNECT_ACCEPT_TCP, 23 bytes, not an app frame");
                t.IsTrue(w.seen[1].id == 0x1A && w.seen[1].len == 2 && !w.seen[1].kept, "CONNECT_COMPLETE, 2 bytes");
            }
            t.Equals(f.rec.bufferedBytes(), size_t(0), "the recorder saw neither: their 01 08 is not a login response");
        });

        tc.Run("a plain SERVER_APP login response, 3 + 198 bytes over two recv chunks, commits once the second lands (RED first)", [](TestCase &t)
        {
            Fixture f;
            Wire w{f.rec};
            f.send(loginRequest("msgid-0001", "alpha", "hunter2"));   // the request, at the RC4 seam as before
            const std::vector<uint8_t> frame = rtFrame(0x0A, loginResponse("msgid-0001", 0, 0x08, 198));
            t.Equals(frame.size(), size_t(201), "3 + 198");
            w.recv(frame, 0, 120);
            t.IsTrue(f.rec.commits() == 0 && f.rec.pending().has_value(), "the first chunk: nothing yet");
            w.recv(frame, 120);
            t.Equals(f.rec.commits(), 1, "the second chunk completes the frame: committed");
            t.Equals(ledgerAt(f.ledger).size(), size_t(1), "one record beside the card");
            f.send(loginRequest("msgid-0002", "alpha", "hunter2"));
            const std::vector<uint8_t> again = rtFrame(0x0A, loginResponse("msgid-0002", 0, 0x08, 198));
            w.recv(again, 0, 2);   // inside the header
            w.recv(again, 2, 60);   // inside the body
            t.Equals(f.rec.commits(), 1, "not before its last byte");
            w.recv(again, 60);
            t.Equals(f.rec.commits(), 2, "split inside the header and the body: committed");
        });

        tc.Run("a refused status (-1003) delivered whole: dropped, no commit (RED first)", [](TestCase &t)
        {
            Fixture f;
            Wire w{f.rec};
            f.send(loginRequest("msgid-0001", "alpha", "wrong"));
            w.recv(rtFrame(0x0A, loginResponse("msgid-0001", -1003, 0x08, 198)));
            t.IsTrue(w.seen.size() == 1 && w.seen[0].kept, "the frame was handed on");
            t.IsFalse(f.rec.pending().has_value(), "answered: dropped");
            t.IsTrue(f.rec.commits() == 0 && !fs::exists(f.ledger), "no commit, no ledger");
        });

        tc.Run("an encrypted 0x8A frame (its 4-byte hash outside the length) is skipped and the stream stays in step (RED first)", [](TestCase &t)
        {
            Fixture f;
            Wire w{f.rec};
            f.send(loginRequest("msgid-0001", "alpha", "hunter2"));
            const std::size_t sent = f.rec.bufferedBytes();   // the request, put together at the RC4 seam
            const std::vector<uint8_t> body = loginResponse("msgid-0001", 0, 0x08, 198);   // bytes that WOULD parse
            const std::vector<uint8_t> hidden = rtFrame(0x8A, body);
            t.Equals(hidden.size(), size_t(3 + 4 + 198), "id, length, hash, body");
            w.recv(cat({hidden, rtFrame(0x9A, {})}));   // an encrypted frame with no body carries no hash
            t.IsTrue(f.rec.commits() == 0 && f.rec.bufferedBytes() == sent, "left to the RC4 seam: nothing reached the recorder");
            w.recv(rtFrame(0x0A, body));
            t.Equals(w.seen.size(), size_t(3), "three frames, cut where the server cuts them");
            t.Equals(f.rec.commits(), 1, "the plain frame after them is read");
        });

        tc.Run("a frame longer than the carry's cap (a plain SERVER_APP over 512) is dropped without a crash, in step (RED first)", [](TestCase &t)
        {
            Fixture f;
            Wire w{f.rec};
            f.send(loginRequest("msgid-0001", "alpha", "hunter2"));
            const std::vector<uint8_t> big = rtFrame(0x0A, loginResponse("msgid-0001", 0, 0x08, 600));
            w.recv(big, 0, 300);
            w.recv(big, 300);
            t.IsTrue(w.seen.size() == 1 && !w.seen[0].kept && f.rec.commits() == 0, "over 512: walked, never kept, never parsed");
            const std::vector<uint8_t> huge = rtFrame(0x0A, std::vector<uint8_t>(0xFFFF, 0x01u));
            for (std::size_t at = 0; at < huge.size(); at += 4096)
                w.recv(huge, at, at + 4096);
            t.IsTrue(w.seen.size() == 2 && w.carry.kept.capacity() <= socom2_rt::kAppMostBytes, "the longest length: the carry never grew past its cap");
            w.recv(rtFrame(0x0A, loginResponse("msgid-0001", 0, 0x08, 198)));
            t.Equals(f.rec.commits(), 1, "the frame after them is read");
        });
    });
}
