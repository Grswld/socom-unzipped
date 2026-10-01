/* The briefing's typewriter (the artifact's TypedText): reveal `text` into `el` at `cps` characters a second,
   the game's pace at 30 fps being 40. Under prefers-reduced-motion the text lands whole. The caret is the
   element's `.s2u-typed__caret` sibling, styled in components.css; this only writes the text. The final height is
   measured and reserved on the nearest `.s2u-typed` block (a min-height on an inline span is a no-op), so the
   page does not grow line by line while the text arrives. */
export function typeInto(el: HTMLElement, text: string, cps = 40): Promise<void> {
  const reduce = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || cps <= 0) { el.textContent = text; return Promise.resolve(); }
  const box = (el.closest('.s2u-typed') as HTMLElement | null) ?? el;
  el.textContent = text;
  const h = box.offsetHeight;
  if (h > 0) box.style.minHeight = `${h}px`;
  el.textContent = '';
  const step = 1000 / cps;
  return new Promise((done) => {
    let i = 0;
    const tick = () => {
      i += 1;
      el.textContent = text.slice(0, i);
      if (i < text.length) setTimeout(tick, step); else done();
    };
    setTimeout(tick, step);
  });
}
