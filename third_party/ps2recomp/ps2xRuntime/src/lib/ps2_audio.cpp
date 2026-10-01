#include <chrono>
#include <cstdio>
#include <string>
#include <sstream>
#include <iostream>
#include <cstdlib>
#include "runtime/ps2_audio.h"
#include "runtime/audio_volume.h"
#include "runtime/audio_cb_trace.h"
#include "runtime/mix_device.h"
#include <atomic>
#include <memory>
#include <thread>
// miniaudio.h WITHOUT MINIAUDIO_IMPLEMENTATION, as host_mic.cpp: the implementation is raylib's raudio.c
#include "external/miniaudio.h"
#include "ps2_runtime.h"
#include "runtime/ps2_memory.h"
#include "ps2_host_backend.h"
#include "ps2x/knobs.h"
#include <cmath>
#include <cstring>
#include <vector>

namespace
{
    std::vector<uint8_t> buildWavFromPcm(const int16_t *pcm, size_t sampleCount, uint32_t sampleRate)
    {
        const uint32_t dataSize = static_cast<uint32_t>(sampleCount * 2);
        const uint32_t fileSize = 36 + dataSize;
        std::vector<uint8_t> wav(8 + fileSize);

        uint8_t *p = wav.data();
        p[0] = 'R';
        p[1] = 'I';
        p[2] = 'F';
        p[3] = 'F';
        p[4] = static_cast<uint8_t>(fileSize);
        p[5] = static_cast<uint8_t>(fileSize >> 8);
        p[6] = static_cast<uint8_t>(fileSize >> 16);
        p[7] = static_cast<uint8_t>(fileSize >> 24);
        p[8] = 'W';
        p[9] = 'A';
        p[10] = 'V';
        p[11] = 'E';
        p[12] = 'f';
        p[13] = 'm';
        p[14] = 't';
        p[15] = ' ';
        p[16] = 16;
        p[17] = 0;
        p[18] = 0;
        p[19] = 0;
        p[20] = 1;
        p[21] = 0;
        p[22] = 1;
        p[23] = 0;
        p[24] = static_cast<uint8_t>(sampleRate);
        p[25] = static_cast<uint8_t>(sampleRate >> 8);
        p[26] = static_cast<uint8_t>(sampleRate >> 16);
        p[27] = static_cast<uint8_t>(sampleRate >> 24);
        const uint32_t byteRate = sampleRate * 2;
        p[28] = static_cast<uint8_t>(byteRate);
        p[29] = static_cast<uint8_t>(byteRate >> 8);
        p[30] = static_cast<uint8_t>(byteRate >> 16);
        p[31] = static_cast<uint8_t>(byteRate >> 24);
        p[32] = 2;
        p[33] = 0;
        p[34] = 16;
        p[35] = 0;
        p[36] = 'd';
        p[37] = 'a';
        p[38] = 't';
        p[39] = 'a';
        p[40] = static_cast<uint8_t>(dataSize);
        p[41] = static_cast<uint8_t>(dataSize >> 8);
        p[42] = static_cast<uint8_t>(dataSize >> 16);
        p[43] = static_cast<uint8_t>(dataSize >> 24);
        if (pcm && dataSize)
            std::memcpy(p + 44, pcm, dataSize);
        return wav;
    }
}

namespace ps2_vag
{
    bool decode(const uint8_t *data, uint32_t sizeBytes,
                std::vector<int16_t> &outPcm, uint32_t &outSampleRate);
}

namespace
{
    // Append what the audio thread has recorded since the last flush, then the status line ("# dropped=N
    // recorded=M": a saturated trace is visible in the file itself, not only in a close summary the harness may
    // never let run). Called from the flusher thread once a second and once more when the trace stops; never
    // from the callback.
    void flushCbTraceRows(const ps2x::AudioCallbackTrace &trace, FILE *file, size_t &flushed, bool &headerDue)
    {
        if (!file)
            return;
        std::ostringstream rows;
        flushed = trace.flush(rows, flushed, headerDue, trace.t0EpochUs());
        headerDue = false;
        trace.status(rows);
        const std::string text = rows.str();
        std::fwrite(text.data(), 1, text.size(), file);
        std::fflush(file);
    }
}

struct PS2AudioBackend::Impl
{
    // The 989snd mix: one 48 kHz stereo stream fed from the audio thread (research/32 section 4).
    ma_context mixCtx{};        // Sprint 9 Q0: the runtime's own playback device, on ps2x::mixDeviceSpec()
    ma_device mixDevice{};
    bool mixCtxOk = false;
    bool mixStreamOpen = false;
    FILE *dumpFile = nullptr;           // PS2X_AUDIO_DUMP=<wav>: the mix, written as it is rendered (the harness kills the process)
    size_t dumpFrames = 0;
    std::string dumpPath;
    std::mutex dumpMutex;
    // PS2X_AUDIO_CB_TRACE=<csv> (Sprint 11 audio-out): every callback's wall-clock entry and exit, recorded on the
    // audio thread without I/O and appended to the file by a flusher thread once a second, so a hole at the endpoint
    // can be laid against the callback that was late -- or against none (KNOWN §2, the 50 ms dips).
    // The slot, not a bare unique_ptr: it is published to the running audio thread with a release store and
    // read back with an acquire load, and the trace carries its own t0 (fix round 2, R1).
    ps2x::AudioCallbackTraceSlot cbTrace;
    std::string cbTracePath;
    FILE *cbTraceFile = nullptr;
    size_t cbTraceFlushed = 0;
    bool cbTraceHeaderDue = true;
    std::thread cbTraceFlusher;
    std::atomic<bool> cbTraceStop{false};

