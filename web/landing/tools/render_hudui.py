#!/usr/bin/env python3
"""Render SOCOM II HUDUI 989snd bank sounds to 48 kHz stereo 16-bit WAV.

A line-for-line port of the runtime's snd989::Mixer (ps2xRuntime/src/lib/snd989_mixer.cpp),
socom2_bank::parse and ps2_vag::decodeBlocks, as documented in docs/research/32-audio-path.md
sections 1 and 3. Plays each sound exactly as snd_PlaySoundVolPanPMPB(bank, sound, 0x400, -1, 0, 0)
would: note 60 / fine 0, pitchMod 0, pitchBend 0, the sound's own pan, master volumes at 0x400.
"""
import math
import os
import struct
import sys
import wave

FIXTURES = os.environ.get("S2U_FIXTURES") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "tests", "fixtures", "audio")
OUT_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
SAMPLE_RATE = 48000
TICK_HZ = 240.0
MAX_SECONDS = 20.0   # safety cap for a sustain phase that never reaches zero

# 7 is the briefing typewriter: the pre-mission screen plays it once per character as the text types in
# (890 plays in one gate mission stage, logs/parity/gate/*/mission.game.log: 989snd
# snd_PlaySoundVolPanPMPBNoReturn [HUDUI, 7, 0x400, ...]). A 62 ms tick, quiet by design (sound vol 44).
# 8, tried first, is a different cue: the two-click blip fired when a menu panel appears.
SOUNDS = {0: "dink", 1: "back", 2: "thunk", 3: "slide", 4: "neg", 7: "type"}


def cdiv(a, b):
    """C integer division (truncate toward zero)."""
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b >= 0) else -q


def s8(b):
    return b - 256 if b >= 128 else b


# ---------------------------------------------------------------- bank (socom2_bank::parse)
GT_TONE, GT_TONE2 = 1, 9
GT_LOOP_START, GT_LOOP_END, GT_LOOP_CONTINUE, GT_STOP = 21, 22, 23, 24
GT_RAND_DELAY, GT_RAND_PB, GT_PB, GT_ADD_PB = 26, 27, 28, 29
GT_KEY_OFF_VOICES, GT_KILL_VOICES = 41, 42


def parse_bank(blk):
    assert blk[0:4] == b"SBlk" and struct.unpack_from("<I", blk, 4)[0] == 3
    num_sounds, num_grains = struct.unpack_from("<hh", blk, 0x16)
    first_sound, first_grain = struct.unpack_from("<II", blk, 0x1C)
    grain_data, block_names = struct.unpack_from("<II", blk, 0x34)
    pool_end = block_names if grain_data < block_names <= len(blk) else len(blk)
    pool = blk[grain_data:pool_end]
    name = blk[block_names:block_names + 16].split(b"\0")[0].decode("ascii", "replace")
    sounds = []
    for i in range(num_sounds):
        p = first_sound + i * 12
        vol, grp, pan, ng, lim, flags, first_sfx = struct.unpack_from("<bbhbbHi", blk, p)
        grains = []
        if ng > 0 and first_sfx >= 0:
            for g in range(ng):
                q = first_grain + first_sfx + g * 8
                opcode, delay = struct.unpack_from("<Ii", blk, q)
                grains.append({"type": opcode >> 24, "arg": opcode & 0xFFFFFF, "delay": delay})
        sounds.append({"vol": vol, "group": grp, "pan": pan, "limit": lim, "flags": flags, "grains": grains})
    return {"name": name, "sounds": sounds, "pool": pool}


def tone_of(bank, grain):
    if grain["type"] not in (GT_TONE, GT_TONE2):
        return None
    p = grain["arg"]
    pool = bank["pool"]
    if p + 24 > len(pool):
        return None
    prio, vol, cnote, cfine, pan, mlo, mhi, pblo, pbhi, adsr1, adsr2, flags, soff = \
        struct.unpack_from("<bbbbhbbbbHHHI", pool, p)
    return {"priority": prio, "vol": vol, "centerNote": cnote, "centerFine": cfine, "pan": pan,
            "pbLow": pblo, "pbHigh": pbhi, "adsr1": adsr1, "adsr2": adsr2, "flags": flags, "sampleOffset": soff}


