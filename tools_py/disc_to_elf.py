"""From your own SOCOM II disc to a buildable ELF -- the one command (Sprint 10, 2026-09-21).

    bash scripts/disc_to_elf.sh "<path to your SOCOM II ISO>" [--out game]
    python -m tools_py.disc_to_elf "<path to your SOCOM II ISO>" [--out game]

`./build.sh recomp` starts from four files this repository does not and must not contain: the
extracted disc tree (`game/disc/`, and `game/disc/SCUS_972.75` in particular) and the two plaintext
overlays merged into one image (`game/overlays/{ftscore.bin,zsealetc.bin,socom2_game.elf}`). Until
today the sequence that produces them existed only as three research scripts and a memory of the
order they were run in, once, on the maintainer's machine (`CONTRIBUTING.md` said so). This module is
that sequence, in four stages, each of which

  * is skipped when its output is already on disk and already right (so a second run is a no-op that
    still verifies -- re-run it as often as you like, and after an interrupted run);
  * checks its output against `tools_py/disc_to_elf_expected.json`, the recorded sizes, sha256 digests
    and addresses of the r0001 disc -- facts *about* the disc, not its content;
  * refuses with an exit code out of `ps2x/exit_codes.h` where one fits, and always with a sentence
    you can act on.

The stages, with what each cost on the machine they were measured on (2026-09-21, an NVMe SSD;
483 s all told, of which the third stage is 473):

  1. extract    the ISO9660 filesystem to `<out>/disc/`                4173 MB, 8 s at 554 MB/s
                (minutes on a slower disk -- it writes 4.1 GB)
  2. dnas       `OVERLAY/REL/DNAS.BIN` -> `DNAS.dec.bin`               2 s, 131 code blocks
                (`dnas_selfdecrypt.py`: the DNAS overlay's self-encrypting code blocks, run
                 through their own cipher under Unicorn)
  3. overlays   `RUN/RAW/APACHE00.ZDB` -> `<out>/overlays/*.bin`       473 s
                (`decrypt_apache.py`: the retail loader's own decryption code under Unicorn)
  4. elf        the loader + the two overlays -> `socom2_game.elf`     instant
                (`make_overlay_elf.py`, exactly as `build.sh recomp` calls it)

Stages 2 and 3 emulate R5900 code, so they need Unicorn (`pip install -r requirements.txt`, whose
unicorn row is 2.1.4) and they are slow -- their chatter goes to `<out>/disc_to_elf-<stage>.log`
rather than your terminal. Everything else is plain Python; no 7z, no external extractor.

Nothing here writes inside the ISO or needs it after stage 1, and nothing writes outside `--out`.
"""
import argparse
import contextlib
import hashlib
import json
import os
import struct
import sys
import time

from tools_py import exit_codes
from tools_py import iso_lbn

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPECTED_PATH = os.path.join(ROOT, "tools_py", "disc_to_elf_expected.json")
SECTOR = iso_lbn.SECTOR
STAGES = ("extract", "dnas", "overlays", "elf")

# The three files on the disc this chain reads, by their path in the extracted tree.
SCUS = "SCUS_972.75"
DNAS_BIN = os.path.join("OVERLAY", "REL", "DNAS.BIN")
DNAS_DEC = os.path.join("OVERLAY", "REL", "DNAS.dec.bin")
DNAS_JSON = os.path.join("OVERLAY", "REL", "DNAS.blocks.json")
APACHE = os.path.join("RUN", "RAW", "APACHE00.ZDB")

# Exit codes. The shared taxonomy (third_party/ps2recomp/ps2xShared/include/ps2x/exit_codes.h, read
# by tools_py/exit_codes.py so no number is copied) covers three of the five ways this can refuse:
# 66 "the disc image was not found", 67 "that image is not r0001", 68 "the game's program image (.elf) is
# missing or damaged". The other two have no row there and are given the generic ones with a sentence of their
# own: 2 for "your machine is missing something" (the shape build.sh uses for a missing toolchain)
# and 1 for "a step's output is not what the disc should produce".
EXIT_OK = 0
EXIT_ENVIRONMENT = 2
EXIT_MISMATCH = exit_codes.code("Failed")              # 1
EXIT_DISC_NOT_FOUND = exit_codes.code("DiscNotFound")  # 66
EXIT_DISC_NOT_R0001 = exit_codes.code("DiscNotR0001")  # 67
EXIT_ELF_BAD = exit_codes.code("ElfMissing")           # 68


