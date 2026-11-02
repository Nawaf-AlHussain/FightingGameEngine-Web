// F-053 — fight-time performance monitor (the `?fps=1` HUD payload).
//
// WHY: the user reported the game "suddenly feeling very laggy" on the live
// deployment. Sandbox evidence could not reproduce a regression (the
// pre-scrub baseline commit profiles identically — see FINDINGS F-053), so
// the deciding numbers have to come from the REPORTER's machine: live FPS,
// worst frame gap, long-task pressure and JS heap during real fights. This
// module instruments requestAnimationFrame (the engine renders through it,
// verified via diag-lag.mjs) and longtask/heap observers, exposes a
// snapshot for the HUD, and logs a greppable '[perf]' beacon every 5s —
// the same paste-into-chat pattern as the boot-stats HUD.
//
// Cost model: installed ONLY when the persisted `fg-fps-stats` flag is on
// (set via ?fps=1, cleared via ?fps=0) — normal players never pay the rAF
// wrapper, the observers or the beacon. Zero gameplay behavior change.

export interface FightPerfSnapshot {
  fps5: number;       // frames/sec over the trailing 5s window
  worstGap5: number;  // worst frame gap (ms) in the trailing 5s window
  frames: number;     // session frames since install
  avgFps: number;     // session average since install
  p90Delta: number;   // session p90 frame delta (ms)
  gaps100: number;    // session frame gaps > 100ms
  gaps250: number;    // session frame gaps > 250ms
  ltN: number;        // long tasks > 50ms (count)
  ltTotal: number;    // long tasks total ms
  ltMax: number;      // worst long task ms
  heapMb: number;     // JS heap MB (performance.memory), -1 unsupported
  elapsedSec: number; // seconds since install
}

declare global {
  interface Window {
    __fightPerf?: () => FightPerfSnapshot;
  }
}

let installed = false;

export function installFightFpsMonitor(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  const t0 = performance.now();
  let last = performance.now();
  let frames = 0;
  let worst = 0;
  let gaps100 = 0;
  let gaps250 = 0;
  const deltas: number[] = [];              // session sample (capped) for p90
  const recent: Array<{ t: number; d: number }> = []; // trailing 5s window
  const lts = { n: 0, total: 0, max: 0 };

  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        lts.n++;
        lts.total += e.duration;
        if (e.duration > lts.max) lts.max = e.duration;
      }
    });
    obs.observe({ type: 'longtask', buffered: false } as PerformanceObserverInit);
  } catch { /* longtask unsupported (Safari pre-16.4) — column stays zero */ }

  const origRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb: FrameRequestCallback): number =>
    origRaf((now: number) => {
      const d = now - last;
      last = now;
      if (d >= 0) {
        frames++;
        if (deltas.length < 12000) deltas.push(d);
        if (d > 100) gaps100++;
        if (d > 250) gaps250++;
        if (d > worst) worst = d;
        recent.push({ t: now, d });
        while (recent.length && now - recent[0].t > 5000) recent.shift();
      }
      cb(now);
    });

  const percentile = (arr: number[], p: number): number => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
  };

  window.__fightPerf = (): FightPerfSnapshot => {
    const now = performance.now();
    let worstGap5 = 0;
    for (const r of recent) if (r.d > worstGap5) worstGap5 = r.d;
    const span = recent.length > 1 ? now - recent[0].t : 5000;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return {
      fps5: span > 0 ? Math.round((recent.length / span) * 1000 * 10) / 10 : 0,
      worstGap5: Math.round(worstGap5),
      frames,
      avgFps: Math.round((frames / Math.max(1, now - t0)) * 1000 * 10) / 10,
      p90Delta: Math.round(percentile(deltas, 0.9)),
      gaps100,
      gaps250,
      ltN: lts.n,
      ltTotal: Math.round(lts.total),
      ltMax: Math.round(lts.max),
      heapMb: mem ? Math.round(mem.usedJSHeapSize / 1048576) : -1,
      elapsedSec: Math.round((now - t0) / 1000),
    };
  };

  // Greppable per-5s beacon — mirrors the '[boot-timing]' line pattern so a
  // bug report pasted from devtools carries the whole session's story.
  setInterval(() => {
    try {
      const s = window.__fightPerf?.();
      if (!s) return;
      console.log(
        `[perf] fps5=${s.fps5} worstGap5=${s.worstGap5}ms avgFps=${s.avgFps} ` +
        `p90=${s.p90Delta}ms gaps100=${s.gaps100} gaps250=${s.gaps250} ` +
        `lt=${s.ltN}x${s.ltTotal}ms heap=${s.heapMb}MB t=${s.elapsedSec}s`
      );
    } catch { /* diagnostics never throw */ }
  }, 5000);
}

// One-line summary for the HUD COPY button (chat-paste friendly).
export function fightPerfCopyText(s: FightPerfSnapshot): string {
  const nav = navigator as unknown as { deviceMemory?: number };
  return [
    `[perf] fps5=${s.fps5} worstGap5=${s.worstGap5}ms avgFps=${s.avgFps} p90=${s.p90Delta}ms ` +
    `gaps100=${s.gaps100} gaps250=${s.gaps250} lt=${s.ltN}x${s.ltTotal}ms max=${s.ltMax}ms ` +
    `heap=${s.heapMb}MB t=${s.elapsedSec}s`,
    `dev=${nav.deviceMemory ?? '?'}GB/${navigator.hardwareConcurrency || '?'}c`,
    'ua=' + navigator.userAgent,
  ].join('\n');
}
