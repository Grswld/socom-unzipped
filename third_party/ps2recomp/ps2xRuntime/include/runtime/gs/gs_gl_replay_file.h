#pragma once

// Sprint 17 F: the replay bench's file -- the GL thread's replayed command stream for a window of presents, so a
// draw-path change is measured by replaying the same recording through the backend (dist/gs_replay_bench.exe) in
// minutes instead of a build and a gate. PS2X_GS_RECORD=<file>[:<start>[:<frames>]] writes it (GSGlBackend::
// HostRenderFrame, the render thread, the exact CommandBuffer executeCommands is about to replay); the bench reads
// it. Header-only and free of GL, so ps2x_tests round-trips it without a context (gs_replay_file_tests.cpp).
//
// What exists already and why it is not this: PS2X_GIF_DUMP (gs_frontend.cpp) records the GIF packets the
// frontend processes, armed by host time and capped in megabytes, in PCSX2-dump shape for the console-replay case.
// It has no frame boundaries, no presents (the privileged display registers never pass through it) and not the
// native VU1 path's host triangles (GS::submitHostTriangle), so replaying it cannot time a mission frame. This file
// is taken one level lower, after the frontend: every Submit, transfer, upload, clear, present, readback and
// palette load, in replay order, grouped in the batches HostRenderFrame took.
//
// The layout (little-endian, the host's struct layouts -- a recording is read by a build of the same tree on the
// same kind of host, and the header's layout block refuses anything else):
//
//   header, 64 bytes: "PS2XGSR1", u32 version, Layout (six u32 sizes), u32 vramBytes, u32 clutCount,
//                     u32 cmdLayout (the recorder's hash of its command record: every field's offset and size,
//                     GSGlBackend::replayCmdLayoutHash), u64 startFrame (the backend's present count when recording
//                     began), u64 0
//   vramBytes of the render thread's shadow VRAM at the first recorded batch
//   clutCount GSClutLoad records: the palette snapshots the draws may still name (m_cluts)
//   u32 knobCount, then knobCount x (u16 n, name[n], u16 m, value[m]): every PS2X_GS_* knob as the recording run
//                     read it, an unset one with an empty value (version 2)
//   records, one tag byte each:
//     'B' u64 frameAtStart                            a batch begins (one HostRenderFrame)
//     'T' GSDrawState u8 n GSVertex[n]                a Submit with a new draw state
//     'S' u8 n GSVertex[n]                            a Submit with the previous Submit's state (the common case)
//     'D' u32 id u64 size bytes[size]                 a data blob, stored once per distinct content
//     'C' u8 type u32 m payload[m] u32 blob           any other command: the backend's CmdType, the fields it
//                                                     needs, the blob it names (kNoBlob for none)
//     'E'                                             the batch ends
//     'Z' u64 batches u64 presents                    the trailer: the recording closed cleanly
//
// The size, measured on the F2 mission (logs/parity/f2/A.log, [gs-gl stats] per 60 buffers): about 11.5 k Submits
// and 730 uploads a present, 83 % of the uploads identical to the last one to their rectangle ([gs-transfer]
// identical=). A Submit is ~125 bytes here against 656 for the in-memory record, and a repeated upload is a 4-byte
// reference, so a mission present is ~1.5 MB and 600 presents about 1 GB. The draw state is compared byte-wise;
// padding that differs only costs a 'T' where an 'S' would do, never a wrong state. Each batch restarts the state
// (its first Submit is a 'T'), so a batch reads on its own.

#include "runtime/gs/gs_state_equal.h"
#include "runtime/gs/gs_types.h"

