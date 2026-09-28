// LOCAL (socom_pc): a relayed game payload is bounded by the packet size the server advertises (Server.Pipeline/RelayCaps.cs,
// called by Server.Dme/Models/World.cs and the DME UDP decoder).
using Constants = RT.Common.Constants;
using Server.Pipeline;
using Xunit;

namespace Server.Test
{
    public class RelayCapsTests
    {
        [Fact] public void ATcpPayloadAtTheAdvertisedSizeIsRelayed() { Assert.True(RelayCaps.RelayPayloadFits(new byte[Constants.MEDIUS_MESSAGE_MAXLEN], udp: false)); }
        [Fact] public void ATcpPayloadOverTheAdvertisedSizeIsRefused() { Assert.False(RelayCaps.RelayPayloadFits(new byte[Constants.MEDIUS_MESSAGE_MAXLEN + 1], udp: false)); }
        [Fact] public void AUdpPayloadAtTheAdvertisedSizeIsRelayed() { Assert.True(RelayCaps.RelayPayloadFits(new byte[Constants.MEDIUS_UDP_MESSAGE_MAXLEN], udp: true)); }
        [Fact] public void AUdpPayloadOverTheAdvertisedSizeIsRefused() { Assert.False(RelayCaps.RelayPayloadFits(new byte[Constants.MEDIUS_UDP_MESSAGE_MAXLEN + 1], udp: true)); }
        [Fact] public void ATcpPayloadBetweenTheTwoCapsIsRefusedOnTcpOnly()
        {
            var p = new byte[Constants.MEDIUS_MESSAGE_MAXLEN + 10];
            Assert.False(RelayCaps.RelayPayloadFits(p, udp: false));
            Assert.True(RelayCaps.RelayPayloadFits(p, udp: true));
        }
        [Fact] public void AnEmptyPayloadIsRelayed() { Assert.True(RelayCaps.RelayPayloadFits(null, udp: false)); Assert.True(RelayCaps.RelayPayloadFits(new byte[0], udp: true)); }

        [Fact] public void AnInboundDatagramAtTheCapIsAccepted() { Assert.True(RelayCaps.InboundDatagramFits(RelayCaps.InboundUdpMax)); }
        [Fact] public void AnInboundDatagramOverTheCapIsRefused() { Assert.False(RelayCaps.InboundDatagramFits(RelayCaps.InboundUdpMax + 1)); }
        [Fact] public void TheInboundCapLeavesRoomForAnAdvertisedPacket() { Assert.True(RelayCaps.InboundUdpMax >= Constants.MEDIUS_UDP_MESSAGE_MAXLEN); }
    }
}
