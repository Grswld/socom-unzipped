// Sprint 13 Task C8 (audit F9): socom2_crypto.cpp -- rt_crypt's SHA-1, RC4 and RSA on the host -- against published
// and independent vectors. Online login rests on all three.
//
//   SHA-1: FIPS 180's own examples ("abc", the 56-character two-block message, one million 'a'), the empty message,
//          and the digest prefix the RT layer asks for (outLen 4).
//   RC4:   NOT RFC 6229's. rt_crypt's cipher is a Medius variant, not RC4: the state starts S[i] = 255 - i, the key is
//          always 64 bytes (index & 0x3f) with a stride of 3, an optional 4-byte hash is mixed first with a stride of 5,
//          the stream index steps by 5 and the plaintext byte feeds back into j. RFC 6229's keystreams (key 0102030405
//          and the rest) cannot come out of it by construction, so the independent reference is the server the game
//          logs in to: Horizon's RT.Cryptography PS2_RC4 (research/horizon-server/RT.Cryptography/RC/PS2_RC4.cs), whose
//          SetKey/Encrypt/Decrypt, copied verbatim into a C# console program on 2026-09-25 (dotnet 10), produced the two
//          ciphertexts below. A client that disagreed with them could not talk to the server.
//   RSA:   the textbook pair (n = 3233, e = 17: 65 -> 2790), and both precomputed 512-bit key pairs the port hands the
//          game (socom2_rsa_key.h) checked as real pairs: m^17 mod N then ^D mod N gives m back; key A's ciphertext for
//          one message pinned from Python's pow().
// Documentation of behaviour with published vectors, not a defect's RED: the implementations matched every vector
// when they were checked (a Python transliteration of this file's RC4 against the C# output, before the build).
#include "MiniTest.h"
#include "ps2_runtime.h"
#include "ps2_runtime_macros.h"
#include "ps2_stubs.h"
#include "runtime/ps2_memory.h"
#include "socom2_crypto.h"
#include "socom2_rsa_key.h"

