// LOCAL (socom_pc): the Medius text fields pass ChatClamp's printable-ASCII mapping at their own widths
// (Server.Medius/Medius/MediusText.cs), and a game-name update is accepted from the host only.
using System;
using RT.Common;
using Server.Medius;
using Xunit;

namespace Server.Test
{
    public class MediusTextTests
    {
        static void AssertClamped(string result, int width)
        {
            Assert.True(result.Length <= width - 1, $"expected at most {width - 1} characters, got {result.Length}");
            Assert.All(result, c => Assert.True(c >= 0x20 && c <= 0x7E, $"expected printable ASCII, got U+{(int)c:X4}"));
        }

        public static TheoryData<string, int> Fields => new TheoryData<string, int>
        {
            { nameof(MediusText.GameName), Constants.GAMENAME_MAXLEN },
            { nameof(MediusText.LobbyName), Constants.LOBBYNAME_MAXLEN },
            { nameof(MediusText.ClanName), Constants.CLANNAME_MAXLEN },
            { nameof(MediusText.ClanMessage), Constants.CLANMSG_MAXLEN },
            { nameof(MediusText.AccountName), Constants.ACCOUNTNAME_MAXLEN },
        };

        static string Apply(string field, string value) => field switch
        {
            nameof(MediusText.GameName) => MediusText.GameName(value),
            nameof(MediusText.LobbyName) => MediusText.LobbyName(value),
            nameof(MediusText.ClanName) => MediusText.ClanName(value),
            nameof(MediusText.ClanMessage) => MediusText.ClanMessage(value),
            nameof(MediusText.AccountName) => MediusText.AccountName(value),
            _ => throw new ArgumentException(field),
        };

        [Theory, MemberData(nameof(Fields))]
        public void AnOverlongMultiByteValueIsClampedToTheField(string field, int width)
        {
            AssertClamped(Apply(field, new string('中', width)), width);
        }

        [Theory, MemberData(nameof(Fields))]
        public void AnOverlongAsciiValueIsCutToWidthMinusOne(string field, int width)
        {
            Assert.Equal(width - 1, Apply(field, new string('a', width + 5)).Length);
        }

        [Theory, MemberData(nameof(Fields))]
        public void ControlAndNonAsciiCharactersAreMapped(string field, int width)
        {
            Assert.Equal("a?b?c??", Apply(field, "a\nbéc\U0001F600"));
            AssertClamped(Apply(field, "a\nb"), width);
        }

        [Theory, MemberData(nameof(Fields))]
        public void APlainValueIsUnchanged(string field, int width)
        {
            var plain = "Seals 24/7";
            Assert.True(plain.Length < width);
            Assert.Equal(plain, Apply(field, plain));
            Assert.Equal("", Apply(field, null));
        }

        [Fact] public void TheHostRenamesTheGame() { Assert.Equal("new", MediusText.ReportedGameName("old", "new", fromHost: true)); }
        [Fact] public void ANonHostRenameIsIgnored() { Assert.Equal("old", MediusText.ReportedGameName("old", "new", fromHost: false)); }
        [Fact] public void TheHostsRenameIsClamped() { AssertClamped(MediusText.ReportedGameName("old", new string('中', 80), fromHost: true), Constants.GAMENAME_MAXLEN); }
    }
}
