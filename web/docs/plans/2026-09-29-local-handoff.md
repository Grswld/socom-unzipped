# Local controller handoff — the walk's 1:1 push (2026-09-29)

For the next local agent or controller picking up the browser viewer's walk mode. Read this, then `web/README.md`,
then the research notes 77-91 in `web/docs/research/` as needed. Rewritten 2026-09-29 ~11:30Z by the controller seated
in `C:/Projects/wt-web-play` after the owner's play test, the fix rounds, and the merge of web sprint 3.

## 1. The goal (the owner's words, condensed)

A fully operable, traversable SOCOM II in the browser viewer's **walk mode**: 1:1 maps, and 1:1 movement, animation,
recoil — **the feel first** — models, sounds and UI, every value from the game (SOCOM II decomp where possible, reCOM
where needed). Walk mode is behind the URL flag **`?redotcom`**. Game data never goes in git. Owner 2026-09-29:
"polish until it's release ready" and "complete any holes".

## 2. Where everything is

- **Integration branch:** `claude/web-viewer-playtest-fixes` in the worktree **`C:/Projects/wt-web-play`** — every
  workstream merges here. **Web sprint 3 (multiplayer) is merged in** (12725f26): the shared sim boundary
  (`mover.ts` now holds the `Walker`; the server runs it), the net protocol, remote players, deaths and respawn, the
  net page, `packages/server`, the Lightsail deploy under `web/deploy/`.
- **Pushing:** the PreToolUse guard refuses a push from this seat, even via `git -C` into the main tree. The owner (or
  the main-tree controller at the owner's word) pushes: `git -C C:/Projects/socom_pc push origin
  claude/web-viewer-playtest-fixes`. Last pushed: d995b282 — everything after it is local.
- **Dev server:** `npm --prefix C:/Projects/wt-web-play/web run dev -- --port 5181`; open `/?map=MP2&redotcom`. Port
  5181 is the owner's; agents use their own (5199 integration e2e, 5201+ per workstream).
- **Verification (from `C:/Projects/wt-web-play/web`):** `npm run typecheck && npx vitest run` (last green 1550 passed
  / 2 skipped, includes the server tests) and `E2E_PORT=5199 npx playwright test` (last full run 49+ passed; the
  multiplayer spec needs `node --import tsx`, fixed in 055d52ec). Load test: `npx tsx tools/mp-bots.ts --spawn-server
  --disc test-fixtures --seconds 30` (60 ticks/s, 0 corrections at 16 players + 8 spectators). Sound/map data:
  `SOCOM_DISC=C:/projects/socom_pc/game/disc npm run extract-maps`.
- **HOST RULE (owner, via the main-tree controller, 2026-09-29):** the web work must never collide with the game's
  runs and gates. Before EVERY Playwright/headless-Chrome run or bots load test: `bash
  C:/Projects/socom_pc/scripts/loop_lock.sh check`; run only if FREE or HELD with a build purpose; never beside a
  purpose starting "launch" or "merged chain". vitest without a browser is fine any time. Put this in every brief.
- **Ground truth:** decomp `C:/Projects/socom_pc/game/analysis/socom2_game.elf.decomp.c`, reCOM
  `C:/Projects/socom_pc/research/recom`, disc `C:/projects/socom_pc/game/disc`, console frames
  `scripts/parity/refs/` and `C:/Projects/socom_pc/logs/parity/` (s4_pcsx2 = two clients in a live Vigilance round).

## 3. Owner rulings 2026-09-29 (after playing) — all implemented and merged

- FOV (vertical 49°), mouse look (raw default, stick curve kept), PS2 final stretch smooth: kept as they were.
- **No first person:** third person or scoped only (motion c13c6d34). Night vision stays as a lens step on night maps.
- **No pistol scope**; the rifle scope's black covers the sides at 16:9, the night goggles too (weapon round 3).
- **PC keys:** tap C = stand/crouch (from prone: crouch), hold C 0.4 s = prone; 1 main, 2 pistol, 3/4 equipment
  slots in kit order.
- **Swap snap** fixed both ends (each weapon hangs from its own clip track, a 0.4 s ease — a named viewer reading).
- **Yellow grenade arc** from the game's `FUN_005970b0`/`FUN_00598860` (grenades, research 85 §11).
- **PS2 black screen** (WebGPU only: the present quad skipped MSAA and the overlays overwrote it) fixed (maps 857b2108).
- **Bullet marks too light:** the game multiplies decals by the wall's vertex colour; marks and footprints now do
  (effects 472efd19, research 89 §13).
- **Jumping up a slope clipped through the ground:** the airborne tick now takes the ground's floor pick (traversal
  2a491b07, research 86 §6.3; now in `mover.ts`).
- Mouse sensitivity goes down to 0.05.

## 4. Workstreams in flight at this writing

| Workstream | Tree | Doing |
|---|---|---|
| grenades | `wt-web-grenades` | the scorch takes the wall's colour (like the marks); research 85's stale keys; `kit.ts` comments |
| multiplayer | `wt-web-mp` (`agent/web-mp`) | `web/deploy/env.example` (missing); replicate only an accepted swap; remote swap hand-off mid-clip; remote stance/scope/jump check |
| feelqa | `wt-web-feelqa` | release-readiness play test on every map, both presentations, both backends; ranked table in research 90 |

Idle, merged: motion, weapon, audio, ui, maps, look, accuracy, hud, traversal, effects.

Merge recipe: in `wt-web-play`, `git merge --no-ff --no-edit <branch>`; union where both add, one path per effect
where both implement the same thing; `npm install` if a package appears; typecheck + vitest + e2e (host rule); commit
with explicit paths, the co-author trailer.

## 5. Open issues

1. The leak check: 33649f95 (sprint 3) names the deploy settings file in 19 lines; the reviewed allow lines are 82c63b42 here,
   and the main-tree controller adds the same on sprint-17 (CI reads its copy).
2. Marks are not clipped to their polygon (they hang past stair edges); one shade per mark where the game shades
   per vertex.
3. The touch C button still cycles stand → crouch → prone; the pad's Triangle from prone stands (C crouches).
4. Sprint 3 deferred: WebRTC, delta snapshots, per-map kits, the claymore online, the radio menu's look, spectator
   views; ~20 `_PLACEHOLDER` constants in the net code.
5. The feel-QA ranked table (research 90) sets the next round.

## 6. Decisions waiting on the owner

- **Triangle hold time** for prone: 0.4 s placeholder (`STANCE_HOLD_S_PLACEHOLDER`), no source found.
- **Rifle kick:** faithful to the decomp, ~30° climb over half a second of auto in the scope (research 84).
- **Scope sway** is applied to scoped rounds but invisible, as in the game — a console check would confirm.
