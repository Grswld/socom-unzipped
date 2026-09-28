using RT.Models;

namespace Server.Pipeline
{
    // LOCAL (socom_pc): the size bounds on relayed game traffic, taken from what the SOCOM II client can consume. The
    // client is never sent RT_MSG_SERVER_CONNECT_REQUIRE (Server.Dme/TcpServer.cs sends it only to PS3 clients and newer
    // Medius versions), so the advertised MEDIUS_MESSAGE_MAXLEN is not a size it knows; its own buffers are the bound.
    // An inbound DME datagram may not exceed InboundUdpMax (or the decoder's configured cap). Callers drop what does not
    // fit, with one log line.
    public static class RelayCaps
    {
        // The client's application layer takes an app message body into a fixed 0x600-byte scratch and refuses a
        // longer one: a relayed TCP payload over 0x600 bytes can never be consumed.
        public const int TcpRelayMax = 0x600;

        // The client's UDP receive ring holds one datagram per 0x248-byte (584) slot; the whole relayed frame must fit.
        public const int UdpRelayMax = 0x248;

        // The relayed RT_MSG_CLIENT_APP_SINGLE around a payload: the frame header (id + length), the hash when the
        // session is encrypted (counted always: the worst case), and the 2-byte source DME id.
        public const int RelayedFrameOverhead = BaseScertMessage.HEADER_SIZE + BaseScertMessage.HASH_SIZE + 2;

        public const int InboundUdpMax = 1024;

        public static bool RelayPayloadFits(byte[] payload, bool udp)
        {
            int length = payload?.Length ?? 0;
            return udp ? length + RelayedFrameOverhead <= UdpRelayMax : length <= TcpRelayMax;
        }

        public static bool InboundDatagramFits(int length) => InboundDatagramFits(length, InboundUdpMax);

        // A cap of 0 or less means uncapped.
        public static bool InboundDatagramFits(int length, int max) => length >= 0 && (max <= 0 || length <= max);
    }
}
