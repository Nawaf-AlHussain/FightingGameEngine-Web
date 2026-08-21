'use client';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, Suspense } from 'react';

// This page loads the IKEMEN GO WASM engine DIRECTLY into a fight.
// Menu/UI is handled by the website (/local page). The engine only runs combat.
//
// How it skips menus: IKEMEN GO's main.lua checks for -p1, -p2, -loadmotif
// command-line args. When all three are present, it calls main.f_commandLine()
// which bypasses the title screen, character select, and VS screen entirely.
// We pass these via go.argv (Go WASM's equivalent of os.Args).

function PlayPageInner() {
  const bootRef = useRef<HTMLPreElement>(null);
  const searchParams = useSearchParams();

  useEffect(() => {
    let cancelled = false;

    async function bootEngine() {
      const boot = bootRef.current;
      if (!boot) return;

      // Hoist cleanup references so catch block can access them
      let onKeyDown: ((e: KeyboardEvent) => void) | null = null;
      let onKeyUp: ((e: KeyboardEvent) => void) | null = null;
      let focusInterval: ReturnType<typeof setInterval> | null = null;
      let focusObserver: MutationObserver | null = null;
      let clickHandler: (() => void) | null = null;

      const cleanup = () => {
        if (onKeyDown) window.removeEventListener('keydown', onKeyDown, true);
        if (onKeyUp) window.removeEventListener('keyup', onKeyUp, true);
        if (focusInterval) clearInterval(focusInterval);
        if (focusObserver) focusObserver.disconnect();
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
        const p2ai = searchParams.get('p2ai') || '5';
        const isTraining = searchParams.get('training') === '1';

        log(`Match: P1=${p1} vs P2=${p2}${p2ai ? ` (CPU lv${p2ai})` : ''}`);
        log(`Stage: ${stage}`);

        // --- 0. Install keyboard bridge BEFORE anything else ---
        const g = globalThis as any;
        g.__ikemenKeyDown = [];
        g.__ikemenKeyUp = [];

        const heldKeys = new Set<string>();

        onKeyDown = (e: KeyboardEvent) => {
          if (!heldKeys.has(e.code)) {
            heldKeys.add(e.code);
            g.__ikemenKeyDown.push(e.code);
          }
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
          if (heldKeys.has(e.code)) {
            heldKeys.delete(e.code);
            g.__ikemenKeyUp.push(e.code);
          }
        };

        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('keyup', onKeyUp, true);
        log('Keyboard bridge installed.');

        // --- 1. Pin devicePixelRatio to 1 (glfw-js expects this) ---
        Object.defineProperty(window, 'devicePixelRatio', {
          value: 1, writable: false, configurable: true,
        });

        // --- 2. Patch VFS fetch base URL ---
        // VFS files live in public/game/ikemen-fs/file/ — serve them as STATIC
        // assets from /game/ikemen-fs/file/ (Vercel edge CDN, HTTP/2, cached)
        // instead of through the /api/ikemen-fs/file serverless route (cold
        // starts, no cache, per-request disk read). This eliminates serverless
        // latency from both boot preload AND any mid-fight lazy fetches.
        const originalFetch = window.fetch;
        const VFS_FILE_PREFIX = './ikemen-fs/file/';
        const VFS_MANIFEST_URL = './ikemen-fs/manifest.json';
        const STATIC_FILE_BASE = '/game/ikemen-fs/file/';
        const STATIC_MANIFEST = '/game/ikemen-fs/manifest.json';

        window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input.toString();

          if (url.startsWith(VFS_FILE_PREFIX)) {
            const vpath = url.slice(VFS_FILE_PREFIX.length);
            // Don't double-encode — static file paths should match disk paths exactly
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

        // --- 6. Set aspect ratio for VFS config patching ---
        (g as any).ikemenAspect = '16:9';

        // --- 7. PRELOAD ALL VFS FILES ---
        log('Fetching file manifest...');
        const manifestResp = await originalFetch(STATIC_MANIFEST);
        const manifest = await manifestResp.json();
        const allFiles = Object.keys(manifest.files);
        const totalBytes = Object.values(manifest.files).reduce((a: number, b: any) => a + (b as number), 0);
        log('Preloading ' + allFiles.length + ' files (' + (totalBytes / 1e6).toFixed(1) + ' MB)...');

        const setBootLine = (prefix: string, text: string) => {
          if (cancelled) return;
          const lines = boot.textContent.split('\n');
          const idx = lines.findIndex(l => l.startsWith(prefix));
          if (idx >= 0) lines[idx] = prefix + text;
          else lines.push(prefix + text);
          boot.textContent = lines.join('\n');
          boot.scrollTop = boot.scrollHeight;
        };

        const nFiles = await (g.ikemenVfsInit as any)(
          '/game/ikemen-fs/manifest.json',
          allFiles,
          (got: number, total: number) => {
            if (cancelled) return;
            const pct = total > 0 ? Math.round((got / total) * 100) : 0;
            setBootLine('[LOAD] ', (got / 1e6).toFixed(1) + ' / ' + (total / 1e6).toFixed(1) + ' MB (' + pct + '%)');
          }
        );
        log('VFS ready: ' + nFiles + ' files preloaded.');

        if (cancelled) return;

        // --- 8. Build command-line args to SKIP ALL MENUS ---
        // IKEMEN GO's main.lua checks: if -p1 && -p2 && -loadmotif → main.f_commandLine()
        // This bypasses title screen, character select, and VS screen.
        const argv = ['ikemen'];
        argv.push('-p1', p1);
        argv.push('-p2', p2);
        argv.push('-loadmotif', 'data/ikemen1/system.def');
        argv.push('-s', stage);
        if (p2ai) {
          argv.push('-p2.ai', p2ai);
        }
        if (isTraining) {
          argv.push('-tmode1', '2'); // training mode
        }

        log(`Starting engine with args: ${argv.slice(1).join(' ')}`);

        // --- 9. Load and run WASM ---
        log('Fetching IKEMEN GO WASM (~22 MB)...');
        const go = new (g.Go as any)();
        go.argv = argv;
        // GODEBUG=gctrace=1 prints GC events to stderr (captured by vfs.js writeStd → console).
        // This lets us see if GC pauses are the lag cause. Each line shows:
        //   gc N @Xms Y%: Z+... MB heap, ... MB goroots, ... MB goal, ... MB stacks
        // If we see frequent GCs (>10/sec) or large pauses (>20ms), GC is the problem.
        go.env = {
          GOGC: '100',
          GOMEMLIMIT: '800MiB',
          GODEBUG: 'gctrace=1',
        };

        const wasmUrl = '/game/ikemen.wasm';
        let result: WebAssembly.WebAssemblyInstantiatedSource;
        try {
          result = await WebAssembly.instantiateStreaming(
            originalFetch(wasmUrl, { cache: 'no-cache' }),
            go.importObject
          );
        } catch (e) {
          log('Streaming compile failed, buffering...');
          const bytes = await (await originalFetch(wasmUrl, { cache: 'no-cache' })).arrayBuffer();
          result = await WebAssembly.instantiate(bytes, go.importObject);
        }

        log('Engine starting... (menus skipped, going straight to fight)');

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
        focusObserver = new MutationObserver(() => {
          if (focusCanvas()) focusObserver?.disconnect();
        });
        focusObserver.observe(document.body, { childList: true, subtree: true });
        focusInterval = setInterval(() => {
          if (focusCanvas() && focusInterval) clearInterval(focusInterval);
        }, 200);
        clickHandler = () => focusCanvas();
        document.addEventListener('click', clickHandler);

        // --- 11. Run the engine ---
        // main.f_commandLine() will run the fight and call os.exit() when done.
        // In Go WASM, os.exit() terminates the goroutine and go.run() resolves.
        // (do NOT await — we want the frame monitor below to run in parallel)
        const enginePromise = go.run(result.instance);

        // --- 12. Frame-time monitor ---
        // Measures actual rendering rate via requestAnimationFrame.
        // The engine drives rAF internally (glfw-js SwapBuffers → rAF).
        // If rAF callbacks are sparse, the engine is blocking the main thread
        // (likely GC pauses or sync I/O). Logs every 5 seconds with stats.
        {
          let frames = 0;
          let lastReport = performance.now();
          let lastFrame = performance.now();
          let maxDelta = 0;
          let sumDelta = 0;
          let reportInterval: ReturnType<typeof setInterval>;
          const tick = () => {
            const now = performance.now();
            const dt = now - lastFrame;
            lastFrame = now;
            if (dt > maxDelta) maxDelta = dt;
            sumDelta += dt;
            frames++;
          };
          const report = () => {
            const now = performance.now();
            const wall = (now - lastReport) / 1000;
            const avgDelta = frames > 0 ? sumDelta / frames : 0;
            const fps = frames > 0 ? (frames / wall).toFixed(1) : '0.0';
            // Only log if we have frames, otherwise engine hasn't started rendering yet
            if (frames > 0) {
              console.log(
                `[perf] ${fps} fps over ${wall.toFixed(1)}s | ` +
                `avg frame ${(avgDelta).toFixed(1)}ms | ` +
                `worst frame ${maxDelta.toFixed(0)}ms`
              );
            }
            frames = 0;
            maxDelta = 0;
            sumDelta = 0;
            lastReport = now;
          };
          reportInterval = setInterval(report, 5000);
          const rafLoop = () => {
            tick();
            if (!cancelled) requestAnimationFrame(rafLoop);
            else clearInterval(reportInterval);
          };
          requestAnimationFrame(rafLoop);

          // Also log canvas size when it appears (the engine creates it)
          const canvasCheck = setInterval(() => {
            const canvas = document.querySelector('canvas');
            if (canvas && canvas.width > 0) {
              const rect = canvas.getBoundingClientRect();
              console.log(
                `[canvas] backing=${canvas.width}x${canvas.height} ` +
                `displayed=${Math.round(rect.width)}x${Math.round(rect.height)} ` +
                `dpr=${window.devicePixelRatio}`
              );
              clearInterval(canvasCheck);
            }
          }, 500);

          // Clean up monitor when engine exits
          enginePromise.finally(() => {
            clearInterval(reportInterval);
            clearInterval(canvasCheck);
          });
        }

        await enginePromise;

        // Engine exited — fight is over.
        cleanup();
        log('Fight complete. Returning to select...');
        window.location.href = '/local';

      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Go WASM calls os.Exit() by throwing. Detect it and navigate back.
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
  }, [searchParams]);

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center">
      {/* Boot log (fades out once fight starts) */}
      <pre
        ref={bootRef}
        id="boot"
        className="w-full max-w-2xl text-sm text-green-400 font-mono whitespace-pre-wrap leading-relaxed mb-4"
        style={{ maxHeight: '200px', overflow: 'hidden' }}
      />
      {/* The engine creates its own canvas element */}
      <div id="game-container" />
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