    // Stop the flusher, write the rest, close the file. Called by closeMixerStream and by the destructor: a
    // joinable std::thread's destructor terminates the process, so every path that skips the close (the device
    // never started, the process is shutting down) still ends the flusher here (audio-out fix round 1, C1).
    void stopCbTrace()
    {
        cbTraceStop.store(true, std::memory_order_release);
        if (cbTraceFlusher.joinable())
            cbTraceFlusher.join();
        cbTrace.close();   // the device is stopped: nothing more may reach the audio thread
        if (cbTrace && cbTraceFile)
            flushCbTraceRows(*cbTrace.get(), cbTraceFile, cbTraceFlushed, cbTraceHeaderDue);
        if (cbTraceFile)
        {
            std::fclose(cbTraceFile);
            cbTraceFile = nullptr;
        }
    }
    ~Impl()
    {
        stopCbTrace();
    }
    struct TrackedSound
    {
        Sound snd;
        uint32_t sampleKey;
    };
    std::vector<TrackedSound> activeSounds;
};

PS2AudioBackend::PS2AudioBackend() : m_impl(std::make_unique<Impl>())
{
}

PS2AudioBackend::~PS2AudioBackend()
{
    closeMixerStream();
    if (m_impl)
        stopAll();
}

void PS2AudioBackend::onVagTransfer(const uint8_t *rdram, uint32_t srcAddr, uint32_t sizeBytes)
{
    if (!rdram || sizeBytes < 48)
        return;

    const uint32_t physAddr = srcAddr & PS2_RAM_MASK;
    if (physAddr + sizeBytes > PS2_RAM_SIZE)
        return;

    std::vector<int16_t> pcm;
    uint32_t sampleRate = 44100;
    if (!ps2_vag::decode(rdram + physAddr, sizeBytes, pcm, sampleRate))
        return;

    std::lock_guard<std::mutex> lock(m_mutex);
    DecodedSample sample;
    sample.pcm = std::move(pcm);
    sample.sampleRate = sampleRate;
    m_sampleBank[physAddr] = std::move(sample);
    m_mostRecentSampleKey = physAddr;
}

void PS2AudioBackend::onVagTransferFromBuffer(const uint8_t *data, uint32_t sizeBytes, uint32_t keyAddr)
{
    if (!data || sizeBytes < 48)
        return;

    std::vector<int16_t> pcm;
    uint32_t sampleRate = 44100;
    if (!ps2_vag::decode(data, sizeBytes, pcm, sampleRate))
        return;

    const uint32_t physAddr = keyAddr & PS2_RAM_MASK;
    std::lock_guard<std::mutex> lock(m_mutex);
    DecodedSample sample;
    sample.pcm = std::move(pcm);
    sample.sampleRate = sampleRate;
    m_sampleBank[physAddr] = sample;
    m_mostRecentSampleKey = physAddr;
    m_loadOrderSamples.push_back(std::move(sample));
    m_loadOrderSampleKeys.push_back(physAddr);
    constexpr size_t kMaxLoadOrderSamples = 32;
    if (m_loadOrderSamples.size() > kMaxLoadOrderSamples)
    {
        m_loadOrderSamples.erase(m_loadOrderSamples.begin());
        m_loadOrderSampleKeys.erase(m_loadOrderSampleKeys.begin());
    }
}

namespace
{
    constexpr uint32_t LIBSD_CMD_SET_VOICE = 0x8010u;
}

