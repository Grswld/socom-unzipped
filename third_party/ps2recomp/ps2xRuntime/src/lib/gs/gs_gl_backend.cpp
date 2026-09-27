#include "runtime/gs/gs_gl_backend.h"
#include "runtime/gs/ps2_gs_common.h"
#include "runtime/gs/ps2_gs_memory.h"

#include "raylib.h"
#include "rlgl.h"
#include "external/glad.h"
#include "runtime/gs/gs_gl_depth.h"
#include "runtime/gs/gs_gl_target_extent.h"
#include "runtime/gs/gs_gl_upload_trace.h"
#include "runtime/gs/gs_gl_upload_identity.h"
#include "runtime/gs/gs_gl_texture_identity.h"
#include "ps2x/knobs.h"

// raylib's glad stops short of GL 4.5, so glClipControl (GL 4.5 / ARB_clip_control) is looked up
// at runtime through GLFW, which raylib links on desktop.
#if !defined(PLATFORM_VITA) && !defined(PLATFORM_ANDROID) && !defined(__ANDROID__)
#define PS2X_GS_GL_HAVE_GLFW_PROC 1
extern "C" void (*glfwGetProcAddress(const char *procname))(void);
#endif
#ifndef GL_CLIP_DEPTH_MODE
#define GL_CLIP_DEPTH_MODE 0x935D
#endif
#ifndef GL_NEGATIVE_ONE_TO_ONE
#define GL_NEGATIVE_ONE_TO_ONE 0x935E
#endif
#ifndef GL_ZERO_TO_ONE
#define GL_ZERO_TO_ONE 0x935F
#endif
#ifndef GL_MAX_DUAL_SOURCE_DRAW_BUFFERS
#define GL_MAX_DUAL_SOURCE_DRAW_BUFFERS 0x88FC
#endif

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstddef>
#include <ctime>
#include <chrono>

// ---------------------------------------------------------------------------------------------
// Helpers (mirrors of the CPU backend's static helpers so the two paths agree)
// ---------------------------------------------------------------------------------------------
namespace
{
    // Sprint 8 Goal 2 Task 1 (PS2X_GS_UPLOAD_TRACE=1): the per-call cost of the tile upload path.
    // The render thread is the accumulator's only writer; record()'s term is produced on the game
    // thread and arrives through the atomic below, drained once per report by the formatter.
    GsGlUploadTrace::Accum g_uploadTrace;
    // Sprint 8 Goal 2b Task 1: the flush half of the transfer= bucket, split by phase. ARMED ONLY
    // around the flushBatch() the CmdType::BeginTransfer case runs (:1535-1538): flushBatch is
    // called from a dozen other command cases and only the transfer one is billed to transfer=, so
    // arming it there is what makes dirty_rows + decode + draw add up to flush.
    thread_local bool g_flushPhasesArmed = false;
    thread_local bool g_flushHadBatch = false;
    thread_local double g_flushDirtyRowsUs = 0.0;
    thread_local double g_flushDecodeUs = 0.0;
    // The game thread writes this one; the render thread's formatter drains it. Relaxed is right:
    // the line is a diagnostic, and a torn microsecond does not change a verdict.
    std::atomic<double> g_recordUsGameThread{0.0};
    inline void addRecordUs(double us)
    {
        double cur = g_recordUsGameThread.load(std::memory_order_relaxed);
        while (!g_recordUsGameThread.compare_exchange_weak(cur, cur + us, std::memory_order_relaxed,
                                                           std::memory_order_relaxed))
        {
        }
    }
    // Times GSGlBackend::record from before the queue mutex is taken to after it is released --
    // destroyed after the lock_guard it is declared ahead of, so the contention is inside the
    // measurement, and so is the early return past the pending cap.
    struct RecordTimer
    {
        bool on = false;
        std::chrono::steady_clock::time_point t0{};
        ~RecordTimer()
        {
            if (on)
                addRecordUs(std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - t0).count());
        }
    };

    constexpr uint32_t kMaxRtWidth = 1024u;
    constexpr uint32_t kRtHeight = 1024u;
    // Integer render scale (S3-c): every render target's GL colour texture is renderScale()
    // times its native GS extent, and every draw rasterises into it at that scale. Read once from
    // PS2X_GS_SCALE and clamped to 1..4; 1 (the default) is the identity -- host == native, so
    // nativeView() never copies, appendVertex multiplies by 1.0f and every rect below is the rect
    // it was before S3-c. The CPU backend ignores this knob entirely and stays 1x.
    //
    // DESIGN (research/14 section 8.1 item 5): this is the *premultiply* design. appendVertex
    // multiplies out.x/out.y by S after the xyoffset >> 4 subtraction, so aPos arrives in host
    // pixels and uRtSize must be the HOST size. uTexSize stays NATIVE unconditionally, because
    // S3-b's nativeView() hands the sampler a native-sized mirror -- so an RT sampled as a texture
    // is sampled at native resolution and a full-screen display copy gains no detail from the
    // scale; only the draws that rasterise into the target do. Point/line/sprite expansion in
    // executeSubmit happens on GSVertex, i.e. pre-scale, so a 1-native-pixel line still covers S
    // host pixels.
    uint32_t renderScale()
    {
        static const uint32_t s_scale = []
        {
            const char *const e = ps2x::knob("PS2X_GS_SCALE");
            long v = (e != nullptr && *e != 0) ? std::strtol(e, nullptr, 0) : 1L;
            if (v < 1L)
                v = 1L;
            if (v > 4L)
                v = 4L;
            return static_cast<uint32_t>(v);
        }();
        return s_scale;
    }
    constexpr uint32_t kHostFrameWidth = 640u;
    constexpr uint32_t kHostFrameHeight = 512u;

    // PS2X_GS_TRACE_PAGES="0xPAGE:count": log every shadow/GPU event that touches those VRAM
    // pages (uploads, local copies, render-target refreshes, downloads, GPU draws, texture
    // decodes) with the frame number — the order of who wrote what into a page that a texture
    // is later decoded from (SOCOM II's title labels: pages 0x190..0x195 inside frame buffer
    // 0x8c's row band).
    bool tracePagesHit(uint32_t page, uint32_t count)
    {
        static const char *const s_env = ps2x::knob("PS2X_GS_TRACE_PAGES");
        static uint32_t s_page = 0u, s_count = 0u;
        static bool s_parsed = false;
        if (!s_env)
            return false;
        if (!s_parsed)
        {
            s_parsed = true;
            char *end = nullptr;
            s_page = static_cast<uint32_t>(std::strtoul(s_env, &end, 0));
            s_count = (end && *end == ':') ? static_cast<uint32_t>(std::strtoul(end + 1, nullptr, 0)) : 1u;
        }
        return page < s_page + s_count && page + count > s_page;
    }

    uint32_t rgba5551To8888(uint32_t c)
    {
        const uint32_t r = (c & 0x1Fu) << 3;
        const uint32_t g = ((c >> 5) & 0x1Fu) << 3;
        const uint32_t b = ((c >> 10) & 0x1Fu) << 3;
        const uint32_t a = (c & 0x8000u) ? 0x80u : 0u;
        return r | (g << 8) | (b << 16) | (a << 24);
    }

    uint32_t rgba8888To5551(uint32_t c)
    {
        const uint32_t r = (c & 0xFFu) >> 3;
        const uint32_t g = ((c >> 8) & 0xFFu) >> 3;
        const uint32_t b = ((c >> 16) & 0xFFu) >> 3;
        const uint32_t a = ((c >> 24) & 0x80u) ? 0x8000u : 0u;
        return r | (g << 5) | (b << 10) | a;
    }

    uint32_t applyTexa(const GSTexaReg &texa, uint8_t psm, uint32_t texel)
    {
        if (psm == GS_PSM_CT32)
            return texel;
        const uint8_t r = static_cast<uint8_t>(texel & 0xFFu);
        const uint8_t g = static_cast<uint8_t>((texel >> 8) & 0xFFu);
        const uint8_t b = static_cast<uint8_t>((texel >> 16) & 0xFFu);
        const bool rgbZero = r == 0u && g == 0u && b == 0u;
        uint8_t a = static_cast<uint8_t>((texel >> 24) & 0xFFu);
        switch (psm)
        {
        case GS_PSM_CT24:
            a = (texa.aem && rgbZero) ? 0u : texa.ta0;
            break;
        case GS_PSM_CT16:
        case GS_PSM_CT16S:
            if ((a & 0x80u) != 0u)
                a = texa.ta1;
            else
                a = (texa.aem && rgbZero) ? 0u : texa.ta0;
            break;
        default:
            break;
        }
        return (texel & 0x00FFFFFFu) | (static_cast<uint32_t>(a) << 24);
    }

    uint32_t resolveClutIndex(uint8_t index, uint8_t cpsm, uint8_t csm, uint8_t csa, uint8_t sourcePsm)
    {
        uint32_t clutIndex = index;
        if (csm != 0u)
            return (sourcePsm == GS_PSM_T4 || sourcePsm == GS_PSM_T4HH || sourcePsm == GS_PSM_T4HL) ? (clutIndex & 0x0Fu) : clutIndex;
        const bool is16 = cpsm == GS_PSM_CT16 || cpsm == GS_PSM_CT16S;
        const uint32_t csaMask = is16 ? 0x1Fu : 0x0Fu;
        const uint32_t clutIndexMask = is16 ? 0x1FFu : 0x0FFu;
        const uint32_t clutBase = (static_cast<uint32_t>(csa) & csaMask) << 4u;
        switch (sourcePsm)
        {
        case GS_PSM_T4:
        case GS_PSM_T4HH:
        case GS_PSM_T4HL:
            clutIndex = clutBase + (clutIndex & 0x0Fu);
            break;
        case GS_PSM_T8:
        case GS_PSM_T8H:
            clutIndex = clutBase + clutIndex;
            break;
        default:
            return clutIndex;
        }
        // CSM1 stores the CLUT with address bits 3 and 4 swapped (a 4-bit CLUT is an 8x2 block,
        // not a 16x1 strip). Same as the CPU rasterizer's swizzleClutIndexCSM1; without it the
        // bright half of every 4-bit palette read the wrong slot (UI text came out dim).
        clutIndex &= clutIndexMask;
        return (clutIndex & ~0x18u) | ((clutIndex & 0x08u) << 1u) | ((clutIndex & 0x10u) >> 1u);
    }

    uint32_t readVramRaw(uint8_t *vram, uint32_t psm, uint32_t bp, uint32_t bw, uint32_t x, uint32_t y)
    {
        switch (psm)
        {
        case GS_PSM_CT32: return GSMem::ReadCT32(vram, bp, bw, x, y);
        case GS_PSM_CT24: return GSMem::ReadCT24(vram, bp, bw, x, y);
        case GS_PSM_CT16: return GSMem::ReadCT16(vram, bp, bw, x, y);
        case GS_PSM_CT16S: return GSMem::ReadCT16S(vram, bp, bw, x, y);
        case GS_PSM_T8: return GSMem::ReadP8(vram, bp, bw, x, y);
        case GS_PSM_T8H: return GSMem::ReadP8H(vram, bp, bw, x, y);
        case GS_PSM_T4: return GSMem::ReadP4(vram, bp, bw, x, y);
        case GS_PSM_T4HL: return GSMem::ReadP4HL(vram, bp, bw, x, y);
        case GS_PSM_T4HH: return GSMem::ReadP4HH(vram, bp, bw, x, y);
        case GS_PSM_Z32: return GSMem::ReadZ32(vram, bp, bw, x, y);
        case GS_PSM_Z24: return GSMem::ReadZ24(vram, bp, bw, x, y);
        case GS_PSM_Z16: return GSMem::ReadZ16(vram, bp, bw, x, y);
        case GS_PSM_Z16S: return GSMem::ReadZ16S(vram, bp, bw, x, y);
        default: return 0u;
        }
    }

    void writeVramRaw(uint8_t *vram, uint32_t psm, uint32_t bp, uint32_t bw, uint32_t x, uint32_t y, uint32_t value)
    {
        switch (psm)
        {
        case GS_PSM_CT32: GSMem::WriteCT32(vram, bp, bw, x, y, value); break;
        case GS_PSM_CT24: GSMem::WriteCT24(vram, bp, bw, x, y, value); break;
        case GS_PSM_CT16: GSMem::WriteCT16(vram, bp, bw, x, y, value); break;
        case GS_PSM_CT16S: GSMem::WriteCT16S(vram, bp, bw, x, y, value); break;
        case GS_PSM_Z32: GSMem::WriteZ32(vram, bp, bw, x, y, value); break;
        case GS_PSM_Z24: GSMem::WriteZ24(vram, bp, bw, x, y, value); break;
        case GS_PSM_Z16: GSMem::WriteZ16(vram, bp, bw, x, y, value); break;
        case GS_PSM_Z16S: GSMem::WriteZ16S(vram, bp, bw, x, y, value); break;
        default: break;
        }
    }

    // Sprint 13 V2 (#32): the upload gate (gs_gl_upload_reasons.h) runs with the stats line, whose
    // reasons line it feeds, or with the skip. Off, the upload path is exactly what it was.
    bool uploadGateSkip()
    {
        static const bool s_skip = ps2x::knobOn("PS2X_GS_UPLOAD_SKIP");
        return s_skip;
    }
    bool uploadGateOn()
    {
        static const bool s_on = uploadGateSkip() || ps2x::knob("PS2X_GS_STATS") != nullptr;
        return s_on;
    }

    // Display register decoding (same as the CPU backend).
    void decodeDisplaySize(uint64_t display64, uint32_t &outWidth, uint32_t &outHeight)
    {
        const uint32_t dw = static_cast<uint32_t>((display64 >> 32) & 0x0FFFu);
        const uint32_t dh = static_cast<uint32_t>((display64 >> 44) & 0x07FFu);
        const uint32_t magh = static_cast<uint32_t>((display64 >> 23) & 0x0Fu);
        outWidth = (dw + 1u) / (magh + 1u);
        outHeight = dh + 1u;
        if (outWidth < 64u || outHeight < 64u)
        {
            outWidth = kHostFrameWidth;
            outHeight = 448u;
        }
        outWidth = std::min<uint32_t>(outWidth, kHostFrameWidth);
        outHeight = std::min<uint32_t>(outHeight, kHostFrameHeight);
    }

    GSFrameReg decodeDisplayFrame(uint64_t dispfb64)
    {
        GSFrameReg frame{};
        frame.fbp = static_cast<uint32_t>(dispfb64 & 0x1FFu);
        frame.fbw = static_cast<uint32_t>((dispfb64 >> 9) & 0x3Fu);
        frame.psm = static_cast<uint8_t>((dispfb64 >> 15) & 0x1Fu);
        return frame;
    }

    bool hasDisplaySetup(uint64_t display64, const GSFrameReg &frame)
    {
        const uint32_t dw = static_cast<uint32_t>((display64 >> 32) & 0x0FFFu);
        const uint32_t dh = static_cast<uint32_t>((display64 >> 44) & 0x07FFu);
        const uint32_t magh = static_cast<uint32_t>((display64 >> 23) & 0x0Fu);
        return frame.fbw != 0u || dw != 0u || dh != 0u || magh != 0u;
    }

    const char *kVertexShader = R"GLSL(
#version 330 core
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aTex;
layout(location = 2) in vec4 aColor;
layout(location = 3) in float aFog;
uniform vec2 uRtSize;
out vec4 vColor;
out vec3 vTex;
out float vFog;
#if PS2X_DEPTH_MODE == 2
noperspective out float vDepth;
#endif
void main()
{
    // aPos.z = GS z / 2^32 (GsGlDepth::attribute). research/26: `* 2.0 - 1.0` rounds window depth
    // to 128 GS z units, so the default is GL_ZERO_TO_ONE clip control with z passed through.
#if PS2X_DEPTH_MODE == 1
    float zNdc = aPos.z;
#else
    float zNdc = aPos.z * 2.0 - 1.0;
#endif
    gl_Position = vec4(aPos.x / uRtSize.x * 2.0 - 1.0, aPos.y / uRtSize.y * 2.0 - 1.0, zNdc, 1.0);
#if PS2X_DEPTH_MODE == 2
    vDepth = aPos.z;
#endif
    vColor = aColor;
    vTex = aTex;
    vFog = aFog;
}
)GLSL";

    const char *kFragmentShader = R"GLSL(
#version 330 core
in vec4 vColor;
in vec3 vTex;
in float vFog;
uniform sampler2D uTex;
uniform vec2 uTexSize;
uniform int uTme, uTfx, uTcc, uFst, uWrapU, uWrapV;
uniform vec4 uRegion;
uniform int uAte, uAtst, uAfail;
uniform float uAref;
uniform int uFge, uFba;
uniform vec3 uFogColor;
uniform int uSrcMode;       // 1: emit uSrcConst; 2: emit the fragment's PS2 alpha (As) in every channel -- for blends
uniform vec4 uSrcConst;     // whose source term has to carry Cd*C (executeSubmit, "Cd*C + Cd")
layout(location = 0, index = 0) out vec4 oColor;
layout(location = 0, index = 1) out vec4 oBlendAlpha;
#if PS2X_DEPTH_MODE == 2
noperspective in float vDepth;
#endif

float wrapCoord(float c, int mode, float size, float mn, float mx)
{
    if (mode == 0) return mod(c, size);
    if (mode == 1) return clamp(c, 0.0, size - 1.0 + 0.999);
    if (mode == 2) return clamp(c, mn, mx + 0.999);
    return float((int(floor(c)) & int(mx)) | int(mn)) + fract(c);
}

void main()
{
#if PS2X_DEPTH_MODE == 2
    gl_FragDepth = vDepth;
#endif
    vec4 c = vColor;
    if (uTme == 1)
    {
        vec2 tc = (uFst == 1) ? vTex.xy : vTex.xy / max(vTex.z, 1e-6);
        float u = wrapCoord(tc.x, uWrapU, uTexSize.x, uRegion.x, uRegion.y);
        float v = wrapCoord(tc.y, uWrapV, uTexSize.y, uRegion.z, uRegion.w);
        vec4 t = texture(uTex, vec2(u, v) / uTexSize);
        if (uTfx == 0)
        {
            c.rgb = min(c.rgb * t.rgb * 2.0, 1.0);
            c.a = (uTcc == 1) ? min(c.a * t.a * 2.0, 1.0) : c.a;
        }
        else if (uTfx == 1)
        {
            c.rgb = t.rgb;
            c.a = (uTcc == 1) ? t.a : c.a;
        }
        else if (uTfx == 2)
        {
            c.rgb = min(c.rgb * t.rgb * 2.0 + c.a, 1.0);
            c.a = (uTcc == 1) ? min(t.a + c.a, 1.0) : c.a;
        }
        else
        {
            c.rgb = min(c.rgb * t.rgb * 2.0 + c.a, 1.0);
            c.a = (uTcc == 1) ? t.a : c.a;
        }
    }
    if (uAte == 1)
    {
        float a = floor(c.a * 255.0 + 0.5);
        bool pass = true;
        if (uAtst == 0) pass = false;
        else if (uAtst == 2) pass = a < uAref;
        else if (uAtst == 3) pass = a <= uAref;
        else if (uAtst == 4) pass = a == uAref;
        else if (uAtst == 5) pass = a >= uAref;
        else if (uAtst == 6) pass = a > uAref;
        else if (uAtst == 7) pass = a != uAref;
        if (!pass && (uAfail == 0 || uAfail == 2)) discard;
    }
    if (uFge == 1)
        c.rgb = mix(uFogColor, c.rgb, vFog);
    if (uFba == 1)
        c.a = float(int(floor(c.a * 255.0 + 0.5)) | 128) / 255.0;
    if (uSrcMode == 1)
        c = uSrcConst;
    else if (uSrcMode == 2)
        c = vec4(min(c.a * 2.0, 1.0));
    oColor = c;
    oBlendAlpha = vec4(min(c.a * 2.0, 1.0));
}
)GLSL";

    // research/26 depth path. Render-thread state, chosen once in ensureGl.
    using ClipControlFn = void(
#if defined(_WIN32) && !defined(_WIN64)
        __stdcall
#endif
        *)(GLenum, GLenum);
    GsGlDepth::Mode g_depthMode = GsGlDepth::Mode::Legacy;
    ClipControlFn g_clipControl = nullptr;

    // GL 4.5 or ARB_clip_control, a resolvable entry point, and a round trip through
    // GL_CLIP_DEPTH_MODE that proves the call took. Leaves the default clip range set.
    ClipControlFn probeClipControl()
    {
#if defined(PS2X_GS_GL_HAVE_GLFW_PROC)
        GLint major = 0, minor = 0, extCount = 0;
        glGetIntegerv(GL_MAJOR_VERSION, &major);
        glGetIntegerv(GL_MINOR_VERSION, &minor);
        bool advertised = major > 4 || (major == 4 && minor >= 5);
        glGetIntegerv(GL_NUM_EXTENSIONS, &extCount);
        for (GLint i = 0; i < extCount && !advertised; ++i)
        {
            const char *ext = reinterpret_cast<const char *>(glGetStringi(GL_EXTENSIONS, static_cast<GLuint>(i)));
            advertised = ext != nullptr && std::strcmp(ext, "GL_ARB_clip_control") == 0;
        }
        if (!advertised)
            return nullptr;
        const ClipControlFn fn = reinterpret_cast<ClipControlFn>(glfwGetProcAddress("glClipControl"));
        if (fn == nullptr)
            return nullptr;
        while (glGetError() != GL_NO_ERROR)
        {
        }
        fn(GL_LOWER_LEFT, GL_ZERO_TO_ONE);
        GLint mode = 0;
        glGetIntegerv(GL_CLIP_DEPTH_MODE, &mode);
        const bool took = glGetError() == GL_NO_ERROR && mode == GL_ZERO_TO_ONE;
        fn(GL_LOWER_LEFT, GL_NEGATIVE_ONE_TO_ONE);
        return took ? fn : nullptr;
#else
        return nullptr;
#endif
    }

    // Task 1a: the fragment shader writes index 1 (oBlendAlpha) through
    // glBindFragDataLocationIndexed, so a driver without dual-source draw buffers links a program
    // that never blends correctly. One integer query answers it.
    bool probeDualSourceBlend()
    {
        while (glGetError() != GL_NO_ERROR)
        {
        }
        GLint buffers = 0;
        glGetIntegerv(GL_MAX_DUAL_SOURCE_DRAW_BUFFERS, &buffers);
        if (glGetError() != GL_NO_ERROR)
            return false;
        return buffers >= 1;
    }

    // The runtime's present loop reads the verdict but holds only a GSRasterBackend pointer, so
    // the latch mirrors itself here. Written once (the render thread's single probe), read on the
    // same thread; atomic anyway because the string is read beside it.
    std::atomic<bool> g_glUnavailable{false};
    std::mutex g_glMissingMutex;
    std::string g_glMissing;

    std::string withDepthMode(const char *source, GsGlDepth::Mode mode)
    {
        std::string s(source);
        const std::string version = "#version 330 core\n";
        const size_t at = s.find(version);
        const std::string define = "#define PS2X_DEPTH_MODE " + std::to_string(static_cast<int>(mode)) + "\n";
        if (at == std::string::npos)
            return define + s;
        s.insert(at + version.size(), define);
        return s;
    }

    // PS2X_GS_SCALE_FILTER=point|box -- how a host-scale render target is resolved down to its
    // native GS extent for the reads the guest can observe. `point` (the default) is a GL_NEAREST
    // glBlitFramebuffer: each native pixel takes one host texel, so a readback carries exactly the
    // bytes some host texel holds. `box` averages the SxS host texels behind each native pixel with
    // the fullscreen-triangle pass below. Both are unreachable until PS2X_GS_SCALE > 1 (S3-c): at
    // scale 1 nativeView() returns the colour texture without ever calling the resolve.
    bool resolveFilterIsBox()
    {
        static const bool s_box = []
        {
            const char *const e = ps2x::knob("PS2X_GS_SCALE_FILTER");
            return e != nullptr && std::strcmp(e, "box") == 0;
        }();
        return s_box;
    }

    // PS2X_GS_SCALE_SELFTEST=1 -- the S3-c verification harness for the S3-b resolve path. Off by
    // default; when off the whole thing is one cached getenv and a branch that is never taken.
    //
    // It answers the two questions a screenshot cannot. (a) FRESHNESS: is the mirror a view of the
    // host texture as of the LAST write to it, or is it short one batch? research/14 section 9.1
    // describes exactly that bug -- resolveTexture can clear dirtySinceResolve between a batch's
    // setup and its draw -- and it is invisible in a frame that still "keeps its shape". A write
    // serial is bumped at every one of the three host-texture writers and stamped into the mirror
    // at every resolve; nativeView() then checks the two are equal on EVERY read, including the
    // reads that return the mirror without re-resolving (which are the only reads a stale mirror
    // can be served from). (b) CONTENT: is each native pixel actually the SxS host block behind
    // it? Both filters put the mirror pixel inside the per-channel [min, max] of its block --
    // point picks one member of the block, box averages them -- so one rule checks both, and a
    // stale mirror fails it wherever the frame changed.
    bool scaleSelfTest()
    {
        static const bool s_on = []
        {
            const char *const e = ps2x::knob("PS2X_GS_SCALE_SELFTEST");
            return e != nullptr && *e != 0 && *e != '0';
        }();
        return s_on;
    }

    struct ScaleSerial
    {
        uint64_t written = 0;    // host colour texture writes (draw / clear / row upload)
        uint64_t resolved = 0;   // the write count the mirror was last resolved at
    };

    std::unordered_map<uint32_t, ScaleSerial> &scaleSerials()
    {
        static std::unordered_map<uint32_t, ScaleSerial> s_map;
        return s_map;
    }

    // Called from every site that sets dirtySinceResolve. Render-thread only, like the map.
    void scaleNoteHostWrite(uint32_t fbp)
    {
        if (scaleSelfTest())
            ++scaleSerials()[fbp].written;
    }

    void scaleSelfTestCheck(uint32_t fbp, uint32_t mirrorFbo, uint32_t hostFbo,
                            uint32_t natW, uint32_t natH, uint32_t hostW, uint32_t hostH, bool resolvedNow)
    {
        // s_contentLit* are budgets for windows that actually have content: a first cut spent all
        // 24 on the first 24 reads and every one of them landed on an all-black window served by a
        // read that had just re-resolved, so "0 samples outside the host block range" was true and
        // near-vacuous. The budget is now charged only when the window is lit (nonBlack > 0), and
        // split by resolved-now so the shape that a stale mirror can actually corrupt -- a read
        // served from an ALREADY-CLEAN mirror -- gets its own half and cannot be crowded out.
        // s_contentTried caps the readbacks themselves, since an unlit window still costs two
        // glReadPixels to discover.
        static uint64_t s_reads = 0, s_stale = 0, s_clean = 0;
        static uint64_t s_contentLitDirty = 0, s_contentLitClean = 0, s_contentTried = 0, s_contentDark = 0;
        const ScaleSerial &ser = scaleSerials()[fbp];
        ++s_reads;
        if (!resolvedNow)
            ++s_clean;   // served from an already-clean mirror: the only shape a stale read can take
        if (ser.resolved != ser.written)
        {
            ++s_stale;
            std::fprintf(stderr, "[gs-scale-selftest] STALE fbp=%03x read#%llu resolved-now=%d: mirror resolved at write %llu, %llu writes have landed\n",
                         fbp, (unsigned long long)s_reads, resolvedNow ? 1 : 0,
                         (unsigned long long)ser.resolved, (unsigned long long)ser.written);
        }
        if (s_reads % 500u == 0u)
            std::fprintf(stderr, "[gs-scale-selftest] %llu native-view reads (%llu served from an already-clean mirror), %llu stale; fbp=%03x writes=%llu\n",
                         (unsigned long long)s_reads, (unsigned long long)s_clean, (unsigned long long)s_stale,
                         fbp, (unsigned long long)ser.written);
        const uint64_t litBudget = resolvedNow ? s_contentLitDirty : s_contentLitClean;
        if (litBudget >= 12u || s_contentTried >= 3000u || natW == 0u || natH == 0u)
            return;
        ++s_contentTried;
        const uint32_t sx = hostW / natW, sy = hostH / natH;
        if (sx == 0u || sy == 0u)
            return;
        const uint32_t w = std::min<uint32_t>(256u, natW), h = std::min<uint32_t>(224u, natH);
        GLint prevRead = 0;
        glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &prevRead);
        glPixelStorei(GL_PACK_ALIGNMENT, 4);
        // Read the native mirror first and count lit pixels in it. A dark window cannot tell a
        // correct mirror from a stale or a mis-addressed one, so it is skipped BEFORE the host
        // readback (which is SxS times larger) and without charging the budget -- that keeps the
        // cost of hunting for a lit frame down to one 256x224 readback per attempt.
        std::vector<uint8_t> nat(static_cast<size_t>(w) * h * 4u);
        glBindFramebuffer(GL_READ_FRAMEBUFFER, mirrorFbo);
        glReadPixels(0, 0, static_cast<GLsizei>(w), static_cast<GLsizei>(h), GL_RGBA, GL_UNSIGNED_BYTE, nat.data());
        uint64_t nonBlack = 0;
        for (size_t i = 0; i < static_cast<size_t>(w) * h; ++i)
            if (nat[i * 4u] != 0u || nat[i * 4u + 1u] != 0u || nat[i * 4u + 2u] != 0u)
                ++nonBlack;
        if (nonBlack == 0u)
        {
            ++s_contentDark;
            glBindFramebuffer(GL_READ_FRAMEBUFFER, static_cast<GLuint>(prevRead));
            return;
        }
        std::vector<uint8_t> host(static_cast<size_t>(w) * sx * static_cast<size_t>(h) * sy * 4u);
        glBindFramebuffer(GL_READ_FRAMEBUFFER, hostFbo);
        glReadPixels(0, 0, static_cast<GLsizei>(w * sx), static_cast<GLsizei>(h * sy), GL_RGBA, GL_UNSIGNED_BYTE, host.data());
        glBindFramebuffer(GL_READ_FRAMEBUFFER, static_cast<GLuint>(prevRead));
        uint64_t bad = 0, samples = 0;
        for (uint32_t y = 0; y < h; ++y)
            for (uint32_t x = 0; x < w; ++x)
                for (uint32_t c = 0; c < 4u; ++c)
                {
                    int lo = 255, hi = 0;
                    for (uint32_t by = 0; by < sy; ++by)
                        for (uint32_t bx = 0; bx < sx; ++bx)
                        {
                            const int v = host[((static_cast<size_t>(y) * sy + by) * (static_cast<size_t>(w) * sx) + (static_cast<size_t>(x) * sx + bx)) * 4u + c];
                            lo = std::min(lo, v);
                            hi = std::max(hi, v);
                        }
                    const int got = nat[(static_cast<size_t>(y) * w + x) * 4u + c];
                    ++samples;
                    if (got < lo - 1 || got > hi + 1)
                        ++bad;
                }
        if (resolvedNow)
            ++s_contentLitDirty;
        else
            ++s_contentLitClean;
        std::fprintf(stderr, "[gs-scale-selftest] content fbp=%03x read#%llu resolved-now=%d writes=%llu resolved-at=%llu filter=%s scale=%ux%u window=%ux%u: %llu/%llu channel samples outside the host block range, %llu/%u non-black native pixels (lit windows checked: %llu after a resolve, %llu served clean; %llu dark windows skipped of %llu tried)\n",
                     fbp, (unsigned long long)s_reads, resolvedNow ? 1 : 0,
                     (unsigned long long)ser.written, (unsigned long long)ser.resolved,
                     resolveFilterIsBox() ? "box" : "point", sx, sy, w, h,
                     (unsigned long long)bad, (unsigned long long)samples, (unsigned long long)nonBlack, w * h,
                     (unsigned long long)s_contentLitDirty, (unsigned long long)s_contentLitClean,
                     (unsigned long long)s_contentDark, (unsigned long long)s_contentTried);
    }

    // Fullscreen triangle from gl_VertexID alone: no attributes, no vertex buffer.
    const char *const kResolveVertexShader = R"GLSL(#version 330 core
