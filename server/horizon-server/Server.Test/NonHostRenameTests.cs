// LOCAL (socom_pc): a world report from a non-host does not rename the game, and the warning for it is logged once per
// game, not once per report (Server.Medius/Medius/Models/Game.cs ReportedGameName).
using System.Runtime.CompilerServices;
using Server.Medius.Models;
using Xunit;

namespace Server.Test
{
    public class NonHostRenameTests
    {
        static Game NewGame(out ClientObject host)
        {
            var game = (Game)RuntimeHelpers.GetUninitializedObject(typeof(Game));
            host = (ClientObject)RuntimeHelpers.GetUninitializedObject(typeof(ClientObject));
            game.GameName = "Standing";
            game.Host = host;
            return game;
        }

        [Fact]
        public void ANonHostRenameIsIgnoredAndWarnedOncePerGame()
        {
            var game = NewGame(out _);
            var other = (ClientObject)RuntimeHelpers.GetUninitializedObject(typeof(ClientObject));
            using var log = new LogCapture();
            Assert.Equal("Standing", game.ReportedGameName("Other", other));
            Assert.Equal("Standing", game.ReportedGameName("Other", other));
            Assert.Equal("Standing", game.ReportedGameName("Third", other));
            Assert.Single(log.Warnings);
            Assert.True(game.NonHostRenameWarned);
        }

        [Fact]
        public void EachGameWarnsForItself()
        {
            var a = NewGame(out _);
            var b = NewGame(out _);
            var other = (ClientObject)RuntimeHelpers.GetUninitializedObject(typeof(ClientObject));
            using var log = new LogCapture();
            a.ReportedGameName("Other", other);
            b.ReportedGameName("Other", other);
            Assert.Equal(2, log.Warnings.Count);
        }

        [Fact]
        public void TheHostRenamesWithoutAWarning()
        {
            var game = NewGame(out var host);
            using var log = new LogCapture();
            Assert.Equal("Renamed", game.ReportedGameName("Renamed", host));
            Assert.Empty(log.Warnings);
            Assert.False(game.NonHostRenameWarned);
        }
    }
}
