// The memory card's SOCOM II save file (launcher/card_save.h): the scrambler, the ZAR v2 archive and the AcctInfo.rdr
// records. A port of tools_py/card_save.py, which round-trips every example card byte for byte; the persona-card
// plan (docs/superpowers/plans/2026-09-28-persona-card-creator.md) section 1 has the layout. Every read is bounded by
// its buffer: a card file is the player's, and a damaged one is refused with a reason, never read past its end.
#include "launcher/card_save.h"

#include "card_template.h"

#include <cstddef>
#include <cstring>
#include <map>

namespace launcher::card
{
    namespace
    {
        int8_t s8(uint32_t x) { return static_cast<int8_t>(static_cast<uint8_t>(x & 0xFFu)); }

        // One step of the game's cipher: the output byte, and k advanced by the PLAIN byte p (signed).
        uint8_t step(uint8_t p, uint32_t &k)
        {
            const uint8_t c = static_cast<uint8_t>((s8(p) ^ s8(k)) & 0xFF);
            k = (k ^ ((k + static_cast<uint32_t>(static_cast<int32_t>(s8(p)))) & 0xFFu)) & 0xFFu;
            return c;
        }

        uint32_t u32At(const std::vector<uint8_t> &b, std::size_t at)
        {
            return static_cast<uint32_t>(b[at]) | (static_cast<uint32_t>(b[at + 1]) << 8) |
                   (static_cast<uint32_t>(b[at + 2]) << 16) | (static_cast<uint32_t>(b[at + 3]) << 24);
        }
        int32_t s32At(const std::vector<uint8_t> &b, std::size_t at) { return static_cast<int32_t>(u32At(b, at)); }

        void putU32(std::vector<uint8_t> &b, std::size_t at, uint32_t v)
        {
            b[at] = static_cast<uint8_t>(v);
            b[at + 1] = static_cast<uint8_t>(v >> 8);
            b[at + 2] = static_cast<uint8_t>(v >> 16);
            b[at + 3] = static_cast<uint8_t>(v >> 24);
        }

        std::size_t align16(std::size_t n) { return (n + 15u) & ~std::size_t(15u); }

        // A C string at `at` in `table`, to its NUL or the table's end (the reference reads it so).
        std::string cstr(const uint8_t *table, std::size_t size, std::size_t at)
        {
            std::size_t end = at;
            while (end < size && table[end] != 0)
                ++end;
            return std::string(reinterpret_cast<const char *>(table + at), end - at);
        }

        // Interned strings, laid out in the order first seen, each NUL-terminated.
        struct StringTable
        {
            std::vector<uint8_t> bytes;
            std::map<std::string, uint32_t> at;
            uint32_t intern(const std::string &s)
            {
                const auto it = at.find(s);
                if (it != at.end())
                    return it->second;
                const uint32_t ofs = static_cast<uint32_t>(bytes.size());
                bytes.insert(bytes.end(), s.begin(), s.end());
                bytes.push_back(0);
                at.emplace(s, ofs);
                return ofs;
            }
        };

        // ---- ZAR ----
        constexpr std::size_t kHeadBytes = 100;   // 25 words
        constexpr int kMaxDepth = 64;

        struct ZarReader
        {
            const std::vector<uint8_t> &plain;
            const uint8_t *stable = nullptr;
            std::size_t stableSize = 0;
            int64_t stableOfs = 0;
            std::size_t keyOfs = 0, keyCount = 0, data0 = 0, next = 0;
            std::string why;

            bool key(ZarKey &out, bool isRoot, int depth)
            {
                if (depth > kMaxDepth)
                    return fail("the key tree is deeper than " + std::to_string(kMaxDepth));
                if (next >= keyCount)
                    return fail("a child count runs past the " + std::to_string(keyCount) + " keys");
                const std::size_t at = keyOfs + next * 16;
                ++next;
                const int32_t nameOfs = s32At(plain, at);
                const uint32_t offset = u32At(plain, at + 4);
                const uint32_t size = u32At(plain, at + 8);
                const int32_t children = s32At(plain, at + 12);
                if (children < 0)
                    return fail("a negative child count");
                out = ZarKey{};
                if (!isRoot)   // reCOM CKey::Read: the root's name is never read
                {
                    const int64_t rel = static_cast<int64_t>(nameOfs) - stableOfs;
                    if (rel >= 0 && static_cast<std::size_t>(rel) < stableSize)
                        out.name = cstr(stable, stableSize, static_cast<std::size_t>(rel));
                }
                if (size != 0)
                {
                    const uint64_t begin = static_cast<uint64_t>(data0) + offset;
                    if (begin + size > plain.size())
                        return fail("key '" + out.name + "' runs past the end of the file");
                    out.data.assign(plain.begin() + static_cast<std::ptrdiff_t>(begin),
                                    plain.begin() + static_cast<std::ptrdiff_t>(begin + size));
                }
                for (int32_t i = 0; i < children; ++i)
                {
                    out.children.emplace_back();
                    if (!key(out.children.back(), false, depth + 1))
                        return false;
                }
                return true;
            }

