#pragma once
// The memory card's SOCOM II save file, read and written -- the persona creator's store (the persona-card plan,
// docs/superpowers/plans/2026-09-28-persona-card-creator.md, section 1; the Python reference is tools_py/card_save.py).
//
// cards/<profile>/BASCUS-97275SOCOMII/BASCUS-97275SOCOMII is a ZAR version-2 archive passed through a fixed-seed byte
// scrambler (the game's sub_0033DC30 encodes, FUN_0033de00 decodes; seed 0x96, no key). Its key CAcctDB/AcctInfo.rdr
// is a serialised rdr tree holding one 16-node record per persona: HOST, NAME, TOWN, GENDER, PORT, PASSWORD (plain,
// the game's own storage), SAVEPASSWORD, PROFILES. Plain C++20, no I/O: the caller reads and writes the file.
#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace launcher::card
{
    // Section 1 item 1. unscramble(scramble(x)) == x and scramble(unscramble(x)) == x for every x.
    std::vector<uint8_t> unscramble(const std::vector<uint8_t> &file);
    std::vector<uint8_t> scramble(const std::vector<uint8_t> &plain);

    // Section 1 item 2: one key of the archive; `data` is the key's bytes (empty for a directory-like key).
    struct ZarKey
    {
        std::string name;
        std::vector<uint8_t> data;
        std::vector<ZarKey> children;
        bool operator==(const ZarKey &) const = default;
    };

    constexpr int32_t kZarVersion2 = 0x20002;

    // Version 2 and flags 0 only (the only form the game writes to a card); false and `why` otherwise.
    bool parseZar(const std::vector<uint8_t> &plain, ZarKey &root, std::string &why);
    // appversion 14, padding 16, crc 0, flags 0, stable_ofs 0 (so a name_ofs is the plain string-table offset; the
    // table starts with an empty string so the root's name_ofs 0 reads as unnamed). Data aligned to 16 as the game
    // lays it. Not byte-identical to the game's file (its stable_ofs is a guest address), re-parses to the same tree.
    std::vector<uint8_t> buildZar(const ZarKey &root);

    // Section 1 item 3: one record of AcctInfo.rdr.
    struct Persona
    {
        std::string host;       // the address the game connected to, resolved (dotted IPv4)
        std::string name;
        std::string town;
        std::string password;   // plain, as the game stores it
        int gender = 0;
        int port = 10075;
        bool savePassword = true;
        std::array<int32_t, 16> checksum{};   // PROFILES' PROFILE_CHECKSUM list
        bool operator==(const Persona &) const = default;
    };

    // Every record of an AcctInfo.rdr blob, in order. A virgin card's blob (an empty list) gives none and true.
    bool readPersonas(const std::vector<uint8_t> &acctInfo, std::vector<Persona> &out, std::string &why);
    // The blob for `personas`: flags 0 on every node (no sharing), strings interned once, nodes laid out as the game
    // lays them (a list's children contiguous, allocated when the list is reached depth-first). PROFILE_INFO is
    // written as an empty list, as every example card holds it.
    std::vector<uint8_t> writePersonas(const std::vector<Persona> &personas);

    // The whole file: decode, find CAcctDB -> AcctInfo.rdr, read it.
    bool readCardFile(const std::vector<uint8_t> &file, std::vector<Persona> &out, std::string &why);
    // Decode `fileOrEmpty` (empty = the embedded virgin template, src/card_template.h), replace AcctInfo.rdr with
    // writePersonas(personas), rebuild and encode. Every other key's bytes are kept. Empty result = the input was not
    // a card file this reader understands (parseZar failed, or it has no CAcctDB/AcctInfo.rdr key).
    std::vector<uint8_t> writeCardFile(const std::vector<uint8_t> &fileOrEmpty, const std::vector<Persona> &personas);
}
