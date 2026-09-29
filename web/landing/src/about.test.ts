import { describe, it, expect } from 'vitest';
import { TABS, createAbout, moveTab, currentTab } from './about';

describe('about tabs', () => {
  it('has the briefing tabs in the game order', () => {
    expect(TABS.map((t) => t.label)).toEqual(['OVERVIEW', 'MISSION DETAILS', 'OBJECTIVES', 'MAPS/INTEL', 'ARMORY']);
  });

  it('starts on OVERVIEW and clamps at both ends', () => {
    const a = createAbout();
    expect(currentTab(a).label).toBe('OVERVIEW');
    expect(currentTab(moveTab(a, -1)).label).toBe('OVERVIEW');
    expect(currentTab(moveTab(a, 99)).label).toBe('ARMORY');
    expect(currentTab(moveTab(moveTab(a, 2), -1)).label).toBe('MISSION DETAILS');
  });

  it('every tab has a head and a body', () => {
    for (const t of TABS) {
      expect(t.head.length).toBeGreaterThan(0);
      expect(t.body.length).toBeGreaterThan(20);
    }
  });
});
