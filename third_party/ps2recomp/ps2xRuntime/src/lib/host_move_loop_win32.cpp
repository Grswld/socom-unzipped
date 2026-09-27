// Issue #67 (Sprint 15 T2): the Win32 half of runtime/host_move_loop.h -- a window-procedure subclass that reports
// the modal move/size loop's two edges and forwards every message, those two included, to GLFW's own procedure.
#include "runtime/host_move_loop.h"

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

namespace ps2x_host
{
#ifdef _WIN32
    namespace
    {
        // One game window per process: the hook's state is the process's.
        WNDPROC g_previous = nullptr;
        MoveLoopCallback g_callback = nullptr;
        void *g_user = nullptr;
        bool g_inLoop = false;

        LRESULT CALLBACK moveLoopProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam)
        {
            if (message == WM_ENTERSIZEMOVE && !g_inLoop)
            {
                g_inLoop = true;
                g_callback(true, g_user);
            }
            else if (message == WM_EXITSIZEMOVE && g_inLoop)
            {
                g_inLoop = false;
                g_callback(false, g_user);
            }
            if (g_previous == nullptr)   // cannot happen after install returns; never lose a message if it did
                return DefWindowProcW(window, message, wParam, lParam);
            return CallWindowProcW(g_previous, window, message, wParam, lParam);
        }
    }
#endif

    bool installMoveLoopHook(void *windowHandle, MoveLoopCallback callback, void *user)
    {
#ifdef _WIN32
        HWND window = static_cast<HWND>(windowHandle);
        if (window == nullptr || callback == nullptr || g_previous != nullptr)
            return false;
        g_callback = callback;
        g_user = user;
        // GLFW creates its windows with CreateWindowExW, so the procedure is read and chained as Unicode.
        g_previous = reinterpret_cast<WNDPROC>(
            SetWindowLongPtrW(window, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(&moveLoopProc)));
        if (g_previous == nullptr)
        {
            g_callback = nullptr;
            g_user = nullptr;
            return false;
        }
        return true;
#else
        (void)windowHandle;
        (void)callback;
        (void)user;
        return false;
#endif
    }
}