            bool fail(const std::string &w)
            {
                why = w;
                return false;
            }
        };

        void preorder(const ZarKey &k, std::vector<const ZarKey *> &out)
        {
            out.push_back(&k);
            for (const auto &c : k.children)
                preorder(c, out);
        }

        ZarKey *findAcctInfo(ZarKey &k, int depth = 0)
        {
            if (depth > kMaxDepth)
                return nullptr;
            if (k.name == "CAcctDB")
                for (auto &c : k.children)
                    if (c.name == "AcctInfo.rdr")
                        return &c;
            for (auto &c : k.children)
                if (ZarKey *hit = findAcctInfo(c, depth + 1))
                    return hit;
            return nullptr;
        }

        // ---- AcctInfo.rdr ----
        constexpr uint8_t kInt = 1, kString = 3, kList = 4;
        constexpr std::size_t kMaxNodesVisited = 1u << 16;   // the game's sharing lets a node be reached twice; bound it

        struct Value
        {
            uint8_t type = kList;
            int32_t i = 0;
            std::string s;
            std::vector<Value> list;
        };

        struct RdrReader
        {
            const std::vector<uint8_t> &blob;
            std::size_t tableAt = 12, tableSize = 0, nodeAt = 0;
            std::size_t visited = 0;
            std::string why;

            bool value(std::size_t at, Value &out, int depth)
            {
                if (depth > 16)
                    return fail("the record tree is deeper than 16");
                if (++visited > kMaxNodesVisited)
                    return fail("more than 65536 nodes reached");
                const uint64_t pos = static_cast<uint64_t>(nodeAt) + at;
                if (pos + 8 > blob.size())
                    return fail("a node at " + std::to_string(at) + " runs past the end of the blob");
                const std::size_t p = static_cast<std::size_t>(pos);
                const uint8_t type = blob[p];
                const uint16_t count = static_cast<uint16_t>(blob[p + 2] | (blob[p + 3] << 8));
                const uint32_t v = u32At(blob, p + 4);
                out = Value{};
                out.type = type;
                if (type == kInt)
                {
                    out.i = static_cast<int32_t>(v);
                    return true;
                }
                if (type == kString)
                {
                    if (v >= tableSize)
                        return fail("a string offset past the string table");
                    out.s = cstr(blob.data() + tableAt, tableSize, v);
                    return true;
                }
                if (type == kList)
                {
                    out.list.resize(count);
                    for (uint16_t n = 0; n < count; ++n)
                        if (!value(static_cast<std::size_t>(v) + std::size_t(n) * 8, out.list[n], depth + 1))
                            return false;
                    return true;
                }
                return fail("rdr node type " + std::to_string(type));
            }

            bool fail(const std::string &w)
            {
                why = w;
                return false;
            }
        };

        // The one-element list the record's scalar fields are ([str] or [int]); nullptr for another shape.
        const Value *single(const Value &v, uint8_t type)
        {
            return v.type == kList && v.list.size() == 1 && v.list[0].type == type ? &v.list[0] : nullptr;
        }

        Value str(const std::string &s)
        {
            Value v;
            v.type = kString;
            v.s = s;
            return v;
        }
        Value num(int32_t i)
        {
            Value v;
            v.type = kInt;
            v.i = i;
            return v;
        }
        Value list(std::vector<Value> items)
        {
            Value v;
            v.type = kList;
            v.list = std::move(items);
            return v;
        }

        // The game's layout: a list's children are allocated as one block when the list is reached, depth-first in
        // child order; strings are interned as they are reached. `nodes` holds {type, count, value} per node.
        struct RdrWriter
        {
            struct Node
            {
                uint8_t type;
                uint16_t count;
                uint32_t value;
            };
            std::vector<Node> nodes;
            StringTable table;

