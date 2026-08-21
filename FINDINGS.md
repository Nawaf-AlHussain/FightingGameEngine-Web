# FINDINGS — Fighting Game Engine Web

A living document for reporting **findings**, **mistakes**, and **breakthroughs**.

Format: newest entries at the top. Each entry gets a unique ID for cross-referencing.

---

## F-007 | Standard library `arena` package is unavailable for GOOS=js
**Date**: 2026-08-21 | **Type**: Finding

IKEMEN GO recently added `import "arena"` (Go 1.20+ experimental) for rollback netcode state cloning. This package has `//go:build` constraints that exclude `GOOS=js` in ALL Go versions (1.20 through 1.23). You cannot build any Go code that imports `"arena"` for the browser.

**Solution**: Created a stub `arena` package with `New[T]()`, `MakeSlice[T]()`, `(a *Arena) Free()`, `NewArena()`. Changed imports from `"arena"` to `"github.com/ikemen-engine/Ikemen-GO/arena"` in 4 files.

**Impact**: Stub uses regular heap allocation instead of arena allocation. Acceptable for local play (Phase 1-3). May need revisiting for rollback netcode (Phase 4) where arena's batch-free semantics matter.

**Lesson**: When a standard library package has platform exclusions, a local stub with the same API surface is the fastest path forward. Check that methods (not just functions) match the calling convention.

---

## F-008 | Go 1.22+ breaks WASM builds with arena runtime conflicts
**Date**: 2026-08-21 | **Type**: Finding

Go 1.23 causes `runtime/mbitmap_noallocheaders.go` redeclaration errors when building with `GOOS=js`. Go 1.22 also has issues. Only Go 1.21 builds cleanly.

Tested: Go 1.21.13 (works), Go 1.22.10 (arena constraint), Go 1.23.4 (runtime redeclaration).

**Lesson**: Lock your Go version for WASM builds. Newest is not always compatible — especially for niche targets like `GOOS=js`.

---

## F-009 | WebMUGEN modding kit doesn't ship the WASM binary
**Date**: 2026-08-21 | **Type**: Mistake

I initially assumed the uploaded `energy-webmugen-modding-kit-v1.7.zip` contained the pre-compiled `ikemen-v2.wasm` (24MB). It does NOT. The kit is a build tool that expects an `ikemen-go-src/` directory alongside it (with the binary at `ikemen-go-src/bin/ikemen-v2.wasm`). The zip only contained the web tooling (JS files, server, export scripts).

This wasted time looking for a non-existent file and then figuring out how to build from source.

**Lesson**: When a kit's README says "keep mugen-web and ikemen-go-src side-by-side", that means both directories must exist. If one is missing, the kit is incomplete.

---

## F-010 | vfs.js uses relative URLs that break from Next.js routes
**Date**: 2026-08-21 | **Type**: Finding

The WebMUGEN kit's `vfs.js` fetches files from `./ikemen-fs/file/<vpath>` (relative URL). This works when the HTML is served from the same directory as `ikemen-fs/`. In Next.js, the game page is at `/play` and the engine files are at `/game/` — the relative URL resolves to `/play/ikemen-fs/file/...` which doesn't exist.

**Solution**: Patch `window.fetch` in the play page to intercept VFS URLs and redirect them to `/api/ikemen-fs/file/...`. This keeps `vfs.js` unmodified (easier to update from upstream later).

**Alternative considered**: Modify vfs.js directly to accept a configurable base URL. Rejected because it creates a maintenance burden when updating from the WebMUGEN kit.

**Lesson**: When integrating third-party JS that uses relative URLs into a SPA router, `fetch` patching is cleaner than modifying the library.

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
