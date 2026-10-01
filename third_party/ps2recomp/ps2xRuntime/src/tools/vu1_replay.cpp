// vu1_replay: run one VU1 program dump (PS2X_VU1_DUMP=<dir> -> vu1_prog_N.bin) through the runtime's
// VU1 interpreter offline and save every XGKICK packet it produces.
//
//   vu1_replay <dump.bin> [--out packets.bin] [--trace] [--state]
//   vu1_replay --batch <outdir> [--repeat N] [--state] <dump.bin>...
//   vu1_replay --gen <out.cpp> [--pchist hist.bin] <dump.bin>...   (VU1 image -> known-program C++)
//   vu1_replay --vram-diff <outdir> [--vram-tol pct] <dump.bin>... (GIF kick vs host draw, per pixel)
//
// Dump layout: uint32 startPc, top, itop, codeSize; 16 KB code; 16 KB data; int32 vi[16]; float
// vf[32][4] (the register file at program start — VU registers persist across MSCALs, so the dump
// restores them before running). The packet file is a sequence of (uint32 length, bytes) records;
// tools_py/gif_packets.py parses them into vertices.
//
// Batch mode writes <outdir>/<dump basename>.pk per dump and <outdir>/state.txt with one line per
// dump (packet count/bytes/FNV hash, cycles, end pc, every register as hex, VU data memory hash) —
// the "golden" used to verify a faster execution path packet-for-packet and register-for-register.
// --repeat N runs every program N times (fresh data memory each time) and reports host ns/cycle.
//
// --host-draw sets PS2X_VU1_HOST_DRAW=1 for this process (the native VU1 programs read it once),
// which makes them draw through GS::submitHostTriangle instead of kicking their GIF packets. With
// it on there are no packets to compare, so --verify then checks only end pc, VU data memory and
// (with --regs all) the register file.
//
// --vram-diff <outdir> renders every dump twice into a fresh 640x448 framebuffer - once through
// the GIF path, once through the host hook - and prints one VRAMDIFF line per dump. The score is
// `hard / drawn`: drawn = pixels either pass wrote, hard = differing pixels that are neither
// rounding nor a coverage difference. Each of those two by-design buckets has an opaque form and
// a form that only appears once the draw is blended or the seam is interior:
//   rounding - max channel delta <= 1 (one step of gouraud interpolation); and, when the dump's
//     draws set PRIM.ABE and both passes drew the pixel, max channel delta <= 2, because a blend
//     turns a one-step source difference into a two-step destination difference.
//   edge - a 3x3 neighbourhood that is not uniformly drawn in one of the two renderings, i.e.
//     where the host path's un-truncated 1/16-pixel coordinates put an edge the GIF path's
//     truncated ones do not; and, when both passes drew the pixel, an *interior* seam between two
//     adjacent triangles that sits one pixel over -- both sides drawn, so no coverage boundary --
//     recognised as each rendering's colour at the pixel appearing (within 2) on a drawn pixel of
//     the other rendering's eight neighbours. That last clause is BUDGETED at 1 % of drawn and
//     reported as seam=N: a real seam is a few pixels along one edge, whereas a uniform one-pixel
//     offset of the whole drawing satisfies it everywhere, so past the budget every pixel it
//     accepted goes back to hard and the line says OVER-BUDGET.
// It exits 1 if any dump exceeds --vram-tol (default 1.0 %). differing / rounding / edge
// and the whole-frame percentage are printed alongside as context: a frame-relative score cannot
// fail on dumps that paint a few hundred of 286720 pixels. A dump whose two passes both drew
// nothing prints `SKIP <name> (nothing drawn)` and does not count as a pass - two blank frames
// are identical for free - and the final PASS/FAIL line reports checked=N skipped=M.
// A run that ends with checked=0 FAILs and exits 1: nothing drew, so nothing was compared.
// Because the knob is a read-once static inside the native program, the two renderings run in two
// child processes (argv[0] re-executed with --vram-dump), which leave
// <outdir>/<dump>.{gif,host}.rgba behind.
#include <atomic>
#include <algorithm>
#include <chrono>
#include <fstream>
#include <map>
#include <sstream>
#include <thread>
#include <unordered_map>
#ifdef _WIN32
#include <windows.h>
#else
// Sprint 8 Goal 1 design item 3: the tool builds on Linux too; the --prof path has a POSIX half.
#include <cerrno>
#include <csignal>
#include <ctime>
#include <dlfcn.h>
#include <unistd.h>
#if defined(__linux__)
#include <sys/syscall.h>
#include <ucontext.h>
#endif

#endif

#ifndef _WIN32
#include <sys/stat.h>
#endif

namespace
{
    // Sprint 8 Goal 1 Task 6: the tool's two process-environment touches, one body per platform.
    void replaySetEnv(const char *pair)   // "NAME=value", the _putenv shape
    {
#ifdef _WIN32
        _putenv(pair);
#else
        const char *eq = std::strchr(pair, '=');
        if (eq == nullptr) { return; }
        const std::string name(pair, static_cast<size_t>(eq - pair));
        setenv(name.c_str(), eq + 1, 1);
#endif
    }

    void replayMakeDirectory(const std::string &path)
    {
#ifdef _WIN32
        CreateDirectoryA(path.c_str(), nullptr);
#else
        mkdir(path.c_str(), 0755);
#endif
    }
}
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <set>
#include <string>
#include <vector>

#define private public
#include "runtime/ps2_vu1.h"
#undef private
#include "runtime/gs/gs_frontend.h"
#include "runtime/ps2_memory.h"
#include "ps2x/knobs.h"
#include "../lib/vu/ps2_vu1_ops.h"   // S17 F C1: vu1ops::productSumZeroCounts
#include "runtime/vu1_native_refusals.h"   // S17 F: the native dispatcher's refusal totals

// g_ps2xTraceArmed (the interpreter's triggered program dump) is the runtime's own since Sprint 13 C8
// (runtime/ps2_trace_armed.h); never armed here.
extern uint32_t *g_vu1PcHist; // ps2_vu1_core.cpp: per-pair execution counts of the fast path
extern uint32_t *g_vu1JrHist; // computed-jump targets
extern uint32_t *g_vu1BailHist; // per-pc hand-backs of the generated code
extern uint64_t g_vu1GenEntered, g_vu1GenEnded, g_vu1GenSkipped;
int vu1GenerateKnownProgram(const uint8_t *code, uint64_t hash, const std::set<uint32_t> &seeds, const std::set<uint32_t> &unknownEntries, const std::string &outPath);

namespace
{
    struct Dump
    {
        std::string path;
        uint32_t hdr[4] = {0, 0, 0, 0};
        std::vector<uint8_t> code, data;
        int32_t vi[16] = {0};
        float vf[32][4] = {};
    };

    bool loadDump(const char *path, Dump &d)
    {
        FILE *fp = std::fopen(path, "rb");
        if (!fp)
        {
            std::fprintf(stderr, "cannot open %s\n", path);
            return false;
        }
        d.path = path;
        d.code.assign(0x4000, 0);
        d.data.assign(0x4000, 0);
        const bool ok = std::fread(d.hdr, sizeof(d.hdr), 1, fp) == 1 &&
                        std::fread(d.code.data(), 1, d.code.size(), fp) == d.code.size() &&
                        std::fread(d.data.data(), 1, d.data.size(), fp) == d.data.size() &&
                        std::fread(d.vi, sizeof(d.vi), 1, fp) == 1 &&
                        std::fread(d.vf, sizeof(d.vf), 1, fp) == 1;
        std::fclose(fp);
        if (!ok)
            std::fprintf(stderr, "short dump file %s\n", path);
        return ok;
    }

    uint64_t fnv1a(const uint8_t *p, size_t n, uint64_t h = 1469598103934665603ull)
    {
        for (size_t i = 0; i < n; ++i)
        {
            h ^= p[i];
            h *= 1099511628211ull;
        }
        return h;
    }

    std::string baseName(const std::string &path)
    {
        const size_t slash = path.find_last_of("/\\");
        std::string base = slash == std::string::npos ? path : path.substr(slash + 1);
        const size_t dot = base.find_last_of('.');
        if (dot != std::string::npos)
            base = base.substr(0, dot);
        return base;
    }

