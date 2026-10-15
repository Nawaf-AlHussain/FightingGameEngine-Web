'use client';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, useCallback, Suspense } from 'react';
import {
  fetchAssetsManifest,
  downloadAndInjectCharacter,
  downloadAndInjectStage,
  downloadCharacterToCache,
  downloadStageToCache,
  getCachedCharacterFiles,
  getCachedStageFiles,
  getStageDefPath,
  injectCharacterFiles,
  injectStageFiles,
  charRef,
  splitCharRef,
} from '@/lib/character-downloader';
import { useIsTouchDevice } from '@/lib/use-touch-device';
import RotateOverlay from '@/components/RotateOverlay';
import { ErrorState, GameButton } from '@/components/ui';
import { readFightResult, clearFightResult, processFightResult, getCurrentModeState, markFightStart } from '@/lib/game-modes';
import { getDisplayModeMarker } from '@/lib/engine-config';
import CharacterSelect from '@/components/CharacterSelect';
import StageSelect from '@/components/StageSelect';

// This page loads the WebAssembly engine and starts a fight directly,
// bypassing the laggy menu (F-026) using the smooth game() path.
//
// How it works:
// 1. React reads match params from URL (?p1=<char>&p2=<char>&stage=<stage>&p2ai=5)
// 2. Loads vfs.js, downloads any non-bundled characters from CDN
// 3. Injects them into the VFS
// 4. Boots the engine with -qp1/-qp2/-qstage CLI flags
// 5. main.lua calls main.f_quickMatch() which uses the smooth game() path
//
// This avoids both:
// - The laggy menu (GC pressure from unoptimized menu rendering — F-026)
// - The f_commandLine loading/compilation freeze (F-022 through F-025)

// ---- Online (net=1) flow types ---------------------------------------------
// The whole online experience lives on the /play page so the WebRTC session
// survives from the room-code exchange through character/stage select into
// the engine boot — navigating pages would drop the connection.

type NetPhase =
  | 'idle'        // not an online boot
  | 'role'        // HOST GAME / JOIN GAME pick
  | 'connecting'  // room-code panel (bridge) until the channel is open
  | 'charselect'  // both players pick their fighter on the site
  | 'stageselect' // host picks the stage
  | 'waiting'     // guest spectates while the host picks the stage
  | 'fight'       // engine booting / running with the agreed roster
  | 'error';      // connection lost / setup failed

interface NetFightConfig {
  /** Host's fighter (engine side 1). */
  p1: string;
  /** Guest's fighter (engine side 2). */
  p2: string;
  /** Stage id (bundled path or manifest id — same format as /local). */
  stage: string;
}

/**
 * Display mode synced for an online fight ('4:3' | '16:9').
 *
 * The engine's netplay handshake REFUSES peers whose effective fight
 * aspect differs ("effective fight aspect differs (local=custom:4:3
 * remote=stage)"): a 4:3-mode host paired with a 16:9 default guest
 * (the classic PC + phone combo) exited the engine before the fight
 * started. The host's display mode rides the 'go' control frame and the
 * guest adopts it via vfs.js engineApplyDisplayMode() before the engine
 * boots — host-authoritative, in-memory only.
 */
type NetDisplayMode = '4:3' | '16:9';

/**
 * WASM heap ceiling (GOMEMLIMIT) for the engine's Go runtime.
 *
 * WHY THIS EXISTS — the "phone page restarts" crash: the engine boots with
 * GOGC=off (no automatic GC mid-round — a desktop smoothness optimization),
 * so the WASM linear memory grows until GOMEMLIMIT forces a collection.
 * With the 800MiB ceiling the engine was ALLOWED to balloon to ~800MB of
 * WASM heap ON TOP OF the JS-side footprint in the same tab (game.pak
 * ~11MB + background-prefetched menu assets ~18MB + the 23MB WASM binary +
 * injected character/stage files — some roster picks are 40-100MB — plus
 * WebGL textures sharing the phone's RAM). Android Chrome and iOS Safari
 * kill the renderer when the tab crosses what the OS tolerates — the user
 * sees the page reload: the intermittent "sometimes my phone restarts the
 * page" report. Which characters are picked (median 11MB vs 102MB
 * EX_janemba) and how long the round runs is why it only happens SOMETIMES.
 *
 * On memory-constrained / mobile devices the ceiling drops to 400MiB: GC
 * still does not run mid-round (smoothness preserved — it only fires when
 * the heap actually approaches the limit, i.e. 1-2 late-round collections
 * instead of none), but the tab's peak stays inside a phone's budget.
 * Desktop keeps the tuned 800MiB behavior byte-for-byte.
 *
 * Device signal: navigator.deviceMemory (approx GB, Chrome/Android —
 * capped at 8). Safari/Firefox don't expose it; there the mobile-UA +
 * touch heuristic covers phones (including iOS, whose per-page limit is
 * the strictest). SSR-safe: the page prerenders without navigator.
 */
function detectMemoryConstrained(): boolean {
  if (typeof navigator === 'undefined') return false;
  const dm = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
  const mobileUA = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const mobileTouch = mobileUA && (navigator.maxTouchPoints || 0) > 0;
  // NOTE: the expression MUST start on this line — a newline after `return`
  // would trigger ASI and make the function return undefined unconditionally.
  return (typeof dm === 'number' && dm > 0 && dm <= 4) ||
    (dm === undefined && mobileTouch);
}

// Computed once at chunk evaluation; shared by the heap ceiling and the
// background-warmup gating so every memory decision uses ONE signal.
const MEMORY_CONSTRAINED = detectMemoryConstrained();

const WASM_HEAP_LIMIT_MIB = ((): number => {
  if (typeof navigator === 'undefined') return 800;
  return MEMORY_CONSTRAINED ? 400 : 800;
})();

// Background warmup cap for memory-constrained devices: lazy files LARGER
// than this are skipped (loaded on demand only when actually used). The
// lazy set is ~15 MB of which system.sff (~9.2 MB) + system.snd (~3.7 MB)
// are 88% — holding all of it resident costs a phone tab whose budget is
// already fought over by the WASM heap + WebGL + injected characters.
const VFS_PREFETCH_MAX_FILE_BYTES = 512 * 1024;

// Captured BEFORE the VFS fetch rewrite is installed (boot time), so the
// wasm/manifest fetches below always bypass the VFS patch — the same
// guarantee the boot path's originalFetch used to provide.
const moduleFetch: typeof fetch =
  typeof window !== 'undefined'
    ? window.fetch.bind(window)
    : (globalThis as any).fetch;

// ---- Module-scope engine runtime (local-mode mirror of the net=1 preboot) --
// This chunk evaluates the moment the browser parses it — BEFORE React
// hydration, before any effect. Kicking the manifest fetch + wasm download
// + compile there overlaps the ~5.3 MB engine download with hydration and
// the boot log's own work instead of serializing behind them. The singleton
// is shared by EVERY boot path (local, net=1, net=direct), so the engine is
// fetched + compiled exactly once per page load no matter which flow runs
// or how often React remounts (StrictMode-safe by construction).
interface EngineRuntime {
  go: any;
  wasmPromise: Promise<WebAssembly.WebAssemblyInstantiatedSource>;
}
let engineRuntimePromise: Promise<EngineRuntime> | null = null;

// The manifest is its OWN singleton so the .pak load can start as soon as
// the manifest is known — without waiting for the wasm compile to finish
// (pak and wasm must download in parallel; that overlap is the single
// biggest boot-window win).
let manifestPromiseSingleton: Promise<{ stamp?: string }> | null = null;
function ensureAssetManifest(): Promise<{ stamp?: string }> {
  if (!manifestPromiseSingleton) {
    // no-store (war story: some middleboxes ignore revalidation).
    manifestPromiseSingleton = moduleFetch('/game/engine-fs/manifest.json', { cache: 'no-store' })
      .then(r => {
        if (!r.ok) throw new Error('asset manifest HTTP ' + r.status);
        return r.json() as Promise<{ stamp?: string }>;
      });
    manifestPromiseSingleton.catch(() => {});
  }
  return manifestPromiseSingleton;
}

