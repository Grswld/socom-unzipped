# Local controller handoff — the walk's 1:1 push (2026-09-29)

For the next local agent picking up where the 2026-09-28/29 controller session stopped (usage limit). Read this, then
`web/README.md`, then the research notes 77-90 in `web/docs/research/` as needed.

## 1. The goal (the owner's words, condensed)

A fully operable, traversable SOCOM II in the browser viewer's **walk mode**: 1:1 maps, and 1:1 movement, animation,
recoil — **the feel first** — models, sounds and UI, every value from the game (SOCOM II decomp where possible, reCOM
where needed). Walk mode is behind the URL flag **`?redotcom`**. Game data never goes in git.

## 2. Where everything is

- **Repo:** `C:/Projects/socom_pc_web` (GitHub `Scotho/socom-unzipped`); the viewer is `web/`. (`C:/Projects/socom` is
  a different project.)
- **Integration branch:** `claude/web-viewer-playtest-fixes` in the worktree **`C:/Projects/wt-web-play`** — every
  workstream merges here. Pushed to origin at `ff54c67b`; the owner approved pushing this branch after further merges
  (a cloud agent merges it into web sprint 3). Push from the main tree: `git -C C:/Projects/socom_pc_web push origin
  claude/web-viewer-playtest-fixes` (the repo forbids pushes from linked worktrees).
