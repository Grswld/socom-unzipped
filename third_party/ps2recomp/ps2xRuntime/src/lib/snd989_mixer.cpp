#include "runtime/snd989_mixer.h"

#include "runtime/ps2_vag.h"
#include "ps2x/knobs.h"

#include <algorithm>
#include <unordered_map>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <map>
#include <memory>
#include <thread>
#include <unordered_set>

// The 989snd bank-sound player as OpenGOAL's re-implementation of the public API describes it and the SBlk v3
// bytes on the disc confirm (research/32 sections 1, 3): a handler walks a sound's grain list at 240 ticks a
// second; each TONE grain keys on an SPU voice whose pitch comes from sceSdNote2Pitch, whose stereo volume comes
// from MakeVolume's pan table and the group's master volume, and whose envelope is the SPU's ADSR.
namespace snd989
{
    namespace
    {
        // The disc image is over 2 GB: fseek's long is 32 bits on Windows, so every seek goes through the 64-bit call.
        int seek64(FILE *fp, uint64_t offset)
        {
#ifdef _WIN32
            return _fseeki64(fp, static_cast<long long>(offset), SEEK_SET);
#else
            return fseeko(fp, static_cast<off_t>(offset), SEEK_SET);
#endif
        }

        // Every stream file the mixer closes goes through here, and the count is the test's handle on the
        // ownership: a file the mixer opened must be closed exactly once. A second fclose of the same FILE *
        // is a double free (glibc aborts on it; the Windows allocator stayed quiet), so the counter is what a
        // Windows test can see of it.
        std::atomic<uint64_t> g_streamFileCloses{0};

        void closeStreamFile(FILE *&fp)
        {
            if (fp)
            {
                std::fclose(fp);
                g_streamFileCloses.fetch_add(1u, std::memory_order_relaxed);
            }
            fp = nullptr;
        }
    }

    uint64_t Mixer::streamFileClosesForTest()
    {
        return g_streamFileCloses.load(std::memory_order_relaxed);
    }
}

namespace snd989
{
    namespace
    {
        // ---- note -> pitch ---------------------------------------------------------------------------------

        // 12 semitone ratios and 128 fine-step ratios, 0x8000 = 1.0 (sceSdNote2Pitch's NotePitchTable).
        const uint32_t *notePitchTable()
        {
            static uint32_t table[140];
            static bool built = false;
            if (!built)
            {
                for (int i = 0; i < 12; ++i)
                    table[i] = static_cast<uint32_t>(std::lround(32768.0 * std::pow(2.0, i / 12.0)));
                for (int i = 0; i < 128; ++i)
                    table[12 + i] = static_cast<uint32_t>(std::lround(32768.0 * std::pow(2.0, i / 1536.0)));
                built = true;
            }
            return table;
        }

        uint16_t sceSdNote2Pitch(uint16_t centerNote, uint16_t centerFine, uint16_t note, int16_t fine)
        {
            const uint32_t *table = notePitchTable();
            int32_t _fine = fine + static_cast<uint16_t>(centerFine);
            int32_t _fine2 = _fine;
            if (_fine < 0)
                _fine2 = _fine + 127;
            _fine2 = _fine2 / 128;
            const int32_t _note = note + _fine2 - centerNote;
            int32_t val3 = _note / 6;
            if (_note < 0)
                val3--;
            const int32_t offset2 = _fine - _fine2 * 128;
            int32_t val2 = _note < 0 ? -1 : 0;
            if (val3 < 0)
                val3--;
            val2 = (val3 / 2) - val2;
            int32_t val = val2 - 2;
            int32_t offset1 = _note - (val2 * 12);
            if ((offset1 < 0) || ((offset1 == 0) && (offset2 < 0)))
            {
                offset1 = offset1 + 12;
                val = val2 - 3;
            }
            int32_t off2 = offset2;
            if (off2 < 0)
            {
                offset1 = (offset1 - 1) + _fine2;
                off2 += (_fine2 + 1) * 128;
            }
            offset1 = std::clamp(offset1, 0, 11);
            off2 = std::clamp(off2, 0, 127);
            int64_t ret = (static_cast<int64_t>(table[offset1]) * table[off2 + 12]) / 0x10000;
            if (val < 0)
                ret = (ret + (1 << (-val - 1))) >> -val;
            else if (val > 0)
                ret = ret << val;
            return static_cast<uint16_t>(std::clamp<int64_t>(ret, 0, 0xFFFF));
        }

        // ---- pan ---------------------------------------------------------------------------------------------

        struct VolPair
        {
            int16_t left, right;
        };

        // The 181-entry quarter-wave pan table (0x3fff at full): left = cos, right = sin over 0..180 degrees.
        const VolPair *panTable()
        {
            static VolPair table[181];
            static bool built = false;
            if (!built)
            {
                for (int i = 0; i <= 180; ++i)
                {
                    const double a = (i / 180.0) * (3.14159265358979323846 / 2.0);
                    table[i].left = static_cast<int16_t>(std::lround(0x3fff * std::cos(a)));
                    table[i].right = static_cast<int16_t>(std::lround(0x3fff * std::sin(a)));
                }
                built = true;
            }
            return table;
        }

        // VoiceManager::MakeVolume(127, 0, playVol, playPan, toneVol, tonePan): stereo volumes 0..0x7FFE.
        VolPair makeVolume(int32_t vol1, int32_t pan1, int32_t vol2, int32_t pan2, int32_t vol3, int32_t pan3)
        {
            int32_t vol = vol1 * 258;
            vol = (vol * vol2) / 0x7f;
            vol = (vol * vol3) / 0x7f;
            if (vol <= 0)
                return {0, 0};
            int total = pan1 + pan3 + pan2;
            while (total >= 360)
                total -= 360;
            while (total < 0)
                total += 360;
            if (total >= 270)
                total -= 270;
            else
                total += 90;
            const VolPair *table = panTable();
            VolPair out{};
            if (total < 180)
            {
                out.left = static_cast<int16_t>((table[total].left * vol) / 0x3fff);
                out.right = static_cast<int16_t>((table[total].right * vol) / 0x3fff);
            }
            else
            {
                out.right = static_cast<int16_t>((table[total - 180].left * vol) / 0x3fff);
                out.left = static_cast<int16_t>((table[total - 180].right * vol) / 0x3fff);
            }
            return out;
        }

        // A VAG stream's MAIN voice volumes (research/36 item 7, 2026-09-20). On the IRX a two-channel VPK is not one
        // centre-panned stereo pair: the play worker (FUN_0000f7e0, 9912-9923) allocates a DOUBLING voice for the
        // handler unless flags bit 0x20 is set, the stream start (FUN_000152fc, 12743-12775) forces the first
        // stream's pan to 0x10e (270) when that voice exists, points the doubling voice at the second buffer (the
        // right channel), and gives it the main voice's volumes SWAPPED (VOLL <- VOLR, VOLR <- VOLL); every later
        // vol/pan update (FUN_00016898) repeats the swap. So with the game's pan -1 (= 0) the left channel's voice
        // sits at pan 270 -- the pan table's (0x3fff, 0), full on its side -- and the right channel at the mirror,
        // where ours put both at the centre entry (0.707, 0.707). Under the square law of the group stage that is
        // exactly 2x in amplitude: the -5.9 dB median of the music-only capture (run 9b) against PCSX2. The pair
        // rotates with the handler pan (270 + p for the left data, its mirror for the right). A mono stream keeps
        // the centre pair; what the IRX's doubling voice plays for a mono file is not established.
        VolPair streamBase(uint32_t channels, int32_t playVol, int32_t playPan)
        {
            return makeVolume(127, 0, playVol, channels > 1 ? playPan + 270 : playPan, 127, 0);
        }

        // ---- the SPU ADSR envelope (psx-spx) ---------------------------------------------------------------

        struct Envelope
        {
            enum Phase { Attack, Decay, Sustain, Release, Off };
            Phase phase = Off;
            int32_t level = 0;   // 0..0x7FFF
            uint16_t adsr1 = 0, adsr2 = 0;
            int32_t cycles = 0;  // samples until the next step

            void keyOn(uint16_t a1, uint16_t a2)
            {
                adsr1 = a1;
                adsr2 = a2;
                level = 0;
                phase = Attack;
                cycles = 0;
            }
            void keyOff()
            {
                if (phase != Off)
                    phase = Release;
                cycles = 0;
            }
            // One step of the phase's rate: returns the level step and the cycles it takes.
            void rate(int shift, int stepValue, bool exponential, bool decrease, int32_t &step, int32_t &cyc) const
            {
                cyc = 1 << std::max(0, shift - 11);
                step = stepValue * (1 << std::max(0, 11 - shift));   // a shift of a negative step is undefined; multiply
                if (exponential && !decrease && level > 0x6000)
                    cyc *= 4;
                if (exponential && decrease)
                    step = (step * level) / 0x8000;
            }
            // Advance by one sample; returns false once the voice is off.
            bool tick()
            {
                if (phase == Off)
                    return false;
                if (cycles > 0)
                {
                    --cycles;
                    return true;
                }
                int32_t step = 0, cyc = 1;
                switch (phase)
                {
                case Attack:
                {
                    const int shift = (adsr1 >> 10) & 0x1F;
                    const int stepValue = 7 - ((adsr1 >> 8) & 3);
                    rate(shift, stepValue, (adsr1 & 0x8000) != 0, false, step, cyc);
                    level += step;
                    if (level >= 0x7FFF)
                    {
                        level = 0x7FFF;
                        phase = Decay;
                    }
                    break;
                }
                case Decay:
                {
                    const int shift = (adsr1 >> 4) & 0x0F;
                    rate(shift, -8, true, true, step, cyc);
                    level += step;
                    const int32_t sustainLevel = ((adsr1 & 0x0F) + 1) * 0x800;
                    if (level <= sustainLevel)
                    {
                        level = std::max(level, 0);
                        phase = Sustain;
                    }
                    break;
                }
                case Sustain:
                {
                    const int shift = (adsr2 >> 8) & 0x1F;
                    const bool decrease = (adsr2 & 0x4000) != 0;
                    const int stepValue = decrease ? -(8 - ((adsr2 >> 6) & 3)) : 7 - ((adsr2 >> 6) & 3);
                    rate(shift, stepValue, (adsr2 & 0x8000) != 0, decrease, step, cyc);
                    level += step;
                    level = std::clamp(level, 0, 0x7FFF);
                    break;
                }
                case Release:
                {
                    const int shift = adsr2 & 0x1F;
                    rate(shift, -8, (adsr2 & 0x20) != 0, true, step, cyc);
                    level += step;
                    if (level <= 0)
                    {
                        level = 0;
                        phase = Off;
                    }
                    break;
                }
                default:
                    break;
                }
                cycles = std::max(0, cyc - 1);
                return phase != Off;
            }
        };

        // ---- data --------------------------------------------------------------------------------------------

        struct DecodedSample
        {
            std::vector<int16_t> pcm;
            bool loops = false;
            size_t loopStart = 0;
        };

        struct BankData
        {
            socom2_bank::Bank bank;
            std::vector<uint8_t> vag;
            std::map<uint32_t, DecodedSample> samples;   // by VAG offset

            const DecodedSample *sample(uint32_t offset)
            {
                auto it = samples.find(offset);
                if (it != samples.end())
                    return &it->second;
                if (offset >= vag.size())
                    return nullptr;
                ps2_vag::BlockRun run;
                if (!ps2_vag::decodeBlocks(vag.data() + offset, vag.size() - offset, run))
                    return nullptr;
                DecodedSample s;
                s.pcm = std::move(run.pcm);
                s.loops = run.loops;
                s.loopStart = run.loopStartSample;
                return &(samples[offset] = std::move(s));
            }
        };

        struct Voice
        {
            uint32_t handler = 0;
            uint32_t bank = 0;
            const DecodedSample *sample = nullptr;
            double pos = 0.0;
            double step = 1.0;
            socom2_bank::Tone tone;
            uint8_t group = 0;
            // The tone's volume and pan once the sentinels resolved: a negative Tone.Vol / Tone.Pan names a handler
            // register (-1..-4), a random value (-5) or a global register (-6..), the reference's TONE grain.
            int32_t gVol = 0;
            int32_t gPan = 0;
            VolPair base{};   // MakeVolume result before the group modifier
            Envelope env;
            bool paused = false;
        };

        // One playing sound: the grain sequencer the reference (open-goal/jak-project, game/sound/989snd) calls a
        // BlockSoundHandler. Sprint 9 Q0: a sound may be a CONDUCTOR whose grains start and stop CHILD sounds --
        // the mission ambience is one (bank M51_AM sound 0x31: START_CHILD_SOUND x9, STOP_CHILD_SOUND x9,
        // TEST_REGISTER on a global the game sets every frame, GOTO_MARKER, LOOP) and the audio parity check
        // measured its absence: a continuous bed on the console, silence on ours (2026-09-20). A child is a
        // Handler of its own with `parent` set; it plays on its own and keeps the parent alive (the reference's
        // Tick: a handler is done only when its grains, its voices AND its children are).
        struct Handler
        {
            uint32_t handle = 0;
            uint32_t bank = 0;
            uint32_t sound = 0;
            uint32_t parent = 0;         // the conductor's handle for a child sound; 0 for one the game played
            int32_t curVolume = 0;       // 0..127
            int32_t curPan = 0;
            int32_t curPb = 0;
            int32_t curPm = 0;
            int32_t appVolume = 0x400;   // the play call's vol (0..0x400), or a child's share of its parent's
            int32_t appPan = kPanReset;  // the play call's pan
            int32_t origVolume = 0;      // the sound's own Vol, or the child spec's vol
            uint8_t group = 0;
            int32_t countdown = 0;
            // Signed: a marker or loop jump lands one BEFORE its target and the ++ after the grain steps onto it.
            int32_t nextGrain = 0;
            bool done = false;
            bool paused = false;
            uint8_t note = 60, fine = 0;
            std::array<int8_t, 4> regs{};   // the handler's registers: SET/INC/DEC/ADD/COPY/TEST_REGISTER, sentinels -1..-4
            // RAND_PLAY / PLAY_CYCLE: play the next `grainsToPlay` grains, then skip `grainsToSkip`.
            bool skipGrains = false;
            int32_t grainsToPlay = 0;
            int32_t grainsToSkip = 0;
        };