    std::string stateLine(const char *name, const VU1Interpreter &vu, uint32_t packetCount,
                          const std::vector<uint8_t> &packets, uint64_t cycles, const std::vector<uint8_t> &data)
    {
        const VU1State &s = vu.m_state;
        std::string out;
        char buf[128];
        auto add = [&](const char *fmt, auto... args) { std::snprintf(buf, sizeof(buf), fmt, args...); out += buf; };
        add("%s packets=%u bytes=%zu hash=%016llx cycles=%llu endpc=0x%x", name, packetCount, packets.size(),
            (unsigned long long)fnv1a(packets.data(), packets.size()), (unsigned long long)cycles, s.pc);
        add(" mac=%03x status=%03x clip=%06x r=%08x", s.mac, s.status, s.clip, s.r);
        uint32_t w = 0;
        std::memcpy(&w, &s.q, 4); add(" q=%08x", w);
        std::memcpy(&w, &s.p, 4); add(" p=%08x", w);
        std::memcpy(&w, &s.i, 4); add(" i=%08x", w);
        out += " vi=";
        for (int r = 0; r < 16; ++r) add("%s%04x", r ? "," : "", (unsigned)(s.vi[r] & 0xFFFF));
        out += " acc=";
        for (int c = 0; c < 4; ++c) { std::memcpy(&w, &s.acc[c], 4); add("%s%08x", c ? "," : "", w); }
        out += " vf=";
        for (int r = 0; r < 32; ++r)
            for (int c = 0; c < 4; ++c) { std::memcpy(&w, &s.vf[r][c], 4); add("%s%08x", (r || c) ? "," : "", w); }
        add(" data=%016llx\n", (unsigned long long)fnv1a(data.data(), data.size()));
        return out;
    }

    void printState(FILE *out, const char *name, const VU1Interpreter &vu, uint32_t packetCount,
                    const std::vector<uint8_t> &packets, uint64_t cycles, const std::vector<uint8_t> &data)
    {
        const std::string line = stateLine(name, vu, packetCount, packets, cycles, data);
        std::fputs(line.c_str(), out);
    }

    // "name k=v k=v ..." -> map; the first token is the dump name.
    std::map<std::string, std::string> parseStateLine(const std::string &line, std::string &name)
    {
        std::map<std::string, std::string> kv;
        std::istringstream in(line);
        in >> name;
        std::string tok;
        while (in >> tok)
        {
            const size_t eq = tok.find('=');
            if (eq != std::string::npos)
                kv[tok.substr(0, eq)] = tok.substr(eq + 1);
        }
        return kv;
    }

    std::map<std::string, std::map<std::string, std::string>> loadGolden(const char *path)
    {
        std::map<std::string, std::map<std::string, std::string>> golden;
        std::ifstream in(path);
        std::string line, name;
        while (std::getline(in, line))
        {
            if (line.empty()) continue;
            auto kv = parseStateLine(line, name);
            golden[name] = std::move(kv);
        }
        return golden;
    }

    // Returns the number of mismatching fields; prints one MISMATCH line per field.
    int compareState(const std::string &name, const std::map<std::string, std::string> &golden,
                     const std::map<std::string, std::string> &got, bool regs, bool packetFields)
    {
        std::vector<const char *> fields = {"endpc", "data"};
        if (packetFields)
            for (const char *f : {"packets", "bytes", "hash"})
                fields.push_back(f);
        if (regs)
            for (const char *f : {"vi", "vf", "acc", "q", "p", "i", "mac", "status", "clip", "r"})
                fields.push_back(f);
        int bad = 0;
        for (const char *f : fields)
        {
            const auto g = golden.find(f), o = got.find(f);
            const std::string gv = g == golden.end() ? "<missing>" : g->second;
            const std::string ov = o == got.end() ? "<missing>" : o->second;
            if (gv != ov)
            {
                ++bad;
                std::printf("MISMATCH %s %s golden=%s got=%s\n", name.c_str(), f, gv.c_str(), ov.c_str());
            }
        }
        return bad;
    }

    // ---- --vram-dump / --vram-diff ---------------------------------------------------------
    //
    // A VU1 dump carries no GS context: the FRAME/SCISSOR/XYOFFSET/TEX0 registers a UI list draws
    // against are written by the game over PATH3, long before the MSCAL. vu1_replay's GS has
    // therefore never seen one, and with an all-zero context every triangle would be scissored
    // away at (0,0). So both renderings get the same synthetic context below — a 640x448 PSMCT32
    // framebuffer at fbp 0, an XYOFFSET that centres it in the GS's 4096x4096 primitive space
    // (which is where these lists put their vertices), the z test forced to ALWAYS with z writes
    // masked, and a 1x1 0x80808080 texture parked outside the framebuffer so that the UI
    // lists' TME=1 MODULATE is the identity (their real textures are PATH3 uploads a dump does not
    // contain, and sampling the framebuffer itself would feed one triangle's pixels into the next).
    // It is the *same* state for both passes, which is all the comparison needs.
    //
    // Two of those synthetic choices are only enough for a list that never touches the GS context
    // itself. A family-C list does: 0x64 kicks the render-state packet at data qword 330 and
    // 0x30/0x32 kick an inline block, and in this corpus both are A+D writes to ALPHA_1, TEX1_1,
    // TEX0_1, TEST_1, CLAMP_1 (+ MIPTBP1_1). Two of those writes land on top of the synthetic
    // state:
    //
    //   * TEX0_1 stops pointing at the parked 1x1 texel and starts pointing at the game's own
    //     texture -- e.g. vu1dump4_prog_252's PSMT8 128x128 at TBP0 0x3d05 with its CLUT at CBP
    //     0x31c2, and TCC = 1 so the texture carries alpha. That upload is a PATH3 transfer the
    //     dump does not contain, so every texel index read back is 0 and the CLUT entry it selects
    //     is 0: the MODULATE gives RGBA (0,0,0,0), and the ALPHA_1 = 0x44 the same packet sets is
    //     (Cs - Cd) * As + Cd with As = 0, i.e. Cd. The framebuffer is left exactly as it was, so
    //     both passes read back a blank frame and the dump SKIPped for want of a drawn pixel.
    //     The fix is the same idea as the parked texel, applied to the whole of VRAM: every byte
    //     outside the framebuffer and the z buffer is 0x80, so whatever TEX0 an inline packet
    //     picks -- direct or through a CLUT, CT32 or PSMT8 -- samples a uniform neutral texel and
    //     the MODULATE stays the identity it already is for family A.
    //   * TEST_1 stops being ZTST = ALWAYS and becomes ZTE = 1, ZTST = GEQUAL. With the z buffer
    //     at ZBP 0 -- harmless while nothing ever tested z -- that reads the colours this frame
    //     just drew as depth. So the z buffer moves to its own pages directly above the frame and
    //     stays blank (ZMSK = 1 masks writes), which makes GEQUAL pass everywhere: the check
    //     measures where the two paths put pixels, not a z pipeline neither path implements.
    //
    // Both changes are context, not scoring: they are applied identically to the GIF pass and the
    // host pass, and they leave the family-A/B dumps' pixels bit-identical (their TEX0 is still
    // the parked texel and their TEST is still ALWAYS).
    constexpr uint32_t kFrameWidth = 640u;
    constexpr uint32_t kFrameHeight = 448u;
    constexpr uint32_t kFrameBufferWidth = kFrameWidth / 64u; // FRAME.FBW
    constexpr uint32_t kGsPageBytes = 8192u;                  // one GS page; the unit of FBP/ZBP
    // 640x448 PSMCT32 is 140 whole pages, so the frame is VRAM bytes [0, 1146880) and the z buffer
    // the next 140 pages above it, [1146880, 2293760).
    constexpr uint32_t kFrameBytes = kFrameWidth * kFrameHeight * 4u;
    constexpr uint32_t kFramePages = kFrameBytes / kGsPageBytes;
    constexpr uint32_t kZBufferPage = kFramePages;                    // ZBUF.ZBP
    constexpr uint32_t kBlankBytes = 2u * kFramePages * kGsPageBytes; // frame + z, kept at zero
    constexpr uint32_t kGsBlockBytes = 256u; // the unit of TEX0.TBP0 and TEX0.CBP
    // The parked texel, in blocks: 2.25 MB in, above both buffers. The relationship is the point,
    // not the number -- a parked texel inside the zeroed region would read 0 and every family-A
    // dump would go back to drawing nothing -- so assert it rather than leaving it to arithmetic
    // done once in a comment.
    constexpr uint32_t kTextureBlock = 0x2400u;
    static_assert(kTextureBlock * kGsBlockBytes >= kBlankBytes,
                  "the parked 1x1 texel must sit above the zeroed framebuffer and z buffer");
    constexpr uint8_t kNeutralTexelByte = 0x80u;

