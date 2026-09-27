// Sprint 16 L1b (#73, R295): the runtime's persona record -- which persona logged in, on which server, and whether
// the card holds its password -- written BESIDE the card for the launcher's ONLINE page (launcher/personas.h; the
// L1 design note, docs/superpowers/plans/2026-09-27-sprint-16-l1-profile-viewer-design.md, sections 1 and 3).
//
// The login request is plain only at the RC4 seam (socom2_crypto.cpp's rc4EncryptFn, before the cipher); its layout
// is the server's own (server/horizon-server/RT.Models/Lobby/MediusAccountLoginRequest.cs): class 0x01 (lobby), type
// 0x07 (AccountLogin), MessageID 21 bytes, SessionKey 17, Username 32 at payload offset 40, Password 32 at 72 -- 104
// bytes. The record is held PENDING with its MessageID and committed by the first type-0x08 response
// (MediusAccountLoginResponse.cs: MessageID, 3 pad bytes, StatusCode at 26) carrying that MessageID with StatusCode >= 0,
// which comes back plain after rc4DecryptFn; a refused login (a wrong password, a refused create) is dropped, so the
// ledger never holds a phantom row.
//
// Whether the seams carry whole messages is inferred (PS2X_SOCOM2_LOGIN_TRACE is the check), so the recorder
// reassembles AT the seams: a concatenation keyed on the RC4 state's guest address, a message opened by a call that
// finds the state's byte counter (word 0, zeroed by every rekey) at 0 -- which discards any half message pending on
// that state -- and continued by the calls after it.
//
// savedPassword, per login, from the request alone: no password keyboard opened since the last COMMITTED success,
// and a non-empty Password. The flag is cleared at a committed success, never at a request: under SAVE PASSWORD NO a
// refused CONNECT retried untyped opens no keyboard, and a per-request clear would record true for a card that holds
// nothing.
#pragma once
#include "launcher/personas.h"

#include <cstddef>
#include <cstdint>
#include <ctime>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace socom2_persona
{
    constexpr uint8_t kClassLobby = 0x01;
    constexpr uint8_t kTypeAccountLogin = 0x07;
    constexpr uint8_t kTypeAccountLoginResponse = 0x08;
    constexpr std::size_t kMessageIdOffset = 2;
    constexpr std::size_t kMessageIdBytes = 21;
    constexpr std::size_t kUsernameOffset = 40;
    constexpr std::size_t kPasswordOffset = 72;
    constexpr std::size_t kFieldBytes = 32;
    constexpr std::size_t kLoginRequestBytes = 104;
    constexpr std::size_t kStatusOffset = 26;
    constexpr std::size_t kLoginResponseMinBytes = 30;

    struct LoginRequest
    {
        std::string messageId;   // the 21 bytes as sent
        std::string username;    // the field's bytes up to its terminator, never normalised
        std::string password;
    };
    // A login request is class 0x01, type 0x07 and exactly 104 bytes; anything else is not one.
    bool parseLoginRequest(const uint8_t *data, std::size_t len, LoginRequest &out);

    struct LoginResponse
    {
        std::string messageId;
        int32_t status = -1;
    };
    // A login response is class 0x01, type 0x08 and at least 30 bytes (StatusCode little-endian at 26).
    bool parseLoginResponse(const uint8_t *data, std::size_t len, LoginResponse &out);

    // The design note's inference: the card holds the password when the login went out with none typed.
    inline bool savedPasswordFor(bool passwordKeyboardOpened, const std::string &password)
    {
        return !passwordKeyboardOpened && !password.empty();
    }

    struct Context
    {
        std::string ledgerPath;   // launcher::personas::ledgerPathFor(the card root)
        std::string server;       // PS2X_SOCOM2_SERVER, the address the game is pointed at
        bool second = false;      // PS2X_SOCOM2_RSA_KEY selects key b: the second instance
    };

    class Recorder
    {
    public:
        explicit Recorder(Context context, std::function<std::time_t()> clock = [] { return std::time(nullptr); });

        // The OSK wrapper saw the login's password keyboard open (socom2_osk::Field::Password).
        void passwordKeyboardOpened() { m_keyboardOpened = true; }
        bool keyboardFlag() const { return m_keyboardOpened; }

        // A call at the RC4 seam: the state's guest address, its byte counter BEFORE the call, and the plain bytes
        // (before the cipher on the way out, after it on the way in).
        void encrypt(uint32_t state, uint32_t counter, const uint8_t *data, std::size_t len);
        void decrypt(uint32_t state, uint32_t counter, const uint8_t *data, std::size_t len);

        struct Pending
        {
            std::string messageId;
            launcher::personas::Persona record;
        };
        const std::optional<Pending> &pending() const { return m_pending; }
        int commits() const { return m_commits; }

    private:
        void onRequest(const std::vector<uint8_t> &message);
        void onResponse(const std::vector<uint8_t> &message);
        void commit();

        Context m_context;
        std::function<std::time_t()> m_clock;
        bool m_keyboardOpened = false;
        std::map<uint32_t, std::vector<uint8_t>> m_out, m_in;   // a message being put together, per RC4 state
        std::optional<Pending> m_pending;
        int m_commits = 0;
    };

    // The runner's one recorder, made on first use from the knobs and the card root (PS2Runtime::getIoPaths); the
    // seams in socom2_crypto.cpp and the keyboard wrapper in game_overrides_socom2.cpp call these.
    void onRc4Encrypt(uint32_t state, uint32_t counter, const uint8_t *data, std::size_t len);
    void onRc4Decrypt(uint32_t state, uint32_t counter, const uint8_t *data, std::size_t len);
    void onPasswordKeyboardOpened();
}
