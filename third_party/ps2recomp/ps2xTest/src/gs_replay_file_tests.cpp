// Sprint 17 F (the replay bench): the file PS2X_GS_RECORD writes and dist/gs_replay_bench.exe reads -- the GL
// thread's replayed command stream for a window of frames, the shadow VRAM and the palettes at its start, the
// upload bytes inline and stored once per distinct content. These cases hold the format without a GL context: a
// synthetic stream written, read back and compared field by field; the knob's spec parser; and the accumulator the
// bench sums the [gs-submit] split into across the stats cadence's resets.
#include "MiniTest.h"
#include "runtime/gs/gs_gl_replay_file.h"
#include "runtime/gs/gs_gl_upload_trace.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace
{
    std::string tempPath(const char *name)
    {
        const char *dir = std::getenv("TEMP");
        if (!dir || !*dir)
            dir = std::getenv("TMPDIR");
        std::string base = (dir && *dir) ? std::string(dir) : std::string(".");
        return base + "/" + name;
    }

    GSPrimitiveBatch triangle(float x0, uint32_t fbp)
    {
        GSPrimitiveBatch b{};
        b.vertexCount = 3;
        for (int i = 0; i < 3; ++i)
        {
            b.vertices[i].x = x0 + static_cast<float>(i);
            b.vertices[i].y = 2.0f * static_cast<float>(i);
            b.vertices[i].z = 0.25 * i;
            b.vertices[i].r = static_cast<uint8_t>(10 + i);
            b.vertices[i].a = 0x80;
            b.vertices[i].u = static_cast<uint16_t>(16 * i);
        }
        b.state.context.frame.fbp = fbp;
        b.state.context.frame.fbw = 10;
        b.state.prim.type = GS_PRIM_TRIANGLE;
        b.state.textureWidth = 64;
        return b;
    }

    bool sameVertices(const GSPrimitiveBatch &a, const GSPrimitiveBatch &b)
    {
        if (a.vertexCount != b.vertexCount)
            return false;
        for (int i = 0; i < a.vertexCount; ++i)
        {
            const GSVertex &p = a.vertices[i], &q = b.vertices[i];
            if (p.x != q.x || p.y != q.y || p.z != q.z || p.r != q.r || p.g != q.g || p.b != q.b || p.a != q.a ||
                p.q != q.q || p.s != q.s || p.t != q.t || p.u != q.u || p.v != q.v || p.fog != q.fog)
                return false;
        }
        return true;
    }

    std::vector<uint8_t> readFile(const std::string &path)
    {
        std::vector<uint8_t> out;
        if (FILE *fp = std::fopen(path.c_str(), "rb"))
        {
            std::fseek(fp, 0, SEEK_END);
            out.resize(static_cast<size_t>(std::ftell(fp)));
            std::fseek(fp, 0, SEEK_SET);
            out.resize(std::fread(out.data(), 1, out.size(), fp));
            std::fclose(fp);
        }
        return out;
    }

    void writeFile(const std::string &path, const std::vector<uint8_t> &bytes)
    {
        if (FILE *fp = std::fopen(path.c_str(), "wb"))
        {
            std::fwrite(bytes.data(), 1, bytes.size(), fp);
            std::fclose(fp);
        }
    }

    // The synthetic stream: two batches, the second submit re-using the first's state (written once), one upload
    // blob sent twice (stored once), a present with a payload, a command with neither payload nor data.
    constexpr uint8_t kTypeUpload = 2, kTypePresent = 5, kTypeReadback = 6;
    struct Planted
    {
        std::vector<uint8_t> vram;
        std::vector<GSClutLoad> cluts;
        std::vector<uint8_t> upload;
        uint8_t presentPayload[24];
        GSPrimitiveBatch a, b, c;
    };

    Planted plant()
    {
        Planted p;
        p.vram.resize(4096);
        for (size_t i = 0; i < p.vram.size(); ++i)
            p.vram[i] = static_cast<uint8_t>(i * 7u + 3u);
        GSClutLoad c0{}, c1{};
        c0.id = 11;
        c0.cbp = 0x3852;
        c0.cpsm = 0;
        c0.bytes[0] = 0xAB;
        c1.id = 12;
        c1.cbp = 0x3854;
        c1.cpsm = 2;
        c1.bytes[2047] = 0xCD;
        p.cluts = {c0, c1};
        p.upload.resize(1024);
        for (size_t i = 0; i < p.upload.size(); ++i)
            p.upload[i] = static_cast<uint8_t>(i ^ 0x5Au);
        for (int i = 0; i < 24; ++i)
            p.presentPayload[i] = static_cast<uint8_t>(0xF0 + i);
        p.a = triangle(1.0f, 0x8c);
        p.b = triangle(5.0f, 0x8c);   // same state as a
        p.c = triangle(9.0f, 0x46);   // a new state
        return p;
    }

    bool writePlanted(const std::string &path, const Planted &p, GsReplayFile::Writer &w)
    {
        if (!w.open(path, 1200u, p.vram.data(), static_cast<uint32_t>(p.vram.size()), p.cluts))
            return false;
        w.beginBatch(1200u);
        w.submit(p.a);
        w.submit(p.b);
        w.command(kTypeUpload, nullptr, 0u, p.upload.data(), p.upload.size());
        w.command(kTypeUpload, nullptr, 0u, p.upload.data(), p.upload.size());
        w.command(kTypePresent, p.presentPayload, sizeof(p.presentPayload), nullptr, 0u);
        w.endBatch();
        w.beginBatch(1201u);
        w.submit(p.c);
        w.command(kTypeReadback, nullptr, 0u, nullptr, 0u);
        w.endBatch();
        return w.close(1u);
    }
}