void main()
{
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
)GLSL";

    // Drawn into the native-sized mirror, so gl_FragCoord.xy IS the native pixel: the SxS host
    // texels behind it start at (native * scale) and the average of them is the box filter.
    const char *const kResolveFragmentShader = R"GLSL(#version 330 core
uniform sampler2D uSrc;
uniform int uScaleX;
uniform int uScaleY;
out vec4 oColor;
void main()
{
    ivec2 base = ivec2(gl_FragCoord.xy) * ivec2(uScaleX, uScaleY);
    vec4 sum = vec4(0.0);
    for (int y = 0; y < uScaleY; ++y)
        for (int x = 0; x < uScaleX; ++x)
            sum += texelFetch(uSrc, base + ivec2(x, y), 0);
    oColor = sum / float(uScaleX * uScaleY);
}
)GLSL";

    uint32_t compileShader(GLenum type, const char *source)
    {
        const GLuint shader = glCreateShader(type);
        glShaderSource(shader, 1, &source, nullptr);
        glCompileShader(shader);
        GLint ok = 0;
        glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
        if (!ok)
        {
            char log[2048];
            glGetShaderInfoLog(shader, sizeof(log), nullptr, log);
            std::fprintf(stderr, "[gs-gl] shader compile failed: %s\n", log);
            glDeleteShader(shader);
            return 0u;
        }
        return shader;
    }
}

// ---------------------------------------------------------------------------------------------
// Construction / VRAM model
// ---------------------------------------------------------------------------------------------
GSGlBackend::GSGlBackend()
    : m_cpu(std::make_unique<GSCpuBackend>()), m_shadow(std::make_unique<GSCpuBackend>()),
      m_pendingCap(GsPendingCap::parseCapMb(ps2x::knob("PS2X_GS_PENDING_CAP_MB"), GsPendingCap::kDefaultCapMb) * 1024ull * 1024ull,
                   GsPendingCap::parseCapMb(ps2x::knob("PS2X_GS_PENDING_HARD_CAP_MB"), GsPendingCap::kDefaultHardCapMb) * 1024ull * 1024ull)
{
    m_backpressure.setMaxPendingFrames(GsFrameBackpressure::parseMaxPendingFrames(ps2x::knob("PS2X_GS_MAX_PENDING_FRAMES")));
}

GSGlBackend::~GSGlBackend() = default;

void GSGlBackend::Initialize(uint8_t *vram, uint32_t vramSize)
{
    m_vram = vram;
    m_vramSize = vramSize;
    m_cpu->Initialize(vram, vramSize);
    // Seed the render-thread shadow from the buffer handed in: zero at a game boot, the dump's VRAM when a GS dump
    // is replayed (ps2_gs_tests 'console GS dump replays...', research/31 section 11).
    m_shadowMemory.assign(vram, vram + vramSize);
    m_shadow->Initialize(m_shadowMemory.data(), vramSize);
    m_gpuDirtyPages.fill(0u);
    m_shadowPageGeneration.fill(0u);
    m_uploadIdentity.clear();
    std::fprintf(stderr, "[gs-gl] OpenGL backend active (PS2X_GS_BACKEND=cpu for the rasterizer)\n");
    // The CPU backend (PS2X_GS_BACKEND=cpu, used by the unit tests and vu1_replay) ignores
    // PS2X_GS_SCALE and always rasterises at 1x; this banner only ever prints from the GL path.
    std::fprintf(stderr, "[gs-gl] PS2X_GS_SCALE=%u (render targets %ux native, resolve filter %s)\n",
                 renderScale(), renderScale(), resolveFilterIsBox() ? "box" : "point");
    std::fprintf(stderr, "[gs-gl] PS2X_GS_MAX_PENDING_FRAMES=%u (guest frames recorded ahead of replay before the EE waits; 0 = unbounded)\n",
                 m_backpressure.maxPendingFrames());
    std::fprintf(stderr, "[gs-gl] PS2X_GS_PENDING_CAP_MB=%llu (pending command bytes kept while the replay is latched stalled; 0 = unbounded)\n",
                 static_cast<unsigned long long>(m_pendingCap.capBytes() / (1024ull * 1024ull)));
    std::fprintf(stderr, "[gs-gl] PS2X_GS_PENDING_HARD_CAP_MB=%llu (hard ceiling: the recorder waits for the replay rather than pend more; 0 = no ceiling)\n",
                 static_cast<unsigned long long>(m_pendingCap.hardCapBytes() / (1024ull * 1024ull)));
    std::fprintf(stderr, "[gs-gl] stall bound (Q6): past the pending cap on a latched stall, state-carrying commands are absorbed and re-anchored from the game VRAM when the replay drains (at most %zu rectangles, %zu palettes, %llu MB; a command record is %zu bytes)\n",
                 GsStallCoalescer::kMaxRects, GsStallCoalescer::kMaxCluts,
                 static_cast<unsigned long long>(GsStallCoalescer::kVramBytes / (1024ull * 1024ull)), kCommandBytes);
}

void GSGlBackend::Reset()
{
    Cmd cmd;
    cmd.type = CmdType::Reset;
    const uint64_t token = postAndGetToken(std::move(cmd));
    if (m_glReady.load(std::memory_order_acquire) && std::this_thread::get_id() != m_renderThread)
        waitForToken(token);
    m_cpu->Reset();
    {
        std::lock_guard<std::mutex> lock(m_dirtyMutex);
        m_gpuDirtyPages.fill(0u);
    }
}

uint32_t GSGlBackend::pageHeightForPsm(uint32_t psm)
{
    switch (psm)
    {
    case GS_PSM_CT16:
    case GS_PSM_CT16S:
    case GS_PSM_Z16:
    case GS_PSM_Z16S:
        return 64u;
    case GS_PSM_T8:
    case GS_PSM_T8H:
        return 64u;
    case GS_PSM_T4:
    case GS_PSM_T4HL:
    case GS_PSM_T4HH:
        return 128u;
    default:
        return 32u;
    }
}

// Number of 8 KB pages a buffer of `bufferWidth64`*64 pixels by `heightPixels` occupies.
uint32_t GSGlBackend::pageSpan(uint32_t psm, uint32_t bufferWidth64, uint32_t heightPixels)
{
    uint32_t pageWidth = 64u;
    if (psm == GS_PSM_T8 || psm == GS_PSM_T8H || psm == GS_PSM_T4 || psm == GS_PSM_T4HL || psm == GS_PSM_T4HH)
        pageWidth = 128u;
    const uint32_t widthPixels = std::max<uint32_t>(1u, bufferWidth64) * 64u;
    const uint32_t pagesPerRow = std::max<uint32_t>(1u, (widthPixels + pageWidth - 1u) / pageWidth);
    const uint32_t rows = std::max<uint32_t>(1u, (heightPixels + pageHeightForPsm(psm) - 1u) / pageHeightForPsm(psm));
    return pagesPerRow * rows;
}

// ---------------------------------------------------------------------------------------------
// Game-thread side: recording
// ---------------------------------------------------------------------------------------------
void GSGlBackend::record(Cmd &&cmd, const uint8_t *data, size_t size)
{
    // Sprint 8 Goal 2 Task 1: term (c) -- the queue-mutex push on the GAME thread, the one term of
    // the tile path that is not on the render thread. Only Upload and BeginTransfer are timed:
    // every tile costs one of each, and timing Submit would fold the draw stream into the answer.
    static const bool s_uploadTrace = ps2x::knob("PS2X_GS_UPLOAD_TRACE") != nullptr;
    const bool traceThis = s_uploadTrace && (cmd.type == CmdType::Upload || cmd.type == CmdType::BeginTransfer);
    RecordTimer recordTimer{traceThis, traceThis ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{}};
    std::unique_lock<std::mutex> lock(m_queueMutex);
    // Sprint 8 Goal 5, ruling R124: the hard ceiling, checked before anything is admitted. The
    // soft cap below may never drop a state-carrying command -- dropping an upload or a CLUT load
    // would corrupt every frame the game draws after the stall -- so before Sprint 10 Q6 a replay
    // that stayed stalled grew the pending buffer on that stream alone until the allocator gave up
    // (KNOWN: "once the replay latched stalled, GsPendingCap::admit keeps every state-carrying
    // command unbounded", ending in std::bad_alloc). Above the ceiling the recorder therefore WAITS
    // for the replay to drain instead of admitting: back-pressure, not loss. Q6's coalescer (below)
    // now stops a LATCHED stall at the soft cap, so this ceiling is reached only by a replay that
    // is merely slow, or with PS2X_GS_PENDING_CAP_MB=0.
    //
    // The wait is bounded twice over so it can never become the deadlock it is protecting against:
    // each slice is 50 ms (the replay's swap notifies m_queueCv, so a live GL thread releases it at
    // once), and the whole wait for one command is capped at 5 s, after which the command is
    // admitted anyway and recording carries on. That matters at shutdown, when the GL thread is
    // already gone and nothing will ever drain the queue again.
    if (m_pendingCap.mustWait())
    {
        m_pendingCap.noteHardWait(); // once per command that waited, not once per slice
        const auto hardWaitDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
        while (m_pendingCap.mustWait() && std::chrono::steady_clock::now() < hardWaitDeadline)
            m_queueCv.wait_for(lock, std::chrono::milliseconds(50));
    }
    // Task 1b: while the replay is latched stalled (the modal size-move loop a title-bar drag puts
    // the GL thread in) the pending buffer is bounded in bytes. Draw work (Submit, Clear) is dropped
    // past the cap: the next guest frame records it again, so the only cost is frames the stalled
    // window could not show anyway. The fire-and-forget Readback goes with it -- it carries no data,
    // it is the auto-exposure thread asking for fresher pixels (~176 per pass, s6_lum5/6) and a
    // later one fetches the same or newer VRAM; the readbacks whose result is actually read back go
    // through postAndGetToken below and are never dropped. Everything else carries state the replay
    // cannot reconstruct from the queue alone (an upload, a transfer, a CLUT load, a VRAM write).
    const bool carriesState = !(cmd.type == CmdType::Submit || cmd.type == CmdType::Clear ||
                                cmd.type == CmdType::Readback);
    // Sprint 10 Goal 11 (Q6): past the cap on a latched stall, a state-carrying command is not
    // pended either -- admit() refuses it and it is absorbed (gs_stall_coalescer.h: the game
    // thread's VRAM already holds its effect, m_cpu applied it before this call), and the replay
    // is re-anchored from that VRAM when the latch clears. So the queue stops growing at the cap
    // for as long as the stall lasts, where before Q6 the state stream grew until R124's ceiling
    // (and before R124, until std::bad_alloc on the 8 GB VM).
    const bool latched = m_backpressure.latched();
    if (m_pendingCap.reanchorDue(latched))
        reanchorLocked();
    if (!m_pendingCap.admit(latched, carriesState, sizeof(Cmd) + size))
    {
        if (carriesState)
            absorbLocked(cmd, data, size);
        return;
    }
    pushLocked(std::move(cmd), data, size);
}

uint64_t GSGlBackend::postAndGetToken(Cmd &&cmd, const uint8_t *data, size_t size)
{
    std::lock_guard<std::mutex> lock(m_queueMutex);
    // Accounted, never dropped: every command posted here is waited on by its token (Reset, Present,
    // the blocking Readback), so dropping one would stall the game thread for the token's 2 s
    // timeout instead of saving memory.
    //
    // Q6 narrows that for Present alone: at the cap on a latched stall a Present is dropped like
    // the draw work it would show -- the next one carries the display registers again -- and its
    // token resolves with the last command issued (a frame dump's wait, the only waiter, then
    // returns at once or at its 2 s timeout, which a latched stall already cost it). Reset and the
    // blocking Readback are waited on for their effect and go in whatever the cap's state; a
    // Reset blanks both VRAMs, so it also blanks what the coalescer remembered before it.
    const bool latched = m_backpressure.latched();
    if (m_pendingCap.reanchorDue(latched))
        reanchorLocked(); // the plan precedes the command that will be waited on
    if (cmd.type == CmdType::Present)
    {
        if (!m_pendingCap.admit(latched, false, sizeof(Cmd) + size))
            return m_nextToken - 1u;
    }
    else
    {
        if (cmd.type == CmdType::Reset && m_coalescer.active())
            m_coalescer.noteReset();
        m_pendingCap.admitWaited(sizeof(Cmd) + size);
    }
    const uint64_t token = m_nextToken;
    pushLocked(std::move(cmd), data, size);
    return token;
}

void GSGlBackend::pushLocked(Cmd &&cmd, const uint8_t *data, size_t size)
{
    if (data && size)
    {
        cmd.dataOffset = m_pending.data.size();
        cmd.dataSize = size;
        m_pending.data.insert(m_pending.data.end(), data, data + size);
    }
    cmd.token = m_nextToken++;
    m_pending.commands.push_back(std::move(cmd));
}

// A state-carrying command admit() refused: the cap is absorbing. The first one of a stall
// engages the coalescer and is logged, once per engagement, so a run log shows the bound
// engaging (the controller's check on a real stall run: this line, then the "released" one from
// reanchorLocked when the window comes back).
void GSGlBackend::absorbLocked(const Cmd &cmd, const uint8_t *data, size_t size)
{
    const uint64_t bytes = sizeof(Cmd) + size;
    if (!m_coalescer.active())
    {
        m_coalescer.engage();
        std::fprintf(stderr, "[gs-gl] stall bound engaged: the replay is latched stalled with %llu MB of commands pending; uploads, transfers, CLUT loads and VRAM writes are absorbed into the game VRAM until it drains (engagement %llu)%c",
                     static_cast<unsigned long long>(m_pendingCap.bytes() / (1024ull * 1024ull)),
                     static_cast<unsigned long long>(m_pendingCap.absorptions()), 10);
    }
    switch (cmd.type)
    {
    case CmdType::BeginTransfer:
    {
        const GSTransferCommand &t = cmd.transfer;
        const uint32_t page = t.bitbltbuf.dbp >> 5;
        const uint32_t span = pageSpan(t.bitbltbuf.dpsm, t.bitbltbuf.dbw, t.trxpos.dsay + t.trxreg.rrh);
        m_coalescer.noteTransfer(t, page, span, bytes);
        break;
    }
    case CmdType::Upload:
    {
        // The chunk's pixels went into the game VRAM in UploadImage, before record(); what is
        // remembered is the rectangle of the transfer they belong to.
        const GSTransferCommand &t = m_gameTransfer;
        const uint32_t page = t.bitbltbuf.dbp >> 5;
        const uint32_t span = pageSpan(t.bitbltbuf.dpsm, t.bitbltbuf.dbw, t.trxpos.dsay + t.trxreg.rrh);
        m_coalescer.noteUpload(t, page, span, bytes);
        break;
    }
    case CmdType::WriteVram:
        m_coalescer.noteWriteVram(cmd.args[0], cmd.args[1], cmd.args[2], cmd.args[3] & 0xFFFFu, cmd.args[3] >> 16,
                                  cmd.args[1] >> 5, bytes);
        break;
    case CmdType::ClutLoad:
        if (data && size >= sizeof(GSClutLoad))
        {
            GSClutLoad load;
            std::memcpy(&load, data, sizeof(GSClutLoad));
            m_coalescer.noteClut(load, bytes);
        }
        break;
    default:
        // Nothing else is refused as state: record()'s carriesState names exactly the four above.
        break;
    }
}

// The latch cleared with an engagement open: push what the replay needs to draw the next frame from
// the VRAM the game has now, in this order -- the palettes (the replay's m_cluts by id), one
// complete host->local transfer per remembered rectangle with the rectangle's bytes as they are in
// the game VRAM now, then the in-flight transfer's own state (BeginTransfer plus the chunks already
// taken, re-read from the same VRAM) so the game's next chunk lands in its own row on the shadow.
// Every rectangle writes the truth, so their order among themselves does not matter; the palettes
// go first because the draws that follow name them.
void GSGlBackend::reanchorLocked()
{
    m_pendingCap.endAbsorbing();
    if (!m_coalescer.active())
        return; // nothing was ever handed to it (cannot happen: the first refusal engages it)
    const GsStallCoalescer::Plan plan = m_coalescer.finish();
    uint64_t pushed = 0u;
    const auto push = [&](Cmd &&cmd, const uint8_t *data, size_t size)
    {
        pushed += sizeof(Cmd) + size;
        m_pendingCap.admitWaited(sizeof(Cmd) + size); // accounted; never refused (the consumer is live)
        pushLocked(std::move(cmd), data, size);
    };
    for (const GSClutLoad &load : plan.cluts)
    {
        Cmd cmd;
        cmd.type = CmdType::ClutLoad;
        push(std::move(cmd), reinterpret_cast<const uint8_t *>(&load), sizeof(GSClutLoad));
    }
    // One 4 MB copy under the CPU backend's own lock (the render thread's GPU downloads write that
    // VRAM too), then every rectangle is packed from the copy.
    const GSTransferSnapshot inFlight = m_cpu->GetTransferSnapshot();
    const bool transferOpen = inFlight.direction == 0u && inFlight.totalPixels != 0u;
    if (!plan.rects.empty() || (transferOpen && inFlight.copiedPixels != 0u))
        m_cpu->SnapshotVram(m_reanchorVram);
    size_t rectsPushed = 0u;
    for (const GsStallCoalescer::Rect &r : plan.rects)
    {
        if (m_reanchorVram.empty() || !GsStallCoalescer::packRect(m_reanchorVram.data(), r, m_reanchorData))
            continue; // cannot happen for a planned rectangle (an unreadable format forces the page plan)
        Cmd begin;
        begin.type = CmdType::BeginTransfer;
        begin.transfer = GsStallCoalescer::transferFor(r);
        push(std::move(begin), nullptr, 0u);
        Cmd upload;
        upload.type = CmdType::Upload;
        push(std::move(upload), m_reanchorData.data(), m_reanchorData.size());
        ++rectsPushed;
    }
    if (transferOpen)
    {
        Cmd begin;
        begin.type = CmdType::BeginTransfer;
        begin.transfer = m_gameTransfer;
        push(std::move(begin), nullptr, 0u);
        if (inFlight.copiedPixels != 0u && !m_reanchorVram.empty() &&
            GsStallCoalescer::packPrefix(m_reanchorVram.data(), m_gameTransfer, inFlight.copiedPixels, m_reanchorData))
        {
            Cmd upload;
            upload.type = CmdType::Upload;
            push(std::move(upload), m_reanchorData.data(), m_reanchorData.size());
        }
    }
    m_coalescer.noteReanchorBytes(pushed);
    std::fprintf(stderr, "[gs-gl] stall bound released: %llu commands (%llu MB) absorbed over the stall, re-anchored as %zu palettes + %zu rectangles%s%s (%llu KB pushed)%c",
                 static_cast<unsigned long long>(plan.absorbedCommands),
                 static_cast<unsigned long long>(plan.absorbedBytes / (1024ull * 1024ull)),
                 plan.cluts.size(), rectsPushed, plan.pagesOnly ? " (per page)" : "",
                 transferOpen ? " + the open transfer" : "",
                 static_cast<unsigned long long>(pushed / 1024ull), 10);
}

void GSGlBackend::waitForToken(uint64_t token)
{
    if (std::this_thread::get_id() == m_renderThread)
    {
        // Called on the GL thread (debug readback): execute inline.
        CommandBuffer &buffer = m_executing;
        buffer.clear();
        uint64_t framesTaken = 0u;
        {
            std::lock_guard<std::mutex> lock(m_queueMutex);
            buffer.commands.swap(m_pending.commands);
            buffer.data.swap(m_pending.data);
            m_pendingCap.onReplayed(buffer.commands.size() * sizeof(Cmd) + buffer.data.size());
            framesTaken = m_backpressure.recordedFrames();
        }
        // R124: the bytes are gone from the queue, so a recorder parked at the hard ceiling may go
        // now -- it must not have to wait out executeCommands (which notifies for the tokens).
        m_queueCv.notify_all();
        executeCommands(buffer);
        m_backpressure.framesReplayed(framesTaken);
        return;
    }
    if (!m_glReady.load(std::memory_order_acquire))
        return; // no GL yet (early boot): nothing to wait for
    std::unique_lock<std::mutex> lock(m_queueMutex);
    // #67: nor while the main thread is in the window's move loop (SetHostMoveLoop): nothing replays until it ends.
    m_queueCv.wait_for(lock, std::chrono::seconds(2), [&]
                       { return m_executedToken.load(std::memory_order_acquire) >= token ||
                                m_backpressure.consumerSuspended(); });
}

bool GSGlBackend::pagesMayBeGpuDirty(uint32_t page, uint32_t pageCount) const
{
    std::lock_guard<std::mutex> lock(m_dirtyMutex);
    for (uint32_t p = page; p < page + pageCount && p < 512u; ++p)
        if (m_gpuDirtyPages[p])
            return true;
    return false;
}

void GSGlBackend::syncDirtyPagesForRead(uint32_t page, uint32_t pageCount) const
{
    if (!pagesMayBeGpuDirty(page, pageCount))
        return;
    auto *self = const_cast<GSGlBackend *>(this);
    Cmd cmd;
    cmd.type = CmdType::Readback;
    const uint64_t token = self->postAndGetToken(std::move(cmd));
    self->waitForToken(token);
    std::lock_guard<std::mutex> lock(m_dirtyMutex);
    self->m_gpuDirtyPages.fill(0u);
}

void GSGlBackend::markRtDirtyFromFrame(const GSContext &context)
{
    const uint32_t height = std::min<uint32_t>(kRtHeight, static_cast<uint32_t>(context.scissor.y1) + 1u);
    const uint32_t span = pageSpan(context.frame.psm, context.frame.fbw, height);
    std::lock_guard<std::mutex> lock(m_dirtyMutex);
    for (uint32_t p = context.frame.fbp; p < context.frame.fbp + span && p < 512u; ++p)
        m_gpuDirtyPages[p] = 1u;
    if (!context.zbuf.zmask)
    {
        const uint32_t zspan = pageSpan(context.zbuf.psm, context.frame.fbw, height);
        for (uint32_t p = context.zbuf.zbp; p < context.zbuf.zbp + zspan && p < 512u; ++p)
            m_gpuDirtyPages[p] = 1u;
    }
}

void GSGlBackend::Submit(const GSPrimitiveBatch &batch)
{
    markRtDirtyFromFrame(batch.state.context);
    Cmd cmd;
    cmd.type = CmdType::Submit;
    cmd.batch = batch;
    record(std::move(cmd));
}

void GSGlBackend::BeginTransfer(const GSTransferCommand &command)
{
    // This used to run `m_currentTransfer = command;`, and that was the intro-movie macroblock bug
    // (research/16 section 9). m_currentTransfer is what executeUpload reads to decide which
    // rectangle of the render target to mark dirty; executeTransfer sets it on the RENDER thread
    // immediately before the upload it belongs to. This function runs on the GAME thread, which
    // queues ahead of the render thread -- so a write here landed between the render thread's
    // executeTransfer and its executeUpload, and the upload marked a rectangle belonging to some
    // later transfer. The shadow VRAM was unaffected (GSCpuBackend keeps its own m_transfer under
    // its own mutex), so the block sat in shadow VRAM and never reached the GL texture, which kept
    // whatever it held: the reported flickering black 16x16 rectangles.
    //
    // Counted with a temporary counter over a title_menu.txt run (research/16 section 9): of
    // 12 205 741 16x16 transfers, 3 748 never reached refreshRenderTargetsFromShadow, and ZERO of
    // those came from the partial-delivery path the note first suspected. After this change the
    // deficit is 0, and movie_blocks.py over the same capture goes from MISSING blocks=9 to 0.
    // Those two numbers are the evidence. The same run also measured that the game thread had
    // already advanced past the transfer being uploaded on 12 240 952 of 12 241 344 uploads --
    // exposure, not proven stale reads, from instrumentation that is no longer in the tree;
    // research/16 section 9.3 says what it does and does not establish.
    //
    // Nothing on the game thread reads m_currentTransfer, so the write is deleted outright rather
    // than duplicated into a second member.
    // Local->host and local->local read GS memory: make sure GPU-drawn pages are downloaded first.
    if (command.direction == 1u || command.direction == 2u)
    {
        const uint32_t page = command.bitbltbuf.sbp >> 5;
        const uint32_t span = pageSpan(command.bitbltbuf.spsm, command.bitbltbuf.sbw,
                                       command.trxpos.ssay + command.trxreg.rrh);
        syncDirtyPagesForRead(page, span);
    }
    m_cpu->BeginTransfer(command);
    m_gameTransfer = command; // Q6: an absorbed Upload chunk belongs to this; the re-anchor restores it
    Cmd cmd;
    cmd.type = CmdType::BeginTransfer;
    cmd.transfer = command;
    record(std::move(cmd));
}

void GSGlBackend::UploadImage(const uint8_t *data, uint32_t sizeBytes)
{
    m_cpu->UploadImage(data, sizeBytes);
    Cmd cmd;
    cmd.type = CmdType::Upload;
    record(std::move(cmd), data, sizeBytes);
}

void GSGlBackend::LoadClut(const GSClutLoad &load)
{
    Cmd cmd;
    cmd.type = CmdType::ClutLoad;
    record(std::move(cmd), reinterpret_cast<const uint8_t *>(&load), static_cast<uint32_t>(sizeof(GSClutLoad)));
}

void GSGlBackend::Flush() {}
void GSGlBackend::TextureFlush() {}

void GSGlBackend::Sync(GSSyncReason reason)
{
    if (reason == GSSyncReason::DebugReadback || reason == GSSyncReason::Reset)
    {
        Cmd cmd;
        cmd.type = CmdType::Readback;
        const uint64_t token = postAndGetToken(std::move(cmd));
        waitForToken(token);
        std::lock_guard<std::mutex> lock(m_dirtyMutex);
        m_gpuDirtyPages.fill(0u);
    }
}

PresentationFrame GSGlBackend::Present(const GSPresentationRequest &request)
{
    static const bool s_wantPixels = ps2x::knob("PS2X_FRAME_DUMP") != nullptr;
    PresentationFrame frame{};
    Cmd cmd;
    cmd.type = CmdType::Present;
    cmd.present = request;
    cmd.args[0] = s_wantPixels ? 1u : 0u;
    const uint64_t token = postAndGetToken(std::move(cmd));

    const GSFrameReg display1 = decodeDisplayFrame(request.dispfb1);
    uint32_t width = 0u, height = 0u;
    decodeDisplaySize(request.display1, width, height);
    frame.width = width;
    frame.height = height;
    frame.displayFbp = display1.fbp;
    frame.sourceFbp = display1.fbp;
    if (s_wantPixels)
    {
        waitForToken(token);
        std::lock_guard<std::mutex> lock(m_queueMutex);
        frame.pixels = m_presentPixels;
        if (frame.pixels.size() != static_cast<size_t>(kHostFrameWidth) * kHostFrameHeight * 4u)
            frame.pixels.clear();
    }
    return frame;
}

bool GSGlBackend::ClearFramebuffer(const GSContext &context, uint32_t rgba)
{
    markRtDirtyFromFrame(context);
    Cmd cmd;
    cmd.type = CmdType::Clear;
    cmd.context = context;
    cmd.args[0] = rgba;
    record(std::move(cmd));
    return true;
}

