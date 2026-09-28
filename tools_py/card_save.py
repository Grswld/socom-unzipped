#!/usr/bin/env python
"""The memory card's SOCOM II save file, decoded and encoded -- the Python reference for launcher/card_save.h.

`cards/<profile>/BASCUS-97275SOCOMII/BASCUS-97275SOCOMII` (and every SaveGame<n>) is a ZAR version-2 archive
(reCOM zar.h) passed through a fixed-seed byte scrambler (the game's sub_0033DC30 / FUN_0033de00, seed 0x96, no
key). Inside, the key CAcctDB/AcctInfo.rdr is a serialised rdr tree holding one 16-node record per persona:
HOST (the resolved server address), NAME, TOWN, GENDER, PORT, PASSWORD (plain), SAVEPASSWORD, PROFILES.
docs/superpowers/plans/2026-09-28-persona-card-creator.md section 1 has the layout; this module round-trips every
example card under logs/parity/*/mc0/ byte for byte (tools_py/tests/test_card_save.py). The encoder
(write_personas, build_zar, write_card_file) lays the bytes out as launcher/card_save.cpp does: one record, or
none, is the game's own AcctInfo.rdr, and ps2xTest/fixtures/cards/created.bin is the card both write for s17pc.

  python -m tools_py.card_save --dump <file>      the personas as JSON
  python -m tools_py.card_save --keys <file>      the archive's keys
"""
import json
import struct
import sys


def _s8(x):
    x &= 0xFF
    return x - 256 if x >= 128 else x


def unscramble(buf):
    b = bytearray(buf)
    n = len(b)
    if n >= 2:
        k = b[n - 1]
        for i in range(n - 2, -1, -1):
            v = (b[i] ^ _s8(k)) & 0xFF
            b[i] = v
            k = (k ^ ((k + _s8(v)) & 0xFF)) & 0xFF
    k = 0x96
    for i in range(n):
        v = (b[i] ^ _s8(k)) & 0xFF
        b[i] = v
        k = (k ^ ((k + _s8(v)) & 0xFF)) & 0xFF
    return bytes(b)


def scramble(buf):
    b = bytearray(buf)
    n = len(b)
    k = 0x96
    for i in range(n):
        p = _s8(b[i])
        b[i] = (p ^ _s8(k)) & 0xFF
        k = (k ^ ((k + p) & 0xFF)) & 0xFF
    if n >= 2:
        k = b[n - 1]
        for i in range(n - 2, -1, -1):
            p = _s8(b[i])
            b[i] = (p ^ _s8(k)) & 0xFF
            k = (k ^ ((k + p) & 0xFF)) & 0xFF
    return bytes(b)


ZAR_VERSION_2 = 0x20002
HEAD_BYTES = 100


def parse_zar(plain):
    """(head dict, keys) -- keys are (name, data bytes, child_count) in the archive's pre-order."""
    h = struct.unpack_from('<25i', plain, 0)
    if h[24] != ZAR_VERSION_2:
        raise ValueError('not a ZAR version-2 archive (version %#x)' % (h[24] & 0xFFFFFFFF))
    head = dict(flags=h[0], key_count=h[1], stable_size=h[2], stable_ofs=h[3], padding=h[4],
                offset=h[21], crc=h[22], appversion=h[23])
    stable = plain[HEAD_BYTES:HEAD_BYTES + head['stable_size']]
    kofs = HEAD_BYTES + head['stable_size']
    key_end = kofs + head['key_count'] * 16
    align = key_end % head['padding'] if head['padding'] else 0
    data0 = key_end + (0 if not align else head['padding'] - align)
    keys = []
    for i in range(head['key_count']):
        name_ofs, off, size, children = struct.unpack_from('<iIIi', plain, kofs + i * 16)
        rel = name_ofs - head['stable_ofs']
        name = stable[rel:stable.find(b'\0', rel)].decode('latin-1') if 0 <= rel < len(stable) else ''
        keys.append((name, plain[data0 + off:data0 + off + size], children))
    return head, keys


