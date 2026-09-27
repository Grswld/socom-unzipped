#pragma once
// Issue #74: the launcher's body face, measured the way raylib's MeasureTextEx measures it, for the tests that hold
// a line to the width it is drawn in. Its own translation unit so raylib.h stays out of launcher_tests.cpp.
#include <string>
#include <vector>

namespace font_advances
{
    // Rajdhani Medium (the launcher's Face::Body) rasterised at `pixels`, as fonts.cpp loads it: the advance of
    // each of the 95 printable ASCII codepoints (32..126), in pixels. Empty if the file would not load.
    std::vector<int> rajdhaniMedium(int pixels);

    // The width MeasureTextEx gives `s` at the size the advances were loaded at (spacing 0): their sum. -1 for a
    // character outside 32..126, which the table cannot measure.
    int widthOf(const std::vector<int> &advances, const std::string &s);
}
