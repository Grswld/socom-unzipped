"""The merged chain's running marker: which tree a live chain pins (Sprint 17 G1).

scripts/parity/merged_chain.sh proves ONE commit of the tree it runs in, and after every step it goes red on a tracked
file changed under it (`git status`, looked at first) or on HEAD moved. Sprint 16 lost five chains that way to peers
editing and committing in the chain's tree (docs/audits/2026-09-28-multi-session-collisions.md sections 3.1 and 5).
So the chain writes `logs/.merged_chain.running` in its own tree right after it fixes HEAD0 -- one `key=value` per
line: `pid` (the chain's bash; its WINDOWS pid under Git Bash, from /proc/$$/winpid, so an in-process check can find
it), `start` (epoch seconds at the write), `head` (HEAD0), `stamp`, `root`, `held` (LOOP_LOCK_HELD) -- and removes it
in an EXIT trap (a red, a green, and a TERM/HUP/INT all run it; dry runs and refusals never write it). A hard kill
(`taskkill /F`, SIGKILL) leaves it behind, which is why it is judged, never trusted.

THE CHAIN'S TREE: a tree whose `logs/.merged_chain.running` names a pid that is alive now and was created no later
than the marker's `start` (plus a 5 s slack) -- a pid created after the write is a reused pid, not the chain. The
lock's state is not part of it (a chain always holds the lock, but a HELD lock says nothing about which tree).
Liveness is judged IN-PROCESS -- OpenProcess/GetExitCodeProcess/GetProcessTimes through ctypes on Windows,
os.kill(pid, 0) and /proc/<pid>/stat elsewhere -- never by starting a child: at the memory floor children fail
(0xC0000142), and the guards must still answer. Every doubt is "not running": a marker that cannot be read, has no
pid, or names a dead pid; a process we may not open (ACCESS_DENIED -- the chain's bash is our own user's, so that is a
service that reused a hard-killed chain's pid) or whose creation time cannot be read; a probe that raises. Nothing
here ever deletes the marker; every refusal names it and says when deleting it by hand is right (STALE_HINT). A pid
reused by a process of our own user is created after the marker, so the start check rejects it.

Readers: tools_py/hooks/precommit.py (no commit in the chain's tree) and tools_py/hooks/pretool.py (no Edit/Write of a
tracked file in it). `python -m tools_py.hooks.chainmark [<tree>]` prints `running pid=<p> stamp=<s>` (exit 0) or
`not running` (exit 1) for the tree holding <tree> (default the current directory).
"""
import os
import sys

MARKER = ("logs", ".merged_chain.running")
SLACK = 5                                                 # seconds between the chain's start and its marker's write


def marker_path(root):
    return os.path.join(root, *MARKER)


def read(root):
    """The marker's fields as a dict (`pid` and `start` as ints when they parse), or None when there is none."""
    try:
        with open(marker_path(root), encoding="utf-8", errors="replace") as f:
            text = f.read(4096)
    except OSError:
        return None
    rec = {}
    for line in text.splitlines():
        key, sep, value = line.partition("=")
        if sep:
            rec[key.strip()] = value.strip()
    for key in ("pid", "start"):
        rec[key] = int(rec[key]) if rec.get(key, "").isdigit() else None
    return rec


STILL_ACTIVE = 259


def windows_verdict(opened, error, exit_code, created, start):
    """Whether a Windows process is the chain, from what the probe could learn: `opened` (OpenProcess succeeded),
    `error` (its last error when not), `exit_code` (GetExitCodeProcess, None when unread), `created` (epoch seconds
    from GetProcessTimes, None when unread). Every doubt is NOT alive: the chain's bash runs as our own user and always
    opens and reads, so ACCESS_DENIED (a service that reused the pid of a hard-killed chain: 163 of 438 processes on
    the host answer it) or unreadable times must not pin the tree until a reboot (the G1 review's blocking finding)."""
    if not opened or exit_code != STILL_ACTIVE:
        return False
    if start is None:
        return True
    return created is not None and created <= start + SLACK


def _windows_api(pid):
    """(opened, error, exit_code, created) of `pid` through kernel32 -- in-process, no child."""
    import ctypes
    from ctypes import wintypes
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    k32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
    k32.GetProcessTimes.argtypes = (wintypes.HANDLE,) + (ctypes.POINTER(wintypes.FILETIME),) * 4
    k32.CloseHandle.argtypes = (wintypes.HANDLE,)
    handle = k32.OpenProcess(0x1000, False, pid)          # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False, ctypes.get_last_error(), None, None
    try:
        code = wintypes.DWORD()
        exit_code = code.value if k32.GetExitCodeProcess(handle, ctypes.byref(code)) else None
        times = [wintypes.FILETIME() for _ in range(4)]
        created = None
        if k32.GetProcessTimes(handle, *[ctypes.byref(t) for t in times]):
            ticks = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
            created = (ticks - 116444736000000000) / 1e7  # FILETIME (100 ns since 1601) -> epoch seconds
        return True, 0, exit_code, created
    finally:
        k32.CloseHandle(handle)


def _alive_windows(pid, start, api=None):
    return windows_verdict(*(api or _windows_api)(pid), start)


def _alive_posix(pid, start):
    try:
        os.kill(pid, 0)
    except OSError:                                       # gone, or another user's (the chain's bash is ours):
        return False                                      # not the chain, as windows_verdict judges it
    if start is None:
        return True
    try:                                                  # Linux: the process's start, from boot time + ticks
        with open("/proc/%d/stat" % pid) as f:
            ticks = int(f.read().rsplit(")", 1)[1].split()[19])
        with open("/proc/stat") as f:
            btime = next(int(l.split()[1]) for l in f if l.startswith("btime "))
        return btime + ticks / os.sysconf("SC_CLK_TCK") <= start + SLACK
    except (OSError, ValueError, IndexError, StopIteration):
        return True                                       # no /proc: alive is all that can be said


def pid_alive(pid, start=None):
    """True when `pid` names a live process created no later than `start` + SLACK (when start is given)."""
    if not pid or pid <= 0:
        return False
    try:
        return _alive_windows(pid, start) if os.name == "nt" else _alive_posix(pid, start)
    except Exception:
        return False


def running(root, alive=None):
    """The marker of `root` when it names a live chain (see the module docstring), else None."""
    rec = read(root)
    if not rec or not rec.get("pid"):
        return None
    try:
        live = (alive or pid_alive)(rec["pid"], rec.get("start"))
    except Exception:                                     # a probe that cannot answer pins nothing
        return None
    return rec if live else None


# What every refusal says after the reason: where the marker is, and when deleting it by hand is right.
STALE_HINT = "marker logs/.merged_chain.running; delete it if no chain runs (`bash scripts/loop_lock.sh check` FREE)"


def tree_root(path):
    """The working tree holding `path`: the nearest directory at or above it with a `.git` entry (a directory in
    the main tree, a file in a linked worktree). Found by stat alone, no git; None outside any tree."""
    d = os.path.abspath(path)
    if not os.path.isdir(d):
        d = os.path.dirname(d)
    while True:
        if os.path.exists(os.path.join(d, ".git")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def main(argv=None):
    argv = sys.argv if argv is None else argv
    root = tree_root(argv[1] if len(argv) > 1 else os.getcwd())
    mark = running(root) if root else None
    if mark:
        print("running pid=%s stamp=%s" % (mark["pid"], mark.get("stamp", "")))
        return 0
    print("not running")
    return 1


if __name__ == "__main__":
    sys.exit(main())
