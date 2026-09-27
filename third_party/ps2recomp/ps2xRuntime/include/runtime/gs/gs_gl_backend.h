#pragma once

#include "runtime/gs/gs_backend.h"
#include "runtime/gs/gs_gl_upload_identity.h"
#include "runtime/gs/gs_gl_upload_reasons.h"
#include "runtime/gs/gs_cpu_backend.h"
#include "runtime/gs/gs_frame_backpressure.h"
#include "runtime/gs/gs_stall_coalescer.h"
#include "runtime/gs/gs_gl_caps.h"

#include <array>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

// OpenGL 3.3 GS backend (design: docs/superpowers/plans/2026-09-05-gpu-gs-backend.md).
//
// The game thread records a command stream (draws, transfers, presents); the main thread — which
// owns raylib's GL context — replays it before each host frame. Two GSCpuBackend instances model
// VRAM: `m_cpu` (authoritative, game thread: uploads applied immediately, reads served from it)
// and `m_shadow` (render thread, fed by the replayed transfers; source for texture decoding).
// Drawing goes to per-framebuffer render targets; pages an RT has drawn into are "GPU-dirty" and
// are downloaded into the CPU VRAM only when the guest reads them.
class GSGlBackend final : public GSRasterBackend
{
public:
    GSGlBackend();
    ~GSGlBackend() override;

    void Initialize(uint8_t *vram, uint32_t vramSize) override;
    void Reset() override;

    void Submit(const GSPrimitiveBatch &batch) override;
    void BeginTransfer(const GSTransferCommand &command) override;
    void UploadImage(const uint8_t *data, uint32_t sizeBytes) override;
    void LoadClut(const GSClutLoad &load) override;

    void Flush() override;
    void TextureFlush() override;
    void Sync(GSSyncReason reason) override;
    PresentationFrame Present(const GSPresentationRequest &request) override;

    bool ClearFramebuffer(const GSContext &context, uint32_t rgba) override;
    uint32_t ConsumeLocalToHostBytes(uint8_t *dst, uint32_t maxBytes) override;

    uint32_t ReadVram(uint32_t psm, uint32_t base, uint32_t bw, uint32_t x, uint32_t y) const override;
    uint32_t PeekVram(uint32_t psm, uint32_t base, uint32_t bw, uint32_t x, uint32_t y) const override;
    void RequestVramReadback() override;
    void WriteVram(uint32_t psm, uint32_t base, uint32_t bw, uint32_t x, uint32_t y, uint32_t value) override;
    void SnapshotVram(std::vector<uint8_t> &out) const override;
    GSTransferSnapshot GetTransferSnapshot() const override;

    // Main thread: replay recorded commands. Returns true when a presentable texture exists.
    bool HostDriven() const override { return true; }
    bool HostRenderFrame() override;
    // EE executor: bound the frames recorded but not yet replayed (PS2X_GS_MAX_PENDING_FRAMES).
    bool GuestFrameBoundary() override;
    void ReleaseHostBackpressure() override;
    // #67: suspends the frame back-pressure (GsFrameBackpressure::setConsumerSuspended) and the token waits.
    void SetHostMoveLoop(bool inLoop) override;
    uint64_t PendingGuestFrames() const override { return m_backpressure.pendingFrames(); }
    uint32_t BackpressureWaiters() const override { return m_backpressure.waiters(); }
    uint64_t BackpressureWaitNs() const override { return m_backpressure.waitNsTotal(); }
    uint32_t HostFrameTexture(uint32_t &width, uint32_t &height, uint32_t &textureWidth, uint32_t &textureHeight) override;
    uint32_t HostFrameTexture2() override { return m_presentTexture2; }

    // Task 1a: what the capability probe decided. Written once on the render thread by ensureGl()
    // and read there; the static pair mirrors it for the runtime's present loop, which holds a
    // GSRasterBackend pointer and cannot see this class.
    bool glUnavailable() const { return m_glCapsLatch.failed(); }
    std::string glMissing() const { return m_glCapsLatch.report().missing; }
    static bool glUnavailableForProcess();
    static std::string glMissingForProcess();

private:
    enum class CmdType : uint8_t
    {
        Submit,
        BeginTransfer,
        Upload,
        WriteVram,
        Clear,
        Present,
        Readback,
        Reset,
        ClutLoad,
    };

    struct Cmd
    {
        CmdType type = CmdType::Submit;
        GSPrimitiveBatch batch{};
        GSTransferCommand transfer{};
        GSPresentationRequest present{};
        GSContext context{};
        uint32_t args[5] = {0, 0, 0, 0, 0};
        size_t dataOffset = 0;
        size_t dataSize = 0;
        uint64_t token = 0;
    };

