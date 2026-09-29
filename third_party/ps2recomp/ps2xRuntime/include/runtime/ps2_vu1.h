#ifndef PS2_VU1_H
#define PS2_VU1_H

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <emmintrin.h>

class GS;
class PS2Memory;

struct VU1State
{
    float vf[32][4];
    int32_t vi[16];
    float acc[4];
    float q;
    float p;
    float i;
    uint32_t r;
    uint32_t pc;
    uint32_t mac;
    uint32_t clip;
    uint32_t status;
    uint64_t cycles;
    bool ebit;
    bool haltAfterDelaySlot;
    bool dBitEnabled;
    bool tBitEnabled;
    bool stoppedByD;
    bool stoppedByT;
    uint32_t top;  // VIF TOP visible to XTOP
    uint32_t itop; // VIF ITOP visible to XITOP

    bool branchPending;
    uint32_t branchTarget;
    uint32_t branchDelay;
};

// Hand-written host replacement of one microprogram entry point (src/lib/vu/native); defined
// below the interpreter because it names VU1Interpreter::KnownProgramFn.
struct Vu1NativeProgram;

class VU1Interpreter
{
    friend struct Vu1Gen; // generated known-program code (src/lib/vu/ps2_vu1_ops.h)
    friend struct Vu1FlagRingProbe; // ps2xTest vu1_ops_tests.cpp: drives the fast flag ring (S17 F C2)
public:
    enum class Unit : uint8_t
    {
        VU0,
        VU1
    };

    explicit VU1Interpreter(Unit unit = Unit::VU1);

    void reset();

    void execute(uint8_t *vuCode, uint32_t codeSize,
                 uint8_t *vuData, uint32_t dataSize,
                 GS &gs, PS2Memory *memory = nullptr,
                 uint32_t startPC = 0, uint32_t top = 0, uint32_t itop = 0,
                 uint32_t maxCycles = 65536);

    void resume(uint8_t *vuCode, uint32_t codeSize,
                uint8_t *vuData, uint32_t dataSize,
                GS &gs, PS2Memory *memory = nullptr,
                uint32_t top = 0, uint32_t itop = 0, uint32_t maxCycles = 65536);

    // The VIF's MSCAL / MSCNT entry points. The hardware VIF stalls on both until the VU is idle, so
    // a program a budget stop left pending (research/31 section 16: a 43-primitive terrain chunk needs
    // 68k cycles, the callbacks ran it under 65536 and the next MSCNT 'continued' it mid-clipper with
    // the next buffer's TOP) finishes first, with its own TOP/ITOP, and the new program or the
    // continuation then runs to its E bit. kVifCycleGuard bounds a runaway program: past it the
    // program is dropped so the VIF can go on (hardware would hang there).
    static constexpr uint32_t kVifCycleSlice = 1u << 20;
    static constexpr uint64_t kVifCycleGuard = 1ull << 28;
    void executeProgram(uint8_t *vuCode, uint32_t codeSize, uint8_t *vuData, uint32_t dataSize,
                        GS &gs, PS2Memory *memory, uint32_t startPC, uint32_t top, uint32_t itop);
    void continueProgram(uint8_t *vuCode, uint32_t codeSize, uint8_t *vuData, uint32_t dataSize,
                         GS &gs, PS2Memory *memory, uint32_t top, uint32_t itop);
    // True when the last run() stopped on its cycle budget before the program's E bit.
    bool programPending() const { return m_programPending; }

    VU1State &state() { return m_state; }
    const VU1State &state() const { return m_state; }

    // The GS the running microprogram submits to. Valid only during execute()/resume().
    GS *activeGs() const { return m_activeGs; }

    // Generated known-program entry (src/lib/vu/generated): returns true when the program ended.
    typedef bool (*KnownProgramFn)(VU1Interpreter &vu, uint64_t budgetEnd);

    // Test hook: use `table` instead of the built-in native-program registry
    // (src/lib/vu/native/vu1_native_programs.cpp). nullptr, 0 restores the built-in table.
    void setNativeProgramsOverride(const Vu1NativeProgram *table, uint32_t count);

private:
    enum Pipeline : uint8_t
    {
        PipelineNone = 0,
        PipelineFmac,
        PipelineLsu,
        PipelineFdiv,
        PipelineEfu,
        PipelineIalu,
        PipelineBranch,
        PipelineXgkick
    };

    struct VfAccess
    {
        uint8_t reg = 0;
        uint8_t lanes = 0;
    };

