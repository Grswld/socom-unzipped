// Sprint 16 L1b (#73, R295): the persona ledger beside the card -- see launcher/personas.h and the L1 design note.
#include "launcher/personas.h"
#include "launcher/launcher_config.h"   // normalizeProfile: a ledger's leaf must be a profile name to be launched
#include "launcher/card_save.h"         // the persona-card plan: the card's own persona file

#include "json_reader.h"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <map>
#include <mutex>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <netdb.h>
#include <sys/socket.h>
#endif

namespace launcher::personas
{
    namespace cs = launcher::card;

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

        bool readBytes(const fs::path &path, std::vector<uint8_t> &out)
        {
            std::ifstream in(path, std::ios::binary);
            if (!in)
                return false;
            out.assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
            return !in.bad();
        }

        // A card file's bytes, refused over kCardMostBytes; false with `note` naming the file relative to cards/.
        bool readCardBytes(const fs::path &file, const std::string &shown, std::vector<uint8_t> &out, std::string &note)
        {
            std::error_code ec;
            const std::uintmax_t size = fs::file_size(file, ec);
            if (!ec && size > kCardMostBytes)
            {
                note = shown + ": larger than 1 MiB, not a card file the game wrote; skipped";
                return false;
            }
            if (!readBytes(file, out))
            {
                note = shown + ": cannot be read; skipped";
                return false;
            }
            return true;
        }

        // "a.b.c.d" with four decimal parts of 0-255: the form HOST holds and a resolver hands back as is.
        bool dottedQuad(const std::string &s)
        {
            int parts = 0, digits = 0, value = 0;
            for (const char ch : s)
            {
                if (ch >= '0' && ch <= '9')
                {
                    value = value * 10 + (ch - '0');
                    if (++digits > 3 || value > 255)
                        return false;
                }
                else if (ch == '.' && digits > 0)
                {
                    ++parts;
                    digits = value = 0;
                }
                else
                    return false;
            }
            return parts == 3 && digits > 0;
        }

        // The host part of "host[:port]" (an address with more than one ':' is not an IPv4 one and is kept whole).
        std::string hostOf(const std::string &address)
        {
            const std::size_t colon = address.find(':');
            if (colon == std::string::npos || address.find(':', colon + 1) != std::string::npos)
                return address;
            return address.substr(0, colon);
        }

        std::string systemResolve(const std::string &host)
        {
#ifdef _WIN32
            static const bool wsaUp = [] {
                WSADATA wsa;
                return WSAStartup(MAKEWORD(2, 2), &wsa) == 0;   // once per process; getaddrinfo needs Winsock up
            }();
            if (!wsaUp)
                return std::string();
#endif
            addrinfo hints{};
            hints.ai_family = AF_INET;
            hints.ai_socktype = SOCK_STREAM;
            addrinfo *res = nullptr;
            if (getaddrinfo(host.c_str(), nullptr, &hints, &res) != 0 || res == nullptr)
                return std::string();
            std::string out;
            for (addrinfo *a = res; a != nullptr && out.empty(); a = a->ai_next)
            {
                if (a->ai_family != AF_INET || a->ai_addr == nullptr)
                    continue;
                const auto *in = reinterpret_cast<const sockaddr_in *>(a->ai_addr);
                const uint32_t ip = ntohl(in->sin_addr.s_addr);
                out = std::to_string((ip >> 24) & 0xFF) + "." + std::to_string((ip >> 16) & 0xFF) + "." +
                      std::to_string((ip >> 8) & 0xFF) + "." + std::to_string(ip & 0xFF);
            }
            freeaddrinfo(res);
            return out;
        }

        std::mutex g_resolveLock;
        Resolver g_resolver = nullptr;
        Clock g_clock = nullptr;
        std::map<std::string, std::string> g_resolved;    // host -> dotted address; only answers are kept for good
        std::map<std::string, std::int64_t> g_failedAt;   // host -> when it last failed to resolve (seconds)

        std::int64_t nowSeconds()
        {
            if (g_clock != nullptr)
                return g_clock();
            return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
        }

