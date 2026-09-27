// Sprint 16 R2a (#71): see launcher/patch_fetch.h.
#include "launcher/patch_fetch.h"
#include "launcher/bug_report.h"
#include "launcher/sha256.h"

#include <cctype>
#include <fstream>
#include <iterator>
#include <system_error>
#include <vector>

namespace launcher::patchfetch
{
    std::string patchBase(const char *envValue)
    {
        // bugreport::apiBase holds the loopback rule (and its tests); it answers its own default for anything
        // it refuses, so a value that comes back changed is a loopback base it accepted.
        const std::string accepted = bugreport::apiBase(envValue);
        return accepted != bugreport::kDefaultApiBase ? accepted : std::string(kDefaultPatchBase);
    }

    std::string patchUrl(const std::string &base)
    {
        std::string b = base;
        if (!b.empty() && b.back() == '/')
            b.pop_back();
        return b + kPatchPath;
    }

    Verdict verifyPackage(const std::filesystem::path &path, uint64_t expectedBytes, const std::string &expectedSha256Hex)
    {
        Verdict out;
        std::error_code ec;
        auto refuse = [&](const std::string &why)
        {
            out.reason = why;
            std::filesystem::remove(path, ec);
            return out;
        };
        std::ifstream in(path, std::ios::binary);
        if (!in)
            return refuse("the package is not there: " + path.string());
        const std::vector<char> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
        in.close();
        if (bytes.size() != expectedBytes)
            return refuse("the package is " + std::to_string(bytes.size()) + " bytes, not " + std::to_string(expectedBytes));
        out.sha256 = sha256::hex(reinterpret_cast<const uint8_t *>(bytes.data()), bytes.size());
        std::string expected = expectedSha256Hex;
        for (char &c : expected)
            c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        if (out.sha256 != expected)
            return refuse("the package's sha256 is " + out.sha256 + ", not " + expected);
        out.ok = true;
        return out;
    }

    std::filesystem::path stagingPath(const std::filesystem::path &dest)
    {
        std::filesystem::path staged = dest;
        staged += ".new";
        return staged;
    }

    Verdict installPackage(const std::filesystem::path &staged, const std::filesystem::path &dest, uint64_t expectedBytes,
                           const std::string &expectedSha256Hex)
    {
        Verdict out = verifyPackage(staged, expectedBytes, expectedSha256Hex);   // a refusal deletes `staged`
        if (!out.ok)
            return out;
        std::error_code ec;
        std::filesystem::rename(staged, dest, ec);   // replaces an existing `dest`
        if (ec)
        {
            out.ok = false;
            out.reason = "could not move the package to " + dest.string() + " (" + ec.message() + ")";
            std::filesystem::remove(staged, ec);
        }
        return out;
    }
}
