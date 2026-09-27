#include "ps2x/knobs.h"

#include <atomic>
#include <cstdlib>
#include <cstring>
#include <cwctype>
#include <filesystem>

namespace ps2x
{
    namespace knobs
    {
        namespace
        {
            std::atomic<int> g_dev{-1};           // -1: not decided yet, PS2X_DEV decides on first use
            std::atomic<bool> g_enforce{true};    // a process that says nothing is a stranger's (Sprint 9 Goal 3 Task 7)

            // Path knobs whose value may lie anywhere: a file that is only read, kept where the player keeps it.
            constexpr const char *kReadAnywhere[] = {"PS2X_CD_IMAGE"};

            // Knobs whose value is a credential: the [knobs] line says one is set and never what it is (R208).
            // The log and versions.txt travel in the diagnostics zip and the bug report, whose text scrubber
            // has a six-character floor (diagnostics.cpp) that a short password passes under.
            constexpr const char *kNeverPrinted[] = {"PS2X_SOCOM2_LOGIN_PASS"};

            bool named(const char *const *list, size_t count, const char *name)
            {
                for (size_t i = 0; i < count; ++i)
                    if (std::strcmp(name, list[i]) == 0)
                        return true;
                return false;
            }

            bool sameComponent(const std::filesystem::path &a, const std::filesystem::path &b)
            {
#ifdef _WIN32
                // Windows paths compare without case; canonical() does not always agree with current_path() on it.
                const std::wstring x = a.wstring(), y = b.wstring();
                if (x.size() != y.size())
                    return false;
                for (size_t i = 0; i < x.size(); ++i)
                    if (towlower(x[i]) != towlower(y[i]))
                        return false;
                return true;
#else
                return a == b;
#endif
            }

            std::string printable(const Entry &e, const std::string &value)
            {
                if (named(kNeverPrinted, sizeof(kNeverPrinted) / sizeof(kNeverPrinted[0]), e.name))
                    return "[redacted]";
                std::string v = value;
                if (e.kind == Kind::Path)
                {
                    const size_t slash = v.find_last_of("/\\");
                    if (slash != std::string::npos && slash + 1 < v.size())
                        v = v.substr(slash + 1);
                }
                if (v.size() > 40)
                    v = v.substr(0, 40) + "...";
                if (v.find(' ') != std::string::npos)
                    v = "\"" + v + "\"";
                return v;
            }
        }

        const Entry *find(const char *name)
        {
            if (name == nullptr)
                return nullptr;
            size_t lo = 0, hi = kTableSize;
            while (lo < hi)
            {
                const size_t mid = lo + (hi - lo) / 2;
                const int c = std::strcmp(kTable[mid].name, name);
                if (c == 0)
                    return &kTable[mid];
                if (c < 0)
                    lo = mid + 1;
                else
                    hi = mid;
            }
            return nullptr;
        }

        const char *className(Class cls)
        {
            switch (cls)
            {
            case Class::Shipping: return "Shipping";
            case Class::Dev: return "Dev";
            case Class::Test: return "Test";
            case Class::Switch: return "Switch";
            }
            return "?";
        }

        const char *kindName(Kind kind)
        {
            switch (kind)
            {
            case Kind::Flag: return "Flag";
            case Kind::Presence: return "Presence";
            case Kind::Int: return "Int";
            case Kind::Float: return "Float";
            case Kind::Text: return "Text";
            case Kind::Path: return "Path";
            case Kind::Spec: return "Spec";
            }
            return "?";
        }

        bool flagValue(const char *value, bool dflt)
        {
            if (value == nullptr || *value == 0)
                return dflt;
            return !(std::strcmp(value, "0") == 0 || std::strcmp(value, "false") == 0 || std::strcmp(value, "off") == 0);
        }

