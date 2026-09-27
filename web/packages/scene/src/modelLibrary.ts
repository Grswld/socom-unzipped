import { modelNodes } from '@s2u/mesh';
import type { Zar, ZarKey } from '@s2u/archive';
import { visualNodes, type SceneNode } from './sceneGraph';

/**
 * The model buffers a map draws from: `WORL_MDL.ZED` (the world), `MP<N>_MDL.ZED` (the props) and
 * `FLIB_MDL.ZED` (the mission's own asset library), keyed by model name (36 section 2).
 *
 * The chunk-key naming is `hookupVisuals`' two `sprintf`s (`zVisual/vis_main.cpp:88-105` and `:118-131`),
 * and `CLIB_MDL.ZED` is excluded the way the engine excludes it: a model that has a mesh takes the
 * `MESH_<name>` path and never reaches the chunk lookup at all (`vis_main.cpp:31-38`, `:181-185`).
 */

/** One model's chain buffer and the chunk offsets inside it (36 section 2: each child key is a u32). */
export interface ModelEntry {
  name: string;
  buffer: Uint8Array;
  /** The `N...` children, name and byte offset, in key order. */
  nodes: { name: string; offset: number }[];
}

export interface ModelLibrary {
  get(name: string): ModelEntry | undefined;
  names(): string[];
  /** Model keys that were not admitted, and why: a mesh model, or a buffer whose walk threw. */
  skipped: { name: string; reason: string }[];
}

/** `sprintf(buf, "MESH_%s", model->m_name)` -- a character model, not a chunked one (vis_main.cpp:36). */
const MESH_PREFIX = 'MESH_';
const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/**
 * The key a chunk is stored under. With instances, `hookupVisuals` writes `N%03d_I%03d_V%02d` (node,
 * instance, visual); with none it falls back to `N%03d_%03d` (node, visual) -- `vis_main.cpp:88` and
 * `:130`. `instanceIndex` is null for the fallback form, which is what the world model uses.
 */
export function chunkKey(nodeIndex: number, instanceIndex: number | null, visualIndex: number): string {
  return instanceIndex === null
    ? `N${pad(nodeIndex, 3)}_${pad(visualIndex, 3)}`
    : `N${pad(nodeIndex, 3)}_I${pad(instanceIndex, 3)}_V${pad(visualIndex, 2)}`;
}

/**
 * Every chunk key a model's buffer should hold, given how many instance contexts it has: one per
 * (visual-bearing node, context, visual). With no contexts the model is drawn once, under the fallback
 * naming. This is the prediction that pins the mapping down -- it reproduces all 46 of Frostfire's key
 * sets exactly.
 */
export function expectedChunks(model: SceneNode, instanceCount: number): string[] {
  const out: string[] = [];
  visualNodes(model).forEach((node, nodeIndex) => {
    if (instanceCount === 0) {
      for (let v = 0; v < node.visuals; v++) out.push(chunkKey(nodeIndex, null, v));
      return;
    }
    for (let i = 0; i < instanceCount; i++) {
      for (let v = 0; v < node.visuals; v++) out.push(chunkKey(nodeIndex, i, v));
    }
  });
  return out;
}

/**
 * Reads the model buffers out of the given archives. Later archives do not replace earlier ones: the
 * world model is unique and the prop libraries do not collide on Frostfire, so a repeated name is a
 * surprise worth recording rather than resolving silently.
 */
export function loadModelLibrary(zars: Zar[]): ModelLibrary {
  const entries = new Map<string, ModelEntry>();
  const skipped: { name: string; reason: string }[] = [];
  for (const zar of zars) {
    for (const key of zar.root.children) {
      if (key.name.startsWith(MESH_PREFIX)) {
        skipped.push({ name: key.name, reason: 'a mesh model: its chains are not VIF chunks (vis_main.cpp:31-38)' });
        continue;
      }
      if (entries.has(key.name)) {
        skipped.push({ name: key.name, reason: 'a second model of this name; the first one is kept' });
        continue;
      }
      try {
        entries.set(key.name, { name: key.name, buffer: zar.data(key), nodes: chunkOffsets(zar, key) });
      } catch (e) {
        skipped.push({ name: key.name, reason: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return {
    get: (name) => entries.get(name),
    names: () => [...entries.keys()],
    skipped,
  };
}

function chunkOffsets(zar: Zar, key: ZarKey): { name: string; offset: number }[] {
  const nodes = modelNodes(zar, key);
  const strays = key.children.filter((c) => c.size === 4 && !/^N\d{3}_(\d{3}|I\d{3}_V\d{2})(_L)?$/.test(c.name));
  if (strays.length > 0) throw new Error(`children ${strays.map((s) => s.name).join(', ')} are not chunk keys`);
  return nodes;
}