def say(line):
    """print, flushed. These stages take minutes; a stranger who redirects this to a file or a pipe
    would otherwise see nothing at all until the buffer filled."""
    print(line, flush=True)


class Refusal(Exception):
    """A refusal with an exit code and a sentence a stranger can act on."""

    def __init__(self, code, sentence):
        super().__init__(sentence)
        self.code = code
        self.sentence = sentence


# ---- the expectations file ---------------------------------------------------------------------

def load_expected(path=EXPECTED_PATH):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def save_expected(data, path=EXPECTED_PATH):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, sort_keys=False)
        fh.write("\n")


def check_value(expected, section, key, got, what, code=EXIT_MISMATCH, log=say):
    """Compare one measured value with the recorded one. A value that is not recorded yet (null, or
    a section this file has never seen) is recorded and said so -- which is how the first run on a
    disc nobody has run this on writes the file. A recorded value that disagrees is a refusal: the
    bytes on your disc are not the bytes this chain was built from, and going on would be a guess."""
    slot = expected.setdefault(section, {})
    was = slot.get(key)
    if was is None:
        slot[key] = got
        log(f"  recorded {section}.{key} = {got!r} (nothing was recorded for it)")
        return True
    if was != got:
        raise Refusal(code, f"{what}: expected {was!r}, got {got!r}. "
                            f"tools_py/disc_to_elf_expected.json records what the r0001 disc produces; "
                            f"yours produced something else, so the result would not be the game. "
                            f"If you believe your disc is right and the record is wrong, say so in an "
                            f"issue with both values -- do not edit the record to make this pass.")
    return False


# ---- hashing ----------------------------------------------------------------------------------

