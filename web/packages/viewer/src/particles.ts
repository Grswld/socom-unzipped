import { BufferAttribute, BufferGeometry, Group, Matrix4, Mesh, Vector3, type Camera } from 'three';
import type { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  frictionFactor, PARTICLE_B, particleColour, particleFade, particleScale, sourceVelocity,
  type EffectContext, type ParticleSource,
} from '@s2u/scene';
import { effectMaterial } from './effectMaterials';
import type { EffectTexture } from './effectData';

/**
 * The particle manager the zAnim `PARTICLE_SOURCE` command drives (web/docs/research/89 §3; `@s2u/scene`'s
 * `effectParticles` for the fields and their decomp lines):
 *
 * - **A source** is one per animation run and name (`FUN_0026ea20`): later commands of the run update it; it emits while
 *   it is active (flag A 0x1 sets it to A 0x2) and its run lives, then dies and lets its particles run out.
 * - **Emission** (`FUN_00329b40`): the first tick after activation only records where the source is; after it an
 *   accumulator gains `dt` and every whole `interval` is an event of `perEvent` particles, spread over the frame, until
 *   the `events` allowed (-1: no end) are spent.
 * - **A particle** (`FUN_00327cd0`, `FUN_003282b0`): its size, lifetime and starting age drawn from their ranges; its
 *   velocity the base (in the node's frame) plus the world velocity plus the random box; each tick `pos += v dt`, then
 *   `v += a dt`, then the friction; it dies at its lifetime.
 * - **The draw** (`FUN_003251b0`): a camera-facing square `2 size scale(t)` across, the colour keys as the vertex colour
 *   (MODULATE: 1.0 leaves the texel), the alpha times the camera fade, back to front, no depth write, the texture's own
 *   blend (`./effectMaterials`).
 */

type Vec3 = [number, number, number];

interface Particle {
  source: ParticleSource;
  texture: string;
  position: Vec3;
  /** Where it was a tick ago: a streaked particle is drawn from here to `position` (`FUN_00326350`). */
  prev: Vec3;
  /** A rotated particle's angle (radians), spin and the spin's acceleration (`FUN_003282b0`). */
  angle: number;
  spin: number;
  spinAccel: number;
  velocity: Vec3;
  size: number;
  age: number;
  life: number;
}

/** The streak's two numbers when the source sets none (`FUN_0032ab20`'s defaults: the tail's reach and its alpha). */
export const STREAK_DEFAULT: readonly [number, number] = [1, 0.3];

interface Source {
  key: string;
  config: ParticleSource;
  active: boolean;
  /** Its node's world matrix at the command (the base velocity's frame; followed with flag A 0x10), or null. */
  node: Matrix4 | null;
  /** A fixed place (flags A 0x8 / 0x4 / 0x20), or null: at its node's origin. */
  position: Vec3 | null;
  /** The base velocity (the node's frame) and the world one, resolved against the context at the command. */
  base: Vec3;
  world: Vec3;
  alive: () => boolean;
  /** Its node's matrix now, for a source that follows it (flag A 0x10), or null. */
  follow: (() => Matrix4 | null) | null;
  started: boolean;
  acc: number;
  events: number;
}

/** The most particles drawn at once (the game sorts up to 5000: `FUN_00326c30`). */
export const MAX_PARTICLES = 2000;

const lerp = (r: readonly [number, number], u: number): number => r[0] + (r[1] - r[0]) * u;
/** A number an owner (a run) keys its sources by. */
const ownerIds = new WeakMap<object, number>();

export class ParticleSystem {
  readonly object = new Group();
  private readonly sources = new Map<string, Source>();
  private particles: Particle[] = [];
  private textures = new Map<string, EffectTexture>();
  private readonly meshes = new Map<string, Group3>();
  /** Particles emitted so far, for the hook. */
  emitted = 0;

  constructor(private readonly random: () => number = Math.random) {
    this.object.name = 'particles';
  }

