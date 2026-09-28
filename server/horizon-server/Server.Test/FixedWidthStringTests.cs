// LOCAL (socom_pc): the fixed-width string field is bounded by its encoded bytes (BinaryWriterExt/BinaryReaderExt).
using System.IO;
using System.Text;
using Server.Common;
using Server.Common.Stream;
using Xunit;

namespace Server.Test
{
    public class FixedWidthStringTests
    {
        static byte[] WriteField(string value, int width, bool viaWriteStr = false)
        {
            using var ms = new MemoryStream();
            using (var w = new MessageWriter(ms))
            {
                if (viaWriteStr) w.WriteStr(value, width); else w.Write(value, width);
            }
            return ms.ToArray();
        }

        static string ReadField(byte[] field, int width)
        {
            using var r = new MessageReader(new MemoryStream(field));
            return r.ReadString(width);
        }

        static void AssertBoundedAndTerminated(byte[] field, int width)
        {
            Assert.Equal(width, field.Length);
            Assert.Equal(0, field[width - 1]);
        }

        [Fact] public void AnAsciiValueIsUnchanged() { var f = WriteField("gg", 8); Assert.Equal(new byte[] { 0x67, 0x67, 0, 0, 0, 0, 0, 0 }, f); }
        [Fact] public void AnOverlongAsciiValueIsCutAndTerminated() { var f = WriteField(new string('a', 20), 8); AssertBoundedAndTerminated(f, 8); Assert.Equal("aaaaaaa", ReadField(f, 8)); }
        [Fact] public void NullIsAZeroField() { Assert.Equal(new byte[8], WriteField(null, 8)); }

        [Fact] public void AMultiByteValueShorterInCharactersIsBoundedByBytes() { AssertBoundedAndTerminated(WriteField(new string('中', 7), 16), 16); }
        [Fact] public void AMultiByteValueAtTheBoundaryIsCutOnACharacter()
        {
            // 'é' is two bytes; seven fill the width with no room for the terminator, so the value keeps six.
            var f = WriteField(new string('é', 7), 14);
            AssertBoundedAndTerminated(f, 14);
            Assert.Equal(new string('é', 6), ReadField(f, 14));
        }
        [Fact] public void AThreeByteCharacterIsNotSplitAtTheBoundary()
        {
            var f = WriteField("ab中", 5); // 'a' 'b' + 3 bytes = 5 > 4 content bytes
            AssertBoundedAndTerminated(f, 5);
            Assert.Equal("ab", ReadField(f, 5));
        }
        [Fact] public void AnEmojiIsBoundedByBytes() { AssertBoundedAndTerminated(WriteField("😀😀😀😀", 16), 16); }
        [Fact] public void WriteStrIsBoundedToo() { AssertBoundedAndTerminated(WriteField(new string('中', 7), 16, viaWriteStr: true), 16); }

        [Fact] public void TheWriterNeverMovesTheStreamPastTheField()
        {
            using var ms = new MemoryStream();
            using (var w = new MessageWriter(ms)) { w.Write(new string('中', 30), 32); w.Write((byte)0x7E); }
            var bytes = ms.ToArray();
            Assert.Equal(33, bytes.Length);
            Assert.Equal(0x7E, bytes[32]);
        }

        [Fact] public void InvalidBytesReadBackWithinTheField()
        {
            var field = new byte[16];
            for (int i = 0; i < 15; ++i) field[i] = 0xFF;
            var value = ReadField(field, 16);
            Assert.True(Encoding.UTF8.GetByteCount(value) <= 15, $"read value re-encodes to {Encoding.UTF8.GetByteCount(value)} bytes");
            AssertBoundedAndTerminated(WriteField(value, 16), 16);
        }
        [Fact] public void ATruncatedSequenceReadsBackWithinTheField()
        {
            var field = new byte[] { 0x61, 0xE4, 0xB8, 0x00 }; // 'a' + two bytes of a three-byte character
            var value = ReadField(field, 4);
            Assert.True(Encoding.UTF8.GetByteCount(value) <= 3);
            Assert.StartsWith("a", value);
        }
        [Fact] public void AValidMultiByteValueReadsBackIntact() { Assert.Equal("héllo", ReadField(WriteField("héllo", 16), 16)); }
    }
}
