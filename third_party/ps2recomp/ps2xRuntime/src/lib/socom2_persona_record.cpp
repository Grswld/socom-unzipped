// Sprint 16 L1b (#73, R295): the runtime's persona record -- see socom2_persona_record.h and the L1 design note.
#include "socom2_persona_record.h"

#include "ps2_runtime.h"
#include "ps2x/knobs.h"

#include <cstring>
#include <iostream>
#include <memory>
#include <mutex>

namespace socom2_persona
{
    namespace
    {
        // A fixed-width field up to its terminator: the game writes C strings into the message.
        std::string field(const uint8_t *data, std::size_t offset, std::size_t width)
        {
            const char *p = reinterpret_cast<const char *>(data + offset);
            std::size_t n = 0;
            while (n < width && p[n] != '\0')
                ++n;
            return std::string(p, n);
        }

        // What a message being put together on one state can still become: false once its class and type say it is
        // not the one this direction listens for, or it has grown past what that message can be.
        bool stillWanted(const std::vector<uint8_t> &m, uint8_t type, std::size_t most)
        {
            if (m.size() >= 1 && m[0] != kClassLobby)
                return false;
            if (m.size() >= 2 && m[1] != type)
                return false;
            return m.size() <= most;
        }

        // Up to the ledger's own size limit: a response is longer than its 30 bytes (AccountID, the connect info),
        // and nothing past the StatusCode is read, so the cap only bounds the buffer.
        constexpr std::size_t kResponseMostBytes = 4096;

        // The seam's reassembly: a call at counter 0 opens a message on that state (a half one there is dropped);
        // a later call continues the message open on that state, if any. A first chunk whose class or type byte is
        // already not the one this direction listens for, or longer than that message can be, opens nothing: it is
        // judged in place, before any copy (every message of the session passes here).
        std::vector<uint8_t> *assemble(std::map<uint32_t, std::vector<uint8_t>> &open, uint32_t state, uint32_t counter,
                                       const uint8_t *data, std::size_t len, uint8_t type, std::size_t most)
        {
            auto it = open.find(state);
            if (counter == 0)
            {
                // Every rekey zeroes the counter (rc4Init), so this is a message's first chunk: whatever was being
                // put together on the state is a half message that will never finish.
                if (data[0] != kClassLobby || (len >= 2 && data[1] != type) || len > most)
                {
                    if (it != open.end())
                        open.erase(it);
                    return nullptr;
                }
                std::vector<uint8_t> &m = open[state];
                m.assign(data, data + len);
                return &m;
            }
            if (it == open.end())
                return nullptr;   // a continuation of a message this recorder never saw open
            it->second.insert(it->second.end(), data, data + len);
            return &it->second;
        }
    }

    bool parseLoginRequest(const uint8_t *data, std::size_t len, LoginRequest &out)
    {
        if (data == nullptr || len != kLoginRequestBytes || data[0] != kClassLobby || data[1] != kTypeAccountLogin)
            return false;
        out.messageId = field(data, kMessageIdOffset, kMessageIdBytes);
        out.username = field(data, kUsernameOffset, kFieldBytes);
        out.password = field(data, kPasswordOffset, kFieldBytes);
        return true;
    }

    bool parseLoginResponse(const uint8_t *data, std::size_t len, LoginResponse &out)
    {
        if (data == nullptr || len < kLoginResponseMinBytes || data[0] != kClassLobby || data[1] != kTypeAccountLoginResponse)
            return false;
        out.messageId = field(data, kMessageIdOffset, kMessageIdBytes);
        const uint8_t *s = data + kStatusOffset;
        out.status = static_cast<int32_t>(static_cast<uint32_t>(s[0]) | (static_cast<uint32_t>(s[1]) << 8) |
                                          (static_cast<uint32_t>(s[2]) << 16) | (static_cast<uint32_t>(s[3]) << 24));
        return true;
    }

    Recorder::Recorder(Context context, std::function<std::time_t()> clock)
        : m_context(std::move(context)), m_clock(std::move(clock))
    {
    }

    void Recorder::encrypt(uint32_t state, uint32_t counter, const uint8_t *data, std::size_t len)
    {
        if (data == nullptr || len == 0)
            return;
        std::vector<uint8_t> *m = assemble(m_out, state, counter, data, len, kTypeAccountLogin, kLoginRequestBytes);
        if (m == nullptr)
            return;
        m_buffered += len;
        if (!stillWanted(*m, kTypeAccountLogin, kLoginRequestBytes))
        {
            m_out.erase(state);
            return;
        }
        if (m->size() == kLoginRequestBytes)
        {
            const std::vector<uint8_t> whole = std::move(*m);
            m_out.erase(state);
            onRequest(whole);
        }
    }

