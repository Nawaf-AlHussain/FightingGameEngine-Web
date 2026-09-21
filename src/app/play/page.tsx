'use client';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, Suspense } from 'react';
import {
  fetchAssetsManifest,
  downloadCharacter,
  downloadStage,
  getStageDefPath,
  injectCachedCharacter,
  injectCachedStage,
} from '@/lib/character-downloader';
import { useIsTouchDevice } from '@/lib/use-touch-device';
import RotateOverlay from '@/components/RotateOverlay';
import { readFightResult, clearFightResult, processFightResult, getCurrentModeState, markFightStart } from '@/lib/game-modes';

// This page loads the IKEMEN GO WASM engine and starts a fight directly,
// bypassing the laggy menu (F-026) using the smooth game() path.
//
// How it works:
// 1. React reads match params from URL (?p1=kfm&p2=kfm&stage=...&p2ai=5)
// 2. Loads vfs.js, downloads any non-bundled characters from CDN
// 3. Injects them into the VFS
// 4. Boots the engine with -qp1/-qp2/-qstage CLI flags
// 5. main.lua calls main.f_quickMatch() which uses the smooth game() path
//
// This avoids both:
// - The laggy menu (GC pressure from unoptimized menu rendering — F-026)
// - The f_commandLine loading/compilation freeze (F-022 through F-025)