    struct InstructionUsage
    {
        std::array<VfAccess, 2> vfRead{};
        VfAccess vfWrite{};
        uint8_t vfReadCount = 0;
        uint16_t viRead = 0;
        uint16_t viWrite = 0;
        uint8_t accRead = 0;
        uint8_t accWrite = 0;
        uint8_t latency = 0;
        uint8_t vfLatency = 0;
        uint8_t viLatency = 0;
        Pipeline pipeline = PipelineNone;
        bool waitQ = false;
        bool waitP = false;
        bool readsClip = false;
        bool writesClip = false;
        bool delaysNextBranchRead = false;
        bool reserved = false;
    };

    struct DecodedInstructionPair
    {
        uint32_t lower = 0;
        uint32_t upper = 0;
        InstructionUsage lowerUsage{};
        InstructionUsage upperUsage{};
        bool iBit = false;
        bool eBit = false;
        bool mBit = false;
        bool dBit = false;
        bool tBit = false;
        uint8_t upperVfShadowReg = 0;
        uint8_t suppressedLowerVf = 0;
    };

    struct FlagPipelineEntry
    {
        uint64_t readyCycle = 0;
        uint64_t issueCycle = 0;
        uint32_t issuePc = 0;       // program counter of the producing instruction (flag trace)
        uint32_t mac = 0;
        uint32_t status = 0;
        uint32_t extraSticky = 0;
        uint32_t clip = 0;
        bool valid = false;
        bool writesMac = false;
        bool writesStatus = false;
        bool writesSticky = false;
        bool writesClip = false;
    };

    struct ScalarPipelineEntry
    {
        uint64_t readyCycle = 0;
        float value = 0.0f;
        uint32_t statusDi = 0;
        bool valid = false;
    };

    struct PendingStore
    {
        uint64_t readyCycle = 0;
        uint32_t address = 0;
        std::array<uint32_t, 4> words{};
        uint8_t laneMask = 0;
        bool valid = false;
    };

    struct PendingVfWrite
    {
        uint64_t readyCycle = 0;
        uint64_t sequence = 0;
        std::array<float, 4> value{};
        uint8_t reg = 0;
        uint8_t laneMask = 0;
        bool valid = false;
    };

    struct PendingViWrite
    {
        uint64_t readyCycle = 0;
        uint64_t sequence = 0;
        int32_t value = 0;
        uint8_t reg = 0;
        bool valid = false;
    };

    struct PendingAccWrite
    {
        uint64_t readyCycle = 0;
        uint64_t sequence = 0;
        std::array<float, 4> value{};
        uint8_t laneMask = 0;
        bool valid = false;
    };

    struct XgkickPipeline
    {
        static constexpr uint32_t kBufferSize = 0x10000u;
        std::array<uint8_t, kBufferSize> packet{};
        uint32_t sourceAddress = 0;
        uint32_t totalBytes = 0;
        uint32_t copiedBytes = 0;
        uint32_t currentTagEnd = 0;
        uint32_t cycleCredit = 0;
        uint64_t issueCycle = 0;
        bool active = false;
        bool currentTagEop = false;
        // Reset the bookkeeping without touching the 64 KB packet buffer: every byte of it is
        // written (copied from VU memory) before it is read, and `m_xgkick = {}` zeroed the
        // whole buffer on every XGKICK and every program start (~24% of the game thread).
        void clear()
        {
            sourceAddress = 0;
            totalBytes = 0;
            copiedBytes = 0;
            currentTagEnd = 0;
            cycleCredit = 0;
            issueCycle = 0;
            active = false;
            currentTagEop = false;
        }
    };

    static constexpr uint32_t kFmacLatency = 4u;
    static constexpr uint32_t kAccForwardLatency = 1u;
    static constexpr uint32_t kMaxFlagEntries = 64u; // the generated code commits lazily (every 16 pushes / at readers)
    static constexpr uint32_t kMaxPendingStores = 8u;
    static constexpr uint32_t kMaxPendingVfWrites = 16u;
    static constexpr uint32_t kMaxPendingViWrites = 8u;
    static constexpr uint32_t kMaxPendingAccWrites = 8u;
    static constexpr uint32_t kMaxDecodedPairs = 0x4000u / 8u;

    Unit m_unit;
    VU1State m_state;
    std::array<DecodedInstructionPair, kMaxDecodedPairs> m_decodedCodeCache{};
    const uint8_t *m_cachedVuCode = nullptr;
    const PS2Memory *m_cachedMemory = nullptr;
    uint32_t m_cachedCodeSize = 0;
    uint64_t m_cachedCodeGeneration = 0;
    bool m_decodedCodeCacheValid = false;

