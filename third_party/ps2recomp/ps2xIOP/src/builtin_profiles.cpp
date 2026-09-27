#include "iop_service.h"
#include "module_factories.h"

namespace ps2x::iop::detail
{
    ServiceList createCoreServices(IopHost &host)
    {
        ServiceList services;
        services.emplace_back(createMcservService(host));
        services.emplace_back(createDbcmanService(host));
        services.emplace_back(createLibSdService(host));
        return services;
    }

    // Sprint 13 Task C7 (audit F24): SOCOM II is the only built-in profile. Upstream's recvx-us (Resident Evil
    // Code: Veronica X), lotr-two-towers-us and fatal-frame-us rows and their five modules (TSNDDRV, CRI DTX,
    // CLFILE, the LotR SOUND stub, SDRDRV) were compiled into the runner and never selected; they are removed.
    // The table and the loader stay generic: a plugin (PS2X_IOP_ENABLE_PLUGINS) can still add a profile.
    namespace
    {
        // SOCOM II (SCUS_972.75): 989snd (989SND.IRX, SIDs 0x123456/0x123457) is high-level emulated in
        // modules/snd989.cpp; lgaud / inet+netcnf services are added as they are implemented; core
        // MCSERV/DBCMAN/LIBSD are always present. The same modules in every revision.
        ServiceList createSocom2Services(IopHost &host, const GameIdentity &)
        {
            ServiceList services;
            services.emplace_back(createSnd989Service(host));
            services.emplace_back(createLgAudService(host));
            services.emplace_back(createEzNetCnfService(host));
            return services;
        }
    }

    std::vector<ProfileDefinition> createBuiltinProfiles()
    {
        std::vector<ProfileDefinition> profiles;

        profiles.push_back({"socom2-us", "builtin", {.elfName = "socom2_game.elf"}, createSocom2Services});
        // Issue #69: r0004's image is socom2_game_r0004.elf (launcher::kGameRevisions' elfName, the name
        // build_revision.sh packages). The match is by file name, so without this row an r0004 run fell back
        // to the core services alone -- no 989snd, no lgaud, no eznetcnf -- and nothing said so.
        profiles.push_back({"socom2-us-r0004", "builtin", {.elfName = "socom2_game_r0004.elf"}, createSocom2Services});

        return profiles;
    }
}