# ---------------------------------------------------------------- VAG (ps2_vag::decodeBlocks)
def decode_blocks(data, start):
    pcm = []
    s1 = s2 = 0
    loops = False
    loop_start = 0
    consumed = 0
    off = start
    while off + 16 <= len(data):
        block = data[off:off + 16]
        shift = block[0] & 0x0F
        if shift > 12:
            shift = 9
        filt = (block[0] >> 4) & 0x07
        if filt > 4:
            filt = 0
        flags = block[1]
        if flags & 0x04:
            loop_start = len(pcm)
        for i in range(28):
            byte = block[2 + i // 2]
            nib = (byte >> 4) if (i & 1) else (byte & 0x0F)
            raw = nib - 16 if nib & 8 else nib
            shifted = raw << (12 - shift)
            old, older = s1, s2
            if filt == 1:
                f = shifted + cdiv(60 * old + 32, 64)
            elif filt == 2:
                f = shifted + cdiv(115 * old - 52 * older + 32, 64)
            elif filt == 3:
                f = shifted + cdiv(98 * old - 55 * older + 32, 64)
            elif filt == 4:
                f = shifted + cdiv(122 * old - 60 * older + 32, 64)
            else:
                f = shifted
            v = max(-32768, min(32767, f))
            s2, s1 = s1, v
            pcm.append(v)
        consumed = off + 16 - start
        if flags & 0x01:
            loops = (flags & 0x02) != 0
            break
        off += 16
    return {"pcm": pcm, "loops": loops, "loopStart": loop_start, "bytes": consumed}


# ---------------------------------------------------------------- pitch (sceSdNote2Pitch / note2Pitch)
NOTE_TABLE = [int(round(32768.0 * 2 ** (i / 12.0))) for i in range(12)] + \
             [int(round(32768.0 * 2 ** (i / 1536.0))) for i in range(128)]


def sce_sd_note2pitch(center_note, center_fine, note, fine):
    _fine = fine + center_fine          # centerFine already 0..255 (uint8)
    _fine2 = _fine
    if _fine < 0:
        _fine2 = _fine + 127
    _fine2 = cdiv(_fine2, 128)
    _note = note + _fine2 - center_note
    val3 = cdiv(_note, 6)
    if _note < 0:
        val3 -= 1
    offset2 = _fine - _fine2 * 128
    val2 = -1 if _note < 0 else 0
    if val3 < 0:
        val3 -= 1
    val2 = cdiv(val3, 2) - val2
    val = val2 - 2
    offset1 = _note - val2 * 12
    if offset1 < 0 or (offset1 == 0 and offset2 < 0):
        offset1 += 12
        val = val2 - 3
    off2 = offset2
    if off2 < 0:
        offset1 = (offset1 - 1) + _fine2
        off2 += (_fine2 + 1) * 128
    offset1 = max(0, min(11, offset1))
    off2 = max(0, min(127, off2))
    ret = (NOTE_TABLE[offset1] * NOTE_TABLE[off2 + 12]) // 0x10000
    if val < 0:
        ret = (ret + (1 << (-val - 1))) >> -val
    elif val > 0:
        ret <<= val
    return max(0, min(0xFFFF, ret))


def note2pitch(center_note, center_fine, note, fine):
    ps1 = center_note >= 0
    center = center_note if ps1 else -center_note
    pitch = sce_sd_note2pitch(center, center_fine & 0xFF, note, fine)
    if ps1:
        pitch = (44100 * pitch) // 48000
    return pitch


# ---------------------------------------------------------------- volume (MakeVolume + pan table)
PAN_TABLE = [(int(round(0x3FFF * math.cos((i / 180.0) * (math.pi / 2)))),
              int(round(0x3FFF * math.sin((i / 180.0) * (math.pi / 2))))) for i in range(181)]


def make_volume(vol1, pan1, vol2, pan2, vol3, pan3):
    vol = vol1 * 258
    vol = cdiv(vol * vol2, 0x7F)
    vol = cdiv(vol * vol3, 0x7F)
    if vol <= 0:
        return 0, 0
    total = pan1 + pan3 + pan2
    while total >= 360:
        total -= 360
    while total < 0:
        total += 360
    total = total - 270 if total >= 270 else total + 90
    if total < 180:
        l, r = PAN_TABLE[total]
        return cdiv(l * vol, 0x3FFF), cdiv(r * vol, 0x3FFF)
    l, r = PAN_TABLE[total - 180]
    return cdiv(r * vol, 0x3FFF), cdiv(l * vol, 0x3FFF)


# ---------------------------------------------------------------- SPU ADSR envelope
ATTACK, DECAY, SUSTAIN, RELEASE, OFF = range(5)


class Envelope:
    def __init__(self, adsr1, adsr2):
        self.adsr1, self.adsr2 = adsr1, adsr2
        self.level = 0
        self.phase = ATTACK
        self.cycles = 0

    def key_off(self):
        if self.phase != OFF:
            self.phase = RELEASE
        self.cycles = 0

    def rate(self, shift, step_value, exponential, decrease):
        cyc = 1 << max(0, shift - 11)
        step = step_value * (1 << max(0, 11 - shift))
        if exponential and not decrease and self.level > 0x6000:
            cyc *= 4
        if exponential and decrease:
            step = cdiv(step * self.level, 0x8000)
        return step, cyc

    def tick(self):
        if self.phase == OFF:
            return False
        if self.cycles > 0:
            self.cycles -= 1
            return True
        a1, a2 = self.adsr1, self.adsr2
        cyc = 1
        if self.phase == ATTACK:
            shift = (a1 >> 10) & 0x1F
            step_value = 7 - ((a1 >> 8) & 3)
            step, cyc = self.rate(shift, step_value, (a1 & 0x8000) != 0, False)
            self.level += step
            if self.level >= 0x7FFF:
                self.level = 0x7FFF
                self.phase = DECAY
        elif self.phase == DECAY:
            shift = (a1 >> 4) & 0x0F
            step, cyc = self.rate(shift, -8, True, True)
            self.level += step
            sustain_level = ((a1 & 0x0F) + 1) * 0x800
            if self.level <= sustain_level:
                self.level = max(self.level, 0)
                self.phase = SUSTAIN
        elif self.phase == SUSTAIN:
            shift = (a2 >> 8) & 0x1F
            decrease = (a2 & 0x4000) != 0
            step_value = -(8 - ((a2 >> 6) & 3)) if decrease else 7 - ((a2 >> 6) & 3)
            step, cyc = self.rate(shift, step_value, (a2 & 0x8000) != 0, decrease)
            self.level = max(0, min(0x7FFF, self.level + step))
        elif self.phase == RELEASE:
            shift = a2 & 0x1F
            step, cyc = self.rate(shift, -8, (a2 & 0x20) != 0, True)
            self.level += step
            if self.level <= 0:
                self.level = 0
                self.phase = OFF
        self.cycles = max(0, cyc - 1)
        return self.phase != OFF


# ---------------------------------------------------------------- handler + voices (Mixer::Impl)
class Voice:
    def __init__(self, sample, step, base, adsr1, adsr2):
        self.sample = sample
        self.pos = 0.0
        self.step = step
        self.base = base
        self.env = Envelope(adsr1, adsr2)

    def gains(self):
        # group modifier = masterVol[group] * masterVol[16] / 0x400 = 0x400 (identity); then the SPU's >> 1
        return (cdiv(self.base[0] * 0x400, 0x400)) >> 1, (cdiv(self.base[1] * 0x400, 0x400)) >> 1


class Renderer:
    def __init__(self, bank, vag):
        self.bank, self.vag = bank, vag
        self.samples = {}
        self.log = []

    def sample(self, off):
        if off not in self.samples:
            self.samples[off] = decode_blocks(self.vag, off)
        return self.samples[off]

    def render(self, sound_idx, vol=0x400, pan=-1, pm=0, pb=0):
        snd = self.bank["sounds"][sound_idx]
        h = {"note": 60, "fine": 0, "pm": pm, "pb": pb, "nextGrain": 0, "done": False}
        play_vol = (snd["vol"] * max(0, min(0x400, vol))) >> 10
        h["vol"] = min(127, max(0, play_vol))
        h["pan"] = snd["pan"] if pan in (-1, -2) else pan
        voices = []

        def start_tone(tone):
            smp = self.sample(tone["sampleOffset"])
            if not smp["pcm"]:
                return
            v9 = (h["note"] << 7) + h["fine"] + h["pm"]
            if h["pb"] >= 0:
                v7 = cdiv(tone["pbHigh"] * (h["pb"] << 7), 0x7FFF) + v9
            else:
                v7 = cdiv(tone["pbLow"] * (h["pb"] << 7), 0x8000) + v9
            note, fine = cdiv(v7, 128), v7 - cdiv(v7, 128) * 128
            pitch = note2pitch(tone["centerNote"], tone["centerFine"], note, fine)
            base = make_volume(127, 0, h["vol"], h["pan"], tone["vol"], tone["pan"])
            v = Voice(smp, pitch / 4096.0, base, tone["adsr1"], tone["adsr2"])
            voices.append(v)
            self.log.append(
                f"    tone @0x{tone['sampleOffset']:05x}: {len(smp['pcm'])} samples ({smp['bytes'] // 16} blocks, "
                f"{'loop' if smp['loops'] else 'one-shot'}), center {tone['centerNote']}/{tone['centerFine']}, "
                f"pitch 0x{pitch:04x} ({pitch / 4096:.4f}x), toneVol {tone['vol']} pan {tone['pan']}, "
                f"L/R {base[0]}/{base[1]} (>>1: {v.gains()[0]}/{v.gains()[1]}), ADSR 0x{tone['adsr1']:04x}/0x{tone['adsr2']:04x}")

        def do_grain():
            grains = snd["grains"]
            if h["nextGrain"] >= len(grains):
                h["done"] = True
                return 0
            g = grains[h["nextGrain"]]
            t = g["type"]
            ret = 0
            if t in (GT_TONE, GT_TONE2):
                tone = tone_of(self.bank, g)
                if tone:
                    start_tone(tone)
            elif t == GT_RAND_DELAY:
                ret = 0   # rand() % amount: deterministic 0 here (documented as a guess)
                self.log.append(f"    RAND_DELAY {g['arg']} -> using 0 extra ticks")
            elif t == GT_PB:
                pbv = s8(g["arg"] & 0xFF)
                h["pb"] = cdiv(0x7FFF * pbv, 127) if pbv >= 0 else cdiv(-0x8000 * pbv, -128)
            elif t == GT_ADD_PB:
                pbv = s8(g["arg"] & 0xFF)
                h["pb"] = max(-32768, min(32767, h["pb"] + cdiv(0x7FFF * pbv, 127)))
            elif t == GT_RAND_PB:
                self.log.append("    RAND_PB: using pb 0 (deterministic)")
                h["pb"] = 0
            elif t == GT_LOOP_END:
                for i in range(h["nextGrain"] - 1, -1, -1):
                    if grains[i]["type"] == GT_LOOP_START:
                        h["nextGrain"] = i
                        break
            elif t == GT_LOOP_CONTINUE:
                for i in range(h["nextGrain"] + 1, len(grains)):
                    if grains[i]["type"] == GT_LOOP_END:
                        h["nextGrain"] = i
                        break
            elif t == GT_STOP:
                h["done"] = True
            elif t == GT_KEY_OFF_VOICES:
                for v in voices:
                    v.env.key_off()
            elif t == GT_KILL_VOICES:
                for v in voices:
                    v.env.phase = OFF
            else:
                self.log.append(f"    grain type {t} (arg 0x{g['arg']:06x}) not modelled, skipped")
            h["nextGrain"] += 1
            if h["nextGrain"] >= len(grains):
                h["done"] = True
            return ret

        def run_grains():
            guard = 0
            while h["countdown"] <= 0 and not h["done"] and guard < 256:
                guard += 1
                ret = do_grain()
                if not h["done"] and h["nextGrain"] < len(snd["grains"]):
                    h["countdown"] = snd["grains"][h["nextGrain"]]["delay"] + ret

        h["countdown"] = snd["grains"][0]["delay"]
        run_grains()

        # Render: per-tick chunks, exactly like Mixer::render with tickAccumulator starting at 0.
        frames_per_tick = SAMPLE_RATE / TICK_HZ
        tick_acc = 0.0
        out_l, out_r = [], []
        max_frames = int(MAX_SECONDS * SAMPLE_RATE)
        while len(out_l) < max_frames:
            alive = [v for v in voices if v.env.phase != OFF]
            if not alive and h["done"]:
                break
            chunk = max(1, math.ceil(frames_per_tick - tick_acc))
            base = len(out_l)
            out_l.extend([0] * chunk)
            out_r.extend([0] * chunk)
            for v in alive:
                left, right = v.gains()
                pcm = v.sample["pcm"]
                n = len(pcm)
                for i in range(chunk):
                    if not v.env.tick():
                        break
                    if int(v.pos) >= n:
                        if v.sample["loops"] and v.sample["loopStart"] < n:
                            v.pos = v.sample["loopStart"] + (v.pos - n)
                        else:
                            v.env.phase = OFF
                            break
                    i0 = int(v.pos)
                    i1 = min(i0 + 1, n - 1)
                    frac = v.pos - i0
                    s = pcm[i0] * (1.0 - frac) + pcm[i1] * frac
                    g = v.env.level / 32767.0 / 0x7FFE
                    out_l[base + i] += int(s * g * left)
                    out_r[base + i] += int(s * g * right)
                    v.pos += v.step
            tick_acc += chunk
            if tick_acc >= frames_per_tick:
                tick_acc -= frames_per_tick
                if not h["done"]:
                    h["countdown"] -= 1
                    run_grains()
        return out_l, out_r


def write_wav(path, l, r):
    n = len(l)
    data = bytearray(n * 4)
    for i in range(n):
        struct.pack_into("<hh", data, i * 4, max(-32768, min(32767, l[i])), max(-32768, min(32767, r[i])))
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(bytes(data))


def main():
    with open(os.path.join(FIXTURES, "hudui_block.bin"), "rb") as f:
        blk = f.read()
    with open(os.path.join(FIXTURES, "hudui_vag.bin"), "rb") as f:
        vag = f.read()
    bank = parse_bank(blk)
    print(f"bank {bank['name']}: {len(bank['sounds'])} sounds")

    # cross-checks against socom2_audio_tests.cpp
    s0 = decode_blocks(vag, 0x3940)
    assert s0["bytes"] == 2528 and len(s0["pcm"]) == 4424 and not s0["loops"], s0["bytes"]
    assert note2pitch(-60, 0, 60, 0) == 0x1000
    p0 = note2pitch(-58, 66, 60, 0)
    e0 = 4096.0 * 2 ** (((60 - 58) + 66 / 128.0) / 12.0)
    assert abs(p0 - e0) <= 1.5, (p0, e0)
    print("cross-checks OK (sound 0 sample: 158 blocks / 4424 samples; note2Pitch)")

    rnd = Renderer(bank, vag)
    for idx, name in SOUNDS.items():
        snd = bank["sounds"][idx]
        rnd.log = []
        print(f"\nsound {idx} {name.upper()}: vol {snd['vol']} group {snd['group']} pan {snd['pan']} "
              f"flags 0x{snd['flags']:x} grains {[(g['type'], g['delay']) for g in snd['grains']]}")
        l, r = rnd.render(idx)
        for line in rnd.log:
            print(line)
        peak = max(max(abs(x) for x in l), max(abs(x) for x in r))
        rms = math.sqrt(sum(x * x for x in l + r) / max(1, len(l) * 2))
        last = 0
        for i in range(len(l) - 1, -1, -1):
            if abs(l[i]) > 1 or abs(r[i]) > 1:
                last = i
                break
        fname = f"{idx:02d}_{name}.wav"
        write_wav(os.path.join(OUT_DIR, fname), l, r)
        db = 20 * math.log10(peak / 32768) if peak else -999
        print(f"  -> {fname}: {len(l)} frames = {len(l) / SAMPLE_RATE:.3f} s, audible to {last / SAMPLE_RATE:.3f} s, "
              f"peak {peak} ({db:.1f} dBFS), rms {rms:.0f}")


if __name__ == "__main__":
    main()
