// The flush-reason counter and the frame-drop breakdown (macOS performance work, step 1): which DrawKey
// field ended each draw batch, how many vertices those batches carried, how many distinct pipeline states a
// session meets (a Metal pipeline-cache sizing input), frame-time percentiles, and the slow-frame records the
// render thread hands to a logger thread through a ring that never blocks it.
#include "MiniTest.h"

#include "runtime/gs/gs_gl_flush_reasons.h"
#include "runtime/gs/gs_gl_frame_stats.h"

#include <cstring>
#include <string>
#include <vector>

using namespace GsGlFlushReasons;
using namespace GsGlFrameStats;

namespace
{
    DrawKey baseKey()
    {
        DrawKey k{};
        k.context.frame.fbp = 0x100;
        k.context.frame.psm = 0;
        k.prim.type = GS_PRIM_TRIANGLE;
        k.textureWidth = 256;
        k.textureHeight = 256;
        return k;
    }

    FrameCounts countsWith(uint32_t draws)
    {
        FrameCounts c{};
        c.draws = draws;
        return c;
    }
}

void register_gs_gl_flush_reasons_tests()
{
    MiniTest::Case("GsGlFlushReasons", [](TestCase &tc)
    {
        tc.Run("keys built alike differ in no value (their padding may still differ: kPadding at most)", [](TestCase &t)
        {
            // DrawKey k{} -- executeSubmit's own construction -- does not zero padding (default member
            // initialisers make it aggregate initialisation), so two such keys may differ byte-wise.
            const DrawKey a = baseKey(), b = baseKey();
            t.Equals(diff(a, b) & ~kPadding, 0u, "no value field");
            t.Equals(diff(a, a), 0u, "and a key against itself, nothing at all");
        });

        tc.Run("each field alone names its own bit", [](TestCase &t)
        {
            struct Case { const char *label; void (*edit)(DrawKey &); uint32_t bit; };
            const Case cases[] = {
                {"frame", [](DrawKey &k) { k.context.frame.fbp = 0x200; }, kFrame},
                {"scissor", [](DrawKey &k) { k.context.scissor.x1 = 639; }, kScissor},
                {"tex0", [](DrawKey &k) { k.context.tex0.tbp0 = 0x3000; }, kTex0},
                {"xyoffset", [](DrawKey &k) { k.context.xyoffset.ofx = 0x8000; }, kXyOffset},
                {"zbuf", [](DrawKey &k) { k.context.zbuf.zmask = true; }, kZbuf},
                {"tex1", [](DrawKey &k) { k.context.tex1 = 1; }, kTex1},
                {"mip", [](DrawKey &k) { k.context.miptbp2 = 5; }, kMip},
                {"clamp", [](DrawKey &k) { k.context.clamp = 2; }, kClamp},
                {"alpha", [](DrawKey &k) { k.context.alpha = 0x44; }, kAlpha},
                {"test", [](DrawKey &k) { k.context.test = 0x80; }, kTest},
                {"fba", [](DrawKey &k) { k.context.fba = 1; }, kFba},
                {"clut", [](DrawKey &k) { k.context.clutId = 7; }, kClutId},
                {"prim", [](DrawKey &k) { k.prim.abe = true; }, kPrim},
                {"texa", [](DrawKey &k) { k.texa.ta1 = 0x80; }, kTexa},
                {"texclut", [](DrawKey &k) { k.texclut.cbw = 4; }, kTexClut},
                {"pabe", [](DrawKey &k) { k.pabe = true; }, kPabe},
                {"filter", [](DrawKey &k) { k.linearFilter = true; }, kFilter},
                {"texsize", [](DrawKey &k) { k.textureHeight = 128; }, kTexSize},
                {"fog", [](DrawKey &k) { k.fogG = 9; }, kFog},
            };
            for (const Case &c : cases)
            {
                DrawKey b = baseKey();
                c.edit(b);
                t.Equals(diff(baseKey(), b), c.bit, std::string(c.label) + " alone");
                t.Equals(std::string(fieldLabel(c.bit)), std::string(c.label), std::string(c.label) + "'s label");
            }
        });

        tc.Run("keys equal in value but not in padding bytes: no field, and the padding bit says so", [](TestCase &t)
        {
            // Register structs carry padding (GSFrameReg is 16 bytes for 4 fields) that a value-initialised key
            // does not zero; executeSubmit compares whole keys with memcmp, so such a pair ends a batch for
            // nothing. diff() compares values and names that case kPadding.
            alignas(DrawKey) unsigned char ra[sizeof(DrawKey)], rb[sizeof(DrawKey)];
            std::memset(ra, 0xAA, sizeof ra);
            std::memset(rb, 0x55, sizeof rb);
            DrawKey &a = *reinterpret_cast<DrawKey *>(ra);
            DrawKey &b = *reinterpret_cast<DrawKey *>(rb);
            const DrawKey v = baseKey();
            a.context.frame = GSFrameReg{}; b.context.frame = GSFrameReg{};
            a.context.frame.fbp = b.context.frame.fbp = v.context.frame.fbp;
            a.context.scissor = b.context.scissor = v.context.scissor;
            a.context.tex0 = GSTex0Reg{}; b.context.tex0 = GSTex0Reg{};
            a.context.xyoffset = b.context.xyoffset = v.context.xyoffset;
            a.context.zbuf = GSZbufReg{}; b.context.zbuf = GSZbufReg{};
            a.context.tex1 = b.context.tex1 = 0; a.context.miptbp1 = b.context.miptbp1 = 0;
            a.context.miptbp2 = b.context.miptbp2 = 0; a.context.clamp = b.context.clamp = 0;
            a.context.alpha = b.context.alpha = 0; a.context.test = b.context.test = 0;
            a.context.fba = b.context.fba = 0; a.context.clutId = b.context.clutId = 0;
            a.prim = GSPrimReg{}; b.prim = GSPrimReg{};
            a.prim.type = b.prim.type = GS_PRIM_TRIANGLE;
            a.texa = GSTexaReg{}; b.texa = GSTexaReg{};
            a.texclut = GSTexClutReg{}; b.texclut = GSTexClutReg{};
            a.pabe = b.pabe = false; a.linearFilter = b.linearFilter = false;
            a.textureWidth = b.textureWidth = 256; a.textureHeight = b.textureHeight = 256;
            a.fogR = b.fogR = 0; a.fogG = b.fogG = 0; a.fogB = b.fogB = 0;
            t.IsTrue(std::memcmp(&a, &b, sizeof(DrawKey)) != 0, "the bytes differ (the padding)");
            t.Equals(diff(a, b), kPadding, "but no value does: kPadding alone");
            t.Equals(std::string(fieldLabel(kPadding)), std::string("padding"), "labelled padding");
        });

        tc.Run("several fields at once set every one of their bits", [](TestCase &t)
        {
            DrawKey b = baseKey();
            b.context.tex0.tbp0 = 0x3000;
            b.context.clutId = 3;
            b.context.alpha = 0x48;
            t.Equals(diff(baseKey(), b), kTex0 | kClutId | kAlpha, "tex0 + clut + alpha");
        });

        tc.Run("the counter sums flushes and vertices per field and per combination, and ranks combinations", [](TestCase &t)
        {
            Counter c;
            c.noteKeyFlush(kXyOffset, 6);
            c.noteKeyFlush(kXyOffset, 4);
            c.noteKeyFlush(kTex0 | kAlpha, 30);
            c.noteCmdFlush(Cmd::Upload, 12);
            t.Equals(c.batches, 4ull, "four batches ended");
            t.Equals(c.vertices, 52ull, "52 vertices in them");
            t.Equals(c.byField[fieldIndex(kXyOffset)], 2ull, "xyoffset ended two");
            t.Equals(c.vertsByField[fieldIndex(kXyOffset)], 10ull, "carrying 10 vertices: 5 per batch");
            t.Equals(c.byField[fieldIndex(kAlpha)], 1ull, "alpha one (counted for each bit of a combination)");
            t.Equals(c.alphaBatches, 1ull, "and alpha is among the changes in one");
            t.Equals(c.byCmd[static_cast<int>(Cmd::Upload)], 1ull, "an upload ended one");
            t.Equals(c.vertsByCmd[static_cast<int>(Cmd::Upload)], 12ull, "of 12 vertices");
            const std::vector<MaskCount> top = c.topMasks(8);
            t.Equals(top.size(), static_cast<size_t>(2), "two distinct key combinations");
            t.Equals(top[0].mask, kXyOffset, "the commonest first");
            t.Equals(top[0].batches, 2ull, "with its count");
            t.Equals(top[0].vertices, 10ull, "and its vertices");
            c.reset();
            t.Equals(c.batches, 0ull, "reset clears the interval");
            t.Equals(c.topMasks(8).size(), static_cast<size_t>(0), "and the combinations");
        });

        tc.Run("a pipeline state is new once per session: the set's size sizes a Metal pipeline cache", [](TestCase &t)
        {
            PipelineSet s;
            PipelineKey a{};
            a.blend = true;
            a.blendEq = 0x8006;
            a.blendSrc = 0x0302;
            a.blendDst = 0x0303;
            a.colorMask = 0xF;
            a.depthTest = true;
            a.depthFunc = 0x0206;
            a.depthWrite = true;
            a.targetPsm = 0;
            t.IsTrue(s.firstUse(a), "the first sighting is a first use");
            t.IsTrue(!s.firstUse(a), "the second is not");
            PipelineKey b = a;
            b.colorMask = 0x7;
            t.IsTrue(s.firstUse(b), "a different colour mask is another pipeline");
            t.Equals(s.size(), static_cast<size_t>(2), "two in the session");
        });
    });

    MiniTest::Case("GsGlFrameStats", [](TestCase &tc)
    {
        tc.Run("frame-time percentiles from 0.25 ms bins, the overflow bin counted, never dropped", [](TestCase &t)
        {
            FrameTimeHistogram h;
            for (int i = 0; i < 90; ++i) h.add(16.0);
            for (int i = 0; i < 8; ++i) h.add(30.0);
            h.add(70.0);
            h.add(400.0);   // past the last bin
            t.Equals(h.count(), 100ull, "every frame counted");
            t.IsTrue(h.percentile(0.50) >= 16.0 && h.percentile(0.50) <= 16.25, "p50 in the 16 ms bin");
            t.IsTrue(h.percentile(0.95) >= 30.0 && h.percentile(0.95) <= 30.25, "p95 in the 30 ms bin");
            t.IsTrue(h.percentile(0.99) >= 70.0 && h.percentile(0.99) <= 70.25, "p99 in the 70 ms bin");
            t.IsTrue(h.percentile(1.00) >= h.overflowMs(), "the worst frame is in the open bin");
            t.Equals(h.maxMs(), 400.0, "and the longest is kept exactly");
            FrameTimeHistogram total;
            total.merge(h);
            total.merge(h);
            t.Equals(total.count(), 200ull, "intervals merge into the session's histogram");
            h.reset();
            t.Equals(h.count(), 0ull, "reset empties an interval");
            t.Equals(h.percentile(0.5), 0.0, "and an empty one answers 0");
        });

        tc.Run("a slow frame is reported with the frame before it; a normal one is not", [](TestCase &t)
        {
            SlowFrameDetector d(45.0);
            FrameRecord rec{};
            t.IsTrue(!d.endFrame(20.0, countsWith(900), rec), "20 ms: not slow");
            t.IsTrue(d.endFrame(72.5, countsWith(4100), rec), "72.5 ms: slow");
            t.Equals(rec.frameMs, 72.5, "the record carries its time");
            t.Equals(rec.now.draws, 4100u, "its own counts");
            t.Equals(rec.before.draws, 900u, "and the frame before's, for contrast");
            t.IsTrue(!d.endFrame(44.9, countsWith(800), rec), "44.9 ms: under the threshold");
            SlowFrameDetector off(0.0);
            t.IsTrue(!off.endFrame(500.0, countsWith(1), rec), "a threshold of 0 reports nothing");
        });

        tc.Run("the ring never blocks its producer: full means dropped and counted", [](TestCase &t)
        {
            Ring<int, 4> r;
            int dropped = 0;
            for (int i = 0; i < 6; ++i)
                if (!r.tryPush(i)) ++dropped;
            t.Equals(dropped, 2, "two pushes past capacity are dropped, not waited on");
            t.Equals(r.dropped(), 2ull, "and counted");
            int v = -1;
            std::vector<int> got;
            while (r.tryPop(v)) got.push_back(v);
            t.Equals(got.size(), static_cast<size_t>(4), "the four that fit come out");
            t.Equals(got[0], 0, "in order");
            t.Equals(got[3], 3, "to the last");
            t.IsTrue(r.tryPush(9), "and the ring takes more once drained");
        });
    });
}
