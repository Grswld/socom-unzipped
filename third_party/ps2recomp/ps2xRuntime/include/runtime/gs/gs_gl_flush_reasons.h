#pragma once
// macOS performance work, step 1: why each GL draw batch ended.
//
// executeSubmit appends a primitive to the open batch while its DrawKey equals the batch's, and flushes (one
// glDrawArrays) the moment any field differs; every command that is not a draw flushes too. A mission issues
// ~10,000 batches a frame, and Apple's GL-on-Metal driver charges heavily per draw (the spike of 2026-10-02:
// 42-49 % of the render thread). Counting which field ended each batch -- and how many vertices those batches
// carried -- says which merges would pay. PipelineSet counts the distinct pipeline states a session meets: the
// combinations Apple's driver builds a Metal pipeline for, and the size a Metal backend's pipeline cache needs.
// Header-only, no GL: ps2x_tests drives it directly (gs_gl_flush_reasons_tests.cpp).
#include "runtime/gs/gs_state_equal.h"
#include "runtime/gs/gs_types.h"

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace GsGlFlushReasons
{
    // What a batch shares: a primitive joins the open batch only when every field matches (gs_gl_backend.cpp,
    // executeSubmit). Zero-initialised before it is filled, so the padding between members compares equal.
    struct DrawKey
    {
        GSContext context{};
        GSPrimReg prim{};
        GSTexaReg texa{};
        GSTexClutReg texclut{};
        bool pabe = false;
        bool linearFilter = false;
        uint16_t textureWidth = 0, textureHeight = 0;
        uint8_t fogR = 0, fogG = 0, fogB = 0;
    };

    // One bit per DrawKey field (GSContext split into its registers). kPadding: the keys' bytes differ but no
    // value does -- the register structs carry padding (GSFrameReg: 16 bytes for 4 fields) that a value-
    // initialised key does not zero, and executeSubmit's whole-key memcmp ends a batch on it.
    constexpr uint32_t kFrame = 1u << 0, kScissor = 1u << 1, kTex0 = 1u << 2, kXyOffset = 1u << 3,
                       kZbuf = 1u << 4, kTex1 = 1u << 5, kMip = 1u << 6, kClamp = 1u << 7, kAlpha = 1u << 8,
                       kTest = 1u << 9, kFba = 1u << 10, kClutId = 1u << 11, kPrim = 1u << 12, kTexa = 1u << 13,
                       kTexClut = 1u << 14, kPabe = 1u << 15, kFilter = 1u << 16, kTexSize = 1u << 17,
                       kFog = 1u << 18, kPadding = 1u << 19;
    constexpr int kFields = 20;
    constexpr const char *kFieldLabels[kFields] = {"frame", "scissor", "tex0", "xyoffset", "zbuf", "tex1", "mip",
                                                   "clamp", "alpha", "test", "fba", "clut", "prim", "texa",
                                                   "texclut", "pabe", "filter", "texsize", "fog", "padding"};

    inline int fieldIndex(uint32_t bit)
    {
        int i = 0;
        while (i < kFields && bit != (1u << i))
            ++i;
        return i;
    }
    inline const char *fieldLabel(uint32_t bit)
    {
        const int i = fieldIndex(bit);
        return i < kFields ? kFieldLabels[i] : "?";
    }

    using GsStateEqual::eq;   // value equality per register: padding bytes never count (see kPadding)

    // The fields a and b differ in, by value; kPadding alone when only their bytes do.
    inline uint32_t diff(const DrawKey &a, const DrawKey &b)
    {
        uint32_t m = 0u;
        const GSContext &x = a.context, &y = b.context;
        if (!eq(x.frame, y.frame)) m |= kFrame;
        if (!eq(x.scissor, y.scissor)) m |= kScissor;
        if (!eq(x.tex0, y.tex0)) m |= kTex0;
        if (!eq(x.xyoffset, y.xyoffset)) m |= kXyOffset;
        if (!eq(x.zbuf, y.zbuf)) m |= kZbuf;
        if (x.tex1 != y.tex1) m |= kTex1;
        if (x.miptbp1 != y.miptbp1 || x.miptbp2 != y.miptbp2) m |= kMip;
        if (x.clamp != y.clamp) m |= kClamp;
        if (x.alpha != y.alpha) m |= kAlpha;
        if (x.test != y.test) m |= kTest;
        if (x.fba != y.fba) m |= kFba;
        if (x.clutId != y.clutId) m |= kClutId;
        if (!eq(a.prim, b.prim)) m |= kPrim;
        if (!eq(a.texa, b.texa)) m |= kTexa;
        if (!eq(a.texclut, b.texclut)) m |= kTexClut;
        if (a.pabe != b.pabe) m |= kPabe;
        if (a.linearFilter != b.linearFilter) m |= kFilter;
        if (a.textureWidth != b.textureWidth || a.textureHeight != b.textureHeight) m |= kTexSize;
        if (a.fogR != b.fogR || a.fogG != b.fogG || a.fogB != b.fogB) m |= kFog;
        if (m == 0u && std::memcmp(&a, &b, sizeof(DrawKey)) != 0) m |= kPadding;
        return m;
    }

    // Does a primitive with key b join the open batch with key a? By value (PS2X_GS_BATCH_BY_VALUE): when no field
    // differs -- padding is not state. By bytes (the original whole-key memcmp): padding alone splits the batch.
    // Either way only separate triangles are ever joined: executeSubmit expands every GS primitive (sprites,
    // points, lines, and each triangle of a strip or fan) into independent triangles drawn with GL_TRIANGLES.
    inline bool sameBatch(const DrawKey &a, const DrawKey &b, bool byValue)
    {
        return byValue ? (diff(a, b) & ~kPadding) == 0u : std::memcmp(&a, &b, sizeof(DrawKey)) == 0;
    }

    // The commands that end a batch without a DrawKey change. EndOfBuffer: executeCommands' closing flush.
    enum class Cmd : uint8_t { Transfer, Upload, VramWrite, Clear, Present, Readback, Reset, EndOfBuffer, Count };
    constexpr int kCmds = static_cast<int>(Cmd::Count);
    constexpr const char *kCmdLabels[kCmds] = {"transfer", "upload", "vram_write", "clear", "present", "readback",
                                               "reset", "end_of_buffer"};

    struct MaskCount
    {
        uint32_t mask = 0u;
        uint64_t batches = 0u;
        uint64_t vertices = 0u;
    };

    // One interval's batches, by what ended them (render thread only).
    struct Counter
    {
        uint64_t batches = 0u, vertices = 0u, alphaBatches = 0u;
        uint64_t byField[kFields] = {}, vertsByField[kFields] = {};
        uint64_t byCmd[kCmds] = {}, vertsByCmd[kCmds] = {};
        std::unordered_map<uint32_t, MaskCount> masks;

        void noteKeyFlush(uint32_t mask, uint32_t verts)
        {
            ++batches;
            vertices += verts;
            if (mask & kAlpha)
                ++alphaBatches;
            for (int i = 0; i < kFields; ++i)
                if (mask & (1u << i))
                {
                    ++byField[i];
                    vertsByField[i] += verts;
                }
            MaskCount &mc = masks[mask];
            mc.mask = mask;
            ++mc.batches;
            mc.vertices += verts;
        }
        void noteCmdFlush(Cmd why, uint32_t verts)
        {
            ++batches;
            vertices += verts;
            ++byCmd[static_cast<int>(why)];
            vertsByCmd[static_cast<int>(why)] += verts;
        }
        // The n commonest key combinations, most batches first.
        std::vector<MaskCount> topMasks(size_t n) const
        {
            std::vector<MaskCount> v;
            v.reserve(masks.size());
            for (const auto &kv : masks)
                v.push_back(kv.second);
            std::sort(v.begin(), v.end(), [](const MaskCount &a, const MaskCount &b) {
                return a.batches != b.batches ? a.batches > b.batches : a.mask < b.mask;
            });
            if (v.size() > n)
                v.resize(n);
            return v;
        }
        void reset() { *this = Counter{}; }
    };

    // The GL state a Metal render pipeline bakes in: blend, colour mask, depth, and the target's format.
    // Uniform values and textures are not part of it.
    struct PipelineKey
    {
        bool blend = false;
        uint32_t blendEq = 0u, blendSrc = 0u, blendDst = 0u;
        uint8_t colorMask = 0u;
        bool depthTest = false;
        uint32_t depthFunc = 0u;
        bool depthWrite = false;
        uint32_t targetPsm = 0u;

        uint64_t hash() const
        {
            uint64_t h = 1469598103934665603ull;   // FNV-1a over the fields, not the padding
            auto mix = [&h](uint64_t v) { h = (h ^ v) * 1099511628211ull; };
            mix(blend); mix(blendEq); mix(blendSrc); mix(blendDst); mix(colorMask);
            mix(depthTest); mix(depthFunc); mix(depthWrite); mix(targetPsm);
            return h;
        }
    };

    struct PipelineSet
    {
        std::unordered_set<uint64_t> seen;
        // True the first time the session meets this pipeline state.
        bool firstUse(const PipelineKey &k) { return seen.insert(k.hash()).second; }
        size_t size() const { return seen.size(); }
    };
}