        // One decoded chunk pair: the samples of channel 0 and, for a stereo stream, of channel 1.
        using ChunkPair = std::array<std::vector<int16_t>, 2>;

        // A VPK stream (research/32 section 5): interleaved 0x800-byte ADPCM chunks per channel, read from the disc
        // image as it plays and resampled from the file's rate to kSampleRate. Since the 2026-09-17 audit
        // (section 2.3) the seek, the read and the ADPCM decode all happen on pumpStreams()' thread under
        // Impl::ioMutex and land in `ready`; render() only pops a chunk pair that is already in memory.
        struct Stream
        {
            uint32_t handle = 0;

            // --- producer side: pumpStreams() only, under Impl::ioMutex ---
            FILE *file = nullptr;
            uint64_t dataStart = 0;      // file offset of the first chunk
            uint32_t dataSize = 0;       // bytes of chunk data
            uint32_t interleave = 0x800;
            uint32_t consumed = 0;       // chunk bytes read so far
            // Sprint 9 Goal 10 (R171): the VAG flags, as the bank decoder has always read them. Bit 2 marks the
            // block a repeat goes back to, bit 0 ends the run and bit 1 says the run repeats. A stream used to
            // end on bit 0 alone, so a looping cue -- the shape of the menu and lobby music -- stopped at its
            // first loop point and the game re-fired it. `loopStart` is a byte offset into the chunk data, on
            // the chunk-pair grid: the producer reads whole chunks, so a repeat resumes at the chunk that
            // carried the mark (its first block for mono, its left chunk for stereo).
            uint32_t loopStart = 0;
            // Issue #94: snd_PlayVAGStreamByLoc flag 4, the IRX's 0x400 "loop the file". Where the data ends --
            // its end block, or no whole block left -- the IRX's FUN_0001446c re-arms the stream at the top of the
            // data (bytes_remaining = bytes_total, the read offset back to the first data sector) instead of
            // deactivating the handler, so the stream never ends by itself. Written once by playStream.
            bool loopFile = false;
            std::vector<int16_t> s1, s2;             // per channel ADPCM history

            // Issue #94: back to the top of the data. The ADPCM history carries over: the IRX splices the top of
            // the file into the same SPU buffer behind the last block, clearing that block's end flag, and never
            // re-keys the voice (989SND.IRX around decomp line 12069-12132), so the decoder runs straight on.
            void rewindToTop()
            {
                consumed = 0;
            }

            // --- shared ---
            uint32_t rate = 32000;                   // written once by playStream, read-only after
            uint32_t channels = 1;                   // likewise
            std::atomic<bool> ended{false};          // the producer has read the last chunk
            std::atomic<bool> done{false};           // played out (or stopped): reaped
            std::deque<ChunkPair> ready;             // the decode-ahead ring, guarded by Impl::ringMutex

            // --- consumer side: render() only, under Impl::mutex ---
            // Sprint 9 Goal 10 (R169): the segment queued behind this one on the same handle (parentHandle), if
            // any. It is decoded ahead like any stream but plays no frame until this one's data runs out, and
            // then takes over on the very next output frame. A chain, so a score may queue several deep.
            std::shared_ptr<Stream> next;
            bool paused = false;
            bool underrunThisCall = false;           // Sprint 9 Q0: one Underrun event per render call
            uint64_t underrunFrames = 0;             // frames this stream has spent starved, in total
            uint8_t group = 0;
            VolPair base{};
            int32_t playVol = 127;   // Sprint 9 Q0: the 0..127 volume and the pan in force, so snd_SetSoundParams
            int32_t playPan = 0;     // can change one and keep the other, as it does for bank sounds
            // The play-time 7-bit volume, the IRX's Original_Vol (+0xc): the IRX's play (FUN_0000f7e0) writes
            // param_5 * 0x7f >> 10 into +0xc and +0x10 alike (research/36 lines 241-242), and an AutoVol target
            // scales it. The play is the only write to +0xc research/36 records, so setVolPan and the AutoVol steps
            // move playVol (+0x10) alone.
            int32_t origVol = 127;
            ChunkPair pcm;                           // per channel: the chunk pair being played
            double pos = 0.0;                        // sample position inside the current chunk
            double step = 1.0;                       // file rate / output rate

            ~Stream() { closeFile(); }
            void closeFile() { closeStreamFile(file); }

            // The producer's half of the old readChunkPair: reads and decodes the next chunk pair into `out`.
            // False at the end of the data, or with no file behind the stream. Never called from render().
            bool decodeChunkPair(ChunkPair &out)
            {
                if (ended.load(std::memory_order_relaxed) || !file)
                    return false;
                if (loopFile && consumed != 0u)
                {
                    // Issue #94: no whole block left for a channel is the end of the data; a looping file goes
                    // back to the top instead of ending (below, perChannel < 16 would end it).
                    const uint32_t left = dataSize > consumed ? dataSize - consumed : 0u;
                    const uint32_t leftPerChannel = channels > 1 ? (left / channels) & ~15u : left;
                    if (leftPerChannel < 16u)
                        rewindToTop();
                }
                const uint32_t chunkPairStart = consumed;
                const uint32_t remaining = dataSize > consumed ? dataSize - consumed : 0u;
                // research/36 item 10: `interleave` is the per-channel stride (a two-channel file: header word 3 /
                // channels, half a streaming buffer -- see playStream). One buffer holds that many bytes of the left
                // channel and then of the right; the last, partial buffer holds the same layout with rem/2 bytes in
                // each half (block-aligned) and padding after them.
                const size_t chunkBytes = static_cast<size_t>(interleave);
                const size_t perChannel = channels > 1
                                              ? std::min<size_t>(chunkBytes, (static_cast<size_t>(remaining) / channels) & ~static_cast<size_t>(15))
                                              : std::min<size_t>(chunkBytes, remaining);
                std::vector<uint8_t> raw(std::max<size_t>(perChannel, 16u));
                bool any = false;
                bool repeat = false;              // R171: this chunk pair ended a run that says it repeats
                bool wrapToTop = false;           // issue #94: it ended the data of a file played looping
                for (uint32_t ch = 0; ch < channels; ++ch)
                {
                    std::vector<int16_t> &pcmCh = out[ch];
                    pcmCh.clear();
                    if (perChannel < 16)
                    {
                        ended.store(true, std::memory_order_release);
                        continue;
                    }
                    // Each channel at its stride: the final, partial buffer keeps the left-then-right layout of the
                    // full ones -- rem/2 bytes a channel, the right at +interleave, not at +rem/2 (L/R correlation
                    // 0.483 over the disc's 188 cues with a partial buffer, against 0.001 for the +rem/2 read).
                    if (seek64(file, dataStart + chunkPairStart + static_cast<uint64_t>(ch) * chunkBytes) != 0)
                    {
                        ended.store(true, std::memory_order_release);
                        continue;
                    }
                    const size_t got = std::fread(raw.data(), 1, perChannel, file);
                    if (got < 16)
                    {
                        ended.store(true, std::memory_order_release);
                        continue;
                    }
                    any = true;
                    int16_t h1 = s1[ch], h2 = s2[ch];
                    for (size_t off = 0; off + 16 <= got; off += 16)
                    {
                        const uint8_t *block = raw.data() + off;
                        uint8_t shift = block[0] & 0x0F;
                        if (shift > 12)
                            shift = 9;
                        uint8_t filter = (block[0] >> 4) & 0x07;
                        if (filter > 4)
                            filter = 0;
                        for (int i = 0; i < 28; ++i)
                        {
                            const uint8_t byte = block[2 + i / 2];
                            const uint8_t nibble = (i & 1) ? (byte >> 4) : (byte & 0x0F);
                            const int8_t raw4 = static_cast<int8_t>((nibble & 8) ? (nibble | 0xF0) : nibble);
                            const int32_t shifted = raw4 << (12 - shift);
                            const int32_t old = h1, older = h2;
                            int32_t filtered;
                            switch (filter)
                            {
                            case 1: filtered = shifted + (60 * old + 32) / 64; break;
                            case 2: filtered = shifted + (115 * old - 52 * older + 32) / 64; break;
                            case 3: filtered = shifted + (98 * old - 55 * older + 32) / 64; break;
                            case 4: filtered = shifted + (122 * old - 60 * older + 32) / 64; break;
                            default: filtered = shifted; break;
                            }
                            const int16_t v = static_cast<int16_t>(std::clamp(filtered, -32768, 32767));
                            h2 = h1;
                            h1 = v;
                            pcmCh.push_back(v);
                        }
                        if (block[1] & 0x04)
                            loopStart = chunkPairStart;          // R171: a repeat comes back to this chunk
                        if (block[1] & 0x01)
                        {
                            // Bit 1 with it means the run repeats (ps2_audio_vag.cpp reads the same two bits for
                            // a bank sample). Only a run that does NOT repeat is the end of the stream.
                            if (block[1] & 0x02)
                                repeat = true;
                            else if (loopFile)
                                wrapToTop = true;         // issue #94: the IRX's 0x400 branch, not the end
                            else
                                ended.store(true, std::memory_order_release);
                            break;
                        }
                    }
                    s1[ch] = h1;
                    s2[ch] = h2;
                }
                consumed = chunkPairStart + static_cast<uint32_t>(static_cast<size_t>(channels) * perChannel);
                if (repeat && !ended.load(std::memory_order_relaxed))
                    consumed = loopStart;   // R171: back to the mark (0 = the top of the data) and keep playing
                else if (wrapToTop && !ended.load(std::memory_order_relaxed))
                    rewindToTop();          // issue #94: the whole file again, as FUN_0001446c re-arms it
                return any;
            }
        };

        constexpr double kTickHz = 240.0;
    }

    // PS2X_SND_MUTE_BANK (ruling R238): "0xa00000,0xb00000" plays nothing from those banks. It exists to
    // settle by ear, in one listen, whether a stray sound is a bank one-shot or the music stream -- the
    // question the owner's 2026-09-22 playthrough left open and that no log could answer. Parsed once.
    const std::vector<uint32_t> &mutedBanks()
    {
        static const std::vector<uint32_t> s_banks = []
        {
            std::vector<uint32_t> out;
            const char *spec = ps2x::knob("PS2X_SND_MUTE_BANK");
            if (spec == nullptr || *spec == '\0')
                return out;
            for (const char *p = spec; *p != '\0';)
            {
                while (*p == ',' || *p == ' ')
                    ++p;
                if (*p == '\0')
                    break;
                char *end = nullptr;
                const unsigned long long value = std::strtoull(p, &end, 0);
                if (end == p)
                    break;
                out.push_back(static_cast<uint32_t>(value));
                p = end;
            }
            return out;
        }();
        return s_banks;
    }

    bool bankMuted(uint32_t bank)
    {
        const std::vector<uint32_t> &banks = mutedBanks();
        return std::find(banks.begin(), banks.end(), bank) != banks.end();
    }

    uint16_t note2Pitch(int8_t centerNote, int8_t centerFine, int note, int fine)
    {
        bool ps1 = false;
        int center = centerNote;
        if (center >= 0)
            ps1 = true;
        else
            center = -center;
        uint16_t pitch = sceSdNote2Pitch(static_cast<uint16_t>(center), static_cast<uint16_t>(static_cast<uint8_t>(centerFine)),
                                         static_cast<uint16_t>(note), static_cast<int16_t>(fine));
        if (ps1)
            pitch = static_cast<uint16_t>(44100u * pitch / 48000u);
        return pitch;
    }

