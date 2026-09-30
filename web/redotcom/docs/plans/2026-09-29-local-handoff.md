# Local controller handoff — the walk's 1:1 push (2026-09-29)

For the next local agent or controller picking up the browser viewer's walk mode. Read this, then
`web/redotcom/README.md`, then the research notes 77-93 in `web/redotcom/docs/research/` as needed. Rewritten
2026-09-29 ~11:30Z by the controller seated in `C:/Projects/wt-web-play` after the owner's play test, the fix rounds,
and the merge of web sprint 3; brought current 2026-09-29 ~23:58Z after the launch fixes (section 4a).

## 1. The goal (the owner's words, condensed)

A fully operable, traversable SOCOM II in the browser viewer's **walk mode**: 1:1 maps, and 1:1 movement, animation,
recoil — **the feel first** — models, sounds and UI, every value from the game (SOCOM II decomp where possible, reCOM
where needed). Walk mode is the settings' **Mode** switch (`mode=play`; `?redotcom` is its alias). Offline it plays
the match on its own (section 4a); `&nomatch` keeps the free walk. Game data never goes in git. Owner 2026-09-29:
"polish until it's release ready" and "complete any holes".

## 2. Where everything is

- **Integration branch:** `claude/web-viewer-playtest-fixes` in the worktree **`C:/Projects/wt-web-play`** — every
  workstream merges here. **Web sprint 3 (multiplayer) is merged in** (12725f26): the shared sim boundary
  (`mover.ts` now holds the `Walker`; the server runs it), the net protocol, remote players, deaths and respawn, the
  net page, `packages/server`, the Lightsail deploy under `web/redotcom/deploy/`.
