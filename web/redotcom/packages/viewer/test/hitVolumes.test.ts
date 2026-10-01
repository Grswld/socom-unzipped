import { describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsAssetSource } from '@s2u/archive/node';
import { parseZdb, Zar, zdbMember } from '@s2u/archive';
import { readSkeleton } from '@s2u/scene';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { PART } from '../src/net/damage';
import {
  bodyVolumes, boneCentre, placeholderVolumes, rayBody, skeletonVolumes, stanceVolumes, type Capsule, type V3,
} from '../src/net/hitVolumes';
import { loadSimSkeleton, type SimSkeleton } from '../src/simMap';

/**
 * The server's hit volumes off the SEAL's own skeleton (web sprint 3, M6; research 91 section 1.3): each damage bone a
 * capsule from its joint to the next joint of its chain, posed at the stance's idle clip, in the body's frame (x right,
 * y up, z behind, the soles at the origin), then placed at the feet and the facing.
 */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures');
const MP2 = fixture('RUN/MP2.ZDB'), PACK = fixture('RUN/MOTION_P.ZAR'), READERC = fixture('RUN/READERC.ZAR');

const FEET: V3 = [100, 50, -20], YAW = 30;
/** A body-frame point (x right, y up, z behind) to the world at FEET and YAW, as `play.ts` `actorToWorld`. */
function world(p: V3): V3 {
  const r = (YAW * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [FEET[0] + p[0] * c + p[2] * s, FEET[1] + p[1], FEET[2] - p[0] * s + p[2] * c];
}
/** A ray from 30 in front of the body at body-frame (x, y), straight back through it. */
function fromFront(x: number, y: number): { o: V3; d: V3 } {
  const r = (YAW * Math.PI) / 180;
  return { o: world([x, y, -30]), d: [Math.sin(r), 0, Math.cos(r)] };
}
const centre = (c: Capsule): V3 => [(c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2, (c.a[2] + c.b[2]) / 2];
const lo = (c: Capsule): number => Math.min(c.a[1], c.b[1]) - c.r;
const hi = (c: Capsule): number => Math.max(c.a[1], c.b[1]) + c.r;
const of = (vs: readonly Capsule[], part: number): Capsule[] => vs.filter((c) => c.part === part);

describe('the placeholder stays the fallback', () => {
  it('bodyVolumes without skeleton volumes is placeholderVolumes', () => {
    for (const posture of ['stand', 'crouch', 'prone'] as const) {
      expect(bodyVolumes(FEET, YAW, posture)).toEqual(placeholderVolumes(FEET, YAW, posture));
    }
  });
});

describe.skipIf(!MP2 || !PACK || !READERC)(`Frostfire's SEAL hit volumes${MP2 && PACK && READERC ? '' : ` (${FIXTURES_ABSENT})`}`, () => {
  let sim: SimSkeleton;
  const get = async (): Promise<SimSkeleton> => {
    if (!sim) {
      const loaded = await loadSimSkeleton(new FsAssetSource(FIXTURES), 'RUN/MP2.ZDB');
      if (!loaded) throw new Error('no skeleton');
      sim = loaded;
    }
    return sim;
  };

  it('loads seal_A_scuba headless, with the three idles, and the Terrorist shares its bone names', async () => {
    const s = await get();
    expect(s.model).toBe('seal_A_scuba');
    expect(s.idles.stand?.name).toBe('seal_stand');
    expect(s.idles.crouch?.name).toBe('seal_crouch');
    expect(s.idles.prone?.name).toBe('seal_prone');
    for (const bone of ['head', 'neck', 'rbicep', 'rforearm', 'lbicep', 'lforearm', 'spinehi', 'spinelo', 'hips', 'rthigh', 'rcalf', 'lthigh', 'lcalf']) {
      expect(s.skeleton.indexOf(bone), bone).toBeGreaterThanOrEqual(0);
    }
    const toc = parseZdb(MP2!);
    const terrorist = readSkeleton(Zar.parse(zdbMember(MP2!, toc, 'CLIB_GEO.ZED')), 'al_gman01');
    expect(terrorist.parts.map((p) => p.name)).toEqual(s.skeleton.parts.map((p) => p.name));
  });

  it('standing: the head at 16-20, the body over about 9-16, the legs down to 1-3', async () => {
    const s = await get();
    const v = skeletonVolumes(s.skeleton, s.idles.stand);
    const head = of(v, PART.HEAD), body = of(v, PART.BODY);
    expect(head.length).toBeGreaterThan(0);
    const top = head.reduce((a, c) => (centre(c)[1] > centre(a)[1] ? c : a));
    expect(centre(top)[1]).toBeGreaterThan(16);
    expect(centre(top)[1]).toBeLessThan(20);
    expect(Math.min(...body.map(lo))).toBeGreaterThan(7.5);
    expect(Math.min(...body.map(lo))).toBeLessThan(10.5);
    expect(Math.max(...body.map(hi))).toBeGreaterThan(15);
    expect(Math.max(...body.map(hi))).toBeLessThan(18);
    for (const leg of [PART.RLEG, PART.LLEG]) {
      const bottom = Math.min(...of(v, leg).map(lo));
      expect(bottom).toBeGreaterThan(0.5);
      expect(bottom).toBeLessThan(3);
    }
    expect(of(v, PART.RARM).length).toBe(2);
    expect(of(v, PART.LARM).length).toBe(2);
    // Right is +x: the right thigh's capsule sits right of the left's.
    expect(centre(of(v, PART.RLEG)[0]!)[0]).toBeGreaterThan(centre(of(v, PART.LLEG)[0]!)[0]);
    expect(skeletonVolumes(s.skeleton, s.idles.stand)).toBe(v);    // cached
  });

  it('crouched lower, prone flat', async () => {
    const s = await get();
    const stand = skeletonVolumes(s.skeleton, s.idles.stand), crouch = skeletonVolumes(s.skeleton, s.idles.crouch);
    const prone = skeletonVolumes(s.skeleton, s.idles.prone);
    const headY = (v: readonly Capsule[]): number => Math.max(...of(v, PART.HEAD).map((c) => centre(c)[1]));
    expect(headY(crouch)).toBeLessThan(headY(stand) - 4);
    expect(Math.max(...crouch.map(hi))).toBeLessThan(Math.max(...stand.map(hi)));
    expect(Math.max(...prone.map(hi))).toBeLessThan(6);
  });

  it('a ray at the head hits HEAD, at the chest BODY, at the knee a leg; beside the arm at the hand, nothing', async () => {
    const s = await get();
    const vols = stanceVolumes(s);
    const placed = bodyVolumes(FEET, YAW, 'stand', vols);
    const shoot = (x: number, y: number): number | null => {
      const { o, d } = fromFront(x, y);
      return rayBody(o, d, 100, placed)?.part ?? null;
    };
    expect(shoot(0.5, 17.8)).toBe(PART.HEAD);
    expect(shoot(0, 14)).toBe(PART.BODY);
    expect([PART.RLEG, PART.LLEG]).toContain(shoot(-0.7, 6));
    // The right hand, clear of the forearm: straight down through its middle the round meets no damage part.
    const hand = boneCentre(s.skeleton, s.idles.stand, 'rhand');
    expect(hand[1]).toBeGreaterThan(10);
    expect(hand[1]).toBeLessThan(14);
    expect(rayBody(world([hand[0], hand[1] + 0.3, hand[2]]), [0, -1, 0], 100, placed)).toBeNull();
  });
});