    struct Mixer::Impl
    {
        mutable std::mutex mutex;
        // Audit 2026-09-17 section 2.3: the disc lives behind `ioMutex`, never behind `mutex`. Lock order is
        // mutex -> ringMutex and mutex -> ioMutex; pumpStreams() takes `mutex` only to copy the stream list, drops
        // it, and reads with `ioMutex` held, so a slow read can never block render() or the game's position poll.
        mutable std::mutex ioMutex;
        mutable std::mutex ringMutex;
        std::unordered_map<uint32_t, BankData> banks;
        std::vector<Voice> voices;
        std::vector<Handler> handlers;
        // Sprint 9 Q0: the 32 global registers snd_SetGlobalReg(index 1..32, value) writes (the IRX keeps a byte
        // table; index 1 is its first entry). A grain names global N as register -N: TEST_REGISTER reg -2 reads
        // what the game set with index 2 -- the value the M51 ambience conductor branches on.
        std::array<int8_t, 32> globalRegs{};
        // Children a grain started while the handler list was being walked: appended after the walk (a push_back
        // under the range-for would move every Handler out from under its reference).
        std::vector<Handler> spawned;
        uint32_t nextChildUid = 1;
        // RAND_PLAY's "previous pick" and PLAY_CYCLE's index live in the grain itself in the reference, shared by
        // every handler of the sound; keyed by bank, sound and grain here.
        std::unordered_map<uint64_t, int16_t> grainState;
        // shared_ptr: pumpStreams() holds a reference to each stream while it reads, so reap() erasing one on the
        // render thread never closes a FILE * out from under a read in flight.
        std::vector<std::shared_ptr<Stream>> streams;
        // Every handle ever handed to playWithHandle / playStream, including one whose file would not open: the
        // mixer HAS an answer for those ("not playing"), and only for a handle that is not here does it have
        // none at all. Entries outlive the stream or handler they named -- dropDoneStreams() erases those.
        std::unordered_set<uint32_t> seenHandles;
        // The stream worker: started on the first playStream, joined in the destructor. PS2X_SND_STREAM_WORKER=0
        // leaves pumpStreams() to the caller (what the tests do).
        std::thread worker;
        std::mutex workerMutex;
        std::condition_variable workerCv;
        bool workerStop = false;
        bool workerStarted = false;
        const bool workerEnabled;
        // The PCM ring (research/32 section 7): 16-bit PCM the EE DMAs in, played from offset 0 at `rate`;
        // stereo is 512 bytes of left then 512 of right (the movie audio's SShd interleave 0x200; a first cut read the
        // capture as sample-interleaved and was wrong -- research/32 section 7).
        struct PcmRing
        {
            bool active = false;
            std::vector<uint8_t> bytes;
            uint32_t rate = 48000;
            uint32_t channels = 2;
            int32_t gain = 0;        // per-channel volume 0..0x3fff after the SPU's >> 1
            double pos = 0.0;        // frames into the ring
            // Sprint 7 Task 12 (ruling R97): the game fills the ring up to the position it polls, block by block, and
            // the ring used to play whatever bytes were there -- a fill that landed after the head had passed was
            // skipped until the next wrap (a splice) and a block never refilled looped (the owner's "persistent
            // buzz", 2026-09-18). A 256-frame block is `fresh` from the write that touches it until the head plays it;
            // the head entering a block that is not fresh plays silence for that block and counts an underrun.
            std::vector<uint8_t> fresh;      // one flag per 256-frame block
            uint32_t currentBlock = 0xffffffffu;
            bool silentBlock = false;
            uint64_t underruns = 0;
            // research/36 item 9 (2026-09-20), the instrument: a stale RUN is a stretch of output frames the head
            // spent in blocks the game had not rewritten (silence). One "[audio] 989snd pcm UNDERRUN" line per run,
            // stamped with the output frame it began on, printed when it ends (or when the ring stops).
            bool inStaleRun = false;
            uint64_t staleRunStart = 0;      // output frame the run began on
            uint64_t staleRunFrames = 0;     // output frames of silence in the run so far
            uint64_t starvationRuns = 0;     // runs completed (Mixer::pcmStarvationRuns)
            uint64_t bytesWritten = 0;       // bytes the game wrote since the last occupancy line
            uint32_t blockBytes() const { return 512u * std::max<uint32_t>(channels, 1u); }
            // (Re)allocate the ring and zero it. `channels` must already be set: it sets the block size.
            void reshape(uint32_t ringBytes)
            {
                bytes.assign(std::min<uint32_t>(ringBytes, 4u << 20), 0u);
                fresh.assign(bytes.empty() ? 0u : (bytes.size() + blockBytes() - 1u) / blockBytes(), 0u);
                rewind();
            }
            // The play head back to the top; the bytes the game wrote and their fresh flags survive.
            void rewind()
            {
                pos = 0.0;
                currentBlock = 0xffffffffu;
                silentBlock = false;
                underruns = 0;
                inStaleRun = false;
                staleRunFrames = 0;
                starvationRuns = 0;
                bytesWritten = 0;
            }
            uint32_t frames() const { return channels == 0 || bytes.empty() ? 0u : static_cast<uint32_t>(bytes.size() / (2u * channels)); }
            int16_t sample(uint32_t frame, uint32_t channel) const
            {
                size_t at;
                // 512-byte blocks, L then R (the SShd interleave 0x200 of the movie audio, research/32 section 7):
                // frame f sits in block pair f / 256 at sample f % 256.
                if (channels >= 2)
                    at = static_cast<size_t>(frame / 256u) * 1024u + channel * 512u + static_cast<size_t>(frame % 256u) * 2u;
                else
                    at = static_cast<size_t>(frame) * 2u;
                if (at + 1 >= bytes.size())
                    return 0;
                return static_cast<int16_t>(bytes[at] | (bytes[at + 1] << 8));
            }
        } pcm;
        // The position the game polls 30 times a second (research/32 section 7.1) is read off this, never off the
        // render mutex: a poll that blocked on a render blocked the EE inside a synchronous RPC.
        std::atomic<bool> pcmActive{false};
        std::atomic<uint32_t> pcmPositionBytes{0};
        std::atomic<uint64_t> pcmUnderrunCount{0};
        int32_t masterVol[17] = {};
        uint32_t nextUid = 1;
        uint32_t nextSlot = 0;
        double tickAccumulator = 0.0;

        Impl() : workerEnabled(streamWorkerEnabled())
        {
            for (int32_t &v : masterVol)
                v = 0x400;
        }

        static bool streamWorkerEnabled()
        {
            const char *env = ps2x::knob("PS2X_SND_STREAM_WORKER");
            return !(env && env[0] == '0');
        }

        // render()'s only contact with a stream's chunks: the ring, in memory.
        bool popChunk(Stream &st)
        {
            std::lock_guard<std::mutex> lock(ringMutex);
            if (st.ready.empty())
                return false;
            st.pcm = std::move(st.ready.front());
            st.ready.pop_front();
            return !st.pcm[0].empty();
        }

        void updatePcmPosition()
        {
            const uint32_t frames = pcm.frames();
            pcmPositionBytes.store(!pcm.active || frames == 0u
                                       ? 0u
                                       : (static_cast<uint32_t>(pcm.pos) % frames) * 2u * pcm.channels,
                                   std::memory_order_relaxed);
        }

        Handler *find(uint32_t handle)
        {
            for (Handler &h : handlers)
                if (h.handle == handle)
                    return &h;
            return nullptr;
        }

        // snd_AutoVol (fno 0x22): the game fades a music cue with a TIMED ramp -- [handle, 0, 0x168, 2] and
        // [handle, 0, 0x1e0, 2] in the owner's 2026-09-18 mission, 360 and 480 of the 240 Hz ticks, 1.5 s and 2 s.
        // Applying the target at once cut the cue dead ("skips and almost plays two different spliced segments").
        // Sprint 15 T1b (research/36 Q5 and item 4): a ramp moves the HANDLE's own 7-bit volume -- a stream's
        // playVol, a bank sound's curVolume, the IRX's Current_Vol -- in integer steps on the IRX's schedule, and
        // lands early (360 ticks from 127 is done at tick 254). It used to be a 0..1 multiplier interpolated in
        // doubles over `ticks`. A landed ramp is dropped; the volume it left is the handle's own from then on.
        struct VolRamp
        {
            uint32_t handle = 0;
            int32_t target = 0;                       // 7-bit, 0..127
            int32_t delta = 0;                        // fast: 32 * volchange / ticks; slow: +1 or -1; 0: a timer only
            uint32_t every = 0;                       // slow: one step each `every` ticks; 0 = fast (every tick)
            uint32_t countdown = 0;                   // ticks to the next slow step, or to a timer's end
            bool stopAtEnd = false;                   // the target -4: fade out, then stop
        };
        std::vector<VolRamp> volRamps;
        // Sprint 9 Q0: the output-frame clock and the event sink (see StreamEvent in the header).
        uint64_t renderedFrames = 0;
        std::function<void(const StreamEvent &)> eventSink;
        void emit(StreamEvent::Kind kind, uint32_t handle, uint64_t detail = 0)
        {
            StreamEvent e;
            e.kind = kind; e.handle = handle; e.frame = renderedFrames; e.detail = detail;
            static const char *const names[] = {"start", "done", "UNDERRUN"};
            std::fprintf(stderr, "[audio] 989snd stream %08x %s frame=%llu %s=%llu\n", handle, names[kind],
                         static_cast<unsigned long long>(e.frame), kind == StreamEvent::Underrun ? "silent" : "detail",
                         static_cast<unsigned long long>(detail));
            if (eventSink)
                eventSink(e);
        }

        // ---- the instrument (research/36 item 9) ----------------------------------------------------------
        void endPcmStaleRun()
        {
            if (!pcm.inStaleRun)
                return;
            pcm.inStaleRun = false;
            ++pcm.starvationRuns;
            std::fprintf(stderr, "[audio] 989snd pcm UNDERRUN frame=%llu silent=%llu\n",
                         static_cast<unsigned long long>(pcm.staleRunStart), static_cast<unsigned long long>(pcm.staleRunFrames));
        }

        // Output frames of decoded audio a stream holds ahead of its read head: the current chunk's remainder plus
        // every chunk pair waiting in its ring, converted from the file's rate.
        uint64_t streamFramesAhead(const Stream &st) const
        {
            double samples = st.pcm[0].empty() ? 0.0 : std::max(0.0, static_cast<double>(st.pcm[0].size()) - st.pos);
            {
                std::lock_guard<std::mutex> lock(ringMutex);
                for (const ChunkPair &c : st.ready)
                    samples += static_cast<double>(c[0].size());
            }
            return static_cast<uint64_t>(st.step > 0.0 ? samples / st.step : samples);
        }

        // Fresh (written, not yet played) blocks the PCM ring holds ahead of its head, contiguously.
        uint32_t pcmBlocksAhead() const
        {
            if (pcm.fresh.empty())
                return 0u;
            const uint32_t n = static_cast<uint32_t>(pcm.fresh.size());
            uint32_t b = pcm.currentBlock == 0xffffffffu ? 0u : (pcm.currentBlock + 1u) % n;
            uint32_t count = 0u;
            while (count < n && pcm.fresh[b] != 0u)
            {
                ++count;
                b = (b + 1u) % n;
            }
            return count;
        }

        void logOccupancy(uint64_t frame)
        {
            for (const auto &sp : streams)
            {
                const Stream &st = *sp;
                if (st.done.load(std::memory_order_relaxed))
                    continue;
                size_t chunks = 0;
                {
                    std::lock_guard<std::mutex> lock(ringMutex);
                    chunks = st.ready.size();
                }
                std::fprintf(stderr, "[audio] 989snd stream %08x occupancy frame=%llu ahead=%llu chunks=%zu%s%s\n", st.handle,
                             static_cast<unsigned long long>(frame), static_cast<unsigned long long>(streamFramesAhead(st)), chunks,
                             st.paused ? " paused" : "", st.ended.load(std::memory_order_relaxed) ? " ended" : "");
            }
            if (pcm.active && pcm.frames() > 0)
            {
                std::fprintf(stderr, "[audio] 989snd pcm occupancy frame=%llu ahead=%u blocks=%zu pos=%u written=%llu underruns=%llu\n",
                             static_cast<unsigned long long>(frame), pcmBlocksAhead(), pcm.fresh.size(),
                             static_cast<uint32_t>(pcm.pos) * 2u * pcm.channels, static_cast<unsigned long long>(pcm.bytesWritten),
                             static_cast<unsigned long long>(pcm.underruns));
                pcm.bytesWritten = 0;
            }
        }

        // The handle's 7-bit volume in force (the IRX's Current_Vol): a stream's playVol, a bank sound's
        // curVolume; -1 when nothing carries the handle.
        int32_t handleLevel7(uint32_t handle) const
        {
            for (const std::shared_ptr<Stream> &st : streams)
                if (st->handle == handle)
                    return st->playVol;
            for (const Handler &h : handlers)
                if (h.handle == handle)
                    return h.curVolume;
            return -1;
        }

        // The volume an AutoVol target scales (the IRX's Original_Vol): a stream's play-time 7-bit volume (origVol,
        // (127 * vol) >> 10 at the play), a bank sound's own Vol; 0 when nothing carries the handle (autoVol has
        // returned before it asks).
        int32_t handleOriginal7(uint32_t handle) const
        {
            for (const std::shared_ptr<Stream> &st : streams)
                if (st->handle == handle)
                    return st->origVol;
            for (const Handler &h : handlers)
                if (h.handle == handle)
                    return h.origVolume;
            return 0;
        }

        // Puts a 7-bit volume on the handle, the IRX's per-step snd_SetSoundVolPan(handle, -level, -2) with the pan
        // unchanged. A stream takes it as is (snd_FixVol: a negative is the absolute 7-bit value). A bank sound's
        // curVolume is written directly too: the target is already in the sound's own scale, and whether the SOCOM
        // IRX's block setter rescales the level by the sound's Vol is unread (research/68 row 2) -- the direct
        // write is the conservative model. appVolume is set to the smallest value that re-derives `level`, so a
        // later pan-only setVolPan keeps it. The handler's children are not touched, a departure from the IRX: v3.01's
        // snd_SetSFXVolPan (blocksnd.c:1232-1236) sets every child to App_Vol * Original_Vol / 127 on each step, while
        // ours leaves them alone until a later setVolPan pushes the stepped appVolume to them in one jump
        // (research/68 row 2).
        void setHandleLevel7(uint32_t handle, int32_t level)
        {
            if (Stream *st = findStream(handle))
            {
                st->playVol = level;
                st->base = streamBase(st->channels, st->playVol, st->playPan);
                return;
            }
            if (Handler *h = find(handle))
            {
                h->curVolume = level;
                if (h->origVolume > 0)
                    h->appVolume = (level * 1024 + h->origVolume - 1) / h->origVolume;
                updateHandlerVoices(*h);
            }
        }