    // One dump's VRAM: the framebuffer and the z buffer blank, every other byte the neutral
    // 0x80808080 an unmapped texture fetch has to read for the MODULATE above to be the identity.
    void resetReplayVram(std::vector<uint8_t> &vram)
    {
        std::fill(vram.begin(), vram.end(), kNeutralTexelByte);
        const size_t blank = std::min<size_t>(vram.size(), kBlankBytes);
        std::fill(vram.begin(), vram.begin() + blank, static_cast<uint8_t>(0u));
    }

    // The neutral fill only helps a texture that lives ABOVE the zeroed region. Every family-C
    // TEX0 and CLUT in today's three dump sets does (3.2-4.0 MB, against a blank region that ends
    // at 2293760), but that is a property of the corpus, not of the design: a dump whose texture
    // fell inside the framebuffer or the z buffer would sample 0 again and silently go back to
    // `SKIP (nothing drawn)` with nothing to say why. So every kicked packet's A+D writes to
    // TEX0_1/TEX0_2 are checked, and the first offender in a dump says so on stderr. A warning,
    // not a failure: the replay framebuffer's address is this tool's choice to change, and the
    // checked=0 FAIL rule is still the backstop if it ever costs the run its last drawn pixel.
    void warnIfTextureInBlankRegion(const uint8_t *packet, uint32_t bytes, const std::string &dump,
                                    bool &warned)
    {
        if (warned || bytes < 16u)
            return;
        uint64_t tagLo = 0u, tagHi = 0u;
        std::memcpy(&tagLo, packet, sizeof(tagLo));
        std::memcpy(&tagHi, packet + 8, sizeof(tagHi));
        if (((tagLo >> 58) & 3u) != 0u) // FLG: only PACKED carries A+D descriptors
            return;
        const uint64_t nloop = tagLo & 0x7FFFu;
        uint64_t nreg = (tagLo >> 60) & 0xFu;
        if (nreg == 0u)
            nreg = 16u; // the GIF reads NREG = 0 as sixteen registers
        const uint64_t qwords = nloop * nreg;
        if ((qwords + 1u) * 16u > bytes) // truncated or not the shape the tag claims: not ours
            return;
        for (uint64_t i = 0; i < qwords; ++i)
        {
            if (((tagHi >> (4u * (i % nreg))) & 0xFu) != 0x0Eu) // A+D
                continue;
            uint64_t value = 0u, addr = 0u;
            std::memcpy(&value, packet + (i + 1u) * 16u, sizeof(value));
            std::memcpy(&addr, packet + (i + 1u) * 16u + 8, sizeof(addr));
            const uint8_t reg = static_cast<uint8_t>(addr & 0xFFu);
            if (reg != GS_REG_TEX0_1 && reg != GS_REG_TEX0_2)
                continue;
            const uint32_t tbp0 = static_cast<uint32_t>(value & 0x3FFFu);        // TEX0.TBP0
            const uint32_t cbp = static_cast<uint32_t>((value >> 37) & 0x3FFFu); // TEX0.CBP
            const bool loadsClut = ((value >> 61) & 0x7u) != 0u;                 // TEX0.CLD
            const bool textureLow = tbp0 * kGsBlockBytes < kBlankBytes;
            const bool clutLow = loadsClut && cbp * kGsBlockBytes < kBlankBytes;
            if (!textureLow && !clutLow)
                continue;
            std::fprintf(stderr,
                         "[vu1_replay] WARNING %s: a kicked GIF packet points TEX0 at %s inside "
                         "the zeroed framebuffer/z region (TBP0 0x%04x, CBP 0x%04x; the neutral "
                         "fill starts at byte %u). It will sample 0, so this dump can draw "
                         "nothing and SKIP -- move the replay framebuffer/z buffer rather than "
                         "ignoring this.\n",
                         dump.c_str(), textureLow ? "a texture" : "a CLUT", tbp0, cbp, kBlankBytes);
            warned = true;
            return;
        }
    }

    // Does a kicked GIF packet turn alpha blending on? The bit is PRIM.ABE (bit 6), which reaches
    // the GS two ways: the GIFtag's own PRIM field (bits 47-57) when PRE (bit 46) is set -- how
    // every triangle in this corpus sets it -- or an A+D descriptor writing the PRIM register.
    // Walks the tag chain; anything whose payload does not fit the bytes the tag claims ends the
    // walk rather than guessing (the answer is then "no blending seen", which only ever narrows
    // the by-design buckets).
    bool gifPacketEnablesBlend(const uint8_t *packet, uint32_t bytes)
    {
        uint32_t offset = 0u;
        while (offset + 16u <= bytes)
        {
            uint64_t tagLo = 0u, tagHi = 0u;
            std::memcpy(&tagLo, packet + offset, sizeof(tagLo));
            std::memcpy(&tagHi, packet + offset + 8, sizeof(tagHi));
            const uint64_t nloop = tagLo & 0x7FFFu;
            const uint64_t flg = (tagLo >> 58) & 3u;
            uint64_t nreg = (tagLo >> 60) & 0xFu;
            if (nreg == 0u)
                nreg = 16u; // the GIF reads NREG = 0 as sixteen registers
            uint64_t payload = 0u;
            if (flg == 0u)
                payload = nloop * nreg * 16u; // PACKED: one qword per register per loop
            else if (flg == 1u)
                payload = (nloop * nreg * 8u + 15u) & ~static_cast<uint64_t>(15u); // REGLIST
            else
                payload = nloop * 16u; // IMAGE / disabled: nloop qwords of data
            // The fit check comes FIRST, before any field of this tag is believed: a truncated or
            // misaligned tag's bits are garbage, and believing its PRE/PRIM would set abe = 1,
            // which WIDENS the buckets. Nothing here may guess in the loosening direction.
            if (static_cast<uint64_t>(offset) + 16u + payload > bytes)
                return false;
            const bool pre = ((tagLo >> 46) & 1u) != 0u;
            const uint64_t prim = (tagLo >> 47) & 0x7FFu;
            if (pre && ((prim >> 6) & 1u) != 0u)
                return true;
            if (flg == 0u)
            {
                for (uint64_t i = 0; i < nloop * nreg; ++i)
                {
                    if (((tagHi >> (4u * (i % nreg))) & 0xFu) != 0x0Eu) // A+D
                        continue;
                    uint64_t value = 0u, addr = 0u;
                    const uint8_t *qword = packet + offset + 16u + i * 16u;
                    std::memcpy(&value, qword, sizeof(value));
                    std::memcpy(&addr, qword + 8, sizeof(addr));
                    if (static_cast<uint8_t>(addr & 0xFFu) == GS_REG_PRIM && ((value >> 6) & 1u) != 0u)
                        return true;
                }
            }
            offset += static_cast<uint32_t>(16u + payload);
        }
        return false;
    }

    void setupReplayGsContext(GS &gs)
    {
        const uint64_t frame = (static_cast<uint64_t>(kFrameBufferWidth) << 16) |
                               (static_cast<uint64_t>(GS_PSM_CT32) << 24);
        // ZBP in pages, PSM 0 = PSMZ32, ZMSK: no z writes.
        const uint64_t zbuf = static_cast<uint64_t>(kZBufferPage) | (1ull << 32);
        const uint64_t scissor = (static_cast<uint64_t>(kFrameWidth - 1u) << 16) |
                                 (static_cast<uint64_t>(kFrameHeight - 1u) << 48);
        const uint64_t xyoffset = static_cast<uint64_t>((2048u - kFrameWidth / 2u) * 16u) |
                                  (static_cast<uint64_t>((2048u - kFrameHeight / 2u) * 16u) << 32);
        const uint64_t test = 0x30000ull; // ZTE = 1, ZTST = ALWAYS
        const uint64_t tex0 = static_cast<uint64_t>(kTextureBlock) | (1ull << 14) |
                              (static_cast<uint64_t>(GS_PSM_CT32) << 20); // 1x1, TCC = RGB, MODULATE
        for (uint8_t context = 0; context < 2u; ++context)
        {
            // The _2 register of every pair is the _1 register plus one.
            gs.writeRegister(static_cast<uint8_t>(GS_REG_FRAME_1 + context), frame);
            gs.writeRegister(static_cast<uint8_t>(GS_REG_ZBUF_1 + context), zbuf);
            gs.writeRegister(static_cast<uint8_t>(GS_REG_SCISSOR_1 + context), scissor);
            gs.writeRegister(static_cast<uint8_t>(GS_REG_XYOFFSET_1 + context), xyoffset);
            gs.writeRegister(static_cast<uint8_t>(GS_REG_TEST_1 + context), test);
            gs.writeRegister(static_cast<uint8_t>(GS_REG_TEX0_1 + context), tex0);
        }
        gs.WriteVram(GS_PSM_CT32, kTextureBlock, 1u, 0u, 0u, 0x80808080u);
    }

