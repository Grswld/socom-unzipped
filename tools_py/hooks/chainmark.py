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
(0xC0000142), and the guards must still answer. A marker that cannot be read, has no pid, or names a dead pid is not a
running chain, and nothing here ever deletes it.

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


def _alive_windows(pid, start):
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
        return ctypes.get_last_error() == 5               # ACCESS_DENIED: it exists, and is not ours to read
    try:
        code = wintypes.DWORD()
        if not k32.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value != 259:   # STILL_ACTIVE
            return False
        if start is None:
            return True
        times = [wintypes.FILETIME() for _ in range(4)]
        if not k32.GetProcessTimes(handle, *[ctypes.byref(t) for t in times]):
            return True
        ticks = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
        created = (ticks - 116444736000000000) / 1e7     # FILETIME (100 ns since 1601) -> epoch seconds
        return created <= start + SLACK
    finally:
        k32.CloseHandle(handle)


def _alive_posix(pid, start):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass                                              # it exists, owned by someone else
    except OSError:
        return False
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
    return rec if (alive or pid_alive)(rec["pid"], rec.get("start")) else None


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
