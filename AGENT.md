# AGENT.md — Project Context for AI Agents

This file contains everything needed to continue working on FightingGameEngine-Web without prior conversation context. Read this first.

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

**Goal**: Build a browser-based MUGEN fighting game platform using IKEMEN GO v2 compiled to WebAssembly, deployed on Vercel, with characters/stages served from a separate GitHub repo via jsDelivr CDN.

**This repo** (`Nawaf-AlHussain/FightingGameEngine-Web`): Engine + frontend, deployed to Vercel.
**Assets repo** (`FightingGameEngine/Assets` on GitHub): 85+ characters, 5+ stages, served via `cdn.jsdelivr.net/gh/FightingGameEngine/Assets@main/`.

This is the **successor** to the older `FightingGameEngine` repo which used the Dolmexica Infinite C++ engine and had fundamental MUGEN compatibility issues.

---

## Architecture

```
FightingGameEngine-Web (this repo, Vercel)    FightingGameEngine/Assets (GitHub)
  Next.js 16 App Router                         manifest.json (v2, per-file listings)
  /lobby → title screen                         characters/ (85+, mostly DBZ)
  /local → React character select                stages/
  /play?p1=..&p2=.. → engine (fight only)       Accessed via jsDelivr CDN
  /api/ikemen-fs/manifest → VFS manifest
  /api/ikemen-fs/file/[path] → VFS files
  public/game/ikemen.wasm (22MB engine)
  public/game/vfs.js (800-line virtual FS)
  public/game/wasm_exec.js (Go WASM runtime)
```

### Page Flow (CRITICAL — this is the core architecture)

```
/lobby  →  PRESS START
  ↓
/local  →  Select mode (VS CPU / VS Player / Training)
          Select P1 character, P2 character, stage, AI level
          Click FIGHT
  ↓
/play?p1=kfm&p2=kfm&stage=stages/stage0-720.def&p2ai=5
          → Engine boots with CLI args (-p1, -p2, -loadmotif, -stage)
          → IKEMEN's main.f_commandLine() skips ALL menus
          → Goes directly into the fight
          → After fight ends (os.exit), redirects back to /local
```

**Key principle**: The engine NEVER renders menus. The website (React) handles ALL UI. The WASM engine is loaded only during fights and boots directly into combat.

This matches the FightingGameEngine-Demo2 architecture pattern ("website UI + engine as renderer").

### How the Engine Loads (updated)

1. User clicks FIGHT on `/local` → navigates to `/play?p1=kfm&p2=kfm&stage=...`
2. `src/app/play/page.tsx` reads URL params and builds CLI arg array
3. Installs keyboard bridge (`window.__ikemenKeyDown` / `__ikemenKeyUp` arrays)
4. Pins `devicePixelRatio` to 1 (glfw-js requirement)
5. Patches `window.fetch` so VFS requests redirect to `/api/ikemen-fs/file/...`
6. Dynamically loads `/game/vfs.js` then `/game/wasm_exec.js`
7. Initializes VFS with manifest and preload list
8. Creates `Go` instance with `go.argv = ['ikemen', '-p1', p1, '-p2', p2, '-loadmotif', 'data/ikemen1/system.def', '-stage', stage, '-p2.ai', aiLevel]`
9. Loads WASM via `instantiateStreaming`, calls `go.run()`
10. Engine's `main.lua` detects CLI args → calls `main.f_commandLine()` → skips menus → fight starts
11. After fight, `os.exit()` is caught → redirects to `/local`

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

### How Keyboard Input Works (Poll-Based Bridge)

Go WASM's `syscall/js` event callback pipeline (`js.FuncOf` → `_makeFuncWrapper` → `_pendingEvent` → `_resume()`) **does not work** for keyboard events (F-011). The JS→Go callback direction is broken in WASM.

**Workaround**: Poll-based bridge.
1. JS captures `keydown`/`keyup` on `window` (capture phase)
2. Pushes `e.code` values (e.g. `"KeyW"`, `"Digit1"`, `"ArrowUp"`) into `window.__ikemenKeyDown` / `window.__ikemenKeyUp` arrays
3. Go's `pollEvents()` in `system_js.go` reads these arrays every frame
4. Looks up `e.code` in `jsCodeToKey` map → gets internal Key enum → calls `OnKeyPressed()`

**Key naming convention** (F-016):
- Letters: lowercase (`w`, `a`, `s`, `d`, `u`, `i`, `o`, `j`, `k`, `l`)
- Arrows: uppercase (`UP`, `DOWN`, `LEFT`, `RIGHT`)
- Numpad: `KP_` prefix (`KP_1`, `KP_7`)
- Special: `RETURN`, `ESCAPE`, `SPACE`, `1`-`9` (digits)

**Config.ini maps key names to commands** (see `public/game/ikemen-fs/file/save/config.ini`):
- P1: WASD move, UIO punches, JKL kicks, 1 = Start
- P2: Arrow keys move, Numpad 1-6 attacks, Numpad 7 = Start

