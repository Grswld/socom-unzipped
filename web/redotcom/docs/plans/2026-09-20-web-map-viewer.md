# Web Map Viewer Implementation Plan (M0-M4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser app under `web/` that decodes a SOCOM II multiplayer map (Frostfire first) from the game's own
archives and renders its textured world geometry with a free camera, verified without a human.

**Architecture:** Five TypeScript packages with strictly downward dependencies: `archive` (ZDB, ZAR, rdr, asset
sources) -> `gs` (texture and palette decode) and `mesh` (DMA chain walk, VIF unpack, vertex interpretation) ->
`scene` (world root, scene graph, collision, clutter) -> `viewer` (three.js app). The decoders are pure functions
over `Uint8Array` and run under node for tests and tools; only `viewer` touches the DOM.

**Tech Stack:** Node 24, npm workspaces, TypeScript 5 strict, vitest, Vite, three.js (r186+, `WebGPURenderer` with
WebGL2 fallback), Playwright for rendered-frame checks. No GPL code enters `web/`.

**Spec:** `docs/superpowers/specs/2026-09-20-web-map-viewer-design.md`. Formats: `web/redotcom/docs/research/72-mp-map-archive-anatomy.md`
(cited below as "36 §N"). Both must be read before any task.

## Global Constraints

- Work only in the worktree `C:\projects\socom_pc_web` on branch `feat/web-map-viewer`. Never touch
  `C:\projects\socom_pc` (another agent's tree), never switch branches there, never take `scripts/loop_lock.sh`.
- Disc tree for fixtures: `C:/projects/socom_pc/game/disc` (read-only; env `SOCOM_DISC` overrides). No file from it
  is ever committed: `web/redotcom/public/maps/`, `web/redotcom/test-fixtures/` are git-ignored.
- Every commit: explicit pathspec (`git commit -m "..." -- <paths>`), subject `type(scope): what changed and why`,
  and the trailer lines:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0136bpGoxzLZ4YAcbi8QCR4G
  ```
  No push.
- Tests that need fixtures call `fixture(name)` which returns `null` when the file is absent, and the test then
  `it.skip`s with the message "fixtures absent: run npm run extract-maps". A fresh clone must be green.
- TypeScript `strict: true`, no `any` in `packages/*`, every binary offset commented with its 36 § citation.
- Host load: `npm test` and Vite only; Playwright headless for seconds. No parallel native compiles.
- Real-archive expectations used below (all from 36): MP2.ZDB 53 members; `MP2_GEO.ZED` 10,433 keys;
  `MP2_TXR.ZED` 65 textures; `MP2_PAL.ZED` 53 palettes ids 94..318; `WORL_MDL.ZED` one model `worldmodel`, 123
  chunks, 1,450 DMA tags, VIF histogram NOP 2953 / STCYCL 2389 / UNPACK 2389 / MSCNT 416 / MSCAL 309; Frostfire
  spawns A (796, 100, 614), B (536, 143, 1254) (`docs/research/24`, KNOWN §2); `MetersPerUnit` 0.1.

---

## File structure

Planned (and corrected against what was built, 2026-09-21 — the tree below is the real one; `packet.ts`
was planned and never existed, its work landing in `vif.ts` and `interpret.ts`):

```
web/
  package.json, tsconfig.base.json, vitest.config.ts, playwright.config.ts (.gitignore in repo root)
  packages/archive/src/{bytes.ts, zdb.ts, zar.ts, rdr.ts, assetSource.ts, fsAssetSource.ts, httpAssetSource.ts,
                        mapIndex.ts, node.ts, index.ts}   + test/*.test.ts, test/fixtures.ts
  packages/gs/src/{tex0.ts, texture.ts, palette.ts, paletteTable.ts, decode.ts, index.ts} + test/
  packages/mesh/src/{dma.ts, vif.ts, interpret.ts, meshData.ts, index.ts}, SEMANTICS.md + test/
  packages/scene/src/{worldRoot.ts, sceneGraph.ts, modelLibrary.ts, clutter.ts, collision.ts, spawns.ts,
                      buildScene.ts, index.ts} + test/
  packages/viewer/{index.html, vite.config.ts, src/{main.ts, renderer.ts, camera.ts, ui.ts, worker.ts,
                   loadMap.ts, overlays.ts, world.ts, hook.ts, styles.css}, e2e/viewer.spec.ts}
  tools/{extract-maps.ts, dump-textures.ts, export-gltf.ts, gltf.ts, png.ts}
  README.md
  test-fixtures/ (ignored), public/maps/ (ignored)
```

`bytes.ts` is the one place that reads little-endian scalars (`u8/u16/u32/i32/f32/u64`) and C strings from a
`DataView`; every reader uses it, so an endianness or bounds bug is fixed once.

---

### Task 1: Workspace scaffold (M0)

**Files:**
- Create: `web/package.json`, `web/redotcom/tsconfig.base.json`, `web/vitest.workspace.ts`,
  `web/redotcom/packages/archive/package.json`, `web/redotcom/packages/archive/tsconfig.json`, `web/redotcom/packages/archive/src/bytes.ts`,
  `web/redotcom/packages/archive/src/index.ts`, `web/redotcom/packages/archive/test/bytes.test.ts`, `web/redotcom/packages/archive/test/fixtures.ts`
- Modify: `.gitignore` (repo root)

**Interfaces:**
- Produces: `class Reader` in `bytes.ts`:
  `new Reader(bytes: Uint8Array)`, `.length`, `.u8(o)`, `.u16(o)`, `.u32(o)`, `.i32(o)`, `.f32(o)`, `.u64(o): bigint`,
  `.cstr(o, max)` (NUL-terminated ASCII, at most `max` bytes), `.slice(o, n): Uint8Array` (a view, not a copy),
  all throwing `RangeError` on out-of-bounds. `fixture(name: string): Uint8Array | null` in `test/fixtures.ts`
  reading `web/redotcom/test-fixtures/<name>`.

- [ ] **Step 1: Root workspace files**

`web/package.json`:
```json
{
  "name": "socom-unzipped-web",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*", "tools"],
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -b packages/archive packages/gs packages/mesh packages/scene",
    "extract-maps": "tsx tools/extract-maps.ts",
    "dump-textures": "tsx tools/dump-textures.ts",
    "export-gltf": "tsx tools/export-gltf.ts",
    "dev": "vite --config packages/viewer/vite.config.ts",
    "build": "vite build --config packages/viewer/vite.config.ts"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^3.2.0",
    "tsx": "^4.19.0",
    "vite": "^7.0.0",
    "@playwright/test": "^1.55.0"
  }
}
```
`web/redotcom/tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "strict": true, "noUncheckedIndexedAccess": true, "noImplicitOverride": true,
    "declaration": true, "composite": true, "skipLibCheck": true, "lib": ["ES2022", "DOM"]
  }
}
```
`web/vitest.workspace.ts`:
```ts
export default ['packages/*/vitest.config.ts'];
```
Each package gets `vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
```
`web/redotcom/packages/archive/package.json`:
```json
{ "name": "@s2u/archive", "version": "0.0.0", "type": "module", "main": "src/index.ts", "types": "src/index.ts" }
```
`web/redotcom/packages/archive/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "." }, "include": ["src", "test"] }
```
Append to the repo root `.gitignore`:
```
# web (browser recreation): dependencies, builds, and game data extracted from the owner's disc
/web/node_modules/
/web/**/node_modules/
/web/**/dist/
/web/public/maps/
/web/test-fixtures/
/web/**/playwright-report/
/web/**/test-results/
```

- [ ] **Step 2: Failing test for `Reader`**

`web/redotcom/packages/archive/test/bytes.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Reader } from '../src/bytes';