            void fill(const Value &v, std::size_t index)
            {
                if (v.type == kInt)
                    nodes[index] = Node{kInt, 0, static_cast<uint32_t>(v.i)};
                else if (v.type == kString)
                    nodes[index] = Node{kString, 0, table.intern(v.s)};
                else
                {
                    const std::size_t base = nodes.size();
                    const std::size_t count = v.list.size() > 0xFFFFu ? 0xFFFFu : v.list.size();
                    nodes[index] = Node{kList, static_cast<uint16_t>(count), static_cast<uint32_t>(base * 8)};
                    nodes.resize(base + count);
                    for (std::size_t n = 0; n < count; ++n)
                        fill(v.list[n], base + n);
                }
            }
        };
    }

    std::vector<uint8_t> unscramble(const std::vector<uint8_t> &file)
    {
        std::vector<uint8_t> b = file;
        const std::size_t n = b.size();
        if (n >= 2)
        {
            uint32_t k = b[n - 1];
            for (std::size_t i = n - 1; i-- > 0;)
            {
                const uint8_t v = static_cast<uint8_t>((s8(b[i]) ^ s8(k)) & 0xFF);
                b[i] = v;
                k = (k ^ ((k + static_cast<uint32_t>(static_cast<int32_t>(s8(v)))) & 0xFFu)) & 0xFFu;
            }
        }
        uint32_t k = 0x96;
        for (std::size_t i = 0; i < n; ++i)
        {
            const uint8_t v = static_cast<uint8_t>((s8(b[i]) ^ s8(k)) & 0xFF);
            b[i] = v;
            k = (k ^ ((k + static_cast<uint32_t>(static_cast<int32_t>(s8(v)))) & 0xFFu)) & 0xFFu;
        }
        return b;
    }

    std::vector<uint8_t> scramble(const std::vector<uint8_t> &plain)
    {
        std::vector<uint8_t> b = plain;
        const std::size_t n = b.size();
        uint32_t k = 0x96;
        for (std::size_t i = 0; i < n; ++i)
            b[i] = step(b[i], k);
        if (n >= 2)
        {
            k = b[n - 1];
            for (std::size_t i = n - 1; i-- > 0;)
                b[i] = step(b[i], k);
        }
        return b;
    }

    bool parseZar(const std::vector<uint8_t> &plain, ZarKey &root, std::string &why)
    {
        if (plain.size() < kHeadBytes)
        {
            why = "shorter than a ZAR head (" + std::to_string(plain.size()) + " bytes)";
            return false;
        }
        const int32_t version = s32At(plain, 24 * 4);
        if (version != kZarVersion2)
        {
            why = "not a ZAR version-2 archive (version " + std::to_string(version) + ")";
            return false;
        }
        const int32_t flags = s32At(plain, 0);
        const int32_t keyCount = s32At(plain, 4);
        const int32_t stableSize = s32At(plain, 8);
        const int32_t stableOfs = s32At(plain, 12);
        const int32_t padding = s32At(plain, 16);
        if (flags != 0)
        {
            why = "ZAR flags " + std::to_string(flags) + " (only 0 is read)";
            return false;
        }
        if (keyCount < 1 || stableSize < 0 || padding < 0)
        {
            why = "a ZAR head with " + std::to_string(keyCount) + " keys, a " + std::to_string(stableSize) +
                  "-byte string table, padding " + std::to_string(padding);
            return false;
        }
        const uint64_t keyOfs = kHeadBytes + static_cast<uint64_t>(stableSize);
        const uint64_t keyEnd = keyOfs + static_cast<uint64_t>(keyCount) * 16;
        if (keyEnd > plain.size())
        {
            why = "the string table and keys run past the end of the file";
            return false;
        }
        const uint64_t rem = padding ? keyEnd % static_cast<uint64_t>(padding) : 0;
        const uint64_t data0 = keyEnd + (rem ? static_cast<uint64_t>(padding) - rem : 0);

        ZarReader r{plain, nullptr, 0, 0, 0, 0, 0, 0, {}};
        r.stable = plain.data() + kHeadBytes;
        r.stableSize = static_cast<std::size_t>(stableSize);
        r.stableOfs = stableOfs;
        r.keyOfs = static_cast<std::size_t>(keyOfs);
        r.keyCount = static_cast<std::size_t>(keyCount);
        r.data0 = static_cast<std::size_t>(data0);
        ZarKey out;
        if (!r.key(out, true, 0))
        {
            why = r.why;
            return false;
        }
        if (r.next != r.keyCount)
        {
            why = "the key tree holds " + std::to_string(r.next) + " of the head's " + std::to_string(keyCount) + " keys";
            return false;
        }
        root = std::move(out);
        why.clear();
        return true;
    }

