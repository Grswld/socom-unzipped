// harness_lle: the disc's real LIBSD.IRX + 989SND.IRX + 989DSTRM.IRX on #254's LLE IOP
// (Sinan-Karakaya/PS2Recomp@e42efbe ps2xIOP/src/lle, patched: see ORACLE PATCH), driven by the same line protocol as
// docs/research/assets/40-irx-differential/harness.cpp so its replay.py runs unchanged (Sprint 15 T1, research/70).
//
// The host import provider: the imports #254's kernel returns zero for -- cdvdman (read, sync, error, callback,
// stop, status, break), ioman (open, close, read, lseek) and sifman's sceSifSetDmaIntr -- served from the disc image.
// ORACLE_NO_PROVIDER=1 leaves them unbound (the kernel's "returns zero"): the refused-read run.
//
// stdin: load <guest path> [args] | rpc <snd|stream> <fno hex> [words hex...] | tick <ee cycles> | peek <addr> <n> |
//        ipeek <addr> <n> | snap | quit.  Every log line is echoed as "LOG <level> <text>".

#include "lle/iop.h"

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <functional>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

using namespace ps2x::iop::lle;
namespace fs = std::filesystem;

namespace
{
    constexpr uint32_t kSndSid = 0x00123456u;
    constexpr uint32_t kStreamSid = 0x00123457u;
    constexpr uint32_t kSndSend = 0x489040u;
    constexpr uint32_t kSndRecv = 0x489000u;
    constexpr uint32_t kStreamSend = 0x48db00u;
    constexpr uint32_t kStreamRecv = 0x48dac0u;
    constexpr uint32_t kGuestBytes = 32u * 1024u * 1024u;
    constexpr uint64_t kEeClock = 294'912'000u;
    constexpr uint32_t kSector = 2048u;
    // The provider's latency is ours (research/69 §2): 1 ms to reach the data, then 4 MB/s.
    constexpr uint64_t kReadAccess = Iop::kClock / 1000u;
    constexpr uint64_t kReadPerSector = Iop::kClock * kSector / (4u * 1024u * 1024u);
    constexpr uint64_t kSifDmaLatency = Iop::kClock / 10'000u;

    std::string upper(std::string s)
    {
        for (char &c : s)
            c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
        return s;
    }

    FILE *openFile(const std::string &path)
    {
        return std::fopen(path.c_str(), "rb");
    }

    bool seekFile(FILE *fp, uint64_t offset)
    {
#ifdef _WIN32
        return _fseeki64(fp, static_cast<long long>(offset), SEEK_SET) == 0;
#else
        return fseeko(fp, static_cast<off_t>(offset), SEEK_SET) == 0;
#endif
    }

    class Host final : public EeLink
    {
    public:
        Host(std::string cdRoot, std::string cdImage)
            : guest(kGuestBytes, 0u), m_cdRoot(std::move(cdRoot)), m_cdImage(std::move(cdImage))
        {
            const char *off = std::getenv("ORACLE_NO_PROVIDER");
            provider = !(off && *off && *off != '0');
        }

        // ---------------------------------------------------------------- EeLink
        bool readEe(uint32_t address, void *destination, uint32_t size) override
        {
            address &= 0x1FFFFFFFu;
            if (address > guest.size() || size > guest.size() - address)
                return false;
            std::memcpy(destination, guest.data() + address, size);
            return true;
        }
        bool writeEe(uint32_t address, const void *source, uint32_t size) override
        {
            address &= 0x1FFFFFFFu;
            if (address > guest.size() || size > guest.size() - address)
                return false;
            std::memcpy(guest.data() + address, source, size);
            return true;
        }
        bool eeServer(uint32_t) override { return false; }
        void log(const std::string &message) override
        {
            std::string text(message);
            std::replace(text.begin(), text.end(), '\n', ' ');
            std::printf("LOG Info %s\n", text.c_str());
        }

        bool claimsImport(const std::string &library, uint16_t ordinal) override
        {
            return provider && (library == "cdvdman" || library == "ioman" || (library == "sifman" && ordinal == 32u));
        }

        void hostImport(Iop &iop, const std::string &library, uint16_t ordinal, CpuContext &c) override
        {
            const auto a = [&](unsigned i) { return iop.argument(c, i); };
            uint32_t result = 0u;
            if (library == "cdvdman")
                result = cdvdman(iop, ordinal, a(0), a(1), a(2), a(3), c.gpr[28]);
            else if (library == "ioman")
                result = ioman(iop, ordinal, a(0), a(1), a(2));
            else if (library == "sifman" && ordinal == 32u)
                result = sifSetDmaIntr(iop, a(0), a(1), a(2), a(3), c.gpr[28]);
            c.gpr[2] = result;
        }

