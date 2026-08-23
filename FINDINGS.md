# FINDINGS — Fighting Game Engine Web

A living document for reporting **findings**, **mistakes**, and **breakthroughs**.

Format: newest entries at the top. Each entry gets a unique ID for cross-referencing.

---

## F-034 | Aspect ratio investigation — true 4:3 shows stage background, reverted to letterbox
**Date**: 2026-08-23 | **Type**: Finding + Mistake (lost Go patches during rebuild)

### Aspect ratio investigation
User wanted true 4:3 fight camera (showing more stage vertically, like IKEMEN
Windows) without stage edges. Tested 3 FightAspect settings:

1. **FightAspect=-1,-1 (Stage)**: 16:9 fight camera, letterboxed black bars
2. **FightAspect=4,3 (Custom)**: 4:3 fight camera, showed stage edges (background)
3. **FightAspect=0,0 (Default)**: 4:3 fight camera, showed stage background

Added Go source debug logging to `GetScaledViewportSize()`. Data confirmed:
```
canvas=640x480  aspectGame=1.333  aspectWindow=1.333  gameW=320.0  gameH=240.0
```
The engine was working correctly — the "black bars" in true 4:3 mode were
the **stage's own background**, not letterboxing. Stage0-720 (localcoord=
1280,720 = 16:9) doesn't have enough art to cover a 4:3 camera vertically.

**Resolution**: Reverted to FightAspect=-1,-1 (Stage aspect) for 4:3 modes.
Gives clean letterboxed 16:9 fight camera. No stage edges visible.

### Mistake: Lost Go patches during WASM rebuild (same as F-027)
When rebuilding the WASM to add/remove debug logging, /tmp was cleared and
the fresh clone was missing all 3 Go patches:
1. time.Sleep(1ms) frame-skip yield (F-025/F-027)
2. runtime.Gosched() in loader (F-025)
3. Lenient state controller parsing (F-032)

Result: Game felt laggy (no frame-skip yield) and some characters would
crash (strict parsing). Fixed by re-applying patches and rebuilding.

**This happened TWICE** (F-027 and F-034). Lesson reinforced: ALWAYS verify
Go patches are present before building. Created `apply_all_go_patches.py`
script for future rebuilds.

