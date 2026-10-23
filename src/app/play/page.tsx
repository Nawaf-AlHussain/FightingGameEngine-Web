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
  purgeAssetsMentionedByPanic,
  charRef,
  splitCharRef,
} from '@/lib/character-downloader';
import { useIsTouchDevice } from '@/lib/use-touch-device';
import { ErrorState, GameButton } from '@/components/ui';
import { readFightResult, clearFightResult, processFightResult, getCurrentModeState, markFightStart } from '@/lib/game-modes';
import { getDisplayModeMarker } from '@/lib/engine-config';
import { engineGzipDecode, bootGzStats } from '@/lib/boot-decompress';
import CharacterSelect from '@/components/CharacterSelect';
import GroupSelect from '@/components/GroupSelect';
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
  | 'groupselect' // both players land here: HOST picks the universe, guest
                  // spectates until the 'group' control frame syncs it
  | 'charselect'  // both players pick their fighter on the site
  | 'stageselect' // host picks the stage
  | 'waiting'     // guest spectates while the host picks the stage
  | 'fight'       // engine booting / running with the agreed roster
  | 'postfight'   // engine exited cleanly, bridge STILL OPEN — rematch panel
  | 'error';      // connection lost / setup failed

/**
 * Remove the engine's dead canvas after a fight (rematch preparation).
 *
 * The engine creates its own <canvas id="ikemen-canvas"> and nothing in the
 * exit path ever removed it (every exit used to navigate the page away). An
 * in-place rematch boots a SECOND engine process in the same document, so the
 * corpse must go first: the old WebGL2 context is explicitly lost via
 * WEBGL_lose_context (browsers cap live contexts — leaked contexts would make
 * the 3rd rematch fail to create one) and the element is removed so the fresh
 * engine's canvas is the only one the fitter can find.
 */
function teardownEngineCanvas() {
  const canvas = document.querySelector('canvas#ikemen-canvas') as HTMLCanvasElement | null;
  if (!canvas) return;
  try {
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const lose = (gl as WebGL2RenderingContext | null)?.getExtension?.('WEBGL_lose_context');
    lose?.loseContext();
  } catch { /* a dead context is exactly what we want anyway */ }
  try { canvas.remove(); } catch { /* already gone */ }
}

interface NetFightConfig {
  /** Host's fighter (engine side 1). */
  p1: string;
  /** Guest's fighter (engine side 2). */
  p2: string;
  /** Stage id (bundled path or manifest id — same format as /local). */
  stage: string;
}

/**
 * Display mode synced for an online fight ('4:3' | '16:9' | 'tall' | '3:2'
 * | '14:9' | '5:3').
 *
 * The engine's netplay handshake REFUSES peers whose effective fight
 * aspect differs ("effective fight aspect differs (local=custom:4:3
 * remote=stage)"): a 4:3-mode host paired with a 16:9 default guest
 * (the classic PC + phone combo) exited the engine before the fight
 * started. The host's display mode rides the 'go' control frame and the
 * guest adopts it via vfs.js engineApplyDisplayMode() before the engine
 * boots — host-authoritative, in-memory only.
 */
type NetDisplayMode = '4:3' | '16:9' | 'tall' | '3:2' | '14:9' | '5:3';

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

// Expose the off-main-thread gunzip to vfs.js (which is plain JS with no
// imports): engineVfsInit's pak path calls globalThis.engineGzipDecode and
// falls back to its inline DecompressionStream when the hook returns null
// (kill-switch localStorage 'fg-boot-worker'='off' / unsupported browser /
// dead worker). Module scope so BOTH engineVfsInit call sites (net=1
// preboot + local boot) are covered from the first tick.
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).engineGzipDecode =
    (stream: ReadableStream<Uint8Array>, label: string) => engineGzipDecode(stream, label);
}

// ---- Real-phone verification switches (no desktop tooling needed) --------
// Query params are read once at module eval — BEFORE any boot work — and
// persisted, so a warm-boot reload or later navigation keeps the setup:
//   ?bootworker=off  pin the old inline gunzip path (A/B baseline)
//   ?bootworker=on   clear the pin (off-thread worker path again)
//   ?bootstats=1     show the boot-stats HUD after boot (top-left pill)
//   ?bootstats=0     hide it again
// 'fg-boot-worker' is boot-decompress.ts's kill-switch key; 'fg-boot-stats'
// only gates the HUD. Both stick until explicitly flipped via the param.
if (typeof window !== 'undefined') {
  try {
    const q = new URLSearchParams(window.location.search);
    const bw = q.get('bootworker');
    if (bw === 'off') localStorage.setItem('fg-boot-worker', 'off');
    else if (bw === 'on') localStorage.removeItem('fg-boot-worker');
    const bs = q.get('bootstats');
    if (bs === '1') localStorage.setItem('fg-boot-stats', '1');
    else if (bs === '0') localStorage.removeItem('fg-boot-stats');
  } catch { /* storage blocked — HUD and switches just stay default */ }
}

// ---- Boot timing beacons (cold-boot pile-up instrumentation) -------------
// Marks land at the phase boundaries below (wasm compile, pak decode, P1/
// P2/stage injection, engine start); a long-task observer counts main-thread
// stalls >50ms from boot start. One compact '[boot-timing]' line is logged
// right before go.run() — greppable before/after evidence for the pile-up
// work, and a permanent free diagnostic for future boot regressions.
interface BootTiming {
  t0: number;
  longTasks: { n: number; total: number; max: number };
  observer?: PerformanceObserver;
}
let bootTiming: BootTiming | null = null;

function bootTimingStart(): void {
  bootTiming = { t0: performance.now(), longTasks: { n: 0, total: 0, max: 0 } };
  try {
    const obs = new PerformanceObserver((list) => {
      if (!bootTiming) return;
      for (const e of list.getEntries()) {
        bootTiming.longTasks.n++;
        bootTiming.longTasks.total += e.duration;
        if (e.duration > bootTiming.longTasks.max) bootTiming.longTasks.max = e.duration;
      }
    });
    obs.observe({ type: 'longtask', buffered: false } as PerformanceObserverInit);
    bootTiming.observer = obs;
  } catch {
    /* longtask unsupported (Safari pre-16.4?) — phases still measured */
  }
}

function bootPhase(name: string): void {
  try { performance.mark('boot:' + name); } catch { /* advisory */ }
}

// Structured summary — `text` is the same greppable '[boot-timing]' line as
// before; the numeric fields feed the boot-stats HUD (?bootstats=1) so the
// numbers can be read and copied on the phone itself.
interface BootStats {
  boot: number;  // engine pipeline total (bootTimingStart -> summary)
  pre: number;   // navigation start -> bootTimingStart (bundle + hydration)
  wasm: number; pak: number; records: number; p1: number; p2: number; stage: number;
  ltN: number; ltTotal: number; ltMax: number;
  text: string;
}

function bootTimingSummary(): BootStats {
  const dur = (startMark: string, endMark: string): number => {
    try {
      performance.measure(startMark + '→' + endMark, startMark, endMark);
      const m = performance.getEntriesByName(startMark + '→' + endMark).slice(-1)[0] as PerformanceMeasure;
      return Math.round(m.duration);
    } catch {
      return -1;
    }
  };
  const wasm = dur('boot:wasm:start', 'boot:wasm:ready');
  const pak = dur('boot:pak:start', 'boot:pak:ready');
  const records = dur('boot:records:start', 'boot:records:ready');
  const p1 = dur('boot:p1:start', 'boot:p1:ready');
  const p2 = dur('boot:p2:start', 'boot:p2:ready');
  const stage = dur('boot:stage:start', 'boot:stage:ready');
  const lt = bootTiming?.longTasks ?? { n: 0, total: 0, max: 0 };
  // performance.now() counts from navigation start, so the captured t0 IS
  // the pre-boot cost (bundle download + hydration before bootEngine ran).
  const bootMs = bootTiming ? Math.round(performance.now() - bootTiming.t0) : -1;
  const preMs = bootTiming ? Math.round(bootTiming.t0) : -1;
  const ltPart = ` | longtasks=${lt.n} total=${Math.round(lt.total)}ms max=${Math.round(lt.max)}ms`;
  const text = `[boot-timing] boot=${bootMs}ms pre=${preMs}ms wasm=${wasm}ms pak=${pak}ms records=${records}ms p1=${p1}ms p2=${p2}ms stage=${stage}ms${ltPart}`;
  return {
    boot: bootMs, pre: preMs, wasm, pak, records, p1, p2, stage,
    ltN: lt.n, ltTotal: Math.round(lt.total), ltMax: Math.round(lt.max), text,
  };
}