        // ---------------------------------------------------------------- paths
        // "cdrom0:\RUN\IRX\SOUND\989SND.IRX;1" -> the extracted disc's file, case-insensitively.
        std::string translate(std::string p) const
        {
            if (const auto colon = p.find(':'); colon != std::string::npos)
                p = p.substr(colon + 1);
            if (const auto semi = p.find(';'); semi != std::string::npos)
                p = p.substr(0, semi);
            std::replace(p.begin(), p.end(), '\\', '/');
            fs::path cur(m_cdRoot);
            std::stringstream ss(p);
            std::string part;
            while (std::getline(ss, part, '/'))
            {
                if (part.empty())
                    continue;
                bool found = false;
                std::error_code ec;
                for (const auto &entry : fs::directory_iterator(cur, ec))
                    if (upper(entry.path().filename().string()) == upper(part))
                    {
                        cur = entry.path();
                        found = true;
                        break;
                    }
                if (!found)
                    return {};
            }
            return cur.string();
        }

        std::vector<uint8_t> guest;
        bool provider = true;
        // Counters for SNAP.
        uint64_t reads = 0, sectors = 0, readsRefused = 0, readsDone = 0, cdCallbacks = 0, syncs = 0, breaks = 0;
        uint64_t dmaIntr = 0, dmaCallbacks = 0, fileOpens = 0;

    private:
        // ---------------------------------------------------------------- cdvdman
        uint32_t cdvdman(Iop &iop, uint16_t ordinal, uint32_t a0, uint32_t a1, uint32_t a2, uint32_t, uint32_t gp)
        {
            switch (ordinal)
            {
            case 6: // sceCdRead(lsn, sectors, buffer, mode)
            {
                if (m_busy)
                {
                    ++readsRefused;
                    return 0u; // the drive is busy: the real cdvdman refuses too
                }
                ++reads;
                sectors += a1;
                m_busy = true;
                const uint64_t generation = ++m_generation;
                m_pending = [this, &iop, lsn = a0, count = a1, buffer = a2]() {
                    std::vector<uint8_t> data(static_cast<size_t>(count) * kSector, 0u);
                    bool ok = image() && seekFile(m_image, static_cast<uint64_t>(lsn) * kSector) &&
                              std::fread(data.data(), 1, data.size(), m_image) == data.size();
                    iop.writeMemory(buffer, data.data(), static_cast<uint32_t>(data.size()));
                    m_error = ok ? 0u : 0x30u;
                    m_busy = false;
                    ++readsDone;
                    if (m_callback != 0u)
                    {
                        ++cdCallbacks;
                        iop.callGuest(m_callback, 1u /* SCECdFuncRead */, m_callbackGp);
                    }
                };
                iop.defer(kReadAccess + kReadPerSector * a1, [this, generation]() {
                    if (generation == m_generation)
                        finish();
                });
                return 1u;
            }
            case 8: // sceCdGetError
                return m_error;
            case 11: // sceCdSync(mode): bit 0 set = poll, clear = block until done
                ++syncs;
                if ((a0 & 1u) != 0u)
                    return m_busy ? 1u : 0u;
                if (m_busy)
                    finish();
                return 0u;
            case 15: // sceCdStop
                cancel();
                return 1u;
            case 28: // sceCdStatus
                return m_busy ? 0x06u /* read */ : 0x0Au /* pause */;
            case 37: // sceCdCallback(function): the previous one
            {
                const uint32_t previous = m_callback;
                m_callback = a0;
                m_callbackGp = gp;
                return previous;
            }
            case 39: // sceCdBreak
                ++breaks;
                cancel();
                return 1u;
            default:
                return 0u;
            }
        }

        void finish()
        {
            ++m_generation; // a deferred completion for this read is now stale
            if (m_pending)
            {
                auto work = std::move(m_pending);
                m_pending = nullptr;
                work();
            }
        }

        void cancel()
        {
            ++m_generation;
            m_pending = nullptr;
            m_busy = false;
        }

        bool image()
        {
            if (!m_image)
                m_image = openFile(m_cdImage);
            return m_image != nullptr;
        }