  setTextures(textures: ReadonlyMap<string, EffectTexture>): void {
    this.clear();
    for (const { mesh, material } of this.meshes.values()) { this.object.remove(mesh); mesh.geometry.dispose(); material.map?.dispose(); material.dispose(); }
    this.meshes.clear();
    this.textures = new Map(textures);
  }

  clear(): void {
    this.sources.clear();
    this.particles = [];
    for (const { mesh } of this.meshes.values()) mesh.visible = false;
  }

  count(): number {
    return this.particles.length;
  }

  /** Sources that are active and alive (the hook). */
  activeSources(): number {
    let n = 0;
    for (const s of this.sources.values()) if (s.active && s.alive()) n++;
    return n;
  }

  /**
   * A `PARTICLE_SOURCE` command of the run `owner` (its name keys the source): the source made or updated, switched as
   * the command says, placed at `matrix`; `alive` answers while its run lives.
   */
  emit(
    config: ParticleSource, node: Matrix4 | null, ctx: EffectContext, owner: string,
    alive: () => boolean = () => false, ownerId: unknown = null, follow: (() => Matrix4 | null) | null = null,
  ): void {
    const id = ownerId !== null && typeof ownerId === 'object' ? ownerIds.get(ownerId) ?? this.idOf(ownerId) : 0;
    const key = `${owner}|${config.name}|${id}`;
    // The place (decomp 112876-112933): the context's position, the offset, the node's origin, the random block.
    let position: Vec3 | null = null;
    const add = (v: Vec3): void => { position = position ? [position[0] + v[0], position[1] + v[1], position[2] + v[2]] : [...v]; };
    if (config.atContext && ctx.position) add(ctx.position);
    if ((config.flagsA & 0x4) !== 0) add(config.offset);
    if (config.atNode && node) add([node.elements[12]!, node.elements[13]!, node.elements[14]!]);
    if (position && config.positionBlock) {
      const { base, range } = config.positionBlock;
      add([base[0] + range[0] * this.random(), base[1] + range[1] * this.random(), base[2] + range[2] * this.random()]);
    }
    const base = sourceVelocity(config.baseFrom, config.baseVelocity, config.baseScale, config.baseUnit, ctx);
    const world = sourceVelocity(config.worldFrom, config.worldVelocity, config.worldScale, config.worldUnit, ctx);
    let s = this.sources.get(key);
    if (!s) {
      s = { key, config, active: false, node: node?.clone() ?? null, position, base, world, alive, follow, started: false, acc: 0, events: config.events };
      this.sources.set(key, s);
    } else {
      if (config.interval !== null) { s.config = config; s.events = config.events; }
      s.node = node?.clone() ?? s.node;
      s.position = position ?? s.position;
      s.base = base;
      s.world = world;
    }
    if (config.setActive !== null && config.setActive !== s.active) {
      s.active = config.setActive;
      s.started = false;
      s.acc = 0;
    }
  }

  private nextId = 0;
  private idOf(owner: unknown): number {
    if (owner === null || typeof owner !== 'object') return 0;
    const id = ++this.nextId;
    ownerIds.set(owner, id);
    return id;
  }

  update(dt: number, camera: Camera | null): void {
    for (const [key, s] of this.sources) {
      if (!s.alive()) { this.sources.delete(key); continue; }
      if (!s.active || s.config.interval === null || s.config.interval <= 0) continue;
      if (s.follow && !s.position) { const m = s.follow(); if (m) s.node = m.clone(); }
      if (!s.started) { s.started = true; continue; }       // the first tick records the place and emits nothing
      s.acc += dt;
      let n = Math.floor(s.acc / s.config.interval + 1e-9);
      s.acc -= n * s.config.interval;
      if (s.events >= 0) { n = Math.min(n, s.events); s.events -= n; }
      for (let i = 0; i < n; i++) {
        const sub = n > 1 ? (dt * (n - 1 - i)) / n : 0;    // spread over the frame: the earliest has aged the most
        for (let k = 0; k < s.config.perEvent; k++) this.spawn(s, sub);
      }
    }
    const alive: Particle[] = [];
    for (const p of this.particles) {
      p.age += dt;
      if (p.age >= p.life) continue;
      const c = p.source;
      p.prev[0] = p.position[0]; p.prev[1] = p.position[1]; p.prev[2] = p.position[2];
      p.position[0] += p.velocity[0] * dt; p.position[1] += p.velocity[1] * dt; p.position[2] += p.velocity[2] * dt;
      p.velocity[0] += c.accel[0] * dt; p.velocity[1] += c.accel[1] * dt; p.velocity[2] += c.accel[2] * dt;
      if (p.spin !== 0 || p.spinAccel !== 0) {
        // The angle by the spin, the spin by its acceleration -- stopped where it would change sign.
        p.angle += p.spin * dt;
        const next = p.spin + p.spinAccel * dt;
        p.spin = next * p.spin < 0 ? 0 : next;
        if (p.spin === 0) p.spinAccel = 0;
      }
      if (c.friction !== 0) {
        const d = frictionFactor(c.friction, dt);
        p.velocity[0] *= d; p.velocity[1] *= d; p.velocity[2] *= d;
      }
      alive.push(p);
    }
    this.particles = alive;
    this.draw(camera);
  }