        void clearRamp(uint32_t handle)
        {
            volRamps.erase(std::remove_if(volRamps.begin(), volRamps.end(),
                                          [handle](const VolRamp &r) { return r.handle == handle; }),
                           volRamps.end());
        }

        // Ends a sound or a stream by handle, the one place stop / a finished fade-out both go through.
        void stopHandle(uint32_t handle)
        {
            if (Stream *st = findStream(handle))
            {
                closeStream(*st);
                return;
            }
            if (Handler *h = find(handle))
            {
                h->done = true;
                keyOffHandler(handle);
            }
        }

        // Floor division by 32 for either sign (C++ `/` truncates toward zero).
        static int32_t floorDiv32(int32_t v)
        {
            return v >= 0 ? v / 32 : -((31 - v) / 32);
        }

        // The level a ramp moves the handle to from `level` (research/36 Q5): the slow branch one unit toward the
        // target; the fast branch floor(delta / 32) units, so a fall rounds down. Never past the target.
        static int32_t nextLevel(const VolRamp &r, int32_t level)
        {
            const int32_t moved = level + (r.every != 0 ? r.delta : floorDiv32(r.delta));
            return r.delta > 0 ? std::min(moved, r.target) : std::max(moved, r.target);
        }

        // One 240 Hz tick of every ramp. A fast ramp steps every tick; a slow one counts its countdown down and
        // steps when it reaches 0, then re-arms (armed at `every`, so the first step falls on tick `every`). The
        // step that lands on the target ends the ramp; a -4 ramp then stops the handle. A timer-only ramp (delta
        // 0, see autoVol) just counts down.
        void tickVolRamps()
        {
            for (size_t i = 0; i < volRamps.size();)
            {
                VolRamp &r = volRamps[i];
                bool ended = false;
                if (r.delta == 0)
                    ended = r.countdown == 0 || --r.countdown == 0;
                else if (r.every == 0 || --r.countdown == 0)
                {
                    const int32_t level = handleLevel7(r.handle);
                    if (level < 0)
                    {
                        volRamps.erase(volRamps.begin() + static_cast<std::ptrdiff_t>(i));   // nothing to fade
                        continue;
                    }
                    const int32_t next = nextLevel(r, level);
                    setHandleLevel7(r.handle, next);
                    ended = next == r.target;
                    r.countdown = r.every;
                }
                if (ended)
                {
                    const uint32_t handle = r.handle;
                    const bool stop = r.stopAtEnd;
                    volRamps.erase(volRamps.begin() + static_cast<std::ptrdiff_t>(i));
                    if (stop)
                        stopHandle(handle);   // the fade has reached silence: only now does the handle stop playing
                    continue;
                }
                ++i;
            }
        }

        // A ramp outlives nothing: once no stream, handler or voice carries the handle it is dropped, so a later
        // handle that reuses the number does not inherit a fade.
        void dropDeadRamps()
        {
            volRamps.erase(std::remove_if(volRamps.begin(), volRamps.end(), [this](const VolRamp &r) {
                               if (find(r.handle) != nullptr || findStream(r.handle) != nullptr)
                                   return false;
                               for (const Voice &v : voices)
                                   if (v.handler == r.handle)
                                       return false;
                               return true;
                           }),
                           volRamps.end());
        }

        int32_t groupModifier(uint8_t group) const
        {
            const int32_t g = std::min<int>(group, 15);
            return masterVol[g] * masterVol[16] / 0x400;   // both 0..0x400
        }

        // The group stage is a SQUARE law (research/36 Q6 item 1): snd_AdjustVolToGroup
        // (research/989snd-ziemas/iop/vol.c:434-455; IRX FUN_00019b7c) takes the 14-bit voice volume, multiplies
        // it by the group's master (x duck) / 0x400, and returns `v * v / 0x7ffe` -- the identity at full scale
        // (0x7ffe), a QUARTER at half amplitude. It sits under every voice (blocksnd.c:1267-1268) and every stream
        // (IRX FUN_00016898), so the MUSIC/SOUND sliders at 50 % are -12 dB on the console, a stem played at vol
        // 0x200 likewise, and a linear 7-bit fade is a quadratic loudness curve. `vol14` is 0..0x7ffe (makeVolume),
        // `modifier` 0..0x400 (group x master); the product's square fits an int32 (0x7ffe^2 < 2^30).
        static int32_t adjustVolToGroup(int32_t vol14, int32_t modifier)
        {
            const int32_t v = (std::min(vol14, 0x7ffe) * modifier) / 0x400;
            return (v * v) / 0x7ffe;
        }

        void applyVoiceVolume(Voice &v, int32_t &left, int32_t &right) const
        {
            // An AutoVol ramp moves the handler's own curVolume (tickVolRamps), which v.base already carries.
            const int32_t modifier = groupModifier(v.group);
            // The SPU voice takes (left >> 1, right >> 1): full volume is half of full scale (StartTone, research/32 section 3).
            left = adjustVolToGroup(v.base.left, modifier) >> 1;
            right = adjustVolToGroup(v.base.right, modifier) >> 1;
        }

        // A negative tone or child-spec volume / pan is a sentinel: -1..-4 a handler register, -5 random, -6.. a
        // global register (the reference's TONE and STARTCHILDSOUND grains; the child variant takes the magnitude).
        int32_t resolveVol(const Handler &h, int32_t vol, bool child) const
        {
            if (vol < 0)
            {
                if (vol >= -4)
                    vol = h.regs[static_cast<size_t>(-vol - 1)];
                else if (vol == -5)
                    vol = std::rand() % 0x7f;
                else
                    vol = globalReg(-vol - 6);
            }
            return child ? std::clamp(std::abs(vol), 0, 127) : std::max(vol, 0);
        }

        int32_t resolvePan(const Handler &h, int32_t pan, bool child) const
        {
            if (pan < 0)
            {
                int32_t reg = 0;
                if (pan >= -4)
                    reg = h.regs[static_cast<size_t>(-pan - 1)];
                else if (pan == -5)
                    return std::rand() % 360;
                else
                    reg = globalReg(-pan - 6);
                pan = 360 * (child ? std::min(std::abs(reg), 127) : reg) / 127;
            }
            while (pan >= 360)
                pan -= 360;
            while (pan < 0)
                pan += 360;
            return pan;
        }

        int32_t globalReg(int32_t index) const   // 0-based
        {
            return (index >= 0 && index < static_cast<int32_t>(globalRegs.size())) ? globalRegs[static_cast<size_t>(index)] : 0;
        }

        // A register by the grains' numbering: 0..3 the handler's, -1.. the globals (-N is global N-1).
        int32_t readReg(const Handler &h, int32_t reg) const
        {
            if (reg < 0)
                return globalReg(-reg - 1);
            return reg < 4 ? h.regs[static_cast<size_t>(reg)] : 0;
        }

        void writeReg(Handler &h, int32_t reg, int32_t value)
        {
            const int8_t v = static_cast<int8_t>(std::clamp(value, -128, 127));
            if (reg < 0)
            {
                const int32_t g = -reg - 1;
                if (g < static_cast<int32_t>(globalRegs.size()))
                    globalRegs[static_cast<size_t>(g)] = v;
            }
            else if (reg < 4)
                h.regs[static_cast<size_t>(reg)] = v;
        }

        void startTone(Handler &h, BankData &bd, const socom2_bank::Tone &tone)
        {
            const DecodedSample *sample = bd.sample(tone.sampleOffset);
            if (!sample || sample->pcm.empty())
                return;
            Voice v;
            v.handler = h.handle;
            v.bank = h.bank;
            v.sample = sample;
            v.tone = tone;
            v.group = h.group;
            // PitchBend(tone, pb, pm, note, fine) then PS1Note2Pitch
            int32_t v9 = (h.note << 7) + h.fine + h.curPm;
            int32_t v7;
            if (h.curPb >= 0)
                v7 = tone.pbHigh * (h.curPb << 7) / 0x7fff + v9;
            else
                v7 = tone.pbLow * (h.curPb << 7) / 0x8000 + v9;
            const int note = v7 / 128;
            const int fine = v7 % 128;
            const uint16_t pitch = note2Pitch(tone.centerNote, tone.centerFine, note, fine);
            v.step = pitch / 4096.0;
            v.gVol = resolveVol(h, tone.vol, false);
            v.gPan = resolvePan(h, tone.pan, false);
            v.base = makeVolume(127, 0, h.curVolume, h.curPan, v.gVol, v.gPan);
            v.env.keyOn(tone.adsr1, tone.adsr2);
            voices.push_back(v);
        }

        void keyOffHandler(uint32_t handle)
        {
            for (Voice &v : voices)
                if (v.handler == handle)
                    v.env.keyOff();
        }

        void updateHandlerVoices(const Handler &h)
        {
            for (Voice &v : voices)
                if (v.handler == h.handle)
                    v.base = makeVolume(127, 0, h.curVolume, h.curPan, v.gVol, v.gPan);
        }

        // The 32-byte PlaySoundParams a START_CHILD_SOUND / STOP_CHILD_SOUND / BRANCH grain indexes in the
        // parameter pool: {s32 vol, s32 pan, s8 regSettings[4], s32 soundId, char name[16]} (reference sfxgrain.h).
        struct ChildSpec
        {
            int32_t vol = 0, pan = 0, soundId = -1;
        };

        static bool childSpec(const BankData &bd, const socom2_bank::Grain &g, ChildSpec &out)
        {
            const std::vector<uint8_t> &pool = bd.bank.grainData;
            if (static_cast<size_t>(g.arg) + 16 > pool.size())
                return false;
            const uint8_t *p = pool.data() + g.arg;
            auto s32At = [p](size_t o) {
                return static_cast<int32_t>(static_cast<uint32_t>(p[o]) | (static_cast<uint32_t>(p[o + 1]) << 8) |
                                            (static_cast<uint32_t>(p[o + 2]) << 16) | (static_cast<uint32_t>(p[o + 3]) << 24));
            };
            out.vol = s32At(0);
            out.pan = s32At(4);
            out.soundId = s32At(12);
            return true;
        }

        // A control grain's operand: the three signed bytes of the 24-bit argument (the reference's ControlParams).
        static int32_t param8(const socom2_bank::Grain &g, int index)
        {
            return static_cast<int8_t>((g.arg >> (8 * index)) & 0xFFu);
        }

        int16_t &grainSlot(const Handler &h, int32_t grainIndex, int16_t initial)
        {
            const uint64_t key = (static_cast<uint64_t>(h.bank) << 32) | (static_cast<uint64_t>(h.sound & 0xFFFFu) << 16) |
                                 static_cast<uint64_t>(static_cast<uint32_t>(grainIndex) & 0xFFFFu);
            auto it = grainState.find(key);
            if (it == grainState.end())
                it = grainState.emplace(key, initial).first;
            return it->second;
        }

        // START_CHILD_SOUND: a handler of its own under a handle the IOP never issues (type 0xF), its volume the
        // spec's (not the child sound's own) scaled by the parent's app volume, as the reference's MakeHandler ->
        // BlockSoundHandler(sfx_vol = spec vol, params.vol = app * orig / 127) computes it.
        void startChild(Handler &h, BankData &bd, const ChildSpec &spec)
        {
            if (spec.soundId < 0 || static_cast<size_t>(spec.soundId) >= bd.bank.sounds.size())
                return;
            const socom2_bank::Sound &snd = bd.bank.sounds[static_cast<size_t>(spec.soundId)];
            if (snd.grains.empty())
                return;
            Handler c;
            c.handle = (0x0Fu << 24) | (nextChildUid++ & 0xFFFFFFu);
            c.bank = h.bank;
            c.sound = static_cast<uint32_t>(spec.soundId);
            c.parent = h.handle;
            c.group = static_cast<uint8_t>(snd.volGroup);
            c.origVolume = resolveVol(h, spec.vol, true);
            c.appVolume = h.appVolume * h.origVolume / 127;
            c.curVolume = std::clamp((c.origVolume * c.appVolume) >> 10, 0, 127);
            const int32_t pan = resolvePan(h, spec.pan, true);
            c.appPan = (h.appPan == kPanReset || h.appPan == kPanDontChange) ? pan : h.appPan;
            c.curPan = c.appPan;
            c.curPm = h.curPm;
            c.curPb = h.curPb;
            c.regs = h.regs;
            c.note = h.note;
            c.fine = h.fine;
            c.countdown = snd.grains[0].delay;
            spawned.push_back(c);
        }

        // The reference erases a stopped child: its destructor stops the voices dead (no release).
        void killHandler(Handler &c)
        {
            c.done = true;
            for (Voice &v : voices)
                if (v.handler == c.handle)
                    v.env.phase = Envelope::Off;
            stopChildren(c.handle, -1);
        }

        void stopChildren(uint32_t parentHandle, int32_t soundId)   // soundId -1: every child
        {
            for (Handler &c : handlers)
                if (c.parent == parentHandle && (soundId < 0 || c.sound == static_cast<uint32_t>(soundId)))
                    killHandler(c);
            for (Handler &c : spawned)
                if (c.parent == parentHandle && (soundId < 0 || c.sound == static_cast<uint32_t>(soundId)))
                    c.done = true;
        }

