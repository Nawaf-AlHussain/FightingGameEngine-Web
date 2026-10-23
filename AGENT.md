# AGENT.md — Project Context for AI Agents

This file contains everything needed to continue working on OpenFighter (the FightingGameEngine-Demo web project) without prior conversation context. Read this first.

---

## Working on This Project (MANDATORY WORKFLOW)

Every agent working on this project **must** follow this workflow. No exceptions.

### 1. Before Starting Work

- Read this file (AGENT.md) in full — it contains architecture, build process, pitfalls, and all context.
- Read `TODO.md` — this is the authoritative task list. Pick the next uncompleted task.
- Read `PROGRESS.md` — understand what's been done and what state the project is in.
- Read `FINDINGS.md` — check if someone already discovered what you're about to investigate.
- If the task requires understanding the old projects, look at `FightingGameEngine` (Dolmexica, what failed) and `FightingGameEngine-Demo` (UI components to reuse).

### 2. During Work

- **Document everything** as it happens. Don't wait until the end.
- If you discover something unexpected (a bug, a compatibility issue, a better approach), add it to `FINDINGS.md` immediately with a new F-number (increment from the last one).
- If you make a mistake, document it in `FINDINGS.md` — the whole point is that future agents learn from it.
- If something works better than expected, document it in `FINDINGS.md` as a breakthrough.

### 3. After Every Work Session (MANDATORY)

Before finishing, you **must** update all three docs:

**TODO.md**:
- Mark completed tasks as `[x]`
- Add any new tasks discovered during work
- Update task descriptions if scope changed
- Re-estimate or reorder if needed

**PROGRESS.md**:
- Add a new session entry with today's date
- List concrete work done (files created/modified, features implemented, bugs fixed)
- Update the "Current Status" and "Next Steps" sections
- Record any key decisions made

**FINDINGS.md**:
- Add entries for any discoveries, mistakes, or breakthroughs using the format:
  ```
  ## F-00N | Short Title
   **Date**: YYYY-MM-DD | **Type**: Finding / Mistake / Breakthrough

   Description of what happened, why it matters, and what to do about it.

   **Lesson**: One-line takeaway for future agents.
  ```
- Each entry gets a unique `F-00N` number (incrementing)

### 4. Commit and Push

After updating docs, commit with a clear message describing what was done. Push to `main`.

### 5. Communication

When reporting back to the user, be concise. Do NOT:
- Re-list every file created (the git commit already shows this)
- Re-explain what AGENT.md already covers
- Summarize the docs — the user can read them

Do:
- State what was accomplished (1-2 sentences)
- State what's broken or needs attention
- Suggest the next actionable step

---

## Project Overview

**Goal**: Build a browser-based MUGEN fighting game platform using IKEMEN GO v2 compiled to WebAssembly, deployed on Vercel, with characters/stages served from a separate GitHub repo via CDN proxies, and online play over WebRTC P2P.

**Active dev repo** (`Nawaf-AlHussain/FightingGameEngine-Demo`, THIS repo): engine + frontend.
**Mirror repo** (`Nawaf-AlHussain/FightingGameEngine-Web`): byte-identical mirror — same commit history, pushed in lockstep (same HEAD sha at all times).
**Production assets** (`FightingGameEngine/Assets` on GitHub): 87 characters, 5+ stages — the DEFAULT roster source (`DEFAULT_ASSETS_REPO` in both API routes).
**Demo assets mirror** (`FightingGameEngine/DemoAssets`): curated roster the DEMO Vercel deployment reads via the `ASSETS_GH_REPO` env switch; synced from production by `scripts/sync-demo-assets.py`.

This is the **successor** to the older `FightingGameEngine` repo which used the Dolmexica Infinite C++ engine and had fundamental MUGEN compatibility issues.

---

## Architecture

