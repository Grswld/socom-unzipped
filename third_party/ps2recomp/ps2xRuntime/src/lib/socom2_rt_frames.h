// Sprint 16 L1b (#73): the RT (SCERT) frames on one TCP descriptor, cut as Horizon cuts them -- so socom2_hostnet can
// hand the persona recorder a login response the server sent PLAIN (MAS and MLS with EnableEncryption false: the seam
// reading, logs/l1b_seam_reading.md, section 4), which the RC4 seam never sees.
//
// A frame (server/horizon-server/RT.Models/BaseScertMessage.cs Serialize; Server.Pipeline/Tcp/ScertTcpFrameDecoder.cs
// Decode): the id, its 0x80 bit set when the body is RC4; the body's length, 16 bits little-endian; for an encrypted
// frame with a body, a 4-byte hash the length does not count; then the body. Only a plain RT_MSG_SERVER_APP body within
// MEDIUS_MESSAGE_MAXLEN (the server fragments a longer one) is ever kept; every other body is passed over by its count,
// so the carry never holds more than one such body and the walk stays in step past any length. Nothing is decrypted,
// no key is held, and describe() prints the head alone -- class and type only for a plain app frame, never a field.
#pragma once
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace socom2_rt
{
    constexpr uint8_t kEncrypted = 0x80;            // the id's top bit
    constexpr uint8_t kServerApp = 0x0A;            // RT_MSG_SERVER_APP (RT.Common/Types.cs)
    constexpr uint8_t kClientAppToServer = 0x0B;    // RT_MSG_CLIENT_APP_TOSERVER
    constexpr std::size_t kHeadBytes = 3;           // BaseScertMessage.HEADER_SIZE
    constexpr std::size_t kHashBytes = 4;           // BaseScertMessage.HASH_SIZE
    constexpr std::size_t kAppMostBytes = 512;      // Constants.MEDIUS_MESSAGE_MAXLEN

    struct Frame
    {
        uint8_t id = 0;                  // as on the wire, the 0x80 bit included
        uint16_t len = 0;                // the length field: the body alone
        uint8_t lead[2] = {0, 0};        // a plain frame's first two body bytes (an app frame's class and type)
        std::size_t leadHave = 0;
        bool kept = false;               // a plain SERVER_APP within the cap, when the walk keeps them
        const uint8_t *body = nullptr;   // then its whole body, valid during the callback only
    };

    // One descriptor, one direction; a default Carry is a stream's start (socom2_hostnet resets it at closeSocket).
    struct Carry
    {
        uint8_t head[kHeadBytes + kHashBytes] = {};
        std::size_t headHave = 0;
        std::size_t bodyLeft = 0;
        bool inBody = false;
        Frame frame;                     // the frame in hand
        std::vector<uint8_t> kept;       // its body, when it is kept
    };

    // Walks `n` more bytes of the stream and calls onFrame(const Frame &) at each frame's last byte, in order.
    // keepServerApp: gather plain SERVER_APP bodies (the receive side); the send side keeps nothing.
    template <typename OnFrame>
    void splitRtFrames(Carry &c, const uint8_t *data, std::size_t n, bool keepServerApp, OnFrame &&onFrame)
    {
        std::size_t i = 0;
        while (i < n)   // a head completed by the chunk's last byte falls through: a 0-length frame is emitted at once
        {
            if (!c.inBody)
            {
                c.head[c.headHave++] = data[i++];
                if (c.headHave < kHeadBytes)
                    continue;
                const uint8_t id = c.head[0];
                const uint16_t len = static_cast<uint16_t>(c.head[1] | (c.head[2] << 8));
                if (c.headHave < kHeadBytes + ((id & kEncrypted) != 0 && len > 0 ? kHashBytes : 0))
                    continue;
                c.headHave = 0;
                c.frame = Frame{};
                c.frame.id = id;
                c.frame.len = len;
                c.frame.kept = keepServerApp && id == kServerApp && len <= kAppMostBytes;
                c.kept.clear();
                if (c.frame.kept)
                    c.kept.reserve(len);
                c.bodyLeft = len;
                c.inBody = true;
            }
            const std::size_t take = std::min(c.bodyLeft, n - i);
            for (std::size_t k = 0; k < take && c.frame.leadHave < 2 && (c.frame.id & kEncrypted) == 0; ++k)
                c.frame.lead[c.frame.leadHave++] = data[i + k];
            if (c.frame.kept)
                c.kept.insert(c.kept.end(), data + i, data + i + take);
            i += take;
            c.bodyLeft -= take;
            if (c.bodyLeft != 0)
                break;
            c.inBody = false;
            c.frame.body = c.frame.kept ? c.kept.data() : nullptr;
            onFrame(static_cast<const Frame &>(c.frame));
            c.kept.clear();
        }
    }

    // The trace's view of a frame head: the id with its 0x80 bit, the length, and a plain app frame's class and type.
    inline std::string describe(const Frame &f)
    {
        char out[80];
        const bool app = (f.id == kServerApp || f.id == kClientAppToServer) && f.leadHave == 2;
        if (app)
            std::snprintf(out, sizeof out, "id=0x%02x plain len=%u class=0x%x type=0x%x", f.id, unsigned(f.len), unsigned(f.lead[0]),
                          unsigned(f.lead[1]));
        else
            std::snprintf(out, sizeof out, "id=0x%02x %s len=%u", f.id, (f.id & kEncrypted) != 0 ? "encrypted" : "plain", unsigned(f.len));
        return out;
    }
}
