#pragma once
// A host 989snd: bank sounds as the IRX plays them (research/32 sections 3-4), mixed to 48 kHz stereo.
// The IOP module (ps2xIOP snd989.cpp) owns the RPC protocol and forwards the play family here through
// PS2AudioBackend; this class is plain C++ so the tests can run it without an audio device.
#include "runtime/socom2_bank.h"

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace snd989
{
    constexpr uint32_t kSampleRate = 48000;     // SPU2: pitch 0x1000 plays one sample per output frame
    // How far ahead pumpStreams() decodes each stream (audit 2026-09-17 section 2.3): four 0x800-byte chunk pairs
    // is 4 x 112 ms of a 32 kHz VPK, so a worker tick that loses a second of wall time to a slow disc still has
    // audio in hand, and the worst case a stream holds is 4 x 2 x 3584 samples (56 KB) of decoded PCM.
    constexpr size_t kStreamRingChunks = 4;
    constexpr int32_t kVolDontChange = 0x7FFFFFFF;
    constexpr int32_t kPanDontChange = -2;
    constexpr int32_t kPanReset = -1;

    // sceSdNote2Pitch / PS1Note2Pitch (research/32 section 3): the SPU pitch (0x1000 = unity at 48 kHz) of
    // `note`/`fine` against a tone's center note; a non-negative center note is a PS1 (44.1 kHz) sample.
    uint16_t note2Pitch(int8_t centerNote, int8_t centerFine, int note, int fine);

    // Sprint 9 Q0 (2026-09-20): a stream's life on the mixer's OUTPUT-FRAME clock -- the clock PS2X_AUDIO_DUMP's
    // WAV is written on, so `frame` is a WAV offset. The mission's music is ~4 s stems the game chains by polling
    // snd_SoundIsStillPlaying, and nothing had ever stamped where one ended and the next began, nor counted a
    // stream that starved (an empty ring played silence and said nothing). Start: the frames rendered before the
    // stream was pushed. Done: the render call in which its data ran out. Underrun: a render call that found the
    // ring empty with data still to come; `detail` is the frames of silence that call produced for the stream.
    struct StreamEvent
    {
        enum Kind { Start, Done, Underrun };
        Kind kind = Start;
        uint32_t handle = 0;
        uint64_t frame = 0;
        uint64_t detail = 0;
    };

    class Mixer
    {
    public:
        Mixer();
        ~Mixer();

        // The output-frame clock: the sum of every `frames` render() has been asked for.
        uint64_t renderedFrames() const;
        // Where StreamEvents go (in addition to the [audio] stderr line each one prints). Called from inside
        // render() and playStream(), under the mixer's lock: keep the sink cheap and never call the mixer from it.
        void setStreamEventSink(std::function<void(const StreamEvent &)> sink);

        // The bank's block chunk and VAG chunk, as read from the disc. Replaces an earlier bank with the handle.
        bool loadBank(uint32_t handle, const uint8_t *block, size_t blockBytes, const uint8_t *vag, size_t vagBytes);
        void unloadBank(uint32_t handle);
        size_t bankCount() const;

        // snd_PlaySoundVolPanPMPB: vol 0..0x400 (0x400 = the sound's own volume), pan -1 = the sound's own,
        // pitchMod in 1/128 semitones, pitchBend -0x8000..0x7fff. Returns the handle (5 << 24 | slot << 16 | uid), 0 if not playable.
        uint32_t play(uint32_t bank, uint32_t sound, int32_t vol, int32_t pan, int32_t pitchMod, int32_t pitchBend);
        // The same under a handle the caller chose (the IOP module's): false if not playable.
        bool playWithHandle(uint32_t handle, uint32_t bank, uint32_t sound, int32_t vol, int32_t pan, int32_t pitchMod, int32_t pitchBend);
        bool isPlaying(uint32_t handle) const;
        // Sprint 7 review finding F3: has the mixer ever been handed this handle (playWithHandle / playStream)?
        // isPlaying answers false both for a finished sound and for one that never existed; the IOP model's
        // stream reaper has to tell those apart, or it frees the slot of a play that never reached the mixer.
        bool knowsHandle(uint32_t handle) const;
        void stop(uint32_t handle);      // key off: the voices release
        void pause(uint32_t handle);
        void resume(uint32_t handle);
        void setVolPan(uint32_t handle, int32_t vol, int32_t pan);   // kVolDontChange / kPanDontChange leave a value
        // snd_AutoVol (fno 0x22, research/06 section 3): a TIMED volume ramp, not an instant set. `vol` is the
        // target 0..0x400 (-4 = fade to silence and then stop the sound or stream), `ticks` its length in mixer
        // ticks (240 a second, as 989snd's own handlers run: the game's [handle, 0, 0x168, 2] is 1.5 s and
        // [handle, 0, 0x1e0, 2] is 2 s). `ticks` <= 0 applies the target at once. `how` is the call's 4th
        // argument (the game always passes 2); its meaning is not established by any reference we can reach, so
        // it is recorded and not acted on. setVolPan and stop cancel a ramp in flight. The ramp moves the handle's
        // own 7-bit volume in the IRX's integer steps and lands early: 360 ticks from 127 is 127 steps, one every 2
        // ticks, done at tick 254 (research/36 Q5; Sprint 15 T1b).
        void autoVol(uint32_t handle, int32_t vol, int32_t ticks, int32_t how);
        void setMasterVolume(uint32_t group, int32_t vol);           // 0..0x400; group 16 = every group
        void stopAll();
        // Sprint 9 Q0: snd_SetGlobalReg(index 1..32, value) -- the byte a grain reads as register -index (the M51
        // ambience conductor's TEST_REGISTER -2 reads what the game sets with index 2 every frame).
        void setGlobalReg(uint32_t index, int32_t value);
        int32_t globalReg(uint32_t index) const;
        // The child sounds a conductor's START_CHILD_SOUND grains have running under `handle`, and the sound index
        // of the `index`-th of them (0xFFFFFFFF past the end) -- for the tests; a child has no handle of the game's.
        size_t activeChildren(uint32_t handle) const;
        uint32_t childSound(uint32_t handle, size_t index) const;

        // snd_PlayVAGStreamByLoc: a VPK file in the disc image ("VPK " header: data size, 0x800-byte interleave, header size,
        // sample rate, channels; research/32 section 5) at `byteOffset` of `path`, read as it plays. vol 0..0x400, pan as play().
        // Sprint 9 Goal 10 (R169): `queueBehind` is snd_PlayVAGStreamByLoc's parentHandle, as the protocol means it
        // (research/06 section 142: "if parentHandle != 0 the stream is QUEUED after that stream instead"). A queued
        // segment waits behind whatever the handle is playing and starts on the very next output frame after it ends;
        // without it, a play on a live handle replaces what is there, which is what cut every mission cue dead.
        // Issue #94: `loopFile` is snd_PlayVAGStreamByLoc's flag 4, which the IRX's play worker (FUN_0000f7e0) turns
        // into the stream's 0x400 "loop the file" bit: at the end of the data the stream goes back to the top of it
        // (FUN_0001107c -> FUN_0001446c) and the handle keeps playing -- it never reports Done, only a stop ends it.
        bool playStream(uint32_t handle, const std::string &path, uint64_t byteOffset, int32_t vol, int32_t pan, uint8_t group,
                        bool queueBehind = false, bool loopFile = false);
        void stopAllStreams();

        // The decode-ahead half of the streams (audit 2026-09-17 section 2.3): reads and decodes the next chunk
        // pair of every live stream until its ring holds kStreamRingChunks, so render() never touches the disc.
        // Owns the file handles under its own I/O mutex and never holds the render mutex while reading. A worker
        // thread started on the first playStream calls it every 10 ms; PS2X_SND_STREAM_WORKER=0 disables that
        // thread and leaves pumpStreams() to the caller (what the tests do). Joined in the destructor.
        void pumpStreams();
        // Closes every stream's file handle and keeps its ring: the seam the "plays with the handle closed" test needs.
        void closeStreamFilesForTest();
        // How many stream files the mixer has closed, process-wide. A file playStream opened must be closed
        // exactly once: closing it twice is the double free glibc caught on Linux and Windows did not report,
        // and this counter is what a test can observe of the ownership on either platform.
        static uint64_t streamFileClosesForTest();
        // The handle's 7-bit volume in force (0..127: a stream's play volume, a bank sound's current volume), -1
        // when nothing carries it: what the AutoVol step-schedule test reads tick by tick (Sprint 15 T1b).
        int32_t autoVolLevelForTest(uint32_t handle) const;

        // The PCM stream (snd_PcmStreamOpen/Start/Position/Stop, research/32 section 7): the EE DMAs 16-bit PCM into a
        // ring the IRX plays through sceSdBlockTrans; stereo data is 512 bytes of left then 512 of right (the movie
        // audio's SShd interleave). The mixer plays the ring at `rate` from offset 0 and reports the play position in bytes.
        //
        // The ring exists from Open, not from Start: the game opens it, stops it, reads the CD stream and DMAs a
        // whole ring in, and only then starts it (any run log: snd_PcmStreamOpen -> snd_PcmStreamStop -> the
        // sceCdStRead fills -> snd_PcmStreamStart). On the console the ring is IOP memory, so those bytes are what
        // plays first; allocating at Start threw them away -- the "blip at each menu stream's start".
        void pcmStreamOpen(uint32_t ringBytes, uint32_t channels);   // allocate and zero; not active yet
        void pcmStreamClose();                                       // free the ring: a later write needs a new Open
        // Start keeps the bytes an Open-to-Start fill left and their fresh flags, and only restarts the play head.
        // A size (or channel count) the ring was not opened with re-allocates, and only then zeroes.
        void pcmStreamStart(uint32_t ringBytes, uint32_t rate, uint32_t channels, int32_t vol);
        void pcmStreamWrite(uint32_t offset, const uint8_t *data, size_t bytes);
        uint32_t pcmStreamPosition() const;   // bytes into the ring, 0 when stopped
        uint64_t pcmUnderruns() const;        // blocks the head reached before the game rewrote them (R97); 0 after stop
        // research/36 item 9 (2026-09-20), the instrument: stale RUNS of the PCM ring (a stretch of output frames the
        // head spent in blocks the game had not rewritten), one "[audio] 989snd pcm UNDERRUN frame=<start> silent=<n>"
        // line each when it ends; and the decoded audio a VAG stream holds ahead of its read head, in output frames
        // (the current chunk's remainder plus every chunk pair in its ring). PS2X_AUDIO_INSTRUMENT=1 prints both, per
        // live stream and for the ring, every 4800 output frames as "[audio] 989snd ... occupancy frame=<f> ahead=<n>".
        uint64_t pcmStarvationRuns() const;
        uint64_t streamFramesAhead(uint32_t handle) const;
        void pcmStreamStop();
        bool pcmStreamActive() const;
        size_t activeStreams() const;

        // Mix `frames` stereo frames (interleaved L R) at kSampleRate; advances the grain sequencers.
        void render(int16_t *interleaved, size_t frames);
        size_t activeVoices() const;
        size_t activeHandlers() const;

    private:
        void startStreamWorker();   // idempotent; a Mixer that never streams never starts a thread

        struct Impl;
        std::unique_ptr<Impl> m_impl;
    };
}