#include <cstdint>
#include <cstring>
#include <functional>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace
{
    constexpr uint32_t kRa = 0x0062c000u;

    using Handler = void (*)(uint8_t *, R5900Context *, PS2Runtime *);

    struct Guest
    {
        // Guest RAM plus a watched margin past its end (the span bounds' cases fill it and check it).
        static constexpr uint32_t kMargin = 0x1000u;
        std::vector<uint8_t> rdram = std::vector<uint8_t>(PS2_RAM_SIZE + kMargin, 0u);
        R5900Context ctx{};

        void call(Handler fn, uint32_t a0, uint32_t a1, uint32_t a2 = 0u, uint32_t a3 = 0u)
        {
            SET_GPR_U32(&ctx, 4, a0);
            SET_GPR_U32(&ctx, 5, a1);
            SET_GPR_U32(&ctx, 6, a2);
            SET_GPR_U32(&ctx, 7, a3);
            SET_GPR_U32(&ctx, 31, kRa);
            ctx.pc = 0u;
            fn(rdram.data(), &ctx, nullptr);
        }

        void put(uint32_t addr, const void *p, size_t n) { std::memcpy(rdram.data() + addr, p, n); }
        std::vector<uint8_t> get(uint32_t addr, size_t n) const
        {
            return std::vector<uint8_t>(rdram.begin() + addr, rdram.begin() + addr + n);
        }
    };

    std::vector<uint8_t> fromHex(const std::string &hex)
    {
        std::vector<uint8_t> out;
        for (size_t i = 0; i + 1 < hex.size(); i += 2)
            out.push_back(static_cast<uint8_t>(std::stoul(hex.substr(i, 2), nullptr, 16)));
        return out;
    }

    // sha1Hash(data, len, out, outLen) on a message placed at 0x100000.
    std::vector<uint8_t> sha1Of(Guest &g, const std::string &msg, uint32_t outLen = 20u)
    {
        constexpr uint32_t kData = 0x00100000u, kOut = 0x00001000u;
        g.put(kData, msg.data(), msg.size());
        std::memset(g.rdram.data() + kOut, 0xCC, 32);
        g.call(socom2_crypto::sha1Hash, kData, static_cast<uint32_t>(msg.size()), kOut, outLen);
        return g.get(kOut, 21);
    }

    // The RC4 known-answer setup: key[i] = i (64 bytes), the plaintext below, hash bytes 12 34 56 78.
    constexpr uint32_t kState = 0x00002000u;   // [0] byte count, [1] x, [2] y, +0x0c S[256]
    constexpr uint32_t kKey = 0x00003000u;
    constexpr uint32_t kData = 0x00004000u;
    const std::string kPlain = "SOCOM II rt_crypt known answer!!";   // 32 bytes
    const char *const kCipherHash = "b02baad4887de912ba7c98c75f378b4e0dc3c6246d2c743178639032bbb971b2";
    const char *const kCipherNoHash = "22a65cc432a2b780a68e474e5d215c6c0e07458526508e225a3d458fcb08d128";
    // rc4SetKeyHash takes the hash as a register word; its bytes in memory order are 12 34 56 78.
    constexpr uint32_t kHashWord = 0x78563412u;

    void keyUp(Guest &g, bool withHash)
    {
        uint8_t key[64];
        for (int i = 0; i < 64; ++i)
            key[i] = static_cast<uint8_t>(i);
        g.put(kKey, key, sizeof(key));
        if (withHash)
            g.call(socom2_crypto::rc4SetKeyHash, kState, kKey, kHashWord);
        else
            g.call(socom2_crypto::rc4SetKey, kState, kKey);
    }

    std::vector<uint8_t> limbsToBytes(const uint32_t *limbs, int count)
    {
        std::vector<uint8_t> out(static_cast<size_t>(count) * 4u);
        std::memcpy(out.data(), limbs, out.size());   // little-endian host, as the guest
        return out;
    }

    // rsaBlock(n, e, in, out): out = in^e mod n, 64-byte little-endian LargeInts.
    std::vector<uint8_t> rsa(Guest &g, const std::vector<uint8_t> &n, const std::vector<uint8_t> &e, const std::vector<uint8_t> &m)
    {
        constexpr uint32_t kN = 0x00010000u, kE = 0x00010100u, kIn = 0x00010200u, kOutAddr = 0x00010300u;
        std::vector<uint8_t> pad(64, 0u);
        g.put(kN, pad.data(), 64);
        g.put(kE, pad.data(), 64);
        g.put(kIn, pad.data(), 64);
        g.put(kN, n.data(), n.size() < 64 ? n.size() : 64);
        g.put(kE, e.data(), e.size() < 64 ? e.size() : 64);
        g.put(kIn, m.data(), m.size() < 64 ? m.size() : 64);
        g.call(socom2_crypto::rsaBlock, kN, kE, kIn, kOutAddr);
        return g.get(kOutAddr, 64);
    }

    std::vector<uint8_t> word(uint32_t v)
    {
        return limbsToBytes(&v, 1);
    }
}

