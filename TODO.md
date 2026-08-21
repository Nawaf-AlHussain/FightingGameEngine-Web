# TODO — Fighting Game Engine Web

## PRIMARY GOAL

**Replace the Dolmexica Infinite WASM engine with IKEMEN GO v2 WASM, keeping the best UI from FightingGameEngine-Demo and the 85+ character roster from FightingGameEngine/Assets.**

---

## Phase 0 — Foundation

- [x] Build IKEMEN GO v2 WASM from source (energyjp/ikemen-go-web, Go 1.21 + arena stub)
- [x] Extract engine JS files from WebMUGEN modding kit v1.7
  - [x] `vfs.js` → `public/game/vfs.js`
  - [x] `wasm_exec.js` → `public/game/wasm_exec.js`
  - [x] `webrtc.js` → `public/game/webrtc.js`
  - [x] `sffpal-core.js` → `public/game/sffpal-core.js`
- [x] Copy engine data files from energyjp source (Lua scripts, fonts, shaders, ZSS bytecode)
- [x] Set up Next.js 16 project with App Router + TypeScript + Tailwind CSS 4
- [x] Create VFS manifest generator (`scripts/generate-manifest.js`) — 60 files, 2.3 MB
- [x] Create API routes for VFS manifest and file serving
- [x] Build `/play` page with WASM loader (GC tuning, WebGL2 check, fetch patching)
- [x] Configure `vercel.json` with WASM MIME type + cache headers
- [ ] **Get screenpack files (BLOCKING)**
  - `data/system.sff` (system sprites — lifebars, fonts, effects)
  - `data/system.snd` (system sounds)
  - Default motif/screenpack `.def` file
  - Source: `ikemen-engine/Ikemen-GO-Screenpack` repo
- [ ] **Generate default `save/config.ini` (BLOCKING)**
  - Engine won't boot without it
  - Source: `src/resources/defaultConfig.ini` in energyjp repo, or generate from screenpack
- [ ] Verify `.zss` vs `.cns` file expectations (engine may not recognize `.zss` extension)
- [ ] Deploy to Vercel and test engine boot at `/play`
- [ ] Verify 60 FPS with default Kung Fu Man on a mid-range machine

---

## Phase 1 — Core Playable

- [x] Next.js project setup with App Router
- [x] Character select screen (basic)
  - [x] P1/P2 character selection with confirm/lock-in
  - [x] Game mode selection (VS CPU / VS Player / Training)
  - [x] CPU difficulty slider (1-8)
  - [x] Stage selection
  - [ ] Fetch roster from `FightingGameEngine/Assets/manifest.json`
  - [ ] Show download progress for on-demand characters
  - [ ] Palette selection (if applicable)
- [x] Game modes (basic framework)
  - [x] Local 2P (two players, one keyboard)
  - [x] VS AI (with difficulty 1-8)
  - [x] Training mode (passes -tmode1 flag)
  - [ ] AI vs AI (watch mode)
- [x] **Engine boots directly into fight (no menus)**
  - [x] Discovered IKEMEN GO's built-in CLI quick match (-p1, -p2, -loadmotif)
  - [x] Play page reads URL params and passes via go.argv
  - [x] Fight end auto-redirects to character select
- [x] **Fix in-fight lag** (F-019)
  - [x] Disable `RollbackNetcode` for local play (arena stub makes per-frame state cloning too expensive)
  - [x] Disable `VSync` (redundant in WASM, browser rAF handles display sync)
  - [x] Disable `TickInterpolation` (reduces per-frame GPU work)
  - [ ] **User verifies fights are now smooth on Vercel** ← pending test
  - [ ] If still laggy: profile with Chrome DevTools, check for software WebGL2, try `-nosound`
- [ ] Clone the Persona 5 UI from FightingGameEngine-Demo
  - [ ] `WipeTransition` component
  - [ ] `FightOverlays` component
  - [ ] `MoveListPopup` component
  - [ ] `useSoundEffects` hook
  - [ ] `game.css` (full P5-style design system)
- [ ] Touch controls for mobile
  - [ ] Virtual D-pad + action buttons
  - [ ] Multi-touch support

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