describe('Reader', () => {
  const bytes = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x41, 0x42, 0x00, 0xff, 0x00, 0x00, 0x80, 0x3f]);
  const r = new Reader(bytes);
  it('reads little-endian scalars', () => {
    expect(r.u8(0)).toBe(1);
    expect(r.u16(0)).toBe(0x0201);
    expect(r.u32(0)).toBe(0x04030201);
    expect(r.i32(4)).toBe(-16758207); // 0xff004241 as signed
    expect(r.f32(8)).toBeCloseTo(1.0);
  });
  it('reads a NUL-terminated string bounded by max', () => {
    expect(r.cstr(4, 4)).toBe('AB');
    expect(r.cstr(4, 1)).toBe('A');
  });
  it('slices as a view', () => {
    const s = r.slice(4, 2);
    expect(Array.from(s)).toEqual([0x41, 0x42]);
    expect(s.buffer).toBe(bytes.buffer);
  });
  it('throws on out-of-bounds', () => {
    expect(() => r.u32(10)).toThrow(RangeError);
    expect(() => r.slice(10, 4)).toThrow(RangeError);
  });
});
```

- [ ] **Step 3: Run, expect failure** — `cd web && npm install && npx vitest run packages/archive` → FAIL (module not found).

- [ ] **Step 4: Implement `bytes.ts`**

```ts
/** Little-endian scalar reads over a Uint8Array view. Every archive reader goes through this class. */
export class Reader {
  private readonly view: DataView;
  constructor(public readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get length(): number { return this.bytes.byteLength; }
  private check(o: number, n: number): void {
    if (o < 0 || o + n > this.bytes.byteLength) throw new RangeError(`read ${n} at ${o} beyond ${this.bytes.byteLength}`);
  }
  u8(o: number): number { this.check(o, 1); return this.view.getUint8(o); }
  u16(o: number): number { this.check(o, 2); return this.view.getUint16(o, true); }
  u32(o: number): number { this.check(o, 4); return this.view.getUint32(o, true); }
  i32(o: number): number { this.check(o, 4); return this.view.getInt32(o, true); }
  i16(o: number): number { this.check(o, 2); return this.view.getInt16(o, true); }
  f32(o: number): number { this.check(o, 4); return this.view.getFloat32(o, true); }
  u64(o: number): bigint { this.check(o, 8); return this.view.getBigUint64(o, true); }
  cstr(o: number, max: number): string {
    this.check(o, max);
    let end = o;
    while (end < o + max && this.bytes[end] !== 0) end++;
    return String.fromCharCode(...this.bytes.subarray(o, end));
  }
  slice(o: number, n: number): Uint8Array { this.check(o, n); return this.bytes.subarray(o, o + n); }
}
```
`src/index.ts`: `export * from './bytes';`

`test/fixtures.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures');
export const FIXTURES_ABSENT = 'fixtures absent: run npm run extract-maps';
export function fixture(name: string): Uint8Array | null {
  const p = resolve(root, name);
  return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
}
```

- [ ] **Step 5: Run, expect pass** — `npx vitest run packages/archive` → 4 passed.

- [ ] **Step 6: Commit**
```bash
git add .gitignore web/package.json web/package-lock.json web/redotcom/tsconfig.base.json web/vitest.workspace.ts web/redotcom/packages/archive
git commit -m "build(web): the browser recreation's workspace -- npm workspaces, vitest, strict TypeScript, and the one little-endian Reader every archive decoder uses (M0)" -- .gitignore web/package.json web/package-lock.json web/redotcom/tsconfig.base.json web/vitest.workspace.ts web/redotcom/packages/archive
```
(Add the trailer lines to every commit message; omitted from the snippets below for brevity.)

---

### Task 2: `extract-maps` tool (M0)

**Files:**
- Create: `web/redotcom/tools/package.json`, `web/redotcom/tools/tsconfig.json`, `web/redotcom/tools/extract-maps.ts`

**Interfaces:**
- Produces: `web/redotcom/test-fixtures/RUN/MP2.ZDB` (and MP6, MP72) and `web/redotcom/public/maps/RUN/<all 22 MP*.ZDB>`; also
  `web/redotcom/public/maps/index.json` = `["RUN/MP1.ZDB", ...]` sorted. Paths mirror the disc so both asset sources
  answer the same `read("RUN/MP2.ZDB")`.

- [ ] **Step 1: Write the tool**

`web/redotcom/tools/package.json`: `{ "name": "@s2u/tools", "version": "0.0.0", "type": "module", "dependencies": { "@s2u/archive": "*", "@s2u/gs": "*", "@s2u/mesh": "*", "@s2u/scene": "*" } }`
(`gs`, `mesh`, `scene` are created in later tasks; npm tolerates a missing workspace dep only once they exist, so
list only `@s2u/archive` now and add the others in the task that creates each package.)

`web/redotcom/tools/extract-maps.ts`:
```ts
import { copyFileSync, mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const disc = process.env.SOCOM_DISC ?? 'C:/projects/socom_pc/game/disc';
const web = resolve(import.meta.dirname, '..');
const run = join(disc, 'RUN');
if (!existsSync(run)) { console.error(`no disc tree at ${disc} (set SOCOM_DISC)`); process.exit(2); }

const mp = readdirSync(run).filter((f) => /^MP\d+\.ZDB$/.test(f)).sort();
const publicRun = join(web, 'public/maps/RUN');
const fixtureRun = join(web, 'test-fixtures/RUN');
mkdirSync(publicRun, { recursive: true });
mkdirSync(fixtureRun, { recursive: true });
for (const f of mp) copyFileSync(join(run, f), join(publicRun, f));
for (const f of ['MP2.ZDB', 'MP6.ZDB', 'MP72.ZDB']) copyFileSync(join(run, f), join(fixtureRun, f));
writeFileSync(join(web, 'public/maps/index.json'), JSON.stringify(mp.map((f) => `RUN/${f}`), null, 2));
console.log(`copied ${mp.length} archives to public/maps, 3 fixtures`);
```

- [ ] **Step 2: Run it** — `cd web && npm run extract-maps` → `copied 22 archives to public/maps, 3 fixtures`;
  `git status --short` shows nothing under `web/public` or `web/redotcom/test-fixtures` (ignored).

- [ ] **Step 3: Commit**
```bash
git commit -m "build(web): extract-maps copies the 22 MP archives from the owner's disc tree into the served and fixture folders, both git-ignored (M0)" -- web/redotcom/tools/package.json web/redotcom/tools/tsconfig.json web/redotcom/tools/extract-maps.ts web/package-lock.json
```

---

### Task 3: ZDB reader (M1)

**Files:**
- Create: `web/redotcom/packages/archive/src/zdb.ts`, `web/redotcom/packages/archive/test/zdb.test.ts`
- Modify: `web/redotcom/packages/archive/src/index.ts`

**Interfaces:**
- Produces: `interface ZdbEntry { name: string; offset: number; size: number }`,
  `function parseZdb(bytes: Uint8Array): ZdbEntry[]`,
  `function zdbMember(bytes: Uint8Array, entries: ZdbEntry[], suffix: string): Uint8Array` (the member whose
  disc path ends with `suffix`, case-insensitive, e.g. `"MP2_GEO.ZED"`; throws if absent or ambiguous).

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { parseZdb, zdbMember } from '../src/zdb';
import { fixture, FIXTURES_ABSENT } from './fixtures';

function syntheticZdb(): Uint8Array {
  // 36 §1: 0xA0 header, count @0x98, entrySize=0x5C @0x9C, 92-byte entries from 0xA0, data 2048-aligned.
  const entries = [{ name: 'RUN\\MP\\MP2\\A.ZED', data: [1, 2, 3] }, { name: 'RUN\\COMMON\\B.ZAR', data: [9] }];
  const dataStart = 2048;
  const out = new Uint8Array(dataStart + 2048 * entries.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0x98, entries.length, true);
  dv.setUint32(0x9c, 0x5c, true);
  entries.forEach((e, i) => {
    const o = 0xa0 + i * 0x5c;
    dv.setUint32(o, 0x5c, true);
    for (let k = 0; k < e.name.length; k++) out[o + 4 + k] = e.name.charCodeAt(k);
    dv.setUint32(o + 68, dataStart + i * 2048, true);
    dv.setUint32(o + 72, e.data.length, true);
    out.set(e.data, dataStart + i * 2048);
  });
  return out;
}

describe('parseZdb', () => {
  it('reads the TOC of a synthetic archive', () => {
    const z = parseZdb(syntheticZdb());
    expect(z).toEqual([
      { name: 'RUN\\MP\\MP2\\A.ZED', offset: 2048, size: 3 },
      { name: 'RUN\\COMMON\\B.ZAR', offset: 4096, size: 1 },
    ]);
    expect(Array.from(zdbMember(syntheticZdb(), z, 'a.zed'))).toEqual([1, 2, 3]);
    expect(() => zdbMember(syntheticZdb(), z, 'nope')).toThrow(/nope/);
  });
  it('rejects a header without the 0x5C entry size', () => {
    const bad = syntheticZdb(); new DataView(bad.buffer).setUint32(0x9c, 0x60, true);
    expect(() => parseZdb(bad)).toThrow(/entrySize/);
  });
  const mp2 = fixture('RUN/MP2.ZDB');
  it.skipIf(!mp2)('Frostfire has 53 members, all 2048-aligned, and MP2_GEO.ZED is 445,856 bytes', () => {
    const z = parseZdb(mp2!);
    expect(z.length).toBe(53);
    for (const e of z) expect(e.offset % 2048).toBe(0);
    expect(zdbMember(mp2!, z, 'MP2_GEO.ZED').byteLength).toBe(445_856);
  });
});
```

- [ ] **Step 2: Run, expect failure** (module not found).

- [ ] **Step 3: Implement**

```ts
import { Reader } from './bytes';
export interface ZdbEntry { name: string; offset: number; size: number }
const HEADER = 0xa0, COUNT_AT = 0x98, ENTRY_SIZE_AT = 0x9c, ENTRY_SIZE = 0x5c; // 36 §1
export function parseZdb(bytes: Uint8Array): ZdbEntry[] {
  const r = new Reader(bytes);
  const entrySize = r.u32(ENTRY_SIZE_AT);
  if (entrySize !== ENTRY_SIZE) throw new Error(`ZDB entrySize ${entrySize}, expected 0x5C`);
  const count = r.u32(COUNT_AT);
  const out: ZdbEntry[] = [];
  for (let i = 0; i < count; i++) {
    const o = HEADER + i * ENTRY_SIZE;
    if (r.u32(o) !== ENTRY_SIZE) throw new Error(`ZDB entry ${i} size field ${r.u32(o)}`);
    const name = r.cstr(o + 4, 64);           // char name[64], garbage after the NUL
    const offset = r.u32(o + 68);              // absolute, 2048-aligned
    const size = r.u32(o + 72);
    if (offset + size > bytes.byteLength) throw new Error(`ZDB entry ${name} runs past the file`);
    out.push({ name, offset, size });
  }
  return out;
}
export function zdbMember(bytes: Uint8Array, entries: ZdbEntry[], suffix: string): Uint8Array {
  const s = suffix.toLowerCase();
  const hits = entries.filter((e) => e.name.toLowerCase().endsWith(s));
  if (hits.length !== 1) throw new Error(`ZDB member ${suffix}: ${hits.length} matches`);
  const e = hits[0]!;
  return bytes.subarray(e.offset, e.offset + e.size);
}
```
Export from `index.ts`.

- [ ] **Step 4: Run, expect pass** (3 tests, the fixture one running because Task 2 populated fixtures).
- [ ] **Step 5: Commit** — `feat(web/archive): the ZDB table of contents reader, verified on Frostfire's 53 members (M1)`.

---

### Task 4: ZAR/ZED reader (M1)

**Files:**
- Create: `web/redotcom/packages/archive/src/zar.ts`, `web/redotcom/packages/archive/test/zar.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface ZarKey { name: string; offset: number; size: number; children: ZarKey[] }
  class Zar {
    static parse(bytes: Uint8Array): Zar;
    readonly root: ZarKey; readonly keyCount: number; readonly version: number;
    data(key: ZarKey): Uint8Array;              // view into the data blob
    find(path: string): ZarKey | undefined;     // "models/alaska4d_x/nparams", names matched exactly, from root's children
    child(key: ZarKey, name: string): ZarKey | undefined;
    walk(visit: (key: ZarKey, depth: number) => void): void;  // pre-order
  }
  ```

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { Zar } from '../src/zar';
import { parseZdb, zdbMember } from '../src/zdb';
import { fixture } from './fixtures';

/** 36 §1: 100-byte head, string table, 16-byte pre-order keys, align to padding, data blob. version 0x20002. */
function syntheticZar(): Uint8Array {
  const names = ['root', 'textures', 'a.tif', 'texdat'];
  const stable = new Uint8Array(names.join('\0').length + 1);
  let p = 0; for (const n of names) { for (const c of n) stable[p++] = c.charCodeAt(0); stable[p++] = 0; }
  const nameOfs: number[] = []; p = 0; for (const n of names) { nameOfs.push(p); p += n.length + 1; }
  const keys = [ // name_ofs, offset, size, child_count  (pre-order: root{textures{a.tif{texdat}}})
    [nameOfs[0]!, 0, 0, 1], [nameOfs[1]!, 0, 0, 1], [nameOfs[2]!, 0, 0, 1], [nameOfs[3]!, 0x10, 4, 0],
  ];
  const head = 100, stableAt = head, keysAt = stableAt + stable.length, padding = 16;
  const dataAt = Math.ceil((keysAt + 16 * keys.length) / padding) * padding;
  const out = new Uint8Array(dataAt + 0x20);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0, true);                 // flags
  dv.setUint32(4, keys.length, true);       // key_count
  dv.setUint32(8, stable.length, true);     // stable_size
  dv.setUint32(12, 0x1000, true);           // stable_ofs (the address the table was packed at; name_ofs is relative to it)
  dv.setUint32(16, padding, true);          // padding
  dv.setUint32(84, 0x20, true);             // data_size
  dv.setUint32(96, 0x20002, true);          // version
  out.set(stable, stableAt);
  keys.forEach((k, i) => { const o = keysAt + i * 16;
    dv.setInt32(o, 0x1000 + k[0]!, true); dv.setUint32(o + 4, k[1]!, true); dv.setUint32(o + 8, k[2]!, true); dv.setInt32(o + 12, k[3]!, true); });
  out.set([0xde, 0xad, 0xbe, 0xef], dataAt + 0x10);
  return out;
}

describe('Zar', () => {
  it('parses a synthetic v2 archive and resolves paths', () => {
    const z = Zar.parse(syntheticZar());
    expect(z.keyCount).toBe(4);
    const texdat = z.find('textures/a.tif/texdat');
    expect(texdat?.size).toBe(4);
    expect(Array.from(z.data(texdat!))).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(z.find('textures/missing')).toBeUndefined();
  });
  it('rejects a key tree that does not consume exactly key_count records', () => {
    const bad = syntheticZar(); new DataView(bad.buffer).setUint32(4, 5, true);
    expect(() => Zar.parse(bad)).toThrow(/key_count/);
  });
  const mp2 = fixture('RUN/MP2.ZDB');
  it.skipIf(!mp2)('Frostfire: MP2_GEO.ZED has 10,433 keys, MP2_TXR.ZED lists 65 textures, WORL_MDL.ZED has worldmodel with 123 chunks', () => {
    const toc = parseZdb(mp2!);
    const geo = Zar.parse(zdbMember(mp2!, toc, 'MP2_GEO.ZED'));
    expect(geo.keyCount).toBe(10_433);
    const txr = Zar.parse(zdbMember(mp2!, toc, 'MP2_TXR.ZED'));
    expect(txr.find('textures')!.children.length).toBe(65);
    const worl = Zar.parse(zdbMember(mp2!, toc, 'WORL_MDL.ZED'));
    const world = worl.find('worldmodel')!;
    expect(world.size).toBe(485_600);
    expect(world.children.length).toBe(123);
    expect(world.children[0]!.name).toBe('N000_000');
  });
});
```
(If the real root key's children are not directly `textures` / `worldmodel`, print `z.root` once and adjust the
`find` paths to the real tree recorded in the scratch dump `MP2_tree.txt`; the counts above are from 36 §2.)

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement**

```ts
import { Reader } from './bytes';
export interface ZarKey { name: string; offset: number; size: number; children: ZarKey[] }
const HEAD = 100, V2 = 0x20002; // 36 §1
export class Zar {
  private constructor(readonly root: ZarKey, readonly keyCount: number, readonly version: number,
                      private readonly blob: Uint8Array) {}
  static parse(bytes: Uint8Array): Zar {
    const r = new Reader(bytes);
    const flags = r.u32(0), keyCount = r.u32(4), stableSize = r.u32(8), stableOfs = r.u32(12), padding = r.u32(16);
    const dataSize = r.u32(84), version = r.u32(96);
    if (version !== V2) throw new Error(`ZAR version 0x${version.toString(16)}, only 0x20002 supported`);
    if (flags !== 0) throw new Error(`ZAR flags ${flags}: securified archives are not supported`);
    const stableAt = HEAD, keysAt = stableAt + stableSize;
    const dataAt = Math.ceil((keysAt + 16 * keyCount) / padding) * padding;
    const blob = r.slice(dataAt, Math.min(dataSize, bytes.byteLength - dataAt));
    let i = 0;
    const readKey = (): ZarKey => {
      if (i >= keyCount) throw new Error(`ZAR key tree overran key_count ${keyCount}`);
      const o = keysAt + 16 * i++;
      const nameOfs = r.i32(o) - stableOfs;     // relative to the address the table was packed at
      const name = r.cstr(stableAt + nameOfs, stableSize - nameOfs);
      const key: ZarKey = { name, offset: r.u32(o + 4), size: r.u32(o + 8), children: [] };
      const n = r.i32(o + 12);
      for (let c = 0; c < n; c++) key.children.push(readKey());
      return key;
    };
    const root = readKey();
    if (i !== keyCount) throw new Error(`ZAR key tree consumed ${i} of key_count ${keyCount}`);
    return new Zar(root, keyCount, version, blob);
  }
  data(key: ZarKey): Uint8Array { // offsets are relative to the data blob (36 §1)
    if (key.offset + key.size > this.blob.byteLength) throw new RangeError(`key ${key.name} outside data blob`);
    return this.blob.subarray(key.offset, key.offset + key.size);
  }
  child(key: ZarKey, name: string): ZarKey | undefined { return key.children.find((k) => k.name === name); }
  find(path: string): ZarKey | undefined {
    let k: ZarKey | undefined = this.root;
    for (const part of path.split('/')) { if (!k) return undefined; k = this.child(k, part); }
    return k;
  }
  walk(visit: (key: ZarKey, depth: number) => void): void {
    const rec = (k: ZarKey, d: number) => { visit(k, d); for (const c of k.children) rec(c, d + 1); };
    rec(this.root, 0);
  }
}
```

- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(web/archive): the ZAR/ZED v2 reader -- pre-order key tree, blob-relative data, exact key_count, verified on Frostfire's geometry, texture and world archives (M1)`.

---

### Task 5: compiled `.rdr` reader and the map index (M1)

**Files:**
- Create: `web/redotcom/packages/archive/src/rdr.ts`, `web/redotcom/packages/archive/src/mapIndex.ts`, `web/redotcom/packages/archive/src/assetSource.ts`,
  `web/redotcom/packages/archive/src/fsAssetSource.ts`, `web/redotcom/packages/archive/test/rdr.test.ts`, `web/redotcom/packages/archive/test/mapIndex.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type RdrNode = string | RdrNode[];
  function parseRdr(bytes: Uint8Array): RdrNode;                  // the root list
  function rdrGet(node: RdrNode, key: string): RdrNode | undefined; // first child list whose first element is `key`; returns that list's remainder (a list) or the single value
  interface AssetSource { list(): Promise<string[]>; read(path: string): Promise<Uint8Array> }  // paths "RUN/MP2.ZDB", forward slashes
  class FsAssetSource implements AssetSource { constructor(root: string) }                     // node only
  interface MapInfo { archive: string /* "MP2" */; path: string /* "RUN/MP2.ZDB" */; name: string /* "FROSTFIRE" */ }
  async function listMaps(source: AssetSource): Promise<MapInfo[]>  // sorted by numeric archive id
  ```

- [ ] **Step 1: Failing tests**

`test/rdr.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseRdr, rdrGet } from '../src/rdr';
import { parseZdb, zdbMember } from '../src/zdb';
import { Zar } from '../src/zar';
import { fixture } from './fixtures';

/** 36 §6: {u32 version=1; u32 string_table_size; u32 node_array_offset}, string table, 8-byte nodes
 *  {u32 (type:8, isclone:1, packed:1, unused:6, length:16); u32 value}. Strings: value = byte offset from 12.
 *  Lists: value = byte offset from node_array_offset to the first of `length` children. Node type: 0 = list, 1 = string
 *  (confirm against the scratch rdr.py; if the type codes differ, the constants in rdr.ts change, not the tests). */
function syntheticRdr(): Uint8Array {
  // (description "FROSTFIRE")  as root list [ list[ str, str ] ]
  const strings = ['description', 'FROSTFIRE'];
  const table = new Uint8Array(strings.join('\0').length + 1);
  let p = 0; for (const s of strings) { for (const c of s) table[p++] = c.charCodeAt(0); table[p++] = 0; }
  const nodeArrayAt = 12 + table.length;
  const nodes: [number, number, number][] = [ // [type, length, value]
    [0, 1, 8],      // root list: 1 child at node byte 8
    [0, 2, 16],     // (description "FROSTFIRE"): 2 children at node byte 16
    [1, 0, 0],      // "description"  -> string table offset 0
    [1, 0, 12],     // "FROSTFIRE"    -> string table offset 12
  ];
  const out = new Uint8Array(nodeArrayAt + 8 * nodes.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 1, true); dv.setUint32(4, table.length, true); dv.setUint32(8, nodeArrayAt, true);
  out.set(table, 12);
  nodes.forEach(([type, length, value], i) => {
    dv.setUint32(nodeArrayAt + 8 * i, (type & 0xff) | (length << 16), true);
    dv.setUint32(nodeArrayAt + 8 * i + 4, value, true);
  });
  return out;
}

describe('parseRdr', () => {
  it('decodes a synthetic script', () => {
    const root = parseRdr(syntheticRdr());
    expect(root).toEqual([['description', 'FROSTFIRE']]);
    expect(rdrGet(root, 'description')).toBe('FROSTFIRE');
  });
  const mp2 = fixture('RUN/MP2.ZDB');
  it.skipIf(!mp2)('Frostfire mission.rdr names the map and mp2.rdr carries MetersPerUnit 0.1', () => {
    const toc = parseZdb(mp2!);
    const readerm = Zar.parse(zdbMember(mp2!, toc, 'READERM.ZAR'));
    const mission = parseRdr(readerm.data(readerm.find('mission')!));
    expect(rdrGet(mission, 'description')).toBe('FROSTFIRE');
    const mp2rdr = parseRdr(readerm.data(readerm.find('mp2')!));
    const wp = rdrGet(mp2rdr, 'world_params') as RdrNode[];
    expect(Number(rdrGet(wp, 'MetersPerUnit'))).toBeCloseTo(0.1);
  });
});
```
(Key names inside `READERM.ZAR` may carry a `.rdr` suffix or live one level down; the implementer prints the
tree once and fixes the `find` path. The scratch `MP2_rdr.txt` in the session scratchpad shows the decoded content.)

`test/mapIndex.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { FsAssetSource } from '../src/fsAssetSource';
import { listMaps } from '../src/mapIndex';

const served = resolve(import.meta.dirname, '../../../public/maps');
describe('listMaps', () => {
  it.skipIf(!existsSync(served))('names all 22 MP archives from their mission.rdr', async () => {
    const maps = await listMaps(new FsAssetSource(served));
    expect(maps.length).toBe(22);
    const byArchive = Object.fromEntries(maps.map((m) => [m.archive, m.name]));
    expect(byArchive).toMatchObject({ MP1: 'BLIZZARD', MP2: 'FROSTFIRE', MP6: 'DESERT GLORY', MP72: 'CROSSROADS', MP83: 'REQUIEM' });
    expect(maps[0]!.archive).toBe('MP1'); expect(maps[1]!.archive).toBe('MP2'); expect(maps[2]!.archive).toBe('MP5');
  });
});
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement**

`rdr.ts`:
```ts
import { Reader } from './bytes';
export type RdrNode = string | RdrNode[];
const TYPE_LIST = 0, TYPE_STRING = 1; // 36 §6; verify against the scratch rdr.py and adjust if the codes differ
export function parseRdr(bytes: Uint8Array): RdrNode {
  const r = new Reader(bytes);
  if (r.u32(0) !== 1) throw new Error(`rdr version ${r.u32(0)}`);
  const stringsAt = 12, nodesAt = r.u32(8);
  const node = (byteOfs: number, depth: number): RdrNode => {
    if (depth > 64) throw new Error('rdr nesting too deep');
    const w = r.u32(nodesAt + byteOfs), value = r.u32(nodesAt + byteOfs + 4);
    const type = w & 0xff, length = w >>> 16;
    if (type === TYPE_STRING) return r.cstr(stringsAt + value, r.u32(4) - value);
    if (type === TYPE_LIST) { const out: RdrNode[] = []; for (let i = 0; i < length; i++) out.push(node(value + 8 * i, depth + 1)); return out; }
    throw new Error(`rdr node type ${type} at ${byteOfs}`);
  };
  return node(0, 0);
}
export function rdrGet(node: RdrNode, key: string): RdrNode | undefined {
  if (typeof node === 'string') return undefined;
  for (const child of node) {
    if (Array.isArray(child) && child[0] === key) return child.length === 2 ? child[1] : child.slice(1);
  }
  return undefined;
}
```
`assetSource.ts`: the interface only. `fsAssetSource.ts`:
```ts
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssetSource } from './assetSource';
export class FsAssetSource implements AssetSource {
  constructor(private readonly root: string) {}
  async list(): Promise<string[]> {
    const out: string[] = [];
    const rec = async (rel: string) => { for (const e of await readdir(join(this.root, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) await rec(p); else out.push(p); } };
    await rec(''); return out.sort();
  }
  async read(path: string): Promise<Uint8Array> { return new Uint8Array(await readFile(join(this.root, path))); }
}
```
`mapIndex.ts`:
```ts
import type { AssetSource } from './assetSource';
import { parseZdb, zdbMember } from './zdb';
import { Zar } from './zar';
import { parseRdr, rdrGet } from './rdr';
export interface MapInfo { archive: string; path: string; name: string }
export async function listMaps(source: AssetSource): Promise<MapInfo[]> {
  const paths = (await source.list()).filter((p) => /^RUN\/MP\d+\.ZDB$/i.test(p));
  const out: MapInfo[] = [];
  for (const path of paths) {
    const bytes = await source.read(path);
    const toc = parseZdb(bytes);
    const readerm = Zar.parse(zdbMember(bytes, toc, 'READERM.ZAR'));
    const missionKey = readerm.root.children.find((k) => /^mission(\.rdr)?$/i.test(k.name));
    const name = missionKey ? String(rdrGet(parseRdr(readerm.data(missionKey)), 'description') ?? '') : '';
    out.push({ archive: path.match(/(MP\d+)\.ZDB/i)![1]!.toUpperCase(), path, name });
  }
  return out.sort((a, b) => Number(a.archive.slice(2)) - Number(b.archive.slice(2)));
}
```
Export all from `index.ts` (keep `fsAssetSource` out of the browser bundle: export it from a separate
`src/node.ts` entry, and add `"exports": { ".": "./src/index.ts", "./node": "./src/node.ts" }` to the package).

- [ ] **Step 4: Run, expect pass** (including the 22-name test).
- [ ] **Step 5: Commit** — `feat(web/archive): compiled rdr scripts decode from the archive, and the map index names all 22 MP archives from their own mission.rdr instead of a typed table (M1)`.

---

### Task 6: `HttpAssetSource` (M1)

**Files:**
- Create: `web/redotcom/packages/archive/src/httpAssetSource.ts`, `web/redotcom/packages/archive/test/httpAssetSource.test.ts`

**Interfaces:**
- Produces: `class HttpAssetSource implements AssetSource { constructor(baseUrl: string) }`; `list()` fetches
  `${baseUrl}/index.json`; `read(path)` fetches `${baseUrl}/${path}`, throws `Error("HTTP <status> <path>")` on
  non-2xx.

- [ ] **Step 1: Failing test** (mock `fetch` with `vi.stubGlobal`):
```ts
import { describe, it, expect, vi } from 'vitest';
import { HttpAssetSource } from '../src/httpAssetSource';
describe('HttpAssetSource', () => {
  it('lists from index.json and reads bytes', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/index.json')) return new Response(JSON.stringify(['RUN/MP2.ZDB']));
      if (url.endsWith('/RUN/MP2.ZDB')) return new Response(new Uint8Array([7, 8]));
      return new Response(null, { status: 404 });
    }));
    const s = new HttpAssetSource('/maps');
    expect(await s.list()).toEqual(['RUN/MP2.ZDB']);
    expect(Array.from(await s.read('RUN/MP2.ZDB'))).toEqual([7, 8]);
    await expect(s.read('RUN/NOPE.ZDB')).rejects.toThrow(/404/);
  });
});
```
- [ ] **Step 2: Run, expect failure.** **Step 3: Implement** (straightforward `fetch` + `arrayBuffer`). **Step 4: pass.**
- [ ] **Step 5: Commit** — `feat(web/archive): the served asset source -- the testing door, mirroring disc paths so the ISO source can answer the same reads later (M1)`.

---

### Task 7: texture and palette records (M2)

**Files:**
- Create: `web/redotcom/packages/gs/{package.json,tsconfig.json,vitest.config.ts}`, `web/redotcom/packages/gs/src/{tex0.ts,texture.ts,palette.ts,index.ts}`,
  `web/redotcom/packages/gs/test/records.test.ts`
- Modify: `web/redotcom/tools/package.json` (add `@s2u/gs`)

**Interfaces:**
- Produces:
  ```ts
  interface Tex0 { tbp0: number; tbw: number; psm: number; tw: number; th: number; tcc: number; tfx: number; cbp: number; cpsm: number; csm: number; csa: number; cld: number }
  function decodeTex0(q: bigint): Tex0;   // GS TEX0 bit layout: TBP0 0-13, TBW 14-19, PSM 20-25, TW 26-29, TH 30-33, TCC 34, TFX 35-36, CBP 37-50, CPSM 51-54, CSM 55, CSA 56-60, CLD 61-63
  const PSM = { CT32: 0x00, CT24: 0x01, CT16: 0x02, CT16S: 0x0a, T8: 0x13, T4: 0x14, T8H: 0x1b, T4HL: 0x24, T4HH: 0x2c } as const;
  interface TextureRecord { name: string; width: number; height: number; size: number; gsaddr: number; bpp: number; selectQwc: number; palOffset: number;
    transparent: boolean; palettized: boolean; isMipChild: boolean; bumpmap: boolean; bilinear: boolean; transp1bit: boolean; dynamic: boolean; context: boolean;
    pixels: Uint8Array; tex0: Tex0 | null }
  function parseTextureRecord(name: string, texdat: Uint8Array): TextureRecord;   // 36 §5
  interface PaletteRecord { gsaddr: number; format: number /* 2 = CT16, 0 = CT32 */; size: number; rgba: Uint8ClampedArray /* 256*4, alpha scaled 0x80->255 */ }
  function parsePaletteRecord(par: Uint8Array, buf: Uint8Array): PaletteRecord;
  ```
  `tex0` is found by scanning the 9 quadwords after the pixels for the one whose PSM field is a known texture PSM
  and whose TBP0 equals `gsaddr`; `null` if none (record it in diagnostics; do not throw).

- [ ] **Step 1: Failing test**
```ts
import { describe, it, expect } from 'vitest';
import { decodeTex0, parseTextureRecord, parsePaletteRecord, PSM } from '../src';
import { parseZdb, zdbMember, Zar } from '@s2u/archive';
import { fixture } from '../../archive/test/fixtures';

