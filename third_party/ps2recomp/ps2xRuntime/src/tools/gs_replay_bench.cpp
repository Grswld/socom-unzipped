// Sprint 17 F: the draw-path bench. Replays a PS2X_GS_RECORD recording (gs_gl_replay_file.h) through the OpenGL
// backend's own executeCommands on a hidden raylib window -- no game, no ELF, no disc, no loop lock -- and prints
// ONE summary line of what the draw path cost over the recording, with a JSON beside it:
//
//   [gs-replay-bench] recording=<name> per=60frames frames=<n> warmup=<w> batches=<b> elapsed=<ms>ms fps=<x>
//       ms_per_frame=<x>ms flushes=<x>/s setup=<x>ms/s dirty_rows= resolve= draw= readback=<x>ms/s readbacks=<x>/s
//       readback_rows= readback_px= rt_direct=<x>/s submit=<x>ms/s transfer= upload= wvram= clear= present=
//       readback_cmd=<x>ms/s hist_n=<n> le17= le20= le25= le33= le50= le100= over= longest_ms=<x>
//
// The [gs-submit] fields keep that line's names (tools_py/parity/submit_split.py) and the [gs-gl stats] command
// buckets keep theirs (submit= is the whole bucket the split divides; its readback column is readback_cmd= here),
// but the unit differs and on purpose: a "ms/s" here is milliseconds per 60 replayed presents -- per second of game
// at 60 presents a second -- not per second of wall, because the bench runs as fast as it can and a per-wall figure
// would move every field whenever one got cheaper. A present's replay time is the hist_ histogram (edges in ms as
// [gs-gl stats] frames; glFinish closes each batch, so the GPU's share is in it) and ms_per_frame= is its mean.
//
//   gs_replay_bench <recording.gsr> [--warmup N] [--frames N] [--json <out.json>] [--no-stats]
//
// --warmup N (default 30): presents replayed before the totals start (the recording starts with no render targets
// and no decoded textures; the game's first frames of the window had them). --frames N (default 0 = to the end):
// presents measured. --json: where the JSON goes (default <recording>.bench.json). The bench sets PS2X_DEV,
// PS2X_GS_UPLOAD_TRACE=1 (the split needs it) and PS2X_GS_STATS=1 (the F runs' configuration, research/73; its
// [gs-gl stats] lines print to stderr every 60 batches); --no-stats leaves PS2X_GS_STATS unset, as a plain gate
// run has it. Exit 0 with a summary; 2 usage or an unreadable recording; 3 no GL (the bench needs a desktop
// session: a hidden window and OpenGL 3.3, as the console-replay case with PS2X_CONSOLE_REPLAY_GL); 4 a recording
// shorter than the warm-up.
#include "raylib.h"

#include "runtime/gs/gs_gl_backend.h"
#include "runtime/gs/gs_gl_replay_file.h"
#include "runtime/ps2_memory.h"
#include "ps2x/knobs.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace
{
    void benchSetEnv(const char *name, const char *value)
    {
#ifdef _WIN32
        _putenv_s(name, value);
#else
        if (*value)
            setenv(name, value, 1);
        else
            unsetenv(name);
#endif
    }

    std::string baseName(const std::string &path)
    {
        const size_t slash = path.find_last_of("/\\");
        std::string b = slash == std::string::npos ? path : path.substr(slash + 1);
        for (char &ch : b)
            if (ch == ' ' || ch == '"' || ch == '\\' || ch == '=')
                ch = '_';
        return b;
    }

    struct Field
    {
        const char *name;
        double value;
        const char *unit;   // "ms/s", "/s" or "ms"
    };
}

