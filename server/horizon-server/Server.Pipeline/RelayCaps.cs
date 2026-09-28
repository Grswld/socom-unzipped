using RtConstants = RT.Common.Constants;

namespace Server.Pipeline
{
    // LOCAL (socom_pc): the size bounds on relayed game traffic. A relayed payload may not exceed the packet size the
    // server advertises to clients (RT_MSG_SERVER_CONNECT_REQUIRE: MaxPacketSize for TCP, MaxUdpPacketSize for UDP);
    // an inbound DME datagram may not exceed InboundUdpMax. Callers drop what does not fit, with a log line.
    public static class RelayCaps
    {
        public const int TcpRelayMax = RtConstants.MEDIUS_MESSAGE_MAXLEN;
        public const int UdpRelayMax = RtConstants.MEDIUS_UDP_MESSAGE_MAXLEN;
        public const int InboundUdpMax = 1024;

        public static bool RelayPayloadFits(byte[] payload, bool udp)
        {
            int length = payload?.Length ?? 0;
            return length <= (udp ? UdpRelayMax : TcpRelayMax);
        }

        public static bool InboundDatagramFits(int length) => length >= 0 && length <= InboundUdpMax;
    }
}
