import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssetSource } from './assetSource';

/** An `AssetSource` over a directory on disk. Node only: import it from `@s2u/archive/node`. */
export class FsAssetSource implements AssetSource {
  constructor(private readonly root: string) {}

  async list(): Promise<string[]> {
    const out: string[] = [];
    const rec = async (rel: string): Promise<void> => {
      for (const entry of await readdir(join(this.root, rel), { withFileTypes: true })) {
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await rec(path);
        else out.push(path);
      }
    };
    await rec('');
    return out.sort();
  }

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(join(this.root, path)));
  }
}