void register_gs_replay_file_tests()
{
    MiniTest::Case("GsReplayFile", [](TestCase &tc)
    {
        tc.Run("a synthetic stream round-trips: header, VRAM, palettes, batches, submits, payloads and blobs", [](TestCase &t)
        {
            const std::string path = tempPath("ps2x_gs_replay_roundtrip.gsr");
            const Planted p = plant();
            GsReplayFile::Writer w;
            t.IsTrue(writePlanted(path, p, w), "the writer opens, writes two batches and closes");
            t.Equals(w.blobsStored(), static_cast<uint64_t>(1u), "the upload sent twice is stored once");
            t.Equals(w.blobRefs(), static_cast<uint64_t>(2u), "... and referenced twice");

            GsReplayFile::Reader r;
            std::string err;
            t.IsTrue(r.open(path, err), "the reader opens the file: " + err);
            t.Equals(r.startFrame(), static_cast<uint64_t>(1200u), "the start frame is kept");
            t.IsTrue(r.vram() == p.vram, "the VRAM snapshot is byte-identical");
            t.Equals(r.cluts().size(), static_cast<size_t>(2u), "both palettes are kept");
            if (r.cluts().size() == 2u)
            {
                t.Equals(r.cluts()[0].id, static_cast<uint64_t>(11u), "palette 0's id");
                t.Equals(static_cast<uint32_t>(r.cluts()[0].bytes[0]), 0xABu, "palette 0's bytes");
                t.Equals(r.cluts()[1].cbp, 0x3854u, "palette 1's cbp");
                t.Equals(static_cast<uint32_t>(r.cluts()[1].bytes[2047]), 0xCDu, "palette 1's last byte");
            }

            GsReplayFile::Batch b1, b2, b3;
            t.IsTrue(r.next(b1, err), "batch 1 reads: " + err);
            t.Equals(b1.frameAtStart, static_cast<uint64_t>(1200u), "batch 1's frame");
            t.Equals(b1.events.size(), static_cast<size_t>(5u), "batch 1 holds five events");
            if (b1.events.size() == 5u)
            {
                t.IsTrue(b1.events[0].submit && sameVertices(b1.events[0].prim, p.a), "event 0 is submit a");
                t.IsTrue(b1.events[1].submit && sameVertices(b1.events[1].prim, p.b), "event 1 is submit b");
                t.Equals(b1.events[1].prim.state.context.frame.fbp, 0x8cu, "submit b carries a's state (written once)");
                t.Equals(static_cast<uint32_t>(b1.events[1].prim.state.textureWidth), 64u, "... whole");
                t.IsTrue(!b1.events[2].submit && b1.events[2].type == kTypeUpload, "event 2 is an upload");
                t.IsTrue(b1.events[2].blob != GsReplayFile::kNoBlob && b1.events[2].blob == b1.events[3].blob,
                         "both uploads name the one stored blob");
                if (b1.events[2].blob != GsReplayFile::kNoBlob)
                    t.IsTrue(r.blob(b1.events[2].blob) == p.upload, "the blob's bytes are the upload's");
                t.Equals(b1.events[4].type, kTypePresent, "event 4 is the present");
                t.Equals(b1.events[4].payloadSize, 24u, "its payload is 24 bytes");
                t.IsTrue(b1.events[4].payloadSize == 24u &&
                             std::memcmp(b1.payload.data() + b1.events[4].payloadOffset, p.presentPayload, 24) == 0,
                         "its payload bytes are kept");
                t.Equals(b1.events[4].blob, GsReplayFile::kNoBlob, "the present has no data");
            }
            t.IsTrue(r.next(b2, err), "batch 2 reads: " + err);
            t.Equals(b2.frameAtStart, static_cast<uint64_t>(1201u), "batch 2's frame");
            t.Equals(b2.events.size(), static_cast<size_t>(2u), "batch 2 holds two events");
            if (b2.events.size() == 2u)
            {
                t.IsTrue(b2.events[0].submit && sameVertices(b2.events[0].prim, p.c), "event 0 is submit c");
                t.Equals(b2.events[0].prim.state.context.frame.fbp, 0x46u, "submit c carries its own state");
                t.IsTrue(!b2.events[1].submit && b2.events[1].type == kTypeReadback && b2.events[1].payloadSize == 0u &&
                             b2.events[1].blob == GsReplayFile::kNoBlob,
                         "event 1 is the bare readback");
            }
            t.IsFalse(r.next(b3, err), "no third batch");
            t.IsTrue(err.empty(), "the end is clean: " + err);
            t.IsTrue(r.sawTrailer(), "the trailer was read");
            t.Equals(r.trailerBatches(), static_cast<uint64_t>(2u), "the trailer counts two batches");
            t.Equals(r.trailerPresents(), static_cast<uint64_t>(1u), "the trailer counts one present");
            std::remove(path.c_str());
        });

        tc.Run("a damaged file is refused: wrong magic, a foreign struct layout, a truncated batch", [](TestCase &t)
        {
            const std::string path = tempPath("ps2x_gs_replay_damaged.gsr");
            const Planted p = plant();
            GsReplayFile::Writer w;
            t.IsTrue(writePlanted(path, p, w), "the writer writes the planted stream");
            const std::vector<uint8_t> good = readFile(path);
            t.IsTrue(good.size() > 64u, "the file is written");
            std::string err;

            std::vector<uint8_t> bad = good;
            bad[0] ^= 0xFFu;
            writeFile(path, bad);
            GsReplayFile::Reader r1;
            t.IsFalse(r1.open(path, err), "a wrong magic does not open");
            t.IsTrue(err.find("magic") != std::string::npos, "... and says magic: " + err);

            bad = good;
            bad[GsReplayFile::kLayoutOffset] ^= 0x01u;   // the recorder's sizeof(GSVertex) no longer matches ours
            writeFile(path, bad);
            GsReplayFile::Reader r2;
            err.clear();
            t.IsFalse(r2.open(path, err), "a foreign layout does not open");
            t.IsTrue(err.find("layout") != std::string::npos, "... and says layout: " + err);

            bad.assign(good.begin(), good.end() - 40);   // cut inside the second batch or the trailer
            writeFile(path, bad);
            GsReplayFile::Reader r3;
            err.clear();
            t.IsTrue(r3.open(path, err), "the truncated file's header still opens");
            GsReplayFile::Batch b;
            int batches = 0;
            while (r3.next(b, err))
                ++batches;
            t.IsTrue(!err.empty() || !r3.sawTrailer(), "the cut is noticed (an error, or no trailer)");
            t.IsTrue(batches <= 2, "no batch is invented");
            std::remove(path.c_str());
        });

        tc.Run("the PS2X_GS_RECORD spec: <file>[:<start>[:<frames>]], start a present index, t<seconds> or trig", [](TestCase &t)
        {
            GsReplayFile::RecordSpec s;
            t.IsTrue(GsReplayFile::parseRecordSpec("logs/x.gsr", s), "a bare file parses");
            t.Equals(s.file, std::string("logs/x.gsr"), "... the file");
            t.IsTrue(s.mode == GsReplayFile::StartMode::Frame && s.start == 0.0, "... from present 0");
            t.Equals(s.frames, GsReplayFile::kDefaultFrames, "... for the default 600 presents");

            t.IsTrue(GsReplayFile::parseRecordSpec("C:/logs/y.gsr:t95.5:300", s), "a drive letter and t<seconds> parse");
            t.Equals(s.file, std::string("C:/logs/y.gsr"), "... the drive letter stays in the file");
            t.IsTrue(s.mode == GsReplayFile::StartMode::Seconds && s.start == 95.5, "... from 95.5 s");
            t.Equals(s.frames, 300u, "... for 300 presents");

            t.IsTrue(GsReplayFile::parseRecordSpec("z.gsr:1200", s), "a present index parses");
            t.IsTrue(s.mode == GsReplayFile::StartMode::Frame && s.start == 1200.0 && s.frames == GsReplayFile::kDefaultFrames,
                     "... from present 1200, 600 presents");

            t.IsTrue(GsReplayFile::parseRecordSpec("z.gsr:trig:50", s), "trig parses");
            t.IsTrue(s.mode == GsReplayFile::StartMode::Trigger && s.frames == 50u, "... armed by PS2X_TRIGGER, 50 presents");

            t.IsFalse(GsReplayFile::parseRecordSpec("z.gsr:soon", s), "a start that is none of the three is refused");
            t.IsFalse(GsReplayFile::parseRecordSpec("z.gsr:10:0", s), "zero presents is refused");
            t.IsFalse(GsReplayFile::parseRecordSpec("", s), "an empty spec is refused");
        });

        tc.Run("the [gs-submit] accumulator sums across the stats cadence's resets", [](TestCase &t)
        {
            GsGlUploadTrace::Accum total, a, b;
            GsGlUploadTrace::noteSubmitFlush(a, 10.0, 2.0, 3.0, 4.0);
            GsGlUploadTrace::noteReadback(a, 16u, 1000u, 5.0);
            GsGlUploadTrace::noteUpload(a, 1024u, 1.5, 0.5);
            GsGlUploadTrace::noteSubmitFlush(b, 20.0, 1.0, 1.0, 6.0);
            GsGlUploadTrace::noteRtDirect(b);
            GsGlUploadTrace::accumulate(total, a);
            GsGlUploadTrace::accumulate(total, b);
            t.Equals(total.submitFlushes, static_cast<uint64_t>(2u), "flushes add");
            t.Equals(total.submitSetupUs, 30.0, "setup adds");
            t.Equals(total.submitRowsUs, 3.0, "dirty_rows adds");
            t.Equals(total.submitResolveUs, 4.0, "resolve adds");
            t.Equals(total.submitDrawUs, 10.0, "draw adds");
            t.Equals(total.readbacks, static_cast<uint64_t>(1u), "readbacks add");
            t.Equals(total.readbackUs, 5.0, "readback time adds");
            t.Equals(total.rtDirect, static_cast<uint64_t>(1u), "rt_direct adds");
            t.Equals(total.uploads, static_cast<uint64_t>(1u), "uploads add");
            t.Equals(total.shadowUs, 1.5, "the upload's shadow time adds");
        });
    });
}
