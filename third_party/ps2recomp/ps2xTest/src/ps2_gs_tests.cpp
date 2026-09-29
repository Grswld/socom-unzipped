#include "MiniTest.h"
#include "runtime/ps2_memory.h"
#include "ps2_runtime.h"
#include "ps2_stubs.h"
#include "ps2_syscalls.h"
#include "runtime/gs/gs_frontend.h"
#include "runtime/gs/gs_cpu_backend.h"
#include "runtime/gs/gs_gl_backend.h"   // Sprint 16 F2: glUnavailableForProcess() for the planted read-back scene
#include "runtime/ee_scheduler.h"
#include "runtime/gs/ps2_gs_memory.h"
#include "runtime/gs/ps2_gs_psmct32.h"
#include "runtime/gs/ps2_gs_psmt4.h"
#include "runtime/gs/ps2_gs_psmt8.h"
#include "runtime/gs/gs_gl_depth.h"
#include "runtime/gs/gs_gl_caps.h"
#include "runtime/gs/gs_gl_target_extent.h"
#include "runtime/gs/gs_gl_upload_trace.h"
#include "runtime/gs/gs_gl_upload_identity.h"
#include "runtime/gs/gs_gl_upload_reasons.h"
#include "runtime/gs/gs_frame_histogram.h"
#include "runtime/gs/gs_gl_texture_identity.h"
#include "runtime/gs/gs_gl_state_tags.h"
#include "Stubs/Helpers/Support.h"
#include "Stubs/GS.h"

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <set>
#include "raylib.h"
#include "runtime/socom2_lum_readback.h"
#include "runtime/socom2_cull_trace.h"
#include "runtime/gs/gs_cpu_backend.h"
#include <string>
#include <thread>
#include <vector>

using namespace ps2_syscalls;

namespace
{
    std::atomic<uint32_t> g_gsSyncCallbackHits{0u};
    std::atomic<uint32_t> g_gsSyncCallbackLastTick{0u};
    std::atomic<int32_t> g_gsSyncFirstField{-1};
    std::atomic<int32_t> g_gsSyncSecondField{-1};
    std::atomic<uint32_t> g_gsSyncCallbackSp{0u};
    std::atomic<uint32_t> g_gsSyncCallbackGp{0u};
    std::atomic<uint32_t> g_gsSyncCallbackPrevious{0u};

    constexpr uint32_t kGsSyncWait0Pc = 0x0011F000u;
    constexpr uint32_t kGsSyncResume0Pc = 0x0011F010u;
    constexpr uint32_t kGsSyncWait1Pc = 0x0011F020u;
    constexpr uint32_t kGsSyncResume1Pc = 0x0011F030u;
    constexpr uint32_t kGsCallbackMainPc = 0x0011F040u;
    constexpr uint32_t kGsCallbackResumePc = 0x0011F050u;
    constexpr uint32_t kGsCallbackPc = 0x00120000u;
    constexpr uint32_t kGsCallbackGp = 0x0036A7F0u;
    constexpr uint32_t kGsCallbackCallerSp = 0x00123450u;

    static_assert(sizeof(GsImageMem) == 12, "GsImageMem size mismatch");

    void setRegU32(R5900Context &ctx, int reg, uint32_t value)
    {
        ctx.r[reg] = _mm_set_epi64x(0, static_cast<int64_t>(value));
    }

    void setRegU64(R5900Context &ctx, int reg, uint64_t value)
    {
        ctx.r[reg] = _mm_set_epi64x(0, static_cast<int64_t>(value));
    }

    uint32_t getRegU32Test(const R5900Context &ctx, int reg)
    {
        return ::getRegU32(&ctx, reg);
    }

    uint64_t getReturnU64(const R5900Context &ctx)
    {
        const uint64_t lo = static_cast<uint64_t>(getRegU32Test(ctx, 2));
        const uint64_t hi = static_cast<uint64_t>(getRegU32Test(ctx, 3));
        return lo | (hi << 32);
    }

    uint64_t makeGifTag(uint16_t nloop, uint8_t flg, uint8_t nreg, bool eop = true)
    {
        uint64_t tag = static_cast<uint64_t>(nloop & 0x7FFFu);
        if (eop)
            tag |= (1ull << 15);
        tag |= (static_cast<uint64_t>(flg & 0x3u) << 58);
        tag |= (static_cast<uint64_t>(nreg & 0xFu) << 60);
        return tag;
    }

    void appendU64(std::vector<uint8_t> &dst, uint64_t value)
    {
        const size_t pos = dst.size();
        dst.resize(pos + sizeof(uint64_t));
        std::memcpy(dst.data() + pos, &value, sizeof(uint64_t));
    }

    void appendGifAd(std::vector<uint8_t> &dst, uint64_t value, uint64_t reg)
    {
        appendU64(dst, value);
        appendU64(dst, reg);
    }

    template <typename Predicate>
    bool waitUntil(Predicate pred, std::chrono::milliseconds timeout)
    {
        const auto deadline = std::chrono::steady_clock::now() + timeout;
        while (std::chrono::steady_clock::now() < deadline)
        {
            if (pred())
            {
                return true;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }

        return pred();
    }

    void testGsSyncVCallback(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        (void)rdram;
        (void)runtime;

        g_gsSyncCallbackLastTick.store(getRegU32(ctx, 4), std::memory_order_relaxed);
        g_gsSyncCallbackSp.store(getRegU32(ctx, 29), std::memory_order_relaxed);
        g_gsSyncCallbackGp.store(getRegU32(ctx, 28), std::memory_order_relaxed);
        g_gsSyncCallbackHits.fetch_add(1u, std::memory_order_relaxed);
        ctx->pc = 0u;
    }

    void testGsSyncWait0(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        ctx->pc = kGsSyncResume0Pc;
        ps2_stubs::sceGsSyncV(rdram, ctx, runtime);
    }

    void testGsSyncResume0(uint8_t *, R5900Context *ctx, PS2Runtime *)
    {
        g_gsSyncFirstField.store(static_cast<int32_t>(getRegU32(ctx, 2)), std::memory_order_release);
        ctx->pc = kGsSyncWait1Pc;
    }

    void testGsSyncWait1(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        ctx->pc = kGsSyncResume1Pc;
        ps2_stubs::sceGsSyncV(rdram, ctx, runtime);
    }

    void testGsSyncResume1(uint8_t *, R5900Context *ctx, PS2Runtime *runtime)
    {
        g_gsSyncSecondField.store(static_cast<int32_t>(getRegU32(ctx, 2)), std::memory_order_release);
        ctx->pc = 0u;
        runtime->requestStop();
    }

    void testGsCallbackMain(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        setRegU32(*ctx, 4, kGsCallbackPc);
        setRegU32(*ctx, 28, kGsCallbackGp);
        setRegU32(*ctx, 29, kGsCallbackCallerSp);
        ctx->pc = kGsCallbackResumePc;
        ps2_stubs::sceGsSyncVCallback(rdram, ctx, runtime);
        g_gsSyncCallbackPrevious.store(getRegU32(ctx, 2), std::memory_order_release);
        ps2_syscalls::WaitVSyncTick(rdram, ctx, runtime, -1);
    }

    void testGsCallbackResume(uint8_t *, R5900Context *ctx, PS2Runtime *runtime)
    {
        ctx->pc = 0u;
        runtime->requestStop();
    }

    // The guest-memory form of a GsImageMem is libgraph's load-image packet (Support.h writeGsLoadImagePacket).
    void writeGsImageTest(uint8_t *rdram, uint32_t addr, const GsImageMem &image)
    {
        writeGsLoadImagePacket(rdram, addr, image);
    }

    void writeGsImageTest(std::vector<uint8_t> &rdram, uint32_t addr, const GsImageMem &image)
    {
        writeGsImageTest(rdram.data(), addr, image);
    }

    void writePSMT4Texel(std::vector<uint8_t> &vram, uint32_t tbp, uint32_t tbw, uint32_t x, uint32_t y, uint8_t index)
    {
        const uint32_t nibbleAddr = GSPSMT4::addrPSMT4(tbp, tbw, x, y);
        const uint32_t byteOff = nibbleAddr >> 1;
        uint8_t &packed = vram[byteOff];
        if ((nibbleAddr & 1u) != 0u)
        {
            packed = static_cast<uint8_t>((packed & 0x0Fu) | ((index & 0x0Fu) << 4));
        }
        else
        {
            packed = static_cast<uint8_t>((packed & 0xF0u) | (index & 0x0Fu));
        }
    }

    uint32_t referenceAddrPSMT4(uint32_t block, uint32_t width, uint32_t x, uint32_t y)
    {
        static constexpr uint8_t kBlockTable4[8][4] = {
            {0, 2, 8, 10},
            {1, 3, 9, 11},
            {4, 6, 12, 14},
            {5, 7, 13, 15},
            {16, 18, 24, 26},
            {17, 19, 25, 27},
            {20, 22, 28, 30},
            {21, 23, 29, 31},
        };

        static constexpr uint16_t kColumnTable4[16][32] = {
            {0, 8, 32, 40, 64, 72, 96, 104, 2, 10, 34, 42, 66, 74, 98, 106, 4, 12, 36, 44, 68, 76, 100, 108, 6, 14, 38, 46, 70, 78, 102, 110},
            {16, 24, 48, 56, 80, 88, 112, 120, 18, 26, 50, 58, 82, 90, 114, 122, 20, 28, 52, 60, 84, 92, 116, 124, 22, 30, 54, 62, 86, 94, 118, 126},
            {65, 73, 97, 105, 1, 9, 33, 41, 67, 75, 99, 107, 3, 11, 35, 43, 69, 77, 101, 109, 5, 13, 37, 45, 71, 79, 103, 111, 7, 15, 39, 47},
            {81, 89, 113, 121, 17, 25, 49, 57, 83, 91, 115, 123, 19, 27, 51, 59, 85, 93, 117, 125, 21, 29, 53, 61, 87, 95, 119, 127, 23, 31, 55, 63},
            {192, 200, 224, 232, 128, 136, 160, 168, 194, 202, 226, 234, 130, 138, 162, 170, 196, 204, 228, 236, 132, 140, 164, 172, 198, 206, 230, 238, 134, 142, 166, 174},
            {208, 216, 240, 248, 144, 152, 176, 184, 210, 218, 242, 250, 146, 154, 178, 186, 212, 220, 244, 252, 148, 156, 180, 188, 214, 222, 246, 254, 150, 158, 182, 190},
            {129, 137, 161, 169, 193, 201, 225, 233, 131, 139, 163, 171, 195, 203, 227, 235, 133, 141, 165, 173, 197, 205, 229, 237, 135, 143, 167, 175, 199, 207, 231, 239},
            {145, 153, 177, 185, 209, 217, 241, 249, 147, 155, 179, 187, 211, 219, 243, 251, 149, 157, 181, 189, 213, 221, 245, 253, 151, 159, 183, 191, 215, 223, 247, 255},
            {256, 264, 288, 296, 320, 328, 352, 360, 258, 266, 290, 298, 322, 330, 354, 362, 260, 268, 292, 300, 324, 332, 356, 364, 262, 270, 294, 302, 326, 334, 358, 366},
            {272, 280, 304, 312, 336, 344, 368, 376, 274, 282, 306, 314, 338, 346, 370, 378, 276, 284, 308, 316, 340, 348, 372, 380, 278, 286, 310, 318, 342, 350, 374, 382},
            {321, 329, 353, 361, 257, 265, 289, 297, 323, 331, 355, 363, 259, 267, 291, 299, 325, 333, 357, 365, 261, 269, 293, 301, 327, 335, 359, 367, 263, 271, 295, 303},
            {337, 345, 369, 377, 273, 281, 305, 313, 339, 347, 371, 379, 275, 283, 307, 315, 341, 349, 373, 381, 277, 285, 309, 317, 343, 351, 375, 383, 279, 287, 311, 319},
            {448, 456, 480, 488, 384, 392, 416, 424, 450, 458, 482, 490, 386, 394, 418, 426, 452, 460, 484, 492, 388, 396, 420, 428, 454, 462, 486, 494, 390, 398, 422, 430},
            {464, 472, 496, 504, 400, 408, 432, 440, 466, 474, 498, 506, 402, 410, 434, 442, 468, 476, 500, 508, 404, 412, 436, 444, 470, 478, 502, 510, 406, 414, 438, 446},
            {385, 393, 417, 425, 449, 457, 481, 489, 387, 395, 419, 427, 451, 459, 483, 491, 389, 397, 421, 429, 453, 461, 485, 493, 391, 399, 423, 431, 455, 463, 487, 495},
            {401, 409, 433, 441, 465, 473, 497, 505, 403, 411, 435, 443, 467, 475, 499, 507, 405, 413, 437, 445, 469, 477, 501, 509, 407, 415, 439, 447, 471, 479, 503, 511},
        };

        const uint32_t pagesPerRow = ((width >> 1u) != 0u) ? (width >> 1u) : 1u;
        const uint32_t page = (block >> 5u) + (y >> 7u) * pagesPerRow + (x >> 7u);
        const uint32_t blockId = (block & 0x1Fu) + kBlockTable4[(y >> 4u) & 7u][(x >> 5u) & 3u];
        const uint32_t pageOffset = (blockId >> 5u) << 14u;
        const uint32_t localBlock = blockId & 0x1Fu;
        return (page << 14u) + pageOffset + localBlock * 512u + kColumnTable4[y & 0x0Fu][x & 0x1Fu];
    }

    void writeReferencePSMT4Texel(std::vector<uint8_t> &vram, uint32_t tbp, uint32_t tbw, uint32_t x, uint32_t y, uint8_t index)
    {
        const uint32_t nibbleAddr = referenceAddrPSMT4(tbp, tbw, x, y);
        const uint32_t byteOff = nibbleAddr >> 1;
        uint8_t &packed = vram[byteOff];
        if ((nibbleAddr & 1u) != 0u)
        {
            packed = static_cast<uint8_t>((packed & 0x0Fu) | ((index & 0x0Fu) << 4));
        }
        else
        {
            packed = static_cast<uint8_t>((packed & 0xF0u) | (index & 0x0Fu));
        }
    }

    uint32_t referenceAddrPSMT8(uint32_t block, uint32_t width, uint32_t x, uint32_t y)
    {
        static constexpr uint8_t kBlockTable8[4][8] = {
            {0, 1, 4, 5, 16, 17, 20, 21},
            {2, 3, 6, 7, 18, 19, 22, 23},
            {8, 9, 12, 13, 24, 25, 28, 29},
            {10, 11, 14, 15, 26, 27, 30, 31},
        };

        static constexpr uint8_t kColumnTable8[16][16] = {
            {0, 4, 16, 20, 32, 36, 48, 52, 2, 6, 18, 22, 34, 38, 50, 54},
            {8, 12, 24, 28, 40, 44, 56, 60, 10, 14, 26, 30, 42, 46, 58, 62},
            {33, 37, 49, 53, 1, 5, 17, 21, 35, 39, 51, 55, 3, 7, 19, 23},
            {41, 45, 57, 61, 9, 13, 25, 29, 43, 47, 59, 63, 11, 15, 27, 31},
            {96, 100, 112, 116, 64, 68, 80, 84, 98, 102, 114, 118, 66, 70, 82, 86},
            {104, 108, 120, 124, 72, 76, 88, 92, 106, 110, 122, 126, 74, 78, 90, 94},
            {65, 69, 81, 85, 97, 101, 113, 117, 67, 71, 83, 87, 99, 103, 115, 119},
            {73, 77, 89, 93, 105, 109, 121, 125, 75, 79, 91, 95, 107, 111, 123, 127},
            {128, 132, 144, 148, 160, 164, 176, 180, 130, 134, 146, 150, 162, 166, 178, 182},
            {136, 140, 152, 156, 168, 172, 184, 188, 138, 142, 154, 158, 170, 174, 186, 190},
            {161, 165, 177, 181, 129, 133, 145, 149, 163, 167, 179, 183, 131, 135, 147, 151},
            {169, 173, 185, 189, 137, 141, 153, 157, 171, 175, 187, 191, 139, 143, 155, 159},
            {224, 228, 240, 244, 192, 196, 208, 212, 226, 230, 242, 246, 194, 198, 210, 214},
            {232, 236, 248, 252, 200, 204, 216, 220, 234, 238, 250, 254, 202, 206, 218, 222},
            {193, 197, 209, 213, 225, 229, 241, 245, 195, 199, 211, 215, 227, 231, 243, 247},
            {201, 205, 217, 221, 233, 237, 249, 253, 203, 207, 219, 223, 235, 239, 251, 255},
        };

        const uint32_t pagesPerRow = ((width >> 1u) != 0u) ? (width >> 1u) : 1u;
        const uint32_t page = (block >> 5u) + (y >> 6u) * pagesPerRow + (x >> 7u);
        const uint32_t blockId = (block & 0x1Fu) + kBlockTable8[(y >> 4u) & 3u][(x >> 4u) & 7u];
        const uint32_t pageOffset = (blockId >> 5u) << 13u;
        const uint32_t localBlock = blockId & 0x1Fu;
        return (page << 13u) + pageOffset + localBlock * 256u + kColumnTable8[y & 0x0Fu][x & 0x0Fu];
    }

    uint32_t referenceAddrPSMCT32(uint32_t block, uint32_t width, uint32_t x, uint32_t y)
    {
        static constexpr uint8_t kBlockTable32[4][8] = {
            {0, 1, 4, 5, 16, 17, 20, 21},
            {2, 3, 6, 7, 18, 19, 22, 23},
            {8, 9, 12, 13, 24, 25, 28, 29},
            {10, 11, 14, 15, 26, 27, 30, 31},
        };

        static constexpr uint8_t kColumnTable32[8][8] = {
            {0, 1, 4, 5, 8, 9, 12, 13},
            {2, 3, 6, 7, 10, 11, 14, 15},
            {16, 17, 20, 21, 24, 25, 28, 29},
            {18, 19, 22, 23, 26, 27, 30, 31},
            {32, 33, 36, 37, 40, 41, 44, 45},
            {34, 35, 38, 39, 42, 43, 46, 47},
            {48, 49, 52, 53, 56, 57, 60, 61},
            {50, 51, 54, 55, 58, 59, 62, 63},
        };

        const uint32_t pagesPerRow = (width != 0u) ? width : 1u;
        const uint32_t page = (block >> 5u) + (y >> 5u) * pagesPerRow + (x >> 6u);
        const uint32_t blockId = (block & 0x1Fu) + kBlockTable32[(y >> 3u) & 3u][(x >> 3u) & 7u];
        const uint32_t pageOffset = (blockId >> 5u) << 13u;
        const uint32_t localBlock = blockId & 0x1Fu;
        return (page << 13u) + pageOffset + localBlock * 256u +
               static_cast<uint32_t>(kColumnTable32[y & 0x7u][x & 0x7u]) * 4u;
    }

    void writeReferencePSMCT32Pixel(std::vector<uint8_t> &vram,
                                    uint32_t fbp,
                                    uint32_t fbw,
                                    uint32_t x,
                                    uint32_t y,
                                    uint32_t pixel)
    {
        const uint32_t off = referenceAddrPSMCT32(fbp, (fbw != 0u) ? fbw : 1u, x, y);
        std::memcpy(vram.data() + off, &pixel, sizeof(pixel));
    }

    uint32_t readReferencePSMCT32Pixel(const std::vector<uint8_t> &vram,
                                       uint32_t fbp,
                                       uint32_t fbw,
                                       uint32_t x,
                                       uint32_t y)
    {
        const uint32_t off = referenceAddrPSMCT32(fbp, (fbw != 0u) ? fbw : 1u, x, y);
        uint32_t pixel = 0u;
        std::memcpy(&pixel, vram.data() + off, sizeof(pixel));
        return pixel;
    }

    uint32_t frameBaseToBlock(uint32_t fbp)
    {
        return fbp << 5u;
    }

    void writeReferenceFramePSMCT32Pixel(std::vector<uint8_t> &vram,
                                         uint32_t fbp,
                                         uint32_t fbw,
                                         uint32_t x,
                                         uint32_t y,
                                         uint32_t pixel)
    {
        writeReferencePSMCT32Pixel(vram, frameBaseToBlock(fbp), fbw, x, y, pixel);
    }

    uint32_t readReferenceFramePSMCT32Pixel(const std::vector<uint8_t> &vram,
                                            uint32_t fbp,
                                            uint32_t fbw,
                                            uint32_t x,
                                            uint32_t y)
    {
        return readReferencePSMCT32Pixel(vram, frameBaseToBlock(fbp), fbw, x, y);
    }

    void expectGuestHeapReusable(TestCase &t, PS2Runtime &runtime, const char *message)
    {
        const uint32_t expectedBase = runtime.guestHeapBase();
        const uint32_t probe = runtime.guestMalloc(16u, 16u);
        t.Equals(probe, expectedBase, message);
        runtime.guestFree(probe);
    }

    struct GsPixelTestResult
    {
        uint32_t framebuffer = 0u;
        uint32_t depth = 0u;
    };

    GsPixelTestResult drawGsPixelForTests(uint8_t framePsm,
                                          uint64_t testReg,
                                          bool zmask,
                                          uint32_t initialFramebuffer,
                                          uint32_t initialDepth,
                                          uint8_t sourceAlpha)
    {
        constexpr uint32_t kFrameBlock = 0u;
        constexpr uint32_t kDepthBlock = 32u;
        constexpr uint32_t kSourceDepth = 0x22222222u;

        std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
        GS gs;
        gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

        gs.WriteVram(framePsm, kFrameBlock, 1u, 0u, 0u, initialFramebuffer);
        gs.WriteVram(GS_PSM_Z32, kDepthBlock, 1u, 0u, 0u, initialDepth);

        const uint64_t frame =
            (1ull << 16) |
            (static_cast<uint64_t>(framePsm) << 24);
        const uint64_t zbuf =
            1ull |
            (static_cast<uint64_t>(zmask ? 1u : 0u) << 32);
        const uint64_t rgbaq =
            (0x12ull << 0) |
            (0x34ull << 8) |
            (0x56ull << 16) |
            (static_cast<uint64_t>(sourceAlpha) << 24) |
            (0x3F800000ull << 32);

        gs.writeRegister(GS_REG_FRAME_1, frame);
        gs.writeRegister(GS_REG_ZBUF_1, zbuf);
        gs.writeRegister(GS_REG_SCISSOR_1, 0ull);
        gs.writeRegister(GS_REG_TEST_1, testReg);
        gs.writeRegister(GS_REG_PRIM, static_cast<uint64_t>(GS_PRIM_POINT));
        gs.writeRegister(GS_REG_RGBAQ, rgbaq);
        gs.writeRegister(GS_REG_XYZ2, static_cast<uint64_t>(kSourceDepth) << 32);

        return {
            gs.ReadVram(framePsm, kFrameBlock, 1u, 0u, 0u),
            gs.ReadVram(GS_PSM_Z32, kDepthBlock, 1u, 0u, 0u),
        };
    }
}

void register_ps2_gs_tests()
{
    MiniTest::Case("PS2GS", [](TestCase &tc)
    {
        tc.Run("GS CSR/IMR support coherent 64-bit and 32-bit access", [](TestCase &t)
        {
            PS2Memory mem;
            t.IsTrue(mem.initialize(), "PS2Memory initialize should succeed");

            constexpr uint32_t kGsCsr = 0x12001000u;
            constexpr uint32_t kGsImr = 0x12001010u;

            const uint64_t csrPattern = 0xA1B2C3D4E5F60718ull;
            mem.write64(kGsCsr, csrPattern);
            t.Equals(mem.read64(kGsCsr), csrPattern, "64-bit CSR read should match prior 64-bit write");
            t.Equals(mem.read32(kGsCsr), static_cast<uint32_t>(csrPattern & 0xFFFFFFFFull), "CSR low dword read should match");
            t.Equals(mem.read32(kGsCsr + 4u), static_cast<uint32_t>(csrPattern >> 32), "CSR high dword read should match");

            mem.write32(kGsCsr, 0x11223344u);
            t.Equals(mem.read64(kGsCsr), 0xA1B2C3D411223344ull, "32-bit low write should preserve CSR high dword");

            mem.write32(kGsCsr + 4u, 0x55667788u);
            t.Equals(mem.read64(kGsCsr), 0x5566778811223344ull, "32-bit high write should preserve CSR low dword");

            const uint64_t imrPattern = 0x0123456789ABCDEFull;
            mem.write64(kGsImr, imrPattern);
            t.Equals(mem.read64(kGsImr), imrPattern, "IMR 64-bit read should match prior write");
            t.Equals(mem.read32(kGsImr), 0x89ABCDEFu, "IMR low dword should match");
            t.Equals(mem.read32(kGsImr + 4u), 0x01234567u, "IMR high dword should match");
        });

        tc.Run("unknown GS privileged offsets are no-op and read as zero", [](TestCase &t)
        {
            PS2Memory mem;
            t.IsTrue(mem.initialize(), "PS2Memory initialize should succeed");

            constexpr uint32_t kKnownBusdir = 0x12001040u;
            constexpr uint32_t kUnknown = 0x12001008u; // inside GS priv range, but not mapped by gsRegPtr.

            mem.write64(kKnownBusdir, 0xCAFEBABE12345678ull);
            const uint64_t before = mem.read64(kKnownBusdir);
            mem.write32(kUnknown, 0xDEADBEEFu);
            t.Equals(mem.read32(kUnknown), 0u, "unknown GS offset should read as zero");
            t.Equals(mem.read64(kKnownBusdir), before, "unknown GS writes should not corrupt mapped GS registers");
        });

        tc.Run("GS writeIORegister increments GS write counter", [](TestCase &t)
        {
            PS2Memory mem;
            t.IsTrue(mem.initialize(), "PS2Memory initialize should succeed");

            constexpr uint32_t kGsPmode = 0x12000000u;
            constexpr uint32_t kGsImr = 0x12001010u;

            const uint64_t countBefore = mem.gsWriteCount();
            t.IsTrue(mem.writeIORegister(kGsPmode, 0x11u), "writeIORegister PMODE should succeed");
            t.IsTrue(mem.writeIORegister(kGsImr, 0x22u), "writeIORegister IMR should succeed");
            t.Equals(mem.gsWriteCount(), countBefore + 2ull, "GS IO writes should increment GS write counter");

            t.Equals(mem.readIORegister(kGsPmode), 0x11u, "writeIORegister PMODE value should be readable");
            t.Equals(mem.readIORegister(kGsImr), 0x22u, "writeIORegister IMR value should be readable");
        });

        tc.Run("GsPutIMR and GsGetIMR roundtrip old and new values", [](TestCase &t)
        {
            PS2Runtime runtime;
            t.IsTrue(runtime.memory().initialize(), "runtime memory initialize should succeed");
            runtime.memory().gs().imr = 0xAAAABBBBCCCCDDDDull;

            std::vector<uint8_t> rdram(PS2_RAM_SIZE, 0u);
            R5900Context ctx{};

            setRegU64(ctx, 4, 0x3333444411112222ull);
            GsPutIMR(rdram.data(), &ctx, &runtime);

            const uint64_t oldImr = getReturnU64(ctx);
            t.Equals(oldImr, 0xAAAABBBBCCCCDDDDull, "GsPutIMR should return previous IMR");
            t.Equals(runtime.memory().gs().imr, 0x3333444411112222ull, "GsPutIMR should update GS IMR");

            std::memset(&ctx, 0, sizeof(ctx));
            GsGetIMR(rdram.data(), &ctx, &runtime);
            const uint64_t currentImr = getReturnU64(ctx);
            t.Equals(currentImr, 0x3333444411112222ull, "GsGetIMR should return current GS IMR");
        });

        tc.Run("GsSetCrt updates SMODE2 for host presentation mode", [](TestCase &t)
        {
            PS2Runtime runtime;
            t.IsTrue(runtime.memory().initialize(), "runtime memory initialize should succeed");

            std::vector<uint8_t> rdram(PS2_RAM_SIZE, 0u);
            R5900Context ctx{};
            setRegU32(ctx, 4, 1u); // interlaced
            setRegU32(ctx, 5, 0u); // NTSC
            setRegU32(ctx, 6, 0u); // field mode

            runtime.memory().gs().pmode = 0u;
            runtime.memory().gs().smode2 = 0u;
            GsSetCrt(rdram.data(), &ctx, &runtime);

            t.Equals(runtime.memory().gs().smode2, 0x1ull,
                     "GsSetCrt should publish interlaced field mode through SMODE2");
            t.Equals(runtime.memory().gs().pmode & 0x3ull, 0x1ull,
                     "GsSetCrt should leave CRT1 enabled for presentation");
            t.Equals(getRegU32Test(ctx, 2), 0u,
                     "GsSetCrt should return success");
        });

        tc.Run("sceGsSetDefDBuffDc seeds display envs and swap applies the selected page", [](TestCase &t)
        {
            PS2Runtime runtime;
            t.IsTrue(runtime.memory().initialize(), "runtime memory initialize should succeed");

            std::vector<uint8_t> rdram(PS2_RAM_SIZE, 0u);
            constexpr uint32_t kEnvAddr = 0x4000u;
            constexpr uint32_t kDispEnvSize = 40u;
            constexpr uint32_t kDBuffSize = 0x330u;
            constexpr uint32_t kDispFbOffset = 16u;
            constexpr uint32_t kDisplayOffset = 24u;
            constexpr uint32_t kDraw01Offset = 0x60u;
            constexpr uint32_t kFrame1Offset = kDraw01Offset + 0x00u;
            constexpr uint32_t kFrame1AddrOffset = kDraw01Offset + 0x08u;
            constexpr uint32_t kXYOffset1Offset = kDraw01Offset + 0x20u;
            constexpr uint32_t kXYOffset1AddrOffset = kDraw01Offset + 0x28u;

            R5900Context ctx{};
            setRegU32(ctx, 4, kEnvAddr);
            setRegU32(ctx, 5, 0u);
            setRegU32(ctx, 6, 640u);
            setRegU32(ctx, 7, 448u);
            std::memset(rdram.data() + kEnvAddr, 0xCD, kDBuffSize);
            ps2_stubs::sceGsSetDefDBuffDc(rdram.data(), &ctx, &runtime);

            uint64_t dispfb0 = 0u;
            uint64_t display0 = 0u;
            uint64_t frame10 = 0u;
            uint64_t frame10Addr = 0u;
            uint64_t xyoffset10 = 0u;
            uint64_t xyoffset10Addr = 0u;
            std::memcpy(&dispfb0, rdram.data() + kEnvAddr + kDispFbOffset, sizeof(dispfb0));
            std::memcpy(&display0, rdram.data() + kEnvAddr + kDisplayOffset, sizeof(display0));
            std::memcpy(&frame10, rdram.data() + kEnvAddr + kFrame1Offset, sizeof(frame10));
            std::memcpy(&frame10Addr, rdram.data() + kEnvAddr + kFrame1AddrOffset, sizeof(frame10Addr));
            std::memcpy(&xyoffset10, rdram.data() + kEnvAddr + kXYOffset1Offset, sizeof(xyoffset10));
            std::memcpy(&xyoffset10Addr, rdram.data() + kEnvAddr + kXYOffset1AddrOffset, sizeof(xyoffset10Addr));

            t.Equals((dispfb0 >> 9) & 0x3Fu, 10ull, "dbuff display env should seed FBW from width");
            t.Equals((display0 >> 32) & 0x0FFFull, 639ull, "dbuff display env should seed DW from width");
            t.Equals((display0 >> 44) & 0x07FFull, 447ull, "dbuff display env should seed DH from height");
            t.Equals((frame10 >> 16) & 0x3Full, 10ull, "dbuff draw env should seed FRAME FBW from width");
            t.Equals(frame10Addr, 0x4Cull, "dbuff draw env should seed FRAME_1 register id");
            t.Equals(xyoffset10 & 0xFFFFull, 0x6C00ull, "dbuff draw env should seed OFX in 12.4 fixed point");
            t.Equals((xyoffset10 >> 32) & 0xFFFFull, 0x7200ull, "dbuff draw env should seed OFY in 12.4 fixed point");
            t.Equals(xyoffset10Addr, 0x18ull, "dbuff draw env should seed XYOFFSET_1 register id");

            dispfb0 = (dispfb0 & ~0x1FFull) | 150ull;
            std::memcpy(rdram.data() + kEnvAddr + kDispFbOffset, &dispfb0, sizeof(dispfb0));

            uint64_t dispfb1 = dispfb0;
            dispfb1 = (dispfb1 & ~0x1FFull) | 151ull;
            std::memcpy(rdram.data() + kEnvAddr + kDispEnvSize + kDispFbOffset, &dispfb1, sizeof(dispfb1));

            std::memset(&ctx, 0, sizeof(ctx));
            setRegU32(ctx, 4, kEnvAddr);
            setRegU32(ctx, 5, 1u);
            ps2_stubs::sceGsSwapDBuffDc(rdram.data(), &ctx, &runtime);

            t.Equals(runtime.memory().gs().dispfb1 & 0x1FFull, 151ull,
                     "sceGsSwapDBuffDc should program GS to the selected display page");
            t.Equals((runtime.memory().gs().display1 >> 32) & 0x0FFFull, 639ull,
                     "sceGsSwapDBuffDc should preserve the display width from the seeded env");
        });

        tc.Run("sceGsSetDefDBuffDc seeds a clear packet and swap clears the draw buffer", [](TestCase &t)
        {
            PS2Runtime runtime;
            t.IsTrue(runtime.memory().initialize(), "runtime memory initialize should succeed");

            std::vector<uint8_t> rdram(PS2_RAM_SIZE, 0u);
            constexpr uint32_t kEnvAddr = 0x5000u;
            constexpr uint32_t kDBuffSize = 0x330u;
            constexpr uint32_t kClear0Offset = 0x160u;
            constexpr uint32_t kTestAAddrOffset = kClear0Offset + 0x08u;
            constexpr uint32_t kPrimAddrOffset = kClear0Offset + 0x18u;
            constexpr uint32_t kRgbaqOffset = kClear0Offset + 0x20u;
            constexpr uint32_t kRgbaqAddrOffset = kClear0Offset + 0x28u;
            constexpr uint32_t kXyz2AAddrOffset = kClear0Offset + 0x38u;
            constexpr uint32_t kXyz2BAddrOffset = kClear0Offset + 0x48u;
            constexpr uint32_t kTestBAddrOffset = kClear0Offset + 0x58u;
            constexpr uint32_t kClearColor = 0x80402010u;
            constexpr uint32_t kStackAddr = 0x900u;
            const uint32_t kZTest = 2u;
            const uint32_t kEnableClear = 1u;

            R5900Context ctx{};
            setRegU32(ctx, 4, kEnvAddr);
            setRegU32(ctx, 5, 0u);
            setRegU32(ctx, 6, 640u);
            setRegU32(ctx, 7, 448u);
            setRegU32(ctx, 29, kStackAddr);
            std::memset(rdram.data() + kEnvAddr, 0xCD, kDBuffSize);
            std::memcpy(rdram.data() + kStackAddr + 16u, &kZTest, sizeof(kZTest));
            std::memcpy(rdram.data() + kStackAddr + 24u, &kEnableClear, sizeof(kEnableClear));
            std::memset(runtime.memory().getGSVRAM(), 0xAB, 16u);
            ps2_stubs::sceGsSetDefDBuffDc(rdram.data(), &ctx, &runtime);

            uint64_t testAAddr = 0u;
            uint64_t primAddr = 0u;
            uint64_t rgbaqAddr = 0u;
            uint64_t xyz2AAddr = 0u;
            uint64_t xyz2BAddr = 0u;
            uint64_t testBAddr = 0u;
            std::memcpy(&testAAddr, rdram.data() + kEnvAddr + kTestAAddrOffset, sizeof(testAAddr));
            std::memcpy(&primAddr, rdram.data() + kEnvAddr + kPrimAddrOffset, sizeof(primAddr));
            std::memcpy(&rgbaqAddr, rdram.data() + kEnvAddr + kRgbaqAddrOffset, sizeof(rgbaqAddr));
            std::memcpy(&xyz2AAddr, rdram.data() + kEnvAddr + kXyz2AAddrOffset, sizeof(xyz2AAddr));
            std::memcpy(&xyz2BAddr, rdram.data() + kEnvAddr + kXyz2BAddrOffset, sizeof(xyz2BAddr));
            std::memcpy(&testBAddr, rdram.data() + kEnvAddr + kTestBAddrOffset, sizeof(testBAddr));

            t.Equals(testAAddr, 0x47ull, "dbuff clear packet should program TEST_1 before clearing");
            t.Equals(primAddr, 0x00ull, "dbuff clear packet should program PRIM before clearing");
            t.Equals(rgbaqAddr, 0x01ull, "dbuff clear packet should expose RGBAQ for runtime color updates");
            t.Equals(xyz2AAddr, 0x05ull, "dbuff clear packet should seed the first clear vertex as XYZ2");
            t.Equals(xyz2BAddr, 0x05ull, "dbuff clear packet should seed the second clear vertex as XYZ2");
            t.Equals(testBAddr, 0x47ull, "dbuff clear packet should restore TEST_1 after clearing");

            uint64_t rgbaq = static_cast<uint64_t>(kClearColor);
            std::memcpy(rdram.data() + kEnvAddr + kRgbaqOffset, &rgbaq, sizeof(rgbaq));

            std::memset(&ctx, 0, sizeof(ctx));
            setRegU32(ctx, 4, kEnvAddr);
            setRegU32(ctx, 5, 0u);
            ps2_stubs::sceGsSwapDBuffDc(rdram.data(), &ctx, &runtime);

            uint32_t clearedPixel = 0u;
            std::memcpy(&clearedPixel, runtime.memory().getGSVRAM(), sizeof(clearedPixel));
            t.Equals(clearedPixel, kClearColor,
                     "sceGsSwapDBuffDc should execute the seeded clear packet against the active draw buffer");

            constexpr uint32_t kMidX = 320u;
            constexpr uint32_t kMidY = 200u;
            const uint32_t kMidOffset = ((kMidY * 640u) + kMidX) * 4u;
            uint32_t clearedMidPixel = 0u;
            std::memcpy(&clearedMidPixel, runtime.memory().getGSVRAM() + kMidOffset, sizeof(clearedMidPixel));
            t.Equals(clearedMidPixel, kClearColor,
                     "sceGsSwapDBuffDc should clear the interior of the active draw buffer, not just the first pixel");
        });

        tc.Run("sceGsSetDefDBuffDc accepts trailing args from the recompiler register ABI", [](TestCase &t)
        {
            PS2Runtime runtime;
            t.IsTrue(runtime.memory().initialize(), "runtime memory initialize should succeed");

            std::vector<uint8_t> rdram(PS2_RAM_SIZE, 0u);
            constexpr uint32_t kEnvAddr = 0x5400u;
            constexpr uint32_t kDBuffSize = 0x330u;
            constexpr uint32_t kClear0Offset = 0x160u;
            constexpr uint32_t kRgbaqOffset = kClear0Offset + 0x20u;
            constexpr uint32_t kRgbaqAddrOffset = kClear0Offset + 0x28u;
            constexpr uint32_t kStackAddr = 0xA00u;
            constexpr uint32_t kClearColor = 0x40201008u;

            R5900Context ctx{};
            setRegU32(ctx, 4, kEnvAddr);
            setRegU32(ctx, 5, 0u);
            setRegU32(ctx, 6, 640u);
            setRegU32(ctx, 7, 448u);
            setRegU32(ctx, 8, 2u);
            setRegU32(ctx, 9, 58u);
            setRegU32(ctx, 10, 1u);
            setRegU32(ctx, 29, kStackAddr);
            std::memset(rdram.data() + kEnvAddr, 0xCD, kDBuffSize);
            std::memset(runtime.memory().getGSVRAM(), 0xAB, 16u);

            ps2_stubs::sceGsSetDefDBuffDc(rdram.data(), &ctx, &runtime);

            uint64_t rgbaqAddr = 0u;
            std::memcpy(&rgbaqAddr, rdram.data() + kEnvAddr + kRgbaqAddrOffset, sizeof(rgbaqAddr));
            t.Equals(rgbaqAddr, 0x01ull,
                     "sceGsSetDefDBuffDc should seed the clear packet when trailing args arrive in t0-t2");

            const uint64_t rgbaq = static_cast<uint64_t>(kClearColor);
            std::memcpy(rdram.data() + kEnvAddr + kRgbaqOffset, &rgbaq, sizeof(rgbaq));

            std::memset(&ctx, 0, sizeof(ctx));
            setRegU32(ctx, 4, kEnvAddr);
            setRegU32(ctx, 5, 0u);
            ps2_stubs::sceGsSwapDBuffDc(rdram.data(), &ctx, &runtime);

            uint32_t clearedPixel = 0u;
            std::memcpy(&clearedPixel, runtime.memory().getGSVRAM(), sizeof(clearedPixel));
            t.Equals(clearedPixel, kClearColor,
                     "sceGsSwapDBuffDc should honor a clear packet seeded from register-based trailing args");
        });

        tc.Run("sceGsSetDefDBuff reads trailing args from t0-t2 and seeds the console's clear packets", [](TestCase &t)
        {
            // Both live callers (0x1c680c, 0x3b16c8) pass ztest/zpsm/clear = 2/0x3a/1 in $t0-$t2; the stack
            // holds unrelated words. Expected bytes: PCSX2 logs/parity/title_pcsx2.rdram, DBuff 0x1e6410.
            PS2Runtime runtime;
            t.IsTrue(runtime.memory().initialize(), "runtime memory initialize should succeed");

            std::vector<uint8_t> rdram(PS2_RAM_SIZE, 0u);
            constexpr uint32_t kEnvAddr = 0x5400u;
            constexpr uint32_t kDBuffSize = 0x230u;
            constexpr uint32_t kStackAddr = 0xA00u;
            const uint32_t stackGarbage[3] = {1u, 0x31u, 0u}; // what the old readStackU32(16/20/24) saw

            R5900Context ctx{};
            setRegU32(ctx, 4, kEnvAddr);
            setRegU32(ctx, 5, 0u);
            setRegU32(ctx, 6, 640u);
            setRegU32(ctx, 7, 448u);
            setRegU32(ctx, 8, 2u);
            setRegU32(ctx, 9, 0x3au);
            setRegU32(ctx, 10, 1u);
            setRegU32(ctx, 29, kStackAddr);
            std::memcpy(rdram.data() + kStackAddr + 16u, stackGarbage, sizeof(stackGarbage));
            std::memset(rdram.data() + kEnvAddr, 0xCD, kDBuffSize);

            ps2_stubs::sceGsSetDefDBuff(rdram.data(), &ctx, &runtime);

            auto qword = [&](uint32_t off)
            {
                uint64_t v = 0u;
                std::memcpy(&v, rdram.data() + kEnvAddr + off, sizeof(v));
                return v;
            };
            const uint64_t zbuf = qword(0x70u); // zbp (low 9 bits) is excluded: sceGszbufaddr, Sprint 6
            t.Equals(qword(0x78u), 0x4eull, "ZBUF_1 register id at +0x78");
            t.Equals(static_cast<uint32_t>((zbuf >> 24) & 0xFu), 0xAu, "ZBUF_1 psm should be 0xa (zpsm 0x3a from $t1)");
            t.Equals(static_cast<uint32_t>((zbuf >> 32) & 0x1u), 0u, "ZBUF_1 zmsk should be 0 (ztest GEQUAL from $t0)");
            t.Equals(qword(0xD0u), 0x50000ull, "TEST_1 should be 0x50000 (ztst GEQUAL)");
            t.Equals(qword(0x50u), 0x100000000000800eull, "giftag0 nloop should be 14 with the clear packet");

            // title_pcsx2 +0xE0..+0x13F: TEST_1 0x30000, PRIM sprite, RGBAQ q=1.0, XYZ2 x2, TEST_1 0x50000.
            constexpr uint64_t kClearPacket[12] = {
                0x0000000000030000ull, 0x0000000000000047ull,
                0x0000000000000006ull, 0x0000000000000000ull,
                0x3f80000000000000ull, 0x0000000000000001ull,
                0x0000000072006c00ull, 0x0000000000000005ull,
                0x000000008e009400ull, 0x0000000000000005ull,
                0x0000000000050000ull, 0x0000000000000047ull,
            };
            t.IsTrue(std::memcmp(rdram.data() + kEnvAddr + 0xE0u, kClearPacket, sizeof(kClearPacket)) == 0,
                     "clear packet 0 (+0xE0) should be byte-identical to title_pcsx2");
            t.IsTrue(std::memcmp(rdram.data() + kEnvAddr + 0x1D0u, kClearPacket, sizeof(kClearPacket)) == 0,
                     "clear packet 1 (+0x1D0) should be byte-identical to title_pcsx2 (context 1, as FUN_001a1e78)");
        });

        tc.Run("clearFramebufferContext clears the requested context even if another context is active", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint32_t kCtx0Color = 0x11223344u;
            constexpr uint32_t kCtx1Sentinel = 0xAABBCCDDu;

            gs.writeRegister(GS_REG_FRAME_1, (1ull << 16)); // FBP=0, FBW=1, PSMCT32
            gs.writeRegister(GS_REG_SCISSOR_1, (0ull << 0) | (0ull << 16) | (1ull << 32) | (1ull << 48));
            gs.writeRegister(GS_REG_FRAME_2, 150ull | (1ull << 16));
            gs.writeRegister(GS_REG_SCISSOR_2, (0ull << 0) | (0ull << 16) | (1ull << 32) | (1ull << 48));
            gs.writeRegister(GS_REG_PRIM, static_cast<uint64_t>(GS_PRIM_POINT) | (1ull << 9));

            writeReferenceFramePSMCT32Pixel(vram, 150u, 1u, 0u, 1u, kCtx1Sentinel);

            t.IsTrue(gs.clearFramebufferContext(0u, kCtx0Color),
                     "context-targeted clear should succeed for a configured CT32 framebuffer");

            const uint32_t ctx0Pixel = readReferenceFramePSMCT32Pixel(vram, 0u, 1u, 0u, 1u);
            t.Equals(ctx0Pixel, kCtx0Color,
                     "context-targeted clear should write the requested context even when PRIM.ctxt points elsewhere");

            const uint32_t ctx1Pixel = readReferenceFramePSMCT32Pixel(vram, 150u, 1u, 0u, 1u);
            t.Equals(ctx1Pixel, kCtx1Sentinel,
                     "context-targeted clear should leave the other context framebuffer untouched");
        });

        tc.Run("XYZ3 culls a triangle strip primitive without desynchronizing the vertex queue", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint32_t kColor = 0xFF0000FFu;
            constexpr uint64_t kFrame =
                (1ull << 16) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kZbuf = (1ull << 32);
            constexpr uint64_t kScissor =
                (6ull << 16) |
                (6ull << 48);

            auto xyz = [](uint32_t x, uint32_t y) -> uint64_t
            {
                return static_cast<uint64_t>(x * 16u) |
                       (static_cast<uint64_t>(y * 16u) << 16);
            };

            gs.writeRegister(GS_REG_FRAME_1, kFrame);
            gs.writeRegister(GS_REG_ZBUF_1, kZbuf);
            gs.writeRegister(GS_REG_SCISSOR_1, kScissor);
            gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
            gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
            gs.writeRegister(GS_REG_PRIM, static_cast<uint64_t>(GS_PRIM_TRISTRIP));
            gs.writeRegister(GS_REG_RGBAQ, kColor);

            // ABC is rejected by XYZ3. D must then draw BCD, not stale ABC.
            gs.writeRegister(GS_REG_XYZ2, xyz(0u, 0u));
            gs.writeRegister(GS_REG_XYZ2, xyz(6u, 0u));
            gs.writeRegister(GS_REG_XYZ3, xyz(0u, 6u));
            gs.writeRegister(GS_REG_XYZ2, xyz(6u, 6u));

            t.Equals(readReferencePSMCT32Pixel(vram, 0u, 1u, 1u, 1u), 0u,
                     "XYZ3 should suppress the completed ABC triangle");
            t.Equals(readReferencePSMCT32Pixel(vram, 0u, 1u, 4u, 4u), kColor,
                     "the next XYZ2 should draw BCD from the advanced strip queue");
        });

        tc.Run("submitHostTriangle draws the same pixels as three XYZ2 kicks", [](TestCase &t)
        {
            // The host-render hook must reproduce the GIF path exactly for a triangle whose
            // vertices happen to land on integer pixel centres: same state, same rasteriser.
            constexpr uint32_t kColor = 0x800000FFu; // RGBAQ layout: R=0xFF G=0 B=0 A=0x80
            constexpr uint64_t kFrame =
                (1ull << 16) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kZbuf = (1ull << 32);
            constexpr uint64_t kScissor =
                (63ull << 16) |
                (63ull << 48);

            auto setupContext1 = [&](GS &gs)
            {
                gs.writeRegister(GS_REG_FRAME_1, kFrame);
                gs.writeRegister(GS_REG_ZBUF_1, kZbuf);
                gs.writeRegister(GS_REG_SCISSOR_1, kScissor);
                gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
                gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
            };

            auto xyz = [](uint32_t x, uint32_t y) -> uint64_t
            {
                return static_cast<uint64_t>(x * 16u) |
                       (static_cast<uint64_t>(y * 16u) << 16);
            };

            std::vector<uint8_t> vramA(PS2_GS_VRAM_SIZE, 0u);
            GS gsA;
            gsA.init(vramA.data(), static_cast<uint32_t>(vramA.size()), nullptr);
            setupContext1(gsA);

            // A: three XYZ2 kicks of an integer-coordinate triangle through the GIF register path.
            gsA.writeRegister(GS_REG_PRIM, static_cast<uint64_t>(GS_PRIM_TRIANGLE));
            gsA.writeRegister(GS_REG_RGBAQ, kColor);
            gsA.writeRegister(GS_REG_XYZ2, xyz(10u, 10u));
            gsA.writeRegister(GS_REG_XYZ2, xyz(40u, 10u));
            gsA.writeRegister(GS_REG_XYZ2, xyz(10u, 40u));

            t.Equals(readReferencePSMCT32Pixel(vramA, 0u, 1u, 15u, 15u), kColor,
                     "the reference GIF triangle should have covered the sample pixel");

            std::vector<uint8_t> vramB(PS2_GS_VRAM_SIZE, 0u);
            GS gsB;
            gsB.init(vramB.data(), static_cast<uint32_t>(vramB.size()), nullptr);
            setupContext1(gsB);

            // B: the same triangle through the hook, with no PRIM/RGBAQ/XYZ2 register writes.
            GSPrimReg prim{};
            prim.type = GS_PRIM_TRIANGLE;
            prim.iip = false;
            prim.tme = false;
            prim.abe = false;
            prim.ctxt = false;
            GSVertex v0{}, v1{}, v2{};
            v0.x = 10.0f; v0.y = 10.0f;
            v1.x = 40.0f; v1.y = 10.0f;
            v2.x = 10.0f; v2.y = 40.0f;
            for (GSVertex *v : {&v0, &v1, &v2})
            {
                v->r = 255; v->g = 0; v->b = 0; v->a = 128; v->q = 1.0f;
            }
            gsB.submitHostTriangle(prim, v0, v1, v2);

            t.Equals(std::memcmp(vramA.data(), vramB.data(), PS2_GS_VRAM_SIZE), 0,
                     "host triangle must match the GIF triangle pixel for pixel");
        });

        tc.Run("submitHostTriangle honours the context selected by prim.ctxt", [](TestCase &t)
        {
            constexpr uint32_t kColor = 0x800000FFu;
            constexpr uint32_t kFbp1 = 0u;
            constexpr uint32_t kFbp2 = 4u; // a whole page past the 64x64 CT32 region of context 1
            constexpr uint64_t kZbuf = (1ull << 32);
            constexpr uint64_t kScissor =
                (63ull << 16) |
                (63ull << 48);
            auto frameReg = [](uint32_t fbp) -> uint64_t
            {
                return static_cast<uint64_t>(fbp) |
                       (1ull << 16) |
                       (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            };

            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            gs.writeRegister(GS_REG_FRAME_1, frameReg(kFbp1));
            gs.writeRegister(GS_REG_ZBUF_1, kZbuf);
            gs.writeRegister(GS_REG_SCISSOR_1, kScissor);
            gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
            gs.writeRegister(GS_REG_TEST_1, 0x30000ull);

            gs.writeRegister(GS_REG_FRAME_2, frameReg(kFbp2));
            gs.writeRegister(GS_REG_ZBUF_2, kZbuf);
            gs.writeRegister(GS_REG_SCISSOR_2, kScissor);
            gs.writeRegister(GS_REG_XYOFFSET_2, 0ull);
            gs.writeRegister(GS_REG_TEST_2, 0x30000ull);

            // PRIM still selects context 1: the hook must ignore it and use prim.ctxt.
            gs.writeRegister(GS_REG_PRIM, static_cast<uint64_t>(GS_PRIM_TRIANGLE));

            GSPrimReg prim{};
            prim.type = GS_PRIM_TRIANGLE;
            prim.ctxt = true;
            GSVertex v0{}, v1{}, v2{};
            v0.x = 10.0f; v0.y = 10.0f;
            v1.x = 40.0f; v1.y = 10.0f;
            v2.x = 10.0f; v2.y = 40.0f;
            for (GSVertex *v : {&v0, &v1, &v2})
            {
                v->r = 255; v->g = 0; v->b = 0; v->a = 128; v->q = 1.0f;
            }
            gs.submitHostTriangle(prim, v0, v1, v2);

            t.Equals(readReferenceFramePSMCT32Pixel(vram, kFbp2, 1u, 15u, 15u), kColor,
                     "prim.ctxt = 1 should draw into FRAME_2's framebuffer");
            t.Equals(readReferenceFramePSMCT32Pixel(vram, kFbp1, 1u, 15u, 15u), 0u,
                     "FRAME_1's framebuffer must be untouched when prim.ctxt selects context 2");
        });

        tc.Run("GS fog blends the shaded color toward FOGCOL before framebuffer blending", [](TestCase &t)
        {
            auto renderFoggedPoint = [](bool fogEnabled, uint8_t fog, uint32_t fogColor = 0u) -> uint32_t
            {
                std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
                GS gs;
                gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

                constexpr uint64_t kFrame =
                    (1ull << 16) |
                    (static_cast<uint64_t>(GS_PSM_CT32) << 24);
                constexpr uint64_t kZbuf = (1ull << 32);
                constexpr uint64_t kWhite = 0x80FFFFFFull;

                gs.writeRegister(GS_REG_FRAME_1, kFrame);
                gs.writeRegister(GS_REG_ZBUF_1, kZbuf);
                gs.writeRegister(GS_REG_SCISSOR_1, 0ull);
                gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
                gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
                gs.writeRegister(GS_REG_FOGCOL, fogColor);
                gs.writeRegister(
                    GS_REG_PRIM,
                    static_cast<uint64_t>(GS_PRIM_POINT) |
                        (static_cast<uint64_t>(fogEnabled ? 1u : 0u) << 5));
                gs.writeRegister(GS_REG_RGBAQ, kWhite);
                gs.writeRegister(GS_REG_FOG, static_cast<uint64_t>(fog) << 56);
                gs.writeRegister(GS_REG_XYZ2, 0ull);

                return readReferencePSMCT32Pixel(vram, 0u, 1u, 0u, 0u);
            };

            t.Equals(renderFoggedPoint(false, 0x80u), 0x80FFFFFFu,
                     "FOG and FOGCOL must not affect primitives with FGE disabled");
            t.Equals(renderFoggedPoint(true, 0x80u), 0x807F7F7Fu,
                     "F=0x80 over black FOGCOL should halve the point RGB and preserve alpha");
            t.Equals(renderFoggedPoint(true, 0x00u), 0x80000000u,
                     "F=0 should replace the point RGB with black FOGCOL");
            t.Equals(renderFoggedPoint(true, 0x00u, 0x00302010u), 0x802F1F0Fu,
                     "F=0 should replace point RGB with the programmed FOGCOL");
        });

        tc.Run("PRMODE supplies primitive attributes while PRMODECONT AC is clear", [](TestCase &t)
        {
            auto renderPoint = [](bool usePrmodeAttributes) -> uint32_t
            {
                std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
                GS gs;
                gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

                constexpr uint64_t kFrame =
                    (1ull << 16) |
                    (static_cast<uint64_t>(GS_PSM_CT32) << 24);
                constexpr uint64_t kZbuf = (1ull << 32);

                gs.writeRegister(GS_REG_FRAME_1, kFrame);
                gs.writeRegister(GS_REG_ZBUF_1, kZbuf);
                gs.writeRegister(GS_REG_SCISSOR_1, 0ull);
                gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
                gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
                gs.writeRegister(GS_REG_FOGCOL, 0ull);
                gs.writeRegister(GS_REG_RGBAQ, 0x80FFFFFFull);
                gs.writeRegister(GS_REG_FOG, 0ull);
                gs.writeRegister(GS_REG_PRMODE, 1ull << 5);
                gs.writeRegister(GS_REG_PRMODECONT, usePrmodeAttributes ? 0ull : 1ull);

                // FGE is clear in PRIM. AC decides whether that clear bit or
                // PRMODE's set bit supplies the effective fog enable.
                gs.writeRegister(GS_REG_PRIM, static_cast<uint64_t>(GS_PRIM_POINT));
                gs.writeRegister(GS_REG_XYZ2, 0ull);

                return readReferencePSMCT32Pixel(vram, 0u, 1u, 0u, 0u);
            };

            t.Equals(renderPoint(true), 0x80000000u,
                     "AC=0 should retain FGE from PRMODE across a PRIM write");
            t.Equals(renderPoint(false), 0x80FFFFFFu,
                     "AC=1 should source FGE from PRIM instead of PRMODE");
        });

        tc.Run("PABE bypasses alpha blend for low-alpha source pixels", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            gs.writeRegister(GS_REG_FRAME_1, (1ull << 16)); // FBW=1, PSMCT32, FBP=0
            gs.writeRegister(GS_REG_ZBUF_1, (1ull << 32));
            gs.writeRegister(GS_REG_SCISSOR_1, 0ull);
            gs.writeRegister(GS_REG_ALPHA_1, 0x6000000064ull);
            gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
            gs.writeRegister(GS_REG_PRIM, static_cast<uint64_t>(GS_PRIM_POINT) | (1ull << 6));

            const uint32_t dstWhite = 0xFFFFFFFFu;
            std::memcpy(vram.data(), &dstWhite, sizeof(dstWhite));

            gs.writeRegister(GS_REG_PABE, 0ull);
            gs.writeRegister(GS_REG_RGBAQ, 0x01000000ull);
            gs.writeRegister(GS_REG_XYZ2, 0ull);

            uint32_t blendedPixel = 0u;
            std::memcpy(&blendedPixel, vram.data(), sizeof(blendedPixel));
            t.Equals(blendedPixel, 0x013F3F3Fu,
                     "without PABE, low-alpha fullscreen copies should still apply ALPHA blending");

            std::memcpy(vram.data(), &dstWhite, sizeof(dstWhite));

            gs.writeRegister(GS_REG_PRIM, static_cast<uint64_t>(GS_PRIM_POINT) | (1ull << 6));
            gs.writeRegister(GS_REG_PABE, 1ull);
            gs.writeRegister(GS_REG_RGBAQ, 0x01000000ull);
            gs.writeRegister(GS_REG_XYZ2, 0ull);

            uint32_t pabeBypassedPixel = 0u;
            std::memcpy(&pabeBypassedPixel, vram.data(), sizeof(pabeBypassedPixel));
            t.Equals(pabeBypassedPixel, 0x01000000u,
                     "with PABE enabled, low-alpha source pixels should bypass ALPHA blending and overwrite the destination");

            std::memcpy(vram.data(), &dstWhite, sizeof(dstWhite));

            gs.writeRegister(GS_REG_PRIM, static_cast<uint64_t>(GS_PRIM_POINT) | (1ull << 6));
            gs.writeRegister(GS_REG_PABE, 1ull);
            gs.writeRegister(GS_REG_RGBAQ, 0x80000000ull);
            gs.writeRegister(GS_REG_XYZ2, 0ull);

            uint32_t highAlphaPixel = 0u;
            std::memcpy(&highAlphaPixel, vram.data(), sizeof(highAlphaPixel));
            t.Equals(highAlphaPixel, 0x803F3F3Fu,
                     "with PABE enabled, high-alpha source pixels should still use the configured ALPHA blend");
        });

        tc.Run("COLCLAMP selects saturated or wrapped alpha blend output", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint64_t kAlpha =
                (0ull << 0) |  // A = source
                (2ull << 2) |  // B = zero
                (2ull << 4) |  // C = FIX
                (1ull << 6) |  // D = destination
                (0x80ull << 32);
            constexpr uint32_t kColor = 0x801020F0u;

            gs.writeRegister(GS_REG_FRAME_1, (1ull << 16));
            gs.writeRegister(GS_REG_ZBUF_1, (1ull << 32));
            gs.writeRegister(GS_REG_SCISSOR_1, 0ull);
            gs.writeRegister(GS_REG_ALPHA_1, kAlpha);
            gs.writeRegister(GS_REG_TEST_1, 0x30000ull);

            std::memcpy(vram.data(), &kColor, sizeof(kColor));
            gs.writeRegister(GS_REG_COLCLAMP, 0ull);
            gs.writeRegister(GS_REG_PRIM, static_cast<uint64_t>(GS_PRIM_POINT) | (1ull << 6));
            gs.writeRegister(GS_REG_RGBAQ, kColor);
            gs.writeRegister(GS_REG_XYZ2, 0ull);

            uint32_t wrappedPixel = 0u;
            std::memcpy(&wrappedPixel, vram.data(), sizeof(wrappedPixel));
            t.Equals(wrappedPixel, 0x802040E0u,
                     "COLCLAMP=0 should retain the low eight bits of overflowing blend channels");

            std::memcpy(vram.data(), &kColor, sizeof(kColor));
            gs.writeRegister(GS_REG_COLCLAMP, 1ull);
            gs.writeRegister(GS_REG_PRIM, static_cast<uint64_t>(GS_PRIM_POINT) | (1ull << 6));
            gs.writeRegister(GS_REG_RGBAQ, kColor);
            gs.writeRegister(GS_REG_XYZ2, 0ull);

            uint32_t clampedPixel = 0u;
            std::memcpy(&clampedPixel, vram.data(), sizeof(clampedPixel));
            t.Equals(clampedPixel, 0x802040FFu,
                     "COLCLAMP=1 should saturate overflowing blend channels");
        });

        tc.Run("FBA forces the framebuffer alpha high bit on CT32 writes", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            gs.writeRegister(GS_REG_FRAME_1, (1ull << 16));
            gs.writeRegister(GS_REG_ZBUF_1, (1ull) << 32);
            gs.writeRegister(GS_REG_SCISSOR_1, 0ull);
            gs.writeRegister(GS_REG_TEST_1, 0x30000ull);

            gs.writeRegister(GS_REG_PRIM, static_cast<uint64_t>(GS_PRIM_POINT));
            gs.writeRegister(GS_REG_FBA_1, 0ull);
            gs.writeRegister(GS_REG_RGBAQ, 0x01112233ull);
            gs.writeRegister(GS_REG_XYZ2, 0ull);

            uint32_t pixelWithoutFba = 0u;
            std::memcpy(&pixelWithoutFba, vram.data(), sizeof(pixelWithoutFba));
            t.Equals(pixelWithoutFba, 0x01112233u,
                     "without FBA, CT32 writes should preserve the source alpha byte");

            std::memset(vram.data(), 0, sizeof(uint32_t));

            gs.writeRegister(GS_REG_PRIM, static_cast<uint64_t>(GS_PRIM_POINT));
            gs.writeRegister(GS_REG_FBA_1, 1ull);
            gs.writeRegister(GS_REG_RGBAQ, 0x01112233ull);
            gs.writeRegister(GS_REG_XYZ2, 0ull);

            uint32_t pixelWithFba = 0u;
            std::memcpy(&pixelWithFba, vram.data(), sizeof(pixelWithFba));
            t.Equals(pixelWithFba, 0x81112233u,
                     "with FBA enabled, CT32 writes should force the framebuffer alpha high bit");
        });

        tc.Run("CT32 raster writes alias cleanly into later CT32 texture sampling", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint64_t kFrame1 =
                (0ull << 0) |
                (1ull << 16) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kZbuf1 = (1ull << 32);
            constexpr uint64_t kScissor1 =
                (0ull << 0) |
                (1ull << 16) |
                (0ull << 32) |
                (1ull << 48);
            constexpr uint64_t kFrame2 =
                (150ull << 0) |
                (1ull << 16) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kZbuf2 = (1ull << 32);
            constexpr uint64_t kScissor2 = 0ull;
            constexpr uint64_t kTex0_2 =
                (0ull << 0) |
                (1ull << 14) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 20) |
                (0ull << 26) |
                (1ull << 30) |
                (1ull << 34) |
                (1ull << 35);
            constexpr uint64_t kPointPrim = static_cast<uint64_t>(GS_PRIM_POINT);
            constexpr uint64_t kCopyPrim =
                static_cast<uint64_t>(GS_PRIM_SPRITE) |
                (1ull << 4) |
                (1ull << 8) |
                (1ull << 9);
            constexpr uint64_t kSourceColor = 0x80665544ull;
            constexpr uint64_t kPointXyz =
                (0ull << 0) |
                (16ull << 16);
            constexpr uint64_t kUvRow1 =
                (0ull << 0) |
                (16ull << 16);

            gs.writeRegister(GS_REG_FRAME_1, kFrame1);
            gs.writeRegister(GS_REG_ZBUF_1, kZbuf1);
            gs.writeRegister(GS_REG_SCISSOR_1, kScissor1);
            gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
            gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
            gs.writeRegister(GS_REG_PRIM, kPointPrim);
            gs.writeRegister(GS_REG_RGBAQ, kSourceColor);
            gs.writeRegister(GS_REG_XYZ2, kPointXyz);

            gs.writeRegister(GS_REG_FRAME_2, kFrame2);
            gs.writeRegister(GS_REG_ZBUF_2, kZbuf2);
            gs.writeRegister(GS_REG_SCISSOR_2, kScissor2);
            gs.writeRegister(GS_REG_XYOFFSET_2, 0ull);
            gs.writeRegister(GS_REG_TEST_2, 0x30000ull);
            gs.writeRegister(GS_REG_TEX0_2, kTex0_2);
            gs.writeRegister(GS_REG_PRIM, kCopyPrim);
            gs.writeRegister(GS_REG_RGBAQ, 0x80808080ull);
            gs.writeRegister(GS_REG_UV, kUvRow1);
            gs.writeRegister(GS_REG_XYZ2, 0ull);
            gs.writeRegister(GS_REG_UV, kUvRow1);
            gs.writeRegister(GS_REG_XYZ2, 0ull);

            const uint32_t dstPixel = readReferenceFramePSMCT32Pixel(vram, 150u, 1u, 0u, 0u);
            t.Equals(dstPixel, static_cast<uint32_t>(kSourceColor),
                     "CT32 primitives should land in the same local-memory layout that later CT32 texture sampling expects");
        });

        tc.Run("FST sprite 1:1 CT32 copies preserve source texels at the right and bottom edges", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint32_t kTexTbp = 64u;
            constexpr uint64_t kFrame =
                (150ull << 0) |
                (1ull << 16) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kZbuf = (1ull << 32);
            constexpr uint64_t kScissor =
                (0ull << 0) |
                (3ull << 16) |
                (0ull << 32) |
                (3ull << 48);
            constexpr uint64_t kTex0 =
                (static_cast<uint64_t>(kTexTbp) << 0) |
                (1ull << 14) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 20) |
                (2ull << 26) |
                (2ull << 30) |
                (1ull << 34);
            constexpr uint64_t kPrim =
                static_cast<uint64_t>(GS_PRIM_SPRITE) |
                (1ull << 4) |
                (1ull << 8);
            constexpr uint64_t kXyz0 = 0ull;
            constexpr uint64_t kXyz1 =
                (static_cast<uint64_t>(4u << 4) << 0) |
                (static_cast<uint64_t>(4u << 4) << 16);
            constexpr uint64_t kUv0 = 0ull;
            constexpr uint64_t kUv1 =
                ((4ull * 16ull) << 0) |
                ((4ull * 16ull) << 16);
            constexpr uint32_t kSourcePixels[4] = {
                0x800000FFu,
                0x8000FF00u,
                0x80FF0000u,
                0x80FFFFFFu,
            };

            for (uint32_t y = 0u; y < 4u; ++y)
            {
                for (uint32_t x = 0u; x < 4u; ++x)
                {
                    writeReferencePSMCT32Pixel(vram, kTexTbp, 1u, x, y, kSourcePixels[x]);
                }
            }

            gs.writeRegister(GS_REG_FRAME_1, kFrame);
            gs.writeRegister(GS_REG_ZBUF_1, kZbuf);
            gs.writeRegister(GS_REG_SCISSOR_1, kScissor);
            gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
            gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
            gs.writeRegister(GS_REG_ALPHA_1, 0ull);
            gs.writeRegister(GS_REG_TEX0_1, kTex0);
            gs.writeRegister(GS_REG_TEX1_1, 0ull);
            gs.writeRegister(GS_REG_PRIM, kPrim);
            gs.writeRegister(GS_REG_RGBAQ, 0x80808080ull);
            gs.writeRegister(GS_REG_UV, kUv0);
            gs.writeRegister(GS_REG_XYZ2, kXyz0);
            gs.writeRegister(GS_REG_UV, kUv1);
            gs.writeRegister(GS_REG_XYZ2, kXyz1);

            for (uint32_t y = 0u; y < 4u; ++y)
            {
                for (uint32_t x = 0u; x < 4u; ++x)
                {
                    const uint32_t pixel = readReferenceFramePSMCT32Pixel(vram, 150u, 1u, x, y);
                    t.Equals(pixel, kSourcePixels[x],
                             "1:1 FST sprite copies should preserve each source texel without off-by-one edge skew");
                }
            }
        });

        // The GS on-chip CLUT (research/31 section 8/9). TEX0/TEX2 writes with CLD != 0 copy the palette from VRAM
        // into the CLUT buffer at that moment; draws sample the buffer, so re-purposing the palette slot afterwards
        // (SOCOM II rewrites block 0x3852 in CT16 and CT32 form on every frame, and the CT32 write also overlaps the
        // 0x3854 palette) does not reach draws whose palette was loaded before the rewrite. Decoding from live VRAM at
        // draw time -- what both backends did -- reads the other texture's bytes as this texture's palette.
        tc.Run("TEX0 CLD=1 loads the CLUT at the write: rewriting the palette slot afterwards does not change the draw", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint32_t kTexTbp = 64u;
            constexpr uint32_t kCbp = 96u;
            constexpr uint64_t kFrame = (150ull << 0) | (1ull << 16) | (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kZbuf = (1ull << 32);
            constexpr uint64_t kScissor = (0ull << 0) | (3ull << 16) | (0ull << 32) | (3ull << 48);
            constexpr uint64_t kTex0Base =
                (static_cast<uint64_t>(kTexTbp) << 0) | (1ull << 14) | (static_cast<uint64_t>(GS_PSM_T8) << 20) |
                (2ull << 26) | (2ull << 30) | (1ull << 34) | (static_cast<uint64_t>(kCbp) << 37) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 51);
            constexpr uint64_t kPrim = static_cast<uint64_t>(GS_PRIM_SPRITE) | (1ull << 4) | (1ull << 8);
            constexpr uint64_t kXyz1 = (static_cast<uint64_t>(4u << 4) << 0) | (static_cast<uint64_t>(4u << 4) << 16);
            constexpr uint64_t kUv1 = ((4ull * 16ull) << 0) | ((4ull * 16ull) << 16);
            constexpr uint32_t kPaletteA[4] = {0x800000FFu, 0x8000FF00u, 0x80FF0000u, 0x80FFFFFFu};
            constexpr uint32_t kPaletteB[4] = {0x80202020u, 0x80202020u, 0x80202020u, 0x80202020u};

            auto setPalette = [&](uint32_t cbp, const uint32_t (&pal)[4])
            {
                for (uint32_t i = 0u; i < 4u; ++i)
                    gs.WriteVram(GS_PSM_CT32, cbp, 1u, i, 0u, pal[i]);   // entries 0..3: the CSM1 swizzle is identity there
            };
            for (uint32_t y = 0u; y < 4u; ++y)
                for (uint32_t x = 0u; x < 4u; ++x)
                    gs.WriteVram(GS_PSM_T8, kTexTbp, 1u, x, y, x);
            auto draw = [&]()
            {
                gs.writeRegister(GS_REG_PRIM, kPrim);
                gs.writeRegister(GS_REG_RGBAQ, 0x80808080ull);
                gs.writeRegister(GS_REG_UV, 0ull);
                gs.writeRegister(GS_REG_XYZ2, 0ull);
                gs.writeRegister(GS_REG_UV, kUv1);
                gs.writeRegister(GS_REG_XYZ2, kXyz1);
            };
            auto row = [&](const uint32_t (&expect)[4], const char *why)
            {
                for (uint32_t x = 0u; x < 4u; ++x)
                    t.Equals(readReferenceFramePSMCT32Pixel(vram, 150u, 1u, x, 0u), expect[x], why);
            };

            gs.writeRegister(GS_REG_FRAME_1, kFrame);
            gs.writeRegister(GS_REG_ZBUF_1, kZbuf);
            gs.writeRegister(GS_REG_SCISSOR_1, kScissor);
            gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
            gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
            gs.writeRegister(GS_REG_ALPHA_1, 0ull);
            gs.writeRegister(GS_REG_TEX1_1, 0ull);

            setPalette(kCbp, kPaletteA);
            gs.writeRegister(GS_REG_TEX0_1, kTex0Base | (1ull << 61));   // CLD=1: load now
            setPalette(kCbp, kPaletteB);                                 // the slot is re-purposed before the draw
            draw();
            row(kPaletteA, "a draw must sample the CLUT loaded at the TEX0 write, not the bytes the slot holds at draw time");

            gs.writeRegister(GS_REG_TEX0_1, kTex0Base);                  // CLD=0: keep the buffer
            draw();
            row(kPaletteA, "TEX0 with CLD=0 must not reload the CLUT");

            gs.writeRegister(GS_REG_TEX0_1, kTex0Base | (1ull << 61));   // CLD=1 again: reload from the slot
            draw();
            row(kPaletteB, "TEX0 with CLD=1 must reload the CLUT from the slot's current bytes");
        });

        tc.Run("TEX0 CLD=2/4 track CBP0: CLD=4 reloads only when CBP moved off the recorded pointer", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint32_t kTexTbp = 64u;
            constexpr uint32_t kCbp = 96u;
            constexpr uint32_t kCbp2 = 100u;
            constexpr uint64_t kFrame = (150ull << 0) | (1ull << 16) | (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kScissor = (0ull << 0) | (3ull << 16) | (0ull << 32) | (3ull << 48);
            constexpr uint64_t kPrim = static_cast<uint64_t>(GS_PRIM_SPRITE) | (1ull << 4) | (1ull << 8);
            constexpr uint64_t kXyz1 = (static_cast<uint64_t>(4u << 4) << 0) | (static_cast<uint64_t>(4u << 4) << 16);
            constexpr uint64_t kUv1 = ((4ull * 16ull) << 0) | ((4ull * 16ull) << 16);
            constexpr uint32_t kPaletteC[4] = {0x80101010u, 0x80202020u, 0x80303030u, 0x80404040u};
            constexpr uint32_t kPaletteD[4] = {0x80FF00FFu, 0x80FF00FFu, 0x80FF00FFu, 0x80FF00FFu};
            constexpr uint32_t kPaletteE[4] = {0x8000FFFFu, 0x8000FFFFu, 0x8000FFFFu, 0x8000FFFFu};

            auto tex0 = [&](uint32_t cbp, uint64_t cld)
            {
                return (static_cast<uint64_t>(kTexTbp) << 0) | (1ull << 14) | (static_cast<uint64_t>(GS_PSM_T8) << 20) |
                       (2ull << 26) | (2ull << 30) | (1ull << 34) | (static_cast<uint64_t>(cbp) << 37) |
                       (static_cast<uint64_t>(GS_PSM_CT32) << 51) | (cld << 61);
            };
            auto setPalette = [&](uint32_t cbp, const uint32_t (&pal)[4])
            {
                for (uint32_t i = 0u; i < 4u; ++i)
                    gs.WriteVram(GS_PSM_CT32, cbp, 1u, i, 0u, pal[i]);
            };
            for (uint32_t y = 0u; y < 4u; ++y)
                for (uint32_t x = 0u; x < 4u; ++x)
                    gs.WriteVram(GS_PSM_T8, kTexTbp, 1u, x, y, x);
            auto draw = [&]()
            {
                gs.writeRegister(GS_REG_PRIM, kPrim);
                gs.writeRegister(GS_REG_RGBAQ, 0x80808080ull);
                gs.writeRegister(GS_REG_UV, 0ull);
                gs.writeRegister(GS_REG_XYZ2, 0ull);
                gs.writeRegister(GS_REG_UV, kUv1);
                gs.writeRegister(GS_REG_XYZ2, kXyz1);
            };
            auto row = [&](const uint32_t (&expect)[4], const char *why)
            {
                for (uint32_t x = 0u; x < 4u; ++x)
                    t.Equals(readReferenceFramePSMCT32Pixel(vram, 150u, 1u, x, 0u), expect[x], why);
            };

            gs.writeRegister(GS_REG_FRAME_1, kFrame);
            gs.writeRegister(GS_REG_ZBUF_1, 1ull << 32);
            gs.writeRegister(GS_REG_SCISSOR_1, kScissor);
            gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
            gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
            gs.writeRegister(GS_REG_ALPHA_1, 0ull);
            gs.writeRegister(GS_REG_TEX1_1, 0ull);

            setPalette(kCbp, kPaletteC);
            gs.writeRegister(GS_REG_TEX0_1, tex0(kCbp, 2ull));            // CLD=2: load, CBP0 = kCbp
            setPalette(kCbp, kPaletteD);
            gs.writeRegister(GS_REG_TEX0_1, tex0(kCbp, 4ull));            // CLD=4, CBP == CBP0: no reload
            draw();
            row(kPaletteC, "CLD=4 with CBP equal to CBP0 must keep the loaded CLUT");

            setPalette(kCbp2, kPaletteE);
            gs.writeRegister(GS_REG_TEX2_1, tex0(kCbp2, 4ull));           // TEX2 carries the same CLUT fields; CBP moved
            draw();
            row(kPaletteE, "CLD=4 with CBP different from CBP0 must reload from the new slot (via TEX2 too)");
        });

        // A palette that was loaded before keeps its snapshot id when it is loaded again (research/34): the id
        // is part of the GL backend's texture-cache key, and the first cut gave every load whose bytes differed
        // from the *previous* load a fresh serial. SOCOM II's HUD and player skins alternate between palettes
        // on every draw, so each draw got a new key -- 55,000 cache entries and 64,000 texture uploads a second
        // in an online round, the render thread at 2 fps, and the guest clock (timer T0, host-paced minus the
        // render back-pressure) crawling: the players stood in STARTING ROUND 1 OF 11 for good.
        tc.Run("a CLUT re-loaded with the same bytes re-uses its snapshot id (alternating palettes do not mint serials)", [](TestCase &t)
        {
            struct Recorder final : GSRasterBackend   // a CPU backend by composition (GSCpuBackend is final)
            {
                GSCpuBackend inner;
                std::vector<uint64_t> ids;
                void Initialize(uint8_t *vram, uint32_t vramSize) override { inner.Initialize(vram, vramSize); }
                void Reset() override { inner.Reset(); }
                void Submit(const GSPrimitiveBatch &batch) override { inner.Submit(batch); }
                void BeginTransfer(const GSTransferCommand &c) override { inner.BeginTransfer(c); }
                void UploadImage(const uint8_t *d, uint32_t n) override { inner.UploadImage(d, n); }
                void LoadClut(const GSClutLoad &load) override { ids.push_back(load.id); inner.LoadClut(load); }
                void Flush() override { inner.Flush(); }
                void TextureFlush() override { inner.TextureFlush(); }
                void Sync(GSSyncReason r) override { inner.Sync(r); }
                PresentationFrame Present(const GSPresentationRequest &r) override { return inner.Present(r); }
                bool ClearFramebuffer(const GSContext &c, uint32_t rgba) override { return inner.ClearFramebuffer(c, rgba); }
                uint32_t ConsumeLocalToHostBytes(uint8_t *d, uint32_t n) override { return inner.ConsumeLocalToHostBytes(d, n); }
                uint32_t ReadVram(uint32_t psm, uint32_t b, uint32_t bw, uint32_t x, uint32_t y) const override { return inner.ReadVram(psm, b, bw, x, y); }
                void WriteVram(uint32_t psm, uint32_t b, uint32_t bw, uint32_t x, uint32_t y, uint32_t v) override { inner.WriteVram(psm, b, bw, x, y, v); }
                void SnapshotVram(std::vector<uint8_t> &out) const override { inner.SnapshotVram(out); }
                GSTransferSnapshot GetTransferSnapshot() const override { return inner.GetTransferSnapshot(); }
            };
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            auto rec = std::make_unique<Recorder>();
            Recorder *recPtr = rec.get();
            GS gs;
            gs.setRasterBackend(std::move(rec));
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint32_t kTexTbp = 64u;
            constexpr uint32_t kCbp = 96u;
            constexpr uint64_t kFrame = (150ull << 0) | (1ull << 16) | (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kScissor = (0ull << 0) | (3ull << 16) | (0ull << 32) | (3ull << 48);
            constexpr uint64_t kPrim = static_cast<uint64_t>(GS_PRIM_SPRITE) | (1ull << 4) | (1ull << 8);
            constexpr uint64_t kXyz1 = (static_cast<uint64_t>(4u << 4) << 0) | (static_cast<uint64_t>(4u << 4) << 16);
            constexpr uint64_t kUv1 = ((4ull * 16ull) << 0) | ((4ull * 16ull) << 16);
            constexpr uint64_t kTex0Load =
                (static_cast<uint64_t>(kTexTbp) << 0) | (1ull << 14) | (static_cast<uint64_t>(GS_PSM_T8) << 20) |
                (2ull << 26) | (2ull << 30) | (1ull << 34) | (static_cast<uint64_t>(kCbp) << 37) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 51) | (1ull << 61);   // CLD=1
            constexpr uint32_t kPaletteA[4] = {0x800000FFu, 0x8000FF00u, 0x80FF0000u, 0x80FFFFFFu};
            constexpr uint32_t kPaletteB[4] = {0x80202020u, 0x80202020u, 0x80202020u, 0x80202020u};
            auto setPalette = [&](const uint32_t (&pal)[4])
            {
                for (uint32_t i = 0u; i < 4u; ++i)
                    gs.WriteVram(GS_PSM_CT32, kCbp, 1u, i, 0u, pal[i]);
            };
            for (uint32_t y = 0u; y < 4u; ++y)
                for (uint32_t x = 0u; x < 4u; ++x)
                    gs.WriteVram(GS_PSM_T8, kTexTbp, 1u, x, y, x);
            gs.writeRegister(GS_REG_FRAME_1, kFrame);
            gs.writeRegister(GS_REG_ZBUF_1, 1ull << 32);
            gs.writeRegister(GS_REG_SCISSOR_1, kScissor);
            gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
            gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
            gs.writeRegister(GS_REG_ALPHA_1, 0ull);
            gs.writeRegister(GS_REG_TEX1_1, 0ull);
            auto draw = [&]()
            {
                gs.writeRegister(GS_REG_PRIM, kPrim);
                gs.writeRegister(GS_REG_RGBAQ, 0x80808080ull);
                gs.writeRegister(GS_REG_UV, 0ull);
                gs.writeRegister(GS_REG_XYZ2, 0ull);
                gs.writeRegister(GS_REG_UV, kUv1);
                gs.writeRegister(GS_REG_XYZ2, kXyz1);
            };

            setPalette(kPaletteA);
            gs.writeRegister(GS_REG_TEX0_1, kTex0Load);
            setPalette(kPaletteB);
            gs.writeRegister(GS_REG_TEX0_1, kTex0Load);
            setPalette(kPaletteA);
            gs.writeRegister(GS_REG_TEX0_1, kTex0Load);
            draw();
            t.Equals(recPtr->ids.size(), static_cast<size_t>(3u), "three CLD=1 loads reach the backend");
            if (recPtr->ids.size() == 3u)
            {
                t.IsTrue(recPtr->ids[0] != recPtr->ids[1], "two different palettes get two ids");
                t.Equals(recPtr->ids[2], recPtr->ids[0], "palette A loaded again gets its first id back, not a third serial");
            }
            for (uint32_t x = 0u; x < 4u; ++x)
                t.Equals(readReferenceFramePSMCT32Pixel(vram, 150u, 1u, x, 0u), kPaletteA[x], "the draw samples palette A through the re-used snapshot");

            // Ten thousand alternations mint no further ids: the key space stays two entries wide.
            for (int i = 0; i < 10000; ++i)
            {
                setPalette((i & 1) ? kPaletteB : kPaletteA);
                gs.writeRegister(GS_REG_TEX0_1, kTex0Load);
            }
            std::set<uint64_t> distinct(recPtr->ids.begin(), recPtr->ids.end());
            t.Equals(distinct.size(), static_cast<size_t>(2u), "alternating two palettes ten thousand times uses exactly two snapshot ids");
        });

        // The console's own draw list through our GS (research/31 sections 11-12): a PCSX2 GS dump's packet stream
        // replayed through the frontend and the CPU rasteriser -- and, with PS2X_CONSOLE_REPLAY_GL=1, the OpenGL
        // backend on a hidden raylib window as well (no window in CI: R109) -- then each frame scored against
        // PCSX2's own screenshot of that state, the one pixel guard a GL change has that needs no launch.
        //
        // The fixture is game bytes and never enters the tree: python tools_py/gsdump_extract.py <dump.gs>
        // game/console_replay writes vram_initial.bin (4 MiB), packets.bin ([u32 path][u32 size][bytes]...) and
        // reference.ppm (the screenshot) from a capture under tools/pcsx2/snaps/; the case looks there
        // (../../../../game/console_replay from the build tree, or the main tree's) or at PS2X_CONSOLE_REPLAY_DIR,
        // and says so when it finds nothing. From Sprint 6 to Sprint 10 this case returned at once because
        // nothing set the variable and the hand-cut dump was lost (KNOWN section 4): a case that never runs is
        // coverage on paper only.
        //
        // The bars, measured 2026-09-21 on the spawn dump (20260916033728_(2).gs, 5386 packets, frames 0-1):
        // CPU frame vs the screenshot mean |diff| 9.1, GL 10.2 (the 480-row screenshot resampled to the 448-row
        // frame), GL vs CPU 7.6 (bilinear against nearest, the dither). Sprint 6's 1.73x-dark frame (research/31
        // section 12) would have read about 27 against the picture. Diagnostics kept: PS2X_CONSOLE_REPLAY_STOP=<n>
        // replays only the first n packets, _FBP=<fbp> picks the frame buffer (default 0x8c), _PIXEL=x,y prints
        // that pixel's history on the CPU pass; the frames are written beside the fixture as PPMs.
        tc.Run("console GS dump replays through the CPU rasteriser to the console's own picture (game/console_replay or PS2X_CONSOLE_REPLAY_DIR)", [](TestCase &t)
        {
            std::string fixture;
            {
                std::vector<std::string> candidates;
                if (const char *env = std::getenv("PS2X_CONSOLE_REPLAY_DIR"); env && *env)
                    candidates.emplace_back(env);
                candidates.emplace_back("../../../../game/console_replay");
                candidates.emplace_back("C:/projects/socom_pc/game/console_replay");
                for (const std::string &c : candidates)
                    if (FILE *fp = std::fopen((c + "/packets.bin").c_str(), "rb"))
                    {
                        std::fclose(fp);
                        fixture = c;
                        break;
                    }
            }
            if (fixture.empty())
            {
                std::printf("console replay: skipped -- no fixture (python tools_py/gsdump_extract.py <dump.gs> game/console_replay)\n");
                return;
            }
            const char *dir = fixture.c_str();
            const double kBarAgainstPicture = 16.0;   // mean |diff| per channel, 0..255; measured 9.1 (CPU) / 10.2 (GL)
            const double kBarGlAgainstCpu = 12.0;     // measured 7.6
            std::vector<uint8_t> vramInitial(PS2_GS_VRAM_SIZE, 0u);
            {
                FILE *fp = std::fopen((std::string(dir) + "/vram_initial.bin").c_str(), "rb");
                t.IsTrue(fp != nullptr, "vram_initial.bin opens");
                if (!fp)
                    return;
                const size_t got = std::fread(vramInitial.data(), 1, vramInitial.size(), fp);
                std::fclose(fp);
                t.Equals(static_cast<uint32_t>(got), static_cast<uint32_t>(PS2_GS_VRAM_SIZE), "vram_initial.bin is 4 MiB");
            }
            std::vector<uint8_t> stream;
            {
                FILE *fp = std::fopen((std::string(dir) + "/packets.bin").c_str(), "rb");
                t.IsTrue(fp != nullptr, "packets.bin opens");
                if (!fp)
                    return;
                std::fseek(fp, 0, SEEK_END);
                const long n = std::ftell(fp);
                std::fseek(fp, 0, SEEK_SET);
                stream.resize(static_cast<size_t>(n));
                const size_t got = std::fread(stream.data(), 1, stream.size(), fp);
                std::fclose(fp);
                t.Equals(static_cast<uint32_t>(got), static_cast<uint32_t>(stream.size()), "packets.bin read");
            }
            const long stopAt = std::getenv("PS2X_CONSOLE_REPLAY_STOP") ? std::strtol(std::getenv("PS2X_CONSOLE_REPLAY_STOP"), nullptr, 0) : -1L;
            const uint32_t fbp = std::getenv("PS2X_CONSOLE_REPLAY_FBP") ? static_cast<uint32_t>(std::strtoul(std::getenv("PS2X_CONSOLE_REPLAY_FBP"), nullptr, 0)) : 0x8cu;
            const bool wantGl = std::getenv("PS2X_CONSOLE_REPLAY_GL") != nullptr;
            // reference.ppm: PCSX2's screenshot of the dumped state, P6, any size (640x480 for these captures).
            uint32_t refW = 0, refH = 0;
            std::vector<uint8_t> reference;
            if (FILE *fp = std::fopen((std::string(dir) + "/reference.ppm").c_str(), "rb"))
            {
                uint32_t maxval = 0;
                if (std::fscanf(fp, "P6 %u %u %u", &refW, &refH, &maxval) == 3 && maxval == 255u && refW && refH)
                {
                    std::fgetc(fp);   // the single whitespace after maxval
                    reference.resize(static_cast<size_t>(refW) * refH * 3u);
                    if (std::fread(reference.data(), 1, reference.size(), fp) != reference.size())
                        reference.clear();
                }
                std::fclose(fp);
            }
            t.IsTrue(!reference.empty(), "reference.ppm (the console's own picture) is beside the fixture -- regenerate it with gsdump_extract.py");
            // Mean |difference| per channel between a 640x448 frame and an image of any height (rows resampled linearly).
            auto meanDiffAgainst = [](const std::vector<uint8_t> &frame, const std::vector<uint8_t> &img, uint32_t imgW, uint32_t imgH)
            {
                if (img.empty() || imgW != 640u)
                    return -1.0;
                double total = 0.0;
                for (uint32_t y = 0; y < 448u; ++y)
                {
                    const double fy = (y + 0.5) * imgH / 448.0 - 0.5;
                    const uint32_t y0 = static_cast<uint32_t>(fy < 0.0 ? 0.0 : fy);
                    const uint32_t y1 = (y0 + 1u < imgH) ? y0 + 1u : y0;
                    const double tt = fy < 0.0 ? 0.0 : fy - y0;
                    const uint8_t *a = frame.data() + static_cast<size_t>(y) * 640u * 3u;
                    const uint8_t *r0 = img.data() + static_cast<size_t>(y0) * imgW * 3u;
                    const uint8_t *r1 = img.data() + static_cast<size_t>(y1) * imgW * 3u;
                    for (uint32_t i = 0; i < 640u * 3u; ++i)
                        total += std::fabs(a[i] - (r0[i] * (1.0 - tt) + r1[i] * tt));
                }
                return total / (640.0 * 448.0 * 3.0);
            };
            std::vector<uint8_t> cpuFrame, glFrame;

            auto setBackend = [](const char *which)
            {
#ifdef _WIN32
                _putenv_s("PS2X_GS_BACKEND", which);
#else
                setenv("PS2X_GS_BACKEND", which, 1);
#endif
            };
            uint32_t watchX = 0, watchY = 0;
            const bool pixelWatch = std::getenv("PS2X_CONSOLE_REPLAY_PIXEL") &&
                                    std::sscanf(std::getenv("PS2X_CONSOLE_REPLAY_PIXEL"), "%u,%u", &watchX, &watchY) == 2;
            auto render = [&](bool useGl)
            {
                uint32_t lastPx = 0xFFFFFFFFu;
                setBackend(useGl ? "gpu" : "cpu");
                std::vector<uint8_t> vram(vramInitial);
                GS gs;
                gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);
                size_t off = 0, packets = 0;
                while (off + 8 <= stream.size())
                {
                    uint32_t path = 0, size = 0;
                    std::memcpy(&path, stream.data() + off, 4);
                    std::memcpy(&size, stream.data() + off + 4, 4);
                    off += 8;
                    if (off + size > stream.size())
                        break;
                    gs.processGIFPacket(stream.data() + off, size);
                    off += size;
                    ++packets;
                    // PS2X_CONSOLE_REPLAY_PIXEL=x,y: on the CPU pass, print every packet that changes that frame pixel
                    // (fbp from PS2X_CONSOLE_REPLAY_FBP) with the packet's leading GIF tag and A+D TEX0 -- a pixel history.
                    if (!useGl && pixelWatch)
                    {
                        const uint32_t px = readReferenceFramePSMCT32Pixel(vram, fbp, 10u, watchX, watchY) & 0xFFFFFFu;
                        if (px != lastPx)
                        {
                            uint64_t tagLo = 0, tex0 = 0, prim = 0;
                            std::memcpy(&tagLo, stream.data() + off - size, 8);
                            for (uint32_t k = 16; k + 16 <= size && k < 16 * 40; k += 16)
                            {
                                uint64_t lo = 0, hi = 0;
                                std::memcpy(&lo, stream.data() + off - size + k, 8);
                                std::memcpy(&hi, stream.data() + off - size + k + 8, 8);
                                if ((hi & 0xFF) == 0x06 && tex0 == 0) tex0 = lo;
                                if ((hi & 0xFF) == 0x00 && prim == 0) prim = lo;
                            }
                            std::printf("pixel(%u,%u) packet %zu size %u: %06x -> %06x  tag=%016llx tex0=%016llx prim=%llx tagprim=%llx\n",
                                        watchX, watchY, packets, size, lastPx, px, (unsigned long long)tagLo, (unsigned long long)tex0,
                                        (unsigned long long)prim, (unsigned long long)((tagLo >> 47) & 0x7FF));
                            lastPx = px;
                        }
                    }
                    if (stopAt >= 0 && static_cast<long>(packets) >= stopAt)
                        break;
                }
                if (useGl)
                {
                    gs.hostRenderFrame();
                    gs.refreshDisplaySnapshot();   // Sync(DebugReadback) inline on this (render) thread + SnapshotVram
                    uint32_t snapSize = 0u;
                    const uint8_t *snap = gs.lockDisplaySnapshot(snapSize);
                    if (snap && snapSize >= vram.size())
                        std::memcpy(vram.data(), snap, vram.size());
                    gs.unlockDisplaySnapshot();
                }
                t.IsTrue(packets > 0u, "the fixture holds packets");
                std::vector<uint8_t> &frame = useGl ? glFrame : cpuFrame;
                frame.resize(640u * 448u * 3u);
                size_t lit = 0;
                for (uint32_t y = 0; y < 448u; ++y)
                    for (uint32_t x = 0; x < 640u; ++x)
                    {
                        const uint32_t px = readReferenceFramePSMCT32Pixel(vram, fbp, 10u, x, y);
                        uint8_t *rgb = frame.data() + (static_cast<size_t>(y) * 640u + x) * 3u;
                        rgb[0] = static_cast<uint8_t>(px & 0xFFu);
                        rgb[1] = static_cast<uint8_t>((px >> 8) & 0xFFu);
                        rgb[2] = static_cast<uint8_t>((px >> 16) & 0xFFu);
                        lit += (px & 0xFFFFFFu) != 0u;
                    }
                const double vsPicture = meanDiffAgainst(frame, reference, refW, refH);
                std::printf("console replay: %zu packets (%s), %.1f%% of the frame lit, mean |diff| vs the console's picture %.2f\n",
                            packets, useGl ? "gl" : "cpu", 100.0 * lit / (640.0 * 448.0), vsPicture);
                if (stopAt < 0)   // a truncated replay (_STOP) is a diagnostic, not the frame
                    t.IsTrue(lit >= static_cast<size_t>(640u * 448u * 9u / 10u), useGl ? "the GL frame is drawn (nine tenths lit)" : "the CPU frame is drawn (nine tenths lit)");
                if (!reference.empty() && stopAt < 0)
                    t.IsTrue(vsPicture <= kBarAgainstPicture, useGl ? "the GL frame is within the bar of the console's own picture (mean |diff| <= 16)"
                                                                     : "the CPU frame is within the bar of the console's own picture (mean |diff| <= 16)");
                const std::string outPath = std::string(dir) + (useGl ? "/frame_gl_fbp" : "/frame_fbp") + std::to_string(fbp) + ".ppm";
                if (FILE *fp = std::fopen(outPath.c_str(), "wb"))
                {
                    std::fprintf(fp, "P6\n640 448\n255\n");
                    std::fwrite(frame.data(), 1, frame.size(), fp);
                    std::fclose(fp);
                }
            };
            render(false);
            if (wantGl)
            {
                SetConfigFlags(FLAG_WINDOW_HIDDEN);
                InitWindow(640, 448, "console replay");
                render(true);
                CloseWindow();
                const double glVsCpu = meanDiffAgainst(glFrame, cpuFrame, 640u, 448u);
                std::printf("console replay: GL vs CPU mean |diff| %.2f\n", glVsCpu);
                if (stopAt < 0)
                    t.IsTrue(glVsCpu >= 0.0 && glVsCpu <= kBarGlAgainstCpu, "the GL frame is within the bar of the CPU frame on identical input (mean |diff| <= 12)");
            }
            setBackend("cpu");
        });

        tc.Run("SOCOM II exposure readback reads the 1x4 frame pixels the guest's VIF1 packet names", [](TestCase &t)
        {
            // The packet FUN_003b24c0 sends (7 quadwords): two VIF codes, a GIF tag, then A+D BITBLTBUF / TRXPOS /
            // TRXREG / TRXDIR, as the console dump records it (research/31 section 12: sbp 0x1180 fbw 10 CT32, 1x4
            // at (317, 430), local -> host).
            uint8_t packet[7 * 16] = {};
            auto ad = [&](int qw, uint64_t value, uint8_t reg)
            {
                std::memcpy(packet + qw * 16, &value, 8);
                const uint64_t hi = reg;
                std::memcpy(packet + qw * 16 + 8, &hi, 8);
            };
            ad(3, 0x00000000000a1180ull, 0x50);
            ad(4, 0x0000000001ae013dull, 0x51);
            ad(5, 0x0000000400000001ull, 0x52);
            ad(6, 0x0000000000000001ull, 0x53);

            socom2_lum::Transfer tr;
            t.IsTrue(socom2_lum::parseTransfer(packet, 7, tr), "the packet's TRXDIR is found");
            t.Equals(tr.sbp, 0x1180u, "BITBLTBUF sbp");
            t.Equals(tr.sbw, 10u, "BITBLTBUF sbw");
            t.Equals(tr.spsm, 0u, "BITBLTBUF spsm (CT32)");
            t.Equals(tr.ssax, 317u, "TRXPOS ssax");
            t.Equals(tr.ssay, 430u, "TRXPOS ssay");
            t.Equals(tr.rrw, 1u, "TRXREG rrw (a column)");
            t.Equals(tr.rrh, 4u, "TRXREG rrh");
            t.Equals(tr.dir, 1u, "TRXDIR local -> host");

            std::vector<std::array<uint32_t, 5>> reads;
            uint8_t out[16] = {};
            const size_t n = socom2_lum::readbackPixels(packet, 7, [&](uint32_t psm, uint32_t bp, uint32_t bw, uint32_t x, uint32_t y)
            {
                reads.push_back({psm, bp, bw, x, y});
                return (x & 0xFFu) | ((y & 0xFFu) << 8) | (0xAAu << 24);   // R = x, G = y, A = 0xAA
            }, out, sizeof(out));
            t.Equals(static_cast<uint32_t>(n), 16u, "four CT32 pixels = one quadword, what the reverse DMA delivered");
            t.Equals(static_cast<uint32_t>(reads.size()), 4u, "one GS read per pixel");
            t.Equals(reads[0][0], 0u, "reads use the source psm");
            t.Equals(reads[0][1], 0x1180u, "reads use the source block pointer");
            t.Equals(reads[0][2], 10u, "reads use the source buffer width");
            t.Equals(reads[0][3], 317u, "first pixel x");
            t.Equals(reads[3][3], 317u, "fourth pixel x (same column)");
            t.Equals(reads[0][4], 430u, "first pixel y");
            t.Equals(reads[3][4], 433u, "fourth pixel y");
            t.Equals(static_cast<uint32_t>(out[0]), 317u & 0xFFu, "out[0] is the first pixel's R (what the caller takes)");
            t.Equals(static_cast<uint32_t>(out[1]), 430u & 0xFFu, "out[1] is its G");
            t.Equals(static_cast<uint32_t>(out[3]), 0xAAu, "out[3] is its A");
            t.Equals(static_cast<uint32_t>(out[5]), 431u & 0xFFu, "the second pixel (next row) follows in memory order");
        });

        tc.Run("SOCOM II box-frustum cull: the eight corners' CLIP judgements AND and OR the way FUN_00294ac0 does", [](TestCase &t)
        {
            // FUN_00294ac0 (research/31 section 16) runs each of eight box corners through a 4x4 (vf4..vf7 are the
            // matrix ROWS applied as clip = vf4*x + vf5*y + vf6*z + vf7*w), CLIPs the result against its own w and
            // ANDs / ORs the six judgement bits (bit0 x>+w, bit1 x<-w, bit2/3 y, bit4/5 z). An identity matrix
            // makes the corners their own clip coordinates.
            float m[16] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
            float inside[8][4], left[8][4], straddle[8][4];
            for (int i = 0; i < 8; ++i)
            {
                const float sx = (i & 1) ? 1.0f : -1.0f, sy = (i & 2) ? 1.0f : -1.0f, sz = (i & 4) ? 1.0f : -1.0f;
                inside[i][0] = 0.5f * sx; inside[i][1] = 0.5f * sy; inside[i][2] = 0.5f * sz; inside[i][3] = 1.0f;
                left[i][0] = -3.0f + 0.5f * sx; left[i][1] = 0.5f * sy; left[i][2] = 0.5f * sz; left[i][3] = 1.0f;
                straddle[i][0] = -1.0f + 0.5f * sx; straddle[i][1] = 0.5f * sy; straddle[i][2] = 0.5f * sz; straddle[i][3] = 1.0f;
            }
            uint32_t andMask = 0xFFu, orMask = 0xFFu;
            socom2_cull::boxClipMasks(m, inside, andMask, orMask);
            t.IsTrue(andMask == 0u && orMask == 0u, "a box inside every plane judges nothing");
            socom2_cull::boxClipMasks(m, left, andMask, orMask);
            t.IsTrue(andMask == 0x02u, "a box wholly beyond -x has bit 1 set in every corner (culled)");
            t.IsTrue(orMask == 0x02u, "... and nothing else");
            socom2_cull::boxClipMasks(m, straddle, andMask, orMask);
            t.IsTrue(andMask == 0u, "a box straddling the -x plane is not culled");
            t.IsTrue(orMask == 0x02u, "... but is marked partial on that plane");
            // The guest packs AND in the low byte and OR << 8, as FUN_00294ac0 returns them.
            t.IsTrue(socom2_cull::packResult(0u, 0x02u) == 0x200u, "packResult puts OR in bits 8..13");
        });

        tc.Run("SOCOM II exposure readback syncs the GPU at most once per interval", [](TestCase &t)
        {
            t.IsTrue(socom2_lum::syncDue(5000, 0), "the first readback syncs");
            t.IsTrue(!socom2_lum::syncDue(5050, 5000), "50 ms later it reads the synced copy");
            t.IsTrue(socom2_lum::syncDue(5100, 5000), "100 ms later it syncs again");
            t.IsTrue(socom2_lum::syncDue(100, 5000), "a clock that went backwards syncs rather than waits");
        });

        tc.Run("SOCOM II exposure readback ignores a packet that is not a local -> host transfer", [](TestCase &t)
        {
            uint8_t packet[7 * 16] = {};
            uint8_t out[16] = {0x11, 0x22, 0x33, 0x44};
            const size_t n = socom2_lum::readbackPixels(packet, 7, [](uint32_t, uint32_t, uint32_t, uint32_t, uint32_t) { return 0u; }, out, sizeof(out));
            t.Equals(static_cast<uint32_t>(n), 0u, "no TRXDIR: nothing read");
            t.Equals(static_cast<uint32_t>(out[0]), 0x11u, "out untouched");
        });

        // Diagnostic (research/31 section 15): feed a vu1_replay packet file (records of u32 length + GIF packet) through
        // the frontend with a recording backend and print the alpha of every submitted vertex per bound TEX0 block --
        // whether the frontend keeps the zero alphas the VU1 program kicks. PS2X_PK_REPLAY=<file.pk>.
        tc.Run("vu1_replay packets through the frontend keep their vertex alphas (PS2X_PK_REPLAY)", [](TestCase &t)
        {
            const char *path = std::getenv("PS2X_PK_REPLAY");
            if (!path)
                return;
            struct Recorder final : GSRasterBackend   // a CPU backend by composition (GSCpuBackend is final)
            {
                GSCpuBackend inner;
                std::map<uint32_t, std::map<int, int>> alphas;   // tbp0 -> alpha -> count
                void Initialize(uint8_t *vram, uint32_t vramSize) override { inner.Initialize(vram, vramSize); }
                void Reset() override { inner.Reset(); }
                void Submit(const GSPrimitiveBatch &batch) override
                {
                    for (uint8_t k = 0; k < batch.vertexCount; ++k)
                        alphas[batch.state.context.tex0.tbp0][batch.vertices[k].a] += 1;
                    inner.Submit(batch);
                }
                void BeginTransfer(const GSTransferCommand &c) override { inner.BeginTransfer(c); }
                void UploadImage(const uint8_t *d, uint32_t n) override { inner.UploadImage(d, n); }
                void Flush() override { inner.Flush(); }
                void TextureFlush() override { inner.TextureFlush(); }
                void Sync(GSSyncReason r) override { inner.Sync(r); }
                PresentationFrame Present(const GSPresentationRequest &r) override { return inner.Present(r); }
                bool ClearFramebuffer(const GSContext &c, uint32_t rgba) override { return inner.ClearFramebuffer(c, rgba); }
                uint32_t ConsumeLocalToHostBytes(uint8_t *d, uint32_t n) override { return inner.ConsumeLocalToHostBytes(d, n); }
                uint32_t ReadVram(uint32_t psm, uint32_t b, uint32_t bw, uint32_t x, uint32_t y) const override { return inner.ReadVram(psm, b, bw, x, y); }
                void WriteVram(uint32_t psm, uint32_t b, uint32_t bw, uint32_t x, uint32_t y, uint32_t v) override { inner.WriteVram(psm, b, bw, x, y, v); }
                void SnapshotVram(std::vector<uint8_t> &out) const override { inner.SnapshotVram(out); }
                GSTransferSnapshot GetTransferSnapshot() const override { return inner.GetTransferSnapshot(); }
            };
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            auto rec = std::make_unique<Recorder>();
            Recorder *recPtr = rec.get();
            GS gs;
            gs.setRasterBackend(std::move(rec));
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);
            FILE *fp = std::fopen(path, "rb");
            t.IsTrue(fp != nullptr, "packet file opens");
            if (!fp)
                return;
            std::vector<uint8_t> file;
            std::fseek(fp, 0, SEEK_END);
            file.resize(static_cast<size_t>(std::ftell(fp)));
            std::fseek(fp, 0, SEEK_SET);
            (void)std::fread(file.data(), 1, file.size(), fp);
            std::fclose(fp);
            size_t off = 0, packets = 0;
            while (off + 4 <= file.size())
            {
                uint32_t n = 0;
                std::memcpy(&n, file.data() + off, 4);
                off += 4;
                if (off + n > file.size())
                    break;
                gs.processGIFPacket(file.data() + off, n);
                off += n;
                ++packets;
            }
            std::printf("pk replay: %zu packets\n", packets);
            for (const auto &kv : recPtr->alphas)
            {
                std::printf("  tbp0=%05x:", kv.first);
                for (const auto &ac : kv.second)
                    std::printf(" %d:%d", ac.first, ac.second);
                std::printf("\n");
            }
        });

        tc.Run("fullscreen display copy tracks the preferred presentation source frame", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint64_t kFrame2 =
                150ull |
                (10ull << 16) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kScissor2 =
                (0ull << 0) |
                (639ull << 16) |
                (0ull << 32) |
                (479ull << 48);
            constexpr uint64_t kXYOffset2 =
                (static_cast<uint64_t>(1728u << 4) << 0) |
                (static_cast<uint64_t>(1808u << 4) << 32);
            constexpr uint64_t kAlpha2 = 0x6000000064ull;
            constexpr uint64_t kTest2 = 0x30000ull;
            constexpr uint64_t kTex0_2 =
                (0ull << 0) |
                (10ull << 14) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 20) |
                (10ull << 26) |
                (9ull << 30) |
                (1ull << 34);
            constexpr uint64_t kPrimCopy =
                static_cast<uint64_t>(GS_PRIM_SPRITE) |
                (1ull << 4) |
                (1ull << 6) |
                (1ull << 8) |
                (1ull << 9);
            constexpr uint64_t kXyz0 =
                (static_cast<uint64_t>(1728u << 4) << 0) |
                (static_cast<uint64_t>(1808u << 4) << 16) |
                (256ull << 32);
            constexpr uint64_t kXyz1 =
                (static_cast<uint64_t>(2368u << 4) << 0) |
                (static_cast<uint64_t>(2288u << 4) << 16) |
                (256ull << 32);
            constexpr uint64_t kUv0 =
                (8ull << 0) |
                (8ull << 16);
            constexpr uint64_t kUv1 =
                ((8ull + (640ull * 16ull)) << 0) |
                ((8ull + (480ull * 16ull)) << 16);

            gs.writeRegister(GS_REG_FRAME_2, kFrame2);
            gs.writeRegister(GS_REG_SCISSOR_2, kScissor2);
            gs.writeRegister(GS_REG_XYOFFSET_2, kXYOffset2);
            gs.writeRegister(GS_REG_ALPHA_2, kAlpha2);
            gs.writeRegister(GS_REG_TEST_2, kTest2);
            gs.writeRegister(GS_REG_TEX0_2, kTex0_2);
            gs.writeRegister(GS_REG_PRIM, kPrimCopy);
            gs.writeRegister(GS_REG_RGBAQ, 0x80808080ull);
            gs.writeRegister(GS_REG_UV, kUv0);
            gs.writeRegister(GS_REG_XYZ2, kXyz0);
            gs.writeRegister(GS_REG_UV, kUv1);
            gs.writeRegister(GS_REG_XYZ2, kXyz1);

            GSFrameReg preferredSource{};
            uint32_t preferredDestFbp = 0u;
            t.IsTrue(gs.getPreferredDisplaySource(preferredSource, preferredDestFbp),
                     "fullscreen display-copy sprites should record their source frame for host presentation");
            t.Equals(preferredDestFbp, 150u,
                     "preferred presentation tracking should target the copied display page");
            t.Equals(preferredSource.fbp, 0u,
                     "preferred presentation tracking should expose the copy source frame base");
            t.Equals(preferredSource.fbw, 10u,
                     "preferred presentation tracking should expose the copy source width");
            t.Equals(static_cast<uint32_t>(preferredSource.psm), static_cast<uint32_t>(GS_PSM_CT32),
                     "preferred presentation tracking should expose the copy source format");

            gs.writeRegister(GS_REG_PRIM, static_cast<uint64_t>(GS_PRIM_POINT) | (1ull << 9));
            gs.writeRegister(GS_REG_RGBAQ, 0xFFFFFFFFull);
            gs.writeRegister(GS_REG_XYZ2, kXyz0);

            t.IsFalse(gs.getPreferredDisplaySource(preferredSource, preferredDestFbp),
                      "non-copy primitives that touch the display target should invalidate the preferred presentation source");
        });

        tc.Run("latched host presentation frame stays stable until the next latch", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GSRegisters regs{};
            regs.pmode = 1ull;
            regs.dispfb1 =
                150ull |
                (10ull << 9) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 15);
            regs.display1 =
                (639ull << 32) |
                (447ull << 44);

            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), &regs);

            constexpr uint32_t kDisplayPixel = 0x00332211u;
            constexpr uint32_t kSourcePixel = 0x00665544u;
            constexpr uint32_t kUpdatedSourcePixel = 0x00998877u;
            writeReferenceFramePSMCT32Pixel(vram, 150u, 10u, 0u, 0u, kDisplayPixel);
            std::memcpy(vram.data() + 0u, &kSourcePixel, sizeof(kSourcePixel));

            constexpr uint64_t kFrame2 =
                150ull |
                (10ull << 16) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kZbuf2 = (1ull << 32);
            constexpr uint64_t kScissor2 =
                (0ull << 0) |
                (639ull << 16) |
                (0ull << 32) |
                (479ull << 48);
            constexpr uint64_t kXYOffset2 =
                (static_cast<uint64_t>(1728u << 4) << 0) |
                (static_cast<uint64_t>(1808u << 4) << 32);
            constexpr uint64_t kAlpha2 = 0x6000000064ull;
            constexpr uint64_t kTest2 = 0x30000ull;
            constexpr uint64_t kTex0_2 =
                (0ull << 0) |
                (10ull << 14) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 20) |
                (10ull << 26) |
                (9ull << 30) |
                (1ull << 34);
            constexpr uint64_t kPrimCopy =
                static_cast<uint64_t>(GS_PRIM_SPRITE) |
                (1ull << 4) |
                (1ull << 6) |
                (1ull << 8) |
                (1ull << 9);
            constexpr uint64_t kXyz0 =
                (static_cast<uint64_t>(1728u << 4) << 0) |
                (static_cast<uint64_t>(1808u << 4) << 16) |
                (256ull << 32);
            constexpr uint64_t kXyz1 =
                (static_cast<uint64_t>(2368u << 4) << 0) |
                (static_cast<uint64_t>(2288u << 4) << 16) |
                (256ull << 32);
            constexpr uint64_t kUv0 =
                (8ull << 0) |
                (8ull << 16);
            constexpr uint64_t kUv1 =
                ((8ull + (640ull * 16ull)) << 0) |
                ((8ull + (480ull * 16ull)) << 16);

            gs.writeRegister(GS_REG_FRAME_2, kFrame2);
            gs.writeRegister(GS_REG_ZBUF_2, kZbuf2);
            gs.writeRegister(GS_REG_SCISSOR_2, kScissor2);
            gs.writeRegister(GS_REG_XYOFFSET_2, kXYOffset2);
            gs.writeRegister(GS_REG_ALPHA_2, kAlpha2);
            gs.writeRegister(GS_REG_TEST_2, kTest2);
            gs.writeRegister(GS_REG_TEX0_2, kTex0_2);
            gs.writeRegister(GS_REG_PRIM, kPrimCopy);
            gs.writeRegister(GS_REG_RGBAQ, 0x80808080ull);
            gs.writeRegister(GS_REG_UV, kUv0);
            gs.writeRegister(GS_REG_XYZ2, kXyz0);
            gs.writeRegister(GS_REG_UV, kUv1);
            gs.writeRegister(GS_REG_XYZ2, kXyz1);

            gs.latchHostPresentationFrame();

            std::vector<uint8_t> latchedFrame;
            uint32_t latchedWidth = 0u;
            uint32_t latchedHeight = 0u;
            uint32_t displayFbp = 0u;
            uint32_t sourceFbp = 0u;
            bool usedPreferred = false;
            t.IsTrue(gs.copyLatchedHostPresentationFrame(latchedFrame,
                                                         latchedWidth,
                                                         latchedHeight,
                                                         &displayFbp,
                                                         &sourceFbp,
                                                         &usedPreferred),
                     "host presentation latch should produce a readable frame");
            t.Equals(displayFbp, 150u,
                     "latched host presentation should remember the selected display page");
            t.Equals(sourceFbp, 0u,
                     "latched host presentation should switch to the fullscreen copy source");
            t.IsTrue(usedPreferred,
                     "latched host presentation should record when it used the preferred copy source");
            t.Equals(latchedWidth, 640u,
                     "latched host presentation should preserve display width");
            t.Equals(latchedHeight, 448u,
                     "latched host presentation should preserve display height");
            t.Equals(static_cast<uint32_t>(latchedFrame[0]), 0x44u,
                     "latched host presentation should expose the source frame RGB data");
            t.Equals(static_cast<uint32_t>(latchedFrame[1]), 0x55u,
                     "latched host presentation should preserve the source frame green channel");
            t.Equals(static_cast<uint32_t>(latchedFrame[2]), 0x66u,
                     "latched host presentation should preserve the source frame blue channel");
            t.Equals(static_cast<uint32_t>(latchedFrame[3]), 0xFFu,
                     "latched host presentation should normalize framebuffer alpha for host upload");

            std::memcpy(vram.data() + 0u, &kUpdatedSourcePixel, sizeof(kUpdatedSourcePixel));

            std::vector<uint8_t> staleFrame;
            uint32_t staleWidth = 0u;
            uint32_t staleHeight = 0u;
            t.IsTrue(gs.copyLatchedHostPresentationFrame(staleFrame, staleWidth, staleHeight),
                     "latched host presentation should remain readable without relatching");
            t.Equals(static_cast<uint32_t>(staleFrame[0]), 0x44u,
                     "latched host presentation should stay stable until the next latch");

            gs.latchHostPresentationFrame();

            std::vector<uint8_t> refreshedFrame;
            uint32_t refreshedWidth = 0u;
            uint32_t refreshedHeight = 0u;
            t.IsTrue(gs.copyLatchedHostPresentationFrame(refreshedFrame, refreshedWidth, refreshedHeight),
                     "latched host presentation should refresh after a new latch");
            t.Equals(static_cast<uint32_t>(refreshedFrame[0]), 0x77u,
                     "relatching should pick up the updated source frame contents");
        });

        tc.Run("latched host presentation frame is returned tightly packed for narrower display widths", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GSRegisters regs{};
            regs.pmode = 1ull;
            regs.dispfb1 =
                150ull |
                (1ull << 9) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 15);
            regs.display1 =
                (63ull << 32) |
                (63ull << 44);

            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), &regs);

            constexpr uint32_t kTopLeft = 0xFF332211u;
            constexpr uint32_t kTopRight = 0xFF665544u;
            constexpr uint32_t kBottomLeft = 0xFF998877u;
            constexpr uint32_t kBottomRight = 0xFFCCBBAAu;
            writeReferenceFramePSMCT32Pixel(vram, 150u, 1u, 0u, 0u, kTopLeft);
            writeReferenceFramePSMCT32Pixel(vram, 150u, 1u, 1u, 0u, kTopRight);
            writeReferenceFramePSMCT32Pixel(vram, 150u, 1u, 0u, 1u, kBottomLeft);
            writeReferenceFramePSMCT32Pixel(vram, 150u, 1u, 1u, 1u, kBottomRight);

            gs.latchHostPresentationFrame();

            std::vector<uint8_t> latchedFrame;
            uint32_t latchedWidth = 0u;
            uint32_t latchedHeight = 0u;
            t.IsTrue(gs.copyLatchedHostPresentationFrame(latchedFrame, latchedWidth, latchedHeight),
                     "latched host presentation should be readable for narrow display widths");
            t.Equals(latchedWidth, 64u,
                     "latched host presentation should preserve the decoded display width");
            t.Equals(latchedHeight, 64u,
                     "latched host presentation should preserve the decoded display height");
            t.Equals(static_cast<uint32_t>(latchedFrame.size()), 64u * 64u * 4u,
                     "latched host presentation should return a tightly packed RGBA buffer");

            uint32_t pixel = 0u;
            std::memcpy(&pixel, latchedFrame.data() + 0u, sizeof(pixel));
            t.Equals(pixel, kTopLeft,
                     "latched host presentation should keep the first row intact");
            std::memcpy(&pixel, latchedFrame.data() + 4u, sizeof(pixel));
            t.Equals(pixel, kTopRight,
                     "latched host presentation should pack the first row contiguously");
            std::memcpy(&pixel, latchedFrame.data() + (64u * 4u), sizeof(pixel));
            t.Equals(pixel, kBottomLeft,
                     "latched host presentation should start the second row immediately after the first");
            std::memcpy(&pixel, latchedFrame.data() + (64u * 4u) + 4u, sizeof(pixel));
            t.Equals(pixel, kBottomRight,
                     "latched host presentation should preserve subsequent rows without the internal 640-pixel stride");
        });

        tc.Run("latched host presentation reads preferred CT32 source with GS swizzle", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GSRegisters regs{};
            regs.pmode = 1ull;
            regs.dispfb1 =
                150ull |
                (10ull << 9) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 15);
            regs.display1 =
                (639ull << 32) |
                (447ull << 44);

            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), &regs);

            constexpr uint32_t kSourceTbp0 = 64u;
            constexpr uint32_t kSourcePixelRow1 = 0x00665544u;
            constexpr uint32_t kDisplayPixelRow1 = 0x00CCBBAAu;
            const uint32_t swizzledSourceOff = GSPSMCT32::addrPSMCT32(kSourceTbp0, 10u, 0u, 1u);
            std::memcpy(vram.data() + swizzledSourceOff, &kSourcePixelRow1, sizeof(kSourcePixelRow1));
            writeReferenceFramePSMCT32Pixel(vram, 150u, 10u, 0u, 1u, kDisplayPixelRow1);

            constexpr uint64_t kFrame2 =
                150ull |
                (10ull << 16) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kZbuf2 = (static_cast<uint64_t>(1) << 32);
            constexpr uint64_t kScissor2 =
                (0ull << 0) |
                (639ull << 16) |
                (0ull << 32) |
                (479ull << 48);
            constexpr uint64_t kXYOffset2 =
                (static_cast<uint64_t>(1728u << 4) << 0) |
                (static_cast<uint64_t>(1808u << 4) << 32);
            constexpr uint64_t kAlpha2 = 0x6000000064ull;
            constexpr uint64_t kTest2 = 0x30000ull;
            constexpr uint64_t kTex0_2 =
                (static_cast<uint64_t>(kSourceTbp0) << 0) |
                (10ull << 14) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 20) |
                (10ull << 26) |
                (9ull << 30) |
                (1ull << 34);
            constexpr uint64_t kPrimCopy =
                static_cast<uint64_t>(GS_PRIM_SPRITE) |
                (1ull << 4) |
                (1ull << 6) |
                (1ull << 8) |
                (1ull << 9);
            constexpr uint64_t kXyz0 =
                (static_cast<uint64_t>(1728u << 4) << 0) |
                (static_cast<uint64_t>(1808u << 4) << 16) |
                (256ull << 32);
            constexpr uint64_t kXyz1 =
                (static_cast<uint64_t>(2368u << 4) << 0) |
                (static_cast<uint64_t>(2288u << 4) << 16) |
                (256ull << 32);
            constexpr uint64_t kUv0 =
                (8ull << 0) |
                (8ull << 16);
            constexpr uint64_t kUv1 =
                ((8ull + (640ull * 16ull)) << 0) |
                ((8ull + (480ull * 16ull)) << 16);

            gs.writeRegister(GS_REG_FRAME_2, kFrame2);
            gs.writeRegister(GS_REG_ZBUF_2, kZbuf2);
            gs.writeRegister(GS_REG_SCISSOR_2, kScissor2);
            gs.writeRegister(GS_REG_XYOFFSET_2, kXYOffset2);
            gs.writeRegister(GS_REG_ALPHA_2, kAlpha2);
            gs.writeRegister(GS_REG_TEST_2, kTest2);
            gs.writeRegister(GS_REG_TEX0_2, kTex0_2);
            gs.writeRegister(GS_REG_PRIM, kPrimCopy);
            gs.writeRegister(GS_REG_RGBAQ, 0x80808080ull);
            gs.writeRegister(GS_REG_UV, kUv0);
            gs.writeRegister(GS_REG_XYZ2, kXyz0);
            gs.writeRegister(GS_REG_UV, kUv1);
            gs.writeRegister(GS_REG_XYZ2, kXyz1);

            gs.latchHostPresentationFrame();

            std::vector<uint8_t> latchedFrame;
            uint32_t latchedWidth = 0u;
            uint32_t latchedHeight = 0u;
            uint32_t displayFbp = 0u;
            uint32_t sourceFbp = 0u;
            bool usedPreferred = false;
            t.IsTrue(gs.copyLatchedHostPresentationFrame(latchedFrame,
                                                         latchedWidth,
                                                         latchedHeight,
                                                         &displayFbp,
                                                         &sourceFbp,
                                                         &usedPreferred),
                     "preferred-source presentation should produce a host frame");
            t.IsTrue(usedPreferred,
                     "preferred-source presentation should use the fullscreen copy source");
            t.Equals(displayFbp, 150u,
                     "preferred-source presentation should still target the display page");
            t.Equals(sourceFbp, kSourceTbp0,
                     "preferred-source presentation should report the CT32 source frame");

            const size_t row1Off = 640u * 4u;
            t.Equals(static_cast<uint32_t>(latchedFrame[row1Off + 0u]), 0x44u,
                     "preferred-source presentation should read row 1 red from the swizzled CT32 source");
            t.Equals(static_cast<uint32_t>(latchedFrame[row1Off + 1u]), 0x55u,
                     "preferred-source presentation should read row 1 green from the swizzled CT32 source");
            t.Equals(static_cast<uint32_t>(latchedFrame[row1Off + 2u]), 0x66u,
                     "preferred-source presentation should read row 1 blue from the swizzled CT32 source");
            t.Equals(static_cast<uint32_t>(latchedFrame[row1Off + 3u]), 0xFFu,
                     "preferred-source presentation should normalize row 1 alpha for the host frame");
        });

        tc.Run("latched host presentation reads direct CT32 display frames with GS swizzle", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GSRegisters regs{};
            regs.pmode = 0x0001ull;
            regs.dispfb1 =
                150ull |
                (10ull << 9) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 15);
            regs.display1 =
                (639ull << 32) |
                (447ull << 44);

            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), &regs);

            constexpr uint32_t kRow1Pixel =
                0x44u |
                (0x55u << 8) |
                (0x66u << 16) |
                (0x77u << 24);
            constexpr uint32_t kLinearGarbageRow1 =
                0xAAu |
                (0xBBu << 8) |
                (0xCCu << 16) |
                (0xDDu << 24);
            constexpr size_t kHostRow1Off = 640u * 4u;

            writeReferenceFramePSMCT32Pixel(vram, 150u, 10u, 0u, 1u, kRow1Pixel);
            std::memcpy(vram.data() + (150u * 8192u) + kHostRow1Off, &kLinearGarbageRow1, sizeof(kLinearGarbageRow1));

            gs.latchHostPresentationFrame();

            std::vector<uint8_t> latchedFrame;
            uint32_t latchedWidth = 0u;
            uint32_t latchedHeight = 0u;
            uint32_t displayFbp = 0u;
            bool usedPreferred = false;
            t.IsTrue(gs.copyLatchedHostPresentationFrame(latchedFrame,
                                                         latchedWidth,
                                                         latchedHeight,
                                                         &displayFbp,
                                                         nullptr,
                                                         &usedPreferred),
                     "direct CT32 display presentation should produce a host frame");
            t.Equals(displayFbp, 150u,
                     "direct CT32 presentation should report the active display page");
            t.IsFalse(usedPreferred,
                      "direct CT32 presentation should not claim it used a preferred copy source");
            t.Equals(static_cast<uint32_t>(latchedFrame[kHostRow1Off + 0u]), 0x44u,
                     "direct CT32 presentation should read row 1 red from the GS-swizzled display page");
            t.Equals(static_cast<uint32_t>(latchedFrame[kHostRow1Off + 1u]), 0x55u,
                     "direct CT32 presentation should read row 1 green from the GS-swizzled display page");
            t.Equals(static_cast<uint32_t>(latchedFrame[kHostRow1Off + 2u]), 0x66u,
                     "direct CT32 presentation should read row 1 blue from the GS-swizzled display page");
            t.Equals(static_cast<uint32_t>(latchedFrame[kHostRow1Off + 3u]), 0xFFu,
                     "direct CT32 presentation should normalize row 1 alpha for the host frame");
        });

        tc.Run("latched host presentation merges both enabled PMODE circuits", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GSRegisters regs{};
            regs.pmode = 0x8007ull;
            regs.dispfb1 =
                150ull |
                (10ull << 9) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 15);
            regs.display1 =
                (639ull << 32) |
                (447ull << 44);
            regs.dispfb2 =
                0ull |
                (10ull << 9) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 15);
            regs.display2 = regs.display1;

            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), &regs);

            constexpr uint32_t kCircuit1Pixel =
                200u |
                (0u << 8) |
                (0u << 16) |
                (64u << 24);
            constexpr uint32_t kCircuit2Pixel =
                0u |
                (0u << 8) |
                (200u << 16) |
                (255u << 24);

            writeReferenceFramePSMCT32Pixel(vram, 150u, 10u, 0u, 0u, kCircuit1Pixel);
            std::memcpy(vram.data(), &kCircuit2Pixel, sizeof(kCircuit2Pixel));

            gs.latchHostPresentationFrame();

            std::vector<uint8_t> latchedFrame;
            uint32_t latchedWidth = 0u;
            uint32_t latchedHeight = 0u;
            uint32_t displayFbp = 0u;
            bool usedPreferred = false;
            t.IsTrue(gs.copyLatchedHostPresentationFrame(latchedFrame,
                                                         latchedWidth,
                                                         latchedHeight,
                                                         &displayFbp,
                                                         nullptr,
                                                         &usedPreferred),
                     "dual-circuit PMODE presentation should produce a host frame");
            t.Equals(displayFbp, 150u,
                     "dual-circuit presentation should still report the primary display page");
            t.IsFalse(usedPreferred,
                      "dual-circuit PMODE presentation should not bypass the first circuit with the preferred-copy shortcut");
            t.Equals(latchedWidth, 640u,
                     "dual-circuit presentation should preserve the display width");
            t.Equals(latchedHeight, 448u,
                     "dual-circuit presentation should preserve the display height");
            t.Equals(static_cast<uint32_t>(latchedFrame[0]), 100u,
                     "dual-circuit presentation should blend the first circuit red channel over the second circuit");
            t.Equals(static_cast<uint32_t>(latchedFrame[1]), 0u,
                     "dual-circuit presentation should preserve a zero green channel");
            t.Equals(static_cast<uint32_t>(latchedFrame[2]), 100u,
                     "dual-circuit presentation should blend the second circuit blue channel under the first circuit");
            t.Equals(static_cast<uint32_t>(latchedFrame[3]), 0xFFu,
                     "dual-circuit presentation should normalize the final host alpha");
        });

        tc.Run("latched host presentation normalizes alpha for single-circuit display", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GSRegisters regs{};
            regs.pmode = 0x0001ull;
            regs.dispfb1 =
                150ull |
                (10ull << 9) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 15);
            regs.display1 =
                (639ull << 32) |
                (447ull << 44);

            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), &regs);

            constexpr uint32_t kPixel =
                0x22u |
                (0x44u << 8) |
                (0x66u << 16) |
                (0x01u << 24);
            writeReferenceFramePSMCT32Pixel(vram, 150u, 10u, 0u, 0u, kPixel);

            gs.latchHostPresentationFrame();

            std::vector<uint8_t> latchedFrame;
            uint32_t latchedWidth = 0u;
            uint32_t latchedHeight = 0u;
            t.IsTrue(gs.copyLatchedHostPresentationFrame(latchedFrame, latchedWidth, latchedHeight),
                     "single-circuit presentation should produce a host frame");
            t.Equals(static_cast<uint32_t>(latchedFrame[0]), 0x22u,
                     "single-circuit presentation should preserve the red channel");
            t.Equals(static_cast<uint32_t>(latchedFrame[1]), 0x44u,
                     "single-circuit presentation should preserve the green channel");
            t.Equals(static_cast<uint32_t>(latchedFrame[2]), 0x66u,
                     "single-circuit presentation should preserve the blue channel");
            t.Equals(static_cast<uint32_t>(latchedFrame[3]), 0xFFu,
                     "single-circuit presentation should upload an opaque host alpha");
        });

        tc.Run("latched host presentation preserves 480-line display height", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GSRegisters regs{};
            regs.pmode = 0x0001ull;
            regs.dispfb1 =
                150ull |
                (10ull << 9) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 15);
            regs.display1 =
                (639ull << 32) |
                (479ull << 44);

            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), &regs);

            constexpr uint32_t kLastRowPixel =
                0x12u |
                (0x34u << 8) |
                (0x56u << 16) |
                (0x78u << 24);
            writeReferenceFramePSMCT32Pixel(vram, 150u, 10u, 0u, 479u, kLastRowPixel);

            gs.latchHostPresentationFrame();

            std::vector<uint8_t> latchedFrame;
            uint32_t latchedWidth = 0u;
            uint32_t latchedHeight = 0u;
            t.IsTrue(gs.copyLatchedHostPresentationFrame(latchedFrame, latchedWidth, latchedHeight),
                     "480-line single-circuit presentation should produce a host frame");
            t.Equals(latchedWidth, 640u,
                     "480-line presentation should preserve the display width");
            t.Equals(latchedHeight, 480u,
                     "480-line presentation should preserve the full display height");

            const size_t lastRowOffset = static_cast<size_t>(479u) * 640u * 4u;
            t.Equals(static_cast<uint32_t>(latchedFrame[lastRowOffset + 0u]), 0x12u,
                     "480-line presentation should keep the last row red channel");
            t.Equals(static_cast<uint32_t>(latchedFrame[lastRowOffset + 1u]), 0x34u,
                     "480-line presentation should keep the last row green channel");
            t.Equals(static_cast<uint32_t>(latchedFrame[lastRowOffset + 2u]), 0x56u,
                     "480-line presentation should keep the last row blue channel");
            t.Equals(static_cast<uint32_t>(latchedFrame[lastRowOffset + 3u]), 0xFFu,
                     "single-circuit presentation should normalize the last row alpha");
        });

        tc.Run("latched host presentation preserves interlaced framebuffer rows", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GSRegisters regs{};
            regs.pmode = 0x0001ull;
            regs.smode2 = 0x0001ull; // interlaced, field mode
            regs.dispfb1 =
                0ull |
                (10ull << 9) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 15);
            regs.display1 =
                (639ull << 32) |
                (447ull << 44);

            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), &regs);

            constexpr uint32_t kLine0 = 0x000000FFu;
            constexpr uint32_t kLine1 = 0x0000FF00u;
            constexpr uint32_t kLine2 = 0x00FF0000u;
            constexpr uint32_t kLine3 = 0x00FFFF00u;
            writeReferencePSMCT32Pixel(vram, 0u, 10u, 0u, 0u, kLine0);
            writeReferencePSMCT32Pixel(vram, 0u, 10u, 0u, 1u, kLine1);
            writeReferencePSMCT32Pixel(vram, 0u, 10u, 0u, 2u, kLine2);
            writeReferencePSMCT32Pixel(vram, 0u, 10u, 0u, 3u, kLine3);

            gs.latchHostPresentationFrame();

            std::vector<uint8_t> latchedFrame;
            uint32_t latchedWidth = 0u;
            uint32_t latchedHeight = 0u;
            t.IsTrue(gs.copyLatchedHostPresentationFrame(latchedFrame, latchedWidth, latchedHeight),
                     "interlaced field presentation should produce a host frame");
            t.Equals(latchedWidth, 640u,
                     "field presentation should preserve display width");
            t.Equals(latchedHeight, 448u,
                     "field presentation should preserve display height");

            auto pixelAtRow = [&](uint32_t row) -> uint32_t
            {
                const size_t off = static_cast<size_t>(row) * 640u * 4u;
                return static_cast<uint32_t>(latchedFrame[off + 0u]) |
                       (static_cast<uint32_t>(latchedFrame[off + 1u]) << 8) |
                       (static_cast<uint32_t>(latchedFrame[off + 2u]) << 16);
            };

            const uint32_t row0 = pixelAtRow(0u);
            const uint32_t row1 = pixelAtRow(1u);
            const uint32_t row2 = pixelAtRow(2u);
            const uint32_t row3 = pixelAtRow(3u);

            t.Equals(row0, kLine0,
                     "interlaced presentation should preserve the first framebuffer row");
            t.Equals(row1, kLine1,
                     "interlaced presentation should preserve the second framebuffer row");
            t.Equals(row2, kLine2,
                     "interlaced presentation should preserve the third framebuffer row");
            t.Equals(row3, kLine3,
                     "interlaced presentation should preserve the fourth framebuffer row");
        });

        tc.Run("GIF PACKED A+D writes DISPFB1 and DISPLAY1 privileged registers", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GSRegisters regs{};
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), &regs);

            std::vector<uint8_t> packet;
            appendU64(packet, makeGifTag(2u, GIF_FMT_PACKED, 1u, true));
            appendU64(packet, 0x0Eull); // REGS[0] = A+D

            const uint64_t dispfb1 = 0x0123456789ABCDEFull;
            const uint64_t display1 = 0x1111222233334444ull;
            appendU64(packet, dispfb1);
            appendU64(packet, 0x59ull); // DISPFB1
            appendU64(packet, display1);
            appendU64(packet, 0x5Aull); // DISPLAY1

            gs.processGIFPacket(packet.data(), static_cast<uint32_t>(packet.size()));

            t.Equals(regs.dispfb1, dispfb1, "A+D should write GS DISPFB1");
            t.Equals(regs.display1, display1, "A+D should write GS DISPLAY1");
        });

        tc.Run("GIF PACKED A+D writes DISPFB2 and DISPLAY2 privileged registers", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GSRegisters regs{};
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), &regs);

            std::vector<uint8_t> packet;
            appendU64(packet, makeGifTag(2u, GIF_FMT_PACKED, 1u, true));
            appendU64(packet, 0x0Eull); // REGS[0] = A+D

            const uint64_t dispfb2 = 0x2222333344445555ull;
            const uint64_t display2 = 0x6666777788889999ull;
            appendU64(packet, dispfb2);
            appendU64(packet, 0x5Bull); // DISPFB2
            appendU64(packet, display2);
            appendU64(packet, 0x5Cull); // DISPLAY2

            gs.processGIFPacket(packet.data(), static_cast<uint32_t>(packet.size()));

            t.Equals(regs.dispfb2, dispfb2, "A+D should write GS DISPFB2");
            t.Equals(regs.display2, display2, "A+D should write GS DISPLAY2");
        });

        tc.Run("reserved PSM 0x3F uses null VRAM handlers", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0xA5u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            t.Equals(gs.ReadVram(0x3Fu, 0u, 1u, 0u, 0u), 0u,
                     "reserved PSM reads should use the null handler");

            gs.WriteVram(0x3Fu, 0u, 1u, 0u, 0u, 0x0005180Bu);
            t.Equals(static_cast<uint32_t>(vram[0]), 0xA5u,
                     "reserved PSM writes should leave VRAM unchanged");
        });

        tc.Run("PSMT4 address mapping matches GS manual layout", [](TestCase &t)
        {
            constexpr uint32_t kBaseBlock = 0u;
            constexpr uint32_t kWidth = 2u; // One 128x128 PSMT4 page.

            t.Equals(GSPSMT4::addrPSMT4(kBaseBlock, kWidth, 0u, 0u), 0u,
                     "PSMT4 origin should map to nibble offset 0");
            t.Equals(GSPSMT4::addrPSMT4(kBaseBlock, kWidth, 1u, 0u), 8u,
                     "PSMT4 x=1 should advance to the next packed nibble group");
            t.Equals(GSPSMT4::addrPSMT4(kBaseBlock, kWidth, 0u, 1u), 16u,
                     "PSMT4 second source row should follow the manual's row packing");
            t.Equals(GSPSMT4::addrPSMT4(kBaseBlock, kWidth, 0u, 2u), 65u,
                     "PSMT4 third source row should include the manual's odd-row permutation");
            t.Equals(GSPSMT4::addrPSMT4(kBaseBlock, kWidth, 0u, 3u), 81u,
                     "PSMT4 fourth source row should stay in the first block's manual column layout");
            t.Equals(GSPSMT4::addrPSMT4(kBaseBlock, kWidth, 31u, 15u), 511u,
                     "PSMT4 final texel in the first 32x16 block should land at the end of the block");
            t.Equals(GSPSMT4::addrPSMT4(kBaseBlock, kWidth, 32u, 0u), 1024u,
                     "PSMT4 x=32 should advance to the next swizzled block in the page");
            t.Equals(GSPSMT4::addrPSMT4(kBaseBlock, kWidth, 32u, 16u), 1536u,
                     "PSMT4 x=32,y=16 should follow the manual's second block-row permutation");
            t.Equals(GSPSMT4::addrPSMT4(kBaseBlock, kWidth, 64u, 0u), 4096u,
                     "PSMT4 x=64 should advance to the third swizzled block column in the page");
            t.Equals(GSPSMT4::addrPSMT4(kBaseBlock, kWidth, 96u, 112u), 15872u,
                     "PSMT4 bottom-right block origin should match the manual's page permutation");
            t.Equals(GSPSMT4::addrPSMT4(kBaseBlock, kWidth, 127u, 127u), 16383u,
                     "PSMT4 final texel in a 128x128 page should land at the end of the page");
            t.Equals(GSPSMT4::addrPSMT4(kBaseBlock, kWidth, 128u, 0u), 16384u,
                     "PSMT4 x=128 should advance to the next page of nibble addresses");
        });

        tc.Run("PSMT4 large atlases keep manual page layout across 512x512 textures", [](TestCase &t)
        {
            constexpr uint32_t kBaseBlock = 64u;
            constexpr uint32_t kWidth = 8u; // 512 pixel-wide T4 atlas, like Veronica font pages.
            constexpr uint32_t kCoords[][2] = {
                {0u, 0u},
                {31u, 15u},
                {32u, 0u},
                {95u, 31u},
                {127u, 127u},
                {128u, 0u},
                {255u, 127u},
                {256u, 0u},
                {383u, 127u},
                {384u, 128u},
                {511u, 511u},
            };

            for (const auto &coord : kCoords)
            {
                const uint32_t x = coord[0];
                const uint32_t y = coord[1];
                t.Equals(GSPSMT4::addrPSMT4(kBaseBlock, kWidth, x, y),
                         referenceAddrPSMT4(kBaseBlock, kWidth, x, y),
                         "PSMT4 512x512 atlas mapping should match the GS manual for every sampled page boundary");
            }
        });

        tc.Run("GS T4 triangle sampling reads manual-layout texels from a 512x512 atlas", [](TestCase &t)
        {
            constexpr uint32_t kTexTbp = 64u;
            constexpr uint32_t kClutCbp = 128u;
            constexpr uint64_t kFrame =
                (0ull << 0) |
                (1ull << 16) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kZbuf = (1ull << 32);
            constexpr uint64_t kScissor =
                (0ull << 0) |
                (4ull << 16) |
                (0ull << 32) |
                (4ull << 48);
            constexpr uint64_t kTex0 =
                (static_cast<uint64_t>(kTexTbp) << 0) |
                (8ull << 14) |
                (static_cast<uint64_t>(GS_PSM_T4) << 20) |
                (9ull << 26) |
                (9ull << 30) |
                (1ull << 34) |
                (1ull << 35) |
                (static_cast<uint64_t>(kClutCbp) << 37) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 51) |
                (1ull << 55);
            constexpr uint64_t kPrim =
                static_cast<uint64_t>(GS_PRIM_TRIANGLE) |
                (1ull << 4);
            constexpr uint64_t kRgbaq = 0x3F80000080808080ull;

            auto packFloat = [](float value) -> uint32_t
            {
                uint32_t bits = 0u;
                std::memcpy(&bits, &value, sizeof(bits));
                return bits;
            };

            auto packSt = [&](float s, float tVal) -> uint64_t
            {
                return static_cast<uint64_t>(packFloat(s)) |
                       (static_cast<uint64_t>(packFloat(tVal)) << 32);
            };

            const struct SampleCase
            {
                uint32_t x;
                uint32_t y;
                uint8_t index;
                uint32_t color;
            } cases[] = {
                {5u, 5u, 1u, 0xFF0000FFu},
                {129u, 5u, 2u, 0xFF00FF00u},
                {257u, 5u, 3u, 0xFFFF0000u},
                {385u, 129u, 4u, 0xFFFFFFFFu},
            };

            for (const auto &sample : cases)
            {
                std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
                GS gs;
                gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

                writeReferencePSMT4Texel(vram, kTexTbp, 8u, sample.x, sample.y, sample.index);
                const uint32_t clutOff = referenceAddrPSMCT32(kClutCbp, 1u, sample.index, 0u);
                std::memcpy(vram.data() + clutOff, &sample.color, sizeof(sample.color));

                gs.writeRegister(GS_REG_FRAME_1, kFrame);
                gs.writeRegister(GS_REG_ZBUF_1, kZbuf);
                gs.writeRegister(GS_REG_SCISSOR_1, kScissor);
                gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
                gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
                gs.writeRegister(GS_REG_ALPHA_1, 0ull);
                gs.writeRegister(GS_REG_TEX0_1, kTex0);
                gs.writeRegister(GS_REG_TEX1_1, 0ull);
                gs.writeRegister(GS_REG_PRIM, kPrim);
                gs.writeRegister(GS_REG_RGBAQ, kRgbaq);

                const float s = (static_cast<float>(sample.x) + 0.25f) / 512.0f;
                const float tVal = (static_cast<float>(sample.y) + 0.25f) / 512.0f;
                gs.writeRegister(GS_REG_ST, packSt(s, tVal));
                gs.writeRegister(GS_REG_XYZ2, 0ull);
                gs.writeRegister(GS_REG_ST, packSt(s, tVal));
                gs.writeRegister(GS_REG_XYZ2, (64ull << 0) | (0ull << 16));
                gs.writeRegister(GS_REG_ST, packSt(s, tVal));
                gs.writeRegister(GS_REG_XYZ2, (0ull << 0) | (64ull << 16));

                const uint32_t pixel = readReferencePSMCT32Pixel(vram, 0u, 1u, 1u, 1u);
                t.Equals(pixel, sample.color,
                         "T4 triangle sampling should fetch the manual-layout atlas texel from the correct 128x128 page");
            }
        });

        tc.Run("PSMT8 address mapping matches Veronica Conv8to32 layout", [](TestCase &t)
        {
            constexpr uint32_t kBaseBlock = 0u;
            constexpr uint32_t kWidth = 2u; // One 128x64 PSMT8 page.

            t.Equals(GSPSMT8::addrPSMT8(kBaseBlock, kWidth, 0u, 0u), 0u,
                     "PSMT8 origin should map to byte offset 0");
            t.Equals(GSPSMT8::addrPSMT8(kBaseBlock, kWidth, 1u, 0u), 4u,
                     "PSMT8 x=1 should follow Veronica's Conv8to32 byte interleave");
            t.Equals(GSPSMT8::addrPSMT8(kBaseBlock, kWidth, 0u, 1u), 8u,
                     "PSMT8 second source row should land on the next Conv8to32 row stride");
            t.Equals(GSPSMT8::addrPSMT8(kBaseBlock, kWidth, 0u, 2u), 33u,
                     "PSMT8 third source row should preserve Veronica's odd-row shuffle");
            t.Equals(GSPSMT8::addrPSMT8(kBaseBlock, kWidth, 0u, 3u), 41u,
                     "PSMT8 fourth source row should preserve Veronica's alternating block rows");
            t.Equals(GSPSMT8::addrPSMT8(kBaseBlock, kWidth, 15u, 15u), 255u,
                     "PSMT8 final texel in the first 16x16 block should end at byte 255");
            t.Equals(GSPSMT8::addrPSMT8(kBaseBlock, kWidth, 16u, 0u), 256u,
                     "PSMT8 x=16 should advance to the next 16x16 block");
            t.Equals(GSPSMT8::addrPSMT8(kBaseBlock, kWidth, 16u, 16u), 768u,
                     "PSMT8 x=16,y=16 should include both block-column and block-row offsets");
            t.Equals(GSPSMT8::addrPSMT8(kBaseBlock, kWidth, 32u, 0u), 1024u,
                     "PSMT8 x=32 should advance to the third block column in the page");
            t.Equals(GSPSMT8::addrPSMT8(kBaseBlock, kWidth, 64u, 0u), 4096u,
                     "PSMT8 x=64 should advance to the second page half");
            t.Equals(GSPSMT8::addrPSMT8(kBaseBlock, kWidth, 96u, 48u), 7680u,
                     "PSMT8 lower-right interior block should follow Veronica's page permutation");
            t.Equals(GSPSMT8::addrPSMT8(kBaseBlock, kWidth, 127u, 63u), 8191u,
                     "PSMT8 final texel in a 128x64 page should land at the final byte");
        });

        tc.Run("GIF REGLIST with odd register count consumes 128-bit padding before next tag", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            const uint64_t bitblt =
                (static_cast<uint64_t>(0u) << 0) |
                (static_cast<uint64_t>(1u) << 16) |
                (static_cast<uint64_t>(0u) << 24) |
                (static_cast<uint64_t>(0u) << 32) |
                (static_cast<uint64_t>(1u) << 48) |
                (static_cast<uint64_t>(0u) << 56);
            gs.writeRegister(GS_REG_BITBLTBUF, bitblt);
            gs.writeRegister(GS_REG_TRXPOS, 0ull);
            gs.writeRegister(GS_REG_TRXREG, (4ull << 0) | (1ull << 32));
            gs.writeRegister(GS_REG_TRXDIR, 0ull);

            std::vector<uint8_t> packet;
            appendU64(packet, makeGifTag(1u, GIF_FMT_REGLIST, 1u, false));
            appendU64(packet, 0x0ull); // REGS[0] = PRIM
            appendU64(packet, 0x0000000000000006ull); // PRIM write
            appendU64(packet, 0xDEADBEEFCAFEBABEull); // required REGLIST pad qword

            appendU64(packet, makeGifTag(1u, GIF_FMT_IMAGE, 0u, true));
            appendU64(packet, 0ull);
            const uint8_t payload[16] = {
                0x31u, 0x32u, 0x33u, 0x34u,
                0x35u, 0x36u, 0x37u, 0x38u,
                0x39u, 0x3Au, 0x3Bu, 0x3Cu,
                0x3Du, 0x3Eu, 0x3Fu, 0x40u,
            };
            packet.insert(packet.end(), payload, payload + sizeof(payload));

            gs.processGIFPacket(packet.data(), static_cast<uint32_t>(packet.size()));

            bool imageOk = true;
            for (uint32_t x = 0; x < 4u && imageOk; ++x)
            {
                const uint32_t off = referenceAddrPSMCT32(0u, 1u, x, 0u);
                for (uint32_t c = 0; c < 4u; ++c)
                {
                    if (vram[off + c] != payload[x * 4u + c])
                    {
                        imageOk = false;
                        break;
                    }
                }
            }
            t.IsTrue(imageOk, "odd REGLIST payload should not corrupt alignment of the following IMAGE tag");
        });

        tc.Run("GIF REGLIST NREG=0 is treated as sixteen descriptors", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            const uint64_t bitblt =
                (static_cast<uint64_t>(0u) << 0) |
                (static_cast<uint64_t>(1u) << 16) |
                (static_cast<uint64_t>(0u) << 24) |
                (static_cast<uint64_t>(0u) << 32) |
                (static_cast<uint64_t>(1u) << 48) |
                (static_cast<uint64_t>(0u) << 56);
            gs.writeRegister(GS_REG_BITBLTBUF, bitblt);
            gs.writeRegister(GS_REG_TRXPOS, 0ull);
            gs.writeRegister(GS_REG_TRXREG, (4ull << 0) | (1ull << 32));
            gs.writeRegister(GS_REG_TRXDIR, 0ull);

            std::vector<uint8_t> packet;
            appendU64(packet, makeGifTag(1u, GIF_FMT_REGLIST, 0u, false)); // NREG=0 -> 16 regs
            appendU64(packet, 0ull); // 16x PRIM descriptors
            for (uint32_t i = 0; i < 16u; ++i)
            {
                appendU64(packet, static_cast<uint64_t>(i));
            }

            appendU64(packet, makeGifTag(1u, GIF_FMT_IMAGE, 0u, true));
            appendU64(packet, 0ull);
            const uint8_t payload[16] = {
                0x51u, 0x52u, 0x53u, 0x54u,
                0x55u, 0x56u, 0x57u, 0x58u,
                0x59u, 0x5Au, 0x5Bu, 0x5Cu,
                0x5Du, 0x5Eu, 0x5Fu, 0x60u,
            };
            packet.insert(packet.end(), payload, payload + sizeof(payload));

            gs.processGIFPacket(packet.data(), static_cast<uint32_t>(packet.size()));

            bool imageOk = true;
            for (uint32_t x = 0; x < 4u && imageOk; ++x)
            {
                const uint32_t off = referenceAddrPSMCT32(0u, 1u, x, 0u);
                for (uint32_t c = 0; c < 4u; ++c)
                {
                    if (vram[off + c] != payload[x * 4u + c])
                    {
                        imageOk = false;
                        break;
                    }
                }
            }
            t.IsTrue(imageOk, "NREG=0 REGLIST should consume 16 data words and keep following tag aligned");
        });

        tc.Run("GS SIGNAL and FINISH set CSR bits that clear by CSR write-one acknowledge", [](TestCase &t)
        {
            PS2Memory mem;
            t.IsTrue(mem.initialize(), "PS2Memory initialize should succeed");

            GS gs;
            gs.init(mem.getGSVRAM(), static_cast<uint32_t>(PS2_GS_VRAM_SIZE), &mem.gs());

            const uint64_t signalValue = (0xFFFFFFFFull << 32) | 0x11223344ull;
            gs.writeRegister(GS_REG_SIGNAL, signalValue);
            gs.writeRegister(GS_REG_FINISH, 0u);

            t.IsTrue((mem.gs().csr & 0x1ull) != 0ull, "SIGNAL should raise CSR.SIGNAL");
            t.IsTrue((mem.gs().csr & 0x2ull) != 0ull, "FINISH should raise CSR.FINISH");
            t.Equals(static_cast<uint32_t>(mem.gs().siglblid & 0xFFFFFFFFull), 0x11223344u, "SIGNAL should update SIGLBLID low dword");

            mem.write64(0x12001000u, 0x1ull);
            t.IsTrue((mem.gs().csr & 0x1ull) == 0ull, "writing CSR bit0 should acknowledge SIGNAL");
            t.IsTrue((mem.gs().csr & 0x2ull) != 0ull, "acknowledging SIGNAL should not clear FINISH");

            mem.write32(0x12001000u, 0x2u);
            t.IsTrue((mem.gs().csr & 0x2ull) == 0ull, "writing CSR bit1 should acknowledge FINISH");
        });

        tc.Run("GIF IMAGE packet writes host-to-local data into GS VRAM", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            // Setup for host->local transfer to DBP=0, DBW=1, PSMCT32, rect 2x2.
            const uint64_t bitblt =
                (static_cast<uint64_t>(0u) << 0) |      // SBP
                (static_cast<uint64_t>(1u) << 16) |     // SBW
                (static_cast<uint64_t>(0u) << 24) |     // SPSM
                (static_cast<uint64_t>(0u) << 32) |     // DBP
                (static_cast<uint64_t>(1u) << 48) |     // DBW
                (static_cast<uint64_t>(0u) << 56);      // DPSM (CT32)
            gs.writeRegister(GS_REG_BITBLTBUF, bitblt);
            gs.writeRegister(GS_REG_TRXPOS, 0ull);
            gs.writeRegister(GS_REG_TRXREG, (2ull << 0) | (2ull << 32));
            gs.writeRegister(GS_REG_TRXDIR, 0ull);

            std::vector<uint8_t> packet;
            appendU64(packet, makeGifTag(1u, GIF_FMT_IMAGE, 0u, true));
            appendU64(packet, 0ull);

            const uint8_t payload[16] = {
                0x10u, 0x11u, 0x12u, 0x13u,
                0x20u, 0x21u, 0x22u, 0x23u,
                0x30u, 0x31u, 0x32u, 0x33u,
                0x40u, 0x41u, 0x42u, 0x43u,
            };
            packet.insert(packet.end(), payload, payload + sizeof(payload));

            gs.processGIFPacket(packet.data(), static_cast<uint32_t>(packet.size()));

            bool same = true;
            for (uint32_t y = 0; y < 2u && same; ++y)
            {
                for (uint32_t x = 0; x < 2u; ++x)
                {
                    const uint32_t pixelIndex = y * 2u + x;
                    const uint32_t off = referenceAddrPSMCT32(0u, 1u, x, y);
                    for (uint32_t c = 0; c < 4u; ++c)
                    {
                        if (vram[off + c] != payload[pixelIndex * 4u + c])
                        {
                            same = false;
                            break;
                        }
                    }
                    if (!same)
                        break;
                }
            }
            t.IsTrue(same, "GIF IMAGE transfer should write payload bytes into GS VRAM");
        });

        tc.Run("GIF IMAGE2 packet writes host-to-local data into GS VRAM", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            const uint64_t bitblt =
                (static_cast<uint64_t>(1u) << 16) |
                (static_cast<uint64_t>(1u) << 48);
            gs.writeRegister(GS_REG_BITBLTBUF, bitblt);
            gs.writeRegister(GS_REG_TRXPOS, 0ull);
            gs.writeRegister(GS_REG_TRXREG, (4ull << 0) | (1ull << 32));
            gs.writeRegister(GS_REG_TRXDIR, 0ull);

            std::vector<uint8_t> packet;
            appendU64(packet, makeGifTag(1u, GIF_FMT_IMAGE2, 0u, true));
            appendU64(packet, 0ull);
            const uint8_t payload[16] = {
                0x71u, 0x72u, 0x73u, 0x74u,
                0x75u, 0x76u, 0x77u, 0x78u,
                0x79u, 0x7Au, 0x7Bu, 0x7Cu,
                0x7Du, 0x7Eu, 0x7Fu, 0x80u,
            };
            packet.insert(packet.end(), payload, payload + sizeof(payload));

            gs.processGIFPacket(packet.data(), static_cast<uint32_t>(packet.size()));

            bool same = true;
            for (uint32_t x = 0; x < 4u && same; ++x)
            {
                const uint32_t off = referenceAddrPSMCT32(0u, 1u, x, 0u);
                for (uint32_t c = 0; c < 4u; ++c)
                {
                    if (vram[off + c] != payload[x * 4u + c])
                    {
                        same = false;
                        break;
                    }
                }
            }
            t.IsTrue(same, "IMAGE2 payload should be handled like IMAGE");
        });

        tc.Run("GIF load-image packet uses native upload fast path", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            const uint64_t bitblt =
                (static_cast<uint64_t>(0u) << 0) |
                (static_cast<uint64_t>(1u) << 16) |
                (static_cast<uint64_t>(0u) << 24) |
                (static_cast<uint64_t>(0u) << 32) |
                (static_cast<uint64_t>(1u) << 48) |
                (static_cast<uint64_t>(0u) << 56);
            const uint64_t trxpos = 0ull;
            const uint64_t trxreg = (2ull << 0) | (2ull << 32);
            const uint64_t trxdir = 0ull;

            const uint8_t payload[16] = {
                0x10u, 0x11u, 0x12u, 0x13u,
                0x20u, 0x21u, 0x22u, 0x23u,
                0x30u, 0x31u, 0x32u, 0x33u,
                0x40u, 0x41u, 0x42u, 0x43u,
            };

            std::vector<uint8_t> packet;
            appendU64(packet, makeGifTag(4u, GIF_FMT_PACKED, 1u, false));
            appendU64(packet, 0x0Eull);
            appendGifAd(packet, bitblt, GS_REG_BITBLTBUF);
            appendGifAd(packet, trxpos, GS_REG_TRXPOS);
            appendGifAd(packet, trxreg, GS_REG_TRXREG);
            appendGifAd(packet, trxdir, GS_REG_TRXDIR);
            appendU64(packet, makeGifTag(1u, GIF_FMT_IMAGE, 0u, true));
            appendU64(packet, 0ull);
            packet.insert(packet.end(), payload, payload + sizeof(payload));

            gs.processGIFPacket(packet.data(), static_cast<uint32_t>(packet.size()));

            t.Equals(gs.nativeImageUploadCount(), 1ull, "load-image packet should use the native image upload fast path");

            bool same = true;
            for (uint32_t y = 0; y < 2u && same; ++y)
            {
                for (uint32_t x = 0; x < 2u; ++x)
                {
                    const uint32_t pixelIndex = y * 2u + x;
                    const uint32_t off = referenceAddrPSMCT32(0u, 1u, x, y);
                    for (uint32_t c = 0; c < 4u; ++c)
                    {
                        if (vram[off + c] != payload[pixelIndex * 4u + c])
                        {
                            same = false;
                            break;
                        }
                    }
                    if (!same)
                        break;
                }
            }
            t.IsTrue(same, "native load-image upload should preserve pixel payload");
        });

        tc.Run("GS local-to-host transfer supports partial incremental reads", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            for (uint32_t x = 0; x < 4u; ++x)
            {
                const uint32_t off = referenceAddrPSMCT32(0u, 1u, x, 0u);
                for (uint32_t c = 0; c < 4u; ++c)
                {
                    vram[off + c] = static_cast<uint8_t>(0xA0u + x * 4u + c);
                }
            }

            const uint64_t bitblt =
                (static_cast<uint64_t>(0u) << 0) |      // SBP
                (static_cast<uint64_t>(1u) << 16) |     // SBW
                (static_cast<uint64_t>(0u) << 24) |     // SPSM (CT32)
                (static_cast<uint64_t>(0u) << 32) |
                (static_cast<uint64_t>(1u) << 48) |
                (static_cast<uint64_t>(0u) << 56);
            gs.writeRegister(GS_REG_BITBLTBUF, bitblt);
            gs.writeRegister(GS_REG_TRXPOS, 0ull);
            gs.writeRegister(GS_REG_TRXREG, (4ull << 0) | (1ull << 32)); // 4 pixels, 1 row -> 16 bytes
            gs.writeRegister(GS_REG_TRXDIR, 1ull);

            uint8_t bufA[8] = {};
            uint8_t bufB[16] = {};

            const uint32_t nA = gs.consumeLocalToHostBytes(bufA, 6u);
            const uint32_t nB = gs.consumeLocalToHostBytes(bufB, 16u);
            const uint32_t nC = gs.consumeLocalToHostBytes(bufB, 4u);

            t.Equals(nA, 6u, "first partial read should consume requested bytes");
            t.Equals(nB, 10u, "second read should consume the remaining bytes");
            t.Equals(nC, 0u, "buffer should be empty after all bytes are consumed");

            bool bytesOk = true;
            for (uint32_t i = 0; i < 6u; ++i)
            {
                if (bufA[i] != static_cast<uint8_t>(0xA0u + i))
                    bytesOk = false;
            }
            for (uint32_t i = 0; i < 10u; ++i)
            {
                if (bufB[i] != static_cast<uint8_t>(0xA6u + i))
                    bytesOk = false;
            }
            t.IsTrue(bytesOk, "partial reads should return local->host data in-order");
        });

        tc.Run("GS CT24 host-local-host transfer preserves 24-bit RGB payload", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            const uint64_t bitblt =
                (static_cast<uint64_t>(0u) << 0) |      // SBP
                (static_cast<uint64_t>(1u) << 16) |     // SBW
                (static_cast<uint64_t>(1u) << 24) |     // SPSM CT24
                (static_cast<uint64_t>(0u) << 32) |     // DBP
                (static_cast<uint64_t>(1u) << 48) |     // DBW
                (static_cast<uint64_t>(1u) << 56);      // DPSM CT24
            gs.writeRegister(GS_REG_BITBLTBUF, bitblt);
            gs.writeRegister(GS_REG_TRXPOS, 0ull);
            gs.writeRegister(GS_REG_TRXREG, (2ull << 0) | (1ull << 32)); // 2 pixels
            gs.writeRegister(GS_REG_TRXDIR, 0ull);

            std::vector<uint8_t> packet;
            appendU64(packet, makeGifTag(1u, GIF_FMT_IMAGE, 0u, true));
            appendU64(packet, 0ull);
            const uint8_t rgbData[16] = {
                0x11u, 0x22u, 0x33u,
                0x44u, 0x55u, 0x66u,
                0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u
            };
            packet.insert(packet.end(), rgbData, rgbData + sizeof(rgbData));
            gs.processGIFPacket(packet.data(), static_cast<uint32_t>(packet.size()));

            // Read back from local to host in CT24.
            gs.writeRegister(GS_REG_TRXDIR, 1ull);
            uint8_t out[16] = {};
            const uint32_t outBytes = gs.consumeLocalToHostBytes(out, sizeof(out));

            t.Equals(outBytes, 6u, "CT24 local->host read should output 3 bytes per pixel");
            t.Equals(out[0], static_cast<uint8_t>(0x11u), "pixel0 R should roundtrip");
            t.Equals(out[1], static_cast<uint8_t>(0x22u), "pixel0 G should roundtrip");
            t.Equals(out[2], static_cast<uint8_t>(0x33u), "pixel0 B should roundtrip");
            t.Equals(out[3], static_cast<uint8_t>(0x44u), "pixel1 R should roundtrip");
            t.Equals(out[4], static_cast<uint8_t>(0x55u), "pixel1 G should roundtrip");
            t.Equals(out[5], static_cast<uint8_t>(0x66u), "pixel1 B should roundtrip");
        });

        tc.Run("GS PSMT4 host-local-host keeps nibble packing stable", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            const uint64_t bitblt =
                (static_cast<uint64_t>(0u) << 0) |      // SBP
                (static_cast<uint64_t>(1u) << 16) |     // SBW
                (static_cast<uint64_t>(20u) << 24) |    // SPSM PSMT4
                (static_cast<uint64_t>(0u) << 32) |     // DBP
                (static_cast<uint64_t>(1u) << 48) |     // DBW
                (static_cast<uint64_t>(20u) << 56);     // DPSM PSMT4
            gs.writeRegister(GS_REG_BITBLTBUF, bitblt);
            gs.writeRegister(GS_REG_TRXPOS, 0ull);
            gs.writeRegister(GS_REG_TRXREG, (4ull << 0) | (1ull << 32)); // 4 texels => 2 bytes
            gs.writeRegister(GS_REG_TRXDIR, 0ull);

            std::vector<uint8_t> packet;
            appendU64(packet, makeGifTag(1u, GIF_FMT_IMAGE, 0u, true));
            appendU64(packet, 0ull);
            const uint8_t nibbleData[16] = {0x21u, 0x43u};
            packet.insert(packet.end(), nibbleData, nibbleData + sizeof(nibbleData));
            gs.processGIFPacket(packet.data(), static_cast<uint32_t>(packet.size()));

            gs.writeRegister(GS_REG_TRXDIR, 1ull);
            uint8_t out[8] = {};
            const uint32_t outBytes = gs.consumeLocalToHostBytes(out, sizeof(out));

            t.Equals(outBytes, 2u, "PSMT4 local->host should return packed nibble bytes");
            t.Equals(out[0], static_cast<uint8_t>(0x21u), "packed nibble byte 0 should roundtrip");
            t.Equals(out[1], static_cast<uint8_t>(0x43u), "packed nibble byte 1 should roundtrip");
        });

        tc.Run("GS PSMT4 host-local upload keeps position across split IMAGE packets", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            const uint64_t bitblt =
                (static_cast<uint64_t>(0u) << 0) |
                (static_cast<uint64_t>(1u) << 16) |
                (static_cast<uint64_t>(GS_PSM_T4) << 24) |
                (static_cast<uint64_t>(0u) << 32) |
                (static_cast<uint64_t>(1u) << 48) |
                (static_cast<uint64_t>(GS_PSM_T4) << 56);
            gs.writeRegister(GS_REG_BITBLTBUF, bitblt);
            gs.writeRegister(GS_REG_TRXPOS, 0ull);
            gs.writeRegister(GS_REG_TRXREG, (8ull << 0) | (8ull << 32)); // 64 texels => 32 bytes
            gs.writeRegister(GS_REG_TRXDIR, 0ull);

            uint8_t packedSource[32] = {};
            for (uint32_t i = 0; i < 32u; ++i)
            {
                packedSource[i] = static_cast<uint8_t>(0x10u + i);
            }

            std::vector<uint8_t> packetA;
            appendU64(packetA, makeGifTag(1u, GIF_FMT_IMAGE, 0u, true));
            appendU64(packetA, 0ull);
            packetA.insert(packetA.end(), packedSource, packedSource + 16u);

            std::vector<uint8_t> packetB;
            appendU64(packetB, makeGifTag(1u, GIF_FMT_IMAGE, 0u, true));
            appendU64(packetB, 0ull);
            packetB.insert(packetB.end(), packedSource + 16u, packedSource + 32u);

            gs.processGIFPacket(packetA.data(), static_cast<uint32_t>(packetA.size()));
            gs.processGIFPacket(packetB.data(), static_cast<uint32_t>(packetB.size()));

            gs.writeRegister(GS_REG_TRXDIR, 1ull);
            uint8_t out[32] = {};
            const uint32_t outBytes = gs.consumeLocalToHostBytes(out, sizeof(out));

            t.Equals(outBytes, 32u, "split T4 IMAGE upload should fill the full packed byte range");
            for (uint32_t i = 0; i < 32u; ++i)
            {
                t.Equals(out[i], packedSource[i], "split T4 IMAGE upload should preserve packed nibble order");
            }
        });

        tc.Run("GS CT32 upload aliases cleanly into later PSMT8 sampling", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint32_t kTexWidth = 128u;
            constexpr uint32_t kTexHeight = 64u;
            constexpr uint32_t kUploadWidth = 64u;
            constexpr uint32_t kUploadHeight = 32u;
            constexpr uint32_t kTexTbp = 0u;
            constexpr uint32_t kTexTbw = 2u;

            std::vector<uint8_t> source(kTexWidth * kTexHeight, 0u);
            for (uint32_t i = 0; i < source.size(); ++i)
            {
                source[i] = static_cast<uint8_t>((i * 37u + 11u) & 0xFFu);
            }

            std::vector<uint16_t> rawToUpload(8192u, 0xFFFFu);
            for (uint32_t y = 0; y < kUploadHeight; ++y)
            {
                for (uint32_t x = 0; x < kUploadWidth; ++x)
                {
                    const uint32_t rawBase = referenceAddrPSMCT32(kTexTbp, 1u, x, y);
                    const uint32_t uploadBase = ((y * kUploadWidth) + x) * 4u;
                    for (uint32_t c = 0; c < 4u; ++c)
                    {
                        rawToUpload[rawBase + c] = static_cast<uint16_t>(uploadBase + c);
                    }
                }
            }

            bool inverseComplete = true;
            for (uint16_t byteOff : rawToUpload)
            {
                if (byteOff == 0xFFFFu)
                {
                    inverseComplete = false;
                    break;
                }
            }
            t.IsTrue(inverseComplete,
                     "reference CT32 raw-to-upload map should cover every byte in a 64x32 CT32 page");

            std::vector<uint8_t> upload(kUploadWidth * kUploadHeight * 4u, 0u);
            for (uint32_t y = 0; y < kTexHeight; ++y)
            {
                for (uint32_t x = 0; x < kTexWidth; ++x)
                {
                    const uint32_t texelIndex = y * kTexWidth + x;
                    const uint32_t rawOff = referenceAddrPSMT8(kTexTbp, kTexTbw, x, y);
                    const uint32_t uploadOff = rawToUpload[rawOff];
                    upload[uploadOff] = source[texelIndex];
                }
            }

            const uint64_t bitblt =
                (static_cast<uint64_t>(0u) << 0) |
                (static_cast<uint64_t>(1u) << 16) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 24) |
                (static_cast<uint64_t>(kTexTbp) << 32) |
                (static_cast<uint64_t>(1u) << 48) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 56);
            gs.writeRegister(GS_REG_BITBLTBUF, bitblt);
            gs.writeRegister(GS_REG_TRXPOS, 0ull);
            gs.writeRegister(GS_REG_TRXREG, (static_cast<uint64_t>(kUploadWidth) << 0) |
                                            (static_cast<uint64_t>(kUploadHeight) << 32));
            gs.writeRegister(GS_REG_TRXDIR, 0ull);

            std::vector<uint8_t> packet;
            appendU64(packet, makeGifTag(static_cast<uint16_t>(upload.size() / 16u), GIF_FMT_IMAGE, 0u, true));
            appendU64(packet, 0ull);
            packet.insert(packet.end(), upload.begin(), upload.end());
            gs.processGIFPacket(packet.data(), static_cast<uint32_t>(packet.size()));

            bool aliasOk = true;
            uint32_t badX = 0u;
            uint32_t badY = 0u;
            uint32_t got = 0u;
            uint32_t expected = 0u;
            for (uint32_t y = 0; y < kTexHeight && aliasOk; ++y)
            {
                for (uint32_t x = 0; x < kTexWidth; ++x)
                {
                    const uint32_t texelOff = GSPSMT8::addrPSMT8(kTexTbp, kTexTbw, x, y);
                    got = vram[texelOff];
                    expected = source[y * kTexWidth + x];
                    if (got != expected)
                    {
                        aliasOk = false;
                        badX = x;
                        badY = y;
                        break;
                    }
                }
            }

            if (!aliasOk)
            {
                t.Fail("CT32 image upload should preserve Veronica's later PSMT8 sampling layout "
                       "(first mismatch at x=" + std::to_string(badX) +
                       ", y=" + std::to_string(badY) +
                       ", got " + std::to_string(got) +
                       ", expected " + std::to_string(expected) + ")");
            }
        });

        tc.Run("GS PSMT4 local-local copy respects swizzled page layout", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint32_t kSrcBp = 64u;
            constexpr uint32_t kDstBp = 96u;
            constexpr uint64_t kUploadBitblt =
                (static_cast<uint64_t>(0u) << 0) |
                (static_cast<uint64_t>(2u) << 16) |
                (static_cast<uint64_t>(GS_PSM_T4) << 24) |
                (static_cast<uint64_t>(kSrcBp) << 32) |
                (static_cast<uint64_t>(2u) << 48) |
                (static_cast<uint64_t>(GS_PSM_T4) << 56);
            constexpr uint64_t kCopyBitblt =
                (static_cast<uint64_t>(kSrcBp) << 0) |
                (static_cast<uint64_t>(2u) << 16) |
                (static_cast<uint64_t>(GS_PSM_T4) << 24) |
                (static_cast<uint64_t>(kDstBp) << 32) |
                (static_cast<uint64_t>(2u) << 48) |
                (static_cast<uint64_t>(GS_PSM_T4) << 56);
            constexpr uint64_t kCopyPos =
                (static_cast<uint64_t>(0u) << 0) |
                (static_cast<uint64_t>(0u) << 16) |
                (static_cast<uint64_t>(32u) << 32) |
                (static_cast<uint64_t>(16u) << 48);
            constexpr uint64_t kReadBitblt =
                (static_cast<uint64_t>(kDstBp) << 0) |
                (static_cast<uint64_t>(2u) << 16) |
                (static_cast<uint64_t>(GS_PSM_T4) << 24) |
                (static_cast<uint64_t>(0u) << 32) |
                (static_cast<uint64_t>(2u) << 48) |
                (static_cast<uint64_t>(GS_PSM_T4) << 56);
            constexpr uint64_t kReadPos =
                (static_cast<uint64_t>(32u) << 0) |
                (static_cast<uint64_t>(16u) << 16);
            constexpr uint64_t kRect = (8ull << 0) | (4ull << 32);
            const uint8_t packedSource[16] = {
                0x10u, 0x32u, 0x54u, 0x76u,
                0x98u, 0xBAu, 0xDCu, 0xFEu,
                0x01u, 0x23u, 0x45u, 0x67u,
                0x89u, 0xABu, 0xCDu, 0xEFu
            };

            gs.writeRegister(GS_REG_BITBLTBUF, kUploadBitblt);
            gs.writeRegister(GS_REG_TRXPOS, 0ull);
            gs.writeRegister(GS_REG_TRXREG, kRect);
            gs.writeRegister(GS_REG_TRXDIR, 0ull);

            std::vector<uint8_t> packet;
            appendU64(packet, makeGifTag(1u, GIF_FMT_IMAGE, 0u, true));
            appendU64(packet, 0ull);
            packet.insert(packet.end(), packedSource, packedSource + sizeof(packedSource));
            gs.processGIFPacket(packet.data(), static_cast<uint32_t>(packet.size()));

            gs.writeRegister(GS_REG_BITBLTBUF, kCopyBitblt);
            gs.writeRegister(GS_REG_TRXPOS, kCopyPos);
            gs.writeRegister(GS_REG_TRXREG, kRect);
            gs.writeRegister(GS_REG_TRXDIR, 2ull);

            gs.writeRegister(GS_REG_BITBLTBUF, kReadBitblt);
            gs.writeRegister(GS_REG_TRXPOS, kReadPos);
            gs.writeRegister(GS_REG_TRXREG, kRect);
            gs.writeRegister(GS_REG_TRXDIR, 1ull);

            uint8_t out[16] = {};
            const uint32_t outBytes = gs.consumeLocalToHostBytes(out, sizeof(out));
            t.Equals(outBytes, 16u, "PSMT4 local-local copy should preserve the full packed byte count");
            for (size_t i = 0; i < sizeof(packedSource); ++i)
            {
                t.Equals(out[i], packedSource[i], "PSMT4 local-local copy should preserve packed nibble order");
            }
        });

        tc.Run("GS T4 CSM1 lookup matches Veronica ClutCopy layout", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint32_t kTexTbp = 64u;
            constexpr uint32_t kClutCbp = 128u;
            constexpr uint32_t kFrameReg =
                (0ull << 0) |
                (1ull << 16) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kZbuf = (1ull << 32);
            constexpr uint64_t kTex0 =
                (static_cast<uint64_t>(kTexTbp) << 0) |
                (1ull << 14) |
                (static_cast<uint64_t>(GS_PSM_T4) << 20) |
                (0ull << 26) |
                (0ull << 30) |
                (1ull << 34) |
                (1ull << 35) |
                (static_cast<uint64_t>(kClutCbp) << 37) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 51);
            constexpr uint64_t kPrim =
                static_cast<uint64_t>(GS_PRIM_SPRITE) |
                (1ull << 4) |  // TME
                (1ull << 8);   // FST
            constexpr uint32_t kExpectedColor = 0x800000FFu; // RGBA = (255,0,0,128)
            constexpr uint32_t kWrongColor = 0x8000FF00u;    // RGBA = (0,255,0,128)

            const uint32_t texNibbleAddr = GSPSMT4::addrPSMT4(kTexTbp, 1u, 0u, 0u);
            const uint32_t texByteOff = texNibbleAddr >> 1;
            vram[texByteOff] = static_cast<uint8_t>((vram[texByteOff] & 0xF0u) | 0x08u);

            // Veronica uploads CSM1 CLUT rows with a 64-pixel GS stride, so logical entry 8
            // resolves to row 1, column 0 after the CSM1 swizzle.
            const uint32_t wrongClutOff = GSPSMCT32::addrPSMCT32(kClutCbp, 1u, 8u, 0u);
            const uint32_t expectedClutOff = GSPSMCT32::addrPSMCT32(kClutCbp, 1u, 0u, 1u);
            std::memcpy(vram.data() + wrongClutOff, &kWrongColor, sizeof(kWrongColor));
            std::memcpy(vram.data() + expectedClutOff, &kExpectedColor, sizeof(kExpectedColor));

            gs.writeRegister(GS_REG_FRAME_1, kFrameReg);
            gs.writeRegister(GS_REG_ZBUF_1, kZbuf);
            gs.writeRegister(GS_REG_SCISSOR_1, 0ull);
            gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
            gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
            gs.writeRegister(GS_REG_ALPHA_1, 0ull);
            gs.writeRegister(GS_REG_TEX0_1, kTex0);
            gs.writeRegister(GS_REG_PRIM, kPrim);
            gs.writeRegister(GS_REG_RGBAQ, 0x80808080ull);
            gs.writeRegister(GS_REG_UV, 0ull);
            gs.writeRegister(GS_REG_XYZ2, 0ull);
            gs.writeRegister(GS_REG_UV, 0ull);
            gs.writeRegister(GS_REG_XYZ2, 0ull);

            uint32_t pixel = 0u;
            std::memcpy(&pixel, vram.data(), sizeof(pixel));
            t.Equals(pixel, kExpectedColor,
                     "T4 CSM1 lookup should follow Veronica's swizzled CLUT row layout for logical index 8");
        });

        tc.Run("GS T8 CT32-uploaded CSM1 CLUT follows swizzled palette layout", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint32_t kTexTbp = 64u;
            constexpr uint32_t kClutCbp = 128u;
            constexpr uint64_t kFrameReg =
                (0ull << 0) |
                (1ull << 16) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kZbuf = (1ull << 32);
            constexpr uint64_t kTex0 =
                (static_cast<uint64_t>(kTexTbp) << 0) |
                (1ull << 14) |
                (static_cast<uint64_t>(GS_PSM_T8) << 20) |
                (0ull << 26) |
                (0ull << 30) |
                (1ull << 34) |
                (1ull << 35) |
                (static_cast<uint64_t>(kClutCbp) << 37) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 51);
            constexpr uint64_t kPrim =
                static_cast<uint64_t>(GS_PRIM_SPRITE) |
                (1ull << 4) |  // TME
                (1ull << 8);   // FST
            constexpr uint64_t kClutBitblt =
                (0ull << 0) |
                (1ull << 16) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 24) |
                (static_cast<uint64_t>(kClutCbp) << 32) |
                (1ull << 48) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 56);
            constexpr uint64_t kClutRect =
                (16ull << 0) |
                (2ull << 32);
            constexpr uint32_t kExpectedColor = 0x80FFFFFFu;

            const uint32_t texOff = GSPSMT8::addrPSMT8(kTexTbp, 1u, 0u, 0u);
            vram[texOff] = 8u;

            std::vector<uint32_t> clut(32u, 0u);
            clut[16] = kExpectedColor;

            gs.writeRegister(GS_REG_BITBLTBUF, kClutBitblt);
            gs.writeRegister(GS_REG_TRXPOS, 0ull);
            gs.writeRegister(GS_REG_TRXREG, kClutRect);
            gs.writeRegister(GS_REG_TRXDIR, 0ull);

            std::vector<uint8_t> packet;
            appendU64(packet,
                      makeGifTag(static_cast<uint16_t>((clut.size() * sizeof(uint32_t)) / 16u),
                                 GIF_FMT_IMAGE,
                                 0u,
                                 true));
            appendU64(packet, 0ull);
            const size_t payloadOffset = packet.size();
            packet.resize(payloadOffset + clut.size() * sizeof(uint32_t));
            std::memcpy(packet.data() + payloadOffset, clut.data(), clut.size() * sizeof(uint32_t));
            gs.processGIFPacket(packet.data(), static_cast<uint32_t>(packet.size()));

            gs.writeRegister(GS_REG_FRAME_1, kFrameReg);
            gs.writeRegister(GS_REG_ZBUF_1, kZbuf);
            gs.writeRegister(GS_REG_SCISSOR_1, 0ull);
            gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
            gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
            gs.writeRegister(GS_REG_ALPHA_1, 0ull);
            gs.writeRegister(GS_REG_TEX0_1, kTex0);
            gs.writeRegister(GS_REG_PRIM, kPrim);
            gs.writeRegister(GS_REG_RGBAQ, 0x80808080ull);
            gs.writeRegister(GS_REG_UV, 0ull);
            gs.writeRegister(GS_REG_XYZ2, 0ull);
            gs.writeRegister(GS_REG_UV, 0ull);
            gs.writeRegister(GS_REG_XYZ2, 0ull);

            uint32_t pixel = 0u;
            std::memcpy(&pixel, vram.data(), sizeof(pixel));
            t.Equals(pixel, kExpectedColor,
                     "T8 CSM1 CLUT sampling should read CT32-uploaded palette entries through GS swizzled addressing");
        });

        tc.Run("GS T8 CSM1 applies CSA and masks CSA bit 4 for CT32 CLUTs", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint32_t kTexTbp = 64u;
            constexpr uint32_t kClutCbp = 128u;
            constexpr uint64_t kFrameReg =
                (0ull << 0) |
                (1ull << 16) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kZbuf = (1ull << 32);
            constexpr uint64_t kTex0 =
                (static_cast<uint64_t>(kTexTbp) << 0) |
                (1ull << 14) |
                (static_cast<uint64_t>(GS_PSM_T8) << 20) |
                (0ull << 26) |
                (0ull << 30) |
                (1ull << 34) |
                (1ull << 35) |
                (static_cast<uint64_t>(kClutCbp) << 37) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 51) |
                (17ull << 56);
            constexpr uint64_t kPrim =
                static_cast<uint64_t>(GS_PRIM_SPRITE) |
                (1ull << 4) |
                (1ull << 8);
            constexpr uint32_t kExpectedColor = 0xFF204080u;
            constexpr uint32_t kWrongNoCsaColor = 0xFF00FF00u;
            constexpr uint32_t kWrongBit4Color = 0xFFFF0000u;

            const uint32_t texOff = GSPSMT8::addrPSMT8(kTexTbp, 1u, 0u, 0u);
            vram[texOff] = 0u;

            // CSA=17 is CSA=1 for a CT32 CLUT. Logical entry 16 is at
            // physical CSM1 entry 8 after address bits 3 and 4 are swapped.
            gs.WriteVram(GS_PSM_CT32, kClutCbp, 1u, 0u, 0u, kWrongNoCsaColor);
            gs.WriteVram(GS_PSM_CT32, kClutCbp, 1u, 8u, 0u, kExpectedColor);
            gs.WriteVram(GS_PSM_CT32, kClutCbp, 1u, 8u, 16u, kWrongBit4Color);

            gs.writeRegister(GS_REG_FRAME_1, kFrameReg);
            gs.writeRegister(GS_REG_ZBUF_1, kZbuf);
            gs.writeRegister(GS_REG_SCISSOR_1, 0ull);
            gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
            gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
            gs.writeRegister(GS_REG_ALPHA_1, 0ull);
            gs.writeRegister(GS_REG_TEX0_1, kTex0);
            gs.writeRegister(GS_REG_PRIM, kPrim);
            gs.writeRegister(GS_REG_RGBAQ, 0x80808080ull);
            gs.writeRegister(GS_REG_UV, 0ull);
            gs.writeRegister(GS_REG_XYZ2, 0ull);
            gs.writeRegister(GS_REG_UV, 0ull);
            gs.writeRegister(GS_REG_XYZ2, 0ull);

            uint32_t pixel = 0u;
            std::memcpy(&pixel, vram.data(), sizeof(pixel));
            t.Equals(pixel, kExpectedColor,
                     "T8 CSM1 should offset by CSA while CT32 ignores the fifth CSA bit");
        });

        tc.Run("GS T4 CSM1 preserves CSA bit 4 for CT16 CLUTs", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint32_t kTexTbp = 64u;
            constexpr uint32_t kClutCbp = 128u;
            constexpr uint64_t kFrameReg =
                (0ull << 0) |
                (1ull << 16) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kZbuf = (1ull << 32);
            constexpr uint64_t kTex0 =
                (static_cast<uint64_t>(kTexTbp) << 0) |
                (1ull << 14) |
                (static_cast<uint64_t>(GS_PSM_T4) << 20) |
                (0ull << 26) |
                (0ull << 30) |
                (1ull << 34) |
                (1ull << 35) |
                (static_cast<uint64_t>(kClutCbp) << 37) |
                (static_cast<uint64_t>(GS_PSM_CT16) << 51) |
                (16ull << 56);
            constexpr uint64_t kTexa = (0x80ull << 32);
            constexpr uint64_t kPrim =
                static_cast<uint64_t>(GS_PRIM_SPRITE) |
                (1ull << 4) |
                (1ull << 8);
            constexpr uint16_t kExpectedRed = 0x801Fu;
            constexpr uint16_t kWrongGreen = 0x83E0u;
            constexpr uint32_t kExpectedColor = 0x800000F8u;

            writePSMT4Texel(vram, kTexTbp, 1u, 0u, 0u, 1u);

            // CSA=16 selects the upper half of a CT16 CLUT. CSM1 swaps bits
            // 3 and 4 but must preserve address bit 8.
            gs.WriteVram(GS_PSM_CT16, kClutCbp, 1u, 1u, 0u, kWrongGreen);
            gs.WriteVram(GS_PSM_CT16, kClutCbp, 1u, 1u, 16u, kExpectedRed);

            gs.writeRegister(GS_REG_FRAME_1, kFrameReg);
            gs.writeRegister(GS_REG_ZBUF_1, kZbuf);
            gs.writeRegister(GS_REG_SCISSOR_1, 0ull);
            gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
            gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
            gs.writeRegister(GS_REG_ALPHA_1, 0ull);
            gs.writeRegister(GS_REG_TEX0_1, kTex0);
            gs.writeRegister(GS_REG_TEXA, kTexa);
            gs.writeRegister(GS_REG_PRIM, kPrim);
            gs.writeRegister(GS_REG_RGBAQ, 0x80808080ull);
            gs.writeRegister(GS_REG_UV, 0ull);
            gs.writeRegister(GS_REG_XYZ2, 0ull);
            gs.writeRegister(GS_REG_UV, 0ull);
            gs.writeRegister(GS_REG_XYZ2, 0ull);

            uint32_t pixel = 0u;
            std::memcpy(&pixel, vram.data(), sizeof(pixel));
            t.Equals(pixel, kExpectedColor,
                     "CT16 CSM1 should retain CSA[4] instead of aliasing the upper palette onto the lower one");
        });

        tc.Run("GS TEX0 dimensions saturate at 1024 pixels", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint32_t kTexTbp = 64u;
            constexpr uint64_t kFrameReg =
                (0ull << 0) |
                (1ull << 16) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kZbuf = (1ull << 32);
            constexpr uint64_t kTex0 =
                (static_cast<uint64_t>(kTexTbp) << 0) |
                (16ull << 14) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 20) |
                (15ull << 26) |
                (15ull << 30) |
                (1ull << 34) |
                (1ull << 35);
            constexpr uint64_t kPrim =
                static_cast<uint64_t>(GS_PRIM_SPRITE) |
                (1ull << 4);
            constexpr uint32_t kExpectedColor = 0xFF3366CCu;
            constexpr uint32_t kUnsaturatedColor = 0xFF00FF00u;

            auto packFloat = [](float value) -> uint32_t
            {
                uint32_t bits = 0u;
                std::memcpy(&bits, &value, sizeof(bits));
                return bits;
            };
            auto packSt = [&](float s, float tValue) -> uint64_t
            {
                return static_cast<uint64_t>(packFloat(s)) |
                       (static_cast<uint64_t>(packFloat(tValue)) << 32u);
            };

            gs.WriteVram(GS_PSM_CT32, kTexTbp, 16u, 1u, 0u, kExpectedColor);
            gs.WriteVram(GS_PSM_CT32, kTexTbp, 16u, 32u, 0u, kUnsaturatedColor);
            gs.writeRegister(GS_REG_FRAME_1, kFrameReg);
            gs.writeRegister(GS_REG_ZBUF_1, kZbuf);
            gs.writeRegister(GS_REG_SCISSOR_1, 0ull);
            gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
            gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
            gs.writeRegister(GS_REG_TEX0_1, kTex0);
            gs.writeRegister(GS_REG_PRIM, kPrim);
            gs.writeRegister(GS_REG_RGBAQ, 0x3F80000080808080ull);
            gs.writeRegister(GS_REG_ST, packSt(1.0f / 1024.0f, 0.0f));
            gs.writeRegister(GS_REG_XYZ2, 0ull);
            gs.writeRegister(GS_REG_ST, packSt(1.0f / 1024.0f, 0.0f));
            gs.writeRegister(GS_REG_XYZ2, (16ull << 0) | (16ull << 16));

            const uint32_t sampled = gs.ReadVram(GS_PSM_CT32, 0u, 1u, 0u, 0u);
            t.Equals(sampled, kExpectedColor,
                     "TW/TH values above 10 should address a 1024-pixel texture instead of growing beyond GS limits");
        });

        tc.Run("GS backend replacement preserves canonical local memory", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint32_t kColor = 0xA55A33CCu;
            gs.WriteVram(GS_PSM_CT32, 64u, 1u, 3u, 2u, kColor);
            gs.setRasterBackend(nullptr);

            t.Equals(gs.ReadVram(GS_PSM_CT32, 64u, 1u, 3u, 2u), kColor,
                     "switching raster backends must retain the logical 4 MiB GS local memory");
        });

        tc.Run("GS TEX2 updates CLUT state independently from TEX0", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint32_t kTexTbp = 64u;
            constexpr uint32_t kWrongClutCbp = 128u;
            constexpr uint32_t kExpectedClutCbp = 192u;
            constexpr uint64_t kFrameReg =
                (0ull << 0) |
                (1ull << 16) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kZbuf = (1ull << 32);
            constexpr uint64_t kTex0 =
                (static_cast<uint64_t>(kTexTbp) << 0) |
                (1ull << 14) |
                (static_cast<uint64_t>(GS_PSM_T8) << 20) |
                (0ull << 26) |
                (0ull << 30) |
                (1ull << 34) |
                (1ull << 35) |
                (static_cast<uint64_t>(kWrongClutCbp) << 37) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 51) |
                (1ull << 55);
            constexpr uint64_t kTex2 =
                (static_cast<uint64_t>(GS_PSM_T8) << 20) |
                (static_cast<uint64_t>(kExpectedClutCbp) << 37) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 51) |
                (1ull << 55);
            constexpr uint64_t kPrim =
                static_cast<uint64_t>(GS_PRIM_SPRITE) |
                (1ull << 4) |
                (1ull << 8);
            constexpr uint32_t kWrongColor = 0xFF00FF00u;
            constexpr uint32_t kExpectedColor = 0xFF0000FFu;

            const uint32_t texOff = GSPSMT8::addrPSMT8(kTexTbp, 1u, 0u, 0u);
            vram[texOff] = 8u;

            const uint32_t wrongClutOff = GSPSMCT32::addrPSMCT32(kWrongClutCbp, 1u, 8u, 0u);
            const uint32_t expectedClutOff = GSPSMCT32::addrPSMCT32(kExpectedClutCbp, 1u, 8u, 0u);
            std::memcpy(vram.data() + wrongClutOff, &kWrongColor, sizeof(kWrongColor));
            std::memcpy(vram.data() + expectedClutOff, &kExpectedColor, sizeof(kExpectedColor));

            gs.writeRegister(GS_REG_FRAME_1, kFrameReg);
            gs.writeRegister(GS_REG_ZBUF_1, kZbuf);
            gs.writeRegister(GS_REG_SCISSOR_1, 0ull);
            gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
            gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
            gs.writeRegister(GS_REG_ALPHA_1, 0ull);
            gs.writeRegister(GS_REG_TEX0_1, kTex0);
            gs.writeRegister(GS_REG_TEX2_1, kTex2);
            gs.writeRegister(GS_REG_PRIM, kPrim);
            gs.writeRegister(GS_REG_RGBAQ, 0x80808080ull);
            gs.writeRegister(GS_REG_UV, 0ull);
            gs.writeRegister(GS_REG_XYZ2, 0ull);
            gs.writeRegister(GS_REG_UV, 0ull);
            gs.writeRegister(GS_REG_XYZ2, (16ull << 0) | (16ull << 16));

            uint32_t pixel = 0u;
            std::memcpy(&pixel, vram.data(), sizeof(pixel));
            t.Equals(pixel, kExpectedColor,
                     "TEX2 should override the active CLUT base and format state without requiring a new TEX0 write");
        });

        tc.Run("GS CSM2 TEXCLUT offsets T8 CLUT fetch coordinates", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint32_t kTexTbp = 64u;
            constexpr uint32_t kClutCbp = 128u;
            constexpr uint64_t kFrameReg =
                (0ull << 0) |
                (1ull << 16) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kZbuf = (1ull << 32);
            constexpr uint64_t kTex0 =
                (static_cast<uint64_t>(kTexTbp) << 0) |
                (1ull << 14) |
                (static_cast<uint64_t>(GS_PSM_T8) << 20) |
                (0ull << 26) |
                (0ull << 30) |
                (1ull << 34) |
                (1ull << 35) |
                (static_cast<uint64_t>(kClutCbp) << 37) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 51) |
                (1ull << 55);
            constexpr uint64_t kTexClut =
                (1ull << 0) |
                (3ull << 6) |
                (2ull << 12);
            constexpr uint64_t kPrim =
                static_cast<uint64_t>(GS_PRIM_SPRITE) |
                (1ull << 4) |
                (1ull << 8);
            constexpr uint32_t kWrongColor = 0xFF00FF00u;
            constexpr uint32_t kExpectedColor = 0xFF3366CCu;

            const uint32_t texOff = GSPSMT8::addrPSMT8(kTexTbp, 1u, 0u, 0u);
            vram[texOff] = 0u;

            const uint32_t wrongClutOff = GSPSMCT32::addrPSMCT32(kClutCbp, 1u, 0u, 0u);
            const uint32_t expectedClutOff = GSPSMCT32::addrPSMCT32(kClutCbp, 1u, 48u, 2u);
            std::memcpy(vram.data() + wrongClutOff, &kWrongColor, sizeof(kWrongColor));
            std::memcpy(vram.data() + expectedClutOff, &kExpectedColor, sizeof(kExpectedColor));

            gs.writeRegister(GS_REG_FRAME_1, kFrameReg);
            gs.writeRegister(GS_REG_ZBUF_1, kZbuf);
            gs.writeRegister(GS_REG_SCISSOR_1, 0ull);
            gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
            gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
            gs.writeRegister(GS_REG_ALPHA_1, 0ull);
            gs.writeRegister(GS_REG_TEX0_1, kTex0);
            gs.writeRegister(GS_REG_TEXCLUT, kTexClut);
            gs.writeRegister(GS_REG_PRIM, kPrim);
            gs.writeRegister(GS_REG_RGBAQ, 0x80808080ull);
            gs.writeRegister(GS_REG_UV, 0ull);
            gs.writeRegister(GS_REG_XYZ2, 0ull);
            gs.writeRegister(GS_REG_UV, 0ull);
            gs.writeRegister(GS_REG_XYZ2, (16ull << 0) | (16ull << 16));

            uint32_t pixel = 0u;
            std::memcpy(&pixel, vram.data(), sizeof(pixel));
            t.Equals(pixel, kExpectedColor,
                     "CSM2 should apply TEXCLUT COU in 16-pixel units and COV in rows");
        });

        tc.Run("GS CSM1 ignores TEXCLUT fetch coordinates", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint32_t kTexTbp = 64u;
            constexpr uint32_t kClutCbp = 128u;
            constexpr uint64_t kFrameReg =
                (1ull << 16) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kTex0 =
                (static_cast<uint64_t>(kTexTbp) << 0) |
                (1ull << 14) |
                (static_cast<uint64_t>(GS_PSM_T8) << 20) |
                (1ull << 34) |
                (1ull << 35) |
                (static_cast<uint64_t>(kClutCbp) << 37) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 51);
            constexpr uint64_t kTexClut =
                (1ull << 0) |
                (3ull << 6) |
                (2ull << 12);
            constexpr uint64_t kPrim =
                static_cast<uint64_t>(GS_PRIM_SPRITE) |
                (1ull << 4) |
                (1ull << 8);
            constexpr uint32_t kExpectedColor = 0xFF3366CCu;
            constexpr uint32_t kWrongColor = 0xFF00FF00u;

            const uint32_t texOff = GSPSMT8::addrPSMT8(kTexTbp, 1u, 0u, 0u);
            vram[texOff] = 0u;

            const uint32_t expectedClutOff = GSPSMCT32::addrPSMCT32(kClutCbp, 1u, 0u, 0u);
            const uint32_t wrongClutOff = GSPSMCT32::addrPSMCT32(kClutCbp, 1u, 3u, 2u);
            std::memcpy(vram.data() + expectedClutOff, &kExpectedColor, sizeof(kExpectedColor));
            std::memcpy(vram.data() + wrongClutOff, &kWrongColor, sizeof(kWrongColor));

            gs.writeRegister(GS_REG_FRAME_1, kFrameReg);
            gs.writeRegister(GS_REG_ZBUF_1, (1ull << 32));
            gs.writeRegister(GS_REG_SCISSOR_1, 0ull);
            gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
            gs.writeRegister(GS_REG_TEX0_1, kTex0);
            gs.writeRegister(GS_REG_TEXCLUT, kTexClut);
            gs.writeRegister(GS_REG_PRIM, kPrim);
            gs.writeRegister(GS_REG_RGBAQ, 0x80808080ull);
            gs.writeRegister(GS_REG_UV, 0ull);
            gs.writeRegister(GS_REG_XYZ2, 0ull);
            gs.writeRegister(GS_REG_UV, 0ull);
            gs.writeRegister(GS_REG_XYZ2, (16ull << 0) | (16ull << 16));

            uint32_t pixel = 0u;
            std::memcpy(&pixel, vram.data(), sizeof(pixel));
            t.Equals(pixel, kExpectedColor,
                     "CSM1 should use its fixed CLUT layout regardless of TEXCLUT state");
        });

        tc.Run("GS TEXA expands CT24 alpha and honors AEM for black texels", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint32_t kTexTbp = 64u;
            constexpr uint64_t kFrameReg =
                (0ull << 0) |
                (1ull << 16) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kZbuf = (1ull << 32);
            constexpr uint64_t kScissor =
                (0ull << 0) |
                (1ull << 16) |
                (0ull << 32) |
                (0ull << 48);
            constexpr uint64_t kTex0 =
                (static_cast<uint64_t>(kTexTbp) << 0) |
                (1ull << 14) |
                (static_cast<uint64_t>(GS_PSM_CT24) << 20) |
                (1ull << 26) |
                (0ull << 30) |
                (1ull << 34) |
                (1ull << 35);
            constexpr uint64_t kTexa =
                (0x55ull << 0) |
                (1ull << 15) |
                (0xAAull << 32);
            constexpr uint64_t kPrim =
                static_cast<uint64_t>(GS_PRIM_SPRITE) |
                (1ull << 4) |
                (1ull << 8);
            constexpr uint32_t kExpectedRed = 0x550000FFu;
            constexpr uint32_t kExpectedBlack = 0x00000000u;

            const uint32_t redOff = GSPSMCT32::addrPSMCT32(kTexTbp, 1u, 0u, 0u);
            vram[redOff + 0u] = 0xFFu;
            vram[redOff + 1u] = 0x00u;
            vram[redOff + 2u] = 0x00u;
            vram[redOff + 3u] = 0x00u;

            const uint32_t blackOff = GSPSMCT32::addrPSMCT32(kTexTbp, 1u, 1u, 0u);
            vram[blackOff + 0u] = 0x00u;
            vram[blackOff + 1u] = 0x00u;
            vram[blackOff + 2u] = 0x00u;
            vram[blackOff + 3u] = 0x00u;

            gs.writeRegister(GS_REG_FRAME_1, kFrameReg);
            gs.writeRegister(GS_REG_ZBUF_1, kZbuf);
            gs.writeRegister(GS_REG_SCISSOR_1, kScissor);
            gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
            gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
            gs.writeRegister(GS_REG_ALPHA_1, 0ull);
            gs.writeRegister(GS_REG_TEX0_1, kTex0);
            gs.writeRegister(GS_REG_TEXA, kTexa);
            gs.writeRegister(GS_REG_PRIM, kPrim);
            gs.writeRegister(GS_REG_RGBAQ, 0x80808080ull);

            gs.writeRegister(GS_REG_UV, 0ull);
            gs.writeRegister(GS_REG_XYZ2, 0ull);
            gs.writeRegister(GS_REG_UV, 0ull);
            gs.writeRegister(GS_REG_XYZ2, (16ull << 0) | (16ull << 16));

            gs.writeRegister(GS_REG_UV, (16ull << 0));
            gs.writeRegister(GS_REG_XYZ2, (16ull << 0));
            gs.writeRegister(GS_REG_UV, (16ull << 0));
            gs.writeRegister(GS_REG_XYZ2, (32ull << 0) | (16ull << 16));

            const uint32_t redPixel = readReferencePSMCT32Pixel(vram, 0u, 1u, 0u, 0u);
            const uint32_t blackPixel = readReferencePSMCT32Pixel(vram, 0u, 1u, 1u, 0u);
            t.Equals(redPixel, kExpectedRed,
                     "TEXA should supply TA0 as the alpha for non-alpha CT24 texels");
            t.Equals(blackPixel, kExpectedBlack,
                     "TEXA AEM should force zero alpha when a CT24 texel is RGB=0");
        });

        tc.Run("GS TCC=0 MODULATE uses texture RGB and keeps vertex alpha", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint32_t kTexTbp = 64u;
            constexpr uint64_t kFrameReg =
                (0ull << 0) |
                (1ull << 16) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kZbuf = (1ull << 32);
            constexpr uint64_t kScissor =
                (0ull << 0) |
                (0ull << 16) |
                (0ull << 32) |
                (0ull << 48);
            constexpr uint64_t kTex0 =
                (static_cast<uint64_t>(kTexTbp) << 0) |
                (1ull << 14) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 20) |
                (0ull << 26) |
                (0ull << 30) |
                (0ull << 34) |
                (0ull << 35);
            constexpr uint64_t kPrim =
                static_cast<uint64_t>(GS_PRIM_SPRITE) |
                (1ull << 4) |
                (1ull << 8);
            constexpr uint32_t kTexturePixel =
                0x12u |
                (0x34u << 8) |
                (0x56u << 16) |
                (0x78u << 24);
            constexpr uint32_t kExpectedPixel =
                0x12u |
                (0x34u << 8) |
                (0x56u << 16) |
                (0x44u << 24);

            const uint32_t texOff = GSPSMCT32::addrPSMCT32(kTexTbp, 1u, 0u, 0u);
            std::memcpy(vram.data() + texOff, &kTexturePixel, sizeof(kTexturePixel));

            gs.writeRegister(GS_REG_FRAME_1, kFrameReg);
            gs.writeRegister(GS_REG_ZBUF_1, kZbuf);
            gs.writeRegister(GS_REG_SCISSOR_1, kScissor);
            gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
            gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
            gs.writeRegister(GS_REG_ALPHA_1, 0ull);
            gs.writeRegister(GS_REG_TEX0_1, kTex0);
            gs.writeRegister(GS_REG_PRIM, kPrim);
            gs.writeRegister(GS_REG_RGBAQ, 0x44808080ull);
            gs.writeRegister(GS_REG_UV, 0ull);
            gs.writeRegister(GS_REG_XYZ2, 0ull);
            gs.writeRegister(GS_REG_UV, 0ull);
            gs.writeRegister(GS_REG_XYZ2, (16ull << 0) | (16ull << 16));

            const uint32_t pixel = readReferencePSMCT32Pixel(vram, 0u, 1u, 0u, 0u);
            t.Equals(pixel, kExpectedPixel,
                     "TCC=0 MODULATE should still use texture RGB while sourcing alpha from the shaded vertex");
        });

        tc.Run("GS HIGHLIGHT adds vertex alpha into RGB and texture alpha into A", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint32_t kTexTbp = 64u;
            constexpr uint64_t kFrameReg =
                (0ull << 0) |
                (1ull << 16) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kZbuf = (1ull << 32);
            constexpr uint64_t kScissor =
                (0ull << 0) |
                (0ull << 16) |
                (0ull << 32) |
                (0ull << 48);
            constexpr uint64_t kTex0 =
                (static_cast<uint64_t>(kTexTbp) << 0) |
                (1ull << 14) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 20) |
                (0ull << 26) |
                (0ull << 30) |
                (1ull << 34) |
                (2ull << 35);
            constexpr uint64_t kPrim =
                static_cast<uint64_t>(GS_PRIM_SPRITE) |
                (1ull << 4) |
                (1ull << 8);
            constexpr uint32_t kTexturePixel =
                0x20u |
                (0x40u << 8) |
                (0x60u << 16) |
                (0x10u << 24);
            constexpr uint32_t kExpectedPixel =
                0x40u |
                (0x60u << 8) |
                (0x80u << 16) |
                (0x30u << 24);

            const uint32_t texOff = GSPSMCT32::addrPSMCT32(kTexTbp, 1u, 0u, 0u);
            std::memcpy(vram.data() + texOff, &kTexturePixel, sizeof(kTexturePixel));

            gs.writeRegister(GS_REG_FRAME_1, kFrameReg);
            gs.writeRegister(GS_REG_ZBUF_1, kZbuf);
            gs.writeRegister(GS_REG_SCISSOR_1, kScissor);
            gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
            gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
            gs.writeRegister(GS_REG_ALPHA_1, 0ull);
            gs.writeRegister(GS_REG_TEX0_1, kTex0);
            gs.writeRegister(GS_REG_PRIM, kPrim);
            gs.writeRegister(GS_REG_RGBAQ, 0x20808080ull);
            gs.writeRegister(GS_REG_UV, 0ull);
            gs.writeRegister(GS_REG_XYZ2, 0ull);
            gs.writeRegister(GS_REG_UV, 0ull);
            gs.writeRegister(GS_REG_XYZ2, (16ull << 0) | (16ull << 16));

            const uint32_t pixel = readReferencePSMCT32Pixel(vram, 0u, 1u, 0u, 0u);
            t.Equals(pixel, kExpectedPixel,
                     "HIGHLIGHT should add the shaded vertex alpha into RGB and accumulate texture plus vertex alpha");
        });

        tc.Run("GS HIGHLIGHT2 keeps texture alpha while adding vertex alpha into RGB", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint32_t kTexTbp = 64u;
            constexpr uint64_t kFrameReg =
                (0ull << 0) |
                (1ull << 16) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kZbuf = (1ull << 32);
            constexpr uint64_t kScissor =
                (0ull << 0) |
                (0ull << 16) |
                (0ull << 32) |
                (0ull << 48);
            constexpr uint64_t kTex0 =
                (static_cast<uint64_t>(kTexTbp) << 0) |
                (1ull << 14) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 20) |
                (0ull << 26) |
                (0ull << 30) |
                (1ull << 34) |
                (3ull << 35);
            constexpr uint64_t kPrim =
                static_cast<uint64_t>(GS_PRIM_SPRITE) |
                (1ull << 4) |
                (1ull << 8);
            constexpr uint32_t kTexturePixel =
                0x20u |
                (0x40u << 8) |
                (0x60u << 16) |
                (0x10u << 24);
            constexpr uint32_t kExpectedPixel =
                0x40u |
                (0x60u << 8) |
                (0x80u << 16) |
                (0x10u << 24);

            const uint32_t texOff = GSPSMCT32::addrPSMCT32(kTexTbp, 1u, 0u, 0u);
            std::memcpy(vram.data() + texOff, &kTexturePixel, sizeof(kTexturePixel));

            gs.writeRegister(GS_REG_FRAME_1, kFrameReg);
            gs.writeRegister(GS_REG_ZBUF_1, kZbuf);
            gs.writeRegister(GS_REG_SCISSOR_1, kScissor);
            gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
            gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
            gs.writeRegister(GS_REG_ALPHA_1, 0ull);
            gs.writeRegister(GS_REG_TEX0_1, kTex0);
            gs.writeRegister(GS_REG_PRIM, kPrim);
            gs.writeRegister(GS_REG_RGBAQ, 0x20808080ull);
            gs.writeRegister(GS_REG_UV, 0ull);
            gs.writeRegister(GS_REG_XYZ2, 0ull);
            gs.writeRegister(GS_REG_UV, 0ull);
            gs.writeRegister(GS_REG_XYZ2, (16ull << 0) | (16ull << 16));

            const uint32_t pixel = readReferencePSMCT32Pixel(vram, 0u, 1u, 0u, 0u);
            t.Equals(pixel, kExpectedPixel,
                     "HIGHLIGHT2 should add the shaded vertex alpha into RGB while preserving the texture alpha");
        });

        tc.Run("GS TEX1 linear filter blends T4 STQ triangle samples", [](TestCase &t)
        {
            auto renderSamplePixel = [](uint64_t tex1Reg) -> uint32_t
            {
                std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
                GS gs;
                gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

                constexpr uint32_t kTexTbp = 64u;
                constexpr uint32_t kClutCbp = 128u;
                constexpr uint64_t kFrame =
                    (0ull << 0) |
                    (1ull << 16) |
                    (static_cast<uint64_t>(GS_PSM_CT32) << 24);
                constexpr uint64_t kZbuf = (1ull << 32);
                constexpr uint64_t kScissor =
                    (0ull << 0) |
                    (4ull << 16) |
                    (0ull << 32) |
                    (4ull << 48);
                constexpr uint64_t kTex0 =
                    (static_cast<uint64_t>(kTexTbp) << 0) |
                    (1ull << 14) |
                    (static_cast<uint64_t>(GS_PSM_T4) << 20) |
                    (1ull << 26) |
                    (0ull << 30) |
                    (1ull << 34) |
                    (1ull << 35) |
                    (static_cast<uint64_t>(kClutCbp) << 37) |
                    (static_cast<uint64_t>(GS_PSM_CT32) << 51);
                constexpr uint64_t kPrim =
                    static_cast<uint64_t>(GS_PRIM_TRIANGLE) |
                    (1ull << 4) |
                    (0ull << 8);
                constexpr uint64_t kRgbaq = 0x3F80000080808080ull;
                constexpr uint32_t kBlack = 0x80000000u;
                constexpr uint32_t kWhite = 0x80FFFFFFu;

                writePSMT4Texel(vram, kTexTbp, 1u, 0u, 0u, 0u);
                writePSMT4Texel(vram, kTexTbp, 1u, 1u, 0u, 1u);
                std::memcpy(vram.data() + kClutCbp * 256u + 0u * 4u, &kBlack, sizeof(kBlack));
                std::memcpy(vram.data() + kClutCbp * 256u + 1u * 4u, &kWhite, sizeof(kWhite));

                auto packFloat = [](float value) -> uint32_t
                {
                    uint32_t bits = 0u;
                    std::memcpy(&bits, &value, sizeof(bits));
                    return bits;
                };

                auto packSt = [&](float s, float tVal) -> uint64_t
                {
                    return static_cast<uint64_t>(packFloat(s)) |
                           (static_cast<uint64_t>(packFloat(tVal)) << 32);
                };

                gs.writeRegister(GS_REG_FRAME_1, kFrame);
                gs.writeRegister(GS_REG_ZBUF_1, kZbuf);
                gs.writeRegister(GS_REG_SCISSOR_1, kScissor);
                gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
                gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
                gs.writeRegister(GS_REG_ALPHA_1, 0ull);
                gs.writeRegister(GS_REG_TEX0_1, kTex0);
                gs.writeRegister(GS_REG_TEX1_1, tex1Reg);
                gs.writeRegister(GS_REG_PRIM, kPrim);
                gs.writeRegister(GS_REG_RGBAQ, kRgbaq);
                gs.writeRegister(GS_REG_ST, packSt(0.0f, 0.0f));
                gs.writeRegister(GS_REG_XYZ2, 0ull);
                gs.writeRegister(GS_REG_ST, packSt(1.0f, 0.0f));
                gs.writeRegister(GS_REG_XYZ2, (64ull << 0) | (0ull << 16));
                gs.writeRegister(GS_REG_ST, packSt(0.0f, 0.0f));
                gs.writeRegister(GS_REG_XYZ2, (0ull << 0) | (64ull << 16));

                return readReferencePSMCT32Pixel(vram, 0u, 1u, 1u, 1u);
            };

            constexpr uint64_t kTex1Linear =
                (1ull << 5) |
                (1ull << 6);

            const uint32_t nearestPixel = renderSamplePixel(0ull);
            const uint32_t linearPixel = renderSamplePixel(kTex1Linear);

            t.Equals(nearestPixel, 0x80000000u,
                     "point sampling should keep the sampled STQ triangle pixel on texel 0");

            const uint8_t linearR = static_cast<uint8_t>(linearPixel & 0xFFu);
            const uint8_t linearA = static_cast<uint8_t>((linearPixel >> 24) & 0xFFu);
            t.IsTrue(linearR > 0x10u && linearR < 0x70u,
                     "linear filtering should blend the STQ triangle sample between black and white T4 texels");
            t.Equals(linearA, static_cast<uint8_t>(0x80u),
                     "linear filtering should preserve the shared opaque alpha from the CLUT entries");
        });

        tc.Run("GS CLAMP modes transform texture coordinates before sampling", [](TestCase &t)
        {
            auto renderConstantUv = [](uint64_t clampReg,
                                       uint16_t fixedU,
                                       uint16_t fixedV) -> uint32_t
            {
                std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
                GS gs;
                gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

                constexpr uint32_t kTexTbp = 64u;
                constexpr uint32_t kTexel0 = 0x800000FFu;
                constexpr uint32_t kTexel1 = 0x8000FF00u;
                constexpr uint32_t kTexel2 = 0x80FF0000u;
                constexpr uint32_t kTexel3 = 0x80FFFFFFu;
                constexpr uint32_t kTexelV3 = 0x80FFFF00u;
                constexpr uint64_t kFrame =
                    (1ull << 16) |
                    (static_cast<uint64_t>(GS_PSM_CT32) << 24);
                constexpr uint64_t kZbuf = (1ull << 32);
                constexpr uint64_t kTex0 =
                    (static_cast<uint64_t>(kTexTbp) << 0) |
                    (1ull << 14) |
                    (static_cast<uint64_t>(GS_PSM_CT32) << 20) |
                    (2ull << 26) |
                    (2ull << 30) |
                    (1ull << 34) |
                    (1ull << 35);
                constexpr uint64_t kPrim =
                    static_cast<uint64_t>(GS_PRIM_TRIANGLE) |
                    (1ull << 4) |
                    (1ull << 8);
                constexpr uint64_t kRgbaq = 0x3F80000080808080ull;

                writeReferencePSMCT32Pixel(vram, kTexTbp, 1u, 0u, 0u, kTexel0);
                writeReferencePSMCT32Pixel(vram, kTexTbp, 1u, 1u, 0u, kTexel1);
                writeReferencePSMCT32Pixel(vram, kTexTbp, 1u, 2u, 0u, kTexel2);
                writeReferencePSMCT32Pixel(vram, kTexTbp, 1u, 3u, 0u, kTexel3);
                writeReferencePSMCT32Pixel(vram, kTexTbp, 1u, 0u, 3u, kTexelV3);

                gs.writeRegister(GS_REG_FRAME_1, kFrame);
                gs.writeRegister(GS_REG_ZBUF_1, kZbuf);
                gs.writeRegister(GS_REG_SCISSOR_1, (3ull << 16) | (3ull << 48));
                gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
                gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
                gs.writeRegister(GS_REG_TEX0_1, kTex0);
                gs.writeRegister(GS_REG_CLAMP_1, clampReg);
                gs.writeRegister(GS_REG_PRIM, kPrim);
                gs.writeRegister(GS_REG_RGBAQ, kRgbaq);

                const uint64_t uv =
                    static_cast<uint64_t>(fixedU) |
                    (static_cast<uint64_t>(fixedV) << 16);
                gs.writeRegister(GS_REG_UV, uv);
                gs.writeRegister(GS_REG_XYZ2, 0ull);
                gs.writeRegister(GS_REG_UV, uv);
                gs.writeRegister(GS_REG_XYZ2, 32ull);
                gs.writeRegister(GS_REG_UV, uv);
                gs.writeRegister(GS_REG_XYZ2, (32ull << 16));

                return readReferencePSMCT32Pixel(vram, 0u, 1u, 0u, 0u);
            };

            constexpr uint64_t kClamp = 1ull;
            constexpr uint64_t kRegionClamp =
                2ull |
                (1ull << 4) |
                (2ull << 14);
            constexpr uint64_t kRegionRepeat =
                3ull |
                (1ull << 4) |
                (2ull << 14);

            t.Equals(renderConstantUv(0ull, 4u * 16u, 0u), 0x800000FFu,
                     "REPEAT should wrap texel 4 to texel 0 for a four-wide texture");
            t.Equals(renderConstantUv(0ull, 0u, 4u * 16u), 0x800000FFu,
                     "REPEAT should wrap texel row 4 to row 0 for a four-high texture");
            t.Equals(renderConstantUv(kClamp, 4u * 16u, 0u), 0x80FFFFFFu,
                     "CLAMP should hold texel 4 at the last texel");
            t.Equals(renderConstantUv(kRegionClamp, 3u * 16u, 0u), 0x80FF0000u,
                     "REGION_CLAMP should hold texel 3 at MAXU=2");
            t.Equals(renderConstantUv(kRegionRepeat, 4u * 16u, 0u), 0x80FF0000u,
                     "REGION_REPEAT should calculate (U & UMSK) | UFIX");
        });

        tc.Run("GS early depth preserves GEQUAL and GREATER stores across Z formats", [](TestCase &t)
        {
            for (uint8_t format : {GS_PSM_Z32, GS_PSM_Z24, GS_PSM_Z16, GS_PSM_Z16S})
            for (uint32_t method = 0u; method < 4u; ++method)
            for (bool masked : {false, true})
            {
                std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
                GSCpuBackend backend;
                backend.Initialize(vram.data(), static_cast<uint32_t>(vram.size()));
                GSPrimitiveBatch batch{};
                batch.vertexCount = 3u;
                batch.state.prim.type = GS_PRIM_TRIANGLE;
                batch.state.context.frame = {0u, 1u, GS_PSM_CT32, 0u};
                batch.state.context.zbuf = {1u, format, masked};
                batch.state.context.scissor = {0u, 7u, 0u, 7u};
                batch.state.context.test = (1ull << 16u) | (static_cast<uint64_t>(method) << 17u);
                batch.vertices[0].x = 0.0f;
                batch.vertices[0].y = 0.0f;
                batch.vertices[1].x = 8.0f;
                batch.vertices[1].y = 0.0f;
                batch.vertices[2].x = 0.0f;
                batch.vertices[2].y = 8.0f;
                for (auto &vertex : batch.vertices)
                {
                    vertex.z = 256.0;
                    vertex.r = 0x12u;
                    vertex.g = 0x34u;
                    vertex.b = 0x56u;
                    vertex.a = 0x80u;
                }
                for (uint32_t x = 1u; x <= 3u; ++x)
                {
                    backend.WriteVram(GS_PSM_CT32, 0u, 1u, x, 1u, 0xAABBCCDDu);
                    backend.WriteVram(format, 32u, 1u, x, 1u, 254u + x);
                }
                backend.Submit(batch);
                for (uint32_t x = 1u; x <= 3u; ++x)
                {
                    const uint32_t stored = 254u + x;
                    const bool passes = method == 1u || (method == 2u && 256u >= stored) ||
                        (method == 3u && 256u > stored);
                    t.Equals(backend.ReadVram(GS_PSM_CT32, 0u, 1u, x, 1u),
                             passes ? 0x80563412u : 0xAABBCCDDu,
                             "depth comparison must preserve the expected color store");
                    t.Equals(backend.ReadVram(format, 32u, 1u, x, 1u),
                             passes && !masked ? 256u : stored,
                             "depth rejection or ZMSK must preserve stored depth");
                }
            }
        });

        tc.Run("GS early depth differential workload covers texture alpha fog and masks", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GSCpuBackend backend;
            backend.Initialize(vram.data(), static_cast<uint32_t>(vram.size()));
            constexpr std::array<uint8_t, 4> frameFormats{
                GS_PSM_CT32, GS_PSM_CT24, GS_PSM_CT16, GS_PSM_CT16S};
            constexpr std::array<uint8_t, 4> depthFormats{
                GS_PSM_Z32, GS_PSM_Z24, GS_PSM_Z16, GS_PSM_Z16S};
            uint32_t random = 0xB16821F3u;
            auto next = [&]() { random = random * 1664525u + 1013904223u; return random; };
            uint64_t hash = 14695981039346656037ull;
            uint32_t changedCases = 0u;
            for (uint32_t index = 0u; index < 128u; ++index)
            {
                std::fill(vram.begin(), vram.end(), 0x3Du);
                GSPrimitiveBatch batch{};
                batch.vertexCount = 3u;
                auto &state = batch.state;
                auto &ctx = state.context;
                state.prim.type = GS_PRIM_TRIANGLE;
                state.prim.tme = true;
                state.prim.iip = (index & 1u) != 0u;
                state.prim.fst = (index & 2u) != 0u;
                state.prim.abe = (index & 4u) != 0u;
                state.prim.fge = (index & 8u) != 0u;
                state.pabe = (index & 16u) != 0u;
                state.colclamp = 1u;
                state.fogR = 0x34u;
                state.fogG = 0x56u;
                state.fogB = 0x78u;
                state.textureWidth = state.textureHeight = 16u;
                state.linearFilter = (index & 32u) != 0u;
                ctx.frame = {0u, 1u, frameFormats[index & 3u], (index & 16u) ? 0x005A005Au : 0u};
                ctx.zbuf = {32u, depthFormats[(index >> 2u) & 3u], (index & 8u) != 0u};
                ctx.scissor = {2u, 29u, 1u, 30u};
                ctx.tex0.tbp0 = 2048u;
                ctx.tex0.tbw = 1u;
                ctx.tex0.psm = GS_PSM_T8;
                ctx.tex0.tw = ctx.tex0.th = 4u;
                ctx.tex0.tcc = 1u;
                ctx.tex0.tfx = static_cast<uint8_t>(index & 3u);
                ctx.tex0.cbp = 4096u;
                ctx.tex0.cpsm = GS_PSM_CT32;
                ctx.tex0.cld = 1u;
                ctx.clamp = static_cast<uint64_t>(index & 15u) | (15ull << 14u) | (15ull << 34u);
                ctx.test = 1ull | ((index & 7ull) << 1u) | (0x70ull << 4u) |
                    (((index >> 3u) & 3ull) << 12u) | (1ull << 16u) |
                    (((index >> 5u) & 3ull) << 17u);
                if ((index & 16u) != 0u)
                    ctx.test |= (1ull << 14u) | ((index & 1ull) << 15u);
                ctx.alpha = 0x44ull | (0x60ull << 32u);
                ctx.fba = index & 1u;
                for (uint32_t y = 0u; y < 32u; ++y)
                for (uint32_t x = 0u; x < 32u; ++x)
                {
                    backend.WriteVram(ctx.frame.psm, 0u, 1u, x, y, next());
                    backend.WriteVram(ctx.zbuf.psm, 1024u, 1u, x, y, 32766u + (next() % 5u));
                }
                for (uint32_t y = 0u; y < 16u; ++y)
                for (uint32_t x = 0u; x < 16u; ++x)
                {
                    backend.WriteVram(GS_PSM_T8, 2048u, 1u, x, y, next() & 255u);
                    backend.WriteVram(GS_PSM_CT32, 4096u, 1u, x, y, next());
                }
                const float xs[] = {-2.0f, 34.0f, 5.0f};
                const float ys[] = {2.0f, 7.0f, 35.0f};
                for (uint32_t vertexIndex = 0u; vertexIndex < 3u; ++vertexIndex)
                {
                    auto &vertex = batch.vertices[vertexIndex];
                    vertex.x = xs[vertexIndex];
                    vertex.y = ys[vertexIndex];
                    vertex.z = 32768.0 + (static_cast<int>(vertexIndex) - 1) * 2.0;
                    vertex.q = 0.5f + static_cast<float>(vertexIndex);
                    vertex.s = static_cast<float>(vertexIndex);
                    vertex.t = 2.0f - vertex.s;
                    vertex.u = static_cast<uint16_t>(vertexIndex * 8u * 16u);
                    vertex.v = static_cast<uint16_t>((2u - vertexIndex) * 8u * 16u);
                    vertex.r = static_cast<uint8_t>(next() >> 24u);
                    vertex.g = static_cast<uint8_t>(next() >> 24u);
                    vertex.b = static_cast<uint8_t>(next() >> 24u);
                    vertex.a = static_cast<uint8_t>(next() >> 24u);
                    vertex.fog = static_cast<uint8_t>(next() >> 24u);
                }
                const auto before = vram;
                backend.Submit(batch);
                if (before != vram)
                    ++changedCases;
                for (uint8_t byte : vram)
                    hash = (hash ^ byte) * 1099511628211ull;
            }
            std::printf("[gs-depth-differential] cases=128 hash=%016llx\n",
                        static_cast<unsigned long long>(hash));
            t.IsTrue(changedCases > 0u && changedCases < 128u,
                     "the workload must exercise both stores and rejected draws");
        });

        tc.Run("GS STQ triangle interpolation divides homogeneous coordinates after DDA", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint32_t kTexTbp = 64u;
            constexpr uint64_t kFrame =
                (1ull << 16) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kZbuf = (1ull << 32);
            constexpr uint64_t kTex0 =
                (static_cast<uint64_t>(kTexTbp) << 0) |
                (1ull << 14) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 20) |
                (2ull << 26) |
                (1ull << 34) |
                (1ull << 35);
            constexpr uint64_t kPrim =
                static_cast<uint64_t>(GS_PRIM_TRIANGLE) |
                (1ull << 4);
            constexpr uint32_t kAffineTexel = 0x800000FFu;
            constexpr uint32_t kHomogeneousTexel = 0x8000FF00u;

            auto packFloat = [](float value) -> uint32_t
            {
                uint32_t bits = 0u;
                std::memcpy(&bits, &value, sizeof(bits));
                return bits;
            };
            auto packSt = [&](float s, float tVal) -> uint64_t
            {
                return static_cast<uint64_t>(packFloat(s)) |
                       (static_cast<uint64_t>(packFloat(tVal)) << 32);
            };
            auto packRgbaq = [&](float q) -> uint64_t
            {
                return 0x80808080ull |
                       (static_cast<uint64_t>(packFloat(q)) << 32);
            };

            writeReferencePSMCT32Pixel(vram, kTexTbp, 1u, 1u, 0u, kAffineTexel);
            writeReferencePSMCT32Pixel(vram, kTexTbp, 1u, 2u, 0u, kHomogeneousTexel);

            gs.writeRegister(GS_REG_FRAME_1, kFrame);
            gs.writeRegister(GS_REG_ZBUF_1, kZbuf);
            gs.writeRegister(GS_REG_SCISSOR_1, (4ull << 16) | (4ull << 48));
            gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
            gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
            gs.writeRegister(GS_REG_TEX0_1, kTex0);
            gs.writeRegister(GS_REG_CLAMP_1, 1ull);
            gs.writeRegister(GS_REG_PRIM, kPrim);

            gs.writeRegister(GS_REG_ST, packSt(0.0f, 0.0f));
            gs.writeRegister(GS_REG_RGBAQ, packRgbaq(1.0f));
            gs.writeRegister(GS_REG_XYZ2, 0ull);
            gs.writeRegister(GS_REG_ST, packSt(2.0f, 0.0f));
            gs.writeRegister(GS_REG_RGBAQ, packRgbaq(2.0f));
            gs.writeRegister(GS_REG_XYZ2, 64ull);
            gs.writeRegister(GS_REG_ST, packSt(0.0f, 0.0f));
            gs.writeRegister(GS_REG_RGBAQ, packRgbaq(1.0f));
            gs.writeRegister(GS_REG_XYZ2, (64ull << 16));

            const uint32_t pixel =
                readReferencePSMCT32Pixel(vram, 0u, 1u, 1u, 1u);
            t.Equals(pixel, kHomogeneousTexel,
                     "the DDA should interpolate S=0.75 and Q=1.375, selecting texel 2 after S/Q");
        });

        tc.Run("GS alpha-test AFAIL independently masks framebuffer and depth", [](TestCase &t)
        {
            constexpr uint32_t kInitialFramebuffer = 0xAB030201u;
            constexpr uint32_t kInitialDepth = 0x11111111u;
            constexpr uint64_t kTestBase =
                1ull |                  // ATE
                (5ull << 1) |           // ATST = GEQUAL
                (0x80ull << 4) |       // AREF
                (1ull << 16) |         // ZTE
                (1ull << 17);          // ZTST = ALWAYS

            const GsPixelTestResult keep =
                drawGsPixelForTests(GS_PSM_CT32, kTestBase | (0ull << 12), false,
                                    kInitialFramebuffer, kInitialDepth, 0x00u);
            t.Equals(keep.framebuffer, kInitialFramebuffer,
                     "AFAIL=KEEP should preserve the framebuffer");
            t.Equals(keep.depth, kInitialDepth,
                     "AFAIL=KEEP should preserve depth");

            const GsPixelTestResult framebufferOnly =
                drawGsPixelForTests(GS_PSM_CT32, kTestBase | (1ull << 12), false,
                                    kInitialFramebuffer, kInitialDepth, 0x00u);
            t.Equals(framebufferOnly.framebuffer, 0x00563412u,
                     "AFAIL=FB_ONLY should update RGBA");
            t.Equals(framebufferOnly.depth, kInitialDepth,
                     "AFAIL=FB_ONLY should preserve depth");

            const GsPixelTestResult depthOnly =
                drawGsPixelForTests(GS_PSM_CT32, kTestBase | (2ull << 12), false,
                                    kInitialFramebuffer, kInitialDepth, 0x00u);
            t.Equals(depthOnly.framebuffer, kInitialFramebuffer,
                     "AFAIL=ZB_ONLY should preserve the framebuffer");
            t.Equals(depthOnly.depth, 0x22222222u,
                     "AFAIL=ZB_ONLY should update depth");

            const GsPixelTestResult rgbOnly =
                drawGsPixelForTests(GS_PSM_CT32, kTestBase | (3ull << 12), false,
                                    kInitialFramebuffer, kInitialDepth, 0x00u);
            t.Equals(rgbOnly.framebuffer, 0xAB563412u,
                     "AFAIL=RGB_ONLY should preserve destination alpha on CT32");
            t.Equals(rgbOnly.depth, kInitialDepth,
                     "AFAIL=RGB_ONLY should preserve depth");
        });

        tc.Run("GS RGB_ONLY falls back to FB_ONLY outside CT32", [](TestCase &t)
        {
            constexpr uint32_t kInitialDepth = 0x11111111u;
            constexpr uint64_t kTest =
                1ull |
                (5ull << 1) |
                (0x80ull << 4) |
                (3ull << 12) |
                (1ull << 16) |
                (1ull << 17);

            const GsPixelTestResult ct24 =
                drawGsPixelForTests(GS_PSM_CT24, kTest, false,
                                    0x00030201u, kInitialDepth, 0x00u);
            t.Equals(ct24.framebuffer, 0x00563412u,
                     "RGB_ONLY should write the full CT24 framebuffer pixel");
            t.Equals(ct24.depth, kInitialDepth,
                     "RGB_ONLY-as-FB_ONLY should preserve CT24 depth");

            const GsPixelTestResult ct16 =
                drawGsPixelForTests(GS_PSM_CT16, kTest, false,
                                    0x8001u, kInitialDepth, 0x00u);
            t.Equals(ct16.framebuffer, 0x28C2u,
                     "RGB_ONLY should write RGB and alpha for CT16");
            t.Equals(ct16.depth, kInitialDepth,
                     "RGB_ONLY-as-FB_ONLY should preserve CT16 depth");
        });

        tc.Run("GS ZMSK suppresses depth without suppressing framebuffer writes", [](TestCase &t)
        {
            constexpr uint64_t kTest =
                1ull |
                (5ull << 1) |
                (0x80ull << 4) |
                (1ull << 16) |
                (1ull << 17);
            const GsPixelTestResult result =
                drawGsPixelForTests(GS_PSM_CT32, kTest, true,
                                    0xAB030201u, 0x11111111u, 0x80u);

            t.Equals(result.framebuffer, 0x80563412u,
                     "a passing alpha test should write the framebuffer");
            t.Equals(result.depth, 0x11111111u,
                     "ZMSK should preserve depth");
        });

        tc.Run("GS DATE and DATM inspect the framebuffer-format alpha bit", [](TestCase &t)
        {
            constexpr uint32_t kInitialDepth = 0x11111111u;
            constexpr uint64_t kTestBase =
                (1ull << 14) |          // DATE
                (1ull << 16) |          // ZTE
                (1ull << 17);           // ZTST = ALWAYS

            const GsPixelTestResult ct32ZeroPass =
                drawGsPixelForTests(GS_PSM_CT32, kTestBase, false,
                                    0x00030201u, kInitialDepth, 0x80u);
            t.Equals(ct32ZeroPass.framebuffer, 0x80563412u,
                     "DATM=0 should accept a clear CT32 alpha bit");
            t.Equals(ct32ZeroPass.depth, 0x22222222u,
                     "a passing CT32 DATE should allow depth");

            const GsPixelTestResult ct32OneFail =
                drawGsPixelForTests(GS_PSM_CT32, kTestBase, false,
                                    0x80030201u, kInitialDepth, 0x80u);
            t.Equals(ct32OneFail.framebuffer, 0x80030201u,
                     "DATM=0 should reject a set CT32 alpha bit");
            t.Equals(ct32OneFail.depth, kInitialDepth,
                     "a failing CT32 DATE should reject depth");

            const GsPixelTestResult ct32OnePass =
                drawGsPixelForTests(GS_PSM_CT32, kTestBase | (1ull << 15), false,
                                    0x80030201u, kInitialDepth, 0x80u);
            t.Equals(ct32OnePass.framebuffer, 0x80563412u,
                     "DATM=1 should accept a set CT32 alpha bit");

            const GsPixelTestResult ct16ZeroPass =
                drawGsPixelForTests(GS_PSM_CT16, kTestBase, false,
                                    0x0001u, kInitialDepth, 0x80u);
            t.Equals(ct16ZeroPass.framebuffer, 0xA8C2u,
                     "DATM=0 should accept a clear CT16 alpha bit");

            const GsPixelTestResult ct16OneFail =
                drawGsPixelForTests(GS_PSM_CT16, kTestBase, false,
                                    0x8001u, kInitialDepth, 0x80u);
            t.Equals(ct16OneFail.framebuffer, 0x8001u,
                     "DATM=0 should reject a set CT16 alpha bit");
            t.Equals(ct16OneFail.depth, kInitialDepth,
                     "a failing CT16 DATE should reject depth");

            const GsPixelTestResult ct16OnePass =
                drawGsPixelForTests(GS_PSM_CT16, kTestBase | (1ull << 15), false,
                                    0x8001u, kInitialDepth, 0x80u);
            t.Equals(ct16OnePass.framebuffer, 0xA8C2u,
                     "DATM=1 should accept a set CT16 alpha bit");

            const GsPixelTestResult ct24DatmZero =
                drawGsPixelForTests(GS_PSM_CT24, kTestBase, false,
                                    0x00030201u, kInitialDepth, 0x80u);
            const GsPixelTestResult ct24DatmOne =
                drawGsPixelForTests(GS_PSM_CT24, kTestBase | (1ull << 15), false,
                                    0x00030201u, kInitialDepth, 0x80u);
            t.Equals(ct24DatmZero.framebuffer, 0x00563412u,
                     "CT24 DATE should pass for DATM=0");
            t.Equals(ct24DatmOne.framebuffer, 0x00563412u,
                     "CT24 DATE should pass for DATM=1");
            t.Equals(ct24DatmOne.depth, 0x22222222u,
                     "CT24 DATE should not block depth");
        });

        tc.Run("GS triangle fan subpixel quad fills rows without interior holes", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint64_t kFrame =
                (0ull << 0) |
                (1ull << 16) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kZbuf = (1ull << 32);
            constexpr uint64_t kScissor =
                (0ull << 0) |
                (31ull << 16) |
                (0ull << 32) |
                (31ull << 48);
            constexpr uint64_t kPrim =
                static_cast<uint64_t>(GS_PRIM_TRIFAN);
            constexpr uint64_t kRgbaq =
                0xFFull |
                (0xFFull << 8) |
                (0xFFull << 16) |
                (0x80ull << 24) |
                (0x3F800000ull << 32); // q = 1.0f
            auto makeXyzf = [](uint16_t x, uint16_t y) -> uint64_t
            {
                return static_cast<uint64_t>(x) |
                       (static_cast<uint64_t>(y) << 16);
            };

            gs.writeRegister(GS_REG_FRAME_1, kFrame);
            gs.writeRegister(GS_REG_ZBUF_1, kZbuf);
            gs.writeRegister(GS_REG_SCISSOR_1, kScissor);
            gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
            gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
            gs.writeRegister(GS_REG_PRIM, kPrim);
            gs.writeRegister(GS_REG_RGBAQ, kRgbaq);
            gs.writeRegister(GS_REG_XYZF2, makeXyzf(102u, 102u));
            gs.writeRegister(GS_REG_XYZF2, makeXyzf(420u, 102u));
            gs.writeRegister(GS_REG_XYZF2, makeXyzf(420u, 420u));
            gs.writeRegister(GS_REG_XYZF2, makeXyzf(102u, 420u));

            bool sawFilledRow = false;
            for (uint32_t y = 6u; y <= 26u; ++y)
            {
                int first = -1;
                int last = -1;
                for (uint32_t x = 6u; x <= 26u; ++x)
                {
                    const size_t offset = (static_cast<size_t>(y) * 64u + static_cast<size_t>(x)) * 4u;
                    uint32_t pixel = 0u;
                    std::memcpy(&pixel, vram.data() + offset, sizeof(pixel));
                    if ((pixel & 0x00FFFFFFu) != 0u)
                    {
                        if (first < 0)
                        {
                            first = static_cast<int>(x);
                        }
                        last = static_cast<int>(x);
                    }
                }

                if (first < 0 || last < 0)
                {
                    continue;
                }

                sawFilledRow = true;
                for (int x = first; x <= last; ++x)
                {
                    const size_t offset = (static_cast<size_t>(y) * 64u + static_cast<size_t>(x)) * 4u;
                    uint32_t pixel = 0u;
                    std::memcpy(&pixel, vram.data() + offset, sizeof(pixel));
                    if ((pixel & 0x00FFFFFFu) == 0u)
                    {
                        t.Fail("triangle fan quad should not leave interior holes within a covered row");
                        break;
                    }
                }
            }

            t.IsTrue(sawFilledRow,
                     "triangle fan quad should light at least one framebuffer row");
        });

        // libgraph's sceGsSetDefLoadImage / sceGsSetDefStoreImage fill a GIF packet the game may inspect or patch
        // directly: SOCOM II's auto-exposure thread (FUN_003b28d0 / FUN_003b1dd0) reads the store packet's PSM at
        // byte 0x23 and its TRXREG at 0x40/0x44, patches TRXPOS at 0x30 and DMAs the 7 quadwords itself. The HLE
        // used to write a private 12-byte struct there instead, so the guest read zero sizes and never issued its
        // readback (research/31 section 13).
        tc.Run("sceGsSetDefStoreImage writes libgraph's 7-quadword store-image packet", [](TestCase &t)
        {
            PS2Runtime runtime;
            t.IsTrue(runtime.memory().initialize(), "runtime memory initialize should succeed");
            uint8_t *const rdram = runtime.memory().getRDRAM();
            constexpr uint32_t kAddr = 0x4000u;
            R5900Context ctx{};
            setRegU32(ctx, 4, kAddr);
            setRegU32(ctx, 5, 0x1180u);   // vram address (blocks): the frame buffer
            setRegU32(ctx, 6, 10u);       // vram width (64-px units)
            setRegU32(ctx, 7, 0u);        // PSMCT32
            setRegU32(ctx, 8, 317u);      // x
            setRegU32(ctx, 9, 430u);      // y
            setRegU32(ctx, 10, 1u);       // width
            setRegU32(ctx, 11, 4u);       // height
            ps2_stubs::sceGsSetDefStoreImage(rdram, &ctx, &runtime);
            auto q = [&](int i, uint64_t &lo, uint64_t &hi)
            {
                std::memcpy(&lo, rdram + kAddr + i * 16, 8);
                std::memcpy(&hi, rdram + kAddr + i * 16 + 8, 8);
            };
            uint64_t lo = 0, hi = 0;
            q(1, lo, hi);
            t.Equals(lo, 5ull | (1ull << 15) | (1ull << 60), "quadword 1: GIF tag NLOOP=5 EOP PACKED NREG=1");
            t.Equals(hi, 0xEull, "quadword 1: the one register is A+D");
            q(2, lo, hi);
            t.Equals(lo, 0x1180ull | (10ull << 16), "quadword 2: BITBLTBUF source = the frame buffer");
            t.Equals(hi & 0xFFu, 0x50ull, "quadword 2: register BITBLTBUF");
            t.Equals(static_cast<uint32_t>(rdram[kAddr + 0x23] & 0x3Fu), 0u, "byte 0x23 is the source PSM the guest reads");
            q(3, lo, hi);
            t.Equals(lo, 317ull | (430ull << 16), "quadword 3: TRXPOS source origin");
            t.Equals(hi & 0xFFu, 0x51ull, "quadword 3: register TRXPOS (the guest patches offset 0x30)");
            q(4, lo, hi);
            t.Equals(lo, 1ull | (4ull << 32), "quadword 4: TRXREG 1x4");
            t.Equals(hi & 0xFFu, 0x52ull, "quadword 4: register TRXREG (the guest reads 0x40/0x44)");
            q(5, lo, hi);
            t.Equals(hi & 0xFFu, 0x61ull, "quadword 5: FINISH, so the guest can wait for the transfer");
            q(6, lo, hi);
            t.Equals(lo, 1ull, "quadword 6: TRXDIR local -> host");
            t.Equals(hi & 0xFFu, 0x53ull, "quadword 6: register TRXDIR");
            GsImageMem img{};
            t.IsTrue(readGsImage(rdram, kAddr, img), "readGsImage parses the packet back");
            t.Equals(static_cast<uint32_t>(img.vram_addr), 0x1180u, "parsed vram address");
            t.Equals(static_cast<uint32_t>(img.vram_width), 10u, "parsed vram width");
            t.Equals(static_cast<uint32_t>(img.psm), 0u, "parsed psm");
            t.Equals(static_cast<uint32_t>(img.x), 317u, "parsed x");
            t.Equals(static_cast<uint32_t>(img.y), 430u, "parsed y");
            t.Equals(static_cast<uint32_t>(img.width), 1u, "parsed width");
            t.Equals(static_cast<uint32_t>(img.height), 4u, "parsed height");
        });

        tc.Run("sceGsSetDefLoadImage writes libgraph's 6-quadword load-image packet", [](TestCase &t)
        {
            PS2Runtime runtime;
            t.IsTrue(runtime.memory().initialize(), "runtime memory initialize should succeed");
            uint8_t *const rdram = runtime.memory().getRDRAM();
            constexpr uint32_t kAddr = 0x4000u;
            R5900Context ctx{};
            setRegU32(ctx, 4, kAddr);
            setRegU32(ctx, 5, 0x2000u);   // vram address (blocks)
            setRegU32(ctx, 6, 4u);        // vram width
            setRegU32(ctx, 7, 0x13u);     // PSMT8
            setRegU32(ctx, 8, 0u);
            setRegU32(ctx, 9, 0u);
            setRegU32(ctx, 10, 64u);
            setRegU32(ctx, 11, 64u);
            ps2_stubs::sceGsSetDefLoadImage(rdram, &ctx, &runtime);
            auto q = [&](int i, uint64_t &lo, uint64_t &hi)
            {
                std::memcpy(&lo, rdram + kAddr + i * 16, 8);
                std::memcpy(&hi, rdram + kAddr + i * 16 + 8, 8);
            };
            uint64_t lo = 0, hi = 0;
            q(0, lo, hi);
            t.Equals(lo, 4ull | (1ull << 15) | (1ull << 60), "quadword 0: GIF tag NLOOP=4 EOP PACKED NREG=1");
            t.Equals(hi, 0xEull, "quadword 0: A+D");
            q(1, lo, hi);
            t.Equals(lo, (0x2000ull << 32) | (4ull << 48) | (0x13ull << 56), "quadword 1: BITBLTBUF destination");
            t.Equals(hi & 0xFFu, 0x50ull, "quadword 1: register BITBLTBUF");
            q(2, lo, hi);
            t.Equals(lo, 0ull, "quadword 2: TRXPOS destination origin 0,0");
            t.Equals(hi & 0xFFu, 0x51ull, "quadword 2: register TRXPOS");
            q(3, lo, hi);
            t.Equals(lo, 64ull | (64ull << 32), "quadword 3: TRXREG 64x64");
            q(4, lo, hi);
            t.Equals(lo, 0ull, "quadword 4: TRXDIR host -> local");
            t.Equals(hi & 0xFFu, 0x53ull, "quadword 4: register TRXDIR");
            q(5, lo, hi);
            t.Equals(lo, 256ull | (1ull << 15) | (2ull << 58), "quadword 5: IMAGE tag, 64x64 T8 = 256 quadwords");
            GsImageMem img{};
            t.IsTrue(readGsImage(rdram, kAddr, img), "readGsImage parses the load packet back");
            t.Equals(static_cast<uint32_t>(img.vram_addr), 0x2000u, "parsed vram address");
            t.Equals(static_cast<uint32_t>(img.psm), 0x13u, "parsed psm");
            t.Equals(static_cast<uint32_t>(img.width), 64u, "parsed width");
        });

        tc.Run("sceGsExecLoadImage and sceGsExecStoreImage roundtrip and free guest packets", [](TestCase &t)
        {
            PS2Runtime runtime;
            t.IsTrue(runtime.memory().initialize(), "runtime memory initialize should succeed");
            uint8_t *const rdram = runtime.memory().getRDRAM();
            constexpr uint32_t kImageAddr = 0x4000u;
            constexpr uint32_t kSrcAddr = 0x5000u;
            constexpr uint32_t kDstAddr = 0x6000u;

            const GsImageMem image{0u, 0u, 2u, 2u, 0u, 1u, 0u};
            const uint8_t pixels[16] = {
                0x10u, 0x20u, 0x30u, 0x40u,
                0x50u, 0x60u, 0x70u, 0x80u,
                0x90u, 0xA0u, 0xB0u, 0xC0u,
                0xD0u, 0xE0u, 0xF0u, 0xFFu,
            };

            (void)image;
            {
                R5900Context defCtx{};
                setRegU32(defCtx, 4, kImageAddr);
                setRegU32(defCtx, 5, 0u);    // vram address
                setRegU32(defCtx, 6, 1u);    // vram width
                setRegU32(defCtx, 7, 0u);    // PSMCT32
                setRegU32(defCtx, 8, 0u);
                setRegU32(defCtx, 9, 0u);
                setRegU32(defCtx, 10, 2u);
                setRegU32(defCtx, 11, 2u);
                ps2_stubs::sceGsSetDefLoadImage(rdram, &defCtx, &runtime);   // libgraph's packet layout
            }
            std::memcpy(rdram + kSrcAddr, pixels, sizeof(pixels));

            R5900Context loadCtx{};
            setRegU32(loadCtx, 4, kImageAddr);
            setRegU32(loadCtx, 5, kSrcAddr);
            ps2_stubs::sceGsExecLoadImage(rdram, &loadCtx, &runtime);
            t.Equals(static_cast<int32_t>(getRegU32Test(loadCtx, 2)), 0,
                     "sceGsExecLoadImage should succeed for a simple CT32 upload");
            uint64_t loadTag = 0u;
            std::memcpy(&loadTag, rdram + runtime.guestHeapBase(), sizeof(loadTag));
            t.Equals(loadTag, 0x1000000000008004ull,
                     "sceGsExecLoadImage should populate the packed A+D GIF tag in guest RAM");
            uint64_t loadReg1 = 0u;
            uint64_t loadReg2 = 0u;
            uint64_t loadReg3 = 0u;
            uint64_t loadReg4 = 0u;
            std::memcpy(&loadReg1, rdram + runtime.guestHeapBase() + 24u, sizeof(loadReg1));
            std::memcpy(&loadReg2, rdram + runtime.guestHeapBase() + 40u, sizeof(loadReg2));
            std::memcpy(&loadReg3, rdram + runtime.guestHeapBase() + 56u, sizeof(loadReg3));
            std::memcpy(&loadReg4, rdram + runtime.guestHeapBase() + 72u, sizeof(loadReg4));
            t.Equals(loadReg1, 0x50ull, "sceGsExecLoadImage should encode BITBLTBUF as A+D register 0x50");
            t.Equals(loadReg2, 0x51ull, "sceGsExecLoadImage should encode TRXPOS as A+D register 0x51");
            t.Equals(loadReg3, 0x52ull, "sceGsExecLoadImage should encode TRXREG as A+D register 0x52");
            t.Equals(loadReg4, 0x53ull, "sceGsExecLoadImage should encode TRXDIR as A+D register 0x53");
            expectGuestHeapReusable(t, runtime,
                                    "sceGsExecLoadImage should free its temporary GIF packet");

            R5900Context storeCtx{};
            setRegU32(storeCtx, 4, kImageAddr);
            setRegU32(storeCtx, 5, kDstAddr);
            ps2_stubs::sceGsExecStoreImage(rdram, &storeCtx, &runtime);
            t.Equals(static_cast<int32_t>(getRegU32Test(storeCtx, 2)), 0,
                     "sceGsExecStoreImage should succeed for a matching CT32 readback");
            uint64_t storeTag = 0u;
            std::memcpy(&storeTag, rdram + runtime.guestHeapBase(), sizeof(storeTag));
            t.Equals(storeTag, 0x1000000000008004ull,
                     "sceGsExecStoreImage should populate the packed A+D GIF tag in guest RAM");
            uint64_t storeReg1 = 0u;
            uint64_t storeReg2 = 0u;
            uint64_t storeReg3 = 0u;
            uint64_t storeReg4 = 0u;
            std::memcpy(&storeReg1, rdram + runtime.guestHeapBase() + 24u, sizeof(storeReg1));
            std::memcpy(&storeReg2, rdram + runtime.guestHeapBase() + 40u, sizeof(storeReg2));
            std::memcpy(&storeReg3, rdram + runtime.guestHeapBase() + 56u, sizeof(storeReg3));
            std::memcpy(&storeReg4, rdram + runtime.guestHeapBase() + 72u, sizeof(storeReg4));
            t.Equals(storeReg1, 0x50ull, "sceGsExecStoreImage should encode BITBLTBUF as A+D register 0x50");
            t.Equals(storeReg2, 0x51ull, "sceGsExecStoreImage should encode TRXPOS as A+D register 0x51");
            t.Equals(storeReg3, 0x52ull, "sceGsExecStoreImage should encode TRXREG as A+D register 0x52");
            t.Equals(storeReg4, 0x53ull, "sceGsExecStoreImage should encode TRXDIR as A+D register 0x53");
            expectGuestHeapReusable(t, runtime,
                                    "sceGsExecStoreImage should free its temporary GIF packet");

            bool roundtripOk = true;
            size_t mismatchIndex = 0u;
            for (size_t i = 0; i < sizeof(pixels); ++i)
            {
                if (rdram[kDstAddr + i] != pixels[i])
                {
                    roundtripOk = false;
                    mismatchIndex = i;
                    break;
                }
            }
            if (!roundtripOk)
            {
                t.Fail("sceGsExecLoadImage/sceGsExecStoreImage should roundtrip CT32 pixel data "
                       "(first mismatch at byte " + std::to_string(mismatchIndex) +
                       ", got " + std::to_string(rdram[kDstAddr + mismatchIndex]) +
                       ", expected " + std::to_string(pixels[mismatchIndex]) + ")");
            }
        });

        // research/25 §9-§10: the game parks the top 1.75 MB of VRAM in the motion-pack buffer during the
        // single-player mission load as seven 256x256 PSMCT32 pieces, vram_addr 0x2400 stepping 0x400
        // (libgraph units: 256-byte blocks, the BITBLTBUF DBP/SBP unit). A single region at vram_addr 0
        // round-trips losslessly whatever the unit, which is why the test above never caught the x8.
        tc.Run("seven 256x256 CT32 regions at vram_addr 0x2400..0x3C00 each round-trip their own bytes", [](TestCase &t)
        {
            PS2Runtime runtime;
            t.IsTrue(runtime.memory().initialize(), "runtime memory initialize should succeed");
            uint8_t *const rdram = runtime.memory().getRDRAM();
            constexpr uint32_t kImageAddr = 0x4000u;
            constexpr uint32_t kSrcAddr = 0x1800000u;   // high RAM: the guest heap starts at 0x100000 and the stub mallocs a 256 KiB packet there
            constexpr uint32_t kDstAddr = 0x1900000u;
            constexpr uint32_t kPieceBytes = 256u * 256u * 4u; // 0x40000
            constexpr uint32_t kPieces = 7u;
            constexpr uint16_t kFirstVramAddr = 0x2400u;
            constexpr uint16_t kVramStep = 0x400u;

            auto fillPiece = [&](uint32_t base, uint32_t piece)
            {
                for (uint32_t off = 0; off < kPieceBytes; off += 4u)
                {
                    const uint32_t word = (piece << 24) | (off & 0x00FFFFFFu);
                    std::memcpy(rdram + base + off, &word, sizeof(word));
                }
            };

            // Load: EE -> GS, seven pieces.
            for (uint32_t i = 0; i < kPieces; ++i)
            {
                const uint16_t vramAddr = static_cast<uint16_t>(kFirstVramAddr + i * kVramStep);
                const GsImageMem image{0u, 0u, 256u, 256u, vramAddr, 4u, 0u};
                writeGsImageTest(rdram, kImageAddr, image);
                fillPiece(kSrcAddr, i);

                R5900Context loadCtx{};
                setRegU32(loadCtx, 4, kImageAddr);
                setRegU32(loadCtx, 5, kSrcAddr);
                ps2_stubs::sceGsExecLoadImage(rdram, &loadCtx, &runtime);
                t.Equals(static_cast<int32_t>(getRegU32Test(loadCtx, 2)), 0,
                         "sceGsExecLoadImage piece " + std::to_string(i) + " should succeed");

                // The freed packet still holds the BITBLTBUF it sent; DBP is bits 32..45 of the A+D data.
                uint64_t bitbltbuf = 0u;
                std::memcpy(&bitbltbuf, rdram + runtime.guestHeapBase() + 16u, sizeof(bitbltbuf));
                const uint32_t dbp = static_cast<uint32_t>((bitbltbuf >> 32) & 0x3FFFu);
                t.Equals(dbp, static_cast<uint32_t>(vramAddr),
                         "sceGsExecLoadImage should send BITBLTBUF DBP == vram_addr (256-byte blocks) for piece " +
                             std::to_string(i));
            }

            // Store: GS -> EE, the same seven pieces back.
            for (uint32_t i = 0; i < kPieces; ++i)
            {
                const uint16_t vramAddr = static_cast<uint16_t>(kFirstVramAddr + i * kVramStep);
                const GsImageMem image{0u, 0u, 256u, 256u, vramAddr, 4u, 0u};
                writeGsImageTest(rdram, kImageAddr, image);
                std::memset(rdram + kDstAddr, 0xEE, kPieceBytes);

                R5900Context storeCtx{};
                setRegU32(storeCtx, 4, kImageAddr);
                setRegU32(storeCtx, 5, kDstAddr);
                ps2_stubs::sceGsExecStoreImage(rdram, &storeCtx, &runtime);
                t.Equals(static_cast<int32_t>(getRegU32Test(storeCtx, 2)), 0,
                         "sceGsExecStoreImage piece " + std::to_string(i) + " should succeed");

                uint64_t bitbltbuf = 0u;
                std::memcpy(&bitbltbuf, rdram + runtime.guestHeapBase() + 16u, sizeof(bitbltbuf));
                const uint32_t sbp = static_cast<uint32_t>(bitbltbuf & 0x3FFFu);
                t.Equals(sbp, static_cast<uint32_t>(vramAddr),
                         "sceGsExecStoreImage should send BITBLTBUF SBP == vram_addr (256-byte blocks) for piece " +
                             std::to_string(i));

                uint32_t firstWord = 0u;
                std::memcpy(&firstWord, rdram + kDstAddr, sizeof(firstWord));
                const uint32_t gotPiece = firstWord >> 24;
                t.Equals(gotPiece, i,
                         "piece " + std::to_string(i) + " should read back its own bytes, not another piece's "
                         "(the x8 block pointer aliases seven regions onto two: [6,5,6,5,6,5,6])");

                bool wholePieceOk = true;
                for (uint32_t off = 0; off < kPieceBytes && wholePieceOk; off += 4u)
                {
                    uint32_t word = 0u;
                    std::memcpy(&word, rdram + kDstAddr + off, sizeof(word));
                    wholePieceOk = word == ((i << 24) | (off & 0x00FFFFFFu));
                }
                t.IsTrue(wholePieceOk, "piece " + std::to_string(i) + " should round-trip every word");
            }
        });

        // Issue #31 (research/25 §10, KNOWN §2): the streamed full-screen image path FUN_001c6570 (decomp 45100/45108)
        // calls sceGsSetDefLoadImage ONCE -- its packet on the stack at sp+0xA0070, the top of the frame -- then per
        // 640x64 CT32 strip reads 0x28000 bytes, calls sceGsExecLoadImage and advances DBP itself:
        //   lhu v1,0x14(pkt); v1 = (v1 & 0xC000) | ((v1 & 0x3FFF) + 0x280) & 0x3FFF; sh v1,0x14(pkt)
        // Only the DBP halfword changes; DBW (0x16), DPSM (0x17), TRXPOS and TRXREG stay as set. LOADING.RAW is
        // 640x448 at x=y=0: seven strips, DBP 0, 0x280 ... 0xF00. Each strip must land at the DBP the packet holds
        // at exec time. `foreignQword` puts an A+D-looking quadword (register byte 0x50) right after the six-quadword
        // load packet, where the guest's packet ends and its caller's frame begins: the exec-time parse must stop at
        // the packet's TRXDIR, not read a seventh quadword that is not the packet's.
        auto runStreamedImage = [](TestCase &t, bool foreignQword)
        {
            PS2Runtime runtime;
            t.IsTrue(runtime.memory().initialize(), "runtime memory initialize should succeed");
            uint8_t *const rdram = runtime.memory().getRDRAM();
            constexpr uint32_t kPacketAddr = 0x4000u;
            constexpr uint32_t kStoreImageAddr = 0x5000u;
            constexpr uint32_t kSrcAddr = 0x1800000u;   // above the guest heap, where the stub mallocs its packet
            constexpr uint32_t kDstAddr = 0x1900000u;
            constexpr uint32_t kWidth = 640u;
            constexpr uint32_t kStripLines = 64u;
            constexpr uint32_t kStripBytes = kWidth * kStripLines * 4u; // 0x28000, the guest's read size
            constexpr uint32_t kStrips = 448u / kStripLines;           // LOADING.RAW: param_3 = 0x1c0
            constexpr uint32_t kDbpStep = kStripBytes / 256u;           // 0x280, the guest's +0x280
            constexpr uint32_t kDbw = kWidth / 64u;                     // 10

            if (foreignQword)
            {
                const uint64_t strayLo = (0x3F00ull << 32) | (static_cast<uint64_t>(kDbw) << 48);
                writeGsQword(rdram + kPacketAddr + 0x60u, strayLo, 0x50ull);
            }

            R5900Context defCtx{};
            setRegU32(defCtx, 4, kPacketAddr);
            setRegU32(defCtx, 5, 0u);        // DBP: (x*4 + y*0xa00) >> 8 = 0 for LOADING.RAW
            setRegU32(defCtx, 6, kDbw);      // DBW: 640 >> 6
            setRegU32(defCtx, 7, 0u);        // PSMCT32
            setRegU32(defCtx, 8, 0u);        // x
            setRegU32(defCtx, 9, 0u);        // y
            setRegU32(defCtx, 10, kWidth);   // w
            setRegU32(defCtx, 11, kStripLines); // h = 0x40
            ps2_stubs::sceGsSetDefLoadImage(rdram, &defCtx, &runtime);

            uint16_t setTimeDbpHalf = 0u;
            std::memcpy(&setTimeDbpHalf, rdram + kPacketAddr + 0x14u, sizeof(setTimeDbpHalf));
            t.Equals(static_cast<uint32_t>(setTimeDbpHalf), 0u,
                     "the halfword at packet offset 0x14 is BITBLTBUF's DBP (the one the guest advances)");

            for (uint32_t i = 0; i < kStrips; ++i)
            {
                for (uint32_t off = 0; off < kStripBytes; off += 4u)
                {
                    const uint32_t word = (i << 24) | (off & 0x00FFFFFFu);
                    std::memcpy(rdram + kSrcAddr + off, &word, sizeof(word));
                }

                R5900Context loadCtx{};
                setRegU32(loadCtx, 4, kPacketAddr);
                setRegU32(loadCtx, 5, kSrcAddr);
                ps2_stubs::sceGsExecLoadImage(rdram, &loadCtx, &runtime);
                t.Equals(static_cast<int32_t>(getRegU32Test(loadCtx, 2)), 0,
                         "sceGsExecLoadImage strip " + std::to_string(i) + " should succeed");

                // The freed packet still holds the BITBLTBUF the stub sent.
                uint64_t bitbltbuf = 0u;
                std::memcpy(&bitbltbuf, rdram + runtime.guestHeapBase() + 16u, sizeof(bitbltbuf));
                t.Equals(static_cast<uint32_t>((bitbltbuf >> 32) & 0x3FFFu), i * kDbpStep,
                         "strip " + std::to_string(i) + " should be sent to the DBP the guest wrote at packet "
                         "offset 0x14, not the set-time DBP or a stray quadword's");
                t.Equals(static_cast<uint32_t>((bitbltbuf >> 48) & 0x3Fu), kDbw,
                         "strip " + std::to_string(i) + " keeps DBW 10");
                t.Equals(static_cast<uint32_t>((bitbltbuf >> 56) & 0x3Fu), 0u,
                         "strip " + std::to_string(i) + " keeps DPSM PSMCT32");

                // FUN_001c6570 0x1c66f0..0x1c6714: advance DBP in the packet, keeping the halfword's top two bits.
                uint16_t half = 0u;
                std::memcpy(&half, rdram + kPacketAddr + 0x14u, sizeof(half));
                half = static_cast<uint16_t>((half & 0xC000u) | (((half & 0x3FFFu) + kDbpStep) & 0x3FFFu));
                std::memcpy(rdram + kPacketAddr + 0x14u, &half, sizeof(half));
            }

            // Read every strip back from its own blocks: each must hold its own bytes, not the last strip's.
            for (uint32_t i = 0; i < kStrips; ++i)
            {
                const GsImageMem image{0u, 0u, static_cast<uint16_t>(kWidth), static_cast<uint16_t>(kStripLines),
                                       static_cast<uint16_t>(i * kDbpStep), static_cast<uint8_t>(kDbw), 0u};
                writeGsImageTest(rdram, kStoreImageAddr, image);
                std::memset(rdram + kDstAddr, 0xEE, kStripBytes);

                R5900Context storeCtx{};
                setRegU32(storeCtx, 4, kStoreImageAddr);
                setRegU32(storeCtx, 5, kDstAddr);
                ps2_stubs::sceGsExecStoreImage(rdram, &storeCtx, &runtime);
                t.Equals(static_cast<int32_t>(getRegU32Test(storeCtx, 2)), 0,
                         "sceGsExecStoreImage strip " + std::to_string(i) + " should succeed");

                bool wholeStripOk = true;
                uint32_t firstBad = 0u;
                for (uint32_t off = 0; off < kStripBytes && wholeStripOk; off += 4u)
                {
                    uint32_t word = 0u;
                    std::memcpy(&word, rdram + kDstAddr + off, sizeof(word));
                    wholeStripOk = word == ((i << 24) | (off & 0x00FFFFFFu));
                    firstBad = word;
                }
                t.IsTrue(wholeStripOk, "strip " + std::to_string(i) + " should read back its own bytes from DBP " +
                                           std::to_string(i * kDbpStep) + " (first wrong word's strip id " +
                                           std::to_string(firstBad >> 24) + ")");
            }
        };

        tc.Run("streamed full-screen image (FUN_001c6570): each 640x64 strip lands at the DBP the guest wrote at packet offset 0x14",
               [runStreamedImage](TestCase &t) { runStreamedImage(t, false); });

        tc.Run("streamed full-screen image: a quadword after the six-quadword load packet is not read as the packet's BITBLTBUF",
               [runStreamedImage](TestCase &t) { runStreamedImage(t, true); });

        tc.Run("sceGifPkRefLoadImage seeds A+D GIFtag nloop once (no double-count)", [](TestCase &t)
        {
            std::vector<uint8_t> rdram(PS2_RAM_SIZE, 0u);
            PS2Runtime runtime;
            R5900Context ctx{};

            constexpr uint32_t stateAddr = 0x1000u;
            constexpr uint32_t baseAddr = 0x2000u;
            constexpr uint32_t spAddr = 0x8000u;

            setRegU32(ctx, 4, stateAddr);
            setRegU32(ctx, 5, baseAddr);
            ps2_stubs::sceGifPkInit(rdram.data(), &ctx, &runtime);

            setRegU32(ctx, 29, spAddr);
            const uint32_t width = 16u;
            const uint32_t height = 1u;
            std::memcpy(rdram.data() + spAddr, &width, sizeof(width));
            std::memcpy(rdram.data() + spAddr + 8u, &height, sizeof(height));

            const uint32_t dbp = 0x3fc0u;
            const uint32_t dpsm = 0u;
            const uint32_t dbw = 1u;
            const uint32_t dataAddr = 0u;
            const uint32_t dsax = 0u;
            const uint32_t dsay = 0u;

            setRegU32(ctx, 4, stateAddr);
            setRegU32(ctx, 5, dbp);
            setRegU32(ctx, 6, dpsm);
            setRegU32(ctx, 7, dbw);
            setRegU32(ctx, 8, dataAddr);
            setRegU32(ctx, 9, 0u); // qwcRemaining: setup only, no image body
            setRegU32(ctx, 10, dsax);
            setRegU32(ctx, 11, dsay);
            ps2_stubs::sceGifPkRefLoadImage(rdram.data(), &ctx, &runtime);

            uint64_t tagLo = 0u;
            uint64_t tagHi = 0u;
            std::memcpy(&tagLo, rdram.data() + baseAddr + 16u, sizeof(tagLo));
            std::memcpy(&tagHi, rdram.data() + baseAddr + 24u, sizeof(tagHi));
            t.Equals(tagLo, static_cast<uint64_t>(0x1000000000000004ULL),
                      "header GIFtag lo must be nloop=4 nreg=1 A+D eop=0 (double-count would give ...0008)");
            t.Equals(tagHi, static_cast<uint64_t>(0xEULL),
                      "header GIFtag hi must be A+D register descriptor 0xE");

            uint64_t reg1Desc = 0u;
            uint64_t reg2Desc = 0u;
            uint64_t reg3Desc = 0u;
            uint64_t reg4Desc = 0u;
            std::memcpy(&reg1Desc, rdram.data() + baseAddr + 32u + 0u * 16u + 8u, sizeof(reg1Desc));
            std::memcpy(&reg2Desc, rdram.data() + baseAddr + 32u + 1u * 16u + 8u, sizeof(reg2Desc));
            std::memcpy(&reg3Desc, rdram.data() + baseAddr + 32u + 2u * 16u + 8u, sizeof(reg3Desc));
            std::memcpy(&reg4Desc, rdram.data() + baseAddr + 32u + 3u * 16u + 8u, sizeof(reg4Desc));
            t.Equals(reg1Desc, static_cast<uint64_t>(0x50ULL), "first register qword should be BITBLTBUF (0x50)");
            t.Equals(reg2Desc, static_cast<uint64_t>(0x51ULL), "second register qword should be TRXPOS (0x51)");
            t.Equals(reg3Desc, static_cast<uint64_t>(0x52ULL), "third register qword should be TRXREG (0x52)");
            t.Equals(reg4Desc, static_cast<uint64_t>(0x53ULL), "fourth register qword should be TRXDIR (0x53)");

            uint64_t reg1Payload = 0u;
            uint64_t reg2Payload = 0u;
            uint64_t reg3Payload = 0u;
            uint64_t reg4Payload = 0u;
            std::memcpy(&reg1Payload, rdram.data() + baseAddr + 32u + 0u * 16u + 0u, sizeof(reg1Payload));
            std::memcpy(&reg2Payload, rdram.data() + baseAddr + 32u + 1u * 16u + 0u, sizeof(reg2Payload));
            std::memcpy(&reg3Payload, rdram.data() + baseAddr + 32u + 2u * 16u + 0u, sizeof(reg3Payload));
            std::memcpy(&reg4Payload, rdram.data() + baseAddr + 32u + 3u * 16u + 0u, sizeof(reg4Payload));
            // BITBLTBUF: dbp=0x3fc0 (bits 32-45), dbw=1 (bits 48-53), dpsm=0 (bits 56-61).
            t.Equals(reg1Payload, static_cast<uint64_t>(0x00013FC000000000ULL),
                      "BITBLTBUF payload must encode dbp=0x3fc0, dbw=1, dpsm=0");
            // TRXPOS: dsax=0, dsay=0.
            t.Equals(reg2Payload, static_cast<uint64_t>(0x0ULL),
                      "TRXPOS payload must encode dsax=0, dsay=0");
            // TRXREG: width=16 (bits 0-31), height=1 (bits 32-63).
            t.Equals(reg3Payload, static_cast<uint64_t>(0x0000000100000010ULL),
                      "TRXREG payload must encode width=16, height=1");
            // TRXDIR: host-to-local transfer, dir=0.
            t.Equals(reg4Payload, static_cast<uint64_t>(0x0ULL),
                      "TRXDIR payload must encode dir=0 (host-to-local)");
        });

        tc.Run("sceGsResetGraph frees its temporary GIF packet", [](TestCase &t)
        {
            PS2Runtime runtime;
            t.IsTrue(runtime.memory().initialize(), "runtime memory initialize should succeed");

            std::vector<uint8_t> rdram(PS2_RAM_SIZE, 0u);
            R5900Context ctx{};
            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 1u);
            setRegU32(ctx, 6, 2u);
            setRegU32(ctx, 7, 1u);
            ps2_stubs::sceGsResetGraph(rdram.data(), &ctx, &runtime);

            t.Equals(static_cast<int32_t>(getRegU32Test(ctx, 2)), 0,
                     "sceGsResetGraph should succeed in reset mode");
            expectGuestHeapReusable(t, runtime,
                                    "sceGsResetGraph should free its temporary GIF packet");
        });

        tc.Run("sceGsSyncV resumes through the scheduler with deterministic field parity", [](TestCase &t)
        {
            PS2Runtime runtime;
            t.IsTrue(runtime.memory().initialize(), "runtime memory initialize should succeed");
            std::vector<uint8_t> rdram(PS2_RAM_SIZE, 0u);

            R5900Context resetCtx{};
            setRegU32(resetCtx, 4, 0u);
            setRegU32(resetCtx, 5, 1u);
            setRegU32(resetCtx, 6, 2u);
            setRegU32(resetCtx, 7, 1u);
            ps2_stubs::sceGsResetGraph(rdram.data(), &resetCtx, &runtime);
            runtime.registerFunction(kGsSyncWait0Pc, testGsSyncWait0);
            runtime.registerFunction(kGsSyncResume0Pc, testGsSyncResume0);
            runtime.registerFunction(kGsSyncWait1Pc, testGsSyncWait1);
            runtime.registerFunction(kGsSyncResume1Pc, testGsSyncResume1);
            g_gsSyncFirstField.store(-1, std::memory_order_release);
            g_gsSyncSecondField.store(-1, std::memory_order_release);

            R5900Context mainContext{};
            mainContext.pc = kGsSyncWait0Pc;
            runtime.eeScheduler().reset(rdram.data(), mainContext);
            runtime.eeScheduler().run();

            t.Equals(g_gsSyncFirstField.load(std::memory_order_acquire), 0,
                     "first interlaced VBlank should report even field");
            t.Equals(g_gsSyncSecondField.load(std::memory_order_acquire), 1,
                     "second interlaced VBlank should report odd field");
        });

        tc.Run("sceGsSyncVCallback runs as a scheduler invocation on its callback stack", [](TestCase &t)
        {
            g_gsSyncCallbackHits.store(0u, std::memory_order_relaxed);
            g_gsSyncCallbackLastTick.store(0u, std::memory_order_relaxed);
            g_gsSyncCallbackSp.store(0u, std::memory_order_relaxed);
            g_gsSyncCallbackGp.store(0u, std::memory_order_relaxed);
            g_gsSyncCallbackPrevious.store(0xFFFFFFFFu, std::memory_order_relaxed);

            PS2Runtime runtime;
            t.IsTrue(runtime.memory().initialize(), "runtime memory initialize should succeed");
            std::vector<uint8_t> rdram(PS2_RAM_SIZE, 0u);
            runtime.configureGuestHeap(0x01F00000u, 0x01F00000u);
            runtime.registerFunction(kGsCallbackMainPc, testGsCallbackMain);
            runtime.registerFunction(kGsCallbackResumePc, testGsCallbackResume);
            runtime.registerFunction(kGsCallbackPc, testGsSyncVCallback);

            R5900Context mainContext{};
            mainContext.pc = kGsCallbackMainPc;
            runtime.eeScheduler().reset(rdram.data(), mainContext);
            runtime.eeScheduler().run();

            t.Equals(g_gsSyncCallbackPrevious.load(std::memory_order_acquire), 0u,
                     "first callback registration should return no previous callback");
            t.Equals(g_gsSyncCallbackHits.load(std::memory_order_acquire), 1u,
                     "the callback should execute once at the next VBlank boundary");
            t.IsTrue(g_gsSyncCallbackLastTick.load(std::memory_order_acquire) > 0u,
                     "VSync callback should receive a positive tick value");
            t.Equals(g_gsSyncCallbackGp.load(std::memory_order_acquire), kGsCallbackGp,
                     "callback invocation should preserve the registered GP");
            t.IsTrue(g_gsSyncCallbackSp.load(std::memory_order_acquire) >= 0x01F00000u,
                     "callback invocation should use the reserved async stack pool");
            t.IsTrue(g_gsSyncCallbackSp.load(std::memory_order_acquire) != kGsCallbackCallerSp,
                     "callback invocation must not reuse the caller stack");
        });

        tc.Run("GS T4HL/T4HH shared-plane upload preserves both index planes via RMW", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint32_t kDbp = 64u;
            constexpr uint32_t kDbw = 1u;
            constexpr uint32_t kRrw = 8u;
            constexpr uint32_t kRrh = 8u;
            constexpr uint64_t kRect = (static_cast<uint64_t>(kRrw) << 0) | (static_cast<uint64_t>(kRrh) << 32);

            // Two independent, differing index patterns for the T4HL and T4HH planes.
            auto indexA = [](uint32_t x, uint32_t y) -> uint8_t
            {
                return static_cast<uint8_t>((x * 3u + y * 5u + 1u) & 0xFu);
            };
            auto indexB = [](uint32_t x, uint32_t y) -> uint8_t
            {
                return static_cast<uint8_t>((x * 7u + y * 2u + 9u) & 0xFu);
            };

            auto buildPacked = [&](const auto &indexFn) -> std::vector<uint8_t>
            {
                std::vector<uint8_t> packed((kRrw * kRrh) / 2u, 0u);
                for (uint32_t y = 0; y < kRrh; ++y)
                {
                    for (uint32_t x = 0; x < kRrw; x += 2u)
                    {
                        const uint8_t lo = indexFn(x, y) & 0xFu;
                        const uint8_t hi = indexFn(x + 1u, y) & 0xFu;
                        packed[(y * kRrw + x) / 2u] = static_cast<uint8_t>(lo | (hi << 4));
                    }
                }
                return packed;
            };

            const std::vector<uint8_t> packedA = buildPacked(indexA);
            const std::vector<uint8_t> packedB = buildPacked(indexB);

            constexpr uint64_t kUploadHLBitblt =
                (static_cast<uint64_t>(kDbp) << 32) |
                (static_cast<uint64_t>(kDbw) << 48) |
                (static_cast<uint64_t>(GS_PSM_T4HL) << 56);
            constexpr uint64_t kUploadHHBitblt =
                (static_cast<uint64_t>(kDbp) << 32) |
                (static_cast<uint64_t>(kDbw) << 48) |
                (static_cast<uint64_t>(GS_PSM_T4HH) << 56);

            gs.writeRegister(GS_REG_BITBLTBUF, kUploadHLBitblt);
            gs.writeRegister(GS_REG_TRXPOS, 0ull);
            gs.writeRegister(GS_REG_TRXREG, kRect);
            gs.writeRegister(GS_REG_TRXDIR, 0ull);

            std::vector<uint8_t> packetA;
            appendU64(packetA, makeGifTag(static_cast<uint16_t>(packedA.size() / 16u), GIF_FMT_IMAGE, 0u, true));
            appendU64(packetA, 0ull);
            packetA.insert(packetA.end(), packedA.begin(), packedA.end());
            gs.processGIFPacket(packetA.data(), static_cast<uint32_t>(packetA.size()));

            gs.writeRegister(GS_REG_BITBLTBUF, kUploadHHBitblt);
            gs.writeRegister(GS_REG_TRXPOS, 0ull);
            gs.writeRegister(GS_REG_TRXREG, kRect);
            gs.writeRegister(GS_REG_TRXDIR, 0ull);

            std::vector<uint8_t> packetB;
            appendU64(packetB, makeGifTag(static_cast<uint16_t>(packedB.size() / 16u), GIF_FMT_IMAGE, 0u, true));
            appendU64(packetB, 0ull);
            packetB.insert(packetB.end(), packedB.begin(), packedB.end());
            gs.processGIFPacket(packetB.data(), static_cast<uint32_t>(packetB.size()));

            bool planesMatch = true;
            bool memReadersMatch = true;
            for (uint32_t y = 0; y < kRrh; ++y)
            {
                for (uint32_t x = 0; x < kRrw; ++x)
                {
                    const uint32_t off = GSPSMCT32::addrPSMCT32(kDbp, kDbw, x, y);
                    uint32_t word = 0u;
                    std::memcpy(&word, vram.data() + off, sizeof(word));

                    const uint8_t expectedA = indexA(x, y);
                    const uint8_t expectedB = indexB(x, y);
                    const uint8_t gotA = static_cast<uint8_t>((word >> 24) & 0xFu);
                    const uint8_t gotB = static_cast<uint8_t>((word >> 28) & 0xFu);
                    if (gotA != expectedA || gotB != expectedB)
                        planesMatch = false;

                    const uint32_t memA = GSMem::ReadP4HL(vram.data(), kDbp, kDbw, x, y);
                    const uint32_t memB = GSMem::ReadP4HH(vram.data(), kDbp, kDbw, x, y);
                    if (memA != expectedA || memB != expectedB)
                        memReadersMatch = false;
                }
            }
            t.IsTrue(planesMatch,
                     "T4HL and T4HH uploads to the same shared CT32 word must not clobber each other's nibble");
            t.IsTrue(memReadersMatch,
                     "GSMem::ReadP4HL/ReadP4HH should agree with the raw shared-word nibble extraction");

            // --- T8H coverage: full-byte upload, round-trip via GSMem::ReadP8H, and the
            // --- clobber interaction when a later T4HL nibble upload lands on the same word.

            constexpr uint32_t kDbpT8H = 128u;
            constexpr uint32_t kDbwT8H = 1u;

            // Full 0..255 range so both nibbles of the uploaded byte vary independently.
            auto byteT8H = [](uint32_t x, uint32_t y) -> uint8_t
            {
                return static_cast<uint8_t>((x * 11u + y * 13u + 7u) & 0xFFu);
            };

            std::vector<uint8_t> packedT8H(kRrw * kRrh, 0u);
            for (uint32_t y = 0; y < kRrh; ++y)
            {
                for (uint32_t x = 0; x < kRrw; ++x)
                {
                    packedT8H[y * kRrw + x] = byteT8H(x, y);
                }
            }

            constexpr uint64_t kUploadT8HBitblt =
                (static_cast<uint64_t>(kDbpT8H) << 32) |
                (static_cast<uint64_t>(kDbwT8H) << 48) |
                (static_cast<uint64_t>(GS_PSM_T8H) << 56);

            gs.writeRegister(GS_REG_BITBLTBUF, kUploadT8HBitblt);
            gs.writeRegister(GS_REG_TRXPOS, 0ull);
            gs.writeRegister(GS_REG_TRXREG, kRect);
            gs.writeRegister(GS_REG_TRXDIR, 0ull);

            std::vector<uint8_t> packetT8H;
            appendU64(packetT8H, makeGifTag(static_cast<uint16_t>(packedT8H.size() / 16u), GIF_FMT_IMAGE, 0u, true));
            appendU64(packetT8H, 0ull);
            packetT8H.insert(packetT8H.end(), packedT8H.begin(), packedT8H.end());
            gs.processGIFPacket(packetT8H.data(), static_cast<uint32_t>(packetT8H.size()));

            bool t8hByteMatches = true;
            bool t8hMemReaderMatches = true;
            for (uint32_t y = 0; y < kRrh; ++y)
            {
                for (uint32_t x = 0; x < kRrw; ++x)
                {
                    const uint32_t off = GSPSMCT32::addrPSMCT32(kDbpT8H, kDbwT8H, x, y);
                    uint32_t word = 0u;
                    std::memcpy(&word, vram.data() + off, sizeof(word));

                    const uint8_t expected = byteT8H(x, y);
                    const uint8_t got = static_cast<uint8_t>((word >> 24) & 0xFFu);
                    if (got != expected)
                        t8hByteMatches = false;

                    const uint32_t memByte = GSMem::ReadP8H(vram.data(), kDbpT8H, kDbwT8H, x, y);
                    if (memByte != expected)
                        t8hMemReaderMatches = false;
                }
            }
            t.IsTrue(t8hByteMatches,
                     "T8H upload must land the full byte in bits 24-31 of the shared CT32 word");
            t.IsTrue(t8hMemReaderMatches,
                     "GSMem::ReadP8H should agree with the raw shared-word byte extraction after a T8H upload");

            // Clobber interaction: upload a T8H byte plane, then upload a T4HL nibble plane to
            // the same shared word. WriteP4HL's nibble RMW should overwrite bits 24-27 with the
            // new nibble while preserving bits 28-31 (the T8H byte's high nibble).
            constexpr uint32_t kDbpMix = 192u;
            constexpr uint32_t kDbwMix = 1u;

            auto byteMix = [](uint32_t x, uint32_t y) -> uint8_t
            {
                return static_cast<uint8_t>((x * 7u + y * 5u + 3u) & 0xFFu);
            };
            auto nibbleN = [](uint32_t x, uint32_t y) -> uint8_t
            {
                return static_cast<uint8_t>((x * 3u + y + 1u) & 0xFu);
            };

            std::vector<uint8_t> packedMixT8H(kRrw * kRrh, 0u);
            for (uint32_t y = 0; y < kRrh; ++y)
            {
                for (uint32_t x = 0; x < kRrw; ++x)
                {
                    packedMixT8H[y * kRrw + x] = byteMix(x, y);
                }
            }

            constexpr uint64_t kUploadMixT8HBitblt =
                (static_cast<uint64_t>(kDbpMix) << 32) |
                (static_cast<uint64_t>(kDbwMix) << 48) |
                (static_cast<uint64_t>(GS_PSM_T8H) << 56);

            gs.writeRegister(GS_REG_BITBLTBUF, kUploadMixT8HBitblt);
            gs.writeRegister(GS_REG_TRXPOS, 0ull);
            gs.writeRegister(GS_REG_TRXREG, kRect);
            gs.writeRegister(GS_REG_TRXDIR, 0ull);

            std::vector<uint8_t> packetMixT8H;
            appendU64(packetMixT8H,
                      makeGifTag(static_cast<uint16_t>(packedMixT8H.size() / 16u), GIF_FMT_IMAGE, 0u, true));
            appendU64(packetMixT8H, 0ull);
            packetMixT8H.insert(packetMixT8H.end(), packedMixT8H.begin(), packedMixT8H.end());
            gs.processGIFPacket(packetMixT8H.data(), static_cast<uint32_t>(packetMixT8H.size()));

            std::vector<uint8_t> packedMixNibble((kRrw * kRrh) / 2u, 0u);
            for (uint32_t y = 0; y < kRrh; ++y)
            {
                for (uint32_t x = 0; x < kRrw; x += 2u)
                {
                    const uint8_t lo = nibbleN(x, y) & 0xFu;
                    const uint8_t hi = nibbleN(x + 1u, y) & 0xFu;
                    packedMixNibble[(y * kRrw + x) / 2u] = static_cast<uint8_t>(lo | (hi << 4));
                }
            }

            constexpr uint64_t kUploadMixHLBitblt =
                (static_cast<uint64_t>(kDbpMix) << 32) |
                (static_cast<uint64_t>(kDbwMix) << 48) |
                (static_cast<uint64_t>(GS_PSM_T4HL) << 56);

            gs.writeRegister(GS_REG_BITBLTBUF, kUploadMixHLBitblt);
            gs.writeRegister(GS_REG_TRXPOS, 0ull);
            gs.writeRegister(GS_REG_TRXREG, kRect);
            gs.writeRegister(GS_REG_TRXDIR, 0ull);

            std::vector<uint8_t> packetMixNibble;
            appendU64(packetMixNibble,
                      makeGifTag(static_cast<uint16_t>(packedMixNibble.size() / 16u), GIF_FMT_IMAGE, 0u, true));
            appendU64(packetMixNibble, 0ull);
            packetMixNibble.insert(packetMixNibble.end(), packedMixNibble.begin(), packedMixNibble.end());
            gs.processGIFPacket(packetMixNibble.data(), static_cast<uint32_t>(packetMixNibble.size()));

            bool mixClobberMatches = true;
            for (uint32_t y = 0; y < kRrh; ++y)
            {
                for (uint32_t x = 0; x < kRrw; ++x)
                {
                    const uint32_t off = GSPSMCT32::addrPSMCT32(kDbpMix, kDbwMix, x, y);
                    uint32_t word = 0u;
                    std::memcpy(&word, vram.data() + off, sizeof(word));

                    const uint8_t gotLow = static_cast<uint8_t>((word >> 24) & 0xFu);
                    const uint8_t gotHigh = static_cast<uint8_t>((word >> 28) & 0xFu);
                    const uint8_t expectedLow = nibbleN(x, y);
                    const uint8_t expectedHigh = static_cast<uint8_t>((byteMix(x, y) >> 4) & 0xFu);
                    if (gotLow != expectedLow || gotHigh != expectedHigh)
                        mixClobberMatches = false;
                }
            }
            t.IsTrue(mixClobberMatches,
                     "T4HL nibble upload over a T8H byte must overwrite bits 24-27 with the nibble and preserve "
                     "bits 28-31 from the T8H byte's high nibble");
        });

        tc.Run("GS T4HL/T4HH sampling reads only its own plane through independent CLUTs", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint32_t kTexTbp = 64u;
            constexpr uint32_t kClutCbpA = 128u;
            constexpr uint32_t kClutCbpB = 192u;
            constexpr uint8_t kIndexA = 4u; // T4HL plane index at the sampled texel (0..7 -> identity swizzle)
            constexpr uint8_t kIndexB = 0u; // T4HH plane index at the sampled texel; must differ from kIndexA

            // Shared CT32 word at texel (0,0): T4HL nibble occupies bits 24-27, T4HH bits 28-31.
            const uint32_t sharedWordOff = GSPSMCT32::addrPSMCT32(kTexTbp, 1u, 0u, 0u);
            const uint32_t sharedWord =
                (static_cast<uint32_t>(kIndexB) << 28) | (static_cast<uint32_t>(kIndexA) << 24);
            std::memcpy(vram.data() + sharedWordOff, &sharedWord, sizeof(sharedWord));

            constexpr uint32_t kExpectedColorA = 0x800000FFu; // RGBA = (255,0,0,128)
            constexpr uint32_t kExpectedColorB = 0x8000FF00u; // RGBA = (0,255,0,128)
            constexpr uint32_t kDistractorColor = 0x800000AAu;

            // Place each plane's expected color at its own CLUT's entry for the sampled index.
            const uint32_t clutAOff = GSPSMCT32::addrPSMCT32(kClutCbpA, 1u, kIndexA, 0u);
            const uint32_t clutBOff = GSPSMCT32::addrPSMCT32(kClutCbpB, 1u, kIndexB, 0u);
            std::memcpy(vram.data() + clutAOff, &kExpectedColorA, sizeof(kExpectedColorA));
            std::memcpy(vram.data() + clutBOff, &kExpectedColorB, sizeof(kExpectedColorB));

            // Seed distractor entries at the *other* plane's index in each CLUT so that a
            // cross-plane nibble read (a bug reading the wrong plane, or the wrong CLUT) would
            // resolve to a non-matching color instead of accidentally matching by coincidence.
            const uint32_t clutADistractorOff = GSPSMCT32::addrPSMCT32(kClutCbpA, 1u, kIndexB, 0u);
            const uint32_t clutBDistractorOff = GSPSMCT32::addrPSMCT32(kClutCbpB, 1u, kIndexA, 0u);
            std::memcpy(vram.data() + clutADistractorOff, &kDistractorColor, sizeof(kDistractorColor));
            std::memcpy(vram.data() + clutBDistractorOff, &kDistractorColor, sizeof(kDistractorColor));

            constexpr uint64_t kFrameReg =
                (0ull << 0) |
                (1ull << 16) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 24);
            constexpr uint64_t kZbuf = (1ull << 32);
            constexpr uint64_t kPrim =
                static_cast<uint64_t>(GS_PRIM_SPRITE) |
                (1ull << 4) |  // TME
                (1ull << 8);   // FST

            const uint64_t kTex0HL =
                (static_cast<uint64_t>(kTexTbp) << 0) |
                (1ull << 14) |
                (static_cast<uint64_t>(GS_PSM_T4HL) << 20) |
                (0ull << 26) |
                (0ull << 30) |
                (1ull << 34) |
                (1ull << 35) |
                (static_cast<uint64_t>(kClutCbpA) << 37) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 51);

            gs.writeRegister(GS_REG_FRAME_1, kFrameReg);
            gs.writeRegister(GS_REG_ZBUF_1, kZbuf);
            gs.writeRegister(GS_REG_SCISSOR_1, 0ull);
            gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
            gs.writeRegister(GS_REG_TEST_1, 0x30000ull);
            gs.writeRegister(GS_REG_ALPHA_1, 0ull);
            gs.writeRegister(GS_REG_TEX0_1, kTex0HL);
            gs.writeRegister(GS_REG_PRIM, kPrim);
            gs.writeRegister(GS_REG_RGBAQ, 0x80808080ull);
            gs.writeRegister(GS_REG_UV, 0ull);
            gs.writeRegister(GS_REG_XYZ2, 0ull);
            gs.writeRegister(GS_REG_UV, 0ull);
            gs.writeRegister(GS_REG_XYZ2, 0ull);

            uint32_t pixelHL = 0u;
            std::memcpy(&pixelHL, vram.data(), sizeof(pixelHL));
            t.Equals(pixelHL, kExpectedColorA,
                     "T4HL sampling should resolve through its own CLUT plane, unaffected by the co-resident T4HH nibble");

            const uint64_t kTex0HH =
                (static_cast<uint64_t>(kTexTbp) << 0) |
                (1ull << 14) |
                (static_cast<uint64_t>(GS_PSM_T4HH) << 20) |
                (0ull << 26) |
                (0ull << 30) |
                (1ull << 34) |
                (1ull << 35) |
                (static_cast<uint64_t>(kClutCbpB) << 37) |
                (static_cast<uint64_t>(GS_PSM_CT32) << 51);

            gs.writeRegister(GS_REG_TEX0_1, kTex0HH);
            gs.writeRegister(GS_REG_UV, 0ull);
            gs.writeRegister(GS_REG_XYZ2, 0ull);
            gs.writeRegister(GS_REG_UV, 0ull);
            gs.writeRegister(GS_REG_XYZ2, 0ull);

            uint32_t pixelHH = 0u;
            std::memcpy(&pixelHH, vram.data(), sizeof(pixelHH));
            t.Equals(pixelHH, kExpectedColorB,
                     "T4HH sampling should resolve through its own CLUT plane, unaffected by the co-resident T4HL nibble");
        });

        tc.Run("GS T4HL upload deactivates the transfer at total_pixels and discards excess bytes", [](TestCase &t)
        {
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            GS gs;
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);

            constexpr uint32_t kDbw = 1u;
            constexpr uint32_t kRrw = 8u;
            constexpr uint32_t kRrh = 8u;
            constexpr uint64_t kRect = (static_cast<uint64_t>(kRrw) << 0) | (static_cast<uint64_t>(kRrh) << 32);

            auto buildPacked = [&](const auto &indexFn) -> std::vector<uint8_t>
            {
                std::vector<uint8_t> packed((kRrw * kRrh) / 2u, 0u);
                for (uint32_t y = 0; y < kRrh; ++y)
                {
                    for (uint32_t x = 0; x < kRrw; x += 2u)
                    {
                        const uint8_t lo = indexFn(x, y) & 0xFu;
                        const uint8_t hi = indexFn(x + 1u, y) & 0xFu;
                        packed[(y * kRrw + x) / 2u] = static_cast<uint8_t>(lo | (hi << 4));
                    }
                }
                return packed;
            };

            // --- First transfer: an ~8x oversized IMAGE payload (256 bytes / 16 qwords) for a
            // rect that only needs 32 bytes (64 texels). The first 32 bytes carry a known
            // pattern; the remaining 224 bytes are a 0xFF sentinel that must be discarded.
            constexpr uint32_t kDbp1 = 0u;
            constexpr uint64_t kUploadBitblt1 =
                (static_cast<uint64_t>(kDbp1) << 32) |
                (static_cast<uint64_t>(kDbw) << 48) |
                (static_cast<uint64_t>(GS_PSM_T4HL) << 56);

            auto indexPattern1 = [](uint32_t x, uint32_t y) -> uint8_t
            {
                return static_cast<uint8_t>((x + y * 3u + 2u) & 0xFu);
            };
            const std::vector<uint8_t> packed1 = buildPacked(indexPattern1);
            t.Equals(packed1.size(), static_cast<size_t>(32), "sanity: packed rect should be 32 bytes (64 texels)");

            gs.writeRegister(GS_REG_BITBLTBUF, kUploadBitblt1);
            gs.writeRegister(GS_REG_TRXPOS, 0ull);
            gs.writeRegister(GS_REG_TRXREG, kRect);
            gs.writeRegister(GS_REG_TRXDIR, 0ull);

            constexpr uint32_t kOversizedBytes = 256u; // 16 qwords, 8x the required 32 bytes
            std::vector<uint8_t> packet;
            appendU64(packet, makeGifTag(static_cast<uint16_t>(kOversizedBytes / 16u), GIF_FMT_IMAGE, 0u, true));
            appendU64(packet, 0ull);
            const size_t payloadOffset = packet.size();
            packet.resize(payloadOffset + kOversizedBytes, 0xFFu);
            std::memcpy(packet.data() + payloadOffset, packed1.data(), packed1.size());
            gs.processGIFPacket(packet.data(), static_cast<uint32_t>(packet.size()));

            const GSDebugSnapshot snap1 = gs.getDebugSnapshot();
            t.Equals(snap1.transferCopiedPixels, 64u, "T4HL transfer should stop after copying exactly rrw*rrh texels");
            t.Equals(snap1.trxdir, 3u, "T4HL transfer should deactivate (trxdir=3) once total_pixels is reached");

            bool pattern1Ok = true;
            for (uint32_t y = 0; y < kRrh; ++y)
            {
                for (uint32_t x = 0; x < kRrw; ++x)
                {
                    const uint32_t off = GSPSMCT32::addrPSMCT32(kDbp1, kDbw, x, y);
                    uint32_t word = 0u;
                    std::memcpy(&word, vram.data() + off, sizeof(word));
                    if (((word >> 24) & 0xFu) != indexPattern1(x, y))
                        pattern1Ok = false;
                }
            }
            t.IsTrue(pattern1Ok,
                     "the first 64 texels of the oversized T4HL transfer should match the known pattern; sentinel bytes must not leak in");

            // --- Second, correctly-sized transfer to a different DBP: proves the discarded
            // excess bytes from the first transfer were not mis-accounted into later state.
            constexpr uint32_t kDbp2 = 128u;
            constexpr uint64_t kUploadBitblt2 =
                (static_cast<uint64_t>(kDbp2) << 32) |
                (static_cast<uint64_t>(kDbw) << 48) |
                (static_cast<uint64_t>(GS_PSM_T4HL) << 56);

            auto indexPattern2 = [](uint32_t x, uint32_t y) -> uint8_t
            {
                return static_cast<uint8_t>((x * 5u + y + 3u) & 0xFu);
            };
            const std::vector<uint8_t> packed2 = buildPacked(indexPattern2);

            gs.writeRegister(GS_REG_BITBLTBUF, kUploadBitblt2);
            gs.writeRegister(GS_REG_TRXPOS, 0ull);
            gs.writeRegister(GS_REG_TRXREG, kRect);
            gs.writeRegister(GS_REG_TRXDIR, 0ull);

            std::vector<uint8_t> packet2;
            appendU64(packet2, makeGifTag(static_cast<uint16_t>(packed2.size() / 16u), GIF_FMT_IMAGE, 0u, true));
            appendU64(packet2, 0ull);
            packet2.insert(packet2.end(), packed2.begin(), packed2.end());
            gs.processGIFPacket(packet2.data(), static_cast<uint32_t>(packet2.size()));

            const GSDebugSnapshot snap2 = gs.getDebugSnapshot();
            t.Equals(snap2.transferCopiedPixels, 64u, "second, correctly-sized T4HL transfer should copy exactly rrw*rrh texels");
            t.Equals(snap2.trxdir, 3u, "second T4HL transfer should also deactivate cleanly");

            bool pattern2Ok = true;
            for (uint32_t y = 0; y < kRrh; ++y)
            {
                for (uint32_t x = 0; x < kRrw; ++x)
                {
                    const uint32_t off = GSPSMCT32::addrPSMCT32(kDbp2, kDbw, x, y);
                    uint32_t word = 0u;
                    std::memcpy(&word, vram.data() + off, sizeof(word));
                    if (((word >> 24) & 0xFu) != indexPattern2(x, y))
                        pattern2Ok = false;
                }
            }
            t.IsTrue(pattern2Ok,
                     "second T4HL transfer to a different DBP should be byte-correct, proving the discarded excess bytes from the first transfer did not leak into subsequent transfer state");
        });
    });

    // research/26: the GL backend's depth path, replicated in the GPU's float32 arithmetic.
    MiniTest::Case("GSGlDepth", [](TestCase &tc)
    {
        // Seeding Chaos stream water (Z16S, 1105..1328 nearest the spawn), a bed/bank neighbour
        // pair, the top of Z24, and a Z32 value.
        static const double kZ[] = {1105.0, 1152.0, 1202.0, 1280.0, 1328.0, 9000.0, 16777215.0, 2147483648.0};
        static const size_t kN = sizeof(kZ) / sizeof(kZ[0]);

        tc.Run("legacy z*2-1 mapping rounds nearby GS z to the same window depth (the defect)", [](TestCase &t)
        {
            using namespace GsGlDepth;
            const float a = windowFromZ(Mode::Legacy, 1105.0), b = windowFromZ(Mode::Legacy, 1152.0), c = windowFromZ(Mode::Legacy, 1202.0);
            t.IsTrue(a == b && b == c, "legacy: 1105, 1152 and 1202 collapse to one depth");
            t.IsTrue(windowFromZ(Mode::Legacy, 1280.0) == windowFromZ(Mode::Legacy, 1328.0), "legacy: 1280 and 1328 collapse to one depth");
            t.IsTrue(static_cast<double>(b) * 4294967296.0 == 1152.0, "legacy: the collapsed depth is 1152 (a multiple of 128)");
        });

        tc.Run("clip-control and gl_FragDepth mappings keep integer GS z exact, distinct and ordered", [](TestCase &t)
        {
            using namespace GsGlDepth;
            for (Mode mode : {Mode::ClipZeroToOne, Mode::FragDepth})
            {
                const std::string tag = name(mode);
                for (size_t i = 0; i < kN; ++i)
                {
                    const float w = windowFromZ(mode, kZ[i]);
                    t.IsTrue(static_cast<double>(w) * 4294967296.0 == kZ[i], tag + ": window depth * 2^32 is the GS z exactly, z=" + std::to_string(kZ[i]));
                    if (i > 0)
                        t.IsTrue(windowFromZ(mode, kZ[i - 1]) < w, tag + ": window depth strictly increases with GS z at z=" + std::to_string(kZ[i]));
                }
            }
        });

        tc.Run("GEQUAL on coplanar-close z 1152 vs 1160: the nearer (larger z) wins in either draw order", [](TestCase &t)
        {
            using namespace GsGlDepth;
            auto gequalPasses = [](Mode mode, double incoming, double stored)
            { return windowFromZ(mode, incoming) >= windowFromZ(mode, stored); };
            t.IsTrue(gequalPasses(Mode::ClipZeroToOne, 1160.0, 1152.0), "clip-control: 1160 over stored 1152 passes");
            t.IsTrue(!gequalPasses(Mode::ClipZeroToOne, 1152.0, 1160.0), "clip-control: 1152 over stored 1160 is rejected");
            t.IsTrue(!gequalPasses(Mode::FragDepth, 1152.0, 1160.0), "gl_FragDepth: 1152 over stored 1160 is rejected");
            // The CPU backend's integer test agrees; the legacy mapping does not.
            t.IsTrue(gequalPasses(Mode::Legacy, 1152.0, 1160.0), "legacy: 1152 over stored 1160 wrongly passes (tie at 1152)");
        });

        tc.Run("depth mode choice: PS2X_GS_DEPTH_LEGACY wins, then clip control, then gl_FragDepth", [](TestCase &t)
        {
            using namespace GsGlDepth;
            t.IsTrue(legacyRequested("1"), "PS2X_GS_DEPTH_LEGACY=1 requests legacy");
            t.IsTrue(!legacyRequested(nullptr) && !legacyRequested("") && !legacyRequested("0"), "unset, empty or 0 does not");
            t.IsTrue(choose(true, true) == Mode::Legacy, "legacy env overrides clip control");
            t.IsTrue(choose(false, true) == Mode::ClipZeroToOne, "clip control is the default when available");
            t.IsTrue(choose(false, false) == Mode::FragDepth, "gl_FragDepth when clip control is unavailable");
        });
    });

    // Sprint 7 Task 1a: the GL capability probe and its latch, pure and context-free.
    MiniTest::Case("GsGlCaps", [](TestCase &tc)
    {
        tc.Run("GsGlCaps names exactly what a machine is missing", [](TestCase &t)
        {
            t.IsTrue(GsGlCaps::evaluate("3.3.0 NVIDIA 555.85", true, true).ok, "3.3 with both features is supported");
            t.IsTrue(GsGlCaps::evaluate("4.6.0 Core Profile", true, true).ok, "a newer core profile is supported");
            const GsGlCaps::Report old = GsGlCaps::evaluate("3.1.0 Mesa 21.0", true, true);
            t.IsTrue(!old.ok, "GL 3.1 is not supported");
            t.IsTrue(old.missing.find("OpenGL 3.3") != std::string::npos, "the line names the version: " + old.missing);
            const GsGlCaps::Report noDual = GsGlCaps::evaluate("3.3.0", false, true);
            t.IsTrue(!noDual.ok && noDual.missing.find("dual-source blending") != std::string::npos,
                     "the line names dual-source blending: " + noDual.missing);
            // Clip control is the exact-integer depth path; without it the fragment-depth mapping runs the game
            // (GsGlDepth::Mode::FragDepth), so its absence is a note, never a reason for the slow CPU rasterizer.
            const GsGlCaps::Report noClip = GsGlCaps::evaluate("3.3.0", true, false);
            t.IsTrue(noClip.ok && noClip.missing.empty(), "GL 3.3 without clip control is still supported");
            t.IsTrue(noClip.note.find("GL_ARB_clip_control") != std::string::npos,
                     "and the note names clip control: " + noClip.note);
            t.IsTrue(GsGlCaps::evaluate("3.3.0", true, true).note.empty(), "no note when clip control is there");
            t.IsTrue(GsGlCaps::evaluate(nullptr, true, true).ok == false, "no version string is a failure, not a pass");
        });
        tc.Run("PS2X_GS_GL_FORCE_FAIL is the only way to reach the fallback on a machine that works", [](TestCase &t)
        {
            // Step 10's gate greps the run log for this exact wording; pin it here rather than on a launch.
            const GsGlCaps::Report forced = GsGlCaps::evaluate("4.6.0 Core Profile", true, true, "1");
            t.IsTrue(!forced.ok, "the knob forces the unsupported path on a supported machine");
            t.Equals(forced.missing, std::string("forced (PS2X_GS_GL_FORCE_FAIL)"), "and says so by name");
            t.IsTrue(GsGlCaps::evaluate("4.6.0 Core Profile", true, true, nullptr).ok, "unset changes nothing");
            t.IsTrue(GsGlCaps::evaluate("4.6.0 Core Profile", true, true, "0").ok, "0 changes nothing");
            t.IsTrue(GsGlCaps::evaluate("4.6.0 Core Profile", true, true, "").ok, "empty changes nothing");
        });
        tc.Run("the GL latch attempts once and never recompiles per frame", [](TestCase &t)
        {
            GsGlCaps::Latch latch;
            t.IsTrue(latch.shouldAttempt(), "the first call attempts");
            latch.attempted();
            latch.fail(GsGlCaps::evaluate("3.1.0", false, false));
            t.IsTrue(latch.failed(), "the latch is set");
            for (int i = 0; i < 1000; ++i)
                t.IsTrue(!latch.shouldAttempt(), "a latched probe never attempts again");
            t.Equals(static_cast<int>(latch.attempts()), 1, "exactly one attempt over 1000 frames");
            t.IsTrue(!latch.report().missing.empty(), "the latch keeps what was missing");
        });
    });

    // Sprint 7 Task 1c: render-target extents chosen from FBW and the rows the game actually uses.
    MiniTest::Case("GsGlTarget", [](TestCase &tc)
    {
        tc.Run("render targets are sized from fbw and usedHeight, not 1024x1024", [](TestCase &t)
        {
            const GsGlTarget::Extent shell = GsGlTarget::choose(10u, 448u);   // FBW 10 = 640 px, PAL/NTSC height
            t.Equals(static_cast<int>(shell.width), 640, "640-wide shell buffer");
            t.Equals(static_cast<int>(shell.height), 448, "448 rows, not 1024");
            const GsGlTarget::Extent boot = GsGlTarget::choose(16u, 512u);
            t.Equals(static_cast<int>(boot.width), 1024, "a 1024-wide boot buffer is capped at the stride");
            t.Equals(static_cast<int>(boot.height), 512, "512 rows");
            const GsGlTarget::Extent unknown = GsGlTarget::choose(0u, 0u);
            t.Equals(static_cast<int>(unknown.width), 1024, "an unknown target keeps the old full allocation");
            t.Equals(static_cast<int>(unknown.height), 1024, "an unknown target keeps the old full allocation");
            t.Equals(static_cast<int>(GsGlTarget::choose(10u, 100u).height), 128, "rows round up to 32");
        });
    });

    // Sprint 8 Goal 2 Task 1: the per-call cost of a texture upload -- the size histogram, the
    // five per-call terms and the distinct destinations, checked without a GL context.
    MiniTest::Case("GsGlUploadTrace", [](TestCase &tc)
    {
        tc.Run("GsGlUploadTrace buckets a 16x16 1 KB tile apart from a full-page upload", [](TestCase &t)
        {
            t.Equals(GsGlUploadTrace::bucketFor(1024u), 0, "16x16 PSMCT32 = 1024 bytes is bucket 0");
            t.Equals(GsGlUploadTrace::bucketFor(1u), 0, "a partial chunk still counts as the smallest bucket");
            t.Equals(GsGlUploadTrace::bucketFor(1025u), 1, "just over 1 KB moves up one bucket");
            t.Equals(GsGlUploadTrace::bucketFor(2048u), 1, "32x16 = 2 KB is bucket 1");
            t.Equals(GsGlUploadTrace::bucketFor(8192u), 3, "8 KB is bucket 3");
            t.Equals(GsGlUploadTrace::bucketFor(65536u), 6, "64 KB is bucket 6");
            t.Equals(GsGlUploadTrace::bucketFor(65537u), 7, "anything larger lands in the last bucket");
            t.Equals(std::string(GsGlUploadTrace::kBucketLabels[0]), std::string("1k"), "bucket 0 is labelled 1k");
            t.Equals(std::string(GsGlUploadTrace::kBucketLabels[7]), std::string("big"), "the last bucket is labelled big");
        });

        tc.Run("GsGlUploadTrace reports microseconds per call and destinations per second", [](TestCase &t)
        {
            GsGlUploadTrace::Accum a;
            for (int i = 0; i < 500; ++i)
            {
                GsGlUploadTrace::noteUpload(a, 1024u, 6.0, 2.0);   // 8 us of CPU per tile
                GsGlUploadTrace::noteRecord(a, 2.0);
                GsGlUploadTrace::noteGlUpload(a, 7u + static_cast<uint32_t>(i % 3), 1.0, 4.0);
            }
            t.Equals(static_cast<int>(a.uploads), 500, "500 uploads counted");
            t.Equals(static_cast<int>(a.sizes[0]), 500, "all of them in the 1 KB bucket");
            t.Equals(static_cast<int>(a.dstTextures.size()), 3, "three distinct destination textures");
            const std::string line = GsGlUploadTrace::format(a, 1000.0);
            t.IsTrue(line.find("[gs-upload]") == 0u, "the line is tagged [gs-upload]");
            t.IsTrue(line.find("uploads=500/s") != std::string::npos, "uploads per second");
            t.IsTrue(line.find("1k=500") != std::string::npos, "the histogram names the 1 KB bucket");
            t.IsTrue(line.find("shadow=6.0") != std::string::npos, "6 us of shadow swizzle per upload");
            t.IsTrue(line.find("mark=2.0") != std::string::npos, "2 us of page+rect marking per upload");
            t.IsTrue(line.find("record=2.0") != std::string::npos, "2 us of record per upload");
            t.IsTrue(line.find("convert=1.0") != std::string::npos, "1 us of CPU convert per GL upload call");
            t.IsTrue(line.find("gl=4.0") != std::string::npos, "4 us of glTexSubImage2D per GL upload call");
            t.IsTrue(line.find("dst_textures=3") != std::string::npos, "the destination count is on the line");
            // Half a second of wall clock doubles every per-second figure and leaves the per-call ones alone.
            const std::string half = GsGlUploadTrace::format(a, 500.0);
            t.IsTrue(half.find("uploads=1000/s") != std::string::npos, "per-second figures scale with elapsed");
            t.IsTrue(half.find("shadow=6.0") != std::string::npos, "per-call figures do not");
        });
        // --- Sprint 8 Goal 2b Task 1: the transfer= column, split, and the identical-bytes question ---

        tc.Run("GsGlUploadTrace splits the transfer bucket into flush and body, by direction", [](TestCase &t)
        {
            GsGlUploadTrace::Accum a;
            for (int i = 0; i < 400; ++i)
            {
                // gs_gl_backend.cpp:1535-1538 -- the BeginTransfer case is flushBatch() then
                // executeTransfer(), and the clock at :1402 charges both to transfer=.
                GsGlUploadTrace::noteTransfer(a, 0u, 18.0, 2.0);
                GsGlUploadTrace::noteFlushPhases(a, 6.0, 9.0, 3.0, false);
            }
            for (int i = 0; i < 100; ++i)
            {
                GsGlUploadTrace::noteTransfer(a, 2u, 0.0, 40.0);   // a local->local VRAM move
                GsGlUploadTrace::noteFlushPhases(a, 0.0, 0.0, 0.0, true);
            }
            t.Equals(static_cast<int>(a.transfers), 500, "500 transfers counted");
            t.Equals(static_cast<int>(a.transfersByDir[0]), 400, "400 host->local");
            t.Equals(static_cast<int>(a.transfersByDir[2]), 100, "100 local->local");
            t.Equals(static_cast<int>(a.flushesEmpty), 100, "100 flushes had nothing to draw");
            t.Equals(static_cast<int>(a.flushesReal), 400, "400 flushes actually drew");
            const std::string line = GsGlUploadTrace::formatTransfer(a, 1000.0);
            t.IsTrue(line.find("[gs-transfer]") == 0u, "the line is tagged [gs-transfer]");
            t.IsTrue(line.find("transfers=500/s") != std::string::npos, "transfers per second");
            t.IsTrue(line.find("dir0=400") != std::string::npos, "the direction histogram names host->local");
            t.IsTrue(line.find("dir2=100") != std::string::npos, "and local->local");
            // 400 x 18 us of flush = 7.2 ms/s; 400 x 2 + 100 x 40 = 4.8 ms/s of body.
            t.IsTrue(line.find("flush=7.2ms/s") != std::string::npos, "the flush half of transfer= in ms/s");
            t.IsTrue(line.find("body=4.8ms/s") != std::string::npos, "the executeTransfer half in ms/s");
            t.IsTrue(line.find("dirty_rows=2.4ms/s") != std::string::npos, "refreshDirtyRows inside the flush");
            t.IsTrue(line.find("decode=3.6ms/s") != std::string::npos, "decodeTexture inside the flush");
            t.IsTrue(line.find("draw=1.2ms/s") != std::string::npos, "the draw itself inside the flush");
        });

        tc.Run("GsGlUploadTrace counts whole vs chunked uploads and identical bytes", [](TestCase &t)
        {
            GsGlUploadTrace::Accum a;
            for (int i = 0; i < 90; ++i)
                GsGlUploadTrace::noteUploadShape(a, true, i < 72);    // 80% identical, all whole
            for (int i = 0; i < 10; ++i)
                GsGlUploadTrace::noteUploadShape(a, false, false);    // chunked, never skippable (R119)
            t.Equals(static_cast<int>(a.uploadsWhole), 90, "90 whole-transfer uploads");
            t.Equals(static_cast<int>(a.uploadsChunked), 10, "10 arrived in pieces");
            t.Equals(static_cast<int>(a.uploadsIdentical), 72, "72 carried bytes the shadow already held");
            const std::string line = GsGlUploadTrace::formatTransfer(a, 1000.0);
            t.IsTrue(line.find("whole=90") != std::string::npos, "the whole-transfer count is on the line");
            t.IsTrue(line.find("chunked=10") != std::string::npos, "and the chunked one");
            t.IsTrue(line.find("identical=72") != std::string::npos, "and the identical-bytes count");
        });

        tc.Run("GsGlUploadTrace counts texture-cache invalidations against decodes", [](TestCase &t)
        {
            // gs_gl_backend.cpp:3209-3222: a cached entry whose pages carry a newer generation is
            // deleted and re-decoded. markShadowPages (:1843) bumps that generation on EVERY upload,
            // identical bytes or not, so this pair is the suspected root of the transfer= column.
            GsGlUploadTrace::Accum a;
            for (int i = 0; i < 30; ++i)
                GsGlUploadTrace::noteDecode(a, true);
            for (int i = 0; i < 4; ++i)
                GsGlUploadTrace::noteDecode(a, false);
            t.Equals(static_cast<int>(a.decodes), 34, "34 decodes");
            t.Equals(static_cast<int>(a.cacheInvalidations), 30, "30 of them replaced a live cache entry");
            const std::string line = GsGlUploadTrace::formatTransfer(a, 1000.0);
            t.IsTrue(line.find("decodes=34/s") != std::string::npos, "decodes per second");
            t.IsTrue(line.find("invalidations=30/s") != std::string::npos, "invalidations per second");
        });

        tc.Run("GsGlUploadIdentity::hash64 separates a one-byte change and is order-sensitive", [](TestCase &t)
        {
            std::vector<uint8_t> a(1024u, 0x5Au);
            std::vector<uint8_t> b = a;
            t.IsTrue(GsGlUploadIdentity::hash64(a.data(), a.size()) ==
                     GsGlUploadIdentity::hash64(b.data(), b.size()), "equal bytes hash equal");
            b[517] ^= 0x01u;
            t.IsTrue(GsGlUploadIdentity::hash64(a.data(), a.size()) !=
                     GsGlUploadIdentity::hash64(b.data(), b.size()), "one flipped bit in the middle changes the hash");
            std::vector<uint8_t> c{1u, 2u, 3u, 4u}, d{4u, 3u, 2u, 1u};
            t.IsTrue(GsGlUploadIdentity::hash64(c.data(), 4u) != GsGlUploadIdentity::hash64(d.data(), 4u),
                     "the same bytes in a different order hash differently");
            t.IsTrue(GsGlUploadIdentity::hash64(nullptr, 0u) == GsGlUploadIdentity::hash64(nullptr, 0u),
                     "an empty buffer is well defined");
        });

        // --- Sprint 8 Goal 2b, R123: the fix moves to the CONSUMER ---
        //
        // R122 (overlap-keyed upload skip) is implemented, measured and superseded: it fired on 4%
        // of uploads and its per-upload invalidation sweep cost ~84 ms/s, more than it saved. The
        // cost was never the upload -- it is resolveTexture deleting and re-decoding a cached
        // texture because a GENERATION STAMP moved, not because the CONTENT did (551-1385
        // invalidations a second against 26-52 cached textures: the whole cache, every frame).
        // A cache entry now carries a 64-bit hash of the exact source bytes it was decoded from,
        // and the stale-generation branch re-hashes before it throws anything away.

        tc.Run("R123: the texel source hash is what decodeTexture reads, row by row", [](TestCase &t)
        {
            // decodeTexture's loop is GSMem::ReadSpan(psm, vram, tbp0, tbw, 0, y, width, row) for
            // y in [0, height), and the hash walks exactly that, in that order.
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            std::vector<uint32_t> scratch(64u);
            for (uint32_t y = 0; y < 64u; ++y)
                for (uint32_t x = 0; x < 64u; ++x)
                    GSMem::WriteCT32(vram.data(), 0x0c0u, 1u, x, y, 0x11223344u + x + y * 64u);
            const uint64_t h0 = GsGlTextureIdentity::hashTexels(vram.data(), GS_PSM_CT32, 0x0c0u, 1u, 64u, 64u,
                                                                scratch.data(), GsGlTextureIdentity::seed());
            t.IsTrue(h0 != 0u, "a hashable source returns a hash");
            const uint64_t again = GsGlTextureIdentity::hashTexels(vram.data(), GS_PSM_CT32, 0x0c0u, 1u, 64u, 64u,
                                                                   scratch.data(), GsGlTextureIdentity::seed());
            t.IsTrue(h0 == again, "the same bytes hash the same");

            // (2) one changed source texel -> a different hash -> a decode.
            GSMem::WriteCT32(vram.data(), 0x0c0u, 1u, 33u, 17u, 0xDEADBEEFu);
            const uint64_t h1 = GsGlTextureIdentity::hashTexels(vram.data(), GS_PSM_CT32, 0x0c0u, 1u, 64u, 64u,
                                                               scratch.data(), GsGlTextureIdentity::seed());
            t.IsTrue(h1 != h0, "one changed source texel changes the hash");

            // (5) the render-target case, at the level this seam can see it: a write into the
            // source pages between two resolves -- which is what downloadRenderTargetToShadow does,
            // and resolveTexture runs that download BEFORE the cache gate -- changes the hash, so
            // the entry is never revalidated against bytes a decode would not read.
            GSMem::WriteCT32(vram.data(), 0x0c0u, 1u, 0u, 0u, 0x01020304u);
            t.IsTrue(GsGlTextureIdentity::hashTexels(vram.data(), GS_PSM_CT32, 0x0c0u, 1u, 64u, 64u,
                                                     scratch.data(), GsGlTextureIdentity::seed()) != h1,
                     "a render-target download into the source pages changes the hash");

            // The extent is part of the identity: the same bytes at a different size are not it.
            t.IsTrue(GsGlTextureIdentity::hashTexels(vram.data(), GS_PSM_CT32, 0x0c0u, 1u, 32u, 64u,
                                                     scratch.data(), GsGlTextureIdentity::seed()) !=
                     GsGlTextureIdentity::hashTexels(vram.data(), GS_PSM_CT32, 0x0c0u, 1u, 64u, 64u,
                                                     scratch.data(), GsGlTextureIdentity::seed()),
                     "width is part of the hash");
        });

        tc.Run("R123: the CLUT is part of the hash, and only the window the texture uses", [](TestCase &t)
        {
            // (3) and (4). The backend mixes the 256 CLUT entries it actually resolved -- through
            // resolveClutIndex, so csa/csm/cou/cov are already applied -- into the same running
            // hash. Mixing the RESOLVED entries and not the raw palette block is the choice: a
            // change to a palette entry outside this texture's csa window is never read by its
            // decode, so it must not force one.
            uint64_t h = GsGlTextureIdentity::seed();
            uint32_t clut[256];
            for (uint32_t i = 0; i < 256u; ++i)
                clut[i] = 0xFF000000u | i;
            const uint64_t base = GsGlTextureIdentity::hashClut(clut, h);
            clut[7] ^= 0x00000100u;                       // an entry the texture resolved
            t.IsTrue(GsGlTextureIdentity::hashClut(clut, h) != base, "a changed CLUT entry changes the hash");
            clut[7] ^= 0x00000100u;
            t.IsTrue(GsGlTextureIdentity::hashClut(clut, h) == base, "and restoring it restores the hash");
            // An entry outside the resolved window never reaches hashClut at all: the 256 values
            // handed in ARE the window (resolveClutIndex maps i through csa).
            t.Equals(static_cast<int>(sizeof(clut) / sizeof(clut[0])), 256, "the window is 256 resolved entries");
        });

        tc.Run("S17 F1 attempt 1: the decode walks the source once and its hash is textureSourceHash's", [](TestCase &t)
        {
            // KNOWN 2 (the Sprint 8 review's (a)): a texture that really changed paid three walks of its
            // source -- the revalidation hash, the decode, and textureSourceHash again inside the decode
            // for entry.sourceHash. The fold: decodeTexture hashes the rows it already reads, through
            // GsGlTextureIdentity::walkTexels, and the value must be hashTexels' exactly, or every entry
            // decoded after the fold fails its next revalidation and R123 is silently undone.
            // For a non-indexed format textureSourceHash() is hashTexels(..., seed()) and nothing else.
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            for (uint32_t y = 0; y < 64u; ++y)
                for (uint32_t x = 0; x < 64u; ++x)
                    GSMem::WriteCT32(vram.data(), 0x0c0u, 1u, x, y, 0x11223344u + x + y * 64u);
            std::vector<uint32_t> scratch(64u), row(64u), decoded(64u * 64u, 0u);
            const uint64_t sourceHash = GsGlTextureIdentity::hashTexels(vram.data(), GS_PSM_CT32, 0x0c0u, 1u, 64u, 64u,
                                                                        scratch.data(), GsGlTextureIdentity::seed());
            uint32_t rowsSeen = 0u;
            const GsGlTextureIdentity::DecodeWalk walk = GsGlTextureIdentity::walkTexels(
                vram.data(), GS_PSM_CT32, 0x0c0u, 1u, 64u, 64u, row.data(), GsGlTextureIdentity::seed(),
                [&](uint32_t y, const uint32_t *texels)
                {
                    ++rowsSeen;
                    std::memcpy(decoded.data() + static_cast<size_t>(y) * 64u, texels, 64u * sizeof(uint32_t));
                });
            t.IsTrue(walk.sourceHash != GsGlTextureIdentity::kUnhashable, "a CT32 source is hashable at decode time");
            t.IsTrue(walk.sourceHash == sourceHash, "the decode-time hash is textureSourceHash()'s value over the same bytes");
            t.Equals(walk.sourceWalks, 1u, "the decode reports one walk of the source");
            t.Equals(rowsSeen, 64u, "every row reaches the decode once");
            bool same = true;
            for (uint32_t y = 0; y < 64u; ++y)
                for (uint32_t x = 0; x < 64u; ++x)
                    same = same && decoded[static_cast<size_t>(y) * 64u + x] == 0x11223344u + x + y * 64u;
            t.IsTrue(same, "the rows handed to the decode are the planted texels, in order");

            // A changed texel: the decode's hash moves with the source, and still equals the revalidation's.
            GSMem::WriteCT32(vram.data(), 0x0c0u, 1u, 33u, 17u, 0xDEADBEEFu);
            const uint64_t changed = GsGlTextureIdentity::hashTexels(vram.data(), GS_PSM_CT32, 0x0c0u, 1u, 64u, 64u,
                                                                     scratch.data(), GsGlTextureIdentity::seed());
            const GsGlTextureIdentity::DecodeWalk again = GsGlTextureIdentity::walkTexels(
                vram.data(), GS_PSM_CT32, 0x0c0u, 1u, 64u, 64u, row.data(), GsGlTextureIdentity::seed(),
                [](uint32_t, const uint32_t *) {});
            t.IsTrue(again.sourceHash == changed && again.sourceHash != walk.sourceHash,
                     "a changed source texel moves the decode-time hash exactly as it moves textureSourceHash()");
            t.Equals(again.sourceWalks, 1u, "and the second decode is one walk too");
        });

        tc.Run("S17 F1 attempt 2: the two [gs-gl stats] tags are formatted only when the stats line prints them", [](TestCase &t)
        {
            // setupDrawState formatted a state tag and a blend tag and searched two logs for them on every draw, but
            // executeCommands prints (and clears) those logs only under PS2X_GS_STATS. Attempt 2 formats them only then;
            // PS2X_GS_SETUP_FORMAT=1 restores the unconditional formatting for the A/B (docs/KNOBS.md). The GL half --
            // setupDrawState calling these under the decision -- needs a context; the decision and the tags do not.
            // The knob is three-way so the A/B can be read under PS2X_GS_STATS, where the [gs-submit] setup= column is:
            // unset follows PS2X_GS_STATS, 0 never formats (the tags print empty), anything else always formats.
            // setupDrawState calls GsGlStateTags::enabled with ps2x::knobOn on the name; here the flag reads a planted value
            // by the same rule (ps2x::knobs::flagValue), so this pins the production decision, not a copy of it.
            const auto flag = [](const char *value) { return [value](bool dflt) { return ps2x::knobs::flagValue(value, dflt); }; };
            t.IsTrue(!GsGlStateTags::enabled(nullptr, flag(nullptr)), "no stats and no A/B knob: nothing is formatted per draw");
            t.IsTrue(GsGlStateTags::enabled("1", flag(nullptr)), "PS2X_GS_STATS=1, A/B knob unset: formatted, as the stats line prints them");
            t.IsTrue(GsGlStateTags::enabled("0", flag(nullptr)), "PS2X_GS_STATS is a Presence knob: any value, 0 too, prints the line");
            t.IsTrue(GsGlStateTags::enabled(nullptr, flag("1")), "PS2X_GS_SETUP_FORMAT=1 restores the per-draw formatting");
            t.IsTrue(GsGlStateTags::enabled("1", flag("1")), "both on: formatted");
            t.IsTrue(!GsGlStateTags::enabled("1", flag("0")), "PS2X_GS_SETUP_FORMAT=0 never formats, even under PS2X_GS_STATS (the A/B's new arm)");
            t.IsTrue(!GsGlStateTags::enabled("1", flag("off")), "off is 0, the one flag rule");
            t.IsTrue(!GsGlStateTags::enabled(nullptr, flag("0")), "0 without stats: not formatted");

            // The tags the stats line prints are the ones setupDrawState wrote before the move, byte for byte.
            std::string states;
            GsGlStateTags::noteState(states, 0x5000Dull | (1ull << 40), 0xFF000000u, 1u, true);
            t.Equals(states, std::string(" T5000d/Mff000000/tfx1t"), "the state tag: TEST's low 19 bits, FBMSK, TFX, t when textured");
            GsGlStateTags::noteState(states, 0x5000Dull, 0xFF000000u, 5u, true);
            t.Equals(states, std::string(" T5000d/Mff000000/tfx1t"), "a state already in the log is not appended twice (TFX is 2 bits)");
            GsGlStateTags::noteState(states, 0x30000ull, 0u, 0u, false);
            t.Equals(states, std::string(" T5000d/Mff000000/tfx1t T30000/M00000000/tfx0"), "a new state is appended; untextured has no t");
            std::string blends;
            GsGlStateTags::noteBlend(blends, 0x5d00000069ull);   // A=1 B=2 C=2 D=1, FIX 0x5d (research/31 section 12)
            t.Equals(blends, std::string(" A1B2C2D1/fix5d"), "the blend tag: the A, B, C, D selectors and FIX");
            GsGlStateTags::noteBlend(blends, 0x5d00000069ull);
            t.Equals(blends, std::string(" A1B2C2D1/fix5d"), "a blend already in the log is not appended twice");
            std::string fullStates(600u, 'x');
            GsGlStateTags::noteState(fullStates, 0x1ull, 0u, 0u, false);
            t.Equals(static_cast<int>(fullStates.size()), 600, "the state log stops growing at 600 characters");
            std::string fullBlends(400u, 'x');
            GsGlStateTags::noteBlend(fullBlends, 0x44ull);
            t.Equals(static_cast<int>(fullBlends.size()), 400, "the blend log stops growing at 400 characters");
        });

        tc.Run("S17 F1 attempt 3: a whole-block tile is swizzled once, by the recorder; the replay copies its blocks", [](TestCase &t)
        {
            // The double swizzle: GSGlBackend::UploadImage swizzled every tile into the game VRAM (m_cpu) on the EE
            // thread, then executeUpload swizzled the same bytes again into the shadow (m_shadow) on the GL thread. For
            // a transfer one call completes whose rectangle is whole 256-byte blocks of a format that owns its bytes,
            // the recorder now carries the blocks it swizzled (their addresses and bytes, taken under m_cpu's lock) and
            // the replay copies them into the shadow: swizzledByRecorder on the Upload command. The command carries the
            // bytes, not a pointer into m_cpu: the game thread runs frames ahead of the replay and may rewrite the same
            // blocks before the replay reaches this command. PS2X_GS_DOUBLE_SWIZZLE=1 restores the second swizzle (A/B).
            std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
            auto owned = std::make_unique<GSGlBackend>();
            GSGlBackend *gl = owned.get();
            GS gs;
            gs.setRasterBackend(std::move(owned));
            gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);
            gl->setDoubleSwizzleForTest(false);
            auto upload = [&](uint32_t dbp, uint32_t dbw, uint32_t psm, uint32_t x0, uint32_t y0, uint32_t w, uint32_t h,
                              const std::vector<uint8_t> &bytes)
            {
                const uint64_t bitblt = (static_cast<uint64_t>(dbp) << 32) | (static_cast<uint64_t>(dbw) << 48) |
                                        (static_cast<uint64_t>(psm) << 56);
                const uint64_t trxpos = (static_cast<uint64_t>(x0) << 32) | (static_cast<uint64_t>(y0) << 48);
                const uint64_t trxreg = static_cast<uint64_t>(w) | (static_cast<uint64_t>(h) << 32);
                std::vector<uint8_t> packet;
                appendU64(packet, makeGifTag(4u, GIF_FMT_PACKED, 1u, false));
                appendU64(packet, 0x0Eull);
                appendGifAd(packet, bitblt, GS_REG_BITBLTBUF);
                appendGifAd(packet, trxpos, GS_REG_TRXPOS);
                appendGifAd(packet, trxreg, GS_REG_TRXREG);
                appendGifAd(packet, 0ull, GS_REG_TRXDIR);
                appendU64(packet, makeGifTag(static_cast<uint16_t>(bytes.size() / 16u), GIF_FMT_IMAGE, 0u, true));
                appendU64(packet, 0ull);
                packet.insert(packet.end(), bytes.begin(), bytes.end());
                gs.processGIFPacket(packet.data(), static_cast<uint32_t>(packet.size()));
            };
            auto pattern = [](size_t n, uint32_t seed)
            {
                std::vector<uint8_t> out(n);
                for (size_t i = 0; i < n; ++i)
                    out[i] = static_cast<uint8_t>((i * 37u + seed * 101u + (i >> 8) * 11u) & 0xFFu);
                return out;
            };

            // 1. A 16x16 CT32 tile at (16, 8): four 8x8 blocks, swizzled by the recorder.
            constexpr uint32_t kDbp = 0x40u;
            std::vector<uint8_t> tile(16u * 16u * 4u);
            for (uint32_t y = 0; y < 16u; ++y)
                for (uint32_t x = 0; x < 16u; ++x)
                {
                    const uint32_t v = 0xA0000000u | (y << 8) | x;
                    std::memcpy(tile.data() + (y * 16u + x) * 4u, &v, 4u);
                }
            upload(kDbp, 1u, GS_PSM_CT32, 16u, 8u, 16u, 16u, tile);
            bool gameHolds = true;
            for (uint32_t y = 0; y < 16u; ++y)
                for (uint32_t x = 0; x < 16u; ++x)
                    gameHolds = gameHolds && GSMem::ReadCT32(vram.data(), kDbp, 1u, 16u + x, 8u + y) == (0xA0000000u | (y << 8) | x);
            t.IsTrue(gameHolds, "the game VRAM (GSCpuBackend) holds the tile, swizzled");
            std::vector<GSGlBackend::PendingUploadForTest> ups = gl->pendingUploadsForTest();
            t.Equals(static_cast<int>(ups.size()), 1, "one Upload command recorded");
            t.IsTrue(!ups.empty() && ups[0].swizzledByRecorder, "the Upload command says the recorder already swizzled it");
            t.Equals(static_cast<int>(ups.empty() ? 0u : ups[0].data.size()), 4 * (4 + 256),
                     "it carries four block addresses and the four swizzled blocks, no raw tile");
            if (!ups.empty() && ups[0].data.size() == 4u * 260u)
            {
                std::set<uint32_t> carried, expected;
                bool blocksAreTheGameVram = true;
                for (uint32_t i = 0; i < 4u; ++i)
                {
                    uint32_t addr = 0u;
                    std::memcpy(&addr, ups[0].data.data() + i * 4u, 4u);
                    carried.insert(addr);
                    blocksAreTheGameVram = blocksAreTheGameVram && addr + 256u <= vram.size() &&
                                           std::memcmp(ups[0].data.data() + 16u + i * 256u, vram.data() + addr, 256u) == 0;
                }
                for (uint32_t by = 0; by < 2u; ++by)
                    for (uint32_t bx = 0; bx < 2u; ++bx)
                    {
                        uint32_t block = 0u;
                        GsGlUploadReasons::blockOf(GS_PSM_CT32, kDbp, 1u, 16u + bx * 8u, 8u + by * 8u, block);
                        expected.insert(block * 256u);
                    }
                t.IsTrue(carried == expected, "the addresses are the tile's four blocks (the upload gate's block map agrees)");
                t.IsTrue(blocksAreTheGameVram, "each carried block is the game VRAM's swizzled block, byte for byte");
            }
            uint64_t swizzles = gl->replaySwizzlesForTest();
            gl->replayPendingForTest();
            t.Equals(gl->replaySwizzlesForTest() - swizzles, 0ull, "the replay does not swizzle the tile a second time");
            t.IsTrue(gl->shadowVramForTest() == vram, "the shadow VRAM equals the game VRAM after the replay");

            // 2. The other formats that own their bytes, one whole-block rectangle each: swizzled once, shadow equal.
            struct Shape { uint32_t psm, dbp, dbw, x0, y0, w, h, bytes; const char *name; };
            const Shape shapes[] = {
                {GS_PSM_CT16, 0x100u, 1u, 16u, 8u, 16u, 8u, 256u, "CT16 16x8"},
                {GS_PSM_CT16S, 0x140u, 1u, 0u, 16u, 32u, 8u, 512u, "CT16S 32x8"},
                {GS_PSM_T8, 0x180u, 2u, 16u, 16u, 16u, 16u, 256u, "T8 16x16"},
                {GS_PSM_T4, 0x200u, 2u, 32u, 16u, 32u, 16u, 256u, "T4 32x16"},
                {GS_PSM_Z16, 0x240u, 1u, 16u, 8u, 16u, 8u, 256u, "Z16 16x8"},
                // dbp 0x2C8 is block 8 of page 0x16, and (56,24)-(72,40) at FBW 2 crosses the 64x32 page corner:
                // the blocks land in four pages and past the base page's 32 blocks (the carry into the next page).
                {GS_PSM_CT32, 0x2C8u, 2u, 56u, 24u, 16u, 16u, 1024u, "CT32 16x16 across a page corner, dbp mid-page"},
            };
            uint32_t seed = 1u;
            for (const Shape &s : shapes)
            {
                upload(s.dbp, s.dbw, s.psm, s.x0, s.y0, s.w, s.h, pattern(s.bytes, seed++));
                ups = gl->pendingUploadsForTest();
                t.IsTrue(ups.size() == 1u && ups[0].swizzledByRecorder, std::string(s.name) + ": swizzled by the recorder");
                swizzles = gl->replaySwizzlesForTest();
                gl->replayPendingForTest();
                t.Equals(gl->replaySwizzlesForTest() - swizzles, 0ull, std::string(s.name) + ": no second swizzle");
                t.IsTrue(gl->shadowVramForTest() == vram, std::string(s.name) + ": the shadow equals the game VRAM");
            }

            // 2b. Two uploads to one rectangle before the replay ("CT32 16x16 twice before the replay"): each command carries
            //     its own bytes (a pointer into the game VRAM would hand the first command the second's pixels), and the
            //     second wins in the shadow as in the game VRAM.
            {
                const std::vector<uint8_t> first = pattern(1024u, seed++), second = pattern(1024u, seed++);
                upload(0x400u, 1u, GS_PSM_CT32, 0u, 0u, 16u, 16u, first);
                upload(0x400u, 1u, GS_PSM_CT32, 0u, 0u, 16u, 16u, second);
                ups = gl->pendingUploadsForTest();
                t.IsTrue(ups.size() == 2u && ups[0].swizzledByRecorder && ups[1].swizzledByRecorder,
                         "CT32 16x16 twice before the replay: two swizzled Upload commands");
                if (ups.size() == 2u && ups[0].data.size() == 4u * 260u && ups[1].data.size() == 4u * 260u)
                {
                    t.IsTrue(std::memcmp(ups[0].data.data(), ups[1].data.data(), 16u) == 0, "the same four blocks");
                    t.IsTrue(std::memcmp(ups[0].data.data() + 16u, ups[1].data.data() + 16u, 1024u) != 0,
                             "the first command still carries the first upload's bytes, not the second's");
                }
                swizzles = gl->replaySwizzlesForTest();
                gl->replayPendingForTest();
                t.Equals(gl->replaySwizzlesForTest() - swizzles, 0ull, "twice before the replay: no second swizzle");
                t.IsTrue(gl->shadowVramForTest() == vram, "twice before the replay: the shadow equals the game VRAM");
                std::vector<uint8_t> shadow = gl->shadowVramForTest();
                bool secondWins = true;
                for (uint32_t y = 0; y < 16u; ++y)
                    for (uint32_t x = 0; x < 16u; ++x)
                    {
                        uint32_t want = 0u;
                        std::memcpy(&want, second.data() + (y * 16u + x) * 4u, 4u);
                        secondWins = secondWins && GSMem::ReadCT32(shadow.data(), 0x400u, 1u, x, y) == want;
                    }
                t.IsTrue(secondWins, "the second upload's pixels are what the shadow holds");
            }

            // 3. Not whole blocks, or split over two calls, or CT24 (its alpha byte is not the transfer's): the old path.
            upload(0x300u, 1u, GS_PSM_CT32, 0u, 0u, 16u, 4u, pattern(16u * 4u * 4u, seed++));      // 4 rows of an 8-row block
            upload(0x340u, 1u, GS_PSM_CT24, 0u, 0u, 16u, 16u, pattern(16u * 16u * 3u, seed++));    // CT24
            {
                const std::vector<uint8_t> whole = pattern(16u * 16u * 4u, seed++);
                const std::vector<uint8_t> firstHalf(whole.begin(), whole.begin() + 512), secondHalf(whole.begin() + 512, whole.end());
                const uint64_t bitblt = (0x380ull << 32) | (1ull << 48) | (static_cast<uint64_t>(GS_PSM_CT32) << 56);
                std::vector<uint8_t> packet;
                appendU64(packet, makeGifTag(4u, GIF_FMT_PACKED, 1u, false));
                appendU64(packet, 0x0Eull);
                appendGifAd(packet, bitblt, GS_REG_BITBLTBUF);
                appendGifAd(packet, 0ull, GS_REG_TRXPOS);
                appendGifAd(packet, 16ull | (16ull << 32), GS_REG_TRXREG);
                appendGifAd(packet, 0ull, GS_REG_TRXDIR);
                appendU64(packet, makeGifTag(32u, GIF_FMT_IMAGE, 0u, false));
                appendU64(packet, 0ull);
                packet.insert(packet.end(), firstHalf.begin(), firstHalf.end());
                appendU64(packet, makeGifTag(32u, GIF_FMT_IMAGE, 0u, true));
                appendU64(packet, 0ull);
                packet.insert(packet.end(), secondHalf.begin(), secondHalf.end());
                gs.processGIFPacket(packet.data(), static_cast<uint32_t>(packet.size()));   // two IMAGE tags: two calls
            }
            ups = gl->pendingUploadsForTest();
            int raw = 0;
            for (const GSGlBackend::PendingUploadForTest &u : ups)
                raw += u.swizzledByRecorder ? 0 : 1;
            t.Equals(raw, static_cast<int>(ups.size()), "a partial block, CT24 and a split transfer are recorded raw");
            t.IsTrue(ups.size() >= 4u, "and all four chunks were recorded");
            swizzles = gl->replaySwizzlesForTest();
            gl->replayPendingForTest();
            t.Equals(gl->replaySwizzlesForTest() - swizzles, static_cast<unsigned long long>(ups.size()),
                     "the replay swizzles each raw chunk itself");
            t.IsTrue(gl->shadowVramForTest() == vram, "the shadow equals the game VRAM after the raw chunks");

            // 4. The A/B: PS2X_GS_DOUBLE_SWIZZLE=1 records the raw tile and the replay swizzles it again, same result.
            gl->setDoubleSwizzleForTest(true);
            upload(kDbp, 1u, GS_PSM_CT32, 32u, 8u, 16u, 16u, pattern(16u * 16u * 4u, seed++));
            ups = gl->pendingUploadsForTest();
            t.IsTrue(ups.size() == 1u && !ups[0].swizzledByRecorder && ups[0].data.size() == 1024u,
                     "PS2X_GS_DOUBLE_SWIZZLE=1: the raw tile is recorded, not swizzled blocks");
            swizzles = gl->replaySwizzlesForTest();
            gl->replayPendingForTest();
            t.Equals(gl->replaySwizzlesForTest() - swizzles, 1ull, "and the replay swizzles it a second time, as before attempt 3");
            t.IsTrue(gl->shadowVramForTest() == vram, "with the same shadow");
        });

        tc.Run("R123: mix and seed are order-sensitive so row order is part of the identity", [](TestCase &t)
        {
            const uint64_t a = GsGlTextureIdentity::mix(GsGlTextureIdentity::mix(GsGlTextureIdentity::seed(), 1u), 2u);
            const uint64_t b = GsGlTextureIdentity::mix(GsGlTextureIdentity::mix(GsGlTextureIdentity::seed(), 2u), 1u);
            t.IsTrue(a != b, "the same values in a different order hash differently");
            t.IsTrue(GsGlTextureIdentity::seed() != 0u, "the seed is not the sentinel");
        });

        tc.Run("R123: the trace carries revalidations beside decodes", [](TestCase &t)
        {
            // (1): a texture whose generation moved but whose source bytes did not is revalidated
            // instead of deleted and re-decoded. The line has to show both or the A/B says nothing.
            GsGlUploadTrace::Accum a;
            for (int i = 0; i < 500; ++i)
                GsGlUploadTrace::noteRevalidate(a, 12.0);
            for (int i = 0; i < 20; ++i)
                GsGlUploadTrace::noteDecode(a, true);
            t.Equals(static_cast<int>(a.revalidated), 500, "500 revalidations");
            t.Equals(static_cast<int>(a.decodes), 20, "20 decodes still happened");
            const std::string line = GsGlUploadTrace::format(a, 1000.0);
            t.IsTrue(line.find("revalidated=500/s") != std::string::npos, "revalidations per second");
            t.IsTrue(line.find("revalidate_us=12.0") != std::string::npos, "and the cost of one");
        });

        // --- Sprint 13 V2 (#32): why each upload happened, and the one that need not ---
        //
        // gs_gl_upload_reasons.h is the Gate executeUpload runs (with PS2X_GS_STATS or
        // PS2X_GS_UPLOAD_SKIP set): the reasons line's counters and the skip decision both come
        // from Gate::decide, so these cases drive the backend's own code without a GL context.

        tc.Run("V2: blocksOf names the 256-byte blocks a rectangle writes, and nothing for a Z format", [](TestCase &t)
        {
            std::vector<uint32_t> blocks;
            GsGlUploadReasons::blocksOf(GS_PSM_CT32, 0x0c0u, 10u, 0u, 0u, 16u, 16u, blocks);
            t.IsTrue(blocks == std::vector<uint32_t>({0x0c0u, 0x0c1u, 0x0c2u, 0x0c3u}),
                     "a 16x16 PSMCT32 tile at (0,0) of dbp 0xc0 is the four 8x8 blocks 0xc0..0xc3");
            std::vector<uint32_t> beside;
            GsGlUploadReasons::blocksOf(GS_PSM_CT32, 0x0c0u, 10u, 16u, 0u, 16u, 16u, beside);
            t.IsTrue(beside == std::vector<uint32_t>({0x0c4u, 0x0c5u, 0x0c6u, 0x0c7u}),
                     "the tile beside it is in the same page and writes other blocks");
            std::vector<uint32_t> frame;
            GsGlUploadReasons::blocksOf(GS_PSM_CT32, 0u, 10u, 0u, 0u, 640u, 448u, frame);
            t.Equals(frame.size(), static_cast<size_t>(10u * 14u * 32u), "a 640x448 frame is 140 whole pages: every block visited");
            std::vector<uint32_t> nibbles;
            GsGlUploadReasons::blocksOf(GS_PSM_T4, 0x0c0u, 10u, 0u, 0u, 16u, 16u, nibbles);
            t.IsTrue(nibbles == std::vector<uint32_t>({0x0c0u}), "a 16x16 PSMT4 tile lies in one 32x16 block");
            GsGlUploadReasons::blocksOf(GS_PSM_Z32, 0x0c0u, 10u, 0u, 0u, 16u, 16u, blocks);
            t.IsTrue(blocks.empty(), "a Z format has no block map here: it is never a skip candidate");
        });

        tc.Run("V2: the reason counters name every branch of a synthetic upload sequence", [](TestCase &t)
        {
            using R = GsGlUploadReasons::Reason;
            using X = GsGlUploadReasons::Tex;
            auto gateOwner = std::make_unique<GsGlUploadReasons::Gate>();   // 132 KB of generations: not on the stack
            GsGlUploadReasons::Gate &gate = *gateOwner;
            const GsGlUploadIdentity::Key tile{0x0c0u, 10u, 0u, 0u, 16u, 16u, GS_PSM_CT32};
            const GsGlUploadIdentity::Key beside{0x0c0u, 10u, 16u, 0u, 16u, 16u, GS_PSM_CT32};
            std::vector<uint32_t> tileBlocks, besideBlocks;
            GsGlUploadReasons::blocksOf(GS_PSM_CT32, 0x0c0u, 10u, 0u, 0u, 16u, 16u, tileBlocks);
            GsGlUploadReasons::blocksOf(GS_PSM_CT32, 0x0c0u, 10u, 16u, 0u, 16u, 16u, besideBlocks);
            const std::vector<uint8_t> a(1024u, 0x11u), b(1024u, 0x22u);
            auto up = [&](const GsGlUploadIdentity::Key &k, const std::vector<uint8_t> &bytes,
                          const std::vector<uint32_t> &blocks, bool whole, bool underGpu)
            {
                return gate.decide(k, bytes.data(), bytes.size(), whole, blocks, 6u, 1u, 10u, underGpu, false).reason;
            };
            t.IsTrue(up(tile, a, tileBlocks, true, false) == R::New, "the first upload of a rectangle is new");
            t.IsTrue(up(tile, a, tileBlocks, true, false) == R::SameFree, "the same bytes again, nothing between: same_free");
            t.IsTrue(up(beside, b, besideBlocks, true, false) == R::New, "a sibling tile in the same page is its own rectangle");
            t.IsTrue(up(tile, a, tileBlocks, true, false) == R::SameFree,
                     "and does not disturb this one (other blocks) -- R118's page guard refused exactly this");
            t.IsTrue(up(tile, b, tileBlocks, true, false) == R::Changed, "different bytes: changed");
            gate.noteForeignWrite(6u, 1u);
            t.IsTrue(up(tile, b, tileBlocks, true, false) == R::SameRewritten,
                     "the same bytes after a VRAM write or a download into its page: same_rewritten");
            t.IsTrue(up(tile, b, tileBlocks, true, true) == R::SameUnderGpu, "GPU-drawn rows over it: same_gpu");
            t.IsTrue(up(tile, b, tileBlocks, false, false) == R::Chunked, "one packet of a split rectangle: chunked");
            for (int i = 0; i < 3; ++i)
                gate.noteTex(X::Hit);
            gate.noteTex(X::RtDirect);
            gate.noteTex(X::Revalidated);
            gate.noteTex(X::Revalidated);
            gate.noteTex(X::Redecoded);
            gate.noteTex(X::New);
            const GsGlUploadReasons::Tally tally = gate.take();
            t.Equals(tally.uploads[static_cast<size_t>(R::New)], static_cast<uint64_t>(2), "two new");
            t.Equals(tally.uploads[static_cast<size_t>(R::SameFree)], static_cast<uint64_t>(2), "two same_free");
            t.Equals(tally.uploads[static_cast<size_t>(R::Changed)], static_cast<uint64_t>(1), "one changed");
            t.Equals(tally.uploads[static_cast<size_t>(R::SameRewritten)], static_cast<uint64_t>(1), "one same_rewritten");
            t.Equals(tally.uploads[static_cast<size_t>(R::SameUnderGpu)], static_cast<uint64_t>(1), "one same_gpu");
            t.Equals(tally.uploads[static_cast<size_t>(R::Chunked)], static_cast<uint64_t>(1), "one chunked");
            t.Equals(tally.skipped, static_cast<uint64_t>(0), "with the knob off nothing is skipped, only counted");
            const std::string line = GsGlUploadReasons::format(tally, false);
            t.IsTrue(line.find("[gs-gl stats] reasons uploads: chunked=1 new=2 changed=1 same_rewritten=1 same_gpu=1 same_free=2 skipped=0 skip=off") == 0,
                     "the reasons line, uploads half: " + line);
            t.IsTrue(line.find("textures: hit=3 rt=1 revalidated=2 redecoded=1 new=1") != std::string::npos,
                     "the reasons line, texture half: " + line);
            t.Equals(gate.take().uploads[static_cast<size_t>(R::New)], static_cast<uint64_t>(0), "take() starts the next interval at zero");
        });

        tc.Run("V2 (#32): a 16x16 tile uploaded twice with the same bytes uploads once", [](TestCase &t)
        {
            // Before V2, executeUpload had no branch that could decline: every Upload command swizzled
            // into the shadow, bumped the page generation of the whole base..span range and marked a
            // dirty rectangle on every target over it, so the same bytes twice were two uploads. The
            // only identical-bytes check was PS2X_GS_UPLOAD_TRACE's identical= counter, which counts.
            auto gateOwner = std::make_unique<GsGlUploadReasons::Gate>();   // 132 KB of generations: not on the stack
            GsGlUploadReasons::Gate &gate = *gateOwner;
            const GsGlUploadIdentity::Key tile{0x0c0u, 10u, 0u, 0u, 16u, 16u, GS_PSM_CT32};
            std::vector<uint32_t> blocks;
            GsGlUploadReasons::blocksOf(GS_PSM_CT32, 0x0c0u, 10u, 0u, 0u, 16u, 16u, blocks);
            const std::vector<uint8_t> a(1024u, 0x5Au), b(1024u, 0xA5u);
            int performed = 0;
            auto upload = [&](const std::vector<uint8_t> &bytes, bool underGpu)
            {
                if (!gate.decide(tile, bytes.data(), bytes.size(), true, blocks, 6u, 1u, 10u, underGpu, true).skip)
                    ++performed;
            };
            upload(a, false);
            upload(a, false);
            t.Equals(performed, 1, "the same 16x16 tile twice with nothing between: ONE upload");
            t.Equals(gate.tally().skipped, static_cast<uint64_t>(1), "and the reasons line says skipped=1");

            // Never where the bytes may not already be everywhere:
            upload(b, false);
            t.Equals(performed, 2, "different bytes upload");
            upload(b, true);
            t.Equals(performed, 3, "under GPU-drawn rows it uploads: the GPU may have drawn over the tile");
            const GsGlUploadIdentity::Key overlap{0x0c0u, 10u, 8u, 8u, 8u, 8u, GS_PSM_CT32};
            std::vector<uint32_t> overlapBlocks;
            GsGlUploadReasons::blocksOf(GS_PSM_CT32, 0x0c0u, 10u, 8u, 8u, 8u, 8u, overlapBlocks);
            const std::vector<uint8_t> c(256u, 0x33u);
            gate.decide(overlap, c.data(), c.size(), true, overlapBlocks, 6u, 1u, 10u, false, true);
            upload(b, false);
            t.Equals(performed, 4, "an upload into one of its blocks since: it uploads");
            upload(b, false);
            t.Equals(performed, 4, "and once it is back, the next identical one is skipped again");
            gate.noteTargetsChanged();
            upload(b, false);
            t.Equals(performed, 5, "a render target created or grown since: it uploads");
            gate.noteForeignWrite(6u, 1u);
            upload(b, false);
            t.Equals(performed, 6, "a VRAM write, local copy or download into its page since: it uploads");
            t.IsFalse(gate.decide(tile, b.data(), b.size(), false, blocks, 6u, 1u, 10u, false, true).skip,
                      "one packet of a split rectangle is never skipped");
            t.IsFalse(gate.decide(tile, b.data(), b.size(), true, blocks, 6u, 1u, 10u, false, false).skip,
                      "with PS2X_GS_UPLOAD_SKIP off the gate only counts");
            gate.reset();
            t.IsFalse(gate.decide(tile, b.data(), b.size(), true, blocks, 6u, 1u, 10u, false, true).skip,
                      "a GS reset forgets every remembered upload");
        });

        tc.Run("V2 review: a page-granular write at an unaligned dbp stamps the page row it spills into", [](TestCase &t)
        {
            // pageSpan counts from the base page; a copy to dbp 0xc8 (page 6, block 8) with one page
            // row of height reaches into page 7. The tile remembered in page 7 must not be skipped.
            using R = GsGlUploadReasons::Reason;
            t.Equals(GsGlUploadReasons::stampSpan(0x0c0u, 1u, 1u), 1u, "an aligned dbp stamps its span");
            t.Equals(GsGlUploadReasons::stampSpan(0x0c8u, 1u, 1u), 2u, "an unaligned dbp stamps one more page row");
            t.Equals(GsGlUploadReasons::stampSpan(0x0c8u, 10u, 10u), 20u, "a page row is dbw pages wide");
            auto gateOwner = std::make_unique<GsGlUploadReasons::Gate>();
            GsGlUploadReasons::Gate &gate = *gateOwner;
            const GsGlUploadIdentity::Key tile{0x0e0u, 1u, 0u, 0u, 16u, 16u, GS_PSM_CT32};
            std::vector<uint32_t> blocks;
            GsGlUploadReasons::blocksOf(GS_PSM_CT32, 0x0e0u, 1u, 0u, 0u, 16u, 16u, blocks);
            const std::vector<uint8_t> a(1024u, 0x77u);
            auto up = [&]() { return gate.decide(tile, a.data(), a.size(), true, blocks, 7u, 1u, 1u, false, false).reason; };
            up();
            gate.noteForeignWrite(6u, GsGlUploadReasons::stampSpan(0x0c0u, 1u, 1u));
            t.IsTrue(up() == R::SameFree, "an aligned copy into page 6 leaves page 7's tile valid");
            gate.noteForeignWrite(6u, GsGlUploadReasons::stampSpan(0x0c8u, 1u, 1u));
            t.IsTrue(up() == R::SameRewritten, "an unaligned copy into page 6 spills into page 7: same_rewritten");
            // decide's own fallback (a Z-format upload has no block map) widens the same way.
            const GsGlUploadIdentity::Key z{0x0c8u, 1u, 0u, 0u, 16u, 16u, GS_PSM_Z32};
            const std::vector<uint32_t> none;
            up();
            t.IsTrue(up() == R::SameFree, "valid again after its re-upload");
            gate.decide(z, a.data(), a.size(), true, none, 6u, 1u, 1u, false, false);
            t.IsTrue(up() == R::SameRewritten, "a Z-format upload at an unaligned dbp in page 6 stamps page 7 too");
        });

        // Sprint 17 F0: the present-interval histogram -- [gs-gl stats] frames line. The fps column
        // is a 60-call mean; this is the distribution of the time between two presents, so a 2.5 s
        // freeze shows in over= and longest_ms instead of vanishing into a mean. Header-only.
        tc.Run("F0: GsFrameHistogram buckets present intervals by edge, keeps the longest, and never drops one past the last edge", [](TestCase &t)
        {
            GsFrameHistogram h{};
            for (int i = 0; i < 3; ++i)
                h.add(16'000'000ull);   // 16.0 ms: le17
            h.add(40'000'000ull);       // 40 ms: le50
            h.add(2'500'000'000ull);    // 2.5 s: over, and the longest
            t.Equals(h.n, 5ull, "five intervals");
            t.Equals(h.counts[0], 3ull, "three at or under 17 ms");
            t.Equals(h.counts[4], 1ull, "one in (33, 50]");
            t.Equals(h.counts[6], 1ull, "one over 100 ms lands in the open bucket, never wraps");
            t.Equals(h.longestNs, 2'500'000'000ull, "the longest is kept");
            const std::string line = h.line();
            t.IsTrue(line.find("le17=3 ") != std::string::npos && line.find("over=1 ") != std::string::npos &&
                         line.find("longest_ms=2500.0") != std::string::npos,
                     line);
        });

        // Sprint 16 F2: the [gs-submit] line -- the submit= column of [gs-gl stats] split over EVERY
        // flush that drew (the [gs-transfer] phases see only the flush a transfer interrupted), and
        // the GPU->shadow read-back inside resolveTexture counted as work. Header-only arithmetic.
        tc.Run("GsGlUploadTrace [gs-submit] reports the submit split in ms/s and the read-back as work per second", [](TestCase &t)
        {
            GsGlUploadTrace::Accum a;
            for (int i = 0; i < 100; ++i)
                GsGlUploadTrace::noteSubmitFlush(a, 30.0, 10.0, 200.0, 60.0);   // 300 us a flush
            GsGlUploadTrace::noteReadback(a, 448u, 640ull * 448ull, 5000.0);
            GsGlUploadTrace::noteReadback(a, 224u, 640ull * 224ull, 3000.0);
            GsGlUploadTrace::noteRtDirect(a);
            t.Equals(a.submitFlushes, 100ull, "every flush that drew is counted");
            t.Equals(a.readbacks, 2ull, "every read-back is counted");
            t.Equals(a.readbackRows, 672ull, "the rows the read-backs wrote add up");
            t.Equals(a.readbackPixels, 430080ull, "the pixels the driver copied add up");
            const std::string line = GsGlUploadTrace::formatSubmit(a, 1000.0);
            t.IsTrue(line.rfind("[gs-submit] elapsed=1000ms flushes=100/s", 0) == 0, "the line is tagged [gs-submit] and counts flushes per second: " + line);
            t.IsTrue(line.find(" setup=3.0ms/s dirty_rows=1.0ms/s resolve=20.0ms/s draw=6.0ms/s") != std::string::npos,
                     "the four phases are milliseconds per second, the unit submit= is read in: " + line);
            t.IsTrue(line.find(" readback=8.0ms/s readbacks=2.0/s readback_rows=672/s readback_px=430080/s rt_direct=1.0/s") != std::string::npos,
                     "the read-back is time AND work, per second: " + line);
            const std::string half = GsGlUploadTrace::formatSubmit(a, 500.0);
            t.IsTrue(half.find(" flushes=200/s") != std::string::npos && half.find(" readbacks=4.0/s") != std::string::npos &&
                         half.find(" resolve=40.0ms/s") != std::string::npos,
                     "half the interval doubles every rate: " + half);
        });

        // Sprint 16 F2, the planted scene (the GL half: PS2X_CONSOLE_REPLAY_GL=1, a hidden raylib window
        // like the console replay's, none in CI). The frame's post-process copy in the game's own shape
        // (research/31 section 12, the dump's packet 1389): a 640x448 CT32 frame (FBW 10, scissor to 447,
        // so GsGlTarget::choose sizes the target 640x448) copied by an FST sprite -- TEX0 at the frame's
        // base, TBW 10, TW=10 TH=10, REPEAT/REPEAT, bilinear -- at half size into a FBW 5 target. A
        // 640x448 buffer can only be declared with a power-of-two envelope larger than itself; the
        // RT-as-texture fast path (PS2X_GS_RT_TEXTURE, 1c301b9b) refused that envelope once Sprint 7
        // Task 1c (6ea95204) shrank targets to their use, and every such draw fell back to
        // downloadRenderTargetToShadow -- a whole-target glReadPixels behind a GPU drain, once a frame
        // in the mission (research/73 section 1; the Sprint 16 plan's Log, F2 Step 1). Red before F2's
        // change (readbacks 1, rt_direct 0), green after (0, 1). The frame is two colours so the copy
        // is checked as a picture, not a flat fill: a read from the wrong place (the review caught a
        // page passed as a block) lands in the other colour. The third draw textures from a TBP0 eight
        // blocks inside the frame's first page: not a target's origin, so the fast path must refuse
        // it and the read-back path decode it from its true block (the F2 review's item 4).
        tc.Run("F2: a 640x448 target sampled through its TW=10 TH=10 REPEAT bilinear TEX0 is served from the target, not read back; a mid-page TBP0 is not (PS2X_CONSOLE_REPLAY_GL=1)", [](TestCase &t)
        {
            if (std::getenv("PS2X_CONSOLE_REPLAY_GL") == nullptr)
            {
                t.Skip("PS2X_CONSOLE_REPLAY_GL unset: the GL half needs a hidden raylib window (none in CI)");
                return;
            }
            auto setBackend = [](const char *which)
            {
#ifdef _WIN32
                _putenv_s("PS2X_GS_BACKEND", which);
#else
                setenv("PS2X_GS_BACKEND", which, 1);
#endif
            };
            setBackend("gpu");
            SetConfigFlags(FLAG_WINDOW_HIDDEN);
            InitWindow(640, 448, "f2 read-back");
            if (!IsWindowReady())
            {
                setBackend("cpu");
                t.Skip("raylib could not open a hidden window on this host");
                return;
            }
            constexpr uint32_t kFrameFbp = 0u;      // pages 0..139: FBW 10, 448 rows
            constexpr uint32_t kCopyFbp = 0x150u;   // page 336, past the 320 pages a TW=10 TH=10 texture at page 0 spans
            constexpr uint32_t kCopy2Fbp = 0x170u;  // page 368, the mid-page draw's target
            constexpr uint32_t kA = 0x80204080u;    // RGBAQ bytes R=0x80 G=0x40 B=0x20 A=0x80: the frame's bottom-right quadrant
            constexpr uint32_t kB = 0x80C08010u;    // R=0x10 G=0x80 B=0xC0 A=0x80: the rest of the frame
            uint64_t readbacks = 0u, rtDirect = 0u, readbacksMidPage = 0u, rtDirectMidPage = 0u;
            uint32_t copiedBottomRight = 0u, copiedTopLeft = 0u, frameBottomRight = 0u, frameTopLeft = 0u, pageAsBlock = 0u;
            bool glUnavailable = false;
            {
                std::vector<uint8_t> vram(PS2_GS_VRAM_SIZE, 0u);
                GS gs;
                gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);
                auto frameReg = [](uint32_t fbp, uint32_t fbw) { return static_cast<uint64_t>(fbp) | (static_cast<uint64_t>(fbw) << 16) | (static_cast<uint64_t>(GS_PSM_CT32) << 24); };
                auto scissor = [](uint32_t x1, uint32_t y1) { return (static_cast<uint64_t>(x1) << 16) | (static_cast<uint64_t>(y1) << 48); };
                auto xyz = [](uint32_t x, uint32_t y) { return static_cast<uint64_t>(x * 16u) | (static_cast<uint64_t>(y * 16u) << 16); };
                auto uv = [](uint32_t u, uint32_t v) { return static_cast<uint64_t>(u * 16u) | (static_cast<uint64_t>(v * 16u) << 16); };
                // TEX0: TBW 10, CT32, TW 10, TH 10, TCC, TFX decal -- the copy's, at a given block pointer.
                auto tex0At = [](uint32_t tbp0) { return static_cast<uint64_t>(tbp0) | (10ull << 14) | (static_cast<uint64_t>(GS_PSM_CT32) << 20) |
                                                         (10ull << 26) | (10ull << 30) | (1ull << 34) | (1ull << 35); };
                auto flatSprite = [&](uint32_t color, uint32_t x0, uint32_t y0, uint32_t x1, uint32_t y1)
                {
                    gs.writeRegister(GS_REG_PRIM, static_cast<uint64_t>(GS_PRIM_SPRITE));
                    gs.writeRegister(GS_REG_RGBAQ, color);
                    gs.writeRegister(GS_REG_XYZ2, xyz(x0, y0));
                    gs.writeRegister(GS_REG_XYZ2, xyz(x1, y1));
                };
                auto copySprite = [&]()   // FST, TME: the frame's 0,0-640,448 onto 0,0-320,224
                {
                    gs.writeRegister(GS_REG_PRIM, static_cast<uint64_t>(GS_PRIM_SPRITE) | (1ull << 4) | (1ull << 8));
                    gs.writeRegister(GS_REG_UV, uv(0u, 0u));
                    gs.writeRegister(GS_REG_XYZ2, xyz(0u, 0u));
                    gs.writeRegister(GS_REG_UV, uv(640u, 448u));
                    gs.writeRegister(GS_REG_XYZ2, xyz(320u, 224u));
                };
                // 1. The frame: B over all of it, A over the bottom-right quadrant.
                gs.writeRegister(GS_REG_FRAME_1, frameReg(kFrameFbp, 10u));
                gs.writeRegister(GS_REG_ZBUF_1, 0x1c0ull | (1ull << 32));   // ZBP past every target, ZMSK
                gs.writeRegister(GS_REG_SCISSOR_1, scissor(639u, 447u));
                gs.writeRegister(GS_REG_XYOFFSET_1, 0ull);
                gs.writeRegister(GS_REG_TEST_1, 0x30000ull);   // ZTE on, ZTST ALWAYS
                flatSprite(kB, 0u, 0u, 640u, 448u);
                flatSprite(kA, 320u, 224u, 640u, 448u);
                // 2. The copy, the game's shape: REPEAT/REPEAT (CLAMP 0), bilinear (TEX1 MMAG), into a FBW 5 target.
                gs.writeRegister(GS_REG_FRAME_1, frameReg(kCopyFbp, 5u));
                gs.writeRegister(GS_REG_SCISSOR_1, scissor(319u, 223u));
                gs.writeRegister(GS_REG_TEX0_1, tex0At(kFrameFbp << 5));
                gs.writeRegister(GS_REG_CLAMP_1, 0ull);
                gs.writeRegister(GS_REG_TEX1_1, 1ull << 5);
                copySprite();
                const GsGlUploadTrace::Accum before = GsGlUploadTrace::live();
                gs.hostRenderFrame();   // this thread replays: the frame's two sprites, then the copy resolves its texture
                glUnavailable = GSGlBackend::glUnavailableForProcess();
                {
                    const GsGlUploadTrace::Accum &after = GsGlUploadTrace::live();
                    readbacks = after.readbacks - before.readbacks;
                    rtDirect = after.rtDirect - before.rtDirect;
                }
                // 3. The same copy from TBP0 = the frame's base + 8 blocks, into a third target. The frame is still
                //    stale (nothing read it back), so the one path or the other must serve this draw.
                gs.writeRegister(GS_REG_FRAME_1, frameReg(kCopy2Fbp, 5u));
                gs.writeRegister(GS_REG_TEX0_1, tex0At((kFrameFbp << 5) + 8u));
                copySprite();
                const GsGlUploadTrace::Accum beforeMid = GsGlUploadTrace::live();
                gs.hostRenderFrame();
                {
                    const GsGlUploadTrace::Accum &after = GsGlUploadTrace::live();
                    readbacksMidPage = after.readbacks - beforeMid.readbacks;
                    rtDirectMidPage = after.rtDirect - beforeMid.rtDirect;
                }
                // 4. The frame drawn once more, the same two sprites. The third draw's read-back put the frame into the
                //    SHADOW and cleared its GPU-row window (downloadRenderTargetToShadow, `rt.gpuRows = false`), and the
                //    guest-visible read-back below copies only that window into the game's VRAM
                //    (downloadRenderTargetToCpu: yEnd = gpuRows ? ... : 0) -- read then, the frame's own pixels were 0
                //    (the F2 review's C++ proof, 21:52Z). Re-drawing re-arms the window over the whole frame; the
                //    picture is unchanged.
                gs.writeRegister(GS_REG_FRAME_1, frameReg(kFrameFbp, 10u));
                gs.writeRegister(GS_REG_SCISSOR_1, scissor(639u, 447u));
                flatSprite(kB, 0u, 0u, 640u, 448u);
                flatSprite(kA, 320u, 224u, 640u, 448u);
                gs.hostRenderFrame();
                // The pictures, through the guest-visible read-back (Sync(DebugReadback) + SnapshotVram, as the console
                // replay reads its frame). fbp is a PAGE here: the Frame helper converts it to the block the layout wants.
                gs.refreshDisplaySnapshot();
                uint32_t snapSize = 0u;
                const uint8_t *snap = gs.lockDisplaySnapshot(snapSize);
                if (snap && snapSize >= vram.size())
                    std::memcpy(vram.data(), snap, vram.size());
                gs.unlockDisplaySnapshot();
                frameBottomRight = readReferenceFramePSMCT32Pixel(vram, kFrameFbp, 10u, 400u, 300u);
                frameTopLeft = readReferenceFramePSMCT32Pixel(vram, kFrameFbp, 10u, 100u, 100u);
                copiedBottomRight = readReferenceFramePSMCT32Pixel(vram, kCopyFbp, 5u, 200u, 150u);   // samples frame (401, 301)
                copiedTopLeft = readReferenceFramePSMCT32Pixel(vram, kCopyFbp, 5u, 50u, 50u);          // samples frame (101, 101)
                // The read the review caught: the page handed to the block-pointer helper. Block 0x150 is page 10 +
                // block 16, so (200,150) at bw 5 resolves to page 33 block 25 -- frame pixels (232..239, 112..119), B.
                pageAsBlock = readReferencePSMCT32Pixel(vram, kCopyFbp, 5u, 200u, 150u);
            }
            CloseWindow();
            setBackend("cpu");
            if (glUnavailable)
            {
                t.Skip("the GL backend latched unavailable on this host (no OpenGL 3.3)");
                return;
            }
            // The reads and the counts, always (the F2 review asked for the coordinates and values on a failure).
            std::printf("f2 planted scene: frame(400,300)=%08x frame(100,100)=%08x copy(200,150)=%08x copy(50,50)=%08x"
                        " page-as-block(0x%x,bw5,200,150)=%08x [A=%08x B=%08x] copy: readbacks=%llu rt_direct=%llu"
                        " mid-page TBP0: readbacks=%llu rt_direct=%llu\n",
                        frameBottomRight, frameTopLeft, copiedBottomRight, copiedTopLeft, kCopyFbp, pageAsBlock, kA, kB,
                        (unsigned long long)readbacks, (unsigned long long)rtDirect,
                        (unsigned long long)readbacksMidPage, (unsigned long long)rtDirectMidPage);
            t.Equals(frameBottomRight, kA, "the frame's bottom-right quadrant is A");
            t.Equals(frameTopLeft, kB, "the rest of the frame is B");
            t.Equals(copiedBottomRight, kA, "the copy's bottom-right quadrant is the frame's: A, whichever path served the texture");
            t.Equals(copiedTopLeft, kB, "the copy's top-left quadrant is the frame's: B");
            t.Equals(pageAsBlock, kB, "the page-as-block read lands in the frame's top-left quadrant (B), not in the copy: the check can fail");
            t.Equals(readbacks, 0ull, "no GPU->shadow read-back: the frame is sampled from its own target");
            t.Equals(rtDirect, 1ull, "the copy's one resolve was served from the target");
            t.Equals(rtDirectMidPage, 0ull, "a texture starting eight blocks inside the target's first page is not served from the target");
            t.Equals(readbacksMidPage, 1ull, "... it is read back and decoded from its true block, as before");
        });

    });
}