function ensureEngineRuntime(): Promise<EngineRuntime> {
  if (engineRuntimePromise) return engineRuntimePromise;
  engineRuntimePromise = (async (): Promise<EngineRuntime> => {
    // wasm_exec.js defines the Go class — required before instantiation.
    // Preloaded at module scope below, so this is usually instant.
    await loadScript('/game/wasm_exec.js');
    const g = globalThis as any;
    const manifestData = await ensureAssetManifest();
    const go = new g.Go();
    go.env = {
      GOGC: 'off',
      GOMEMLIMIT: WASM_HEAP_LIMIT_MIB + 'MiB',
    };
    // Record the engine's exit code. The shipped wasm_exec.js resolves
    // run() normally on os.Exit, so without this an engine that dies at
    // boot is indistinguishable from a finished fight - it used to bounce
    // the player to the lobby with zero explanation.
    try {
      const prevExit = go.exit;
      go.exit = (code: number) => {
        (globalThis as any).__engineExitCode = code;
        if (prevExit) prevExit.call(go, code);
      };
    } catch { /* diagnostics must never block boot */ }
    const wasmPromise = instantiateEngineWasm(
      moduleFetch,
      go,
      manifestData.stamp || '',
      (s: string) => console.log('[boot]', s),
    );
    // A visitor who bounces off /play before any boot awaits the runtime
    // must not produce unhandled-rejection noise; real awaiters still see
    // the failure through their own await.
    wasmPromise.catch(() => {});
    return { go, wasmPromise };
  })();
  engineRuntimePromise.catch(() => {});
  return engineRuntimePromise;
}

// Preload the boot scripts while React hydrates: the <link>s go in at chunk
// evaluation, so by the time the boot effect runs, both files are already in
// the memory cache and loadScript() resolves without a fresh round-trip.
// (Both scripts are shared by every boot path — including net=1's preboot.)
if (typeof document !== 'undefined') {
  for (const preloaded of ['/game/vfs.js', '/game/wasm_exec.js']) {
    if (!document.querySelector(`link[rel="preload"][href="${preloaded}"]`)) {
      const link = document.createElement('link');
      link.rel = 'preload';
      link.as = 'script';
      link.href = preloaded;
      document.head.appendChild(link);
    }
  }
}