    // The framebuffer as a linear RGBA8888 image (PSMCT32 is swizzled in VRAM; ReadVram undoes it).
    std::vector<uint8_t> readFrameRgba(const GS &gs)
    {
        std::vector<uint8_t> frame(static_cast<size_t>(kFrameWidth) * kFrameHeight * 4u, 0u);
        for (uint32_t y = 0; y < kFrameHeight; ++y)
            for (uint32_t x = 0; x < kFrameWidth; ++x)
            {
                const uint32_t pixel = gs.ReadVram(GS_PSM_CT32, 0u, kFrameBufferWidth, x, y);
                std::memcpy(frame.data() + (static_cast<size_t>(y) * kFrameWidth + x) * 4u, &pixel, 4);
            }
        return frame;
    }

    bool writeFile(const std::string &path, const std::vector<uint8_t> &bytes)
    {
        FILE *fp = std::fopen(path.c_str(), "wb");
        if (!fp)
            return false;
        const bool ok = std::fwrite(bytes.data(), 1, bytes.size(), fp) == bytes.size();
        std::fclose(fp);
        return ok;
    }

    bool readFile(const std::string &path, std::vector<uint8_t> &bytes)
    {
        FILE *fp = std::fopen(path.c_str(), "rb");
        if (!fp)
            return false;
        std::fseek(fp, 0, SEEK_END);
        const long size = std::ftell(fp);
        std::fseek(fp, 0, SEEK_SET);
        bytes.assign(size > 0 ? static_cast<size_t>(size) : 0u, 0u);
        const bool ok = size > 0 && std::fread(bytes.data(), 1, bytes.size(), fp) == bytes.size();
        std::fclose(fp);
        return ok;
    }

    std::string vramDumpPath(const std::string &dir, const std::string &dumpPath, bool hostDraw)
    {
        return dir + "/" + baseName(dumpPath) + (hostDraw ? ".host.rgba" : ".gif.rgba");
    }

    // The two renderings happen in child processes that hand back nothing but a framebuffer, and
    // one of the buckets below needs to know something about how that framebuffer was drawn:
    // whether the dump's draws had alpha blending on. Each child writes it next to its .rgba.
    std::string vramMetaPath(const std::string &dir, const std::string &dumpPath, bool hostDraw)
    {
        return dir + "/" + baseName(dumpPath) + (hostDraw ? ".host.meta" : ".gif.meta");
    }

    // Missing or unreadable reads as "no blending", which only ever narrows the by-design buckets.
    bool readBlendFlag(const std::string &path)
    {
        std::vector<uint8_t> bytes;
        if (!readFile(path, bytes))
            return false;
        const std::string text(bytes.begin(), bytes.end());
        return text.find("abe=1") != std::string::npos;
    }