```
FightingGameEngine-Demo (this repo, Vercel)   FightingGameEngine/Assets (GitHub)
  Next.js 16 App Router                         manifest.json (v2, per-file listings)
  /lobby → title screen                         characters/ (87, mostly DBZ)
  /mode-select → /group-select → /local         stages/
  /match-prep → /play (fight only)              DEFAULT roster source
  /play?net=1 → online flow                     via /api/cdn + /api/assets-manifest
  public/game/engine.wasm (22MB) + .gz (5.1MB)  FightingGameEngine/DemoAssets
  public/game/engine-fs/file/* → static VFS     (demo mirror roster, ASSETS_GH_REPO)
  public/game/engine-fs/game.pak (3.6MB bundle)
  public/game/vfs.js (virtual FS)  wasm_exec.js  webrtc.js (netplay bridge)
  netrelay/cloudflare/worker.js → Cloudflare Worker (signaling + ranked queue)
```

### Page Flow (CRITICAL — this is the core architecture)

```
LOCAL:
/lobby  →  PRESS START (menu: LOCAL / ONLINE / ABOUT; +INSTALL when offered.
                SETTINGS disabled for showcase F-041 — /settings redirects here)
  ↓
/mode-select?—  ISSUE 01: game mode + difficulty
  ↓
/group-select?mode=&diff=  —  ISSUE 02: universe (character group)
  ↓
/local?mode=&diff=  —  ISSUE 03: roster (P1/P2 picks, AI level)
  ↓
stage select  —  ISSUE 04: battleground
  ↓
/match-prep  —  real asset readiness check + countdown
  ↓
/play?p1=..&p2=..&stage=..&mode=..
          → Engine boots with quick-match args (-qp1, -qp2, -qstage, ...)
          → IKEMEN's quick-match path skips ALL menus, straight into the fight
          → After the fight: /results?result=..&mode=..&wins=..&losses=..&time=..
          NOTE clean-URL: /play backs the query up to sessionStorage and strips
          it from the address bar once captured (F5 / RETRY restore the same
          matchup from the backup; hand-typed /play still errors). Net URLs
          (?net=1 / ?net=direct) are never stripped — they are the room link.

ONLINE:
/lobby → /play?net=1  —  ISSUE 05 NETWORK panel (host / join code + QR /
          ranked queue). Select screens run shared with live spectate
          cursors synced over the WebRTC bridge; the engine boots into
          the fight, then the postfight panel offers rematch in place.
```

**Key principle**: The engine NEVER renders menus. The website (React) handles ALL UI. The WASM engine is loaded only during fights and boots directly into combat.

This matches the FightingGameEngine-Demo2 architecture pattern ("website UI + engine as renderer").

### How the Engine Loads (updated)

1. User clicks FIGHT on `/match-prep` (after the readiness countdown) → `/play?...`
2. `src/app/play/page.tsx` reads URL params and resolves the asset lists
3. Fetches the assets manifest MANDATORILY and computes the roster
   fingerprint (`setRosterFingerprint` in `character-downloader.ts`) —
   netplay mixes it into the bridge build check
4. Installs keyboard `preventDefault` handler on `window` (stops browser shortcuts; engine listens for native keydown/keyup on `document` directly — no poll-based bridge)
5. Pins `devicePixelRatio` to 1 (glfw-js requirement)
6. Patches `window.fetch` so VFS requests resolve to `/game/engine-fs/file/...` (static assets) and the CDN proxy for roster files
7. Dynamically loads `/game/vfs.js` then `/game/wasm_exec.js`; gz engine
   boot uses `boot-decompress.ts` (DecompressionStream worker, cache-first)
8. Initializes VFS with manifest and preload list
9. `vfs.js` calls `restorePersisted()` which loads the persisted config
   (localStorage `engine-vfs12:save/config.ini` — the Settings UI's
   authoritative config). VFS does NOT overwrite display-mode choices —
   the Settings UI / display ladder is the single source of truth.