function PlayPageInner() {
  const bootRef = useRef<HTMLPreElement>(null);
  const searchParams = useSearchParams();
  const isTouch = useIsTouchDevice();
  // Touch controls are shown after the boot log fades (i.e., engine is running).
  // We toggle this true once go.run() is called.
  const [engineRunning, setEngineRunning] = useState(false);
  // Exit confirmation — show a small floating X on touch devices.
  const [showExit, setShowExit] = useState(false);
  // Boot failure — shown as a structured ErrorState overlay (Frontend 2.1
  // spec Section 33: what failed, can the user retry, can they go back).
  // The boot log below remains available as "Technical Details".
  const [bootError, setBootError] = useState<string | null>(null);

  // ---- Online (net=1) flow state ----
  // bootEngine() runs the preboot (game data + netplay bridge), then parks
  // on a promise that this state machine resolves with the final match
  // config once both players picked fighters (and the host a stage).
  const isNetFlow = (searchParams.get('net') || '') === '1';
  const [netPhase, setNetPhase] = useState<NetPhase>('idle');
  const [netRole, setNetRole] = useState<'host' | 'join'>('host');
  const [netBridgeStarted, setNetBridgeStarted] = useState(false);
  const [netMine, setNetMine] = useState<{ id: string | null; locked: boolean }>({ id: null, locked: false });
  const [netOpp, setNetOpp] = useState<{ id: string | null; locked: boolean; liveIdx: number | null }>({ id: null, locked: false, liveIdx: null });
  const [netError, setNetError] = useState<string | null>(null);
  const netRoleRef = useRef<'host' | 'join'>('host');
  const netResolveRef = useRef<((cfg: NetFightConfig | null) => void) | null>(null);
  // Display mode synced for this online fight (host: its own choice;
  // guest: the mode adopted from the host). Logged after the park.
  const netSyncedModeRef = useRef<NetDisplayMode | null>(null);
  const vfsPromiseRef = useRef<Promise<number> | null>(null);

  // ---- Incoming website-level control frames from the opponent ----
  // (IKWS frames over the bridge data channel — selection sync, pre-boot.)
  const handleNetControl = useCallback((m: Record<string, unknown>) => {
    if (!m || typeof m !== 'object') return;
    const t = m.t;
    if (t === 'cursor') {
      const idx = typeof m.idx === 'number' ? m.idx : null;
      setNetOpp(prev => ({ ...prev, liveIdx: idx }));
    } else if (t === 'lock') {
      setNetOpp({
        id: typeof m.id === 'string' ? m.id : '',
        locked: true,
        liveIdx: typeof m.idx === 'number' ? m.idx : null,
      });
    } else if (t === 'unlock') {
      setNetOpp(prev => ({ ...prev, locked: false }));
    } else if (t === 'go') {
      // Guest: the host finalised the match (both fighters + stage).
      const p1 = typeof m.p1 === 'string' ? m.p1 : '';
      const p2 = typeof m.p2 === 'string' ? m.p2 : '';
      const stage = typeof m.stage === 'string' ? m.stage : '';
      if (!p1 || !p2 || !stage) return;
      // Host-authoritative display-mode sync: the engine's netplay check
      // refuses mismatched fight aspects, so the guest adopts the host's
      // display mode (in-memory config patch) BEFORE the engine boots.
      const dm = m.dm;
      if (dm === '4:3' || dm === '16:9') {
        netSyncedModeRef.current = dm;
        try {
          const applied = (globalThis as any).engineApplyDisplayMode?.(dm);
          if (applied !== dm) {
            // Config missing or patch failed — the engine overlay would
            // report the aspect mismatch; nothing better to do here.
            console.log('[netplay] host display mode could not be applied:', dm);
          }
        } catch { /* engine overlay reports a real mismatch */ }
      }
      setNetPhase('fight');
      netResolveRef.current?.({ p1, p2, stage });
    }
  }, []);

  const handleNetPick = useCallback((charId: string | null, index: number) => {
    const net = (globalThis as any).ikemenNet;
    const wireRole = netRoleRef.current === 'join' ? 'guest' : 'host';
    if (charId) {
      setNetMine({ id: charId, locked: true });
      try { net?.control?.({ t: 'lock', role: wireRole, id: charId, idx: index }); } catch { /* poller reports drops */ }
    } else {
      setNetMine(prev => ({ ...prev, locked: false }));
      try { net?.control?.({ t: 'unlock', role: wireRole }); } catch { /* poller reports drops */ }
    }
  }, []);

  const handleNetCursor = useCallback((index: number) => {
    const net = (globalThis as any).ikemenNet;
    try { net?.control?.({ t: 'cursor', role: netRoleRef.current === 'join' ? 'guest' : 'host', idx: index }); } catch { /* ignore */ }
  }, []);

  // Role picked → connect: wait for the .pak (the build-check hash is
  // computed at the end of vfs init), fetch the roster manifest (its digest
  // rides the bridge's build check — MUST be set before net.start, which
  // sends the hash the moment the channel opens), then open the bridge room
  // panel.
  const handleNetRolePick = useCallback(async (role: 'host' | 'join') => {
    setNetRole(role);
    netRoleRef.current = role;
    setNetPhase('connecting');
    try {
      if (vfsPromiseRef.current) await vfsPromiseRef.current;
      // Mandatory (not best-effort): a client WITHOUT the roster fingerprint
      // would false-refuse against every client that has it, so a failed
      // fetch here blocks the flow with a retryable error instead.
      const roster = await fetchAssetsManifest();
      console.log('[netplay] roster manifest v' + roster.version +
        ((globalThis as any).engineRosterHex ? ' (' + (globalThis as any).engineRosterHex + ')' : ''));
      const net = (globalThis as any).ikemenNet;
      if (!net) throw new Error('Netplay bridge not loaded');
      net.start(role);
      setNetBridgeStarted(true);
    } catch (e) {
      setNetError(e instanceof Error ? e.message : String(e));
      setNetPhase('error');
      netResolveRef.current?.(null);
    }
  }, []);

  // Host locked the stage → finalise and boot both engines.
  const handleNetStage = useCallback((stageId: string) => {
    if (!netMine.id || !netOpp.id) return;
    // Prefetch the chosen stage OUT of the boot memory window (same crash
    // family as the opponent-char prefetch below). The guest learns the
    // stage only at 'go' and pulls it through the boot fallback, which now
    // also persists it. Fire-and-forget: the boot path cache-hits or
    // piggybacks on the shared in-flight download registry.
    (async () => {
      try {
        const manifest = await fetchAssetsManifest();
        const stg = manifest.stages.find(s => s.id === stageId);
        if (stg) await downloadStageToCache(stg);
      } catch { /* boot fallback reports real failures */ }
    })();
    const cfg: NetFightConfig = { p1: netMine.id, p2: netOpp.id, stage: stageId };
    // The guest adopts OUR display mode (fight aspects must match for the
    // engine's netplay check — a 4:3 host cannot pair with a 16:9 guest).
    const dm: NetDisplayMode = getDisplayModeMarker() ?? '16:9';
    netSyncedModeRef.current = dm;
    const net = (globalThis as any).ikemenNet;
    try {
      net?.control?.({ t: 'go', p1: cfg.p1, p2: cfg.p2, stage: stageId, dm });
    } catch { /* the poller reports real drops */ }
    setNetPhase('fight');
    netResolveRef.current?.(cfg);
  }, [netMine.id, netOpp.id]);

  const cancelNetFlow = useCallback(() => {
    try { (globalThis as any).ikemenNet?.close?.(); } catch { /* already gone */ }
    netResolveRef.current?.(null);
    try { sessionStorage.removeItem('engine-boot-live'); } catch { /* ignore */ }
    window.location.href = '/lobby';
  }, []);

  // ---- Opponent prefetch (online flow) --------------------------------------
  // Only MY fighter gets cached (on lock-in, inside CharacterSelect). The
  // OPPONENT's fighter used to download INSIDE the boot memory window —
  // on phones that spike killed the renderer mid-boot: the page refreshed
  // once, then played (retry found the assets cached). Cache it the moment
  // the opponent locks instead; the boot path then cache-hits or piggybacks
  // on the shared in-flight download registry.
  const netOppPrefetchRef = useRef<string | null>(null);
  useEffect(() => {
    const ref = netOpp.id;
    if (!ref || netOppPrefetchRef.current === ref) return;
    netOppPrefetchRef.current = ref;
    (async () => {
      try {
        const manifest = await fetchAssetsManifest();
        const char = manifest.characters.find(c => charRef(c) === ref);
        if (char) await downloadCharacterToCache(char);
      } catch { /* boot fallback reports real failures */ }
    })();
  }, [netOpp.id]);

  // ---- Connection watcher for the online flow ----
  // 'connecting' waits for the bridge to report established; afterwards a
  // few consecutive dead polls (or an explicit failure) end the flow.
  useEffect(() => {
    if (!['connecting', 'charselect', 'stageselect', 'waiting'].includes(netPhase)) return;
    let misses = 0;
    const timer = setInterval(() => {
      const net = (globalThis as any).ikemenNet;
      if (!net) return;
      if (netPhase === 'connecting') {
        if (typeof net.connected === 'function' && net.connected()) {
          setNetMine({ id: null, locked: false });
          setNetOpp({ id: null, locked: false, liveIdx: null });
          setNetPhase('charselect');
        } else if (typeof net.failed === 'function' && net.failed()) {
          setNetError('Connection failed. Both players should retry (a VPN or hotspot can help stubborn routers).');
          setNetPhase('error');
          netResolveRef.current?.(null);
        }
        return;
      }
      if (typeof net.connected === 'function' && net.connected()) {
        misses = 0;
        return;
      }
      misses += 1;
      if (misses >= 4 || (typeof net.failed === 'function' && net.failed())) {
        setNetError('Lost connection to your opponent.');
        setNetPhase('error');
        netResolveRef.current?.(null);
      }
    }, 500);
    return () => clearInterval(timer);
  }, [netPhase]);

  // ---- Online phase machine ----
  // Both picks in → host goes to stage select, guest to the waiting view.
  // A re-pick walks the phase back so the other side sees it live.
  useEffect(() => {
    if (netPhase === 'charselect') {
      if (netRole === 'host' && netMine.locked && netOpp.locked) setNetPhase('stageselect');
      if (netRole === 'join' && netMine.locked) setNetPhase('waiting');
    } else if (netPhase === 'stageselect') {
      if (!netMine.locked || !netOpp.locked) setNetPhase('charselect');
    } else if (netPhase === 'waiting') {
      if (!netMine.locked) setNetPhase('charselect');
    }
  }, [netPhase, netRole, netMine.locked, netOpp.locked]);

  // ---- Deep link (the host's QR / a shared link): /play?net=1&join=CODE ----
  // Skip the role screen and drive the bridge straight into joining.
  // webrtc.js reads the same URL params and prefills (and auto-fires) the
  // room panel, so the scanned guest touches nothing at all.
  const autoJoinCode = (searchParams.get('join') || '').trim().toLowerCase();
  useEffect(() => {
    if (!isNetFlow || !autoJoinCode || netPhase !== 'role') return;
    const t = setTimeout(() => { handleNetRolePick('join'); }, 300);
    return () => clearTimeout(t);
  }, [isNetFlow, autoJoinCode, netPhase, handleNetRolePick]);


  // ---- Load vanilla JS touch overlay on touch devices when engine starts ----
  // touch.js is a self-contained IIFE that creates its own DOM (circular D-pad
  // + two-arc action buttons + START/ESC pills). Bindings are hardcoded to the
  // engine's built-in P1 layout (arrows + z/x/c/a/s/d — see touch.js header;
  // the engine ignores config.ini key sections, and config-derived bindings
  // were the root cause of the wrong-player touch bug family). No React
  // dependency — simpler and more reliable than the old React TouchControls.
  useEffect(() => {
    if (!isTouch || !engineRunning) return;
    const script = document.createElement('script');
    // Cache-buster: public/game files are served must-revalidate, but some
    // mobile browsers / PWA contexts have been observed keeping stale copies.
    // A versioned URL makes a stale touch.js impossible after a deploy.
    // IMPORTANT: bump this together with the BUILD constant inside touch.js.
    script.src = '/game/touch.js?v=2026-10-07.1';
    script.onload = () => {
      const g = globalThis as any;
      if (g.__engineTouch?.build) g.__engineTouch.build();
    };
    document.head.appendChild(script);
    return () => {
      const g = globalThis as any;
      if (g.__engineTouch?.destroy) g.__engineTouch.destroy();
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
    // Always go back after a short delay (in case the engine's escape
    // handler doesn't fire or doesn't quit the match). Online fights go to
    // the lobby — there is no website select session to return to.
    setTimeout(() => {
      window.location.href = isNetFlow ? '/lobby' : '/local';
    }, 500);
  };

  useEffect(() => {
    let cancelled = false;

    async function bootEngine() {
      const boot = bootRef.current;
      if (!boot) return;

      // Online (net=1) fights return to the lobby — there is no website
      // select session to go back to mid-flow. Computed here because the
      // catch block below sits outside the try scope where netMenu lives.
      const exitTarget = (searchParams.get('net') || '') === '1' ? '/lobby' : '/local';

      // NOTE: no touch-binding config snapshot here anymore. touch.js no
      // longer parses config.ini — the engine ignores config key sections for
      // fight input (proven via keymap-probe.mjs), so the overlay hardcodes
      // the engine's built-in P1 layout instead. Parsing config copies was
      // the root cause of touch dispatching keys the engine had not bound.

      let onKeyDown: ((e: KeyboardEvent) => void) | null = null;
      let onKeyUp: ((e: KeyboardEvent) => void) | null = null;
      let clickHandler: (() => void) | null = null;
      // Deferred lazy-asset warmup timers (see scheduleVfsPrefetch below).
      let prefetchPoll: ReturnType<typeof setInterval> | null = null;
      let prefetchTimer: ReturnType<typeof setTimeout> | null = null;
      // Canvas-fitter teardown, assigned once installCanvasFit() runs below
      // (inside the try block - this outer handle lets cleanup() reach it).
      let canvasFitCleanup: (() => void) | null = null;
      // Online (net=1) fight config — filled by the preboot park below.
      let netFightCfg: NetFightConfig | null = null;
      // Set right before go.run() - lets the exit handlers below tell a real
      // fight (ran for a while, canvas up) apart from a boot-time death.
      let engineStartAt = 0;
      // Graphics-death tripwire: a WebGL context loss (GPU driver reset /
      // GPU-memory exhaustion - the Huawei Chrome failure class) can kill the
      // engine WITHOUT a Go panic line, so the exit paths below would
      // silently bounce the player to the select screen. The engine creates
      // its own canvas, so this listens on document in the capture phase
      // (context-lost does not bubble, but capture still reaches it).
      let glContextLost = false;
      const onContextLost = (ev: Event) => {
        glContextLost = true;
        ev.preventDefault(); // let the engine attempt whatever restore it wants
      };

      const cleanup = () => {
        if (onKeyDown) window.removeEventListener('keydown', onKeyDown, true);
        if (onKeyUp) window.removeEventListener('keyup', onKeyUp, true);
        if (clickHandler) document.removeEventListener('click', clickHandler);
        // The canvas fitter used to be torn down only after a SUCCESSFUL
        // go.run() - every boot failure / engine panic leaked its resize,
        // visualViewport resize/scroll listeners and the rAF canvas poll.
        if (canvasFitCleanup) canvasFitCleanup();
        if (prefetchPoll) { clearInterval(prefetchPoll); prefetchPoll = null; }
        if (prefetchTimer) { clearTimeout(prefetchTimer); prefetchTimer = null; }
        document.removeEventListener('webglcontextlost', onContextLost, true);
      };

      // --- Boot-death recorder (the "first match refreshes once" family) ---
      // When a phone's renderer is killed mid-boot, the browser auto-reloads
      // the SAME tab and sessionStorage survives that crash-reload. Park the
      // boot log there line-by-line under a live-marker; orderly exits clear
      // the marker (see clearBootLive below). If the next boot finds the
      // marker, the previous boot died abruptly — surface exactly what it
      // was doing last, so the refresh reports itself instead of relying on
      // the user's memory of what the screen showed.
      const recordBootLine = (line: string) => {
        try {
          const prev = sessionStorage.getItem('engine-bootlog');
          const lines = prev ? prev.split('\n') : [];
          lines.push(line);
          sessionStorage.setItem('engine-bootlog', lines.slice(-60).join('\n'));
        } catch { /* private mode / quota — diagnostics only, never fatal */ }
      };
      const clearBootLive = () => {
        try { sessionStorage.removeItem('engine-boot-live'); } catch { /* ignore */ }
      };

      // The boot log mirrors its lines in JS (bootLines + a prefix→index map)
      // instead of re-parsing the DOM. Rationale (Batch 4): progress callbacks
      // ([PAK]/[P1]/[P2]/[STAGE]) can fire hundreds of times a second on a
      // fast connection, and each update used to split the WHOLE log text,
      // linear-scan for the prefix, rejoin, rewrite the <pre>, force layout
      // via scrollTop AND append to the sessionStorage bootlog — five costs
      // per tick for one changing line. Now: O(1) line update in the buffer,
      // ONE DOM write per animation frame (flushBoot), and progress snapshots
      // recorded to the crash-diagnosis bootlog at most once per second per
      // prefix (the next log() line records the final value anyway).
      const bootLines: string[] = [];
      const liveLineIdx = new Map<string, number>();
      let bootFlushScheduled = false;
      let bootTextDirty = false;
      const flushBoot = () => {
        bootFlushScheduled = false;
        if (cancelled || !bootTextDirty) return;
        bootTextDirty = false;
        boot.textContent = bootLines.join('\n');
        boot.scrollTop = boot.scrollHeight;
      };
      const scheduleBootFlush = () => {
        if (bootFlushScheduled) return;
        bootFlushScheduled = true;
        requestAnimationFrame(flushBoot);
      };

      const log = (msg: string) => {
        if (cancelled) return;
        bootLines.push(msg);
        bootTextDirty = true;
        scheduleBootFlush();
        console.log('[boot]', msg);
        recordBootLine(msg);
      };

      // In-place line update for progress displays ([PAK]/[P1]/[P2]/[STAGE]).
      // Hoisted here so the online preboot can show .pak progress too.
      const liveRecordedAt = new Map<string, number>();
      const setBootLine = (prefix: string, text: string) => {
        if (cancelled) return;
        const line = prefix + text;
        const idx = liveLineIdx.get(prefix);
        if (idx !== undefined) bootLines[idx] = line;
        else {
          liveLineIdx.set(prefix, bootLines.length);
          bootLines.push(line);
        }
        bootTextDirty = true;
        scheduleBootFlush();
        // Crash-diagnosis value is "what was it doing when it died" — a 1s
        // stale progress snapshot answers that just as well as 60 per second.
        const now = Date.now();
        if (now - (liveRecordedAt.get(prefix) || 0) >= 1000) {
          liveRecordedAt.set(prefix, now);
          recordBootLine(line);
        }
      };

      {
        let prevLive: string | null = null;
        let prevLog = '';
        try {
          prevLive = sessionStorage.getItem('engine-boot-live');
          prevLog = sessionStorage.getItem('engine-bootlog') || '';
        } catch { /* ignore */ }
        if (prevLive) {
          const last = prevLog.split('\n').filter(Boolean).slice(-3).join('  |  ');
          log('PREVIOUS BOOT ON THIS TAB ENDED ABRUPTLY (likely the phone killed the renderer mid-boot).');
          log('Last activity before the refresh: ' + (last || '(no boot log recorded)'));
        }
        try { sessionStorage.setItem('engine-bootlog', ''); } catch { /* ignore */ }
      }
      try { sessionStorage.setItem('engine-boot-live', String(Date.now())); } catch { /* ignore */ }

      try {
        // --- Read match parameters from URL ---
        // Nothing is bundled in game.pak anymore (kfm + the training stage
        // were removed from the engine), so every fight must name both
        // fighters and a stage. net=1 resolves its roster later via the
        // lobby select flow, so it is exempt from this check.
        const p1 = searchParams.get('p1') || '';
        const p2 = searchParams.get('p2') || '';
        const stage = searchParams.get('stage') || '';
        if (searchParams.get('net') !== '1' && (!p1 || !p2 || !stage)) {
          throw new Error('Missing match parameters - /play needs ?p1=<char>&p2=<char>&stage=<stage-id>. Start a fight from the select screen instead of typing this URL by hand.');
        }
        const p2ai = searchParams.get('p2ai'); // null = human, number = AI level
        const p1ai = searchParams.get('p1ai') || '0'; // 0 = human, >0 = AI level
        const training = searchParams.get('training') || '0';
        const time = searchParams.get('time') || '99';
        // NOTE: 'aspect' URL param is no longer used. The display mode is
        // controlled by the Settings UI (or /local RES toggle) via the
        // persisted config.ini (written by applyDisplayModeChoice). vfs.js
        // reads the config on boot; this is the single source of truth.
        //
        // Presentation (ONE path for every display mode): the canvas is
        // displayed at its intrinsic aspect ratio, fitted to the largest
        // size that fully fits inside the viewport (contain), centered.
        // The 16:9 modes render at a 16:9 canvas and the 4:3 mode renders
        // at a genuine 4:3 canvas (960x720 + FightAspect=4,3 — the engine's
        // native 4:3, with MORE vertical stage content than 16:9), so plain
        // contain-fit is correct at both aspects: wide viewports pillarbox
        // a 4:3 canvas, tall/narrow viewports letterbox a 16:9 canvas, and
        // the picture itself is always undistorted and uncropped.
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
          canvas.style.setProperty('object-fit', 'contain', 'important');
          canvas.style.setProperty('object-position', 'center', 'important');
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
          style.id = 'engine-canvas-fit';
          style.textContent = [
            'html, body { overflow: hidden !important; }',
            // object-fit / object-position are set inline (always contain —
            // the canvas aspect always matches the chosen display mode).
            'canvas#ikemen-canvas { display: block !important; margin: 0 !important; }',
          ].join('\n');
          document.head.appendChild(style);
          document.body.classList.add('fighting');

          // Do not observe the whole document while the engine is running.
          // The engine and the touch overlay can mutate the DOM frequently;
          // a subtree MutationObserver would turn unrelated DOM changes into
          // canvas layout work. The canvas is created during engine startup,
          // so wait for it with a short rAF bootstrap loop, then only react to
          // actual viewport changes.
          let rafId = 0;
          let resizeQueued = false;

          const fitOnNextFrame = () => {
            if (resizeQueued) return;
            resizeQueued = true;
            rafId = requestAnimationFrame(() => {
              resizeQueued = false;
              fitCanvasToViewport();
            });
          };

          const waitForCanvas = () => {
            if (fitCanvasToViewport()) return;
            rafId = requestAnimationFrame(waitForCanvas);
          };

          const onResize = () => fitOnNextFrame();
          window.addEventListener('resize', onResize);
          window.visualViewport?.addEventListener('resize', onResize);
          window.visualViewport?.addEventListener('scroll', onResize);

          waitForCanvas();

          return () => {
            if (rafId) cancelAnimationFrame(rafId);
            window.removeEventListener('resize', onResize);
            window.visualViewport?.removeEventListener('resize', onResize);
            window.visualViewport?.removeEventListener('scroll', onResize);
            document.getElementById('engine-canvas-fit')?.remove();
            document.body.classList.remove('fighting');
          };
        };

        const cleanupCanvasFit = installCanvasFit();
        canvasFitCleanup = cleanupCanvasFit;
        const qmode = searchParams.get('qmode') || 'quickvs'; // progression mode
        // Netplay modes (both use the WebRTC bridge - public/game/webrtc.js,
        // engine netplay_js.go):
        //   net=1      ONLINE MODE via the WEBSITE: role pick (host/join) and
        //              room codes on the site, then BOTH players pick their
        //              fighter (and the host the stage) on the site's own
        //              select screens — picks ride the bridge as IKWS control
        //              frames — and the engine boots into the fight with the
        //              agreed roster. NO engine-side menus at any point.
        //   net=direct boot straight into a netplay fight with the URL's fixed
        //              roster: -p1/-p2/-s + -ip ('' hosts, anything else joins -
        //              the address string is meaningless on the WebRTC build).
        //              Both players must open the SAME p1/p2/stage link.
        const netParam = searchParams.get('net') || '';
        const netMenu = netParam === '1';
        const netDirect = netParam === 'direct';
        const netMode = netMenu || netDirect;
        const netDirectRole = searchParams.get('role') === 'join' ? 'join' : 'host';

        if (!netMenu) {
          log(`Match: P1=${p1} vs P2=${p2}${p2ai ? ` (CPU lv${p2ai})` : ''}`);
          log(`Stage: ${stage}`);
          log(`Mode: ${qmode}`);
        }

        // --- 0. Install keyboard preventDefault handler ---
        // The engine listens for native keydown/keyup on document (via
        // system_js.go's addEventListener). We intercept at the window
        // level (capture phase) ONLY to call preventDefault on game keys
        // so the browser doesn't fire shortcuts (Ctrl+W, F5, backspace
        // navigation, etc.). We do NOT push to any array — the old
        // poll-based key bridge was dead code (the engine never read it).
        // Online (net=1) installs this AFTER the select screens are done —
        // they need the arrows/WASD for navigation.
        const heldKeys = new Set<string>();

        const installKeyboardGuard = () => {
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
        };
        if (!netMenu) installKeyboardGuard();

        // --- 1. Pin devicePixelRatio to 1 (glfw-js expects this) ---
        const g = globalThis as any;
        Object.defineProperty(window, 'devicePixelRatio', {
          value: 1, writable: false, configurable: true,
        });

        // --- 2. Patch VFS fetch base URL ---
        // Idempotent by marker: an in-realm re-boot (StrictMode double-mount,
        // hot reload) used to wrap ANOTHER rewriting layer around the
        // previous patch, stacking fetch closures for the lifetime of the
        // realm. Patch once; later boots reuse the recorded ORIGINAL fetch
        // so the wasm/CDN fetches below still bypass the rewrite.
        const originalFetch: typeof window.fetch =
          (window.fetch as any).__fgOriginal || window.fetch;
        const VFS_FILE_PREFIX = './engine-fs/file/';
        const VFS_MANIFEST_URL = './engine-fs/manifest.json';
        const STATIC_FILE_BASE = '/game/engine-fs/file/';
        const STATIC_MANIFEST = '/game/engine-fs/manifest.json';

        if (!(window.fetch as any).__fgPatched) {
          const patchedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input.toString();

            if (url.startsWith(VFS_FILE_PREFIX)) {
              const vpath = url.slice(VFS_FILE_PREFIX.length);
              const rewritten = STATIC_FILE_BASE + vpath;
              return originalFetch(rewritten, init);
            }

            if (url === VFS_MANIFEST_URL || url.startsWith('./engine-fs/manifest.json')) {
              return originalFetch(STATIC_MANIFEST, init);
            }

            return originalFetch(input, init);
          };
          (patchedFetch as any).__fgOriginal = originalFetch;
          (patchedFetch as any).__fgPatched = true;
          window.fetch = patchedFetch;
        }

        // --- 2a. Engine runtime (module-scope singleton, kicked at chunk
        // evaluation) + parallel VFS script load ---
        // The manifest fetch and the 5.3 MB wasm download/compile have been
        // running since before hydration — usually already resolved here.
        // vfs.js is only needed for engineVfsInit, so its load overlaps the
        // runtime's remaining wasm work (these two loaded SERIALLY before,
        // costing a full extra script round-trip on every boot).
        const runtimePromise = ensureEngineRuntime();
        const vfsScriptPromise = loadScript('/game/vfs.js');

        // --- 2b. Deferred warmup of the lazy VFS set (boot-window fix) ---
        // vfs.js no longer prefetches its ~18MB lazy menu/UI set inside
        // engineVfsInit — that download used to race the .pak, WASM compile
        // and character injection inside the boot window (the phone
        // first-start refresh family). The boot page starts it once the
        // engine is actually up: first canvas frame + 2s grace, with a
        // canvas-gated fallback so a missed frame signal still warms late
        // instead of never. A boot that never produced a canvas (failure)
        // never warms - no wasted megabytes on a dead page. cleanup()
        // revokes both timers.
        let vfsPrefetchStarted = false;
        const startVfsPrefetch = () => {
          if (vfsPrefetchStarted || cancelled) return;
          vfsPrefetchStarted = true;
          if (prefetchPoll) { clearInterval(prefetchPoll); prefetchPoll = null; }
          if (prefetchTimer) { clearTimeout(prefetchTimer); prefetchTimer = null; }
          try {
            // Memory-constrained devices warm only small files — the big
            // ones (system.sff/system.snd) load on demand when first used,
            // trading a one-time fetch on menu open for ~13 MB of always-
            // resident heap (the phone tab-kill/refresh family).
            const p = (g.engineVfsPrefetch as any)?.(
              undefined,
              MEMORY_CONSTRAINED ? { maxFileBytes: VFS_PREFETCH_MAX_FILE_BYTES } : undefined
            );
            log(MEMORY_CONSTRAINED
              ? 'VFS: warming small UI assets (large ones load on demand)...'
              : 'VFS: warming menu/UI assets in the background...');
            if (p && typeof p.catch === 'function') p.catch(() => {});
          } catch { /* warmup must never break the fight */ }
        };
        const scheduleVfsPrefetch = () => {
          if (vfsPrefetchStarted) return;
          if (prefetchPoll) clearInterval(prefetchPoll);
          prefetchPoll = setInterval(() => {
            if (document.querySelector('canvas#ikemen-canvas')) {
              if (prefetchPoll) { clearInterval(prefetchPoll); prefetchPoll = null; }
              prefetchTimer = setTimeout(startVfsPrefetch, 2000);
            }
          }, 250);
          prefetchTimer = setTimeout(() => {
            // Fallback: only if the engine really booted (canvas exists) but
            // the frame watcher above somehow missed it.
            if (document.querySelector('canvas#ikemen-canvas')) startVfsPrefetch();
          }, 20000);
        };

        // ---- ONLINE MODE (net=1): website flow, zero engine menus ----
        // Role pick, the room-code panel and the character/stage select
        // screens are all rendered by the netPhase state on THIS page, so
        // the WebRTC session stays alive from handshake to engine boot.
        // Everything after the park runs only once both players locked in
        // and the host picked the stage.
        if (netMenu) {
          log('Online mode: loading game data...');
          await vfsScriptPromise;
          if (cancelled) return;
          // Stamp source for the immutable wasm/pak URLs. Only the MANIFEST
          // is awaited here — the runtime's wasm download/compile keeps
          // running concurrently, so the .pak starts immediately (exactly
          // the overlap the old preboot had, plus a module-scope head start).
          const manifestData = await ensureAssetManifest();
          if (cancelled) return;
          g.engineAssetStamp = manifestData.stamp || '';
          // Start the .pak load NOW: the netplay build check exchanges a
          // hash that vfs init computes at its END, so it must be underway
          // before the handshake. The fight boot reuses this promise (a
          // second init would download everything twice). The manifest is
          // passed through so vfs init does not refetch it.
          vfsPromiseRef.current = (g.engineVfsInit as any)(
            '/game/engine-fs/manifest.json',
            [],
            (got: number, total: number) => {
              if (cancelled) return;
              const pct = total > 0 ? Math.round((got / total) * 100) : 0;
              setBootLine('[PAK] ', (got / 1e6).toFixed(1) + ' / ' + (total / 1e6).toFixed(1) + ' MB (' + pct + '%)');
            },
            manifestData
          );
          // The wasm compile started at module scope (the local-mode mirror
          // of this preboot) — it is already warming while the players are
          // in the lobby and the select screens.
          // Sanity-touch the runtime: resolves once the module-scope wasm
          // compile is done (the fight boot below reuses the same singleton).
          await runtimePromise;
          log('Loading netplay bridge...');
          await loadScript('/game/webrtc.js');
          if (cancelled) return;
          g.ikemenNet.onControl(handleNetControl);

          // Park until the website flow resolves the match config:
          // host locked the stage / guest received 'go' / cancel or drop.
          netFightCfg = await new Promise<NetFightConfig | null>((resolve) => {
            netResolveRef.current = resolve;
            setNetPhase('role');
          });
          netResolveRef.current = null;
          if (cancelled) return;
          if (!netFightCfg) {
            // Cancel navigates to /lobby on its own; a dropped connection
            // leaves the error UI up. Nothing more to boot here.
            log('Online match did not start.');
            return;
          }
          log(`Online match: P1=${netFightCfg.p1} vs P2=${netFightCfg.p2} (you are ${netRoleRef.current === 'join' ? 'P2/guest' : 'P1/host'})`);
          log(`Stage: ${netFightCfg.stage}`);
          // Roster fingerprint actually in play (visible in screenshots when
          // a mismatch is refused) — set at role pick, before net.start.
          if ((globalThis as any).engineRosterVersion) {
            log('Roster: manifest v' + (globalThis as any).engineRosterVersion +
              ((globalThis as any).engineRosterHex ? ' (' + (globalThis as any).engineRosterHex + ')' : ''));
          }
          // Display-mode sync result — the engine's netplay check refuses
          // mismatched fight aspects, so this line proves the fix ran.
          if (netSyncedModeRef.current) {
            log(`Display mode: ${netSyncedModeRef.current} ` + (netRoleRef.current === 'join'
              ? '(adopted from the host — fight aspects must match online)'
              : '(host — the guest adopts it)'));
          }
          installKeyboardGuard();
        }

        // --- 3. VFS script (kicked off at 2a, overlapped with the runtime) ---
        // (net=1 awaited it in the online preboot above; both scripts are
        // standalone IIFEs, so only the USAGE order matters: vfs.js before
        // engineVfsInit, wasm_exec.js before `new Go()` — both preserved.)
        if (!netMenu) {
          log('Loading virtual filesystem...');
          await vfsScriptPromise;
          if (cancelled) return;
        }

        // --- 3b. Load the netplay bridge (net=direct only — net=1 loaded
        // it in the online preboot above, before the select screens) ---
        if (netDirect) {
          log('Loading netplay bridge...');
          await loadScript('/game/webrtc.js');
          if (cancelled) return;
        }

        // --- 4. wasm_exec.js — already loaded by the module-scope runtime
        // (its load overlaps the VFS script instead of trailing it).

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
        if (!soft) {
          // No WebGL2 at all (not even software) — the engine's glfw-js
          // context would never come up and the engine would die inside the
          // boot window, which the local flow used to report by silently
          // bouncing back to character select (the Huawei Chrome report).
          // Fail here with the actual reason instead.
          throw new Error('This browser cannot create a WebGL2 context, so the game engine cannot start. In Chrome: Settings > System > "Use graphics acceleration" must be ON, and chrome://gpu must list WebGL2. Update the browser or its GPU drivers, then retry.');
        }

        // --- 6. Resolution is controlled by Settings UI / localStorage ---
        // Previously, /play set a global aspect override here, and vfs.js
        // used it to overwrite GameWidth/GameHeight in config.ini. Now that
        // Settings UI is authoritative (vfs.js no longer overwrites), we
        // don't set any aspect override at all. The engine boots with whatever
        // GameWidth/GameHeight is in localStorage config.ini (set by the
        // Settings UI or the /local RES toggle).

        // --- 7. PARALLEL LOAD: VFS (.pak) + WASM simultaneously ---
        // Both downloads start at the same time instead of sequentially.
        // On a typical connection this saves ~40% of total load time:
        //   Sequential: .pak (3s) + WASM (5s) = 8s
        //   Parallel:   max(.pak, WASM)      = 5s
        log(netMenu ? 'Finalizing engine boot...' : 'Loading game.pak + engine.wasm in parallel...');

        // Asset manifest (fetched at module scope): provides the content
        // stamp for the immutable wasm/pak URLs and is passed into vfs init
        // so it is fetched exactly once per boot.
        const manifestData = await ensureAssetManifest();
        if (cancelled) return;
        g.engineAssetStamp = manifestData.stamp || '';

        // Start VFS (.pak) load FIRST — it downloads while the module-scope
        // runtime finishes the wasm compile (net=1: already started in the
        // preboot — reuse the promise).
        // (go.argv is set later, after CDN downloads, with resolved paths.)
        const vfsPromise = netMenu
          ? vfsPromiseRef.current!
          : (g.engineVfsInit as any)(
              '/game/engine-fs/manifest.json',
              [],
              (got: number, total: number) => {
                if (cancelled) return;
                const pct = total > 0 ? Math.round((got / total) * 100) : 0;
                setBootLine('[PAK] ', (got / 1e6).toFixed(1) + ' / ' + (total / 1e6).toFixed(1) + ' MB (' + pct + '%)');
              },
              manifestData
            );

        // Runtime (Go instance + wasm promise) comes from the module-scope
        // singleton — the download/compile have been running since chunk
        // evaluation, and the exit-code recorder + GC env are already
        // installed there.
        const runtime = await runtimePromise;
        const go = runtime.go;
        if (!netMenu && WASM_HEAP_LIMIT_MIB < 800) {
          log('Engine GC: GOGC=off, GOMEMLIMIT=' + WASM_HEAP_LIMIT_MIB + 'MiB (mobile memory guard — prevents phone tab kills)');
        }

        const wasmPromise = runtime.wasmPromise;

        // Await both in parallel
        const [result, nFiles] = await Promise.all([wasmPromise, vfsPromise]);
        log('VFS ready: ' + nFiles + ' files from .pak | WASM compiled.');

        if (cancelled) return;

        // --- 8. Inject characters/stage from cache or CDN ---
        // Nothing is bundled in game.pak anymore (kfm + the training stage
        // were removed from the engine) — every character and stage is
        // injected from the IndexedDB cache, or downloaded AND PERSISTED to
        // that cache before injection (the fallback used to be session-only,
        // which re-downloaded the same files on every boot).
        //
        // IMPORTANT: addChar() expects just the character ID, NOT the full path.
        // (net=1: the roster comes from the website select flow, not the URL —
        // both sides download the agreed fighters here, same as net=direct.)
        // effP1/effP2 are selection REFERENCES ("Wolverine" or
        // "charsMARVEL/Wolverine") — the ENGINE always gets the plain id
        // (it builds chars/<id>/<id>.def internally).
        const effP1 = netFightCfg ? netFightCfg.p1 : p1;
        const effP2 = netFightCfg ? netFightCfg.p2 : p2;
        const effStage = netFightCfg ? netFightCfg.stage : stage;
        let p1Path = splitCharRef(effP1).id;
        let p2Path = splitCharRef(effP2).id;
        let stagePath = effStage;

        // No bundled fast-path anymore: the predicates stay (as always-false)
        // so the cache/download branches below read unchanged.
        const isBundledChar = (_id: string) => false;
        const isBundledStage = (_s: string) => false;

        if (!isBundledChar(effP1) || !isBundledChar(effP2) || !isBundledStage(effStage)) {
          // PARALLEL READ: pull all three IndexedDB records in ONE round-trip
          // (they used to be three serial ~record-size structured clones).
          // Records are Blob-backed and off-heap, so holding all three at
          // once is free; the injection loops below stay strictly SERIAL —
          // one file materialized at a time (phone-memory rule).
          log('Loading characters from cache...');
          const [p1Files, p2Files, stageFiles] = await Promise.all([
            isBundledChar(effP1) ? Promise.resolve(null) : getCachedCharacterFiles(effP1),
            isBundledChar(effP2) ? Promise.resolve(null) : getCachedCharacterFiles(effP2),
            isBundledStage(effStage) ? Promise.resolve(null) : getCachedStageFiles(effStage),
          ]);
          if (cancelled) return;

          // P1: inject from the in-hand record, fallback to download
          if (!isBundledChar(effP1)) {
            if (p1Files && await injectCharacterFiles(effP1, p1Files)) {
              log(`P1 loaded from cache: ${effP1}`);
              p1Path = splitCharRef(effP1).id;
            } else {
              log(`P1 not in cache, downloading...`);
              const manifest = await fetchAssetsManifest();
              const char = manifest.characters.find(c => charRef(c) === effP1);
              if (char) {
                log(`Downloading P1: ${char.displayName} (~${char.sizeMB} MB)...`);
                // Cache-first fallback: persists to IndexedDB AND injects —
                // the next boot of this character loads from cache instantly.
                await downloadAndInjectCharacter(char, (pct, msg) => {
                  setBootLine('[P1] ', `${msg} (${pct}%)`);
                });
                p1Path = char.id;
                log(`P1 ready: ${char.id}`);
              } else {
                log(`ERROR: Character "${effP1}" not found in manifest`);
                // Booting the engine with a path that does not exist makes it
                // exit silently - which in the online flow bounced the player
                // to the lobby with no explanation. Fail loudly instead.
                if (netMode) throw new Error(`Character "${effP1}" is not in the assets manifest - it cannot be loaded for this online match. Both players must pick a fighter that exists in the roster.`);
              }
            }
          }

          // P2: inject from the in-hand record, fallback to download
          if (!isBundledChar(effP2)) {
            if (p2Files && await injectCharacterFiles(effP2, p2Files)) {
              log(`P2 loaded from cache: ${effP2}`);
              p2Path = splitCharRef(effP2).id;
            } else {
              log(`P2 not in cache, downloading...`);
              const manifest = await fetchAssetsManifest();
              const char = manifest.characters.find(c => charRef(c) === effP2);
              if (char) {
                log(`Downloading P2: ${char.displayName} (~${char.sizeMB} MB)...`);
                await downloadAndInjectCharacter(char, (pct, msg) => {
                  setBootLine('[P2] ', `${msg} (${pct}%)`);
                });
                p2Path = char.id;
                log(`P2 ready: ${char.id}`);
              } else {
                log(`ERROR: Character "${effP2}" not found in manifest`);
                if (netMode) throw new Error(`Character "${effP2}" is not in the assets manifest - it cannot be loaded for this online match. Both players must pick a fighter that exists in the roster.`);
              }
            }
          }

          // Stage: inject from the in-hand record, fallback to download.
          // The cache HIT path needs no manifest at all (the .def file is
          // resolved from the record's own file list — same rule
          // getStageDefPath applies); only the miss path fetches it.
          if (!isBundledStage(effStage)) {
            if (stageFiles && await injectStageFiles(effStage, stageFiles)) {
              log(`Stage loaded from cache: ${effStage}`);
              const defFile = Object.keys(stageFiles).find(f => f.endsWith('.def'));
              stagePath = 'stages/' + (defFile || `${effStage}.def`);
            } else {
              log(`Stage not in cache, resolving...`);
              // For stages, the URL param is the stage ID (e.g. 'DU_Campus')
              // not the full path. We need to find it in the manifest.
              const manifest = await fetchAssetsManifest();
              const stg = manifest.stages.find(s => s.id === effStage);
              if (stg) {
                log(`Downloading stage: ${stg.displayName} (~${stg.sizeMB} MB)...`);
                // Cache-first fallback: persists to IndexedDB AND injects.
                await downloadAndInjectStage(stg, (pct, msg) => {
                  setBootLine('[STAGE] ', `${msg} (${pct}%)`);
                });
                stagePath = getStageDefPath(stg);
                log(`Stage ready: ${stagePath}`);
              } else {
                log(`ERROR: Stage "${effStage}" not found in the assets manifest`);
                // There is no bundled fallback stage anymore - fail loudly
                // instead of pointing the engine at a file that does not exist.
                throw new Error(`Stage "${effStage}" is not in the assets manifest. Pick a stage from the stage list.`);
              }
            }
          }
        }

        // net=direct boots via the engine's own -ip handshake; make sure the
        // roster fingerprint exists before go.run (the engine calls
        // ikemenNet.start mid-run, which sends the build check immediately).
        // Best-effort here: net=direct is the fixed-roster dev/advanced flow.
        if (netDirect) {
          try {
            const roster = await fetchAssetsManifest();
            log('Roster: manifest v' + roster.version +
              ((globalThis as any).engineRosterHex ? ' (' + (globalThis as any).engineRosterHex + ')' : ''));
          } catch { /* bridge falls back to the pack-only hash */ }
        }

        if (cancelled) return;

        // --- 9. Build go.argv with the resolved character/stage paths ---
        if (netMenu || netDirect) {
          const wireRole = netMenu ? netRoleRef.current : netDirectRole;
          log(`Engine starting... (netplay ${wireRole} - connecting via WebRTC bridge)`);
        } else {
          log('Engine starting... (quick match, bypassing menu)');
        }

        // Install the display-only canvas fitter before starting the engine.
        // It waits for the engine-created canvas, then keeps it at the maximum
        // aspect-ratio-preserving size during browser/mobile viewport changes.
        go.argv = (netMenu || netDirect)
          ? [
              'ikemen',
              '-p1', p1Path,
              '-p2', p2Path,
              '-s', stagePath,
              // net=1: the website select flow already established the
              // session — the engine attaches to it (webrtc.js start()
              // reuse-guard). '' = listen (host); the value is otherwise
              // ignored by the WebRTC transport.
              '-ip', (netMenu ? netRoleRef.current : netDirectRole) === 'join' ? 'webrtc' : '',
            ]
          : [
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
        scheduleVfsPrefetch();
        // Mark fight start time for Time Attack duration tracking.
        // Must be called right before go.run() so it measures the actual
        // fight duration, not the engine boot time. Not meaningful for
        // netplay (no progression session) - skip to keep stats clean.
        if (!netMode) markFightStart();
        // Show floating exit button on touch devices after engine starts.
        if (isTouch) {
          setTimeout(() => setShowExit(true), 1500);
        }
        g.__engineExitCode = null;
        engineStartAt = Date.now();
        glContextLost = false;
        document.addEventListener('webglcontextlost', onContextLost, true);
        await go.run(result.instance);
        cleanupCanvasFit();

        // The engine's own output decides whether run() resolving means
        // "fight ended" or "engine died". Report deaths visibly - local AND
        // online - instead of silently bouncing back to the select screen,
        // which is exactly what made the "before the match starts it kicks
        // me back to character select" reports undiagnosable on phones.
        // 'Panic:' = Go panic; 'fatal error:' = Go RUNTIME death (out of
        // memory, deadlock, ...) printed to stderr WITHOUT a panic line —
        // the OOM-class boot deaths (Huawei Chrome report) only match the
        // second pattern. Both come through the vfs log bridge
        // (window.__engineLog), which captures stdout AND stderr.
        const engineTail = ((globalThis as any).__engineLog || []) as string[];
        const crashLine = engineTail.find(l => l.includes('Panic:') || l.includes('fatal error:'));
        if (crashLine) {
          cleanup();
          log('ENGINE CRASHED: ' + crashLine);
          setBootError('The game engine crashed (' + crashLine.slice(0, 200) + '). Send a screenshot of this screen when reporting — the boot log below shows how far it got.');
          return;
        }

        // An engine that quits before any picture ever appeared did NOT
        // finish a fight. The engine calls exit() on fatal errors (no GL,
        // bad netplay attach, peer death during handshake) and wasm_exec
        // resolves run() normally for it - which used to fall through to
        // the "Fight complete" path for LOCAL fights and silently bounce
        // the player to /local (= character select; the Huawei Chrome
        // report), while online got the error screen. A real fight = canvas
        // existed AND ran for a sensible duration, OR a result marker was
        // written (an ultra-short but genuinely finished fight reports it).
        const fightResult = readFightResult();
        const engineRan = !!document.querySelector('canvas#ikemen-canvas') && (Date.now() - engineStartAt > 8000);
        // A genuinely finished fight always exits 0 (clean main return or a
        // menu Quit). os.Exit(nonzero) or a lost WebGL context is an engine
        // death even when a picture had been on screen for a while - report
        // it instead of silently bouncing. This closes the LAST silent path
        // of the Huawei Chrome report class: an engine dying after the
        // canvas is up (past the 8s engineRan heuristic) without printing a
        // Go panic line.
        const exitCode = g.__engineExitCode;
        const engineDied = (exitCode != null && exitCode !== 0) || glContextLost;
        if (engineDied && !fightResult) {
          cleanup();
          const why = glContextLost
            ? 'the WebGL graphics context was lost (GPU driver reset or GPU memory exhaustion)'
            : 'the engine exited abnormally (exit code ' + exitCode + ')';
          const tail = engineTail.slice(-4).join(' | ').slice(0, 240);
          log('ENGINE DIED: ' + why);
          clearBootLive();
          setBootError('The game engine died: ' + why +
            (tail ? '. Engine output: ' + tail : '') +
            '. The boot log below shows how far it got - send a screenshot when reporting.');
          return;
        }
        if (!engineRan && !fightResult) {
          cleanup();
          clearBootLive();
          log('ENGINE EXITED BEFORE THE FIGHT STARTED' + (exitCode != null && exitCode !== 0 ? ' (exit code ' + exitCode + ')' : '') + '.');
          const tail = engineTail.slice(-4).join(' | ').slice(0, 240);
          setBootError('The game engine exited before the match started' + (exitCode != null && exitCode !== 0 ? ' (exit code ' + exitCode + ')' : '') +
            (tail ? '. Engine output: ' + tail : '') +
            '. The boot log below shows how far it got. If this repeats, send a screenshot when reporting' + (netMode ? '; both players should also hard-refresh the page (Ctrl+F5) and retry.' : '.'));
          return;
        }

        // Engine exited — fight is over. Read the match result and decide
        // what to do next based on the game mode.
        clearFightResult();
        cleanup();

        if (fightResult && qmode !== 'quickvs' && qmode !== 'training') {
          // Progression mode — process the result and advance
          const action = processFightResult(fightResult);
          switch (action.type) {
            case 'next-fight': {
              log(`Victory! Advancing to fight ${getCurrentModeState()?.fightNumber ?? '?'}`);
              clearBootLive();
              window.location.href = '/progress';
              return;
            }
            case 'finished': {
              const resultParam = action.result === 'victory' ? 'win' : 'lose';
              log(`${action.result === 'victory' ? 'VICTORY!' : 'DEFEAT'} — ${action.wins}W / ${action.losses}L`);
              clearBootLive();
              window.location.href = `/results?result=${resultParam}&mode=${qmode}&wins=${action.wins}&losses=${action.losses}&time=${action.totalTime.toFixed(1)}`;
              return;
            }
            case 'retry': {
              log('Draw! Replaying the fight...');
              clearBootLive();
              window.location.reload();
              return;
            }
            case 'exit': {
              log('Fight complete. Returning...');
              clearBootLive();
              window.location.href = exitTarget;
              return;
            }
          }
        }

        // Single-fight mode (quickvs/training) or a finished online fight.
        log('Fight complete. Returning...');
        clearBootLive();
        window.location.href = exitTarget;

      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('Go program has already exited') || msg.includes('unreachable')) {
          cleanup();
          // Engine's own output wins: a Panic line (or a Go runtime 'fatal
          // error:') is a real engine bug, and bouncing silently would hide
          // it (the phone report class).
          const engineTail = ((globalThis as any).__engineLog || []) as string[];
          const crashLine = engineTail.find(l => l.includes('Panic:') || l.includes('fatal error:'));
          if (crashLine) {
            log('ENGINE CRASHED: ' + crashLine);
            clearBootLive();
            setBootError('The game engine crashed (' + crashLine.slice(0, 200) + '). Send a screenshot of this screen when reporting — the boot log below shows how far it got.');
            return;
          }
          // Keep the redirect ONLY for a genuine post-fight exit (the fight
          // actually ran). A trap before the fight ever showed a picture is
          // a boot crash - it must be reported, not silently bounced to
          // /local or /lobby (the Huawei Chrome report class).
          const engineRan = !!document.querySelector('canvas#ikemen-canvas') && (Date.now() - engineStartAt > 8000);
          // `g` lives inside the try scope - read the exit code off globalThis
          // directly (the go.exit wrapper records it there).
          const exitCode = (globalThis as any).__engineExitCode;
          const engineDied = (exitCode != null && exitCode !== 0) || glContextLost;
          if (engineRan && !engineDied) {
            clearBootLive();
            window.location.href = exitTarget;
            return;
          }
          const why = engineDied
            ? (glContextLost ? 'graphics context lost' : 'exit code ' + exitCode)
            : msg;
          log('ENGINE CRASHED: ' + why);
          clearBootLive();
          setBootError('The game engine crashed (' + why + '). The boot log below and the browser console (F12) hold the details - send them along when reporting.');
          return;
        }
        log('BOOT ERROR: ' + msg);
        console.error(e);
        clearBootLive();
        if (!cancelled) setBootError(msg);
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
    // fetch of engine.wasm, etc.). The touch UI is handled in render
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

      {/* ---- Online flow UI (net=1): website select screens, NO engine menus.
          Sits above the page (fixed) while the boot log/pak load runs behind
          it; the bridge's own room-code panel (z-index 1000) stays on top so
          both players can exchange codes during 'connecting'. ---- */}
      {netPhase === 'role' && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 40,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: '0.9rem', background: '#0a0a0c',
          }}
        >
          <h1 style={{ fontSize: '2rem', letterSpacing: '0.2em', fontWeight: 800, color: '#eee' }}>
            ONLINE PLAY
          </h1>
          <div style={{ fontSize: '0.65rem', letterSpacing: '0.25em', color: '#888', marginBottom: '1rem' }}>
            PICK FIGHTERS ON THE SITE — NO ENGINE MENUS
          </div>
          <GameButton variant="primary" onClick={() => handleNetRolePick('host')}>
            HOST GAME
          </GameButton>
          <GameButton onClick={() => handleNetRolePick('join')}>
            JOIN GAME
          </GameButton>
          <GameButton variant="danger" onClick={cancelNetFlow}>
            ← BACK TO LOBBY
          </GameButton>
        </div>
      )}
      {netPhase === 'connecting' && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 40,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: '0.8rem', pointerEvents: 'none', background: 'transparent',
          }}
        >
          <div style={{ fontSize: '0.8rem', letterSpacing: '0.25em', color: 'var(--gold, #d9a92f)', fontWeight: 700 }}>
            {!netBridgeStarted
              ? 'LOADING GAME DATA…'
              : netRole === 'host'
              ? 'WAITING FOR YOUR FRIEND…'
              : 'CONNECTING TO THE HOST…'}
          </div>
          <div style={{ fontSize: '0.65rem', letterSpacing: '0.15em', color: '#888', maxWidth: 440, textAlign: 'center' }}>
            {netBridgeStarted
              ? netRole === 'host'
                ? 'Create a room in the NETPLAY panel and share the room code.'
                : 'Enter the room code in the NETPLAY panel.'
              : 'Preparing the build hash used by the netplay check…'}
          </div>
          <div style={{ pointerEvents: 'auto', marginTop: '0.5rem' }}>
            <GameButton variant="danger" onClick={cancelNetFlow}>
              CANCEL
            </GameButton>
          </div>
        </div>
      )}
      {netPhase === 'charselect' && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 40, overflowY: 'auto', background: '#0a0a0c' }}>
          <CharacterSelect
            isTouch={isTouch}
            online={{
              role: netRole === 'join' ? 'guest' : 'host',
              opponentId: netOpp.id,
              opponentIndex: netOpp.liveIdx,
              opponentLocked: netOpp.locked,
              onPick: handleNetPick,
              onCursor: handleNetCursor,
            }}
            onCancel={cancelNetFlow}
          />
        </div>
      )}
      {(netPhase === 'stageselect' || netPhase === 'waiting') && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 40, overflowY: 'auto', background: '#0a0a0c' }}>
          <StageSelect
            isTouch={isTouch}
            spectate={netPhase === 'waiting'}
            spectateNote="YOUR OPPONENT IS CHOOSING THE STAGE…"
            onSelect={handleNetStage}
            onCancel={cancelNetFlow}
          />
        </div>
      )}
      {netPhase === 'error' && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0c' }}>
          <ErrorState
            title="ONLINE MATCH ENDED"
            message={netError || 'The connection to your opponent was lost.'}
            onRetry={() => window.location.reload()}
            onBack={() => { window.location.href = '/lobby'; }}
          />
        </div>
      )}

      {/* Structured boot-failure overlay (Frontend 2.1 spec Section 33).
          The green boot log above stays visible as raw diagnostics. */}
      {bootError && (
        <ErrorState
          title="ENGINE FAILED TO START"
          message="The game engine could not finish booting. This is usually a network or browser-memory issue. Retrying reloads the engine; going back returns to character select."
          onRetry={() => window.location.reload()}
          onBack={() => { window.location.href = isNetFlow ? '/lobby' : '/local'; }}
          details={bootError}
        />
      )}

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
  const existing = scriptPromises.get(src);
  if (existing) return existing;
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromises.delete(src); // allow a retry on a later boot
      reject(new Error('Failed to load: ' + src));
    };
    document.head.appendChild(script);
  });
  scriptPromises.set(src, promise);
  return promise;
}