int main(int argc, char **argv)
{
    ps2x::knobs::setDevMode(true);   // the knobs below are Dev
    std::string recording, jsonPath;
    uint64_t warmup = 30u, frames = 0u;
    bool stats = true;
    for (int i = 1; i < argc; ++i)
    {
        if (!std::strcmp(argv[i], "--warmup") && i + 1 < argc)
            warmup = std::strtoull(argv[++i], nullptr, 10);
        else if (!std::strcmp(argv[i], "--frames") && i + 1 < argc)
            frames = std::strtoull(argv[++i], nullptr, 10);
        else if (!std::strcmp(argv[i], "--json") && i + 1 < argc)
            jsonPath = argv[++i];
        else if (!std::strcmp(argv[i], "--no-stats"))
            stats = false;
        else if (argv[i][0] != '-' && recording.empty())
            recording = argv[i];
        else
        {
            recording.clear();
            break;
        }
    }
    if (recording.empty())
    {
        std::fprintf(stderr, "usage: gs_replay_bench <recording.gsr> [--warmup N] [--frames N] [--json <out.json>] [--no-stats]\n"
                             "       (record one with PS2X_GS_RECORD=<file>[:<present>|t<seconds>|trig[:<presents>]])\n");
        return 2;
    }
    if (jsonPath.empty())
        jsonPath = recording + ".bench.json";
    benchSetEnv("PS2X_GS_UPLOAD_TRACE", "1");
    benchSetEnv("PS2X_GS_STATS", stats ? "1" : "");

    GsReplayFile::Reader reader;
    std::string err;
    if (!reader.open(recording, err))
    {
        std::fprintf(stderr, "[gs-replay-bench] %s: %s\n", recording.c_str(), err.c_str());
        return 2;
    }

    SetTraceLogLevel(LOG_WARNING);
    SetConfigFlags(FLAG_WINDOW_HIDDEN);
    InitWindow(640, 448, "gs_replay_bench");
    if (!IsWindowReady())
    {
        std::fprintf(stderr, "[gs-replay-bench] no window: the bench needs a desktop session (a hidden raylib window, OpenGL 3.3)\n");
        return 3;
    }
    std::vector<uint8_t> vram(reader.vram());
    vram.resize(PS2_GS_VRAM_SIZE, 0u);
    GSGlBackend backend;
    backend.Initialize(vram.data(), static_cast<uint32_t>(vram.size()));   // seeds the render thread's shadow
    if (!backend.BenchBegin(reader.cluts()))
    {
        std::fprintf(stderr, "[gs-replay-bench] the GL backend did not start: %s\n", GSGlBackend::glMissingForProcess().c_str());
        CloseWindow();
        return 3;
    }

    GsReplayFile::Batch batch;
    uint64_t presents = 0u, batches = 0u, measuredBatches = 0u, measuredPresents = 0u;
    bool measuring = warmup == 0u;
    while (reader.next(batch, err))
    {
        const uint64_t p = backend.BenchReplay(batch, reader);
        presents += p;
        ++batches;
        if (!measuring)
        {
            if (presents >= warmup)
            {
                backend.BenchResetTotals();   // the warm-up ends with this batch
                measuring = true;
            }
            continue;
        }
        ++measuredBatches;
        measuredPresents += p;
        if (frames && measuredPresents >= frames)
            break;
    }
    if (!err.empty())
        std::fprintf(stderr, "[gs-replay-bench] WARNING: the recording is damaged after batch %llu (%s); the summary covers what replayed\n",
                     (unsigned long long)batches, err.c_str());
    else if (!reader.sawTrailer() && !(frames && measuredPresents >= frames))
        std::fprintf(stderr, "[gs-replay-bench] WARNING: no trailer -- the recorder never closed the file (the game stopped first); the summary covers what is in it\n");
    const GSGlBackend::BenchTotals t = backend.BenchTotalsNow();
    CloseWindow();
    if (!measuring || t.presents == 0u)
    {
        std::fprintf(stderr, "[gs-replay-bench] %s holds %llu presents, not more than the warm-up of %llu: nothing measured\n",
                     recording.c_str(), (unsigned long long)presents, (unsigned long long)warmup);
        return 4;
    }

    const double f = static_cast<double>(t.presents);
    const double per60 = 60.0 / f;
    auto msPer60 = [&](double us) { return us / 1000.0 * per60; };
    auto countPer60 = [&](uint64_t n) { return static_cast<double>(n) * per60; };
    const GsGlUploadTrace::Accum &a = t.trace;
    const Field fields[] = {
        {"ms_per_frame", t.elapsedMs / f, "ms"},
        {"flushes", countPer60(a.submitFlushes), "/s"},
        {"setup", msPer60(a.submitSetupUs), "ms/s"},
        {"dirty_rows", msPer60(a.submitRowsUs), "ms/s"},
        {"resolve", msPer60(a.submitResolveUs), "ms/s"},
        {"draw", msPer60(a.submitDrawUs), "ms/s"},
        {"readback", msPer60(a.readbackUs), "ms/s"},
        {"readbacks", countPer60(a.readbacks), "/s"},
        {"readback_rows", countPer60(a.readbackRows), "/s"},
        {"readback_px", countPer60(a.readbackPixels), "/s"},
        {"rt_direct", countPer60(a.rtDirect), "/s"},
        {"submit", t.cmdMs[0] * per60, "ms/s"},
        {"transfer", t.cmdMs[1] * per60, "ms/s"},
        {"upload", t.cmdMs[2] * per60, "ms/s"},
        {"wvram", t.cmdMs[3] * per60, "ms/s"},
        {"clear", t.cmdMs[4] * per60, "ms/s"},
        {"present", t.cmdMs[5] * per60, "ms/s"},
        {"readback_cmd", t.cmdMs[6] * per60, "ms/s"},
    };
    const double fps = t.elapsedMs > 0.0 ? f * 1000.0 / t.elapsedMs : 0.0;
    const std::string name = baseName(recording);
    const GsFrameHistogram &h = t.hist;
    const char *const histNames[7] = {"le17", "le20", "le25", "le33", "le50", "le100", "over"};

    std::string line = "[gs-replay-bench] recording=" + name + " per=60frames";
    char buf[160];
    std::snprintf(buf, sizeof(buf), " frames=%llu warmup=%llu batches=%llu elapsed=%.0fms fps=%.2f",
                  (unsigned long long)t.presents, (unsigned long long)warmup, (unsigned long long)measuredBatches, t.elapsedMs, fps);
    line += buf;
    for (const Field &fd : fields)
    {
        std::snprintf(buf, sizeof(buf), " %s=%.1f%s", fd.name, fd.value, fd.unit);
        line += buf;
    }
    std::snprintf(buf, sizeof(buf), " hist_n=%llu", (unsigned long long)h.n);
    line += buf;
    for (int i = 0; i < 7; ++i)
    {
        std::snprintf(buf, sizeof(buf), " %s=%llu", histNames[i], (unsigned long long)h.counts[i]);
        line += buf;
    }
    std::snprintf(buf, sizeof(buf), " longest_ms=%.1f", static_cast<double>(h.longestNs) / 1.0e6);
    line += buf;
    std::printf("%s\n", line.c_str());
    std::fflush(stdout);

    if (FILE *fp = std::fopen(jsonPath.c_str(), "wb"))
    {
        std::fprintf(fp, "{\n  \"tool\": \"gs_replay_bench\",\n  \"recording\": \"%s\",\n  \"per\": \"60frames\",\n", name.c_str());
        std::fprintf(fp, "  \"frames\": %llu,\n  \"warmup\": %llu,\n  \"batches\": %llu,\n  \"elapsed_ms\": %.3f,\n  \"fps\": %.4f,\n",
                     (unsigned long long)t.presents, (unsigned long long)warmup, (unsigned long long)measuredBatches, t.elapsedMs, fps);
        std::fprintf(fp, "  \"start_frame\": %llu,\n  \"stats\": %s,\n  \"fields\": {\n",
                     (unsigned long long)reader.startFrame(), stats ? "true" : "false");
        const size_t nf = sizeof(fields) / sizeof(fields[0]);
        for (size_t i = 0; i < nf; ++i)
            std::fprintf(fp, "    \"%s\": %.4f%s\n", fields[i].name, fields[i].value, i + 1 < nf ? "," : "");
        std::fprintf(fp, "  },\n  \"ms_fields\": [");
        bool first = true;
        for (size_t i = 0; i < nf; ++i)
            if (fields[i].unit[0] == 'm')
            {
                std::fprintf(fp, "%s\"%s\"", first ? "" : ", ", fields[i].name);
                first = false;
            }
        std::fprintf(fp, "],\n  \"hist\": {\"n\": %llu", (unsigned long long)h.n);
        for (int i = 0; i < 7; ++i)
            std::fprintf(fp, ", \"%s\": %llu", histNames[i], (unsigned long long)h.counts[i]);
        std::fprintf(fp, ", \"longest_ms\": %.3f}\n}\n", static_cast<double>(h.longestNs) / 1.0e6);
        std::fclose(fp);
    }
    else
        std::fprintf(stderr, "[gs-replay-bench] WARNING: cannot write %s\n", jsonPath.c_str());
    return 0;
}
