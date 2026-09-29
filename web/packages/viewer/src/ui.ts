import type { MapInfo } from '@s2u/archive';
import { labelFor } from './mapOrder';
import { viewerRevision, viewerRevisionBadge } from './revision';
import { chooseTab, CONTROLS_TAB_KEY, controlGroups, padControlGroups, type ControlGroup, type ControlsTab, type FaceGlyph } from './controlsList';
import type { LookOptions } from './look';
import type { OnlineChoice } from './online';

/** The overlays a viewer can switch on, in the order the panel lists them. */
export const TOGGLES = ['grid', 'collision', 'spawns', 'wireframe', 'untextured',
  'fog', 'blendgraded', 'engineorder', 'shadows', 'alternate', 'detail', 'linestrips', 'billboards', 'rigeverywhere', 'ps2look',
  'body'] as const;
export type ToggleName = (typeof TOGGLES)[number];

/** The continuous controls, in the order the panel lists them. */
export const SLIDERS = ['brighten', 'fognear', 'fogfar'] as const;
export type SliderName = (typeof SLIDERS)[number];

/** The page's controls, found once and typed, so the rest of the viewer never touches `getElementById`. */
export class Ui {
  private readonly maps = find<HTMLSelectElement>('maps');
  private readonly status = find<HTMLParagraphElement>('status');
  private readonly diagnostics = find<HTMLUListElement>('diagnostics');
  private readonly diagnosticsCount = find<HTMLElement>('diagnostics-count');
  private readonly hint = find<HTMLParagraphElement>('hint');
  private readonly fpsNumber = find<HTMLElement>('fps-n');
  private readonly fpsRest = find<HTMLElement>('fps-rest');
  private readonly loading = find<HTMLElement>('loading');
  private readonly loadingWhat = find<HTMLElement>('loading-what');
  private readonly loadingBar = find<HTMLElement>('loading-bar');
  private readonly panel = find<HTMLElement>('panel');
  private readonly panelToggle = find<HTMLButtonElement>('panel-toggle');
  /**
   * Whether the play (walk mode) is on the page: the Fly / Walk switch's hidden box is there only then (`./features`).
   * The settings switch changes it at run time (`setPlay`).
   */
  private play = document.getElementById('walk') !== null;
  /** The loaded map's name, for the cog's tooltip; null before the first load. */
  private mapName: string | null = null;
  /**
   * The continuous controls, as [input, readout, how to word the number]. Kept as one table for the same
   * reason the checkboxes are: so the wiring cannot drift from what the page shows.
   */
  private readonly sliders: Record<SliderName, { input: HTMLInputElement; out: HTMLOutputElement; fmt: (v: number) => string }> = {
    brighten: { input: find('brighten'), out: find('brighten-out'), fmt: (v) => `${(1 + v / 128).toFixed(2)}× (FIX ${Math.round(v)})` },
    fognear: { input: find('fognear'), out: find('fognear-out'), fmt: (v) => String(Math.round(v)) },
    fogfar: { input: find('fogfar'), out: find('fogfar-out'), fmt: (v) => String(Math.round(v)) },
  };
  /**
   * The overlay checkboxes, by the name the debug hook reports them under. Held as one record rather
   * than six fields so `toggles()` cannot drift out of step with what the page actually shows.
   */
  private readonly checks: Record<ToggleName, HTMLInputElement> = {
    grid: find('grid'),
    collision: find('collision'),
    spawns: find('spawns'),
    wireframe: find('wireframe'),
    untextured: find('untextured'),
    fog: find('fog'),
    blendgraded: find('blendgraded'),
    engineorder: find('engineorder'),
    shadows: find('shadows'),
    alternate: find('alternate'),
    detail: find('detail'),
    linestrips: find('linestrips'),
    billboards: find('billboards'),
    rigeverywhere: find('rigeverywhere'),
    ps2look: find('ps2look'),
    // W2.1's SEAL; W2.2b: shown in fly mode (in play it always is, `./play`). With the play off the row is gone, and a
    // box that is not on the page stands in, so the toggles' one table still reads false.
    body: document.getElementById('player-body') as HTMLInputElement | null ?? document.createElement('input'),
  };

  /**
   * The panel opens at the page's own defaults, every time. A browser restores form controls on a
   * reload or a back-navigation to whatever they were, so a box unticked in an earlier build came back
   * unticked after the build that ticked it -- the line strips looked off by default when they were
   * not. What the markup says is what a fresh visit gets; the remembered things are elsewhere.
   */
  constructor() {
    for (const box of Object.values(this.checks)) box.checked = box.defaultChecked;
    for (const { input } of Object.values(this.sliders)) input.value = input.defaultValue;
    this.setCameraHint(...this.hintArgs);         // the line for the mode the page starts in, whatever the markup says
  }