uint32_t GSGlBackend::ConsumeLocalToHostBytes(uint8_t *dst, uint32_t maxBytes)
{
    return m_cpu->ConsumeLocalToHostBytes(dst, maxBytes);
}

uint32_t GSGlBackend::ReadVram(uint32_t psm, uint32_t base, uint32_t bw, uint32_t x, uint32_t y) const
{
    syncDirtyPagesForRead(base >> 5, 1u + pageSpan(psm, bw, y + 1u));
    return m_cpu->ReadVram(psm, base, bw, x, y);
}

uint32_t GSGlBackend::PeekVram(uint32_t psm, uint32_t base, uint32_t bw, uint32_t x, uint32_t y) const
{
    return m_cpu->ReadVram(psm, base, bw, x, y);
}

void GSGlBackend::RequestVramReadback()
{
    // The game thread must not wait here: SOCOM II's auto-exposure thread reads frame pixels ~176 times per pass,
    // and one blocking sync per 100 ms already held the single EE host thread for the GL backlog each time
    // (s6_lum5/6: the pad went unanswered). The Readback executes in stream order; PeekVram sees it after.
    Cmd cmd;
    cmd.type = CmdType::Readback;
    record(std::move(cmd));
}

void GSGlBackend::WriteVram(uint32_t psm, uint32_t base, uint32_t bw, uint32_t x, uint32_t y, uint32_t value)
{
    m_cpu->WriteVram(psm, base, bw, x, y, value);
    Cmd cmd;
    cmd.type = CmdType::WriteVram;
    cmd.args[0] = psm;
    cmd.args[1] = base;
    cmd.args[2] = bw;
    cmd.args[3] = x | (y << 16);
    cmd.args[4] = value;
    record(std::move(cmd));
}

void GSGlBackend::SnapshotVram(std::vector<uint8_t> &out) const
{
    syncDirtyPagesForRead(0u, 512u);
    m_cpu->SnapshotVram(out);
}

GSTransferSnapshot GSGlBackend::GetTransferSnapshot() const
{
    return m_cpu->GetTransferSnapshot();
}

// ---------------------------------------------------------------------------------------------
// Render-thread side
// ---------------------------------------------------------------------------------------------
bool GSGlBackend::glUnavailableForProcess()
{
    return g_glUnavailable.load(std::memory_order_acquire);
}

std::string GSGlBackend::glMissingForProcess()
{
    std::lock_guard<std::mutex> lock(g_glMissingMutex);
    return g_glMissing;
}

// Task 1a: the probe failed, or the shaders did. Latch it, say once what is missing, and let the
// runtime swap in the CPU rasterizer. ensureGl() never tries again.
void GSGlBackend::latchGlUnsupported(const GsGlCaps::Report &report)
{
    m_glCapsLatch.fail(report);
    {
        std::lock_guard<std::mutex> lock(g_glMissingMutex);
        g_glMissing = m_glCapsLatch.report().missing;
    }
    g_glUnavailable.store(true, std::memory_order_release);
    std::fprintf(stderr,
                 "[gs-gl] UNSUPPORTED: %s; falling back to the CPU rasterizer (PS2X_GS_BACKEND=cpu)\n",
                 m_glCapsLatch.report().missing.c_str());
}

bool GSGlBackend::ensureGl()
{
    if (m_program != 0u)
        return true;
    // Task 1a: a machine that failed the probe (or the shader compile) never tries again.
    if (!m_glCapsLatch.shouldAttempt())
        return false;
    if (!IsWindowReady())
        return false;
    m_glCapsLatch.attempted();
    // research/26: exact integer z in the depth test. PS2X_GS_DEPTH_LEGACY=1 restores the old
    // z*2-1 mapping for A/B.
    {
        static bool s_chosen = false;
        if (!s_chosen)
        {
            s_chosen = true;
            const bool legacy = GsGlDepth::legacyRequested(ps2x::knob("PS2X_GS_DEPTH_LEGACY"));
            g_clipControl = legacy ? nullptr : probeClipControl();
            g_depthMode = GsGlDepth::choose(legacy, g_clipControl != nullptr);
            std::fprintf(stderr, "[gs-gl] depth mapping: %s\n", GsGlDepth::name(g_depthMode));
        }
    }
    // Task 1a (audit 2026-09-17 s2.2 F2): GL 3.3, dual-source blending and clip control, probed
    // once. probeClipControl() is re-run rather than reading g_clipControl, which
    // PS2X_GS_DEPTH_LEGACY deliberately clears.
    {
        const GsGlCaps::Report report = GsGlCaps::evaluate(reinterpret_cast<const char *>(glGetString(GL_VERSION)),
                                                           probeDualSourceBlend(),
                                                           probeClipControl() != nullptr);
        if (!report.ok)
        {
            latchGlUnsupported(report);
            return false;
        }
        if (!report.note.empty())
            std::fprintf(stderr, "[gs-gl] note: %s\n", report.note.c_str());
    }
    const std::string vsSource = withDepthMode(kVertexShader, g_depthMode);
    const std::string fsSource = withDepthMode(kFragmentShader, g_depthMode);
    const uint32_t vs = compileShader(GL_VERTEX_SHADER, vsSource.c_str());
    const uint32_t fs = compileShader(GL_FRAGMENT_SHADER, fsSource.c_str());
    if (!vs || !fs)
    {
        GsGlCaps::Report shaders;
        shaders.ok = false;
        shaders.missing = "a working OpenGL 3.3 shader compiler (the backend's shaders did not compile)";
        latchGlUnsupported(shaders);
        return false;
    }
    m_program = glCreateProgram();
    glAttachShader(m_program, vs);
    glAttachShader(m_program, fs);
    glBindFragDataLocationIndexed(m_program, 0, 0, "oColor");
    glBindFragDataLocationIndexed(m_program, 0, 1, "oBlendAlpha");
    glLinkProgram(m_program);
    GLint ok = 0;
    glGetProgramiv(m_program, GL_LINK_STATUS, &ok);
    glDeleteShader(vs);
    glDeleteShader(fs);
    if (!ok)
    {
        char log[2048];
        glGetProgramInfoLog(m_program, sizeof(log), nullptr, log);
        std::fprintf(stderr, "[gs-gl] program link failed: %s\n", log);
        glDeleteProgram(m_program);
        m_program = 0u;
        GsGlCaps::Report link;
        link.ok = false;
        link.missing = "an OpenGL 3.3 driver that links the backend's shaders";
        latchGlUnsupported(link);
        return false;
    }
    auto uni = [&](const char *name) { return glGetUniformLocation(m_program, name); };
    m_u.rtSize = uni("uRtSize");
    m_u.tex = uni("uTex");
    m_u.texSize = uni("uTexSize");
    m_u.tme = uni("uTme");
    m_u.tfx = uni("uTfx");
    m_u.tcc = uni("uTcc");
    m_u.fst = uni("uFst");
    m_u.wrapU = uni("uWrapU");
    m_u.wrapV = uni("uWrapV");
    m_u.region = uni("uRegion");
    m_u.ate = uni("uAte");
    m_u.atst = uni("uAtst");
    m_u.afail = uni("uAfail");
    m_u.aref = uni("uAref");
    m_u.fge = uni("uFge");
    m_u.fogColor = uni("uFogColor");
    m_u.fba = uni("uFba");
    m_u.srcMode = uni("uSrcMode");
    m_u.srcConst = uni("uSrcConst");

    glGenVertexArrays(1, &m_vao);
    glGenBuffers(1, &m_vbo);
    glBindVertexArray(m_vao);
    glBindBuffer(GL_ARRAY_BUFFER, m_vbo);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, sizeof(GlVertex), reinterpret_cast<void *>(offsetof(GlVertex, x)));
    glEnableVertexAttribArray(1);
    glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, sizeof(GlVertex), reinterpret_cast<void *>(offsetof(GlVertex, s)));
    glEnableVertexAttribArray(2);
    glVertexAttribPointer(2, 4, GL_UNSIGNED_BYTE, GL_TRUE, sizeof(GlVertex), reinterpret_cast<void *>(offsetof(GlVertex, r)));
    glEnableVertexAttribArray(3);
    glVertexAttribPointer(3, 1, GL_FLOAT, GL_FALSE, sizeof(GlVertex), reinterpret_cast<void *>(offsetof(GlVertex, fog)));
    glBindVertexArray(0);
    m_renderThread = std::this_thread::get_id();
    m_glReady.store(true, std::memory_order_release);
    std::fprintf(stderr, "[gs-gl] initialised: %s\n", reinterpret_cast<const char *>(glGetString(GL_VERSION)));
    return true;
}

bool GSGlBackend::GuestFrameBoundary()
{
    // Nothing replays before ensureGl(), and the GL thread never waits on itself.
    if (!m_glReady.load(std::memory_order_acquire) || std::this_thread::get_id() == m_renderThread)
        return false;
    const GsFrameBackpressure::WaitResult result = m_backpressure.frameRecorded();
    if (result == GsFrameBackpressure::WaitResult::Waited)
        return true;
    if (result != GsFrameBackpressure::WaitResult::TimedOut)
        return false;
    // A cap hit: the GL thread made no progress (no heartbeat) for the whole cap (window drag in the
    // modal pump, hang, exit). Log it at most once per 10 s; the latch means the EE does not wait
    // again until the GL thread shows progress.
    static uint64_t s_capHits = 0u;
    static std::chrono::steady_clock::time_point s_lastLog{};
    ++s_capHits;
    const auto now = std::chrono::steady_clock::now();
    if (s_lastLog == std::chrono::steady_clock::time_point{} || now - s_lastLog >= std::chrono::seconds(10))
    {
        s_lastLog = now;
        std::fprintf(stderr, "[gs-gl] back-pressure: replay made no progress within %lld ms (N=%u, %llu frames pending, %llu cap hits); the EE runs on until it does\n",
                     static_cast<long long>(GsFrameBackpressure::kDefaultWaitCap.count()), m_backpressure.maxPendingFrames(),
                     static_cast<unsigned long long>(m_backpressure.pendingFrames()), static_cast<unsigned long long>(s_capHits));
    }
    return true;
}

void GSGlBackend::ReleaseHostBackpressure()
{
    m_backpressure.release();
}

// Issue #67: the main thread is in the window's modal move loop (a title-bar drag), where it cannot replay. The frame
// back-pressure stands aside (and reads latched, so the pending cap bounds the queue in bytes and the coalescer
// re-anchors once the loop ends, Q6), and a game thread waiting on a token -- a blocking Readback or a Reset, each a
// 2 s timeout otherwise, which kept the guest clock crawling after the frame wait had latched -- goes on without it,
// as it would at that timeout. The queue mutex is taken so a waiter between its predicate and its sleep cannot miss
// the wake.
void GSGlBackend::SetHostMoveLoop(bool inLoop)
{
    m_backpressure.setConsumerSuspended(inLoop);
    {
        std::lock_guard<std::mutex> lock(m_queueMutex);
    }
    m_queueCv.notify_all();
}

bool GSGlBackend::HostRenderFrame()
{
    if (!ensureGl())
        return false;
    m_backpressure.consumerProgress(); // R40: the host loop is alive and about to replay
    // The executed buffer is a member so its capacity (commands and upload bytes) is handed back
    // to m_pending by the swap: no vector growth on the game thread every frame (~7% of it).
    CommandBuffer &buffer = m_executing;
    buffer.clear();
    // The frame count is read under the same lock as the swap: GuestFrameBoundary counts a frame
    // only after its commands were recorded (under m_queueMutex), so this is exactly the frames in
    // `buffer`. It is reported replayed even when the buffer is empty (a frame with no GS work).
    uint64_t framesTaken = 0u;
    {
        std::lock_guard<std::mutex> lock(m_queueMutex);
        buffer.commands.swap(m_pending.commands);
        buffer.data.swap(m_pending.data);
        m_pendingCap.onReplayed(buffer.commands.size() * sizeof(Cmd) + buffer.data.size());
        framesTaken = m_backpressure.recordedFrames();
    }
    // R124: as above. Note executeCommands is skipped for an empty buffer, so this is the only
    // notify on that path -- and an empty swap is exactly when a waiter needs telling that the
    // queue it is parked behind is already drained.
    m_queueCv.notify_all();
    if (!buffer.commands.empty())
        executeCommands(buffer);
    m_backpressure.framesReplayed(framesTaken);
    // Restore raylib's expectations.
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glDisable(GL_SCISSOR_TEST);
    glDisable(GL_DEPTH_TEST);
    glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    glBlendEquation(GL_FUNC_ADD);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    glViewport(0, 0, GetScreenWidth(), GetScreenHeight());
    glUseProgram(0);
    glBindVertexArray(0);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, 0);
    return m_presentTexture != 0u;
}

uint32_t GSGlBackend::HostFrameTexture(uint32_t &width, uint32_t &height, uint32_t &textureWidth, uint32_t &textureHeight)
{
    // Host texels, paired with the host-sized m_presentTexWidth/Height: ps2_runtime builds its
    // srcRect out of these four and aspect-fits the result, so scaling all four together leaves the
    // aspect ratio alone and simply hands raylib a sharper texture to minify.
    width = m_presentHostWidth;
    height = m_presentHostHeight;
    textureWidth = m_presentTexWidth;
    textureHeight = m_presentTexHeight;
    return m_presentTexture;
}

// PS2X_GS_TRACE_PRESENT / PS2X_GS_TRACE_CMDS=<n>: trace after present n; a negative n counts from
// the first movie block upload (SOCOM II's intro movie starts at a different present count per run).
// Wall-clock time of day for trace lines, so a [gs-cmd] line can be lined up with the drive log's step
// times (the run log's name carries the launch time to the second).
// "0x38a4,0x38a8": the block pointers a PS2X_GS_*_TBP0 filter accepts (the game repacks its streamed texture region
// every few frames, so one texture sits at more than one block over a run).
static std::vector<long> traceBlockList(const char *e)
{
    std::vector<long> out;
    while (e && *e)
    {
        char *end = nullptr;
        const long v = std::strtol(e, &end, 0);
        if (end == e)
            break;
        out.push_back(v);
        e = (*end == ',') ? end + 1 : end;
    }
    return out;
}

static bool traceBlockMatch(const std::vector<long> &list, uint32_t tbp0)
{
    return list.empty() || std::find(list.begin(), list.end(), static_cast<long>(tbp0)) != list.end();
}

static const char *traceTimeOfDay()
{
    static char buf[32];
    const auto now = std::chrono::system_clock::now();
    const std::time_t t = std::chrono::system_clock::to_time_t(now);
    const int ms = static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count() % 1000);
    std::tm tmv{};
#ifdef _WIN32
    localtime_s(&tmv, &t);
#else
    localtime_r(&t, &tmv);
#endif
    std::snprintf(buf, sizeof(buf), "%02d:%02d:%02d.%03d", tmv.tm_hour, tmv.tm_min, tmv.tm_sec, ms);
    return buf;
}

long GSGlBackend::traceSkip(const char *env) const
{
    // The trace switches never change during a run: cache the lookups (std::getenv here was ~4%
    // of the GL thread with tracing off; the callers are on every upload/download/refresh).
    struct CachedEnv
    {
        const char *name;
        const char *value;
    };
    static CachedEnv s_cache[8] = {};
    static int s_cacheCount = 0;
    const char *e = nullptr;
    bool found = false;
    for (int i = 0; i < s_cacheCount; ++i)
    {
        if (s_cache[i].name == env || std::strcmp(s_cache[i].name, env) == 0)
        {
            e = s_cache[i].value;
            found = true;
            break;
        }
    }
    if (!found)
    {
        e = ps2x::knob(env);
        if (s_cacheCount < 8)
            s_cache[s_cacheCount++] = {env, e};
    }
    if (!e)
        return -1;
    if (e[0] == 't' && e[1] == 'r')   // "trig": armed by PS2X_TRIGGER (game-state trigger in the PC sampler)
    {
        extern std::atomic<bool> g_ps2xTraceArmed;
        return g_ps2xTraceArmed.load() ? 0L : 0x7FFFFFF0L;
    }
    if (e[0] == 't')   // "t<seconds>": host-time trigger (any frame once that much time has passed)
    {
        static const auto s_epoch = std::chrono::steady_clock::now();
        const double elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - s_epoch).count();
        return elapsed >= std::atof(e + 1) ? 0L : 0x7FFFFFF0L;
    }
    const long v = std::strtol(e, nullptr, 0);
    if (v >= 0)
        return v;
    if (v == -1)   // seam-relative: from the decode that first shows the movie seam
        return m_seamFrame ? static_cast<long>(m_seamFrame) - 1 : 0x7FFFFFF0L;
    if (m_movieStartFrame == 0u)
        return 0x7FFFFFF0L;
    return static_cast<long>(m_movieStartFrame) - v;
}

void GSGlBackend::executeCommands(CommandBuffer &buffer)
{
    static const bool s_stats = ps2x::knob("PS2X_GS_STATS") != nullptr;
    // Sprint 8 Goal 2 Task 1: PS2X_GS_UPLOAD_TRACE=1 -- the per-call breakdown of the tile upload
    // path, on the same 60-call cadence as [gs-gl stats]. Read once; with it unset nothing below
    // reads a clock or touches a counter.
    static const bool s_uploadTrace = ps2x::knob("PS2X_GS_UPLOAD_TRACE") != nullptr;
    static double s_time[8] = {0};
    static uint64_t s_count[8] = {0};
    static uint64_t s_calls = 0;
    static uint64_t s_bytes = 0;
    static auto s_lastReport = std::chrono::steady_clock::now();
    s_bytes += buffer.data.size();
    // PS2X_GS_TRACE_CMDS=<presents to skip>: then print the next 4000 replayed commands.
    static const char *s_traceEnv = ps2x::knob("PS2X_GS_TRACE_CMDS");
    static const bool s_traceCmds = s_traceEnv != nullptr;
    static uint32_t s_traceLines = 0;
    // PS2X_GS_TRACE_PRESENT: which replayed command changes the movie staging area (page row 3 of
    // base 0: frame rows 96..128, page columns 0 and 6) — first non-black row of the two columns.
    const long s_probeSkip = traceSkip("PS2X_GS_TRACE_PRESENT");
    auto probe = [this](uint32_t base, uint32_t c) -> int {
        for (uint32_t y = 90u; y < 340u; ++y)
        {
            uint32_t sum = 0, cnt = 0;
            for (uint32_t x = c * 64u; x < c * 64u + 64u; x += 4u, ++cnt)
            {
                const uint32_t p = readVramRaw(m_shadowMemory.data(), GS_PSM_CT32, base, 10u, x, y);
                sum += ((p & 0xFFu) + ((p >> 8) & 0xFFu) + ((p >> 16) & 0xFFu)) / 3u;
            }
            if (sum > 8u * cnt)
                return static_cast<int>(y);
        }
        return -1;
    };
    const bool probeOn = s_probeSkip >= 0 && static_cast<long>(m_frameCounter) > s_probeSkip && static_cast<long>(m_frameCounter) <= s_probeSkip + 3;
    static int s_probe[4] = {-2, -2, -2, -2};
    // R40 heartbeat: a live replay of a big batch must not look like a stalled consumer to the
    // recorder's capped back-pressure wait. One lock-free bump per 64 commands (and at entry).
    m_backpressure.consumerProgress();
    // research/26: guest draws use GL_ZERO_TO_ONE so window depth = aPos.z exactly. Clip control is
    // context-global, and raylib's own 2D drawing (ortho z at ndc -1) would clip under it, so it is
    // restored at the end of the replay. The resolve pass's z = 0 is inside [0, w] either way.
    const bool clipZeroToOne = g_depthMode == GsGlDepth::Mode::ClipZeroToOne && g_clipControl != nullptr;
    if (clipZeroToOne)
        g_clipControl(GL_LOWER_LEFT, GL_ZERO_TO_ONE);
    uint32_t heartbeatCountdown = 64u;
    for (Cmd &cmd : buffer.commands)
    {
        if (--heartbeatCountdown == 0u)
        {
            heartbeatCountdown = 64u;
            m_backpressure.consumerProgress();
        }
        const auto t0 = std::chrono::steady_clock::now();
        if (probeOn)
        {
            const int p[4] = {probe(0u, 2u), probe(0u, 6u), probe(0x1180u, 2u), probe(0x1180u, 6u)};
            if (p[0] != s_probe[0] || p[1] != s_probe[1] || p[2] != s_probe[2] || p[3] != s_probe[3])
            {
                std::fprintf(stderr, "[gs-gl probe] frame=%llu before cmd type=%u (dbp=%05x at %u,%u %ux%u): base0 col2=%d col6=%d | base1180 col2=%d col6=%d\n",
                             (unsigned long long)m_frameCounter, static_cast<unsigned>(cmd.type),
                             cmd.transfer.bitbltbuf.dbp, cmd.transfer.trxpos.dsax, cmd.transfer.trxpos.dsay,
                             cmd.transfer.trxreg.rrw, cmd.transfer.trxreg.rrh, p[0], p[1], p[2], p[3]);
                for (int i = 0; i < 4; ++i)
                    s_probe[i] = p[i];
            }
        }
        static const uint32_t s_traceMax = ps2x::knob("PS2X_GS_TRACE_CMDS_MAX") ? static_cast<uint32_t>(std::strtoul(ps2x::knob("PS2X_GS_TRACE_CMDS_MAX"), nullptr, 0)) : 4000u;
        static const long s_traceFrom = ps2x::knob("PS2X_GS_TRACE_CMDS_FROM") ? std::strtol(ps2x::knob("PS2X_GS_TRACE_CMDS_FROM"), nullptr, 0) : -1L;
        if (s_traceCmds && s_traceLines < s_traceMax &&
            (s_traceFrom >= 0 ? static_cast<long>(m_frameCounter) >= s_traceFrom : static_cast<long>(m_frameCounter) >= traceSkip("PS2X_GS_TRACE_CMDS")))
        {
            // PS2X_GS_TRACE_CMDS_TBP0=<block>: print only the submits that bind that texture (transfers, uploads
            // and the rest still print); PS2X_GS_TRACE_CMDS_PER_FRAME=<n>: at most n submit lines per frame. Together
            // they let a trace stay armed across a whole mission (the water pass: research/31 section 8) instead of
            // the ~5 s a 400k-line cap covers when every submit prints.
            static const std::vector<long> s_traceTbp0 = traceBlockList(ps2x::knob("PS2X_GS_TRACE_CMDS_TBP0"));
            static const uint32_t s_tracePerFrame = ps2x::knob("PS2X_GS_TRACE_CMDS_PER_FRAME") ? static_cast<uint32_t>(std::strtoul(ps2x::knob("PS2X_GS_TRACE_CMDS_PER_FRAME"), nullptr, 0)) : 0u;
            static unsigned long long s_traceFrameSeen = ~0ull;
            static uint32_t s_traceFrameLines = 0u;
            if (m_frameCounter != s_traceFrameSeen)
            {
                s_traceFrameSeen = m_frameCounter;
                s_traceFrameLines = 0u;
            }
            // PS2X_GS_TRACE_CMDS_BOX=x0,y0,x1,y1 (screen pixels, after XYOFFSET): print only the submits whose vertex
            // bounding box touches that box -- "which draws cover this shard pixel" (research/31 section 10).
            static const std::vector<long> s_traceBox = traceBlockList(ps2x::knob("PS2X_GS_TRACE_CMDS_BOX"));
            bool boxHit = true;
            if (cmd.type == CmdType::Submit && s_traceBox.size() >= 4u && cmd.batch.vertexCount > 0u)
            {
                float bx0 = 1e30f, bx1 = -1e30f, by0 = 1e30f, by1 = -1e30f;
                for (uint8_t k = 0; k < cmd.batch.vertexCount; ++k)
                {
                    const GSVertex &v = cmd.batch.vertices[k];
                    bx0 = std::min(bx0, v.x); bx1 = std::max(bx1, v.x);
                    by0 = std::min(by0, v.y); by1 = std::max(by1, v.y);
                }
                const float ox = static_cast<float>(cmd.batch.state.context.xyoffset.ofx >> 4);
                const float oy = static_cast<float>(cmd.batch.state.context.xyoffset.ofy >> 4);
                boxHit = !(bx1 - ox < static_cast<float>(s_traceBox[0]) || bx0 - ox > static_cast<float>(s_traceBox[2]) ||
                           by1 - oy < static_cast<float>(s_traceBox[1]) || by0 - oy > static_cast<float>(s_traceBox[3]));
            }
            const bool traceThis = cmd.type != CmdType::Submit ||
                (traceBlockMatch(s_traceTbp0, cmd.batch.state.context.tex0.tbp0) && boxHit &&
                 (s_tracePerFrame == 0u || s_traceFrameLines < s_tracePerFrame));
            if (traceThis && cmd.type == CmdType::Submit)
                ++s_traceFrameLines;
            if (traceThis)
                ++s_traceLines;
            if (traceThis)
            switch (cmd.type)
            {
            case CmdType::Submit:
            {
                float xmin = 1e30f, xmax = -1e30f, ymin = 1e30f, ymax = -1e30f;
                double zmin = 1e300, zmax = -1e300;
                for (const GSVertex &v : cmd.batch.vertices)
                {
                    xmin = std::min(xmin, v.x); xmax = std::max(xmax, v.x);
                    ymin = std::min(ymin, v.y); ymax = std::max(ymax, v.y);
                    zmin = std::min(zmin, v.z); zmax = std::max(zmax, v.z);
                }
                std::fprintf(stderr, "[gs-cmd] n=%u x=[%.0f..%.0f] y=[%.0f..%.0f] z=[%.0f..%.0f] ", (unsigned)cmd.batch.vertices.size(),
                             xmin, xmax, ymin, ymax, zmin, zmax);
                std::fprintf(stderr, "submit prim=%u iip=%u tme=%u fst=%u q=%g tbp0=%05x psm=%02x cbp=%05x cpsm=%02x fbp=%03x fpsm=%02x zbp=%03x zpsm=%02x zmsk=%u test=%05llx abe=%u v0=(%.0f,%.0f,%.0f) v1=(%.0f,%.0f) rgba=%02x%02x%02x%02x sc=(%d,%d)-(%d,%d) off=(%u,%u) alpha=%llx pabe=%u fba=%u fge=%u fog=%02x texa=%02x/%02x/%u tex1=%llx tod=%s frame=%llu%c",
                             cmd.batch.state.prim.type, cmd.batch.state.prim.iip ? 1u : 0u, cmd.batch.state.prim.tme ? 1u : 0u, cmd.batch.state.prim.fst ? 1u : 0u,
                             (double)cmd.batch.vertices[1].q, cmd.batch.state.context.tex0.tbp0,
                             cmd.batch.state.context.tex0.psm, cmd.batch.state.context.tex0.cbp, cmd.batch.state.context.tex0.cpsm,
                             cmd.batch.state.context.frame.fbp, cmd.batch.state.context.frame.psm, cmd.batch.state.context.zbuf.zbp,
                             cmd.batch.state.context.zbuf.psm, cmd.batch.state.context.zbuf.zmask ? 1u : 0u,
                             (unsigned long long)(cmd.batch.state.context.test & 0x7FFFFu), cmd.batch.state.prim.abe ? 1u : 0u,
                             cmd.batch.vertices[0].x, cmd.batch.vertices[0].y, (double)cmd.batch.vertices[0].z,
                             cmd.batch.vertices[1].x, cmd.batch.vertices[1].y,
                             cmd.batch.vertices[1].r, cmd.batch.vertices[1].g, cmd.batch.vertices[1].b, cmd.batch.vertices[1].a, cmd.batch.state.context.scissor.x0, cmd.batch.state.context.scissor.y0, cmd.batch.state.context.scissor.x1, cmd.batch.state.context.scissor.y1, (unsigned)(cmd.batch.state.context.xyoffset.ofx >> 4), (unsigned)(cmd.batch.state.context.xyoffset.ofy >> 4),
                             (unsigned long long)cmd.batch.state.context.alpha, cmd.batch.state.pabe ? 1u : 0u, (unsigned)(cmd.batch.state.context.fba & 1u),
                             cmd.batch.state.prim.fge ? 1u : 0u, cmd.batch.vertices[1].fog, cmd.batch.state.texa.ta0, cmd.batch.state.texa.ta1, cmd.batch.state.texa.aem ? 1u : 0u,
                             (unsigned long long)cmd.batch.state.context.tex1, traceTimeOfDay(), (unsigned long long)m_frameCounter, 10);
                if (!s_traceTbp0.empty() || s_traceBox.size() >= 4u)
                {
                    // Every vertex of the filtered submit: position, q, s/t (or u/v), rgba, fog.
                    std::fprintf(stderr, "[gs-vtx]");
                    for (const GSVertex &v : cmd.batch.vertices)
                        std::fprintf(stderr, " (%.1f,%.1f,%.0f q=%g st=%g,%g uv=%u,%u rgba=%02x%02x%02x%02x f=%02x)",
                                     v.x, v.y, (double)v.z, (double)v.q, (double)v.s, (double)v.t, v.u, v.v, v.r, v.g, v.b, v.a, v.fog);
                    std::fprintf(stderr, "%c", 10);
                }
                break;
            }
            case CmdType::BeginTransfer:
                std::fprintf(stderr, "[gs-cmd] transfer dir=%u sbp=%05x spsm=%02x -> dbp=%05x dpsm=%02x dbw=%u at (%u,%u) %ux%u%c",
                             cmd.transfer.direction, cmd.transfer.bitbltbuf.sbp, cmd.transfer.bitbltbuf.spsm, cmd.transfer.bitbltbuf.dbp,
                             cmd.transfer.bitbltbuf.dpsm, cmd.transfer.bitbltbuf.dbw, cmd.transfer.trxpos.dsax, cmd.transfer.trxpos.dsay,
                             cmd.transfer.trxreg.rrw, cmd.transfer.trxreg.rrh, 10);
                break;
            case CmdType::Upload:
                std::fprintf(stderr, "[gs-cmd] upload %zu bytes%c", cmd.dataSize, 10);
                break;
            case CmdType::WriteVram:
                std::fprintf(stderr, "[gs-cmd] writevram psm=%02x base=%05x%c", cmd.args[0], cmd.args[1], 10);
                break;
            case CmdType::Clear:
                std::fprintf(stderr, "[gs-cmd] clear fbp=%03x%c", cmd.context.frame.fbp, 10);
                break;
            case CmdType::Present:
                std::fprintf(stderr, "[gs-cmd] present%c", 10);
                break;
            case CmdType::ClutLoad:
                break;
            default:
                std::fprintf(stderr, "[gs-cmd] other %u%c", static_cast<unsigned>(cmd.type), 10);
                break;
            }
        }
        switch (cmd.type)
        {
        case CmdType::Submit:
        {
            // PS2X_GS_SKIP_TBP0=<blocks>: drop every textured draw that binds one of these textures (a bisect:
            // research/31 section 10 -- are the water shards the water draws or something under them?).
            static const std::vector<long> s_skipTbp0 = traceBlockList(ps2x::knob("PS2X_GS_SKIP_TBP0"));
            if (!s_skipTbp0.empty() && cmd.batch.state.prim.tme && !traceBlockMatch(s_skipTbp0, 0xFFFFFFFFu) &&
                std::find(s_skipTbp0.begin(), s_skipTbp0.end(), static_cast<long>(cmd.batch.state.context.tex0.tbp0)) != s_skipTbp0.end())
                break;
            executeSubmit(cmd.batch);
            break;
        }
        case CmdType::BeginTransfer:
        {
            // Sprint 8 Goal 2b Task 1: transfer= is these TWO statements, because the per-command
            // clock is taken at :1402 before this switch. executeTransfer's body moves no pixels
            // for a host->local transfer (gs_cpu_backend.cpp:1441-1456), so the milliseconds are
            // the draw batch this transfer interrupted. Split them.
            if (s_uploadTrace)
            {
                g_flushDirtyRowsUs = 0.0;
                g_flushDecodeUs = 0.0;
                g_flushHadBatch = false;
                g_flushPhasesArmed = true;
            }
            const auto tFlush0 = s_uploadTrace ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
            flushBatch();
            const auto tFlush1 = s_uploadTrace ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
            executeTransfer(cmd.transfer);
            if (s_uploadTrace)
            {
                const auto tBody1 = std::chrono::steady_clock::now();
                g_flushPhasesArmed = false;
                const double flushUs = std::chrono::duration<double, std::micro>(tFlush1 - tFlush0).count();
                const double bodyUs = std::chrono::duration<double, std::micro>(tBody1 - tFlush1).count();
                GsGlUploadTrace::noteTransfer(g_uploadTrace, cmd.transfer.direction, flushUs, bodyUs);
                const double restUs = flushUs - g_flushDirtyRowsUs - g_flushDecodeUs;
                GsGlUploadTrace::noteFlushPhases(g_uploadTrace, g_flushDirtyRowsUs, g_flushDecodeUs,
                                                 restUs > 0.0 ? restUs : 0.0, !g_flushHadBatch);
            }
            break;
        }
        case CmdType::Upload:
            flushBatch();
            executeUpload(buffer.data.data() + cmd.dataOffset, cmd.dataSize);
            break;
        case CmdType::WriteVram:
            flushBatch();
            m_shadow->WriteVram(cmd.args[0], cmd.args[1], cmd.args[2], cmd.args[3] & 0xFFFFu, cmd.args[3] >> 16, cmd.args[4]);
            markShadowPages(cmd.args[1] >> 5, 1u);
            if (uploadGateOn())
            {
                // The page the pixel is really in (markShadowPages above stamps only the base page).
                uint32_t block = 0u;
                if (GsGlUploadReasons::blockOf(cmd.args[0], cmd.args[1], cmd.args[2], cmd.args[3] & 0xFFFFu, cmd.args[3] >> 16, block))
                    m_uploadGate.noteForeignWrite(block >> 5, 1u);
                else
                    m_uploadGate.noteForeignWrite(cmd.args[1] >> 5, pageSpan(cmd.args[0], cmd.args[2], (cmd.args[3] >> 16) + 1u));
            }
            break;
        case CmdType::Clear:
            flushBatch();
            executeClear(cmd.context, cmd.args[0]);
            break;
        case CmdType::Present:
            flushBatch();
            m_presentPixelsRequested = cmd.args[0] != 0u;
            executePresent(cmd.present);
            break;
        case CmdType::Readback:
            flushBatch();
            executeReadback();
            break;
        case CmdType::ClutLoad:
        {
            // A palette snapshot (GSClutLoad) in stream order; decodeTexture reads it by state.context.clutId.
            GSClutLoad load;
            if (cmd.dataSize >= sizeof(GSClutLoad))
            {
                std::memcpy(&load, buffer.data.data() + cmd.dataOffset, sizeof(GSClutLoad));
                m_cluts[load.id] = load;
                m_clutUse[load.id] = ++m_clutLoadSeq;
                // Ids are stable per palette content (GS::loadClutIfNeeded), so an id's age says nothing about
                // whether draws still name it: evict by the last load or lookup instead.
                if (m_cluts.size() > 512u)
                    for (auto it2 = m_cluts.begin(); it2 != m_cluts.end();)
                    {
                        const auto use = m_clutUse.find(it2->first);
                        const bool stale = use == m_clutUse.end() || use->second + 256u < m_clutLoadSeq;
                        if (stale)
                        {
                            if (use != m_clutUse.end())
                                m_clutUse.erase(use);
                            it2 = m_cluts.erase(it2);
                        }
                        else
                            ++it2;
                    }
            }
            break;
        }
        case CmdType::Reset:
            flushBatch();
            for (auto &kv : m_textures)
                glDeleteTextures(1, &kv.second.texture);
            m_textures.clear();
            m_cluts.clear();
            m_clutUse.clear();
            for (RenderTarget &rt : m_renderTargets)
            {
                glDeleteFramebuffers(1, &rt.fbo);
                glDeleteTextures(1, &rt.color);
                if (rt.mirrorFbo != 0u)
                    glDeleteFramebuffers(1, &rt.mirrorFbo);
                if (rt.mirrorTexture != 0u)
                    glDeleteTextures(1, &rt.mirrorTexture);
            }
            m_renderTargets.clear();
            for (DepthTarget &dt : m_depthTargets)
                glDeleteTextures(1, &dt.texture);
            m_depthTargets.clear();
            m_shadow->Reset();
            m_uploadIdentity.clear();
            m_uploadGate.reset();
            m_presentTexture = 0u;
            break;
        }
        m_executedToken.store(cmd.token, std::memory_order_release);
        if (s_stats)
        {
            const auto t1 = std::chrono::steady_clock::now();
            const int idx = static_cast<int>(cmd.type) & 7;
            s_time[idx] += std::chrono::duration<double, std::milli>(t1 - t0).count();
            ++s_count[idx];
        }
    }
    flushBatch();
    if (clipZeroToOne)
        g_clipControl(GL_LOWER_LEFT, GL_NEGATIVE_ONE_TO_ONE);
    m_queueCv.notify_all();
    if (s_stats && (++s_calls % 60u) == 0u)
    {
        const auto now = std::chrono::steady_clock::now();
        const double elapsed = std::chrono::duration<double, std::milli>(now - s_lastReport).count();
        s_lastReport = now;
        std::fprintf(stderr, "[gs-gl stats] elapsed=%.0fms (%.1f fps) blends=%s\n", elapsed, 60000.0 / std::max(1.0, elapsed), m_blendLog.c_str());
        m_blendLog.clear();
        std::fprintf(stderr, "[gs-gl stats] states=%s%c", m_stateLog.c_str(), 10);
        m_stateLog.clear();
        std::fprintf(stderr, "[gs-gl stats] calls=%llu bytes=%llu ms: submit=%.1f/%llu transfer=%.1f/%llu upload=%.1f/%llu wvram=%.1f/%llu clear=%.1f/%llu present=%.1f/%llu readback=%.1f/%llu textures=%zu rts=%zu\n",
                     (unsigned long long)s_calls, (unsigned long long)s_bytes,
                     s_time[0], (unsigned long long)s_count[0], s_time[1], (unsigned long long)s_count[1],
                     s_time[2], (unsigned long long)s_count[2], s_time[3], (unsigned long long)s_count[3],
                     s_time[4], (unsigned long long)s_count[4], s_time[5], (unsigned long long)s_count[5],
                     s_time[6], (unsigned long long)s_count[6], m_textures.size(), m_renderTargets.size());
        const GsFrameBackpressure::Stats bp = m_backpressure.takeStats();
        // Q6: stall_engaged= counts the bound's engagements (one per latched stall that reached the
        // cap), stall_absorbed_*= what they took instead of pending, stall_reanchor_bytes= what the
        // re-anchors pushed back.
        std::fprintf(stderr, "[gs-gl stats] backpressure N=%u guest_frames=%llu waits=%llu wait_ms=%.1f timeouts=%llu skipped=%llu unlatched=%llu pending=%llu pending_bytes=%llu dropped_cmds=%llu dropped_bytes=%llu hard_waits=%llu stall_engaged=%llu stall_absorbed_cmds=%llu stall_absorbed_bytes=%llu stall_reanchor_bytes=%llu\n",
                     m_backpressure.maxPendingFrames(), (unsigned long long)bp.frames, (unsigned long long)bp.waits, bp.waitMs,
                     (unsigned long long)bp.timeouts, (unsigned long long)bp.skipped, (unsigned long long)bp.unlatched, (unsigned long long)m_backpressure.pendingFrames(),
                     (unsigned long long)m_pendingCap.bytes(), (unsigned long long)m_pendingCap.droppedCommands(), (unsigned long long)m_pendingCap.droppedBytes(),
                     (unsigned long long)m_pendingCap.hardWaits(),
                     (unsigned long long)m_pendingCap.absorptions(), (unsigned long long)m_pendingCap.absorbedCommands(),
                     (unsigned long long)m_pendingCap.absorbedBytes(), (unsigned long long)m_coalescer.reanchorBytes());
        // Sprint 13 V2 (#32): why the uploads and texture resolves of this interval happened.
        std::fprintf(stderr, "%s\n", GsGlUploadReasons::format(m_uploadGate.take(), uploadGateSkip()).c_str());
        if (s_uploadTrace)
        {
            g_uploadTrace.recordUs += g_recordUsGameThread.exchange(0.0);
            std::fprintf(stderr, "%s\n", GsGlUploadTrace::format(g_uploadTrace, elapsed).c_str());
            // Sprint 8 Goal 2b Task 1: the second line, same knob and same 60-call cadence, printed
            // before the reset so both lines describe the same interval.
            std::fprintf(stderr, "%s\n", GsGlUploadTrace::formatTransfer(g_uploadTrace, elapsed).c_str());
            GsGlUploadTrace::reset(g_uploadTrace);
        }
        for (int i = 0; i < 8; ++i) { s_time[i] = 0; s_count[i] = 0; }
        s_bytes = 0;
    }
}