    std::vector<uint8_t> buildZar(const ZarKey &root)
    {
        std::vector<const ZarKey *> keys;
        preorder(root, keys);

        StringTable table;
        table.intern("");   // offset 0: stable_ofs is 0, so the root's name_ofs 0 must read as unnamed
        std::vector<uint32_t> nameOfs(keys.size(), 0), dataOfs(keys.size(), 0);
        std::size_t cursor = 0;
        for (std::size_t i = 0; i < keys.size(); ++i)
        {
            if (i != 0)
                nameOfs[i] = table.intern(keys[i]->name);
            if (!keys[i]->data.empty())
            {
                dataOfs[i] = static_cast<uint32_t>(cursor);
                cursor = align16(cursor + keys[i]->data.size());
            }
        }

        const std::size_t keyOfs = kHeadBytes + table.bytes.size();
        const std::size_t data0 = align16(keyOfs + keys.size() * 16);
        std::vector<uint8_t> out(data0 + cursor, 0);
        putU32(out, 0, 0);                                                  // flags
        putU32(out, 4, static_cast<uint32_t>(keys.size()));                 // key_count
        putU32(out, 8, static_cast<uint32_t>(table.bytes.size()));          // stable_size
        putU32(out, 12, 0);                                                 // stable_ofs
        putU32(out, 16, 16);                                                // padding
        putU32(out, 21 * 4, static_cast<uint32_t>(cursor));                 // offset: the data's size
        putU32(out, 22 * 4, 0);                                             // crc
        putU32(out, 23 * 4, 14);                                            // appversion
        putU32(out, 24 * 4, static_cast<uint32_t>(kZarVersion2));           // version
        std::memcpy(out.data() + kHeadBytes, table.bytes.data(), table.bytes.size());
        for (std::size_t i = 0; i < keys.size(); ++i)
        {
            const std::size_t at = keyOfs + i * 16;
            putU32(out, at, nameOfs[i]);
            putU32(out, at + 4, dataOfs[i]);
            putU32(out, at + 8, static_cast<uint32_t>(keys[i]->data.size()));
            putU32(out, at + 12, static_cast<uint32_t>(keys[i]->children.size()));
            if (!keys[i]->data.empty())
                std::memcpy(out.data() + data0 + dataOfs[i], keys[i]->data.data(), keys[i]->data.size());
        }
        return out;
    }

    bool readPersonas(const std::vector<uint8_t> &acctInfo, std::vector<Persona> &out, std::string &why)
    {
        out.clear();
        if (acctInfo.size() < 12)
        {
            why = "AcctInfo.rdr is shorter than its header (" + std::to_string(acctInfo.size()) + " bytes)";
            return false;
        }
        const uint32_t one = u32At(acctInfo, 0), stableSize = u32At(acctInfo, 4), nodeOfs = u32At(acctInfo, 8);
        if (one != 1)
        {
            why = "AcctInfo.rdr header word 0 is " + std::to_string(one) + ", not 1";
            return false;
        }
        if (static_cast<uint64_t>(stableSize) + 12 > nodeOfs || nodeOfs > acctInfo.size())
        {
            why = "AcctInfo.rdr's string table or node section runs past the end of the blob";
            return false;
        }
        RdrReader r{acctInfo, 12, 0, 0, 0, {}};
        r.tableSize = stableSize;
        r.nodeAt = nodeOfs;
        Value root;
        if (!r.value(0, root, 0))
        {
            why = r.why;
            return false;
        }
        if (root.type != kList)
        {
            why = "AcctInfo.rdr's root is not a list";
            return false;
        }
        std::vector<Persona> rows;
        for (const Value &rec : root.list)
        {
            if (rec.type != kList)
            {
                why = "a persona record that is not a list";
                return false;
            }
            Persona p;
            for (std::size_t i = 0; i + 1 < rec.list.size(); i += 2)
            {
                if (rec.list[i].type != kString)
                    continue;
                const std::string &key = rec.list[i].s;
                const Value &val = rec.list[i + 1];
                if (key == "PROFILES")
                {
                    if (val.type == kList && val.list.size() > 1 && val.list[1].type == kList)
                    {
                        const auto &sums = val.list[1].list;
                        for (std::size_t n = 0; n < sums.size() && n < p.checksum.size(); ++n)
                            if (sums[n].type == kInt)
                                p.checksum[n] = sums[n].i;
                    }
                    continue;
                }
                const Value *s = single(val, kString);
                const Value *n = single(val, kInt);
                if (key == "HOST" && s)
                    p.host = s->s;
                else if (key == "NAME" && s)
                    p.name = s->s;
                else if (key == "TOWN" && s)
                    p.town = s->s;
                else if (key == "PASSWORD" && s)
                    p.password = s->s;
                else if (key == "GENDER" && n)
                    p.gender = n->i;
                else if (key == "PORT" && n)
                    p.port = n->i;
                else if (key == "SAVEPASSWORD" && n)
                    p.savePassword = n->i != 0;
            }
            rows.push_back(std::move(p));
        }
        out = std::move(rows);
        why.clear();
        return true;
    }