    // PS2X_VU1_HOST_DRAW is read once into a static inside the native program, so one process can
    // only ever render one of the two ways: re-run this executable with the same arguments (minus
    // --vram-diff) plus --vram-dump, once without and once with --host-draw, then compare.
    int runVramDiff(int argc, char **argv, const std::string &outDir, double tolerancePct,
                    const std::vector<std::string> &inputs)
    {
        replayMakeDirectory(outDir);

        // A child pass that dies before it writes its dump must not be scored against the
        // artefact a previous invocation left in outDir: clear both expected paths up front.
        for (const std::string &input : inputs)
        {
            std::remove(vramDumpPath(outDir, input, false).c_str());
            std::remove(vramDumpPath(outDir, input, true).c_str());
            std::remove(vramMetaPath(outDir, input, false).c_str());
            std::remove(vramMetaPath(outDir, input, true).c_str());
        }

        for (int pass = 0; pass < 2; ++pass)
        {
            const bool hostDraw = pass == 1;
            std::string command = "\"" + std::string(argv[0]) + "\"";
            for (int i = 1; i < argc; ++i)
            {
                if (!std::strcmp(argv[i], "--vram-diff") || !std::strcmp(argv[i], "--vram-tol"))
                {
                    ++i; // and its value
                    continue;
                }
                if (!std::strcmp(argv[i], "--host-draw"))
                    continue;
                command += " \"" + std::string(argv[i]) + "\"";
            }
            command += " --vram-dump \"" + outDir + "\"";
            if (hostDraw)
                command += " --host-draw";
            // cmd.exe strips one layer of quotes from the whole command line.
            const int rc = std::system(("\"" + command + "\"").c_str());
            if (rc != 0)
            {
                std::fprintf(stderr, "--vram-diff: %s pass failed (%d): %s\n",
                             hostDraw ? "host" : "gif", rc, command.c_str());
                return 1;
            }
        }

        bool failed = false;
        size_t checked = 0, skipped = 0;
        for (const std::string &input : inputs)
        {
            const std::string name = baseName(input);
            std::vector<uint8_t> gif, host;
            if (!readFile(vramDumpPath(outDir, input, false), gif) ||
                !readFile(vramDumpPath(outDir, input, true), host) ||
                gif.size() != host.size() || gif.empty())
            {
                std::printf("VRAMDIFF %s missing or mismatched frame dumps\n", name.c_str());
                failed = true;
                continue;
            }
            // Both children write one; only the GIF pass sees the triangle packets (the host pass
            // draws them through the hook instead of kicking them), so the two are OR'd rather
            // than required to agree.
            const bool blendEnabled = readBlendFlag(vramMetaPath(outDir, input, false)) ||
                                      readBlendFlag(vramMetaPath(outDir, input, true));
            const size_t pixels = gif.size() / 4u;
            if (pixels != static_cast<size_t>(kFrameWidth) * kFrameHeight)
            {
                std::printf("VRAMDIFF %s unexpected dump size (%zu pixels)\n", name.c_str(), pixels);
                failed = true;
                continue;
            }
            // Per-pixel "did this pass write here?" masks, so a differing pixel can be told apart
            // from one that exists in only one of the two renderings.
            std::vector<uint8_t> drawnGif(pixels, 0u), drawnHost(pixels, 0u);
            size_t differing = 0, drawn = 0;
            for (size_t p = 0; p < pixels; ++p)
            {
                uint32_t a = 0, b = 0;
                std::memcpy(&a, gif.data() + p * 4u, 4);
                std::memcpy(&b, host.data() + p * 4u, 4);
                drawnGif[p] = a != 0u;
                drawnHost[p] = b != 0u;
                if (a != b)
                    ++differing;
                if (a != 0u || b != 0u)
                    ++drawn;
            }
            // drawn = pixels either pass wrote. Two blank frames are trivially identical, so a dump
            // that draws nothing is not evidence that the host path matches the GIF path: report it
            // as SKIP and leave it out of the count the PASS line stands on.
            if (drawn == 0)
            {
                std::printf("SKIP %s (nothing drawn)\n", name.c_str());
                ++skipped;
                continue;
            }

            // A pixel sits on a coverage boundary when its 3x3 neighbourhood is not uniformly
            // drawn (nor uniformly undrawn) in one of the two renderings: that is where the host
            // path's un-truncated 1/16-pixel vertex coordinates put a triangle edge somewhere the
            // GIF path's truncated ones do not, so the two rasterisers legitimately disagree about
            // whether the pixel is covered at all.
            auto boundaryAt = [&](const std::vector<uint8_t> &mask, size_t x, size_t y) {
                bool anySet = false, allSet = true;
                for (int dy = -1; dy <= 1; ++dy)
                    for (int dx = -1; dx <= 1; ++dx)
                    {
                        const long nx = static_cast<long>(x) + dx;
                        const long ny = static_cast<long>(y) + dy;
                        const bool set = nx >= 0 && ny >= 0 && nx < static_cast<long>(kFrameWidth) &&
                                         ny < static_cast<long>(kFrameHeight) &&
                                         mask[static_cast<size_t>(ny) * kFrameWidth + static_cast<size_t>(nx)] != 0u;
                        anySet |= set;
                        allSet &= set;
                    }
                return anySet && !allSet;
            };

            // The other half of the coverage story. A colour seam between two adjacent triangles
            // can sit one pixel over while BOTH sides are drawn: the 3x3 is uniformly drawn, so
            // boundaryAt never fires, yet the difference is the same sub-pixel coverage effect --
            // the host path's un-truncated vertex puts the seam one pixel from where the GIF
            // path's truncated one does. The signature is that the colour each rendering has at
            // the pixel is a colour the other rendering has right next to it. Tolerance 2, not an
            // exact match, because the two sides of the seam are themselves gouraud-interpolated
            // and blended, so the neighbour that carries the colour carries it a step or two off.
            // The centre is deliberately excluded: including it would match host[p] against gif[p]
            // and silently turn this into "delta <= 2 is always fine", which is exactly the
            // blanket pass the blend widening above is gated on ABE to avoid. The neighbour must
            // itself be drawn, so an undrawn (zero) neighbour cannot stand in for a dark colour.
            // Both directions are required, not either: a seam that moved one pixel swaps the two
            // sides' colours, so each rendering's colour is next door in the other. Measured on
            // every hard pixel of prog_11/177/182 -- all of them satisfy both directions -- and
            // the one-directional form scores materially worse on the +8 px sanity experiment.
            constexpr int kSeamTolerance = 2;
            auto colourNearby = [&](const std::vector<uint8_t> &src, const std::vector<uint8_t> &other,
                                    const std::vector<uint8_t> &drawnOther, size_t x, size_t y) {
                const size_t p = y * kFrameWidth + x;
                for (int dy = -1; dy <= 1; ++dy)
                    for (int dx = -1; dx <= 1; ++dx)
                    {
                        if (dx == 0 && dy == 0)
                            continue;
                        const long nx = static_cast<long>(x) + dx;
                        const long ny = static_cast<long>(y) + dy;
                        if (nx < 0 || ny < 0 || nx >= static_cast<long>(kFrameWidth) ||
                            ny >= static_cast<long>(kFrameHeight))
                            continue;
                        const size_t q = static_cast<size_t>(ny) * kFrameWidth + static_cast<size_t>(nx);
                        if (!drawnOther[q])
                            continue;
                        int d = 0;
                        for (int c = 0; c < 4; ++c)
                            d = std::max(d, std::abs(static_cast<int>(src[p * 4u + c]) -
                                                     static_cast<int>(other[q * 4u + c])));
                        if (d <= kSeamTolerance)
                            return true;
                    }
                return false;
            };

            // The seam clause is the loosest rule here, and measurably so: it is what makes a
            // UNIFORM one-pixel screen-space offset invisible, because every pixel of a rigidly
            // shifted drawing finds its own colour one pixel over in both directions. A real
            // interior seam is a handful of pixels along one edge; a systematic offset -- a wrong
            // XYOFFSET constant, an off-by-one in the >>4 truncation, a wrong lane feeding x --
            // moves the whole drawing. So the clause gets a budget: on the fixture set it accepts
            // 0 pixels on twelve dumps and 0.12 / 0.24 / 0.50 % of drawn on prog_11 / prog_177 /
            // prog_182, while a +-1 px shift needs 1.44-11.65 %. Above the budget every
            // seam-accepted pixel goes back to hard, which is what keeps the check able to fail on
            // a one-pixel offset. seam= on the VRAMDIFF line reports the usage either way, so the
            // rule can never quietly carry a dump.
            constexpr double kSeamBudgetPct = 1.0;

            // Split the differing pixels into the two kinds the two paths produce by design and the
            // remainder, which is the only kind a wrong lane or a wrong context shows up as.
            size_t rounding = 0, edge = 0, seam = 0, hard = 0;
            for (size_t y = 0; y < kFrameHeight; ++y)
                for (size_t x = 0; x < kFrameWidth; ++x)
                {
                    const size_t p = y * kFrameWidth + x;
                    int delta = 0;
                    for (int c = 0; c < 4; ++c)
                        delta = std::max(delta, std::abs(static_cast<int>(gif[p * 4u + c]) -
                                                         static_cast<int>(host[p * 4u + c])));
                    if (delta == 0)
                        continue;
                    if (delta <= 1)
                        ++rounding;   // gouraud interpolation rounding: one step in one channel
                    // With ABE = 1 the one step above comes out of the blend as two: the measured
                    // cases are alpha 127 on one side and 128 on the other. Gated on the dump
                    // actually blending, because on an opaque draw a delta of 2 is a real
                    // difference, and on both passes having drawn the pixel, because a step
                    // against a pixel only one pass wrote is not rounding at all.
                    else if (delta <= 2 && blendEnabled && drawnGif[p] && drawnHost[p])
                        ++rounding;
                    else if (boundaryAt(drawnGif, x, y) || boundaryAt(drawnHost, x, y))
                        ++edge;       // sub-pixel coverage difference at a triangle edge
                    else if (drawnGif[p] && drawnHost[p] &&
                             colourNearby(gif, host, drawnHost, x, y) &&
                             colourNearby(host, gif, drawnGif, x, y))
                        ++seam;       // the same coverage difference at an interior seam
                    else
                        ++hard;
                }

            // Over budget, the seam clause is not describing a seam any more: it is describing a
            // drawing that moved. Everything it accepted goes back to hard.
            const bool seamOverBudget =
                static_cast<double>(seam) * 100.0 > kSeamBudgetPct * static_cast<double>(drawn);
            if (seamOverBudget)
                hard += seam;
            else
                edge += seam;

            // The score is hard / drawn, not differing / whole frame: these dumps paint a few
            // hundred pixels of a 286720-pixel frame, so a frame-relative percentage cannot reach
            // 1% even when every drawn pixel is wrong. The frame percentage is printed as context.
            const double pct = 100.0 * static_cast<double>(hard) / static_cast<double>(drawn);
            const double framePct = 100.0 * static_cast<double>(differing) / static_cast<double>(pixels);
            std::printf("VRAMDIFF %s hard=%zu of drawn=%zu (%.3f%%) [differing=%zu: rounding=%zu "
                        "edge=%zu seam=%zu%s hard=%zu; %.4f%% of the %zu-pixel frame; abe=%d]\n",
                        name.c_str(), hard, drawn, pct, differing, rounding, edge, seam,
                        seamOverBudget ? " OVER-BUDGET(->hard)" : "", hard, framePct,
                        pixels, blendEnabled ? 1 : 0);
            ++checked;
            if (pct > tolerancePct)
                failed = true;
        }
        // Every dump skipped is not a pass, it is the blank-frame regression this accounting was
        // added to catch: nothing drew, so nothing was compared, so the run proves nothing.
        if (checked == 0)
        {
            std::printf("FAIL: vram diff compared nothing -- all %zu dump(s) drew no pixels on "
                        "either path\n", skipped);
            return 1;
        }
        std::printf("%s: vram diff against %.2f%% tolerance, checked=%zu skipped=%zu\n",
                    failed ? "FAIL" : "PASS", tolerancePct, checked, skipped);
        return failed ? 1 : 0;
    }
}

#if defined(__linux__) && defined(__x86_64__)
namespace
{
    // Sprint 8 Goal 1 design item 3: the POSIX side of --prof (see the block in main()). The signal
    // handler may not touch the map, so it publishes into a ring the helper thread drains.
    constexpr uint32_t kProfRing = 8192u;   // power of two
    std::atomic<uint64_t> g_profRing[kProfRing];
    std::atomic<uint64_t> g_profWrite{0};
    uint64_t g_profRead = 0;   // the helper thread alone

    void hostProfSignalHandler(int, siginfo_t *, void *ctx)
    {
        if (!ctx)
            return;
        const uint64_t rip =
            static_cast<uint64_t>(reinterpret_cast<const ucontext_t *>(ctx)->uc_mcontext.gregs[REG_RIP]);
        if (!rip)
            return;
        const uint64_t slot = g_profWrite.fetch_add(1, std::memory_order_relaxed);
        g_profRing[slot & (kProfRing - 1u)].store(rip, std::memory_order_release);
    }

    bool hostProfInstallSignal()
    {
        struct sigaction sa;
        std::memset(&sa, 0, sizeof(sa));
        sa.sa_sigaction = hostProfSignalHandler;
        sa.sa_flags = SA_SIGINFO | SA_RESTART;
        sigemptyset(&sa.sa_mask);
        return ::sigaction(SIGPROF, &sa, nullptr) == 0;
    }

