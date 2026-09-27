// SOCOM II rt_crypt primitives on the host.
//
// The SCERT layer (RT messages, 0x630690 encode / 0x630938 decode) hashes every message with a
// 4-byte SHA1 prefix (FUN_0062eec0) and encrypts the key exchange with 512-bit RSA
// (FUN_0062bbe0 -> FUN_0062bc10 -> FUN_0062b948 per 64-byte block, exponent LargeInt at 0x655570
// = 17 for the public operation, the private exponent for decryption). The recompiled bignum
// code produced ciphertext the server could not decrypt, so both primitives run on the host.
//
// LargeInt layout: little-endian bytes (64 bytes = 512 bits per block; the key buffers hold 64).
#include "socom2_crypto.h"
#include "ps2_runtime.h"
#include "ps2_runtime_macros.h"
#include "runtime/ps2_memory.h"

#include <array>
#include <cstdint>
#include <cstring>
#include <iostream>

#include "ps2_stubs.h"
#include "ps2x/knobs.h"
#include "socom2_rsa_key.h"

namespace socom2_crypto
{
    namespace
    {
        constexpr int kLimbs = 17;                    // 512 bits + one limb of headroom
        using Big = std::array<uint32_t, kLimbs>;

        Big load(const uint8_t *p)
        {
            Big b{};
            for (int i = 0; i < 16; ++i)
                b[i] = static_cast<uint32_t>(p[i * 4]) | (static_cast<uint32_t>(p[i * 4 + 1]) << 8) |
                       (static_cast<uint32_t>(p[i * 4 + 2]) << 16) | (static_cast<uint32_t>(p[i * 4 + 3]) << 24);
            return b;
        }

        void store(uint8_t *p, const Big &b)
        {
            for (int i = 0; i < 16; ++i)
            {
                p[i * 4] = static_cast<uint8_t>(b[i]);
                p[i * 4 + 1] = static_cast<uint8_t>(b[i] >> 8);
                p[i * 4 + 2] = static_cast<uint8_t>(b[i] >> 16);
                p[i * 4 + 3] = static_cast<uint8_t>(b[i] >> 24);
            }
        }

        int cmp(const Big &a, const Big &b)
        {
            for (int i = kLimbs - 1; i >= 0; --i)
                if (a[i] != b[i])
                    return a[i] < b[i] ? -1 : 1;
            return 0;
        }

        void sub(Big &a, const Big &b)
        {
            uint64_t borrow = 0;
            for (int i = 0; i < kLimbs; ++i)
            {
                uint64_t d = static_cast<uint64_t>(a[i]) - b[i] - borrow;
                a[i] = static_cast<uint32_t>(d);
                borrow = (d >> 32) ? 1u : 0u;
            }
        }

        void addMod(Big &a, const Big &b, const Big &n)
        {
            uint64_t carry = 0;
            for (int i = 0; i < kLimbs; ++i)
            {
                uint64_t s = static_cast<uint64_t>(a[i]) + b[i] + carry;
                a[i] = static_cast<uint32_t>(s);
                carry = s >> 32;
            }
            if (cmp(a, n) >= 0)
                sub(a, n);
        }

        void dblMod(Big &a, const Big &n)
        {
            uint32_t carry = 0;
            for (int i = 0; i < kLimbs; ++i)
            {
                uint32_t next = a[i] >> 31;
                a[i] = (a[i] << 1) | carry;
                carry = next;
            }
            if (cmp(a, n) >= 0)
                sub(a, n);
        }

        Big mulMod(const Big &a, const Big &b, const Big &n)
        {
            Big r{};
            for (int i = kLimbs - 1; i >= 0; --i)
            {
                for (int bit = 31; bit >= 0; --bit)
                {
                    dblMod(r, n);
                    if ((b[i] >> bit) & 1u)
                        addMod(r, a, n);
                }
            }
            return r;
        }

        Big powMod(const Big &base, const Big &exp, const Big &n)
        {
            Big result{};
            result[0] = 1;
            Big b = base;
            if (cmp(b, n) >= 0)
                sub(b, n);
            int top = kLimbs - 1;
            while (top > 0 && exp[top] == 0)
                --top;
            for (int i = top; i >= 0; --i)
            {
                for (int bit = 31; bit >= 0; --bit)
                {
                    result = mulMod(result, result, n);
                    if ((exp[i] >> bit) & 1u)
                        result = mulMod(result, b, n);
                }
            }
            return result;
        }