void PS2AudioBackend::onSoundCommand(uint32_t sid, uint32_t rpcNum,
                                     const uint8_t *sendBuf, uint32_t sendSize,
                                     uint8_t *recvBuf, uint32_t recvSize)
{
    if (sid != 0x80000701u)
        return;

    if ((rpcNum == LIBSD_CMD_SET_VOICE || (rpcNum & 0xFF00u) == 0x8100u) &&
        sendBuf && sendSize >= 20)
    {
        uint32_t sampleAddr = 0;
        uint32_t voiceIndex = 0xFFFFFFFFu;
        for (int vo = 4; vo >= 0 && voiceIndex == 0xFFFFFFFFu; vo -= 4)
        {
            if (vo < static_cast<int>(sendSize))
            {
                uint32_t v = 0;
                std::memcpy(&v, sendBuf + vo, sizeof(v));
                if (v < 24u)
                    voiceIndex = v;
            }
        }

        constexpr uint32_t kMinPlausibleAddr = 0x1000u;
        for (int off = 12; off <= 24 && sampleAddr == 0; off += 4)
        {
            if (sendSize >= static_cast<uint32_t>(off + 4))
            {
                uint32_t cand = 0;
                std::memcpy(&cand, sendBuf + off, sizeof(cand));
                if (cand >= kMinPlausibleAddr && (cand <= PS2_RAM_MASK || (cand & ~PS2_RAM_MASK) == 0))
                    sampleAddr = cand;
            }
        }
        if (sampleAddr == 0)
            sampleAddr = m_mostRecentSampleKey;

        float pitch = 1.0f;
        if (sendSize >= 12)
        {
            uint16_t pitchHalf = 0;
            std::memcpy(&pitchHalf, sendBuf + 8, sizeof(pitchHalf));
            if (pitchHalf != 0)
                pitch = 4096.0f / static_cast<float>(pitchHalf);
        }
        play(sampleAddr, pitch, 1.0f, voiceIndex);
    }
}

void PS2AudioBackend::play(uint32_t sampleAddr, float pitch, float volume, uint32_t voiceIndex)
{
    std::lock_guard<std::mutex> lock(m_mutex);
    DecodedSample *sampleToPlay = nullptr;
    uint32_t sampleKey = 0;

    auto it = m_sampleBank.find(sampleAddr & PS2_RAM_MASK);
    if (it != m_sampleBank.end())
    {
        sampleToPlay = &it->second;
        sampleKey = it->first;
    }
    else if (voiceIndex != 0xFFFFFFFFu &&
             voiceIndex < m_loadOrderSamples.size() &&
             voiceIndex < m_loadOrderSampleKeys.size())
    {
        sampleToPlay = &m_loadOrderSamples[voiceIndex];
        sampleKey = m_loadOrderSampleKeys[voiceIndex];
    }
    else
    {
        it = m_sampleBank.find(m_mostRecentSampleKey);
        if (it == m_sampleBank.end())
            return;
        sampleToPlay = &it->second;
        sampleKey = it->first;
    }
    if (!sampleToPlay || sampleToPlay->pcm.empty())
        return;

    const bool isBgm = (sampleToPlay->pcm.size() > static_cast<size_t>(sampleToPlay->sampleRate * 5));
    playDecodedSample(sampleKey, *sampleToPlay, pitch, volume, isBgm);
}

void PS2AudioBackend::pruneFinishedSounds()
{
#if defined(PLATFORM_VITA)
    return;
#else
    auto &sounds = m_impl->activeSounds;
    auto it = sounds.begin();
    while (it != sounds.end())
    {
        if (!IsSoundPlaying(it->snd))
        {
            UnloadSound(it->snd);
            it = sounds.erase(it);
        }
        else
        {
            ++it;
        }
    }
#endif
}

void PS2AudioBackend::playDecodedSample(uint32_t sampleKey, DecodedSample &sample, float pitch, float volume,
                                        bool isBgm)
{
#if defined(PLATFORM_VITA)
    (void)sampleKey;
    (void)sample;
    (void)pitch;
    (void)volume;
    (void)isBgm;
    return;
#else
    if (!m_audioReady || sample.pcm.empty())
        return;

    pruneFinishedSounds();

    for (const auto &t : m_impl->activeSounds)
    {
        if (t.sampleKey == sampleKey && IsSoundPlaying(t.snd))
            return;
    }

    auto &sounds = m_impl->activeSounds;
    if (isBgm)
    {
        for (auto it = sounds.begin(); it != sounds.end();)
        {
            if (IsSoundPlaying(it->snd))
            {
                StopSound(it->snd);
                UnloadSound(it->snd);
                it = sounds.erase(it);
            }
            else
                ++it;
        }
    }

    constexpr int kMaxConcurrentSounds = 4;
    while (static_cast<int>(sounds.size()) >= kMaxConcurrentSounds)
    {
        StopSound(sounds.front().snd);
        UnloadSound(sounds.front().snd);
        sounds.erase(sounds.begin());
    }

    std::vector<uint8_t> wav = buildWavFromPcm(sample.pcm.data(), sample.pcm.size(), sample.sampleRate);
    Wave wave = LoadWaveFromMemory(".wav", wav.data(), static_cast<int>(wav.size()));
    if (wave.frameCount <= 0)
        return;
    Sound snd = LoadSoundFromWave(wave);
    UnloadWave(wave);
    SetSoundPitch(snd, pitch);
    SetSoundVolume(snd, volume);
    m_impl->activeSounds.push_back({snd, sampleKey});
    PlaySound(snd);
#endif
}

void PS2AudioBackend::stop(uint32_t voiceId)
{
    (void)voiceId;
}

void PS2AudioBackend::stopAll()
{
    std::lock_guard<std::mutex> lock(m_mutex);
#if defined(PLATFORM_VITA)
    return;
#else
    for (auto &t : m_impl->activeSounds)
    {
        StopSound(t.snd);
        UnloadSound(t.snd);
    }
    m_impl->activeSounds.clear();
#endif
}

