import { describe, expect, it } from 'vitest';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { simMapFromBytes } from '../src/simMap';
import { DoorPage, type DoorPageDeps } from '../src/doorPage';
import { groundGrid, TICK } from '../src/mover';
import type { ClientEvent, DoorWire } from '../src/net/protocol';

/**
 * The doors on the page (`./doorPage`): the action button on the door under the reticle -- used here offline, sent to
 * the server in a match (and not at all by a spectator) -- the swing heard and drawn, the server's doors followed.
 */

const MP2 = fixture('RUN/MP2.ZDB');

describe.skipIf(!MP2)(`the doors on the page${MP2 ? '' : ` (${FIXTURES_ABSENT})`}`, () => {
  const setUp = (net: ReturnType<DoorPageDeps['net']> = null) => {
    const map = simMapFromBytes(MP2!, 'RUN/MP2.ZDB');
    const grid = groundGrid(map.ground);
    const sounds: string[] = [], moves: string[] = [];
    const page = new DoorPage({
      grid: () => grid, feet: () => [582.5, 142, 1135], aim: () => ({ eye: [582.5, 157.4, 1135], far: [582.5, 157.4, 135] }),
      sound: (name) => sounds.push(name), move: (path) => moves.push(path), net: () => net,
    });
    page.setMap(map.doors, map.ground);
    return { page, sounds, moves };
  };

  it('offline, the action on bdoor_4 swings it open: heard, drawn, and the HUD\'s target is gone while it swings', () => {
    const { page, sounds, moves } = setUp();
    expect(page.target()).toBe(0);
    expect(page.action()).toBe(true);
    expect(page.target()).toBeNull();
    for (let k = 0; k < 2 / TICK; k++) page.frame(TICK);
    expect(page.stats().doors[0]).toMatchObject({ node: 'bdoor_4', open: true, busy: false });
    expect(sounds).toEqual(['.DOOR_WOOD_OPEN']);
    expect(new Set(moves)).toEqual(new Set(['worldmodel/bdoor_4']));
  });

  it('in a match the action is the server\'s: a door event, nothing swung here until the snapshots say so', () => {
    const sent: ClientEvent[] = [];
    let doors: DoorWire[] | undefined = [{ valve: 0, phase: 255 }, { valve: 0, phase: 255 }, { valve: 0, phase: 255 }];
    const { page, sounds } = setUp({ role: 'player', send: (ev) => sent.push(ev), lastSeq: () => 41, doors: () => doors });
    expect(page.action()).toBe(true);
    expect(sent).toEqual([{ type: 'door', seq: 41, door: 0 }]);
    page.frame(TICK);
    expect(page.stats().doors[0]!.busy).toBe(false);
    doors = [{ valve: 1, phase: 60 }, { valve: 0, phase: 255 }, { valve: 0, phase: 255 }];   // the server swings it
    page.frame(TICK);
    expect(page.stats().doors[0]!.busy).toBe(true);
    expect(sounds).toEqual(['.DOOR_WOOD_OPEN']);
    doors = [{ valve: 1, phase: 255 }, { valve: 0, phase: 255 }, { valve: 0, phase: 255 }];
    for (let k = 0; k < 2 / TICK; k++) page.frame(TICK);
    expect(page.stats().doors[0]).toMatchObject({ open: true, busy: false });
    expect(sounds).toEqual(['.DOOR_WOOD_OPEN']);                              // once
  });

  it('a spectator\'s press is not a door\'s; a late joiner sees an open door open, silently', () => {
    const sent: ClientEvent[] = [];
    const { page, sounds } = setUp({ role: 'spectator', send: (ev) => sent.push(ev), lastSeq: () => 1, doors: () => [{ valve: 1, phase: 255 }] });
    expect(page.action()).toBe(false);
    expect(sent).toEqual([]);
    page.frame(TICK);
    expect(page.stats().doors[0]).toMatchObject({ open: true, busy: false });
    expect(sounds).toEqual([]);
  });
});