    struct CommandBuffer
    {
        std::vector<Cmd> commands;
        std::vector<uint8_t> data;
        void clear()
        {
            commands.clear();
            data.clear();
        }
    };

public:
    // What one command record costs the pending queue before its data (the tests bound a stall's
    // working set in these; the [gs-gl] banner prints it).
    static constexpr size_t kCommandBytes = sizeof(Cmd);

private:

    struct RenderTarget
    {
        uint32_t fbp = 0;   // pages
        uint32_t fbw = 0;   // 64-pixel units
        uint32_t psm = 0;
        // The target's extent in NATIVE GS pixels. This is VRAM addressing, not rasterisation:
        // page/row bookkeeping, the FBW*64 page-row clamps, usedHeight and the DISPLAY rectangle
        // are all expressed in these units and never scale (research/14 section 3).
        uint32_t nativeWidth = 0;
        uint32_t nativeHeight = 0;
        // The extent of the GL colour texture in texels == native * renderScale() (S3-c: read
        // once from PS2X_GS_SCALE, clamped 1..4, default 1). Everything that names a GL object --
        // the glTexImage2D allocation, glViewport, glScissor, glReadPixels rects, uRtSize, and the
        // strides of the pixel buffers those readbacks fill -- uses these. (uTexSize is the one
        // exception: an RT sampled as a texture goes through nativeView(), so it is native.)
        uint32_t hostWidth = 0;
        uint32_t hostHeight = 0;
        uint32_t usedHeight = 32;
        uint32_t fbo = 0;
        uint32_t color = 0;
        // S3-b native view. At scale 1 (hostWidth == nativeWidth) these stay 0 forever: nativeView()
        // hands back `color` itself, so a 1x run allocates no mirror and copies nothing. Above 1x
        // they are a nativeWidth x nativeHeight RGBA8 texture plus the FBO it is attached to, and
        // every guest-observable read (the two downloads, the RT-as-texture sample, the display
        // dump) resolves the host-scale colour texture into them first. Allocated once per target
        // -- the native extent is kMaxRtWidth x kRtHeight and never changes -- and freed with the
        // target's own fbo/color.
        uint32_t mirrorTexture = 0;
        uint32_t mirrorFbo = 0;
        // The colour texture was written (draw, clear, or a shadow->GPU row refresh) since the
        // mirror was last resolved, so the next nativeView() must re-resolve. Starts true: a fresh
        // target is cleared on allocation.
        bool dirtySinceResolve = true;
        uint32_t attachedDepth = 0;
        bool gpuDirty = false;
        bool shadowStale = false;   // shadow VRAM does not hold the GPU contents
        bool dirtyRows = false;     // some 32-row band must be re-read from the shadow (see dirtyMask)
        uint32_t dirtyRowFirst = 0; // bounding range of the dirty bands (diagnostics)
        uint32_t dirtyRowLast = 0;
        uint32_t dirtyMask = 0;     // bit i = rows [32i, 32i+32) were written by an upload since the last refresh
                                    // (a single merged [first,last) range let a mark at the top of the
                                    // target and one far below it re-read everything in between)
        struct DirtyRect { uint32_t x0, y0, x1, y1; };
        std::vector<DirtyRect> dirtyRects;   // exact rectangles (uploads in the target's own layout):
                                             // re-read only these pixels — a band re-read dragged the
                                             // stale rows next to a 16-row movie block back over the
                                             // GPU's newer contents
        bool gpuRows = false;       // rows [gpuRowFirst, gpuRowLast) drawn by the GPU since the last download
        uint32_t gpuRowFirst = 0;
        uint32_t gpuRowLast = 0;
    };

    struct DepthTarget
    {
        uint32_t zbp = 0;
        uint32_t fbw = 0;
        uint32_t texture = 0;
        uint32_t width = 0;
        uint32_t height = 0;
    };

