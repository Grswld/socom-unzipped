#pragma once

// Sprint 17 F N1c (docs/research/82 section 9): dump the VU1 programs the native path REFUSED, and only those.
//
// PS2X_VU1_DUMP_REFUSED=<dir>[:<count>[:<entrypc>]] (a Dev Path, default "": off). After a native program hands
// back with a whole-program refusal whose reason is resume_command or write_range -- the reasons entry 0x33c8's write
// proof gives when a last-bone list holds a command it has no store range for -- VU1Interpreter::run writes the
// program's entry state as <dir>/vu1_refused_<n>_<reason>_<cmd>.bin, PS2X_VU1_DUMP's format (16-byte header startPc,
// top, itop, codeSize; code 16 KB; data 16 KB; vi[16]; vf[32][4]), so vu1_replay and every dump reader take it, and
// appends one line to <dir>/refused.txt:
//
//   vu1_refused_0_resume_command_0x2.bin entry=0x33c8 reason=resume_command cmd=0x2 resume=1 list=66,06,02,0a,2a,4c
//
// `list=` is the command list from the resume index (vi14 at 0x33c8, 0 at any other entry) as the x-lane words at
// qword 340 on, hex, up to and including the first 0x42 or 0x4c (64 qwords at most; an inline block's qwords are
// listed raw -- tools_py/parity/vu1_refused_shapes.py walks them properly). At most <count> files (default 150);
// <entrypc> (hex or decimal) narrows the capture to one entry, any entry otherwise. The directory is created.
//
// No 33 KB copy is taken per run: a whole-program refusal leaves the register file and VU data memory exactly as the
// entry found them (the dispatcher's contract, pinned by vu1_ops_tests' "nothing touched before the hand-back"), so
// the state written after the hand-back, before the fallback runs, IS the entry state. With the knob off run() pays
// one relaxed load per native entry and a refusal site one more (Vu1Refusals::rememberWhole).

#include "ps2x/knobs.h"
#include "runtime/vu1_native_refusals.h"

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <mutex>
#include <string>
#include <system_error>
#include <vector>

namespace Vu1DumpRefused
{
    constexpr int kDefaultCount = 150;
    constexpr uint32_t kListQword = 340;    // the dispatcher's command list (socom2_dispatch_0x1b50.cpp)
    constexpr uint32_t kListQwords = 64;    // its kMaxListQwords
    constexpr uint32_t kResumeEntryPc = 0x33c8u;

    struct Config
    {
        std::string dir;
        int maxFiles = kDefaultCount;
        bool anyEntry = true;
        uint32_t entryPc = 0u;
        bool on() const { return !dir.empty() && maxFiles > 0; }
    };

    // "<dir>[:<count>[:<entrypc>]]". A colon at index 1 is a drive letter ("C:/x"), not a separator.
    inline Config parse(const char *value)
    {
        Config config;
        if (value == nullptr || *value == '\0')
            return config;
        const std::string text = value;
        std::vector<std::string> fields;
        size_t start = 0u;
        for (size_t i = 2u; i < text.size(); ++i)
            if (text[i] == ':')
            {
                fields.push_back(text.substr(start, i - start));
                start = i + 1u;
            }
        fields.push_back(text.substr(start));
        config.dir = fields[0];
        if (fields.size() > 1u && !fields[1].empty())
            config.maxFiles = std::atoi(fields[1].c_str());
        if (fields.size() > 2u && !fields[2].empty())
        {
            char *end = nullptr;
            const unsigned long pc = std::strtoul(fields[2].c_str(), &end, 0);
            if (end != nullptr && *end == '\0')
            {
                config.anyEntry = false;
                config.entryPc = static_cast<uint32_t>(pc);
            }
        }
        return config;
    }

    // The reasons a capture writes: the resumed list holds a command the write proof has no range for, or one
    // whose range it could not prove. Every other refusal (skin_pass, repack_range ...) is not a list shape.
    inline bool dumpable(Vu1Refusals::Reason reason)
    {
        return reason == Vu1Refusals::Reason::ResumeCommand || reason == Vu1Refusals::Reason::WriteRange;
    }

    // The resumed command list: x-lane low 16 bits of qword 340 + resume on, through the first 0x42 or 0x4c.
    inline std::vector<uint32_t> resumedList(const uint8_t *data, uint32_t dataSize, int32_t resume)
    {
        std::vector<uint32_t> list;
        if (data == nullptr || resume < 0 || resume >= static_cast<int32_t>(kListQwords))
            return list;
        for (uint32_t k = static_cast<uint32_t>(resume); k < kListQwords; ++k)
        {
            const uint32_t offset = (kListQword + k) * 16u;
            if (offset + 4u > dataSize)
                break;
            uint32_t word = 0u;
            std::memcpy(&word, data + offset, 4u);
            list.push_back(word & 0xFFFFu);
            if (list.back() == 0x42u || list.back() == 0x4cu)
                break;
        }
        return list;
    }

    inline std::string fileName(int n, Vu1Refusals::Reason reason, uint32_t command)
    {
        char buf[96];
        std::snprintf(buf, sizeof(buf), "vu1_refused_%d_%s_0x%x.bin", n, Vu1Refusals::name(reason), command);
        return std::string(buf);
    }

