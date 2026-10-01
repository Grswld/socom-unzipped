import { describe, it, expect } from 'vitest';
import { tileFor, emptyTile } from './home_tiles';

const entry = { id: '2026-09-25-the-debts-paid-in-one-day', date: '2026-09-25', title: 'The debts, paid in one day', hook: 'The saved password was never lost.' };

describe('tileFor', () => {
  it('builds a system tile with a blank frame for a text entry', () => {
    const li = tileFor(document, entry, () => {}, true);
    expect(li.className).toBe('s2u-tile is-latest');
    expect(li.querySelector('.s2u-tile__frame.is-blank span')?.textContent).toBe('NO FRAME ON FILE');
    expect(li.querySelector('.s2u-tile__text time')?.getAttribute('datetime')).toBe('2026-09-25');
    expect(li.querySelector('h3 a')?.getAttribute('href')).toBe('/story.html#2026-09-25-the-debts-paid-in-one-day');
    expect(li.querySelector('.s2u-tile__read')?.textContent).toBe('Read the entry');
  });
  it('builds a picture frame with the play mark for a video', () => {
    const li = tileFor(document, { ...entry, picture: { path: 'story/img/x.mp4', caption: 'a run' } }, () => {}, false);
    expect(li.className).toBe('s2u-tile');
    expect(li.querySelector('.s2u-tile__frame img')?.getAttribute('alt')).toBe('a run');
    expect(li.querySelector('.tile-play')?.textContent).toBe('PLAY');
  });
  it('emptyTile is a status line', () => {
    expect(emptyTile(document).className).toBe('s2u-status');
  });
});
