#pragma once
// The hand-rolled JSON reader config.json is read with (launcher_config.cpp, since Task 8b) -- one small struct,
// no dependency for the launcher. Sprint 10 Goal 8 moved it here so the "mapping" block (mapping.cpp) reads its
// nested objects with the same reader rather than a second one. Internal to ps2x_shared: not under include/.
#include <cctype>
#include <cstdlib>
#include <string>

namespace launcher::detail
{
    struct JsonReader
    {
        const std::string &s;
        size_t i = 0;
        explicit JsonReader(const std::string &text) : s(text) {}

        void ws()
        {
            while (i < s.size() && std::isspace(static_cast<unsigned char>(s[i])))
                ++i;
        }
        // The next non-space character, without taking it ('\0' at the end).
        char peek()
        {
            ws();
            return i < s.size() ? s[i] : '\0';
        }
        bool take(char c)
        {
            ws();
            if (i < s.size() && s[i] == c)
            {
                ++i;
                return true;
            }
            return false;
        }
        bool string(std::string &out)
        {
            ws();
            if (i >= s.size() || s[i] != '"')
                return false;
            ++i;
            out.clear();
            while (i < s.size())
            {
                const char c = s[i++];
                if (c == '"')
                    return true;
                if (c == '\\')
                {
                    if (i >= s.size())
                        return false;
                    const char e = s[i++];
                    switch (e)
                    {
                    case '"': out.push_back('"'); break;
                    case '\\': out.push_back('\\'); break;
                    case '/': out.push_back('/'); break;
                    case 'n': out.push_back('\n'); break;
                    case 'r': out.push_back('\r'); break;
                    case 't': out.push_back('\t'); break;
                    case 'b': out.push_back('\b'); break;
                    case 'f': out.push_back('\f'); break;
                    case 'u':
                    {
                        if (i + 4 > s.size())
                            return false;
                        const unsigned code = static_cast<unsigned>(std::strtoul(s.substr(i, 4).c_str(), nullptr, 16));
                        i += 4;
                        // Sprint 16 L1b (#73): 0x80-0xFF is the byte itself -- the persona ledger writes every byte
                        // of a name outside printable ASCII as \u00XX (personas.cpp), and a name is bytes, so an
                        // accented one must come back as it went in. Past 0xFF there is no one byte to give: '?'.
                        if (code <= 0xFF)
                            out.push_back(static_cast<char>(code));
                        else
                            out.push_back('?');
                        break;
                    }
                    default: return false;
                    }
                }
                else
                    out.push_back(c);
            }
            return false;
        }
        // Skips any JSON value (used for unknown keys). Returns false on malformed input.
        bool skipValue()
        {
            ws();
            if (i >= s.size())
                return false;
            const char c = s[i];
            if (c == '"')
            {
                std::string tmp;
                return string(tmp);
            }
            if (c == '{' || c == '[')
            {
                const char close = c == '{' ? '}' : ']';
                ++i;
                ws();
                if (take(close))
                    return true;
                for (;;)
                {
                    if (c == '{')
                    {
                        std::string key;
                        if (!string(key) || !take(':'))
                            return false;
                    }
                    if (!skipValue())
                        return false;
                    if (take(','))
                        continue;
                    return take(close);
                }
            }
            // number, true, false, null
            const size_t start = i;
            while (i < s.size() && (std::isalnum(static_cast<unsigned char>(s[i])) || s[i] == '-' || s[i] == '+' || s[i] == '.'))
                ++i;
            return i > start;
        }
        // The text of the next value, whole, as written -- for a block another reader takes apart (the mapping).
        bool rawValue(std::string &out)
        {
            ws();
            const size_t start = i;
            if (!skipValue())
                return false;
            out = s.substr(start, i - start);
            return true;
        }
        bool scalar(std::string &raw)
        {
            ws();
            const size_t start = i;
            while (i < s.size() && (std::isalnum(static_cast<unsigned char>(s[i])) || s[i] == '-' || s[i] == '+' || s[i] == '.'))
                ++i;
            raw = s.substr(start, i - start);
            return !raw.empty();
        }
    };
}