    bool hostProfArmTimer(int tid, double periodMs)
    {
        struct sigevent sev;
        std::memset(&sev, 0, sizeof(sev));
        sev.sigev_notify = SIGEV_THREAD_ID;
        sev.sigev_signo = SIGPROF;
#if defined(sigev_notify_thread_id)
        sev.sigev_notify_thread_id = tid;
#else
        sev._sigev_un._tid = tid;
#endif
        timer_t timer{};
        if (::timer_create(CLOCK_MONOTONIC, &sev, &timer) != 0)
            return false;
        struct itimerspec its;
        std::memset(&its, 0, sizeof(its));
        const long long ns = static_cast<long long>(periodMs * 1e6);
        its.it_interval.tv_sec = static_cast<time_t>(ns / 1000000000LL);
        its.it_interval.tv_nsec = static_cast<long>(ns % 1000000000LL);
        its.it_value = its.it_interval;
        if (::timer_settime(timer, 0, &its, nullptr) != 0)
        {
            ::timer_delete(timer);
            return false;
        }
        return true;   // the timer lives for the run, like the duplicated handle on Windows
    }

    uint64_t hostProfSelfBase()
    {
        Dl_info dli;
        if (::dladdr(reinterpret_cast<void *>(&hostProfSelfBase), &dli) && dli.dli_fbase)
            return reinterpret_cast<uint64_t>(dli.dli_fbase);
        return 0;
    }

    std::string hostProfSelfExe()
    {
        char buf[4096];
        const ssize_t n = ::readlink("/proc/self/exe", buf, sizeof(buf) - 1);
        if (n <= 0)
            return "?";
        buf[n] = '\0';
        return std::string(buf);
    }

    uint64_t hostProfDrain(std::unordered_map<uint64_t, uint32_t> &counts)
    {
        const uint64_t head = g_profWrite.load(std::memory_order_acquire);
        if (head - g_profRead > kProfRing)
            g_profRead = head - kProfRing;
        uint64_t n = 0;
        for (; g_profRead < head; ++g_profRead)
        {
            std::atomic<uint64_t> &slot = g_profRing[g_profRead & (kProfRing - 1u)];
            const uint64_t rip = slot.load(std::memory_order_acquire);
            if (!rip)
                continue;
            ++counts[rip];
            slot.store(0, std::memory_order_relaxed);
            ++n;
        }
        return n;
    }
}
#endif

