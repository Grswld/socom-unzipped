import type { MapInfo } from '@s2u/archive';
import { labelFor } from './mapOrder';
import { viewerRevision, viewerRevisionBadge } from './revision';
import { ACTION_WORDS, shortSource, type PadRow } from './gamepad';

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
  /** Whether the play (walk mode) is on the page: the Fly / Walk switch's hidden box is there only then (`./features`). */
  private readonly play = document.getElementById('walk') !== null;
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
    const input = find<HTMLInputElement>('disc-file');
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      // Cleared so choosing the same image again still fires `change`.
      input.value = '';
      if (file) handler(file);
    });
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

  /** No maps are served: the panel opens on the disc control, even on a phone where it starts folded. */
  offerDisc(): void {
    this.setPanelCollapsed(false);
    document.body.classList.add('no-served');
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
   * The Controls popover (owner, 2026-09-28): `#controls`, anchored under the bar's Controls tab, holding the hint line
   * and the pad's table -- both the current mode's alone (`setCameraHint`, `renderPadLayout`). It is open while the
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
  onLook(): void {
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
      });
    }
    box.addEventListener('change', show);
    const stored = read(LOOK_KEY);
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
    if (this.walking === walking) return;
    this.walking = walking;
    this.setCameraHint(...this.hintArgs);
    this.renderPadLayout();
  }

  /**
   * The camera's line: the controls of the mode you are in and no others (owner, 2026-09-28) -- fly's or walk's, F
   * fullscreen and the backtick in both. Rebuilt on every mode change (`setWalk`), and reads differently once the mouse
   * is captured, because the way back out -- Esc -- is the one control a player cannot guess from the others.
   */
  setCameraHint(multiplier: number, locked: boolean): void {
    this.hintArgs = [multiplier, locked];     // W2.7: kept, so a pad's connecting or a mode change can rebuild the line
    const speed = `wheel speed ${multiplier.toFixed(multiplier < 1 ? 2 : 1)}×`;
    const mode = this.walking ? WALK_HINT : `${FLY_HINT} · ${speed} · arrows look${this.play ? ' · G walk' : ''}`;
    // The backtick belongs to every version of this line: it used to be in the page's markup only,
    // so the first wheel notch or pointer lock rebuilt the hint without it and it vanished.
    const rest = `${mode} · F fullscreen · \` hides this`;
    this.hint.textContent = locked ? `esc to release · ${rest}` : `click to look · ${rest}`;
    if (this.padConnected) this.hint.textContent += ' · pad: connected';
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

  // ---- the controller (W2.7, ruling W2.R5: a toast when a pad connects or leaves, naming it; the layout shown) ----

  private readonly toastEl = find<HTMLElement>('toast');
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  /** What the hint line was last built from, and whether it carries the pad's note. */
  private hintArgs: [number, boolean] = [1, false];
  private padConnected = false;
  /** The mode the page shows, which picks the hint line's and the pad table's words (`setWalk`). */
  private walking = false;
  /** The layout the table was last filled from, kept so a mode change can redraw it. */
  private padRows: readonly PadRow[] | null = null;

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

  /** "pad: connected" at the end of the hint line while a pad is, however the line is rebuilt. */
  setPadConnected(on: boolean): void {
    this.padConnected = on;
    this.setCameraHint(...this.hintArgs);
  }

  /**
   * The layout table under the hint line (`index.html`, `#pad-box`), shown: a row per control that does something in
   * the mode you are in, what it does, and its source -- the owner's word or the repository's, or the system's warn
   * label, "assumed", on a row neither documents. The row's note is its tooltip. Redrawn on a mode change.
   */
  showPadLayout(rows: readonly PadRow[]): void {
    this.padRows = rows;
    this.renderPadLayout();
    find<HTMLElement>('pad-box').hidden = false;
  }

  private renderPadLayout(): void {
    const rows = this.padRows;
    const body = document.querySelector('#pad-layout tbody');
    if (!rows || !body) return;
    const mode = this.walking ? 'walk' : 'fly';
    find<HTMLElement>('pad-mode').textContent = this.walking ? 'on foot' : 'flying';
    // With the play off there is no walk to switch to, so Start has no row either.
    body.replaceChildren(...rows.filter((r) => ACTION_WORDS[r.action][mode] !== null && (this.play || r.action !== 'mode'))
      .map((r) => padRow(r, mode)));
  }
}

/** The hint line's controls, by mode; the page's markup carries the same fly line for the first paint. */
const FLY_HINT = 'WASD fly · space/shift up/down · double-tap W to boost';
const WALK_HINT = 'WASD move · mouse look/turn · space jump · C stance · V first person · right click zoom · d-pad up/down zoom · click fire · B fire mode · R reload · G fly';

/** How long the Controls popover stays once the pointer has left the tab and the popover, ms. */
export const POPOVER_GRACE_MS = 200;

/** How long a toast stays: long enough to read a pad's id, short enough not to sit over the map. */
export const TOAST_MS = 3500;

/**
 * The four face buttons' glyphs, in the system's own colours (`.s2u-hint__glyph--*`, the site's hint bar): the
 * PlayStation shapes on a 14-unit box.
 */
const FACE_GLYPHS: Partial<Record<PadRow['control'], { kind: string; d: string }>> = {
  Cross: { kind: 'cross', d: 'M3 3 11 11M11 3 3 11' },
  Circle: { kind: 'circle', d: 'M12 7a5 5 0 1 1-10 0a5 5 0 1 1 10 0' },
  Square: { kind: 'square', d: 'M2.5 2.5h9v9h-9z' },
  Triangle: { kind: 'triangle', d: 'M7 2 12.5 11.5h-11z' },
};

function padRow(row: PadRow, mode: 'walk' | 'fly'): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.classList.toggle('is-assumed', row.documented === 'assumed');
  tr.title = row.note;
  const cell = (...content: (Node | string)[]): HTMLTableCellElement => {
    const td = document.createElement('td');
    td.append(...content);
    tr.append(td);
    return td;
  };
  const glyph = FACE_GLYPHS[row.control];
  if (glyph) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', `s2u-hint__glyph s2u-hint__glyph--${glyph.kind}`);
    svg.setAttribute('viewBox', '0 0 14 14');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', glyph.d);
    svg.append(path);
    cell(svg, row.control);
  } else {
    cell(row.control);
  }
  cell(ACTION_WORDS[row.action][mode] ?? '');
  if (row.documented === 'assumed') {
    const label = document.createElement('span');
    label.className = 's2u-label s2u-label--warn';
    label.textContent = 'assumed';
    cell(label);
  } else {
    cell(shortSource(row.documented)).title = row.documented;
  }
  return tr;
}

function find<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`the page has no #${id}`);
  return element as T;
}

/** `localStorage`, best-effort both ways: it throws in a private window and returns null when cleared. */
const PANEL_KEY = 's2u.viewer.panelOpen';   // '1' open, '0' folded; the old `panelCollapsed` key held a choice made when open was the default
const LOOK_KEY = 's2u.viewer.look';
function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* the panel just opens next time */ }
}