  private spawn(s: Source, sub: number): void {
    if (this.particles.length >= MAX_PARTICLES) return;
    const c = s.config, r = this.random;
    const life = lerp(c.lifetime, r());
    const age = lerp(c.startAge, r()) + sub;
    if (age >= life) return;
    const m = s.node?.elements ?? null;
    // The node's rotation: its matrix's basis, unit length (a node's scale does not scale a velocity).
    const local = (v: Vec3): Vec3 => {
      if (!m) return v;
      const col = (i: number): Vec3 => { const x = m[i]!, y = m[i + 1]!, z = m[i + 2]!, l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
      const a = col(0), b = col(4), cc = col(8);
      return [v[0] * a[0] + v[1] * b[0] + v[2] * cc[0], v[0] * a[1] + v[1] * b[1] + v[2] * cc[1], v[0] * a[2] + v[1] * b[2] + v[2] * cc[2]];
    };
    const base = local(s.base);
    let rand: Vec3 = [lerp(c.randomVelocity[0], r()), lerp(c.randomVelocity[1], r()), lerp(c.randomVelocity[2], r())];
    if ((c.flagsB & PARTICLE_B.LOCAL_RANDOM) !== 0) rand = local(rand);
    const velocity: Vec3 = [base[0] + s.world[0] + rand[0], base[1] + s.world[1] + rand[1], base[2] + s.world[2] + rand[2]];
    const at: Vec3 = s.position ?? (m ? [m[12]!, m[13]!, m[14]!] : [0, 0, 0]);
    const position: Vec3 = [
      at[0] + lerp(c.box[0], r()) + velocity[0] * sub,
      at[1] + lerp(c.box[1], r()) + velocity[1] * sub,
      at[2] + lerp(c.box[2], r()) + velocity[2] * sub,
    ];
    const texture = c.textureMode === 'random' && c.textures.length > 1
      ? c.textures[Math.min(c.textures.length - 1, Math.floor(r() * c.textures.length))]!.name : c.texture ?? '';
    // A rotated particle's spin (`FUN_00327cd0`); its angle is whatever the pool's slot last held: random here.
    const spin = c.spin;
    this.particles.push({
      source: c, texture: texture.toLowerCase(), position, prev: [...position], velocity, size: lerp(c.size, r()), age, life,
      angle: r() * Math.PI * 2, spin: spin ? lerp(spin.spin, r()) : 0, spinAccel: spin ? lerp(spin.accel, r()) : 0,
    });
    this.emitted++;
  }

  /**
   * A streaked particle (type 3, `FUN_00326350`, decomp 224624): a band `2 h` wide from where it was a tick ago to
   * where it is, its head pushed `h` on along the travel and its tail `h x streak[0]` back, the tail's alpha times
   * `streak[1]` -- the sparks' look. False when it has not moved (drawn as a square).
   */
  private streak(p: Particle, h: number, eye: Vector3, rgba: [number, number, number, number], pos: Float32Array, uv: Float32Array, col: Float32Array, q: number): boolean {
    const d = new Vector3(p.position[0] - p.prev[0], p.position[1] - p.prev[1], p.position[2] - p.prev[2]);
    const view = new Vector3(p.position[0] - eye.x, p.position[1] - eye.y, p.position[2] - eye.z).normalize();
    d.addScaledVector(view, -d.dot(view));                // the travel as the screen sees it
    if (d.lengthSq() < 1e-8) return false;
    d.normalize();
    const side = new Vector3().crossVectors(view, d).normalize().multiplyScalar(h);
    const [reach, tailAlpha] = p.source.streak ?? STREAK_DEFAULT;
    const head = new Vector3(...p.position).addScaledVector(d, h);
    const tail = new Vector3(...p.prev).addScaledVector(d, -h * reach);
    const corners: [Vector3, number][] = [
      [tail.clone().sub(side), tailAlpha], [tail.clone().add(side), tailAlpha], [head.clone().add(side), 1], [head.clone().sub(side), 1],
    ];
    corners.forEach(([v, k], i) => {
      const o = q * 4 + i;
      pos[o * 3] = v.x; pos[o * 3 + 1] = v.y; pos[o * 3 + 2] = v.z;
      uv[o * 2] = i === 1 || i === 2 ? 1 : 0;
      uv[o * 2 + 1] = i >= 2 ? 1 : 0;
      col[o * 4] = rgba[0]; col[o * 4 + 1] = rgba[1]; col[o * 4 + 2] = rgba[2]; col[o * 4 + 3] = rgba[3] * k;
    });
    return true;
  }

  /** A drawing group for each of `textures`, made now (the pre-warm compiles their programs at the map's load). */
  warm(textures: Iterable<string>): Mesh[] {
    const out: Mesh[] = [];
    for (const t of textures) out.push(this.groupFor(t.toLowerCase(), 1).mesh);
    return out;
  }

  private groupFor(texture: string, need: number): Group3 {
    let g = this.meshes.get(texture);
    if (g && g.capacity >= need) return g;
    const capacity = Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(1, need))));
    if (!g) {
      const material = effectMaterial(this.textures.get(texture) ?? null, { fog: true });
      const mesh = new Mesh(new BufferGeometry(), material);
      mesh.frustumCulled = false;
      mesh.name = `particles ${texture}`;
      this.object.add(mesh);
      g = { mesh, material, capacity: 0, pos: new BufferAttribute(new Float32Array(0), 3), uv: new BufferAttribute(new Float32Array(0), 2), col: new BufferAttribute(new Float32Array(0), 4) };
      this.meshes.set(texture, g);
    }
    // Grown to a power of two: the buffers are made again only then, and rewritten in place every frame.
    const geometry = new BufferGeometry();
    g.pos = new BufferAttribute(new Float32Array(capacity * 12), 3);
    g.uv = new BufferAttribute(new Float32Array(capacity * 8), 2);
    g.col = new BufferAttribute(new Float32Array(capacity * 16), 4);
    const idx = new Uint32Array(capacity * 6);
    for (let q = 0; q < capacity; q++) idx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
    geometry.setAttribute('position', g.pos);
    geometry.setAttribute('uv', g.uv);
    geometry.setAttribute('color', g.col);
    geometry.setIndex(new BufferAttribute(idx, 1));
    g.mesh.geometry.dispose();
    g.mesh.geometry = geometry;
    g.capacity = capacity;
    return g;
  }

  private draw(camera: Camera | null): void {
    for (const { mesh } of this.meshes.values()) mesh.visible = false;
    if (!camera || this.particles.length === 0) return;
    const eye = new Vector3().setFromMatrixPosition(camera.matrixWorld);
    const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    const byTexture = new Map<string, { p: Particle; d2: number }[]>();
    for (const p of this.particles) {
      const d2 = (p.position[0] - eye.x) ** 2 + (p.position[1] - eye.y) ** 2 + (p.position[2] - eye.z) ** 2;
      let list = byTexture.get(p.texture);
      if (!list) byTexture.set(p.texture, (list = []));
      list.push({ p, d2 });
    }
    const CORNERS: readonly (readonly [number, number])[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (const [texture, list] of byTexture) {
      list.sort((a, b) => b.d2 - a.d2);                  // back to front (`FUN_00326c30`)
      const g = this.groupFor(texture, list.length);
      const pos = g.pos.array as Float32Array, uv = g.uv.array as Float32Array, col = g.col.array as Float32Array;
      let q = 0;
      for (const { p, d2 } of list) {
        const t = p.age / p.life, c = p.source;
        const fade = particleFade(c, d2);
        if (fade <= 0.01) continue;
        const [r, gg, b, a] = particleColour(c, t);
        const h = p.size * particleScale(c, t);
        if (c.type === 3 && this.streak(p, h, eye, [r, gg, b, a * fade], pos, uv, col, q)) { q++; continue; }
        if (c.type === 1 || c.type === 2) {
          const corners = c.type === 1 ? rotatedCorners(p.position, h, p.angle, right, up) : flatCorners(p.position, h);
          for (let k = 0; k < 4; k++) {
            const v = q * 4 + k, [x, y, z, u, w] = corners[k]!;
            pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
            uv[v * 2] = u; uv[v * 2 + 1] = w;
            col[v * 4] = r; col[v * 4 + 1] = gg; col[v * 4 + 2] = b; col[v * 4 + 3] = a * fade;
          }
          q++;
          continue;
        }
        for (let k = 0; k < 4; k++) {
          const [sx, sy] = CORNERS[k]!;
          const v = q * 4 + k;
          pos[v * 3] = p.position[0] + (right.x * sx + up.x * sy) * h;
          pos[v * 3 + 1] = p.position[1] + (right.y * sx + up.y * sy) * h;
          pos[v * 3 + 2] = p.position[2] + (right.z * sx + up.z * sy) * h;
          uv[v * 2] = (sx + 1) / 2;
          uv[v * 2 + 1] = (sy + 1) / 2;
          col[v * 4] = r; col[v * 4 + 1] = gg; col[v * 4 + 2] = b; col[v * 4 + 3] = a * fade;
        }
        q++;
      }
      if (q === 0) continue;
      g.pos.needsUpdate = true; g.uv.needsUpdate = true; g.col.needsUpdate = true;
      g.mesh.geometry.setDrawRange(0, q * 6);
      g.mesh.visible = true;
    }
  }
}