namespace
{
    // Bit i of a RenderTarget's dirtyMask covers native rows [32i, 32i+32); 1024 rows is the whole
    // 32-bit mask (1u << 32 is undefined, hence the branch).
    inline uint32_t bandMask(uint32_t rows)
    {
        const uint32_t bands = std::min<uint32_t>(32u, (rows + 31u) / 32u);
        return bands >= 32u ? 0xFFFFFFFFu : (1u << bands) - 1u;
    }
}

// Sprint 7 Task 1c. A target sized from the use known at creation must still be correct when the
// use grows: the same base page is re-addressed at a wider FBW, or a later draw's scissor reaches
// further down than the first one did. The extent only ever grows, never shrinks -- a shrink would
// throw away rows the game can still read back through VRAM.
//
// The contents are not blitted: whatever the GPU drew and has not written back is put into the
// shadow VRAM first, the textures are respecified (same names, so the FBO attachment and every
// cached handle stay valid), and the whole extent is marked dirty so refreshDirtyRows paints it
// back from the shadow before the next draw or present. Two proven paths instead of a third.
void GSGlBackend::growRenderTarget(RenderTarget &rt, uint32_t nativeWidth, uint32_t nativeHeight)
{
    const uint32_t nw = std::max(rt.nativeWidth, std::min<uint32_t>(kMaxRtWidth, nativeWidth));
    const uint32_t nh = std::max(rt.nativeHeight, std::min<uint32_t>(kRtHeight, nativeHeight));
    if (nw == rt.nativeWidth && nh == rt.nativeHeight)
        return;
    if (rt.gpuDirty)
        downloadRenderTargetToShadow(rt);
    GLint prevFbo = 0, prevTex = 0;
    glGetIntegerv(GL_FRAMEBUFFER_BINDING, &prevFbo);
    glGetIntegerv(GL_TEXTURE_BINDING_2D, &prevTex);
    rt.nativeWidth = nw;
    rt.nativeHeight = nh;
    rt.hostWidth = nw * renderScale();
    rt.hostHeight = nh * renderScale();
    glBindTexture(GL_TEXTURE_2D, rt.color);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, static_cast<GLsizei>(rt.hostWidth), static_cast<GLsizei>(rt.hostHeight),
                 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
    if (rt.mirrorTexture != 0u)
    {
        glBindTexture(GL_TEXTURE_2D, rt.mirrorTexture);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, static_cast<GLsizei>(rt.nativeWidth), static_cast<GLsizei>(rt.nativeHeight),
                     0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
    }
    glBindTexture(GL_TEXTURE_2D, static_cast<GLuint>(prevTex));
    glBindFramebuffer(GL_FRAMEBUFFER, rt.fbo);
    glDisable(GL_SCISSOR_TEST);
    glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    glClearColor(0.0f, 0.0f, 0.0f, 0.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    glBindFramebuffer(GL_FRAMEBUFFER, static_cast<GLuint>(prevFbo));
    // The depth attachment is keyed by ZBP and sized from the target it was first used with;
    // setupDrawState re-attaches when the texture name changes, and getDepthTarget grows it.
    rt.attachedDepth = 0u;
    rt.dirtySinceResolve = true;
    rt.gpuDirty = false;
    rt.shadowStale = false;
    rt.gpuRows = false;
    rt.dirtyRows = true;
    rt.dirtyRowFirst = 0u;
    rt.dirtyRowLast = rt.nativeHeight;
    rt.dirtyMask = bandMask(rt.nativeHeight);
    rt.dirtyRects.clear();
    scaleNoteHostWrite(rt.fbp);
    if (uploadGateOn())
        m_uploadGate.noteTargetsChanged();   // V2: the texture was respecified; no remembered upload stands
}

GSGlBackend::RenderTarget *GSGlBackend::getRenderTarget(uint32_t fbp, uint32_t fbw, uint32_t psm, bool create, uint32_t usedHeight)
{
    // Targets are keyed by base page only: the game addresses the same buffer with different
    // FRAME widths (1024-wide at boot, 640-wide in the shell) and draws must land in one texture.
    // The stride used to be allocated at its 1024-pixel maximum for exactly that reason; since
    // Sprint 7 Task 1c it is allocated from the FBW and the rows in use and GROWN when a later
    // FRAME is wider or a later scissor reaches further down, so pixel coordinates still map
    // directly regardless of FBW -- growRenderTarget below is what keeps that true.
    // S3-a invariant, load-bearing from S3-c on: the GL texture is exactly renderScale() times
    // the native GS extent, and every site in the backend names one or the other (research/14
    // section 3). If the two ever drift apart the GL rects and the VRAM addressing disagree
    // silently, which is the failure mode this split exists to prevent -- so fail loudly instead.
    auto checkScale = [](const RenderTarget &t)
    {
        if (t.hostWidth != t.nativeWidth * renderScale() || t.hostHeight != t.nativeHeight * renderScale())
        {
            std::fprintf(stderr, "[gs-gl] FATAL render target fbp=%03x host %ux%u != native %ux%u * scale %u\n",
                         t.fbp, t.hostWidth, t.hostHeight, t.nativeWidth, t.nativeHeight, renderScale());
            std::abort();
        }
    };
    for (RenderTarget &rt : m_renderTargets)
        if (rt.fbp == fbp)
        {
            // V2 review: a narrower re-address changes fbw without a grow, so the texture maps to
            // other VRAM; no remembered upload may stand across it.
            const uint32_t newFbw = std::max<uint32_t>(fbw, 1u);
            if (newFbw != rt.fbw && uploadGateOn())
                m_uploadGate.noteTargetsChanged();
            rt.fbw = newFbw;
            // Sprint 7 Task 1c: the target was sized from the use known when it was created, and
            // the use can grow -- the same base page is re-addressed at a wider FBW (1024-wide at
            // boot, 640-wide in the shell) and a later draw's scissor reaches further down. Grow
            // before handing the target back, never shrink.
            growRenderTarget(rt, std::max<uint32_t>(1u, rt.fbw) * 64u,
                             usedHeight == 0u ? 0u : GsGlTarget::choose(rt.fbw, usedHeight).height);
            checkScale(rt);
            return &rt;
        }
    if (!create)
        return nullptr;
    RenderTarget rt;
    rt.fbp = fbp;
    rt.fbw = std::max<uint32_t>(fbw, 1u);
    rt.psm = psm;
    // Sprint 7 Task 1c (audit section 2.2 F9): size the target from FBW and the rows the caller
    // says it is using instead of the old flat kMaxRtWidth x kRtHeight. A caller that does not
    // know (usedHeight == 0) still gets the full 1024x1024, so nothing is under-allocated by
    // ignorance -- see gs_gl_target_extent.h.
    {
        const GsGlTarget::Extent extent = GsGlTarget::choose(rt.fbw, usedHeight);
        rt.nativeWidth = extent.width;
        rt.nativeHeight = extent.height;
    }
    // [* S site 1 -- allocation] the GL colour texture is the native extent times the scale; the
    // depth attachment follows it via getDepthTarget(rt->hostWidth, rt->hostHeight) in
    // setupDrawState, and the native mirror stays nativeWidth x nativeHeight.
    rt.hostWidth = rt.nativeWidth * renderScale();
    rt.hostHeight = rt.nativeHeight * renderScale();
    checkScale(rt);
    glGenTextures(1, &rt.color);
    glBindTexture(GL_TEXTURE_2D, rt.color);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, rt.hostWidth, rt.hostHeight, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glGenFramebuffers(1, &rt.fbo);
    glBindFramebuffer(GL_FRAMEBUFFER, rt.fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, rt.color, 0);
    glDisable(GL_SCISSOR_TEST);
    glClearColor(0.0f, 0.0f, 0.0f, 0.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    // Seed the target with whatever the shadow VRAM holds (uploads that landed before any draw).
    m_renderTargets.push_back(rt);
    RenderTarget &ref = m_renderTargets.back();
    ref.dirtyRows = true;
    ref.dirtyRowFirst = 0u;
    ref.dirtyRowLast = std::min<uint32_t>(448u, ref.nativeHeight);
    ref.dirtyMask = bandMask(ref.dirtyRowLast);   // bands 0..13 = rows 0..448, clipped to the extent
    if (uploadGateOn())
        m_uploadGate.noteTargetsChanged();   // V2: seeded from rows 0..448 of the shadow only
    return &ref;
}

GSGlBackend::DepthTarget *GSGlBackend::getDepthTarget(uint32_t zbp, uint32_t fbw, uint32_t width, uint32_t height)
{
    for (DepthTarget &dt : m_depthTargets)
        if (dt.zbp == zbp)
        {
            // Sprint 7 Task 1c: render targets are no longer all 1024x1024, so a depth buffer first
            // used with a small target can be smaller than the one now attached to it. An FBO whose
            // attachments differ in size renders only their intersection -- silently clipping every
            // depth-tested draw -- so grow it. PS2 local memory starts zeroed and no path reads
            // depth back into guest VRAM, so re-zeroing is the whole of the contents.
            if (width > dt.width || height > dt.height)
            {
                dt.width = std::max(dt.width, width);
                dt.height = std::max(dt.height, height);
                GLint prevTexGrow = 0;
                glGetIntegerv(GL_TEXTURE_BINDING_2D, &prevTexGrow);
                glBindTexture(GL_TEXTURE_2D, dt.texture);
                const std::vector<float> zeros(static_cast<size_t>(dt.width) * dt.height, 0.0f);
                glTexImage2D(GL_TEXTURE_2D, 0, GL_DEPTH_COMPONENT32F, static_cast<GLsizei>(dt.width), static_cast<GLsizei>(dt.height),
                             0, GL_DEPTH_COMPONENT, GL_FLOAT, zeros.data());
                glBindTexture(GL_TEXTURE_2D, static_cast<GLuint>(prevTexGrow));
            }
            return &dt;
        }
    DepthTarget dt;
    dt.zbp = zbp;
    dt.fbw = fbw;
    dt.width = width;
    dt.height = height;
    glGenTextures(1, &dt.texture);
    glBindTexture(GL_TEXTURE_2D, dt.texture);
    // PS2 local memory starts zeroed: initialise the depth buffer to 0 instead of leaving it undefined
    // (otherwise GEQUAL tests fail until the game's own clear writes it).
    std::vector<float> zeros(static_cast<size_t>(width) * height, 0.0f);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_DEPTH_COMPONENT32F, width, height, 0, GL_DEPTH_COMPONENT, GL_FLOAT, zeros.data());
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    m_depthTargets.push_back(dt);
    return &m_depthTargets.back();
}

void GSGlBackend::markShadowPages(uint32_t page, uint32_t pageCount)
{
    ++m_generation;
    for (uint32_t p = page; p < page + pageCount && p < 512u; ++p)
        m_shadowPageGeneration[p] = m_generation;
}

// Sprint 13 V2 (#32): the pages of each target's GPU-drawn row window (noteGpuRows' own page
// arithmetic) against the upload's pages. A window is one [first, last) range per target, so a
// draw above and one below an upload refuse it too: conservative, never wrong.
bool GSGlBackend::uploadUnderGpuRows(uint32_t pageLo, uint32_t pageHi) const
{
    for (const RenderTarget &rt : m_renderTargets)
    {
        if (!rt.gpuRows)
            continue;
        const uint32_t ph = pageHeightForPsm(rt.psm), ppr = std::max<uint32_t>(1u, rt.fbw);
        const uint32_t p0 = rt.fbp + (rt.gpuRowFirst / ph) * ppr;
        const uint32_t p1 = rt.fbp + ((rt.gpuRowLast + ph - 1u) / ph) * ppr;
        if (pageLo < p1 && p0 < pageHi)
            return true;
    }
    return false;
}

void GSGlBackend::executeTransfer(const GSTransferCommand &command)
{
    m_shadow->BeginTransfer(command);
    if (command.direction == 2u) // local -> local: the shadow copies immediately; refresh RTs
    {
        const uint32_t page = command.bitbltbuf.dbp >> 5;
        const uint32_t span = pageSpan(command.bitbltbuf.dpsm, command.bitbltbuf.dbw, command.trxpos.dsay + command.trxreg.rrh);
        markShadowPages(page, span);
        if (uploadGateOn())
            // V2 review: pageSpan counts from the base page, so a dbp inside a page (dbp & 31)
            // lets the last block row spill one page row past the span; stamp that row too.
            // markShadowPages above has the same gap (pre-existing, default path, KNOWN section 4).
            m_uploadGate.noteForeignWrite(page, GsGlUploadReasons::stampSpan(command.bitbltbuf.dbp, span,
                                                                          pageSpan(command.bitbltbuf.dpsm, command.bitbltbuf.dbw, 1u)));
        if (tracePagesHit(page, span))
            std::fprintf(stderr, "[gs-pages] frame=%llu local-copy sbp=%05x -> dbp=%05x dbw=%u %ux%u pages %03x+%u\n",
                         (unsigned long long)m_frameCounter, command.bitbltbuf.sbp, command.bitbltbuf.dbp, command.bitbltbuf.dbw,
                         command.trxreg.rrw, command.trxreg.rrh, page, span);
        refreshRenderTargetsFromShadow(page, span, command);
    }
    if (m_movieStartFrame == 0u && command.trxreg.rrw == 16u && command.trxreg.rrh == 16u && command.bitbltbuf.dbw == 10u &&
        command.trxpos.dsax == 0u && command.trxpos.dsay == 0u && (command.bitbltbuf.dbp == 0x3c0u || command.bitbltbuf.dbp == 0x1540u))
        m_movieStartFrame = m_frameCounter ? m_frameCounter : 1u;
    m_currentTransfer = command;
    m_uploadReceivedBytes = 0u;
    m_uploadExpectedBytes = static_cast<uint64_t>(command.trxreg.rrw) * command.trxreg.rrh *
                            GSInternal::bitsPerPixel(command.bitbltbuf.dpsm) / 8u;
}

void GSGlBackend::executeUpload(const uint8_t *data, size_t size)
{
    // Sprint 8 Goal 2 Task 1: term (a) of the tile path, split -- the CPU swizzle into shadow VRAM,
    // and the page + rect marking. These two are the whole of the [gs-gl stats] upload= column.
    static const bool s_uploadTrace = ps2x::knob("PS2X_GS_UPLOAD_TRACE") != nullptr;
    const GSTransferCommand &t = m_currentTransfer;
    const uint32_t page = t.bitbltbuf.dbp >> 5;
    const uint32_t span = pageSpan(t.bitbltbuf.dpsm, t.bitbltbuf.dbw, t.trxpos.dsay + t.trxreg.rrh);
    // R119 kept as the population split the [gs-transfer] line reports: a rectangle split across
    // several IMAGE GIF tags (gs_frontend.cpp:938-943) arrives as several calls.
    const bool wholeTransfer = (m_uploadReceivedBytes == 0u && m_uploadExpectedBytes != 0u &&
                                static_cast<uint64_t>(size) == m_uploadExpectedBytes);
    // Task 1's identical= counter, and nothing else: computed only with the trace on, so the
    // production upload path is exactly what it was before this goal touched it.
    bool identicalBytes = false;
    if (s_uploadTrace)
    {
        const GsGlUploadIdentity::Key identityKey{t.bitbltbuf.dbp, t.bitbltbuf.dbw, t.trxpos.dsax,
                                                  t.trxpos.dsay, t.trxreg.rrw, t.trxreg.rrh, t.bitbltbuf.dpsm};
        const uint64_t identityHash = GsGlUploadIdentity::hash64(data, size);
        identicalBytes = m_uploadIdentity.matches(identityKey, identityHash, size);
        if (wholeTransfer)
            m_uploadIdentity.store(identityKey, identityHash, size);
    }
    // Sprint 13 V2 (#32): why this upload happened (the [gs-gl stats] reasons line) and, with
    // PS2X_GS_UPLOAD_SKIP=1, the one case that changes nothing: the same bytes as this rectangle's
    // last upload, none of its blocks written since, and no render target drawn over it since its
    // last download. Then the shadow already holds the bytes, every render-target texture over them
    // does too (or has them pending from the shadow), and the cached textures are right as they are.
    if (uploadGateOn())
    {
        const GsGlUploadIdentity::Key key{t.bitbltbuf.dbp, t.bitbltbuf.dbw, t.trxpos.dsax,
                                          t.trxpos.dsay, t.trxreg.rrw, t.trxreg.rrh, t.bitbltbuf.dpsm};
        GsGlUploadReasons::blocksOf(t.bitbltbuf.dpsm, t.bitbltbuf.dbp, t.bitbltbuf.dbw, t.trxpos.dsax, t.trxpos.dsay,
                                    t.trxreg.rrw, t.trxreg.rrh, m_uploadBlocks);
        bool underGpu = false;
        if (wholeTransfer && !m_uploadBlocks.empty())
            underGpu = uploadUnderGpuRows(m_uploadBlocks.front() >> 5, (m_uploadBlocks.back() >> 5) + 1u);
        const GsGlUploadReasons::Gate::Decision decision =
            m_uploadGate.decide(key, data, size, wholeTransfer, m_uploadBlocks, page, span,
                                pageSpan(t.bitbltbuf.dpsm, t.bitbltbuf.dbw, 1u), underGpu, uploadGateSkip());
        if (decision.skip)
        {
            // Leave the shadow's transfer where the write would have: complete, so a stray packet
            // past the rectangle is dropped exactly as before.
            m_shadow->CompleteImageTransfer();
            m_uploadReceivedBytes = 0u;
            if (s_uploadTrace)
                GsGlUploadTrace::noteUploadShape(g_uploadTrace, wholeTransfer, identicalBytes);
            return;
        }
    }
    double traceShadowUs = 0.0, traceMarkUs = 0.0;
    const auto tShadow0 = s_uploadTrace ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
    m_shadow->UploadImage(data, static_cast<uint32_t>(size));
    if (s_uploadTrace)
        traceShadowUs = std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - tShadow0).count();
    const auto tMark0 = s_uploadTrace ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
    markShadowPages(page, span);
    if (s_uploadTrace)
        traceMarkUs += std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - tMark0).count();
    if (tracePagesHit(page, span))
        std::fprintf(stderr, "[gs-pages] frame=%llu upload dbp=%05x dbw=%u psm=%02x dst=(%u,%u) %ux%u pages %03x+%u bytes=%zu\n",
                     (unsigned long long)m_frameCounter, t.bitbltbuf.dbp, t.bitbltbuf.dbw, t.bitbltbuf.dpsm,
                     t.trxpos.dsax, t.trxpos.dsay, t.trxreg.rrw, t.trxreg.rrh, page, span, size);
    // Uploads arrive in chunks; refresh overlapping render targets once per completed rectangle.
    m_uploadReceivedBytes += size;
    if (m_uploadExpectedBytes != 0u && m_uploadReceivedBytes >= m_uploadExpectedBytes)
    {
        m_uploadReceivedBytes = 0u;
        const auto tRects0 = s_uploadTrace ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
        refreshRenderTargetsFromShadow(page, span, t);
        if (s_uploadTrace)
            traceMarkUs += std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - tRects0).count();
        // PS2X_GS_TRACE_PRESENT: after the last 16x16 block of a movie frame (dsax 624, dsay 208),
        // the first non-black row per 64-px page column of the frame area in the shadow VRAM.
        const long s_upSkip = traceSkip("PS2X_GS_TRACE_PRESENT");
        static uint32_t s_upPrinted = 0u;
        if (s_upSkip >= 0 && static_cast<long>(m_frameCounter) > s_upSkip && s_upPrinted < 12u &&
            t.trxreg.rrw == 16u && t.trxreg.rrh == 16u && t.trxpos.dsax == 624u && t.trxpos.dsay == 208u)
        {
            ++s_upPrinted;
            char line[256];
            int n = std::snprintf(line, sizeof(line), "[gs-gl upload-scan] frame=%llu dbp=%05x dbw=%u first-row/page-col:",
                                  (unsigned long long)m_frameCounter, t.bitbltbuf.dbp, t.bitbltbuf.dbw);
            for (uint32_t c = 0; c < 10u && n < 240; ++c)
            {
                int firstRow = -1;
                for (uint32_t y = 0; y < 240u; ++y)
                {
                    uint32_t sum = 0, cnt = 0;
                    for (uint32_t x = c * 64u; x < c * 64u + 64u; x += 4u, ++cnt)
                    {
                        const uint32_t p = readVramRaw(m_shadowMemory.data(), t.bitbltbuf.dpsm, t.bitbltbuf.dbp, t.bitbltbuf.dbw, x, y);
                        sum += ((p & 0xFFu) + ((p >> 8) & 0xFFu) + ((p >> 16) & 0xFFu)) / 3u;
                    }
                    if (sum > 8u * cnt) { firstRow = static_cast<int>(y); break; }
                }
                n += std::snprintf(line + n, sizeof(line) - n, " %d", firstRow);
            }
            std::fprintf(stderr, "%s\n", line);
        }
    }
    if (s_uploadTrace)
    {
        GsGlUploadTrace::noteUpload(g_uploadTrace, size, traceShadowUs, traceMarkUs);
        GsGlUploadTrace::noteUploadShape(g_uploadTrace, wholeTransfer, identicalBytes);
    }
}