    std::array<FlagPipelineEntry, kMaxFlagEntries> m_flagPipeline{};
    ScalarPipelineEntry m_fdiv{};
    std::array<ScalarPipelineEntry, 2> m_efu{};
    std::array<PendingStore, kMaxPendingStores> m_storePipeline{};
    std::array<PendingVfWrite, kMaxPendingVfWrites> m_vfWritePipeline{};
    std::array<PendingViWrite, kMaxPendingViWrites> m_viWritePipeline{};
    std::array<PendingAccWrite, kMaxPendingAccWrites> m_accWritePipeline{};
    XgkickPipeline m_xgkick{};
    std::array<std::array<uint64_t, 4>, 32> m_vfReady{};
    std::array<uint64_t, 16> m_viReady{};
    std::array<uint64_t, 4> m_accReady{};
    std::array<std::array<uint64_t, 4>, 32> m_vfLatestWrite{};
    std::array<uint64_t, 16> m_viLatestWrite{};
    std::array<uint64_t, 4> m_accLatestWrite{};

    uint64_t m_cycle = 0;
    uint64_t m_nextWriteSequence = 0;
    uint64_t m_efuResourceReady = 0;
    uint32_t m_workingClip = 0;
    uint32_t m_currentUpperInstruction = 0;
    int32_t m_viBranchBackupValue = 0;
    uint8_t m_viBranchBackupReg = 0;
    bool m_viBranchBackupValid = false;
    uint8_t *m_activeVuData = nullptr;
    uint32_t m_activeVuDataSize = 0;
    GS *m_activeGs = nullptr;
    PS2Memory *m_activeMemory = nullptr;
    bool m_stopRequested = false;
    bool m_programPending = false; // set by run(): budget stop before the E bit
    void runToEnd(uint8_t *vuCode, uint32_t codeSize, uint8_t *vuData, uint32_t dataSize, GS &gs, PS2Memory *memory);
    bool m_pendingHaltD = false;
    bool m_pendingHaltT = false;

    void run(uint8_t *vuCode, uint32_t codeSize,
             uint8_t *vuData, uint32_t dataSize,
             GS &gs, PS2Memory *memory, uint32_t maxCycles);

