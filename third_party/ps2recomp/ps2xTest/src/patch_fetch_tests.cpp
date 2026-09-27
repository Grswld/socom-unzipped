// Sprint 16 R2a (#71): the r0004 package fetch's pure half -- the URL, the loopback-only seam and the check that
// refuses (and deletes) a package of the wrong size or digest. Nothing here opens a socket;
// tools_py/tests/test_patch_fetch.py drives the transport against a loopback server. Every byte is synthetic.
#include "MiniTest.h"
#include "launcher/patch_fetch.h"
#include "launcher/sha256.h"

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <string>
#include <system_error>

namespace
{
    namespace pf = launcher::patchfetch;
    namespace fs = std::filesystem;

    fs::path scratchFile(const char *name, const std::string &bytes)
    {
        const fs::path dir = fs::temp_directory_path() / "ps2x_patch_fetch_tests";
        std::error_code ec;
        fs::create_directories(dir, ec);
        const fs::path p = dir / name;
        std::ofstream(p, std::ios::binary).write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
        return p;
    }

    std::string digest(const std::string &bytes)
    {
        return sha256::hex(reinterpret_cast<const uint8_t *>(bytes.data()), bytes.size());
    }
}

void register_patch_fetch_tests()
{
    MiniTest::Case("PatchFetch", [](TestCase &tc)
    {
        tc.Run("the package's address and the client's User-Agent", [](TestCase &t)
        {
            t.Equals(pf::patchUrl(pf::kDefaultPatchBase), std::string("http://patch.psrewired.com/s2/r0004/APACHE00.ZDB"), "the served path");
            t.Equals(pf::patchUrl("http://127.0.0.1:8123/"), std::string("http://127.0.0.1:8123/s2/r0004/APACHE00.ZDB"), "a trailing slash is dropped");
            t.Equals(std::string(pf::kPatchUserAgent), std::string("sceHTTPLib-1.2.42"), "the r0001 client's own");
        });

        tc.Run("patchBase: the test seam is loopback or nothing", [](TestCase &t)
        {
            const std::string live = "http://patch.psrewired.com";
            t.Equals(pf::patchBase(nullptr), live, "unset is the package server");
            t.Equals(pf::patchBase(""), live, "empty is the package server");
            t.Equals(pf::patchBase("http://127.0.0.1:8123"), std::string("http://127.0.0.1:8123"), "a loopback test server is accepted");
            t.Equals(pf::patchBase("http://localhost:8123/"), std::string("http://localhost:8123"), "by name too, the slash dropped");
            t.Equals(pf::patchBase("http://evil.example"), live, "anywhere else is refused");
            t.Equals(pf::patchBase("http://127.0.0.1:80@evil.example"), live, "userinfo dressed as loopback is refused");
            t.Equals(pf::patchBase("http://127.0.0.1:8123/x"), live, "a path is refused");
            t.Equals(pf::patchBase("http://127.0.0.1.evil.example:80"), live, "a look-alike host is refused");
        });

        tc.Run("verifyPackage: the right size and digest is kept", [](TestCase &t)
        {
            const std::string body(70000, 'S');
            const fs::path p = scratchFile("good.zdb", body);
            std::string upper = digest(body);
            for (char &c : upper)
                c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
            const pf::Verdict v = pf::verifyPackage(p, body.size(), upper);
            t.IsTrue(v.ok, "accepted (the expected digest in either case): " + v.reason);
            t.Equals(v.sha256, digest(body), "the digest is reported lower-case");
            t.IsTrue(fs::exists(p), "and the file stays");
            std::error_code ec;
            fs::remove(p, ec);
        });

        tc.Run("verifyPackage: a wrong size is refused and deleted", [](TestCase &t)
        {
            const std::string body(70000, 'S');
            const fs::path p = scratchFile("short.zdb", body);
            const pf::Verdict v = pf::verifyPackage(p, body.size() + 1, digest(body));
            t.IsTrue(!v.ok, "refused");
            t.IsTrue(v.reason.find("70000") != std::string::npos, "the reason names the size: " + v.reason);
            t.IsTrue(!fs::exists(p), "and the file is gone");
        });

        tc.Run("verifyPackage: the right size with the wrong digest is refused and deleted", [](TestCase &t)
        {
            const std::string body(70000, 'S');
            const fs::path p = scratchFile("tampered.zdb", body);
            const pf::Verdict v = pf::verifyPackage(p, body.size(), digest(std::string(70000, 'T')));
            t.IsTrue(!v.ok, "refused");
            t.IsTrue(v.reason.find("sha256") != std::string::npos, "the reason names the digest: " + v.reason);
            t.IsTrue(!fs::exists(p), "and the file is gone");
        });

        tc.Run("verifyPackage: no file is a refusal", [](TestCase &t)
        {
            const pf::Verdict v = pf::verifyPackage(fs::temp_directory_path() / "ps2x_patch_fetch_tests" / "absent.zdb", 1, std::string(64, '0'));
            t.IsTrue(!v.ok, "refused");
        });
    });
}
