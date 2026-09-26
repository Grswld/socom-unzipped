// Task 6c Step 2 (research/32): the sound bank reader and the headerless VAG block decoder, against the HUDUI
// bank cut from the disc (tests/fixtures/audio/hudui_block.bin = chunk 0, 3472 bytes; hudui_vag.bin = chunk 1,
// 60928 bytes; sector 2010461 of the r0001 ISO).
#include "MiniTest.h"
#include "runtime/ps2_vag.h"
#include "runtime/socom2_bank.h"
#include "runtime/mix_device.h"
#include "runtime/snd989_mixer.h"
#include "runtime/ps2_audio.h"
#include "runtime/audio_volume.h"
#include "runtime/host_mic.h"
#include "runtime/mic_format.h"
#include "runtime/socom2_music_trace.h"
#include "ps2x/iop/iop_subsystem.h"
#include "ps2_runtime.h"
#include "ps2_iop_transport.h"
#include "ps2_syscalls.h"
#include "ps2_stubs.h"

#include <chrono>
#include <cmath>
#include <cstring>
#include <thread>

#include <algorithm>
#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <string>
#include <vector>

namespace
{
    // Every file a case writes goes under the system temp directory, never the working directory: the suite used
    // to drop its VPK, ring-image and microphone WAV fixtures wherever it was run from, and they showed as untracked
    // at the repository root for weeks (Sprint 10 H4 / Sprint 11 Goal 0). Cases still remove what they wrote.
    std::string tmpPath(const char *name)
    {
        return (std::filesystem::temp_directory_path() / (std::string("ps2x_") + name)).string();
    }

    std::vector<uint8_t> readFixture(const char *name)
    {
        const char *roots[] = {"../../../../tests/fixtures/audio/", "tests/fixtures/audio/", "../../../tests/fixtures/audio/"};
        for (const char *root : roots)
        {
            const std::string path = std::string(root) + name;
            if (FILE *fp = std::fopen(path.c_str(), "rb"))
            {
                std::vector<uint8_t> bytes;
                uint8_t buf[4096];
                size_t n;
                while ((n = std::fread(buf, 1, sizeof(buf), fp)) > 0)
                    bytes.insert(bytes.end(), buf, buf + n);
                std::fclose(fp);
                return bytes;
            }
        }
        return {};
    }

    // One ADPCM block: shift, filter, flags, 28 4-bit samples (-8..7).
    std::vector<uint8_t> block(uint8_t shift, uint8_t filter, uint8_t flags, const int8_t (&nibbles)[28])
    {
        std::vector<uint8_t> b(16, 0u);
        b[0] = static_cast<uint8_t>((shift & 0x0F) | (filter << 4));
        b[1] = flags;
        for (int i = 0; i < 28; ++i)
        {
            const uint8_t n = static_cast<uint8_t>(nibbles[i] & 0x0F);
            if (i & 1)
                b[2 + i / 2] |= static_cast<uint8_t>(n << 4);
            else
                b[2 + i / 2] |= n;
        }
        return b;
    }

    // Sprint 9 Q0: an SBlk v3 block built by hand (the layout of research/32 section 1) with three sounds -- sound 0
    // a CONDUCTOR of the shape of the M51 ambience's (child sounds, a register test on a global, markers, a loop),
    // sounds 1 and 2 one TONE each on a HUDUI sample. The program:
    //   g0  START_CHILD_SOUND  spec A -> sound 1 (vol 100)
    //   g1  TEST_REGISTER      global 2 (register -2), action 0: skip the next grain when the value is >= 5
    //   g2  GOTO_MARKER 1
    //   g3  MARKER 0
    //   g4  SET_REGISTER       register 0 = 90
    //   g5  START_CHILD_SOUND  spec B -> sound 2 (vol 100; its tone's Vol is -1 = register 0)
    //   g6  LOOP_START (delay 10)   g7 LOOP_END
    //   g8  MARKER 1
    //   g9  STOP_CHILD_SOUND   spec A
    //   g10 LOOP_START (delay 10)   g11 LOOP_END
    // So with global 2 >= 5 the conductor runs children 1 and 2 forever; below 5 it starts child 1, stops it at
    // once and idles -- the two branches of the mission conductor in miniature.
    std::vector<uint8_t> conductorBlock(const socom2_bank::Tone &sample)
    {
        std::vector<uint8_t> b(0x160, 0u);
        auto put16 = [&b](size_t at, uint16_t v) { b[at] = static_cast<uint8_t>(v & 0xFF); b[at + 1] = static_cast<uint8_t>(v >> 8); };
        auto put32 = [&b](size_t at, uint32_t v) { for (int i = 0; i < 4; ++i) b[at + static_cast<size_t>(i)] = static_cast<uint8_t>((v >> (8 * i)) & 0xFF); };
        auto arg3 = [](int a0, int a1, int a2) {
            return static_cast<uint32_t>(a0 & 0xFF) | (static_cast<uint32_t>(a1 & 0xFF) << 8) | (static_cast<uint32_t>(a2 & 0xFF) << 16);
        };
        std::memcpy(b.data(), "SBlk", 4);
        put32(0x04, 3u);
        put16(0x16, 3u);      // NumSounds
        put16(0x18, 14u);     // NumGrains
        put32(0x1C, 0x40u);   // FirstSound
        put32(0x20, 0x70u);   // FirstGrain
        put32(0x34, 0xE0u);   // GrainData
        put32(0x38, 0x150u);  // BlockNames
        std::memcpy(b.data() + 0x150, "COND", 4);
        // Sound records: {s8 vol, s8 group, s16 pan, s8 numGrains, s8 limit, u16 flags, s32 firstSfxGrain}
        auto sound = [&](size_t index, int8_t vol, int8_t numGrains, int32_t firstGrain) {
            const size_t at = 0x40 + index * 12;
            b[at] = static_cast<uint8_t>(vol);
            b[at + 4] = static_cast<uint8_t>(numGrains);
            put32(at + 8, static_cast<uint32_t>(firstGrain));
        };
        sound(0, 100, 12, 0);
        sound(1, 100, 1, 12 * 8);
        sound(2, 100, 1, 13 * 8);
        struct G { uint8_t type; uint32_t arg; int32_t delay; };
        const G grains[14] = {
            {5, 0x00u, 0}, {34, arg3(-2, 0, 5), 0}, {36, 1u, 0}, {35, 0u, 0}, {30, arg3(0, 90, 0), 0}, {5, 0x20u, 0},
            {21, 0u, 10}, {22, 0u, 0}, {35, 1u, 0}, {6, 0x00u, 0}, {21, 0u, 10}, {22, 0u, 0},
            {1, 0x40u, 0},   // sound 1: TONE at pool +0x40
            {1, 0x58u, 0},   // sound 2: TONE at pool +0x58, Vol -1
        };
        for (size_t i = 0; i < 14; ++i)
        {
            put32(0x70 + i * 8, (static_cast<uint32_t>(grains[i].type) << 24) | (grains[i].arg & 0xFFFFFFu));
            put32(0x70 + i * 8 + 4, static_cast<uint32_t>(grains[i].delay));
        }
        // The pool: two PlaySoundParams {s32 vol, s32 pan, s8 regs[4], s32 soundId, char name[16]}, two 24-byte tones.
        put32(0xE0 + 0x00, 100u);
        put32(0xE0 + 0x0C, 1u);
        put32(0xE0 + 0x20, 100u);
        put32(0xE0 + 0x2C, 2u);
        auto tone = [&](size_t at, int8_t vol) {
            b[at + 0] = static_cast<uint8_t>(sample.priority);
            b[at + 1] = static_cast<uint8_t>(vol);
            b[at + 2] = static_cast<uint8_t>(sample.centerNote);
            b[at + 3] = static_cast<uint8_t>(sample.centerFine);
            put16(at + 4, static_cast<uint16_t>(sample.pan));
            b[at + 6] = static_cast<uint8_t>(sample.mapLow);
            b[at + 7] = static_cast<uint8_t>(sample.mapHigh);
            b[at + 8] = static_cast<uint8_t>(sample.pbLow);
            b[at + 9] = static_cast<uint8_t>(sample.pbHigh);
            put16(at + 10, sample.adsr1);
            put16(at + 12, sample.adsr2);
            put16(at + 14, sample.flags);
            put32(at + 16, sample.sampleOffset);
        };
        tone(0xE0 + 0x40, 100);
        tone(0xE0 + 0x58, -1);
        return b;
    }

    // A stereo VPK on disk: 0xB0-byte header {"VPK ", dataSize, interleave 0x800, headerSize 0xB0, rate 32000,
    // channels 2}, then `chunkPairs` pairs of 0x800-byte chunks (left ramp up, right ramp down); the very last
    // block carries the data's end flag. Task 1e's ring cases need a file longer than the ring holds.
    // `shift` is the ADPCM block shift: the decoder scales a nibble by 1 << (12 - shift), so 12 is the quietest
    // (the level cases want a loud file, the ring cases only care about the sign of each channel).
    bool writeVpk(const std::string &path, int chunkPairs, uint8_t shift = 12)
    {
        int8_t up[28], down[28];
        for (int i = 0; i < 28; ++i)
        {
            up[i] = static_cast<int8_t>(i % 8);
            down[i] = static_cast<int8_t>(-(i % 8));
        }
        // research/36 item 10: a two-channel VPK's per-channel stride is header word 3 / 2 (the streaming buffer's
        // half), so a file of alternating 0x800-byte channel chunks declares word 3 = 0x1000 (data at 0x1000).
        std::vector<uint8_t> file(0x1000, 0u);
        auto put32 = [&](size_t at, uint32_t v) { file[at] = static_cast<uint8_t>(v); file[at + 1] = static_cast<uint8_t>(v >> 8); file[at + 2] = static_cast<uint8_t>(v >> 16); file[at + 3] = static_cast<uint8_t>(v >> 24); };
        std::memcpy(file.data(), " KPV", 4);
        put32(4, static_cast<uint32_t>(chunkPairs * 2 * 0x800));
        put32(8, 0x800);
        put32(12, 0x1000);
        put32(16, 32000);
        put32(20, 2);
        for (int c = 0; c < chunkPairs; ++c)
            for (int ch = 0; ch < 2; ++ch)
                for (int b = 0; b < 0x800 / 16; ++b)
                {
                    const bool last = c == chunkPairs - 1 && b == 0x800 / 16 - 1;
                    const std::vector<uint8_t> blk = block(shift, 0, last ? 0x01 : 0x00, ch == 0 ? up : down);
                    file.insert(file.end(), blk.begin(), blk.end());
                }
        FILE *fp = std::fopen(path.c_str(), "wb");
        if (!fp)
            return false;
        std::fwrite(file.data(), 1, file.size(), fp);
        std::fclose(fp);
        return true;
    }
    // ---- the 989snd IOP module (modules/snd989.cpp) --------------------------------------------
    // Its model -- bank table, sound slots, VAG stream slots -- is only reachable over its RPC
    // server (SID 0x00123456, one command per call), so the cases below drive it the way the game
    // does. A minimal host: guest memory and nothing else (no disc image, no mixer).
    class Snd989TestHost : public ps2x::iop::IopHost
    {
    public:
        std::vector<uint8_t> memory = std::vector<uint8_t>(0x10000u, 0u);

        bool readGuest(uint32_t address, void *destination, size_t size) const override
        {
            if (!fits(address, size))
                return false;
            if (size != 0u)
                std::memcpy(destination, memory.data() + address, size);
            return true;
        }
        bool writeGuest(uint32_t address, const void *source, size_t size) override
        {
            if (!fits(address, size))
                return false;
            if (size != 0u)
                std::memcpy(memory.data() + address, source, size);
            return true;
        }
        bool zeroGuest(uint32_t address, size_t size) override
        {
            if (!fits(address, size))
                return false;
            std::fill(memory.begin() + address, memory.begin() + address + size, uint8_t{0});
            return true;
        }
        bool normalizeGuestAddress(uint32_t address, uint32_t &normalized) const override
        {
            normalized = address & 0x1FFFFFFFu;
            return normalized < memory.size();
        }
        uint32_t allocateIopHandle(ps2x::iop::IopHandleKind) override { return m_nextHandle += 0x40u; }
        uint32_t allocateGuest(uint32_t size, uint32_t) override
        {
            if (size == 0u || m_nextAlloc + size > memory.size())
                return 0u;
            const uint32_t address = m_nextAlloc;
            m_nextAlloc += size;
            return address;
        }
        void freeGuest(uint32_t) override {}
        void audioCommand(uint32_t, uint32_t function, ps2x::iop::GuestBuffer, ps2x::iop::GuestBuffer) override
        {
            audioCommands.push_back(function);
        }
        std::string hostPath(ps2x::iop::HostPathKind) const override { return std::string(); }
        std::string translateGuestPath(std::string_view path) const override { return std::string(path); }
        uint64_t openHostFile(std::string_view) override { return 0u; }
        bool hostFileSize(uint64_t, uint64_t &) const override { return false; }
        bool readHostFile(uint64_t, uint64_t, void *, size_t, size_t &bytesRead) override
        {
            bytesRead = 0u;
            return false;
        }
        void closeHostFile(uint64_t) override {}
        int32_t memoryCard(const ps2x::iop::MemoryCardRequest &) override { return 0; }
        bool hasGuestFunction(uint32_t) const override { return false; }
        bool invokeGuestFunction(uint64_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t *) override
        {
            return false;
        }
        void log(ps2x::iop::LogLevel, std::string_view) override {}

        std::vector<uint32_t> audioCommands;

    private:
        bool fits(uint32_t address, size_t size) const
        {
            return static_cast<uint64_t>(address) + size <= memory.size();
        }
        uint32_t m_nextHandle = 0x8000u;
        uint32_t m_nextAlloc = 0x4000u;
    };

    // Task 12b: the same minimal host with the one seam the runtime's PS2IopHostAdapter provides for the
    // mixer -- audioNotify() reaches PS2AudioBackend::onNotify (which opens the VAG stream) and
    // audioIsPlaying() is answered by snd989::Mixer::isPlaying, per handle. This is how the IOP model learns
    // that a stream the game never stopped has played to its end.
    class Snd989MixerHost final : public Snd989TestHost
    {
    public:
        PS2AudioBackend backend;

        void audioNotify(uint32_t function, const int32_t *args, size_t count) override
        {
            backend.onNotify(function, args, count);
        }
        bool audioIsPlaying(uint32_t handle, bool &playing) const override
        {
            return backend.isPlaying(handle, playing);
        }
    };

    // Sprint 9 Goal 10 (R169): what the module actually told the host. snd_PlayVAGStreamByLoc with a
    // parentHandle is a QUEUE, and the host cannot know that from the nine words the module used to send --
    // it saw a play on a handle it was already playing, and replaced it.
    class Snd989NotifyRecorderHost final : public Snd989TestHost
    {
    public:
        struct Notify
        {
            uint32_t function = 0u;
            std::vector<int32_t> args;
        };
        std::vector<Notify> notifies;

        void audioNotify(uint32_t function, const int32_t *args, size_t count) override
        {
            notifies.push_back({function, std::vector<int32_t>(args, args + count)});
        }
        const Notify *last(uint32_t function) const
        {
            for (size_t i = notifies.size(); i-- > 0;)
                if (notifies[i].function == function)
                    return &notifies[i];
            return nullptr;
        }
    };

    // Sprint 7 review finding F3: the same mixer host, except that snd_PlayVAGStreamByLoc never reaches the
    // mixer (a failed open, a notify the host dropped). The handle the model minted is then one the mixer has
    // never seen, and the reaper must not read "no answer" as "finished".
    class Snd989UnseenStreamHost final : public Snd989TestHost
    {
    public:
        PS2AudioBackend backend;

        void audioNotify(uint32_t function, const int32_t *args, size_t count) override
        {
            if (function == 0x2Cu)
                return;   // snd_PlayVAGStreamByLoc: the mixer never learns this handle
            backend.onNotify(function, args, count);
        }
        bool audioIsPlaying(uint32_t handle, bool &playing) const override
        {
            return backend.isPlaying(handle, playing);
        }
    };

    // One RPC call on the snd server, returning the module's result word.
    template <typename HostT = Snd989TestHost>
    struct Snd989HarnessT
    {
        static constexpr uint32_t kSid = 0x00123456u;
        static constexpr uint32_t kSend = 0x0800u;
        static constexpr uint32_t kReceive = 0x1000u;

        HostT host;
        ps2x::iop::IopSubsystem subsystem{host};
        bool configured = false;

        Snd989HarnessT()
        {
            std::string error;
            configured = subsystem.configure({"socom2_game.elf", 0u, 0u}, &error);
        }

        uint32_t call(uint32_t fno, const std::vector<uint32_t> &words)
        {
            if (!words.empty())
                (void)host.writeGuest(kSend, words.data(), words.size() * sizeof(uint32_t));
            (void)host.zeroGuest(kReceive, 0x40u);
            ps2x::iop::RpcRequest request{};
            request.sid = kSid;
            request.function = fno;
            request.send = {kSend, static_cast<uint32_t>(words.size() * sizeof(uint32_t))};
            request.receive = {kReceive, 0x40u};
            (void)subsystem.handleRpc(request);
            uint32_t value = 0u;
            (void)host.readGuest(kReceive + 4u, &value, sizeof(value));
            return value;   // handleSingle: [0]=-1, [1]=the result, [2]=-1
        }
    };

    using Snd989Harness = Snd989HarnessT<>;

    // A one-channel VPK of a single 0x800-byte chunk (the last block carries the data's end flag) written at
    // sector 2 of a small "disc image": a stream of ~5376 output frames that ends by itself.
    bool writeOneChunkVpkImage(const std::string &path)
    {
        int8_t up[28];
        for (int i = 0; i < 28; ++i)
            up[i] = static_cast<int8_t>(i % 8);
        std::vector<uint8_t> image(2048u * 2u, 0u);
        std::vector<uint8_t> vpk(0xB0, 0u);
        auto put32 = [&](size_t at, uint32_t v) { vpk[at] = static_cast<uint8_t>(v); vpk[at + 1] = static_cast<uint8_t>(v >> 8); vpk[at + 2] = static_cast<uint8_t>(v >> 16); vpk[at + 3] = static_cast<uint8_t>(v >> 24); };
        std::memcpy(vpk.data(), " KPV", 4);
        put32(4, 0x800u);
        put32(8, 0x800u);
        put32(12, 0xB0u);
        put32(16, 32000u);
        put32(20, 1u);
        for (int b = 0; b < 0x800 / 16; ++b)
        {
            const std::vector<uint8_t> blk = block(12, 0, b == 0x800 / 16 - 1 ? 0x01 : 0x00, up);
            vpk.insert(vpk.end(), blk.begin(), blk.end());
        }
        image.insert(image.end(), vpk.begin(), vpk.end());
        FILE *fp = std::fopen(path.c_str(), "wb");
        if (!fp)
            return false;
        std::fwrite(image.data(), 1, image.size(), fp);
        std::fclose(fp);
        return true;
    }

    // Task 12b, the bank table: the call that wiped it is an EE one (sceSifInitRpc), so this case needs the
    // runtime's own IOP subsystem rather than the standalone harness above -- the same shape as TestEnv in
    // ps2_sif_rpc_tests.cpp.
    struct SndRuntimeEnv
    {
        std::vector<uint8_t> rdram;
        R5900Context ctx{};
        PS2Runtime runtime;
        bool configured = false;

        SndRuntimeEnv() : rdram(PS2_RAM_SIZE, 0)
        {
            std::memset(&ctx, 0, sizeof(ctx));
            std::string error;
            configured = PS2IopTransport::configureForTesting(&runtime, {"socom2_game.elf", 0u, 0u}, &error);
        }

        static constexpr uint32_t kSid = 0x00123456u;
        static constexpr uint32_t kSend = 0x00023000u;
        static constexpr uint32_t kReceive = 0x00023100u;

        uint32_t call(uint32_t fno, const std::vector<uint32_t> &words)
        {
            std::memset(rdram.data() + kSend, 0, 0x100u);
            std::memset(rdram.data() + kReceive, 0, 0x100u);
            if (!words.empty())
                std::memcpy(rdram.data() + kSend, words.data(), words.size() * sizeof(uint32_t));
            ps2x::iop::RpcRequest request{};
            request.sid = kSid;
            request.function = fno;
            request.send = {kSend, static_cast<uint32_t>(words.size() * sizeof(uint32_t))};
            request.receive = {kReceive, 0x40u};
            (void)PS2IopTransport::handleRpc(&runtime, rdram.data(), &ctx, std::move(request));
            uint32_t value = 0u;
            std::memcpy(&value, rdram.data() + kReceive + 4u, sizeof(value));
            return value;
        }
    };
}