    InstructionUsage decodeUpperUsage(uint32_t upper) const;
    InstructionUsage decodeLowerUsage(uint32_t lower) const;
    static void addVfRead(InstructionUsage &usage, uint8_t reg, uint8_t lanes);
    static void addVfWrite(InstructionUsage &usage, uint8_t reg, uint8_t lanes);
    static uint8_t vfReadLanes(const InstructionUsage &usage, uint8_t reg);
    DecodedInstructionPair decodeInstructionPair(const uint8_t *vuCode, uint32_t pc) const;
    const DecodedInstructionPair &getDecodedInstructionPairForPc(const uint8_t *vuCode, uint32_t codeSize, PS2Memory *memory, uint32_t pc);
    // Scratch slot for pairs that are not served from the decoded-code cache (odd pc, foreign code).
    DecodedInstructionPair m_uncachedDecoded{};
    // Earliest readyCycle of any queued pipeline entry (UINT64_MAX when none): commitReadyPipelines()
    // returns immediately before that cycle instead of scanning every queue on every instruction.
    uint64_t m_nextReadyCycle = ~0ull;
    uint32_t m_lastMacPc = 0;       // issuePc of the entry that last committed MAC flags (flag trace)
    // Fast path (PS2X_VU1_FAST, default on): no per-cycle scheduler. VF/VI/ACC writes and stores land
    // immediately (every VF write has the same latency and reads stall on the register anyway), the
    // cycle counter still advances by the modeled stalls so MAC/STATUS/CLIP flags, Q and P become
    // visible exactly when the cycle-exact path shows them (4-deep flag ring in issue order, Q/P by
    // their latencies). Verified packet-for-packet and register-for-register against the exact path
    // with vu1_replay --batch (see docs/STATUS.md 2026-09-09).
    bool m_fast = false;
    // Known-program table: VU1 microcode images recompiled to host code (vu1_replay --gen ->
    // src/lib/vu/generated). Keyed by the FNV-1a hash of the 16 KB code memory, rehashed only when
    // the VIF MPG generation counter changes. PS2X_VU1_GEN=0 disables the generated code.
    uint64_t m_knownGeneration = ~0ull;
    KnownProgramFn m_knownFn = nullptr;
    uint64_t m_knownHash = 0;
    // Native programs (src/lib/vu/native), keyed by (image hash, entry pc) and selected by
    // PS2X_VU1_NATIVE. m_nativeTable is the test override; nullptr = the built-in table.
    const Vu1NativeProgram *m_nativeTable = nullptr;
    uint32_t m_nativeCount = 0;
    KnownProgramFn m_nativeFn = nullptr; // resolved for (m_knownHash, entry pc) on each run
    uint32_t m_fastFlagHead = 0;    // m_flagPipeline used as a ring in issue order
    uint32_t m_fastFlagCount = 0;
    uint64_t m_fastPairs = 0;       // executed pairs, folded into g_vuInsnCount at the end of a run
    void runFast(uint8_t *vuCode, uint32_t codeSize, uint8_t *vuData, uint32_t dataSize,
                 GS &gs, PS2Memory *memory, uint64_t budgetEnd, bool &programEnded);
    void fastCommit();
    // fastCommit with the flag ring's drain fixed (ps2_vu1_core.cpp, its invariants block): Batch =
    // false lands entry by entry (the old path), true folds the ready run in locals and writes the
    // state, head and count once. fastCommit picks one by PS2X_VU1_COMMIT_BATCH (read once).
    template <bool Batch>
    void fastCommitWith();
    static bool fastCommitBatchKnob();
    void fastFlush();
    __attribute__((always_inline)) uint64_t fastReadyCycle(const DecodedInstructionPair &decoded) const;
    void fastPushOverflow();
    // Fast path flag ring push (issue order; entries commit in fastCommit when ready).
    void fastPushFlags(const FlagPipelineEntry &entry)
    {
        if (m_fastFlagCount >= kMaxFlagEntries)
        {
            fastPushOverflow();
            return;
        }
        const uint32_t slot = (m_fastFlagHead + m_fastFlagCount) % kMaxFlagEntries;
        m_flagPipeline[slot] = entry;
        ++m_fastFlagCount;
        noteQueued(entry.readyCycle);
    }
    // In-place variant for the FMAC flag entry (the hot push).
    __attribute__((always_inline)) void fastPushMacFlags(uint32_t mac, uint32_t status, uint32_t extraSticky)
    {
        if (m_fastFlagCount >= kMaxFlagEntries)
        {
            fastPushOverflow();
            return;
        }
        FlagPipelineEntry &e = m_flagPipeline[(m_fastFlagHead + m_fastFlagCount) % kMaxFlagEntries];
        e.readyCycle = m_cycle + kFmacLatency;
        e.issueCycle = m_cycle;
        e.issuePc = m_state.pc;
        e.mac = mac;
        e.status = status;
        e.extraSticky = extraSticky;
        e.clip = 0u;
        e.valid = true;
        e.writesMac = true;
        e.writesStatus = true;
        e.writesSticky = false;
        e.writesClip = false;
        ++m_fastFlagCount;
        noteQueued(e.readyCycle);
    }
    void noteQueued(uint64_t readyCycle) { if (readyCycle < m_nextReadyCycle) m_nextReadyCycle = readyCycle; }
    // Latest cycle at which any operand (VF/VI/ACC/Q/P/EFU resource) becomes ready: once m_cycle reaches
    // it, calculatePairReadyCycle() cannot stall and skips the operand scan.
    uint64_t m_maxReadyCycle = 0;
    void noteReady(uint64_t readyCycle) { if (readyCycle > m_maxReadyCycle) m_maxReadyCycle = readyCycle; }
    void rebuildDecodedCodeCache(const uint8_t *vuCode, uint32_t codeSize, const PS2Memory *memory, uint64_t generation);

    void execUpper(uint32_t instr);
    void execLower(uint32_t instr, uint8_t *vuData, uint32_t dataSize, GS &gs, PS2Memory *memory, uint32_t upperInstr);

