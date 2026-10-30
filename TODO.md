# TODO — Fighting Game Engine Web

## PRIMARY GOAL

**Browser-based fighting game platform: IKEMEN GO v2 WASM engine + React UI that handles ALL menus, with the roster streamed from a CDN assets repo and online play over WebRTC P2P.**

## CURRENT STATE (October 28, 2026) — ONLINE PLAY SHIPPED, DOCS REALIGNED

- ✅ Esc is reserved for the site's fight-exit flow (shipped
  `EscOpensMenu=0`; Settings toggle restores the native menu) and the
  Assets manifest casing is aligned with disk (F-006 closed — 6
  characters' CDN downloads no longer 404).
- ✅ Online multiplayer live (Phase 4): WebRTC P2P lockstep over
  `public/game/webrtc.js`, Cloudflare Workers signaling relay + ranked
  queue (`netrelay/cloudflare/`), room codes + QR, build-hash + roster
  fingerprint handshake (mismatched clients are REFUSED, not desynced),
  rematch-in-place, pre-fight RTT pill, mid-fight DC report, weak-link
  strip for slow links, guest stage prefetch, screen Wake Lock.
- ✅ Display ladder complete: TALL 4:3 / FITTED / 3:2 WIDE / 14:9 / 5:3 /
  EXPANDED (classic 4:3) + stage zoom on close action + portrait
  "Game Boy" mode (no landscape locks).
- ✅ Separated UI flow: /lobby → /mode-select (ISSUE 01) → /group-select
  (ISSUE 02) → /local roster (ISSUE 03) → stage select (ISSUE 04) →
  /match-prep → /play. Online rides the same select screens with live
  spectate cursors synced over the bridge (host's pick is flagged).
- ✅ PWA install (address-bar + menu entry), Squadron Comic skin with
  unique ISSUE numbers per screen (05 NETWORK on the netplay overlays),
  transparent character portraits.
- ✅ Demo asset mirror: the demo deployment reads
  `FightingGameEngine/DemoAssets` via the `ASSETS_GH_REPO` env pin in
  `vercel.json` — now a **Marvel-only roster with the full production
  stage set** (87 charsMARVEL characters + portraits; the 71-char DBZ
  `chars/` was removed; all 9 Assets stages + thumbs copied in and
  Masjid_Al_Mustafa removed; manifest at **v5** — `sources`, portrait
  fields, and the per-character `source` field the UI groups by).
  `scripts/sync-demo-assets.py` must NOT be run against it anymore
  without an include-list update — it would re-add the removed DBZ
  `chars/`.
- ✅ Frontend 2.1 complete (spec §56 DoD); 100% 60fps for ALL characters
  incl. heavy DBZ with specials (F-038 spatial grid broad-phase); no
  mid-round GC pauses (F-033); IndexedDB caching (F-037); .pak fast load
  (F-029); 87 characters + 9 stages on the production CDN.
- ✅ Comic Print System v2 (F-042): full-page motion on every chrome
  screen — staggered entrances, ambient print-shop loops, hover/press
  micro-interactions; transform/opacity only, reduced-motion honored.
- ✅ Motion completion pass (F-049): reduced-motion coverage closed
  (wipe sweep, spinner pulse, entrances/pulses), every transform hover
  gated behind (hover: hover) — no sticky lifts on touch — plus motion
  tokens, roster press feedback, settings entrance (dormant until the
  F-041 restore). Audit + 3-context verifier kept in /scripts.
- ✅ Phase 4 hardening batch (Oct 25): mid-fight flow-stall watchdog +
  stream-integrity probes (F-044) and ranked ladder persistence on the
  relay (F-045) — both purely additive; the ladder goes live with one
  `wrangler deploy` and degrades to today's silence until then.
- ✅ 6 game modes all working (VS CPU, VS Player, Training, Arcade,
  Survival, Time Attack). Watch is disabled for the public showcase
  (F-041) — machinery intact; restore = re-add the MODES catalog entry.
- ✅ **This repo (`FightingGameEngine-Demo`) and
  `FightingGameEngine-Web` mirror each other's code byte-for-byte**, with
  ONE deliberate exception: `vercel.json` `env.ASSETS_GH_REPO` — Demo
  pins `FightingGameEngine/DemoAssets`, Web pins `FightingGameEngine/
  Assets` (production). Histories diverge at those commits; never mirror
  that env line between the repos (see AGENT.md).
- ✅ Asset origin is public and now presented as a feature (F-046): the
  manifest `cdnBase`, portrait/stage `<img>` srcs and the network tab all
  carry `cdn.jsdelivr.net/gh/FightingGameEngine/DemoAssets@main/…`, and
  both asset repos are public — audited live; user chose "stay public".
  About gained section 04 "Open by design" linking the repo; Credits
  credit the MUGEN community; `stageThumbUrl` regex made
  repo-name-agnostic.
- [ ] Optional brand polish: rename `FightingGameEngine/DemoAssets` →
  `openfighter-assets`. Steps 1–2 of the runbook (FINDINGS F-046) need
  the FightingGameEngine account; the demo-side follow-ups (vercel.json
  env, sync script default, About/README/AGENT names) are one commit
  here.

---

## Phase 0 — Foundation (COMPLETE)

- [x] Build IKEMEN GO v2 WASM from source (energyjp/ikemen-go-web, Go 1.21 + GOEXPERIMENT=arenas)
- [x] Extract engine JS files from WebMUGEN modding kit v1.7
- [x] Copy engine data files from energyjp source
- [x] Set up Next.js project with App Router + TypeScript + Tailwind CSS 4
- [x] Create VFS manifest generator + .pak bundler
- [x] Build `/play` page with WASM loader
- [x] Configure `vercel.json` with WASM MIME type + immutable cache headers
- [x] Deploy to Vercel

---

## Phase 1 — Core Playable (COMPLETE)

- [x] Engine boots via f_quickMatch (bypasses laggy menu)
- [x] Fights run at smooth 60fps using optimized game() path
- [x] React character select (mode, P1/P2, stage, AI level, resolution)
- [x] Player input (WASD/UIO/JKL for P1, arrows/numpad for P2)
- [x] AI opponent (level 1-8)
- [x] .pak bundling + parallel loading
- [x] Immutable caching
- [x] Auto-redirect after fight
- [x] Touch controls for mobile (reads key bindings from config.ini)
- [x] Escape/touch exit to quit fight back to the site

---

## Phase 2 — Asset Pipeline (COMPLETE)

- [x] CDN proxy route (/api/cdn/) — fetches from GitHub raw, serves with CORS
- [x] Character download from CDN (parallel, batched, with progress)
- [x] VFS injection API (ikemenInjectFile / ikemenHasFile)
- [x] Full roster from the Assets manifest on the select screen
- [x] Lenient state controller parsing (F-032 — empty [State] blocks skipped)
- [x] Browser caching of CDN files (force-cache)
- [x] IndexedDB caching of downloaded characters/stages (F-037, transactional)
- [x] Demo asset mirror (`ASSETS_GH_REPO` switch + `scripts/sync-demo-assets.py`)
- [x] Assets manifest casing aligned with disk (F-006 closed — 6 characters
  + 3 portraits were 404ing on case-sensitive CDNs)

---

## Phase 3 — UI Polish (COMPLETE)

- [x] Title/lobby screen (Squadron Comic poster v2)
- [x] Wipe transition between screens
- [x] Character portraits on select screen (transparent PNGs from CDN)
- [x] Settings/options screen — 9-tab React settings menu at /settings,
  all IKEMEN GO config options, keyboard remapping with capture flow
- [x] Mobile responsive UI (tap-to-lock select, touch controls, rotate overlay)
- [x] Keyboard remapping (KEYS tab, capture flow, conflict detection)
- [x] Match-prep screen with real asset readiness (spec §17/§48)
- [x] Progress/results screens with real names + mode rules (spec §21/§22)
- [x] Error/retry affordances on every fetch failure (spec §16/§33)

### Remaining (minor)
- [ ] Move list display (per-character command list)
- [ ] Sound effects for the site UI (engine sounds work; site chrome is silent)

Note: Fight HUD (lifebars/timer/rounds) is rendered natively by the
engine — no site-side overlay is planned.

---

## Phase 4 — Online Multiplayer (SHIPPED — hardening continues)

- [x] WebRTC netplay (`public/game/webrtc.js` — P2P data channels,
  lockstep input stream, STUN + optional TURN via `turn-creds.json`)
- [x] Room/lobby system — signaling relay deployed on Cloudflare Workers
  free tier (`netrelay/cloudflare/worker.js`), short room codes + QR
  scan, in-memory rooms (max 500, 30-min expiry)
- [x] Ranked queue — `?queue=1&build=...` matchmaking bucketed by Build
  ID + netcode so only byte-identical clients pair
- [x] Build ID verification — bridge build-check hash covers shipped
  pack + browser mods + theme + roster manifest fingerprint
  (`engineRosterHash`, cyrb64); mismatched clients are refused at the
  handshake with a hard-refresh message instead of desyncing mid-fight
- [x] Online flow over the site's own select screens — host picks the
  universe, BOTH players pick fighters + stage with live spectate
  cursors ('gcursor'/'scursor' IKWS frames); zero engine-side menus
- [x] Rematch in place (fresh Go runtime + WASM instance from the
  compiled module; REMATCH / CHANGE FIGHTERS / LOBBY panel)
- [x] BACK guard (history guard + themed LEAVE-SESSION confirm +
  beforeunload) and courtesy 'leave' frames on every exit path
- [x] Disconnect handling — pre-fight transport self-heal (pong
  disproof of stale failure latches), guest stage prefetch before 'go',
  Wake Lock across the net flow, weak-link strip vs full DC report
  (flagged-but-alive never walls the fight), mid-fight DC overlay
- [x] Pre-fight RTT pill (netping/netpong every 4s; green ≤70ms /
  royal ≤130 / crimson)

### Remaining (online)
- [x] Desync DETECTION beyond prevention (F-044, site-side half): the
  handshake still refuses mismatched builds up front; mid-fight, a
  flow-stall watchdog now surfaces a previously-flowing input stream
  going silent (~10s) as a non-destructive "FIGHT STALLED" strip, and
  stream-integrity probes cross-check cumulative byte counters between
  peers (a persistent >64KB excess = forked streams, reported to the
  diag overlay, never fatal). A true mid-fight engine STATE-hash compare
  still needs engine-side work — none happened here (no WASM rebuild).
- [x] Ranked ladder persistence (F-045): the relay worker now serves
  `LadderDO` + `/leaderboard/report|player|top` — both peers post
  mirror halves, the match counts only on agreement, disputes and
  replays are refused, orphan halves expire via the DO alarm. Client
  wired via `ladderBase()` (relay origin), with ranked-record readouts
  on the queue and postfight panels. NEEDS `wrangler deploy` (migration
  v2 registers the class); until then the site behaves exactly as
  before — silent skip, both compatibility directions graceful.
- [ ] Full match spectating (IKEMEN rollback supports spectators; today
  only the SELECT screens are spectated live)
- [ ] Remove the old-peer compatibility shims once the fleet is current
  (no-id frames degrade gracefully today)

---

## Phase 5 — Compatibility & Testing (NOT STARTED — needs real hardware)

- [ ] Test all characters from the production Assets repo
  - Categorize: works perfectly / minor glitches / major issues / crashes
  - Document findings in FINDINGS.md
- [ ] Test all stages
- [ ] Test across browsers (Chrome primary; Firefox, Safari, Edge)
- [ ] Test on mobile (Android Chrome, iOS Safari)
- [ ] Performance profiling on mid-range hardware
  - GC pause patterns with `?gctrace=1`
  - Heap profile with `?profile=1` for large rosters

---

## Potential Future Optimizations (researched)

### Tier 1: Safe, build-flag only
- [ ] **PGO (Profile-Guided Optimization)**: capture CPU profile during
  fight, rebuild with `-pgo=profile.pprof`. Go 1.21+ supports this for
  GOOS=js. Expected 5-15% faster hot paths.
- [ ] **`-gcflags="-B"` (disable bounds checks)**: 3-8% in array-heavy
  code. One build flag, no code changes. Low-medium risk.

### Tier 2: Medium effort, medium risk
- [x] ~~Spatial grid broad-phase collision~~ — DONE (F-038, 164ms spikes
  eliminated; the engine WASM already ships it)
- [ ] **sync.Pool for hot allocations**: pool frequently allocated
  structs (helpers, projectiles, explods). Requires a WASM rebuild.

### Tier 3: Confirmed dead ends (don't try)
- [x] ~~WASM SIMD~~: Go compiler doesn't autovectorize. No stable path.
- [x] ~~True multithreading~~: Go GOOS=js is single-threaded. No change as of Go 1.24.
- [x] ~~Web Worker~~: isolates from main thread but doesn't speed up engine.

### Build command with all optimizations (for future rebuilds)
```bash
GOEXPERIMENT=arenas GOWASM=satconv,signext GOOS=js GOARCH=wasm CGO_ENABLED=0 \
  go build -trimpath -pgo=profile.pprof -gcflags="-B" -o bin/ikemen-v2.wasm ./src
```

---

## Key Findings Summary

| ID | Status | Summary |
|----|--------|---------|
| F-006 | ✅ Fixed | Assets manifest casing vs disk — 6 chars' CDN fetches 404'd |
| F-017 | ✅ Breakthrough | IKEMEN GO CLI quick match — no WASM changes to skip menus |
| F-023 | ✅ Fixed | vfs.js Promise cache storm |
| F-025 | ✅ Applied | WASM rebuilt with yield fixes |
| F-028 | ✅ Breakthrough | f_quickMatch works — fights playable |
| F-029 | ✅ Breakthrough | .pak bundling — 1 HTTP request instead of 48 |
| F-032 | ✅ Breakthrough | Lenient state parsing — all chars load |
| F-033 | ✅ Breakthrough | GOGC=off — no mid-round GC pauses |
| F-035 | ✅ Breakthrough | Audio buffer + safety-net GC + GOWASM flags |
| F-037 | ✅ Feature | IndexedDB caching — download-on-select, instant fights |
| F-038 | ✅ Breakthrough | Spatial grid — 164ms spikes eliminated, 100% 60fps |
| F-039 | ✅ Fixed | Dead FILL/16:9 toggle removed (display always fits) |
| F-040 | ✅ Documented | Docs drift — 9 days of shipped work missing from docs |

Full list: FINDINGS.md (F-001 → F-040).

---

## Risks & Unknowns

| Risk | Impact | Mitigation |
|------|--------|------------|
| Go WASM GC pauses on large characters | Frame drops | Tuned (GOGC=off + safety-net GC); F-038 spatial grid |
| jsDelivr rate limiting / caching issues | Download failures | Fallback to raw GitHub; cache-buster bump `.r2` (see character-downloader.ts) |
| Vercel WASM MIME type misconfiguration | Black screen | vercel.json pins `application/wasm`; tested |
| Mobile WebGL2 performance | Sub-60fps | Display ladder + fitted modes; Game Boy portrait mode |
| Some characters incompatible with IKEMEN GO | Crashes | Far more compatible than Dolmexica; log in FINDINGS.md |
| Relay free-tier limits (Cloudflare WS wall-clock) | Queue/room 503s | Rooms expire 30min; ranked queue is bucketed; can move to paid tier |
| Arena stub + rollback memory management | Online desync under pressure | Watch Phase 4 field reports; revisit if reproducible |