// ---- Boot-stats HUD (real-phone verification readout) ---------------------
// Small top-left pill with the pipeline total; tap expands the phase table
// plus COPY, which puts the '[boot-timing]' line + device tags on the
// clipboard for pasting straight into a chat report. Mounted only when the
// persisted fg-boot-stats flag is on (set via ?bootstats=1) — normal players
// never see it, and it carries zero gameplay behavior.
function BootStatsHud({ stats }: { stats: BootStats }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const gz = bootGzStats();

  const copy = async (): Promise<void> => {
    const nav = navigator as unknown as { deviceMemory?: number };
    const dev = `${nav.deviceMemory ?? '?'}GB/${navigator.hardwareConcurrency || '?'}c`;
    const text = [
      stats.text,
      `pre=${stats.pre}ms gz=worker×${gz.worker}+inline×${gz.inline} dev=${dev}`,
      'ua=' + navigator.userAgent,
    ].join('\n');
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch { /* denied (e.g. unfocused tab) — legacy path below */ }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      } catch { /* give up — numbers remain readable in the panel */ }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const row = (label: string, ms: number): string =>
    label.padEnd(8) + (ms < 0 ? 'n/a' : ms + 'ms');

  return (
    <div className="bootstats">
      <button
        type="button"
        className="bootstats__pill"
        onClick={() => setOpen(o => !o)}
        aria-label="Toggle boot stats"
      >
        BOOT {stats.boot >= 0 ? (stats.boot / 1000).toFixed(2) + 's' : '?'}
      </button>
      {open && (
        <div className="bootstats__panel">
          <pre className="bootstats__rows">
{row('boot', stats.boot) + '\n' +
  row('pre', stats.pre) + '\n' +
  row('wasm', stats.wasm) + '\n' +
  row('pak', stats.pak) + '\n' +
  row('records', stats.records) + '\n' +
  row('p1', stats.p1) + '\n' +
  row('p2', stats.p2) + '\n' +
  row('stage', stats.stage) + '\n' +
  `longtask ${stats.ltN}× ${stats.ltTotal}ms max=${stats.ltMax}ms\n` +
  `gz       worker×${gz.worker} inline×${gz.inline}`}
          </pre>
          <div className="bootstats__btnrow">
            <button type="button" className="bootstats__btn" onClick={copy}>
              {copied ? 'COPIED' : 'COPY'}
            </button>
            <button
              type="button"
              className="bootstats__btn bootstats__btn--x"
              onClick={() => setOpen(false)}
              aria-label="Close boot stats"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
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
  // The hidden boot log's tail is embedded in the error's "Technical
  // Details" (see bootDetails in bootEngine).
  const [bootError, setBootError] = useState<string | null>(null);

  // Boot-stats HUD (?bootstats=1 — real-phone verification readout). The
  // payload arrives from bootEngine right before the engine starts; the
  // visibility flag is read post-mount because localStorage is client-only.
  const [bootStats, setBootStats] = useState<BootStats | null>(null);
  const [bootStatsOn, setBootStatsOn] = useState(false);
  useEffect(() => {
    try { setBootStatsOn(localStorage.getItem('fg-boot-stats') === '1'); } catch { /* private */ }
  }, []);

  // ---- Online (net=1) flow state ----
  // bootEngine() runs the preboot (game data + netplay bridge), then parks
  // on a promise that this state machine resolves with the final match
  // config once both players picked fighters (and the host a stage).
  const isNetFlow = (searchParams.get('net') || '') === '1';
  const [netPhase, setNetPhase] = useState<NetPhase>('idle');
  const [netRole, setNetRole] = useState<'host' | 'join'>('host');
  const [netBridgeStarted, setNetBridgeStarted] = useState(false);
  // The universe both fighters browse — the HOST picks it on the group
  // screen (normal fighting-game flow: modes → universe → fighter) and it
  // rides a 'group' control frame to the guest. Both grids then show the
  // SAME folder, which keeps the shared grid-index cursor/lock sync
  // meaningful (previously each side could browse a different folder and
  // the opponent-cursor highlight pointed at the wrong card).
  const [netGroup, setNetGroup] = useState<string | null>(null);
  const [netMine, setNetMine] = useState<{ id: string | null; locked: boolean }>({ id: null, locked: false });
  const [netOpp, setNetOpp] = useState<{ id: string | null; locked: boolean; liveIdx: number | null }>({ id: null, locked: false, liveIdx: null });
  const [netError, setNetError] = useState<string | null>(null);
  const netRoleRef = useRef<'host' | 'join'>('host');
  const netResolveRef = useRef<((cfg: NetFightConfig | null) => void) | null>(null);
  // ---- Post-fight session (rematch) state ----
  // After a clean engine exit the WebRTC channel is STILL OPEN at page level
  // (the bridge outlives the engine). The postfight panel offers a rematch:
  // the host re-boots the engine in place from the ALREADY-COMPILED wasm
  // module (netRebootRef, assigned by bootEngine) — no reload, no relay round
  // trip, no lost room.
  const [netRebooting, setNetRebooting] = useState(false);
  const [netRebootMsg, setNetRebootMsg] = useState('');
  const [netOppDrop, setNetOppDrop] = useState(false); // in-fight opponent disconnect overlay
  const [netLeaveAsk, setNetLeaveAsk] = useState(false); // BACK / cancel confirmation
  const [netRematchSent, setNetRematchSent] = useState(false); // guest: request pending
  const [netOppRematch, setNetOppRematch] = useState(false); // host: request received
  // ---- Pre-fight connection quality ----
  // The bridge measures an RTT with its own netping/netpong IKWS frames
  // (see webrtc.js dispatchControl) — surfaced as a small comic pill on the
  // pre-fight screens so both players can see the link quality BEFORE
  // committing to a fight. The engine's rollback ping takes over mid-fight
  // (diagnostics header), so the pill only renders pre-fight.
  const [netRtt, setNetRtt] = useState(-1);
  // ---- Live spectate cursors (group + stage screens) ----
  // The character grid shows the opponent's browsing cursor live; the
  // universe and stage screens used to go dark instead (audit nit). The
  // browsing side publishes its index ('gcursor'/'scursor' frames) and the
  // spectating guest highlights that card. Indexes are ABSOLUTE positions
  // in the manifest-ordered lists, identical on both sides (build check).
  const [netGroupCursor, setNetGroupCursor] = useState<number | null>(null);
  const [netStageCursor, setNetStageCursor] = useState<number | null>(null);
  // Guest-side stage prefetch timer ('scursor'-driven; see handleNetControl).
  // Cleared on unmount — a pending debounce must not outlive the flow.
  const netStagePrefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const netRttVisible = 
    netPhase === 'connecting' || netPhase === 'groupselect' ||
    netPhase === 'charselect' || netPhase === 'stageselect' || netPhase === 'waiting';
  useEffect(() => {
    if (!netRttVisible) return;
    const read = () => {
      const r = (globalThis as any).ikemenNet?.rtt?.();
      setNetRtt(typeof r === 'number' && r >= 0 ? Math.round(r) : -1);
    };
    read();
    const id = setInterval(read, 1000);
    return () => clearInterval(id);
  }, [netRttVisible]);
  const netLastFightRef = useRef<{ p1: string; p2: string; stage: string; dm: NetDisplayMode } | null>(null);
  const netRebootRef = useRef<((cfg: NetFightConfig, dm: NetDisplayMode) => Promise<void>) | null>(null);
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
    } else if (t === 'group') {
      // Guest: the host picked the universe (chars* folder id) — join them
      // in character select on that folder.
      const src = typeof m.src === 'string' ? m.src : '';
      if (!src) return;
      setNetGroup(src);
      setNetGroupCursor(null); // browsing is over — clear the spectate cursor
    } else if (t === 'gcursor') {
      const idx = typeof m.idx === 'number' ? m.idx : null;
      setNetGroupCursor(idx);
    } else if (t === 'scursor') {
      const idx = typeof m.idx === 'number' ? m.idx : null;
      setNetStageCursor(idx);
      // Guest-side stage prefetch — the "disconnects before the match starts"
      // family. The guest learns the stage only at 'go', which used to drop a
      // multi-MB download INSIDE the engine-boot window: the window where the
      // opponent's engine is already waiting on the netplay handshake and
      // where the documented phone renderer-kill lives. The host's live
      // browsing cursor is the earliest signal available — download the
      // DWELLED-ON stage now (debounced; fly-overs cancelled), so 'go' finds
      // it cached or mid-flight (the downloader's in-flight registry dedupes
      // and the boot path piggybacks on it). The stage id rides the frame
      // because the index is a per-device position in a probed list (the
      // availability probe can keep different stages per device).
      const sid = typeof m.id === 'string' ? m.id : '';
      if (sid && netRoleRef.current === 'join') {
        if (netStagePrefetchTimer.current) clearTimeout(netStagePrefetchTimer.current);
        netStagePrefetchTimer.current = setTimeout(() => {
          netStagePrefetchTimer.current = null;
          (async () => {
            try {
              const manifest = await fetchAssetsManifest();
              const stg = manifest.stages.find(s => s.id === sid);
              if (stg) await downloadStageToCache(stg);
            } catch { /* boot fallback reports real failures */ }
          })();
        }, 1200);
      }
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
      if (dm === '4:3' || dm === '16:9' || dm === 'tall' || dm === '3:2' || dm === '14:9' || dm === '5:3') {
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
      setNetOppDrop(false);
      setNetGroupCursor(null);
      setNetStageCursor(null);
      if (netResolveRef.current) {
        // FIRST fight of this session: resolve the bootEngine park.
        netResolveRef.current({ p1, p2, stage });
      } else {
        // Rematch / re-pick: the park is long gone — boot the engine IN PLACE
        // (fresh process over the still-open WebRTC channel; see netRebootRef).
        netRebootRef.current?.({ p1, p2, stage }, (dm as NetDisplayMode) || '16:9');
      }
    } else if (t === 'rematch') {
      // Guest asked to run it back — the host's panel says so; the host
      // confirms by pressing REMATCH (which re-sends 'go' with the same cfg).
      setNetOppRematch(true);
    } else if (t === 'back') {
      // Host sent everyone back to the fighter grid (CHANGE FIGHTERS).
      // The universe stays synced; both sides re-pick from scratch.
      setNetMine({ id: null, locked: false });
      setNetOpp({ id: null, locked: false, liveIdx: null });
      setNetRematchSent(false);
      setNetOppRematch(false);
      setNetGroupCursor(null);
      setNetStageCursor(null);
      setNetPhase('charselect');
    } else if (t === 'leave') {
      // The opponent left the session on purpose (lobby / room closed).
      setNetError('Your opponent left the session.');
      setNetPhase('error');
      setNetRebooting(false);
      netResolveRef.current?.(null);
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

  // Browsing cursors for the universe / stage screens (same sync family as
  // the character grid's 'cursor' frame — tiny, fire-and-forget, dropped
  // silently when the channel is dead; the poller reports real drops).
  const handleNetGroupCursor = useCallback((index: number) => {
    const net = (globalThis as any).ikemenNet;
    try { net?.control?.({ t: 'gcursor', idx: index }); } catch { /* ignore */ }
  }, []);
  const handleNetStageCursor = useCallback((index: number, stageId: string | null) => {
    const net = (globalThis as any).ikemenNet;
    // The id rides along so the spectating guest can PREFETCH the dwelled-on
    // stage before 'go' (see the 'scursor' branch in handleNetControl).
    try { net?.control?.({ t: 'scursor', idx: index, id: stageId || undefined }); } catch { /* ignore */ }
  }, []);

  // ---- Leaving /play must not orphan the bridge (audit nit) ----
  // Every BUTTONED exit is a full-page navigation (sockets die with the
  // tab), but browser BACK during the ENGINE-driven ranked queue runs no
  // guard (netPhase is 'idle' there) and lands on /lobby as an SPA
  // navigation — the bridge, its queue socket (relay slot still held) and
  // the floating NETPLAY panel all survive onto the new page. Unmount is
  // the one point every departure crosses: say goodbye first (courtesy
  // 'leave' frame, opponent's error screen lands instantly), then close.
  useEffect(() => {
    return () => {
      const net = (globalThis as any).ikemenNet;
      if (netStagePrefetchTimer.current) clearTimeout(netStagePrefetchTimer.current);
      if (!net) return;
      try {
        if (typeof net.connected === 'function' && net.connected()) {
          try { net.control?.({ t: 'leave' }); } catch { /* channel dead */ }
          setTimeout(() => { try { net.close(); } catch { /* gone */ } }, 200);
        } else {
          net.close();
        }
      } catch { /* page is going away anyway */ }
    };
  }, []);

  // Host confirmed the universe → sync it to the guest and advance both
  // sides to character select (the phase machine fires on netGroup).
  const handleNetGroupPick = useCallback((sourceId: string) => {
    setNetGroup(sourceId);
    const net = (globalThis as any).ikemenNet;
    try { net?.control?.({ t: 'group', src: sourceId }); } catch { /* the poller reports real drops */ }
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
    setNetOppDrop(false);
    if (netResolveRef.current) {
      // FIRST fight of this session: resolve the bootEngine park.
      netResolveRef.current(cfg);
    } else {
      // Rematch cycle: boot the engine in place over the live channel.
      netRebootRef.current?.(cfg, dm);
    }
  }, [netMine.id, netOpp.id]);

  // Immediate teardown + lobby. The courtesy 'leave' frame is sent FIRST
  // (while the channel is still open) so the opponent lands on their error
  // screen instantly instead of waiting out the ICE timeout; the close is
  // delayed a beat so the frame flushes before the SCTP association dies.
  const leaveNetNow = useCallback(() => {
    const net = (globalThis as any).ikemenNet;
    try { net?.control?.({ t: 'leave' }); } catch { /* channel already dead */ }
    const finish = () => {
      try { net?.close?.(); } catch { /* already gone */ }
      netResolveRef.current?.(null);
      try { sessionStorage.removeItem('engine-boot-live'); } catch { /* ignore */ }
      window.location.href = '/lobby';
    };
    setTimeout(finish, 200);
  }, []);

  // Every in-page exit (BACK buttons, CANCEL, touch exit) goes through here.
  // A LIVE session is a shared object: killing it strands the opponent on a
  // dead channel, so a tap that would do that asks first. Before the room is
  // established (role screen, silent connect failure) there is nothing to
  // protect — leave immediately.
  const cancelNetFlow = useCallback(() => {
    const net = (globalThis as any).ikemenNet;
    if (net && typeof net.connected === 'function' && net.connected()) {
      setNetLeaveAsk(true);
      return;
    }
    try { net?.close?.(); } catch { /* already gone */ }
    netResolveRef.current?.(null);
    try { sessionStorage.removeItem('engine-boot-live'); } catch { /* ignore */ }
    window.location.href = '/lobby';
  }, []);

  // ---- Postfight panel actions (the rematch offer) ----
  // Host: REMATCH re-sends the exact 'go' frame of the last fight — both
  // engines re-boot in place over the still-open channel. CHANGE FIGHTERS
  // walks BOTH sides back to the fighter grid with the room intact.
  // Guest: REQUEST REMATCH is a vote the host sees on their panel.
  const postfightRematch = useCallback(() => {
    const last = netLastFightRef.current;
    if (!last) return;
    const net = (globalThis as any).ikemenNet;
    try { net?.control?.({ t: 'go', p1: last.p1, p2: last.p2, stage: last.stage, dm: last.dm }); } catch { /* the poller reports real drops */ }
    setNetPhase('fight');
    setNetOppDrop(false);
    netRebootRef.current?.({ p1: last.p1, p2: last.p2, stage: last.stage }, last.dm);
  }, []);

  const postfightChangeFighters = useCallback(() => {
    const net = (globalThis as any).ikemenNet;
    try { net?.control?.({ t: 'back' }); } catch { /* the poller reports real drops */ }
    setNetMine({ id: null, locked: false });
    setNetOpp({ id: null, locked: false, liveIdx: null });
    setNetRematchSent(false);
    setNetOppRematch(false);
    setNetPhase('charselect');
  }, []);

  const postfightRequestRematch = useCallback(() => {
    if (netRematchSent) return;
    const net = (globalThis as any).ikemenNet;
    try { net?.control?.({ t: 'rematch' }); } catch { /* the poller reports real drops */ }
    setNetRematchSent(true);
  }, [netRematchSent]);

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
  // 'fight' and 'postfight' are watched TOO (the mid-fight silence bug): the
  // engine owns the main thread there, so the page's only line to the truth
  // is the bridge state. In-fight death raises a non-destructive overlay
  // (the engine's own exit triage closes the story); post-fight death ends
  // the rematch wait explicitly.
  const NET_LIVE_PHASES: NetPhase[] = ['connecting', 'groupselect', 'charselect', 'stageselect', 'waiting', 'fight', 'postfight'];
  useEffect(() => {
    if (!NET_LIVE_PHASES.includes(netPhase)) return;
    let misses = 0;
    // connected-but-flagged patience: the bridge's failure flag can latch on
    // a false positive (zombie-watchdog sample taken while the opponent is
    // mid-download on a congested phone link, transient dc error). The flag
    // must STAY up across ~4s of polls before the overlay fires — long
    // enough for the bridge's pong self-heal to disprove a blip (a real
    // black hole never receives a pong, so its latch survives this window).
    let failTicks = 0;
    const timer = setInterval(() => {
      const net = (globalThis as any).ikemenNet;
      if (!net) return;
      if (netPhase === 'connecting') {
        if (typeof net.connected === 'function' && net.connected()) {
          setNetMine({ id: null, locked: false });
          setNetOpp({ id: null, locked: false, liveIdx: null });
          // Normal fighting-game flow: the universe is picked BEFORE the
          // fighter. Host chooses on the group screen; the guest spectates
          // there until the host's 'group' frame arrives.
          setNetGroup(null);
          setNetPhase('groupselect');
        } else if (typeof net.failed === 'function' && net.failed()) {
          setNetError('Connection failed. Both players should retry (a VPN or hotspot can help stubborn routers).');
          setNetPhase('error');
          netResolveRef.current?.(null);
        }
        return;
      }
      if (netPhase === 'fight') {
        // dc.onclose is the only thing that flips isConnected mid-fight (the
        // transport's transient 'disconnected' rides a 12s recovery grace in
        // the bridge and never touches isConnected), so 3 dead polls = the
        // channel is genuinely gone. A latched failure flag alone needs the
        // patient failTicks window below instead. The overlay is
        // informational AND self-retracting: if the flag was a blip and the
        // bridge heals it, a later alive poll takes the report back down.
        // The engine will exit on its own when its reads return null, and
        // the post-run triage lands the phase machine on 'error'.
        const alive = typeof net.connected === 'function' && net.connected();
        const flagged = typeof net.failed === 'function' && net.failed();
        if (alive && !flagged) {
          misses = 0;
          failTicks = 0;
          setNetOppDrop(false); // no-op while hidden; retracts a healed blip
          return;
        }
        if (!alive) {
          misses += 1;
          if (misses >= 3) setNetOppDrop(true);
          return;
        }
        failTicks += 1;
        if (failTicks >= 8) setNetOppDrop(true);
        return;
      }
      if (netPhase === 'postfight') {
        // The opponent did not stick around for the rematch offer.
        if (typeof net.connected === 'function' && net.connected()) {
          misses = 0;
          return;
        }
        misses += 1;
        if (misses >= 4 || (typeof net.failed === 'function' && net.failed())) {
          setNetError('Your opponent left the session.');
          setNetPhase('error');
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

  // ---- BACK-button session guard (the "one accidental press kills the set" bug) ----
  // Every phase from 'connecting' onward holds a LIVE shared session. Browser
  // BACK (the instinctive gesture) used to navigate /play away with zero
  // ceremony — the room died, the opponent stared at a frozen screen. A guard
  // history entry swallows the first BACK and asks; STAY re-arms the trap,
  // LEAVE tears the session down politely. beforeunload covers desktop
  // reload/close (mobile browsers routinely ignore it — the history trap is
  // the layer that matters on phones).
  const sessionLive = isNetFlow && NET_LIVE_PHASES.includes(netPhase);
  useEffect(() => {
    if (!sessionLive) return;
    window.history.pushState({ fgNetGuard: true }, '');
    const onPop = () => {
      setNetLeaveAsk(true);
      // Consume-and-rearm: the pop ate the guard entry; push it back so the
      // NEXT press is caught too (whether they stay or the overlay is still up).
      window.history.pushState({ fgNetGuard: true }, '');
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [sessionLive]);

  // ---- Screen Wake Lock across the live net flow ----
  // Two phones in a room: the WAITING player's screen dozes (auto-lock) and
  // the OS suspends the tab — the P2P datachannel dies, and the opponent's
  // FIGHT press lands on a dead session ("disconnects before the match
  // starts", field report). Hold a screen wake lock for the whole live
  // window (connecting → postfight): the select screens are exactly where a
  // player idles without touching the screen. Mid-fight the engine's
  // continuous rendering keeps the screen alive on its own; the lock costs
  // nothing there and re-arms automatically if the tab is hidden and shown
  // again (the OS releases the sentinel on hide, per spec).
  useEffect(() => {
    if (!sessionLive) return;
    type WakeSentinel = { release: () => Promise<void>; addEventListener: (t: string, cb: () => void) => void };
    let sentinel: WakeSentinel | null = null;
    let disposed = false;
    const acquire = async () => {
      if (sentinel || disposed) return;
      try {
        const wl = (navigator as Navigator & {
          wakeLock?: { request: (type: 'screen') => Promise<WakeSentinel> };
        }).wakeLock;
        if (!wl) return; // unsupported (older browser) — purely best-effort
        sentinel = await wl.request('screen');
        sentinel.addEventListener('release', () => { sentinel = null; });
      } catch { /* denied / low battery / not allowed — silently fine */ }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void acquire(); };
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisible);
      const s = sentinel;
      sentinel = null;
      if (s) s.release().catch(() => { /* already released */ });
    };
  }, [sessionLive]);

  // ---- Online phase machine ----
  // Host picks the universe → both sides advance to the fighter grid. Both
  // picks in → host goes to stage select, guest to the waiting view. A
  // re-pick walks the phase back so the other side sees it live.
  useEffect(() => {
    if (netPhase === 'groupselect') {
      // Host: advances on their own pick. Guest: advances when the host's
      // 'group' control frame lands (spectate mode blocks local picks, so
      // netGroup can only be set remotely for them).
      if (netGroup) setNetPhase('charselect');
    } else if (netPhase === 'charselect') {
      if (netRole === 'host' && netMine.locked && netOpp.locked) setNetPhase('stageselect');
      if (netRole === 'join' && netMine.locked) setNetPhase('waiting');
    } else if (netPhase === 'stageselect') {
      if (!netMine.locked || !netOpp.locked) setNetPhase('charselect');
    } else if (netPhase === 'waiting') {
      if (!netMine.locked) setNetPhase('charselect');
    }
  }, [netPhase, netRole, netGroup, netMine.locked, netOpp.locked]);

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
    script.src = '/game/touch.js?v=2026-10-22.1';
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
    // the lobby — there is no website select session to return to. The
    // courtesy 'leave' frame lands while the channel is still open, so the
    // opponent sees "left the session" instead of waiting out an ICE timeout.
    setTimeout(() => {
      if (isNetFlow) {
        try { (globalThis as any).ikemenNet?.control?.({ t: 'leave' }); } catch { /* channel already dead */ }
        setTimeout(() => { window.location.href = '/lobby'; }, 150);
        return;
      }
      window.location.href = '/local';
    }, 500);
  };

  useEffect(() => {
    let cancelled = false;

    async function bootEngine() {
      const boot = bootRef.current;
      if (!boot) return;

      // Main-thread stall instrumentation runs from boot start to engine
      // start (long tasks >50ms are counted; one summary line logs right
      // before go.run). StrictMode double-mount just resets the counters.
      bootTimingStart();

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

      // The on-screen boot terminal is HIDDEN by default (user request:
      // the green log spooked the pre-match screen). bootLines still records
      // every line — failures embed the tail below into the error overlay's
      // Technical Details, so the "send a screenshot" flow keeps its
      // diagnostics without the terminal being visible on every boot.
      const bootDetails = () => {
        const lines = bootLines.filter(Boolean).slice(-30);
        return lines.length
          ? '\n\n--- Boot log (last ' + lines.length + ' lines) ---\n' + lines.join('\n')
          : '';
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
        // controlled by the Settings UI via the persisted config.ini
        // (written by applyDisplayModeChoice). vfs.js reads the config on
        // boot; this is the single source of truth.
        //
        // Presentation (ONE path for every display mode): the canvas is
        // displayed at its intrinsic aspect ratio, fitted to the largest
        // size that fully fits inside the viewport (contain), centered.
        // Every mode renders a 16:9 canvas — the 16:9 presets natively
        // (1280x720 / 1920x1080) and the Expanded mode via
        // 1280x720 + FightAspect=16,9 with the vfs.js stage fit (more
        // stage visible in every direction than plain 16:9) — so plain
        // contain-fit is correct for all of them: a 16:9 viewport is
        // filled edge-to-edge (no pillarbox), tall/narrow viewports
        // letterbox, and the picture itself is always undistorted and
        // uncropped.
        //
        // PORTRAIT GAME BOY MODE (touch only): on a coarse-pointer device
        // held in portrait the canvas is pinned to the TOP of the screen at
        // full width instead of centering, leaving the lower half for the
        // touch controls — a Game Boy style layout (screen up, buttons
        // down). --ikemen-screen-bottom on <html> marks where the game
        // screen ends so touch.js pills and the fight exit button can dock
        // below it. Landscape and non-touch portrait keep the exact
        // centered presentation that has always shipped (var = 0px →
        // consumers compute their old positions).
        const fitCanvasToViewport = () => {
          const canvas = document.querySelector('canvas#ikemen-canvas') as HTMLCanvasElement | null;
          if (!canvas || canvas.width <= 0 || canvas.height <= 0) return false;

          const viewport = window.visualViewport;
          // html.phone-landscape (game.css) zooms the root to 0.7 on phones
          // in landscape: the layout viewport is 1/0.7x the physical units
          // that visualViewport/innerWidth report, while style px are layout
          // units — unscale the measurement so the canvas still fills the
          // physical screen. Keep in sync with the 0.7 in game.css.
          const ZOOM = document.documentElement.classList.contains('phone-landscape') ? 0.7 : 1;
          const viewportWidth = (viewport?.width || window.innerWidth) / ZOOM;
          const viewportHeight = (viewport?.height || window.innerHeight) / ZOOM;

          const aspect = canvas.width / canvas.height;

          // Maximum aspect-ratio-preserving size that fits entirely in the
          // current viewport. Wide viewports get pillarboxing on the sides;
          // tall/narrow viewports get the equivalent top/bottom letterbox.
          const displayWidth = Math.min(viewportWidth, viewportHeight * aspect);
          const displayHeight = displayWidth / aspect;

          // Primary pointer coarse = phone/tablet held in hand. Primary
          // pointer fine (desktop, touchscreen laptops) keeps centering.
          const portraitGameboy =
            viewportHeight > viewportWidth &&
            window.matchMedia('(pointer: coarse)').matches;
          // Gap between the screen top edge and the viewport top (below the
          // notch). Kept in sync with the --ikemen-screen-bottom calc below.
          const gbGap = 'calc(env(safe-area-inset-top, 0px) + 10px)';

          canvas.style.setProperty('width', displayWidth + 'px', 'important');
          canvas.style.setProperty('height', displayHeight + 'px', 'important');
          canvas.style.setProperty('object-fit', 'contain', 'important');
          canvas.style.setProperty('object-position', 'center', 'important');
          canvas.style.setProperty('left', '50%', 'important');
          if (portraitGameboy) {
            canvas.style.setProperty('top', gbGap, 'important');
            canvas.style.setProperty('transform', 'translate(-50%, 0)', 'important');
            document.documentElement.style.setProperty(
              '--ikemen-screen-bottom',
              `calc(${gbGap} + ${displayHeight}px)`,
            );
          } else {
            canvas.style.setProperty('top', '50%', 'important');
            canvas.style.setProperty('transform', 'translate(-50%, -50%)', 'important');
            document.documentElement.style.setProperty('--ikemen-screen-bottom', '0px');
          }
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
            document.documentElement.style.removeProperty('--ikemen-screen-bottom');
          };
        };

        // NOTE: the canvas fitter is installed by runEngineFight() below,
        // immediately before each engine run (first fight AND rematches) —
        // not here. Its cleanup tears down body.fighting and the resize
        // listeners, so keeping it alive across the whole select phase served
        // nothing: no canvas exists until the engine creates one, and the
        // online select screens manage their own scrolling.
        const qmode = searchParams.get('qmode') || 'quickvs'; // progression mode
        // Netplay modes (both use the WebRTC bridge - public/game/webrtc.js,
        // engine netplay_js.go):
        //   net=1      ONLINE MODE via the WEBSITE: role pick (host/join) and
        //              room codes on the site, then the normal fighting-game
        //              chain — the HOST picks the universe (group screen,
        //              synced to the guest via a 'group' control frame), BOTH
        //              players pick their fighter, the host the stage — all
        //              on the site's own select screens, picks riding the
        //              bridge as IKWS control frames — and the engine boots
        //              into the fight with the agreed roster. NO engine-side
        //              menus at any point.
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

        // Re-entrant on purpose: every engine run ends with cleanup() tearing
        // the guard down, and an in-place rematch re-installs it for the next
        // fight. Removing the previous pair first keeps re-installation from
        // stacking duplicate listeners.
        const installKeyboardGuard = () => {
          if (onKeyDown) window.removeEventListener('keydown', onKeyDown, true);
          if (onKeyUp) window.removeEventListener('keyup', onKeyUp, true);
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

        // ---- Per-fight engine run (shared by the first boot AND rematches) --
        // Everything from "the engine is about to take the main thread" to
        // "the run resolved" lives in ONE function so an in-place rematch can
        // call it a second time. Returns true when a fight genuinely finished
        // (lastFightResult stashes the marker for the progression branch);
        // false means a death overlay was already shown and the caller must
        // stop. The exit triage inside is the historical one — moved, not
        // rewritten.
        let lastFightResult: ReturnType<typeof readFightResult> = null;
        const runEngineFight = async (
          activeGo: any,
          instance: WebAssembly.Instance,
          argv: string[],
          fightRefs: { p1: string; p2: string; stage: string },
          isReboot: boolean,
        ): Promise<boolean> => {
          activeGo.argv = argv;

          // Per-run presentation. The fitter is (re)installed fresh: the
          // previous run's cleanup() tore it down along with body.fighting.
          // The keyboard guard re-arms for the same reason.
          canvasFitCleanup = installCanvasFit();
          if (netMode) installKeyboardGuard();
          if (!isReboot && boot) {
            // Hide the boot log once the engine starts
            boot.style.opacity = '0';
            boot.style.transition = 'opacity 1s';
            setTimeout(() => { if (boot) boot.style.display = 'none'; }, 1000);
          }

          // --- Auto-focus the engine canvas once created ---
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

          // --- Run the engine ---
          // Paint first, measure, THEN hand the thread to the engine: go.run()
          // is one long main-thread block (Go wasm is single-threaded here), so
          // without this yield the last boot-log lines ("Engine starting...")
          // would only render after the first engine frame. The summary line
          // also closes the long-task observation window here — everything
          // after this point is the engine's own boot, not the JS pipeline.
          // (Boot-timing instrumentation measures the FIRST run only.)
          if (!isReboot) {
            const bootSummary = bootTimingSummary();
            log(bootSummary.text);
            setBootStats(bootSummary); // HUD readout (?bootstats=1)
            try { bootTiming?.observer?.disconnect(); } catch { /* advisory */ }
          }
          await new Promise((r) => setTimeout(r, 0));
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
          await activeGo.run(instance);

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
            // POISONED-CACHE SELF-HEAL: a truncated/corrupt cached asset (sff
            // cut mid-stream by a flaky network — the header survives, so no
            // sniff can see it) panics the engine at parse time and the panic
            // text names the VFS path. Purge the implicated match records so
            // RETRY re-downloads them, instead of replaying the same poisoned
            // bytes on every attempt ("character does not appear in the fight").
            let healedNote = '';
            try {
              const crashIdx = engineTail.indexOf(crashLine);
              const panicText = engineTail.slice(crashIdx, crashIdx + 30).join('\n');
              const purged = await purgeAssetsMentionedByPanic(panicText, fightRefs.p1, fightRefs.p2, fightRefs.stage);
              if (purged.length) {
                log('CACHE HEAL: purged damaged records for: ' + purged.join(', '));
                healedNote = ' The cached copy of ' + purged.join(' and ') +
                  ' was damaged and has been deleted — press RETRY to re-download it.';
              }
            } catch { /* healing is best-effort; the error screen still shows */ }
            setBootError('The game engine crashed (' + crashLine.slice(0, 200) + ').' + healedNote +
              ' Send a screenshot of this screen when reporting — expand Technical Details below to see how far the boot got.' + bootDetails());
            return false;
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
              '. Expand Technical Details below for the boot log - send a screenshot when reporting.' + bootDetails());
            return false;
          }
          if (!engineRan && !fightResult) {
            cleanup();
            clearBootLive();
            log('ENGINE EXITED BEFORE THE FIGHT STARTED' + (exitCode != null && exitCode !== 0 ? ' (exit code ' + exitCode + ')' : '') + '.');
            const tail = engineTail.slice(-4).join(' | ').slice(0, 240);
            setBootError('The game engine exited before the match started' + (exitCode != null && exitCode !== 0 ? ' (exit code ' + exitCode + ')' : '') +
              (tail ? '. Engine output: ' + tail : '') +
              '. Expand Technical Details below for the boot log. If this repeats, send a screenshot when reporting' + (netMode ? '; both players should also hard-refresh the page (Ctrl+F5) and retry.' : '.') + bootDetails());
            return false;
          }

          // Engine exited — fight is over. Read the match result and hand the
          // decision back to the caller.
          lastFightResult = fightResult;
          clearFightResult();
          cleanup();
          return true;
        };

        // ---- Net fight completion (first boot AND rematches) ----------------
        // The engine process is dead but the WEBSITE session (WebRTC channel,
        // select state, room) is still alive. A dead channel here means the
        // opponent vanished mid-fight — the old code logged "Fight complete.
        // Returning..." and dumped BOTH players at /lobby with no word, which
        // is the mid-fight-disconnect-is-invisible bug. A live channel means
        // the rematch offer is real: park on the postfight panel with the
        // fight's corpse cleared away and the agreed config stashed.
        const finishNetFight = (p1Ref: string, p2Ref: string, stageRef: string) => {
          const net = (globalThis as any).ikemenNet;
          const peerGone = !net || typeof net.connected !== 'function' || !net.connected();
          clearBootLive();
          if (peerGone) {
            log('Fight ended: the opponent is gone.');
            setNetError('Your opponent disconnected.');
            setNetPhase('error');
            return;
          }
          log('Fight complete. Rematch available.');
          netLastFightRef.current = {
            p1: p1Ref,
            p2: p2Ref,
            stage: stageRef,
            dm: netSyncedModeRef.current ?? '16:9',
          };
          teardownEngineCanvas();
          setEngineRunning(false);
          setNetRebooting(false);
          setNetPhase('postfight');
        };

        // ---- In-place rematch boot ------------------------------------------
        // After go.run() resolves, EVERYTHING the next fight needs is still
        // alive at page level: the compiled wasm module (WebAssembly.Module is
        // reusable across instances), the JS-side VFS (engineVfsInit state +
        // injected files + the patched config.ini), and above all the WebRTC
        // channel. So a rematch = fresh Go runtime + fresh instance from the
        // CACHED module + cache-first asset injection + a bridge buffer flush,
        // then runEngineFight() again. No reload — a reload would kill the P2P
        // session and force both players back through the room-code dance.
        const rebootNetAssets = async (cfg: NetFightConfig): Promise<{ p1Path: string; p2Path: string; stagePath: string }> => {
          // Mirror of the first-boot injection block, cache-first: unchanged
          // picks re-inject from the IndexedDB records in milliseconds;
          // CHANGED picks (after CHANGE FIGHTERS) download exactly like a
          // first boot does.
          const manifest = await fetchAssetsManifest();
          setNetRebootMsg('LOADING THE FIGHTERS…');
          const [p1Files, p2Files] = await Promise.all([
            getCachedCharacterFiles(cfg.p1),
            getCachedCharacterFiles(cfg.p2),
          ]);
          let p1Path = splitCharRef(cfg.p1).id;
          if (p1Files && await injectCharacterFiles(cfg.p1, p1Files)) {
            log(`P1 loaded from cache: ${cfg.p1}`);
          } else {
            const char = manifest.characters.find(c => charRef(c) === cfg.p1);
            if (!char) throw new Error(`Fighter "${cfg.p1}" is not in the assets manifest.`);
            await downloadAndInjectCharacter(char, (pct, msg) => setNetRebootMsg(`P1 ${msg} ${pct}%`));
            p1Path = char.id;
            log(`P1 ready: ${char.id}`);
          }
          let p2Path = splitCharRef(cfg.p2).id;
          if (p2Files && await injectCharacterFiles(cfg.p2, p2Files)) {
            log(`P2 loaded from cache: ${cfg.p2}`);
          } else {
            const char = manifest.characters.find(c => charRef(c) === cfg.p2);
            if (!char) throw new Error(`Fighter "${cfg.p2}" is not in the assets manifest.`);
            await downloadAndInjectCharacter(char, (pct, msg) => setNetRebootMsg(`P2 ${msg} ${pct}%`));
            p2Path = char.id;
            log(`P2 ready: ${char.id}`);
          }
          setNetRebootMsg('LOADING THE STAGE…');
          let stagePath: string;
          const stageFiles = await getCachedStageFiles(cfg.stage);
          if (stageFiles && await injectStageFiles(cfg.stage, stageFiles)) {
            const defFile = Object.keys(stageFiles).find(f => f.endsWith('.def'));
            stagePath = 'stages/' + (defFile || `${cfg.stage}.def`);
            log(`Stage loaded from cache: ${cfg.stage}`);
          } else {
            const stg = manifest.stages.find(s => s.id === cfg.stage);
            if (!stg) throw new Error(`Stage "${cfg.stage}" is not in the assets manifest.`);
            await downloadAndInjectStage(stg, (pct, msg) => setNetRebootMsg(`STAGE ${msg} ${pct}%`));
            stagePath = getStageDefPath(stg);
            log(`Stage ready: ${stagePath}`);
          }
          return { p1Path, p2Path, stagePath };
        };

        netRebootRef.current = async (cfg: NetFightConfig, dm: NetDisplayMode) => {
          try {
            setNetRebooting(true);
            setNetRebootMsg('PREPARING THE ENGINE…');
            setNetOppDrop(false);
            setNetRematchSent(false);
            setNetOppRematch(false);
            netSyncedModeRef.current = dm;
            const runtime2 = await runtimePromise;
            const compiled = await runtime2.wasmPromise;
            const go2 = new g.Go();
            // Same GC envelope as the module-scope runtime (the phone
            // tab-kill guard) — a rematch boot is a FULL engine process.
            go2.env = { GOGC: 'off', GOMEMLIMIT: WASM_HEAP_LIMIT_MIB + 'MiB' };
            try {
              const prevExit = go2.exit;
              go2.exit = (code: number) => {
                (globalThis as any).__engineExitCode = code;
                if (prevExit) prevExit.call(go2, code);
              };
            } catch { /* diagnostics must never block boot */ }
            const paths = await rebootNetAssets(cfg);
            // Fresh log window + flushed engine buffers: bytes still queued
            // from the previous fight must not be mistaken for handshake
            // frames by the new engine process. (The IKWS site channel and
            // its backlog are untouched — only engine data is flushed.)
            const gLog = (globalThis as any).__engineLog;
            if (Array.isArray(gLog)) gLog.length = 0;
            try { ((globalThis as any).ikemenNet as any)?.flushEngineBuffers?.(); } catch { /* dead channel fails visibly below */ }
            teardownEngineCanvas();
            setNetRebootMsg('STARTING THE FIGHT…');
            log(`Rematch boot: P1=${cfg.p1} vs P2=${cfg.p2} (stage ${cfg.stage})`);
            const instance2 = new WebAssembly.Instance(compiled.module, go2.importObject as any);
            const argv2 = [
              'ikemen',
              '-p1', paths.p1Path,
              '-p2', paths.p2Path,
              '-s', paths.stagePath,
              // The engine re-attaches to the LIVE site-established session
              // (webrtc.js start() reuse-guard) — same contract as first boot.
              '-ip', netRoleRef.current === 'join' ? 'webrtc' : '',
            ];
            const ran = await runEngineFight(go2, instance2, argv2, { p1: cfg.p1, p2: cfg.p2, stage: cfg.stage }, true);
            if (cancelled || !ran) {
              setNetRebooting(false);
              return;
            }
            finishNetFight(cfg.p1, cfg.p2, cfg.stage);
          } catch (e) {
            setNetRebooting(false);
            const msg = e instanceof Error ? e.message : String(e);
            log('REMATCH BOOT FAILED: ' + msg);
            setBootError('The rematch could not start: ' + msg +
              '. The connection to your opponent is still open — CHANGE FIGHTERS on their screen will still work.' + bootDetails());
          }
        };

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

        // --- 6. Resolution is controlled by Settings UI ---
        // Previously, /play set a global aspect override here, and vfs.js
        // used it to overwrite GameWidth/GameHeight in config.ini. Now that
        // Settings UI is authoritative (vfs.js no longer overwrites), we
        // don't set any aspect override at all. The engine boots with whatever
        // GameWidth/GameHeight is in localStorage config.ini (set by the
        // Settings UI).

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
          bootPhase('records:start');
          const [p1Files, p2Files, stageFiles] = await Promise.all([
            isBundledChar(effP1) ? Promise.resolve(null) : getCachedCharacterFiles(effP1),
            isBundledChar(effP2) ? Promise.resolve(null) : getCachedCharacterFiles(effP2),
            isBundledStage(effStage) ? Promise.resolve(null) : getCachedStageFiles(effStage),
          ]);
          bootPhase('records:ready');
          if (cancelled) return;

          // P1: inject from the in-hand record, fallback to download
          if (!isBundledChar(effP1)) {
            bootPhase('p1:start');
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
            bootPhase('p1:ready');
          }

          // P2: inject from the in-hand record, fallback to download
          if (!isBundledChar(effP2)) {
            bootPhase('p2:start');
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
            bootPhase('p2:ready');
          }

          // Stage: inject from the in-hand record, fallback to download.
          // The cache HIT path needs no manifest at all (the .def file is
          // resolved from the record's own file list — same rule
          // getStageDefPath applies); only the miss path fetches it.
          if (!isBundledStage(effStage)) {
            bootPhase('stage:start');
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
            bootPhase('stage:ready');
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

        // --- 9. Engine run: build the argv, then hand everything to
        // runEngineFight() — the per-fight machinery (fitter, focus, run,
        // exit triage) defined above, shared with the rematch path.
        if (netMenu || netDirect) {
          const wireRole = netMenu ? netRoleRef.current : netDirectRole;
          log(`Engine starting... (netplay ${wireRole} - connecting via WebRTC bridge)`);
        } else {
          log('Engine starting... (quick match, bypassing menu)');
        }

        const engineArgv = (netMenu || netDirect)
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

        const ran = await runEngineFight(go, result.instance, engineArgv, { p1: effP1, p2: effP2, stage: effStage }, false);
        if (cancelled || !ran) return;

        if (netMenu) {
          // Online: the engine exited after a real fight, but the WEBSITE
          // session is still alive. Park on the rematch panel instead of the
          // old "Fight complete. Returning..." navigation, which dumped BOTH
          // players at /lobby and destroyed the room (the no-rematch bug).
          finishNetFight(effP1, effP2, effStage);
          return;
        }

        if (lastFightResult && qmode !== 'quickvs' && qmode !== 'training') {
          // Progression mode — process the result and advance
          const action = processFightResult(lastFightResult);
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

        // Single-fight mode (quickvs/training).
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
            setBootError('The game engine crashed (' + crashLine.slice(0, 200) + '). Send a screenshot of this screen when reporting — expand Technical Details below to see how far the boot got.' + bootDetails());
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
          setBootError('The game engine crashed (' + why + '). Technical Details below and the browser console (F12) hold the details - send them along when reporting.' + bootDetails());
          return;
        }
        log('BOOT ERROR: ' + msg);
        console.error(e);
        clearBootLive();
        if (!cancelled) setBootError(msg + bootDetails());
      }
    }

    bootEngine();

    return () => {
      cancelled = true;
      // The reboot closure belongs to THIS mount's boot scope — a remount
      // (hot reload, StrictMode) must not fire a stale one.
      netRebootRef.current = null;
    };
    // NOTE: isTouch is intentionally NOT in the deps array. The hook
    // starts as false (SSR-safe) and flips to true on mount. If we
    // included isTouch, this effect would re-fire when isTouch flips,
    // cancelling the first bootEngine() mid-WASM-load and starting a
    // second one (race condition: duplicate <script> tags, double
    // fetch of engine.wasm, etc.). The touch UI is handled in render
    // via the isTouch && engineRunning condition — no need to re-boot.
  }, [searchParams]);

  // The boot terminal is hidden by default (user request: they don't want
  // to see the green log before a match). ?debug=1 on the URL re-shows the
  // raw terminal for live diagnosis of a misbehaving device.
  const showBootTerminal = searchParams.get('debug') === '1';

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center">
      <pre
        ref={bootRef}
        id="boot"
        className="w-full max-w-2xl text-sm text-green-400 font-mono whitespace-pre-wrap leading-relaxed mb-4"
        style={{ maxHeight: '200px', overflow: 'hidden' }}
        hidden={!showBootTerminal}
      />
      {/* Minimal boot indicator replacing the visible terminal — a quiet
          pulsing LOADING label instead of scrolling green log lines. It
          unmounts once the engine is up (or an error overlay takes over). */}
      {!engineRunning && !bootError && !showBootTerminal && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 5,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <span
            className="animate-pulse"
            style={{
              fontFamily: 'var(--font-poster)',
              color: 'var(--paper, #f2ecda)',
              fontSize: '1.1rem',
              letterSpacing: '0.3em',
              paddingLeft: '0.3em',
              textShadow: '3px 3px 0 var(--crimson, #e8283c)',
            }}
          >
            LOADING
          </span>
        </div>
      )}
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
            gap: '0.9rem',
            backgroundColor: 'var(--paper, #f2ecda)',
            backgroundImage: 'radial-gradient(rgba(16,16,24,0.1) 1.2px, transparent 1.4px)',
            backgroundSize: '13px 13px',
            color: 'var(--ink, #101018)',
          }}
        >
          <div style={{ fontSize: '0.65rem', letterSpacing: '0.35em', color: 'var(--crimson, #e8283c)', fontWeight: 700 }}>
            ISSUE No. 05 — THE NETWORK
          </div>
          <h1 style={{
            fontFamily: 'var(--font-poster)', fontSize: '2.6rem', letterSpacing: '0.04em',
            color: 'var(--ink, #101018)', textShadow: '4px 4px 0 var(--crimson, #e8283c)',
            lineHeight: 1, textTransform: 'uppercase', margin: '0 0 0.5rem',
          }}>
            ONLINE PLAY
          </h1>
          <div style={{ fontSize: '0.65rem', letterSpacing: '0.25em', color: 'var(--gray)', marginBottom: '1rem' }}>
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
            gap: '0.9rem', pointerEvents: 'none',
            // Opaque paper page (same treatment as the role screen): the
            // engine boots BEHIND this overlay to produce the netplay build
            // hash, and its big "NOW LOADING" splash used to bleed through
            // the old transparent background and collide with this copy.
            backgroundColor: 'var(--paper, #f2ecda)',
            backgroundImage: 'radial-gradient(rgba(16,16,24,0.1) 1.2px, transparent 1.4px)',
            backgroundSize: '13px 13px',
            color: 'var(--ink, #101018)',
          }}
        >
          <div style={{
            fontSize: '0.65rem', letterSpacing: '0.35em', color: 'var(--crimson, #e8283c)', fontWeight: 700,
          }}>
            ISSUE No. 05 — THE NETWORK
          </div>
          <div style={{
            fontFamily: 'var(--font-poster)', fontSize: '2.2rem', letterSpacing: '0.04em',
            color: 'var(--ink, #101018)', textShadow: '4px 4px 0 var(--crimson, #e8283c)',
            lineHeight: 1, textTransform: 'uppercase', textAlign: 'center',
          }}>
            {!netBridgeStarted
              ? 'LOADING GAME DATA…'
              : netRole === 'host'
              ? 'WAITING FOR YOUR FRIEND…'
              : 'CONNECTING TO THE HOST…'}
          </div>
          <div style={{ fontSize: '0.65rem', letterSpacing: '0.15em', color: 'var(--gray-dark, #4a4a56)', maxWidth: 440, textAlign: 'center' }}>
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
      {netPhase === 'groupselect' && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 40, overflowY: 'auto', background: 'var(--paper, #f2ecda)' }}>
          {/* Normal fighting-game flow, online edition: after the room opens
              the HOST picks the universe and the guest spectates this same
              screen until the 'group' control frame syncs the pick. */}
          <GroupSelect
            onConfirm={handleNetGroupPick}
            onCancel={cancelNetFlow}
            spectate={netRole === 'join'}
            spectateNote="YOUR OPPONENT IS CHOOSING THE UNIVERSE…"
            onCursor={handleNetGroupCursor}
            opponentIndex={netGroupCursor}
          />
        </div>
      )}
      {netPhase === 'charselect' && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 40, overflowY: 'auto', background: 'var(--paper, #f2ecda)' }}>
          <CharacterSelect
            isTouch={isTouch}
            initialSource={netGroup ?? undefined}
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
        <div style={{ position: 'fixed', inset: 0, zIndex: 40, overflowY: 'auto', background: 'var(--paper, #f2ecda)' }}>
          <StageSelect
            isTouch={isTouch}
            spectate={netPhase === 'waiting'}
            spectateNote="YOUR OPPONENT IS CHOOSING THE STAGE…"
            onCursor={handleNetStageCursor}
            opponentIndex={netStageCursor}
            onSelect={handleNetStage}
            onCancel={cancelNetFlow}
          />
        </div>
      )}
      {netPhase === 'error' && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(16,16,24,0.9)' }}>
          <ErrorState
            title="ONLINE MATCH ENDED"
            message={netError || 'The connection to your opponent was lost.'}
            onRetry={() => window.location.reload()}
            onBack={() => { window.location.href = '/lobby'; }}
          />
        </div>
      )}
      {netPhase === 'postfight' && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 46,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: '0.9rem',
            backgroundColor: 'var(--paper, #f2ecda)',
            backgroundImage: 'radial-gradient(rgba(16,16,24,0.1) 1.2px, transparent 1.4px)',
            backgroundSize: '13px 13px',
            color: 'var(--ink, #101018)',
          }}
        >
          <div style={{ fontSize: '0.65rem', letterSpacing: '0.35em', color: 'var(--crimson, #e8283c)', fontWeight: 700 }}>
            ISSUE No. 05 — THE NETWORK
          </div>
          <h2 style={{
            fontFamily: 'var(--font-poster)', fontSize: '2.4rem', letterSpacing: '0.04em',
            color: 'var(--ink, #101018)', textShadow: '4px 4px 0 var(--crimson, #e8283c)',
            lineHeight: 1, textTransform: 'uppercase', margin: '0 0 0.4rem', textAlign: 'center',
          }}>
            FIGHT COMPLETE
          </h2>
          <div style={{ fontSize: '0.65rem', letterSpacing: '0.25em', color: 'var(--gray)', marginBottom: '0.6rem' }}>
            {netRole === 'host' ? 'RUN IT BACK — OR FIND NEW FIGHTERS' : 'THE HOST DECIDES THE NEXT ROUND'}
          </div>
          {netRole === 'host' && netOppRematch && (
            <div style={{
              fontSize: '0.7rem', letterSpacing: '0.2em', fontWeight: 700,
              color: 'var(--paper, #f2ecda)', background: 'var(--crimson, #e8283c)',
              padding: '0.45rem 1rem', border: '2px solid var(--ink, #101018)',
              boxShadow: '3px 3px 0 var(--ink, #101018)',
            }}>
              YOUR OPPONENT WANTS A REMATCH
            </div>
          )}
          {netRole === 'host' ? (
            <>
              <GameButton variant="primary" onClick={postfightRematch} disabled={!netLastFightRef.current}>
                REMATCH
              </GameButton>
              <GameButton onClick={postfightChangeFighters}>
                CHANGE FIGHTERS
              </GameButton>
              <GameButton variant="danger" onClick={leaveNetNow}>
                ← BACK TO LOBBY
              </GameButton>
            </>
          ) : (
            <>
              <GameButton variant="primary" onClick={postfightRequestRematch} disabled={netRematchSent}>
                {netRematchSent ? 'WAITING FOR THE HOST…' : 'REQUEST REMATCH'}
              </GameButton>
              <GameButton variant="danger" onClick={leaveNetNow}>
                ← BACK TO LOBBY
              </GameButton>
            </>
          )}
        </div>
      )}

      {/* Rematch reboot overlay: the engine re-boots IN PLACE over the still
          open WebRTC channel — the dead canvas is already torn down behind
          this. Opaque paper hides the empty page during the fresh boot. */}
      {netRebooting && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 47,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: '0.9rem',
            backgroundColor: 'var(--paper, #f2ecda)',
            backgroundImage: 'radial-gradient(rgba(16,16,24,0.1) 1.2px, transparent 1.4px)',
            backgroundSize: '13px 13px',
            color: 'var(--ink, #101018)',
          }}
        >
          <div style={{ fontSize: '0.65rem', letterSpacing: '0.35em', color: 'var(--crimson, #e8283c)', fontWeight: 700 }}>
            ISSUE No. 05 — THE NETWORK
          </div>
          <div style={{
            fontFamily: 'var(--font-poster)', fontSize: '2.2rem', letterSpacing: '0.04em',
            color: 'var(--ink, #101018)', textShadow: '4px 4px 0 var(--crimson, #e8283c)',
            lineHeight: 1, textTransform: 'uppercase', textAlign: 'center',
          }}>
            LOADING THE NEXT FIGHT…
          </div>
          <div style={{ fontSize: '0.65rem', letterSpacing: '0.2em', color: 'var(--gray-dark, #4a4a56)', textAlign: 'center' }}>
            {netRebootMsg || 'PREPARING…'}
          </div>
        </div>
      )}

      {/* Pre-fight connection quality (bridge RTT from webrtc.js). Fixed
          top-right so it clears the centered select-screen mastheads;
          pointer-events none — pure readout. Sits UNDER the bridge's room
          panel (z 1000) during 'connecting', taking the corner once the
          panel retires itself 2.5s after connect. */}
      {netRttVisible && netRtt >= 0 && (
        <div
          style={{
            position: 'fixed', top: 'calc(env(safe-area-inset-top, 0px) + 10px)', right: 10, zIndex: 41,
            display: 'flex', alignItems: 'center', gap: '0.45rem',
            background: 'var(--paper, #f2ecda)', border: '2px solid var(--ink, #101018)',
            boxShadow: '3px 3px 0 var(--ink, #101018)', borderRadius: 2,
            padding: '0.3rem 0.6rem', pointerEvents: 'none',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 9, height: 9, borderRadius: '50%', display: 'inline-block',
              background: netRtt <= 70 ? 'var(--green, #43a058)'
                : netRtt <= 130 ? 'var(--royal, #3143d6)' : 'var(--crimson, #e8283c)',
            }}
          />
          <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.08em', color: 'var(--ink, #101018)' }}>
            {netRtt} MS
          </span>
        </div>
      )}

      {/* In-fight opponent-disconnect report (the mid-fight silence fix).
          The engine owns the main thread and will end the round when its
          reads return null; until then the player at least KNOWS why the
          opponent stopped moving — and has a way out that does not require
          guessing at browser gestures. */}
      {netOppDrop && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 48,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: '1rem', background: 'rgba(16,16,24,0.92)',
            color: 'var(--paper, #f2ecda)', textAlign: 'center', padding: '0 1.5rem',
          }}
        >
          <div style={{ fontSize: '0.65rem', letterSpacing: '0.35em', color: 'var(--crimson, #e8283c)', fontWeight: 700 }}>
            CONNECTION REPORT
          </div>
          <div style={{
            fontFamily: 'var(--font-poster)', fontSize: '2rem', letterSpacing: '0.04em',
            lineHeight: 1.1, textTransform: 'uppercase',
            textShadow: '4px 4px 0 var(--crimson, #e8283c)',
          }}>
            YOUR OPPONENT LOST CONNECTION
          </div>
          <div style={{ fontSize: '0.7rem', letterSpacing: '0.15em', color: 'rgba(242,236,218,0.75)', maxWidth: 420 }}>
            The match cannot continue. The engine will end the round on its own — or leave now.
          </div>
          <GameButton variant="danger" onClick={leaveNetNow}>
            LEAVE MATCH
          </GameButton>
        </div>
      )}

      {/* Leave-session confirmation: browser BACK and in-page cancels land
          here while a session is LIVE. z-index 1100 — above the bridge's own
          room panel (z 1000), so the question is readable during 'connecting'. */}
      {netLeaveAsk && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(16,16,24,0.9)', padding: '0 1.5rem' }}>
          <div style={{
            background: 'var(--paper, #f2ecda)', border: '3px solid var(--ink, #101018)',
            boxShadow: '6px 6px 0 var(--ink, #101018)', padding: '1.6rem 1.8rem',
            display: 'flex', flexDirection: 'column', gap: '0.8rem',
            alignItems: 'center', maxWidth: 420, textAlign: 'center',
          }}>
            <div style={{ fontSize: '0.65rem', letterSpacing: '0.3em', color: 'var(--crimson, #e8283c)', fontWeight: 700 }}>
              WAIT — YOUR SESSION IS LIVE
            </div>
            <div style={{
              fontFamily: 'var(--font-poster)', fontSize: '1.5rem', letterSpacing: '0.04em',
              textTransform: 'uppercase', lineHeight: 1.15, color: 'var(--ink, #101018)',
            }}>
              LEAVE THE ONLINE SESSION?
            </div>
            <div style={{ fontSize: '0.7rem', letterSpacing: '0.1em', color: 'var(--gray-dark, #4a4a56)' }}>
              Your opponent will be disconnected with you.
            </div>
            <div style={{ display: 'flex', gap: '0.7rem', marginTop: '0.4rem' }}>
              <GameButton variant="primary" onClick={() => setNetLeaveAsk(false)}>
                STAY
              </GameButton>
              <GameButton variant="danger" onClick={leaveNetNow}>
                LEAVE
              </GameButton>
            </div>
          </div>
        </div>
      )}

      {/* Structured boot-failure overlay (Frontend 2.1 spec Section 33).
          The boot terminal is hidden by default; each failure embeds the
          recent boot log inside `details` (Technical Details panel), and
          ?debug=1 re-shows the raw green terminal for live diagnosis. */}
      {bootError && (
        <ErrorState
          title="ENGINE FAILED TO START"
          message="The game engine could not finish booting. This is usually a network or browser-memory issue. Retrying reloads the engine; going back returns to character select."
          onRetry={() => window.location.reload()}
          onBack={() => { window.location.href = isNetFlow ? '/lobby' : '/local'; }}
          details={bootError}
        />
      )}

      {/* Floating exit button — touch only, shown after engine starts (a
          live engine only: during postfight the panel owns the screen). */}
      {isTouch && showExit && engineRunning && (
        <button
          type="button"
          className="fight__exit-touch"
          onClick={() => exitFightRef.current?.()}
          aria-label="Exit fight"
        >
          ✕
        </button>
      )}

      {/* Boot-stats HUD — real-phone verification readout (?bootstats=1).
          Top-left (the touch exit ✕ owns top-right). Tapping it also
          re-focuses the engine canvas via the document click handler, so it
          cannot steal input from the game. */}
      {bootStatsOn && bootStats && <BootStatsHud stats={bootStats} />}

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
        <span
          className="font-mono text-sm"
          style={{ color: 'rgba(242,236,218,0.6)', letterSpacing: '0.2em' }}
        >
          Loading...
        </span>
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
  bootPhase('wasm:start');
  const qs = stamp ? '?v=' + encodeURIComponent(stamp) : '';
  if (typeof DecompressionStream === 'function' && stamp) {
    try {
      const res = await fetchFn('/game/engine.wasm.gz' + qs, { cache: 'default' });
      if (res.ok && res.body) {
        // Worker gunzip first (off the main thread — cold-boot pile-up).
        // null = declined (kill-switch / unsupported, body untouched) ->
        // identical inline path as before. A worker failure AFTER the body
        // transferred leaves nothing to inline-decompress: catch maps it to
        // null and the pipeThrough below throws on the consumed body, which
        // the outer catch routes to the raw-wasm path (rare; same contract
        // as the corrupt-.gz fallback).
        let s: ReadableStream<Uint8Array> | null = null;
        try {
          s = await engineGzipDecode(res.body, 'wasm');
        } catch (e) {
          log('Worker gunzip failed (' + (e instanceof Error ? e.message : String(e)) + '), using raw wasm.');
        }
        const wasmStream = s ?? res.body.pipeThrough(new DecompressionStream('gzip'));
        const wasmRes = new Response(wasmStream, { headers: { 'Content-Type': 'application/wasm' } });
        const out = await WebAssembly.instantiateStreaming(wasmRes, go.importObject as any);
        bootPhase('wasm:ready');
        return out;
      }
      log('Compressed wasm unavailable (HTTP ' + res.status + '), falling back to raw.');
    } catch (e) {
      log('Compressed wasm path failed (' + (e instanceof Error ? e.message : String(e)) + '), falling back to raw.');
    }
  }
  const res = await fetchFn('/game/engine.wasm' + qs, { cache: 'no-cache' });
  try {
    const out = await WebAssembly.instantiateStreaming(res.clone(), go.importObject as any);
    bootPhase('wasm:ready');
    return out;
  } catch {
    log('Streaming compile failed, buffering...');
    const bytes = await res.arrayBuffer();
    const out = await WebAssembly.instantiate(bytes, go.importObject as any);
    bootPhase('wasm:ready');
    return out;
  }
}

// (DebugBadge component removed — was a development tool for touch
// control debugging, not needed in production per spec Section 50.)