- **Dev server:** `.claude/launch.json` config `web-viewer` (in the old session's worktree) ran
  `npm --prefix C:/Projects/wt-web-play/web run dev -- --port 5181`; open `/?map=MP2&redotcom`.
- **Verification (from `C:/Projects/wt-web-play/web`):** `npm run typecheck && npx vitest run` (last green: 1389
  passed / 2 skipped) and `E2E_PORT=5199 npx playwright test` (last full run 38-39 of 39; the grenade spec's flash and
  toss checks were timing flakes, since made robust). If a test needs sound data, re-run `SOCOM_DISC=C:/projects/socom_pc/game/disc npm run extract-maps` (it now copies SOUNDRDR, BNKSTORE, LIBSD.IRX too).
- **Ground truth:** decomp `C:/Projects/socom_pc/game/analysis/socom2_game.elf.decomp.c` (grep by `FUN_`/string, read
  line ranges), reCOM `C:/Projects/socom_pc/research/recom`, disc `C:/projects/socom_pc/game/disc`, console frames
  `scripts/parity/refs/` and `C:/Projects/socom_pc/logs/parity/` (s4_pcsx2 = two clients in a live Vigilance round).

## 3. Workstreams (one worktree + branch each, `C:/Projects/wt-web-<name>` on `claude/web-<name>`)

All were cut from the integration branch and merge back into it (the controller merges; each agent first merges the
integration head into its own branch). State at the stop:

| Workstream | State | Next |
|---|---|---|
| motion (`wt-web-motion`) | merged through round 4 (head look, aim weight, jump rule, swap clips `WalkMode.swapWeapon`) | research 80 §7 leftovers; the pistol set with weapon |
| **weapon** (`wt-web-weapon`) | **17 uncommitted files** — round 3 in progress: the Mark 23 sidearm swap (L1 rifle / L2 Mark 23 / R2 inventory), hand-offs + `Animator.setWeapon`, per-weapon fire/reticle/HUD icon/sounds, pistol-fire and reload clips, the game's reload rules (refill at start, auto-reload on empty, no fire during reload, still→moving overlay). The research is summarised in the controller's last message to it (see the session transcript) and in its own research notes | inspect the diff, finish, test, commit, merge |
| audio (`wt-web-audio`) | merged through round 3 (unlock < 1 ms, lent banks, reverb, ambience, command 45) | idle |
| ui (`wt-web-ui`) | merged through round 3 (panel, toggles, popover, phone layout, `?redotcom` gate) | phone panel covers buttons in landscape (open) |
| maps (`wt-web-maps`) | merged through round 4 (the SEAL's shadow pass, the background compile queue -- Guidance's load stutter 26 slow frames → 1 --, the reflection palette with `specular_map.tif`, the night-vision tint in the shading; research 82 §6). Merged with typecheck + vitest (1401) only: **run the full e2e** | the `hud` fade-in e2e is timing-flaky under load (the HUD steps ≤ 0.1 s a frame); the audio unlock was measured at 36-466 ms by maps vs < 1 ms by audio -- re-measure |
| look (`wt-web-look`) | merged (research 83) | owner decisions below |
| accuracy (`wt-web-accuracy`) | merged through round 3 + the `lastHit` fix | idle |
| grenades (`wt-web-grenades`) | merged through round 4 (claymore + Detonator) | `SMOKE_ALWAYS_PLACEHOLDER` waits on effects' smoke screen |
| traversal (`wt-web-traversal`) | merged through round 3 (dive, hang, slopes) | its ripple keeper is unwired on purpose (effects owns water) |
| hud (`wt-web-hud`) | merged through round 3 (scoreboard on Select/Tab, zoom/range text, message window) | idle |
| feelqa (`wt-web-feelqa`) | merged; tools `web/tools/feel-parity.ts`, `web/tools/playtest.ts`; research 88, 90 | re-run after merges; open issues below |
| **effects** (`wt-web-effects`) | **15 uncommitted files** — round 3 in progress: the per-blast freeze fix (#19, cache/pre-warm light materials), the smoke screen (so grenades can drop their placeholder), effect lights on the body (`rigShading.ts`), `.BUL_CASE_METAL`/`.SG_SHELL_TIN` leftovers (#18) | inspect the diff, finish, test, commit, merge |

Merge recipe used all session: in `wt-web-play`, `git merge --no-ff --no-edit claude/web-<name>`; resolve conflicts by
**union** where both sides add, and by **one path per effect** where both implement the same thing (e.g. explosions go
through the grenade's `setEffectPlayer`; water ripples are effects'); `npm install` if a new workspace package
appears; typecheck + vitest + full e2e; commit with explicit paths (`git add -- <paths>`), the co-author trailer.

## 4. Open issues (research 90, ranked)

1. **#19 (high):** a 500-850 ms frame 0.6 s after every grenade blast — effects is fixing it (uncommitted).
2. #17 fixed in maps round 4 (one 117-217 ms frame left per map when walk starts during the load).
3. Walk entry pre-warmed in maps round 4; re-measure with `tools/playtest.ts`.
4. Grenade bounces on asphalt: the game has no `.GREN_ASPHALT`; the viewer lends `.GREN_STONE` (a named departure).
5. The character shadow is in (maps round 4); only the local player gets one, as in the game.
6. The phone panel covers the touch buttons in landscape (UI).

## 5. Decisions waiting on the owner

- **Native 16:9 field of view:** keep vertical 49° (horizontal widens to 78°) — the recommendation — or crop to the
  console's 70°, or pillarbox to 1.537:1 (research 88).
- **Mouse look default:** raw (1 inch at 800 DPI = 1 s of full stick) or the stick curve; both exist in settings.
- **Triangle hold time** for prone: 0.4 s placeholder (`STANCE_HOLD_S_PLACEHOLDER`), no source found.
- **Rifle kick:** faithful to the decomp, ~30° climb over half a second of auto in the scope; out of the scope the
  view does not kick (research 84).
- **Scope sway** is applied to scoped rounds but invisible, as in the game — a console check would confirm.
- **PS2 presentation's final stretch:** smooth (current) or nearest-neighbour.

## 6. Also running elsewhere

- **Web sprint 3 (multiplayer)** is handed to a cloud agent: branch `web-sprint-3-multiplayer`, spec/plan
  `web/docs/specs|plans/2026-09-29-web-sprint-3-multiplayer*`, handoff zip `C:/Projects/handoff/socom-web-sprint-3.zip`.
  Keep pushing the integration branch after merges so it can pull them in.

## 7. First moves for the next agent

1. `cd C:/Projects/wt-web-play/web && git status && git log --oneline -3` — confirm the head is `ff54c67b` or later.
2. In `wt-web-weapon` and `wt-web-effects`: `git diff --stat`, read the diffs, finish or stash-as-WIP-commit, run
   their tests, commit, then merge each into the integration branch with the recipe above.
3. Run the full e2e (maps round 4 was merged without it).
4. Full verification, push the integration branch, re-run `tools/playtest.ts` on five maps and update research 90.
5. Continue the feel-first list: the open issues above, then the owner's decisions once answered.
