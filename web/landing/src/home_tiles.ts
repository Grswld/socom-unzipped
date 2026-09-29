/* The latest-entries tiles of the web page, built from timeline.json: pure DOM construction so the classes can be
   tested. The system's s2u-tile; the play mark is the page's own (.tile-play in home.css). */
import { tileImage, type TimelineEntry } from './home_data';

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function tileFor(doc: Document, e: TimelineEntry, onOpen: () => void, latest: boolean): HTMLLIElement {
  const li = el(doc, 'li', latest ? 's2u-tile is-latest' : 's2u-tile');
  if (e.picture) {
    const pic = tileImage(e.picture.path);
    const img = doc.createElement('img');
    img.src = pic.src; img.alt = e.picture.caption; img.loading = 'lazy';
    const frame = el(doc, 'div', 's2u-tile__frame');
    frame.appendChild(img);
    if (pic.video) frame.appendChild(el(doc, 'span', 'tile-play', 'PLAY'));
    li.appendChild(frame);
  } else {
    const frame = el(doc, 'div', 's2u-tile__frame is-blank');
    frame.setAttribute('aria-hidden', 'true');
    frame.appendChild(el(doc, 'span', '', 'NO FRAME ON FILE'));
    li.appendChild(frame);
  }
  const txt = el(doc, 'div', 's2u-tile__text');
  const time = doc.createElement('time');
  time.dateTime = e.date; time.textContent = e.date;
  const h3 = doc.createElement('h3');
  const a = doc.createElement('a');
  a.href = `/story.html#${e.id}`; a.textContent = e.title;
  a.addEventListener('click', onOpen);
  h3.appendChild(a);
  txt.append(time, h3, el(doc, 'p', '', e.hook), el(doc, 'span', 's2u-tile__read', 'Read the entry'));
  li.appendChild(txt);
  return li;
}

export function emptyTile(doc: Document): HTMLLIElement {
  return el(doc, 'li', 's2u-status', 'THE TIMELINE DID NOT LOAD. THE WHOLE STORY IS ONE CLICK BELOW.');
}