describe('TEX0', () => {
  it('decodes a_floor.tif bind word from 36 §5', () => {
    const t = decodeTex0(0x201026E599304001n);
    expect(t).toMatchObject({ tbp0: 1, tbw: 1, psm: PSM.T8, tw: 6, th: 6, cbp: 311, cpsm: 2 });
  });
});
describe('records', () => {
  const mp2 = fixture('RUN/MP2.ZDB');
  it.skipIf(!mp2)('a_floor.tif is 64x64 PSMT8 palettized bilinear, pixels 4096 bytes, palette 311 exists as CT16', () => {
    const toc = parseZdb(mp2!);
    const txr = Zar.parse(zdbMember(mp2!, toc, 'MP2_TXR.ZED'));
    const key = txr.find('textures/a_floor.tif/texdat')!;
    const rec = parseTextureRecord('a_floor.tif', txr.data(key));
    expect(rec).toMatchObject({ width: 64, height: 64, size: 4096, gsaddr: 1, bpp: 8, selectQwc: 6, palettized: true, bilinear: true });
    expect(rec.pixels.byteLength).toBe(4096);
    expect(rec.tex0).toMatchObject({ tbp0: 1, psm: PSM.T8, cbp: 311, cpsm: 2 });
    const pal = Zar.parse(zdbMember(mp2!, toc, 'MP2_PAL.ZED'));
    const p311 = pal.find('palettes/texpal_311')!;
    const prec = parsePaletteRecord(pal.data(pal.child(p311, 'par')!), pal.data(pal.child(p311, 'buf')!));
    expect(prec.gsaddr).toBe(311); expect(prec.format).toBe(2); expect(prec.rgba.length).toBe(1024);
  });
  it.skipIf(!mp2)('all 65 Frostfire textures parse with size == w*h*bpp/8 and 53 palettes parse', () => {
    const toc = parseZdb(mp2!);
    const txr = Zar.parse(zdbMember(mp2!, toc, 'MP2_TXR.ZED'));
    const texKeys = txr.find('textures')!.children;
    expect(texKeys.length).toBe(65);
    for (const k of texKeys) { const rec = parseTextureRecord(k.name, txr.data(txr.child(k, 'texdat')!));
      expect(rec.size).toBe((rec.width * rec.height * rec.bpp) / 8); }
    const pal = Zar.parse(zdbMember(mp2!, toc, 'MP2_PAL.ZED'));
    expect(pal.find('palettes')!.children.length).toBe(53);
  });
});
```
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement** per the layouts in 36 §5 (`TEXTURE_PARAMS`: `u16 w, u16 h, u32 size, u32 gsaddr, u32 flags` with
  `texelBitSize` bits 0-7, `selectQwc` 8-15, `palOffset` 16-23, then eight 1-bit flags from bit 24 in the order
  transparent, palettized, isMipChild, bumpmap, bilinear, transp1bit, dynamic, context; pixels at 16; bind packet
  after; `PALETTE_PARAMS`: `u32 gsaddr; u32 (size:16, format:8, combo:1, dynamic:1)`). CT16 entry `abgr1555`:
  r = (v & 31) << 3, g = ((v >> 5) & 31) << 3, b = ((v >> 10) & 31) << 3, a = (v >> 15) ? 255 : 0. CT32 entry: r,g,b
  bytes as-is, a = min(255, a * 255 / 128). Add `packages/gs/package.json` with dependency `"@s2u/archive": "*"`.
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(web/gs): texture and palette records exactly as GameZ reads them, with the TEX0 bind word recovered from the record's own packet (M2)`.

