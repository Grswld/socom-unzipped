import { Vector3 } from 'three';
import type { Node } from 'three/webgpu';
import { normalWorld, uniform, varying, vec3 } from 'three/tsl';
import type { GlobalLighting } from '@s2u/scene';
import { FALLBACK_RIG } from './lighting';

/**
 * The map's `GlobalLighting` rig on a moving thing, on the GPU, per vertex, every frame: the VU1 light command
 * (`0x54`/`0x18`, `./lighting`'s `applyLighting` is its CPU twin) on the normal as the frame poses it -- skinned
 * through the bones for the SEAL (three's skinning moves `normalWorld` with the vertex), turned with the hand for the
 * rifle, with the throw for a grenade. The CPU path lit the body's bind-pose normals and re-lit them only when the
 * body had turned ten degrees, so a raised arm or a crouched back kept the light of the standing pose.
 *
 * `lit = ambient + sum_k C_k * max(dot(D_k, N), 0)`, three directions in the rig's world frame -- the same frame the
 * world's normals are lit in, so a SEAL beside a wall is lit from where the wall is. Per vertex (a varying), as the VU
 * lights vertices and the GS interpolates the colour.
 */
export interface RigShading {
  /** The lit colour, rgb, 1.0 the PS2's unity; multiply the vertex's material colour by it. */
  lit: Node<'vec3'>;
  /** Puts a rig on the uniforms (the fallback when the map has none, as `applyLighting` does). */
  set(rig: GlobalLighting | null): void;
}

export function rigShading(rig: GlobalLighting | null): RigShading {
  const dirs = [0, 1, 2].map(() => uniform(new Vector3()));
  const colours = [0, 1, 2].map(() => uniform(new Vector3()));
  const ambient = uniform(new Vector3());
  const set = (next: GlobalLighting | null): void => {
    const r = next ?? FALLBACK_RIG;
    for (let k = 0; k < 3; k++) {
      dirs[k]!.value.set(...r.directions[k]!);
      colours[k]!.value.set(...r.colours[k]!);
    }
    ambient.value.set(...r.ambient);
  };
  set(rig);
  const n = normalWorld;
  let sum: Node<'vec3'> = vec3(ambient);
  for (let k = 0; k < 3; k++) sum = sum.add(vec3(colours[k]!).mul(n.dot(dirs[k]!).max(0)));
  return { lit: varying(sum) as unknown as Node<'vec3'>, set };
}