#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace GsReplayFile
{
    constexpr char kMagic[8] = {'P', 'S', '2', 'X', 'G', 'S', 'R', '1'};
    // 2: the command layout hash, the knob block, and a flags word in every 'C' payload (the review's fix round:
    // F1 attempt 3's Cmd::swizzledByRecorder changed what an Upload's bytes mean without moving sizeof(Cmd)).
    constexpr uint32_t kVersion = 2u;
    constexpr uint32_t kHeaderBytes = 64u;
    constexpr size_t kLayoutOffset = 12u;          // the layout block's first byte (sizeof(GSVertex))
    constexpr uint32_t kNoBlob = 0xFFFFFFFFu;
    constexpr uint32_t kDefaultFrames = 600u;      // the gate's mission walk after the HUD, about half a minute
    constexpr uint32_t kMaxPayloadBytes = 4096u;   // a 'C' record's fields; the largest (a present) is ~170

    // The struct sizes a recording is only readable with: a recorder built from another tree reads as "layout".
    struct Layout
    {
        uint32_t vertexBytes = 0, stateBytes = 0, transferBytes = 0, presentBytes = 0, contextBytes = 0, clutBytes = 0;

        static Layout current()
        {
            Layout l;
            l.vertexBytes = sizeof(GSVertex);
            l.stateBytes = sizeof(GSDrawState);
            l.transferBytes = sizeof(GSTransferCommand);
            l.presentBytes = sizeof(GSPresentationRequest);
            l.contextBytes = sizeof(GSContext);
            l.clutBytes = sizeof(GSClutLoad);
            return l;
        }
        bool operator==(const Layout &o) const
        {
            return vertexBytes == o.vertexBytes && stateBytes == o.stateBytes && transferBytes == o.transferBytes &&
                   presentBytes == o.presentBytes && contextBytes == o.contextBytes && clutBytes == o.clutBytes;
        }
    };

    // ---- PS2X_GS_RECORD=<file>[:<start>[:<frames>]] ----
    // <start>: a present index (the backend's frame counter, from 0 at boot), t<seconds> (host time since the first
    // replayed frame), or trig (PS2X_TRIGGER's game-state trigger, as the trace knobs take it); default 0.
    // <frames>: presents to record, > 0; default kDefaultFrames. The file may carry a drive letter.
    enum class StartMode { Frame, Seconds, Trigger, Key };   // Key: when F9 is pressed (macOS perf, the owner's cue)
    struct RecordSpec
    {
        std::string file;
        StartMode mode = StartMode::Frame;
        double start = 0.0;
        uint32_t frames = kDefaultFrames;
    };

    inline bool parseUnsigned(const std::string &s, unsigned long long &out)
    {
        if (s.empty() || s.size() > 18u)
            return false;
        for (char ch : s)
            if (!std::isdigit(static_cast<unsigned char>(ch)))
                return false;
        out = std::strtoull(s.c_str(), nullptr, 10);
        return true;
    }

    inline bool parseRecordSpec(const char *spec, RecordSpec &out)
    {
        if (!spec || !*spec)
            return false;
        const std::string s(spec);
        const size_t from = (s.size() >= 2u && s[1] == ':' && std::isalpha(static_cast<unsigned char>(s[0]))) ? 2u : 0u;
        const size_t c1 = s.find(':', from);
        RecordSpec r;
        r.file = s.substr(0, c1);
        if (r.file.size() <= from)
            return false;
        if (c1 != std::string::npos)
        {
            const std::string rest = s.substr(c1 + 1u);
            const size_t c2 = rest.find(':');
            const std::string start = rest.substr(0, c2);
            unsigned long long v = 0;
            if (start == "trig")
                r.mode = StartMode::Trigger;
            else if (start == "key")
                r.mode = StartMode::Key;
            else if (!start.empty() && start[0] == 't')
            {
                char *end = nullptr;
                const double sec = std::strtod(start.c_str() + 1, &end);
                if (start.size() < 2u || !end || *end != '\0' || !(sec >= 0.0))
                    return false;
                r.mode = StartMode::Seconds;
                r.start = sec;
            }
            else if (parseUnsigned(start, v))
                r.start = static_cast<double>(v);
            else
                return false;
            if (c2 != std::string::npos)
            {
                if (!parseUnsigned(rest.substr(c2 + 1u), v) || v == 0u || v > 0xFFFFFFFFull)
                    return false;
                r.frames = static_cast<uint32_t>(v);
            }
        }
        out = r;
        return true;
    }

    // ---- content keys for the blob table ----
    inline uint64_t rotl64(uint64_t x, int r) { return (x << r) | (x >> (64 - r)); }
    inline uint64_t fmix64(uint64_t k)
    {
        k ^= k >> 33;
        k *= 0xFF51AFD7ED558CCDull;
        k ^= k >> 33;
        k *= 0xC4CEB9FE1A85EC53ull;
        k ^= k >> 33;
        return k;
    }
    // FNV-1a over 32-bit words: the command layout hash the recorder writes and the replayer checks.
    inline uint32_t layoutHash(const uint32_t *words, size_t n)
    {
        uint32_t h = 2166136261u;
        for (size_t i = 0; i < n; ++i)
            for (int b = 0; b < 4; ++b)
            {
                h ^= (words[i] >> (8 * b)) & 0xFFu;
                h *= 16777619u;
            }
        return h ? h : 1u;   // 0 means "not checked"
    }

    using KnobList = std::vector<std::pair<std::string, std::string>>;

    struct BlobKey
    {
        uint64_t h1 = 0, h2 = 0, size = 0;
        bool operator==(const BlobKey &o) const { return h1 == o.h1 && h2 == o.h2 && size == o.size; }
    };
    struct BlobKeyHash
    {
        size_t operator()(const BlobKey &k) const { return static_cast<size_t>(k.h1 ^ (k.h2 * 0x9E3779B97F4A7C15ull)); }
    };
    // Two independent 64-bit lanes over the bytes (and the size): a false match needs both to collide at once.
    inline BlobKey blobKey(const uint8_t *p, size_t n)
    {
        uint64_t h1 = 0x9E3779B97F4A7C15ull ^ n, h2 = 0xC2B2AE3D27D4EB4Full + n;
        size_t i = 0;
        for (; i + 8u <= n; i += 8u)
        {
            uint64_t w;
            std::memcpy(&w, p + i, 8);
            h1 = rotl64(h1 ^ (w * 0x87C37B91114253D5ull), 31) * 0x4CF5AD432745937Full;
            h2 = rotl64(h2 + (w ^ 0x52DCE729DA3ED8F1ull), 27) * 0x94D049BB133111EBull + 0x38495AB5ull;
        }
        uint64_t tail = 0;
        if (i < n)
            std::memcpy(&tail, p + i, n - i);
        h1 = fmix64(h1 ^ tail);
        h2 = fmix64(h2 + tail * 0xBF58476D1CE4E5B9ull);
        return BlobKey{h1, h2, static_cast<uint64_t>(n)};
    }

    // ---- what a reader hands back: one batch ----
    struct Event
    {
        bool submit = false;
        uint8_t type = 0;               // the backend's CmdType for a command (unused for a Submit)
        GSPrimitiveBatch prim{};        // a Submit's batch (vertices and state)
        uint32_t payloadOffset = 0;     // a command's fields, in Batch::payload
        uint32_t payloadSize = 0;
        uint32_t blob = kNoBlob;        // a command's data: Reader::blob(id)
    };
    struct Batch
    {
        uint64_t frameAtStart = 0;
        std::vector<Event> events;
        std::vector<uint8_t> payload;
        void clear()
        {
            frameAtStart = 0;
            events.clear();
            payload.clear();
        }
    };

    class Writer
    {
    public:
        Writer() = default;
        Writer(const Writer &) = delete;
        Writer &operator=(const Writer &) = delete;
        ~Writer()
        {
            if (m_fp)
                std::fclose(m_fp);
        }

        bool open(const std::string &path, uint64_t startFrame, const uint8_t *vram, uint32_t vramBytes,
                  const std::vector<GSClutLoad> &cluts, uint32_t cmdLayout = 0u, const KnobList &knobs = {})
        {
            if (m_fp)
                return false;
            m_fp = std::fopen(path.c_str(), "wb");
            if (!m_fp)
                return false;
            m_buffer.resize(8u << 20);
            std::setvbuf(m_fp, reinterpret_cast<char *>(m_buffer.data()), _IOFBF, m_buffer.size());
            uint8_t header[kHeaderBytes] = {};
            std::memcpy(header, kMagic, 8);
            put32(header + 8, kVersion);
            const Layout l = Layout::current();
            const uint32_t sizes[6] = {l.vertexBytes, l.stateBytes, l.transferBytes, l.presentBytes, l.contextBytes, l.clutBytes};
            for (int i = 0; i < 6; ++i)
                put32(header + kLayoutOffset + 4u * i, sizes[i]);
            put32(header + 36, vramBytes);
            put32(header + 40, static_cast<uint32_t>(cluts.size()));
            put32(header + 44, cmdLayout);
            std::memcpy(header + 48, &startFrame, 8);
            write(header, kHeaderBytes);
            if (vramBytes)
                write(vram, vramBytes);
            for (const GSClutLoad &c : cluts)
                write(&c, sizeof(GSClutLoad));
            const uint32_t knobCount = static_cast<uint32_t>(knobs.size());
            write(&knobCount, 4);
            for (const auto &kv : knobs)
            {
                for (const std::string *str : {&kv.first, &kv.second})
                {
                    const uint16_t n = static_cast<uint16_t>(str->size() < 0xFFFFu ? str->size() : 0xFFFFu);
                    write(&n, 2);
                    write(str->data(), n);
                }
            }
            return m_ok;
        }

        void beginBatch(uint64_t frameAtStart)
        {
            tag('B');
            write(&frameAtStart, 8);
            m_haveState = false;
            ++m_batches;
        }

        void submit(const GSPrimitiveBatch &b)
        {
            const uint8_t n = b.vertexCount <= 3u ? b.vertexCount : 3u;
            // By value: GSDrawState's padding is not state (gs_state_equal.h); a memcmp wrote 'T' for equal states.
            if (m_haveState && GsStateEqual::eq(m_lastState, b.state))
                tag('S');
            else
            {
                tag('T');
                write(&b.state, sizeof(GSDrawState));
                std::memcpy(&m_lastState, &b.state, sizeof(GSDrawState));
                m_haveState = true;
            }
            write(&n, 1);
            write(b.vertices.data(), sizeof(GSVertex) * n);
        }

        void command(uint8_t type, const void *payload, uint32_t payloadBytes, const uint8_t *data, size_t dataBytes)
        {
            uint32_t id = kNoBlob;
            if (data && dataBytes)
            {
                const BlobKey key = blobKey(data, dataBytes);
                const auto it = m_blobIds.find(key);
                if (it != m_blobIds.end())
                    id = it->second;
                else
                {
                    id = static_cast<uint32_t>(m_blobIds.size());
                    m_blobIds.emplace(key, id);
                    const uint64_t size = dataBytes;
                    tag('D');
                    write(&id, 4);
                    write(&size, 8);
                    write(data, dataBytes);
                }
                ++m_blobRefs;
            }
            if (payloadBytes > kMaxPayloadBytes)
                payloadBytes = kMaxPayloadBytes;
            tag('C');
            write(&type, 1);
            write(&payloadBytes, 4);
            if (payloadBytes)
                write(payload, payloadBytes);
            write(&id, 4);
        }

        void endBatch() { tag('E'); }

        bool close(uint64_t presents)
        {
            if (!m_fp)
                return false;
            tag('Z');
            write(&m_batches, 8);
            write(&presents, 8);
            const bool ok = m_ok && std::fclose(m_fp) == 0;
            m_fp = nullptr;
            m_buffer.clear();
            m_buffer.shrink_to_fit();
            return ok;
        }

        bool isOpen() const { return m_fp != nullptr; }
        bool ok() const { return m_ok; }
        uint64_t bytes() const { return m_bytes; }
        uint64_t batches() const { return m_batches; }
        uint64_t blobsStored() const { return m_blobIds.size(); }
        uint64_t blobRefs() const { return m_blobRefs; }

    private:
        static void put32(uint8_t *p, uint32_t v) { std::memcpy(p, &v, 4); }
        void tag(char t)
        {
            const uint8_t b = static_cast<uint8_t>(t);
            write(&b, 1);
        }
        void write(const void *p, size_t n)
        {
            if (!m_fp || !n)
                return;
            if (std::fwrite(p, 1, n, m_fp) != n)
                m_ok = false;
            m_bytes += n;
        }

        FILE *m_fp = nullptr;
        std::vector<uint8_t> m_buffer;
        bool m_ok = true;
        uint64_t m_bytes = 0;
        uint64_t m_batches = 0;
        uint64_t m_blobRefs = 0;
        bool m_haveState = false;
        GSDrawState m_lastState{};
        std::unordered_map<BlobKey, uint32_t, BlobKeyHash> m_blobIds;
    };

    class Reader
    {
    public:
        Reader() = default;
        Reader(const Reader &) = delete;
        Reader &operator=(const Reader &) = delete;
        ~Reader()
        {
            if (m_fp)
                std::fclose(m_fp);
        }

        // expectedCmdLayout: the replayer's own GSGlBackend::replayCmdLayoutHash(); 0 skips the check (the codec's tests).
        bool open(const std::string &path, std::string &err, uint32_t expectedCmdLayout = 0u)
        {
            m_fp = std::fopen(path.c_str(), "rb");
            if (!m_fp)
            {
                err = "cannot open " + path;
                return false;
            }
            m_buffer.resize(8u << 20);
            std::setvbuf(m_fp, reinterpret_cast<char *>(m_buffer.data()), _IOFBF, m_buffer.size());
            uint8_t header[kHeaderBytes];
            if (!read(header, kHeaderBytes))
            {
                err = "short header (not a PS2X_GS_RECORD file)";
                return false;
            }
            if (std::memcmp(header, kMagic, 8) != 0)
            {
                err = "bad magic (not a PS2X_GS_RECORD file)";
                return false;
            }
            uint32_t version = 0;
            std::memcpy(&version, header + 8, 4);
            if (version != kVersion)
            {
                err = "version " + std::to_string(version) + " (this reader is version " + std::to_string(kVersion) + ")";
                return false;
            }
            Layout l;
            uint32_t sizes[6];
            std::memcpy(sizes, header + kLayoutOffset, sizeof(sizes));
            l.vertexBytes = sizes[0];
            l.stateBytes = sizes[1];
            l.transferBytes = sizes[2];
            l.presentBytes = sizes[3];
            l.contextBytes = sizes[4];
            l.clutBytes = sizes[5];
            if (!(l == Layout::current()))
            {
                err = "layout: the recording's struct sizes are not this build's (record and replay with one tree)";
                return false;
            }
            uint32_t vramBytes = 0, clutCount = 0;
            std::memcpy(&vramBytes, header + 36, 4);
            std::memcpy(&clutCount, header + 40, 4);
            std::memcpy(&m_cmdLayout, header + 44, 4);
            if (expectedCmdLayout != 0u && m_cmdLayout != expectedCmdLayout)
            {
                err = "layout: the recording's command record (field offsets and sizes) is not this build's -- a recorder "
                      "from another tree; record and replay with one tree";
                return false;
            }
            std::memcpy(&m_startFrame, header + 48, 8);
            if (vramBytes > (64u << 20) || clutCount > (1u << 20))
            {
                err = "implausible header (vram or palette count)";
                return false;
            }
            m_vram.resize(vramBytes);
            if (vramBytes && !read(m_vram.data(), vramBytes))
            {
                err = "truncated VRAM snapshot";
                return false;
            }
            m_cluts.resize(clutCount);
            for (GSClutLoad &c : m_cluts)
                if (!read(&c, sizeof(GSClutLoad)))
                {
                    err = "truncated palettes";
                    return false;
                }
            uint32_t knobCount = 0;
            if (!read(&knobCount, 4) || knobCount > 4096u)
            {
                err = "truncated or implausible knob block";
                return false;
            }
            for (uint32_t i = 0; i < knobCount; ++i)
            {
                std::string parts[2];
                for (std::string &str : parts)
                {
                    uint16_t n = 0;
                    if (!read(&n, 2))
                    {
                        err = "truncated knob block";
                        return false;
                    }
                    str.resize(n);
                    if (n && !read(&str[0], n))
                    {
                        err = "truncated knob block";
                        return false;
                    }
                }
                m_knobs.emplace_back(parts[0], parts[1]);
            }
            return true;
        }

        // The next batch. False at the trailer or a clean end of file (err empty; sawTrailer() says which), or on
        // a damaged stream (err set).
        bool next(Batch &out, std::string &err)
        {
            out.clear();
            if (!m_fp || m_done)
                return false;
            uint8_t t = 0;
            if (!read(&t, 1))
            {
                m_done = true;   // the end, with no trailer: the recorder did not close (the game exited early)
                return false;
            }
            if (t == 'Z')
            {
                m_done = true;
                if (!read(&m_trailerBatches, 8) || !read(&m_trailerPresents, 8))
                {
                    err = "truncated trailer";
                    return false;
                }
                m_sawTrailer = true;
                return false;
            }
            if (t != 'B' || !read(&out.frameAtStart, 8))
                return fail(err, t != 'B' ? "a record outside a batch" : "truncated batch header");
            bool haveState = false;
            GSDrawState state{};
            for (;;)
            {
                if (!read(&t, 1))
                    return fail(err, "truncated batch (no end record)");
                if (t == 'E')
                    return true;
                if (t == 'S' || t == 'T')
                {
                    Event e;
                    e.submit = true;
                    if (t == 'T')
                    {
                        if (!read(&state, sizeof(GSDrawState)))
                            return fail(err, "truncated submit state");
                        haveState = true;
                    }
                    else if (!haveState)
                        return fail(err, "a submit names a state the batch never gave");
                    uint8_t n = 0;
                    if (!read(&n, 1) || n > 3u || (n && !read(e.prim.vertices.data(), sizeof(GSVertex) * n)))
                        return fail(err, "truncated submit vertices");
                    e.prim.vertexCount = n;
                    e.prim.state = state;
                    out.events.push_back(e);
                }
                else if (t == 'D')
                {
                    uint32_t id = 0;
                    uint64_t size = 0;
                    if (!read(&id, 4) || !read(&size, 8))
                        return fail(err, "truncated blob header");
                    if (id != m_blobs.size() || size > (256ull << 20))
                        return fail(err, "blob out of sequence or implausible");
                    std::vector<uint8_t> bytes(static_cast<size_t>(size));
                    if (size && !read(bytes.data(), bytes.size()))
                        return fail(err, "truncated blob");
                    m_blobs.push_back(std::move(bytes));
                }
                else if (t == 'C')
                {
                    Event e;
                    uint32_t m = 0;
                    if (!read(&e.type, 1) || !read(&m, 4) || m > kMaxPayloadBytes)
                        return fail(err, "truncated or oversized command");
                    e.payloadOffset = static_cast<uint32_t>(out.payload.size());
                    e.payloadSize = m;
                    out.payload.resize(out.payload.size() + m);
                    if (m && !read(out.payload.data() + e.payloadOffset, m))
                        return fail(err, "truncated command payload");
                    if (!read(&e.blob, 4) || (e.blob != kNoBlob && e.blob >= m_blobs.size()))
                        return fail(err, "a command names a blob not yet stored");
                    out.events.push_back(e);
                }
                else
                    return fail(err, std::string("unknown record tag ") + std::to_string(static_cast<unsigned>(t)));
            }
        }

        const std::vector<uint8_t> &vram() const { return m_vram; }
        const std::vector<GSClutLoad> &cluts() const { return m_cluts; }
        uint64_t startFrame() const { return m_startFrame; }
        uint32_t cmdLayout() const { return m_cmdLayout; }
        const KnobList &knobs() const { return m_knobs; }
        const std::vector<uint8_t> &blob(uint32_t id) const
        {
            static const std::vector<uint8_t> s_none;
            return id < m_blobs.size() ? m_blobs[id] : s_none;
        }
        size_t blobCount() const { return m_blobs.size(); }
        bool sawTrailer() const { return m_sawTrailer; }
        uint64_t trailerBatches() const { return m_trailerBatches; }
        uint64_t trailerPresents() const { return m_trailerPresents; }

    private:
        bool read(void *p, size_t n) { return std::fread(p, 1, n, m_fp) == n; }
        bool fail(std::string &err, const std::string &why)
        {
            err = why;
            m_done = true;
            return false;
        }

        FILE *m_fp = nullptr;
        std::vector<uint8_t> m_buffer;
        std::vector<uint8_t> m_vram;
        std::vector<GSClutLoad> m_cluts;
        std::vector<std::vector<uint8_t>> m_blobs;
        uint64_t m_startFrame = 0;
        uint32_t m_cmdLayout = 0;
        KnobList m_knobs;
        bool m_done = false;
        bool m_sawTrailer = false;
        uint64_t m_trailerBatches = 0;
        uint64_t m_trailerPresents = 0;
    };
}