---

### Task 8: texture decode, PNG dump, the swizzle question (M2)

**Files:**
- Create: `web/redotcom/packages/gs/src/decode.ts`, `web/redotcom/packages/gs/src/paletteTable.ts`, `web/redotcom/packages/gs/test/decode.test.ts`,
  `web/redotcom/tools/dump-textures.ts`, `web/redotcom/packages/gs/test/goldens/frostfire-textures.json`
- Modify: spec section 9 (finding), `web/redotcom/docs/research/72-mp-map-archive-anatomy.md` §5 (answer the open question)

**Interfaces:**
- Produces:
  ```ts
  interface Rgba { width: number; height: number; data: Uint8ClampedArray }
  type PixelOrder = 'raster' | 'swizzled';
  function decodeTexture(rec: TextureRecord, palettes: PaletteTable, order?: PixelOrder): Rgba;  // default = the order Step 5 settles
  class PaletteTable { add(p: PaletteRecord): void; get(gsaddr: number): PaletteRecord | undefined; static fromZars(pals: Zar[]): PaletteTable }
  ```
  Decode: PSMT8: index per byte, palette = `palettes.get(tex0.cbp)` (fall back to the first palette and record a
  diagnostic if missing); for an 8-bit CLUT the GS stores entries in blocks of 32 with the two middle 8-entry
  groups swapped (`csm1` layout): index `i` maps to `(i & ~0x18) | ((i & 0x08) << 1) | ((i & 0x10) >> 1)`.
  PSMCT16 direct: `abgr1555` per u16. PSMCT32 direct: bytes as-is, alpha scaled.
  `'swizzled'`: the PSMT8 page layout (a 128x64 page of 8x16 columns, the standard GS PSMT8 block/column
  arrangement); implement it as a lookup built once, following the runtime's `ps2_gs_psmt8.h` as the reference,
  but written independently (no GPL text copied).

