import { parseRdr, rdrGet, Zar, zdbMember, type RdrNode, type ZdbEntry } from '@s2u/archive';
import { flattenScene, parseSceneGraph, transformPoint } from '@s2u/scene';

/**
 * The map's own context actions (web/docs/research/87-hud.md §5): `READERM.ZAR/actions.rdr` lists, per map, the
 * scene nodes an action hangs on -- `node`, `valve`, `anim`, `type` (`DOOR`, `MPBOMB`), `range` (units) and the
 * prompt's `bitmap` (`action_door_open.tif`, `action_MP_bomb.tif`). This is where the door icon comes from: the ELF
 * never names it, the map data does. Frostfire has three doors (`bdoor_4`, `wdoor_1`, `wdoor_2`), Blizzard six doors
 * and two bomb sites, Desert Glory one door, Abandoned none.
 */
export interface MapAction {
  node: string;
  type: string;
  range: number;
  bitmap: string;
  /** The node's origin in the world, game units (the first placement of that name under `worldmodel`). */
  at: [number, number, number];
}

/** The actions of a map archive whose nodes are placed; a map without the script has none. Never throws. */
export function readMapActions(bytes: Uint8Array, toc: ZdbEntry[], stem: string): { actions: MapAction[]; diagnostics: string[] } {
  let script: RdrNode;
  try {
    const readerm = Zar.parse(zdbMember(bytes, toc, 'READERM.ZAR'));
    const key = readerm.root.children.find((k) => k.name.toLowerCase() === 'actions.rdr');
    if (!key) return { actions: [], diagnostics: [] };
    script = parseRdr(readerm.data(key));
  } catch (e) {
    return { actions: [], diagnostics: [`actions: READERM.ZAR: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const root = Array.isArray(script) && Array.isArray(script[0]) && typeof script[0][0] === 'string' ? script[0] : script;
  const list = (rdrGet(root, 'actions') ?? []) as RdrNode[];
  const records = list.filter((r): r is RdrNode[] => Array.isArray(r) && rdrGet(r, 'node') !== undefined);
  if (records.length === 0) return { actions: [], diagnostics: [] };
  const one = (r: RdrNode[], k: string): string => {
    const v = rdrGet(r, k);
    return typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '';
  };
  let where: Map<string, [number, number, number]>;
  try {
    const models = parseSceneGraph(Zar.parse(zdbMember(bytes, toc, `${stem}_GEO.ZED`)));
    where = new Map();
    for (const f of flattenScene(models, 'worldmodel')) {
      const name = f.node.name.toLowerCase();
      if (!where.has(name)) where.set(name, transformPoint(f.world, 0, 0, 0));
    }
  } catch (e) {
    return { actions: [], diagnostics: [`actions: ${stem}_GEO.ZED: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const actions: MapAction[] = [];
  const diagnostics: string[] = [];
  for (const r of records) {
    const node = one(r, 'node');
    const at = where.get(node.toLowerCase());
    if (!at) { diagnostics.push(`actions: node ${node} is not placed`); continue; }
    actions.push({ node, type: one(r, 'type'), range: Number(one(r, 'range')) || 0, bitmap: one(r, 'bitmap').toLowerCase(), at });
  }
  return { actions, diagnostics };
}

/**
 * The action whose node is nearest the feet within its `range` (units, measured in 3D from the node's origin
 * [estimate: the game's own test -- facing, a cone, the valve's state -- was not traced]), or none.
 */
export function actionInReach(actions: readonly MapAction[], feet: readonly number[] | null, types?: readonly string[]): MapAction | null {
  if (!feet) return null;
  let best: MapAction | null = null, bestD = Infinity;
  for (const a of actions) {
    if (types && !types.includes(a.type)) continue;
    const d = Math.hypot(a.at[0] - feet[0]!, a.at[1] - feet[1]!, a.at[2] - feet[2]!);
    if (d <= a.range && d < bestD) { best = a; bestD = d; }
  }
  return best;
}