// A transfer wrote into pages a render target covers (video frames are uploaded straight into the
// display buffer as hundreds of small transfers with their own base addresses). Mark the affected
// page rows; they are re-read from the shadow VRAM in the target's own layout before the next draw
// into that target or the next present (refreshDirtyRows).
void GSGlBackend::refreshRenderTargetsFromShadow(uint32_t page, uint32_t pageCount, const GSTransferCommand &transfer)
{
    // Sprint 8 Goal 2 Task 1: how many exact rectangles a second there are to batch. Task 2's claim
    // is that rects/s is large and gl_calls/s equals it today.
    static const bool s_uploadTrace = ps2x::knob("PS2X_GS_UPLOAD_TRACE") != nullptr;
    for (RenderTarget &rt : m_renderTargets)
    {
        const uint32_t pagesPerRow = std::max<uint32_t>(1u, (rt.fbw * 64u + 63u) / 64u);
        const uint32_t pageHeight = pageHeightForPsm(rt.psm);
        const uint32_t rtPages = pagesPerRow * ((kRtHeight + pageHeight - 1u) / pageHeight);
        if (page + pageCount <= rt.fbp || page >= rt.fbp + rtPages)
            continue;
        const uint32_t first = page > rt.fbp ? page - rt.fbp : 0u;
        const uint32_t last = std::min<uint32_t>(page + pageCount - rt.fbp, rtPages);   // exclusive
        uint32_t rowFirst = (first / pagesPerRow) * pageHeight;
        uint32_t rowLast = std::min<uint32_t>(kRtHeight, ((last + pagesPerRow - 1u) / pagesPerRow) * pageHeight);
        // A transfer in the target's own layout writes exactly rows [dsay, dsay+rrh) below its
        // base page row: use them. The page-span window above starts at the base page, so a
        // 16x16 movie block at row 392 marked rows 0..408 dirty, and the next draw re-read the
        // whole window from the shadow — resurrecting rows of the last cinematic frame that the
        // GPU had already painted black (the movie strip at rows ~396-415 on SOCOM II's
        // black typing screen before the mission briefing, user report 2026-09-09).
        bool exact = false;
        if (transfer.bitbltbuf.dbw == rt.fbw && transfer.bitbltbuf.dpsm == rt.psm && page >= rt.fbp && (page - rt.fbp) % pagesPerRow == 0u)
        {
            const uint32_t baseRow = ((page - rt.fbp) / pagesPerRow) * pageHeight;
            const uint32_t y0 = baseRow + transfer.trxpos.dsay;
            const uint32_t y1 = y0 + transfer.trxreg.rrh;
            const uint32_t x0 = transfer.trxpos.dsax;
            const uint32_t x1 = std::min<uint32_t>(x0 + transfer.trxreg.rrw, rt.fbw * 64u);
            if (y0 < kRtHeight && y1 > y0 && x1 > x0)
            {
                rowFirst = std::max(rowFirst, y0);
                rowLast = std::min<uint32_t>(rowLast, y1);
                if (rt.dirtyRects.size() < 4096u)
                {
                    rt.dirtyRects.push_back({x0, y0, x1, std::min<uint32_t>(y1, kRtHeight)});
                    if (s_uploadTrace)
                        GsGlUploadTrace::noteRect(g_uploadTrace);
                    exact = true;
                }
            }
        }
        if (rowFirst >= rowLast)
            continue;
        {
            // PS2X_GS_TRACE_DIRTY=<frame>: from that frame on, log every dirty mark that lands in
            // the visible rows of a display buffer, with the transfer that caused it.
            static const long s_traceDirty = ps2x::knob("PS2X_GS_TRACE_DIRTY") ? std::strtol(ps2x::knob("PS2X_GS_TRACE_DIRTY"), nullptr, 0) : -1L;
            if (s_traceDirty >= 0 && static_cast<long>(m_frameCounter) >= s_traceDirty && rowFirst < 448u && rowLast > 380u)
                std::fprintf(stderr, "[gs-gl dirty] frame=%llu rt fbp=%03x rows %u..%u <- transfer dbp=%05x dbw=%u dpsm=%02x dst=(%u,%u) %ux%u pages %03x+%u\n",
                             (unsigned long long)m_frameCounter, rt.fbp, rowFirst, rowLast, transfer.bitbltbuf.dbp, transfer.bitbltbuf.dbw,
                             transfer.bitbltbuf.dpsm, transfer.trxpos.dsax, transfer.trxpos.dsay, transfer.trxreg.rrw, transfer.trxreg.rrh, page, pageCount);
        }
        if (!rt.dirtyRows)
        {
            rt.dirtyRowFirst = rowFirst;
            rt.dirtyRowLast = rowLast;
            rt.dirtyRows = true;
            rt.dirtyMask = 0u;
        }
        else
        {
            rt.dirtyRowFirst = std::min(rt.dirtyRowFirst, rowFirst);
            rt.dirtyRowLast = std::max(rt.dirtyRowLast, rowLast);
        }
        if (!exact)
            for (uint32_t band = rowFirst / 32u; band < (std::min<uint32_t>(rowLast, kRtHeight) + 31u) / 32u && band < 32u; ++band)
                rt.dirtyMask |= 1u << band;
    }
}

// Re-read the marked rows of a render target from the shadow VRAM (its own base/width/format).
void GSGlBackend::refreshDirtyRows(RenderTarget &rt)
{
    if (!rt.dirtyRows)
        return;
    // Sprint 8 Goal 2 Task 1: terms (a-convert) and (b). The two glTexSubImage2D sites of this file
    // are both below, so this is the only place the GL half of a tile upload can be timed -- and
    // its milliseconds are charged to clear=, submit= and present=, never to upload=.
    static const bool s_uploadTrace = ps2x::knob("PS2X_GS_UPLOAD_TRACE") != nullptr;
    // PS2X_GS_NO_DIRTY_REFRESH=1: A/B switch — drop the pending rows instead of re-reading them.
    static const bool s_noRefresh = ps2x::knobOn("PS2X_GS_NO_DIRTY_REFRESH");
    if (s_noRefresh)
    {
        rt.dirtyRows = false;
        rt.dirtyMask = 0u;
        rt.dirtyRects.clear();
        return;
    }
    {
        const long skip = traceSkip("PS2X_GS_TRACE_PRESENT");
        if (skip >= 0 && static_cast<long>(m_frameCounter) > skip && static_cast<long>(m_frameCounter) <= skip + 3)
            std::fprintf(stderr, "[gs-gl refresh] frame=%llu rt fbp=%03x rows %u..%u mask=%08x -> gpu\n", (unsigned long long)m_frameCounter,
                         rt.fbp, rt.dirtyRowFirst, rt.dirtyRowLast, rt.dirtyMask);
    }
    const uint32_t mask = rt.dirtyMask;
    std::vector<RenderTarget::DirtyRect> rects;
    rects.swap(rt.dirtyRects);
    rt.dirtyRows = false;
    rt.dirtyMask = 0u;
    // The glTexSubImage2D calls below write the host colour texture just as a draw does, so the
    // native mirror must be re-resolved before the next read (brief names executeSubmit and
    // executeClear; this is the third writer of the same texture and would silently serve a stale
    // mirror to a download that follows an upload).
    rt.dirtySinceResolve = true;
    scaleNoteHostWrite(rt.fbp);
    const uint32_t w = std::min<uint32_t>(rt.nativeWidth, rt.fbw * 64u);
    if (w == 0u)
        return;
    const uint32_t base = rt.fbp << 5;
    glBindTexture(GL_TEXTURE_2D, rt.color);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
    // [* S site 5 -- shadow->GPU upload] Both uploads below produce a buffer of NATIVE pixels at a
    // NATIVE destination rect (every clamp feeding them -- `w`, both `y1`s -- stays native, per
    // research/14 section 8's audit). This is the one place that turns them into the host rect they
    // have to write: destination (x0*S, y0*S) sized (w*S, h*S), each native pixel nearest-expanded
    // into an SxS block on the CPU. Without it an unscaled glTexSubImage2D writes a native-sized
    // patch into the top-left corner of the host-sized region it meant to cover (section 8.1 item 7).
    //
    // The consequence is intended and is NOT a bug to fix: the shadow only ever holds native
    // pixels, so an upload DESTROYS sub-native detail in the rows it covers -- any region the game
    // re-uploads (the movie path re-uploads a full frame every frame) loses the Sx draw beneath it.
    const uint32_t uploadScale = renderScale();
    auto uploadScaled = [&](const std::vector<uint32_t> &src, uint32_t sw, uint32_t sh, uint32_t dx, uint32_t dy, double convertUs)
    {
        if (uploadScale == 1u)
        {
            const auto tGl0 = s_uploadTrace ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
            glTexSubImage2D(GL_TEXTURE_2D, 0, static_cast<GLint>(dx), static_cast<GLint>(dy),
                            static_cast<GLsizei>(sw), static_cast<GLsizei>(sh), GL_RGBA, GL_UNSIGNED_BYTE, src.data());
            if (s_uploadTrace)
                GsGlUploadTrace::noteGlUpload(g_uploadTrace, rt.color, convertUs,
                                              std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - tGl0).count());
            return;
        }
        // The replication loop below is CPU work that happens to sit in this lambda: it belongs to
        // convert, not to gl.
        const auto tRep0 = s_uploadTrace ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
        const size_t stride = static_cast<size_t>(sw) * uploadScale;
        std::vector<uint32_t> big(stride * sh * uploadScale);
        for (uint32_t y = 0; y < sh; ++y)
        {
            uint32_t *const row0 = big.data() + static_cast<size_t>(y) * uploadScale * stride;
            for (uint32_t x = 0; x < sw; ++x)
            {
                const uint32_t px = src[static_cast<size_t>(y) * sw + x];
                for (uint32_t sx = 0; sx < uploadScale; ++sx)
                    row0[static_cast<size_t>(x) * uploadScale + sx] = px;
            }
            for (uint32_t sy = 1u; sy < uploadScale; ++sy)
                std::memcpy(row0 + static_cast<size_t>(sy) * stride, row0, stride * sizeof(uint32_t));
        }
        if (s_uploadTrace)
            convertUs += std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - tRep0).count();
        const auto tGl0 = s_uploadTrace ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
        glTexSubImage2D(GL_TEXTURE_2D, 0, static_cast<GLint>(dx * uploadScale), static_cast<GLint>(dy * uploadScale),
                        static_cast<GLsizei>(sw * uploadScale), static_cast<GLsizei>(sh * uploadScale),
                        GL_RGBA, GL_UNSIGNED_BYTE, big.data());
        if (s_uploadTrace)
            GsGlUploadTrace::noteGlUpload(g_uploadTrace, rt.color, convertUs,
                                          std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - tGl0).count());
    };
    auto convert = [&](uint32_t p) -> uint32_t
    {
        if (rt.psm == GS_PSM_CT16 || rt.psm == GS_PSM_CT16S)
            return rgba5551To8888(p);
        if (rt.psm == GS_PSM_CT24)
            return p | 0x80000000u;
        return p;
    };
    // Exact rectangles first (uploads in the target's own layout: only the written pixels).
    for (const RenderTarget::DirtyRect &r : rects)
    {
        const uint32_t x0 = std::min(r.x0, w), x1 = std::min(r.x1, w);
        const uint32_t y0 = r.y0, y1 = std::min<uint32_t>(r.y1, rt.nativeHeight);
        if (x1 <= x0 || y1 <= y0)
            continue;
        const auto tConv0 = s_uploadTrace ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
        std::vector<uint32_t> px(static_cast<size_t>(x1 - x0) * (y1 - y0));
        for (uint32_t y = y0; y < y1; ++y)
            for (uint32_t x = x0; x < x1; ++x)
                px[static_cast<size_t>(y - y0) * (x1 - x0) + (x - x0)] = convert(readVramRaw(m_shadowMemory.data(), rt.psm, base, rt.fbw, x, y));
        const double convertUs = s_uploadTrace
                                     ? std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - tConv0).count()
                                     : 0.0;
        uploadScaled(px, x1 - x0, y1 - y0, x0, y0, convertUs);
        rt.usedHeight = std::max(rt.usedHeight, y1);
    }
    // Re-read each run of dirty 32-row bands on its own; bands nobody uploaded into keep the
    // GPU's newer contents (the game's draws are not mirrored in the shadow).
    for (uint32_t band = 0; band < 32u;)
    {
        if (!(mask & (1u << band)))
        {
            ++band;
            continue;
        }
        uint32_t end = band;
        while (end < 32u && (mask & (1u << end)))
            ++end;
        const uint32_t y0 = band * 32u;
        const uint32_t y1 = std::min<uint32_t>(end * 32u, rt.nativeHeight);
        band = end;
        if (y1 <= y0)
            continue;
        {
            const uint32_t ph = pageHeightForPsm(rt.psm), ppr = std::max<uint32_t>(1u, rt.fbw);
            const uint32_t p0 = rt.fbp + (y0 / ph) * ppr, p1 = rt.fbp + ((y1 + ph - 1u) / ph) * ppr;
            if (p1 > p0 && tracePagesHit(p0, p1 - p0))
                std::fprintf(stderr, "[gs-pages] frame=%llu refresh shadow->gpu rt fbp=%03x rows %u..%u pages %03x+%u\n",
                             (unsigned long long)m_frameCounter, rt.fbp, y0, y1, p0, p1 - p0);
        }
        const auto tBand0 = s_uploadTrace ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
        std::vector<uint32_t> pixels(static_cast<size_t>(w) * (y1 - y0));
        for (uint32_t y = y0; y < y1; ++y)
            for (uint32_t x = 0; x < w; ++x)
            {
                uint32_t p = readVramRaw(m_shadowMemory.data(), rt.psm, base, rt.fbw, x, y);
                if (rt.psm == GS_PSM_CT16 || rt.psm == GS_PSM_CT16S)
                    p = rgba5551To8888(p);
                else if (rt.psm == GS_PSM_CT24)
                    p |= 0x80000000u;
                pixels[static_cast<size_t>(y - y0) * w + x] = p;
            }
        const double bandConvertUs = s_uploadTrace
                                         ? std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - tBand0).count()
                                         : 0.0;
        uploadScaled(pixels, w, y1 - y0, 0u, y0, bandConvertUs);
        rt.usedHeight = std::max(rt.usedHeight, y1);
    }
}

void GSGlBackend::executeClear(const GSContext &context, uint32_t rgba)
{
    RenderTarget *rt = getRenderTarget(context.frame.fbp, context.frame.fbw, context.frame.psm, true,
                                      std::min<uint32_t>(kRtHeight, static_cast<uint32_t>(context.scissor.y1) + 1u));
    // Rows an image upload wrote into this target before the clear must land before the clear,
    // not after it: without this the next draw's refreshDirtyRows painted the stale rows (the
    // last cinematic frame, uploaded as 16x16 blocks into the display buffer) over the cleared
    // black screen — SOCOM II showed a strip of the previous movie at rows ~396-415 during the
    // fade/typing screen before the mission briefing (user report 2026-09-09).
    refreshDirtyRows(*rt);
    {
        static const bool s_traceClear = ps2x::knob("PS2X_GS_TRACE_DISPFB") != nullptr;
        if (s_traceClear)
            std::fprintf(stderr, "[gs-gl clear] frame=%llu fbp=%03x fbw=%u psm=%02x scissor=(%d,%d)-(%d,%d) rgba=%08x\n",
                         (unsigned long long)m_frameCounter, context.frame.fbp, context.frame.fbw, context.frame.psm,
                         context.scissor.x0, context.scissor.y0, context.scissor.x1, context.scissor.y1, rgba);
    }
    glBindFramebuffer(GL_FRAMEBUFFER, rt->fbo);
    glViewport(0, 0, rt->hostWidth, rt->hostHeight);
    glEnable(GL_SCISSOR_TEST);
    // [* S site 3 -- clear scissor] SCISSOR is in native GS pixels and the viewport above is host,
    // so the rect must be scaled as a whole: x0*S, y0*S, (x1-x0+1)*S, (y1-y0+1)*S. research/14
    // section 2.2 marks an off-by-one here semantic-adjacent -- a scissor that leaks a draw into
    // the next native row leaks it into rows a later download writes back into guest VRAM.
    {
        const int cs = static_cast<int>(renderScale());
        glScissor(static_cast<int>(context.scissor.x0) * cs, static_cast<int>(context.scissor.y0) * cs,
                  std::max<int>(0, context.scissor.x1 - context.scissor.x0 + 1) * cs,
                  std::max<int>(0, context.scissor.y1 - context.scissor.y0 + 1) * cs);
    }
    glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    glClearColor((rgba & 0xFFu) / 255.0f, ((rgba >> 8) & 0xFFu) / 255.0f, ((rgba >> 16) & 0xFFu) / 255.0f, ((rgba >> 24) & 0xFFu) / 255.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    rt->gpuDirty = true;
    rt->shadowStale = true;
    rt->dirtySinceResolve = true;   // the clear wrote the host colour texture: the native mirror is stale
    scaleNoteHostWrite(rt->fbp);
    rt->usedHeight = std::max(rt->usedHeight, std::min<uint32_t>(kRtHeight, static_cast<uint32_t>(context.scissor.y1) + 1u));
    noteGpuRows(*rt, static_cast<uint32_t>(std::max<int>(0, context.scissor.y0)), std::min<uint32_t>(kRtHeight, static_cast<uint32_t>(context.scissor.y1) + 1u));
}

// Rows [y0, y1) of a target were written by the GPU since the shadow/CPU VRAM last synced with
// it. Downloads write back only this window: a target's texture is 1024 rows tall regardless of
// how much the game uses, and writing all of it back clobbers every buffer that lives below the
// target's base in VRAM (SOCOM II's movie staging buffer sits 140 pages after the display buffer:
// its freshly uploaded frame was overwritten with a stale copy, one page-row of the frame at a time).
void GSGlBackend::noteGpuRows(RenderTarget &rt, uint32_t y0, uint32_t y1)
{
    if (y1 <= y0)
        return;
    {
        const uint32_t ph = pageHeightForPsm(rt.psm), ppr = std::max<uint32_t>(1u, rt.fbw);
        const uint32_t p0 = rt.fbp + (y0 / ph) * ppr, p1 = rt.fbp + ((y1 + ph - 1u) / ph) * ppr;
        if (p1 > p0 && tracePagesHit(p0, p1 - p0))
            std::fprintf(stderr, "[gs-pages] frame=%llu gpu-draw rt fbp=%03x rows %u..%u pages %03x+%u (dirty %d %u..%u)\n",
                         (unsigned long long)m_frameCounter, rt.fbp, y0, y1, p0, p1 - p0, rt.dirtyRows ? 1 : 0, rt.dirtyRowFirst, rt.dirtyRowLast);
    }
    if (!rt.gpuRows)
    {
        rt.gpuRowFirst = y0;
        rt.gpuRowLast = y1;
        rt.gpuRows = true;
    }
    else
    {
        rt.gpuRowFirst = std::min(rt.gpuRowFirst, y0);
        rt.gpuRowLast = std::max(rt.gpuRowLast, y1);
    }
}

// ---------------------------------------------------------------------------------------------
// Native view (S3-b)
// ---------------------------------------------------------------------------------------------
// Everything the guest can observe must see a render target at its NATIVE GS extent, whatever
// extent the GL texture the backend actually draws into happens to have. nativeView() is the one
// place that promise is kept: it hands back a GL texture that is nativeWidth x nativeHeight.
//
// At scale 1 -- every build until S3-c introduces PS2X_GS_SCALE -- host == native, so the colour
// texture already IS the native view: the early return costs two integer compares, allocates
// nothing, copies nothing, and the whole resolve machinery below is unreachable. Above scale 1 the
// host texture is resolved into a per-target native mirror, at most once per target between draws
// (dirtySinceResolve), and the mirror is returned instead.
uint32_t GSGlBackend::nativeView(RenderTarget &rt)
{
    if (rt.hostWidth == rt.nativeWidth && rt.hostHeight == rt.nativeHeight)
        return rt.color;
    bool resolvedNow = false;
    if (rt.dirtySinceResolve || rt.mirrorTexture == 0u)
    {
        resolveToMirror(rt);
        rt.dirtySinceResolve = false;
        resolvedNow = true;
        if (scaleSelfTest())
            scaleSerials()[rt.fbp].resolved = scaleSerials()[rt.fbp].written;
    }
    // Deliberately outside the branch above: a stale mirror is only ever *served* by the path that
    // skips the resolve, so checking inside the branch would check the one case that cannot fail.
    if (scaleSelfTest())
        scaleSelfTestCheck(rt.fbp, rt.mirrorFbo, rt.fbo, rt.nativeWidth, rt.nativeHeight, rt.hostWidth, rt.hostHeight, resolvedNow);
    return rt.mirrorTexture;
}

// The same view for readers that need a framebuffer to glReadPixels out of rather than a texture
// to sample. Identical to rt.fbo at scale 1, so those readers keep binding exactly what they bind
// today.
uint32_t GSGlBackend::nativeViewFbo(RenderTarget &rt)
{
    return nativeView(rt) == rt.color ? rt.fbo : rt.mirrorFbo;
}

bool GSGlBackend::ensureResolveProgram()
{
    if (m_resolveProgram != 0u)
        return true;
    if (m_resolveProgramFailed)
        return false;
    const uint32_t vs = compileShader(GL_VERTEX_SHADER, kResolveVertexShader);
    const uint32_t fs = compileShader(GL_FRAGMENT_SHADER, kResolveFragmentShader);
    if (!vs || !fs)
    {
        if (vs)
            glDeleteShader(vs);
        if (fs)
            glDeleteShader(fs);
        m_resolveProgramFailed = true;
        return false;
    }
    m_resolveProgram = glCreateProgram();
    glAttachShader(m_resolveProgram, vs);
    glAttachShader(m_resolveProgram, fs);
    glLinkProgram(m_resolveProgram);
    GLint ok = 0;
    glGetProgramiv(m_resolveProgram, GL_LINK_STATUS, &ok);
    glDeleteShader(vs);
    glDeleteShader(fs);
    if (!ok)
    {
        char log[2048];
        glGetProgramInfoLog(m_resolveProgram, sizeof(log), nullptr, log);
        std::fprintf(stderr, "[gs-gl] scale-resolve program link failed: %s\n", log);
        glDeleteProgram(m_resolveProgram);
        m_resolveProgram = 0u;
        m_resolveProgramFailed = true;
        return false;
    }
    m_resolveUSrc = glGetUniformLocation(m_resolveProgram, "uSrc");
    m_resolveUScaleX = glGetUniformLocation(m_resolveProgram, "uScaleX");
    m_resolveUScaleY = glGetUniformLocation(m_resolveProgram, "uScaleY");
    glGenVertexArrays(1, &m_resolveVao);
    return true;
}

// Resolve the host-scale colour texture down into the target's native mirror. Unreachable at scale
// 1 (nativeView returns before calling this), so no scale-1 run allocates the mirror, compiles the
// box program or issues either pass.
void GSGlBackend::resolveToMirror(RenderTarget &rt)
{
    // The callers run in the middle of a draw batch (resolveTexture is called from setupDrawState
    // after glUseProgram, and the downloads from the texture path), so this pass restores every
    // piece of GL state it touches rather than assuming the next caller re-establishes it. The
    // capture has to come before the lazy allocation below, which binds an FBO of its own.
    // READ and DRAW are captured separately: the blit path below binds them to different
    // framebuffers, so restoring GL_FRAMEBUFFER (which would force the caller's read binding to
    // equal its draw binding) is only correct for a caller that happens to keep the two the same.
    // Every reader today does, but executePresent does not, and this is the pass a later reader
    // will be routed through.
    GLint prevReadFbo = 0, prevDrawFbo = 0, prevProgram = 0, prevVao = 0, prevActive = 0, prevTex = 0, prevViewport[4] = {0, 0, 0, 0};
    GLboolean prevMask[4] = {GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE};
    glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &prevReadFbo);
    glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &prevDrawFbo);
    glGetIntegerv(GL_VIEWPORT, prevViewport);
    glGetBooleanv(GL_COLOR_WRITEMASK, prevMask);
    const GLboolean wasScissor = glIsEnabled(GL_SCISSOR_TEST);

    if (rt.mirrorTexture == 0u)
    {
        GLint prevTexAlloc = 0;
        glGetIntegerv(GL_TEXTURE_BINDING_2D, &prevTexAlloc);
        glGenTextures(1, &rt.mirrorTexture);
        glBindTexture(GL_TEXTURE_2D, rt.mirrorTexture);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, static_cast<GLsizei>(rt.nativeWidth), static_cast<GLsizei>(rt.nativeHeight),
                     0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        glBindTexture(GL_TEXTURE_2D, static_cast<GLuint>(prevTexAlloc));
        // Exactly one texture and one FBO per render target, for the life of that target: the
        // native extent is chosen once by GsGlTarget::choose and afterwards only ever respecified
        // in place by growRenderTarget (same names), so there is no resize path that could leak a
        // second pair. Both are deleted beside rt.fbo / rt.color when the targets are dropped
        // (CmdType::Reset).
        glGenFramebuffers(1, &rt.mirrorFbo);
        glBindFramebuffer(GL_FRAMEBUFFER, rt.mirrorFbo);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, rt.mirrorTexture, 0);
        // Fail loudly, on the same reasoning as checkScale in getRenderTarget. If the allocation or
        // the attachment did not take, nativeView would hand the RT-as-texture path texture 0, and
        // -- far worse -- nativeViewFbo would hand both downloads framebuffer 0, the default
        // framebuffer, so glReadPixels would copy the host window straight into guest VRAM. A
        // corrupt frame buffer that looks like a scaling artefact is exactly what this must not be.
        const GLenum status = glCheckFramebufferStatus(GL_FRAMEBUFFER);
        if (status != GL_FRAMEBUFFER_COMPLETE || rt.mirrorTexture == 0u || rt.mirrorFbo == 0u)
        {
            std::fprintf(stderr, "[gs-gl] FATAL native mirror for fbp=%03x is incomplete: status=0x%04x tex=%u fbo=%u native %ux%u host %ux%u\n",
                         rt.fbp, static_cast<unsigned>(status), rt.mirrorTexture, rt.mirrorFbo,
                         rt.nativeWidth, rt.nativeHeight, rt.hostWidth, rt.hostHeight);
            std::abort();
        }
    }

    glDisable(GL_SCISSOR_TEST);
    // The box path's fragment shader honours the colour mask, so a batch that left one set would
    // otherwise write only some channels of the mirror. A glBlitFramebuffer does NOT honour it --
    // GL 3.3 section 18.3.1: a blit is affected by pixel ownership, the scissor and sRGB, and
    // nothing else -- so for the blit path this reset is merely harmless, not load-bearing. (The
    // present copy's blit further down is the same case; its comment states this correctly.)
    glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);

    const GLint hostW = static_cast<GLint>(rt.hostWidth), hostH = static_cast<GLint>(rt.hostHeight);
    const GLint natW = static_cast<GLint>(rt.nativeWidth), natH = static_cast<GLint>(rt.nativeHeight);
    if (resolveFilterIsBox() && ensureResolveProgram())
    {
        glGetIntegerv(GL_CURRENT_PROGRAM, &prevProgram);
        glGetIntegerv(GL_VERTEX_ARRAY_BINDING, &prevVao);
        glGetIntegerv(GL_ACTIVE_TEXTURE, &prevActive);
        glActiveTexture(GL_TEXTURE0);
        glGetIntegerv(GL_TEXTURE_BINDING_2D, &prevTex);
        const GLboolean wasBlend = glIsEnabled(GL_BLEND), wasDepth = glIsEnabled(GL_DEPTH_TEST), wasCull = glIsEnabled(GL_CULL_FACE);
        glDisable(GL_BLEND);
        glDisable(GL_DEPTH_TEST);
        glDisable(GL_CULL_FACE);
        glBindFramebuffer(GL_FRAMEBUFFER, rt.mirrorFbo);
        glViewport(0, 0, natW, natH);
        glUseProgram(m_resolveProgram);
        glUniform1i(m_resolveUSrc, 0);
        glUniform1i(m_resolveUScaleX, hostW / natW);
        glUniform1i(m_resolveUScaleY, hostH / natH);
        glBindTexture(GL_TEXTURE_2D, rt.color);
        glBindVertexArray(m_resolveVao);
        glDrawArrays(GL_TRIANGLES, 0, 3);
        glBindVertexArray(static_cast<GLuint>(prevVao));
        glUseProgram(static_cast<GLuint>(prevProgram));
        glBindTexture(GL_TEXTURE_2D, static_cast<GLuint>(prevTex));
        glActiveTexture(static_cast<GLenum>(prevActive));
        if (wasBlend)
            glEnable(GL_BLEND);
        if (wasDepth)
            glEnable(GL_DEPTH_TEST);
        if (wasCull)
            glEnable(GL_CULL_FACE);
    }
    else
    {
        glBindFramebuffer(GL_READ_FRAMEBUFFER, rt.fbo);
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER, rt.mirrorFbo);
        glBlitFramebuffer(0, 0, hostW, hostH, 0, 0, natW, natH, GL_COLOR_BUFFER_BIT, GL_NEAREST);
    }

    glViewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
    glColorMask(prevMask[0], prevMask[1], prevMask[2], prevMask[3]);
    if (wasScissor)
        glEnable(GL_SCISSOR_TEST);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, static_cast<GLuint>(prevReadFbo));
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, static_cast<GLuint>(prevDrawFbo));
}

