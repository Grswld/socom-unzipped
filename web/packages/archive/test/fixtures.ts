import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures');
export const FIXTURES_ABSENT = 'fixtures absent: run npm run extract-maps';
export function fixture(name: string): Uint8Array | null {
  const p = resolve(root, name);
  return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
}