        // ---------------------------------------------------------------- ioman (host files under the disc root)
        uint32_t ioman(Iop &iop, uint16_t ordinal, uint32_t a0, uint32_t a1, uint32_t a2)
        {
            switch (ordinal)
            {
            case 4: // open(name, flags)
            {
                std::string name;
                for (uint32_t i = 0; i < 256u; ++i)
                {
                    uint8_t ch = 0;
                    iop.readMemory(a0 + i, &ch, 1u);
                    if (!ch)
                        break;
                    name.push_back(static_cast<char>(ch));
                }
                const std::string host = translate(name);
                FILE *fp = host.empty() ? nullptr : openFile(host);
                log("[provider] open " + name + (fp ? " ok" : " FAILED"));
                if (!fp)
                    return static_cast<uint32_t>(-2);
                ++fileOpens;
                m_files.push_back(fp);
                return static_cast<uint32_t>(m_files.size() + 2u);
            }
            case 5: // close(fd)
                if (FILE *fp = file(a0))
                {
                    std::fclose(fp);
                    m_files[a0 - 3u] = nullptr;
                    return 0u;
                }
                return static_cast<uint32_t>(-9);
            case 6: // read(fd, buffer, size)
            {
                FILE *fp = file(a0);
                if (!fp)
                    return static_cast<uint32_t>(-9);
                std::vector<uint8_t> data(a2);
                const size_t got = std::fread(data.data(), 1, data.size(), fp);
                iop.writeMemory(a1, data.data(), static_cast<uint32_t>(got));
                return static_cast<uint32_t>(got);
            }
            case 8: // lseek(fd, offset, whence)
            {
                FILE *fp = file(a0);
                if (!fp)
                    return static_cast<uint32_t>(-9);
                std::fseek(fp, static_cast<int32_t>(a1), a2 == 2u ? SEEK_END : a2 == 1u ? SEEK_CUR : SEEK_SET);
                return static_cast<uint32_t>(std::ftell(fp));
            }
            default:
                return 0u;
            }
        }

        FILE *file(uint32_t fd) const
        {
            return (fd < 3u || fd - 3u >= m_files.size()) ? nullptr : m_files[fd - 3u];
        }

        // ---------------------------------------------------------------- sifman #32
        // sceSifSetDmaIntr(descriptors, count, function, data): the transfer lands at once; the completion callback
        // runs as the interrupt would, a SIF round trip later.
        uint32_t sifSetDmaIntr(Iop &iop, uint32_t list, uint32_t count, uint32_t function, uint32_t data, uint32_t gp)
        {
            ++dmaIntr;
            for (uint32_t i = 0; i < count; ++i)
            {
                uint32_t d[4] = {};
                iop.readMemory(list + i * 16u, d, sizeof d);
                std::vector<uint8_t> bytes(d[2]);
                iop.readMemory(d[0], bytes.data(), d[2]);
                writeEe(d[1], bytes.data(), d[2]);
            }
            if (function != 0u)
                iop.defer(kSifDmaLatency, [this, &iop, function, data, gp]() {
                    ++dmaCallbacks;
                    iop.callGuest(function, data, gp);
                });
            return ++m_dmaId;
        }

        std::string m_cdRoot, m_cdImage;
        FILE *m_image = nullptr;
        bool m_busy = false;
        uint32_t m_error = 0u;
        uint32_t m_callback = 0u, m_callbackGp = 0u;
        uint64_t m_generation = 0;
        std::function<void()> m_pending;
        std::vector<FILE *> m_files;
        uint32_t m_dmaId = 0x100u;
    };

    uint32_t parseHex(const std::string &s) { return static_cast<uint32_t>(std::stoul(s, nullptr, 16)); }
}