// Download a render target (GPU) into the shadow VRAM so texture decoding sees the drawn pixels.
void GSGlBackend::downloadRenderTargetToShadow(RenderTarget &rt)
{
    // Native throughout: `h` is a native row count, the buffer stride and the glReadPixels rect
    // below are native pixels, and the source is nativeViewFbo() rather than rt.fbo -- which is
    // rt.fbo itself at scale 1 (research/14 section 8.1 item 1).
    const uint32_t h = std::min<uint32_t>(rt.usedHeight, rt.nativeHeight);
    std::vector<uint32_t> pixels(static_cast<size_t>(rt.nativeWidth) * h);
    {
        // PS2X_GS_TRACE_PRESENT: log the downloads after the trace point (layout the shadow is written with).
        const long s_dlSkip = traceSkip("PS2X_GS_TRACE_PRESENT");
        static uint32_t s_dlPrinted = 0u;
        if (s_dlSkip >= 0 && static_cast<long>(m_frameCounter) > s_dlSkip && s_dlPrinted < 20u)
        {
            ++s_dlPrinted;
            std::fprintf(stderr, "[gs-gl download] frame=%llu rt fbp=%03x fbw=%u psm=%02x used=%u rows=%u dirty=%d %u..%u gpu=%d %u..%u\n",
                         (unsigned long long)m_frameCounter, rt.fbp, rt.fbw, rt.psm, rt.usedHeight, h,
                         rt.dirtyRows ? 1 : 0, rt.dirtyRowFirst, rt.dirtyRowLast, rt.gpuRows ? 1 : 0, rt.gpuRowFirst, rt.gpuRowLast);
        }
    }
    // Called from the texture path in the middle of a draw batch: restore the batch target's
    // FBO afterwards, or the draw lands in this target (SOCOM II's movie copy sprite went into
    // the staging buffer instead of the display buffer whenever the two were laid out that way).
    GLint prevFbo = 0;
    glGetIntegerv(GL_FRAMEBUFFER_BINDING, &prevFbo);
    glBindFramebuffer(GL_FRAMEBUFFER, nativeViewFbo(rt));
    glPixelStorei(GL_PACK_ALIGNMENT, 4);
    glReadPixels(0, 0, rt.nativeWidth, h, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());
    const uint32_t base = rt.fbp << 5;
    // Only rows the GPU drew since the last sync (see noteGpuRows); nothing else is stale.
    const uint32_t yStart = rt.gpuRows ? std::min(h, rt.gpuRowFirst) : 0u;
    const uint32_t yEnd = rt.gpuRows ? std::min(h, rt.gpuRowLast) : 0u;
    const uint32_t xEnd = std::min<uint32_t>(rt.nativeWidth, std::max<uint32_t>(1u, rt.fbw) * 64u);
    if (yEnd > yStart)
    {
        const uint32_t ph = pageHeightForPsm(rt.psm), ppr = std::max<uint32_t>(1u, rt.fbw);
        const uint32_t p0 = rt.fbp + (yStart / ph) * ppr, p1 = rt.fbp + ((yEnd + ph - 1u) / ph) * ppr;
        if (p1 > p0 && tracePagesHit(p0, p1 - p0))
            std::fprintf(stderr, "[gs-pages] frame=%llu download gpu->shadow rt fbp=%03x rows %u..%u (skip dirty %d %u..%u) pages %03x+%u\n",
                         (unsigned long long)m_frameCounter, rt.fbp, yStart, yEnd, rt.dirtyRows ? 1 : 0, rt.dirtyRowFirst, rt.dirtyRowLast, p0, p1 - p0);
    }
    for (uint32_t y = yStart; y < yEnd; ++y)
    {
        // Rows an image upload wrote into the shadow after the last GPU draw hold the newest
        // data (the GPU copy is refreshed from them lazily): do not clobber them with the stale
        // GPU pixels. SOCOM II's movie path clears the movie buffer on the GPU, uploads the next
        // decoded frame into it, then textures from it; this download used to overwrite the
        // uploaded frame with the clear, so every movie frame textured black.
        if (rt.dirtyRows && ((rt.dirtyMask & (1u << std::min<uint32_t>(31u, y / 32u))) || std::any_of(rt.dirtyRects.begin(), rt.dirtyRects.end(), [&](const RenderTarget::DirtyRect &r) { return y >= r.y0 && y < r.y1; })))
            continue;
        // Only the buffer's own width: the texture is 1024 px wide regardless of FBW, and pixels
        // past FBW*64 address the *next* page row's first columns (SOCOM II's movie staging
        // buffer, FBW 10, got its frame rows 96..128 of page columns 0-5 blacked out by the GPU
        // rows 64..96 of the same target — a seam at x=384 on every movie frame).
        for (uint32_t x = 0; x < xEnd; ++x)
        {
            uint32_t p = pixels[static_cast<size_t>(y) * rt.nativeWidth + x];
            if (rt.psm == GS_PSM_CT16 || rt.psm == GS_PSM_CT16S)
                p = rgba8888To5551(p);
            writeVramRaw(m_shadowMemory.data(), rt.psm, base, rt.fbw, x, y, p);
        }
    }
    if (uploadGateOn())
        m_uploadGate.noteForeignWrite(rt.fbp, pageSpan(rt.psm, rt.fbw, h));   // V2: the shadow took GPU pixels
    rt.shadowStale = false;
    rt.gpuRows = false;
    glBindFramebuffer(GL_FRAMEBUFFER, static_cast<GLuint>(prevFbo));
}

// Download into the game thread's authoritative VRAM (guest reads GS memory).
void GSGlBackend::downloadRenderTargetToCpu(RenderTarget &rt)
{
    // Native throughout; see downloadRenderTargetToShadow.
    const uint32_t h = std::min<uint32_t>(rt.usedHeight, rt.nativeHeight);
    std::vector<uint32_t> pixels(static_cast<size_t>(rt.nativeWidth) * h);
    // Called from the texture path in the middle of a draw batch: restore the batch target's
    // FBO afterwards, or the draw lands in this target (SOCOM II's movie copy sprite went into
    // the staging buffer instead of the display buffer whenever the two were laid out that way).
    GLint prevFbo = 0;
    glGetIntegerv(GL_FRAMEBUFFER_BINDING, &prevFbo);
    glBindFramebuffer(GL_FRAMEBUFFER, nativeViewFbo(rt));
    glPixelStorei(GL_PACK_ALIGNMENT, 4);
    glReadPixels(0, 0, rt.nativeWidth, h, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());
    const uint32_t base = rt.fbp << 5;
    const uint32_t yStart = rt.gpuRows ? std::min(h, rt.gpuRowFirst) : 0u;   // see downloadRenderTargetToShadow
    const uint32_t yEnd = rt.gpuRows ? std::min(h, rt.gpuRowLast) : 0u;
    const uint32_t xEnd = std::min<uint32_t>(rt.nativeWidth, std::max<uint32_t>(1u, rt.fbw) * 64u);
    if (yEnd > yStart)
    {
        const uint32_t ph = pageHeightForPsm(rt.psm), ppr = std::max<uint32_t>(1u, rt.fbw);
        const uint32_t p0 = rt.fbp + (yStart / ph) * ppr, p1 = rt.fbp + ((yEnd + ph - 1u) / ph) * ppr;
        if (p1 > p0 && tracePagesHit(p0, p1 - p0))
            std::fprintf(stderr, "[gs-pages] frame=%llu download gpu->cpu rt fbp=%03x rows %u..%u (skip dirty %d %u..%u) pages %03x+%u\n",
                         (unsigned long long)m_frameCounter, rt.fbp, yStart, yEnd, rt.dirtyRows ? 1 : 0, rt.dirtyRowFirst, rt.dirtyRowLast, p0, p1 - p0);
    }
    for (uint32_t y = yStart; y < yEnd; ++y)
    {
        if (rt.dirtyRows && ((rt.dirtyMask & (1u << std::min<uint32_t>(31u, y / 32u))) || std::any_of(rt.dirtyRects.begin(), rt.dirtyRects.end(), [&](const RenderTarget::DirtyRect &r) { return y >= r.y0 && y < r.y1; })))   // see downloadRenderTargetToShadow
            continue;
        // Only the buffer's own width: the texture is 1024 px wide regardless of FBW, and pixels
        // past FBW*64 address the *next* page row's first columns (SOCOM II's movie staging
        // buffer, FBW 10, got its frame rows 96..128 of page columns 0-5 blacked out by the GPU
        // rows 64..96 of the same target — a seam at x=384 on every movie frame).
        for (uint32_t x = 0; x < xEnd; ++x)
        {
            uint32_t p = pixels[static_cast<size_t>(y) * rt.nativeWidth + x];
            if (rt.psm == GS_PSM_CT16 || rt.psm == GS_PSM_CT16S)
                p = rgba8888To5551(p);
            m_cpu->WriteVram(rt.psm, base, rt.fbw, x, y, p);
            writeVramRaw(m_shadowMemory.data(), rt.psm, base, rt.fbw, x, y, p);
        }
    }
    if (uploadGateOn())
        m_uploadGate.noteForeignWrite(rt.fbp, pageSpan(rt.psm, rt.fbw, h));   // V2: the shadow took GPU pixels
    rt.gpuDirty = false;
    rt.shadowStale = false;
    rt.gpuRows = false;
    glBindFramebuffer(GL_FRAMEBUFFER, static_cast<GLuint>(prevFbo));
}

void GSGlBackend::executeReadback()
{
    for (RenderTarget &rt : m_renderTargets)
        if (rt.gpuDirty)
            downloadRenderTargetToCpu(rt);
}

void GSGlBackend::executePresent(const GSPresentationRequest &request)
{
    const GSFrameReg display1 = decodeDisplayFrame(request.dispfb1);
    const GSFrameReg display2 = decodeDisplayFrame(request.dispfb2);
    const bool en1 = (request.pmode & 1ull) != 0ull && hasDisplaySetup(request.display1, display1);
    const bool en2 = (request.pmode & 2ull) != 0ull && hasDisplaySetup(request.display2, display2);
    const GSFrameReg &display = en1 ? display1 : display2;
    uint32_t width = 0u, height = 0u;
    decodeDisplaySize(en1 ? request.display1 : request.display2, width, height);
    if (!en1 && !en2)
    {
        // Display off (PMODE EN1=EN2=0): the host shows black. Blank the dump pixels too so
        // PS2X_FRAME_DUMP counters do not report the last presented frame as still visible.
        m_presentTexture = 0u;
        if (m_presentPixelsRequested)
        {
            std::lock_guard<std::mutex> lock(m_queueMutex);
            m_presentPixels.assign(static_cast<size_t>(kHostFrameWidth) * kHostFrameHeight * 4u, 0u);
        }
        static uint32_t s_offLogged = 0u;
        if (s_offLogged < 2u)
        {
            ++s_offLogged;
            std::fprintf(stderr, "[gs-gl present] frame=%llu display off (pmode=%llx)\n", (unsigned long long)m_frameCounter, (unsigned long long)request.pmode);
        }
        return;
    }

    RenderTarget *rt = getRenderTarget(display.fbp, display.fbw, display.psm, false);
    if (!rt)
    {
        // The display base may sit inside a larger target (or an upload-only buffer).
        for (RenderTarget &candidate : m_renderTargets)
        {
            const uint32_t span = pageSpan(candidate.psm, candidate.fbw, std::min<uint32_t>(candidate.usedHeight, 512u));
            if (display.fbp >= candidate.fbp && display.fbp < candidate.fbp + span)
            {
                rt = &candidate;
                break;
            }
        }
    }
    if (!rt)
        rt = getRenderTarget(display.fbp, display.fbw, display.psm, true);
    if (request.hasPreferredSource && request.preferredDestFbp == display.fbp)
    {
        if (RenderTarget *pref = getRenderTarget(request.preferredSource.fbp, request.preferredSource.fbw, request.preferredSource.psm, false))
            if (pref->gpuDirty)
                rt = pref;
    }
    // PS2X_GS_TRACE_PRESENT: sample the displayed target before the shadow refresh, and record
    // the refresh window, to tell a blank target from a refresh that blanks it.
    {
        static const long s_skipPre = [] { const char *e = ps2x::knob("PS2X_GS_TRACE_PRESENT"); return e ? std::strtol(e, nullptr, 0) : -1L; }();
        static uint32_t s_printedPre = 0u;
        // After the skip: the first 30 presents, then every present that still has pending
        // dirty rows below 512 (the visible part of the display buffers) — a refresh that would
        // repaint rows of a buffer the game already drew over.
        if (s_skipPre >= 0 && static_cast<long>(m_frameCounter + 1u) > s_skipPre &&
            (s_printedPre < 30u || (rt->dirtyRows && rt->dirtyRowFirst < 512u)))
        {
            ++s_printedPre;
            uint8_t px[4] = {0, 0, 0, 0};
            glBindFramebuffer(GL_READ_FRAMEBUFFER, rt->fbo);
            glReadPixels(320, 224, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, px);
            glBindFramebuffer(GL_FRAMEBUFFER, 0);
            std::fprintf(stderr, "[gs-gl present-pre] frame=%llu rt fbp=%03x fbo=%u used=%u centre=%02x%02x%02x%02x dirty=%d rows=%u..%u shadowStale=%d gpuDirty=%d pref=%d\n",
                         (unsigned long long)(m_frameCounter + 1u), rt->fbp, rt->fbo, rt->usedHeight, px[0], px[1], px[2], px[3],
                         rt->dirtyRows ? 1 : 0, rt->dirtyRowFirst, rt->dirtyRowLast, rt->shadowStale ? 1 : 0, rt->gpuDirty ? 1 : 0,
                         (request.hasPreferredSource && request.preferredDestFbp == display.fbp) ? 1 : 0);
        }
    }
    // DISPLAY gives the field height (224) when the game renders full frames (448 rows) and
    // scans out interlaced; present the rows that were actually drawn in that case.
    refreshDirtyRows(*rt);
    // PS2X_GS_DUMP_DISPLAY="<dir>:<t0>:<t1>": every ~2 s of host time in [t0, t1) write the
    // displayed buffer three ways (gpu = the GL target, shadow = the render thread's VRAM copy,
    // cpu = the authoritative game-thread VRAM) as PPMs, to tell which layer holds a pixel.
    {
        static const char *const s_dumpEnv = ps2x::knob("PS2X_GS_DUMP_DISPLAY");
        if (s_dumpEnv)
        {
            static const auto s_epoch = std::chrono::steady_clock::now();
            static double s_next = -1.0;
            static std::string s_dir;
            static double s_t0 = 0.0, s_t1 = 0.0;
            if (s_next < 0.0)
            {
                std::string spec(s_dumpEnv);
                // "<dir>:<t0>:<t1>" — split on the LAST two colons (the dir may carry a drive letter).
                const size_t c2 = spec.rfind(':');
                const size_t c1 = c2 == std::string::npos ? std::string::npos : spec.rfind(':', c2 - 1);
                s_dir = spec.substr(0, c1);
                s_t0 = c1 == std::string::npos ? 0.0 : std::atof(spec.c_str() + c1 + 1);
                s_t1 = c2 == std::string::npos ? 1e9 : std::atof(spec.c_str() + c2 + 1);
                s_next = s_t0;
            }
            const double elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - s_epoch).count();
            if (elapsed >= s_next && elapsed < s_t1)
            {
                s_next = elapsed + 2.0;
                // The "gpu" PPM is compared pixel-for-pixel with the "shadow" and "cpu" PPMs, which
                // are read out of native VRAM: read the native view so all three have the same
                // extent at any scale (research/14 section 8.1 item 3).
                const uint32_t w = std::min<uint32_t>(640u, rt->nativeWidth), h = std::min<uint32_t>(448u, rt->nativeHeight);
                std::vector<uint32_t> gpu(static_cast<size_t>(rt->nativeWidth) * h);
                glBindFramebuffer(GL_READ_FRAMEBUFFER, nativeViewFbo(*rt));
                glReadPixels(0, 0, rt->nativeWidth, h, GL_RGBA, GL_UNSIGNED_BYTE, gpu.data());
                glBindFramebuffer(GL_FRAMEBUFFER, 0);
                const uint32_t base = rt->fbp << 5;
                auto writePpm = [&](const char *tag, auto fetch)
                {
                    char name[512];
                    std::snprintf(name, sizeof(name), "%s/display_%03.0fs_fbp%03x_%s.ppm", s_dir.c_str(), elapsed, rt->fbp, tag);
                    FILE *f = std::fopen(name, "wb");
                    if (!f)
                        return;
                    std::fprintf(f, "P6\n%u %u\n255\n", w, h);
                    for (uint32_t y = 0; y < h; ++y)
                        for (uint32_t x = 0; x < w; ++x)
                        {
                            const uint32_t p = fetch(x, y);
                            const uint8_t rgb[3] = {static_cast<uint8_t>(p & 0xFFu), static_cast<uint8_t>((p >> 8) & 0xFFu), static_cast<uint8_t>((p >> 16) & 0xFFu)};
                            std::fwrite(rgb, 1, 3, f);
                        }
                    std::fclose(f);
                };
                writePpm("gpu", [&](uint32_t x, uint32_t y) { return gpu[static_cast<size_t>(y) * rt->nativeWidth + x]; });
                writePpm("shadow", [&](uint32_t x, uint32_t y) { return readVramRaw(m_shadowMemory.data(), rt->psm, base, rt->fbw, x, y); });
                writePpm("cpu", [&](uint32_t x, uint32_t y) { return m_cpu->ReadVram(rt->psm, base, rt->fbw, x, y); });
                std::fprintf(stderr, "[gs-gl dump-display] t=%.1f frame=%llu fbp=%03x -> %s\n", elapsed, (unsigned long long)m_frameCounter, rt->fbp, s_dir.c_str());
            }
        }
    }
    // Copy the presented rectangle into a dedicated texture: the render target keeps being drawn
    // into (the next frame's clear lands on it while it is on screen), which showed as flicker.
    // [* S site 6 -- presentation] research/14 section 8.1 item 2: the DISPLAY rectangle is a
    // native GS extent (so the clamp against nativeWidth/Height is native), but every GL consumer
    // of it is a host rect. Settled by naming the two rather than by a bare * kScale at each use:
    // m_presentNative* is the clamped native rectangle, m_presentHost* the same rectangle in host
    // texels. min(display, native) * S is identically min(display * S, host), so this agrees with
    // section 2.9's formulation too.
    m_presentNativeWidth = std::min<uint32_t>(width, rt->nativeWidth);
    m_presentNativeHeight = std::min<uint32_t>(height, rt->nativeHeight);
    m_presentHostWidth = m_presentNativeWidth * renderScale();
    m_presentHostHeight = m_presentNativeHeight * renderScale();
    if (m_presentCopyTexture == 0u || m_presentTexWidth != rt->hostWidth || m_presentTexHeight != rt->hostHeight)
    {
        if (m_presentCopyTexture != 0u)
            glDeleteTextures(1, &m_presentCopyTexture);
        if (m_presentCopyFbo == 0u)
            glGenFramebuffers(1, &m_presentCopyFbo);
        glGenTextures(1, &m_presentCopyTexture);
        glBindTexture(GL_TEXTURE_2D, m_presentCopyTexture);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, rt->hostWidth, rt->hostHeight, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        m_presentTexWidth = rt->hostWidth;
        m_presentTexHeight = rt->hostHeight;
    }
    glBindFramebuffer(GL_READ_FRAMEBUFFER, rt->fbo);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, m_presentCopyFbo);
    glFramebufferTexture2D(GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, m_presentCopyTexture, 0);
    glDisable(GL_SCISSOR_TEST);
    // glBlitFramebuffer is NOT affected by the colour mask (GL 3.3 section 18.3.1: a blit is
    // affected only by pixel ownership, the scissor and sRGB). This reset is therefore harmless
    // here, not load-bearing -- see resolveToMirror above, whose box path is the case where the
    // mask is real.
    glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    glBlitFramebuffer(0, 0, static_cast<GLint>(m_presentHostWidth), static_cast<GLint>(m_presentHostHeight),
                      0, 0, static_cast<GLint>(m_presentHostWidth), static_cast<GLint>(m_presentHostHeight),
                      GL_COLOR_BUFFER_BIT, GL_NEAREST);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    m_presentTexture = m_presentCopyTexture;
    m_presentFbp = display.fbp;

    // PMODE merge: both read circuits enabled on different frame buffers. SOCOM II shows its
    // pre-rendered movies this way — circuit 1 reads a black buffer, circuit 2 the buffer the
    // decoded frames are uploaded into, ALP=0x7f (MMOD=1) — so presenting circuit 1 alone was a
    // black screen. Copy circuit 2's target too and hand it out with alpha = its weight
    // (1 - ALP/255); the host draws it alpha-blended over circuit 1. SLBG=1 (background colour
    // instead of circuit 2) and MMOD=0 (per-pixel alpha from circuit 1) fall back to circuit 1.
    m_presentTexture2 = 0u;
    if (en1 && en2 && display2.fbp != display1.fbp)
    {
        const bool mmod = (request.pmode & (1ull << 5)) != 0ull;
        const bool slbg = (request.pmode & (1ull << 7)) != 0ull;
        const uint32_t alp = static_cast<uint32_t>((request.pmode >> 8) & 0xFFull);
        if (mmod && !slbg && alp < 0xFFu)
        {
            RenderTarget *rt2 = getRenderTarget(display2.fbp, display2.fbw, display2.psm, false);
            if (!rt2)
            {
                for (RenderTarget &candidate : m_renderTargets)
                {
                    const uint32_t span = pageSpan(candidate.psm, candidate.fbw, std::min<uint32_t>(candidate.usedHeight, 512u));
                    if (display2.fbp >= candidate.fbp && display2.fbp < candidate.fbp + span)
                    {
                        rt2 = &candidate;
                        break;
                    }
                }
            }
            if (rt2 && rt2 != rt)
            {
                refreshDirtyRows(*rt2);
                if (m_presentCopyTexture2 == 0u || m_presentTexWidth != rt->hostWidth || m_presentTexHeight != rt->hostHeight)
                {
                    if (m_presentCopyTexture2 != 0u)
                        glDeleteTextures(1, &m_presentCopyTexture2);
                    if (m_presentCopyFbo2 == 0u)
                        glGenFramebuffers(1, &m_presentCopyFbo2);
                    glGenTextures(1, &m_presentCopyTexture2);
                    glBindTexture(GL_TEXTURE_2D, m_presentCopyTexture2);
                    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, rt->hostWidth, rt->hostHeight, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
                    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
                    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
                    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
                    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
                }
                // Clamp in native units against the second circuit's native extent, then scale:
                // both framebuffers in the blit below are host-sized.
                const uint32_t w2 = std::min<uint32_t>(m_presentNativeWidth, rt2->nativeWidth) * renderScale();
                const uint32_t h2 = std::min<uint32_t>(m_presentNativeHeight, rt2->nativeHeight) * renderScale();
                glBindFramebuffer(GL_READ_FRAMEBUFFER, rt2->fbo);
                glBindFramebuffer(GL_DRAW_FRAMEBUFFER, m_presentCopyFbo2);
                glFramebufferTexture2D(GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, m_presentCopyTexture2, 0);
                glDisable(GL_SCISSOR_TEST);
                glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
                glBlitFramebuffer(0, 0, static_cast<GLint>(w2), static_cast<GLint>(h2),
                                  0, 0, static_cast<GLint>(w2), static_cast<GLint>(h2),
                                  GL_COLOR_BUFFER_BIT, GL_NEAREST);
                // Alpha channel := circuit 2's weight in the merge (RGB untouched).
                glBindFramebuffer(GL_FRAMEBUFFER, m_presentCopyFbo2);
                glColorMask(GL_FALSE, GL_FALSE, GL_FALSE, GL_TRUE);
                glClearColor(0.0f, 0.0f, 0.0f, 1.0f - static_cast<float>(alp) / 255.0f);
                glClear(GL_COLOR_BUFFER_BIT);
                glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
                glBindFramebuffer(GL_FRAMEBUFFER, 0);
                m_presentTexture2 = m_presentCopyTexture2;
            }
        }
    }
    ++m_frameCounter;
    // PS2X_GS_TRACE_PRESENT=<skip>: after <skip> presents, print 30 presents with the copy's
    // centre pixel (rgba) and the GL error state, to tell a black copy from a black draw.
    {
        static const long s_skip = [] { const char *e = ps2x::knob("PS2X_GS_TRACE_PRESENT"); return e ? std::strtol(e, nullptr, 0) : -1L; }();
        static uint32_t s_printed = 0u;
        if (s_skip >= 0 && static_cast<long>(m_frameCounter) > s_skip && s_printed < 30u)
        {
            ++s_printed;
            uint8_t px[4] = {0, 0, 0, 0};
            glBindFramebuffer(GL_READ_FRAMEBUFFER, m_presentCopyFbo);
            glReadPixels(static_cast<GLint>(m_presentHostWidth / 2u), static_cast<GLint>(m_presentHostHeight / 2u), 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, px);
            glBindFramebuffer(GL_FRAMEBUFFER, 0);
            uint8_t px2[4] = {0, 0, 0, 0};
            if (m_presentTexture2 != 0u)
            {
                glBindFramebuffer(GL_READ_FRAMEBUFFER, m_presentCopyFbo2);
                glReadPixels(static_cast<GLint>(m_presentHostWidth / 2u), static_cast<GLint>(m_presentHostHeight / 2u), 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, px2);
                glBindFramebuffer(GL_FRAMEBUFFER, 0);
            }
            std::fprintf(stderr, "[gs-gl present-trace] frame=%llu en1=%d en2=%d pmode=%llx fbp=%03x fbp2=%03x rt#fbo=%u %ux%u copy=%u centre=%02x%02x%02x%02x tex2=%u centre2=%02x%02x%02x%02x glerr=0x%x\n",
                         (unsigned long long)m_frameCounter, en1 ? 1 : 0, en2 ? 1 : 0, (unsigned long long)request.pmode, display.fbp, display2.fbp, rt->fbo,
                         m_presentHostWidth, m_presentHostHeight, m_presentCopyTexture, px[0], px[1], px[2], px[3],
                         m_presentTexture2, px2[0], px2[1], px2[2], px2[3], glGetError());
        }
    }
    {
        static uint32_t s_logged = 0u;
        // PS2X_GS_TRACE_DISPFB=1: log every change of the displayed buffer (fbp/fbw/psm/size).
        static const bool s_traceDispfb = ps2x::knob("PS2X_GS_TRACE_DISPFB") != nullptr;
        static uint64_t s_lastKey = ~0ull;
        const uint64_t key = (static_cast<uint64_t>(display.fbp) << 32) | (display.fbw << 24) | (display.psm << 16) | (width << 4) | (height & 0xFu) | (static_cast<uint64_t>(height) << 40);
        const bool changed = s_traceDispfb && key != s_lastKey;
        s_lastKey = key;
        if (changed || (s_logged < 4u && (m_frameCounter == 1u || m_frameCounter == 600u || m_frameCounter == 1200u || m_frameCounter == 1800u)))
        {
            if (!changed)
                ++s_logged;
            // display/rt/used are NATIVE GS extents; present is the HOST rect (native * scale).
            std::fprintf(stderr, "[gs-gl present] frame=%llu dispfb fbp=%03x fbw=%u psm=%02x display(native)=%ux%u smode2=%llx rt(native)=%ux%u used(native)=%u -> present(host)=%ux%u\n",
                         (unsigned long long)m_frameCounter, display.fbp, display.fbw, display.psm, width, height,
                         (unsigned long long)request.smode2, rt->nativeWidth, rt->nativeHeight, rt->usedHeight, m_presentHostWidth, m_presentHostHeight);
        }
    }

    if (m_presentPixelsRequested)
    {
        // The fifth guest-visible-ish read, deliberately left unrouted by S3-b (research/14
        // section 9.5) because it is item 2's territory. Settled NATIVE: m_presentPixels is a fixed
        // kHostFrameWidth x kHostFrameHeight (640x512) buffer that the parity harness and the CPU
        // backend both speak in native GS pixels, so scaling this capture would either hand back
        // the top-left 1/S corner of the frame (reading a host rect into a native buffer) or a
        // frame at a size the harness cannot compare. Reading the native mirror keeps
        // PS2X_FRAME_DUMP and every parity capture identical in shape at any scale -- and at scale
        // 1 nativeViewFbo() IS rt->fbo, so this is the same call it was.
        const uint32_t dumpW = m_presentNativeWidth, dumpH = m_presentNativeHeight;
        std::vector<uint32_t> pixels(static_cast<size_t>(dumpW) * dumpH);
        glBindFramebuffer(GL_FRAMEBUFFER, nativeViewFbo(*rt));
        glPixelStorei(GL_PACK_ALIGNMENT, 4);
        glReadPixels(0, 0, dumpW, dumpH, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        std::lock_guard<std::mutex> lock(m_queueMutex);
        m_presentPixels.assign(static_cast<size_t>(kHostFrameWidth) * kHostFrameHeight * 4u, 0u);
        for (uint32_t y = 0; y < dumpH && y < kHostFrameHeight; ++y)
            std::memcpy(m_presentPixels.data() + static_cast<size_t>(y) * kHostFrameWidth * 4u,
                        pixels.data() + static_cast<size_t>(y) * dumpW,
                        std::min<uint32_t>(dumpW, kHostFrameWidth) * 4u);
    }
}