- [ ] **Step 1: Failing test**
```ts
import { describe, it, expect } from 'vitest';
import { decodeTexture, PaletteTable, parseTextureRecord, parsePaletteRecord } from '../src';
import { parseZdb, zdbMember, Zar } from '@s2u/archive';
import { fixture } from '../../archive/test/fixtures';
import { createHash } from 'node:crypto';
import goldens from './goldens/frostfire-textures.json';

describe('decodeTexture', () => {
  it('maps a synthetic 2x2 PSMT8 through a CT32 palette', () => {
    const rec = { name: 't', width: 2, height: 2, size: 4, gsaddr: 1, bpp: 8, selectQwc: 0, palOffset: 0, transparent: false, palettized: true,
      isMipChild: false, bumpmap: false, bilinear: false, transp1bit: false, dynamic: false, context: false,
      pixels: new Uint8Array([0, 1, 2, 3]), tex0: { tbp0: 1, tbw: 1, psm: 0x13, tw: 1, th: 1, tcc: 0, tfx: 0, cbp: 5, cpsm: 0, csm: 0, csa: 0, cld: 0 } };
    const rgba = new Uint8ClampedArray(1024); for (let i = 0; i < 256; i++) rgba.set([i, 0, 255 - i, 255], i * 4);
    const table = new PaletteTable(); table.add({ gsaddr: 5, format: 0, size: 256, rgba });
    const out = decodeTexture(rec, table, 'raster');
    expect(Array.from(out.data)).toEqual([0, 0, 255, 255, 1, 0, 254, 255, 2, 0, 253, 255, 3, 0, 252, 255]);
  });
  const mp2 = fixture('RUN/MP2.ZDB');
  it.skipIf(!mp2)('every Frostfire texture decodes and matches the frozen goldens', () => {
    const toc = parseZdb(mp2!);
    const txr = Zar.parse(zdbMember(mp2!, toc, 'MP2_TXR.ZED'));
    const table = PaletteTable.fromZars([Zar.parse(zdbMember(mp2!, toc, 'MP2_PAL.ZED'))]);
    for (const k of txr.find('textures')!.children) {
      const rec = parseTextureRecord(k.name, txr.data(txr.child(k, 'texdat')!));
      const out = decodeTexture(rec, table);
      const hash = createHash('sha256').update(out.data).digest('hex').slice(0, 16);
      expect({ name: k.name, hash }).toEqual({ name: k.name, hash: (goldens as Record<string, string>)[k.name] });
    }
  });
});
```
The goldens file starts as `{}`; the golden test is expected to fail until Step 6 freezes it.

- [ ] **Step 2: Run, expect failure.** **Step 3: Implement `decode.ts`, `paletteTable.ts`.**

- [ ] **Step 4: `tools/dump-textures.ts`**: for `RUN/MP2.ZDB` (arg 1, default) writes
  `web/redotcom/test-fixtures/textures/<archive>/<order>/<name>.png` for both orders, using a tiny PNG encoder (write one in
  `tools/png.ts`: zlib via `node:zlib` `deflateSync`, 8-bit RGBA, CRC32 table; about 40 lines) so no new dependency
  is needed. Also writes a contact sheet `sheet-<order>.png` tiling all textures at native size with 4 px gaps,
  256 px per cell.

- [ ] **Step 5: Look at the two contact sheets** with the Read tool (it renders PNGs). One order shows recognisable
  materials (wood grain, snow, metal, signage text readable); the other shows 8x16 pixel blocks shuffled. Record
  the winner as the default in `decode.ts` and write the finding, with the two sheet names and one texture named
  as the decisive example, into spec section 9 and into 36 §5 replacing "Open question". Also confirm or refute
  the CLUT 32-entry swap the same way (a palettized texture with a smooth gradient looks banded if the swap is
  wrong): try both and keep the one that renders smooth gradients; record it.

- [ ] **Step 6: Freeze goldens**: add a `--write-goldens` flag to `dump-textures.ts` that writes
  `packages/gs/test/goldens/frostfire-textures.json` (`{name: hash16}` for all 65). Run it, then `npx vitest run packages/gs` → pass.

