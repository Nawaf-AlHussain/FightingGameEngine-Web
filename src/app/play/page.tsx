'use client';

import { useEffect, useRef } from 'react';

// This page loads the IKEMEN GO WASM engine.
// The engine files (vfs.js, wasm_exec.js, ikemen.wasm) live in /game/.
// The VFS manifest and file serving go through our API routes (/api/ikemen-fs/).
//
// We patch the VFS's relative URL base before it initializes so that
// file fetches go to /api/ikemen-fs/file/ instead of ./ikemen-fs/file/.

export default function PlayPage() {
  const bootRef = useRef<HTMLPreElement>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function bootEngine() {
      const boot = bootRef.current;
      if (!boot) return;

      const log = (msg: string) => {
        if (cancelled) return;
        boot.textContent += '\n' + msg;
        boot.scrollTop = boot.scrollHeight;
        console.log('[boot]', msg);
      };

      try {
        // --- 0. Debug: permanently log all addEventListener calls on document ---
        const _origDocAEL = document.addEventListener.bind(document);
        const _aelLog: string[] = [];
        document.addEventListener = ((orig: typeof document.addEventListener) =>
          function (this: Document, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
            _aelLog.push(type);
            console.log('[debug-ael] document.addEventListener("' + type + '")');
            return orig.call(this, type, listener, options);
          })(_origDocAEL) as typeof document.addEventListener;

        // --- 1. Pin devicePixelRatio to 1 (glfw-js expects this) ---
        Object.defineProperty(window, 'devicePixelRatio', {
          value: 1, writable: false, configurable: true,
        });

        // --- 2. Patch VFS fetch base URL ---
        // The original vfs.js fetches from './ikemen-fs/file/<vpath>'.
        // We intercept globalThis.fetch so that VFS requests go to our API route.
        const originalFetch = window.fetch;
        const VFS_FILE_PREFIX = './ikemen-fs/file/';
        const VFS_MANIFEST_URL = './ikemen-fs/manifest.json';
        const API_FILE_BASE = '/api/ikemen-fs/file/';
        const API_MANIFEST = '/api/ikemen-fs/manifest';

        window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input.toString();

          // Rewrite VFS file requests to API route
          if (url.startsWith(VFS_FILE_PREFIX)) {
            const vpath = url.slice(VFS_FILE_PREFIX.length);
            const rewritten = API_FILE_BASE + encodeURIComponent(vpath).replace(/%2F/gi, '/');
            return originalFetch(rewritten, init);
          }

          // Rewrite manifest request
          if (url === VFS_MANIFEST_URL || url.startsWith('./ikemen-fs/manifest.json')) {
            return originalFetch(API_MANIFEST, init);
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
        log('Checking GPU acceleration...');
        const strict = document.createElement('canvas');
        const hw = strict.getContext('webgl2', { failIfMajorPerformanceCaveat: true });
        if (!hw) {
          log('WARNING: Software rendering detected. Turn on hardware acceleration.');
          log('The game needs GPU acceleration for 60 FPS.');
        } else {
          log('GPU: Hardware accelerated');
        }
        // Clean up probe contexts
        const any = document.createElement('canvas');
        const soft = any.getContext('webgl2');
        for (const ctx of [hw, soft]) {
          if (ctx) {
            const lose = ctx.getExtension('WEBGL_lose_context');
            if (lose) lose.loseContext();
          }
        }

        // --- 6. Initialize VFS with our API manifest URL ---
        log('Initializing VFS manifest...');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nFiles = await (globalThis as any).ikemenVfsInit(
          '/api/ikemen-fs/manifest',
          [
            'external/script/main.lua',
            'save/config.json',
            'save/stats.json',
          ],
          (got: number, total: number) => {
            if (cancelled) return;
            const done = total && got >= total;
            boot.textContent = boot.textContent.replace(/\nDownloading game data[^\n]*/g, '')
              + (done
                ? '\nDownloading game data: complete.'
                : `\nDownloading game data: ${(got / 1e6).toFixed(1)}${total ? ' / ' + (total / 1e6).toFixed(1) : ''} MB`);
            boot.scrollTop = boot.scrollHeight;
          }
        );
        log(`VFS ready: ${nFiles} files.`);

        if (cancelled) return;

        // --- 7. Load and run WASM ---
        log('Fetching IKEMEN GO WASM (~22 MB)...');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const go = new (globalThis as any).Go() as any;
        go.argv = ['ikemen'];
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

        log('Starting engine... (watch console for output)');

        // --- 7b. Auto-focus the engine canvas once created ---
        const focusCanvas = () => {
          const canvas = document.querySelector('canvas');
          if (canvas && canvas.width > 0) {
            canvas.setAttribute('tabindex', '0');
            (canvas as HTMLCanvasElement).focus();
            return true;
          }
          return false;
        };
        const focusObserver = new MutationObserver(() => {
          if (focusCanvas()) focusObserver.disconnect();
        });
        focusObserver.observe(document.body, { childList: true, subtree: true });
        // Poll as fallback in case MutationObserver misses it
        const focusInterval = setInterval(() => {
          if (focusCanvas()) clearInterval(focusInterval);
        }, 200);
        // Click-to-focus: if user clicks anywhere on page, refocus canvas
        const clickHandler = () => focusCanvas();
        document.addEventListener('click', clickHandler);

        await go.run(result.instance);
        clearInterval(focusInterval);
        focusObserver.disconnect();
        document.removeEventListener('click', clickHandler);
        log('Engine exited.');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log('BOOT ERROR: ' + msg);
        console.error(e);
      }
    }

    bootEngine();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
      {/* Boot log — visible during loading, hidden once engine renders */}
      <pre
        ref={bootRef}
        id="boot"
        className="w-full max-w-2xl text-sm text-green-400 font-mono whitespace-pre-wrap leading-relaxed mb-4"
        style={{ maxHeight: '200px', overflow: 'hidden' }}
      />
      {/* The engine creates its own canvas element via glfw-js */}
      <div ref={canvasContainerRef} id="game-container" />
    </div>
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