**Status**: Only the `1` key (Start) has been verified working through the full path. Fight inputs (WASD, UIO, JKL) are theoretically correct but **untested in actual combat** (the engine was stuck in menus during previous testing sessions).

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
| `src/app/lobby/page.tsx` | Title screen. "PRESS START" → navigates to `/local` |
| `src/app/local/page.tsx` | **Character select screen** (pure React). Mode select, P1/P2 slots, AI level, stage select, FIGHT button |
| `src/app/play/page.tsx` | **Fight page**. Reads URL params, boots WASM with CLI args, keyboard bridge, auto-redirects to `/local` after fight |
| `public/game/ikemen.wasm` | IKEMEN GO v2 engine compiled to WASM (22MB). Built from source (see Build Section) |
| `public/game/vfs.js` | Browser filesystem shim (800+ lines). Replaces `syscall/fs_js.go` with HTTP-backed VFS. From WebMUGEN kit v1.7 |
| `public/game/wasm_exec.js` | Go's official WASM JavaScript runtime. From WebMUGEN kit |
| `public/game/ikemen-fs/file/save/config.ini` | Engine config: video 1280x720, P1/P2 key bindings, audio, debug settings |
| `public/game/ikemen-fs/file/data/select.def` | Character roster definition. Currently: `kfm` + `randomselect` |
| `public/game/ikemen-fs/file/external/script/main.lua` | IKEMEN's main Lua script. Contains `main.f_commandLine()` menu skip path (line 4061) |
| `public/game/ikemen-fs/file/data/ikemen1/` | Screenpack: `system.def`, `system.sff` (9.1MB sprites), `system.snd` (3.6MB sounds), fonts |
| `public/game/ikemen-fs/file/chars/kfm/` | Kung Fu Man character (11 files: .def, .cns, .cmd, .air, .sff, .snd, etc) |
| `public/game/ikemen-fs/file/stages/stage0-720/` | One stage (.def + .sff) |
| `public/game/ikemen-fs/manifest.json` | VFS manifest (generated by `scripts/generate-manifest.js`) |
| `src/app/api/ikemen-fs/manifest/route.ts` | API route serving VFS manifest |
| `src/app/api/ikemen-fs/file/[...path]/route.ts` | API route serving VFS files (path-traversal-safe) |
| `vercel.json` | WASM MIME type + no-cache headers |
| `TODO.md` | Phased task list (Phase 0-5). Authoritative task list |
| `PROGRESS.md` | What's done, current status, next steps |
| `FINDINGS.md` | Technical discoveries F-001 through F-017 |

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
- **Original URL pattern**: `./ikemen-fs/file/<vpath>` (relative)
- **Patched pattern**: `/api/ikemen-fs/file/<vpath>` (via `window.fetch` patch in play page)
- **Manifest served at**: `/api/ikemen-fs/manifest`

### For Phase 2 (CDN assets):
The file API route will need to check locally first, then proxy to jsDelivr CDN for character/stage files not in the VFS.

---

## Current State

### What works:
- [x] Engine boots and renders (title screen, menus, fights all render)
- [x] Auto-fight (attract mode) runs at smooth 60 FPS
- [x] Menu skip via CLI args (`-p1`, `-p2`, `-loadmotif`) — goes directly to fight
- [x] React character select screen (mode, P1/P2, stage, AI level)
- [x] Full page flow: /lobby → /local → /play → fight → back to /local
- [x] Poll-based keyboard bridge (JS→Go direction works)
- [x] `1` key (Start) verified working through full input path
- [x] VFS serves all engine data files correctly
- [x] Deployed on Vercel

### What's NOT working / untested:
- [ ] **Fight input (WASD, UIO, JKL) untested in actual combat** — only Start key verified
- [ ] Engine canvas may not fill viewport properly
- [ ] Escape key opens native IKEMEN pause menu during fight
- [ ] Only 1 character (KFM) and 1 stage available
- [ ] No sound effects or music in the web UI
- [ ] No touch controls for mobile

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

---

## Next Steps (from TODO.md)

### Immediate:
1. **Test fight with CLI args on Vercel** — verify engine boots directly into KFM vs KFM fight
2. **Test fight input** — verify WASD, UIO, JKL work during actual gameplay
3. **Disable native pause menu** — set `EscOpensMenu=0` in config.ini or intercept Escape
4. **Add Escape to quit fight** — navigate back to /local

### Phase 1 remaining:
1. AI vs AI (watch mode)
2. Persona 5 UI polish (WipeTransition, FightOverlays, game.css from Demo repo)
3. Touch controls for mobile
4. Character portraits on select screen

### Phase 2 (Asset Pipeline):
1. Point VFS file route to jsDelivr CDN for character/stage files
2. Character download & caching system
3. Fix case-sensitivity in Assets manifest

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
4. **Don't forget the fetch patch** — vfs.js uses relative `./ikemen-fs/` URLs that won't resolve from `/play`
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
- **Primary repo**: `Nawaf-AlHussain/FightingGameEngine-Web`
- **Assets org**: `FightingGameEngine`
- **PAT**: Stored securely by the user. Request it when needed.