void PS2AudioBackend::stopForGuestRestart()
{
    stopAll();
    m_mixer.stopAll();
    m_mixer.stopAllStreams();
    m_mixer.pcmStreamStop();
    m_mixer.pcmStreamClose();
}

// ---- 989snd -------------------------------------------------------------------------------------

namespace
{
    // Twenty minutes, not ten: the sixteen-minute briefing captures ran past the old cap, and every endpoint dip
    // past the dump's end then read as "in the endpoint, not in the dump" (audio-out fix round 1, I6).
    constexpr size_t kDumpMaxFrames = 48000u * 1200u;
    constexpr size_t kCbTraceCapacity = 200000u;       // 20 ms callbacks for 66 minutes

    void mixDeviceCallback(ma_device *device, void *output, const void *, ma_uint32 frames)
    {
        auto *owner = static_cast<PS2AudioBackend *>(device->pUserData);
        if (owner)
            owner->mixerRender(static_cast<int16_t *>(output), frames);
        else
            std::memset(output, 0, static_cast<size_t>(frames) * 4u);
    }

    std::vector<uint8_t> buildStereoWav(const int16_t *pcm, size_t frames, uint32_t sampleRate)
    {
        const uint32_t dataSize = static_cast<uint32_t>(frames * 4);
        std::vector<uint8_t> wav(44 + dataSize);
        uint8_t *p = wav.data();
        auto put32 = [&](size_t at, uint32_t v) { p[at] = static_cast<uint8_t>(v); p[at + 1] = static_cast<uint8_t>(v >> 8); p[at + 2] = static_cast<uint8_t>(v >> 16); p[at + 3] = static_cast<uint8_t>(v >> 24); };
        auto put16 = [&](size_t at, uint16_t v) { p[at] = static_cast<uint8_t>(v); p[at + 1] = static_cast<uint8_t>(v >> 8); };
        std::memcpy(p, "RIFF", 4);
        put32(4, 36 + dataSize);
        std::memcpy(p + 8, "WAVEfmt ", 8);
        put32(16, 16);
        put16(20, 1);
        put16(22, 2);
        put32(24, sampleRate);
        put32(28, sampleRate * 4);
        put16(32, 4);
        put16(34, 16);
        std::memcpy(p + 36, "data", 4);
        put32(40, dataSize);
        std::memcpy(p + 44, pcm, dataSize);
        return wav;
    }
}

void PS2AudioBackend::setAudioReady(bool ready)
{
    m_audioReady = ready;
    if (ready)
        openMixerStream();
    else
        closeMixerStream();
}

void PS2AudioBackend::openMixerStream()
{
    if (!m_impl || m_impl->mixStreamOpen)
        return;
    if (const char *dump = ps2x::knob("PS2X_AUDIO_DUMP"))
    {
        m_impl->dumpPath = dump;
        m_impl->dumpFile = std::fopen(dump, "wb");
        if (m_impl->dumpFile)
        {
            const std::vector<uint8_t> header = buildStereoWav(nullptr, 0, snd989::kSampleRate);   // sizes patched on close; a killed run reads by file length
            std::fwrite(header.data(), 1, 44, m_impl->dumpFile);
        }
    }
    // Sprint 9 Q0: our own device, not raylib's AudioStream -- raylib opens miniaudio at 10 ms x 3 and offers no way
    // to change it, and that 30 ms buffer dropped out ~40 times a minute at the owner's speaker under gameplay
    // load (mix_device.h has the measurement). The mixer renders straight into the device's own buffer.
    const ps2x::MixDeviceSpec spec = ps2x::mixDeviceSpec();
    if (!m_impl->mixCtxOk)
    {
        if (ma_context_init(nullptr, 0, nullptr, &m_impl->mixCtx) != MA_SUCCESS)
        {
            std::cout << "[audio] 989snd mix device: no audio context" << std::endl;
            return;
        }
        m_impl->mixCtxOk = true;
    }
    ma_device_config cfg = ma_device_config_init(ma_device_type_playback);
    cfg.playback.format = ma_format_s16;
    cfg.playback.channels = spec.channels;
    cfg.sampleRate = spec.sampleRate;
    cfg.periodSizeInMilliseconds = spec.periodMs;
    cfg.periods = spec.periods;
    cfg.dataCallback = mixDeviceCallback;
    cfg.pUserData = this;
    if (ma_device_init(&m_impl->mixCtx, &cfg, &m_impl->mixDevice) != MA_SUCCESS)
    {
        std::cout << "[audio] 989snd mix device: could not open the playback device" << std::endl;
        return;
    }
    // The callback trace, BEFORE the device starts (audio-out fix round 2, R1). Round 1 moved this block after
    // ma_device_start so that a failed start could not leak the flusher -- but the audio thread is live from the
    // start, and publishing a unique_ptr into it, then setting t0, is a data race whose first row is stamped
    // against a default clock (the evidence capture began at out_frame 5760: six callbacks already gone). The
    // leak is answered by stopCbTrace()/~Impl instead, which was the load-bearing half of C1: the trace is
    // complete before AudioCallbackTraceSlot::open publishes it, and every failure path below stops the flusher.
    if (const char *cbPath = ps2x::knob("PS2X_AUDIO_CB_TRACE"); cbPath != nullptr && *cbPath != 0)
    {
        const int64_t epochUs = std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
        m_impl->cbTracePath = cbPath;
        m_impl->cbTraceFile = std::fopen(cbPath, "wb");
        m_impl->cbTraceFlushed = 0;
        m_impl->cbTraceHeaderDue = true;
        m_impl->cbTraceStop = false;
        m_impl->cbTrace.open(kCbTraceCapacity, static_cast<int64_t>(spec.periodMs) * 1000, spec.periods,
                             std::chrono::steady_clock::now(), epochUs);
        Impl *impl = m_impl.get();
        m_impl->cbTraceFlusher = std::thread([impl]
        {
            while (!impl->cbTraceStop.load(std::memory_order_acquire))
            {
                for (int i = 0; i < 10 && !impl->cbTraceStop.load(std::memory_order_acquire); ++i)
                    std::this_thread::sleep_for(std::chrono::milliseconds(100));
                flushCbTraceRows(*impl->cbTrace.get(), impl->cbTraceFile, impl->cbTraceFlushed, impl->cbTraceHeaderDue);
            }
        });
    }
    if (ma_device_start(&m_impl->mixDevice) != MA_SUCCESS)
    {
        ma_device_uninit(&m_impl->mixDevice);
        m_impl->stopCbTrace();      // no device, so no callback: end the flusher here rather than at ~Impl
        m_impl->cbTrace.reset();
        std::cout << "[audio] 989snd mix device: could not start the playback device" << std::endl;
        return;
    }
    m_impl->mixStreamOpen = true;
    std::cout << "[audio] 989snd mix stream open (" << spec.sampleRate << " Hz stereo, device " << m_impl->mixDevice.playback.name
              << ", period " << spec.periodMs << " ms x " << spec.periods << ", engine " << m_impl->mixDevice.sampleRate << " Hz"
              << (m_impl->dumpPath.empty() ? "" : ", dump " + m_impl->dumpPath) << ")" << std::endl;
}

