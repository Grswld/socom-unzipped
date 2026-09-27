#include "ps2x/host_window.h"

#include "launcher/launcher_config.h"

namespace ps2x::host_window
{
    std::string title(const char *tag, const char *gameName, const std::string &elfName)
    {
        std::string out;
        if (tag != nullptr && *tag != '\0')
            out = std::string(tag) + " | ";
        // Issue #69: any revision's ELF is the game (the launcher's table names each), not only kSocom2Elf.
        if (launcher::gameRevisionForElfName(elfName) != nullptr)
            out += kSocom2Name;
        else if (gameName != nullptr && *gameName != '\0')
            out += gameName;
        else
            out += elfName;
        out += kTitleSuffix;
        return out;
    }
}
