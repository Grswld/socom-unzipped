#!/usr/bin/env python3
"""Build the landing site's game-derived assets from this repository: the disc tree under game/disc/ and the HUDUI
audio fixtures under tests/fixtures/audio/ (SOCOM_PC=<path> points at another checkout).

  python web/landing/tools/build-assets.py            # everything (npm run assets -w landing)
  python web/landing/tools/build-assets.py sfx logo   # a subset: video | sfx | logo

Outputs -- all git-ignored, never committed (they are the game's, rendered from your own disc):
  web/landing/public/media/menuloop.mp4    MENULOOP.PSS video (deinterlaced, H.264) + its PCM music (AAC)
  web/landing/public/sfx/*.ogg             HUDUI bank sounds (dink = select, thunk/slide = move)
  web/landing/public/img/logo.webp         the SOCOM II UNZIPPED logo: web/landing/art/logo-unzipped.jpg, matted
                                           (the build copies docs/story/img/logo.webp instead; this re-cuts it)
  web/landing/public/img/intel.jpg         the About screen's intel photo, from a local parity golden
tools/prepare.mjs runs the sfx step when the sounds are missing and says what is missing otherwise.
Needs ffmpeg on PATH and Python 3 with Pillow + numpy (logo only).
"""
import os, struct, subprocess, sys, tempfile

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # web/landing
ROOT = os.path.dirname(os.path.dirname(APP))  # the repository (socom_pc)
SOCOM = os.environ.get("SOCOM_PC", ROOT)
PSS = os.path.join(SOCOM, "game", "disc", "RUN", "MOVIES", "COMMON", "MENULOOP.PSS")
GOLDEN = os.path.join(SOCOM, "logs", "parity", "golden", "s07_CROSS.png")
PUB = os.path.join(APP, "public")


def run(*args):
    print("+", " ".join(args)); subprocess.run(args, check=True)


def demux_pcm(pss_path, out_path):
    """Concatenate the PSS private-stream-1 payloads (SShd/SSbd, 48 kHz stereo s16 in 512-byte L/R
    blocks) and write sample-interleaved s16le. Returns (rate, channels, seconds)."""
    d = open(pss_path, "rb").read()
    i, n, payload = 0, len(d), bytearray()
    while i < n - 6:
        if d[i] == 0 and d[i + 1] == 0 and d[i + 2] == 1:
            sid = d[i + 3]
            if sid == 0xBA: i += 14; continue
            if sid == 0xB9: break
            ln = struct.unpack_from(">H", d, i + 4)[0]
            if sid == 0xBD:
                hl = d[i + 8]; p = i + 9 + hl
                payload += d[p + 4:i + 6 + ln]   # skip the 4-byte substream header
            i += 6 + ln; continue
        i += 1
    assert payload[:4] == b"SShd", "no SShd audio header in the PSS"
    rate, interleave, chans = struct.unpack_from("<III", payload, 12 - 4)[0], struct.unpack_from("<I", payload, 20)[0], struct.unpack_from("<I", payload, 16)[0]
    rate = struct.unpack_from("<I", payload, 12)[0]
    j = payload.find(b"SSbd"); size = struct.unpack_from("<I", payload, j + 4)[0]
    pcm = payload[j + 8:j + 8 + size]
    blk = interleave
    out = bytearray()
    for k in range(0, len(pcm) - 2 * blk + 1, 2 * blk):
        L, R = pcm[k:k + blk], pcm[k + blk:k + 2 * blk]
        for s in range(0, blk, 2):
            out += L[s:s + 2]; out += R[s:s + 2]
    open(out_path, "wb").write(out)
    return rate, chans, len(out) / (2 * chans * rate)