void register_socom2_crypto_tests()
{
    MiniTest::Case("SOCOM2Crypto", [](TestCase &tc)
    {
        tc.Run("SHA-1 matches FIPS 180's examples", [](TestCase &t)
        {
            Guest g;
            t.IsTrue(sha1Of(g, "abc") == [] { auto v = fromHex("a9993e364706816aba3e25717850c26c9cd0d89d"); v.push_back(0xCC); return v; }(),
                     "\"abc\" -> a9993e36 4706816a ba3e2571 7850c26c 9cd0d89d, and nothing past the 20 bytes");
            t.IsTrue(sha1Of(g, "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq") ==
                         [] { auto v = fromHex("84983e441c3bd26ebaae4aa1f95129e5e54670f1"); v.push_back(0xCC); return v; }(),
                     "the 56-character message (two blocks: the length does not fit the first) -> 84983e44 ... e54670f1");
            t.Equals(g.ctx.pc, kRa, "pc = $ra");
        });

        tc.Run("SHA-1 of one million 'a' and of the empty message", [](TestCase &t)
        {
            Guest g;
            const std::vector<uint8_t> million = sha1Of(g, std::string(1000000u, 'a'));
            t.IsTrue(std::vector<uint8_t>(million.begin(), million.begin() + 20) == fromHex("34aa973cd4c4daa4f61eeb2bdbad27316534016f"),
                     "FIPS 180's third example -> 34aa973c d4c4daa4 f61eeb2b dbad2731 6534016f");
            Guest e;
            const std::vector<uint8_t> empty = sha1Of(e, std::string());
            t.IsTrue(std::vector<uint8_t>(empty.begin(), empty.begin() + 20) == fromHex("da39a3ee5e6b4b0d3255bfef95601890afd80709"),
                     "the empty message -> da39a3ee ... afd80709");
        });

        tc.Run("SHA-1 writes only the prefix the caller asks for", [](TestCase &t)
        {
            Guest g;
            const std::vector<uint8_t> out = sha1Of(g, "abc", 4u);
            t.IsTrue(std::vector<uint8_t>(out.begin(), out.begin() + 4) == fromHex("a9993e36"), "the first four digest bytes");
            t.Equals(static_cast<unsigned>(out[4]), 0xCCu, "nothing past outLen (the RT layer's 4-byte hash)");
            Guest h;
            const std::vector<uint8_t> capped = sha1Of(h, "abc", 64u);
            t.Equals(static_cast<unsigned>(capped[20]), 0xCCu, "an outLen past 20 still writes 20 bytes");
        });

        tc.Run("RC4 with a hash matches Horizon's PS2_RC4 known answer", [](TestCase &t)
        {
            Guest g;
            keyUp(g, true);
            t.Equals(g.ctx.pc, kRa, "SetKeyHash: pc = $ra");
            g.put(kData, kPlain.data(), kPlain.size());
            g.call(socom2_crypto::rc4EncryptFn, kState, kData, static_cast<uint32_t>(kPlain.size()));
            t.IsTrue(g.get(kData, 32) == fromHex(kCipherHash), "encrypt in place == Horizon's ciphertext (hash 12345678)");
            uint32_t count = 0;
            std::memcpy(&count, g.rdram.data() + kState, 4);
            t.Equals(count, 32u, "state[0] counts the bytes processed");

            Guest d;
            keyUp(d, true);
            d.put(kData, fromHex(kCipherHash).data(), 32);
            d.call(socom2_crypto::rc4DecryptFn, kState, kData, 32u);
            t.IsTrue(d.get(kData, 32) == std::vector<uint8_t>(kPlain.begin(), kPlain.end()), "decrypt of Horizon's ciphertext == the plaintext");
        });

        tc.Run("RC4 without a hash matches Horizon's PS2_RC4 known answer", [](TestCase &t)
        {
            Guest g;
            keyUp(g, false);
            g.put(kData, kPlain.data(), kPlain.size());
            g.call(socom2_crypto::rc4EncryptFn, kState, kData, static_cast<uint32_t>(kPlain.size()));
            t.IsTrue(g.get(kData, 32) == fromHex(kCipherNoHash), "encrypt in place == Horizon's ciphertext (no hash)");
        });

        tc.Run("RC4 keeps its stream position across calls", [](TestCase &t)
        {
            Guest g;
            keyUp(g, true);
            g.put(kData, kPlain.data(), kPlain.size());
            g.call(socom2_crypto::rc4EncryptFn, kState, kData, 10u);
            g.call(socom2_crypto::rc4EncryptFn, kState, kData + 10u, 22u);
            t.IsTrue(g.get(kData, 32) == fromHex(kCipherHash), "10 + 22 bytes == 32 at once (x and y live in the state)");
        });

        tc.Run("RSA: the textbook pair", [](TestCase &t)
        {
            Guest g;
            const std::vector<uint8_t> c = rsa(g, word(3233u), word(17u), word(65u));
            std::vector<uint8_t> expected(64, 0u);
            const std::vector<uint8_t> w = word(2790u);
            std::memcpy(expected.data(), w.data(), 4);
            t.IsTrue(c == expected, "65^17 mod 3233 = 2790");
            t.Equals(g.ctx.pc, kRa, "pc = $ra");
            Guest h;
            std::vector<uint8_t> back = rsa(h, word(3233u), word(2753u), word(2790u));
            std::vector<uint8_t> m(64, 0u);
            m[0] = 65u;
            t.IsTrue(back == m, "2790^2753 mod 3233 = 65 (the private exponent)");
        });

        tc.Run("RSA: both precomputed key pairs are real pairs", [](TestCase &t)
        {
            std::vector<uint8_t> m(64);
            for (int i = 0; i < 64; ++i)
                m[static_cast<size_t>(i)] = static_cast<uint8_t>(i + 1);   // < N: N's top bit is set, m's top byte is 0x40
            const std::vector<uint8_t> e = word(17u);
            for (int which = 0; which < 2; ++which)
            {
                const uint32_t *n = which ? kSocom2RsaNb : kSocom2RsaN;
                const uint32_t *d = which ? kSocom2RsaDb : kSocom2RsaD;
                bool upperZero = true;
                for (int i = 16; i < 32; ++i)
                    upperZero = upperZero && n[i] == 0u && d[i] == 0u;
                t.IsTrue(upperZero, "limbs 16..31 are zero: a 512-bit key in the 64 bytes rsaBlock reads");
                t.IsTrue((n[15] >> 31) == 1u, "a full 512-bit N (the RC4 session key never exceeds it)");
                Guest g;
                const std::vector<uint8_t> c = rsa(g, limbsToBytes(n, 16), e, m);
                t.IsTrue(c != m, "the ciphertext is not the message");
                if (which == 0)
                    t.IsTrue(c == fromHex("e2e65d516a54d33eb514077d9f22b7c7b7c33f0f45ffb057a01758bbd5c0b91f"
                                          "ca703c87d5ce2611104a9bcc14938ff76e0ef3b924f32cdfc34cc6f8b26a744b"),
                             "key A: m^17 mod N == Python's pow(m, 17, N)");
                Guest h;
                t.IsTrue(rsa(h, limbsToBytes(n, 16), limbsToBytes(d, 16), c) == m, "c^D mod N == m");
            }
        });

        tc.Run("the key-pair stub writes key A's limbs and returns to the caller", [](TestCase &t)
        {
            Guest g;
            constexpr uint32_t kNAddr = 0x00020000u, kDAddr = 0x00020100u;
            g.call(ps2_stubs::socom2_RsaGenerateKeyPair, kNAddr, kDAddr);
            t.Equals(g.ctx.pc, kRa, "pc = $ra");
            t.IsTrue(std::memcmp(g.rdram.data() + kNAddr, kSocom2RsaN, sizeof(kSocom2RsaN)) == 0, "N = key A's (PS2X_SOCOM2_RSA_KEY unset)");
            t.IsTrue(std::memcmp(g.rdram.data() + kDAddr, kSocom2RsaD, sizeof(kSocom2RsaD)) == 0, "D = key A's");
        });
    });

    // The RC4 and SHA-1 hooks work on guest RAM in place, over a length the caller's register gives. A span that does not
    // lie inside guest RAM is refused: nothing is read, nothing written, one log line.
    MiniTest::Case("SOCOM2CryptoBounds", [](TestCase &tc)
    {
        auto fillMargin = [](Guest &g) { std::memset(g.rdram.data() + PS2_RAM_SIZE, 0xA5, Guest::kMargin); };
        auto marginUntouched = [](const Guest &g)
        {
            for (uint32_t i = 0; i < Guest::kMargin; ++i)
                if (g.rdram[PS2_RAM_SIZE + i] != 0xA5)
                    return false;
            return true;
        };
        auto capture = [](const std::function<void()> &body)
        {
            std::ostringstream sink;
            std::streambuf *old = std::cout.rdbuf(sink.rdbuf());
            body();
            std::cout.rdbuf(old);
            return sink.str();
        };

        tc.Run("RC4 refuses a span past the end of guest RAM", [=](TestCase &t)
        {
            const Handler fns[] = {socom2_crypto::rc4EncryptFn, socom2_crypto::rc4DecryptFn};
            for (Handler fn : fns)
            {
                Guest g;
                keyUp(g, true);
                fillMargin(g);
                const std::vector<uint8_t> state = g.get(kState, 0x10c);
                const uint32_t before = socom2_crypto::spansRefused();
                const std::string out = capture([&] { g.call(fn, kState, PS2_RAM_SIZE - 0x10u, 0x40u); });
                t.IsTrue(marginUntouched(g), "nothing is written past the end of guest RAM");
                t.IsTrue(g.get(PS2_RAM_SIZE - 0x10u, 0x10) == std::vector<uint8_t>(0x10, 0u), "the bytes inside RAM are untouched too");
                t.IsTrue(g.get(kState, 0x10c) == state, "the cipher state does not advance");
                t.Equals(g.ctx.pc, kRa, "pc = $ra");
                t.Equals(socom2_crypto::spansRefused(), before + 1u, "the refusal is counted");
                t.IsTrue(out.find("bounded") != std::string::npos && out.find("64") != std::string::npos,
                         "one line names the hook and the length: " + out);
            }
        });

        tc.Run("SHA-1 refuses a span past the end of guest RAM", [=](TestCase &t)
        {
            Guest g;
            fillMargin(g);
            constexpr uint32_t kOut = 0x00001000u;
            std::memset(g.rdram.data() + kOut, 0xCC, 32);
            const std::string out = capture([&] { g.call(socom2_crypto::sha1Hash, PS2_RAM_SIZE - 0x10u, 0x40u, kOut, 4u); });
            t.IsTrue(g.get(kOut, 4) == std::vector<uint8_t>(4, 0xCC), "no digest is written");
            t.Equals(g.ctx.pc, kRa, "pc = $ra");
            t.IsTrue(out.find("sha1Hash bounded") != std::string::npos && out.find("64") != std::string::npos,
                     "one line names the hook and the length: " + out);
            Guest h;
            fillMargin(h);
            capture([&] { h.call(socom2_crypto::sha1Hash, 0x00100000u, 4u, PS2_RAM_SIZE - 2u, 20u); });
            t.IsTrue(marginUntouched(h), "a digest that would land past the end of guest RAM is not written");
        });

        tc.Run("RC4 and SHA-1 on a span that ends exactly at the end of guest RAM still run", [=](TestCase &t)
        {
            Guest g;
            keyUp(g, true);
            fillMargin(g);
            const uint32_t at = PS2_RAM_SIZE - 32u;
            g.put(at, kPlain.data(), kPlain.size());
            const uint32_t before = socom2_crypto::spansRefused();
            g.call(socom2_crypto::rc4EncryptFn, kState, at, 32u);
            t.IsTrue(g.get(at, 32) == fromHex(kCipherHash), "the same ciphertext as anywhere else in RAM");
            t.IsTrue(marginUntouched(g), "and nothing past the end");
            Guest h;
            const std::string abc = "abc";
            h.put(PS2_RAM_SIZE - 3u, abc.data(), 3);
            h.call(socom2_crypto::sha1Hash, PS2_RAM_SIZE - 3u, 3u, 0x00001000u, 20u);
            t.IsTrue(h.get(0x00001000u, 20) == fromHex("a9993e364706816aba3e25717850c26c9cd0d89d"), "SHA-1 of abc at the top of RAM");
            t.Equals(socom2_crypto::spansRefused(), before, "nothing refused");
        });
    });
}