void PS2AudioBackend::closeMixerStream()
{
    if (!m_impl || !m_impl->mixStreamOpen)
        return;
    ma_device_stop(&m_impl->mixDevice);
    ma_device_uninit(&m_impl->mixDevice);
    if (m_impl->mixCtxOk)
    {
        ma_context_uninit(&m_impl->mixCtx);
        m_impl->mixCtxOk = false;
    }
    m_impl->mixStreamOpen = false;
    if (m_impl->cbTrace)
    {
        // The device is stopped: the audio thread has recorded its last callback. Stop the flusher, write the
        // rest (rows and the status line), close the file, say what the session was.
        m_impl->stopCbTrace();
        const auto s = m_impl->cbTrace.get()->stats();
        std::cout << "[audio] wrote " << m_impl->cbTracePath << " (" << m_impl->cbTrace.get()->size() << " callbacks, late " << s.late
                  << ", dry " << s.dry << ", jitter " << s.jittered << ", max gap " << (s.maxGapUs / 1000.0) << " ms, max render "
                  << (s.maxRenderUs / 1000.0) << " ms, silence " << (s.silenceUs / 1000.0) << " ms, dropped " << m_impl->cbTrace.get()->dropped()
                  << ")" << std::endl;
        m_impl->cbTrace.reset();
    }
    std::lock_guard<std::mutex> lock(m_impl->dumpMutex);
    if (m_impl->dumpFile)
    {
        const uint32_t dataSize = static_cast<uint32_t>(m_impl->dumpFrames * 4);
        const std::vector<uint8_t> header = buildStereoWav(nullptr, m_impl->dumpFrames, snd989::kSampleRate);
        std::fseek(m_impl->dumpFile, 0, SEEK_SET);
        std::fwrite(header.data(), 1, 44, m_impl->dumpFile);
        std::fclose(m_impl->dumpFile);
        m_impl->dumpFile = nullptr;
        std::cout << "[audio] wrote " << m_impl->dumpPath << " (" << m_impl->dumpFrames << " frames, " << dataSize << " bytes)" << std::endl;
    }
}

void PS2AudioBackend::onBankLoaded(uint32_t handle, const uint8_t *block, size_t blockBytes, const uint8_t *vag, size_t vagBytes)
{
    const bool ok = m_mixer.loadBank(handle, block, blockBytes, vag, vagBytes);
    std::cout << "[audio] 989snd bank " << std::hex << handle << std::dec << (ok ? " loaded" : " rejected") << " (block "
              << blockBytes << " B, vag " << vagBytes << " B)" << std::endl;
}

