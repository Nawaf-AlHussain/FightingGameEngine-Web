# TODO — Fighting Game Engine Web

## PRIMARY GOAL

**Replace the Dolmexica Infinite WASM engine with IKEMEN GO v2 WASM, keeping the best UI from FightingGameEngine-Demo and the 85+ character roster from FightingGameEngine/Assets.**

## CURRENT STATE (August 22, 2026)

- ✅ Engine boots normally, attract mode runs at smooth 60fps
- ❌ Engine menus freeze after a few seconds (GC pressure — F-026)
- ❌ Cannot start fights through the engine's own menu (too laggy)
- 🔄 Need a way to start fights that bypasses the menu but uses the smooth game() path

---

## Phase 0 — Foundation (COMPLETE)

- [x] Build IKEMEN GO v2 WASM from source (energyjp/ikemen-go-web, Go 1.21 + GOEXPERIMENT=arenas)
- [x] Extract engine JS files from WebMUGEN modding kit v1.7
- [x] Copy engine data files from energyjp source
- [x] Set up Next.js 16 project with App Router + TypeScript + Tailwind CSS 4
- [x] Create VFS manifest generator
- [x] Create API routes for VFS manifest and file serving
- [x] Build `/play` page with WASM loader
- [x] Configure `vercel.json` with WASM MIME type + cache headers
- [x] Get screenpack files (system.sff, system.snd, motif)
- [x] Generate default `save/config.ini`
- [x] Deploy to Vercel and test engine boot
- [x] Verify 60 FPS in attract mode

---

## Phase 1 — Core Playable (IN PROGRESS)

### Architecture
- [x] Engine boots normally (title screen → attract mode → menus → fight)
- [x] Attract mode runs smoothly (60fps)
- [ ] **Menu bypass: start fights without using the engine's laggy menu**
  - [ ] Modify main.lua attract mode to detect keypress and start a fight directly
  - [ ] Use `main.f_demoStart()` pattern (which uses smooth `game()` path)
  - [ ] Allow character/stage selection via React UI, pass to engine via global variables

### Performance fixes applied
- [x] vfs.js Promise cache fix (F-023) — prevents microtask storms on missing files
- [x] Static VFS file serving — faster boot, no serverless cold starts
- [x] Manifest generator fix (F-021) — correct file sizes
- [x] WASM rebuilt with frame-skip yield (F-025) — time.Sleep(0) in await() default case
- [x] WASM rebuilt with loader Gosched (F-025) — runtime.Gosched() after character loads
- [x] config.ini: RollbackNetcode=0, VSync=0, TickInterpolation=0

