// diag-lag.mjs — F-053 investigation: "the game is suddenly feeling very laggy".
//
// Boots a real fight on a PRODUCTION server (next dev stalls headless) with
// full instrumentation injected BEFORE any app script runs:
//   - requestAnimationFrame delta tracing  -> FPS + stall gaps during the fight
//   - longtask observer                    -> main-thread blocks >50ms
//   - console wrapper                      -> lines/sec spam detection + top lines
//   - fetch wrapper                        -> request count, repeats, slow fetches
//   - localStorage wrapper                 -> write volume + cumulative sync ms
//   - performance.memory sampler           -> heap growth curve
// Phases are split at canvas#ikemen-canvas (engine start): BOOT vs FIGHT.
//
// Usage: node scripts/diag-lag.mjs [--url URL] [--fight-ms 45000]
//   BASE env or --url: server to test (default http://localhost:3000)

import { chromium } from 'playwright';

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const BASE = argOf('--url', process.env.BASE || 'http://localhost:3000');
const FIGHT_MS = Number(argOf('--fight-ms', 45000));
const PLAY_URL =
  `${BASE}/play?p1=charsMARVEL/Abomination&p2=charsMARVEL/Beast&stage=Badda_Large_Stage&p2ai=4&qmode=arcade`;

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
});

// Optional network throttling via CDP (e.g. THROTTLE=fast3g): makes the
// mid-fight asset-streaming cost visible on a realistic connection.
const THROTTLE = argOf('--throttle', process.env.THROTTLE || '');
const PROFILES = {
  fast3g: { downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8, latency: 150 },
  slow4g: { downloadThroughput: (4 * 1024 * 1024) / 8, uploadThroughput: (3 * 1024 * 1024) / 8, latency: 60 },
};

// ---- pre-page instrumentation --------------------------------------------
await ctx.addInitScript(() => {
  window.__diag = {
    t0: performance.now(),
    canvasAt: 0,
    consoleLines: [],          // {t, level, line}
    consoleCount: { log: 0, warn: 0, error: 0 },
    raf: [],                   // deltas > 0 (we keep all; summarised page-side)
    frames: 0,
    longTasks: [],             // {t, dur}
    fetches: [],               // {t, urlTail, ms, ok}
    lsWrites: [],              // {t, keyTail, bytes, ms}
    lsTimeMs: 0,
    lsBytes: 0,
    heap: [],                  // {t, mb}
    net400: [],                // {t, url, status} filled via fetch wrapper only
  };
  const D = window.__diag;

  // console wrapper
  for (const lvl of ['log', 'warn', 'error', 'info']) {
    const orig = console[lvl].bind(console);
    console[lvl] = (...args) => {
      try {
        D.consoleCount[lvl === 'info' ? 'log' : lvl]++;
        const line = args.map((a) => (typeof a === 'string' ? a : String(a?.message ?? a))).join(' ');
        if (D.consoleLines.length < 4000) {
          D.consoleLines.push({ t: performance.now() - D.t0, lvl, line: line.slice(0, 220) });
        }
      } catch { /* diag must not break the page */ }
      orig(...args);
    };
  }

  // rAF delta tracing
  const origRaf = window.requestAnimationFrame.bind(window);
  let last = 0;
  window.requestAnimationFrame = (cb) =>
    origRaf((now) => {
      if (last) {
        const d = now - last;
        D.frames++;
        if (D.raf.length < 20000) D.raf.push({ t: now, d });
      }
      last = now;
      cb(now);
    });

  // long tasks
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (D.longTasks.length < 4000) D.longTasks.push({ t: e.startTime, dur: e.duration });
      }
    }).observe({ type: 'longtask', buffered: false });
  } catch { /* Safari */ }

  // fetch wrapper
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const t = performance.now();
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    try {
      const res = await origFetch(input, init);
      const tail = url.replace(/^https?:\/\/[^/]+/, '');
      if (D.fetches.length < 6000) {
        D.fetches.push({ t: t - D.t0, urlTail: tail.slice(0, 160), ms: Math.round(performance.now() - t), status: res.status });
      }
      return res;
    } catch (e) {
      if (D.fetches.length < 6000) {
        D.fetches.push({ t: t - D.t0, urlTail: ('ERR ' + url).slice(0, 160), ms: Math.round(performance.now() - t), status: 0 });
      }
      throw e;
    }
  };

  // localStorage wrapper (sync block measurement)
  const origSet = Storage.prototype.setItem;
  const origRm = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (k, v) {
    const t = performance.now();
    origSet.call(this, k, v);
    const ms = performance.now() - t;
    D.lsTimeMs += ms;
    D.lsBytes += (k.length + (v ? v.length : 0));
    if (D.lsWrites.length < 3000) {
      D.lsWrites.push({ t: performance.now() - D.t0, keyTail: String(k).slice(0, 60), bytes: v ? v.length : 0, ms: Math.round(ms * 10) / 10 });
    }
  };
  Storage.prototype.removeItem = function (k) {
    const t = performance.now();
    origRm.call(this, k);
    D.lsTimeMs += performance.now() - t;
  };

  // heap sampler
  const memTimer = setInterval(() => {
    try {
      if (performance.memory && D.heap.length < 2000) {
        D.heap.push({ t: performance.now() - D.t0, mb: Math.round(performance.memory.usedJSHeapSize / 1048576) });
      }
    } catch { /* noop */ }
  }, 2000);
  memTimer.unref?.();
});