// ---------------------------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------------------------
// Sprint 8 Goal 2b R123: the hash of the exact source bytes a decode of this texture would read,
// right now, out of the shadow -- the texel spans in decodeTexture's own order, then the 256 CLUT
// entries it would resolve. Returns GsGlTextureIdentity::kUnhashable (0) when the source cannot be
// walked, and the caller then decodes as it always did.
//
// WHY THE SHADOW BYTES HASHED HERE ARE THE BYTES A DECODE WOULD READ: resolveTexture runs its
// render-target reconciliation BEFORE the cache gate -- the RT-as-texture fast path returns first,
// and the loop below it walks m_renderTargets for any shadowStale target overlapping the texture's
// pages and calls downloadRenderTargetToShadow + markShadowPages on it. So by the time the gate
// looks at a cached entry, every pending GPU->shadow download for those pages has already been
// performed, and a decode taken at this instant would read exactly these bytes. (That download is
// also what moves the generation that brought us to the gate in the first place, and it changes
// the bytes, so such a texture re-hashes differently and is decoded, not revalidated.)
uint64_t GSGlBackend::textureSourceHash(const GSDrawState &state, uint32_t width, uint32_t height)
{
    const GSTex0Reg &tex = state.context.tex0;
    static thread_local std::vector<uint32_t> s_row;
    if (s_row.size() < width)
        s_row.resize(width);
    uint64_t h = GsGlTextureIdentity::hashTexels(m_shadowMemory.data(), tex.psm, tex.tbp0, tex.tbw,
                                                 width, height, s_row.data(), GsGlTextureIdentity::seed());
    if (h == GsGlTextureIdentity::kUnhashable)
        return GsGlTextureIdentity::kUnhashable;
    const bool indexed = tex.psm == GS_PSM_T8 || tex.psm == GS_PSM_T8H || tex.psm == GS_PSM_T4 ||
                         tex.psm == GS_PSM_T4HL || tex.psm == GS_PSM_T4HH;
    if (!indexed)
        return h;
    // The palette this decode would use, resolved exactly as decodeTexture resolves it: the
    // frontend's snapshot when the draw carries a clutId (immutable, and already part of the cache
    // key), otherwise the live slot in the shadow.
    const uint32_t clutWidth = (state.texclut.cbw != 0u) ? static_cast<uint32_t>(state.texclut.cbw) : 1u;
    const GSClutLoad *clutLoad = nullptr;
    if (state.context.clutId != 0u && tex.csm == 0u && state.texclut.cou == 0u && state.texclut.cov == 0u)
    {
        auto cl = m_cluts.find(state.context.clutId);
        if (cl != m_cluts.end())
            clutLoad = &cl->second;
    }
    uint8_t *clutVram = clutLoad ? const_cast<uint8_t *>(clutLoad->bytes.data()) : m_shadowMemory.data();
    const uint32_t clutBp = clutLoad ? 0u : tex.cbp;
    const uint32_t clutBw = clutLoad ? 1u : clutWidth;
    const uint8_t clutPsm = clutLoad ? clutLoad->cpsm : tex.cpsm;
    uint32_t clut[256];
    for (uint32_t i = 0; i < 256u; ++i)
    {
        const uint32_t clutIndex = resolveClutIndex(static_cast<uint8_t>(i), clutPsm, tex.csm, tex.csa, tex.psm);
        const uint32_t clutX = static_cast<uint32_t>(state.texclut.cou) + (clutIndex & 0x0Fu);
        const uint32_t clutY = static_cast<uint32_t>(state.texclut.cov) + (clutIndex >> 4);
        switch (clutPsm)
        {
        case GS_PSM_CT32: clut[i] = GSMem::ReadCT32(clutVram, clutBp, clutBw, clutX, clutY); break;
        case GS_PSM_CT24: clut[i] = GSMem::ReadCT24(clutVram, clutBp, clutBw, clutX, clutY); break;
        case GS_PSM_CT16: clut[i] = GSMem::ReadCT16(clutVram, clutBp, clutBw, clutX, clutY); break;
        case GS_PSM_CT16S: clut[i] = GSMem::ReadCT16S(clutVram, clutBp, clutBw, clutX, clutY); break;
        default: clut[i] = 0xFFFF00FFu; break;
        }
    }
    return GsGlTextureIdentity::hashClut(clut, h);
}

uint32_t GSGlBackend::decodeTexture(const GSDrawState &state, const TextureKey &key, uint32_t width, uint32_t height, uint32_t pageStart, uint32_t pageCount)
{
    const GSTex0Reg &tex = state.context.tex0;
    std::vector<uint32_t> pixels(static_cast<size_t>(width) * height);
    {
        // PS2X_GS_TRACE_PRESENT: the same per-page-column scan as upload-scan, at decode time,
        // for the movie staging buffers (tbp0 0 / 0x1180, frame rows 96..336 in the buffer).
        const long s_dcSkip = traceSkip("PS2X_GS_TRACE_PRESENT");
        static uint32_t s_dcPrinted = 0u;
        const bool dcPrint = s_dcSkip >= 0 && static_cast<long>(m_frameCounter) > s_dcSkip && s_dcPrinted < 12u;
        if ((dcPrint || (m_movieStartFrame != 0u && m_seamFrame == 0u)) && tex.psm == GS_PSM_CT32 &&
            (tex.tbp0 == 0u || tex.tbp0 == 0x1180u) && width >= 640u)
        {
            int rows[10] = {-1, -1, -1, -1, -1, -1, -1, -1, -1, -1};
            char line[256];
            int n = std::snprintf(line, sizeof(line), "[gs-gl decode-scan] frame=%llu tbp0=%05x tbw=%u first-row/page-col:",
                                  (unsigned long long)m_frameCounter, tex.tbp0, tex.tbw);
            for (uint32_t c = 0; c < 10u && n < 240; ++c)
            {
                int firstRow = -1;
                for (uint32_t y = 90u; y < 340u; ++y)
                {
                    uint32_t sum = 0, cnt = 0;
                    for (uint32_t x = c * 64u; x < c * 64u + 64u; x += 4u, ++cnt)
                    {
                        const uint32_t p = readVramRaw(m_shadowMemory.data(), tex.psm, tex.tbp0, tex.tbw, x, y);
                        sum += ((p & 0xFFu) + ((p >> 8) & 0xFFu) + ((p >> 16) & 0xFFu)) / 3u;
                    }
                    if (sum > 8u * cnt) { firstRow = static_cast<int>(y); break; }
                }
                rows[c] = firstRow;
                n += std::snprintf(line + n, sizeof(line) - n, " %d", firstRow);
            }
            const bool seam = rows[0] > 0 && rows[6] > 0 && rows[0] != rows[6];
            if (seam && m_seamFrame == 0u)
            {
                m_seamFrame = m_frameCounter ? m_frameCounter : 1u;
                std::fprintf(stderr, "[gs-gl seam] first seen at frame=%llu (movie start frame=%llu): %s\n",
                             (unsigned long long)m_frameCounter, (unsigned long long)m_movieStartFrame, line);
            }
            if (dcPrint)
            {
                ++s_dcPrinted;
                std::fprintf(stderr, "%s\n", line);
            }
        }
    }
    uint8_t *vram = m_shadowMemory.data();
    const uint32_t clutWidth = (state.texclut.cbw != 0u) ? static_cast<uint32_t>(state.texclut.cbw) : 1u;
    const bool indexed = tex.psm == GS_PSM_T8 || tex.psm == GS_PSM_T8H || tex.psm == GS_PSM_T4 || tex.psm == GS_PSM_T4HL || tex.psm == GS_PSM_T4HH;

    // The on-chip CLUT (GSClutLoad): the palette snapshot the frontend took at the TEX0 write, addressed from
    // its block 0. Without it the decode read the slot's bytes at decode time -- SOCOM II's water palette slot
    // holds another texture's CT32 palette by then (research/31 section 9).
    const GSClutLoad *clutLoad = nullptr;
    if (indexed && state.context.clutId != 0u && tex.csm == 0u && state.texclut.cou == 0u && state.texclut.cov == 0u)
    {
        auto cl = m_cluts.find(state.context.clutId);
        if (cl != m_cluts.end())
            m_clutUse[cl->first] = m_clutLoadSeq;
        if (cl != m_cluts.end())
            clutLoad = &cl->second;
    }
    uint8_t *clutVram = clutLoad ? const_cast<uint8_t *>(clutLoad->bytes.data()) : vram;
    const uint32_t clutBp = clutLoad ? 0u : tex.cbp;
    const uint32_t clutBw = clutLoad ? 1u : clutWidth;
    const uint8_t clutPsm = clutLoad ? clutLoad->cpsm : tex.cpsm;

    // Decode the CLUT once (256 entries) for indexed formats.
    uint32_t clut[256];
    if (indexed)
    {
        for (uint32_t i = 0; i < 256u; ++i)
        {
            const uint32_t clutIndex = resolveClutIndex(static_cast<uint8_t>(i), clutPsm, tex.csm, tex.csa, tex.psm);
            const uint32_t clutX = static_cast<uint32_t>(state.texclut.cou) + (clutIndex & 0x0Fu);
            const uint32_t clutY = static_cast<uint32_t>(state.texclut.cov) + (clutIndex >> 4);
            uint32_t c = 0u;
            switch (clutPsm)
            {
            case GS_PSM_CT32: c = applyTexa(state.texa, GS_PSM_CT32, GSMem::ReadCT32(clutVram, clutBp, clutBw, clutX, clutY)); break;
            case GS_PSM_CT24: c = applyTexa(state.texa, GS_PSM_CT24, GSMem::ReadCT24(clutVram, clutBp, clutBw, clutX, clutY)); break;
            case GS_PSM_CT16: c = applyTexa(state.texa, GS_PSM_CT16, rgba5551To8888(GSMem::ReadCT16(clutVram, clutBp, clutBw, clutX, clutY))); break;
            case GS_PSM_CT16S: c = applyTexa(state.texa, GS_PSM_CT16S, rgba5551To8888(GSMem::ReadCT16S(clutVram, clutBp, clutBw, clutX, clutY))); break;
            default: c = 0xFFFF00FFu; break;
            }
            clut[i] = c;
        }
        // Diagnostic (with PS2X_GS_DUMP_TEX, after PS2X_GS_GL_DEBUG_AFTER presents, first 64
        // decodes): does the shadow VRAM's CLUT match the authoritative VRAM?
        static const bool s_clutDiag = ps2x::knob("PS2X_GS_DUMP_TEX") != nullptr;
        static const unsigned long long s_clutAfter = ps2x::knob("PS2X_GS_GL_DEBUG_AFTER") ? std::strtoull(ps2x::knob("PS2X_GS_GL_DEBUG_AFTER"), nullptr, 0) : 0ull;
        static uint32_t s_clutDiagCount = 0;
        if (s_clutDiag && m_frameCounter >= s_clutAfter && s_clutDiagCount++ < 64u)
        {
            uint32_t mismatches = 0u;
            for (uint32_t i = 0; i < 256u; ++i)
            {
                const uint32_t clutIndex = resolveClutIndex(static_cast<uint8_t>(i), tex.cpsm, tex.csm, tex.csa, tex.psm);
                const uint32_t clutX = static_cast<uint32_t>(state.texclut.cou) + (clutIndex & 0x0Fu);
                const uint32_t clutY = static_cast<uint32_t>(state.texclut.cov) + (clutIndex >> 4);
                const uint32_t shadowRaw = readVramRaw(vram, tex.cpsm, tex.cbp, clutWidth, clutX, clutY);
                const uint32_t cpuRaw = m_cpu->ReadVram(tex.cpsm, tex.cbp, clutWidth, clutX, clutY);
                if (shadowRaw != cpuRaw)
                    ++mismatches;
            }
            std::fprintf(stderr, "[gs-gl tex] tbp0=%05x psm=%02x cbp=%05x cpsm=%02x cbw=%u cou=%u cov=%u clut mismatches shadow vs cpu: %u; clut[0..3]=%08x %08x %08x %08x\n",
                         tex.tbp0, tex.psm, tex.cbp, tex.cpsm, clutWidth, state.texclut.cou, state.texclut.cov, mismatches, clut[0], clut[1], clut[2], clut[3]);
        }
    }

    // Row spans (GSMem::ReadSpan: the same per-pixel Read* inlined, no page arithmetic per pixel;
    // this loop was ~14% of the GL thread), conversion chosen once per texture.
    {
        std::vector<uint32_t> row(width);
        const bool spanOk = GSMem::ReadSpan(tex.psm, vram, tex.tbp0, tex.tbw, 0u, 0u, 0u, row.data());
        enum class Conv { Color32, Color16, Indexed, Missing } conv;
        switch (tex.psm)
        {
        case GS_PSM_CT32: case GS_PSM_CT24: case GS_PSM_Z32: case GS_PSM_Z24: conv = Conv::Color32; break;
        case GS_PSM_CT16: case GS_PSM_CT16S: case GS_PSM_Z16: case GS_PSM_Z16S: conv = Conv::Color16; break;
        default: conv = indexed ? Conv::Indexed : Conv::Missing; break;
        }
        for (uint32_t y = 0; y < height; ++y)
        {
            if (spanOk)
                GSMem::ReadSpan(tex.psm, vram, tex.tbp0, tex.tbw, 0u, y, width, row.data());
            else
                for (uint32_t x = 0; x < width; ++x)
                    row[x] = readVramRaw(vram, tex.psm, tex.tbp0, tex.tbw, x, y);
            uint32_t *dst = pixels.data() + static_cast<size_t>(y) * width;
            switch (conv)
            {
            case Conv::Color32:
                for (uint32_t x = 0; x < width; ++x)
                    dst[x] = applyTexa(state.texa, tex.psm, row[x]);
                break;
            case Conv::Color16:
                for (uint32_t x = 0; x < width; ++x)
                    dst[x] = applyTexa(state.texa, tex.psm, rgba5551To8888(row[x]));
                break;
            case Conv::Indexed:
                for (uint32_t x = 0; x < width; ++x)
                    dst[x] = clut[row[x] & 0xFFu];
                break;
            default:
                for (uint32_t x = 0; x < width; ++x)
                    dst[x] = 0xFFFF00FFu;
                break;
            }
        }
    }

    // PS2X_GS_DUMP_TEX=<dir>: write every decoded texture as a PPM (RGB) + PGM (alpha) for inspection.
    static const char *s_dumpDir = ps2x::knob("PS2X_GS_DUMP_TEX");
    // Gated by PS2X_GS_GL_DEBUG_AFTER (presents) and capped: ungated it wrote 136k files per boot.
    static const unsigned long long s_dumpAfter = ps2x::knob("PS2X_GS_GL_DEBUG_AFTER") ? std::strtoull(ps2x::knob("PS2X_GS_GL_DEBUG_AFTER"), nullptr, 0) : 0ull;
    static uint32_t s_dumpCount = 0;
    // PS2X_GS_DUMP_TEX_TBP0=<block>: only decodes of that texture; _EVERY=<n>: every n-th of them; _MAX=<n>: the cap
    // (default 6); _FROM=t<seconds>: a host-time arm like PS2X_GS_TRACE_CMDS (the frame arm above still applies).
    static const std::vector<long> s_dumpTbp0 = traceBlockList(ps2x::knob("PS2X_GS_DUMP_TEX_TBP0"));
    static const uint32_t s_dumpEvery = ps2x::knob("PS2X_GS_DUMP_TEX_EVERY") ? std::max<uint32_t>(1u, static_cast<uint32_t>(std::strtoul(ps2x::knob("PS2X_GS_DUMP_TEX_EVERY"), nullptr, 0))) : 1u;
    static const uint32_t s_dumpMax = ps2x::knob("PS2X_GS_DUMP_TEX_MAX") ? static_cast<uint32_t>(std::strtoul(ps2x::knob("PS2X_GS_DUMP_TEX_MAX"), nullptr, 0)) : 6u;
    static const bool s_dumpHasFrom = ps2x::knob("PS2X_GS_DUMP_TEX_FROM") != nullptr;
    static uint32_t s_dumpSeen = 0u;
    const bool dumpArmed = s_dumpDir && m_frameCounter >= s_dumpAfter &&
        (!s_dumpHasFrom || static_cast<long>(m_frameCounter) >= traceSkip("PS2X_GS_DUMP_TEX_FROM")) &&
        traceBlockMatch(s_dumpTbp0, tex.tbp0);
    if (dumpArmed && (s_dumpSeen++ % s_dumpEvery) == 0u && s_dumpCount++ < s_dumpMax)
    {
        static uint32_t s_dumpIndex = 0;
        char path[512];
        std::snprintf(path, sizeof(path), "%s/tex_%03u_f%llu_tbp%05x_psm%02x_%ux%u_cbp%05x_cpsm%02x.ppm", s_dumpDir, s_dumpIndex,
                      (unsigned long long)m_frameCounter, tex.tbp0, tex.psm, width, height, tex.cbp, tex.cpsm);
        if (FILE *fp = std::fopen(path, "wb"))
        {
            std::fprintf(fp, "P6\n%u %u\n255\n", width, height);
            for (uint32_t i = 0; i < width * height; ++i)
                std::fwrite(&pixels[i], 1, 3, fp);
            std::fclose(fp);
        }
        // The decoded CLUT beside it (indexed formats): 16x16 RGB + alpha, entry i at (i & 15, i >> 4), plus a note
        // of which palette snapshot (context.clutId) or live slot it came from.
        if (indexed)
        {
            std::snprintf(path, sizeof(path), "%s/tex_%03u_clut_id%llu.ppm", s_dumpDir, s_dumpIndex, (unsigned long long)state.context.clutId);
            if (FILE *fp = std::fopen(path, "wb"))
            {
                std::fprintf(fp, "P6\n16 16\n255\n");
                for (uint32_t i = 0; i < 256u; ++i)
                    std::fwrite(&clut[i], 1, 3, fp);
                std::fclose(fp);
            }
            std::snprintf(path, sizeof(path), "%s/tex_%03u_clut_alpha.pgm", s_dumpDir, s_dumpIndex);
            if (FILE *fp = std::fopen(path, "wb"))
            {
                std::fprintf(fp, "P5\n16 16\n255\n");
                for (uint32_t i = 0; i < 256u; ++i)
                {
                    const uint8_t a = static_cast<uint8_t>(clut[i] >> 24);
                    std::fwrite(&a, 1, 1, fp);
                }
                std::fclose(fp);
            }
        }
        std::snprintf(path, sizeof(path), "%s/tex_%03u_alpha.pgm", s_dumpDir, s_dumpIndex);
        if (FILE *fp = std::fopen(path, "wb"))
        {
            std::fprintf(fp, "P5\n%u %u\n255\n", width, height);
            for (uint32_t i = 0; i < width * height; ++i)
            {
                const uint8_t a = static_cast<uint8_t>(pixels[i] >> 24);
                std::fwrite(&a, 1, 1, fp);
            }
            std::fclose(fp);
        }
        ++s_dumpIndex;
    }

    GLuint texture = 0u;
    glGenTextures(1, &texture);
    glBindTexture(GL_TEXTURE_2D, texture);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, width, height, 0, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

    TextureEntry entry;
    entry.texture = texture;
    entry.width = width;
    entry.height = height;
    entry.pageStart = pageStart;
    entry.pageCount = pageCount;
    entry.generation = m_generation;
    entry.lastUse = m_frameCounter;
    // R123: what this decode read. The next time a generation bump brings the gate here, the same
    // walk over the shadow answers "did the CONTENT change?" instead of "did a stamp move?".
    entry.sourceHash = textureSourceHash(state, width, height);
    m_textures[key] = entry;
    return texture;
}

uint32_t GSGlBackend::resolveTexture(const GSDrawState &state, uint32_t &outWidth, uint32_t &outHeight)
{
    static const bool s_uploadTraceResolve = ps2x::knob("PS2X_GS_UPLOAD_TRACE") != nullptr;
    const GSTex0Reg &tex = state.context.tex0;
    const uint32_t width = std::min<uint32_t>(1024u, 1u << std::min<uint32_t>(tex.tw, 10u));
    const uint32_t height = std::min<uint32_t>(1024u, 1u << std::min<uint32_t>(tex.th, 10u));
    outWidth = width;
    outHeight = height;
    const uint32_t pageStart = tex.tbp0 >> 5;
    const uint32_t pageCount = pageSpan(tex.psm, tex.tbw, height);
    if (tracePagesHit(pageStart, pageCount))
        std::fprintf(stderr, "[gs-pages] frame=%llu texture tbp0=%05x tbw=%u psm=%02x %ux%u pages %03x+%u gpu-dirty=%d\n",
                     (unsigned long long)m_frameCounter, tex.tbp0, tex.tbw, tex.psm, width, height, pageStart, pageCount,
                     pagesMayBeGpuDirty(pageStart, pageCount) ? 1 : 0);

    // Render target sampled as a texture: when the texture is exactly a render target the GPU
    // drew into (same base, width and 32-bit format), sample the target's own colour texture
    // instead of reading the GPU pixels back into the shadow and decoding them (the readback was
    // ~26% of the GL thread). Pending shadow->GPU rectangles are applied first, so the GPU texture
    // holds everything the readback+decode would have produced. Restricted to texel-coordinate
    // draws with clamp/region-clamp wrapping (the shader normalizes by the target's size then),
    // never for the target being drawn into (feedback). PS2X_GS_RT_TEXTURE=0 restores the readback.
    static const bool s_rtTexture = ps2x::knob("PS2X_GS_RT_TEXTURE") == nullptr || std::atoi(ps2x::knob("PS2X_GS_RT_TEXTURE")) != 0;
    if (s_rtTexture && tex.psm == GS_PSM_CT32 && state.prim.fst)
    {
        const uint64_t clamp = state.context.clamp;
        const uint32_t wrapU = static_cast<uint32_t>(clamp & 3u), wrapV = static_cast<uint32_t>((clamp >> 2) & 3u);
        if (wrapU <= 2u && wrapV <= 2u)
        {
            for (RenderTarget &rt : m_renderTargets)
            {
                if (!rt.shadowStale || rt.psm != GS_PSM_CT32 || rt.fbp != pageStart || rt.fbw != tex.tbw || rt.color == 0u)
                    continue;
                if (rt.fbp == state.context.frame.fbp)
                    continue;
                if (width > rt.nativeWidth || height > rt.nativeHeight)
                    continue;
                refreshDirtyRows(rt);
                // The draw samples this target with the same native texel coordinates it would use
                // for a decoded texture, so it must be handed a native-sized view -- rt.color
                // itself at scale 1, the resolved mirror above it -- and uTexSize (outWidth /
                // outHeight) must match that view. Sampling a host-scale texture with native texel
                // coordinates is the third failure mode in research/14 section 8.1 item 5; going
                // through nativeView() settles the uTexSize half of that hand-off as *native*
                // whichever design S3-c picks for appendVertex/uRtSize.
                const uint32_t view = nativeView(rt);
                outWidth = rt.nativeWidth;
                outHeight = rt.nativeHeight;
                if (tracePagesHit(pageStart, pageCount))
                    std::fprintf(stderr, "[gs-pages] frame=%llu texture tbp0=%05x sampled from rt fbp=%03x (%ux%u) directly\n",
                                 (unsigned long long)m_frameCounter, tex.tbp0, rt.fbp, rt.nativeWidth, rt.nativeHeight);
                if (uploadGateOn())
                    m_uploadGate.noteTex(GsGlUploadReasons::Tex::RtDirect);
                return view;
            }
        }
    }

    // If the texture lives in pages a render target has drawn into, bring the shadow up to date.
    for (RenderTarget &rt : m_renderTargets)
    {
        if (!rt.shadowStale)
            continue;
        const uint32_t span = pageSpan(rt.psm, rt.fbw, std::min<uint32_t>(rt.usedHeight, 512u));
        if (pageStart + pageCount <= rt.fbp || pageStart >= rt.fbp + span)
            continue;
        downloadRenderTargetToShadow(rt);
        markShadowPages(rt.fbp, span);
    }

    TextureKey key;
    key.tbp0 = tex.tbp0;
    key.tbw = tex.tbw;
    key.psm = tex.psm;
    key.tw = width;
    key.th = height;
    key.cbp = tex.cbp;
    key.cpsm = tex.cpsm;
    key.csm = tex.csm;
    key.csa = tex.csa;
    key.texa = static_cast<uint32_t>(state.texa.ta0) | (static_cast<uint32_t>(state.texa.ta1) << 8) | (state.texa.aem ? 0x10000u : 0u);
    key.texclut = static_cast<uint32_t>(state.texclut.cbw) | (static_cast<uint32_t>(state.texclut.cou) << 8) | (static_cast<uint32_t>(state.texclut.cov) << 16);
    key.clutId = state.context.clutId;

    bool wasInvalidation = false;
    // Review 2026-09-19: a cached or revalidated texture never reaches decodeTexture, the only place that
    // stamped its palette snapshot as in use -- so a menu texture that stopped re-decoding (R123) let its
    // snapshot age out after 256 loads, and the next real decode read the live slot (research/31 section 9).
    const auto touchClutSnapshot = [&]() {
        if (state.context.clutId == 0u)
            return;
        auto use = m_clutUse.find(state.context.clutId);
        if (use != m_clutUse.end())
            use->second = m_clutLoadSeq;
    };
    auto it = m_textures.find(key);
    if (it != m_textures.end())
    {
        uint64_t newest = 0u;
        for (uint32_t p = it->second.pageStart; p < it->second.pageStart + it->second.pageCount && p < 512u; ++p)
            newest = std::max(newest, m_shadowPageGeneration[p]);
        // CLUT pages too -- unless the draw samples a palette snapshot (context.clutId): then the slot's later
        // rewrites are exactly what must NOT reach it.
        if (state.context.clutId == 0u &&
            (tex.psm == GS_PSM_T8 || tex.psm == GS_PSM_T8H || tex.psm == GS_PSM_T4 || tex.psm == GS_PSM_T4HL || tex.psm == GS_PSM_T4HH))
            newest = std::max(newest, m_shadowPageGeneration[std::min<uint32_t>(511u, tex.cbp >> 5)]);
        if (newest <= it->second.generation)
        {
            it->second.lastUse = m_frameCounter;
            touchClutSnapshot();
            if (uploadGateOn())
                m_uploadGate.noteTex(GsGlUploadReasons::Tex::Hit);
            return it->second.texture;
        }
        // Sprint 8 Goal 2b R123. This is the root Task 1 measured: markShadowPages (:1843-1848)
        // bumps m_generation on EVERY upload, identical bytes or not, so a menu that re-uploads its
        // atlas each frame lands here every frame and paid a full decode + glTexImage2D below --
        // 551-1385 of them a second against 26-52 cached textures. Before throwing the texture
        // away, ask whether the CONTENT actually changed. PS2X_GS_NO_TEX_REVALIDATE=1 restores the
        // old behaviour for the A/B and the bisect.
        static const bool s_noRevalidate = ps2x::knobOn("PS2X_GS_NO_TEX_REVALIDATE");
        if (!s_noRevalidate && it->second.sourceHash != GsGlTextureIdentity::kUnhashable)
        {
            const auto tRev0 = s_uploadTraceResolve ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
            const uint64_t now = textureSourceHash(state, width, height);
            if (now == it->second.sourceHash)
            {
                it->second.generation = m_generation;
                it->second.lastUse = m_frameCounter;
                touchClutSnapshot();
                if (s_uploadTraceResolve)
                    GsGlUploadTrace::noteRevalidate(g_uploadTrace,
                        std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - tRev0).count());
                if (uploadGateOn())
                    m_uploadGate.noteTex(GsGlUploadReasons::Tex::Revalidated);
                return it->second.texture;
            }
            // A miss falls through to the decode below, which dominates its own re-hash; only
            // successful revalidations are counted and timed.
        }
        wasInvalidation = true;
        glDeleteTextures(1, &it->second.texture);
        m_textures.erase(it);
    }

    // Evict stale entries occasionally.
    if (m_textures.size() > 512u)
    {
        for (auto e = m_textures.begin(); e != m_textures.end();)
        {
            if (e->second.lastUse + 120u < m_frameCounter)
            {
                glDeleteTextures(1, &e->second.texture);
                e = m_textures.erase(e);
            }
            else
                ++e;
        }
    }
    if (s_uploadTraceResolve)
        GsGlUploadTrace::noteDecode(g_uploadTrace, wasInvalidation);
    if (uploadGateOn())
        m_uploadGate.noteTex(wasInvalidation ? GsGlUploadReasons::Tex::Redecoded : GsGlUploadReasons::Tex::New);
    return decodeTexture(state, key, width, height, pageStart, pageCount);
}

