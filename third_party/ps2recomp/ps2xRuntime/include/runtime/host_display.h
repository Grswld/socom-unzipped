#pragma once
// The macOS port: how many displays a window could open on right now (host_display.cpp).

namespace ps2x_host
{
    // Darwin: the online displays that are not asleep -- the ones GLFW's Cocoa monitor scan keeps. -1 elsewhere
    // (unknown: nothing is asked, and the window opens as it always did).
    int awakeDisplayCount();
}
