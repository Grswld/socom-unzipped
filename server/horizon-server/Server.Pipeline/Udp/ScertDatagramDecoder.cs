using RT.Models;
using RT.Common;
using DotNetty.Buffers;
using DotNetty.Codecs;
using DotNetty.Common.Internal.Logging;
using DotNetty.Transport.Channels;
using DotNetty.Transport.Channels.Sockets;
using RT.Cryptography;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace Server.Pipeline.Udp
{
    public class ScertDatagramDecoder : MessageToMessageDecoder<DatagramPacket>
    {
        static readonly IInternalLogger Logger = InternalLoggerFactory.GetInstance<ScertDatagramDecoder>();

        /// <summary>LOCAL (socom_pc): inbound datagrams longer than this are refused; 0 means no cap.</summary>
        public int MaxDatagramLength { get; set; } = 0;

        readonly ICipher[] _ciphers = null;
        readonly Func<RT_MSG_TYPE, CipherContext, ICipher> _getCipher = null;

        public ScertDatagramDecoder(params ICipher[] ciphers)
        {
            this._ciphers = ciphers;
            this._getCipher = (id, ctx) =>
            {
                return _ciphers?.FirstOrDefault(x => x.Context == ctx);
            };
        }

        public override void ExceptionCaught(IChannelHandlerContext context, Exception exception)
        {
            Logger.Error(exception);
            // context.CloseAsync();
        }

        protected override void Decode(IChannelHandlerContext context, DatagramPacket message, List<object> output)
        {
            // LOCAL (socom_pc): an inbound datagram over the configured cap is refused whole.
            if (MaxDatagramLength > 0 && message.Content.ReadableBytes > MaxDatagramLength)
            {
                Logger.Warn($"scert datagram from {message.Sender} refused: {message.Content.ReadableBytes} bytes over the {MaxDatagramLength}-byte cap");
                return;
            }

            while (message.Content.IsReadable())
            {
                int before = message.Content.ReaderIndex;
                object decoded = Decode(context, message);
                if (decoded == null)
                {
                    // LOCAL (socom_pc): a dropped frame was consumed, keep reading; an incomplete one ends the datagram.
                    if (message.Content.ReaderIndex != before)
                        continue;
                    if (message.Content.IsReadable())
                        Logger.Warn($"scert datagram from {message.Sender}: {message.Content.ReadableBytes} trailing bytes refused (incomplete frame)");
                    break;
                }

                output.Add(decoded);
            }
        }

        /// <summary>
        ///     Create a frame out of the <see cref="IByteBuffer" /> and return it.
        /// </summary>
        /// <param name="context">
        ///     The <see cref="IChannelHandlerContext" /> which this <see cref="ByteToMessageDecoder" /> belongs
        ///     to.
        /// </param>
        /// <param name="input">The <see cref="IByteBuffer" /> from which to read data.</param>
        /// <returns>The <see cref="IByteBuffer" /> which represents the frame or <c>null</c> if no frame could be created.</returns>
        protected virtual object Decode(IChannelHandlerContext context, DatagramPacket input)
        {
            if (!context.HasAttribute(Constants.SCERT_CLIENT))
                context.GetAttribute(Constants.SCERT_CLIENT).Set(new Attribute.ScertClientAttribute());
            var scertClient = context.GetAttribute(Constants.SCERT_CLIENT).Get();

            // LOCAL (socom_pc): bounded decode (unsigned length, header counted, undecodable bodies dropped): ScertFrame.
            if (!ScertFrame.TryDecode(input.Content, scertClient.MediusVersion, scertClient.CipherService, out var message) || message == null)
                return null;
            return new ScertDatagramPacket(message, null, input.Sender);
        }

    }
}
