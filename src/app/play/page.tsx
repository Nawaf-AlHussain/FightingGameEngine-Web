'use client';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, Suspense } from 'react';
import { fetchAssetsManifest, downloadCharacter, downloadStage, getStageDefPath } from '@/lib/character-downloader';

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
        const aspectParam = searchParams.get('aspect') || '4:3';

        // Map aspect param to resolution for vfs.js
        // 'low' = 320×240 (fastest), '4:3' = 640×480, '16:9' = 1280×720
        let ikemenAspect: any;
        if (aspectParam === '16:9') ikemenAspect = '16:9';
        else if (aspectParam === 'low') ikemenAspect = { w: 320, h: 240 };
        else ikemenAspect = '4:3'; // default

        log(`Match: P1=${p1} vs P2=${p2}${p2ai ? ` (CPU lv${p2ai})` : ''}`);
        log(`Stage: ${stage}`);
        log(`Aspect: ${aspectParam} → ${typeof ikemenAspect === 'object' ? `${ikemenAspect.w}×${ikemenAspect.h}` : ikemenAspect}`);

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
        // Lower resolutions render fewer pixels → faster gameplay.
        // 'low' (320×240) is 16x fewer pixels than 16:9 (1280×720).
        (g as any).ikemenAspect = ikemenAspect;

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
        // GC settings:
        // - GOGC=50: More frequent, shorter GC pauses (better for smoothness
        //   than fewer/longer pauses). Claude's analysis: with frame-skip yield
        //   now working (F-027), the engine can recover between pauses.
        //   energyjp tested 200/500 (worse) but never tested LOWER than 100.
        // - GODEBUG=gctrace=1: Prints GC events to console for diagnosis.
        //   Each line shows: gc N @time X%: mark+term ms, heap MB→MB→MB
        //   Zero overhead beyond console output, can be removed later.
        go.env = {
          GOGC: '50',
          GOMEMLIMIT: '800MiB',
          GODEBUG: 'gctrace=1',
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
        // Other characters are fetched from jsDelivr CDN and injected into VFS.
        //
        // IMPORTANT: addChar() expects just the character ID (e.g. 'kfm' or
        // '!Nightwing-o'), NOT the full path. It internally looks for
        // chars/<id>/<id>.def. Passing a full path breaks relative path
        // resolution in the .def file (sprite = X.sff can't be found).
        // addStage() expects the full path (e.g. 'stages/DU_Campus.def').
        let p1Path = p1; // character ID (e.g. 'kfm' or '!Nightwing-o')
        let p2Path = p2;
        let stagePath = stage; // full path (e.g. 'stages/stage0-720.def')

        const isBundledChar = (id: string) => id === 'kfm';
        const isBundledStage = (s: string) => s === 'stages/stage0-720.def';

        if (!isBundledChar(p1) || !isBundledChar(p2) || !isBundledStage(stage)) {
          log('Fetching character roster from CDN...');
          const manifest = await fetchAssetsManifest();

          // Download P1 if not bundled
          if (!isBundledChar(p1)) {
            const char = manifest.characters.find(c => c.id === p1);
            if (char) {
              log(`Downloading P1: ${char.displayName} (~${char.sizeMB} MB)...`);
              await downloadCharacter(char, (pct, msg) => {
                setBootLine('[P1] ', `${msg} (${pct}%)`);
              });
              p1Path = char.id; // just the ID, not the full path
              log(`P1 ready: ${char.id}`);
            } else {
              log(`ERROR: Character "${p1}" not found in manifest`);
            }
          }

          // Download P2 if not bundled
          if (!isBundledChar(p2)) {
            const char = manifest.characters.find(c => c.id === p2);
            if (char) {
              log(`Downloading P2: ${char.displayName} (~${char.sizeMB} MB)...`);
              await downloadCharacter(char, (pct, msg) => {
                setBootLine('[P2] ', `${msg} (${pct}%)`);
              });
              p2Path = char.id; // just the ID
              log(`P2 ready: ${char.id}`);
            } else {
              log(`ERROR: Character "${p2}" not found in manifest`);
            }
          }

          // Download stage if not bundled
          if (!isBundledStage(stage)) {
            const stg = manifest.stages.find(s => s.id === stage);
            if (stg) {
              log(`Downloading stage: ${stg.displayName} (~${stg.sizeMB} MB)...`);
              await downloadStage(stg, (pct, msg) => {
                setBootLine('[STAGE] ', `${msg} (${pct}%)`);
              });
              stagePath = getStageDefPath(stg); // full path for stages
              log(`Stage ready: ${stagePath}`);
            } else {
              log(`ERROR: Stage "${stage}" not found in manifest, using default`);
              stagePath = 'stages/stage0-720.def';
            }
          }
        }

        if (cancelled) return;

        // --- 9. Build go.argv with the resolved character/stage paths ---
        log('Engine starting... (quick match, bypassing menu)');
        go.argv = [
          'ikemen',
          '-qp1', p1Path,
          '-qp2', p2Path,
          '-qstage', stagePath,
          '-qp2ai', String(p2ai),
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
