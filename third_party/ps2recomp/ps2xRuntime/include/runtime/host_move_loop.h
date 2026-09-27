#pragma once
// Issue #67 (Sprint 15 T2): a title-bar drag or an edge resize puts the window's thread in the Win32 modal move loop
// (WM_ENTERSIZEMOVE to WM_EXITSIZEMOVE). That thread is the one that replays the GS command stream and presents, so
// for the length of the drag nothing replays; the guest's frame back-pressure waited on it and the guest clock stood
// still. The hook tells the runtime when the loop begins and ends so the back-pressure can stand aside
// (GsFrameBackpressure::setConsumerSuspended). windows.h and raylib.h do not share a translation unit, hence this
// small header and its Win32 half (host_move_loop_win32.cpp), as host_window_chrome.* do. Elsewhere it is a no-op:
// X11 and Wayland have no modal move loop of this kind.
namespace ps2x_host
{
    // Runs on the window's own thread, from its window procedure: true at WM_ENTERSIZEMOVE, false at WM_EXITSIZEMOVE.
    using MoveLoopCallback = void (*)(bool entering, void *user);

    // Subclasses the window (raylib's GetWindowHandle(), the GLFW HWND) once; every other message goes to the
    // procedure it had. False off Windows, for a null handle, or when a hook is already installed.
    bool installMoveLoopHook(void *windowHandle, MoveLoopCallback callback, void *user);
}