### Final resolution
Rolled back all code to commit a2ee988 (the last known-good state before
aspect ratio changes). This restores:
- The working 3-option resolution toggle (480p / 4:3 / 16:9)
- vfs.js without FightAspect patching (uses stage's default -1,-1)
- Simple CSS (no object-fit interference)
- WASM with all 3 Go patches

The 4:3 modes are letterboxed (16:9 fight camera in 4:3 canvas). This is
clean and works well. True 4:3 fight camera is not feasible with 16:9 stages
without showing stage background areas.

---

## F-033 | GOGC=off eliminates mid-round GC pauses — smooth gameplay achieved
**Date**: 2026-08-22 | **Type**: Breakthrough (final performance fix)

After collecting GC trace data (GODEBUG=gctrace=1) and Claude's analysis,
discovered the key insight: **GC pause duration is proportional to live
heap size, not GC frequency**.

Data showed:
- KFM vs KFM: 200ms pause every ~8s, live heap 51MB
- Nightwing vs KFM: 200ms pause every ~7s, live heap 63MB
- Character doesn't affect GC behavior — both have same ~200ms pauses

This meant:
- GOGC=100: 200ms pause every ~8s (automatic, during gameplay)
- GOGC=50: 200ms pause every ~4s (worse — more frequent, same duration)
- **GOGC=off: 0 automatic pauses** — GC only runs at forced call sites

**Fix**: Set `GOGC=off` in go.env. GC now only runs at:
- Round transitions (platformIdleGC in system.go:4107)
- Pauses (platformIdleGC in input.go:146)
- Match load (platformLoadGC in system.go:1014)

**Safety**: GOMEMLIMIT=800MiB remains as backstop. A 60s round generates
~200MB garbage — well under 800MB. Between rounds, forced GC collects
before garbage accumulates.

**Result**: User reports "gameplay is very smooth now. For long sessions
and heavy characters as well." This is the final performance fix.

**Lesson**: When a GC pause is proportional to live heap size (not garbage
volume), tuning GOGC is the wrong lever — it only changes frequency, not
duration. The correct approach is to disable automatic GC entirely
(GOGC=off) and force collections only at invisible moments (round
transitions, pauses). This is Go's documented pattern for latency-sensitive
applications.

**Journey**: F-025 (time.Sleep(0) was no-op) → F-027 (Claude caught it) →
F-028 (f_quickMatch works) → F-029 (.pak bundling) → F-032 (lenient
parsing) → F-033 (GOGC=off). Each fix was necessary; none was sufficient
alone.

---

## F-032 | Lenient state controller parsing — characters now load from CDN
**Date**: 2026-08-22 | **Type**: Breakthrough (character compatibility)

After the CDN pipeline (F-029) and addChar() path fix (c048ceb) worked,
characters still crashed with "State controller type not specified".

**Root cause**: Character authors use empty `[State -1]` blocks as section
headers/comments before the actual state block:
```mugen
[state -1]          ← empty block, no type= (used as a header)
[state -1]          ← actual state block
type = changestate
value = 200
```

IKEMEN GO on Windows **skips** these empty blocks silently. Our WASM build
was **crashing** because `compiler.go:7008` returned an error instead of
skipping. Same issue with "Missing trigger1" at line 7014.

**Fix** (requires WASM rebuild):
1. `compiler.go:7008`: `return errmes(...)` → `continue` (skip with warning)
2. `compiler.go:7014`: `return errmes(...)` → `continue` (skip with warning)

Both now log a warning to console and skip the malformed block, matching
IKEMEN GO Windows behavior. Characters with non-standard syntax now load.

**Result**: Nightwing and other previously-failing characters now load
perfectly from CDN. The 85-character roster is fully accessible.

**Lesson**: When a character works in the desktop engine but not in WASM,
the WASM build may have stricter error handling. Always compare with the
desktop engine's behavior — if it tolerates something, the WASM build
should too. The energyjp fork may have diverged from upstream in error
handling strictness.

---

## F-031 | Character compatibility — some .cmd files have syntax IKEMEN rejects
**Date**: 2026-08-22 | **Type**: Finding (character compatibility)

After fixing the CDN pipeline (F-029) and the addChar() path issue (c048ceb),
CDN characters now download and inject correctly. But some characters crash
with "State controller type not specified" errors during .cmd parsing.

**Example**: Nightwing's `!Nightwing.cmd` line 552:
```
command = D,D, x+y
```
The spaces after commas cause IKEMEN's parser to fail. This is MUGEN syntax
that some characters use but IKEMEN doesn't fully accept.

**This is NOT our pipeline issue** — the files download correctly, inject
into the VFS correctly, and the engine reads them. The error is in the
character's own syntax, not our code.

**Known working**: KFM (bundled), Bardock (clean syntax).
**Known failing**: Nightwing (cmd syntax issues).

**Workaround**: Added note to character select suggesting KFM or Bardock.

---

## F-028 | f_quickMatch breakthrough — fights now work smoothly
**Date**: 2026-08-22 | **Type**: Breakthrough (working fights!)

After Claude's review (F-027) identified two critical bugs:
1. `ikemenQuickMatch` JS global was never accessible from Lua
2. `time.Sleep(0)` was a no-op (F-027)

...and I fixed the `clearSelected()` ordering bug, **fights now work**.

**What works**:
- React character select → FIGHT → engine boots via `f_quickMatch()`
- Fights run at smooth 60fps using the optimized `game()` path
- No menu freeze (menu is never rendered)
- Player input works (WASD/UIO/JKL for P1, arrows/numpad for P2)
- AI opponent works (configurable level 1-8)
- After fight ends, auto-redirects back to character select

**The three fixes that made it work** (all needed):
1. CLI args: `go.argv = ['ikemen', '-qp1', 'kfm', '-qp2', 'kfm', ...]` — Lua reads via `getCommandLineValue("-qp1")`
2. `time.Sleep(1 * time.Millisecond)` in frame-skip default case (was `Sleep(0)` = no-op)
3. `clearSelected()` BEFORE `selectChar()` (was after, wiping the selection)

**Lesson**: When a system has multiple bugs, fixing them one at a time can mask progress. The f_quickMatch approach was correct from the start (F-026), but three independent bugs prevented it from working. Each bug had to be fixed before the system could function. Claude's external review caught two of the three that I had missed.

---

## F-029 | .pak bundling — 1 HTTP request instead of 48
**Date**: 2026-08-22 | **Type**: Breakthrough (load time optimization)

Bundled essential VFS files into a single `game.pak` file (10.7 MB), loaded in one HTTP request with streaming progress. Previously: 48 individual HTTP requests.

**Comparison with Dolmexica** (the old engine that loaded fast):
| | Dolmexica | IKEMEN before | IKEMEN after |
|---|---|---|---|
| Engine binary | 4.6 MB | 23.1 MB | 23.1 MB (cached) |
| Data loading | 1 file (14.4 MB) | 48 files (10 MB) | 1 file (10.7 MB) |
| HTTP requests | 2 | 49 | 2 |
| Caching | Permanent | no-cache | immutable |

**vfs.js already had .pak support** — the `ikemenVfsInit` function checks for `data.pack` in the manifest and loads the pack file if present. I just had to:
1. Write `scripts/generate-pak.js` to bundle files
2. Generate the packed manifest format: `{pack: 'game.pak', stamp, files: {vpath: [offset, length]}}`
3. Add immutable cache headers (`max-age=31536000`) for .pak and .wasm

**Remaining load time**: WASM (23 MB) + .pak (10.7 MB) = ~34 MB on first load. On repeat visits, both are cached — near-instant. The `stamp` query param busts cache on rebuild.

---

## F-030 | Lazy file registration caused in-game lag (mistake)
**Date**: 2026-08-22 | **Type**: Mistake

When implementing .pak bundling (F-029), I registered 77 non-essential files (system.sff, system.snd, icons, fonts) as "lazy" entries in the VFS manifest. This made `exists('data/ikemen1/system.sff')` return `true`, so the engine tried to fetch the 9.2 MB system.sff **synchronously during gameplay** — causing massive freezes.

**Fix**: Removed lazy file registration entirely. Now `exists()` returns `false` for menu-only assets, and the engine skips them (correct — we don't use menus). The `lazy` field stays in the manifest for documentation but is intentionally not processed.

**Lesson**: Registering a file in the VFS manifest is not free — it tells the engine "this file exists, fetch it if you need it." If the engine decides it needs it mid-fight, you get a synchronous 9 MB HTTP fetch = freeze. Only register files you actually want the engine to access.

---

## F-027 | time.Sleep(0) is a no-op in Go — F-025's frame-skip yield was dead code
**Date**: 2026-08-22 | **Type**: Mistake (identified by Claude's review)

F-025 added `time.Sleep(0)` in the `await()` frame-skip default case to
yield to the browser. The comment said "schedules a 0ms setTimeout which
yields one event loop cycle to the browser." **This was completely wrong.**

Go's `time.Sleep(d)` for `d <= 0` returns **immediately without parking
the goroutine** — on ALL platforms including `GOOS=js`. No `setTimeout`
is scheduled. The Go runtime checks `d <= 0` and returns early.

This means F-025's frame-skip yield was **dead code** — it never actually
yielded to the browser. The tight frame-skip loop still blocked the main
thread, exactly as if the fix wasn't there.

**Fix**: Changed `time.Sleep(0)` to `time.Sleep(1 * time.Millisecond)`.
The positive duration triggers `wasm_exec.js`'s `scheduleTimeoutEvent`
→ real `setTimeout(callback, 1)` → actual yield to the browser event loop.

**How this went undetected**: I verified the source had the patch, rebuilt
the WASM, confirmed the binary size changed, deployed, and tested. All
correct except the fundamental assumption that `time.Sleep(0)` yields.
I never tested whether the yield actually happened — I assumed the Go
runtime behavior matched my mental model.

**Lesson**: When adding a yield/sleep mechanism, ALWAYS verify it actually
yields. For Go WASM, this means:
- `time.Sleep(0)` → no-op (returns immediately)
- `time.Sleep(1 * time.Millisecond)` → real yield via setTimeout
- `runtime.Gosched()` → yields to Go scheduler (may not yield to browser)
- Channel receive (`<-ch`) → yields if channel is empty
- `SwapBuffers()` → yields via requestAnimationFrame (best for frame pacing)

**Also identified by Claude**: The `ikemenQuickMatch` JS global was never
accessible from Lua (Lua can't access JS globals). f_quickMatch never
actually ran — all tests of "Attempt 4" silently fell through to attract
mode. Fixed by using CLI args (`-qp1`, `-qp2`, etc.) via `go.argv` and
reading them with `getCommandLineValue()` in Lua.

---

## F-026 | Menu freezes after a few seconds due to GC pressure (menus not optimized like fights)
**Date**: 2026-08-22 | **Type**: Finding (confirms F-014, adds root cause)

After reverting to the normal boot path (commit 75893ad), user tested and
reported:
- **Attract mode (demo mode): perfectly smooth** — 60fps, no issues
- **Menu: works for first few seconds, then becomes unresponsive**
- Pressing Enter to skip attract mode → menu accepts input briefly → freezes

This is the signature of **GC pressure building up over time**:

The fight rendering path was heavily optimized by energyjp (F-003):
- Allocation-free hot paths (sprite/text draw paths reuse buffers)
- GL command buffer (one JS crossing per frame instead of hundreds)
- Deduplicated uniform writes

The **menu rendering path was NOT given the same optimizations**. Every
menu frame allocates:
- Text image objects (textImgDraw for menu items, cursor, info text)
- Animation state objects (main.f_animPosDraw for menu transitions)
- Draw queue entries (luaDrawPreOps, luaDrawLayerOps)
- Temporary strings and tables (menu item generation, status checks)

With `GOGC=100`, the GC runs frequently. As the heap grows (menu keeps
allocating without freeing as fast), each GC scan takes longer. After
a few seconds, GC pauses exceed 100ms, the menu becomes unresponsive,
and the browser eventually kills the tab.

**Why attract mode doesn't have this problem**: attract mode calls
`main.f_demoStart()` → `game()`. The `game()` function uses the optimized
fight rendering path (even for AI vs AI demo fights). No menu rendering
= no excessive allocation = no GC pressure.

**Why the menu works briefly**: At startup, the heap is small. The first
few seconds of menu rendering allocate modestly, GC pauses are short.
As the heap grows (menu keeps allocating, GC can't keep up), pauses
lengthen until the menu freezes.

**Confirmed**: This is NOT a frame-skip issue (F-024/F-025). The menu
loop calls `refresh()` which calls `SwapBuffers()` → rAF → yields to
browser. The freeze is caused by GC pauses WITHIN the rAF callback,
not by a tight loop that doesn't yield.

**Implication**: We cannot use the engine's native menus. The menu
rendering path is fundamentally too allocation-heavy for single-threaded
WASM. The React UI approach (website handles menus, engine only fights)
was the right architecture — but the `f_commandLine()` quick-match path
has its own issues (F-022, F-023, F-024).

**Path forward**: Need a way to start a fight that:
1. Uses the normal boot path (which yields properly via rAF)
2. Skips the menu (which freezes due to GC pressure)
3. Doesn't use `f_commandLine()` (which has the loading/compilation freeze)

The most promising approach: modify `main.lua`'s attract mode loop to
detect a keypress and immediately start a fight (via `main.f_demoStart()`
pattern) instead of entering the menu. This uses the smooth `game()`
path without going through the laggy menu.

**Lesson**: When a system works in one mode but not another, and the
difference is allocation pattern (not control flow), the issue is GC.
Profile with `GODEBUG=gctrace=1` to confirm — if GC frequency increases
over time and pause durations grow, it's GC pressure. The fix is either
reducing allocations (hard, requires engine modifications) or avoiding
the allocation-heavy code path entirely (the approach we'll take).

---

## F-025 | WASM rebuilt with frame-skip yield fix (F-024 properly fixed)
**Date**: 2026-08-21 | **Type**: Breakthrough (proper fix for F-024)

Installed Go 1.21.13, cloned energyjp/ikemen-go-web fork, applied a one-line
fix to `system.go`, and rebuilt the WASM binary.

**Key discovery during build**: The energyjp fork uses `GOEXPERIMENT=arenas`,
meaning the real Go `arena` package IS available for `GOOS=js`. The arena stub
(F-007) was NOT needed — AGENT.md was wrong about this. The build command is:
```
GOEXPERIMENT=arenas GOOS=js GOARCH=wasm CGO_ENABLED=0 \
  go build -trimpath -o bin/ikemen-v2.wasm ./src
```

**The fix** (in `src/system.go`, `await()` function, default case):
```go
default:
    if diff < -150*time.Millisecond {
        s.redrawWait.nextTime = now.Add(waitDuration)
    }
    s.frameSkip = true
    // WASM: always yield to the browser event loop, even when behind schedule
    if runtime.GOOS == "js" {
        time.Sleep(0)  // schedules a 0ms setTimeout, yields to browser
    }
```

When the engine falls behind schedule and enters frame-skip mode, it now
calls `time.Sleep(0)` which translates to `setTimeout(callback, 0)` in the
Go WASM runtime. This yields one event loop cycle to the browser, preventing
the tight loop that was blocking the main thread.

On native builds, `runtime.GOOS == "js"` is false, so the fix is a no-op —
the OS scheduler handles yielding. This is a WASM-only fix.

**Why this is the proper fix**: The original frame-skip logic assumed that
skipping `SwapBuffers()` and `time.Sleep()` was safe because the OS would
eventually preempt the thread. In WASM, there's no preemption — the main
thread runs until it voluntarily yields. The fix adds that voluntary yield.

**Build details**:
- Go version: 1.21.13 (linux-amd64)
- Source: energyjp/ikemen-go-web (latest main)
- Arena: real `arena` package via `GOEXPERIMENT=arenas` (NOT the stub)
- Output: 23.1 MB WASM (was 23.4 MB with stub — slightly smaller because
  the real arena package is more optimized than the stub)
- Build time: ~30 seconds

**Lesson**: Always check if a fork has already solved the problem you're
working around. F-007 documented the arena stub as necessary, but the
energyjp fork's README-WEB.md clearly states `GOEXPERIMENT=arenas` is
the build flag. The stub was from an earlier attempt that didn't know
about this flag. Reading the fork's own documentation would have saved
the stub effort entirely.

---

## F-024 | Frame-skip tight loop blocks browser (Go source issue, no WASM rebuild available)
**Date**: 2026-08-21 | **Type**: Finding (architectural limitation)

After F-023 (vfs.js Promise cache) was fixed, the "broken record" complete
freeze was replaced by "very laggy, becomes unresponsive after a while."
Analysis of the Go source (`system.go:807-864`) revealed the root cause:

The `await()` function has a frame-skip optimization:
```go
func (s *System) await(fps int) bool {
    if !s.frameSkip {
        gfx.EndFrame()
        s.window.SwapBuffers()  // yields to browser via rAF
        ...
    }
    // Note: if frameSkip is true, SwapBuffers is NOT called!

    switch {
    case diff >= 0 && diff < waitDuration+2*time.Millisecond:
        time.Sleep(diff)  // yields to browser via setTimeout
        fallthrough
    case now.Sub(s.redrawWait.lastDraw) > 250*time.Millisecond:
        fallthrough
    case diff >= -17*time.Millisecond:
        s.redrawWait.lastDraw = now
        s.frameSkip = false
    default:
        s.frameSkip = true  // frame skip activated
    }
}
```

When the engine falls behind schedule (diff < -17ms):
1. `frameSkip` is set to `true`
2. Next frame: `SwapBuffers()` is SKIPPED (no rAF yield)
3. `time.Sleep()` is SKIPPED (diff < 0, hits default case)
4. Game loop spins tightly: `renderFrame()` → `update()` → `await()` → repeat
5. Only yield is the 250ms safety valve (`now.Sub(lastDraw) > 250ms`)

Result: ~4 FPS with 250ms freezes. The browser eventually kills the tab
for being unresponsive.

**Why this doesn't affect native builds**: The OS scheduler prevents
true busy-looping. In WASM, the main thread IS the browser tab — a
tight loop blocks everything.

**Fix requires**: Modifying `system.go` to always call `SwapBuffers()`
even during frame skip, then rebuilding the WASM. The Go SDK is NOT
available (`~/go-sdk/` missing), so a rebuild is not currently possible.

**Workaround applied**: Reduce per-frame workload so the engine never
falls behind:
- Resolution: 16:9 (1280x720) → 4:3 (640x480) = 3x fewer pixels
- Framerate: 60 → 30 = 2x more time per frame
- AfterImageMax: 512 → 128, ExplodMax: 512 → 128
- HelperMax: 56 → 32, ProjectileMax: 256 → 64

This gives the engine ~6x more headroom. If it still falls behind at
30fps/4:3, the only remaining option is to rebuild the WASM with the
Go source fix.

**Lesson**: Frame-skip optimizations from native engines don't translate
to WASM. In native, skipping a frame means "don't render, but still
yield to OS." In WASM, skipping a frame means "don't render, don't yield,
burn CPU." Any port of a game engine to WASM must ensure the main loop
ALWAYS yields, even when skipping frames.

---

## F-023 | vfs.js fetchFile rejected-promise cache creates infinite microtask storm (ROOT CAUSE of 7.3s freeze)
**Date**: 2026-08-21 | **Type**: Finding (root cause — confirmed via Chrome trace)

User uploaded a Chrome Performance trace (`.cpuprofile`) of the frozen fight.
Analysis revealed:

- One `RunTask` event lasting **7285 ms** (7.3 seconds) on the main renderer thread
- Inside it: one `RunMicrotasks` event lasting **7268 ms**
- 3047 `V8.StackGuard` calls (one every ~2.4ms — tight loop)
- 244 `v8::Debugger::AsyncTaskScheduled` + 77 `AsyncTaskCanceled`
- 80 `TimerInstall` + 77 `TimerRemove` (retry loop signature)
- Only 1 `RequestAnimationFrame` during the entire 7.3s (main thread blocked)
- 6 MajorGC + 13 MinorGC (GC is a SYMPTOM of the loop creating garbage, not the cause)
- Zero `v8.wasm.execute` events (WASM itself isn't running — the JS bridge is stuck)

This is the signature of a **Promise resolution storm**: microtasks scheduling
microtasks in an infinite cascade, never yielding to the event loop. The
`TimerInstall`/`TimerRemove` pattern (80 installed, 77 removed) indicates a
retry loop where each failed operation schedules a timer, the timer fires,
the operation fails again, schedules another timer.

**Root cause**: `vfs.js` `fetchFile()` function cached rejected Promises in
the `fetching` Map without cleaning them up on failure:

```js
// BEFORE (buggy):
async function fetchFile(vpath) {
  if (contents.has(vpath)) return contents.get(vpath);
  if (fetching.has(vpath)) return fetching.get(vpath);  // returns cached rejected promise!
  const p = (async () => {
    const res = await fetch(...);
    if (!res.ok) throw enoent(vpath);  // throws, never reaches fetching.delete()
    ...
    fetching.delete(vpath);  // only runs on success
    return buf;
  })();
  fetching.set(vpath, p);  // caches the (will-be-rejected) promise
  return p;
}
```

When the engine calls `open('save/config.json')` (a file in the manifest
with size 0 but not on disk), `exists()` returns true (manifest has the
entry), so `open()` proceeds to `fetchFile()`. The fetch 404s, the promise
rejects, but the rejected promise stays in `fetching`. Every subsequent
`open()` for the same path returns the same rejected promise, which when
awaited throws, which Go's syscall/js bridge catches and retries, which
schedules another microtask... infinite loop.

**Fix** (two changes to `fetchFile`):
1. On 404, `manifest.delete(vpath)` — removes the phantom entry so
   `exists()` returns false on subsequent calls. `open()` then returns
   ENOENT synchronously without any Promise/microtask.
2. `p.catch(() => fetching.delete(vpath))` — clears the fetching cache
   on failure so retries don't return a stale rejected promise.

**Why attract mode worked**: attract mode (`f_demoStart`) only opens files
that actually exist (KFM character files, stage0-720). It never tries to
open `save/config.json`, `save/stats.json`, or `stages/stage1.def` (files
the engine probes for but that don't exist in our VFS). The retry loop
never triggered.

**Why f_commandLine() froze**: the command-line quick-match path does
more aggressive file probing — it tries `stages/stage1.def`,
`stages/stage3d.def`, `stages/stage3d_outline.def` (looking for
alternate stages), `save/config.json`, `save/stats.json`. Each 404
triggered the infinite microtask storm.

**Lesson**: When caching Promises, ALWAYS handle the failure case —
either clear the cache entry on rejection, or use a pattern that doesn't
cache rejected promises. A cached rejected promise is a time bomb: every
future caller gets the same rejection, and if the caller retries, you
get an infinite loop. The Chrome trace's `TimerInstall`/`TimerRemove`
count (80/77) was the giveaway that this was a retry loop, not a tight
CPU loop — timers mean JS is scheduling work, not executing it.

**Also**: manifest entries with size 0 for files that don't exist on disk
(`save/config.json`, `save/stats.json`) are a footgun. `exists()` checks
`manifest.has()`, so these phantom entries make the engine think the
files exist. The manifest generator (F-021) was already fixed to not
overwrite real sizes with 0, but we should also NOT add entries for
files that don't exist on disk. Left as a follow-up — the vfs.js fix
handles the failure case gracefully now.

---

## F-022 | `while loading() do refresh() end` loop in f_commandLine() blocks WASM main thread (ROOT CAUSE of in-fight freeze)
**Date**: 2026-08-21 | **Type**: Finding (root cause — breaks the "broken record" freeze)

User reported fights as "completely frozen, broken record sound, can't
interact with tab" after commit 8133c60 (menu skip architecture). The
attract mode (smooth) and our /play fight (frozen) both call the same
`game()` function — so the engine itself works. The difference is the
boot path:

**Attract mode (smooth)** — `main.f_demoStart()` (main.lua:3513):
```lua
loadStart(start.f_buildLoadStartParams())
game()  -- called IMMEDIATELY, no loading wait loop
```

**f_commandLine() (frozen)** — main.lua:1160:
```lua
loadStart(table.concat(t_params, ', '))
while loading() do
    refresh()
end
game()
```

The `while loading() do refresh() end` loop is unique to f_commandLine().
In WASM, `refresh()` inside this loading loop does NOT call `SwapBuffers`
(there's nothing to render during loading), so it never yields to the
browser via `requestAnimationFrame`. The loop becomes a tight CPU-burning
spin that blocks the main thread completely.

Symptom match: "broken record sound" = Web Audio thread keeps playing
the same buffer (runs on separate thread), but the main thread can't
advance frames (blocked in the spin loop). Audio repeats, screen frozen.

**Fix**: Removed the `while loading() do refresh() end` loop. Call
`game()` directly after `loadStart()`, matching `f_demoStart()`. The
`game()` function has its own internal frame loop that properly yields
via `SwapBuffers` → `requestAnimationFrame`, and it handles loading
completion internally (the attract mode path proves this works).

**Why F-018 was partially right but incomplete**: F-018 correctly
identified that `BootLoadingMode=0` caused sync loading. Setting
`BootLoadingMode=1` made loading async — but the `while loading()` loop
was STILL there, spinning tightly. With async loading, `loading()`
returns true for a while (loading in progress), and the loop spins
calling `refresh()` which doesn't yield. F-018 reduced the freeze
duration (loading itself became non-blocking) but didn't eliminate the
spin loop that blocked AFTER loading started.

**Also removed**: MutationObserver + setInterval(200ms) for canvas focus
(played once on /play, ran forever during fight). Replaced with single
setTimeout(1000ms). These weren't the root cause but added overhead.

**Lesson**: When a function works in one code path (attract mode) but
freezes in another (f_commandLine), diff the two paths line by line.
The difference IS the bug. Don't theorize about GC, rollback, or config
values until you've compared the working path to the broken path.

---

## F-020 | VFS patches RollbackNetcode at boot — config.ini value is ignored (F-019 was wrong root cause)
**Date**: 2026-08-21 | **Type**: Mistake / Finding (corrects F-019)

User reported "no change at all" after F-019 (disabling RollbackNetcode in
config.ini). Investigation of `vfs.js:600` revealed:

```js
const nc = (globalThis.ikemenNetcode === 'rollback') ? 1 : 0;
const cfg = contents.get('save/config.ini');
if (cfg) {
  const text = new TextDecoder().decode(cfg);
  const patched = text.replace(/^(\s*RollbackNetcode\s*=\s*)[0-9]+/mi, '$1' + nc);
  if (patched !== text) contents.set('save/config.ini', new TextEncoder().encode(patched));
}
```

The VFS **already patches `RollbackNetcode=0`** at boot (because our play
page doesn't set `globalThis.ikemenNetcode='rollback'`). So the value in
config.ini was never authoritative — it gets overwritten in memory before
the engine reads it.

**Implication**: RollbackNetcode was ALREADY 0 during the user's "laggy"
tests. F-019's fix was redundant. The in-fight lag has a different cause.

**Lesson**: Before attributing a perf problem to a config value, verify
the value is actually read at runtime — check for runtime patches,
overrides, or environment variables that might supersede the file. The
vfs.js boot sequence is a "shadow config" layer that silently rewrites
config.ini before the engine sees it.

---

## F-021 | Manifest generator overwrote real file sizes with 0 (config.ini silently "empty")
**Date**: 2026-08-21 | **Type**: Finding (manifest bug)

`scripts/generate-manifest.js` unconditionally set:
```js
manifest['save/config.ini'] = 0;
manifest['save/config.json'] = 0;
manifest['save/stats.json'] = 0;
```

AFTER `walkDir()` had already populated `save/config.ini` with its real
size (4982 bytes). The override zeroed it out. Effect: the VFS manifest
reported config.ini as 0 bytes, so `stat('save/config.ini').size`
returned 0. The engine may have skipped reading it or read it as empty,
falling back to hardcoded defaults for any setting not patched by vfs.js.

This didn't fully break the engine because vfs.js separately fetches
config.ini via HTTP (line 542) for its own boot-time patching, and that
fetch got the real file. But the engine's own stat-based size checks
were wrong.

**Fix**: Changed to `if (!manifest['save/config.ini']) manifest[...] = 0`
— only add the entry if walkDir didn't find the real file.

**Lesson**: When adding "ensure exists" defaults, check whether the key
already exists first. A `manifest[key] = 0` after `walkDir()` is a
silent override, not a fallback.

---

## F-019 | RollbackNetcode=1 causes severe in-fight GC stutter with arena stub (root cause of unplayable combat lag)
**Date**: 2026-08-21 | **Type**: Finding (root cause of in-fight lag)
**Status**: ❌ WRONG — see F-020. RollbackNetcode was already 0 via VFS patch.
Kept for cross-reference and because the lesson about stub+feature
interaction is still valid for Phase 4.

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