def key_tree(keys):
    """The pre-order list as nested (name, data, [children])."""
    it = iter(keys)

    def node():
        name, data, count = next(it)
        return (name, data, [node() for _ in range(count)])
    return node()


def find_key(keys, name):
    for k in keys:
        if k[0] == name:
            return k[1]
    return None


def _cstr(table, at):
    end = table.find(b'\0', at)
    return table[at:end if end >= 0 else len(table)].decode('latin-1')


def read_personas(acct):
    """The records of an AcctInfo.rdr blob, as dicts."""
    if len(acct) < 12:
        return []
    _one, stable_size, node_ofs = struct.unpack_from('<III', acct, 0)
    table = acct[12:12 + stable_size]
    nodes = acct[node_ofs:]

    def node(at):
        t, flags, count, value = struct.unpack_from('<BBHI', nodes, at)
        return t, count, value

    def value_of(at):
        t, count, value = node(at)
        if t == 1:
            return struct.unpack('<i', struct.pack('<I', value))[0]
        if t == 3:
            return _cstr(table, value)
        if t == 4:
            return [value_of(value + i * 8) for i in range(count)]
        raise ValueError('rdr node type %d' % t)

    root = value_of(0)
    out = []
    for rec in root:
        d = {}
        i = 0
        while i + 1 < len(rec):
            key, val = rec[i], rec[i + 1]
            if key == 'PROFILES':
                d['profileChecksum'] = val[1] if len(val) > 1 else []
                d['profileInfo'] = val[3] if len(val) > 3 else []
            else:
                d[key] = val[0] if isinstance(val, list) and len(val) == 1 else val
            i += 2
        out.append(dict(host=d.get('HOST', ''), name=d.get('NAME', ''), town=d.get('TOWN', ''),
                        gender=d.get('GENDER', 0), port=d.get('PORT', 10075), password=d.get('PASSWORD', ''),
                        savePassword=int(d.get('SAVEPASSWORD', 0)), profileChecksum=d.get('profileChecksum', []),
                        profileInfo=d.get('profileInfo', [])))
    return out


def read_card_file(raw):
    head, keys = parse_zar(unscramble(raw))
    acct = find_key(keys, 'AcctInfo.rdr')
    return read_personas(acct if acct is not None else b'')


# ---- the encoder: the layout launcher/card_save.cpp writes, byte for byte ----

def _align16(n):
    return (n + 15) & ~15


class _Strings(object):
    def __init__(self):
        self.data = bytearray()
        self.at = {}

    def intern(self, s):
        if s not in self.at:
            self.at[s] = len(self.data)
            self.data += s.encode('latin-1') + b'\0'
        return self.at[s]


def build_zar(tree):
    """A version-2 archive for a (name, data, [children]) tree: appversion 14, padding 16, crc 0, flags 0 and
    stable_ofs 0, the string table led by an empty string (the root's name_ofs 0 reads as unnamed), each key's data
    at a 16-aligned offset. Not the game's bytes (its stable_ofs is a guest address); it re-parses to the same tree."""
    keys = []

    def walk(node):
        keys.append(node)
        for child in node[2]:
            walk(child)
    walk(tree)
    table = _Strings()
    table.intern('')
    name_ofs, data_ofs, cursor = [], [], 0
    for i, (name, data, _children) in enumerate(keys):
        name_ofs.append(table.intern(name) if i else 0)
        data_ofs.append(cursor if data else 0)
        if data:
            cursor = _align16(cursor + len(data))
    key_ofs = HEAD_BYTES + len(table.data)
    data0 = _align16(key_ofs + len(keys) * 16)
    out = bytearray(data0 + cursor)
    head = [0] * 25
    head[1], head[2], head[4] = len(keys), len(table.data), 16
    head[21], head[23], head[24] = cursor, 14, ZAR_VERSION_2
    struct.pack_into('<25i', out, 0, *head)
    out[HEAD_BYTES:HEAD_BYTES + len(table.data)] = table.data
    for i, (name, data, children) in enumerate(keys):
        struct.pack_into('<iIIi', out, key_ofs + i * 16, name_ofs[i], data_ofs[i], len(data), len(children))
        if data:
            out[data0 + data_ofs[i]:data0 + data_ofs[i] + len(data)] = data
    return bytes(out)