- [ ] **Step 7: Commit** — `feat(web/gs): Frostfire's 65 textures decode -- <raster|swizzled> pixel order and the <swapped|linear> 8-bit CLUT, settled by looking, frozen as goldens (M2)` — paths: `web/redotcom/packages/gs`, `web/redotcom/tools/dump-textures.ts`, `web/redotcom/tools/png.ts`, the spec, `web/redotcom/docs/research/72-mp-map-archive-anatomy.md`.

---

### Task 9: DMA chain walker and VIF stream (M3)

**Files:**
- Create: `web/redotcom/packages/mesh/{package.json,tsconfig.json,vitest.config.ts}`, `web/redotcom/packages/mesh/src/{dma.ts,index.ts}`,
  `web/redotcom/packages/mesh/test/dma.test.ts`
- Modify: `web/redotcom/tools/package.json` (add `@s2u/mesh`)

**Interfaces:**
- Produces:
  ```ts
  interface DmaTag { qwc: number; reloc: number; id: number /* 0 refe,1 cnt,2 next,3 ref,4 refs,5 call,6 ret,7 end */; addr: number; vif0: number; vif1: number; tagOffset: number }
  interface Chain { nodeName: string; headerOffset: number; tags: DmaTag[]; textureName: string | null; vif: Uint8Array /* the linear VIF1 byte stream */ }
  function walkChain(buffer: Uint8Array, headerOffset: number, nodeName: string): Chain;   // 36 §3
  function walkModel(buffer: Uint8Array, nodes: { name: string; offset: number }[]): Chain[];
  function modelNodes(zar: Zar, model: ZarKey): { name: string; offset: number }[];  // each child key's 4-byte u32
  ```
  `vif` assembly: for each tag in order, append the 8 bytes of `vif0,vif1` (the tag-transfer codes), then for
  `ref`/`refe` the `qwc*16` bytes at `buffer[addr ..]`, for `cnt` the `qwc*16` bytes following the tag in the chain.
  Type-6 tags contribute the texture name (`cstr` at `addr`) and no VIF bytes. Throw on any other id or on an
  address outside the buffer.

- [ ] **Step 1: Failing test**
```ts
import { describe, it, expect } from 'vitest';
import { walkModel, modelNodes } from '../src/dma';
import { parseZdb, zdbMember, Zar } from '@s2u/archive';
import { fixture } from '../../archive/test/fixtures';

describe('walkModel', () => {
  const mp2 = fixture('RUN/MP2.ZDB');
  it.skipIf(!mp2)('Frostfire worldmodel: 123 chains, 1,450 tags, reloc types {2,3,4,6}, 37 distinct texture names, first chunk cites cuba1a_sky01.tif', () => {
    const toc = parseZdb(mp2!);
    const worl = Zar.parse(zdbMember(mp2!, toc, 'WORL_MDL.ZED'));
    const world = worl.find('worldmodel')!;
    const chains = walkModel(worl.data(world), modelNodes(worl, world));
    expect(chains.length).toBe(123);
    expect(chains.reduce((n, c) => n + c.tags.length, 0)).toBe(1450);
    const relocs = new Set(chains.flatMap((c) => c.tags.map((t) => t.reloc)));
    expect([...relocs].sort()).toEqual([2, 3, 4, 6]);
    expect(chains[0]!.textureName).toBe('cuba1a_sky01.tif');
    expect(new Set(chains.map((c) => c.textureName)).size).toBe(37);
    for (const c of chains) expect(c.vif.byteLength % 4).toBe(0);
  });
});
```
- [ ] **Step 2: Run, expect failure.** **Step 3: Implement `dma.ts`** per 36 §3 (word 0: qwc bits 0-15, reloc bits
  16-23, id bits 28-30; word 1 addr; words 2-3 vif codes). Header at `headerOffset`: `u8 count` in the first byte
  of the count quadword (`m_dmaQwc = *tag[0].u8`), tags start at `headerOffset + 16`.
- [ ] **Step 4: Run, expect pass.** **Step 5: Commit** — `feat(web/mesh): the model DMA chains walk exactly as CVisual::GetChainData/SetBuffer read them -- 123 chunks, 1,450 tags, 37 textures on Frostfire's world (M3)`.

---

### Task 10: VIF1 unpacker to per-packet VU memory (M3)

**Files:**
- Create: `web/redotcom/packages/mesh/src/vif.ts`, `web/redotcom/packages/mesh/test/vif.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface Unpack { addr: number; num: number; vn: number; vl: number; usn: boolean; flg: boolean; cl: number; wl: number; dataOffset: number }
  interface VuPacket { kind: 'mscal' | 'mscnt'; entry: number /* mscal imm*8, or -1 */; mem: Int32Array /* 1024 qw * 4 lanes, raw sign-extended integers */;
                       f32: Float32Array /* same bytes viewed as float, for V4-32 data */; written: Uint8Array /* 1024 flags: qw written by this packet */; unpacks: Unpack[] }
  function unpackVif(vif: Uint8Array): VuPacket[];   // splits at each MSCAL/MSCNT; throws VifError(code, offset) on any command outside NOP/STCYCL/UNPACK/MSCAL/MSCNT, on m=1 (masked) unpacks, or on STMASK/STROW/STCOL
  function vifHistogram(vif: Uint8Array): Record<string, number>;
  ```
  Unpack semantics (VIF1, FLG=1 so `addr` is relative to a per-packet base of 0): element sizes V4-32 16 B,
  V4-16 8 B, V4-8 4 B, V3-32 12 B, V3-16 6 B, V3-8 3 B, V2-32 8 B, V2-16 4 B, V2-8 2 B, S-32 4 B, S-16 2 B, S-8 1 B;
  16- and 8-bit lanes sign-extend unless `usn`; missing lanes (V3, V2, S) are left as written by earlier unpacks (do
  not zero); skipping write when `cl >= wl`: element `i` lands at `addr + floor(i / wl) * cl + (i % wl)`; when
  `cl < wl` throw (filling write, not used). `num` of 0 means 256. After an unpack's data the stream re-aligns to a
  4-byte boundary. VIF code word: cmd = bits 24-31 (mask bit 7 of cmd is the `i` interrupt bit: ignore it), imm =
  bits 0-15, num = bits 16-23; UNPACK has cmd bits 0x60..0x7F with vn = (cmd >> 2) & 3, vl = cmd & 3, m = cmd & 0x10;
  addr = imm & 0x3ff, usn = (imm >> 14) & 1, flg = (imm >> 15) & 1; STCYCL: cl = imm & 0xff, wl = (imm >> 8) & 0xff.

- [ ] **Step 1: Failing test**
```ts
import { describe, it, expect } from 'vitest';
import { unpackVif, vifHistogram } from '../src/vif';
import { walkModel, modelNodes } from '../src/dma';
import { parseZdb, zdbMember, Zar } from '@s2u/archive';
import { fixture } from '../../archive/test/fixtures';

function words(...w: number[]): Uint8Array { const out = new Uint8Array(w.length * 4); const dv = new DataView(out.buffer); w.forEach((x, i) => dv.setUint32(i * 4, x >>> 0, true)); return out; }

describe('unpackVif', () => {
  it('skipping-write V4-16 at CL=3 WL=2 lands elements at 0,1,3,4 and sign-extends', () => {
    // STCYCL cl=3 wl=2 ; UNPACK V4-16 num=4 addr=0 flg ; 4 elements of 8 bytes ; MSCNT
    const stcycl = 0x01000000 | (2 << 8) | 3;
    const unpack = 0x60000000 | (0b01 << 24) /* vl=1 (16-bit) */ | (0b11 << 26) /* vn=3 (V4) */ | (4 << 16) | 0x8000 /* flg */ | 0;
    const data = new Int16Array([1, 2, 3, -4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, -16]);
    const stream = new Uint8Array([...words(stcycl, unpack), ...new Uint8Array(data.buffer), ...words(0x17000000)]);
    const [pkt] = unpackVif(stream);
    expect(pkt!.kind).toBe('mscnt');
    expect(Array.from(pkt!.mem.subarray(0, 4))).toEqual([1, 2, 3, -4]);
    expect(Array.from(pkt!.mem.subarray(4, 8))).toEqual([5, 6, 7, 8]);
    expect(pkt!.written[2]).toBe(0);
    expect(Array.from(pkt!.mem.subarray(12, 16))).toEqual([9, 10, 11, 12]);
    expect(Array.from(pkt!.mem.subarray(16, 20))).toEqual([13, 14, 15, -16]);
  });
  it('throws on a command outside the five', () => {
    expect(() => unpackVif(words(0x4a000000))).toThrow(/MPG|0x4a/i);
  });
  const mp2 = fixture('RUN/MP2.ZDB');
  it.skipIf(!mp2)('Frostfire world: histogram NOP 2953 STCYCL 2389 UNPACK 2389 MSCNT 416 MSCAL 309; every MSCAL is entry 0', () => {
    const toc = parseZdb(mp2!);
    const worl = Zar.parse(zdbMember(mp2!, toc, 'WORL_MDL.ZED'));
    const world = worl.find('worldmodel')!;
    const chains = walkModel(worl.data(world), modelNodes(worl, world));
    const total: Record<string, number> = {};
    let mscnt = 0, mscal = 0;
    for (const c of chains) {
      for (const [k, v] of Object.entries(vifHistogram(c.vif))) total[k] = (total[k] ?? 0) + v;
      for (const p of unpackVif(c.vif)) { if (p.kind === 'mscnt') mscnt++; else { mscal++; expect(p.entry).toBe(0); } }
    }
    expect(total).toMatchObject({ NOP: 2953, STCYCL: 2389, UNPACK: 2389, MSCNT: 416, MSCAL: 309 });
    expect(mscnt).toBe(416); expect(mscal).toBe(309);
  });
  it.skipIf(!mp2)('the first MSCNT packet of chunk N000_000 has header at qw 0-3, vertex triples from qw 4, and a 12-entry tail at qw 112..135', () => {
    const toc = parseZdb(mp2!);
    const worl = Zar.parse(zdbMember(mp2!, toc, 'WORL_MDL.ZED'));
    const world = worl.find('worldmodel')!;
    const [chain] = walkModel(worl.data(world), modelNodes(worl, world));
    const pkts = unpackVif(chain!.vif);
    const first = pkts.find((p) => p.kind === 'mscnt')!;
    expect(first.unpacks.map((u) => [u.vn, u.vl, u.num, u.addr, u.cl, u.wl])).toEqual([
      [3, 2, 36, 6, 3, 1], [3, 0, 4, 0, 1, 1], [3, 1, 72, 4, 3, 2], [3, 2, 12, 112, 2, 1], [2, 1, 12, 113, 2, 1],
    ]);
    for (let q = 0; q < 136; q++) expect(first.written[q]).toBe(1);
  });
});
```
(The MSCAL-0 packet that precedes the first MSCNT carries the V4-32 num=2 addr=2 parameter unpack; whether
that unpack is reported in the MSCNT packet or the MSCAL packet depends on stream order; the test above lists the
unpacks the scratch trace showed for the MSCNT packet in 36 §3 and the implementer adjusts the expectation to the
real order after printing it once, keeping the layout facts: header 0-3, 36 vertex triples from 4, 12-entry tail.)