function PlayPageInner() {
  const bootRef = useRef<HTMLPreElement>(null);
  const searchParams = useSearchParams();
  const isTouch = useIsTouchDevice();
  // Touch controls are shown after the boot log fades (i.e., engine is running).
  // We toggle this true once go.run() is called.
  const [engineRunning, setEngineRunning] = useState(false);
  // Exit confirmation — show a small floating X on touch devices.
  const [showExit, setShowExit] = useState(false);

  // ---- Load vanilla JS touch overlay on touch devices when engine starts ----
  // touch.js is a self-contained IIFE that creates its own DOM (circular D-pad
  // + two-arc action buttons + START/ESC pills). It reads P1 key bindings from
  // localStorage config.ini and dispatches synthetic KeyboardEvents. No React
  // dependency — simpler and more reliable than the old React TouchControls.
  useEffect(() => {
    if (!isTouch || !engineRunning) return;
    const script = document.createElement('script');
    script.src = '/game/touch.js';
    script.onload = () => {
      const g = globalThis as any;
      if (g.__ikemenTouch?.build) g.__ikemenTouch.build();
    };
    document.head.appendChild(script);
    return () => {
      const g = globalThis as any;
      if (g.__ikemenTouch?.destroy) g.__ikemenTouch.destroy();
      script.remove();
    };
  }, [isTouch, engineRunning]);

  // Expose exit handler so the touch exit button can call it.
  const exitFightRef = useRef<(() => void) | null>(null);
  exitFightRef.current = () => {
    // Send Escape key to engine via synthetic KeyboardEvent (the engine
    // listens for native keydown/keyup on document, see system_js.go).
    // This should trigger the pause menu / quit confirmation.
    try {
      const evDown = new KeyboardEvent('keydown', {
        code: 'Escape',
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(evDown);
      setTimeout(() => {
        const evUp = new KeyboardEvent('keyup', {
          code: 'Escape',
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        });
        document.dispatchEvent(evUp);
      }, 50);
    } catch {}
    // Always go back to character select after a short delay (in case the
    // engine's escape handler doesn't fire or doesn't quit the match)
    setTimeout(() => {
      window.location.href = '/local';
    }, 500);
  };

  useEffect(() => {
    let cancelled = false;

    async function bootEngine() {
      const boot = bootRef.current;
      if (!boot) return;

      let onKeyDown: ((e: KeyboardEvent) => void) | null = null;
      let onKeyUp: ((e: KeyboardEvent) => void) | null = null;
      let clickHandler: (() => void) | null = null;

      const cleanup = () => {
        if (onKeyDown) window.removeEventListener('keydown', onKeyDown, true);
        if (onKeyUp) window.removeEventListener('keyup', onKeyUp, true);
        if (clickHandler) document.removeEventListener('click', clickHandler);
      };

      const log = (msg: string) => {
        if (cancelled) return;
        boot.textContent += '\n' + msg;
        boot.scrollTop = boot.scrollHeight;
        console.log('[boot]', msg);
      };

      try {
        // --- Read match parameters from URL ---
        const p1 = searchParams.get('p1') || 'kfm';
        const p2 = searchParams.get('p2') || 'kfm';
        const stage = searchParams.get('stage') || 'stages/stage0-720.def';
        const p2ai = searchParams.get('p2ai'); // null = human, number = AI level
        const p1ai = searchParams.get('p1ai') || '0'; // 0 = human, >0 = AI level
        const training = searchParams.get('training') || '0';
        const time = searchParams.get('time') || '99';
        // NOTE: 'aspect' URL param is no longer used. Resolution is controlled
        // by the Settings UI (or /local RES toggle) via localStorage config.ini,
        // which vfs.js reads on boot. This is the single source of truth.
        // The game canvas is always displayed with its intrinsic aspect ratio.
        // It is fitted to the largest size that can fully fit inside the viewport;
        // the engine's internal resolution is never changed by this display logic.
        const fitCanvasToViewport = () => {
          const canvas = document.querySelector('canvas#ikemen-canvas') as HTMLCanvasElement | null;
          if (!canvas || canvas.width <= 0 || canvas.height <= 0) return false;

          const viewport = window.visualViewport;
          const viewportWidth = viewport?.width || window.innerWidth;
          const viewportHeight = viewport?.height || window.innerHeight;
          const aspect = canvas.width / canvas.height;

          // Maximum aspect-ratio-preserving size that fits entirely in the
          // current viewport. Wide viewports get pillarboxing on the sides;
          // tall/narrow viewports get the equivalent top/bottom letterbox.
          const displayWidth = Math.min(viewportWidth, viewportHeight * aspect);
          const displayHeight = displayWidth / aspect;

          canvas.style.setProperty('width', displayWidth + 'px', 'important');
          canvas.style.setProperty('height', displayHeight + 'px', 'important');
          canvas.style.setProperty('left', '50%', 'important');
          canvas.style.setProperty('top', '50%', 'important');
          canvas.style.setProperty('transform', 'translate(-50%, -50%)', 'important');
          canvas.style.setProperty('position', 'fixed', 'important');
          canvas.style.setProperty('max-width', 'none', 'important');
          canvas.style.setProperty('max-height', 'none', 'important');
          return true;
        };

        const installCanvasFit = () => {
          const style = document.createElement('style');
          style.id = 'ikemen-canvas-fit';
          style.textContent = [
            'html, body { overflow: hidden !important; }',
            'canvas#ikemen-canvas { display: block !important; object-fit: contain !important; margin: 0 !important; }',
          ].join('\\n');
          document.head.appendChild(style);
          document.body.classList.add('fighting');

          const observer = new MutationObserver(() => { fitCanvasToViewport(); });
          observer.observe(document.body, { childList: true, subtree: true });

          const onResize = () => fitCanvasToViewport();
          window.addEventListener('resize', onResize);
          window.visualViewport?.addEventListener('resize', onResize);
          window.visualViewport?.addEventListener('scroll', onResize);

          fitCanvasToViewport();

          return () => {
            observer.disconnect();
            window.removeEventListener('resize', onResize);
            window.visualViewport?.removeEventListener('resize', onResize);
            window.visualViewport?.removeEventListener('scroll', onResize);
            document.getElementById('ikemen-canvas-fit')?.remove();
            document.body.classList.remove('fighting');
          };
        };

        const cleanupCanvasFit = installCanvasFit();
        const qmode = searchParams.get('qmode') || 'quickvs'; // progression mode

        log(`Match: P1=${p1} vs P2=${p2}${p2ai ? ` (CPU lv${p2ai})` : ''}`);
        log(`Stage: ${stage}`);
        log(`Mode: ${qmode}`);

        // --- 0. Install keyboard preventDefault handler ---
        // The engine listens for native keydown/keyup on document (via
        // system_js.go's addEventListener). We intercept at the window
        // level (capture phase) ONLY to call preventDefault on game keys
        // so the browser doesn't fire shortcuts (Ctrl+W, F5, backspace
        // navigation, etc.). We do NOT push to any array — the old
        // __ikemenKeyDown/__ikemenKeyUp poll-based bridge was dead code
        // (the engine never read it).
        const heldKeys = new Set<string>();

        onKeyDown = (e: KeyboardEvent) => {
          heldKeys.add(e.code);
          if (
            e.code.startsWith('Arrow') ||
            e.code.startsWith('Key') ||
            e.code.startsWith('Digit') ||
            e.code === 'Enter' ||
            e.code === 'Space' ||
            e.code === 'Escape' ||
            e.code === 'Tab' ||
            e.code.startsWith('Shift') ||
            e.code.startsWith('Control') ||
            e.code.startsWith('Alt') ||
            e.code.startsWith('Numpad')
          ) {
            e.preventDefault();
          }
        };

        onKeyUp = (e: KeyboardEvent) => {
          heldKeys.delete(e.code);
        };

        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('keyup', onKeyUp, true);
        log('Keyboard preventDefault installed.');

        // --- 1. Pin devicePixelRatio to 1 (glfw-js expects this) ---
        const g = globalThis as any;
        Object.defineProperty(window, 'devicePixelRatio', {
          value: 1, writable: false, configurable: true,
        });

        // --- 2. Patch VFS fetch base URL ---
        const originalFetch = window.fetch;
        const VFS_FILE_PREFIX = './ikemen-fs/file/';
        const VFS_MANIFEST_URL = './ikemen-fs/manifest.json';
        const STATIC_FILE_BASE = '/game/ikemen-fs/file/';
        const STATIC_MANIFEST = '/game/ikemen-fs/manifest.json';

        window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input.toString();

          if (url.startsWith(VFS_FILE_PREFIX)) {
            const vpath = url.slice(VFS_FILE_PREFIX.length);
            const rewritten = STATIC_FILE_BASE + vpath;
            return originalFetch(rewritten, init);
          }

          if (url === VFS_MANIFEST_URL || url.startsWith('./ikemen-fs/manifest.json')) {
            return originalFetch(STATIC_MANIFEST, init);
          }

          return originalFetch(input, init);
        };

        // --- 3. Load VFS (must load BEFORE wasm_exec.js) ---
        log('Loading virtual filesystem...');
        await loadScript('/game/vfs.js');
        if (cancelled) return;

        // --- 4. Load wasm_exec.js (Go's WASM runtime) ---
        log('Loading Go WASM runtime...');
        await loadScript('/game/wasm_exec.js');
        if (cancelled) return;

        // --- 5. WebGL2 hardware check ---
        const strict = document.createElement('canvas');
        const hw = strict.getContext('webgl2', { failIfMajorPerformanceCaveat: true });
        if (!hw) {
          log('WARNING: Software rendering. Enable hardware acceleration for 60 FPS.');
        } else {
          log('GPU: Hardware accelerated');
        }
        const any = document.createElement('canvas');
        const soft = any.getContext('webgl2');
        for (const ctx of [hw, soft]) {
          if (ctx) {
            const lose = ctx.getExtension('WEBGL_lose_context');
            if (lose) lose.loseContext();
          }
        }

        // --- 6. Resolution is controlled by Settings UI / localStorage ---
        // Previously, /play set globalThis.ikemenAspect here, and vfs.js
        // used it to overwrite GameWidth/GameHeight in config.ini. Now that
        // Settings UI is authoritative (vfs.js no longer overwrites), we
        // don't set ikemenAspect at all. The engine boots with whatever
        // GameWidth/GameHeight is in localStorage config.ini (set by the
        // Settings UI or the /local RES toggle).

        // --- 7. PARALLEL LOAD: VFS (.pak) + WASM simultaneously ---
        // Both downloads start at the same time instead of sequentially.
        // On a typical connection this saves ~40% of total load time:
        //   Sequential: .pak (3s) + WASM (5s) = 8s
        //   Parallel:   max(.pak, WASM)      = 5s
        log('Loading game.pak + ikemen.wasm in parallel...');

        const setBootLine = (prefix: string, text: string) => {
          if (cancelled) return;
          const lines = boot.textContent.split('\n');
          const idx = lines.findIndex(l => l.startsWith(prefix));
          if (idx >= 0) lines[idx] = prefix + text;
          else lines.push(prefix + text);
          boot.textContent = lines.join('\n');
          boot.scrollTop = boot.scrollHeight;
        };

        // Start WASM fetch immediately (don't await yet — runs in background)
        // go.argv is set later (after CDN downloads) with resolved character paths
        const go = new (g.Go as any)();
        // GC settings (tuned based on gctrace data + Claude's analysis):
        // - GOGC=off: Disables automatic GC entirely. GC only runs at our
        //   forced call sites (platformIdleGC at round transitions, pauses,
        //   match load). This eliminates mid-round GC pauses.
        //
        //   Why this works: GC trace data showed pause duration (~200ms) is
        //   proportional to live heap size (51MB), NOT GC frequency. GOGC
        //   only controls when GC triggers, not how long it takes. So:
        //   - GOGC=100: 200ms pause every ~8s (automatic)
        //   - GOGC=50: 200ms pause every ~4s (worse — more frequent)
        //   - GOGC=off: 0 automatic pauses, only forced ones at round transitions
        //
        //   Safety: GOMEMLIMIT=800MiB remains as backstop. A 60s round
        //   generates ~200MB garbage — well under 800MB. platformIdleGC()
        //   runs between rounds to collect before garbage accumulates.
        //
        //   lines disappear and only (forced) ones remain.
        go.env = {
          GOGC: 'off',
          GOMEMLIMIT: '800MiB',
        };

        const wasmUrl = '/game/ikemen.wasm';
        const wasmPromise = WebAssembly.instantiateStreaming(
          originalFetch(wasmUrl, { cache: 'no-cache' }),
          go.importObject
        ).catch(async () => {
          // Fallback: buffered compile if streaming fails
          log('Streaming compile failed, buffering...');
          const bytes = await (await originalFetch(wasmUrl, { cache: 'no-cache' })).arrayBuffer();
          return WebAssembly.instantiate(bytes, go.importObject);
        });

        // Start VFS (.pak) load — updates progress as it streams
        const vfsPromise = (g.ikemenVfsInit as any)(
          '/game/ikemen-fs/manifest.json',
          [],
          (got: number, total: number) => {
            if (cancelled) return;
            const pct = total > 0 ? Math.round((got / total) * 100) : 0;
            setBootLine('[PAK] ', (got / 1e6).toFixed(1) + ' / ' + (total / 1e6).toFixed(1) + ' MB (' + pct + '%)');
          }
        );

        // Await both in parallel
        const [result, nFiles] = await Promise.all([wasmPromise, vfsPromise]);
        log('VFS ready: ' + nFiles + ' files from .pak | WASM compiled.');

        if (cancelled) return;

        // --- 8. Download non-bundled characters/stages from CDN ---
        // KFM and stage0-720 are bundled in game.pak — skip download.
        // Other characters are injected from IndexedDB cache (if available)
        // or downloaded as fallback.
        //
        // IMPORTANT: addChar() expects just the character ID, NOT the full path.
        let p1Path = p1;
        let p2Path = p2;
        let stagePath = stage;

        const isBundledChar = (id: string) => id === 'kfm';
        const isBundledStage = (s: string) => s === 'stages/stage0-720.def';

        if (!isBundledChar(p1) || !isBundledChar(p2) || !isBundledStage(stage)) {
          // Try to inject from IndexedDB cache first (instant)
          log('Loading characters from cache...');

          // P1: try cache, fallback to download
          if (!isBundledChar(p1)) {
            const injected = await injectCachedCharacter(p1);
            if (injected) {
              log(`P1 loaded from cache: ${p1}`);
              p1Path = p1;
            } else {
              log(`P1 not in cache, downloading...`);
              const manifest = await fetchAssetsManifest();
              const char = manifest.characters.find(c => c.id === p1);
              if (char) {
                log(`Downloading P1: ${char.displayName} (~${char.sizeMB} MB)...`);
                await downloadCharacter(char, (pct, msg) => {
                  setBootLine('[P1] ', `${msg} (${pct}%)`);
                });
                p1Path = char.id;
                log(`P1 ready: ${char.id}`);
              } else {
                log(`ERROR: Character "${p1}" not found in manifest`);
              }
            }
          }

          // P2: try cache, fallback to download
          if (!isBundledChar(p2)) {
            const injected = await injectCachedCharacter(p2);
            if (injected) {
              log(`P2 loaded from cache: ${p2}`);
              p2Path = p2;
            } else {
              log(`P2 not in cache, downloading...`);
              const manifest = await fetchAssetsManifest();
              const char = manifest.characters.find(c => c.id === p2);
              if (char) {
                log(`Downloading P2: ${char.displayName} (~${char.sizeMB} MB)...`);
                await downloadCharacter(char, (pct, msg) => {
                  setBootLine('[P2] ', `${msg} (${pct}%)`);
                });
                p2Path = char.id;
                log(`P2 ready: ${char.id}`);
              } else {
                log(`ERROR: Character "${p2}" not found in manifest`);
              }
            }
          }

          // Stage: try cache, fallback to download
          if (!isBundledStage(stage)) {
            // For stages, the URL param is the stage ID (e.g. 'DU_Campus')
            // not the full path. We need to find it in the manifest.
            const manifest = await fetchAssetsManifest();
            const stg = manifest.stages.find(s => s.id === stage);
            if (stg) {
              const stageInjected = await injectCachedStage(stg.id);
              if (stageInjected) {
                log(`Stage loaded from cache: ${stg.id}`);
                stagePath = getStageDefPath(stg);
              } else {
                log(`Downloading stage: ${stg.displayName} (~${stg.sizeMB} MB)...`);
                await downloadStage(stg, (pct, msg) => {
                  setBootLine('[STAGE] ', `${msg} (${pct}%)`);
                });
                stagePath = getStageDefPath(stg);
                log(`Stage ready: ${stagePath}`);
              }
            } else {
              log(`ERROR: Stage "${stage}" not found in manifest, using default`);
              stagePath = 'stages/stage0-720.def';
            }
          }
        }

        if (cancelled) return;

        // --- 9. Build go.argv with the resolved character/stage paths ---
        log('Engine starting... (quick match, bypassing menu)');

        // Install the display-only canvas fitter before starting the engine.
        // It waits for the engine-created canvas, then keeps it at the maximum
        // aspect-ratio-preserving size during browser/mobile viewport changes.
        go.argv = [
          'ikemen',
          '-qp1', p1Path,
          '-qp2', p2Path,
          '-qstage', stagePath,
          '-qp2ai', p2ai || '0', // 0 = human, >0 = AI level
          '-qp1ai', String(p1ai),
          '-qtraining', String(training),
          '-qtime', String(time),
          '-qmode', qmode, // progression mode: quickvs/arcade/survival/time-attack/watch
        ];

        // Hide the boot log once the engine starts
        if (boot) {
          boot.style.opacity = '0';
          boot.style.transition = 'opacity 1s';
          setTimeout(() => { if (boot) boot.style.display = 'none'; }, 1000);
        }

        // --- 10. Auto-focus the engine canvas once created ---
        const focusCanvas = () => {
          const canvas = document.querySelector('canvas');
          if (canvas && canvas.width > 0) {
            canvas.setAttribute('tabindex', '0');
            (canvas as HTMLCanvasElement).focus();
            return true;
          }
          return false;
        };
        setTimeout(() => focusCanvas(), 1000);
        clickHandler = () => focusCanvas();
        document.addEventListener('click', clickHandler);

        // --- 11. Run the engine ---
        setEngineRunning(true);
        // Mark fight start time for Time Attack duration tracking.
        // Must be called right before go.run() so it measures the actual
        // fight duration, not the engine boot time.
        markFightStart();
        // Show floating exit button on touch devices after engine starts.
        if (isTouch) {
          setTimeout(() => setShowExit(true), 1500);
        }
        await go.run(result.instance);
        cleanupCanvasFit();

        // Engine exited — fight is over. Read the match result and decide
        // what to do next based on the game mode.
        cleanup();

        const fightResult = readFightResult();
        clearFightResult();

        if (fightResult && qmode !== 'quickvs' && qmode !== 'training') {
          // Progression mode — process the result and advance
          const action = processFightResult(fightResult);
          switch (action.type) {
            case 'next-fight': {
              log(`Victory! Advancing to fight ${getCurrentModeState()?.fightNumber ?? '?'}`);
              window.location.href = '/progress';
              return;
            }
            case 'finished': {
              const resultParam = action.result === 'victory' ? 'win' : 'lose';
              log(`${action.result === 'victory' ? 'VICTORY!' : 'DEFEAT'} — ${action.wins}W / ${action.losses}L`);
              window.location.href = `/results?result=${resultParam}&mode=${qmode}&wins=${action.wins}&losses=${action.losses}&time=${action.totalTime.toFixed(1)}`;
              return;
            }
            case 'retry': {
              log('Draw! Replaying the fight...');
              window.location.reload();
              return;
            }
            case 'exit': {
              log('Fight complete. Returning to select...');
              window.location.href = '/local';
              return;
            }
          }
        }

        // Single-fight mode (quickvs/training) — go back to select
        log('Fight complete. Returning to select...');
        window.location.href = '/local';

      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('Go program has already exited') || msg.includes('unreachable')) {
          cleanup();
          window.location.href = '/local';
          return;
        }
        log('BOOT ERROR: ' + msg);
        console.error(e);
      }
    }

    bootEngine();

    return () => {
      cancelled = true;
    };
    // NOTE: isTouch is intentionally NOT in the deps array. The hook
    // starts as false (SSR-safe) and flips to true on mount. If we
    // included isTouch, this effect would re-fire when isTouch flips,
    // cancelling the first bootEngine() mid-WASM-load and starting a
    // second one (race condition: duplicate <script> tags, double
    // fetch of ikemen.wasm, etc.). The touch UI is handled in render
    // via the isTouch && engineRunning condition — no need to re-boot.
  }, [searchParams]);

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center">
      <pre
        ref={bootRef}
        id="boot"
        className="w-full max-w-2xl text-sm text-green-400 font-mono whitespace-pre-wrap leading-relaxed mb-4"
        style={{ maxHeight: '200px', overflow: 'hidden' }}
      />
      {/* The engine creates its own canvas element */}
      <div id="game-container" />

      {/* Rotate overlay for portrait touch devices */}
      {isTouch && <RotateOverlay />}

      {/* Floating exit button — touch only, shown after engine starts */}
      {isTouch && showExit && (
        <button
          type="button"
          className="fight__exit-touch"
          onClick={() => exitFightRef.current?.()}
          aria-label="Exit fight"
        >
          ✕
        </button>
      )}

      {/* Touch controls are loaded via vanilla JS (public/game/touch.js)
          in the useEffect above. No React component needed — the script
          creates its own DOM overlay with circular D-pad + action buttons. */}
    </div>
  );
}

export default function PlayPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-black flex items-center justify-center">
        <span className="text-gray-500 font-mono text-sm">Loading...</span>
      </div>
    }>
      <PlayPageInner />
    </Suspense>
  );
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load: ' + src));
    document.head.appendChild(script);
  });
}

// (DebugBadge component removed — was a development tool for touch
// control debugging, not needed in production per spec Section 50.)