    std::vector<uint8_t> writePersonas(const std::vector<Persona> &personas)
    {
        Value root = list({});
        for (const Persona &p : personas)
        {
            std::vector<Value> sums;
            for (int32_t c : p.checksum)
                sums.push_back(num(c));
            root.list.push_back(list({
                str("HOST"), list({str(p.host)}),
                str("NAME"), list({str(p.name)}),
                str("TOWN"), list({str(p.town)}),
                str("GENDER"), list({num(p.gender)}),
                str("PORT"), list({num(p.port)}),
                str("PASSWORD"), list({str(p.password)}),
                str("SAVEPASSWORD"), list({num(p.savePassword ? 1 : 0)}),
                str("PROFILES"), list({str("PROFILE_CHECKSUM"), list(std::move(sums)), str("PROFILE_INFO"), list({})}),
            }));
        }
        RdrWriter w;
        w.nodes.resize(1);
        w.fill(root, 0);

        const std::size_t nodeOfs = align16(12 + w.table.bytes.size());
        std::vector<uint8_t> out(nodeOfs + w.nodes.size() * 8, 0);
        putU32(out, 0, 1);
        putU32(out, 4, static_cast<uint32_t>(w.table.bytes.size()));
        putU32(out, 8, static_cast<uint32_t>(nodeOfs));
        std::memcpy(out.data() + 12, w.table.bytes.data(), w.table.bytes.size());
        for (std::size_t i = 0; i < w.nodes.size(); ++i)
        {
            const std::size_t at = nodeOfs + i * 8;
            out[at] = w.nodes[i].type;
            out[at + 1] = 0;   // flags: no node shared with an earlier record
            out[at + 2] = static_cast<uint8_t>(w.nodes[i].count);
            out[at + 3] = static_cast<uint8_t>(w.nodes[i].count >> 8);
            putU32(out, at + 4, w.nodes[i].value);
        }
        return out;
    }

    bool readCardFile(const std::vector<uint8_t> &file, std::vector<Persona> &out, std::string &why)
    {
        out.clear();
        ZarKey root;
        if (!parseZar(unscramble(file), root, why))
            return false;
        const ZarKey *acct = findAcctInfo(root);
        if (!acct)
        {
            why = "the card file has no CAcctDB/AcctInfo.rdr key";
            return false;
        }
        return readPersonas(acct->data, out, why);
    }

    std::vector<uint8_t> writeCardFile(const std::vector<uint8_t> &fileOrEmpty, const std::vector<Persona> &personas)
    {
        const std::vector<uint8_t> plain =
            fileOrEmpty.empty() ? std::vector<uint8_t>(kCardTemplate_Virgin, kCardTemplate_Virgin + kCardTemplate_Virgin_len)
                                : unscramble(fileOrEmpty);
        ZarKey root;
        std::string why;
        if (!parseZar(plain, root, why))
            return {};
        ZarKey *acct = findAcctInfo(root);
        if (!acct)
            return {};
        acct->data = writePersonas(personas);
        return scramble(buildZar(root));
    }
}