// ---------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------
void GSGlBackend::appendVertex(const GSVertex &v, const GSDrawState &state, bool flatColorFromLast, const GSVertex &colorSource)
{
    const auto &ctx = state.context;
    GlVertex out{};
    // [* S site 2 -- vertex premultiply] AFTER the xyoffset subtraction: XYOFFSET is a native
    // 1/16-pixel origin, so the subtraction happens in native space and only the result is scaled.
    // This is the premultiply half of research/14 section 8.1 item 5; its pair is the uRtSize
    // uniform in setupDrawState, which must therefore be the HOST size. Changing one without the
    // other gives a frame shrunk into a 1/S corner or one scissored off the edge.
    const float scale = static_cast<float>(renderScale());
    out.x = (v.x - static_cast<float>(ctx.xyoffset.ofx >> 4)) * scale;
    out.y = (v.y - static_cast<float>(ctx.xyoffset.ofy >> 4)) * scale;
    // z / 2^32: exact in float32 for integer z < 2^24 (all of Z24/Z16/Z16S). The shader's depth
    // mapping (GsGlDepth::Mode) decides whether it stays exact through to the depth test.
    out.z = GsGlDepth::attribute(v.z);
    if (state.prim.fst)
    {
        out.s = static_cast<float>(v.u) / 16.0f;
        out.t = static_cast<float>(v.v) / 16.0f;
        out.q = 1.0f;
    }
    else
    {
        out.s = v.s * static_cast<float>(state.textureWidth);
        out.t = v.t * static_cast<float>(state.textureHeight);
        // Q of 0 means "no perspective" for 2D STQ sprites (the UI's text glyphs never set Q);
        // treat it as 1.0 like the CPU rasterizer, not as a near-zero divisor.
        out.q = std::fabs(v.q) < 1e-8f ? 1.0f : std::fabs(v.q);
    }
    const GSVertex &c = flatColorFromLast ? colorSource : v;
    out.r = c.r;
    out.g = c.g;
    out.b = c.b;
    out.a = c.a;
    out.fog = static_cast<float>(v.fog) / 255.0f;
    m_vertices.push_back(out);
}

void GSGlBackend::executeSubmit(const GSPrimitiveBatch &batch)
{
    const GSDrawState &state = batch.state;
    DrawKey key{};
    key.context = state.context;
    key.prim = state.prim;
    key.texa = state.texa;
    key.texclut = state.texclut;
    key.pabe = state.pabe;
    key.linearFilter = state.linearFilter;
    key.textureWidth = state.textureWidth;
    key.textureHeight = state.textureHeight;
    key.fogR = state.fogR;
    key.fogG = state.fogG;
    key.fogB = state.fogB;
    if (m_hasBatch && std::memcmp(&key, &m_batchKey, sizeof(DrawKey)) != 0)
        flushBatch();
    if (!m_hasBatch)
    {
        m_hasBatch = true;
        m_batchKey = key;
        m_batchState = state;
        m_vertices.clear();
    }

    const GSVertex *v = batch.vertices.data();
    switch (state.prim.type)
    {
    case GS_PRIM_SPRITE:
    {
        if (batch.vertexCount < 2)
            return;
        GSVertex a = v[0], b = v[1];
        // Corners: (a.x,a.y) (b.x,a.y) (a.x,b.y) (b.x,b.y) with matching texcoords; colour = b.
        GSVertex tl = a, tr = a, bl = a, br = b;
        tr.x = b.x; tr.u = b.u; tr.s = b.s;
        bl.y = b.y; bl.v = b.v; bl.t = b.t;
        tl.z = tr.z = bl.z = b.z;
        tr.q = bl.q = b.q; tl.q = b.q;
        appendVertex(tl, state, true, b);
        appendVertex(tr, state, true, b);
        appendVertex(bl, state, true, b);
        appendVertex(tr, state, true, b);
        appendVertex(br, state, true, b);
        appendVertex(bl, state, true, b);
        break;
    }
    case GS_PRIM_TRIANGLE:
    case GS_PRIM_TRISTRIP:
    case GS_PRIM_TRIFAN:
    {
        if (batch.vertexCount < 3)
            return;
        const bool flat = !state.prim.iip;
        appendVertex(v[0], state, flat, v[2]);
        appendVertex(v[1], state, flat, v[2]);
        appendVertex(v[2], state, flat, v[2]);
        break;
    }
    case GS_PRIM_POINT:
    {
        GSVertex a = v[0], b = v[0];
        b.x += 1.0f;
        b.y += 1.0f;
        GSVertex tr = a, bl = a;
        tr.x = b.x;
        bl.y = b.y;
        appendVertex(a, state, false, a);
        appendVertex(tr, state, false, a);
        appendVertex(bl, state, false, a);
        appendVertex(tr, state, false, a);
        appendVertex(b, state, false, a);
        appendVertex(bl, state, false, a);
        break;
    }
    case GS_PRIM_LINE:
    case GS_PRIM_LINESTRIP:
    {
        if (batch.vertexCount < 2)
            return;
        // 1-pixel wide quad along the line.
        const GSVertex &a = v[0];
        const GSVertex &b = v[1];
        float dx = b.x - a.x, dy = b.y - a.y;
        const float len = std::sqrt(dx * dx + dy * dy);
        if (len < 1e-3f)
            return;
        const float nx = -dy / len * 0.5f, ny = dx / len * 0.5f;
        GSVertex a0 = a, a1 = a, b0 = b, b1 = b;
        a0.x += nx; a0.y += ny; a1.x -= nx; a1.y -= ny;
        b0.x += nx; b0.y += ny; b1.x -= nx; b1.y -= ny;
        const bool flat = !state.prim.iip;
        appendVertex(a0, state, flat, b);
        appendVertex(b0, state, flat, b);
        appendVertex(a1, state, flat, b);
        appendVertex(b0, state, flat, b);
        appendVertex(b1, state, flat, b);
        appendVertex(a1, state, flat, b);
        break;
    }
    default:
        break;
    }
}

void GSGlBackend::setupDrawState(const GSDrawState &state)
{
    const auto &ctx = state.context;
    RenderTarget *rt = getRenderTarget(ctx.frame.fbp, ctx.frame.fbw, ctx.frame.psm, true,
                                      std::min<uint32_t>(kRtHeight, static_cast<uint32_t>(ctx.scissor.y1) + 1u));
    m_batchRt = rt;
    {
        // Sprint 8 Goal 2b Task 1: phase 1 of the flush the transfer interrupted.
        const auto tRows0 = g_flushPhasesArmed ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
        refreshDirtyRows(*rt);
        if (g_flushPhasesArmed)
            g_flushDirtyRowsUs += std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - tRows0).count();
    }
    glBindFramebuffer(GL_FRAMEBUFFER, rt->fbo);
    // Depth attachment keyed by ZBP.
    const bool zte = (ctx.test >> 16) & 1u;
    DepthTarget *dt = getDepthTarget(ctx.zbuf.zbp, rt->fbw, rt->hostWidth, rt->hostHeight);
    if (rt->attachedDepth != dt->texture)
    {
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_TEXTURE_2D, dt->texture, 0);
        rt->attachedDepth = dt->texture;
    }
    glViewport(0, 0, rt->hostWidth, rt->hostHeight);
    // The GS has no face culling. raylib's rlglInit enables GL_CULL_FACE for its own drawing
    // (and may re-enable it while drawing the debug UI), which silently dropped every sprite
    // whose second vertex lies above/left of the first — all of the UI's text glyphs.
    glDisable(GL_CULL_FACE);
    glEnable(GL_SCISSOR_TEST);
    // [* S site 4 -- draw scissor] as executeClear: native SCISSOR rect into a host viewport.
    {
        const int ds = static_cast<int>(renderScale());
        glScissor(static_cast<int>(ctx.scissor.x0) * ds, static_cast<int>(ctx.scissor.y0) * ds,
                  std::max<int>(0, ctx.scissor.x1 - ctx.scissor.x0 + 1) * ds,
                  std::max<int>(0, ctx.scissor.y1 - ctx.scissor.y0 + 1) * ds);
    }
    rt->usedHeight = std::max(rt->usedHeight, std::min<uint32_t>(kRtHeight, static_cast<uint32_t>(ctx.scissor.y1) + 1u));
    noteGpuRows(*rt, static_cast<uint32_t>(std::max<int>(0, ctx.scissor.y0)), std::min<uint32_t>(kRtHeight, static_cast<uint32_t>(ctx.scissor.y1) + 1u));
    rt->gpuDirty = true;
    rt->shadowStale = true;
    // NOT dirtySinceResolve: that is set in flushBatch at the glDrawArrays, not here. See the
    // comment there -- resolveTexture runs between this point and the draw and can clear it.

    {
        char tag[64];
        std::snprintf(tag, sizeof(tag), " T%05llx/M%08x/tfx%u%s", (unsigned long long)(ctx.test & 0x7FFFFu), ctx.frame.fbmsk,
                      ctx.tex0.tfx & 3u, state.prim.tme ? "t" : "");
        if (m_stateLog.find(tag) == std::string::npos && m_stateLog.size() < 600u)
            m_stateLog += tag;
    }
    // Depth test.
    uint32_t ztst = (ctx.test >> 17) & 3u;
    if (!zte)
        ztst = 1u;
    // PS2X_GS_NO_ZTEST=1: A/B switch — every draw passes the depth test.
    static const bool s_noZtest = ps2x::knobOn("PS2X_GS_NO_ZTEST");
    if (s_noZtest)
        ztst = 1u;
    glEnable(GL_DEPTH_TEST);
    switch (ztst)
    {
    case 0: glDepthFunc(GL_NEVER); break;
    case 1: glDepthFunc(GL_ALWAYS); break;
    case 2: glDepthFunc(GL_GEQUAL); break;
    default: glDepthFunc(GL_GREATER); break;
    }
    glDepthMask(ctx.zbuf.zmask ? GL_FALSE : GL_TRUE);

    // Colour mask from FBMSK (per-channel when whole bytes).
    const uint32_t mask = ctx.frame.fbmsk;
    glColorMask((mask & 0x000000FFu) != 0x000000FFu, (mask & 0x0000FF00u) != 0x0000FF00u,
                (mask & 0x00FF0000u) != 0x00FF0000u, (mask & 0xFF000000u) != 0xFF000000u);

    // Alpha blending: out = (A - B) * C + D
    int srcMode = 0;
    float srcConst = 0.0f;
    if (state.prim.abe)
    {
        const uint64_t alpha = ctx.alpha;
        const uint32_t asel = alpha & 3u, bsel = (alpha >> 2) & 3u, csel = (alpha >> 4) & 3u, dsel = (alpha >> 6) & 3u;
        {
            char tag[48];
            std::snprintf(tag, sizeof(tag), " A%uB%uC%uD%u/fix%02llx", asel, bsel, csel, dsel, (unsigned long long)((alpha >> 32) & 0xFFu));
            if (m_blendLog.find(tag) == std::string::npos && m_blendLog.size() < 400u)
                m_blendLog += tag;
        }
        const float fix = std::min(1.0f, static_cast<float>((alpha >> 32) & 0xFFu) / 128.0f);
        GLenum cFactor = GL_SRC1_ALPHA, cInv = GL_ONE_MINUS_SRC1_ALPHA;
        if (csel == 1u) { cFactor = GL_DST_ALPHA; cInv = GL_ONE_MINUS_DST_ALPHA; }
        else if (csel >= 2u) { cFactor = GL_CONSTANT_COLOR; cInv = GL_ONE_MINUS_CONSTANT_COLOR; glBlendColor(fix, fix, fix, fix); }
        GLenum eq = GL_FUNC_ADD, src = GL_ONE, dst = GL_ZERO;
        const uint32_t a = asel >= 2u ? 2u : asel, b = bsel >= 2u ? 2u : bsel, d = dsel >= 2u ? 2u : dsel;
        if (a == b)
        {
            src = (d == 0u) ? GL_ONE : GL_ZERO;
            dst = (d == 1u) ? GL_ONE : GL_ZERO;
        }
        else if (a == 0u && b == 1u)      // (Cs - Cd) * C + D
        {
            if (d == 1u) { src = cFactor; dst = cInv; }
            else if (d == 0u) { eq = GL_FUNC_SUBTRACT; src = GL_ONE; dst = cFactor; }   // approx (1+C)Cs - C Cd
            else { eq = GL_FUNC_SUBTRACT; src = cFactor; dst = cFactor; }
        }
        else if (a == 0u && b == 2u)      // Cs * C + D
        {
            src = cFactor;
            dst = (d == 1u) ? GL_ONE : GL_ZERO;
            if (d == 0u) src = GL_ONE;    // approx Cs(1+C)
        }
        else if (a == 1u && b == 0u)      // (Cd - Cs) * C + D
        {
            if (d == 0u) { src = cInv; dst = cFactor; }
            else if (d == 1u) { eq = GL_FUNC_REVERSE_SUBTRACT; src = cFactor; dst = GL_ONE; }
            else { eq = GL_FUNC_REVERSE_SUBTRACT; src = cFactor; dst = cFactor; }
        }
        else if (a == 1u && b == 2u)      // Cd * C + D
        {
            if (d == 0u) { src = GL_ONE; dst = cFactor; }
            else if (d == 1u)
            {
                // Cd*C + Cd = Cd*(1+C): GL has no destination factor above one, so the SOURCE term carries Cd*C --
                // the fragment shader emits C (uSrcMode) and the source factor is GL_DST_COLOR. SOCOM II's
                // post-process brightens every frame this way (ALPHA 0x5d00000069: FIX 93 -> x1.73, research/31
                // section 12); the former identity mapping left the whole scene dark. C = Ad keeps the identity
                // (Cd*Ad would need the destination alpha in the shader).
                if (csel >= 2u) { srcMode = 1; srcConst = static_cast<float>((alpha >> 32) & 0xFFu) / 128.0f; src = GL_DST_COLOR; dst = GL_ONE; }
                else if (csel == 0u) { srcMode = 2; src = GL_DST_COLOR; dst = GL_ONE; }
                else { src = GL_ZERO; dst = GL_ONE; }
            }
            else { src = GL_ZERO; dst = cFactor; }
        }
        else if (a == 2u && b == 0u)      // -Cs * C + D
        {
            if (d == 1u) { eq = GL_FUNC_REVERSE_SUBTRACT; src = cFactor; dst = GL_ONE; }
            else if (d == 0u) { src = cInv; dst = GL_ZERO; }
            else { src = GL_ZERO; dst = GL_ZERO; }
        }
        else                              // a == 2, b == 1: -Cd * C + D
        {
            if (d == 0u) { eq = GL_FUNC_SUBTRACT; src = GL_ONE; dst = cFactor; }
            else if (d == 1u) { src = GL_ZERO; dst = cInv; }
            else { src = GL_ZERO; dst = GL_ZERO; }
        }
        glEnable(GL_BLEND);
        glBlendEquationSeparate(eq, GL_FUNC_ADD);
        glBlendFuncSeparate(src, dst, GL_ONE, GL_ZERO);
    }
    else
    {
        glDisable(GL_BLEND);
    }

    glUseProgram(m_program);
    // HOST, and that is not a free choice: aPos arrives premultiplied by S from appendVertex, so
    // gl_Position = aPos / uRtSize * 2 - 1 needs the host extent (research/14 section 8.1 item 5).
    glUniform2f(m_u.rtSize, static_cast<float>(rt->hostWidth), static_cast<float>(rt->hostHeight));
    glUniform1i(m_u.tme, state.prim.tme ? 1 : 0);
    glUniform1i(m_u.fge, state.prim.fge ? 1 : 0);
    glUniform3f(m_u.fogColor, state.fogR / 255.0f, state.fogG / 255.0f, state.fogB / 255.0f);
    glUniform1i(m_u.fba, (ctx.fba & 1ull) != 0ull ? 1 : 0);
    glUniform1i(m_u.srcMode, srcMode);
    glUniform4f(m_u.srcConst, srcConst, srcConst, srcConst, 1.0f);
    const uint32_t test = static_cast<uint32_t>(ctx.test);
    glUniform1i(m_u.ate, test & 1u);
    glUniform1i(m_u.atst, (test >> 1) & 7u);
    glUniform1f(m_u.aref, static_cast<float>((test >> 4) & 0xFFu));
    glUniform1i(m_u.afail, (test >> 12) & 3u);

    if (state.prim.tme)
    {
        uint32_t tw = 1u, th = 1u;
        // Sprint 8 Goal 2b Task 1: phase 2 -- the cache gate at :3209-3222 and, on a miss, the whole
        // decodeTexture + glTexImage2D. (resolveTexture calls refreshDirtyRows of its own on the
        // RT-as-texture path; that time lands here rather than in dirty_rows, deliberately: it is
        // part of resolving the batch's texture.)
        const auto tTex0 = g_flushPhasesArmed ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
        const uint32_t texture = resolveTexture(state, tw, th);
        if (g_flushPhasesArmed)
            g_flushDecodeUs += std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - tTex0).count();
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, texture);
        const GLint filter = state.linearFilter ? GL_LINEAR : GL_NEAREST;
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, filter);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, filter);
        glUniform1i(m_u.tex, 0);
        glUniform2f(m_u.texSize, static_cast<float>(tw), static_cast<float>(th));
        glUniform1i(m_u.tfx, ctx.tex0.tfx & 3u);
        glUniform1i(m_u.tcc, ctx.tex0.tcc & 1u);
        glUniform1i(m_u.fst, state.prim.fst ? 1 : 0);
        const uint64_t clamp = ctx.clamp;
        glUniform1i(m_u.wrapU, static_cast<int>(clamp & 3u));
        glUniform1i(m_u.wrapV, static_cast<int>((clamp >> 2) & 3u));
        glUniform4f(m_u.region, static_cast<float>((clamp >> 4) & 0x3FFu), static_cast<float>((clamp >> 14) & 0x3FFu),
                    static_cast<float>((clamp >> 24) & 0x3FFu), static_cast<float>((clamp >> 34) & 0x3FFu));
    }
}

void GSGlBackend::flushBatch()
{
    if (!m_hasBatch)
        return;
    m_hasBatch = false;
    if (m_vertices.empty())
        return;
    // Sprint 8 Goal 2b Task 1: past both early returns, so this flush really drew. The two returns
    // above are the "empty" case the [gs-transfer] line counts as flush_empty.
    g_flushHadBatch = true;
    setupDrawState(m_batchState);
    // PS2X_GS_GL_DEBUG_PSM=<psm>: print the first batches drawn with that texture format (state,
    // bound texture, blend and the vertices actually submitted), to compare with the CPU path.
    static const int s_debugPsm = ps2x::knob("PS2X_GS_GL_DEBUG_PSM") ? std::atoi(ps2x::knob("PS2X_GS_GL_DEBUG_PSM")) : -1;
    static int s_debugCount = 0;
    // PS2X_GS_GL_DEBUG_AFTER=<presents>: only debug draws issued after that many presents.
    static const unsigned long long s_debugAfter = ps2x::knob("PS2X_GS_GL_DEBUG_AFTER") ? std::strtoull(ps2x::knob("PS2X_GS_GL_DEBUG_AFTER"), nullptr, 0) : 0ull;
    const bool debugWindow = m_frameCounter >= s_debugAfter;
    if (debugWindow && s_debugPsm >= 0 && m_batchState.prim.tme && static_cast<int>(m_batchState.context.tex0.psm) == s_debugPsm && s_debugCount++ < 12)
    {
        GLint tex = 0, prog = 0, blend = 0, srcRgb = 0, dstRgb = 0, eqRgb = 0, depthFn = 0, depthMask = 0;
        GLint scissor[4] = {0, 0, 0, 0};
        GLboolean colorMask[4] = {0, 0, 0, 0};
        glGetIntegerv(GL_TEXTURE_BINDING_2D, &tex);
        glGetIntegerv(GL_CURRENT_PROGRAM, &prog);
        glGetIntegerv(GL_BLEND, &blend);
        glGetIntegerv(GL_BLEND_SRC_RGB, &srcRgb);
        glGetIntegerv(GL_BLEND_DST_RGB, &dstRgb);
        glGetIntegerv(GL_BLEND_EQUATION_RGB, &eqRgb);
        glGetIntegerv(GL_DEPTH_FUNC, &depthFn);
        glGetIntegerv(GL_DEPTH_WRITEMASK, &depthMask);
        glGetIntegerv(GL_SCISSOR_BOX, scissor);
        glGetBooleanv(GL_COLOR_WRITEMASK, colorMask);
        const auto &c = m_batchState.context;
        std::fprintf(stderr, "[gs-gl dbg] psm=%02x tex=%d prog=%d blend=%d src=%#x dst=%#x eq=%#x depth=%#x zmask=%d scissor=%d,%d %dx%d cmask=%d%d%d%d tw=%u th=%u clamp=%#llx alpha=%#llx tfx=%u tcc=%u fst=%u verts=%zu\n",
                     c.tex0.psm, tex, prog, blend, srcRgb, dstRgb, eqRgb, depthFn, depthMask, scissor[0], scissor[1], scissor[2], scissor[3],
                     colorMask[0], colorMask[1], colorMask[2], colorMask[3], m_batchState.textureWidth, m_batchState.textureHeight,
                     (unsigned long long)c.clamp, (unsigned long long)c.alpha, c.tex0.tfx & 3u, c.tex0.tcc & 1u, m_batchState.prim.fst ? 1u : 0u, m_vertices.size());
        for (size_t i = 0; i < std::min<size_t>(6, m_vertices.size()); ++i)
        {
            const GlVertex &v = m_vertices[i];
            std::fprintf(stderr, "[gs-gl dbg]   v%zu pos=(%.1f,%.1f,%.6f) st=(%.2f,%.2f) q=%.3f rgba=%u,%u,%u,%u\n", i, v.x, v.y, v.z, v.s, v.t, v.q, v.r, v.g, v.b, v.a);
        }
    }
    const bool debugThis = debugWindow && s_debugPsm >= 0 && m_batchState.prim.tme && static_cast<int>(m_batchState.context.tex0.psm) == s_debugPsm && s_debugCount <= 12;
    float dbgCx = 0.0f, dbgCy = 0.0f;
    if (debugThis && m_vertices.size() >= 6)
    {
        dbgCx = (m_vertices[0].x + m_vertices[4].x) * 0.5f;
        dbgCy = (m_vertices[0].y + m_vertices[4].y) * 0.5f;
        uint8_t before[4] = {0, 0, 0, 0};
        glReadPixels(static_cast<int>(dbgCx), static_cast<int>(dbgCy), 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, before);
        std::memcpy(m_dbgBefore, before, 4);
        float storedDepth = -2.0f;
        glReadPixels(static_cast<int>(dbgCx), static_cast<int>(dbgCy), 1, 1, GL_DEPTH_COMPONENT, GL_FLOAT, &storedDepth);
        std::fprintf(stderr, "[gs-gl dbg]   pixel(%d,%d) before=%u,%u,%u,%u storedDepth=%.7f vertexDepth(ndc->[0,1])=%.7f\n", static_cast<int>(dbgCx), static_cast<int>(dbgCy),
                     before[0], before[1], before[2], before[3], storedDepth, m_vertices[0].z);
        // Two more probes above the quad (letterbox band) to tell a failed clear from a stray draw.
        uint8_t pa[4] = {0, 0, 0, 0}, pb[4] = {0, 0, 0, 0};
        glReadPixels(100, 50, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, pa);
        glReadPixels(500, 50, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, pb);
        std::fprintf(stderr, "[gs-gl dbg]   band before: (100,50)=%u,%u,%u,%u (500,50)=%u,%u,%u,%u target fbp=%03x fbo=%u tex tbp0=%05x tbw=%u\n",
                     pa[0], pa[1], pa[2], pa[3], pb[0], pb[1], pb[2], pb[3],
                     m_batchRt ? m_batchRt->fbp : 0u, m_batchRt ? m_batchRt->fbo : 0u, m_batchState.context.tex0.tbp0, m_batchState.context.tex0.tbw);
        // What does the bound texture hold at the sampled texel?
        GLint tw = 0, th = 0;
        glGetTexLevelParameteriv(GL_TEXTURE_2D, 0, GL_TEXTURE_WIDTH, &tw);
        glGetTexLevelParameteriv(GL_TEXTURE_2D, 0, GL_TEXTURE_HEIGHT, &th);
        if (tw > 0 && th > 0)
        {
            std::vector<uint8_t> img(static_cast<size_t>(tw) * th * 4);
            glGetTexImage(GL_TEXTURE_2D, 0, GL_RGBA, GL_UNSIGNED_BYTE, img.data());
            const int sx = std::clamp(static_cast<int>((m_vertices[0].s + m_vertices[4].s) * 0.5f), 0, tw - 1);
            const int sy = std::clamp(static_cast<int>((m_vertices[0].t + m_vertices[4].t) * 0.5f), 0, th - 1);
            size_t opaque = 0;
            for (size_t i = 3; i < img.size(); i += 4)
                opaque += img[i] > 0 ? 1 : 0;
            const uint8_t *px = &img[(static_cast<size_t>(sy) * tw + sx) * 4];
            std::fprintf(stderr, "[gs-gl dbg]   bound tex %dx%d texel(%d,%d)=%u,%u,%u,%u nonzero-alpha texels=%zu\n", tw, th, sx, sy, px[0], px[1], px[2], px[3], opaque);
        }
    }
    if (m_batchRt)
    {
        glBindFramebuffer(GL_FRAMEBUFFER, m_batchRt->fbo);   // the texture path may have rebound another target
        // The draw below is the write; the native mirror is stale from here (see nativeView).
        // This has to be marked at the draw and not up in setupDrawState beside gpuDirty, because
        // resolveTexture runs in between and can clear the flag on this very target: its
        // RT-as-texture fast path deliberately skips the target being drawn into (the feedback
        // case), which routes that target into the shadow-download loop below it, and
        // downloadRenderTargetToShadow -> nativeViewFbo resolves the *pre-draw* contents and marks
        // the mirror clean. The batch would then draw into a mirror nothing re-resolves until the
        // next setup/clear/upload on the target, and every read in that window (executeReadback,
        // another batch sampling it, the display dump) would be short one whole batch.
        m_batchRt->dirtySinceResolve = true;
        scaleNoteHostWrite(m_batchRt->fbp);
    }
    glBindVertexArray(m_vao);
    glBindBuffer(GL_ARRAY_BUFFER, m_vbo);
    glBufferData(GL_ARRAY_BUFFER, static_cast<GLsizeiptr>(m_vertices.size() * sizeof(GlVertex)), m_vertices.data(), GL_STREAM_DRAW);
    glDrawArrays(GL_TRIANGLES, 0, static_cast<GLsizei>(m_vertices.size()));
    if (debugThis && m_vertices.size() >= 6)
    {
        // Read back the whole quad region and count pixels the draw changed.
        const int x0 = static_cast<int>(std::min(m_vertices[0].x, m_vertices[4].x)), x1 = static_cast<int>(std::max(m_vertices[0].x, m_vertices[4].x));
        const int y0 = static_cast<int>(std::min(m_vertices[0].y, m_vertices[4].y)), y1 = static_cast<int>(std::max(m_vertices[0].y, m_vertices[4].y));
        const int w = std::max(1, x1 - x0), h = std::max(1, y1 - y0);
        std::vector<uint8_t> after(static_cast<size_t>(w) * h * 4);
        glReadPixels(x0, y0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, after.data());
        size_t changed = 0;
        uint8_t brightest[4] = {0, 0, 0, 0};
        for (size_t i = 0; i < after.size(); i += 4)
        {
            if (after[i] != m_dbgBefore[0] || after[i + 1] != m_dbgBefore[1] || after[i + 2] != m_dbgBefore[2])
            {
                ++changed;
                if (after[i] > brightest[0])
                    std::memcpy(brightest, &after[i], 4);
            }
        }
        GLint fbo = 0;
        glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &fbo);
        std::fprintf(stderr, "[gs-gl dbg]   quad %dx%d at (%d,%d): %zu of %d pixels changed, brightest=%u,%u,%u,%u fbo=%d glerr=%#x\n",
                     w, h, x0, y0, changed, w * h, brightest[0], brightest[1], brightest[2], brightest[3], fbo, glGetError());
    }
    m_vertices.clear();
}
