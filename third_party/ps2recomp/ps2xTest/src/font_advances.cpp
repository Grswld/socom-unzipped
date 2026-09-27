// Issue #74: see font_advances.h. PS2X_LAUNCHER_FONTS_DIR is the launcher's assets/fonts (ps2xTest/CMakeLists.txt).
#include "font_advances.h"

#include "raylib.h"

namespace font_advances
{
    std::vector<int> rajdhaniMedium(int pixels)
    {
        std::vector<int> out;
        int size = 0;
        unsigned char *data = LoadFileData(PS2X_LAUNCHER_FONTS_DIR "/Rajdhani-Medium.ttf", &size);
        if (data == nullptr)
            return out;
        // fonts.cpp: LoadFontFromMemory(".ttf", ..., pixels, nullptr, 0) -- the default 95 codepoints from 32.
        GlyphInfo *glyphs = LoadFontData(data, size, pixels, nullptr, 95, FONT_DEFAULT);
        if (glyphs != nullptr)
        {
            for (int i = 0; i < 95; ++i)
                out.push_back(glyphs[i].advanceX);
            UnloadFontData(glyphs, 95);
        }
        UnloadFileData(data);
        return out;
    }

    int widthOf(const std::vector<int> &advances, const std::string &s)
    {
        int w = 0;
        for (const char ch : s)
        {
            const int c = static_cast<unsigned char>(ch);
            if (c < 32 || c > 126 || advances.size() != 95u)
                return -1;
            w += advances[static_cast<size_t>(c - 32)];
        }
        return w;
    }
}
