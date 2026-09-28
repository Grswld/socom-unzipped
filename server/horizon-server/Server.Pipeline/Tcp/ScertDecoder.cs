// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

using System;
using System.Collections.Generic;
using System.Linq;
using DotNetty.Buffers;
using DotNetty.Codecs;
using DotNetty.Common.Internal.Logging;
using DotNetty.Transport.Channels;
using RT.Common;
using RT.Cryptography;
using RT.Models;

namespace Server.Pipeline.Tcp
{
    public class ScertDecoder : MessageToMessageDecoder<IByteBuffer>
    {
        static readonly IInternalLogger Logger = InternalLoggerFactory.GetInstance<ScertDecoder>();

        /// <summary>
        ///     Create a new instance.
        /// </summary>
        public ScertDecoder()
        {

        }

        protected override void Decode(IChannelHandlerContext context, IByteBuffer input, List<object> output)
        {
            try
            {
                var decoded = this.Decode(context, input);
                if (decoded != null)
                    output.Add(decoded);
            }
            catch (Exception e)
            {
                Logger.Error(e);
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
        protected virtual object Decode(IChannelHandlerContext context, IByteBuffer input)
        {
            if (!context.HasAttribute(Constants.SCERT_CLIENT))
                context.GetAttribute(Constants.SCERT_CLIENT).Set(new Attribute.ScertClientAttribute());
            var scertClient = context.GetAttribute(Constants.SCERT_CLIENT).Get();

            // LOCAL (socom_pc): bounded decode (unsigned length, header counted, undecodable bodies dropped): ScertFrame.
            if (!ScertFrame.TryDecode(input, scertClient.MediusVersion, scertClient.CipherService, out var message))
                return null;
            return message;
        }

    }
}