- [ ] **Step 2: Run, expect failure.** **Step 3: Implement `vif.ts`.** **Step 4: pass.**
- [ ] **Step 5: Commit** — `feat(web/mesh): a VIF1 unpacker for the five commands and five formats map geometry uses, reproducing Frostfire's histogram and the packet layout of its first chunk (M3)`.

---

### Task 11: vertex semantics from the VU1 translation (M3, research)

**Files:**
- Create: `web/redotcom/packages/mesh/src/SEMANTICS.md`
- Modify: spec section 9

This task produces a document, not code. It is done by an agent reading, with citations to file and line, and it
decides how Task 12 is written. Read-only on `C:\projects\socom_pc` (the other agent's tree).

- [ ] **Step 1: Establish what the dispatcher does with a packet.** Read
  `third_party/ps2recomp/ps2xRuntime/src/lib/vu/native/socom2_dispatch_0x1b50.cpp` (3,503 lines, hand-written, so
  it names things) and `docs/research/13-vu1-family-b-world-objects.md`, `15-vu1-fourth-family.md`,
  `12-vu1-entry0-ui-path.md` §"header". Answer, with citations: (a) which command words the MSCAL-0 parameter
  quadwords (the `V4-32 num=2 addr=2` unpack) carry and which family handles a world chunk; (b) how the header
  quadwords 0-3 are used (matrix rows? a GIFtag template? vertex count? at which lanes); (c) the vertex triple: which
  lanes of the two V4-16 quadwords are position (x, y, z) and which are texture coordinates or normals, and the
  conversion (`ITOF15`, `ITOF12`, `ITOF4`, `ITOF0`, or a per-packet scale from the header); (d) what the V4-8 quadword
  at `+2` in each triple is (RGBA vertex colour, 0..128 alpha?); (e) what the 12-entry tail (V4-8 at 112+2k, V3-16
  at 113+2k) is: per-triangle data (face normal and colour), per-strip, or lights; (f) the primitive: triangle list,
  strips with a restart flag in a lane (the ADC bit convention: a set bit in the position's w lane or a flag lane
  marks "do not draw this vertex"), or fans; (g) UV convention: STQ with perspective divide, or UV in texel units;
  and the texture-coordinate scale (`TW/TH` from `TEX0`?).
- [ ] **Step 2: Cross-check on real data.** Use `tools_py/research/terrain/patch_dump.py` and the dumps under
  `tools_py/research/terrain/` (read-only) to see what a family-B vertex block looks like at runtime after unpack,
  and compare with the raw lanes of Frostfire chunk `N000_000` printed by a small tsx script over Task 10's output.
  The positions of a sky chunk (`cuba1a_sky01.tif`) should be large and far; a floor chunk's y values should
  cluster near 100 or 142 (the two Frostfire spawn floors) once the scale is right. `MetersPerUnit` is 0.1, so the
  world spans roughly 0..2000 units.
- [ ] **Step 3: Write `SEMANTICS.md`**: one table per quadword role (header qw0..3, vertex qw a, b, c, tail
  entries) with lane, meaning, conversion, and the citation; a section "primitive assembly" with the exact rule;
  a section "unknowns" listing anything not settled and the test that would settle it. Add a dated entry to spec
  section 9 summarising the decision.
- [ ] **Step 4: Commit** — `docs(web/mesh): what the VU1 dispatcher makes of a world chunk -- the vertex lanes, their fixed-point scale, and the primitive rule, from the native translation (M3)`.

---

### Task 12: `interpretPacket` to `MeshData` (M3)

**Files:**
- Create: `web/redotcom/packages/mesh/src/interpret.ts`, `web/redotcom/packages/mesh/src/meshData.ts`, `web/redotcom/packages/mesh/test/interpret.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface MeshData { positions: Float32Array /* xyz */; uvs: Float32Array /* uv */; colors: Uint8Array /* rgba */; normals: Float32Array | null; indices: Uint32Array; textureName: string | null }
  function interpretChain(chain: Chain): MeshData[];          // one MeshData per MSCNT packet, per SEMANTICS.md
  function mergeMeshes(parts: MeshData[]): MeshData;           // concatenates, re-basing indices
  function bounds(m: MeshData): { min: [number, number, number]; max: [number, number, number] }
  ```
  The code follows `SEMANTICS.md` exactly; the shape below assumes the reading "36 vertex triples = 12 triangles,
  tail = 12 per-face records" and must be changed to what Task 11 found. Every conversion constant is a named
  constant with its SEMANTICS.md row in a comment.

- [ ] **Step 1: Failing test**
```ts
import { describe, it, expect } from 'vitest';
import { interpretChain, mergeMeshes, bounds } from '../src';
import { walkModel, modelNodes } from '../src/dma';
import { parseZdb, zdbMember, Zar } from '@s2u/archive';
import { fixture } from '../../archive/test/fixtures';

describe('interpretChain on Frostfire', () => {
  const mp2 = fixture('RUN/MP2.ZDB');
  const load = () => { const toc = parseZdb(mp2!); const worl = Zar.parse(zdbMember(mp2!, toc, 'WORL_MDL.ZED'));
    const world = worl.find('worldmodel')!; return walkModel(worl.data(world), modelNodes(worl, world)); };
  it.skipIf(!mp2)('produces finite geometry with indices in range for all 123 chunks', () => {
    for (const c of load()) for (const m of interpretChain(c)) {
      expect(m.positions.length % 3).toBe(0); expect(m.indices.length % 3).toBe(0);
      for (const v of m.positions) expect(Number.isFinite(v)).toBe(true);
      for (const i of m.indices) expect(i).toBeLessThan(m.positions.length / 3);
      expect(m.uvs.length / 2).toBe(m.positions.length / 3);
    }
  });
  it.skipIf(!mp2)('the world encloses both measured spawns and its floors sit near them', () => {
    const world = mergeMeshes(load().flatMap(interpretChain));
    const b = bounds(world);
    for (const [x, y, z] of [[796, 100, 614], [536, 143, 1254]] as const) {
      expect(x).toBeGreaterThan(b.min[0]); expect(x).toBeLessThan(b.max[0]);
      expect(z).toBeGreaterThan(b.min[2]); expect(z).toBeLessThan(b.max[2]);
      // a triangle vertex within 40 units horizontally and 30 units below the spawn's feet: the floor it stands on
      let found = false;
      for (let i = 0; i < world.positions.length; i += 3) {
        const dx = world.positions[i]! - x, dz = world.positions[i + 2]! - z, dy = y - world.positions[i + 1]!;
        if (dx * dx + dz * dz < 40 * 40 && dy >= -5 && dy <= 30) { found = true; break; }
      }
      expect(found).toBe(true);
    }
    expect(world.indices.length / 3).toBeGreaterThan(2000);
  });
});
```
If the game's axis convention differs (y up versus z up, or a handedness flip), the spawn test says so by failing
on one axis; fix the convention in `interpret.ts` and record it in `SEMANTICS.md`, never in the test.

- [ ] **Step 2: Run, expect failure.** **Step 3: Implement** per `SEMANTICS.md`. **Step 4: pass.**
- [ ] **Step 5: Commit** — `feat(web/mesh): Frostfire's world decodes to triangles that enclose both measured spawns, with floors under their feet (M3)`.

---

### Task 13: glTF export tool (M3)

**Files:**
- Create: `web/redotcom/tools/export-gltf.ts`, `web/redotcom/tools/gltf.ts`

- [ ] **Step 1: Write `gltf.ts`**: a minimal `.glb` writer (JSON chunk + BIN chunk; one mesh per texture with
  `POSITION`, `TEXCOORD_0`, `COLOR_0`, indices; PNG textures embedded as `image/png` buffer views; sampler with
  nearest or linear per `bilinear`; `KHR_materials_unlit`). About 150 lines; no dependency.
- [ ] **Step 2: `export-gltf.ts <RUN/MP2.ZDB> <out.glb>`**: loads the world via Tasks 3-12, writes the glb, prints
  triangle count and bounds. Run it for Frostfire into `web/redotcom/test-fixtures/frostfire-world.glb` and open the file in
  any glTF validator (`npx gltf-validator` if available; otherwise the viewer in Task 14 is the check).
- [ ] **Step 3: Commit** — `feat(web/redotcom/tools): a map exports to glTF, the debugging aid for eyes other than the viewer's (M3)`.

---

### Task 14: the viewer app renders Frostfire's world (M3)

**Files:**
- Create: `web/redotcom/packages/viewer/{package.json,tsconfig.json,index.html,vite.config.ts}`,
  `web/redotcom/packages/viewer/src/{main.ts,renderer.ts,camera.ts,ui.ts,loadMap.ts,worker.ts,overlays.ts,styles.css}`,
  `web/redotcom/packages/viewer/e2e/viewer.spec.ts`, `web/redotcom/playwright.config.ts`

**Interfaces:**
- `loadMap.ts` (runs in `worker.ts`): `loadMap(source: AssetSource, path: string): Promise<LoadedMap>` where
  `LoadedMap { name: string; world: MeshData[] /* one per texture */; textures: Record<string, Rgba>; textureFlags: Record<string, { bilinear: boolean }>; metersPerUnit: number; diagnostics: string[] }`;
  posted to the main thread with all typed arrays in the transfer list.
- `renderer.ts`: `createRenderer(canvas): Promise<{ renderer: WebGPURenderer; backend: 'webgpu' | 'webgl2' }>`
  (three.js `WebGPURenderer` with `forceWebGL: false`; it falls back on its own; report `renderer.backend.isWebGPUBackend`).
- `camera.ts`: a fly camera (WASD + QE for up/down, mouse-look on drag, shift for speed, touch drag to look); speed in
  game units per second scaled by `1 / metersPerUnit`.
- `ui.ts`: a map `<select>` filled from `listMaps(source)`, a status line (backend, triangles, load ms), a
  diagnostics `<details>`, checkboxes wired in Task 16.
- `main.ts`: `HttpAssetSource('/maps')` if `/maps/index.json` answers, else the "Open ISO" button only (implemented
  in M5; tonight it shows a disabled button with the text "ISO source: milestone M5").

- [ ] **Step 1: Scaffold Vite** (`root: packages/viewer`, `publicDir: '../../public'`, `server.port 5173`,
  `server.headers` none needed; `optimizeDeps.exclude: ['three']` if the WebGPU build complains; import from
  `three/webgpu`). `package.json` deps: `three@^0.186.0`, `@s2u/archive`, `@s2u/gs`, `@s2u/mesh`.
- [ ] **Step 2: Build the scene**: one `Mesh` per `MeshData`, `BufferGeometry` with `position`, `uv`, `color`
  (normalized), `index`; `MeshBasicMaterial({ map, vertexColors: true, side: DoubleSide, alphaTest: 0.5 when the texture record is transparent })`;
  `DataTexture(rgba, w, h, RGBAFormat)` with `flipY` false, `magFilter`/`minFilter` per `bilinear`, wrap `RepeatWrapping`,
  `colorSpace = SRGBColorSpace`, `needsUpdate = true`. Camera starts at spawn A (796, 100+20, 614) looking toward
  spawn B. Background dark grey; a grid helper at y = 100 toggled by a checkbox; an axes helper.
- [ ] **Step 3: Playwright** (`e2e/viewer.spec.ts`): start `vite` (Playwright `webServer`), open `/`, choose
  `FROSTFIRE`, wait for the status line to contain `triangles`, assert triangles > 2000 and diagnostics empty,
  screenshot to `web/redotcom/test-fixtures/screens/frostfire-spawnA.png`; then set the camera to a top-down orbit via a
  `window.__viewer.setCamera({x, y, z, yaw, pitch})` debug hook and screenshot `frostfire-top.png`. Run with
  `npx playwright test` (chromium only; install with `npx playwright install chromium` if missing).
- [ ] **Step 4: Look at both screenshots** with the Read tool. The spawn-A view should show a recognisable
  interior or exterior with aligned textures; the top view should show a level-shaped footprint. If textures are
  mirrored or rotated on every surface, the UV convention in `SEMANTICS.md` is wrong on one axis: fix in
  `interpret.ts`, re-run, re-look. Record the result (what was seen, what was fixed) in spec section 9.
- [ ] **Step 5: Commit** — `feat(web/viewer): Frostfire's world renders textured in the browser on WebGPU with WebGL2 fallback, from the archive alone, with a fly camera starting at spawn A (M3)`.

---

### Task 15: scene graph and props (M4)

**Files:**
- Create: `web/redotcom/packages/scene/{package.json,tsconfig.json,vitest.config.ts}`, `web/redotcom/packages/scene/src/{worldRoot.ts,sceneGraph.ts,modelLibrary.ts,buildScene.ts,index.ts}`,
  `web/redotcom/packages/scene/test/scene.test.ts`
- Modify: `web/redotcom/packages/viewer/src/loadMap.ts`

**Interfaces:**
- ```ts
  interface WorldRoot { metersPerUnit: number; shadowVector: [number, number, number]; nightMission: boolean; defaultMaterial: string }
  function parseWorldRoot(zar: Zar): WorldRoot;   // 36 §2: MetersPerUnit f32, ShadowVector 3xf32, NightMission u32, DefaultMaterial str
  interface SceneNode { name: string; modelName: string | null; matrix: Float32Array /* 16, row-major as stored (36 §2: nparams = 64 B matrix + 32 B bbox) */; bbox: Float32Array /* 8 */; children: SceneNode[]; collision: CollisionPoly[] }
  interface CollisionPoly { region: number; ditype: number; material: number; points: Float32Array /* n*3, model space */ }
  function parseSceneGraph(geo: Zar): SceneNode[];   // the `models` children
  interface ModelLibrary { get(name: string): { buffer: Uint8Array; nodes: { name: string; offset: number }[] } | undefined }
  function loadModelLibrary(zars: Zar[]): ModelLibrary;   // WORL_MDL, MP<N>_MDL, FLIB_MDL; model key name -> buffer
  interface PlacedModel { modelName: string; world: Float32Array /* 16 column-major for three.js */ }
  function placeInstances(nodes: SceneNode[]): PlacedModel[];   // world = local x parent, row-vector convention (docs/research/24 §1.1: FUN_001BFC30)
  ```
- [ ] **Step 1: Failing test** on Frostfire: `parseSceneGraph` yields 46 prototypes, 206 instance nodes
  (`modelName !== null`, counted recursively), 2,756 collision polys with `points.length/3 === ptcount`; every
  instance's `modelName` resolves in the library or is listed as missing (assert the missing list is empty for MP2).
- [ ] **Step 2..4: implement, pass.** Matrix convention: the stored 64 bytes are 4 rows of 4 floats in the
  engine's row-vector convention (`world = local * parent`); three.js wants column-major with column vectors, which
  is the transpose of the row-vector product: compute in row-vector form, then transpose once when producing
  `world`. The test for this is visual (props sit on floors, not inside walls) plus: every placed model's bbox
  centre lies inside the world bounds from Task 12.
- [ ] **Step 5: Wire into `loadMap`**: props become `MeshData[]` per model decoded once and instanced by matrix
  (`InstancedMesh` per model when count > 1). Playwright screenshot again; look; commit —
  `feat(web/scene): the scene graph places Frostfire's 206 props from their prototypes with the engine's row-vector matrices (M4)`.

---

### Task 16: collision, spawn overlays, diagnostics, and the other two maps (M4)

**Files:**
- Create: `web/redotcom/packages/scene/src/{collision.ts,spawns.ts,clutter.ts}`, `web/redotcom/packages/viewer/src/overlays.ts`
- Modify: `web/redotcom/packages/viewer/src/{ui.ts,loadMap.ts}`, `web/redotcom/packages/scene/test/scene.test.ts`

- [ ] **Step 1: `spawns.ts`**: the measured A/B table for the maps that have one in `docs/research/33` and KNOWN §2
  (Frostfire A (796,100,614) B (536,143,1254); Crossroads A (1972,68,2150) B (748,93,766); Desert Glory
  A (837,-5,1901) B (1865,66,1221); copy the rest of the table from `docs/research/33-online-map-coverage.md` lines 47-71),
  keyed by display name, with a comment that these are measured actor positions, not archive data, pending
  `AIMAPS.MPS`.
- [ ] **Step 2: `collision.ts`**: world-space polygons from `SceneNode.collision` through `placeInstances`
  matrices; `clutter.ts`: `CLUTTER.ZAR` instances (96-byte matrix + `scale_inverse`), test on Desert Glory: 6 models /
  110 instances (36 §2).
- [ ] **Step 3: `overlays.ts`**: collision as translucent `LineSegments` per polygon edge (toggle), spawns as two
  coloured spheres with labels (toggle), wireframe toggle, untextured-chunk highlight toggle (chunks whose texture
  failed to resolve render magenta).
- [ ] **Step 4: Diagnostics**: `loadMap` collects every caught decode error per chunk/model/texture into
  `diagnostics: string[]`; the UI lists them; a map with diagnostics still renders what decoded.
- [ ] **Step 5: Playwright**: load `DESERT GLORY` and `CROSSROADS` too; assert triangles > 2000 and record the
  diagnostics count for each (0 expected; if not 0, list them in spec section 9 as M6 work, do not fix tonight).
  Screenshots into `web/redotcom/test-fixtures/screens/`. Look at them.
- [ ] **Step 6: Commit** — `feat(web/viewer): collision and spawn overlays, a diagnostics panel, and Desert Glory and Crossroads rendering beside Frostfire (M4)`.

---

## Self-review

- **Spec coverage**: §3.1 archive (Tasks 3-6, ISO source deferred to M5 as the spec says), §3.2 gs (7-8), §3.3
  mesh (9-12), §3.4 scene (15-16), §3.5 viewer (14, 16), §5 verification (tests in every task; goldens in 8;
  Playwright in 14 and 16), §6 milestones M0-M4 (Tasks 1-16), §7 conventions (Global Constraints). M5 (ISO) and M6
  (all 22 maps) are outside this plan and get their own when M4 closes.
- **Placeholders**: Task 11 is deliberately a research deliverable and Task 12's code shape is marked as
  dependent on it; that is the one unknown the spec names, not a placeholder. Task 5's `find` paths and Task 10's
  unpack order carry an explicit "print once and fix the expectation" instruction because the scratch dumps did not
  record those two details.
- **Type consistency**: `Reader` (1) used by 3, 4, 5, 7, 9; `Zar`/`ZarKey` (4) used by 5, 7, 8, 9, 15; `Chain`
  (9) consumed by 10, 12; `VuPacket` (10) consumed by 12; `MeshData` (12) consumed by 13, 14, 15; `TextureRecord`,
  `PaletteTable`, `Rgba` (7, 8) consumed by 14; `AssetSource` (5) implemented by 5 and 6, consumed by 14.