### Remaining Phase 1
- [ ] **Menu bypass implementation** (BLOCKING — can't start fights without this)
- [ ] Test fight input (WASD/UIO/JKL) — blocked until fights can be started
- [ ] Disable native pause menu (EscOpensMenu=0)
- [ ] Clone the Persona 5 UI from FightingGameEngine-Demo
- [ ] Touch controls for mobile

---

## Phase 2 — Asset Pipeline (NOT STARTED)

- [ ] Point VFS file route to jsDelivr CDN for character/stage files
- [ ] Character download & caching system
- [ ] Stage download & caching
- [ ] Music download & caching
- [ ] Handle large characters (50MB+) gracefully
- [ ] Fix case-sensitivity issues in Assets repo manifest

---

## Phase 3 — UI Polish (NOT STARTED)

- [ ] Title/lobby screen (from Demo repo design)
- [ ] Wipe transition between screens
- [ ] Fight HUD (lifebars, timer, round indicator)
- [ ] Character portraits on select screen
- [ ] Move list display
- [ ] Sound effects for UI
- [ ] Settings/options screen

---

## Phase 4 — Online Multiplayer (NOT STARTED)

- [ ] WebRTC netplay (using WebMUGEN's `webrtc.js`)
- [ ] Room/lobby system
- [ ] Build ID verification
- [ ] Desync detection and reporting
- [ ] Online identity

---

## Phase 5 — Compatibility & Testing (NOT STARTED)

- [ ] Test all 85 characters from Assets repo
- [ ] Test all 5 stages
- [ ] Test across browsers (Chrome, Firefox, Safari, Edge)
- [ ] Test on mobile
- [ ] Performance profiling

---

## Key Findings Summary

| ID | Status | Summary |
|----|--------|---------|
| F-007 | ✅ Corrected | Arena stub was NOT needed — energyjp fork uses GOEXPERIMENT=arenas |
| F-018 | ✅ Fixed | BootLoadingMode=0 freeze — fixed with BootLoadingMode=1 |
| F-019 | ❌ Wrong | RollbackNetcode was already 0 via VFS patch (F-020) |
| F-020 | ✅ Documented | VFS patches RollbackNetcode at boot, config.ini value is ignored |
| F-021 | ✅ Fixed | Manifest generator was overwriting real file sizes with 0 |
| F-022 | ❌ Not root cause | while-loading loop removed but freeze persisted |
| F-023 | ✅ Fixed | vfs.js Promise cache storm — fixed with catch handler + manifest delete |
| F-024 | ✅ Fixed | Frame-skip tight loop — fixed with time.Sleep(0) in WASM (F-025) |
| F-025 | ✅ Applied | WASM rebuilt with frame-skip yield + loader Gosched |
| **F-026** | **🔄 Current** | **Menu freezes after a few seconds — GC pressure from unoptimized menu rendering** |

---

## Phase 2 — Asset Pipeline

- [ ] Point VFS file route to jsDelivr CDN for character/stage files
  - Serve engine data locally, proxy CDN requests transparently
- [ ] Character download & caching system
  - Download from jsDelivr CDN on character select
  - Inject into browser VFS (IndexedDB or in-memory)
  - Cache in browser for repeat visits
  - Cache versioning (bust on manifest change)
- [ ] Stage download & caching (same pattern)
- [ ] Music download & caching (optional .ogg/.mp3)
- [ ] Handle large characters (50MB+) gracefully
  - Progress indicator
  - Background download
  - Netplay weight tags (green/yellow/red like WebMUGEN)
- [ ] Fix case-sensitivity issues in Assets repo manifest
  - Some characters have filename case mismatches (e.g. `basics.st` vs `Basics.st`)
  - This caused 404s in the old project

---

## Phase 3 — UI Polish

- [ ] Title/lobby screen (from Demo repo design)
- [ ] Wipe transition between screens
- [ ] Fight HUD (lifebars, timer, round indicator, names)
  - Note: IKEMEN GO renders these natively, so may just need CSS overlay
- [ ] Character portraits on select screen
  - Extract from SFF or use pre-rendered images
- [ ] Move list display
- [ ] Sound effects for UI (from Demo repo's `useSoundEffects`)
- [ ] Settings/options screen
  - Resolution (4:3 vs 16:9)
  - Audio volume
  - Key bindings

---

## Phase 4 — Online Multiplayer

- [ ] WebRTC netplay (using WebMUGEN's `webrtc.js`)
  - STUN servers (free, works for most players)
  - Optional TURN relay for strict NATs
- [ ] Room/lobby system
  - Room codes for matchmaking
  - Spectator support (if IKEMEN supports it)
- [ ] Build ID verification (ensure both players have same content)
- [ ] Desync detection and reporting
- [ ] Online identity (name + recovery code, from WebMUGEN)
- [ ] Revisit arena stub for proper rollback memory management

---

## Phase 5 — Compatibility & Testing

- [ ] Test all 85 characters from Assets repo
  - Categorize: works perfectly / minor glitches / major issues / crashes
  - Document findings in FINDINGS.md
- [ ] Test all 5 stages
- [ ] Test across browsers
  - Chrome (primary)
  - Firefox
  - Safari (macOS/iOS)
  - Edge
- [ ] Test on mobile
  - Android Chrome
  - iOS Safari
- [ ] Performance profiling
  - Identify GC pause patterns with `?gctrace=1`
  - Profile heap with `?profile=1` for large rosters

---

## Risks & Unknowns

| Risk | Impact | Mitigation |
|------|--------|------------|
| Go WASM GC pauses on large characters | Frame drops | Tuning GOGC/GOMEMLIMIT; WebMUGEN already measured this |
| jsDelivr rate limiting / caching issues | Download failures | Fallback to raw GitHub; cache-busting strategy |
| Vercel WASM MIME type misconfiguration | Black screen | Test early, document fix |
| Mobile WebGL2 performance | Sub-60fps | 4:3 resolution default; asset size limits |
| Some characters still incompatible with IKEMEN GO | Crashes | IKEMEN GO is much more compatible than Dolmexica; log remaining issues |
| WebMUGEN kit license vs our project | Legal | Check license terms; IKEMEN GO itself is MIT |
| Arena stub causes rollback netcode memory issues | Online lag/desync | Revisit in Phase 4; may need proper arena or different approach |
| .zss files not recognized by engine | Boot failure | Test on Vercel; convert to .cns if needed |