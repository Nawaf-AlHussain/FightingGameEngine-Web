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
  /play → WASM engine loader                    characters/ (85+, mostly DBZ)
  /api/ikemen-fs/manifest → VFS manifest        stages/
  /api/ikemen-fs/file/[path] → VFS files        Accessed via jsDelivr CDN
  public/game/ikemen.wasm (22MB engine)
  public/game/vfs.js (800-line virtual FS)
  public/game/wasm_exec.js (Go WASM runtime)
```

### How the Engine Loads

1. User visits `/play`
2. `src/app/play/page.tsx` dynamically loads `/game/vfs.js` then `/game/wasm_exec.js`
3. It patches `window.fetch` so VFS requests (`./ikemen-fs/file/...`) redirect to `/api/ikemen-fs/file/...`
4. `ikemenVfsInit()` fetches the manifest from `/api/ikemen-fs/manifest`, then lazy-loads files
5. The WASM binary (`/game/ikemen.wasm`) is loaded via `instantiateStreaming`
6. Go runtime starts, calls VFS to read files, renders to canvas via WebGL2

### Critical Performance Settings

From WebMUGEN kit (measured and documented):
```javascript
go.env = { GOGC: '100', GOMEMLIMIT: '800MiB' };
```
- `GOGC: '100'` is Go's default. Values of 200 and 500 both cause **noticeable frame freezes**. Do not increase this.
- `GOMEMLIMIT: '800MiB'` prevents the heap from ballooning with large character rosters.
- WebGL2 with `failIfMajorPerformanceCaveat: true` detects software rendering (causes sub-60fps on strong hardware).

---

## Key Files

### This Repo

| File | Purpose |
|------|---------|
| `public/game/ikemen.wasm` | IKEMEN GO v2 engine compiled to WASM (22MB). **Built from source** (see Build Section). |
| `public/game/vfs.js` | Browser filesystem shim for Go's WASM runtime (800+ lines). Replaces `syscall/fs_js.go` with HTTP-backed VFS. **From WebMUGEN kit v1.7.** |
| `public/game/wasm_exec.js` | Go's official WASM JavaScript runtime. **From WebMUGEN kit.** |
| `public/game/sffpal-core.js` | SFF palette processing. **From WebMUGEN kit.** |
| `public/game/webrtc.js` | P2P netcode with rollback. **From WebMUGEN kit. Not yet integrated.** |
| `public/game/ikemen-fs/file/` | Engine data files (Lua scripts, fonts, shaders, ZSS bytecode) from `energyjp/ikemen-go-web` repo. |
| `public/game/ikemen-fs/manifest.json` | Generated by `scripts/generate-manifest.js`. Lists all VFS files with sizes. |
| `src/app/play/page.tsx` | Game page — loads WASM engine with GC tuning, WebGL2 check, fetch-patched VFS. |
| `src/app/api/ikemen-fs/manifest/route.ts` | API route serving the VFS manifest. |
| `src/app/api/ikemen-fs/file/[...path]/route.ts` | API route serving individual VFS files (with path traversal protection). |
| `scripts/generate-manifest.js` | Node script that walks `public/game/ikemen-fs/file/` and generates manifest.json. |
| `vercel.json` | WASM MIME type headers + cache control. |
| `TODO.md` | Phased task list (Phase 0-5). **This is the authoritative task list.** |
| `PROGRESS.md` | What's done, what's next, key decisions. |
| `FINDINGS.md` | Technical discoveries, mistakes, breakthroughs (F-001 through F-006). |

### External Repos

| Repo | Access | Purpose |
|------|--------|---------|
| `FightingGameEngine/Assets` | Public org repo | Character/stage library. `manifest.json` v2 with per-file listings. 85+ chars (mostly DBZ), 5+ stages. |
| `Nawaf-AlHussain/FightingGameEngine` | Private | **Old** engine (Dolmexica Infinite). Reference for what DIDN'T work. 63+ compat patches. |
| `Nawaf-AlHussain/FightingGameEngine-Demo` | Private | Better UI (Persona 5 design). Has reusable components: `WipeTransition.tsx`, `FightOverlays.tsx`, `MoveListPopup.tsx`, `useSoundEffects`, `game.css`. |
| `Nawaf-AlHussain/FightingGameEngine-Demo2` | Public | UI overhaul variant. Reference only. |
| `energyjp/ikemen-go-web` | Public | **IKEMEN GO fork with WASM support.** Source of our WASM build and engine data files. Has JS-specific files: `audio_js.go`, `render_webgl.go`, `input_js.go`, `system_js.go`, `platform_js.go`, `netplay_js.go`, `font_webgl.go`, `util_js.go`. |
| `energyjp/webmugen-modding-kit` (zip) | Not on GitHub | Modding kit v1.7. Source of vfs.js, wasm_exec.js, sffpal-core.js, webrtc.js. Extracted at `/home/z/my-project/webmugen/`. |
| `ikemen-engine/Ikemen-GO` | Public | **Upstream** IKEMEN GO engine. No WASM support (WASM is energyjp's fork). |

---

## WASM Build Process

The WASM binary was built from source because:
1. The official IKEMEN GO releases don't include WASM builds
2. The WebMUGEN modding kit doesn't ship the pre-compiled binary (it's a build tool)
3. The energyjp/ikemen-go-web fork has the WASM platform code but no releases

### Build Steps (reproducible)

```bash
# 1. Install Go 1.21 (NOT 1.22+ — see Arena Issue below)
# Go 1.22+ has runtime conflicts with arena on GOOS=js
# Go 1.21 is the last version that builds cleanly with our arena stub

