# PROGRESS — Fighting Game Engine Web

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