- **Pushing:** the PreToolUse guard refuses a push from this seat, even via `git -C` into the main tree. The owner (or
  the main-tree controller at the owner's word) pushes: `git -C C:/Projects/socom_pc push origin
  claude/web-viewer-playtest-fixes`. Last pushed: d995b282 -- everything after it (the launch fixes included) is local.
- **Dev server:** `npm --prefix C:/Projects/wt-web-play/web run dev -- --port 5181`; open `/?map=MP2&mode=play&devmode`
  (without `&devmode` the page shows the disc page: `viewer/src/source.ts`). Port 5181 is the owner's; agents use
  their own (5199 integration e2e, 5201+ per workstream).
- **Verification (from `C:/Projects/wt-web-play/web`):** `npm run typecheck && npm test` -- each workspace's own vitest
  (web/ has no vitest config: a bare `npx vitest run` there ignores the per-package configs and even collects the
  Playwright specs). Last green: the docs batch's repair (agent/web-w3docs, on its committed head, 2026-09-30 00:21Z, fixtures present)
  redotcom typecheck clean, 169 files passed / 1 skipped, 2004 tests passed / 4 skipped incl. the server tests and the
  paths guard (which skips its own file: it names the pre-move paths on purpose); landing 206 passed (b6). Landing's globalSetup (`tools/vitest-prepare.mjs`) makes
  story.html and public/story first, so a targeted run works too; `S2U_TEST_FIXTURES=<empty dir>` points
  `archive/test/fixtures.ts` away (its users skip, as on CI). Then `E2E_PORT=5199 npx playwright test` (last full run
  49+ passed, before the launch fixes; the multiplayer spec needs `node --import tsx`, fixed in 055d52ec). Load test:
  `npx tsx tools/mp-bots.ts --spawn-server --disc test-fixtures --seconds 30` (60 ticks/s, 0 corrections at 16
  players + 8 spectators). Sound/map data: `npm run extract-maps` (`SOCOM_DISC` defaults to the repository's
  `game/disc`).
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
- **The panel kicker says `redotcom · SOCOM II multiplayer`** on every page, fly-only included: redotcom is the
  project's name, no longer the walk flag's word (a9228a66 restored it over b1eb349b; ui.spec.ts pins it). Do not flip
  it.
- **Launch-review rulings (the owner, 2026-09-29):** the site keeps serving `/redotcom/maps/` for now (OWNER-1
  withdrawn; the move to disc-only is row O28 in `docs/HUMAN_TASKS.md`); `/rooms` is public and documented (OWNER-4);
  the airborne column takes the ground's pick, not 6.5 (OWNER-5); the scorch pool is the game's 30 triangles, refused
  when full (OWNER-6). OWNER-3 needed no answer: the server runs the page's own accuracy cone (`net/shotCone.ts`).

## 4. Rounds since the first rewrite (all merged here, 2026-09-29 afternoon)

- **Multiplayer holes** (`wt-web-mp`): `web/redotcom/deploy/env.example` (placeholders only; its allow line is on
  sprint-17 7a176e35), only an accepted swap is replicated, remote players hand the weapon off mid-clip.
- **Effects:** marks, footprints and the scorch clipped to the world triangles under them, shaded per vertex
  (`markClip.ts`, 6055a75e); the pool counts triangles as the game's does (`TEMP_DECAL_TRIANGLES` = 150, so ~30 marks
  stay up -- kept for fidelity); marks framed along the hit surface's normal, not the round (75495a54 -- slanted big
  walls were dropped whole; research 89 section 15).
- **Traversal:** prone in water over 2 deep is the game's crouch (over 8.5: stand), applied before any clip starts
  -- the release sweep's "prone refused + creep" on MP62/64/71 (research 86 section 6.4).
- **Audio:** HUDUI loaded with every map (the goggle sounds), emitter offsets, Death Trap's default material, the
  context made at page start (unlock ~0.1 ms).
- **Maps:** the WebGL2 walk-entry stall (167-208 ms) fixed by a rehearsal draw before the walk (now 9-42 ms); the
  blast's shadow-pass link and the late arc/scorch warm-ups fixed (blast worst 42-58 ms WebGL2, 8-17 ms WebGPU).
- **Motion:** the touch C button takes the C rule (it is hidden while walking; Triangle keeps the pad's rule);
  per-test timeouts for load-bound vitest; `shot.ts` deleted.

Release checks in the 13:10-14:05Z window: e2e 50/53 (the audio spec's bank list fixed after; the muzzle flash
flaked and passed; the mark-colour spec failed -> the 75495a54 fix, e2e owed); the release sweep clean on the 7
remaining WebGL2 maps and on MP2/MP62/MP9/MP10 x both looks on WebGPU (scope sides black, key 3, no pistol zoom, no
first person, stance, audio, blasts). The sweep's MP71 "no mark" was not a game defect: its heading met only
`INVISIBLE_DI` (`PENETRATION` 1, passed over by rule); the sweep now picks the first strikable surface (research 89
section 15, `tools/sweepHeading.ts`). **Grenades:** the scorch is framed along the ground's normal (8a4e853e, research
85 section 7.3).

## 4a. The launch fixes (2026-09-29 evening, all merged here)

The Fable-signed launch fix list (blockers BL-1..7, majors MJ-1..11, post-launch items taken early) landed in three
waves, each Fable-verified:

- **Wave 1** (B1-B10, B13): the room owns fire and reload (the fastest mode's rate, the weapon from the server's frame,
  the round re-run from the eye, the reload lock = the clip, `reloadClip.ts`, one table for the page and the room);
  malformed frames dropped, never thrown (room and process); one hello per socket; a 5 s ping/pong heartbeat;
  `TRUST_PROXY`; respawn refills the page's kit; R on a full magazine reloads (the game's ring walk); map switches
  dispose what they made; mission zAnims before common; remote fire's MED/FAR reports; the ground pick in the air;
  the spawn placed from the feet + 5; ISO/rdr/grid hardening (research 93); the e2e specs and the landing claims.
- **Wave 2:** the scorch pool (30 triangles), the effect-light overlays out of the clip, the effect SOUND volume; the
  release sweep's fall and mark heading; one yaw arithmetic (`yaw.ts`: the climb turns the short way at any winding);
  one retail `.rdr` count (736); a dropped disc's unreadable archive named on the disc page.
- **Grenade damage and the offline match** (df10caaa): grenades hurt, knock and ring the player (research 85 section
  12); offline, reCOM mode runs the match server's own `Room` in the page (`net/loopback.ts`, research 91 section 20),
  on by default -- `&nomatch` keeps the free walk, `&fly` too (every e2e spec but `soloMatch.spec.ts` opens with it).
  **The protocol is 6** (four knock action codes and the `blast` event after protocol 5's).
- **Docs** (the last batch): the research notes' placeholder rows and the retired ones, the stale paths
  (`tools/test/paths.test.ts`), and `tools/test/placeholderLedger.test.ts`, which fails when a `*_PLACEHOLDER` /
  `*_READING` in the viewer, server, scene or sound sources is in no note's placeholder section, or a note still lists
  one no source holds without marking it resolved, retired or note only.

**The release gate** (the signed GO): typecheck + `npm test` green with and without fixtures; then, in a window the
main-tree controller names, the full e2e -- owed since the launch fixes: multiplayer, touch, weapon (the fire event's
eye and aim), doors, pad, ui (MJ-11), share (PL-12), soloMatch, and effects' "the marks take the colour of the wall
they are on"; web.yml green on the pushed head; the leak gate with the audio fixtures gone (B4); the owner's push.

Merge recipe: in `wt-web-play`, `git merge --no-ff --no-edit <branch>`; union where both add, one path per effect
where both implement the same thing; `npm install` if a package appears; typecheck + vitest + e2e (host rule); commit
with explicit paths, the co-author trailer. The browser runs happen only in a window the main-tree controller names.

## 5. Open issues

1. Owed browser checks: the release gate's e2e list (section 4a), then the owner's push. Owner rows: O28 (redeploy
   the site; later the disc-only switch); a live cloudflared tunnel must add `/rooms` to its ingress (OWNER-4,
   `deploy/README.md`) -- row O29.
2. The pad's Triangle from prone stands (the game's pad rule); C and touch C crouch (the owner's PC rule).
3. Sprint 3 deferred: WebRTC, delta snapshots, per-map kits, the claymore online, the radio menu's look, spectator
   views. The net code's placeholders are listed in research 91 section 16 (the ledger test keeps them there).
4. Grenade stand-in sprites (maps with no game explosion effect) make materials per blast, so they cannot be warmed.
5. Small leftovers the verifiers named: a door's zAnim `SOUND` still plays at 1.0 (`doors.ts` drops `op.volume`,
   research 81 section 12); the sweep's `floorUnder` / `surfacesAlong` hooks are ungated like the rest of `__viewer`;
   the knock's `ROOT_HEIGHT` has no disc-gated pin; the Online panel reads "single player: no server" while the
   offline match runs.

## 6. Decisions waiting on the owner

- **Triangle hold time** for prone: 0.4 s placeholder (`STANCE_HOLD_S_PLACEHOLDER`), no source found.
- **Rifle kick:** faithful to the decomp, ~30° climb over half a second of auto in the scope (research 84).
- **Scope sway** is applied to scoped rounds but invisible, as in the game — a console check would confirm.
