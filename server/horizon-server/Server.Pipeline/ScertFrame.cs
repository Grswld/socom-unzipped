using DotNetty.Buffers;
using DotNetty.Common.Internal.Logging;
using RT.Common;
using RT.Cryptography;
using RT.Models;

namespace Server.Pipeline
{
    // LOCAL (socom_pc): one SCERT frame off a buffer, shared by the TCP and UDP decoders. The length is an unsigned
    // 16-bit field; a frame is complete only when its header (3 bytes, 7 with the hash) AND its body are readable; a
    // body that fails to deserialize is consumed and dropped, never forwarded.
    public static class ScertFrame
    {
        public const int HeaderLength = BaseScertMessage.HEADER_SIZE;
        public const int HashLength = BaseScertMessage.HASH_SIZE;

        static readonly IInternalLogger Logger = InternalLoggerFactory.GetInstance(typeof(ScertFrame));

        /// <summary>
        /// False: the frame is incomplete and the reader is untouched. True: one frame was consumed; <paramref name="message"/>
        /// is null when it was dropped.
        /// </summary>
        public static bool TryDecode(IByteBuffer input, int mediusVersion, CipherService cipherService, out BaseScertMessage message)
        {
            message = null;
            if (input.ReadableBytes < HeaderLength)
                return false;

            byte id = input.GetByte(input.ReaderIndex);
            int frameLength = input.GetUnsignedShortLE(input.ReaderIndex + 1);

            if (frameLength == 0)
            {
                input.SetReaderIndex(input.ReaderIndex + HeaderLength);
                message = BaseScertMessage.Instantiate((RT_MSG_TYPE)(id & 0x7F), null, new byte[0], mediusVersion, cipherService);
                if (message == null)
                    Logger.Warn($"scert frame dropped: type {id & 0x7F} empty body refused");
                return true;
            }

            byte[] hash = null;
            int headerLength = HeaderLength;
            if (id >= 0x80)
            {
                headerLength += HashLength;
                id &= 0x7F;
            }

            if (input.ReadableBytes < headerLength + frameLength)
                return false;

            if (headerLength > HeaderLength)
            {
                hash = new byte[HashLength];
                input.GetBytes(input.ReaderIndex + HeaderLength, hash);
            }

            byte[] messageContents = new byte[frameLength];
            input.GetBytes(input.ReaderIndex + headerLength, messageContents);
            input.SetReaderIndex(input.ReaderIndex + headerLength + frameLength);
            message = BaseScertMessage.Instantiate((RT_MSG_TYPE)id, hash, messageContents, mediusVersion, cipherService);
            if (message == null)
                Logger.Warn($"scert frame dropped: type {id} ({frameLength} bytes) did not decode");
            return true;
        }
    }
}