const page = await ctx.newPage();
if (THROTTLE && PROFILES[THROTTLE]) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    ...PROFILES[THROTTLE],
  });
  console.log('throttle:', THROTTLE, JSON.stringify(PROFILES[THROTTLE]));
}
const net400 = [];
page.on('response', (r) => {
  if (r.status() >= 400) net400.push({ url: r.url().replace(/^https?:\/\/[^/]+/, '').slice(0, 140), status: r.status() });
});
page.on('pageerror', (e) => console.log('   [pageerror]', String(e.message).slice(0, 160)));

const tGo = Date.now();
await page.goto(PLAY_URL, { waitUntil: 'domcontentloaded' });

let booted = false;
try {
  await page.waitForSelector('canvas#ikemen-canvas', { timeout: 120000 });
  booted = true;
  await page.evaluate(() => { window.__diag.canvasAt = performance.now(); });
} catch { /* canvas never appeared */ }

if (booted) {
  await page.waitForTimeout(FIGHT_MS);
}

const d = await page.evaluate(() => {
  const D = window.__diag;
  // summarize rAF AFTER canvas (fight window)
  const cvs = D.canvasAt || 0;
  const stat = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const sum = s.reduce((a, b) => a + b, 0);
    return {
      n: s.length, mean: Math.round((sum / s.length) * 10) / 10,
      p50: s[Math.floor(s.length * 0.5)], p90: s[Math.floor(s.length * 0.9)],
      p99: s[Math.min(s.length - 1, Math.floor(s.length * 0.99))], max: s[s.length - 1],
    };
  };
  // console rate after canvas
  const fightLines = D.consoleLines.filter((l) => l.t >= cvs);
  const byLine = new Map();
  for (const l of fightLines) byLine.set(l.line, (byLine.get(l.line) || 0) + 1);
  const topLines = [...byLine.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  // fetches after canvas
  const fightFetches = D.fetches.filter((f) => f.t >= cvs);
  const byUrl = new Map();
  for (const f of fightFetches) byUrl.set(f.urlTail, (byUrl.get(f.urlTail) || 0) + 1);
  const topFetch = [...byUrl.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const slowFetch = [...fightFetches].sort((a, b) => b.ms - a.ms).slice(0, 10);
  // long tasks after canvas
  const fightLT = D.longTasks.filter((l) => l.t >= cvs);
  const bootLT = D.longTasks.filter((l) => l.t < cvs);
  const ltStat = (a) => ({ n: a.length, total: Math.round(a.reduce((x, y) => x + y.dur, 0)), max: a.reduce((m, y) => Math.max(m, y.dur), 0) });
  // localStorage writes after canvas
  const fightLS = D.lsWrites.filter((w) => w.t >= cvs);
  const lsByKey = new Map();
  for (const w of fightLS) {
    const k = w.keyTail;
    lsByKey.set(k, (lsByKey.get(k) || { n: 0, bytes: 0 }));
    lsByKey.get(k).n++;
    lsByKey.get(k).bytes += w.bytes;
  }
  // rAF stats split at canvas time (boot vs fight)
  const rafAll = D.raf;
  const deltas = rafAll.map((x) => x.d);
  const fightDeltas = rafAll.filter((x) => x.t >= cvs).map((x) => x.d);
  return {
    canvasAtMs: Math.round(cvs),
    nowMs: Math.round(performance.now() - D.t0),
    frames: D.frames,
    rafAllStat: stat(deltas),
    rafFightStat: stat(fightDeltas),
    gaps50: fightDeltas.filter((x) => x > 50).length,
    gaps100: fightDeltas.filter((x) => x > 100).length,
    gaps250: fightDeltas.filter((x) => x > 250).length,
    maxGap: fightDeltas.length ? Math.max(...fightDeltas) : 0,
    bootLT: ltStat(bootLT),
    fightLT: ltStat(fightLT),
    fightSec: Math.round(((D.raf.length ? rafAll[rafAll.length - 1].t : cvs) - cvs) / 1000),
    consoleTotal: D.consoleCount,
    consoleFightLines: fightLines.length,
    topLines,
    fetchFightCount: fightFetches.length,
    topFetch,
    slowFetch,
    fight400: D.fetches.filter((f) => f.t >= cvs && f.status >= 400).slice(0, 15),
    lsFight: { n: fightLS.length, timeMs: null, byKey: [...lsByKey.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8) },
    lsTotalTimeMs: Math.round(D.lsTimeMs),
    heapHead: D.heap.slice(0, 3),
    heapTail: D.heap.slice(-3),
  };
});

console.log('==== diag-lag results ====');
console.log('target:', PLAY_URL);
console.log('booted:', booted, '| canvas at', d.canvasAtMs, 'ms | total', d.nowMs, 'ms');
console.log('fight window ~', d.fightSec, 's');
console.log('FIGHT gaps>50ms:', d.gaps50, '| >100ms:', d.gaps100, '| >250ms:', d.gaps250, '| maxGap:', d.maxGap, 'ms');
console.log('rAF all  :', JSON.stringify(d.rafAllStat));
console.log('rAF fight:', JSON.stringify(d.rafFightStat));
console.log('longtasks boot:', JSON.stringify(d.bootLT), '| fight:', JSON.stringify(d.fightLT));
console.log('console counts:', JSON.stringify(d.consoleTotal), '| fight lines:', d.consoleFightLines);
console.log('top fight console lines:');
for (const [line, n] of d.topLines) console.log(`   ${String(n).padStart(6)}x  ${line.slice(0, 150)}`);
console.log('fight fetches:', d.fetchFightCount, '| top repeated:');
for (const [u, n] of d.topFetch) console.log(`   ${String(n).padStart(6)}x  ${u.slice(0, 140)}`);
console.log('slowest fight fetches:');
for (const f of d.slowFetch) console.log(`   ${String(f.ms).padStart(6)}ms ${f.status}  ${f.urlTail.slice(0, 130)}`);
console.log('fight 4xx/5xx (fetch layer):', d.fight400.length);
for (const f of d.fight400) console.log(`   ${f.status} ${f.urlTail.slice(0, 130)}`);
console.log('net400 (response layer) total:', net400.length);
for (const f of net400.slice(0, 15)) console.log(`   ${f.status} ${f.url}`);
console.log('localStorage: totalSyncMs', d.lsTotalTimeMs, '| fight writes:', JSON.stringify(d.lsFight));
console.log('heap MB first->last:', JSON.stringify(d.heapHead), '->', JSON.stringify(d.heapTail));
console.log('wall ms:', Date.now() - tGo);

await browser.close();
