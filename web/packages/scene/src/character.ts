import { rdrGet, type RdrNode } from '@s2u/archive';

/**
 * The character types: `READERC.ZAR`'s `character.rdr` (web/docs/research/78 §5). Not in a map archive -- a file
 * of its own on the disc, which the extractor copies beside the maps -- and the only place that says which part
 * a piece of gear hangs from.
 *
 * The file is one record: `AngleUnits`, `ai_settings`, `body_items` (the parts gear may name, with the gear nodes
 * after them), `gear` (one record a piece: `name`, `model`, and `ofs` = the part, a translation and three angles),
 * and `characters`, a flat list of `name [":" base] record` in which a character takes from its base whatever it
 * does not state -- `mp2_seal1 : mp_seal1 : mp_seal : ... : basic_seal`.
 */

/** One piece of gear: its model and where on the body it goes. */
export interface GearDef {
  name: string;
  /** The `FLIB_MDL.ZED` model: the `model` file name without its extension (`gear_holster.flt`). */
  model: string;
  /** The part it hangs from (`body_items`, the skeleton's names). */
  part: string;
  /** In the part's frame. */
  translation: [number, number, number];
  /** About x, then y, then z, the fixed axes, in `AngleUnits` (`gearMatrix`). */
  rotation: [number, number, number];
}

/** One entry of `characters`: its base, and its own record. */
export interface CharacterType { name: string; base: string | null; record: RdrNode }

export interface CharacterTable {
  angleUnits: 'DEG' | 'RAD';
  /** The parts gear may name, without the trailing `gear_nodes` list. */
  bodyItems: string[];
  gear: Map<string, GearDef>;
  characters: Map<string, CharacterType>;
  /** A key of a character, looked up through its bases; undefined when none of them states it. */
  get(character: string, key: string): RdrNode | undefined;
  /** The character's mesh, `model_name` without its extension, or null. */
  model(character: string): string | null;
  /** The character's `default_gear` names, or none. */
  defaultGear(character: string): string[];
}

/** `seal_A_scuba.xsi`, `gear_holster.flt`, `seal_black_hat.mb`: the exporter's file names, stripped. */
const stem = (file: string): string => file.replace(/\.[a-z]+$/i, '');
const list = (n: RdrNode | undefined): RdrNode[] => (Array.isArray(n) ? n : n === undefined ? [] : [n]);
/**
 * A list of records. `rdrGet` hands back a one-element value list as its element, so a list holding a single
 * record arrives as that record -- a list that starts with a key -- and is wrapped back up here.
 */
const records = (n: RdrNode | undefined): RdrNode[] => (Array.isArray(n) && typeof n[0] === 'string' ? [n] : list(n));
/** A bases chain longer than this is a loop, not an inheritance. */
const MAX_BASES = 32;

export function parseCharacterTable(root: RdrNode): CharacterTable {
  const units = rdrGet(root, 'AngleUnits');
  const angleUnits = units === 'RAD' ? 'RAD' : 'DEG';
  const items = list(rdrGet(root, 'body_items'));
  const bodyItems = items.filter((x): x is string => typeof x === 'string' && x !== 'gear_nodes');

  const gear = new Map<string, GearDef>();
  for (const record of records(rdrGet(root, 'gear'))) {
    const name = rdrGet(record, 'name'), model = rdrGet(record, 'model'), ofs = list(rdrGet(record, 'ofs'));
    if (typeof name !== 'string' || typeof model !== 'string') continue;
    const [part, t, r] = ofs;
    const three = (n: RdrNode | undefined): [number, number, number] => {
      const v = list(n).map(Number);
      return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
    };
    if (typeof part !== 'string') continue;
    gear.set(name, { name, model: stem(model), part, translation: three(t), rotation: three(r) });
  }

  const characters = new Map<string, CharacterType>();
  const entries = list(rdrGet(root, 'characters'));
  for (let i = 0; i < entries.length;) {
    const name = entries[i];
    if (typeof name !== 'string') { i++; continue; }
    if (entries[i + 1] === ':' && typeof entries[i + 2] === 'string') {
      characters.set(name, { name, base: entries[i + 2] as string, record: entries[i + 3] ?? [] });
      i += 4;
    } else {
      characters.set(name, { name, base: null, record: entries[i + 1] ?? [] });
      i += 2;
    }
  }

  const get = (character: string, key: string): RdrNode | undefined => {
    let c = characters.get(character);
    for (let depth = 0; c && depth < MAX_BASES; depth++) {
      const v = rdrGet([c.record], key);
      if (v !== undefined) return v;
      c = c.base === null ? undefined : characters.get(c.base);
    }
    return undefined;
  };
  return {
    angleUnits, bodyItems, gear, characters, get,
    model: (character) => { const m = get(character, 'model_name'); return typeof m === 'string' ? stem(m) : null; },
    defaultGear: (character) => list(get(character, 'default_gear')).filter((x): x is string => typeof x === 'string'),
  };
}

/**
 * A gear's offset as the engine stores a matrix, row-major with the translation in the fourth row (24 §1.1):
 * the turn is x, then y, then z about the fixed axes -- `Rz * Ry * Rx` on a column vector -- and that one of the
 * twelve orders is the one under which the SEAL's worn gear undoes its part's bind turn to a few hundredths
 * (78 §5): the gear is modelled in the character's own axes. A point of the gear lands at `p x offset x part`.
 */
export function gearMatrix(gear: GearDef, angleUnits: 'DEG' | 'RAD' = 'DEG'): Float32Array {
  const k = angleUnits === 'DEG' ? Math.PI / 180 : 1;
  const [a, b, c] = gear.rotation.map((x) => x * k) as [number, number, number];
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
  // R = Rz(c) Ry(b) Rx(a), column-vector; the engine's row i is R's column i, the image of axis i.
  const R = [
    [cc * cb, cc * sb * sa - sc * ca, cc * sb * ca + sc * sa],
    [sc * cb, sc * sb * sa + cc * ca, sc * sb * ca - cc * sa],
    [-sb, cb * sa, cb * ca],
  ];
  const [tx, ty, tz] = gear.translation;
  return Float32Array.from([
    R[0]![0]!, R[1]![0]!, R[2]![0]!, 0,
    R[0]![1]!, R[1]![1]!, R[2]![1]!, 0,
    R[0]![2]!, R[1]![2]!, R[2]![2]!, 0,
    tx, ty, tz, 1,
  ]);
}

/**
 * The player's character on a map: the first of the `navyseals` its `READERM.ZAR/chartype.rdr` lists -- `mp2_seal1`
 * on Frostfire -- or null when the file names none.
 */
export function playerCharacter(chartype: RdrNode): string | null {
  const seals = records(rdrGet(chartype, 'navyseals'));
  for (const entry of seals) {
    const c = rdrGet(entry, 'character');
    if (typeof c === 'string') return c;
  }
  return null;
}
