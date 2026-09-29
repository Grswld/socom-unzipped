import { describe, expect, it } from 'vitest';
import { remoteKit } from '../src/remotePlayers';

// The merge of web sprint 3 into the integration branch: the replicated weapon (0 the rifle, 1 the Mark 23) puts the
// other player's weapons where the local kit puts them once its swap has ended (`./kit`: FUN_005a60d0 / FUN_005a75d0).
describe('remoteKit', () => {
  it('the rifle in the hand, the pistol holstered', () => {
    expect(remoteKit(0)).toEqual({ item: 'rifle', mounts: { rifle: 'hand', pistol: 'holster' } });
  });
  it('the pistol in the hand, the rifle carried', () => {
    expect(remoteKit(1)).toEqual({ item: 'pistol', mounts: { rifle: 'carry', pistol: 'hand' } });
  });
});
