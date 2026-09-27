// Sprint 16 L1b (#73, R295): the persona ledger beside the card -- see launcher/personas.h and the L1 design note.
#include "launcher/personas.h"
#include "launcher/launcher_config.h"   // normalizeProfile: a ledger's leaf must be a profile name to be launched

#include "json_reader.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>

namespace launcher::personas
{
    namespace
    {
        namespace fs = std::filesystem;

        // Every byte outside printable ASCII as \u00XX, so the file is ASCII whatever the keyboard typed and the
        // shared reader gives each byte back (json_reader.h); the two escapes JSON requires as themselves.
        std::string quote(const std::string &s)
        {
            std::string out = "\"";
            for (const char c : s)
            {
                const unsigned char u = static_cast<unsigned char>(c);
                if (c == '"')
                    out += "\\\"";
                else if (c == '\\')
                    out += "\\\\";
                else if (u < 0x20 || u >= 0x7F)
                {
                    char esc[8];
                    std::snprintf(esc, sizeof(esc), "\\u%04x", static_cast<unsigned>(u));
                    out += esc;
                }
                else
                    out.push_back(c);
            }
            out.push_back('"');
            return out;
        }

        bool blank(const std::string &s)
        {
            return std::all_of(s.begin(), s.end(), [](char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n'; });
        }

        bool endsWith(const std::string &s, const std::string &tail)
        {
            return s.size() >= tail.size() && s.compare(s.size() - tail.size(), tail.size(), tail) == 0;
        }

        std::string leafOf(const std::string &path)
        {
            std::string file = fs::path(path).filename().string();
            const std::string suffix = kSuffix;
            return endsWith(file, suffix) ? file.substr(0, file.size() - suffix.size()) : file;
        }

        bool readWhole(const std::string &path, std::string &out)
        {
            std::ifstream in(fs::path(path), std::ios::binary);
            if (!in)
                return false;
            out.assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
            return !in.bad();
        }

        // A card's save folder holds a SaveGame* file.
        bool hasSaveGame(const fs::path &card)
        {
            std::error_code ec;
            for (fs::directory_iterator it(card / kSaveFolder, ec), end; !ec && it != end; it.increment(ec))
            {
                const std::string name = it->path().filename().string();
                if (name.rfind(kSaveGamePrefix, 0) == 0)
                    return true;
            }
            return false;
        }
    }

    std::string ledgerPathFor(const std::string &cardRoot)
    {
        std::string root = cardRoot;
        while (root.size() > 1 && (root.back() == '/' || root.back() == '\\'))
            root.pop_back();
        return root + kSuffix;
    }

    std::string toJson(const std::vector<Persona> &records)
    {
        std::string out = "[";
        for (size_t i = 0; i < records.size(); ++i)
        {
            const Persona &p = records[i];
            out += i == 0 ? "\n" : ",\n";
            out += "  {\"name\": " + quote(p.name) + ", \"server\": " + quote(p.server) +
                   ", \"lastLogin\": " + std::to_string(static_cast<long long>(p.lastLogin)) +
                   ", \"savedPassword\": " + (p.savedPassword ? "true" : "false") +
                   ", \"second\": " + (p.second ? "true" : "false") + "}";
        }
        out += records.empty() ? "]\n" : "\n]\n";
        return out;
    }

    bool fromJson(const std::string &json, std::vector<Persona> &out)
    {
        out.clear();
        if (blank(json))
            return true;   // a 0-byte ledger: no records yet, not a corrupt one
        std::vector<Persona> records;
        detail::JsonReader p(json);
        if (!p.take('['))
            return false;
        if (!p.take(']'))
        {
            for (;;)
            {
                if (!p.take('{'))
                    return false;
                Persona r;
                bool haveName = false, haveServer = false;
                if (!p.take('}'))
                {
                    for (;;)
                    {
                        std::string key;
                        if (!p.string(key) || !p.take(':'))
                            return false;
                        if (key == "name" || key == "server")
                        {
                            std::string v;
                            if (!p.string(v))
                                return false;
                            (key == "name" ? r.name : r.server) = v;
                            (key == "name" ? haveName : haveServer) = !v.empty();
                        }
                        else if (key == "lastLogin" || key == "savedPassword" || key == "second")
                        {
                            std::string raw;
                            if (!p.scalar(raw))
                                return false;
                            if (key == "lastLogin")
                                r.lastLogin = static_cast<std::time_t>(std::strtoll(raw.c_str(), nullptr, 10));
                            else
                                (key == "savedPassword" ? r.savedPassword : r.second) = raw == "true";
                        }
                        else if (!p.skipValue())
                            return false;
                        if (p.take(','))
                            continue;
                        if (!p.take('}'))
                            return false;
                        break;
                    }
                }
                if (!haveName || !haveServer)
                    return false;   // a record the launcher could not show or match: the whole ledger is suspect
                records.push_back(r);
                if (p.take(','))
                    continue;
                if (!p.take(']'))
                    return false;
                break;
            }
        }
        if (p.peek() != '\0')
            return false;   // anything after the array is not a ledger this writer wrote
        out = std::move(records);
        return true;
    }

    void upsert(std::vector<Persona> &records, const Persona &record)
    {
        for (Persona &r : records)
            if (r.name == record.name && r.server == record.server)
            {
                r = record;
                return;
            }
        records.push_back(record);
    }

    bool readLedger(const std::string &path, std::vector<Persona> &out, std::string &note)
    {
        out.clear();
        const std::string file = fs::path(path).filename().string();
        std::error_code ec;
        const std::uintmax_t size = fs::file_size(fs::path(path), ec);
        if (!ec && size > kLedgerMostBytes)
        {
            note = file + ": larger than 1 MiB, not a ledger this build wrote; skipped";
            return false;
        }
        std::string text;
        if (!readWhole(path, text))
        {
            note = file + ": cannot be read; skipped";
            return false;
        }
        if (!fromJson(text, out))
        {
            note = file + ": not a persona ledger (truncated, corrupt, or a record with no name or server); skipped";
            return false;
        }
        const std::string leaf = leafOf(path);
        for (Persona &r : out)
            r.card = leaf;
        return true;
    }

    std::string tempPathFor(const std::string &path)
    {
        return path + ".tmp";
    }

    bool writeTemp(const std::string &path, const std::string &json)
    {
        const std::string tmp = tempPathFor(path);
        {
            std::ofstream outFile(fs::path(tmp), std::ios::binary | std::ios::trunc);
            if (!outFile)
                return false;
            outFile.write(json.data(), static_cast<std::streamsize>(json.size()));
            outFile.flush();
            if (outFile.good())
                return true;
        }
        std::error_code ec;
        fs::remove(fs::path(tmp), ec);
        return false;
    }

    bool commitTemp(const std::string &path)
    {
        std::error_code ec;
        fs::rename(fs::path(tempPathFor(path)), fs::path(path), ec);   // replaces the ledger whole, or not at all
        if (!ec)
            return true;
        fs::remove(fs::path(tempPathFor(path)), ec);
        return false;
    }

    bool writeAtomic(const std::string &path, const std::string &json)
    {
        return writeTemp(path, json) && commitTemp(path);
    }

    Cards readCards(const std::string &cardsDir)
    {
        Cards cards;
        const fs::path dir(cardsDir);
        std::error_code ec;
        if (!fs::is_directory(dir, ec))
            return cards;
        std::vector<fs::path> ledgers, cardDirs;
        for (fs::directory_iterator it(dir, ec), end; !ec && it != end; it.increment(ec))
        {
            std::error_code kind;
            if (it->is_directory(kind))
                cardDirs.push_back(it->path());
            else if (endsWith(it->path().filename().string(), kSuffix))
                ledgers.push_back(it->path());
        }
        std::sort(ledgers.begin(), ledgers.end());
        std::sort(cardDirs.begin(), cardDirs.end());
        for (const fs::path &ledger : ledgers)
        {
            const std::string file = ledger.filename().string();
            const std::string leaf = leafOf(file);
            if (normalizeProfile(leaf) != leaf)
            {
                cards.notes.push_back(file + ": its card name is not a profile name; skipped");
                continue;
            }
            std::error_code kind;
            if (!fs::is_directory(dir / leaf, kind))
            {
                // Listed, a row would launch a card that is not there and drop a password it never held.
                cards.notes.push_back(file + ": its card, cards/" + leaf + "/, is gone; skipped");
                continue;
            }
            std::vector<Persona> records;
            std::string note;
            if (!readLedger(ledger.string(), records, note))
            {
                cards.notes.push_back(note);
                continue;
            }
            cards.rows.insert(cards.rows.end(), records.begin(), records.end());
        }
        for (const fs::path &card : cardDirs)
        {
            std::error_code exists;
            if (!fs::exists(dir / (card.filename().string() + kSuffix), exists) && hasSaveGame(card))
                cards.savesWithoutLedger = true;
        }
        std::stable_sort(cards.rows.begin(), cards.rows.end(),
                         [](const Persona &a, const Persona &b) { return a.lastLogin > b.lastLogin; });
        return cards;
    }

    const char *emptySentence(const Cards &cards)
    {
        if (!cards.rows.empty())
            return "";
        return cards.savesWithoutLedger ? kEmptyAgainSentence : kEmptySentence;
    }

    std::string displayName(const std::string &name)
    {
        std::string out;
        for (const char c : name)
        {
            const unsigned char u = static_cast<unsigned char>(c);
            out.push_back(u >= 0x20 && u < 0x7F ? c : '?');
        }
        return out;
    }

    std::string cardLeaf(const Config &c)
    {
        return normalizeProfile(c.profile) + (c.secondInstance ? "_b" : "");
    }

    bool counts(const Persona &row, const Config &c)
    {
        return row.server == effectiveServer(c);
    }

    std::size_t selectedRow(const std::vector<Persona> &rows, const Config &c)
    {
        const std::string leaf = cardLeaf(c);
        std::size_t first = rows.size();
        for (std::size_t i = 0; i < rows.size(); ++i)
        {
            if (rows[i].card != leaf || rows[i].name != c.loginName || c.loginName.empty())
                continue;
            if (counts(rows[i], c))
                return i;   // of two alike on one card (one name, two servers), the one the game is pointed at
            if (first == rows.size())
                first = i;
        }
        return first;
    }

    bool passwordShown(const std::vector<Persona> &rows, const Config &c)
    {
        const std::size_t at = selectedRow(rows, c);
        return at == rows.size() || !counts(rows[at], c) || !rows[at].savedPassword;
    }

    void pick(Config &c, const Persona &row)
    {
        const std::string suffix = "_b";
        const bool bLedger = row.card.size() > suffix.size() && row.card.compare(row.card.size() - suffix.size(), suffix.size(), suffix) == 0;
        if (row.second && bLedger)
        {
            c.profile = row.card.substr(0, row.card.size() - suffix.size());   // environmentFor appends _b itself
            c.secondInstance = true;
        }
        else
        {
            c.profile = row.card;
            c.secondInstance = false;
        }
        // Only a name the keyboard could have typed reaches the prefill: "xmf" + an accent would otherwise launch as
        // "xmf", a persona the ledger never held.
        c.loginName = normalizeLoginName(row.name) == row.name ? row.name : std::string();
        c.loginPassword.clear();
    }

    void pickNewPersona(Config &c)
    {
        c.loginName.clear();
        c.loginPassword.clear();
    }

    std::string ageCaption(std::time_t lastLogin, std::time_t now)
    {
        const long long days = now > lastLogin ? static_cast<long long>(now - lastLogin) / 86400 : 0;
        if (days == 0)
            return "last played today";
        return "last played " + std::to_string(days) + (days == 1 ? " day ago" : " days ago");
    }
    bool cardHoldsPassword(const std::vector<Persona> &rows, const Config &c)
    {
        const std::size_t at = selectedRow(rows, c);
        return at < rows.size() && counts(rows[at], c) && rows[at].savedPassword;
    }

    bool dropSavedPassword(Config &c, const std::vector<Persona> &rows)
    {
        if (c.loginPassword.empty() || !cardHoldsPassword(rows, c))
            return false;
        c.loginPassword.clear();
        return true;
    }

    std::string serverCaption(const std::string &address)
    {
        const ServerPreset *preset = findServerPresetByAddress(address);
        return preset != nullptr ? std::string(preset->label) : address;
    }
}
