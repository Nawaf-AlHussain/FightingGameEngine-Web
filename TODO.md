# TODO — Fighting Game Engine Web

## PRIMARY GOAL

**Replace the Dolmexica Infinite WASM engine with IKEMEN GO v2 WASM, keeping the best UI from FightingGameEngine-Demo and the 85+ character roster from FightingGameEngine/Assets.**

## CURRENT STATE (August 23, 2026) — ✅ ROLLED BACK TO a2ee988 (stable)

- ✅ Smooth 60fps gameplay for ALL characters (GOGC=off — F-033)
- ✅ No mid-round GC pauses
- ✅ 85 characters + 5 stages available from CDN
- ✅ Fast load (.pak bundling + parallel loading + immutable caching)
- ✅ 3 resolution options (480p / 4:3 / 16:9, all letterboxed)
- ✅ React character select with mode/character/stage/AI/resolution

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
| **F-032** | **✅ Breakthrough** | **Lenient state parsing — all 85 chars load** |

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