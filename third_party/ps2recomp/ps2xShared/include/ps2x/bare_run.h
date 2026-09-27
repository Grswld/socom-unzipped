#pragma once

// Sprint 9 Goal 1: `socom2` with no argument -- a double-click -- reads the launcher's own config.json
// beside it and starts the game the way the launcher would have. The launcher's Config, fromJson and
// environmentFor are the single schema (launcher/launcher_config.h, in this same library); nothing here
// parses JSON or names a knob of its own.

#include "ps2x/exit_codes.h"

#include <filesystem>
#include <string>
#include <vector>

namespace BareRun
{
    struct Plan
    {
        int code = ExitCodes::kOk;            // kConfigUnreadable when config.json is there and cannot be read
        std::string detail;
        std::filesystem::path home;           // the folder the game lives in
        std::filesystem::path elf;            // home/<the revision's ELF>: socom2_game.elf for r0001
        std::filesystem::path logDir;         // home/logs
        bool configFound = false;             // false: no config.json, the defaults were used
        std::vector<std::string> environment; // KEY=VALUE, PS2X_MC_DIR absolute
    };

    // `gameRevision` is the BUILD's own revision (the runner passes PS2X_GAME_REVISION): an r0004 executable
    // double-clicked loads socom2_game_r0004.elf, not r0001's ELF beside it (issue #69). The ELF's name is
    // launcher::gameFilesFor's -- the launcher's table -- and an unknown revision is r0001.
    Plan plan(const std::filesystem::path &home, const std::string &gameRevision);
    // r0001's plan: plan(home, "r0001").
    Plan plan(const std::filesystem::path &home);

    // Sets each KEY=VALUE only when KEY is not already set; returns how many were set. An entry with
    // no '=' is skipped.
    int applyEnvironment(const std::vector<std::string> &keyValues);

    // "YYYYMMDD_HHMMSS", local time: the launcher's run_<stamp>.log shape.
    std::string stamp();

    // stdout and stderr to logDir/run_<stamp>.log. Returns the path; empty when it could not be opened
    // (output then stays where it was).
    std::string redirectOutput(const std::filesystem::path &logDir);

    // Windows: when this process is the only client of its console -- Explorer made one for a
    // double-click -- let it go, so no empty black window sits behind the game. Elsewhere: nothing.
    void detachOwnConsole();
}