    static void applyDest(float *dst, const float *result, uint8_t dest)
    {
        alignas(16) static constexpr int32_t kDestLanes[16][4] = {
            {0, 0, 0, 0}, {0, 0, 0, -1}, {0, 0, -1, 0}, {0, 0, -1, -1},
            {0, -1, 0, 0}, {0, -1, 0, -1}, {0, -1, -1, 0}, {0, -1, -1, -1},
            {-1, 0, 0, 0}, {-1, 0, 0, -1}, {-1, 0, -1, 0}, {-1, 0, -1, -1},
            {-1, -1, 0, 0}, {-1, -1, 0, -1}, {-1, -1, -1, 0}, {-1, -1, -1, -1}};
        const __m128i mask = _mm_load_si128(reinterpret_cast<const __m128i *>(kDestLanes[dest & 0xFu]));
        const __m128i old = _mm_loadu_si128(reinterpret_cast<const __m128i *>(dst));
        const __m128i value = _mm_loadu_si128(reinterpret_cast<const __m128i *>(result));
        _mm_storeu_si128(reinterpret_cast<__m128i *>(dst), _mm_or_si128(_mm_andnot_si128(mask, old), _mm_and_si128(mask, value)));
    }
    void applyDestAcc(const float *result, uint8_t dest);
    void applyFmacDest(float *dst, float *result, uint8_t dest);
    void applyFmacDestAcc(float *result, uint8_t dest);
    void normalizeFmacResult(float *result, uint8_t dest, uint8_t laneFlags[4]);
    bool calculateFmacExactResult(uint32_t component, long double &result) const;
    uint8_t normalizeFmacExactResult(float &value, long double exactResult) const;
    uint32_t calculateFmacProductSticky(uint8_t dest) const;
    void updateFmacFlags(const uint8_t laneFlags[4], uint8_t dest, uint32_t extraSticky);
    void pushFmacFlagsExact(uint32_t mac, uint32_t status, uint32_t extraSticky);
    __attribute__((always_inline)) void pushFmacFlags(uint32_t mac, uint32_t status, uint32_t extraSticky)
    {
        if (!m_fast)
        {
            pushFmacFlagsExact(mac, status, extraSticky);
            return;
        }
        fastPushMacFlags(mac, status, extraSticky);
    }
    void checkFmac(uint32_t instr, uint8_t kind, bool opmul, __m128 first, __m128 second, __m128 value,
                   uint32_t mac, uint32_t status, uint32_t sticky);
    void queueFsset(uint16_t immediate);
    void queueClip(uint32_t clip);
    void queueFcset(uint32_t clip);
    void queueQ(float value, uint32_t latency, uint32_t statusDi);
    void queueP(float value, uint32_t latency);
    void queueStore(uint32_t address, const uint32_t words[4], uint8_t laneMask);
    void queueVfWrite(uint8_t reg, uint8_t laneMask, const float value[4], uint32_t latency);
    void queueViWrite(uint8_t reg, int32_t value, uint32_t latency);
    void queueAccWrite(uint8_t laneMask, const float value[4], uint32_t latency);
    void startXgkick(uint32_t qwordAddress);

    void resetScheduler();
    void commitReadyPipelines();
    void advanceOneCycle();
    void advanceTo(uint64_t targetCycle);
    void flushPipelines();
    void progressXgkick();
    void dumpOverrunState();
    void finishXgkick();
    uint64_t calculatePairReadyCycle(const DecodedInstructionPair &decoded) const;
    void markPairWrites(const DecodedInstructionPair &decoded);
    bool pipelinesPending() const;

    // Operand normalization (denormals flush to +/-0, infinities and NaNs clamp to +/-FLT_MAX);
    // inline: every FMAC operand goes through it.
    static float normalizeOperand(float value)
    {
        uint32_t bits = 0;
        std::memcpy(&bits, &value, sizeof(bits));
        const uint32_t exponent = (bits >> 23) & 0xFFu;
        if (exponent == 0u)
            bits &= 0x80000000u;
        else if (exponent == 0xFFu)
            bits = (bits & 0x80000000u) | 0x7F7FFFFFu;
        std::memcpy(&value, &bits, sizeof(value));
        return value;
    }
    float normalizeResult(float value, uint32_t &laneFlags) const;
    uint32_t microAddressMask() const { return m_unit == Unit::VU1 ? 0x3FFFu : 0x0FFFu; }
    int32_t readBranchVi(uint8_t reg) const;
    void recordViWriteForBranch(uint8_t reg, int32_t oldValue);
    void reportReservedInstruction(bool upper, uint32_t instruction);
    float broadcast(const float *vf, uint8_t bc);
};

// Selected when the 16 KB code image hashes to `hash` and the program is entered at `entryPc`.
// Same contract as KnownProgramFn: true = ended (E bit reached); false = hand back to the
// microcode at m_state.pc with every live register set as the microcode would have them.
// execute() resets the scheduler before the native call, but resume() (MSCNT) does not: a
// program registered at a mid-program entry pc that hands back must expect in-flight FMAC
// results to commit after it returns. Entry pcs that are program starts (0, 0x1b50) are safe.
struct Vu1NativeProgram
{
    uint64_t hash;
    uint32_t entryPc;
    VU1Interpreter::KnownProgramFn fn;
};

#endif