        // resolveIPv4's lookup. `fresh` (a player's CREATE) asks even inside a failure's retry interval.
        std::string lookupIPv4(const std::string &address, bool fresh)
        {
            const std::string host = hostOf(address);
            if (host.empty())
                return std::string();
            if (dottedQuad(host))
                return host;
            std::lock_guard<std::mutex> hold(g_resolveLock);
            const auto known = g_resolved.find(host);
            if (known != g_resolved.end())
                return known->second;
            const std::int64_t now = nowSeconds();
            const auto failed = g_failedAt.find(host);
            if (!fresh && failed != g_failedAt.end() && now - failed->second < kResolveRetrySeconds)
                return std::string();   // failed a moment ago: the frame path does not ask every frame
            std::string ip = g_resolver != nullptr ? g_resolver(host) : systemResolve(host);
            if (!dottedQuad(ip))
            {
                g_failedAt[host] = now;   // remembered for the retry interval only, never for the process
                return std::string();
            }
            g_failedAt.erase(host);
            g_resolved[host] = ip;
            return ip;
        }

        // cardHost's address: the Custom server's MUIS Endpoint when one is set, else the server itself.
        std::string cardHostAddress(const Config &c)
        {
            if (c.serverPreset == "custom" && !c.serverEndpoint.empty())   // a preset's Endpoint is its address
                return c.serverEndpoint;
            return effectiveServer(c);
        }