    struct TextureKey
    {
        uint32_t tbp0 = 0, tbw = 0, psm = 0, tw = 0, th = 0;
        uint32_t cbp = 0, cpsm = 0, csm = 0, csa = 0;
        uint32_t texa = 0, texclut = 0;
        uint64_t clutId = 0;
        bool operator==(const TextureKey &o) const
        {
            return tbp0 == o.tbp0 && tbw == o.tbw && psm == o.psm && tw == o.tw && th == o.th && cbp == o.cbp &&
                   cpsm == o.cpsm && csm == o.csm && csa == o.csa && texa == o.texa && texclut == o.texclut &&
                   clutId == o.clutId;
        }
    };
    struct TextureKeyHash
    {
        size_t operator()(const TextureKey &k) const
        {
            size_t h = k.tbp0 * 0x9E3779B1u;
            h ^= (k.tbw + k.psm * 64u + k.tw * 4096u + k.th * 65536u) * 0x85EBCA6Bu;
            h ^= (k.cbp + k.cpsm * 16384u + k.csa * 262144u + k.csm * 524288u) * 0xC2B2AE35u;
            h ^= k.texa * 0x27D4EB2Fu ^ k.texclut * 0x165667B1u;
            h ^= static_cast<size_t>(k.clutId * 0x9E3779B97F4A7C15ull);
            return h;
        }
    };

    struct TextureEntry
    {
        uint32_t texture = 0;
        uint32_t width = 0;
        uint32_t height = 0;
        uint32_t pageStart = 0;
        uint32_t pageCount = 0;
        uint64_t generation = 0;
        uint64_t lastUse = 0;
        uint64_t sourceHash = 0;   // R123: the shadow bytes this entry was decoded from
    };

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

    uint8_t m_dbgBefore[4] = {0, 0, 0, 0};   // PS2X_GS_GL_DEBUG_PSM readback
    struct GlVertex
    {
        float x, y, z;
        float s, t, q;
        uint8_t r, g, b, a;
        float fog;
    };

    // game-thread side
    void record(Cmd &&cmd, const uint8_t *data = nullptr, size_t size = 0);
    uint64_t postAndGetToken(Cmd &&cmd, const uint8_t *data = nullptr, size_t size = 0);
    // Q6 (gs_stall_coalescer.h). All three run on the game thread with m_queueMutex held: a
    // state-carrying command the cap refused goes to absorbLocked; reanchorLocked pushes the plan
    // when GsPendingCap::reanchorDue says the latch has cleared; pushLocked is the queue append.
    void absorbLocked(const Cmd &cmd, const uint8_t *data, size_t size);
    void reanchorLocked();
    void pushLocked(Cmd &&cmd, const uint8_t *data, size_t size);
    void waitForToken(uint64_t token);
    void syncDirtyPagesForRead(uint32_t page, uint32_t pageCount) const;
    bool pagesMayBeGpuDirty(uint32_t page, uint32_t pageCount) const;
    void markRtDirtyFromFrame(const GSContext &context);

    // render-thread side
    void executeCommands(CommandBuffer &buffer);
    void executeSubmit(const GSPrimitiveBatch &batch);
    void executeTransfer(const GSTransferCommand &command);
    void executeUpload(const uint8_t *data, size_t size);
    void executeClear(const GSContext &context, uint32_t rgba);
    void executePresent(const GSPresentationRequest &request);
    void executeReadback();
    void flushBatch();
    bool ensureGl();
    // Task 1a: latch the verdict, publish it to the process, and print the one UNSUPPORTED line.
    void latchGlUnsupported(const GsGlCaps::Report &report);
    // usedHeight (Sprint 7 Task 1c) is the native row count the caller knows this target is
    // using -- the scissor's last row + 1 for a draw or a clear. 0 means "not known", which
    // keeps the old full 1024x1024 allocation. See gs_gl_target_extent.h.
    RenderTarget *getRenderTarget(uint32_t fbp, uint32_t fbw, uint32_t psm, bool create, uint32_t usedHeight = 0u);
    // Grow a target's native extent in place, never shrink it (Sprint 7 Task 1c).
    void growRenderTarget(RenderTarget &rt, uint32_t nativeWidth, uint32_t nativeHeight);
    DepthTarget *getDepthTarget(uint32_t zbp, uint32_t fbw, uint32_t width, uint32_t height);
    uint32_t resolveTexture(const GSDrawState &state, uint32_t &outWidth, uint32_t &outHeight);
    uint32_t decodeTexture(const GSDrawState &state, const TextureKey &key, uint32_t width, uint32_t height, uint32_t pageStart, uint32_t pageCount);
    // A GL texture holding the target's contents at its NATIVE GS extent, for anything the guest
    // can observe. Returns rt.color unchanged (no copy, no allocation) while host == native;
    // otherwise resolves host -> mirror when the target has been drawn since the last resolve and
    // returns the mirror. nativeViewFbo() is the same thing for readers that need a framebuffer to
    // glReadPixels from. (uint32_t, not GLuint: this header does not pull in glad; they are the
    // same type, and every other GL name in the class is uint32_t for the same reason.)
    uint32_t nativeView(RenderTarget &rt);
    uint32_t nativeViewFbo(RenderTarget &rt);
    void resolveToMirror(RenderTarget &rt);
    bool ensureResolveProgram();
    void downloadRenderTargetToShadow(RenderTarget &rt);
    void downloadRenderTargetToCpu(RenderTarget &rt);
    void refreshRenderTargetsFromShadow(uint32_t page, uint32_t pageCount, const GSTransferCommand &transfer);
    void refreshDirtyRows(RenderTarget &rt);
    void noteGpuRows(RenderTarget &rt, uint32_t y0, uint32_t y1);
    void markShadowPages(uint32_t page, uint32_t pageCount);
    // Sprint 13 V2 (#32): a render target has GPU-drawn rows since its last download over pages
    // [pageLo, pageHi) -- the upload gate's same_gpu refusal.
    bool uploadUnderGpuRows(uint32_t pageLo, uint32_t pageHi) const;
    // Sprint 8 Goal 2b R123: the hash of the source bytes a decode of this texture would read now.
    uint64_t textureSourceHash(const GSDrawState &state, uint32_t width, uint32_t height);
    void setupDrawState(const GSDrawState &state);
    void appendVertex(const GSVertex &v, const GSDrawState &state, bool flatColorFromLast, const GSVertex &colorSource);

