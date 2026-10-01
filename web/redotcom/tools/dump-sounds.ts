import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Zar } from '@s2u/archive';
import { parseBankFile, renderSound, SampleCache, type SoundBank } from '@s2u/sound';

/**
 * Renders a map's 989snd sounds to WAV files and prints each one's length, peak and RMS, so a decode can be checked
 * without a speaker: a wrong ADPCM filter is noise (a flat spectrum at full scale), a wrong pitch the wrong length, a
 * wrong volume a peak far off the rest (web/redotcom/docs/research/81 §11).
 *
 * Usage: npm run dump-sounds -- [MP2] [out-dir] [.STEP_STONE .M4A1_SIL ...]
 *   The map's `_am`, `_fx` and `_vc` banks out of `test-fixtures/RUN/SOUNDS/BNKSTORE.ZAR`; with no names, every
 *   sound of the three. The WAVs are 48 kHz stereo 16-bit, the console's mix of the sound alone at full volume and
 *   the sound's own pan. They are the owner's disc's audio: write them outside the repository (the default is
 *   `test-fixtures/sounds/<map>/`, which git ignores).
 */
const web = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const map = (args[0] ?? 'MP2').toUpperCase();
const out = args[1] ?? join(web, 'test-fixtures/sounds', map);
const wanted = args.slice(2);
const store = join(web, 'test-fixtures/RUN/SOUNDS/BNKSTORE.ZAR');
if (!existsSync(store)) { console.error(`no ${store} (run npm run extract-maps)`); process.exit(2); }

/** 16-bit stereo PCM WAV. */
function wav(left: Float32Array, right: Float32Array, rate: number): Uint8Array {
  const n = left.length, bytes = new Uint8Array(44 + n * 4), dv = new DataView(bytes.buffer);
  const tag = (o: number, s: string): void => { for (let i = 0; i < 4; i++) bytes[o + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); tag(36, 'data');
  dv.setUint32(40, n * 4, true);
  const s16 = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  for (let i = 0; i < n; i++) { dv.setInt16(44 + 4 * i, s16(left[i]!), true); dv.setInt16(46 + 4 * i, s16(right[i]!), true); }
  return bytes;
}

const zar = Zar.parse(new Uint8Array(readFileSync(store)));
mkdirSync(out, { recursive: true });
const seeded = (seed: number) => (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
let written = 0;
for (const kind of ['am', 'fx', 'vc']) {
  const key = zar.root.children.find((k) => k.name.toLowerCase() === `${map}_${kind}.bnk`.toLowerCase());
  if (!key) continue;
  const bank: SoundBank = parseBankFile(zar.data(key));
  const samples = new SampleCache(bank.vag);
  const byIndex = new Map([...bank.names].map(([name, i]) => [i, name]));
  for (let i = 0; i < bank.sounds.length; i++) {
    const name = byIndex.get(i) ?? `#${i}`;
    if (wanted.length > 0 && !wanted.includes(name) && !wanted.includes(name.trim())) continue;
    const r = renderSound(bank, i, samples, { random: seeded(i + 1) });
    let sum = 0;
    for (let n = 0; n < r.left.length; n++) sum += r.left[n]! * r.left[n]! + r.right[n]! * r.right[n]!;
    const rms = Math.sqrt(sum / Math.max(1, 2 * r.left.length));
    const file = `${bank.name}_${String(i).padStart(3, '0')}_${name.trim().replace(/[^A-Za-z0-9_]/g, '')}.wav`;
    if (r.left.length > 0) { writeFileSync(join(out, file), wav(r.left, r.right, r.sampleRate)); written++; }
    console.log(`${bank.name} ${String(i).padStart(3)} ${name.padEnd(16)} ${(r.left.length / r.sampleRate).toFixed(3)} s  ` +
      `voices ${r.voices}  peak ${r.peak.toFixed(3)}  rms ${rms.toFixed(4)}`);
  }
}
console.log(`${written} WAV files in ${out}`);
