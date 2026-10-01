import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// S2U_TEST_FIXTURES points the fixture-backed tests elsewhere -- an empty directory checks that they skip cleanly
// without game data, as on CI (release review BL-7), without touching the extracted test-fixtures/.
const root = process.env.S2U_TEST_FIXTURES ? resolve(process.env.S2U_TEST_FIXTURES) : resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures');
export const FIXTURES_ABSENT = 'fixtures absent: run npm run extract-maps';
export function fixture(name: string): Uint8Array | null {
  const p = resolve(root, name);
  return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
}
