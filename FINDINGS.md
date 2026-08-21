# FINDINGS — Fighting Game Engine Web

A living document for reporting **findings**, **mistakes**, and **breakthroughs**.

Format: newest entries at the top. Each entry gets a unique ID for cross-referencing.

---

## F-019 | RollbackNetcode=1 causes severe in-fight GC stutter with arena stub (root cause of unplayable combat lag)
**Date**: 2026-08-21 | **Type**: Finding (root cause of in-fight lag)

User reported fights as "completely unplayable" — severe stutter during
actual combat, while boot/attract mode was previously smooth. Symptom
profile pointed to per-frame work that only happens during `game()`, not
during menu rendering.

`config.ini` shipped with `RollbackNetcode = 1`. IKEMEN GO's rollback
netcode clones the entire game state every frame so it can rewind to a
previous state when late input arrives. In native builds this uses Go's
experimental `arena` package for batch allocation (allocate many objects
in a single arena, free the whole arena in one call — zero GC scanning).

Per F-007, we replaced `arena` with a heap-allocation stub (`New[T]()`
does `new(T)`, `MakeSlice` does `make`, `Free()` is a no-op). So with
`RollbackNetcode = 1`:

- Every frame: engine allocates a fresh full copy of game state on the
  Go heap (players, helpers, projectiles, explods, afterimages, etc.)
- Previous frame's clone becomes garbage
- `GOGC=100` triggers frequent GC scans of this growing heap
- Each GC pause = 5-50ms hitch = visible stutter
- Compounds with normal per-frame allocation, so pauses get worse as a
  fight progresses (more helpers/projectiles/afterimages active)

Attract mode didn't show this because it's short and the user wasn't
actively comparing — but the same `game()` call was always doing this
work. The fix isn't "make attract mode smooth", it's "stop the wasteful
per-frame clone for local play where there's no network opponent to
reconcile with".

**Fix**: Set `RollbackNetcode = 0` in `config.ini`. Local play has no
network peer, so there's nothing to roll back to — the clone is pure
overhead. Rollback can be re-enabled per-match in Phase 4 (online
multiplayer) once we either (a) rebuild the WASM with a real arena
implementation for GOOS=js, or (b) accept the GC overhead only when a
peer is actually connected.

**Secondary changes** (same commit, lower-confidence suspects, easy to
revert individually):
- `VSync = 0` — engine-side vsync on top of browser rAF causes
  double-buffered frame pacing. Browser rAF already syncs to display
  refresh. Engine vsync is redundant in WASM and can cause frame drops.
- `TickInterpolation = 0` — extra interpolated render between physics
  ticks. Reduces GPU work per frame. Visual smoothness tradeoff is
  acceptable for 60fps physics; revisit if movement looks choppy.

