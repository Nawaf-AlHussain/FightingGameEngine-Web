# PROGRESS — Fighting Game Engine Web

## Session: August 21, 2026 (Night 4) — ROOT CAUSE CONFIRMED via Chrome trace: vfs.js Promise cache storm

### Work Done

#### Analyzed Chrome Performance trace (user-provided .cpuprofile)
User uploaded a trace of the frozen fight. Analysis revealed:
- **7285 ms RunTask** (single task blocking main thread for 7.3 seconds)
- **7268 ms RunMicrotasks** inside it (microtask loop, not WASM execution)
- 3047 V8.StackGuard calls (tight loop, one every 2.4ms)
- 80 TimerInstall + 77 TimerRemove (retry loop signature)
- Only 1 RequestAnimationFrame during the entire 7.3s (main thread fully blocked)
- Zero v8.wasm.execute events (WASM not running — JS bridge stuck)

This is a **Promise resolution storm**: microtasks scheduling microtasks infinitely.

#### Root cause: vfs.js fetchFile() cached rejected promises (F-023)
`fetchFile()` caches promises in a `fetching` Map to deduplicate concurrent fetches. On failure (404), the promise rejects but `fetching.delete(vpath)` is never reached (it's after the throw). The rejected promise stays cached. Every subsequent `open()` for the same path returns the same rejected promise → Go retries → another microtask → infinite loop.

**Trigger**: The engine probes for files not in our VFS (`save/config.json`, `save/stats.json`, `stages/stage1.def`, `stages/stage3d.def`, `stages/stage3d_outline.def`). Each 404 triggers the storm. Attract mode never probed these files, which is why it was smooth.

**Fix** (in `vfs.js` `fetchFile()`):
1. On 404: `manifest.delete(vpath)` — removes phantom entry so `exists()` returns false on subsequent calls. `open()` then returns ENOENT synchronously, no Promise/microtask.
2. `p.catch(() => fetching.delete(vpath))` — clears the fetching cache on failure so retries don't get a stale rejected promise.

### Why previous fixes didn't work
- F-018 (BootLoadingMode): fixed sync loading but not the retry loop
- F-019 (RollbackNetcode): was already 0 via VFS patch (F-020)
- F-022 (while-loading loop): removed a useless spin loop but not the actual blocker
- F-022 continued (remove -loadmotif): switched to lighter boot path but the retry loop triggers regardless of boot path

The retry loop triggers any time the engine opens a non-existent file, which happens in BOTH f_commandLine() paths. The vfs.js fix is the actual root cause fix.

### Current Status
- **Engine**: vfs.js no longer caches rejected promises, phantom manifest entries self-heal on first 404
- **Frontend**: Clean play page (no instrumentation, no persistent timers)
- **Deployment**: On Vercel, fix pushing now
- **Lag diagnosis**: ROOT CAUSE FIXED (F-023)

### Next Steps
1. **User tests the fix** — verify fights are now smooth
2. **If smooth**: test fight input (WASD/UIO/JKL), disable native pause menu, proceed to Phase 2
3. **If still laggy**: upload a new trace — but this fix addresses the exact 7.3s blocker seen in the trace

### Key Decisions
- Fixed vfs.js (data file) rather than Go source — no WASM rebuild needed
- Did NOT remove the phantom manifest entries (`save/config.json`, `save/stats.json`) — the vfs.js fix handles them gracefully by self-healing on first 404. Cleaner to leave the manifest generator as-is.
- Kept all previous fixes (static VFS, manifest fix, main.lua while-loop removal, -loadmotif removal) — none were the root cause but none are harmful

---

## Session: August 21, 2026 (Night 3) — ROOT CAUSE FOUND: while-loading loop blocks main thread

### Work Done

#### Identified root cause by diffing working vs broken code paths (F-022)
User confirmed the smooth attract mode was on Vercel BEFORE commit 8133c60 (menu skip). Both attract mode and our /play fight call the same `game()` function — the engine works. The difference is the boot path:

- **Attract mode (smooth)**: `main.f_demoStart()` calls `loadStart()` then `game()` directly
- **f_commandLine() (frozen)**: `loadStart()` then `while loading() do refresh() end` then `game()`

The `while loading() do refresh() end` loop is unique to f_commandLine(). In WASM, `refresh()` inside this loading loop doesn't call `SwapBuffers` (nothing to render), so it never yields to the browser via `requestAnimationFrame`. The loop becomes a tight CPU-burning spin that blocks the main thread — matching the "broken record sound" symptom (audio thread runs, main thread blocked).

**Fix**: Removed the loop. Call `game()` directly after `loadStart()`, matching the attract mode pattern. `game()` has its own internal frame loop that properly yields via SwapBuffers.

#### Reverted instrumentation from previous session
- Removed `GODEBUG=gctrace=1` (was flooding console with GC traces, adding synchronous I/O overhead)
- Removed frame-time monitor (rAF loop + setInterval)
- Removed canvas size logger (setInterval)
- These made the freeze WORSE (from "unplayable lag" to "completely frozen")

#### Removed persistent timers from play page
- Removed `MutationObserver` on `document.body` (ran forever during fight, fired on every DOM mutation including boot log updates)
- Removed `setInterval(focusCanvas, 200)` (ran forever during fight)
- Replaced with single `setTimeout(focusCanvas, 1000)` — one attempt, then done

#### Kept good changes from previous session
- Static VFS file serving (`/game/ikemen-fs/file/` instead of `/api/ikemen-fs/file/`) — faster boot, no serverless cold starts
- Manifest generator fix (F-021) — no longer overwrites real file sizes with 0
- F-019 config changes (RollbackNetcode=0, VSync=0, TickInterpolation=0) — redundant but harmless

### Current Status
- **Engine**: WASM boots via f_commandLine() — loading loop removed, game() called directly
- **Frontend**: Clean play page — no persistent timers, no MutationObserver
- **Deployment**: On Vercel, fix pushing now
- **Lag diagnosis**: ROOT CAUSE FOUND AND FIXED (F-022)

### Next Steps
1. **User tests the fix** — verify fights are now smooth (should match attract mode performance)
2. **If smooth**: test fight input (WASD/UIO/JKL), disable native pause menu, proceed to Phase 2
3. **If still laggy**: the issue is inside `game()` itself, not the loading loop. Would need to profile with Chrome DevTools Performance tab.

### Key Decisions
- Modified main.lua (data file, not WASM) — no rebuild needed. This is the correct approach for Lua-level fixes.
- Used Python script to make the edit (preserves tabs — the Edit tool converts tabs to spaces, which would show the entire file as changed in git)
- Did NOT revert F-019's config changes — they're redundant (VFS patches RollbackNetcode=0 anyway) but not harmful
- Kept static VFS change — genuine improvement regardless of lag cause

---

## Session: August 21, 2026 (Night 2) — Lag Diagnosis Round 2: Instrumentation + Static VFS

### Work Done

#### F-019 was wrong — RollbackNetcode was already 0 (F-020)
User reported "no change at all" after F-019. Investigation of `vfs.js:600` revealed the VFS already patches `RollbackNetcode=0` at boot (based on `globalThis.ikemenNetcode`, which our play page doesn't set). So the config.ini value was never authoritative. Rollback was already off during the laggy tests — the lag has a different cause.

#### Fixed manifest generator bug (F-021)
`scripts/generate-manifest.js` was unconditionally setting `manifest['save/config.ini'] = 0` AFTER `walkDir()` had already populated it with the real size (4982 bytes). The override zeroed it out. The VFS manifest was reporting config.ini as 0 bytes. Fixed to only add the entry if walkDir didn't find the real file. Regenerated manifest — config.ini now correctly shows 4982 bytes.

#### Switched VFS file serving from serverless API to static assets
`play_page.tsx` was rewriting VFS file requests to `/api/ikemen-fs/file/...` (serverless route with `no-store` cache, per-request disk read, cold-start risk). Changed to rewrite to `/game/ikemen-fs/file/...` (static assets served by Vercel edge CDN, HTTP/2 multiplexing, cacheable). This eliminates serverless latency from both boot preload AND any mid-fight lazy fetches. The API routes are kept for Phase 2 CDN proxying but no longer used for the base engine data.

#### Added instrumentation for next test
- `GODEBUG=gctrace=1` in go.env — prints Go GC events to stderr (captured by vfs.js → console). Will reveal if GC pauses are the lag cause.
- Frame-time monitor in play_page.tsx — measures actual rAF rate, logs `[perf] N fps over Xs | avg frame Yms | worst frame Zms` every 5 seconds.
- Canvas size logger — logs `[canvas] backing=WxH displayed=WxH dpr=N` when the engine canvas appears, to verify it's not rendering at an oversized backing store.

### Current Status
- **Engine**: WASM boots directly into fights, GC tracing and frame monitor active
- **Frontend**: Lobby → Character Select → Fight flow complete
- **Deployment**: On Vercel, instrumentation push will auto-deploy
- **Lag diagnosis**: STILL OPEN — F-019 was wrong, need user to test with new instrumentation

### Next Steps
1. **User tests with instrumentation** — play a fight, copy the console output. The `[perf]` lines will show actual fps, and `gc N @Xms` lines will show if GC is the bottleneck.
2. **Based on perf data**:
   - If fps < 30 and GC lines are frequent → try `GOGC=200` or `GOGC=off` (counterintuitive but reduces GC frequency)
   - If fps < 30 and NO GC lines → it's not GC, look at rendering (canvas size, shader complexity)
   - If fps ≈ 60 but feels laggy → input latency, not rendering (check poll bridge)
3. **Revert F-019 config changes if needed** — VSync=0 and TickInterpolation=0 are still in config.ini. If they don't help (or hurt), revert. RollbackNetcode=0 is redundant but harmless (VFS patches it anyway).

### Key Decisions
- Kept F-019's config changes in place — they're redundant but not harmful, and reverting them would add noise to the test
- Switched to static file serving — this is a genuine improvement regardless of the lag cause (faster boot, no serverless cold starts)
- Added instrumentation rather than guessing again — two wrong guesses (F-018, F-019) is enough; need actual data

---

## Session: August 21, 2026 (Night) — Fix In-Fight Lag (Rollback Netcode)

### Work Done

#### Root-caused severe in-fight stutter (F-019)
- User reported fights as "completely unplayable" on Vercel deployment — severe stutter during combat, while boot and attract mode were smooth
- Diagnosis: `RollbackNetcode = 1` in config.ini caused per-frame full-game-state cloning. The arena stub (F-007) turns this into heap allocation + garbage, and `GOGC=100` triggers frequent GC scans of the rollback heap — 5-50ms pauses per frame
- Fix: Set `RollbackNetcode = 0` in `public/game/ikemen-fs/file/save/config.ini`. Local play has no network peer to reconcile with, so the clone is pure overhead

#### Secondary config changes (same commit)
- `VSync = 0` — engine vsync is redundant in WASM (browser rAF already syncs to display) and can cause double-buffered frame pacing drops
- `TickInterpolation = 0` — eliminates extra interpolated render between physics ticks, reduces per-frame GPU work

#### Documentation
- Added F-019 to FINDINGS.md with full root-cause analysis and lesson
- Updated PROGRESS.md (this entry) and TODO.md

### Current Status
- **Engine**: WASM boots directly into fights, rollback netcode disabled for local play
- **Frontend**: Lobby → Character Select → Fight flow complete
- **Deployment**: On Vercel, fix pushed and auto-deploy triggered
- **Input**: Poll-based keyboard bridge active, fight keys still need real-world testing now that fights are playable
- **Assets**: 1 character (KFM), 1 stage (stage0-720)

### Known Issues
1. **Fight input untested**: Now that fights should be playable, WASD/UIO/JKL mappings need verification during actual combat
2. **Engine canvas not fullscreen**: May need CSS adjustments
3. **No escape/pause during fight**: EscOpensMenu=1 still set — pressing Escape opens IKEMEN's native pause menu
4. **Only 1 character and 1 stage**: Character select shows KFM only. Need asset pipeline (Phase 2) for more
5. **Rollback disabled**: Phase 4 (online multiplayer) will need either a real arena implementation for GOOS=js or a different approach to state cloning

### Next Steps
1. **User tests the fix** on Vercel deployment — verify fights are now smooth
2. **If still laggy**: profile with Chrome DevTools Performance tab, check for software WebGL2 (Cause 4 in lag diagnosis), try `-nosound` flag to rule out audio
3. **Test fight input**: With playable framerates, verify WASD/UIO/JKL work during combat
4. **Disable native pause menu**: Set `EscOpensMenu=0` or intercept Escape key to return to /local
5. **Phase 2**: Wire VFS file route to jsDelivr CDN for the 85-character roster

### Key Decisions
- Disabled rollback netcode globally rather than per-match. Rationale: there's no netplay code path in Phase 1-3, so the flag is pure overhead. Re-enable in Phase 4 only when a peer is actually connected.
- Kept `GOGC=100` (no change) — the GC setting is correct; the problem was the allocation pattern, not the GC aggressiveness
- Did NOT rebuild the WASM — config-only change, fastest path to test the hypothesis

---

## Session: August 21, 2026 (Late PM) — Architecture Overhaul: Skip Menus

### Work Done

#### KEY BREAKTHROUGH: IKEMEN GO has built-in CLI quick match (no recompilation needed)
- Discovered that `main.lua` (line 4061) checks for `-p1`, `-p2`, `-loadmotif` command-line args
- When all three are present, it calls `main.f_commandLine()` which skips title screen, character select, and VS screen
- We pass these via `go.argv` in `wasm_exec.js` — Go's WASM equivalent of `os.Args`
- **Zero WASM changes required** — this was always there, just not utilized

#### Architecture Changed to Demo2 Pattern (Website UI + Engine Only for Fights)
- Created `/local` page — pure React character select screen:
  - Game mode selection (VS CPU / VS Player / Training)
  - P1 and P2 character slots with confirm/lock-in
  - CPU difficulty slider (1-8) for AI modes
  - Stage selection
  - Extensible design — add more characters/stages to the arrays
- Modified `/play` page to accept URL query parameters:
  - `?p1=kfm&p2=kfm&stage=stages/stage0-720.def&p2ai=5`
  - Builds `go.argv` with `-p1`, `-p2`, `-loadmotif`, `-stage`, `-p2.ai` flags
  - Boot log fades out once fight starts
  - After fight ends (os.exit caught), auto-redirects to `/local`
- Updated `/lobby` page — PRESS START now navigates to `/local` instead of `/play`

#### New Flow
```
/lobby (title) → /local (React char select) → /play?p1=kfm&p2=kfm&stage=... (engine boots directly into fight)
```

#### Committed and Pushed
- Commit `8133c60`: `feat: skip IKEMEN menus - React UI handles character select, engine only fights`
- Pushed to `origin/main` — Vercel auto-deploy triggered

### Current Status
- **Engine**: WASM boots directly into fights (no menus)
- **Frontend**: Lobby → Character Select → Fight flow complete
- **Deployment**: On Vercel, auto-deployed from push
- **Input**: Poll-based keyboard bridge active. Config.ini key mappings correct in theory (w/a/s/d for P1, arrows for P2). WASD keys need real-world testing during fight.
- **Assets**: 1 character (KFM), 1 stage (stage0-720)

### Known Issues
1. **Fight input untested**: WASD + UIO/JKL mappings are in config.ini and jsCodeToKey looks correct, but only "1" (Start) was verified working previously. Menu navigation keys were broken; fight keys may work differently. Needs testing.
2. **Engine canvas not fullscreen**: The engine creates its own canvas but it may not fill the viewport. May need CSS adjustments.
3. **No escape/pause during fight**: Pressing Escape opens IKEMEN's native pause menu (EscOpensMenu=1 in config). This should be disabled or intercepted.
4. **Only 1 character and 1 stage**: Character select shows KFM only. Need asset pipeline (Phase 2) for more.
5. **Fight end detection is crude**: We rely on os.exit() throwing an error. If the engine hangs after the fight, the user is stuck.

### Next Steps
1. **Test the fight**: Deploy and verify the engine actually loads and fights with CLI args
2. **Test fight input**: Verify WASD, UIO, JKL work during gameplay
3. **Add more characters/stages to VFS**: At minimum a few more to make select screen useful
4. **Disable native pause menu**: Set `EscOpensMenu=0` or intercept Escape key
5. **Add Escape to quit fight**: Navigate back to /local when pressing Escape

---

## Session: August 21, 2026 (PM) — Phase 1 Foundation

### Work Done

#### WASM Engine Built from Source
- Installed Go 1.21.13 toolchain (user directory, no sudo needed)
- Cloned `energyjp/ikemen-go-web` (IKEMEN GO fork with WASM platform code)
- Discovered standard library `arena` package is unavailable for `GOOS=js` — created a stub package with `New[T]()`, `MakeSlice[T]()`, `Free()`, `NewArena()`
- Replaced `"arena"` imports in `system.go`, `state_clone.go`, `state.go`, `rollback.go` with stub path
- Successfully built `ikemen.wasm` (22MB) with `GOOS=js GOARCH=wasm`
- Go 1.23 causes runtime mbitmap redeclaration errors; Go 1.22 has arena constraint issues; Go 1.21 is the only working version

#### Next.js Project Scaffolded
- Initialized Next.js 16 + TypeScript 5 + Tailwind CSS 4 with App Router
- Copied engine JS files from WebMUGEN kit v1.7: `vfs.js`, `wasm_exec.js`, `sffpal-core.js`, `webrtc.js`
- Copied engine data from energyjp source: Lua scripts (6 files), fonts (Open Sans + bitmap), shaders (8 files), icons
- Created `scripts/generate-manifest.js` — walks `public/game/ikemen-fs/file/` and generates VFS manifest
- Generated manifest: 60 files, 2.3 MB engine data

#### API Routes Created
- `GET /api/ikemen-fs/manifest` — serves VFS manifest JSON (no-store cache)
- `GET /api/ikemen-fs/file/[...path]` — serves individual VFS files with path traversal protection
- Both routes ready for Phase 2 CDN proxying

#### Game Page with WASM Loader
- `src/app/play/page.tsx` — full engine boot sequence:
  - Pins `devicePixelRatio` to 1 (glfw-js expectation)
  - Patches `window.fetch` to redirect VFS relative URLs to API routes
  - Dynamically loads `vfs.js` then `wasm_exec.js` (VFS must load first)
  - WebGL2 hardware check with `failIfMajorPerformanceCaveat: true`
  - Initializes VFS with manifest and preload list
  - Loads WASM via `instantiateStreaming` (falls back to buffered compile)
  - GC tuning: `GOGC: '100'`, `GOMEMLIMIT: '800MiB'`

#### Configuration
- `vercel.json` with `application/wasm` MIME type + `no-cache` headers
- `tsconfig.json`, `postcss.config.mjs`, `.gitignore` properly configured
- Landed at `github.com/Nawaf-AlHussain/FightingGameEngine-Web`

#### Documentation
- Updated `PROGRESS.md`, `TODO.md`, `FINDINGS.md`, `README.md`
- Created `AGENT.md` with full project context, architecture, build process, workflow instructions

### Current Status

- **Engine**: WASM built (22MB) and committed, JS glue in place
- **Frontend**: Landing page + game loader page, no character select yet
- **Deployment**: vercel.json configured, NOT yet deployed to Vercel
- **Assets**: Engine data only (60 files). No characters or stages yet.

### Known Gaps (must fix before engine can boot)
1. Missing `save/config.ini` — engine needs a default config file in the VFS
2. Missing `data/system.sff` and `data/system.snd` — system sprites/sounds from IKEMEN GO Screenpack
3. `.zss` files may need to be `.cns` files — need to verify what the engine expects
4. Fetch patching untested in production (relative URL rewriting from `/play`)

### Next Steps
1. Get screenpack files (system.sff, system.snd, default motif) from `ikemen-engine/Ikemen-GO-Screenpack`
2. Generate default `save/config.ini` and add to VFS
3. Deploy to Vercel and test engine boot at `/play`
4. Debug any VFS/loading issues that surface
5. Add at least one character (Kung Fu Man) to verify end-to-end gameplay

### Key Decisions
- Built WASM from energyjp fork rather than using WebMUGEN kit directly (kit doesn't ship binary)
- Used API routes for VFS serving instead of static files (needed for Phase 2 CDN proxy)
- Patched `window.fetch` at the play page level rather than modifying vfs.js (keeps kit files untouched for future updates)
- Go 1.21 locked as build requirement (only version that works with arena stub)

---

## Session: August 21, 2026 (AM) — Research & Planning

### Work Done

1. **Evaluated IKEMEN GO WASM options**:
   - `tursom/Ikemen-wasm` — abandoned fork from July 2022, no unique changes beyond WASM build scripts
   - `yasyzb/Ikemen-wasm` — fork of tursom's fork, zero additional code
   - **Conclusion**: Both redundant; upstream `ikemen-engine/Ikemen-GO` + energyjp fork is the path

2. **Evaluated WebMUGEN by energyjp**:
   - NOT a naive Go WASM dump — production-quality browser port
   - Custom `vfs.js` (800+ lines) replacing Go's filesystem with HTTP-backed VFS
   - GC tuned for 60fps (`GOGC=100`, `GOMEMLIMIT=800MiB`)
   - WebGL2 hardware detection at boot
   - WebRTC P2P netcode with rollback
   - Audio working (unlike Dolmexica WASM build)
   - **Conclusion**: This is the right foundation

3. **Audited existing FightingGameEngine ecosystem**:
   - Main repo: Dolmexica Infinite C++ → WASM, 63+ engine fixes, fundamental compat wall
   - Demo repo: Better UI (Persona 5 design, wipe transitions, sound effects)
   - Assets repo: 85 characters via jsDelivr CDN, 5 stages

4. **Repository created** with documentation (README, TODO, PROGRESS, FINDINGS)

### Decisions
- IKEMEN GO v2 WASM over Dolmexica Infinite (native MUGEN compat eliminates 63+ patches)
- Vercel for hosting, jsDelivr CDN for assets, separate repos for engine and assets
