#pragma once
// Sprint 16 L1b (#73, R295): the personas a card has logged in with, as the runtime records them BESIDE the card --
// cards/<profile>.personas.json, a sibling of the card directory the game lists, never inside it (the L1 design
// note, docs/superpowers/plans/2026-09-27-sprint-16-l1-profile-viewer-design.md, section 1). The runtime writes a
// record when a login succeeds (ps2xRuntime/src/lib/socom2_persona_record.cpp); the launcher's ONLINE page reads
// every ledger under cards/ and lists the records. Both ends share this one reader and writer (ps2x_shared: the
// runner never links the launcher), so what one writes the other reads (the accept-set lesson, docs/HAZARDS.md).
//
// Names are BYTES: the request's Username is what the game's keyboard typed, accent mode included, so a record can
// hold a byte normalizeLoginName would drop. The ledger writes every byte outside printable ASCII as \u00XX and the
// shared JSON reader gives the byte back (json_reader.h), so a name round-trips byte for byte.
//
// The persona-card plan (docs/superpowers/plans/2026-09-28-persona-card-creator.md, R-A/R-B/R-C): the CARD is the
// persona store. readCards lists the records of each card's own save file (launcher/card_save.h), in the card's
// order; the ledger beside it only adds `lastLogin`. createPersona writes a new record into the card as the game
// writes one, and pick puts the picked record first so the game's login form arrives with it.
#include <cstddef>
#include <cstdint>
#include <ctime>
#include <string>
#include <vector>

namespace launcher
{
    struct Config;
}

namespace launcher::personas
{
    struct Persona
    {
        std::string name;     // the login request's Username, byte for byte
        std::string card;     // the card's leaf -- "player", "player_b" -- set by the reader from the file name, never stored
        // In a ledger: the address the game was pointed at (launcher::effectiveServer at launch). In a readCards row:
        // the card record's HOST, the address the game connected to, resolved (a dotted IPv4).
        std::string server;
        std::time_t lastLogin = 0;   // when the login succeeded (seconds since the epoch); 0 in a row no ledger dates
        bool savedPassword = false;  // the card holds the password (a row: SAVEPASSWORD 1 and a PASSWORD on the card)
        bool second = false;         // the second instance's card: a ledger's own field; a row's is its card's _b suffix
        bool operator==(const Persona &) const = default;
    };

    constexpr const char *kSuffix = ".personas.json";
    // The game's save folder on a card (docs/HAZARDS.md), and the prefix of its saved-game files.
    constexpr const char *kSaveFolder = "BASCUS-97275SOCOMII";
    constexpr const char *kSaveGamePrefix = "SaveGame";

    // The ledger beside a card root: the root with any trailing separator stripped (cards/player/ would otherwise put
    // the ledger INSIDE the card, where the game lists it), then kSuffix. "cards/player/" -> "cards/player.personas.json".
    std::string ledgerPathFor(const std::string &cardRoot);

    // A ledger's text: a JSON array of {name, server, lastLogin, savedPassword, second}. fromJson refuses the whole
    // text (false, `out` empty) when it is not an array of objects or a record has no name or no server -- a
    // structurally corrupt ledger is skipped whole, never half read. An empty text (0 bytes, blanks) is no records.
    std::string toJson(const std::vector<Persona> &records);
    bool fromJson(const std::string &json, std::vector<Persona> &out);

    // One record per (name, server): a login already recorded updates its record, a new pair is appended.
    void upsert(std::vector<Persona> &records, const Persona &record);

    // Reads one ledger; each record's `card` is the file's leaf (its name less kSuffix). False, with `note` one line
    // naming the file, when the file cannot be read or is corrupt; a missing file is false too. A file over
    // kLedgerMostBytes is refused unread (a few hundred bytes a record: no real ledger comes near it).
    constexpr std::uintmax_t kLedgerMostBytes = 1024u * 1024u;
    bool readLedger(const std::string &path, std::vector<Persona> &out, std::string &note);