**Lesson**: When a feature (rollback netcode) depends on a platform
primitive (arena allocation) that you've stubbed out, disable the
feature by default — don't ship with the stub and the feature both
active. The stub preserves API correctness but not performance
characteristics. F-007 flagged this risk explicitly ("May need
revisiting for rollback netcode") but the config was never updated to
match. Always trace the consequences of a stub through to the config
layer.

---

## F-018 | BootLoadingMode=0 in f_commandLine() freezes WASM main thread
**Date**: 2026-08-21 | **Type**: Finding (root cause of freeze)

main.lua line 952 set BootLoadingMode=0, forcing synchronous asset loading.
loadStart() blocked the browser main thread for seconds loading 29MB of
sprites/sounds/fonts. Audio buffers starved (broken record sound) and no
frames rendered (frozen screen).

Attract mode worked because it used async loading (BootLoadingMode=1),
which loads assets across multiple frames with refresh() calls that yield
to the browser event loop.

The f_commandLine() while-loading loop (line 1159-1165) calls refresh()
each frame, but with BootLoadingMode=0, loading() returns false
immediately so the loop never executes.

**Fix**: Changed to BootLoadingMode=1. The while-loading loop now runs,
calling refresh() which yields to the browser.

**Secondary**: Lua checks flags['-s'], not flags['-stage']. Our stage arg
was silently ignored.

**Lesson**: When a native app works but WASM freezes, check for sync I/O
that blocks the single-threaded browser event loop.

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

## F-011 | Go WASM syscall/js event callback pipeline is broken for keyboard events
**Date**: 2026-08-21 | **Type**: Finding

The Go WASM event delivery mechanism (js.FuncOf -> _makeFuncWrapper -> _pendingEvent -> _resume() -> handleEvent()) fails to deliver keyboard events from JavaScript to Go. Events registered via document.addEventListener('keydown', jsFunc) never reach the Go callback. The Go->JS direction (calling js.Global().Get(), .Call(), .String()) works perfectly.

**Workaround**: Poll-based keyboard bridge — JS pushes key codes into window.__ikemenKeyDown/__ikemenKeyUp arrays, Go reads them in pollEvents(). This works because Go->JS calls are reliable.

**Likely root cause**: The main goroutine blocks in SwapBuffers() (channel receive waiting for requestAnimationFrame). When _resume() is called to deliver a pending event, the interaction between channel-based blocking and event delivery may have a race condition or deadlock. The WebMUGEN GRAIL.md hints at this: "Per-frame input sampling misses single-frame synthetic events; hold keys >= 100ms."

**Lesson**: When a cross-language event pipeline fails silently, check if the main goroutine is blocked in a way that prevents event delivery. A poll-based bridge (JS writes, Go reads) is more reliable than callback-based bridges (JS calls Go) in WASM.

---

## F-012 | Poll-based keyboard bridge only works for Start (1) key — other keys still broken
**Date**: 2026-08-21 | **Type**: Finding (unresolved)

After implementing the poll-based keyboard bridge and fixing config.ini key names to use lowercase/KP_ format, only the "1" key (Start for P1) works. Movement keys (w/a/s/d) and action keys (u/i/o/j/k/l) do not register.

**Most likely causes** (in order of probability):
1. jsCodeToKey mapping mismatch: The Go code reads strings from __ikemenKeyDown and looks them up in jsCodeToKey (which maps "KeyW" to keyW). This should work, but there may be a subtle string encoding issue.
2. Config.ini VFS loading: The engine may not be reading the modified config.ini, falling back to defaults that don't match the keyboard layout.
3. OnKeyPressed timing: The poll bridge calls OnKeyPressed inside pollEvents(), but this may be processed at a point in the frame loop where key state is not checked.

**Next step**: Add console.log on both JS and Go sides to trace the full data path from keydown event to config lookup to command matching.

**Lesson**: When a workaround appears to partially work (1 key), don't assume the mechanism is correct. The 1 key may work through a different code path than the other keys.

---

## F-017 | IKEMEN GO has built-in CLI quick match — no WASM changes needed to skip menus
**Date**: 2026-08-21 | **Type**: Breakthrough

F-013 concluded that "No equivalent to startDirectMatch exists" for IKEMEN GO. This was WRONG. IKEMEN GO's `main.lua` (line 4061) has a built-in command-line quick match:

```lua
if getCommandLineValue("-p1") ~= nil 
   and getCommandLineValue("-p2") ~= nil 
   and getCommandLineValue("-loadmotif") ~= nil then
  main.f_commandLine()  -- Skips ALL menus, goes straight to fight
end
```

We pass these via `go.argv` in `wasm_exec.js` (Go's WASM equivalent of `os.Args`):
```js
go.argv = ['ikemen', '-p1', 'kfm', '-p2', 'kfm', '-loadmotif', 'data/ikemen1/system.def', '-stage', 'stages/stage0-720.def', '-p2.ai', '5'];
```

This means the entire architecture change (React UI + engine only for fights) was achievable WITHOUT any Go source modifications or WASM recompilation. The 22MB WASM binary already had this capability.

**Impact**: Saved hours of Go development, compilation, and testing. The Demo2 pattern is now fully replicated using IKEMEN's existing CLI interface.

**Additional flags supported**: `-p1.ai`, `-p2.ai` (AI level 1-8), `-stage` (stage path), `-r` (rounds), `-time` (round time), `-tmode1`/`-tmode2` (team mode).

**Lesson**: Before writing new code to bypass a system, read the system's source code thoroughly. The developers may have already provided the escape hatch you need. The `main.f_commandLine()` function was there all along.

---

## F-013 | Demo2 input architecture is the correct target pattern for IKEMEN GO WASM
**Date**: 2026-08-21 | **Type**: Breakthrough

After analyzing Demo2's complete input system (use-local-two-player.ts, wasm-loader.ts, GameCanvas.tsx, use-fight-state.ts), the correct architecture for the IKEMEN GO WASM project is clear: the website handles ALL menus and character selection via React, and the engine loads only during fights. Input flows from React keyboard capture -> MUGEN input string conversion -> synchronous engine injection via ccall every frame.

Key Demo2 patterns to replicate:
- GameCanvas dynamically loads engine and calls startDirectMatch(p1Char, p2Char, stage) to bypass menus
- use-local-two-player captures keyboard in a React hook, pumps to engine via requestAnimationFrame loop
- use-fight-state polls engine exports for life/power/round state, drives React HUD overlays
- use-ai-player sets difficulty after fight starts via polling roundState >= 2

**Challenge for IKEMEN GO**: No equivalent to startDirectMatch exists. Need to find or create a Lua entry point that starts a match programmatically, bypassing the menu system.

**Lesson**: Study the working system thoroughly before designing the replacement. Demo2's architecture (website UI + engine-as-renderer) is proven and should be replicated, not reinvented.

---

## F-014 | Menu lag in IKEMEN GO WASM but 60 FPS in fights
**Date**: 2026-08-21 | **Type**: Finding

The IKEMEN GO WASM engine's menu screens (title, character select) are visually laggy with stuttering and low FPS. However, the actual fight gameplay runs at smooth 60 FPS. This suggests the menu rendering path uses more CPU-intensive operations (WebGL text rendering, Lua script execution for animations, frequent texture switching) compared to the fight path (pre-compiled ZSS bytecode, batched sprite rendering, minimal per-frame allocation).

**Solution**: Architectural — bypass engine menus entirely. The Demo2 pattern (website handles all menus in React, engine only runs during fights) naturally eliminates this problem because the engine never renders menus.

**Lesson**: When an engine's non-core features (menus, UI) perform poorly in WASM, don't try to fix them. Replace them with native web UI instead.

---

## F-015 | uint8_t overflow caused 3 wasted input fix attempts (Dolmexica lesson)
**Date**: 2026-08-21 | **Type**: Mistake (carried over, documented for cross-reference)

The P2 input bug in the Dolmexica engine had three failed fix attempts because all three patched downstream consumers while the data source (mRemoteButtons) was corrupted by a uint8_t overflow. UP=8, DOWN=9, START=10 don't fit in 8 bits. Three attempts: (1) OR into hasPressedXSingle -> double-input, (2) external-first pattern -> broke jump/crouch, (3) correct location but data still corrupted. Fourth attempt: changed uint8_t to uint32_t -> everything worked.

**Lesson**: Always verify the data path end-to-end before patching consumers. If the source data is corrupted, fixing how it's consumed is wasted effort.

---

## F-016 | StringToKeyLUT uses lowercase for letters, uppercase for special keys
**Date**: 2026-08-21 | **Type**: Finding

The WASM backend's KeyToStringLUT in input_js.go maps letters to lowercase (a-z), arrow keys to uppercase (UP, DOWN, LEFT, RIGHT), and numpad keys to KP_ prefix (KP_1, KP_7). The SDL desktop backend uses different names (W, Up, Num1). A lowercase fallback was added to StringToKey(): `strings.ToLower(s)` is tried if the exact match fails. Config.ini for the WASM build must use the WASM naming convention: w, a, s, d, UP, DOWN, KP_1, KP_7.

**Lesson**: When porting between backends with different key naming conventions, add a fallback lookup rather than requiring exact matches. The user shouldn't need to know the internal naming scheme.

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