10. Creates `Go` instance with `go.argv = ['ikemen', '-qp1', p1Path, '-qp2', p2Path, '-qstage', stagePath, '-qp2ai', ai, '-qmode', mode, ...]` (quick-match flags, bypasses laggy menu) — argv is set AFTER CDN downloads, with resolved paths
11. Loads WASM via `instantiateStreaming`, calls `go.run()`
12. Engine's quick-match path skips menus → fight starts
13. After the fight: `/results?result=..&mode=..&wins=..&losses=..&time=..` (local) or the postfight rematch panel (online)

### How Menu Skipping Works (F-017, BREAKTHROUGH)

IKEMEN GO's `main.lua` (line 4061) has a built-in command-line quick match:

```lua
if getCommandLineValue("-p1") ~= nil
   and getCommandLineValue("-p2") ~= nil
   and getCommandLineValue("-loadmotif") ~= nil then
  main.f_commandLine()  -- Skips title, char select, VS screen
end
```

We pass these via `go.argv` in `wasm_exec.js`. **No WASM recompilation needed** — the 22MB binary already supports this.

Supported flags: `-p1 <char>`, `-p2 <char>`, `-loadmotif <def>`, `-stage <def>`, `-p1.ai <1-8>`, `-p2.ai <1-8>`, `-r <rounds>`, `-time <seconds>`, `-tmode1 <mode>`, `-tmode2 <mode>`.

### How Keyboard Input Works (Native DOM Events)