def build_video():
    os.makedirs(os.path.join(PUB, "media"), exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        raw = os.path.join(td, "music.raw")
        rate, chans, secs = demux_pcm(PSS, raw)
        print(f"music: {rate} Hz x{chans}, {secs:.1f} s")
        run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", PSS, "-f", "s16le", "-ar", str(rate), "-ac", str(chans), "-i", raw,
            "-map", "0:v:0", "-map", "1:a:0",
            "-vf", "bwdif=mode=0:parity=0,setsar=1", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest",
            os.path.join(PUB, "media", "menuloop.mp4"))


def build_sfx():
    os.makedirs(os.path.join(PUB, "sfx"), exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        env = dict(os.environ, S2U_FIXTURES=os.path.join(SOCOM, "tests", "fixtures", "audio"))
        subprocess.run([sys.executable, os.path.join(APP, "tools", "render_hudui.py"), td], check=True, env=env)
        for f in sorted(os.listdir(td)):
            if f.endswith(".wav"):
                name = f.split("_", 1)[1][:-4]
                run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", os.path.join(td, f),
                    "-c:a", "libvorbis", "-q:a", "6", os.path.join(PUB, "sfx", name + ".ogg"))


ART_LOGO = os.path.join(APP, "art", "logo-unzipped.jpg")
# The artwork is a whole 4:3 title frame (1200x896). The logo sits at x 102-1091, y 197-711; the menu shows a
# 640x280 band, so the band is cut as 1394x610 around the logo: rows 149-759, the full width centred on the canvas.
ART_BAND_TOP, ART_BAND_W, ART_BAND_H = 149, 1394, 610   # 92%: 22 px of air above and below in the 280 px band