    static uint32_t pageSpan(uint32_t psm, uint32_t bufferWidth64, uint32_t heightPixels);
    static uint32_t pageHeightForPsm(uint32_t psm);

    std::unique_ptr<GSCpuBackend> m_cpu;
    std::unique_ptr<GSCpuBackend> m_shadow;
    std::vector<uint8_t> m_shadowMemory;
    uint8_t *m_vram = nullptr;
    uint32_t m_vramSize = 0;

    // command stream
    mutable std::mutex m_queueMutex;
    std::condition_variable m_queueCv;
    CommandBuffer m_pending;
    CommandBuffer m_executing;
    uint64_t m_nextToken = 1;
    std::atomic<uint64_t> m_executedToken{0};
    std::atomic<bool> m_glReady{false};
    // Task 1a: one probe, one attempt. A failure is final, so ensureGl() stops recompiling the
    // shaders on every host frame of a machine that cannot run them.
    GsGlCaps::Latch m_glCapsLatch;
    std::thread::id m_renderThread{};
    // Frames recorded (EE executor, GuestFrameBoundary) vs replayed (the swaps above): ruling R35.
    GsFrameBackpressure m_backpressure;
    // Sprint 7 Task 1b: the same queue bounded in BYTES while the consumer is latched stalled, so
    // a title-bar drag cannot grow m_pending without end (PS2X_GS_PENDING_CAP_MB, default 64 MB).
    GsPendingCap m_pendingCap;
    // Sprint 10 Goal 11 (Q6): the state-carrying stream during that stall, absorbed into the game
    // thread's VRAM and re-anchored when the latch clears (gs_stall_coalescer.h). Game thread only,
    // under m_queueMutex; its counters are atomic for the stats line.
    GsStallCoalescer m_coalescer;
    // The last BeginTransfer the game thread issued, admitted or absorbed: an absorbed Upload
    // chunk belongs to it, and the re-anchor restores the shadow's transfer state from it.
    GSTransferCommand m_gameTransfer{};
    // Scratch for the re-anchor (a VRAM snapshot and one packed rectangle); kept so a stall that
    // clears and re-latches does not reallocate 4 MB each time.
    std::vector<uint8_t> m_reanchorVram;
    std::vector<uint8_t> m_reanchorData;

    // GPU-dirty page tracking (written on the game thread from draw submissions)
    mutable std::mutex m_dirtyMutex;
    std::array<uint8_t, 512> m_gpuDirtyPages{};

    // render thread state
    std::vector<RenderTarget> m_renderTargets;
    std::vector<DepthTarget> m_depthTargets;
    std::unordered_map<TextureKey, TextureEntry, TextureKeyHash> m_textures;
    std::unordered_map<uint64_t, GSClutLoad> m_cluts;   // palette snapshots by id (render thread only)
    std::unordered_map<uint64_t, uint64_t> m_clutUse;   // id -> m_clutLoadSeq at its last load or lookup (eviction)
    uint64_t m_clutLoadSeq = 0u;
    std::array<uint64_t, 512> m_shadowPageGeneration{};
    uint64_t m_generation = 1;
    uint64_t m_frameCounter = 0;
    uint64_t m_movieStartFrame = 0;   // first 16x16 movie block upload seen (trace windows are relative to it)
    uint64_t m_seamFrame = 0;         // first decode where page columns 0 and 6 of the movie frame start on different rows
    long traceSkip(const char *env) const;

