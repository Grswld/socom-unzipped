// Sprint 9 Goal 1: the exit-code taxonomy -- one table, shared by the runner and the launcher.
#include "MiniTest.h"
#include "ps2x/exit_codes.h"
#include "runtime/gs/gs_gl_caps.h"
#include "launcher/launcher_config.h"

#include <set>
#include <string>
#include <vector>

void register_exit_codes_tests()
{
    MiniTest::Case("ExitCodes", [](TestCase &tc)
    {
        tc.Run("every code is a byte outside the shell's range, appears once, and has a sentence that fits the line", [](TestCase &t)
        {
            std::set<int> codes;
            std::set<std::string> slugs;
            for (const ExitCodes::Entry &e : ExitCodes::kTable)
            {
                t.IsTrue(e.code >= 0 && e.code <= 255, std::string(e.name) + ": fits a byte");
                t.IsTrue(e.code < 126 || e.code > 165, std::string(e.name) + ": outside the shell's 126-165");
                t.IsTrue(codes.insert(e.code).second, std::string(e.name) + ": its code is used once");
                t.IsTrue(slugs.insert(e.slug).second, std::string(e.name) + ": its slug is used once");
                const std::string s = e.sentence;
                t.IsTrue(!s.empty() && s.size() <= 120, std::string(e.name) + ": a sentence of at most 120 characters");
                t.IsTrue(!s.empty() && s.back() == '.', std::string(e.name) + ": ends with a full stop");
                t.IsTrue(s.find('"') == std::string::npos, std::string(e.name) + ": no double quote (tools_py/exit_codes.py reads the table with a regex)");
            }
            // Thirteen since Sprint 11 Task 19 added 73, the revision guard's refusal, and 74,
            // the reboot LoadExecPS2 cannot carry out. (Sprint 13 V8 added 75 for a server name that does not
            // resolve and review round 1 took it out again: ruling S13-R9 makes that a notice.)
            t.Equals(ExitCodes::kTableSize, 13, "thirteen codes: 0, 1, 3, 65, Sprint 9 Goal 1's seven, 73 and 74");
        });

        tc.Run("the codes themselves: 65 kept, 66-74 added, GsGlCaps agrees with the table", [](TestCase &t)
        {
            t.Equals(ExitCodes::kOk, 0, "ok");
            t.Equals(ExitCodes::kFailed, 1, "the runner's unnamed failure, as it leaves today");
            t.Equals(ExitCodes::kAborted, 3, "abort() on the mingw CRT");
            t.Equals(ExitCodes::kNoUsableGl, 65, "Sprint 7's code keeps its number");
            t.Equals(GsGlCaps::kExitCode, ExitCodes::kNoUsableGl, "gs_gl_caps.h takes its number from the table");
            t.Equals(ExitCodes::kDiscNotFound, 66, "disc not found");
            t.Equals(ExitCodes::kDiscNotR0001, 67, "disc is not r0001");
            t.Equals(ExitCodes::kElfMissing, 68, "game ELF missing");
            t.Equals(ExitCodes::kConfigUnreadable, 69, "config unreadable");
            t.Equals(ExitCodes::kCrashed, 70, "crash");
            t.Equals(ExitCodes::kOutOfMemory, 71, "out of memory");
            t.Equals(ExitCodes::kCardDirUnwritable, 72, "memory-card directory unwritable");
            // Sprint 11 Task 19: the generated code and the overlay image name different pressings of the
            // game. Its own code, not 67's: the disc is beside the point, it is the ELF that disagrees.
            t.Equals(ExitCodes::kRevisionMismatch, 73, "the executable and the image are different revisions");
            // Sprint 11 Task 19: LoadExecPS2 is the game asking to restart itself, a decision it made;
            // this build cannot re-exec, and 3 ("stopped itself after an internal error") hid that.
            t.Equals(ExitCodes::kRebootRequested, 74, "the game asked for a reboot this build cannot carry out");
            t.IsNull(ExitCodes::find(64), "64 is not ours");
            t.IsNull(ExitCodes::find(75), "and 75 is not a code: a server that does not resolve is a notice (S13-R9)");
            t.IsNotNull(ExitCodes::find(73), "73 is");
            t.IsNotNull(ExitCodes::find(74), "and so is 74");
        });

        tc.Run("classify: a native crash status is 70 on both platforms, a plain code is itself", [](TestCase &t)
        {
            t.Equals(ExitCodes::classify(static_cast<int>(0xC0000005u)), ExitCodes::kCrashed, "Windows access violation, as GetExitCodeProcess hands it over in an int");
            t.Equals(ExitCodes::classify(0xC0000005LL), ExitCodes::kCrashed, "and as Python's subprocess reports it, unsigned");
            t.Equals(ExitCodes::classify(static_cast<int>(0xC00000FDu)), ExitCodes::kCrashed, "stack overflow");
            t.Equals(ExitCodes::classify(static_cast<int>(0xC0000409u)), ExitCodes::kCrashed, "the UCRT's fast-fail abort");
            t.Equals(ExitCodes::classify(139), ExitCodes::kCrashed, "128 + SIGSEGV, posix_glue.cpp's convention");
            t.Equals(ExitCodes::classify(135), ExitCodes::kCrashed, "SIGBUS");
            t.Equals(ExitCodes::classify(132), ExitCodes::kCrashed, "SIGILL");
            t.Equals(ExitCodes::classify(136), ExitCodes::kCrashed, "SIGFPE");
            t.Equals(ExitCodes::classify(134), ExitCodes::kCrashed, "SIGABRT: std::terminate on Linux");
            t.Equals(ExitCodes::classify(137), 137, "SIGKILL is not a crash: someone, or the OOM killer, ended it");
            t.Equals(ExitCodes::classify(143), 143, "nor is SIGTERM");
            t.Equals(ExitCodes::classify(0), 0, "0 is 0");
            t.Equals(ExitCodes::classify(65), 65, "a taxonomy code is itself");
            t.Equals(ExitCodes::classify(-1), -1, "0xFFFFFFFF is not an NT error status");
        });

        tc.Run("describe: the table's sentence, the crash sentence for a native status, the number for a stranger", [](TestCase &t)
        {
            t.Equals(ExitCodes::describe(0), std::string("The last run exited normally."), "0");
            t.Equals(ExitCodes::describe(66), std::string("The disc image was not found. Open the DISC page and choose your SOCOM II ISO again."), "66");
            t.Equals(ExitCodes::describe(static_cast<int>(0xC0000005u)), std::string(ExitCodes::find(70)->sentence), "an access violation reads as the crash sentence");
            t.Equals(ExitCodes::describe(139), std::string(ExitCodes::find(70)->sentence), "so does SIGSEGV");
            t.Equals(ExitCodes::describe(42), std::string("The game closed with code 42. Press SAVE DIAGNOSTICS to collect the log."), "an unknown code names itself");
            t.Equals(launcher::exitMessage(65),
                     std::string("Your GPU or driver is missing OpenGL 3.3 with dual-source blending; the game ran on the slow CPU renderer."),
                     "the launcher's exitMessage is this table, and 65 kept Sprint 7's words");
            t.Equals(launcher::exitMessage(71), ExitCodes::describe(71), "exitMessage is describe");
        });

        // Issue #69: 68 is met by every revision's build, and the r0004 build's image is socom2_game_r0004.elf,
        // so the sentence names no one revision's file -- it said "socom2_game.elf" to an r0004 player.
        tc.Run("68's sentence names the game's image, not one revision's file (issue #69)", [](TestCase &t)
        {
            const std::string s = ExitCodes::describe(68);
            for (size_t i = 0; i < launcher::kGameRevisionCount; ++i)
                t.IsTrue(s.find(launcher::kGameRevisions[i].elfName) == std::string::npos,
                         std::string("the sentence does not name ") + launcher::kGameRevisions[i].elfName);
            t.IsTrue(s.find("missing or damaged") != std::string::npos, "and still says what is wrong");
        });

        tc.Run("notices: a non-fatal report is a log line the launcher can read back", [](TestCase &t)
        {
            const std::string line = ExitCodes::noticeLine(ExitCodes::kNoAudioDevice);
            t.Equals(line, std::string("[notice] no-audio-device: No audio device was found; the game ran without sound."), "the line's shape");
            const std::string log = "INFO: boot\r\n" + line + "\r\n[gs-gl] initialised: 3.3.0\n" + line + "\n[notice] malformed\n";
            const std::vector<std::string> found = ExitCodes::noticesIn(log);
            t.Equals(static_cast<int>(found.size()), 1, "one notice, reported once however often it was printed; a line with no sentence is skipped");
            if (!found.empty())
                t.Equals(found[0], std::string("No audio device was found; the game ran without sound."), "the sentence, without the tag, without the CR");
            t.IsTrue(ExitCodes::noticesIn("no notices here\n").empty(), "a clean log has none");
        });
    });
}
