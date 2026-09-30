import { describe, expect, it } from 'vitest';
import { parseZdb } from '@s2u/archive';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { actionInReach, readMapActions, type MapAction } from '../src/mapActions';

/** The map's own context actions (web/redotcom/docs/research/87-hud.md §5): `READERM.ZAR/actions.rdr` on placed nodes. */

describe('actionInReach', () => {
  const door = (node: string, at: [number, number, number]): MapAction => ({ node, type: 'DOOR', range: 30, bitmap: 'action_door_open.tif', at });
  it('picks the nearest action within its range, of the types asked for', () => {
    const actions = [door('a', [0, 0, 0]), door('b', [20, 0, 0]), { ...door('c', [5, 0, 0]), type: 'MPBOMB' }];
    expect(actionInReach(actions, [14, 0, 0])?.node).toBe('b');
    expect(actionInReach(actions, [4, 0, 0], ['DOOR'])?.node).toBe('a');
    expect(actionInReach(actions, [4, 0, 0])?.node).toBe('c');
    expect(actionInReach(actions, [100, 0, 0])).toBeNull();
    expect(actionInReach(actions, null)).toBeNull();
  });
});

const bytes = fixture('RUN/MP2.ZDB');
describe.skipIf(bytes === null)(`Frostfire's actions${bytes === null ? ` (${FIXTURES_ABSENT})` : ''}`, () => {
  it('are its three doors, 30 units of reach, the door icon, where the scene graph places the nodes', () => {
    const { actions, diagnostics } = readMapActions(bytes!, parseZdb(bytes!), 'MP2');
    expect(diagnostics).toEqual([]);
    expect(actions.map((a) => [a.node, a.type, a.range, a.bitmap])).toEqual([
      ['bdoor_4', 'DOOR', 30, 'action_door_open.tif'],
      ['wdoor_1', 'DOOR', 30, 'action_door_open.tif'],
      ['wdoor_2', 'DOOR', 30, 'action_door_open.tif'],
    ]);
    const at = Object.fromEntries(actions.map((a) => [a.node, a.at.map((v) => Math.round(v * 10) / 10)]));
    expect(at).toEqual({ bdoor_4: [588.8, 142, 1117], wdoor_1: [765, 142, 991], wdoor_2: [897.5, 100, 995] });
  });
});
