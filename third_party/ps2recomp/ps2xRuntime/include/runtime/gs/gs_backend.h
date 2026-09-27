#pragma once

#include "runtime/gs/gs_types.h"

#include <cstdint>
#include <vector>

class GSRasterBackend
{
public:
    virtual ~GSRasterBackend() = default;

    virtual void Initialize(uint8_t *vram, uint32_t vramSize) = 0;
    virtual void Reset() = 0;

    virtual void Submit(const GSPrimitiveBatch &batch) = 0;

    virtual void BeginTransfer(const GSTransferCommand &command) = 0;
    virtual void UploadImage(const uint8_t *data, uint32_t sizeBytes) = 0;
    // A palette snapshot the frontend took at a TEX0/TEX2 write with CLD != 0 (GSClutLoad); draws whose
    // context.clutId names it decode through the snapshot rather than live VRAM.
    virtual void LoadClut(const GSClutLoad &load) { (void)load; }

    virtual void Flush() = 0;
    virtual void TextureFlush() = 0;
    virtual void Sync(GSSyncReason reason) = 0;
    virtual PresentationFrame Present(const GSPresentationRequest &request) = 0;

    virtual bool ClearFramebuffer(const GSContext &context, uint32_t rgba) = 0;
    virtual uint32_t ConsumeLocalToHostBytes(uint8_t *dst, uint32_t maxBytes) = 0;

    virtual uint32_t ReadVram(uint32_t psm, uint32_t base, uint32_t bw, uint32_t x, uint32_t y) const = 0;
    // ReadVram without bringing GPU-drawn pages up to date first: whatever the last sync left in CPU memory.
    virtual uint32_t PeekVram(uint32_t psm, uint32_t base, uint32_t bw, uint32_t x, uint32_t y) const { return ReadVram(psm, base, bw, x, y); }
    // Ask for GPU-drawn pages to be downloaded into CPU memory in stream order, without waiting: a later
    // PeekVram sees them once the render thread gets there. No-op for a CPU backend (its memory is current).
    virtual void RequestVramReadback() {}
    virtual void WriteVram(uint32_t psm, uint32_t base, uint32_t bw, uint32_t x, uint32_t y, uint32_t value) = 0;
    virtual void SnapshotVram(std::vector<uint8_t> &out) const = 0;
    virtual GSTransferSnapshot GetTransferSnapshot() const = 0;

    // Optional host-side hooks (GPU backends). Called on the thread that owns the GL context.
    // HostRenderFrame replays pending work; HostFrameTexture returns a GL texture id for the
    // last presented frame (0 = none, use the CPU pixel path).
    virtual bool HostDriven() const { return false; }
    // Recorder-side hooks (GPU backends). GuestFrameBoundary runs on the thread that records the
    // command stream (the EE executor), once per guest VBlankStart; a backend may block there,
    // capped, until its replay is within a bound (GsFrameBackpressure, ruling R35). Returns true when
    // it actually waited (the scheduler then re-anchors the VBlank deadline, ruling R41).
    // ReleaseHostBackpressure (any thread, at shutdown) wakes that wait and disables it.
    virtual bool GuestFrameBoundary() { return false; }
    virtual void ReleaseHostBackpressure() {}
    // Issue #67: the main (replaying) thread entered (true) or left (false) the host window's modal move loop -- a
    // title-bar drag or an edge resize -- during which it cannot replay. A GPU backend stops holding the recorder on
    // it until the loop ends; the CPU rasterizer has nothing to release.
    virtual void SetHostMoveLoop(bool inLoop) { (void)inLoop; }
    // What that back-pressure is doing right now, for the pc-sampler (research/29 section 4 item 6). A backend
    // without one (the CPU rasterizer) reports nothing pending and nobody waiting.
    virtual uint64_t PendingGuestFrames() const { return 0ull; }
    virtual uint32_t BackpressureWaiters() const { return 0u; }
    virtual uint64_t BackpressureWaitNs() const { return 0ull; }
    virtual bool HostRenderFrame() { return false; }
    // width/height = the presented rectangle (rows/cols actually displayed); textureWidth/Height =
    // the GL texture's full size (the presented rectangle is its top-left corner).
    virtual uint32_t HostFrameTexture(uint32_t &width, uint32_t &height, uint32_t &textureWidth, uint32_t &textureHeight)
    {
        width = height = textureWidth = textureHeight = 0u;
        return 0u;
    }
    // PMODE with both read circuits enabled (EN1 && EN2, different frame buffers): the second
    // circuit's frame, same size/rectangle as HostFrameTexture's, with its alpha channel set to
    // the circuit's weight in the merge (1 - ALP when MMOD=1). Draw it alpha-blended over the
    // first. 0 = single circuit.
    virtual uint32_t HostFrameTexture2() { return 0u; }
};