void register_socom2_audio_tests()
{
    // Task 1e: the mixer's stream worker is a thread; the tests drive pumpStreams() themselves so a case's audio
    // is a function of its calls and not of a 10 ms tick (the interface's PS2X_SND_STREAM_WORKER=0 path).
#ifdef _WIN32
    _putenv_s("PS2X_SND_STREAM_WORKER", "0");
#else
    setenv("PS2X_SND_STREAM_WORKER", "0", 1);
#endif

    MiniTest::Case("SOCOM2Audio", [](TestCase &tc)
    {
        tc.Run("the HUDUI bank parses: 24 sounds, sound 0's four tones, sound 16's grain script, the bank name", [](TestCase &t)
        {
            const std::vector<uint8_t> blk = readFixture("hudui_block.bin");
            t.Equals(blk.size(), static_cast<size_t>(3472u), "fixture hudui_block.bin is present (3472 bytes)");
            socom2_bank::Bank bank;
            t.IsTrue(socom2_bank::parse(blk.data(), blk.size(), bank), "parse accepts the SBlk v3 block");
            t.Equals(bank.version, 3u, "version 3");
            t.Equals(bank.sounds.size(), static_cast<size_t>(24u), "NumSounds sits at 0x16: 24 sounds (the first cut read 0 at 0x14)");
            t.Equals(bank.name, std::string("HUDUI"), "the block name");
            if (bank.sounds.size() < 24u)
                return;
            const socom2_bank::Sound &s0 = bank.sounds[0];
            t.Equals(static_cast<int>(s0.vol), 98, "sound 0 vol");
            t.Equals(static_cast<int>(s0.volGroup), 14, "sound 0 group");
            t.Equals(static_cast<int>(s0.pan), 0, "sound 0 pan");
            t.Equals(s0.grains.size(), static_cast<size_t>(4u), "sound 0 has four grains");
            t.Equals(static_cast<unsigned>(s0.flags), 2u, "sound 0 flags");
            if (s0.grains.size() == 4u)
            {
                socom2_bank::Tone tone;
                t.Equals(static_cast<int>(s0.grains[0].type), 1, "grain 0 is a TONE");
                t.IsTrue(bank.tone(s0.grains[0], tone), "the TONE grain resolves its parameters in GrainData");
                t.Equals(static_cast<int>(tone.priority), 99, "tone 0 priority");
                t.Equals(static_cast<int>(tone.vol), 90, "tone 0 vol");
                t.Equals(static_cast<int>(tone.centerNote), -58, "tone 0 center note (negative: a PS1 note)");
                t.Equals(static_cast<int>(tone.centerFine), 66, "tone 0 center fine");
                t.Equals(static_cast<unsigned>(tone.adsr1), 0x80ffu, "tone 0 ADSR1");
                t.Equals(static_cast<unsigned>(tone.adsr2), 0x9fe8u, "tone 0 ADSR2");
                t.Equals(tone.sampleOffset, 0x3940u, "tone 0 sample offset into the VAG chunk");
                t.IsTrue(bank.tone(s0.grains[3], tone) && tone.vol == 120 && tone.priority == 88 && tone.sampleOffset == 0x3030u, "tone 3: prio 88, vol 120, sample 0x3030");
                t.Equals(static_cast<int>(s0.grains[1].type), 1, "grain 1 is a TONE");
                t.IsTrue(bank.tone(s0.grains[1], tone) && tone.pan == 300 && tone.sampleOffset == 0xa820u, "tone 1: pan 300, sample 0xa820");
            }
            const socom2_bank::Sound &s5 = bank.sounds[5];
            t.Equals(s5.grains.size(), static_cast<size_t>(0u), "sound 5 has no grains (FirstSFXGrain -8)");
            const socom2_bank::Sound &s8 = bank.sounds[8];
            t.Equals(static_cast<int>(s8.vol), 115, "sound 8 vol");
            t.Equals(s8.grains.size(), static_cast<size_t>(1u), "sound 8 has one grain");
            const socom2_bank::Sound &s16 = bank.sounds[16];
            t.Equals(s16.grains.size(), static_cast<size_t>(5u), "sound 16 has five grains");
            if (s16.grains.size() == 5u)
            {
                const int types[5] = {4, 1, 1, 26, 41};
                for (int i = 0; i < 5; ++i)
                    t.Equals(static_cast<int>(s16.grains[i].type), types[i], "sound 16 grain " + std::to_string(i) + " type (LFO, TONE, TONE, RAND_DELAY, KEY_OFF_VOICES)");
                t.Equals(s16.grains[3].delay, 444, "the RAND_DELAY grain's delay");
                socom2_bank::Tone tone;
                t.IsTrue(bank.tone(s16.grains[1], tone) && tone.centerNote == -99 && tone.pbLow == 12 && tone.pbHigh == 12 && tone.sampleOffset == 0x6950u, "sound 16 tone 1: note -99, PB 12/12, sample 0x6950");
                t.IsTrue(bank.tone(s16.grains[2], tone) && tone.centerNote == -106 && tone.sampleOffset == 0x6950u, "sound 16 tone 2: the same sample at note -106");
                t.IsTrue(!bank.tone(s16.grains[3], tone), "a RAND_DELAY grain has no tone");
            }
        });

        tc.Run("parse rejects a block that is not SBlk v3 or runs off the end", [](TestCase &t)
        {
            const std::vector<uint8_t> blk = readFixture("hudui_block.bin");
            socom2_bank::Bank bank;
            std::vector<uint8_t> bad = blk;
            bad[0] ^= 0xFFu;
            t.IsTrue(!socom2_bank::parse(bad.data(), bad.size(), bank), "wrong magic");
            std::vector<uint8_t> wrongVersion = blk;
            wrongVersion[4] = 1u;
            t.IsTrue(!socom2_bank::parse(wrongVersion.data(), wrongVersion.size(), bank), "version 1 (the 0x28-byte grain layout) is not this reader's");
            t.IsTrue(!socom2_bank::parse(blk.data(), 0x100u, bank), "a block cut before its sound table");
            t.IsTrue(!socom2_bank::parse(blk.data(), 0x40u, bank), "a block cut at the header");
        });

        tc.Run("decodeBlocks: shift 12 filter 0 reproduces the nibbles; the end flag stops the run; loop flags are reported", [](TestCase &t)
        {
            int8_t ramp[28];
            for (int i = 0; i < 28; ++i)
                ramp[i] = static_cast<int8_t>((i % 16) - 8);   // -8..7
            std::vector<uint8_t> data = block(12, 0, 0, ramp);
            const std::vector<uint8_t> second = block(12, 0, 0x01, ramp);   // end
            data.insert(data.end(), second.begin(), second.end());
            const std::vector<uint8_t> third = block(12, 0, 0, ramp);       // past the end: not decoded
            data.insert(data.end(), third.begin(), third.end());
            ps2_vag::BlockRun run;
            t.IsTrue(ps2_vag::decodeBlocks(data.data(), data.size(), run), "decodes");
            t.Equals(run.bytesConsumed, static_cast<size_t>(32u), "two blocks consumed: the end-flagged block is the last");
            t.Equals(run.pcm.size(), static_cast<size_t>(56u), "28 samples per block");
            bool same = run.pcm.size() == 56u;
            for (size_t i = 0; same && i < 56u; ++i)
                same = run.pcm[i] == static_cast<int16_t>(ramp[i % 28]);
            t.IsTrue(same, "shift 12, filter 0: each sample is its sign-extended nibble");
            t.IsTrue(!run.loops, "an end block without the repeat flag does not loop");

            std::vector<uint8_t> looped = block(12, 0, 0, ramp);
            const std::vector<uint8_t> loopStart = block(12, 0, 0x04, ramp);   // loop start
            looped.insert(looped.end(), loopStart.begin(), loopStart.end());
            const std::vector<uint8_t> loopEnd = block(12, 0, 0x03, ramp);     // end + repeat
            looped.insert(looped.end(), loopEnd.begin(), loopEnd.end());
            ps2_vag::BlockRun run2;
            t.IsTrue(ps2_vag::decodeBlocks(looped.data(), looped.size(), run2), "decodes the looped sample");
            t.IsTrue(run2.loops, "end + repeat: the sample loops");
            t.Equals(run2.loopStartSample, static_cast<size_t>(28u), "the loop starts at the flagged block's first sample");
            t.Equals(run2.bytesConsumed, static_cast<size_t>(48u), "three blocks");

            ps2_vag::BlockRun run3;
            t.IsTrue(!ps2_vag::decodeBlocks(data.data(), 15u, run3), "fewer than 16 bytes is not a block");
            ps2_vag::BlockRun run4;
            t.IsTrue(ps2_vag::decodeBlocks(third.data(), third.size(), run4) && run4.pcm.size() == 28u && !run4.loops, "no end flag inside maxBytes: decode what is there, no loop");
        });

        tc.Run("decodeBlocks: filter 1 accumulates the previous sample (the reference filter table)", [](TestCase &t)
        {
            int8_t ones[28];
            for (int i = 0; i < 28; ++i)
                ones[i] = 1;
            const std::vector<uint8_t> data = block(12, 1, 0x01, ones);
            ps2_vag::BlockRun run;
            t.IsTrue(ps2_vag::decodeBlocks(data.data(), data.size(), run), "decodes");
            // s[n] = 1 + (60 * s[n-1] + 32) / 64: 1, 2, 3, 4, 5, 6, 7, 8 for the first eight samples
            const int16_t expect[8] = {1, 2, 3, 4, 5, 6, 7, 8};
            bool ok = run.pcm.size() == 28u;
            for (int i = 0; ok && i < 8; ++i)
                ok = run.pcm[static_cast<size_t>(i)] == expect[i];
            t.IsTrue(ok, "the first eight samples follow the filter-1 recurrence");
        });

        tc.Run("the HUDUI VAG chunk: sound 0's first sample decodes to 158 blocks ending on the end flag, non-looping, audible", [](TestCase &t)
        {
            const std::vector<uint8_t> vag = readFixture("hudui_vag.bin");
            t.Equals(vag.size(), static_cast<size_t>(60928u), "fixture hudui_vag.bin is present");
            if (vag.size() < 0x3940u + 2528u)
                return;
            ps2_vag::BlockRun run;
            t.IsTrue(ps2_vag::decodeBlocks(vag.data() + 0x3940u, vag.size() - 0x3940u, run), "decodes");
            t.Equals(run.bytesConsumed, static_cast<size_t>(2528u), "158 blocks to the end flag");
            t.Equals(run.pcm.size(), static_cast<size_t>(158u * 28u), "4424 samples");
            t.IsTrue(!run.loops, "a one-shot HUD sound");
            int32_t peak = 0;
            for (int16_t s : run.pcm)
                peak = std::max<int32_t>(peak, s < 0 ? -s : s);
            t.IsTrue(peak > 2000, "the sample has signal (peak " + std::to_string(peak) + ")");
        });

        tc.Run("note2Pitch: the SPU pitch of note 60 against HUDUI's tones matches 2^(semitones/12) to a unit, PS1 notes scaled by 44100/48000", [](TestCase &t)
        {
            auto expect = [](int centerNote, int centerFine, int note, int fine, bool ps1) -> double
            {
                // sceSdNote2Pitch adds the center fine to the played fine (a tuning offset), so the interval is
                // (note - center) semitones plus (fine + centerFine) / 128.
                const double semis = (note - centerNote) + (fine + centerFine) / 128.0;
                double p = 4096.0 * std::pow(2.0, semis / 12.0);
                if (ps1)
                    p = std::floor(44100.0 * std::floor(p) / 48000.0);
                return p;
            };
            // HUDUI sound 0 tone 0: center -58 / 66 (negative: not a PS1 note), played at note 60
            const double e0 = expect(58, 66, 60, 0, false);
            const uint16_t p0 = snd989::note2Pitch(-58, 66, 60, 0);
            t.IsTrue(std::fabs(p0 - e0) <= 1.5, "center -58/66 at note 60: " + std::to_string(p0) + " vs " + std::to_string(e0));
            t.Equals(static_cast<int>(snd989::note2Pitch(-60, 0, 60, 0)), 0x1000, "note at its own center is unity");
            const double e1 = expect(99, 104, 60, 0, false);
            const uint16_t p1 = snd989::note2Pitch(-99, 104, 60, 0);
            t.IsTrue(std::fabs(p1 - e1) <= 1.5, "sound 16 tone: center -99/104 -> " + std::to_string(p1) + " vs " + std::to_string(e1));
            const double e2 = expect(60, 0, 60, 0, true);
            const uint16_t p2 = snd989::note2Pitch(60, 0, 60, 0);
            t.IsTrue(std::fabs(p2 - e2) <= 1.5, "a PS1 note (center >= 0) is scaled by 44100/48000: " + std::to_string(p2) + " vs " + std::to_string(e2));
            const double e3 = expect(58, 66, 62, 64, false);
            const uint16_t p3 = snd989::note2Pitch(-58, 66, 62, 64);
            t.IsTrue(std::fabs(p3 - e3) <= 1.5, "note 62 fine 64 (pitch mod applied by the caller): " + std::to_string(p3) + " vs " + std::to_string(e3));
        });

        tc.Run("Mixer: a HUDUI sound plays to its end and goes quiet; stop keys it off; volume and master volume gate it", [](TestCase &t)
        {
            const std::vector<uint8_t> blk = readFixture("hudui_block.bin");
            const std::vector<uint8_t> vag = readFixture("hudui_vag.bin");
            snd989::Mixer mixer;
            t.IsTrue(mixer.loadBank(0x00a00000u, blk.data(), blk.size(), vag.data(), vag.size()), "HUDUI loads");
            t.Equals(mixer.bankCount(), static_cast<size_t>(1u), "one bank");
            t.Equals(mixer.play(0x00a00001u, 8u, 0x400, -1, 0, 0), 0u, "an unknown bank plays nothing");
            t.Equals(mixer.play(0x00a00000u, 99u, 0x400, -1, 0, 0), 0u, "an out-of-range sound plays nothing");
            const uint32_t h = mixer.play(0x00a00000u, 8u, 0x400, -1, 0, 0);   // the HUD click: one TONE, one-shot
            t.IsTrue(h != 0u && (h >> 24) == 5u, "a bank-sound handle (type 5)");
            t.IsTrue(mixer.isPlaying(h), "playing right after play()");
            t.Equals(mixer.activeVoices(), static_cast<size_t>(1u), "one voice for the one tone");
            std::vector<int16_t> buf(2 * 4096);
            mixer.render(buf.data(), 4096);
            double sum = 0.0;
            int32_t peak = 0;
            for (int16_t s : buf)
            {
                sum += static_cast<double>(s) * s;
                peak = std::max<int32_t>(peak, s < 0 ? -s : s);
            }
            const double rms = std::sqrt(sum / buf.size());
            t.IsTrue(peak > 500, "the first 4096 frames carry the click (peak " + std::to_string(peak) + ")");
            t.IsTrue(rms > 50.0, "and its RMS is above the floor (" + std::to_string(rms) + ")");
            // sound 8's sample is 4424 samples at ~1.156x: about 3830 frames; the envelope's release follows. Two seconds is plenty.
            size_t framesUntilQuiet = 0;
            for (int i = 0; i < 24 && mixer.isPlaying(h); ++i)
            {
                mixer.render(buf.data(), 4096);
                framesUntilQuiet += 4096;
            }
            t.IsTrue(!mixer.isPlaying(h), "the one-shot ends on its own (" + std::to_string(framesUntilQuiet) + " more frames)");
            t.Equals(mixer.activeVoices(), static_cast<size_t>(0u), "no voice left");
            t.Equals(mixer.activeHandlers(), static_cast<size_t>(0u), "no handler left");

            // Stop: the voice releases and the handle dies within a second.
            const uint32_t h2 = mixer.play(0x00a00000u, 8u, 0x400, -1, 0, 0);
            mixer.render(buf.data(), 512);
            mixer.stop(h2);
            size_t after = 0;
            for (int i = 0; i < 12 && mixer.isPlaying(h2); ++i)
            {
                mixer.render(buf.data(), 4096);
                after += 4096;
            }
            t.IsTrue(!mixer.isPlaying(h2) && after <= 48000u, "stopped within a second of frames (" + std::to_string(after) + ")");

            // Volume 0 is silence; so is master volume 0 on the sound's group.
            const uint32_t h3 = mixer.play(0x00a00000u, 8u, 0, -1, 0, 0);
            mixer.render(buf.data(), 4096);
            int32_t peak3 = 0;
            for (int16_t s : buf)
                peak3 = std::max<int32_t>(peak3, s < 0 ? -s : s);
            t.Equals(peak3, 0, "vol 0: silence");
            mixer.stop(h3);
            mixer.stopAll();
            for (int i = 0; i < 12; ++i)
                mixer.render(buf.data(), 4096);
            mixer.setMasterVolume(16u, 0);
            const uint32_t h4 = mixer.play(0x00a00000u, 8u, 0x400, -1, 0, 0);
            mixer.render(buf.data(), 4096);
            int32_t peak4 = 0;
            for (int16_t s : buf)
                peak4 = std::max<int32_t>(peak4, s < 0 ? -s : s);
            t.Equals(peak4, 0, "master volume 0: silence");
            t.IsTrue(mixer.isPlaying(h4), "... but the sound still runs");
            mixer.setMasterVolume(16u, 0x400);
            mixer.stopAll();
        });

        tc.Run("Mixer: pan puts the sound left or right; the sound's own pan is the default; SetVolPan moves it", [](TestCase &t)
        {
            const std::vector<uint8_t> blk = readFixture("hudui_block.bin");
            const std::vector<uint8_t> vag = readFixture("hudui_vag.bin");
            snd989::Mixer mixer;
            mixer.loadBank(0x00a00000u, blk.data(), blk.size(), vag.data(), vag.size());
            auto energy = [&](int32_t pan, double &left, double &right)
            {
                const uint32_t h = mixer.play(0x00a00000u, 8u, 0x400, pan, 0, 0);
                std::vector<int16_t> buf(2 * 2048);
                mixer.render(buf.data(), 2048);
                left = right = 0.0;
                for (size_t i = 0; i < 2048; ++i)
                {
                    left += std::fabs(static_cast<double>(buf[2 * i]));
                    right += std::fabs(static_cast<double>(buf[2 * i + 1]));
                }
                mixer.stopAll();
                for (int i = 0; i < 12; ++i)
                    mixer.render(buf.data(), 2048);
                return h;
            };
            double l = 0, r = 0;
            energy(-1, l, r);   // sound 8's own pan is 0: centre
            t.IsTrue(l > 0 && r > 0 && std::fabs(l - r) < 0.05 * (l + r), "pan reset (-1) -> the sound's own pan 0: centred");
            energy(270, l, r);
            t.IsTrue(l > 4.0 * r, "pan 270 is hard left (L " + std::to_string(l) + " R " + std::to_string(r) + ")");
            energy(90, l, r);
            t.IsTrue(r > 4.0 * l, "pan 90 is hard right (L " + std::to_string(l) + " R " + std::to_string(r) + ")");
            energy(0x167, l, r);
            t.IsTrue(l > r && l < 2.0 * r, "pan 359 (the weapon bank's) is just left of centre");

            const uint32_t h = mixer.play(0x00a00000u, 8u, 0x400, 0, 0, 0);
            mixer.setVolPan(h, snd989::kVolDontChange, 270);
            std::vector<int16_t> buf(2 * 2048);
            mixer.render(buf.data(), 2048);
            l = r = 0.0;
            for (size_t i = 0; i < 2048; ++i)
            {
                l += std::fabs(static_cast<double>(buf[2 * i]));
                r += std::fabs(static_cast<double>(buf[2 * i + 1]));
            }
            t.IsTrue(l > 4.0 * r, "SetVolPan to 270 moved the playing sound hard left");
            mixer.stopAll();
        });

        tc.Run("Mixer: a multi-tone sound starts all its tones; pitch mod raises the pitch; unloadBank silences the bank", [](TestCase &t)
        {
            const std::vector<uint8_t> blk = readFixture("hudui_block.bin");
            const std::vector<uint8_t> vag = readFixture("hudui_vag.bin");
            snd989::Mixer mixer;
            mixer.loadBank(0x00a00000u, blk.data(), blk.size(), vag.data(), vag.size());
            const uint32_t h = mixer.play(0x00a00000u, 0u, 0x400, -1, 0, 0);   // four TONE grains, delay 0
            t.IsTrue(h != 0u, "sound 0 plays");
            t.Equals(mixer.activeVoices(), static_cast<size_t>(4u), "four voices, one per tone");
            mixer.stopAll();
            std::vector<int16_t> buf(2 * 4096);
            for (int i = 0; i < 12; ++i)
                mixer.render(buf.data(), 4096);
            t.Equals(mixer.activeVoices(), static_cast<size_t>(0u), "stopAll released every voice");

            // Pitch mod +1200 (12 semitones in 1/128 units = 1536) plays the one-shot in about half the frames.
            auto framesToEnd = [&](int32_t pm)
            {
                const uint32_t hh = mixer.play(0x00a00000u, 8u, 0x400, -1, pm, 0);
                size_t frames = 0;
                while (mixer.isPlaying(hh) && frames < 48000u * 4u)
                {
                    mixer.render(buf.data(), 256);
                    frames += 256;
                }
                return frames;
            };
            const size_t f0 = framesToEnd(0);
            const size_t f1 = framesToEnd(1536);
            t.IsTrue(f1 < f0 && f1 > f0 / 4, "an octave up ends in about half the frames (" + std::to_string(f1) + " vs " + std::to_string(f0) + ")");

            const uint32_t h5 = mixer.play(0x00a00000u, 8u, 0x400, -1, 0, 0);
            mixer.unloadBank(0x00a00000u);
            t.Equals(mixer.bankCount(), static_cast<size_t>(0u), "bank gone");
            t.IsTrue(!mixer.isPlaying(h5), "its sounds stop with it");
            t.Equals(mixer.play(0x00a00000u, 8u, 0x400, -1, 0, 0), 0u, "and it no longer plays");
        });

        tc.Run("Mixer: a conductor sound starts and stops child sounds, tests a global register and jumps to markers (Sprint 9 Q0)", [](TestCase &t)
        {
            const std::vector<uint8_t> hud = readFixture("hudui_block.bin");
            const std::vector<uint8_t> vag = readFixture("hudui_vag.bin");
            socom2_bank::Bank hudui;
            t.IsTrue(socom2_bank::parse(hud.data(), hud.size(), hudui) && hudui.sounds.size() > 8u, "HUDUI parses");
            socom2_bank::Tone click;
            t.IsTrue(hudui.tone(hudui.sounds[8].grains[0], click), "sound 8's tone is the sample the children play");
            const std::vector<uint8_t> blk = conductorBlock(click);
            socom2_bank::Bank cond;
            t.IsTrue(socom2_bank::parse(blk.data(), blk.size(), cond), "the hand-built block parses");
            t.Equals(cond.sounds.size(), static_cast<size_t>(3u), "three sounds");
            t.Equals(cond.sounds[0].grains.size(), static_cast<size_t>(12u), "the conductor's twelve grains");
            t.Equals(cond.name, std::string("COND"), "its name");

            snd989::Mixer mixer;
            t.IsTrue(mixer.loadBank(0x00a30000u, blk.data(), blk.size(), vag.data(), vag.size()), "loads with HUDUI's samples");
            std::vector<int16_t> buf(2 * 4096);

            // Global 2 below 5: child 1 is started and stopped again before it joins; the conductor idles in its loop, alive.
            mixer.setGlobalReg(2u, 0);
            const uint32_t idle = mixer.play(0x00a30000u, 0u, 0x400, -1, 0, 0);
            t.IsTrue(idle != 0u && mixer.isPlaying(idle), "the conductor plays");
            t.Equals(mixer.activeChildren(idle), static_cast<size_t>(0u), "global 2 = 0: the one child was started and stopped at once");
            t.Equals(mixer.activeVoices(), static_cast<size_t>(0u), "no voice: it never played");
            for (int i = 0; i < 12; ++i)
                mixer.render(buf.data(), 4096);
            t.IsTrue(mixer.isPlaying(idle), "the conductor loops on, alive with no voice of its own (the game polls it and never restarts it)");
            mixer.stop(idle);
            mixer.render(buf.data(), 4096);
            t.IsTrue(!mixer.isPlaying(idle), "stop ends it");

            // Global 2 at 6: the test passes, register 0 is set, both children run; the second's tone reads its
            // volume (-1) from register 0, copied from the conductor at the start.
            mixer.setGlobalReg(2u, 6);
            t.Equals(mixer.globalReg(2u), 6, "the global reads back");
            const uint32_t h = mixer.play(0x00a30000u, 0u, 0x400, -1, 0, 0);
            t.Equals(mixer.activeChildren(h), static_cast<size_t>(2u), "global 2 = 6: two children");
            const uint32_t c0 = mixer.childSound(h, 0), c1 = mixer.childSound(h, 1);
            t.IsTrue((c0 == 1u && c1 == 2u) || (c0 == 2u && c1 == 1u), "sounds 1 and 2 (" + std::to_string(c0) + ", " + std::to_string(c1) + ")");
            t.Equals(mixer.activeVoices(), static_cast<size_t>(2u), "one voice each");
            mixer.render(buf.data(), 4096);
            int32_t peak = 0;
            for (int16_t s : buf)
                peak = std::max<int32_t>(peak, s < 0 ? -s : s);
            t.IsTrue(peak > 500, "the children are audible (peak " + std::to_string(peak) + ")");
            t.IsTrue(mixer.isPlaying(h), "the conductor is alive");
            // Stopping the conductor stops its children with it.
            mixer.stop(h);
            for (int i = 0; i < 12; ++i)
                mixer.render(buf.data(), 4096);
            t.IsTrue(!mixer.isPlaying(h), "stopped");
            t.Equals(mixer.activeChildren(h), static_cast<size_t>(0u), "no child survives its conductor");
            t.Equals(mixer.activeHandlers(), static_cast<size_t>(0u), "nothing left");

            // Register sentinel: register 0 = 0 makes child 2's tone silent while child 1 still sounds.
            // (Played with the conductor's branch that sets the register, then the register re-set by hand is not
            // reachable; instead play sound 2 directly: its tone's Vol -1 reads the handler's register 0, which a
            // sound the game plays starts at 0.)
            const uint32_t direct = mixer.play(0x00a30000u, 2u, 0x400, -1, 0, 0);
            t.IsTrue(direct != 0u, "sound 2 plays on its own");
            mixer.render(buf.data(), 4096);
            int32_t peak2 = 0;
            for (int16_t s : buf)
                peak2 = std::max<int32_t>(peak2, s < 0 ? -s : s);
            t.Equals(peak2, 0, "with register 0 at 0 its tone is silent: the sentinel resolved to the register, not to a negative volume");
            mixer.stopAll();
        });

        tc.Run("the M51 ambience conductor (bank M51_AM sound 0x31, cut from the disc): global 2 selects the child set (Sprint 9 Q0)", [](TestCase &t)
        {
            // The parity check's finding: the console plays a continuous bed at the mission start that ours did not
            // -- this sound, whose grains are START/STOP_CHILD_SOUND, TEST_REGISTER, GOTO_MARKER and LOOP. With no
            // VAG chunk the children's tones find no sample; the programs still run and the child set is visible.
            const std::vector<uint8_t> blk = readFixture("m51_am_block.bin");
            t.Equals(blk.size(), static_cast<size_t>(25968u), "fixture m51_am_block.bin is present (25968 bytes)");
            socom2_bank::Bank bank;
            t.IsTrue(socom2_bank::parse(blk.data(), blk.size(), bank), "parses");
            t.Equals(bank.name, std::string("M51_AM"), "the block name");
            t.Equals(bank.sounds.size(), static_cast<size_t>(123u), "123 sounds");
            t.Equals(bank.sounds[0x31].grains.size(), static_cast<size_t>(33u), "the conductor's 33 grains");
            t.Equals(static_cast<int>(bank.sounds[0x31].grains[0].type), static_cast<int>(socom2_bank::kStartChild), "its first grain starts a child");

            static const uint8_t none[1] = {0u};
            snd989::Mixer mixer;
            t.IsTrue(mixer.loadBank(0x00a30000u, blk.data(), blk.size(), none, 0u), "loads without its samples");
            auto childSet = [&](int32_t global2) {
                mixer.setGlobalReg(2u, global2);
                const uint32_t h = mixer.play(0x00a30000u, 0x31u, 0x400, -1, 0, 0);
                std::vector<uint32_t> sounds;
                for (size_t i = 0; i < mixer.activeChildren(h); ++i)
                    sounds.push_back(mixer.childSound(h, i));
                std::sort(sounds.begin(), sounds.end());
                mixer.stop(h);
                std::vector<int16_t> buf(2 * 512);
                mixer.render(buf.data(), 512);
                return sounds;
            };
            const std::vector<uint32_t> day = childSet(6);   // what the game writes to global 2 through the first mission
            t.Equals(day.size(), static_cast<size_t>(8u), "global 2 = 6: eight children");
            t.IsTrue(day.size() == 8u && day[0] == 0x32u && day[6] == 0x38u && day[7] == 0x52u, "sounds 0x32..0x38 and 0x52 -- the bed, the birds, the insects");
            const std::vector<uint32_t> other = childSet(40);
            t.Equals(other.size(), static_cast<size_t>(2u), "global 2 = 40 (the register test's other side): two children");
            t.IsTrue(other.size() == 2u && other[0] == 0x52u && other[1] == 0x73u, "sounds 0x52 and 0x73");
            t.Equals(mixer.activeHandlers(), static_cast<size_t>(0u), "every conductor and child stopped");
        });

        tc.Run("PS2AudioBackend routes snd_SetGlobalReg into the mixer (Sprint 9 Q0)", [](TestCase &t)
        {
            PS2AudioBackend backend;
            const int32_t reg[2] = {2, 6};
            backend.onNotify(0x67u, reg, 2u);
            t.Equals(backend.mixerGlobalReg(2u), 6, "global 2 reads back as 6");
            const int32_t bad[2] = {0, 9};
            backend.onNotify(0x67u, bad, 2u);
            t.Equals(backend.mixerGlobalReg(0u), 0, "index 0 is not a register (the API counts from 1)");
        });

        tc.Run("PS2AudioBackend routes a bank and the play family from the IOP module into the mixer", [](TestCase &t)
        {
            const std::vector<uint8_t> blk = readFixture("hudui_block.bin");
            const std::vector<uint8_t> vag = readFixture("hudui_vag.bin");
            PS2AudioBackend backend;   // no audio device: the mix stream stays closed, the mixer still runs
            backend.onBankLoaded(0x00a00000u, blk.data(), blk.size(), vag.data(), vag.size());
            const int32_t play[7] = {0x05010001, 0x00a00000, 8, 0x400, -1, 0, 0};   // the module's handle first
            backend.onNotify(0x12u, play, 7u);
            t.Equals(backend.mixerActiveVoices(), static_cast<size_t>(1u), "snd_PlaySoundVolPanPMPBNoReturn started the tone");
            t.IsTrue(backend.mixerIsPlaying(0x05010001u), "under the module's handle");
            std::vector<int16_t> buf(2 * 4096);   // sized for the largest render below (a 2048 buffer overflowed the heap, 2026-09-17)
            backend.mixerRender(buf.data(), 2048);
            int32_t peak = 0;
            for (int16_t v : buf)
                peak = std::max<int32_t>(peak, v < 0 ? -v : v);
            t.IsTrue(peak > 500, "the mix has signal");
            const int32_t stop[1] = {0x05010001};
            backend.onNotify(0x15u, stop, 1u);
            for (int i = 0; i < 12; ++i)
                backend.mixerRender(buf.data(), 4096);
            t.IsTrue(!backend.mixerIsPlaying(0x05010001u), "snd_StopSound keyed it off");
            const int32_t unload[1] = {0x00a00000};
            backend.onNotify(0x06u, unload, 1u);
            backend.onNotify(0x12u, play, 7u);
            t.Equals(backend.mixerActiveVoices(), static_cast<size_t>(0u), "after snd_UnloadBank the bank plays nothing");
        });

        // Sprint 9 Goal 10 (R169), the owner's 2026-09-19 mission: "the music... jumping between different tracks...
        // glitched between different samples". snd_PlayVAGStreamByLoc's parentHandle means QUEUE -- research/06
        // section 142, "if parentHandle != 0 the stream is queued after that stream instead" -- but the IOP module
        // reused the parent's slot AND its handle, and a play on a live handle replaced what was there. So the very
        // act of queueing the next segment of an adaptive score cut the playing one dead mid-sample. A queued
        // segment must wait, and then start on the next output frame after its parent's last, with no gap.
        tc.Run("Mixer: a queued stream waits for its parent and starts on the next frame after it, sample-accurate", [](TestCase &t)
        {
            const std::string loud = tmpPath("socom2_audio_queue_a.vpk");
            const std::string quiet = tmpPath("socom2_audio_queue_b.vpk");
            // Two chunk pairs each: 2 x 128 blocks x 28 samples = 7168 samples at 32 kHz = 224 ms, 10752 frames at
            // 48 kHz. Shift 2 decodes loud, shift 12 quiet: the level says WHICH segment is playing.
            t.IsTrue(writeVpk(loud, 2, 2), "the parent VPK (loud)");
            t.IsTrue(writeVpk(quiet, 2, 12), "the queued VPK (quiet)");
            snd989::Mixer mixer;
            const uint32_t h = 0x04000011u;
            t.IsTrue(mixer.playStream(h, loud, 0u, 0x400, -1, 1u), "the parent plays");
            mixer.pumpStreams();
            std::vector<int16_t> buf(2 * 1200);
            auto peak = [&buf](size_t frames) {
                int32_t p = 0;
                for (size_t i = 0; i < frames * 2; ++i)
                    p = std::max(p, std::abs(static_cast<int32_t>(buf[i])));
                return p;
            };
            mixer.render(buf.data(), 1200);            // 25 ms of the parent
            const int32_t parentPeak = peak(1200);
            t.IsTrue(parentPeak > 200, "the parent is audible before anything is queued (peak " + std::to_string(parentPeak) + ")");

            // The game queues the next segment on the SAME handle while the parent still plays.
            t.IsTrue(mixer.playStream(h, quiet, 0u, 0x400, -1, 1u, true), "the next segment queues behind it");
            mixer.pumpStreams();
            t.Equals(mixer.activeStreams(), static_cast<size_t>(1u), "one stream is playing, not two: the queued one waits");
            mixer.render(buf.data(), 1200);            // 25 ms more -- still the parent, untouched
            const int32_t afterQueue = peak(1200);
            t.IsTrue(afterQueue > parentPeak / 2, "queueing does not cut the parent dead (peak " + std::to_string(afterQueue) +
                                                      " against " + std::to_string(parentPeak) + ")");

            // Play both out, window by window, and find the seam: the level drops to the quiet segment's and
            // NOTHING is silent in between.
            int32_t silentWindows = 0, quietWindows = 0;
            size_t frames = 2400;
            bool sawQuiet = false;
            while (mixer.isPlaying(h) && frames < 96000u)
            {
                mixer.pumpStreams();
                mixer.render(buf.data(), 1200);
                frames += 1200;
                const int32_t p = peak(1200);
                if (p == 0)
                    ++silentWindows;
                else if (p < parentPeak / 8)
                {
                    ++quietWindows;
                    sawQuiet = true;
                }
            }
            t.IsTrue(sawQuiet, "the queued segment did play: the level dropped to its own (" + std::to_string(quietWindows) + " windows)");
            t.Equals(silentWindows, 0, "and there is no silence at the seam: the queued segment starts on the next frame");
            // 224 ms + 224 ms at 32 kHz = 21504 frames at 48 kHz, in 1200-frame windows.
            t.IsTrue(frames >= 19000u && frames <= 24000u,
                     "both segments played, one after the other (" + std::to_string(frames) + " frames)");
            t.IsTrue(!mixer.isPlaying(h), "and the handle is done only when the queue is empty");
            t.Equals(mixer.activeStreams(), static_cast<size_t>(0u), "no stream left");

            // A stop while a segment is queued stops the whole chain -- stop means stop, not "skip to the next".
            t.IsTrue(mixer.playStream(h, loud, 0u, 0x400, -1, 1u), "a parent again");
            t.IsTrue(mixer.playStream(h, quiet, 0u, 0x400, -1, 1u, true), "with one queued behind it");
            mixer.stop(h);
            t.IsTrue(!mixer.isPlaying(h), "stop ends the handle");
            t.Equals(mixer.activeStreams(), static_cast<size_t>(0u), "and takes the queued segment with it");
            std::remove(loud.c_str());
            std::remove(quiet.c_str());
        });

        // Sprint 9 Q0 (2026-09-20): the owner failed playtest-1 on the mission music with the original symptoms
        // intact, and the driven capture that had been called clean turned out to be blind to the two things that
        // matter. The mission's music is ~4-second VPK stems (2.6-4.3 s each, read off the disc headers) that the
        // game chains by polling snd_SoundIsStillPlaying and starting the next stem the moment we answer "done" --
        // so every four seconds the music crosses a stem boundary, and a hole there is "skips" exactly. Nothing
        // stamped a stem's start or end, and a starved stream (the ring empty, the worker behind) played silence
        // and counted NOTHING. This is the instrument: every stream start, end and underrun is reported on the
        // mixer's own output-frame clock -- the clock the PS2X_AUDIO_DUMP WAV is written on -- so a boundary is a
        // WAV offset a person can open, and a starved stem is a number instead of a feeling.
        tc.Run("Mixer: stream start, end and underrun are reported on the output-frame clock the dump is written on", [](TestCase &t)
        {
            const std::string two = tmpPath("socom2_audio_clock_a.vpk");
            t.IsTrue(writeVpk(two, 2, 2), "a two-chunk-pair VPK: 7168 samples at 32 kHz, 10752 output frames at 48 kHz");
            // The sink's vector outlives the mixer: ~Mixer stops every live stream and emits its Done into the
            // sink, so a vector declared after the mixer is already gone by then (glibc: "double free", CI 2026-09-20).
            std::vector<snd989::StreamEvent> events;
            snd989::Mixer mixer;
            mixer.setStreamEventSink([&events](const snd989::StreamEvent &e) { events.push_back(e); });
            std::vector<int16_t> buf(2 * 1200);

            // Some silence first, so a start frame of 0 cannot pass by accident.
            mixer.render(buf.data(), 1200);
            mixer.render(buf.data(), 1200);
            t.Equals(mixer.renderedFrames(), static_cast<uint64_t>(2400u), "the clock counts what render was asked for");

            const uint32_t h = 0x04000021u;
            t.IsTrue(mixer.playStream(h, two, 0u, 0x400, -1, 1u), "the stem plays");
            mixer.pumpStreams();
            size_t calls = 0;
            while (mixer.isPlaying(h) && calls < 40)
            {
                mixer.render(buf.data(), 1200);
                ++calls;
            }
            t.IsFalse(mixer.isPlaying(h), "the stem played out");

            size_t starts = 0, dones = 0, underruns = 0;
            uint64_t startFrame = 0, doneFrame = 0;
            for (const snd989::StreamEvent &e : events)
            {
                if (e.handle != h) continue;
                if (e.kind == snd989::StreamEvent::Start) { ++starts; startFrame = e.frame; }
                if (e.kind == snd989::StreamEvent::Done) { ++dones; doneFrame = e.frame; }
                if (e.kind == snd989::StreamEvent::Underrun) ++underruns;
            }
            t.Equals(starts, static_cast<size_t>(1u), "one start");
            t.Equals(dones, static_cast<size_t>(1u), "one end");
            t.Equals(underruns, static_cast<size_t>(0u), "and, with the ring kept full, no underrun");
            t.Equals(startFrame, static_cast<uint64_t>(2400u), "the start is stamped with the frames rendered before it -- its WAV offset");
            // The end is reported in the very render call where the data ran out: the stem is 10752 frames long,
            // so its last sample lands in the call that begins at frame 2400 + 9600 = 12000 and covers 12000..13199.
            t.IsTrue(doneFrame >= 2400u + 10752u - 1200u && doneFrame < 2400u + 10752u + 1200u,
                     "the end is stamped within one render call of the last sample (done at frame " + std::to_string(doneFrame) + ")");
        });

        tc.Run("Mixer: a starved stream reports every underrun with its frame, stretches by exactly the starved frames, and is not 'done'", [](TestCase &t)
        {
            // Longer than the ring, so pumping once cannot hold the whole stem.
            const std::string longStem = tmpPath("socom2_audio_clock_b.vpk");
            t.IsTrue(writeVpk(longStem, 12, 2), "a twelve-chunk-pair VPK");
            // The sink's vector outlives the mixer: ~Mixer stops every live stream and emits its Done into the
            // sink, so a vector declared after the mixer is already gone by then (glibc: "double free", CI 2026-09-20).
            std::vector<snd989::StreamEvent> events;
            snd989::Mixer mixer;
            mixer.setStreamEventSink([&events](const snd989::StreamEvent &e) { events.push_back(e); });
            std::vector<int16_t> buf(2 * 1200);
            const uint32_t h = 0x04000022u;
            t.IsTrue(mixer.playStream(h, longStem, 0u, 0x400, -1, 1u), "the stem plays");
            mixer.pumpStreams();   // the ring fills to its depth, and then the worker "falls behind" -- we never pump again

            size_t calls = 0;
            while (mixer.isPlaying(h) && calls < 200)
            {
                mixer.render(buf.data(), 1200);
                ++calls;
            }
            t.IsTrue(mixer.isPlaying(h), "a stream whose ring ran dry before its data did is NOT done -- it is waiting");
            size_t underruns = 0;
            uint64_t firstUnderrun = 0;
            for (const snd989::StreamEvent &e : events)
                if (e.handle == h && e.kind == snd989::StreamEvent::Underrun)
                {
                    if (underruns == 0) firstUnderrun = e.frame;
                    ++underruns;
                }
            t.IsTrue(underruns >= 1u, "the starvation was reported (" + std::to_string(underruns) + " underrun events)");
            t.IsTrue(firstUnderrun > 0u && firstUnderrun < 200u * 1200u, "with the frame it began at");

            // The worker catches up: the stream resumes from where it stopped and plays to its end.
            const uint64_t starvedUntil = mixer.renderedFrames();
            mixer.pumpStreams();
            calls = 0;
            while (mixer.isPlaying(h) && calls < 200)
            {
                if (calls % 4 == 3) mixer.pumpStreams();   // keep it fed from here on
                mixer.render(buf.data(), 1200);
                ++calls;
            }
            t.IsFalse(mixer.isPlaying(h), "fed again, it plays out");
            uint64_t startFrame = 0, doneFrame = 0, reportedSilent = 0, summedSilent = 0;
            for (const snd989::StreamEvent &e : events)
            {
                if (e.handle != h) continue;
                if (e.kind == snd989::StreamEvent::Start) startFrame = e.frame;
                if (e.kind == snd989::StreamEvent::Done) { doneFrame = e.frame; reportedSilent = e.detail; }
                if (e.kind == snd989::StreamEvent::Underrun) summedSilent += e.detail;
            }
            // 12 chunk pairs = 43008 samples at 32 kHz = 64512 output frames. The stem took longer than that by
            // exactly the frames it spent starved -- the audible stall, now a number the Done event carries.
            const uint64_t nominal = 64512u;
            (void)starvedUntil; (void)firstUnderrun;
            t.Equals(reportedSilent, summedSilent, "the Done event's total is the sum of the underruns it reported");
            const uint64_t took = doneFrame - startFrame;
            const uint64_t expect = nominal + reportedSilent;
            t.IsTrue(took + 1200u >= expect && took <= expect + 1200u,
                     "the stem stretched by its starved frames, to within one render call (took " + std::to_string(took) +
                         ", nominal " + std::to_string(nominal) + " + starved " + std::to_string(reportedSilent) + ")");
        });

        // Sprint 9 Q0 (2026-09-20). The game starts its positioned voice streams SILENT -- snd_PlayVAGStreamByLoc with
        // vol 0, flags 2, a pan in degrees -- and then raises them with snd_SetSoundParams(handle, mask bit0, vol, pan),
        // one call per stream in the driven mission's first 30 s. Mixer::setVolPan looked up only bank handlers, so on
        // a stream handle it returned at find() and the line stayed silent. The PCSX2 reference has voices where ours
        // has nothing; this is one of the mechanisms.
        tc.Run("Mixer: snd_SetSoundParams reaches a STREAM handle -- a stream started at vol 0 becomes audible when the game raises it", [](TestCase &t)
        {
            const std::string clip = tmpPath("socom2_audio_volpan_stream.vpk");
            t.IsTrue(writeVpk(clip, 4, 2), "a loud four-chunk-pair VPK");
            snd989::Mixer mixer;
            const uint32_t h = 0x04000041u;
            t.IsTrue(mixer.playStream(h, clip, 0u, 0, -1, 2u), "the stream plays, at vol 0 as the game asks");
            mixer.pumpStreams();
            std::vector<int16_t> buf(2 * 1200);
            auto peak = [&buf]() {
                int32_t p = 0;
                for (int16_t v : buf) p = std::max(p, std::abs(static_cast<int32_t>(v)));
                return p;
            };
            mixer.render(buf.data(), 1200);
            t.IsTrue(peak() < 8, "silent at vol 0 (peak " + std::to_string(peak()) + ")");

            mixer.setVolPan(h, 0x400, snd989::kPanDontChange);   // the game's snd_SetSoundParams, mask bit0
            mixer.pumpStreams();
            mixer.render(buf.data(), 1200);
            const int32_t raised = peak();
            t.IsTrue(raised > 200, "audible once the game raises it (peak " + std::to_string(raised) + ")");

            // The clip is two-channel: its left channel is a rising ramp, its right the same ramp negated, so at
            // the default pan (the IRX's voice pair at 270 / its mirror) the two outputs differ.
            int32_t differ = 0;
            for (size_t i = 0; i < 1200; ++i)
                differ = std::max(differ, std::abs(static_cast<int32_t>(buf[i * 2]) - static_cast<int32_t>(buf[i * 2 + 1])));
            t.IsTrue(differ > 100, "at the default pan the two channels come out on their own sides (max |L-R| " + std::to_string(differ) + ")");
            // research/36 item 7: a pan-only call on a two-channel stream ROTATES the IRX's voice pair (left data at
            // 270 + p, right data mirrored): at p = 90 both voices land on the pan table's centre entry, so the
            // two outputs become the same mix -- not "hard right", which a stereo pair cannot be.
            mixer.setVolPan(h, snd989::kVolDontChange, 90);   // pan-only: the volume left alone
            mixer.pumpStreams();
            mixer.render(buf.data(), 1200);
            int32_t same = 0;
            for (size_t i = 0; i < 1200; ++i)
                same = std::max(same, std::abs(static_cast<int32_t>(buf[i * 2]) - static_cast<int32_t>(buf[i * 2 + 1])));
            t.IsTrue(same <= 2, "and a pan of 90 collapses the pair to the centre: identical outputs (max |L-R| " + std::to_string(same) + ")");
        });
        // Sprint 9 Q0 (2026-09-20): the device buffer. The traced mission run put 41 sub-second dropouts a minute at the
        // owner's speaker that the pre-device dump did not have -- the device thread missing a 10 ms deadline under
        // gameplay load (raylib's miniaudio defaults: 10 ms x 3). PCSX2 on the same endpoint, 20 ms with stretch: none.
        // The spec is pinned here so the number cannot drift back without this test noticing.
        tc.Run("the mix device's buffer is at least 60 ms in periods of at least 20 ms, at the mixer's own rate and width", [](TestCase &t)
        {
            const ps2x::MixDeviceSpec d = ps2x::mixDeviceSpec();
            t.Equals(d.sampleRate, static_cast<uint32_t>(snd989::kSampleRate), "the device runs at the mixer's rate: no resampling between them");
            t.Equals(d.channels, 2u, "stereo");
            t.IsTrue(d.periodMs >= 20u, "a period of at least 20 ms (raylib's 10 ms missed ~40 times a minute under load; got " + std::to_string(d.periodMs) + ")");
            t.IsTrue(d.bufferMs() >= 60u, "at least 60 ms of buffer in flight (got " + std::to_string(d.bufferMs()) + " ms)");
            t.IsTrue(d.bufferMs() <= 200u, "and not so much that the game's own timing drifts audibly (got " + std::to_string(d.bufferMs()) + " ms)");
        });
        // Sprint 9 Q0 (2026-09-20, the owner's second listen): every stream's FIRST callback found the ring empty --
        // 21 underruns in the owner's run, one per stream start, 20 ms each (one device period) -- because the push
        // happens on the RPC thread and the worker fills the ring on its own 10 ms cadence. A stem that starts on
        // the heels of another therefore opens with a 20 ms hole, and a voice line starts 20 ms late: the owner's
        // "stuttering, skipping a bit". The push decodes the first chunk pair itself, so the first render has data.
        tc.Run("Mixer: a stream has sound in its very first render call, before any worker pump", [](TestCase &t)
        {
            const std::string clip = tmpPath("socom2_audio_prefill.vpk");
            t.IsTrue(writeVpk(clip, 4, 2), "a loud four-chunk-pair VPK");
            // The sink's vector outlives the mixer: ~Mixer stops every live stream and emits its Done into the
            // sink, so a vector declared after the mixer is already gone by then (glibc: "double free", CI 2026-09-20).
            std::vector<snd989::StreamEvent> events;
            snd989::Mixer mixer;
            mixer.setStreamEventSink([&events](const snd989::StreamEvent &e) { events.push_back(e); });
            const uint32_t h = 0x04000051u;
            t.IsTrue(mixer.playStream(h, clip, 0u, 0x400, -1, 1u), "the stream plays");
            // No pumpStreams() here: this is the callback that lands before the worker has run.
            std::vector<int16_t> buf(2 * 960);
            mixer.render(buf.data(), 960);
            int32_t peak = 0;
            for (int16_t v : buf) peak = std::max(peak, std::abs(static_cast<int32_t>(v)));
            t.IsTrue(peak > 200, "the first 20 ms render already carries the stream (peak " + std::to_string(peak) + ")");
            size_t underruns = 0;
            for (const snd989::StreamEvent &e : events) if (e.handle == h && e.kind == snd989::StreamEvent::Underrun) ++underruns;
            t.Equals(underruns, static_cast<size_t>(0u), "and no underrun was reported for it");
        });
        // Sprint 9 Goal 10 (R170): the other half of the owner's sentence -- "getting louder and quieter". A
        // fade belongs to the cue it was asked for, not to the handle for ever. stop() and setVolPan() already
        // drop a handle's ramp; playStream did not, and dropDeadRamps keeps a ramp alive while ANY stream
        // carries the handle. So the game faded a cue out with snd_AutoVol(h, 0, 0x168, 2) and started the next
        // one on h, and the new cue picked up a fade already part way to silence: it began quiet and got
        // quieter, while every cue measured perfect on its own.
        tc.Run("Mixer: a new cue on a handle starts at its own volume, never on the fade that ended the one before", [](TestCase &t)
        {
            const std::string a = tmpPath("socom2_audio_ramp_a.vpk");
            const std::string b = tmpPath("socom2_audio_ramp_b.vpk");
            t.IsTrue(writeVpk(a, 6, 2), "a 672 ms parent");
            t.IsTrue(writeVpk(b, 6, 2), "and an equally loud successor");
            std::vector<int16_t> buf(2 * 1200);
            auto peak = [&buf](size_t frames) {
                int32_t p = 0;
                for (size_t i = 0; i < frames * 2; ++i)
                    p = std::max(p, std::abs(static_cast<int32_t>(buf[i])));
                return p;
            };
            const uint32_t h = 0x04000021u;

            // (a) A play that REPLACES what the handle was playing.
            snd989::Mixer mixer;
            t.IsTrue(mixer.playStream(h, a, 0u, 0x400, -1, 1u), "the first cue plays");
            mixer.pumpStreams();
            mixer.render(buf.data(), 1200);
            const int32_t full = peak(1200);
            t.IsTrue(full > 200, "at its own level (peak " + std::to_string(full) + ")");
            mixer.autoVol(h, 0, 240, 2);               // the game's fade: to silence over 240 ticks = 1 s
            for (int i = 0; i < 20; ++i)               // 24000 frames = 120 ticks: half way down
            {
                mixer.pumpStreams();
                mixer.render(buf.data(), 1200);
            }
            const int32_t faded = peak(1200);
            t.IsTrue(faded < full * 3 / 4, "the fade is in force (peak " + std::to_string(faded) + " against " + std::to_string(full) + ")");
            t.IsTrue(mixer.playStream(h, b, 0u, 0x400, -1, 1u), "the next cue takes the handle");
            mixer.pumpStreams();
            mixer.render(buf.data(), 1200);
            const int32_t fresh = peak(1200);
            t.IsTrue(fresh > full * 4 / 5, "and it starts at ITS volume, not on the dead cue's fade (peak " +
                                               std::to_string(fresh) + " against " + std::to_string(full) + ")");

            // (b) The same, queued: the parent must keep fading (the fade is its own), and the segment that
            // takes over afterwards must start clean.
            snd989::Mixer m2;
            const std::string shortA = tmpPath("socom2_audio_ramp_short.vpk");
            t.IsTrue(writeVpk(shortA, 2, 2), "a 224 ms parent to fade out and run out");
            t.IsTrue(m2.playStream(h, shortA, 0u, 0x400, -1, 1u), "the parent plays");
            m2.pumpStreams();
            m2.render(buf.data(), 1200);
            const int32_t full2 = peak(1200);
            t.IsTrue(m2.playStream(h, b, 0u, 0x400, -1, 1u, true), "the next segment is queued behind it");
            m2.autoVol(h, 0, 30, 2);                   // fade the PARENT out over 30 ticks = 6000 frames
            m2.pumpStreams();
            m2.render(buf.data(), 1200);
            const int32_t stillParent = peak(1200);
            t.IsTrue(stillParent > 0, "queueing does not silence the parent mid-fade (peak " + std::to_string(stillParent) + ")");
            int32_t afterSeam = 0;
            for (int i = 0; i < 20 && afterSeam == 0; ++i)   // past the parent's 10752 frames: the seam
            {
                m2.pumpStreams();
                m2.render(buf.data(), 1200);
                if (i >= 9)
                    afterSeam = std::max(afterSeam, peak(1200));
            }
            t.IsTrue(afterSeam > full2 * 4 / 5, "the queued segment starts at its own volume, not on the fade that ended its parent (peak " +
                                                    std::to_string(afterSeam) + " against " + std::to_string(full2) + ")");
            std::remove(a.c_str());
            std::remove(b.c_str());
            std::remove(shortA.c_str());
        });

        // Sprint 9 Goal 10 (R171): the same symptom between menus and on entering a lobby. The bank decoder has
        // always read the VAG flags properly -- bit 2 marks the loop start, bit 0 ends the run, bit 1 says the
        // run repeats (ps2_audio_vag.cpp) -- but the STREAM decoder ended on bit 0 alone and had nowhere to
        // remember a loop start. A looping cue therefore stopped at its first loop point and the game re-fired
        // it: a jump, in the two places the mission's queue bugs cannot reach.
        tc.Run("Mixer: a stream whose data says it repeats loops at its loop start instead of ending", [](TestCase &t)
        {
            // A mono VPK of two 0x800 chunks: chunk 0 loud, chunk 1 quiet, the loop start marked at the first
            // block of chunk 1 and the last block carrying end|repeat. Played out it should be loud once and
            // quiet for ever after -- which also proves it loops to the MARK, not to the beginning.
            const std::string path = tmpPath("socom2_audio_loop.vpk");
            int8_t ramp[28];
            for (int i = 0; i < 28; ++i)
                ramp[i] = static_cast<int8_t>(i % 8);
            std::vector<uint8_t> file(0xB0, 0u);
            auto put32 = [&](size_t at, uint32_t v) { file[at] = static_cast<uint8_t>(v); file[at + 1] = static_cast<uint8_t>(v >> 8); file[at + 2] = static_cast<uint8_t>(v >> 16); file[at + 3] = static_cast<uint8_t>(v >> 24); };
            std::memcpy(file.data(), " KPV", 4);
            put32(4, 2u * 0x800u);
            put32(8, 0x800u);
            put32(12, 0xB0u);
            put32(16, 32000u);
            put32(20, 1u);
            for (int c = 0; c < 2; ++c)
                for (int b = 0; b < 0x800 / 16; ++b)
                {
                    uint8_t flags = 0x00;
                    if (c == 1 && b == 0)
                        flags = 0x04;                        // the loop starts here
                    if (c == 1 && b == 0x800 / 16 - 1)
                        flags = 0x03;                        // end of the run, and it repeats
                    const std::vector<uint8_t> blk = block(c == 0 ? 2 : 12, 0, flags, ramp);
                    file.insert(file.end(), blk.begin(), blk.end());
                }
            {
                FILE *fp = std::fopen(path.c_str(), "wb");
                t.IsTrue(fp != nullptr, "the looping VPK can be written");
                if (!fp)
                    return;
                std::fwrite(file.data(), 1, file.size(), fp);
                std::fclose(fp);
            }
            snd989::Mixer mixer;
            const uint32_t h = 0x04000031u;
            t.IsTrue(mixer.playStream(h, path, 0u, 0x400, -1, 1u), "the looping stream plays");
            std::vector<int16_t> buf(2 * 1200);
            auto peak = [&buf](size_t frames) {
                int32_t p = 0;
                for (size_t i = 0; i < frames * 2; ++i)
                    p = std::max(p, std::abs(static_cast<int32_t>(buf[i])));
                return p;
            };
            mixer.pumpStreams();
            mixer.render(buf.data(), 1200);
            const int32_t loud = peak(1200);
            t.IsTrue(loud > 200, "the first chunk is the loud one (peak " + std::to_string(loud) + ")");
            // Its whole data is 7168 samples at 32 kHz = 10752 frames out. Play three times that.
            int32_t silent = 0, afterFirstPass = 0;
            size_t frames = 1200;
            for (int i = 0; i < 26; ++i)
            {
                mixer.pumpStreams();
                mixer.render(buf.data(), 1200);
                frames += 1200;
                const int32_t p = peak(1200);
                if (p == 0)
                    ++silent;
                if (frames > 12000)
                    afterFirstPass = std::max(afterFirstPass, p);
            }
            t.IsTrue(mixer.isPlaying(h), "it is still playing after three times its own length: it loops");
            t.Equals(silent, 0, "and never falls silent");
            t.IsTrue(afterFirstPass > 0 && afterFirstPass < loud / 4,
                     "after the first pass only the quiet half repeats: it looped to the mark, not to the start (peak " +
                         std::to_string(afterFirstPass) + " against " + std::to_string(loud) + ")");
            mixer.stop(h);
            t.IsTrue(!mixer.isPlaying(h), "and a stop still ends it");
            std::remove(path.c_str());
        });

        tc.Run("Mixer: a VPK stream plays its interleaved channels left and right at its own rate, then ends", [](TestCase &t)
        {
            // A VPK: 0xB0-byte header {"VPK ", dataSize, interleave 0x800, headerSize 0xB0, rate 32000, channels 2}, then
            // 0x800-byte chunks alternating L, R. Left carries a positive ramp, right a negative one.
            int8_t up[28], down[28];
            for (int i = 0; i < 28; ++i)
            {
                up[i] = static_cast<int8_t>(i % 8);        // 0..7
                down[i] = static_cast<int8_t>(-(i % 8));   // 0..-7
            }
            const int chunksPerChannel = 3;
            std::vector<uint8_t> file(0x1000, 0u);   // research/36 item 10: word 3 = 0x1000 -> a per-channel stride of 0x800
            auto put32 = [&](size_t at, uint32_t v) { file[at] = static_cast<uint8_t>(v); file[at + 1] = static_cast<uint8_t>(v >> 8); file[at + 2] = static_cast<uint8_t>(v >> 16); file[at + 3] = static_cast<uint8_t>(v >> 24); };
            std::memcpy(file.data(), " KPV", 4);   // the disc stores the magic as the little-endian word "VPK "
            put32(4, static_cast<uint32_t>(chunksPerChannel * 2 * 0x800));
            put32(8, 0x800);
            put32(12, 0x1000);
            put32(16, 32000);
            put32(20, 2);
            for (int c = 0; c < chunksPerChannel; ++c)
                for (int ch = 0; ch < 2; ++ch)
                    for (int b = 0; b < 0x800 / 16; ++b)
                    {
                        const bool last = c == chunksPerChannel - 1 && b == 0x800 / 16 - 1;
                        const std::vector<uint8_t> blk = block(12, 0, last ? 0x01 : 0x00, ch == 0 ? up : down);
                        file.insert(file.end(), blk.begin(), blk.end());
                    }
            const std::string path = tmpPath("socom2_audio_test_stream.vpk");
            {
                FILE *fp = std::fopen(path.c_str(), "wb");
                t.IsTrue(fp != nullptr, "the temporary VPK can be written");
                if (!fp)
                    return;
                std::fwrite(file.data(), 1, file.size(), fp);
                std::fclose(fp);
            }
            snd989::Mixer mixer;
            // Sprint 8: a refused playStream owns the file it opened for the length of the call and must close
            // it exactly once. The refusal path used to fclose the handle the half-built Stream also held, so
            // the Stream's destructor closed it a second time -- a double free glibc aborts on (Linux) and the
            // Windows allocator never reported. Windows cannot see the second free, so it counts the closes.
            const uint64_t closesBefore = snd989::Mixer::streamFileClosesForTest();
            t.IsTrue(!mixer.playStream(0x04000001u, path, 4u, 0x400, -1, 1u), "an offset that is not a VPK header is refused");
            t.Equals(snd989::Mixer::streamFileClosesForTest() - closesBefore, static_cast<uint64_t>(1u),
                     "the refused stream closes its file exactly once (twice is the double free)");
            t.IsTrue(mixer.playStream(0x04000001u, path, 0u, 0x400, -1, 1u), "the stream starts");
            mixer.pumpStreams();   // the worker's job, driven by hand: the whole file fits the ring
            t.Equals(mixer.activeStreams(), static_cast<size_t>(1u), "one stream");
            t.IsTrue(mixer.isPlaying(0x04000001u), "playing under the module's handle");
            std::vector<int16_t> buf(2 * 4800);
            mixer.render(buf.data(), 4800);   // 100 ms
            double left = 0, right = 0;
            for (size_t i = 0; i < 4800; ++i)
            {
                left += buf[2 * i];
                right += buf[2 * i + 1];
            }
            t.IsTrue(left > 0 && right < 0, "left carries the positive ramp, right the negative (L " + std::to_string(left) + " R " + std::to_string(right) + ")");
            t.IsTrue(std::fabs(left + right) < 0.05 * (std::fabs(left) + std::fabs(right)), "and they are equal in size (pan reset = centre)");
            // 3 chunks x 128 blocks x 28 samples = 10752 samples at 32 kHz = 336 ms = 16128 output frames at 48 kHz.
            size_t frames = 4800;
            while (mixer.isPlaying(0x04000001u) && frames < 48000u)
            {
                mixer.render(buf.data(), 4800);
                frames += 4800;
            }
            t.IsTrue(!mixer.isPlaying(0x04000001u), "the stream ends after its data (" + std::to_string(frames) + " frames)");
            t.IsTrue(frames >= 14400u && frames <= 24000u, "about 16128 frames of output: 336 ms at 32 kHz resampled to 48 kHz");
            t.Equals(mixer.activeStreams(), static_cast<size_t>(0u), "no stream left");

            t.IsTrue(mixer.playStream(0x04000002u, path, 0u, 0x400, 90, 1u), "again, panned right");
            mixer.pumpStreams();
            mixer.render(buf.data(), 2400);
            left = right = 0;
            for (size_t i = 0; i < 2400; ++i)
            {
                left += std::fabs(static_cast<double>(buf[2 * i]));
                right += std::fabs(static_cast<double>(buf[2 * i + 1]));
            }
            // research/36 item 7: a two-channel stream is the IRX's voice pair (left data at 270 + p, right data
            // mirrored), so a pan of 90 puts both voices on the centre entry and the two outputs become the same
            // mix -- for this clip's mirrored ramps, near silence on both sides. Not "hard right": a stereo pair
            // cannot be panned to one side by the handler pan on the IRX.
            t.IsTrue(std::fabs(left - right) <= 0.05 * (left + right) + 1.0,
                     "pan 90: the pair collapses to the centre, equal outputs (L " + std::to_string(left) + " R " + std::to_string(right) + ")");
            mixer.stop(0x04000002u);
            t.IsTrue(!mixer.isPlaying(0x04000002u), "stop ends a stream at once");
            t.IsTrue(mixer.playStream(0x04000003u, path, 0u, 0x400, -1, 1u), "a third");
            mixer.stopAllStreams();
            t.Equals(mixer.activeStreams(), static_cast<size_t>(0u), "stopAllStreams");
            std::remove(path.c_str());
        });

        // Sprint 8, the owner's 2026-09-18 mission ("skips and almost plays two different spliced segments"):
        // snd_AutoVol (fno 0x22) is a TIMED ramp. The game fades its music cues with [handle, 0, 0x168, 2] and
        // [handle, 0, 0x1e0, 2] -- target 0 over 360 and 480 of the 240 Hz mixer ticks, 1.5 s and 2 s -- and the
        // handler applied the target at once (and stopped at once for the -4 target), cutting a cue dead mid
        // phrase. 240 Hz is the rate 989snd's own handlers run at, which the open reimplementation confirms
        // (open-goal/jak-project game/sound/989snd/player.cpp: "The handlers expect to tick at 240hz",
        // "48000/240 = 200") -- it does not implement snd_AutoVol itself, so the ramp's shape here was the plain
        // reading: linear, from the volume in force, to the target, over `ticks` ticks. Sprint 15 T1b replaced that
        // with the IRX's integer schedule (research/36 Q5; the case after the -4 one): 240 ticks from 127 is a -1
        // step every floor(240 / 127) = 1 tick, landing at tick 127.
        tc.Run("Mixer: snd_AutoVol fades over its ticks instead of applying the target at once; the fade lands on the target", [](TestCase &t)
        {
            const std::string path = tmpPath("socom2_audio_autovol_stream.vpk");
            t.IsTrue(writeVpk(path, 40, 2), "a 4.4 s stereo VPK to fade, loud enough to measure a level on");
            snd989::Mixer mixer;
            std::vector<int16_t> buf(2 * 2400);
            // 2400 frames = 12 of the 240 Hz ticks. Renders `slices` of them, keeping the decode-ahead ring
            // filled by hand, and answers the mean |sample| of the LAST slice: the level at the window's end.
            auto renderLevel = [&](int slices) {
                double level = 0.0;
                for (int i = 0; i < slices; ++i)
                {
                    mixer.pumpStreams();
                    mixer.render(buf.data(), 2400);
                    if (i == slices - 1)
                    {
                        double sum = 0.0;
                        for (size_t k = 0; k < 2u * 2400u; ++k)
                            sum += std::fabs(static_cast<double>(buf[k]));
                        level = sum / (2.0 * 2400.0);
                    }
                }
                return level;
            };
            t.IsTrue(mixer.playStream(0x04000019u, path, 0u, 0x400, -1, 1u), "the cue plays");
            const double full = renderLevel(1);
            t.IsTrue(full > 100.0, "loud before the fade (" + std::to_string(full) + ")");
            mixer.autoVol(0x04000019u, 0, 240, 2);            // the game's fade, one second of it
            const double justAfter = renderLevel(1);          // ticks 0..12 of 240
            t.IsTrue(justAfter > 0.8 * full, "the call itself does not cut the cue (" + std::to_string(justAfter) + " of " + std::to_string(full) + ")");
            const double half = renderLevel(5);               // through tick 72: about the middle of the 127-tick ramp
            // The ramp's scale is about 0.5 here (levels 67 down to 56 of 127 over the slice), and the group stage
            // SQUARES it (vol.c:434-455, research/36 Q6 item 1):
            // a linear fade is a quadratic loudness curve on the console -- a quarter of the amplitude, not half.
            t.IsTrue(half > 0.15 * full && half < 0.35 * full, "half way through it is a QUARTER as loud, the square law (" + std::to_string(half) + " of " + std::to_string(full) + ")");
            const double landed = renderLevel(11);            // through tick 204: past the landing at 127
            t.IsTrue(landed < 1e-9, "the fade lands on silence (" + std::to_string(landed) + ")");
            t.IsTrue(mixer.isPlaying(0x04000019u), "a fade to 0 does not end the cue -- only the -4 target does");
            mixer.stop(0x04000019u);

            // A ramp is per handle: fading one cue leaves every other one alone.
            t.IsTrue(mixer.playStream(0x0400001Au, path, 0u, 0x400, -1, 1u), "cue A");
            t.IsTrue(mixer.playStream(0x0400001Bu, path, 0u, 0x400, -1, 1u), "cue B");
            mixer.autoVol(0x0400001Au, 0, 240, 2);
            const double bothFaded = renderLevel(22);         // A is silent by now; B never was asked to fade
            t.IsTrue(bothFaded > 0.5 * full, "the cue that was not faded still plays (" + std::to_string(bothFaded) + " of " + std::to_string(full) + ")");
            mixer.stopAllStreams();

            // An explicit snd_SetSoundVolPan cancels a fade in flight (unverified against a reference: the open
            // 989snd reimplementation has no snd_AutoVol -- see the header).
            t.IsTrue(mixer.playStream(0x0400001Cu, path, 0u, 0x400, -1, 1u), "a cue to interrupt");
            mixer.autoVol(0x0400001Cu, 0, 240, 2);
            const double mid = renderLevel(10);               // through tick 120
            t.IsTrue(mid < 0.8 * full, "the fade is under way (" + std::to_string(mid) + ")");
            mixer.setVolPan(0x0400001Cu, 0x400, snd989::kPanDontChange);
            const double cancelled = renderLevel(1);
            t.IsTrue(cancelled > 0.8 * full, "setVolPan cancels it: full volume again (" + std::to_string(cancelled) + " of " + std::to_string(full) + ")");
            mixer.stopAllStreams();
            std::remove(path.c_str());
        });

        tc.Run("Mixer: snd_AutoVol's -4 target fades out and stops -- the handle plays until the ramp lands, not from the call", [](TestCase &t)
        {
            const std::string path = tmpPath("socom2_audio_autovol_stop.vpk");
            t.IsTrue(writeVpk(path, 40, 2), "a 4.4 s stereo VPK to fade out");
            snd989::Mixer mixer;
            std::vector<int16_t> buf(2 * 2400);
            auto render = [&](int slices) {
                for (int i = 0; i < slices; ++i)
                {
                    mixer.pumpStreams();
                    mixer.render(buf.data(), 2400);
                }
            };
            t.IsTrue(mixer.playStream(0x0401005Cu, path, 0u, 0x400, -1, 1u), "the cue plays");
            render(1);
            mixer.autoVol(0x0401005Cu, -4, 240, 2);            // fade out and stop
            t.IsTrue(mixer.isPlaying(0x0401005Cu), "still playing at the call: the stop is at the END of the fade");
            render(10);                                        // through tick 120: 7 steps short of the landing at 127
            t.IsTrue(mixer.isPlaying(0x0401005Cu), "still playing late in the fade");
            t.Equals(mixer.activeStreams(), static_cast<size_t>(1u), "and the stream is still there");
            render(11);                                        // past tick 127 (and 240)
            t.IsTrue(!mixer.isPlaying(0x0401005Cu), "stopped once the fade landed");
            t.Equals(mixer.activeStreams(), static_cast<size_t>(0u), "the stream is gone");
            // ticks <= 0 has no ramp to run: the target applies at once, which is what -4 used to do for every length.
            t.IsTrue(mixer.playStream(0x0401005Du, path, 0u, 0x400, -1, 1u), "another cue");
            mixer.pumpStreams();
            mixer.autoVol(0x0401005Du, -4, 0, 2);
            t.IsTrue(!mixer.isPlaying(0x0401005Du), "a zero-tick -4 stops at once");
            std::remove(path.c_str());
        });

        // Sprint 15 T1b (research/36 Q5 and item 4, research/69 entry 2): the IRX's snd_AutoVol does not interpolate
        // over `ticks`; it moves the handle's 7-bit volume in INTEGER steps on a schedule of its own, and lands early.
        // The game's 1.5 s fade, [handle, 0, 0x168, 2], takes a full cue (127) to 0 over 360 ticks. The schedule:
        //   volchange = target - current = -127. |volchange| < ticks, so the SLOW branch: a step of exactly -1 every
        //   floor(360 / 127) = 2 ticks (integer division). The effect's counter is armed at 2, counts down once per
        //   240 Hz tick and fires the step when it reaches 0, then re-arms at 2 -- so step k lands on tick 2k, and the
        //   127th (1 -> 0) on tick 127 x 2 = 254 = 1.06 s, where the ramp is removed with the volume held at 0.
        //   The 2 s fade (0x1e0 = 480 ticks) runs 127 x floor(480 / 127) = 127 x 3 = 381 ticks.
        //   |volchange| >= ticks is the FAST branch: delta = 32 * volchange / ticks (C division, toward zero), and each
        //   tick the level becomes (32 * level + delta) >> 5 -- an arithmetic shift, so a fall rounds DOWN -- clamped
        //   at the target. A 30-tick fade from 127: delta = -4064 / 30 = -135, a step of floor(-135 / 32) = -5 a tick,
        //   2 left after 25 ticks and 0 (clamped) at tick 26.
        // Ours interpolated in doubles and moved the level every tick until tick 360. The first step's timing (tick d,
        // not tick 1) is the effect counter's reading: armed at d, decremented before the zero test.
        tc.Run("Mixer: snd_AutoVol steps in 7-bit integers on the IRX's schedule -- 360 ticks from 127 is 127 steps of -1, one every 2 ticks, landing at tick 254", [](TestCase &t)
        {
            const std::string path = tmpPath("socom2_audio_autovol_steps.vpk");
            t.IsTrue(writeVpk(path, 40, 2), "a 4.4 s stereo VPK to fade");
            std::vector<int16_t> buf(2 * 200);   // 200 frames = one 240 Hz tick at 48 kHz
            struct Trace { int changes = 0, nonUnit = 0, offSchedule = 0, lastChange = -1; int32_t at253 = -1, final = -1; };
            // Fades a fresh cue from full with autoVol(h, vol, ticks) and reads the 7-bit level after every tick.
            auto fade = [&](uint32_t h, int32_t vol, int32_t ticks, int every) {
                snd989::Mixer mixer;
                Trace tr;
                if (!mixer.playStream(h, path, 0u, 0x400, -1, 1u))
                    return tr;
                mixer.autoVol(h, vol, ticks, 2);
                int32_t prev = mixer.autoVolLevelForTest(h);
                for (int tick = 1; tick <= 500; ++tick)
                {
                    mixer.pumpStreams();
                    mixer.render(buf.data(), 200);
                    const int32_t lvl = mixer.autoVolLevelForTest(h);
                    if (lvl != prev)
                    {
                        ++tr.changes;
                        if (prev - lvl != 1)
                            ++tr.nonUnit;
                        if (tick != every * tr.changes)
                            ++tr.offSchedule;
                        tr.lastChange = tick;
                        prev = lvl;
                    }
                    if (tick == 253)
                        tr.at253 = lvl;
                }
                tr.final = prev;
                return tr;
            };
            const Trace a = fade(0x0400001Eu, 0, 0x168, 2);
            t.Equals(a.changes, 127, "the 1.5 s fade moves the level 127 times (" + std::to_string(a.changes) + ")");
            t.Equals(a.nonUnit, 0, "every move is one 7-bit step (" + std::to_string(a.nonUnit) + " were not)");
            t.Equals(a.offSchedule, 0, "step k lands on tick 2k (" + std::to_string(a.offSchedule) + " did not)");
            t.Equals(a.at253, 1, "one step left at tick 253 (" + std::to_string(a.at253) + ")");
            t.Equals(a.lastChange, 254, "and it lands at tick 254 = 127 x floor(360 / 127), not 360 (" + std::to_string(a.lastChange) + ")");
            t.Equals(a.final, 0, "on silence, where it stays");

            const Trace b = fade(0x0400001Fu, 0, 0x1e0, 3);
            t.Equals(b.changes, 127, "the 2 s fade: 127 steps too (" + std::to_string(b.changes) + ")");
            t.Equals(b.offSchedule, 0, "one every 3 ticks (" + std::to_string(b.offSchedule) + " off)");
            t.Equals(b.lastChange, 381, "landing at tick 381 = 127 x 3, not 480 (" + std::to_string(b.lastChange) + ")");

            // The fast branch: 30 ticks for 127 steps of volume.
            snd989::Mixer fast;
            t.IsTrue(fast.playStream(0x04000020u, path, 0u, 0x400, -1, 1u), "a cue for the fast fade");
            fast.autoVol(0x04000020u, 0, 30, 2);
            int32_t level25 = -1, landed = -1;
            for (int tick = 1; tick <= 40; ++tick)
            {
                fast.pumpStreams();
                fast.render(buf.data(), 200);
                if (tick == 1)
                    t.Equals(fast.autoVolLevelForTest(0x04000020u), 122, "the fast fade's first tick: 127 + floor(-135 / 32) = 122");
                if (tick == 25)
                    level25 = fast.autoVolLevelForTest(0x04000020u);
                if (tick == 26)
                    landed = fast.autoVolLevelForTest(0x04000020u);
            }
            t.Equals(level25, 2, "2 left after 25 steps of -5 (" + std::to_string(level25) + ")");
            t.Equals(landed, 0, "clamped onto the target at tick 26, not 30 (" + std::to_string(landed) + ")");

            // The -4 target stops the handle on the landing tick: 254, not 360.
            snd989::Mixer stopper;
            const uint32_t hs = 0x04010060u;
            t.IsTrue(stopper.playStream(hs, path, 0u, 0x400, -1, 1u), "a cue to fade out and stop");
            stopper.autoVol(hs, -4, 0x168, 2);
            bool playing253 = false, playing254 = true;
            for (int tick = 1; tick <= 254; ++tick)
            {
                stopper.pumpStreams();
                stopper.render(buf.data(), 200);
                if (tick == 253)
                    playing253 = stopper.isPlaying(hs);
                if (tick == 254)
                    playing254 = stopper.isPlaying(hs);
            }
            t.IsTrue(playing253, "still playing at tick 253, one step from silence");
            t.IsTrue(!playing254, "stopped at tick 254, where the fade lands");
            std::remove(path.c_str());
        });

        // research/36 Q6 item 1 (2026-09-20): the group stage is a SQUARE law. snd_AdjustVolToGroup
        // (research/989snd-ziemas/iop/vol.c:434-455; IRX FUN_00019b7c): m = MasterVol[g] * Duck[g] / 0x10000;
        // v = vol14 * m / 0x400; return v * v / 0x7ffe. The identity at full scale (0x7ffe), a QUARTER at half
        // amplitude: the MUSIC/SOUND sliders at 50 % are -12 dB on the console, and so is a stem played at vol 0x200.
        // Ours was linear (-6 dB) -- 2x too loud in amplitude at every level below full, and every fade the wrong
        // shape -- the likeliest reason for the music-only parity windows' level mismatch once Q1 was out of the way.
        tc.Run("Mixer: the group stage is a square law -- half volume is -12 dB (a quarter of the amplitude), full volume is unity", [](TestCase &t)
        {
            const std::string path = tmpPath("socom2_audio_square_law.vpk");
            t.IsTrue(writeVpk(path, 8, 2), "a loud stereo VPK");
            // The mean absolute level of the second 2400-frame slice of a fresh mixer playing `path` at `vol`
            // (group 1) under master `master`: one mixer per measurement, so nothing carries over.
            auto streamLevel = [&](int32_t vol, int32_t master) {
                snd989::Mixer mixer;
                mixer.setMasterVolume(16u, master);
                std::vector<int16_t> buf(2 * 2400);
                t.IsTrue(mixer.playStream(0x04000071u, path, 0u, vol, -1, 1u), "the stream plays");
                for (int i = 0; i < 2; ++i)
                {
                    mixer.pumpStreams();
                    mixer.render(buf.data(), 2400);
                }
                double sum = 0.0;
                for (int16_t s : buf)
                    sum += std::fabs(static_cast<double>(s));
                return sum / static_cast<double>(buf.size());
            };
            const double full = streamLevel(0x400, 0x400);
            t.IsTrue(full > 100.0, "loud at full (" + std::to_string(full) + ")");
            const double again = streamLevel(0x400, 0x400);
            t.IsTrue(std::fabs(again - full) <= 0.01 * full, "unity at full: v * v / 0x7ffe is the identity at 0x7ffe (" +
                                                                 std::to_string(again) + " of " + std::to_string(full) + ")");

            // A stem played at vol 0x200: playVol 63 of 127 (0.496 of full amplitude), squared -> 0.246. -12 dB.
            const double halfVol = streamLevel(0x200, 0x400);
            t.IsTrue(halfVol > 0.20 * full && halfVol < 0.30 * full, "vol 0x200 is a quarter as loud, -12 dB (" +
                                                                       std::to_string(halfVol) + " of " + std::to_string(full) + ")");
            t.IsTrue(halfVol < 0.40 * full, "and not the linear -6 dB of before");

            // The game's MUSIC slider at 50 % = master 0x200 on the group: the same quarter.
            const double halfMaster = streamLevel(0x400, 0x200);
            t.IsTrue(halfMaster > 0.20 * full && halfMaster < 0.30 * full, "master 0x200 is a quarter as loud, -12 dB (" +
                                                                             std::to_string(halfMaster) + " of " + std::to_string(full) + ")");

            // A bank voice goes through the same stage (blocksnd.c:1267-1268): HUDUI sound 8 under master 0x200 is a
            // quarter as loud as under 0x400, envelope for envelope (the same render length on a fresh mixer each).
            const std::vector<uint8_t> blk = readFixture("hudui_block.bin");
            const std::vector<uint8_t> vag = readFixture("hudui_vag.bin");
            auto voiceLevel = [&](int32_t master) {
                snd989::Mixer mixer;
                t.IsTrue(mixer.loadBank(0x00a00000u, blk.data(), blk.size(), vag.data(), vag.size()), "HUDUI loads");
                mixer.setMasterVolume(16u, master);
                std::vector<int16_t> buf(2 * 4096);
                t.IsTrue(mixer.play(0x00a00000u, 8u, 0x400, -1, 0, 0) != 0u, "sound 8 plays");
                mixer.render(buf.data(), 4096);
                double sum = 0.0;
                for (int16_t s : buf)
                    sum += std::fabs(static_cast<double>(s));
                return sum / static_cast<double>(buf.size());
            };
            const double voiceFull = voiceLevel(0x400);
            t.IsTrue(voiceFull > 20.0, "the voice is audible at full (" + std::to_string(voiceFull) + ")");
            const double voiceHalf = voiceLevel(0x200);
            t.IsTrue(voiceHalf > 0.20 * voiceFull && voiceHalf < 0.30 * voiceFull, "a bank voice under master 0x200 is a quarter as loud too (" +
                                                                                     std::to_string(voiceHalf) + " of " + std::to_string(voiceFull) + ")");
            std::remove(path.c_str());
        });

        // Task 1e (audit 2026-09-17 section 2.3): the disc read moved off the audio callback. pumpStreams() decodes
        // ahead into each stream's ring on a worker; render() touches memory only.
        tc.Run("a stream plays out of its ring with the file handle closed", [](TestCase &t)
        {
            const std::string path = tmpPath("socom2_audio_ring_stream.vpk");
            t.IsTrue(writeVpk(path, 8), "the temporary VPK can be written");
            snd989::Mixer mixer;
            t.IsTrue(mixer.playStream(1u, path, 0ull, 0x400, 0, 0u), "the stream starts");
            mixer.pumpStreams();
            t.Equals(mixer.activeStreams(), static_cast<size_t>(1u), "one live stream");
            mixer.closeStreamFilesForTest();
            std::vector<int16_t> buf(4096 * 2, 0);
            mixer.render(buf.data(), 4096);
            bool anyNonZero = false;
            for (int16_t s : buf) if (s != 0) { anyNonZero = true; break; }
            t.IsTrue(anyNonZero, "render plays the ring's contents with no file behind it");
            // And only the ring's contents: the file holds 8 chunk pairs, the ring at most kStreamRingChunks.
            // One chunk pair is 128 blocks x 28 samples = 3584 samples at 32 kHz = 5376 frames at 48 kHz.
            size_t frames = 4096;
            while (frames < 8u * 5376u)
            {
                mixer.render(buf.data(), 4096);
                frames += 4096;
            }
            bool tailNonZero = false;
            for (int16_t s : buf) if (s != 0) { tailNonZero = true; break; }
            t.IsTrue(!tailNonZero, "past the ring it goes quiet: render never read the rest of the file");
            std::remove(path.c_str());
        });

        tc.Run("render never reads the disc", [](TestCase &t)
        {
            const std::string path = tmpPath("socom2_audio_ring_empty.vpk");
            t.IsTrue(writeVpk(path, 8), "the temporary VPK can be written");
            snd989::Mixer mixer;
            t.IsTrue(mixer.playStream(2u, path, 0ull, 0x400, 0, 0u), "the stream starts");
            mixer.closeStreamFilesForTest();          // nothing pumped past the pre-fill: the ring holds one chunk pair
            std::vector<int16_t> buf(4096 * 2, 0x7F);
            auto anyNonZero = [&]() { for (int16_t s : buf) if (s != 0) return true; return false; };
            // Sprint 9 Q0: playStream decodes the first chunk pair on the caller's thread (the pre-fill), so the
            // first render has sound without a pump -- one chunk pair of a 32 kHz stream is 5376 frames at 48 kHz.
            mixer.render(buf.data(), 4096);
            t.IsTrue(anyNonZero(), "the pre-filled chunk plays on the first render");
            mixer.render(buf.data(), 4096);           // the pre-fill runs out inside this one
            std::fill(buf.begin(), buf.end(), static_cast<int16_t>(0x7F));
            mixer.render(buf.data(), 4096);           // must not crash, must not read, must go quiet
            t.Equals(static_cast<int>(buf[0]), 0, "an empty ring renders silence, not a disc read");
            t.IsTrue(!anyNonZero(), "the whole buffer is silence");
            t.Equals(mixer.activeStreams(), static_cast<size_t>(1u), "an underrun is not the end of the stream");
            std::remove(path.c_str());
        });

        tc.Run("PS2AudioBackend routes a VPK stream by sector and answers snd_SoundIsStillPlaying from the mixer", [](TestCase &t)
        {
            // A one-channel VPK in a "disc image" of three sectors: header at sector 2, so the play call's sector is 2.
            int8_t up[28];
            for (int i = 0; i < 28; ++i)
                up[i] = static_cast<int8_t>(i % 8);
            std::vector<uint8_t> image(2048u * 2u, 0u);
            std::vector<uint8_t> vpk(0xB0, 0u);
            auto put32 = [&](size_t at, uint32_t v) { vpk[at] = static_cast<uint8_t>(v); vpk[at + 1] = static_cast<uint8_t>(v >> 8); vpk[at + 2] = static_cast<uint8_t>(v >> 16); vpk[at + 3] = static_cast<uint8_t>(v >> 24); };
            std::memcpy(vpk.data(), " KPV", 4);
            put32(4, 0x800u);
            put32(8, 0x800u);
            put32(12, 0xB0u);
            put32(16, 32000u);
            put32(20, 1u);
            for (int b = 0; b < 0x800 / 16; ++b)
            {
                const std::vector<uint8_t> blk = block(12, 0, b == 0x800 / 16 - 1 ? 0x01 : 0x00, up);
                vpk.insert(vpk.end(), blk.begin(), blk.end());
            }
            image.insert(image.end(), vpk.begin(), vpk.end());
            const std::string path = tmpPath("socom2_audio_test_image.bin");
            if (FILE *fp = std::fopen(path.c_str(), "wb"))
            {
                std::fwrite(image.data(), 1, image.size(), fp);
                std::fclose(fp);
            }
            PS2AudioBackend backend;
            backend.setDiscImagePath(path);
            const int32_t play[9] = {0x04000005, 2, 0, 0, 0x400, 0, -1, 1, 0};
            backend.onNotify(0x2Cu, play, 9u);
            backend.mixerPumpStreams();
            t.Equals(backend.mixerActiveStreams(), static_cast<size_t>(1u), "snd_PlayVAGStreamByLoc opened the stream at sector 2");
            bool playing = false;
            t.IsTrue(backend.isPlaying(0x04000005u, playing) && playing, "the mixer answers snd_SoundIsStillPlaying: playing");
            t.IsTrue(!backend.isPlaying(0x00a00000u, playing), "a bank handle is not a sound handle: no answer");
            std::vector<int16_t> buf(2 * 4800);
            backend.mixerRender(buf.data(), 4800);
            int32_t peak = 0;
            for (int16_t v : buf)
                peak = std::max<int32_t>(peak, v < 0 ? -v : v);
            t.IsTrue(peak > 0, "the stream is in the mix");
            const int32_t stop[1] = {0x04000005};
            backend.onNotify(0x2Fu, stop, 1u);
            t.IsTrue(backend.isPlaying(0x04000005u, playing) && !playing, "snd_StopVAGStream: the mixer says it is over");
            std::remove(path.c_str());
        });

        tc.Run("Mixer: a VAGp file (the mission voice-overs: 48-byte big-endian header, mono 22050 Hz) streams too", [](TestCase &t)
        {
            int8_t up[28];
            for (int i = 0; i < 28; ++i)
                up[i] = static_cast<int8_t>(i % 8);
            std::vector<uint8_t> file(48, 0u);
            std::memcpy(file.data(), "VAGp", 4);
            const uint32_t dataSize = 16u * 64u;   // 64 blocks
            file[12] = static_cast<uint8_t>(dataSize >> 24); file[13] = static_cast<uint8_t>(dataSize >> 16); file[14] = static_cast<uint8_t>(dataSize >> 8); file[15] = static_cast<uint8_t>(dataSize);
            const uint32_t rate = 22050u;
            file[16] = static_cast<uint8_t>(rate >> 24); file[17] = static_cast<uint8_t>(rate >> 16); file[18] = static_cast<uint8_t>(rate >> 8); file[19] = static_cast<uint8_t>(rate);
            std::memcpy(file.data() + 32, "M51_140", 7);
            for (int b = 0; b < 64; ++b)
            {
                const std::vector<uint8_t> blk = block(12, 0, b == 63 ? 0x01 : 0x00, up);
                file.insert(file.end(), blk.begin(), blk.end());
            }
            const std::string path = "socom2_audio_test_vo.vag";
            if (FILE *fp = std::fopen(path.c_str(), "wb"))
            {
                std::fwrite(file.data(), 1, file.size(), fp);
                std::fclose(fp);
            }
            snd989::Mixer mixer;
            t.IsTrue(mixer.playStream(0x04000009u, path, 0u, 0x400, -1, 1u), "the VAGp stream starts");
            mixer.pumpStreams();
            std::vector<int16_t> buf(2 * 4800);
            mixer.render(buf.data(), 4800);
            double left = 0, right = 0;
            for (size_t i = 0; i < 4800; ++i)
            {
                left += buf[2 * i];
                right += buf[2 * i + 1];
            }
            t.IsTrue(left > 0 && right > 0, "mono goes to both channels");
            // 64 blocks x 28 = 1792 samples at 22050 Hz = 81 ms = 3901 frames at 48 kHz: over in the first render.
            size_t frames = 4800;
            while (mixer.isPlaying(0x04000009u) && frames < 48000u)
            {
                mixer.render(buf.data(), 4800);
                frames += 4800;
            }
            t.IsTrue(frames <= 9600u, "ends within its 81 ms (" + std::to_string(frames) + " frames rendered)");
            std::remove(path.c_str());
        });

        tc.Run("Mixer: a full-scale stream at full volume sits at the SPU's half scale (voice volume >> 1), not at clipping", [](TestCase &t)
        {
            // shift 0: a nibble of 7 decodes to 7 << 12 = 28672. At vol 0x400 and centre pan the 14-bit voice volume
            // is 0x7ffe * cos(45 deg); the group stage then SQUARES it (vol.c:434-455, research/36 Q6 item 1: the IRX
            // applies the pan table BEFORE FUN_00019b7c, so the pan's 0.707 is squared to 0.5), then the SPU's >> 1:
            // about 28672 * 0.5 * 0.5 = 7168 per channel.
            int8_t sevens[28];
            for (int i = 0; i < 28; ++i)
                sevens[i] = 7;
            std::vector<uint8_t> file(48, 0u);
            std::memcpy(file.data(), "VAGp", 4);
            const uint32_t dataSize = 16u * 32u;
            file[12] = static_cast<uint8_t>(dataSize >> 24); file[13] = static_cast<uint8_t>(dataSize >> 16); file[14] = static_cast<uint8_t>(dataSize >> 8); file[15] = static_cast<uint8_t>(dataSize);
            file[16] = 0; file[17] = 0; file[18] = 0xBB; file[19] = 0x80;   // 48000
            for (int b = 0; b < 32; ++b)
            {
                const std::vector<uint8_t> blk = block(0, 0, b == 31 ? 0x01 : 0x00, sevens);
                file.insert(file.end(), blk.begin(), blk.end());
            }
            const std::string path = "socom2_audio_test_loud.vag";
            if (FILE *fp = std::fopen(path.c_str(), "wb"))
            {
                std::fwrite(file.data(), 1, file.size(), fp);
                std::fclose(fp);
            }
            {   // the mixer must close the file before it can be removed (Windows)
                snd989::Mixer mixer;
                t.IsTrue(mixer.playStream(0x0400000Au, path, 0u, 0x400, -1, 1u), "starts");
                mixer.pumpStreams();
                std::vector<int16_t> buf(2 * 512);
                mixer.render(buf.data(), 512);
                int32_t peak = 0;
                for (int16_t v : buf)
                    peak = std::max<int32_t>(peak, v < 0 ? -v : v);
                t.IsTrue(peak >= 6400 && peak <= 8000, "peak " + std::to_string(peak) + " (about 7168: 28672 x 0.707^2 x 1/2, the square law)");
                mixer.stopAll();
            }
            std::remove(path.c_str());
        });

        // research/36 item 7 (2026-09-20): the music-only capture (run 9b) had every VAG stem 5.9 dB (median) under
        // PCSX2 with the square law in. On the IRX a two-channel VPK plays on a PAIR of voices: the play worker
        // allocates a doubling voice (FUN_0000f7e0, 9912-9923: unless flags bit 0x20), the stream start forces the
        // first stream's pan to 270 when it exists (FUN_000152fc, 12755) and hands the doubling voice the second
        // buffer with the main voice's volumes swapped (12759-12775; FUN_00016898 on every update). So each channel
        // sits at the pan table's FULL entry on its own side, where ours put both at the centre entry (0.707) --
        // squared, exactly half the amplitude.
        tc.Run("Mixer: a two-channel stream is the IRX's voice pair -- each channel at the pan table's full value on its side, twice the centre-panned level", [](TestCase &t)
        {
            // shift 0: a nibble of 7 decodes to 28672. Left channel sevens, right channel silence.
            int8_t sevens[28], zeros[28];
            for (int i = 0; i < 28; ++i)
            {
                sevens[i] = 7;
                zeros[i] = 0;
            }
            std::vector<uint8_t> file(0x1000, 0u);   // research/36 item 10: word 3 = 0x1000 -> a per-channel stride of 0x800
            auto put32 = [&](size_t at, uint32_t v) { file[at] = static_cast<uint8_t>(v); file[at + 1] = static_cast<uint8_t>(v >> 8); file[at + 2] = static_cast<uint8_t>(v >> 16); file[at + 3] = static_cast<uint8_t>(v >> 24); };
            std::memcpy(file.data(), " KPV", 4);
            const int chunkPairs = 4;
            put32(4, static_cast<uint32_t>(chunkPairs * 2 * 0x800));
            put32(8, 0x800);
            put32(12, 0x1000);
            put32(16, 48000);
            put32(20, 2);
            for (int c = 0; c < chunkPairs; ++c)
                for (int ch = 0; ch < 2; ++ch)
                    for (int b = 0; b < 0x800 / 16; ++b)
                    {
                        const bool last = c == chunkPairs - 1 && b == 0x800 / 16 - 1;
                        const std::vector<uint8_t> blk = block(0, 0, last ? 0x01 : 0x00, ch == 0 ? sevens : zeros);
                        file.insert(file.end(), blk.begin(), blk.end());
                    }
            const std::string path = tmpPath("socom2_audio_test_pair.vpk");
            if (FILE *fp = std::fopen(path.c_str(), "wb"))
            {
                std::fwrite(file.data(), 1, file.size(), fp);
                std::fclose(fp);
            }
            {
                snd989::Mixer mixer;
                std::vector<int16_t> buf(2 * 512);
                auto peaks = [&](int32_t &l, int32_t &r) {
                    l = r = 0;
                    for (size_t i = 0; i < 512; ++i)
                    {
                        l = std::max(l, std::abs(static_cast<int32_t>(buf[i * 2])));
                        r = std::max(r, std::abs(static_cast<int32_t>(buf[i * 2 + 1])));
                    }
                };
                t.IsTrue(mixer.playStream(0x0400000Bu, path, 0u, 0x400, -1, 1u), "starts at vol 0x400, pan -1 (the game's music cue)");
                mixer.pumpStreams();
                mixer.render(buf.data(), 512);
                int32_t l = 0, r = 0;
                peaks(l, r);
                // Main voice at pan 270: table (0x3fff, 0) -> 32766, the square law's identity, >> 1: 28672 / 2 = 14336.
                t.IsTrue(l >= 12900 && l <= 15800, "left data on the left at the table's full entry (peak " + std::to_string(l) + ", about 14336 = 28672 x 1 x 1/2)");
                t.IsTrue(r <= 8, "nothing of it on the right (peak " + std::to_string(r) + ")");

                // The pair rotates with the handler pan: at 90 both voices sit on the centre entry, 0.707 squared = half.
                mixer.setVolPan(0x0400000Bu, snd989::kVolDontChange, 90);
                mixer.pumpStreams();
                mixer.render(buf.data(), 512);
                peaks(l, r);
                t.IsTrue(l >= 6400 && l <= 8000 && r >= 6400 && r <= 8000,
                         "pan 90: the left data on both sides at the centre entry squared (L " + std::to_string(l) + ", R " + std::to_string(r) + ", about 7168)");
                mixer.stopAll();
            }
            std::remove(path.c_str());
        });

        // research/36 item 10 (2026-09-20): the owner's "doesn't even sound like music". Every SOCOM stem is a VPK
        // with word 2 = 0x800, word 3 = 0xb000, channels 2 -- and the two channels are interleaved per streaming
        // BUFFER (word 3: the IRX's FUN_00013334 requires it to equal its stream buffer, and its per-channel stride
        // is `puVar12[3] >> 1`): each 0xb000-byte buffer holds 0x5800 bytes of L then 0x5800 of R, the last, partial
        // buffer split in halves; 0x800 is only the streamer's refill grain. Ours read alternating 0x800 chunks as
        // L, R, L, R -- different music in the two channels (run 10: L/R correlation 0.05 at lag 0 against the
        // console's 0.3-0.6, "best" lags scattered at 61/136/674 ms). This file is authored in the real layout with
        // IDENTICAL data in both halves, so a correct decode renders L == R for every frame.
        tc.Run("Mixer: a two-channel VPK is interleaved per streaming buffer (word 3 / 2): L and R stay sample-aligned through the pre-fill, every buffer boundary, the partial tail and a forced underrun", [](TestCase &t)
        {
            constexpr uint32_t kBuffer = 0xb000u, kHalf = kBuffer / 2u;
            const int fullBuffers = 6;                 // 7 chunk pairs with the tail: more than the ring's 4, so an underrun can be forced
            const uint32_t tailPerChannel = 0x1000u;   // a partial last buffer, split in halves
            std::vector<uint8_t> file(kBuffer, 0u);    // the header block: 24 bytes of header, zero to word 3
            auto put32 = [&](size_t at, uint32_t v) { file[at] = static_cast<uint8_t>(v); file[at + 1] = static_cast<uint8_t>(v >> 8); file[at + 2] = static_cast<uint8_t>(v >> 16); file[at + 3] = static_cast<uint8_t>(v >> 24); };
            std::memcpy(file.data(), " KPV", 4);
            put32(4, static_cast<uint32_t>(fullBuffers) * kBuffer + 2u * tailPerChannel);
            put32(8, 0x800);
            put32(12, kBuffer);
            put32(16, 32000);
            put32(20, 2);
            // A block pattern that changes from block to block, so a channel reading the wrong bytes cannot match.
            auto pattern = [](uint32_t idx, int8_t (&n)[28]) {
                for (int i = 0; i < 28; ++i)
                    n[i] = static_cast<int8_t>(static_cast<int>((idx * 5u + static_cast<uint32_t>(i)) % 15u) - 7);
            };
            int8_t nib[28];
            for (int b = 0; b < fullBuffers; ++b)
                for (int ch = 0; ch < 2; ++ch)
                    for (uint32_t k = 0; k < kHalf / 16u; ++k)
                    {
                        pattern(static_cast<uint32_t>(b) * (kHalf / 16u) + k, nib);
                        const std::vector<uint8_t> blk = block(4, 0, 0x00, nib);   // shift 4: samples of +-1792
                        file.insert(file.end(), blk.begin(), blk.end());
                    }
            for (int ch = 0; ch < 2; ++ch)
                for (uint32_t k = 0; k < tailPerChannel / 16u; ++k)
                {
                    pattern(static_cast<uint32_t>(fullBuffers) * (kHalf / 16u) + k, nib);
                    const std::vector<uint8_t> blk = block(4, 0, k == tailPerChannel / 16u - 1u ? 0x01 : 0x00, nib);
                    file.insert(file.end(), blk.begin(), blk.end());
                }
            const std::string path = tmpPath("socom2_audio_test_buffer_layout.vpk");
            if (FILE *fp = std::fopen(path.c_str(), "wb"))
            {
                std::fwrite(file.data(), 1, file.size(), fp);
                std::fclose(fp);
            }
            const uint64_t samplesPerChannel = (2ull * fullBuffers * kHalf + 2ull * tailPerChannel) / 2ull / 16ull * 28ull;
            const uint64_t expectFrames = samplesPerChannel * 48000ull / 32000ull;
            {
                snd989::Mixer mixer;
                const uint32_t h = 0x0400000Cu;
                t.IsTrue(mixer.playStream(h, path, 0u, 0x400, -1, 1u), "the buffer-layout VPK plays (pan -1: L data left, R data right)");
                std::vector<int16_t> buf(2 * 2400);
                std::vector<int16_t> out;
                for (int i = 0; i < 400 && mixer.isPlaying(h); ++i)
                {
                    mixer.pumpStreams();
                    mixer.render(buf.data(), 2400);
                    out.insert(out.end(), buf.begin(), buf.end());
                }
                t.IsTrue(!mixer.isPlaying(h), "it plays to its end");
                // Its length is every half of every buffer, tail included: the decoder read the halves, not 0x800 chunks.
                size_t lastLoud = 0;
                int32_t peak = 0;
                for (size_t f = 0; f < out.size() / 2; ++f)
                {
                    const int32_t a = std::abs(static_cast<int32_t>(out[f * 2])), b = std::abs(static_cast<int32_t>(out[f * 2 + 1]));
                    if (a > 200 || b > 200)
                        lastLoud = f;
                    peak = std::max(peak, std::max(a, b));
                }
                t.IsTrue(peak > 500, "audible (peak " + std::to_string(peak) + ", +-1792 blocks at the SPU half scale)");
                t.IsTrue(lastLoud + 1 >= expectFrames - 4800 && lastLoud + 1 <= expectFrames + 4800,
                         "the whole file plays: " + std::to_string(lastLoud + 1) + " frames of sound against " + std::to_string(expectFrames) + " expected");
                size_t mismatches = 0, first = 0;
                for (size_t f = 0; f < out.size() / 2; ++f)
                    if (std::abs(static_cast<int32_t>(out[f * 2]) - static_cast<int32_t>(out[f * 2 + 1])) > 1)
                    {
                        if (mismatches++ == 0)
                            first = f;
                    }
                t.Equals(mismatches, static_cast<size_t>(0u), "L and R are sample-aligned for the whole stream (first mismatch at frame " + std::to_string(first) + ")");
            }
            {
                // A forced underrun: the worker is off in the tests, so after the pre-fill and one pump the ring holds
                // at most 1 + 3 chunk pairs; render past them without pumping (silence), then pump again.
                snd989::Mixer mixer;
                const uint32_t h = 0x0400000Du;
                t.IsTrue(mixer.playStream(h, path, 0u, 0x400, -1, 1u), "plays again");
                mixer.pumpStreams();
                std::vector<int16_t> buf(2 * 4800);
                size_t mismatches = 0;
                bool starved = false;
                for (int i = 0; i < 60 && mixer.isPlaying(h); ++i)
                {
                    mixer.render(buf.data(), 4800);   // 100 ms a call, no pump: the ring drains within its ~5 s
                    int32_t peak = 0;
                    for (size_t f = 0; f < 4800; ++f)
                    {
                        peak = std::max(peak, std::abs(static_cast<int32_t>(buf[f * 2])));
                        if (std::abs(static_cast<int32_t>(buf[f * 2]) - static_cast<int32_t>(buf[f * 2 + 1])) > 1)
                            ++mismatches;
                    }
                    if (peak < 8)
                        starved = true;
                }
                t.IsTrue(starved, "the ring ran dry without the pump: silence");
                mixer.pumpStreams();
                int32_t resumed = 0;
                for (int i = 0; i < 20 && mixer.isPlaying(h); ++i)
                {
                    mixer.pumpStreams();
                    mixer.render(buf.data(), 4800);
                    for (size_t f = 0; f < 4800; ++f)
                    {
                        resumed = std::max(resumed, std::abs(static_cast<int32_t>(buf[f * 2])));
                        if (std::abs(static_cast<int32_t>(buf[f * 2]) - static_cast<int32_t>(buf[f * 2 + 1])) > 1)
                            ++mismatches;
                    }
                }
                t.IsTrue(resumed > 500, "and plays on once pumped (peak " + std::to_string(resumed) + ")");
                t.Equals(mismatches, static_cast<size_t>(0u), "L and R stay aligned through the underrun and the resume");
            }
            std::remove(path.c_str());
        });

        // The same through the real thing: a mission stem straight from the disc image (skipped when no image is at
        // hand). Decoded through the fixed path, its channels correlate at lag 0 as they do on the console.
        tc.Run("Mixer: a real stem from the disc decodes with its two channels time-aligned (skipped without the disc image)", [](TestCase &t)
        {
            std::vector<std::string> candidates;
            if (const char *env = std::getenv("PS2X_CD_IMAGE"); env && *env)
                candidates.emplace_back(env);
            candidates.emplace_back("../../../../game/SOCOM II - U.S. Navy SEALs (USA).iso");
            candidates.emplace_back("C:/projects/socom_pc/game/SOCOM II - U.S. Navy SEALs (USA).iso");
            std::string iso;
            for (const std::string &c : candidates)
                if (FILE *fp = std::fopen(c.c_str(), "rb"))
                {
                    std::fclose(fp);
                    iso = c;
                    break;
                }
            if (iso.empty())
            {
                t.IsTrue(true, "no disc image: skipped");
                return;
            }
            snd989::Mixer mixer;
            const uint32_t h = 0x0400000Eu;
            // Sector 0x11ec92: a 3.9 s stereo stem (VPK size 0x22c60, word 3 0xb000) the driven mission plays twice.
            t.IsTrue(mixer.playStream(h, iso, 0x11ec92ull * 2048ull, 0x400, -1, 1u), "the stem opens from the disc image");
            std::vector<int16_t> buf(2 * 2400);
            std::vector<double> L, R;
            for (int i = 0; i < 200 && mixer.isPlaying(h); ++i)
            {
                mixer.pumpStreams();
                mixer.render(buf.data(), 2400);
                for (size_t f = 0; f < 2400; f += 8)   // decimated by 8: 6 kHz, enough for a lag search of +-80 ms
                {
                    L.push_back(buf[f * 2]);
                    R.push_back(buf[f * 2 + 1]);
                }
            }
            t.IsTrue(!mixer.isPlaying(h), "it plays to its end (" + std::to_string(L.size() * 8) + " frames)");
            const size_t n = L.size();
            double ml = 0.0, mr = 0.0;
            for (size_t i = 0; i < n; ++i) { ml += L[i]; mr += R[i]; }
            ml /= static_cast<double>(n); mr /= static_cast<double>(n);
            double nl = 0.0, nr = 0.0;
            for (size_t i = 0; i < n; ++i) { L[i] -= ml; R[i] -= mr; nl += L[i] * L[i]; nr += R[i] * R[i]; }
            const double norm = std::sqrt(nl * nr) + 1e-9;
            auto corrAt = [&](int lag) {
                double s = 0.0;
                for (size_t i = 0; i < n; ++i)
                {
                    const long j = static_cast<long>(i) + lag;
                    if (j >= 0 && static_cast<size_t>(j) < n)
                        s += L[i] * R[static_cast<size_t>(j)];
                }
                return s / norm;
            };
            const double c0 = corrAt(0);
            int bestLag = 0;
            double best = -2.0;
            for (int lag = -480; lag <= 480; ++lag)   // +-80 ms at 6 kHz
            {
                const double c = corrAt(lag);
                if (c > best) { best = c; bestLag = lag; }
            }
            t.IsTrue(c0 > 0.35, "L and R correlate at lag 0 like the console's (corr " + std::to_string(c0) + ")");
            t.IsTrue(std::abs(bestLag) * 8 <= 144, "and the best lag is within 3 ms of zero (" + std::to_string(bestLag * 8) + " frames, corr " + std::to_string(best) + ")");
        });

        // research/36 item 9 (2026-09-20), the instrument: the owner hears 100-450 ms dips on every STREAMED route
        // (the PCM ring, the VAG stems) and none on sounds held in memory. The mixer now counts the PCM ring's stale
        // RUNS (a stretch of output the head spent in blocks the game had not rewritten: one "[audio] 989snd pcm
        // UNDERRUN frame=<start> silent=<n>" line each) and answers how much decoded audio a stream holds ahead of
        // its read head, so a dip in the mix can be read against the buffer that fed it.
        tc.Run("Mixer: the PCM ring counts a stale run once, from its first silent frame to the first fresh one", [](TestCase &t)
        {
            snd989::Mixer mixer;
            mixer.pcmStreamOpen(0x6000u, 2u);                       // 24 blocks of 256 frames (1024 bytes each)
            std::vector<uint8_t> bytes(0x6000u);
            for (size_t i = 0; i < bytes.size(); ++i)
                bytes[i] = static_cast<uint8_t>((i * 7u) & 0x7Fu);
            mixer.pcmStreamWrite(0u, bytes.data(), bytes.size());   // every block fresh
            mixer.pcmStreamStart(0x6000u, 48000u, 2u, 0x400);
            std::vector<int16_t> buf(2 * 6144);
            mixer.render(buf.data(), 6144);                          // one full pass: all fresh, no run
            t.Equals(mixer.pcmStarvationRuns(), static_cast<uint64_t>(0u), "a ring the game keeps fresh has no stale run");
            // The game rewrites blocks 1..23 but not block 0: the head's next block is stale, the one after fresh.
            mixer.pcmStreamWrite(1024u, bytes.data() + 1024u, bytes.size() - 1024u);
            mixer.render(buf.data(), 512);                           // block 0 (stale: 256 silent frames), block 1 (fresh)
            t.Equals(mixer.pcmUnderruns(), static_cast<uint64_t>(1u), "one stale block");
            t.Equals(mixer.pcmStarvationRuns(), static_cast<uint64_t>(1u), "one stale RUN, closed by the fresh block that followed");
            mixer.render(buf.data(), 5632);                          // the rest of the pass: fresh
            t.Equals(mixer.pcmStarvationRuns(), static_cast<uint64_t>(1u), "and no new run while the ring stays fresh");
            mixer.render(buf.data(), 1024);                          // blocks 0..3 again, none rewritten: one run of 4 blocks so far
            mixer.pcmStreamWrite(4096u, bytes.data() + 4096u, 1024u);   // block 4 fresh again
            mixer.render(buf.data(), 512);                           // block 4 (fresh) closes the run
            t.Equals(mixer.pcmStarvationRuns(), static_cast<uint64_t>(2u), "a run of several stale blocks counts once");
            mixer.pcmStreamStop();
        });

        tc.Run("Mixer: streamFramesAhead is the decoded audio ahead of a stream's read head -- it grows with the pump and drains with the render", [](TestCase &t)
        {
            const std::string path = tmpPath("socom2_audio_ahead.vpk");
            t.IsTrue(writeVpk(path, 12, 2), "a 12-chunk-pair VPK (each pair 3584 samples at 32 kHz = 5376 output frames)");
            snd989::Mixer mixer;
            const uint32_t h = 0x04000031u;
            t.IsTrue(mixer.playStream(h, path, 0u, 0x400, -1, 1u), "plays");
            const uint64_t afterPush = mixer.streamFramesAhead(h);
            t.IsTrue(afterPush >= 5000u && afterPush <= 6000u, "the push pre-fills one chunk pair (" + std::to_string(afterPush) + " frames ahead)");
            mixer.pumpStreams();                                     // the worker is off in the tests: fill to the ring's depth
            const uint64_t afterPump = mixer.streamFramesAhead(h);
            t.IsTrue(afterPump >= 4u * 5000u, "the pump fills the ring (" + std::to_string(afterPump) + " frames ahead)");
            std::vector<int16_t> buf(2 * 2400);
            mixer.render(buf.data(), 2400);
            const uint64_t afterRender = mixer.streamFramesAhead(h);
            t.IsTrue(afterRender + 2400u <= afterPump + 8u && afterRender + 2400u + 8u >= afterPump,
                     "a render of 2400 frames takes 2400 off it (" + std::to_string(afterPump) + " -> " + std::to_string(afterRender) + ")");
            t.Equals(mixer.streamFramesAhead(0x04000032u), static_cast<uint64_t>(0u), "an unknown handle has nothing ahead");
            mixer.stopAllStreams();
            std::remove(path.c_str());
        });

        // research/36 item 8: the cue push's decision (FUN_0034b6c0, decomp :246909-246947), as the trace names it.
        tc.Run("socom2 music trace: the cue push verdict follows FUN_0034b6c0 -- no free entry refuses, an unflagged cue is dropped with a 1, a flagged one queues", [](TestCase &t)
        {
            using socom2_music::pushVerdict;
            t.Equals(std::string(pushVerdict(0u, 0u, 0x08u, 0x40u, 0u, 3u, 3u).label), std::string("refused"), "mgr+0x28 == 0: refused");
            t.Equals(std::string(pushVerdict(4u, 0u, 0x08u, 0x40u, 1u, 3u, 3u).label), std::string("dropped"),
                     "flagB 0, type 2, +0x1c bit 6 clear: the push returns 1 without queueing");
            t.Equals(std::string(pushVerdict(4u, 0u, 0x48u, 0x40u, 1u, 3u, 4u).label), std::string("queued"), "+0x1c bit 6: queued");
            t.Equals(std::string(pushVerdict(4u, 0u, 0x08u, 0x60u, 1u, 3u, 4u).label), std::string("queued"), "type 3: queued");
            t.Equals(std::string(pushVerdict(4u, 1u, 0x08u, 0x40u, 1u, 3u, 4u).label), std::string("queued"), "mgr+0xb set: queued");
            t.Equals(std::string(pushVerdict(4u, 1u, 0x08u, 0x40u, 0u, 3u, 3u).label), std::string("refused"), "flagged but the free list head was -1: refused");
        });

        // Sprint 7 Task 12 Step 4 (ruling R97): the owner's "persistent buzz" on the online menus was a 512-byte block
        // looping -- the game's fill landed after the head had passed, and the ring replayed stale bytes. A block the
        // game has not rewritten since the head last played it is now silence, counted, never a loop.
        tc.Run("Mixer: a PCM ring block not rewritten since it was last played is silence and counts an underrun; a rewritten block plays", [](TestCase &t)
        {
            snd989::Mixer mixer;
            mixer.pcmStreamStart(0x6000u, 48000u, 2u, 0x400);   // 24 block pairs of 1024 bytes = 256 frames each
            t.Equals(mixer.pcmUnderruns(), static_cast<uint64_t>(0), "no underruns at start");
            std::vector<uint8_t> ring(0x6000u);
            for (size_t i = 0; i < ring.size(); i += 2) { ring[i] = 0x40; ring[i + 1] = 0x1f; }   // +8000 everywhere
            std::vector<int16_t> buf(2 * 6144);
            auto peak = [&](size_t frames) { int32_t p = 0; for (size_t i = 0; i < 2 * frames; ++i) p = std::max<int32_t>(p, buf[i] < 0 ? -buf[i] : buf[i]); return p; };
            mixer.render(buf.data(), 256);
            t.Equals(peak(256), 0, "nothing written yet: silence");
            t.Equals(mixer.pcmUnderruns(), static_cast<uint64_t>(1), "and that is one underrun");
            mixer.pcmStreamWrite(0u, ring.data(), ring.size());   // the game fills the whole ring, as the log shows before Start
            mixer.render(buf.data(), 6144u);                       // one full ring from block 1: every block fresh, block 0 played at the wrap
            t.IsTrue(peak(6144u) > 3000, "written blocks play");
            t.Equals(mixer.pcmUnderruns(), static_cast<uint64_t>(1), "no new underrun while the fill is ahead");
            t.Equals(mixer.pcmStreamPosition(), 256u * 4u, "back at block 1");
            mixer.render(buf.data(), 256);                         // block 1 again: played once since the write, never rewritten
            t.Equals(peak(256), 0, "a block played once and not rewritten is silence, not a loop");
            t.Equals(mixer.pcmUnderruns(), static_cast<uint64_t>(2), "counted");
            mixer.pcmStreamWrite(2048u, ring.data(), 1024u);       // the game refills block 2 just before the head reaches it
            mixer.render(buf.data(), 256);
            t.IsTrue(peak(256) > 3000, "the refilled block plays");
            t.Equals(mixer.pcmUnderruns(), static_cast<uint64_t>(2), "no underrun for it");
            mixer.pcmStreamStop();
            t.Equals(mixer.pcmUnderruns(), static_cast<uint64_t>(0), "stop resets the count");
        });

        // Sprint 8: the "blip at each menu stream's start" (KNOWN / docs/archive/HUMAN_TASKS-to-2026-09-25.md: "the first ~10 s after a stream
        // start fill a little short"). The game opens the ring, DMAs a whole ring of movie audio into it, and only
        // then starts it -- any run log: snd_PcmStreamOpen [0x6000] -> 0xa0000, snd_PcmStreamStop, the sceCdStRead
        // fills, snd_PcmStreamStart. A ring allocated and zeroed at Start threw that first fill away: one ring of
        // silence and an underrun a block. On the console the ring is IOP memory -- what the EE wrote plays first.
        tc.Run("Mixer: the fill the game makes between PcmStreamOpen and PcmStreamStart is what plays first; a restart with nothing rewritten is still stale (R97)", [](TestCase &t)
        {
            snd989::Mixer mixer;
            std::vector<int16_t> buf(2 * 256);
            auto peak = [&] { int32_t p = 0; for (size_t i = 0; i < 2u * 256u; ++i) p = std::max<int32_t>(p, buf[i] < 0 ? -buf[i] : buf[i]); return p; };
            mixer.pcmStreamOpen(0x6000u, 2u);
            t.IsTrue(!mixer.pcmStreamActive(), "open alone does not start the stream");
            mixer.pcmStreamStop();                                  // the snd_PcmStreamStop the game sends right after the open
            std::vector<uint8_t> ring(0x6000u);
            for (size_t i = 0; i < ring.size(); i += 2) { ring[i] = 0x40; ring[i + 1] = 0x1f; }   // +8000 everywhere
            mixer.pcmStreamWrite(0u, ring.data(), ring.size());     // the EE's DMA, before the start
            mixer.pcmStreamStart(0x6000u, 48000u, 2u, 0x400);
            mixer.render(buf.data(), 256);
            t.IsTrue(peak() > 3000, "the pre-start fill plays (peak " + std::to_string(peak()) + ")");
            t.Equals(mixer.pcmUnderruns(), static_cast<uint64_t>(0), "and costs no underrun");
            // R97's policy survives a restart: a block played once and never rewritten is silence, counted.
            mixer.pcmStreamStop();
            mixer.pcmStreamStart(0x6000u, 48000u, 2u, 0x400);
            mixer.render(buf.data(), 256);
            t.Equals(peak(), 0, "a restart replays nothing: block 0 was consumed and never rewritten");
            t.Equals(mixer.pcmUnderruns(), static_cast<uint64_t>(1), "counted as an underrun");
            // Close frees the ring: a write before the next open has nowhere to land, as on the console.
            mixer.pcmStreamClose();
            mixer.pcmStreamWrite(0u, ring.data(), ring.size());
            mixer.pcmStreamStart(0x6000u, 48000u, 2u, 0x400);
            mixer.render(buf.data(), 256);
            t.Equals(peak(), 0, "after close the write is dropped: a fresh Start ring is silence");
        });

        tc.Run("Mixer: the PCM ring plays block-interleaved stereo (512-byte L and R blocks, as the movie audio is laid out) at its rate, reports its position, wraps, and stops", [](TestCase &t)
        {
            snd989::Mixer mixer;
            t.IsTrue(!mixer.pcmStreamActive(), "no PCM stream before start");
            t.Equals(mixer.pcmStreamPosition(), 0u, "position 0 before start");
            mixer.pcmStreamStart(0x6000u, 48000u, 2u, 0x400);
            t.IsTrue(mixer.pcmStreamActive(), "started");
            // 512-byte blocks alternating L (+8000) and R (-8000) over the whole ring: the SShd interleave of the movie audio.
            std::vector<uint8_t> ring(0x6000u);
            for (size_t i = 0; i < ring.size(); i += 2)
            {
                const int16_t v = ((i / 512) % 2 == 0) ? static_cast<int16_t>(8000) : static_cast<int16_t>(-8000);   // 512 bytes of L, 512 of R
                ring[i] = static_cast<uint8_t>(v & 0xFF);
                ring[i + 1] = static_cast<uint8_t>((v >> 8) & 0xFF);
            }
            mixer.pcmStreamWrite(0u, ring.data(), ring.size());
            std::vector<int16_t> buf(2 * 6144);   // sized for the largest render below
            mixer.render(buf.data(), 512);
            double left = 0, right = 0;
            for (size_t i = 0; i < 512; ++i)
            {
                left += buf[2 * i];
                right += buf[2 * i + 1];
            }
            t.IsTrue(left > 0 && right < 0, "left blocks to the left channel, right blocks to the right (L " + std::to_string(left) + " R " + std::to_string(right) + ")");
            t.IsTrue(std::fabs(left + right) < 0.02 * (std::fabs(left) + std::fabs(right)), "equal magnitudes");
            const int32_t sample = buf[0];
            t.IsTrue(sample >= 3600 && sample <= 4400, "vol 0x400 at half scale: 8000 -> about 4000 (got " + std::to_string(sample) + ")");
            t.Equals(mixer.pcmStreamPosition(), 512u * 4u, "512 frames of stereo 16-bit consumed 2048 bytes");
            // 0x6000 bytes = 6144 frames; 6144 - 512 more frames reach the end, then it wraps to 0.
            mixer.render(buf.data(), 6144u - 512u);
            t.Equals(mixer.pcmStreamPosition(), 0u, "the ring wraps");
            mixer.render(buf.data(), 100u);
            t.Equals(mixer.pcmStreamPosition(), 400u, "and continues from the start");
            // A rate below the output rate stretches: 24000 Hz consumes half the bytes per frame.
            mixer.pcmStreamStop();
            t.IsTrue(!mixer.pcmStreamActive() && mixer.pcmStreamPosition() == 0u, "stopped: inactive, position 0");
            mixer.render(buf.data(), 512);
            int32_t peak = 0;
            for (size_t i = 0; i < 2u * 512u; ++i)   // only the frames this render wrote
                peak = std::max<int32_t>(peak, buf[i] < 0 ? -buf[i] : buf[i]);
            t.Equals(peak, 0, "silence after stop");
            mixer.pcmStreamStart(0x6000u, 24000u, 2u, 0x400);
            mixer.pcmStreamWrite(0u, ring.data(), ring.size());
            mixer.render(buf.data(), 512);
            t.Equals(mixer.pcmStreamPosition(), 256u * 4u, "24 kHz: 512 output frames consume 256 ring frames");
            mixer.pcmStreamStop();
        });

        tc.Run("PS2AudioBackend routes the PCM stream: start, the EE's ring writes, the position the module reports, stop", [](TestCase &t)
        {
            PS2AudioBackend backend;
            uint32_t position = 0;
            t.IsTrue(!backend.pcmPosition(position), "no PCM stream: the module answers 0 itself");
            const int32_t start[5] = {0x6000, 0, 2, 0x366, 0x01a00000};
            backend.onNotify(0x3Eu, start, 5u);
            t.IsTrue(backend.pcmPosition(position) && position == 0u, "started at position 0");
            std::vector<uint8_t> half(0x3000u);
            for (size_t i = 0; i < half.size(); i += 2)
            {
                const int16_t v = ((i / 512) % 2 == 0) ? 6000 : -6000;   // 512 bytes of L, 512 of R
                half[i] = static_cast<uint8_t>(v & 0xFF);
                half[i + 1] = static_cast<uint8_t>((v >> 8) & 0xFF);
            }
            backend.onPcmWrite(0u, half.data(), half.size());
            std::vector<int16_t> buf(2 * 1024);
            backend.mixerRender(buf.data(), 1024);
            double left = 0, right = 0;
            for (size_t i = 0; i < 1024; ++i)
            {
                left += buf[2 * i];
                right += buf[2 * i + 1];
            }
            t.IsTrue(left > 0 && right < 0, "the ring's left blocks play left, right blocks right");
            t.IsTrue(backend.pcmPosition(position) && position == 1024u * 4u, "position after 1024 frames: 4096 bytes");
            const int32_t none[1] = {0};
            backend.onNotify(0x3Du, none, 1u);
            t.IsTrue(!backend.pcmPosition(position), "snd_PcmStreamStop: no stream");
        });

        tc.Run("PS2AudioBackend routes snd_PcmStreamOpen: the ring the EE fills before the start is not thrown away by it", [](TestCase &t)
        {
            PS2AudioBackend backend;
            const int32_t open[2] = {0x6000, 2};
            backend.onNotify(0x3Bu, open, 2u);                 // snd_PcmStreamOpen, forwarded by the IOP module
            const int32_t none[1] = {0};
            backend.onNotify(0x3Du, none, 1u);                 // the snd_PcmStreamStop that follows it
            std::vector<uint8_t> fill(0x6000u);
            for (size_t i = 0; i < fill.size(); i += 2) { fill[i] = 0x40; fill[i + 1] = 0x1f; }   // +8000
            backend.onPcmWrite(0u, fill.data(), fill.size());   // the EE's SIF DMA into the ring
            const int32_t start[5] = {0x6000, 0, 2, 0x400, 0x000a0000};
            backend.onNotify(0x3Eu, start, 5u);
            std::vector<int16_t> buf(2 * 256);
            backend.mixerRender(buf.data(), 256);
            int32_t peak = 0;
            for (size_t i = 0; i < 2u * 256u; ++i) peak = std::max<int32_t>(peak, buf[i] < 0 ? -buf[i] : buf[i]);
            t.IsTrue(peak > 3000, "the pre-start fill plays through the backend (peak " + std::to_string(peak) + ")");
            uint32_t position = 0;
            backend.onNotify(0x3Cu, none, 1u);                 // snd_PcmStreamClose
            t.IsTrue(!backend.pcmPosition(position), "close leaves no stream");
        });

        tc.Run("volumeGain: 0-100 percent to a linear gain, out of range clamped", [](TestCase &t)
        {
            t.IsTrue(volumeGain(100) == 1.0f, "100 is unity -- byte for byte the mix the renderer produced");
            t.IsTrue(volumeGain(0) == 0.0f, "0 is silence");
            t.IsTrue(volumeGain(50) == 0.5f, "50 is half");
            t.IsTrue(volumeGain(150) == 1.0f, "above the range is unity, never a gain above 1 that would clip the mix");
            t.IsTrue(volumeGain(-10) == 0.0f, "below the range is silence, never a negative gain that would invert it");
            t.IsTrue(volumeGain(1) > 0.0f && volumeGain(1) < 0.02f, "the bottom step is quiet, not muted");
        });

        tc.Run("MicRing: write n, read n, and it wraps without tearing a frame", [](TestCase &t)
        {
            MicRing ring(8);
            int16_t out[16] = {};
            t.Equals(ring.available(), static_cast<size_t>(0), "a new ring is empty");
            t.Equals(ring.read(out, 4), static_cast<size_t>(0), "reading an empty ring yields nothing");
            const int16_t a[4] = {1, 2, 3, 4};
            t.Equals(ring.write(a, 4), static_cast<size_t>(4), "four in");
            t.Equals(ring.available(), static_cast<size_t>(4), "four waiting");
            t.Equals(ring.read(out, 4), static_cast<size_t>(4), "four out");
            t.IsTrue(out[0] == 1 && out[1] == 2 && out[2] == 3 && out[3] == 4, "in the order they went in");
            // Six more from a read cursor at 4 in an 8-frame ring: the second half wraps past the end.
            const int16_t b[6] = {5, 6, 7, 8, 9, 10};
            t.Equals(ring.write(b, 6), static_cast<size_t>(6), "six in, across the wrap");
            t.Equals(ring.read(out, 6), static_cast<size_t>(6), "six out, across the wrap");
            for (int i = 0; i < 6; ++i)
                t.Equals(static_cast<int>(out[i]), 5 + i, "every frame survived the wrap");
            // Overrun: capacity is 8, so 9 cannot fit and the oldest are NOT silently overwritten.
            const int16_t c[9] = {1, 1, 1, 1, 1, 1, 1, 1, 1};
            t.Equals(ring.write(c, 9), static_cast<size_t>(8), "a full ring takes what fits");
            t.Equals(ring.dropped(), static_cast<size_t>(1), "and counts what it dropped");
            t.Equals(ring.read(out, 16), static_cast<size_t>(8), "reading more than there is yields what there is");
        });

        // Sprint 8 review MUST FIX: capture runs from boot, so by the time the game asks to record the ring
        // is holding a whole second of whatever was said before -- and that stale second is what got sent,
        // which is exactly the ~1 s lateness heard on the voice path. clear() drops it, from the CONSUMER
        // side only (advance the read index; the capture callback owns the write index and is never touched).
        tc.Run("MicRing::clear drops every unread frame and leaves the ring usable", [](TestCase &t)
        {
            MicRing ring(8);
            int16_t out[16] = {};
            const int16_t stale[5] = {-1, -2, -3, -4, -5};
            t.Equals(ring.write(stale, 5), static_cast<size_t>(5), "five stale frames in");
            t.Equals(ring.available(), static_cast<size_t>(5), "five waiting");
            t.Equals(ring.clear(), static_cast<size_t>(5), "clear reports what it discarded");
            t.Equals(ring.available(), static_cast<size_t>(0), "the ring is empty after clear");
            t.Equals(ring.read(out, 4), static_cast<size_t>(0), "and reads nothing");
            const int16_t fresh[4] = {7, 8, 9, 10};
            t.Equals(ring.write(fresh, 4), static_cast<size_t>(4), "a write after clear is taken");
            t.Equals(ring.read(out, 4), static_cast<size_t>(4), "and read back");
            for (int i = 0; i < 4; ++i)
                t.Equals(static_cast<int>(out[i]), 7 + i, "intact, in order, across the cleared cursor");
            t.Equals(ring.clear(), static_cast<size_t>(0), "clearing an empty ring discards nothing");
        });

        // Sprint 8 Goal 3 Task 1: the microphone arithmetic, device-free so it runs in CI, in the VM and on a
        // machine with no microphone at all. The game asks lgAudOpen for 11025 Hz mono 16-bit
        // (game/analysis/socom2_game.elf.decomp.c:48341, openparam+0x04 = 0x2b11), so the ring's 16 kHz is
        // always resampled down -- which retracts host_mic.h's "16 kHz" FORMAT ASSUMPTION.
        tc.Run("micResampleLinear carries its phase across calls and never clicks at the seam", [](TestCase &t)
        {
            // A 16 kHz ramp resampled to 11025 Hz: the game's rate (decomp :48341, 0x2b11).
            std::vector<int16_t> in(1600);
            for (size_t i = 0; i < in.size(); ++i)
                in[i] = static_cast<int16_t>(i * 10);
            MicFormat fmt{11025u, 1u, 16u};
            t.IsTrue(fmt.supported(), "11025 Hz mono 16-bit is what the game asks for");
            t.Equals(fmt.bytesPerFrame(), size_t{2}, "mono 16-bit is two bytes a frame");

            std::vector<int16_t> out(1102);
            double phase = 0.0;
            const size_t firstHalf = micResampleLinear(in.data(), 800u, 16000u, out.data(), 551u, 11025u, phase);
            t.Equals(firstHalf, size_t{551}, "the first half fills");
            t.IsTrue(phase > 0.0, "the fractional position is carried, not dropped");
            const size_t consumed = micFramesNeeded(551u, 16000u, 11025u, 0.0);
            t.IsTrue(consumed <= 800u, "the arithmetic never asks for more input than it was given");

            const size_t secondHalf = micResampleLinear(in.data() + consumed, 800u - consumed + 800u, 16000u,
                                                        out.data() + 551u, 551u, 11025u, phase);
            t.Equals(secondHalf, size_t{551}, "the second half fills");
            // A ramp stays a ramp: every step is positive and within one input step of the last.
            for (size_t i = 1; i < out.size(); ++i)
                t.IsTrue(out[i] > out[i - 1], "the resampled ramp is still monotonic across the seam");
        });

        // Sprint 10 Q7 item 3 (KNOWN 110 b): lgaud read micFramesNeeded() frames from the host ring -- a CONSUMING
        // read -- and handed them to the resampler, which for its last output sample interpolates between in[i0]
        // and in[i0 + 1] and then advances by floor(phase + step * outFrames). Those two counts agree only when
        // the step is a whole number (16000 -> 8000: 2.0). At every other rate the ring gave up one lookahead
        // frame per read that the resampler never advanced past, so about half the reads at 11025 Hz (the rate
        // the game asks for, decomp :48341) dropped one input frame at the seam. The monotonic-ramp case above
        // cannot see it: a ramp with a frame missing is still a ramp. This one can: a linear resample of the
        // ramp in[i] = 4 * i is the ramp read at the output positions, so every served sample must sit at
        // 4 * k * step within one LSB of rounding, across every read boundary, at every rate MicFormat accepts.
        tc.Run("a microphone stream pulled through the resampler in reads drops no input frame at any rate MicFormat accepts (KNOWN 110 b)", [](TestCase &t)
        {
            std::vector<int16_t> source(8192);   // 4 * 8191 fits an int16; 12 reads at step 4 need about 5650
            for (size_t i = 0; i < source.size(); ++i)
                source[i] = static_cast<int16_t>(4u * i);
            size_t ratesChecked = 0, ratesWrong = 0;
            uint32_t firstWrongRate = 0;
            size_t firstWrongRead = 0, firstWrongSample = 0;
            double firstWrongGot = 0.0, firstWrongWant = 0.0;
            for (uint32_t rate = 4000u; rate <= 48000u; rate += 1u)
            {
                if (!MicFormat{rate, 1u, 16u}.supported())
                    continue;
                ++ratesChecked;
                const double step = 16000.0 / static_cast<double>(rate);
                MicResampleFeed feed;
                size_t cursor = 0;              // the consuming ring: what is read is gone
                size_t servedTotal = 0;
                bool wrong = false;
                // Reads of odd sizes so the seam lands at every phase; about 17 a second in the game.
                const size_t sizes[5] = {97u, 130u, 61u, 211u, 89u};
                for (size_t r = 0; r < 12 && !wrong; ++r)
                {
                    const size_t want = sizes[r % 5];
                    std::vector<int16_t> out(want, 0);
                    const size_t served = feed.pull(out.data(), want, 16000u, rate, [&](int16_t *dst, size_t n)
                    {
                        const size_t got = std::min(n, source.size() - cursor);
                        std::memcpy(dst, source.data() + cursor, got * sizeof(int16_t));
                        cursor += got;
                        return got;
                    });
                    for (size_t k = 0; k < served; ++k)
                    {
                        const double wantValue = 4.0 * static_cast<double>(servedTotal + k) * step;
                        if (std::fabs(static_cast<double>(out[k]) - wantValue) > 1.0)
                        {
                            wrong = true;
                            if (ratesWrong == 0)
                            {
                                firstWrongRate = rate; firstWrongRead = r; firstWrongSample = k;
                                firstWrongGot = out[k]; firstWrongWant = wantValue;
                            }
                            break;
                        }
                    }
                    servedTotal += served;
                    if (served != want && !wrong)
                    {
                        wrong = true;   // the source holds 8192 frames, enough for every rate here
                        if (ratesWrong == 0)
                        {
                            firstWrongRate = rate; firstWrongRead = r; firstWrongSample = served;
                            firstWrongGot = static_cast<double>(served); firstWrongWant = static_cast<double>(want);
                        }
                    }
                }
                ratesWrong += wrong ? 1u : 0u;
            }
            t.Equals(ratesChecked, size_t{44001}, "every rate from 4000 to 48000 Hz was walked");
            if (ratesWrong != 0)
                std::printf("mic feed: %zu of %zu rates lose a frame; first at %u Hz, read %zu sample %zu: got %.0f want %.1f\n",
                            ratesWrong, ratesChecked, firstWrongRate, firstWrongRead, firstWrongSample, firstWrongGot, firstWrongWant);
            t.Equals(ratesWrong, size_t{0}, "no rate loses or repeats an input frame across a read boundary");
        });

        tc.Run("micResampleLinear reports the input frames it has finished with, which is fewer than it needed to see", [](TestCase &t)
        {
            std::vector<int16_t> in(64, 0);
            std::vector<int16_t> out(8, 0);
            double phase = 0.0;
            size_t consumed = 0;
            // 16000 -> 11025: step 1.4512...; 8 outputs read up to in[floor(7 * step) + 1] = in[11], so 12 frames
            // are NEEDED, but the stream has only advanced by floor(8 * step) = 11 -- in[11] is next read's in[0].
            t.Equals(micFramesNeeded(8u, 16000u, 11025u, 0.0), size_t{12}, "needed: the lookahead included");
            t.Equals(micResampleLinear(in.data(), 12u, 16000u, out.data(), 8u, 11025u, phase, &consumed), size_t{8}, "eight written");
            t.Equals(consumed, size_t{11}, "consumed: floor(8 * step), one fewer than needed");
            t.IsTrue(std::fabs(phase - (8.0 * 16000.0 / 11025.0 - 11.0)) < 1e-9, "the phase left is the fraction past the consumed frames");
            // At a whole-number step the two agree, which is why the 8000 Hz harness never saw the defect.
            phase = 0.0;
            t.Equals(micFramesNeeded(8u, 16000u, 8000u, 0.0), size_t{16}, "needed at step 2");
            t.Equals(micResampleLinear(in.data(), 16u, 16000u, out.data(), 8u, 8000u, phase, &consumed), size_t{8}, "eight written at step 2");
            t.Equals(consumed, size_t{16}, "consumed at step 2: the same");
            // Equal rates: a copy, all of it consumed.
            t.Equals(micResampleLinear(in.data(), 8u, 16000u, out.data(), 8u, 16000u, phase, &consumed), size_t{8}, "copied");
            t.Equals(consumed, size_t{8}, "a copy consumes what it copied");
        });

        tc.Run("MicFormat refuses what we cannot serve", [](TestCase &t)
        {
            t.IsTrue(!MicFormat{11025u, 2u, 16u}.supported(), "stereo capture is refused");
            t.IsTrue(!MicFormat{11025u, 1u, 8u}.supported(), "8-bit capture is refused");
            t.IsTrue(!MicFormat{96000u, 1u, 16u}.supported(), "a rate outside 4000..48000 is refused");
            t.IsTrue(MicFormat{16000u, 1u, 16u}.supported(), "the ring's own rate is of course supported");
        });
        // Sprint 7 Task 12a: the owner's run of 2026-09-18 played six VAG streams, stopped four of them with
        // snd_StopSound, and then logged "no free VAG stream slot" 237 times to the end of the run -- stopSound()
        // only ever looked in the bank-sound table, so a stream handle (type 4) freed nothing.
        // The music, round four, second reading (research/36 Q1, 2026-09-20). Commit e39a8dc had a played-out stream
        // keep answering its handle until its slot was retaken; that was a misreading of the IRX. What the IRX does:
        // the streamer's per-tick update (FUN_0001107c) deactivates the handler of a stream whose final buffer has
        // played and whose voice envelope has reached zero, and snd_DeactivateHandler CLEARS BIT 31 of the handle
        // word it leaves in the slot (research/989snd-ziemas/iop/sndhand.c:237 `snd->OwnerID &= ~0x80000000`; IRX
        // FUN_0000d4a4 `*param_1 = *param_1 & 0x7fffffff`). Every handle the EE holds has bit 31 SET (activation,
        // sndhand.c:148), and snd_CheckHandlerStillActive compares the WHOLE word (sndhand.c:270-310; IRX
        // FUN_0000d6b4 `if (*puVar1 == param_1) return puVar1; return 0`) -- so from the next tick the poll answers
        // 0, and the slot (Sound == NULL) is the first one snd_FindFreeHandler will hand out. The EE's music manager
        // relies on that 0 to leave its "playing" state and start the next stem fresh; with e39a8dc it never did.
        tc.Run("989snd: a VAG stream that played out answers 0 to snd_SoundIsStillPlaying on the next poll and its slot is free (the IRX's deactivated handler)", [](TestCase &t)
        {
            // A host that answers for the handles it was told to play: playing until the test says the audio ended.
            class AnsweringHost final : public Snd989TestHost
            {
            public:
                std::vector<uint32_t> known;
                std::vector<uint32_t> ended;
                void audioNotify(uint32_t function, const int32_t *args, size_t count) override
                {
                    if (function == 0x2Cu && count >= 1)
                        known.push_back(static_cast<uint32_t>(args[0]));
                }
                bool audioIsPlaying(uint32_t handle, bool &playing) const override
                {
                    if (std::find(known.begin(), known.end(), handle) == known.end())
                        return false;
                    playing = std::find(ended.begin(), ended.end(), handle) == ended.end();
                    return true;
                }
            };
            Snd989HarnessT<AnsweringHost> h;
            t.IsTrue(h.configured, "the SOCOM II profile registers the 989snd service");
            constexpr uint32_t kInitVagStreaming = 0x2Au;
            constexpr uint32_t kPlayVagStreamByLoc = 0x2Cu;
            constexpr uint32_t kIsStillPlaying = 0x19u;
            const std::vector<uint32_t> play = {2000u, 0u, 0x04000000u, 0u, 1u, 0u, 0u, 0u};   // group 1, parent 0
            t.Equals(h.call(kInitVagStreaming, {2u, 0x8000u}), 1u, "two stream slots");

            const uint32_t a = h.call(kPlayVagStreamByLoc, play);
            t.IsTrue(a != 0u && ((a >> 24) & 0x1Fu) == 4u, "stem A gets a stream handle");
            t.Equals(h.call(kIsStillPlaying, {a}), a, "playing while the mixer says so");

            // A live parent still chains (R169): the queued segment rides A's slot and handle.
            std::vector<uint32_t> queued = play;
            queued[5] = a;
            const uint32_t q = h.call(kPlayVagStreamByLoc, queued);
            t.Equals(q, a, "a stem queued behind the LIVE A chains onto A's handle, as before");

            AnsweringHost &host = h.host;
            host.ended.push_back(a);
            t.Equals(h.call(kIsStillPlaying, {a}), 0u,
                     "the audio ended: the next poll answers 0 (sndhand.c:237 cleared bit 31; FUN_0000d6b4's whole-word compare fails)");
            t.Equals(h.call(kIsStillPlaying, {a}), 0u, "and stays 0 on the poll after that");

            // A queue behind the dead handle cannot resolve its parent (FUN_0000d6b4 returns 0): the IRX's
            // FUN_0000f7e0 falls through to a FRESH play (param_8 = 0), never a chain onto the freed slot.
            const uint32_t behindDead = h.call(kPlayVagStreamByLoc, queued);
            t.IsTrue(behindDead != 0u && behindDead != a, "a play queued behind the dead A starts fresh under a new handle");
            host.ended.push_back(behindDead);

            // A fresh play (no parent) takes the first free slot -- A's, freed by the poll -- under a NEW handle
            // (snd_FindFreeHandler bumps the low 16 bits, sndhand.c:55-56; IRX FUN_000163f4).
            const uint32_t b = h.call(kPlayVagStreamByLoc, play);
            t.IsTrue(b != 0u && b != a, "stem B gets a handle of its own");
            t.Equals((b >> 16) & 0xFFu, (a >> 16) & 0xFFu, "in A's slot: the first free one");
            t.Equals(h.call(kIsStillPlaying, {a}), 0u, "A still answers 0");
            t.Equals(h.call(kIsStillPlaying, {b}), b, "B answers itself");

            // Played-out slots never leak (the 107 x "no free VAG stream slot" of 2026-09-18): with both slots'
            // audio ended and no poll in between, four more plays all get slots -- the reap on play frees them.
            host.ended.push_back(b);
            for (int i = 0; i < 4; ++i)
            {
                const uint32_t n = h.call(kPlayVagStreamByLoc, play);
                t.IsTrue(n != 0u, "play " + std::to_string(i) + " after the ended ones gets a slot");
                host.ended.push_back(n);
            }
        });

        tc.Run("989snd: snd_StopSound on a VAG stream handle frees its stream slot", [](TestCase &t)
        {
            Snd989Harness h;
            t.IsTrue(h.configured, "the SOCOM II profile registers the 989snd service");

            constexpr uint32_t kInitVagStreaming = 0x2Au;
            constexpr uint32_t kPlayVagStreamByLoc = 0x2Cu;
            constexpr uint32_t kStopSound = 0x15u;
            const std::vector<uint32_t> play = {2000u, 0u, 0x04000000u, 0u, 0u, 0u, 0u, 0u};   // parent (word 5) = 0

            t.Equals(h.call(kInitVagStreaming, {2u, 0x8000u}), 1u, "snd_InitVAGStreamingEx takes its two slots");

            const uint32_t first = h.call(kPlayVagStreamByLoc, play);
            t.IsTrue(first != 0u, "the first stream gets a slot");
            t.Equals((first >> 24) & 0x1Fu, 4u, "and a type-4 (stream) handle");

            h.call(kStopSound, {first});

            t.IsTrue(h.call(kPlayVagStreamByLoc, play) != 0u, "a stream plays after the stop");
            t.IsTrue(h.call(kPlayVagStreamByLoc, play) != 0u,
                     "and so does the next one: snd_StopSound freed the stopped stream's slot");
        });

        // research/36 Q6 item 4 (2026-09-20): the IRX's snd_SetSoundParams (FUN_0000bcbc; playsnd.c:304-306, 340)
        // answers the handle for ANY live handler, or 0. The EE polls its POSITIONED entries with 0x21 instead of
        // 0x19 (FUN_00346ea0, flag bit 0: SetSoundParams with the same completion callback), and the module answered
        // 0 for every stream handle -- so every positioned stream (the Sprint 9 Q0 voice lines, a positioned music
        // cue) read as dead on its first poll. Same class of bug as Q1, in the other direction.
        tc.Run("989snd: snd_SetSoundParams answers the handle for a live VAG STREAM too, and 0 once it has played out (the IRX's FUN_0000bcbc)", [](TestCase &t)
        {
            class AnsweringHost final : public Snd989TestHost
            {
            public:
                std::vector<uint32_t> known;
                std::vector<uint32_t> ended;
                void audioNotify(uint32_t function, const int32_t *args, size_t count) override
                {
                    if (function == 0x2Cu && count >= 1)
                        known.push_back(static_cast<uint32_t>(args[0]));
                }
                bool audioIsPlaying(uint32_t handle, bool &playing) const override
                {
                    if (std::find(known.begin(), known.end(), handle) == known.end())
                        return false;
                    playing = std::find(ended.begin(), ended.end(), handle) == ended.end();
                    return true;
                }
            };
            Snd989HarnessT<AnsweringHost> h;
            t.IsTrue(h.configured, "the SOCOM II profile registers the 989snd service");
            constexpr uint32_t kInitVagStreaming = 0x2Au;
            constexpr uint32_t kPlayVagStreamByLoc = 0x2Cu;
            constexpr uint32_t kSetSoundParams = 0x21u;
            constexpr uint32_t kIsStillPlaying = 0x19u;
            // A positioned voice line: vol 0, flags 2, then raised with SetSoundParams (Sprint 9 Q0).
            const std::vector<uint32_t> play = {2000u, 0u, 0u, 0u, 1u, 0u, 0u, 2u};
            t.Equals(h.call(kInitVagStreaming, {2u, 0x8000u}), 1u, "two stream slots");

            const uint32_t s = h.call(kPlayVagStreamByLoc, play);
            t.IsTrue(s != 0u && ((s >> 24) & 0x1Fu) == 4u, "the stream gets a type-4 handle");
            t.Equals(h.call(kSetSoundParams, {s, 1u, 0x400u, 0u}), s, "SetSoundParams(mask bit0, vol) on the live stream answers the HANDLE");
            t.Equals(h.call(kSetSoundParams, {s, 6u, 0u, 90u}), s, "and so does a pan-only call");
            t.IsTrue(!h.host.audioCommands.empty() && h.host.audioCommands.back() == kSetSoundParams,
                     "the call still reaches the host (the mixer's setVolPan)");
            t.Equals(h.call(kSetSoundParams, {s ^ 0x1u, 1u, 0x400u, 0u}), 0u, "a stream handle nothing owns answers 0");

            h.host.ended.push_back(s);
            t.Equals(h.call(kSetSoundParams, {s, 1u, 0x400u, 0u}), 0u,
                     "once the mixer has finished it the answer is 0: the IRX's deactivated handler (sndhand.c:237)");
            t.Equals(h.call(kIsStillPlaying, {s}), 0u, "and 0x19 agrees");
            const uint32_t next = h.call(kPlayVagStreamByLoc, play);
            t.IsTrue(next != 0u && next != s, "the next play gets a fresh handle");
            t.Equals((next >> 16) & 0xFFu, (s >> 16) & 0xFFu, "in the slot the 0x21 poll freed");
        });

        // Task 12c: 971 "play request for unknown bank" lines for banks that were loaded and never unloaded. The
        // reject path itself has to stay harmless (return 0, play nothing) while a loaded bank still plays.
        tc.Run("989snd: a play on an unknown bank handle is rejected without disturbing a loaded bank", [](TestCase &t)
        {
            Snd989Harness h;
            t.IsTrue(h.configured, "the SOCOM II profile registers the 989snd service");

            constexpr uint32_t kBankLoadByLoc = 0x03u;
            constexpr uint32_t kPlaySound = 0x11u;

            const uint32_t bank = h.call(kBankLoadByLoc, {2010461u, 0u});
            t.IsTrue(bank != 0u, "snd_BankLoadByLoc returns a bank handle even with no disc image");

            t.Equals(h.call(kPlaySound, {0xDEADBEEFu, 8u, 0x400u, 0xFFFFFFFFu, 0u, 0u}), 0u,
                     "a play on a handle no bank owns returns 0");
            t.IsTrue(h.call(kPlaySound, {bank, 8u, 0x400u, 0xFFFFFFFFu, 0u, 0u}) != 0u,
                     "and the loaded bank still plays");
        });

        // Sprint 7 Task 12b, the larger stream leak (the owner's run of 2026-09-18, logs/run_20260918_044701.log):
        // 12 streams played, only 4 ever stopped, then 107 x "no free VAG stream slot". A one-shot VAG stream that
        // plays to its natural end is never stopped by the game -- it polls snd_SoundIsStillPlaying and reuses the
        // slot when the answer is "done" (4440 polls of 0x04030005 / 0x04050008 in that run). The console's IRX
        // learns the end from the mixer; the model has to ask the host the same question, or the slot leaks for the
        // rest of the run and so does the game's own handle.
        tc.Run("989snd: a VAG stream that plays to its end is reported done and its slot is reusable", [](TestCase &t)
        {
            const std::string path = tmpPath("socom2_audio_stream_end_image.bin");
            t.IsTrue(writeOneChunkVpkImage(path), "the one-chunk VPK image is written");

            Snd989HarnessT<Snd989MixerHost> h;
            t.IsTrue(h.configured, "the SOCOM II profile registers the 989snd service");
            h.host.backend.setDiscImagePath(path);

            constexpr uint32_t kInitVagStreaming = 0x2Au;
            constexpr uint32_t kPlayVagStreamByLoc = 0x2Cu;
            constexpr uint32_t kSoundIsStillPlaying = 0x19u;
            const std::vector<uint32_t> play = {2u, 0u, 0x04000000u, 0u, 0u, 0u, 0u, 0u};   // sector 2, vol 0x400, parent 0

            t.Equals(h.call(kInitVagStreaming, {2u, 0x8000u}), 1u, "snd_InitVAGStreamingEx takes its two slots");

            const uint32_t first = h.call(kPlayVagStreamByLoc, play);
            t.IsTrue(first != 0u, "the first stream gets a slot");
            t.Equals(h.host.backend.mixerActiveStreams(), static_cast<size_t>(1u), "and the mixer opened it");
            t.Equals(h.call(kSoundIsStillPlaying, {first}), first, "while it plays, the game's poll says still playing");

            // Render past the end of the chunk (3584 samples at 32 kHz = 5376 frames out).
            std::vector<int16_t> buf(2 * 4800);
            for (int i = 0; i < 3; ++i)
            {
                h.host.backend.mixerPumpStreams();
                h.host.backend.mixerRender(buf.data(), 4800);
            }
            bool playing = true;
            t.IsTrue(h.host.backend.isPlaying(first, playing) && !playing, "the mixer has finished the stream");

            // The music, round four, second reading (research/36 Q1): the IRX deactivates the handler on the tick the
            // voice's envelope reaches zero on the final buffer (FUN_0001107c -> FUN_0000d4a4), clearing bit 31 of
            // the handle word (sndhand.c:237); the EE's handle keeps bit 31, so the whole-word compare of
            // snd_CheckHandlerStillActive (sndhand.c:270-310, FUN_0000d6b4) fails -- the poll answers 0 at once, and
            // that 0 is what lets the EE's music manager free its cue entry and start the next stem.
            t.Equals(h.call(kSoundIsStillPlaying, {first}), 0u, "the game's poll says done, as the IRX does (bit 31 cleared)");
            t.Equals(h.call(kSoundIsStillPlaying, {first}), 0u, "and keeps saying so");
            const uint32_t second = h.call(kPlayVagStreamByLoc, play);
            t.IsTrue(second != 0u && second != first, "a stream plays into the freed slot under a new handle");
            t.Equals((second >> 16) & 0xFFu, (first >> 16) & 0xFFu, "the first slot: the played-out one was freed, not leaked");
            t.Equals(h.call(kSoundIsStillPlaying, {first}), 0u, "the old handle still reads done");
            t.IsTrue(h.call(kPlayVagStreamByLoc, play) != 0u, "and the next one takes the other slot");

            std::remove(path.c_str());
        });

        // Sprint 9 Goal 10 (R169): the module and the host have to agree on what parentHandle means. The module
        // reuses the parent's slot and keeps its handle -- correct, the game polls that handle -- but it told the
        // host nothing about the queue, so the host saw a second play on a live handle and replaced it. The word
        // goes on the wire.
        tc.Run("989snd: a play with a parentHandle tells the host it is QUEUED behind the parent, not a replacement", [](TestCase &t)
        {
            Snd989HarnessT<Snd989NotifyRecorderHost> h;
            t.IsTrue(h.configured, "the SOCOM II profile registers the 989snd service");
            constexpr uint32_t kInitVagStreaming = 0x2Au;
            constexpr uint32_t kPlayVagStreamByLoc = 0x2Cu;
            t.Equals(h.call(kInitVagStreaming, {2u, 0x8000u}), 1u, "snd_InitVAGStreamingEx takes its two slots");

            const uint32_t first = h.call(kPlayVagStreamByLoc, {2u, 0u, 0x04000000u, 0u, 0u, 0u, 0u, 0u});
            t.IsTrue(first != 0u, "the parent gets a slot");
            const Snd989NotifyRecorderHost::Notify *fresh = h.host.last(kPlayVagStreamByLoc);
            t.IsTrue(fresh != nullptr, "the host was told about it");
            if (fresh != nullptr)
            {
                t.IsTrue(fresh->args.size() >= 10u, "the play carries a tenth word: is this a queue? (" +
                                                        std::to_string(fresh->args.size()) + " words)");
                if (fresh->args.size() >= 10u)
                    t.Equals(fresh->args[9], 0, "a play with no parent is not a queue");
            }

            const uint32_t queued = h.call(kPlayVagStreamByLoc, {2u, 0u, 0x04000000u, 0u, 0u, first, 0u, 0u});
            t.Equals(queued, first, "the queued segment keeps the parent's handle: that is what the game polls");
            const Snd989NotifyRecorderHost::Notify *behind = h.host.last(kPlayVagStreamByLoc);
            t.IsTrue(behind != nullptr, "the host was told about the queued one too");
            if (behind != nullptr && behind->args.size() >= 10u)
                t.Equals(behind->args[9], 1, "and it is marked a queue, so the host does not replace what is playing");
        });

        // Sprint 9 Q0 (2026-09-20). Every music cue in the driven mission arrives as snd_PlayVAGStreamByLoc
        // [.., vol|off1 = 0x04000000, pan|off2 = 0xffff0000, ..]: the upper halves are the 16-bit vol and pan,
        // and 0xffff is -1 -- "the default pan", exactly as the mixer's kPanReset means it. The module split
        // the word with `>> 16` and no sign, so the host was handed 65535, which the pan table wraps to 15
        // degrees and then to 105: every music cue in the game played ~2.3 dB to the right, and no
        // measurement could see it because every one of them drove the mixer directly with a pan it chose.
        tc.Run("989snd: a stream play's 16-bit vol and pan halves are SIGNED on the wire -- 0xffff is -1, the default, not 65535", [](TestCase &t)
        {
            Snd989HarnessT<Snd989NotifyRecorderHost> h;
            t.IsTrue(h.configured, "the SOCOM II profile registers the 989snd service");
            constexpr uint32_t kInitVagStreaming = 0x2Au;
            constexpr uint32_t kPlayVagStreamByLoc = 0x2Cu;
            t.Equals(h.call(kInitVagStreaming, {2u, 0x8000u}), 1u, "two stream slots");

            // The mission's music play, byte for byte: vol 0x400 over offset 0, pan -1 over offset 0, group 1.
            t.IsTrue(h.call(kPlayVagStreamByLoc, {0x11e17du, 0u, 0x04000000u, 0xffff0000u, 1u, 0u, 0u, 0u}) != 0u, "the cue plays");
            const Snd989NotifyRecorderHost::Notify *n = h.host.last(kPlayVagStreamByLoc);
            t.IsTrue(n != nullptr && n->args.size() >= 10u, "the host was told, in the ten-word form");
            if (n != nullptr && n->args.size() >= 10u)
            {
                t.Equals(n->args[4], 0x400, "vol: the upper half of the third word");
                t.Equals(n->args[6], -1, "pan: 0xffff is MINUS ONE -- the default pan, not 65535 (the wire says " +
                                             std::to_string(n->args[6]) + ")");
            }

            // A pan the game does set, and a negative vol, both survive the split with their sign.
            t.IsTrue(h.call(kPlayVagStreamByLoc, {0x11e17du, 0u, 0xfffe0000u, 0x00b40000u, 2u, 0u, 0u, 0u}) != 0u, "another cue");
            n = h.host.last(kPlayVagStreamByLoc);
            if (n != nullptr && n->args.size() >= 10u)
            {
                t.Equals(n->args[4], -2, "vol 0xfffe is -2 (kVolDontChange's shape), not 65534");
                t.Equals(n->args[6], 180, "pan 0x00b4 is 180 degrees either way");
            }
        });

        // The same thing end to end: the module, the backend and the mixer. Queued, the two segments play one
        // after the other; replaced, only the second one's worth of audio ever comes out.
        tc.Run("989snd: a queued segment plays AFTER its parent, so the handle carries both segments' audio", [](TestCase &t)
        {
            const std::string path = tmpPath("ps2x_test_stream_queue_e2e.bin");
            t.IsTrue(writeOneChunkVpkImage(path), "the one-chunk VPK image is written");
            Snd989HarnessT<Snd989MixerHost> h;
            t.IsTrue(h.configured, "the SOCOM II profile registers the 989snd service");
            h.host.backend.setDiscImagePath(path);
            constexpr uint32_t kInitVagStreaming = 0x2Au;
            constexpr uint32_t kPlayVagStreamByLoc = 0x2Cu;
            t.Equals(h.call(kInitVagStreaming, {2u, 0x8000u}), 1u, "snd_InitVAGStreamingEx takes its two slots");

            const uint32_t first = h.call(kPlayVagStreamByLoc, {2u, 0u, 0x04000000u, 0u, 0u, 0u, 0u, 0u});
            t.IsTrue(first != 0u, "the parent plays");
            // Queued at once, before a frame is rendered: one chunk is 3584 samples at 32 kHz = 5376 frames out,
            // so a queue must yield about 10752 frames and a replacement only about 5376.
            t.Equals(h.call(kPlayVagStreamByLoc, {2u, 0u, 0x04000000u, 0u, 0u, first, 0u, 0u}), first, "one queued behind it");
            t.Equals(h.host.backend.mixerActiveStreams(), static_cast<size_t>(1u), "one stream plays; the queued one waits");

            std::vector<int16_t> buf(2 * 600);
            size_t frames = 0, silent = 0;
            bool playing = true;
            while (frames < 48000u)
            {
                h.host.backend.mixerPumpStreams();
                h.host.backend.mixerRender(buf.data(), 600);
                int32_t peak = 0;
                for (int16_t v : buf)
                    peak = std::max<int32_t>(peak, v < 0 ? -v : v);
                (void)h.host.backend.isPlaying(first, playing);
                if (!playing)
                    break;
                if (peak == 0)
                    ++silent;
                frames += 600;
            }
            t.IsTrue(frames >= 9000u, "both segments were heard, one after the other (" + std::to_string(frames) + " frames)");
            t.Equals(silent, static_cast<size_t>(0u), "with no silence where they meet");
            std::remove(path.c_str());
        });

        // Sprint 7 review finding F2: playVagStream reaped the ended streams BEFORE it looked the queued
        // stream's parent up, so a parent whose mixer stream had just finished was deactivated and findStream
        // missed it -- the queue silently took a fresh slot with an unrelated handle and the chain broke.
        tc.Run("989snd: a stream queued onto a just-ended parent still chains onto the parent's slot", [](TestCase &t)
        {
            const std::string path = tmpPath("ps2x_test_stream_queue.bin");
            if (!writeOneChunkVpkImage(path))
            {
                t.IsTrue(false, "could not write the test disc image");
                return;
            }

            Snd989HarnessT<Snd989MixerHost> h;
            t.IsTrue(h.configured, "the SOCOM II profile registers the 989snd service");
            h.host.backend.setDiscImagePath(path);

            constexpr uint32_t kInitVagStreaming = 0x2Au;
            constexpr uint32_t kPlayVagStreamByLoc = 0x2Cu;
            t.Equals(h.call(kInitVagStreaming, {2u, 0x8000u}), 1u, "snd_InitVAGStreamingEx takes its two slots");

            const uint32_t first = h.call(kPlayVagStreamByLoc, {2u, 0u, 0x04000000u, 0u, 0u, 0u, 0u, 0u});
            t.IsTrue(first != 0u, "the parent stream gets a slot");

            // A live parent's shape: the queued play reuses the parent's slot and so returns the parent's own
            // handle. Queue onto a parent the mixer has just finished and the answer must be the same.
            std::vector<int16_t> buf(2 * 4800);
            for (int i = 0; i < 3; ++i)
            {
                h.host.backend.mixerPumpStreams();
                h.host.backend.mixerRender(buf.data(), 4800);
            }
            bool playing = true;
            t.IsTrue(h.host.backend.isPlaying(first, playing) && !playing, "the mixer has finished the parent");

            const uint32_t queued = h.call(kPlayVagStreamByLoc, {2u, 0u, 0x04000000u, 0u, 0u, first, 0u, 0u});
            t.Equals(queued, first, "the queued stream chains onto the parent's slot, exactly as a live parent would");

            std::remove(path.c_str());
        });

        // Sprint 7 review finding F3: the backend answered "true, not playing" for ANY type-4/5 handle, so a
        // handle the mixer had never seen (the play never reached it) read as finished and the reaper freed the
        // slot under it. The answer is three-state now: no answer at all for a handle the mixer does not know.
        tc.Run("989snd: a handle the mixer never saw gets no answer, and its slot is not reaped", [](TestCase &t)
        {
            PS2AudioBackend backend;
            bool playing = true;
            t.IsTrue(!backend.isPlaying(0x04120001u, playing), "a stream handle the mixer never saw: no answer");
            playing = true;
            t.IsTrue(!backend.isPlaying(0x05120001u, playing), "a sound handle the mixer never saw: no answer either");

            Snd989HarnessT<Snd989UnseenStreamHost> h;
            t.IsTrue(h.configured, "the SOCOM II profile registers the 989snd service");

            constexpr uint32_t kInitVagStreaming = 0x2Au;
            constexpr uint32_t kPlayVagStreamByLoc = 0x2Cu;
            const std::vector<uint32_t> play = {2u, 0u, 0x04000000u, 0u, 0u, 0u, 0u, 0u};
            t.Equals(h.call(kInitVagStreaming, {2u, 0x8000u}), 1u, "snd_InitVAGStreamingEx takes its two slots");

            const uint32_t first = h.call(kPlayVagStreamByLoc, play);
            t.IsTrue(first != 0u, "the first stream gets a slot");
            const uint32_t second = h.call(kPlayVagStreamByLoc, play);   // this play runs the reaper
            t.IsTrue(second != 0u, "the second stream gets a slot too");
            t.IsTrue(((first >> 16) & 0xFFu) != ((second >> 16) & 0xFFu),
                     "the first slot was not reaped out from under a handle the mixer never answered for");
        });

        // Sprint 7 review finding F6: the PS2X_MIC_DUMP header was written with dataSize 0 and only patched
        // with the real sizes on a clean stop, so a run that was killed (which is how a capture usually ends)
        // left a WAV claiming zero bytes -- unplayable, although every byte was on disc.
        tc.Run("the mic dump's WAV header: an unfinished dump reads to EOF, a finished one carries its sizes", [](TestCase &t)
        {
            uint8_t header[44] = {};
            hostMicWavHeader(header, 0u, HostMic::kSampleRate);
            auto u32 = [&](size_t at) { uint32_t v; std::memcpy(&v, header + at, 4); return v; };
            t.Equals(std::memcmp(header, "RIFF", 4), 0, "still a RIFF header");
            t.Equals(std::memcmp(header + 36, "data", 4), 0, "with a data chunk");
            t.Equals(u32(4), 0xFFFFFFFFu, "size 0 = not known yet: the RIFF size says 'read to the end of the file'");
            t.Equals(u32(40), 0xFFFFFFFFu, "and so does the data size, so a killed run still plays");
            t.Equals(u32(24), HostMic::kSampleRate, "16 kHz");
            t.Equals(u32(28), HostMic::kSampleRate * 2u, "byte rate for 16-bit mono");

            hostMicWavHeader(header, 32000u, HostMic::kSampleRate);
            t.Equals(u32(4), 36u + 32000u, "a clean stop patches the real RIFF size back in");
            t.Equals(u32(40), 32000u, "and the real data size");
        });

        // Sprint 8 Goal 3 Task 1 Step 3: the reader half of the same 44-byte header, so PS2X_MIC_FAKE can put a
        // known WAV where a device would be. raudio.c:167 defines MA_NO_WAV, so there is no decoder in the
        // binary to lean on -- this is hand-written the way hostMicWavHeader is.
        tc.Run("micWavRead reads back what hostMicWavHeader wrote, patched sizes or not", [](TestCase &t)
        {
            const std::string path = tmpPath("socom2_mic_roundtrip.wav");
            std::vector<int16_t> written(4410);
            for (size_t i = 0; i < written.size(); ++i)
                written[i] = static_cast<int16_t>((i % 128) * 200 - 12800);
            {
                uint8_t header[44] = {};
                hostMicWavHeader(header, static_cast<uint32_t>(written.size() * 2u), 11025u);
                std::FILE *f = std::fopen(path.c_str(), "wb");
                t.IsTrue(f != nullptr, "the temp WAV opens for writing");
                if (f == nullptr)
                    return;
                std::fwrite(header, 1, 44, f);
                std::fwrite(written.data(), 2, written.size(), f);
                std::fclose(f);
            }
            std::vector<int16_t> read;
            MicFormat fmt{};
            std::string error;
            t.IsTrue(micWavRead(path, read, fmt, error), "a well-formed 16-bit mono WAV reads: " + error);
            t.Equals(fmt.rate, 11025u, "the rate comes out of the header, not out of a default");
            t.Equals(read.size(), written.size(), "every sample comes back");
            t.Equals(read[100], written[100], "and they are the same samples");

            // A killed run leaves 0xFFFFFFFF in both size fields (host_mic.h:94-98): read to end of file.
            {
                uint8_t header[44] = {};
                hostMicWavHeader(header, 0u, 11025u);
                std::FILE *f = std::fopen(path.c_str(), "r+b");
                t.IsTrue(f != nullptr, "the temp WAV reopens to unpatch its sizes");
                if (f != nullptr)
                {
                    std::fwrite(header, 1, 44, f);
                    std::fclose(f);
                }
            }
            std::vector<int16_t> unpatched;
            MicFormat unpatchedFmt{};
            std::string unpatchedError;
            t.IsTrue(micWavRead(path, unpatched, unpatchedFmt, unpatchedError),
                     "an unfinished dump still reads: " + unpatchedError);
            t.Equals(unpatched.size(), written.size(), "0xFFFFFFFF means 'to the end of the file', not zero bytes");

            std::vector<int16_t> nothing;
            MicFormat bad{};
            std::string reason;
            t.IsTrue(!micWavRead(path + ".missing", nothing, bad, reason), "a missing file is refused");
            t.IsTrue(!reason.empty(), "and it says why, because that string reaches the player on stderr");
        });

        // Sprint 8 review MUST FIX: micWavRead's data branch set `remaining` to the chunk size in BYTES and
        // then compared and decremented it in SAMPLES, so it read twice the data chunk and carried straight
        // on into whatever followed. A WAV with a trailing LIST chunk -- what every tagging tool writes --
        // therefore had its metadata decoded as audio.
        tc.Run("micWavRead stops at the end of the data chunk when a LIST chunk follows it", [](TestCase &t)
        {
            const std::string path = tmpPath("socom2_mic_trailing_list.wav");
            std::vector<int16_t> written(600);
            for (size_t i = 0; i < written.size(); ++i)
                written[i] = static_cast<int16_t>((i % 100) * 300 - 15000);
            const uint32_t dataBytes = static_cast<uint32_t>(written.size() * 2u);
            // 'LIST' + size + "INFO" + an INAM tag: plain ASCII, so reading it as audio is audible garbage.
            const std::string info = std::string("INFOINAM") + std::string("   ", 4) +
                                     "a stale second !";
            {
                uint8_t header[44] = {};
                hostMicWavHeader(header, dataBytes, 11025u);
                // RIFF size covers the LIST chunk too: 36 + data + (8 + info).
                const uint32_t riff = 36u + dataBytes + 8u + static_cast<uint32_t>(info.size());
                std::memcpy(header + 4, &riff, 4);
                std::FILE *f = std::fopen(path.c_str(), "wb");
                t.IsTrue(f != nullptr, "the trailing-LIST WAV opens for writing");
                if (f == nullptr)
                    return;
                std::fwrite(header, 1, 44, f);
                std::fwrite(written.data(), 2, written.size(), f);
                const uint32_t listSize = static_cast<uint32_t>(info.size());
                std::fwrite("LIST", 1, 4, f);
                std::fwrite(&listSize, 4, 1, f);
                std::fwrite(info.data(), 1, info.size(), f);
                std::fclose(f);
            }
            std::vector<int16_t> read;
            MicFormat fmt{};
            std::string error;
            t.IsTrue(micWavRead(path, read, fmt, error), "the file reads: " + error);
            t.Equals(read.size(), written.size(),
                     "exactly the data chunk's samples -- the LIST chunk is metadata, not audio");
            t.Equals(read.front(), written.front(), "the first sample is the first sample");
            t.Equals(read.back(), written.back(), "and the last is the data chunk's last");
            std::remove(path.c_str());
        });

        // Sprint 8 Goal 3 Task 1 Steps 4 and 6: PS2X_MIC_FAKE is a microphone that is a file, so CI, the Linux
        // VM and the driven harness all have a capture source with a KNOWN signal -- which is what lets the
        // game-read dump be correlated against it without a human speaking. And PS2X_MIC_DUMP must TEE off the
        // capture callback rather than drain the ring: host_mic.cpp:163-165 said the dump thread was the ring's
        // only consumer, which silently halves both files the moment the game starts reading too.
        tc.Run("PS2X_MIC_FAKE feeds the ring from a WAV, and the PS2X_MIC_DUMP tee does not steal its frames", [](TestCase &t)
        {
            const std::string path = tmpPath("socom2_mic_fake_source.wav");
            {
                std::vector<int16_t> written(11025);
                for (size_t i = 0; i < written.size(); ++i)
                    written[i] = static_cast<int16_t>((i % 128) * 200 - 12800);
                uint8_t header[44] = {};
                hostMicWavHeader(header, static_cast<uint32_t>(written.size() * 2u), 11025u);
                std::FILE *f = std::fopen(path.c_str(), "wb");
                t.IsTrue(f != nullptr, "the fake source WAV opens for writing");
                if (f == nullptr)
                    return;
                std::fwrite(header, 1, 44, f);
                std::fwrite(written.data(), 2, written.size(), f);
                std::fclose(f);
            }

            HostMic mic;
            t.IsTrue(mic.startFromFile(path), "a 11025 Hz mono WAV opens as a capture source: " + mic.error());
            t.IsTrue(mic.running(), "and running() is true exactly as it is for a device");
            mic.startDumpTee(tmpPath("socom2_mic_tee.wav"));
            std::this_thread::sleep_for(std::chrono::milliseconds(300));
            std::vector<int16_t> blockOut(4096);
            const size_t got = mic.read(blockOut.data(), blockOut.size());
            t.IsTrue(got > 1000u, "the game's read still gets the frames the dump also wrote");
            mic.stop();
            t.IsTrue(!mic.running(), "stop() joins the feeder");

            HostMic bad;
            t.IsTrue(!bad.startFromFile(path + ".missing"), "a missing WAV is refused, never fatal");
            t.IsTrue(!bad.error().empty(), "with a reason for the player's stderr");
        });

        // Sprint 8 Goal 3 Task 1 Step 7: the seam lgaud.cpp asks its two questions through. Nothing in the IOP
        // module reads the environment -- whether a microphone exists is a question it asks IopHost, exactly as
        // snd989.cpp asks audioIsPlaying rather than owning a mixer (snd989.cpp:1271). The OFF path is pinned
        // here, before the on path exists: with no override, a host answers "no device" and serves no frames,
        // which is what the gate (which exports no mic knob) must keep seeing.
        tc.Run("IopHost::micAvailable/micRead default to no microphone at all", [](TestCase &t)
        {
            Snd989TestHost host;
            ps2x::iop::IopHost &seam = host;
            t.IsTrue(!seam.micAvailable(), "a host that overrides nothing has no capture device");
            int16_t frames[64] = {};
            frames[0] = 0x4141;
            t.Equals(seam.micRead(frames, 64u), size_t{0}, "and serves no frames");
            t.Equals(static_cast<int>(frames[0]), 0x4141, "leaving the caller's buffer untouched");
        });

        // Sprint 8 Goal 3 Task 4 Step A: two instances of the game share one environment, so the three dump
        // knobs need a per-instance path without the harness having to learn about them. The runtime does the
        // one substitution: "{title}" becomes PS2X_WINDOW_TITLE (instance B runs with SOCOM-B; instance A
        // sets none, and is "A"), so one exported PS2X_MIC_GAMEREAD_DUMP serves both sides of a round.
        tc.Run("a dump path's {title} becomes the instance's window title, or A when it has none", [](TestCase &t)
        {
#ifdef _WIN32
            _putenv_s("PS2X_WINDOW_TITLE", "SOCOM-B");
#else
            setenv("PS2X_WINDOW_TITLE", "SOCOM-B", 1);
#endif
            t.Equals(hostMicDumpPath("logs/parity/r1/{title}_gameread.wav"),
                     std::string("logs/parity/r1/SOCOM-B_gameread.wav"), "B's dump carries B's title");
            t.Equals(hostMicDumpPath("{title}"), std::string("SOCOM-B"), "the token can be the whole path");
            t.Equals(hostMicDumpPath("logs/plain.wav"), std::string("logs/plain.wav"),
                     "a path without the token is untouched, byte for byte");
#ifdef _WIN32
            _putenv_s("PS2X_WINDOW_TITLE", "");
#else
            unsetenv("PS2X_WINDOW_TITLE");
#endif
            t.Equals(hostMicDumpPath("logs/parity/r1/{title}_gameread.wav"),
                     std::string("logs/parity/r1/A_gameread.wav"), "instance A sets no title and is 'A'");
        });

        // Sprint 8 Goal 3: PS2X_MIC_GAMEREAD_DUMP is the proof's second file -- every frame the IOP module's
        // Read (lgaud 0x08) was handed, recorded on the runtime side so the module stays environment-free
        // (Task 2's Interfaces: "the module hands the bytes it served to IopHost ... the knob stays on the
        // runtime side"). Correlating it against what PS2X_MIC_FAKE fed in is what proves the capture path
        // without a human speaking. Written at the rate lgAudOpen asked for -- the module hands over what it
        // SERVED, after the resample, so the file needs no rate argument at correlation time.
        tc.Run("PS2X_MIC_GAMEREAD_DUMP records exactly the frames the module was handed", [](TestCase &t)
        {
            const std::string path = tmpPath("socom2_mic_gameread.wav");
#ifdef _WIN32
            _putenv_s("PS2X_MIC_GAMEREAD_DUMP", path.c_str());
#else
            setenv("PS2X_MIC_GAMEREAD_DUMP", path.c_str(), 1);
#endif
            std::vector<int16_t> served(2048);
            for (size_t i = 0; i < served.size(); ++i)
                served[i] = static_cast<int16_t>((i % 97) * 300 - 14000);
            hostMicGameReadDump(served.data(), served.size(), 8000u);
            hostMicGameReadDump(served.data(), served.size(), 8000u);
            hostMicGameReadDumpClose();
#ifdef _WIN32
            _putenv_s("PS2X_MIC_GAMEREAD_DUMP", "");
#else
            unsetenv("PS2X_MIC_GAMEREAD_DUMP");
#endif
            std::vector<int16_t> back;
            MicFormat fmt{};
            std::string error;
            t.IsTrue(micWavRead(path, back, fmt, error), "the game-read dump is a readable WAV: " + error);
            t.Equals(fmt.rate, 8000u, "at the rate lgAudOpen asked for (the voice path's 8000, decomp :211849)");
            t.Equals(back.size(), served.size() * 2u, "every frame from both calls, appended in order");
            t.Equals(back[0], served[0], "and they are the frames that were handed over");
            t.Equals(back[served.size()], served[0], "including the second call's");

            // With the knob unset the dump is inert: no file, and nothing to slow the RPC path down.
            hostMicGameReadDump(served.data(), served.size(), 8000u);
            hostMicGameReadDumpClose();
        });

        // Sprint 7 Task 12b, the bank table: in the same run bank 0xa30000 was loaded and 66 lines later every play
        // on it was rejected with an EMPTY table ("0 entries, lastBank 0x00000000"). Nothing unloaded it: the game
        // called sceSifInitRpc a second time (the lgaud / mcserv init between the two), and the EE stub reset every
        // IOP service on every call, wiping the model. On the console sceSifInitRpc only sets up the EE's own RPC
        // packet queues -- the IOP keeps running and a bank stays loaded until snd_BankUnload / snd_UnloadBank.
        tc.Run("989snd: a loaded bank survives a second sceSifInitRpc (the console does not reset the IOP for it)", [](TestCase &t)
        {
            SndRuntimeEnv env;
            t.IsTrue(env.configured, "the SOCOM II profile registers the 989snd service");

            constexpr uint32_t kBankLoadByLoc = 0x03u;
            constexpr uint32_t kPlaySound = 0x11u;

            ps2_syscalls::SifInitRpc(env.rdram.data(), &env.ctx, &env.runtime);

            const uint32_t bank = env.call(kBankLoadByLoc, {2010461u, 0u});
            t.IsTrue(bank != 0u, "snd_BankLoadByLoc returns a bank handle");
            t.IsTrue(env.call(kPlaySound, {bank, 8u, 0x400u, 0xFFFFFFFFu, 0u, 0u}) != 0u, "and the bank plays");

            ps2_syscalls::SifInitRpc(env.rdram.data(), &env.ctx, &env.runtime);   // the game's second init

            t.IsTrue(env.call(kPlaySound, {bank, 8u, 0x400u, 0xFFFFFFFFu, 0u, 0u}) != 0u,
                     "the bank is still loaded afterwards: sceSifInitRpc is not a bank unload");
        });

        // Sprint 7 review finding F1: with sceSifInitRpc no longer resetting the IOP model, the reset had to
        // move to where the console puts it -- an actual IOP reboot. Both reboot stubs were empty, so after the
        // InitRpc fix NOTHING reset the model any more. (SOCOM II never calls either: 0 RebootIop and 0 ResetIop
        // in the owner's log and in the driven mission log, so this is correctness for a path the game skips.)
        tc.Run("989snd: sceSifRebootIop resets the IOP model, so a loaded bank does not survive it", [](TestCase &t)
        {
            SndRuntimeEnv env;
            t.IsTrue(env.configured, "the SOCOM II profile registers the 989snd service");

            constexpr uint32_t kBankLoadByLoc = 0x03u;
            constexpr uint32_t kPlaySound = 0x11u;

            ps2_syscalls::SifInitRpc(env.rdram.data(), &env.ctx, &env.runtime);
            const uint32_t bank = env.call(kBankLoadByLoc, {2010461u, 0u});
            t.IsTrue(bank != 0u, "snd_BankLoadByLoc returns a bank handle");
            t.IsTrue(env.call(kPlaySound, {bank, 8u, 0x400u, 0xFFFFFFFFu, 0u, 0u}) != 0u, "and the bank plays");

            ps2_stubs::sceSifRebootIop(env.rdram.data(), &env.ctx, &env.runtime);

            t.Equals(env.call(kPlaySound, {bank, 8u, 0x400u, 0xFFFFFFFFu, 0u, 0u}), 0u,
                     "the reboot reset the IOP model: the bank is gone and the play is rejected");
        });

        tc.Run("989snd: sceSifResetIop resets the IOP model too", [](TestCase &t)
        {
            SndRuntimeEnv env;
            t.IsTrue(env.configured, "the SOCOM II profile registers the 989snd service");

            constexpr uint32_t kBankLoadByLoc = 0x03u;
            constexpr uint32_t kPlaySound = 0x11u;

            ps2_syscalls::SifInitRpc(env.rdram.data(), &env.ctx, &env.runtime);
            const uint32_t bank = env.call(kBankLoadByLoc, {2010461u, 0u});
            t.IsTrue(bank != 0u, "snd_BankLoadByLoc returns a bank handle");

            ps2_stubs::sceSifResetIop(env.rdram.data(), &env.ctx, &env.runtime);

            t.Equals(env.call(kPlaySound, {bank, 8u, 0x400u, 0xFFFFFFFFu, 0u, 0u}), 0u,
                     "sceSifResetIop is a reboot as well: the bank table is empty afterwards");
        });

        // Sprint 11 milestone U, R245 (research/40 §9.3): two answers aligned with the disc's own 989SND.IRX, run on
        // PR #244's IOP emulator against our logged calls. The real IRX has no extension registered under the id
        // the game passes to snd_CallExtension (0x12c4e67a occurs in none of the disc's IRX files; 989DSTRM
        // registers as "dstr", HEADSETO registers nothing without a headset), so snd_DoExternCall reports
        // "cause 3" and answers 0 on every call; our model invented 1. And every handle the real IRX issues has
        // bit 31 set (0x84000002, 0x84000003, ...: snd_ActivateHandler's `OwnerID |= 0x80000000`, research/36
        // §"bit 31"), where ours were 0x0400003c-class. What the EE does with a handle's sign is a named unknown
        // for the gate: the console's handles are negative as int32 and the game plays, so at least nothing on
        // the EE may treat a negative handle as failure.
        tc.Run("989snd: snd_CallExtension answers 0 for every module id, as the real IRX does with nothing registered (R245)", [](TestCase &t)
        {
            Snd989Harness h;
            t.IsTrue(h.configured, "the SOCOM II profile registers the 989snd service");
            constexpr uint32_t kCallExtension = 0x4Cu;
            t.Equals(h.call(kCallExtension, {0x12C4E67Au, 6u, 0u, 0u, 0u, 0u, 0u}), 0u,
                     "the game's id, fn 6: the real IRX answers 0 (cause 3), not 1");
            t.Equals(h.call(kCallExtension, {0x12C4E67Au, 0u, 0u, 0u, 0u, 0u, 0u}), 0u, "fn 0 too");
            t.Equals(h.call(kCallExtension, {0x12C4E67Au, 1u, 0u, 0u, 0u, 0u, 0u}), 0u, "and fn 1");
            t.Equals(h.call(kCallExtension, {0x64737472u, 6u, 0u, 0u, 0u, 0u, 0u}), 0u,
                     "989DSTRM's own id (\"dstr\") is not modelled either: 0, not a crash");
        });

        tc.Run("989snd: every handle the model issues carries bit 31, as the real IRX's do (R245)", [](TestCase &t)
        {
            // A host that answers only for the handles the module told it to play (the shape of the played-out
            // case above): the model asks the host before it looks a handle up, so a host that says "playing" for
            // any word would answer for the bit-31-stripped word too, and the assertion below would test the host.
            struct KnownHandlesHost : Snd989TestHost
            {
                std::vector<uint32_t> known;
                void audioNotify(uint32_t function, const int32_t *args, size_t count) override
                {
                    if (function == 0x2Cu && count >= 1)
                        known.push_back(static_cast<uint32_t>(args[0]));
                }
                bool audioIsPlaying(uint32_t handle, bool &playing) const override
                {
                    if (std::find(known.begin(), known.end(), handle) == known.end())
                        return false;
                    playing = true;
                    return true;
                }
            };
            Snd989HarnessT<KnownHandlesHost> h;
            t.IsTrue(h.configured, "the SOCOM II profile registers the 989snd service");
            constexpr uint32_t kInitVagStreaming = 0x2Au;
            constexpr uint32_t kPlayVagStreamByLoc = 0x2Cu;
            constexpr uint32_t kIsStillPlaying = 0x19u;
            t.Equals(h.call(kInitVagStreaming, {2u, 0x8000u}), 1u, "two stream slots");
            const std::vector<uint32_t> play = {2000u, 0u, 0x04000000u, 0u, 1u, 0u, 0u, 0u};
            const uint32_t a = h.call(kPlayVagStreamByLoc, play);
            t.IsTrue(a != 0u, "stem A gets a handle");
            t.IsTrue((a & 0x80000000u) != 0u, "with bit 31 set, like the real IRX's 0x84000002");
            t.IsTrue(std::find(h.host.known.begin(), h.host.known.end(), a) != h.host.known.end(),
                     "and the host mixer was told that same word");
            t.Equals((a >> 24) & 0x1Fu, 4u, "type 4 in bits 24-28");
            t.Equals(h.call(kIsStillPlaying, {a}), a, "snd_SoundIsStillPlaying answers the same word, bit 31 included");
            const uint32_t b = h.call(kPlayVagStreamByLoc, play);
            t.IsTrue(b != 0u && b != a && (b & 0x80000000u) != 0u, "stem B: its own handle, bit 31 set as well");
            t.Equals(h.call(kIsStillPlaying, {a & 0x7FFFFFFFu}), 0u,
                     "the word without bit 31 is not a handle the model knows (the IRX compares the whole word)");
        });
    });
}
