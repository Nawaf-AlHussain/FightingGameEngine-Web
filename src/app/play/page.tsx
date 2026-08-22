'use client';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, Suspense } from 'react';

// This page loads the IKEMEN GO WASM engine and starts a fight directly,
// bypassing the laggy menu (F-026) using the smooth game() path.
//
// How it works:
// 1. React reads match params from URL (?p1=kfm&p2=kfm&stage=...&p2ai=5)
// 2. Sets globalThis.ikemenQuickMatch = {p1, p2, stage, p2ai}
// 3. Boots the engine normally (go.argv = ['ikemen'])
// 4. main.lua checks for ikemenQuickMatch global and calls main.f_quickMatch()
// 5. f_quickMatch() uses the same game() path as attract mode (smooth 60fps)
//
// This avoids both:
// - The laggy menu (GC pressure from unoptimized menu rendering — F-026)
// - The f_commandLine loading/compilation freeze (F-022 through F-025)

function PlayPageInner() {
  const bootRef = useRef<HTMLPreElement>(null);
  const searchParams = useSearchParams();

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
        const p2ai = searchParams.get('p2ai') || '5';

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

        // --- 8. Build go.argv with custom CLI flags for f_quickMatch ---
        // main.lua checks for -qp1 and -qp2 via getCommandLineValue() and
        // calls main.f_quickMatch() which uses the smooth game() path.
        // Custom flags work because Go's processCommandLine() parses any
        // -flag value pair into sys.cmdFlags (no whitelist).
        log('Loading and running WASM...');
        const go = new (g.Go as any)();
        go.argv = [
          'ikemen',
          '-qp1', p1,
          '-qp2', p2,
          '-qstage', stage,
          '-qp2ai', String(p2ai),
        ];
        go.env = { GOGC: '100', GOMEMLIMIT: '800MiB' };

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

        log('Engine starting... (quick match, bypassing menu)');

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
        await go.run(result.instance);

        // Engine exited — fight is over.
        cleanup();
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