        // ---- SHA-1 -----------------------------------------------------------------------
        uint32_t rol(uint32_t v, int s) { return (v << s) | (v >> (32 - s)); }

        void sha1(const uint8_t *data, size_t len, uint8_t out[20])
        {
            uint32_t h0 = 0x67452301u, h1 = 0xEFCDAB89u, h2 = 0x98BADCFEu, h3 = 0x10325476u, h4 = 0xC3D2E1F0u;
            std::array<uint8_t, 64> block{};
            size_t processed = 0;
            auto compress = [&](const uint8_t *chunk)
            {
                uint32_t w[80];
                for (int i = 0; i < 16; ++i)
                    w[i] = (static_cast<uint32_t>(chunk[i * 4]) << 24) | (static_cast<uint32_t>(chunk[i * 4 + 1]) << 16) |
                           (static_cast<uint32_t>(chunk[i * 4 + 2]) << 8) | chunk[i * 4 + 3];
                for (int i = 16; i < 80; ++i)
                    w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
                uint32_t a = h0, b = h1, c = h2, d = h3, e = h4;
                for (int i = 0; i < 80; ++i)
                {
                    uint32_t f, k;
                    if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999u; }
                    else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1u; }
                    else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDCu; }
                    else { f = b ^ c ^ d; k = 0xCA62C1D6u; }
                    uint32_t t = rol(a, 5) + f + e + k + w[i];
                    e = d; d = c; c = rol(b, 30); b = a; a = t;
                }
                h0 += a; h1 += b; h2 += c; h3 += d; h4 += e;
            };
            while (len - processed >= 64)
            {
                compress(data + processed);
                processed += 64;
            }
            size_t rem = len - processed;
            std::memcpy(block.data(), data + processed, rem);
            block[rem] = 0x80;
            if (rem + 1 > 56)
            {
                compress(block.data());
                block.fill(0);
            }
            uint64_t bits = static_cast<uint64_t>(len) * 8u;
            for (int i = 0; i < 8; ++i)
                block[63 - i] = static_cast<uint8_t>(bits >> (8 * i));
            compress(block.data());
            const uint32_t hs[5] = {h0, h1, h2, h3, h4};
            for (int i = 0; i < 5; ++i)
            {
                out[i * 4] = static_cast<uint8_t>(hs[i] >> 24);
                out[i * 4 + 1] = static_cast<uint8_t>(hs[i] >> 16);
                out[i * 4 + 2] = static_cast<uint8_t>(hs[i] >> 8);
                out[i * 4 + 3] = static_cast<uint8_t>(hs[i]);
            }
        }
    }

    // FUN_0062b948(n, e, in, out): one 64-byte RSA block, out = in^e mod n.
    void rsaBlock(uint8_t *rdram, R5900Context *ctx, PS2Runtime *)
    {
        const uint32_t nAddr = GPR_U32(ctx, 4);
        const uint32_t eAddr = GPR_U32(ctx, 5);
        const uint32_t inAddr = GPR_U32(ctx, 6);
        const uint32_t outAddr = GPR_U32(ctx, 7);
        const Big n = load(rdram + (nAddr & PS2_RAM_MASK));
        const Big e = load(rdram + (eAddr & PS2_RAM_MASK));
        const Big m = load(rdram + (inAddr & PS2_RAM_MASK));
        const Big c = powMod(m, e, n);
        store(rdram + (outAddr & PS2_RAM_MASK), c);
        static int logged = 0;
        if (logged++ < 4)
            std::cout << "[socom2/crypto] RSA block e[0]=" << e[0] << " (host modexp)" << std::endl;
        ctx->pc = GPR_U32(ctx, 31);
    }

    // ---- rt_crypt RC4 variant (state: [0] byte count, [1] x, [2] y, +0x0c S[256]) ----------
    namespace
    {
        struct Rc4
        {
            uint8_t *base;
            uint8_t *S() { return base + 0x0c; }
            uint32_t &word(int i) { return *reinterpret_cast<uint32_t *>(base + i * 4); }
        };

        void rc4Init(Rc4 &st, const uint8_t *key, const uint8_t *hash)
        {
            uint8_t *S = st.S();
            for (int i = 0; i < 256; ++i)
                S[i] = static_cast<uint8_t>(~i);
            if (hash)
            {
                uint32_t li = 0, ci = 0, hi = 0;
                do
                {
                    const uint8_t t = S[ci];
                    li = (t + li + hash[hi]) & 0xff;
                    hi = (hi + 1) & 3;
                    S[ci] = S[li];
                    S[li] = t;
                    ci = (ci + 5) & 0xff;
                } while (ci != 0);
            }
            uint32_t li = 0, ci = 0, ki = 0;
            do
            {
                const uint8_t t = S[ci];
                li = (t + li + key[ki]) & 0xff;
                ki = (ki + 1) & 0x3f;
                S[ci] = S[li];
                S[li] = t;
                ci = (ci + 3) & 0xff;
            } while (ci != 0);
            st.word(0) = 0;
            st.word(1) = 0;
            st.word(2) = 0;
        }

        // FUN_0062a720: encrypt in place.
        void rc4Encrypt(Rc4 &st, uint8_t *data, uint32_t len)
        {
            uint8_t *S = st.S();
            uint32_t x = st.base[4], y = st.base[8];
            for (uint32_t i = 0; i < len; ++i)
            {
                x = (x + 5) & 0xff;
                const uint8_t t = S[x];
                y = (y + t) & 0xff;
                S[x] = S[y];
                S[y] = t;
                const uint8_t plain = data[i];
                y = (y + S[plain]) & 0xff;
                data[i] = plain ^ S[(S[x] + t) & 0xff];
            }
            st.word(1) = x;
            st.word(2) = y;
            st.word(0) += len;
        }

        // FUN_0062a7c8: decrypt in place.
        void rc4Decrypt(Rc4 &st, uint8_t *data, uint32_t len)
        {
            uint8_t *S = st.S();
            uint32_t x = st.base[4], y = st.base[8];
            for (uint32_t i = 0; i < len; ++i)
            {
                x = (x + 5) & 0xff;
                const uint8_t t = S[x];
                y = (y + t) & 0xff;
                S[x] = S[y];
                S[y] = t;
                const uint8_t plain = data[i] ^ S[(S[x] + t) & 0xff];
                data[i] = plain;
                y = (y + S[plain]) & 0xff;
            }
            st.word(1) = x;
            st.word(2) = y;
            st.word(0) += len;
        }
    }

    namespace
    {
        // Sprint 16 L1b (#73; the L1 design note, section 1): whether the RC4 seams carry whole messages is inferred,
        // not observed, so this Dev trace logs what each call sees -- the state's guest address, its byte counter
        // (word 0: zeroed by rc4Init, advanced by every call) and, for a call opening a message (the counter at 0),
        // the class and type bytes and the length. Never a field: no name, no password, no key.
        bool loginTraceOn()
        {
            static const bool on = ps2x::knob("PS2X_SOCOM2_LOGIN_TRACE") != nullptr;
            return on;
        }

        void traceRc4(const char *what, uint32_t stateAddr, uint32_t counter, const uint8_t *plain, uint32_t len)
        {
            std::cout << "[login-trace] " << what << " state=0x" << std::hex << stateAddr << std::dec << " counter=" << counter
                      << " len=" << len;
            if (counter == 0 && len >= 2)
                std::cout << " class=0x" << std::hex << static_cast<unsigned>(plain[0]) << " type=0x" << static_cast<unsigned>(plain[1])
                          << std::dec;
            else
                std::cout << " (continues)";
            std::cout << std::endl;
        }
    }

    void rc4SetKeyHash(uint8_t *rdram, R5900Context *ctx, PS2Runtime *)    // FUN_0062a638(state, key, hash)
    {
        Rc4 st{rdram + (GPR_U32(ctx, 4) & PS2_RAM_MASK)};
        if (loginTraceOn())
            std::cout << "[login-trace] rc4SetKeyHash state=0x" << std::hex << (GPR_U32(ctx, 4) & PS2_RAM_MASK) << std::dec << std::endl;
        const uint32_t hashWord = GPR_U32(ctx, 6);
        uint8_t hash[4];
        std::memcpy(hash, &hashWord, 4);
        rc4Init(st, rdram + (GPR_U32(ctx, 5) & PS2_RAM_MASK), hash);
        ctx->pc = GPR_U32(ctx, 31);
    }

    void rc4SetKey(uint8_t *rdram, R5900Context *ctx, PS2Runtime *)        // FUN_0062a5a8(state, key)
    {
        Rc4 st{rdram + (GPR_U32(ctx, 4) & PS2_RAM_MASK)};
        if (loginTraceOn())
            std::cout << "[login-trace] rc4SetKey state=0x" << std::hex << (GPR_U32(ctx, 4) & PS2_RAM_MASK) << std::dec << std::endl;
        rc4Init(st, rdram + (GPR_U32(ctx, 5) & PS2_RAM_MASK), nullptr);
        ctx->pc = GPR_U32(ctx, 31);
    }

    void rc4EncryptFn(uint8_t *rdram, R5900Context *ctx, PS2Runtime *)     // FUN_0062a720(state, data, len)
    {
        const uint32_t stateAddr = GPR_U32(ctx, 4) & PS2_RAM_MASK;
        Rc4 st{rdram + stateAddr};
        uint8_t *data = rdram + (GPR_U32(ctx, 5) & PS2_RAM_MASK);
        const uint32_t len = GPR_U32(ctx, 6);
        if (loginTraceOn())
            traceRc4("encrypt", stateAddr, st.word(0), data, len);   // the plain bytes, before the cipher
        rc4Encrypt(st, data, len);
        ctx->pc = GPR_U32(ctx, 31);
    }

    void rc4DecryptFn(uint8_t *rdram, R5900Context *ctx, PS2Runtime *)     // FUN_0062a7c8(state, data, len)
    {
        const uint32_t stateAddr = GPR_U32(ctx, 4) & PS2_RAM_MASK;
        Rc4 st{rdram + stateAddr};
        uint8_t *data = rdram + (GPR_U32(ctx, 5) & PS2_RAM_MASK);
        const uint32_t len = GPR_U32(ctx, 6);
        const uint32_t counter = st.word(0);
        rc4Decrypt(st, data, len);
        if (loginTraceOn())
            traceRc4("decrypt", stateAddr, counter, data, len);   // the plain bytes, after the cipher
        ctx->pc = GPR_U32(ctx, 31);
    }

    // FUN_0062eec0(data, len, out, outLen): SHA-1 digest prefix.
    void sha1Hash(uint8_t *rdram, R5900Context *ctx, PS2Runtime *)
    {
        const uint32_t data = GPR_U32(ctx, 4);
        const uint32_t len = GPR_U32(ctx, 5);
        const uint32_t out = GPR_U32(ctx, 6);
        const uint32_t outLen = GPR_U32(ctx, 7);
        uint8_t digest[20];
        sha1(rdram + (data & PS2_RAM_MASK), len, digest);
        std::memcpy(rdram + (out & PS2_RAM_MASK), digest, outLen > 20u ? 20u : outLen);
        ctx->pc = GPR_U32(ctx, 31);
    }
}