def sha256_file(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            block = fh.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def manifest_sha256(files):
    """One digest over the ISO's directory records: "<path> <size> <lbn>" a line, in sorted order.
    It says "the same image, laid out the same way" in 64 characters, and costs no reading."""
    h = hashlib.sha256()
    for lbn, size, name in sorted(files, key=lambda f: f[2]):
        h.update(f"{name} {size} {lbn}\n".encode("utf-8"))
    return h.hexdigest()


# ---- stage 1: the ISO9660 reader ---------------------------------------------------------------

def read_pvd(fh):
    """(volume_id, volume_sectors, root_extent, root_size) from the primary volume descriptor."""
    fh.seek(16 * SECTOR)
    pvd = fh.read(SECTOR)
    if len(pvd) < SECTOR or pvd[1:6] != b"CD001":
        raise Refusal(EXIT_DISC_NOT_R0001,
                      "that file is not an ISO9660 disc image (no CD001 at sector 16). Point this at "
                      "the .iso you dumped from your SOCOM II disc, not at a .bin/.cue, a .zip or a folder.")
    block = struct.unpack_from("<H", pvd, 128)[0]
    if block != SECTOR:
        raise Refusal(EXIT_DISC_NOT_R0001,
                      f"that image says its logical block is {block} bytes; a PlayStation 2 disc's is 2048. "
                      "Re-dump the disc as a plain ISO9660 image.")
    volume_id = pvd[40:72].decode("ascii", "replace").strip()
    volume_sectors = struct.unpack_from("<I", pvd, 80)[0]
    root = pvd[156:190]
    return volume_id, volume_sectors, struct.unpack_from("<I", root, 2)[0], struct.unpack_from("<I", root, 10)[0]


def read_tree(iso_path):
    """([(lbn, size, "/PATH/NAME")], volume_id, volume_sectors) -- every file in the image.

    The directory-record walk is `iso_lbn.parse_dir`, which the CD-read annotator has used all
    sprint; this adds the volume descriptor, the truncation checks and a closed file handle."""
    if not os.path.isfile(iso_path):
        raise Refusal(EXIT_DISC_NOT_FOUND,
                      f"no file at {iso_path}. Pass the path to your own SOCOM II ISO "
                      "(quote it -- the usual name has spaces in it).")
    image_bytes = os.path.getsize(iso_path)
    with open(iso_path, "rb") as fh:
        volume_id, volume_sectors, root_extent, root_size = read_pvd(fh)
        if image_bytes < volume_sectors * SECTOR:
            short = volume_sectors * SECTOR - image_bytes
            raise Refusal(EXIT_MISMATCH,
                          f"that image is truncated: its own volume descriptor says "
                          f"{volume_sectors * SECTOR} bytes and the file is {image_bytes} "
                          f"({short} bytes short). Copy or dump it again -- a partial image would "
                          "silently produce a partial disc tree.")
        files = []
        try:
            iso_lbn.parse_dir(fh, root_extent, root_size, "", files)
        except (struct.error, UnicodeDecodeError, IndexError, RecursionError) as exc:
            raise Refusal(EXIT_MISMATCH,
                          f"that image's directory records do not parse as ISO9660 ({exc.__class__.__name__}: {exc}). "
                          "If it came out of a compressed format (.cso, .chd, .gz), convert it to a plain "
                          "ISO first.")
    files.sort()
    for lbn, size, name in files:
        end = (lbn + (size + SECTOR - 1) // SECTOR) * SECTOR
        if end > image_bytes:
            raise Refusal(EXIT_MISMATCH,
                          f"that image is truncated: {name} needs bytes up to {end} and the file ends at "
                          f"{image_bytes}. Copy or dump it again.")
    if not files:
        raise Refusal(EXIT_DISC_NOT_R0001, "that image holds no files at all. Re-dump the disc.")
    return files, volume_id, volume_sectors


def extract(iso_path, files, dest, log=say, force=False):
    """Write every file in `files` under `dest`. A file already there at exactly the right size is
    left alone, which is what makes a second run cheap: the bytes come from the image by LBN, so
    size is the only thing that can differ short of a damaged filesystem."""
    os.makedirs(dest, exist_ok=True)
    total = sum(size for _, size, _ in files)
    written = kept = done_bytes = 0
    next_mark = 0.1
    started = time.time()
    with open(iso_path, "rb") as fh:
        for lbn, size, name in files:
            out = os.path.join(dest, *name.strip("/").split("/"))
            done_bytes += size
            if not force and os.path.isfile(out) and os.path.getsize(out) == size:
                kept += 1
                continue
            os.makedirs(os.path.dirname(out), exist_ok=True)
            fh.seek(lbn * SECTOR)
            left = size
            with open(out + ".part", "wb") as dst:
                while left > 0:
                    block = fh.read(min(left, 1 << 22))
                    if not block:
                        raise Refusal(EXIT_MISMATCH,
                                      f"the image ended while reading {name} ({left} bytes short). "
                                      "It is truncated or damaged; copy or dump it again.")
                    dst.write(block)
                    left -= len(block)
            os.replace(out + ".part", out)
            written += 1
            if total and done_bytes / total >= next_mark:
                rate = done_bytes / max(time.time() - started, 0.001) / (1 << 20)
                log(f"  {done_bytes * 100 // total}% ({done_bytes >> 20} of {total >> 20} MB, {rate:.0f} MB/s)")
                while total and done_bytes / total >= next_mark:
                    next_mark += 0.1
    return written, kept, total


def stage_extract(iso_path, disc, expected, log=say, force=False):
    files, volume_id, volume_sectors = read_tree(iso_path)
    log(f"extract: {os.path.basename(iso_path)}: volume {volume_id!r}, {len(files)} files, "
        f"{sum(s for _, s, _ in files) >> 20} MB")
    # The revision gate is SCUS_972.75's digest, the same one the launcher and the runner's preflight
    # pin (launcher::kSocom2R0001ElfSha256). It is checked against the bytes in the image before
    # 4 GB is written: a stranger with the wrong disc waits seconds, not minutes.
    entry = next((f for f in files if f[2] == "/" + SCUS), None)
    if entry is None:
        raise Refusal(EXIT_DISC_NOT_R0001,
                      f"that image has no {SCUS} in its root directory, so it is not SOCOM II NTSC "
                      f"(SCUS-97275). This build plays only the r0001 disc.")
    want = expected.get("inputs", {}).get(SCUS, {})
    with open(iso_path, "rb") as fh:
        fh.seek(entry[0] * SECTOR)
        boot = fh.read(entry[1])
    got = sha256_bytes(boot)
    if want.get("sha256") and got != want["sha256"]:
        raise Refusal(EXIT_DISC_NOT_R0001,
                      f"that image's {SCUS} is not the r0001 one (sha256 {got[:16]}..., wanted "
                      f"{want['sha256'][:16]}...). This build plays only SOCOM II NTSC r0001 "
                      f"(SCUS-97275); the launcher's DISC page says the same thing about an image you give it.")
    log(f"extract: {SCUS} is the r0001 boot ELF (sha256 {got[:16]}...)")
    # The image's shape -- how many files, laid out where, in how many sectors -- is recorded, but a
    # difference here is a NOTE and not a refusal (R231): a re-built or differently padded image of
    # the same disc carries the same bytes at other LBNs, and the three files this chain actually
    # reads are each pinned by digest (the boot ELF just above, the other two in check_input).
    notes = []
    for key, got in (("manifest_sha256", manifest_sha256(files)),
                     ("files", len(files)),
                     ("volume_sectors", volume_sectors)):
        slot = expected.setdefault("disc", {})
        if slot.get(key) is None:
            slot[key] = got
            log(f"  recorded disc.{key} = {got!r} (nothing was recorded for it)")
        elif slot[key] != got:
            notes.append(f"disc.{key}: recorded {slot[key]!r}, yours is {got!r}")
    if notes:
        log("extract: NOTE your image is laid out differently from the recorded one -- "
            + "; ".join(notes))
        log("extract: NOTE that is allowed. The files this chain reads are checked by their digests, "
            "so a different layout of the same bytes still builds the same game.")
    written, kept, total = extract(iso_path, files, disc, log=log, force=force)
    log(f"extract: {written} files written, {kept} already there ({total >> 20} MB in the tree)")
    return files


# ---- the two Unicorn stages -------------------------------------------------------------------

def _import_emulator(name):
    """Import one of the two research scripts, turning a missing Unicorn into a sentence."""
    try:
        __import__("unicorn")
    except ImportError:
        raise Refusal(EXIT_ENVIRONMENT,
                      "this step runs the game's own decryption code on an emulated R5900 and needs "
                      "Unicorn: pip install unicorn  (2.1.4 is what it was measured with). Nothing has "
                      "been written; re-run this command afterwards and it picks up where it stopped.")
    import importlib
    return importlib.import_module("tools_py." + name)


@contextlib.contextmanager
def _quiet(path, log=say):
    """Both emulation stages print thousands of progress lines. They go to a log beside the output."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    log(f"  (chatter -> {os.path.relpath(path, ROOT) if path.startswith(ROOT) else path})")
    with open(path, "w", encoding="utf-8", errors="replace") as fh:
        with contextlib.redirect_stdout(fh):
            yield fh


def check_input(disc, rel, expected, log=say):
    path = os.path.join(disc, rel)
    key = rel.replace(os.sep, "/")
    if not os.path.isfile(path):
        raise Refusal(EXIT_DISC_NOT_R0001,
                      f"{key} is not in the extracted tree at {disc}. Delete the tree and run this "
                      "command again; if it is still missing, your image is not the r0001 disc.")
    check_value(expected, "inputs", key, {"size": os.path.getsize(path), "sha256": sha256_file(path)},
                f"{key} on your disc", code=EXIT_DISC_NOT_R0001, log=log)
    return path


def stage_dnas(disc, out_dir, expected, log=say, force=False):
    """DNAS.BIN -> DNAS.dec.bin: the DNAS overlay's self-encrypting code blocks, statically undone."""
    src = check_input(disc, DNAS_BIN, expected, log=log)
    dest = os.path.join(disc, DNAS_DEC)
    want = expected.get("dnas", {}).get("output") or {}
    if not force and os.path.isfile(dest) and want.get("sha256") and sha256_file(dest) == want["sha256"]:
        log("dnas: DNAS.dec.bin is already there and matches -- skipped")
        return dest
    variants = {int(k, 16): {"keytab": int(v["keytab"], 16), "core": int(v["core"], 16)}
                for k, v in expected["dnas"]["variants"].items()}
    module = _import_emulator("dnas_selfdecrypt")
    with open(src, "rb") as fh:
        data = fh.read()
    started = time.time()
    log("dnas: decrypting the DNAS overlay's code blocks under Unicorn (a few seconds)")
    with _quiet(os.path.join(out_dir, "disc_to_elf-dnas.log"), log=log):
        plain, meta = module.decrypt(data, variants)
    check_value(expected, "dnas", "blocks", len(meta), "the number of encrypted DNAS code blocks", log=log)
    with open(dest + ".part", "wb") as fh:
        fh.write(plain)
    os.replace(dest + ".part", dest)
    with open(os.path.join(disc, DNAS_JSON), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=1)
    check_value(expected, "dnas", "output", {"size": len(plain), "sha256": sha256_bytes(plain)},
                "the decrypted DNAS overlay", log=log)
    log(f"dnas: {len(meta)} blocks, {len(plain)} bytes -> {DNAS_DEC} ({time.time() - started:.0f}s)")
    return dest


def stage_overlays(disc, overlays, expected, log=say, force=False):
    """APACHE00.ZDB -> ftscore.bin + zsealetc.bin, by running the retail loader's own decryption."""
    check_input(disc, APACHE, expected, log=log)
    names = ("ftscore.bin", "zsealetc.bin")
    want = expected.get("overlays", {})
    if not force and all(os.path.isfile(os.path.join(overlays, n)) and want.get(n, {}).get("sha256")
                         and sha256_file(os.path.join(overlays, n)) == want[n]["sha256"] for n in names):
        log("overlays: ftscore.bin and zsealetc.bin are already there and match -- skipped")
        return [os.path.join(overlays, n) for n in names]
    module = _import_emulator("decrypt_apache")
    blobs = module.zdb_entries(os.path.join(disc, APACHE))
    sizes = {k: len(v) for k, v in blobs.items()}
    check_value(expected, "zdb", "entries", sizes, "the code package APACHE00.ZDB holds",
                code=EXIT_DISC_NOT_R0001, log=log)
    os.makedirs(overlays, exist_ok=True)
    started = time.time()
    log("overlays: running the loader's decryption under Unicorn (about eight minutes; four "
        "emulated passes over two blobs)")
    with _quiet(os.path.join(overlays, "disc_to_elf-overlays.log"), log=log):
        module.main(game=disc, out=overlays)
    for name in names:
        path = os.path.join(overlays, name)
        if not os.path.isfile(path):
            raise Refusal(EXIT_MISMATCH,
                          f"the decryption finished without writing {name}. The end of "
                          f"{os.path.join(overlays, 'disc_to_elf-overlays.log')} says which step stopped.")
        check_value(expected, "overlays", name, {"size": os.path.getsize(path), "sha256": sha256_file(path)},
                    f"the decrypted {name}", log=log)
    build_id = expected["elf"]["build_id"].encode("ascii")
    with open(os.path.join(overlays, "ftscore.bin"), "rb") as fh:
        if build_id not in fh.read():
            raise Refusal(EXIT_MISMATCH,
                          f"the decrypted ftscore.bin does not carry the build id "
                          f"{expected['elf']['build_id']!r}. It decrypted to something, but not to this game.")
    log(f"overlays: ftscore.bin + zsealetc.bin written, build id {expected['elf']['build_id']!r} "
        f"({time.time() - started:.0f}s)")
    return [os.path.join(overlays, n) for n in names]


# ---- stage 4: the merged ELF ------------------------------------------------------------------

def elf_facts(path):
    """(entry point, segment count, the whole image) out of the merged ELF."""
    with open(path, "rb") as fh:
        head = fh.read(0x34)
        if head[:4] != b"\x7fELF":
            raise Refusal(EXIT_ELF_BAD, f"{path} is not an ELF file. Delete it and run this command again.")
        entry = struct.unpack_from("<I", head, 0x18)[0]
        phnum = struct.unpack_from("<H", head, 0x2c)[0]
        fh.seek(0)
        body = fh.read()
    return entry, phnum, body


def stage_elf(disc, overlays, expected, log=say, force=False):
    want = expected.get("elf", {})
    dest = os.path.join(overlays, "socom2_game.elf")
    if not force and os.path.isfile(dest) and want.get("sha256") and sha256_file(dest) == want["sha256"]:
        log("elf: socom2_game.elf is already there and matches -- skipped")
        return dest
    from tools_py import make_overlay_elf
    with open(os.path.join(ROOT, "recomp", "loader_text_end.txt"), "r", encoding="utf-8") as fh:
        loader_text_end = int(fh.read().strip(), 16)
    started = time.time()
    log(f"elf: merging the loader and the two overlays (loader text ends at {loader_text_end:#x})")
    with _quiet(os.path.join(overlays, "disc_to_elf-elf.log"), log=log):
        # No capsule write stack is passed here and none exists for r0001, so the overlay repair
        # (tools_py/overlay_repair.py) cannot rewrite a byte on this path. The check below is the
        # belt on those braces: if it ever did, the player would otherwise meet it as an unrelated
        # sha256 refusal with advice ("delete game/overlays and try again") that cannot help.
        repairs = make_overlay_elf.build(dest, os.path.join(disc, SCUS),
                                         [os.path.join(overlays, "ftscore.bin"), os.path.join(overlays, "zsealetc.bin")],
                                         loader_text_end)
    if repairs:
        raise Refusal(EXIT_ELF_BAD,
                      "the overlay repair rewrote "
                      + ", ".join(f"{r.address:#010x} ({r.before:#010x} -> {r.after:#010x})" for r in repairs)
                      + " while merging the r0001 image, which is supposed to need no repair at all. "
                        "This is a bug in tools_py/overlay_repair.py, not something to work around.")
    entry, phnum, body = elf_facts(dest)
    check_value(expected, "elf", "entry", f"{entry:#x}", "the merged ELF's entry point",
                code=EXIT_ELF_BAD, log=log)
    check_value(expected, "elf", "segments", phnum, "the merged ELF's segment count",
                code=EXIT_ELF_BAD, log=log)
    if expected["elf"]["build_id"].encode("ascii") not in body:
        raise Refusal(EXIT_ELF_BAD,
                      f"the merged ELF does not carry the build id {expected['elf']['build_id']!r}. "
                      "Delete game/overlays and run this command again.")
    check_value(expected, "elf", "size", len(body), "the merged ELF's size", code=EXIT_ELF_BAD, log=log)
    check_value(expected, "elf", "sha256", sha256_bytes(body), "the merged ELF's sha256",
                code=EXIT_ELF_BAD, log=log)
    log(f"elf: {os.path.relpath(dest, ROOT) if dest.startswith(ROOT) else dest}: {len(body)} bytes, "
        f"{phnum} segments, entry {entry:#x}, build id {expected['elf']['build_id']!r} "
        f"({time.time() - started:.1f}s)")
    return dest


# ---- the command ------------------------------------------------------------------------------

def state(out_dir, expected):
    """What is on disk already: [(stage, ok, what)] -- the body of --check."""
    disc = os.path.join(out_dir, "disc")
    overlays = os.path.join(out_dir, "overlays")
    rows = []
    boot = os.path.join(disc, SCUS)
    rows.append(("extract", os.path.isfile(boot), os.path.join(disc, SCUS)))
    for stage, path, want in (("dnas", os.path.join(disc, DNAS_DEC), expected.get("dnas", {}).get("output") or {}),
                              ("overlays", os.path.join(overlays, "ftscore.bin"),
                               expected.get("overlays", {}).get("ftscore.bin") or {}),
                              ("overlays", os.path.join(overlays, "zsealetc.bin"),
                               expected.get("overlays", {}).get("zsealetc.bin") or {}),
                              ("elf", os.path.join(overlays, "socom2_game.elf"), expected.get("elf", {}))):
        ok = os.path.isfile(path) and bool(want.get("sha256")) and sha256_file(path) == want["sha256"]
        rows.append((stage, ok, path))
    return rows


def run(iso_path, out_dir, expected, log=say, force=False, stages=STAGES, record_path=None):
    """The four stages in order. Returns the path of the merged ELF."""
    disc = os.path.join(out_dir, "disc")
    overlays = os.path.join(out_dir, "overlays")
    before = json.dumps(expected, sort_keys=True)
    started = time.time()
    try:
        if "extract" in stages:
            stage_extract(iso_path, disc, expected, log=log, force=force)
        elif not os.path.isfile(os.path.join(disc, SCUS)):
            raise Refusal(EXIT_DISC_NOT_FOUND, f"{os.path.join(disc, SCUS)} is not there and --stages "
                                               "left the extract stage out.")
        if "dnas" in stages:
            stage_dnas(disc, out_dir, expected, log=log, force=force)
        if "overlays" in stages:
            stage_overlays(disc, overlays, expected, log=log, force=force)
        elf = os.path.join(overlays, "socom2_game.elf")
        if "elf" in stages:
            elf = stage_elf(disc, overlays, expected, log=log, force=force)
    finally:
        if record_path and json.dumps(expected, sort_keys=True) != before:
            save_expected(expected, record_path)
            log(f"recorded new values in {os.path.relpath(record_path, ROOT)} -- commit it, and say in the "
                "commit message which disc they came from.")
    log(f"done in {time.time() - started:.0f}s. Next: ./build.sh recomp  (then ./build.sh runtime)")
    return elf


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="python -m tools_py.disc_to_elf",
        description="Your own SOCOM II r0001 ISO -> the extracted disc tree and the overlays "
                    "./build.sh recomp needs. Idempotent: re-run it freely.")
    parser.add_argument("iso", nargs="?", help="path to your SOCOM II ISO (quote it: the name has spaces)")
    parser.add_argument("--out", default=os.path.join(ROOT, "game"),
                        help="where the disc tree and the overlays go (default: game/ beside build.sh); "
                             "it holds about 4.2 GB when this is done")
    parser.add_argument("--force", action="store_true", help="redo every stage even if its output is already right")
    parser.add_argument("--stages", default=",".join(STAGES),
                        help="a comma-separated subset of " + ",".join(STAGES) + " (for debugging one step)")
    parser.add_argument("--check", action="store_true",
                        help="say which stages are already done for --out and exit 0 iff all of them are")
    parser.add_argument("--expected", default=EXPECTED_PATH, help="the expectations file to verify against")
    parser.add_argument("--no-record", action="store_true",
                        help="refuse instead of recording a value the expectations file does not hold yet")
    args = parser.parse_args(argv)

    expected = load_expected(args.expected)
    out_dir = os.path.abspath(args.out)
    if args.check:
        rows = state(out_dir, expected)
        for stage, ok, path in rows:
            print(f"disc_to_elf: {stage:9s} {'ok  ' if ok else 'todo'} {path}")
        return EXIT_OK if all(ok for _, ok, _ in rows) else 1
    if not args.iso:
        parser.error("the path to your ISO is required (or pass --check)")
    stages = tuple(s.strip() for s in args.stages.split(",") if s.strip())
    unknown = [s for s in stages if s not in STAGES]
    if unknown:
        print(f"disc_to_elf: no such stage: {', '.join(unknown)} (have: {', '.join(STAGES)})", file=sys.stderr)
        return EXIT_ENVIRONMENT
    try:
        run(os.path.abspath(args.iso), out_dir, expected, force=args.force, stages=stages,
            record_path=None if args.no_record else args.expected)
    except Refusal as refusal:
        print(f"disc_to_elf: {refusal.sentence}", file=sys.stderr)
        return refusal.code
    except KeyboardInterrupt:
        print("disc_to_elf: stopped. Nothing is half-written; run the same command again to go on.",
              file=sys.stderr)
        return EXIT_ENVIRONMENT
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