void PS2AudioBackend::onNotify(uint32_t function, const int32_t *args, size_t count)
{
    auto arg = [&](size_t i) { return i < count ? args[i] : 0; };
    // The instrument (research/36 item 9, 2026-09-20): PS2X_AUDIO_INSTRUMENT=1 stamps every command that can change
    // a route's level -- master volume, pause/continue/stop, vol/pan, AutoVol, the stream and PCM stops -- with the
    // output-frame clock the [audio] start/done/UNDERRUN events carry, so a dip in the mix can be told from a
    // volume the game asked for (the IOP's own log of the same commands has no clock).
    static const bool s_instrument = ps2x::knob("PS2X_AUDIO_INSTRUMENT") != nullptr;
    if (s_instrument)
    {
        switch (function)
        {
        // 0x11/0x12 (the play family) joined the stamped commands on 2026-09-22, for R239's experiment: a
        // stray sound can only be charged to a play if the play carries the output-frame clock the capture is
        // measured on. Without the stamp, tools_py/parity/audio_dips.py can classify a dip as COMMAND but
        // nothing can align an ONSET with the play that caused it.
        case 0x09u: case 0x11u: case 0x12u: case 0x13u: case 0x14u: case 0x15u: case 0x18u: case 0x1Bu:
        case 0x21u: case 0x22u:
        case 0x2Du: case 0x2Eu: case 0x2Fu: case 0x34u: case 0x3Cu: case 0x3Du:
        {
            std::ostringstream o;
            o << "[audio] 989snd cmd 0x" << std::hex << function << " frame=" << std::dec << m_mixer.renderedFrames() << " [";
            for (size_t i = 0; i < count && i < 8u; ++i)
                o << (i ? ", " : "") << "0x" << std::hex << static_cast<uint32_t>(args[i]);
            o << "]";
            std::fprintf(stderr, "%s\n", o.str().c_str());
            break;
        }
        default:
            break;
        }
    }
    switch (function)
    {
    case 0x11u:
    case 0x12u:   // snd_PlaySoundVolPanPMPB[NoReturn]: {handle, bank, sound, vol, pan, pitchMod, pitchBend}
        if (count >= 7)
            m_mixer.playWithHandle(static_cast<uint32_t>(arg(0)), static_cast<uint32_t>(arg(1)), static_cast<uint32_t>(arg(2)), arg(3), arg(4), arg(5), arg(6));
        break;
    case 0x13u: m_mixer.pause(static_cast<uint32_t>(arg(0))); break;
    case 0x14u: m_mixer.resume(static_cast<uint32_t>(arg(0))); break;
    case 0x15u: m_mixer.stop(static_cast<uint32_t>(arg(0))); break;
    case 0x18u: m_mixer.stopAll(); break;
    case 0x1Bu: m_mixer.setVolPan(static_cast<uint32_t>(arg(0)), arg(1), arg(2)); break;
    case 0x21u:   // snd_SetSoundParams {handle, mask, vol, pan, pm, pb}: bit0 vol, bit1 pan
    {
        const int32_t mask = arg(1);
        m_mixer.setVolPan(static_cast<uint32_t>(arg(0)), (mask & 1) ? arg(2) : snd989::kVolDontChange, (mask & 2) ? arg(3) : snd989::kPanDontChange);
        break;
    }
    case 0x22u:   // snd_AutoVol {handle, vol, ticks, how}: a ramp over `ticks` 240 Hz ticks; vol -4 = fade out, then stop
        // The game fades its music cues with this ([handle, 0, 0x168, 2] = 1.5 s, [handle, 0, 0x1e0, 2] = 2 s in
        // the owner's 2026-09-18 mission). Applying the target at once, and stopping at once for -4, cut a cue
        // dead mid-phrase -- the owner's "skips and almost plays two different spliced segments".
        m_mixer.autoVol(static_cast<uint32_t>(arg(0)), arg(1), count >= 3 ? arg(2) : 0, count >= 4 ? arg(3) : 0);
        break;
    case 0x09u: m_mixer.setMasterVolume(static_cast<uint32_t>(arg(0)), arg(1)); break;
    case 0x67u: m_mixer.setGlobalReg(static_cast<uint32_t>(arg(0)), arg(1)); break;   // snd_SetGlobalReg {index, value}
    case 0x2Cu:   // snd_PlayVAGStreamByLoc {handle, sector1, sector2, off1, vol, off2, pan, group, flags, queued}
        if (count >= 9)
        {
            if (m_discImagePath.empty())
                m_discImagePath = PS2Runtime::getIoPaths().cdImage.string();
            const uint64_t offset = static_cast<uint64_t>(static_cast<uint32_t>(arg(1))) * 2048ull + static_cast<uint32_t>(arg(3));
            // Goal 10 (R169): the tenth word is the module's parentHandle, as a yes/no. Queued means the segment
            // waits for the one in the air and starts on the frame after its last sample; without it a play on a
            // live handle replaces what is there, which is the cue being cut dead.
            const bool queued = count >= 10 && arg(9) != 0;
            // Issue #94: the ninth word is the play's flags, and flag 4 is the IRX's 0x400 "loop the file"
            // (989SND.IRX FUN_0000f7e0: `if (param_10 & 4) *stream |= 0x400`). The SOCOM Online lobby track asks
            // for it; dropped, the track played once and the lobby was silent from then on. Only a fresh play: the
            // IRX's queued path (FUN_0000f7e0, decomp 9826-9831) keeps flag 4 as bit 4 of the queue node, not the
            // stream's 0x400, and nothing shown promotes it -- a queued segment plays once.
            const bool loopFile = !queued && (static_cast<uint32_t>(arg(8)) & 4u) != 0u;
            const bool ok = m_mixer.playStream(static_cast<uint32_t>(arg(0)), m_discImagePath, offset, arg(4), arg(6), static_cast<uint8_t>(arg(7)), queued,
                                               loopFile);
            std::cout << "[audio] 989snd stream " << std::hex << static_cast<uint32_t>(arg(0)) << " sector " << static_cast<uint32_t>(arg(1))
                      << std::dec << "+" << static_cast<uint32_t>(arg(3)) << (queued ? " queued" : "") << (loopFile ? " looping" : "") << (ok ? " playing" : " not a VPK or VAGp") << std::endl;
        }
        break;
    case 0x2Du: m_mixer.pause(static_cast<uint32_t>(arg(0))); break;
    case 0x2Eu: m_mixer.resume(static_cast<uint32_t>(arg(0))); break;
    case 0x2Fu: m_mixer.stop(static_cast<uint32_t>(arg(0))); break;
    case 0x34u: m_mixer.stopAllStreams(); break;
    case 0x3Eu:   // snd_PcmStreamStart {ringBytes, freq, channels, vol, buffer}
        if (count >= 4)
        {
            m_mixer.pcmStreamStart(static_cast<uint32_t>(arg(0)), static_cast<uint32_t>(arg(1)), static_cast<uint32_t>(arg(2)), arg(3));
            std::cout << "[audio] 989snd pcm stream: ring " << arg(0) << " B at " << std::hex << static_cast<uint32_t>(arg(4)) << std::dec << ", " << (arg(1) ? arg(1) : 48000) << " Hz, " << arg(2) << " ch, vol " << arg(3) << std::endl;
        }
        break;
    case 0x3Bu:   // snd_PcmStreamOpen {ringBytes, channels}: the ring the EE fills BEFORE it starts the stream
        if (count >= 1)
        {
            m_mixer.pcmStreamOpen(static_cast<uint32_t>(arg(0)), count >= 2 ? static_cast<uint32_t>(arg(1)) : 0u);
            std::cout << "[audio] 989snd pcm stream open: ring " << arg(0) << " B, " << (count >= 2 ? arg(1) : 2) << " ch" << std::endl;
        }
        break;
    case 0x3Cu: m_mixer.pcmStreamClose(); break;   // snd_PcmStreamClose: the ring is freed
    case 0x3Du: m_mixer.pcmStreamStop(); break;
    case 0x06u: m_mixer.unloadBank(static_cast<uint32_t>(arg(0))); break;
    default:
        break;
    }
}