/**
 * A rotated particle (type 1, `FUN_00325580`, decomp 224057): a screen-aligned square turned by its angle, its
 * half-diagonal the size -- corner i at `C + size (cos(θ + iπ/2) right + sin(θ + iπ/2) down)`, uv (0,0) (0,1) (1,1) (1,0).
 */
export function rotatedCorners(c: readonly number[], size: number, angle: number, right: Vector3, up: Vector3): [number, number, number, number, number][] {
  const uvs: [number, number][] = [[0, 0], [0, 1], [1, 1], [1, 0]];
  return uvs.map(([u, v], i) => {
    const t = angle + (i * Math.PI) / 2, cx = Math.cos(t) * size, sy = -Math.sin(t) * size;   // screen y runs down
    return [c[0]! + right.x * cx + up.x * sy, c[1]! + right.y * cx + up.y * sy, c[2]! + right.z * cx + up.z * sy, u, v];
  });
}

/**
 * A flat particle (type 2, `FUN_00325cc0`, decomp 224342): a square in the world's XZ plane at the particle's height,
 * `2 size` across and square to the world's axes -- the ripples' rings; u runs along +z, v along +x.
 */
export function flatCorners(c: readonly number[], s: number): [number, number, number, number, number][] {
  const [x, y, z] = [c[0]!, c[1]!, c[2]!];
  return [[x - s, y, z - s, 0, 0], [x + s, y, z - s, 0, 1], [x + s, y, z + s, 1, 1], [x - s, y, z + s, 1, 0]];
}

export interface Group3 {
  mesh: Mesh;
  material: MeshBasicNodeMaterial;
  capacity: number;
  pos: BufferAttribute;
  uv: BufferAttribute;
  col: BufferAttribute;
}
