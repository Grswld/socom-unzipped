// LOCAL (socom_pc): a relayed game payload is bounded by what the SOCOM II client can consume (Server.Pipeline/RelayCaps.cs,
// called by Server.Dme/Models/World.cs), and an inbound DME datagram by the decoder's cap (ScertDatagramDecoder calls
// RelayCaps.InboundDatagramFits).
using System.Collections.Generic;
using System.Net;
using System.Runtime.CompilerServices;
using DotNetty.Buffers;
using DotNetty.Transport.Channels.Embedded;
using DotNetty.Transport.Channels.Sockets;
using RT.Common;
using RT.Models;
using Server.Pipeline;
using Server.Pipeline.Udp;
using Xunit;

namespace Server.Test
{
    public class RelayCapsTests
    {
        // The relayed RT_MSG_CLIENT_APP_SINGLE frame around a payload: id + length (3), the hash when encrypted (4),
        // the source DME id (2).
        const int FrameAround = 3 + 4 + 2;

        [Fact] public void TheTcpCapIsTheClientAppScratchSize() { Assert.Equal(0x600, RelayCaps.TcpRelayMax); }
        [Fact] public void TheUdpCapIsTheClientUdpRingSlot() { Assert.Equal(0x248, RelayCaps.UdpRelayMax); }

        [Fact] public void TheRelayedFrameOverheadIsCounted() { Assert.Equal(FrameAround, RelayCaps.RelayedFrameOverhead); }

        [Fact] public void ATcpPayloadOf1536BytesIsRelayed() { Assert.True(RelayCaps.RelayPayloadFits(new byte[1536], udp: false)); }
        [Fact] public void ATcpPayloadOf1537BytesIsDropped() { Assert.False(RelayCaps.RelayPayloadFits(new byte[1537], udp: false)); }
        [Fact] public void ATcpPayloadOver512BytesIsRelayed() { Assert.True(RelayCaps.RelayPayloadFits(new byte[513], udp: false)); }

        [Fact] public void AUdpPayloadWhoseRelayedFrameFillsTheSlotIsRelayed() { Assert.True(RelayCaps.RelayPayloadFits(new byte[584 - FrameAround], udp: true)); }
        [Fact] public void AUdpPayloadWhoseRelayedFrameOverrunsTheSlotIsDropped() { Assert.False(RelayCaps.RelayPayloadFits(new byte[584 - FrameAround + 1], udp: true)); }
        [Fact] public void AUdpPayloadOfTheWholeSlotIsDropped() { Assert.False(RelayCaps.RelayPayloadFits(new byte[584], udp: true)); }

        [Fact]
        public void TheRelayedUdpFrameAtTheCapIsNoLongerThanTheSlot()
        {
            var msg = new RT_MSG_CLIENT_APP_SINGLE() { TargetOrSource = 1, Payload = new byte[584 - FrameAround] };
            var wire = msg.Serialize(0, null);
            Assert.Single(wire);
            Assert.True(wire[0].Length + BaseScertMessage.HASH_SIZE <= RelayCaps.UdpRelayMax);
        }

        [Fact]
        public void APayloadBetweenTheTwoCapsIsDroppedOnUdpOnly()
        {
            var p = new byte[1000];
            Assert.True(RelayCaps.RelayPayloadFits(p, udp: false));
            Assert.False(RelayCaps.RelayPayloadFits(p, udp: true));
        }
        [Fact] public void AnEmptyPayloadIsRelayed() { Assert.True(RelayCaps.RelayPayloadFits(null, udp: false)); Assert.True(RelayCaps.RelayPayloadFits(new byte[0], udp: true)); }

        [Fact] public void AnInboundDatagramAtTheCapIsAccepted() { Assert.True(RelayCaps.InboundDatagramFits(RelayCaps.InboundUdpMax)); }
        [Fact] public void AnInboundDatagramOverTheCapIsRefused() { Assert.False(RelayCaps.InboundDatagramFits(RelayCaps.InboundUdpMax + 1)); }
        [Fact] public void TheInboundCapLeavesRoomForAnAdvertisedPacket() { Assert.True(RelayCaps.InboundUdpMax >= RT.Common.Constants.MEDIUS_UDP_MESSAGE_MAXLEN); }
        [Fact] public void AnExplicitInboundCapIsHonoured() { Assert.True(RelayCaps.InboundDatagramFits(16, 16)); Assert.False(RelayCaps.InboundDatagramFits(17, 16)); }
        [Fact] public void AnInboundCapOfZeroMeansUncapped() { Assert.True(RelayCaps.InboundDatagramFits(65535, 0)); }

        static List<object> DecodeDatagram(int max, int length)
        {
            var bytes = new byte[length];
            bytes[0] = (byte)RT_MSG_TYPE.RT_MSG_CLIENT_APP_SINGLE;
            bytes[1] = (byte)((length - 3) & 0xFF);
            bytes[2] = (byte)(((length - 3) >> 8) & 0xFF);
            var channel = new EmbeddedChannel(new ScertDatagramDecoder() { MaxDatagramLength = max });
            // A plaintext session (no cipher): the attribute is made without its constructor's RSA key set-up.
            var client = (Server.Pipeline.Attribute.ScertClientAttribute)RuntimeHelpers.GetUninitializedObject(typeof(Server.Pipeline.Attribute.ScertClientAttribute));
            channel.GetAttribute(Server.Pipeline.Constants.SCERT_CLIENT).Set(client);
            var from = new IPEndPoint(IPAddress.Loopback, 10070);
            channel.WriteInbound(new DatagramPacket(Unpooled.WrappedBuffer(bytes), from, from));
            var output = new List<object>();
            object o;
            while ((o = channel.ReadInbound<object>()) != null)
                output.Add(o);
            channel.Finish();
            return output;
        }

        [Fact] public void TheDecoderAcceptsADatagramAtItsCap() { Assert.Single(DecodeDatagram(16, 16)); }
        [Fact] public void TheDecoderRefusesADatagramOverItsCap() { Assert.Empty(DecodeDatagram(16, 17)); }
    }
}
