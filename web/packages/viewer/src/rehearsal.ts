import type { Object3D } from 'three';

/**
 * The walk's first draws, made before the walk (research 90 §9, #21).
 *
 * On WebGL2 the frame that entered the walk took 167-208 ms (MP9, MP10, MP51, both looks; 17-33 ms on WebGPU) with no
 * program linked in it and no slow texture upload (`./linkLog`, `tools/entry-links.ts`, 2026-09-29): every program it
 * drew was compiled by the walk's warm-up (`ViewerRenderer.prepare`), but none had been *drawn* -- the SEAL, its rifle,
 * the shadow map's pass, the HUD and the reticle meet the driver for the first time in that frame. [Reading, to be
 * measured: a compile warms the link, and the first draw has a cost of its own on ANGLE's D3D11 -- the executables for
 * the draw's vertex layout and outputs, the first use of each buffer and texture -- paid in the GPU process, which the
 * page's next synchronous call waits for; WebGPU has no such step.] So the page draws each of them once ahead of time,
 * in a frame before the walk, just before that frame's own render, which clears over it: nothing of it is ever seen.
 *
 * `rehearse` shows exactly `show` -- every object under each, unculled -- and the path from `root` down to it, hides
 * `root`'s other children, calls `draw`, and puts every flag back, whatever `draw` does. What `skip` answers true for
 * stays as it is, with everything under it (an effect light's overlay: not the walk's, and warmed with the effects).
 */
export function rehearse(root: Object3D, show: readonly Object3D[], draw: () => void, skip: (o: Object3D) => boolean = () => false): void {
  const flags: { o: Object3D; visible: boolean; culled: boolean }[] = [];
  const keep = (o: Object3D): void => { flags.push({ o, visible: o.visible, culled: o.frustumCulled }); };
  const onPath = new Set<Object3D>();
  for (const s of show) for (let o: Object3D | null = s; o && o !== root; o = o.parent) onPath.add(o);
  try {
    for (const c of root.children) {
      if (onPath.has(c)) continue;
      keep(c);
      c.visible = false;
    }
    for (const o of onPath) { keep(o); o.visible = true; }
    for (const s of show) {
      const walk = (o: Object3D): void => {
        if (skip(o)) return;
        keep(o);
        o.visible = true;
        o.frustumCulled = false;
        for (const c of o.children) walk(c);
      };
      walk(s);
    }
    draw();
  } finally {
    for (let i = flags.length - 1; i >= 0; i--) {
      const { o, visible, culled } = flags[i]!;
      o.visible = visible;
      o.frustumCulled = culled;
    }
  }
}
