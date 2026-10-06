'use client';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, useCallback, Suspense } from 'react';
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
import { ErrorState, GameButton } from '@/components/ui';
import { readFightResult, clearFightResult, processFightResult, getCurrentModeState, markFightStart } from '@/lib/game-modes';
import CharacterSelect from '@/components/CharacterSelect';
import StageSelect from '@/components/StageSelect';

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
  const vfsPromiseRef = useRef<Promise<number> | null>(null);
  const goRef = useRef<any>(null);
  const wasmPromiseRef = useRef<Promise<WebAssembly.WebAssemblyInstantiatedSource> | null>(null);

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
  // computed at the end of vfs init), then open the bridge room panel.
  const handleNetRolePick = useCallback(async (role: 'host' | 'join') => {
    setNetRole(role);
    netRoleRef.current = role;
    setNetPhase('connecting');
    try {
      if (vfsPromiseRef.current) await vfsPromiseRef.current;
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
    const cfg: NetFightConfig = { p1: netMine.id, p2: netOpp.id, stage: stageId };
    const net = (globalThis as any).ikemenNet;
    try {
      net?.control?.({ t: 'go', p1: cfg.p1, p2: cfg.p2, stage: stageId });
    } catch { /* the poller reports real drops */ }
    setNetPhase('fight');
    netResolveRef.current?.(cfg);
  }, [netMine.id, netOpp.id]);

  const cancelNetFlow = useCallback(() => {
    try { (globalThis as any).ikemenNet?.close?.(); } catch { /* already gone */ }
    netResolveRef.current?.(null);
    window.location.href = '/lobby';
  }, []);

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

  // ---- Load vanilla JS touch overlay on touch devices when engine starts ----
  // touch.js is a self-contained IIFE that creates its own DOM (circular D-pad
  // + two-arc action buttons + START/ESC pills). It reads P1 key bindings from
  // localStorage config.ini and dispatches synthetic KeyboardEvents. No React
  // dependency — simpler and more reliable than the old React TouchControls.
  useEffect(() => {
    if (!isTouch || !engineRunning) return;
    const script = document.createElement('script');
    // Cache-buster: public/game files are served must-revalidate, but some
    // mobile browsers / PWA contexts have been observed keeping stale copies.
    // A versioned URL makes a stale touch.js impossible after a deploy.
    // IMPORTANT: bump this together with the BUILD constant inside touch.js.
    script.src = '/game/touch.js?v=2026-10-06.2';
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

      // ---- Touch-binding config snapshot (touch input root-cause fix) ----
      // The engine writes its OWN default [Keys_P1] (lowercase "up = UP",
      // "a = z", ...) to save/config.ini shortly after boot, and vfs.js
      // persists that write to localStorage. touch.js parses localStorage
      // with the same first-match-wins rule as the engine, so if it reads
      // AFTER the write it sees the engine's DEFAULTS instead of the
      // bindings the engine actually booted with — touch then dispatches
      // ArrowRight/KeyZ while the engine waits for KeyD/Digit8.
      //
      // In local mode the engine boots slowly (WASM compile + VFS), so
      // touch.js usually builds first and wins the race; in online mode
      // the engine boots near-instantly (precompiled WASM + prebuilt VFS
      // from the online preboot) and the write lands BEFORE touch.js
      // builds — that is exactly why touch broke only in network mode.
      //
      // Fix: snapshot the config BEFORE the engine can write, and hand
      // the snapshot to touch.js. vfs.js restorePersisted() reads the
      // same value during init, so the engine boots on the same bytes
      // touch.js parses — consistent by construction, race-proof.
      try {
        (globalThis as any).__ikemenTouchConfig =
          localStorage.getItem('ikemen-vfs12:save/config.ini');
      } catch { /* private mode — touch.js falls back to its defaults */ }

      let onKeyDown: ((e: KeyboardEvent) => void) | null = null;
      let onKeyUp: ((e: KeyboardEvent) => void) | null = null;
      let clickHandler: (() => void) | null = null;
      // Online (net=1) fight config — filled by the preboot park below.
      let netFightCfg: NetFightConfig | null = null;

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

      // In-place line update for progress displays ([PAK]/[P1]/[P2]/[STAGE]).
      // Hoisted here so the online preboot can show .pak progress too.
      const setBootLine = (prefix: string, text: string) => {
        if (cancelled) return;
        const lines = boot.textContent.split('\n');
        const idx = lines.findIndex(l => l.startsWith(prefix));
        if (idx >= 0) lines[idx] = prefix + text;
        else lines.push(prefix + text);
        boot.textContent = lines.join('\n');
        boot.scrollTop = boot.scrollHeight;
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
          style.id = 'ikemen-canvas-fit';
          style.textContent = [
            'html, body { overflow: hidden !important; }',
            // object-fit / object-position are set inline (always contain —
            // the canvas aspect always matches the chosen display mode).
            'canvas#ikemen-canvas { display: block !important; margin: 0 !important; }',
          ].join('\n');
          document.head.appendChild(style);
          document.body.classList.add('fighting');

          // Do not observe the whole document while the engine is running.
          // IKEMEN/wasm and the touch overlay can mutate the DOM frequently;
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
            document.getElementById('ikemen-canvas-fit')?.remove();
            document.body.classList.remove('fighting');
          };
        };

        const cleanupCanvasFit = installCanvasFit();
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
        // __ikemenKeyDown/__ikemenKeyUp poll-based bridge was dead code
        // (the engine never read it).
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

        // ---- ONLINE MODE (net=1): website flow, zero engine menus ----
        // Role pick, the room-code panel and the character/stage select
        // screens are all rendered by the netPhase state on THIS page, so
        // the WebRTC session stays alive from handshake to engine boot.
        // Everything after the park runs only once both players locked in
        // and the host picked the stage.
        if (netMenu) {
          log('Online mode: loading game data...');
          await loadScript('/game/vfs.js');
          if (cancelled) return;
          // Start the .pak load NOW: the netplay build check exchanges a
          // hash that vfs init computes at its END, so it must be underway
          // before the handshake. The fight boot reuses this promise (a
          // second init would download everything twice).
          vfsPromiseRef.current = (g.ikemenVfsInit as any)(
            '/game/ikemen-fs/manifest.json',
            [],
            (got: number, total: number) => {
              if (cancelled) return;
              const pct = total > 0 ? Math.round((got / total) * 100) : 0;
              setBootLine('[PAK] ', (got / 1e6).toFixed(1) + ' / ' + (total / 1e6).toFixed(1) + ' MB (' + pct + '%)');
            }
          );
          // Warm the WASM compile while the players are in the lobby and
          // the select screens — the fight then starts near-instantly.
          log('Loading Go WASM runtime...');
          await loadScript('/game/wasm_exec.js');
          if (cancelled) return;
          const goPre = new (g.Go as any)();
          goPre.env = { GOGC: 'off', GOMEMLIMIT: '800MiB' };
          goRef.current = goPre;
          wasmPromiseRef.current = WebAssembly.instantiateStreaming(
            originalFetch('/game/ikemen.wasm', { cache: 'no-cache' }),
            goPre.importObject,
          ).catch(async () => {
            log('Streaming compile failed, buffering...');
            const bytes = await (await originalFetch('/game/ikemen.wasm', { cache: 'no-cache' })).arrayBuffer();
            return WebAssembly.instantiate(bytes, goPre.importObject);
          });
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
          installKeyboardGuard();
        }

        // --- 3. Load VFS (must load BEFORE wasm_exec.js) ---
        // (net=1 already loaded it in the online preboot above.)
        if (!netMenu) {
          log('Loading virtual filesystem...');
          await loadScript('/game/vfs.js');
          if (cancelled) return;
        }

        // --- 3b. Load the netplay bridge (net=direct only — net=1 loaded
        // it in the online preboot above, before the select screens) ---
        if (netDirect) {
          log('Loading netplay bridge...');
          await loadScript('/game/webrtc.js');
          if (cancelled) return;
        }

        // --- 4. Load wasm_exec.js (Go's WASM runtime) ---
        // (net=1 already loaded it in the preboot above.)
        if (!netMenu) {
          log('Loading Go WASM runtime...');
          await loadScript('/game/wasm_exec.js');
          if (cancelled) return;
        }

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
        log(netMenu ? 'Finalizing engine boot...' : 'Loading game.pak + ikemen.wasm in parallel...');

        // Start WASM fetch immediately (don't await yet — runs in background)
        // go.argv is set later (after CDN downloads) with resolved character paths
        // (net=1: the Go runtime + WASM compile started in the online preboot —
        //  reuse them so the fight boots instantly after selection.)
        const go = netMenu ? goRef.current : new (g.Go as any)();
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
        if (!netMenu) {
          go.env = {
            GOGC: 'off',
            GOMEMLIMIT: '800MiB',
          };
        }

        const wasmUrl = '/game/ikemen.wasm';
        const wasmPromise = netMenu
          ? wasmPromiseRef.current!
          : WebAssembly.instantiateStreaming(
              originalFetch(wasmUrl, { cache: 'no-cache' }),
              go.importObject
            ).catch(async () => {
              // Fallback: buffered compile if streaming fails
              log('Streaming compile failed, buffering...');
              const bytes = await (await originalFetch(wasmUrl, { cache: 'no-cache' })).arrayBuffer();
              return WebAssembly.instantiate(bytes, go.importObject);
            });

        // Start VFS (.pak) load — updates progress as it streams
        // (net=1: already started in the preboot — reuse the promise)
        const vfsPromise = netMenu
          ? vfsPromiseRef.current!
          : (g.ikemenVfsInit as any)(
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
        // (net=1: the roster comes from the website select flow, not the URL —
        // both sides download the agreed fighters here, same as net=direct.)
        const effP1 = netFightCfg ? netFightCfg.p1 : p1;
        const effP2 = netFightCfg ? netFightCfg.p2 : p2;
        const effStage = netFightCfg ? netFightCfg.stage : stage;
        let p1Path = effP1;
        let p2Path = effP2;
        let stagePath = effStage;

        const isBundledChar = (id: string) => id === 'kfm';
        const isBundledStage = (s: string) => s === 'stages/stage0-720.def';

        if (!isBundledChar(effP1) || !isBundledChar(effP2) || !isBundledStage(effStage)) {
          // Try to inject from IndexedDB cache first (instant)
          log('Loading characters from cache...');

          // P1: try cache, fallback to download
          if (!isBundledChar(effP1)) {
            const injected = await injectCachedCharacter(effP1);
            if (injected) {
              log(`P1 loaded from cache: ${effP1}`);
              p1Path = effP1;
            } else {
              log(`P1 not in cache, downloading...`);
              const manifest = await fetchAssetsManifest();
              const char = manifest.characters.find(c => c.id === effP1);
              if (char) {
                log(`Downloading P1: ${char.displayName} (~${char.sizeMB} MB)...`);
                await downloadCharacter(char, (pct, msg) => {
                  setBootLine('[P1] ', `${msg} (${pct}%)`);
                });
                p1Path = char.id;
                log(`P1 ready: ${char.id}`);
              } else {
                log(`ERROR: Character "${effP1}" not found in manifest`);
              }
            }
          }

          // P2: try cache, fallback to download
          if (!isBundledChar(effP2)) {
            const injected = await injectCachedCharacter(effP2);
            if (injected) {
              log(`P2 loaded from cache: ${effP2}`);
              p2Path = effP2;
            } else {
              log(`P2 not in cache, downloading...`);
              const manifest = await fetchAssetsManifest();
              const char = manifest.characters.find(c => c.id === effP2);
              if (char) {
                log(`Downloading P2: ${char.displayName} (~${char.sizeMB} MB)...`);
                await downloadCharacter(char, (pct, msg) => {
                  setBootLine('[P2] ', `${msg} (${pct}%)`);
                });
                p2Path = char.id;
                log(`P2 ready: ${char.id}`);
              } else {
                log(`ERROR: Character "${effP2}" not found in manifest`);
              }
            }
          }

          // Stage: try cache, fallback to download
          if (!isBundledStage(effStage)) {
            // For stages, the URL param is the stage ID (e.g. 'DU_Campus')
            // not the full path. We need to find it in the manifest.
            const manifest = await fetchAssetsManifest();
            const stg = manifest.stages.find(s => s.id === effStage);
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
        // Mark fight start time for Time Attack duration tracking.
        // Must be called right before go.run() so it measures the actual
        // fight duration, not the engine boot time. Not meaningful for
        // netplay (no progression session) - skip to keep stats clean.
        if (!netMode) markFightStart();
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
              log('Fight complete. Returning...');
              window.location.href = exitTarget;
              return;
            }
          }
        }

        // Single-fight mode (quickvs/training) or a finished online fight.
        log('Fight complete. Returning...');
        window.location.href = exitTarget;

      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('Go program has already exited') || msg.includes('unreachable')) {
          cleanup();
          window.location.href = exitTarget;
          return;
        }
        log('BOOT ERROR: ' + msg);
        console.error(e);
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