void PS2AudioBackend::mixerRender(int16_t *interleaved, size_t frames)
{
    // PS2X_AUDIO_TRACE=1: how the host audio callback is serviced -- rendered frames against wall time, calls, the
    // longest render -- every 5 s (research/32 section 7.1: the title music starved when this fell to 80% of real time).
    static const bool trace = ps2x::knob("PS2X_AUDIO_TRACE") != nullptr;
    static const auto t0 = std::chrono::steady_clock::now();
    static uint64_t framesTotal = 0u, calls = 0u;
    static double maxRenderMs = 0.0, nextReportS = 5.0;
    const auto renderStart = std::chrono::steady_clock::now();
    m_mixer.render(interleaved, frames);
    // PS2X_AUDIO_VOLUME (read once): unity does nothing at all -- no multiply, no rounding -- so "100" is byte
    // for byte the mix this function produced before the knob existed.
    static const float s_gain = [] {
        const char *const e = ps2x::knob("PS2X_AUDIO_VOLUME");
        return volumeGain((e != nullptr && *e != 0) ? std::atoi(e) : 100);
    }();
    if (s_gain != 1.0f)
    {
        const size_t samples = frames * 2u;   // interleaved stereo
        for (size_t i = 0; i < samples; ++i)
            interleaved[i] = static_cast<int16_t>(std::lround(static_cast<float>(interleaved[i]) * s_gain));
    }
    if (trace)
    {
        const auto now = std::chrono::steady_clock::now();
        framesTotal += frames;
        ++calls;
        maxRenderMs = std::max(maxRenderMs, std::chrono::duration<double, std::milli>(now - renderStart).count());
        const double elapsedS = std::chrono::duration<double>(now - t0).count();
        if (elapsedS >= nextReportS)
        {
            // One line, one write: a concurrent stderr writer cannot split it and every grep of it stays whole (M5).
            char line[512];
            int n = std::snprintf(line, sizeof(line),
                                  "[audio-trace] t=%.1fs rendered=%.2fs of wall (%.0f%%) calls=%llu frames/call=%zu max_render=%.2fms pcm_underruns=%llu",
                                  elapsedS, framesTotal / 48000.0, 100.0 * (framesTotal / 48000.0) / elapsedS,
                                  static_cast<unsigned long long>(calls), frames, maxRenderMs, static_cast<unsigned long long>(m_mixer.pcmUnderruns()));
            const ps2x::AudioCallbackTrace *cbTrace = m_impl ? m_impl->cbTrace.live() : nullptr;
            if (cbTrace && n > 0 && static_cast<size_t>(n) < sizeof(line))
            {
                // Sprint 11 audio-out: the callback trace's running counts. late = the device thread was one
                // period from dry; dry = the buffer ran out and the endpoint got silence (cb_silence is its sum).
                const auto s = cbTrace->stats();
                n += std::snprintf(line + n, sizeof(line) - static_cast<size_t>(n),
                                   " cb_late=%llu cb_dry=%llu cb_jitter=%llu cb_max_gap=%.1fms cb_silence=%.0fms",
                                   static_cast<unsigned long long>(s.late), static_cast<unsigned long long>(s.dry),
                                   static_cast<unsigned long long>(s.jittered), s.maxGapUs / 1000.0, s.silenceUs / 1000.0);
            }
            if (n > 0 && static_cast<size_t>(n) < sizeof(line) - 1)
            {
                line[n++] = '\n';
                line[n] = 0;
            }
            std::fputs(line, stderr);
            nextReportS += 5.0;
            maxRenderMs = 0.0;
        }
    }
    if (m_impl && !m_impl->dumpPath.empty())
    {
        std::lock_guard<std::mutex> lock(m_impl->dumpMutex);
        if (m_impl->dumpFile && m_impl->dumpFrames < kDumpMaxFrames)
        {
            std::fwrite(interleaved, sizeof(int16_t), frames * 2, m_impl->dumpFile);
            m_impl->dumpFrames += frames;
            if ((m_impl->dumpFrames / frames) % 64 == 0)
                std::fflush(m_impl->dumpFile);
        }
    }
    if (ps2x::AudioCallbackTrace *cbTrace = m_impl ? m_impl->cbTrace.live() : nullptr)
    {
        // Sprint 11 audio-out: this callback's wall clock, recorded last so the exit stamp covers the dump's write
        // AND the frame-clock read below, which takes the mixer's mutex (the one the EE holds while submitting
        // 989snd commands): a wait there shows in this callback's render_us, not in the next one's gap (M1).
        // The trace came from the slot's acquire load, so it is complete and its t0 is its own (R1).
        const uint64_t outFrame = m_mixer.renderedFrames();
        const auto exit = std::chrono::steady_clock::now();
        cbTrace->record(cbTrace->stampUs(renderStart), cbTrace->stampUs(exit), static_cast<uint32_t>(frames), outFrame);
    }
}