int main(int argc, char **argv)
{
    ps2x::knobs::setDevMode(true);   // the tool steers the runtime through Dev knobs (replaySetEnv)
    if (argc < 2)
    {
        std::fprintf(stderr, "usage: vu1_replay <dump.bin> [--out packets.bin] [--trace] [--state]\n"
                             "       vu1_replay --batch <outdir> [--repeat N] [--state] <dump.bin>...\n"
                             "       vu1_replay --verify <golden.txt> [--regs all|none] [--native|--no-native] [--host-draw] <dump.bin>...\n"
                             "       vu1_replay --vram-diff <outdir> [--vram-tol pct] <dump.bin>...\n");
        return 2;
    }
    std::string outPath = "vu1_packets.bin";
    std::string batchDir;
    std::string verifyPath;
    bool verifyRegs = true;
    std::string profPath;
    std::string genPath;
    std::string pcHistPath;
    std::string seedsPath; // --seeds <file>: extra pcs (hex, one per line; in-game [vu1-bail] pcs) as unknown entries
    bool bailHist = false;
    bool trace = false;
    bool printStateFlag = false;
    bool hostDraw = false;
    std::string vramDiffDir;
    std::string vramDumpDir;
    double vramTolerancePct = 1.0;
    int repeat = 1;
    std::vector<std::string> inputs;
    for (int i = 1; i < argc; ++i)
    {
        if (!std::strcmp(argv[i], "--out") && i + 1 < argc)
            outPath = argv[++i];
        else if (!std::strcmp(argv[i], "--batch") && i + 1 < argc)
            batchDir = argv[++i];
        else if (!std::strcmp(argv[i], "--repeat") && i + 1 < argc)
            repeat = std::atoi(argv[++i]);
        else if (!std::strcmp(argv[i], "--prof") && i + 1 < argc)
            profPath = argv[++i];
        else if (!std::strcmp(argv[i], "--gen") && i + 1 < argc)
            genPath = argv[++i];
        else if (!std::strcmp(argv[i], "--pchist") && i + 1 < argc)
            pcHistPath = argv[++i];
        else if (!std::strcmp(argv[i], "--bailhist"))
            bailHist = true;
        else if (!std::strcmp(argv[i], "--seeds") && i + 1 < argc)
            seedsPath = argv[++i];
        else if (!std::strcmp(argv[i], "--trace"))
            trace = true;
        else if (!std::strcmp(argv[i], "--state"))
            printStateFlag = true;
        else if (!std::strcmp(argv[i], "--verify") && i + 1 < argc)
            verifyPath = argv[++i];
        else if (!std::strcmp(argv[i], "--regs") && i + 1 < argc)
        {
            // Only two spellings, and a typo must not silently select "all": every other value
            // used to compare unequal to "none" and turn the register check ON, so `--regs non`
            // and `--regs off` read as `--regs all`.
            const char *mode = argv[++i];
            if (!std::strcmp(mode, "all"))
                verifyRegs = true;
            else if (!std::strcmp(mode, "none"))
                verifyRegs = false;
            else
            {
                std::fprintf(stderr, "--regs takes all|none, not \"%s\"\n", mode);
                return 2;
            }
        }
        else if (!std::strcmp(argv[i], "--host-draw"))
            hostDraw = true;
        else if (!std::strcmp(argv[i], "--vram-diff") && i + 1 < argc)
            vramDiffDir = argv[++i];
        else if (!std::strcmp(argv[i], "--vram-dump") && i + 1 < argc)
            vramDumpDir = argv[++i];
        else if (!std::strcmp(argv[i], "--vram-tol") && i + 1 < argc)
            vramTolerancePct = std::atof(argv[++i]);
        else if (!std::strcmp(argv[i], "--native"))
            replaySetEnv("PS2X_VU1_NATIVE=1");
        else if (!std::strcmp(argv[i], "--no-native"))
            replaySetEnv("PS2X_VU1_NATIVE=0");
        else
            inputs.push_back(argv[i]);
    }
    if (inputs.empty())
    {
        std::fprintf(stderr, "no dump given\n");
        return 2;
    }
    if (repeat < 1)
        repeat = 1;

    if (!vramDiffDir.empty())
        return runVramDiff(argc, argv, vramDiffDir, vramTolerancePct, inputs);

    // Always explicit, so a stale PS2X_VU1_HOST_DRAW in the environment cannot decide which path a
    // run takes (and so the --vram-diff children do not inherit their parent's setting).
    replaySetEnv(hostDraw ? "PS2X_VU1_HOST_DRAW=1" : "PS2X_VU1_HOST_DRAW=0");
    replaySetEnv("PS2X_GS_BACKEND=cpu");
    if (trace)
        replaySetEnv("PS2X_TRACE_VU=0");
    // The generator needs the interpreter's own execution profile (the generated code keeps none).
    std::vector<uint32_t> bails;
    if (bailHist)
    {
        bails.assign(2048, 0u);
        g_vu1BailHist = bails.data();
    }
    std::vector<uint32_t> pcHist, jrHist;
    if (!genPath.empty() || !pcHistPath.empty())
    {
        replaySetEnv("PS2X_VU1_GEN=0");
        replaySetEnv("PS2X_VU1_FAST=1");
        pcHist.assign(2048, 0u);
        g_vu1PcHist = pcHist.data();
        jrHist.assign(2048, 0u);
        g_vu1JrHist = jrHist.data();
    }

    std::map<std::string, std::map<std::string, std::string>> golden;
    int mismatches = 0;
    if (!verifyPath.empty())
    {
        golden = loadGolden(verifyPath.c_str());
        if (golden.empty())
        {
            std::fprintf(stderr, "--verify: no lines read from %s\n", verifyPath.c_str());
            return 2;
        }
        if (hostDraw)
            std::printf("[vu1_replay] --host-draw: comparing end pc, VU data memory%s "
                        "(the packets are drawn through the host hook, not kicked)\n",
                        verifyRegs ? " and the register file" : "");
    }

    GS gs;
    PS2Memory memory;
    // The program runs from the memory object's own VU1 buffers so the interpreter's decoded-code
    // cache applies exactly as in the game (a foreign code pointer is decoded pair by pair).
    if (!memory.initialize())
    {
        std::fprintf(stderr, "PS2Memory::initialize failed\n");
        return 1;
    }
    // --vram-dump: give the GS somewhere to draw. Outside that mode nothing rasterises — the GS
    // here has no VRAM and the GIF packets only ever reach the callback below.
    std::vector<uint8_t> vram;
    const bool renderToVram = !vramDumpDir.empty();
    if (renderToVram)
    {
        vram.assign(PS2_GS_VRAM_SIZE, 0u);
        gs.init(vram.data(), static_cast<uint32_t>(vram.size()), nullptr);
    }

    std::vector<uint8_t> packets;
    uint32_t packetCount = 0;
    // Set per dump, for warnIfTextureInBlankRegion's message and its once-per-dump latch.
    std::string currentDump;
    bool warnedTextureInBlankRegion = false;
    // Set by the packet callback, reset per dump, written next to the .rgba for --vram-diff.
    bool blendSeenThisDump = false;
    memory.setGifPacketCallback([&](const uint8_t *p, uint32_t n) {
        const uint32_t len = n;
        packets.insert(packets.end(), reinterpret_cast<const uint8_t *>(&len), reinterpret_cast<const uint8_t *>(&len) + 4);
        packets.insert(packets.end(), p, p + n);
        ++packetCount;
        // Kicked packets have to reach the GS too, or the GIF pass of --vram-diff would draw
        // nothing and the host pass would be compared against a blank frame.
        if (renderToVram)
        {
            warnIfTextureInBlankRegion(p, n, currentDump, warnedTextureInBlankRegion);
            blendSeenThisDump |= gifPacketEnablesBlend(p, n);
            gs.processGIFPacket(p, n);
        }
    });

    VU1Interpreter vu(VU1Interpreter::Unit::VU1);
    FILE *stateOut = nullptr;
    if (!batchDir.empty())
    {
        const std::string statePath = batchDir + "/state.txt";
        stateOut = std::fopen(statePath.c_str(), "w");
        if (!stateOut)
        {
            std::fprintf(stderr, "cannot write %s\n", statePath.c_str());
            return 1;
        }
    }

    // --prof <file>: sample this thread's instruction pointer every 0.2 ms from a helper thread and
    // write a PS2X_HOST_PROF-style histogram (symbolize with tools_py/hostprof_symbolize.py --exe).
    std::atomic<bool> profStop{false};
    std::thread profThread;
    if (!profPath.empty())
    {
#ifdef _WIN32
        HANDLE dup = nullptr;
        DuplicateHandle(GetCurrentProcess(), GetCurrentThread(), GetCurrentProcess(), &dup,
                        THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION, FALSE, 0);
        const uint64_t base = reinterpret_cast<uint64_t>(GetModuleHandleW(nullptr));
        profThread = std::thread([dup, base, profPath, &profStop]() {
            std::unordered_map<uint64_t, uint32_t> counts;
            uint64_t total = 0;
            while (!profStop.load())
            {
                // Sleep granularity on Windows is ~15 ms: spin (yielding) for the sample period.
                const auto until = std::chrono::steady_clock::now() + std::chrono::microseconds(100);
                while (std::chrono::steady_clock::now() < until)
                    std::this_thread::yield();
                if (SuspendThread(dup) == static_cast<DWORD>(-1))
                    continue;
                CONTEXT c;
                std::memset(&c, 0, sizeof(c));
                c.ContextFlags = CONTEXT_CONTROL;
                uint64_t rip = GetThreadContext(dup, &c) ? c.Rip : 0;
                ResumeThread(dup);
                if (rip)
                {
                    ++counts[rip];
                    ++total;
                }
            }
            std::vector<std::pair<uint64_t, uint32_t>> v(counts.begin(), counts.end());
            std::sort(v.begin(), v.end(), [](const auto &a, const auto &b) { return a.second > b.second; });
            std::ofstream f(profPath, std::ios::trunc);
            f << "base 0x" << std::hex << base << std::dec << " total " << total << '\n';
            for (const auto &kv : v)
            {
                HMODULE mod = nullptr;
                const bool inExe = GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                                                      reinterpret_cast<LPCWSTR>(kv.first), &mod) &&
                                   reinterpret_cast<uint64_t>(mod) == base;
                if (inExe)
                    f << std::hex << kv.first - base << std::dec << " " << kv.second << '\n';
                else
                {
                    char name[MAX_PATH] = {0};
                    if (mod)
                        GetModuleFileNameA(mod, name, sizeof(name));
                    f << std::hex << kv.first << std::dec << " " << kv.second << " ext " << (mod ? name : "?") << "+0x"
                      << std::hex << (mod ? kv.first - reinterpret_cast<uint64_t>(mod) : 0) << std::dec << '\n';
                }
            }
        });
#elif defined(__linux__) && defined(__x86_64__)
        // The Linux half: no thread can read another thread context, so the kernel interrupts this
        // one -- a SIGPROF timer on this thread (SIGEV_THREAD_ID + gettid) whose handler pushes
        // uc_mcontext.gregs[REG_RIP] into a ring the helper thread drains. Same histogram file.
        const uint64_t base = hostProfSelfBase();
        if (!hostProfInstallSignal() || !hostProfArmTimer(static_cast<int>(::syscall(SYS_gettid)), 0.1))
        {
            std::fprintf(stderr, "--prof: cannot arm the SIGPROF timer (errno %d)\n", errno);
            return 1;
        }
        profThread = std::thread([base, profPath, &profStop]() {
            std::unordered_map<uint64_t, uint32_t> counts;
            uint64_t total = 0;
            while (!profStop.load())
            {
                std::this_thread::sleep_for(std::chrono::milliseconds(2));
                total += hostProfDrain(counts);
            }
            total += hostProfDrain(counts);
            std::vector<std::pair<uint64_t, uint32_t>> v(counts.begin(), counts.end());
            std::sort(v.begin(), v.end(), [](const auto &a, const auto &b) { return a.second > b.second; });
            std::ofstream f(profPath, std::ios::trunc);
            f << "base 0x" << std::hex << base << std::dec << " total " << total << '\n';
            // readlink("/proc/self/exe") is this tool own path: the mirror of GetModuleFileNameA on
            // the main module (dladdr would hand back argv[0], which can be relative).
            const std::string selfExe = hostProfSelfExe();
            for (const auto &kv : v)
            {
                Dl_info dli;
                const bool known = ::dladdr(reinterpret_cast<void *>(kv.first), &dli) != 0 && dli.dli_fbase != nullptr;
                const uint64_t modBase = known ? reinterpret_cast<uint64_t>(dli.dli_fbase) : 0ull;
                if (known && modBase == base)
                    f << std::hex << kv.first - base << std::dec << " " << kv.second << '\n';
                else
                {
                    const char *name = known && dli.dli_fname ? dli.dli_fname : nullptr;
                    f << std::hex << kv.first << std::dec << " " << kv.second << " ext "
                      << (name ? name : (modBase ? selfExe.c_str() : "?")) << "+0x"
                      << std::hex << (modBase ? kv.first - modBase : 0ull) << std::dec << '\n';
                }
            }
        });
#else
        std::fprintf(stderr, "--prof: not supported on this platform\n");
        return 1;
#endif
    }

    double totalHostNs = 0.0;
    uint64_t totalCycles = 0;
    uint64_t totalPairs = 0;
    std::vector<uint8_t> data;
    std::set<uint32_t> entryPcs;
    std::vector<uint8_t> firstCode;
    for (const std::string &input : inputs)
    {
        Dump d;
        if (!loadDump(input.c_str(), d))
            return 1;
        currentDump = baseName(input);
        warnedTextureInBlankRegion = false;
        blendSeenThisDump = false;
        entryPcs.insert(d.hdr[0]);
        if (firstCode.empty())
            firstCode = d.code;
        else if (!genPath.empty() && firstCode != d.code)
        {
            std::fprintf(stderr, "--gen: %s runs a different microcode image than the first dump\n", input.c_str());
            return 1;
        }
        uint64_t cycles = 0;
        for (int iter = 0; iter < repeat; ++iter)
        {
            packets.clear();
            packetCount = 0;
            if (renderToVram)
            {
                // Fresh VRAM and a fresh context per dump, so one dump's pixels never reach another's.
                resetReplayVram(vram);
                gs.reset();
                setupReplayGsContext(gs);
            }
            uint8_t *code = memory.getVU1Code();
            uint8_t *vuData = memory.getVU1Data();
            if (std::memcmp(code, d.code.data(), PS2_VU1_CODE_SIZE) != 0)
            {
                std::memcpy(code, d.code.data(), PS2_VU1_CODE_SIZE);
                memory.markVU1CodeModified();
            }
            std::memcpy(vuData, d.data.data(), PS2_VU1_DATA_SIZE);
            vu.reset();
            std::memcpy(vu.m_state.vi, d.vi, sizeof(d.vi));
            std::memcpy(vu.m_state.vf, d.vf, sizeof(d.vf));
            const uint64_t startCycle = vu.m_cycle;
            extern std::atomic<uint64_t> g_vuInsnCount;
            const uint64_t startPairs = g_vuInsnCount.load();
            const auto t0 = std::chrono::steady_clock::now();
            vu.execute(code, PS2_VU1_CODE_SIZE, vuData, PS2_VU1_DATA_SIZE,
                       gs, &memory, d.hdr[0], d.hdr[1], d.hdr[2], 1u << 28);
            const auto t1 = std::chrono::steady_clock::now();
            totalHostNs += std::chrono::duration<double, std::nano>(t1 - t0).count();
            cycles = vu.m_cycle - startCycle;
            totalCycles += cycles;
            totalPairs += g_vuInsnCount.load() - startPairs;
            data.assign(vuData, vuData + PS2_VU1_DATA_SIZE);
        }

        if (renderToVram)
        {
            const std::string path = vramDumpPath(vramDumpDir, input, hostDraw);
            if (!writeFile(path, readFrameRgba(gs)))
            {
                std::fprintf(stderr, "cannot write %s\n", path.c_str());
                return 1;
            }
            // What --vram-diff's parent cannot see from the framebuffer alone.
            const std::string metaPath = vramMetaPath(vramDumpDir, input, hostDraw);
            FILE *meta = std::fopen(metaPath.c_str(), "w");
            if (meta == nullptr)
            {
                std::fprintf(stderr, "cannot write %s\n", metaPath.c_str());
                return 1;
            }
            std::fprintf(meta, "abe=%d\n", blendSeenThisDump ? 1 : 0);
            std::fclose(meta);
            std::fprintf(stderr, "[vu1_replay] %s: %u packets kicked -> %s\n",
                         baseName(input).c_str(), packetCount, path.c_str());
            continue;
        }

        if (!verifyPath.empty())
        {
            const std::string base = baseName(input);
            std::string gotName;
            auto got = parseStateLine(stateLine(base.c_str(), vu, packetCount, packets, cycles, data), gotName);
            const auto g = golden.find(base);
            if (g == golden.end())
            {
                std::printf("MISMATCH %s <no golden line>\n", base.c_str());
                ++mismatches;
            }
            else
            {
                // --host-draw replaces the XGKICK with a host draw, so there are no packets to
                // compare; what the knob must not change is the VU state it leaves behind.
                const int bad = compareState(base, g->second, got, verifyRegs, !hostDraw);
                mismatches += bad;
                if (bad == 0) std::printf("OK %s\n", base.c_str());
            }
            continue;
        }

        if (batchDir.empty())
        {
            std::printf("pc=0x%x top=0x%x itop=0x%x: %u packets, %zu bytes, %llu cycles, end pc=0x%x\n",
                        d.hdr[0], d.hdr[1], d.hdr[2], packetCount, packets.size(), (unsigned long long)cycles, vu.m_state.pc);
            if (FILE *out = std::fopen(outPath.c_str(), "wb"))
            {
                std::fwrite(packets.data(), 1, packets.size(), out);
                std::fclose(out);
            }
            if (printStateFlag)
                printState(stdout, baseName(input).c_str(), vu, packetCount, packets, cycles, data);
        }
        else
        {
            const std::string base = baseName(input);
            const std::string pk = batchDir + "/" + base + ".pk";
            if (FILE *out = std::fopen(pk.c_str(), "wb"))
            {
                std::fwrite(packets.data(), 1, packets.size(), out);
                std::fclose(out);
            }
            printState(stateOut, base.c_str(), vu, packetCount, packets, cycles, data);
        }
    }
    if (stateOut)
        std::fclose(stateOut);
    if (bailHist)
    {
        uint64_t total = 0;
        for (uint32_t i = 0; i < bails.size(); ++i)
            total += bails[i];
        std::fprintf(stderr, "[vu1_replay] generated code: entered %llu, ended %llu, dispatch skipped %llu, hand-backs %llu\n",
                     (unsigned long long)g_vu1GenEntered, (unsigned long long)g_vu1GenEnded, (unsigned long long)g_vu1GenSkipped, (unsigned long long)total);
        for (uint32_t i = 0; i < bails.size(); ++i)
            if (bails[i])
                std::fprintf(stderr, "  pc=0x%04x: %u\n", i * 8u, bails[i]);
    }
    if (!pcHistPath.empty())
    {
        if (FILE *fp = std::fopen(pcHistPath.c_str(), "wb"))
        {
            std::fwrite(pcHist.data(), sizeof(uint32_t), pcHist.size(), fp);
            std::fclose(fp);
        }
    }
    if (!genPath.empty())
    {
        std::set<uint32_t> seeds(entryPcs);
        uint32_t executed = 0;
        for (uint32_t i = 0; i < pcHist.size(); ++i)
            if (pcHist[i])
            {
                seeds.insert(i * 8u);
                ++executed;
            }
        std::set<uint32_t> unknownEntries(entryPcs);
        for (uint32_t i = 0; i < jrHist.size(); ++i)
            if (jrHist[i])
                unknownEntries.insert(i * 8u);
        if (!seedsPath.empty())
        {
            if (FILE *sf = std::fopen(seedsPath.c_str(), "r"))
            {
                char line[128];
                while (std::fgets(line, sizeof(line), sf))
                {
                    const uint32_t pc = static_cast<uint32_t>(std::strtoul(line, nullptr, 0)) & 0x3FF8u;
                    seeds.insert(pc);
                    unknownEntries.insert(pc);
                }
                std::fclose(sf);
            }
            else
                std::fprintf(stderr, "cannot read %s\n", seedsPath.c_str());
        }
        std::fprintf(stderr, "[vu1_gen] %zu entry pcs, %u executed pairs, %zu computed-jump/entry pcs\n", entryPcs.size(), executed, unknownEntries.size());
        const int rc = vu1GenerateKnownProgram(firstCode.data(), fnv1a(firstCode.data(), firstCode.size()), seeds, unknownEntries, genPath);
        if (rc != 0)
            return rc;
    }
    if (profThread.joinable())
    {
        profStop.store(true);
        profThread.join();
    }
    {
        // Native-program registry counters (src/lib/vu/native): entered = runs a native program
        // took over, ended = it ran the whole program to the E bit, handbacks = it gave control
        // back to the microcode. Printed on every run so a --verify without --native shows zeros.
        extern std::atomic<uint64_t> g_vu1NativeEntered, g_vu1NativeEnded, g_vu1NativeHandBacks;
        std::fprintf(stderr, "[vu1_replay] native entered=%llu ended=%llu handbacks=%llu\n",
                     (unsigned long long)g_vu1NativeEntered.load(),
                     (unsigned long long)g_vu1NativeEnded.load(),
                     (unsigned long long)g_vu1NativeHandBacks.load());
    }
    if (vu1ops::fmacZeroFastKnob())
    {
        // S17 F C1 (research/81): product-sums that failed the fast test, and the share of them whose
        // failing lanes were all exact zeros (now fast). Only counted with the knob on: the runtime's own
        // read, so the line prints under the default (1, R337) and is silent at =0.
        const vu1ops::ProductSumZeroCounts &z = vu1ops::productSumZeroCounts();
        std::fprintf(stderr, "[vu1_replay] fmac zero-fast: refused=%llu rescued=%llu (%.1f %%)\n",
                     (unsigned long long)z.refused, (unsigned long long)z.rescued,
                     z.refused ? 100.0 * (double)z.rescued / (double)z.refused : 0.0);
    }
    if (Vu1Refusals::enabled())
    {
        // S17 F (research/81 §3.4): why the native dispatcher refused, one line per (entry, reason, command),
        // with the VU cycles and host time the fallback ran for it. PS2X_VU1_NATIVE_REFUSALS=1 (Dev); read by
        // tools_py/parity/vu1_refusals.py. Totals over every program and --repeat pass.
        Vu1Refusals::printTotals(stderr);
    }
    std::fprintf(stderr, "[vu1_replay] %zu programs x%d: %llu cycles, %llu pairs, host %.1f ms, %.1f ns/cycle, %.1f ns/pair\n",
                 inputs.size(), repeat, (unsigned long long)totalCycles, (unsigned long long)totalPairs,
                 totalHostNs / 1e6, totalCycles ? totalHostNs / (double)totalCycles : 0.0,
                 totalPairs ? totalHostNs / (double)totalPairs : 0.0);
    if (!verifyPath.empty())
    {
        std::printf("%s: %d mismatching field(s)\n", mismatches ? "FAIL" : "PASS", mismatches);
        return mismatches ? 1 : 0;
    }
    return 0;
}