# 2. Clone the WASM-enabled fork
git clone https://github.com/energyjp/ikemen-go-web.git
cd ikemen-go-web

# 3. Create arena stub (standard library arena package is unavailable for GOOS=js)
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
# Output: ~22MB WebAssembly binary
```

### Arena Issue (IMPORTANT)

The upstream IKEMEN GO recently added `import "arena"` (Go 1.20+ experimental package) for rollback netcode state cloning. This package has `//go:build` constraints that **exclude `GOOS=js`** in all Go versions. Our stub provides `New[T]()`, `MakeSlice[T]()`, `Free()`, and `NewArena()` — the four functions the engine uses.

**Impact**: Our arena stub uses regular heap allocation instead of arena allocation. This means rollback netcode may use more memory than intended. For Phase 1 (local play only), this is irrelevant. For Phase 4 (online multiplayer), this may need a proper solution.

**Go version**: Must use Go 1.21. Go 1.23 causes runtime compilation errors (`mbitmap_noallocheaders.go` redeclarations) when building with `GOOS=js`. Go 1.22 also has the arena constraint issue.

---

## VFS (Virtual Filesystem) — How It Works

`vfs.js` shims Go's `syscall/fs_js.go` — it provides the `globalThis.fs` API that the Go WASM runtime expects, but backed by HTTP fetches instead of a real filesystem.

### Two manifest formats supported:
1. **Per-file**: `{ files: { "data/common1.cns": 12345, ... } }` — each file fetched lazily on first open
2. **Packed**: `{ pack: "game.pak", files: { "data/common1.cns": [offset, length], ... } }` — single download

We use **per-file** format (unpacked). The manifest is at `public/game/ikemen-fs/manifest.json`, generated by `scripts/generate-manifest.js`.

### File fetch URL pattern:
Original vfs.js fetches: `./ikemen-fs/file/<vpath>` (relative URL)
Our `/play` page patches `window.fetch` to redirect these to `/api/ikemen-fs/file/<vpath>`

### For Phase 2 (CDN assets):
Character/stage files need to be fetched from jsDelivr CDN:
`https://cdn.jsdelivr.net/gh/FightingGameEngine/Assets@main/<path>`

The file API route (`src/app/api/ikemen-fs/file/[...path]/route.ts`) will need to:
- Check if file exists locally (engine data) → serve from disk
- Otherwise proxy to jsDelivr CDN (character/stage data)
- Cache CDN responses

---

## Current State (Phase 0 Complete, Phase 1 In Progress)

### What works:
- [x] Next.js project scaffolded with App Router
- [x] WASM binary built and committed (22MB)
- [x] Engine JS glue files (vfs.js, wasm_exec.js, sffpal-core.js, webrtc.js)
- [x] Engine data files (Lua scripts, fonts, shaders, ZSS bytecode)
- [x] VFS manifest generated (60 files, 2.3 MB engine data)
- [x] API routes for manifest and file serving
- [x] `/play` page with WASM loader (GC tuning, WebGL2 check, fetch patching)
- [x] `vercel.json` with WASM MIME type
- [x] Project documentation (README, TODO, PROGRESS, FINDINGS)

### What's NOT working yet:
- [ ] Engine hasn't been tested end-to-end (needs Vercel deployment to test)
- [ ] No characters or stages loaded yet (only bare engine data)
- [ ] No save/config.ini generated (engine may fail without it)
- [ ] VFS fetch patching is untested in production
- [ ] The `external/mods/.keep` directory exists but isn't in the manifest

### Known issues to investigate:
1. **Missing save/config.ini**: The engine expects a config file. The VFS creates virtual `save/` dirs but we may need to generate a default `config.ini`. Check `src/resources/defaultConfig.ini` in the energyjp repo.
2. **Missing system.sff and system.snd**: The engine needs `data/system.sff` (system sprites) and `data/system.snd` (system sounds). These are NOT in the energyjp source — they come from the IKEMEN GO Screenpack. We need to get them from `ikemen-engine/Ikemen-GO-Screenpack` repo.
3. **ZSS files vs CNS files**: The engine data has `.zss` files (precompiled Lua bytecode) but the engine may expect `.cns` files. The `common1.cns.zss` suggests the ZSS is a compiled form of common1.cns.

---

## Research Findings Summary

### Why IKEMEN GO over Dolmexica Infinite (F-004)
Dolmexica Infinite has fundamental MUGEN compatibility limits that 63+ patches couldn't fix:
- `localcoord` crashes on most characters
- Missing triggers and state controllers
- SFF v2 palette issues
- Font crashes, broken audio in WASM
- IKEMEN GO handles all of these natively

