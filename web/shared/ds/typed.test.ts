import { describe, it, expect, vi, afterEach } from 'vitest';
import { typeInto } from './typed';

describe('typeInto', () => {
  afterEach(() => vi.useRealTimers());
  it('reveals the text at the given rate and ends whole', async () => {
    vi.useFakeTimers();
    const el = document.createElement('p');
    const done = typeInto(el, 'US Special Operations Command', 40);
    expect(el.textContent).toBe('');
    await vi.advanceTimersByTimeAsync(25);
    expect(el.textContent).toBe('U');
    await vi.advanceTimersByTimeAsync(25 * 40);
    expect(el.textContent).toBe('US Special Operations Command');
    await done;
    vi.useRealTimers();
  });
  it('reserves the final height on the .s2u-typed block, not the inline span it types into', () => {
    vi.useFakeTimers();
    const box = document.createElement('p');
    box.className = 's2u-typed';
    box.innerHTML = '<span id="t"></span><span class="s2u-typed__caret"></span>';
    const span = box.querySelector<HTMLElement>('#t')!;
    Object.defineProperty(box, 'offsetHeight', { value: 52 });
    typeInto(span, 'US Special Operations Command', 40);
    expect(box.style.minHeight).toBe('52px');
    expect(span.style.minHeight).toBe('');
    expect(span.textContent).toBe('');
  });
  it('shows everything at once under reduced motion', async () => {
    const mm = window.matchMedia;
    window.matchMedia = (() => ({ matches: true })) as unknown as typeof window.matchMedia;
    const el = document.createElement('p');
    await typeInto(el, 'DEVELOPED BY', 40);
    expect(el.textContent).toBe('DEVELOPED BY');
    window.matchMedia = mm;
  });
});
