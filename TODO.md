# TODO — Fighting Game Engine Web

## PRIMARY GOAL

**Replace the Dolmexica Infinite WASM engine with IKEMEN GO v2 WASM, keeping the best UI from FightingGameEngine-Demo and the 85+ character roster from FightingGameEngine/Assets.**

## CURRENT STATE (August 26, 2026) — ✅ BEST PERFORMANCE + SPATIAL GRID

- ✅ 100% 60fps for ALL characters including heavy DBZ with specials (F-038)
- ✅ Zero frame spikes during special attacks (spatial grid broad-phase)
- ✅ No audio stutter during special attacks (audio buffer 8192)
- ✅ No mid-round GC pauses (GOGC=off + safety-net GC every 60s)
- ✅ IndexedDB caching — characters download once, instant on repeat (F-036)
- ✅ 87 characters + 5 stages available from CDN
- ✅ 7 game modes all working (VS CPU, VS Player, Training, Arcade, Survival, Time Attack, Watch)
- ✅ Persona 5 UI with grid character select + stage select + wipe transitions
- ✅ 3 resolution options (480p / 4:3 / 16:9) + FILL/16:9 toggle
- ✅ Fast load (.pak bundling + parallel loading)
- ✅ GOWASM=satconv,signext compiler optimizations

---

## Phase 0 — Foundation (COMPLETE)

- [x] Build IKEMEN GO v2 WASM from source (energyjp/ikemen-go-web, Go 1.21 + GOEXPERIMENT=arenas)
- [x] Extract engine JS files from WebMUGEN modding kit v1.7
- [x] Copy engine data files from energyjp source
- [x] Set up Next.js 16 project with App Router + TypeScript + Tailwind CSS 4
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
- [x] Resolution toggle (480p / 4:3 / 16:9)
- [x] .pak bundling + parallel loading
- [x] Immutable caching
- [x] Auto-redirect after fight

### Remaining (minor)
- [ ] Disable native pause menu (EscOpensMenu=0 in config.ini)
- [ ] Add Escape key to quit fight (navigate back to /local)
- [ ] Clone the Persona 5 UI from FightingGameEngine-Demo
- [ ] Touch controls for mobile

---

## Phase 2 — Asset Pipeline (COMPLETE)

- [x] CDN proxy route (/api/cdn/) — fetches from GitHub raw, serves with CORS
- [x] Character download from CDN (parallel, batched, with progress)
- [x] VFS injection API (ikemenInjectFile / ikemenHasFile)
- [x] Character select shows full 85-character roster from Assets manifest
- [x] Lenient state controller parsing (F-032 — empty [State] blocks skipped)
- [x] Browser caching of CDN files (force-cache)

### Remaining (minor)
- [ ] Character download progress bar in UI (currently only in boot log)
- [ ] IndexedDB caching of downloaded characters (for offline repeat play)
- [ ] Fix case-sensitivity issues in Assets repo (F-006)

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

---

## Phase 5 — Compatibility & Testing (NOT STARTED)

- [ ] Test all 85 characters from Assets repo
- [ ] Test all 5 stages
- [ ] Test across browsers (Chrome, Firefox, Safari, Edge)
- [ ] Test on mobile
- [ ] Performance profiling

---

## Potential Future Optimizations (researched, not yet done)

### Tier 1: Safe, build-flag only (try first)
- [ ] **PGO (Profile-Guided Optimization)**: Capture CPU profile during fight, rebuild with `-pgo=profile.pprof`. Go 1.21+ supports this for GOOS=js. Expected 5-15% faster hot paths. Need to add `runtime/pprof` CPU profile export via `syscall/js` (Blob download).
- [ ] **`-gcflags="-B"` (disable bounds checks)**: Go inserts bounds checks on every array/slice access. Disabling them saves 3-8% in array-heavy code. One build flag, no code changes. Low-medium risk.

### Tier 2: Medium effort, medium risk
- [ ] **Spatial grid broad-phase collision**: Bolt a uniform spatial grid in front of O(n²) collision check. Only check entities in same/adjacent cells. ~150 lines in char.go/system.go. Large gain during special attacks (50 entities → ~5 checks instead of ~2500).
- [ ] **sync.Pool for hot allocations**: Pool frequently allocated structs (helpers, projectiles, explods). Reduces allocation overhead and shrinks live heap (shorter GC pauses).

### Tier 3: Confirmed dead ends (don't try)
- [x] ~~WASM SIMD~~: Go compiler doesn't autovectorize. No stable path.
- [x] ~~True multithreading~~: Go GOOS=js is single-threaded. No change as of Go 1.24.
- [x] ~~Web Worker~~: Isolates from main thread but doesn't speed up engine.

### Build command with all optimizations (for future rebuilds)
```bash
GOEXPERIMENT=arenas GOWASM=satconv,signext GOOS=js GOARCH=wasm CGO_ENABLED=0 \
  go build -trimpath -pgo=profile.pprof -gcflags="-B" -o bin/ikemen-v2.wasm ./src
```

---

## Key Findings Summary

| ID | Status | Summary |
|----|--------|---------|
| F-007 | ✅ Corrected | Arena stub was NOT needed — GOEXPERIMENT=arenas |
| F-018 | ✅ Fixed | BootLoadingMode=0 freeze |
| F-019 | ❌ Wrong | RollbackNetcode was already 0 via VFS patch |
| F-020 | ✅ Documented | VFS patches RollbackNetcode at boot |
| F-021 | ✅ Fixed | Manifest generator overwrote file sizes with 0 |
| F-022 | ❌ Not root cause | while-loading loop removed, freeze persisted |
| F-023 | ✅ Fixed | vfs.js Promise cache storm |
| F-024 | ✅ Fixed | Frame-skip tight loop |
| F-025 | ✅ Applied | WASM rebuilt with yield fixes |
| F-026 | ✅ Understood | Menu freezes due to GC pressure |
| F-027 | ✅ Fixed | time.Sleep(0) was no-op (Claude caught it) |
| F-028 | ✅ Breakthrough | f_quickMatch works — fights playable! |
| F-029 | ✅ Breakthrough | .pak bundling — 1 HTTP request instead of 48 |
| F-030 | ✅ Fixed | Lazy file registration caused in-game lag |
| F-031 | ✅ Documented | Character compatibility — .cmd syntax issues |
| F-032 | ✅ Breakthrough | Lenient state parsing — all 85 chars load |
| F-033 | ✅ Breakthrough | GOGC=off — eliminates mid-round GC pauses |
| F-034 | ✅ Documented | Aspect ratio investigation — reverted to letterbox |
| **F-035** | **✅ Breakthrough** | **Audio buffer + safety-net GC + GOWASM flags — best performance** |
| F-036 | ✅ Fixed | GODEBUG=gctrace=1 was causing micro-stutters — removed |
| F-037 | ✅ Feature | IndexedDB caching — download-on-select, instant fight start |
| **F-038** | **✅ Breakthrough** | **Spatial grid broad-phase — 164ms spikes eliminated, 100% 60fps** |

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