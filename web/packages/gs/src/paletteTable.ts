import { Zar } from '@s2u/archive';
import { parsePaletteRecord, type PaletteRecord } from './palette';

const PALETTES = 'palettes';    // 36 §5: the group every `*_PAL.ZED` hangs its `texpal_<id>` keys under

/**
 * One id-to-palette map over every `*_PAL.ZED` a map loads. The gsaddr id space is global across those
 * archives (36 §5), so a texture's `TEX0.CBP` is resolved against the whole set, not against one archive.
 */
export class PaletteTable {
  private readonly byAddr = new Map<number, PaletteRecord>();

  /** A later archive never replaces an id an earlier one already claimed: the first load wins. */
  add(palette: PaletteRecord): void {
    if (!this.byAddr.has(palette.gsaddr)) this.byAddr.set(palette.gsaddr, palette);
  }

  get(gsaddr: number): PaletteRecord | undefined { return this.byAddr.get(gsaddr); }

  /** The first palette added: what a texture whose CBP names nothing is decoded with, under protest. */
  get first(): PaletteRecord | undefined { return this.byAddr.values().next().value; }

  get size(): number { return this.byAddr.size; }

  static fromZars(pals: Zar[]): PaletteTable {
    const table = new PaletteTable();
    for (const zar of pals) {
      const group = zar.find(PALETTES);
      if (!group) continue;
      for (const key of group.children) {
        const par = zar.child(key, 'par'), buf = zar.child(key, 'buf');   // 36 §5
        if (!par || !buf) continue;
        table.add(parsePaletteRecord(zar.data(par), zar.data(buf)));
      }
    }
    return table;
  }
}