  /** The map list, named from each archive's own `mission.rdr`. The value is the archive-relative path. */
  setMaps(maps: MapInfo[], selected: string | null): void {
    this.maps.replaceChildren(...maps.map((m) => {
      const option = document.createElement('option');
      option.value = m.path;
      option.textContent = labelFor(m);
      option.selected = m.path === selected;
      return option;
    }));
  }

  select(path: string): void {
    this.maps.value = path;
  }

  onMapChange(handler: (path: string) => void): void {
    this.maps.addEventListener('change', () => handler(this.maps.value));
  }

  /**
   * "Open your own disc (.iso)" (W1.7, milestone M5): the panel's file input, and a file dropped anywhere
   * on the page. Both are the standard file APIs -- an `<input type=file>` and the drop's `DataTransfer`
   * -- and not the File System Access API, which Safari does not offer. Either way the page gets a `File`,
   * a handle the worker reads by range; nothing is uploaded. `accept=".iso"` only steers the picker: a
   * dropped file of any name is handed on, and the ISO9660 reader says what it is not.
   */
  onDisc(handler: (file: File) => void): void {
    // The panel's input, and the disc page's (`#disc-page`, owner 2026-09-29).
    for (const id of ['disc-file', 'disc-page-file']) {
      const input = document.getElementById(id) as HTMLInputElement | null;
      input?.addEventListener('change', () => {
        const file = input.files?.[0];
        // Cleared so choosing the same image again still fires `change`.
        input.value = '';
        if (file) handler(file);
      });
    }
    const carriesFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const over = (on: boolean): void => { document.body.classList.toggle('disc-over', on); };
    document.addEventListener('dragover', (e) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();                       // what makes the page a drop target at all
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      over(true);
    });
    // `relatedTarget` is null only when the drag leaves the window, not when it crosses between elements.
    document.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) over(false); });
    document.addEventListener('drop', (e) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();                       // or the browser navigates to the dropped file
      over(false);
      const file = e.dataTransfer?.files[0];
      if (file) handler(file);
    });
  }

  /**
   * No maps to read but the visitor's own disc (the default since 2026-09-29, `./source`): the disc page stands over the
   * canvas (`#disc-page`) until a disc's map list is in. The panel stays as it was.
   */
  offerDisc(): void {
    document.body.classList.add('no-served');
    const page = document.getElementById('disc-page');
    if (page) page.hidden = false;
  }

  /** The disc page is taken down: a disc is open. */
  hideDiscPage(): void {
    document.body.classList.remove('no-served');
    const page = document.getElementById('disc-page');
    if (page) page.hidden = true;
  }

  /** Whether the disc page is up, for the hook and the status wiring. */
  discPageShown(): boolean {
    const page = document.getElementById('disc-page');
    return !!page && !page.hidden;
  }

  /** The disc page's one status line: reading, or what went wrong (the reader's own words). */
  setDiscState(text: string, kind: 'ok' | 'error' = 'ok'): void {
    const line = document.getElementById('disc-state');
    if (!line) return;
    line.textContent = text;
    line.classList.toggle('is-bad', kind === 'error');
  }

  /**
   * The Mode switch (owner, 2026-09-29): Map viewer or reCOM, the picture switch's markup (`#recom`). `handler` hears the
   * visitor's choice; `setRecom` puts the switch where the page is, whoever changed it.
   */
  onRecomSwitch(handler: (on: boolean) => void): void {
    for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('#recom button[data-recom]'))) {
      b.addEventListener('click', () => {
        const on = b.dataset['recom'] === 'on';
        if (b.getAttribute('aria-pressed') === 'true') return;
        this.setRecom(on);
        handler(on);
      });
    }
  }

  setRecom(on: boolean): void {
    for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('#recom button[data-recom]'))) {
      b.setAttribute('aria-pressed', (b.dataset['recom'] === 'on') === on ? 'true' : 'false');
    }
  }

  /**
   * The play's lists follow the mode: the Controls popover's two lists name the walk and Start only while the play is
   * on the page.
   */
  setPlay(on: boolean): void {
    if (this.play === on) return;
    this.play = on;
    this.setCameraHint(...this.hintArgs);
  }

  /** The Online setting (owner, 2026-09-29; `./online`): Off, Shared or Local, the picture switch's markup (`#online`). */
  onOnline(handler: (choice: OnlineChoice) => void): void {
    for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('#online button[data-online]'))) {
      b.addEventListener('click', () => {
        const choice = b.dataset['online'];
        if (choice !== 'off' && choice !== 'shared' && choice !== 'local') return;
        if (b.getAttribute('aria-pressed') === 'true') return;
        this.setOnline(choice);
        handler(choice);
      });
    }
  }

  /** Puts the Online switch on a choice; 'url' (a server the URL named) presses none. */
  setOnline(choice: OnlineChoice | 'url'): void {
    for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('#online button[data-online]'))) {
      b.setAttribute('aria-pressed', b.dataset['online'] === choice ? 'true' : 'false');
    }
  }

  /** The connection's line under the Online setting, and its lamp: up (online), down (unreachable, refused) or dark. */
  setOnlineState(text: string, lamp: 'up' | 'down' | null): void {
    const line = document.getElementById('online-text');
    const dot = document.getElementById('online-lamp');
    if (line && line.textContent !== text) line.textContent = text;
    dot?.classList.toggle('is-up', lamp === 'up');
    dot?.classList.toggle('is-down', lamp === 'down');
  }

  /** The fog colour picker. `FOGCOL` is a register value, so it is handed over as 0..255 per channel. */
  onFogColour(handler: (rgb: [number, number, number]) => void): void {
    const input = find<HTMLInputElement>('fogcolour');
    const fire = (): void => {
      const hex = parseInt(input.value.slice(1), 16);
      handler([(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff]);
    };
    input.addEventListener('input', fire);
    fire();
  }

  /**
   * Backtick hides the panel and the counter, for a clean look at the map. Bound on the window rather
   * than the canvas so it works whether or not the mouse is captured, and ignored while a control has
   * the keyboard so it cannot fire from inside a text field.
   */
  onChromeToggle(): void {
    globalThis.addEventListener('keydown', (e) => {
      if (e.code !== 'Backquote' || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target;
      if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
      e.preventDefault();
      document.body.classList.toggle('chrome-hidden');
    });
  }

  /**
   * Fullscreen, from the button beside the frame counter and from `F`. On a phone the browser's bars
   * are a third of the screen, and fullscreen is also the one place a landscape lock is allowed, so
   * one is asked for and the refusal (a desktop, an iPhone) is ignored.
   */
  onFullscreen(): void {
    const button = find<HTMLButtonElement>('fullscreen');
    const toggle = (): void => {
      const doc = document as Document & { webkitExitFullscreen?: () => void };
      const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
      if (document.fullscreenElement) {
        void document.exitFullscreen?.();
        return;
      }
      const request = root.requestFullscreen ?? root.webkitRequestFullscreen ?? doc.webkitExitFullscreen;
      try {
        const r = request?.call(root) as unknown;
        if (r instanceof Promise) r.catch(() => undefined);
      } catch { /* not offered here */ }
      const orientation = (screen as Screen & { orientation?: { lock?: (o: string) => Promise<void> } }).orientation;
      try { orientation?.lock?.('landscape').catch(() => undefined); } catch { /* a desktop, or an iPhone */ }
    };
    button.addEventListener('click', toggle);
    globalThis.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyF' || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target;
      if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
      e.preventDefault();
      toggle();
    });
    document.addEventListener('fullscreenchange', () => {
      button.title = document.fullscreenElement ? 'leave fullscreen (F)' : 'fullscreen (F)';
    });
  }

  /**
   * The panel folded away behind the cog in the site bar, and back (W2.0). Two ways in, because they
   * answer different wants: the backtick takes *everything* away for a clean picture, and the cog
   * takes the panel only and stays where a thumb can tap it to bring the panel back.
   *
   * The panel starts folded on every device: a first visit shows the map, and the cog (beside the GitHub link)
   * opens the settings. A choice the visitor made with the cog is remembered, in `localStorage` and so
   * best-effort: a private window, blocked site data or a browser that throws on access all end up with the
   * panel folded, which is the default anyway. Nothing here fails if storage does.
   */
  onPanelToggle(): void {
    this.setPanelCollapsed(read(PANEL_KEY) !== '1');
    this.panelToggle.addEventListener('click', () => {
      const collapsed = !document.body.classList.contains('panel-collapsed');
      this.setPanelCollapsed(collapsed);
      write(PANEL_KEY, collapsed ? '0' : '1');
    });
  }

  /**
   * The Controls popover (owner, 2026-09-28; two tabs, 2026-09-29): `#controls`, anchored under the bar's Controls tab,
   * holding the Controller and the Mouse & Keyboard lists -- the current mode's alone (`renderControls`), one shown at a
   * time (`showTab`; the choice remembered under `CONTROLS_TAB_KEY`). It is open while the
   * pointer is over the tab or the popover (a mouse or pen; a touch has no hover), while a keyboard focus is on
   * either, and while a click or tap has pinned it; Esc closes it whatever held it, and so does a press outside. It
   * never takes the focus and never asks for the pointer lock, and a key pressed with the tab focused still reaches
   * the game (the camera's own listeners are on the window).
   */
  onControlsPopover(): void {
    const button = find<HTMLButtonElement>('controls-toggle');
    const pop = find<HTMLElement>('controls');
    let hover = false, focus = false, pinned = false;
    let leaving: ReturnType<typeof setTimeout> | null = null;
    const sync = (): void => {
      const open = hover || focus || pinned;
      const was = !pop.hidden;
      pop.hidden = !open;
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      button.classList.toggle('is-on', open);
      if (open && !was) this.placePopover(button, pop);
    };
    const mouse = (e: Event): boolean => (e as Partial<PointerEvent>).pointerType !== 'touch';
    const enter = (e: Event): void => {
      if (!mouse(e)) return;
      if (leaving !== null) { clearTimeout(leaving); leaving = null; }
      hover = true;
      sync();
    };
    // A short grace, so the pointer can cross the gap between the tab and the popover.
    const leave = (e: Event): void => {
      if (!mouse(e)) return;
      if (leaving !== null) clearTimeout(leaving);
      leaving = setTimeout(() => { leaving = null; hover = false; sync(); }, POPOVER_GRACE_MS);
    };
    const focusIn = (): void => {
      // Only a keyboard's focus (a click's is the pin's business): where `:focus-visible` cannot be asked, count it.
      let visible = true;
      try { visible = button.matches(':focus-visible') || pop.matches(':focus-within'); } catch { /* not offered */ }
      focus = visible;
      sync();
    };
    const focusOut = (e: FocusEvent): void => {
      const next = e.relatedTarget;
      if (next instanceof Node && (button.contains(next) || pop.contains(next))) return;
      focus = false;
      sync();
    };
    for (const el of [button, pop]) {
      el.addEventListener('pointerenter', enter);
      el.addEventListener('pointerleave', leave);
      el.addEventListener('focusin', focusIn);
      el.addEventListener('focusout', focusOut as EventListener);
    }
    button.addEventListener('click', () => { pinned = !pinned; sync(); });
    for (const t of Array.from(pop.querySelectorAll<HTMLButtonElement>('#controls-tabs [data-tab]'))) {
      t.addEventListener('click', () => {
        const tab: ControlsTab = t.dataset['tab'] === 'pad' ? 'pad' : 'keys';
        this.tabChosen = true;
        write(CONTROLS_TAB_KEY, tab);
        this.showTab(tab);
      });
    }
    const stored = read(CONTROLS_TAB_KEY);
    this.tabChosen = stored === 'pad' || stored === 'keys';
    this.showTab(chooseTab(stored, this.padConnected));
    globalThis.addEventListener('keydown', (e) => {
      if (e.code !== 'Escape' || pop.hidden) return;
      hover = focus = pinned = false;
      if (leaving !== null) { clearTimeout(leaving); leaving = null; }
      sync();
    });
    document.addEventListener('pointerdown', (e) => {
      const target = e.target;
      if (pop.hidden || (target instanceof Node && (button.contains(target) || pop.contains(target)))) return;
      hover = pinned = false;
      sync();
    });
    sync();
  }

  /** Under the tab, its left edge kept on the screen; on a narrow screen the stylesheet owns the place. */
  private placePopover(button: HTMLElement, pop: HTMLElement): void {
    pop.style.left = '';
    if (this.isNarrow()) return;
    const left = button.getBoundingClientRect().left;
    const room = globalThis.innerWidth - pop.offsetWidth - 12;
    pop.style.left = `${Math.max(12, Math.min(left, room))}px`;
  }

  private setPanelCollapsed(collapsed: boolean): void {
    document.body.classList.toggle('panel-collapsed', collapsed);
    this.panel.classList.toggle('is-folded', collapsed);
    this.panelToggle.classList.toggle('is-on', !collapsed);
    this.panelToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    this.titleCog(collapsed);
  }

  private titleCog(collapsed: boolean): void {
    this.panelToggle.title = collapsed
      ? (this.mapName ? `show the settings · ${this.mapName}` : 'show the settings')
      : 'hide the settings';
  }

  /**
   * The loaded map's name, which the folded panel used to show in its title bar. The panel folds to
   * nothing now (W2.0), so the name rides on the cog's tooltip while it is folded; open, the status
   * line says it.
   */
  setPanelTitle(map: string | null): void {
    this.mapName = map;
    this.titleCog(this.panelCollapsed());
  }

  /**
   * A narrow screen, where the status line has to earn every character or it wraps to four lines and
   * pushes everything else out of the top strip.
   */
  isNarrow(): boolean {
    try {
      return globalThis.matchMedia?.('(max-width: 480px)').matches ?? false;
    } catch {
      return false;
    }
  }

  /**
   * The build's revision: `rev <hash>` alone on the About summary's chip, so it is readable without
   * unfolding anything, and the full "rev … · built …" line as the last line of the About text.
   * Returns the full label for the debug hook.
   */
  showRevision(label = viewerRevision(), badge = viewerRevisionBadge()): string {
    find<HTMLElement>('revision').textContent = badge;
    find<HTMLElement>('revision-line').textContent = label;
    return label;
  }

  /** Whether the panel is folded, for the debug hook. */
  panelCollapsed(): boolean {
    return document.body.classList.contains('panel-collapsed');
  }

  /** Whether the chrome is hidden, for the debug hook. */
  chromeHidden(): boolean {
    return document.body.classList.contains('chrome-hidden');
  }

  /**
   * The picture switch: Modern or PS2. It drives the hidden `ps2look` checkbox -- the state the
   * toggles, the hook and the tests read -- and remembers the choice, so a return visit opens on it.
   */
  onLook(fromAddress: 'modern' | 'ps2' | null = null, changed: (view: 'modern' | 'ps2') => void = () => undefined): void {
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('#look button[data-look]'));
    const box = this.checks.ps2look;
    const show = (): void => {
      for (const b of buttons) b.setAttribute('aria-pressed', (b.dataset['look'] === 'ps2') === box.checked ? 'true' : 'false');
    };
    for (const b of buttons) {
      b.addEventListener('click', () => {
        const ps2 = b.dataset['look'] === 'ps2';
        if (box.checked === ps2) return;
        box.checked = ps2;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        write(LOOK_KEY, ps2 ? 'ps2' : 'modern');
        show();
        changed(ps2 ? 'ps2' : 'modern');
      });
    }
    box.addEventListener('change', show);
    // The address's `view` (a shared link, `./shareUrl`) beats the remembered picture, for this visit.
    const stored = fromAddress ?? read(LOOK_KEY);
    if (stored === 'ps2' || stored === 'modern') box.checked = stored === 'ps2';
    show();
  }

  /** The fog checkbox follows the map's own enable bit. */
  setFogEnabled(on: boolean): void {
    this.checks.fog.checked = on;
  }

  /**
   * Puts a map's own fog on the panel. The range inputs snap to their `step` and clamp to their bounds,
   * so the value read back out is not the value written in -- MP51's 600/875 would come back 870/880.
   * The caller keeps the decoded number; this only moves the control to the nearest place it can sit,
   * and widens the bounds so a map outside them is not silently clamped.
   */
  setFog(near: number, far: number, rgb: [number, number, number]): void {
    const widen = (input: HTMLInputElement, v: number): void => {
      if (v < Number(input.min)) input.min = String(Math.floor(v));
      if (v > Number(input.max)) input.max = String(Math.ceil(v));
      input.value = String(v);
    };
    widen(this.sliders.fognear.input, near);
    widen(this.sliders.fogfar.input, far);
    find<HTMLInputElement>('fogcolour').value =
      `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    // The readout says what the fog *is*, not where the control could sit: the input has snapped the
    // value to its step, and it is the decoded number that is being drawn.
    this.sliders.fognear.out.textContent = this.sliders.fognear.fmt(near);
    this.sliders.fogfar.out.textContent = this.sliders.fogfar.fmt(far);
  }

  /**
   * The loading overlay, and the one control it takes away while it is up.
   *
   * The picker is disabled for the duration because two loads started over each other is how two maps
   * end up half drawn together; nothing else is touched, so the camera keeps flying over the map that
   * is still on screen while the next one comes in.
   *
   * `fraction` is 0..1, or a negative number for a step with nothing to count -- the bar then sits where
   * it was rather than snapping back to empty.
   */
  setLoading(on: boolean, what = '', fraction = -1): void {
    this.loading.hidden = !on;
    this.maps.disabled = on;
    if (!on) { this.loadingBar.style.setProperty('--s2u-progress', '0'); return; }
    if (what) this.loadingWhat.textContent = fraction >= 0 ? `${what} ${Math.round(fraction * 100)}%` : what;
    if (fraction >= 0) this.loadingBar.style.setProperty('--s2u-progress', String(Math.max(0, Math.min(1, fraction))));
  }

  /** Calls `handler` with the slider that moved, and keeps its readout in step. */
  onSlider(handler: (name: SliderName, value: number) => void): void {
    for (const name of SLIDERS) {
      const { input, out, fmt } = this.sliders[name];
      const fire = (): void => {
        const value = Number(input.value);
        out.textContent = fmt(value);
        handler(name, value);
      };
      input.addEventListener('input', fire);
      out.textContent = fmt(Number(input.value));
    }
  }

  /** Announces every slider at once, the way `apply` does for the toggles. */
  applySliders(handler: (name: SliderName, value: number) => void): void {
    for (const name of SLIDERS) handler(name, Number(this.sliders[name].input.value));
  }

  /** What the sliders are set to, for the debug hook. */
  sliderValues(): Record<SliderName, number> {
    return Object.fromEntries(SLIDERS.map((n) => [n, Number(this.sliders[n].input.value)])) as Record<SliderName, number>;
  }

  /** Calls `handler` with the toggle that changed, whichever of the six it was. */
  onToggle(handler: (name: ToggleName, on: boolean) => void): void {
    for (const name of TOGGLES) {
      const box = this.checks[name];
      box.addEventListener('change', () => handler(name, box.checked));
    }
  }

  /**
   * Announces every toggle at once: what a freshly built world has to be told before it is drawn, and
   * what the page needs at boot, since a browser may restore the checkboxes from the last visit.
   */
  apply(handler: (name: ToggleName, on: boolean) => void): void {
    for (const name of TOGGLES) handler(name, this.checks[name].checked);
  }

  /** What the page is showing, for the debug hook and the screenshot test. */
  toggles(): Record<ToggleName, boolean> {
    return Object.fromEntries(TOGGLES.map((name) => [name, this.checks[name].checked])) as Record<ToggleName, boolean>;
  }

  /**
   * The sound controls (round 2): a mute switch and a volume slider (`#mute`, `#volume`), in the panel's Sound section.
   * They start from what this browser last had -- `localStorage`, best-effort, a per-viewer convenience -- or from the
   * page's own defaults (1, not muted), and the handlers hear the starting values at once, so the mix is what the
   * controls show from the first frame. With the play off the section is not on the page and nothing is wired.
   */
  onSound(handler: { volume: (volume: number) => void; muted: (muted: boolean) => void }): void {
    const mute = document.getElementById('mute') as HTMLInputElement | null;
    const slider = document.getElementById('volume') as HTMLInputElement | null;
    const out = document.getElementById('volume-out');
    if (!mute || !slider || !out) return;
    const storedVolume = Number(read(VOLUME_KEY));
    if (read(VOLUME_KEY) !== null && Number.isFinite(storedVolume)) slider.value = String(Math.min(1, Math.max(0, storedVolume)));
    mute.checked = read(MUTED_KEY) === '1';
    const show = (): void => { out.textContent = `${Math.round(Number(slider.value) * 100)}%`; };
    slider.addEventListener('input', () => {
      show();
      write(VOLUME_KEY, slider.value);
      handler.volume(Number(slider.value));
    });
    mute.addEventListener('change', () => {
      write(MUTED_KEY, mute.checked ? '1' : '0');
      handler.muted(mute.checked);
    });
    show();
    handler.volume(Number(slider.value));
    handler.muted(mute.checked);
  }

  /**
   * The mouse's look (round 2; `./look`): the law (raw or the game's stick curve), the sensitivity, invert pitch and the
   * game's or a uniform pitch, in the panel's Mouse look section (walk mode's, so behind `?redotcom`). Remembered like the
   * sound. `handler` gets the whole option set (the four the panel owns; `throttle` is the game's own and stays off) at
   * the start and on every change.
   */
  onLookControls(handler: (opts: Pick<LookOptions, 'mouse' | 'sensitivity' | 'pitchRatio' | 'invertPitch'>) => void): void {
    const group = document.getElementById('mouselaw');
    const slider = document.getElementById('sensitivity') as HTMLInputElement | null;
    const out = document.getElementById('sensitivity-out');
    const invert = document.getElementById('invertpitch') as HTMLInputElement | null;
    const uniform = document.getElementById('uniformpitch') as HTMLInputElement | null;
    if (!group || !slider || !out || !invert || !uniform) return;
    const buttons = Array.from(group.querySelectorAll<HTMLButtonElement>('button[data-law]'));
    let mouse: LookOptions['mouse'] = 'raw';
    try {
      const stored = JSON.parse(read(MOUSE_LOOK_KEY) ?? 'null') as Partial<LookOptions> | null;
      if (stored && (stored.mouse === 'raw' || stored.mouse === 'stick')) mouse = stored.mouse;
      if (stored && typeof stored.sensitivity === 'number' && Number.isFinite(stored.sensitivity)) {
        slider.value = String(Math.min(Number(slider.max), Math.max(Number(slider.min), stored.sensitivity)));
      }
      invert.checked = stored?.invertPitch === true;
      uniform.checked = stored?.pitchRatio === 'uniform';
    } catch { /* a value that is not ours: the defaults */ }
    const options = (): Pick<LookOptions, 'mouse' | 'sensitivity' | 'pitchRatio' | 'invertPitch'> => ({
      mouse, sensitivity: Number(slider.value), pitchRatio: uniform.checked ? 'uniform' : 'game', invertPitch: invert.checked,
    });
    const show = (): void => {
      for (const b of buttons) b.setAttribute('aria-pressed', b.dataset['law'] === mouse ? 'true' : 'false');
      out.textContent = `${Number(slider.value).toFixed(2)}×`;
    };
    const changed = (): void => { show(); write(MOUSE_LOOK_KEY, JSON.stringify(options())); handler(options()); };
    for (const b of buttons) {
      b.addEventListener('click', () => {
        const law = b.dataset['law'] === 'stick' ? 'stick' : 'raw';
        if (law === mouse) return;
        mouse = law;
        changed();
      });
    }
    slider.addEventListener('input', changed);
    invert.addEventListener('change', changed);
    uniform.addEventListener('change', changed);
    show();
    handler(options());
  }

  /**
   * The camera switch (W1.4): Fly or Walk -- walk on the game's floors behind the SEAL, in the game's camera (W2.1),
   * or fly. Two buttons in the picture switch's own markup (`#look`, `onLook`), driving the hidden `walk` checkbox
   * that stays the state the hook and the tests read. It is not one of the overlay toggles -- it moves the camera,
   * so `apply` must not replay it on every map load -- and it mirrors `G` and the pad's Start through `setWalk`.
   * The switch starts as the markup has it, like the toggles.
   */
  onWalkSwitch(handler: (on: boolean) => void): void {
    const box = document.getElementById('walk') as HTMLInputElement | null;
    if (!box) return;                             // the play is off: there is no switch to wire
    box.checked = box.defaultChecked;
    box.addEventListener('change', () => { this.showMode(box.checked); handler(box.checked); });
    for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('#mode button[data-mode]'))) {
      b.addEventListener('click', () => {
        const walk = b.dataset['mode'] === 'walk';
        if (box.checked === walk) return;
        box.checked = walk;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    this.showMode(box.checked);
  }

  /**
   * Puts the switch where the mode is, whoever changed it, and the controls the page lists with it: the hint line
   * and the pad's table name only the mode you are in.
   */
  setWalk(on: boolean): void {
    const box = document.getElementById('walk') as HTMLInputElement | null;
    if (box) box.checked = on;
    this.showMode(on);
  }

  private showMode(walking: boolean): void {
    for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('#mode button[data-mode]'))) {
      b.setAttribute('aria-pressed', (b.dataset['mode'] === 'walk') === walking ? 'true' : 'false');
    }
    document.body.classList.toggle('is-walking', walking);      // the touch layout and the fullscreen button's place follow it
    if (this.walking === walking) return;
    this.walking = walking;
    this.setCameraHint(...this.hintArgs);
  }

  /**
   * The Mouse & Keyboard tab's first line: how the mouse stands (click to look, or Esc to release it), and the fly speed
   * while flying. The controls themselves are the two grouped lists (`renderControls`), the current mode's alone.
   * Rebuilt on every mode change (`setWalk`).
   */
  setCameraHint(multiplier: number, locked: boolean): void {
    this.hintArgs = [multiplier, locked];     // kept, so a pad's connecting or a mode change can rebuild the line
    const speed = `wheel speed ${multiplier.toFixed(multiplier < 1 ? 2 : 1)}×`;
    this.hint.textContent = `${locked ? 'esc to release' : 'click to look'}${this.walking ? '' : ` · ${speed}`}`;
    this.renderControls();
  }

  /** The two lists (`./controlsList`): grouped, for the mode you are in and no other. */
  private renderControls(): void {
    const mode = this.walking ? 'walk' : 'fly';
    fillList('#keys-list tbody', controlGroups(mode, this.play));
    fillList('#pad-list tbody', padControlGroups(mode, this.play));
  }

  /** One of the popover's two tabs shown, the other hidden; the tab lit and selected. */
  private showTab(tab: ControlsTab): void {
    for (const t of Array.from(document.querySelectorAll<HTMLButtonElement>('#controls-tabs [data-tab]'))) {
      const on = t.dataset['tab'] === tab;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.classList.toggle('is-on', on);
      t.tabIndex = on ? 0 : -1;
    }
    const pad = document.getElementById('controls-pad');
    const keys = document.getElementById('controls-keys');
    if (pad) pad.hidden = tab !== 'pad';
    if (keys) keys.hidden = tab !== 'keys';
  }

  /**
   * The frame rate, top right. Shown as a whole number plus the frame time, because 60 and 59 look the
   * same in a counter but 16.7 ms and 34 ms do not.
   */
  setFps(fps: number, frameMs: number): void {
    // Two spans: at 360px the pill keeps the number and styles.css hides the rest, so it clears the
    // site bar's GitHub tab.
    this.fpsNumber.textContent = String(Math.round(fps));
    this.fpsRest.textContent = ` fps · ${frameMs.toFixed(1)} ms`;
  }

  /**
   * The status line lives in the settings panel, which starts folded, so an error unfolds it (not remembered): a failed
   * load must not be a map that quietly never came. The progress of a load is not here but in the loading overlay
   * (`setLoading`), which stands over the map whatever the panel is doing.
   */
  setStatus(text: string, kind: 'ok' | 'error' = 'ok'): void {
    this.status.textContent = text;
    this.status.title = text;                     // the line is clamped to two; the whole of it is here
    this.status.classList.toggle('is-bad', kind === 'error');
    if (kind === 'error') this.setPanelCollapsed(false);
  }

  setDiagnostics(lines: string[]): void {
    this.diagnosticsCount.textContent = String(lines.length);
    this.diagnostics.replaceChildren(...lines.map((line) => {
      const li = document.createElement('li');
      li.textContent = line;
      return li;
    }));
  }

  // ---- the controller (W2.7, ruling W2.R5: a toast when a pad connects or leaves, naming it) ----

  private readonly toastEl = find<HTMLElement>('toast');
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  /** What the hint line was last built from. */
  private hintArgs: [number, boolean] = [1, false];
  private padConnected = false;
  /** Whether the player picked a Controls tab (now or on an earlier visit): a pad connecting then moves nothing. */
  private tabChosen = false;
  /** The mode the page shows, which picks the lists' words (`setWalk`). */
  private walking = false;

  /**
   * A short line in the frame counter's pill, top centre, for `TOAST_MS`. One at a time: a second replaces the first
   * and has its own few seconds. The pill is fixed, so nothing on the page moves when it comes or goes.
   */
  toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.hidden = false;
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastEl.hidden = true;
      this.toastTimer = null;
    }, TOAST_MS);
  }

  /**
   * Whether a pad is connected: the Controller tab's status line says so, an unchosen popover moves to the Controller
   * tab, and `body.pad-on` hides the touch layer on a phone (owner, 2026-09-29: a pad on a phone works as on a desktop;
   * its leaving brings the touch controls back).
   */
  setPadConnected(on: boolean): void {
    this.padConnected = on;
    document.body.classList.toggle('pad-on', on);
    const status = document.getElementById('pad-status');
    if (status) status.textContent = on ? 'Controller connected' : 'No controller connected: press a button on it';
    if (!this.tabChosen) this.showTab(chooseTab(null, on));
    if (on) this.hideTip();
    this.setCameraHint(...this.hintArgs);
  }

  // ---- the phone's tip (owner, 2026-09-29: a controller and landscape recommended; `./mobileTip`) ----

  private tipTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The tip shown, with `text`, until its close button is pressed (`onDismiss`, which the page remembers) or `TIP_MS`
   * pass. Shown again replaces the text and starts the time again.
   */
  showTip(text: string, onDismiss: () => void): void {
    const tip = document.getElementById('mobile-tip');
    const words = document.getElementById('mobile-tip-text');
    const close = document.getElementById('mobile-tip-close');
    if (!tip || !words || !close) return;
    words.textContent = text;
    tip.hidden = false;
    document.body.classList.add('tip-on');
    close.onclick = () => { this.hideTip(); onDismiss(); };
    if (this.tipTimer !== null) clearTimeout(this.tipTimer);
    this.tipTimer = setTimeout(() => this.hideTip(), TIP_MS);
  }

  hideTip(): void {
    if (this.tipTimer !== null) { clearTimeout(this.tipTimer); this.tipTimer = null; }
    const tip = document.getElementById('mobile-tip');
    if (tip) tip.hidden = true;
    document.body.classList.remove('tip-on');
  }

  tipShown(): boolean {
    return document.getElementById('mobile-tip')?.hidden === false;
  }
}