    void Recorder::decrypt(uint32_t state, uint32_t counter, const uint8_t *data, std::size_t len)
    {
        if (data == nullptr || len == 0)
            return;
        std::vector<uint8_t> *m = assemble(m_in, state, counter, data, len, kTypeAccountLoginResponse, kResponseMostBytes);
        if (m == nullptr)
            return;
        m_buffered += len;
        if (!stillWanted(*m, kTypeAccountLoginResponse, kResponseMostBytes))
        {
            m_in.erase(state);
            return;
        }
        if (m->size() >= kLoginResponseMinBytes)
        {
            const std::vector<uint8_t> whole = std::move(*m);
            m_in.erase(state);
            onResponse(whole);
        }
    }

    void Recorder::onRequest(const std::vector<uint8_t> &message)
    {
        LoginRequest req;
        if (!parseLoginRequest(message.data(), message.size(), req))
            return;
        Pending p;
        p.messageId = req.messageId;
        p.record.name = req.username;
        p.record.server = m_context.server;
        p.record.second = m_context.second;
        // No observer, no inference: with the keyboard unwatched a typed login looks untyped, and true would drop
        // a plain password the card does not hold.
        p.record.savedPassword = m_observerLive && savedPasswordFor(m_keyboardOpened, req.password);
        m_pending = p;   // a retry replaces the one before it: the newest request is the one the server answers
    }

    void Recorder::onResponse(const std::vector<uint8_t> &message)
    {
        LoginResponse res;
        if (!parseLoginResponse(message.data(), message.size(), res) || !m_pending || res.messageId != m_pending->messageId)
            return;   // not ours: the pending record waits for its own answer
        if (res.status >= 0)
            commit();
        m_pending.reset();   // answered: committed, or refused and dropped (the keyboard flag survives a refusal)
    }

    void Recorder::commit()
    {
        launcher::personas::Persona record = m_pending->record;
        record.lastLogin = m_clock();
        std::vector<launcher::personas::Persona> records;
        std::string note;
        if (!launcher::personas::readLedger(m_context.ledgerPath, records, note) && !note.empty())
            records.clear();   // missing or unreadable: this record starts it again (the launcher skipped the old one)
        launcher::personas::upsert(records, record);
        if (launcher::personas::writeAtomic(m_context.ledgerPath, launcher::personas::toJson(records)))
            ++m_commits;
        else
            std::cout << "[socom2] persona record: could not write " << m_context.ledgerPath << std::endl;
        m_keyboardOpened = false;   // cleared at a committed success, never at a request
    }

    namespace
    {
        std::mutex g_mutex;
        std::unique_ptr<Recorder> g_recorder;
        int g_wrapped = 0, g_entries = 0;   // the wrap site's count, kept for a recorder made after it reports

        Recorder &recorder()
        {
            std::unique_ptr<Recorder> &r = g_recorder;
            if (!r)
            {
                Context c;
                c.ledgerPath = launcher::personas::ledgerPathFor(PS2Runtime::getIoPaths().mcRoot.string());
                const char *server = ps2x::knob("PS2X_SOCOM2_SERVER");
                c.server = server != nullptr && *server != '\0' ? server : "127.0.0.1";
                const char *key = ps2x::knob("PS2X_SOCOM2_RSA_KEY");   // the same test socom2_RsaGenerateKeyPair makes
                c.second = key != nullptr && (*key == 'b' || *key == 'B' || *key == '1');
                r = std::make_unique<Recorder>(c);
                r->keyboardObserverWraps(g_wrapped, g_entries);
            }
            return *r;
        }
    }

    void onRc4Encrypt(uint32_t state, uint32_t counter, const uint8_t *data, std::size_t len)
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        recorder().encrypt(state, counter, data, len);
    }

    void onRc4Decrypt(uint32_t state, uint32_t counter, const uint8_t *data, std::size_t len)
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        const int before = recorder().commits();
        recorder().decrypt(state, counter, data, len);
        if (recorder().commits() != before)
            std::cout << "[socom2] persona record: a login committed to " << PS2Runtime::getIoPaths().mcRoot.filename().string()
                      << "'s ledger" << std::endl;   // never the name or the password
    }

    void onKeyboardObserverWraps(int wrapped, int entries)
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        g_wrapped = wrapped;
        g_entries = entries;
        if (g_recorder)   // never made here: the card root may not be known yet at install time
            g_recorder->keyboardObserverWraps(wrapped, entries);
    }

    void onPasswordKeyboardOpened()
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        recorder().passwordKeyboardOpened();
    }
}