// Moved here from game_overrides_socom2.cpp by Sprint 13 Task C8 (it is rt_crypt's, and the test binary now links
// it rather than a stand-in; socom2_crypto_tests.cpp checks both precomputed pairs are real RSA pairs).
// Bound at recompile time via recomp/socom2.toml: "socom2_RsaGenerateKeyPair@0x0062B168".
// rt_crypt FUN_0062b168(LargeInt *n, LargeInt *d) generates a 512-bit RSA key pair with two random
// 256-bit primes (e = 17); the prime search takes minutes under recompiled code and a fixed key
// pair is equivalent for a private server, so the precomputed limbs are written instead.
namespace ps2_stubs
{
    void socom2_RsaGenerateKeyPair(uint8_t *rdram, R5900Context *ctx, PS2Runtime *)
    {
        const uint32_t nAddr = GPR_U32(ctx, 4);
        const uint32_t dAddr = GPR_U32(ctx, 5);
        // PS2X_SOCOM2_RSA_KEY=b selects the second precomputed pair: two instances of the exe on
        // one host otherwise publish the *same* public key in their DME 0x18 client record, while
        // two PCSX2 clients publish distinct random keys (server/logs/console-DME.log).
        const char *keyEnv = ps2x::knob("PS2X_SOCOM2_RSA_KEY");
        const bool keyB = keyEnv && (*keyEnv == 'b' || *keyEnv == 'B' || *keyEnv == '1');
        std::memcpy(rdram + (nAddr & PS2_RAM_MASK), keyB ? kSocom2RsaNb : kSocom2RsaN, sizeof(kSocom2RsaN));
        std::memcpy(rdram + (dAddr & PS2_RAM_MASK), keyB ? kSocom2RsaDb : kSocom2RsaD, sizeof(kSocom2RsaD));
        std::cout << "[socom2] rt_crypt RSA key pair -> fixed precomputed key " << (keyB ? "B" : "A") << std::endl;
        ctx->pc = GPR_U32(ctx, 31);
    }
}