/** How long the Controls popover stays once the pointer has left the tab and the popover, ms. */
export const POPOVER_GRACE_MS = 200;

/** How long a toast stays: long enough to read a pad's id, short enough not to sit over the map. */
export const TOAST_MS = 3500;

/** How long the phone's tip stays when it is not dismissed: long enough to read two lines. */
export const TIP_MS = 12000;

/** The four face buttons' glyphs, in the system's own colours (`.s2u-hint__glyph--*`): the PlayStation shapes on a 14-unit box. */
const FACE_PATHS: Record<FaceGlyph, string> = {
  cross: 'M3 3 11 11M11 3 3 11',
  circle: 'M12 7a5 5 0 1 1-10 0a5 5 0 1 1 10 0',
  square: 'M2.5 2.5h9v9h-9z',
  triangle: 'M7 2 12.5 11.5h-11z',
};

/** A group's heading row, spanning the table (`.pad-group`). */
function groupRow(name: string, span = 2): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = 'pad-group';
  const th = document.createElement('th');
  th.colSpan = span;
  th.scope = 'colgroup';
  th.textContent = name;
  tr.append(th);
  return tr;
}

/** One of the popover's lists filled: a heading row a group, then the button or key (a face button's glyph first) and what it does. */
function fillList(selector: string, groups: ControlGroup[]): void {
  const body = document.querySelector(selector);
  if (!body) return;
  const rows: HTMLTableRowElement[] = [];
  for (const group of groups) {
    rows.push(groupRow(group.name));
    for (const row of group.rows) {
      const tr = document.createElement('tr');
      const key = document.createElement('td');
      if (row.glyph) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', `s2u-hint__glyph s2u-hint__glyph--${row.glyph}`);
        svg.setAttribute('viewBox', '0 0 14 14');
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', FACE_PATHS[row.glyph]);
        svg.append(path);
        key.append(svg);
      }
      key.append(row.keys);
      const does = document.createElement('td');
      does.textContent = row.does;
      tr.append(key, does);
      rows.push(tr);
    }
  }
  body.replaceChildren(...rows);
}

function find<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`the page has no #${id}`);
  return element as T;
}

/** `localStorage`, best-effort both ways: it throws in a private window and returns null when cleared. */
const PANEL_KEY = 's2u.viewer.panelOpen';   // '1' open, '0' folded; the old `panelCollapsed` key held a choice made when open was the default
const LOOK_KEY = 's2u.viewer.look';
const VOLUME_KEY = 's2u.viewer.volume';
const MUTED_KEY = 's2u.viewer.muted';
const MOUSE_LOOK_KEY = 's2u.viewer.mouseLook';
function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* the panel just opens next time */ }
}