        // The game's stop (the reference's Stop): the handler is done, its children stop the same way, its voices release.
        void stopHandlerTree(uint32_t handle)
        {
            for (size_t i = 0; i < handlers.size(); ++i)
                if (handlers[i].parent == handle)
                    stopHandlerTree(handlers[i].handle);
            if (Handler *h = find(handle))
                h->done = true;
            keyOffHandler(handle);
        }

        void setHandlerPaused(uint32_t handle, bool paused)
        {
            for (Handler &c : handlers)
                if (c.parent == handle)
                    setHandlerPaused(c.handle, paused);
            if (Handler *h = find(handle))
                h->paused = paused;
            for (Voice &v : voices)
                if (v.handler == handle)
                    v.paused = paused;
        }

        // The reference's SetVolPan: the app volume (0..0x400, or a negative 0..127 scaled up) and pan land on
        // the handler, its voices re-derive theirs, and each child gets app * orig / 127 with the same pan.
        void setHandlerVolPan(Handler &h, int32_t vol, int32_t pan)
        {
            if (vol != kVolDontChange)
                h.appVolume = vol >= 0 ? vol : -1024 * vol / 127;
            if (pan == kPanReset)
            {
                auto bit = banks.find(h.bank);
                h.appPan = (bit != banks.end() && h.sound < bit->second.bank.sounds.size()) ? bit->second.bank.sounds[h.sound].pan : 0;
            }
            else if (pan != kPanDontChange)
                h.appPan = pan;
            const int32_t newVol = std::clamp((h.appVolume * h.origVolume) >> 10, 0, 127);
            int32_t newPan = h.appPan;
            while (newPan >= 360)
                newPan -= 360;
            while (newPan < 0)
                newPan += 360;
            if (newVol == h.curVolume && newPan == h.curPan)
                return;
            h.curVolume = newVol;
            h.curPan = newPan;
            const uint32_t handle = h.handle;
            const int32_t childVol = h.appVolume * h.origVolume / 127;
            for (size_t i = 0; i < handlers.size(); ++i)
                if (handlers[i].parent == handle)
                    setHandlerVolPan(handlers[i], childVol, pan);
            if (Handler *self = find(handle))
                updateHandlerVoices(*self);
        }

        void gotoMarker(Handler &h, const socom2_bank::Sound &snd, int32_t target)
        {
            for (size_t i = 0; i < snd.grains.size(); ++i)
                if (snd.grains[i].type == socom2_bank::kMarker && param8(snd.grains[i], 0) == target)
                {
                    h.nextGrain = static_cast<int32_t>(i) - 1;
                    return;
                }
        }

        // One grain, the reference's Grain::operator(): returns the ticks to add to the next grain's countdown.
        int32_t doGrain(Handler &h, BankData &bd, const socom2_bank::Sound &snd, const socom2_bank::Grain &g)
        {
            switch (g.type)
            {
            case socom2_bank::kTone:
            case socom2_bank::kTone2:
            {
                socom2_bank::Tone tone;
                if (bd.bank.tone(g, tone))
                    startTone(h, bd, tone);
                break;
            }
            case socom2_bank::kStartChild:
            {
                ChildSpec spec;
                if (childSpec(bd, g, spec))
                    startChild(h, bd, spec);
                break;
            }
            case socom2_bank::kStopChild:
            {
                ChildSpec spec;
                if (childSpec(bd, g, spec) && spec.soundId >= 0)
                    stopChildren(h.handle, spec.soundId);
                break;
            }
            case socom2_bank::kBranch:
            {
                // The handler carries on as another sound of the block: its voices go, the sequencer restarts.
                ChildSpec spec;
                if (!childSpec(bd, g, spec) || spec.soundId < 0 || static_cast<size_t>(spec.soundId) >= bd.bank.sounds.size() ||
                    bd.bank.sounds[static_cast<size_t>(spec.soundId)].grains.empty())
                    break;
                for (Voice &v : voices)
                    if (v.handler == h.handle)
                    {
                        v.env.keyOff();
                        v.base = VolPair{};
                    }
                const socom2_bank::Sound &ns = bd.bank.sounds[static_cast<size_t>(spec.soundId)];
                h.sound = static_cast<uint32_t>(spec.soundId);
                h.origVolume = ns.vol;
                h.curVolume = std::clamp((h.appVolume * ns.vol) >> 10, 0, 127);
                h.group = static_cast<uint8_t>(ns.volGroup);
                h.countdown = ns.grains[0].delay;
                h.nextGrain = -1;
                h.skipGrains = false;
                h.grainsToPlay = 0;
                h.grainsToSkip = 0;
                break;
            }
            case socom2_bank::kRandDelay:
                return std::rand() % (static_cast<int32_t>(g.arg & 0xFFFFFFu) + 1);   // the reference: Amount = arg + 1
            case socom2_bank::kRandPb:
            {
                const int32_t pb = param8(g, 0);
                const int32_t rnd = std::rand();
                h.curPb = pb * ((0xffff * (rnd % 0x7fff)) / 0x7fff - 0x8000) / 100;
                break;
            }
            case socom2_bank::kPb:
            {
                const int32_t pb = param8(g, 0);
                h.curPb = pb >= 0 ? 0x7fff * pb / 127 : -0x8000 * pb / -128;
                break;
            }
            case socom2_bank::kAddPb:
            {
                const int32_t pb = param8(g, 0);
                h.curPb = std::clamp(h.curPb + 0x7fff * pb / 127, -32768, 32767);
                break;
            }
            case socom2_bank::kLoopStart:
                break;
            case socom2_bank::kLoopEnd:
            {
                // Back onto LOOP_START itself (i - 1, then the ++): its delay counts every time round, which is how
                // the M51 conductor paces its register test (LOOP_START delay 120 = half a second).
                for (int32_t i = h.nextGrain - 1; i >= 0; --i)
                    if (snd.grains[static_cast<size_t>(i)].type == socom2_bank::kLoopStart)
                    {
                        h.nextGrain = i - 1;
                        break;
                    }
                break;
            }
            case socom2_bank::kLoopContinue:
            {
                for (int32_t i = h.nextGrain + 1; i < static_cast<int32_t>(snd.grains.size()); ++i)
                    if (snd.grains[static_cast<size_t>(i)].type == socom2_bank::kLoopEnd)
                    {
                        h.nextGrain = i;
                        break;
                    }
                break;
            }
            case socom2_bank::kStop:
                h.done = true;
                break;
            case socom2_bank::kRandPlay:
            {
                const int32_t options = param8(g, 0);
                const int32_t count = param8(g, 1);
                if (options <= 0)
                    break;
                int16_t &previous = grainSlot(h, h.nextGrain, static_cast<int16_t>(param8(g, 2)));
                int32_t rnd = std::rand() % options;
                if (rnd == previous && ++rnd >= options)
                    rnd = 0;
                previous = static_cast<int16_t>(rnd);
                h.nextGrain += rnd * count;
                h.grainsToPlay = count + 1;
                h.grainsToSkip = (options - 1 - rnd) * count;
                h.skipGrains = true;
                break;
            }
            case socom2_bank::kPlayCycle:
            {
                const int32_t groupSize = param8(g, 0);
                const int32_t groupCount = param8(g, 1);
                if (groupSize <= 0)
                    break;
                int16_t &index = grainSlot(h, h.nextGrain, static_cast<int16_t>(param8(g, 2)));
                const int32_t a = index;
                if (++index >= groupSize)
                    index = 0;
                h.nextGrain += groupCount * a;
                h.grainsToPlay = groupCount + 1;
                h.grainsToSkip = (groupSize - 1 - a) * groupCount;
                h.skipGrains = true;
                break;
            }
            case socom2_bank::kSetRegister:
                writeReg(h, param8(g, 0), param8(g, 1));
                break;
            case socom2_bank::kSetRegisterRand:
            {
                const int32_t lo = param8(g, 1), hi = param8(g, 2);
                const int32_t range = hi - lo + 1;
                if (range > 0)
                    writeReg(h, param8(g, 0), std::rand() % range + lo);
                break;
            }
            case socom2_bank::kIncRegister:
                writeReg(h, param8(g, 0), readReg(h, param8(g, 0)) + 1);
                break;
            case socom2_bank::kDecRegister:
                writeReg(h, param8(g, 0), readReg(h, param8(g, 0)) - 1);
                break;
            case socom2_bank::kAddRegister:
                writeReg(h, param8(g, 1), readReg(h, param8(g, 1)) + param8(g, 0));
                break;
            case socom2_bank::kCopyRegister:
                writeReg(h, param8(g, 1), readReg(h, param8(g, 0)));
                break;
            case socom2_bank::kTestRegister:
            {
                // Skips the grain after it when the test FAILS: action 0 "value < cmp", 1 "value == cmp", 2.. "value > cmp".
                const int32_t value = readReg(h, param8(g, 0));
                const int32_t action = param8(g, 1);
                const int32_t cmp = param8(g, 2);
                if (action == 0)
                {
                    if (value >= cmp)
                        ++h.nextGrain;
                }
                else if (action == 1)
                {
                    if (value != cmp)
                        ++h.nextGrain;
                }
                else if (cmp >= value)
                    ++h.nextGrain;
                break;
            }
            case socom2_bank::kMarker:
                break;
            case socom2_bank::kGotoMarker:
                gotoMarker(h, snd, param8(g, 0));
                break;
            case socom2_bank::kGotoRandomMarker:
            {
                const int32_t lo = param8(g, 0), hi = param8(g, 1);
                const int32_t range = hi - lo + 1;
                if (range > 0)
                    gotoMarker(h, snd, std::rand() % range + lo);
                break;
            }
            case socom2_bank::kWaitForAllVoices:
                for (const Voice &v : voices)
                    if (v.handler == h.handle && v.env.phase != Envelope::Off)
                    {
                        --h.nextGrain;   // the same grain again next tick
                        return 1;
                    }
                break;
            case socom2_bank::kOnStopMarker:
                h.nextGrain = static_cast<int32_t>(snd.grains.size()) - 1;
                break;
            case socom2_bank::kKeyOffVoices:
                keyOffHandler(h.handle);
                break;
            case socom2_bank::kKillVoices:
                for (Voice &v : voices)
                    if (v.handler == h.handle)
                        v.env.phase = Envelope::Off;
                break;
            default:
                break;   // LFO, XREF, plugins: not modelled (research/32 section 4)
            }
            return 0;
        }

        // The reference's DoGrain: one grain, the RAND_PLAY / PLAY_CYCLE skip bookkeeping, the step to the next
        // grain and its delay.
        void stepGrain(Handler &h)
        {
            auto bit = banks.find(h.bank);
            if (bit == banks.end() || h.sound >= bit->second.bank.sounds.size())
            {
                h.done = true;
                return;
            }
            BankData &bd = bit->second;
            const socom2_bank::Sound &snd = bd.bank.sounds[h.sound];
            if (h.nextGrain < 0 || h.nextGrain >= static_cast<int32_t>(snd.grains.size()))
            {
                h.done = true;
                return;
            }
            const socom2_bank::Grain g = snd.grains[static_cast<size_t>(h.nextGrain)];   // a copy: BRANCH re-points the sound
            const int32_t ret = doGrain(h, bd, snd, g);
            const socom2_bank::Sound &cur = bd.bank.sounds[h.sound];
            if (h.skipGrains && --h.grainsToPlay == 0)
            {
                h.nextGrain += h.grainsToSkip;
                h.skipGrains = false;
            }
            ++h.nextGrain;
            if (h.nextGrain >= static_cast<int32_t>(cur.grains.size()))
            {
                h.done = true;
                return;
            }
            if (h.nextGrain < 0)
                h.nextGrain = 0;
            h.countdown = cur.grains[static_cast<size_t>(h.nextGrain)].delay + ret;
        }

        void runGrains(Handler &h)
        {
            int guard = 0;
            while (h.countdown <= 0 && !h.done && guard++ < 256)
                stepGrain(h);
        }

        // Children started this pass join the handler list and run their first grains (which may start more).
        void flushSpawned()
        {
            int guard = 0;
            while (!spawned.empty() && guard++ < 64)
            {
                std::vector<Handler> batch;
                batch.swap(spawned);
                for (Handler &c : batch)
                {
                    if (c.done)
                        continue;   // stopped by its parent before it ever joined
                    handlers.push_back(c);
                    runGrains(handlers.back());
                }
            }
            spawned.clear();
        }

        void tick()
        {
            tickVolRamps();
            for (size_t i = 0; i < handlers.size(); ++i)
            {
                Handler &h = handlers[i];
                if (h.done || h.paused)
                    continue;
                --h.countdown;
                runGrains(h);
            }
            flushSpawned();
        }

        Stream *findStream(uint32_t handle)
        {
            for (const std::shared_ptr<Stream> &st : streams)
                if (st->handle == handle)
                    return st.get();
            return nullptr;
        }

        // Stopping a stream marks it; the FILE * is closed when the last reference to the Stream goes, so no
        // fclose ever waits behind a read in flight (and no close happens under the render mutex while it might).
        void closeStream(Stream &st)
        {
            // R169: the queued segments go with it. A stop means the handle is silent, not that the score
            // advances; the game restarts what it wants.
            for (std::shared_ptr<Stream> q = st.next; q; q = q->next)
                q->done.store(true, std::memory_order_relaxed);
            st.next.reset();
            // Sprint 9 Q0: a stream the GAME ended (stop, stop-all, a replace) reports Done too, marked so the
            // trace can tell it from one that ran out of data: detail 0xFFFFFFFF, not a silent-frame count.
            if (!st.done.load(std::memory_order_relaxed))
                emit(StreamEvent::Done, st.handle, 0xFFFFFFFFull);
            st.done.store(true, std::memory_order_relaxed);
        }

