import { describe, expect, it } from 'vitest';
import { latestEntries, tileImage, uptimeText } from './home_data';

const tl = {
  entries: [
    { id: 'a', date: '2026-09-18', title: 'A', hook: 'ha' },
    { id: 'b', date: '2026-09-19', title: 'B', hook: 'hb', picture: { path: 'docs/story/img/b.png', caption: 'cb' } },
    { id: 'c', date: '2026-09-20', title: 'C', hook: 'hc' },
    { id: 'd', date: '2026-09-20', title: 'D', hook: 'hd', picture: { path: 'docs/story/img/d.png', caption: 'cd' } },
  ],
};

describe('latestEntries', () => {
  it('returns the newest first and prefers entries with a picture', () => {
    const got = latestEntries(tl, 2);
    expect(got.map((e) => e.id)).toEqual(['d', 'b']);
  });
  it('fills with picture-less entries when it must', () => {
    expect(latestEntries(tl, 4).map((e) => e.id)).toEqual(['d', 'c', 'b', 'a']);
  });
  it('drops malformed rows and never throws', () => {
    expect(latestEntries({ entries: [{ id: 'x' }, 7, null, { id: 'y', date: 'nope', title: 'Y' }] }, 3)).toEqual([]);
    expect(latestEntries(null, 3)).toEqual([]);
    expect(latestEntries('not json', 3)).toEqual([]);
  });
  it('cuts long strings', () => {
    const long = 'x'.repeat(1000);
    const got = latestEntries({ entries: [{ id: 'l', date: '2026-09-20', title: long, hook: long }] }, 1);
    expect(got[0].title.length).toBe(160);
    expect(got[0].hook.length).toBe(400);
  });
});

describe('uptimeText', () => {
  it('picks the two largest units', () => {
    expect(uptimeText(45)).toBe('45S');
    expect(uptimeText(12 * 60 + 5)).toBe('12M');
    expect(uptimeText(4 * 3600 + 12 * 60)).toBe('4H 12M');
    expect(uptimeText(3 * 86400 + 4 * 3600 + 59)).toBe('3D 4H');
    expect(uptimeText(-5)).toBe('0S');
  });
});

describe('tileImage', () => {
  it('shows a picture as itself', () => {
    expect(tileImage('docs/story/img/d.png')).toEqual({ src: '/story/img/d.png', video: false });
  });
  it('shows a video by its poster frame, and says so', () => {
    expect(tileImage('docs/story/img/2026-09-21-online-kill.mp4')).toEqual({ src: '/story/img/2026-09-21-online-kill.png', video: true });
  });
});
