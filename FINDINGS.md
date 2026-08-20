# FINDINGS — Fighting Game Engine Web

A living document for reporting **findings**, **mistakes**, and **breakthroughs**.

Format: newest entries at the top. Each entry gets a unique ID for cross-referencing.

---

## F-001 | Go WASM performance is NOT universally bad
**Date**: 2026-08-21 | **Type**: Finding

Initial research suggested Go WASM runs at <10 FPS vs 60+ FPS native — a 6x+ slowdown. This would make a fighting game unplayable.

**Reality**: The WebMUGEN modding kit (energyjp) achieves 60 FPS in browser through:
- Custom JS VFS replacing Go's filesystem (avoids syscall bridge overhead)
- GC tuning: `GOGC=100`, `GOMEMLIMIT=800MiB` (measured: 100 = smooth, 200/500 = noticeable freezes)
- WebGL2 hardware detection with `failIfMajorPerformanceCaveat: true`
- `instantiateStreaming` for WASM (no full-buffer compile)

**Lesson**: Don't extrapolate from generic benchmarks. Real-world optimization matters more than language-level overhead.

---

## F-002 | Both Ikemen-wasm forks on GitHub are dead
**Date**: 2026-08-21 | **Type**: Finding

- `tursom/Ikemen-wasm`: Created July 2022, 1 commit, 2 stars. Fork of upstream Ikemen-GO with WASM build scripts added.
- `yasyzb/Ikemen-wasm`: Created July 2022, fork OF tursom's fork. Zero additional code.
- Both abandoned for 4+ years.
- Upstream `ikemen-engine/Ikemen-GO` now includes `build/wasm.sh` and `build/wasm.bat` natively.

**Lesson**: Always check fork relationships and last-push dates. The GitHub API's `parent` field reveals the chain.

---

## F-003 | WebMUGEN is IKEMEN GO, not a from-scratch engine
**Date**: 2026-08-21 | **Type**: Finding

Earlier in the conversation, I described WebMUGEN on itch.io as potentially being a "from-scratch JS/HTML5 implementation." After examining the modding kit v1.7:

- It IS IKEMEN GO v2 compiled to WASM (`ikemen-v2.wasm`, 24MB)
- The `vfs.js` shims Go's `syscall/fs_js.go` before `wasm_exec.js` loads
- Uses Go's official `wasm_exec.js` runtime
- The engine data files (`common1.cns`, `system.sff`, Lua scripts, shaders) are standard IKEMEN GO

**Lesson**: Verify assumptions by examining actual code, not just descriptions.

---

## F-004 | Dolmexica Infinite's fundamental compatibility limit
**Date": 2026-08-21 | **Type**: Finding (carried over from FightingGameEngine)

After 63+ engine fixes in FightingGameEngine, the core problem remains: Dolmexica's MUGEN interpreter is incomplete.

- `localcoord` crashes on most characters (no per-player coordinate space tracking)
- Missing triggers and state controllers require manual C++ implementation
- SFF v2 palette links and JUS palettes needed manual fixes
- Fonts crash in WASM (TrueType and bitmap .fnt both broken)
- Audio (SDL_mixer) initialization unreliable in browser

IKEMEN GO handles all of these natively. The 63 fixes were valuable learning but the engine choice was the real bottleneck.

**Lesson**: Engine selection matters more than engine patching. Time spent fixing fundamental compatibility issues would have been better spent migrating to a more compatible engine.

---

## F-005 | FightingGameEngine-Demo has the UI we want
**Date**: 2026-08-21 | **Type**: Finding

The Demo repo (private) contains UI components that don't exist in the main repo:
- `WipeTransition` — 3-pane diagonal color wipe (Persona 5 style, 720ms)
- `FightOverlays` — in-fight HUD overlays
- `MoveListPopup` — character move list display
- `useSoundEffects` — UI sound effects hook
- `game.css` — full Persona 5 design system (black/red/white/cyan, angular clip-paths, Oswald font)

The main repo's `game.css` (714 lines) existed but was never imported until discovered during an audit.

**Lesson**: When splitting projects (main vs demo), make sure the better UI doesn't get stranded in the demo branch.

---

## F-006 | Assets repo case-sensitivity causes silent 404s
**Date**: 2026-08-21 | **Type**: Finding (carried over from FightingGameEngine)

The FightingGameEngine/Assets manifest references files by their `.def` filename casing (e.g. `basics.st`), but actual files on disk have different case (e.g. `Basics.st`). This is invisible on Windows (case-insensitive) but causes 404s from GitHub raw/jsDelivr (case-sensitive).

Affected characters: BroliT (2 files), THE NIGHTMARE (4 files).

**Lesson**: Always validate manifest file paths against actual filenames on a case-sensitive filesystem before deploying.