    uint32_t m_program = 0;
    uint32_t m_vao = 0;
    uint32_t m_vbo = 0;
    // PS2X_GS_SCALE_FILTER=box only: fullscreen-triangle box-average resolve (host -> native
    // mirror). Compiled lazily on the first box resolve, so `point` (the default) and every scale-1
    // run never create it. m_resolveVao is a dedicated empty VAO -- the shader reads gl_VertexID
    // and no attributes, and binding m_vao here would source 3 vertices out of m_vbo.
    uint32_t m_resolveProgram = 0;
    uint32_t m_resolveVao = 0;
    bool m_resolveProgramFailed = false;
    int m_resolveUSrc = -1;
    int m_resolveUScaleX = -1;
    int m_resolveUScaleY = -1;
    struct Uniforms
    {
        int srcMode = -1, srcConst = -1;   // blend modes whose source term must carry Cd*C (see executeSubmit)
        int rtSize = -1, tex = -1, texSize = -1, tme = -1, tfx = -1, tcc = -1, fst = -1, wrapU = -1, wrapV = -1;
        int region = -1, ate = -1, atst = -1, afail = -1, aref = -1, fge = -1, fogColor = -1, fba = -1;
    } m_u;

    std::vector<GlVertex> m_vertices;
    bool m_hasBatch = false;
    DrawKey m_batchKey{};
    GSDrawState m_batchState{};
    RenderTarget *m_batchRt = nullptr;

    // presentation
    uint32_t m_presentTexture = 0;
    // S3-c settles research/14 section 8.1 item 2 by renaming rather than by an in-place * S.
    // m_presentHost* is the displayed rectangle in HOST texels (= native * renderScale()) and is
    // what every GL consumer wants: the present-copy glBlitFramebuffer rects, the trace probes'
    // glReadPixels, and the srcRect handed to HostFrameTexture beside the host-sized
    // m_presentTexWidth/Height. m_presentNative* is the same rectangle in native GS pixels and has
    // exactly one consumer: the PS2X_FRAME_DUMP capture, which reads nativeViewFbo() into the
    // fixed 640x512 kHostFrame buffer the parity harness and the CPU backend both speak.
    uint32_t m_presentHostWidth = 0;
    uint32_t m_presentHostHeight = 0;
    uint32_t m_presentNativeWidth = 0;
    uint32_t m_presentNativeHeight = 0;
    uint32_t m_presentFbp = 0;
    uint32_t m_presentCopyTexture = 0;
    uint32_t m_presentCopyFbo = 0;
    uint32_t m_presentTexWidth = 0;
    uint32_t m_presentTexHeight = 0;
    uint32_t m_presentTexture2 = 0;          // second read circuit (PMODE EN1 && EN2), alpha = weight
    uint32_t m_presentCopyTexture2 = 0;
    uint32_t m_presentCopyFbo2 = 0;
    std::vector<uint8_t> m_presentPixels;   // filled only when a frame dump is requested
    bool m_presentPixelsRequested = false;

    // The transfer whose image data executeUpload is taking. RENDER THREAD ONLY: written by
    // executeTransfer, read by executeUpload, both on the render thread. The game thread must not
    // write it -- it queues ahead of the render thread, so a game-thread write makes executeUpload
    // mark the wrong rectangle dirty and the block never reaches the GL texture (research/16
    // section 9).
    GSTransferCommand m_currentTransfer{};
    // Sprint 8 Goal 2b Task 1's identical= counter: the last packet written to each destination
    // rectangle. Diagnostic only, filled only with PS2X_GS_UPLOAD_TRACE set. Render thread only.
    GsGlUploadIdentity::LastUploads m_uploadIdentity;
    // Sprint 13 V2 (#32): the per-reason upload and texture counters of the [gs-gl stats] reasons
    // line, and the skip of an upload whose bytes are already everywhere (PS2X_GS_UPLOAD_SKIP=1).
    // Fed only with PS2X_GS_STATS or the skip knob set. Render thread only.
    GsGlUploadReasons::Gate m_uploadGate;
    std::vector<uint32_t> m_uploadBlocks;
    std::string m_blendLog;
    std::string m_stateLog;
    uint64_t m_uploadExpectedBytes = 0;
    uint64_t m_uploadReceivedBytes = 0;
};