### Why NOT the community WASM forks (F-002)
- `tursom/Ikemen-wasm`: Abandoned July 2022, 1 commit
- `yasyzb/Ikemen-wasm`: Fork of tursom's, zero additional code
- Upstream IKEMEN GO + energyjp's fork is the correct path

### Browser 60 FPS IS achievable (F-001)
WebMUGEN kit proves it through: GC tuning (GOGC=100), custom VFS (HTTP lazy-loading), WebGL2 hardware acceleration, streaming WASM compile.

### WebMUGEN is IKEMEN GO, not a new engine (F-003)
The kit IS IKEMEN GO v2 compiled to WASM. It uses Go's official `wasm_exec.js` and a custom `vfs.js` that shims the filesystem.

### Demo repo has the UI we want (F-005)
FightingGameEngine-Demo (private) has Persona 5-inspired components: WipeTransition, FightOverlays, MoveListPopup, useSoundEffects, game.css (black/red/white/cyan, Oswald font, angular clip-paths).

### Assets repo case-sensitivity (F-006)
Some characters have filename case mismatches in the manifest (e.g. `basics.st` vs `Basics.st`). Causes 404s from jsDelivr (case-sensitive). Affected: BroliT, THE NIGHTMARE.

---

## Next Steps (from TODO.md)

### Immediate (Phase 0 remaining):
1. **Get default config.ini** — from `ikemen-engine/Ikemen-GO-Screenpack` or generate from `src/resources/defaultConfig.ini`
2. **Get system.sff and system.snd** — from the Screenpack repo
3. **Test engine boot on Vercel** — deploy and check `/play` actually starts
4. **Verify 60 FPS with Kung Fu Man** — needs at least one character

### Phase 1 (Core Playable):
1. Build character select screen fetching from Assets manifest
2. Implement game modes (Local 2P, VS AI, Training, AI vs AI)
3. Input system (keyboard mapping, optional gamepad)

### Phase 2 (Asset Pipeline):
1. Point VFS file route to jsDelivr CDN for character/stage files
2. Character download & caching (IndexedDB or in-memory)
3. Fix case-sensitivity issues in Assets manifest

---

## Assets Repo Structure

The `FightingGameEngine/Assets` repo (GitHub org account, public):
- `manifest.json` v2 — per-file listings for all characters and stages
- `characters/` — 85+ character folders (mostly Dragon Ball Z)
- `stages/` — 5+ stage folders
- CDN base: `https://cdn.jsdelivr.net/gh/FightingGameEngine/Assets@main/`
- There's also `update-manifest.py` for auto-generating the manifest

Each character folder contains: `.def` (definition), `.cns`/`.zss` (states), `.air` (animations), `.sff` (sprites), `.snd` (sounds), `.cmd` (command inputs), `.act` (palette files).

---

## Design Direction (from FightingGameEngine-Demo)

When building the UI in Phase 1/3, follow this design system:
- **Palette**: Black (#0a0a0a), Red (#e53e3e), White (#ffffff), Cyan (#06b6d4)
- **Typography**: Oswald for headings, clean sans-serif for body
- **Shapes**: Angular clip-paths (diagonal cuts, not rounded corners)
- **Transitions**: 3-pane diagonal color wipe (720ms, from WipeTransition.tsx)
- **Sound**: UI click/navigation sound effects
- **Style reference**: Persona 5 UI aesthetic

---

## Tools & Dependencies

- **Runtime**: Node.js v24, npm
- **Framework**: Next.js 16, React 19, TypeScript 5
- **Styling**: Tailwind CSS 4
- **Engine**: IKEMEN GO v2 (WASM), built with Go 1.21
- **Hosting**: Vercel (free tier)
- **CDN**: jsDelivr (free, GitHub-integrated)
- **Go SDK location**: `~/go-sdk/` (Go 1.21.13, user-installed)
- **WebMUGEN kit extract**: `/home/z/my-project/webmugen/` (local only, not in repo)
- **energyjp source clone**: `/tmp/ikemen-go-web/` (local only, not in repo)

---

## GitHub Access

- **PAT**: Stored securely by the user. Request it when needed.
- **User**: `Nawaf-AlHussain`
- **Primary repo**: `Nawaf-AlHussain/FightingGameEngine-Web`
- **Assets org**: `FightingGameEngine`

---

## Common Pitfalls

1. **Don't use Go 1.22+ for WASM builds** — runtime conflicts with arena on GOOS=js
2. **Don't change GOGC from 100** — measured to cause frame freezes at higher values
3. **Don't serve .wasm without `application/wasm` MIME type** — browser won't streaming-compile it
4. **Don't forget the fetch patch** — vfs.js uses relative `./ikemen-fs/` URLs that won't resolve from `/play`
5. **Don't put character/stage data in this repo** — assets come from the CDN
6. **Don't use `tursom/Ikemen-wasm` or `yasyzb/Ikemen-wasm`** — both are abandoned
7. **Do validate case-sensitivity** of Assets manifest filenames before CDN integration
8. **Do check FINDINGS.md before making architectural decisions** — mistakes are documented there