        // Drops the stopped streams: the last reference to a Stream closes its file. A read in flight holds its
        // own reference, so the close happens on the worker instead and never waits under the render mutex.
        void dropDoneStreams()
        {
            streams.erase(std::remove_if(streams.begin(), streams.end(),
                                         [](const std::shared_ptr<Stream> &st) { return st->done.load(std::memory_order_relaxed); }),
                          streams.end());
        }

        bool handlerAlive(const Handler &h) const
        {
            if (!h.done)
                return true;
            for (const Voice &v : voices)
                if (v.handler == h.handle && v.env.phase != Envelope::Off)
                    return true;
            // A conductor whose grains ran out is alive while a child of it plays (the reference's Tick).
            for (const Handler &c : handlers)
                if (c.parent == h.handle && c.handle != h.handle && handlerAlive(c))
                    return true;
            return false;
        }

        void reap()
        {
            voices.erase(std::remove_if(voices.begin(), voices.end(), [](const Voice &v) { return v.env.phase == Envelope::Off; }), voices.end());
            // Aliveness first, then the erase: handlerAlive() reads the children through `handlers`, which a
            // remove_if is rearranging under it.
            std::vector<uint8_t> alive(handlers.size(), 0u);
            for (size_t i = 0; i < handlers.size(); ++i)
                alive[i] = handlerAlive(handlers[i]) ? 1u : 0u;
            std::vector<Handler> kept;
            kept.reserve(handlers.size());
            for (size_t i = 0; i < handlers.size(); ++i)
                if (alive[i])
                    kept.push_back(std::move(handlers[i]));
            handlers.swap(kept);
            dropDoneStreams();
            dropDeadRamps();
        }
    };

    Mixer::Mixer() : m_impl(std::make_unique<Impl>()) {}
    Mixer::~Mixer()
    {
        if (m_impl->worker.joinable())
        {
            {
                std::lock_guard<std::mutex> lock(m_impl->workerMutex);
                m_impl->workerStop = true;
            }
            m_impl->workerCv.notify_all();
            m_impl->worker.join();
        }
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        for (const std::shared_ptr<Stream> &st : m_impl->streams)
            m_impl->closeStream(*st);
        m_impl->streams.clear();
    }

    bool Mixer::loadBank(uint32_t handle, const uint8_t *block, size_t blockBytes, const uint8_t *vag, size_t vagBytes)
    {
        BankData bd;
        if (!socom2_bank::parse(block, blockBytes, bd.bank))
            return false;
        bd.vag.assign(vag, vag + vagBytes);
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        {
            auto it = m_impl->banks.find(handle);
            if (it != m_impl->banks.end())
            {
                m_impl->voices.erase(std::remove_if(m_impl->voices.begin(), m_impl->voices.end(), [&](const Voice &v) { return v.bank == handle; }), m_impl->voices.end());
                m_impl->handlers.erase(std::remove_if(m_impl->handlers.begin(), m_impl->handlers.end(), [&](const Handler &h) { return h.bank == handle; }), m_impl->handlers.end());
                m_impl->banks.erase(it);
            }
        }
        m_impl->banks[handle] = std::move(bd);
        return true;
    }