        bool pathInsideHome(const char *name, const char *value)
        {
            if (name == nullptr || value == nullptr || *value == 0)
                return true;
            if (named(kReadAnywhere, sizeof(kReadAnywhere) / sizeof(kReadAnywhere[0]), name))
                return true;
            namespace fs = std::filesystem;
            std::error_code ec;
            const fs::path home = fs::weakly_canonical(fs::current_path(ec), ec);
            if (ec || home.empty())
                return false;
            const fs::path where = fs::weakly_canonical(fs::absolute(fs::path(value), ec), ec);
            if (ec)
                return false;
            auto h = home.begin();
            auto w = where.begin();
            for (; h != home.end(); ++h, ++w)
                if (w == where.end() || !sameComponent(*h, *w))
                    return false;
            return true;
        }

        bool devMode()
        {
            int v = g_dev.load(std::memory_order_acquire);
            if (v < 0)
            {
                // The one raw read of a PS2X_* name outside this function's callers: the switch cannot be read
                // through the accessor it controls. tools_py/knobs.py allows getenv("PS2X_ in this file only.
                v = flagValue(std::getenv("PS2X_DEV"), false) ? 1 : 0;
                g_dev.store(v, std::memory_order_release);
            }
            return v != 0;
        }

        void setDevMode(bool on) { g_dev.store(on ? 1 : 0, std::memory_order_release); }
        void resetDevModeForTests() { g_dev.store(-1, std::memory_order_release); }
        bool enforcement() { return g_enforce.load(std::memory_order_acquire); }
        void setEnforcement(bool on) { g_enforce.store(on, std::memory_order_release); }

        bool consumeDevFlag(int &argc, char **argv)
        {
            bool found = false;
            int out = 0;
            for (int i = 0; i < argc; ++i)
            {
                if (i > 0 && argv[i] != nullptr && std::strcmp(argv[i], "--dev") == 0)
                {
                    found = true;
                    continue;
                }
                argv[out++] = argv[i];
            }
            if (found)
                argv[out] = nullptr;   // out < argc, and argv[argc] was already null
            argc = out;
            return found;
        }

        std::string describe(const Pairs &set, bool honourDev)
        {
            std::string shown, ignored, refused;
            for (const auto &pair : set)
            {
                const Entry *e = find(pair.first.c_str());
                if (e == nullptr || e->cls == Class::Test || pair.second.empty())
                    continue;
                if (e->cls == Class::Dev && !honourDev)
                {
                    ignored += " " + pair.first;
                    continue;
                }
                if (!honourDev && e->kind == Kind::Path && !pathInsideHome(e->name, pair.second.c_str()))
                {
                    refused += " " + pair.first;
                    continue;
                }
                if (e->cls != Class::Dev && pair.second == e->dflt)
                    continue;
                shown += " " + pair.first + "=" + printable(*e, pair.second);
            }
            std::string out = std::string("[knobs] dev=") + (honourDev ? "1" : "0") + " set:" + (shown.empty() ? std::string(" none") : shown);
            if (!ignored.empty())
                out += " | ignored without --dev:" + ignored;
            if (!refused.empty())
                out += " | refused, outside the game folder:" + refused;
            return out;
        }

        std::string startupLine()
        {
            Pairs set;
            for (const Entry &e : kTable)
            {
                const char *v = std::getenv(e.name);
                if (v != nullptr && *v != 0)
                    set.emplace_back(e.name, v);
            }
            return describe(set, devMode() || !enforcement());
        }
    }

    const char *knob(const char *name)
    {
        const char *v = std::getenv(name);
        if (!knobs::enforcement())
            return v;
        if (v == nullptr || *v == 0)
            return nullptr;               // the common case costs what it cost before: one getenv
        const knobs::Entry *e = knobs::find(name);
        if (e == nullptr)
            return nullptr;               // test_knobs_registry keeps this unreachable for a literal name
        if (e->cls == knobs::Class::Dev && !knobs::devMode())
            return nullptr;
        if (e->kind == knobs::Kind::Path && !knobs::devMode() && !knobs::pathInsideHome(name, v))
            return nullptr;               // R207: a stranger's path stays inside the game folder
        return v;
    }

    bool knobOn(const char *name, bool dflt)
    {
        return knobs::flagValue(knob(name), dflt);
    }
}