        // A card's records, or false with `note` (the card is then neither listed nor rewritten).
        bool readCardRecords(const fs::path &file, const std::string &shown, std::vector<cs::Persona> &out, std::string &note)
        {
            std::vector<uint8_t> bytes;
            if (!readCardBytes(file, shown, bytes, note))
                return false;
            std::string why;
            if (!cs::readCardFile(bytes, out, why))
            {
                note = shown + ": not a card file this build reads (" + why + "); skipped";
                return false;
            }
            return true;
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

    bool writeTempBytes(const std::string &path, const std::vector<uint8_t> &bytes)
    {
        return writeTemp(path, std::string(bytes.begin(), bytes.end()));
    }

    bool writeAtomicBytes(const std::string &path, const std::vector<uint8_t> &bytes)
    {
        return writeTempBytes(path, bytes) && commitTemp(path);
    }

    std::string cardFilePath(const std::string &cardsDir, const std::string &leaf)
    {
        return (fs::path(cardsDir) / leaf / kSaveFolder / kSaveFolder).string();
    }

    std::string resolveIPv4(const std::string &address)
    {
        return lookupIPv4(address, false);
    }

    int serverPort(const std::string &address)
    {
        const std::string host = hostOf(address);
        if (host.size() == address.size() || host.size() + 1 >= address.size())
            return 10075;
        int port = 0;
        for (std::size_t i = host.size() + 1; i < address.size(); ++i)
        {
            if (address[i] < '0' || address[i] > '9')
                return 10075;
            port = port * 10 + (address[i] - '0');
            if (port > 65535)
                return 10075;
        }
        return port == 0 ? 10075 : port;
    }

    std::string resolvedServer(const Config &c)
    {
        return resolveIPv4(effectiveServer(c));
    }

    std::string cardHost(const Config &c)
    {
        return resolveIPv4(cardHostAddress(c));
    }

    void setResolverForTests(Resolver resolver)
    {
        std::lock_guard<std::mutex> hold(g_resolveLock);
        g_resolver = resolver;
        g_resolved.clear();
        g_failedAt.clear();
    }

    void setClockForTests(Clock clock)
    {
        std::lock_guard<std::mutex> hold(g_resolveLock);
        g_clock = clock;
    }

    bool createPersona(const std::string &home, const Config &c, const std::string &name, const std::string &password,
                       std::string &note)
    {
        const std::string n = normalizeLoginName(name);
        const std::string pw = normalizeLoginPassword(password);
        if (n.empty())
        {
            note = "no name: type the persona's name (the game's keyboard has no space)";
            return false;
        }
        if (pw.empty())
        {
            note = "no password: type the persona's password";
            return false;
        }
        const std::string server = effectiveServer(c);
        // HOST is what the game connects to after MUIS (cardHost): a Custom server's Endpoint when one is set. Asked
        // afresh -- a press, not a frame -- so a failure remembered from an offline start does not refuse it.
        const std::string hostAddress = cardHostAddress(c);
        const std::string host = lookupIPv4(hostAddress, true);
        if (host.empty())
        {
            note = "the server " + hostAddress + " does not resolve to an address; nothing written";
            return false;
        }
        const std::string cardsDir = (fs::path(home) / "cards").string();
        const std::string leaf = cardLeaf(c);
        const fs::path file(cardFilePath(cardsDir, leaf));
        const std::string shown = "cards/" + leaf + "/" + kSaveFolder + "/" + kSaveFolder;
        std::vector<uint8_t> bytes;
        std::vector<cs::Persona> records;
        std::error_code ec;
        if (fs::exists(file, ec))
        {
            if (!readCardBytes(file, shown, bytes, note))
                return false;
            std::string why;
            if (!cs::readCardFile(bytes, records, why))
            {
                note = shown + ": not a card file this build reads (" + why + "); nothing written";
                return false;
            }
        }
        cs::Persona record;
        record.host = host;
        record.name = n;
        record.password = pw;
        record.port = serverPort(server);
        record.savePassword = true;
        for (auto it = records.begin(); it != records.end(); ++it)
            if (it->host == host && it->name == n)
            {
                // The same persona again: its password and port are the new ones; what the game keeps of its own
                // (TOWN, GENDER, the profile checksum) stays as the card holds it.
                record.town = it->town;
                record.gender = it->gender;
                record.checksum = it->checksum;
                records.erase(it);
                break;
            }
        records.insert(records.begin(), record);
        const std::vector<uint8_t> out = cs::writeCardFile(bytes, records);
        if (out.empty())
        {
            note = shown + ": the card file could not be rebuilt; nothing written";
            return false;
        }
        fs::create_directories(file.parent_path(), ec);
        if (!writeAtomicBytes(file.string(), out))
        {
            note = shown + ": cannot be written";
            return false;
        }
        note = "wrote " + n + " to " + fs::path(file).make_preferred().string();
        return true;
    }

    bool moveFirst(const std::string &cardsDir, const Persona &row, std::string &note)
    {
        const fs::path file(cardFilePath(cardsDir, row.card));
        const std::string shown = "cards/" + row.card + "/" + kSaveFolder + "/" + kSaveFolder;
        std::vector<uint8_t> bytes;
        std::vector<cs::Persona> records;
        if (!readCardBytes(file, shown, bytes, note))
            return false;
        std::string why;
        if (!cs::readCardFile(bytes, records, why))
        {
            note = shown + ": not a card file this build reads (" + why + ")";
            return false;
        }
        for (std::size_t i = 0; i < records.size(); ++i)
        {
            if (records[i].name != row.name || records[i].host != row.server)
                continue;
            if (i == 0)
                return true;   // first already: the file is left as it is
            std::rotate(records.begin(), records.begin() + static_cast<std::ptrdiff_t>(i),
                        records.begin() + static_cast<std::ptrdiff_t>(i) + 1);
            const std::vector<uint8_t> out = cs::writeCardFile(bytes, records);
            if (out.empty() || !writeAtomicBytes(file.string(), out))
            {
                note = shown + ": cannot be rewritten with " + displayName(row.name) + " first";
                return false;
            }
            return true;
        }
        note = shown + ": no longer holds " + displayName(row.name);
        return false;
    }

    void holdFirst(PendingFirst &pending, const Persona &row)
    {
        pending.held = true;
        pending.row = row;   // the last pick wins
    }

    bool applyPendingFirst(PendingFirst &pending, const Config &c, const std::string &cardsDir, std::string &note)
    {
        if (!pending.held)
            return true;
        const Persona row = pending.row;
        pending = PendingFirst{};
        // Picked, then moved away from (another row, NEW PERSONA): the card's order is the player's later choice's.
        // pick() leaves the name empty for one the keyboard cannot type, so an empty name still matches that row.
        const bool named = row.name == c.loginName || (c.loginName.empty() && normalizeLoginName(row.name) != row.name);
        if (!named || row.card != cardLeaf(c))
            return true;
        return moveFirst(cardsDir, row, note);
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
        std::vector<std::string> cardLeaves;   // the cards whose file was read: a ledger beside one is not orphaned
        for (const fs::path &cardDir : cardDirs)
        {
            const std::string leaf = cardDir.filename().string();
            if (normalizeProfile(leaf) != leaf)
                continue;   // not a card this launcher could launch (a hand-made folder): not listed, not noted
            const fs::path file(cardFilePath(cardsDir, leaf));
            std::error_code kind;
            if (!fs::is_regular_file(file, kind))
                continue;   // a card the game has not written a persona file into yet
            const std::string shown = "cards/" + leaf + "/" + kSaveFolder + "/" + kSaveFolder;
            std::vector<cs::Persona> records;
            std::string note;
            if (!readCardRecords(file, shown, records, note))
            {
                cards.notes.push_back(note);
                continue;
            }
            cardLeaves.push_back(leaf);
            // The ledger beside it dates the records; a corrupt one costs only the dates.
            std::vector<Persona> ledger;
            const fs::path ledgerPath = dir / (leaf + kSuffix);
            if (fs::exists(ledgerPath, kind) && !readLedger(ledgerPath.string(), ledger, note))
            {
                cards.notes.push_back(note);
                ledger.clear();
            }
            std::vector<bool> used(ledger.size(), false);
            for (const cs::Persona &rec : records)
            {
                Persona row;
                row.name = rec.name;
                row.card = leaf;
                row.server = rec.host;
                row.savedPassword = rec.savePassword && !rec.password.empty();
                row.second = endsWith(leaf, "_b");
                for (std::size_t i = 0; i < ledger.size(); ++i)
                {
                    if (ledger[i].name != rec.name)
                        continue;
                    if (ledger[i].server != rec.host && resolveIPv4(ledger[i].server) != rec.host)
                        continue;
                    used[i] = true;
                    if (ledger[i].lastLogin > row.lastLogin)
                        row.lastLogin = ledger[i].lastLogin;
                }
                cards.rows.push_back(row);
            }
            const auto unmatched = std::count(used.begin(), used.end(), false);
            if (unmatched > 0)
                cards.notes.push_back(leaf + kSuffix + ": " + std::to_string(unmatched) +
                                      (unmatched == 1 ? " record" : " records") + " with no persona on the card; not listed");
        }
        for (const fs::path &ledger : ledgers)
        {
            const std::string file = ledger.filename().string();
            const std::string leaf = leafOf(file);
            if (std::find(cardLeaves.begin(), cardLeaves.end(), leaf) != cardLeaves.end())
                continue;   // dated its card's rows above
            if (normalizeProfile(leaf) != leaf)
            {
                cards.notes.push_back(file + ": its card name is not a profile name; skipped");
                continue;
            }
            std::error_code kind;
            if (!fs::is_directory(dir / leaf, kind))
            {
                cards.notes.push_back(file + ": its card, cards/" + leaf + "/, is gone; skipped");
                continue;
            }
            // The card is there but holds no persona file this build read: the ledger's records are not rows (R-A).
            std::vector<Persona> records;
            std::string note;
            if (!readLedger(ledger.string(), records, note))
                cards.notes.push_back(note);
            else if (!records.empty() && !fs::is_regular_file(fs::path(cardFilePath(cardsDir, leaf)), kind))
                cards.notes.push_back(file + ": its card holds no persona file yet; not listed");
        }
        return cards;
    }

    const char *emptySentence(const Cards &cards)
    {
        return cards.rows.empty() ? kEmptySentence : "";
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
        // The address the game connects to: a Custom server's MUIS Endpoint when one is set (the review, finding 1).
        const std::string server = cardHostAddress(c);
        if (row.server == server)
            return true;
        // A card row holds HOST, the address the game connected to, with no port; the config may name the server by
        // its hostname or add ":port". Only a dotted row needs the server's address (a dotted one without a lookup,
        // a name through the cache).
        if (!dottedQuad(row.server))
            return false;
        return resolveIPv4(server) == row.server;
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

    bool pick(Config &c, const Persona &row, const std::string &cardsDir, std::string &note)
    {
        pick(c, row);
        return moveFirst(cardsDir, row, note);
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
        if (preset != nullptr)
            return preset->label;
        // A card row's HOST is the preset's hostname resolved: the preset's label still names it (cached lookups).
        if (dottedQuad(address))
            for (const ServerPreset &p : kServerPresets)
                if (p.address[0] != '\0' && presetAvailable(p) && !dottedQuad(p.address) && resolveIPv4(p.address) == address)
                    return p.label;
        return address;
    }
}
