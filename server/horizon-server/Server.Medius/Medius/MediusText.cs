// LOCAL (socom_pc): the project's own file, not upstream Horizon's. Carry it across every vendor bump.
using RT.Common;

namespace Server.Medius
{
    // The Medius text fields a client sets and other clients are served -- game, lobby, clan and account names, clan
    // messages -- pass the same mapping ChatClamp.Fit applies to chat: printable ASCII only (everything else '?'),
    // at most the field's width - 1 characters, so each one fits its fixed-width field with its terminator.
    public static class MediusText
    {
        public static string GameName(string s) => ChatClamp.Fit(s, Constants.GAMENAME_MAXLEN);
        public static string LobbyName(string s) => ChatClamp.Fit(s, Constants.LOBBYNAME_MAXLEN);
        public static string ClanName(string s) => ChatClamp.Fit(s, Constants.CLANNAME_MAXLEN);
        public static string ClanMessage(string s) => ChatClamp.Fit(s, Constants.CLANMSG_MAXLEN);
        public static string AccountName(string s) => ChatClamp.Fit(s, Constants.ACCOUNTNAME_MAXLEN);

        // A world report may rename the game only when it comes from the game's host; otherwise the name stands.
        public static string ReportedGameName(string current, string reported, bool fromHost) =>
            fromHost ? GameName(reported) : current;
    }
}
