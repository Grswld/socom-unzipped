#pragma once

// Sprint 8 Goal 2 Task 1: what a texture upload actually costs, per call.
//
// The [gs-gl stats] line says the menus spend 80-133 ms/s in `upload=` against gameplay's 20-28
// (KNOWN section 1, the 2026-09-18 re-measure), and that 100% of the traced uploads are 16x16
// PSMCT32 tiles of exactly 1024 bytes. What it does NOT say is which term of the tile path that
// time is: the shadow swizzle, the page/rect marking, the record under the queue mutex, the CPU
// convert in refreshDirtyRows, or glTexSubImage2D itself. Those live in three different functions
// and only the first two are inside the `upload=` bucket at all (gs_gl_backend.cpp:1577-1581 times
// executeUpload; the two glTexSubImage2D sites are in refreshDirtyRows and are charged to clear=,
// submit= and present=). This accumulator straddles them and prints one line.
//
// Header-only and free of GL includes on purpose, so ps2xTest can check the arithmetic without a
// context -- the same reason gs_gl_target_extent.h is.

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace GsGlUploadTrace
{
    constexpr int kBuckets = 8;
    // 1024 bytes is a 16x16 PSMCT32 tile: the entire menu upload population, per the [gs-pages]
    // trace. Each later bucket is a doubling, so a full 8 KB page and a 64 KB movie strip are
    // visibly separate columns rather than one "everything else".
    constexpr const char *kBucketLabels[kBuckets] = {"1k", "2k", "4k", "8k", "16k", "32k", "64k", "big"};

    inline int bucketFor(size_t bytes)
    {
        if (bytes <= 1024u)
            return 0;
        int b = 0;
        size_t limit = 1024u;
        while (b < kBuckets - 1 && bytes > limit)
        {
            limit <<= 1;
            ++b;
        }
        return b;
    }

    struct Accum
    {
        uint64_t sizes[kBuckets] = {0, 0, 0, 0, 0, 0, 0, 0};
        uint64_t uploads = 0;        // CmdType::Upload commands replayed
        uint64_t rectsMarked = 0;    // exact rectangles pushed onto rt.dirtyRects
        uint64_t glCalls = 0;        // glTexSubImage2D calls made by refreshDirtyRows
        double shadowUs = 0.0;       // (a) m_shadow->UploadImage: the CPU swizzle into shadow VRAM
        double markUs = 0.0;         // (a) markShadowPages + refreshRenderTargetsFromShadow
        double recordUs = 0.0;       // (c) GSGlBackend::record, game thread, under m_queueMutex
        double convertUs = 0.0;      // (a) the readVramRaw + convert + replicate loops feeding a GL upload
        double glUs = 0.0;           // (b) glTexSubImage2D itself
        // Distinct destination texture objects touched in the interval. Bounded: a menu screen has
        // a handful of render targets, and an unbounded set would be the trace's own hot spot.
        std::vector<uint32_t> dstTextures;

        // --- Sprint 8 Goal 2b Task 1: the transfer= column, split ---
        // transfer= is NOT what executeTransfer does. executeCommands takes its per-command clock at
        // gs_gl_backend.cpp:1402, BEFORE the dispatch switch, and the CmdType::BeginTransfer case at
        // :1535-1538 is two statements -- flushBatch() and then executeTransfer(). Both land in the
        // bucket. executeTransfer's own body moves no pixels for a host->local transfer, which is
        // what a menu upload is (gs_cpu_backend.cpp:1441-1456), so the milliseconds are the draw
        // batch the transfer interrupted: flushBatch (:3572) -> setupDrawState (:3389) ->
        // refreshDirtyRows (:3393) and resolveTexture (:3125).
        uint64_t transfers = 0;             // CmdType::BeginTransfer commands replayed
        uint64_t transfersByDir[4] = {0, 0, 0, 0};   // 0 host->local, 1 local->host, 2 local->local, 3 other
        double flushUs = 0.0;               // the flushBatch() half of the transfer= bucket
        double transferBodyUs = 0.0;        // the executeTransfer() half
        double dirtyRowsUs = 0.0;           // refreshDirtyRows, inside the flush
        double decodeUs = 0.0;              // resolveTexture + decodeTexture, inside the flush
        double drawUs = 0.0;                // everything left in setupDrawState + the draw call
        uint64_t flushesEmpty = 0;          // flushBatch had nothing to draw
        uint64_t flushesReal = 0;           // ... and how many actually drew
        uint64_t decodes = 0;               // decodeTexture calls (:3105-3122)
        uint64_t cacheInvalidations = 0;    // ... of which threw away a live cache entry (:3209-3222)
        uint64_t uploadsWhole = 0;          // R119's population split: the whole transfer in one call
        uint64_t uploadsChunked = 0;        // ... against one chunk of several
        uint64_t uploadsIdentical = 0;      // the same bytes as the last upload to that rectangle
        // R123: a cached texture whose generation moved but whose source bytes did not, handed
        // back instead of deleted and re-decoded, and what the re-hash cost.
        uint64_t revalidated = 0;
        double revalidateUs = 0.0;

        // --- Sprint 16 F2: the submit= bucket split for EVERY flushBatch, and the read-back inside it ---
        // The [gs-transfer] phases above are armed only around the flush a BeginTransfer interrupts
        // (gs_gl_backend.cpp, the CmdType::BeginTransfer case); the mission's flushes come from
        // executeSubmit and no line split them (research/73 section 1). These count every flush that
        // drew, whatever command flushed it, and they count the GPU->shadow read-back
        // (downloadRenderTargetToShadow) as WORK -- calls, rows written, pixels fetched -- as well as
        // time, so a test can read the work without the trace knob: the read-back and rt_direct
        // counts are kept unconditionally, only the microseconds need PS2X_GS_UPLOAD_TRACE.
        uint64_t submitFlushes = 0;         // flushBatch calls past both early returns (they drew)
        double submitSetupUs = 0.0;         // setupDrawState minus its refreshDirtyRows and resolveTexture halves
        double submitRowsUs = 0.0;          // refreshDirtyRows inside setupDrawState
        double submitResolveUs = 0.0;       // resolveTexture (the read-backs below are inside it)
        double submitDrawUs = 0.0;          // glBufferData + glDrawArrays after setupDrawState
        uint64_t readbacks = 0;             // downloadRenderTargetToShadow calls
        uint64_t readbackRows = 0;          // rows of the GPU-drawn window written into the shadow
        uint64_t readbackPixels = 0;        // pixels glReadPixels fetched (the driver's copy)
        double readbackUs = 0.0;            // the whole call
        uint64_t rtDirect = 0;              // resolveTexture served the target's own texture: no read-back, no decode
    };

    inline void noteDst(Accum &a, uint32_t texture)
    {
        if (a.dstTextures.size() >= 256u)
            return;
        const auto it = std::lower_bound(a.dstTextures.begin(), a.dstTextures.end(), texture);
        if (it == a.dstTextures.end() || *it != texture)
            a.dstTextures.insert(it, texture);
    }

    inline void noteUpload(Accum &a, size_t bytes, double shadowUs, double markUs)
    {
        ++a.uploads;
        ++a.sizes[bucketFor(bytes)];
        a.shadowUs += shadowUs;
        a.markUs += markUs;
    }

    inline void noteRecord(Accum &a, double us) { a.recordUs += us; }

    inline void noteRect(Accum &a) { ++a.rectsMarked; }

    inline void noteGlUpload(Accum &a, uint32_t texture, double convertUs, double glUs)
    {
        ++a.glCalls;
        a.convertUs += convertUs;
        a.glUs += glUs;
        noteDst(a, texture);
    }

    inline void noteTransfer(Accum &a, uint32_t direction, double flushUs, double bodyUs)
    {
        ++a.transfers;
        ++a.transfersByDir[direction < 3u ? direction : 3u];
        a.flushUs += flushUs;
        a.transferBodyUs += bodyUs;
    }

    inline void noteFlushPhases(Accum &a, double dirtyRowsUs, double decodeUs, double drawUs, bool empty)
    {
        if (empty)
        {
            ++a.flushesEmpty;
            return;
        }
        ++a.flushesReal;
        a.dirtyRowsUs += dirtyRowsUs;
        a.decodeUs += decodeUs;
        a.drawUs += drawUs;
    }

    inline void noteDecode(Accum &a, bool wasInvalidation)
    {
        ++a.decodes;
        if (wasInvalidation)
            ++a.cacheInvalidations;
    }

    inline void noteUploadShape(Accum &a, bool whole, bool identical)
    {
        if (whole)
            ++a.uploadsWhole;
        else
            ++a.uploadsChunked;
        if (identical)
            ++a.uploadsIdentical;
    }

    inline void noteRevalidate(Accum &a, double us)
    {
        ++a.revalidated;
        a.revalidateUs += us;
    }

    // Sprint 16 F2: one flush that drew, split. setupUs is setupDrawState's remainder after its
    // two timed halves; rowsUs and resolveUs are those halves; drawUs is the buffer upload + draw.
    inline void noteSubmitFlush(Accum &a, double setupUs, double rowsUs, double resolveUs, double drawUs)
    {
        ++a.submitFlushes;
        a.submitSetupUs += setupUs > 0.0 ? setupUs : 0.0;
        a.submitRowsUs += rowsUs;
        a.submitResolveUs += resolveUs;
        a.submitDrawUs += drawUs;
    }

    // One GPU->shadow read-back: the rows it wrote (the GPU-drawn window), the pixels the driver
    // copied (the whole target), and its microseconds (0 when the trace knob is off).
    inline void noteReadback(Accum &a, uint32_t rows, uint64_t pixels, double us)
    {
        ++a.readbacks;
        a.readbackRows += rows;
        a.readbackPixels += pixels;
        a.readbackUs += us;
    }

    inline void noteRtDirect(Accum &a) { ++a.rtDirect; }

    inline void reset(Accum &a) { a = Accum{}; }

    // Sprint 17 F: the replay bench's total over a whole recording. The stats cadence resets the live accumulator
    // every 60 command buffers once its lines are printed; the bench adds each interval into its own total first.
    inline void accumulate(Accum &into, const Accum &a)
    {
        for (int b = 0; b < kBuckets; ++b)
            into.sizes[b] += a.sizes[b];
        into.uploads += a.uploads;
        into.rectsMarked += a.rectsMarked;
        into.glCalls += a.glCalls;
        into.shadowUs += a.shadowUs;
        into.markUs += a.markUs;
        into.recordUs += a.recordUs;
        into.convertUs += a.convertUs;
        into.glUs += a.glUs;
        for (uint32_t t : a.dstTextures)
            noteDst(into, t);
        into.transfers += a.transfers;
        for (int d = 0; d < 4; ++d)
            into.transfersByDir[d] += a.transfersByDir[d];
        into.flushUs += a.flushUs;
        into.transferBodyUs += a.transferBodyUs;
        into.dirtyRowsUs += a.dirtyRowsUs;
        into.decodeUs += a.decodeUs;
        into.drawUs += a.drawUs;
        into.flushesEmpty += a.flushesEmpty;
        into.flushesReal += a.flushesReal;
        into.decodes += a.decodes;
        into.cacheInvalidations += a.cacheInvalidations;
        into.uploadsWhole += a.uploadsWhole;
        into.uploadsChunked += a.uploadsChunked;
        into.uploadsIdentical += a.uploadsIdentical;
        into.revalidated += a.revalidated;
        into.revalidateUs += a.revalidateUs;
        into.submitFlushes += a.submitFlushes;
        into.submitSetupUs += a.submitSetupUs;
        into.submitRowsUs += a.submitRowsUs;
        into.submitResolveUs += a.submitResolveUs;
        into.submitDrawUs += a.submitDrawUs;
        into.readbacks += a.readbacks;
        into.readbackRows += a.readbackRows;
        into.readbackPixels += a.readbackPixels;
        into.readbackUs += a.readbackUs;
        into.rtDirect += a.rtDirect;
    }

    // The render thread's live accumulator (defined in gs_gl_backend.cpp). For ps2x_tests, which
    // replay on the calling thread and read the work counts after hostRenderFrame; never written
    // through, never read from another thread.
    const Accum &live();

    // One line: every count per second, every per-call figure in microseconds to one decimal.
    inline std::string format(const Accum &a, double elapsedMs)
    {
        const double perSec = elapsedMs > 0.0 ? 1000.0 / elapsedMs : 0.0;
        auto per = [](double total, uint64_t n) { return n ? total / static_cast<double>(n) : 0.0; };
        char buf[640];
        int n = std::snprintf(buf, sizeof(buf),
                              "[gs-upload] elapsed=%.0fms uploads=%.0f/s rects=%.0f/s gl_calls=%.0f/s sizes:",
                              elapsedMs, static_cast<double>(a.uploads) * perSec,
                              static_cast<double>(a.rectsMarked) * perSec,
                              static_cast<double>(a.glCalls) * perSec);
        for (int b = 0; b < kBuckets && n < 480; ++b)
            if (a.sizes[b])
                n += std::snprintf(buf + n, sizeof(buf) - n, " %s=%llu", kBucketLabels[b], (unsigned long long)a.sizes[b]);
        std::snprintf(buf + n, sizeof(buf) - n,
                      " us/upload: shadow=%.1f mark=%.1f record=%.1f us/gl_call: convert=%.1f gl=%.1f dst_textures=%zu"
                      " revalidated=%.0f/s revalidate_us=%.1f",
                      per(a.shadowUs, a.uploads), per(a.markUs, a.uploads), per(a.recordUs, a.uploads),
                      per(a.convertUs, a.glCalls), per(a.glUs, a.glCalls), a.dstTextures.size(),
                      static_cast<double>(a.revalidated) * perSec, per(a.revalidateUs, a.revalidated));
        return std::string(buf);
    }

    // The second line, tagged [gs-transfer]: the transfer= column split by phase and by direction,
    // the texture-cache churn the generation bump causes, and the upload population's shape. Kept
    // apart from format() above so the [gs-upload] line's shape -- parsed by eye and by grep in a
    // dozen places (R107) -- does not change. Phase terms are MILLISECONDS PER SECOND, the unit the
    // [gs-gl stats] transfer= column is already read in; counts are per second or raw totals.
    inline std::string formatTransfer(const Accum &a, double elapsedMs)
    {
        const double perSec = elapsedMs > 0.0 ? 1000.0 / elapsedMs : 0.0;
        auto ms = [&](double us) { return us * perSec / 1000.0; };
        char buf[768];
        int n = std::snprintf(buf, sizeof(buf),
                              "[gs-transfer] elapsed=%.0fms transfers=%.0f/s dir0=%llu dir1=%llu dir2=%llu dir3=%llu"
                              " flush=%.1fms/s body=%.1fms/s dirty_rows=%.1fms/s decode=%.1fms/s draw=%.1fms/s"
                              " flush_empty=%llu flush_real=%llu decodes=%.0f/s invalidations=%.0f/s",
                              elapsedMs, static_cast<double>(a.transfers) * perSec,
                              (unsigned long long)a.transfersByDir[0], (unsigned long long)a.transfersByDir[1],
                              (unsigned long long)a.transfersByDir[2], (unsigned long long)a.transfersByDir[3],
                              ms(a.flushUs), ms(a.transferBodyUs), ms(a.dirtyRowsUs), ms(a.decodeUs), ms(a.drawUs),
                              (unsigned long long)a.flushesEmpty, (unsigned long long)a.flushesReal,
                              static_cast<double>(a.decodes) * perSec,
                              static_cast<double>(a.cacheInvalidations) * perSec);
        if (n < 0 || n >= static_cast<int>(sizeof(buf)))
            n = static_cast<int>(sizeof(buf)) - 1;
        std::snprintf(buf + n, sizeof(buf) - static_cast<size_t>(n),
                      " whole=%llu chunked=%llu identical=%llu",
                      (unsigned long long)a.uploadsWhole, (unsigned long long)a.uploadsChunked,
                      (unsigned long long)a.uploadsIdentical);
        return std::string(buf);
    }

    // Sprint 16 F2, the third line, tagged [gs-submit]: the submit= column of [gs-gl stats] split
    // by phase over EVERY flush that drew (the [gs-transfer] phases cover only the flush a transfer
    // interrupted), and the GPU->shadow read-back inside resolveTexture counted as work. Phase
    // terms are milliseconds per second like [gs-transfer]'s; readbacks=, readback_rows=,
    // readback_px= and rt_direct= are per second. A new line, so neither older line's shape moves.
    inline std::string formatSubmit(const Accum &a, double elapsedMs)
    {
        const double perSec = elapsedMs > 0.0 ? 1000.0 / elapsedMs : 0.0;
        auto ms = [&](double us) { return us * perSec / 1000.0; };
        char buf[512];
        std::snprintf(buf, sizeof(buf),
                      "[gs-submit] elapsed=%.0fms flushes=%.0f/s setup=%.1fms/s dirty_rows=%.1fms/s resolve=%.1fms/s"
                      " draw=%.1fms/s readback=%.1fms/s readbacks=%.1f/s readback_rows=%.0f/s readback_px=%.0f/s"
                      " rt_direct=%.1f/s",
                      elapsedMs, static_cast<double>(a.submitFlushes) * perSec,
                      ms(a.submitSetupUs), ms(a.submitRowsUs), ms(a.submitResolveUs), ms(a.submitDrawUs),
                      ms(a.readbackUs), static_cast<double>(a.readbacks) * perSec,
                      static_cast<double>(a.readbackRows) * perSec, static_cast<double>(a.readbackPixels) * perSec,
                      static_cast<double>(a.rtDirect) * perSec);
        return std::string(buf);
    }
}
