# TODO — Fighting Game Engine Web

## PRIMARY GOAL

**Replace the Dolmexica Infinite WASM engine with IKEMEN GO v2 WASM, keeping the best UI from FightingGameEngine-Demo and the 85+ character roster from FightingGameEngine/Assets.**

---

## Phase 0 — Foundation

- [ ] Extract and commit the IKEMEN GO v2 WASM build from WebMUGEN modding kit v1.7
  - `ikemen-v2.wasm` (24MB) → `public/game/ikemen.wasm`
  - `vfs.js` → `public/game/vfs.js`
  - `wasm_exec.js` → `public/game/wasm_exec.js`
  - `webrtc.js` → `public/game/webrtc.js`
  - `sffpal-core.js` → `public/game/sffpal-core.js`
  - `index.html` (reference, will be rebuilt as Next.js)
  - `ikemen-go-src/data/` (engine data files: common1.cns, system.sff, fonts, shaders, scripts)
- [ ] Set up Vercel deployment
  - `vercel.json` with correct `.wasm` MIME type (`application/wasm`)
  - HTTPS enforced (required for WASM + WebRTC)
- [ ] Create manifest-based VFS that points to `FightingGameEngine/Assets` via jsDelivr
  - Generate `ikemen-fs/manifest.json` from the Assets repo manifest
  - Test lazy-loading a character from jsDelivr CDN
- [ ] Verify 60 FPS with default Kung Fu Man on a mid-range machine

## Phase 1 — Core Playable

- [ ] Next.js project setup with App Router
  - Clone the Persona 5 UI from FightingGameEngine-Demo
    - `WipeTransition` component
    - `FightOverlays` component
    - `MoveListPopup` component
    - `useSoundEffects` hook
    - `game.css` (full P5-style design system)
  - Replace the old WASM loader with IKEMEN GO WASM loader
- [ ] Character select screen
  - Fetch roster from `FightingGameEngine/Assets/manifest.json`
  - Show download progress for on-demand characters
  - Palette selection (if applicable)
- [ ] Stage select screen
  - Fetch stages from manifest
  - Preview images
- [ ] Game modes
  - Local 2P (two players, one keyboard)
  - VS AI (with difficulty: Easy/Normal/Hard)
  - Training mode
  - AI vs AI (watch mode)
- [ ] Touch controls for mobile
  - Virtual D-pad + action buttons
  - Multi-touch support

## Phase 2 — Asset Pipeline

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