    void Mixer::unloadBank(uint32_t handle)
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        m_impl->voices.erase(std::remove_if(m_impl->voices.begin(), m_impl->voices.end(), [&](const Voice &v) { return v.bank == handle; }), m_impl->voices.end());
        m_impl->handlers.erase(std::remove_if(m_impl->handlers.begin(), m_impl->handlers.end(), [&](const Handler &h) { return h.bank == handle; }), m_impl->handlers.end());
        m_impl->banks.erase(handle);
    }

    size_t Mixer::bankCount() const
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        return m_impl->banks.size();
    }

    uint32_t Mixer::play(uint32_t bank, uint32_t sound, int32_t vol, int32_t pan, int32_t pitchMod, int32_t pitchBend)
    {
        uint32_t handle;
        {
            std::lock_guard<std::mutex> lock(m_impl->mutex);
            uint32_t uid = m_impl->nextUid++ & 0xFFFFu;
            if (uid == 0u)
                uid = m_impl->nextUid++ & 0xFFFFu;
            const uint32_t slot = m_impl->nextSlot++ & 0xFFu;
            handle = (5u << 24) | (slot << 16) | uid;
        }
        return playWithHandle(handle, bank, sound, vol, pan, pitchMod, pitchBend) ? handle : 0u;
    }

    bool Mixer::playWithHandle(uint32_t handle, uint32_t bank, uint32_t sound, int32_t vol, int32_t pan, int32_t pitchMod, int32_t pitchBend)
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        // Seen from here on, refused or not: the mixer HAS an answer for a play it turned down ("not playing"),
        // and only a handle it was never handed at all leaves it with none (knowsHandle, review finding F3).
        if (handle != 0u)
            m_impl->seenHandles.insert(handle);
        if (bankMuted(bank))
        {
            // Counted and reported once per bank, so the A/B says in the log what it silenced: a run whose
            // log has no such line silenced nothing and is not an A/B.
            static std::unordered_set<uint32_t> s_said;
            if (s_said.insert(bank).second)
            {
                std::fprintf(stderr, "[audio] 989snd bank 0x%08x MUTED by PS2X_SND_MUTE_BANK\n", bank);
                std::fflush(stderr);
            }
            return false;
        }
        auto it = m_impl->banks.find(bank);
        if (it == m_impl->banks.end() || handle == 0u)
            return false;
        BankData &bd = it->second;
        if (sound >= bd.bank.sounds.size() || bd.bank.sounds[sound].grains.empty())
            return false;
        const socom2_bank::Sound &snd = bd.bank.sounds[sound];
        // A re-used handle (the module's slot came round) ends the earlier sound under it.
        for (Handler &old : m_impl->handlers)
            if (old.handle == handle)
            {
                old.done = true;
                m_impl->keyOffHandler(handle);
            }
        Handler h;
        h.handle = handle;
        h.bank = bank;
        h.sound = sound;
        h.group = static_cast<uint8_t>(snd.volGroup);
        int32_t playVol = (snd.vol * std::clamp(vol, 0, 0x400)) >> 10;
        if (playVol >= 128)
            playVol = 127;
        h.curVolume = std::max(0, playVol);
        h.curPan = (pan == kPanReset || pan == kPanDontChange) ? snd.pan : pan;
        h.curPm = pitchMod;
        h.curPb = pitchBend;
        h.appVolume = std::clamp(vol, 0, 0x400);
        h.appPan = pan;
        h.origVolume = snd.vol;
        h.countdown = snd.grains[0].delay;
        m_impl->handlers.push_back(h);
        m_impl->runGrains(m_impl->handlers.back());
        m_impl->flushSpawned();
        return true;
    }

    bool Mixer::knowsHandle(uint32_t handle) const
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        return m_impl->seenHandles.find(handle) != m_impl->seenHandles.end();
    }

    bool Mixer::isPlaying(uint32_t handle) const
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        for (const std::shared_ptr<Stream> &st : m_impl->streams)
            if (st->handle == handle)
                return !st->done.load(std::memory_order_relaxed);
        for (const Handler &h : m_impl->handlers)
            if (h.handle == handle)
                return m_impl->handlerAlive(h);
        return false;
    }

    void Mixer::stop(uint32_t handle)
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        m_impl->clearRamp(handle);   // an explicit stop ends any fade with it
        if (Stream *st = m_impl->findStream(handle))
        {
            m_impl->closeStream(*st);
            m_impl->dropDoneStreams();
            return;
        }
        if (m_impl->find(handle))
            m_impl->stopHandlerTree(handle);
    }

    void Mixer::pause(uint32_t handle)
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        if (Stream *st = m_impl->findStream(handle))
            st->paused = true;
        m_impl->setHandlerPaused(handle, true);
    }

    void Mixer::resume(uint32_t handle)
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        if (Stream *st = m_impl->findStream(handle))
            st->paused = false;
        m_impl->setHandlerPaused(handle, false);
    }

    void Mixer::setVolPan(uint32_t handle, int32_t vol, int32_t pan)
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        // An explicit volume cancels a fade in flight: the value the game just asked for is the one in force from
        // here (a pan-only call, vol = kVolDontChange, leaves the fade running). Not established by a reference --
        // the open 989snd reimplementation has no snd_AutoVol at all -- but it is the only reading under which the
        // game's own "set the volume" call means anything while a fade runs.
        if (vol != kVolDontChange)
            m_impl->clearRamp(handle);
        // Sprint 9 Q0: a STREAM handle. The game starts its positioned voice streams at vol 0 and raises them with
        // snd_SetSoundParams; this function found only bank handlers, so every such line stayed silent on ours
        // while the PCSX2 reference had voices. Same arithmetic as playStream, one value at a time.
        if (Stream *st = m_impl->findStream(handle))
        {
            if (vol != kVolDontChange)
                st->playVol = std::min(127, (127 * std::clamp(vol, 0, 0x400)) >> 10);
            if (pan == kPanReset)
                st->playPan = 0;
            else if (pan != kPanDontChange)
                st->playPan = pan;
            st->base = streamBase(st->channels, st->playVol, st->playPan);
            return;
        }
        Handler *h = m_impl->find(handle);
        if (!h)
            return;
        m_impl->setHandlerVolPan(*h, vol != kVolDontChange ? std::clamp(vol, 0, 0x400) : vol, pan);
    }

    // snd_SetGlobalReg(index 1..32, value): the byte the grains read as register -index.
    void Mixer::setGlobalReg(uint32_t index, int32_t value)
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        if (index >= 1u && index <= m_impl->globalRegs.size())
            m_impl->globalRegs[index - 1u] = static_cast<int8_t>(std::clamp(value, -128, 127));
    }

    int32_t Mixer::globalReg(uint32_t index) const
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        return (index >= 1u && index <= m_impl->globalRegs.size()) ? m_impl->globalRegs[index - 1u] : 0;
    }

    size_t Mixer::activeChildren(uint32_t handle) const
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        size_t n = 0;
        for (const Handler &c : m_impl->handlers)
            if (c.parent == handle && m_impl->handlerAlive(c))
                ++n;
        return n;
    }

    uint32_t Mixer::childSound(uint32_t handle, size_t index) const
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        size_t n = 0;
        for (const Handler &c : m_impl->handlers)
            if (c.parent == handle && m_impl->handlerAlive(c) && n++ == index)
                return c.sound;
        return 0xFFFFFFFFu;
    }

    // snd_AutoVol(handle, vol, ticks, how), fno 0x22. See the header: a ramp over `ticks` of the 240 Hz mixer
    // tick, not an instant set. `how` (2 in every call the game makes) is not acted on -- the open 989snd
    // reimplementation (open-goal/jak-project, game/sound/989snd) does not implement snd_AutoVol, so nothing we
    // can reach establishes its meaning; its 240 Hz tick, which this ramp is counted in, IS confirmed there
    // ("The handlers expect to tick at 240hz // 48000/240 = 200", player.cpp).
    void Mixer::autoVol(uint32_t handle, int32_t vol, int32_t ticks, int32_t how)
    {
        (void)how;
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        const int32_t current = m_impl->handleLevel7(handle);
        if (current < 0)
            return;   // nothing carries the handle: nothing to fade (the IRX returns for a handler no longer active)
        const bool fadeOutAndStop = (vol == -4);
        // The target is 7-bit and scales the handle's Original_Vol: (Original_Vol * vol) >> 10, capped 127.
        const int32_t target = fadeOutAndStop ? 0 : std::min(127, (m_impl->handleOriginal7(handle) * std::clamp(vol, 0, 0x400)) >> 10);
        m_impl->clearRamp(handle);   // a new call replaces a ramp in flight (`how` 2: the new timing, from here)
        if (ticks <= 0)
        {
            // No time to ramp over: the target at once.
            if (fadeOutAndStop)
            {
                m_impl->stopHandle(handle);
                m_impl->dropDoneStreams();
                return;
            }
            m_impl->setHandleLevel7(handle, target);
            return;
        }
        Impl::VolRamp r;
        r.handle = handle;
        r.target = target;
        r.stopAtEnd = fadeOutAndStop;
        // research/36 Q5, the schedule: volchange = target - current. |volchange| >= ticks is the fast branch,
        // delta = 32 * volchange / ticks (C division, toward zero), a step every tick; otherwise the slow branch,
        // one unit every floor(ticks / |volchange|) ticks. 360 ticks from 127 to 0: -1 every 2 ticks, landing at
        // tick 254; from 95 (a stream played at 0x300), -1 every 3, landing at 285.
        const int32_t volchange = target - current;
        if (volchange == 0)
        {
            // The IRX drops the effect here and the handle plays on. Ours keeps one deviation: a -4 still stops the
            // handle when its `ticks` run out (a timer ramp), so a fade-out of a handle already silent still ends it.
            if (!fadeOutAndStop)
                return;
            r.countdown = static_cast<uint32_t>(ticks);
        }
        else if (std::abs(volchange) >= ticks)
            r.delta = 32 * volchange / ticks;
        else
        {
            r.delta = volchange > 0 ? 1 : -1;
            r.every = static_cast<uint32_t>(ticks / std::abs(volchange));
            r.countdown = r.every;
        }
        m_impl->volRamps.push_back(r);
    }

    int32_t Mixer::autoVolLevelForTest(uint32_t handle) const
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        return m_impl->handleLevel7(handle);
    }

    void Mixer::setMasterVolume(uint32_t group, int32_t vol)
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        const int32_t v = std::clamp(vol, 0, 0x400);
        if (group == 16u)
            m_impl->masterVol[16] = v;
        else if (group < 16u)
            m_impl->masterVol[group] = v;
    }

    void Mixer::stopAll()
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        m_impl->volRamps.clear();
        for (Handler &h : m_impl->handlers)
            h.done = true;
        for (Voice &v : m_impl->voices)
            v.env.keyOff();
    }

    uint64_t Mixer::renderedFrames() const
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        return m_impl->renderedFrames;
    }

    void Mixer::setStreamEventSink(std::function<void(const StreamEvent &)> sink)
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        m_impl->eventSink = std::move(sink);
    }

    void Mixer::render(int16_t *interleaved, size_t frames)
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        std::memset(interleaved, 0, frames * 2 * sizeof(int16_t));
        std::vector<int32_t> mix(frames * 2, 0);
        const double framesPerTick = kSampleRate / kTickHz;
        size_t frame = 0;
        while (frame < frames)
        {
            // Frames until the next grain tick.
            const double untilTick = framesPerTick - m_impl->tickAccumulator;
            size_t chunk = static_cast<size_t>(std::max(1.0, std::ceil(untilTick)));
            chunk = std::min(chunk, frames - frame);
            for (Voice &v : m_impl->voices)
            {
                if (v.paused || v.env.phase == Envelope::Off || !v.sample)
                    continue;
                int32_t left = 0, right = 0;
                m_impl->applyVoiceVolume(v, left, right);
                const std::vector<int16_t> &pcm = v.sample->pcm;
                for (size_t i = 0; i < chunk; ++i)
                {
                    if (!v.env.tick())
                        break;
                    const size_t idx = static_cast<size_t>(v.pos);
                    if (idx >= pcm.size())
                    {
                        if (v.sample->loops && v.sample->loopStart < pcm.size())
                            v.pos = static_cast<double>(v.sample->loopStart) + (v.pos - static_cast<double>(pcm.size()));
                        else
                        {
                            v.env.phase = Envelope::Off;
                            break;
                        }
                    }
                    const size_t i0 = static_cast<size_t>(v.pos);
                    const size_t i1 = std::min(i0 + 1, pcm.size() - 1);
                    const double frac = v.pos - static_cast<double>(i0);
                    const double s = pcm[i0] * (1.0 - frac) + pcm[i1] * frac;
                    const double g = static_cast<double>(v.env.level) / 32767.0 / 0x7FFE;
                    mix[(frame + i) * 2] += static_cast<int32_t>(s * g * left);
                    mix[(frame + i) * 2 + 1] += static_cast<int32_t>(s * g * right);
                    v.pos += v.step;
                }
            }
            // R169: a stream may carry a queue (parentHandle), so the entry in `streams` can change inside this
            // loop -- by index and by pointer, never by a reference that cannot be rebound.
            for (size_t si = 0; si < m_impl->streams.size(); ++si)
            {
                Stream *cur = m_impl->streams[si].get();
                if (cur->paused || cur->done.load(std::memory_order_relaxed))
                    continue;
                cur->underrunThisCall = false;
                int32_t left = 0, right = 0;
                auto takeGains = [&]() {
                    const int32_t modifier = m_impl->groupModifier(cur->group);   // an AutoVol ramp moves playVol itself
                    // The square law of the group stage (adjustVolToGroup), then the SPU's half scale, as for the voices.
                    left = Impl::adjustVolToGroup(cur->base.left, modifier) >> 1;
                    right = Impl::adjustVolToGroup(cur->base.right, modifier) >> 1;
                };
                takeGains();
                for (size_t i = 0; i < chunk; ++i)
                {
                    bool haveSamples = true;
                    while (cur->pcm[0].empty() || cur->pos >= static_cast<double>(cur->pcm[0].size()))
                    {
                        const double carry = cur->pcm[0].empty() ? 0.0 : cur->pos - static_cast<double>(cur->pcm[0].size());
                        // Memory only (audit section 2.3): the next chunk pair comes off the ring the worker
                        // filled, never off the disc. An empty ring on a stream that has not ended yet is an
                        // underrun -- silence until the worker catches up, not the end of the stream.
                        if (m_impl->popChunk(*cur))
                        {
                            cur->pos = std::max(0.0, carry);
                            break;
                        }
                        if (!cur->ended.load(std::memory_order_acquire))
                        {
                            // Sprint 9 Q0: a starved stream said nothing before this. The frames left in this
                            // chunk play as silence; report them, once per render call per stream.
                            if (!cur->underrunThisCall)
                            {
                                cur->underrunThisCall = true;
                                const uint64_t silent = static_cast<uint64_t>(chunk - i);
                                cur->underrunFrames += silent;
                                m_impl->emit(StreamEvent::Underrun, cur->handle, silent);
                            }
                            haveSamples = false;
                            break;
                        }
                        cur->done.store(true, std::memory_order_relaxed);
                        m_impl->emit(StreamEvent::Done, cur->handle, cur->underrunFrames);
                        if (!cur->next)
                        {
                            haveSamples = false;
                            break;
                        }
                        // R169: the segment queued behind this one takes over on THIS output frame -- the frame
                        // after the parent's last sample, with no gap and no overlap. Sample-accurate: the seam
                        // falls wherever the data ends, not on a block boundary.
                        std::shared_ptr<Stream> nxt = cur->next;
                        // The other half of the proof: the handover itself, once per segment.
                        std::fprintf(stderr, "[audio] 989snd stream %08x seam: queued segment took over\n", cur->handle);
                        m_impl->clearRamp(cur->handle);   // R170: the fade ended the parent; it is not the next one's
                        nxt->pos = 0.0;
                        nxt->pcm[0].clear();
                        nxt->pcm[1].clear();
                        m_impl->streams[si] = nxt;
                        m_impl->emit(StreamEvent::Start, nxt->handle);
                        cur = nxt.get();
                        takeGains();
                    }
                    if (!haveSamples)
                        break;
                    const std::vector<int16_t> &l = cur->pcm[0];
                    const std::vector<int16_t> &r = cur->pcm[cur->channels > 1 ? 1 : 0];
                    const size_t i0 = static_cast<size_t>(cur->pos);
                    const size_t i1 = std::min(i0 + 1, l.size() - 1);
                    const double frac = cur->pos - static_cast<double>(i0);
                    const double sl = l[i0] * (1.0 - frac) + l[i1] * frac;
                    const double sr = (i0 < r.size() ? r[i0] : 0) * (1.0 - frac) + (i1 < r.size() ? r[i1] : 0) * frac;
                    if (cur->channels > 1)
                    {
                        // The IRX's voice pair (streamBase): the main voice plays the left data at (left, right), the
                        // doubling voice the right data at the SAME volumes swapped (FUN_000152fc, FUN_00016898).
                        mix[(frame + i) * 2] += static_cast<int32_t>((sl * left + sr * right) / 0x7FFE);
                        mix[(frame + i) * 2 + 1] += static_cast<int32_t>((sl * right + sr * left) / 0x7FFE);
                    }
                    else
                    {
                        mix[(frame + i) * 2] += static_cast<int32_t>(sl / 0x7FFE * left);
                        mix[(frame + i) * 2 + 1] += static_cast<int32_t>(sr / 0x7FFE * right);
                    }
                    cur->pos += cur->step;
                }
            }
            if (m_impl->pcm.active && m_impl->pcm.frames() > 0)
            {
                Impl::PcmRing &ring = m_impl->pcm;
                const int32_t gain = (ring.gain * m_impl->masterVol[16]) / 0x400;
                const double step = static_cast<double>(ring.rate) / static_cast<double>(kSampleRate);
                const uint32_t total = ring.frames();
                for (size_t i = 0; i < chunk; ++i)
                {
                    const uint32_t f = static_cast<uint32_t>(ring.pos) % total;
                    const uint32_t block = f / 256u;
                    if (block != ring.currentBlock)
                    {
                        // Entering a block: fresh plays and is consumed; stale (played once, not rewritten) is silence.
                        ring.currentBlock = block;
                        const bool isFresh = block < ring.fresh.size() && ring.fresh[block] != 0u;
                        ring.silentBlock = !isFresh;
                        if (isFresh)
                            ring.fresh[block] = 0u;
                        else
                            ++ring.underruns;
                    }
                    // The instrument (research/36 item 9): a stale run begins on the first silent frame and ends,
                    // with one UNDERRUN line, on the first fresh one (or at pcmStreamStop / pcmStreamClose).
                    if (ring.silentBlock)
                    {
                        if (!ring.inStaleRun)
                        {
                            ring.inStaleRun = true;
                            ring.staleRunStart = m_impl->renderedFrames + frame + i;
                            ring.staleRunFrames = 0;
                        }
                        ++ring.staleRunFrames;
                    }
                    else if (ring.inStaleRun)
                    {
                        m_impl->endPcmStaleRun();
                    }
                    if (!ring.silentBlock)
                    {
                        const int32_t l = ring.sample(f, 0);
                        const int32_t r = ring.channels >= 2 ? ring.sample(f, 1) : l;
                        mix[(frame + i) * 2] += (l * gain) / 0x7fff;   // the SPU voice volume is 15-bit: 0x3fff (the >> 1 of full) is half scale
                        mix[(frame + i) * 2 + 1] += (r * gain) / 0x7fff;
                    }
                    ring.pos += step;
                    if (ring.pos >= static_cast<double>(total))
                        ring.pos -= static_cast<double>(total);
                }
            }
            frame += chunk;
            m_impl->tickAccumulator += static_cast<double>(chunk);
            if (m_impl->tickAccumulator >= framesPerTick)
            {
                m_impl->tickAccumulator -= framesPerTick;
                m_impl->tick();
            }
        }
        for (size_t i = 0; i < frames * 2; ++i)
            interleaved[i] = static_cast<int16_t>(std::clamp<int32_t>(mix[i], -32768, 32767));
        m_impl->updatePcmPosition();
        m_impl->pcmUnderrunCount.store(m_impl->pcm.underruns, std::memory_order_relaxed);
        // The instrument (research/36 item 9): PS2X_AUDIO_INSTRUMENT=1 prints, every 4800 output frames (100 ms),
        // what each live stream holds decoded ahead of its read head and how many fresh blocks the PCM ring holds
        // ahead of its head -- on the same output-frame clock as the start/done/UNDERRUN events, so a dip in the
        // mix can be read against the buffer that fed it.
        static const bool s_instrument = ps2x::knob("PS2X_AUDIO_INSTRUMENT") != nullptr;
        constexpr uint64_t kOccupancyFrames = 4800u;
        if (s_instrument && (m_impl->renderedFrames / kOccupancyFrames) != ((m_impl->renderedFrames + frames) / kOccupancyFrames))
            m_impl->logOccupancy(m_impl->renderedFrames + frames);
        m_impl->renderedFrames += frames;   // Sprint 9 Q0: the output-frame clock the dump is written on
        m_impl->reap();
    }

    size_t Mixer::activeVoices() const
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        size_t n = 0;
        for (const Voice &v : m_impl->voices)
            if (v.env.phase != Envelope::Off)
                ++n;
        return n;
    }

    size_t Mixer::activeHandlers() const
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        size_t n = 0;
        for (const Handler &h : m_impl->handlers)
            if (m_impl->handlerAlive(h))
                ++n;
        return n;
    }
}