The IKEMEN GO WASM engine listens for **native `keydown`/`keyup` DOM events** on `document` (via `system_js.go`'s `newWindow()` function, which calls `doc.Call("addEventListener", "keydown", keydown)`). The handler reads `ev.Get("code").String()`, looks it up in `jsCodeToKey` (maps `"KeyW"` → `keyW`, `"Digit8"` → `key8`, etc.), and calls `OnKeyPressed()`/`OnKeyReleased()`.

**The old `__ikemenKeyDown`/`__ikemenKeyUp` poll-based bridge is dead code.** It was an earlier workaround for a Go WASM callback issue that turned out to be misdiagnosed. The engine never read those arrays — it uses native DOM events directly. The dead code has been removed from `play/page.tsx`.

**Touch input** dispatches synthetic `KeyboardEvent`s on `document` with the correct `code` property. The engine's own listener picks them up exactly like real keyboard events. TouchControls reads the P1 key bindings from `localStorage['ikemen-vfs12:save/config.ini']` (the same source the Settings UI writes to) — no separate hardcoded KEY_MAP.

**Key naming convention** (config.ini [Keys_P1] / [Keys_P2]):
- Letters: lowercase (`w`, `a`, `s`, `d`, `u`, `i`, `o`, `j`, `k`, `l`)
- Digits: the digit itself (`0`-`9`)
- Arrows: uppercase (`UP`, `DOWN`, `LEFT`, `RIGHT`)
- Punctuation: uppercase names (`COMMA`, `PERIOD`, `SLASH`, etc.)
- Numpad: `KP_` prefix (`KP_1`, `KP_7`)
- Special: `RETURN`, `ESCAPE`, `SPACE`

**Config.ini maps key names to commands** (see `public/game/ikemen-fs/file/save/config.ini`):
- P1: WASD move, 8/9/0 punches, I/O/P kicks, U = Start
- P2: Arrow keys move, J/K/L punches, M/,/.  kicks, / = Start

**Status**: All P1 keys verified working through the full path (physical keyboard + touch controls + key remapping via Settings UI).

### Critical Performance Settings

```javascript
go.env = { GOGC: '100', GOMEMLIMIT: '800MiB' };
```
- `GOGC: '100'` is Go's default. Values of 200 and 500 both cause **noticeable frame freezes**. Do not increase.
- `GOMEMLIMIT: '800MiB'` prevents heap from ballooning with large character rosters.
- WebGL2 with `failIfMajorPerformanceCaveat: true` detects software rendering.
- `devicePixelRatio` must be pinned to 1 (glfw-js expectation).

---

## Key Files

### This Repo

| File | Purpose |
|------|---------|
| `src/app/lobby/page.tsx` | Title screen (Squadron Comic poster). Menu → /mode-select, /play?net=1, /about (+ /settings, disabled for showcase F-041) |
| `src/app/mode-select/page.tsx` | ISSUE 01 — game mode + difficulty (local flow stop 1) |
| `src/app/group-select/page.tsx` | ISSUE 02 — universe/group select (local flow stop 2) |
| `src/app/local/page.tsx` | ISSUE 03 — roster screen (pure React): P1/P2 picks, AI level, then stage select |
| `src/app/match-prep/page.tsx` | Real asset readiness check + countdown before the fight |
| `src/app/play/page.tsx` | **Fight page** (~3000 lines): boots WASM with quick-match args, netplay lifecycle (connecting → groupselect → charselect → stageselect → waiting → fight → postfight), rematch-in-place, disconnect handling |
| `public/game/engine.wasm` / `engine.wasm.gz` | IKEMEN GO v2 engine (22MB raw / 5.1MB gz). Built from source (see Build Section) |
| `public/game/vfs.js` | Browser filesystem shim. Replaces `syscall/fs_js.go` with HTTP-backed VFS; also implements the display-ladder stage fits |
| `public/game/wasm_exec.js` | Go's official WASM JavaScript runtime. From WebMUGEN kit |
| `public/game/webrtc.js` | Netplay bridge: P2P data channels, room codes, ranked queue, build check + roster fingerprint, IKWS frames (cursor/char/stage/go/netping/rematch/back/leave) |
| `public/game/engine-fs/file/save/config.ini` | Shipped engine config: video, P1/P2 key bindings, audio, debug settings |
| `public/game/engine-fs/manifest.json` | VFS manifest (generated by `scripts/generate-manifest.js`) |
| `public/game/engine-fs/game.pak` (+`.gz`) | Bundled engine data for fast boot (F-029) |
| `public/game/netrelay-url.txt` | Production signaling relay URL (Cloudflare Worker) |
| `src/lib/engine-config.ts` | Config storage keys, display-mode ladder presets (TALL/FITTED/3:2/14:9/5:3/EXPANDED), config apply logic |
| `src/lib/character-downloader.ts` | CDN roster fetch, IndexedDB download, roster fingerprint (cyrb64) for netplay |
| `src/lib/game-modes.ts` | Progression state machine + MODE_LABELS / MODE_RULES |
| `vercel.json` | WASM MIME type + cache headers |
| `netrelay/cloudflare/worker.js` | Signaling relay + ranked queue (Cloudflare Workers); `netrelay/relay.ts` is the Deno dev version |
| `src/app/api/cdn/[...path]/route.ts` | GitHub-raw CDN proxy — `ASSETS_GH_REPO` env switch (default `FightingGameEngine/Assets`) |
| `src/app/api/assets-manifest/route.ts` | Assets roster manifest proxy — same repo switch |
| `scripts/sync-demo-assets.py` | Mirrors production Assets content into DemoAssets |
| `TODO.md` | Phased task list (Phase 0-5). Authoritative task list |
| `PROGRESS.md` | What's done, current status, next steps |
| `FINDINGS.md` | Technical discoveries F-001 through F-040 |

### Go Source (NOT in repo, local only)

| File | Location | Purpose |
|------|----------|---------|
| `system_js.go` | `/tmp/ikemen-go-web/src/` | WASM window/backend. Contains `pollEvents()` with keyboard bridge and gamepad polling |
| `input_js.go` | `/tmp/ikemen-go-web/src/` | `jsCodeToKey` map (KeyboardEvent.code → Key enum), `KeyToStringLUT`, `StringToKeyLUT`, gamepad handling |
| `main.go` | `/tmp/ikemen-go-web/src/` | Entry point. `processCommandLine()` parses -p1, -p2, -loadmotif, etc. into `sys.cmdFlags` |

### External Repos

| Repo | Access | Purpose |
|------|--------|---------|
| `FightingGameEngine/Assets` | Public org repo | Character/stage library. 85+ chars (mostly DBZ), 5+ stages |
| `Nawaf-AlHussain/FightingGameEngine` | Private | Old engine (Dolmexica). Reference for what DIDN'T work |
| `Nawaf-AlHussain/FightingGameEngine-Demo` | Private | Persona 5 UI components: WipeTransition, FightOverlays, MoveListPopup, useSoundEffects, game.css |
| `Nawaf-AlHussain/FightingGameEngine-Demo2` | Public | Full reference architecture: React UI + engine only for fights. Has hooks (use-local-two-player, use-fight-state), lib (wasm-loader, wasm-asset-injector), components (CharacterSelect, StageSelect, TouchControls, GameCanvas) |
| `energyjp/ikemen-go-web` | Public | IKEMEN GO fork with WASM support. Source of our WASM build and JS-specific Go files |
| `ikemen-engine/Ikemen-GO` | Public | Upstream IKEMEN GO. No WASM support (that's energyjp's fork) |

---

## WASM Build Process

The WASM binary was built from source because no pre-built WASM release exists.

### Build Steps (reproducible)

```bash
# 1. Install Go 1.21 (NOT 1.22+ — see Arena Issue)
# Go 1.23: runtime mbitmap redeclaration errors
# Go 1.22: arena constraint issues
# Go 1.21: ONLY version that builds cleanly

# 2. Clone the WASM-enabled fork
git clone https://github.com/energyjp/ikemen-go-web.git
cd ikemen-go-web

# 3. Create arena stub (standard library arena excludes GOOS=js)
mkdir arena
cat > arena/arena.go << 'EOF'
package arena
type Arena struct{}
func New[T any](a *Arena) *T { return new(T) }
func MakeSlice[T any](a *Arena, len, cap int) []T { return make([]T, len, cap) }
func (a *Arena) Free() {}
func NewArena() *Arena { return &Arena{} }
EOF

# 4. Replace standard library arena imports with our stub
sed -i 's|"arena"|"github.com/ikemen-engine/Ikemen-GO/arena"|' \
  src/system.go src/state_clone.go src/state.go src/rollback.go

# 5. Build
GOOS=js GOARCH=wasm go build -o ikemen.wasm ./src/
# Output: ~22MB
```

**NOTE**: The current WASM binary already includes the poll-based keyboard bridge and all necessary JS platform code. You do NOT need to rebuild unless you need to modify Go source code.

### Arena Issue

The upstream engine uses Go 1.20+ experimental `arena` package for rollback netcode. It's excluded from `GOOS=js` in all Go versions. Our stub uses regular heap allocation. Fine for local play (Phase 1-3), may need revisiting for rollback netcode (Phase 4).

---

## VFS (Virtual Filesystem)

`vfs.js` shims Go's `syscall/fs_js.go` with HTTP-backed file access.

- **Format**: Per-file manifest (`{ files: { "path": size, ... } }`)
- **URL pattern**: `/game/engine-fs/file/<vpath>` (static edge-cached assets; the old `/api/ikemen-fs/*` serverless routes were removed)
- **Manifest served at**: `/game/engine-fs/manifest.json` (static)
- **Writes**: `save/*` paths persist to localStorage (config.ini, key remaps, stats)
- **Display ladder**: vfs.js implements the stage-view fits (TALL/FITTED/3:2/14:9/5:3/EXPANDED markers from `DISPLAY_MODE_STORAGE_KEY`)

### CDN assets:
Character/stage files come from `/api/cdn/<path>` (GitHub-raw proxy with
`ASSETS_GH_REPO` switch) and are cached in IndexedDB
(`character-cache.ts` + `character-downloader.ts`, transactional).

---

## Current State (October 24, 2026)

### What works:
- [x] Local play end to end: mode → universe → roster → stage → fight → results, all 7 modes
- [x] 100% 60fps for ALL characters incl. heavy DBZ with specials (F-038)
- [x] No mid-round GC pauses (GOGC=off + safety-net GC every 60s, F-033)
- [x] IndexedDB asset caching — download once, instant on repeat (F-037)
- [x] Online play: rooms, QR join, ranked queue, rematch-in-place,
      spectate cursors, RTT pill, disconnect hardening (see TODO Phase 4)
- [x] Display ladder: TALL 4:3 / FITTED / 3:2 / 14:9 / 5:3 / EXPANDED +
      stage zoom + portrait Game Boy mode
- [x] PWA install, touch controls, keyboard remapping, 9-tab settings
- [x] Demo asset mirror (ASSETS_GH_REPO → FightingGameEngine/DemoAssets)

### Known gaps (see TODO.md for the authoritative list):
- [ ] Phase 5 device/browser matrix untested (needs real hardware)
- [ ] Online remainders: full match spectating, ladder persistence,
      mid-fight desync detection

### Key insight (F-026, still true):
The engine's fight rendering path is optimized but the menu rendering path is NOT. The site renders ALL UI; the engine only ever runs the smooth quick-match/fight path.

---

## Key Findings Summary (from FINDINGS.md)

| ID | Type | Summary |
|----|------|---------|
| F-001 | Finding | Go WASM 60 FPS IS achievable (WebMUGEN proves it) |
| F-002 | Finding | Community WASM forks (tursom, yasyzb) are dead |
| F-003 | Finding | WebMUGEN IS IKEMEN GO v2, not a new engine |
| F-004 | Finding | Dolmexica has fundamental MUGEN compat limits (63+ patches couldn't fix) |
| F-005 | Finding | Demo repo has Persona 5 UI components to reuse |
| F-006 | Finding | Assets repo has case-sensitivity issues (causes 404s on jsDelivr) |
| F-007 | Finding | Go `arena` package unavailable for GOOS=js (created stub) |
| F-008 | Finding | Go 1.22+ breaks WASM builds (must use 1.21) |
| F-009 | Mistake | Assumed WebMUGEN kit shipped the WASM binary (it doesn't) |
| F-010 | Finding | vfs.js relative URLs break from Next.js routes (fixed with fetch patching) |
| F-011 | Finding | Go WASM syscall/js event callbacks broken for keyboard (JS→Go fails) |
| F-012 | Finding | Poll bridge only "1" key works — other keys untested in fight context |
| F-013 | Breakthrough | Demo2 architecture (React UI + engine only for fights) is the target pattern |
| F-014 | Finding | IKEMEN menus lag in WASM but fights are 60fps (bypass menus entirely) |
| F-015 | Mistake | uint8_t overflow in Dolmexica caused 3 wasted fix attempts (lesson for data path verification) |
| F-016 | Finding | Key naming: lowercase letters, uppercase arrows, KP_ prefix for numpad |
| **F-017** | **Breakthrough** | **IKEMEN GO has built-in CLI quick match — no WASM changes needed to skip menus** |
| F-018 | Finding | BootLoadingMode=0 freezes WASM main thread (sync asset loading) — fixed with BootLoadingMode=1 |
| F-019 | ❌ Wrong | RollbackNetcode was already 0 via VFS patch (F-020) |
| F-020 | Finding | VFS patches RollbackNetcode at boot — config.ini value is ignored |
| F-021 | Finding | Manifest generator overwrote real file sizes with 0 — fixed |
| F-022 | ❌ Not root cause | while-loading loop removed but freeze persisted |
| F-023 | Finding | vfs.js Promise cache storm — fixed with catch handler + manifest delete |
| F-024 | Finding | Frame-skip tight loop blocks browser — fixed with time.Sleep(0) in WASM |
| F-025 | Breakthrough | WASM rebuilt with GOEXPERIMENT=arenas + frame-skip yield + loader Gosched |
| **F-026** | **Finding** | **Menu freezes after a few seconds — GC pressure from unoptimized menu rendering** |
| F-038 | Breakthrough | Spatial grid broad-phase — 164ms spikes eliminated, 100% 60fps |
| F-039 | Fixed | Dead FILL/16:9 toggle removed — display always aspect-fits |
| F-040 | Mistake | Docs drift — 15 commits shipped without session entries; TODO said "Phase 4 NOT STARTED" for live features |

---

## Next Steps (from TODO.md)

### Online remainders (Phase 4 tail):
1. Full match spectating (rollback supports it; today only select screens are spectated)
2. Ranked ladder persistence (server-side W/L records)
3. Mid-fight desync detection (beyond the handshake build/roster refusal)

### Minor fixes:
1. Move list display + site UI sound effects (Phase 3 tails)

(Done 2026-10-24: EscOpensMenu=0 shipped default; F-006 manifest casing
fixed in the Assets repo — commit 2f3da1c there, engine-invisible.)

### Phase 5 (needs real hardware):
1. Character/stage compat matrix, browser matrix, mobile testing, profiling

---

## Design Direction

When building UI, follow the FightingGameEngine-Demo design system:
- **Palette**: Black (#0a0a0a), Red (#e53e3e), White (#ffffff), Cyan (#06b6d4)
- **Typography**: Oswald for headings, clean sans-serif for body
- **Shapes**: Angular clip-paths (diagonal cuts, not rounded corners)
- **Transitions**: 3-pane diagonal color wipe (720ms)
- **Style reference**: Persona 5 UI aesthetic

Current UI (lobby, local) uses a simpler dark theme with red accents. Upgrade to P5 style in Phase 3.

---

## Tools & Dependencies

- **Runtime**: Node.js v24, npm
- **Framework**: Next.js 16, React 19, TypeScript 7
- **Styling**: Tailwind CSS 4
- **Engine**: IKEMEN GO v2 (WASM), built with Go 1.21
- **Hosting**: Vercel
- **CDN**: jsDelivr (for Phase 2 assets)
- **Go SDK**: `~/go-sdk/` (Go 1.21.13, user-installed)
- **WebMUGEN kit**: `/home/z/my-project/webmugen/` (local only, not in repo)
- **energyjp source**: `/tmp/ikemen-go-web/` (local only, not in repo)

---

## Common Pitfalls

1. **Don't use Go 1.22+ for WASM builds** — runtime conflicts with arena on GOOS=js
2. **Don't change GOGC from 100** — causes frame freezes at higher values
3. **Don't serve .wasm without `application/wasm` MIME type** — browser won't streaming-compile
4. **Don't forget the fetch patch** — vfs.js uses relative `./engine-fs/` URLs that won't resolve from `/play`
5. **Don't put character/stage data in this repo** — assets come from CDN (Phase 2)
6. **Don't try to use the engine's native menus** — they lag and input is broken. Use React UI + CLI args instead
7. **Don't use `syscall/js` event callbacks for input** — JS→Go direction is broken (F-011). Use the poll bridge
8. **Don't use SDL-style key names in config.ini** — WASM backend uses lowercase letters (`w` not `W`), uppercase arrows (`UP` not `Up`), `KP_` prefix (`KP_1` not `Num1`)
9. **Don't rebuild the WASM unless you must** — the current binary already supports CLI quick match, poll bridge, and all needed features
10. **Do check FINDINGS.md before making decisions** — 17 findings documented
11. **Do validate case-sensitivity** of Assets manifest filenames before CDN integration
12. **Do test on actual Vercel deployment** — some issues only appear in production

---

## GitHub Access

- **User**: `Nawaf-AlHussain`
- **Active dev repo**: `Nawaf-AlHussain/FightingGameEngine-Demo` (THIS repo — push here first)
- **Mirror repo**: `Nawaf-AlHussain/FightingGameEngine-Web` (byte-identical; keep in lockstep — after pushing Demo, push the same commit(s) to Web)
- **Production assets org**: `FightingGameEngine` (`Assets` = production roster, `DemoAssets` = demo mirror)
- **PAT**: Stored securely by the user. Request it when needed.