int main(int argc, char **argv)
{
    if (argc < 3)
    {
        std::fprintf(stderr, "usage: harness_lle <cd root dir> <cd image .iso>\n");
        return 2;
    }
    std::setvbuf(stdout, nullptr, _IOLBF, 1 << 16);
    Host host(argv[1], argv[2]);
    Iop iop(host);
    std::printf("READY provider=%d\n", host.provider ? 1 : 0);
    std::fflush(stdout);

    uint64_t sampleRemainder = 0;
    std::string line;
    while (std::getline(std::cin, line))
    {
        std::istringstream in(line);
        std::string cmd;
        in >> cmd;
        if (cmd.empty())
            continue;
        if (cmd == "quit")
            break;
        if (cmd == "load")
        {
            std::string path, rest;
            in >> path;
            std::getline(in, rest);
            std::vector<std::string> args;
            std::istringstream words(rest);
            for (std::string w; words >> w;)
                args.push_back(w);
            const std::string file = host.translate(path);
            std::vector<uint8_t> bytes;
            if (FILE *fp = file.empty() ? nullptr : std::fopen(file.c_str(), "rb"))
            {
                std::fseek(fp, 0, SEEK_END);
                bytes.resize(static_cast<size_t>(std::ftell(fp)));
                std::fseek(fp, 0, SEEK_SET);
                bytes.resize(std::fread(bytes.data(), 1, bytes.size(), fp));
                std::fclose(fp);
            }
            const int32_t id = bytes.empty() ? -1 : iop.loadModule(bytes, path, args);
            std::printf("LOAD %s handled=%d id=%d start=%d modules=%zu threads=%zu servers=%zu\n", path.c_str(),
                        bytes.empty() ? 0 : 1, id, id > 0 ? 0 : -1, iop.moduleCount(), iop.threadCount(), iop.serverCount());
        }
        else if (cmd == "rpc")
        {
            std::string which, fnoText;
            in >> which >> fnoText;
            const bool stream = which == "stream";
            auto request = std::make_shared<Iop::Request>();
            request->sid = stream ? kStreamSid : kSndSid;
            request->function = parseHex(fnoText);
            for (std::string w; in >> w;)
            {
                const uint32_t v = parseHex(w);
                const auto *p = reinterpret_cast<const uint8_t *>(&v);
                request->send.insert(request->send.end(), p, p + 4);
            }
            request->receiveAddress = stream ? kStreamRecv : kSndRecv;
            request->receiveSize = stream ? 4u : 0xCu;
            std::memset(host.guest.data() + request->receiveAddress, 0, 0x40u);
            const bool served = iop.hasServer(request->sid);
            const uint64_t before = iop.work();
            iop.submit(request);
            iop.settle();
            // The EE waits for the IOP (#254's NativeIop::call): run the clock until the answer, at most 2 s.
            uint32_t waited = 0;
            int16_t l = 0, r = 0;
            while (!request->done && waited < 96'000u)
            {
                iop.step(l, r);
                ++waited;
                if ((waited % 480u) == 0u)
                    iop.settle();
            }
            uint32_t out[4] = {};
            std::memcpy(out, host.guest.data() + request->receiveAddress, sizeof out);
            std::printf("RPC %s fno=%02x handled=%d recv=%08x %08x %08x %08x instr=%llu waited=%u\n", stream ? "stream" : "snd",
                        request->function, served && request->done ? 1 : 0, out[0], out[1], out[2], out[3],
                        static_cast<unsigned long long>(iop.work() - before), waited);
        }
        else if (cmd == "tick")
        {
            unsigned long long cycles = 0;
            in >> cycles;
            sampleRemainder += static_cast<uint64_t>(cycles) * 48'000u;
            const uint64_t samples = sampleRemainder / kEeClock;
            sampleRemainder %= kEeClock;
            const uint64_t before = iop.work();
            int peak = 0;
            uint64_t nonzero = 0;
            for (uint64_t i = 0; i < samples; ++i)
            {
                int16_t l = 0, r = 0;
                iop.step(l, r);
                peak = std::max({peak, std::abs(static_cast<int>(l)), std::abs(static_cast<int>(r))});
                nonzero += (l != 0 || r != 0) ? 1u : 0u;
            }
            std::printf("TICK cycles=%llu instr=%llu samples=%llu peak=%d nonzero=%llu\n", cycles,
                        static_cast<unsigned long long>(iop.work() - before), static_cast<unsigned long long>(samples), peak,
                        static_cast<unsigned long long>(nonzero));
        }
        else if (cmd == "peek" || cmd == "ipeek")
        {
            std::string a;
            unsigned n = 0;
            in >> a >> n;
            const uint32_t addr = parseHex(a);
            std::printf("%s %08x", cmd == "peek" ? "PEEK" : "IPEEK", addr);
            for (unsigned i = 0; i < n; ++i)
            {
                uint32_t v = 0;
                if (cmd == "peek")
                    (void)host.readEe(addr + 4u * i, &v, 4u);
                else
                    iop.readMemory(addr + 4u * i, &v, 4u);
                std::printf(" %08x", v);
            }
            std::printf("\n");
        }
        else if (cmd == "snap")
        {
            std::printf("SNAP cycles=%llu instr=%llu modules=%zu threads=%zu servers=%zu diagnostics=0 provider=%d reads=%llu "
                        "sectors=%llu refused=%llu done=%llu cdcb=%llu syncs=%llu breaks=%llu dmaintr=%llu dmacb=%llu opens=%llu\n",
                        static_cast<unsigned long long>(iop.cycle()), static_cast<unsigned long long>(iop.work()),
                        iop.moduleCount(), iop.threadCount(), iop.serverCount(), host.provider ? 1 : 0,
                        static_cast<unsigned long long>(host.reads), static_cast<unsigned long long>(host.sectors),
                        static_cast<unsigned long long>(host.readsRefused), static_cast<unsigned long long>(host.readsDone),
                        static_cast<unsigned long long>(host.cdCallbacks), static_cast<unsigned long long>(host.syncs),
                        static_cast<unsigned long long>(host.breaks), static_cast<unsigned long long>(host.dmaIntr),
                        static_cast<unsigned long long>(host.dmaCallbacks), static_cast<unsigned long long>(host.fileOpens));
        }
        else
            std::printf("ERR unknown command: %s\n", cmd.c_str());
        std::fflush(stdout);
    }
    return 0;
}