namespace snd989
{
    bool Mixer::playStream(uint32_t handle, const std::string &path, uint64_t byteOffset, int32_t vol, int32_t pan, uint8_t group,
                           bool queueBehind, bool loopFile)
    {
        (void)queueBehind;   // Sprint 9 Goal 10 (R169): honoured below once its RED test is watched failing
        FILE *fp = std::fopen(path.c_str(), "rb");
        if (!fp)
            return false;
        // Two file shapes on the disc (research/32 section 5): a VPK (magic stored as the little-endian word "VPK ",
        // so the bytes read " KPV"; data size, interleave, header size, rate, channels as little-endian words) for the
        // music, and a "VAGp" (48-byte big-endian header: data size at 0x0c, rate at 0x10; mono) for the voice-overs.
        uint8_t header[0x30] = {};
        if (seek64(fp, byteOffset) != 0 || std::fread(header, 1, sizeof(header), fp) != sizeof(header))
        {
            closeStreamFile(fp);
            return false;
        }
        auto u32 = [&](size_t at) { uint32_t v; std::memcpy(&v, header + at, 4); return v; };
        auto be32 = [&](size_t at) { return (static_cast<uint32_t>(header[at]) << 24) | (static_cast<uint32_t>(header[at + 1]) << 16) | (static_cast<uint32_t>(header[at + 2]) << 8) | header[at + 3]; };
        auto sp = std::make_shared<Stream>();
        Stream &st = *sp;
        st.handle = handle;
        {
            std::lock_guard<std::mutex> lock(m_impl->mutex);
            m_impl->seenHandles.insert(handle);   // seen, whatever the file turns out to be
        }
        if (std::memcmp(header, " KPV", 4) == 0)
        {
            st.dataSize = u32(4);
            st.rate = u32(16) ? u32(16) : 32000u;
            st.channels = std::clamp<uint32_t>(u32(20), 1u, 2u);
            // research/36 item 10 (2026-09-20): header word 3 is the streaming BUFFER the file was authored for
            // (0xb000 on every SOCOM stem; the IRX's FUN_00013334 refuses a file whose word 3 differs from its
            // stream buffer). A two-channel file is interleaved per buffer -- half of each buffer is the left
            // channel, then half the right (the IRX's per-channel stride is `puVar12[3] >> 1`) -- so the per-channel
            // stride is word 3 / channels.
            // Word 2 is the HEADER SIZE, and the data starts there (macOS port, 2026-10-02): all 210 VPKs on the disc
            // say 0x800, and from 0x800 each decodes as valid ADPCM throughout, the bytes up to word 3 included.
            // Starting at word 3 skipped 0xa800 bytes -- the first 1.12 s of every cue -- and made each buffer's
            // first sector the other channel's (the regular 1.2 s skips in the mission music).
            st.interleave = std::max<uint32_t>(16u, (u32(12) / st.channels) & ~15u);
            st.dataStart = byteOffset + u32(8);
        }
        else if (std::memcmp(header, "VAGp", 4) == 0)
        {
            st.dataSize = be32(12);
            st.interleave = 0x800;
            st.rate = be32(16) ? be32(16) : 44100u;
            st.channels = 1;
            st.dataStart = byteOffset + 48;
        }
        else
        {
            closeStreamFile(fp);
            return false;
        }
        // Only now does the Stream take the file: until the header is understood the open handle belongs to
        // this call alone, which closes it on the refusal. Handing it over at the fopen left both owners
        // closing it -- the refusal's fclose and then ~Stream's, a double free (ASan, Linux, 2026-09-18).
        st.file = fp;
        st.group = group;
        // Issue #94: before the pre-fill below, the first decode of the file. A file under one chunk per channel
        // plays once instead: looped, each pump yields a sliver and the ring starves (an underrun every render).
        st.loopFile = loopFile && st.dataSize >= st.interleave * st.channels;
        st.step = static_cast<double>(st.rate) / static_cast<double>(kSampleRate);
        st.s1.assign(st.channels, 0);
        st.s2.assign(st.channels, 0);
        const int32_t playVol = std::min(127, (127 * std::clamp(vol, 0, 0x400)) >> 10);
        const int32_t playPan = (pan == kPanReset || pan == kPanDontChange) ? 0 : pan;
        st.base = streamBase(st.channels, playVol, playPan);
        st.playVol = playVol;
        st.origVol = playVol;   // the IRX's Original_Vol, the play-time volume an AutoVol target scales
        st.playPan = playPan;
        // Sprint 9 Q0 (the owner's second listen): the worker fills the ring on its own 10 ms cadence, so the
        // first render after a push found it empty -- one device period of silence at the start of EVERY stream
        // (21 in the owner's run, 20 ms each). A stem on the heels of another opened with a hole; a voice line
        // started late. One chunk pair is decoded here, on the caller's thread, before the stream is pushed: the
        // header was just read from the same file, so this is one more 4 KB read, and the ring then has
        // ~112 ms in hand before the worker's first pass.
        {
            ChunkPair first;
            if (st.decodeChunkPair(first) && !first[0].empty())
                st.ready.push_back(std::move(first));
        }
        {
            std::lock_guard<std::mutex> lock(m_impl->mutex);
            Stream *old = m_impl->findStream(handle);
            if (old != nullptr && queueBehind && !old->done.load(std::memory_order_relaxed))
            {
                // R169: parentHandle means QUEUE. Append at the tail of the chain -- the playing segment is not
                // touched, and this one starts on the frame after its last. Replacing here is what cut every
                // mission cue dead mid-sample (the owner, 2026-09-19).
                Stream *tail = old;
                int depth = 1;
                while (tail->next)
                {
                    tail = tail->next.get();
                    ++depth;
                }
                tail->next = std::move(sp);
                // Goal 10's proof line: rare (once per cue change), so no rate limit. Its absence in a mission
                // log means the adaptive score never queued, not that the queue is broken.
                std::fprintf(stderr, "[audio] 989snd stream %08x QUEUED behind a live stream (depth %d)\n", handle, depth);
                startStreamWorker();
                return true;
            }
            if (old != nullptr)
            {
                // Goal 10: the line the M51 proof run greps for. A play that REPLACES a stream still in the air
                // is the old defect's signature -- during mission music it should never appear, because every
                // segment of an adaptive score arrives with a parentHandle and is queued instead.
                if (!old->done.load(std::memory_order_relaxed))
                    std::fprintf(stderr, "[audio] 989snd stream %08x REPLACED a live stream (not queued)\n", handle);
                m_impl->closeStream(*old);
                m_impl->dropDoneStreams();   // the handle is being reused: the old entry must not answer for it
            }
            // R170: a fade belongs to the cue it was asked for. stop() and setVolPan() already drop the handle's
            // ramp; this did not, so a cue started on a handle the game had just faded out began part way to
            // silence and kept fading -- the owner's "getting louder and quieter", with every cue measuring
            // perfect on its own. A queued segment is the exception: its parent is still playing and still owns
            // the fade, so that one is cleared at the seam instead (render()).
            m_impl->clearRamp(handle);
            m_impl->streams.push_back(std::move(sp));
            m_impl->emit(StreamEvent::Start, handle);   // Sprint 9 Q0: stamped with the frames rendered so far
        }
        startStreamWorker();
        return true;
    }

    // The worker: pumpStreams() every 10 ms from the first stream on, so the ring is refilled off the audio
    // callback. Started here rather than in the constructor because a Mixer that never streams needs no thread.
    void Mixer::startStreamWorker()
    {
        if (!m_impl->workerEnabled)
            return;
        std::lock_guard<std::mutex> lock(m_impl->workerMutex);
        if (m_impl->workerStarted)
            return;
        m_impl->workerStarted = true;
        Impl *impl = m_impl.get();
        m_impl->worker = std::thread([this, impl]()
        {
            std::unique_lock<std::mutex> lock(impl->workerMutex);
            while (!impl->workerStop)
            {
                lock.unlock();
                pumpStreams();
                lock.lock();
                impl->workerCv.wait_for(lock, std::chrono::milliseconds(10), [impl]() { return impl->workerStop; });
            }
        });
    }

    void Mixer::pumpStreams()
    {
        // The stream list is the render thread's; copy it (a reference each, so nothing is freed underneath) and
        // let go of the render mutex before touching the disc.
        std::vector<std::shared_ptr<Stream>> live;
        {
            std::lock_guard<std::mutex> lock(m_impl->mutex);
            live.reserve(m_impl->streams.size());
            for (const std::shared_ptr<Stream> &st : m_impl->streams)
                for (std::shared_ptr<Stream> q = st; q; q = q->next)   // R169: the queued segments decode ahead too
                    if (!q->done.load(std::memory_order_relaxed))
                        live.push_back(q);
        }
        for (const std::shared_ptr<Stream> &sp : live)
        {
            Stream &st = *sp;
            std::lock_guard<std::mutex> io(m_impl->ioMutex);
            while (!st.done.load(std::memory_order_relaxed) && !st.ended.load(std::memory_order_relaxed))
            {
                {
                    std::lock_guard<std::mutex> ring(m_impl->ringMutex);
                    if (st.ready.size() >= kStreamRingChunks)
                        break;
                }
                ChunkPair decoded;
                if (!st.decodeChunkPair(decoded) || decoded[0].empty())
                    break;   // the end of the data, or nothing behind the stream: `ended` says which
                std::lock_guard<std::mutex> ring(m_impl->ringMutex);
                st.ready.push_back(std::move(decoded));
            }
        }
    }

    void Mixer::closeStreamFilesForTest()
    {
        std::vector<std::shared_ptr<Stream>> live;
        {
            std::lock_guard<std::mutex> lock(m_impl->mutex);
            live = m_impl->streams;
        }
        std::lock_guard<std::mutex> io(m_impl->ioMutex);
        for (const std::shared_ptr<Stream> &st : live)
            st->closeFile();
    }

    void Mixer::stopAllStreams()
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        for (const std::shared_ptr<Stream> &st : m_impl->streams)
            m_impl->closeStream(*st);
        m_impl->dropDoneStreams();
    }

    size_t Mixer::activeStreams() const
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        size_t n = 0;
        for (const std::shared_ptr<Stream> &st : m_impl->streams)
            if (!st->done.load(std::memory_order_relaxed))
                ++n;
        return n;
    }
}

namespace snd989
{
    // snd_PcmStreamOpen: the EE gets a ring address back and DMAs its first whole fill in before it ever calls
    // Start (any run log: Open -> Stop -> the sceCdStRead fills -> Start). On the console that ring is IOP memory,
    // so the fill is what plays first; the mixer's ring has to exist from here for those writes to land.
    void Mixer::pcmStreamOpen(uint32_t ringBytes, uint32_t channels)
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        Impl::PcmRing &ring = m_impl->pcm;
        ring.channels = std::clamp<uint32_t>(channels ? channels : 2u, 1u, 2u);
        ring.reshape(ringBytes);
        ring.active = false;
        m_impl->pcmActive.store(false, std::memory_order_relaxed);
        m_impl->pcmPositionBytes.store(0u, std::memory_order_relaxed);
        m_impl->pcmUnderrunCount.store(0u, std::memory_order_relaxed);
    }

    // snd_PcmStreamClose: the ring is gone. A write before the next Open has nowhere to land, as on the console.
    void Mixer::pcmStreamClose()
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        Impl::PcmRing &ring = m_impl->pcm;
        ring.bytes.clear();
        ring.bytes.shrink_to_fit();
        ring.fresh.clear();
        ring.rewind();
        ring.active = false;
        m_impl->pcmActive.store(false, std::memory_order_relaxed);
        m_impl->pcmPositionBytes.store(0u, std::memory_order_relaxed);
        m_impl->pcmUnderrunCount.store(0u, std::memory_order_relaxed);
    }

    void Mixer::pcmStreamStart(uint32_t ringBytes, uint32_t rate, uint32_t channels, int32_t vol)
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        Impl::PcmRing &ring = m_impl->pcm;
        const uint32_t ch = std::clamp<uint32_t>(channels ? channels : 2u, 1u, 2u);
        // Start's size confirms the Open's (0 means "the one you were opened with").
        const uint32_t want = ringBytes ? std::min<uint32_t>(ringBytes, 4u << 20) : static_cast<uint32_t>(ring.bytes.size());
        const bool reshape = ring.bytes.size() != static_cast<size_t>(want) || ring.channels != ch;
        ring.channels = ch;
        ring.rate = rate ? rate : 48000u;
        // vol 0..0x400 -> 0..0x7ffe (MakeVolume's scale) then the SPU's >> 1: 0..0x3fff
        ring.gain = static_cast<int32_t>((static_cast<int64_t>(0x7ffe) * std::clamp(vol, 0, 0x400)) / 0x400) >> 1;
        if (reshape)
            ring.reshape(want);   // a ring of a shape this one was not opened with: allocate, and only then zero
        else
            ring.rewind();        // the Open-to-Start fill and its fresh flags stay; only the play head restarts
        ring.active = !ring.bytes.empty();
        m_impl->pcmActive.store(ring.active, std::memory_order_relaxed);
        m_impl->pcmPositionBytes.store(0u, std::memory_order_relaxed);
        m_impl->pcmUnderrunCount.store(0u, std::memory_order_relaxed);
    }

    void Mixer::pcmStreamWrite(uint32_t offset, const uint8_t *data, size_t bytes)
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        Impl::PcmRing &ring = m_impl->pcm;
        if (!data || ring.bytes.empty() || offset >= ring.bytes.size())
            return;
        const size_t n = std::min(bytes, ring.bytes.size() - offset);
        std::memcpy(ring.bytes.data() + offset, data, n);
        ring.bytesWritten += n;   // the instrument's feed counter (research/36 item 9)
        // Every block the write touches is fresh again (a partial write counts: the game writes whole blocks).
        if (n > 0 && !ring.fresh.empty())
        {
            const size_t first = offset / ring.blockBytes();
            const size_t last = std::min(ring.fresh.size() - 1u, (offset + n - 1u) / ring.blockBytes());
            for (size_t b = first; b <= last; ++b)
                ring.fresh[b] = 1u;
        }
    }

    uint64_t Mixer::pcmUnderruns() const
    {
        return m_impl->pcmUnderrunCount.load(std::memory_order_relaxed);
    }

    uint64_t Mixer::pcmStarvationRuns() const
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        return m_impl->pcm.starvationRuns;
    }

    uint64_t Mixer::streamFramesAhead(uint32_t handle) const
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        const Stream *st = m_impl->findStream(handle);
        return st ? m_impl->streamFramesAhead(*st) : 0u;
    }

    // The game's audio thread polls this 30 times a second through a synchronous RPC (research/32 section 7.1):
    // it reads the value render() published, and never waits on the render mutex.
    uint32_t Mixer::pcmStreamPosition() const
    {
        return m_impl->pcmPositionBytes.load(std::memory_order_relaxed);
    }

    void Mixer::pcmStreamStop()
    {
        std::lock_guard<std::mutex> lock(m_impl->mutex);
        m_impl->pcm.active = false;
        m_impl->pcm.pos = 0.0;
        m_impl->pcm.underruns = 0;
        m_impl->pcm.currentBlock = 0xffffffffu;
        m_impl->pcmActive.store(false, std::memory_order_relaxed);
        m_impl->pcmPositionBytes.store(0u, std::memory_order_relaxed);
        m_impl->pcmUnderrunCount.store(0u, std::memory_order_relaxed);
    }

    bool Mixer::pcmStreamActive() const
    {
        return m_impl->pcmActive.load(std::memory_order_relaxed);
    }
}
