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
#include <cstddef>
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
        std::string card;     // the ledger's leaf -- "player", "player_b" -- set by readLedger from the file name, never stored
        std::string server;   // the address the game was pointed at (launcher::effectiveServer at launch)
        std::time_t lastLogin = 0;   // when the login succeeded (seconds since the epoch)
        bool savedPassword = false;  // the card holds the password: the login went out with no password keyboard opened
        bool second = false;         // made by the second instance (PS2X_SOCOM2_RSA_KEY=b), never read off a _b suffix
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
    // naming the file, when the file cannot be read or is corrupt; a missing file is false too.
    bool readLedger(const std::string &path, std::vector<Persona> &out, std::string &note);

    // The atomic write: the whole text to `<path>.tmp`, then renamed over the ledger, so a reader never sees half a
    // ledger. writeAtomic is writeTemp then commitTemp; the halves are public so a test can look between them.
    std::string tempPathFor(const std::string &path);
    bool writeTemp(const std::string &path, const std::string &json);
    bool commitTemp(const std::string &path);
    bool writeAtomic(const std::string &path, const std::string &json);

    // Every record across every cards/*.personas.json whose card directory exists, newest login first (ties keep
    // the ledgers' name order, then the file's). A ledger with no card, a corrupt one, or one whose leaf is not a
    // profile name is skipped with one line in `notes` and never throws.
    struct Cards
    {
        std::vector<Persona> rows;
        std::vector<std::string> notes;
        // A card with a SaveGame* file in its save folder and no ledger: a card from before this build, whose
        // personas appear only after their next login (the "again" sentence). An inference from one card (W10).
        bool savesWithoutLedger = false;
    };
    Cards readCards(const std::string &cardsDir);

    // The empty viewer's one sentence ("" when there are rows).
    constexpr const char *kEmptySentence =
        "No persona yet -- press LAUNCH, the game asks for a name on its own keyboard, and it appears here after your first login.";
    constexpr const char *kEmptyAgainSentence =
        "No persona listed yet -- press LAUNCH and log in again; each persona on your card appears here after that login.";
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
