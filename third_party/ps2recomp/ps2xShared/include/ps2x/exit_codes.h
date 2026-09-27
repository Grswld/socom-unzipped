#pragma once

// Sprint 9 Goal 1: what the game's exit code means -- decided once, for the runner that leaves with it
// and the launcher that reads it. Header-only and free of every other header in this tree, so
// ps2xRuntime, ps2xLauncher and ps2xTest can all include it; tools_py/exit_codes.py reads the table
// below with a regex, so a row's shape is part of the contract:
//
//     X(Name, <decimal code>, "slug", "One plain sentence, at most 120 characters, no double quote.")
//
// Rules (tools_py/tests/test_exit_codes_table.py and the ExitCodes suite enforce them): a code fits a
// byte, stays outside the shell's 126-165, is used once, and 65 keeps the meaning Sprint 7 gave it.
// 1 and 3 are not new: they are what this process already leaves with, given a name and a sentence.
//
// A crash has no row the runner ever returns. The Windows vectored handler and the Linux sigaction
// handler (game_overrides_socom2.cpp) print their report and let the process die the native way --
// an NT status such as 0xC0000005, or a signal the launcher reads as 128 + n -- and classify() folds
// those onto kCrashed for whoever reads the status (R128).

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#define PS2X_EXIT_CODE_TABLE(X) \
    X(Ok, 0, "ok", "The last run exited normally.") \
    X(Failed, 1, "failed", "The game stopped on an error it did not name. Press SAVE DIAGNOSTICS; the end of the log says more.") \
    X(Aborted, 3, "aborted", "The game stopped itself after an internal error. Press SAVE DIAGNOSTICS; the end of the log says why.") \
    X(NoUsableGl, 65, "no-usable-gl", "Your GPU or driver is missing OpenGL 3.3 with dual-source blending; the game ran on the slow CPU renderer.") \
    X(DiscNotFound, 66, "disc-not-found", "The disc image was not found. Open the DISC page and choose your SOCOM II ISO again.") \
    X(DiscNotR0001, 67, "disc-not-r0001", "That disc image is not SOCOM II NTSC r0001 (SCUS-97275). This build plays only that disc.") \
    X(ElfMissing, 68, "elf-missing", "The game's program image (.elf) is missing or damaged. Unpack the download again and keep every file together.") \
    X(ConfigUnreadable, 69, "config-unreadable", "config.json could not be read. Delete it and start the launcher, which writes a new one.") \
    X(Crashed, 70, "crashed", "The game crashed. Press SAVE DIAGNOSTICS and send the zip; it holds the crash record.") \
    X(OutOfMemory, 71, "out-of-memory", "The game ran out of memory. Close other programs, or lower the render scale on the VIDEO page.") \
    X(CardDirUnwritable, 72, "card-dir-unwritable", "The memory-card folder cannot be written. Move the game out of a protected folder and try again.") \
    X(RevisionMismatch, 73, "revision-mismatch", "These game files are a different disc revision than this copy of the game was built for. Unpack the download again.") \
    X(RebootRequested, 74, "reboot-requested", "The game asked to restart itself after an error. This build cannot restart, so it stopped; the log says why.")

namespace ExitCodes
{
#define PS2X_EXIT_CODE_CONSTANT(Name, code, slug, sentence) constexpr int k##Name = code;
    PS2X_EXIT_CODE_TABLE(PS2X_EXIT_CODE_CONSTANT)
#undef PS2X_EXIT_CODE_CONSTANT

    struct Entry
    {
        int code;
        const char *name;
        const char *slug;
        const char *sentence;
    };

#define PS2X_EXIT_CODE_ENTRY(Name, code, slug, sentence) Entry{code, #Name, slug, sentence},
    inline constexpr Entry kTable[] = {PS2X_EXIT_CODE_TABLE(PS2X_EXIT_CODE_ENTRY)};
#undef PS2X_EXIT_CODE_ENTRY
    inline constexpr int kTableSize = static_cast<int>(sizeof(kTable) / sizeof(kTable[0]));

    inline const Entry *find(int code)
    {
        for (const Entry &e : kTable)
            if (e.code == code)
                return &e;
        return nullptr;
    }

    // What the operating system reported -> a code out of the table where there is one. `raw` is
    // GetExitCodeProcess's DWORD (as an int or unsigned), or posix_glue.cpp's WEXITSTATUS / 128 + signal.
    inline int classify(long long raw)
    {
        const uint32_t u = static_cast<uint32_t>(raw);
        if ((u & 0xF0000000u) == 0xC0000000u)
            return kCrashed;   // an NT error status: access violation, stack overflow, illegal instruction, fast-fail
        switch (raw)
        {
        case 128 + 4:    // SIGILL
        case 128 + 6:    // SIGABRT: std::terminate -> abort() on Linux
        case 128 + 7:    // SIGBUS
        case 128 + 8:    // SIGFPE
        case 128 + 11:   // SIGSEGV
            return kCrashed;
        default:
            return static_cast<int>(raw);
        }
    }

    // The sentence for whatever the process left with. Never empty.
    inline std::string describe(long long raw)
    {
        const int code = classify(raw);
        if (const Entry *e = find(code))
            return e->sentence;
        char buf[128];
        std::snprintf(buf, sizeof(buf), "The game closed with code %d. Press SAVE DIAGNOSTICS to collect the log.", code);
        return buf;
    }

    // ---- notices: something the player should hear about that is not a reason to stop ----------------
    // The runner prints noticeLine() to its log; the launcher reads the log back with noticesIn() and
    // appends the sentences to the LAST RUN line (R129).
    struct Notice
    {
        const char *slug;
        const char *sentence;
    };

    inline constexpr const char *kNoticePrefix = "[notice] ";
    inline constexpr Notice kNoAudioDevice{"no-audio-device", "No audio device was found; the game ran without sound."};
    // Sprint 13 V8, ruling S13-R9: PS2X_SOCOM2_SERVER named a server that does not resolve, so socom2_hostnet
    // refused it (the retail names resolve to nothing, never loopback). A notice and not an exit code: the run
    // goes on offline, and a code would overwrite 65 or 72, which say more about the run than this does.
    inline constexpr Notice kServerUnresolved{"server-unresolved",
                                              "The server name on the ONLINE page did not resolve, so the game stayed offline. Check your connection or the name."};

    inline std::string noticeLine(const Notice &notice)
    {
        return std::string(kNoticePrefix) + notice.slug + ": " + notice.sentence;
    }

    inline std::vector<std::string> noticesIn(const std::string &logText)
    {
        std::vector<std::string> out;
        const std::string prefix = kNoticePrefix;
        size_t pos = 0;
        while (pos < logText.size())
        {
            size_t end = logText.find('\n', pos);
            if (end == std::string::npos)
                end = logText.size();
            std::string line = logText.substr(pos, end - pos);
            pos = end + 1;
            if (!line.empty() && line.back() == '\r')
                line.pop_back();
            if (line.rfind(prefix, 0) != 0)
                continue;
            const size_t colon = line.find(": ", prefix.size());
            if (colon == std::string::npos || colon + 2 >= line.size())
                continue;
            const std::string sentence = line.substr(colon + 2);
            bool seen = false;
            for (const std::string &s : out)
                seen = seen || s == sentence;
            if (!seen)
                out.push_back(sentence);
        }
        return out;
    }
}
