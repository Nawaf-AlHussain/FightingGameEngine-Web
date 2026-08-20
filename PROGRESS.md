# PROGRESS — Fighting Game Engine Web

## Session: August 21, 2026

### Work Done

#### Repository created
- Created `Nawaf-AlHussain/FightingGameEngine-Web` on GitHub (public)
- Added documentation: README.md, TODO.md, PROGRESS.md, FINDINGS.md
- No engine code yet — docs-only initial commit

#### Research & Analysis completed (prior sessions)

1. **Evaluated IKEMEN GO WASM options**: 
   - `tursom/Ikemen-wasm` — abandoned fork from July 2022, no unique changes beyond WASM build scripts
   - `yasyzb/Ikemen-wasm` — fork of tursom's fork, zero additional code
   - **Conclusion**: Both redundant; upstream `ikemen-engine/Ikemen-GO` now includes WASM build natively

2. **Evaluated WebMUGEN by energyjp**:
   - NOT a naive Go WASM dump — production-quality browser port
   - Custom `vfs.js` (800+ lines) replacing Go's filesystem with HTTP-backed VFS
   - GC tuned for 60fps (`GOGC=100`, `GOMEMLIMIT=800MiB`)
   - WebGL2 hardware detection at boot
   - WebRTC P2P netcode with rollback
   - Audio working (unlike Dolmexica WASM build)
   - **Conclusion**: This is the right foundation, not a raw `build/wasm.sh` output

3. **Audited existing FightingGameEngine ecosystem**:
   - Main repo: Dolmexica Infinite C++ → WASM, 63+ engine fixes, 85 chars, but fundamental compat wall
   - Demo repo: Better UI (Persona 5 design, wipe transitions, sound effects)
   - Demo2 repo: UI overhaul variant
   - Assets repo: 85 characters via jsDelivr CDN, 5 stages
   - **Key problems with Dolmexica**: localcoord crashes, incomplete triggers/sctrls, font crashes, audio broken

4. **Performance assessment**:
   - Go WASM has 6x+ overhead vs native in general
   - BUT WebMUGEN's engineering (VFS, GC tuning, WebGL2) makes 60fps achievable on GPU-accelerated browsers
   - 4:3 (640x480) safe for most machines; 16:9 (1280x720) needs decent GPU
   - Software rendering detection built into WebMUGEN's index.html

### Current Status

- **Engine**: Not yet added to repo
- **Frontend**: Not yet started
- **Deployment**: Not yet configured
- **Assets**: Existing 85 chars + 5 stages in FightingGameEngine/Assets ready to use

### Next Steps

1. Extract IKEMEN GO v2 WASM build from WebMUGEN modding kit
2. Set up Next.js project with Persona 5 UI
3. Create VFS manifest pointing to Assets repo via jsDelivr
4. Get Kung Fu Man running in browser on Vercel