bool PS2AudioBackend::isPlaying(uint32_t handle, bool &playing) const
{
    const uint32_t type = (handle >> 24) & 0x1Fu;
    if (type != 4u && type != 5u)
        return false;
    // Sprint 7 review finding F3: three-state. The IOP model mints the handle and only then forwards the play,
    // so a handle the mixer has never been handed is one whose play never arrived -- not one that has finished.
    // Answering "true, not playing" for it let the stream reaper free a slot the model still owned.
    if (!m_mixer.knowsHandle(handle))
        return false;
    playing = m_mixer.isPlaying(handle);
    return true;
}

void PS2AudioBackend::onPcmWrite(uint32_t offset, const uint8_t *data, size_t bytes)
{
    m_mixer.pcmStreamWrite(offset, data, bytes);
    // PS2X_AUDIO_PCM_DUMP=<file>: the first 16 MiB the EE wrote, raw with a wall-clock stamp, to check the ring's layout and fill rate offline.
    static FILE *s_dump = nullptr;
    static size_t s_dumped = 0;
    static bool s_tried = false;
    if (!s_tried)
    {
        s_tried = true;
        if (const char *path = ps2x::knob("PS2X_AUDIO_PCM_DUMP"))
            s_dump = std::fopen(path, "wb");
    }
    if (s_dump && s_dumped < (16u << 20))
    {
        static const auto s_epoch = std::chrono::steady_clock::now();
        const uint32_t ms = static_cast<uint32_t>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - s_epoch).count());
        const uint32_t hdr[3] = {offset, static_cast<uint32_t>(bytes), ms};   // offset, bytes, wall ms since the first write
        std::fwrite(hdr, sizeof(hdr), 1, s_dump);
        std::fwrite(data, 1, bytes, s_dump);
        std::fflush(s_dump);
        s_dumped += bytes;
    }
}

bool PS2AudioBackend::pcmPosition(uint32_t &position) const
{
    if (!m_mixer.pcmStreamActive())
        return false;
    position = m_mixer.pcmStreamPosition();
    return true;
}