    // The atomic write: the whole text to `<path>.tmp`, then renamed over the ledger, so a reader never sees half a
    // ledger. writeAtomic is writeTemp then commitTemp; the halves are public so a test can look between them.
    std::string tempPathFor(const std::string &path);
    bool writeTemp(const std::string &path, const std::string &json);
    bool commitTemp(const std::string &path);
    bool writeAtomic(const std::string &path, const std::string &json);
    // The same two halves for a card file's bytes (the temp file beside it, then the rename over it).
    bool writeTempBytes(const std::string &path, const std::vector<uint8_t> &bytes);
    bool writeAtomicBytes(const std::string &path, const std::vector<uint8_t> &bytes);

    // ---- the card's own persona file (the persona-card plan) -------------------------------------------------------
    // cards/<leaf>/BASCUS-97275SOCOMII/BASCUS-97275SOCOMII under `cardsDir`. A file over kCardMostBytes is refused
    // unread (the game's is a few KiB).
    constexpr std::uintmax_t kCardMostBytes = 1024u * 1024u;
    std::string cardFilePath(const std::string &cardsDir, const std::string &leaf);

    // The IPv4 an address resolves to, as the game's HOST holds it: a dotted quad as is, a name through getaddrinfo
    // (AF_INET), a ":port" suffix ignored; "" when it does not resolve. An answer is kept for the process (a cache),
    // so counts() stays cheap on the frame path; a FAILURE is kept only kResolveRetrySeconds (the review, finding 6: a
    // launcher opened offline must not read every row as another server's until it is restarted) -- the next need
    // after that asks again. The lookup runs on the caller's thread, the UI's included: at most once per host per
    // interval while it fails. serverPort is the suffix's port, else 10075.
    constexpr int kResolveRetrySeconds = 30;
    std::string resolveIPv4(const std::string &address);
    int serverPort(const std::string &address);
    // resolveIPv4(effectiveServer(c)).
    std::string resolvedServer(const Config &c);
    // The address the card's HOST holds for the server `c` points at -- what the game connects to after MUIS: a
    // Custom server's Config::serverEndpoint when one is set (resolved like any address), else resolvedServer(c).
    // The review, finding 1: a self-hosted server at 127.0.0.1 whose MUIS Endpoint is its LAN address.
    std::string cardHost(const Config &c);
    // The tests' seam: a resolver in place of getaddrinfo (nullptr restores it); either way the cache is cleared.
    using Resolver = std::string (*)(const std::string &host);
    void setResolverForTests(Resolver resolver);
    // The retry interval's clock, in seconds (nullptr restores the steady clock).
    using Clock = std::int64_t (*)();
    void setClockForTests(Clock clock);

    // NEW PERSONA's CREATE ON CARD: the name and password as the game's keyboards could type them (empty after that
    // -> false), HOST cardHost(c), asked afresh -- a player's press, not a frame, so a remembered failure is not the
    // answer (unresolvable -> false), PORT 10075 or the effectiveServer address's own; the
    // card cardLeaf(c) under <home>/cards/ read (unreadable -> false, the file untouched) or started from the virgin
    // template; the record upserted by (HOST, NAME) with SAVEPASSWORD 1 and put FIRST; the directories made and the
    // file written atomically. `note` is one line: the path written, or why nothing was.
    bool createPersona(const std::string &home, const Config &c, const std::string &name, const std::string &password,
                       std::string &note);
    // R-C: the row's record (by NAME and HOST) moved first on its card, the file rewritten only when it was not first
    // already. False with `note` when the card cannot be read or written or no longer holds the record.
    bool moveFirst(const std::string &cardsDir, const Persona &row, std::string &note);
    // The review, finding 4: a pick made while the game runs switches the config at once, but the game holds the
    // card and saves over it, so the reorder is HELD, not dropped (the last pick wins) and applyPendingFirst makes it
    // at the next LAUNCH, before the game starts -- moveFirst, the pick's own path. A held row that is no longer the
    // selection (c.loginName or cardLeaf(c) is not the row's: another row, NEW PERSONA) is let go unapplied: true,
    // the card untouched.
    struct PendingFirst
    {
        bool held = false;
        Persona row;
    };
    void holdFirst(PendingFirst &pending, const Persona &row);
    // True when nothing was held, the held row was stale, or moveFirst succeeded; false with moveFirst's `note`.
    // `pending` is empty afterwards either way.
    bool applyPendingFirst(PendingFirst &pending, const Config &c, const std::string &cardsDir, std::string &note);