// Script-loader promise cache: every /play boot path (local, net=1,
// net=direct, module-scope runtime) shares ONE load per src, so a re-entrant
// boot can never double-execute a script (a second wasm_exec.js execution
// would clobber the Go class and orphan the running instance).
const scriptPromises = new Map<string, Promise<void>>();

// Instantiate the engine WASM over the cheapest wire path:
//   1. /game/engine.wasm.gz?v=<stamp> — ~5.4 MB instead of 23 MB (-77%),
//      immutable-cached via the content stamp, streamed through
//      DecompressionStream so decompression overlaps the download and
//      compilation overlaps decompression.
//   2. Raw /game/engine.wasm — browsers without DecompressionStream, or a
//      missing/corrupt .gz artifact.
// The raw path fetches ONCE and reuses the same response for the buffered
// fallback (the old code re-downloaded all 23 MB on fallback).
async function instantiateEngineWasm(
  fetchFn: typeof fetch,
  go: { importObject: unknown },
  stamp: string,
  log: (s: string) => void,
) {
  const qs = stamp ? '?v=' + encodeURIComponent(stamp) : '';
  if (typeof DecompressionStream === 'function' && stamp) {
    try {
      const res = await fetchFn('/game/engine.wasm.gz' + qs, { cache: 'default' });
      if (res.ok && res.body) {
        const wasmStream = res.body.pipeThrough(new DecompressionStream('gzip'));
        const wasmRes = new Response(wasmStream, { headers: { 'Content-Type': 'application/wasm' } });
        return await WebAssembly.instantiateStreaming(wasmRes, go.importObject as any);
      }
      log('Compressed wasm unavailable (HTTP ' + res.status + '), falling back to raw.');
    } catch (e) {
      log('Compressed wasm path failed (' + (e instanceof Error ? e.message : String(e)) + '), falling back to raw.');
    }
  }
  const res = await fetchFn('/game/engine.wasm' + qs, { cache: 'no-cache' });
  try {
    return await WebAssembly.instantiateStreaming(res.clone(), go.importObject as any);
  } catch {
    log('Streaming compile failed, buffering...');
    const bytes = await res.arrayBuffer();
    return WebAssembly.instantiate(bytes, go.importObject as any);
  }
}

// (DebugBadge component removed — was a development tool for touch
// control debugging, not needed in production per spec Section 50.)
