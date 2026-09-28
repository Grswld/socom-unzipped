// LOCAL (socom_pc): the SCERT frame decode is bounded -- unsigned length, header counted, a body that fails to
// deserialize is dropped (Server.Pipeline/ScertFrame.cs, used by ScertDecoder and ScertDatagramDecoder).
using DotNetty.Buffers;
using RT.Common;
using RT.Models;
using Server.Pipeline;
using Xunit;

namespace Server.Test
{
    public class ScertFrameTests
    {
        static readonly byte AppSingle = (byte)RT_MSG_TYPE.RT_MSG_CLIENT_APP_SINGLE;

        static byte[] Frame(byte id, int declaredLength, int bodyBytes)
        {
            var f = new byte[3 + bodyBytes];
            f[0] = id;
            f[1] = (byte)(declaredLength & 0xFF);
            f[2] = (byte)((declaredLength >> 8) & 0xFF);
            for (int i = 0; i < bodyBytes; ++i) f[3 + i] = (byte)i;
            return f;
        }

        [Fact]
        public void AWellFormedFrameDecodes()
        {
            var buf = Unpooled.WrappedBuffer(Frame(AppSingle, 6, 6));
            Assert.True(ScertFrame.TryDecode(buf, 0, null, out var msg));
            var single = Assert.IsType<RT_MSG_CLIENT_APP_SINGLE>(msg);
            Assert.Equal(4, single.Payload.Length);
            Assert.Equal(0, buf.ReadableBytes);
        }

        [Fact]
        public void ALengthOf0x8000IsReadUnsigned()
        {
            var buf = Unpooled.WrappedBuffer(Frame(AppSingle, 0x8000, 0x8000));
            Assert.True(ScertFrame.TryDecode(buf, 0, null, out var msg));
            var single = Assert.IsType<RT_MSG_CLIENT_APP_SINGLE>(msg);
            Assert.Equal(0x8000 - 2, single.Payload.Length);
            Assert.Equal(0, buf.ReadableBytes);
        }

        [Fact]
        public void ALengthOf0xFFFFWithoutItsBodyIsIncomplete()
        {
            var buf = Unpooled.WrappedBuffer(Frame(AppSingle, 0xFFFF, 16));
            Assert.False(ScertFrame.TryDecode(buf, 0, null, out var msg));
            Assert.Null(msg);
            Assert.Equal(0, buf.ReaderIndex);
        }

        [Fact]
        public void AFrameShortByTheHeaderIsIncomplete()
        {
            // The body is declared as 8 bytes; 8 bytes are readable in total but only 5 of them follow the header.
            var bytes = Frame(AppSingle, 8, 5);
            var buf = Unpooled.WrappedBuffer(bytes);
            Assert.Equal(8, buf.ReadableBytes);
            Assert.False(ScertFrame.TryDecode(buf, 0, null, out var msg));
            Assert.Null(msg);
            Assert.Equal(0, buf.ReaderIndex);
        }

        [Fact]
        public void AnEncryptedFrameShortByItsHashIsIncomplete()
        {
            var buf = Unpooled.WrappedBuffer(Frame((byte)(AppSingle | 0x80), 4, 4)); // needs 3 + 4 hash + 4 body
            Assert.False(ScertFrame.TryDecode(buf, 0, null, out var msg));
            Assert.Null(msg);
            Assert.Equal(0, buf.ReaderIndex);
        }

        [Fact]
        public void LessThanAHeaderIsIncomplete()
        {
            var buf = Unpooled.WrappedBuffer(new byte[] { AppSingle, 0x01 });
            Assert.False(ScertFrame.TryDecode(buf, 0, null, out _));
            Assert.Equal(0, buf.ReaderIndex);
        }

        [Fact]
        public void AMalformedBodyIsDroppedAndConsumed()
        {
            // RT_MSG_CLIENT_APP_SINGLE needs a 2-byte target before its payload; one byte cannot deserialize.
            var bytes = new byte[3 + 1 + 3 + 6];
            System.Array.Copy(Frame(AppSingle, 1, 1), 0, bytes, 0, 4);
            System.Array.Copy(Frame(AppSingle, 6, 6), 0, bytes, 4, 9);
            var buf = Unpooled.WrappedBuffer(bytes);
            Assert.True(ScertFrame.TryDecode(buf, 0, null, out var dropped));
            Assert.Null(dropped);
            Assert.Equal(4, buf.ReaderIndex);
            Assert.True(ScertFrame.TryDecode(buf, 0, null, out var next));
            Assert.IsType<RT_MSG_CLIENT_APP_SINGLE>(next);
        }

        [Fact]
        public void ADroppedBodyLogsOnceWithItsTypeAndLength()
        {
            using var log = new LogCapture();
            var buf = Unpooled.WrappedBuffer(Frame(AppSingle, 1, 1));
            Assert.True(ScertFrame.TryDecode(buf, 0, null, out var dropped));
            Assert.Null(dropped);
            var line = Assert.Single(log.Warnings);
            Assert.Contains("RT_MSG_CLIENT_APP_SINGLE", line);
            Assert.Contains("1 bytes", line);
        }

        [Fact]
        public void InstantiateDropsAMalformedBody()
        {
            Assert.Null(BaseScertMessage.Instantiate(RT_MSG_TYPE.RT_MSG_CLIENT_APP_SINGLE, null, new byte[] { 0x01 }, 0, null));
        }

        [Fact]
        public void AZeroLengthFrameConsumesItsHeader()
        {
            var buf = Unpooled.WrappedBuffer(Frame(AppSingle, 0, 0));
            Assert.True(ScertFrame.TryDecode(buf, 0, null, out _));
            Assert.Equal(3, buf.ReaderIndex);
        }
    }
}