def matte_logo(rgb):
    """Alpha for the SOCOM II UNZIPPED artwork (the owner's). Its own
    background is the menu's dark brown with the rig silhouettes; only the brown that is CONNECTED TO THE EDGE of
    the picture is background, so the brown inside the artwork (crevices in the gold, shadows on the plate, the
    letters' counters) stays and nothing turns into a hole. The teal burst has no edge of its own and fades by its
    own blueness. Pillow and numpy only."""
    from PIL import Image, ImageDraw, ImageFilter
    import numpy as np
    a = rgb.astype(float)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    lum = a.max(2)
    brown = (r < 95) & (b < 0.42 * r + 7) & (g <= r + 2)
    # Seal before flooding: the letters fade to black at the foot inside a thin gold outline, and a JPEG leaves
    # pinholes in that outline. Eroding the brown mask closes them; the flood is grown back by as much afterwards.
    m = Image.fromarray((brown * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(5))
    pad = Image.new("L", (m.width + 2, m.height + 2), 255)
    pad.paste(m, (1, 1))
    ImageDraw.floodfill(pad, (0, 0), 128)
    outside = np.asarray(pad.crop((1, 1, m.width + 1, m.height + 1))) == 128
    grown = Image.fromarray((outside * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5))
    outside = (np.asarray(grown) > 0) & brown
    solid = Image.fromarray(((~outside) * 255).astype(np.uint8))
    hard = np.asarray(solid.filter(ImageFilter.GaussianBlur(1.4))).astype(float) / 255.0
    # The teal burst has no edge of its own, so it fades by its own blueness -- but ONLY the burst: pixels that are
    # clearly teal (blue well over red) and lie near the background. The first version faded every dim pixel with
    # b > r, which speckled the letters' black feet and the grey plate with partial opacity (owner, 2026-09-19).
    teal = np.clip((b - 0.42 * r - 8) / 60.0, 0, 1)
    near_bg = np.asarray(Image.fromarray((outside * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(41))) > 0
    burst = (b - r > 22) & (g - r > 12) & (lum < 120) & near_bg
    alpha = np.where(burst, np.minimum(hard, teal), hard)
    # The burst's own dark halo (near-black, not brown, so the flood keeps it) would sit on the video as a hard
    # black blot. Between the letters' feet and the plate, dark non-grey pixels near the background fade by their
    # brightness instead. Rows are the band's: the letters end at 225, the plate's rim starts near 372 at its ends.
    rows = np.arange(alpha.shape[0])[:, None]
    chroma = a.max(2) - a.min(2)
    halo = near_bg & (lum < 75) & ~((chroma < 14) & (lum > 38)) & (rows > 228) & (rows < 372) & ~burst
    alpha = np.where(halo, np.minimum(alpha, np.clip((lum - 22) / 45.0, 0, 1)), alpha)
    # specks of JPEG noise the flood left standing alone: an opening removes anything under ~7 px across
    keep = Image.fromarray(((alpha > 0.5) * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(7)).filter(ImageFilter.MaxFilter(11))
    alpha = alpha * (np.asarray(keep.filter(ImageFilter.GaussianBlur(1.5))).astype(float) / 255.0)
    # Everything above can only take alpha away, and under SOC the burst is thin wisps of teal with brown between
    # them: the flood keyed out the brown, the halo rule dimmed the wisps and the opening deleted what was left as
    # specks (owner, 2026-09-20: "spliced out some of the blue around the top left"). Teal-ness is a soft matte of
    # the burst on its own and is nil outside the artwork, so it is the floor of the alpha, not just a ceiling.
    alpha = np.maximum(alpha, teal)
    alpha = np.where(rows > 572, 0.0, alpha)   # nothing of the logo is below the zipper's pull
    return np.clip(alpha, 0, 1)


def build_logo():
    """The menu's logo: the owner's SOCOM II UNZIPPED artwork, matted off its background and composited normally
    over the video (it replaced the crop of the game's own title, which needed mix-blend-mode: screen)."""
    from PIL import Image
    import numpy as np
    os.makedirs(os.path.join(PUB, "img"), exist_ok=True)
    src = Image.open(ART_LOGO).convert("RGB")
    band = src.crop((0, ART_BAND_TOP, src.width, ART_BAND_TOP + ART_BAND_H))
    rgb = np.asarray(band)
    alpha = matte_logo(rgb)
    # the frame's own edges are not the logo's: fade the last few columns and rows so no cut line can show
    h, w = alpha.shape
    cols = np.minimum(np.arange(w), w - 1 - np.arange(w))
    alpha = alpha * np.clip(cols / 24.0, 0, 1)[None, :]
    keyed = Image.fromarray(np.dstack([rgb, (alpha * 255).astype(np.uint8)]), "RGBA")
    out = Image.new("RGBA", (ART_BAND_W, ART_BAND_H), (0, 0, 0, 0))
    out.paste(keyed, ((ART_BAND_W - keyed.width) // 2, 0))
    # Two outputs. The full-resolution matte stays beside the source as the reference. What the page serves is
    # brought down to the console's own resolution on purpose (owner, 2026-09-19): at 3x it looked too clean next
    # to a 640x448 MPEG-2 movie. 640x280 is the band's native size; the browser scales it up with the stage, a
    # touch of blur takes the resampler's crispness off, and the page adds its scanlines on top.
    out.save(os.path.join(APP, "art", "logo-unzipped-keyed.webp"), "WEBP", quality=92, method=6)
    from PIL import ImageFilter
    small = out.resize((640, 280), Image.LANCZOS).filter(ImageFilter.GaussianBlur(0.35))
    small.save(os.path.join(PUB, "img", "logo.webp"), "WEBP", quality=88, method=6)
    # Briefing-screen "intel" photo for the About page: an in-mission capture from the parity goldens.
    intel = os.path.join(SOCOM, "logs", "parity", "golden_mission", "final.png")
    Image.open(intel).convert("RGB").resize((640, 480)).crop((40, 60, 600, 420)).save(
        os.path.join(PUB, "img", "intel.jpg"), quality=82)


if __name__ == "__main__":
    steps = sys.argv[1:] or ["video", "sfx", "logo"]
    for s in steps:
        {"video": build_video, "sfx": build_sfx, "logo": build_logo}[s]()
    print("done")
