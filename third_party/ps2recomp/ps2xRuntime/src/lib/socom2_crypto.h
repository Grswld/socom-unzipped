// Host implementations of SOCOM II's rt_crypt RSA block transform and SHA-1 hash.
#pragma once
#include <cstdint>
#include <string>

struct R5900Context;
class PS2Runtime;

namespace socom2_crypto
{
    // PS2X_SOCOM2_LOGIN_TRACE's tail for one RC4 call: a message's class and type at counter 0, "(continues)" after it.
    std::string rc4TraceTail(uint32_t counter, const uint8_t *plain, uint32_t len);
    // Calls of the RC4 and SHA-1 hooks refused so far: a span outside guest RAM is neither read nor written.
    uint32_t spansRefused();
    void rsaBlock(uint8_t *rdram, R5900Context *ctx, PS2Runtime *);   // FUN_0062b948
    void sha1Hash(uint8_t *rdram, R5900Context *ctx, PS2Runtime *);   // FUN_0062eec0
    void rc4SetKeyHash(uint8_t *rdram, R5900Context *ctx, PS2Runtime *); // FUN_0062a638
    void rc4SetKey(uint8_t *rdram, R5900Context *ctx, PS2Runtime *);     // FUN_0062a5a8
    void rc4EncryptFn(uint8_t *rdram, R5900Context *ctx, PS2Runtime *);  // FUN_0062a720
    void rc4DecryptFn(uint8_t *rdram, R5900Context *ctx, PS2Runtime *);  // FUN_0062a7c8
}
