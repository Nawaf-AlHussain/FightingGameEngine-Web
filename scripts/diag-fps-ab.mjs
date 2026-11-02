// diag-fps-ab.mjs — F-054 follow-up: "FPS is low from the start".
//
// A/B the render-resolution lever: seeds localStorage save/config.ini with
// the SHIPPED config but a chosen GameWidth/GameHeight (what the Settings
// "16:9 · 1080p Full HD" preset writes), then boots a real fight on a
// PRODUCTION server with the diag-lag instrumentation and reports per-5s
// FPS buckets after the canvas appears — so "low from the start" is visible
// as a shape, not just an average.
//
// Usage:
//   node scripts/diag-fps-ab.mjs --gw 1920 --gh 1080 [--fight-ms 45000]
//   (no --gw  => no seed, shipped 1280x720 control)

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const BASE = argOf('--url', process.env.BASE || 'http://localhost:3000');
const FIGHT_MS = Number(argOf('--fight-ms', 45000));
const GW = argOf('--gw', '');
const GH = argOf('--gh', '');
const PLAY_URL =
  `${BASE}/play?p1=charsMARVEL/Abomination&p2=charsMARVEL/Beast&stage=Badda_Large_Stage&p2ai=4&qmode=arcade`;

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CFG_TEXT = readFileSync(join(REPO, 'public/game/engine-fs/file/save/config.ini'), 'utf8');
const SEED_B64 = (GW && GH)
  ? Buffer.from(
      CFG_TEXT
        .replace(/^GameWidth\s*=.*$/m, `GameWidth           = ${GW}`)
        .replace(/^GameHeight\s*=.*$/m, `GameHeight          = ${GH}`),
      'utf8'
    ).toString('base64')
  : '';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });

if (SEED_B64) {
  await ctx.addInitScript((b64) => {
    try { localStorage.setItem('engine-vfs12:save/config.ini', b64); } catch { /* ignore */ }
  }, SEED_B64);
}

// ---- same pre-page instrumentation as diag-lag.mjs ------------------------
await ctx.addInitScript(() => {
  window.__diag = { t0: performance.now(), canvasAt: 0, raf: [], frames: 0, longTasks: [], fetches: [], lsTimeMs: 0, lsBytes: 0, lsWrites: [] };
  const D = window.__diag;
  const origRaf = window.requestAnimationFrame.bind(window);
  let last = 0;
  window.requestAnimationFrame = (cb) =>
    origRaf((now) => {
      if (last) { D.frames++; if (D.raf.length < 30000) D.raf.push({ t: now, d: now - last }); }
      last = now;
      cb(now);
    });
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (D.longTasks.length < 6000) D.longTasks.push({ t: e.startTime, dur: e.duration });
    }).observe({ type: 'longtask', buffered: false });
  } catch { /* Safari */ }
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const t = performance.now();
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    const res = await origFetch(input, init);
    if (D.fetches.length < 6000) D.fetches.push({ t: t - D.t0, tail: url.replace(/^https?:\/\/[^/]+/, '').slice(0, 120), ms: Math.round(performance.now() - t), status: res.status });
    return res;
  };
  const origSet = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    const t = performance.now();
    origSet.call(this, k, v);
    D.lsTimeMs += performance.now() - t;
    D.lsBytes += k.length + (v ? v.length : 0);
  };
});

const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('   [pageerror]', String(e.message).slice(0, 160)));
await page.goto(PLAY_URL, { waitUntil: 'domcontentloaded' });

let booted = false;
try {
  await page.waitForSelector('canvas#ikemen-canvas', { timeout: 120000 });
  booted = true;
  await page.evaluate(() => { window.__diag.canvasAt = performance.now(); });
} catch { /* canvas never appeared */ }
if (booted) await page.waitForTimeout(FIGHT_MS);

const d = await page.evaluate(() => {
  const D = window.__diag;
  const cvs = D.canvasAt || 0;
  const fight = D.raf.filter((r) => r.t >= cvs);
  const stat = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const sum = s.reduce((a, b) => a + b, 0);
    return { n: s.length, mean: Math.round((sum / s.length) * 10) / 10, p50: s[Math.floor(s.length * 0.5)], p90: s[Math.floor(s.length * 0.9)], max: s[s.length - 1] };
  };
  // per-5s fps buckets after canvas
  const buckets = [];
  for (let b = 0; b * 5000 < (fight.length ? fight[fight.length - 1].t - cvs : 0); b++) {
    const inB = fight.filter((r) => r.t >= cvs + b * 5000 && r.t < cvs + (b + 1) * 5000);
    if (!inB.length) { buckets.push({ s: b * 5, fps: 0, gaps250: 0 }); continue; }
    const sum = inB.reduce((a, r) => a + r.d, 0);
    buckets.push({
      s: b * 5,
      fps: Math.round((inB.length / (sum / 1000)) * 10) / 10,
      gaps250: inB.filter((r) => r.d > 250).length,
      p90: inB.map((r) => r.d).sort((a, b) => a - b)[Math.floor(inB.length * 0.9)],
    });
  }
  const fightLT = D.longTasks.filter((l) => l.t >= cvs);
  const fightFetches = D.fetches.filter((f) => f.t >= cvs);
  return {
    booted: true, canvasAtMs: Math.round(cvs),
    rafAll: stat(D.raf.map((r) => r.d)), rafFight: stat(fight.map((r) => r.d)),
    buckets,
    ltFight: { n: fightLT.length, total: Math.round(fightLT.reduce((a, e) => a + e.dur, 0)), max: fightLT.reduce((m, e) => Math.max(m, e.dur), 0) },
    fetchFightCount: fightFetches.length,
    fetchMs: Math.round(fightFetches.reduce((a, f) => a + f.ms, 0)),
    lsTimeMs: Math.round(D.lsTimeMs), lsBytes: D.lsBytes,
  };
});

console.log('==== diag-fps-ab ====');
console.log('seeded:', GW ? `${GW}x${GH}` : '(none — shipped 1280x720)');
console.log('booted:', d.booted, '| canvas at', d.canvasAtMs, 'ms');
console.log('rAF fight:', JSON.stringify(d.rafFight));
console.log('per-5s buckets (s, fps, p90 delta ms, gaps>250ms):');
for (const b of d.buckets) console.log(`   +${String(b.s).padStart(3)}s  fps=${String(b.fps).padStart(6)}  p90=${String(b.p90).padStart(6)}ms  gaps250=${b.gaps250}`);
console.log('fight longtasks:', JSON.stringify(d.ltFight));
console.log('fight fetches:', d.fetchFightCount, '| fetch ms total:', d.fetchMs);
console.log('localStorage: syncMs', d.lsTimeMs, '| bytes', d.lsBytes);
await browser.close();
