/**
 * The GS state every texture's bind packet sets, tallied across every extracted map.
 *
 * A texture record ends in a 9-quadword bind packet (36 §5), and inside it is a GIF A+D block that writes
 * ALPHA_1, TEX1_1, TEX0_1, TEST_1 and CLAMP_1. That is the per-draw GS state the viewer used to guess
 * from the pixels: the blend equation, the alpha test, the filtering and mipmap levels, and the wrap
 * modes. This prints each register decoded, the distinct combinations with how many textures use each,
 * and the texture names behind the rare ones.
 *
 *   npx tsx tools/dump-gsstate.ts            # all 22 maps, tallied
 *   npx tsx tools/dump-gsstate.ts MP2        # one map, every texture listed
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseZdb, zdbMember, Zar, Reader, type ZarKey } from '@s2u/archive';

const only = process.argv[2];
const web = resolve(import.meta.dirname, '..');
const dir = resolve(web, 'public/maps/RUN');
const archives = only ? [only] : readdirSync(dir).filter((f) => /\.ZDB$/i.test(f)).map((f) => f.replace(/\.ZDB$/i, ''));

const HEADER = 16, PIXEL_PREFIX = 16, BIND_QWC = 9;

const CH = ['Cs', 'Cd', '0', '0'], CC = ['As', 'Ad', 'FIX', '?'];
const alpha = (v: bigint): string => {
  const a = Number(v & 3n), b = Number((v >> 2n) & 3n), c = Number((v >> 4n) & 3n), d = Number((v >> 6n) & 3n);
  const fix = Number((v >> 32n) & 0xffn);
  return `ALPHA (${CH[a]}-${CH[b]})*${CC[c]}${c === 2 ? `[${fix}]` : ''}+${CH[d]}`;
};
const FILT = ['NEAREST', 'LINEAR', 'NEAREST_MIPMAP_NEAREST', 'NEAREST_MIPMAP_LINEAR', 'LINEAR_MIPMAP_NEAREST', 'LINEAR_MIPMAP_LINEAR', '?6', '?7'];
const tex1 = (v: bigint): string => {
  const lcm = Number(v & 1n), mxl = Number((v >> 2n) & 7n), mmag = Number((v >> 5n) & 1n), mmin = Number((v >> 6n) & 7n);
  const mtba = Number((v >> 9n) & 1n), l = Number((v >> 19n) & 3n), k = Number((v >> 32n) & 0xfffn);
  return `TEX1 mag=${mmag ? 'LINEAR' : 'NEAREST'} min=${FILT[mmin]} mxl=${mxl} lcm=${lcm} mtba=${mtba} L=${l} K=${k}`;
};
const ATST = ['NEVER', 'ALWAYS', 'LESS', 'LEQUAL', 'EQUAL', 'GEQUAL', 'GREATER', 'NOTEQUAL'];
const AFAIL = ['KEEP', 'FB_ONLY', 'ZB_ONLY', 'RGB_ONLY'];
const ZTST = ['NEVER', 'ALWAYS', 'GEQUAL', 'GREATER'];
const test = (v: bigint): string => {
  const ate = Number(v & 1n), atst = Number((v >> 1n) & 7n), aref = Number((v >> 4n) & 0xffn), afail = Number((v >> 12n) & 3n);
  const date = Number((v >> 14n) & 1n), datm = Number((v >> 15n) & 1n), zte = Number((v >> 16n) & 1n), ztst = Number((v >> 17n) & 3n);
  return `TEST ate=${ate}${ate ? ` ${ATST[atst]} ${aref} fail=${AFAIL[afail]}` : ''} date=${date}${date ? `/${datm}` : ''} zte=${zte} ${ZTST[ztst]}`;
};
const WRAP = ['REPEAT', 'CLAMP', 'REGION_CLAMP', 'REGION_REPEAT'];
const clamp = (v: bigint): string => {
  const wms = Number(v & 3n), wmt = Number((v >> 2n) & 3n);
  const minu = Number((v >> 4n) & 0x3ffn), maxu = Number((v >> 14n) & 0x3ffn), minv = Number((v >> 24n) & 0x3ffn), maxv = Number((v >> 34n) & 0x3ffn);
  const region = wms >= 2 || wmt >= 2 ? ` u=${minu}..${maxu} v=${minv}..${maxv}` : '';
  return `CLAMP s=${WRAP[wms]} t=${WRAP[wmt]}${region}`;
};
const DECODE: Record<number, (v: bigint) => string> = { 0x42: alpha, 0x14: tex1, 0x47: test, 0x08: clamp };

const tally = new Map<string, { n: number; names: string[] }>();
let textures = 0, noPacket = 0;
for (const archive of archives) {
  const bytes = readFileSync(resolve(dir, `${archive}.ZDB`));
  const toc = parseZdb(bytes);
  // Every asset library the archive holds: the map's own and the shared ones.
  const members = toc.map((e) => e.name).filter((n) => /_TXR\.ZED$/i.test(n));
  for (const member of members) {
    let txr: Zar;
    try { txr = Zar.parse(zdbMember(bytes, toc, member)); } catch { continue; }
    for (const key of (txr.find('textures')?.children ?? []) as ZarKey[]) {
      const texdat = txr.child(key, 'texdat');
      if (!texdat) continue;
      let data: Uint8Array;
      try { data = txr.data(texdat); } catch { continue; }
      const r = new Reader(data);
      if (r.length < HEADER) continue;
      textures++;
      const size = r.u32(4);
      const flags = r.u32(12);
      const recFlags = ['transparent', 'palettized', 'mipchild', 'bumpmap', 'bilinear', 'transp1bit', 'dynamic', 'context']
        .filter((_, i) => ((flags >>> (24 + i)) & 1) === 1).join(',');
      const at = HEADER + PIXEL_PREFIX + size;
      const parts: string[] = [];
      for (let o = at; o + 16 <= Math.min(at + BIND_QWC * 16, r.length); o += 16) {
        const id = Number(r.u64(o + 8) & 0xffn);
        const decode = DECODE[id];
        if (decode) parts.push(decode(r.u64(o)));
      }
      if (parts.length === 0) { noPacket++; continue; }
      const line = `${parts.join(' | ')} || rec:${recFlags || '-'}`;
      const name = `${archive}/${member.replace(/_TXR\.ZED$/i, '')}/${key.name}`;
      if (only) console.log(`${key.name.padEnd(28)} ${line}`);
      const t = tally.get(line) ?? { n: 0, names: [] };
      t.n++;
      if (t.names.length < 6) t.names.push(name);
      tally.set(line, t);
    }
  }
}

console.log(`\n${textures} textures over ${archives.length} archive(s), ${noPacket} without a decodable bind packet\n`);
for (const [line, { n, names }] of [...tally.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`${String(n).padStart(5)}  ${line}`);
  if (n <= 12) for (const name of names) console.log(`         ${name}`);
}
