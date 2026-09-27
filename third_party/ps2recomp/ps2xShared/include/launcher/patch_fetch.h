#pragma once

// Sprint 16 R2a (#71): the r0004 package fetch's plumbing, as pure functions. PSRewired serves the r0004 package
// at one fixed path for everyone, and the r0001 client asks for it with the game's own sceHTTP (docs/KNOWN.md
// section 1, the #71 row): GET /s2/r0004/APACHE00.ZDB on patch.psrewired.com, port 80, User-Agent
// sceHTTPLib-1.2.42. The transport is the launcher's glue (win32glue::httpDownload); nothing in this header
// opens a socket. The decrypt, the merge and the toggle are R2's; the first live fetch is the owner's (R293).

#include <cstdint>
#include <filesystem>
#include <string>

namespace launcher::patchfetch
{
    constexpr const char *kDefaultPatchBase = "http://patch.psrewired.com";
    constexpr const char *kPatchBaseEnv = "PS2X_LAUNCHER_PATCH_BASE";   // TEST-ONLY, loopback only: see patchBase()
    constexpr const char *kPatchPath = "/s2/r0004/APACHE00.ZDB";
    constexpr const char *kPatchUserAgent = "sceHTTPLib-1.2.42";        // what the r0001 client sends

    // The package server's base URL. `envValue` (PS2X_LAUNCHER_PATCH_BASE, may be null) is honoured ONLY when it
    // is exactly http://127.0.0.1:<port> or http://localhost:<port> -- a loopback test server, the same rule as
    // bugreport::apiBase -- so nobody can point a player's download somewhere else with an environment variable.
    std::string patchBase(const char *envValue);
    // <base>/s2/r0004/APACHE00.ZDB (a trailing slash on `base` is dropped).
    std::string patchUrl(const std::string &base);

    struct Verdict
    {
        bool ok = false;
        std::string reason;       // why it was refused; empty when ok
        std::string sha256;       // the file's digest, lower-case hex, when it was read
    };
    // The downloaded file is exactly `expectedBytes` long and hashes to `expectedSha256Hex` (either case).
    // Anything else is a refusal that DELETES the file: a wrong package is never left where R2 would read it.
    Verdict verifyPackage(const std::filesystem::path &path, uint64_t expectedBytes, const std::string &expectedSha256Hex);
}
