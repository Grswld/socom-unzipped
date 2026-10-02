#pragma once
// Sprint 9 Goal 1: the folder the running executable is in. The launcher has had this since Task 8b
// (win32glue::exeDirectory, both glues); the runner needs it for the bare run and must not link the glue.
#include <filesystem>

namespace ExeDir
{
    std::filesystem::path get();
    // "windows", "linux", "macos" or "other": for the diagnostics zip's versions.txt, so the launcher needs no #ifdef.
    const char *platformName();
}
