import {
  Box3, BufferAttribute, BufferGeometry, CanvasTexture, GridHelper, LineBasicMaterial,
  LineSegments, Mesh, MeshBasicMaterial, Object3D, Scene, SphereGeometry, Sprite, SpriteMaterial,
  Vector3,
} from 'three';
import type { Spawns } from '@s2u/scene';

/** Frostfire's playable floor is y = 100; the grid sits there so heights read against something known. */
const GRID_Y = 100;
/** Game units: 100 units is 10 m at `MetersPerUnit` 0.1, so a square is a room. */
const GRID_STEP = 100;
/** A spawn marker, in game units: 8 is about a player's shoulders at `MetersPerUnit` 0.1. */
const SPAWN_RADIUS = 4;
/** The label floats clear of its sphere rather than inside it. */
const LABEL_ABOVE = 26;
const LABEL_SIZE = 22;
/** A's marker and B's, the two sides of every measured round. */
const SPAWN_COLOURS = { a: 0x4d9bff, b: 0xff6a3d } as const;

/**
 * What the viewer draws on top of a map: a grid at the floor height, the collision hull
 * as coloured line segments, and the two measured spawns as labelled spheres.
 *
 * Everything here is an answer to "is what I am looking at in the right place?", so all of it is off by
 * default and each piece is its own toggle. The collision hull and the spawns come from the map; the
 * grid comes from nothing but the frame itself.
 */
export class Overlays {
  private grid: GridHelper | null = null;
  private collision: LineSegments | null = null;
  private spawns: Object3D | null = null;
  private collisionOn = false;
  /** The current map's hull arrays, waiting to be made into an object -- see `placeCollision`. */
  private pendingCollision: { positions: Float32Array; colors: Uint8Array } | null = null;
  private spawnsOn = false;

  constructor(private readonly scene: Scene) {
  }

  /** Re-sizes the grid to the map that is now loaded and centres it on that map. */
  place(box: Box3): void {
    const visible = this.grid?.visible ?? false;
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
    }
    const size = box.isEmpty() ? 2000 : Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
    const span = Math.ceil(size / GRID_STEP) * GRID_STEP;
    const centre = box.isEmpty() ? new Vector3() : box.getCenter(new Vector3());
    this.grid = new GridHelper(span, Math.max(1, span / GRID_STEP), 0x5a6472, 0x323a45);
    this.grid.position.set(centre.x, GRID_Y, centre.z);
    this.grid.visible = visible;
    this.scene.add(this.grid);
  }

  /**
   * The new map's collision hull: one segment per polygon side, already in world space and already
   * coloured by `ditype` (`@s2u/scene`'s `collisionLines`). Drawn translucent and without depth writes,
   * because the hull is mostly coplanar with the floor it guards and an opaque line over a lit floor
   * reads as a crack in the geometry.
   */
  placeCollision(lines: { positions: Float32Array; colors: Uint8Array }): void {
    this.dropCollision();
    // **Held, not built.** Shadow Falls' hull is 13,250 polygons and tens of thousands of segments, and
    // building it costs that whichever way the checkbox is set. It is off by default and usually stays
    // off, so the arrays are kept and the object is made the first time it is actually asked for.
    this.pendingCollision = lines.positions.length === 0 ? null : lines;
    if (this.collisionOn) this.realiseCollision();
  }

  /** Builds the held hull, once. Called by the first `setCollision(true)` after a map load. */
  private realiseCollision(): void {
    const lines = this.pendingCollision;
    if (!lines || this.collision) return;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(lines.positions, 3));
    geometry.setAttribute('color', new BufferAttribute(lines.colors, 3, true));
    this.collision = new LineSegments(geometry, new LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false,
    }));
    this.collision.frustumCulled = false;                 // one object spans the map; culling it hides it
    this.collision.visible = this.collisionOn;
    this.scene.add(this.collision);
  }

  /** The new map's two measured spawns, or nothing when none were measured for it. */
  placeSpawns(spawns: Spawns | null): void {
    this.dropSpawns();
    if (!spawns) return;
    const group = new Object3D();
    for (const [side, feet] of [['a', spawns.a], ['b', spawns.b]] as ['a' | 'b', [number, number, number]][]) {
      const colour = SPAWN_COLOURS[side];
      const ball = new Mesh(
        new SphereGeometry(SPAWN_RADIUS, 16, 12),
        // Depth-tested like anything else: a marker that shines through a wall would lie about where it is.
        new MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.8 }),
      );
      ball.position.set(feet[0], feet[1] + SPAWN_RADIUS, feet[2]);   // the table's y is the feet
      group.add(ball);
      const label = new Sprite(new SpriteMaterial({ map: letter(side.toUpperCase()), transparent: true, depthTest: false }));
      label.position.set(feet[0], feet[1] + LABEL_ABOVE, feet[2]);
      label.scale.set(LABEL_SIZE, LABEL_SIZE, 1);
      group.add(label);
    }
    group.visible = this.spawnsOn;
    this.spawns = group;
    this.scene.add(group);
  }

  setGrid(visible: boolean): void {
    if (this.grid) this.grid.visible = visible;
  }

  setCollision(visible: boolean): void {
    this.collisionOn = visible;
    if (visible) this.realiseCollision();
    if (this.collision) this.collision.visible = visible;
  }

  setSpawns(visible: boolean): void {
    this.spawnsOn = visible;
    if (this.spawns) this.spawns.visible = visible;
  }

  private dropCollision(): void {
    this.pendingCollision = null;
    if (!this.collision) return;
    this.scene.remove(this.collision);
    this.collision.geometry.dispose();
    (this.collision.material as LineBasicMaterial).dispose();
    this.collision = null;
  }

  private dropSpawns(): void {
    if (!this.spawns) return;
    this.scene.remove(this.spawns);
    for (const child of this.spawns.children) {
      if (child instanceof Mesh) {
        child.geometry.dispose();
        (child.material as MeshBasicMaterial).dispose();
      } else if (child instanceof Sprite) {
        child.material.map?.dispose();
        child.material.dispose();
      }
    }
    this.spawns = null;
  }
}

/** One character on a transparent square, for a sprite label. A canvas is the only font three.js has. */
function letter(text: string): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.font = `bold ${size * 0.7}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = size * 0.1;
  ctx.strokeStyle = '#000000';                            // an outline, so the letter reads over any map
  ctx.strokeText(text, size / 2, size / 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, size / 2, size / 2);
  return new CanvasTexture(canvas);
}