def write_personas(personas):
    """The AcctInfo.rdr blob for records shaped as read_personas returns them. The game's layout: a list's children
    are one block allocated when the list is reached, depth-first in child order; strings interned as reached; flags
    0 on every node (no sharing). One record, or none, is the game's own bytes."""
    def rec(p):
        sums = (list(p.get('profileChecksum') or []) + [0] * 16)[:16]
        return [('s', 'HOST'), [('s', p.get('host', ''))], ('s', 'NAME'), [('s', p.get('name', ''))],
                ('s', 'TOWN'), [('s', p.get('town', ''))], ('s', 'GENDER'), [('i', p.get('gender', 0))],
                ('s', 'PORT'), [('i', p.get('port', 10075))], ('s', 'PASSWORD'), [('s', p.get('password', ''))],
                ('s', 'SAVEPASSWORD'), [('i', 1 if p.get('savePassword', 1) else 0)],
                ('s', 'PROFILES'), [('s', 'PROFILE_CHECKSUM'), [('i', v) for v in sums], ('s', 'PROFILE_INFO'), []]]
    root = [rec(p) for p in personas]
    table = _Strings()
    nodes = [None]

    def fill(v, index):
        if isinstance(v, list):
            base = len(nodes)
            nodes[index] = (4, len(v), base * 8)
            nodes.extend([None] * len(v))
            for n, child in enumerate(v):
                fill(child, base + n)
        elif v[0] == 'i':
            nodes[index] = (1, 0, v[1] & 0xFFFFFFFF)
        else:
            nodes[index] = (3, 0, table.intern(v[1]))
    fill(root, 0)
    node_ofs = _align16(12 + len(table.data))
    out = bytearray(node_ofs + len(nodes) * 8)
    struct.pack_into('<III', out, 0, 1, len(table.data), node_ofs)
    out[12:12 + len(table.data)] = table.data
    for i, (t, count, value) in enumerate(nodes):
        struct.pack_into('<BBHI', out, node_ofs + i * 8, t, 0, count, value)
    return bytes(out)


def write_card_file(raw, personas):
    """`raw` (a card file) with its CAcctDB/AcctInfo.rdr replaced by write_personas(personas), rebuilt and scrambled;
    every other key's bytes kept. launcher/card_save.h's writeCardFile starts from virgin.bin decoded when it has no
    file, so write_card_file(virgin.bin, p) is its writeCardFile({}, p)."""
    _head, keys = parse_zar(unscramble(raw))
    tree = key_tree(keys)
    acct = write_personas(personas)

    def replace(node, parent):
        name, data, children = node
        if name == 'AcctInfo.rdr' and parent == 'CAcctDB':
            data = acct
        return (name, data, [replace(c, name) for c in children])
    return scramble(build_zar(replace(tree, None)))


def _read(path):
    with open(path, 'rb') as f:
        return f.read()


def main(argv):
    if len(argv) == 3 and argv[1] == '--dump':
        print(json.dumps(read_card_file(_read(argv[2])), indent=2))
        return 0
    if len(argv) == 3 and argv[1] == '--keys':
        head, keys = parse_zar(unscramble(_read(argv[2])))
        print(json.dumps(head))
        for name, data, children in keys:
            print('%-24s %6d bytes  %d children' % (name or '(root)', len(data), children))
        return 0
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