    // Every record of every card under cardsDir whose leaf is a profile name (cards/<leaf>/BASCUS-97275SOCOMII/
    // BASCUS-97275SOCOMII), cards in name order and each card's records in the card's own order (the game's list).
    // The ledger beside a card (<leaf>.personas.json) supplies lastLogin to the record with its name whose HOST is the
    // ledger record's server or what that server resolves to. A card this build cannot read, a corrupt ledger, a
    // ledger with no card and a ledger record with no card record are one line each in `notes`; nothing throws.
    struct Cards
    {
        std::vector<Persona> rows;
        std::vector<std::string> notes;
    };
    Cards readCards(const std::string &cardsDir);

    // The empty viewer's one sentence ("" when there are rows).
    constexpr const char *kEmptySentence =
        "No persona yet -- pick NEW PERSONA, type a name and a password, and CREATE ON CARD writes it to your memory card.";
    const char *emptySentence(const Cards &cards);

    // What a row can draw of a name: printable ASCII as is, any other byte as '?' (the launcher's glyph set).
    std::string displayName(const std::string &name);

    // ---- the ONLINE page's selection (the design note, section 2) -------------------------------------------------
    // The card a Config launches: normalizeProfile(profile), plus "_b" for the second instance -- what a row's `card`
    // is compared with.
    std::string cardLeaf(const Config &c);
    // A record counts -- for the password field and for the saved-password rule -- only on the server the game is
    // pointed at: on another server the game runs a create-persona login and opens its keyboard empty.
    bool counts(const Persona &row, const Config &c);
    // The selected row: the record whose card is cardLeaf(c) and whose name is c.loginName byte for byte (of two
    // alike, the one that counts, else the first); rows.size() -- NEW PERSONA -- when none matches.
    std::size_t selectedRow(const std::vector<Persona> &rows, const Config &c);
    // The masked PASSWORD field shows for NEW PERSONA, a record that does not count, and one whose card does not hold
    // the password.
    bool passwordShown(const std::vector<Persona> &rows, const Config &c);
    // Picking a row: the card (a `second` record in a <p>_b ledger sets <p> and the second instance, since
    // environmentFor appends _b itself), the name when normalizeLoginName leaves it as it is and EMPTY otherwise, and
    // the typed password cleared -- one loginPassword serves every row, and B picked after A must not send A's.
    void pick(Config &c, const Persona &row);
    // The pick a player makes (R-C): pick(c, row), then moveFirst(cardsDir, row, note) -- its answer is this one's.
    bool pick(Config &c, const Persona &row, const std::string &cardsDir, std::string &note);
    // NEW PERSONA: the name and the password cleared, the card kept; the game asks for a name on its own keyboard.
    void pickNewPersona(Config &c);
    // The config write rule (the design note, section 3): the selected row's record counts and says the card holds
    // the password -- config.json then keeps the key empty and no PS2X_SOCOM2_LOGIN_PASS is sent
    // (launcher::toJson / environmentFor with the rows). dropSavedPassword is the migration at a ledger read: it
    // clears Config::loginPassword under that rule and answers whether it did (the caller rewrites the file).
    bool cardHoldsPassword(const std::vector<Persona> &rows, const Config &c);
    bool dropSavedPassword(Config &c, const std::vector<Persona> &rows);
    // A record's server as a row shows it: the label of the preset with that address, else the address.
    std::string serverCaption(const std::string &address);
    // "last played today", "last played 1 day ago", "last played <n> days ago".
    std::string ageCaption(std::time_t lastLogin, std::time_t now);
}