    inline std::string indexLine(const std::string &file, uint32_t entryPc, Vu1Refusals::Reason reason, uint32_t command,
                                 int32_t resume, const std::vector<uint32_t> &list)
    {
        char head[256];
        std::snprintf(head, sizeof(head), "%s entry=0x%x reason=%s cmd=0x%x resume=%d list=", file.c_str(), entryPc,
                      Vu1Refusals::name(reason), command, resume);
        std::string line = head;
        for (size_t i = 0; i < list.size(); ++i)
        {
            char word[16];
            std::snprintf(word, sizeof(word), i == 0 ? "%02x" : ",%02x", list[i]);
            line += word;
        }
        return line;
    }

    // PS2X_VU1_DUMP's format, byte for byte (VU1Interpreter::run writes both through this).
    inline bool writeProgram(const std::string &path, const uint32_t header[4], const uint8_t *code, uint32_t codeSize,
                             const uint8_t *data, uint32_t dataSize, const int32_t vi[16], const float vf[32][4])
    {
        FILE *fp = std::fopen(path.c_str(), "wb");
        if (fp == nullptr)
            return false;
        std::fwrite(header, sizeof(uint32_t), 4, fp);
        std::fwrite(code, 1, std::min<uint32_t>(codeSize, 0x4000u), fp);
        std::fwrite(data, 1, std::min<uint32_t>(dataSize, 0x4000u), fp);
        std::fwrite(vi, sizeof(int32_t), 16, fp);
        std::fwrite(vf, sizeof(float), 32 * 4, fp);
        return std::fclose(fp) == 0;
    }

    // The process's capture: its configuration and how many files it has written.
    class Capture
    {
    public:
        void configure(const Config &config)
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            m_config = config;
            m_written = 0;
            m_dirMade = false;
        }

        Config config() const
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            return m_config;
        }

        int written() const
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            return m_written;
        }

        // After a native hand-back: writes the program when (entry, reason) is one the capture wants and the count
        // allows. Returns the path written, "" otherwise.
        std::string offer(const Vu1Refusals::WholeRefusal &refusal, const uint32_t header[4], const uint8_t *code,
                          uint32_t codeSize, const uint8_t *data, uint32_t dataSize, const int32_t vi[16],
                          const float vf[32][4])
        {
            if (!dumpable(refusal.reason))
                return std::string();
            std::lock_guard<std::mutex> lock(m_mutex);
            if (!m_config.on() || m_written >= m_config.maxFiles ||
                (!m_config.anyEntry && refusal.entryPc != m_config.entryPc))
                return std::string();
            if (!m_dirMade)
            {
                std::error_code ec;
                std::filesystem::create_directories(m_config.dir, ec);
                m_dirMade = true;
            }
            const int n = m_written++;
            const std::string file = fileName(n, refusal.reason, refusal.command);
            const std::string path = m_config.dir + "/" + file;
            if (!writeProgram(path, header, code, codeSize, data, dataSize, vi, vf))
            {
                std::fprintf(stderr, "[vu1-dump-refused] could not write %s\n", path.c_str());
                return std::string();
            }
            const int32_t resume = refusal.entryPc == kResumeEntryPc ? static_cast<int16_t>(vi[14] & 0xFFFF) : 0;
            const std::string line =
                indexLine(file, refusal.entryPc, refusal.reason, refusal.command, resume, resumedList(data, dataSize, resume));
            if (FILE *index = std::fopen((m_config.dir + "/refused.txt").c_str(), "a"))
            {
                std::fprintf(index, "%s\n", line.c_str());
                std::fclose(index);
            }
            if (n < 3 || n + 1 == m_config.maxFiles)
                std::fprintf(stderr, "[vu1-dump-refused] #%d %s\n", n, line.c_str());
            return path;
        }

    private:
        mutable std::mutex m_mutex;
        Config m_config;
        int m_written = 0;
        bool m_dirMade = false;
    };

    inline Capture &live()
    {
        static Capture s_capture;
        return s_capture;
    }

    // -1 = the knob not read yet; read on the first native entry that asks (after developer mode is set).
    inline std::atomic<int> &enabledState()
    {
        static std::atomic<int> s_state{-1};
        return s_state;
    }

    inline void apply(const Config &config)
    {
        live().configure(config);
        Vu1Refusals::wholeListening().store(config.on(), std::memory_order_relaxed);
        enabledState().store(config.on() ? 1 : 0, std::memory_order_relaxed);
    }

    inline bool enabled()
    {
        const int state = enabledState().load(std::memory_order_relaxed);
        if (__builtin_expect(state < 0, 0))
        {
            apply(parse(ps2x::knob("PS2X_VU1_DUMP_REFUSED")));
            return enabledState().load(std::memory_order_relaxed) != 0;
        }
        return state != 0;
    }

    // ps2x_tests: a value as the knob would carry it (nullptr or "" = off); -1 again re-reads the knob.
    inline void setForTest(const char *value) { apply(parse(value)); }
    inline void resetForTest()
    {
        live().configure(Config{});
        Vu1Refusals::wholeListening().store(false, std::memory_order_relaxed);
        enabledState().store(-1, std::memory_order_relaxed);
    }
}
